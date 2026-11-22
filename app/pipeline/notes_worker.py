"""On-demand stem transcription worker.

Run as its own process: `python -m app.pipeline.notes_worker <device>
<stems_dir> <stem,stem,...>`. Like vocal_split_worker.py it is **not**
persistent: transcribing is an occasional action on a finished song, so there
is no per-job model load worth keeping warm, and a process that exits gives
back every byte of three large models.

(The name is `notes_worker` because `transcribe_worker.py` is already the
Whisper lyrics worker.)

It groups the requested stems by the transcriber each is routed to
(app.core.config.TRANSCRIBE_ROUTES), loads each model once, and writes each
stem's notes to stems/transcription/<stem>.json the moment that stem is done.
So a run that dies half way keeps what it finished, and a model that cannot
load costs only the stems routed to it.

Protocol on stderr, matching vocal_split_worker.py so the parent's reader has
the same shape. Progress and log lines, and for each stem exactly one

  "@@STEM@@<json object>"   {"stem", "status": "done" | "skipped" | "error",
                             "notes": int, "code": reason code or null,
                             "transcriber": name}

then exactly one of:

  "@@DONE@@"                -- every requested stem was reported, failed or not
  "@@ERROR@@<json object>"  -- the run itself could not happen; exit(1).
                               {"message": str, "code": reason code}

Reason codes are app.core.transcription_outcome.CODES.
"""

from __future__ import annotations

import gc
import json
import sys
from collections.abc import Callable, Mapping
from pathlib import Path

from app.core.config import (
    TIMEOUT_TRANSCRIPTION,
    TRANSCRIBE_ROUTES,
    TRANSCRIBE_SILENCE_PEAK,
    TRANSCRIBERS,
)
from app.core.process import arm_parent_watchdog
from app.core.stem_files import stem_path
from app.core.transcription_files import write_notes
from app.core.transcription_outcome import MODEL_UNAVAILABLE, WORKER_FAILED


def _emit(line: str) -> None:
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def _stem_line(
    stem: str, status: str, *, notes: int = 0, code: str | None, transcriber: str
) -> None:
    _emit(
        "@@STEM@@"
        + json.dumps(
            {
                "stem": stem,
                "status": status,
                "notes": notes,
                "code": code,
                "transcriber": transcriber,
            }
        )
    )


def _code(phase: str, exc: BaseException) -> str:
    """The reason code for a failure. A model that would not download is the
    model, whatever its words; the rest is judged the way the vocal split
    judges its own failures (the shared codes are the same strings)."""
    try:
        from app.pipeline.notes_adapters import ModelUnavailable

        if isinstance(exc, ModelUnavailable):
            return MODEL_UNAVAILABLE
        from app.pipeline.vocal_split_status import failure_code

        return failure_code(phase, exc)
    except Exception:
        # The classifier is a nicety. Failing to load it must not cost the
        # parent the error itself.
        return WORKER_FAILED


def _decode(path: Path, sample_rate: int):
    """The whole stem as mono float32 at ``sample_rate``, or None."""
    from app.pipeline.analyze import _load_audio_ffmpeg

    loaded = _load_audio_ffmpeg(path, sr=sample_rate, duration=None, timeout=TIMEOUT_TRANSCRIPTION)
    return None if loaded is None else loaded[0]


def _default_transcribers() -> Mapping[str, Callable[[], object]]:
    from app.pipeline.notes_adapters import TRANSCRIBER_CLASSES

    return TRANSCRIBER_CLASSES


def _load(transcriber, name: str, device: str) -> str:
    """Load a transcriber and return the device it ended up on.

    A model that will not load on the GPU is tried once on the CPU: Apple's
    MPS backend still lacks operators some of these models use, and a slower
    transcription beats none.

    Deliberately not app.core.model_cache.load_or_heal. That helper deletes
    the cached file when a load fails, which is right for loaders that trust a
    file's existence. These checkpoints are checked against their published
    hash before every load (notes_adapters.ensure_*), so a damaged one is
    already refetched there, and a load that fails afterwards failed for some
    other reason. Healing here once threw away a good 536 MB checkpoint
    because the GPU lacked an operator."""
    from app.pipeline.notes_adapters import ModelUnavailable

    try:
        transcriber.load(device)
        return device
    except (ImportError, ModelUnavailable):
        raise
    except Exception as exc:
        if device == "cpu":
            raise
        _emit(f"{name}: could not load on {device} ({exc}); trying the CPU")
        transcriber.load("cpu")
        return "cpu"


def run(
    device: str,
    stems_dir: Path,
    stems: list[str],
    *,
    transcribers: Mapping[str, Callable[[], object]] | None = None,
    decode: Callable[[Path, int], object] = _decode,
    routes: Mapping[str, str] | None = None,
) -> dict[str, dict]:
    """Transcribe ``stems``, reporting each on stderr. Returns the outcomes,
    keyed by stem, for a caller in the same process (the tests)."""
    import numpy as np

    routes = TRANSCRIBE_ROUTES if routes is None else routes
    factories = _default_transcribers() if transcribers is None else transcribers
    outcomes: dict[str, dict] = {}

    def report(stem: str, status: str, name: str, *, notes: int = 0, code: str | None = None):
        outcomes[stem] = {"status": status, "notes": notes, "code": code, "transcriber": name}
        _stem_line(stem, status, notes=notes, code=code, transcriber=name)

    by_transcriber: dict[str, list[str]] = {}
    for stem in stems:
        name = routes.get(stem)
        if name not in factories:
            report(stem, "error", str(name), code=WORKER_FAILED)
            continue
        by_transcriber.setdefault(name, []).append(stem)

    # Cheapest first, so the quick stems are on disk before the slow model loads.
    for name in sorted(
        by_transcriber, key=lambda n: TRANSCRIBERS.index(n) if n in TRANSCRIBERS else 99
    ):
        group = by_transcriber[name]
        transcriber = factories[name]()
        rate = transcriber.sample_rate

        # Read every stem of the group first. A silent one is recorded as
        # skipped without a model: there is no reason to download and load
        # 500 MB to learn that an empty piano stem has no notes.
        audio_of: dict[str, object] = {}
        for stem in group:
            try:
                audio = decode(stem_path(stems_dir, stem), rate)
                if audio is None:
                    raise RuntimeError(f"could not read the {stem} stem")
                audio = np.asarray(audio, dtype=np.float32)
                if audio.size == 0 or float(np.max(np.abs(audio))) < TRANSCRIBE_SILENCE_PEAK:
                    write_notes(
                        stems_dir,
                        stem,
                        transcriber=name,
                        model=transcriber.model,
                        duration=len(audio) / rate,
                        notes=[],
                        skipped="silent",
                    )
                    report(stem, "skipped", name)
                    continue
                audio_of[stem] = audio
            except Exception as exc:
                _emit(f"{stem}: could not be read: {exc}")
                report(stem, "error", name, code=_code("separate", exc))
        if not audio_of:
            continue

        _emit(f"loading the {name} transcriber for {', '.join(audio_of)}")
        try:
            on = _load(transcriber, name, device)
        except Exception as exc:
            code = _code("import" if isinstance(exc, ImportError) else "load", exc)
            _emit(f"{name}: could not load: {exc}")
            for stem in audio_of:
                report(stem, "error", name, code=code)
            continue

        for stem, audio in audio_of.items():
            _emit(f"transcribing {stem} with {name}")
            try:
                try:
                    notes = transcriber.transcribe(audio, stem)
                except Exception as exc:
                    if on == "cpu" or isinstance(exc, MemoryError):
                        raise
                    _emit(f"{name}: failed on {on} ({exc}); trying the CPU")
                    transcriber = factories[name]()
                    on = _load(transcriber, name, "cpu")
                    notes = transcriber.transcribe(audio, stem)
                write_notes(
                    stems_dir,
                    stem,
                    transcriber=name,
                    model=transcriber.model,
                    duration=len(audio) / rate,
                    notes=notes,
                )
                report(stem, "done", name, notes=len(notes))
            except Exception as exc:
                _emit(f"{stem}: transcription failed: {exc}")
                report(stem, "error", name, code=_code("separate", exc))
        # Give the model's memory back before the next one loads.
        del transcriber, audio_of
        gc.collect()
    return outcomes


def main() -> None:
    # A Force-Quit of the app otherwise orphans this process holding the GPU
    # and several GB of model (#519).
    arm_parent_watchdog()
    if len(sys.argv) < 4:
        _emit(
            "@@ERROR@@"
            + json.dumps(
                {
                    "message": "usage: notes_worker <device> <stems_dir> <stem,stem,...>",
                    "code": WORKER_FAILED,
                }
            )
        )
        sys.exit(1)
    device, stems_dir = sys.argv[1], Path(sys.argv[2])
    stems = [s for s in sys.argv[3].split(",") if s]
    try:
        run(device, stems_dir, stems)
    except Exception as exc:
        _emit("@@ERROR@@" + json.dumps({"message": str(exc), "code": _code("unknown", exc)}))
        sys.exit(1)
    _emit("@@DONE@@")


if __name__ == "__main__":
    main()
