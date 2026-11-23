// Song planet's mapping from song to a small world, as plain numbers: no
// Three.js and no DOM, so it runs under node (scene.test.mjs).
//
// The song is wrapped once around the planet's equator: a moment `t` is the
// meridian at longitude 2π · t / duration, so one lap is one song. Each stem is
// a band of terrain at its own latitude, raised by its loudness. Each section
// is the stretch of ground between its start's and its end's meridians, in its
// own colour. Longitude 0 faces +z and grows toward +x.

export const RADIUS = 10;
export const LIFT = 1.7; // how far a stem's loudest terrain stands above the ground
export const LAT_SPAN = 50; // the bands lie between this many degrees north and south
export const BAND_GAP = 4; // degrees of bare ground between bands
export const SEGMENTS = [96, 144, 192]; // steps around the planet, per quality level: few, so facets show
export const NOTE_CAP = [1200, 4000, 12000]; // note crystals per stem, per quality level
export const CAMERA_DISTANCE = 41;
export const CAMERA_ELEVATION = 7; // degrees above the equator

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The longitude of a moment: 0 at the start, a full turn at the end. */
export function timeToAngle(time, duration) {
  if (!(duration > 0)) return 0;
  return clamp(time / duration, 0, 1) * TAU;
}

/** The moment at a longitude (any angle; it wraps). */
export function angleToTime(angle, duration) {
  const a = ((angle % TAU) + TAU) % TAU;
  return (a / TAU) * duration;
}

/** A point at a longitude (radians), a latitude (degrees) and a distance from the centre. */
export function surfacePoint(angle, latitude, radius) {
  const lat = latitude * RAD;
  return {
    x: radius * Math.cos(lat) * Math.sin(angle),
    y: radius * Math.sin(lat),
    z: radius * Math.cos(lat) * Math.cos(angle),
  };
}

/** Where the viewpoint is when it is over a longitude. */
export function cameraPlace(angle, distance = CAMERA_DISTANCE, elevation = CAMERA_ELEVATION) {
  return surfacePoint(angle, elevation, distance);
}

/** The longitude a viewpoint at (x, z) is over, 0..2π. */
export function angleOf(x, z) {
  return (Math.atan2(x, z) + TAU) % TAU;
}

/** Each stem's band of latitude, first stem northernmost: [{ north, south }] in degrees. */
export function bandLatitudes(count) {
  if (count <= 0) return [];
  const gap = count > 1 ? BAND_GAP : 0;
  const height = (LAT_SPAN * 2 - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => {
    const north = LAT_SPAN - i * (height + gap);
    return { north, south: north - height };
  });
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

/** The loudest point of a stem in the stretch of song one step around the planet covers. */
export function stepLevel(peaks, step, steps) {
  const n = peaks?.length || 0;
  if (!n) return 0;
  const from = Math.floor((step / steps) * n);
  const to = Math.max(from + 1, Math.ceil(((step + 1) / steps) * n));
  let level = 0;
  for (let i = from; i < to && i < n; i++) if (peaks[i] > level) level = peaks[i];
  return level;
}

/**
 * How high terrain stands for a loudness: 0..LIFT. `loudest` is the stem's own
 * loudest moment, so every stem uses the full height, and the curve is steep,
 * so a quiet passage sinks to the ground and a loud one stands clear: a ring's
 * skyline is that stem's loud and quiet through the song.
 */
export function lift(level, loudest = 1) {
  const f = loudest > 0 ? clamp(level / loudest, 0, 1) : 0;
  return Math.pow(f, 1.7) * LIFT;
}

/** A stem's loudest moment. */
export function loudestOf(peaks) {
  let top = 0;
  for (let i = 0; i < (peaks?.length || 0); i++) if (peaks[i] > top) top = peaks[i];
  return top;
}

/** A band's cross-section: 0 at its edges, 1 along its middle. `across` is 0..1. */
export function profile(across) {
  return Math.sin(Math.PI * clamp(across, 0, 1));
}

/** Which section a moment is in: its index, or -1 between sections. */
export function sectionAt(time, sections) {
  for (let i = 0; i < sections.length; i++) if (time >= sections[i].start && time < sections[i].end) return i;
  return -1;
}

/** Each section as a stretch of longitude: [{ from, to, color, index }] in radians. */
export function sectionRegions(sections, duration) {
  return sections.map((s, index) => ({
    from: timeToAngle(s.start, duration),
    to: timeToAngle(s.end, duration),
    color: s.color || "#88a8c8",
    index,
  }));
}

/** The lowest and highest pitch of a stem's notes, never narrower than six semitones. */
export function pitchSpan(notes) {
  let min = Infinity;
  let max = -Infinity;
  for (const n of notes || []) {
    if (n.pitch < min) min = n.pitch;
    if (n.pitch > max) max = n.pitch;
  }
  if (min > max) return null;
  if (max - min < 6) {
    const pad = Math.ceil((6 - (max - min)) / 2);
    min -= pad;
    max += pad;
  }
  return { min, max };
}

/**
 * Where a note's crystal stands: at its moment's longitude, across its stem's
 * band by pitch (low notes toward the south edge, high toward the north), as
 * tall as it was played hard.
 */
export function notePlace(note, band, span, duration) {
  const f = clamp((note.pitch - span.min) / (span.max - span.min), 0, 1);
  const across = 0.12 + f * 0.76; // 0 is the band's south edge
  return {
    angle: timeToAngle(note.start, duration),
    latitude: band.south + across * (band.north - band.south),
    across,
    height: 0.12 + note.velocity * 0.5,
  };
}

/** Which notes get a crystal when there are more than `cap`: every k-th, evenly. */
export function thin(count, cap) {
  if (count <= cap) return 1;
  return Math.ceil(count / cap);
}
