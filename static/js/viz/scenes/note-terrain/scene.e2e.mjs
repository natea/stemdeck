// Note terrain in a real browser. Run by tests/e2e/viz-scenes.spec.mjs, which
// hands over Playwright's `test` and `expect` and the Visualizer's helpers.

const ID = "note-terrain";
const SPEED = 8; // map.js: world units per second of song

const NOTES = {
  bass: [40, 43, 45, 47, 48, 50].map((pitch, i) => ({ start: i * 0.9, end: i * 0.9 + 0.7, pitch, velocity: 70 + i * 8 })),
  vocals: [{ start: 1, end: 2.5, pitch: 64, velocity: 110 }, { start: 3, end: 4.5, pitch: 67, velocity: 90 }],
};

export default function define({ test, expect, h }) {
  const debug = async (page) => (await h.vizState(page)).debug;

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await h.rememberScene(page, ID);
  });

  test("starts, draws, follows a seek, dims a muted stem and frees everything", async ({ page }) => {
    await h.stubNotes(page, NOTES);
    await h.openStudio(page);
    await h.openViz(page);
    const state = await h.vizState(page);
    expect(state.scene).toBe(ID);
    expect(state.message).toBe(null);
    await expect(page.locator(`#viz .viz-pick[data-scene="${ID}"] .viz-pick-name`)).toHaveText("Note terrain");

    // The bass and the vocals are drawn from their notes, the rest from loudness.
    const d = await debug(page);
    expect(d.plan.noted).toEqual(["vocals", "bass"]);
    expect(d.plan.ridged).toEqual(["drums", "other"]);

    // A picture, not a blank canvas.
    await h.seek(page, 1.2);
    await expect.poll(() => h.inkOf(page)).toBeGreaterThan(0.02);

    // A seek moves the landscape to the same moment.
    await h.seek(page, 4);
    await expect.poll(async () => (await debug(page)).landscapeZ).toBeCloseTo(4 * SPEED, 0);
    await h.seek(page, 1.2);
    await expect.poll(async () => (await debug(page)).landscapeZ).toBeCloseTo(1.2 * SPEED, 0);

    // Mute the drums: their ridge loses its colour, the others keep theirs.
    const tint = async (name) => (await debug(page)).stems.find((s) => s.name === name).tint;
    const drums = await tint("drums");
    const bass = await tint("bass");
    const before = await h.brightnessOf(page);
    await h.setLane(page, "drums", { muted: true });
    await expect.poll(() => tint("drums")).not.toBe(drums);
    expect(await tint("bass")).toBe(bass);
    await expect.poll(() => h.brightnessOf(page)).toBeLessThan(before);
    // Solo the vocals: everything else goes dark too.
    await h.setLane(page, "drums", { muted: false });
    await h.setLane(page, "vocals", { soloed: true });
    await expect.poll(() => tint("bass")).not.toBe(bass);
    await h.setLane(page, "vocals", { soloed: false });
    await expect.poll(() => tint("bass")).toBe(bass);

    await h.closeViz(page);
    expect((await h.vizState(page)).lastDispose).toEqual({ geometries: 0, textures: 0 });
  });

  test("on a song with no notes each stem is a ridge that moves with playback", async ({ page }) => {
    await h.openStudio(page);
    await h.openViz(page);
    const d = await debug(page);
    expect(d.plan.noted).toEqual([]);
    expect(d.plan.ridged).toEqual(["vocals", "drums", "bass", "other"]);
    expect(d.stems.every((s) => s.blocks > 0)).toBe(true);
    await h.seek(page, 1);
    await expect.poll(() => h.inkOf(page)).toBeGreaterThan(0.05);
    // Playing: the landscape is at the moment being heard, and keeps up.
    await h.play(page);
    const first = await h.vizAndNow(page);
    expect(Math.abs(first.state.debug.landscapeZ / SPEED - first.now)).toBeLessThan(0.2);
    await expect.poll(async () => (await h.now(page)) - first.now).toBeGreaterThan(0.4);
    const later = await h.vizAndNow(page);
    expect(later.state.debug.landscapeZ).toBeGreaterThan(first.state.debug.landscapeZ);
    expect(Math.abs(later.state.debug.landscapeZ / SPEED - later.now)).toBeLessThan(0.2);
  });

  test("with reduce-motion the landscape holds still and the line walks", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await h.openStudio(page);
    await h.openViz(page);
    expect((await debug(page)).calm).toBe(true);
    expect((await h.vizState(page)).bloom).toBe(false);
    await h.seek(page, 0.5);
    const a = await debug(page);
    const cam = (await h.vizState(page)).camera;
    await h.seek(page, 3);
    await expect.poll(async () => (await debug(page)).lineZ).toBeCloseTo(-3 * SPEED, 0);
    const b = await debug(page);
    // The song moved on; the landscape and the camera did not.
    expect(b.landscapeZ).toBe(a.landscapeZ);
    expect(b.lineZ).toBeLessThan(a.lineZ);
    expect((await h.vizState(page)).camera).toEqual(cam);
  });
}
