// Song planet: time to angle (one lap is one song), section regions, both data
// tiers, and its strings.
//
// Run:  node static/js/viz/scenes/song-planet/scene.test.mjs
// (tests/js/viz-scenes.test.mjs runs every visualization's scene.test.mjs.)

import * as THREE from "../../../../vendor/three/three.module.js";
import scene from "./index.js";
import { strings } from "./strings.js";
import {
  RADIUS, LIFT, LAT_SPAN, BAND_GAP, SEGMENTS, NOTE_CAP, CAMERA_DISTANCE, CAMERA_ELEVATION,
  timeToAngle, angleToTime, surfacePoint, cameraPlace, angleOf, bandLatitudes, levelAt, stepLevel, lift, loudestOf, profile,
  sectionAt, sectionRegions, pitchSpan, notePlace, thin,
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
const TAU = Math.PI * 2;
const note = (start, end, pitch, velocity = 0.8) => ({ start, end, pitch, velocity });

// -- one lap is one song ------------------------------------------------------------

check("the song starts at longitude 0", timeToAngle(0, 200) === 0);
check("halfway through the song is halfway round", near(timeToAngle(100, 200), Math.PI));
check("a quarter is a quarter turn", near(timeToAngle(50, 200), Math.PI / 2));
check("the end of the song is one whole lap", near(timeToAngle(200, 200), TAU));
check("past the end is still one lap, not more", near(timeToAngle(900, 200), TAU) && timeToAngle(-5, 200) === 0);
check("a song with no length does not turn", timeToAngle(10, 0) === 0);
check("angle to time is the way back", [0, 13.7, 100, 199].every((t) => near(angleToTime(timeToAngle(t, 200), 200), t, 1e-9)));
check("an angle wraps", near(angleToTime(TAU + Math.PI, 200), 100) && near(angleToTime(-Math.PI / 2, 200), 150));

// -- places on the planet -------------------------------------------------------------

{
  const front = surfacePoint(0, 0, 10);
  const east = surfacePoint(Math.PI / 2, 0, 10);
  const pole = surfacePoint(1.234, 90, 10);
  check("longitude 0 faces +z", near(front.x, 0) && near(front.y, 0) && near(front.z, 10));
  check("longitude grows toward +x", near(east.x, 10) && near(east.z, 0, 1e-9));
  check("the north pole is straight up, whatever the longitude", near(pole.y, 10) && near(pole.x, 0, 1e-9) && near(pole.z, 0, 1e-9));
  check("a point is at its distance from the centre", near(Math.hypot(...Object.values(surfacePoint(2.2, 37, 12.5))), 12.5));
}
{
  const cam = cameraPlace(Math.PI);
  check("halfway through, the viewpoint is over the far side", cam.z < 0 && near(cam.x, 0, 1e-9));
  check("the viewpoint keeps its distance and its height", near(Math.hypot(cam.x, cam.y, cam.z), CAMERA_DISTANCE) && near(cam.y, CAMERA_DISTANCE * Math.sin((CAMERA_ELEVATION * Math.PI) / 180)));
  check("the viewpoint is over the present moment's longitude", [0, 1, 2.5, 4, 6].every((a) => near(angleOf(cameraPlace(a).x, cameraPlace(a).z), a, 1e-9)));
  check("angleOf is 0..2π", near(angleOf(0, 1), 0) && near(angleOf(1, 0), Math.PI / 2) && near(angleOf(-1, 0), Math.PI * 1.5));
}

// -- stems are bands of latitude --------------------------------------------------------

const bands = bandLatitudes(6);
check("one band per stem", bands.length === 6);
check("the first stem is northernmost", near(bands[0].north, LAT_SPAN) && bands.every((b, i) => i === 0 || b.north < bands[i - 1].south));
check("the last reaches the southern limit", near(bands[5].south, -LAT_SPAN));
check("bare ground lies between bands", bands.every((b, i) => i === 0 || near(bands[i - 1].south - b.north, BAND_GAP)));
check("bands are the same height", bands.every((b) => near(b.north - b.south, bands[0].north - bands[0].south)));
check("one stem has the whole span", near(bandLatitudes(1)[0].north, LAT_SPAN) && near(bandLatitudes(1)[0].south, -LAT_SPAN));
check("no stems, no bands", bandLatitudes(0).length === 0);

// -- loudness is height -------------------------------------------------------------------

check("louder terrain stands higher", lift(0.9) > lift(0.3) && lift(0.3) > lift(0));
check("silence is flat ground and full loudness is LIFT", lift(0) === 0 && near(lift(1), LIFT) && near(lift(5), LIFT));
check("a stem's own loudest moment stands at full height", near(lift(0.3, 0.3), LIFT) && near(lift(0.9, 0.9), LIFT) && loudestOf(new Float32Array([0.1, 0.3, 0.2])) > 0.29);
check("a quiet passage sinks well below half of a loud one", lift(0.3, 1) < lift(1, 1) * 0.2 && lift(0.5, 1) < lift(1, 1) * 0.4);
check("a silent stem is flat ground", lift(0, 0) === 0 && loudestOf(null) === 0);
check("a band's cross-section is a ridge", profile(0) === 0 && near(profile(0.5), 1) && near(profile(1), 0, 1e-9) && profile(0.25) > 0);
const peaks = new Float32Array(100).fill(0.1);
peaks[50] = 0.9;
check("a step around the planet takes the loudest point inside it", near(stepLevel(peaks, 5, 10), 0.9) && near(stepLevel(peaks, 4, 10), 0.1));
check("more steps than points still reads a point", near(stepLevel(new Float32Array([0.2, 0.8]), 300, 400), 0.8));
check("no peaks is silence", stepLevel(null, 1, 10) === 0 && levelAt(null, 10, 1) === 0);
check("levelAt is linear between points", near(levelAt(new Float32Array([0, 1]), 10, 2.5), 0.25));

// -- sections are regions -----------------------------------------------------------------

const sections = [
  { start: 0, end: 50, color: "#ff8800", name: "Intro", kind: "intro" },
  { start: 50, end: 150, color: "#00aaff", name: "Verse", kind: "verse" },
  { start: 160, end: 200, color: "#44dd66", name: "Outro", kind: "outro" },
];
check("a moment is in its section", sectionAt(10, sections) === 0 && sectionAt(50, sections) === 1 && sectionAt(199, sections) === 2);
check("between sections is no section", sectionAt(155, sections) === -1);
check("a section ends where the next begins", sectionAt(49.99, sections) === 0 && sectionAt(150, sections) === -1);
check("no sections, no section", sectionAt(10, []) === -1);
const regions = sectionRegions(sections, 200);
check("each section is a stretch of longitude", regions.length === 3 && near(regions[0].from, 0) && near(regions[0].to, Math.PI / 2) && near(regions[1].to, Math.PI * 1.5));
check("regions follow each other round the planet", regions.every((r) => r.to > r.from) && near(regions[1].from, regions[0].to));
check("a quarter of the song is a quarter of the planet", near(regions[0].to - regions[0].from, TAU / 4));
check("each region keeps its section's colour", regions.map((r) => r.color).join() === "#ff8800,#00aaff,#44dd66" && regions.map((r) => r.index).join() === "0,1,2");
check("the last region ends where the song does", near(regions[2].to, TAU));

// -- notes are crystals on the bands ---------------------------------------------------------

const span = pitchSpan([note(0, 1, 40), note(1, 2, 64)]);
check("a part's pitch span is its lowest and highest note", span.min === 40 && span.max === 64);
check("a part on one pitch still gets room", (() => { const s = pitchSpan([note(0, 1, 60)]); return s.max - s.min >= 6; })());
check("no notes, no span", pitchSpan(null) === null && pitchSpan([]) === null);
{
  const band = { north: 20, south: 0 };
  const low = notePlace(note(50, 51, 40, 0.2), band, span, 200);
  const high = notePlace(note(100, 101, 64, 1), band, span, 200);
  check("a note stands at its moment's longitude", near(low.angle, Math.PI / 2) && near(high.angle, Math.PI));
  check("a higher note stands further north on the band", high.latitude > low.latitude);
  check("notes stay inside the band", low.latitude > band.south && high.latitude < band.north);
  check("a harder note is a taller crystal", high.height > low.height && low.height > 0);
}
check("few notes are all drawn", thin(100, 1000) === 1 && thin(1000, 1000) === 1);
check("too many are thinned evenly", thin(30000, 4000) === 8 && Math.ceil(30000 / thin(30000, 4000)) <= 4000);
check("detail tables grow with quality", SEGMENTS[0] < SEGMENTS[1] && SEGMENTS[1] < SEGMENTS[2] && NOTE_CAP[0] < NOTE_CAP[2]);

// -- the scene itself, both tiers ------------------------------------------------------------

const ramp = (n, f) => Float32Array.from({ length: n }, (_, i) => f(i / (n - 1)));
const stem = (name, color, notes) => ({ name, color, peaks: ramp(300, (x) => 0.2 + 0.6 * x), notes });
const song = (over = {}) => ({
  duration: 200, bpm: 120, beats: [], bars: [], sections, hasNotes: true,
  stems: [stem("vocals", "#e85f6f", [note(50, 51, 60), note(100, 101, 67, 1)]), stem("drums", "#e89048", null), stem("bass", "#e8b848", null)],
  ...over,
});
const lights = (over = {}) => ({ vocals: { level: 0.4, lit: true, gain: 1 }, drums: { level: 0.4, lit: true, gain: 1 }, bass: { level: 0.4, lit: true, gain: 1 }, ...over });
const frame = (time, over = {}) => ({ time, playing: true, rate: 1, jumped: false, beat: null, bar: null, stems: lights(), ...over });
const size = { width: 1200, height: 600, pixelRatio: 1 };
const by = (inst) => Object.fromEntries(inst.debug().stems.map((s) => [s.name, s]));

check("the visualization names itself", scene.id === "song-planet" && scene.needs.notes === false && scene.strings === strings);
{
  const inst = scene.create({ THREE, renderer: null, song: song(), size, reducedMotion: false, text: (k) => k });
  check("create returns the contract", inst.scene.isScene && inst.camera.isCamera && ["update", "resize", "setQuality", "dispose"].every((k) => typeof inst[k] === "function"));
  inst.update(frame(0));
  check("at the start the viewpoint is over longitude 0", near(inst.debug().viewAngle, 0, 1e-6) && inst.camera.position.z > 0);
  inst.update(frame(100));
  let d = inst.debug();
  check("halfway through the song the viewpoint is halfway round", near(d.viewAngle, Math.PI, 1e-6) && near(d.angle, Math.PI), String(d.viewAngle));
  check("it is on the far side, looking back at the centre", inst.camera.position.z < 0 && inst.camera.getWorldDirection(new THREE.Vector3()).z > 0);
  inst.update(frame(50));
  check("a quarter through, a quarter round", near(inst.debug().viewAngle, Math.PI / 2, 1e-6));
  check("the viewpoint keeps its distance", near(inst.debug().cameraDistance, CAMERA_DISTANCE, 1e-6));
  check("sections are drawn when the song has them", d.sections === 3);
  check("a stem with notes has its crystals; one without has none", by(inst).vocals.crystals === 2 && by(inst).drums.crystals === 0);
  const full = by(inst).bass.tint;
  inst.update(frame(50, { stems: lights({ bass: { level: 0.4, lit: false, gain: 0 } }) }));
  check("a muted stem's band goes almost black", by(inst).bass.tint !== full && new THREE.Color(by(inst).bass.tint).r < 0.2);
  check("the others keep their colour", by(inst).vocals.tint === full);
  inst.update(frame(51));
  check("unmuted, it is back", by(inst).bass.tint === full);
  inst.update(frame(150, { jumped: true }));
  check("a seek moves the viewpoint with it", near(inst.debug().viewAngle, Math.PI * 1.5, 1e-6));
  inst.resize({ width: 500, height: 800, pixelRatio: 1 });
  check("on a narrow view the viewpoint stands further back, over the same longitude", inst.debug().cameraDistance > CAMERA_DISTANCE && near(inst.debug().viewAngle, Math.PI * 1.5, 1e-6));
  inst.setQuality(0);
  inst.update(frame(150));
  check("lower detail rebuilds and still draws", inst.debug().quality === 0 && by(inst).vocals.crystals === 2);
  let threw = null;
  try { inst.dispose(); } catch (e) { threw = e; }
  check("dispose frees without complaint", threw === null, String(threw));
}
{
  const plain = song({ sections: [], hasNotes: false });
  for (const s of plain.stems) s.notes = null;
  const inst = scene.create({ THREE, renderer: null, song: plain, size, reducedMotion: false, text: (k) => k });
  inst.update(frame(100));
  check("without notes or sections it still draws every band", inst.debug().stems.length === 3 && inst.debug().sections === 0 && inst.debug().stems.every((s) => s.crystals === 0));
  check("and still goes halfway round at halfway", near(inst.debug().viewAngle, Math.PI, 1e-6));
  inst.dispose();
}
{
  const inst = scene.create({ THREE, renderer: null, song: song(), size, reducedMotion: true, text: (k) => k });
  check("calm: no glow is asked for", inst.bloom === null && inst.debug().calm === true);
  inst.update(frame(0));
  const cam = inst.camera.position.toArray().join();
  inst.update(frame(100));
  check("calm: the viewpoint does not travel", inst.camera.position.toArray().join() === cam);
  check("calm: the planet turns under it instead, halfway at halfway", near(inst.debug().viewAngle, Math.PI, 1e-6));
  inst.dispose();
}
{
  const dense = song();
  dense.stems[0].notes = Array.from({ length: 30000 }, (_, i) => note(i * 0.006, i * 0.006 + 0.05, 40 + (i % 30), 0.5));
  const inst = scene.create({ THREE, renderer: null, song: dense, size, reducedMotion: false, text: (k) => k });
  check("tens of thousands of notes are thinned to the cap", by(inst).vocals.crystals <= NOTE_CAP[2] && by(inst).vocals.crystals > NOTE_CAP[2] / 2);
  inst.dispose();
}
check("the planet's size is the mapping's", RADIUS === 10 && LIFT > 0 && LIFT < RADIUS / 3);

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
