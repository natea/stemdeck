// The installed visualizations: one line each, and the only place outside its
// own folder that a visualization is named. docs/visualizers.md says how to add
// one; `node scripts/viz-remove.mjs <id>` removes one.
//
// Each `load` is a dynamic import, so a missing or broken folder is a caught
// failure: the host leaves that entry out of its list and the rest work.
export const SCENES = [
  { id: "note-terrain", load: () => import("./scenes/note-terrain/index.js") },
  { id: "slit-scan", load: () => import("./scenes/slit-scan/index.js") },
  { id: "note-galaxy", load: () => import("./scenes/note-galaxy/index.js") },
  { id: "lit-stage", load: () => import("./scenes/lit-stage/index.js") },
  { id: "song-planet", load: () => import("./scenes/song-planet/index.js") },
  { id: "drive-the-song", load: () => import("./scenes/drive-the-song/index.js") },
];
