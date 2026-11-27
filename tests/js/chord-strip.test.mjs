// The chord strip's logic (static/js/chords/chordStripCore.js): which chord
// is sounding, what is drawn when bass notes are hidden, and what each
// correction does to the timeline.
//
// Scenarios of "The user can correct the chords", "A chord strip follows
// playback" and "The bass note is kept and shown on request" in the
// chord-recognition spec.
//
// Run:  node tests/js/chord-strip.test.mjs

import {
  FREE_STEP_SEC, LABEL_MIN_SCALE, MAX_ENTRIES, REASONS,
  blocks, cleanTimeline, clearChord, fitLabels, fromDisplayed, indexAt, isValidTimeline, moveStart,
  payload, phaseKey, placement, reasonKey, removeChord, setChord, stepTime, tidy,
} from '../../static/js/chords/chordStripCore.js';
import { chordSymbol, parseSymbol } from '../../static/js/harmony/chords.js';
import { TRANSLATIONS } from '../../static/js/i18n.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
  }
}

function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  check(name, a === b, `got ${a}, want ${b}`);
}

const C = { root: 0, degrees: ['1', '3', '5'], bass: null };
const C7 = { root: 0, degrees: ['1', '3', '5', 'b7'], bass: null };
const CMAJ7 = { root: 0, degrees: ['1', '3', '5', '7'], bass: null };
const F = { root: 5, degrees: ['1', '3', '5'], bass: null };
const G7 = { root: 7, degrees: ['1', '3', '5', 'b7'], bass: null };
const NONE = { root: null, degrees: [], bass: null };

/** A timeline from (end, chord) pairs, starting at 0. */
function line(...parts) {
  const out = [];
  let at = 0;
  for (const [end, chord] of parts) {
    out.push({ start: at, end, ...chord, degrees: [...chord.degrees] });
    at = end;
  }
  return out;
}

const shape = (entries) => entries.map((e) => [e.start, e.end, e.root]);
const symbols = (entries, opts) => entries.map((e) => chordSymbol(e, opts) || '-');
const covers = (entries, start, end) =>
  entries.length > 0 && entries[0].start === start && entries[entries.length - 1].end === end &&
  entries.every((e, i) => e.end > e.start && (i === 0 || entries[i - 1].end === e.start));

// 120 BPM from zero: a beat every half second.
const BEATS = Array.from({ length: 33 }, (_, i) => i * 0.5);

// ─── Reading what the server sent ─────────────────────────

const served = [
  { start: 0, end: 2, root: null, degrees: [], bass: null, label: 'N' },
  { start: 2, end: 4, root: 0, degrees: ['b7', '1', '5', '3'], bass: 4, label: 'C:7/3' },
  { start: 4, end: 8, root: 5, degrees: ['1', '3', '5'], bass: 5 },
];
eq('a served timeline is read as it is', cleanTimeline(served), [
  { start: 0, end: 2, root: null, degrees: [], bass: null, label: 'N' },
  { start: 2, end: 4, root: 0, degrees: ['1', '3', '5', 'b7'], bass: 4, label: 'C:7/3' },
  // A bass note that is the root is no bass note.
  { start: 4, end: 8, root: 5, degrees: ['1', '3', '5'], bass: null },
]);
eq('what cannot be drawn is dropped', shape(cleanTimeline([
  null, 'C', { start: 'x', end: 2, root: 0 }, { start: 0, end: 2, root: 0, degrees: ['1'] },
  { start: 3, end: 3, root: 0 }, { start: 1, end: 5, root: 5 }, { start: -1, end: 1, root: 0 },
  { start: 2, end: 4, root: 99, degrees: ['1'] },
])), [[0, 2, 0], [2, 4, null]]);
eq('nothing is no timeline', [cleanTimeline(null), cleanTimeline({}), cleanTimeline([])], [[], [], []]);
eq('a chord with no degrees is its root', cleanTimeline([{ start: 0, end: 1, root: 2 }])[0].degrees, ['1']);

// ─── Which chord is sounding ──────────────────────────────

const song = line([2, NONE], [4, C], [8, F], [16, G7]);
eq('the entry under the playhead', [0, 1.99, 2, 3.5, 4, 15.9].map((t) => indexAt(song, t)), [0, 0, 1, 1, 2, 3]);
eq('the very end belongs to the last entry', indexAt(song, 16), 3);
eq('outside the song there is none', [indexAt(song, -1), indexAt(song, 17), indexAt(song, NaN), indexAt([], 1)], [-1, -1, -1, -1]);
eq('a long timeline is searched, not walked', (() => {
  const many = line(...Array.from({ length: 4000 }, (_, i) => [i + 1, i % 2 ? C : F]));
  return [indexAt(many, 0.5), indexAt(many, 2500.2), indexAt(many, 3999.9)];
})(), [0, 2500, 3999]);

// ─── Where a block sits ───────────────────────────────────

eq('a block is placed by percentages of the song', placement({ start: 4, end: 8 }, 16), { left: 25, width: 25 });
eq('never outside the track', placement({ start: 12, end: 40 }, 16), { left: 75, width: 25 });
check('a song with no length does not divide by zero', Number.isFinite(placement({ start: 0, end: 1 }, 0).width));

// ─── Which symbols are drawn ──────────────────────────────

// A symbol is shown whole or not at all: half of "F#" is "F", another chord.
// Whenever there is room for one it is shown, squeezed a little sideways if
// that is what makes it fit. Each item is where a label starts, how wide its
// text is, and how much of its own block there is for it.
const fits = (items, opts) => fitLabels(items, opts).map((scale) => (scale === 1 ? 'F' : scale > 0 ? 's' : '-')).join('');
const item = (start, width, room) => ({ start, width, room });
const GAP = { gap: 4 };

eq('a label that fits in its block is drawn at full width', fits([item(0, 20, 60), item(70, 30, 80)]), 'FF');
eq('one that does not fit runs on over the blocks after it, when nothing is in the way',
  fits([item(0, 30, 4), item(60, 20, 100)]), 'FF');
eq('one that would reach the next label is squeezed to stop short of it',
  fits([item(0, 30, 4), item(30, 20, 100)], GAP), 'sF');
eq('by exactly as much as it takes', fitLabels([item(0, 30, 4), item(30, 20, 100)], GAP)[0].toFixed(3), (26 / 30).toFixed(3));
eq('and hidden, whole, when even squeezed it would not fit', fits([item(0, 30, 4), item(20, 20, 100)], GAP), '-F');
eq('never squeezed past the limit', LABEL_MIN_SCALE, 0.75);

// The case this rule was tightened for: a block with barely room for its own
// symbol, and a neighbour right after it. It is drawn, at full width.
eq('a label that just fits its block, with a neighbour close behind, is drawn',
  fits([item(6, 26.5, 26), item(39, 20, 60)], GAP), 'FF');
eq('a label a little too wide for its block is squeezed into it, not hidden',
  fits([item(6, 30, 26), item(36, 20, 60)], GAP), 'sF');
eq('a label that fits its own block is drawn whatever came before it',
  fits([item(0, 40, 3), item(10, 30, 3), item(30, 20, 60)], GAP), '--F');

eq('in a run of narrow blocks the first label is drawn and those under it are not',
  fits([item(0, 24, 3), item(10, 24, 3), item(20, 24, 3), item(40, 24, 3), item(50, 24, 3)], GAP), 'F--F-');
eq('a block with no text draws nothing, and is in nobody\'s way', fits([item(0, 30, 4), item(10, 0, 50), item(60, 20, 30)], GAP), 'F-F');
eq('a label is not drawn past the end of the track', [fits([item(90, 30, 5)], { limit: 100 }), fits([item(60, 30, 5)], { limit: 100 })], ['-', 'F']);
eq('at the end of the track it is squeezed before it is dropped', fits([item(75, 30, 5)], { limit: 100 }), 's');
eq('nothing is nothing', fitLabels([]), []);

// However tight the strip: no two drawn labels overlap, none leaves the
// track, none is squeezed past the limit, and one that fits its own block is
// never missing.
{
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let overlaps = 0;
  let tooNarrow = 0;
  let missing = 0;
  let drawnTotal = 0;
  let squeezed = 0;
  for (let round = 0; round < 200; round++) {
    const items = [];
    let at = 0;
    for (let i = 0; i < 60; i++) {
      const block = 2 + Math.floor(rnd() * 50);
      items.push(item(at + 6, rnd() < 0.1 ? 0 : 8 + Math.floor(rnd() * 60), block - 7));
      at += block;
    }
    const scales = fitLabels(items, { gap: 4, limit: at });
    let lastEnd = -Infinity;
    items.forEach((it, i) => {
      if (it.width > 0 && it.width <= it.room && scales[i] !== 1) missing++;
      if (!scales[i]) return;
      drawnTotal++;
      if (scales[i] < 1) squeezed++;
      if (scales[i] < LABEL_MIN_SCALE - 1e-9) tooNarrow++;
      const end = it.start + it.width * scales[i];
      if (it.start < lastEnd - 1e-9 || end > at + 1e-9) overlaps++;
      lastEnd = end;
    });
  }
  check('no two drawn labels ever overlap, and none leaves the track', overlaps === 0, String(overlaps));
  check('none is squeezed past the limit', tooNarrow === 0, String(tooNarrow));
  check('a label with room in its own block is always drawn, at full width', missing === 0, String(missing));
  check('plenty are drawn, some of them squeezed', drawnTotal > 2000 && squeezed > 100, `${drawnTotal} / ${squeezed}`);
}

// ─── Bass notes hidden ────────────────────────────────────

const walking = [
  { start: 0, end: 2, ...C7, bass: null },
  { start: 2, end: 4, ...C7, bass: 4 },
  { start: 4, end: 6, ...C7, bass: 7 },
  { start: 6, end: 8, ...F, bass: null },
];
const hidden = blocks(walking);
eq('the same chord over a moving bass is one block', hidden.map((b) => [b.first, b.last, b.start, b.end]), [[0, 2, 0, 6], [3, 3, 6, 8]]);
eq('shown without its bass note', hidden.map((b) => chordSymbol(b.chord)), ['C7', 'F']);
const shown = blocks(walking, { bass: true });
eq('with bass notes on, each is its own block', shown.map((b) => [b.first, b.last]), [[0, 0], [1, 1], [2, 2], [3, 3]]);
eq('written as slash chords', shown.map((b) => chordSymbol(b.chord, { bass: true })), ['C7', 'C7/E', 'C7/G', 'F']);
eq('the block under the playhead', [1, 5, 7].map((t) => indexAt(hidden, t)), [0, 0, 1]);
eq('no chord is a block too, so the gap can be clicked', blocks(song).map((b) => b.chord.root), [null, 0, 5, 7]);
eq('entries that do not touch are not joined', blocks([{ start: 0, end: 1, ...C }, { start: 2, end: 3, ...C }]).length, 2);

// ─── Change a chord ───────────────────────────────────────

const before = line([4, C7], [8, F], [16, G7]);
const changed = setChord(before, 0, 0, parseSymbol('Cmaj7'));
eq('C7 edited to Cmaj7 reads Cmaj7', symbols(changed), ['Cmaj7', 'F', 'G7']);
eq('nothing else moved', shape(changed), [[0, 4, 0], [4, 8, 5], [8, 16, 7]]);
eq('the list it was given is untouched', symbols(before), ['C7', 'F', 'G7']);
check('the result is one the server takes', isValidTimeline(changed));
eq('changing a chord into its neighbour joins them', shape(setChord(before, 1, 1, C7)), [[0, 8, 0], [8, 16, 7]]);
eq('a block of several entries becomes one chord', shape(setChord(walking, 0, 2, CMAJ7)), [[0, 6, 0], [6, 8, 5]]);
eq('the bass note typed is kept', setChord(before, 0, 0, parseSymbol('C7/E'))[0].bass, 4);
eq('a stretch can be set to no chord', symbols(clearChord(before, 1, 1)), ['C7', '-', 'G7']);
eq('an entry that does not exist changes nothing', [setChord(before, 5, 5, C), setChord(before, 1, 0, C), setChord(before, -1, 0, C)].map((r) => r === before), [true, true, true]);
eq('the detector label does not survive a correction', 'label' in setChord([{ start: 0, end: 4, ...C7, label: 'C:7' }], 0, 0, CMAJ7)[0], false);

// A symbol that cannot be read never reaches the timeline: the strip asks
// parseSymbol first and stops on null.
check('Hx9 cannot be read', parseSymbol('Hx9') === null);

// ─── Move a chord's start ─────────────────────────────────

const moved = moveStart(before, 1, -1, BEATS);
check('one beat earlier moves', moved.moved);
eq('the chord starts on the earlier beat and the one before it ends there', shape(moved.entries), [[0, 3.5, 0], [3.5, 8, 5], [8, 16, 7]]);
eq('one beat later', shape(moveStart(before, 1, 1, BEATS).entries), [[0, 4.5, 0], [4.5, 8, 5], [8, 16, 7]]);
check('the timeline still covers the song', covers(moved.entries, 0, 16) && isValidTimeline(moved.entries));
eq('the list it was given is untouched', shape(before), [[0, 4, 0], [4, 8, 5], [8, 16, 7]]);

const tight = line([0.5, C], [1, F], [16, G7]);
eq('a start cannot move onto the start of the chord before it', moveStart(tight, 1, -1, BEATS).moved, false);
eq('nor past its own end', moveStart(tight, 1, 1, BEATS).moved, false);
eq('a refused move returns the same list', moveStart(tight, 1, -1, BEATS).entries === tight, true);
eq('the first chord cannot start earlier', moveStart(before, 0, -1, BEATS).moved, false);
eq('moved later, no chord is left in front of it', shape(moveStart(before, 0, 1, BEATS).entries), [[0, 0.5, null], [0.5, 4, 0], [4, 8, 5], [8, 16, 7]]);
eq('an entry that does not exist does not move', [moveStart(before, 9, 1, BEATS).moved, moveStart(before, -1, 1, BEATS).moved], [false, false]);
eq('past the last beat there is nowhere to go', moveStart(line([16, C], [17, F]), 1, 1, BEATS).moved, false);

// A grid that drifts: the step is to the next beat, wherever it is.
const DRIFT = [0, 0.48, 0.99, 1.52, 2.0, 2.47];
eq('the next beat of a drifting grid', [stepTime(DRIFT, 0.99, 1), stepTime(DRIFT, 0.99, -1)], [1.52, 0.48]);
eq('from between two beats', [stepTime(DRIFT, 1.2, 1), stepTime(DRIFT, 1.2, -1)], [1.52, 0.99]);
eq('no beat that way', [stepTime(DRIFT, 0, -1), stepTime(DRIFT, 2.47, 1)], [null, null]);

// Without a beat grid the step is half a second.
eq('without a grid a step is half a second', [stepTime([], 4, 1), stepTime(null, 4, -1), stepTime([1], 4, 1)], [4.5, 3.5, 4.5]);
eq('and a start moves by that', shape(moveStart(before, 1, -1, []).entries), [[0, 3.5, 0], [3.5, 8, 5], [8, 16, 7]]);
eq('the step', FREE_STEP_SEC, 0.5);

// ─── Delete a chord ───────────────────────────────────────

const deleted = removeChord(before, 1, 1);
eq('the chord before it lasts until the chord after it', shape(deleted), [[0, 8, 0], [8, 16, 7]]);
check('still covers the song', covers(deleted, 0, 16) && isValidTimeline(deleted));
eq('deleting the last chord stretches the one before to the end', shape(removeChord(before, 2, 2)), [[0, 4, 0], [4, 16, 5]]);
eq('the first chord has nothing before it: it becomes no chord', shape(removeChord(before, 0, 0)), [[0, 4, null], [4, 8, 5], [8, 16, 7]]);
eq('a block of several entries goes at once', shape(removeChord(walking, 0, 2)), [[0, 6, null], [6, 8, 5]]);
eq('deleting between two equal chords joins them', shape(removeChord(line([4, C], [8, F], [16, C]), 1, 1)), [[0, 16, 0]]);
eq('the list it was given is untouched', shape(before), [[0, 4, 0], [4, 8, 5], [8, 16, 7]]);

// ─── Tidy ─────────────────────────────────────────────────

eq('what has no length is dropped and equal neighbours joined', shape(tidy([
  { start: 0, end: 2, ...C }, { start: 2, end: 2, ...F }, { start: 2, end: 4, ...C }, { start: 4, end: 6, ...F },
])), [[0, 4, 0], [4, 6, 5]]);
eq('the same chord over another bass note is kept apart', tidy([{ start: 0, end: 2, ...C7 }, { start: 2, end: 4, ...C7, bass: 4 }]).length, 2);

// ─── What is saved ────────────────────────────────────────

eq('the detector labels are not sent', payload(cleanTimeline(served)), [
  { start: 0, end: 2, root: null, degrees: [], bass: null },
  { start: 2, end: 4, root: 0, degrees: ['1', '3', '5', 'b7'], bass: 4 },
  { start: 4, end: 8, root: 5, degrees: ['1', '3', '5'], bass: null },
]);
check('a served timeline is valid', isValidTimeline(cleanTimeline(served)));
check('out of order is not', !isValidTimeline([{ start: 4, end: 8, ...C }, { start: 0, end: 4, ...F }]));
check('overlapping is not', !isValidTimeline([{ start: 0, end: 5, ...C }, { start: 4, end: 8, ...F }]));
check('a root out of range is not', !isValidTimeline([{ start: 0, end: 4, ...C, root: 12 }]));
check('a degree that does not exist is not', !isValidTimeline([{ start: 0, end: 4, ...C, degrees: ['1', 'h3'] }]));
check('an entry with no length is not', !isValidTimeline([{ start: 4, end: 4, ...C }]));
check('too many entries is not', !isValidTimeline(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ start: i, end: i + 1, ...C }))));
check('an empty timeline is valid', isValidTimeline([]));

// ─── Typed while transposed ───────────────────────────────

// The player is two semitones up: the strip shows D, and the user types the
// chord they hear. What is stored is in the song's own key.
const typed = fromDisplayed(parseSymbol('Dmaj7/F#'), 2);
eq('a chord typed two semitones up is stored two down', typed, { root: 0, degrees: ['1', '3', '5', '7'], bass: 4 });
eq('and is shown again as it was typed', chordSymbol(typed, { key: 'C maj', transpose: 2, bass: true }), 'Dmaj7/F#');
eq('downward too', fromDisplayed(parseSymbol('B'), -1).root, 0);
eq('untransposed it is stored as typed', fromDisplayed(parseSymbol('Am7'), 0), { root: 9, degrees: ['1', 'b3', '5', 'b7'], bass: null });
eq('no chord stays no chord', [fromDisplayed(parseSymbol('N.C.'), 3), fromDisplayed(null, 3)], [NONE, NONE]);

// ─── A run in progress, and how one ends ──────────────────

eq('each step has its sentence', ['mixing', 'loading', 'detecting', 'finishing', 'starting', undefined, 'made-up'].map((phase) => phaseKey({ phase })), [
  'chords.progress.mixing', 'chords.progress.loading', 'chords.progress.detecting', 'chords.progress.finishing',
  'chords.progress.starting', 'chords.progress.starting', 'chords.progress.starting',
]);
eq('no progress yet is starting', phaseKey(null), 'chords.progress.starting');
eq('a reason the page does not know reads as the general failure', [reasonKey('timeout'), reasonKey('nope'), reasonKey(null)], ['chords.reason.timeout', 'chords.reason.worker_failed', 'chords.reason.worker_failed']);

// Every sentence the strip can say exists in English, so no key is ever shown.
const english = TRANSLATIONS.en;
const said = [
  ...REASONS.map((code) => reasonKey(code)),
  ...['starting', 'mixing', 'loading', 'detecting', 'finishing'].map((phase) => phaseKey({ phase })),
];
const missing = said.filter((key) => typeof english[key] !== 'string' || !english[key]);
check('every step and every reason has its English sentence', missing.length === 0, missing.join(', '));

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
