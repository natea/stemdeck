"""The chord model, for real. Off by default.

It needs the model's five checkpoints on disk (detect chords once in the app,
or press Download in Settings > Models), loads torch and takes several
seconds, and the rest of the worker is covered without it in
tests/test_chords_worker.py. Run it when the vendored package or a pin changes:

    STEMDECK_TEST_REAL_MODELS=1 uv run pytest tests/test_chords_real_model.py -q
"""

from __future__ import annotations

import os
import wave

import numpy as np
import pytest

from app.core import chord_files
from app.pipeline import chords_worker as worker
from tests.ffmpeg_probe import skip_without_ffmpeg

pytestmark = pytest.mark.skipif(
    os.environ.get("STEMDECK_TEST_REAL_MODELS") != "1",
    reason="slow: loads and runs the real chord model; set STEMDECK_TEST_REAL_MODELS=1",
)

SR = 44100
SECONDS = 3.0
# C, F, G, C as close-position major triads around middle C.
PROGRESSION = ((60, 64, 67), (60, 65, 69), (59, 62, 67), (60, 64, 67))
ROOTS = [0, 5, 7, 0]


def _note(midi: int, seconds: float) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    f = 440.0 * 2 ** ((midi - 69) / 12)
    env = np.minimum(1.0, t / 0.01) * np.exp(-t * 0.8)
    wave_ = sum(np.sin(2 * np.pi * f * k * t) / k for k in (1, 2, 3, 4))
    return (wave_ * env).astype(np.float32)


def _song(path) -> None:
    parts = []
    for chord in PROGRESSION:
        # The triad, and its root an octave and two below as a bass note.
        root = min(chord, key=lambda m: (m - ROOTS[len(parts)]) % 12)
        voices = [*chord, root - 12, root - 24]
        parts.append(sum(_note(m, SECONDS) for m in voices))
    audio = np.concatenate(parts)
    audio = audio / np.max(np.abs(audio)) * 0.5
    pcm = (audio * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(pcm.tobytes())


def test_the_model_names_a_plain_progression(tmp_path):
    skip_without_ffmpeg()
    from app.pipeline import chord_engine

    if chord_engine.missing_checkpoints():
        pytest.skip("the chord model's checkpoints are not downloaded here")
    stems = tmp_path / "song" / "stems"
    stems.mkdir(parents=True)
    _song(stems / "piano.wav")

    result = worker.run(stems)

    assert result["lanes"] == ["piano"]
    record = chord_files.read_detected(stems)
    assert record["engine"] == "lv-chordia" and record["vocabulary"] == "full"
    assert record["duration"] == pytest.approx(len(PROGRESSION) * SECONDS, abs=0.05)
    named = [c for c in record["chords"] if c["root"] is not None]
    # The four roots in order; a chord may come as more than one entry (the
    # same chord over another bass note), so neighbours are folded.
    roots: list[int] = []
    for chord in named:
        if not roots or roots[-1] != chord["root"]:
            roots.append(chord["root"])
    assert roots == ROOTS, [c["label"] for c in record["chords"]]
    # Each change within half a second of where it was played.
    for index in range(1, len(PROGRESSION)):
        expected = index * SECONDS
        assert any(abs(c["start"] - expected) < 0.5 for c in named if c["root"] == ROOTS[index])
    assert sorted(p.name for p in stems.iterdir()) == ["chords.json", "piano.wav"]
