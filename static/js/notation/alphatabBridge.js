// The one module that knows alphaTab (openspec change add-alphatab-notation).
//
// alphaTab is the notation and tablature renderer vendored under
// static/vendor/alphatab/. Everything else in the Notation view talks to the
// small object this module returns, so upgrading alphaTab, or replacing it,
// touches this file only.
//
// What it does:
//
// - Loads alphaTab lazily. The library is 1.2 MB and nothing needs it until
//   the view first opens, so it is a dynamic import, not a static one.
// - Draws in a web worker started from a file this app serves. The app's
//   Content-Security-Policy allows that and forbids the blob: workers
//   alphaTab would fall back to, so when the worker does not answer the score
//   is drawn on the main thread instead.
// - Runs alphaTab in external-media mode. StemDeck's own player is the clock:
//   this module tells alphaTab where the song is and alphaTab moves its
//   cursor there, using the sync points in the score to turn a time into a
//   bar. alphaTab never makes a sound, never creates an AudioContext and
//   never loads a soundfont.
// - Turns a click on the score into a seek request for the player.
//
// The names used here are alphaTab 1.9.0's. The change's design.md records
// how each was checked ("Spike Findings").

import { barAt } from "./notationCore.js";

const BASE = new URL("../../vendor/alphatab/", import.meta.url).href;
// How long the worker has to start drawing before the main thread takes over.
const WORKER_GRACE_MS = 5000;
// A click on the score reaches the player as a seek only this soon after the
// pointer went down on it. alphaTab also asks for a seek on its own (once
// when a score loads), and that must never move the song.
const CLICK_SEEK_WINDOW_MS = 1500;
// How long a paused position must hold before the score scrolls to it.
const CURSOR_SETTLE_MS = 90;

let library = null;

/** The alphaTab module, imported once on first use. */
export function loadAlphaTab() {
  library ??= import(`${BASE}alphaTab.min.mjs`).catch((e) => {
    library = null; // let a later open try again
    throw e;
  });
  return library;
}

/** A score that could not be read. `diagnostics` are alphaTab's own messages. */
export class ScoreError extends Error {
  constructor(message, diagnostics = []) {
    super(message);
    this.name = "ScoreError";
    this.diagnostics = diagnostics;
  }
}

function diagnosticsOf(importer) {
  const out = [];
  for (const key of ["lexerDiagnostics", "parserDiagnostics", "semanticDiagnostics"]) {
    const bag = importer[key];
    const items = bag?.items ?? (bag && typeof bag[Symbol.iterator] === "function" ? [...bag] : []);
    for (const item of items) {
      out.push({
        code: item.code,
        message: String(item.message ?? ""),
        line: item.start?.line ?? null,
        col: item.start?.col ?? null,
      });
    }
  }
  return out;
}

/**
 * Parse alphaTex into an alphaTab score. Throws ScoreError when alphaTab
 * refuses the text. Warnings do not throw: they come back in `diagnostics`.
 */
export function parseAlphaTex(alphaTab, text) {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(text, new alphaTab.Settings());
  try {
    const score = importer.readScore();
    return { score, diagnostics: diagnosticsOf(importer) };
  } catch (e) {
    throw new ScoreError(e?.message || "the score could not be read", diagnosticsOf(importer));
  }
}

// Following: the system being played is brought to the top of the view as
// the song reaches it. Not following: alphaTab never scrolls.
function scrollModeFor(alphaTab, follow) {
  return follow ? alphaTab.ScrollMode.Continuous : alphaTab.ScrollMode.Off;
}

function settingsFor(alphaTab, { scrollElement, zoom, useWorkers, follow }) {
  const settings = new alphaTab.Settings();
  settings.core.fontDirectory = `${BASE}font/`;
  settings.core.scriptFile = `${BASE}alphaTab.min.mjs`;
  // Only the one font file is vendored. Left to its default, alphaTab would
  // also name the .eot, .woff, .otf and .svg files, which are not there.
  settings.core.smuflFontSources = new Map([
    [alphaTab.FontFileFormat.Woff2, `${BASE}font/Bravura.woff2`],
  ]);
  settings.core.useWorkers = useWorkers;
  settings.core.engine = "svg";
  settings.core.enableLazyLoading = true;
  settings.display.scale = zoom;
  // The song's name is already on the page, above the lanes. Drawn again
  // here it would cost the drawer a third of its height. The title stays in
  // the score, so a Guitar Pro file made from it still carries it.
  settings.notation.elements.set(alphaTab.NotationElement.ScoreTitle, false);
  settings.notation.elements.set(alphaTab.NotationElement.ScoreSubTitle, false);
  // Each fretted stem's tuning is named in the drawer's own controls.
  settings.notation.elements.set(alphaTab.NotationElement.GuitarTuning, false);
  settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia;
  settings.player.enableCursor = true;
  settings.player.enableUserInteraction = true;
  settings.player.scrollElement = scrollElement;
  settings.player.scrollMode = scrollModeFor(alphaTab, follow);
  // A little air above the system being played.
  settings.player.scrollOffsetY = -12;
  return settings;
}

/**
 * `text` (alphaTex) as a Guitar Pro 7 file's bytes, with nothing drawn.
 * `names` maps a track's name in the text to the name the file gives it.
 */
export async function guitarProBytes(text, names = {}) {
  const alphaTab = await loadAlphaTab();
  const { score } = parseAlphaTex(alphaTab, text);
  for (const track of score.tracks) {
    const shown = names[track.name];
    if (shown) {
      track.name = shown;
      track.shortName = shown;
    }
  }
  return new alphaTab.exporter.Gp7Exporter().export(score, new alphaTab.Settings());
}

/**
 * A score view in `host`.
 *
 * @param {HTMLElement} host Where the score is drawn.
 * @param {object} options
 * @param {HTMLElement} options.scrollElement The element that scrolls the score.
 * @param {() => number} options.duration The song's length in seconds.
 * @param {(seconds: number) => void} options.onSeek A click on the score asks
 *   for the song to move to this time.
 * @param {number} [options.zoom] The drawing scale, 1 being alphaTab's own size.
 * @param {boolean} [options.follow] Whether the score scrolls to keep the bar
 *   the song is in on show.
 */
export async function createScoreView(host, { scrollElement, duration, onSeek, zoom = 1, follow = true } = {}) {
  const alphaTab = await loadAlphaTab();
  const PLAYING = alphaTab.synth?.PlayerState?.Playing ?? 1;
  let following = Boolean(follow);
  let api = null;
  let usingWorkers = true;
  let destroyed = false;
  let barStarts = [];
  let tick = 0;
  let playing = false;
  let lastMs = -1;
  let lastPointerDown = -Infinity;
  let scale = zoom;
  let diagnostics = [];
  let scrollTimer = null;
  const waiting = new Set(); // resolvers for the next "drawing started"

  // (All of this only while following: see setFollow.)
  // alphaTab scrolls to its cursor by itself only while it is playing. After
  // a seek with the song paused, the bar the song is on may be far off the
  // part of the score on show: bring it into view. Only when the position
  // changed, so a reader who scrolls ahead by hand while paused is left
  // where they are; and only once the position has stopped changing, because
  // alphaTab reports a new position a moment before it moves its cursor
  // there, and a drag along the waveform is many positions in a row.
  function showCursor() {
    clearTimeout(scrollTimer);
    if (playing || !following) return;
    scrollTimer = setTimeout(() => {
      if (playing || destroyed || !following) return;
      try {
        api?.scrollToCursor();
      } catch (e) {
        console.warn("[notation] could not scroll to the cursor:", e);
      }
    }, CURSOR_SETTLE_MS);
  }

  const onPointerDown = () => { lastPointerDown = performance.now(); };
  host.addEventListener("pointerdown", onPointerDown, true);

  const handler = {
    get backingTrackDuration() { return Math.max(0, (duration?.() || 0) * 1000); },
    // Always 1: alphaTab is told where the song is, in song time, so the
    // player's speed is none of its business. A half-speed song simply
    // reports positions that advance half as fast.
    get playbackRate() { return 1; },
    set playbackRate(_value) {},
    get masterVolume() { return 1; },
    set masterVolume(_value) {},
    seekTo(ms) {
      if (performance.now() - lastPointerDown > CLICK_SEEK_WINDOW_MS) return;
      lastPointerDown = -Infinity; // one click, one seek
      onSeek?.(ms / 1000);
    },
    // alphaTab calls these from its own play() and pause(). The player is
    // never driven from here: it would start the two calling each other.
    play() {},
    pause() {},
  };

  function attach() {
    const output = api?.player?.output;
    if (output) output.handler = handler;
  }

  function build(useWorkers) {
    api?.destroy();
    host.replaceChildren();
    usingWorkers = useWorkers;
    api = new alphaTab.AlphaTabApi(
      host,
      settingsFor(alphaTab, { scrollElement, zoom: scale, useWorkers, follow: following }),
    );
    api.error.on((e) => console.warn("[notation] alphaTab:", e?.message || e));
    api.renderStarted.on(() => {
      for (const done of waiting) done(true);
      waiting.clear();
    });
    api.playerReady.on(attach);
    api.playerPositionChanged.on((e) => {
      const moved = e.currentTick !== tick;
      tick = e.currentTick;
      if (moved) showCursor();
    });
    attach();
    playing = false;
    lastMs = -1;
  }

  /** Resolves true once alphaTab starts drawing, false if it has not in time. */
  function drawingStarted() {
    return new Promise((resolve) => {
      const done = (ok) => { clearTimeout(timer); waiting.delete(done); resolve(ok); };
      const timer = setTimeout(() => done(false), WORKER_GRACE_MS);
      waiting.add(done);
    });
  }

  build(true);

  return {
    /** Whether the score is being drawn in the worker (false: main thread). */
    get usesWorker() { return usingWorkers; },
    /** alphaTab's warnings about the last score loaded. Empty when it had none. */
    get diagnostics() { return diagnostics; },
    /** Tracks and bars of the score on show. */
    get counts() {
      const score = api?.score;
      return { tracks: score?.tracks.length ?? 0, bars: score?.masterBars.length ?? 0 };
    },

    /**
     * Draw `text` (alphaTex). `names` maps a track's name in the text to the
     * name to show for it. Throws ScoreError when the text cannot be read.
     */
    async load(text, names = {}) {
      const parsed = parseAlphaTex(alphaTab, text);
      diagnostics = parsed.diagnostics;
      const score = parsed.score;
      for (const track of score.tracks) {
        const shown = names[track.name];
        if (shown) {
          track.name = shown;
          track.shortName = shown;
        }
      }
      barStarts = score.masterBars.map((bar) => bar.start);
      tick = 0;
      lastMs = -1;
      // Every track: alphaTab draws only the first unless told.
      const all = score.tracks.map((track) => track.index);
      let started = drawingStarted();
      api.renderScore(score, all);
      if (!(await started) && usingWorkers && !destroyed) {
        // The worker never answered (a webview that will not start a module
        // worker, or a file that did not load). Draw on the main thread.
        console.warn("[notation] the drawing worker did not start; drawing on the main thread");
        build(false);
        started = drawingStarted();
        api.renderScore(score, all);
        await started;
      }
      attach();
      return this.counts;
    },

    /** Tell alphaTab where the song is. Cheap to call every frame. */
    setPosition(ms) {
      if (ms === lastMs) return;
      lastMs = ms;
      api?.player?.output?.updatePosition?.(ms);
    },

    /**
     * Mirror the player's state, so alphaTab animates its cursor, and scrolls
     * after it, only while the song moves. Never starts or stops the player.
     * Cheap to call every frame, and meant to be.
     *
     * alphaTab is asked what state it is in, not remembered: it leaves its
     * playing state by itself when it is given a score to draw. Unticking a
     * stem while the song ran left it paused for good, so its cursor still
     * moved (it is told the position) but the score no longer scrolled.
     */
    setPlaying(next) {
      playing = Boolean(next);
      if (!api || (api.playerState === PLAYING) === playing) return;
      try {
        if (next) api.play();
        else api.pause();
      } catch (e) {
        console.warn("[notation] could not mirror the play state:", e);
      }
    },

    /** The index of the bar the cursor is in, from 0, or -1 with no score. */
    currentBar() {
      return barAt(barStarts, tick);
    },

    /** Whether the score scrolls to keep the bar the song is in on show. */
    get follows() { return following; },

    /** Turn following on or off. Turned on, the bar comes into view at once. */
    setFollow(next) {
      const wanted = Boolean(next);
      if (wanted === following) return;
      following = wanted;
      clearTimeout(scrollTimer);
      if (!api) return;
      api.settings.player.scrollMode = scrollModeFor(alphaTab, following);
      api.updateSettings();
      if (!following) return;
      // After alphaTab has taken the setting in: it makes its scroller then.
      scrollTimer = setTimeout(() => {
        if (destroyed || !following) return;
        try {
          api?.scrollToCursor();
        } catch (e) {
          console.warn("[notation] could not scroll to the cursor:", e);
        }
      }, CURSOR_SETTLE_MS);
    },

    setZoom(next) {
      scale = next;
      if (!api) return;
      api.settings.display.scale = next;
      api.updateSettings();
      api.render();
    },

    destroy() {
      destroyed = true;
      clearTimeout(scrollTimer);
      host.removeEventListener("pointerdown", onPointerDown, true);
      for (const done of waiting) done(false);
      waiting.clear();
      api?.destroy();
      api = null;
      host.replaceChildren();
    },
  };
}
