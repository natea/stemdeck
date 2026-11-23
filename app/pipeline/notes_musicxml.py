"""Write a song's quantised transcription as a MusicXML score.

One part per stem, built from the quantiser's notes (app/pipeline/quantize.py)
and the beat grid's bars. One beat of the song is one quarter note, so a bar
of four beats is a bar of 4/4, and a bar the grid cut short (a pickup, or the
bar before a meter change) is written with the short signature it has.

music21 does the notation bookkeeping this needs and that is easy to get
wrong by hand: splitting a note at a bar line into tied notes, breaking a
five-sixteenth note into a quarter tied to a sixteenth, filling gaps with
rests, and putting notes that overlap with different lengths into voices.

The result is a correct starting point for a notation program, not an
engraving: no voice-leading choices, no enharmonic spelling beyond the key
signature.

A guitar or bass part also carries its tablature (openspec change
add-alphatab-notation): under its staff of notation, a tab staff with the
string and fret of every note the fingering placed
(app/pipeline/fingering.py), tuned and capoed as the song's tab choices say,
so a notation program shows the same frets as StemDeck's Notation view. The
notation staff keeps every note; a note the instrument cannot play is a rest
on the tab staff. music21 cannot write a tab staff, so it is added to the
finished document (``_add_tablature``), as one voice with the same rhythm the
Notation view draws. The same pass renumbers the voices of a bar, which
music21 counts from 0 and notation programs from 1.

music21 is slow to import, so it is imported inside the function. Nothing at
startup may import this module's dependency (tests/test_transcription_imports.py).
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from fractions import Fraction
from typing import TYPE_CHECKING

from app.pipeline.note_values import NoteValue, chord_spans, drum_spans, split_steps, voice_spans
from app.pipeline.quantize import Bar, QNote

if TYPE_CHECKING:
    from app.pipeline.notes_alphatex import TabStaff

# General MIDI percussion key -> (staff position as a treble-clef pitch,
# notehead). The usual drum-kit layout: kick in the bottom space, snare in the
# third space, cymbals on top with x heads.
_DRUM_DEFAULT = ("C5", "normal")
_DRUM_MAP: dict[int, tuple[str, str]] = {
    35: ("F4", "normal"),  # kick
    36: ("F4", "normal"),
    37: ("C5", "x"),  # side stick
    38: ("C5", "normal"),  # snare
    39: ("C5", "x"),  # clap
    40: ("C5", "normal"),
    41: ("A4", "normal"),  # floor toms
    43: ("A4", "normal"),
    45: ("D5", "normal"),  # mid toms
    47: ("D5", "normal"),
    48: ("E5", "normal"),  # high toms
    50: ("E5", "normal"),
    42: ("G5", "x"),  # closed hi-hat
    44: ("D4", "x"),  # pedal hi-hat
    46: ("G5", "x"),  # open hi-hat
    49: ("A5", "x"),  # crash
    57: ("A5", "x"),
    51: ("F5", "x"),  # ride
    59: ("F5", "x"),
    53: ("F5", "x"),  # ride bell
    52: ("B5", "x"),  # china
    55: ("B5", "x"),  # splash
    54: ("G5", "x"),  # tambourine
    56: ("E5", "x"),  # cowbell
}

_PITCH_CLASSES = ("C", "C#", "D", "E-", "E", "F", "F#", "G", "A-", "A", "B-", "B")


def _key(key_name: str | None, scale: str | None):
    """A music21 Key from the job's detected key, or None.

    The job keeps the key as the chip shows it ("E maj", "G# min") and the
    scale beside it ("Major", "Minor", "Harmonic Minor"), so the tonic is the
    first word and either field can say minor."""
    from music21 import key as m21key

    words = (key_name or "").replace("♯", "#").replace("♭", "b").split()
    if not words or words[0][0].upper() not in "ABCDEFG":
        return None
    tonic = words[0][0].upper() + words[0][1:].replace("b", "-")
    said = f"{' '.join(words[1:])} {scale or ''}".lower()
    mode = "minor" if "min" in said else "major"
    try:
        return m21key.Key(tonic, mode)
    except Exception:
        return None


def _clef(stem: str):
    from music21 import clef

    if stem == "drums":
        return clef.PercussionClef()
    if stem == "bass":
        # Bass sounds an octave below where it is written; the 8vb clef shows
        # the true pitches on the staff a bassist reads.
        return clef.Bass8vbClef()
    if stem == "guitar":
        return clef.Treble8vbClef()
    return clef.TrebleClef()


def _drum_events(
    notes: Sequence[QNote], unit: Fraction, steps_per_beat: int
) -> list[tuple[Fraction, object]]:
    """Each drum span (app.pipeline.note_values.drum_spans) as a percussion
    note, or a percussion chord when several kit pieces are hit together."""
    from music21 import duration, note, percussion

    out: list[tuple[Fraction, object]] = []
    for step, steps, members in drum_spans(notes, steps_per_beat):
        hits = []
        seen: set[tuple[str, str]] = set()
        for n in members:
            display, head = _DRUM_MAP.get(n.pitch, _DRUM_DEFAULT)
            if (display, head) in seen:
                continue
            seen.add((display, head))
            hit = note.Unpitched(displayName=display)
            hit.notehead = head
            hits.append(hit)
        element = hits[0] if len(hits) == 1 else percussion.PercussionChord(hits)
        element.duration = duration.Duration(steps * unit)
        out.append((step * unit, element))
    return out


def _pitched_events(notes: Sequence[QNote], unit: Fraction) -> list[tuple[Fraction, object]]:
    """Each chord span (app.pipeline.note_values.chord_spans) as a note or a
    chord. Spans that overlap are put into voices by music21."""
    from music21 import chord, duration, note

    out: list[tuple[Fraction, object]] = []
    for step, steps, members in chord_spans(notes):
        pitches = sorted({m.pitch for m in members})
        element = note.Note(pitches[0]) if len(pitches) == 1 else chord.Chord(pitches)
        element.duration = duration.Duration(steps * unit)
        out.append((step * unit, element))
    return out


_STEPS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_STEP_OF = ("C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B")
_ALTER_OF = (0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0)
# MusicXML fixes the order of the children of <attributes> and of <note>. A
# new child goes before the first of the elements that must follow it.
_AFTER_STAVES = (
    "part-symbol",
    "instruments",
    "clef",
    "staff-details",
    "transpose",
    "for-part",
    "directive",
    "measure-style",
)
_AFTER_STAFF_DETAILS = ("transpose", "for-part", "directive", "measure-style")
_AFTER_VOICE = (
    "type",
    "dot",
    "accidental",
    "time-modification",
    "stem",
    "notehead",
    "notehead-text",
    "staff",
    "beam",
    "notations",
    "lyric",
    "play",
    "listen",
)
_AFTER_STAFF = ("beam", "notations", "lyric", "play", "listen")
# The staff of notation is staff 1 and the tab staff is staff 2. By MusicXML's
# convention a part's second staff uses voices 5 to 8; the tab is one voice.
_TAB_STAFF = 2
_TAB_VOICE = "5"
_XML_HEAD = b'<?xml version="1.0" encoding="utf-8"?>\n'


def _midi(pitch: ET.Element) -> int:
    step = _STEPS[(pitch.findtext("step") or "C").strip()]
    alter = round(float(pitch.findtext("alter") or 0))
    return 12 * (int(pitch.findtext("octave") or 4) + 1) + step + alter


def _before(parent: ET.Element, followers: tuple[str, ...]) -> int:
    """Where a new child of ``parent`` goes: before the first of ``followers``."""
    return next((i for i, e in enumerate(parent) if e.tag in followers), len(parent))


def _set_voice(note: ET.Element) -> None:
    """Give ``note`` a voice number if it has none. A part music21 wrote in
    one voice has none, and two staves cannot be told apart without."""
    if note.find("voice") is None:
        voice = ET.Element("voice")
        voice.text = "1"
        note.insert(_before(note, _AFTER_VOICE), voice)


def _set_staff(note: ET.Element, number: int) -> None:
    staff = ET.Element("staff")
    staff.text = str(number)
    note.insert(_before(note, _AFTER_STAFF), staff)


# One written value on the tab staff: its length, the (pitch, string, fret)
# of each note sounded (none for a rest), and whether it is tied to the value
# before it and to the value after it.
_TabValue = tuple[NoteValue, list[tuple[int, int, int]], bool, bool]
_TYPE_NAMES = {1: "whole", 2: "half", 4: "quarter", 8: "eighth", 16: "16th", 32: "32nd"}


def _tab_bars(
    notes: Sequence[QNote], tab: TabStaff, bars: Sequence[Bar], per_beat: int
) -> list[list[_TabValue]]:
    """What the tab staff holds, bar by bar: the part as one voice, as the
    Notation view draws it (app/pipeline/notes_alphatex.py). Notes that start
    together are a chord, and a chord ends where the next begins. A chord with
    no note the fingering placed is silence, and silence is written as rests."""
    where = {(p.note.step, p.note.pitch): (p.string, p.fret) for p in tab.placed}
    starts = [bar.start_beat * per_beat for bar in bars]
    sizes = [bar.beats * per_beat for bar in bars]
    sounded: list[list[tuple[int, NoteValue, list[tuple[int, int, int]], bool, bool]]] = [
        [] for _ in bars
    ]
    for step, length, members in voice_spans(notes, sum(sizes)):
        spots = sorted(
            {(m.pitch, *where[(m.step, m.pitch)]) for m in members if (m.step, m.pitch) in where}
        )
        if not spots:
            continue
        pieces: list[tuple[int, int, NoteValue]] = []
        at, left = step, length
        index = bisect_right(starts, at) - 1
        while left > 0 and 0 <= index < len(bars):
            take = min(left, starts[index] + sizes[index] - at)
            if take <= 0:
                break
            offset = at - starts[index]
            for value in split_steps(offset, take, per_beat):
                pieces.append((index, offset, value))
                offset += value.steps
            at += take
            left -= take
            index += 1
        for count, (index, offset, value) in enumerate(pieces):
            sounded[index].append((offset, value, spots, count > 0, count < len(pieces) - 1))

    rows: list[list[_TabValue]] = []
    for index, size in enumerate(sizes):
        row: list[_TabValue] = []
        cursor = 0
        for offset, value, spots, tied_back, tied_on in sounded[index]:
            row.extend(
                (v, [], False, False) for v in split_steps(cursor, offset - cursor, per_beat)
            )
            row.append((value, spots, tied_back, tied_on))
            cursor = offset + value.steps
        row.extend((v, [], False, False) for v in split_steps(cursor, size - cursor, per_beat))
        rows.append(row)
    return rows


def _tab_notes(row: Sequence[_TabValue], per_beat: int, divisions: int) -> list[ET.Element]:
    """One bar of the tab staff as MusicXML notes and rests."""
    out: list[ET.Element] = []
    for value, spots, tied_back, tied_on in row:
        for count, (pitch, string, fret) in enumerate(spots or [(0, 0, 0)]):
            note = ET.Element("note")
            if spots:
                if count:
                    ET.SubElement(note, "chord")
                written = ET.SubElement(note, "pitch")
                ET.SubElement(written, "step").text = _STEP_OF[pitch % 12]
                if _ALTER_OF[pitch % 12]:
                    ET.SubElement(written, "alter").text = str(_ALTER_OF[pitch % 12])
                ET.SubElement(written, "octave").text = str(pitch // 12 - 1)
            else:
                ET.SubElement(note, "rest")
            ET.SubElement(note, "duration").text = str(value.steps * divisions // per_beat)
            if spots and tied_back:
                ET.SubElement(note, "tie", {"type": "stop"})
            if spots and tied_on:
                ET.SubElement(note, "tie", {"type": "start"})
            ET.SubElement(note, "voice").text = _TAB_VOICE
            ET.SubElement(note, "type").text = _TYPE_NAMES[value.denominator]
            if value.dots:
                ET.SubElement(note, "dot")
            if value.tuplet:
                ratio = ET.SubElement(note, "time-modification")
                ET.SubElement(ratio, "actual-notes").text = str(value.tuplet)
                ET.SubElement(ratio, "normal-notes").text = "2"
            ET.SubElement(note, "staff").text = str(_TAB_STAFF)
            if spots:
                notations = ET.SubElement(note, "notations")
                if tied_back:
                    ET.SubElement(notations, "tied", {"type": "stop"})
                if tied_on:
                    ET.SubElement(notations, "tied", {"type": "start"})
                technical = ET.SubElement(notations, "technical")
                ET.SubElement(technical, "string").text = str(string)
                ET.SubElement(technical, "fret").text = str(fret)
            out.append(note)
    return out


def _tab_attributes(attributes: ET.Element, tab: TabStaff) -> None:
    """Make the part two staves: the notation it has, and under it a tab
    staff with a line for each string, tuned as the instrument is. Line 1 is
    the lowest string."""
    staves = ET.Element("staves")
    staves.text = "2"
    attributes.insert(_before(attributes, _AFTER_STAVES), staves)
    for clef in attributes.findall("clef"):
        clef.set("number", "1")
    tab_clef = ET.Element("clef", {"number": str(_TAB_STAFF)})
    ET.SubElement(tab_clef, "sign").text = "TAB"
    ET.SubElement(tab_clef, "line").text = "5"
    details = ET.Element("staff-details", {"number": str(_TAB_STAFF)})
    ET.SubElement(details, "staff-lines").text = str(len(tab.tuning))
    for line, open_pitch in enumerate(tab.tuning, start=1):
        tuning = ET.SubElement(details, "staff-tuning", {"line": str(line)})
        ET.SubElement(tuning, "tuning-step").text = _STEP_OF[open_pitch % 12]
        if _ALTER_OF[open_pitch % 12]:
            ET.SubElement(tuning, "tuning-alter").text = str(_ALTER_OF[open_pitch % 12])
        ET.SubElement(tuning, "tuning-octave").text = str(open_pitch // 12 - 1)
    if tab.capo:
        ET.SubElement(details, "capo").text = str(tab.capo)
    at = _before(attributes, _AFTER_STAFF_DETAILS)
    attributes.insert(at, details)
    attributes.insert(at, tab_clef)


def _number_voices_from_one(root: ET.Element) -> bool:
    """music21 numbers the voices of a bar from 0. MusicXML counts them from
    1, and MuseScore reads a part that has a voice 0 as empty bars: every note
    of a guitar or piano part gone, with no error. Shift such a part's voices
    up by one. Returns whether anything changed."""
    changed = False
    for part in root.findall("part"):
        voices = [v for v in part.iter("voice") if (v.text or "").strip().isdigit()]
        if not any(int(v.text) == 0 for v in voices):
            continue
        for voice in voices:
            voice.text = str(int(voice.text) + 1)
        changed = True
    return changed


def _add_tablature(
    root: ET.Element,
    tabs: Mapping[str, TabStaff],
    parts: Mapping[str, Sequence[QNote]],
    bars: Sequence[Bar],
    per_beat: int,
) -> None:
    """Give each fretted part in ``tabs`` a tab staff under its notation.

    The notation music21 wrote becomes staff 1 and is left as it is, every
    note on it. Staff 2 is written here, bar for bar and in one voice: each
    note the fingering placed, with its string and fret, and rests where
    nothing placed sounds. A notation program shows the tablature as soon as
    the file opens, with the frets StemDeck's Notation view draws.

    (A string and fret on the notes of an ordinary staff, which is all the
    format asks for, is not enough: MuseScore 4 ignores the fret there and
    prints the string as a circled number over every note.)"""
    names = {
        part.get("id"): (part.findtext("part-name") or "").strip()
        for part in root.iter("score-part")
    }
    for part in root.findall("part"):
        stem = names.get(part.get("id"), "")
        tab = tabs.get(stem)
        measures = part.findall("measure")
        # One measure per bar is what music21 was asked for. Were that ever
        # not so, the part keeps its notation and simply has no tab staff.
        if tab is None or len(measures) != len(bars):
            continue
        rows = _tab_bars(parts[stem], tab, bars, per_beat)
        divisions = 1
        two_staves = False
        for measure, bar, row in zip(measures, bars, rows, strict=True):
            for attributes in measure.findall("attributes"):
                if attributes.findtext("divisions"):
                    divisions = int(attributes.findtext("divisions") or 1)
                if not two_staves:
                    _tab_attributes(attributes, tab)
                    two_staves = True
                else:
                    for clef in attributes.findall("clef"):
                        clef.set("number", "1")
            for note in measure.findall("note"):
                _set_voice(note)
                _set_staff(note, 1)
            # Back to the bar line, then the same bar on the tab staff.
            back = ET.Element("backup")
            ET.SubElement(back, "duration").text = str(bar.beats * divisions)
            # A closing bar line stays the last thing in the bar.
            at = next(
                (
                    i
                    for i, e in enumerate(measure)
                    if e.tag == "barline" and e.get("location") != "left"
                ),
                len(measure),
            )
            for offset, new in enumerate([back, *_tab_notes(row, per_beat, divisions)]):
                measure.insert(at + offset, new)


def _finish(
    document: bytes,
    tabs: Mapping[str, TabStaff],
    parts: Mapping[str, Sequence[QNote]],
    bars: Sequence[Bar],
    steps_per_beat: int,
) -> bytes:
    """What music21 cannot be asked to write, put into its document: voices
    counted from 1, and the tablature of the fretted parts. A document that
    needs neither is returned as it was."""
    root = ET.fromstring(document)
    renumbered = _number_voices_from_one(root)
    if tabs:
        _add_tablature(root, tabs, parts, bars, steps_per_beat)
    if not renumbered and not tabs:
        return document
    ET.indent(root, space="  ")
    # The declaration and doctype music21 wrote, then the changed tree.
    head = document[: document.index(b"<score-partwise")]
    return (head or _XML_HEAD) + ET.tostring(root, encoding="utf-8")


def musicxml_score(
    parts: Mapping[str, Sequence[QNote]],
    bars: Sequence[Bar],
    steps_per_beat: int,
    *,
    title: str = "",
    bpm: float | None = None,
    key_name: str | None = None,
    scale: str | None = None,
    tabs: Mapping[str, TabStaff] | None = None,
) -> bytes:
    """The score as MusicXML bytes. ``parts`` maps a stem name to its
    quantised notes, ``bars`` are the grid's bars, ``steps_per_beat`` the
    resolution the notes were quantised at. ``tabs`` gives the tuning, capo
    and fingering of each fretted stem, whose part then has a tab staff under
    its notation."""
    from music21 import duration, metadata, meter, note, stream, tempo
    from music21.musicxml.m21ToXml import GeneralObjectExporter

    unit = Fraction(1, steps_per_beat)
    total_beats = sum(bar.beats for bar in bars)
    score = stream.Score()
    score.metadata = metadata.Metadata()
    score.metadata.title = title or "Transcription"
    score.metadata.composer = "Transcribed by StemDeck"
    key_signature = _key(key_name, scale)

    for index, (stem, notes) in enumerate(parts.items()):
        part = stream.Part()
        part.id = stem
        part.partName = stem
        part.insert(0, _clef(stem))
        if key_signature is not None and stem != "drums":
            part.insert(0, _key(key_name, scale))
        if index == 0 and bpm:
            part.insert(0, tempo.MetronomeMark(number=round(float(bpm))))

        # A time signature wherever the bar length changes. Bar lengths are the
        # grid's, so the measures music21 cuts are exactly the song's bars.
        last_len: int | None = None
        for bar in bars:
            if bar.beats != last_len:
                part.insert(bar.start_beat, meter.TimeSignature(f"{bar.beats}/4"))
                last_len = bar.beats

        if stem == "drums":
            events = _drum_events(notes, unit, steps_per_beat)
        else:
            events = _pitched_events(notes, unit)
        covered = Fraction(0)
        for offset, element in events:
            # A note that would run past the last bar ends with it.
            room = Fraction(total_beats) - offset
            if room <= 0:
                continue
            if element.duration.quarterLength > room:
                element.duration.quarterLength = room
            part.insert(offset, element)
            covered = max(covered, offset + element.duration.quarterLength)
        # Every part is as long as the song, so they all have the same bars:
        # a part that stops early ends in rests, not a shorter staff.
        if covered < total_beats:
            tail = note.Rest()
            tail.duration = duration.Duration(Fraction(total_beats) - covered)
            part.insert(covered, tail)
        # Gaps become written rests. Left to the exporter they are filled with
        # hidden ones, and a notation program then shows bars with holes.
        part.makeRests(fillGaps=True, inPlace=True, hideRests=False)
        score.insert(0, part)

    document = GeneralObjectExporter(score).parse()
    fretted = {stem: tab for stem, tab in (tabs or {}).items() if stem in parts}
    return _finish(document, fretted, parts, bars, steps_per_beat)
