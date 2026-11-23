// Slit-scan score: its mapping, both data tiers, click-to-seek and its strings.
//
// Run:  node static/js/viz/scenes/slit-scan/scene.test.mjs
// (tests/js/viz-scenes.test.mjs runs every visualization's scene.test.mjs.)

import * as THREE from "../../../../vendor/three/three.module.js";
import scene from "./index.js";
import { strings } from "./strings.js";
import {
  COLUMNS, ROWS, STRIP, timeToColumn, columnToTime, timeToX, pointToTime, bandRects, hexToRgb,
  columnLevel, brightness, pitchSpan, pitchRow, bandPixels,
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

// -- time and columns ---------------------------------------------------------------

check("the start of the song is the first column", timeToColumn(0, 200) === 0);
check("the end of the song is the last column", timeToColumn(200, 200) === COLUMNS - 1 && timeToColumn(999, 200) === COLUMNS - 1);
check("halfway is the middle column", timeToColumn(100, 200) === COLUMNS / 2);
check("a song with no length has one column", timeToColumn(5, 0) === 0);
{
  let worst = 0;
  for (let c = 0; c < COLUMNS; c += 7) {
    const back = timeToColumn(columnToTime(c, 187.3), 187.3);
    if (back !== c) worst++;
  }
  check("column to time and back is the same column", worst === 0, `${worst} columns moved`);
  let drift = 0;
  for (let t = 0; t <= 187.3; t += 1.7) drift = Math.max(drift, Math.abs(columnToTime(timeToColumn(t, 187.3), 187.3) - t));
  check("time to column and back is within one column of time", drift <= 187.3 / COLUMNS, String(drift));
}
check("columnToTime is the middle of the column", near(columnToTime(0, 100, 100), 0.5) && near(columnToTime(99, 100, 100), 99.5));

// -- the strip in the view, and clicks ------------------------------------------------------

check("the start of the song is the strip's left edge", near(timeToX(0, 60), STRIP.x0));
check("the end is its right edge", near(timeToX(60, 60), STRIP.x1) && near(timeToX(600, 60), STRIP.x1));
const twoThirds = STRIP.x0 + (2 / 3) * (STRIP.x1 - STRIP.x0);
check("a click two thirds along the strip is two thirds of the song", near(pointToTime(twoThirds, 0.5, 90), 60));
check("click and line agree: time to x and back", [0, 13.7, 45, 90].every((t) => near(pointToTime(timeToX(t, 90), 0.5, 90), t, 1e-6)));
check("a click left or right of the strip is not a seek", pointToTime(STRIP.x0 - 0.01, 0.5, 90) === null && pointToTime(STRIP.x1 + 0.01, 0.5, 90) === null);
check("a click far above or below the strip is not a seek", pointToTime(0.5, 0.02, 90) === null && pointToTime(0.5, 0.98, 90) === null);
check("the section bar and the ruler seek too", pointToTime(0.5, STRIP.y0 - 0.04, 90) !== null && pointToTime(0.5, STRIP.y1 + 0.03, 90) !== null);
check("a song with no length cannot be sought", pointToTime(0.5, 0.5, 0) === null);

const rects = bandRects(6);
check("one band per stem", rects.length === 6);
check("the first stem is uppermost and they do not overlap", rects.every((r, i) => r.y1 > r.y0 && (i === 0 || r.y0 > rects[i - 1].y1)));
check("the bands fill the strip", near(rects[0].y0, STRIP.y0) && near(rects[5].y1, STRIP.y1));
check("one stem fills the strip alone", near(bandRects(1)[0].y1 - bandRects(1)[0].y0, STRIP.y1 - STRIP.y0));
check("no stems, no bands", bandRects(0).length === 0);

// -- loudness is brightness ---------------------------------------------------------------

check("hex colours parse", JSON.stringify(hexToRgb("#e85f6f")) === "[232,95,111]" && hexToRgb("nonsense").length === 3);
check("louder is brighter", brightness(0.9) > brightness(0.3) && brightness(0.3) > brightness(0));
check("silence still shows the band, faintly", brightness(0) > 0 && brightness(0) < 0.2);
check("full loudness is full brightness", near(brightness(1), 1) && near(brightness(7), 1));
const peaks = new Float32Array(100).fill(0.1);
peaks[50] = 0.9;
check("a column takes the loudest point inside it", near(columnLevel(peaks, 5, 10), 0.9) && near(columnLevel(peaks, 4, 10), 0.1));
check("more columns than points still reads a point", near(columnLevel(new Float32Array([0.2, 0.8]), 1500, 2000), 0.8));
check("no peaks is silence", columnLevel(new Float32Array(0), 3, 10) === 0 && columnLevel(null, 3, 10) === 0);

const quietThenLoud = Float32Array.from({ length: 64 }, (_, i) => (i < 32 ? 0.02 : 0.8));
const bare = bandPixels({ color: "#e85f6f", peaks: quietThenLoud, notes: null }, 64, 64, 8);
const px = (buf, cols, c, y) => [...buf.slice((y * cols + c) * 4, (y * cols + c) * 4 + 4)];
check("the band is the right size", bare.length === 64 * 8 * 4);
check("a loud passage is brighter than a quiet one", px(bare, 64, 50, 3)[0] > px(bare, 64, 10, 3)[0] * 2);
check("a column is one colour top to bottom without notes", JSON.stringify(px(bare, 64, 50, 0)) === JSON.stringify(px(bare, 64, 50, 7)));
check("the band is its stem's hue", (() => { const [r, g, b] = px(bare, 64, 50, 3); return r > g && r > b && near(g / r, 95 / 232, 0.03); })());
check("every pixel is opaque", px(bare, 64, 0, 0)[3] === 255 && px(bare, 64, 63, 7)[3] === 255);

// -- notes are marks at their pitch ----------------------------------------------------------

check("a part's pitch span is its lowest and highest note", JSON.stringify(pitchSpan([{ pitch: 40 }, { pitch: 64 }, { pitch: 52 }])) === JSON.stringify({ min: 40, max: 64 }));
check("a part on one pitch still gets room", (() => { const s = pitchSpan([{ pitch: 60 }]); return s.max - s.min >= 6 && s.min < 60 && s.max > 60; })());
check("no notes, no span", pitchSpan([]) === null && pitchSpan(null) === null);
const span = { min: 40, max: 64 };
check("a higher pitch is a higher row", pitchRow(64, span) > pitchRow(52, span) && pitchRow(52, span) > pitchRow(40, span));
check("marks stay inside the band, clear of its edges", pitchRow(40, span) >= 4 && pitchRow(64, span) <= ROWS - 5 && pitchRow(200, span) <= ROWS - 5 && pitchRow(-5, span) >= 4);
{
  const notes = [{ start: 10, end: 20, pitch: 40, velocity: 1 }, { start: 30, end: 31, pitch: 64, velocity: 1 }];
  const flat = new Float32Array(64).fill(0.5);
  const withNotes = bandPixels({ color: "#88d878", peaks: flat, notes }, 64, 64, ROWS);
  const without = bandPixels({ color: "#88d878", peaks: flat, notes: null }, 64, 64, ROWS);
  const low = pitchRow(40, pitchSpan(notes));
  const high = pitchRow(64, pitchSpan(notes));
  const lum = (p) => p[0] + p[1] + p[2];
  check("a note is a bright mark at its pitch's row", lum(px(withNotes, 64, 15, low)) > lum(px(withNotes, 64, 15, low + 6)) * 2);
  check("the mark lasts as long as the note", lum(px(withNotes, 64, 10, low)) > 500 && lum(px(withNotes, 64, 19, low)) > 500 && lum(px(withNotes, 64, 25, low)) < 400);
  check("a higher note is marked higher in the band", lum(px(withNotes, 64, 30, high)) > 500 && lum(px(withNotes, 64, 30, low)) < 400 && high > low);
  check("a short note still gets a column", lum(px(withNotes, 64, 30, high)) > 500);
  check("the mark is nearly white with a tint of the stem", (() => { const [r, g, b] = px(withNotes, 64, 15, low); return g > r && g > b && r > 150; })());
  check("with notes the band behind them is dimmer", lum(px(withNotes, 64, 50, 3)) < lum(px(without, 64, 50, 3)));
  check("loudness still shows behind the notes", lum(px(withNotes, 64, 50, 3)) > 0);
  const faint = bandPixels({ color: "#88d878", peaks: new Float32Array(64).fill(0.01), notes }, 64, 64, ROWS);
  const silent = bandPixels({ color: "#88d878", peaks: new Float32Array(64).fill(0), notes }, 64, 64, ROWS);
  check("a quiet stem with notes keeps a tint of its colour", px(faint, 64, 50, 3)[1] > 30 && px(faint, 64, 50, 3)[1] > px(faint, 64, 50, 3)[0]);
  check("true silence is still nearly black", lum(px(silent, 64, 50, 3)) < lum(px(faint, 64, 50, 3)) / 2);
}
check("a stem transcribed but silent is drawn from loudness", (() => {
  const a = bandPixels({ color: "#88d878", peaks: new Float32Array(8).fill(0.5), notes: [] }, 8, 8, 8);
  const b = bandPixels({ color: "#88d878", peaks: new Float32Array(8).fill(0.5), notes: null }, 8, 8, 8);
  return JSON.stringify([...a]) === JSON.stringify([...b]);
})());

// -- the scene itself, both tiers ------------------------------------------------------------

const stem = (name, color, notes) => ({ name, color, peaks: new Float32Array(200).fill(0.4), notes });
const song = (over = {}) => ({
  duration: 90,
  bpm: 120,
  beats: Array.from({ length: 180 }, (_, i) => i * 0.5),
  bars: Array.from({ length: 45 }, (_, i) => i * 2),
  sections: [{ start: 0, end: 30, color: "#ff8800", name: "A", kind: "verse" }, { start: 30, end: 90, color: "#00aaff", name: "B", kind: "chorus" }],
  hasNotes: true,
  stems: [stem("vocals", "#e85f6f", [{ start: 1, end: 2, pitch: 64, velocity: 1 }]), stem("drums", "#e89048", null), stem("bass", "#e8b848", null)],
  ...over,
});
const lights = (over = {}) => ({ vocals: { level: 0.4, lit: true, gain: 1 }, drums: { level: 0.4, lit: true, gain: 1 }, bass: { level: 0.4, lit: true, gain: 1 }, ...over });
const frame = (time, over = {}) => ({ time, playing: true, rate: 1, jumped: false, beat: null, bar: null, stems: lights(), ...over });
const size = { width: 1200, height: 600, pixelRatio: 1 };

check("the visualization names itself", scene.id === "slit-scan" && scene.needs.notes === false && scene.strings === strings);
{
  const inst = scene.create({ THREE, renderer: null, song: song(), size, reducedMotion: false, text: (k) => k });
  check("create returns the contract", inst.scene.isScene && inst.camera.isOrthographicCamera && ["update", "resize", "setQuality", "dispose", "timeAt"].every((k) => typeof inst[k] === "function"));
  inst.update(frame(45));
  let d = inst.debug();
  check("one band per stem, in the song's order", d.bands.map((b) => b.name).join() === "vocals,drums,bass");
  check("halfway through, the line is halfway along the strip", near(d.headX, (STRIP.x0 + STRIP.x1) / 2));
  check("sections and bars are drawn when the song has them", d.sections === 2 && d.bars === 45);
  inst.update(frame(0));
  check("at the start the line is at the left edge", near(inst.debug().headX, STRIP.x0));
  inst.update(frame(90));
  check("at the end it is at the right edge", near(inst.debug().headX, STRIP.x1));
  check("the picture's click is the mapping's", near(inst.timeAt({ x: twoThirds, y: 0.5 }), 60) && inst.timeAt({ x: 0.001, y: 0.5 }) === null);
  check("clicking where the line is gives the present moment", (() => { inst.update(frame(33)); return near(inst.timeAt({ x: inst.debug().headX, y: 0.5 }), 33, 1e-6); })());
  const full = inst.debug().bands[2].tint;
  inst.update(frame(33, { stems: lights({ bass: { level: 0.4, lit: false, gain: 0 } }) }));
  d = inst.debug();
  check("a muted stem's band goes almost black", d.bands[2].tint !== full && new THREE.Color(d.bands[2].tint).r < 0.05);
  check("the other bands stay", d.bands[0].tint === full && d.bands[1].tint === full);
  inst.update(frame(34));
  check("unmuted, it is back", inst.debug().bands[2].tint === full);
  inst.resize({ width: 800, height: 500, pixelRatio: 1 });
  check("resize keeps one unit one pixel", inst.camera.right === 800 && inst.camera.top === 500);
  check("the line keeps its place in the song after a resize", near(inst.debug().headX, timeToX(34, 90)));
  inst.setQuality(0);
  let threw = null;
  try { inst.dispose(); } catch (e) { threw = e; }
  check("dispose frees without complaint", threw === null, String(threw));
}
{
  const plain = song({ sections: [], beats: [], bars: [], hasNotes: false });
  for (const s of plain.stems) s.notes = null;
  const inst = scene.create({ THREE, renderer: null, song: plain, size, reducedMotion: true, text: (k) => k });
  inst.update(frame(10));
  const d = inst.debug();
  check("without notes, sections or a beat grid it still draws every band", d.bands.length === 3 && d.sections === 0 && d.bars === 0);
  check("the line's halo is the scene's own: the host's glow is never asked for", inst.bloom === null && d.calm === true);
  const cam = inst.camera.position.toArray().join();
  inst.update(frame(70));
  check("calm: only the line moves", inst.debug().headX > d.headX && inst.camera.position.toArray().join() === cam);
  inst.dispose();
}

// -- strings ----------------------------------------------------------------------------------

const LANGS = ["en", "pl", "ja", "ko", "zh-Hans", "de", "fr", "es", "pt", "id"];
check("strings come in the ten languages", LANGS.every((l) => strings[l]) && Object.keys(strings).length === LANGS.length, Object.keys(strings).join(","));
for (const lang of LANGS) {
  const s = strings[lang] || {};
  check(`${lang} has a name and a description`, typeof s.name === "string" && s.name.trim() && typeof s.description === "string" && s.description.trim());
  if (lang !== "en") check(`${lang} is translated`, s.description !== strings.en.description);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
