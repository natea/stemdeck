"""Transcription adds several heavy libraries. None of them may load with the
app: they belong to a worker process that runs on demand, and to an export
that is built when someone asks for it.
"""

from __future__ import annotations

import subprocess
import sys

_HEAVY = (
    "music21",
    "mt3_infer",
    "torchcrepe",
    "piano_transcription_inference",
    "transformers",
)


def test_importing_the_app_loads_no_transcription_library():
    code = f"import sys, app.main\nprint(','.join(m for m in {_HEAVY!r} if m in sys.modules))\n"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip() == ""


def test_the_adapters_module_itself_imports_no_model_library():
    """The API never imports it, but if it ever does, it still costs nothing:
    the model libraries are imported inside the classes that use them."""
    code = (
        "import sys, app.pipeline.notes_adapters, app.pipeline.notes_worker\n"
        f"print(','.join(m for m in {_HEAVY!r} if m in sys.modules))\n"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip() == ""


def test_transformers_is_a_version_yourmt3_runs_on():
    """mt3-infer's vendored YourMT3+ decoder breaks on transformers 4.46 and
    later (measured: 4.46.3 and 4.47.1 fail in the decoder, 5.x does not
    import). pyproject.toml caps it; this fails loudly if the cap is lifted."""
    from importlib.metadata import version

    major, minor = (int(p) for p in version("transformers").split(".")[:2])
    assert (major, minor) == (4, 45)
