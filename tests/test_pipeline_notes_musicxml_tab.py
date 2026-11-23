"""Tablature in the MusicXML score (app/pipeline/notes_musicxml.py): a tab
staff under the notation of a guitar or bass part, with the string and fret
of each placed note and the part's tuning and capo
(openspec change add-alphatab-notation, task 6.1).

Scenarios of "The MusicXML score carries tablature for fretted stems" in the
notation-export spec. The output is read back two ways: as XML, for what was
written, and by music21, for whether a notation program would accept it.
What MuseScore 4 makes of it was checked by hand on a real song: it shows
the tab staff with these frets.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from fractions import Fraction

import pytest
from fastapi.testclient import TestClient

from app.core.config import QUANTIZE_PARTS, TAB_TUNINGS
from app.core.models import Job
from app.core.registry import _jobs, _procs
from app.core.transcription_files import write_notes
from app.pipeline.fingering import assign
from app.pipeline.notes_alphatex import TabStaff
from app.pipeline.notes_musicxml import musicxml_score
from app.pipeline.quantize import QNote, bars_of

pytest.importorskip("music21")

GUITAR = TAB_TUNINGS["guitar"]["standard"]
_STEPS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# The order MusicXML requires of a note's children.
_NOTE_ORDER = [
    "chord", "pitch", "unpitched", "rest", "duration", "tie", "voice", "type", "dot",
    "accidental", "time-modification", "stem", "notehead", "staff", "beam", "notations",
]  # fmt: skip


def _q(pitch: int, step: int, steps: int) -> QNote:
    return QNote(pitch, 90, step, steps, 1, 1, 0, 0.0, 0.0)


def _grid(n: int = 9) -> dict:
    return {
        "beats": [round(0.5 * i, 3) for i in range(n)],
        "bars": [{"beat": 0, "beats_per_bar": 4}],
    }


def _score(parts, tabs, per_beat: int = 4) -> ET.Element:
    grid = _grid()
    data = musicxml_score(parts, bars_of(grid, len(grid["beats"])), per_beat, tabs=tabs)
    assert data.startswith(b"<?xml")
    assert b"<!DOCTYPE score-partwise" in data[:300]
    return ET.fromstring(data)


def _tab(stem: str, notes, preset: str = "standard", capo: int = 0) -> dict[str, TabStaff]:
    tuning = TAB_TUNINGS[stem][preset]
    placed, _ = assign(notes, tuning, capo)
    return {stem: TabStaff(tuning, capo, "both", placed)}


def _part(root: ET.Element, name: str) -> ET.Element:
    ids = {p.findtext("part-name"): p.get("id") for p in root.iter("score-part")}
    return next(p for p in root.findall("part") if p.get("id") == ids[name])


def _midi(note: ET.Element) -> int | None:
    pitch = note.find("pitch")
    if pitch is None:
        return None
    return (
        12 * (int(pitch.findtext("octave")) + 1)
        + _STEPS[pitch.findtext("step")]
        + round(float(pitch.findtext("alter") or 0))
    )


def _staff(part: ET.Element, number: int) -> list[dict]:
    """Every note and rest written on one staff of the part, in order."""
    out = []
    for measure in part.findall("measure"):
        for note in measure.findall("note"):
            if note.findtext("staff", "1") != str(number):
                continue
            technical = note.find("notations/technical")
            out.append(
                {
                    "bar": measure.get("number"),
                    "pitch": _midi(note),
                    "string": None if technical is None else technical.findtext("string"),
                    "fret": None if technical is None else technical.findtext("fret"),
                    "ties": sorted(t.get("type") for t in note.findall("tie")),
                    "chord": note.find("chord") is not None,
                    "type": note.findtext("type"),
                    "voice": note.findtext("voice"),
                }
            )
    return out


def _sounds(written: list[dict], tuning, capo: int = 0) -> bool:
    """Open string + capo + fret is the note's pitch, for every tab note."""
    return all(
        tuning[len(tuning) - int(n["string"])] + capo + int(n["fret"]) == n["pitch"]
        for n in written
        if n["pitch"] is not None
    )


def test_the_part_has_a_tab_staff_under_its_notation():
    notes = [_q(40, 0, 4), _q(45, 4, 4)]
    part = _part(_score({"guitar": notes}, _tab("guitar", notes)), "guitar")
    attributes = part.find("measure/attributes")
    assert attributes.findtext("staves") == "2"
    clefs = [
        (c.get("number"), c.findtext("sign"), c.findtext("line"))
        for c in attributes.findall("clef")
    ]
    assert clefs == [("1", "G", "2"), ("2", "TAB", "5")]
    details = attributes.find("staff-details")
    assert details.get("number") == "2"
    assert details.findtext("staff-lines") == "6"  # one line per string
    # In the order MusicXML requires: time, staves, clefs, staff details.
    order = [e.tag for e in attributes]
    assert order.index("time") < order.index("staves") < order.index("clef")
    assert order[-1] == "staff-details" and order.count("clef") == 2
    # Written once, in the first bar.
    assert len(list(part.iter("staves"))) == 1
    assert len(list(part.iter("staff-details"))) == 1


def test_every_placed_note_is_on_the_tab_staff_with_its_string_and_fret():
    # A line, a chord, and a note held across the bar line.
    notes = [_q(40, 0, 4), _q(45, 4, 4), _q(52, 8, 4), _q(55, 8, 4), _q(59, 8, 4), _q(64, 12, 8)]
    tabs = _tab("guitar", notes)
    part = _part(_score({"guitar": notes}, tabs), "guitar")

    tab = [n for n in _staff(part, 2) if n["pitch"] is not None]
    assert [n["pitch"] for n in tab] == [40, 45, 52, 55, 59, 64, 64]
    assert _sounds(tab, GUITAR)
    # The frets are the fingering's own: what the Notation view draws.
    placed = {p.note.pitch: (str(p.string), str(p.fret)) for p in tabs["guitar"].placed}
    assert all((n["string"], n["fret"]) == placed[n["pitch"]] for n in tab)
    # The chord's three notes are one chord, on three strings.
    chord = tab[2:5]
    assert [n["chord"] for n in chord] == [False, True, True]
    assert len({n["string"] for n in chord}) == 3
    # The held note is tied over the bar line, on the same string and fret.
    first, second = tab[5], tab[6]
    assert (first["bar"], second["bar"]) == ("1", "2")
    assert (first["ties"], second["ties"]) == (["start"], ["stop"])
    assert (first["string"], first["fret"]) == (second["string"], second["fret"]) == ("1", "0")
    # One voice, the second staff's first by MusicXML's convention.
    assert {n["voice"] for n in _staff(part, 2)} == {"5"}


def test_the_notation_staff_is_complete_and_carries_no_string_numbers():
    notes = [_q(40, 0, 4), _q(45, 4, 4), _q(52, 8, 4), _q(55, 8, 4), _q(59, 8, 4), _q(64, 12, 8)]
    part = _part(_score({"guitar": notes}, _tab("guitar", notes)), "guitar")
    staff = [n for n in _staff(part, 1) if n["pitch"] is not None]
    assert [n["pitch"] for n in staff] == [40, 45, 52, 55, 59, 64, 64]
    # A string number on an ordinary staff is printed over the note by
    # MuseScore, on every note. They belong to the tab staff only.
    assert all(n["string"] is None and n["fret"] is None for n in staff)
    assert {n["voice"] for n in _staff(part, 1)} == {"1"}


def test_a_note_the_instrument_cannot_play_is_on_the_staff_and_a_rest_on_the_tab():
    # The low D is below a standard guitar's sixth string.
    notes = [_q(38, 0, 4), _q(45, 4, 4), _q(38, 8, 4), _q(50, 12, 4)]
    part = _part(_score({"guitar": notes}, _tab("guitar", notes)), "guitar")
    # Every note is on the staff of notation.
    assert [n["pitch"] for n in _staff(part, 1) if n["bar"] == "1"] == [38, 45, 38, 50]
    first_bar = [n for n in _staff(part, 2) if n["bar"] == "1"]
    assert [(n["pitch"], n["string"], n["fret"], n["type"]) for n in first_bar] == [
        (None, None, None, "quarter"),
        (45, "5", "0", "quarter"),
        (None, None, None, "quarter"),
        (50, "4", "0", "quarter"),
    ]
    # In drop D the same notes all have a place.
    part = _part(_score({"guitar": notes}, _tab("guitar", notes, preset="drop_d")), "guitar")
    assert [(n["string"], n["fret"]) for n in _staff(part, 2) if n["bar"] == "1"] == [
        ("6", "0"),
        ("5", "0"),
        ("6", "0"),
        ("4", "0"),
    ]


def test_a_chord_with_one_unplayable_note_keeps_the_others_on_the_tab():
    # Low D under an A and a D: the D2 has no string in standard tuning.
    notes = [_q(38, 0, 4), _q(45, 0, 4), _q(50, 0, 4)]
    part = _part(_score({"guitar": notes}, _tab("guitar", notes)), "guitar")
    tab = [n for n in _staff(part, 2) if n["bar"] == "1" and n["pitch"] is not None]
    assert [(n["pitch"], n["chord"]) for n in tab] == [(45, False), (50, True)]


def test_the_tab_staff_names_its_tuning_and_capo():
    notes = [_q(45, 0, 4), _q(52, 4, 4)]
    root = _score({"guitar": notes}, _tab("guitar", notes, preset="drop_d", capo=2))
    part = _part(root, "guitar")
    details = part.find("measure/attributes/staff-details")
    # Line 1 is the lowest string: D A D G B E.
    tunings = [
        (
            t.get("line"),
            t.findtext("tuning-step"),
            t.findtext("tuning-alter"),
            t.findtext("tuning-octave"),
        )
        for t in details.findall("staff-tuning")
    ]
    assert tunings == [
        ("1", "D", None, "2"),
        ("2", "A", None, "2"),
        ("3", "D", None, "3"),
        ("4", "G", None, "3"),
        ("5", "B", None, "3"),
        ("6", "E", None, "4"),
    ]
    assert details.findtext("capo") == "2"
    assert [e.tag for e in details] == ["staff-lines", *["staff-tuning"] * 6, "capo"]
    # Frets count from the capo.
    tab = [n for n in _staff(part, 2) if n["pitch"] is not None]
    assert tab and _sounds(tab, TAB_TUNINGS["guitar"]["drop_d"], capo=2)


def test_a_bass_tuned_down_a_half_step_and_a_five_string():
    half_down = TAB_TUNINGS["bass"]["half_step_down"]  # D# G# C# F#
    notes = [_q(27, 0, 4)]
    placed, _ = assign(notes, half_down)
    root = _score({"bass": notes}, {"bass": TabStaff(half_down, 0, "tab", placed)})
    details = _part(root, "bass").find("measure/attributes/staff-details")
    first = details.find("staff-tuning")
    assert (first.findtext("tuning-step"), first.findtext("tuning-alter")) == ("D", "1")
    assert first.findtext("tuning-octave") == "1"
    assert details.findtext("staff-lines") == "4"
    assert _part(root, "bass").find("measure/attributes/clef").findtext("sign") == "F"

    five = TAB_TUNINGS["bass"]["five_string"]
    notes = [_q(23, 0, 4)]
    placed, _ = assign(notes, five)
    root = _score({"bass": notes}, {"bass": TabStaff(five, 0, "both", placed)})
    assert _part(root, "bass").findtext("measure/attributes/staff-details/staff-lines") == "5"


def test_only_fretted_parts_get_a_tab_staff():
    guitar = [_q(52, 0, 4)]
    vocals = [_q(64, 0, 4), _q(67, 4, 4)]
    root = _score({"vocals": vocals, "guitar": guitar}, _tab("guitar", guitar))
    voice = _part(root, "vocals")
    assert voice.find("measure/attributes/staves") is None
    assert voice.find("measure/attributes/staff-details") is None
    assert all(n.find("staff") is None for n in voice.iter("note"))
    assert _staff(_part(root, "guitar"), 2)[0]["string"] == "4"


def test_without_tabs_the_score_is_what_it_was():
    notes = [_q(40, 0, 4), _q(47, 4, 4)]
    grid = _grid()
    bars = bars_of(grid, len(grid["beats"]))
    plain = musicxml_score({"guitar": notes}, bars, 4)
    assert b"<technical>" not in plain and b"staff-details" not in plain
    assert b"<staves>" not in plain
    # A tab for a stem that is not in the score changes nothing either.
    other = _tab("bass", [_q(28, 0, 4)])
    again = musicxml_score({"guitar": notes}, bars, 4, tabs=other)
    assert b"<technical>" not in again and b"<staves>" not in again
    assert again.count(b"<note>") == plain.count(b"<note>")


@pytest.mark.parametrize("per_beat", QUANTIZE_PARTS)
def test_both_staves_fill_every_bar_at_every_resolution(per_beat):
    """The notation and the tab are the same bars: each staff's notes and
    rests add up to the bar, every note is where MusicXML wants its children,
    and what the tab plays is what the fingering placed."""
    import random

    rng = random.Random(per_beat)
    total = 8 * per_beat
    starts = sorted(rng.sample(range(total), min(total, 14)))
    notes = [_q(rng.randint(40, 72), s, rng.randint(1, 2 * per_beat)) for s in starts]
    notes += [_q(n.pitch + 7, n.step, n.steps) for n in notes[::3] if n.pitch + 7 <= 80]
    tabs = _tab("guitar", notes)
    part = _part(_score({"guitar": notes}, tabs, per_beat), "guitar")
    divisions = int(part.findtext("measure/attributes/divisions"))
    for measure in part.findall("measure"):
        beats = int(measure.get("number")) <= 2 and 4 or 1  # two bars of four, then the last beat
        filled = {1: Fraction(0), 2: Fraction(0)}
        for note in measure.findall("note"):
            tags = [c.tag for c in note]
            assert [t for t in tags if t in _NOTE_ORDER] == tags, tags
            assert sorted(tags, key=_NOTE_ORDER.index) == tags, tags
            if note.find("chord") is None and note.findtext("staff") == "2":
                filled[2] += Fraction(int(note.findtext("duration")), divisions)
        # Staff 1 may be in several voices: its bar is as long as its longest.
        cursor = longest = Fraction(0)
        for element in measure:
            if element.tag == "backup":
                cursor -= Fraction(int(element.findtext("duration")), divisions)
            elif (
                element.tag == "forward" or element.tag == "note" and element.find("chord") is None
            ):
                cursor += Fraction(int(element.findtext("duration")), divisions)
            longest = max(longest, cursor)
        assert longest == beats
        assert filled[2] == beats
    tab = [n for n in _staff(part, 2) if n["pitch"] is not None]
    assert _sounds(tab, GUITAR)
    struck = {(n["pitch"], n["string"], n["fret"]) for n in tab}
    assert struck <= {(p.note.pitch, str(p.string), str(p.fret)) for p in tabs["guitar"].placed}


def test_triplets_on_the_tab_staff_are_marked_three_in_the_time_of_two():
    notes = [_q(60, 0, 1), _q(62, 1, 1), _q(64, 2, 1)]
    part = _part(_score({"guitar": notes}, _tab("guitar", notes), per_beat=3), "guitar")
    first = [n for n in part.find("measure").findall("note") if n.findtext("staff") == "2"][:3]
    assert [n.findtext("type") for n in first] == ["eighth"] * 3
    assert [
        (n.findtext("time-modification/actual-notes"), n.findtext("time-modification/normal-notes"))
        for n in first
    ] == [("3", "2")] * 3


def test_voices_are_numbered_from_one():
    """music21 counts a bar's voices from 0. MuseScore reads a part with a
    voice 0 as empty: every note of a polyphonic part silently gone. Found by
    opening a real song's score in MuseScore 4."""
    held_under_a_line = [_q(48, 0, 12), _q(64, 0, 3), _q(67, 4, 3), _q(71, 8, 3)]
    grid = _grid()
    bars = bars_of(grid, len(grid["beats"]))
    # With no tablature in the score at all: a piano part.
    plain = ET.fromstring(musicxml_score({"piano": held_under_a_line}, bars, 4))
    assert sorted({v.text for v in plain.iter("voice")}) == ["1", "2"]
    # Beside a tab part, whose tab staff is voice 5.
    notes = [_q(40, 0, 12), _q(64, 0, 3), _q(67, 4, 3)]
    both = _score({"guitar": notes, "piano": held_under_a_line}, _tab("guitar", notes))
    assert sorted({v.text for v in _part(both, "piano").iter("voice")}) == ["1", "2"]
    assert sorted({v.text for v in _part(both, "guitar").iter("voice")}) == ["1", "2", "5"]
    # A part with one voice and no tab is left exactly as music21 wrote it.
    line = [_q(60, 0, 4), _q(62, 4, 4)]
    assert b"<voice>" not in musicxml_score({"vocals": line}, bars, 4)


def test_a_notation_program_reads_it_back():
    from music21 import articulations, converter

    notes = [_q(40, 0, 4), _q(52, 4, 4), _q(55, 4, 4), _q(59, 4, 4), _q(64, 12, 8)]
    grid = _grid()
    data = musicxml_score(
        {"guitar": notes},
        bars_of(grid, len(grid["beats"])),
        4,
        tabs=_tab("guitar", notes),
    )
    score = converter.parseData(data, format="musicxml")
    # music21 reads a two-staff part as two staves: notation, then tab.
    assert len(score.parts) == 2
    notation, tab = score.parts
    assert sorted({p.midi for n in notation.recurse().notes for p in n.pitches}) == [
        40, 52, 55, 59, 64,
    ]  # fmt: skip
    frets = [
        a.number
        for n in tab.recurse().notes
        for a in n.articulations
        if isinstance(a, articulations.FretIndication)
    ]
    assert frets  # it found frets on the tab staff


# --- The endpoint ---------------------------------------------------------------

JOB = "a1b2c3d4e5f6"


@pytest.fixture(autouse=True)
def _isolate():
    _jobs.clear()
    _procs.clear()
    yield
    _jobs.clear()
    _procs.clear()


def test_the_download_carries_the_songs_tuning_and_frets():
    from app.core import config
    from app.main import app

    client = TestClient(app)
    job = Job(id=JOB, status="done", title="Blue in Green", source_url="local:x")
    stems_dir = config.JOBS_DIR / JOB / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    grid = {
        "detector": "beat_this",
        "confidence": 91,
        "bpm": 120.0,
        "beats": [round(0.5 * i, 6) for i in range(17)],
        "bars": [{"beat": 0, "beats_per_bar": 4}],
    }
    (stems_dir / "beats.json").write_text(json.dumps(grid), encoding="utf-8")
    _jobs[job.id] = job
    riff = [38, 45, 50, 38]
    write_notes(
        stems_dir,
        "guitar",
        transcriber="mt3",
        model="m",
        duration=8.0,
        notes=[
            {"start": i * 0.5, "end": i * 0.5 + 0.45, "pitch": p, "velocity": 90}
            for i, p in enumerate(riff)
        ],
    )
    url = f"/api/jobs/{JOB}/transcription.musicxml"

    def first_bar(root, staff):
        return [n for n in _staff(_part(root, "guitar"), staff) if n["bar"] == "1"]

    # Standard tuning: the low Ds are on the staff, and rests on the tab.
    root = ET.fromstring(client.get(url).content)
    assert [n["pitch"] for n in first_bar(root, 1)] == riff
    assert [n["string"] for n in first_bar(root, 2)] == [None, "5", "4", None]

    # Drop D is the song's choice: the next download has it.
    client.patch(f"/api/jobs/{JOB}/transcription/tab", json={"guitar": {"preset": "drop_d"}})
    root = ET.fromstring(client.get(url).content)
    assert [(n["string"], n["fret"]) for n in first_bar(root, 2)] == [
        ("6", "0"),
        ("5", "0"),
        ("4", "0"),
        ("6", "0"),
    ]
    lowest = _part(root, "guitar").find("measure/attributes/staff-details/staff-tuning")
    assert (lowest.findtext("tuning-step"), lowest.findtext("tuning-octave")) == ("D", "2")
    # The same frets the Notation view draws.
    score = client.get(f"/api/jobs/{JOB}/transcription.alphatex").text
    assert "0.6.4 0.5.4 0.4.4 0.6.4 |" in score
