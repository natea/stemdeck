"""Choose a string and fret for every note of a guitar or bass part.

A transcription knows pitches and times. Tablature needs to know where the
hand goes: the same E can be the open first string or the fifth fret of the
second, and which one a player would use depends on the notes around it.

This module decides that, in one place, so the Notation view, the Guitar Pro
file and the MusicXML score all show the same frets
(openspec change add-alphatab-notation). It is pure and model-free: quantised
notes in, a tuning and a capo, placements out. Nothing it returns is stored,
so changing the tuning re-fingers the part with no transcription run.

How it chooses:

1. Candidates. A note can go on any string where the open pitch, plus the
   capo, plus a fret from 0 to TAB_MAX_FRET, equals its pitch.
2. Events. Notes that start on the same grid step are played together. For
   each event it lists the hand shapes that put every note on its own string
   with the fretted notes inside one hand span (open strings need no finger,
   so they do not count toward the span).
3. Path. Dynamic programming over the events picks the sequence of shapes
   with the lowest total cost: how high up the neck the hand is (so the lower
   of two equal positions wins), how far it moved from the shape before, and
   a small charge for skipping strings. After a rest longer than a bar the
   hand can go anywhere, so the movement charge is dropped.
4. What cannot be played. A note no string reaches is left out as
   ``out_of_range``. When an event has more notes than can be held at once,
   the notes that cost most to keep are left out as ``too_many_notes``.
   Neither is dropped silently: both come back in ``unplaced`` with the reason.

Strings are numbered as tablature and MusicXML number them: 1 is the
highest-sounding string. Frets are counted from the capo.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from app.core.config import (
    QUANTIZE_DEFAULT_BEATS_PER_BAR,
    QUANTIZE_PARTS_DEFAULT,
    TAB_BEAM,
    TAB_MAX_FRET,
    TAB_SPAN_FRETS,
    TAB_SUGGEST_SHARE,
    TAB_TUNINGS,
)
from app.pipeline.quantize import QNote

OUT_OF_RANGE = "out_of_range"
TOO_MANY_NOTES = "too_many_notes"
REASONS: tuple[str, ...] = (OUT_OF_RANGE, TOO_MANY_NOTES)

# Cost weights, in "frets". Moving the hand one fret costs 1. Sitting one fret
# higher costs a quarter of that for each event, which is enough to settle a
# tie toward the nut without dragging a phrase out of the position it is in.
_W_MOVE = 1.0
_W_POSITION = 0.25
_W_STRETCH = 0.15
_W_STRING_SKIP = 0.2
# A safety valve on the shape search. An ordinary chord visits a few hundred
# nodes; this only stops a pathological event (a dozen notes on one step) from
# taking seconds.
_SEARCH_NODES = 40_000
_SEARCH_SHAPES = 2_000


@dataclass(frozen=True)
class Placed:
    """A note with the string (1 is the highest) and fret (from the capo) it
    is played on."""

    note: QNote
    string: int
    fret: int


@dataclass(frozen=True)
class Unplaced:
    """A note left out of the tab, and why (one of REASONS)."""

    note: QNote
    reason: str


@dataclass(frozen=True)
class _Shape:
    """One way to play an event. ``choice[i]`` is (string index, fret) for the
    event's i-th note, or None when that note is left out. String indexes
    count from the lowest string, 0."""

    choice: tuple[tuple[int, int] | None, ...]
    cost: float
    position: float | None  # mean fretted fret; None when every note is open
    string: float  # mean string index


def candidates(pitch: int, tuning: Sequence[int], capo: int = 0) -> list[tuple[int, int]]:
    """Every (string index, fret) that sounds ``pitch``, lowest fret first."""
    out = []
    for index, open_pitch in enumerate(tuning):
        fret = pitch - open_pitch - capo
        if 0 <= fret <= TAB_MAX_FRET:
            out.append((index, fret))
    out.sort(key=lambda c: (c[1], c[0]))
    return out


def in_range(pitch: int, tuning: Sequence[int], capo: int = 0) -> bool:
    return any(0 <= pitch - open_pitch - capo <= TAB_MAX_FRET for open_pitch in tuning)


def _shape(choice: tuple[tuple[int, int] | None, ...]) -> _Shape:
    used = [c for c in choice if c is not None]
    fretted = [fret for _, fret in used if fret > 0]
    strings = sorted(s for s, _ in used)
    position = sum(fretted) / len(fretted) if fretted else None
    cost = _W_POSITION * (position or 0.0)
    if fretted:
        cost += _W_STRETCH * (max(fretted) - min(fretted))
    # Strings left unplayed between the lowest and highest one used.
    cost += _W_STRING_SKIP * (strings[-1] - strings[0] + 1 - len(strings))
    return _Shape(choice, cost, position, sum(strings) / len(strings))


def _choices(
    cands: Sequence[Sequence[tuple[int, int]]], skips: int
) -> list[tuple[tuple[int, int] | None, ...]]:
    """Every way to play an event leaving exactly ``skips`` of its notes out:
    each kept note on its own string, the fretted ones inside one hand span."""
    count = len(cands)
    found: list[tuple[tuple[int, int] | None, ...]] = []
    budget = [_SEARCH_NODES]
    choice: list[tuple[int, int] | None] = [None] * count

    def search(i: int, used: int, low: int, high: int, skips_left: int) -> None:
        if budget[0] <= 0 or len(found) >= _SEARCH_SHAPES:
            return
        budget[0] -= 1
        if i == count:
            if skips_left == 0:
                found.append(tuple(choice))
            return
        if count - i > skips_left:
            for string, fret in cands[i]:
                if used >> string & 1:
                    continue
                new_low, new_high = low, high
                if fret > 0:
                    new_low, new_high = min(low, fret), max(high, fret)
                    if new_high - new_low >= TAB_SPAN_FRETS:
                        continue
                choice[i] = (string, fret)
                search(i + 1, used | 1 << string, new_low, new_high, skips_left)
            choice[i] = None
        if skips_left > 0:
            search(i + 1, used, low, high, skips_left - 1)

    search(0, 0, TAB_MAX_FRET + 1, -1, skips)
    return found


def _shapes(cands: Sequence[Sequence[tuple[int, int]]], n_strings: int) -> list[_Shape]:
    """The cheapest shapes for one event, each placing as many of its notes as
    can be held at once. ``cands[i]`` are the i-th note's candidates and is
    never empty."""
    count = len(cands)
    for skips in range(max(0, count - n_strings), count):
        found = _choices(cands, skips)
        if found:
            shapes = sorted((_shape(c) for c in found), key=lambda s: s.cost)
            return shapes[:TAB_BEAM]
    return []


def assign(
    notes: Iterable[QNote],
    tuning: Sequence[int],
    capo: int = 0,
    *,
    reset_steps: int = QUANTIZE_PARTS_DEFAULT * QUANTIZE_DEFAULT_BEATS_PER_BAR,
) -> tuple[list[Placed], list[Unplaced]]:
    """Strings and frets for ``notes`` on an instrument tuned to ``tuning``
    (open-string pitches, lowest string first) with a capo at ``capo``.

    Returns the notes that were placed and the notes that could not be, both
    in time order. ``reset_steps`` is how long a silence, in grid steps, lets
    the hand move for free: one bar.
    """
    tuning = list(tuning)
    n_strings = len(tuning)
    ordered = sorted(notes, key=lambda n: (n.step, n.pitch))
    unplaced: list[Unplaced] = []

    # Events: the placeable notes of each step, with their candidates.
    events: list[tuple[list[QNote], list[_Shape]]] = []
    i = 0
    while i < len(ordered):
        j = i
        while j < len(ordered) and ordered[j].step == ordered[i].step:
            j += 1
        members: list[QNote] = []
        cands: list[list[tuple[int, int]]] = []
        for note in ordered[i:j]:
            found = candidates(note.pitch, tuning, capo)
            if found:
                members.append(note)
                cands.append(found)
            else:
                unplaced.append(Unplaced(note, OUT_OF_RANGE))
        if members:
            events.append((members, _shapes(cands, n_strings)))
        i = j

    # Viterbi over the events. A state is (total cost, hand position, mean
    # string, index of the state it came from). The hand position carries
    # through shapes that are all open strings, which need no hand.
    trail: list[list[tuple[float, float | None, float, int]]] = []
    sounding_until: int | None = None
    for members, shapes in events:
        step = members[0].step
        free = sounding_until is None or step - sounding_until > reset_steps
        previous = trail[-1] if trail else []
        states: list[tuple[float, float | None, float, int]] = []
        for shape in shapes:
            if not previous:
                states.append((shape.cost, shape.position, shape.string, -1))
                continue
            best_cost = float("inf")
            best_from = 0
            best_position: float | None = None
            for index, (cost, position, string, _) in enumerate(previous):
                total = cost + shape.cost
                if not free:
                    if position is not None and shape.position is not None:
                        total += _W_MOVE * abs(shape.position - position)
                    jump = abs(shape.string - string)
                    if jump > 1:
                        total += _W_STRING_SKIP * (jump - 1)
                if total < best_cost:
                    best_cost, best_from, best_position = total, index, position
            states.append(
                (
                    best_cost,
                    shape.position if shape.position is not None else best_position,
                    shape.string,
                    best_from,
                )
            )
        trail.append(states)
        end = max(n.step + n.steps for n in members)
        sounding_until = end if sounding_until is None else max(sounding_until, end)

    placed: list[Placed] = []
    if trail:
        at = min(range(len(trail[-1])), key=lambda k: trail[-1][k][0])
        chosen: list[int] = []
        for states in reversed(trail):
            chosen.append(at)
            at = states[at][3]
        chosen.reverse()
        for (members, shapes), pick in zip(events, chosen, strict=True):
            for note, where in zip(members, shapes[pick].choice, strict=True):
                if where is None:
                    unplaced.append(Unplaced(note, TOO_MANY_NOTES))
                else:
                    placed.append(Placed(note, n_strings - where[0], where[1]))

    unplaced.sort(key=lambda u: (u.note.step, u.note.pitch))
    return placed, unplaced


def reasons(unplaced: Iterable[Unplaced]) -> dict[str, int]:
    """How many notes were left out for each reason, reasons with none omitted."""
    out: dict[str, int] = {}
    for item in unplaced:
        out[item.reason] = out.get(item.reason, 0) + 1
    return out


def suggest_tuning(
    notes: Iterable[QNote], stem: str, tuning: Sequence[int], capo: int = 0
) -> str | None:
    """The name of the preset tuning that reaches the most of ``notes``, when
    more than a small share of them are out of the current tuning's range and
    a preset does better. None otherwise.

    Presets are scored by the notes in their range. Between presets that reach
    equally many, the one closest to the current tuning wins: the same number
    of strings, then the fewest strings retuned, then the order they are
    listed in. So a song with low Ds on a standard guitar is offered drop D,
    not a seven-string."""
    pitches = [n.pitch for n in notes]
    presets = TAB_TUNINGS.get(stem)
    if not pitches or not presets:
        return None
    current = tuple(tuning)

    def reach(strings: Sequence[int]) -> int:
        return sum(1 for p in pitches if in_range(p, strings, capo))

    have = reach(current)
    if len(pitches) - have <= TAB_SUGGEST_SHARE * len(pitches):
        return None
    best: tuple[tuple[int, bool, int, int], str] | None = None
    for order, (name, preset) in enumerate(presets.items()):
        got = reach(preset)
        if preset == current or got <= have:
            continue
        other_count = len(preset) != len(current)
        retuned = (
            len(preset)
            if other_count
            else sum(a != b for a, b in zip(preset, current, strict=True))
        )
        key = (-got, other_count, retuned, order)
        if best is None or key < best[0]:
            best = (key, name)
    return best[1] if best else None
