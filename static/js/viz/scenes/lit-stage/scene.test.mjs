// Lit stage: pitch to key, pitch to string and fret, drum key to piece, the
// voice and the lamps, and its strings.
//
// Run:  node static/js/viz/scenes/lit-stage/scene.test.mjs
// (tests/js/viz-scenes.test.mjs runs every visualization's scene.test.mjs.)

import * as THREE from "../../../../vendor/three/three.module.js";
import scene from "./index.js";
import { strings } from "./strings.js";
import {
  INSTRUMENT, KEY_LOW, KEY_HIGH, WHITE_KEYS, GUITAR_TUNING, BASS_TUNING, MAX_FRET, PIECES, FADE_SECONDS, CALM_FADE_SECONDS,
  isBlack, keyFor, whitesBelow, keyPlace, fretFor, fretWire, fretSpot, drumPiece, voiceRange, voiceHeight, lampFor,
  glowAt, upperBound, litThings, sungAt,
} from "./map.js";

let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const note = (start, end, pitch, velocity = 0.8) => ({ start, end, pitch, velocity });

// -- who plays what --------------------------------------------------------------

check("each stem has its instrument", same(INSTRUMENT, { piano: "keyboard", guitar: "guitar", bass: "bass", drums: "kit", vocals: "voice", other: "lamps" }));

// -- pitch to key -----------------------------------------------------------------

check("the keyboard is a piano's 88 keys", KEY_HIGH - KEY_LOW + 1 === 88 && WHITE_KEYS === 52);
check("black keys are the sharps", [61, 63, 66, 68, 70].every(isBlack) && [60, 62, 64, 65, 67, 69, 71].every((p) => !isBlack(p)));
check("a pitch on the keyboard is its own key", keyFor(60) === 60 && keyFor(21) === 21 && keyFor(108) === 108);
check("a pitch off the keyboard folds onto it by octaves", keyFor(9) === 21 && keyFor(12) === 24 && keyFor(120) === 108 && keyFor(115) === 103);
check("a folded pitch keeps its note name", [3, 15, 110, 127].every((p) => keyFor(p) % 12 === p % 12));
check("the lowest key is the leftmost white", whitesBelow(21) === 0 && near(keyPlace(21).x, 0.5) && keyPlace(21).black === false);
check("the highest key is the rightmost white", near(keyPlace(108).x, WHITE_KEYS - 0.5));
check("middle C is the 24th white key", whitesBelow(60) === 23 && near(keyPlace(60).x, 23.5));
check("a black key sits on the crack to the right of its white", keyPlace(61).black === true && near(keyPlace(61).x, 24));
check("keys run left to right in pitch order", (() => { let last = -1; for (let p = KEY_LOW; p <= KEY_HIGH; p++) { const x = keyPlace(p).x; if (x <= last) return false; last = x; } return true; })());
check("E and F, B and C have no black key between", near(keyPlace(65).x - keyPlace(64).x, 1) && near(keyPlace(72).x - keyPlace(71).x, 1));

// -- pitch to string and fret -----------------------------------------------------

check("the guitar is in standard tuning, lowest string first", same(GUITAR_TUNING, [40, 45, 50, 55, 59, 64]));
check("the bass too", same(BASS_TUNING, [28, 33, 38, 43]));
check("an open string is fret 0 on that string", GUITAR_TUNING.every((p, s) => same(fretFor(p, GUITAR_TUNING), { string: s, fret: 0 })));
check("the lowest-fret fingering: A2 is the open fifth string, not fret 5 of the sixth", same(fretFor(45, GUITAR_TUNING), { string: 1, fret: 0 }));
check("a note between strings is on the lower one", same(fretFor(43, GUITAR_TUNING), { string: 0, fret: 3 }) && same(fretFor(57, GUITAR_TUNING), { string: 3, fret: 2 }));
check("high notes go up the top string", same(fretFor(76, GUITAR_TUNING), { string: 5, fret: 12 }) && same(fretFor(84, GUITAR_TUNING), { string: 5, fret: 20 }));
check("every fingering sounds its pitch", (() => { for (let p = 40; p <= 84; p++) { const f = fretFor(p, GUITAR_TUNING); if (GUITAR_TUNING[f.string] + f.fret !== p) return false; } return true; })());
check("frets never exceed the neck", (() => { for (let p = 0; p <= 127; p++) { const f = fretFor(p, GUITAR_TUNING); if (f.fret < 0 || f.fret > MAX_FRET) return false; } return true; })());
check("a note below the lowest string folds up an octave", same(fretFor(38, GUITAR_TUNING), fretFor(50, GUITAR_TUNING)) && same(fretFor(28, GUITAR_TUNING), fretFor(40, GUITAR_TUNING)));
check("a note beyond the last fret folds down an octave", same(fretFor(90, GUITAR_TUNING), fretFor(78, GUITAR_TUNING)));
check("the bass's low E is its open lowest string", same(fretFor(28, BASS_TUNING), { string: 0, fret: 0 }) && same(fretFor(36, BASS_TUNING), { string: 1, fret: 3 }));
check("fret wires run from the nut to the last fret", near(fretWire(0), 0) && near(fretWire(MAX_FRET), 1));
check("frets get closer together up the neck", fretWire(1) - fretWire(0) > fretWire(12) - fretWire(11) && fretWire(12) - fretWire(11) > fretWire(20) - fretWire(19));
check("the twelfth fret is where a real neck has it", near(fretWire(12), 0.5 / (1 - Math.pow(2, -20 / 12)), 1e-9));
check("a finger goes between the wires", fretSpot(3) > fretWire(2) && fretSpot(3) < fretWire(3));
check("an open string is marked at the nut", fretSpot(0) < fretWire(0));

// -- drum key to piece ------------------------------------------------------------

check("the kit has its eight pieces", same(PIECES, ["kick", "snare", "hihat", "tomHigh", "tomMid", "tomFloor", "crash", "ride"]));
check("kick", drumPiece(35) === "kick" && drumPiece(36) === "kick");
check("snare, rimshot and clap", [37, 38, 39, 40].every((k) => drumPiece(k) === "snare"));
check("hi-hat closed, pedal and open", [42, 44, 46].every((k) => drumPiece(k) === "hihat"));
check("toms from floor to high", drumPiece(41) === "tomFloor" && drumPiece(43) === "tomFloor" && drumPiece(45) === "tomMid" && drumPiece(47) === "tomMid" && drumPiece(48) === "tomHigh" && drumPiece(50) === "tomHigh");
check("crash and ride", drumPiece(49) === "crash" && drumPiece(57) === "crash" && drumPiece(51) === "ride" && drumPiece(53) === "ride");
check("every piece can be hit", PIECES.every((p) => [...Array(128).keys()].some((k) => drumPiece(k) === p)));
check("a sound the kit has no piece for lights nothing", drumPiece(60) === null && drumPiece(0) === null && drumPiece(81) === null);

// -- the voice and the lamps ------------------------------------------------------

const vr = voiceRange([note(0, 1, 55), note(1, 2, 67), note(2, 3, 60)]);
check("the voice's range is its lowest to its highest note", vr.min === 55 && vr.max === 67);
check("a higher sung pitch is a higher light", voiceHeight(67, vr) === 1 && voiceHeight(55, vr) === 0 && near(voiceHeight(61, vr), 0.5));
check("the light stays on its rail", voiceHeight(90, vr) === 1 && voiceHeight(20, vr) === 0);
check("a voice on one pitch still has a range", (() => { const r = voiceRange([note(0, 1, 60)]); return r.max > r.min && voiceHeight(60, r) > 0 && voiceHeight(60, r) < 1; })());
check("no notes, a default range", voiceRange(null).max > voiceRange(null).min);
check("a lamp per note name", lampFor(60) === 0 && lampFor(61) === 1 && lampFor(71) === 11 && lampFor(72) === 0);

// -- light: on while it sounds, fading after ----------------------------------------

const n = note(2, 3, 60);
check("dark before the note", glowAt(n, 1.99) === 0);
check("lit while it sounds", glowAt(n, 2) === 1 && glowAt(n, 3) === 1);
check("fading afterwards", (() => { const g = glowAt(n, 3 + FADE_SECONDS / 2); return g > 0.4 && g < 0.6; })());
check("dark again", glowAt(n, 3 + FADE_SECONDS) === 0 && glowAt(n, 9) === 0);
check("the calm fade is slower", glowAt(n, 3.3, CALM_FADE_SECONDS) > glowAt(n, 3.3, FADE_SECONDS));
const piano = [note(1, 2, 60), note(1, 2, 64), note(1, 2, 67), note(4, 4.2, 72), note(5, 30, 48)];
check("upperBound finds the first note after a time", upperBound(piano, 1) === 3 && upperBound(piano, 0) === 0);
{
  const chord = litThings(piano, 1.5, (x) => keyFor(x.pitch), { longest: 25 });
  check("a chord lights its three keys", same([...chord.keys()].sort(), [60, 64, 67]) && [...chord.values()].every((g) => g === 1));
  const after = litThings(piano, 2 + FADE_SECONDS / 2, (x) => keyFor(x.pitch), { longest: 25 });
  check("and they fade together", after.size === 3 && [...after.values()].every((g) => g > 0 && g < 1));
  check("then nothing is lit", litThings(piano, 3, (x) => keyFor(x.pitch), { longest: 25 }).size === 0);
  check("a long held note is still lit much later", litThings(piano, 20, (x) => keyFor(x.pitch), { longest: 25 }).get(48) === 1);
  check("a note that maps to nothing lights nothing", litThings(piano, 1.5, () => null, { longest: 25 }).size === 0);
  check("no notes, nothing lit", litThings(null, 1.5, (x) => x.pitch).size === 0 && litThings([], 1.5, (x) => x.pitch).size === 0);
  const twice = litThings([note(1, 2, 60), note(1.9, 3, 60)], 2.1, (x) => x.pitch, { longest: 1.1 });
  check("two notes on one key: the brighter wins", twice.get(60) === 1);
}
{
  const kickAndHat = litThings([note(1, 1.1, 36), note(1, 1.1, 42)], 1.05, (x) => drumPiece(x.pitch), { longest: 0.1 });
  check("a kick and a hi-hat together light both", kickAndHat.get("kick") === 1 && kickAndHat.get("hihat") === 1 && kickAndHat.size === 2);
}
{
  const voice = [note(1, 2, 60), note(2.5, 3, 67)];
  const o = { longest: 1 };
  check("the voice follows the note being sung", sungAt(voice, 1.5, o).pitch === 60 && sungAt(voice, 2.7, o).pitch === 67);
  check("between notes it fades, then is gone", sungAt(voice, 2.1, o).glow < 1 && sungAt(voice, 2.45, o) === null);
  check("nothing sung, no light", sungAt(null, 1, o) === null && sungAt(voice, 0.5, o) === null);
}

// -- the stage itself ---------------------------------------------------------------

const stem = (name, color, notes) => ({ name, color, peaks: new Float32Array(50).fill(0.4), notes });
const song = () => ({
  duration: 40, bpm: 120, beats: [], bars: [], sections: [], hasNotes: true,
  stems: [
    stem("vocals", "#e85f6f", [note(1, 2, 60), note(3, 4, 67)]),
    stem("drums", "#e89048", [note(1, 1.1, 36), note(1, 1.1, 42), note(2, 2.1, 38), note(2.5, 2.6, 99)]),
    stem("bass", "#e8b848", [note(1, 2, 28)]),
    stem("guitar", "#88d878", null),
    stem("piano", "#b88fe8", [note(1, 2, 60), note(1, 2, 64), note(1, 2, 67)]),
    stem("other", "#88a8c8", [note(1, 2, 62)]),
  ],
});
const lights = (over = {}) => Object.fromEntries(["vocals", "drums", "bass", "guitar", "piano", "other"].map((k) => [k, { level: 0.4, lit: true, gain: 1 }]).concat(Object.entries(over)));
const frame = (time, over = {}) => ({ time, playing: true, rate: 1, jumped: false, beat: null, bar: null, stems: lights(), ...over });
const size = { width: 1200, height: 600, pixelRatio: 1 };
const make = (s, calm = false) => scene.create({
  THREE, renderer: null, song: s, size, reducedMotion: calm,
  text: (k, v) => strings.en[k].replace("{list}", v?.list ?? ""), stemLabel: (name) => name[0].toUpperCase() + name.slice(1),
});

check("the visualization names itself and needs notes", scene.id === "lit-stage" && scene.needs.notes === true && scene.strings === strings);
{
  const inst = make(song());
  check("create returns the contract", inst.scene.isScene && inst.camera.isCamera && ["update", "resize", "setQuality", "dispose", "caption"].every((k) => typeof inst[k] === "function"));
  inst.update(frame(0.5));
  let d = inst.debug();
  check("before any note nothing is lit", d.lit.keys.length === 0 && d.lit.kit.length === 0 && d.lit.bass.length === 0 && d.lit.lamps.length === 0 && d.lit.voice === null);
  inst.update(frame(1.05));
  d = inst.debug();
  check("a piano chord lights its keys", same(d.lit.keys, [60, 64, 67]));
  check("a kick and a hi-hat together light both pieces", same(d.lit.kit, ["kick", "hihat"]));
  check("the bass's low E lights its open lowest string", same(d.lit.bass, [[0, 0]]));
  check("the voice's light is on, at its pitch's height", d.lit.voice && d.lit.voice.pitch === 60 && d.lit.voice.height === 0);
  check("the other stem lights its note's lamp", same(d.lit.lamps, [2]));
  check("a stem with no notes lights nothing", d.lit.guitar.length === 0);
  check("and is named as having none yet", same(d.unlit, ["guitar"]) && inst.caption() === "No notes yet: Guitar");
  check("its instrument's trim is grey; the others are their stems'", d.trims.guitar === "none" && d.trims.keyboard === "on" && d.trims.kit === "on");
  inst.update(frame(2.05));
  d = inst.debug();
  check("the snare lights when it is hit", d.lit.kit.includes("snare"));
  check("the keys are fading, not gone", same(d.lit.keys, [60, 64, 67]));
  inst.update(frame(2.6));
  d = inst.debug();
  check("then the keys are dark", d.lit.keys.length === 0);
  check("a drum sound with no piece lights nothing and breaks nothing", !d.lit.kit.includes(undefined) && d.lit.kit.every((p) => PIECES.includes(p)));
  inst.update(frame(3.5));
  check("the voice rises with the pitch", inst.debug().lit.voice.height === 1);
  inst.update(frame(1.05, { jumped: true }));
  check("a seek back lights that moment again", same(inst.debug().lit.keys, [60, 64, 67]));
  inst.update(frame(1.05, { stems: lights({ piano: { level: 0.4, lit: false, gain: 0 } }) }));
  d = inst.debug();
  check("a muted stem's instrument stops lighting", d.lit.keys.length === 0 && d.trims.keyboard === "muted");
  check("the others carry on", same(d.lit.kit, ["kick", "hihat"]) && d.trims.kit === "on");
  inst.update(frame(1.06));
  check("unmuted, it lights again", same(inst.debug().lit.keys, [60, 64, 67]) && inst.debug().trims.keyboard === "on");
  inst.resize({ width: 500, height: 800, pixelRatio: 1 });
  check("resize keeps the camera's aspect", near(inst.camera.aspect, 500 / 800));
  inst.setQuality(0);
  let threw = null;
  try { inst.dispose(); } catch (e) { threw = e; }
  check("dispose frees without complaint", threw === null, String(threw));
}
{
  // A song with only four stems: the missing instruments are furniture.
  const four = song();
  four.stems = four.stems.filter((s) => ["vocals", "drums", "bass", "other"].includes(s.name));
  const inst = make(four);
  inst.update(frame(1.05));
  const d = inst.debug();
  check("an instrument whose stem the song lacks is unlit and not listed", d.unlit.length === 0 && inst.caption() === "" && d.trims.keyboard === "none" && d.trims.guitar === "none");
  check("the rest still light", d.lit.kit.length === 2 && d.lit.bass.length === 1);
  inst.dispose();
}
{
  const inst = make(song(), true);
  check("calm: no glow is asked for", inst.bloom === null && inst.debug().calm === true);
  const cam = inst.camera.position.toArray().join();
  inst.update(frame(1.05));
  inst.update(frame(2 + FADE_SECONDS + 0.05));
  check("calm: the fade is slower", inst.debug().lit.keys.length === 3);
  check("calm: the camera does not move", inst.camera.position.toArray().join() === cam);
  inst.dispose();
}

// -- strings ----------------------------------------------------------------------------------

const LANGS = ["en", "pl", "ja", "ko", "zh-Hans", "de", "fr", "es", "pt", "id"];
check("strings come in the ten languages", LANGS.every((l) => strings[l]) && Object.keys(strings).length === LANGS.length, Object.keys(strings).join(","));
for (const lang of LANGS) {
  const s = strings[lang] || {};
  check(`${lang} has a name, a description and the no-notes line`, ["name", "description", "noNotes"].every((k) => typeof s[k] === "string" && s[k].trim()));
  check(`${lang} keeps the {list} placeholder`, s.noNotes?.includes("{list}"));
  if (lang !== "en") check(`${lang} is translated`, s.description !== strings.en.description && s.noNotes !== strings.en.noNotes);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
