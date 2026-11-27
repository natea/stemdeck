"""What a chord is, as StemDeck stores one.

A chord timeline is a list of entries. Each entry has a start and an end in
seconds from the start of the song, and either a chord or "no chord":

    {"start": 2.6, "end": 5.1, "root": 0, "degrees": ["1", "3", "5", "b7"], "bass": 4}
    {"start": 0.0, "end": 2.6, "root": None, "degrees": [], "bass": None}

- ``root`` and ``bass`` are pitch classes, 0 for C to 11 for B. ``root`` is
  None for "no chord"; ``bass`` is None when the bass note is the root or is
  not known.
- ``degrees`` are the chord tones as scale-degree names counted from the root:
  ``1``, ``b3``, ``5``, ``b7``, ``9``, ``#11``. Names, not semitones, because a
  sharp eleventh and a flat fifth are the same key on a piano and are written
  differently in a chord symbol.

No note name and no finished symbol is stored. Which name a pitch class gets
(G sharp or A flat) depends on the song's key and on how far the player has
transposed it, and both are known only where the chord is shown
(static/js/harmony/chords.js).

Shared by the reader of the detector's labels (app/pipeline/chord_labels.py),
the files (app/core/chord_files.py), the beat alignment
(app/pipeline/chord_snap.py) and the API (app/api/chords.py). Pure functions,
no I/O.
"""

from __future__ import annotations

import math
import re
from typing import Any

# Semitones above the root of each unaltered degree, to the thirteenth.
_NATURAL: dict[int, int] = {
    1: 0,
    2: 2,
    3: 4,
    4: 5,
    5: 7,
    6: 9,
    7: 11,
    8: 12,
    9: 14,
    10: 16,
    11: 17,
    12: 19,
    13: 21,
}
_DEGREE_RE = re.compile(r"^(b{0,2}|#{0,2})(1[0-3]|[1-9])$")

# Every degree name an entry may hold: 1 to 13, with up to two flats or sharps.
DEGREE_NAMES: frozenset[str] = frozenset(
    f"{accidental}{number}" for number in _NATURAL for accidental in ("", "b", "bb", "#", "##")
)

# A timeline longer than this is not a chord chart of a song: the longest
# import is 20 minutes, and a chord per beat at 300 BPM is 6,000.
MAX_ENTRIES = 5000
# A stored label is the detector's own text; nothing it writes is this long.
MAX_LABEL_CHARS = 64


def split_degree(name: str) -> tuple[int, int] | None:
    """A degree name as (number, alteration): ``"b7"`` is (7, -1), ``"#11"``
    is (11, 1). None when it is not a degree."""
    match = _DEGREE_RE.match(name) if isinstance(name, str) else None
    if match is None:
        return None
    accidental, number = match.group(1), int(match.group(2))
    return number, (len(accidental) if accidental.startswith("#") else -len(accidental))


def degree_name(number: int, alter: int) -> str:
    return ("#" * alter if alter > 0 else "b" * -alter) + str(number)


def degree_semitones(name: str) -> int:
    """How many semitones above the root a degree is, as a pitch class (so a
    ninth is 2). Raises ValueError for a name that is not a degree."""
    parts = split_degree(name)
    if parts is None:
        raise ValueError(f"not a chord degree: {name!r}")
    number, alter = parts
    return (_NATURAL[number] + alter) % 12


def sort_degrees(names) -> list[str]:
    """The degrees once each, in the order they are stored: by number, flats
    before naturals before sharps."""
    seen: dict[tuple[int, int], str] = {}
    for name in names:
        parts = split_degree(name)
        if parts is not None:
            seen[parts] = degree_name(*parts)
    return [seen[key] for key in sorted(seen)]


def no_chord(start: float, end: float) -> dict[str, Any]:
    return {"start": start, "end": end, "root": None, "degrees": [], "bass": None}


def same_chord(a: dict, b: dict) -> bool:
    """Whether two entries hold the same chord over the same bass note. Two
    "no chord" entries are the same."""
    return (
        a.get("root") == b.get("root")
        and a.get("bass") == b.get("bass")
        and list(a.get("degrees") or []) == list(b.get("degrees") or [])
    )


def _pitch_class(value: object) -> int | None:
    # bool is an int in Python; True is not the note C sharp.
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 11:
        raise ValueError("pitch class out of range")
    return value


def _time(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("time is not a number")
    number = float(value)
    if not math.isfinite(number) or not 0 <= number < 86400:
        raise ValueError("time out of range")
    return round(number, 3)


def clean_entry(raw: object, *, keep_label: bool) -> dict[str, Any]:
    """One entry in the stored shape, or ValueError. The message never repeats
    the value that was refused: it may be echoed to a client."""
    if not isinstance(raw, dict):
        raise ValueError("entry is not an object")
    start, end = _time(raw.get("start")), _time(raw.get("end"))
    if end <= start:
        raise ValueError("entry ends before it starts")
    root = raw.get("root")
    degrees_raw = raw.get("degrees")
    if degrees_raw is None:
        degrees_raw = []
    if not isinstance(degrees_raw, list) or len(degrees_raw) > len(DEGREE_NAMES):
        raise ValueError("degrees is not a list")
    if any(name not in DEGREE_NAMES for name in degrees_raw):
        raise ValueError("unknown chord degree")
    if root is None:
        entry = no_chord(start, end)
    else:
        bass = raw.get("bass")
        root = _pitch_class(root)
        bass = None if bass is None else _pitch_class(bass)
        entry = {
            "start": start,
            "end": end,
            "root": root,
            # A chord always has its root, whatever a rootless voicing left out.
            "degrees": sort_degrees(degrees_raw) or ["1"],
            "bass": None if bass == root else bass,
        }
    if keep_label:
        label = raw.get("label")
        if isinstance(label, str) and label:
            entry["label"] = label[:MAX_LABEL_CHARS]
    return entry


def clean_entries(raw: object, *, keep_label: bool = False) -> list[dict[str, Any]]:
    """A timeline in the stored shape, or ValueError: every entry valid, in
    time order, none overlapping the one before it."""
    if not isinstance(raw, list):
        raise ValueError("chords is not a list")
    if len(raw) > MAX_ENTRIES:
        raise ValueError("too many chords")
    out: list[dict[str, Any]] = []
    for item in raw:
        entry = clean_entry(item, keep_label=keep_label)
        if out and entry["start"] < out[-1]["end"]:
            raise ValueError("chords overlap or are out of order")
        out.append(entry)
    return out


def fill_gaps(entries: list[dict[str, Any]], duration: float | None = None) -> list[dict[str, Any]]:
    """The timeline with "no chord" wherever it said nothing: before the first
    entry, between two that do not touch, and up to ``duration`` when that is
    known and later than the last entry. Entries are assumed clean."""
    out: list[dict[str, Any]] = []
    at = 0.0
    for entry in entries:
        if entry["start"] > at:
            out.append(no_chord(at, entry["start"]))
        out.append(entry)
        at = entry["end"]
    if duration is not None and math.isfinite(duration) and duration > at + 1e-3:
        out.append(no_chord(at, round(float(duration), 3)))
    return out
