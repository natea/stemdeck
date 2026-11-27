"""On-demand chord detection worker.

Run as its own process: `python -m app.pipeline.chords_worker <stems_dir>`.
Like midi_worker.py it is **not** persistent: detecting chords is an
occasional action on a finished song, and a process that exits gives back the
model and everything torch loaded with it.

What it does, in order:

1. **Mixing.** Sums the song from its lanes into one mono WAV at the rate the
   model works at. The lanes are the base stems on disk plus the Original lane
   when the song has one, so the result is the whole song however it was
   imported. (`stems/mix.*` is not that: it holds only the stems the user
   selected, and is missing when one stem was selected.) The lead and backing
   vocal stems are a second copy of `vocals` and are left out. The file goes
   in a temporary folder inside `stems/`, named so the startup sweep
   (collect.sweep_crash_leftovers) removes one a killed worker left behind.
2. **Loading.** Checks the model's five checkpoints against their recorded
   SHA-256 values (app.core.config.CHORDS_CHECKPOINT_SHA256), puts the
   vendored package first on sys.path (app/pipeline/chord_engine.py) and
   imports lv-chordia. This is the only place in StemDeck that imports it.
   The checkpoints are already on disk: the parent downloads them before it
   starts this process, which never needs the network and refuses it, as the
   MIDI worker does.
3. **Detecting.** Hands the model the file by its absolute path (the package
   resolves a relative path against its own folder) and the chord list to
   answer from.
4. **Finishing.** Reads the model's labels into chords
   (app/pipeline/chord_labels.py) and writes `stems/chords.json` whole
   (app/core/chord_files.py). The times are the model's own: putting changes
   on beats is done when the timeline is read.

Protocol on stderr. Progress and log lines,
then exactly one of:

  "@@PROGRESS@@<json object>"  {"phase": "mixing" | "loading" | "detecting" |
                                "finishing", "percent": 0-100 or null}
  "@@DONE@@<json object>"      {"chords": entries, "named": entries that are
                                a chord}; the file is written
  "@@ERROR@@<json object>"     {"message": str, "code": reason code}; exit(1)

Reason codes are app.core.chord_outcome.CODES. A song the model found no
chord in is not an error: the file is written and says so.
"""

from __future__ import annotations

import errno
import hashlib
import json
import shutil
import signal
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

from app.core.chord_files import write_detected
from app.core.chord_outcome import DEPENDENCY_MISSING, NO_AUDIO, OUT_OF_MEMORY, WORKER_FAILED
from app.core.config import (
    CHORDS_CHECKPOINT_SHA256,
    CHORDS_ENGINE,
    CHORDS_SAMPLE_RATE,
    CHORDS_VOCABULARY,
    STEM_NAMES,
    TIMEOUT_FFMPEG,
    WAV_PLAIN_HEADER_ARGS,
    ffmpeg_executable,
)
from app.core.process import arm_parent_watchdog
from app.core.stem_files import stem_exists, stem_path

# The lane that holds the rest of the song when the user kept a subset of
# stems (app/pipeline/collect.py make_original_track).
ORIGINAL_LANE = "original"
# How many models the ensemble runs, one "Inference:" line each.
_ENSEMBLE = len(CHORDS_CHECKPOINT_SHA256)

# (absolute path of the audio, vocabulary name) -> lv-chordia's segments.
Recogniser = Callable[[str, str], list]


class ChordsFailure(Exception):
    """A run that cannot go on, with the reason as a code. The message is for
    the server's log only."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _emit(line: str) -> None:
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def _progress(phase: str, percent: int | None = None) -> None:
    _emit("@@PROGRESS@@" + json.dumps({"phase": phase, "percent": percent}))


def _code(exc: BaseException) -> str:
    """The reason code for a failure nobody named."""
    if isinstance(exc, ChordsFailure):
        return exc.code
    if isinstance(exc, MemoryError):
        return OUT_OF_MEMORY
    if isinstance(exc, ImportError):
        return DEPENDENCY_MISSING
    try:
        from app.pipeline.errors import classify_failure

        if classify_failure(f"{type(exc).__name__}: {exc}") == "out-of-memory":
            return OUT_OF_MEMORY
    except Exception:
        # The classifier is a nicety. Failing to load it must not cost the
        # parent the error itself.
        pass
    return WORKER_FAILED


def song_lanes(stems_dir: Path) -> list[str]:
    """The lanes that add up to the whole song, in a fixed order."""
    return [name for name in (*STEM_NAMES, ORIGINAL_LANE) if stem_exists(stems_dir, name)]


def mix_song(stems_dir: Path, out: Path) -> list[str]:
    """Sum the song's lanes into ``out`` (mono float WAV at
    CHORDS_SAMPLE_RATE) and return the lanes that went in. Float, so a sum
    that passes full scale is not clipped."""
    lanes = song_lanes(stems_dir)
    if not lanes:
        raise ChordsFailure(NO_AUDIO, "the song has no stem on disk")
    cmd: list[str] = [ffmpeg_executable(), "-y", "-nostdin", "-loglevel", "error"]
    for name in lanes:
        cmd += ["-i", str(stem_path(stems_dir, name))]
    # Every lane to stereo float first, so the sum does not depend on which
    # lane happens to be mono, then the two channels averaged into one. The
    # average is written out: ffmpeg's own stereo-to-mono scales by 0.707 a
    # channel and only normalises that for integer output.
    graph = "".join(
        f"[{i}:a:0]aformat=sample_fmts=fltp:channel_layouts=stereo[lane{i}];"
        for i in range(len(lanes))
    )
    if len(lanes) > 1:
        graph += "".join(f"[lane{i}]" for i in range(len(lanes)))
        graph += f"amix=inputs={len(lanes)}:normalize=0,"
    else:
        graph += "[lane0]"
    graph += "pan=mono|c0=0.5*c0+0.5*c1[song]"
    cmd += [
        "-filter_complex",
        graph,
        "-map",
        "[song]",
        "-ar",
        str(CHORDS_SAMPLE_RATE),
        "-c:a",
        "pcm_f32le",
        *WAV_PLAIN_HEADER_ARGS,
        "-f",
        "wav",
        str(out),
    ]
    try:
        done = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=TIMEOUT_FFMPEG,
        )
    except subprocess.TimeoutExpired as exc:
        raise ChordsFailure(WORKER_FAILED, "ffmpeg took too long to mix the song") from exc
    except OSError as exc:
        raise ChordsFailure(WORKER_FAILED, f"ffmpeg could not start: {exc}") from exc
    if done.returncode != 0 or not out.is_file() or out.stat().st_size <= 44:
        detail = done.stderr.decode("utf-8", errors="replace").strip().splitlines()[-3:]
        raise ChordsFailure(NO_AUDIO, "the song's audio could not be read: " + " | ".join(detail))
    return lanes


def wav_seconds(path: Path) -> float:
    """How long the mixed WAV is. It is our own file: 4 bytes a frame, one
    channel, after a 44-byte header (WAV_PLAIN_HEADER_ARGS keeps it plain)."""
    try:
        import soundfile

        info = soundfile.info(str(path))
        return float(info.frames) / float(info.samplerate)
    except Exception:
        return max(0.0, (path.stat().st_size - 44) / (4.0 * CHORDS_SAMPLE_RATE))


def checkpoint_dir() -> Path:
    """Where the model's checkpoints are kept once downloaded."""
    from app.pipeline import chord_engine

    return chord_engine.checkpoint_dir()


def verify_checkpoints(folder: Path | None = None) -> None:
    """Refuse to go on unless every checkpoint is the file StemDeck was built
    with. Raises ChordsFailure(DEPENDENCY_MISSING) for one that is missing or
    differs. About 30 MB to hash, a fraction of a second."""
    folder = checkpoint_dir() if folder is None else folder
    for name, expected in CHORDS_CHECKPOINT_SHA256.items():
        path = folder / name
        if not path.is_file():
            raise ChordsFailure(DEPENDENCY_MISSING, f"chord model file is missing: {name}")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        if digest.hexdigest() != expected:
            raise ChordsFailure(
                DEPENDENCY_MISSING, f"chord model file is not the one expected: {name}"
            )


def _engine_version() -> str:
    from app.pipeline import chord_engine

    return chord_engine.engine_version() or "unknown"


def _no_network(*_args: object, **_kwargs: object):
    raise OSError(errno.EACCES, "the chord worker has no network access")


def _block_network() -> None:
    """Defense in depth, as in midi_worker: nothing in a detection needs the
    network (the package can fetch audio from an address; it is only ever
    given a file), so a connection from this process is refused."""
    import socket

    socket.socket.connect = _no_network  # type: ignore[method-assign]
    socket.socket.connect_ex = _no_network  # type: ignore[method-assign]
    socket.socket.sendto = _no_network  # type: ignore[method-assign]
    socket.create_connection = _no_network  # type: ignore[assignment]
    socket.getaddrinfo = _no_network  # type: ignore[assignment]
    socket.gethostbyname = _no_network  # type: ignore[assignment]


class _Relay:
    """Stands in for stderr while the model runs. lv-chordia prints one
    "Inference: <model> on <path>" line per ensemble member; each becomes a
    progress line, without the path. Everything else passes through."""

    def __init__(self, real) -> None:
        self._real = real
        self._pending = ""
        self.seen = 0

    def write(self, text: str) -> int:
        self._pending += text
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            self._line(line)
        return len(text)

    def _line(self, line: str) -> None:
        if line.startswith("Inference:"):
            # Printed before each model runs: that many are finished.
            percent = min(99, round(100 * self.seen / _ENSEMBLE))
            self.seen += 1
            self._real.write(
                "@@PROGRESS@@" + json.dumps({"phase": "detecting", "percent": percent}) + "\n"
            )
        elif line.strip():
            self._real.write(line + "\n")
        self._real.flush()

    def flush(self) -> None:
        self._real.flush()

    def close(self) -> None:
        if self._pending.strip():
            self._line(self._pending)
        self._pending = ""

    def __getattr__(self, name: str):
        return getattr(self._real, name)


def _default_recogniser() -> Recogniser:
    """lv-chordia, imported here and nowhere else, from its vendored copy.
    The checkpoints are verified first: importing the package is harmless,
    loading them is not."""
    from app.pipeline import chord_engine

    folder = checkpoint_dir()
    verify_checkpoints(folder)
    chord_engine.install()
    try:
        from lv_chordia.chord_recognition import chord_recognition

        chord_engine.use_checkpoints(folder)
    except ImportError as exc:
        raise ChordsFailure(DEPENDENCY_MISSING, f"lv-chordia did not import: {exc}") from exc

    def recognise(audio_path: str, vocabulary: str) -> list:
        return chord_recognition(audio_path=audio_path, chord_dict_name=vocabulary)

    return recognise


def run(
    stems_dir: Path,
    *,
    recogniser: Callable[[], Recogniser] = _default_recogniser,
    vocabulary: str = CHORDS_VOCABULARY,
    mix: Callable[[Path, Path], list[str]] = mix_song,
    engine_version: Callable[[], str] = _engine_version,
) -> dict:
    """Detect the chords of the song in ``stems_dir`` and write them. Returns
    {"chords": entries, "named": entries that are a chord, "lanes": [...]}
    for a caller in the same process (the tests)."""
    from app.pipeline.chord_labels import entries_from_segments

    stems_dir = Path(stems_dir).resolve()
    if not stems_dir.is_dir():
        raise ChordsFailure(NO_AUDIO, "the song's stems folder is not there")
    folder = Path(tempfile.mkdtemp(prefix=".decode-", dir=stems_dir))
    try:
        _progress("mixing")
        audio = folder / "song.wav"
        lanes = mix(stems_dir, audio)
        _emit(f"mixed {len(lanes)} lanes: {', '.join(lanes)}")
        duration = wav_seconds(audio)

        _progress("loading")
        recognise = recogniser()

        _progress("detecting", 0)
        relay = _Relay(sys.stderr)
        real, sys.stderr = sys.stderr, relay
        try:
            # Absolute on purpose: lv-chordia resolves a relative path against
            # its own package folder.
            segments = recognise(str(audio.resolve()), vocabulary)
        finally:
            sys.stderr = real
            relay.close()

        _progress("finishing")
        chords = entries_from_segments(segments, duration)
        write_detected(
            stems_dir,
            engine=CHORDS_ENGINE,
            engine_version=engine_version(),
            vocabulary=vocabulary,
            duration=duration,
            chords=chords,
        )
        named = sum(1 for entry in chords if entry["root"] is not None)
        return {"chords": len(chords), "named": named, "lanes": lanes}
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def _on_terminate(signum, frame) -> None:
    # A cancel arrives as SIGTERM. Raised as an exit, so the temporary folder
    # is removed and a running ffmpeg is killed on the way out.
    raise SystemExit(143)


def main() -> None:
    # A Force-Quit of the app otherwise orphans this process (#519).
    arm_parent_watchdog()
    _block_network()
    try:
        signal.signal(signal.SIGTERM, _on_terminate)
    except (ValueError, OSError, AttributeError):
        pass
    if len(sys.argv) != 2:
        _emit(
            "@@ERROR@@"
            + json.dumps({"message": "usage: chords_worker <stems_dir>", "code": WORKER_FAILED})
        )
        sys.exit(1)
    try:
        result = run(Path(sys.argv[1]))
    except SystemExit:
        raise
    except BaseException as exc:
        if isinstance(exc, KeyboardInterrupt):
            raise
        _emit("@@ERROR@@" + json.dumps({"message": str(exc), "code": _code(exc)}))
        sys.exit(1)
    _emit("@@DONE@@" + json.dumps({"chords": result["chords"], "named": result["named"]}))


if __name__ == "__main__":
    main()
