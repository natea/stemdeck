"""The chord detection worker and its parent (app/pipeline/chords_worker.py,
app/pipeline/chords.py).

The worker runs here with a fake recogniser in place of the model, so these
tests need ffmpeg but no model. The model itself is run in
tests/test_chords_real_model.py, off by default. The first-use download of
the model's checkpoints runs here with a stand-in for app/core/model_fetch.py:
nothing in this file reaches the network.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import wave
from pathlib import Path

import numpy as np
import pytest

from app.core import chord_files, registry
from app.core.config import CHORDS_SAMPLE_RATE
from app.core.models import Job
from app.pipeline import chord_engine
from app.pipeline import chords as chords_mod
from app.pipeline import chords_worker as worker
from tests.ffmpeg_probe import skip_without_ffmpeg

JOB = "abcdef012345"
SR = 44100


def _write_tone(path: Path, hz: float, seconds: float = 2.0, level: float = 0.2) -> None:
    t = np.arange(int(seconds * SR)) / SR
    pcm = (np.sin(2 * np.pi * hz * t) * level * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(np.column_stack([pcm, pcm]).tobytes())


@pytest.fixture(autouse=True)
def _checkpoints_on_disk(monkeypatch):
    """The model's checkpoints count as downloaded, so no run here starts a
    download. The download's own tests say otherwise themselves."""
    monkeypatch.setattr(chord_engine, "missing_checkpoints", lambda: [])


@pytest.fixture
def stems(tmp_path):
    folder = tmp_path / "song" / "stems"
    folder.mkdir(parents=True)
    return folder


def _segments(*parts):
    out, at = [], 0.0
    for end, label in parts:
        out.append({"start_time": at, "end_time": end, "chord": label})
        at = end
    return out


class _Recogniser:
    """Stands in for lv-chordia: remembers what it was handed and answers
    with fixed segments."""

    def __init__(self, segments=None, *, fail: BaseException | None = None, chatter=()):
        self.segments = _segments((1.0, "C:maj"), (2.0, "G:7/3")) if segments is None else segments
        self.fail = fail
        self.chatter = chatter
        self.calls: list[tuple[str, str]] = []
        self.seen: dict = {}

    def __call__(self):
        def recognise(audio_path: str, vocabulary: str):
            self.calls.append((audio_path, vocabulary))
            path = Path(audio_path)
            self.seen = {"exists": path.is_file(), "absolute": path.is_absolute()}
            with open(audio_path, "rb") as handle:
                self.seen["header"] = handle.read(12)
            import soundfile

            info = soundfile.info(audio_path)
            self.seen.update(rate=info.samplerate, channels=info.channels, frames=info.frames)
            data, _ = soundfile.read(audio_path, dtype="float32")
            self.seen["peak"] = float(np.max(np.abs(data)))
            self.seen["spectrum"] = np.abs(np.fft.rfft(data[: info.samplerate]))
            for line in self.chatter:
                print(line, file=sys.stderr)
            if self.fail is not None:
                raise self.fail
            return self.segments

        return recognise


def _lines(capfd) -> list[str]:
    return [ln for ln in capfd.readouterr().err.splitlines() if ln.strip()]


def _progress(lines) -> list[dict]:
    return [json.loads(ln[len("@@PROGRESS@@") :]) for ln in lines if ln.startswith("@@PROGRESS@@")]


def _peak_hz(spectrum) -> int:
    # One second of audio was transformed, so bin n is n Hz.
    return int(np.argmax(spectrum))


# --- The worker ------------------------------------------------------------


def test_the_worker_writes_the_chord_file_and_cleans_up(stems, capfd):
    skip_without_ffmpeg()
    _write_tone(stems / "bass.wav", 110.0)
    _write_tone(stems / "piano.wav", 440.0)
    fake = _Recogniser()

    result = worker.run(stems, recogniser=fake, vocabulary="full", engine_version=lambda: "9.9")

    assert result == {"chords": 2, "named": 2, "lanes": ["bass", "piano"]}
    record = chord_files.read_detected(stems)
    assert record["engine"] == "lv-chordia" and record["engine_version"] == "9.9"
    assert record["vocabulary"] == "full"
    assert record["duration"] == pytest.approx(2.0, abs=0.02)
    assert [(c["start"], c["end"], c["root"], c["bass"], c["label"]) for c in record["chords"]] == [
        (0.0, 1.0, 0, None, "C:maj"),
        (1.0, 2.0, 7, 11, "G:7/3"),
    ]
    # Nothing but the song and its chords is left in the folder.
    assert sorted(p.name for p in stems.iterdir()) == ["bass.wav", "chords.json", "piano.wav"]


def test_the_model_is_handed_one_mono_file_by_its_absolute_path(stems):
    skip_without_ffmpeg()
    _write_tone(stems / "bass.wav", 110.0)
    _write_tone(stems / "piano.wav", 440.0)
    fake = _Recogniser()
    worker.run(stems, recogniser=fake, vocabulary="submission")

    ((path, vocabulary),) = fake.calls
    assert vocabulary == "submission"
    assert fake.seen["absolute"] and fake.seen["exists"]
    assert fake.seen["header"][:4] == b"RIFF" and fake.seen["header"][8:12] == b"WAVE"
    assert fake.seen["rate"] == CHORDS_SAMPLE_RATE and fake.seen["channels"] == 1
    # Inside the song's own folder, in a folder the startup sweep knows.
    assert Path(path).parent.parent == stems.resolve()
    assert Path(path).parent.name.startswith(".decode-")
    assert not Path(path).exists()


def test_every_lane_is_in_the_sum_and_the_original_lane_too(stems):
    skip_without_ffmpeg()
    # A song kept as vocals and bass, with the rest in the Original lane.
    _write_tone(stems / "vocals.wav", 880.0, level=0.1)
    _write_tone(stems / "bass.wav", 110.0, level=0.1)
    _write_tone(stems / "original.wav", 440.0, level=0.3)
    # Not part of the song a second time, and not the song at all.
    _write_tone(stems / "lead_vocals.wav", 2000.0, level=0.3)
    _write_tone(stems / "mix.wav", 3000.0, level=0.3)
    fake = _Recogniser()

    result = worker.run(stems, recogniser=fake)

    assert result["lanes"] == ["vocals", "bass", "original"]
    spectrum = fake.seen["spectrum"]
    assert _peak_hz(spectrum) == 440
    floor = float(np.median(spectrum)) + 1e-9
    for hz in (110, 440, 880):
        assert spectrum[hz] > 100 * floor, hz
    for hz in (2000, 3000):
        assert spectrum[hz] < spectrum[110] / 50, hz


def test_a_sum_louder_than_full_scale_is_not_clipped(stems):
    skip_without_ffmpeg()
    for name in ("vocals", "bass", "guitar"):
        _write_tone(stems / f"{name}.wav", 440.0, level=0.6)
    fake = _Recogniser()
    worker.run(stems, recogniser=fake)
    assert fake.seen["peak"] == pytest.approx(1.8, rel=0.05)


def test_a_song_of_one_stem_works(stems):
    skip_without_ffmpeg()
    _write_tone(stems / "other.wav", 330.0)
    fake = _Recogniser()
    assert worker.run(stems, recogniser=fake)["lanes"] == ["other"]
    assert _peak_hz(fake.seen["spectrum"]) == 330


def test_an_mp3_song_is_read_too(stems):
    skip_without_ffmpeg()
    from app.core.config import ffmpeg_executable

    _write_tone(stems / "tmp.wav", 440.0)
    subprocess.run(
        [ffmpeg_executable(), "-y", "-loglevel", "error", "-i", str(stems / "tmp.wav"),
         str(stems / "piano.mp3")],
        check=True,
    )  # fmt: skip
    (stems / "tmp.wav").unlink()
    fake = _Recogniser()
    assert worker.run(stems, recogniser=fake)["lanes"] == ["piano"]
    assert _peak_hz(fake.seen["spectrum"]) == 440


def test_the_worker_says_which_step_it_is_in(stems, capfd):
    skip_without_ffmpeg()
    _write_tone(stems / "bass.wav", 110.0)
    chatter = [f"Inference: model_s{i}.best on /private/secret/path/song.wav" for i in range(5)]
    worker.run(stems, recogniser=_Recogniser(chatter=[*chatter, "a plain log line"]))
    lines = _lines(capfd)
    steps = _progress(lines)
    assert [s["phase"] for s in steps] == [
        "mixing",
        "loading",
        "detecting",
        *["detecting"] * 5,
        "finishing",
    ]
    assert [s["percent"] for s in steps if s["phase"] == "detecting"] == [0, 0, 20, 40, 60, 80]
    # The model's own lines are not passed on with the path in them.
    assert not any("secret" in ln for ln in lines)
    assert "a plain log line" in lines


def test_a_song_with_no_audio_is_no_audio(stems, capfd):
    with pytest.raises(worker.ChordsFailure) as caught:
        worker.run(stems, recogniser=_Recogniser())
    assert caught.value.code == "no_audio"
    assert list(stems.iterdir()) == []

    with pytest.raises(worker.ChordsFailure) as caught:
        worker.run(stems / "nowhere", recogniser=_Recogniser())
    assert caught.value.code == "no_audio"


def test_audio_that_cannot_be_read_is_no_audio(stems):
    skip_without_ffmpeg()
    (stems / "bass.wav").write_bytes(b"RIFF not really a wav")
    with pytest.raises(worker.ChordsFailure) as caught:
        worker.run(stems, recogniser=_Recogniser())
    assert caught.value.code == "no_audio"
    assert sorted(p.name for p in stems.iterdir()) == ["bass.wav"]


def test_a_failure_leaves_the_earlier_chords_and_no_temp(stems):
    skip_without_ffmpeg()
    _write_tone(stems / "bass.wav", 110.0)
    worker.run(stems, recogniser=_Recogniser(_segments((2.0, "F:maj"))))
    before = (stems / "chords.json").read_bytes()

    with pytest.raises(RuntimeError):
        worker.run(stems, recogniser=_Recogniser(fail=RuntimeError("model exploded")))

    assert (stems / "chords.json").read_bytes() == before
    assert sorted(p.name for p in stems.iterdir()) == ["bass.wav", "chords.json"]


def test_a_song_with_no_chord_in_it_is_written_as_such(stems):
    skip_without_ffmpeg()
    _write_tone(stems / "drums.wav", 60.0)
    result = worker.run(stems, recogniser=_Recogniser(_segments((2.0, "N"))))
    assert result["named"] == 0 and result["chords"] == 1
    (entry,) = chord_files.read_detected(stems)["chords"]
    assert entry["root"] is None and entry["label"] == "N"


def test_the_timeline_covers_the_whole_song(stems):
    skip_without_ffmpeg()
    _write_tone(stems / "bass.wav", 110.0, seconds=3.0)
    # The model stopped a second early.
    worker.run(stems, recogniser=_Recogniser(_segments((0.5, "N"), (2.0, "C:maj"))))
    chords = chord_files.read_detected(stems)["chords"]
    assert [(c["start"], c["root"]) for c in chords] == [(0.0, None), (0.5, 0), (2.0, None)]
    assert chords[-1]["end"] == pytest.approx(3.0, abs=0.02)


def test_failures_are_given_a_reason():
    assert worker._code(MemoryError()) == "out_of_memory"
    assert worker._code(RuntimeError("CUDA out of memory. Tried to allocate")) == "out_of_memory"
    assert worker._code(ModuleNotFoundError("No module named 'lv_chordia'")) == "dependency_missing"
    assert worker._code(worker.ChordsFailure("no_audio", "x")) == "no_audio"
    assert worker._code(ValueError("anything else")) == "worker_failed"


# --- The model's files -----------------------------------------------------


def _fake_checkpoints(folder: Path, monkeypatch) -> dict[str, bytes]:
    import hashlib

    folder.mkdir(parents=True)
    files = {f"model_s{i}.best.sdict": f"weights {i}".encode() for i in range(3)}
    for name, data in files.items():
        (folder / name).write_bytes(data)
    monkeypatch.setattr(
        worker,
        "CHORDS_CHECKPOINT_SHA256",
        {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
    )
    return files


def test_checkpoints_that_match_their_hashes_pass(tmp_path, monkeypatch):
    folder = tmp_path / "cache_data"
    _fake_checkpoints(folder, monkeypatch)
    worker.verify_checkpoints(folder)


def test_a_changed_checkpoint_stops_the_run(tmp_path, monkeypatch):
    folder = tmp_path / "cache_data"
    _fake_checkpoints(folder, monkeypatch)
    (folder / "model_s1.best.sdict").write_bytes(b"something else")
    with pytest.raises(worker.ChordsFailure) as caught:
        worker.verify_checkpoints(folder)
    assert caught.value.code == "dependency_missing"
    assert "model_s1" in str(caught.value)


def test_a_missing_checkpoint_stops_the_run(tmp_path, monkeypatch):
    folder = tmp_path / "cache_data"
    _fake_checkpoints(folder, monkeypatch)
    (folder / "model_s2.best.sdict").unlink()
    with pytest.raises(worker.ChordsFailure) as caught:
        worker.verify_checkpoints(folder)
    assert caught.value.code == "dependency_missing"


def test_the_model_is_not_imported_when_its_files_do_not_verify(stems, tmp_path, monkeypatch):
    skip_without_ffmpeg()
    _write_tone(stems / "bass.wav", 110.0)
    monkeypatch.setattr(worker, "checkpoint_dir", lambda: tmp_path / "nothing-here")
    for name in [m for m in sys.modules if m == "lv_chordia" or m.startswith("lv_chordia.")]:
        monkeypatch.delitem(sys.modules, name)
    with pytest.raises(worker.ChordsFailure) as caught:
        worker.run(stems)
    assert caught.value.code == "dependency_missing"
    assert "lv_chordia" not in sys.modules
    assert sorted(p.name for p in stems.iterdir()) == ["bass.wav"]


def test_downloaded_checkpoints_are_the_ones_recorded(monkeypatch):
    """The files this machine has downloaded, when it has, are the pinned
    ones. Skipped on a machine that never detected chords."""
    monkeypatch.undo()
    if chord_engine.missing_checkpoints():
        pytest.skip("the chord model's checkpoints are not downloaded here")
    worker.verify_checkpoints()


def test_the_checkpoint_folder_is_in_the_models_folder(tmp_path, monkeypatch):
    from app.core import stem_models

    monkeypatch.setattr(stem_models, "MODELS_DIR", tmp_path)
    assert worker.checkpoint_dir() == tmp_path / "lv_chordia"
    assert [p.parent for p, _size in chord_engine.checkpoint_paths()] == [
        tmp_path / "lv_chordia"
    ] * 5


# --- The first-use download (app/pipeline/chords.py fetch_checkpoints) -------

# A stand-in for app/core/model_fetch.py: writes the file and says so.
_FETCH_OK = """
import json, sys, pathlib
dst = pathlib.Path(sys.argv[sys.argv.index("--dst") + 1])
size = int(sys.argv[sys.argv.index("--size") + 1])
print(json.dumps({"event": "progress", "pct": 0}), flush=True)
print(json.dumps({"event": "progress", "pct": 50}), flush=True)
dst.write_bytes(b"x" * size)
print(json.dumps({"event": "progress", "pct": 100}), flush=True)
print(json.dumps({"event": "done"}), flush=True)
"""
_FETCH_FAILS = """
import json, sys
sys.stderr.write("could not connect\\n")
print(json.dumps({"event": "error", "code": "download"}), flush=True)
sys.exit(3)
"""
_FETCH_HANGS = """
import json, sys, time
print(json.dumps({"event": "progress", "pct": 10}), flush=True)
time.sleep(60)
"""


@pytest.fixture
def two_missing(tmp_path, monkeypatch):
    """Two small checkpoints that are not on disk yet, under tmp_path."""
    from app.core import stem_models

    monkeypatch.undo()  # drop the autouse "everything is downloaded"
    monkeypatch.setattr(stem_models, "MODELS_DIR", tmp_path / "models")
    sizes = {"a_s0.best.sdict": 300, "a_s1.best.sdict": 100}
    monkeypatch.setattr(chord_engine, "CHORDS_CHECKPOINT_SIZE", sizes)
    monkeypatch.setattr(chord_engine, "CHORDS_CHECKPOINT_SHA256", {n: "0" * 64 for n in sizes})
    return tmp_path / "models" / "lv_chordia"


def _fetch_with(monkeypatch, code: str) -> list[list[str]]:
    calls: list[list[str]] = []

    def cmd(dst, url, sha256, size):
        calls.append([str(dst), url, sha256, str(size)])
        return [sys.executable, "-c", code, "--dst", str(dst), "--size", str(size)]

    monkeypatch.setattr(chords_mod, "_spawn_fetch_cmd", cmd)
    return calls


def test_missing_checkpoints_are_downloaded_before_the_worker_starts(two_missing, monkeypatch):
    calls = _fetch_with(monkeypatch, _FETCH_OK)
    seen: list[tuple[str, int | None]] = []
    chords_mod.fetch_checkpoints(Job(id=JOB, status="done"), lambda *a: seen.append(a))
    assert sorted(p.name for p in two_missing.iterdir()) == ["a_s0.best.sdict", "a_s1.best.sdict"]
    assert [Path(c[0]).name for c in calls] == ["a_s0.best.sdict", "a_s1.best.sdict"]
    assert all(c[1].startswith("https://raw.githubusercontent.com/music-x-lab/") for c in calls)
    assert seen[0] == ("downloading", 0)
    percents = [p for phase, p in seen if phase == "downloading"]
    # Across both files, by bytes: the first is three quarters of the total.
    assert percents == sorted(percents) and 37 in percents and 75 in percents
    assert max(percents) <= 99
    assert chord_engine.missing_checkpoints() == []


def test_only_the_missing_checkpoints_are_downloaded(two_missing, monkeypatch):
    two_missing.mkdir(parents=True)
    (two_missing / "a_s0.best.sdict").write_bytes(b"x" * 300)
    calls = _fetch_with(monkeypatch, _FETCH_OK)
    chords_mod.fetch_checkpoints(Job(id=JOB, status="done"), lambda *a: None)
    assert [Path(c[0]).name for c in calls] == ["a_s1.best.sdict"]


def test_nothing_is_downloaded_when_the_checkpoints_are_there(monkeypatch):
    monkeypatch.setattr(chords_mod, "_spawn_fetch_cmd", lambda *a: pytest.fail("a download"))
    seen: list = []
    chords_mod.fetch_checkpoints(Job(id=JOB, status="done"), lambda *a: seen.append(a))
    assert seen == []


def test_a_download_that_fails_says_so_and_starts_no_worker(two_missing, monkeypatch, stems):
    _fetch_with(monkeypatch, _FETCH_FAILS)
    monkeypatch.setattr(chords_mod, "_spawn_cmd", lambda stems_dir: pytest.fail("the worker"))
    job = Job(id=JOB, status="done")
    with pytest.raises(chords_mod.ChordsError) as caught:
        chords_mod.detect_chords(job, stems)
    assert caught.value.code == "model_download"
    assert job.chords_progress is None
    assert not two_missing.exists() or not list(two_missing.iterdir())


def test_a_cancel_stops_the_download(two_missing, monkeypatch):
    _fetch_with(monkeypatch, _FETCH_HANGS)
    job = Job(id=JOB, status="done")
    registry._jobs[JOB] = job
    started = threading.Event()

    def show(phase, percent=None):
        if percent:
            started.set()

    def cancel():
        started.wait(timeout=20)
        job.cancel_requested = True
        with registry.operation("chords"):
            proc = registry.get_proc(JOB, "chords")
        if proc is not None:
            proc.terminate()

    threading.Thread(target=cancel, daemon=True).start()
    try:
        with registry.operation("chords"), pytest.raises(chords_mod.ChordsError) as caught:
            chords_mod.fetch_checkpoints(job, show)
    finally:
        registry._jobs.pop(JOB, None)
    assert caught.value.code == "cancelled"


# --- The real worker process -----------------------------------------------


def test_the_real_worker_reports_usage_as_an_error():
    out = subprocess.run(
        [sys.executable, "-m", "app.pipeline.chords_worker"], capture_output=True, text=True
    )
    assert out.returncode == 1
    line = next(ln for ln in out.stderr.splitlines() if ln.startswith("@@ERROR@@"))
    assert json.loads(line[len("@@ERROR@@") :])["code"] == "worker_failed"


def test_the_real_worker_reports_a_song_with_no_audio(stems):
    out = subprocess.run(
        [sys.executable, "-m", "app.pipeline.chords_worker", str(stems)],
        capture_output=True,
        text=True,
    )
    assert out.returncode == 1
    lines = out.stderr.splitlines()
    assert json.loads(lines[-1][len("@@ERROR@@") :])["code"] == "no_audio"
    assert not any(ln.startswith("@@DONE@@") for ln in lines)
    assert list(stems.iterdir()) == []


# --- The parent, against stub workers --------------------------------------

_OK_WORKER = """
import sys, json
def say(tag, obj):
    sys.stderr.write(tag + json.dumps(obj) + "\\n"); sys.stderr.flush()
say("@@PROGRESS@@", {"phase": "mixing", "percent": None})
sys.stderr.write("mixed 2 lanes\\n")
say("@@PROGRESS@@", {"phase": "detecting", "percent": 40})
say("@@DONE@@", {"chords": 12, "named": 9})
"""

_PROGRESS_WORKER = """
import sys, json, time
def say(tag, obj):
    sys.stderr.write(tag + json.dumps(obj) + "\\n"); sys.stderr.flush()
say("@@PROGRESS@@", {"phase": "mixing", "percent": None})
time.sleep(0.4)
say("@@PROGRESS@@", {"phase": "detecting", "percent": 60})
time.sleep(0.4)
sys.stderr.write("@@PROGRESS@@{not json\\n")
say("@@PROGRESS@@", {"phase": "made-up", "percent": 5})
say("@@PROGRESS@@", {"phase": "finishing", "percent": 900})
time.sleep(0.4)
say("@@DONE@@", {"chords": 3, "named": 3})
"""

_FATAL_WORKER = """
import sys, json
sys.stderr.write("@@ERROR@@" + json.dumps({"message": "boom", "code": "no_audio"}) + "\\n")
sys.stderr.flush(); sys.exit(1)
"""

_UNKNOWN_CODE_WORKER = """
import sys, json
sys.stderr.write("@@ERROR@@" + json.dumps({"message": "boom", "code": "made-up"}) + "\\n")
sys.stderr.flush(); sys.exit(1)
"""

_CRASH_WORKER = "import sys; sys.stderr.write('Killed\\n'); sys.exit(137)"
_OOM_WORKER = "import sys; sys.stderr.write('RuntimeError: out of memory\\n'); sys.exit(1)"
_IMPORT_WORKER = (
    "import sys; sys.stderr.write(\"ModuleNotFoundError: No module named 'x'\\n\"); sys.exit(1)"
)

_HANG_WORKER = """
import sys, json, time
sys.stderr.write("@@PROGRESS@@" + json.dumps({"phase": "detecting", "percent": 20}) + "\\n")
sys.stderr.flush()
time.sleep(60)
"""

_BARE_DONE_WORKER = "import sys; sys.stderr.write('@@DONE@@\\n'); sys.stderr.flush()"


@pytest.fixture
def parent(monkeypatch, stems):
    def run(code: str, job: Job | None = None):
        monkeypatch.setattr(
            chords_mod, "_spawn_cmd", lambda stems_dir: [sys.executable, "-c", code, str(stems_dir)]
        )
        return chords_mod.detect_chords(job or Job(id=JOB, status="done"), stems)

    return run


def test_the_parent_returns_what_the_worker_wrote(parent):
    job = Job(id=JOB, status="done")
    assert parent(_OK_WORKER, job) == {"chords": 12, "named": 9}
    # The run is over: nothing is left describing a process.
    assert job.chords_progress is None
    assert registry.get_proc(JOB, "chords") is None


def test_a_done_line_with_nothing_in_it_still_ends_the_run(parent):
    assert parent(_BARE_DONE_WORKER) == {"chords": 0, "named": 0}


def test_the_run_reports_where_it_is_while_it_runs(parent):
    job = Job(id=JOB, status="done")
    seen: list[dict] = []
    stop = threading.Event()

    def watch():
        while not stop.wait(0.05):
            if job.chords_progress is not None and job.chords_progress not in seen:
                seen.append(dict(job.chords_progress))

    threading.Thread(target=watch, daemon=True).start()
    version = job.version
    try:
        parent(_PROGRESS_WORKER, job)
    finally:
        stop.set()
    assert {"phase": "mixing", "percent": None} in seen
    assert {"phase": "detecting", "percent": 60} in seen
    # A percent out of range is dropped; a phase that does not exist is ignored.
    assert {"phase": "finishing", "percent": None} in seen
    assert not any(step["phase"] == "made-up" for step in seen)
    # Each step was announced to whoever watches the job.
    assert job.version > version


def test_the_worker_is_started_on_the_cpu_with_a_parent_to_watch(monkeypatch, stems, tmp_path):
    out = tmp_path / "env.json"
    code = (
        "import os, sys, json\n"
        f"open({str(out)!r}, 'w').write(json.dumps({{k: os.environ.get(k) for k in "
        "('CUDA_VISIBLE_DEVICES', 'STEMDECK_PARENT_PID', 'PYTHONIOENCODING')}))\n"
        "sys.stderr.write('@@DONE@@{}\\n')\n"
    )
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "0")
    monkeypatch.setattr(chords_mod, "_spawn_cmd", lambda stems_dir: [sys.executable, "-c", code])
    chords_mod.detect_chords(Job(id=JOB, status="done"), stems)
    import os

    env = json.loads(out.read_text())
    assert env["CUDA_VISIBLE_DEVICES"] == ""
    assert env["STEMDECK_PARENT_PID"] == str(os.getpid())
    assert env["PYTHONIOENCODING"] == "utf-8:replace"


def test_the_real_worker_is_what_gets_started(stems):
    cmd = chords_mod._spawn_cmd(stems)
    assert cmd == [sys.executable, "-m", "app.pipeline.chords_worker", str(stems)]


def test_a_fatal_error_carries_its_code(parent):
    with pytest.raises(chords_mod.ChordsError) as caught:
        parent(_FATAL_WORKER)
    assert caught.value.code == "no_audio"
    assert caught.value.tail == ["boom"]


def test_an_unknown_code_never_leaves(parent):
    with pytest.raises(chords_mod.ChordsError) as caught:
        parent(_UNKNOWN_CODE_WORKER)
    assert caught.value.code == "worker_failed"


@pytest.mark.parametrize(
    ("code", "reason"),
    [
        (_CRASH_WORKER, "worker_failed"),
        (_OOM_WORKER, "out_of_memory"),
        (_IMPORT_WORKER, "dependency_missing"),
        ("pass", "worker_failed"),
    ],
)
def test_a_worker_that_dies_without_a_code_is_given_one(parent, code, reason):
    with pytest.raises(chords_mod.ChordsError) as caught:
        parent(code)
    assert caught.value.code == reason


def test_a_stalled_worker_is_stopped_as_a_timeout(parent, monkeypatch):
    monkeypatch.setattr(chords_mod, "TIMEOUT_CHORDS", 0.3)
    monkeypatch.setattr(chords_mod, "CHORDS_WATCHDOG_POLL_SEC", 0.1)
    job = Job(id=JOB, status="done")
    with pytest.raises(chords_mod.ChordsError) as caught:
        parent(_HANG_WORKER, job)
    assert caught.value.code == "timeout"
    assert job.chords_progress is None


def test_a_cancel_is_reported_as_cancelled(parent):
    job = Job(id=JOB, status="done")

    def cancel_soon():
        proc = None
        for _ in range(200):
            proc = registry.get_proc(JOB)
            if proc is not None:
                break
            threading.Event().wait(0.02)
        # Long enough for the stub to start and report a step.
        threading.Event().wait(1.0)
        job.cancel_requested = True
        if proc is not None:
            proc.terminate()

    threading.Thread(target=cancel_soon, daemon=True).start()
    with pytest.raises(chords_mod.ChordsError) as caught:
        parent(_HANG_WORKER, job)
    assert caught.value.code == "cancelled"


def test_a_worker_that_cannot_start_is_a_worker_failure(monkeypatch, stems, tmp_path):
    monkeypatch.setattr(
        chords_mod, "_spawn_cmd", lambda stems_dir: [str(tmp_path / "no-such-python"), "-c", "pass"]
    )
    with pytest.raises(chords_mod.ChordsError) as caught:
        chords_mod.detect_chords(Job(id=JOB, status="done"), stems)
    assert caught.value.code == "worker_failed"


def test_a_cancelled_real_worker_leaves_no_temp_folder(stems):
    """SIGTERM while it works: the temporary folder goes with it."""
    if sys.platform == "win32":
        pytest.skip("Windows ends a process without telling it")
    code = (
        "import sys, time\n"
        "from pathlib import Path\n"
        "from app.pipeline import chords_worker as w\n"
        "def slow(stems_dir, out):\n"
        "    out.write_bytes(b'x' * 100)\n"
        "    sys.stderr.write('READY\\n'); sys.stderr.flush()\n"
        "    time.sleep(60)\n"
        "w.mix_song = slow\n"
        "w.run.__kwdefaults__['mix'] = slow\n"
        f"sys.argv = ['chords_worker', {str(stems)!r}]\n"
        "w.main()\n"
    )
    proc = subprocess.Popen([sys.executable, "-c", code], stderr=subprocess.PIPE, text=True)
    try:
        assert proc.stderr is not None
        for line in proc.stderr:
            if line.strip() == "READY":
                break
        assert any(p.name.startswith(".decode-") for p in stems.iterdir())
        proc.terminate()
        proc.wait(timeout=20)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert list(stems.iterdir()) == []
