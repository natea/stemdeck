# Tasks

## 1. Vendor alphaTab and prove the approach

- [x] 1.1 Confirm `add-stem-transcription` is implemented (its quantiser, merged-grid helper and exports exist and its tests pass); verify with `uv run pytest tests/ -q -k "quantize or transcription"`
- [x] 1.2 Copy `alphaTab.min.mjs`, `alphaTab.core.min.mjs`, `alphaTab.worker.min.mjs`, `font/Bravura.woff2`, `LICENSE` and `font/Bravura-OFL.txt` from `@coderline/alphatab@1.9.0` into `static/vendor/alphatab/` with a `VERSION` file listing each file's SHA-256; verify the hashes match the npm tarball and the files are byte-identical to upstream
- [x] 1.3 Spike: a throwaway page that lazily imports the vendored module, loads a hand-written alphaTex score with two tracks, a tab staff and `\sync` points, runs in external-media mode and moves the cursor from a fake clock; verify in Chrome and in the desktop webview that it renders with the CSP unchanged, with no console errors and no network request off-origin, then record the exact alphaTab API names used in `design.md`
- [x] 1.4 Add alphaTab (MPL-2.0) and Bravura (SIL OFL 1.1) to the project's third-party notices; verify the notice names the version and links both licenses

## 2. Fingering

- [x] 2.1 Add tuning presets for guitar and bass to `app/core/config.py`; verify a unit test asserts each preset's string count and that standard guitar is 40 45 50 55 59 64
- [x] 2.2 Implement `app/pipeline/fingering.py` (candidates, chord combinations with the span rule, dynamic programming over events, unplaced notes with reasons, capped beam); verify unit tests cover every scenario of "Every tab note has a string and fret that sound its pitch", "Fingerings are playable" and "Notes the instrument cannot play are not silently dropped" in `specs/tablature/spec.md`
- [x] 2.3 Implement the tuning suggestion; verify a test with notes a whole step below standard suggests drop D
- [x] 2.4 Add a property-style test: for random playable lines, every placed note satisfies open + capo + fret = pitch and no two simultaneous notes share a string
- [x] 2.5 Verify fingering a 2,000-note guitar part finishes in under two seconds in a timed test

## 3. Tab settings and the score endpoint

- [x] 3.1 Add `stems/transcription/tab.json` with `GET` and `PATCH /api/jobs/{id}/transcription/tab` (preset or custom tuning, capo, staff/tab/both per fretted stem), validated and written atomically; verify endpoint tests for defaults, a preset, a custom tuning, an invalid tuning and persistence across a registry reload
- [x] 3.2 Move the split of a grid-step length into tied note values and rests out of the MusicXML writer into a shared helper; verify its unit tests and that the existing MusicXML tests still pass unchanged
- [x] 3.3 Implement the alphaTex generator (tracks, staves per the display choice, tuning and capo, time signatures, tempo, key, chords, rests, ties, percussion, display transposition for guitar and bass, one `\sync` point per bar from the merged grid); verify unit tests assert the text for a small fixture of each stem type and for a meter change
- [x] 3.4 Add `GET /api/jobs/{id}/transcription.alphatex` with the `stems` and `parts` parameters, the count and reasons of unplaced notes, the tuning suggestion, and the no-beat-grid and nothing-transcribed refusals; verify endpoint tests for each, and document the endpoint and the tab endpoints in `docs/api.md`

## 4. Notation view

- [x] 4.1 Add the alphaTab bridge module (lazy import, settings for font and worker paths, main-thread fallback, load alphaTex, destroy); verify a Playwright test loads the endpoint's alphaTex for a fixture song into the vendored alphaTab and asserts no parse errors and the expected number of rendered tracks
- [x] 4.2 Add the Notation toggle and resizable panel in Practice and Advanced modes, with strings in `static/js/i18n.js` and styles in `static/css/`; verify `node --check` passes and a Playwright test opens and closes the panel without interrupting playback
- [x] 4.3 Implement the empty states (nothing transcribed with the Transcribe action, no beat grid with the as-played MIDI link, hidden when transcription is unavailable); verify a Playwright test covers each scenario of "The view says why there is nothing to show"
- [x] 4.4 Implement the external media handler against the player (position pushed while playing, seek from a click on the score, rate and loop); verify a Playwright test asserts the cursor's bar at three points during playback, at 0.5x, across a loop jump and after a click-to-seek
- [x] 4.5 Implement the view choices (stems shown, zoom, resolution) with per-song persistence, and redraw after a beat-grid edit or a finished transcription; verify Playwright tests for hide-a-stem, change-resolution, persistence after reopening, and redraw after a grid edit
- [x] 4.6 Verify opening the view makes no sound and creates no second audio context (assert in a Playwright test that no alphaTab synth or soundfont request occurs)
- [x] 4.7 Keep the score following the song after it is drawn again during playback (ask alphaTab for its play state instead of remembering it), and add a Follow switch, remembered per song, that turns the scrolling off and on; verify Playwright tests for a redraw while playing and for Follow off and on, and the same two checks in the system webview

## 5. Tablature in the view

- [x] 5.1 Add the staff/tab/both choice and the tuning and capo controls for `guitar` and `bass`, saved through the tab endpoint; verify a Playwright test changes bass to tab and guitar to drop D and sees the score redrawn with no transcription request
- [x] 5.2 Show the count of unplaced notes and the tuning suggestion with a one-click apply; verify a Playwright test with an out-of-range fixture shows the message and applies the suggestion
- [x] 5.3 Add the feature to the README feature list; verify the wording matches the controls the view offers

## 6. Exports

- [x] 6.1 Add a tab staff with string, fret, tuning and capo to the MusicXML writer for fretted parts; verify tests re-parse the output and find a string and fret on each placed note of the tab staff, no unplaced note on it, and every note still present on the staff of notation
- [x] 6.2 Add the Guitar Pro download using alphaTab's Guitar Pro 7 exporter for the stems shown, named after the song, saved through a backend endpoint that holds the file so the desktop app can save it too; verify a Playwright test downloads the file, re-imports the bytes with alphaTab and asserts the track count, tuning, capo and first bar's frets, and that pytest covers the endpoint's refusals
- [x] 6.3 Put the four downloads (MIDI as played, MIDI quantised, MusicXML, Guitar Pro) in the view, scoped to the stems shown; verify a Playwright test checks each link's stems parameter and file name

## 7. Integration checks

- [ ] 7.1 Run a real song end to end on Apple Silicon in the browser and in the desktop app: transcribe, open the view, play at full and half speed, loop four bars, switch guitar to drop D, export Guitar Pro and MusicXML; verify the cursor stays on the bar being heard to the end of the song and both files open in MuseScore and a tab editor
  - Done in a browser (Chromium) on a real song of 126 bars: full speed, half speed, a 4-bar loop, drop D, both exports, and both files opened in MuseScore 4. Still for a person: the packaged desktop app, and a dedicated tab editor (none is installed on the build machine).
- [x] 7.2 Disconnect the network and reload; verify the view still draws the score with its music font
- [ ] 7.3 Run `uv run ruff check app/ tests/`, `uv run ruff format --check app/ tests/`, `uv run pytest tests/ -q`, `npm run test:js` and `npm run test:e2e`; verify all pass
  - Run on the final code, 2026-11-23. ruff check and format: clean. `npm run test:js`: exit 0. pytest: 4,543 passed, 3 failed, all three `test_demucs_worker_*` in `tests/test_pipeline_workers.py`, which fail on `feat/stem-transcription` itself (commit `eb9e6b4` imports `prevent_clip`, which the test's fake `demucs` lacks). Browser suite, with the parallel runner (`npm run test:e2e:parallel -- --shards 3`): 1,107 passed, 7 skipped, 11 failed, none in `notation.spec.mjs` (34 of 34). Of the 11, 9 pass when run on their own, and `karaoke.spec.mjs:210` and `panel-toggles.spec.mjs:80` fail 2 runs in 3 on a clean copy of `e390fc2` as well. Left unticked because the suites are not all green, for reasons outside this change.
- [x] 7.4 Run `openspec validate add-alphatab-notation --strict`; verify it reports no errors

## Workflow follow-up

- Archive `add-stem-transcription` before this change, because this change's `notation-export` delta adds to the spec that change creates.
