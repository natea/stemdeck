"""Stem transcription below the HTTP layer: the routing table, reason codes,
job state, the conversions from each model's output to notes, the worker and
its parent. No real model runs here except CREPE, whose weights ship in its
package and need no download.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import mido
import numpy as np
import pytest

from app.core import model_cache, transcription_outcome
from app.core.config import STEM_NAMES, TRANSCRIBE_ROUTES, TRANSCRIBERS, transcribe_routes
from app.core.models import Job
from app.core.transcription_files import notes_path, read_notes, transcribed_stems, write_notes
from app.pipeline import notes as notes_mod
from app.pipeline import notes_adapters as adapters
from app.pipeline import notes_worker as worker

JOB = "a1b2c3d4e5f6"


# -- routing ----------------------------------------------------------------


def test_every_stem_is_routed_to_a_known_transcriber():
    for stem in (*STEM_NAMES, "lead_vocals", "backing_vocals"):
        assert TRANSCRIBE_ROUTES[stem] in TRANSCRIBERS


def test_the_default_table():
    routes = transcribe_routes({})
    assert routes == {
        "vocals": "crepe",
        "lead_vocals": "crepe",
        "bass": "crepe",
        "piano": "piano",
        "guitar": "mt3",
        "other": "mt3",
        "backing_vocals": "mt3",
        "drums": "mt3",
    }


def test_one_environment_variable_reroutes_a_stem():
    routes = transcribe_routes({"STEMDECK_TRANSCRIBE_PIANO": "mt3"})
    assert routes["piano"] == "mt3"
    assert routes["bass"] == "crepe"


def test_an_override_that_names_no_transcriber_is_ignored():
    assert transcribe_routes({"STEMDECK_TRANSCRIBE_BASS": "basic-pitch"})["bass"] == "crepe"
    assert transcribe_routes({"STEMDECK_TRANSCRIBE_BASS": "  MT3 "})["bass"] == "mt3"


# -- reason codes -----------------------------------------------------------


def test_every_code_has_a_message():
    for code in transcription_outcome.CODES:
        message = transcription_outcome.message_for(code)
        assert message and message == transcription_outcome.MESSAGES[code]
    assert transcription_outcome.message_for(None) is None
    # An unknown code never leaks: it reads as the generic failure.
    assert (
        transcription_outcome.message_for("nope") == transcription_outcome.MESSAGES["worker_failed"]
    )


def test_the_no_beat_grid_message_names_the_beat_grid():
    assert "beat grid" in transcription_outcome.message_for("no_beat_grid")


# -- job state --------------------------------------------------------------


def test_transcription_state_round_trips_through_the_record():
    job = Job(id=JOB, status="done")
    job.transcription = "done"
    job.transcription_stems = {
        "bass": {"status": "done", "notes": 12, "code": None, "transcriber": "crepe"}
    }
    back = Job.from_record(job.to_record())
    assert back.transcription == "done"
    assert back.transcription_stems == job.transcription_stems
    state = back.to_state()
    assert state["transcription"] == "done"
    assert state["transcription_stems"]["bass"]["notes"] == 12
    assert state["transcription_reason"] is None and state["transcription_message"] is None


def test_a_new_job_has_no_transcription():
    state = Job(id=JOB).to_state()
    assert state["transcription"] == "none"
    assert state["transcription_stems"] == {}


def test_a_running_transcription_makes_the_song_busy():
    job = Job(id=JOB, status="done")
    assert not job.post_hoc_running()
    job.transcription = "running"
    assert job.post_hoc_running()


def test_a_restart_during_a_run_reads_as_interrupted():
    job = Job(id=JOB, status="done", stage_message="Transcribing stems...")
    job.transcription = "running"
    back = Job.from_record(job.to_record())
    assert back.transcription == "error"
    assert back.transcription_reason == "interrupted"
    assert back.stage_message == "Done"
    assert "closed before" in back.to_state()["transcription_message"]


def test_a_damaged_stems_record_is_dropped():
    record = Job(id=JOB, status="done").to_record()
    record["transcription_stems"] = ["not", "a", "dict"]
    assert Job.from_record(record).transcription_stems is None


# -- storage ----------------------------------------------------------------


def test_notes_are_written_whole_and_read_back(tmp_path):
    stems = tmp_path / "stems"
    stems.mkdir()
    notes = [{"start": 0.5, "end": 1.0, "pitch": 40, "velocity": 90}]
    path = write_notes(stems, "bass", transcriber="crepe", model="m", duration=3.21, notes=notes)
    assert path == notes_path(stems, "bass")
    record = read_notes(stems, "bass")
    assert record["notes"] == notes
    assert record["transcriber"] == "crepe" and record["stem"] == "bass"
    assert transcribed_stems(stems) == ["bass"]
    assert [p.name for p in path.parent.iterdir()] == ["bass.json"]  # no temp file left


def test_transcribing_again_replaces_that_stem_only(tmp_path):
    stems = tmp_path / "stems"
    stems.mkdir()
    write_notes(stems, "bass", transcriber="crepe", model="m", duration=1, notes=[{"pitch": 1}])
    write_notes(stems, "piano", transcriber="piano", model="m", duration=1, notes=[{"pitch": 2}])
    write_notes(stems, "bass", transcriber="crepe", model="m", duration=1, notes=[{"pitch": 3}])
    assert read_notes(stems, "bass")["notes"] == [{"pitch": 3}]
    assert read_notes(stems, "piano")["notes"] == [{"pitch": 2}]


def test_a_damaged_file_reads_as_not_transcribed(tmp_path):
    stems = tmp_path / "stems"
    (stems / "transcription").mkdir(parents=True)
    (stems / "transcription" / "bass.json").write_text("{not json", encoding="utf-8")
    (stems / "transcription" / "piano.json").write_text('{"notes": 3}', encoding="utf-8")
    assert read_notes(stems, "bass") is None
    assert read_notes(stems, "piano") is None
    assert read_notes(stems, "drums") is None


# -- conversions ------------------------------------------------------------


def test_piano_events_become_notes():
    events = [
        {"onset_time": 1.0, "offset_time": 1.5, "midi_note": 60, "velocity": 70},
        {"onset_time": 0.5, "offset_time": 0.9, "midi_note": 64, "velocity": 300},
        {"onset_time": 2.0, "offset_time": 2.0, "midi_note": 62, "velocity": 50},  # no length
        {"onset_time": 2.0, "offset_time": 2.5, "midi_note": 12, "velocity": 50},  # below the 88
        {"onset_time": 9.5, "offset_time": 11.0, "midi_note": 72, "velocity": 0},  # past the end
    ]
    notes = adapters.piano_events_to_notes(events, duration=10.0)
    assert notes == [
        {"start": 0.5, "end": 0.9, "pitch": 64, "velocity": 127},
        {"start": 1.0, "end": 1.5, "pitch": 60, "velocity": 70},
        {"start": 9.5, "end": 10.0, "pitch": 72, "velocity": 1},
    ]


def _midi(tracks: list[list[tuple]]) -> mido.MidiFile:
    """A MidiFile at 120 BPM / 480 PPQ (960 ticks per second) from
    (delta ticks, type, channel, note, velocity) tuples."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    for events in tracks:
        track = mido.MidiTrack()
        for delta, kind, channel, note, velocity in events:
            track.append(
                mido.Message(kind, channel=channel, note=note, velocity=velocity, time=delta)
            )
        mid.tracks.append(track)
    return mid


def test_a_pitched_stem_merges_every_program_and_drops_percussion():
    mid = _midi(
        [
            [(0, "note_on", 0, 60, 90), (480, "note_off", 0, 60, 0)],
            [(960, "note_on", 3, 67, 80), (480, "note_off", 3, 67, 0)],
            [(0, "note_on", 9, 36, 100), (96, "note_off", 9, 36, 0)],
        ]
    )
    notes = adapters.midi_to_notes(mid, drums=False)
    assert [(n["pitch"], n["start"], n["end"]) for n in notes] == [(60, 0.0, 0.5), (67, 1.0, 1.5)]


def test_the_drums_stem_keeps_only_percussion_keys():
    mid = _midi(
        [
            [(0, "note_on", 0, 60, 90), (480, "note_off", 0, 60, 0)],
            [(0, "note_on", 9, 36, 100), (480, "note_on", 9, 38, 90), (480, "note_on", 9, 36, 80)],
        ]
    )
    notes = adapters.midi_to_notes(mid, drums=True)
    assert [(n["pitch"], n["start"]) for n in notes] == [(36, 0.0), (38, 0.5), (36, 1.0)]
    assert all(n["end"] > n["start"] for n in notes)


def test_the_same_pitch_from_two_programs_at_once_is_one_note():
    mid = _midi(
        [
            [(0, "note_on", 0, 60, 70), (960, "note_off", 0, 60, 0)],
            [(480, "note_on", 1, 60, 100), (960, "note_off", 1, 60, 0)],
        ]
    )
    (note,) = adapters.midi_to_notes(mid, drums=False)
    assert (note["start"], note["end"], note["velocity"]) == (0.0, 1.5, 100)


def test_velocity_zero_note_on_is_a_release_and_an_unreleased_note_ends_with_the_file():
    mid = _midi(
        [[(0, "note_on", 0, 60, 90), (480, "note_on", 0, 60, 0), (0, "note_on", 0, 62, 90)]]
    )
    mid.tracks[0].append(mido.MetaMessage("end_of_track", time=480))
    notes = adapters.midi_to_notes(mid, drums=False)
    assert [(n["pitch"], n["start"], n["end"]) for n in notes] == [(60, 0.0, 0.5), (62, 0.5, 1.0)]


def test_a_tempo_change_in_the_file_is_followed():
    mid = _midi([[(480, "note_on", 0, 60, 90), (480, "note_off", 0, 60, 0)]])
    mid.tracks[0].insert(0, mido.MetaMessage("set_tempo", tempo=1_000_000, time=0))  # 60 BPM
    (note,) = adapters.midi_to_notes(mid, drums=False)
    assert (note["start"], note["end"]) == (1.0, 2.0)


def test_midi_round_trips_through_bytes():
    buf = io.BytesIO()
    _midi([[(0, "note_on", 0, 60, 90), (480, "note_off", 0, 60, 0)]]).save(file=buf)
    notes = adapters.midi_to_notes(mido.MidiFile(file=io.BytesIO(buf.getvalue())), drums=False)
    assert len(notes) == 1


# -- weights ----------------------------------------------------------------


@pytest.fixture
def models_dir(tmp_path, monkeypatch):
    root = tmp_path / "models"
    monkeypatch.setattr(adapters, "MODELS_DIR", root)
    return root


def test_a_truncated_checkpoint_is_refetched(models_dir, monkeypatch):
    """A file that is on disk but is not the published one is dropped and
    fetched again, instead of failing every load from then on (#502)."""
    good = b"the whole checkpoint"
    import hashlib

    monkeypatch.setattr(adapters, "TRANSCRIBE_PIANO_MD5", hashlib.md5(good).hexdigest())
    path = adapters.piano_checkpoint_path()
    path.parent.mkdir(parents=True)
    path.write_bytes(good[:7])
    calls: list[str] = []

    def fetch(url, dest, expected):
        calls.append(url)
        dest.write_bytes(good)

    assert adapters.ensure_piano_checkpoint(fetch) == path
    assert len(calls) == 1 and path.read_bytes() == good
    # Verified once: the next call neither fetches nor hashes again.
    monkeypatch.setattr(adapters, "_file_hash", lambda *a: pytest.fail("hashed twice"))
    assert adapters.ensure_piano_checkpoint(fetch) == path
    assert len(calls) == 1


def test_a_download_that_never_verifies_is_model_unavailable(models_dir):
    def fetch(url, dest, expected):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"an error page")

    with pytest.raises(adapters.ModelUnavailable):
        adapters.ensure_piano_checkpoint(fetch)
    assert not adapters.piano_checkpoint_path().exists()


def test_the_mt3_checkpoint_follows_the_same_rule(models_dir, monkeypatch):
    import hashlib

    good = b"mt3 weights"
    monkeypatch.setattr(adapters, "TRANSCRIBE_MT3_SHA256", hashlib.sha256(good).hexdigest())
    path = adapters.mt3_checkpoint_path()
    # mt3-infer reads the model variant from the checkpoint's folder name.
    assert "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops" in str(path)

    def fetch(dest):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(good)

    assert adapters.ensure_mt3_checkpoint(fetch) == path


def test_a_marker_for_another_file_does_not_vouch_for_this_one(models_dir, monkeypatch):
    import hashlib

    good = b"the whole checkpoint"
    monkeypatch.setattr(adapters, "TRANSCRIBE_PIANO_MD5", hashlib.md5(good).hexdigest())
    path = adapters.piano_checkpoint_path()
    path.parent.mkdir(parents=True)
    path.write_bytes(good)
    assert adapters.ensure_piano_checkpoint(lambda *a: pytest.fail("fetched")) == path
    # Replaced by something of another size after it was verified.
    path.write_bytes(b"short")
    fetched: list[int] = []

    def fetch(url, dest, expected):
        fetched.append(1)
        dest.write_bytes(good)

    adapters.ensure_piano_checkpoint(fetch)
    assert fetched == [1]


def test_the_checkpoint_paths_and_their_markers(tmp_path):
    piano = model_cache.transcription_artifacts(tmp_path, "piano")
    mt3 = model_cache.transcription_artifacts(tmp_path, "mt3")
    assert piano[0].name.endswith(".pth") and piano[1].name.endswith(".pth.verified")
    assert mt3[0].name == "last.ckpt" and mt3[1].name == "last.ckpt.verified"
    assert model_cache.transcription_artifacts(tmp_path, "crepe") == []
    assert all(p.is_relative_to(tmp_path) for p in (*piano, *mt3))


def test_a_failed_load_never_deletes_a_verified_checkpoint(fake_stems, models_dir, monkeypatch):
    """A load that fails for a reason a fresh download cannot fix (here, the
    GPU lacks an operator) must leave the checkpoint alone. It is verified by
    hash before loading, so it is not the problem."""
    path = adapters.mt3_checkpoint_path()
    path.parent.mkdir(parents=True)
    path.write_bytes(b"verified weights")
    shy = _Fake("mt3", fail_on=("mps", "cpu"))
    outcomes = worker.run(
        "mps", fake_stems, ["guitar"], transcribers=_factories(mt3=shy), decode=_decode_loud
    )
    assert outcomes["guitar"]["status"] == "error"
    assert path.read_bytes() == b"verified weights"


# -- CREPE, for real --------------------------------------------------------


def test_crepe_transcribes_a_generated_bass_line():
    """A generated bass-range tone sequence comes back as monophonic notes of
    the right pitches. CREPE's weights are in its package: no download."""
    pytest.importorskip("torchcrepe")
    sr = adapters.PITCH_SR

    def tone(midi: int, seconds: float) -> np.ndarray:
        t = np.arange(int(seconds * sr)) / sr
        f = 440.0 * 2 ** ((midi - 69) / 12)
        env = np.minimum(1.0, t / 0.01) * np.exp(-t * 1.5)
        return (0.5 * env * (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t))).astype(
            np.float32
        )

    sequence = [40, 43, 45, 40, 40, 47]
    audio = np.concatenate(
        [
            np.zeros(sr // 4, np.float32),
            *(tone(m, 0.5) for m in sequence),
            np.zeros(sr // 2, np.float32),
        ]
    )
    transcriber = adapters.CrepeTranscriber()
    transcriber.load("cpu")
    notes = transcriber.transcribe(audio, "bass")
    assert [n["pitch"] for n in notes] == sequence
    for a, b in zip(notes, notes[1:], strict=False):
        assert a["end"] <= b["start"]
    for note, expected in zip(notes, (0.25 + 0.5 * i for i in range(6)), strict=True):
        assert abs(note["start"] - expected) <= 0.06


def test_piano_adapter_maps_the_models_events(monkeypatch):
    """With the model mocked: its note events become stored notes."""

    class FakeModel:
        def transcribe(self, audio, midi_path):
            assert midi_path.endswith(".mid")
            return {
                "est_note_events": [
                    {"onset_time": 0.25, "offset_time": 1.0, "midi_note": 60, "velocity": 64}
                ]
            }

    transcriber = adapters.PianoTranscriber()
    transcriber._model = FakeModel()
    notes = transcriber.transcribe(np.zeros(adapters.MODEL_SR * 2, np.float32), "piano")
    assert notes == [{"start": 0.25, "end": 1.0, "pitch": 60, "velocity": 64}]


def test_mt3_adapter_maps_pitched_and_drum_stems(monkeypatch):
    """With the model mocked: programs are merged for a pitched stem, and the
    drums stem keeps the percussion channel as GM keys."""
    mid = _midi(
        [
            [(0, "note_on", 2, 55, 90), (480, "note_off", 2, 55, 0)],
            [(0, "note_on", 9, 42, 100), (96, "note_off", 9, 42, 0)],
        ]
    )

    class FakeModel:
        def transcribe(self, audio, sr):
            assert sr == adapters.MODEL_SR
            return mid

    transcriber = adapters.Mt3Transcriber()
    transcriber._model = FakeModel()
    audio = np.zeros(adapters.MODEL_SR * 2, np.float32)
    assert [n["pitch"] for n in transcriber.transcribe(audio, "guitar")] == [55]
    assert [n["pitch"] for n in transcriber.transcribe(audio, "drums")] == [42]


def test_yourmt3_never_runs_on_mps(monkeypatch, models_dir):
    """MPS is three times slower than the CPU for this model and hangs on
    exit, so a Mac's GPU choice is answered with the CPU. CUDA is kept."""
    assert adapters.mt3_device("mps") == "cpu"
    assert adapters.mt3_device("cuda") == "cuda"
    assert adapters.mt3_device("cpu") == "cpu"

    import sys
    import types

    seen = {}
    fake = types.ModuleType("mt3_infer")
    fake.load_model = lambda name, **kwargs: seen.update(name=name, **kwargs) or object()
    monkeypatch.setitem(sys.modules, "mt3_infer", fake)
    monkeypatch.setattr(adapters, "ensure_mt3_checkpoint", lambda: models_dir / "last.ckpt")
    adapters.Mt3Transcriber().load("mps")
    assert seen["device"] == "cpu" and seen["name"] == "yourmt3"
    assert seen["auto_download"] is False and seen["cache"] is False


# -- worker, with fake transcribers ------------------------------------------


class _Fake:
    sample_rate = 16000
    model = "fake"

    def __init__(self, name, *, fail_load=None, fail_on=(), fail_stems=()):
        self.name = name
        self._fail_load = fail_load
        self._fail_on = fail_on
        self._fail_stems = fail_stems
        self.device = None

    def load(self, device):
        if self._fail_load is not None:
            raise self._fail_load
        if device in self._fail_on:
            raise RuntimeError(f"operator not implemented on {device}")
        self.device = device
        _Fake.loaded.append((self.name, device))

    def transcribe(self, audio, stem):
        if stem in self._fail_stems:
            raise RuntimeError("decoder blew up")
        return [{"start": 0.0, "end": 0.5, "pitch": 60 + len(stem), "velocity": 80}]


@pytest.fixture
def fake_stems(tmp_path):
    _Fake.loaded = []
    stems = tmp_path / "stems"
    stems.mkdir()
    for name in ("bass", "piano", "guitar", "drums"):
        (stems / f"{name}.wav").write_bytes(b"RIFF")
    return stems


def _decode_loud(path, sample_rate):
    return np.full(sample_rate, 0.3, np.float32)


def _factories(**overrides):
    def make(name):
        return lambda: overrides.get(name) or _Fake(name)

    return {name: make(name) for name in ("crepe", "piano", "mt3")}


def test_the_worker_writes_a_file_per_stem_and_loads_each_model_once(fake_stems, capfd):
    outcomes = worker.run(
        "cpu",
        fake_stems,
        ["guitar", "bass", "drums", "piano"],
        transcribers=_factories(),
        decode=_decode_loud,
    )
    assert {s: o["status"] for s, o in outcomes.items()} == dict.fromkeys(
        ("guitar", "bass", "drums", "piano"), "done"
    )
    assert transcribed_stems(fake_stems) == ["bass", "drums", "guitar", "piano"]
    assert read_notes(fake_stems, "bass")["transcriber"] == "crepe"
    assert read_notes(fake_stems, "drums")["transcriber"] == "mt3"
    # guitar and drums share one mt3 load, and the cheap transcriber goes first.
    assert _Fake.loaded == [("crepe", "cpu"), ("piano", "cpu"), ("mt3", "cpu")]
    lines = [ln for ln in capfd.readouterr().err.splitlines() if ln.startswith("@@STEM@@")]
    reported = [json.loads(ln[len("@@STEM@@") :]) for ln in lines]
    assert sorted(r["stem"] for r in reported) == ["bass", "drums", "guitar", "piano"]
    assert all(r["status"] == "done" and r["notes"] == 1 and r["code"] is None for r in reported)


def test_one_model_failing_to_load_costs_only_its_stems(fake_stems):
    broken = _Fake("piano", fail_load=adapters.ModelUnavailable("failed to download"))
    outcomes = worker.run(
        "cpu",
        fake_stems,
        ["bass", "piano"],
        transcribers=_factories(piano=broken),
        decode=_decode_loud,
    )
    assert outcomes["bass"]["status"] == "done"
    assert outcomes["piano"] == {
        "status": "error",
        "notes": 0,
        "code": "model_unavailable",
        "transcriber": "piano",
    }
    assert transcribed_stems(fake_stems) == ["bass"]


def test_a_missing_package_is_a_missing_dependency(fake_stems):
    broken = _Fake("mt3", fail_load=ModuleNotFoundError("No module named 'mt3_infer'"))
    outcomes = worker.run(
        "cpu", fake_stems, ["guitar"], transcribers=_factories(mt3=broken), decode=_decode_loud
    )
    assert outcomes["guitar"]["code"] == "dependency_missing"


def test_a_silent_stem_is_skipped_without_loading_a_model(fake_stems):
    def decode(path, sample_rate):
        level = 0.0 if path.stem == "piano" else 0.3
        return np.full(sample_rate, level, np.float32)

    outcomes = worker.run(
        "cpu", fake_stems, ["bass", "piano"], transcribers=_factories(), decode=decode
    )
    assert outcomes["piano"]["status"] == "skipped" and outcomes["piano"]["code"] is None
    record = read_notes(fake_stems, "piano")
    assert record["skipped"] == "silent" and record["notes"] == []
    assert ("piano", "cpu") not in _Fake.loaded
    assert outcomes["bass"]["status"] == "done"


def test_a_model_that_will_not_load_on_the_gpu_falls_back_to_the_cpu(fake_stems):
    shy = _Fake("mt3", fail_on=("mps",))
    outcomes = worker.run(
        "mps", fake_stems, ["guitar"], transcribers=_factories(mt3=shy), decode=_decode_loud
    )
    assert outcomes["guitar"]["status"] == "done"
    assert _Fake.loaded == [("mt3", "cpu")]


def test_one_stem_failing_leaves_the_other_stems_of_that_model(fake_stems):
    flaky = _Fake("mt3", fail_stems=("guitar",))
    outcomes = worker.run(
        "cpu",
        fake_stems,
        ["guitar", "drums"],
        transcribers={**_factories(), "mt3": lambda: flaky},
        decode=_decode_loud,
    )
    assert outcomes["guitar"]["status"] == "error" and outcomes["guitar"]["code"] == "worker_failed"
    assert outcomes["drums"]["status"] == "done"
    assert transcribed_stems(fake_stems) == ["drums"]


def test_an_unreadable_stem_and_an_unrouted_one_are_errors(fake_stems):
    outcomes = worker.run(
        "cpu",
        fake_stems,
        ["bass", "kazoo"],
        transcribers=_factories(),
        decode=lambda path, sample_rate: None,
    )
    assert outcomes["bass"]["status"] == "error"
    assert outcomes["kazoo"]["status"] == "error"
    assert transcribed_stems(fake_stems) == []


# -- parent, against stub workers --------------------------------------------

_OK_WORKER = """
import sys, json
for stem in sys.argv[3].split(","):
    sys.stderr.write("loading something\\n")
    sys.stderr.write("@@STEM@@" + json.dumps({"stem": stem, "status": "done", "notes": 3,
        "code": None, "transcriber": "crepe"}) + "\\n")
sys.stderr.write("@@DONE@@\\n"); sys.stderr.flush()
"""

_PARTIAL_WORKER = """
import sys, json
sys.stderr.write("@@STEM@@" + json.dumps({"stem": "bass", "status": "done", "notes": 3,
    "code": None, "transcriber": "crepe"}) + "\\n")
sys.stderr.write("@@STEM@@" + json.dumps({"stem": "piano", "status": "error", "notes": 0,
    "code": "model_unavailable", "transcriber": "piano"}) + "\\n")
sys.stderr.write("@@DONE@@\\n"); sys.stderr.flush()
"""

_FATAL_WORKER = """
import sys, json
sys.stderr.write("@@STEM@@" + json.dumps({"stem": "bass", "status": "done", "notes": 3,
    "code": None, "transcriber": "crepe"}) + "\\n")
sys.stderr.write("@@ERROR@@" + json.dumps({"message": "boom", "code": "out_of_memory"}) + "\\n")
sys.stderr.flush(); sys.exit(1)
"""

_CRASH_WORKER = "import sys; sys.stderr.write('Killed\\n'); sys.exit(137)"

_HANG_WORKER = """
import sys, json, time
sys.stderr.write("@@STEM@@" + json.dumps({"stem": "bass", "status": "done", "notes": 3,
    "code": None, "transcriber": "crepe"}) + "\\n")
sys.stderr.flush()
time.sleep(60)
"""

_GARBAGE_WORKER = """
import sys
sys.stderr.write("@@STEM@@{not json\\n")
sys.stderr.write('@@STEM@@{"stem": "bass", "status": "weird"}\\n')
sys.stderr.write('@@STEM@@{"stem": "piano", "status": "error", "code": "made-up"}\\n')
sys.stderr.write("@@DONE@@\\n"); sys.stderr.flush()
"""


def _stub(code: str):
    def fake_spawn(device: str, stems_dir: Path, names: list[str]) -> list[str]:
        return [sys.executable, "-c", code, device, str(stems_dir), ",".join(names)]

    return fake_spawn


@pytest.fixture
def parent(monkeypatch, tmp_path):
    monkeypatch.setattr(notes_mod, "get_demucs_device", lambda: "cpu")
    stems = tmp_path / "stems"
    stems.mkdir()

    def run(code: str, names=("bass", "piano"), job: Job | None = None):
        monkeypatch.setattr(notes_mod, "_spawn_cmd", _stub(code))
        return notes_mod.transcribe_stems(job or Job(id=JOB, status="done"), stems, list(names))

    return run


def test_the_parent_returns_each_stems_outcome(parent):
    outcomes = parent(_OK_WORKER)
    assert outcomes == {
        name: {"status": "done", "notes": 3, "code": None, "transcriber": "crepe"}
        for name in ("bass", "piano")
    }


_PROGRESS_WORKER = """
import sys, json, time
def say(tag, obj):
    sys.stderr.write(tag + json.dumps(obj) + "\\n"); sys.stderr.flush()
say("@@PROGRESS@@", {"stem": "bass", "phase": "downloading", "percent": 40})
time.sleep(0.4)
say("@@PROGRESS@@", {"stem": "bass", "phase": "transcribing", "percent": None})
time.sleep(0.4)
say("@@STEM@@", {"stem": "bass", "status": "done", "notes": 3, "code": None, "transcriber": "crepe"})
say("@@PROGRESS@@", {"stem": "piano", "phase": "loading", "percent": None})
say("@@PROGRESS@@", {"stem": "kazoo", "phase": "loading", "percent": None})
sys.stderr.write("@@PROGRESS@@{not json\\n")
say("@@PROGRESS@@", {"stem": "piano", "phase": "made-up", "percent": 900})
time.sleep(0.4)
say("@@STEM@@", {"stem": "piano", "status": "done", "notes": 1, "code": None, "transcriber": "piano"})
sys.stderr.write("@@DONE@@\\n"); sys.stderr.flush()
"""


def test_the_run_reports_where_it_is_while_it_runs(parent):
    import threading

    job = Job(id=JOB, status="done")
    job.transcription = "running"
    seen: list[dict] = []
    stop = threading.Event()

    def watch():
        while not stop.wait(0.05):
            p = job.transcription_progress
            if p is not None and (not seen or seen[-1] != p):
                seen.append(dict(p))

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        outcomes = parent(_PROGRESS_WORKER, job=job)
    finally:
        stop.set()
        watcher.join(2)
    assert outcomes["bass"]["status"] == outcomes["piano"]["status"] == "done"
    steps = [(p["stem"], p["phase"], p["percent"], p["done"], p["finished"]) for p in seen]
    assert ("bass", "downloading", 40, 0, []) in steps
    assert ("bass", "transcribing", None, 0, []) in steps
    # An unknown phase reads as transcribing and a wild percent is dropped;
    # a stem that is not in the run, and a line that is not JSON, are ignored.
    assert ("piano", "transcribing", None, 1, ["bass"]) in steps
    assert all(p["stem"] != "kazoo" for p in seen)
    assert all(p["stems"] == ["bass", "piano"] and p["total"] == 2 for p in seen)
    # Nothing is left behind when the run is over.
    assert job.transcription_progress is None


def test_progress_is_shown_only_while_running_and_never_saved():
    job = Job(id=JOB, status="done")
    job.transcription_progress = {"stems": ["bass"], "stem": "bass", "phase": "loading"}
    assert job.to_state()["transcription_progress"] is None
    job.transcription = "running"
    assert job.to_state()["transcription_progress"]["phase"] == "loading"
    assert "transcription_progress" not in job.to_record()
    assert Job.from_record(job.to_record()).transcription_progress is None


def test_the_worker_says_what_it_is_doing_to_each_stem(fake_stems, capfd):
    worker.run(
        "cpu", fake_stems, ["bass", "guitar"], transcribers=_factories(), decode=_decode_loud
    )
    lines = [
        json.loads(ln[len("@@PROGRESS@@") :])
        for ln in capfd.readouterr().err.splitlines()
        if ln.startswith("@@PROGRESS@@")
    ]
    assert [(p["stem"], p["phase"]) for p in lines] == [
        ("bass", "loading"),
        ("bass", "transcribing"),
        ("guitar", "loading"),
        ("guitar", "transcribing"),
    ]


def test_a_download_reports_its_percent_through_the_hook(models_dir, monkeypatch):
    import hashlib

    good = b"x" * 1000
    monkeypatch.setattr(adapters, "TRANSCRIBE_PIANO_MD5", hashlib.md5(good).hexdigest())
    seen: list[tuple] = []
    monkeypatch.setattr(
        adapters, "progress_hook", lambda phase, percent: seen.append((phase, percent))
    )

    def fetch(url, dest, expected):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(good)

    adapters.ensure_piano_checkpoint(fetch)
    assert seen and seen[0] == ("downloading", 0)

    def broken(phase, percent):
        raise RuntimeError("hook blew up")

    # A failing hook never costs the run.
    monkeypatch.setattr(adapters, "progress_hook", broken)
    adapters._progress("loading")


def test_a_failed_stem_is_an_outcome_not_an_exception(parent):
    outcomes = parent(_PARTIAL_WORKER)
    assert outcomes["bass"]["status"] == "done"
    assert outcomes["piano"]["status"] == "error"
    assert outcomes["piano"]["code"] == "model_unavailable"


def test_a_fatal_error_carries_its_code_and_the_stems_already_done(parent):
    with pytest.raises(notes_mod.TranscriptionError) as exc_info:
        parent(_FATAL_WORKER)
    assert exc_info.value.code == "out_of_memory"
    assert exc_info.value.outcomes["bass"]["status"] == "done"
    assert "piano" not in exc_info.value.outcomes


def test_a_worker_that_dies_without_a_word_is_a_worker_failure(parent):
    with pytest.raises(notes_mod.TranscriptionError) as exc_info:
        parent(_CRASH_WORKER)
    assert exc_info.value.code == "worker_failed"
    assert exc_info.value.tail == ["Killed"]


def test_a_stalled_worker_is_stopped_as_a_timeout(parent, monkeypatch):
    monkeypatch.setattr(notes_mod, "TIMEOUT_TRANSCRIPTION", 0.3)
    monkeypatch.setattr(notes_mod, "TRANSCRIPTION_WATCHDOG_POLL_SEC", 0.1)
    with pytest.raises(notes_mod.TranscriptionError) as exc_info:
        parent(_HANG_WORKER)
    assert exc_info.value.code == "timeout"
    assert exc_info.value.outcomes["bass"]["status"] == "done"


def test_a_cancel_is_reported_as_cancelled(parent, monkeypatch):
    import threading

    from app.core import registry

    job = Job(id=JOB, status="done")

    def cancel_soon():
        proc = None
        for _ in range(200):
            proc = registry.get_proc(JOB)
            if proc is not None:
                break
            threading.Event().wait(0.02)
        # Long enough for the stub to start and report its first stem.
        threading.Event().wait(1.0)
        job.cancel_requested = True
        if proc is not None:
            proc.terminate()

    threading.Thread(target=cancel_soon, daemon=True).start()
    with pytest.raises(notes_mod.TranscriptionError) as exc_info:
        parent(_HANG_WORKER, job=job)
    assert exc_info.value.code == "cancelled"
    assert exc_info.value.outcomes["bass"]["status"] == "done"


def test_malformed_stem_lines_are_ignored_and_unknown_codes_never_leave(parent):
    outcomes = parent(_GARBAGE_WORKER)
    # "weird" is not a status, so bass was never reported: it did not happen.
    assert outcomes["bass"] == {
        "status": "error",
        "notes": 0,
        "code": "worker_failed",
        "transcriber": None,
    }
    assert outcomes["piano"]["code"] == "worker_failed"


def test_a_worker_that_cannot_start_is_a_worker_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(notes_mod, "get_demucs_device", lambda: "cpu")
    monkeypatch.setattr(
        notes_mod, "_spawn_cmd", lambda *a: [str(tmp_path / "no-such-python"), "-c", "pass"]
    )
    with pytest.raises(notes_mod.TranscriptionError) as exc_info:
        notes_mod.transcribe_stems(Job(id=JOB, status="done"), tmp_path, ["bass"])
    assert exc_info.value.code == "worker_failed"


def test_the_real_worker_reports_usage_as_an_error():
    import subprocess

    out = subprocess.run(
        [sys.executable, "-m", "app.pipeline.notes_worker"], capture_output=True, text=True
    )
    assert out.returncode == 1
    line = next(ln for ln in out.stderr.splitlines() if ln.startswith("@@ERROR@@"))
    assert json.loads(line[len("@@ERROR@@") :])["code"] == "worker_failed"
