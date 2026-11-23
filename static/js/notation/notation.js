// The Notation view (openspec change add-alphatab-notation): the song's
// transcribed stems as sheet music, with tablature for guitar and bass, in a
// drawer under the lanes.
//
// Opened from the footer's Notation chip, in Practice and Advanced. Karaoke
// and Performance own the whole window, so opening either closes it.
//
// The drawer owns no audio and no notes. Every time it shows a score it asks
// the server for one (GET /api/jobs/{id}/transcription.alphatex), which is
// worked out there from the stored notes, the current beat grid and the
// current tuning. So a corrected grid, a stem transcribed again or a new
// tuning is simply what the next request returns: nothing here can go stale.
//
// StemDeck's player is the only clock. While the drawer is open a frame loop
// reads where the song is and hands it to alphaTab (alphatabBridge.js), which
// moves its cursor there. Speed changes and loop jumps are just positions. A
// click on the score asks the player to seek; the view never plays anything.
//
// What is remembered: which stems are ticked, the resolution and the zoom,
// per song, in the browser's store (as the song's other view state is).
// Tuning, capo and staff-or-tab go to the server instead, because the
// downloads depend on them (PATCH /api/jobs/{id}/transcription/tab).

import { t, onLanguageChange } from "../i18n.js";
import { storeGet, storeSet } from "../utils.js";
import { currentJobId, totalDuration } from "../state.js";
import { transport, setPlayheadTime } from "../transport.js";
import { triggerDownload } from "../player.js";
import { toggleBeatGridEditor } from "../beatgridUi.js";
import { openTranscribeDialog, transcriptionConfig } from "../transcribe.js";
import { createScoreView, guitarProBytes, ScoreError } from "./alphatabBridge.js";
import {
  TAB_STEMS, ZOOMS, DRAWER_MIN_PX, DRAWER_DEFAULT_PX, HEIGHT_KEY,
  prefsKey, cleanPrefs, availableStems, shownStems, withStem, scoreUrl, downloadUrls,
  stepZoom, emptyState, unplacedNotes, tuningText, parseTuning,
} from "./notationCore.js";

const REFRESH_DELAY_MS = 400;
const RESIZE_STEP_PX = 24;

let drawer = null;
let chip = null;
let ui = null;
let open = false;
let config = null;

let jobId = null;
let available = [];
let prefs = cleanPrefs(null);
let info = null; // the last score response
let tabOptions = null; // GET .../transcription/tab: the tunings on offer
let view = null; // alphatabBridge's score view
let viewFor = null; // the host element `view` was made for
let token = 0; // bumps on every refresh; a stale answer is dropped
let frame = 0;
let shownBar = -2;
let refreshTimer = null;

const inDesktop = () => Boolean(window.__TAURI__?.core?.invoke);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function stemLabel(name) {
  const key = `stem.${name}`;
  const label = t(key);
  return label === key ? name : label;
}

function tuningLabel(preset) {
  const key = `notation.tuning.${preset}`;
  const label = t(key);
  return label === key ? preset : label;
}

// ─── Building the drawer ───

function build() {
  const resize = el("div", "notation-resize");
  resize.setAttribute("role", "separator");
  resize.setAttribute("aria-orientation", "horizontal");
  resize.tabIndex = 0;

  const bar = el("div", "notation-bar");
  bar.setAttribute("role", "toolbar");
  const title = el("span", "notation-title");
  const barNo = el("span", "notation-barno num");
  barNo.id = "notationBar";
  const stems = el("div", "notation-stems");
  stems.id = "notationStems";
  stems.setAttribute("role", "group");

  const partsField = el("label", "notation-field");
  const partsLabel = el("span");
  const parts = el("select", "notation-select");
  parts.id = "notationParts";
  partsField.append(partsLabel, parts);

  // Follow: whether the score scrolls with the song, or stays where the
  // reader put it. A switch the size of a zoom button: the row is full.
  const follow = el("button", "notation-btn notation-zoom-btn notation-follow");
  follow.type = "button";
  follow.id = "notationFollow";
  follow.setAttribute("role", "switch");
  follow.setAttribute("aria-checked", "true");
  // A target: the place the song is at, kept in sight.
  follow.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/></svg>';

  const zoom = el("div", "notation-zoom");
  zoom.setAttribute("role", "group");
  const zoomOut = el("button", "notation-btn notation-zoom-btn", "−");
  zoomOut.type = "button";
  zoomOut.id = "notationZoomOut";
  const zoomValue = el("output", "notation-zoom-value num");
  zoomValue.id = "notationZoomValue";
  const zoomIn = el("button", "notation-btn notation-zoom-btn", "+");
  zoomIn.type = "button";
  zoomIn.id = "notationZoomIn";
  zoom.append(zoomOut, zoomValue, zoomIn);

  // The downloads, behind one button: a <details>, so it opens and closes
  // from the keyboard with no code of its own.
  const downloads = el("details", "notation-downloads");
  downloads.id = "notationDownloads";
  const downloadsLabel = el("summary", "notation-btn notation-downloads-btn");
  const menu = el("div", "notation-menu");
  const link = (id) => {
    const a = el("a", "notation-menu-item notation-download");
    a.id = id;
    return a;
  };
  const midiPlayed = link("notationMidiPlayed");
  const midiQuantised = link("notationMidiQuantised");
  const musicxml = link("notationMusicxml");
  const guitarPro = el("button", "notation-menu-item notation-download");
  guitarPro.type = "button";
  guitarPro.id = "notationGuitarPro";
  menu.append(midiPlayed, midiQuantised, musicxml, guitarPro);
  downloads.append(downloadsLabel, menu);
  menu.addEventListener("click", (e) => {
    if (e.target.closest(".notation-menu-item")) downloads.open = false;
  });
  document.addEventListener("pointerdown", (e) => {
    if (downloads.open && !downloads.contains(e.target)) downloads.open = false;
  });
  // The menu hangs from the button's right edge, unless that would push it
  // out of the drawer: in a narrow window the button wraps to the left.
  downloads.addEventListener("toggle", () => {
    if (!downloads.open) return;
    menu.classList.remove("from-left");
    const room = downloads.getBoundingClientRect().right - drawer.getBoundingClientRect().left;
    menu.classList.toggle("from-left", room < menu.offsetWidth + 8);
  });

  const close = el("button", "notation-close");
  close.type = "button";
  close.id = "notationClose";
  close.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  // Follow sits with the zoom: the two say how the score is looked at.
  const look = el("div", "notation-look");
  look.append(follow, zoom);
  bar.append(title, barNo, stems, el("div", "notation-spacer"), partsField, look, downloads, close);

  // Second row: how the fretted stems on show are drawn.
  const tabs = el("div", "notation-tabs");
  tabs.id = "notationTabs";
  const notices = el("div", "notation-notices");
  notices.id = "notationNotices";
  notices.setAttribute("role", "status");

  const body = el("div", "notation-body");
  const scroll = el("div", "notation-scroll");
  scroll.id = "notationScroll";
  const score = el("div", "notation-score");
  score.id = "notationScore";
  scroll.append(score);
  const empty = el("div", "notation-empty");
  empty.id = "notationEmpty";
  const emptyText = el("p", "notation-empty-text");
  const emptyAction = el("button", "about-link about-link-primary notation-empty-action");
  emptyAction.type = "button";
  const emptyLink = el("a", "about-link about-link-secondary notation-empty-action");
  empty.append(emptyText, emptyAction, emptyLink);
  const busy = el("div", "notation-busy");
  busy.id = "notationBusy";
  busy.setAttribute("role", "status");
  body.append(scroll, empty, busy);

  const foot = el("p", "notation-foot");
  foot.id = "notationFoot";

  drawer.replaceChildren(resize, bar, tabs, notices, body, foot);
  ui = {
    resize, title, barNo, stems, follow,
    partsLabel, parts, zoomOut, zoomValue, zoomIn,
    downloads, downloadsLabel, midiPlayed, midiQuantised, musicxml, guitarPro, close,
    tabs, notices, scroll, score, empty, emptyText, emptyAction, emptyLink, busy, foot,
  };

  for (const value of config?.quantize_parts || [1, 2, 3, 4, 6, 8]) {
    const option = el("option");
    option.value = String(value);
    parts.append(option);
  }

  close.addEventListener("click", () => { setOpen(false); chip?.focus(); });
  parts.addEventListener("change", () => {
    prefs = { ...prefs, parts: Number(parts.value) };
    savePrefs();
    refresh();
  });
  follow.addEventListener("click", () => setFollow(!prefs.follow));
  zoomOut.addEventListener("click", () => setZoom(stepZoom(prefs.zoom, -1)));
  zoomIn.addEventListener("click", () => setZoom(stepZoom(prefs.zoom, 1)));
  guitarPro.addEventListener("click", downloadGuitarPro);
  for (const a of [midiPlayed, midiQuantised, musicxml]) {
    a.addEventListener("click", (e) => {
      if (a.getAttribute("aria-disabled") === "true") { e.preventDefault(); return; }
      // The desktop shell saves a download itself, through its own dialog.
      if (!inDesktop()) return;
      e.preventDefault();
      Promise.resolve(triggerDownload(a.getAttribute("href"), a.download))
        .catch((err) => console.warn("[notation] download failed:", err));
    });
  }
  wireResize(resize);
  // Keys typed in the drawer are the drawer's: Space must not start playback
  // from a field, Delete must not move the song to the Trash.
  drawer.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && downloads.open) {
      downloads.open = false;
      downloadsLabel.focus();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape") { setOpen(false); chip?.focus(); return; }
    const control = e.target?.closest?.("button, input, select, a, summary");
    if (e.key === "Delete" || e.key === "Backspace" || (control && (e.code === "Space" || e.key === "Enter"))) {
      e.stopPropagation();
    }
  });
  relabel();
}

function relabel() {
  if (chip) {
    chip.title = t("notation.chipTitle");
    chip.setAttribute("aria-label", t("notation.title"));
  }
  if (!ui) return;
  drawer.setAttribute("aria-label", t("notation.title"));
  ui.resize.setAttribute("aria-label", t("notation.resize"));
  ui.resize.title = t("notation.resize");
  ui.title.textContent = t("notation.title");
  ui.stems.setAttribute("aria-label", t("notation.stemsAria"));
  ui.partsLabel.textContent = t("transcribe.resolution");
  for (const option of ui.parts.options) option.textContent = t(`transcribe.parts.${option.value}`);
  ui.follow.setAttribute("aria-label", t("notation.follow"));
  ui.follow.title = t("notation.followTitle");
  ui.zoomOut.title = t("notation.zoomOut");
  ui.zoomOut.setAttribute("aria-label", t("notation.zoomOut"));
  ui.zoomIn.title = t("notation.zoomIn");
  ui.zoomIn.setAttribute("aria-label", t("notation.zoomIn"));
  ui.zoomValue.parentElement.setAttribute("aria-label", t("notation.zoomAria"));
  ui.downloadsLabel.textContent = t("notation.downloads");
  ui.midiPlayed.textContent = t("transcribe.midiPlayed");
  ui.midiQuantised.textContent = t("transcribe.midiQuantised");
  ui.musicxml.textContent = t("transcribe.musicxml");
  ui.guitarPro.textContent = t("notation.guitarPro");
  ui.guitarPro.title = t("notation.guitarProTitle");
  ui.close.title = t("notation.close");
  ui.close.setAttribute("aria-label", t("notation.close"));
  ui.busy.textContent = t("notation.loading");
  shownBar = -2;
}

// ─── The drawer's height ───

/** The height a drawer never resized opens at: most of half the window. */
function defaultHeight() {
  return Math.max(DRAWER_DEFAULT_PX, Math.round(window.innerHeight * 0.44));
}

function clampHeight(px) {
  const max = Math.max(DRAWER_MIN_PX, Math.round(window.innerHeight * 0.7));
  return Math.round(Math.min(max, Math.max(DRAWER_MIN_PX, px)));
}

function applyHeight(px, { save = false } = {}) {
  const height = clampHeight(px);
  drawer.style.setProperty("--notation-drawer-h", `${height}px`);
  ui?.resize.setAttribute("aria-valuenow", String(height));
  if (save) storeSet(HEIGHT_KEY, height);
  return height;
}

function wireResize(handle) {
  let startY = 0;
  let startH = 0;
  const move = (e) => applyHeight(startH + (startY - e.clientY));
  const up = (e) => {
    handle.releasePointerCapture?.(e.pointerId);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    applyHeight(drawer.getBoundingClientRect().height, { save: true });
  };
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startY = e.clientY;
    startH = drawer.getBoundingClientRect().height;
    handle.setPointerCapture?.(e.pointerId);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("keydown", (e) => {
    const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    applyHeight(drawer.getBoundingClientRect().height + dir * RESIZE_STEP_PX, { save: true });
  });
}

// ─── What the song remembers ───

function savePrefs() {
  if (jobId) storeSet(prefsKey(jobId), prefs);
}

function setFollow(next) {
  prefs = { ...prefs, follow: Boolean(next) };
  savePrefs();
  paintFollow();
  view?.setFollow(prefs.follow);
}

function paintFollow() {
  ui.follow.setAttribute("aria-checked", String(prefs.follow));
}

function setZoom(next) {
  if (next === prefs.zoom) return;
  prefs = { ...prefs, zoom: next };
  savePrefs();
  paintZoom();
  view?.setZoom(next);
}

function paintZoom() {
  ui.zoomValue.textContent = `${Math.round(prefs.zoom * 100)}%`;
  ui.zoomOut.disabled = prefs.zoom <= ZOOMS[0];
  ui.zoomIn.disabled = prefs.zoom >= ZOOMS[ZOOMS.length - 1];
}

// ─── Painting ───

function paintStems() {
  const shown = new Set(shownStems(available, prefs));
  ui.stems.replaceChildren();
  for (const name of available) {
    const row = el("label", "notation-stem");
    row.dataset.stem = name;
    const box = el("input");
    box.type = "checkbox";
    box.checked = shown.has(name);
    box.addEventListener("change", () => {
      prefs = withStem(available, prefs, name, box.checked);
      savePrefs();
      refresh();
    });
    row.append(box, el("span", "notation-stem-name", stemLabel(name)));
    ui.stems.append(row);
  }
  ui.stems.hidden = !available.length;
}

function paintDownloads(shown) {
  const hasScore = Boolean(info && shown.length);
  ui.downloads.hidden = !shown.length;
  if (!shown.length) { ui.downloads.open = false; return; }
  const urls = downloadUrls(jobId, shown, prefs.parts);
  const names = info?.file_names || {};
  const set = (a, href, name, enabled) => {
    a.classList.toggle("is-disabled", !enabled);
    a.setAttribute("aria-disabled", String(!enabled));
    a.tabIndex = enabled ? 0 : -1;
    if (enabled) {
      a.href = href;
      a.download = name || "";
    } else {
      a.removeAttribute("href");
    }
  };
  // The as-played MIDI needs no beat grid, so it is offered even when the
  // score cannot be drawn. Without a score its name is the server's to give.
  set(ui.midiPlayed, urls.midiPlayed, names.midi_played, true);
  set(ui.midiQuantised, urls.midiQuantised, names.midi_quantised, hasScore);
  set(ui.musicxml, urls.musicxml, names.musicxml, hasScore);
  ui.guitarPro.disabled = !hasScore;
}

function option(value, label, selected = false) {
  const node = el("option", null, label);
  node.value = value;
  node.selected = selected;
  return node;
}

function paintTabs() {
  ui.tabs.replaceChildren();
  const drawn = TAB_STEMS.filter((stem) => info?.tab?.[stem]);
  ui.tabs.hidden = !drawn.length;
  for (const stem of drawn) {
    const facts = info.tab[stem];
    const name = stemLabel(stem);
    const row = el("div", "notation-tab");
    row.dataset.stem = stem;
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", name);
    row.append(el("span", "notation-tab-name", name));

    const display = el("select", "notation-select notation-tab-display");
    display.setAttribute("aria-label", t("notation.tab.display", { stem: name }));
    for (const kind of tabOptions?.displays || ["score", "tab", "both"]) {
      display.append(option(kind, t(`notation.tab.${kind}`), kind === facts.display));
    }
    display.addEventListener("change", () => saveTab(stem, { display: display.value }));

    const tuning = el("select", "notation-select notation-tab-tuning");
    tuning.setAttribute("aria-label", t("notation.tab.tuning", { stem: name }));
    const presets = tabOptions?.presets?.[stem] || {};
    for (const preset of Object.keys(presets)) {
      tuning.append(option(preset, tuningLabel(preset), preset === facts.preset));
    }
    tuning.append(option("custom", t("notation.tab.custom"), facts.preset === "custom"));

    const custom = el("input", "notation-tab-custom");
    custom.type = "text";
    custom.spellcheck = false;
    custom.autocomplete = "off";
    custom.placeholder = "D2 A2 D3 G3 A3 D4";
    custom.setAttribute("aria-label", t("notation.tab.customAria", { stem: name }));
    custom.value = tuningText(facts.tuning);
    custom.hidden = facts.preset !== "custom";
    const strings = el("span", "notation-tab-strings num", tuningText(facts.tuning));
    strings.hidden = facts.preset === "custom";

    const limits = tabOptions?.custom || {};
    const range = { min: limits.min_strings || 4, max: limits.max_strings || 8 };
    const commitCustom = () => {
      const typed = parseTuning(custom.value, range);
      if (!typed) {
        custom.setAttribute("aria-invalid", "true");
        showTabError(t("notation.tab.customInvalid", range));
        return;
      }
      custom.removeAttribute("aria-invalid");
      saveTab(stem, { tuning: typed });
    };
    tuning.addEventListener("change", () => {
      if (tuning.value === "custom") {
        custom.hidden = false;
        strings.hidden = true;
        custom.focus();
        custom.select();
      } else {
        saveTab(stem, { preset: tuning.value });
      }
    });
    custom.addEventListener("change", commitCustom);
    custom.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commitCustom(); } });

    const capoField = el("label", "notation-field");
    const capo = el("input", "notation-tab-capo");
    capo.type = "number";
    capo.min = "0";
    capo.max = String(tabOptions?.max_capo ?? 12);
    capo.step = "1";
    capo.value = String(facts.capo);
    capo.setAttribute("aria-label", t("notation.tab.capoAria", { stem: name }));
    capo.addEventListener("change", () => {
      const fret = Math.round(Number(capo.value));
      const max = Number(capo.max);
      if (!Number.isFinite(fret) || fret < 0 || fret > max) { capo.value = String(facts.capo); return; }
      saveTab(stem, { capo: fret });
    });
    capoField.append(el("span", null, t("notation.tab.capo")), capo);

    row.append(display, tuning, custom, strings, capoField);
    ui.tabs.append(row);
  }
}

function showTabError(text) {
  const p = el("p", "notation-notice is-error", text);
  p.id = "notationTabError";
  p.setAttribute("role", "alert");
  document.getElementById("notationTabError")?.remove();
  ui.notices.prepend(p);
  ui.notices.hidden = false;
}

function paintNotices() {
  ui.notices.replaceChildren();
  for (const item of unplacedNotes(info?.tab)) {
    const name = stemLabel(item.stem);
    const row = el("p", "notation-notice");
    row.dataset.stem = item.stem;
    row.dataset.unplaced = String(item.count);
    const parts = [t("notation.unplaced", { stem: name, n: item.count })];
    if (item.outOfRange) parts.push(t("notation.unplaced.range", { n: item.outOfRange }));
    if (item.tooMany) parts.push(t("notation.unplaced.many", { n: item.tooMany }));
    if (item.suggestion) parts.push(t("notation.unplaced.suggest", { tuning: tuningLabel(item.suggestion) }));
    else if (item.outOfRange) parts.push(t(item.stem === "bass" ? "notation.unplaced.hintBass" : "notation.unplaced.hint"));
    row.append(el("span", "notation-notice-text", parts.join(" ")));
    if (item.suggestion) {
      const use = el("button", "notation-btn notation-use", t("notation.unplaced.use", { tuning: tuningLabel(item.suggestion) }));
      use.type = "button";
      use.dataset.preset = item.suggestion;
      use.addEventListener("click", () => saveTab(item.stem, { preset: item.suggestion }));
      row.append(use);
    }
    ui.notices.append(row);
  }
  ui.notices.hidden = !ui.notices.childElementCount;
}

function paintFoot() {
  ui.foot.replaceChildren();
  ui.foot.hidden = !info;
  if (!info) return;
  ui.foot.append(el("span", null, t("notation.foot.auto")));
  const confidence = info.grid?.confidence;
  if (typeof confidence === "number") {
    ui.foot.append(" ", el("span", "notation-foot-confidence", t("notation.foot.confidence", { n: Math.round(confidence) })));
  }
  const edit = el("button", "notation-foot-link", t("notation.foot.editGrid"));
  edit.type = "button";
  edit.id = "notationEditGrid";
  edit.addEventListener("click", () => toggleBeatGridEditor(true));
  ui.foot.append(" ", edit);
  if (info.polyphonic?.length) {
    ui.foot.append(" ", el("span", "notation-foot-held", t("notation.foot.held", { stems: info.polyphonic.map(stemLabel).join(", ") })));
  }
}

function paintBar() {
  const bar = view ? view.currentBar() : -1;
  if (bar === shownBar) return;
  shownBar = bar;
  // Read by the browser tests, and by anyone looking at the element.
  if (bar >= 0) ui.score.dataset.bar = String(bar);
  else delete ui.score.dataset.bar;
  ui.barNo.textContent = bar >= 0 ? t("notation.bar", { n: bar + 1 }) : "";
}

/** Show `kind` in place of the score, or the score when `kind` is null. */
function paintEmpty(kind) {
  drawer.dataset.state = kind || "score";
  ui.empty.hidden = !kind;
  ui.scroll.hidden = Boolean(kind);
  if (!kind) return;
  ui.emptyText.textContent = t(`notation.empty.${{
    "no-song": "noSong", untranscribed: "untranscribed", "no-grid": "noGrid", "no-stems": "noStems", failed: "failed",
  }[kind]}`);
  ui.emptyAction.hidden = true;
  ui.emptyLink.hidden = true;
  ui.emptyAction.onclick = null;
  if (kind === "untranscribed") {
    ui.emptyAction.hidden = false;
    ui.emptyAction.textContent = t("transcribe.start");
    ui.emptyAction.onclick = () => openTranscribeDialog(jobId);
  } else if (kind === "failed") {
    ui.emptyAction.hidden = false;
    ui.emptyAction.textContent = t("notation.retry");
    ui.emptyAction.onclick = () => refresh();
  } else if (kind === "no-grid") {
    // The one download that needs no beat grid.
    ui.emptyLink.hidden = false;
    ui.emptyLink.textContent = t("transcribe.midiPlayed");
    ui.emptyLink.href = ui.midiPlayed.getAttribute("href") || "#";
    ui.emptyLink.download = "";
    ui.emptyLink.onclick = (e) => {
      if (!inDesktop()) return;
      e.preventDefault();
      ui.midiPlayed.click();
    };
  }
}

function setBusy(on) {
  ui.busy.hidden = !on;
  drawer.setAttribute("aria-busy", String(on));
}

function dropView() {
  view?.destroy();
  view = null;
  viewFor = null;
  shownBar = -2;
}

// ─── Fetching and drawing ───

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
}

/**
 * Ask the server what there is and draw it. Safe to call at any time: a
 * later call wins, and an answer for a song no longer open is dropped.
 */
async function refresh() {
  if (!open || !ui) return;
  clearTimeout(refreshTimer);
  const mine = ++token;
  const id = currentJobId;
  const stale = () => mine !== token || !open;
  if (id !== jobId) {
    jobId = id;
    info = null;
    available = [];
    dropView();
  }
  if (!id) {
    info = null;
    paintStems();
    paintDownloads([]);
    paintTabs();
    paintNotices();
    paintFoot();
    paintEmpty("no-song");
    setBusy(false);
    return;
  }
  setBusy(true);
  try {
    const [job, tab, stored] = await Promise.all([
      getJson(`/api/jobs/${id}`),
      getJson(`/api/jobs/${id}/transcription/tab`),
      storeGet(prefsKey(id)),
    ]);
    if (stale()) return;
    available = availableStems(job.body?.transcription_stems);
    tabOptions = tab.ok ? tab.body : null;
    prefs = cleanPrefs(stored, {
      parts: config?.quantize_parts,
      defaultParts: config?.quantize_parts_default,
    });
    ui.parts.value = String(prefs.parts);
    paintFollow();
    view?.setFollow(prefs.follow);
    paintZoom();
    paintStems();
    const shown = shownStems(available, prefs);

    let answer = { status: 200, ok: true, body: null };
    if (available.length && shown.length) {
      answer = await getJson(scoreUrl(id, shown, prefs.parts));
      if (stale()) return;
    }
    info = answer.ok && answer.body?.alphatex ? answer.body : null;
    const kind = emptyState({
      available,
      shown,
      status: answer.status,
      reason: answer.body?.transcription_reason || null,
      failed: Boolean(available.length && shown.length && !info && answer.ok),
    });
    paintDownloads(shown);
    paintTabs();
    paintNotices();
    paintFoot();
    paintEmpty(kind);
    if (kind) {
      dropView();
      return;
    }
    await draw(stale);
  } catch (e) {
    if (stale()) return;
    console.warn("[notation] could not show the score:", e);
    info = null;
    dropView();
    paintDownloads([]);
    paintFoot();
    paintEmpty("failed");
  } finally {
    if (!stale()) setBusy(false);
  }
}

async function draw(stale) {
  if (!view || viewFor !== ui.score) {
    dropView();
    const made = await createScoreView(ui.score, {
      scrollElement: ui.scroll,
      zoom: prefs.zoom,
      follow: prefs.follow,
      duration: () => totalDuration,
      onSeek: (seconds) => setPlayheadTime(seconds),
    });
    if (stale()) { made.destroy(); return; }
    view = made;
    viewFor = ui.score;
  }
  const names = Object.fromEntries(info.stems.map((name) => [name, stemLabel(name)]));
  try {
    const counts = await view.load(info.alphatex, names);
    if (stale()) return;
    ui.score.dataset.tracks = String(counts.tracks);
    ui.score.dataset.bars = String(counts.bars);
    ui.score.dataset.warnings = String(view.diagnostics.length);
    ui.score.dataset.worker = String(view.usesWorker);
    if (view.diagnostics.length) console.warn("[notation] alphaTab warnings:", view.diagnostics);
  } catch (e) {
    if (!(e instanceof ScoreError)) throw e;
    console.warn("[notation] the score could not be read:", e.message, e.diagnostics);
    ui.score.dataset.warnings = String(e.diagnostics.length || 1);
    dropView();
    paintEmpty("failed");
  }
}

/** Refresh soon: several edits in a row are one redraw. */
function refreshSoon() {
  if (!open) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, REFRESH_DELAY_MS);
}

async function saveTab(stem, change) {
  if (!jobId) return;
  const id = jobId;
  try {
    const res = await fetch(`/api/jobs/${id}/transcription/tab`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [stem]: change }),
    });
    if (!res.ok) throw new Error(`PATCH ${res.status}`);
  } catch (e) {
    console.warn("[notation] could not save the tab choice:", e);
    showTabError(t("notation.tab.saveFailed"));
    return;
  }
  // The score is fingered again on the server; no transcription runs.
  if (id === currentJobId) refresh();
}

/**
 * The stems on show as a Guitar Pro file. Made by alphaTab from the same
 * score the server gives the view, in the form a tab editor reads: one staff
 * per stem, so a note with no string and fret (already counted above the
 * score) is left out rather than given a staff of its own.
 */
// The Guitar Pro file is made here, by alphaTab, from the score's own text.
// A file that exists only in the page can be saved by a browser but not by the
// desktop app, whose shell saves only what it fetches from the server. So the
// bytes are sent to the server, which holds them for a few minutes, and the
// file is then downloaded from there like every other export.
async function heldGuitarPro(job, shown, parts, names) {
  const res = await fetch(`${scoreUrl(job, shown, parts)}&unplaced=omit`);
  if (!res.ok) throw new Error(`score ${res.status}`);
  const bytes = await guitarProBytes((await res.json()).alphatex, names);
  const held = await fetch(`/api/jobs/${job}/transcription.gp`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (!held.ok) throw new Error(`hold ${held.status}`);
  return (await held.json()).url;
}

async function downloadGuitarPro() {
  if (!info || !jobId) return;
  const job = jobId;
  const shown = info.stems;
  const parts = info.parts;
  const names = Object.fromEntries(shown.map((name) => [name, stemLabel(name)]));
  const fileName = info.file_names?.guitar_pro || "transcription.gp";
  ui.guitarPro.disabled = true;
  try {
    // In the desktop app the save dialog comes first and the file is made
    // once a place is chosen; a cancelled dialog makes nothing.
    await triggerDownload(() => heldGuitarPro(job, shown, parts, names), fileName);
  } catch (e) {
    console.warn("[notation] the Guitar Pro file could not be made:", e);
    showTabError(t("notation.guitarProFailed"));
  } finally {
    ui.guitarPro.disabled = !info;
  }
}

// ─── Following the player ───

function follow() {
  frame = requestAnimationFrame(follow);
  if (!view) return;
  const tx = transport();
  if (!tx) return;
  view.setPlaying(Boolean(tx.isPlaying?.()));
  view.setPosition(Math.round((tx.getCurrentTime?.() ?? 0) * 1000));
  paintBar();
}

// ─── Open and close ───

export function isOpen() { return open; }

export function setOpen(next) {
  if (!drawer || !chip || chip.hidden) return;
  const want = Boolean(next);
  if (want === open) return;
  open = want;
  drawer.hidden = !open;
  chip.setAttribute("aria-expanded", String(open));
  chip.classList.toggle("on", open);
  if (open) {
    if (!ui) build();
    refresh();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(follow);
  } else {
    cancelAnimationFrame(frame);
    clearTimeout(refreshTimer);
    token += 1;
    dropView();
  }
  // The lanes give the drawer its room: lay them out again.
  document.dispatchEvent(new CustomEvent("stemdeck:notation-drawer", { detail: { open } }));
}

export async function initNotation() {
  drawer = document.getElementById("notation-drawer");
  chip = document.getElementById("t-notation-btn");
  if (!drawer || !chip) return;
  config = await transcriptionConfig();
  // No notes can be made on this machine, so there is nothing to read.
  chip.hidden = !config?.transcription_available;
  if (chip.hidden) return;
  relabel();
  storeGet(HEIGHT_KEY).then((px) => applyHeight(Number(px) || defaultHeight()));
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!open);
  });
  // The studio's Space shortcut plays; on this button Space is the button's.
  chip.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.key === "Enter") e.stopPropagation();
  });
  // Another song: its own notes, its own choices.
  document.addEventListener("trackopen", () => refreshSoon());
  // The grid was corrected, or a stem was transcribed (again): show it.
  document.addEventListener("stemdeck:beats-saved", () => refreshSoon());
  document.addEventListener("stemdeck:transcription-changed", () => refreshSoon());
  // Karaoke and Performance own the whole window.
  for (const name of ["stemdeck:karaoke-changed", "stemdeck:streamer-changed"]) {
    document.addEventListener(name, (e) => { if (e.detail?.open) setOpen(false); });
  }
  window.addEventListener("resize", () => {
    if (open) applyHeight(drawer.getBoundingClientRect().height);
  });
  onLanguageChange(() => {
    relabel();
    if (open) refresh();
  });
}
