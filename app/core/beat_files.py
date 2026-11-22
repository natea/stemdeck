"""Reading a song's beat grid as the app uses it.

The detected grid is `stems/beats.json` (app/pipeline/beatgrid.py), a computed
artifact that never changes. The user's corrections live beside it in
`stems/beats.user.json`, so re-running analysis cannot discard them. Everything
that keeps time with the song wants the two merged: the click track through
GET /api/jobs/{id}/beats, and the note quantiser (app/pipeline/quantize.py).
They read it here, through one function, so they cannot disagree about where
the beats are.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger("stemdeck.beats")

COMPUTED_NAME = "beats.json"
USER_NAME = "beats.user.json"


def read_grid(stems_dir: Path) -> dict | None:
    """The merged beat grid of the song in ``stems_dir``, or None when it has
    no detected grid or that file cannot be read.

    The user's edits override the detected beats and bar marks but keep the
    computed onsets, which the editor still needs for snapping and which
    editing never changes. Unreadable edits are ignored: the detected grid is
    still the song's grid."""
    computed_path = stems_dir / COMPUTED_NAME
    if not computed_path.is_file():
        return None
    try:
        grid = json.loads(computed_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.exception("unreadable beat grid in %s", stems_dir)
        return None
    if not isinstance(grid, dict):
        logger.warning("beat grid in %s is not an object", stems_dir)
        return None

    user_path = stems_dir / USER_NAME
    if user_path.is_file():
        try:
            edits = json.loads(user_path.read_text(encoding="utf-8"))
            if isinstance(edits.get("beats"), list) and edits["beats"]:
                grid["beats"] = edits["beats"]
                grid["bars"] = edits.get("bars") or []
                grid["edited"] = True
        except (OSError, json.JSONDecodeError, AttributeError):
            logger.warning("ignoring unreadable beat edits in %s", stems_dir)

    grid.setdefault("bars", [])
    grid.setdefault("edited", False)
    return grid
