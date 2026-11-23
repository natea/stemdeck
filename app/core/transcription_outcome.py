"""Why a stem transcription did not make its notes.

Transcribing is a best-effort pass over a finished song, like the lead and
backing vocal split (app/core/vocal_split_outcome.py): its failure never fails
the song, and a stem that could not be transcribed costs that stem only. The
job carries one of these codes for the run and one per failed stem, and the
client says what happened from it in the person's own language.

The messages below are the API's plain-English fallback for a client with no
table of its own. They are fixed strings on purpose: nothing from the worker's
stderr, no path and no traceback ever reaches a client through them.
"""

from __future__ import annotations

DEPENDENCY_MISSING = "dependency_missing"
MODEL_UNAVAILABLE = "model_unavailable"
OUT_OF_MEMORY = "out_of_memory"
WORKER_FAILED = "worker_failed"
TIMEOUT = "timeout"
CANCELLED = "cancelled"
# The app stopped while the transcription ran, so it never finished.
INTERRUPTED = "interrupted"
# This build has no transcription at all: its model runtimes are not installed
# on Intel macOS (pyproject.toml), so no update or retry brings it.
UNSUPPORTED_PLATFORM = "unsupported_platform"
# The notes are there, but there are no beats to snap them to.
NO_BEAT_GRID = "no_beat_grid"

MESSAGES: dict[str, str] = {
    DEPENDENCY_MISSING: (
        "A part StemDeck needs for transcription did not load on this install. "
        "Update StemDeck, then try again."
    ),
    MODEL_UNAVAILABLE: (
        "A transcription model could not be downloaded or loaded. "
        "Check the internet connection, then try again."
    ),
    OUT_OF_MEMORY: (
        "The computer ran out of memory during the transcription. Close other apps, then try again."
    ),
    WORKER_FAILED: "The transcription stopped with an error. Try again, or check the logs.",
    TIMEOUT: "The transcription stopped responding and was stopped. Try again.",
    CANCELLED: "The transcription was cancelled.",
    INTERRUPTED: "StemDeck closed before the transcription finished. Try again.",
    UNSUPPORTED_PLATFORM: "Transcription is not available on Macs with an Intel processor.",
    NO_BEAT_GRID: (
        "This song has no beat grid, so its notes cannot be placed on a grid. "
        "The notes as played are still available."
    ),
}

CODES = frozenset(MESSAGES)


def message_for(code: str | None) -> str | None:
    """The safe sentence for ``code``, or None when there is no failure."""
    if code is None:
        return None
    return MESSAGES.get(code, MESSAGES[WORKER_FAILED])
