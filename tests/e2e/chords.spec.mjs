// The Chords strip (Labs), driven in a
// real browser against the real backend with only the chord endpoints stubbed.
// A real detection loads a model and listens to the song; what is under test
// here is the strip: what it offers, what it sends, what it shows for each
// answer, and that it follows playback, the key and the corrections.
//
// The seeded song is 6 seconds long, in C major, with a beat every half second.

import { test, expect } from "@playwright/test";
import { openStudio, JOB_ID } from "./helpers.mjs";

const CHORDS = new RegExp(`/api/jobs/${JOB_ID}/chords(\\?.*)?$`);
const STATE = new RegExp(`/api/jobs/${JOB_ID}$`);
const CONFIG = /\/api\/config$/;
const BEATS = Array.from({ length: 12 }, (_, i) => i * 0.5);

const C = { root: 0, degrees: ["1", "3", "5"], bass: null };
const C7 = { root: 0, degrees: ["1", "3", "5", "b7"], bass: null };
const F = { root: 5, degrees: ["1", "3", "5"], bass: null };
const NONE = { root: null, degrees: [], bass: null };

// A second of nothing, C, C7 over a walking bass (E, then G), and F.
const TIMELINE = [
  { start: 0, end: 1, ...NONE, label: "N" },
  { start: 1, end: 2, ...C, label: "C:maj" },
  { start: 2, end: 3, ...C7, bass: 4, label: "C:7/3" },
  { start: 3, end: 4, ...C7, bass: 7, label: "C:7/5" },
  { start: 4, end: 6, ...F, label: "F:maj" },
];

const ui = (page) => ({
  rail: page.locator("#t-chords-btn"),
  ribbon: page.locator("#chordStrip"),
  area: page.locator("#daw-chords"),
  blocks: page.locator("#daw-chords-track .chord-block"),
  named: page.locator("#daw-chords-track .chord-block:not(.none)"),
  block: (text) => page.locator("#daw-chords-track .chord-block", { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`) }),
  // A gap under the playhead is marked too, and shows nothing: only a chord counts as lit.
  current: page.locator("#daw-chords-track .chord-block.current:not(.none)"),
  note: page.locator("#chordsNote"),
  detect: page.locator("#chordsDetectBtn"),
  cancel: page.locator("#chordsCancelBtn"),
  bass: page.locator("#chordsBassBtn"),
  edit: page.locator("#chordsEditBtn"),
  reset: page.locator("#chordsResetBtn"),
  saved: page.locator("#chordsSaveIndicator"),
  pop: page.locator("#chordsPopover"),
  input: page.locator("#chordsPopInput"),
  popError: page.locator("#chordsPopError"),
  act: (name) => page.locator(`#chordsPopover button[data-act="${name}"]`),
});

/**
 * Stand in for the chord endpoints and for what the song's state and
 * /api/config say about chords. `detected` and `user` are the two files the
 * server keeps; `run` decides what a POST answers.
 */
async function stubChords(page, { detected = null, user = null, available = true, run = null } = {}) {
  const calls = { gets: 0, posts: 0, patches: [], deletes: 0, cancels: 0, release: null };
  const server = { detected, user, job: { chords: detected ? "done" : "none", chords_reason: null, chords_progress: null } };

  await page.route(CONFIG, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), chords_available: available } });
  });
  await page.route(STATE, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), ...server.job } });
  });
  await page.route(new RegExp(`/api/jobs/${JOB_ID}/cancel$`), async (route) => {
    calls.cancels += 1;
    await route.fulfill({ json: { job_id: JOB_ID, status: "done" } });
  });
  await page.route(CHORDS, async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === "GET") {
      calls.gets += 1;
      const wantDetected = new URL(request.url()).searchParams.get("source") === "detected" || !server.user;
      const chords = wantDetected ? server.detected : server.user;
      if (!chords) return route.fulfill({ status: 404, json: { detail: "no chords" } });
      return route.fulfill({
        headers: { "Cache-Control": "no-store" },
        json: {
          job_id: JOB_ID, chords, source: wantDetected ? "detected" : "user", edited: Boolean(server.user),
          has_detected: Boolean(server.detected), aligned: true, beats: BEATS,
          named: chords.filter((c) => c.root !== null).length,
          engine: "lv-chordia", engine_version: "1.1.0", vocabulary: "full", duration: 6,
        },
      });
    }
    if (method === "POST") {
      calls.posts += 1;
      server.job = { chords: "running", chords_reason: null, chords_progress: { phase: "detecting", percent: 40 } };
      // Held until the test lets it go, so the running state can be looked at.
      await new Promise((resolve) => { calls.release = resolve; });
      calls.release = null;
      const answer = (run || (() => ({ timeline: TIMELINE })))();
      if (answer.timeline) server.detected = answer.timeline;
      const ok = !answer.reason && !answer.status;
      server.job = { chords: ok ? "done" : "error", chords_reason: answer.reason || null, chords_progress: null };
      return route.fulfill({
        status: answer.status || (ok ? 200 : 500),
        json: answer.body || {
          job_id: JOB_ID, status: "done", ...server.job,
          chords_found: answer.found ?? true, chords_edited: Boolean(server.user),
        },
      });
    }
    if (method === "PATCH") {
      const body = request.postDataJSON();
      calls.patches.push(body);
      server.user = body.chords;
      return route.fulfill({ json: { job_id: JOB_ID, chords: body.chords.length, edited: true } });
    }
    if (method === "DELETE") {
      calls.deletes += 1;
      server.user = null;
      return route.fulfill({ json: { job_id: JOB_ID, edited: false, has_detected: Boolean(server.detected) } });
    }
    return route.fallback();
  });
  return { calls, server };
}

/** The strip's own two choices, as a visitor left them last time. */
async function remember(page, { on = true, bass = false } = {}) {
  await page.addInitScript(([onValue, bassValue]) => {
    // Once: a test that reloads must find what the page itself stored.
    if (window.sessionStorage.getItem("chords-seeded")) return;
    window.sessionStorage.setItem("chords-seeded", "1");
    window.localStorage.setItem("stemdeck.chords.on", onValue ? "1" : "0");
    window.localStorage.setItem("stemdeck.chords.bass", bassValue ? "1" : "0");
  }, [on, bass]);
}

const texts = (locator) => locator.allTextContents();

async function release(calls) {
  await expect.poll(() => calls.release !== null).toBe(true);
  calls.release();
}

/** The last list the page saved, as (start, end, root) rows, or null. */
const saved = (calls) => calls.patches.at(-1)?.chords.map((c) => [c.start, c.end, c.root]) ?? null;

/** Wait until the last save is `rows`. Saves are debounced, so two quick
 * corrections may arrive as one request or as two. */
const expectSaved = (calls, rows) => expect.poll(() => saved(calls)).toEqual(rows);

async function openEditor(page, text) {
  const s = ui(page);
  if ((await s.edit.getAttribute("aria-pressed")) !== "true") await s.edit.click();
  await s.block(text).click();
  await expect(s.pop).toBeVisible();
}

test.describe("Chords strip", () => {
  test("it is off until asked for, and fetches nothing before that", async ({ page }) => {
    const { calls } = await stubChords(page, { detected: TIMELINE });
    await remember(page, { on: false });
    await openStudio(page);
    const s = ui(page);

    await expect(s.rail).toBeVisible();
    await expect(s.rail).toHaveAttribute("aria-pressed", "false");
    await expect(s.rail).toContainText("Labs");
    await expect(s.ribbon).toBeHidden();
    expect(calls.gets).toBe(0);

    await s.rail.click();
    await expect(s.rail).toHaveAttribute("aria-pressed", "true");
    await expect(s.ribbon).toBeVisible();
    await expect(s.ribbon).toContainText("Labs");
    await expect(s.named).toHaveText(["C", "C7", "F"]);

    // Off again puts it away, and the choice is kept across a reload.
    await s.rail.click();
    await expect(s.ribbon).toBeHidden();
    await s.rail.click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await expect(s.ribbon).toBeVisible();
    await expect(s.named).toHaveText(["C", "C7", "F"]);
  });

  test("a song with no chords offers to detect them, and shows each step of the run", async ({ page }) => {
    const { calls } = await stubChords(page);
    await remember(page);
    await openStudio(page);
    const s = ui(page);

    await expect(s.ribbon).toBeVisible();
    await expect(s.area).toBeHidden();
    await expect(s.note).toContainText("No chords yet");
    await expect(s.detect).toBeVisible();
    await expect(s.cancel).toBeHidden();
    // Nothing to correct or to show bass notes of yet.
    await expect(s.edit).toBeHidden();
    await expect(s.bass).toBeHidden();

    await s.detect.click();
    await expect(s.cancel).toBeVisible();
    await expect(s.detect).toBeHidden();
    await expect(s.note).toHaveText("Detecting chords… 40%");
    expect(calls.posts).toBe(1);

    await release(calls);
    await expect(s.named).toHaveText(["C", "C7", "F"]);
    await expect(s.note).toBeHidden();
    await expect(s.detect).toBeVisible();
    await expect(s.cancel).toBeHidden();
    await expect(s.edit).toBeVisible();
    // "No chord" is a gap: a block with no symbol in it.
    await expect(s.blocks).toHaveCount(4);
    await expect(s.blocks.first()).toHaveClass(/none/);
    await expect(s.blocks.first()).toBeDisabled();
  });

  test("Cancel stops the run and the song keeps the chords it had", async ({ page }) => {
    const { calls } = await stubChords(page, { detected: TIMELINE, run: () => ({ reason: "cancelled" }) });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.named).toHaveText(["C", "C7", "F"]);

    await s.detect.click();
    await expect(s.cancel).toBeVisible();
    // The chords of the last run stay, dimmed, while the new one is made.
    await expect(s.ribbon).toHaveClass(/running/);
    await expect(s.named).toHaveText(["C", "C7", "F"]);
    await s.cancel.click();
    await expect.poll(() => calls.cancels).toBe(1);
    await release(calls);

    await expect(s.note).toHaveText("Chord detection was cancelled.");
    await expect(s.note).not.toHaveClass(/problem/);
    await expect(s.named).toHaveText(["C", "C7", "F"]);
    await expect(s.ribbon).not.toHaveClass(/running/);
  });

  test("a run that fails says why in plain words", async ({ page }) => {
    const { calls } = await stubChords(page, { run: () => ({ reason: "timeout" }) });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await s.detect.click();
    await release(calls);
    await expect(s.note).toHaveText("Chord detection stopped responding and was stopped. Try again.");
    await expect(s.note).toHaveClass(/problem/);
    await expect(s.detect).toBeVisible();
    await expect(s.area).toBeHidden();
  });

  test("a song the detector finds no chord in says so", async ({ page }) => {
    const empty = [{ start: 0, end: 6, ...NONE, label: "N" }];
    const { calls } = await stubChords(page, { run: () => ({ timeline: empty, found: false }) });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await s.detect.click();
    await release(calls);
    await expect(s.note).toHaveText("No chords were found in this song.");
    await expect(s.named).toHaveCount(0);
  });

  test("a busy song is said to be busy", async ({ page }) => {
    const { calls } = await stubChords(page, {
      run: () => ({ status: 409, body: { detail: "the song is busy", code: "job_busy" } }),
    });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await s.detect.click();
    await release(calls);
    await expect(s.note).toContainText("busy with other work");
  });

  test("a run found already going is watched to its end", async ({ page }) => {
    const { server } = await stubChords(page);
    server.job = { chords: "running", chords_reason: null, chords_progress: { phase: "loading", percent: null } };
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.cancel).toBeVisible();
    await expect(s.note).toHaveText("Loading the chord model…");

    // It ends on the server, with nobody here waiting on its request.
    server.detected = TIMELINE;
    server.job = { chords: "done", chords_reason: null, chords_progress: null };
    await expect(s.named).toHaveText(["C", "C7", "F"]);
    await expect(s.cancel).toBeHidden();
  });

  test("a click plays from a chord, and the chord under the playhead is lit", async ({ page }) => {
    await stubChords(page, { detected: TIMELINE });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.named).toHaveText(["C", "C7", "F"]);

    // Each block sits over its own stretch of the song: F is the last third.
    const track = await page.locator("#daw-chords-track").boundingBox();
    const f = await s.block("F").boundingBox();
    expect((f.x - track.x) / track.width).toBeCloseTo(4 / 6, 2);
    expect(f.width / track.width).toBeCloseTo(2 / 6, 2);

    await s.block("F").click();
    await expect(s.current).toHaveText("F");
    await s.block("C").click();
    await expect(s.current).toHaveText("C");
    // The gap at the start lights nothing.
    await page.evaluate(() => document.querySelector("#t-stop")?.click());
    await expect(s.current).toHaveCount(0);

    // Playing moves the light on its own.
    await s.block("C7").click();
    await expect(s.current).toHaveText("C7");
    await page.keyboard.press("Space");
    await expect(s.current).toHaveText("F", { timeout: 15000 });
    await page.keyboard.press("Space");
  });

  test("the strip stays over the audio when the waveform is zoomed", async ({ page }) => {
    await stubChords(page, { detected: TIMELINE });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.named).toHaveText(["C", "C7", "F"]);

    const widths = () => page.evaluate(() => ({
      chords: document.querySelector("#daw-chords-track").getBoundingClientRect().width,
      sections: document.querySelector("#daw-sections-track").getBoundingClientRect().width,
      chordsShift: document.querySelector("#daw-chords-track").style.transform,
      sectionsShift: document.querySelector("#daw-sections-track").style.transform,
    }));
    const before = await widths();
    expect(before.chords).toBeCloseTo(before.sections, 0);

    // The wheel over the waveform zooms it.
    const wave = await page.locator("#wave-scroll").boundingBox();
    await page.mouse.move(wave.x + wave.width / 2, wave.y + wave.height / 2);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -300);
    await expect.poll(async () => (await widths()).chords).toBeGreaterThan(before.chords * 1.2);
    const zoomed = await widths();
    expect(zoomed.chords).toBeCloseTo(zoomed.sections, 0);

    // Scrolled, it slides with the bars above it.
    await page.evaluate(() => { document.querySelector("#wave-scroll").scrollLeft = 120; });
    await expect.poll(async () => (await widths()).chordsShift).toBe("translateX(-120px)");
    expect((await widths()).sectionsShift).toBe("translateX(-120px)");
  });

  test("a symbol is shown whole or not at all, and the sounding chord always shows", async ({ page }) => {
    // Two chords a beat for six seconds, with long symbols: far more than
    // fit. Half of "F#m7(b9)" would read as another chord.
    const roots = [6, 1, 8, 3, 10, 5, 0, 7, 2, 9, 4, 11];
    const busy = [...roots, ...roots].map((root, i) => ({
      start: i * 0.25, end: (i + 1) * 0.25, root, degrees: ["1", "b3", "5", "b7", "b9"], bass: null, label: "x",
    }));
    await stubChords(page, { detected: busy });
    await remember(page);
    await page.setViewportSize({ width: 900, height: 800 });
    await openStudio(page);
    const s = ui(page);
    await expect(s.named).toHaveCount(24);

    const labels = () => page.evaluate(() => {
      const blocks = [...document.querySelectorAll("#daw-chords-track .chord-block:not(.none)")];
      const shown = blocks.filter((b) => getComputedStyle(b.firstChild).visibility === "visible");
      const rects = shown.map((b) => b.firstChild.getBoundingClientRect());
      // The track, not the window onto it: on a narrow window it is wider
      // than what is seen, and scrolls.
      const track = document.querySelector("#daw-chords-track").getBoundingClientRect();
      return {
        shown: shown.map((b) => b.textContent),
        overlapping: rects.filter((r, i) => i > 0 && r.left < rects[i - 1].right).length,
        cut: shown.filter((b) => b.firstChild.scrollWidth > b.firstChild.clientWidth + 1).length,
        outside: rects.filter((r) => r.right > track.right + 1).length,
        runsOn: shown.filter((b) => b.firstChild.getBoundingClientRect().right > b.getBoundingClientRect().right).length,
      };
    });

    await expect.poll(async () => (await labels()).shown.length).toBeGreaterThan(0);
    const before = await labels();
    // Not all twenty-four fit. The ones drawn are whole and apart, and at
    // least one runs on past its own narrow block instead of being clipped.
    expect(before.shown.length).toBeLessThan(24);
    expect(before.shown[0]).toBe("F#m7(b9)");
    expect(before).toMatchObject({ overlapping: 0, cut: 0, outside: 0 });
    expect(before.runsOn).toBeGreaterThan(0);

    // A chord whose symbol is hidden shows it while it is the one sounding.
    const hidden = page.locator("#daw-chords-track .chord-block.label-hidden").first();
    const name = await hidden.textContent();
    await hidden.click();
    await page.mouse.move(5, 5);
    await expect(s.current).toHaveText(name);
    await expect(s.current.locator(".chord-block-label")).toBeVisible();
    expect(await s.current.locator(".chord-block-label").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    // Zoomed in there is room for more of them, still whole and apart.
    const wave = await page.locator("#wave-scroll").boundingBox();
    await page.mouse.move(wave.x + wave.width / 2, wave.y + wave.height / 2);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -300);
    await expect.poll(async () => (await labels()).shown.length).toBeGreaterThan(before.shown.length);
    expect(await labels()).toMatchObject({ overlapping: 0, cut: 0 });

    // And with room for every one of them, every one is drawn: none waits
    // for the playhead.
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -300);
    await expect.poll(async () => (await labels()).shown.length).toBe(24);
    expect(await labels()).toMatchObject({ overlapping: 0, cut: 0 });
  });

  test("a symbol with just enough room for itself is drawn without waiting for the playhead", async ({ page }) => {
    // One short chord between two long ones, as wide as its own symbol and
    // no wider: it used to be hidden for want of a few spare pixels.
    const Cs = { root: 1, degrees: ["1", "b3", "5"], bass: null };
    const tight = [
      { start: 0, end: 2.75, root: 8, degrees: ["1", "3", "5"], bass: null, label: "x" },
      { start: 2.75, end: 3, ...Cs, label: "x" },
      { start: 3, end: 6, root: 6, degrees: ["1", "3", "5"], bass: null, label: "x" },
    ];
    await stubChords(page, { detected: tight });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.named).toHaveText(["Ab", "C#m", "F#"]);
    // The playhead is at the start, nowhere near it.
    await expect(s.current).toHaveText("Ab");
    const block = s.block("C#m");
    const fit = await block.evaluate((node) => ({
      block: node.getBoundingClientRect().width,
      label: node.firstChild.getBoundingClientRect().width,
    }));
    // The premise: a block about the width of its symbol.
    expect(fit.block).toBeLessThan(fit.label + 22);
    await expect(block).not.toHaveClass(/label-hidden/);
    await expect(block.locator(".chord-block-label")).toBeVisible();
  });

  test("bass notes are hidden until asked for, and the choice is remembered", async ({ page }) => {
    await stubChords(page, { detected: TIMELINE });
    await remember(page);
    await openStudio(page);
    const s = ui(page);

    // The same chord over a moving bass is one block.
    await expect(s.named).toHaveText(["C", "C7", "F"]);
    await expect(s.bass).toHaveAttribute("aria-pressed", "false");

    await s.bass.click();
    await expect(s.bass).toHaveAttribute("aria-pressed", "true");
    await expect(s.named).toHaveText(["C", "C7/E", "C7/G", "F"]);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await expect(s.named).toHaveText(["C", "C7/E", "C7/G", "F"]);
    await s.bass.click();
    await expect(s.named).toHaveText(["C", "C7", "F"]);
  });

  test("the chords are respelled when the song is transposed", async ({ page }) => {
    await stubChords(page, { detected: TIMELINE });
    await remember(page, { bass: true });
    await openStudio(page);
    const s = ui(page);
    await expect(s.named).toHaveText(["C", "C7/E", "C7/G", "F"]);

    const up = page.locator("#t-pitch-up");
    const down = page.locator("#t-pitch-down");
    await expect(up).toBeEnabled();
    await up.click();
    await up.click();
    await expect(s.named).toHaveText(["D", "D7/F#", "D7/A", "G"]);
    // One more and the key is E flat: flats.
    await up.click();
    await expect(s.named).toHaveText(["Eb", "Eb7/G", "Eb7/Bb", "Ab"]);
    for (let i = 0; i < 4; i++) await down.click();
    await expect(s.named).toHaveText(["B", "B7/D#", "B7/F#", "E"]);
    await up.click();
    await expect(s.named).toHaveText(["C", "C7/E", "C7/G", "F"]);
  });

  test("a chord is corrected by typing another, and the correction is saved", async ({ page }) => {
    const { calls } = await stubChords(page, { detected: TIMELINE });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.named).toHaveText(["C", "C7", "F"]);
    await expect(s.reset).toBeHidden();

    await openEditor(page, "C7");
    // The field holds the whole chord, bass note included, selected to type over.
    await expect(s.input).toHaveValue("C7/E");
    await expect(s.input).toBeFocused();
    await s.input.fill("Cmaj7");
    await s.input.press("Enter");

    await expect(s.pop).toBeHidden();
    await expect(s.named).toHaveText(["C", "Cmaj7", "F"]);
    await expectSaved(calls, [[0, 1, null], [1, 2, 0], [2, 4, 0], [4, 6, 5]]);
    expect(calls.patches.length).toBe(1);
    expect(calls.patches[0].chords[2].degrees).toEqual(["1", "3", "5", "7"]);
    // The detector's label is not sent back as if the user had written it.
    expect(calls.patches[0].chords.every((c) => !("label" in c))).toBe(true);
    await expect(s.saved).toHaveText("Saved");
    await expect(s.reset).toBeVisible();

    // Still there after the song is closed and opened again.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await expect(s.named).toHaveText(["C", "Cmaj7", "F"]);
    await expect(s.reset).toBeVisible();
  });

  test("a symbol that cannot be read is refused and changes nothing", async ({ page }) => {
    const { calls } = await stubChords(page, { detected: TIMELINE });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await openEditor(page, "F");
    await s.input.fill("Hx9");
    await s.input.press("Enter");

    await expect(s.popError).toContainText("could not be read");
    await expect(s.input).toHaveAttribute("aria-invalid", "true");
    await expect(s.pop).toBeVisible();
    await expect(s.named).toHaveText(["C", "C7", "F"]);
    // Typing again clears the complaint.
    await s.input.fill("Fm");
    await expect(s.popError).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(s.pop).toBeHidden();
    await page.waitForTimeout(600);
    expect(calls.patches.length).toBe(0);
    await expect(s.reset).toBeHidden();
  });

  test("a chord's start moves by a beat, and it can be deleted or set to no chord", async ({ page }) => {
    const { calls } = await stubChords(page, { detected: TIMELINE });
    await remember(page);
    await openStudio(page);
    const s = ui(page);

    // Start earlier: F begins on the beat before, and C7 ends there.
    await openEditor(page, "F");
    await s.act("earlier").click();
    await expectSaved(calls, [[0, 1, null], [1, 2, 0], [2, 3, 0], [3, 3.5, 0], [3.5, 6, 5]]);
    // The editor stays on the chord, to move it again.
    await expect(s.pop).toBeVisible();
    await expect(s.input).toHaveValue("F");
    await s.act("later").click();
    await s.act("later").click();
    await expectSaved(calls, [[0, 1, null], [1, 2, 0], [2, 3, 0], [3, 4.5, 0], [4.5, 6, 5]]);
    await page.keyboard.press("Escape");

    // Delete: the chord before it lasts until the chord after it.
    await openEditor(page, "C7");
    await s.act("delete").click();
    await expect(s.pop).toBeHidden();
    await expect(s.named).toHaveText(["C", "F"]);
    await expectSaved(calls, [[0, 1, null], [1, 4.5, 0], [4.5, 6, 5]]);

    // No chord: the stretch becomes a gap, which Edit lets one click on.
    await openEditor(page, "F");
    await s.act("none").click();
    await expect(s.named).toHaveText(["C"]);
    await expectSaved(calls, [[0, 1, null], [1, 4.5, 0], [4.5, 6, null]]);

    // And a gap is given a chord by typing one.
    await s.blocks.last().click();
    await expect(s.pop).toBeVisible();
    await expect(s.input).toHaveValue("");
    await expect(s.act("none")).toBeDisabled();
    await s.input.fill("G7");
    await s.input.press("Enter");
    await expect(s.named).toHaveText(["C", "G7"]);
    await expectSaved(calls, [[0, 1, null], [1, 4.5, 0], [4.5, 6, 7]]);
  });

  test("a start that cannot move further says so and moves nothing", async ({ page }) => {
    const { calls } = await stubChords(page, { detected: TIMELINE });
    await remember(page, { bass: true });
    await openStudio(page);
    const s = ui(page);
    // C7/G is two beats long. One step later leaves it one beat; a second
    // would leave it none.
    await openEditor(page, "C7/G");
    await s.act("later").click();
    await expect(s.input).toHaveValue("C7/G");
    await expect(s.popError).toBeHidden();
    await s.act("later").click();
    await expect(s.popError).toContainText("cannot move any further");
    await expectSaved(calls, [[0, 1, null], [1, 2, 0], [2, 3.5, 0], [3.5, 4, 0], [4, 6, 5]]);
    await page.waitForTimeout(600);
    expect(calls.patches.length).toBe(1);
  });

  test("a chord typed while transposed is stored in the song's own key", async ({ page }) => {
    const { calls } = await stubChords(page, { detected: TIMELINE });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await page.locator("#t-pitch-up").click();
    await page.locator("#t-pitch-up").click();
    await expect(s.named).toHaveText(["D", "D7", "G"]);

    await openEditor(page, "G");
    await s.input.fill("Gm7");
    await s.input.press("Enter");
    await expect(s.named).toHaveText(["D", "D7", "Gm7"]);
    await expect.poll(() => calls.patches.length).toBe(1);
    // G minor seventh heard two semitones up is F minor seventh in the song.
    expect(calls.patches[0].chords.at(-1)).toMatchObject({ root: 5, degrees: ["1", "b3", "5", "b7"] });
  });

  test("Reset asks once, then goes back to the detected chords", async ({ page }) => {
    const user = [{ start: 0, end: 6, ...F }];
    const { calls } = await stubChords(page, { detected: TIMELINE, user });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.named).toHaveText(["F"]);
    await expect(s.reset).toBeVisible();

    await s.reset.click();
    await expect(s.reset).toHaveClass(/armed/);
    await expect(s.reset).toContainText("Sure?");
    expect(calls.deletes).toBe(0);
    await expect(s.named).toHaveText(["F"]);

    await s.reset.click();
    await expect.poll(() => calls.deletes).toBe(1);
    await expect(s.named).toHaveText(["C", "C7", "F"]);
    await expect(s.reset).toBeHidden();
  });

  test("detecting again keeps the corrections, and says so", async ({ page }) => {
    const user = [{ start: 0, end: 6, ...F }];
    const again = [{ start: 0, end: 6, ...C, label: "C:maj" }];
    const { calls } = await stubChords(page, { detected: TIMELINE, user, run: () => ({ timeline: again }) });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.named).toHaveText(["F"]);
    await expect(s.detect).toHaveAttribute("title", /again/i);

    await s.detect.click();
    await release(calls);
    await expect(s.note).toContainText("Your corrected chords are still shown");
    await expect(s.named).toHaveText(["F"]);
    await expect(s.reset).toBeVisible();

    // Going back shows what the detector found this time.
    await s.reset.click();
    await s.reset.click();
    await expect(s.named).toHaveText(["C"]);
    await expect(s.note).toBeHidden();
  });

  test("an install that cannot detect offers no control, unless the song brought chords", async ({ page }) => {
    await stubChords(page, { available: false });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.rail).toBeHidden();
    await expect(s.ribbon).toBeHidden();
  });

  test("a song that brought chords still shows them where none can be detected", async ({ page }) => {
    await stubChords(page, { available: false, detected: TIMELINE });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.rail).toBeVisible();
    await expect(s.named).toHaveText(["C", "C7", "F"]);
    await expect(s.detect).toBeHidden();
    await expect(s.edit).toBeVisible();
  });

  test("the chords can be walked with the arrow keys", async ({ page }) => {
    await stubChords(page, { detected: TIMELINE });
    await remember(page);
    await openStudio(page);
    const s = ui(page);
    await expect(s.named).toHaveText(["C", "C7", "F"]);
    // One tab stop for the whole strip.
    expect(await page.locator("#daw-chords-track .chord-block[tabindex='0']").count()).toBe(1);
    await s.block("C").focus();
    await page.keyboard.press("ArrowRight");
    await expect(s.block("C7")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(s.block("F")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(s.block("F")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    // Not onto the gap: it does nothing outside Edit.
    await page.keyboard.press("ArrowLeft");
    await expect(s.block("C")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(s.current).toHaveText("C");
  });

  test("its labels follow the language", async ({ page }) => {
    await stubChords(page);
    await remember(page);
    await page.addInitScript(() => window.localStorage.setItem("stemdeck.language", JSON.stringify("de")));
    await openStudio(page);
    const s = ui(page);
    await expect(s.note).toBeVisible();
    await expect(s.detect).toHaveText("Erkennen");
    await expect(s.note).toContainText("Noch keine Akkorde");
  });
});
