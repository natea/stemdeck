"""On-demand chord detection: the parent side.

A post-hoc action on an already-"done" job (POST /api/jobs/{id}/chords in
app/api/chords.py), not part of the import pipeline. Starts
app/pipeline/chords_worker.py as a fresh process per run, the way a MIDI run
starts its own (app/pipeline/midi.py), reads its progress, and returns
when the song's chord file is written.

The model's five checkpoints are not shipped with the app. The first run
downloads them here, in the parent, one process per file
(app/core/model_fetch.py: a pinned address, size and SHA-256), before the
worker starts; the worker itself has no network.

Nothing here touches the song's audio, and nothing here touches a chord file
either: the worker writes `stems/chords.json` whole as its last step, so a run
that ends early for any reason (a cancel, a stall, a crash) leaves the chords
the song already had exactly as they were.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from app.core.chord_outcome import CANCELLED, CODES, MODEL_DOWNLOAD, TIMEOUT, WORKER_FAILED
from app.core.config import CHORDS_WATCHDOG_POLL_SEC, TIMEOUT_CHORDS, TIMEOUT_CHORDS_MODEL_DOWNLOAD
from app.core.models import Job, _set
from app.core.registry import set_proc
from app.pipeline.errors import SeparationError

logger = logging.getLogger("stemdeck.pipeline")

_PHASES = frozenset(("starting", "mixing", "loading", "detecting", "finishing"))
# "downloading" is the parent's own phase (fetch_checkpoints), never the worker's.
# Longest a download may say nothing: model_fetch writes a line at least every
# ten seconds while bytes come, and gives up on a quiet read by itself.
_FETCH_QUIET_SEC = 120


class ChordsError(SeparationError):
    """A detection that did not finish, with the reason as one of
    app.core.chord_outcome.CODES."""

    def __init__(self, message: str, *, code: str, **kwargs) -> None:
        super().__init__(message, **kwargs)
        self.code = code if code in CODES else WORKER_FAILED


def _spawn_cmd(stems_dir: Path) -> list[str]:
    return [sys.executable, "-m", "app.pipeline.chords_worker", str(stems_dir)]


def _spawn_fetch_cmd(dst: Path, url: str, sha256: str, size: int) -> list[str]:
    """One checkpoint's download (app/core/model_fetch.py): the pinned
    address, size and SHA-256, into MODELS_DIR. A seam for tests."""
    return [
        sys.executable,
        "-m",
        "app.core.model_fetch",
        "--url",
        url,
        "--dst",
        str(dst),
        "--sha256",
        sha256,
        "--size",
        str(size),
    ]


def _worker_env() -> dict[str, str]:
    env = os.environ.copy()
    # The child arms a watchdog on this and hard-exits when we disappear, so a
    # kill that runs no cleanup cannot leave it running (#519).
    env["STEMDECK_PARENT_PID"] = str(os.getpid())
    # Pin the child's stdio encoding to what the parent decodes with (see
    # vocal_split.py): diagnostic text is never a reason to fail a run.
    env["PYTHONIOENCODING"] = "utf-8:replace"
    return env


def fetch_checkpoints(job: Job, show) -> None:
    """Download the checkpoints that are not on disk at their pinned size,
    one after the other, showing ``show("downloading", percent)`` across all
    of them. Returns when every one is in place. Raises ChordsError
    (MODEL_DOWNLOAD, or CANCELLED) otherwise; a file that did arrive stays,
    so the next try fetches only the rest."""
    from app.core.stem_models import model_path
    from app.pipeline import chord_engine

    missing = chord_engine.missing_checkpoints()
    if not missing:
        return
    total = sum(f.size for f in missing) or 1
    fetched = 0
    deadline = time.monotonic() + TIMEOUT_CHORDS_MODEL_DOWNLOAD
    logger.info("[%s] chords: downloading %d model file(s)", job.id, len(missing))
    show("downloading", 0)
    for model_file in missing:
        if job.cancel_requested:
            raise ChordsError("chord detection was cancelled", code=CANCELLED, device="cpu")
        dst = model_path(model_file)
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            proc = subprocess.Popen(
                _spawn_fetch_cmd(dst, model_file.url, model_file.sha256, model_file.size),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=_worker_env(),
            )
        except OSError as exc:
            raise ChordsError(
                f"the chord model could not be downloaded: {exc}",
                code=MODEL_DOWNLOAD,
                device="cpu",
            ) from exc
        set_proc(job.id, proc)
        last_output = [time.monotonic()]
        done_evt = threading.Event()
        stopped = threading.Event()

        def _watchdog(proc=proc, last_output=last_output, done_evt=done_evt, stopped=stopped):
            while not done_evt.wait(timeout=1.0):
                if proc.poll() is not None:
                    return
                now = time.monotonic()
                if now - last_output[0] > _FETCH_QUIET_SEC or now > deadline:
                    stopped.set()
                    proc.terminate()
                    return

        wt = threading.Thread(target=_watchdog, daemon=True)
        wt.start()
        finished = False
        tail: list[str] = []
        try:
            assert proc.stdout is not None
            for raw_line in proc.stdout:
                last_output[0] = time.monotonic()
                line = raw_line.strip()
                if not line:
                    continue
                event: object = None
                if line.startswith("{"):
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        event = None
                if not isinstance(event, dict):
                    tail.append(line)
                    if len(tail) > 20:
                        tail.pop(0)
                    continue
                if event.get("event") == "progress":
                    pct = event.get("pct")
                    if isinstance(pct, int) and not isinstance(pct, bool) and 0 <= pct <= 100:
                        got = fetched + model_file.size * pct // 100
                        show("downloading", min(99, got * 100 // total))
                elif event.get("event") == "done":
                    finished = True
                elif event.get("event") == "error":
                    tail.append(f"download ended with: {event.get('code')}")
        finally:
            done_evt.set()
            set_proc(job.id, None)
            wt.join(timeout=2)
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
        if job.cancel_requested:
            raise ChordsError("chord detection was cancelled", code=CANCELLED, device="cpu")
        if not finished or proc.returncode != 0 or stopped.is_set():
            logger.warning(
                "[%s] chords: a model file could not be downloaded: %s",
                job.id,
                " | ".join(tail[-3:]) or "no diagnostic output",
            )
            raise ChordsError(
                "the chord model could not be downloaded",
                code=MODEL_DOWNLOAD,
                tail=tail[-20:],
                device="cpu",
            )
        fetched += model_file.size
    if chord_engine.missing_checkpoints():
        raise ChordsError(
            "the chord model's files are not all there after the download",
            code=MODEL_DOWNLOAD,
            device="cpu",
        )


def _result(raw: object) -> dict[str, int]:
    """The worker's @@DONE@@ object, with anything unusable as zero."""
    out = {"chords": 0, "named": 0}
    if isinstance(raw, dict):
        for key in out:
            value = raw.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                out[key] = value
    return out


def detect_chords(job: Job, stems_dir: Path) -> dict[str, int]:
    """Detect the chords of the song in ``stems_dir``.

    Returns ``{"chords": entries written, "named": entries that are a chord}``
    once `stems/chords.json` is in place. Raises ChordsError when the run did
    not finish; the song's earlier chord file, if any, is then untouched."""

    def show(phase: str, percent: int | None = None) -> None:
        job.chords_progress = {"phase": phase, "percent": percent}
        _set(job)

    show("starting")
    try:
        fetch_checkpoints(job, show)
    except ChordsError:
        job.chords_progress = None
        raise

    env = _worker_env()
    # lv-chordia moves itself to CUDA when it sees a device. The model is
    # small and a song takes under a minute on a CPU, so every machine runs it
    # the same way, and no second process sits on a GPU an import will want.
    env["CUDA_VISIBLE_DEVICES"] = ""
    env.setdefault("TQDM_DISABLE", "1")

    try:
        proc = subprocess.Popen(
            _spawn_cmd(stems_dir),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )
    except OSError as exc:
        raise ChordsError(
            f"chord detection could not start: {exc}", code=WORKER_FAILED, device="cpu"
        ) from exc
    set_proc(job.id, proc)

    show("starting")
    tail: list[str] = []
    last_output = [time.monotonic()]
    done_evt = threading.Event()
    stalled = threading.Event()
    worker_code: list[str | None] = [None]
    result: dict[str, int] | None = None

    def _watchdog() -> None:
        while not done_evt.wait(timeout=CHORDS_WATCHDOG_POLL_SEC):
            if proc.poll() is not None:
                return
            if time.monotonic() - last_output[0] > TIMEOUT_CHORDS:
                logger.warning(
                    "chord detection stalled for %ss with no output, terminating job %s",
                    TIMEOUT_CHORDS,
                    job.id,
                )
                stalled.set()
                proc.terminate()
                return

    wt = threading.Thread(target=_watchdog, daemon=True)
    wt.start()
    try:
        assert proc.stderr is not None
        for raw_line in proc.stderr:
            last_output[0] = time.monotonic()
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith("@@DONE@@"):
                try:
                    result = _result(json.loads(line[len("@@DONE@@") :] or "{}"))
                except json.JSONDecodeError:
                    result = _result(None)
                break
            if line.startswith("@@PROGRESS@@"):
                try:
                    step = json.loads(line[len("@@PROGRESS@@") :])
                except json.JSONDecodeError:
                    continue
                if isinstance(step, dict) and step.get("phase") in _PHASES:
                    percent = step.get("percent")
                    show(
                        step["phase"],
                        percent
                        if isinstance(percent, int)
                        and not isinstance(percent, bool)
                        and 0 <= percent <= 100
                        else None,
                    )
                continue
            if line.startswith("@@ERROR@@"):
                msg: object = line[len("@@ERROR@@") :]
                try:
                    msg = json.loads(str(msg))
                except json.JSONDecodeError:
                    pass
                if isinstance(msg, dict):
                    code = msg.get("code")
                    worker_code[0] = code if isinstance(code, str) else None
                    msg = msg.get("message", "")
                tail.append(str(msg))
                break
            tail.append(line)
            if len(tail) > 40:
                tail.pop(0)
    finally:
        done_evt.set()
        job.chords_progress = None
        set_proc(job.id, None)
        wt.join(timeout=2)
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()

    if result is None:
        detail = "\n".join(tail[-15:]) if tail else "(no stderr captured)"
        logger.warning("[%s] chord detection failed: %s", job.id, detail)
        last = tail[-1] if tail else "chord detection failed"
        # A cancel and the watchdog both end the worker from outside, so what
        # it last wrote says nothing about why it stopped.
        if job.cancel_requested:
            code = CANCELLED
        elif stalled.is_set():
            code = TIMEOUT
        elif worker_code[0] is not None:
            code = worker_code[0]
        else:
            code = _code_from_text("\n".join(tail))
        raise ChordsError(
            f"chord detection failed: {last}", code=code, tail=tail[-40:], device="cpu"
        )
    return result


def _code_from_text(text: str) -> str:
    """The reason for a worker that died without naming one."""
    from app.core.chord_outcome import DEPENDENCY_MISSING, OUT_OF_MEMORY
    from app.pipeline.errors import classify_failure

    low = text.lower()
    if classify_failure(low) == "out-of-memory":
        return OUT_OF_MEMORY
    if "modulenotfounderror" in low or "importerror" in low:
        return DEPENDENCY_MISSING
    return WORKER_FAILED
