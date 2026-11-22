// Transcribe to notes: turn a finished song's stems into notes, then take
// them out as MIDI or MusicXML (POST/GET /api/jobs/{id}/transcription...).
//
// Opened from the Export menu. The dialog owns no audio and no player state:
// it reads the song's job state, starts a run, polls while it runs, and
// builds download links. The server stores the notes as played and works the
// quantised files out from the beat grid on each request, so nothing here is
// cached either, and a corrected grid shows in the next download.

import { t } from "./i18n.js";
import { currentJobId } from "./state.js";
import {
  LOW_CONFIDENCE, REASONS, ROUTES,
  transcribableStems, defaultChoice, downloadQuery, hasNotes, gridWarning,
} from "./transcribeCore.js";

const POLL_MS = 1500;

let config = null;
let els = null;
let jobId = null;
let jobState = null;
let gridInfo = { available: false, confidence: null, known: false };
let running = false;
let pollTimer = null;
// Which stems are ticked. Kept across re-renders while the dialog is open.
let chosen = null;

async function loadConfig() {
  if (config) return config;
  try {
    const res = await fetch("/api/config");
    config = res.ok ? await res.json() : {};
  } catch (e) {
    console.warn("[transcribe] could not read /api/config:", e);
    config = {};
  }
  return config;
}

export function transcriptionAvailable() {
  return Boolean(config?.transcription_available);
}

function stemLabel(name) {
  const key = `stem.${name}`;
  const label = t(key);
  return label === key ? name : label;
}

function reasonText(code, fallback) {
  if (code && REASONS.includes(code)) return t(`transcribe.reason.${code}`);
  return fallback || t("transcribe.reason.worker_failed");
}

function statusText(entry) {
  if (!entry) return t("transcribe.status.none");
  if (entry.status === "done") return t("transcribe.status.done", { n: entry.notes ?? 0 });
  if (entry.status === "skipped") return t("transcribe.status.skipped");
  return reasonText(entry.code);
}

function renderStems() {
  const names = transcribableStems(jobState, config?.transcription_routes);
  if (!chosen) chosen = defaultChoice(names, jobState?.stem_presence);
  const stemsState = jobState?.transcription_stems || {};
  els.stems.replaceChildren();
  for (const name of names) {
    const row = document.createElement("label");
    row.className = "transcribe-stem";
    row.dataset.stem = name;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = chosen.has(name);
    box.disabled = running;
    box.addEventListener("change", () => {
      if (box.checked) chosen.add(name);
      else chosen.delete(name);
      renderActions();
    });
    const label = document.createElement("span");
    label.className = "transcribe-stem-name";
    label.textContent = stemLabel(name);
    const route = document.createElement("span");
    route.className = "transcribe-stem-route";
    const kind = config?.transcription_routes?.[name];
    route.textContent = ROUTES.includes(kind) ? t(`transcribe.route.${kind}`) : "";
    const status = document.createElement("span");
    const entry = stemsState[name];
    status.className = `transcribe-stem-status${entry?.status === "error" ? " is-error" : ""}`;
    status.dataset.status = entry?.status || "none";
    status.textContent = statusText(entry);
    row.append(box, label, route, status);
    els.stems.append(row);
  }
}

function renderActions() {
  const stemsState = jobState?.transcription_stems || {};
  els.start.disabled = running || !chosen || chosen.size === 0;
  els.start.textContent = running ? t("transcribe.running") : t("transcribe.start");
  els.cancel.hidden = !running;

  // The run's own failure (a cancel, a stall, the app closing). A stem that
  // failed inside a finished run says so on its row instead.
  const failed = !running && jobState?.transcription === "error";
  els.error.hidden = !failed;
  if (failed) els.error.textContent = reasonText(jobState.transcription_reason, jobState.transcription_message);

  const ready = hasNotes(stemsState);
  els.downloads.hidden = !ready;
  if (!ready) {
    els.warning.hidden = true;
    return;
  }
  const parts = Number(els.parts.value) || config?.quantize_parts_default || 4;
  const base = `/api/jobs/${jobId}/transcription`;
  els.midiPlayed.href = `${base}.mid${downloadQuery(chosen, stemsState)}`;
  els.midiQuantised.href = `${base}.mid${downloadQuery(chosen, stemsState, { quantize: true, parts })}`;
  els.musicxml.href = `${base}.musicxml${downloadQuery(chosen, stemsState, { parts })}`;
  const noGrid = gridInfo.known && !gridInfo.available;
  for (const link of [els.midiQuantised, els.musicxml]) {
    link.classList.toggle("is-disabled", noGrid);
    link.setAttribute("aria-disabled", String(noGrid));
    if (noGrid) link.removeAttribute("href");
  }
  els.parts.disabled = noGrid;
  const warning = gridWarning(gridInfo);
  els.warning.hidden = !warning;
  els.warning.dataset.kind = warning || "";
  if (warning === "no-grid") els.warning.textContent = t("transcribe.noGrid");
  else if (warning === "low-confidence") {
    els.warning.textContent = t("transcribe.lowConfidence", { n: Math.round(gridInfo.confidence) });
  }
}

function render() {
  renderStems();
  renderActions();
}

async function fetchJob() {
  const res = await fetch(`/api/jobs/${jobId}`);
  if (!res.ok) throw new Error(`job state ${res.status}`);
  return res.json();
}

// Whether the song can be quantised, and how sure its grid is. Asked only
// once there are notes: the endpoint answers 404 before that.
async function fetchGridInfo() {
  gridInfo = { available: false, confidence: null, known: false };
  if (!hasNotes(jobState?.transcription_stems)) return;
  try {
    const res = await fetch(`/api/jobs/${jobId}/transcription`);
    if (!res.ok) return;
    const body = await res.json();
    gridInfo = {
      available: Boolean(body.quantize_available),
      confidence: typeof body.grid?.confidence === "number" ? body.grid.confidence : null,
      known: true,
    };
  } catch (e) {
    console.warn("[transcribe] could not read the transcription:", e);
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  stopPolling();
  const forJob = jobId;
  pollTimer = setInterval(async () => {
    if (jobId !== forJob) return stopPolling();
    try {
      const state = await fetchJob();
      if (jobId !== forJob || !running) return;
      jobState = { ...state, transcription: "running" };
      render();
    } catch (e) {
      console.warn("[transcribe] poll failed:", e);
    }
  }, POLL_MS);
}

async function start() {
  if (running || !chosen?.size) return;
  const forJob = jobId;
  const names = transcribableStems(jobState, config?.transcription_routes).filter((n) => chosen.has(n));
  running = true;
  jobState = { ...jobState, transcription: "running", transcription_reason: null };
  render();
  startPolling();
  let body = null;
  try {
    const res = await fetch(`/api/jobs/${forJob}/transcription`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stems: names }),
    });
    body = await res.json().catch(() => null);
    if (!res.ok && !(body && "transcription" in body)) {
      // Refused before it started (busy, already running, not available here).
      body = {
        ...jobState,
        transcription: "error",
        transcription_reason: body?.transcription_reason || (res.status === 409 ? "worker_failed" : null),
        transcription_message: body?.transcription_message || (typeof body?.detail === "string" ? body.detail : null),
      };
    }
  } catch (e) {
    console.warn("[transcribe] request failed:", e);
    body = { ...jobState, transcription: "error", transcription_reason: "worker_failed" };
  }
  stopPolling();
  if (jobId !== forJob) return;
  running = false;
  jobState = body;
  await fetchGridInfo();
  if (jobId === forJob) render();
}

async function cancel() {
  if (!running) return;
  els.cancel.disabled = true;
  try {
    await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
  } catch (e) {
    console.warn("[transcribe] cancel failed:", e);
  } finally {
    els.cancel.disabled = false;
  }
}

function hide() {
  els.dialog.classList.add("hidden");
  // A run keeps going on the server; only the watching stops.
  stopPolling();
}

export async function openTranscribeDialog(forJobId = currentJobId) {
  if (!els || !forJobId) return;
  await loadConfig();
  if (!transcriptionAvailable()) return;
  if (jobId !== forJobId) {
    chosen = null;
    running = false;
  }
  jobId = forJobId;
  try {
    jobState = await fetchJob();
  } catch (e) {
    console.warn("[transcribe] could not read the song:", e);
    return;
  }
  running = jobState.transcription === "running";
  await fetchGridInfo();
  render();
  els.dialog.classList.remove("hidden");
  els.close.focus();
  if (running) {
    // Opened on a run started elsewhere (another window, before a reload):
    // watch it until the song stops saying it is running.
    stopPolling();
    const watched = jobId;
    pollTimer = setInterval(async () => {
      try {
        const state = await fetchJob();
        if (jobId !== watched) return stopPolling();
        jobState = state;
        if (state.transcription !== "running") {
          running = false;
          stopPolling();
          await fetchGridInfo();
        }
        render();
      } catch (e) {
        console.warn("[transcribe] poll failed:", e);
      }
    }, POLL_MS);
  }
}

// Wire the dialog and its Export-menu row. Returns the row, hidden where
// transcription cannot run (Intel Macs), so the menu can skip it.
export async function initTranscribe() {
  const dialog = document.getElementById("transcribeDialog");
  const item = document.getElementById("t-export-transcribe");
  if (!dialog || !item) return null;
  els = {
    dialog,
    close: document.getElementById("transcribeClose"),
    stems: document.getElementById("transcribeStems"),
    start: document.getElementById("transcribeStart"),
    cancel: document.getElementById("transcribeCancel"),
    error: document.getElementById("transcribeError"),
    downloads: document.getElementById("transcribeDownloads"),
    parts: document.getElementById("transcribeParts"),
    warning: document.getElementById("transcribeWarning"),
    midiPlayed: document.getElementById("transcribeMidiPlayed"),
    midiQuantised: document.getElementById("transcribeMidiQuantised"),
    musicxml: document.getElementById("transcribeMusicxml"),
  };
  els.close.addEventListener("click", hide);
  dialog.addEventListener("click", (e) => { if (e.target === dialog) hide(); });
  dialog.addEventListener("keydown", (e) => { if (e.code === "Escape") hide(); });
  els.start.addEventListener("click", start);
  els.cancel.addEventListener("click", cancel);
  els.parts.addEventListener("change", renderActions);
  for (const link of [els.midiQuantised, els.musicxml]) {
    link.addEventListener("click", (e) => {
      if (link.getAttribute("aria-disabled") === "true") e.preventDefault();
    });
  }
  await loadConfig();
  item.hidden = !transcriptionAvailable();
  const def = String(config?.quantize_parts_default || 4);
  if ([...els.parts.options].some((o) => o.value === def)) els.parts.value = def;
  return item;
}
