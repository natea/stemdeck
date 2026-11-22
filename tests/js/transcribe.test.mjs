// Transcribe to Notes (openspec change add-stem-transcription): the dialog's
// pure logic, and the strings, markup, Guide entry and code naming the same
// keys and ids in all ten languages.
//
// Run:  node tests/js/transcribe.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TRANSLATIONS } from "../../static/js/i18n.js";
import {
  LOW_CONFIDENCE, REASONS, ROUTES,
  transcribableStems, defaultChoice, downloadQuery, hasNotes, gridWarning,
} from "../../static/js/transcribeCore.js";

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
const main = read("static/js/main.js");
const dialog = read("static/js/transcribe.js");
const css = read("static/css/daw.css");
const outcome = read("app/core/transcription_outcome.py");
const config = read("app/core/config.py");

// -- pure logic -------------------------------------------------------------

const routes = { vocals: "crepe", bass: "crepe", piano: "piano", drums: "mt3", guitar: "mt3" };
const state = {
  stems: [{ name: "original" }, { name: "vocals" }, { name: "drums" }, { name: "bass" }, { name: "piano" }, {}],
  stem_presence: { vocals: 80, drums: 60, bass: 40, piano: 0 },
};
const names = transcribableStems(state, routes);
check("only routed stems can be chosen, in the song's order", same(names, ["vocals", "drums", "bass", "piano"]), names.join(","));
check("no routes, no stems", same(transcribableStems(state, null), []));
check("no song, no stems", same(transcribableStems(null, routes), []));

check(
  "a silent stem starts unticked",
  same([...defaultChoice(names, state.stem_presence)], ["vocals", "drums", "bass"]),
);
check("a song with no presence data ticks every stem", defaultChoice(names, null).size === 4);
check("a stem missing from the presence data stays ticked", defaultChoice(["guitar"], { vocals: 0 }).has("guitar"));

const done = (n) => ({ status: "done", notes: n });
const stemsState = { vocals: done(12), bass: done(40), piano: { status: "skipped", notes: 0 }, drums: { status: "error", notes: 0 } };
check("there are notes once a stem is done", hasNotes(stemsState));
check("skipped and failed stems are not notes", !hasNotes({ piano: stemsState.piano, drums: stemsState.drums }));
check("an empty done stem is not notes", !hasNotes({ vocals: done(0) }));
check("no state, no notes", !hasNotes(undefined));

check(
  "a download asks for the ticked stems that have notes",
  downloadQuery(new Set(["vocals", "bass", "piano", "drums"]), stemsState) === "?stems=vocals%2Cbass",
  downloadQuery(new Set(["vocals", "bass", "piano", "drums"]), stemsState),
);
check(
  "with none of the ticked stems transcribed it asks for every stem",
  downloadQuery(new Set(["piano"]), stemsState) === "",
);
check(
  "a quantised download carries the resolution",
  downloadQuery(new Set(["bass"]), stemsState, { quantize: true, parts: 3 }) === "?stems=bass&quantize=1&parts=3",
);
check(
  "the score carries the resolution without the quantize flag",
  downloadQuery(new Set(["bass"]), stemsState, { parts: 4 }) === "?stems=bass&parts=4",
);

check("no warning before the grid is known", gridWarning({ known: false, available: false }) === null);
check("no grid is a warning", gridWarning({ known: true, available: false, confidence: null }) === "no-grid");
check("an unsure grid is a warning", gridWarning({ known: true, available: true, confidence: LOW_CONFIDENCE - 1 }) === "low-confidence");
check("a sure grid is not", gridWarning({ known: true, available: true, confidence: LOW_CONFIDENCE }) === null);
check("a grid with no confidence is not", gridWarning({ known: true, available: true, confidence: null }) === null);

// -- the client's tables match the server's ----------------------------------

const serverCodes = [...outcome.matchAll(/^([A-Z_]+) = "([a-z_]+)"$/gm)].map((m) => m[2]).sort();
check("every server reason code has a client entry", same([...REASONS].sort(), serverCodes), serverCodes.join(","));
const serverRoutes = config.match(/TRANSCRIBERS: tuple\[str, \.\.\.\] = \(([^)]*)\)/)[1].match(/[a-z0-9]+/g);
check("every transcriber has a client entry", same([...ROUTES].sort(), [...serverRoutes].sort()), serverRoutes.join(","));

// -- strings ----------------------------------------------------------------

const KEYS = [
  "export.transcribe",
  "export.transcribeDesc",
  "help.exportTranscribe",
  "transcribe.title",
  "transcribe.hint",
  "transcribe.closeAria",
  "transcribe.start",
  "transcribe.running",
  "transcribe.cancel",
  "transcribe.status.none",
  "transcribe.status.done",
  "transcribe.status.skipped",
  "transcribe.resolution",
  "transcribe.midiPlayed",
  "transcribe.midiQuantised",
  "transcribe.musicxml",
  "transcribe.noGrid",
  "transcribe.lowConfidence",
  ...ROUTES.map((r) => `transcribe.route.${r}`),
  ...REASONS.map((r) => `transcribe.reason.${r}`),
  ...[1, 2, 3, 4, 6, 8].map((n) => `transcribe.parts.${n}`),
];

// pt-PT is a regional variant that resolves through pt, so it needs no copy.
const full = Object.keys(TRANSLATIONS).filter((l) => l !== "pt-PT");
check("the tables are the ten full languages", full.length === 10, full.join(","));

for (const lang of full) {
  const table = TRANSLATIONS[lang];
  const missing = KEYS.filter((k) => typeof table[k] !== "string" || !table[k].trim());
  check(`${lang} has every transcription key`, missing.length === 0, missing.join(", "));
  check(`${lang} keeps the note count placeholder`, table["transcribe.status.done"]?.includes("{n}"));
  check(`${lang} keeps the confidence placeholder`, table["transcribe.lowConfidence"]?.includes("{n}"));
}

// An English sentence copied into another table is the silent failure the
// fallback hides.
const en = TRANSLATIONS.en;
const SENTENCES = KEYS.filter((k) => en[k].split(" ").length >= 4);
for (const lang of full.filter((l) => l !== "en")) {
  const copied = SENTENCES.filter((k) => TRANSLATIONS[lang][k] === en[k]);
  check(`${lang} translates every sentence`, copied.length === 0, copied.join(", "));
}

// -- markup, Guide and code name the same things ------------------------------

const used = new Set([...dialog.matchAll(/\bt\(\s*["'`]([a-zA-Z0-9_.]+)["'`]/g)].map((m) => m[1]));
const unknown = [...used].filter((k) => !(k in en));
check("every literal key the dialog asks for exists", unknown.length === 0, unknown.join(", "));
const inMarkup = [...html.matchAll(/data-i18n(?:-aria-label|-title)?="(transcribe\.[a-zA-Z0-9_.]+|export\.transcribe[a-zA-Z]*)"/g)].map((m) => m[1]);
const badMarkup = inMarkup.filter((k) => !(k in en));
check("every key in the markup exists", inMarkup.length >= 15 && badMarkup.length === 0, badMarkup.join(", "));

const IDS = [
  "t-export-transcribe", "transcribeDialog", "transcribeClose", "transcribeStems", "transcribeStart",
  "transcribeCancel", "transcribeError", "transcribeDownloads", "transcribeParts", "transcribeWarning",
  "transcribeMidiPlayed", "transcribeMidiQuantised", "transcribeMusicxml",
];
for (const id of IDS) {
  check(`#${id} is in the markup once`, html.split(`id="${id}"`).length === 2);
  check(`#${id} is used by the code`, dialog.includes(`"${id}"`) || main.includes(`"${id}"`));
}
check("the row starts hidden, shown only where transcription can run", /id="t-export-transcribe"[^>]*\shidden>/.test(html));
check("the dialog starts hidden", /class="about-backdrop hidden" id="transcribeDialog"/.test(html));
check("the row is hidden with the other audio rows in MP4 mode", css.includes("#t-export-panel.fmt-mp4 #t-export-transcribe"));
check("the Guide explains the row", help.includes('["#t-export-transcribe", "help.exportTranscribe"]'));
check("the menu knows the row", main.includes("itemTranscribe") && main.includes("openTranscribeDialog"));
const options = [...html.matchAll(/<option value="(\d)" data-i18n="transcribe\.parts\.(\d)"/g)];
check(
  "the resolution choices are the server's",
  same(options.map((m) => m[1]), ["1", "2", "3", "4", "6", "8"]) && options.every((m) => m[1] === m[2]),
);
check("the server offers the same resolutions", /QUANTIZE_PARTS: tuple\[int, \.\.\.\] = \(1, 2, 3, 4, 6, 8\)/.test(config));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
