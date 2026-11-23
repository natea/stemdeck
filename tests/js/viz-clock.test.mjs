// The Visualizer's clock (static/js/viz/clock.js), against a fake player.
//
// Run:  node tests/js/viz-clock.test.mjs

import { createClock, lighting, controlLanes, position } from "../../static/js/viz/clock.js";

let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};
const near = (a, b, eps = 0.02) => Math.abs(a - b) < eps;

const SONG = {
  duration: 100,
  stems: [
    { name: "vocals", peaks: new Float32Array([0, 1]) },
    { name: "drums", peaks: new Float32Array([0.5, 0.5]) },
    { name: "bass", peaks: new Float32Array(0) },
  ],
  beats: [1, 2, 3, 4, 5, 6],
  bars: [1, 5],
};
const lane = (o = {}) => ({ volume: 1, muted: false, soloed: false, ...o });

// A player like the real one: its position only moves in audio-callback
// steps, however often it is read.
function fakePlayer({ step = 0.02 } = {}) {
  const p = {
    wall: 0, // ms
    pos: 0, // true position, seconds
    isPlaying: false,
    speed: 1,
    advance(ms) {
      p.wall += ms;
      if (p.isPlaying) p.pos += (ms / 1000) * p.speed;
    },
    time: () => Math.floor(p.pos / step + 1e-9) * step,
    playing: () => p.isPlaying,
    rate: () => p.speed,
  };
  return p;
}

function rig(lanes = { vocals: lane(), drums: lane(), bass: lane() }) {
  const player = fakePlayer();
  const state = { lanes };
  const clock = createClock({ song: SONG, player, mixer: () => state.lanes, now: () => player.wall });
  // Run n frames of 1/60 s and return the frames.
  const run = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      player.advance(1000 / 60);
      out.push(clock.frame());
    }
    return out;
  };
  return { player, clock, run, state };
}

// -- playing: smooth and in step ----------------------------------------------

{
  const { player, run } = rig();
  player.isPlaying = true;
  const frames = run(120);
  const last = frames[frames.length - 1];
  check("playing: the clock follows the player", near(last.time, player.pos, 0.03), `${last.time} vs ${player.pos}`);
  const steps = frames.slice(10).map((f, i, a) => (i ? f.time - a[i - 1].time : null)).filter((d) => d !== null);
  check("playing: time never runs backwards", steps.every((d) => d >= 0));
  // The player itself moves 0 or 20 ms per frame; the clock should be even.
  const worst = Math.max(...steps.map((d) => Math.abs(d - 1 / 60)));
  check("playing: motion is even between the player's steps", worst < 0.006, `worst step error ${worst}`);
  check("playing: no jump is reported", frames.slice(2).every((f) => !f.jumped));
  check("playing: the frame says so", last.playing === true && last.rate === 1);
}

// -- pause ----------------------------------------------------------------------

{
  const { player, run } = rig();
  player.isPlaying = true;
  run(60);
  player.isPlaying = false;
  const held = run(30);
  check("paused: the picture holds", held.every((f) => f.time === held[0].time));
  check("paused: it holds where the player is", held[0].time === player.time());
  check("paused: the frame says so", held[0].playing === false);
  player.isPlaying = true;
  const resumed = run(30);
  check("resumed: it moves again from there", resumed[29].time > held[0].time && near(resumed[29].time, player.pos, 0.03));
}

// -- seek -----------------------------------------------------------------------

{
  const { player, run } = rig();
  player.isPlaying = true;
  run(60);
  player.pos = 42;
  const after = run(3);
  check("seek forward: the picture jumps to it at once", near(after[0].time, 42, 0.03), String(after[0].time));
  check("seek forward: the jump is reported once", after[0].jumped === true && after[2].jumped === false);
  player.pos = 7;
  const back = run(2);
  check("seek back: the picture jumps to it at once", near(back[0].time, 7, 0.03) && back[0].jumped);

  player.isPlaying = false;
  run(2);
  player.pos = 30;
  const paused = run(1);
  check("seek while paused: the picture follows", near(paused[0].time, 30, 0.03) && paused[0].jumped);
}

// -- loop jump --------------------------------------------------------------------

{
  // A loop from 8 to 10: at 10 the player is back at 8.
  const r2 = rig();
  r2.player.isPlaying = true;
  r2.player.pos = 9.9;
  r2.run(3);
  const times = [];
  for (let i = 0; i < 30; i++) {
    r2.player.advance(1000 / 60);
    if (r2.player.pos >= 10) r2.player.pos -= 2;
    const f = r2.clock.frame();
    times.push(f);
  }
  const wrap = times.find((f) => f.jumped);
  check("loop: the jump back is seen", Boolean(wrap));
  check("loop: the picture lands at the loop start", wrap && near(wrap.time, 8, 0.05), String(wrap?.time));
  check("loop: it never shows time past the loop end by more than a frame", Math.max(...times.map((f) => f.time)) < 10.05);
  check("loop: it carries on from the start", near(times[29].time, r2.player.pos, 0.03));
}

// -- half speed ---------------------------------------------------------------------

{
  const { player, run } = rig();
  player.isPlaying = true;
  player.speed = 0.5;
  const frames = run(120); // two seconds of wall time
  const last = frames[119];
  check("half speed: one second of song in two", near(last.time, 1, 0.04), String(last.time));
  check("half speed: the frame reports the rate", last.rate === 0.5);
  const steps = frames.slice(10).map((f, i, a) => (i ? f.time - a[i - 1].time : null)).filter((d) => d !== null);
  check("half speed: frames advance at half pace", near(steps.reduce((s, d) => s + d, 0) / steps.length, 0.5 / 60, 0.001));
  check("half speed: still on the moment being heard", near(last.time, player.pos, 0.03));
}

// -- a stalled player -----------------------------------------------------------------

{
  const { player, run } = rig();
  player.isPlaying = true;
  run(30);
  const before = player.pos;
  // Says it is playing but the position stops (buffering).
  const realAdvance = player.advance;
  player.advance = (ms) => { player.wall += ms; };
  const stalled = run(60);
  check("stalled: the picture does not run away", stalled[59].time - before < 0.15, String(stalled[59].time - before));
  player.advance = realAdvance;
}

// -- the end of the song ----------------------------------------------------------------

{
  const { player, run } = rig();
  player.isPlaying = true;
  player.pos = 99.99;
  const frames = run(10);
  check("time never passes the song's end", frames.every((f) => f.time <= 100));
}

// -- beat and bar -----------------------------------------------------------------------

check("position: before the first entry", JSON.stringify(position([1, 2, 3], 0.5)) === JSON.stringify({ index: -1, phase: 0 }));
check("position: on an entry", position([1, 2, 3], 2).index === 1 && position([1, 2, 3], 2).phase === 0);
check("position: part way", position([1, 2, 3], 1.25).index === 0 && near(position([1, 2, 3], 1.25).phase, 0.25, 1e-9));
check("position: the last interval is as long as the one before", near(position([1, 2, 3], 3.5).phase, 0.5, 1e-9) && position([1, 2, 3], 9).phase === 1);
check("position: no entries, no position", position([], 1) === null && position(null, 1) === null);
{
  const { player, run } = rig();
  player.pos = 2.5;
  const f = run(1)[0];
  check("frame carries the beat", f.beat.index === 1 && near(f.beat.phase, 0.5));
  check("frame carries the bar", f.bar.index === 0 && near(f.bar.phase, 1.5 / 4));
  const player2 = fakePlayer();
  const bare = createClock({ song: { ...SONG, beats: [], bars: [] }, player: player2, mixer: () => ({}), now: () => 0 }).frame();
  check("no beat grid: beat and bar are null, the rest still works", bare.beat === null && bare.bar === null && bare.time === 0);
}

// -- level ------------------------------------------------------------------------------

{
  const { player, run } = rig();
  player.pos = 50;
  const f = run(1)[0];
  check("level is the stem's loudness now", near(f.stems.vocals.level, 0.5) && near(f.stems.drums.level, 0.5));
  check("a stem with no peaks has level 0", f.stems.bass.level === 0);
}

// -- mute and solo ----------------------------------------------------------------------

const names = ["vocals", "drums", "bass"];
{
  const l = lighting(names, { vocals: lane(), drums: lane(), bass: lane() });
  check("nothing muted: everything is lit", names.every((n) => l[n].lit && l[n].gain === 1));
}
{
  const l = lighting(names, { vocals: lane(), drums: lane(), bass: lane({ muted: true }) });
  check("mute: the bass goes dark, the others stay lit", !l.bass.lit && l.bass.gain === 0 && l.vocals.lit && l.drums.lit);
}
{
  const l = lighting(names, { vocals: lane({ soloed: true }), drums: lane(), bass: lane() });
  check("solo: only the vocals are lit", l.vocals.lit && !l.drums.lit && !l.bass.lit);
}
{
  const l = lighting(names, { vocals: lane({ soloed: true }), drums: lane({ soloed: true }), bass: lane() });
  check("two solos: both are lit", l.vocals.lit && l.drums.lit && !l.bass.lit);
}
{
  const l = lighting(names, { vocals: lane({ soloed: true, muted: true }), drums: lane(), bass: lane() });
  check("muted wins over soloed, as in the mixer", !l.vocals.lit && !l.drums.lit);
}
{
  const l = lighting(names, { vocals: lane({ volume: 0 }), drums: lane({ volume: 1.5 }), bass: lane() });
  check("a fader at zero is dark; gain rides along", !l.vocals.lit && l.drums.gain === 1.5);
}
{
  // Practice mode: only vocals has a lane, the rest play inside Original.
  const lanes = { vocals: lane(), original: lane({ muted: true }) };
  const l = lighting(names, lanes);
  check("a stem folded into Original follows Original", l.vocals.lit && !l.drums.lit && !l.bass.lit);
  check("controlLanes names the lane that decides", controlLanes("drums", lanes)[0] === "original" && controlLanes("vocals", lanes)[0] === "vocals");
}
{
  const lanes = { lead_vocals: lane({ muted: true }), backing_vocals: lane(), drums: lane() };
  const l = lighting(names, lanes);
  check("vocals shown as lead and backing follow the pair", l.vocals.lit && !l.bass.lit);
  lanes.backing_vocals.muted = true;
  check("both of the pair muted: vocals dark", !lighting(names, lanes).vocals.lit);
}
check("a stem with no lane at all is dark", !lighting(["piano"], { vocals: lane() }).piano.lit);
check("no mixer state: everything dark, nothing thrown", !lighting(names, null).vocals.lit);
{
  const { run, state, player } = rig();
  player.isPlaying = true;
  run(5);
  state.lanes = { vocals: lane(), drums: lane(), bass: lane({ muted: true }) };
  const f = run(1)[0];
  check("the frame carries lit from the mixer, live", f.stems.bass.lit === false && f.stems.vocals.lit === true);
  state.lanes = { vocals: lane({ soloed: true }), drums: lane(), bass: lane() };
  const g = run(1)[0];
  check("the frame carries solo, live", g.stems.vocals.lit && !g.stems.drums.lit && !g.stems.bass.lit);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
