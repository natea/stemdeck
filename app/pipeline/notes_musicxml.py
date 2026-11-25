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
finished document (``_add_tablature``). The same pass renumbers the voices of
a bar, which music21 counts from 0 and notation programs from 1.

music21 is slow to import, so it is imported inside the function. Nothing at
startup may import this module's dependency (tests/test_transcription_imports.py).
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections.abc import Mapping, Sequence
from copy import deepcopy
from fractions import Fraction
from typing import TYPE_CHECKING

from app.pipeline.note_values import chord_spans, drum_spans
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


# A staff holds at most four voices in MuseScore and most other notation
# programs, and a tab staff's voices are 5 to 8 (_TAB_VOICE_SHIFT). More
# overlapping spans than that and MuseScore calls the file corrupted.
_MAX_VOICES = 4


def _within_voices(spans: Sequence) -> list[tuple[int, int, list[int]]]:
    """``spans`` as (step, steps, pitches), cut so that no more than
    ``_MAX_VOICES`` sound at once. When one more would start, the span that
    began earliest is shortened to end there; if every sounding span began on
    that same step, the new pitches join the one closest in length instead."""
    kept: list[list] = []  # [step, steps, pitches]
    for step, steps, members in spans:
        pitches = sorted({m.pitch for m in members})
        sounding = [s for s in kept if s[0] + s[1] > step]
        if len(sounding) >= _MAX_VOICES:
            earliest = min(sounding, key=lambda s: s[0])
            if earliest[0] < step:
                earliest[1] = step - earliest[0]
            else:
                closest = min(sounding, key=lambda s: abs(s[1] - steps))
                closest[2] = sorted(set(closest[2]) | set(pitches))
                continue
        kept.append([step, steps, pitches])
    return [(s[0], s[1], s[2]) for s in kept]


def _pitched_events(notes: Sequence[QNote], unit: Fraction) -> list[tuple[Fraction, object]]:
    """Each chord span (app.pipeline.note_values.chord_spans) as a note or a
    chord. Spans that overlap are put into voices by music21."""
    from music21 import chord, duration, note

    out: list[tuple[Fraction, object]] = []
    for step, steps, pitches in _within_voices(chord_spans(notes)):
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
# What a tab note does not carry: tablature shows a fret on a string, not a
# notehead with an accidental and a stem.
_NOT_ON_TAB = ("accidental", "stem", "notehead", "notehead-text", "beam", "staff")
# The staff of notation is staff 1 and the tab staff is staff 2. By MusicXML's
# convention a part's second staff uses voices 5 to 8.
_TAB_STAFF = 2
_TAB_VOICE_SHIFT = 4
_XML_HEAD = b'<?xml version="1.0" encoding="utf-8"?>\n'


def _midi(pitch: ET.Element) -> int:
    step = _STEPS[(pitch.findtext("step") or "C").strip()]
    alter = round(float(pitch.findtext("alter") or 0))
    return 12 * (int(pitch.findtext("octave") or 4) + 1) + step + alter


def _before(parent: ET.Element, followers: tuple[str, ...]) -> int:
    """Where a new child of ``parent`` goes: before the first of ``followers``."""
    return next((i for i, e in enumerate(parent) if e.tag in followers), len(parent))


def _set_voice(note: ET.Element, shift: int = 0) -> None:
    """Give ``note`` a voice number, moved up by ``shift``. A part music21
    wrote in one voice has none, and two staves cannot be told apart without."""
    voice = note.find("voice")
    if voice is None:
        voice = ET.Element("voice")
        voice.text = "1"
        note.insert(_before(note, _AFTER_VOICE), voice)
    voice.text = str(int(voice.text or 1) + shift)


def _set_staff(note: ET.Element, number: int) -> None:
    staff = ET.Element("staff")
    staff.text = str(number)
    note.insert(_before(note, _AFTER_STAFF), staff)


def _tab_note(note: ET.Element, spot: tuple[int, int], first: bool) -> ET.Element:
    """``note`` as it is written on the tab staff: the same pitch and length,
    with its string and fret. ``first`` is whether it leads its chord."""
    copy = deepcopy(note)
    for child in [c for c in copy if c.tag in _NOT_ON_TAB]:
        copy.remove(child)
    chord = copy.find("chord")
    if first and chord is not None:
        copy.remove(chord)
    elif not first and chord is None:
        copy.insert(0, ET.Element("chord"))
    _set_voice(copy, _TAB_VOICE_SHIFT)
    _set_staff(copy, _TAB_STAFF)
    notations = copy.find("notations")
    if notations is None:
        notations = ET.SubElement(copy, "notations")
    technical = ET.SubElement(notations, "technical")
    ET.SubElement(technical, "string").text = str(spot[0])
    ET.SubElement(technical, "fret").text = str(spot[1])
    return copy


def _tab_rest(note: ET.Element) -> ET.Element:
    """A rest on the tab staff as long as ``note``: where the notation staff
    has a rest, or a note the instrument cannot play."""
    rest = ET.Element("note")
    ET.SubElement(rest, "rest")
    for child in note:
        if child.tag in ("duration", "voice", "type", "dot", "time-modification"):
            rest.append(deepcopy(child))
    _set_voice(rest, _TAB_VOICE_SHIFT)
    _set_staff(rest, _TAB_STAFF)
    return rest


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


def _add_tablature(root: ET.Element, tabs: Mapping[str, TabStaff], steps_per_beat: int) -> None:
    """Give each fretted part in ``tabs`` a tab staff under its notation.

    The notation music21 wrote becomes staff 1 and is left as it is, every
    note on it. Staff 2 is written here, bar for bar: each note the fingering
    placed, with its string and fret, and a rest wherever the notation has a
    rest or a note the instrument cannot play. A notation program shows the
    tablature as soon as the file opens, with the frets StemDeck's Notation
    view draws.

    (A string and fret on the notes of an ordinary staff, which is all the
    format asks for, is not enough: MuseScore 4 ignores the fret there and
    prints the string as a circled number over every note.)

    A written note is matched to its fingering by where it starts and its
    pitch. A long note that music21 split into tied notes has the same string
    and fret on every piece."""
    names = {
        part.get("id"): (part.findtext("part-name") or "").strip()
        for part in root.iter("score-part")
    }
    for part in root.findall("part"):
        tab = tabs.get(names.get(part.get("id"), ""))
        if tab is None:
            continue
        where = {(p.note.step, p.note.pitch): (p.string, p.fret) for p in tab.placed}
        held: dict[int, tuple[int, int]] = {}  # a tied note's place, by pitch
        divisions = 1
        bar_start = Fraction(0)  # in beats, from the start of the song
        two_staves = False
        for measure in part.findall("measure"):
            cursor = last_onset = furthest = 0  # in divisions, from the bar line
            on_tab: list[ET.Element] = []
            # The notes of the chord being read, each with its place or None.
            chord: list[tuple[ET.Element, tuple[int, int] | None]] = []

            def flush(into: list[ET.Element] = on_tab, group: list = chord) -> None:
                kept = [(note, spot) for note, spot in group if spot is not None]
                if kept:
                    into.extend(_tab_note(n, s, first=i == 0) for i, (n, s) in enumerate(kept))
                elif group:
                    into.append(_tab_rest(group[0][0]))
                group.clear()

            for element in list(measure):
                if element.tag == "attributes":
                    if element.findtext("divisions"):
                        divisions = int(element.findtext("divisions") or 1)
                    if not two_staves:
                        _tab_attributes(element, tab)
                        two_staves = True
                    else:
                        for clef in element.findall("clef"):
                            clef.set("number", "1")
                    continue
                if element.tag not in ("note", "backup", "forward"):
                    continue
                length = int(element.findtext("duration") or 0)
                if element.tag in ("backup", "forward"):
                    flush()
                    cursor += length if element.tag == "forward" else -length
                    furthest = max(furthest, cursor)
                    on_tab.append(deepcopy(element))
                    continue
                # A note of a chord starts where the chord's first note did.
                if element.find("chord") is None:
                    flush()
                    last_onset = cursor
                    cursor += length
                    furthest = max(furthest, cursor)
                spot = None
                pitch = element.find("pitch")
                if pitch is not None:
                    number = _midi(pitch)
                    ties = {tie.get("type") for tie in element.findall("tie")}
                    if "stop" in ties and number in held:
                        spot = held[number]
                    else:
                        beat = bar_start + Fraction(last_onset, divisions)
                        spot = where.get((round(beat * steps_per_beat), number))
                    if "start" in ties and spot is not None:
                        held[number] = spot
                    elif "start" not in ties:
                        held.pop(number, None)
                chord.append((element, spot))
                _set_voice(element)
                _set_staff(element, 1)
            flush()
            if furthest > 0 and on_tab:
                # Back to the bar line, then the same bar on the tab staff.
                back = ET.Element("backup")
                ET.SubElement(back, "duration").text = str(furthest)
                # A closing bar line stays the last thing in the bar.
                at = next(
                    (
                        i
                        for i, e in enumerate(measure)
                        if e.tag == "barline" and e.get("location") != "left"
                    ),
                    len(measure),
                )
                for offset, new in enumerate([back, *on_tab]):
                    measure.insert(at + offset, new)
            bar_start += Fraction(furthest, divisions)


def _finish(document: bytes, tabs: Mapping[str, TabStaff], steps_per_beat: int) -> bytes:
    """What music21 cannot be asked to write, put into its document: voices
    counted from 1, and the tablature of the fretted parts. A document that
    needs neither is returned as it was."""
    root = ET.fromstring(document)
    renumbered = _number_voices_from_one(root)
    if tabs:
        _add_tablature(root, tabs, steps_per_beat)
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
    return _finish(document, fretted, steps_per_beat)
