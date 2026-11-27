// Chord symbols: writing them, reading them, spelling them.
//
// StemDeck stores a chord as facts, not as text (app/core/chord_model.py):
//
//   { root: 0, degrees: ["1", "3", "5", "b7"], bass: 4 }
//
// `root` and `bass` are pitch classes (0 is C). `degrees` are the chord tones
// as scale-degree names above the root. `root: null` is "no chord". This
// module turns that into the symbol a musician would write ("C7/E"), and a
// typed symbol back into those facts.
//
// It is done here, in the page, and not on the server, because the same chord
// is written differently depending on things only the page knows: the song's
// key (G sharp or A flat), how far the player has transposed it, and whether
// bass notes are shown.
//
// Pure functions: no DOM, no i18n, no state. The chord strip uses it
// (chords/chordStrip.js); the jazz chart and the keyboard view are meant to
// use the same module, so a chord reads the same everywhere in the app.
//
// How a symbol is built from the degrees, in `chordSuffix`:
//
//   1. the third and the fifth give the quality: nothing, m, dim, sus4, sus2
//   2. a seventh or a sixth gives the figure: 7, maj7, 6, dim7
//   3. a ninth, eleventh or thirteenth on top of a seventh replaces the 7:
//      9, m11, maj13
//   4. what is left goes in brackets: 7(b9), 7(#9,b13), (add9), 7(no3)
//   5. a tone that was left out is not written, except a missing third when
//      nothing stands in for it
//   6. a few shapes have a spelling of their own: m7b5, 6/9, 7sus4, m(maj7),
//      5, +
//
// Accidentals are the letters b and #, which every font has.

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
// For a song with no known key, and for the keys with no sharps or flats of
// their own (C major, A minor): the names chord charts use most.
const MIXED_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Major keys written with sharps, by tonic: G, D, A, E, B, F sharp.
const SHARP_MAJOR_TONICS = new Set([7, 2, 9, 4, 11, 6]);
// Major keys written with flats: F, B flat, E flat, A flat, D flat.
const FLAT_MAJOR_TONICS = new Set([5, 10, 3, 8, 1]);

const NATURAL_SEMITONES = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11, 8: 12, 9: 14, 10: 16, 11: 17, 12: 19, 13: 21 };
const DEGREE_RE = /^(b{0,2}|#{0,2})(1[0-3]|[1-9])$/;

const mod12 = (n) => ((Math.round(n) % 12) + 12) % 12;

// ─── Degrees ──────────────────────────────────────────────

/** "b7" as { number: 7, alter: -1 }, or null when it is not a degree. */
export function splitDegree(name) {
  const m = typeof name === "string" ? DEGREE_RE.exec(name) : null;
  if (!m) return null;
  const alter = m[1].startsWith("#") ? m[1].length : -m[1].length;
  return { number: Number(m[2]), alter };
}

/** Semitones above the root, as a pitch class: a ninth is 2. */
export function degreeSemitones(name) {
  const d = splitDegree(name);
  return d ? mod12(NATURAL_SEMITONES[d.number] + d.alter) : null;
}

function degreeName(number, alter) {
  return (alter > 0 ? "#".repeat(alter) : "b".repeat(-alter)) + number;
}

/** The degrees once each, in stored order: by number, flats first. */
export function sortDegrees(names) {
  const seen = new Map();
  for (const name of names || []) {
    const d = splitDegree(name);
    if (d) seen.set(d.number * 10 + d.alter, degreeName(d.number, d.alter));
  }
  return [...seen.keys()].sort((a, b) => a - b).map((k) => seen.get(k));
}

// ─── Keys and note names ──────────────────────────────────

/**
 * A key as analysis stores it ("F# min", "D maj", "Bb") as
 * { tonic: pitch class, minor: boolean }, or null.
 */
export function parseKey(key) {
  const m = /^\s*([A-Ga-g])([#b♯♭]*)\s*(.*)$/.exec(String(key ?? ""));
  if (!m) return null;
  let tonic = LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) tonic += ch === "#" || ch === "♯" ? 1 : -1;
  const mode = m[3].trim().toLowerCase();
  const minor = mode.startsWith("min") || mode === "m";
  return { tonic: mod12(tonic), minor };
}

/**
 * Which accidentals a key is written with: "sharp", "flat" or "mixed" (a key
 * with none of its own, or no key at all). `transpose` moves the key by that
 * many semitones first, the way the player's pitch control does.
 */
export function keySpelling(key, transpose = 0) {
  const parsed = typeof key === "object" && key ? key : parseKey(key);
  if (!parsed) return "mixed";
  // A minor key is spelled like the major key three semitones up.
  const major = mod12(parsed.tonic + (Number(transpose) || 0) + (parsed.minor ? 3 : 0));
  if (SHARP_MAJOR_TONICS.has(major)) return "sharp";
  if (FLAT_MAJOR_TONICS.has(major)) return "flat";
  return "mixed";
}

/**
 * The name of a pitch class. `opts.key` and `opts.transpose` choose between
 * sharps and flats; `opts.spelling` ("sharp" | "flat" | "mixed") overrides
 * them. The pitch class is not moved: transpose the chord first.
 */
export function noteName(pitchClass, opts = {}) {
  const spelling = opts.spelling || keySpelling(opts.key, opts.transpose);
  const names = spelling === "sharp" ? SHARP_NAMES : spelling === "flat" ? FLAT_NAMES : MIXED_NAMES;
  return names[mod12(pitchClass)];
}

// ─── Writing a symbol ─────────────────────────────────────

function isChord(chord) {
  return Boolean(chord) && Number.isInteger(chord.root) && chord.root >= 0 && chord.root <= 11;
}

/**
 * Everything after the root: "m7", "7(b9)", "sus4", "" for a major triad.
 * `degrees` is a list of degree names; the root is implied.
 */
export function chordSuffix(degrees) {
  const have = new Set(sortDegrees(degrees));
  have.add("1");
  const used = new Set(["1"]);
  const take = (name) => {
    if (!have.has(name)) return false;
    used.add(name);
    return true;
  };

  if (have.size === 1) return "(bass)";

  const seventh = have.has("b7") || have.has("7") || have.has("bb7");
  // The same tone under its other name. Always: an altered second or fourth
  // is written as an altered ninth or eleventh. Under a seventh, the plain
  // second, fourth, sixth and flat sixth are extensions too.
  const rename = (from, to) => {
    if (have.has(from) && !have.has(to)) {
      have.delete(from);
      have.add(to);
    } else if (have.has(from)) {
      have.delete(from);
    }
  };
  rename("b2", "b9");
  rename("#2", "#9");
  rename("#4", "#11");
  const third = have.has("3") ? "3" : have.has("b3") ? "b3" : null;
  // With no third, an eleventh is a suspended fourth an octave up.
  if (!third) rename("11", "4");
  if (seventh) {
    rename("6", "13");
    rename("b6", "b13");
    if (third) rename("4", "11");
    // A second stays a suspension when it is the only thing standing in for
    // the third: C7sus2, not C9(no3).
    if (third || have.has("4")) rename("2", "9");
  }
  // A flat fifth beside a real fifth is a sharp eleventh, and a sharp fifth
  // beside one is a flat thirteenth.
  if (have.has("5")) {
    rename("b5", "#11");
    rename("#5", "b13");
  }

  let quality = "";
  let figure = "";
  const items = [];
  let diminished = false;

  // 1. Quality, from the third and the fifth.
  if (third === "b3" && have.has("b5") && !have.has("7")) {
    take("b3");
    take("b5");
    diminished = true;
    if (take("bb7")) {
      quality = "dim7";
    } else if (have.has("6") && !seventh) {
      // A sixth on a diminished triad is the diminished seventh by its
      // other name.
      take("6");
      quality = "dim7";
    } else if (have.has("b7")) {
      take("b7");
      quality = "m";
      figure = "7b5";
    } else {
      quality = "dim";
    }
  } else if (third === "b3") {
    take("b3");
    quality = "m";
  } else if (third === "3") {
    take("3");
    if (have.has("#5") && !seventh && !have.has("6")) {
      take("#5");
      quality = "+";
    }
  }

  // 2 and 3. The figure: a seventh, with the extensions stacked on it.
  const half = figure === "7b5";
  if (!diminished || half) {
    const dominant = half ? true : take("b7");
    const major = !dominant && take("7");
    if (dominant || major) {
      let top = half ? null : "7";
      if (have.has("9")) {
        top = "9";
        if (have.has("13")) top = "13";
        else if (have.has("11")) top = "11";
      }
      if (top === "13") { take("9"); take("11"); take("13"); }
      if (top === "11") { take("9"); take("11"); }
      if (top === "9") take("9");
      if (half) {
        if (top) figure = `${top}b5`;
      } else if (major && quality === "m") {
        // Minor with a major seventh: the figure goes in brackets.
        items.push(`maj${top}`);
      } else {
        figure = (major ? "maj" : "") + top;
      }
      // Both sevenths at once: the dominant gives the figure.
      if (dominant && have.has("7")) { take("7"); items.push("maj7"); }
    } else if (take("6")) {
      figure = "6";
      // A second beside a third is the ninth of a 6/9. With no third it is
      // the suspension, and stays one: C6sus2.
      if (take("9") || (third && take("2"))) figure = "6/9";
    }
  }

  // The suspension, when there is no third.
  let sus = "";
  if (!third) {
    if (take("4")) sus = "sus4";
    else if (take("2")) sus = "sus2";
  }

  // 4. What is left, in order.
  const additions = [];
  for (const name of sortDegrees([...have])) {
    if (used.has(name)) continue;
    if (name === "5") continue;
    const d = splitDegree(name);
    const plain = d.alter === 0;
    // Under a seventh a plain extension is named by its number alone; on a
    // triad it is an added note.
    additions.push(plain && !(dominantOrMajor(figure, items)) ? `add${name}` : name);
  }
  items.push(...additions);

  // 5. A missing third is said when nothing stands in for it.
  const powerChord = !third && !sus && !figure && items.length === 0 && have.has("5");
  if (powerChord) return "5";
  if (!third && !sus && !diminished) {
    const fifthAltered = have.has("b5") || have.has("#5");
    if (!figure && !fifthAltered && items.every((item) => item.startsWith("add") || /^[b#]/.test(item))) {
      // A fifth with something added: C5(add9). A fifth that was left out is
      // not written, so the same goes for a root with something added.
      quality = "5";
    } else {
      items.push("no3");
    }
  }

  const brackets = items.length ? `(${items.join(",")})` : "";
  return `${quality}${figure}${sus}${brackets}`;
}

function dominantOrMajor(figure, items) {
  // A figure that holds a seventh (7, maj9, 13, 7b5), or the bracketed
  // major seventh of a minor chord.
  return /7|9|11|13/.test(figure.replace("6/9", "")) || items.some((item) => /^maj\d/.test(item));
}

/**
 * The symbol for a stored chord, or "" for "no chord".
 *
 *   key        the song's key as stored ("F# min"), for sharps or flats
 *   transpose  semitones the player has moved the song by
 *   bass       show the bass note as a slash chord (off by default)
 *   spelling   "sharp" | "flat" | "mixed", instead of deriving it from the key
 */
export function chordSymbol(chord, opts = {}) {
  if (!isChord(chord)) return "";
  const transpose = Number(opts.transpose) || 0;
  const spelling = opts.spelling || keySpelling(opts.key, transpose);
  const root = noteName(chord.root + transpose, { spelling });
  let text = root + chordSuffix(chord.degrees);
  if (opts.bass && Number.isInteger(chord.bass) && mod12(chord.bass) !== mod12(chord.root)) {
    text += `/${noteName(chord.bass + transpose, { spelling })}`;
  }
  return text;
}

// ─── Reading a symbol ─────────────────────────────────────

const FIGURES = {
  "6": ["6"],
  "7": ["b7"],
  "9": ["b7", "9"],
  "11": ["b7", "9", "11"],
  "13": ["b7", "9", "13"],
};

function readNote(text) {
  const m = /^([A-Ga-g])([#b]*)/.exec(text);
  if (!m) return null;
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) pc += ch === "#" ? 1 : -1;
  return { pc: mod12(pc), length: m[0].length };
}

function applyItem(tones, raw) {
  const item = raw.trim();
  if (!item) return true;
  let m;
  if (item === "bass") {
    tones.clear();
    tones.add("1");
    return true;
  }
  if ((m = /^(?:no|omit)(\d+)$/.exec(item))) {
    for (const name of [...tones]) {
      if (splitDegree(name)?.number === Number(m[1])) tones.delete(name);
    }
    return true;
  }
  if ((m = /^sus(2|4)?$/.exec(item))) {
    tones.delete("3");
    tones.delete("b3");
    // The fourth an octave up is the same suspension.
    if (m[1] !== "2") tones.delete("11");
    tones.add(m[1] === "2" ? "2" : "4");
    return true;
  }
  if ((m = /^maj(7|9|11|13)$/.exec(item))) {
    // In brackets it adds the major seventh: Cm(maj7), and C7(maj7) for the
    // rare chord with both sevenths.
    tones.add("7");
    for (const name of FIGURES[m[1]]) if (name !== "b7") tones.add(name);
    return true;
  }
  if ((m = /^add([b#]*\d+)$/.exec(item))) {
    if (!splitDegree(m[1])) return false;
    tones.add(m[1]);
    return true;
  }
  const d = splitDegree(item);
  if (!d) return false;
  // An altered fifth replaces the fifth.
  if (d.number === 5 && d.alter !== 0) tones.delete("5");
  tones.add(item);
  return true;
}

/**
 * A typed chord symbol as { root, degrees, bass }, { root: null, degrees: [],
 * bass: null } for "N.C." and its relatives, or null when it cannot be read.
 *
 * Reads what `chordSymbol` writes, and the usual other spellings: Cm7, C-7,
 * Cmin7, CM7, Cmaj7, CΔ, Cø, C°7, C+, C7b9, C7(b9), C7-9, C6/9, C69, Csus,
 * C/E, with flats and sharps as letters or as signs.
 */
export function parseSymbol(text) {
  let s = String(text ?? "").trim();
  if (!s) return null;
  if (/^(n\.?\s?c\.?|none|no chord|-|—)$/i.test(s)) return { root: null, degrees: [], bass: null };
  s = s.replace(/♭/g, "b").replace(/♯/g, "#").replace(/\s+/g, "");

  const rootNote = readNote(s);
  if (!rootNote || s[0] !== s[0].toUpperCase()) return null;
  let rest = s.slice(rootNote.length);

  // A slash before a note name is the bass. "6/9" is not.
  let bass = null;
  const slash = /\/([A-G][#b]*)$/.exec(rest);
  if (slash) {
    bass = readNote(slash[1]).pc;
    rest = rest.slice(0, slash.index);
  }

  rest = rest
    .replace(/Δ|△/g, "maj7")
    .replace(/maj7(?=7|9|11|13)/, "maj")
    .replace(/ø7?/g, "m7b5")
    .replace(/°|º/g, "dim")
    .replace(/^6\/9|^69/, "6(9)")
    .replace(/^(m|min|mi|-)6\/9|^(m|min|mi|-)69/, "m6(9)");

  const tones = new Set(["1", "3", "5"]);
  let m;

  // Quality.
  if ((m = /^(dim|o)(?![a-z])/.exec(rest))) {
    tones.delete("3"); tones.delete("5");
    tones.add("b3"); tones.add("b5");
    rest = rest.slice(m[0].length);
    if (rest.startsWith("7")) { tones.add("bb7"); rest = rest.slice(1); }
  } else if ((m = /^(aug|\+)/.exec(rest))) {
    tones.delete("5"); tones.add("#5");
    rest = rest.slice(m[0].length);
  } else if ((m = /^(min|mi(?!n)|m(?!aj|a)|-)/.exec(rest))) {
    tones.delete("3"); tones.add("b3");
    rest = rest.slice(m[0].length);
  }

  // Figure: an optional "maj" (or M) and a number.
  if ((m = /^(maj|Maj|MAJ|ma|M)?(13|11|9|7|6)(?!\d)/.exec(rest))) {
    const major = Boolean(m[1]);
    for (const name of FIGURES[m[2]]) tones.add(name === "b7" && major ? "7" : name);
    // A minor thirteenth keeps its eleventh; over a major third it is left out.
    if (m[2] === "13" && tones.has("b3")) tones.add("11");
    rest = rest.slice(m[0].length);
  } else if ((m = /^(maj|Maj|MAJ|M)(?![a-z0-9])/.exec(rest))) {
    // "Cmaj" and "CM" alone are the major triad.
    rest = rest.slice(m[0].length);
  } else if ((m = /^5(?!\d)/.exec(rest)) && tones.has("3") && tones.has("5")) {
    // A power chord: the root and its fifth.
    tones.delete("3");
    rest = rest.slice(m[0].length);
  }

  // What follows: bare items and bracketed lists, in any order.
  while (rest) {
    if ((m = /^\(([^()]*)\)/.exec(rest))) {
      for (const item of m[1].split(",")) {
        if (!applyItem(tones, item)) return null;
      }
      rest = rest.slice(m[0].length);
      continue;
    }
    m = /^(sus[24]?|add[b#]*\d+|(?:no|omit)\d+|maj(?:7|9|11|13)|[b#]+(?:1[0-3]|[1-9])|[-+](?:1[0-3]|[1-9]))/.exec(rest);
    if (!m) return null;
    // "C7-9" and "C7+9": a minus is a flat and a plus is a sharp.
    const item = m[0].replace(/^-/, "b").replace(/^\+/, "#");
    if (!applyItem(tones, item)) return null;
    rest = rest.slice(m[0].length);
  }

  const degrees = sortDegrees([...tones]);
  return {
    root: rootNote.pc,
    degrees: degrees.length ? degrees : ["1"],
    bass: bass === null || bass === rootNote.pc ? null : bass,
  };
}

// ─── Other readings of a chord ────────────────────────────

/**
 * The chord's notes as pitch classes, root first, then upward by degree, each
 * once. `opts.transpose` moves them; `opts.bass` puts the bass note first.
 * Empty for "no chord".
 */
export function chordNotes(chord, opts = {}) {
  if (!isChord(chord)) return [];
  const transpose = Number(opts.transpose) || 0;
  const out = [];
  const push = (pc) => {
    const n = mod12(pc + transpose);
    if (!out.includes(n)) out.push(n);
  };
  if (opts.bass && Number.isInteger(chord.bass)) push(chord.bass);
  for (const name of sortDegrees(["1", ...(chord.degrees || [])])) {
    // A rootless voicing still sounds over its root for this purpose.
    push(chord.root + degreeSemitones(name));
  }
  return out;
}

/**
 * Whether two entries are the same chord. With `opts.bass` false the bass
 * note is ignored, which is what "bass notes hidden" joins neighbours by.
 * Two "no chord" entries are the same.
 */
export function sameChord(a, b, opts = {}) {
  const rootA = isChord(a) ? a.root : null;
  const rootB = isChord(b) ? b.root : null;
  if (rootA !== rootB) return false;
  if (rootA === null) return true;
  const withBass = opts.bass !== false;
  if (withBass && (a.bass ?? null) !== (b.bass ?? null)) return false;
  const da = sortDegrees(a.degrees);
  const db = sortDegrees(b.degrees);
  return da.length === db.length && da.every((name, i) => name === db[i]);
}
