// Drive the song's mapping from song to road, as plain numbers: no Three.js
// and no DOM, so it runs under node (scene.test.mjs).
//
// The road runs along -z. A beat is always the same length of road, so the
// song's tempo is the pace: a song at 160 beats a minute passes at twice the
// pace of one at 80. A moment `t` is `distanceAt(t)` units along the road.

export const UNITS_PER_BEAT = 8;
export const DEFAULT_BPM = 120; // a song with no tempo at all still moves
export const ROAD_WIDTH = 9;
export const POSTS_PER_BEAT = 2; // roadside posts, per stem
export const VIEW_DISTANCE = [50, 70, 92]; // where the fog closes, per quality level
export const CALM_PAGE_BEATS = 16; // beats of road on one still page
export const BUMP_SECONDS = 0.16; // how long a bump lasts under the viewer
const MAX_POST = 5.5; // how tall a roadside post stands at full loudness

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** How fast the road passes at a tempo, in units a second. */
export function tempoPace(bpm) {
  return ((bpm > 0 ? bpm : DEFAULT_BPM) / 60) * UNITS_PER_BEAT;
}

/** The last index of a rising list that is <= value, or -1. */
function lastAtOrBefore(list, value) {
  let lo = -1;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The road for a song: how far along it each moment is.
 *
 * With a beat grid, each beat is UNITS_PER_BEAT of road, so the road speeds
 * up and slows down with the playing. Before the first beat and after the
 * last it carries on at the pace of the nearest beats. With no grid it runs
 * at the song's tempo, or at DEFAULT_BPM when the song has none.
 */
export function makeTrack(song) {
  const beats = song.beats || [];
  const steady = tempoPace(song.bpm);
  if (beats.length < 2) {
    return {
      beatsKnown: false,
      distanceAt: (time) => Math.max(0, time) * steady,
      timeAt: (distance) => Math.max(0, distance) / steady,
      paceAt: () => steady,
      length: Math.max(0, song.duration) * steady,
    };
  }
  const first = beats[1] - beats[0];
  const last = beats[beats.length - 1] - beats[beats.length - 2];
  // The road starts at time 0, which may be before the first beat.
  const lead = (beats[0] / first) * UNITS_PER_BEAT;
  function distanceAt(time) {
    const t = Math.max(0, time);
    if (t <= beats[0]) return (t / first) * UNITS_PER_BEAT;
    const i = lastAtOrBefore(beats, t);
    if (i >= beats.length - 1) return lead + (beats.length - 1 + (t - beats[beats.length - 1]) / last) * UNITS_PER_BEAT;
    return lead + (i + (t - beats[i]) / (beats[i + 1] - beats[i])) * UNITS_PER_BEAT;
  }
  function timeAt(distance) {
    const d = Math.max(0, distance);
    if (d <= lead) return (d / UNITS_PER_BEAT) * first;
    const b = (d - lead) / UNITS_PER_BEAT;
    const i = Math.floor(b);
    if (i >= beats.length - 1) return beats[beats.length - 1] + (b - (beats.length - 1)) * last;
    return beats[i] + (b - i) * (beats[i + 1] - beats[i]);
  }
  function paceAt(time) {
    if (time <= beats[0]) return UNITS_PER_BEAT / first;
    const i = Math.min(beats.length - 2, lastAtOrBefore(beats, time));
    return UNITS_PER_BEAT / (beats[i + 1] - beats[i]);
  }
  return { beatsKnown: true, distanceAt, timeAt, paceAt, length: distanceAt(Math.max(song.duration, beats[beats.length - 1])) };
}

/** How far along the road each bar line is. */
export function barMarkers(song, track) {
  return (song.bars || []).map((time) => track.distanceAt(time));
}

/** The loudness of a stem at a time, 0..1. */
export function levelAt(peaks, duration, time) {
  const n = peaks?.length || 0;
  if (!n || !(duration > 0)) return 0;
  const x = clamp(time / duration, 0, 1) * (n - 1);
  const i = Math.floor(x);
  const j = Math.min(n - 1, i + 1);
  return peaks[i] + (peaks[j] - peaks[i]) * (x - i);
}

/**
 * Drum hits found in loudness alone, for a song with no drum notes: every
 * point that stands clear of its neighbours and of the stem's own average, no
 * two closer than a tenth of a second. [{ time, strength }], strength 0..1.
 */
export function peakHits(peaks, duration) {
  const n = peaks?.length || 0;
  if (n < 3 || !(duration > 0)) return [];
  let sum = 0;
  let top = 0;
  for (let i = 0; i < n; i++) {
    sum += peaks[i];
    if (peaks[i] > top) top = peaks[i];
  }
  if (!(top > 0.01)) return [];
  const floor = Math.max(0.05 * top, (sum / n) * 1.15);
  const gap = Math.max(1, Math.round((0.1 / duration) * n));
  const hits = [];
  let lastIndex = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const v = peaks[i];
    if (v < floor || v < peaks[i - 1] || v <= peaks[i + 1]) continue;
    if (i - lastIndex < gap) {
      // Too close to the last one: keep the louder.
      if (v > hits[hits.length - 1].strength * top) hits[hits.length - 1] = { time: (i / (n - 1)) * duration, strength: v / top };
      lastIndex = i;
      continue;
    }
    hits.push({ time: (i / (n - 1)) * duration, strength: v / top });
    lastIndex = i;
  }
  return hits;
}

/**
 * The drum hits of a song: from the drum stem's notes when it has them
 * (strength from how hard each was played), otherwise from its loudness.
 * Returns { hits, from: "notes" | "loudness" | "none" }, hits in time order.
 */
export function drumHits(stem, duration) {
  if (!stem) return { hits: [], from: "none" };
  if (stem.notes && stem.notes.length) {
    return { hits: stem.notes.map((n) => ({ time: n.start, strength: clamp(n.velocity, 0.15, 1) })), from: "notes" };
  }
  const hits = peakHits(stem.peaks, duration);
  return { hits, from: hits.length ? "loudness" : "none" };
}

/**
 * How high the road lifts the viewer at `time`: 0 between hits, up to a hit's
 * strength as it passes underneath, at the moment it is heard. `times` is the
 * hits' times, passed in by a caller that asks every frame.
 */
export function bumpAt(hits, time, times = hits.map((h) => h.time)) {
  let i = lastAtOrBefore(times, time + BUMP_SECONDS * 0.25);
  let lift = 0;
  // A few hits back: a flam's two hits overlap.
  for (let k = 0; k < 4 && i >= 0; k++, i--) {
    const dt = time - hits[i].time;
    if (dt > BUMP_SECONDS) break;
    // Up just before the hit, over the top as it sounds, down after.
    const x = dt < 0 ? 1 + dt / (BUMP_SECONDS * 0.25) : 1 - dt / BUMP_SECONDS;
    if (x > 0) lift = Math.max(lift, hits[i].strength * Math.sin((Math.PI / 2) * x));
  }
  return lift;
}

/** Which side of the road a stem's posts stand on, and how far out: first stem nearest, alternating. */
export function laneOffset(index) {
  const side = index % 2 === 0 ? -1 : 1;
  // Rows on the same side stand well apart, so the outer shows between the inner's posts.
  return side * (ROAD_WIDTH / 2 + 3.4 + Math.floor(index / 2) * 4.4);
}

/**
 * Which row each stem gets, so the two sides of the road carry about the same
 * weight: the stem with the most posts first, each next one on whichever side
 * has fewer posts so far. `counts` is posts per stem; a stem with none gets no
 * row (-1). Returns a lane index per stem, for laneOffset.
 */
export function balanceRows(counts) {
  const order = counts.map((n, i) => [n, i]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const rows = counts.map(() => -1);
  const weight = [0, 0]; // left, right
  const used = [0, 0];
  for (const [n, i] of order) {
    const side = weight[0] <= weight[1] ? 0 : 1;
    rows[i] = used[side] * 2 + side;
    used[side]++;
    weight[side] += n;
  }
  return rows;
}

/** Whether a stem makes any sound at all in the song: one that does not gets no row. */
export function sounds(peaks) {
  for (let i = 0; i < (peaks?.length || 0); i++) if (peaks[i] > 0.004) return true;
  return false;
}

/** How tall a roadside post stands for a loudness. */
export function postHeight(level) {
  // Loudness is heard as roughly the square root of amplitude.
  return 0.25 + Math.sqrt(clamp(level, 0, 1)) * MAX_POST;
}

/** Where a stem's posts stand: [{ distance, time }], POSTS_PER_BEAT to the beat, the whole road. */
export function postPlaces(track, stride = 1) {
  const step = (UNITS_PER_BEAT / POSTS_PER_BEAT) * Math.max(1, stride);
  const out = [];
  for (let d = 0; d <= track.length; d += step) out.push({ distance: d, time: track.timeAt(d) });
  return out;
}

/** Which section a moment is in: its index, or -1 between sections. */
export function sectionAt(time, sections) {
  for (let i = 0; i < sections.length; i++) if (time >= sections[i].start && time < sections[i].end) return i;
  return -1;
}

/**
 * Where the viewer and the road are. In motion the viewer is at the present
 * moment on the road. In the calm version the viewer holds still above one
 * page of road at a time, and a marker travels along it instead.
 */
export function placement(distance, calm = false) {
  if (!calm) return { viewer: distance, marker: distance, page: 0 };
  const length = CALM_PAGE_BEATS * UNITS_PER_BEAT;
  const page = Math.floor(Math.max(0, distance) / length);
  return { viewer: page * length, marker: distance, page };
}
