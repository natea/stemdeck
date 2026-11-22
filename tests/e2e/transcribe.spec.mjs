// Transcribe to Notes (openspec change add-stem-transcription): the dialog,
// driven in a real browser against the real backend with only the model run
// stubbed. A real run downloads 700 MB of weights and takes minutes; what is
// under test here is the dialog: what it offers, what it sends, and what it
// shows for each answer.

import { test, expect } from "@playwright/test";
import { openStudio, exportUi, JOB_ID } from "./helpers.mjs";

const RUN = new RegExp(`/api/jobs/${JOB_ID}/transcription$`);
const done = (notes, transcriber = "crepe") => ({ status: "done", notes, code: null, transcriber });

const ui = (page) => ({
  row: page.locator("#t-export-transcribe"),
  dialog: page.locator("#transcribeDialog"),
  stem: (name) => page.locator(`#transcribeStems .transcribe-stem[data-stem="${name}"]`),
  status: (name) => page.locator(`#transcribeStems .transcribe-stem[data-stem="${name}"] .transcribe-stem-status`),
  start: page.locator("#transcribeStart"),
  cancel: page.locator("#transcribeCancel"),
  error: page.locator("#transcribeError"),
  downloads: page.locator("#transcribeDownloads"),
  warning: page.locator("#transcribeWarning"),
  parts: page.locator("#transcribeParts"),
  midiPlayed: page.locator("#transcribeMidiPlayed"),
  midiQuantised: page.locator("#transcribeMidiQuantised"),
  musicxml: page.locator("#transcribeMusicxml"),
});

// Stand in for the two transcription endpoints. `run` decides what a POST
// answers; `grid` is what the notes endpoint says about the beat grid.
async function stubTranscription(page, { run, grid = { available: true, confidence: 95 } } = {}) {
  const calls = { posts: [], release: null };
  let stems = {};
  await page.route(RUN, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      calls.posts.push(body);
      // Held until the test lets it go, so the running state can be looked at.
      await new Promise((resolve) => { calls.release = resolve; });
      const answer = run(body);
      stems = answer.body.transcription_stems || stems;
      await route.fulfill({ status: answer.status ?? 200, json: answer.body });
      return;
    }
    const has = Object.values(stems).some((s) => s.status === "done" && s.notes > 0);
    if (!has) return route.fulfill({ status: 404, json: { detail: "nothing transcribed" } });
    await route.fulfill({
      json: {
        job_id: JOB_ID,
        quantized: false,
        quantize_available: grid.available,
        quantize_reason: grid.available ? null : "no_beat_grid",
        grid: grid.available ? { confidence: grid.confidence, detector: "beat_this", bpm: 120, edited: false } : null,
        stems: {},
      },
    });
  });
  return calls;
}

const finished = (stems) => ({
  body: { job_id: JOB_ID, status: "done", transcription: "done", transcription_reason: null, transcription_stems: stems,
    stems: ["vocals", "drums", "bass", "other"].map((name) => ({ name })) },
});

async function openDialog(page) {
  const menu = exportUi(page);
  await menu.open();
  await ui(page).row.click();
  await expect(ui(page).dialog).toBeVisible();
}

async function release(page, calls) {
  await expect.poll(() => calls.release !== null).toBe(true);
  calls.release();
}

test.describe("Transcribe to Notes", () => {
  test("the row opens the dialog, a run fills in the stems and the downloads", async ({ page }) => {
    const calls = await stubTranscription(page, {
      run: () => finished({ vocals: done(42), bass: done(17), drums: done(230, "mt3"), other: { status: "skipped", notes: 0, code: null, transcriber: "mt3" } }),
    });
    await openStudio(page);
    const d = ui(page);
    await openDialog(page);
    await expect(exportUi(page).panel).toBeHidden();

    // Every stem of the song is offered, each with the kind of model it goes to.
    for (const name of ["vocals", "drums", "bass", "other"]) {
      await expect(d.stem(name).locator("input")).toBeChecked();
      await expect(d.status(name)).toHaveText("Not transcribed");
    }
    await expect(d.stem("bass")).toContainText("Pitch tracker");
    await expect(d.stem("drums")).toContainText("Multi-instrument model");
    await expect(d.downloads).toBeHidden();
    await expect(d.cancel).toBeHidden();

    await d.stem("other").locator("input").uncheck();
    await d.start.click();

    // Running: the button says so and cannot be pressed twice, Cancel appears.
    await expect(d.start).toHaveText("Transcribing…");
    await expect(d.start).toBeDisabled();
    await expect(d.cancel).toBeVisible();
    await expect(d.stem("bass").locator("input")).toBeDisabled();
    await release(page, calls);

    expect(calls.posts).toEqual([{ stems: ["vocals", "drums", "bass"] }]);
    await expect(d.start).toHaveText("Transcribe");
    await expect(d.start).toBeEnabled();
    await expect(d.cancel).toBeHidden();
    await expect(d.status("vocals")).toHaveText("42 notes");
    await expect(d.status("drums")).toHaveText("230 notes");
    await expect(d.status("other")).toHaveText("Silent, skipped");
    await expect(d.error).toBeHidden();

    // The three downloads, for the ticked stems that have notes.
    await expect(d.downloads).toBeVisible();
    await expect(d.warning).toBeHidden();
    const base = `/api/jobs/${JOB_ID}/transcription`;
    await expect(d.midiPlayed).toHaveAttribute("href", `${base}.mid?stems=vocals%2Cdrums%2Cbass`);
    await expect(d.midiQuantised).toHaveAttribute("href", `${base}.mid?stems=vocals%2Cdrums%2Cbass&quantize=1&parts=4`);
    await expect(d.musicxml).toHaveAttribute("href", `${base}.musicxml?stems=vocals%2Cdrums%2Cbass&parts=4`);

    // The resolution choice and the ticks both change what is asked for.
    await d.parts.selectOption("3");
    await expect(d.musicxml).toHaveAttribute("href", `${base}.musicxml?stems=vocals%2Cdrums%2Cbass&parts=3`);
    await d.stem("drums").locator("input").uncheck();
    await expect(d.midiQuantised).toHaveAttribute("href", `${base}.mid?stems=vocals%2Cbass&quantize=1&parts=3`);

    // Escape closes it, and the song is as it was.
    await page.keyboard.press("Escape");
    await expect(d.dialog).toBeHidden();
  });

  test("a stem that failed says why on its own row, and the others still download", async ({ page }) => {
    const calls = await stubTranscription(page, {
      run: () => finished({
        bass: done(17),
        vocals: { status: "error", notes: 0, code: "model_unavailable", transcriber: "crepe" },
      }),
    });
    await openStudio(page);
    const d = ui(page);
    await openDialog(page);
    await d.start.click();
    await release(page, calls);

    await expect(d.status("vocals")).toContainText("could not be downloaded or loaded");
    await expect(d.status("vocals")).toHaveClass(/is-error/);
    await expect(d.status("bass")).toHaveText("17 notes");
    await expect(d.error).toBeHidden();
    await expect(d.midiPlayed).toHaveAttribute("href", `/api/jobs/${JOB_ID}/transcription.mid?stems=bass`);
  });

  test("a run that ends early says why and can be started again", async ({ page }) => {
    let attempt = 0;
    const calls = await stubTranscription(page, {
      run: () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            status: 500,
            body: { ...finished({ bass: done(17) }).body, transcription: "error", transcription_reason: "cancelled",
              transcription_message: "The transcription was cancelled.", detail: "transcription failed" },
          };
        }
        return finished({ bass: done(17), vocals: done(9) });
      },
    });
    await openStudio(page);
    const d = ui(page);
    await openDialog(page);
    await d.start.click();
    await release(page, calls);

    await expect(d.error).toBeVisible();
    await expect(d.error).toHaveText("The transcription was cancelled.");
    // What it finished is kept and can be downloaded.
    await expect(d.status("bass")).toHaveText("17 notes");
    await expect(d.downloads).toBeVisible();

    calls.release = null;
    await d.start.click();
    await release(page, calls);
    await expect(d.error).toBeHidden();
    await expect(d.status("vocals")).toHaveText("9 notes");
  });

  test("Cancel asks the server to stop the run", async ({ page }) => {
    const calls = await stubTranscription(page, { run: () => finished({ bass: done(1) }) });
    let cancelled = 0;
    await page.route(new RegExp(`/api/jobs/${JOB_ID}/cancel$`), async (route) => {
      cancelled += 1;
      await route.fulfill({ json: { job_id: JOB_ID, status: "done" } });
    });
    await openStudio(page);
    const d = ui(page);
    await openDialog(page);
    await d.start.click();
    await expect(d.cancel).toBeVisible();
    await d.cancel.click();
    await expect.poll(() => cancelled).toBe(1);
    await release(page, calls);
  });

  test("a song with no beat grid is warned about and offers only the as-played MIDI", async ({ page }) => {
    const calls = await stubTranscription(page, {
      run: () => finished({ bass: done(17) }),
      grid: { available: false },
    });
    await openStudio(page);
    const d = ui(page);
    await openDialog(page);
    await d.start.click();
    await release(page, calls);

    await expect(d.warning).toBeVisible();
    await expect(d.warning).toHaveAttribute("data-kind", "no-grid");
    await expect(d.warning).toContainText("no beat grid");
    await expect(d.midiPlayed).toHaveAttribute("href", /transcription\.mid/);
    for (const link of [d.midiQuantised, d.musicxml]) {
      await expect(link).toHaveAttribute("aria-disabled", "true");
      await expect(link).not.toHaveAttribute("href", /.*/);
    }
    await expect(d.parts).toBeDisabled();
  });

  test("an unsure beat grid is warned about with its confidence", async ({ page }) => {
    const calls = await stubTranscription(page, {
      run: () => finished({ bass: done(17) }),
      grid: { available: true, confidence: 41 },
    });
    await openStudio(page);
    const d = ui(page);
    await openDialog(page);
    await d.start.click();
    await release(page, calls);

    await expect(d.warning).toBeVisible();
    await expect(d.warning).toHaveAttribute("data-kind", "low-confidence");
    await expect(d.warning).toContainText("41%");
    // Unsure is a warning, not a refusal: the files are still offered.
    await expect(d.midiQuantised).toHaveAttribute("href", /quantize=1/);
    await expect(d.musicxml).toHaveAttribute("href", /transcription\.musicxml/);
  });

  test("the row is absent where transcription cannot run", async ({ page }) => {
    await page.route(/\/api\/config$/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, transcription_available: false } });
    });
    await openStudio(page);
    await exportUi(page).open();
    await expect(ui(page).row).toBeHidden();
    await expect(exportUi(page).stems).toBeVisible();
  });

  test("the row is hidden while MP4 is the chosen format", async ({ page }) => {
    await openStudio(page);
    const menu = exportUi(page);
    await menu.open();
    await expect(ui(page).row).toBeVisible();
    await page.evaluate(() => document.getElementById("t-export-panel").classList.add("fmt-mp4"));
    await expect(ui(page).row).toBeHidden();
  });
});
