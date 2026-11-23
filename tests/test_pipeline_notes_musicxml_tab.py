"""Tablature in the MusicXML score (app/pipeline/notes_musicxml.py): the
string and fret of each placed note of a guitar or bass part, and the part's
tuning and capo (openspec change add-alphatab-notation, task 6.1).

Scenarios of "The MusicXML score carries tablature for fretted stems" in the
notation-export spec. The output is read back two ways: as XML, for what was
written, and by music21, for whether a notation program would accept it.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET

import pytest
from fastapi.testclient import TestClient

from app.core.config import TAB_TUNINGS
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


def _written(part: ET.Element) -> list[dict]:
    """Every pitched note written in the part, in order."""
    out = []
    for note in part.iter("note"):
        pitch = note.find("pitch")
        if pitch is None:
            continue
        number = (
            12 * (int(pitch.findtext("octave")) + 1)
            + _STEPS[pitch.findtext("step")]
            + round(float(pitch.findtext("alter") or 0))
        )
        technical = note.find("notations/technical")
        out.append(
            {
                "pitch": number,
                "string": None if technical is None else technical.findtext("string"),
                "fret": None if technical is None else technical.findtext("fret"),
                "ties": sorted(t.get("type") for t in note.findall("tie")),
                "chord": note.find("chord") is not None,
            }
        )
    return out


def _sounds(written: list[dict], tuning, capo: int = 0) -> bool:
    """Open string + capo + fret is the note's pitch, wherever one is given."""
    return all(
        tuning[len(tuning) - int(n["string"])] + capo + int(n["fret"]) == n["pitch"]
        for n in written
        if n["string"] is not None
    )


def test_every_placed_note_has_its_string_and_fret():
    # A line, a chord (which music21 alone would leave bare), and a note
    # held across the bar line (written as two tied notes).
    notes = [_q(40, 0, 4), _q(45, 4, 4), _q(52, 8, 4), _q(55, 8, 4), _q(59, 8, 4), _q(64, 12, 8)]
    tabs = _tab("guitar", notes)
    written = _written(_part(_score({"guitar": notes}, tabs), "guitar"))

    assert [n["pitch"] for n in written] == [40, 45, 52, 55, 59, 64, 64]
    assert all(n["string"] is not None and n["fret"] is not None for n in written)
    assert _sounds(written, GUITAR)
    # The frets are the fingering's own: what the Notation view draws.
    placed = {p.note.pitch: (str(p.string), str(p.fret)) for p in tabs["guitar"].placed}
    assert all((n["string"], n["fret"]) == placed[n["pitch"]] for n in written)
    # The chord's three notes are on three strings.
    chord = written[2:5]
    assert [n["chord"] for n in chord] == [False, True, True]
    assert len({n["string"] for n in chord}) == 3
    # Both pieces of the tied note carry the same place.
    first, second = written[5], written[6]
    assert (first["ties"], second["ties"]) == (["start"], ["stop"])
    assert (first["string"], first["fret"]) == (second["string"], second["fret"]) == ("1", "0")


def test_a_note_the_instrument_cannot_play_stays_on_the_staff_without_them():
    # The low D is below a standard guitar's sixth string.
    notes = [_q(38, 0, 4), _q(45, 4, 4), _q(38, 8, 4), _q(50, 12, 4)]
    written = _written(_part(_score({"guitar": notes}, _tab("guitar", notes)), "guitar"))
    assert [n["pitch"] for n in written] == [38, 45, 38, 50]  # every note is there
    assert [(n["string"], n["fret"]) for n in written] == [
        (None, None),
        ("5", "0"),
        (None, None),
        ("4", "0"),
    ]
    # In drop D the same notes all have a place.
    written = _written(
        _part(_score({"guitar": notes}, _tab("guitar", notes, preset="drop_d")), "guitar")
    )
    assert [(n["string"], n["fret"]) for n in written] == [
        ("6", "0"),
        ("5", "0"),
        ("6", "0"),
        ("4", "0"),
    ]


def test_the_part_names_its_tuning_and_capo():
    notes = [_q(45, 0, 4), _q(52, 4, 4)]
    root = _score({"guitar": notes}, _tab("guitar", notes, preset="drop_d", capo=2))
    part = _part(root, "guitar")
    details = part.find("measure/attributes/staff-details")
    assert details is not None
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
    # Still a five-line staff of notation: nothing turns it into a tab staff.
    assert details.find("staff-lines") is None
    assert part.find("measure/attributes/clef/sign").text == "G"
    # Written once, in the first bar, after the clef as MusicXML orders them.
    assert len(list(part.iter("staff-details"))) == 1
    order = [e.tag for e in part.find("measure/attributes")]
    assert order.index("staff-details") == order.index("clef") + 1
    # Frets count from the capo.
    written = _written(part)
    assert _sounds(written, TAB_TUNINGS["guitar"]["drop_d"], capo=2)


def test_a_tuning_with_a_sharp_string():
    half_down = TAB_TUNINGS["bass"]["half_step_down"]  # D# G# C# F#
    notes = [_q(27, 0, 4)]
    placed, _ = assign(notes, half_down)
    root = _score({"bass": notes}, {"bass": TabStaff(half_down, 0, "tab", placed)})
    first = _part(root, "bass").find("measure/attributes/staff-details/staff-tuning")
    assert (first.findtext("tuning-step"), first.findtext("tuning-alter")) == ("D", "1")
    assert first.findtext("tuning-octave") == "1"


def test_only_fretted_parts_are_touched():
    guitar = [_q(52, 0, 4)]
    vocals = [_q(64, 0, 4), _q(67, 4, 4)]
    root = _score({"vocals": vocals, "guitar": guitar}, _tab("guitar", guitar))
    assert _part(root, "vocals").find("measure/attributes/staff-details") is None
    assert all(n["string"] is None for n in _written(_part(root, "vocals")))
    assert _written(_part(root, "guitar"))[0]["string"] == "4"


def test_without_tabs_the_score_is_what_it_was():
    notes = [_q(40, 0, 4), _q(47, 4, 4)]
    grid = _grid()
    bars = bars_of(grid, len(grid["beats"]))
    plain = musicxml_score({"guitar": notes}, bars, 4)
    assert b"<technical>" not in plain and b"staff-details" not in plain
    # A tab for a stem that is not in the score changes nothing either.
    other = _tab("bass", [_q(28, 0, 4)])
    again = musicxml_score({"guitar": notes}, bars, 4, tabs=other)
    assert b"<technical>" not in again and b"staff-details" not in again


def test_two_voices_and_a_triplet_grid_keep_their_places():
    # A held bass note under a moving line: music21 writes two voices with a
    # <backup> between them, so a note's start has to be worked out, not counted.
    notes = [_q(40, 0, 12), _q(64, 0, 3), _q(67, 3, 3), _q(71, 6, 3), _q(72, 9, 3)]
    tabs = _tab("guitar", notes)
    root = _score({"guitar": notes}, tabs, per_beat=3)
    part = _part(root, "guitar")
    assert part.find("measure/backup") is not None
    written = _written(part)
    assert sorted({n["pitch"] for n in written}) == [40, 64, 67, 71, 72]
    assert all(n["string"] is not None for n in written)
    assert _sounds(written, GUITAR)


def test_voices_are_numbered_from_one():
    """music21 counts a bar's voices from 0. MuseScore reads a part with a
    voice 0 as empty: every note of a polyphonic part silently gone. Found by
    opening a real song's score in MuseScore 4."""
    held_under_a_line = [_q(48, 0, 12), _q(64, 0, 3), _q(67, 4, 3), _q(71, 8, 3)]
    grid = _grid()
    bars = bars_of(grid, len(grid["beats"]))
    # With no tablature in the score at all: a piano part.
    plain = ET.fromstring(musicxml_score({"piano": held_under_a_line}, bars, 4))
    voices = sorted({v.text for v in plain.iter("voice")})
    assert voices == ["1", "2"]
    # And beside a tab part.
    notes = [_q(40, 0, 12), _q(64, 0, 3), _q(67, 4, 3)]
    both = _score({"guitar": notes, "piano": held_under_a_line}, _tab("guitar", notes))
    for name in ("guitar", "piano"):
        assert sorted({v.text for v in _part(both, name).iter("voice")}) == ["1", "2"]
    # A part with one voice is left exactly as music21 wrote it.
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
    part = score.parts[0]
    pitches = [p.midi for n in part.recurse().notes for p in n.pitches]
    assert sorted(set(pitches)) == [40, 52, 55, 59, 64]  # every note still on the staff
    frets = [
        a.number
        for n in part.recurse().notes
        for a in n.articulations
        if isinstance(a, articulations.FretIndication)
    ]
    assert frets  # music21 found frets in what was written


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

    # Standard tuning: the low Ds are on the staff, with no string and fret.
    written = _written(_part(ET.fromstring(client.get(url).content), "guitar"))
    assert [n["pitch"] for n in written] == riff
    assert [n["string"] for n in written] == [None, "5", "4", None]

    # Drop D with a capo is the song's choice: the next download has it.
    client.patch(f"/api/jobs/{JOB}/transcription/tab", json={"guitar": {"preset": "drop_d"}})
    root = ET.fromstring(client.get(url).content)
    written = _written(_part(root, "guitar"))
    assert [(n["string"], n["fret"]) for n in written] == [
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
