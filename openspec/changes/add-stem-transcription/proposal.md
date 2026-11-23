# Proposal

## Why

StemDeck separates a song into stems but stops at audio: a musician who wants the notes of the bass line, the vocal melody or the piano part still has to work them out by ear. Separated stems are close to the clean, single-instrument input that transcription models are most accurate on, and StemDeck already computes a beat and downbeat grid for every song, which is the piece that raw audio-to-MIDI output lacks to become readable notation.

## What Changes

- Add an on-demand **Transcribe** action for a finished song that turns each chosen stem into notes (pitch, start, end, velocity), using the model that is most accurate for that kind of stem:
  - `vocals`, `lead_vocals`, `bass` (one note at a time): CREPE pitch tracking, followed by a new step that turns the pitch curve into discrete notes.
  - `piano`: the ByteDance high-resolution piano transcription model.
  - `guitar`, `other`, `backing_vocals` (several notes at once): YourMT3+.
  - `drums`: YourMT3+, with its drum output mapped to General MIDI percussion.
- Add **rhythm quantisation** that snaps note starts and ends to a grid built from the song's own beats and downbeats (the grid the click track uses, including the user's edits to it), so the result follows tempo drift and real bar lines.
- Keep the unquantised notes as the stored result, and derive the quantised version from them, so editing the beat grid re-quantises without running a model again.
- Add downloads per song: a multi-track **MIDI** file (as played, or quantised with a tempo map so it stays in sync with the audio) and a **MusicXML** score (quantised only), one track or part per transcribed stem.
- Add three Python dependencies and three model downloads, fetched on first use and not bundled in installers. Record each model's license basis in `docs/models.md`.

Not in this change: chord recognition, lyrics in the score, an in-app piano roll or score viewer, and editing notes in the app.

## Capabilities

### New Capabilities
- `stem-transcription`: turning a song's separated stems into note data on demand, including which kind of model each stem is routed to, the as-played and beat-quantised forms of the result, and what happens when a stem, a model or the beat grid is unavailable.
- `notation-export`: downloading a song's transcription as a MIDI file or a MusicXML score.

### Modified Capabilities

None. The project has no existing specs.

## Impact

- **Backend**: new pipeline modules under `app/pipeline/` (a transcription worker run as its own process, the pitch-curve-to-notes step, the quantiser, MIDI and MusicXML writers); new endpoints and job state in `app/api/jobs.py` and `app/core/models.py`; new settings in `app/core/config.py`. `stems/beats.json` and `stems/beats.user.json` are read, not changed.
- **Frontend**: a Transcribe control and download entries in `static/js`, with strings in `static/js/i18n.js`.
- **Dependencies**: `torchcrepe`, `piano-transcription-inference`, `mt3-infer` (model runtimes), plus `mido` and `music21` (file writers). A release that changes Python packages is a full download for desktop users, not an in-place update.
- **Disk and time**: model weights of roughly 0.1 GB (CREPE), 0.2 GB (piano) and 0.5 to 1 GB (YourMT3+) on first use; transcription of a full song takes minutes on a CPU.
- **Platforms**: not offered on Intel Macs, which are pinned to torch 2.2 (the same limit as the lead and backing vocal split).
- **Licensing**: StemDeck is AGPL-3.0-only and has turned down models with non-commercial terms before (madmom). The piano model's weights were trained on a non-commercial dataset, and YourMT3+ carries two different license statements upstream. Both need a recorded decision before release.
- **Docs**: `docs/models.md`, `docs/api.md`, `docs/configuration.md`, README feature list.
