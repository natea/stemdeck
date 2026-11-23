# Tasks

## 1. Tooling and vendoring

- [x] 1.1 Vet `achimala/dream-loop` and the `agent-skills/3d` folder of `mengto/skills` with the `vet-before-install` skill, each at a pinned commit; verify the findings and the two commit hashes are recorded in `design.md` under a new "Installed tooling" note, and stop and ask if either has a blocking finding
- [ ] 1.2 Install dream-loop and the mengto 3D skills into `.claude/skills/` at those commits; verify both appear in the session's skill list and that `git status` shows nothing new (the folder is git-ignored)
- [x] 1.3 Establish how dream-loop's target images will be made in this environment (an available image generator, user-supplied references, or critique against written art direction) and record the answer in `design.md`; verify by producing one target or reference for Note terrain and saving its source in that scene's `LOOK.md` in task 3.1
- [x] 1.4 Write `scripts/vendor-three.mjs` (download a pinned Three.js release, copy the core module and the listed add-ons, rewrite the bare `"three"` specifier to a relative path, write `VERSION` with SHA-256 per file and the MIT license) and run it; verify the hashes match a second run and no file outside `static/vendor/three/` changed
- [x] 1.5 Spike in the browser and in the desktop shell: a throwaway page that lazily imports the vendored module and an add-on, draws 20,000 instanced boxes with bloom, with the CSP unchanged; verify no console error, no off-origin request, and note the frame rate on this Mac in `design.md`

## 2. Host, data and clock

- [x] 2.1 Implement `static/js/viz/data.js` (peaks, beats and bars, sections, notes per stem or null, stem colours, one load per song); verify node unit tests cover a song with notes, without notes, with some stems transcribed, without a beat grid, and without sections
- [x] 2.2 Implement `static/js/viz/clock.js` (per-frame player time with extrapolation, snap on seek and loop, rate, play state, per-stem level and `lit` from mute and solo); verify node unit tests with a fake player cover pause, seek, loop jump, half speed, mute and solo
- [x] 2.3 Implement `static/js/viz/registry.js` and `host.js` (lazy Three.js load, single renderer, picker, remembered choice, render loop, resize, pause when hidden or closed, frame-rate guard, `dispose` on close, messages for needs-notes, scene failure, and no WebGL), with host strings in `static/js/i18n.js` in ten languages and styles in `static/css/viz.css`; verify `node --check` passes and Playwright tests using two stub scenes cover every scenario of the host requirements in `specs/stem-visualizers/spec.md` except the six scene requirements
- [x] 2.4 Add the Visualizer button with its Labs badge in Practice and Advanced modes, bracketing every line added outside `static/js/viz/` with `viz:begin` / `viz:end` comments; verify a Playwright test opens and closes it during playback with no gap in audio time and no state-changing request
- [x] 2.5 Verify the reduced-motion and missing-scene behaviours: Playwright tests with `prefers-reduced-motion` emulated, and with one scene's module answered 404

## 3. Note terrain

- [x] 3.1 Write the scene's `LOOK.md` (art direction and target or reference image) and implement `scenes/note-terrain/` (`map.js` pure mapping, `index.js`, `strings.js` in ten languages) with both data tiers; verify `scene.test.mjs` covers the mapping, both tiers and the strings, and add the registry line
- [x] 3.2 Run the dream-loop critique on three songs (dense rock, sparse acoustic, one with no notes and no sections) until the critic passes or three rounds are spent; verify the last verdict and screenshots' description are in `LOOK.md`
- [x] 3.3 Verify with a Playwright test that the scene starts, draws a non-blank frame, follows a seek, dims a muted stem and disposes without leaking (renderer info shows zero geometries and textures after close)

## 4. Slit-scan score

- [x] 4.1 Write `LOOK.md` and implement `scenes/slit-scan/` with both data tiers and click-to-seek; verify `scene.test.mjs` covers the mapping, the time-to-column and column-to-time round trip, and the strings, and add the registry line
- [x] 4.2 Run the dream-loop critique on the three songs; verify the verdict is in `LOOK.md`
- [x] 4.3 Verify with a Playwright test: non-blank frame, a click two thirds along moves playback to two thirds, muted stem dims, clean dispose

## 5. Note galaxy

- [x] 5.1 Write `LOOK.md` and implement `scenes/note-galaxy/` (needs notes; particle bursts per note); verify `scene.test.mjs` covers pitch-to-radius, velocity-to-size, the per-stem arm and the strings, and add the registry line
- [x] 5.2 Run the dream-loop critique on the two songs that have notes; verify the verdict is in `LOOK.md`
- [x] 5.3 Verify with a Playwright test: on a song without notes the view offers Transcribe and starts no scene; with notes it draws, follows a seek, dims a muted stem and disposes cleanly

## 6. Lit stage

- [x] 6.1 Write `LOOK.md` and implement `scenes/lit-stage/` (keyboard, guitar and bass fretboards with lowest-fret mapping, drum kit pieces from GM keys, vocal light; needs notes, unlit instrument for an untranscribed stem); verify `scene.test.mjs` covers pitch-to-key, pitch-to-string-and-fret, drum-key-to-piece and the strings, and add the registry line
- [x] 6.2 Run the dream-loop critique on the two songs that have notes; verify the verdict is in `LOOK.md`
- [x] 6.3 Verify with a Playwright test: needs-notes state, a stem without notes shown unlit, a note lights its key, clean dispose

## 7. Song planet

- [x] 7.1 Write `LOOK.md` and implement `scenes/song-planet/` with both data tiers; verify `scene.test.mjs` covers time-to-angle (one lap is one song), section regions and the strings, and add the registry line
- [x] 7.2 Run the dream-loop critique on the three songs; verify the verdict is in `LOOK.md`
- [x] 7.3 Verify with a Playwright test: non-blank frame, halfway through the song is halfway round, muted stem dims, clean dispose

## 8. Drive the song

- [x] 8.1 Write `LOOK.md` and implement `scenes/drive/` with both data tiers (drum hits from notes, else from the drums' loudness peaks); verify `scene.test.mjs` covers tempo-to-pace, bar markers, bump timing and the strings, and add the registry line
- [x] 8.2 Run the dream-loop critique on the three songs; verify the verdict is in `LOOK.md`
- [x] 8.3 Verify with a Playwright test: non-blank frame, pace doubles between an 80 and a 160 beats-per-minute fixture, reduced motion holds the camera, clean dispose

## 9. Disposal

- [x] 9.1 Write `scripts/viz-remove.mjs` (`<id>` and `--all`) and `docs/visualizers.md` (how to add one, how to remove one, how to remove everything); verify the documented commands run as written on a scratch copy
- [x] 9.2 Add the disposal test: for every registered scene, remove it in a temp copy and assert the registry parses, the host unit tests pass there and no file mentions the id; and for `--all`, assert no `viz` or `three` reference remains and `index.html` parses; verify it runs with the other node tests and passes
- [ ] 9.3 Add the Labs mention to the README; verify it names only what the review in group 10 kept, after that review

## 10. Review and removal

- [ ] 10.1 Put the six visualizations in front of the project owner on the three songs and record, per visualization, keep or remove and one line of why, in `design.md` under "Review"; verify every one of the six has a decision
- [ ] 10.2 Remove each visualization marked remove with `scripts/viz-remove.mjs <id>`; verify the disposal test and the full node and Playwright suites pass afterwards, and a search for each removed id finds nothing
- [ ] 10.3 If none were kept, run `scripts/viz-remove.mjs --all`; verify the repository's diff against the commit before this change touches nothing outside `openspec/`
- [ ] 10.4 Run `uv run ruff check app/ tests/`, `uv run pytest tests/ -q`, every `tests/js/*.test.mjs`, and the Playwright suite with the microphone tests excluded while the owner is listening on Bluetooth; verify all pass, or list each failure that also fails on the base branch
- [ ] 10.5 Run `openspec validate add-stem-visualizers --strict`; verify it reports no errors

## Workflow follow-up

- Archive the change after the review is recorded and the kept set is final.
- Decide separately whether survivors leave Labs and whether video export is worth a change of its own.
