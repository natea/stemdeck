"""Saving a separated stem when torchaudio cannot (torchaudio 2.9 and later
without torchcodec): the worker writes the same 16-bit WAV with soundfile."""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf
import torch

from app.pipeline import demucs_worker


def _stem() -> torch.Tensor:
    t = torch.arange(4410) / 44100
    return torch.stack(
        [0.5 * torch.sin(2 * torch.pi * 440 * t), 0.25 * torch.sin(2 * torch.pi * 220 * t)]
    )


def test_a_stem_is_saved_as_16_bit_stereo(tmp_path):
    path = tmp_path / "bass.wav"
    demucs_worker._save_stem(_stem(), str(path), 44100)
    info = sf.info(str(path))
    assert (info.samplerate, info.channels, info.subtype, info.frames) == (44100, 2, "PCM_16", 4410)


def test_without_torchcodec_the_same_file_is_written_with_soundfile(tmp_path, monkeypatch):
    import demucs.audio

    reference = tmp_path / "reference.wav"
    demucs_worker._save_stem(_stem(), str(reference), 44100)

    def refuses(*args, **kwargs):
        raise ImportError(
            "TorchCodec is required for save_with_torchcodec. Please install torchcodec"
        )

    monkeypatch.setattr(demucs.audio, "save_audio", refuses)
    path = tmp_path / "bass.wav"
    demucs_worker._save_stem(_stem(), str(path), 44100)
    info = sf.info(str(path))
    assert (info.samplerate, info.channels, info.subtype, info.frames) == (44100, 2, "PCM_16", 4410)
    got, _ = sf.read(str(path), dtype="int16")
    want, _ = sf.read(str(reference), dtype="int16")
    # The same samples, to within one step of 16-bit rounding.
    assert np.abs(got.astype(int) - want.astype(int)).max() <= 1


def test_a_loud_stem_is_rescaled_not_clipped_in_the_fallback(tmp_path, monkeypatch):
    import demucs.audio

    monkeypatch.setattr(
        demucs.audio, "save_audio", lambda *a, **k: (_ for _ in ()).throw(ImportError("torchcodec"))
    )
    path = tmp_path / "loud.wav"
    demucs_worker._save_stem(_stem() * 4, str(path), 44100)
    got, _ = sf.read(str(path), dtype="float32")
    assert np.abs(got).max() <= 1.0
    assert np.abs(got).max() > 0.9


def test_any_other_save_failure_is_not_swallowed(tmp_path, monkeypatch):
    import demucs.audio

    def disk_full(*args, **kwargs):
        raise OSError("No space left on device")

    monkeypatch.setattr(demucs.audio, "save_audio", disk_full)
    with pytest.raises(OSError):
        demucs_worker._save_stem(_stem(), str(tmp_path / "x.wav"), 44100)
    assert not (tmp_path / "x.wav").exists()
