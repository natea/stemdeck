"""On-demand stem transcription: the parent side.

A post-hoc action on an already-"done" job (POST /api/jobs/{id}/transcription
in app/api/transcription.py), not part of the import pipeline. Starts
app/pipeline/notes_worker.py as a fresh process per run, the way the lead and
backing vocal split does (app/pipeline/vocal_split.py), reads its progress,
and returns what happened to each stem.

Nothing here touches the stems themselves. The worker writes each stem's
notes under stems/transcription/ as it finishes, so whatever ends the run
early (a cancel, a stall, a crash) leaves the stems that were done with their
results: the error this raises carries those outcomes with it.
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

from app.core.config import TIMEOUT_TRANSCRIPTION, TRANSCRIPTION_WATCHDOG_POLL_SEC
from app.core.models import Job, _set
from app.core.registry import set_proc
from app.core.settings import get_demucs_device
from app.core.transcription_outcome import CANCELLED, CODES, TIMEOUT, WORKER_FAILED
from app.pipeline.errors import SeparationError
from app.pipeline.vocal_split_status import failure_code

logger = logging.getLogger("stemdeck.pipeline")

# What one stem's outcome looks like: {"status": "done" | "skipped" | "error",
# "notes": int, "code": reason code or None, "transcriber": name}.
Outcome = dict


class TranscriptionError(SeparationError):
    """A run that ended before it reported every stem, with the reason as one
    of app.core.transcription_outcome.CODES. ``outcomes`` holds the stems it
    did report, whose results are on disk and are kept."""

    def __init__(
        self, message: str, *, code: str, outcomes: dict[str, Outcome] | None = None, **kwargs
    ) -> None:
        super().__init__(message, **kwargs)
        self.code = code if code in CODES else WORKER_FAILED
        self.outcomes: dict[str, Outcome] = outcomes or {}


def _spawn_cmd(device: str, stems_dir: Path, names: list[str]) -> list[str]:
    return [
        sys.executable,
        "-m",
        "app.pipeline.notes_worker",
        device,
        str(stems_dir),
        ",".join(names),
    ]


def _outcome(raw: object) -> tuple[str, Outcome] | None:
    """A worker's @@STEM@@ object as (stem, outcome), or None if malformed."""
    if not isinstance(raw, dict) or not isinstance(raw.get("stem"), str):
        return None
    status = raw.get("status")
    if status not in ("done", "skipped", "error"):
        return None
    code = raw.get("code")
    # Only a failed stem has a reason, and only a known one leaves this function.
    code = (code if code in CODES else WORKER_FAILED) if status == "error" else None
    notes = raw.get("notes")
    return raw["stem"], {
        "status": status,
        "notes": notes if isinstance(notes, int) and notes >= 0 else 0,
        "code": code,
        "transcriber": raw.get("transcriber") if isinstance(raw.get("transcriber"), str) else None,
    }


def transcribe_stems(job: Job, stems_dir: Path, names: list[str]) -> dict[str, Outcome]:
    """Transcribe ``names`` and return each stem's outcome.

    A stem that failed is an outcome, not an exception: the run goes on to the
    others. Raises TranscriptionError only when the run itself ended early
    (cancelled, stalled, crashed, never started), carrying the outcomes so far.
    """
    device = get_demucs_device()
    env = os.environ.copy()
    # The worker arms a watchdog on this and hard-exits when we disappear, so a
    # kill that runs no cleanup cannot leave it holding the GPU (#519).
    env["STEMDECK_PARENT_PID"] = str(os.getpid())
    # Pin the child's stdio encoding to what the parent decodes with (see
    # vocal_split.py): diagnostic text is never a reason to fail a run.
    env["PYTHONIOENCODING"] = "utf-8:replace"
    # mt3-infer and huggingface-hub draw progress bars with carriage returns,
    # which would arrive as one endless line.
    env.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    env.setdefault("TQDM_DISABLE", "1")
    try:
        import certifi

        env.setdefault("SSL_CERT_FILE", certifi.where())
        env.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
    except ModuleNotFoundError:
        pass

    try:
        proc = subprocess.Popen(
            _spawn_cmd(device, stems_dir, names),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )
    except OSError as exc:
        raise TranscriptionError(
            f"transcription could not start: {exc}", code=WORKER_FAILED, device=device
        ) from exc
    set_proc(job.id, proc)

    tail: list[str] = []
    outcomes: dict[str, Outcome] = {}
    last_output = [time.monotonic()]
    done_evt = threading.Event()
    stalled = threading.Event()
    worker_code: list[str | None] = [None]

    def _watchdog() -> None:
        while not done_evt.wait(timeout=TRANSCRIPTION_WATCHDOG_POLL_SEC):
            if proc.poll() is not None:
                return
            if time.monotonic() - last_output[0] > TIMEOUT_TRANSCRIPTION:
                logger.warning(
                    "transcription stalled for %ss with no output, terminating job %s",
                    TIMEOUT_TRANSCRIPTION,
                    job.id,
                )
                stalled.set()
                proc.terminate()
                return

    wt = threading.Thread(target=_watchdog, daemon=True)
    wt.start()
    job_ok = False
    try:
        assert proc.stderr is not None
        for raw_line in proc.stderr:
            last_output[0] = time.monotonic()
            line = raw_line.strip()
            if not line:
                continue
            if line == "@@DONE@@":
                job_ok = True
                break
            if line.startswith("@@STEM@@"):
                try:
                    parsed = _outcome(json.loads(line[len("@@STEM@@") :]))
                except json.JSONDecodeError:
                    parsed = None
                if parsed is not None:
                    outcomes[parsed[0]] = parsed[1]
                    # Shown as it happens: the song's state carries each stem's
                    # result while the rest are still being transcribed.
                    job.transcription_stems = {
                        **(job.transcription_stems or {}),
                        parsed[0]: parsed[1],
                    }
                    left = len(names) - len(outcomes)
                    stage = (
                        f"Transcribing stems ({len(outcomes)} of {len(names)})..."
                        if left > 0
                        else "Transcribing stems..."
                    )
                    _set(job, stage=stage)
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
        set_proc(job.id, None)
        wt.join(timeout=2)
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()

    if not job_ok:
        detail = "\n".join(tail[-15:]) if tail else "(no stderr captured)"
        logger.warning("[%s] transcription failed: %s", job.id, detail)
        last = tail[-1] if tail else "transcription failed"
        # A cancel and the watchdog both end the worker from outside, so what
        # it last wrote says nothing about why it stopped.
        if job.cancel_requested:
            code = CANCELLED
        elif stalled.is_set():
            code = TIMEOUT
        elif worker_code[0] is not None:
            code = worker_code[0]
        else:
            code = failure_code("unknown", text="\n".join(tail))
        raise TranscriptionError(
            f"transcription failed: {last}",
            code=code,
            outcomes=outcomes,
            tail=tail[-40:],
            device=device,
        )

    # A stem the worker never mentioned did not get transcribed.
    for name in names:
        outcomes.setdefault(
            name, {"status": "error", "notes": 0, "code": WORKER_FAILED, "transcriber": None}
        )
    return outcomes
