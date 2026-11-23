// The Notation view (openspec change add-alphatab-notation): a transcribed
// song read as sheet music and tab, in a real browser against the real
// backend and the real vendored alphaTab.
//
// The song is the seeded MP3 fixture (tests/e2e/seed.py), which is also the
// transcribed one: notes for a voice, a guitar, a bass and drums, 6 seconds
// at 120 BPM. That is three bars of 4/4 with bar lines at 0, 2 and 4 s, which
// is what the cursor checks count against. Its guitar plays low Ds, below a
// guitar in standard tuning, so the tab leaves four notes off until the
// tuning is changed to drop D.
//
// Nothing here stubs the score: the alphaTex comes from
// GET /api/jobs/{id}/transcription.alphatex and is drawn by alphaTab. Only
// the cases the fixture cannot be in at once are stubbed (no beat grid, a
// machine that cannot transcribe, a worker that does not start).

import { test, expect } from "@playwright/test";
import {
  JOB_ID, TRACK_TITLE, SIBLING_JOB_ID, SIBLING_TITLE,
  fixtureTrack, seedCatalogState, stubExportEndpoints, stubUpdateCheck, stubTauri, chooseMode,
} from "./helpers.mjs";

// The engine has to really play for "the cursor follows playback" to mean
// anything. Muted, so a run makes no sound.
test.use({ launchOptions: { args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] } });

const SONG = "e2e0f00dface";
const SONG_TITLE = "E2E MP3 Track";
const SONG_SEC = 6;
const BAR_SEC = 2;
const BARS = 3;
const SCORE = new RegExp(`/api/jobs/${SONG}/transcription\\.alphatex`);
const TAB = `/api/jobs/${SONG}/transcription/tab`;
const GUITAR_PRO = `/api/jobs/${SONG}/transcription.gp`;

const ui = (page) => ({
  chip: page.locator("#t-notation-btn"),
  drawer: page.locator("#notation-drawer"),
  score: page.locator("#notationScore"),
  scroll: page.locator("#notationScroll"),
  bar: page.locator("#notationBar"),
  stem: (name) => page.locator(`#notationStems .notation-stem[data-stem="${name}"] input`),
  parts: page.locator("#notationParts"),
  zoomIn: page.locator("#notationZoomIn"),
  zoomOut: page.locator("#notationZoomOut"),
  zoomValue: page.locator("#notationZoomValue"),
  follow: page.locator("#notationFollow"),
  downloads: page.locator("#notationDownloads summary"),
  midiPlayed: page.locator("#notationMidiPlayed"),
  midiQuantised: page.locator("#notationMidiQuantised"),
  musicxml: page.locator("#notationMusicxml"),
  guitarPro: page.locator("#notationGuitarPro"),
  close: page.locator("#notationClose"),
  resize: page.locator("#notation-drawer .notation-resize"),
  tab: (stem) => page.locator(`#notationTabs .notation-tab[data-stem="${stem}"]`),
  notices: page.locator("#notationNotices"),
  notice: (stem) => page.locator(`#notationNotices .notation-notice[data-stem="${stem}"]`),
  empty: page.locator("#notationEmpty"),
  emptyText: page.locator("#notationEmpty .notation-empty-text"),
  emptyAction: page.locator("#notationEmpty button.notation-empty-action"),
  emptyLink: page.locator("#notationEmpty a.notation-empty-action"),
  foot: page.locator("#notationFoot"),
});

/** Open a song in the studio. `mode` is "daw" (Advanced) or "practice". */
async function openSong(page, id = SONG, { mode = "daw" } = {}) {
  await page.addInitScript((m) => {
    if (!window.localStorage.getItem("stemdeck.mode")) window.localStorage.setItem("stemdeck.mode", m);
  }, mode);
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID, SONG], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
      [SONG]: { ...fixtureTrack(SONG, SONG_TITLE), sourceUrl: "local:e2e-mp3-fixture" },
    },
  });
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await pickSong(page, id);
}

async function pickSong(page, id) {
  await page.locator(`.cat-item[data-id="${id}"]`).first().click();
  // The song is open, its length is known, and there is a player to ask.
  await page.waitForFunction(
    async (want) => (await import("/js/state.js")).currentJobId === want
      && !/\/\s*00:00\s*$/.test(document.querySelector("#t-time")?.textContent || "00:00 / 00:00")
      && Boolean((await import("/js/transport.js")).transport()?.getCurrentTime),
    id,
    { timeout: 20000 },
  );
}

/** Open the drawer and wait for a drawn score of `tracks` tracks. */
async function openScore(page, tracks = 4) {
  const v = ui(page);
  await v.chip.click();
  await expect(v.drawer).toBeVisible();
  await expect(v.score).toHaveAttribute("data-tracks", String(tracks), { timeout: 30000 });
  await expect(v.drawer).toHaveAttribute("aria-busy", "false");
  // Drawn, not only parsed: alphaTab has put the staves on the page.
  await expect(v.score.locator("svg").first()).toBeVisible();
}

async function player(page) {
  return page.evaluate(async () => {
    // Between two engines (a song just opened) there is briefly no player.
    const tx = (await import("/js/transport.js")).transport();
    return { time: tx?.getCurrentTime?.() ?? 0, playing: Boolean(tx?.isPlaying?.()) };
  });
}

/** Wait until the song has played past `sec`, then say which bar the cursor is in. */
async function barWhenPast(page, sec) {
  return page.evaluate(async (at) => {
    const tx = (await import("/js/transport.js")).transport();
    await new Promise((resolve, reject) => {
      const started = performance.now();
      const look = () => {
        if (tx.getCurrentTime() >= at) return resolve();
        if (performance.now() - started > 30000) return reject(new Error("the song never got there"));
        requestAnimationFrame(look);
      };
      look();
    });
    // Two frames: one for the view to hand alphaTab the position, one for
    // alphaTab's answer to be read back.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { time: tx.getCurrentTime(), bar: Number(document.querySelector("#notationScore").dataset.bar) };
  }, sec);
}

const seek = (page, sec) =>
  page.evaluate(async (t) => (await import("/js/transport.js")).setPlayheadTime(t), sec);

/** The bar the cursor is in, once it has settled there. */
const expectBar = (page, bar) => expect(ui(page).score).toHaveAttribute("data-bar", String(bar));

const query = (url) => Object.fromEntries(new URL(url, "http://x").searchParams);

// The server is shared by every spec, and tab choices and grid edits live on
// it. Each test starts from the fixture as seeded.
test.beforeEach(async ({ request }) => {
  await request.patch(TAB, {
    data: {
      guitar: { preset: "standard", capo: 0, display: "both" },
      bass: { preset: "standard", capo: 0, display: "both" },
    },
  });
  await request.delete(`/api/jobs/${SONG}/beats`);
});
test.afterEach(async ({ request }) => {
  await request.patch(TAB, {
    data: {
      guitar: { preset: "standard", capo: 0, display: "both" },
      bass: { preset: "standard", capo: 0, display: "both" },
    },
  });
  await request.delete(`/api/jobs/${SONG}/beats`);
});

test.describe("Notation view", () => {
  // ── 4.1 The bridge: the endpoint's own alphaTex in the vendored alphaTab ──

  test("the fixture's score loads into alphaTab with no parse errors and every track drawn", async ({ page, request }) => {
    // Errors the page itself raises. A request the server refuses is logged
    // by the browser as "Failed to load resource" with no address, so those
    // are read from the responses instead, where the address is known.
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(e.message));
    const asked = [];
    page.on("request", (r) => asked.push(r.url()));
    const refused = [];
    page.on("response", (r) => { if (r.status() >= 400) refused.push(`${r.status()} ${new URL(r.url()).pathname}`); });

    await openSong(page);
    // alphaTab is 1.2 MB: not fetched until the view is opened.
    expect(asked.some((u) => u.includes("/vendor/alphatab/"))).toBe(false);
    await openScore(page);
    const v = ui(page);

    // What was drawn is what the endpoint returns, unchanged.
    const body = await (await request.get(`/api/jobs/${SONG}/transcription.alphatex?format=json`)).json();
    expect(body.stems).toEqual(["vocals", "guitar", "bass", "drums"]);
    expect(body.alphatex).toContain('\\track ("guitar" "guitar")');
    await expect(v.score).toHaveAttribute("data-warnings", "0");
    await expect(v.score).toHaveAttribute("data-bars", String(body.bars));
    await expect(v.score).toHaveAttribute("data-worker", "true");
    expect(body.bars).toBe(BARS);

    // Each staff is labelled with its stem's name, as the app names it.
    const text = await v.score.evaluate((el) => [...el.querySelectorAll("svg text")].map((t) => t.textContent).join("|"));
    for (const name of ["Vocals", "Guitar", "Bass", "Drums"]) expect(text).toContain(name);

    // Served by the app itself: the module, its core, its worker and the one font.
    const vendored = [...new Set(asked.filter((u) => u.includes("/vendor/alphatab/")).map((u) => new URL(u).pathname))].sort();
    expect(vendored).toEqual([
      "/vendor/alphatab/alphaTab.core.min.mjs",
      "/vendor/alphatab/alphaTab.min.mjs",
      "/vendor/alphatab/alphaTab.worker.min.mjs",
      "/vendor/alphatab/font/Bravura.woff2",
    ]);
    const origin = new URL(page.url()).origin;
    const elsewhere = asked.filter((u) => /^https?:/.test(u) && !u.startsWith(origin) && /alphatab|bravura|soundfont|\.sf[23]/i.test(u));
    expect(elsewhere).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(refused.filter((line) => /alphatab|transcription|notation/.test(line))).toEqual([]);
  });

  test("the score is drawn on the main thread when the worker cannot start", async ({ page }) => {
    test.setTimeout(60_000);
    // A webview that will not start a module worker: the file never arrives.
    await page.route("**/vendor/alphatab/alphaTab.worker.min.mjs", (route) => route.abort());
    await openSong(page);
    const v = ui(page);
    await v.chip.click();
    await expect(v.score).toHaveAttribute("data-worker", "false", { timeout: 40000 });
    await expect(v.score).toHaveAttribute("data-tracks", "4");
    await expect(v.score.locator("svg").first()).toBeVisible();
    await expect(v.empty).toBeHidden();
  });

  // ── 4.2 The toggle and the panel ──

  for (const mode of ["daw", "practice"]) {
    test(`the chip opens and closes the drawer without interrupting playback (${mode})`, async ({ page }) => {
      await openSong(page, SONG, { mode });
      const v = ui(page);
      await expect(v.chip).toBeVisible();
      await expect(v.chip).toHaveAttribute("aria-expanded", "false");
      await expect(v.drawer).toBeHidden();

      await page.locator("#t-play").click();
      await expect.poll(async () => (await player(page)).playing).toBe(true);
      const before = (await player(page)).time;

      await openScore(page);
      await expect(v.chip).toHaveAttribute("aria-expanded", "true");
      let now = await player(page);
      expect(now.playing).toBe(true);
      expect(now.time).toBeGreaterThan(before);

      await v.close.click();
      await expect(v.drawer).toBeHidden();
      await expect(v.chip).toHaveAttribute("aria-expanded", "false");
      await expect(v.chip).toBeFocused();
      const closedAt = (await player(page)).time;
      await expect.poll(async () => (await player(page)).time).toBeGreaterThan(closedAt);
      now = await player(page);
      expect(now.playing).toBe(true);
    });
  }

  test("the drawer is resized by its top edge, by mouse and by keyboard, and remembers its height", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    const height = async () => Math.round((await v.drawer.boundingBox()).height);
    const start = await height();

    const edge = await v.resize.boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 3);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 3 - 80, { steps: 4 });
    await page.mouse.up();
    await expect.poll(height).toBe(start + 80);

    await v.resize.focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(height).toBe(start + 80 - 24);
    // The arrow keys are the handle's: the song did not start.
    expect((await player(page)).playing).toBe(false);

    // Never smaller than is usable: there is still music on show.
    for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowDown");
    await expect.poll(height).toBe(260);
    await expect(v.score.locator("svg").first()).toBeVisible();
    expect((await v.scroll.boundingBox()).height).toBeGreaterThan(60);

    await page.keyboard.press("ArrowUp");
    await page.reload({ waitUntil: "domcontentloaded" });
    await pickSong(page, SONG);
    await openScore(page);
    await expect.poll(height).toBe(260 + 24);
  });

  test("Karaoke takes the whole window, so it closes the drawer", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    await chooseMode(page, "karaoke");
    await expect(ui(page).drawer).toBeHidden();
    await expect(ui(page).chip).toHaveAttribute("aria-expanded", "false");
  });

  // ── 4.3 When there is nothing to show ──

  test("a song with no transcription says so and offers Transcribe", async ({ page }) => {
    await openSong(page, JOB_ID);
    const v = ui(page);
    await v.chip.click();
    await expect(v.drawer).toHaveAttribute("data-state", "untranscribed");
    await expect(v.emptyText).toContainText("has not been transcribed yet");
    await expect(v.scroll).toBeHidden();
    await expect(v.emptyAction).toHaveText("Transcribe");
    await v.emptyAction.click();
    await expect(page.locator("#transcribeDialog")).toBeVisible();
  });

  test("a transcribed song with no beat grid says why and points to the as-played MIDI", async ({ page }) => {
    await page.route(SCORE, (route) => route.fulfill({
      status: 409,
      json: { detail: "this song has no beat grid", transcription_reason: "no_beat_grid", transcription_message: "This song has no beat grid." },
    }));
    await openSong(page);
    const v = ui(page);
    await v.chip.click();
    await expect(v.drawer).toHaveAttribute("data-state", "no-grid");
    await expect(v.emptyText).toContainText("needs a beat grid");
    await expect(v.emptyText).toContainText("as-played MIDI does not need one");
    await expect(v.scroll).toBeHidden();
    // The one download that needs no grid, for the stems on show.
    await expect(v.emptyLink).toHaveText("MIDI, as played");
    const href = await v.emptyLink.getAttribute("href");
    expect(new URL(href, "http://x").pathname).toBe(`/api/jobs/${SONG}/transcription.mid`);
    expect(query(href)).toEqual({ stems: "vocals,guitar,bass,drums" });
    // The downloads that do need one are not offered.
    await v.downloads.click();
    await expect(v.midiQuantised).toHaveAttribute("aria-disabled", "true");
    await expect(v.musicxml).toHaveAttribute("aria-disabled", "true");
    await expect(v.guitarPro).toBeDisabled();
    await expect(v.midiPlayed).toHaveAttribute("aria-disabled", "false");
  });

  test("where transcription cannot run, the view is not offered", async ({ page }) => {
    await page.route("**/api/config", async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), transcription_available: false } });
    });
    await openSong(page);
    await expect(ui(page).chip).toBeHidden();
    await expect(ui(page).drawer).toBeHidden();
    // Its neighbours are still there: only this chip is withheld.
    await expect(page.locator("#t-export-btn")).toBeVisible();
  });

  // ── 4.4 Following the player ──

  test("the cursor is in the bar being heard, through the song", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    await expectBar(page, 0);
    await expect(ui(page).bar).toHaveText("Bar 1");

    await page.locator("#t-play").click();
    for (const bar of [0, 1, 2]) {
      const at = await barWhenPast(page, bar * BAR_SEC + 0.7);
      expect(at.time, "sampled inside the bar").toBeLessThan((bar + 1) * BAR_SEC);
      expect(at.bar, `bar at ${at.time.toFixed(2)} s`).toBe(bar);
    }
    // Paused, the cursor stays where the song stopped.
    await page.locator("#t-play").click();
    await expect.poll(async () => (await player(page)).playing).toBe(false);
    const stopped = await player(page);
    await expectBar(page, Math.floor(stopped.time / BAR_SEC));
    await expect(ui(page).bar).toHaveText(`Bar ${Math.floor(stopped.time / BAR_SEC) + 1}`);
  });

  test("at half speed the cursor moves at half the pace and stays on the bar", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    await page.locator("#t-speed-05").click();
    await page.locator("#t-play").click();
    const started = Date.now();
    const first = await barWhenPast(page, 0.8);
    expect(first.bar).toBe(0);
    const second = await barWhenPast(page, BAR_SEC + 0.5);
    expect(second.bar).toBe(1);
    // Two and a half seconds of song took about five of the clock.
    expect(Date.now() - started).toBeGreaterThan(4000);
  });

  test("when a loop jumps back, the cursor jumps back with it", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    // Bars two and three: from 2 s to just short of the end of the song.
    expect(await page.evaluate(async () => (await import("/js/transport.js")).setLoopRange(2, 5.8))).toBe(true);
    await page.locator("#t-play").click();
    const late = await barWhenPast(page, 4.6);
    expect(late.bar).toBe(2);
    // Past the loop end the song is back in bar two.
    const wrapped = await page.evaluate(async () => {
      const tx = (await import("/js/transport.js")).transport();
      let last = tx.getCurrentTime();
      await new Promise((resolve, reject) => {
        const started = performance.now();
        const look = () => {
          const now = tx.getCurrentTime();
          if (now < last - 1) return resolve();
          last = now;
          if (performance.now() - started > 20000) return reject(new Error("the loop never wrapped"));
          requestAnimationFrame(look);
        };
        look();
      });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { time: tx.getCurrentTime(), bar: Number(document.querySelector("#notationScore").dataset.bar) };
    });
    expect(wrapped.time).toBeGreaterThanOrEqual(2);
    expect(wrapped.time).toBeLessThan(4);
    expect(wrapped.bar).toBe(1);
  });

  test("a click on a bar moves the song there, and the rest of the player with it", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    // Where bar three is on the page: put the cursor there and read its box,
    // once the box has stopped moving (alphaTab slides its cursor into place).
    const cursorBox = async () => {
      let last = null;
      await expect.poll(async () => {
        const box = await v.score.locator(".at-cursor-bar").boundingBox();
        const settled = Boolean(last && box && Math.abs(box.x - last.x) < 0.5 && Math.abs(box.width - last.width) < 0.5);
        last = box;
        return settled;
      }).toBe(true);
      return last;
    };
    await expectBar(page, 0);
    const first = await cursorBox();
    await seek(page, 2 * BAR_SEC + 0.01);
    await expectBar(page, 2);
    await expect.poll(async () => (await v.score.locator(".at-cursor-bar").boundingBox()).x).toBeGreaterThan(first.x + first.width);
    const third = await cursorBox();
    await seek(page, 0);
    await expectBar(page, 0);
    await expect.poll(async () => (await v.score.locator(".at-cursor-bar").boundingBox()).x).toBeLessThan(third.x);

    // The first beat of bar three, on the top staff.
    await page.mouse.click(third.x + 14, third.y + 40);
    await expect.poll(async () => (await player(page)).time).toBeCloseTo(4, 1);
    await expectBar(page, 2);
    // The footer clock and the waveform's playhead say the same.
    await expect(page.locator("#footer-time-elapsed")).toHaveText("00:04");
    const lanes = await page.locator("#ruler-time").boundingBox();
    const head = await page.locator(".playhead-marker").boundingBox();
    expect((head.x + head.width / 2 - lanes.x) / lanes.width).toBeCloseTo(4 / SONG_SEC, 1);
    // A click moves the song; it does not start it.
    expect((await player(page)).playing).toBe(false);
  });

  test("a seek on the waveform moves the cursor while paused", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    await seek(page, 5.5);
    await expectBar(page, 2);
    await seek(page, 2.2);
    await expectBar(page, 1);
  });

  test("a seek while paused scrolls the score to the bar the song is on", async ({ page }) => {
    // A narrow window, large notes and a short drawer: the three bars take
    // more than one system, and the later ones are below what is on show.
    await page.setViewportSize({ width: 960, height: 900 });
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    for (let i = 0; i < 6; i++) await v.zoomIn.click({ force: true });
    await expect(v.zoomValue).toHaveText("150%");
    await v.resize.focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await v.scroll.evaluate((el) => el.scrollHeight - el.clientHeight))).toBeGreaterThan(400);
    // Where the cursor's bar is in the score, and whether its top is in the
    // part of the score on show.
    const cursor = () => page.evaluate(() => {
      const scroller = document.querySelector("#notationScroll");
      const view = scroller.getBoundingClientRect();
      const bar = document.querySelector("#notationScore .at-cursor-bar").getBoundingClientRect();
      const top = bar.top - view.top;
      return { inScore: Math.round(top + scroller.scrollTop), onShow: top >= -1 && top < view.height, scrollTop: scroller.scrollTop };
    });
    await seek(page, 0);
    await expectBar(page, 0);
    await expect.poll(async () => (await cursor()).onShow).toBe(true);
    const start = await cursor();

    // The last bar is on a later system, far below: the cursor goes there,
    // and the score glides after it until it is on show.
    await seek(page, 2 * BAR_SEC + 0.3);
    await expectBar(page, 2);
    await expect.poll(async () => (await cursor()).inScore).toBeGreaterThan(start.inScore + 400);
    await expect.poll(async () => (await cursor()).onShow).toBe(true);
    const end = await cursor();
    expect(end.scrollTop).toBeGreaterThan(start.scrollTop + 400);

    // And back again.
    await seek(page, 0.1);
    await expectBar(page, 0);
    await expect.poll(async () => (await cursor()).inScore).toBe(start.inScore);
    await expect.poll(async () => (await cursor()).onShow).toBe(true);
    expect((await cursor()).scrollTop).toBeLessThan(end.scrollTop - 400);
    expect((await player(page)).playing).toBe(false);
  });

  // A narrow window, large notes and a short drawer: the three bars take more
  // than one system, and the later ones are below what is on show.
  async function tallScore(page) {
    await page.setViewportSize({ width: 960, height: 900 });
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    for (let i = 0; i < 6; i++) await v.zoomIn.click({ force: true });
    await expect(v.zoomValue).toHaveText("150%");
    await v.resize.focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await v.scroll.evaluate((el) => el.scrollHeight - el.clientHeight))).toBeGreaterThan(400);
    return v;
  }

  // Where the cursor's bar is, and whether its top is in the part on show.
  const cursorPlace = (page) => page.evaluate(() => {
    const scroller = document.querySelector("#notationScroll");
    const view = scroller.getBoundingClientRect();
    const bar = document.querySelector("#notationScore .at-cursor-bar").getBoundingClientRect();
    const top = bar.top - view.top;
    return { onShow: top >= -1 && top < view.height, scrollTop: scroller.scrollTop };
  });

  test("the score keeps following the song after it is drawn again while playing", async ({ page }) => {
    // A reader unticks a stem with the song running. alphaTab stops its own
    // playing state when it is given a score, and has to be told again, or
    // the cursor walks off the bottom of the drawer and nothing scrolls.
    const v = await tallScore(page);
    await page.locator("#t-speed-05").click(); // six seconds of song, twelve of clock
    const start = await cursorPlace(page);
    await page.locator("#t-play").click();
    await expect.poll(async () => (await player(page)).playing).toBe(true);
    await v.stem("vocals").uncheck();
    await expect(v.score).toHaveAttribute("data-tracks", "3");
    await expect(v.drawer).toHaveAttribute("aria-busy", "false");
    expect((await player(page)).playing, "the redraw did not stop the song").toBe(true);
    expect((await player(page)).time, "redrawn before the last bar").toBeLessThan(2 * BAR_SEC);

    const late = await barWhenPast(page, 2 * BAR_SEC + 0.5);
    expect(late.bar).toBe(2);
    await expect.poll(async () => (await cursorPlace(page)).onShow).toBe(true);
    expect((await cursorPlace(page)).scrollTop).toBeGreaterThan(start.scrollTop + 200);
  });

  test("Follow off leaves the score where the reader put it, and on brings the bar back", async ({ page }) => {
    const v = await tallScore(page);
    await expect(v.follow).toBeChecked();
    await seek(page, 0);
    await expectBar(page, 0);
    await expect.poll(async () => (await cursorPlace(page)).onShow).toBe(true);
    const top = (await cursorPlace(page)).scrollTop;

    // Off: the song moves on, paused or playing, and the score stays put.
    await v.follow.uncheck();
    await seek(page, 2 * BAR_SEC + 0.3);
    await expectBar(page, 2);
    await page.waitForTimeout(600); // longer than the glide a follow would take
    expect(await cursorPlace(page)).toEqual({ onShow: false, scrollTop: top });
    await seek(page, 0);
    await expectBar(page, 0);
    await page.locator("#t-speed-05").click();
    await page.locator("#t-play").click();
    const late = await barWhenPast(page, 2 * BAR_SEC + 0.5);
    expect(late.bar).toBe(2);
    expect(await cursorPlace(page)).toEqual({ onShow: false, scrollTop: top });
    // The reader's own scrolling is theirs.
    await v.scroll.evaluate((el) => { el.scrollTop = 40; });
    await page.waitForTimeout(300);
    expect((await cursorPlace(page)).scrollTop).toBe(40);
    await page.locator("#t-play").click();
    await expect.poll(async () => (await player(page)).playing).toBe(false);

    // On again: the bar the song is in comes back into view at once.
    await v.follow.check();
    await expect.poll(async () => (await cursorPlace(page)).onShow).toBe(true);
    expect((await cursorPlace(page)).scrollTop).toBeGreaterThan(top + 200);

    // The choice is the song's, like the zoom.
    await v.follow.uncheck();
    await page.reload({ waitUntil: "domcontentloaded" });
    await pickSong(page, SONG);
    await openScore(page);
    await expect(v.follow).not.toBeChecked();
    await v.follow.check();
  });

  // ── 4.5 The view's choices ──

  test("unticking a stem removes its staff and asks only for the others", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    const asked = page.waitForRequest((r) => SCORE.test(r.url()) && !query(r.url()).stems.includes("drums"));
    await v.stem("drums").uncheck();
    expect(query((await asked).url()).stems).toBe("vocals,guitar,bass");
    await expect(v.score).toHaveAttribute("data-tracks", "3");
    // The staves arrive a moment after the score is counted: wait for them.
    const drawn = () => v.score.evaluate((el) => [...el.querySelectorAll("svg text")].map((t) => t.textContent).join("|"));
    await expect.poll(drawn).toContain("Bass");
    expect(await drawn()).not.toContain("Drums");

    // Unticking them all says so, instead of an empty sheet.
    for (const name of ["vocals", "guitar", "bass"]) await v.stem(name).uncheck();
    await expect(v.drawer).toHaveAttribute("data-state", "no-stems");
    await expect(v.emptyText).toContainText("No stem is ticked");
    await v.stem("bass").check();
    await expect(v.score).toHaveAttribute("data-tracks", "1");
    await expect(v.drawer).toHaveAttribute("data-state", "score");
  });

  test("changing the resolution redraws the score on that grid", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    await expect(v.parts).toHaveValue("4");
    const answer = page.waitForResponse((r) => SCORE.test(r.url()) && query(r.url()).parts === "3");
    await v.parts.selectOption("3");
    const body = await (await answer).json();
    expect(body.parts).toBe(3);
    // The guitar's eighth notes do not fit a triplet grid: they are snapped to it.
    expect(body.alphatex).toContain("{tu 3}");
    await expect(v.score).toHaveAttribute("data-warnings", "0");
    await expect(v.score).toHaveAttribute("data-tracks", "4");
    // The downloads follow the resolution.
    await v.downloads.click();
    expect(query(await v.musicxml.getAttribute("href")).parts).toBe("3");
  });

  test("zoom steps between its limits and is redrawn by alphaTab", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    await expect(v.zoomValue).toHaveText("80%");
    const width = async () => (await v.score.locator(".at-cursor-bar").boundingBox()).width;
    const before = await width();
    await v.zoomIn.click();
    await v.zoomIn.click();
    await expect(v.zoomValue).toHaveText("100%");
    await expect.poll(width).toBeGreaterThan(before * 1.1);
    for (let i = 0; i < 12; i++) await v.zoomOut.click({ force: true });
    await expect(v.zoomValue).toHaveText("50%");
    await expect(v.zoomOut).toBeDisabled();
  });

  test("the choices are remembered for the song", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    await v.stem("drums").uncheck();
    await expect(v.score).toHaveAttribute("data-tracks", "3");
    await v.parts.selectOption("2");
    await v.zoomIn.click();
    await expect(v.zoomValue).toHaveText("90%");

    // Another song, then back: the view opens as it was left.
    await pickSong(page, JOB_ID);
    await expect(v.drawer).toHaveAttribute("data-state", "untranscribed");
    await pickSong(page, SONG);
    await expect(v.score).toHaveAttribute("data-tracks", "3", { timeout: 30000 });
    await expect(v.stem("drums")).not.toBeChecked();
    await expect(v.parts).toHaveValue("2");
    await expect(v.zoomValue).toHaveText("90%");

    // And after the app is opened again.
    await page.reload({ waitUntil: "domcontentloaded" });
    await pickSong(page, SONG);
    await openScore(page, 3);
    await expect(v.stem("drums")).not.toBeChecked();
    await expect(v.stem("bass")).toBeChecked();
    await expect(v.parts).toHaveValue("2");
    await expect(v.zoomValue).toHaveText("90%");
  });

  test("the score follows an edit to the beat grid", async ({ page, request }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    await expect(v.score).toHaveAttribute("data-bars", "3");
    // The grid is corrected to bars of three, as the beat editor saves it.
    const beats = Array.from({ length: 12 }, (_, i) => i * 0.5);
    const saved = await request.patch(`/api/jobs/${SONG}/beats`, { data: { beats, bars: [{ beat: 0, beats_per_bar: 3 }] } });
    expect(saved.ok()).toBe(true);
    await page.evaluate((id) => document.dispatchEvent(new CustomEvent("stemdeck:beats-saved", { detail: { id } })), SONG);
    await expect(v.score).toHaveAttribute("data-bars", "4", { timeout: 20000 });
    // Bar two now starts at 1.5 s.
    await seek(page, 1.6);
    await expectBar(page, 1);
    // And a view opened later shows the grid as it is now.
    await v.close.click();
    await request.delete(`/api/jobs/${SONG}/beats`);
    await openScore(page);
    await expect(v.score).toHaveAttribute("data-bars", "3");
  });

  test("the beat editor and the transcribe dialog tell the view when they change the song", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    // A run that ends, as the dialog announces it: the view asks again.
    const again = page.waitForRequest((r) => SCORE.test(r.url()));
    await page.evaluate((id) => document.dispatchEvent(new CustomEvent("stemdeck:transcription-changed", { detail: { id } })), SONG);
    await again;
    await expect(v.score).toHaveAttribute("data-tracks", "4");
    // The foot links to the beat editor, where a wrong grid is fixed.
    await expect(v.foot).toContainText("Transcribed automatically");
    await expect(v.foot).toContainText("Beat grid confidence: 95%");
    await page.locator("#notationEditGrid").click();
    await expect(page.locator("#beatgrid-toolbar")).toBeVisible();
  });

  // ── 4.6 The view is silent ──

  test("opening the view makes no sound of its own", async ({ page }) => {
    await page.addInitScript(() => {
      window.__audioContexts = 0;
      for (const name of ["AudioContext", "webkitAudioContext", "OfflineAudioContext"]) {
        const Original = window[name];
        if (!Original) continue;
        window[name] = class extends Original {
          constructor(...args) { super(...args); window.__audioContexts += 1; }
        };
      }
    });
    const asked = [];
    page.on("request", (r) => asked.push(r.url()));
    await openSong(page);
    await page.locator("#t-play").click();
    await expect.poll(async () => (await player(page)).playing).toBe(true);
    const before = await page.evaluate(() => window.__audioContexts);
    expect(before).toBeGreaterThan(0); // the player's own

    await openScore(page);
    await barWhenPast(page, 1.2);
    // No second audio context, no synthesiser, no soundfont, no worklet.
    expect(await page.evaluate(() => window.__audioContexts)).toBe(before);
    expect(asked.filter((u) => /soundfont|\.sf2|\.sf3|worklet/i.test(u) && /alphatab/i.test(u))).toEqual([]);
    expect(asked.filter((u) => /\.sf2|\.sf3|sonivox/i.test(u))).toEqual([]);
    expect((await player(page)).playing).toBe(true);
    // Mute, solo and the rest are the player's: the view has no such control.
    await expect(ui(page).drawer.locator("audio, video")).toHaveCount(0);
  });

  // ── 7.2 Nothing comes from the internet ──

  test("with no internet the view still draws the score in its music font", async ({ page }) => {
    // The machine is offline: anything that is not this app's own server
    // fails, as it would with the network cable out. (Playwright's own
    // offline switch also cuts the page off from the app on localhost, which
    // is not what being offline does to a local app.)
    const origin = new URL(test.info().project.use.baseURL).origin;
    const cut = [];
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || /^(data|blob):/.test(url)) return route.continue();
      cut.push(url);
      return route.abort("internetdisconnected");
    });
    await openSong(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await pickSong(page, SONG);
    await openScore(page);
    const v = ui(page);
    await expect(v.score).toHaveAttribute("data-warnings", "0");

    // The music font is the vendored Bravura, loaded and in use.
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, ""));
    });
    expect(fonts).toContain("alphaTab");
    const served = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name));
    expect(served.some((u) => u.endsWith("/vendor/alphatab/font/Bravura.woff2"))).toBe(true);
    // Notes, clefs and rests are glyphs of that font: there are many on the page.
    const glyphs = await v.score.evaluate((el) => el.querySelectorAll("svg text, svg .at").length);
    expect(glyphs).toBeGreaterThan(40);
    // And the cursor still follows the song.
    await seek(page, 4.5);
    await expectBar(page, 2);
    // Nothing the view needs was among what the dead network refused.
    expect(cut.filter((u) => /alphatab|bravura|notation|transcription/i.test(u))).toEqual([]);
  });

  // ── 5.1 Tab, tuning and capo ──

  test("bass as tab and guitar in drop D redraw the score with no transcription run", async ({ page }) => {
    // Everything the page writes about the song's notes. (Opening a song
    // makes other writes of its own, which are not this view's.)
    const writes = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (r.method() !== "GET" && path.includes("/transcription")) writes.push(`${r.method()} ${path}`);
    });
    await openSong(page);
    await openScore(page);
    const v = ui(page);

    // Fretted stems have the choices; the others do not.
    await expect(v.tab("guitar")).toBeVisible();
    await expect(v.tab("bass")).toBeVisible();
    await expect(page.locator("#notationTabs .notation-tab")).toHaveCount(2);
    await expect(v.tab("guitar").locator(".notation-tab-display")).toHaveValue("both");
    await expect(v.tab("guitar").locator(".notation-tab-tuning")).toHaveValue("standard");
    await expect(v.tab("guitar").locator(".notation-tab-strings")).toHaveText("E2 A2 D3 G3 B3 E4");
    await expect(v.tab("bass").locator(".notation-tab-strings")).toHaveText("E1 A1 D2 G2");
    await expect(v.tab("guitar").locator(".notation-tab-capo")).toHaveValue("0");

    let answer = page.waitForResponse((r) => SCORE.test(r.url()) && r.request().method() === "GET");
    await v.tab("bass").locator(".notation-tab-display").selectOption("tab");
    let body = await (await answer).json();
    expect(body.tab.bass.display).toBe("tab");
    expect(body.alphatex).toContain("\\staff {tabs} \\tuning (G2 D2 A1 E1)");
    await expect(v.tab("bass").locator(".notation-tab-display")).toHaveValue("tab");

    answer = page.waitForResponse((r) => SCORE.test(r.url()) && r.request().method() === "GET");
    await v.tab("guitar").locator(".notation-tab-tuning").selectOption("drop_d");
    body = await (await answer).json();
    expect(body.tab.guitar).toMatchObject({ preset: "drop_d", tuning: [38, 45, 50, 55, 59, 64], unplaced: 0 });
    // One staff with frets now: every note has a place, the low D on the open sixth string.
    expect(body.alphatex).toContain("\\staff {score tabs} \\tuning (E4 B3 G3 D3 A2 D2)");
    expect(body.alphatex).toContain("0.6.4 0.5.4 0.4.4 0.6.4 |");
    await expect(v.tab("guitar").locator(".notation-tab-strings")).toHaveText("D2 A2 D3 G3 B3 E4");
    await expect(v.score).toHaveAttribute("data-tracks", "4");
    await expect(v.score).toHaveAttribute("data-warnings", "0");

    answer = page.waitForResponse((r) => SCORE.test(r.url()) && r.request().method() === "GET");
    await v.tab("bass").locator(".notation-tab-capo").fill("2");
    await v.tab("bass").locator(".notation-tab-capo").blur();
    body = await (await answer).json();
    expect(body.tab.bass.capo).toBe(2);
    expect(body.alphatex).toContain("\\capo (2)");

    // Saved on the server, where the downloads read it. Nothing else was written.
    // Three choices, three saves, and no POST that would start a model.
    expect(writes).toEqual([`PATCH ${TAB}`, `PATCH ${TAB}`, `PATCH ${TAB}`]);

    // The choice is the song's: it is there when the song is opened again.
    await page.reload({ waitUntil: "domcontentloaded" });
    await pickSong(page, SONG);
    await openScore(page);
    await expect(v.tab("guitar").locator(".notation-tab-tuning")).toHaveValue("drop_d");
    await expect(v.tab("bass").locator(".notation-tab-display")).toHaveValue("tab");
    await expect(v.tab("bass").locator(".notation-tab-capo")).toHaveValue("2");
  });

  test("a stem shown as staff only keeps its tuning choices, and hiding it removes them", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    const answer = page.waitForResponse((r) => SCORE.test(r.url()));
    await v.tab("guitar").locator(".notation-tab-display").selectOption("score");
    expect((await (await answer).json()).alphatex).not.toContain("\\staff {tabs} \\tuning (E4");
    await expect(v.tab("guitar").locator(".notation-tab-display")).toHaveValue("score");
    await v.stem("guitar").uncheck();
    await expect(v.tab("guitar")).toHaveCount(0);
    await expect(v.tab("bass")).toBeVisible();
    await v.stem("bass").uncheck();
    await expect(page.locator("#notationTabs")).toBeHidden();
  });

  test("a custom tuning is typed as note names", async ({ page }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    const tuning = v.tab("guitar").locator(".notation-tab-tuning");
    const custom = v.tab("guitar").locator(".notation-tab-custom");
    await expect(custom).toBeHidden();
    await tuning.selectOption("custom");
    await expect(custom).toBeVisible();
    await expect(custom).toBeFocused();

    await custom.fill("D2 A2 D3 nope");
    await custom.press("Enter");
    await expect(custom).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#notationTabError")).toContainText("note names");

    const answer = page.waitForResponse((r) => SCORE.test(r.url()));
    await custom.fill("C2 G2 C3 G3 C4 E4");
    await custom.press("Enter");
    const body = await (await answer).json();
    expect(body.tab.guitar).toMatchObject({ preset: "custom", tuning: [36, 43, 48, 55, 60, 64] });
    await expect(v.tab("guitar").locator(".notation-tab-tuning")).toHaveValue("custom");
    await expect(v.tab("guitar").locator(".notation-tab-custom")).toHaveValue("C2 G2 C3 G3 C4 E4");
    // Space in the field is a space, not Play.
    expect((await player(page)).playing).toBe(false);
  });

  // ── 5.2 Notes left off the tab ──

  test("notes the tuning cannot reach are counted, and the suggested tuning is one click", async ({ page }) => {
    const writes = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (r.method() !== "GET" && path.includes("/transcription")) writes.push(`${r.method()} ${path}`);
    });
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    const notice = v.notice("guitar");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-unplaced", "4");
    await expect(notice).toContainText("Guitar: notes left off the tab: 4.");
    await expect(notice).toContainText("Outside this tuning's range: 4.");
    await expect(notice).toContainText("Drop D reaches more of them.");
    await expect(v.notice("bass")).toHaveCount(0);

    const use = notice.locator("button.notation-use");
    await expect(use).toHaveText("Use Drop D");
    const answer = page.waitForResponse((r) => SCORE.test(r.url()));
    await use.click();
    const body = await (await answer).json();
    expect(body.tab.guitar).toMatchObject({ preset: "drop_d", unplaced: 0, suggestion: null });
    await expect(v.notices).toBeHidden();
    await expect(v.tab("guitar").locator(".notation-tab-tuning")).toHaveValue("drop_d");
    expect(writes).toEqual([`PATCH ${TAB}`]);
  });

  test("a bass note below the lowest string is reported with a five-string hint", async ({ page }) => {
    // One stray low note among many is below the 5% that earns a named
    // suggestion, so the view says what kind of tuning would reach it.
    await page.route(SCORE, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (body.tab?.bass) body.tab.bass = { ...body.tab.bass, unplaced: 1, reasons: { out_of_range: 1 }, suggestion: null };
      await route.fulfill({ response: res, json: body });
    });
    await openSong(page);
    await openScore(page);
    const notice = ui(page).notice("bass");
    await expect(notice).toContainText("Bass: notes left off the tab: 1.");
    await expect(notice).toContainText("A five-string bass or a lower tuning may reach them.");
    await expect(notice.locator("button")).toHaveCount(0);
  });

  // ── 6.2 and 6.3 Downloads ──

  test("the four downloads are for the stems shown, each named after the song", async ({ page, request }) => {
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    await v.stem("vocals").uncheck();
    await v.stem("drums").uncheck();
    await expect(v.score).toHaveAttribute("data-tracks", "2");
    await v.parts.selectOption("8");
    await expect(v.score).toHaveAttribute("data-warnings", "0");
    await v.downloads.click();

    const base = `/api/jobs/${SONG}/transcription`;
    const want = [
      [v.midiPlayed, "MIDI, as played", `${base}.mid`, { stems: "guitar,bass" }, "E2E_MP3_Track_notes.mid"],
      [v.midiQuantised, "MIDI, on the beat grid", `${base}.mid`, { stems: "guitar,bass", quantize: "1", parts: "8" }, "E2E_MP3_Track_notes_quantised.mid"],
      [v.musicxml, "Sheet music (MusicXML)", `${base}.musicxml`, { stems: "guitar,bass", parts: "8" }, "E2E_MP3_Track.musicxml"],
    ];
    for (const [link, label, path, params, name] of want) {
      await expect(link).toBeVisible();
      await expect(link).toHaveText(label);
      const href = await link.getAttribute("href");
      expect(new URL(href, "http://x").pathname).toBe(path);
      expect(query(href)).toEqual(params);
      await expect(link).toHaveAttribute("download", name);
      // The link is live, and the server names the file the same.
      const res = await request.get(href);
      expect(res.ok()).toBe(true);
      expect(res.headers()["content-disposition"]).toBe(`attachment; filename="${name}"`);
    }
    await expect(v.guitarPro).toBeVisible();
    await expect(v.guitarPro).toHaveText("Guitar Pro");
    await expect(v.guitarPro).toBeEnabled();

    // The MusicXML holds the two parts shown and no others.
    const xml = await (await request.get(await v.musicxml.getAttribute("href"))).text();
    expect([...xml.matchAll(/<part-name>([^<]+)<\/part-name>/g)].map((m) => m[1])).toEqual(["guitar", "bass"]);
  });

  test("a Guitar Pro track is one staff even when the view shows two", async ({ page }) => {
    // In standard tuning the guitar's low Ds have no string. The view keeps
    // them on a staff of their own; a tab editor wants one staff per track.
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    await expect(v.notice("guitar")).toHaveAttribute("data-unplaced", "4");
    await v.stem("vocals").uncheck();
    await v.stem("drums").uncheck();
    await v.stem("bass").uncheck();
    await expect(v.score).toHaveAttribute("data-tracks", "1");
    const asked = page.waitForRequest((r) => SCORE.test(r.url()) && query(r.url()).unplaced === "omit");
    await v.downloads.click();
    const [download] = await Promise.all([page.waitForEvent("download"), v.guitarPro.click()]);
    expect(query((await asked).url())).toMatchObject({ stems: "guitar", parts: "4", unplaced: "omit" });
    const bytes = [...(await import("node:fs")).readFileSync(await download.path())];
    const read = await page.evaluate(async (data) => {
      const alphaTab = await import("/vendor/alphatab/alphaTab.min.mjs");
      const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(data), new alphaTab.Settings());
      const [track] = score.tracks;
      const [staff] = track.staves;
      return {
        tracks: score.tracks.length,
        staves: track.staves.length,
        tab: staff.showTablature,
        notation: staff.showStandardNotation,
        tuning: [...staff.tuning].reverse(),
        firstBar: staff.bars[0].voices[0].beats.map((beat) => (beat.isRest ? "rest" : beat.notes.map((n) => `${n.fret}.${staff.tuning.length - n.string + 1}`).join("+"))),
      };
    }, bytes);
    expect(read).toEqual({
      tracks: 1,
      staves: 1,
      tab: true,
      notation: true,
      tuning: [40, 45, 50, 55, 59, 64],
      // D2 A2 D3 D2: the two low Ds are rests, the others open strings.
      firstBar: ["rest", "0.5", "0.4", "rest"],
    });
  });

  test("the Guitar Pro file opens again with the same tracks, tunings, capo and frets", async ({ page, request }) => {
    // Guitar in drop D; bass as a five-string with a capo at the second fret.
    await request.patch(TAB, { data: { guitar: { preset: "drop_d" }, bass: { preset: "five_string", capo: 2 } } });
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    await v.stem("vocals").uncheck();
    await v.stem("drums").uncheck();
    await expect(v.score).toHaveAttribute("data-tracks", "2");

    // The view makes the file, hands it to the server, and downloads it from
    // there: the one way of saving that the desktop app has too.
    const held = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === GUITAR_PRO);
    await v.downloads.click();
    const [download] = await Promise.all([page.waitForEvent("download"), v.guitarPro.click()]);
    expect(download.suggestedFilename()).toBe("E2E_MP3_Track.gp");
    expect(new URL(download.url()).pathname).toBe(GUITAR_PRO);
    const answer = await held;
    expect(answer.status()).toBe(200);
    expect(answer.request().headers()["content-type"]).toBe("application/octet-stream");
    const bytes = [...(await import("node:fs")).readFileSync(await download.path())];
    expect(await answer.json()).toEqual({ job_id: SONG, url: GUITAR_PRO, file_name: "E2E_MP3_Track.gp", bytes: bytes.length });
    expect(bytes.length).toBeGreaterThan(500);
    // A Guitar Pro 7 file is a zip.
    expect(String.fromCharCode(...bytes.slice(0, 2))).toBe("PK");

    // Read the bytes back with alphaTab, as a tab editor would.
    const read = await page.evaluate(async (data) => {
      const alphaTab = await import("/vendor/alphatab/alphaTab.min.mjs");
      const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(data), new alphaTab.Settings());
      return {
        title: score.title,
        bars: score.masterBars.length,
        meter: score.masterBars.map((b) => `${b.timeSignatureNumerator}/${b.timeSignatureDenominator}`),
        tracks: score.tracks.map((track) => {
          const staff = track.staves.find((s) => s.showTablature) || track.staves[0];
          return {
            name: track.name,
            staves: track.staves.length,
            tuning: [...staff.tuning].reverse(), // lowest string first, as the app writes it
            capo: staff.capo,
            // The first bar, a beat at a time: [string from the highest, fret].
            firstBar: staff.bars[0].voices[0].beats.map((beat) =>
              beat.notes.map((n) => [staff.tuning.length - n.string + 1, n.fret]).sort((a, b) => a[0] - b[0])),
          };
        }),
      };
    }, bytes);

    // One staff of notation and tab for each fretted stem.
    expect(read.tracks.map((t) => t.staves)).toEqual([1, 1]);
    expect(read.title).toBe(SONG_TITLE);
    expect(read.bars).toBe(BARS);
    expect(read.meter).toEqual(["4/4", "4/4", "4/4"]);
    expect(read.tracks.map((t) => t.name)).toEqual(["Guitar", "Bass"]);
    const [guitar, bass] = read.tracks;
    expect(guitar.tuning).toEqual([38, 45, 50, 55, 59, 64]);
    expect(guitar.capo).toBe(0);
    expect(bass.tuning).toEqual([23, 28, 33, 38, 43]);
    expect(bass.capo).toBe(2);
    // The frets in the file are the frets the view draws: the endpoint's own.
    const body = await (await request.get(`/api/jobs/${SONG}/transcription.alphatex?format=json&stems=guitar,bass`)).json();
    const lines = body.alphatex.split("\n");
    const firstBarOf = (staffLine) => lines[lines.findIndex((l) => l.startsWith(staffLine)) + 1];
    expect(firstBarOf("\\staff {score tabs} \\tuning (E4 B3 G3 D3 A2 D2)")).toContain("0.6.4 0.5.4 0.4.4 0.6.4 |");
    expect(guitar.firstBar).toEqual([[[6, 0]], [[5, 0]], [[4, 0]], [[6, 0]]]);
    // Bass: D2 then A1, half notes. With a capo at 2 the A string's open note is B1.
    expect(firstBarOf("\\staff {score tabs} \\tuning (G2 D2 A1 E1 B0) \\capo (2)")).toMatch(/^\\clef \(F4\) \\ks \(dminor\) (\d+\.\d\.2) (\d+\.\d\.2) \|$/);
    const written = [...firstBarOf("\\staff {score tabs} \\tuning (G2 D2 A1 E1 B0) \\capo (2)").matchAll(/(\d+)\.(\d)\.2/g)]
      .map((m) => [[Number(m[2]), Number(m[1])]]);
    expect(bass.firstBar).toEqual(written);
    // And those frets sound the notes: open string + capo + fret.
    const open = [43, 38, 33, 28, 23];
    expect(bass.firstBar.map(([[string, fret]]) => open[string - 1] + 2 + fret)).toEqual([38, 33]);
  });

  test("the desktop app saves the Guitar Pro file through its own dialog", async ({ page }) => {
    // The shell saves only what it fetches from the server, so the file the
    // view makes has to be waiting there by the time the shell is given a URL.
    await stubTauri(page);
    const posts = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === GUITAR_PRO) posts.push(r.url());
    });
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    await v.stem("vocals").uncheck();
    await v.stem("drums").uncheck();
    await expect(v.score).toHaveAttribute("data-tracks", "2");

    await v.downloads.click();
    await v.guitarPro.click();
    // First the dialog, under the song's name. Nothing is made while it is open.
    await page.waitForFunction(() => window.__e2e.pickPending());
    const pick = await page.evaluate(() => window.__e2e.callsFor("pick_export_destination").at(-1).args);
    expect(pick).toEqual({ filename: "E2E_MP3_Track.gp" });
    expect(posts).toEqual([]);
    await expect(v.guitarPro).toBeDisabled();

    // A place is chosen: the file is made, held, and the shell is told where.
    await page.evaluate(() => window.__e2e.choosePath());
    await page.waitForFunction(() => window.__e2e.savePending());
    expect(posts).toHaveLength(1);
    const save = await page.evaluate(() => window.__e2e.callsFor("download_to_path").at(-1).args);
    expect(save.token).toBe("token-1");
    const url = new URL(save.url);
    expect(url.origin).toBe(new URL(page.url()).origin); // absolute, as the shell requires
    expect(url.pathname).toBe(GUITAR_PRO);

    // What the shell fetches from there is the Guitar Pro file, named after the song.
    const fetched = await page.evaluate(async (href) => {
      const res = await fetch(href);
      const data = new Uint8Array(await res.arrayBuffer());
      const alphaTab = await import("/vendor/alphatab/alphaTab.min.mjs");
      const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(data, new alphaTab.Settings());
      return {
        status: res.status,
        disposition: res.headers.get("content-disposition"),
        magic: String.fromCharCode(data[0], data[1]),
        tracks: score.tracks.map((track) => track.name),
      };
    }, save.url);
    expect(fetched).toEqual({
      status: 200,
      disposition: 'attachment; filename="E2E_MP3_Track.gp"',
      magic: "PK",
      tracks: ["Guitar", "Bass"],
    });
    await page.evaluate(() => window.__e2e.finishSave());
    await expect(v.guitarPro).toBeEnabled();
    await expect(page.locator("#notationTabError")).toHaveCount(0);
  });

  test("a cancelled save dialog makes no Guitar Pro file", async ({ page }) => {
    await stubTauri(page);
    const posts = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === GUITAR_PRO) posts.push(r.url());
    });
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    await v.downloads.click();
    await v.guitarPro.click();
    await page.waitForFunction(() => window.__e2e.pickPending());
    await page.evaluate(() => window.__e2e.cancelPick());
    await expect(v.guitarPro).toBeEnabled();
    expect(posts).toEqual([]);
    expect(await page.evaluate(() => window.__e2e.callsFor("download_to_path").length)).toBe(0);
  });

  test("a Guitar Pro file the server will not hold is reported, not saved", async ({ page }) => {
    await page.route(`**${GUITAR_PRO}`, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: "that is not a Guitar Pro (.gp) file" }) })
        : route.fallback());
    await openSong(page);
    await openScore(page);
    const v = ui(page);
    let downloads = 0;
    page.on("download", () => { downloads += 1; });
    await v.downloads.click();
    await v.guitarPro.click();
    await expect(page.locator("#notationTabError")).toHaveText("The Guitar Pro file could not be made. Try again.");
    await expect(v.guitarPro).toBeEnabled();
    expect(downloads).toBe(0);
  });
});
