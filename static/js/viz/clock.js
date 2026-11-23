// The Visualizer's clock: once per drawn frame, where the song is and what the
// mixer is letting through.
//
//   frame = {
//     time, playing, rate,
//     jumped,                       true on the frame after a seek or loop jump
//     beat: { index, phase } | null,   phase 0..1 through the current beat
//     bar:  { index, phase } | null,
//     stems: { name: { level, lit, gain } },
//   }
//
// The player is the only clock. Its position advances in audio-callback steps,
// which at 60 frames a second shows as judder, so between readings the clock
// runs on at the playback rate and eases toward each new reading. A reading
// that is behind the estimate, or further ahead than playback could have got,
// is a seek or a loop jump, and the clock goes straight there.
//
// `level` is the stem's loudness at this moment (0..1, from its peaks). `lit`
// is whether the mixer lets it sound: not muted, and soloed when anything is.
// Every visualization dims by `lit`, so each follows the mixer by construction.
//
// No DOM and no player import: both are handed in, so this runs under node
// (tests/js/viz-clock.test.mjs).

import { levelAt } from "./data.js";

// A new reading this far behind the estimate is a jump back, not jitter.
const BACK_TOLERANCE_S = 0.05;
// How far beyond the expected advance a reading may land before it is a jump.
const FORWARD_TOLERANCE_S = 0.15;
// With no new reading, run on for at most this long (a stalled player).
const MAX_RUN_ON_S = 0.1;
// How much of the gap to a new reading is closed per frame.
const EASE = 0.25;

/**
 * Which lanes decide whether a stem sounds. A stem with a lane of its own is
 * that lane. Vocals shown as the lead and backing pair follow the pair. A stem
 * folded into the Original lane follows Original. Otherwise it is not playing.
 */
export function controlLanes(stem, lanes) {
  if (lanes[stem]) return [stem];
  if (stem === "vocals") {
    const pair = ["lead_vocals", "backing_vocals"].filter((n) => lanes[n]);
    if (pair.length) return pair;
  }
  return lanes.original ? ["original"] : [];
}

/**
 * Mute and solo, folded into one answer per stem.
 *
 * @param stemNames  the song's stems
 * @param lanes      { laneName: { volume, muted, soloed } } for every lane that plays
 * @returns { name: { lit, gain } }
 */
export function lighting(stemNames, lanes) {
  const all = lanes || {};
  const anySolo = Object.values(all).some((l) => l?.soloed);
  const audible = (lane) => {
    const l = all[lane];
    if (!l || l.muted) return 0;
    if (anySolo && !l.soloed) return 0;
    const v = Number(l.volume);
    return Number.isFinite(v) ? Math.max(0, v) : 1;
  };
  const out = {};
  for (const name of stemNames) {
    const gain = Math.max(0, ...controlLanes(name, all).map(audible));
    out[name] = { lit: gain > 0, gain };
  }
  return out;
}

/** The entry of a rising list of times that `time` is in: { index, phase }. */
export function position(times, time) {
  const n = times?.length || 0;
  if (!n) return null;
  if (time < times[0]) return { index: -1, phase: 0 };
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  // The last interval has no end of its own: it is as long as the one before.
  const span = lo + 1 < n ? times[lo + 1] - times[lo] : lo > 0 ? times[lo] - times[lo - 1] : 0;
  const phase = span > 0 ? Math.min(1, (time - times[lo]) / span) : 0;
  return { index: lo, phase };
}

/**
 * @param song    from data.js
 * @param player  { time(): seconds, playing(): boolean, rate(): number }
 * @param mixer   () => { laneName: { volume, muted, soloed } }
 * @param now     () => milliseconds (performance.now)
 */
export function createClock({ song, player, mixer, now = () => performance.now() }) {
  const stemNames = song.stems.map((s) => s.name);
  let started = false;
  let time = 0;
  let lastRaw = 0;
  let lastWall = 0;
  let rawWall = 0;
  let wasPlaying = false;

  function read() {
    const raw = Number(player.time());
    return Number.isFinite(raw) ? raw : 0;
  }

  function frame() {
    const wall = now();
    const raw = read();
    const playing = Boolean(player.playing());
    const rateRaw = Number(player.rate());
    const rate = rateRaw > 0 ? rateRaw : 1;
    let jumped = false;

    if (!started || !playing || !wasPlaying) {
      // Stopped, or the first frame of playing: the reading is the truth.
      jumped = started && Math.abs(raw - time) > BACK_TOLERANCE_S;
      time = raw;
      rawWall = wall;
    } else {
      const advance = ((wall - lastWall) / 1000) * rate;
      const estimate = time + advance;
      if (raw !== lastRaw) {
        const gap = raw - estimate;
        if (gap < -BACK_TOLERANCE_S || gap > advance + FORWARD_TOLERANCE_S) {
          time = raw;
          jumped = true;
        } else {
          // Never backwards for jitter: only a jump may move the picture back.
          time = Math.max(time, estimate + gap * EASE);
        }
        rawWall = wall;
      } else {
        const ranOn = ((wall - rawWall) / 1000) * rate;
        time = ranOn > MAX_RUN_ON_S ? Math.max(time, raw + MAX_RUN_ON_S * rate) : estimate;
      }
    }
    if (song.duration > 0) time = Math.min(song.duration, time);
    if (time < 0) time = 0;

    started = true;
    wasPlaying = playing;
    lastRaw = raw;
    lastWall = wall;

    const lights = lighting(stemNames, mixer ? mixer() : null);
    const stems = {};
    for (const s of song.stems) {
      const light = lights[s.name];
      stems[s.name] = { level: levelAt(s.peaks, song.duration, time), lit: light.lit, gain: light.gain };
    }
    return {
      time,
      playing,
      rate,
      jumped,
      beat: position(song.beats, time),
      bar: position(song.bars, time),
      stems,
    };
  }

  return { frame };
}
