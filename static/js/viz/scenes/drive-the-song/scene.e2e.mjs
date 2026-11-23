// Drive the song in a real browser. Run by tests/e2e/viz-scenes.spec.mjs,
// which hands over Playwright's `test` and `expect` and the Visualizer's helpers.

const ID = "drive-the-song";
const UNITS_PER_BEAT = 8; // map.js
const pace = (bpm) => (bpm / 60) * UNITS_PER_BEAT;

export default function define({ test, expect, h }) {
  const debug = async (page) => (await h.vizState(page)).debug;

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await h.rememberScene(page, ID);
  });

  // Open the fixture song at a tempo and read how fast its road passes.
  async function paceAt(page, bpm) {
    await h.stubTempo(page, bpm);
    await h.openStudio(page);
    await h.openViz(page);
    expect((await h.vizState(page)).scene).toBe(ID);
    await h.seek(page, 3);
    await expect.poll(async () => (await debug(page)).distance).toBeCloseTo(3 * pace(bpm), 0);
    return debug(page);
  }

  test("draws, and the road passes at 80 beats a minute's pace", async ({ page }) => {
    const d = await paceAt(page, 80);
    await expect(page.locator(`#viz .viz-pick[data-scene="${ID}"] .viz-pick-name`)).toHaveText("Drive the song");
    expect(d.pace).toBeCloseTo(pace(80), 3);
    expect(d.beatsKnown).toBe(true);
    expect(d.bars).toBe(2);
    // A picture, not a blank canvas.
    await expect.poll(() => h.inkOf(page)).toBeGreaterThan(0.02);

    // Playing, the viewer is at the moment being heard and keeps up.
    await h.seek(page, 0.5);
    await h.play(page);
    const a = await h.vizAndNow(page);
    expect(Math.abs(a.state.debug.distance - a.now * pace(80))).toBeLessThan(0.25 * pace(80));
    await expect.poll(async () => (await h.now(page)) - a.now).toBeGreaterThan(0.4);
    const b = await h.vizAndNow(page);
    expect(b.state.debug.distance).toBeGreaterThan(a.state.debug.distance);
    expect(b.state.debug.cameraZ).toBeLessThan(a.state.debug.cameraZ);
  });

  test("at 160 beats a minute the road passes at twice the pace", async ({ page }) => {
    const d = await paceAt(page, 160);
    expect(d.pace).toBeCloseTo(2 * pace(80), 3);
    expect(d.distance).toBeCloseTo(2 * 3 * pace(80), 0);
  });

  test("drum notes are bumps, a muted stem dims, and everything is freed", async ({ page }) => {
    await h.stubNotes(page, { drums: [{ start: 2, end: 2.1, pitch: 38, velocity: 127 }, { start: 4, end: 4.1, pitch: 36, velocity: 100 }] });
    await h.openStudio(page);
    await h.openViz(page);
    let d = await debug(page);
    expect(d.hitsFrom).toBe("notes");
    expect(d.hits).toBe(2);
    expect(d.stems.map((s) => s.name)).toEqual(["vocals", "bass", "other"]);
    // On the hit the view lifts; between hits it does not.
    await h.seek(page, 3);
    await expect.poll(async () => (await debug(page)).lift).toBe(0);
    const flat = (await debug(page)).cameraY;
    await h.seek(page, 2);
    await expect.poll(async () => (await debug(page)).lift).toBeGreaterThan(0.8);
    expect((await debug(page)).cameraY).toBeGreaterThan(flat);
    // Muted drums: no lift.
    await h.setLane(page, "drums", { muted: true });
    await expect.poll(async () => (await debug(page)).lift).toBe(0);
    await h.setLane(page, "drums", { muted: false });

    // Mute the bass: its posts go dark, the vocals' stay.
    const tint = async (name) => (await debug(page)).stems.find((s) => s.name === name).tint;
    const bass = await tint("bass");
    const vocals = await tint("vocals");
    const before = await h.brightnessOf(page);
    await h.setLane(page, "bass", { muted: true });
    await expect.poll(() => tint("bass")).not.toBe(bass);
    expect(await tint("vocals")).toBe(vocals);
    await expect.poll(() => h.brightnessOf(page)).toBeLessThan(before);
    await h.setLane(page, "bass", { muted: false });
    await expect.poll(() => tint("bass")).toBe(bass);

    await h.closeViz(page);
    expect((await h.vizState(page)).lastDispose).toEqual({ geometries: 0, textures: 0 });
  });

  test("without drum notes the bumps come from the drums' loudness", async ({ page }) => {
    await h.openStudio(page);
    await h.openViz(page);
    const d = await debug(page);
    expect(d.hitsFrom).toBe("loudness");
    expect(d.hits).toBeGreaterThan(0);
  });

  test("with reduce-motion the camera holds while the song moves on", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await h.stubTempo(page, 120);
    await h.openStudio(page);
    await h.openViz(page);
    expect((await debug(page)).calm).toBe(true);
    await h.seek(page, 0.5);
    await expect.poll(async () => (await debug(page)).distance).toBeCloseTo(0.5 * pace(120), 0);
    const cam = (await h.vizState(page)).camera;
    await h.seek(page, 4);
    await expect.poll(async () => (await debug(page)).distance).toBeCloseTo(4 * pace(120), 0);
    expect((await h.vizState(page)).camera).toEqual(cam);
    expect((await debug(page)).lift).toBe(0);
  });
}
