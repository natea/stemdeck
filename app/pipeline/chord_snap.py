"""Putting chord changes on the beat.

The detector places a chord change where it hears one, to a hundredth of a
second. A chart places it on a beat. This moves every boundary between two
entries of a timeline to the nearest beat of the song's grid.

It is a pure function of the stored timeline and the grid, run each time the
timeline is read (app/api/chords.py). The stored detection keeps the detector's own
times, so a beat grid corrected afterwards moves the chords with it.

What `snap` does, in order:

1. An entry shorter than ``min_beats`` beats is given to its neighbours: the
   boundary between them goes to its middle. Done shortest first, so a run of
   flickers settles into the chords around it. The first and the last entry
   are left alone: the detector's lead-in and tail are short by nature.
2. Every boundary between two entries moves to the nearest beat. The start of
   the first entry and the end of the last stay where they are.
3. An entry left with no length is dropped.
4. Neighbours that are the same chord over the same bass note are joined.

The result covers exactly the span the input covered, with no gap and no
overlap, and snapping it again changes nothing.
"""

from __future__ import annotations

import bisect
import math
from typing import Any

from app.core.chord_model import same_chord

# How far under ``min_beats`` an entry may be and still count as that long.
# Entry times are kept to the millisecond and beats to the microsecond, so an
# entry that sits exactly on two beats measures a hair under a whole one.
_LENGTH_SLACK_BEATS = 0.02


def usable_beats(grid: dict | None) -> list[float] | None:
    """The grid's beat times when there are enough to snap to, else None. Two
    beats are the least that say how long a beat is."""
    beats = grid.get("beats") if isinstance(grid, dict) else None
    if not isinstance(beats, list):
        return None
    times = sorted(
        float(t)
        for t in beats
        if isinstance(t, (int, float)) and not isinstance(t, bool) and math.isfinite(t)
    )
    return times if len(times) >= 2 else None


def nearest_beat(beats: list[float], time: float) -> float:
    """The beat closest to ``time``; the earlier one on a tie."""
    i = bisect.bisect_left(beats, time)
    if i <= 0:
        return beats[0]
    if i >= len(beats):
        return beats[-1]
    before, after = beats[i - 1], beats[i]
    return before if time - before <= after - time else after


def beat_position(beats: list[float], time: float) -> float:
    """``time`` as a count of beats from the first one, between two beats in
    proportion, and before the first or after the last at the length of the
    nearest interval."""
    if time <= beats[0]:
        return (time - beats[0]) / (beats[1] - beats[0])
    if time >= beats[-1]:
        return len(beats) - 1 + (time - beats[-1]) / (beats[-1] - beats[-2])
    i = bisect.bisect_right(beats, time) - 1
    return i + (time - beats[i]) / (beats[i + 1] - beats[i])


def _join(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for entry in entries:
        if out and same_chord(out[-1], entry):
            out[-1]["end"] = entry["end"]
        else:
            out.append(entry)
    return out


def _give_away_short(
    entries: list[dict[str, Any]], beats: list[float], min_beats: float
) -> list[dict[str, Any]]:
    """Step 1: no entry but the first and the last is shorter than
    ``min_beats``."""
    entries = _join(entries)
    while len(entries) > 2:
        lengths = [
            beat_position(beats, e["end"]) - beat_position(beats, e["start"]) for e in entries
        ]
        # The shortest of the entries that are too short, edges excluded.
        index = min(range(1, len(entries) - 1), key=lambda i: lengths[i])
        if lengths[index] >= min_beats - _LENGTH_SLACK_BEATS:
            break
        gone = entries.pop(index)
        middle = round((gone["start"] + gone["end"]) / 2, 3)
        entries[index - 1]["end"] = middle
        entries[index]["start"] = middle
        entries = _join(entries)
    return entries


def snap(
    chords: list[dict[str, Any]], beats: list[float] | None, min_beats: float = 1.0
) -> list[dict[str, Any]]:
    """``chords`` with every change on a beat of ``beats``.

    ``chords`` is a clean timeline in time order with no gaps
    (app.core.chord_model). ``beats`` is `usable_beats` of the song's grid;
    with None the timeline is returned as it is, copied. ``min_beats`` is the
    shortest chord that is kept as its own entry; 0 keeps every one that still
    has a length after the move, which is what a timeline the user placed by
    hand wants."""
    entries = [dict(entry) for entry in chords]
    if not entries or not beats or len(beats) < 2:
        return entries

    if min_beats > 0:
        entries = _give_away_short(entries, beats, min_beats)

    for before, after in zip(entries, entries[1:], strict=False):
        at = round(nearest_beat(beats, after["start"]), 3)
        # Never past the ends of the timeline: a boundary stays inside it.
        at = min(max(at, entries[0]["start"]), entries[-1]["end"])
        before["end"] = at
        after["start"] = at

    return _join([entry for entry in entries if entry["end"] - entry["start"] > 1e-9])
