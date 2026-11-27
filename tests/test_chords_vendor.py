"""The vendored chord model in app/_vendor/chords.

One PyPI wheel unpacked as it ships (README.md there says how), checked here
file by file against the wheel's own RECORD, so an edit to vendored code, a
line-ending rewrite by git or a partial refresh fails the suite. And the
model stays out of the server process: only the chord worker imports it,
with the copies of pretty_midi and mido vendored for MIDI and a stand-in for
h5py.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

from app.core import config
from app.pipeline import chord_engine

VENDOR = chord_engine.VENDOR_DIR
# (version, wheel sha256 as PyPI publishes it, licence)
EXPECTED = (
    "1.1.0",
    "292241f03e1029e6739ee7a2a91fbe348c25c97b8b3641db76cbef9f9dee0cb0",
    "MIT",
)
# StemDeck's own files in the folder: not part of the wheel.
OWN = ("manifest.json", "README.md", "shim/h5py/__init__.py")


def _manifest() -> dict:
    return json.loads((VENDOR / "manifest.json").read_text(encoding="utf-8"))


def _record_hash(data: bytes) -> str:
    digest = hashlib.sha256(data).digest()
    return "sha256=" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _record(package: dict) -> list[tuple[str, str]]:
    """(name, hash) of every line of the wheel's RECORD. Read as CSV: the
    checkpoints' names hold a comma."""
    text = (VENDOR / package["dist_info"] / "RECORD").read_text(encoding="utf-8")
    return [(row[0], row[1]) for row in csv.reader(text.splitlines()) if row]


def test_the_manifest_names_the_exact_wheel():
    manifest = _manifest()
    (package,) = manifest["packages"]
    assert package["name"] == "lv-chordia"
    assert (package["version"], package["sha256"], package["licence"]) == EXPECTED
    assert package["url"].endswith("/" + package["wheel"])
    ident = hashlib.sha256(package["sha256"].encode())
    assert manifest["id"] == ident.hexdigest()[:16] == chord_engine.vendor_id()
    assert chord_engine.engine_version() == EXPECTED[0]
    assert chord_engine.vendored()


def test_every_vendored_file_matches_the_wheel_record():
    manifest = _manifest()
    (package,) = manifest["packages"]
    listed = {VENDOR / name for name in OWN}
    removed = set(package["removed"])
    for name, digest in _record(package):
        path = VENDOR / name
        if name in removed:
            assert not path.exists(), f"{name} was left out on purpose"
            continue
        listed.add(path)
        assert path.is_file(), f"{name} is missing"
        if digest:
            assert _record_hash(path.read_bytes()) == digest, f"{name} was changed"
    present = {p for p in VENDOR.rglob("*") if p.is_file() and "__pycache__" not in p.parts}
    assert present - listed == set(), "files that are not in the wheel"
    assert package["files"] == len(listed) - len(OWN)
    assert manifest["shim"] == ["shim/h5py/__init__.py"]


def test_left_out_on_purpose():
    # The checkpoints (downloaded on first use), the pickled training tables
    # and the training lists. What is left of data/ is the four chord lists.
    assert not list(VENDOR.rglob("*.sdict"))
    assert not list(VENDOR.rglob("*.pkl"))
    assert not list(VENDOR.rglob("*.csv"))
    assert sorted(p.name for p in (VENDOR / "lv_chordia" / "data").iterdir()) == [
        "extended_chord_list.txt",
        "full_chord_list.txt",
        "ismir2017_chord_list.txt",
        "submission_chord_list.txt",
    ]


def test_the_licence_travels_with_the_code():
    licence = VENDOR / "lv_chordia-1.1.0.dist-info" / "licenses" / "LICENSE"
    assert "MIT License" in licence.read_text(encoding="utf-8")
    readme = (VENDOR / "README.md").read_text(encoding="utf-8")
    assert EXPECTED[0] in readme and EXPECTED[1][:16] in readme


def test_the_checkpoints_are_pinned_to_the_authors_repository():
    files = chord_engine.checkpoint_files()
    assert len(files) == 5
    for model_file in files:
        name = model_file.relpath.rpartition("/")[2]
        assert model_file.relpath == f"{config.CHORDS_CHECKPOINT_RELDIR}/{name}"
        assert model_file.url == config.CHORDS_CHECKPOINT_URL_BASE + name
        assert config.CHORDS_CHECKPOINT_REVISION in model_file.url
        assert model_file.url.startswith("https://raw.githubusercontent.com/music-x-lab/")
        assert model_file.sha256 == config.CHORDS_CHECKPOINT_SHA256[name]
        assert model_file.size == config.CHORDS_CHECKPOINT_SIZE[name]
    # The wheel carries the same five files; its RECORD agrees on each hash.
    (package,) = _manifest()["packages"]
    in_wheel = {
        name.rpartition("/")[2]: digest
        for name, digest in _record(package)
        if name.endswith(".sdict")
    }
    for name, sha256 in config.CHORDS_CHECKPOINT_SHA256.items():
        raw = bytes.fromhex(sha256)
        assert in_wheel[name] == "sha256=" + base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _isolated_env(tmp_path: Path) -> dict[str, str]:
    """The subprocess's library, data and cache folders: a temp dir, never
    the one this machine's app uses."""
    env = dict(os.environ)
    for key, sub in (
        ("STEMDECK_JOBS_DIR", "jobs"),
        ("STEMDECK_DATA_DIR", "data"),
        ("STEMDECK_CACHE_DIR", "cache"),
    ):
        env[key] = str(tmp_path / sub)
    return env


def test_the_server_process_cannot_import_the_model(tmp_path):
    """app/__init__ puts app/_vendor on sys.path; the model is one folder
    further in, so `import lv_chordia` fails in the server, and so does the
    stand-in h5py. Checked in a fresh interpreter."""
    code = textwrap.dedent(
        """
        import importlib.util
        import app.api.router  # noqa: F401
        import app.pipeline.chords, app.pipeline.chord_engine  # noqa: F401
        print(all(importlib.util.find_spec(n) is None for n in ("lv_chordia", "h5py")))
        """
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=120,
        env=_isolated_env(tmp_path),
    )
    assert out.stdout.strip().splitlines()[-1] == "True", out.stderr[-2000:]


def test_the_worker_imports_the_model_from_the_vendored_copies(tmp_path):
    """After chord_engine.install(), the package, pretty_midi and mido come
    from app/_vendor, h5py is the stand-in, and the package is told where
    the checkpoints are."""
    code = textwrap.dedent(
        f"""
        from app.pipeline import chord_engine
        chord_engine.install()
        import lv_chordia
        from lv_chordia.chord_recognition import chord_recognition  # noqa: F401
        import h5py, mido, pretty_midi
        root = {str(VENDOR.parent)!r}
        for m in (lv_chordia, h5py, mido, pretty_midi):
            assert m.__file__.startswith(root), m.__file__
        assert h5py.__file__.startswith({str(chord_engine.SHIM_DIR)!r})
        try:
            h5py.File
        except RuntimeError as exc:
            assert "not part of StemDeck" in str(exc)
        else:
            raise AssertionError("the stand-in answered")
        chord_engine.use_checkpoints({str(tmp_path)!r})
        from lv_chordia.mir import common
        assert common.CACHE_DATA_PATH == {str(tmp_path)!r}
        print("ok")
        """
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=180,
        env=_isolated_env(tmp_path),
    )
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip().splitlines()[-1] == "ok"
