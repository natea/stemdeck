"""Reading the chord detector's labels.

lv-chordia names chords in Harte notation, the syntax chord research uses:

    F# : min7 (b13, *5) / b3
    |     |      |         |
    |     |      |         the bass note, as a degree above the root
    |     |      extra tones; "*5" leaves out a tone the shorthand brought
    |     a shorthand for a base chord
    the root

    C:(1,5)   no shorthand: the list is the chord
    C         a root alone is a major triad
    N         no chord
    X         the detector does not know

This turns a label into what StemDeck stores (app/core/chord_model.py): the
root as a pitch class, the chord tones as degree names, the bass note as a
pitch class. Nothing here writes a chord symbol; that is done where the chord
is shown, in static/js/harmony/chords.js.

A label that cannot be read is "no chord", never an error: one odd label must
not cost a whole detection. The detector's label is kept beside each entry
(app/pipeline/chords_worker.py), so a later reader can do better.

Pure functions, no model and no I/O.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from app.core.chord_model import (
    degree_name,
    degree_semitones,
    fill_gaps,
    no_chord,
    same_chord,
    sort_degrees,
    split_degree,
)

logger = logging.getLogger("stemdeck.chords")

_NOTE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_ROOT_RE = re.compile(r"^([A-G])([#b]*)$")

# Each shorthand's chord tones. The names are Harte's, with the extensions
# mir_eval added (the ninths, elevenths and thirteenths, "1" and "5").
SHORTHANDS: dict[str, tuple[str, ...]] = {
    "maj": ("1", "3", "5"),
    "min": ("1", "b3", "5"),
    "dim": ("1", "b3", "b5"),
    "aug": ("1", "3", "#5"),
    "sus2": ("1", "2", "5"),
    "sus4": ("1", "4", "5"),
    "maj6": ("1", "3", "5", "6"),
    "min6": ("1", "b3", "5", "6"),
    "7": ("1", "3", "5", "b7"),
    "maj7": ("1", "3", "5", "7"),
    "min7": ("1", "b3", "5", "b7"),
    "minmaj7": ("1", "b3", "5", "7"),
    "dim7": ("1", "b3", "b5", "bb7"),
    "hdim7": ("1", "b3", "b5", "b7"),
    "9": ("1", "3", "5", "b7", "9"),
    "maj9": ("1", "3", "5", "7", "9"),
    "min9": ("1", "b3", "5", "b7", "9"),
    "11": ("1", "3", "5", "b7", "9", "11"),
    "maj11": ("1", "3", "5", "7", "9", "11"),
    "min11": ("1", "b3", "5", "b7", "9", "11"),
    "13": ("1", "3", "5", "b7", "9", "11", "13"),
    "maj13": ("1", "3", "5", "7", "9", "11", "13"),
    "min13": ("1", "b3", "5", "b7", "9", "11", "13"),
    "1": ("1",),
    "5": ("1", "5"),
}

# The detector's two labels that are not a chord.
NO_CHORD_LABELS = frozenset({"N", "X"})

# Labels already reported as unreadable, so a song with one odd label on every
# bar writes one log line, not three hundred.
_reported: set[str] = set()


def _root(text: str) -> int | None:
    match = _ROOT_RE.match(text)
    if match is None:
        return None
    letter, accidentals = match.groups()
    return (_NOTE[letter] + accidentals.count("#") - accidentals.count("b")) % 12


def _degree(text: str) -> str | None:
    """A degree as the label writes it, in the stored spelling, or None."""
    parts = split_degree(text.strip())
    return None if parts is None else degree_name(*parts)


def parse_label(label: object) -> dict[str, Any] | None:
    """A Harte label as ``{"root", "degrees", "bass"}``, or None for "no
    chord": the detector's ``N`` and ``X``, and anything that is not a chord."""
    if not isinstance(label, str):
        return None
    text = label.strip()
    if not text or text in NO_CHORD_LABELS:
        return None

    body, slash, bass_text = text.partition("/")
    root_text, colon, kind = body.partition(":")
    root = _root(root_text.strip())
    if root is None:
        return None
    kind = kind.strip()

    shorthand, paren, listed = kind.partition("(")
    shorthand = shorthand.strip()
    if paren and not listed.endswith(")"):
        return None
    listed = listed[:-1] if paren else ""

    if shorthand:
        base = SHORTHANDS.get(shorthand)
        if base is None:
            return None
        tones = set(base)
    elif paren:
        # A list with no shorthand is the whole chord, over its root.
        tones = {"1"}
    else:
        # "C" and "C:" are both a major triad.
        if colon and kind:
            return None
        tones = set(SHORTHANDS["maj"])

    for item in (part.strip() for part in listed.split(",")):
        if not item:
            continue
        omit = item.startswith("*")
        name = _degree(item[1:] if omit else item)
        if name is None:
            return None
        if omit:
            tones.discard(name)
        else:
            # An altered fifth takes the place of the fifth. Harte's grammar
            # says a listed degree is only ever added, which would make
            # "min7(b5)" a minor seventh with both fifths; the people who
            # annotated the data the model learned from wrote it for the
            # half-diminished chord, as every chart does. Where a label does
            # leave the fifth out itself ("7(b5,*5)") this changes nothing.
            parts = split_degree(name)
            if parts is not None and parts[0] == 5 and parts[1] != 0:
                tones.discard("5")
            tones.add(name)

    bass: int | None = None
    if slash:
        bass_degree = _degree(bass_text)
        if bass_degree is None:
            return None
        bass = (root + degree_semitones(bass_degree)) % 12
        if bass == root:
            bass = None

    # A rootless voicing ("maj(*1)") is still a chord on that root.
    return {"root": root, "degrees": sort_degrees(tones) or ["1"], "bass": bass}


def _warn_once(label: object) -> None:
    key = repr(label)[:80]
    if key not in _reported:
        _reported.add(key)
        logger.warning("chord label not understood, stored as no chord: %s", key)


def entries_from_segments(segments: object, duration: float | None = None) -> list[dict[str, Any]]:
    """The detector's output as a stored timeline.

    ``segments`` is lv-chordia's list of ``{"start_time", "end_time",
    "chord"}``. The result is in time order, has no overlaps, says "no chord"
    wherever the detector said nothing, and joins neighbours that are the same
    chord over the same bass note. Each entry keeps the detector's label; a
    joined entry keeps the first one. A segment with no usable times is
    dropped."""
    rows: list[tuple[float, float, str]] = []
    for seg in segments if isinstance(segments, list) else []:
        if not isinstance(seg, dict):
            continue
        try:
            start, end = float(seg.get("start_time")), float(seg.get("end_time"))
        except (TypeError, ValueError):
            continue
        # NaN fails both comparisons.
        if not (start >= 0 and end > start):
            continue
        label = seg.get("chord")
        rows.append((start, end, label if isinstance(label, str) else ""))
    rows.sort(key=lambda row: (row[0], row[1]))
    # The detector works in frames, so its last segment can end a few
    # hundredths of a second after the audio does. The timeline ends with the
    # song.
    limit = float(duration) if isinstance(duration, (int, float)) and duration > 0 else None
    if limit is not None:
        rows = [(start, min(end, limit), label) for start, end, label in rows if start < limit]

    entries: list[dict[str, Any]] = []
    at = 0.0
    for start, end, label in rows:
        # A segment that begins inside the one before it is clipped to start
        # where that one ends.
        start = max(start, at)
        if end - start < 1e-3:
            continue
        start, end = round(start, 3), round(end, 3)
        if end <= start:
            continue
        chord = parse_label(label)
        if chord is None:
            if label.strip() not in NO_CHORD_LABELS:
                _warn_once(label)
            entry = no_chord(start, end)
        else:
            entry = {"start": start, "end": end, **chord}
        entry["label"] = label
        if entries and entries[-1]["end"] == start and same_chord(entries[-1], entry):
            entries[-1]["end"] = end
        else:
            entries.append(entry)
        at = end
    filled = fill_gaps(entries, duration)
    for entry in filled:
        entry.setdefault("label", "N")
    return filled


def has_chords(entries: list[dict[str, Any]]) -> bool:
    """Whether a timeline names any chord at all."""
    return any(entry.get("root") is not None for entry in entries)
