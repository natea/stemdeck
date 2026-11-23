// Shared setup for the Visualizer's browser tests (static/js/viz/): the host's
// own spec, and each visualization's scene.e2e.mjs, which lives in its folder
// and is run by viz-scenes.spec.mjs.

import { expect } from "@playwright/test";
import { JOB_ID, openStudio } from "./helpers.mjs";

export { JOB_ID, openStudio };

const ev = (page, fn, arg) => page.evaluate(fn, arg);

// On a Mac the tests draw with the machine's GPU, as the app does. Elsewhere
// (CI) Chromium falls back to software drawing, which is slower: the waits
// below allow for it. Use as `test.use(GPU)`.
export const GPU = process.platform === "darwin"
  ? { launchOptions: { args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] } }
  : {};
// Opening the view loads the 3D library and compiles a scene's shaders.
const OPEN_TIMEOUT = 30_000;

/** What the host says it is doing (host.js visualizerState). */
export const vizState = (page) => ev(page, async () => (await import("/js/viz/host.js")).visualizerState());
/** The host's state and the player's position, read in the same instant. */
export const vizAndNow = (page) => ev(page, async () => {
  const host = await import("/js/viz/host.js");
  const { transport } = await import("/js/transport.js");
  // After a drawn frame, so the scene has seen the time being reported.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { state: host.visualizerState(), now: transport().getCurrentTime() };
});
export const now = (page) => ev(page, async () => (await import("/js/transport.js")).transport().getCurrentTime());
export const isPlaying = (page) => ev(page, async () => (await import("/js/transport.js")).transport().isPlaying());
export const seek = (page, s) => ev(page, async (x) => (await import("/js/transport.js")).setPlayheadTime(x), s);
export const setSpeed = (page, r) => ev(page, async (x) => (await import("/js/transport.js")).setSpeed(x), r);

/** Mute or solo a lane through the mixer's own state, as its M and S buttons do. */
export const setLane = (page, name, patch) => ev(page, async ([n, p]) => {
  const m = await import("/js/mixer.js");
  const { mixerState } = await import("/js/state.js");
  Object.assign(mixerState[n], p);
  m.refreshMixerVisuals();
  m.applyMix();
}, [name, patch]);

export async function play(page) {
  if (!(await isPlaying(page))) await page.locator("#t-play").click();
  await expect.poll(() => isPlaying(page)).toBe(true);
}

export async function pause(page) {
  if (await isPlaying(page)) await page.locator("#t-play").click();
  await expect.poll(() => isPlaying(page)).toBe(false);
}

/** Open the view and wait until it is drawing a scene or showing a message. */
export async function openViz(page) {
  const before = (await vizState(page)).frames;
  await page.locator("#t-viz-btn").click();
  await expect(page.locator("#viz")).toBeVisible();
  // A scene that has drawn at least one frame, or a message in its place.
  await expect.poll(async () => {
    const s = await vizState(page);
    return (Boolean(s.scene) && s.frames > before) || (s.message && s.message !== "loading");
  }, { timeout: OPEN_TIMEOUT }).toBe(true);
}

export async function closeViz(page) {
  await page.locator("#viz .viz-close").click();
  await expect(page.locator("#viz")).toBeHidden();
}

export async function pick(page, id) {
  const before = (await vizState(page)).frames;
  await page.locator(`#viz .viz-pick[data-scene="${id}"]`).click();
  await expect.poll(async () => {
    const s = await vizState(page);
    return s.chosen === id && ((s.scene === id && s.frames > before) || (s.message && s.message !== "loading"));
  }, { timeout: OPEN_TIMEOUT }).toBe(true);
}

/** Remember a choice before the page loads, the way the host stores it. */
export async function rememberScene(page, id) {
  await page.addInitScript((sceneId) => {
    if (!window.sessionStorage.getItem("e2e.vizChoice")) {
      window.sessionStorage.setItem("e2e.vizChoice", "1");
      window.localStorage.setItem("stemdeck.viz.scene", sceneId);
    }
  }, id);
}

// Changes to the song's own state (GET /api/jobs/{id}), kept per page so that
// several stubs compose: one route answers, every patch is applied.
const jobPatches = new WeakMap();
async function patchJob(page, jobId, patch) {
  let byJob = jobPatches.get(page);
  if (!byJob) jobPatches.set(page, (byJob = new Map()));
  if (!byJob.has(jobId)) {
    byJob.set(jobId, []);
    await page.route(new RegExp(`/api/jobs/${jobId}$`), async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const json = await res.json();
      for (const fn of byJob.get(jobId)) fn(json);
      return route.fulfill({ response: res, json });
    });
  }
  byJob.get(jobId).push(patch);
}

/**
 * Give the fixture song a transcription: { stemName: [{start, end, pitch, velocity}] }.
 * Without this the song has no notes (the endpoint answers 404).
 */
export async function stubNotes(page, stems, jobId = JOB_ID) {
  // The song's own state says which stems have notes; the Visualizer asks for
  // the notes only then.
  await patchJob(page, jobId, (json) => {
    json.transcription = "done";
    json.transcription_stems = Object.fromEntries(Object.entries(stems).map(([n, notes]) => [n, { status: "done", notes: notes.length }]));
  });
  await page.route(new RegExp(`/api/jobs/${jobId}/transcription(\\?.*)?$`), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        job_id: jobId,
        quantized: false,
        quantize_available: true,
        stems: Object.fromEntries(Object.entries(stems).map(([n, notes]) => [n, { transcriber: "e2e", notes }])),
      },
    });
  });
}

/**
 * Give the fixture song one more stem (it has vocals, drums, bass and other),
 * playing another stem's audio: enough for an instrument that needs "piano" or
 * "guitar" to have a stem to follow.
 */
export async function stubExtraStem(page, name, jobId = JOB_ID) {
  await patchJob(page, jobId, (json) => {
    const from = json.stems?.find((s) => s.name === "other");
    if (from && !json.stems.some((s) => s.name === name)) json.stems.push({ name, url: from.url });
    if (Array.isArray(json.selected_stems) && !json.selected_stems.includes(name)) json.selected_stems.push(name);
  });
}

/** Sections for the fixture song, which has none. */
export async function stubSections(page, sections, jobId = JOB_ID) {
  await patchJob(page, jobId, (json) => { json.sections = sections; });
}

/** A tempo and beat grid for the fixture song: `bpm` beats a minute, 4 to the bar. */
export async function stubTempo(page, bpm, { duration = 6, jobId = JOB_ID } = {}) {
  const step = 60 / bpm;
  const beats = [];
  for (let t = 0; t < duration; t += step) beats.push(Number(t.toFixed(4)));
  await patchJob(page, jobId, (json) => { json.bpm = bpm; });
  await page.route(new RegExp(`/api/jobs/${jobId}/beats$`), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { version: 1, bpm, duration, confidence: 95, beats, onsets: beats, bars: [{ beat: 0, beats_per_bar: 4 }] } });
  });
}

/** Say the server can transcribe, so "needs notes" can offer it. */
export async function stubTranscriptionAvailable(page) {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.transcription_available = true;
    json.transcription_routes = { vocals: "crepe", bass: "crepe", drums: "mt3", other: "mt3" };
    return route.fulfill({ response: res, json });
  });
}

/** Every request made while `fn` runs: [{ method, url }]. */
export async function requestsDuring(page, fn) {
  const seen = [];
  const on = (r) => seen.push({ method: r.method(), url: r.url() });
  page.on("request", on);
  try {
    await fn();
  } finally {
    page.off("request", on);
  }
  return seen;
}

/** Fraction of the canvas's pixels that are not the background, 0..1. */
export async function inkOf(page) {
  const png = await page.locator("#viz .viz-canvas").screenshot();
  return ev(page, async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    // The view's background is #050b10; anything clearly brighter is picture.
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 90) lit++;
    return lit / (d.length / 4);
  }, png.toString("base64"));
}

/** Mean brightness (0..255) of the canvas, for "a muted stem dims". */
export async function brightnessOf(page, region = null) {
  const png = await page.locator("#viz .viz-canvas").screenshot();
  return ev(page, async ([b64, r]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const x = r ? Math.floor(r.x * c.width) : 0;
    const y = r ? Math.floor(r.y * c.height) : 0;
    const w = r ? Math.max(1, Math.floor(r.w * c.width)) : c.width;
    const h = r ? Math.max(1, Math.floor(r.h * c.height)) : c.height;
    const d = g.getImageData(x, y, w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4);
  }, [png.toString("base64"), region]);
}
