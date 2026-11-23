// Note galaxy: its mapping, its particle bursts, and its strings.
//
// Run:  node static/js/viz/scenes/note-galaxy/scene.test.mjs
// (tests/js/viz-scenes.test.mjs runs every visualization's scene.test.mjs.)

import * as THREE from "../../../../vendor/three/three.module.js";
import scene from "./index.js";
import { strings } from "./strings.js";
import {
  R_MIN, R_MAX, TWIST, BURST_SECONDS, SPREAD, BIRTH_ALPHA, BURST_MIN, BURST_MAX, MAX_POINTS, ARM_STARS,
  pitchRange, pitchRadius, velocitySize, burstCount, armAngle, armPoint, notePoint, hash, particle,
  upperBound, window as noteWindow, holdGlow, armStars,
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

// -- pitch is distance from the centre ---------------------------------------------

const range = { min: 36, max: 84 };
check("the lowest pitch sits nearest the core", near(pitchRadius(36, range), R_MIN));
check("the highest at the rim", near(pitchRadius(84, range), R_MAX));
check("a higher pitch is further out", [40, 52, 60, 72].every((p, i, a) => i === 0 || pitchRadius(p, range) > pitchRadius(a[i - 1], range)));
check("the middle pitch is midway", near(pitchRadius(60, range), (R_MIN + R_MAX) / 2));
check("a pitch outside the range stays on the disc", pitchRadius(0, range) === R_MIN && pitchRadius(127, range) === R_MAX);
check("the range covers the notes", (() => { const r = pitchRange([{ notes: [note(0, 1, 40), note(1, 2, 70)] }, { notes: null }]); return r.min <= 40 && r.max >= 70; })());
check("with no notes there is a default range", JSON.stringify(pitchRange([{ notes: null }])) === JSON.stringify({ min: 36, max: 84 }));
check("a part on one pitch still gets an octave", (() => { const r = pitchRange([{ notes: [note(0, 1, 60)] }]); return r.max - r.min >= 12; })());
{
  const many = Array.from({ length: 1000 }, (_, i) => note(i, i + 0.1, 48 + (i % 24)));
  check("a stray note does not crowd the rest into one ring", pitchRange([{ notes: [...many, note(0, 1, 120)] }]).max === pitchRange([{ notes: many }]).max);
}

// -- how hard is how big ------------------------------------------------------------

check("a harder note is a bigger light", velocitySize(1) > velocitySize(0.5) && velocitySize(0.5) > velocitySize(0));
check("the softest note is still seen", velocitySize(0) > 0.2);
check("size is bounded", velocitySize(9) === velocitySize(1) && velocitySize(-3) === velocitySize(0));
check("a harder note throws more particles", burstCount(1) > burstCount(0.5) && burstCount(0.5) > burstCount(0));
check("burst sizes are the table's ends", burstCount(0, 2) === BURST_MIN[2] && burstCount(1, 2) === BURST_MAX[2]);
check("lower detail throws fewer", burstCount(1, 0) < burstCount(1, 1) && burstCount(1, 1) < burstCount(1, 2));
check("a burst is always whole particles", Number.isInteger(burstCount(0.37, 1)));

// -- one arm per stem ---------------------------------------------------------------

check("arms leave the core evenly around the circle", near(armAngle(0, 4), 0) && near(armAngle(1, 4), Math.PI / 2) && near(armAngle(3, 6), Math.PI));
check("one stem is one arm", near(armAngle(0, 1), 0));
{
  const inner = armPoint(2, 6, R_MIN);
  const outer = armPoint(2, 6, R_MAX);
  check("a point on an arm is at its radius", near(Math.hypot(inner.x, inner.z), R_MIN) && near(Math.hypot(outer.x, outer.z), R_MAX));
  check("an arm winds as it goes out", near(outer.angle - inner.angle, TWIST));
  check("every arm winds the same way", near(armPoint(0, 6, 20).angle - armPoint(0, 6, 10).angle, armPoint(4, 6, 20).angle - armPoint(4, 6, 10).angle));
  const a = armPoint(1, 6, 17);
  const b = armPoint(2, 6, 17);
  check("two stems' arms are apart at the same radius", Math.hypot(a.x - b.x, a.z - b.z) > 5);
}
{
  // A chord: three notes at once on one stem.
  const chord = [note(2, 3, 52), note(2, 3, 56), note(2, 3, 59)].map((n) => notePoint(n, 3, 6, range));
  const radii = chord.map((p) => Math.hypot(p.x, p.z));
  check("a chord's notes sit at their pitches' distances", radii.every((r, i) => near(r, pitchRadius([52, 56, 59][i], range))));
  check("and all on the stem's own arm", chord.every((p, i) => near(p.angle, armPoint(3, 6, radii[i]).angle)));
  check("the same note on another stem is on another arm", (() => { const o = notePoint(note(2, 3, 52), 0, 6, range); return Math.hypot(o.x - chord[0].x, o.z - chord[0].z) > 3; })());
}

// -- a burst is a function of time ----------------------------------------------------

check("hash is repeatable and spread", hash(3, 7) === hash(3, 7) && hash(3, 7) !== hash(3, 8) && hash(3, 7) >= 0 && hash(3, 7) < 1);
{
  const born = particle(42, 0, 0);
  const mid = particle(42, 0, BURST_SECONDS / 2);
  const dead = particle(42, 0, BURST_SECONDS);
  const dist = (p) => Math.hypot(p.dx, p.dy, p.dz);
  const young = particle(42, 0, BURST_SECONDS * 0.07);
  check("a particle starts at its note, from nothing", near(dist(born), 0) && born.alpha === 0);
  check("it is brightest just after, and never fully bright", young.alpha > mid.alpha && young.alpha < BIRTH_ALPHA && BIRTH_ALPHA < 1);
  check("it travels outward and fades", dist(mid) > 0 && mid.alpha > 0);
  check("it is gone after BURST_SECONDS", near(dead.alpha, 0) && dist(dead) <= SPREAD + 1e-9);
  check("it moves fast at first and slows", dist(mid) > dist(dead) * 0.5);
  check("the same moment gives the same particle", JSON.stringify(particle(42, 0, 0.3)) === JSON.stringify(particle(42, 0, 0.3)));
  check("a seek back gives the earlier particle again", dist(particle(42, 0, 0.2)) < dist(particle(42, 0, 0.9)));
  check("particles of one burst go different ways", (() => { const a = particle(42, 0, 0.5); const b = particle(42, 1, 0.5); return Math.hypot(a.dx - b.dx, a.dz - b.dz) > 0.01; })());
  check("mostly within the galaxy's plane", [...Array(40).keys()].every((k) => Math.abs(particle(7, k, BURST_SECONDS).dy) < SPREAD * 0.5));
  const still = particle(42, 0, 0.5, true);
  check("calm: a particle does not travel", still.dx === 0 && still.dy === 0 && still.dz === 0 && still.alpha > 0);
}
check("a held note is lit while it sounds", holdGlow(note(2, 5, 60), 1.9) === 0 && holdGlow(note(2, 5, 60), 2) === 1 && holdGlow(note(2, 5, 60), 5) === 1);
check("and fades quickly after", holdGlow(note(2, 5, 60), 5.1) < 1 && holdGlow(note(2, 5, 60), 5.1) > 0 && holdGlow(note(2, 5, 60), 6) === 0);

const sorted = [note(1, 2, 60), note(2, 9, 62), note(2, 2.1, 64), note(8, 8.5, 65)];
check("upperBound finds the first note after a time", upperBound(sorted, 0) === 0 && upperBound(sorted, 2) === 3 && upperBound(sorted, 99) === 4);
check("the window holds the notes just started", JSON.stringify(noteWindow(sorted, 2.5, 0)) === "[1,3]", JSON.stringify(noteWindow(sorted, 2.5, 0)));
check("and reaches back for a long held note", noteWindow(sorted, 8.2, 7)[0] === 1 && noteWindow(sorted, 8.2, 7)[1] === 4);
check("nothing has started before the first note", JSON.stringify(noteWindow(sorted, 0.5, 7)) === "[0,0]");

const stars = armStars(2, 6, 200);
check("an arm has its stars", stars.length === 200 && stars.every((s) => Number.isFinite(s.x) && Number.isFinite(s.z) && s.size > 0));
check("the same arm is the same stars every time", JSON.stringify(armStars(2, 6, 50)) === JSON.stringify(armStars(2, 6, 50)));
check("stars lie along the arm, from the core's edge to the rim", (() => { const r = stars.map((s) => Math.hypot(s.x, s.z)); return Math.min(...r) < R_MIN * 0.7 && Math.max(...r) > R_MAX * 0.8 && Math.max(...r) < R_MAX * 1.4; })());
check("stars stay near their own arm", stars.every((s) => { const r = Math.hypot(s.x, s.z); const p = armPoint(2, 6, r); return Math.hypot(s.x - p.x, s.z - p.z) < 6; }));

// -- the scene itself ------------------------------------------------------------------

const stem = (name, color, notes) => ({ name, color, peaks: new Float32Array(100).fill(0.4), notes });
const song = () => ({
  duration: 60, bpm: 120, beats: [], bars: [], sections: [], hasNotes: true,
  stems: [
    stem("vocals", "#e85f6f", [note(1, 2, 64, 1), note(10, 11, 70, 0.3)]),
    stem("drums", "#e89048", null),
    stem("guitar", "#88d878", [note(5, 6, 52, 0.9), note(5, 6, 56, 0.9), note(5, 6, 59, 0.9)]),
  ],
});
const lights = (over = {}) => ({ vocals: { level: 0.4, lit: true, gain: 1 }, drums: { level: 0.4, lit: true, gain: 1 }, guitar: { level: 0.4, lit: true, gain: 1 }, ...over });
const frame = (time, over = {}) => ({ time, playing: true, rate: 1, jumped: false, beat: null, bar: null, stems: lights(), ...over });
const size = { width: 1200, height: 600, pixelRatio: 1 };
const by = (inst) => Object.fromEntries(inst.debug().stems.map((s) => [s.name, s]));

check("the visualization names itself and needs notes", scene.id === "note-galaxy" && scene.needs.notes === true && scene.strings === strings);
{
  const inst = scene.create({ THREE, renderer: null, song: song(), size, reducedMotion: false, text: (k) => k });
  check("create returns the contract", inst.scene.isScene && inst.camera.isCamera && ["update", "resize", "setQuality", "dispose"].every((k) => typeof inst[k] === "function"));
  check("it asks the host for a glow", inst.bloom && inst.bloom.strength > 0);
  inst.update(frame(0.5));
  check("before any note there is no burst", inst.debug().points === 0 && by(inst).vocals.bursts === 0);
  check("every stem has an arm, with notes or without", inst.debug().stems.length === 3 && inst.debug().stems.every((s) => s.stars === ARM_STARS[2]));
  inst.update(frame(1.1));
  check("a note bursts as it sounds", by(inst).vocals.bursts === 1 && inst.debug().points === 1 + burstCount(1, 2), String(inst.debug().points));
  inst.update(frame(5.2));
  check("a chord is several bursts together on its stem's arm", by(inst).guitar.bursts === 3 && by(inst).vocals.bursts === 0);
  const chordPoints = inst.debug().points;
  check("each with its particles and its own light", chordPoints === 3 * (1 + burstCount(0.9, 2)));
  inst.update(frame(5.2, { stems: lights({ guitar: { level: 0.4, lit: false, gain: 0 } }) }));
  check("a muted stem's notes make no light", inst.debug().points === 0 && by(inst).guitar.on === false);
  check("and its arm fades almost to nothing", by(inst).guitar.arm < by(inst).vocals.arm / 3);
  inst.update(frame(5.3));
  check("unmuted, it bursts again", by(inst).guitar.bursts === 3 && inst.debug().points > 0);
  inst.update(frame(1.1, { jumped: true }));
  check("a seek back shows that moment again", by(inst).vocals.bursts === 1 && by(inst).guitar.bursts === 0);
  inst.update(frame(30));
  check("long after the last note the sky is quiet", inst.debug().points === 0);
  const loud = by(inst).vocals.arm;
  inst.update(frame(30, { stems: lights({ vocals: { level: 0, lit: true, gain: 1 } }) }));
  check("an arm brightens with its stem's loudness", by(inst).vocals.arm < loud);
  const turn = inst.debug().turn;
  inst.update(frame(40));
  check("the galaxy turns with the song's time", inst.debug().turn !== turn);
  inst.update(frame(5.2));
  inst.setQuality(0);
  inst.update(frame(5.2));
  check("lower detail throws fewer particles and draws fewer stars", inst.debug().points === 3 * (1 + burstCount(0.9, 0)) && by(inst).guitar.stars === ARM_STARS[0]);
  check("the pool never overflows", inst.debug().points <= MAX_POINTS[0]);
  inst.resize({ width: 500, height: 800, pixelRatio: 1 });
  check("resize keeps the camera's aspect", near(inst.camera.aspect, 500 / 800));
  let threw = null;
  try { inst.dispose(); } catch (e) { threw = e; }
  check("dispose frees without complaint", threw === null, String(threw));
}
{
  const inst = scene.create({ THREE, renderer: null, song: song(), size, reducedMotion: true, text: (k) => k });
  check("calm: no glow is asked for", inst.bloom === null);
  inst.update(frame(5.2));
  check("calm: a note is one steady dot, nothing bursts", inst.debug().points === 3);
  const turn = inst.debug().turn;
  const cam = inst.camera.position.toArray().join();
  inst.update(frame(40));
  check("calm: the galaxy does not turn and the camera does not move", inst.debug().turn === turn && inst.camera.position.toArray().join() === cam);
  inst.dispose();
}
{
  // Tens of thousands of notes: the pool caps what is drawn.
  const dense = song();
  dense.stems[0].notes = Array.from({ length: 30000 }, (_, i) => note(i * 0.001, i * 0.001 + 0.2, 40 + (i % 40), 1));
  const inst = scene.create({ THREE, renderer: null, song: dense, size, reducedMotion: false, text: (k) => k });
  inst.update(frame(15));
  check("a very dense passage is capped, not an overflow", inst.debug().points === MAX_POINTS[2]);
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
