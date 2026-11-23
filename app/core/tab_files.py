"""A song's tablature choices: tuning, capo, and staff or tab or both, for
each stem that can be shown as tab (app.core.config.TAB_STEMS).

Stored as ``stems/transcription/tab.json`` beside the notes
(app/core/transcription_files.py), so it travels with the song and is removed
with it. It is the one thing about notation kept on disk besides the notes
themselves, because the exports depend on it: the fingering
(app/pipeline/fingering.py) is worked out from the stored notes and these
choices on every request, so changing a tuning never touches the notes and
never needs a transcription run.

A song with no file, or with an unreadable one, has the defaults: standard
tuning, no capo, staff and tab together.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from app.core.config import (
    TAB_CUSTOM_PITCH_MAX,
    TAB_CUSTOM_PITCH_MIN,
    TAB_CUSTOM_STRINGS_MAX,
    TAB_CUSTOM_STRINGS_MIN,
    TAB_DEFAULT_DISPLAY,
    TAB_DEFAULT_PRESET,
    TAB_DISPLAYS,
    TAB_MAX_CAPO,
    TAB_STEMS,
    TAB_TUNINGS,
)
from app.core.transcription_files import transcription_dir

logger = logging.getLogger("stemdeck.transcription")

FILE_NAME = "tab.json"  # its stem is in transcription_files.NOT_STEMS
CUSTOM = "custom"


class TabSettingsError(ValueError):
    """A tab choice that cannot be saved. The message says which and why."""


def tab_path(stems_dir: Path) -> Path:
    return transcription_dir(stems_dir) / FILE_NAME


def default_choice(stem: str) -> dict:
    return {
        "preset": TAB_DEFAULT_PRESET,
        "tuning": list(TAB_TUNINGS[stem][TAB_DEFAULT_PRESET]),
        "capo": 0,
        "display": TAB_DEFAULT_DISPLAY,
    }


def _tuning(stem: str, raw: object) -> list[int]:
    """A typed-in tuning, checked: open-string pitches, lowest string first."""
    if not isinstance(raw, list) or any(isinstance(p, bool) or not isinstance(p, int) for p in raw):
        raise TabSettingsError(f"{stem}: a tuning is a list of whole MIDI pitches")
    if not TAB_CUSTOM_STRINGS_MIN <= len(raw) <= TAB_CUSTOM_STRINGS_MAX:
        raise TabSettingsError(
            f"{stem}: a tuning has {TAB_CUSTOM_STRINGS_MIN} to {TAB_CUSTOM_STRINGS_MAX} strings"
        )
    if any(not TAB_CUSTOM_PITCH_MIN <= p <= TAB_CUSTOM_PITCH_MAX for p in raw):
        raise TabSettingsError(
            f"{stem}: each string is a pitch from {TAB_CUSTOM_PITCH_MIN} to {TAB_CUSTOM_PITCH_MAX}"
        )
    return list(raw)


def _preset_of(stem: str, tuning: list[int]) -> str:
    """The name of the preset with exactly these strings, or "custom"."""
    for name, strings in TAB_TUNINGS[stem].items():
        if list(strings) == tuning:
            return name
    return CUSTOM


def merge_choice(stem: str, current: dict, change: object) -> dict:
    """``current`` with ``change`` applied, or TabSettingsError.

    ``change`` may name a ``preset`` or give a ``tuning`` (which becomes the
    preset it equals, or "custom"), and may set ``capo`` and ``display``.
    Keys it leaves out keep their value."""
    if not isinstance(change, dict):
        raise TabSettingsError(f"{stem}: expected an object of choices")
    unknown = sorted(set(change) - {"preset", "tuning", "capo", "display"})
    if unknown:
        raise TabSettingsError(f"{stem}: unknown choice: {', '.join(map(str, unknown))}")
    out = dict(current)

    if "tuning" in change:
        tuning = _tuning(stem, change["tuning"])
        named = change.get("preset")
        if named not in (None, CUSTOM) and list(TAB_TUNINGS[stem].get(named, ())) != tuning:
            raise TabSettingsError(f"{stem}: the tuning given is not the preset named")
        out["tuning"] = tuning
        out["preset"] = _preset_of(stem, tuning)
    elif "preset" in change:
        named = change["preset"]
        if named == CUSTOM:
            raise TabSettingsError(f"{stem}: a custom tuning needs its strings")
        if not isinstance(named, str) or named not in TAB_TUNINGS[stem]:
            raise TabSettingsError(
                f"{stem}: the tunings on offer are: {', '.join(TAB_TUNINGS[stem])}"
            )
        out["preset"] = named
        out["tuning"] = list(TAB_TUNINGS[stem][named])

    if "capo" in change:
        capo = change["capo"]
        if isinstance(capo, bool) or not isinstance(capo, int) or not 0 <= capo <= TAB_MAX_CAPO:
            raise TabSettingsError(f"{stem}: the capo is a fret from 0 to {TAB_MAX_CAPO}")
        out["capo"] = capo

    if "display" in change:
        if change["display"] not in TAB_DISPLAYS:
            raise TabSettingsError(f"{stem}: display is one of: {', '.join(TAB_DISPLAYS)}")
        out["display"] = change["display"]
    return out


def read_tab(stems_dir: Path) -> dict[str, dict]:
    """Every tab stem's choices, with defaults for whatever the file lacks.

    A stored choice that no longer passes the checks (a hand-edited file, a
    preset since renamed) falls back to that stem's default rather than
    failing the score."""
    out = {stem: default_choice(stem) for stem in TAB_STEMS}
    path = tab_path(stems_dir)
    if not path.is_file():
        return out
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("unreadable tab settings %s", path, exc_info=True)
        return out
    if not isinstance(stored, dict):
        return out
    for stem in TAB_STEMS:
        if stem not in stored:
            continue
        try:
            raw = stored[stem] if isinstance(stored[stem], dict) else {}
            known = {k: raw[k] for k in ("tuning", "capo", "display") if k in raw}
            # The strings are what was chosen; the name is only a label for
            # them. A file that has a name alone is read by the name.
            if "tuning" not in raw and "preset" in raw:
                known["preset"] = raw["preset"]
            out[stem] = merge_choice(stem, out[stem], known)
        except TabSettingsError:
            logger.warning("ignoring stored tab settings for %s in %s", stem, path)
    return out


def write_tab(stems_dir: Path, choices: dict[str, dict]) -> Path:
    """Write the choices, whole or not at all: a temp file moved into place,
    so a kill mid-write never leaves half a file."""
    folder = transcription_dir(stems_dir)
    folder.mkdir(parents=True, exist_ok=True)
    final = tab_path(stems_dir)
    tmp = final.with_name(f".{final.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps({s: choices[s] for s in TAB_STEMS}), encoding="utf-8")
        os.replace(tmp, final)
    finally:
        tmp.unlink(missing_ok=True)
    return final


def update_tab(stems_dir: Path, changes: object) -> dict[str, dict]:
    """Apply ``changes`` ({stem: {choice: value}}) and save. Nothing is saved
    when any part of it is refused. Returns every stem's choices."""
    if not isinstance(changes, dict) or not changes:
        raise TabSettingsError("expected choices for at least one of: " + ", ".join(TAB_STEMS))
    unknown = sorted(str(k) for k in changes if k not in TAB_STEMS)
    if unknown:
        raise TabSettingsError(
            f"no tablature for: {', '.join(unknown)} (only {', '.join(TAB_STEMS)})"
        )
    choices = read_tab(stems_dir)
    for stem, change in changes.items():
        choices[stem] = merge_choice(stem, choices[stem], change)
    write_tab(stems_dir, choices)
    return choices
