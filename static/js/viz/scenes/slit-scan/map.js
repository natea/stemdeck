// Slit-scan score's mapping from song to strip, as plain numbers and bytes: no
// Three.js and no DOM, so it runs under node (scene.test.mjs).
//
// The strip is the whole song, left to right: one column per moment, one band
// per stem. A band's brightness in a column is the stem's loudness then, and
// where the stem has notes, bright marks sit at their pitch inside the band.

export const COLUMNS = 1536; // moments across the strip
export const ROWS = 48; // pixel rows in a band: the room pitch marks have
// The strip's place in the view, as fractions of its width and height
// (y measured from the top). The margins hold the section bar and the ruler.
export const STRIP = { x0: 0.07, x1: 0.93, y0: 0.16, y1: 0.86 };
export const BAND_GAP = 0.012; // between bands, as a fraction of the view's height
const FLOOR = 0.1; // a silent column still shows its band, faintly
const MARK_HALF = 1; // a pitch mark is this many rows either side of its row
const MARK_INSET = 3; // rows kept clear at the top and bottom of a band
const NOTED_DIM = 0.45; // a band with notes is drawn dimmer, so the marks stand out
const NOTED_FLOOR = 0.2; // but never so dim that a sounding stem loses its colour
const SILENCE = 0.004;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Which column a moment falls in. */
export function timeToColumn(time, duration, columns = COLUMNS) {
  if (!(duration > 0)) return 0;
  return clamp(Math.floor((time / duration) * columns), 0, columns - 1);
}

/** The moment at the middle of a column. */
export function columnToTime(column, duration, columns = COLUMNS) {
  return ((clamp(column, 0, columns - 1) + 0.5) / columns) * duration;
}

/** Where a moment is across the view, 0..1. */
export function timeToX(time, duration, strip = STRIP) {
  const f = duration > 0 ? clamp(time / duration, 0, 1) : 0;
  return strip.x0 + f * (strip.x1 - strip.x0);
}

/**
 * The moment under a point of the view (x and y 0..1, y from the top), or null
 * when the point is not on the strip. A little slack above and below, so the
 * section bar and the ruler seek too.
 */
export function pointToTime(x, y, duration, strip = STRIP) {
  if (!(duration > 0)) return null;
  // A hair of tolerance: the strip's own right edge, computed, can land a
  // rounding error outside it.
  if (x < strip.x0 - 1e-9 || x > strip.x1 + 1e-9) return null;
  if (y < strip.y0 - 0.06 || y > strip.y1 + 0.06) return null;
  return clamp((x - strip.x0) / (strip.x1 - strip.x0), 0, 1) * duration;
}

/** Each band's top and bottom (0..1 from the top), first stem uppermost. */
export function bandRects(count, strip = STRIP) {
  if (count <= 0) return [];
  const gap = count > 1 ? BAND_GAP : 0;
  const h = (strip.y1 - strip.y0 - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => {
    const y0 = strip.y0 + i * (h + gap);
    return { y0, y1: y0 + h };
  });
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [136, 168, 200];
}

/** The loudest point of a stem inside one column, 0..1. */
export function columnLevel(peaks, column, columns = COLUMNS) {
  const n = peaks?.length || 0;
  if (!n) return 0;
  const from = Math.floor((column / columns) * n);
  const to = Math.max(from + 1, Math.ceil(((column + 1) / columns) * n));
  let level = 0;
  for (let i = from; i < to && i < n; i++) if (peaks[i] > level) level = peaks[i];
  return level;
}

/** How bright a column of a band is for a loudness, 0..1. */
export function brightness(level) {
  // Loudness is heard as roughly the square root of amplitude.
  return FLOOR + (1 - FLOOR) * Math.sqrt(clamp(level, 0, 1));
}

/** The lowest and highest pitch of a stem's notes. */
export function pitchSpan(notes) {
  let min = Infinity;
  let max = -Infinity;
  for (const n of notes || []) {
    if (n.pitch < min) min = n.pitch;
    if (n.pitch > max) max = n.pitch;
  }
  if (min > max) return null;
  // A part on one or two pitches still gets room either side.
  if (max - min < 6) {
    const pad = Math.ceil((6 - (max - min)) / 2);
    min -= pad;
    max += pad;
  }
  return { min, max };
}

/** Which row of the band a pitch is marked on: low pitches low, high pitches high. */
export function pitchRow(pitch, span, rows = ROWS) {
  const lowest = MARK_HALF + MARK_INSET;
  const inner = rows - 1 - 2 * lowest;
  const f = clamp((pitch - span.min) / (span.max - span.min), 0, 1);
  return lowest + Math.round(f * inner);
}

/**
 * One stem's band as RGBA bytes, `columns` wide and `rows` tall, row 0 at the
 * bottom. Loudness is the brightness of each column. With notes, the band is
 * drawn dimmer and each note is a bright mark at its pitch for its length.
 */
export function bandPixels(stem, duration, columns = COLUMNS, rows = ROWS) {
  const [r, g, b] = hexToRgb(stem.color);
  const px = new Uint8Array(columns * rows * 4);
  const span = pitchSpan(stem.notes);
  for (let c = 0; c < columns; c++) {
    const level = columnLevel(stem.peaks, c, columns);
    let k = brightness(level);
    // With notes: dimmer, but a column that sounds keeps a tint of its stem.
    if (span) k = level > SILENCE ? Math.max(NOTED_FLOOR, k * NOTED_DIM) : k * NOTED_DIM;
    const cr = Math.round(r * k);
    const cg = Math.round(g * k);
    const cb = Math.round(b * k);
    for (let y = 0; y < rows; y++) {
      const i = (y * columns + c) * 4;
      px[i] = cr;
      px[i + 1] = cg;
      px[i + 2] = cb;
      px[i + 3] = 255;
    }
  }
  if (!span) return px;
  // Marks: the stem's colour pushed half of the way to white.
  const mr = Math.round(r * 0.5 + 255 * 0.5);
  const mg = Math.round(g * 0.5 + 255 * 0.5);
  const mb = Math.round(b * 0.5 + 255 * 0.5);
  for (const n of stem.notes) {
    const from = timeToColumn(n.start, duration, columns);
    const to = Math.max(from, timeToColumn(n.end, duration, columns));
    const row = pitchRow(n.pitch, span, rows);
    for (let y = row - MARK_HALF; y <= row + MARK_HALF; y++) {
      for (let c = from; c <= to; c++) {
        const i = (y * columns + c) * 4;
        px[i] = mr;
        px[i + 1] = mg;
        px[i + 2] = mb;
      }
    }
  }
  return px;
}
