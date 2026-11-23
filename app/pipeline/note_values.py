"""From grid steps to written notes: what the notation writers share.

The quantiser (app/pipeline/quantize.py) puts every note on a step of the beat
grid and gives it a length in steps. A score needs two more things worked out
before anything can be drawn, and both writers (MusicXML in
app/pipeline/notes_musicxml.py, alphaTex in app/pipeline/notes_alphatex.py)
must agree on them, or the download would not match the view:

- **Which notes are one written event.** Notes that start together are a
  chord. Drum hits have no length of their own, so each lasts until the next
  hit or the end of its beat.
- **How a length is written.** Five sixteenths is not a note value: it is a
  quarter tied to a sixteenth. ``split_steps`` breaks a length in grid steps
  into the values a musician reads, the way an engraver would: a value never
  starts off its own grid, and a note that starts off the beat does not run
  across the next beat line.

One beat of the song is one quarter note, as everywhere in the exports.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from app.pipeline.quantize import QNote

# One written event: where it starts and how long it lasts, in grid steps
# from the start of the song, and the notes sounded.
Span = tuple[int, int, list[QNote]]


@dataclass(frozen=True)
class NoteValue:
    """One written note value.

    ``steps`` is its length in grid steps. ``denominator`` is the value as a
    fraction of a whole note (1 whole, 2 half, 4 quarter, 8, 16, 32).
    ``dots`` is 0 or 1. ``tuplet`` is 3 when the value is a triplet value
    (three in the time of two), otherwise 0.
    """

    steps: int
    denominator: int
    dots: int = 0
    tuplet: int = 0


def _binary(offset: int, steps: int, per_beat: int) -> list[NoteValue]:
    """Split on a grid that divides the beat in halves (1, 2, 4 or 8 parts)."""
    whole = 4 * per_beat
    # Every plain and dotted value up to a whole note, longest first, each
    # with the size of grid it must start on. A plain value starts on its own
    # grid (a quarter on a beat). A dotted value starts on the grid of the
    # next value up (a dotted quarter on beat one or three, not on beat two),
    # so the long part of the rhythm stays on the strong beat.
    values: list[tuple[int, int, int, int]] = []  # (steps, denominator, dots, grid)
    size = whole
    while size >= 1:
        values.append((size, whole // size, 0, size))
        if size % 2 == 0 and size * 3 // 2 <= whole:
            values.append((size * 3 // 2, whole // size, 1, size * 2))
        size //= 2
    values.sort(reverse=True)

    out: list[NoteValue] = []
    at, left = offset, steps
    while left > 0:
        # Off the beat, a value stops at the next beat line.
        room = left if at % per_beat == 0 else min(left, per_beat - at % per_beat)
        for length, denominator, dots, grid in values:
            if length <= room and at % grid == 0:
                out.append(NoteValue(length, denominator, dots))
                at += length
                left -= length
                break
    return out


def _triplet(offset: int, steps: int, per_beat: int) -> list[NoteValue]:
    """Split on a grid that divides the beat in three (3 parts) or six."""
    # A step is a triplet eighth on the 3-part grid and a triplet sixteenth on
    # the 6-part grid. Three steps are a tuplet group: a beat, or half a beat.
    unit = 8 if per_beat == 3 else 16
    out: list[NoteValue] = []
    at, left = offset, steps
    while left > 0:
        if at % per_beat == 0 and left >= per_beat:
            # Whole beats from a beat line are written plainly.
            beats = left // per_beat
            for value in _binary(at // per_beat, beats, 1):
                out.append(NoteValue(value.steps * per_beat, value.denominator, value.dots))
            at += beats * per_beat
            left -= beats * per_beat
        elif per_beat == 6 and at % 3 == 0 and left >= 3:
            out.append(NoteValue(3, 8))  # half a beat from a half-beat line
            at += 3
            left -= 3
        else:
            take = min(left, 3 - at % 3)
            out.append(NoteValue(take, unit // take, 0, 3))
            at += take
            left -= take
    return out


def split_steps(offset: int, steps: int, steps_per_beat: int) -> list[NoteValue]:
    """The note values that make up ``steps`` grid steps, in order.

    ``offset`` is where the span starts, in steps from the start of its bar:
    the same length is written differently on the beat and off it. The span
    must lie inside one bar; a note that crosses a bar line is split there by
    the caller and each part passed separately. For a note, the values are
    tied together. For a silence, they are rests.

    The values always add up to ``steps`` exactly.
    """
    if steps <= 0:
        return []
    if steps_per_beat in (3, 6):
        return _triplet(offset, steps, steps_per_beat)
    return _binary(offset, steps, steps_per_beat)


def chord_spans(notes: Iterable[QNote]) -> list[Span]:
    """Notes that start together and last equally long are one chord. Spans
    may overlap: a writer with voices keeps both, a writer with one voice
    uses ``voice_spans`` instead."""
    groups: dict[tuple[int, int], list[QNote]] = defaultdict(list)
    for n in notes:
        groups[(n.step, n.steps)].append(n)
    return [(step, steps, members) for (step, steps), members in sorted(groups.items())]


def voice_spans(notes: Iterable[QNote], total_steps: int) -> list[Span]:
    """The notes as one voice, where nothing overlaps: every note that starts
    on a step is in that step's chord, and the chord lasts as long as its
    longest note, or until the next chord starts or the song ends, whichever
    comes first. A held note under a moving line therefore loses its sustain;
    the MIDI export keeps true lengths."""
    by_step: dict[int, list[QNote]] = defaultdict(list)
    for n in notes:
        by_step[n.step].append(n)
    onsets = sorted(by_step)
    out: list[Span] = []
    for i, step in enumerate(onsets):
        members = sorted(by_step[step], key=lambda q: q.pitch)
        until = min(
            max(n.step + n.steps for n in members),
            onsets[i + 1] if i + 1 < len(onsets) else total_steps,
            total_steps,
        )
        if until > step:
            out.append((step, until - step, members))
    return out


def drum_spans(notes: Sequence[QNote], steps_per_beat: int) -> list[Span]:
    """Drum hits have no length of their own. Each is written as lasting until
    the next hit or the end of its beat, whichever comes first, which is how a
    drum part is read (a hit on the beat is a quarter, not a sixteenth and
    three rests). Hits on the same step are one span."""
    by_step: dict[int, list[QNote]] = defaultdict(list)
    for n in notes:
        by_step[n.step].append(n)
    steps = sorted(by_step)
    out: list[Span] = []
    for i, step in enumerate(steps):
        beat_end = (step // steps_per_beat + 1) * steps_per_beat
        until = min(beat_end, steps[i + 1]) if i + 1 < len(steps) else beat_end
        out.append((step, until - step, sorted(by_step[step], key=lambda q: q.pitch)))
    return out
