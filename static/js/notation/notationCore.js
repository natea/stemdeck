// The Notation view's decisions, with no DOM and no alphaTab, so node can
// test them (tests/js/notation.test.mjs): which stems are shown, what is
// remembered for a song, the addresses of the score and the downloads, what
// the view says when there is nothing to draw, and how a tuning is written.

/** Stems that can be drawn as tablature (app/core/config.py TAB_STEMS). */
export const TAB_STEMS = Object.freeze(["guitar", "bass"]);

/** Top to bottom as a score is read (app/api/transcription.py _SCORE_ORDER). */
export const SCORE_ORDER = Object.freeze([
  "vocals", "lead_vocals", "backing_vocals", "guitar", "piano", "other", "bass", "drums",
]);

/** How many stems a song shows before the user has chosen: what one can read
 * at once, and what a long song draws quickly. */
export const DEFAULT_SHOWN = 4;

export const ZOOMS = Object.freeze([0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5]);
export const DEFAULT_ZOOM = 0.8;

// Room for the two rows of controls, a notice, the foot and a system of music.
export const DRAWER_MIN_PX = 260;
export const DRAWER_DEFAULT_PX = 360;

/** Where a song's view choices are kept (static/js/utils.js storeGet/storeSet). */
export const prefsKey = (jobId) => `stemdeck:notation:${jobId}`;
export const HEIGHT_KEY = "stemdeck:notation:height";

/**
 * Stored choices made safe to use: `hidden` (the stems unticked, or null when
 * the user has never chosen), `parts` (the resolution) and `zoom`.
 */
export function cleanPrefs(raw, { parts = [1, 2, 3, 4, 6, 8], defaultParts = 4 } = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const hidden = Array.isArray(src.hidden)
    ? [...new Set(src.hidden.filter((s) => typeof s === "string"))]
    : null;
  const wanted = Number(src.parts);
  const zoom = Number(src.zoom);
  return {
    hidden,
    parts: parts.includes(wanted) ? wanted : defaultParts,
    zoom: ZOOMS.includes(zoom) ? zoom : DEFAULT_ZOOM,
    // Follow the song unless the reader turned it off.
    follow: src.follow !== false,
  };
}

/** `names` in score order; a name with no place in the order goes last. */
export function inScoreOrder(names) {
  const rank = (n) => (SCORE_ORDER.includes(n) ? SCORE_ORDER.indexOf(n) : SCORE_ORDER.length);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * The stems with notes to draw, from the song's job state
 * (`transcription_stems`: {name: {status, notes}}), in score order.
 */
export function availableStems(transcriptionStems) {
  const names = Object.entries(transcriptionStems || {})
    .filter(([, entry]) => entry?.status === "done" && Number(entry.notes) > 0)
    .map(([name]) => name);
  return inScoreOrder(names);
}

/**
 * Which of `available` are drawn. A song the user has made no choice for
 * shows the first DEFAULT_SHOWN. After that, everything not unticked: a stem
 * transcribed later appears without being asked for.
 */
export function shownStems(available, prefs) {
  if (!prefs?.hidden) return available.slice(0, DEFAULT_SHOWN);
  return available.filter((name) => !prefs.hidden.includes(name));
}

/** `prefs` with `stem` ticked or unticked. */
export function withStem(available, prefs, stem, on) {
  const shown = new Set(shownStems(available, prefs));
  if (on) shown.add(stem);
  else shown.delete(stem);
  return { ...prefs, hidden: available.filter((name) => !shown.has(name)) };
}

const query = (params) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

/** The address of the score for `stems` at `parts` per beat. */
export function scoreUrl(jobId, stems, parts) {
  return `/api/jobs/${jobId}/transcription.alphatex${query({ format: "json", stems: stems.join(","), parts })}`;
}

/**
 * The server's downloads for the stems on show. Guitar Pro is not among
 * them: it is made in the browser from the score that is drawn.
 */
export function downloadUrls(jobId, stems, parts) {
  const base = `/api/jobs/${jobId}/transcription`;
  const names = stems.join(",");
  return {
    midiPlayed: `${base}.mid${query({ stems: names })}`,
    midiQuantised: `${base}.mid${query({ stems: names, quantize: 1, parts })}`,
    musicxml: `${base}.musicxml${query({ stems: names, parts })}`,
  };
}

/** The next zoom step up (dir 1) or down (dir -1), staying at the ends. */
export function stepZoom(zoom, dir) {
  const at = ZOOMS.indexOf(zoom);
  const from = at < 0 ? ZOOMS.indexOf(DEFAULT_ZOOM) : at;
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, from + dir))];
}

/**
 * The index of the bar holding `tick`, given each bar's first tick in order.
 * Before the first bar is the first bar; with no bars, -1.
 */
export function barAt(starts, tick) {
  if (!starts?.length) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * What the view shows in place of a score, or null to draw one.
 *   "untranscribed": the song has no notes yet (offer Transcribe)
 *   "no-grid":       notes, but no beat grid to put them in bars
 *   "no-stems":      every stem is unticked
 *   "failed":        the score could not be fetched or read
 */
export function emptyState({ available = [], shown = [], status = 200, reason = null, failed = false }) {
  if (!available.length || status === 404) return "untranscribed";
  if (status === 409 && reason === "no_beat_grid") return "no-grid";
  if (failed || status >= 400) return "failed";
  if (!shown.length) return "no-stems";
  return null;
}

/**
 * For each fretted stem drawn: how many notes are missing from its tab and
 * why, and the tuning that would reach more of them. Stems with nothing
 * missing are left out.
 */
export function unplacedNotes(tab) {
  const out = [];
  for (const stem of TAB_STEMS) {
    const facts = tab?.[stem];
    if (!facts || !(facts.unplaced > 0)) continue;
    out.push({
      stem,
      count: facts.unplaced,
      outOfRange: facts.reasons?.out_of_range || 0,
      tooMany: facts.reasons?.too_many_notes || 0,
      suggestion: facts.suggestion || null,
    });
  }
  return out;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** A MIDI pitch as a note name: 40 is "E2". */
export function pitchName(pitch) {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

/** A tuning as its strings' names, lowest first: "E2 A2 D3 G3 B3 E4". */
export function tuningText(tuning) {
  return (tuning || []).map(pitchName).join(" ");
}

/**
 * A typed tuning ("D2 A2 D3 G3 A3 D4", lowest string first) as MIDI pitches,
 * or null when a word is not a note name or the count is not `min` to `max`.
 */
export function parseTuning(text, { min = 4, max = 8 } = {}) {
  const words = String(text || "").trim().split(/[\s,]+/).filter(Boolean);
  if (words.length < min || words.length > max) return null;
  const out = [];
  for (const word of words) {
    const m = /^([A-Ga-g])([#♯b♭]?)(-?\d)$/.exec(word);
    if (!m) return null;
    const shift = m[2] === "#" || m[2] === "♯" ? 1 : m[2] ? -1 : 0;
    out.push(NOTE_STEPS[m[1].toUpperCase()] + shift + 12 * (Number(m[3]) + 1));
  }
  return out;
}
