# Visualizers (Labs)

The Visualizer is an experimental view that shows the open song's stems as a moving 3D picture. It follows StemDeck's own player and mixer, makes no sound and changes nothing. It opens from the cube button marked **Labs** at the right of the footer, in Practice and Advanced modes.

It is built so that any picture, or all of it, can be removed without leaving anything behind. This page says how to add one, how to remove one, and how to remove everything.

## Where things are

```
static/js/viz/
  host.js        the view: canvas, renderer, draw loop, picker, messages
  data.js        loads a song once: loudness, beats, bars, sections, notes
  clock.js       player time per frame, and what the mixer lets through
  registry.js    the list: one line per visualization
  scenes/<id>/   one folder per visualization, with everything it has
static/css/viz.css        the view's own styles
static/vendor/three/      Three.js, pinned (scripts/vendor-three.mjs)
tests/js/viz-*.test.mjs   node tests for the shared parts, and the runners
tests/e2e/viz-*.mjs       browser tests for the host, and the runner
scripts/viz-remove.mjs    removes one visualization, or everything
```

Outside those, the Visualizer has only a few lines, each between a `viz:begin` and a `viz:end` comment: a stylesheet link and the button in `static/index.html`, an import and a call in `static/js/main.js`, the view's own strings in each language table of `static/js/i18n.js`, and a mention in `README.md`.

## What a visualization is

A folder `static/js/viz/scenes/<id>/` holding:

| File | What it is |
|---|---|
| `index.js` | Builds the picture with Three.js. Default-exports `{ id, needs, strings, create }`. |
| `map.js` | The mapping from song to picture as plain numbers: no Three.js, no DOM. This is what the node test tests. |
| `strings.js` | Its name and one-line description (and any other text) in the ten languages. |
| `scene.test.mjs` | Its node test: the mapping, both data tiers, the strings. |
| `scene.e2e.mjs` | Its browser test. Exports a function that defines Playwright tests. |
| `LOOK.md` | Its art direction, the songs it was checked on, and the critic's verdict. |

`create({ THREE, renderer, song, size, reducedMotion, text, stemLabel })` returns:

```js
{
  scene, camera,            // the host draws them
  update(frame),            // frame = { time, playing, rate, jumped, beat, bar, stems: { name: { level, lit, gain } } }
  resize(size),             // { width, height, pixelRatio }
  setQuality(level),        // 0..2: the host lowers it when frames get slow
  dispose(),                // free every geometry, material and texture it made
  bloom,                    // optional { strength, radius, threshold }: the host draws the glow
  timeAt({ x, y }),         // optional: a click at this point of the view seeks to this many seconds
  caption(),                // optional: one line of text over the picture
  debug(),                  // optional: whatever its tests want to read
}
```

Rules that keep a visualization removable and honest:

- **It touches nothing outside its folder.** No DOM, no player, no network, no import from another visualization or from the app. `THREE` is handed in. If two visualizations need the same helper, each has its own copy: a shared helper would make one of them impossible to delete.
- **It is a function of `song` and `frame`.** Draw the moment `frame.time` says, never "what came after the last frame", so pause, seek, loop and half speed all work without special cases.
- **It follows the mixer through `frame.stems[name].lit`.** A stem that is muted, or not soloed while another is, has `lit: false`: dim it or hide it.
- **It uses a stem's own colour** (`song.stems[i].color`) for that stem and nothing else.
- **Notes are optional.** `song.stems[i].notes` is a list or `null`. Either draw from loudness when it is `null`, or set `needs: { notes: true }` and the host will say so and offer Transcribe instead of starting it.
- **`reducedMotion` means a calm version:** no travelling camera (the host pins the camera too), no flashing, no glow.
- **Its strings are in its own `strings.js`**, not in `static/js/i18n.js`. This is the one place the project's "every string is in i18n.js" rule is set aside, on purpose: strings in the shared file would be left behind when the folder is deleted. Each `scene.test.mjs` checks all ten languages are there.
- **Its id is two or more lower-case words joined by hyphens** (`rain-of-notes`), and is used nowhere else in the project. A one-word id such as `drive` is already a word somewhere in the app, and then nobody can tell what a search for it should find.

## Add one

1. Copy an existing folder under `static/js/viz/scenes/` that is close to what you want to `static/js/viz/scenes/<your-id>/`, and change the `id` at the bottom of its `index.js`.
2. Add one line to `static/js/viz/registry.js`:

   ```js
   { id: "<your-id>", load: () => import("./scenes/<your-id>/index.js") },
   ```

3. Write its `LOOK.md` first (what it should look like, in words or with a reference image), then `map.js` and its test, then `index.js`.
4. Run its tests:

   ```sh
   node static/js/viz/scenes/<your-id>/scene.test.mjs
   node tests/js/viz-scenes.test.mjs
   npx playwright test tests/e2e/viz-scenes.spec.mjs
   ```

Nothing else needs to change: no string table, no stylesheet, no test list.

## Remove one

The ids are the folder names under `static/js/viz/scenes/`. This page names none of them, on purpose: a page that did would be a leftover the moment that one was removed.

```sh
node scripts/viz-remove.mjs <id>
```

It deletes `static/js/viz/scenes/<id>/` and the visualization's line in `registry.js`, then searches the project for the id and fails, listing every line, if it is still mentioned anywhere. The other visualizations and the Visualizer itself are untouched. If it was the last one, the button disappears by itself: with nothing in the registry the Visualizer is not offered.

## Remove everything

```sh
node scripts/viz-remove.mjs --all
```

It deletes `static/js/viz/`, `static/css/viz.css`, `static/vendor/three/`, the `viz-*` test files, `scripts/vendor-three.mjs`, this page and the script itself, and strips every `viz:begin` to `viz:end` block from the rest of the project. Then it searches for anything of the Visualizer left behind and fails, listing every line, if it finds any. Afterwards the app is as it was before the Visualizer existed: there is no backend part, no stored data and no setting to migrate (the one remembered choice is a `localStorage` key, `stemdeck.viz.scene`, that nothing else reads).

`openspec/` is planning history and is neither changed nor searched by either command.

Both commands are run by a test on every run, on a temporary copy of the project (`tests/js/viz-disposal.test.mjs`): for every visualization in the registry, and for `--all`. To try one by hand without touching your checkout, give it a copy:

```sh
cp -R static tests scripts docs README.md package.json /tmp/stemdeck-copy/
node scripts/viz-remove.mjs --all --root /tmp/stemdeck-copy
```

## The 3D library

`static/vendor/three/` is Three.js, pinned, with a `VERSION` file listing a SHA-256 for every file. It is loaded only when the Visualizer first opens. To check the files or to upgrade:

```sh
node scripts/vendor-three.mjs --check    # the files match VERSION
node scripts/vendor-three.mjs            # download the pinned release again
```

To upgrade, change `VERSION` and `INTEGRITY` at the top of the script and run it. The script makes one change to the upstream files, recorded in `VERSION`: the add-ons import from the bare name `"three"`, which a browser resolves only through an import map, and StemDeck's Content-Security-Policy does not allow an inline one, so that import is rewritten to a relative path.
