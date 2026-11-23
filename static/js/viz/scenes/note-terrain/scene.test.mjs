// Note terrain: its mapping, both data tiers, and its strings.
//
// Run:  node static/js/viz/scenes/note-terrain/scene.test.mjs
// (tests/js/viz-scenes.test.mjs runs every visualization's scene.test.mjs.)

import * as THREE from "../../../../vendor/three/three.module.js";
import scene from "./index.js";
import { strings } from "./strings.js";
import {
  SPEED, VOXEL, CELL, FIELD_WIDTH, LANE_WIDTH, CHUNK_SECONDS, VIEW_AHEAD, FUTURE, PAST, FOV, HOLD_SECONDS, FADE_SECONDS,
  levelAt, pitchRange, pitchX, layout, noteBlocks, ridgeBlocks, stemBlocks, extent, cameraFor,
  chunkOf, chunkVisible, litAmount, shadeFor, litValue, upperBound, placement,
} from "./map.js";

let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const note = (start, end, pitch, velocity = 0.8) => ({ start, end, pitch, velocity });
const ramp = (n, f) => Float32Array.from({ length: n }, (_, i) => f(i / (n - 1)));
const stem = (name, notes, peaks = ramp(64, (x) => x), color = "#88d878") => ({ name, color, peaks, notes });
// A bass line walking up a scale, a chord, and two stems with no notes.
const SCALE = [40, 42, 44, 45, 47, 49, 51, 52].map((p, i) => note(i * 0.5, i * 0.5 + 0.375, p, 0.4 + i * 0.07));
const withNotes = (over = {}) => ({
  duration: 40,
  bpm: 120,
  beats: Array.from({ length: 80 }, (_, i) => i * 0.5),
  bars: Array.from({ length: 20 }, (_, i) => i * 2),
  sections: [{ start: 0, end: 20, kind: "verse", name: "Verse", color: "#ff8800" }, { start: 20, end: 40, kind: "chorus", name: "Chorus", color: "#00aaff" }],
  hasNotes: true,
  stems: [
    stem("vocals", [note(1, 3, 64, 1), note(1, 3, 67, 0.2), note(30, 30.1, 72, 0.5)], undefined, "#e85f6f"),
    stem("drums", null, ramp(64, () => 0.5), "#e89048"),
    stem("bass", SCALE, undefined, "#e8b848"),
    stem("other", null, ramp(64, () => 0), "#88a8c8"),
  ],
  ...over,
});
const withoutNotes = () => {
  const s = withNotes({ hasNotes: false, sections: [], beats: [], bars: [] });
  for (const st of s.stems) st.notes = null;
  return s;
};
const lights = (over = {}) => ({
  vocals: { level: 0.5, lit: true, gain: 1 }, drums: { level: 0.5, lit: true, gain: 1 },
  bass: { level: 0.5, lit: true, gain: 1 }, other: { level: 0, lit: true, gain: 1 }, ...over,
});
const frame = (time, over = {}) => ({ time, playing: true, rate: 1, jumped: false, beat: null, bar: null, stems: lights(), ...over });

// -- pitch across -----------------------------------------------------------------

const range = pitchRange(withNotes().stems);
check("the pitch range covers the notes drawn", range.min <= 40 && range.max >= 67, JSON.stringify(range));
check("with no notes there is a default range", JSON.stringify(pitchRange([])) === JSON.stringify({ min: 36, max: 84 }));
check("a narrow part still gets two octaves", (() => { const r = pitchRange([{ notes: [note(0, 1, 60), note(1, 2, 62)] }]); return r.max - r.min >= 24; })());
{
  // One stray note in a thousand must not stretch the field.
  const many = Array.from({ length: 1000 }, (_, i) => note(i * 0.1, i * 0.1 + 0.05, 48 + (i % 24)));
  const tight = pitchRange([{ notes: many }]);
  const stretched = pitchRange([{ notes: [...many, note(0, 1, 120)] }]);
  check("a stray note does not stretch the field", stretched.max === tight.max, `${stretched.max} vs ${tight.max}`);
  check("a note outside the range is drawn at its edge", pitchX(120, tight).x === pitchX(tight.max, tight).x);
}
const xs = SCALE.map((n) => pitchX(n.pitch, range).x);
check("a line walking up a scale steps across in pitch order", xs.every((x, i) => i === 0 || x > xs[i - 1]), xs.join(","));
check("the field is centred", near(pitchX((range.min + range.max) / 2, range).x, 0));
check("the whole range fits the field", pitchX(range.max, range).x - pitchX(range.min, range).x < FIELD_WIDTH);

// -- a note is a run of blocks ------------------------------------------------------

const soft = noteBlocks(note(2, 2.1, 60, 0.1), range);
const hard = noteBlocks(note(2, 2.1, 60, 1), range);
check("a harder note is a taller block", hard[0].h > soft[0].h);
check("heights come in voxel steps", near(Math.round(hard[0].h / VOXEL) * VOXEL, hard[0].h) && near(Math.round(soft[0].h / VOXEL) * VOXEL, soft[0].h));
check("a block stands on the ground", near(hard[0].y, hard[0].h / 2));
const early = noteBlocks(note(1, 1.1, 60), range);
const late = noteBlocks(note(9, 9.1, 60), range);
check("later is further into the screen", late[0].z < early[0].z);
check("a moment sits at -time * SPEED", near(early[0].z, -(1 * SPEED + CELL / 2)));
check("a short note is one block", early.length === 1);
const held = noteBlocks(note(4, 5, 60, 1), range);
check("a held note is a run of blocks, one per cell", held.length === Math.round((1 * SPEED) / CELL), String(held.length));
check("each block of the run is a step lower, down to one step", held.every((b, i) => i === 0 || near(b.h, Math.max(VOXEL, held[i - 1].h - VOXEL))), held.map((b) => b.h.toFixed(1)).join(","));
check("the run dies away", held[held.length - 1].h < held[0].h);
check("each block has its own moment on the line", held.every((b, i) => near(b.start, 4 + (i * CELL) / SPEED) && near(b.end - b.start, CELL / SPEED)));
check("the run covers the note's length along -z", near(held[held.length - 1].z, -(4 * SPEED + (held.length - 0.5) * CELL)));
check("a very long note is capped", noteBlocks(note(0, 600, 60), range).length <= 48);
check("blocks of neighbouring pitches do not touch", (() => { const a = noteBlocks(note(0, 0.1, 60), range)[0]; const b = noteBlocks(note(0, 0.1, 61), range)[0]; return a.x + a.w / 2 < b.x - b.w / 2; })());

// -- loudness ridges ----------------------------------------------------------------

check("levelAt is linear between points", near(levelAt(new Float32Array([0, 1]), 10, 2.5), 0.25));
check("levelAt of nothing is 0", levelAt(new Float32Array(0), 10, 1) === 0 && levelAt(null, 10, 1) === 0);
const lane = { x: 10, width: LANE_WIDTH };
const crests = (blocks) => blocks.filter((b) => near(b.x, 10));
const ridge = ridgeBlocks(ramp(160, (x) => x), 20, lane);
check("a ridge step is a crest and two shoulders", ridge.length % 3 === 0 && ridge.length > 0);
check("a ridge's height follows its loudness", (() => { const c = crests(ridge); return c[c.length - 1].h > c[Math.floor(c.length / 2)].h && c[Math.floor(c.length / 2)].h > c[0].h; })());
check("the shoulders are lower than the crest", (() => { const i = ridge.length - 3; return ridge[i + 1].h < ridge[i].h && ridge[i + 2].h < ridge[i].h; })());
check("the three share one footprint", (() => { const i = ridge.length - 3; return ridge[i].w === ridge[i + 1].w && ridge[i].d === ridge[i + 2].d && ridge[i].z === ridge[i + 1].z; })());
check("the shoulders stay inside the lane", ridge.every((b) => Math.abs(b.x - 10) + b.w / 2 <= LANE_WIDTH / 2 + 1e-9));
check("crest and shoulders stand shoulder to shoulder", (() => { const i = ridge.length - 3; return near(ridge[i].x - ridge[i].w / 2, ridge[i + 1].x + ridge[i + 1].w / 2); })());
check("steps follow each other with no gap", (() => { const c = crests(ridge); return near(c[0].z - c[0].d / 2, c[1].z + c[1].d / 2, 1e-6); })());
check("ridge steps are a cell deep", near(crests(ridge)[0].end - crests(ridge)[0].start, CELL / SPEED, 0.01));
check("ridge steps run in time order along -z", (() => { const c = crests(ridge); return c[1].start > c[0].start && c[1].z < c[0].z; })());
check("a quiet moment is bare ground, not a thin plate", ridgeBlocks(ramp(160, () => 0.001), 20, lane).length === 0 && ridge.every((b) => b.h >= VOXEL));
check("a silent stem is bare ground", ridgeBlocks(ramp(40, () => 0), 20, lane).length === 0);
check("no peaks, no ridge", ridgeBlocks(new Float32Array(0), 20, lane).length === 0 && ridgeBlocks(ramp(4, () => 1), 0, lane).length === 0);
{
  // 400 points in 6 seconds would be blocks a hair deep: they are taken together.
  const fine = crests(ridgeBlocks(ramp(400, () => 0.5), 6, lane));
  check("points closer than a block are taken together", fine.length === 50 && fine[0].d > 0.8, `${fine.length} ${fine[0].d}`);
  check("grouped steps cover the song end to end", near(fine[fine.length - 1].end, 6) && near(fine[1].start, fine[0].end));
  const spike = new Float32Array(400);
  spike[5] = 0.9;
  check("the loudest point of a group wins", crests(ridgeBlocks(spike, 6, lane)).length === 1 && ridgeBlocks(spike, 6, lane)[0].start < 0.1);
}

// -- which stems are notes and which are ridges -------------------------------------------

const mixed = layout(withNotes().stems);
check("stems with notes are drawn from notes", mixed.noted.join() === "vocals,bass");
check("stems without notes are ridges", mixed.ridged.join() === "drums,other");
check("ridges flank the pitch field, left and right", mixed.lanes.drums.x < -FIELD_WIDTH / 2 && mixed.lanes.other.x > FIELD_WIDTH / 2);
check("a stem drawn from notes has no ridge lane", !("bass" in mixed.lanes));
const bare = layout(withoutNotes().stems);
check("without notes every stem is a ridge", bare.noted.length === 0 && bare.ridged.length === 4);
const laneXs = bare.ridged.map((n) => bare.lanes[n].x);
check("the ridges share the width, in stem order, centred", laneXs.every((x, i) => i === 0 || x > laneXs[i - 1]) && near(laneXs[0] + laneXs[3], 0));
check("a stem transcribed but silent is a ridge too", layout([stem("piano", [])]).ridged.join() === "piano");
{
  const song = withNotes();
  const bass = stemBlocks(song.stems[2], song, mixed, range);
  check("the bass is drawn from its notes", bass.length === SCALE.length * 3, String(bass.length));
  check("blocks come in the order the line reaches them", bass.every((b, i) => i === 0 || b.start >= bass[i - 1].start));
  const drums = stemBlocks(song.stems[1], song, mixed, range);
  check("the drums, with no notes, from loudness", drums.length > 0 && drums.every((b) => Math.abs(b.x - mixed.lanes.drums.x) < LANE_WIDTH));
  check("a stem with neither draws nothing", stemBlocks(song.stems[3], song, mixed, range).length === 0);
  check("only the bass transcribed: the bass from notes, the others from loudness", (() => {
    const s2 = withoutNotes();
    s2.stems[2].notes = SCALE;
    const p2 = layout(s2.stems);
    return p2.noted.join() === "bass" && p2.ridged.join() === "vocals,drums,other";
  })());
}

// -- framing ---------------------------------------------------------------------------

check("extent is how far across the blocks reach", JSON.stringify(extent([[{ x: -3, w: 2 }], [{ x: 5, w: 4 }]])) === JSON.stringify({ min: -4, max: 7 }));
check("no blocks, no extent", extent([[], []]) === null);
{
  const wide = cameraFor(30, 2);
  const narrow = cameraFor(10, 2);
  check("a wider landscape is seen from further back and higher", wide.back > narrow.back && wide.height > narrow.height);
  check("and further ahead", wide.sees > narrow.sees && narrow.sees > 0);
  check("a narrower picture stands further back for the same landscape", cameraFor(30, 1).back > wide.back);
  // Project a point of the present line through the camera this describes.
  const cam = new THREE.PerspectiveCamera(FOV, 2, 0.5, 600);
  cam.position.set(0, wide.height, wide.back);
  cam.lookAt(0, 0, -wide.lookAhead);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const edge = new THREE.Vector3(30, 0, 0).project(cam);
  check("the whole width is in the picture at the present line", Math.abs(edge.x) < 0.95 && Math.abs(edge.x) > 0.6, String(edge.x));
  const down = (1 - edge.y) / 2;
  check("the present line sits near the bottom of the picture", down > 0.84 && down < 0.94, String(down));
}

// -- what is lit, what can be seen ----------------------------------------------------------

const block = held[2];
check("a block still to come is not lit", litAmount(block, block.start - 0.01) === -1);
check("a block on the present line is lit", litAmount(block, block.start) === 1 && litAmount(block, block.end - 0.001) === 1);
check("it stays lit for one more block's length", litAmount(block, block.end + HOLD_SECONDS) === 1);
check("then it fades, quickly at first", (() => { const a = litAmount(block, block.end + HOLD_SECONDS + FADE_SECONDS / 2); return a > 0.1 && a < 0.4; })());
check("and is dark once it is past", litAmount(block, block.end + HOLD_SECONDS + FADE_SECONDS) === 0 && litAmount(block, 99) === 0);
check("only the blocks at the line are lit, not the whole note", held.filter((b) => litAmount(b, 4.5) > 0).length <= 3 && held.filter((b) => litAmount(b, 4.5) === -1).length >= 3, held.map((b) => litAmount(b, 4.5)).join(","));
check("a block to come is drawn at half strength", shadeFor(-1, 3) === FUTURE);
check("a lit block at the stem's lit value, a past one nearly black", shadeFor(1, 3) === 3 && shadeFor(0, 3) === PAST);
check("the fade runs between them", shadeFor(0.5, 3) > PAST && shadeFor(0.5, 3) < 3);
check("to come is brighter than played", FUTURE > PAST * 4);
check("every stem is lit to the same brightness, whatever its hue", near(litValue(0.45) * 0.45, litValue(0.7) * 0.7) && litValue(0.45) > litValue(0.7));
check("lit is always brighter than to come", litValue(1) > FUTURE && litValue(0.9, true) > FUTURE);
check("the calm version lights less", litValue(0.3, true) < litValue(0.3));
const sorted = [1, 2, 2, 5].map((s) => ({ start: s }));
check("upperBound finds the first block after a time", upperBound(sorted, 0) === 0 && upperBound(sorted, 2) === 3 && upperBound(sorted, 9) === 4);
check("slabs are CHUNK_SECONDS long", chunkOf(0) === 0 && chunkOf(CHUNK_SECONDS) === 1 && chunkOf(-3) === 0);
check("the slab at the present can be seen", chunkVisible(chunkOf(40), 40, VIEW_AHEAD[2]));
check("a slab far ahead cannot", !chunkVisible(chunkOf(40) + 3, 40, VIEW_AHEAD[2]));
check("a slab long past cannot", !chunkVisible(0, 200, VIEW_AHEAD[2]));
check("lower detail sees less far", VIEW_AHEAD[0] < VIEW_AHEAD[1] && VIEW_AHEAD[1] < VIEW_AHEAD[2]);

const moving = placement(10);
check("in motion the landscape slides and the line stays", near(moving.landscapeZ, 10 * SPEED) && moving.lineZ === 0);
const calmA = placement(13, { calm: true, page: 12 });
const calmB = placement(20, { calm: true, page: 12 });
check("calm: the landscape holds still within a page", calmA.landscapeZ === calmB.landscapeZ && near(calmA.landscapeZ, 12 * SPEED));
check("calm: the line walks along the page instead", near(calmA.lineZ, -1 * SPEED) && near(calmB.lineZ, -8 * SPEED));
check("calm: the next page starts where the last ended", near(placement(24, { calm: true, page: 12 }).landscapeZ, 24 * SPEED));

// -- the scene itself, both tiers ------------------------------------------------------------

check("the visualization names itself", scene.id === "note-terrain" && scene.needs.notes === false && scene.strings === strings);
const size = { width: 1200, height: 600, pixelRatio: 1 };
const byName = (inst) => Object.fromEntries(inst.debug().stems.map((s) => [s.name, s]));
{
  const inst = scene.create({ THREE, renderer: null, song: withNotes(), size, reducedMotion: false, text: (k) => k });
  check("create returns the contract", inst.scene.isScene && inst.camera.isCamera && ["update", "resize", "setQuality", "dispose"].every((k) => typeof inst[k] === "function"));
  check("it asks the host for a glow", inst.bloom && inst.bloom.strength > 0);
  inst.setQuality(2);
  inst.update(frame(2));
  const d = inst.debug();
  const by = byName(inst);
  check("with notes: the bass has a block run per note", by.bass.blocks === SCALE.length * 3, JSON.stringify(by.bass));
  check("with notes: an untranscribed stem is still drawn, as a ridge", by.drums.blocks > 0 && by.drums.blocks % 3 === 0);
  check("with notes: a silent stem draws nothing and breaks nothing", by.other.blocks === 0);
  check("the landscape is at the present moment", near(d.landscapeZ, 2 * SPEED) && d.lineZ === 0);
  check("the picture is framed on what is drawn", d.half > 10 && Math.abs(d.centre) < FIELD_WIDTH);
  inst.update(frame(1, { jumped: true }));
  const start = byName(inst).vocals;
  check("only slabs near the present are drawn", start.chunks === 2 && start.visible === 1, JSON.stringify(start));
  const colour = by.bass.tint;
  inst.update(frame(2.1, { stems: lights({ bass: { level: 0.5, lit: false, gain: 0 } }) }));
  const grey = new THREE.Color(byName(inst).bass.tint);
  check("a muted stem loses its colour: it goes grey", byName(inst).bass.tint !== colour && near(grey.r, grey.g) && near(grey.g, grey.b));
  check("the others keep their colour", byName(inst).vocals.tint === by.vocals.tint);
  inst.update(frame(2.2));
  check("unmuted, it has its colour again", byName(inst).bass.tint === colour);
  inst.update(frame(31, { jumped: true }));
  check("a seek moves the landscape with it", near(inst.debug().landscapeZ, 31 * SPEED));
  inst.update(frame(1, { jumped: true }));
  check("and back", near(inst.debug().landscapeZ, 1 * SPEED));
  const before = inst.camera.position.z;
  inst.resize({ width: 500, height: 800, pixelRatio: 1 });
  check("resize keeps the camera's aspect and steps back on a narrow view", near(inst.camera.aspect, 500 / 800) && inst.camera.position.z > before);
  const farFog = inst.scene.fog.far;
  inst.setQuality(0);
  inst.update(frame(1.1));
  check("lower detail still draws", inst.debug().stems.some((s) => s.visible > 0));
  check("lower detail brings the fog in", inst.scene.fog.far < farFog);
  check("the fog starts beyond the present line, however far back the camera stands", inst.scene.fog.near > Math.hypot(inst.camera.position.y, inst.camera.position.z));
  let threw = null;
  try { inst.dispose(); } catch (e) { threw = e; }
  check("dispose frees without complaint", threw === null, String(threw));
}
{
  const inst = scene.create({ THREE, renderer: null, song: withoutNotes(), size, reducedMotion: false, text: (k) => k });
  inst.update(frame(5));
  const d = inst.debug();
  check("without notes: one ridge per stem that makes a sound", d.plan.noted.length === 0 && d.stems.filter((s) => s.blocks > 0).length === 3 && byName(inst).other.blocks === 0);
  check("without notes: no beat grid and no sections is fine", near(d.landscapeZ, 5 * SPEED));
  inst.dispose();
}
{
  const inst = scene.create({ THREE, renderer: null, song: withNotes(), size, reducedMotion: true, text: (k) => k });
  check("calm: no glow is asked for", inst.bloom === null);
  inst.update(frame(13));
  const a = inst.debug();
  const camA = inst.camera.position.toArray().join();
  inst.update(frame(20));
  const b = inst.debug();
  check("calm: the landscape does not travel between frames", a.landscapeZ === b.landscapeZ && a.calm === true);
  check("calm: the present-moment line does", b.lineZ < a.lineZ);
  check("calm: the camera does not move", inst.camera.position.toArray().join() === camA);
  inst.dispose();
}
{
  // Tens of thousands of notes: built in slabs, and only a few are drawn.
  const dense = withNotes({ duration: 600 });
  dense.stems[0].notes = Array.from({ length: 40000 }, (_, i) => note(i * 0.015, i * 0.015 + 0.1, 40 + (i % 40), 0.5));
  const inst = scene.create({ THREE, renderer: null, song: dense, size, reducedMotion: false, text: (k) => k });
  inst.update(frame(300));
  const v = byName(inst).vocals;
  check("a dense song is cut into slabs", v.blocks === 40000 && v.chunks >= 30, JSON.stringify(v));
  check("and only the slabs in view are drawn", v.visible <= 3, String(v.visible));
  inst.dispose();
}

// -- strings ----------------------------------------------------------------------------------

const LANGS = ["en", "pl", "ja", "ko", "zh-Hans", "de", "fr", "es", "pt", "id"];
check("strings come in the ten languages", LANGS.every((l) => strings[l]) && Object.keys(strings).length === LANGS.length, Object.keys(strings).join(","));
for (const lang of LANGS) {
  const s = strings[lang] || {};
  check(`${lang} has a name and a description`, typeof s.name === "string" && s.name.trim() && typeof s.description === "string" && s.description.trim());
  if (lang !== "en") check(`${lang} is translated`, s.description !== strings.en.description);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
