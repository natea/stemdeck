"""Stem transcription: turn a finished song's stems into notes, and take them
out as JSON, MIDI or MusicXML.

    POST /api/jobs/{id}/transcription            start a run (body: {stems?})
    GET  /api/jobs/{id}/transcription            the notes, as played or quantised
    GET  /api/jobs/{id}/transcription.mid        a MIDI file
    GET  /api/jobs/{id}/transcription.musicxml   a MusicXML score

Transcribing is a post-hoc action on a "done" job, like the lead and backing
vocal split: it runs a worker process under the pipeline lock, its failure
never fails the song, and POST /api/jobs/{id}/cancel stops it. What it stores
is the notes as the model found them. The quantised forms are worked out from
those and the song's current beat grid on every request, so a corrected grid
shows up in the next download with no model run.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from app.api.config import transcription_available
from app.api.jobs import _job_state, _pipeline_lock
from app.api.stems import _title_slug
from app.core.beat_files import read_grid
from app.core.config import (
    JOB_ID_RE,
    JOBS_DIR,
    QUANTIZE_PARTS,
    QUANTIZE_PARTS_DEFAULT,
    TRANSCRIBE_ROUTES,
)
from app.core.models import Job, JobBusy, _set
from app.core.registry import get as registry_get
from app.core.registry import operation as registry_operation
from app.core.registry import persist as registry_persist
from app.core.stem_files import stem_exists
from app.core.transcription_files import read_notes, transcribed_stems
from app.core.transcription_outcome import (
    CANCELLED,
    NO_BEAT_GRID,
    UNSUPPORTED_PLATFORM,
    WORKER_FAILED,
    message_for,
)
from app.pipeline.notes import TranscriptionError, transcribe_stems
from app.pipeline.quantize import NoBeatGrid, bars_of, grid_beats, quantize

logger = logging.getLogger("stemdeck.api")

router = APIRouter()

_MIDI_TYPE = "audio/midi"
_MUSICXML_TYPE = "application/vnd.recordare.musicxml+xml"
# The order of tracks and staves when the request names none.
_SCORE_ORDER = (
    "vocals",
    "lead_vocals",
    "backing_vocals",
    "guitar",
    "piano",
    "other",
    "bass",
    "drums",
)
# Never cached: the quantised forms change whenever the beat grid is edited.
_NO_STORE = {"Cache-Control": "no-store"}


class TranscriptionRequest(BaseModel):
    # None transcribes every stem the song has. Bounded: there are eight stem
    # names, and a request is not a place to send a megabyte of them.
    stems: list[str] | None = Field(default=None, max_length=32)


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
        {
            "detail": detail,
            "transcription_reason": code,
            "transcription_message": message_for(code),
        },
        status_code=status,
        headers=_NO_STORE,
    )


def _transcribable(job: Job, stems_dir: Path) -> list[str]:
    """The song's stems that can be transcribed, in the song's own order."""
    names = [s.get("name") for s in job.stems if isinstance(s, dict)]
    return [n for n in names if n in TRANSCRIBE_ROUTES and stem_exists(stems_dir, n)]


@router.post("/{job_id}/transcription")
async def start_transcription(job_id: str, body: TranscriptionRequest | None = None) -> Response:
    """Transcribe stems of a completed job into notes.

    With no ``stems`` it takes every stem the song has; a silent one is
    recorded as skipped. Each stem goes to the transcriber it is routed to
    (app.core.config.TRANSCRIBE_ROUTES). The response arrives when the run
    ends and is the job's state; while it runs the job reports
    ``transcription: "running"``. A stem that fails is reported in
    ``transcription_stems`` and does not stop the others."""
    job, stems_dir = _done_job(job_id)
    if not transcription_available():
        return _refusal(501, "transcription is not available here", UNSUPPORTED_PLATFORM)
    if job.transcription == "running":
        raise HTTPException(status_code=409, detail="transcription already running")
    # Refused, not queued behind it: a split or a fill is writing stems this
    # would be reading.
    if job.post_hoc_running():
        raise JobBusy()

    available = _transcribable(job, stems_dir)
    requested = body.stems if body is not None and body.stems is not None else None
    if requested is None:
        names = available
    else:
        names = list(dict.fromkeys(requested))
        unknown = [n for n in names if n not in available]
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=f"this song has no stem to transcribe named: {', '.join(map(str, unknown))}",
            )
    if not names:
        raise HTTPException(status_code=422, detail="this song has no stem to transcribe")

    # A cancel is for the run it was sent to. One left over from an earlier
    # run would otherwise read as this one being cancelled.
    job.cancel_requested = False
    job.transcription = "running"
    job.transcription_reason = None
    _set(job, stage="Transcribing stems...")
    # Saved before it starts: a restart during the run then reads it as
    # interrupted (Job.from_record) instead of running forever.
    await asyncio.to_thread(registry_persist, JOBS_DIR)

    stems_state = dict(job.transcription_stems or {})
    try:
        async with _pipeline_lock:
            # Cancelled while it waited behind an import: never start.
            if job.cancel_requested:
                raise TranscriptionError(
                    "transcription cancelled before it started", code=CANCELLED
                )
            logger.info("[%s] transcription started: %s", job_id, ", ".join(names))
            started = time.monotonic()
            with registry_operation("transcribe"):
                outcomes = await asyncio.to_thread(transcribe_stems, job, stems_dir, names)
    except Exception as e:
        logger.warning("[%s] transcription failed: %s", job_id, e, exc_info=True)
        # The song stays done with all its stems, and the stems the run did
        # finish keep their notes. Only the code leaves the server: the
        # exception's words stay in the log.
        code = getattr(e, "code", None) or (CANCELLED if job.cancel_requested else WORKER_FAILED)
        stems_state.update(getattr(e, "outcomes", None) or {})
        job.cancel_requested = False
        job.transcription = "error"
        job.transcription_reason = code
        job.transcription_stems = stems_state or None
        _set(job, stage="Done")
        await asyncio.to_thread(registry_persist, JOBS_DIR)
        return JSONResponse(
            {
                **_job_state(job),
                "detail": "transcription failed",
                "transcription_reason": code,
                "transcription_message": message_for(code),
            },
            status_code=500,
        )

    stems_state.update(outcomes)
    logger.info(
        "[%s] transcription done in %.1fs: %s",
        job_id,
        time.monotonic() - started,
        ", ".join(f"{n}={o['status']}" for n, o in outcomes.items()),
    )
    # A cancel that arrived after the worker finished lost the race. Left set,
    # it would stop the next run on this song that reads the flag.
    job.cancel_requested = False
    job.transcription = "done"
    job.transcription_reason = None
    job.transcription_stems = stems_state
    _set(job, stage="Done")
    await asyncio.to_thread(registry_persist, JOBS_DIR)
    return JSONResponse(_job_state(job))


def _records(stems_dir: Path, stems: str) -> dict[str, dict]:
    """The stored results to serve: the named stems, or every transcribed one.
    404 when the song has none, or one that was asked for is not there."""
    have = transcribed_stems(stems_dir)
    if not have:
        raise HTTPException(status_code=404, detail="nothing transcribed")
    if stems:
        wanted = [s for s in (p.strip() for p in stems.split(",")) if s]
    else:
        # Top to bottom as a score is read: voices, then the band, bass and
        # drums last. A stem with no place in the order goes after them.
        wanted = sorted(have, key=lambda n: (_SCORE_ORDER.index(n) if n in _SCORE_ORDER else 99, n))
    out: dict[str, dict] = {}
    for name in dict.fromkeys(wanted):
        record = read_notes(stems_dir, name) if name in have else None
        if record is None:
            raise HTTPException(status_code=404, detail=f"no transcription for stem: {name}")
        out[name] = record
    return out


def _check_parts(parts: int) -> int:
    if parts not in QUANTIZE_PARTS:
        raise HTTPException(
            status_code=422,
            detail=f"parts must be one of {', '.join(map(str, QUANTIZE_PARTS))}",
        )
    return parts


def _monophonic(record: dict) -> bool:
    # A pitch tracker reports one note at a time, so its quantised notes must
    # not overlap either.
    return record.get("transcriber") == "crepe"


def _quantised(records: dict[str, dict], grid: dict | None, parts: int) -> dict[str, list]:
    """Each stem's notes on the grid. NoBeatGrid when the song has none."""
    grid_beats(grid)
    return {
        name: quantize(record["notes"], grid, parts, monophonic=_monophonic(record))
        for name, record in records.items()
    }


def _with_notes(parts: dict[str, list]) -> dict[str, list]:
    """Only the stems that have notes: a silent stem is no track and no staff."""
    kept = {name: notes for name, notes in parts.items() if notes}
    if not kept:
        raise HTTPException(status_code=404, detail="nothing transcribed")
    return kept


def _no_grid() -> JSONResponse:
    return _refusal(409, "this song has no beat grid", NO_BEAT_GRID)


def _download(data: bytes, media_type: str, filename: str) -> Response:
    return Response(
        content=data,
        media_type=media_type,
        headers={**_NO_STORE, "Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _file_name(job: Job, suffix: str, ext: str) -> str:
    """Named after the song like its other downloads (app/api/stems.py)."""
    slug = _title_slug(job.title)
    return f"{slug}{suffix}.{ext}" if slug else f"transcription{suffix}.{ext}"


def _grid_summary(grid: dict | None) -> dict | None:
    if grid is None:
        return None
    return {
        "confidence": grid.get("confidence"),
        "detector": grid.get("detector"),
        "bpm": grid.get("bpm"),
        "edited": bool(grid.get("edited")),
    }


@router.get("/{job_id}/transcription")
def get_transcription(
    job_id: str,
    stems: str = Query(default="", max_length=256, description="Comma-separated stem names"),
    quantize: bool = Query(default=False, description="Snap the notes to the beat grid"),
    parts: int = Query(default=QUANTIZE_PARTS_DEFAULT, description="Parts per beat when quantised"),
) -> Response:
    """A song's transcription as JSON: each stem's notes as played, or with
    ``quantize=1`` snapped to the beat grid, each note then carrying its bar,
    beat and part. The grid's confidence and detector ride along, since a
    quantised note is only as right as the grid under it."""
    _job, stems_dir = _done_job(job_id)
    _check_parts(parts)
    records = _records(stems_dir, stems)
    grid = read_grid(stems_dir)
    try:
        grid_beats(grid)
        has_grid = True
    except NoBeatGrid:
        has_grid = False
    if quantize and not has_grid:
        return _no_grid()

    out_stems: dict[str, dict] = {}
    for name, record in records.items():
        entry = {
            "transcriber": record.get("transcriber"),
            "model": record.get("model"),
            "duration": record.get("duration"),
            "skipped": record.get("skipped"),
        }
        if quantize:
            notes = _quantised({name: record}, grid, parts)[name]
            entry["notes"] = [n.to_dict() for n in notes]
        else:
            entry["notes"] = record["notes"]
        out_stems[name] = entry
    return JSONResponse(
        {
            "job_id": job_id,
            "quantized": quantize,
            "parts": parts if quantize else None,
            "quantize_available": has_grid,
            "quantize_reason": None if has_grid else NO_BEAT_GRID,
            "grid": _grid_summary(grid) if has_grid else None,
            "stems": out_stems,
        },
        headers=_NO_STORE,
    )


@router.get("/{job_id}/transcription.mid")
def get_transcription_midi(
    job_id: str,
    stems: str = Query(default="", max_length=256, description="Comma-separated stem names"),
    quantize: bool = Query(default=False, description="Notes on the beat grid, with a tempo map"),
    parts: int = Query(default=QUANTIZE_PARTS_DEFAULT, description="Parts per beat when quantised"),
) -> Response:
    """The transcription as one Standard MIDI File, a track per stem.

    As played by default. With ``quantize=1`` the notes sit on the beat grid
    and the file carries a tempo map and time signatures from that grid, so it
    lines up with a DAW's bars and still plays in time with the song."""
    from app.pipeline.notes_midi import as_played_midi, quantised_midi

    job, stems_dir = _done_job(job_id)
    _check_parts(parts)
    records = _records(stems_dir, stems)
    title = job.title or ""
    if not quantize:
        played = _with_notes({name: record["notes"] for name, record in records.items()})
        return _download(
            as_played_midi(played, title), _MIDI_TYPE, _file_name(job, "_notes", "mid")
        )

    grid = read_grid(stems_dir)
    try:
        notes = _quantised(records, grid, parts)
    except NoBeatGrid:
        return _no_grid()
    assert grid is not None
    beats = grid_beats(grid)
    data = quantised_midi(_with_notes(notes), beats, bars_of(grid, len(beats)), parts, title)
    return _download(data, _MIDI_TYPE, _file_name(job, "_notes_quantised", "mid"))


@router.get("/{job_id}/transcription.musicxml")
def get_transcription_musicxml(
    job_id: str,
    stems: str = Query(default="", max_length=256, description="Comma-separated stem names"),
    parts: int = Query(default=QUANTIZE_PARTS_DEFAULT, description="Parts per beat"),
) -> Response:
    """The quantised transcription as a MusicXML score, a part per stem, with
    bars and time signatures from the beat grid, a tempo marking and the
    song's detected key."""
    from app.pipeline.notes_musicxml import musicxml_score

    job, stems_dir = _done_job(job_id)
    _check_parts(parts)
    records = _records(stems_dir, stems)
    grid = read_grid(stems_dir)
    try:
        notes = _quantised(records, grid, parts)
    except NoBeatGrid:
        return _no_grid()
    assert grid is not None
    beats = grid_beats(grid)
    data = musicxml_score(
        _with_notes(notes),
        bars_of(grid, len(beats)),
        parts,
        title=job.title or "",
        bpm=grid.get("bpm") or job.bpm,
        key_name=job.key,
        scale=getattr(job, "scale", None),
    )
    return _download(data, _MUSICXML_TYPE, _file_name(job, "", "musicxml"))
