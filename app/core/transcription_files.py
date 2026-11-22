"""Where a song's transcription lives on disk, and how it is read and written.

One JSON file per stem under ``stems/transcription/``, holding the notes as
the transcriber found them: times in seconds from the start of the song.
That is the stored truth. The quantised form is derived from it and the beat
grid whenever it is asked for (app/pipeline/quantize.py), so nothing here goes
stale when the grid is edited.

One file per stem is what makes two behaviours fall out of the layout:
transcribing a stem again replaces that stem only, and a run that fails half
way keeps the stems it finished. The folder travels with the song and is
removed with it.

Shared by the worker that writes results (app/pipeline/notes_worker.py) and
the API that serves them (app/api/jobs.py).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger("stemdeck.transcription")

DIR_NAME = "transcription"
VERSION = 1


def transcription_dir(stems_dir: Path) -> Path:
    return stems_dir / DIR_NAME


def notes_path(stems_dir: Path, stem: str) -> Path:
    return transcription_dir(stems_dir) / f"{stem}.json"


def write_notes(
    stems_dir: Path,
    stem: str,
    *,
    transcriber: str,
    model: str,
    duration: float,
    notes: list[dict],
    skipped: str | None = None,
) -> Path:
    """Write one stem's result, whole or not at all: a temp file moved into
    place, so a kill mid-write never leaves half a file that reads as a
    transcription."""
    folder = transcription_dir(stems_dir)
    folder.mkdir(parents=True, exist_ok=True)
    record: dict = {
        "version": VERSION,
        "stem": stem,
        "transcriber": transcriber,
        "model": model,
        "duration": round(float(duration), 3),
        "notes": notes,
    }
    if skipped:
        record["skipped"] = skipped
    final = notes_path(stems_dir, stem)
    tmp = final.with_name(f".{final.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(record), encoding="utf-8")
        os.replace(tmp, final)
    finally:
        tmp.unlink(missing_ok=True)
    return final


def read_notes(stems_dir: Path, stem: str) -> dict | None:
    """One stem's stored result, or None when it has none or the file is
    damaged. A damaged file reads as "not transcribed": the stem can simply be
    transcribed again."""
    path = notes_path(stems_dir, stem)
    if not path.is_file():
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("unreadable transcription %s", path, exc_info=True)
        return None
    if not isinstance(record, dict) or not isinstance(record.get("notes"), list):
        return None
    record.setdefault("stem", stem)
    return record


def transcribed_stems(stems_dir: Path) -> list[str]:
    """Names of the stems with a stored result, in name order."""
    folder = transcription_dir(stems_dir)
    if not folder.is_dir():
        return []
    return sorted(p.stem for p in folder.glob("*.json") if not p.name.startswith("."))
