# Design

## Context

See proposal.md for motivation. What shapes the approach:

- **Data already served.** `stems/peaks.json` holds 3,000 loudness points per stem for the whole song. `GET /api/jobs/{id}/beats` gives beat times and bar marks (with the user's edits). `GET /api/jobs/{id}/transcription` gives notes per stem, as played or quantised, and answers 404 when nothing is transcribed. The job state has sections, key, tempo and duration. No new endpoint is needed.
- **Notes are optional.** Transcription takes minutes, is on demand, and is unavailable on Intel Macs. Most songs open with no notes.
- **The frontend has no build step.** `static/js` is plain ES modules; third-party code is vendored as files under `static/vendor/`. Strings live in `static/js/i18n.js` in ten languages, with tests that every key reaches every table.
- **Content-Security-Policy**: `script-src 'self' 'wasm-unsafe-eval'`, no inline scripts. WebGL is allowed. An inline `<script type="importmap">` is not.
- **Precedents.** Karaoke fills the window while the player keeps running (`static/js/karaoke/`). Stem colours are `STEM_COLORS` in `static/js/constants.js`. The player is the only clock.
- **The premise is doubt.** Any of the six may turn out to be useless. The design optimises for cheap removal over shared elegance.

## Goals / Non-Goals

**Goals:**
- A visualization is a folder. Adding one is adding a folder and a line; removing one is deleting them.
- Nothing about a visualization lives outside its folder: not strings, not styles, not tests, not assets.
- One shared, tested layer for the things all six need (clock, mixer state, song data, renderer lifecycle), so each visualization is only its own drawing code.
- The whole feature is removable the same way: one tree, one vendor folder, one entry point.

**Non-Goals:**
- Shared visual components between visualizations. Duplication between two scenes is preferred over a dependency between them, because a dependency makes one of them undeletable.
- Video export, phone UI, headset output.
- Photorealism. The targets are stylised (voxel, low-poly, particles), which are cheap to draw and suit data.
- Usage telemetry. StemDeck uploads nothing; the keep-or-remove decision is made by people looking at it.

## Decisions

### 1. Layout: host, registry, one folder per visualization

```
static/js/viz/
  host.js          opens and closes the view, owns the canvas and renderer, the picker, errors
  data.js          loads and normalises song data once per song (pure parts unit-tested)
  clock.js         player time, play state, rate; mixer state (mute, solo, gain) per stem
  registry.js      the list: one line per visualization
  scenes/
    note-terrain/  index.js  map.js  strings.js  scene.test.mjs  [assets]
    note-galaxy/   ...
    song-planet/   ...
    slit-scan/     ...
    lit-stage/     ...
    drive/         ...
static/css/viz.css       host styles only
static/vendor/three/     pinned Three.js files, VERSION, LICENSE
```

`registry.js` is the only place a visualization is named outside its folder:

```js
export const SCENES = [
  { id: "note-terrain", load: () => import("./scenes/note-terrain/index.js") },
  ...
];
```

Each `load` is a dynamic import, so a visualization costs nothing until chosen, and a missing or broken folder is a caught import failure: the host drops it from the list.

### 2. The contract every visualization implements

```js
export default {
  id: "note-terrain",
  needs: { notes: false },          // true: host shows "needs notes" instead of starting it
  strings,                          // its name and one-line description, ten languages
  create({ THREE, renderer, song, size, reducedMotion }) {
    return {
      scene, camera,                // host renders them
      update(frame),                // frame = { time, playing, rate, beat, bar, stems: {name: {level, lit}} }
      resize(size),
      setQuality(level),            // 0..2, called by the host's frame-rate guard
      dispose(),                    // must free every geometry, material and texture it made
    };
  },
};
```

- The host owns the single `WebGLRenderer`, the animation loop, resize, visibility, the frame-rate guard and error handling. A visualization never touches the DOM, the player or the network.
- `song` is plain data built once by `data.js`: `{ duration, stems: [{name, color, peaks, notes|null}], beats, bars, sections, key, bpm }`. Visualizations are pure functions of `song` and `frame`, which is what makes their mapping testable without WebGL.
- `stems[name].lit` already folds in mute and solo, so every visualization honours the mixer by construction.
- Each visualization's `map.js` holds its pure mapping (note to position, level to height, time to camera) and is what its `scene.test.mjs` tests under node.

Alternative considered: a base class with shared helpers. Rejected: inheritance couples scenes to a parent that then cannot change without touching all six.

### 3. Strings stay in the folder

A visualization needs two strings (name, description). They live in its own `strings.js` as `{ en: {...}, pl: {...}, ... }` and the host reads them through a small `sceneText(scene, key)` that follows the app's current language and falls back to English. Host strings (the view's title, "needs notes", errors) go in `static/js/i18n.js` as usual.

This departs from the project's rule that every string is in `i18n.js`. It is deliberate: twelve keys in ten tables of a 22,000-line file per visualization is exactly the residue that makes removal a chore. Each scene's test checks its `strings.js` has all ten languages, so the coverage guarantee is kept.

### 4. Disposal

- `node scripts/viz-remove.mjs <id>` deletes `static/js/viz/scenes/<id>/` and its line in `registry.js`, then greps the repository for the id and fails if anything remains.
- `node scripts/viz-remove.mjs --all` removes `static/js/viz/`, `static/css/viz.css` and its `<link>`, `static/vendor/three/`, the entry point's markup and wiring, the host strings, the host tests, `docs/visualizers.md` and the script itself. Every line it must remove outside the tree is bracketed by `viz:begin` / `viz:end` comments so the removal is mechanical.
- **A disposal test runs on every visualization on every run**: it copies the repository's `static/` and tests to a temp folder, removes one visualization with the script, and asserts the registry still parses, the host's unit tests pass there, and no file mentions the id. A second test does `--all` and asserts no `viz` or `three` reference remains and `index.html` still parses. Removal that works only in theory is the failure this change exists to avoid.
- No backend, no stored data, no settings beyond one `localStorage` key for the last choice, so there is nothing to migrate when one goes.

### 5. Vendoring Three.js

`static/vendor/three/` holds the pinned core ES module and only the add-ons the scenes use (expected: `OrbitControls`, `EffectComposer`, `RenderPass`, `UnrealBloomPass`, `OutputPass` and the shaders they import), with `VERSION` (version and SHA-256 per file) and the MIT license.

- **The bare-import problem.** The add-ons import from the bare specifier `"three"`, which a browser resolves only through an import map, and the CSP forbids an inline one. The vendoring step therefore rewrites that one specifier to a relative path. `scripts/vendor-three.mjs` does the download, the rewrite and the hashes, so an upgrade is one command and the modification is recorded and reproducible. Alternative considered: allowing an inline import map with a CSP hash. Rejected: it changes a security header for an experiment.
- The exact version is chosen in the first task from what is current then, and its documentation for that version is the reference. Three.js changes its API between releases.
- Loaded only when the Visualizer first opens.

### 6. The host view

A **Visualizer** button (Labs badge) beside the studio's view controls, in Practice and Advanced modes. It opens a layer over the lanes; the footer transport stays visible and usable, Esc closes. Not a mode: modes keep their own stems and saved mix, and looking at a picture should not change what is heard. Karaoke and Performance own the window and do not get the button.

Inside: the canvas, a picker (name and one-line description per visualization), and a message area for "needs notes" (with Transcribe), "failed", and "this computer cannot show it".

### 7. Clock and smoothness

`clock.js` reads the player's position each animation frame. Player time advances in audio-callback steps, so the clock extrapolates between reads using the play state and rate, and snaps on a seek or loop jump (a backwards step, or a forwards step larger than expected). This is what keeps motion smooth at 60 frames per second and exact after a jump.

The frame-rate guard averages frame time over a second; below about 45 frames per second it calls `setQuality` one step down (fewer particles, no bloom, lower pixel ratio, capped at 2 to begin with), and it never steps back up within a session. Drawing stops when the view is closed or `document.hidden`. On close the host calls `dispose()` and releases the renderer.

### 8. Data tiers

`data.js` returns notes per stem or `null`. Per visualization:

| Visualization | No notes | With notes |
|---|---|---|
| Note terrain | one ridge per stem from loudness | blocks at pitch, height from velocity |
| Note galaxy | needs notes | bursts per note |
| Song planet | loudness bands, sections | adds pitch texture to the bands |
| Slit-scan score | loudness bands | marks at pitch inside each band |
| Lit stage | needs notes (per stem: unlit instrument) | keys, frets, drum pieces |
| Drive the song | beats, loudness, sections | drum hits from the drum notes; otherwise from the drums' loudness peaks |

Notes are fetched as played (`quantize=0`): a picture should move when the sound does, and it then needs no beat grid. Thousands of notes are drawn as instanced meshes or point clouds, never one object each. Lit stage's fretboards use a simple lowest-fret mapping; if `add-alphatab-notation` lands, its fingering replaces that.

### 9. How the look gets made: the two skill sets

Installed in the first task group, into the git-ignored `.claude/skills/`, after vetting with the project's `vet-before-install` skill. They are instructions for the agent doing the work, not code that ships.

- **dream-loop** is the method for each visualization: make or obtain a target image of the finished look, build toward it, take a screenshot through the Playwright setup the repository already has, have a separate critic compare screenshot and target and list the top gaps, repeat until the critic passes. Its target-image step needs an image generator. Where none is available, the user supplies a reference image or the loop runs on critique alone against a written art direction; the tasks say which was used for each scene.
- **mengto/skills**, 3D category only (about 30 of its 1,900 files): used as technique references for lighting, camera lenses, god rays, high-resolution rendering and orbit controls. The rest of that repository is unrelated to this work and is not installed.

Each visualization's folder keeps a `LOOK.md`: its art direction, the reference or target image's source, and the critic's last verdict. That is also the evidence for the keep-or-remove review, and it is deleted with the folder.

## Risks / Trade-offs

- **[Six scenes is six times the work for something that may be thrown away]** → The host and data layer are built once and are most of the engineering. Scenes are built in order of confidence (terrain, slit-scan, galaxy first), and the review can stop the series early.
- **[Duplicated code across scenes]** → Accepted on purpose; see Non-Goals. If two scenes survive the review, sharing can be introduced then, between survivors.
- **[Strings outside `i18n.js` break the project's convention and its translation tests]** → Each scene's own test enforces ten languages; documented in `docs/visualizers.md`.
- **[The removal script rots]** → It is exercised by a test on every run, for every scene and for `--all`.
- **[Vendored Three.js is modified (one import specifier)]** → Done by a script, recorded with hashes, MIT permits it.
- **[WebGL in the desktop webview, or on weak GPUs]** → The host catches context-creation failure and context loss; the first task group includes a desktop-shell check; quality steps down automatically.
- **[A picture that looks good on one song and broken on another]** → Each scene is checked against three songs: dense rock, sparse acoustic, and one with no transcription and no sections.
- **[Third-party skills are instructions an agent will follow]** → Vetted before install, pinned to a commit, installed project-locally, and listed with their versions in the tasks.
- **[Motion sickness and flashing]** → `prefers-reduced-motion` is honoured by the host for every scene; bloom and beat flashes are capped in brightness and rate.

## Migration Plan

Additive, no stored data. Ships as Labs. Rollback is `node scripts/viz-remove.mjs --all`.

## Open Questions

- Which Three.js version to pin: decided in the first task from what is current, and recorded in `VERSION`.
- Whether surviving visualizations graduate from Labs, and whether video export follows. Both are for after the review.
