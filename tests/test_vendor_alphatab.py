"""The vendored alphaTab files are the ones its VERSION file says they are.

static/vendor/alphatab/ holds unmodified copies from the npm package
@coderline/alphatab (openspec change add-alphatab-notation). MPL-2.0 asks
nothing more of unmodified files than the license text and a notice, so a
file edited in place would quietly change what the project owes. This test
fails when a file no longer matches the hash recorded when it was copied.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

VENDOR = Path(__file__).resolve().parents[1] / "static" / "vendor" / "alphatab"
EXPECTED = {
    "alphaTab.min.mjs",
    "alphaTab.core.min.mjs",
    "alphaTab.worker.min.mjs",
    "font/Bravura.woff2",
    "LICENSE",
    "font/Bravura-OFL.txt",
}


def _recorded() -> dict[str, str]:
    out: dict[str, str] = {}
    for line in (VENDOR / "VERSION").read_text(encoding="utf-8").splitlines():
        m = re.fullmatch(r"([0-9a-f]{64})  (\S+)", line)
        if m:
            out[m.group(2)] = m.group(1)
    return out


def test_version_file_names_the_release() -> None:
    text = (VENDOR / "VERSION").read_text(encoding="utf-8")
    assert text.startswith("alphaTab 1.9.0\n")
    assert "@coderline/alphatab@1.9.0" in text


def test_every_vendored_file_matches_its_recorded_hash() -> None:
    recorded = _recorded()
    assert set(recorded) == EXPECTED
    for name, digest in recorded.items():
        assert hashlib.sha256((VENDOR / name).read_bytes()).hexdigest() == digest, name


def test_nothing_else_is_vendored() -> None:
    """No soundfont, worklet or second build: the view never plays sound."""
    found = {p.relative_to(VENDOR).as_posix() for p in VENDOR.rglob("*") if p.is_file()}
    assert found == EXPECTED | {"VERSION"}


def test_notices_name_the_version_and_both_licenses() -> None:
    root = VENDOR.parents[2]
    for platform in ("linux", "macos", "windows"):
        text = (root / "packaging" / platform / "THIRD_PARTY_NOTICES.txt").read_text(
            encoding="utf-8"
        )
        assert "alphaTab 1.9.0" in text, platform
        assert "https://www.mozilla.org/MPL/2.0/" in text, platform
        assert "SIL Open Font License 1.1" in text, platform
        assert "https://openfontlicense.org/open-font-license-official-text/" in text, platform
