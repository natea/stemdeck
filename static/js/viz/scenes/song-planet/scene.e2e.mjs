// Song planet in a real browser. Run by tests/e2e/viz-scenes.spec.mjs, which
// hands over Playwright's `test` and `expect` and the Visualizer's helpers.

const ID = "song-planet";
const SECTIONS = [
  { id: "s1", name: "Intro", start: 0, end: 2, color: "#ff8800", kind: "intro" },
  { id: "s2", name: "Verse", start: 2, end: 6, color: "#00aaff", kind: "verse" },
];

export default function define({ test, expect, h }) {
  const debug = async (page) => (await h.vizState(page)).debug;

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await h.rememberScene(page, ID);
  });

  test("draws, is halfway round at halfway, dims a muted stem and frees everything", async ({ page }) => {
    await h.stubSections(page, SECTIONS);
    await h.openStudio(page);
    await h.openViz(page);
    expect((await h.vizState(page)).scene).toBe(ID);
    await expect(page.locator(`#viz .viz-pick[data-scene="${ID}"] .viz-pick-name`)).toHaveText("Song planet");
    const d = await debug(page);
    expect(d.stems.map((s) => s.name)).toEqual(["vocals", "drums", "bass", "other"]);
    expect(d.sections).toBe(2);

    // A picture, not a blank canvas.
    await expect.poll(() => h.inkOf(page)).toBeGreaterThan(0.05);

    // The song is 6 s long: at 3 s the viewpoint is halfway round the planet.
    await h.seek(page, 3);
    await expect.poll(async () => (await debug(page)).viewAngle).toBeCloseTo(Math.PI, 1);
    // A quarter, and three quarters.
    await h.seek(page, 1.5);
    await expect.poll(async () => (await debug(page)).viewAngle).toBeCloseTo(Math.PI / 2, 1);
    await h.seek(page, 4.5);
    await expect.poll(async () => (await debug(page)).viewAngle).toBeCloseTo(Math.PI * 1.5, 1);

    // Mute every stem but one: the picture gets darker; each band's own tint drops.
    const tint = async (name) => (await debug(page)).stems.find((s) => s.name === name).tint;
    const drums = await tint("drums");
    const vocals = await tint("vocals");
    const before = await h.brightnessOf(page);
    await h.setLane(page, "drums", { muted: true });
    await expect.poll(() => tint("drums")).not.toBe(drums);
    expect(await tint("vocals")).toBe(vocals);
    await expect.poll(() => h.brightnessOf(page)).toBeLessThan(before);
    await h.setLane(page, "drums", { muted: false });
    await expect.poll(() => tint("drums")).toBe(drums);
    await h.setLane(page, "vocals", { soloed: true });
    await expect.poll(() => tint("drums")).not.toBe(drums);
    await h.setLane(page, "vocals", { soloed: false });

    await h.closeViz(page);
    expect((await h.vizState(page)).lastDispose).toEqual({ geometries: 0, textures: 0 });
  });

  test("the viewpoint travels with playback, and notes become crystals", async ({ page }) => {
    // Four notes where the fixture's bass is loud (a crystal stands only where
    // its ring rises above the ground), and one where it is silent.
    const loud = [0.42, 1.27, 2.12, 2.97];
    await h.stubNotes(page, { bass: [...loud.map((start, i) => ({ start, end: start + 0.3, pitch: 40 + i * 2, velocity: 100 })), { start: 0.85, end: 0.9, pitch: 50, velocity: 100 }] });
    await h.openStudio(page);
    await h.openViz(page);
    expect((await debug(page)).stems.find((s) => s.name === "bass").crystals).toBe(4);
    await h.seek(page, 0.5);
    await h.play(page);
    const a = await h.vizAndNow(page);
    const expected = (now) => (now / 6) * Math.PI * 2;
    expect(Math.abs(a.state.debug.viewAngle - expected(a.now))).toBeLessThan(0.25);
    await expect.poll(async () => (await h.now(page)) - a.now).toBeGreaterThan(0.5);
    const b = await h.vizAndNow(page);
    expect(b.state.debug.viewAngle).toBeGreaterThan(a.state.debug.viewAngle);
    expect(Math.abs(b.state.debug.viewAngle - expected(b.now))).toBeLessThan(0.25);
  });

  test("with reduce-motion the viewpoint stays and the planet turns", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await h.openStudio(page);
    await h.openViz(page);
    expect((await debug(page)).calm).toBe(true);
    await h.seek(page, 0.5);
    const cam = (await h.vizState(page)).camera;
    await h.seek(page, 3);
    await expect.poll(async () => (await debug(page)).viewAngle).toBeCloseTo(Math.PI, 1);
    expect((await h.vizState(page)).camera).toEqual(cam);
  });
}
