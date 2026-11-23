// The Notation view (openspec change add-alphatab-notation): its pure logic,
// and the strings, markup, Guide entry and code naming the same keys and ids
// in all ten languages.
//
// Run:  node tests/js/notation.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TRANSLATIONS } from "../../static/js/i18n.js";
import {
  TAB_STEMS, SCORE_ORDER, DEFAULT_SHOWN, ZOOMS, DEFAULT_ZOOM,
  prefsKey, cleanPrefs, inScoreOrder, availableStems, shownStems, withStem,
  scoreUrl, downloadUrls, stepZoom, barAt, emptyState, unplacedNotes,
  pitchName, tuningText, parseTuning,
} from "../../static/js/notation/notationCore.js";

let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const html = read("static/index.html");
const help = read("static/js/helpMode.js");
const view = read("static/js/notation/notation.js");
const bridge = read("static/js/notation/alphatabBridge.js");
const config = read("app/core/config.py");
const api = read("app/api/transcription.py");

// ── Which stems are drawn ──

const done = (notes) => ({ status: "done", notes });
const stemsState = {
  drums: done(40), bass: done(12), vocals: done(30), guitar: done(88), piano: done(0),
  other: { status: "error", notes: 0 }, backing_vocals: { status: "skipped", notes: 0 },
};
const available = availableStems(stemsState);
check("stems with notes, in score order", same(available, ["vocals", "guitar", "bass", "drums"]), available.join());
check("no notes, no stems", same(availableStems(null), []) && same(availableStems({}), []));
check("an unknown stem goes after the known ones", same(inScoreOrder(["zither", "drums", "vocals"]), ["vocals", "drums", "zither"]));
check(
  "the score order is the server's",
  SCORE_ORDER.every((name) => api.includes(`"${name}",`)) && SCORE_ORDER.length === 8,
);

const six = ["vocals", "lead_vocals", "guitar", "piano", "bass", "drums"];
const fresh = cleanPrefs(null);
check("a song never opened shows the first few stems", same(shownStems(six, fresh), six.slice(0, DEFAULT_SHOWN)));
check("a short song shows them all", same(shownStems(available, fresh), available));

let prefs = withStem(available, fresh, "drums", false);
check("unticking a stem hides it", same(shownStems(available, prefs), ["vocals", "guitar", "bass"]) && same(prefs.hidden, ["drums"]));
check("ticking it again brings it back", same(shownStems(available, withStem(available, prefs, "drums", true)), available));
check(
  "a stem transcribed later appears without being asked for",
  same(shownStems([...available.slice(0, 2), "piano", ...available.slice(2)], prefs), ["vocals", "guitar", "piano", "bass"]),
);
const beyond = withStem(six, fresh, "drums", true);
check("ticking a stem beyond the first few keeps the others as they were", same(shownStems(six, beyond), ["vocals", "lead_vocals", "guitar", "piano", "drums"]));
const none = available.reduce((p, name) => withStem(available, p, name, false), fresh);
check("every stem can be unticked", same(shownStems(available, none), []));

// ── What a song remembers ──

check("the choices are kept per song", prefsKey("abc123") === "stemdeck:notation:abc123" && prefsKey("x") !== prefsKey("y"));
check("nothing stored is the defaults", same(fresh, { hidden: null, parts: 4, zoom: DEFAULT_ZOOM, follow: true }));
check(
  "stored choices come back",
  same(cleanPrefs({ hidden: ["drums"], parts: 3, zoom: 1.15, follow: false }), { hidden: ["drums"], parts: 3, zoom: 1.15, follow: false }),
);
check(
  "the score follows the song unless that was turned off",
  cleanPrefs({ parts: 3 }).follow === true && cleanPrefs({ follow: "no" }).follow === true && cleanPrefs({ follow: false }).follow === false,
);
check(
  "damaged choices fall back to the defaults",
  same(cleanPrefs({ hidden: "drums", parts: 5, zoom: 99 }), fresh) && same(cleanPrefs("nonsense"), fresh) && same(cleanPrefs({ hidden: [1, "bass", "bass"] }).hidden, ["bass"]),
);
check("the server's resolutions decide what is allowed", cleanPrefs({ parts: 6 }, { parts: [1, 2, 4], defaultParts: 2 }).parts === 2);
check("the default zoom is one of the steps", ZOOMS.includes(DEFAULT_ZOOM));
check("zoom steps up and down", stepZoom(0.8, 1) === 0.9 && stepZoom(0.8, -1) === 0.7);
check("zoom stops at the ends", stepZoom(ZOOMS[0], -1) === ZOOMS[0] && stepZoom(ZOOMS.at(-1), 1) === ZOOMS.at(-1));
check("an unknown zoom steps from the default", stepZoom(0.33, 1) === stepZoom(DEFAULT_ZOOM, 1));

// ── Addresses ──

check(
  "the score is asked for by stems and resolution",
  scoreUrl("job1", ["bass", "guitar"], 3) === "/api/jobs/job1/transcription.alphatex?format=json&stems=bass%2Cguitar&parts=3",
);
const urls = downloadUrls("job1", ["bass", "guitar"], 6);
check("the as-played MIDI names the stems shown", urls.midiPlayed === "/api/jobs/job1/transcription.mid?stems=bass%2Cguitar");
check("the quantised MIDI adds the resolution", urls.midiQuantised === "/api/jobs/job1/transcription.mid?stems=bass%2Cguitar&quantize=1&parts=6");
check("the MusicXML score names the stems and the resolution", urls.musicxml === "/api/jobs/job1/transcription.musicxml?stems=bass%2Cguitar&parts=6");
check("Guitar Pro is not a server download", !("guitarPro" in urls));
for (const route of ["transcription.alphatex", "transcription/tab"]) {
  check(`the server has ${route}`, api.includes(`/{job_id}/${route}"`));
}

// ── The bar the cursor is in ──

const starts = [0, 3840, 7680, 10560];
check("the bar holding a tick", barAt(starts, 0) === 0 && barAt(starts, 3839) === 0 && barAt(starts, 3840) === 1 && barAt(starts, 9000) === 2);
check("past the last bar line is the last bar", barAt(starts, 999999) === 3);
check("before the first bar is the first bar", barAt(starts, -5) === 0);
check("no score, no bar", barAt([], 100) === -1 && barAt(null, 0) === -1);

// ── When there is nothing to draw ──

check("no notes yet", emptyState({ available: [], shown: [] }) === "untranscribed");
check("the server says nothing is transcribed", emptyState({ available, shown: available, status: 404 }) === "untranscribed");
check("notes but no beat grid", emptyState({ available, shown: available, status: 409, reason: "no_beat_grid" }) === "no-grid");
check("every stem unticked", emptyState({ available, shown: [] }) === "no-stems");
check("a server error", emptyState({ available, shown: available, status: 500 }) === "failed");
check("an answer with no score in it", emptyState({ available, shown: available, failed: true }) === "failed");
check("a score to draw", emptyState({ available, shown: available, status: 200 }) === null);

// ── Notes left off the tab ──

const tab = {
  guitar: { unplaced: 5, reasons: { out_of_range: 4, too_many_notes: 1 }, suggestion: "drop_d" },
  bass: { unplaced: 0, reasons: {}, suggestion: null },
};
check(
  "a stem with notes left off is reported with the reasons and the suggestion",
  same(unplacedNotes(tab), [{ stem: "guitar", count: 5, outOfRange: 4, tooMany: 1, suggestion: "drop_d" }]),
);
check("nothing left off, nothing reported", same(unplacedNotes({ bass: tab.bass }), []) && same(unplacedNotes(null), []));
check(
  "a stray bass note is reported without a suggestion",
  same(unplacedNotes({ bass: { unplaced: 1, reasons: { out_of_range: 1 }, suggestion: null } }), [
    { stem: "bass", count: 1, outOfRange: 1, tooMany: 0, suggestion: null },
  ]),
);
check("the tab stems are the server's", /TAB_STEMS: tuple\[str, \.\.\.\] = \("guitar", "bass"\)/.test(config) && same([...TAB_STEMS], ["guitar", "bass"]));

// ── Tunings as text ──

check("a pitch as a note name", pitchName(40) === "E2" && pitchName(60) === "C4" && pitchName(63) === "D#4" && pitchName(23) === "B0");
check("standard guitar, lowest string first", tuningText([40, 45, 50, 55, 59, 64]) === "E2 A2 D3 G3 B3 E4");
check("a typed tuning is read back", same(parseTuning("D2 A2 D3 G3 A3 D4"), [38, 45, 50, 55, 57, 62]));
check("flats, sharps, commas and lower case", same(parseTuning("eb2, ab2 Db3 f#3 B♭3 e♭4"), [39, 44, 49, 54, 58, 63]));
check("text and back again", same(parseTuning(tuningText([23, 28, 33, 38, 43])), [23, 28, 33, 38, 43]));
check("too few strings", parseTuning("E2 A2 D3") === null);
check("too many strings", parseTuning("E1 A1 D2 G2 B2 E3 A3 D4 G4") === null);
check("not note names", parseTuning("E2 A2 D3 H3 B3 E4") === null && parseTuning("EADGBE") === null && parseTuning("") === null);
check("the server's limits can be passed in", same(parseTuning("E2 A2 D3", { min: 3, max: 3 }), [40, 45, 50]));

// ── Strings in every language ──

const KEYS = Object.keys(TRANSLATIONS.en).filter((k) => k.startsWith("notation.") || k === "help.notationChip");
check("the view has strings", KEYS.length >= 45, String(KEYS.length));
// pt-PT only holds what differs from pt, as for every other feature.
const FULL = Object.keys(TRANSLATIONS).filter((code) => code !== "pt-PT");
check("ten full tables", FULL.length === 10, FULL.join());
for (const code of FULL) {
  const missing = KEYS.filter((k) => !TRANSLATIONS[code][k]);
  check(`${code} has every Notation string`, missing.length === 0, missing.join(", "));
  const holes = KEYS.filter((k) => {
    const want = (TRANSLATIONS.en[k].match(/\{\w+\}/g) || []).sort();
    const got = (String(TRANSLATIONS[code][k] || "").match(/\{\w+\}/g) || []).sort();
    return !same(want, got);
  });
  check(`${code} keeps every {placeholder}`, holes.length === 0, holes.join(", "));
  const dashes = KEYS.filter((k) => /[—–]/.test(String(TRANSLATIONS[code][k] || "")));
  check(`${code} uses no dashes as punctuation`, dashes.length === 0, dashes.join(", "));
}

// Every key the code reads exists, and every key that exists is read.
const reads = [...view.matchAll(/\bt\(\s*"(notation\.[A-Za-z_.]+)"/g)].map((m) => m[1]);
const dynamic = [
  ...["noSong", "untranscribed", "noGrid", "noStems", "failed"].map((k) => `notation.empty.${k}`),
  ...["score", "tab", "both"].map((k) => `notation.tab.${k}`),
  // Chosen by stem, in one call.
  "notation.unplaced.hint", "notation.unplaced.hintBass",
];
check("both hints for notes out of range are in the code", view.includes('"notation.unplaced.hintBass" : "notation.unplaced.hint"'));
check("the code's keys all exist", reads.every((k) => KEYS.includes(k)), reads.filter((k) => !KEYS.includes(k)).join());
for (const kind of ["noSong", "untranscribed", "noGrid", "noStems", "failed"]) {
  check(`the empty state ${kind} is in the code`, view.includes(kind));
}
check("the display choices are the server's", /TAB_DISPLAYS: tuple\[str, \.\.\.\] = \("score", "tab", "both"\)/.test(config));
const presets = [...config.matchAll(/^\s{8}"([a-z_]+)": \(/gm)].map((m) => m[1]);
check("the server has tunings", presets.includes("drop_d") && presets.includes("five_string"), presets.join());
for (const preset of new Set(presets)) {
  check(`the tuning ${preset} has a name`, KEYS.includes(`notation.tuning.${preset}`));
}
const tunings = KEYS.filter((k) => k.startsWith("notation.tuning."));
check("no tuning is named that the server does not offer", tunings.every((k) => presets.includes(k.slice("notation.tuning.".length))), tunings.join());
const unread = KEYS.filter((k) => !reads.includes(k) && !dynamic.includes(k) && !tunings.includes(k) && k !== "help.notationChip");
check("no Notation string is left unread", unread.length === 0, unread.join(", "));
check("the resolution names are the transcribe dialog's", view.includes("transcribe.parts.") && view.includes('t("transcribe.resolution")'));

// ── Markup, Guide and wiring ──

check("the chip is in the footer, hidden until transcription is known to run", /<button class="track-chip notation-chip" id="t-notation-btn" type="button" hidden /.test(html));
check("the chip names the drawer it opens", /id="t-notation-btn"[^>]*aria-controls="notation-drawer"/.test(html));
check("the drawer is in the layout, closed", /<section class="notation-drawer" id="notation-drawer" hidden /.test(html));
check("the drawer comes before the Master drawer", html.indexOf('id="notation-drawer"') < html.indexOf('id="master-drawer"'));
check("its stylesheet is linked", html.includes('href="/css/notation.css"'));
check("the Guide explains the chip", help.includes('["#t-notation-btn", "help.notationChip", null, "notation.title"]'));
check("main.js starts it", read("static/js/main.js").includes("initNotation()"));

// ── alphaTab stays behind the bridge, and stays silent ──

const others = [view, read("static/js/notation/notationCore.js"), read("static/js/main.js")].join("\n");
check("only the bridge imports alphaTab", !/vendor\/alphatab|alphaTab\.min/.test(others) && bridge.includes("alphaTab.min.mjs"));
check("alphaTab is imported lazily", /import\(`\$\{BASE\}alphaTab\.min\.mjs`\)/.test(bridge) && !/^import .*alphaTab/m.test(bridge));
check("the player is external media", bridge.includes("PlayerMode.EnabledExternalMedia"));
// Its comments say what it never does; only the code is searched.
const bridgeCode = bridge.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
check("no synthesiser, soundfont or audio context is asked for", !/soundfont|EnabledSynthesizer|EnabledAutomatic|EnabledBackingTrack|AudioContext/i.test(bridgeCode));
check("the vendored paths come from the module's own address", bridge.includes('new URL("../../vendor/alphatab/", import.meta.url)'));
check("only the one font file is named", bridge.includes("FontFileFormat.Woff2") && bridge.includes("Bravura.woff2"));
check("the view follows the player and never drives it", view.includes("transport()") && !/\.play\(\)|togglePlayPause|resumePlayback/.test(view));
check("a click on the score seeks the player", view.includes("onSeek: (seconds) => setPlayheadTime(seconds)"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
