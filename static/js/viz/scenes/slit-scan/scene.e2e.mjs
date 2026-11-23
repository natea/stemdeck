// Slit-scan score in a real browser. Run by tests/e2e/viz-scenes.spec.mjs,
// which hands over Playwright's `test` and `expect` and the Visualizer's helpers.

const ID = "slit-scan";
const STRIP = { x0: 0.07, x1: 0.93, y0: 0.16, y1: 0.86 }; // map.js

const NOTES = {
  bass: [40, 43, 45, 47, 48, 50].map((pitch, i) => ({ start: i * 0.9, end: i * 0.9 + 0.7, pitch, velocity: 90 })),
};

export default function define({ test, expect, h }) {
  const debug = async (page) => (await h.vizState(page)).debug;
  // Click a point of the canvas given as fractions of its width and height.
  const clickAt = async (page, fx, fy) => {
    const box = await page.locator("#viz .viz-canvas").boundingBox();
    await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
  };

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await h.rememberScene(page, ID);
  });

  test("draws the whole song, seeks on a click, dims a muted stem and frees everything", async ({ page }) => {
    await h.stubNotes(page, NOTES);
    await h.openStudio(page);
    await h.openViz(page);
    expect((await h.vizState(page)).scene).toBe(ID);
    await expect(page.locator(`#viz .viz-pick[data-scene="${ID}"] .viz-pick-name`)).toHaveText("Slit-scan score");
    const d = await debug(page);
    expect(d.bands.map((b) => b.name)).toEqual(["vocals", "drums", "bass", "other"]);

    // A picture, not a blank canvas: the bands cover most of the view.
    await expect.poll(() => h.inkOf(page)).toBeGreaterThan(0.2);

    // A click two thirds of the way along the strip is two thirds of the song.
    const twoThirds = STRIP.x0 + (2 / 3) * (STRIP.x1 - STRIP.x0);
    await clickAt(page, twoThirds, 0.5);
    await expect.poll(() => h.now(page)).toBeCloseTo(4, 1);
    await expect.poll(async () => (await debug(page)).headX).toBeCloseTo(twoThirds, 2);
    // And a quarter.
    await clickAt(page, STRIP.x0 + 0.25 * (STRIP.x1 - STRIP.x0), 0.3);
    await expect.poll(() => h.now(page)).toBeCloseTo(1.5, 1);
    // Outside the strip nothing happens.
    await clickAt(page, 0.01, 0.5);
    await clickAt(page, 0.5, 0.03);
    await page.waitForTimeout(150);
    expect(await h.now(page)).toBeCloseTo(1.5, 1);

    // Mute the drums: their band, the second from the top, goes dark.
    const band = d.bands[1].rect;
    const region = { x: 0.2, y: band.y0, w: 0.6, h: band.y1 - band.y0 };
    const other = { x: 0.2, y: d.bands[0].rect.y0, w: 0.6, h: d.bands[0].rect.y1 - d.bands[0].rect.y0 };
    const before = await h.brightnessOf(page, region);
    const otherBefore = await h.brightnessOf(page, other);
    await h.setLane(page, "drums", { muted: true });
    await expect.poll(() => h.brightnessOf(page, region)).toBeLessThan(before * 0.5);
    expect(await h.brightnessOf(page, other)).toBeGreaterThan(otherBefore * 0.9);
    await h.setLane(page, "drums", { muted: false });
    await expect.poll(() => h.brightnessOf(page, region)).toBeGreaterThan(before * 0.9);
    // Solo the vocals: the drums' band goes dark again.
    await h.setLane(page, "vocals", { soloed: true });
    await expect.poll(() => h.brightnessOf(page, region)).toBeLessThan(before * 0.5);
    await h.setLane(page, "vocals", { soloed: false });

    await h.closeViz(page);
    expect((await h.vizState(page)).lastDispose).toEqual({ geometries: 0, textures: 0 });
  });

  test("the line follows playback across the strip, and a click seeks while playing", async ({ page }) => {
    await h.openStudio(page);
    await h.openViz(page);
    await h.seek(page, 0.5);
    await h.play(page);
    const a = await h.vizAndNow(page);
    const expected = (now) => STRIP.x0 + (now / 6) * (STRIP.x1 - STRIP.x0);
    expect(Math.abs(a.state.debug.headX - expected(a.now))).toBeLessThan(0.03);
    await clickAt(page, STRIP.x0 + 0.5 * (STRIP.x1 - STRIP.x0), 0.5);
    await expect.poll(() => h.now(page)).toBeGreaterThan(2.9);
    expect(await h.isPlaying(page)).toBe(true);
    const b = await h.vizAndNow(page);
    expect(b.state.debug.headX).toBeGreaterThan(a.state.debug.headX);
    expect(Math.abs(b.state.debug.headX - expected(b.now))).toBeLessThan(0.03);
  });
}
