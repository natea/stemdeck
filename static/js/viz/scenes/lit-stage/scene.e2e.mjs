// Lit stage in a real browser. Run by tests/e2e/viz-scenes.spec.mjs, which
// hands over Playwright's `test` and `expect` and the Visualizer's helpers.

const ID = "lit-stage";

// The piano plays a C major chord at 1 s; the drums a kick and a hi-hat with it.
const NOTES = {
  piano: [60, 64, 67].map((pitch) => ({ start: 1, end: 2, pitch, velocity: 100 })),
  drums: [{ start: 1, end: 1.4, pitch: 36, velocity: 110 }, { start: 1, end: 1.4, pitch: 42, velocity: 80 }, { start: 3, end: 3.4, pitch: 38, velocity: 100 }],
};

export default function define({ test, expect, h }) {
  const debug = async (page) => (await h.vizState(page)).debug;

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await h.rememberScene(page, ID);
  });

  test("on a song without notes it offers Transcribe and starts nothing", async ({ page }) => {
    await h.stubTranscriptionAvailable(page);
    await h.openStudio(page);
    await h.openViz(page);
    const state = await h.vizState(page);
    expect(state.chosen).toBe(ID);
    expect(state.scene).toBe(null);
    expect(state.message).toBe("needsNotes");
    await expect(page.locator("#viz .viz-message-text")).toHaveText("Lit stage needs this song's notes.");
    await expect(page.locator("#viz .viz-message-action")).toHaveText("Transcribe");
  });

  test("a note lights its key, a stem without notes stays unlit and is named, and everything is freed", async ({ page }) => {
    await h.stubExtraStem(page, "piano");
    await h.stubNotes(page, NOTES);
    await h.openStudio(page);
    await h.openViz(page);
    expect((await h.vizState(page)).scene).toBe(ID);
    await expect(page.locator(`#viz .viz-pick[data-scene="${ID}"] .viz-pick-name`)).toHaveText("Lit stage");

    // The stems that have no notes yet are on stage, unlit, and named.
    const d = await debug(page);
    expect(d.unlit).toEqual(["vocals", "bass", "other"]);
    expect(d.trims.bass).toBe("none");
    expect(d.trims.keyboard).toBe("on");
    expect(d.trims.kit).toBe("on");
    await expect(page.locator("#viz .viz-caption")).toHaveText("No notes yet: Vocals, Bass, Other");

    // A picture, not a blank canvas, even with nothing sounding.
    await h.seek(page, 0.2);
    await expect.poll(async () => (await debug(page)).lit.keys).toEqual([]);
    await expect.poll(() => h.inkOf(page)).toBeGreaterThan(0.01);
    const dark = await h.brightnessOf(page);

    // The chord: its three keys light, and the kick and the hi-hat with them.
    await h.seek(page, 1.2);
    await expect.poll(async () => (await debug(page)).lit.keys).toEqual([60, 64, 67]);
    expect((await debug(page)).lit.kit).toEqual(["kick", "hihat"]);
    expect((await debug(page)).lit.bass).toEqual([]);
    await expect.poll(() => h.brightnessOf(page)).toBeGreaterThan(dark);
    // After the notes end they fade and go out.
    await h.seek(page, 2.6);
    await expect.poll(async () => (await debug(page)).lit.keys).toEqual([]);
    // The snare, later.
    await h.seek(page, 3.1);
    await expect.poll(async () => (await debug(page)).lit.kit).toEqual(["snare"]);

    // Mute the piano: its keys stop lighting, the drums carry on.
    await h.seek(page, 1.2);
    await expect.poll(async () => (await debug(page)).lit.keys).toEqual([60, 64, 67]);
    await h.setLane(page, "piano", { muted: true });
    await expect.poll(async () => (await debug(page)).lit.keys).toEqual([]);
    expect((await debug(page)).trims.keyboard).toBe("muted");
    expect((await debug(page)).lit.kit).toEqual(["kick", "hihat"]);
    await h.setLane(page, "piano", { muted: false });
    await expect.poll(async () => (await debug(page)).lit.keys).toEqual([60, 64, 67]);

    await h.closeViz(page);
    expect((await h.vizState(page)).lastDispose).toEqual({ geometries: 0, textures: 0 });
  });

  test("the caption is in the app's language", async ({ page }) => {
    await h.stubNotes(page, { drums: NOTES.drums });
    await h.openStudio(page);
    await page.evaluate(async () => (await import("/js/i18n.js")).setLanguage("de"));
    await h.openViz(page);
    await expect(page.locator("#viz .viz-caption")).toContainText("Noch keine Noten:");
  });
}
