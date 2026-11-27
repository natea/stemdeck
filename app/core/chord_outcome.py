"""Why a chord detection did not make a chord timeline.

Detecting chords is a best-effort pass over a finished song, like the vocal
split (app/core/vocal_split_outcome.py): its failure never fails the
song, and whatever chords the song already had stay. The job carries one of
these codes for the last run, and the client says what happened from it in the
person's own language.

The messages below are the API's plain-English fallback for a client with no
table of its own. They are fixed strings on purpose: nothing from the worker's
stderr, no path and no traceback ever reaches a client through them.
"""

from __future__ import annotations

# The detector, or its model files, is not in this install or is not the one
# StemDeck was built with.
DEPENDENCY_MISSING = "dependency_missing"
# The model's files (28.7 MB, fetched the first time chords are detected)
# did not arrive, or could not be written.
MODEL_DOWNLOAD = "model_download"
# The song has no audio on disk to listen to.
NO_AUDIO = "no_audio"
OUT_OF_MEMORY = "out_of_memory"
WORKER_FAILED = "worker_failed"
TIMEOUT = "timeout"
CANCELLED = "cancelled"
# The app stopped while the detection ran, so it never finished.
INTERRUPTED = "interrupted"

MESSAGES: dict[str, str] = {
    DEPENDENCY_MISSING: (
        "A part StemDeck needs to detect chords is missing or damaged on this install. "
        "Update or reinstall StemDeck, then try again."
    ),
    MODEL_DOWNLOAD: (
        "The chord model could not be downloaded (29 MB, the first time only). "
        "Check the internet connection and the free disk space, then try again."
    ),
    NO_AUDIO: "This song has no audio on disk to detect chords from.",
    OUT_OF_MEMORY: (
        "The computer ran out of memory while detecting chords. Close other apps, then try again."
    ),
    WORKER_FAILED: "Chord detection stopped with an error. Try again, or check the logs.",
    TIMEOUT: "Chord detection stopped responding and was stopped. Try again.",
    CANCELLED: "Chord detection was cancelled.",
    INTERRUPTED: "StemDeck closed before chord detection finished. Try again.",
}

CODES = frozenset(MESSAGES)


def message_for(code: str | None) -> str | None:
    """The safe sentence for ``code``, or None when there is no failure."""
    if code is None:
        return None
    return MESSAGES.get(code, MESSAGES[WORKER_FAILED])
