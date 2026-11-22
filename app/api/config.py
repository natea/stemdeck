from __future__ import annotations

import platform
import sys

from fastapi import APIRouter

from app.core.config import (
    EXTRA_STEM_NAMES,
    QUANTIZE_PARTS,
    QUANTIZE_PARTS_DEFAULT,
    STEM_NAMES,
    TRANSCRIBE_ROUTES,
)

router = APIRouter()


@router.get("/config")
def get_config() -> dict:
    # extra_stem_names (#275) are produced only when a job's on-demand
    # lead/backing vocal split has run -- kept separate from stem_names so
    # existing clients that assume "every job produces exactly these stems"
    # are unaffected; new clients merge it into their lane vocab (see
    # syncStemNamesFromAPI in static/js/constants.js).
    return {
        "stem_names": list(STEM_NAMES),
        "extra_stem_names": list(EXTRA_STEM_NAMES),
        # Stem transcription (POST /api/jobs/{id}/transcription). False where
        # its model runtimes are not installed (Intel macOS, pyproject.toml):
        # the client then shows no Transcribe control at all.
        "transcription_available": transcription_available(),
        # Which kind of transcriber each stem goes to, so the client can say
        # what a stem will be transcribed with before anyone asks.
        "transcription_routes": dict(TRANSCRIBE_ROUTES),
        # The resolutions the quantised exports accept, and the default.
        "quantize_parts": list(QUANTIZE_PARTS),
        "quantize_parts_default": QUANTIZE_PARTS_DEFAULT,
    }


def transcription_available() -> bool:
    """Whether this install can transcribe stems at all."""
    return not (sys.platform == "darwin" and platform.machine() == "x86_64")
