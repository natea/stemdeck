"""Snap transcribed notes to the song's own beat grid.

A transcriber reports when a note started in seconds. Notation, and a MIDI
file that lines up with a DAW's bars, need to know where it sits in the music:
which bar, which beat, which part of the beat. A fixed tempo cannot answer
that, because a band does not play at one. The beat grid can: it is the list
of times at which the beats actually fall, the grid the click track plays
(app/pipeline/beatgrid.py), with the user's corrections merged in
(app/core/beat_files.py).

So the quantiser divides every interval between two real beats into equal
parts and snaps note starts and ends to the nearest of those points. Because
the points are interpolated inside each real beat, a song that drifts from 100
to 108 BPM is followed exactly, and a note played on the beat stays on it.

This is a pure function of the stored notes and the grid. Nothing it returns
is saved: the stored result is the notes as played, so editing the grid
re-quantises with no model run and nothing to invalidate.

Positions are expressed in *steps*: step ``i * parts + p`` is part ``p`` of
beat ``i``. One beat is treated as one quarter note throughout the exports.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass

import numpy as np

from app.core.config import QUANTIZE_DEFAULT_BEATS_PER_BAR, QUANTIZE_PARTS, QUANTIZE_PARTS_DEFAULT


class NoBeatGrid(ValueError):
    """The song has no beat grid to quantise against (fewer than two beats)."""


@dataclass(frozen=True)
class Bar:
    """One bar: ``number`` counts from 1, ``start_beat`` is an index into the
    grid's beats, ``beats`` is its length. The first bar may be a pickup,
    shorter than ``beats_per_bar``, when the first downbeat is not beat 0."""

    number: int
    start_beat: int
    beats: int
    beats_per_bar: int


@dataclass(frozen=True)
class QNote:
    """A note on the grid.

    ``step`` and ``steps`` are its start and length in grid steps. ``bar``
    (from 1), ``beat`` (from 1, within the bar) and ``part`` (from 0, within
    the beat) say where it starts. ``start`` and ``end`` are the grid times in
    seconds it was snapped to, so the quantised form can still be played
    against the audio."""

    pitch: int
    velocity: int
    step: int
    steps: int
    bar: int
    beat: int
    part: int
    start: float
    end: float

    def to_dict(self) -> dict:
        return asdict(self)


def check_parts(parts: int) -> int:
    if parts not in QUANTIZE_PARTS:
        raise ValueError(f"parts per beat must be one of {QUANTIZE_PARTS}")
    return parts


def grid_beats(grid: Mapping | None) -> list[float]:
    """The grid's beat times, strictly increasing, or NoBeatGrid."""
    raw = (grid or {}).get("beats") if isinstance(grid, Mapping) else None
    beats: list[float] = []
    for t in raw if isinstance(raw, list) else []:
        try:
            value = float(t)
        except (TypeError, ValueError):
            continue
        if np.isfinite(value) and (not beats or value > beats[-1]):
            beats.append(value)
    if len(beats) < 2:
        raise NoBeatGrid("the song has no beat grid")
    return beats


def _marks(grid: Mapping, n_beats: int) -> list[tuple[int, int]]:
    """(beat index, beats per bar) bar marks, in order, well-formed ones only."""
    out: dict[int, int] = {}
    for mark in grid.get("bars") or []:
        if not isinstance(mark, Mapping):
            continue
        try:
            beat, per = int(mark["beat"]), int(mark["beats_per_bar"])
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= beat < n_beats and 1 <= per <= 32:
            out[beat] = per
    return sorted(out.items())


def bars_of(grid: Mapping, n_beats: int | None = None) -> list[Bar]:
    """Every bar of the song, covering beats 0 to the last.

    A mark says "a bar of this length starts here, and so on until the next
    mark". Beats before the first mark are counted backwards from it in bars of
    the same length, which leaves a pickup bar at the very start when the
    first downbeat is not a whole number of bars in. A bar cut short by the
    next mark keeps its shorter length. With no marks (the librosa fallback
    detects no downbeats) bars are counted in fours from the first beat.
    """
    if n_beats is None:
        n_beats = len(grid_beats(grid))
    marks = _marks(grid, n_beats)
    if not marks:
        marks = [(0, QUANTIZE_DEFAULT_BEATS_PER_BAR)]
    bars: list[Bar] = []
    first_beat, first_per = marks[0]
    if first_beat > 0:
        pickup = first_beat % first_per
        if pickup:
            bars.append(Bar(1, 0, pickup, first_per))
        marks[0] = (pickup, first_per)

    for i, (at, per) in enumerate(marks):
        until = marks[i + 1][0] if i + 1 < len(marks) else n_beats
        beat = at
        while beat < until:
            length = min(per, until - beat)
            bars.append(Bar(len(bars) + 1, beat, length, per))
            beat += length
    return bars


def step_times(beats: Sequence[float], parts: int) -> np.ndarray:
    """The time of every grid step: ``parts`` per beat interval, plus the last
    beat itself as the final point (an end may land there, a start may not)."""
    b = np.asarray(beats, dtype=float)
    frac = np.arange(parts, dtype=float) / parts
    inner = (b[:-1, None] + (b[1:] - b[:-1])[:, None] * frac[None, :]).reshape(-1)
    return np.concatenate([inner, b[-1:]])


def _nearest(times: np.ndarray, t: float) -> int:
    i = int(np.searchsorted(times, t))
    if i <= 0:
        return 0
    if i >= len(times):
        return len(times) - 1
    return i if times[i] - t < t - times[i - 1] else i - 1


def _bar_at(bars: Sequence[Bar], starts: np.ndarray, beat_index: int) -> Bar:
    return bars[max(0, int(np.searchsorted(starts, beat_index, side="right")) - 1)]


def quantize(
    notes: Iterable[Mapping],
    grid: Mapping | None,
    parts: int = QUANTIZE_PARTS_DEFAULT,
    *,
    monophonic: bool = False,
) -> list[QNote]:
    """Notes snapped to the grid, in time order.

    A start snaps to the nearest step. An end snaps to the nearest step after
    its start, so every note is at least one step long. Notes outside the grid
    clamp to its edges. With ``monophonic``, a note is cut where the next one
    starts and two notes that land on the same step keep only the louder, so
    the result never sounds two notes at once.

    Raises NoBeatGrid when the song has no usable grid.
    """
    check_parts(parts)
    beats = grid_beats(grid)
    assert isinstance(grid, Mapping)
    times = step_times(beats, parts)
    last_start = len(times) - 2
    bars = bars_of(grid, len(beats))
    bar_starts = np.asarray([b.start_beat for b in bars])

    placed: list[tuple[int, int, int, int]] = []  # (step, end step, pitch, velocity)
    for note in notes:
        try:
            start, end = float(note["start"]), float(note["end"])
            pitch, velocity = int(note["pitch"]), int(note.get("velocity", 80))
        except (KeyError, TypeError, ValueError):
            continue
        if not (np.isfinite(start) and np.isfinite(end)) or not 0 <= pitch <= 127:
            continue
        step = min(_nearest(times, start), last_start)
        end_step = max(_nearest(times, max(end, start)), step + 1)
        placed.append((step, end_step, pitch, max(1, min(127, velocity))))
    placed.sort(key=lambda n: (n[0], n[2]))

    if monophonic:
        mono: list[tuple[int, int, int, int]] = []
        for item in placed:
            if mono and mono[-1][0] == item[0]:
                if item[3] > mono[-1][3]:
                    mono[-1] = item
                continue
            if mono and mono[-1][1] > item[0]:
                prev = mono[-1]
                mono[-1] = (prev[0], item[0], prev[2], prev[3])
            mono.append(item)
        placed = mono
    else:
        # The same pitch struck twice on one step is one note, the longer.
        seen: dict[tuple[int, int], int] = {}
        unique: list[tuple[int, int, int, int]] = []
        for item in placed:
            key = (item[0], item[2])
            if key in seen:
                kept = unique[seen[key]]
                unique[seen[key]] = (kept[0], max(kept[1], item[1]), kept[2], max(kept[3], item[3]))
                continue
            seen[key] = len(unique)
            unique.append(item)
        placed = unique

    out: list[QNote] = []
    for step, end_step, pitch, velocity in placed:
        beat_index, part = divmod(step, parts)
        bar = _bar_at(bars, bar_starts, beat_index)
        out.append(
            QNote(
                pitch=pitch,
                velocity=velocity,
                step=step,
                steps=end_step - step,
                bar=bar.number,
                beat=beat_index - bar.start_beat + 1,
                part=part,
                start=round(float(times[step]), 6),
                end=round(float(times[end_step]), 6),
            )
        )
    return out
