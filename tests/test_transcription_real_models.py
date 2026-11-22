"""The piano and YourMT3+ models, for real. Slow, and off by default.

They download 172 MB and 536 MB of weights on first use and take tens of
seconds to load, so the suite does not run them unless asked:

    STEMDECK_TEST_REAL_MODELS=1 uv run pytest tests/test_transcription_real_models.py -q

CREPE is not here: its weights ship in its package, so it is tested for real
in tests/test_transcription.py on every run. Everything else about these two
adapters (how their output becomes notes) is covered there with the model
mocked.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from app.pipeline import notes_adapters as adapters

pytestmark = pytest.mark.skipif(
    os.environ.get("STEMDECK_TEST_REAL_MODELS") != "1",
    reason="slow: downloads and runs the real models; set STEMDECK_TEST_REAL_MODELS=1",
)

SR = adapters.MODEL_SR
# Two-note chords a major third apart, half a second each.
ROOTS = (60, 62, 64, 65)


def _tone(midi: int, seconds: float) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    f = 440.0 * 2 ** ((midi - 69) / 12)
    env = np.minimum(1.0, t / 0.005) * np.exp(-t * 3)
    wave = (
        np.sin(2 * np.pi * f * t)
        + 0.5 * np.sin(4 * np.pi * f * t)
        + 0.25 * np.sin(6 * np.pi * f * t)
    )
    return (0.4 * env * wave).astype(np.float32)


@pytest.fixture(scope="module")
def chords() -> np.ndarray:
    parts = [np.zeros(SR // 2, np.float32)]
    parts += [_tone(root, 0.5) + _tone(root + 4, 0.5) for root in ROOTS]
    parts.append(np.zeros(SR, np.float32))
    return np.concatenate(parts)


def _starting_near(notes, seconds, tolerance=0.08):
    return {n["pitch"] for n in notes if abs(n["start"] - seconds) <= tolerance}


def test_yourmt3_hears_the_chords(chords):
    transcriber = adapters.Mt3Transcriber()
    transcriber.load("cpu")
    notes = transcriber.transcribe(chords, "guitar")
    for i, root in enumerate(ROOTS):
        assert {root, root + 4} <= _starting_near(notes, 0.5 + 0.5 * i), (root, notes)
    # A pitched stem gets no percussion, and the drums stem no pitched notes.
    assert transcriber.transcribe(chords, "drums") == [] or all(
        35 <= n["pitch"] <= 81 for n in transcriber.transcribe(chords, "drums")
    )


def test_the_piano_model_hears_the_chords(chords):
    transcriber = adapters.PianoTranscriber()
    transcriber.load("cpu")
    notes = transcriber.transcribe(chords, "piano")
    assert all(21 <= n["pitch"] <= 108 and 1 <= n["velocity"] <= 127 for n in notes)
    for i, root in enumerate(ROOTS):
        # The tones are synthetic and rich in overtones, so the model also
        # reports some harmonics; the fundamentals must be among what it hears.
        assert {root, root + 4} <= _starting_near(notes, 0.5 + 0.5 * i), (root, notes)
