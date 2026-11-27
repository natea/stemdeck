"""Where a song's chords live on disk, and how they are read and written.

Two files in the song's ``stems/`` folder, the way the beat grid has two
(``beats.json`` and ``beats.user.json``):

- ``chords.json`` is what the detector found (app/pipeline/chords_worker.py):
  its segments with their times untouched, each one read into a root, chord
  tones and a bass note (app/core/chord_model.py), and its own label kept
  beside them. A computed artifact. Detecting again replaces it.
- ``chords.user.json`` is the user's corrected timeline. It is never written
  by a detection, so running one again cannot discard a correction.

Neither holds a chord symbol or a beat-aligned time. The timeline the app
shows is worked out from these and the song's current beat grid each time it
is asked for (app/pipeline/chord_snap.py, app/api/chords.py), so a corrected
grid moves the chord changes with no model run.

Both travel with the song and are removed with it.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from app.core.chord_model import clean_entries

logger = logging.getLogger("stemdeck.chords")

DETECTED_NAME = "chords.json"
USER_NAME = "chords.user.json"
VERSION = 1


def detected_path(stems_dir: Path) -> Path:
    return stems_dir / DETECTED_NAME


def user_path(stems_dir: Path) -> Path:
    return stems_dir / USER_NAME


def _write(final: Path, record: dict[str, Any]) -> Path:
    """Whole or not at all: a temp file moved into place, so a kill mid-write
    never leaves half a file that reads as a chord timeline."""
    final.parent.mkdir(parents=True, exist_ok=True)
    tmp = final.with_name(f".{final.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(record), encoding="utf-8")
        os.replace(tmp, final)
    finally:
        tmp.unlink(missing_ok=True)
    return final


def _read(path: Path, *, keep_label: bool) -> dict[str, Any] | None:
    """A stored record with its entries checked, or None when there is no file
    or it cannot be trusted. A damaged file reads as "no chords": the song can
    simply be detected again."""
    if not path.is_file():
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        logger.warning("unreadable chord file %s", path, exc_info=True)
        return None
    if not isinstance(record, dict):
        return None
    try:
        record["chords"] = clean_entries(record.get("chords"), keep_label=keep_label)
    except ValueError as exc:
        logger.warning("chord file %s holds a timeline that is not valid: %s", path, exc)
        return None
    return record


def write_detected(
    stems_dir: Path,
    *,
    engine: str,
    engine_version: str,
    vocabulary: str,
    duration: float,
    chords: list[dict[str, Any]],
) -> Path:
    """Store a detection. ``chords`` are entries with their labels, in time
    order (app.pipeline.chord_labels.entries_from_segments)."""
    return _write(
        detected_path(stems_dir),
        {
            "version": VERSION,
            "engine": engine,
            "engine_version": engine_version,
            "vocabulary": vocabulary,
            "duration": round(float(duration), 3),
            "chords": clean_entries(chords, keep_label=True),
        },
    )


def read_detected(stems_dir: Path) -> dict[str, Any] | None:
    """The stored detection, or None when the song has none."""
    return _read(detected_path(stems_dir), keep_label=True)


def write_user(stems_dir: Path, chords: list[dict[str, Any]]) -> Path:
    """Store the user's corrected timeline. Raises ValueError when it is not a
    valid one."""
    return _write(
        user_path(stems_dir),
        {"version": VERSION, "chords": clean_entries(chords, keep_label=False)},
    )


def read_user(stems_dir: Path) -> list[dict[str, Any]] | None:
    """The user's corrected timeline, or None when there is none. Unreadable
    corrections are ignored: the detected chords are still the song's chords."""
    record = _read(user_path(stems_dir), keep_label=False)
    return None if record is None else record["chords"]


def delete_user(stems_dir: Path) -> bool:
    """Discard the corrections. True when there were some."""
    path = user_path(stems_dir)
    existed = path.is_file()
    path.unlink(missing_ok=True)
    return existed


def has_chords(stems_dir: Path) -> bool:
    """Whether the song has a chord file of either kind."""
    return detected_path(stems_dir).is_file() or user_path(stems_dir).is_file()
