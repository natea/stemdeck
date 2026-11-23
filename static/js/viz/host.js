// The Visualizer (Labs): a layer over the lanes that shows the open song's
// stems as a 3D picture. It follows StemDeck's own player and mixer, makes no
// sound and changes nothing: every request it sends is a GET.
//
// The host owns everything a visualization must not touch: the canvas and the
// one WebGLRenderer, the draw loop, resize, the frame-rate guard, the picker,
// errors and the DOM. A visualization (static/js/viz/scenes/<id>/) is given
// plain song data and a frame, and returns a scene and a camera:
//
//   export default {
//     id, needs: { notes }, strings,
//     create({ THREE, renderer, song, size, reducedMotion, text, stemLabel }) {
//       return {
//         scene, camera,
//         update(frame), resize(size), setQuality(level), dispose(),
//         bloom?: { strength, radius, threshold },   // the host draws the glow
//         timeAt?({ x, y }) -> seconds | null,       // a click that seeks
//         caption?() -> string,                      // one line over the picture
//       };
//     },
//   };
//
// `text(key, vars)` reads the visualization's own strings.js in the app's
// language; `stemLabel(name)` is a stem's name as StemDeck shows it.
//
// Not a mode: modes keep their own stems and saved mix, and looking at a
// picture must not change what is heard. Karaoke and Performance own the
// window: viz.css hides the button while either is open.

import { t, getLanguage, onLanguageChange } from "../i18n.js";
import { currentJobId, mixerState, trackIndex, playbackSpeed } from "../state.js";
import { transport, setPlayheadTime } from "../transport.js";
import { STEM_COLORS, laneLabel } from "../constants.js";
import { openTranscribeDialog, transcriptionAvailable } from "../transcribe.js";
import { SCENES } from "./registry.js";
import { loadSong, forgetSong } from "./data.js";
import { createClock } from "./clock.js";

const CHOICE_KEY = "stemdeck.viz.scene";
const THREE_URL = "/vendor/three/three.module.js";
const ADDONS = "/vendor/three/addons/postprocessing";

// The frame-rate guard: below this, averaged over a second, detail steps down.
const MIN_FPS = 45;
const GUARD_WINDOW_MS = 1000;
// Frames this long are a hidden tab or a stall, not a slow scene.
const GUARD_IGNORE_MS = 250;
// A new scene compiles its shaders in its first moments; do not judge those.
const GUARD_GRACE_MS = 1500;
const MAX_QUALITY = 2;
// Pixel ratio cap per quality level; bloom is off at level 0.
const PIXEL_RATIO = [1, 1.5, 2];
// Glow is capped so a scene cannot flash the whole view.
const MAX_BLOOM = 1.2;

let btn = null;
let root = null;
let ui = null;
let open = false;
// Bumped on every open, close and scene change: late async work checks it.
let token = 0;

let THREE = null;
let renderer = null;
let canvas = null;
let composer = null;
let bloomPass = null;
let installed = null; // [{ id, def }] that loaded, in registry order
let current = null; // the entry being shown, or asked for
let instance = null;
let song = null;
let songJob = null;
let clock = null;
let quality = MAX_QUALITY;
let raf = 0;
let frames = 0;
let message = null; // { kind, sceneId } while the canvas is not drawing
let pinned = null; // the camera's pose under reduced motion
let lastDispose = null;
let guard = { since: 0, count: 0, start: 0 };
let lastFrameAt = 0;
let layerObserver = null;
let sizeObserver = null;
let dialogObserver = null;
let rootClassObserver = null;
let songWatch = 0;
let songLoads = 0;
let songLoading = false;

const reducedMotionQuery = () => window.matchMedia?.("(prefers-reduced-motion: reduce)");
const reducedMotion = () => Boolean(reducedMotionQuery()?.matches);

// ── Strings ──

/** A visualization's own text (its strings.js), in the app's language. */
export function sceneText(def, key, vars) {
  const tables = def?.strings || {};
  const lang = getLanguage();
  const base = lang.includes("-") ? lang.split("-")[0] : null;
  let str = tables[lang]?.[key] ?? (base ? tables[base]?.[key] : undefined) ?? tables.en?.[key] ?? key;
  if (vars) str = str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return str;
}

// ── The player and the mixer, as the clock wants them ──

const player = {
  time: () => transport()?.getCurrentTime?.() ?? 0,
  playing: () => Boolean(transport()?.isPlaying?.()),
  rate: () => playbackSpeed,
};

function lanes() {
  const out = {};
  for (const [name, s] of Object.entries(mixerState)) {
    if (s && trackIndex[name] !== undefined) out[name] = s;
  }
  return out;
}

// ── DOM ──

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function build() {
  root = el("section", "viz");
  root.id = "viz";
  root.hidden = true;

  const bar = el("div", "viz-bar");
  const heading = el("div", "viz-heading");
  const title = el("span", "viz-title");
  const labs = el("span", "viz-labs");
  heading.append(title, labs);
  const picker = el("div", "viz-picker");
  picker.setAttribute("role", "radiogroup");
  const close = el("button", "viz-close", "×");
  close.type = "button";
  close.addEventListener("click", () => closeVisualizer());
  bar.append(heading, picker, close);

  const stage = el("div", "viz-stage");
  const caption = el("div", "viz-caption");
  caption.hidden = true;
  const note = el("div", "viz-message");
  note.setAttribute("role", "status");
  note.hidden = true;
  const noteText = el("p", "viz-message-text");
  const noteAction = el("button", "viz-message-action");
  noteAction.type = "button";
  noteAction.hidden = true;
  note.append(noteText, noteAction);
  stage.append(caption, note);

  root.append(bar, stage);
  ui = { title, labs, picker, close, stage, caption, note, noteText, noteAction };

  const col = document.querySelector(".daw-main-col") || document.body;
  col.append(root);
  relabel();
}

function relabel() {
  if (!ui) return;
  root.setAttribute("aria-label", t("viz.title"));
  ui.title.textContent = t("viz.title");
  ui.labs.textContent = t("viz.labs");
  ui.close.setAttribute("aria-label", t("viz.close"));
  ui.close.title = t("viz.close");
  ui.picker.setAttribute("aria-label", t("viz.pickerAria"));
  paintPicker();
  paintMessage();
}

function paintPicker() {
  if (!ui) return;
  ui.picker.replaceChildren();
  for (const entry of installed || []) {
    const b = el("button", "viz-pick");
    b.type = "button";
    b.dataset.scene = entry.id;
    b.setAttribute("role", "radio");
    const on = current?.id === entry.id;
    b.setAttribute("aria-checked", String(on));
    b.classList.toggle("on", on);
    b.append(el("span", "viz-pick-name", sceneText(entry.def, "name")), el("span", "viz-pick-desc", sceneText(entry.def, "description")));
    b.title = sceneText(entry.def, "description");
    b.addEventListener("click", () => choose(entry.id));
    ui.picker.append(b);
  }
}

function setMessage(kind, sceneId = null) {
  message = kind ? { kind, sceneId } : null;
  paintMessage();
}

function paintMessage() {
  if (!ui) return;
  ui.note.hidden = !message;
  ui.note.dataset.kind = message?.kind || "";
  if (canvas) canvas.hidden = Boolean(message);
  if (!message) return;
  const entry = (installed || []).find((e) => e.id === message.sceneId);
  const name = entry ? sceneText(entry.def, "name") : "";
  const text = {
    loading: t("viz.loading"),
    noSong: t("viz.noSong"),
    needsNotes: t("viz.needsNotes", { name }),
    failed: t("viz.failed", { name }),
    noWebgl: t("viz.noWebgl"),
    none: t("viz.none"),
  }[message.kind];
  ui.noteText.textContent = text || "";
  const action = message.kind === "needsNotes" && transcriptionAvailable()
    ? { label: t("viz.transcribe"), run: () => openTranscribeDialog(songJob) }
    : message.kind === "noWebgl" || message.kind === "none"
      ? { label: t("viz.close"), run: () => closeVisualizer() }
      : null;
  ui.noteAction.hidden = !action;
  ui.noteAction.textContent = action?.label || "";
  ui.noteAction.onclick = action?.run || null;
}

function placeLayer() {
  if (!open || !root) return;
  const lanesEl = document.getElementById("lanes");
  if (!lanesEl) return;
  const a = lanesEl.getBoundingClientRect();
  const col = lanesEl.closest(".daw-main-col") || lanesEl;
  const footer = col.querySelector(".daw-footer");
  // Down to the top of the footer, which stays visible and usable.
  const bottom = footer ? footer.getBoundingClientRect().top : col.getBoundingClientRect().bottom;
  root.style.left = `${Math.round(a.left)}px`;
  root.style.top = `${Math.round(a.top)}px`;
  root.style.width = `${Math.round(a.width)}px`;
  root.style.height = `${Math.max(0, Math.round(bottom - a.top))}px`;
}

function stageSize() {
  const r = ui.stage.getBoundingClientRect();
  return {
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height)),
    pixelRatio: Math.min(window.devicePixelRatio || 1, PIXEL_RATIO[quality]),
  };
}

// ── Three.js and the renderer ──

async function loadThree() {
  if (!THREE) THREE = await import(THREE_URL);
  return THREE;
}

function makeRenderer() {
  canvas = el("canvas", "viz-canvas");
  canvas.addEventListener("click", onCanvasClick);
  canvas.addEventListener("webglcontextlost", onContextLost);
  try {
    // Asked for by hand first: Three.js logs an error before it throws, and a
    // computer without 3D graphics is an ordinary case, not an error.
    const probe = document.createElement("canvas");
    if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) throw new Error("no WebGL");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch (e) {
    console.warn("[viz] no 3D graphics:", e?.message || e);
    canvas = null;
    renderer = null;
    return false;
  }
  renderer.setClearColor(0x050b10, 1);
  ui.stage.prepend(canvas);
  applySize();
  return true;
}

function applySize() {
  if (!renderer) return;
  const size = stageSize();
  renderer.setPixelRatio(size.pixelRatio);
  renderer.setSize(size.width, size.height, false);
  if (composer) {
    composer.setPixelRatio(size.pixelRatio);
    composer.setSize(size.width, size.height);
  }
  if (instance) {
    try {
      instance.resize(size);
    } catch (e) {
      fail(e);
    }
  }
}

function dropComposer() {
  if (!composer) return;
  for (const pass of composer.passes) pass.dispose?.();
  composer.dispose();
  composer = null;
  bloomPass = null;
}

// The glow, when the scene asks for one and detail allows it.
async function syncBloom(mine) {
  const want = instance?.bloom && quality > 0;
  if (!want) return dropComposer();
  if (composer) return;
  const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
    import(`${ADDONS}/EffectComposer.js`),
    import(`${ADDONS}/RenderPass.js`),
    import(`${ADDONS}/UnrealBloomPass.js`),
    import(`${ADDONS}/OutputPass.js`),
  ]);
  if (mine !== token || !instance?.bloom || !renderer || quality === 0) return;
  const size = stageSize();
  const b = instance.bloom;
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(size.pixelRatio);
  composer.setSize(size.width, size.height);
  composer.addPass(new RenderPass(instance.scene, instance.camera));
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(size.width, size.height),
    Math.min(MAX_BLOOM, Number(b.strength) || 0.6),
    Number(b.radius) || 0.4,
    Number(b.threshold) || 0.7,
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}

function releaseRenderer() {
  dropComposer();
  if (renderer) {
    const mem = renderer.info?.memory;
    lastDispose = { geometries: mem?.geometries ?? 0, textures: mem?.textures ?? 0 };
    renderer.dispose();
    renderer.forceContextLoss?.();
  }
  if (canvas) {
    canvas.removeEventListener("click", onCanvasClick);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.remove();
  }
  renderer = null;
  canvas = null;
}

function onContextLost(e) {
  e.preventDefault();
  if (!open) return;
  console.warn("[viz] the graphics context was lost");
  stopScene();
  releaseRenderer();
  setMessage("noWebgl");
}

// ── A scene's life ──

function stopScene() {
  cancelAnimationFrame(raf);
  raf = 0;
  if (instance) {
    try {
      instance.dispose();
    } catch (e) {
      console.warn("[viz] dispose failed:", e);
    }
  }
  dropComposer();
  instance = null;
  clock = null;
  pinned = null;
  if (ui) ui.caption.hidden = true;
}

function fail(err) {
  console.warn(`[viz] "${current?.id}" failed:`, err);
  const id = current?.id || null;
  stopScene();
  setMessage("failed", id);
}

async function startScene() {
  const mine = ++token;
  stopScene();
  if (!current) return setMessage("none");
  if (!song) return setMessage("noSong");
  if (current.def.needs?.notes && !song.hasNotes) return setMessage("needsNotes", current.id);
  if (!renderer && !makeRenderer()) return setMessage("noWebgl");
  setMessage(null);
  quality = MAX_QUALITY;
  applySize();
  const def = current.def;
  try {
    instance = def.create({
      THREE,
      renderer,
      song,
      size: stageSize(),
      reducedMotion: reducedMotion(),
      text: (key, vars) => sceneText(def, key, vars),
      stemLabel: laneLabel,
    });
    instance.setQuality?.(quality);
  } catch (e) {
    return fail(e);
  }
  clock = createClock({ song, player, mixer: lanes });
  guard = { since: 0, count: 0, start: performance.now() };
  lastFrameAt = 0;
  // Draw straight away; the glow joins in when its files have loaded.
  schedule();
  try {
    await syncBloom(mine);
  } catch (e) {
    console.warn("[viz] the glow could not be loaded:", e);
  }
}

function schedule() {
  cancelAnimationFrame(raf);
  raf = 0;
  if (!open || !instance || document.hidden) return;
  raf = requestAnimationFrame(draw);
}

function setQuality(level) {
  quality = Math.max(0, Math.min(MAX_QUALITY, level));
  try {
    instance?.setQuality?.(quality);
  } catch (e) {
    return fail(e);
  }
  if (quality === 0) dropComposer();
  applySize();
}

// Averaged over a second; never steps back up within a session.
function watchFrameRate(now) {
  const dt = lastFrameAt ? now - lastFrameAt : 0;
  lastFrameAt = now;
  if (now - guard.start < GUARD_GRACE_MS || dt <= 0 || dt > GUARD_IGNORE_MS) {
    guard.since = now;
    guard.count = 0;
    return;
  }
  guard.count++;
  if (now - guard.since < GUARD_WINDOW_MS) return;
  const fps = (guard.count * 1000) / (now - guard.since);
  guard.since = now;
  guard.count = 0;
  if (fps < MIN_FPS && quality > 0) setQuality(quality - 1);
}

function draw(now) {
  raf = 0;
  if (!open || !instance) return;
  try {
    const frame = clock.frame();
    instance.update(frame);
    const cam = instance.camera;
    if (reducedMotion()) {
      // The camera does not travel: whatever the scene did, it stays put.
      if (!pinned) pinned = { position: cam.position.clone(), quaternion: cam.quaternion.clone(), zoom: cam.zoom, fov: cam.fov };
      else {
        cam.position.copy(pinned.position);
        cam.quaternion.copy(pinned.quaternion);
        if (cam.zoom !== pinned.zoom || cam.fov !== pinned.fov) {
          cam.zoom = pinned.zoom;
          if (pinned.fov !== undefined) cam.fov = pinned.fov;
          cam.updateProjectionMatrix();
        }
      }
    } else pinned = null;
    if (composer) composer.render();
    else renderer.render(instance.scene, cam);
    const caption = instance.caption ? instance.caption() : "";
    if (ui.caption.textContent !== (caption || "")) ui.caption.textContent = caption || "";
    ui.caption.hidden = !caption;
  } catch (e) {
    return fail(e);
  }
  frames++;
  watchFrameRate(now);
  schedule();
}

function onCanvasClick(e) {
  if (!instance?.timeAt || !song) return;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  let time = null;
  try {
    time = instance.timeAt({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  } catch (err) {
    return fail(err);
  }
  if (typeof time === "number" && Number.isFinite(time)) setPlayheadTime(Math.max(0, Math.min(song.duration, time)));
}

// ── Choosing ──

function remembered() {
  try {
    return window.localStorage.getItem(CHOICE_KEY);
  } catch {
    return null;
  }
}

function choose(id) {
  const entry = (installed || []).find((e) => e.id === id);
  if (!entry || !open) return;
  current = entry;
  try {
    window.localStorage.setItem(CHOICE_KEY, id);
  } catch { /* a private window: the choice is not kept */ }
  paintPicker();
  // While the song is being read again, the reading starts this choice when it is done.
  if (!songLoading) startScene();
}

// Every listed visualization whose files load. One that does not is left out.
async function loadScenes() {
  const settled = await Promise.allSettled(SCENES.map((s) => s.load()));
  const out = [];
  settled.forEach((r, i) => {
    const def = r.status === "fulfilled" ? r.value?.default : null;
    if (def && typeof def.create === "function") out.push({ id: SCENES[i].id, def });
    else console.warn(`[viz] "${SCENES[i].id}" could not be loaded and is left out`, r.reason || "");
  });
  return out;
}

// Read the open song again (another song was opened, or notes have arrived).
// It has a count of its own: a visualization picked while the song is still
// being read must not make that reading be thrown away.
async function reloadSong() {
  const mine = ++songLoads;
  token++;
  stopScene();
  songJob = currentJobId;
  song = null;
  if (!songJob) {
    songLoading = false;
    return setMessage("noSong");
  }
  songLoading = true;
  setMessage("loading");
  forgetSong(songJob);
  const loaded = await loadSong(songJob, { colors: STEM_COLORS });
  if (mine !== songLoads || !open) return;
  songLoading = false;
  song = loaded;
  startScene();
}

// ── Open and close ──

function onKey(e) {
  if (e.code !== "Escape") return;
  // A dialog over the view (Transcribe) takes its own Escape.
  const dialog = document.getElementById("transcribeDialog");
  if (dialog && !dialog.classList.contains("hidden")) return;
  e.stopPropagation();
  closeVisualizer();
}

function onVisibility() {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    raf = 0;
  } else {
    lastFrameAt = 0;
    schedule();
  }
}

function onMotionChange() {
  // A calm version is built, not switched to: start the scene again.
  if (open && instance) startScene();
}

export async function openVisualizer() {
  if (open || !SCENES.length) return;
  // Karaoke and Performance own the window.
  const cls = document.documentElement.classList;
  if (cls.contains("karaoke-open") || cls.contains("streamer-open")) return;
  if (!root) build();
  open = true;
  const mine = ++token;
  root.hidden = false;
  cls.add("viz-open");
  btn?.setAttribute("aria-pressed", "true");
  for (const id of ["lanes", "master-drawer"]) document.getElementById(id)?.setAttribute("inert", "");
  placeLayer();
  window.addEventListener("resize", placeLayer);
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("visibilitychange", onVisibility);
  reducedMotionQuery()?.addEventListener?.("change", onMotionChange);
  layerObserver = new ResizeObserver(placeLayer);
  for (const node of [document.getElementById("lanes"), document.querySelector(".daw-footer")]) if (node) layerObserver.observe(node);
  sizeObserver = new ResizeObserver(applySize);
  sizeObserver.observe(ui.stage);
  // Notes transcribed from here should be seen: look again when the dialog shuts.
  const dialog = document.getElementById("transcribeDialog");
  if (dialog) {
    dialogObserver = new MutationObserver(() => {
      if (dialog.classList.contains("hidden") && message?.kind === "needsNotes") reloadSong();
    });
    dialogObserver.observe(dialog, { attributes: true, attributeFilter: ["class"] });
  }
  rootClassObserver = new MutationObserver(() => {
    if (cls.contains("karaoke-open") || cls.contains("streamer-open")) closeVisualizer();
  });
  rootClassObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  setMessage("loading");
  songJob = currentJobId;
  song = null;
  if (songJob) forgetSong(songJob);
  try {
    // loadScenes and loadSong never reject: only the 3D library can fail here.
    [, installed, song] = await Promise.all([
      loadThree(),
      loadScenes(),
      songJob ? loadSong(songJob, { colors: STEM_COLORS }) : null,
    ]);
  } catch (e) {
    console.warn("[viz] could not load:", e);
    if (mine === token) setMessage("noWebgl");
    return;
  }
  if (mine !== token) return;
  // Another song opened behind the view (the library stays in reach): show it.
  songWatch = window.setInterval(() => {
    if (open && currentJobId !== songJob) reloadSong();
  }, 500);
  const want = remembered();
  current = installed.find((e) => e.id === want) || installed[0] || null;
  paintPicker();
  if (!current) return setMessage("none");
  startScene();
}

export function closeVisualizer() {
  if (!open) return;
  open = false;
  token++;
  songLoads++;
  songLoading = false;
  stopScene();
  releaseRenderer();
  message = null;
  song = null;
  songJob = null;
  current = null;
  root.hidden = true;
  document.documentElement.classList.remove("viz-open");
  btn?.setAttribute("aria-pressed", "false");
  const cls = document.documentElement.classList;
  // Karaoke or Performance may have opened over the lanes: their inert stays.
  if (!cls.contains("karaoke-open") && !cls.contains("streamer-open")) {
    for (const id of ["lanes", "master-drawer"]) document.getElementById(id)?.removeAttribute("inert");
  }
  window.removeEventListener("resize", placeLayer);
  window.removeEventListener("keydown", onKey, true);
  document.removeEventListener("visibilitychange", onVisibility);
  reducedMotionQuery()?.removeEventListener?.("change", onMotionChange);
  window.clearInterval(songWatch);
  songWatch = 0;
  for (const o of [layerObserver, sizeObserver, dialogObserver, rootClassObserver]) o?.disconnect();
  layerObserver = sizeObserver = dialogObserver = rootClassObserver = null;
}

export function isVisualizerOpen() {
  return open;
}

/** What the view is doing, for the browser tests. */
export function visualizerState() {
  const cam = instance?.camera;
  return {
    open,
    scene: instance ? current?.id ?? null : null,
    chosen: current?.id ?? null,
    installed: (installed || []).map((e) => e.id),
    message: message?.kind ?? null,
    quality,
    frames,
    drawing: raf !== 0,
    hasRenderer: Boolean(renderer),
    bloom: Boolean(composer),
    memory: renderer ? { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures } : null,
    lastDispose,
    camera: cam ? [...cam.position.toArray(), ...cam.quaternion.toArray()] : null,
    reducedMotion: reducedMotion(),
    // Whatever the visualization itself offers the tests.
    debug: instance?.debug ? instance.debug() : null,
  };
}

/** Wire the rail's Visualizer button. With nothing installed there is no button. */
export function initVisualizer() {
  btn = document.getElementById("t-viz-btn");
  if (!btn) return;
  if (!SCENES.length) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.setAttribute("aria-pressed", "false");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (open) closeVisualizer();
    else openVisualizer();
  });
  // The studio's Space shortcut plays; on this button Space is the button's.
  btn.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.key === "Enter") e.stopPropagation();
  });
  onLanguageChange(relabel);
}
