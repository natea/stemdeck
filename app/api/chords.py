"""Chord detection: find a finished song's chords, serve them as a timeline,
and keep the user's corrections.

    POST   /api/jobs/{id}/chords   detect the chords (answers when it ends)
    GET    /api/jobs/{id}/chords   the timeline, with changes on beats
    PATCH  /api/jobs/{id}/chords   save a corrected timeline
    DELETE /api/jobs/{id}/chords   discard the corrections

Detecting is a post-hoc action on a "done" job, like the lead and backing
vocal split: it runs a worker process under the pipeline lock,
its failure never fails the song, and POST /api/jobs/{id}/cancel stops it.

Two files hold a song's chords (app/core/chord_files.py). The detection is the
detector's own output, times untouched. The corrections are the user's
timeline, kept apart so a detection run again cannot discard them; while they
exist they are what GET serves. Neither is aligned to beats on disk: every GET
moves the chord changes onto the song's current beat grid
(app/pipeline/chord_snap.py), so a grid corrected afterwards moves the chords
with no model run.

Chords are served as a root, chord tones and a bass note
(app/core/chord_model.py), never as a symbol. The page writes the symbol,
because how a chord is spelled depends on the key and on how far the player
has transposed the song (static/js/harmony/chords.js).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response

from app.api.config import chords_available
from app.api.jobs import _job_state, _pipeline_lock
from app.core import chord_files
from app.core.chord_model import clean_entries, fill_gaps
from app.core.chord_outcome import CANCELLED, DEPENDENCY_MISSING, WORKER_FAILED, message_for
from app.core.config import CHORDS_MIN_BEATS, JOB_ID_RE, JOBS_DIR
from app.core.models import Job, JobBusy, _set
from app.core.registry import get as registry_get
from app.core.registry import operation as registry_operation
from app.core.registry import persist as registry_persist
from app.pipeline.chord_snap import snap, usable_beats
from app.pipeline.chords import ChordsError, detect_chords
from app.pipeline.midi import read_grid

logger = logging.getLogger("stemdeck.api")

router = APIRouter()

# Never cached: the timeline changes with every correction and with every
# edit of the beat grid.
_NO_STORE = {"Cache-Control": "no-store"}
# A corrected timeline is at most MAX_ENTRIES small objects. Refused before it
# is parsed when it is far larger than that could ever be.
_MAX_BODY_BYTES = 2 * 1024 * 1024


def _done_job(job_id: str) -> tuple[Job, Path]:
    """The finished job and its stems folder, or 404."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None or job.status != "done":
        raise HTTPException(status_code=404, detail="job not found")
    stems_dir = (JOBS_DIR / job_id / "stems").resolve()
    if not stems_dir.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="job not found")
    return job, stems_dir


def _refusal(status: int, detail: str, code: str) -> JSONResponse:
    """A refusal that carries a reason code and its fixed sentence."""
    return JSONResponse(
        {"detail": detail, "chords_reason": code, "chords_message": message_for(code)},
        status_code=status,
        headers=_NO_STORE,
    )


@router.post("/{job_id}/chords")
async def start_chords(job_id: str) -> Response:
    """Detect the chords of a completed job.

    The response arrives when the run ends and is the job's state, with
    ``chords_found`` (whether the detector named any chord at all) and
    ``chords_edited`` (whether the song has corrections, which are then still
    what GET serves). While it runs the job reports ``chords: "running"`` and
    its step in ``chords_progress``. A run that does not finish leaves the
    song, and any chords it already had, as they were."""
    job, stems_dir = _done_job(job_id)
    if not chords_available():
        return _refusal(501, "chord detection is not available here", DEPENDENCY_MISSING)
    if job.chords == "running":
        raise HTTPException(status_code=409, detail="chord detection already running")
    # Refused, not queued behind it: a fill or a split is writing stems this
    # would be reading, and a MIDI run is working in the song's folder.
    if job.post_hoc_running():
        raise JobBusy()

    # A cancel is for the run it was sent to. One left over from an earlier
    # run would otherwise read as this one being cancelled.
    job.cancel_requested = False
    job.chords = "running"
    job.chords_reason = None
    _set(job, stage="Detecting chords...")
    # Saved before it starts: a restart during the run then reads it as
    # interrupted (Job.from_record) instead of running forever.
    await asyncio.to_thread(registry_persist, JOBS_DIR)

    try:
        async with _pipeline_lock:
            # Cancelled while it waited behind an import: never start.
            if job.cancel_requested:
                raise ChordsError("chord detection cancelled before it started", code=CANCELLED)
            logger.info("[%s] chord detection started", job_id)
            started = time.monotonic()
            with registry_operation("chords"):
                result = await asyncio.to_thread(detect_chords, job, stems_dir)
    except Exception as e:
        logger.warning("[%s] chord detection failed: %s", job_id, e, exc_info=True)
        # The song stays done, with the chords it had. Only the code leaves
        # the server: the exception's words stay in the log.
        code = getattr(e, "code", None) or (CANCELLED if job.cancel_requested else WORKER_FAILED)
        job.cancel_requested = False
        job.chords = "error"
        job.chords_reason = code
        job.chords_progress = None
        _set(job, stage="Done")
        await asyncio.to_thread(registry_persist, JOBS_DIR)
        return JSONResponse(
            {
                **_job_state(job),
                "detail": "chord detection failed",
                "chords_reason": code,
                "chords_message": message_for(code),
            },
            status_code=500,
        )

    logger.info(
        "[%s] chord detection done in %.1fs: %d entries, %d of them chords",
        job_id,
        time.monotonic() - started,
        result["chords"],
        result["named"],
    )
    # A cancel that arrived after the worker finished lost the race. Left set,
    # it would stop the next run on this song that reads the flag.
    job.cancel_requested = False
    job.chords = "done"
    job.chords_reason = None
    job.chords_progress = None
    _set(job, stage="Done")
    await asyncio.to_thread(registry_persist, JOBS_DIR)
    return JSONResponse(
        {
            **_job_state(job),
            "chords_found": result["named"] > 0,
            "chords_edited": chord_files.user_path(stems_dir).is_file(),
        }
    )


@router.get("/{job_id}/chords")
def get_chords(
    job_id: str,
    source: str = Query(
        default="",
        max_length=16,
        description="'detected' serves what the detector found even when corrections exist",
    ),
) -> Response:
    """A song's chord timeline.

    ``chords`` is the list of entries, each with ``start``, ``end``, ``root``
    (a pitch class, or null for "no chord"), ``degrees`` and ``bass``; an
    entry of the detected timeline also carries the detector's ``label``. It
    covers the song with no gap and no overlap.

    The user's corrections are served when the song has some (``edited``),
    unless ``source=detected``. With a beat grid every chord change is on one
    of its beats (``aligned``), and ``beats`` holds the beat times a start can
    be moved to. Without one the stored times are served as they are."""
    job, stems_dir = _done_job(job_id)
    if source not in ("", "detected"):
        raise HTTPException(status_code=422, detail="source must be 'detected' when given")

    detected = chord_files.read_detected(stems_dir)
    user = chord_files.read_user(stems_dir)
    want_detected = source == "detected" or user is None
    if (detected if want_detected else user) is None:
        raise HTTPException(status_code=404, detail="no chords")

    duration = detected.get("duration") if detected else None
    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or duration <= 0:
        duration = job.duration_sec if isinstance(job.duration_sec, (int, float)) else None

    entries = detected["chords"] if want_detected else user
    entries = fill_gaps([dict(entry) for entry in entries], duration)
    beats = usable_beats(read_grid(stems_dir)[0])
    # What the user placed by hand is moved to the grid but never merged away.
    chords = snap(entries, beats, CHORDS_MIN_BEATS if want_detected else 0)

    return JSONResponse(
        {
            "job_id": job_id,
            "chords": chords,
            "source": "detected" if want_detected else "user",
            "edited": user is not None,
            "has_detected": detected is not None,
            "aligned": beats is not None,
            "beats": [round(t, 3) for t in beats] if beats is not None else [],
            "named": sum(1 for entry in chords if entry["root"] is not None),
            "engine": detected.get("engine") if detected else None,
            "engine_version": detected.get("engine_version") if detected else None,
            "vocabulary": detected.get("vocabulary") if detected else None,
            "duration": duration,
        },
        headers=_NO_STORE,
    )


def _reject_non_finite(_token: str) -> float:
    """`json.loads` parse_constant hook: NaN and Infinity are not JSON, and a
    validation error that held one could not be serialised (see the beat grid's
    own hook in app/api/jobs.py)."""
    raise ValueError("non-finite numbers are not accepted")


async def _parse_body(request: Request) -> list:
    """The ``chords`` list of a PATCH body, checked. Refusals never repeat
    what was sent."""
    raw = await request.body()
    if len(raw) > _MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="chord timeline too large")
    try:
        data = json.loads(raw, parse_constant=_reject_non_finite)
    except (ValueError, UnicodeDecodeError, RecursionError) as exc:
        raise HTTPException(status_code=422, detail="invalid JSON body") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="expected a JSON object")
    try:
        return clean_entries(data.get("chords"), keep_label=False)
    except ValueError as exc:
        # The reason is one of a few fixed phrases (app/core/chord_model.py)
        # and holds nothing from the request.
        raise HTTPException(status_code=422, detail=f"invalid chord timeline: {exc}") from exc


@router.patch("/{job_id}/chords")
async def update_chords(job_id: str, request: Request) -> dict:
    """Save a corrected chord timeline: the whole list, as GET serves it.

    Written to a file of its own, so detecting again can never discard a
    correction. Stretches the list leaves out are stored as "no chord"."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    entries = await _parse_body(request)
    _job, stems_dir = _done_job(job_id)
    if not stems_dir.is_dir():
        raise HTTPException(status_code=404, detail="job not found")
    try:
        await asyncio.to_thread(chord_files.write_user, stems_dir, fill_gaps(entries))
    except OSError as exc:
        logger.exception("failed to write chord corrections for %s", job_id)
        raise HTTPException(status_code=500, detail="failed to save chords") from exc
    return {"job_id": job_id, "chords": len(entries), "edited": True}


@router.delete("/{job_id}/chords")
def reset_chords(job_id: str) -> dict:
    """Discard the corrections and go back to what the detector found. The
    detection itself is kept."""
    _job, stems_dir = _done_job(job_id)
    try:
        chord_files.delete_user(stems_dir)
    except OSError as exc:
        logger.exception("failed to discard chord corrections for %s", job_id)
        raise HTTPException(status_code=500, detail="failed to reset chords") from exc
    return {
        "job_id": job_id,
        "edited": False,
        "has_detected": chord_files.detected_path(stems_dir).is_file(),
    }
