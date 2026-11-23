# Proposal

## Why

StemDeck knows a great deal about a song (how loud each instrument is at every moment, where the beats and bars fall, and after transcription the notes themselves) and shows it only as waveforms. A 3D view of the stems could make a song something to watch as well as to practise, for people who do not read waveforms or notation. Nobody knows yet which picture is worth having, so this change builds six candidates cheaply, side by side, with removal designed in from the start.

## What Changes

- Add a **Visualizer** view (marked Labs) that opens over the studio, follows StemDeck's own playback, and makes no sound of its own.
- Add six visualizations to choose between in that view, each drawn with Three.js from the song's stems:
  1. **Note terrain**: a voxel landscape, time into the screen, pitch across, height from how hard a note was played, colour by stem.
  2. **Note galaxy**: one spiral arm per stem; each note fires particles at a radius set by its pitch.
  3. **Song planet**: the song wrapped once around a small sphere, sections as terrain; playback walks around it.
  4. **Slit-scan score**: a flat strip, one column per moment, stems as stacked colour bands: the whole song at a glance.
  5. **Lit stage**: a low-poly stage whose keyboard, fretboard and drum pieces light up note by note.
  6. **Drive the song**: a road at the song's tempo, drum hits as bumps, sections as scenery.
- Every visualization follows the mixer: a muted stem goes dark, a soloed stem stands alone.
- Visualizations use the transcribed notes when the song has them and fall back to loudness and beats when it does not. The two that are meaningless without notes say so and offer Transcribe.
- **Disposal is a feature.** Each visualization is one self-contained folder plus one line in a list. Removing one, or the whole Visualizer, is a documented one-command operation that leaves no strings, styles, tests or dead code behind, and a test proves that for every visualization on every run.
- The change ends with a **keep or remove review** of each of the six, and removes the ones that did not earn their place.
- Vendor a pinned Three.js build into `static/vendor/`. No build step, no CDN, no backend change.
- Install two agent skills for the people and agents doing the work: `achimala/dream-loop` (generate a target image, build toward it, have a critic compare screenshots) and the 3D recipes from `mengto/skills`. They are development tooling in the git-ignored `.claude/skills/`, vetted before install, and are not shipped with StemDeck.

Not in this change: exporting a visualization as video, a visualizer in the phone UI, AR or headset output, and user-made visualizations.

## Capabilities

### New Capabilities
- `stem-visualizers`: the Visualizer view, what every visualization must do (follow playback and the mixer, work without notes or say why not, stay responsive), the six visualizations, and the guarantee that any of them can be removed cleanly.

### Modified Capabilities

None. The view reads data that existing endpoints already serve.

## Impact

- **Frontend**: a new `static/js/viz/` tree (host, shared data loader, registry, one folder per visualization), one entry point in the studio UI, host strings in `static/js/i18n.js`, host styles in a new `static/css/viz.css`.
- **Vendored files**: `static/vendor/three/` (Three.js core module and the few add-ons used, MIT), with a version file and hashes. Well under 2 MB.
- **Backend**: none. Data comes from `peaks.json`, `GET /api/jobs/{id}/beats`, `GET /api/jobs/{id}/transcription` and the job state.
- **Depends on** `add-stem-transcription` for notes. Without it the visualizations still run on loudness and beats.
- **Tests**: node unit tests for the data loader and each visualization's pure mapping, Playwright tests for the host, and a disposal test per visualization.
- **Tooling**: two third-party skill sets in `.claude/skills/` (git-ignored, so each developer installs them; the tasks record the exact commands and versions). dream-loop wants an image generator for its target pictures; without one the screenshot-and-critique half is still used.
- **Performance and platforms**: needs WebGL. Machines without it, or users who ask for reduced motion, get a plain message or a still frame instead of a broken canvas.
- **Docs**: README (Labs mention), a short `docs/visualizers.md` on adding and removing one.
