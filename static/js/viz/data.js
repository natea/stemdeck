// Song data for the Visualizer: everything a visualization draws from, loaded
// once per song and handed over as plain data.
//
//   song = {
//     id, duration, bpm, key,
//     stems:    [{ name, color, peaks: Float32Array(0..1), notes: [...] | null }],
//     beats:    [seconds, ...]          (empty without a beat grid)
//     bars:     [seconds, ...]          (downbeats; empty without bar marks)
//     sections: [{ start, end, kind, name, color }]   (empty without sections)
//     hasNotes: any stem has at least one note
//   }
//
// A note is { start, end, pitch, velocity } with times in seconds, pitch a MIDI
// number (a General MIDI drum key on the drums stem) and velocity 0..1.
//
// Read only: this module sends GET requests and nothing else. It imports
// nothing, so the pure parts run under node (tests/js/viz-data.test.mjs).

// The order visualizations show stems in. Stems outside it (the "original"
// mix, the lead and backing vocal pair, recording tracks) are not drawn: they
// are another view of a stem that already is.
export const STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"];
const FALLBACK_COLOR = "#88a8c8";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** [[min, max], ...] as the backend writes it -> one loudness value 0..1 per point. */
export function amplitude(points) {
  if (!Array.isArray(points)) return new Float32Array(0);
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let a = 0;
    if (Array.isArray(p)) a = Math.max(Math.abs(Number(p[0]) || 0), Math.abs(Number(p[1]) || 0));
    else if (finite(p)) a = Math.abs(p);
    out[i] = a > 1 ? 1 : a;
  }
  return out;
}

/** The loudness of a stem at a time, 0..1, linearly between its two nearest points. */
export function levelAt(peaks, duration, time) {
  const n = peaks?.length || 0;
  if (!n || !(duration > 0) || !finite(time)) return 0;
  const x = Math.min(1, Math.max(0, time / duration)) * (n - 1);
  const i = Math.floor(x);
  const j = Math.min(n - 1, i + 1);
  return peaks[i] + (peaks[j] - peaks[i]) * (x - i);
}

/** A stem's notes, cleaned and in time order. Anything that is not a note is dropped. */
export function cleanNotes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const n of list) {
    const start = Number(n?.start);
    const pitch = Math.round(Number(n?.pitch));
    if (!finite(start) || start < 0 || !finite(pitch) || pitch < 0 || pitch > 127) continue;
    let end = Number(n?.end);
    if (!finite(end) || end <= start) end = start + 0.1;
    const raw = Number(n?.velocity);
    const velocity = finite(raw) ? Math.min(1, Math.max(0, raw / 127)) : 0.63;
    out.push({ start, end, pitch, velocity });
  }
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return out;
}

/** Beat times in order, from a beat grid or nothing. */
export function beatTimes(grid) {
  const beats = Array.isArray(grid?.beats) ? grid.beats.filter(finite) : [];
  return beats.slice().sort((a, b) => a - b);
}

/**
 * Downbeat times. A bar mark { beat, beats_per_bar } says: from this beat on, a
 * bar starts every beats_per_bar beats, until the next mark (the same reading
 * as beatgrid.js and the click track).
 */
export function barTimes(beats, marks) {
  if (!Array.isArray(marks) || !marks.length || !beats.length) return [];
  const valid = marks
    .filter((m) => Number.isInteger(m?.beat) && Number.isInteger(m?.beats_per_bar) && m.beats_per_bar >= 1 && m.beat >= 0)
    .sort((a, b) => a.beat - b.beat);
  const out = [];
  for (let k = 0; k < valid.length; k++) {
    const until = k + 1 < valid.length ? valid[k + 1].beat : beats.length;
    for (let i = valid[k].beat; i < until && i < beats.length; i += valid[k].beats_per_bar) out.push(beats[i]);
  }
  return out;
}

/** Sections in time order, clipped to the song. */
export function cleanSections(list, duration) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    const start = Math.max(0, Number(s?.start));
    let end = Number(s?.end);
    if (!finite(start) || !finite(end)) continue;
    if (duration > 0) end = Math.min(end, duration);
    if (end <= start) continue;
    out.push({
      start,
      end,
      kind: typeof s.kind === "string" ? s.kind : null,
      name: typeof s.name === "string" ? s.name : "",
      color: typeof s.color === "string" ? s.color : null,
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Put one song together from what the endpoints answered. Every argument but
 * the job may be missing: no peaks, no beat grid, no transcription.
 *
 * @param job           GET /api/jobs/{id}
 * @param peaks         GET /api/jobs/{id}/peaks, or null
 * @param grid          GET /api/jobs/{id}/beats, or null
 * @param transcription GET /api/jobs/{id}/transcription, or null
 * @param colors        { stemName: "#rrggbb" }
 */
export function buildSong({ job, peaks = null, grid = null, transcription = null, colors = {} }) {
  const present = new Set((job?.stems || []).map((s) => (typeof s === "string" ? s : s?.name)).filter(Boolean));
  const names = STEM_ORDER.filter((n) => present.has(n) || (peaks && Array.isArray(peaks[n])));
  const records = transcription?.stems && typeof transcription.stems === "object" ? transcription.stems : {};

  const stems = names.map((name) => {
    const record = records[name];
    return {
      name,
      color: colors[name] || FALLBACK_COLOR,
      peaks: amplitude(peaks?.[name]),
      notes: record && Array.isArray(record.notes) ? cleanNotes(record.notes) : null,
    };
  });

  const beats = beatTimes(grid);
  let duration = Number(job?.duration);
  if (!(duration > 0)) duration = Number(grid?.duration);
  if (!(duration > 0)) {
    duration = 0;
    for (const s of stems) for (const n of s.notes || []) duration = Math.max(duration, n.end);
    if (beats.length) duration = Math.max(duration, beats[beats.length - 1]);
  }

  const bpm = [grid?.bpm, job?.bpm].map(Number).find((v) => v > 0) ?? null;
  return {
    id: job?.job_id ?? job?.id ?? null,
    duration,
    bpm,
    key: typeof job?.key === "string" ? job.key : null,
    stems,
    beats,
    bars: barTimes(beats, grid?.bars),
    sections: cleanSections(job?.sections, duration),
    hasNotes: stems.some((s) => s.notes && s.notes.length > 0),
  };
}

// ── Loading ──

/** Whether the job's own state says any stem has notes. */
export function transcribed(job) {
  return Object.values(job?.transcription_stems || {}).some((s) => s?.status === "done" && s.notes > 0);
}

async function getJson(fetchFn, url) {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("[viz] could not read", url, e);
    return null;
  }
}

// One load per song: the promise is kept, so choosing another visualization
// never asks the server again. forgetSong drops it (the host does that when the
// view opens, so notes transcribed since the last look are seen).
const cache = new Map();

/**
 * @param jobId
 * @param colors   { stemName: "#rrggbb" }
 * @param fetchFn  fetch, or a stand-in under test
 * @returns the song, or null when the job itself cannot be read
 */
export function loadSong(jobId, { colors = {}, fetchFn = globalThis.fetch } = {}) {
  if (!jobId) return Promise.resolve(null);
  if (cache.has(jobId)) return cache.get(jobId);
  const base = `/api/jobs/${encodeURIComponent(jobId)}`;
  const promise = (async () => {
    const job = await getJson(fetchFn, base);
    if (!job) {
      cache.delete(jobId);
      return null;
    }
    const [peaks, grid, transcription] = await Promise.all([
      getJson(fetchFn, `${base}/peaks`),
      getJson(fetchFn, `${base}/beats`),
      // As played, not quantised: a picture should move when the sound does.
      // Asked only when the song says it has notes: before that the endpoint
      // answers 404, which the browser would log as an error on every open.
      transcribed(job) ? getJson(fetchFn, `${base}/transcription`) : null,
    ]);
    return buildSong({ job, peaks, grid, transcription, colors });
  })();
  cache.set(jobId, promise);
  return promise;
}

export function forgetSong(jobId) {
  if (jobId == null) cache.clear();
  else cache.delete(jobId);
}
