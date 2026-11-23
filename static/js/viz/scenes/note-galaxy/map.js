// Note galaxy's mapping from song to stars, as plain numbers: no Three.js and
// no DOM, so it runs under node (scene.test.mjs).
//
// The galaxy lies in the x-z plane, seen from above at a tilt. Each stem owns
// one spiral arm. A note sits on its stem's arm at a distance from the centre
// set by its pitch (low notes near the core, high notes at the rim), and when
// it sounds it throws out a burst of particles whose number and size follow how
// hard it was played. Everything is a function of the song's time, never of
// what was drawn before, so a pause holds it and a seek lands on it exactly.

export const R_MIN = 7; // the lowest pitch sits this far from the centre: clear of the core
export const R_MAX = 30; // and the highest this far
export const TWIST = Math.PI * 1.35; // how far an arm winds between core and rim
export const BURST_SECONDS = 1.4; // how long a burst's particles live
export const SPREAD = 3.2; // how far they travel in that time
export const BIRTH_ALPHA = 0.42; // how bright one particle is at its brightest, just after it is born
// Particles in a burst for the softest and the hardest note, per quality level.
export const BURST_MIN = [2, 4, 6];
export const BURST_MAX = [8, 16, 26];
export const MAX_POINTS = [2500, 6000, 12000];
export const ARM_STARS = [120, 260, 420]; // the faint stars that draw an arm

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The pitch span the galaxy shows: the 2nd to the 98th percentile of every
 * note, so a few stray notes do not crowd the rest into one ring.
 */
export function pitchRange(stems) {
  const pitches = [];
  for (const s of stems) for (const n of s.notes || []) pitches.push(n.pitch);
  if (!pitches.length) return { min: 36, max: 84 };
  pitches.sort((a, b) => a - b);
  let min = pitches[Math.floor((pitches.length - 1) * 0.02)];
  let max = pitches[Math.ceil((pitches.length - 1) * 0.98)];
  while (max - min < 12) {
    if (min > 0) min--;
    if (max - min < 12 && max < 127) max++;
  }
  return { min, max };
}

/** How far from the centre a pitch sits: higher is further out. */
export function pitchRadius(pitch, range) {
  const f = clamp((pitch - range.min) / (range.max - range.min), 0, 1);
  return R_MIN + f * (R_MAX - R_MIN);
}

/** How big a note's light is: harder is bigger. velocity is 0..1. */
export function velocitySize(velocity) {
  return 0.45 + clamp(velocity, 0, 1) * 1.35;
}

/** How many particles a note throws out. */
export function burstCount(velocity, quality = 2) {
  const q = clamp(Math.round(quality), 0, 2);
  return Math.round(BURST_MIN[q] + clamp(velocity, 0, 1) * (BURST_MAX[q] - BURST_MIN[q]));
}

/** The direction an arm leaves the core in: the stems share the circle evenly. */
export function armAngle(index, count) {
  return (index / Math.max(1, count)) * Math.PI * 2;
}

/** Where a stem's arm is at a distance from the centre: { x, z, angle }. */
export function armPoint(index, count, radius) {
  const angle = armAngle(index, count) + TWIST * ((radius - R_MIN) / (R_MAX - R_MIN));
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, angle };
}

/** Where a note sits: on its stem's arm, at its pitch's distance. */
export function notePoint(note, index, count, range) {
  return armPoint(index, count, pitchRadius(note.pitch, range));
}

/** A repeatable number in 0..1 from two integers (no Math.random: a frame must be the same twice). */
export function hash(a, b) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * One particle of a burst, `age` seconds after its note began: where it is
 * relative to the note, and how bright (1 at birth, 0 at BURST_SECONDS).
 * Fast at first and slowing, mostly within the galaxy's plane.
 */
export function particle(seed, k, age, calm = false) {
  const life = clamp(age / BURST_SECONDS, 0, 1);
  // Never fully bright: a burst is many particles on one spot at its birth,
  // and their light adds up.
  // It also starts from nothing: at birth it is under its note's own light.
  const alpha = BIRTH_ALPHA * Math.min(1, life / 0.06) * Math.pow(1 - life, 3);
  if (calm) return { dx: 0, dy: 0, dz: 0, alpha };
  const around = hash(seed, k * 3 + 1) * Math.PI * 2;
  const lift = (hash(seed, k * 3 + 2) - 0.5) * 0.9;
  const reach = SPREAD * (0.35 + 0.65 * hash(seed, k * 3 + 3)) * (1 - (1 - life) * (1 - life));
  return {
    dx: Math.cos(around) * reach * Math.cos(lift),
    dy: Math.sin(lift) * reach,
    dz: Math.sin(around) * reach * Math.cos(lift),
    alpha,
  };
}

/** The first index whose start is after `time`, in a list sorted by start. */
export function upperBound(notes, time) {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].start <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The notes that matter at `time`: [from, to) in a list sorted by start. A
 * note matters while it sounds and while its burst lives. `longest` is the
 * longest note in the list.
 */
export function window(notes, time, longest = 0) {
  return [upperBound(notes, time - Math.max(BURST_SECONDS, Math.min(longest, 12))), upperBound(notes, time)];
}

/** How bright a held note's own light is, 0..1: full while it sounds, then gone. */
export function holdGlow(note, time) {
  if (time < note.start) return 0;
  if (time <= note.end) return 1;
  return clamp(1 - (time - note.end) / 0.25, 0, 1);
}

/** The faint stars that draw an arm: [{ x, y, z, size }], the same every time. */
export function armStars(index, count, howMany) {
  const out = [];
  for (let i = 0; i < howMany; i++) {
    const f = Math.pow(hash(index + 11, i), 0.8);
    // From the core's edge, so the arms wind out of it.
    const radius = R_MIN * 0.28 + f * (R_MAX * 1.06 - R_MIN * 0.28);
    const p = armPoint(index, count, radius);
    // Scatter across the arm's width, wider toward the rim.
    const across = (hash(index + 23, i) - 0.5) * (1.2 + radius * 0.12);
    const nx = -Math.sin(p.angle);
    const nz = Math.cos(p.angle);
    out.push({
      x: p.x + nx * across,
      y: (hash(index + 37, i) - 0.5) * 0.9,
      z: p.z + nz * across,
      size: 0.25 + hash(index + 41, i) * 0.35,
    });
  }
  return out;
}
