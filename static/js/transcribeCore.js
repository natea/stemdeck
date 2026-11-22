// The parts of the Transcribe dialog (transcribe.js) that are plain data in,
// plain data out: which stems can be chosen, what a download link asks for,
// and when the beat grid deserves a warning. No DOM and no imports, so they
// run under node (tests/js/transcribe.test.mjs).

// Below this, the beat grid is too unsure to quantise against without a word.
export const LOW_CONFIDENCE = 60;
export const ROUTES = ["crepe", "piano", "mt3"];
// app/core/transcription_outcome.py CODES. Each has a transcribe.reason.* string.
export const REASONS = [
  "dependency_missing", "model_unavailable", "out_of_memory", "worker_failed",
  "timeout", "cancelled", "interrupted", "unsupported_platform", "no_beat_grid",
];

// The stems the server can transcribe for this song, in the song's order.
export function transcribableStems(state, routes) {
  const names = (state?.stems || []).map((s) => s?.name).filter(Boolean);
  return names.filter((n) => routes && Object.prototype.hasOwnProperty.call(routes, n));
}

// Ticked by default: every stem that is not silent. A song without presence
// data ticks everything; the worker skips a silent stem either way.
export function defaultChoice(names, presence) {
  return new Set(names.filter((n) => !presence || presence[n] == null || presence[n] > 0));
}

// The query string for a download: the ticked stems that have notes, or
// every transcribed stem when none of the ticked ones do.
export function downloadQuery(chosenNames, stemsState, { quantize = false, parts = null } = {}) {
  const withNotes = [...chosenNames].filter(
    (n) => stemsState?.[n]?.status === "done" && stemsState[n].notes > 0,
  );
  const params = new URLSearchParams();
  if (withNotes.length) params.set("stems", withNotes.join(","));
  if (quantize) params.set("quantize", "1");
  if (parts != null) params.set("parts", String(parts));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function hasNotes(stemsState) {
  return Object.values(stemsState || {}).some((s) => s?.status === "done" && s.notes > 0);
}

// What to warn about before someone trusts a quantised file: "no-grid" when
// the song cannot be quantised at all, "low-confidence" when its grid is
// unsure, null otherwise (including before the answer is known).
export function gridWarning(info) {
  if (!info?.known) return null;
  if (!info.available) return "no-grid";
  if (info.confidence != null && info.confidence < LOW_CONFIDENCE) return "low-confidence";
  return null;
}
