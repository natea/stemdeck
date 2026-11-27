"""The chord model's libraries load in the chord worker's process and nowhere
else: the vendored lv-chordia and what it brings are imported inside
app/pipeline/chords_worker.py, so starting the app, and even importing the
chord modules, stays cheap. (tests/test_chords_vendor.py checks that the
server cannot import the model at all.)"""

from __future__ import annotations

import subprocess
import sys

_CHORD_HEAVY = ("lv_chordia", "h5py", "pretty_midi", "pydub")


def test_importing_the_app_loads_no_chord_library():
    code = (
        f"import sys, app.main\nprint(','.join(m for m in {_CHORD_HEAVY!r} if m in sys.modules))\n"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip() == ""


def test_the_chord_modules_themselves_import_no_model_library():
    """The worker imports lv-chordia inside the function that runs it, after
    its checkpoints are verified, so even importing the worker is free."""
    code = (
        "import sys, app.pipeline.chords, app.pipeline.chords_worker, "
        "app.pipeline.chord_engine, app.pipeline.chord_labels, app.pipeline.chord_snap, "
        "app.core.chord_files\n"
        f"print(','.join(m for m in ({_CHORD_HEAVY!r} + ('torch', 'librosa')) if m in sys.modules))\n"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip() == ""
