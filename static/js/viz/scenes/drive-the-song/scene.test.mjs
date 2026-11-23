// Drive the song: tempo to pace, bar markers, bump timing, both data tiers,
// and its strings.
//
// Run:  node static/js/viz/scenes/drive-the-song/scene.test.mjs
// (tests/js/viz-scenes.test.mjs runs every visualization's scene.test.mjs.)

import * as THREE from "../../../../vendor/three/three.module.js";
import scene from "./index.js";
import { strings } from "./strings.js";
import {
  UNITS_PER_BEAT, DEFAULT_BPM, ROAD_WIDTH, POSTS_PER_BEAT, VIEW_DISTANCE, CALM_PAGE_BEATS, BUMP_SECONDS,
  tempoPace, makeTrack, barMarkers, levelAt, peakHits, drumHits, bumpAt, laneOffset, sounds, balanceRows, postHeight, postPlaces, sectionAt, placement,
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
const grid = (bpm, seconds, from = 0) => Array.from({ length: Math.floor(((seconds - from) * bpm) / 60) + 1 }, (_, i) => from + (i * 60) / bpm);

// -- tempo is pace ------------------------------------------------------------------

check("a beat is always the same length of road", near(tempoPace(60), UNITS_PER_BEAT));
check("160 beats a minute passes at twice the pace of 80", near(tempoPace(160), 2 * tempoPace(80)));
check("a song with no tempo still moves", near(tempoPace(null), tempoPace(DEFAULT_BPM)) && tempoPace(0) > 0);
{
  const slow = makeTrack({ duration: 60, bpm: 80, beats: grid(80, 60) });
  const fast = makeTrack({ duration: 60, bpm: 160, beats: grid(160, 60) });
  check("with a beat grid, the faster song's road passes at twice the pace", near(fast.paceAt(10), 2 * slow.paceAt(10)) && near(slow.paceAt(10), tempoPace(80)));
  check("and it has gone twice as far in the same time", near(fast.distanceAt(30), 2 * slow.distanceAt(30)));
  check("every beat is UNITS_PER_BEAT of road", near(slow.distanceAt(0.75) - slow.distanceAt(0), UNITS_PER_BEAT) && near(slow.distanceAt(7.5), 10 * UNITS_PER_BEAT));
  check("between beats the road is linear", near(slow.distanceAt(0.375), UNITS_PER_BEAT / 2));
  check("time and distance are each other's inverse", [0, 0.2, 3.3, 29, 59.5].every((t) => near(slow.timeAt(slow.distanceAt(t)), t, 1e-9)));
  check("the road is as long as the song", near(slow.length, slow.distanceAt(60)) && slow.beatsKnown === true);
}
{
  // A grid that starts late and a song that speeds up.
  const late = makeTrack({ duration: 20, bpm: 120, beats: [2, 2.5, 3, 3.5, 4] });
  check("before the first beat the road already runs, at the first beats' pace", near(late.distanceAt(1), 2 * UNITS_PER_BEAT) && near(late.distanceAt(2), 4 * UNITS_PER_BEAT));
  check("after the last beat it carries on at the last beats' pace", near(late.distanceAt(5) - late.distanceAt(4), 2 * UNITS_PER_BEAT));
  check("the inverse holds outside the grid too", near(late.timeAt(late.distanceAt(1)), 1, 1e-9) && near(late.timeAt(late.distanceAt(9)), 9, 1e-9));
  const rushing = makeTrack({ duration: 10, bpm: 100, beats: [0, 1, 2, 2.5, 3, 3.5] });
  check("a song that speeds up, its road speeds up", near(rushing.paceAt(0.5), UNITS_PER_BEAT) && near(rushing.paceAt(2.7), 2 * UNITS_PER_BEAT));
  check("the road never runs backwards", [0, 0.5, 1, 2, 2.4, 3, 6].every((t, i, a) => i === 0 || rushing.distanceAt(t) > rushing.distanceAt(a[i - 1])));
}
{
  const noGrid = makeTrack({ duration: 30, bpm: 90, beats: [] });
  check("without a beat grid the road runs at the song's tempo", noGrid.beatsKnown === false && near(noGrid.paceAt(5), tempoPace(90)) && near(noGrid.distanceAt(10), 10 * tempoPace(90)));
  check("and time and distance still invert", near(noGrid.timeAt(noGrid.distanceAt(7.7)), 7.7, 1e-9));
  const nothing = makeTrack({ duration: 30, bpm: null, beats: [] });
  check("without any tempo it runs at the default", near(nothing.paceAt(0), tempoPace(DEFAULT_BPM)) && near(nothing.length, 30 * tempoPace(DEFAULT_BPM)));
  check("one beat is not a grid", makeTrack({ duration: 30, bpm: 90, beats: [1] }).beatsKnown === false);
}

// -- bar markers ---------------------------------------------------------------------

{
  const song = { duration: 16, bpm: 120, beats: grid(120, 16), bars: [0, 2, 4, 6] };
  const track = makeTrack(song);
  const marks = barMarkers(song, track);
  check("a bar line for every bar", marks.length === 4);
  check("bar lines are four beats of road apart in 4/4", marks.every((d, i) => i === 0 || near(d - marks[i - 1], 4 * UNITS_PER_BEAT)));
  check("a bar line is where its moment is on the road", near(marks[2], track.distanceAt(4)));
  check("no bars, no bar lines", barMarkers({ bars: [] }, track).length === 0 && barMarkers({}, track).length === 0);
}

// -- drum hits and bumps ----------------------------------------------------------------

{
  // Hits from notes.
  const notes = [{ start: 1, end: 1.1, pitch: 36, velocity: 1 }, { start: 2, end: 2.1, pitch: 38, velocity: 0.4 }, { start: 3, end: 3.1, pitch: 42, velocity: 0.01 }];
  const fromNotes = drumHits({ notes, peaks: new Float32Array(10) }, 10);
  check("with drum notes, the hits are the notes", fromNotes.from === "notes" && fromNotes.hits.length === 3 && fromNotes.hits[0].time === 1);
  check("a harder hit is a stronger bump", fromNotes.hits[0].strength > fromNotes.hits[1].strength);
  check("the softest hit is still a bump", fromNotes.hits[2].strength >= 0.15);
  // Hits from loudness: a spike every second on a quiet floor.
  const peaks = new Float32Array(1001).fill(0.05);
  for (const s of [1, 2, 3, 4]) peaks[s * 100] = 0.9;
  peaks[250] = 0.5;
  const fromLoudness = drumHits({ notes: null, peaks }, 10);
  check("without drum notes, hits are found in the loudness", fromLoudness.from === "loudness" && fromLoudness.hits.length === 5, String(fromLoudness.hits.length));
  check("at the moments of the peaks", [1, 2, 2.5, 3, 4].every((t, i) => near(fromLoudness.hits[i].time, t, 0.02)));
  check("a louder peak is a stronger bump", fromLoudness.hits[0].strength > fromLoudness.hits[2].strength && near(fromLoudness.hits[0].strength, 1));
  check("a transcribed but empty drum stem falls back to loudness", drumHits({ notes: [], peaks }, 10).from === "loudness");
  check("steady noise has no hits", peakHits(new Float32Array(500).fill(0.5), 10).length === 0);
  check("silence has no hits", peakHits(new Float32Array(500), 10).length === 0 && drumHits({ notes: null, peaks: new Float32Array(500) }, 10).from === "none");
  check("no drum stem, no hits", drumHits(null, 10).hits.length === 0 && drumHits(null, 10).from === "none");
  {
    const close = new Float32Array(1001).fill(0.05);
    close[100] = 0.6;
    close[103] = 0.9;
    const h = peakHits(close, 10);
    check("two peaks closer than a tenth of a second are one hit, the louder", h.length === 1 && near(h[0].strength, 1));
  }

  const hits = [{ time: 2, strength: 1 }, { time: 4, strength: 0.5 }];
  check("between hits the road is flat", bumpAt(hits, 1) === 0 && bumpAt(hits, 3) === 0 && bumpAt(hits, 9) === 0);
  check("the bump is under the viewer as the hit is heard", near(bumpAt(hits, 2), 1));
  check("the viewer rides up just before it", bumpAt(hits, 2 - BUMP_SECONDS * 0.1) > 0 && bumpAt(hits, 2 - BUMP_SECONDS * 0.1) < 1);
  check("and down just after", bumpAt(hits, 2 + BUMP_SECONDS / 2) > 0 && bumpAt(hits, 2 + BUMP_SECONDS / 2) < 1);
  check("the bump is over within BUMP_SECONDS", bumpAt(hits, 2 + BUMP_SECONDS + 0.001) === 0);
  check("a softer hit is a smaller bump", near(bumpAt(hits, 4), 0.5));
  check("the same moment gives the same lift", bumpAt(hits, 2.03) === bumpAt(hits, 2.03));
  check("no hits, no bump", bumpAt([], 1) === 0);
  check("a flam's two hits: the higher wins", near(bumpAt([{ time: 2, strength: 0.4 }, { time: 2.02, strength: 1 }], 2.02), 1));
}

// -- the other stems beside the road ---------------------------------------------------------

check("the first stem stands nearest the road, on the left", laneOffset(0) < -ROAD_WIDTH / 2 && Math.abs(laneOffset(0)) < Math.abs(laneOffset(2)));
check("stems alternate sides", laneOffset(1) > ROAD_WIDTH / 2 && laneOffset(2) < 0 && laneOffset(3) > 0);
check("the two sides mirror each other", near(laneOffset(0), -laneOffset(1)) && near(laneOffset(2), -laneOffset(3)));
check("nothing stands on the road", [0, 1, 2, 3, 4].every((i) => Math.abs(laneOffset(i)) > ROAD_WIDTH / 2 + 1));
check("a stem that makes any sound gets a row; a silent one does not", sounds(new Float32Array([0, 0.2])) && !sounds(new Float32Array(50)) && !sounds(null));
check("rows are shared out so the sides balance", JSON.stringify(balanceRows([100, 90, 80, 5])) === "[0,1,3,2]", JSON.stringify(balanceRows([100, 90, 80, 5])));
check("a stem with no posts gets no row and leaves no hole", JSON.stringify(balanceRows([50, 0, 40])) === "[0,-1,1]" && JSON.stringify(balanceRows([0, 0])) === "[-1,-1]");
check("the busiest stem stands nearest the road", balanceRows([3, 200, 100])[1] === 0);
check("a louder stem's post is taller", postHeight(0.9) > postHeight(0.3) && postHeight(0.3) > postHeight(0));
check("levelAt is linear between points", near(levelAt(new Float32Array([0, 1]), 10, 2.5), 0.25) && levelAt(null, 10, 1) === 0);
{
  const track = makeTrack({ duration: 10, bpm: 120, beats: grid(120, 10) });
  const places = postPlaces(track);
  check("posts stand POSTS_PER_BEAT to the beat", near(places[1].distance - places[0].distance, UNITS_PER_BEAT / POSTS_PER_BEAT));
  check("the whole length of the road", near(places[0].distance, 0) && places[places.length - 1].distance > track.length - UNITS_PER_BEAT);
  check("each post knows its moment", near(places[4].time, track.timeAt(places[4].distance)) && near(places[4].time, 1));
  check("lower detail plants every other post", postPlaces(track, 2).length <= Math.ceil(places.length / 2) + 1);
}

// -- sections, and the calm version -----------------------------------------------------------

const sections = [{ start: 0, end: 8, color: "#ff8800" }, { start: 8, end: 20, color: "#00aaff" }];
check("a moment is in its section", sectionAt(3, sections) === 0 && sectionAt(8, sections) === 1 && sectionAt(25, sections) === -1 && sectionAt(3, []) === -1);
check("in motion the viewer is at the present moment", placement(123).viewer === 123 && placement(123).marker === 123);
{
  const page = CALM_PAGE_BEATS * UNITS_PER_BEAT;
  const a = placement(page * 2 + 10, true);
  const b = placement(page * 2 + 90, true);
  check("calm: the viewer holds still within a page", a.viewer === b.viewer && a.viewer === page * 2 && a.page === 2);
  check("calm: the marker travels instead", b.marker > a.marker);
  check("calm: the next page starts where the last ended", placement(page * 3, true).viewer === page * 3);
}
check("lower detail sees less far", VIEW_DISTANCE[0] < VIEW_DISTANCE[1] && VIEW_DISTANCE[1] < VIEW_DISTANCE[2]);

// -- the scene itself, both tiers ------------------------------------------------------------

const stem = (name, color, notes, peaks = new Float32Array(200).fill(0.4)) => ({ name, color, peaks, notes });
const spiky = Float32Array.from({ length: 2001 }, (_, i) => (i % 100 === 0 && i > 0 ? 0.9 : 0.05));
const song = (bpm, over = {}) => ({
  duration: 20, bpm, beats: grid(bpm, 20), bars: grid(bpm / 4, 20), sections, hasNotes: false,
  stems: [stem("vocals", "#e85f6f", null), stem("drums", "#e89048", null, spiky), stem("bass", "#e8b848", null), stem("other", "#88a8c8", null, new Float32Array(200))],
  ...over,
});
const lights = (over = {}) => Object.fromEntries(["vocals", "drums", "bass", "other"].map((k) => [k, { level: 0.4, lit: true, gain: 1 }]).concat(Object.entries(over)));
const frame = (time, over = {}) => ({ time, playing: true, rate: 1, jumped: false, beat: null, bar: null, stems: lights(), ...over });
const size = { width: 1200, height: 600, pixelRatio: 1 };
const make = (s, calm = false) => scene.create({ THREE, renderer: null, song: s, size, reducedMotion: calm, text: (k) => k });
const by = (inst) => Object.fromEntries(inst.debug().stems.map((s) => [s.name, s]));

check("the visualization names itself", scene.id === "drive-the-song" && scene.needs.notes === false && scene.strings === strings);
{
  const slow = make(song(80));
  const fast = make(song(160));
  check("create returns the contract", slow.scene.isScene && slow.camera.isCamera && ["update", "resize", "setQuality", "dispose"].every((k) => typeof slow[k] === "function"));
  slow.update(frame(5));
  fast.update(frame(5));
  check("the faster song is driven at twice the pace", near(fast.debug().pace, 2 * slow.debug().pace) && near(fast.debug().distance, 2 * slow.debug().distance));
  slow.update(frame(6));
  check("the viewer moves along the road with the song", near(slow.debug().distance, 6 * tempoPace(80)) && slow.debug().cameraZ < -30);
  check("a bar line for every bar, on the road", slow.debug().bars === song(80).bars.length);
  check("drum hits come from loudness when there are no drum notes", slow.debug().hitsFrom === "loudness" && slow.debug().hits === 19, String(slow.debug().hits));
  check("the other stems are rows of posts; a silent one has none", by(slow).vocals.posts > 10 && by(slow).bass.posts > 10 && by(slow).other.posts === 0);
  check("the drums are the road's bumps, not a row of posts", !("drums" in by(slow)));
  check("stems stand on alternating sides", by(slow).vocals.x < 0 && by(slow).bass.x > 0);
  {
    // The silent stem between two sounding ones takes no side from them.
    const gap = song(80);
    gap.stems = [gap.stems[0], gap.stems[1], gap.stems[3], gap.stems[2]];
    const inst = make(gap);
    check("a silent stem does not leave a hole in the alternation", by(inst).vocals.x < 0 && by(inst).bass.x > 0 && near(by(inst).vocals.x, -by(inst).bass.x));
    inst.dispose();
  }
  // The drums' loudness has a peak on every whole second.
  slow.update(frame(5.5));
  const flat = slow.debug().cameraY;
  slow.update(frame(5.3));
  check("the road is flat between hits", slow.debug().lift === 0 && near(slow.debug().cameraY, flat));
  slow.update(frame(6));
  check("a hit lifts the viewer as it is heard", slow.debug().lift > 0.8 && slow.debug().cameraY > flat, String(slow.debug().lift));
  slow.update(frame(6, { stems: lights({ drums: { level: 0.4, lit: false, gain: 0 } }) }));
  check("muted drums make no lift", slow.debug().lift === 0 && slow.debug().drumsOn === false);
  slow.update(frame(3));
  check("the viewer is in the first section", slow.debug().section === 0);
  slow.update(frame(9));
  check("and then the second: the scenery changes", slow.debug().section === 1);
  const full = by(slow).bass.tint;
  slow.update(frame(9, { stems: lights({ bass: { level: 0.4, lit: false, gain: 0 } }) }));
  check("a muted stem's posts go almost black", by(slow).bass.tint !== full && new THREE.Color(by(slow).bass.tint).r < 0.2);
  check("the others keep their colour", by(slow).vocals.tint !== by(slow).bass.tint);
  slow.update(frame(9.1));
  check("unmuted, it is back", by(slow).bass.tint === full);
  slow.update(frame(1, { jumped: true }));
  check("a seek moves the viewer with it", near(slow.debug().distance, tempoPace(80)));
  const posts = by(slow).vocals.posts;
  slow.setQuality(0);
  slow.update(frame(1));
  check("lower detail plants fewer posts and still draws", by(slow).vocals.posts < posts && by(slow).vocals.posts > 0);
  slow.resize({ width: 500, height: 800, pixelRatio: 1 });
  check("resize keeps the camera's aspect", near(slow.camera.aspect, 500 / 800));
  let threw = null;
  try { slow.dispose(); fast.dispose(); } catch (e) { threw = e; }
  check("dispose frees without complaint", threw === null, String(threw));
}
{
  const s = song(120);
  s.stems[1].notes = [{ start: 2, end: 2.1, pitch: 38, velocity: 1 }, { start: 2.5, end: 2.6, pitch: 36, velocity: 0.5 }];
  const inst = make(s);
  check("with drum notes, the bumps are the notes", inst.debug().hitsFrom === "notes" && inst.debug().hits === 2);
  inst.update(frame(2));
  check("a snare hit is a bump under the viewer as it is heard", inst.debug().lift > 0.9);
  inst.update(frame(2.3));
  check("and the road is flat again after it", inst.debug().lift === 0);
  inst.dispose();
}
{
  const bare = song(100, { beats: [], bars: [], sections: [] });
  const inst = make(bare);
  inst.update(frame(4));
  const d = inst.debug();
  check("without a beat grid it still drives, at the song's tempo, with no bar lines", d.beatsKnown === false && d.bars === 0 && near(d.pace, tempoPace(100)) && near(d.distance, 4 * tempoPace(100)));
  check("without sections there is no scenery change and nothing breaks", d.section === -1);
  inst.dispose();
}
{
  const inst = make(song(120), true);
  check("calm: no glow is asked for", inst.bloom === null && inst.debug().calm === true);
  inst.update(frame(1));
  const cam = inst.camera.position.toArray().join();
  inst.update(frame(6));
  check("calm: the viewer holds still while the song moves on", inst.camera.position.toArray().join() === cam && near(inst.debug().distance, 6 * tempoPace(120)));
  check("calm: a hit does not lift the view", inst.debug().lift === 0);
  inst.update(frame(9));
  check("calm: the page turns when the car reaches its end", inst.camera.position.toArray().join() !== cam);
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
