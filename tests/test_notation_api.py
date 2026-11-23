"""The Notation view's endpoints (app/api/transcription.py): the song's tab
choices and the alphaTex score (openspec change add-alphatab-notation,
tasks 3.1 and 3.4).
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.core.models import Job
from app.core.registry import _jobs, _procs
from app.core.registry import persist as persist_registry
from app.core.registry import restore as restore_registry
from app.core.tab_files import read_tab, tab_path
from app.core.transcription_files import transcribed_stems, write_notes

JOB = "a1b2c3d4e5f6"
TAB = f"/api/jobs/{JOB}/transcription/tab"
SCORE = f"/api/jobs/{JOB}/transcription.alphatex"

GUITAR_STANDARD = [40, 45, 50, 55, 59, 64]
BASS_STANDARD = [28, 33, 38, 43]


@pytest.fixture(autouse=True)
def _isolate():
    _jobs.clear()
    _procs.clear()
    yield
    _jobs.clear()
    _procs.clear()


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


@pytest.fixture
def jobs_dir():
    from app.core import config

    return config.JOBS_DIR


def _song(jobs_dir, stems=("vocals", "guitar", "bass", "drums"), grid=True, **fields) -> Job:
    job = Job(id=JOB, status="done", title="Blue in Green", source_url="local:x", **fields)
    stems_dir = jobs_dir / JOB / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    for name in ("original", *stems):
        (stems_dir / f"{name}.wav").write_bytes(b"RIFF")
        job.stems.append({"name": name, "url": f"/api/jobs/{JOB}/stems/{name}.wav"})
    if grid:
        beats = {
            "version": 1,
            "detector": "beat_this",
            "confidence": 91,
            "bpm": 120.0,
            "beats": [round(0.5 * i, 6) for i in range(17)],
            "bars": [{"beat": 0, "beats_per_bar": 4}],
        }
        (stems_dir / "beats.json").write_text(json.dumps(beats), encoding="utf-8")
    _jobs[job.id] = job
    return job


def _note(start, end, pitch=60, velocity=90):
    return {"start": start, "end": end, "pitch": pitch, "velocity": velocity}


def _store(jobs_dir, stem, notes, transcriber="mt3"):
    write_notes(
        jobs_dir / JOB / "stems",
        stem,
        transcriber=transcriber,
        model="m",
        duration=8.0,
        notes=notes,
    )


def _line(pitches, every=0.5):
    return [_note(i * every, i * every + every * 0.9, p) for i, p in enumerate(pitches)]


# --- Tab choices (task 3.1) -----------------------------------------------------


def test_a_song_starts_with_standard_tuning_no_capo_and_both(client, jobs_dir):
    _song(jobs_dir)
    r = client.get(TAB)
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["stems"] == {
        "guitar": {"preset": "standard", "tuning": GUITAR_STANDARD, "capo": 0, "display": "both"},
        "bass": {"preset": "standard", "tuning": BASS_STANDARD, "capo": 0, "display": "both"},
    }
    # The tunings on offer ride along, with at least the ones the spec names.
    assert {"standard", "drop_d", "half_step_down"} <= set(body["presets"]["guitar"])
    assert {"standard", "drop_d", "five_string"} <= set(body["presets"]["bass"])
    assert body["presets"]["guitar"]["standard"] == GUITAR_STANDARD
    assert body["displays"] == ["score", "tab", "both"]
    # Reading the defaults writes nothing.
    assert not tab_path(jobs_dir / JOB / "stems").exists()


def test_a_preset_is_saved_and_only_what_was_sent_changes(client, jobs_dir):
    _song(jobs_dir)
    r = client.patch(TAB, json={"guitar": {"preset": "drop_d"}})
    assert r.status_code == 200
    stems = r.json()["stems"]
    assert stems["guitar"] == {
        "preset": "drop_d",
        "tuning": [38, 45, 50, 55, 59, 64],
        "capo": 0,
        "display": "both",
    }
    assert stems["bass"]["preset"] == "standard"

    r = client.patch(TAB, json={"guitar": {"capo": 2}, "bass": {"display": "tab"}})
    stems = r.json()["stems"]
    assert stems["guitar"]["preset"] == "drop_d"  # kept
    assert stems["guitar"]["capo"] == 2
    assert stems["bass"]["display"] == "tab"
    assert client.get(TAB).json()["stems"] == stems


def test_a_custom_tuning(client, jobs_dir):
    _song(jobs_dir)
    open_c = [36, 43, 48, 55, 60, 64]
    r = client.patch(TAB, json={"guitar": {"tuning": open_c}})
    assert r.status_code == 200
    assert r.json()["stems"]["guitar"]["preset"] == "custom"
    assert r.json()["stems"]["guitar"]["tuning"] == open_c
    # Typing in the strings of a preset is that preset.
    r = client.patch(TAB, json={"bass": {"tuning": [23, 28, 33, 38, 43]}})
    assert r.json()["stems"]["bass"]["preset"] == "five_string"


@pytest.mark.parametrize(
    "change",
    [
        {"guitar": {"tuning": [40, 45, 50]}},  # too few strings
        {"guitar": {"tuning": [40] * 9}},  # too many
        {"guitar": {"tuning": [40, 45, 50, 55, 59, 640]}},  # not a pitch
        {"guitar": {"tuning": [40, 45, 50, 55, 59, 64.5]}},  # not whole
        {"guitar": {"tuning": "EADGBE"}},
        {"guitar": {"preset": "open_z"}},
        {"guitar": {"preset": "custom"}},  # custom needs its strings
        {"guitar": {"preset": "drop_d", "tuning": GUITAR_STANDARD}},  # they disagree
        {"guitar": {"capo": 13}},
        {"guitar": {"capo": -1}},
        {"guitar": {"capo": "2"}},
        {"guitar": {"display": "sideways"}},
        {"guitar": {"frets": 24}},  # no such choice
        {"piano": {"preset": "standard"}},  # no tablature for piano
        {},
    ],
)
def test_a_choice_that_makes_no_sense_is_refused_and_nothing_is_saved(client, jobs_dir, change):
    _song(jobs_dir)
    client.patch(TAB, json={"guitar": {"preset": "drop_d"}})
    r = client.patch(TAB, json={**change, "bass": {"display": "tab"}} if change else change)
    assert r.status_code == 422
    # Not even the valid half of the request was saved.
    stems = client.get(TAB).json()["stems"]
    assert stems["guitar"]["preset"] == "drop_d"
    assert stems["bass"]["display"] == "both"


def test_choices_survive_a_registry_reload(client, jobs_dir):
    _song(jobs_dir)
    client.patch(TAB, json={"guitar": {"preset": "drop_d", "capo": 3, "display": "tab"}})
    persist_registry(jobs_dir)
    _jobs.clear()
    restore_registry(jobs_dir)
    assert JOB in _jobs
    assert client.get(TAB).json()["stems"]["guitar"] == {
        "preset": "drop_d",
        "tuning": [38, 45, 50, 55, 59, 64],
        "capo": 3,
        "display": "tab",
    }


def test_the_file_is_written_whole_beside_the_notes(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "guitar", _line([52, 55, 59]))
    client.patch(TAB, json={"bass": {"preset": "five_string"}})
    stems_dir = jobs_dir / JOB / "stems"
    path = tab_path(stems_dir)
    assert path == stems_dir / "transcription" / "tab.json"
    assert json.loads(path.read_text(encoding="utf-8"))["bass"]["preset"] == "five_string"
    assert [p.name for p in path.parent.iterdir() if p.name.startswith(".")] == []
    # The settings file is not mistaken for a transcribed stem.
    assert transcribed_stems(stems_dir) == ["guitar"]


def test_a_damaged_file_reads_as_the_defaults(client, jobs_dir):
    _song(jobs_dir)
    stems_dir = jobs_dir / JOB / "stems"
    path = tab_path(stems_dir)
    path.parent.mkdir(parents=True)
    path.write_text("{not json", encoding="utf-8")
    assert read_tab(stems_dir)["guitar"]["preset"] == "standard"
    # One bad stem does not take the other with it.
    path.write_text(
        json.dumps({"guitar": {"tuning": [1, 2]}, "bass": {"preset": "drop_d", "capo": 1}}),
        encoding="utf-8",
    )
    choices = client.get(TAB).json()["stems"]
    assert choices["guitar"]["preset"] == "standard"
    assert choices["bass"] == {
        "preset": "drop_d",
        "tuning": [26, 33, 38, 43],
        "capo": 1,
        "display": "both",
    }


def test_tab_choices_need_a_finished_song(client, jobs_dir):
    assert client.get(TAB).status_code == 404
    assert client.patch(TAB, json={"guitar": {"capo": 1}}).status_code == 404
    assert client.get("/api/jobs/not-an-id/transcription/tab").status_code == 404


# --- The score (task 3.4) -------------------------------------------------------


def _transcribed(jobs_dir):
    _song(jobs_dir, key="D maj", scale="Major")
    _store(jobs_dir, "vocals", _line([62, 64, 66, 67]), transcriber="crepe")
    _store(jobs_dir, "guitar", _line([52, 55, 59, 64]))
    _store(jobs_dir, "bass", _line([28, 31, 33, 36]), transcriber="crepe")
    _store(jobs_dir, "drums", [_note(i * 0.5, i * 0.5 + 0.1, 36) for i in range(8)])


def test_the_score_is_alphatex_text(client, jobs_dir):
    _transcribed(jobs_dir)
    r = client.get(SCORE)
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/plain; charset=utf-8"
    assert r.headers["cache-control"] == "no-store"
    lines = r.text.splitlines()
    assert lines[0] == '\\title ("Blue in Green")'
    assert "\\tempo (120)" in lines
    # Top to bottom as a score is read: voice, guitar, bass, drums.
    tracks = [line for line in lines if line.startswith("\\track")]
    assert tracks == [
        '\\track ("vocals" "vocals")',
        '\\track ("guitar" "guitar")',
        '\\track ("bass" "bass")',
        '\\track ("drums" "drums")',
    ]
    assert "\\clef (G2) \\ks (dmajor) \\ts (4 4) D4.4 E4.4 F#4.4 G4.4 |" in lines
    assert (
        "\\staff {score tabs} \\tuning (G2 D2 A1 E1) \\instrument (33) \\displayTranspose (12)"
        in lines
    )
    assert "\\clef (F4) \\ks (dmajor) 0.4.4 3.4.4 0.3.4 3.3.4 |" in lines
    # One sync point per bar (sixteen beats are four bars, the last beat a
    # fifth), and one at the end.
    assert [line for line in lines if line.startswith("\\sync")] == [
        "\\sync (0 0 0)",
        "\\sync (1 0 2000)",
        "\\sync (2 0 4000)",
        "\\sync (3 0 6000)",
        "\\sync (4 0 8000)",
        "\\sync (4 0 8500 1)",
    ]


def test_the_stems_parameter_chooses_the_tracks(client, jobs_dir):
    _transcribed(jobs_dir)
    text = client.get(SCORE, params={"stems": "bass,vocals"}).text
    tracks = [line for line in text.splitlines() if line.startswith("\\track")]
    assert tracks == ['\\track ("bass" "bass")', '\\track ("vocals" "vocals")']
    assert client.get(SCORE, params={"stems": "piano"}).status_code == 404


def test_the_parts_parameter_sets_the_resolution(client, jobs_dir):
    _song(jobs_dir)
    # Three notes inside one beat: a triplet.
    _store(jobs_dir, "vocals", [_note(i / 6, i / 6 + 0.15, 60 + i) for i in range(3)], "crepe")
    triplets = client.get(SCORE, params={"parts": 3}).text
    assert "C4.8{tu 3} C#4.8{tu 3} D4.8{tu 3}" in triplets
    assert "{tu 3}" not in client.get(SCORE, params={"parts": 4}).text
    assert client.get(SCORE, params={"parts": 5}).status_code == 422


def test_json_says_what_the_score_shows(client, jobs_dir):
    _transcribed(jobs_dir)
    _store(jobs_dir, "piano", [])  # transcribed, and silent
    body = client.get(SCORE, params={"format": "json", "stems": "guitar,bass"}).json()
    assert body["job_id"] == JOB
    assert body["parts"] == 4
    assert body["stems"] == ["guitar", "bass"]
    assert body["available"] == ["vocals", "guitar", "bass", "drums"]  # not the silent piano
    assert body["polyphonic"] == ["guitar"]
    assert body["bars"] == 5
    assert body["grid"] == {
        "confidence": 91,
        "detector": "beat_this",
        "bpm": 120.0,
        "edited": False,
    }
    assert body["alphatex"] == client.get(SCORE, params={"stems": "guitar,bass"}).text
    assert body["file_names"] == {
        "midi_played": "Blue_in_Green_notes.mid",
        "midi_quantised": "Blue_in_Green_notes_quantised.mid",
        "musicxml": "Blue_in_Green.musicxml",
        "guitar_pro": "Blue_in_Green.gp",
    }
    # The same names the download endpoints give their files.
    for url, key in (
        (f"/api/jobs/{JOB}/transcription.mid", "midi_played"),
        (f"/api/jobs/{JOB}/transcription.mid?quantize=1", "midi_quantised"),
        (f"/api/jobs/{JOB}/transcription.musicxml", "musicxml"),
    ):
        disposition = client.get(url).headers["content-disposition"]
        assert disposition == f'attachment; filename="{body["file_names"][key]}"'
    assert body["tab"] == {
        "guitar": {
            "preset": "standard",
            "tuning": GUITAR_STANDARD,
            "capo": 0,
            "display": "both",
            "notes": 4,
            "unplaced": 0,
            "reasons": {},
            "suggestion": None,
        },
        "bass": {
            "preset": "standard",
            "tuning": BASS_STANDARD,
            "capo": 0,
            "display": "both",
            "notes": 4,
            "unplaced": 0,
            "reasons": {},
            "suggestion": None,
        },
    }
    assert client.get(SCORE, params={"format": "xml"}).status_code == 422


def test_notes_the_instrument_cannot_play_are_counted_with_the_reason(client, jobs_dir):
    _song(jobs_dir)
    # Low Ds under a D5 riff, on a guitar in standard tuning.
    _store(jobs_dir, "guitar", _line([38, 38, 45, 50, 38, 41, 43, 38]))
    body = client.get(SCORE, params={"format": "json"}).json()
    tab = body["tab"]["guitar"]
    assert tab["notes"] == 8
    assert tab["unplaced"] == 4
    assert tab["reasons"] == {"out_of_range": 4}
    assert tab["suggestion"] == "drop_d"
    # The staff keeps every note; the tab staff beside it has rests for the Ds.
    lines = body["alphatex"].splitlines()
    assert "\\clef (G2) \\ts (4 4) D2.4 D2.4 A2.4 D3.4 |" in lines
    assert "r.2 0.5.4 0.4.4 |" in lines


def test_unplaced_omit_is_one_staff_per_stem_for_a_tab_editor(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "guitar", _line([38, 38, 45, 50, 38, 41, 43, 38]))
    shown = client.get(SCORE).text
    assert shown.count("\\staff") == 2  # the staff with every note, and the tab
    for params in ({"unplaced": "omit"}, {"unplaced": "omit", "format": "json"}):
        r = client.get(SCORE, params=params)
        text = r.json()["alphatex"] if "format" in params else r.text
        staves = [line for line in text.splitlines() if line.startswith("\\staff")]
        assert staves == [
            "\\staff {score tabs} \\tuning (E4 B3 G3 D3 A2 E2) \\instrument (27)"
            " \\displayTranspose (12)"
        ]
        assert "\\clef (G2) \\ts (4 4) r.2 0.5.4 0.4.4 |" in text.splitlines()
    # What was left out is still counted.
    facts = client.get(SCORE, params={"unplaced": "omit", "format": "json"}).json()["tab"]
    assert facts["guitar"]["unplaced"] == 4
    assert client.get(SCORE, params={"unplaced": "hide"}).status_code == 422


def test_a_new_tuning_changes_the_score_with_no_transcription_run(client, jobs_dir, monkeypatch):
    import app.api.transcription as api

    def never(*args, **kwargs):  # pragma: no cover - the assertion is that it is not called
        raise AssertionError("a transcription model ran")

    monkeypatch.setattr(api, "transcribe_stems", never)
    _song(jobs_dir)
    _store(jobs_dir, "guitar", _line([38, 38, 45, 50, 38, 41, 43, 38]))
    assert client.patch(TAB, json={"guitar": {"preset": "drop_d"}}).status_code == 200
    body = client.get(SCORE, params={"format": "json"}).json()
    assert body["tab"]["guitar"]["unplaced"] == 0
    assert body["tab"]["guitar"]["suggestion"] is None
    lines = body["alphatex"].splitlines()
    assert (
        "\\staff {score tabs} \\tuning (E4 B3 G3 D3 A2 D2) \\instrument (27) \\displayTranspose (12)"
        in lines
    )
    assert "\\clef (G2) \\ts (4 4) 0.6.4 0.6.4 0.5.4 0.4.4 |" in lines

    # A capo: frets count from it, and it is named in the score.
    client.patch(TAB, json={"guitar": {"preset": "standard", "capo": 2}})
    body = client.get(SCORE, params={"format": "json"}).json()
    assert "\\capo (2)" in body["alphatex"]
    assert body["tab"]["guitar"]["capo"] == 2

    # Tab only: no staff notation for the guitar.
    client.patch(TAB, json={"guitar": {"preset": "drop_d", "capo": 0, "display": "tab"}})
    text = client.get(SCORE).text
    assert "\\staff {tabs} \\tuning (E4 B3 G3 D3 A2 D2)" in text
    assert "\\staff {score" not in text


def test_seven_notes_at_once_are_six_placed_and_one_reported(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "guitar", [_note(0.0, 1.0, p) for p in (40, 47, 52, 56, 59, 64, 68)])
    tab = client.get(SCORE, params={"format": "json"}).json()["tab"]["guitar"]
    assert (tab["notes"], tab["unplaced"], tab["reasons"]) == (7, 1, {"too_many_notes": 1})
    assert tab["suggestion"] is None  # no tuning fixes too many notes


def test_no_beat_grid_is_refused_with_the_reason(client, jobs_dir):
    _song(jobs_dir, grid=False)
    _store(jobs_dir, "vocals", _line([60, 62]), "crepe")
    for params in ({}, {"format": "json"}):
        r = client.get(SCORE, params=params)
        assert r.status_code == 409
        assert r.json()["transcription_reason"] == "no_beat_grid"
        assert "beat grid" in r.json()["detail"]


def test_nothing_transcribed_is_refused(client, jobs_dir):
    _song(jobs_dir)
    r = client.get(SCORE)
    assert r.status_code == 404
    assert r.json()["detail"] == "nothing transcribed"
    # Transcribed, but every stem silent: still nothing to draw.
    _store(jobs_dir, "vocals", [])
    assert client.get(SCORE, params={"format": "json"}).status_code == 404
    assert client.get("/api/jobs/000000000000/transcription.alphatex").status_code == 404


def test_the_score_follows_an_edited_grid(client, jobs_dir):
    _transcribed(jobs_dir)
    before = client.get(SCORE).text
    edits = {
        "beats": [round(0.25 + 0.5 * i, 6) for i in range(17)],
        "bars": [{"beat": 0, "beats_per_bar": 3}],
    }
    (jobs_dir / JOB / "stems" / "beats.user.json").write_text(json.dumps(edits), encoding="utf-8")
    after = client.get(SCORE, params={"format": "json"}).json()
    assert after["grid"]["edited"] is True
    assert after["alphatex"] != before
    assert "\\ts (3 4)" in after["alphatex"]
    assert "\\sync (0 0 250)" in after["alphatex"]
