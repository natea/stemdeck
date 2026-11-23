# Tasks

## 1. Licenses and dependencies

- [x] 1.1 Read the license files and model cards for torchcrepe, piano-transcription-inference (and its MAESTRO-trained weights) and YourMT3+ (GitHub GPL-3.0 against Hugging Face Apache-2.0), choose the YourMT3+ checkpoint, and add an entry per model to `docs/models.md` with the decision; verify each entry names the license, the upstream URL and the checkpoint file
- [x] 1.2 If the piano weights are rejected in 1.1, set the `piano` route to `mt3` in the routing table and note the rejected alternative in `docs/models.md`; verify the proposal's routing list and the doc agree (outcome: not rejected; the weights are published under CC BY 4.0, kept as the default, with `STEMDECK_TRANSCRIBE_PIANO=mt3` documented as the opt-out)
- [x] 1.3 Add `torchcrepe`, `piano-transcription-inference`, `mt3-infer` (exact pin), `mido` and `music21` to `pyproject.toml` with the non-Intel-Mac marker; verify `uv sync` succeeds, `uv lock --check` passes, and `uv run python -c "import torchcrepe, piano_transcription_inference, mt3_infer, mido, music21"` exits 0
- [x] 1.4 Verify no TensorFlow package entered the lock (`grep -i tensorflow uv.lock` is empty) and record the change in runtime-pack size in the change notes

## 2. Configuration and job state

- [x] 2.1 Add `TRANSCRIBE_ROUTES`, the per-stem `STEMDECK_TRANSCRIBE_<STEM>` overrides, `STEMDECK_TIMEOUT_TRANSCRIPTION` and the note-segmentation and quantiser constants to `app/core/config.py`, and document the environment variables in `docs/configuration.md`; verify a unit test covers the default table and one override
- [x] 2.2 Add `app/core/transcription_outcome.py` with reason codes and `message_for`, mirroring `vocal_split_outcome.py`; verify a test asserts every code has a message
- [x] 2.3 Add `transcription`, `transcription_reason` and `transcription_stems` to `Job` in `app/core/models.py`, include them in the serialised state and in `post_hoc_running()`, and turn a persisted "running" into "error"/`interrupted` on load; verify tests for the round trip, the busy flag and the restart case pass
- [x] 2.4 Add `transcription_available` to `/api/config`, false on Intel Macs; verify a test covers both values

## 3. Pitch curve to notes

- [x] 3.1 Implement `app/pipeline/pitch_notes.py` (voicing with hysteresis, Hz to MIDI, median filter, pitch-band segmentation, onset re-attack split, clean-up, velocity) as pure functions over arrays; verify unit tests on synthetic curves cover each scenario of "A pitch curve is turned into discrete notes" in `specs/stem-transcription/spec.md`
- [x] 3.2 Add a test that synthesises a short monophonic melody (sine notes with vibrato and a gap), runs the segmenter on its exact pitch curve, and asserts the recovered pitches and onsets within 50 ms

## 4. Model adapters and worker

- [x] 4.1 Add the three models' checkpoint paths to `app/core/model_cache.py` and check each downloaded checkpoint against its published hash before loading (not `load_or_heal`, which deletes a good file on an unrelated load failure; see design.md, Implementation notes); verify a test simulates a truncated checkpoint and sees a re-fetch, and another shows a failed load leaves a verified checkpoint in place
- [x] 4.2 Implement the CREPE adapter (ffmpeg decode to 16 kHz mono, torchcrepe `full` with Viterbi, per-stem `fmin`/`fmax`, then `pitch_notes`); verify it returns monophonic notes for a generated bass-range tone sequence
- [x] 4.3 Implement the piano adapter over `piano_transcription_inference`, mapping its note events to the stored note shape; verify with the model mocked that events convert correctly, and mark a real-model test as slow (the project has no slow marker, so `tests/test_transcription_real_models.py` runs only with `STEMDECK_TEST_REAL_MODELS=1`)
- [x] 4.4 Implement the YourMT3+ adapter over `mt3-infer`, merging instrument programs into one track for pitched stems and mapping drum events to GM percussion keys for `drums`; verify with the model mocked that both mappings are correct
- [x] 4.5 Implement `app/pipeline/notes_worker.py` (group stems by transcriber, load each model once, write `stems/transcription/<stem>.json` atomically, emit `@@STEM@@`, `@@DONE@@`, `@@ERROR@@`, skip silent stems, retry a model on CPU after an MPS failure); verify a test runs the worker with fake adapters and checks the files, the per-stem outcomes and that one adapter failing leaves the other stem's file
- [x] 4.6 Implement `app/pipeline/notes.py`, the parent side: spawn the worker, read stderr, enforce the timeout, honour cancel, return per-stem outcomes; verify tests for success, timeout and cancel using a stub worker, following `tests/test_pipeline_vocal_split.py`

## 5. Quantiser

- [x] 5.1 Extract the merge of `beats.json` and `beats.user.json` used by `GET /api/jobs/{id}/beats` into a shared helper; verify the existing beats tests still pass unchanged
- [x] 5.2 Implement `app/pipeline/quantize.py` (grid points per beat interval, start and end snapping, minimum one step, monophonic trim, bar/beat/part from bar marks with the `beats_per_bar` and four-four fallbacks); verify unit tests cover every scenario of "Notes are quantised to the song's beat grid" and "Transcription works without a beat grid"
- [x] 5.3 Add a property-style test: notes generated exactly on a drifting grid, jittered by up to a third of a step, quantise back to their original positions

## 6. API

- [x] 6.1 Add `POST /api/jobs/{id}/transcription` with the refusals in `specs/stem-transcription/spec.md` (not done, unknown stem, already running, busy, unavailable platform), run under `_pipeline_lock`, persist state before starting; verify endpoint tests for each refusal and the happy path with the worker stubbed
- [x] 6.2 Add `GET /api/jobs/{id}/transcription` returning as-played or quantised notes with the grid's `confidence` and `detector`; verify tests for both forms, the `stems` and `parts` parameters, and the no-beat-grid refusal
- [x] 6.3 Wire cancellation and failure handling so completed stems are kept and the job stays done; verify tests for cancel mid-run and for a per-stem failure
- [x] 6.4 Document the new endpoints in `docs/api.md`; verify each documented path and parameter matches the route definitions

## 7. Exports

- [x] 7.1 Implement the MIDI writer with `mido` (as-played at fixed tempo; quantised with per-beat tempo events and time signatures; drums on channel 10; tracks named after stems); verify tests parse the output and check track names, the drum channel, as-played times within 5 ms, and that quantised bar lines map back to the grid's downbeat times
- [x] 7.2 Implement the MusicXML writer with `music21`, imported lazily (parts, clefs, time signatures per bar mark, tempo, key signature, ties across bar lines, percussion part); verify tests re-parse the output with music21 and cover each scenario of "Transcription downloads as a MusicXML score"
- [x] 7.3 Add `GET /api/jobs/{id}/transcription.mid` and `.musicxml` with song-named downloads and document them in `docs/api.md`; verify endpoint tests for content type, file name, the `stems` filter, nothing-transcribed, and the no-beat-grid refusal
- [x] 7.4 Verify `import app.main` does not import `music21`, `mt3_infer` or `torchcrepe` (assert on `sys.modules` in a test)

## 8. Frontend

- [x] 8.1 Add the Transcribe entry and dialog (stem choice, progress, per-stem failure message, the three downloads, grid-resolution choice), hidden when `transcription_available` is false, with strings in `static/js/i18n.js`; verify `node --check` passes on changed files and a Playwright test drives the dialog against a stubbed API
- [x] 8.2 Show a warning in the dialog when the beat grid's confidence is low or the grid is missing; verify the Playwright test covers both states
- [x] 8.3 Add the feature to the README feature list; verify the wording matches what the dialog offers

## 9. Integration checks

- [x] 9.1 Run a real song end to end on Apple Silicon: import it through the app, transcribe all six stems, download the as-played MIDI, the quantised MIDI and the MusicXML; verify by program that every bar line of the quantised MIDI falls on its downbeat to the end of the song, every quantised note is on the grid, drums are on channel 10, and the score is well-formed and re-parses with one part per stem and the same bars in each (done on a public-domain rock recording, 3 min 28 s, 126 bars: bar-line error 0 s, 0 notes off the grid, six parts of 126 bars; the by-ear and by-eye check in a DAW and in MuseScore is in Workflow follow-up, since neither is installed where this was built)
- [x] 9.2 Edit the song's beat grid and download the quantised MIDI again; verify the note positions changed and the server log shows no model run (done: 4,784 note positions changed after moving every beat 70 ms, no run in the log, and resetting the grid gave back the original file byte for byte)
- [x] 9.3 Run `uv run ruff check app/ tests/`, `uv run ruff format --check app/ tests/` and `uv run pytest tests/ -q`; verify all three pass (done: both ruff commands clean, 4,375 passed and 13 skipped, none failed)
- [x] 9.4 Run `openspec validate add-stem-transcription --strict`; verify it reports no errors

## Workflow follow-up

- Load the quantised MIDI beside the song's stems in a DAW, both starting at zero, and listen: the notes should sit on the DAW's grid and stay in time with the audio to the end. Remember the lead-in bar: the song's bar 1 is the DAW's bar 2.
- Open the MusicXML score in MuseScore or another notation program and confirm it opens without errors. It was checked here by re-parsing it with music21 and for XML well-formedness, not in a notation program.
- Run `STEMDECK_TEST_REAL_MODELS=1 uv run pytest tests/test_transcription_real_models.py -q` once on each release platform.
- Archive the change after the project's review requirements are satisfied.
