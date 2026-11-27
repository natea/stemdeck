// The chord strip's logic, with no DOM in it (tests/js/chord-strip.test.mjs).
//
// A song's chord timeline is a list of entries in time order with no gaps:
//
//   { start, end, root, degrees, bass }      a chord
//   { start, end, root: null, degrees: [] }  "no chord"
//
// The strip (chordStrip.js) draws it, lights the entry under the playhead and
// lets the user correct it. Everything it has to work out is here: which
// entry is sounding, what is drawn when bass notes are hidden, and what the
// list looks like after each kind of correction.
//
// Corrections return a new list and never change the one they are given. The
// whole list is what is saved (PATCH /api/jobs/{id}/chords), the way an
// edited beat grid is.

import { degreeSemitones, sameChord, sortDegrees } from "../harmony/chords.js";

/** Without a beat grid, Start earlier and Start later move by this much. */
export const FREE_STEP_SEC = 0.5;

/** The server refuses a longer list (app/core/chord_model.py MAX_ENTRIES). */
export const MAX_ENTRIES = 5000;

const EPS = 1e-6;
const round3 = (n) => Math.round(n * 1000) / 1000;

function isPitchClass(value) {
  return Number.isInteger(value) && value >= 0 && value <= 11;
}

function chordOf(entry) {
  if (!isPitchClass(entry?.root)) return { root: null, degrees: [], bass: null };
  const degrees = sortDegrees(entry.degrees);
  const bass = isPitchClass(entry.bass) && entry.bass !== entry.root ? entry.bass : null;
  return { root: entry.root, degrees: degrees.length ? degrees : ["1"], bass };
}

function entry(start, end, chord, label) {
  const out = { start: round3(start), end: round3(end), ...chordOf(chord) };
  if (typeof label === "string" && label) out.label = label;
  return out;
}

// ─── Reading what the server sent ─────────────────────────

/**
 * The entries of a served timeline, cleaned: in time order, each with a
 * length, none overlapping the one before. An entry that cannot be used is
 * dropped rather than drawn at NaN.
 */
export function cleanTimeline(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const start = Number(item.start);
    const end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < EPS) continue;
    if (out.length && start < out[out.length - 1].end - EPS) continue;
    out.push(entry(start, end, item, item.label));
  }
  return out;
}

/**
 * Whether a list is one the server will accept: the checks of
 * app/core/chord_model.py clean_entries, so a save that would be refused is
 * not sent.
 */
export function isValidTimeline(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) return false;
  let at = 0;
  for (const e of entries) {
    if (!e || !Number.isFinite(e.start) || !Number.isFinite(e.end)) return false;
    if (e.start < 0 || e.end <= e.start || e.start < at - EPS || e.end >= 86400) return false;
    if (e.root !== null && !isPitchClass(e.root)) return false;
    if (e.bass !== null && e.bass !== undefined && !isPitchClass(e.bass)) return false;
    if (!Array.isArray(e.degrees) || e.degrees.some((d) => degreeSemitones(d) === null)) return false;
    at = e.end;
  }
  return true;
}

/** What is sent to the server: the entries without the detector's labels. */
export function payload(entries) {
  return entries.map((e) => ({
    start: e.start,
    end: e.end,
    root: e.root,
    degrees: [...e.degrees],
    bass: e.bass ?? null,
  }));
}

// ─── What is drawn ────────────────────────────────────────

/**
 * The blocks the strip draws. One per entry when bass notes are shown. When
 * they are hidden, neighbours that are the same chord over different bass
 * notes are one block: over a walking bass the chord has not changed.
 *
 * Each block is { first, last, start, end, chord }, with `first` and `last`
 * the entries it stands for.
 */
export function blocks(entries, { bass = false } = {}) {
  const out = [];
  entries.forEach((e, i) => {
    const prev = out[out.length - 1];
    if (prev && sameChord(prev.chord, e, { bass }) && Math.abs(prev.end - e.start) < 1e-3) {
      prev.last = i;
      prev.end = e.end;
    } else {
      out.push({ first: i, last: i, start: e.start, end: e.end, chord: chordOf(e) });
    }
  });
  return out;
}

/** The index of the item of `list` (entries or blocks) that holds `time`, or -1. */
export function indexAt(list, time) {
  if (!Array.isArray(list) || !list.length || !Number.isFinite(time)) return -1;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time < list[mid].start) hi = mid - 1;
    else if (time >= list[mid].end) lo = mid + 1;
    else return mid;
  }
  // The very end of the song belongs to the last item.
  const last = list[list.length - 1];
  return Math.abs(time - last.end) < 1e-3 ? list.length - 1 : -1;
}

/** Where a block sits, as percentages of the song's length. */
export function placement(block, duration) {
  const total = Math.max(0.001, Number(duration) || 0);
  const left = Math.max(0, Math.min(100, (block.start / total) * 100));
  const right = Math.max(left, Math.min(100, (block.end / total) * 100));
  return { left, width: right - left };
}

/** A label may be drawn this much narrower than its text before it is hidden. */
export const LABEL_MIN_SCALE = 0.75;

/**
 * Which labels are drawn, and how wide. A chord symbol is shown whole or not
 * at all: half of one is a different chord (F for F sharp). Whenever there is
 * room for a symbol it is shown, squeezed a little sideways if that is what
 * makes it fit; it is hidden only when even squeezed it would run into
 * another.
 *
 * `items` are the blocks in order, each { start, width, room } in pixels:
 * where its label begins, how wide the label's text is, and how much of its
 * own block there is to hold it. `limit` is where the track ends.
 *
 * Returns a scale per block: 1 for a label at its full width, less for one
 * drawn narrower (never under `minScale`), 0 for one that is not drawn.
 *
 * A label that fits inside its own block, squeezed if need be, is always
 * drawn. Any label may run on over the blocks after it, up to `gap` short of
 * the next label that is sure to be drawn. A block with no text (a gap in the
 * song) draws nothing and is in nobody's way.
 */
export function fitLabels(items, { gap = 4, limit = Infinity, minScale = LABEL_MIN_SCALE } = {}) {
  const sure = items.map((item) => item.width > 0 && item.width * minScale <= item.room);
  // For each block, where the next label that is sure to be drawn begins.
  const nextSure = new Array(items.length).fill(Infinity);
  for (let i = items.length - 2; i >= 0; i--) {
    nextSure[i] = sure[i + 1] ? items[i + 1].start : nextSure[i + 1];
  }
  const scales = new Array(items.length).fill(0);
  let lastEnd = -Infinity;
  items.forEach((item, i) => {
    if (!(item.width > 0)) return;
    // How far this label may reach: the next sure label, or the end of the track.
    const reach = Math.min(nextSure[i] === Infinity ? limit : nextSure[i] - gap, limit);
    // A sure label always has its own block, whatever lies ahead.
    const space = Math.max(reach - item.start, sure[i] ? item.room : 0);
    if (!sure[i] && item.start < lastEnd + gap) return;
    const scale = Math.min(1, space / item.width);
    if (scale < minScale) return;
    scales[i] = scale;
    lastEnd = item.start + item.width * scale;
  });
  return scales;
}

// ─── Corrections ──────────────────────────────────────────

/** Drop what has no length and join neighbours that are the same chord. */
export function tidy(entries) {
  const out = [];
  for (const e of entries) {
    if (e.end - e.start < 1e-3) continue;
    const prev = out[out.length - 1];
    if (prev && sameChord(prev, e) && Math.abs(prev.end - e.start) < 1e-3) {
      prev.end = e.end;
    } else {
      out.push({ ...e, degrees: [...e.degrees] });
    }
  }
  return out;
}

function span(entries, first, last) {
  if (!Number.isInteger(first) || !Number.isInteger(last)) return null;
  if (first < 0 || last < first || last >= entries.length) return null;
  return { start: entries[first].start, end: entries[last].end };
}

/** Entries `first` to `last` become one entry holding `chord`. */
export function setChord(entries, first, last, chord) {
  const where = span(entries, first, last);
  if (!where) return entries;
  return tidy([
    ...entries.slice(0, first),
    entry(where.start, where.end, chord),
    ...entries.slice(last + 1),
  ]);
}

/** Entries `first` to `last` become "no chord". */
export function clearChord(entries, first, last) {
  return setChord(entries, first, last, { root: null });
}

/**
 * Entries `first` to `last` are deleted: the entry before them lasts until
 * the entry after them starts. With nothing before them, the stretch becomes
 * "no chord".
 */
export function removeChord(entries, first, last) {
  const where = span(entries, first, last);
  if (!where) return entries;
  if (first === 0) return clearChord(entries, first, last);
  const before = entries.slice(0, first).map((e) => ({ ...e }));
  before[before.length - 1].end = where.end;
  return tidy([...before, ...entries.slice(last + 1)]);
}

/**
 * The time one step from `time`: the next beat in that direction, or
 * FREE_STEP_SEC away when the song has no beat grid. `direction` is -1 for
 * earlier and 1 for later.
 */
export function stepTime(beats, time, direction) {
  const dir = direction < 0 ? -1 : 1;
  if (!Array.isArray(beats) || beats.length < 2) return round3(time + dir * FREE_STEP_SEC);
  if (dir < 0) {
    for (let i = beats.length - 1; i >= 0; i--) {
      if (beats[i] < time - 1e-3) return round3(beats[i]);
    }
  } else {
    for (const beat of beats) {
      if (beat > time + 1e-3) return round3(beat);
    }
  }
  return null;
}

/**
 * Move the start of entry `first` one step earlier or later. The entry before
 * it ends there. Returns { entries, moved }: nothing moves when the step
 * would leave either of the two with no length, or when there is no beat
 * that way.
 *
 * The first entry of the song has nothing before it: moving its start later
 * leaves "no chord" in front of it, and it cannot move earlier.
 */
export function moveStart(entries, first, direction, beats) {
  const same = { entries, moved: false };
  if (!Number.isInteger(first) || first < 0 || first >= entries.length) return same;
  const target = entries[first];
  const to = stepTime(beats, target.start, direction);
  if (to === null || to < 0) return same;
  if (to >= target.end - 1e-3) return same;
  const next = entries.map((e) => ({ ...e, degrees: [...e.degrees] }));
  if (first === 0) {
    if (to <= target.start) return same;
    next[0].start = to;
    next.unshift(entry(target.start, to, { root: null }));
    return { entries: tidy(next), moved: true };
  }
  const before = entries[first - 1];
  if (to <= before.start + 1e-3) return same;
  next[first - 1].end = to;
  next[first].start = to;
  return { entries: tidy(next), moved: true };
}

/**
 * A chord as the user typed it, in the key they are hearing, as the chord to
 * store. The strip shows chords moved by the player's transposition, so what
 * is typed is moved back by it.
 */
export function fromDisplayed(parsed, transpose = 0) {
  if (!parsed || parsed.root === null) return { root: null, degrees: [], bass: null };
  const shift = (pc) => (((pc - (Number(transpose) || 0)) % 12) + 12) % 12;
  return {
    root: shift(parsed.root),
    degrees: [...parsed.degrees],
    bass: parsed.bass === null || parsed.bass === undefined ? null : shift(parsed.bass),
  };
}

// ─── A run in progress ────────────────────────────────────

/** The i18n key for the step a running detection is in. */
export function phaseKey(progress) {
  const phase = progress?.phase;
  if (phase === "downloading") return "chords.progress.downloading";
  if (phase === "mixing") return "chords.progress.mixing";
  if (phase === "loading") return "chords.progress.loading";
  if (phase === "detecting") return "chords.progress.detecting";
  if (phase === "finishing") return "chords.progress.finishing";
  return "chords.progress.starting";
}

/** The reason codes the server can give (app/core/chord_outcome.py). */
export const REASONS = [
  "dependency_missing",
  "model_download",
  "no_audio",
  "out_of_memory",
  "worker_failed",
  "timeout",
  "cancelled",
  "interrupted",
];

/** The i18n key for why a detection did not finish. */
export function reasonKey(code) {
  return `chords.reason.${REASONS.includes(code) ? code : "worker_failed"}`;
}
