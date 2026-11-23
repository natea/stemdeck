// Note terrain's mapping from song to landscape, as plain numbers: no Three.js
// and no DOM, so it runs under node (scene.test.mjs).
//
// World: x is across (pitch), y is up (how hard a note was played), and time
// runs along -z, so a moment `t` seconds into the song sits at z = -t * SPEED.
// The landscape is built once in those absolute coordinates and slid toward
// the viewer as the song plays.
//
// Everything drawn for music is a block: { start, end, x, y, z, w, h, d },
// where start and end are the moments the present line enters and leaves it.

export const SPEED = 8; // world units per second of song
export const VOXEL = 0.4; // heights come in steps of this
export const CELL = 1; // a block is this deep: an eighth of a second
export const FIELD_WIDTH = 52; // the pitch field, across
export const LANE_WIDTH = 5; // one loudness ridge
export const LANE_GAP = 1;
export const CHUNK_SECONDS = 16; // the landscape is built and culled in slabs
// Seconds of song visible ahead of the present, per quality level 0..2.
export const VIEW_AHEAD = [7, 10, 14];
export const VIEW_BEHIND = 2;
const RIDGE_HEIGHT = 6;
const NOTE_HEIGHT = 2.4;
const MAX_CELLS = 48;

const steps = (h) => Math.max(1, Math.round(h / VOXEL));

/** The loudness of a stem at a time, 0..1. */
export function levelAt(peaks, duration, time) {
  const n = peaks?.length || 0;
  if (!n || !(duration > 0)) return 0;
  const x = Math.min(1, Math.max(0, time / duration)) * (n - 1);
  const i = Math.floor(x);
  const j = Math.min(n - 1, i + 1);
  return peaks[i] + (peaks[j] - peaks[i]) * (x - i);
}

/**
 * The pitch span the field shows: the 2nd to the 98th percentile of every note
 * drawn, padded by one, so a few stray notes do not squeeze everything else
 * into thin sticks. Notes outside it are drawn at its edge.
 */
export function pitchRange(stems) {
  const pitches = [];
  for (const s of stems) for (const n of s.notes || []) pitches.push(n.pitch);
  if (!pitches.length) return { min: 36, max: 84 };
  pitches.sort((a, b) => a - b);
  let min = pitches[Math.floor((pitches.length - 1) * 0.02)];
  let max = pitches[Math.ceil((pitches.length - 1) * 0.98)];
  // Never narrower than two octaves: three notes should not fill the field.
  while (max - min < 24) {
    if (min > 0) min--;
    if (max - min < 24 && max < 127) max++;
  }
  return { min: min - 1, max: max + 1 };
}

/** Where a pitch sits across the field, and how wide one semitone is. */
export function pitchX(pitch, range) {
  const step = FIELD_WIDTH / (range.max - range.min + 1);
  const p = Math.min(range.max, Math.max(range.min, pitch));
  return { x: (p - (range.min + range.max) / 2) * step, width: step };
}

/**
 * Which stems are drawn from notes and which as loudness ridges, and where
 * each ridge runs. With notes, the pitch field is the valley and the ridges
 * flank it, alternating left and right. With none, the ridges share the width.
 */
export function layout(stems) {
  const noted = stems.filter((s) => s.notes && s.notes.length > 0).map((s) => s.name);
  const ridged = stems.filter((s) => !(s.notes && s.notes.length > 0)).map((s) => s.name);
  const lanes = {};
  if (!noted.length) {
    const total = ridged.length * LANE_WIDTH + Math.max(0, ridged.length - 1) * LANE_GAP;
    ridged.forEach((name, i) => {
      lanes[name] = { x: -total / 2 + LANE_WIDTH / 2 + i * (LANE_WIDTH + LANE_GAP), width: LANE_WIDTH };
    });
    return { noted, ridged, lanes };
  }
  const edge = FIELD_WIDTH / 2 + LANE_GAP;
  ridged.forEach((name, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const rank = Math.floor(i / 2);
    lanes[name] = { x: side * (edge + LANE_WIDTH / 2 + rank * (LANE_WIDTH + LANE_GAP)), width: LANE_WIDTH };
  });
  return { noted, ridged, lanes };
}

/**
 * A note as a run of blocks: pitch across, as tall as it was played hard, one
 * block per CELL of its length, each a step lower than the one before, the way
 * a struck note dies away. A short note is a single block.
 */
export function noteBlocks(note, range) {
  const { x, width } = pitchX(note.pitch, range);
  const top = steps(VOXEL + note.velocity * NOTE_HEIGHT);
  const length = Math.max(0.05, note.end - note.start);
  const cells = Math.max(1, Math.min(MAX_CELLS, Math.round((length * SPEED) / CELL)));
  const cellSeconds = CELL / SPEED;
  const out = [];
  for (let k = 0; k < cells; k++) {
    const h = Math.max(1, top - k) * VOXEL;
    const start = note.start + k * cellSeconds;
    out.push({ start, end: start + cellSeconds, x, y: h / 2, z: -(start * SPEED + CELL / 2), w: width * 0.9, h, d: CELL * 0.88 });
  }
  return out;
}

/**
 * A stem's ridge: one crest block and a lower shoulder either side per step,
 * all on the same footprint grid, so it reads as a range of hills. A step is
 * CELL deep: the loudness points inside it are taken together, loudest wins.
 * A step too quiet to stand a block and a half tall is bare ground.
 */
export function ridgeBlocks(peaks, duration, lane) {
  const n = peaks?.length || 0;
  if (!n || !(duration > 0)) return [];
  const group = Math.max(1, Math.round(CELL / ((duration / n) * SPEED)));
  const seconds = (duration / n) * group;
  const d = seconds * SPEED;
  const third = lane.width / 3;
  const out = [];
  for (let i = 0; i < n; i += group) {
    let level = 0;
    for (let k = i; k < Math.min(n, i + group); k++) if (peaks[k] > level) level = peaks[k];
    // Loudness is heard as roughly the square root of amplitude.
    const tall = Math.sqrt(level) * RIDGE_HEIGHT;
    if (tall < VOXEL * 1.5) continue;
    const h = steps(tall) * VOXEL;
    const side = Math.max(1, Math.round(steps(tall) * 0.55)) * VOXEL;
    const start = (i / n) * duration;
    const z = -(start * SPEED + d / 2);
    // Shoulder to shoulder with no gaps: a ridge is one solid range.
    const base = { start, end: start + seconds, z, w: third, d };
    out.push({ ...base, x: lane.x, y: h / 2, h });
    out.push({ ...base, x: lane.x - third, y: side / 2, h: side });
    out.push({ ...base, x: lane.x + third, y: side / 2, h: side });
  }
  return out;
}

/** Every block a stem contributes, in the order the present line reaches them. */
export function stemBlocks(stem, song, plan, range) {
  let out = [];
  if (plan.noted.includes(stem.name)) for (const n of stem.notes) out = out.concat(noteBlocks(n, range));
  else if (plan.lanes[stem.name]) out = ridgeBlocks(stem.peaks, song.duration, plan.lanes[stem.name]);
  return out.sort((a, b) => a.start - b.start);
}

/** How far across the blocks reach: { min, max } in x, or null with none. */
export function extent(lists) {
  let min = Infinity;
  let max = -Infinity;
  for (const blocks of lists) {
    for (const b of blocks) {
      if (b.x - b.w / 2 < min) min = b.x - b.w / 2;
      if (b.x + b.w / 2 > max) max = b.x + b.w / 2;
    }
  }
  return min > max ? null : { min, max };
}

/**
 * Where the camera stands to see `halfWidth` either side of the middle at the
 * present line, with the line at about 89% of the way down the picture and the
 * top of the picture near the horizon. Returns { height, back, lookAhead, sees }:
 * the camera is `height` up and `back` behind the line, looking at the ground
 * `lookAhead` in front of it, and the ground is in the picture for `sees`
 * units ahead of the line.
 */
export const FOV = 32;
export function cameraFor(halfWidth, aspect) {
  const half = (FOV / 2) * (Math.PI / 180);
  // The line is seen 42 degrees below the horizon and the view's centre 30.
  const toLine = 42 * (Math.PI / 180);
  const toCentre = 30 * (Math.PI / 180);
  // At the line, the picture is this wide per unit of distance behind it.
  const perBack = (Math.tan(half) * Math.max(0.3, aspect)) / Math.cos(toLine);
  // 0.78: a margin either side, and the line is nearer than the view's centre.
  const back = Math.max(8, halfWidth / (0.78 * perBack));
  const height = back * Math.tan(toLine);
  // How far ahead of the line the ground runs before it leaves the top of the picture.
  const sees = height / Math.tan(toCentre - half) - back;
  return { height, back, lookAhead: height / Math.tan(toCentre) - back, sees };
}

export const chunkOf = (time) => Math.max(0, Math.floor(time / CHUNK_SECONDS));

/** Whether a slab of the landscape can be seen from `time` at this view distance. */
export function chunkVisible(chunk, time, ahead) {
  const from = chunk * CHUNK_SECONDS;
  const to = from + CHUNK_SECONDS + 1;
  return to >= time - VIEW_BEHIND && from <= time + ahead;
}

// How much of its stem's colour a block shows: still to come, or already played.
// On the present line it is lit (litValue), and it stays lit for one more
// block's length and then fades, so the block nearest the viewer is never a
// dark wall in front of the lit ones.
export const FUTURE = 0.5;
export const PAST = 0.06;
export const HOLD_SECONDS = CELL / SPEED;
export const FADE_SECONDS = CELL / SPEED;

/**
 * How lit a block is at `time`: -1 while it is still to come, 1 on the line
 * and just after, then down to 0 as it fades into the past.
 */
export function litAmount(block, time) {
  if (time < block.start) return -1;
  const t = (time - block.end - HOLD_SECONDS) / FADE_SECONDS;
  // Squared: it drops away from lit quickly, so a fading block is never
  // mistaken for one still to come.
  return t <= 0 ? 1 : t >= 1 ? 0 : (1 - t) * (1 - t);
}

/** The colour scale for a lit amount: FUTURE, or between PAST and `lit`. */
export function shadeFor(amount, lit, past = PAST, future = FUTURE) {
  return amount < 0 ? future : past + (lit - past) * amount;
}

/**
 * How far a lit block's colour is pushed, so that every stem ends up equally
 * bright whatever its hue: a dark red needs more of a push than a light green.
 * `luminance` is the stem colour's (linear, 0..1).
 */
export function litValue(luminance, calm = false) {
  const target = calm ? 0.62 : 1.25;
  return Math.min(calm ? 1.6 : 6, Math.max(1.05, target / Math.max(0.05, luminance)));
}

/** The first index whose start is after `time`, in a list sorted by start. */
export function upperBound(blocks, time) {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].start <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where the landscape and the present-moment line sit. Normally the landscape
 * slides and the line stays put. In the calm version nothing travels: the
 * landscape holds one page of the song at a time and the line walks along it.
 */
export function placement(time, { calm = false, page = 12 } = {}) {
  if (!calm) return { landscapeZ: time * SPEED, lineZ: 0 };
  const start = Math.floor(Math.max(0, time) / page) * page;
  return { landscapeZ: start * SPEED, lineZ: -(time - start) * SPEED };
}
