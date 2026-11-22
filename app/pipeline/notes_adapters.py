"""The three transcribers behind app/pipeline/notes_worker.py.

Each turns one decoded stem into the stored note shape
({"start", "end", "pitch", "velocity"}, times in seconds):

- ``CrepeTranscriber``: CREPE (torchcrepe) tracks one pitch per 10 ms, and
  app/pipeline/pitch_notes.py turns that curve into notes. For stems that
  sound one note at a time: vocals, lead vocals, bass.
- ``PianoTranscriber``: the ByteDance high-resolution piano model
  (piano-transcription-inference). Polyphonic, with velocities.
- ``Mt3Transcriber``: YourMT3+ through mt3-infer. Polyphonic, any instrument,
  and drums as General MIDI percussion keys.

Which stem goes to which is a table in app/core/config.py (TRANSCRIBE_ROUTES),
so this module holds no routing.

The conversions from each library's output to notes are plain functions over
plain data (`piano_events_to_notes`, `midi_to_notes`), tested without a model.
The heavy imports (torch, torchcrepe, mt3_infer) happen inside the classes:
this module is imported by the API process for its names, and none of those
libraries may load there.

Model weights are fetched on first use into MODELS_DIR, never bundled, and
checked against a published hash before they are loaded, so a download that
was cut short is refetched instead of failing forever (#502). See
docs/models.md for where each comes from and its license.
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import tempfile
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path

from app.core.config import (
    MODELS_DIR,
    PITCH_HOP_S,
    PITCH_RANGE_DEFAULT_HZ,
    PITCH_RANGES_HZ,
    PITCH_SR,
    TRANSCRIBE_MT3_CHECKPOINT,
    TRANSCRIBE_MT3_REPO,
    TRANSCRIBE_MT3_SHA256,
    TRANSCRIBE_PIANO_BYTES,
    TRANSCRIBE_PIANO_MD5,
    TRANSCRIBE_PIANO_URL,
)
from app.core.model_cache import transcription_artifacts

logger = logging.getLogger("stemdeck.transcription")

Note = dict

# CREPE's lowest pitch bin is C1. A search floor under it masks every bin.
_CREPE_FMIN_HZ = 32.71
_CREPE_BATCH = 512
# Both neural note models were trained at this rate.
MODEL_SR = 16000
# A piano key outside the 88 is a decoding artifact, not a note.
_PIANO_RANGE = (21, 108)
_DOWNLOAD_CHUNK = 1 << 20


class ModelUnavailable(RuntimeError):
    """A model's weights could not be fetched or did not verify."""


def _say(text: str) -> None:
    """A progress line for the parent, which reads this process's stderr and
    resets its stall timer on every line."""
    sys.stderr.write(text.rstrip() + "\n")
    sys.stderr.flush()


def _clean(notes: Iterable[Mapping], duration: float | None = None) -> list[Note]:
    """Stored notes: valid, clamped to the stem's length, in time order."""
    out: list[Note] = []
    for n in notes:
        start, end = float(n["start"]), float(n["end"])
        if duration is not None:
            start, end = min(start, duration), min(end, duration)
        pitch = int(n["pitch"])
        if end <= start or start < 0 or not 0 <= pitch <= 127:
            continue
        out.append(
            {
                "start": round(start, 4),
                "end": round(end, 4),
                "pitch": pitch,
                "velocity": max(1, min(127, int(n.get("velocity", 80)))),
            }
        )
    out.sort(key=lambda n: (n["start"], n["pitch"]))
    return out


# -- conversions, no model --------------------------------------------------


def piano_events_to_notes(events: Iterable[Mapping], duration: float | None = None) -> list[Note]:
    """Notes from piano-transcription-inference's ``est_note_events``: dicts of
    ``onset_time``, ``offset_time``, ``midi_note`` and ``velocity``."""
    low, high = _PIANO_RANGE
    return _clean(
        (
            {
                "start": e["onset_time"],
                "end": e["offset_time"],
                "pitch": e["midi_note"],
                "velocity": e.get("velocity", 80),
            }
            for e in events
            if low <= int(e["midi_note"]) <= high
        ),
        duration,
    )


def midi_to_notes(mid, *, drums: bool, duration: float | None = None) -> list[Note]:
    """Notes from a ``mido.MidiFile``, as YourMT3+ returns its transcription.

    The model labels what it hears with instruments, one program per track or
    channel. A stem is one instrument already, so for a pitched stem every
    pitched program is merged into one line and the percussion channel is
    dropped, and for the drums stem only the percussion channel is kept, its
    pitches being General MIDI percussion keys. A drum hit has no length of
    its own, so each is given a short fixed one.
    """
    import mido

    tempo = 500_000
    events: list[tuple[int, int, object]] = []
    for index, track in enumerate(mid.tracks):
        tick = 0
        for msg in track:
            tick += msg.time
            events.append((tick, index, msg))
    events.sort(key=lambda e: (e[0], e[1]))

    seconds = 0.0
    last_tick = 0
    open_notes: dict[tuple[int, int], list[tuple[float, int]]] = {}
    notes: list[Note] = []
    for tick, _index, msg in events:
        seconds += mido.tick2second(tick - last_tick, mid.ticks_per_beat, tempo)
        last_tick = tick
        if msg.type == "set_tempo":
            tempo = msg.tempo
            continue
        if msg.type not in ("note_on", "note_off"):
            continue
        is_drum = msg.channel == 9
        if is_drum != drums:
            continue
        key = (msg.channel, msg.note)
        if msg.type == "note_on" and msg.velocity > 0:
            if drums:
                notes.append(
                    {
                        "start": seconds,
                        "end": seconds + _DRUM_HIT_S,
                        "pitch": msg.note,
                        "velocity": msg.velocity,
                    }
                )
            else:
                open_notes.setdefault(key, []).append((seconds, msg.velocity))
        elif not drums and open_notes.get(key):
            start, velocity = open_notes[key].pop(0)
            notes.append({"start": start, "end": seconds, "pitch": msg.note, "velocity": velocity})
    # A note the file never released ends where the file does.
    for (_channel, pitch), pending in open_notes.items():
        for start, velocity in pending:
            notes.append({"start": start, "end": seconds, "pitch": pitch, "velocity": velocity})
    return _merge_same_pitch(_clean(notes, duration))


_DRUM_HIT_S = 0.05


def _merge_same_pitch(notes: list[Note]) -> list[Note]:
    """Two programs sounding the same pitch at once are one note in a stem.
    Overlapping notes of one pitch are joined into the longer."""
    out: list[Note] = []
    last: dict[int, Note] = {}
    for note in notes:
        prev = last.get(note["pitch"])
        if prev is not None and note["start"] < prev["end"]:
            prev["end"] = max(prev["end"], note["end"])
            prev["velocity"] = max(prev["velocity"], note["velocity"])
            continue
        kept = dict(note)
        out.append(kept)
        last[note["pitch"]] = kept
    return out


# -- weights ----------------------------------------------------------------


def _file_hash(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(_DOWNLOAD_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verified(path: Path, algorithm: str, expected: str) -> bool:
    """Whether ``path`` is the file with that hash. The answer is remembered
    in a marker beside it, so a 560 MB checkpoint is hashed once, not on
    every run; the marker records the size it vouched for."""
    if not path.is_file():
        return False
    marker = path.with_name(path.name + ".verified")
    size = str(path.stat().st_size)
    try:
        if marker.read_text(encoding="utf-8").strip() == f"{expected}:{size}":
            return True
    except OSError:
        pass
    if _file_hash(path, algorithm) != expected:
        return False
    try:
        marker.write_text(f"{expected}:{size}", encoding="utf-8")
    except OSError:
        logger.warning("could not write %s", marker, exc_info=True)
    return True


def _discard(path: Path) -> None:
    for p in (path, path.with_name(path.name + ".verified")):
        try:
            p.unlink(missing_ok=True)
        except OSError:
            logger.warning("could not remove %s", p, exc_info=True)


def piano_checkpoint_path() -> Path:
    return transcription_artifacts(MODELS_DIR, "piano")[0]


def mt3_checkpoint_path() -> Path:
    # The checkpoint's own folder name stays in the path: mt3-infer reads the
    # model variant from it.
    return transcription_artifacts(MODELS_DIR, "mt3")[0]


def _download(url: str, dest: Path, expected_bytes: int | None = None) -> None:
    """Fetch ``url`` to ``dest`` through a temp file, with progress lines."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "StemDeck"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response, tmp.open("wb") as out:
            total = int(response.headers.get("Content-Length") or expected_bytes or 0)
            done, reported = 0, -1
            while chunk := response.read(_DOWNLOAD_CHUNK):
                out.write(chunk)
                done += len(chunk)
                percent = int(done * 100 / total) if total else 0
                if percent // 10 != reported:
                    reported = percent // 10
                    _say(
                        f"downloading {dest.name}: {done >> 20} MB"
                        + (f" ({percent}%)" if total else "")
                    )
        if expected_bytes is not None and tmp.stat().st_size != expected_bytes:
            raise ModelUnavailable(
                f"{dest.name}: got {tmp.stat().st_size} bytes, expected {expected_bytes}"
            )
        os.replace(tmp, dest)
    except ModelUnavailable:
        raise
    except Exception as exc:
        raise ModelUnavailable(f"failed to download {dest.name}: {exc}") from exc
    finally:
        tmp.unlink(missing_ok=True)


def ensure_piano_checkpoint(fetch: Callable[[str, Path, int | None], None] = _download) -> Path:
    """The piano checkpoint, downloaded if absent and refetched once if what
    is on disk is not the published file."""
    path = piano_checkpoint_path()
    for attempt in (1, 2):
        if _verified(path, "md5", TRANSCRIBE_PIANO_MD5):
            return path
        if path.exists():
            _say(f"{path.name} is damaged, fetching it again")
            _discard(path)
        if attempt == 2:
            break
        _say("fetching the piano transcription model (164 MB)")
        fetch(TRANSCRIBE_PIANO_URL, path, TRANSCRIBE_PIANO_BYTES)
    raise ModelUnavailable(f"{path.name} did not verify after download")


def _fetch_mt3(dest: Path) -> None:
    from huggingface_hub import hf_hub_download

    root = MODELS_DIR / "yourmt3"
    root.mkdir(parents=True, exist_ok=True)
    try:
        got = hf_hub_download(
            repo_id=TRANSCRIBE_MT3_REPO,
            filename=TRANSCRIBE_MT3_CHECKPOINT,
            local_dir=str(root),
        )
    except Exception as exc:
        raise ModelUnavailable(f"failed to download the YourMT3+ checkpoint: {exc}") from exc
    if Path(got).resolve() != dest.resolve():
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.replace(got, dest)


def ensure_mt3_checkpoint(fetch: Callable[[Path], None] = _fetch_mt3) -> Path:
    """The YourMT3+ checkpoint, with the same download-and-verify rule."""
    path = mt3_checkpoint_path()
    for attempt in (1, 2):
        if _verified(path, "sha256", TRANSCRIBE_MT3_SHA256):
            return path
        if path.exists():
            _say(f"{path.name} is damaged, fetching it again")
            _discard(path)
        if attempt == 2:
            break
        _say("fetching the YourMT3+ transcription model (536 MB)")
        fetch(path)
    raise ModelUnavailable("the YourMT3+ checkpoint did not verify after download")


# -- transcribers -----------------------------------------------------------


class CrepeTranscriber:
    """CREPE pitch tracking, then the pitch-curve-to-notes step."""

    name = "crepe"
    model = "torchcrepe-full"
    sample_rate = PITCH_SR

    def load(self, device: str) -> None:
        import torchcrepe  # noqa: F401  (its weights ship in the package)

        self.device = device

    def transcribe(self, audio, stem: str) -> list[Note]:
        import librosa
        import numpy as np
        import torch
        import torchcrepe

        from app.pipeline.pitch_notes import notes_from_pitch

        hop = round(PITCH_SR * PITCH_HOP_S)
        fmin, fmax = PITCH_RANGES_HZ.get(stem, PITCH_RANGE_DEFAULT_HZ)
        f0, periodicity = torchcrepe.predict(
            torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))[None],
            PITCH_SR,
            hop_length=hop,
            fmin=max(fmin, _CREPE_FMIN_HZ),
            fmax=fmax,
            model="full",
            decoder=torchcrepe.decode.viterbi,
            return_periodicity=True,
            batch_size=_CREPE_BATCH,
            device=self.device,
        )
        f0 = f0[0].detach().cpu().numpy()
        periodicity = periodicity[0].detach().cpu().numpy()
        if not np.isfinite(periodicity).any():
            raise RuntimeError("the pitch tracker returned no usable frames")
        rms = librosa.feature.rms(y=audio, frame_length=1024, hop_length=hop, center=True)[0]
        frames = min(len(f0), len(rms))
        onsets = librosa.onset.onset_detect(
            y=audio, sr=PITCH_SR, hop_length=hop, units="time", backtrack=True
        )
        notes = notes_from_pitch(
            f0[:frames], periodicity[:frames], rms[:frames], hop / PITCH_SR, onsets
        )
        return _clean(notes, len(audio) / PITCH_SR)


class PianoTranscriber:
    """The ByteDance high-resolution piano transcription model."""

    name = "piano"
    model = "bytedance-piano-crnn"
    sample_rate = MODEL_SR

    def load(self, device: str) -> None:
        import torch
        from piano_transcription_inference import PianoTranscription

        path = ensure_piano_checkpoint()
        # The library only moves itself to a GPU for CUDA; on anything else it
        # runs where it loaded. Its own downloader (wget, to the home folder)
        # never runs: the checkpoint is already in place and whole.
        target = device if device == "cuda" else "cpu"
        self._model = PianoTranscription(checkpoint_path=str(path), device=torch.device(target))

    def transcribe(self, audio, stem: str) -> list[Note]:
        import numpy as np

        with tempfile.TemporaryDirectory(prefix="stemdeck-piano-") as tmp:
            result = self._model.transcribe(
                np.ascontiguousarray(audio, dtype=np.float32), os.path.join(tmp, "out.mid")
            )
        return piano_events_to_notes(result["est_note_events"], len(audio) / MODEL_SR)


def mt3_device(device: str) -> str:
    """Where YourMT3+ runs for a requested device: never on Apple's MPS.

    Its decoder writes one token at a time, so every step has a new tensor
    shape, and MPS compiles and caches a graph per shape. Measured on a real
    guitar stem (20 s of audio, an M-series Mac): 151 s on the CPU, 481 s on
    MPS, and the MPS process then spent minutes freeing those graphs before it
    could exit. CUDA has no such cost and is used as asked."""
    return "cpu" if device == "mps" else device


class Mt3Transcriber:
    """YourMT3+ through mt3-infer."""

    name = "mt3"
    model = "yourmt3-yptf-moe-nops"
    sample_rate = MODEL_SR

    def load(self, device: str) -> None:
        from mt3_infer import load_model

        path = ensure_mt3_checkpoint()
        self._model = load_model(
            "yourmt3",
            checkpoint_path=str(path),
            device=mt3_device(device),
            cache=False,
            auto_download=False,
        )

    def transcribe(self, audio, stem: str) -> list[Note]:
        import numpy as np

        mid = self._model.transcribe(np.ascontiguousarray(audio, dtype=np.float32), sr=MODEL_SR)
        return midi_to_notes(mid, drums=stem == "drums", duration=len(audio) / MODEL_SR)


TRANSCRIBER_CLASSES: dict[str, type] = {
    "crepe": CrepeTranscriber,
    "piano": PianoTranscriber,
    "mt3": Mt3Transcriber,
}
