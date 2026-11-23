// The Visualizer's host (static/js/viz/host.js), against stub visualizations.
//
// Every scenario of the host requirements in the stem-visualizers spec, with
// no real visualization involved: the registry and the scenes are served by
// the test, so this spec keeps passing whichever of the six are kept or
// removed. Each real one has its own tests in its folder (viz-scenes.spec.mjs).

import { test, expect } from "@playwright/test";
import {
  JOB_ID, openStudio, vizState, now, isPlaying, seek, setSpeed, setLane, play, pause,
  openViz, closeViz, pick, stubNotes, stubTranscriptionAvailable, requestsDuring, GPU,
} from "./viz-helpers.mjs";

// A visualization that draws one box and writes down what the host gives it.
// Options are baked into the module text: needsNotes, throwOnCreate,
// throwOnFrame (n), slowMs (busy-wait per frame), moveCamera, bloom.
function stubScene(id, o = {}) {
  return `
const log = (window.__viz = window.__viz || {});
export default {
  id: ${JSON.stringify(id)},
  needs: { notes: ${Boolean(o.needsNotes)} },
  strings: {
    en: { name: ${JSON.stringify(o.name || id)}, description: "A stub for the tests" },
    pl: { name: ${JSON.stringify("PL " + (o.name || id))}, description: "Atrapa do testów" },
  },
  create({ THREE, renderer, song, size, reducedMotion, text }) {
    if (${Boolean(o.throwOnCreate)}) throw new Error("stub refuses to start");
    const me = (log[${JSON.stringify(id)}] = {
      created: (log[${JSON.stringify(id)}]?.created || 0) + 1, disposed: 0, frames: 0, last: null, times: [],
      qualities: [], sizes: [size], reducedMotion, hasRenderer: Boolean(renderer),
      song: { duration: song.duration, bpm: song.bpm, hasNotes: song.hasNotes, beats: song.beats.length, bars: song.bars.length,
        sections: song.sections.length,
        stems: song.stems.map((s) => ({ name: s.name, color: s.color, peaks: s.peaks.length, notes: s.notes ? s.notes.length : null })) },
      name: text("name"),
    });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 100);
    camera.position.set(0, 0, 5);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    return {
      scene, camera,
      bloom: ${o.bloom ? '{ strength: 0.8, radius: 0.4, threshold: 0.2 }' : 'null'},
      update(frame) {
        me.frames++;
        me.last = JSON.parse(JSON.stringify(frame));
        me.times.push([frame.time, performance.now(), frame.jumped]);
        if (me.times.length > 600) me.times.shift();
        if (${Number(o.throwOnFrame) || 0} && me.frames >= ${Number(o.throwOnFrame) || 0}) throw new Error("stub broke while drawing");
        if (${Number(o.slowMs) || 0}) { const until = performance.now() + ${Number(o.slowMs) || 0}; while (performance.now() < until); }
        if (${Boolean(o.moveCamera)}) { camera.position.x += 0.05; camera.rotation.y += 0.01; }
        mesh.rotation.y = frame.time;
      },
      resize(s) { me.sizes.push(s); camera.aspect = s.width / s.height; camera.updateProjectionMatrix(); },
      setQuality(level) { me.qualities.push(level); },
      dispose() { me.disposed++; geometry.dispose(); material.dispose(); },
    };
  },
};`;
}

/**
 * Serve a registry of stubs in place of the real one. `scenes` is
 * [{ id, ...options }] ; an entry with `missing: true` is listed but its files
 * answer 404.
 */
async function stubRegistry(page, scenes) {
  const lines = scenes.map((s) => `  { id: ${JSON.stringify(s.id)}, load: () => import("./scenes/${s.id}/index.js") },`).join("\n");
  await page.route("**/js/viz/registry.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: `export const SCENES = [\n${lines}\n];\n` }));
  for (const s of scenes) {
    await page.route(`**/js/viz/scenes/${s.id}/index.js`, (route) =>
      s.missing
        ? route.fulfill({ status: 404, contentType: "text/plain", body: "not found" })
        : route.fulfill({ contentType: "text/javascript", body: stubScene(s.id, s) }));
  }
}

const stub = (page, id) => page.evaluate((i) => window.__viz?.[i] ?? null, id);
const TWO = [{ id: "stub-a", name: "Alpha" }, { id: "stub-b", name: "Beta" }];
const NOTES = { bass: [{ start: 0.5, end: 1, pitch: 40, velocity: 100 }, { start: 1.5, end: 2, pitch: 43, velocity: 90 }] };

test.use(GPU);

test.describe("Visualizer host", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
  });

  // ── A song can be opened in the Visualizer ──

  test("opens over the studio and closes back to it while the song keeps playing", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    const btn = page.locator("#t-viz-btn");
    await expect(btn).toBeVisible();
    await expect(btn.locator(".viz-badge")).toHaveText("Labs");
    await play(page);

    // Sample the engine's clock right through open and close: it must only
    // ever move forward, at the pace of the wall clock.
    await page.evaluate(async () => {
      const { transport } = await import("/js/transport.js");
      const s = (window.__audio = { samples: [], stopped: false });
      const tick = () => {
        s.samples.push([performance.now(), transport().getCurrentTime(), transport().isPlaying()]);
        if (!s.stopped) setTimeout(tick, 20);
      };
      tick();
    });
    const t0 = await now(page);
    await openViz(page);
    expect((await vizState(page)).scene).toBe("stub-a");
    await expect(page.locator("#viz .viz-title")).toHaveText("Visualizer");
    await expect(page.locator("#viz .viz-labs")).toHaveText("Labs");
    await expect(page.locator("#lanes")).toHaveAttribute("inert", "");
    await expect(page.locator(".daw-footer")).toBeVisible();
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    // The footer transport is still usable under the view.
    const layer = await page.locator("#viz").boundingBox();
    const footer = await page.locator(".daw-footer").boundingBox();
    expect(layer.y + layer.height).toBeLessThanOrEqual(footer.y + 1);
    await page.waitForTimeout(400);
    await closeViz(page);
    await page.waitForTimeout(200);
    const samples = await page.evaluate(() => { window.__audio.stopped = true; return window.__audio.samples; });

    expect(samples.every((s) => s[2] === true)).toBe(true);
    for (let i = 1; i < samples.length; i++) {
      const wall = (samples[i][0] - samples[i - 1][0]) / 1000;
      const audio = samples[i][1] - samples[i - 1][1];
      // No gap and no jump: audio time advanced with the wall clock.
      expect(audio).toBeGreaterThanOrEqual(0);
      expect(Math.abs(audio - wall)).toBeLessThan(0.12);
    }
    expect(await now(page)).toBeGreaterThan(t0);
    // The studio is as it was.
    await expect(page.locator("#lanes")).not.toHaveAttribute("inert", "");
    await expect(btn).toHaveAttribute("aria-pressed", "false");
    expect((await vizState(page)).open).toBe(false);
  });

  test("the button toggles the view and Escape closes it", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#viz")).toBeHidden();
    await openViz(page);
    await page.locator("#t-viz-btn").click();
    await expect(page.locator("#viz")).toBeHidden();
  });

  test("picking another visualization changes the picture without interrupting playback", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await play(page);
    await openViz(page);
    await expect(page.locator("#viz .viz-pick")).toHaveCount(2);
    await expect(page.locator('#viz .viz-pick[data-scene="stub-a"] .viz-pick-name')).toHaveText("Alpha");
    await expect(page.locator('#viz .viz-pick[data-scene="stub-a"]')).toHaveAttribute("aria-checked", "true");
    const before = await now(page);
    await pick(page, "stub-b");
    expect((await vizState(page)).scene).toBe("stub-b");
    await expect(page.locator('#viz .viz-pick[data-scene="stub-b"]')).toHaveAttribute("aria-checked", "true");
    expect((await stub(page, "stub-a")).disposed).toBe(1);
    await expect.poll(async () => (await stub(page, "stub-b")).frames).toBeGreaterThan(3);
    expect(await isPlaying(page)).toBe(true);
    expect(await now(page)).toBeGreaterThan(before);
  });

  test("the last choice is remembered", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    await pick(page, "stub-b");
    await closeViz(page);
    await openViz(page);
    expect((await vizState(page)).scene).toBe("stub-b");
    // And across a reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await page.waitForFunction(() => !/\/\s*00:00\s*$/.test(document.querySelector("#t-time")?.textContent || "00:00 / 00:00"));
    await openViz(page);
    expect((await vizState(page)).scene).toBe("stub-b");
  });

  test("the button is there in Practice and in Advanced", async ({ page }) => {
    await stubRegistry(page, TWO);
    await page.addInitScript(() => window.localStorage.setItem("stemdeck.mode", "practice"));
    await openStudio(page);
    expect(await page.evaluate(async () => (await import("/js/mode.js")).getMode())).toBe("practice");
    await expect(page.locator("#t-viz-btn")).toBeVisible();
    await openViz(page);
    expect((await vizState(page)).scene).toBe("stub-a");
    await closeViz(page);
    await page.evaluate(async () => (await import("/js/mode.js")).setMode("daw"));
    await page.waitForTimeout(700);
    await expect(page.locator("#t-viz-btn")).toBeVisible();
    await openViz(page);
    expect((await vizState(page)).scene).toBe("stub-a");
  });

  test("with nothing installed the Visualizer is not offered", async ({ page }) => {
    await stubRegistry(page, []);
    await openStudio(page);
    await expect(page.locator("#modeBtn")).toBeVisible();
    await expect(page.locator("#t-viz-btn")).toBeHidden();
    await expect(page.locator("#viz")).toHaveCount(0);
  });

  test("Karaoke closes the view and takes the button away", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    await page.evaluate(async () => (await import("/js/karaoke/karaoke.js")).openKaraoke());
    await expect(page.locator("#viz")).toBeHidden();
    await expect(page.locator("#t-viz-btn")).toBeHidden();
    expect((await vizState(page)).open).toBe(false);
  });

  // ── The picture follows playback ──

  test("the frame is the moment being heard: playing, paused, sought", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    await play(page);
    await page.waitForTimeout(500);
    const both = () => page.evaluate(async () => {
      const { transport } = await import("/js/transport.js");
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve([window.__viz["stub-a"].last, transport().getCurrentTime()]);
      })));
    });
    let [frame, heard] = await both();
    expect(frame.playing).toBe(true);
    expect(Math.abs(frame.time - heard)).toBeLessThan(0.05);
    // Smooth: while playing, the time given to the scene never steps back.
    const times = (await stub(page, "stub-a")).times;
    const tail = times.slice(-20);
    for (let i = 1; i < tail.length; i++) expect(tail[i][0]).toBeGreaterThanOrEqual(tail[i - 1][0]);

    await pause(page);
    await page.waitForTimeout(150);
    const held = (await stub(page, "stub-a")).last.time;
    await page.waitForTimeout(300);
    [frame, heard] = await both();
    expect(frame.playing).toBe(false);
    expect(frame.time).toBe(held);
    expect(Math.abs(frame.time - heard)).toBeLessThan(0.02);

    await seek(page, 4.2);
    await expect.poll(async () => (await stub(page, "stub-a")).last.time).toBeCloseTo(4.2, 1);
    await play(page);
    await seek(page, 1.0);
    await expect.poll(async () => Math.abs((await stub(page, "stub-a")).last.time - (await now(page)))).toBeLessThan(0.08);
    expect((await stub(page, "stub-a")).last.time).toBeLessThan(2.5);
  });

  test("a loop's jump back is followed", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    await page.evaluate(async () => (await import("/js/transport.js")).setLoopRange(1.0, 2.0));
    await seek(page, 1.6);
    await play(page);
    // Long enough to pass the loop's end at least once.
    await page.waitForTimeout(1400);
    const times = (await stub(page, "stub-a")).times;
    const seen = times.filter((x) => x[0] > 0.9).map((x) => x[0]);
    expect(Math.max(...seen)).toBeLessThan(2.15);
    // It went back: some frame is earlier than the one before it.
    expect(seen.some((v, i) => i > 0 && v < seen[i - 1] - 0.5)).toBe(true);
    expect(times.some((x) => x[2] === true)).toBe(true);
    const heard = await now(page);
    expect(Math.abs((await stub(page, "stub-a")).last.time - heard)).toBeLessThan(0.1);
  });

  test("at half speed the picture moves at half pace", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    await setSpeed(page, 0.5);
    await seek(page, 0.5);
    await play(page);
    // Measure once the audio is under way: the engine takes a moment to start.
    await expect.poll(() => now(page)).toBeGreaterThan(0.9);
    const times = (await stub(page, "stub-a")).times.filter((x) => x[0] >= 0.6);
    const first = times[0];
    const last = times[times.length - 1];
    expect(last[1] - first[1]).toBeGreaterThan(300);
    const pace = (last[0] - first[0]) / ((last[1] - first[1]) / 1000);
    // About half: wide enough for a machine that is busy with other test runs
    // (the audio clock and the frame clock are not the same clock), narrow
    // enough that full speed (1) or a stalled picture (0) cannot pass.
    expect(pace).toBeGreaterThan(0.3);
    expect(pace).toBeLessThan(0.7);
    const s = await stub(page, "stub-a");
    expect(s.last.rate).toBe(0.5);
    expect(Math.abs(s.last.time - (await now(page)))).toBeLessThan(0.08);
  });

  // ── The picture follows the mixer ──

  test("stems come in StemDeck's colours, and mute and solo reach the frame", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    const colors = await page.evaluate(async () => ({ ...(await import("/js/constants.js")).STEM_COLORS }));
    const s = await stub(page, "stub-a");
    expect(s.song.stems.map((x) => x.name)).toEqual(["vocals", "drums", "bass", "other"]);
    for (const st of s.song.stems) expect(st.color).toBe(colors[st.name]);

    const lit = async () => {
      const f = (await stub(page, "stub-a")).last;
      return Object.fromEntries(Object.entries(f.stems).map(([n, v]) => [n, v.lit]));
    };
    await expect.poll(lit).toEqual({ vocals: true, drums: true, bass: true, other: true });
    await setLane(page, "bass", { muted: true });
    await expect.poll(lit).toEqual({ vocals: true, drums: true, bass: false, other: true });
    await setLane(page, "bass", { muted: false });
    await setLane(page, "vocals", { soloed: true });
    await expect.poll(lit).toEqual({ vocals: true, drums: false, bass: false, other: false });
    await setLane(page, "vocals", { soloed: false });
    await expect.poll(lit).toEqual({ vocals: true, drums: true, bass: true, other: true });
  });

  // ── Silent, read-only, and served by StemDeck ──

  test("opening, trying every visualization and closing sends only same-origin GETs", async ({ page, baseURL }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await play(page);
    const audioContexts = await page.evaluate(() => {
      const Real = window.AudioContext;
      window.__newContexts = 0;
      window.AudioContext = class extends Real { constructor(...a) { super(...a); window.__newContexts++; } };
      return window.__newContexts;
    });
    expect(audioContexts).toBe(0);
    const seen = await requestsDuring(page, async () => {
      await openViz(page);
      await pick(page, "stub-b");
      await pick(page, "stub-a");
      await page.waitForTimeout(300);
      await closeViz(page);
    });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.filter((r) => r.method !== "GET")).toEqual([]);
    const origin = new URL(baseURL).origin;
    expect(seen.filter((r) => new URL(r.url).origin !== origin)).toEqual([]);
    // The 3D library came from StemDeck's own vendor folder.
    expect(seen.some((r) => r.url.endsWith("/vendor/three/three.module.js"))).toBe(true);
    // And it made no sound of its own.
    expect(await page.evaluate(() => window.__newContexts)).toBe(0);
  });

  test("the 3D library is not loaded until the Visualizer first opens", async ({ page }) => {
    await stubRegistry(page, TWO);
    const three = [];
    page.on("request", (r) => { if (r.url().includes("/vendor/three/")) three.push(r.url()); });
    await openStudio(page);
    await page.waitForTimeout(300);
    expect(three).toEqual([]);
    await openViz(page);
    expect(three.length).toBeGreaterThan(0);
  });

  // ── With or without notes ──

  test("a song with no transcription: loudness and beats reach a scene that can use them", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    const s = await stub(page, "stub-a");
    expect(s.song.hasNotes).toBe(false);
    expect(s.song.stems.every((x) => x.notes === null)).toBe(true);
    expect(s.song.stems.every((x) => x.peaks > 0)).toBe(true);
    expect(s.song.beats).toBe(12);
    expect(s.song.bars).toBe(3);
    expect(s.song.duration).toBe(6);
    await seek(page, 1.6);
    await expect.poll(async () => (await stub(page, "stub-a")).last.beat?.index).toBe(3);
    const f = (await stub(page, "stub-a")).last;
    expect(f.bar.index).toBe(0);
    expect(f.stems.drums.level).toBeGreaterThan(0);
  });

  test("a visualization that needs notes says so and offers Transcribe", async ({ page }) => {
    await stubTranscriptionAvailable(page);
    await stubRegistry(page, [{ id: "stub-a", name: "Alpha" }, { id: "stub-n", name: "Needy", needsNotes: true }]);
    await openStudio(page);
    await play(page);
    await openViz(page);
    await pick(page, "stub-n");
    const state = await vizState(page);
    expect(state.message).toBe("needsNotes");
    expect(state.scene).toBe(null);
    expect(await stub(page, "stub-n")).toBe(null);
    await expect(page.locator("#viz .viz-message-text")).toHaveText("Needy needs this song's notes.");
    await expect(page.locator("#viz .viz-canvas")).toBeHidden();
    const action = page.locator("#viz .viz-message-action");
    await expect(action).toHaveText("Transcribe");
    await action.click();
    await expect(page.locator("#transcribeDialog")).toBeVisible();
    // Escape belongs to the dialog while it is up, not to the view under it.
    await page.locator("#transcribeClose").click();
    await expect(page.locator("#viz")).toBeVisible();
    expect(await isPlaying(page)).toBe(true);
    // The others can still be chosen.
    await pick(page, "stub-a");
    expect((await vizState(page)).scene).toBe("stub-a");
  });

  test("notes that arrive while it waits start the visualization", async ({ page }) => {
    await stubTranscriptionAvailable(page);
    await stubRegistry(page, [{ id: "stub-n", name: "Needy", needsNotes: true }]);
    await openStudio(page);
    await openViz(page);
    expect((await vizState(page)).message).toBe("needsNotes");
    await page.locator("#viz .viz-message-action").click();
    await expect(page.locator("#transcribeDialog")).toBeVisible();
    // The song gets its notes while the dialog is open.
    await stubNotes(page, NOTES);
    await page.locator("#transcribeClose").click();
    await expect.poll(async () => (await vizState(page)).scene).toBe("stub-n");
    expect((await stub(page, "stub-n")).song.hasNotes).toBe(true);
  });

  test("with only the bass transcribed, the bass has notes and the others loudness", async ({ page }) => {
    await stubNotes(page, NOTES);
    await stubRegistry(page, [{ id: "stub-n", name: "Needy", needsNotes: true }]);
    await openStudio(page);
    await openViz(page);
    expect((await vizState(page)).scene).toBe("stub-n");
    const s = await stub(page, "stub-n");
    expect(Object.fromEntries(s.song.stems.map((x) => [x.name, x.notes]))).toEqual({ vocals: null, drums: null, bass: 2, other: null });
    expect(s.song.stems.every((x) => x.peaks > 0)).toBe(true);
  });

  test("without a beat grid the picture still follows playback and loudness", async ({ page }) => {
    await page.route(new RegExp(`/api/jobs/${JOB_ID}/beats$`), (route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 404, json: { detail: "beat grid not found" } }) : route.fallback());
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    const s = await stub(page, "stub-a");
    expect(s.song.beats).toBe(0);
    expect(s.song.bars).toBe(0);
    await seek(page, 2.5);
    await expect.poll(async () => (await stub(page, "stub-a")).last.time).toBeCloseTo(2.5, 1);
    const f = (await stub(page, "stub-a")).last;
    expect(f.beat).toBe(null);
    expect(f.bar).toBe(null);
    expect(f.stems.vocals.level).toBeGreaterThan(0);
  });

  // ── Stays responsive ──

  test("closed, it draws nothing and holds no graphics memory", async ({ page }) => {
    // With the glow on: its render targets are the host's to free too.
    await stubRegistry(page, [{ id: "stub-a", name: "Alpha", bloom: true }]);
    await openStudio(page);
    await openViz(page);
    await expect.poll(async () => (await vizState(page)).frames).toBeGreaterThan(5);
    const live = await vizState(page);
    expect(live.hasRenderer).toBe(true);
    expect(live.bloom).toBe(true);
    expect(live.memory.geometries).toBeGreaterThan(0);
    expect(live.memory.textures).toBeGreaterThan(0);
    await closeViz(page);
    const closed = await vizState(page);
    expect(closed.hasRenderer).toBe(false);
    expect(closed.drawing).toBe(false);
    expect(closed.lastDispose).toEqual({ geometries: 0, textures: 0 });
    const drawn = await stub(page, "stub-a");
    expect(drawn.disposed).toBe(1);
    await expect(page.locator("#viz canvas")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect((await vizState(page)).frames).toBe(closed.frames);
    expect((await stub(page, "stub-a")).frames).toBe(drawn.frames);
  });

  test("the glow is dropped when detail steps down to the lowest level", async ({ page }) => {
    await stubRegistry(page, [{ id: "stub-slow", name: "Slow", slowMs: 40, bloom: true }]);
    await openStudio(page);
    await openViz(page);
    await expect.poll(async () => (await vizState(page)).bloom).toBe(true);
    await expect.poll(async () => (await vizState(page)).quality, { timeout: 15000 }).toBe(0);
    expect((await vizState(page)).bloom).toBe(false);
  });

  test("a scene too heavy for the machine has its detail stepped down, and never back up", async ({ page }) => {
    await stubRegistry(page, [{ id: "stub-slow", name: "Slow", slowMs: 40 }]);
    await openStudio(page);
    await openViz(page);
    expect((await stub(page, "stub-slow")).qualities).toEqual([2]);
    await expect.poll(async () => (await vizState(page)).quality, { timeout: 15000 }).toBe(0);
    const q = (await stub(page, "stub-slow")).qualities;
    expect(q).toEqual([2, 1, 0]);
    await page.waitForTimeout(1500);
    expect((await stub(page, "stub-slow")).qualities).toEqual([2, 1, 0]);
    // Lower detail is a lower pixel ratio handed to the scene.
    const sizes = (await stub(page, "stub-slow")).sizes;
    expect(sizes[sizes.length - 1].pixelRatio).toBe(1);
  });

  test("a scene that keeps up is left at full detail", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    await page.waitForTimeout(3200);
    expect((await vizState(page)).quality).toBe(2);
  });

  test("drawing pauses while the window is hidden and resumes when it is shown", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await play(page);
    await openViz(page);
    await expect.poll(async () => (await vizState(page)).frames).toBeGreaterThan(5);
    const setHidden = (hidden) => page.evaluate((h) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
    await setHidden(true);
    const at = (await vizState(page)).frames;
    expect((await vizState(page)).drawing).toBe(false);
    await page.waitForTimeout(400);
    expect((await vizState(page)).frames).toBe(at);
    await setHidden(false);
    await expect.poll(async () => (await vizState(page)).frames).toBeGreaterThan(at + 5);
    // Back in step with the song, which kept playing.
    await expect.poll(async () => Math.abs((await stub(page, "stub-a")).last.time - (await now(page)))).toBeLessThan(0.08);
    expect((await vizState(page)).quality).toBe(2);
  });

  test("the canvas follows the size of the view", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    const before = (await stub(page, "stub-a")).sizes.at(-1);
    await page.setViewportSize({ width: 1200, height: 760 });
    await expect.poll(async () => (await stub(page, "stub-a")).sizes.at(-1).width).toBeLessThan(before.width);
    const box = await page.locator("#viz .viz-stage").boundingBox();
    const after = (await stub(page, "stub-a")).sizes.at(-1);
    expect(Math.abs(after.width - box.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.height - box.height)).toBeLessThanOrEqual(1);
  });

  // ── Degrades gracefully ──

  test("without 3D graphics it says so in plain words and closes cleanly", async ({ page }) => {
    await page.addInitScript(() => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
        if (/webgl/i.test(String(kind))) return null;
        return real.call(this, kind, ...rest);
      };
    });
    await stubRegistry(page, TWO);
    await openStudio(page);
    await play(page);
    await openViz(page);
    const state = await vizState(page);
    expect(state.message).toBe("noWebgl");
    expect(state.hasRenderer).toBe(false);
    await expect(page.locator("#viz .viz-message-text")).toHaveText("This computer cannot show the Visualizer.");
    await page.locator("#viz .viz-message-action").click();
    await expect(page.locator("#viz")).toBeHidden();
    await expect(page.locator("#lanes")).not.toHaveAttribute("inert", "");
    expect(await isPlaying(page)).toBe(true);
    // The studio still works.
    await pause(page);
  });

  test("a visualization that throws while starting says so; the others still work", async ({ page }) => {
    await stubRegistry(page, [{ id: "stub-bad", name: "Broken", throwOnCreate: true }, { id: "stub-a", name: "Alpha" }]);
    await openStudio(page);
    await play(page);
    await openViz(page);
    expect((await vizState(page)).message).toBe("failed");
    await expect(page.locator("#viz .viz-message-text")).toHaveText("Broken failed. The other visualizations still work.");
    expect(await isPlaying(page)).toBe(true);
    await pick(page, "stub-a");
    expect((await vizState(page)).scene).toBe("stub-a");
    await expect(page.locator("#viz .viz-message")).toBeHidden();
    await expect.poll(async () => (await stub(page, "stub-a")).frames).toBeGreaterThan(3);
    expect(await isPlaying(page)).toBe(true);
  });

  test("a visualization that throws while drawing is stopped and disposed", async ({ page }) => {
    await stubRegistry(page, [{ id: "stub-bad", name: "Broken", throwOnFrame: 5 }, { id: "stub-a", name: "Alpha" }]);
    await openStudio(page);
    await play(page);
    await openViz(page);
    await expect.poll(async () => (await vizState(page)).message).toBe("failed");
    const bad = await stub(page, "stub-bad");
    expect(bad.frames).toBe(5);
    expect(bad.disposed).toBe(1);
    expect(await isPlaying(page)).toBe(true);
    await pick(page, "stub-a");
    expect((await vizState(page)).scene).toBe("stub-a");
  });

  test("with reduce-motion on, the camera does not travel", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await stubRegistry(page, [{ id: "stub-m", name: "Mover", moveCamera: true }]);
    await openStudio(page);
    await play(page);
    await openViz(page);
    expect((await stub(page, "stub-m")).reducedMotion).toBe(true);
    await expect.poll(async () => (await vizState(page)).frames).toBeGreaterThan(5);
    const a = (await vizState(page)).camera;
    await page.waitForTimeout(400);
    const b = await vizState(page);
    expect(b.frames).toBeGreaterThan(10);
    expect(b.camera).toEqual(a);
    expect(b.reducedMotion).toBe(true);
  });

  test("without reduce-motion the same scene's camera is its own to move", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await stubRegistry(page, [{ id: "stub-m", name: "Mover", moveCamera: true }]);
    await openStudio(page);
    await openViz(page);
    expect((await stub(page, "stub-m")).reducedMotion).toBe(false);
    const a = (await vizState(page)).camera;
    await page.waitForTimeout(300);
    expect((await vizState(page)).camera).not.toEqual(a);
  });

  // ── Removal ──

  test("a visualization whose files are missing is left out, and the rest work", async ({ page }) => {
    await stubRegistry(page, [{ id: "stub-gone", missing: true }, { id: "stub-a", name: "Alpha" }, { id: "stub-b", name: "Beta" }]);
    await openStudio(page);
    await expect(page.locator("#t-viz-btn")).toBeVisible();
    await openViz(page);
    const state = await vizState(page);
    expect(state.installed).toEqual(["stub-a", "stub-b"]);
    expect(state.scene).toBe("stub-a");
    await expect(page.locator("#viz .viz-pick")).toHaveCount(2);
    await expect(page.locator('#viz .viz-pick[data-scene="stub-gone"]')).toHaveCount(0);
    await pick(page, "stub-b");
    expect((await vizState(page)).scene).toBe("stub-b");
  });

  test("a remembered visualization that is gone falls back to the first", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("stemdeck.viz.scene", "stub-gone"));
    await stubRegistry(page, [{ id: "stub-gone", missing: true }, { id: "stub-a", name: "Alpha" }]);
    await openStudio(page);
    await openViz(page);
    expect((await vizState(page)).scene).toBe("stub-a");
  });

  test("when every listed visualization is missing the view says none could be loaded", async ({ page }) => {
    await stubRegistry(page, [{ id: "stub-gone", missing: true }]);
    await openStudio(page);
    await openViz(page);
    expect((await vizState(page)).message).toBe("none");
    await expect(page.locator("#viz .viz-message-text")).toHaveText("No visualization could be loaded.");
    await page.locator("#viz .viz-message-action").click();
    await expect(page.locator("#viz")).toBeHidden();
  });

  // ── Strings ──

  test("the view and a visualization's own strings follow the app's language", async ({ page }) => {
    await stubRegistry(page, TWO);
    await openStudio(page);
    await openViz(page);
    await page.evaluate(async () => (await import("/js/i18n.js")).setLanguage("pl"));
    await expect(page.locator("#viz .viz-title")).toHaveText("Wizualizator");
    await expect(page.locator('#viz .viz-pick[data-scene="stub-a"] .viz-pick-name')).toHaveText("PL Alpha");
    // A language the visualization has no table for falls back to English.
    await page.evaluate(async () => (await import("/js/i18n.js")).setLanguage("de"));
    await expect(page.locator("#viz .viz-title")).toHaveText("Visualizer");
    await expect(page.locator('#viz .viz-pick[data-scene="stub-a"] .viz-pick-name')).toHaveText("Alpha");
  });
});
