"""The transcription endpoints (app/api/transcription.py), with the worker
stubbed: starting a run and its refusals, the notes as JSON, and the MIDI and
MusicXML downloads.
"""

from __future__ import annotations

import io
import json
import sys

import mido
import pytest
from fastapi.testclient import TestClient

import app.api.transcription as api
from app.core.models import Job
from app.core.registry import _jobs, _procs
from app.core.transcription_files import read_notes, transcribed_stems, write_notes
from app.pipeline.notes import TranscriptionError

JOB = "a1b2c3d4e5f6"


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


def _song(jobs_dir, stems=("vocals", "bass", "piano", "drums"), grid=True, **fields) -> Job:
    job = Job(id=JOB, status="done", title="Blue in Green", source_url="local:x", **fields)
    stems_dir = jobs_dir / JOB / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    for name in ("original", *stems):
        (stems_dir / f"{name}.wav").write_bytes(b"RIFF")
        job.stems.append({"name": name, "url": f"/api/jobs/{JOB}/stems/{name}.wav"})
    if grid:
        _write_grid(jobs_dir)
    _jobs[job.id] = job
    return job


def _write_grid(jobs_dir, start=0.0, bars=None, name="beats.json"):
    grid = {
        "version": 1,
        "detector": "beat_this",
        "confidence": 91,
        "bpm": 120.0,
        "beats": [round(start + 0.5 * i, 6) for i in range(33)],
        "bars": [{"beat": 0, "beats_per_bar": 4}] if bars is None else bars,
    }
    (jobs_dir / JOB / "stems" / name).write_text(json.dumps(grid), encoding="utf-8")


def _note(start, end, pitch=60, velocity=90):
    return {"start": start, "end": end, "pitch": pitch, "velocity": velocity}


def _store(jobs_dir, stem, notes, transcriber="crepe", skipped=None):
    write_notes(
        jobs_dir / JOB / "stems",
        stem,
        transcriber=transcriber,
        model="m",
        duration=16.0,
        notes=notes,
        skipped=skipped,
    )


def _fake_run(outcome_for=None, raises=None):
    """A stand-in for transcribe_stems that writes notes like the worker."""
    calls: list[list[str]] = []

    def run(job, stems_dir, names):
        calls.append(list(names))
        outcomes = {}
        for name in names:
            custom = (outcome_for or {}).get(name)
            if custom is not None:
                outcomes[name] = custom
                continue
            write_notes(
                stems_dir, name, transcriber="crepe", model="m", duration=4, notes=[_note(0, 1)]
            )
            outcomes[name] = {"status": "done", "notes": 1, "code": None, "transcriber": "crepe"}
        if raises is not None:
            raise raises(outcomes)
        return outcomes

    run.calls = calls
    return run


# -- starting a run ---------------------------------------------------------


def test_transcribes_the_chosen_stems_and_no_others(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)
    run = _fake_run()
    monkeypatch.setattr(api, "transcribe_stems", run)
    r = client.post(f"/api/jobs/{JOB}/transcription", json={"stems": ["bass", "piano"]})
    assert r.status_code == 200, r.text
    assert run.calls == [["bass", "piano"]]
    body = r.json()
    assert body["transcription"] == "done"
    assert sorted(body["transcription_stems"]) == ["bass", "piano"]
    assert job.status == "done" and job.stage_message == "Done"
    assert transcribed_stems(jobs_dir / JOB / "stems") == ["bass", "piano"]


def test_no_list_transcribes_every_stem_the_song_has(client, jobs_dir, monkeypatch):
    _song(jobs_dir)
    run = _fake_run()
    monkeypatch.setattr(api, "transcribe_stems", run)
    assert client.post(f"/api/jobs/{JOB}/transcription").status_code == 200
    # Never "original": it is the mix, not a stem.
    assert run.calls == [["vocals", "bass", "piano", "drums"]]


def test_the_song_reports_running_while_it_runs(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)
    seen = {}

    def run(j, stems_dir, names):
        seen["state"] = j.transcription
        seen["busy"] = j.post_hoc_running()
        seen["stage"] = j.stage_message
        return {}

    monkeypatch.setattr(api, "transcribe_stems", run)
    client.post(f"/api/jobs/{JOB}/transcription", json={"stems": ["bass"]})
    assert seen == {"state": "running", "busy": True, "stage": "Transcribing stems..."}
    assert job.transcription == "done"


def test_a_song_that_is_not_finished_is_refused(client, jobs_dir, monkeypatch):
    monkeypatch.setattr(api, "transcribe_stems", lambda *a: pytest.fail("started"))
    assert client.post("/api/jobs/000000000000/transcription").status_code == 404
    assert client.post("/api/jobs/not-an-id/transcription").status_code == 404
    for status in ("separating", "error", "queued"):
        _jobs[JOB] = Job(id=JOB, status=status)
        assert client.post(f"/api/jobs/{JOB}/transcription").status_code == 404


def test_an_unknown_stem_is_refused_by_name(client, jobs_dir, monkeypatch):
    _song(jobs_dir, stems=("vocals", "bass"))
    monkeypatch.setattr(api, "transcribe_stems", lambda *a: pytest.fail("started"))
    r = client.post(f"/api/jobs/{JOB}/transcription", json={"stems": ["bass", "piano", "kazoo"]})
    assert r.status_code == 422
    assert "piano" in r.json()["detail"] and "kazoo" in r.json()["detail"]
    # "original" exists as a file but is not a stem that can be transcribed.
    r = client.post(f"/api/jobs/{JOB}/transcription", json={"stems": ["original"]})
    assert r.status_code == 422


def test_a_second_request_while_running_is_refused(client, jobs_dir, monkeypatch):
    _song(jobs_dir, transcription="running")
    monkeypatch.setattr(api, "transcribe_stems", lambda *a: pytest.fail("started"))
    r = client.post(f"/api/jobs/{JOB}/transcription")
    assert r.status_code == 409


@pytest.mark.parametrize("busy", [{"vocal_split": "running"}, {"stem_fill": "running"}])
def test_refused_as_busy_while_a_split_or_a_fill_runs(client, jobs_dir, monkeypatch, busy):
    _song(jobs_dir, **busy)
    monkeypatch.setattr(api, "transcribe_stems", lambda *a: pytest.fail("started"))
    r = client.post(f"/api/jobs/{JOB}/transcription")
    assert r.status_code == 409
    assert r.json().get("code") == "job_busy" or "busy" in r.text


def test_a_running_transcription_blocks_a_vocal_split_and_a_delete(client, jobs_dir):
    _song(jobs_dir, transcription="running")
    assert client.post(f"/api/jobs/{JOB}/vocal-split").status_code == 409
    assert client.delete(f"/api/jobs/{JOB}").status_code == 409
    assert (jobs_dir / JOB / "stems" / "bass.wav").exists()


def test_refused_where_transcription_cannot_run(client, jobs_dir, monkeypatch):
    _song(jobs_dir)
    monkeypatch.setattr(api, "transcription_available", lambda: False)
    monkeypatch.setattr(api, "transcribe_stems", lambda *a: pytest.fail("started"))
    r = client.post(f"/api/jobs/{JOB}/transcription")
    assert r.status_code == 501
    assert r.json()["transcription_reason"] == "unsupported_platform"
    assert "Intel" in r.json()["transcription_message"]


def test_config_says_whether_transcription_is_available(client, monkeypatch):
    import app.api.config as config_api

    body = client.get("/api/config").json()
    assert body["transcription_available"] is True
    assert body["transcription_routes"]["bass"] == "crepe"
    assert body["quantize_parts"] == [1, 2, 3, 4, 6, 8]
    assert body["quantize_parts_default"] == 4
    monkeypatch.setattr(config_api.sys, "platform", "darwin")
    monkeypatch.setattr(config_api.platform, "machine", lambda: "x86_64")
    assert client.get("/api/config").json()["transcription_available"] is False
    monkeypatch.setattr(config_api.platform, "machine", lambda: "arm64")
    assert client.get("/api/config").json()["transcription_available"] is True


def test_one_stem_failing_keeps_the_others_and_the_song(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)
    failed = {"status": "error", "notes": 0, "code": "model_unavailable", "transcriber": "piano"}
    monkeypatch.setattr(api, "transcribe_stems", _fake_run({"piano": failed}))
    r = client.post(f"/api/jobs/{JOB}/transcription", json={"stems": ["bass", "piano"]})
    assert r.status_code == 200
    body = r.json()
    assert body["transcription"] == "done" and body["status"] == "done"
    assert body["transcription_stems"]["piano"]["code"] == "model_unavailable"
    assert body["transcription_stems"]["bass"]["status"] == "done"
    assert transcribed_stems(jobs_dir / JOB / "stems") == ["bass"]
    assert job.status == "done"


def test_a_cancel_keeps_completed_stems_and_the_song(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)

    def cancelled(outcomes):
        del outcomes["piano"]
        (jobs_dir / JOB / "stems" / "transcription" / "piano.json").unlink()
        job.cancel_requested = True
        return TranscriptionError("cancelled", code="cancelled", outcomes=outcomes)

    monkeypatch.setattr(api, "transcribe_stems", _fake_run(raises=cancelled))
    r = client.post(f"/api/jobs/{JOB}/transcription", json={"stems": ["bass", "piano"]})
    assert r.status_code == 500
    body = r.json()
    assert body["transcription"] == "error"
    assert body["transcription_reason"] == "cancelled"
    assert body["transcription_message"] == "The transcription was cancelled."
    assert body["status"] == "done"
    assert body["transcription_stems"] == {
        "bass": {"status": "done", "notes": 1, "code": None, "transcriber": "crepe"}
    }
    assert job.cancel_requested is False and job.stage_message == "Done"
    assert read_notes(jobs_dir / JOB / "stems", "bass") is not None
    # And it can be started again afterwards.
    monkeypatch.setattr(api, "transcribe_stems", _fake_run())
    assert (
        client.post(f"/api/jobs/{JOB}/transcription", json={"stems": ["piano"]}).status_code == 200
    )
    assert sorted(job.transcription_stems) == ["bass", "piano"]


def test_an_unexpected_failure_reads_as_a_worker_failure_without_its_words(
    client, jobs_dir, monkeypatch
):
    _song(jobs_dir)

    def boom(*a):
        raise RuntimeError("/secret/path/model.ckpt is corrupt")

    monkeypatch.setattr(api, "transcribe_stems", boom)
    r = client.post(f"/api/jobs/{JOB}/transcription", json={"stems": ["bass"]})
    assert r.status_code == 500
    assert r.json()["transcription_reason"] == "worker_failed"
    assert "secret" not in r.text


def test_cancel_terminates_the_running_worker(client, jobs_dir):
    import subprocess

    from app.core import registry

    job = _song(jobs_dir, transcription="running")
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        with registry.operation("transcribe"):
            registry.set_proc(JOB, proc)
        r = client.post(f"/api/jobs/{JOB}/cancel")
        assert r.status_code == 200
        assert job.cancel_requested is True
        assert proc.wait(timeout=10) != 0
    finally:
        proc.kill()


def test_a_real_run_through_the_stub_worker(client, jobs_dir, monkeypatch):
    """The endpoint, the parent and a worker process together: only the
    models are missing."""
    import app.pipeline.notes as notes_mod

    _song(jobs_dir)
    stub = """
import sys, json
from pathlib import Path
from app.core.transcription_files import write_notes
for stem in sys.argv[3].split(","):
    write_notes(Path(sys.argv[2]), stem, transcriber="crepe", model="stub", duration=2.0,
                notes=[{"start": 0.0, "end": 0.5, "pitch": 40, "velocity": 80}])
    sys.stderr.write("@@STEM@@" + json.dumps({"stem": stem, "status": "done", "notes": 1,
        "code": None, "transcriber": "crepe"}) + "\\n")
sys.stderr.write("@@DONE@@\\n")
"""
    monkeypatch.setattr(notes_mod, "get_demucs_device", lambda: "cpu")
    monkeypatch.setattr(
        notes_mod,
        "_spawn_cmd",
        lambda device, stems_dir, names: [
            sys.executable,
            "-c",
            stub,
            device,
            str(stems_dir),
            ",".join(names),
        ],
    )
    r = client.post(f"/api/jobs/{JOB}/transcription", json={"stems": ["bass", "vocals"]})
    assert r.status_code == 200, r.text
    assert r.json()["transcription_stems"]["bass"]["notes"] == 1
    assert client.get(f"/api/jobs/{JOB}/transcription").json()["stems"]["vocals"]["model"] == "stub"


# -- notes as JSON ----------------------------------------------------------


def test_notes_as_played(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "bass", [_note(0.97, 1.4, 40)])
    _store(jobs_dir, "piano", [_note(0.0, 2.0, 60), _note(0.0, 2.0, 64)], transcriber="piano")
    r = client.get(f"/api/jobs/{JOB}/transcription")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["quantized"] is False and body["parts"] is None
    assert body["quantize_available"] is True
    assert body["grid"] == {
        "confidence": 91,
        "detector": "beat_this",
        "bpm": 120.0,
        "edited": False,
    }
    assert body["stems"]["bass"]["notes"] == [_note(0.97, 1.4, 40)]
    assert body["stems"]["bass"]["transcriber"] == "crepe"
    assert list(body["stems"]) == ["piano", "bass"]


def test_notes_quantised_carry_bar_beat_and_part(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "bass", [_note(0.97, 1.4, 40)])
    body = client.get(f"/api/jobs/{JOB}/transcription?quantize=1").json()
    assert body["quantized"] is True and body["parts"] == 4
    (note,) = body["stems"]["bass"]["notes"]
    assert (note["bar"], note["beat"], note["part"]) == (1, 3, 0)
    assert note["start"] == 1.0


def test_stems_and_parts_parameters(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "bass", [_note(0.17, 0.3, 40)])
    _store(jobs_dir, "vocals", [_note(1.0, 1.5, 64)])
    body = client.get(f"/api/jobs/{JOB}/transcription?stems=bass&quantize=1&parts=3").json()
    assert list(body["stems"]) == ["bass"]
    assert body["stems"]["bass"]["notes"][0]["part"] == 1
    assert client.get(f"/api/jobs/{JOB}/transcription?parts=5").status_code == 422
    r = client.get(f"/api/jobs/{JOB}/transcription?stems=bass,piano")
    assert r.status_code == 404 and "piano" in r.json()["detail"]


def test_a_monophonic_stem_stays_monophonic_when_quantised(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "bass", [_note(0.0, 2.0, 40), _note(0.5, 1.0, 43)])
    notes = client.get(f"/api/jobs/{JOB}/transcription?quantize=1").json()["stems"]["bass"]["notes"]
    assert notes[0]["step"] + notes[0]["steps"] <= notes[1]["step"]


def test_nothing_transcribed_is_a_404(client, jobs_dir):
    _song(jobs_dir)
    for path in ("transcription", "transcription.mid", "transcription.musicxml"):
        r = client.get(f"/api/jobs/{JOB}/{path}")
        assert r.status_code == 404 and r.json()["detail"] == "nothing transcribed"


def test_without_a_beat_grid_the_played_notes_are_still_served(client, jobs_dir):
    _song(jobs_dir, grid=False)
    _store(jobs_dir, "bass", [_note(0.5, 1.0, 40)])
    body = client.get(f"/api/jobs/{JOB}/transcription").json()
    assert body["quantize_available"] is False
    assert body["quantize_reason"] == "no_beat_grid" and body["grid"] is None
    assert body["stems"]["bass"]["notes"] == [_note(0.5, 1.0, 40)]
    for path in (
        "transcription?quantize=1",
        "transcription.mid?quantize=1",
        "transcription.musicxml",
    ):
        r = client.get(f"/api/jobs/{JOB}/{path}")
        assert r.status_code == 409, path
        assert r.json()["transcription_reason"] == "no_beat_grid"
        assert "beat grid" in r.json()["transcription_message"]
    assert client.get(f"/api/jobs/{JOB}/transcription.mid").status_code == 200


def test_an_edited_grid_changes_the_quantised_notes_with_no_model_run(
    client, jobs_dir, monkeypatch
):
    _song(jobs_dir)
    _store(jobs_dir, "bass", [_note(1.0, 1.4, 40)])
    monkeypatch.setattr(api, "transcribe_stems", lambda *a: pytest.fail("a model ran"))
    before = client.get(f"/api/jobs/{JOB}/transcription?quantize=1").json()
    # The user moves every beat a sixteenth later (PATCH .../beats writes this file).
    r = client.patch(
        f"/api/jobs/{JOB}/beats",
        json={
            "beats": [round(0.125 + 0.5 * i, 6) for i in range(33)],
            "bars": [{"beat": 0, "beats_per_bar": 4}],
        },
    )
    assert r.status_code == 200, r.text
    after = client.get(f"/api/jobs/{JOB}/transcription?quantize=1").json()
    b, a = before["stems"]["bass"]["notes"][0], after["stems"]["bass"]["notes"][0]
    assert (b["beat"], b["part"]) == (3, 0)
    assert (a["beat"], a["part"]) == (2, 3)
    assert after["grid"]["edited"] is True and before["grid"]["edited"] is False


# -- downloads --------------------------------------------------------------


def _midi(response) -> mido.MidiFile:
    return mido.MidiFile(file=io.BytesIO(response.content))


def _track_names(mid) -> list[str]:
    return [next(m.name for m in t if m.type == "track_name") for t in mid.tracks]


def test_midi_download_has_a_track_per_transcribed_stem(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "vocals", [_note(1.0, 1.5, 64)])
    _store(jobs_dir, "bass", [_note(0.5, 1.0, 40)])
    _store(jobs_dir, "drums", [_note(0.0, 0.05, 36)], transcriber="mt3")
    r = client.get(f"/api/jobs/{JOB}/transcription.mid")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/midi"
    assert r.headers["content-disposition"] == 'attachment; filename="Blue_in_Green_notes.mid"'
    mid = _midi(r)
    assert _track_names(mid)[1:] == ["vocals", "bass", "drums"]
    drums = mid.tracks[_track_names(mid).index("drums")]
    assert {m.channel for m in drums if m.type == "note_on"} == {9}


def test_midi_download_for_chosen_stems(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "vocals", [_note(1.0, 1.5, 64)])
    _store(jobs_dir, "bass", [_note(0.5, 1.0, 40)])
    mid = _midi(client.get(f"/api/jobs/{JOB}/transcription.mid?stems=bass"))
    assert _track_names(mid)[1:] == ["bass"]


def test_quantised_midi_download(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "bass", [_note(0.97, 1.4, 40)])
    r = client.get(f"/api/jobs/{JOB}/transcription.mid?quantize=1")
    assert r.status_code == 200
    assert "Blue_in_Green_notes_quantised.mid" in r.headers["content-disposition"]
    mid = _midi(r)
    assert any(m.type == "set_tempo" for m in mid.tracks[0])
    assert any(m.type == "time_signature" and m.numerator == 4 for m in mid.tracks[0])
    tick = 0
    for msg in mid.tracks[1]:
        tick += msg.time
        if msg.type == "note_on":
            break
    # The grid starts at 0, so there is no lead-in: beat 3 is tick 2 * 480.
    assert tick == 960


def test_musicxml_download(client, jobs_dir):
    from music21 import converter

    _song(jobs_dir, key="A", scale="minor")
    _store(jobs_dir, "vocals", [_note(1.5, 2.5, 69)])
    _store(jobs_dir, "bass", [_note(0.0, 0.5, 45)])
    r = client.get(f"/api/jobs/{JOB}/transcription.musicxml")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.recordare.musicxml+xml")
    assert r.headers["content-disposition"] == 'attachment; filename="Blue_in_Green.musicxml"'
    score = converter.parseData(r.content.decode("utf-8"), format="musicxml")

    def names(parsed):
        # The bass part is two staves, notation and tab (openspec change
        # add-alphatab-notation), which music21 reads as two parts of one name.
        return list(dict.fromkeys(p.partName for p in parsed.parts))

    # Score order, not the alphabet: the voice on top, the bass under it.
    assert names(score) == ["vocals", "bass"]
    assert r.content.count(b"<score-part ") == 2
    asked = client.get(f"/api/jobs/{JOB}/transcription.musicxml?stems=bass,vocals")
    asked_score = converter.parseData(asked.content.decode("utf-8"), format="musicxml")
    assert names(asked_score) == ["bass", "vocals"]
    assert b"<fifths>0</fifths>" in r.content and b"<mode>minor</mode>" in r.content
    only = client.get(f"/api/jobs/{JOB}/transcription.musicxml?stems=vocals")
    assert only.content.count(b"<score-part ") == 1


def test_a_skipped_silent_stem_is_no_track_and_no_part(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir, "bass", [_note(0.5, 1.0, 40)])
    _store(jobs_dir, "piano", [], transcriber="piano", skipped="silent")
    body = client.get(f"/api/jobs/{JOB}/transcription").json()
    assert body["stems"]["piano"] == {
        "transcriber": "piano",
        "model": "m",
        "duration": 16.0,
        "skipped": "silent",
        "notes": [],
    }
    assert _track_names(_midi(client.get(f"/api/jobs/{JOB}/transcription.mid")))[1:] == ["bass"]
    xml = client.get(f"/api/jobs/{JOB}/transcription.musicxml").content
    assert xml.count(b"<score-part ") == 1
    # Only the silent stem asked for: there is nothing to download.
    assert client.get(f"/api/jobs/{JOB}/transcription.mid?stems=piano").status_code == 404


def test_a_song_with_no_title_still_gets_a_file_name(client, jobs_dir):
    job = _song(jobs_dir)
    job.title = None
    _store(jobs_dir, "bass", [_note(0.5, 1.0, 40)])
    r = client.get(f"/api/jobs/{JOB}/transcription.musicxml")
    assert r.headers["content-disposition"] == 'attachment; filename="transcription.musicxml"'


def test_downloads_of_an_unknown_job_are_404(client):
    for path in ("transcription", "transcription.mid", "transcription.musicxml"):
        assert client.get(f"/api/jobs/000000000000/{path}").status_code == 404


def test_a_song_rebuilt_from_its_folder_still_knows_its_transcription(jobs_dir):
    from app.core.registry import _rebuild_from_folder

    _song(jobs_dir)
    _store(jobs_dir, "bass", [_note(0.5, 1.0, 40)])
    _store(jobs_dir, "piano", [], transcriber="piano", skipped="silent")
    # A finished run's metadata.json is what makes the folder a done song.
    (jobs_dir / JOB / "metadata.json").write_text(
        json.dumps({"title": "Blue in Green", "created_at": 1.0}), encoding="utf-8"
    )
    rebuilt = _rebuild_from_folder(jobs_dir / JOB)
    assert rebuilt is not None
    job, _ = rebuilt
    assert job.transcription == "done"
    assert job.transcription_stems["bass"] == {
        "status": "done",
        "notes": 1,
        "code": None,
        "transcriber": "crepe",
    }
    assert job.transcription_stems["piano"]["status"] == "skipped"
