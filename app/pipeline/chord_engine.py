"""The chord model: where its vendored code and its checkpoints live.

lv-chordia 1.1.0 (MIT), the ISMIR 2019 large-vocabulary chord model from
Music X Lab, is vendored in app/_vendor/chords as its PyPI wheel ships it
(that folder's README says what was left out, and why), and runs on the torch
StemDeck already ships. Its five checkpoints (28.7 MB, MIT) are not in the
package: they are fetched on first use, by the parent, never by the worker
(app/pipeline/chords.py, app/core/model_fetch.py).

Two halves, like piano_hr.py:

- In the server: where the vendored code and the checkpoints live, what they
  are (manifest.json), and which checkpoints are on disk at their pinned
  size. Nothing here imports torch or the vendored package.
- In the worker (app/pipeline/chords_worker.py): `install` puts the vendored
  folders first on sys.path and `use_checkpoints` tells the package where its
  checkpoints are.

The package imports three libraries it does not need to name a chord:

- pretty_midi (with mido and importlib_resources): the copies vendored for
  MIDI, in app/_vendor/transcribe, the same versions lv-chordia asks for.
- h5py, a compiled library its training storage uses. A stand-in that holds
  nothing (app/_vendor/chords/shim/h5py) satisfies the import; a chord run
  never touches it.
- pydub, which StemDeck's own environment has.
"""

from __future__ import annotations

import json
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.core.config import (
    CHORDS_CHECKPOINT_RELDIR,
    CHORDS_CHECKPOINT_SHA256,
    CHORDS_CHECKPOINT_SIZE,
    CHORDS_CHECKPOINT_URL_BASE,
)

_VENDOR_ROOT = Path(__file__).resolve().parent.parent / "_vendor"
VENDOR_DIR = _VENDOR_ROOT / "chords"
SHIM_DIR = VENDOR_DIR / "shim"
# pretty_midi, mido and importlib_resources, as vendored for MIDI.
MIDI_VENDOR_DIR = _VENDOR_ROOT / "transcribe"
MANIFEST_PATH = VENDOR_DIR / "manifest.json"

ENGINE_ID = "lv_chordia"
ENGINE_LABEL = "lv-chordia"
ENGINE_LICENCE = "MIT"
PACKAGE = "lv-chordia"


@lru_cache(maxsize=1)
def manifest() -> dict[str, Any]:
    """manifest.json as written when the engine was vendored, or {}."""
    try:
        data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def engine_version() -> str | None:
    for package in manifest().get("packages") or []:
        if isinstance(package, dict) and package.get("name") == PACKAGE:
            version = package.get("version")
            return version if isinstance(version, str) else None
    return None


def vendor_id() -> str | None:
    """A short id of the exact vendored wheel (a hash of its sha256)."""
    value = manifest().get("id")
    return value if isinstance(value, str) else None


def vendored() -> bool:
    """Whether the vendored code is all there (cheap file lookups)."""
    return (
        engine_version() is not None
        and (VENDOR_DIR / "lv_chordia" / "chord_recognition.py").is_file()
        and (SHIM_DIR / "h5py" / "__init__.py").is_file()
        and (MIDI_VENDOR_DIR / "pretty_midi" / "__init__.py").is_file()
    )


# -- the checkpoints


def checkpoint_files() -> list:
    """The five checkpoints as pinned stem_models.ModelFile, under MODELS_DIR.
    The address holds the file's own name, parentheses and comma included:
    they are legal in a URL path as they are, and a ModelFile takes no "%"."""
    from app.core.stem_models import ModelFile

    return [
        ModelFile(
            url=CHORDS_CHECKPOINT_URL_BASE + name,
            sha256=sha256,
            size=CHORDS_CHECKPOINT_SIZE[name],
            relpath=f"{CHORDS_CHECKPOINT_RELDIR}/{name}",
        )
        for name, sha256 in CHORDS_CHECKPOINT_SHA256.items()
    ]


def checkpoint_paths() -> list[tuple[Path, int]]:
    """(path, pinned size) of each checkpoint."""
    from app.core.stem_models import model_path

    return [(model_path(f), f.size) for f in checkpoint_files()]


def checkpoint_dir() -> Path:
    """The folder the five checkpoints are kept in."""
    return checkpoint_paths()[0][0].parent


def missing_checkpoints() -> list:
    """The checkpoints to download: not on disk, or not at the pinned size.
    Size only; the worker reads each whole file against its SHA-256."""
    out = []
    for model_file, (path, size) in zip(checkpoint_files(), checkpoint_paths(), strict=True):
        try:
            on_disk = path.stat().st_size
        except OSError:
            on_disk = -1
        if on_disk != size:
            out.append(model_file)
    return out


def checkpoints_state() -> str:
    """ "downloaded" (all five at their pinned size), "not_downloaded" (none
    on disk) or "partial"."""
    missing = len(missing_checkpoints())
    if not missing:
        return "downloaded"
    on_disk = sum(1 for path, _size in checkpoint_paths() if path.exists())
    return "partial" if on_disk else "not_downloaded"


# -- in the worker


def install() -> None:
    """Put the vendored folders first on sys.path, the stand-ins before the
    package. Only app/pipeline/chords_worker.py calls this: the server never
    has these folders on its path."""
    for folder in (MIDI_VENDOR_DIR, VENDOR_DIR, SHIM_DIR):
        value = str(folder)
        if value in sys.path:
            sys.path.remove(value)
        sys.path.insert(0, value)


def use_checkpoints(folder: Path) -> None:
    """Tell the installed package where its checkpoints are. Left alone it
    looks in <prefix>/share/lv-chordia/cache_data, then beside itself; it
    reads this name each time a model is built."""
    from lv_chordia.mir import common

    common.CACHE_DATA_PATH = str(folder)
