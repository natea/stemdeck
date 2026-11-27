// The Chords strip (Labs): a song's chord timeline under the Markers bar.
//
// One block per chord, at a percentage of an inner track that is the zoomed
// waveform's width; transport.js slides that track by the waveform's scroll
// (syncRulerScroll), so zooming and scrolling need nothing from here. The
// block under the playhead is lit as playback goes; a click moves playback to
// a chord's start.
//
// The server holds the chords as facts, a root and chord tones
// (GET /api/jobs/{id}/chords), already moved onto the song's beats. This
// module writes the symbols (harmony/chords.js), because how a chord is
// spelled depends on the song's key and on how far the player has transposed
// it, and it redraws them when either changes.
//
// The rail's Chords button switches the strip on. It is off until someone
// asks for it: the strip takes a row from the mixer, and detection is a Labs
// feature whose result is a draft. Detect runs the model on the server and
// shows the step it is in; Edit turns a click on a chord into a correction.
// A correction changes the list here and saves the whole of it (PATCH), in a
// file of its own on the server, so detecting again never discards one.
//
// Everything that can be worked out without a page is in chordStripCore.js,
// where node tests it. This file is the DOM, the requests and the clock.

import { onLanguageChange, t } from "../i18n.js";
import { getGlobalPitch, setPlayheadTime, transport } from "../transport.js";
import { chordSymbol, parseSymbol } from "../harmony/chords.js";
import {
  blocks, cleanTimeline, clearChord, fitLabels, fromDisplayed, indexAt, isValidTimeline,
  moveStart, payload, phaseKey, placement, reasonKey, removeChord, setChord,
} from "./chordStripCore.js";

const ON_KEY = "stemdeck.chords.on";
const BASS_KEY = "stemdeck.chords.bass";
const POLL_MS = 1000;
const SAVE_DELAY_MS = 350;
const RESET_ARM_MS = 4000;
// Where a label begins inside its block (the tick and the padding, chords.css),
// and the least room between two labels.
const LABEL_INSET_PX = 6;
const LABEL_GAP_PX = 4;

let els = null;
let config = null;

// The open song.
let jobId = null;
// Bumped whenever the song changes, so an answer for the last one is dropped.
let token = 0;
let song = { key: null, duration: 0 };
let entries = [];
let beats = [];
let edited = false;
let hasDetected = false;
// Whether the open song is known to have chords, for an install that cannot
// detect any: its button is offered only for a song that brought some.
let knownChords = false;

// What the user chose.
let on = false;
let showBass = false;
let editing = false;

// A detection in progress on the open song.
let running = false;
let pollTimer = null;
// A run this page did not start (it was found running): nobody is waiting on
// its POST, so the poll is what notices it end.
let watching = false;

// What the line under the track says: { key, vars?, problem? } or null.
let note = null;

// Drawing.
let drawn = [];
let blockEls = [];
let playheadEl = null;
let frame = 0;
let currentIndex = -1;
let lastPitch = 0;
let lastTime = -1;

// Saving corrections.
let saveTimer = null;
let saveChain = Promise.resolve();
let savedTimer = null;
let resetTimer = null;

// The correction popover.
let pop = null;
let popIndex = -1;

// ─── Small things ─────────────────────────────────────────

function readFlag(key) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch (e) {
    console.warn("[chords] could not read a stored choice:", e);
    return false;
  }
}

function writeFlag(key, value) {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch (e) {
    console.warn("[chords] could not store a choice:", e);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function pitch() {
  return Number(getGlobalPitch()?.semitones) || 0;
}

function symbolOf(chord, bass = showBass) {
  return chordSymbol(chord, { key: song.key, transpose: pitch(), bass });
}

function available() {
  return Boolean(config?.chords_available);
}

async function loadConfig() {
  if (config) return config;
  try {
    const res = await fetch("/api/config");
    config = res.ok ? await res.json() : {};
  } catch (e) {
    console.warn("[chords] could not read /api/config:", e);
    config = {};
  }
  return config;
}

// ─── What is shown ────────────────────────────────────────

function setNote(next) {
  note = next;
  renderNote();
}

function renderNote() {
  if (!els) return;
  let shown = note;
  // Nothing to say and nothing to show: say how to get some.
  if (!shown && !entries.length && jobId && !running) {
    shown = { key: available() ? "chords.empty" : "chords.unavailable" };
  }
  els.note.hidden = !shown;
  els.note.classList.toggle("problem", Boolean(shown?.problem));
  els.note.textContent = shown ? t(shown.key, shown.vars) : "";
}

function renderButtons() {
  if (!els) return;
  const some = entries.length > 0;
  els.rail.hidden = !(jobId && (available() || knownChords));
  els.rail.setAttribute("aria-pressed", String(on));
  els.ribbon.hidden = !(on && jobId && !els.rail.hidden);
  els.ribbon.classList.toggle("editing", editing);
  els.ribbon.classList.toggle("running", running);
  els.area.hidden = !some;

  els.bass.hidden = !some;
  els.bass.setAttribute("aria-pressed", String(showBass));
  els.edit.hidden = !some;
  els.edit.disabled = running;
  els.edit.setAttribute("aria-pressed", String(editing));
  els.reset.hidden = !edited || running;
  els.detect.hidden = running || !available();
  els.detect.title = t(some ? "chords.detectAgainTitle" : "chords.detectTitle");
  els.cancel.hidden = !running;
}

// The width of a label's text, without laying anything out: there can be
// hundreds of them, and they are measured again at every zoom step.
let measureCtx = null;
let measureFont = "";
const measured = new Map();

function textWidth(text, font) {
  if (!text) return 0;
  if (font !== measureFont) {
    measureFont = font;
    measured.clear();
  }
  let width = measured.get(text);
  if (width === undefined) {
    try {
      measureCtx ??= document.createElement("canvas").getContext("2d");
      measureCtx.font = font;
      width = measureCtx.measureText(text).width;
    } catch (e) {
      width = text.length * 8;
    }
    measured.set(text, width);
  }
  return width;
}

/**
 * Show each chord's symbol whole or not at all (fitLabels). Run when the
 * symbols change and when the track changes width: zooming in makes room
 * for more of them.
 */
function layoutLabels() {
  if (!els || els.ribbon.hidden || !drawn.length || !blockEls.length) return;
  // Layout pixels, not getBoundingClientRect: the app can be zoomed by CSS.
  const width = els.track.offsetWidth;
  if (!width) return;
  const font = getComputedStyle(blockEls[0]).font || "600 12px sans-serif";
  const items = drawn.map((block, i) => {
    const where = placement(block, song.duration);
    return {
      start: (where.left / 100) * width + LABEL_INSET_PX,
      width: Math.ceil(textWidth(blockEls[i].firstChild.textContent, font)),
      room: (where.width / 100) * width - LABEL_INSET_PX - 1,
    };
  });
  const scales = fitLabels(items, { gap: LABEL_GAP_PX, limit: width });
  blockEls.forEach((node, i) => {
    const scale = scales[i];
    node.classList.toggle("label-hidden", scale === 0);
    // Squeezed sideways when that is what lets it show (chords.css undoes
    // this for the chord that is sounding and the one under the pointer).
    node.firstChild.style.transform = scale > 0 && scale < 1 ? `scaleX(${scale.toFixed(3)})` : "";
  });
}

function renderLabels() {
  drawn.forEach((block, i) => {
    const node = blockEls[i];
    if (!node) return;
    const none = block.chord.root === null;
    const label = none ? "" : symbolOf(block.chord);
    const text = node.firstChild;
    if (text.textContent !== label) text.textContent = label;
    const aria = none
      ? t("chords.gapAria", { time: clock(block.start) })
      : t("chords.blockAria", { chord: symbolOf(block.chord, true), time: clock(block.start) });
    node.setAttribute("aria-label", aria);
    node.title = none ? (editing ? t("chords.gapTitle") : "") : t(editing ? "chords.blockEditTitle" : "chords.blockTitle", { chord: label });
  });
  layoutLabels();
}

function renderBlocks() {
  if (!els) return;
  closePopover();
  drawn = blocks(entries, { bass: showBass });
  blockEls = drawn.map((block, i) => {
    const none = block.chord.root === null;
    const node = el("button", none ? "chord-block none" : "chord-block");
    node.type = "button";
    node.dataset.index = String(i);
    // One stop on the way through the page: the arrow keys walk the chords.
    node.tabIndex = -1;
    // A gap does nothing outside Edit, where it can be given a chord.
    node.disabled = none && !editing;
    const where = placement(block, song.duration);
    node.style.left = `${where.left.toFixed(4)}%`;
    node.style.width = `${where.width.toFixed(4)}%`;
    node.append(el("span", "chord-block-label"));
    return node;
  });
  const firstStop = blockEls.find((node) => !node.disabled);
  if (firstStop) firstStop.tabIndex = 0;
  playheadEl = el("div", "chords-playhead");
  playheadEl.setAttribute("aria-hidden", "true");
  playheadEl.append(el("i"));
  els.track.replaceChildren(...blockEls, playheadEl);
  // Where the waveform is scrolled to now; transport.js keeps it in step.
  const wave = document.getElementById("wave-scroll");
  els.track.style.transform = `translateX(${-(wave?.scrollLeft || 0)}px)`;
  currentIndex = -1;
  lastTime = -1;
  lastPitch = pitch();
  renderLabels();
}

function render() {
  renderButtons();
  renderBlocks();
  renderNote();
  follow();
}

// ─── Following playback ───────────────────────────────────

function tick() {
  frame = requestAnimationFrame(tick);
  if (!els || els.ribbon.hidden || !drawn.length) return;
  // The key the player is in: the chords are respelled when it moves.
  const now = pitch();
  if (now !== lastPitch) {
    lastPitch = now;
    renderLabels();
  }
  const time = transport()?.getCurrentTime?.() ?? 0;
  if (time === lastTime) return;
  lastTime = time;
  const index = indexAt(drawn, time);
  if (index !== currentIndex) {
    blockEls[currentIndex]?.classList.remove("current");
    currentIndex = index;
    blockEls[currentIndex]?.classList.add("current");
  }
  if (playheadEl) {
    const pct = Math.max(0, Math.min(100, (time / Math.max(0.001, song.duration)) * 100));
    playheadEl.style.transform = `translateX(${pct}%)`;
  }
}

/** Run the frame loop only while there is something on screen to move. */
function follow() {
  cancelAnimationFrame(frame);
  frame = 0;
  if (els && !els.ribbon.hidden && drawn.length) frame = requestAnimationFrame(tick);
}

// ─── Reading the song's chords ────────────────────────────

function forget() {
  entries = [];
  beats = [];
  edited = false;
  hasDetected = false;
}

/** Fetch the timeline of song `id`. True when the answer was for the song
 * that is still open. */
async function loadTimeline(id, my) {
  let res;
  try {
    res = await fetch(`/api/jobs/${id}/chords`);
  } catch (e) {
    console.warn("[chords] could not read the chords:", e);
    return id === jobId && my === token;
  }
  let body = null;
  if (res.ok) body = await res.json().catch(() => null);
  if (id !== jobId || my !== token) return false;
  if (!body) {
    forget();
    knownChords = false;
    return true;
  }
  entries = cleanTimeline(body.chords);
  beats = Array.isArray(body.beats) ? body.beats.filter((b) => Number.isFinite(b)) : [];
  edited = Boolean(body.edited);
  hasDetected = Boolean(body.has_detected);
  knownChords = entries.length > 0;
  if (Number(body.duration) > 0 && !(song.duration > 0)) song.duration = Number(body.duration);
  return true;
}

async function loadState(id) {
  try {
    const res = await fetch(`/api/jobs/${id}`);
    return res.ok ? await res.json() : null;
  } catch (e) {
    console.warn("[chords] could not read the song's state:", e);
    return null;
  }
}

/** Everything about the open song, from the server. */
async function load() {
  const id = jobId;
  const my = token;
  if (!id) return;
  await loadConfig();
  if (id !== jobId || my !== token) return;
  // Switched off, and this install can detect: nothing to fetch until the
  // button is pressed. One that cannot detect still has to find out whether
  // the song brought chords, to know if the button is worth showing.
  if (!on && available()) {
    render();
    return;
  }
  const [state] = await Promise.all([on ? loadState(id) : null, loadTimeline(id, my)]);
  if (id !== jobId || my !== token) return;
  if (state) {
    if (typeof state.key === "string") song.key = state.key;
    if (Number(state.duration) > 0) song.duration = Number(state.duration);
    if (state.chords === "running") {
      watching = true;
      setRunning(true);
      showProgress(state.chords_progress);
      startPolling(id, my);
    } else if (state.chords === "error" && !entries.length) {
      // Why the song has none, when the last try did not finish.
      note = { key: reasonKey(state.chords_reason), problem: state.chords_reason !== "cancelled" };
    }
  }
  render();
}

// ─── Detecting ────────────────────────────────────────────

function setRunning(next) {
  running = next;
  if (running) {
    editing = false;
    closePopover();
  }
}

function showProgress(progress) {
  const percent = progress?.percent;
  if (progress?.phase === "downloading" && Number.isInteger(percent) && percent > 0) {
    setNote({ key: "chords.progress.downloadingPercent", vars: { n: percent } });
  } else if (progress?.phase === "detecting" && Number.isInteger(percent) && percent > 0) {
    setNote({ key: "chords.progress.detectingPercent", vars: { n: percent } });
  } else {
    setNote({ key: phaseKey(progress) });
  }
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function startPolling(id, my) {
  stopPolling();
  const poll = async () => {
    const state = await loadState(id);
    if (id !== jobId || my !== token || !running) return;
    if (state?.chords === "running") {
      showProgress(state.chords_progress);
    } else if (state && watching) {
      // A run nobody here is waiting on has ended.
      await finish(id, my, {
        ok: state.chords === "done",
        reason: state.chords_reason,
        found: true,
        edited: null,
      });
      return;
    }
    pollTimer = setTimeout(poll, POLL_MS);
  };
  pollTimer = setTimeout(poll, POLL_MS);
}

/** A run on song `id` is over: show what it left. */
async function finish(id, my, outcome) {
  stopPolling();
  watching = false;
  setRunning(false);
  if (outcome.ok) {
    if (!(await loadTimeline(id, my))) return;
    if (!entries.some((e) => e.root !== null) || outcome.found === false) {
      note = { key: "chords.noneFound", problem: true };
    } else if (outcome.edited ?? edited) {
      // The new detection is behind the corrections, which are still shown.
      note = { key: "chords.correctionsKept" };
    } else {
      note = null;
    }
  } else if (outcome.busy) {
    note = { key: "chords.busy", problem: true };
  } else {
    note = { key: reasonKey(outcome.reason), problem: outcome.reason !== "cancelled" };
  }
  render();
}

async function detect() {
  if (!jobId || running) return;
  const id = jobId;
  const my = token;
  // A correction still on its way is saved first, so the run's answer about
  // corrections is true.
  await flushChordsSave();
  if (id !== jobId || my !== token || running) return;
  watching = false;
  setRunning(true);
  note = { key: "chords.progress.starting" };
  render();
  startPolling(id, my);

  let res = null;
  let body = null;
  try {
    res = await fetch(`/api/jobs/${id}/chords`, { method: "POST" });
    body = await res.json().catch(() => null);
  } catch (e) {
    // The request was lost, not the run: the poll sees how it ends.
    console.warn("[chords] lost the request that started detection:", e);
    if (id === jobId && my === token) watching = true;
    return;
  }
  if (id !== jobId || my !== token) return;
  await finish(id, my, {
    ok: res.ok,
    reason: body?.chords_reason,
    busy: res.status === 409 && !body?.chords_reason,
    found: body?.chords_found,
    edited: body?.chords_edited,
  });
}

async function cancel() {
  if (!jobId || !running) return;
  els.cancel.disabled = true;
  try {
    await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
  } catch (e) {
    console.warn("[chords] cancel failed:", e);
  } finally {
    els.cancel.disabled = false;
  }
}

// ─── Saving corrections ───────────────────────────────────

function indicator(text, cls) {
  const node = els?.saved;
  if (!node) return;
  clearTimeout(savedTimer);
  node.textContent = text;
  node.className = `sections-save-indicator${cls ? ` ${cls}` : ""}`;
}

function hideIndicator(after = 0) {
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    if (els?.saved) els.saved.className = "sections-save-indicator hidden";
  }, after);
}

async function sendSave(id, body) {
  try {
    const res = await fetch(`/api/jobs/${id}/chords`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (id === jobId && saveTimer === null) {
      indicator(t("sections.saved"), "saved");
      hideIndicator(1800);
    }
  } catch (e) {
    console.warn("[chords] save failed:", e);
    if (id === jobId) {
      hideIndicator();
      setNote({ key: "chords.saveFailed", problem: true });
    }
  }
}

function queueSave() {
  saveTimer = null;
  const id = jobId;
  if (!id) return;
  const list = payload(entries);
  if (!isValidTimeline(list)) {
    console.warn("[chords] not saving a timeline the server would refuse");
    hideIndicator();
    return;
  }
  const body = JSON.stringify({ chords: list });
  saveChain = saveChain.then(() => sendSave(id, body));
}

function scheduleSave() {
  clearTimeout(saveTimer);
  indicator(t("sections.saving"));
  saveTimer = setTimeout(queueSave, SAVE_DELAY_MS);
}

/** Send a correction that is still waiting, and resolve when every save so
 * far has been answered. Called before the song changes and before a run. */
export function flushChordsSave() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    queueSave();
  }
  return saveChain;
}

function applyCorrection(next) {
  if (next === entries) return false;
  entries = next;
  edited = true;
  knownChords = entries.length > 0;
  // What was said about the last run is about a timeline that has changed.
  note = null;
  scheduleSave();
  renderButtons();
  renderBlocks();
  renderNote();
  return true;
}

function disarmReset() {
  clearTimeout(resetTimer);
  resetTimer = null;
  if (!els) return;
  els.reset.classList.remove("armed");
  els.resetLabel.hidden = true;
}

async function reset() {
  if (!jobId || running) return;
  // Every correction at once, with no way back: the first click asks.
  if (resetTimer === null) {
    els.reset.classList.add("armed");
    els.resetLabel.hidden = false;
    resetTimer = setTimeout(disarmReset, RESET_ARM_MS);
    return;
  }
  disarmReset();
  const id = jobId;
  const my = token;
  closePopover();
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveChain;
  try {
    const res = await fetch(`/api/jobs/${id}/chords`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.warn("[chords] reset failed:", e);
    if (id === jobId && my === token) setNote({ key: "chords.saveFailed", problem: true });
    return;
  }
  if (!(await loadTimeline(id, my))) return;
  note = null;
  editing = editing && entries.length > 0;
  render();
}

// ─── The correction popover ───────────────────────────────

function buildPopover() {
  const root = el("div", "chords-popover");
  root.id = "chordsPopover";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  const form = el("form");
  form.noValidate = true;
  const label = el("label", "chords-pop-label");
  label.htmlFor = "chordsPopInput";
  const row = el("div", "chords-pop-row");
  const input = el("input", "chords-pop-input");
  input.id = "chordsPopInput";
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = 32;
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("aria-describedby", "chordsPopError chordsPopHint");
  const set = el("button", "chords-pop-btn primary");
  set.type = "submit";
  row.append(input, set);
  const error = el("p", "chords-pop-error");
  error.id = "chordsPopError";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const hint = el("p", "chords-pop-hint");
  hint.id = "chordsPopHint";
  const actions = el("div", "chords-pop-row chords-pop-actions");
  const make = (act, cls = "") => {
    const b = el("button", `chords-pop-btn${cls}`);
    b.type = "button";
    b.dataset.act = act;
    actions.append(b);
    return b;
  };
  const earlier = make("earlier");
  const later = make("later");
  const none = make("none");
  const remove = make("delete", " danger");
  form.append(label, row, error, hint, actions);
  root.append(form);
  document.body.append(root);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitSymbol();
  });
  input.addEventListener("input", () => showPopError(null));
  actions.addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act) popAction(act);
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      const back = blockEls[popIndex];
      closePopover();
      back?.focus();
    }
    // The player's shortcuts (space, the digits, the arrows) are not for a
    // text field.
    e.stopPropagation();
  });
  pop = { root, label, input, set, error, hint, earlier, later, none, remove };
  labelPopover();
}

function labelPopover() {
  if (!pop) return;
  pop.root.setAttribute("aria-label", t("chords.pop.title"));
  pop.label.textContent = t("chords.pop.label");
  pop.input.placeholder = t("chords.pop.placeholder");
  pop.set.textContent = t("chords.pop.set");
  pop.hint.textContent = t(beats.length >= 2 ? "chords.pop.hint" : "chords.pop.hintNoGrid");
  pop.earlier.textContent = t("chords.pop.earlier");
  pop.later.textContent = t("chords.pop.later");
  pop.none.textContent = t("chords.pop.none");
  pop.remove.textContent = t("chords.pop.delete");
}

function showPopError(key) {
  if (!pop) return;
  pop.error.hidden = !key;
  pop.error.textContent = key ? t(key) : "";
  pop.input.setAttribute("aria-invalid", String(Boolean(key)));
}

function placePopover(anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = pop.root.offsetWidth || 300;
  const height = pop.root.offsetHeight || 150;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
  pop.root.style.left = `${Math.round(left)}px`;
  pop.root.style.top = `${Math.round(top)}px`;
}

function openPopover(index) {
  const block = drawn[index];
  const anchor = blockEls[index];
  if (!block || !anchor) return;
  if (!pop) buildPopover();
  blockEls[popIndex]?.classList.remove("selected");
  popIndex = index;
  anchor.classList.add("selected");
  labelPopover();
  showPopError(null);
  // The bass note is always in the field, hidden on the strip or not: what
  // is typed is the whole chord.
  pop.input.value = block.chord.root === null ? "" : symbolOf(block.chord, true);
  pop.none.disabled = block.chord.root === null;
  pop.root.hidden = false;
  placePopover(anchor);
  pop.input.focus();
  pop.input.select();
}

function closePopover() {
  if (!pop || pop.root.hidden) return;
  pop.root.hidden = true;
  blockEls[popIndex]?.classList.remove("selected");
  popIndex = -1;
}

function submitSymbol() {
  const block = drawn[popIndex];
  if (!block) return;
  const parsed = parseSymbol(pop.input.value);
  if (!parsed) {
    showPopError("chords.pop.unreadable");
    pop.input.focus();
    return;
  }
  const at = block.start;
  // Typed in the key being heard; stored in the song's own.
  const chord = fromDisplayed(parsed, pitch());
  applyCorrection(setChord(entries, block.first, block.last, chord));
  refocus(at);
}

function popAction(act) {
  const block = drawn[popIndex];
  if (!block) return;
  if (act === "none") {
    const at = block.start;
    applyCorrection(clearChord(entries, block.first, block.last));
    refocus(at);
    return;
  }
  if (act === "delete") {
    const at = block.start;
    applyCorrection(removeChord(entries, block.first, block.last));
    refocus(Math.max(0, at - 1e-3));
    return;
  }
  // A start moved: the popover stays on the chord, to move it again.
  const result = moveStart(entries, block.first, act === "earlier" ? -1 : 1, beats);
  if (!result.moved) {
    showPopError("chords.pop.cannotMove");
    return;
  }
  // The chord is the one that still ends where it ended.
  const inside = block.end - 1e-3;
  applyCorrection(result.entries);
  const index = indexAt(drawn, inside);
  if (index >= 0) openPopover(index);
}

/** After a correction redrew the strip: focus the block at `time`. */
function refocus(time) {
  const index = indexAt(drawn, time);
  const node = blockEls[index >= 0 ? index : 0];
  if (node && !node.disabled) node.focus();
}

// ─── Wiring ───────────────────────────────────────────────

function onTrackClick(e) {
  const node = e.target.closest(".chord-block");
  if (!node || node.disabled) return;
  const index = Number(node.dataset.index);
  const block = drawn[index];
  if (!block) return;
  if (editing) {
    if (popIndex === index && pop && !pop.root.hidden) closePopover();
    else openPopover(index);
    return;
  }
  if (block.chord.root === null) return;
  setPlayheadTime(block.start);
  // A click with the mouse should not leave the block holding the keys.
  if (e.detail > 0) node.blur();
}

function onTrackKey(e) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const node = e.target.closest(".chord-block");
  if (!node) return;
  const step = e.key === "ArrowLeft" ? -1 : 1;
  for (let i = Number(node.dataset.index) + step; i >= 0 && i < blockEls.length; i += step) {
    if (!blockEls[i].disabled) {
      e.preventDefault();
      e.stopPropagation();
      blockEls[i].focus();
      return;
    }
  }
}

function toggleOn() {
  on = !on;
  writeFlag(ON_KEY, on);
  if (!on) {
    editing = false;
    closePopover();
    renderButtons();
    follow();
    return;
  }
  // Fetched on the first press, not before.
  token += 1;
  renderButtons();
  load();
}

function wire() {
  els.rail.addEventListener("click", toggleOn);
  els.bass.addEventListener("click", () => {
    showBass = !showBass;
    writeFlag(BASS_KEY, showBass);
    renderButtons();
    renderBlocks();
  });
  els.edit.addEventListener("click", () => {
    editing = !editing;
    renderButtons();
    renderBlocks();
  });
  els.detect.addEventListener("click", detect);
  els.cancel.addEventListener("click", cancel);
  els.reset.addEventListener("click", reset);
  els.track.addEventListener("click", onTrackClick);
  els.track.addEventListener("keydown", onTrackKey);

  // The popover is fixed to the window: anything that moves the chord under
  // it puts it away.
  document.addEventListener("pointerdown", (e) => {
    if (!pop || pop.root.hidden) return;
    if (pop.root.contains(e.target) || e.target.closest?.(".chord-block")) return;
    closePopover();
  });
  document.getElementById("wave-scroll")?.addEventListener("scroll", closePopover, { passive: true });
  window.addEventListener("resize", closePopover);
  // The track is the zoomed waveform's width: at another zoom, or when the
  // strip is first shown, a different set of symbols fits.
  if (typeof ResizeObserver === "function") new ResizeObserver(layoutLabels).observe(els.track);
  // Measured with the fallback font if the page's own was still loading.
  document.fonts?.ready?.then(() => {
    measured.clear();
    layoutLabels();
  });

  onLanguageChange(() => {
    labelPopover();
    renderButtons();
    renderLabels();
    renderNote();
  });
}

/** Find the strip in the page and wire it. Called once, from main.js. */
export function initChordStrip() {
  const byId = (id) => document.getElementById(id);
  const found = {
    rail: byId("t-chords-btn"),
    ribbon: byId("chordStrip"),
    area: byId("daw-chords"),
    track: byId("daw-chords-track"),
    note: byId("chordsNote"),
    saved: byId("chordsSaveIndicator"),
    bass: byId("chordsBassBtn"),
    edit: byId("chordsEditBtn"),
    reset: byId("chordsResetBtn"),
    resetLabel: document.querySelector("#chordsResetBtn .chords-reset-label"),
    detect: byId("chordsDetectBtn"),
    cancel: byId("chordsCancelBtn"),
  };
  if (Object.values(found).some((node) => !node)) return;
  els = found;
  on = readFlag(ON_KEY);
  showBass = readFlag(BASS_KEY);
  wire();
  render();
  // A song opened before the strip was found in the page.
  if (jobId) load();
  else {
    loadConfig().then(() => {
      renderButtons();
      renderNote();
    });
  }
}

/**
 * A song was opened in the player. `info` is what the caller already knows:
 * `key` as analysis stored it and `duration` in seconds.
 */
export function openChordStrip(id, info = {}) {
  // A correction to the last song is sent before the strip lets go of it.
  flushChordsSave();
  stopPolling();
  disarmReset();
  closePopover();
  token += 1;
  jobId = typeof id === "string" && id ? id : null;
  song = { key: typeof info.key === "string" ? info.key : null, duration: Number(info.duration) || 0 };
  forget();
  knownChords = false;
  running = false;
  watching = false;
  editing = false;
  note = null;
  if (!els) return;
  render();
  if (jobId) load();
}

/** The song was closed. */
export function closeChordStrip() {
  openChordStrip(null);
}
