// The Visualizer's song data (static/js/viz/data.js): one plain object per
// song, whatever the song has or lacks.
//
// Run:  node tests/js/viz-data.test.mjs

import {
  STEM_ORDER, amplitude, levelAt, cleanNotes, beatTimes, barTimes, cleanSections, buildSong, loadSong, forgetSong, transcribed,
} from "../../static/js/viz/data.js";

let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const COLORS = { vocals: "#e85f6f", drums: "#e89048", bass: "#e8b848", other: "#88a8c8" };
const stem = (name) => ({ name, url: `/api/jobs/j1/stems/${name}.wav` });
const JOB = {
  job_id: "j1",
  duration: 8,
  bpm: 120,
  key: "C maj",
  transcription_stems: { vocals: { status: "done", notes: 3 }, other: { status: "skipped", notes: 0 } },
  stems: [stem("vocals"), stem("drums"), stem("bass"), stem("other"), stem("original")],
  sections: [
    { id: "b", name: "Chorus", start: 4, end: 20, color: "#f00", kind: "chorus" },
    { id: "a", name: "Intro", start: 0, end: 4, color: "#0f0", kind: "intro" },
    { id: "x", name: "bad", start: 5, end: 5, color: "#00f" },
  ],
};
const PEAKS = {
  vocals: [[-0.5, 0.25], [-0.1, 0.9], [0, 0], [-2, 0.3]],
  drums: [[-0.2, 0.2], [-0.4, 0.4]],
  bass: [[-0.1, 0.1]],
  other: [],
  mix: [[-1, 1]],
};
const GRID = {
  bpm: 121.5,
  duration: 8,
  beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5],
  bars: [{ beat: 1, beats_per_bar: 4 }, { beat: 6, beats_per_bar: 2 }],
};
const note = (start, end, pitch, velocity) => ({ start, end, pitch, velocity });
const TRANSCRIPTION = {
  stems: {
    vocals: { notes: [note(2, 2.5, 64, 100), note(1, 1.5, 60, 127), note(1, 1.2, 55, 0)] },
    bass: { notes: [note(0, 1, 40, 80)] },
    drums: { notes: [note(0.5, 0.6, 36, 110), note(-1, 0, 38, 90), note(1, 1.1, 300, 90), { start: "x" }] },
    other: { notes: [], skipped: "silent" },
  },
};

// -- pure pieces --------------------------------------------------------------

const amp = amplitude(PEAKS.vocals);
check("amplitude takes the larger side of each point", near(amp[0], 0.5) && near(amp[1], 0.9) && amp[2] === 0);
check("amplitude never exceeds 1", amp[3] === 1);
check("amplitude of nothing is empty", amplitude(null).length === 0 && amplitude(undefined).length === 0);

check("levelAt reads the first point at 0", near(levelAt(amp, 8, 0), 0.5));
check("levelAt reads the last point at the end", near(levelAt(amp, 8, 8), 1));
check("levelAt is linear between points", near(levelAt(new Float32Array([0, 1]), 10, 2.5), 0.25));
check("levelAt clamps outside the song", near(levelAt(amp, 8, -3), 0.5) && near(levelAt(amp, 8, 99), 1));
check("levelAt with no peaks or no duration is 0", levelAt(new Float32Array(0), 8, 1) === 0 && levelAt(amp, 0, 1) === 0);

const cleaned = cleanNotes(TRANSCRIPTION.stems.drums.notes);
check("notes that are not notes are dropped", cleaned.length === 1 && cleaned[0].pitch === 36, JSON.stringify(cleaned));
const sorted = cleanNotes(TRANSCRIPTION.stems.vocals.notes);
check("notes come out in time order, then pitch", same(sorted.map((n) => n.pitch), [55, 60, 64]));
check("velocity is 0..1", near(sorted[1].velocity, 1) && sorted[0].velocity === 0 && near(sorted[2].velocity, 100 / 127));
check("a note with no usable end gets a short one", near(cleanNotes([{ start: 1, end: 1, pitch: 60 }])[0].end, 1.1));
check("a note without a velocity gets a middling one", cleanNotes([{ start: 1, end: 2, pitch: 60 }])[0].velocity > 0.5);

check("beats come out sorted", same(beatTimes({ beats: [2, 1, "x", 3] }), [1, 2, 3]));
check("no grid, no beats", same(beatTimes(null), []) && same(beatTimes({}), []));
const beats = beatTimes(GRID);
check("bar marks give downbeats, each mark until the next", same(barTimes(beats, GRID.bars), [1, 3, 3.5, 4.5]), JSON.stringify(barTimes(beats, GRID.bars)));
check("no bar marks, no bars", same(barTimes(beats, []), []) && same(barTimes(beats, undefined), []));
check("a nonsense bar mark is ignored", same(barTimes(beats, [{ beat: 0, beats_per_bar: 0 }, { beat: "a" }]), []));

const sections = cleanSections(JOB.sections, 8);
check("sections are in time order", same(sections.map((s) => s.name), ["Intro", "Chorus"]));
check("a section is clipped to the song", sections[1].end === 8);
check("an empty section is dropped", sections.length === 2);
check("no sections is an empty list", same(cleanSections(null, 8), []));

// -- a song with notes --------------------------------------------------------

const full = buildSong({ job: JOB, peaks: PEAKS, grid: GRID, transcription: TRANSCRIPTION, colors: COLORS });
check("stems are the song's, in display order, without the mix", same(full.stems.map((s) => s.name), ["vocals", "drums", "bass", "other"]));
check("the display order is the six base stems", same(STEM_ORDER, ["vocals", "drums", "bass", "guitar", "piano", "other"]));
check("each stem has StemDeck's colour", full.stems.every((s) => s.color === COLORS[s.name]));
check("each stem has its peaks", full.stems[0].peaks.length === 4 && full.stems[3].peaks.length === 0);
check("a song with notes has notes on every transcribed stem", full.stems.every((s) => Array.isArray(s.notes)));
check("a silent transcribed stem has an empty list, not null", same(full.stems[3].notes, []));
check("hasNotes is true", full.hasNotes === true);
check("duration, tempo and key ride along", full.duration === 8 && full.bpm === 121.5 && full.key === "C maj" && full.id === "j1");
check("beats and bars are there", full.beats.length === 9 && full.bars.length === 4);
check("sections are there", full.sections.length === 2);

// -- without notes ------------------------------------------------------------

const bare = buildSong({ job: JOB, peaks: PEAKS, grid: GRID, transcription: null, colors: COLORS });
check("without a transcription every stem's notes are null", bare.stems.every((s) => s.notes === null));
check("hasNotes is false", bare.hasNotes === false);
check("the loudness is still there", bare.stems[0].peaks.length === 4);

// -- some stems transcribed ---------------------------------------------------

const part = buildSong({ job: JOB, peaks: PEAKS, grid: GRID, transcription: { stems: { bass: TRANSCRIPTION.stems.bass } }, colors: COLORS });
check("only the transcribed stem has notes", same(part.stems.map((s) => (s.notes ? s.notes.length : null)), [null, null, 1, null]));
check("hasNotes is true with one stem", part.hasNotes === true);

// -- without a beat grid ------------------------------------------------------

const noGrid = buildSong({ job: JOB, peaks: PEAKS, grid: null, transcription: TRANSCRIPTION, colors: COLORS });
check("no beat grid: no beats and no bars", same(noGrid.beats, []) && same(noGrid.bars, []));
check("no beat grid: the tempo falls back to the job's", noGrid.bpm === 120);
check("no beat grid: everything else is intact", noGrid.duration === 8 && noGrid.stems.length === 4 && noGrid.hasNotes);

// -- without sections ---------------------------------------------------------

const noSections = buildSong({ job: { ...JOB, sections: null }, peaks: PEAKS, grid: GRID, colors: COLORS });
check("no sections: an empty list", same(noSections.sections, []));

// -- the thin cases -----------------------------------------------------------

const noPeaks = buildSong({ job: JOB, colors: COLORS });
check("no peaks: stems still listed, with empty peaks", noPeaks.stems.length === 4 && noPeaks.stems.every((s) => s.peaks.length === 0));
const noDuration = buildSong({ job: { ...JOB, duration: null }, grid: { beats: [1, 2, 3] }, transcription: TRANSCRIPTION });
check("no duration anywhere: the last note or beat stands in", noDuration.duration === 3, String(noDuration.duration));
check("an unknown stem colour falls back", buildSong({ job: JOB }).stems[0].color.startsWith("#"));
check("a job with no tempo has none", buildSong({ job: { stems: [] } }).bpm === null);

// -- loading: one load per song -------------------------------------------------

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const body = answers[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const answers = {
  "/api/jobs/j1": JOB,
  "/api/jobs/j1/peaks": PEAKS,
  "/api/jobs/j1/beats": GRID,
  "/api/jobs/j1/transcription": TRANSCRIPTION,
};
forgetSong();
const fetchA = fakeFetch(answers);
const [a, b] = await Promise.all([loadSong("j1", { colors: COLORS, fetchFn: fetchA }), loadSong("j1", { colors: COLORS, fetchFn: fetchA })]);
check("a song loads", a && a.stems.length === 4 && a.hasNotes);
check("two asks for one song are one load", a === b && fetchA.calls.length === 4, String(fetchA.calls.length));
check("only the four read endpoints are asked", same([...fetchA.calls].sort(), Object.keys(answers).sort()));
await loadSong("j1", { fetchFn: fetchA });
check("a later ask is still the same load", fetchA.calls.length === 4);
forgetSong("j1");
await loadSong("j1", { fetchFn: fetchA });
check("after forgetSong the song is read again", fetchA.calls.length === 8);

check("a song says whether it has notes", transcribed(JOB) && !transcribed({}) && !transcribed({ transcription_stems: { bass: { status: "error", notes: 0 } } }));
forgetSong();
const fetchC = fakeFetch({ ...answers, "/api/jobs/j1": { ...JOB, transcription_stems: {} } });
const untranscribed = await loadSong("j1", { fetchFn: fetchC });
check("a song with no notes is never asked for them", !fetchC.calls.some((u) => u.endsWith("/transcription")) && fetchC.calls.length === 3, fetchC.calls.join(" "));
check("and its stems have no notes", untranscribed.stems.every((s2) => s2.notes === null) && !untranscribed.hasNotes);

forgetSong();
const fetchB = fakeFetch({ "/api/jobs/j2": { ...JOB, job_id: "j2" }, "/api/jobs/j2/peaks": new Error("offline") });
const thin = await loadSong("j2", { fetchFn: fetchB });
check("404s and failures are missing data, not an error", thin && thin.id === "j2" && !thin.hasNotes && thin.beats.length === 0);
const gone = await loadSong("j3", { fetchFn: fakeFetch({}) });
check("a song that cannot be read is null", gone === null);
check("no song id, no load", (await loadSong(null)) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
