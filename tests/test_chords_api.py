"""The chord endpoints (app/api/chords.py), with the worker stubbed: starting a
detection and its refusals, the timeline with its changes on beats, and the
user's corrections.
"""

from __future__ import annotations

import json
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

import app.api.chords as api
from app.core import chord_files
from app.core.models import Job
from app.core.registry import _jobs, _procs
from app.pipeline.chords import ChordsError

JOB = "a1b2c3d4e5f6"


@pytest.fixture(autouse=True)
def _checkpoints_on_disk(monkeypatch):
    """The model's checkpoints count as downloaded: no run here downloads."""
    from app.pipeline import chord_engine

    monkeypatch.setattr(chord_engine, "missing_checkpoints", lambda: [])


C = {"root": 0, "degrees": ["1", "3", "5"], "bass": None}
F = {"root": 5, "degrees": ["1", "3", "5"], "bass": None}
G7 = {"root": 7, "degrees": ["1", "3", "5", "b7"], "bass": None}
CMAJ7 = {"root": 0, "degrees": ["1", "3", "5", "7"], "bass": None}
NONE = {"root": None, "degrees": [], "bass": None}


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


def _stems(jobs_dir):
    return jobs_dir / JOB / "stems"


def _song(jobs_dir, grid=True, **fields) -> Job:
    job = Job(id=JOB, status="done", title="Sunny Side", source_url="local:x", **fields)
    stems_dir = _stems(jobs_dir)
    stems_dir.mkdir(parents=True, exist_ok=True)
    for name in ("vocals", "bass", "piano"):
        (stems_dir / f"{name}.wav").write_bytes(b"RIFF")
        job.stems.append({"name": name, "url": f"/api/jobs/{JOB}/stems/{name}.wav"})
    if grid:
        _write_grid(jobs_dir)
    _jobs[job.id] = job
    return job


def _write_grid(jobs_dir, start=0.0, name="beats.json", n=33):
    """120 BPM: a beat every half second."""
    grid = {
        "version": 1,
        "detector": "beat_this",
        "confidence": 91,
        "bpm": 120.0,
        "beats": [round(start + 0.5 * i, 6) for i in range(n)],
        "bars": [{"beat": 0, "beats_per_bar": 4}],
    }
    (_stems(jobs_dir) / name).write_text(json.dumps(grid), encoding="utf-8")


def _line(*parts, label=True):
    out, at = [], 0.0
    for end, chord in parts:
        entry = {"start": at, "end": end, **chord}
        if label:
            entry["label"] = "N" if chord["root"] is None else "x"
        out.append(entry)
        at = end
    return out


# The detector's times: a change 80 ms before the beat at 2.0, and a blip.
DETECTED = _line((1.92, C), (4.1, F), (4.267, G7), (8.0, C), (16.0, F))


def _store(jobs_dir, chords=None, duration=16.0):
    chord_files.write_detected(
        _stems(jobs_dir),
        engine="lv-chordia",
        engine_version="1.1.0",
        vocabulary="full",
        duration=duration,
        chords=DETECTED if chords is None else chords,
    )


def _fake_run(chords=None, raises=None, named=None):
    """A stand-in for detect_chords that writes the file like the worker."""
    calls: list[str] = []

    def run(job, stems_dir):
        calls.append(job.id)
        if raises is not None:
            raise raises
        entries = DETECTED if chords is None else chords
        chord_files.write_detected(
            stems_dir,
            engine="lv-chordia",
            engine_version="1.1.0",
            vocabulary="full",
            duration=16.0,
            chords=entries,
        )
        count = sum(1 for e in entries if e["root"] is not None)
        return {"chords": len(entries), "named": count if named is None else named}

    run.calls = calls
    return run


def _shape(chords):
    return [(c["start"], c["end"], c["root"]) for c in chords]


def _edit(*parts):
    return _line(*parts, label=False)


# -- starting a detection ---------------------------------------------------


def test_detects_the_chords_of_a_finished_song(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)
    run = _fake_run()
    monkeypatch.setattr(api, "detect_chords", run)

    r = client.post(f"/api/jobs/{JOB}/chords")

    assert r.status_code == 200, r.text
    assert run.calls == [JOB]
    body = r.json()
    assert body["chords"] == "done" and body["status"] == "done"
    assert body["chords_reason"] is None and body["chords_progress"] is None
    assert body["chords_found"] is True and body["chords_edited"] is False
    assert job.chords == "done" and job.stage_message == "Done"
    assert client.get(f"/api/jobs/{JOB}/chords").status_code == 200


def test_the_song_reports_running_while_it_runs(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)
    seen = {}

    def run(j, stems_dir):
        seen["state"] = j.chords
        seen["busy"] = j.post_hoc_running()
        seen["stage"] = j.stage_message
        j.chords_progress = {"phase": "detecting", "percent": 40}
        seen["progress"] = j.to_state()["chords_progress"]
        return {"chords": 0, "named": 0}

    monkeypatch.setattr(api, "detect_chords", run)
    client.post(f"/api/jobs/{JOB}/chords")
    assert seen == {
        "state": "running",
        "busy": True,
        "stage": "Detecting chords...",
        "progress": {"phase": "detecting", "percent": 40},
    }
    assert job.chords == "done" and job.chords_progress is None


def test_the_running_state_is_saved_before_the_run_starts(client, jobs_dir, monkeypatch):
    _song(jobs_dir)
    seen = {}

    def run(j, stems_dir):
        # What a restart right now would load.
        saved = json.loads((jobs_dir / "registry.json").read_text(encoding="utf-8"))
        records = saved["jobs"] if isinstance(saved, dict) and "jobs" in saved else saved
        record = (
            records[JOB]
            if isinstance(records, dict)
            else next(r for r in records if r["id"] == JOB)
        )
        seen["saved"] = record["chords"]
        seen["restart"] = Job.from_record(record).chords_reason
        return {"chords": 0, "named": 0}

    monkeypatch.setattr(api, "detect_chords", run)
    client.post(f"/api/jobs/{JOB}/chords")
    assert seen == {"saved": "running", "restart": "interrupted"}


def test_import_does_not_detect_chords(client, jobs_dir):
    _song(jobs_dir)
    assert client.get(f"/api/jobs/{JOB}").json()["chords"] == "none"
    assert client.get(f"/api/jobs/{JOB}/chords").status_code == 404


def test_a_song_that_is_not_finished_is_refused(client, jobs_dir, monkeypatch):
    monkeypatch.setattr(api, "detect_chords", lambda *a: pytest.fail("started"))
    assert client.post("/api/jobs/000000000000/chords").status_code == 404
    assert client.post("/api/jobs/not-an-id/chords").status_code == 404
    for status in ("separating", "error", "queued"):
        _jobs[JOB] = Job(id=JOB, status=status)
        assert client.post(f"/api/jobs/{JOB}/chords").status_code == 404
        assert client.get(f"/api/jobs/{JOB}/chords").status_code == 404
        assert client.patch(f"/api/jobs/{JOB}/chords", json={"chords": []}).status_code == 404
        assert client.delete(f"/api/jobs/{JOB}/chords").status_code == 404


def test_a_second_request_while_running_is_refused(client, jobs_dir, monkeypatch):
    _song(jobs_dir, chords="running")
    monkeypatch.setattr(api, "detect_chords", lambda *a: pytest.fail("started"))
    assert client.post(f"/api/jobs/{JOB}/chords").status_code == 409


@pytest.mark.parametrize(
    "busy",
    [
        {"vocal_split": "running"},
        {"stem_fill": "running"},
        {"midi": {"bass": {"state": "running"}}},
        {"stem_reextract": {"state": "running"}},
    ],
)
def test_refused_as_busy_while_other_work_runs_on_the_song(client, jobs_dir, monkeypatch, busy):
    job = _song(jobs_dir, **busy)
    monkeypatch.setattr(api, "detect_chords", lambda *a: pytest.fail("started"))
    r = client.post(f"/api/jobs/{JOB}/chords")
    assert r.status_code == 409
    assert r.json().get("code") == "job_busy" or "busy" in r.text
    assert job.chords == "none"


def test_a_running_detection_blocks_other_work_and_a_delete(client, jobs_dir):
    _song(jobs_dir, chords="running")
    assert client.post(f"/api/jobs/{JOB}/vocal-split").status_code == 409
    assert client.post(f"/api/jobs/{JOB}/midi", json={"stem": "bass"}).status_code == 409
    assert client.post(f"/api/jobs/{JOB}/fill-stems", json={"stems": ["drums"]}).status_code == 409
    assert client.delete(f"/api/jobs/{JOB}").status_code == 409
    assert (_stems(jobs_dir) / "bass.wav").exists()


def test_refused_where_the_detector_is_not_installed(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)
    monkeypatch.setattr(api, "chords_available", lambda: False)
    monkeypatch.setattr(api, "detect_chords", lambda *a: pytest.fail("started"))
    r = client.post(f"/api/jobs/{JOB}/chords")
    assert r.status_code == 501
    assert r.json()["chords_reason"] == "dependency_missing"
    assert "missing or damaged" in r.json()["chords_message"]
    assert job.chords == "none"


def test_config_says_whether_chords_can_be_detected(client, monkeypatch):
    from app.pipeline import chord_engine

    # The vendored model is all there. Its checkpoints need not be: they are
    # downloaded the first time chords are detected.
    assert client.get("/api/config").json()["chords_available"] is True
    monkeypatch.setattr(chord_engine, "vendored", lambda: False)
    assert client.get("/api/config").json()["chords_available"] is False


# -- failure and cancel -----------------------------------------------------


def test_a_failure_keeps_the_song_and_the_chords_it_had(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)
    _store(jobs_dir)
    before = (_stems(jobs_dir) / "chords.json").read_bytes()
    monkeypatch.setattr(api, "detect_chords", _fake_run(raises=ChordsError("x", code="timeout")))

    r = client.post(f"/api/jobs/{JOB}/chords")

    assert r.status_code == 500
    body = r.json()
    assert body["status"] == "done" and body["chords"] == "error"
    assert body["chords_reason"] == "timeout"
    assert (
        body["chords_message"] == "Chord detection stopped responding and was stopped. Try again."
    )
    assert job.stage_message == "Done" and not job.post_hoc_running()
    assert (_stems(jobs_dir) / "chords.json").read_bytes() == before
    assert client.get(f"/api/jobs/{JOB}/chords").status_code == 200
    # And it can be started again.
    monkeypatch.setattr(api, "detect_chords", _fake_run())
    assert client.post(f"/api/jobs/{JOB}/chords").json()["chords"] == "done"


def test_a_cancel_is_reported_and_cleared(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)

    def cancelled(j, stems_dir):
        j.cancel_requested = True
        raise ChordsError("cancelled", code="cancelled")

    monkeypatch.setattr(api, "detect_chords", cancelled)
    r = client.post(f"/api/jobs/{JOB}/chords")
    assert r.status_code == 500
    assert r.json()["chords_reason"] == "cancelled"
    assert r.json()["chords_message"] == "Chord detection was cancelled."
    assert job.cancel_requested is False
    assert not (_stems(jobs_dir) / "chords.json").exists()


def test_a_cancel_left_from_an_earlier_run_does_not_stop_this_one(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)
    job.cancel_requested = True
    monkeypatch.setattr(api, "detect_chords", _fake_run())
    assert client.post(f"/api/jobs/{JOB}/chords").status_code == 200
    assert job.cancel_requested is False


def test_an_unexpected_failure_reads_as_a_worker_failure_without_its_words(
    client, jobs_dir, monkeypatch
):
    _song(jobs_dir)

    def boom(*a):
        raise RuntimeError("/secret/path/model.sdict is corrupt")

    monkeypatch.setattr(api, "detect_chords", boom)
    r = client.post(f"/api/jobs/{JOB}/chords")
    assert r.status_code == 500
    assert r.json()["chords_reason"] == "worker_failed"
    assert "secret" not in r.text


def test_cancel_terminates_the_running_worker(client, jobs_dir):
    from app.core import registry

    job = _song(jobs_dir, chords="running")
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        with registry.operation("chords"):
            registry.set_proc(JOB, proc)
        r = client.post(f"/api/jobs/{JOB}/cancel")
        assert r.status_code == 200
        assert job.cancel_requested is True
        assert proc.wait(timeout=10) != 0
    finally:
        proc.kill()


def test_a_real_run_through_a_stub_worker(client, jobs_dir, monkeypatch):
    """The endpoint, the parent and a worker process together: only the model
    is missing."""
    import app.pipeline.chords as parent

    job = _song(jobs_dir)
    stub = (
        "import sys, json\n"
        "from pathlib import Path\n"
        "from app.core.chord_files import write_detected\n"
        "sys.stderr.write('@@PROGRESS@@' + json.dumps({'phase': 'detecting', 'percent': 20}) + '\\n')\n"
        "write_detected(Path(sys.argv[1]), engine='lv-chordia', engine_version='1.1.0',\n"
        "    vocabulary='full', duration=8.0, chords=[\n"
        "    {'start': 0.0, 'end': 8.0, 'root': 9, 'degrees': ['1', 'b3', '5'], 'bass': None,\n"
        "     'label': 'A:min'}])\n"
        "sys.stderr.write('@@DONE@@' + json.dumps({'chords': 1, 'named': 1}) + '\\n')\n"
    )
    monkeypatch.setattr(
        parent, "_spawn_cmd", lambda stems_dir: [sys.executable, "-c", stub, str(stems_dir)]
    )
    r = client.post(f"/api/jobs/{JOB}/chords")
    assert r.status_code == 200, r.text
    assert r.json()["chords_found"] is True
    assert job.chords == "done"
    body = client.get(f"/api/jobs/{JOB}/chords").json()
    assert _shape(body["chords"]) == [(0.0, 8.0, 9)]
    assert body["chords"][0]["label"] == "A:min"


def test_no_chord_found_anywhere_is_said(client, jobs_dir, monkeypatch):
    _song(jobs_dir)
    monkeypatch.setattr(api, "detect_chords", _fake_run(chords=_line((16.0, NONE))))
    body = client.post(f"/api/jobs/{JOB}/chords").json()
    assert body["chords"] == "done" and body["chords_found"] is False
    served = client.get(f"/api/jobs/{JOB}/chords").json()
    assert served["named"] == 0 and _shape(served["chords"]) == [(0.0, 16.0, None)]


# -- the timeline -----------------------------------------------------------


def test_the_detected_timeline_is_served_with_its_changes_on_beats(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir)
    r = client.get(f"/api/jobs/{JOB}/chords")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    # 1.92 is on the beat at 2.0; the G7 blip went to its neighbours.
    assert _shape(body["chords"]) == [
        (0.0, 2.0, 0),
        (2.0, 4.0, 5),
        (4.0, 8.0, 0),
        (8.0, 16.0, 5),
    ]
    assert body["source"] == "detected" and body["edited"] is False
    assert body["has_detected"] is True and body["aligned"] is True
    assert body["engine"] == "lv-chordia" and body["engine_version"] == "1.1.0"
    assert body["vocabulary"] == "full" and body["duration"] == 16.0
    assert body["named"] == 4
    assert body["beats"][:3] == [0.0, 0.5, 1.0] and len(body["beats"]) == 33
    assert all("label" in c for c in body["chords"])
    # The stored detection still has the detector's own times.
    stored = chord_files.read_detected(_stems(jobs_dir))["chords"]
    assert stored[0]["end"] == 1.92 and len(stored) == 5


def test_a_song_with_no_chords_answers_that_it_has_none(client, jobs_dir):
    _song(jobs_dir)
    r = client.get(f"/api/jobs/{JOB}/chords")
    assert r.status_code == 404 and r.json()["detail"] == "no chords"
    assert client.get(f"/api/jobs/{JOB}/chords?source=detected").status_code == 404


def test_a_damaged_chord_file_reads_as_no_chords(client, jobs_dir):
    _song(jobs_dir)
    (_stems(jobs_dir) / "chords.json").write_text("{", encoding="utf-8")
    assert client.get(f"/api/jobs/{JOB}/chords").status_code == 404


def test_a_corrected_beat_grid_moves_the_changes_with_no_model_run(client, jobs_dir, monkeypatch):
    _song(jobs_dir)
    _store(jobs_dir)
    monkeypatch.setattr(api, "detect_chords", lambda *a: pytest.fail("a model run"))
    assert client.get(f"/api/jobs/{JOB}/chords").json()["chords"][0]["end"] == 2.0
    # The user moves every beat 0.2 s later (PATCH /beats writes this file).
    edited = {"version": 1, "beats": [round(0.2 + 0.5 * i, 6) for i in range(33)], "bars": []}
    (_stems(jobs_dir) / "beats.user.json").write_text(json.dumps(edited), encoding="utf-8")
    body = client.get(f"/api/jobs/{JOB}/chords").json()
    assert body["chords"][0]["end"] == 1.7
    assert body["beats"][0] == 0.2
    # And back, when the edit is discarded.
    (_stems(jobs_dir) / "beats.user.json").unlink()
    assert client.get(f"/api/jobs/{JOB}/chords").json()["chords"][0]["end"] == 2.0


def test_without_a_beat_grid_the_detectors_times_are_served(client, jobs_dir):
    _song(jobs_dir, grid=False)
    _store(jobs_dir)
    body = client.get(f"/api/jobs/{JOB}/chords").json()
    assert body["aligned"] is False and body["beats"] == []
    assert _shape(body["chords"]) == _shape(DETECTED)


def test_a_grid_of_one_beat_is_no_grid(client, jobs_dir):
    _song(jobs_dir, grid=False)
    _write_grid(jobs_dir, n=1)
    _store(jobs_dir)
    assert client.get(f"/api/jobs/{JOB}/chords").json()["aligned"] is False


def test_the_timeline_reaches_the_end_of_the_song(client, jobs_dir):
    _song(jobs_dir)
    # A detection that stopped at 12 s of a 16 s song.
    _store(jobs_dir, chords=_line((4.0, C), (12.0, F)))
    chords = client.get(f"/api/jobs/{JOB}/chords").json()["chords"]
    assert _shape(chords) == [(0.0, 4.0, 0), (4.0, 12.0, 5), (12.0, 16.0, None)]


def test_an_unknown_source_is_refused(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir)
    assert client.get(f"/api/jobs/{JOB}/chords?source=mine").status_code == 422


# -- corrections ------------------------------------------------------------


def test_a_correction_is_saved_and_served(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir)
    served = client.get(f"/api/jobs/{JOB}/chords").json()["chords"]
    # The second C is really a Cmaj7.
    served[2] = {**served[2], **CMAJ7}

    r = client.patch(f"/api/jobs/{JOB}/chords", json={"chords": served})

    assert r.status_code == 200, r.text
    assert r.json() == {"job_id": JOB, "chords": 4, "edited": True}
    body = client.get(f"/api/jobs/{JOB}/chords").json()
    assert body["source"] == "user" and body["edited"] is True and body["has_detected"] is True
    assert body["chords"][2]["degrees"] == ["1", "3", "5", "7"]
    assert _shape(body["chords"]) == _shape(served)
    # A correction carries no detector label.
    assert all("label" not in c for c in body["chords"])
    # The detection is untouched and can still be read.
    detected = client.get(f"/api/jobs/{JOB}/chords?source=detected").json()
    assert detected["source"] == "detected" and detected["edited"] is True
    assert detected["chords"][2]["degrees"] == ["1", "3", "5"]


def test_detecting_again_keeps_the_corrections(client, jobs_dir, monkeypatch):
    _song(jobs_dir)
    _store(jobs_dir)
    corrected = _edit((8.0, CMAJ7), (16.0, F))
    assert client.patch(f"/api/jobs/{JOB}/chords", json={"chords": corrected}).status_code == 200
    # The detector now hears something else entirely.
    monkeypatch.setattr(api, "detect_chords", _fake_run(chords=_line((16.0, G7))))

    r = client.post(f"/api/jobs/{JOB}/chords")

    assert r.status_code == 200
    assert r.json()["chords_edited"] is True
    body = client.get(f"/api/jobs/{JOB}/chords").json()
    assert body["source"] == "user" and _shape(body["chords"]) == [(0.0, 8.0, 0), (8.0, 16.0, 5)]
    # The new detection is there, behind the corrections.
    detected = client.get(f"/api/jobs/{JOB}/chords?source=detected").json()
    assert _shape(detected["chords"]) == [(0.0, 16.0, 7)]


def test_discarding_the_corrections_goes_back_to_the_detection(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir)
    client.patch(f"/api/jobs/{JOB}/chords", json={"chords": _edit((16.0, CMAJ7))})

    r = client.delete(f"/api/jobs/{JOB}/chords")

    assert r.status_code == 200
    assert r.json() == {"job_id": JOB, "edited": False, "has_detected": True}
    body = client.get(f"/api/jobs/{JOB}/chords").json()
    assert body["source"] == "detected" and body["edited"] is False
    assert len(body["chords"]) == 4
    # Twice is fine.
    assert client.delete(f"/api/jobs/{JOB}/chords").status_code == 200


def test_corrections_survive_being_read_back_and_saved_again(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir)
    first = client.get(f"/api/jobs/{JOB}/chords").json()["chords"]
    client.patch(f"/api/jobs/{JOB}/chords", json={"chords": first})
    second = client.get(f"/api/jobs/{JOB}/chords").json()["chords"]
    client.patch(f"/api/jobs/{JOB}/chords", json={"chords": second})
    third = client.get(f"/api/jobs/{JOB}/chords").json()["chords"]
    assert _shape(first) == _shape(second) == _shape(third)


def test_what_the_user_placed_is_moved_to_the_grid_but_not_merged_away(client, jobs_dir):
    _song(jobs_dir)
    # One-beat chords, which the detected timeline would also keep, and a
    # correction made before the grid was moved by 0.2 s.
    client.patch(
        f"/api/jobs/{JOB}/chords",
        json={"chords": _edit((2.0, C), (2.5, G7), (3.0, F), (16.0, C))},
    )
    assert [c["root"] for c in client.get(f"/api/jobs/{JOB}/chords").json()["chords"]] == [
        0,
        7,
        5,
        0,
    ]
    _write_grid(jobs_dir, start=0.2)
    body = client.get(f"/api/jobs/{JOB}/chords").json()
    assert [c["root"] for c in body["chords"]] == [0, 7, 5, 0]
    assert [c["start"] for c in body["chords"]] == [0.0, 2.2, 2.7, 3.2]


def test_a_stretch_the_correction_leaves_out_is_no_chord(client, jobs_dir):
    _song(jobs_dir)
    gapped = [{"start": 2.0, "end": 4.0, **C}, {"start": 6.0, "end": 8.0, **F}]
    assert client.patch(f"/api/jobs/{JOB}/chords", json={"chords": gapped}).status_code == 200
    stored = chord_files.read_user(_stems(jobs_dir))
    assert _shape(stored) == [(0.0, 2.0, None), (2.0, 4.0, 0), (4.0, 6.0, None), (6.0, 8.0, 5)]


def test_corrections_can_be_written_for_a_song_that_was_never_detected(client, jobs_dir):
    _song(jobs_dir)
    assert (
        client.patch(f"/api/jobs/{JOB}/chords", json={"chords": _edit((16.0, C))}).status_code
        == 200
    )
    body = client.get(f"/api/jobs/{JOB}/chords").json()
    assert body["source"] == "user" and body["has_detected"] is False and body["engine"] is None
    # Asked for by name, the detection is not there.
    assert client.get(f"/api/jobs/{JOB}/chords?source=detected").status_code == 404
    assert client.delete(f"/api/jobs/{JOB}/chords").json()["has_detected"] is False
    assert client.get(f"/api/jobs/{JOB}/chords").status_code == 404


SECRET = "launch-codes-1234"


@pytest.mark.parametrize(
    "body",
    [
        {"chords": "C F G"},
        {"chords": [{"start": 0, "end": 4, "root": 12, "degrees": ["1"]}]},
        {"chords": [{"start": 0, "end": 4, "root": SECRET, "degrees": ["1"]}]},
        {"chords": [{"start": 0, "end": 4, "root": 0, "degrees": [SECRET]}]},
        {"chords": [{"start": 0, "end": 4, "root": 0, "degrees": ["1"], "bass": 99}]},
        {"chords": [{"start": 4, "end": 0, "root": 0, "degrees": ["1"]}]},
        {"chords": [{"start": SECRET, "end": 4, "root": 0, "degrees": ["1"]}]},
        {
            "chords": [
                {"start": 0, "end": 4, "root": 0, "degrees": ["1"]},
                {"start": 2, "end": 6, "root": 5, "degrees": ["1"]},
            ]
        },
        {"chords": [{"start": i, "end": i + 1, "root": 0, "degrees": ["1"]} for i in range(5001)]},
        {"timeline": []},
        [],
        SECRET,
    ],
)
def test_an_invalid_correction_is_refused_without_repeating_it(client, jobs_dir, body):
    _song(jobs_dir)
    _store(jobs_dir)
    r = client.patch(f"/api/jobs/{JOB}/chords", json=body)
    assert r.status_code == 422, r.text
    assert SECRET not in r.text
    assert not (_stems(jobs_dir) / "chords.user.json").exists()
    assert client.get(f"/api/jobs/{JOB}/chords").json()["edited"] is False


@pytest.mark.parametrize(
    "raw",
    [
        b"{not json",
        b'{"chords": [{"start": 0, "end": NaN, "root": 0, "degrees": ["1"]}]}',
        b'{"chords": [{"start": 0, "end": Infinity, "root": 0, "degrees": ["1"]}]}',
        b"\xff\xfe",
        b"",
    ],
)
def test_a_body_that_is_not_json_is_refused_cleanly(client, jobs_dir, raw):
    _song(jobs_dir)
    r = client.patch(
        f"/api/jobs/{JOB}/chords", content=raw, headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "invalid JSON body"


def test_a_body_far_too_large_is_refused_before_it_is_parsed(client, jobs_dir):
    _song(jobs_dir)
    raw = b'{"chords": [' + b" " * (2 * 1024 * 1024) + b"]}"
    r = client.patch(
        f"/api/jobs/{JOB}/chords", content=raw, headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 413


def test_the_chords_go_with_the_song(client, jobs_dir):
    _song(jobs_dir)
    _store(jobs_dir)
    client.patch(f"/api/jobs/{JOB}/chords", json={"chords": _edit((16.0, C))})
    assert client.delete(f"/api/jobs/{JOB}").status_code == 200
    assert not (jobs_dir / JOB).exists()


def test_the_state_of_a_song_survives_a_restart(client, jobs_dir, monkeypatch):
    job = _song(jobs_dir)
    monkeypatch.setattr(api, "detect_chords", _fake_run())
    client.post(f"/api/jobs/{JOB}/chords")
    back = Job.from_record(job.to_record())
    assert back.chords == "done" and back.chords_reason is None
    # The file is on disk, not in the record.
    _jobs[JOB] = back
    assert len(client.get(f"/api/jobs/{JOB}/chords").json()["chords"]) == 4
