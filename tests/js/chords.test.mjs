// Chord symbols (static/js/harmony/chords.js): writing a stored chord as the
// symbol a musician would write, spelling it for the key and the
// transposition, and reading a typed symbol back.
//
// Scenarios of "Chords are written the way a musician writes them", "Chords
// are spelled for the key being heard" and "The bass note is kept and shown
// on request" in the chord-recognition spec.
//
// Run:  node tests/js/chords.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  chordNotes, chordSuffix, chordSymbol, degreeSemitones, keySpelling, noteName,
  parseKey, parseSymbol, sameChord, sortDegrees, splitDegree,
} from '../../static/js/harmony/chords.js';

const here = dirname(fileURLToPath(import.meta.url));

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

const chord = (root, degrees, bass = null) => ({ root, degrees, bass });
const MAJ = ['1', '3', '5'];
const MIN = ['1', 'b3', '5'];
const DOM7 = ['1', '3', '5', 'b7'];
const MIN7 = ['1', 'b3', '5', 'b7'];
const NO_CHORD = { root: null, degrees: [], bass: null };

// ─── Degrees ──────────────────────────────────────────────

eq('a degree splits into number and alteration', splitDegree('b7'), { number: 7, alter: -1 });
eq('a sharp eleventh', splitDegree('#11'), { number: 11, alter: 1 });
eq('a doubly flat seventh', splitDegree('bb7'), { number: 7, alter: -2 });
check('fourteen is not a degree', splitDegree('14') === null);
check('a word is not a degree', splitDegree('maj') === null);
eq('a ninth is two semitones as a pitch class', degreeSemitones('9'), 2);
eq('a sharp eleventh and a flat fifth are the same key', [degreeSemitones('#11'), degreeSemitones('b5')], [6, 6]);
eq('degrees are kept in one order', sortDegrees(['b7', '5', '1', '#11', '3', '9', '5']), ['1', '3', '5', 'b7', '9', '#11']);

// ─── Common chords ────────────────────────────────────────

eq('C major is the root alone', chordSymbol(chord(0, MAJ)), 'C');
eq('A minor seventh', chordSymbol(chord(9, MIN7)), 'Am7');
eq('G dominant seventh', chordSymbol(chord(7, DOM7)), 'G7');
eq('a minor triad takes an m', chordSymbol(chord(2, MIN)), 'Dm');
eq('a major seventh', chordSymbol(chord(5, ['1', '3', '5', '7'])), 'Fmaj7');
eq('a sixth', chordSymbol(chord(0, ['1', '3', '5', '6'])), 'C6');
eq('a minor sixth', chordSymbol(chord(9, ['1', 'b3', '5', '6'])), 'Am6');
eq('a ninth replaces the seven', chordSymbol(chord(0, [...DOM7, '9'])), 'C9');
eq('a minor eleventh', chordSymbol(chord(2, [...MIN7, '9', '11'])), 'Dm11');
eq('a major thirteenth', chordSymbol(chord(0, ['1', '3', '5', '7', '9', '13'])), 'Cmaj13');
eq('a diminished triad', chordSymbol(chord(11, ['1', 'b3', 'b5'])), 'Bdim');
eq('a diminished seventh', chordSymbol(chord(11, ['1', 'b3', 'b5', 'bb7'])), 'Bdim7');
eq('an augmented triad', chordSymbol(chord(0, ['1', '3', '#5'])), 'C+');
eq('a suspended fourth', chordSymbol(chord(7, ['1', '4', '5'])), 'Gsus4');
eq('a suspended second', chordSymbol(chord(7, ['1', '2', '5'])), 'Gsus2');

// ─── Idioms ───────────────────────────────────────────────

eq('half-diminished is m7b5', chordSymbol(chord(11, ['1', 'b3', 'b5', 'b7'])), 'Bm7b5');
eq('a sixth and a ninth is 6/9', chordSymbol(chord(0, ['1', '3', '5', '6', '9'])), 'C6/9');
eq('a suspended fourth with a flat seventh is 7sus4', chordSymbol(chord(7, ['1', '4', '5', 'b7'])), 'G7sus4');
eq('and with a ninth, 9sus4', chordSymbol(chord(7, ['1', '4', '5', 'b7', '9'])), 'G9sus4');
eq('minor with a major seventh', chordSymbol(chord(2, ['1', 'b3', '5', '7'])), 'Dm(maj7)');
eq('a root and a fifth is a power chord', chordSymbol(chord(4, ['1', '5'])), 'E5');
eq('a minor 6/9', chordSymbol(chord(9, ['1', 'b3', '5', '6', '9'])), 'Am6/9');

// ─── Alterations and additions ────────────────────────────

eq('a flat ninth goes in brackets', chordSymbol(chord(9, [...DOM7, 'b9'])), 'A7(b9)');
eq('two alterations, in order', chordSymbol(chord(7, [...DOM7, '#9', 'b13'])), 'G7(#9,b13)');
eq('a sharp eleventh on a major seventh', chordSymbol(chord(5, ['1', '3', '5', '7', '#11'])), 'Fmaj7(#11)');
eq('a ninth on a triad is added', chordSymbol(chord(0, [...MAJ, '9'])), 'C(add9)');
eq('a flat fifth on a dominant', chordSymbol(chord(0, ['1', '3', 'b5', 'b7'])), 'C7(b5)');
eq('a sharp fifth on a dominant', chordSymbol(chord(0, ['1', '3', '#5', 'b7'])), 'C7(#5)');
eq('a flat fifth beside a fifth is a sharp eleventh', chordSymbol(chord(0, ['1', '3', 'b5', '5', 'b7'])), 'C7(#11)');
eq('a flat second is written as a flat ninth', chordSymbol(chord(0, ['1', 'b2', '3', '5', 'b7'])), 'C7(b9)');
eq('a sixth under a seventh is a thirteenth', chordSymbol(chord(0, ['1', '3', '5', '6', 'b7'])), 'C7(13)');
eq('a tone that was left out is not written', chordSymbol(chord(0, ['1', '3'])), 'C');
eq('a missing third is said when nothing stands in for it', chordSymbol(chord(0, ['1', '5', 'b7'])), 'C7(no3)');
eq('a second stays a suspension under a seventh', chordSymbol(chord(0, ['1', '2', '5', 'b7'])), 'C7sus2');
eq('a bare root says so', chordSymbol(chord(0, ['1'])), 'C(bass)');
eq('a fifth with a ninth added', chordSymbol(chord(0, ['1', '5', '9'])), 'C5(add9)');
eq('a sixth with a suspended second', chordSymbol(chord(0, ['1', '2', '5', '6'])), 'C6sus2');
eq('both sevenths at once', chordSymbol(chord(0, ['1', '3', '5', 'b7', '7'])), 'C7(maj7)');
eq('a rootless voicing is still its chord', chordSymbol(chord(0, ['3', '5'])), 'C');
eq('the suffix alone', chordSuffix(MIN7), 'm7');

// ─── No chord ─────────────────────────────────────────────

eq('no chord has no symbol', chordSymbol(NO_CHORD), '');
eq('nor does nothing at all', [chordSymbol(null), chordSymbol(undefined), chordSymbol({})], ['', '', '']);
eq('a root out of range is no chord', chordSymbol(chord(12, MAJ)), '');

// ─── Spelling for the key ─────────────────────────────────

eq('a key is read from how analysis stores it', parseKey('F# min'), { tonic: 6, minor: true });
eq('a major key', parseKey('D maj'), { tonic: 2, minor: false });
eq('a flat key', parseKey('Bb maj'), { tonic: 10, minor: false });
check('no key', parseKey('') === null && parseKey(null) === null);

eq('E major spells the chord between G and A as G sharp', chordSymbol(chord(8, MIN), { key: 'E maj' }), 'G#m');
eq('F minor spells it as A flat', chordSymbol(chord(8, MAJ), { key: 'F min' }), 'Ab');
eq('sharp keys', ['G maj', 'D maj', 'A maj', 'E maj', 'B maj', 'F# maj', 'E min', 'B min', 'F# min', 'C# min', 'G# min', 'D# min'].map((k) => keySpelling(k)), Array(12).fill('sharp'));
eq('flat keys', ['F maj', 'A# maj', 'D# maj', 'G# maj', 'C# maj', 'D min', 'G min', 'C min', 'F min', 'A# min'].map((k) => keySpelling(k)), Array(10).fill('flat'));
eq('C major and A minor have none of their own', [keySpelling('C maj'), keySpelling('A min')], ['mixed', 'mixed']);
eq('no key spells the black keys the way charts mostly do', [1, 3, 6, 8, 10].map((pc) => noteName(pc)), ['C#', 'Eb', 'F#', 'Ab', 'Bb']);
eq('analysis writes B flat major as A sharp: it is still a flat key', chordSymbol(chord(3, MAJ), { key: 'A# maj' }), 'Eb');
eq('the spelling can be forced', [noteName(6, { spelling: 'flat' }), noteName(6, { spelling: 'sharp' })], ['Gb', 'F#']);

// ─── Transposition ────────────────────────────────────────

const inC = [chord(0, MAJ), chord(5, MAJ), chord(7, DOM7)];
eq('C F G7 in C major', inC.map((c) => chordSymbol(c, { key: 'C maj' })), ['C', 'F', 'G7']);
eq('up two semitones it reads D G A7', inC.map((c) => chordSymbol(c, { key: 'C maj', transpose: 2 })), ['D', 'G', 'A7']);
eq('down one it is in B, with sharps', chordSymbol(chord(5, MAJ), { key: 'C maj', transpose: -1 }), 'E');
eq('up one from C the key is D flat', chordSymbol(chord(5, MAJ), { key: 'C maj', transpose: 1 }), 'Gb');
eq('and E major up one is F: flats', chordSymbol(chord(8, MIN), { key: 'E maj', transpose: 1 }), 'Am');
eq('the bass note moves with the chord', chordSymbol(chord(0, DOM7, 4), { key: 'C maj', transpose: 2, bass: true }), 'D7/F#');
eq('a whole octave is no move', chordSymbol(chord(0, MAJ), { transpose: 12 }), 'C');
eq('the stored chord is not changed', (() => { const c = chord(0, DOM7, 4); chordSymbol(c, { transpose: 5, bass: true }); return c; })(), chord(0, DOM7, 4));

// ─── The bass note ────────────────────────────────────────

const c7OverE = chord(0, DOM7, 4);
eq('the bass note is left out by default', chordSymbol(c7OverE), 'C7');
eq('and shown as a slash chord when asked', chordSymbol(c7OverE, { bass: true }), 'C7/E');
eq('a bass note that is the root is no slash chord', chordSymbol(chord(0, DOM7, 0), { bass: true }), 'C7');
eq('the bass note is spelled for the key', chordSymbol(chord(5, MAJ, 10), { key: 'F maj', bass: true }), 'F/Bb');
check('the same chord over another bass note is the same chord with bass notes off', sameChord(c7OverE, chord(0, DOM7, 7), { bass: false }));
check('and a different one with them on', !sameChord(c7OverE, chord(0, DOM7, 7)));
check('the same chord is the same', sameChord(c7OverE, { ...c7OverE, start: 3 }));
check('another quality is another chord', !sameChord(chord(0, MAJ), chord(0, MIN), { bass: false }));
check('another root is another chord', !sameChord(chord(0, MAJ), chord(2, MAJ)));
check('no chord is the same as no chord', sameChord(NO_CHORD, { root: null }));
check('no chord is not a chord', !sameChord(NO_CHORD, chord(0, MAJ)));
check('degrees in another order are the same chord', sameChord(chord(0, ['5', '1', '3']), chord(0, MAJ)));

// ─── The notes of a chord ─────────────────────────────────

eq('C7 is C E G B flat', chordNotes(chord(0, DOM7)), [0, 4, 7, 10]);
eq('a ninth folds into the octave', chordNotes(chord(0, [...DOM7, '9'])), [0, 4, 7, 10, 2]);
eq('the bass note first when asked', chordNotes(c7OverE, { bass: true }), [4, 0, 7, 10]);
eq('moved by the transposition', chordNotes(chord(0, MAJ), { transpose: 2 }), [2, 6, 9]);
eq('no chord has no notes', chordNotes(NO_CHORD), []);
eq('a rootless voicing sounds over its root', chordNotes(chord(0, ['3', '5'])), [0, 4, 7]);

// ─── Reading a typed symbol ───────────────────────────────

const reads = (text) => parseSymbol(text);
eq('C', reads('C'), chord(0, MAJ));
eq('Cmaj7', reads('Cmaj7'), chord(0, ['1', '3', '5', '7']));
eq('Am7', reads('Am7'), chord(9, MIN7));
eq('Bb7', reads('Bb7'), chord(10, DOM7));
eq('F#m', reads('F#m'), chord(6, MIN));
eq('C7/E', reads('C7/E'), chord(0, DOM7, 4));
eq('a bass note that is the root is dropped', reads('C/C'), chord(0, MAJ));
eq('Bm7b5', reads('Bm7b5'), chord(11, ['1', 'b3', 'b5', 'b7']));
eq('C6/9 is not a slash chord', reads('C6/9'), chord(0, ['1', '3', '5', '6', '9']));
eq('G7sus4', reads('G7sus4'), chord(7, ['1', '4', '5', 'b7']));
eq('Gsus is sus4', reads('Gsus'), chord(7, ['1', '4', '5']));
eq('A7(b9)', reads('A7(b9)'), chord(9, [...DOM7, 'b9']));
eq('E5', reads('E5'), chord(4, ['1', '5']));
eq('Bb5 is a power chord on B flat', reads('Bb5'), chord(10, ['1', '5']));
eq('C13 leaves the eleventh out', reads('C13'), chord(0, ['1', '3', '5', 'b7', '9', '13']));
eq('Cm13 keeps it', reads('Cm13'), chord(0, ['1', 'b3', '5', 'b7', '9', '11', '13']));
eq('C(bass)', reads('C(bass)'), chord(0, ['1']));
eq('C7(no3)', reads('C7(no3)'), chord(0, ['1', '5', 'b7']));
eq('C7(maj7) keeps both sevenths', reads('C7(maj7)'), chord(0, ['1', '3', '5', 'b7', '7']));
eq('C5(add9)', reads('C5(add9)'), chord(0, ['1', '5', '9']));
eq('Dm(maj7)', reads('Dm(maj7)'), chord(2, ['1', 'b3', '5', '7']));
eq('C+', reads('C+'), chord(0, ['1', '3', '#5']));
eq('Cdim7', reads('Cdim7'), chord(0, ['1', 'b3', 'b5', 'bb7']));

// The same chord, the other ways people write it.
const SAME = {
  Cm7: ['C-7', 'Cmin7', 'Cmi7', 'C m7', 'Cm 7'],
  Cmaj7: ['CM7', 'CΔ', 'CΔ7', 'Cma7', 'CMaj7', 'C△7'],
  Cm7b5: ['Cø', 'Cø7', 'Cm7(b5)', 'C-7b5', 'Cmin7b5', 'Cm7-5'],
  Cdim7: ['C°7', 'Co7'],
  Cdim: ['C°', 'Co'],
  'C+': ['Caug'],
  'C7(b9)': ['C7b9', 'C7-9', 'C7(♭9)'],
  'C7(#9)': ['C7#9', 'C7+9', 'C7(♯9)'],
  'C7(#5)': ['C+7', 'Caug7', 'C7#5', 'C7+5'],
  'C7(b9,#11)': ['C7b9#11', 'C7(b9)(#11)'],
  'C6/9': ['C69', 'C6(9)'],
  'Cm6/9': ['Cm69', 'C-6/9'],
  'Cm(maj7)': ['CmM7', 'Cmmaj7', 'CminMaj7', 'C-maj7'],
  'C(add9)': ['Cadd9'],
  Csus4: ['Csus', 'C(sus4)'],
  C: ['Cmaj', 'CM', 'C '],
  Bb: ['B♭'],
  'F#m': ['F♯m', 'F#min', 'F#-'],
  'Cmaj9': ['CΔ9', 'CM9'],
  'C7/Bb': ['C7/B♭'],
};
for (const [canonical, others] of Object.entries(SAME)) {
  const want = reads(canonical);
  check(`${canonical} is readable`, want !== null);
  for (const other of others) {
    eq(`${other} reads as ${canonical}`, reads(other), want);
  }
}

eq('N.C. is no chord', reads('N.C.'), NO_CHORD);
eq('so are its relatives', ['NC', 'n.c.', 'N.C', 'none', 'no chord', '-'].map((s) => reads(s)), Array(6).fill(NO_CHORD));

// The spec's own example, and its kin: refused, never guessed.
for (const bad of ['Hx9', '', '   ', 'c7', 'C7alt', 'Cfoo', 'C7(', 'C7(b99)', '7', 'Cm7/H', 'C(add)', null, undefined]) {
  check(`"${bad}" cannot be read`, reads(bad) === null, JSON.stringify(reads(bad)));
}

// ─── Every chord of the vocabulary ────────────────────────

// The 380 chords the detector can report, each with the symbol it gets. The
// table was generated once from tests/fixtures/chords/full_chord_list.txt and
// read through by hand; this pins it. tests/test_chord_labels.py checks the
// stored chords in it against the Python reader.
const FIXTURE = JSON.parse(readFileSync(join(here, 'fixtures', 'chord-symbols.json'), 'utf8'));
check('the table holds the whole vocabulary', FIXTURE.length === 380, String(FIXTURE.length));

let wrong = [];
let empty = [];
for (const row of FIXTURE) {
  const c = chord(row.root, row.degrees, row.bass);
  const symbol = chordSymbol(c);
  const slash = chordSymbol(c, { bass: true });
  if (symbol !== row.symbol || slash !== row.slash) wrong.push(`${row.label}: ${symbol} / ${slash}`);
  if (!symbol || /undefined|null|NaN|\(\)|,,|\(,|,\)/.test(slash)) empty.push(row.label);
  if (row.bass === null ? slash !== symbol : !slash.startsWith(`${symbol}/`)) empty.push(`${row.label} (slash)`);
}
check('every chord renders to its reviewed symbol', wrong.length === 0, wrong.slice(0, 5).join('; '));
check('no symbol is empty or malformed', empty.length === 0, empty.slice(0, 5).join('; '));

// On every root, in a sharp and a flat key: still a symbol, and the suffix is
// the same whatever the root.
let rootTrouble = [];
for (const row of FIXTURE) {
  for (let step = 0; step < 12; step++) {
    for (const key of ['E maj', 'F min']) {
      const symbol = chordSymbol(chord(row.root, row.degrees, row.bass), { key, transpose: step });
      const root = noteName(row.root + step, { key, transpose: step });
      if (symbol !== root + row.symbol.slice(1)) rootTrouble.push(`${row.label}+${step} in ${key}: ${symbol}`);
    }
  }
}
check('the suffix does not depend on the root or the key', rootTrouble.length === 0, rootTrouble.slice(0, 3).join('; '));

// ─── There and back ───────────────────────────────────────

// A symbol the writer makes reads back as the chord it was made from, for
// every chord type of the vocabulary that leaves no tone out ("*" in its
// label). The types below are one-way on purpose: the symbol is what a
// musician writes, and it does not say everything the label did.
const ONE_WAY = {
  // A thirteenth is written C13 whether or not the label had the eleventh,
  // and read back without it: over a major third it is not played.
  'a thirteenth over an eleventh': ['13', 'maj13', '9(11,13)', '11(13)', '13(#11)'],
  // A bare list with no fifth of any kind. A fifth that is left out is not
  // written, so the symbol reads back with one.
  'a list with no fifth': [
    '(b7)', '(b3,b7)', '(1,4)', '(3)', '(6)', '(3,7)', '(13)', '(1,4,b7)', '(b3)', '(7)',
    '(4,b7,9)', '(1,b7)', '(1,b3,4)', '(1,b3)', '(1,2,4)', '(b3,b7,11,9)', '(1,2,#4,6)',
  ],
  // A tone written under the name a chart gives it: a fourth beside a third
  // as an eleventh, a sixth under a seventh as a thirteenth, a second as a
  // ninth, a flat second as a flat ninth, a sharp fourth as a sharp eleventh,
  // an eleventh with no third as a suspended fourth, a sixth on a diminished
  // triad as the diminished seventh.
  'a tone under its other name': [
    'min7(4)', '7(4)', '7(4,b5)', '7(4,#9)', 'maj6(b7)', 'maj6(7)', 'maj6(7,#11)',
    'maj6(b7,11)', 'min6(7)', 'min6(b7)', 'sus2(6,b7)', '7(b2)', 'maj6(b2)', 'maj6(2)',
    'maj7(2)', 'min7(2)', 'maj(#4)', '(1,b3,b5,6)', '(b5,11)', '(11)', '(11,9)',
  ],
};
const oneWay = new Set(Object.values(ONE_WAY).flat());
const typeOf = (label) => label.slice(2).split('/')[0];

let notBack = [];
let wronglyListed = new Set(oneWay);
let checkedTypes = new Set();
for (const row of FIXTURE) {
  const type = typeOf(row.label);
  if (type.includes('*')) continue;
  const original = chord(row.root, row.degrees, row.bass);
  const back = parseSymbol(row.slash);
  const same = back !== null && sameChord(back, original);
  if (oneWay.has(type)) {
    if (!same) wronglyListed.delete(type);
    continue;
  }
  checkedTypes.add(type);
  if (!same) notBack.push(`${row.label} -> ${row.slash} -> ${JSON.stringify(back)}`);
}
check('every other symbol reads back as its chord', notBack.length === 0, notBack.slice(0, 5).join('; '));
check('every type listed as one-way is one-way', wronglyListed.size === 0, [...wronglyListed].join(', '));
check('most of the vocabulary goes both ways', checkedTypes.size >= 100, String(checkedTypes.size));

// Every symbol of the table can at least be read, one-way or not: it is what
// the correction field shows the user to edit.
const unreadable = FIXTURE.filter((row) => parseSymbol(row.slash) === null).map((row) => row.slash);
check('every symbol the strip shows can be typed back in', unreadable.length === 0, unreadable.slice(0, 5).join('; '));

// And reading then writing a symbol settles: the second writing is the first.
const unsettled = FIXTURE.filter((row) => {
  const once = parseSymbol(row.slash);
  return chordSymbol(once, { bass: true }) !== row.slash;
}).map((row) => `${row.label}: ${row.slash} -> ${chordSymbol(parseSymbol(row.slash), { bass: true })}`);
check('writing what was read gives the same symbol', unsettled.length === 0, unsettled.slice(0, 5).join('; '));

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
