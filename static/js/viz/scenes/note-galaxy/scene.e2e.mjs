// Note galaxy in a real browser. Run by tests/e2e/viz-scenes.spec.mjs, which
// hands over Playwright's `test` and `expect` and the Visualizer's helpers.

const ID = "note-galaxy";

// A chord on the bass at 1 s, single vocal notes after it.
const NOTES = {
  bass: [40, 44, 47].map((pitch) => ({ start: 1, end: 2.2, pitch, velocity: 120 })),
  vocals: [{ start: 3, end: 3.8, pitch: 64, velocity: 100 }, { start: 4.5, end: 5, pitch: 67, velocity: 60 }],
};

export default function define({ test, expect, h }) {
  const debug = async (page) => (await h.vizState(page)).debug;
  const stem = async (page, name) => (await debug(page)).stems.find((s) => s.name === name);

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await h.rememberScene(page, ID);
  });

  test("on a song without notes it offers Transcribe and starts nothing", async ({ page }) => {
    await h.stubTranscriptionAvailable(page);
    await h.openStudio(page);
    await h.play(page);
    await h.openViz(page);
    const state = await h.vizState(page);
    expect(state.chosen).toBe(ID);
    expect(state.scene).toBe(null);
    expect(state.message).toBe("needsNotes");
    await expect(page.locator("#viz .viz-message-text")).toHaveText("Note galaxy needs this song's notes.");
    await expect(page.locator("#viz .viz-message-action")).toHaveText("Transcribe");
    await expect(page.locator("#viz .viz-canvas")).toHaveCount(0);
    expect(await h.isPlaying(page)).toBe(true);
  });

  test("with notes it draws, follows a seek, dims a muted stem and frees everything", async ({ page }) => {
    await h.stubNotes(page, NOTES);
    await h.openStudio(page);
    await h.openViz(page);
    expect((await h.vizState(page)).scene).toBe(ID);
    await expect(page.locator(`#viz .viz-pick[data-scene="${ID}"] .viz-pick-name`)).toHaveText("Note galaxy");
    const d = await debug(page);
    expect(d.stems.map((s) => s.name)).toEqual(["vocals", "drums", "bass", "other"]);
    expect(d.stems.map((s) => s.notes)).toEqual([2, 0, 3, 0]);

    // A picture, not a blank canvas: the arms are there before any note.
    await h.seek(page, 0.2);
    await expect.poll(async () => (await debug(page)).points).toBe(0);
    await expect.poll(() => h.inkOf(page)).toBeGreaterThan(0.001);

    // Seek into the chord: three bursts together on the bass's arm.
    await h.seek(page, 1.3);
    await expect.poll(async () => (await stem(page, "bass")).bursts).toBe(3);
    expect((await stem(page, "vocals")).bursts).toBe(0);
    const lit = await h.brightnessOf(page);
    // Seek on to the vocal note: one burst, on the other arm.
    await h.seek(page, 3.2);
    await expect.poll(async () => (await stem(page, "vocals")).bursts).toBe(1);
    expect((await stem(page, "bass")).bursts).toBe(0);
    // And back.
    await h.seek(page, 1.3);
    await expect.poll(async () => (await stem(page, "bass")).bursts).toBe(3);

    // Mute the bass: its notes make no light and its arm fades.
    const arm = (await stem(page, "bass")).arm;
    await h.setLane(page, "bass", { muted: true });
    await expect.poll(async () => (await debug(page)).points).toBe(0);
    expect((await stem(page, "bass")).arm).toBeLessThan(arm / 3);
    await expect.poll(() => h.brightnessOf(page)).toBeLessThan(lit);
    await h.setLane(page, "bass", { muted: false });
    await expect.poll(async () => (await debug(page)).points).toBeGreaterThan(0);
    // Solo the vocals: the bass goes dark the same way.
    await h.setLane(page, "vocals", { soloed: true });
    await expect.poll(async () => (await debug(page)).points).toBe(0);
    await h.setLane(page, "vocals", { soloed: false });

    await h.closeViz(page);
    expect((await h.vizState(page)).lastDispose).toEqual({ geometries: 0, textures: 0 });
  });

  test("with reduce-motion the galaxy holds still and nothing bursts", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await h.stubNotes(page, NOTES);
    await h.openStudio(page);
    await h.openViz(page);
    expect((await debug(page)).calm).toBe(true);
    await h.seek(page, 1.3);
    // One steady dot per sounding note.
    await expect.poll(async () => (await debug(page)).points).toBe(3);
    const turn = (await debug(page)).turn;
    await h.seek(page, 4.6);
    await expect.poll(async () => (await debug(page)).points).toBe(1);
    expect((await debug(page)).turn).toBe(turn);
  });
}
