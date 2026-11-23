// Lit stage's mapping from notes to the things that light up, as plain numbers:
// no Three.js and no DOM, so it runs under node (scene.test.mjs).
//
// Which stem plays which instrument:
//   piano  -> the keyboard      guitar -> the guitar fretboard
//   bass   -> the bass fretboard   drums -> the kit
//   vocals -> a light whose height is the sung pitch
//   other  -> a row of twelve lamps, one per note name (C, C sharp, ... B)

export const INSTRUMENT = { piano: "keyboard", guitar: "guitar", bass: "bass", drums: "kit", vocals: "voice", other: "lamps" };

// ── The keyboard: a piano's 88 keys, A0 to C8 ──

export const KEY_LOW = 21;
export const KEY_HIGH = 108;
const BLACK = new Set([1, 3, 6, 8, 10]);

export const isBlack = (pitch) => BLACK.has(((pitch % 12) + 12) % 12);

/**
 * The key a pitch is played on. A pitch off either end of the keyboard is
 * folded by octaves onto it, so no note is lost.
 */
export function keyFor(pitch) {
  let p = Math.round(pitch);
  while (p < KEY_LOW) p += 12;
  while (p > KEY_HIGH) p -= 12;
  return p;
}

/** How many white keys lie below a key (its white key's index, or the one to its left for a black key). */
export function whitesBelow(key) {
  let n = 0;
  for (let p = KEY_LOW; p < key; p++) if (!isBlack(p)) n++;
  return n;
}

export const WHITE_KEYS = whitesBelow(KEY_HIGH) + 1; // 52

/**
 * Where a key is across the keyboard, in white-key widths from its left end:
 * a white key's own middle, or for a black key the crack between its neighbours.
 */
export function keyPlace(key) {
  const k = keyFor(key);
  return isBlack(k) ? { x: whitesBelow(k), black: true } : { x: whitesBelow(k) + 0.5, black: false };
}

// ── Fretboards ──

export const GUITAR_TUNING = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4, lowest string first
export const BASS_TUNING = [28, 33, 38, 43]; // E1 A1 D2 G2
export const MAX_FRET = 20;

/**
 * Where a pitch is played: { string, fret }, string 0 being the lowest. The
 * simple "lowest fret" fingering: the highest string that can play it, which
 * is where its fret number is smallest. A pitch below the lowest string or
 * beyond the last fret is folded by octaves into the neck's range.
 */
export function fretFor(pitch, tuning) {
  let p = Math.round(pitch);
  const lowest = tuning[0];
  const highest = tuning[tuning.length - 1] + MAX_FRET;
  while (p < lowest) p += 12;
  while (p > highest) p -= 12;
  let string = 0;
  for (let s = 0; s < tuning.length; s++) if (tuning[s] <= p) string = s;
  return { string, fret: p - tuning[string] };
}

/**
 * How far along a neck a fret wire is, 0 at the nut and 1 at the last fret,
 * by the rule real necks follow: each fret is the twelfth root of two closer.
 */
export function fretWire(fret) {
  const at = (f) => 1 - Math.pow(2, -f / 12);
  return at(Math.max(0, Math.min(MAX_FRET, fret))) / at(MAX_FRET);
}

/** Where a finger goes for a fret: just behind its wire. An open string is at the nut. */
export function fretSpot(fret) {
  if (fret <= 0) return -0.025;
  return (fretWire(fret - 1) + fretWire(fret)) / 2;
}

// ── The kit, by General MIDI drum key ──

export const PIECES = ["kick", "snare", "hihat", "tomHigh", "tomMid", "tomFloor", "crash", "ride"];
const GM = {
  35: "kick", 36: "kick",
  37: "snare", 38: "snare", 39: "snare", 40: "snare",
  42: "hihat", 44: "hihat", 46: "hihat", 54: "hihat", 69: "hihat", 70: "hihat",
  48: "tomHigh", 50: "tomHigh",
  45: "tomMid", 47: "tomMid",
  41: "tomFloor", 43: "tomFloor",
  49: "crash", 52: "crash", 55: "crash", 57: "crash",
  51: "ride", 53: "ride", 56: "ride", 59: "ride",
};

/** The piece of the kit a drum key hits, or null for a sound the kit has no piece for. */
export function drumPiece(key) {
  return GM[Math.round(key)] || null;
}

// ── The voice and the lamps ──

/** The span a voice's light moves over: its lowest to its highest note. */
export function voiceRange(notes) {
  let min = Infinity;
  let max = -Infinity;
  for (const n of notes || []) {
    if (n.pitch < min) min = n.pitch;
    if (n.pitch > max) max = n.pitch;
  }
  if (min > max) return { min: 48, max: 72 };
  if (max - min < 5) {
    min -= 3;
    max += 3;
  }
  return { min, max };
}

/** How high the voice's light is for a pitch, 0 (lowest) to 1 (highest). */
export function voiceHeight(pitch, range) {
  return Math.min(1, Math.max(0, (pitch - range.min) / (range.max - range.min)));
}

/** Which of the twelve lamps a pitch lights: its note name, C first. */
export const lampFor = (pitch) => ((Math.round(pitch) % 12) + 12) % 12;

// ── Light ──

export const FADE_SECONDS = 0.35;
export const CALM_FADE_SECONDS = 0.7;

/** How lit a note's thing is at `time`: 1 while it sounds, fading to 0 afterwards. */
export function glowAt(note, time, fade = FADE_SECONDS) {
  if (time < note.start) return 0;
  if (time <= note.end) return 1;
  return Math.max(0, 1 - (time - note.end) / fade);
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
 * What is lit at `time` for one stem: a Map from a thing's key to its glow.
 * `keyOf(note)` says which thing a note lights (null: none). `longest` is the
 * stem's longest note, so held notes are not missed.
 */
export function litThings(notes, time, keyOf, { longest = 0, fade = FADE_SECONDS } = {}) {
  const out = new Map();
  if (!notes || !notes.length) return out;
  const from = upperBound(notes, time - Math.min(longest, 30) - fade);
  const to = upperBound(notes, time);
  for (let i = from; i < to; i++) {
    const g = glowAt(notes[i], time, fade);
    if (g <= 0) continue;
    const key = keyOf(notes[i]);
    if (key == null) continue;
    if (g > (out.get(key) || 0)) out.set(key, g);
  }
  return out;
}

/** The sung note at `time`: the latest one still glowing, as { pitch, glow }, or null. */
export function sungAt(notes, time, { longest = 0, fade = FADE_SECONDS } = {}) {
  if (!notes || !notes.length) return null;
  const from = upperBound(notes, time - Math.min(longest, 30) - fade);
  for (let i = upperBound(notes, time) - 1; i >= from; i--) {
    const g = glowAt(notes[i], time, fade);
    if (g > 0) return { pitch: notes[i].pitch, glow: g };
  }
  return null;
}
