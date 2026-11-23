// Lit stage: a small low-poly stage with a keyboard, a guitar fretboard, a bass
// fretboard and a drum kit. Each note lights its key, its fret position or its
// drum piece as it sounds, and the light fades afterwards. The voice is a light
// whose height is the sung pitch, and the "other" stem is a row of twelve lamps.
// Needs notes. A stem with no notes yet has its instrument on stage, unlit.
//
// The mapping is map.js (plain numbers, tested under node). This file only
// builds the stage and turns glows into colour. LOOK.md has the art direction.

import { strings } from "./strings.js";
import {
  INSTRUMENT, KEY_LOW, KEY_HIGH, WHITE_KEYS, GUITAR_TUNING, BASS_TUNING, MAX_FRET, PIECES, FADE_SECONDS, CALM_FADE_SECONDS,
  isBlack, keyFor, keyPlace, fretFor, fretWire, fretSpot, drumPiece, voiceRange, voiceHeight, lampFor, litThings, sungAt,
} from "./map.js";

const BACKGROUND = 0x05080d;
const BODY = 0x18212b; // what instruments are made of
const TRIM_NONE = 0x3a4450; // the trim of an instrument whose stem has no notes
const MUTED = 0.18; // how much of its light a muted instrument's trim keeps
const KEY_W = 0.6;
// A big thing lit as hard as a small one floods the stage with glow: drums
// and the voice's ball are lit to this much of what a key or a fret spot gets.
const BIG = 0.85;

function create({ THREE, song, size, reducedMotion, text, stemLabel }) {
  const calm = Boolean(reducedMotion);
  const fade = calm ? CALM_FADE_SECONDS : FADE_SECONDS;
  // How bright a lit thing gets, as light (luminance): past 1 so the host's
  // glow catches it, and the same for every stem whatever its hue. In the calm
  // version it stays within plain colour.
  const PEAK_LIGHT = calm ? 0.5 : 1.15;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  const camera = new THREE.PerspectiveCamera(36, size.width / size.height, 1, 300);
  function frameCamera(aspect) {
    const fit = Math.max(1, 1.9 / Math.max(0.4, aspect));
    camera.position.set(0, 15.5 * fit, 47 * fit);
    camera.lookAt(0, 6.2, 0);
  }
  frameCamera(size.width / size.height);

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x10161e, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(-10, 24, 20);
  scene.add(key);

  const disposables = [];
  const keep = (x) => {
    disposables.push(x);
    return x;
  };
  const box = keep(new THREE.BoxGeometry(1, 1, 1));
  const drum = keep(new THREE.CylinderGeometry(1, 1, 1, 10)); // few sides: faceted, not round
  const ball = keep(new THREE.IcosahedronGeometry(1, 1));
  const matte = (color) => keep(new THREE.MeshLambertMaterial({ color, flatShading: true }));
  const glowing = (color) => keep(new THREE.MeshBasicMaterial({ color }));
  const matrix = new THREE.Matrix4();
  const shade = new THREE.Color();
  const black = new THREE.Color(0x000000);

  const part = (geometry, material, parent, [x, y, z], [sx, sy, sz]) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.add(mesh);
    return mesh;
  };

  // The stage floor, with a lighter edge so the stage reads in the dark.
  const ring = keep(new THREE.CylinderGeometry(1, 1, 1, 40));
  part(ring, glowing(0x243140), scene, [0, -0.3, 0], [24.25, 0.4, 15.25]);
  part(ring, matte(0x131c26), scene, [0, -0.25, 0], [24, 0.5, 15]);

  // Each stem that the song has, by instrument.
  const stems = {};
  for (const s of song.stems) {
    const kind = INSTRUMENT[s.name];
    if (!kind) continue;
    let longest = 0;
    for (const n of s.notes || []) longest = Math.max(longest, n.end - n.start);
    const color = new THREE.Color(s.color);
    const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    stems[kind] = {
      name: s.name,
      color,
      // Capped, so a lit thing keeps its stem's hue and does not burn to white.
      peak: Math.min(calm ? 1.6 : 2.1, Math.max(1, PEAK_LIGHT / Math.max(0.05, luminance))),
      notes: s.notes && s.notes.length ? s.notes : null,
      present: true,
      longest,
      on: true,
      lit: new Map(),
    };
  }
  const stemOf = (kind) => stems[kind] || { name: null, color: new THREE.Color(TRIM_NONE), peak: 1, notes: null, present: false, longest: 0, on: true, lit: new Map() };

  // An instrument's trim: its stem's colour, or grey when the stem has no notes.
  const trims = [];
  function trim(kind) {
    const stem = stemOf(kind);
    const material = glowing(0x000000);
    trims.push({ kind, material, shown: null });
    return { stem, material };
  }

  // ── Keyboard ──
  const keyboard = new THREE.Group();
  keyboard.position.set(0, 0.6, 11.5);
  keyboard.rotation.x = 0.5;
  scene.add(keyboard);
  const kb = trim("keyboard");
  const kbWidth = WHITE_KEYS * KEY_W;
  part(box, matte(BODY), keyboard, [0, -0.35, -0.6], [kbWidth + 1.2, 0.5, 5]);
  part(box, kb.material, keyboard, [0, 0.05, -2.75], [kbWidth + 1.2, 0.12, 0.12]);
  const whites = [];
  const blacks = [];
  for (let p = KEY_LOW; p <= KEY_HIGH; p++) (isBlack(p) ? blacks : whites).push(p);
  // Unlit keys are flat colour, not shaded: a lit key is then exactly its
  // stem's colour at full strength, and glows like everything else that is lit.
  const WHITE = new THREE.Color(0x46505b);
  const EBONY = new THREE.Color(0x0b0f13);
  const whiteKeys = new THREE.InstancedMesh(box, glowing(0xffffff), whites.length);
  const blackKeys = new THREE.InstancedMesh(box, glowing(0xffffff), blacks.length);
  const keySlot = new Map();
  whites.forEach((p, i) => {
    // A clear gap between keys, the same all the way along.
    matrix.makeScale(KEY_W * 0.84, 0.3, 3.4).setPosition((keyPlace(p).x - WHITE_KEYS / 2) * KEY_W, 0, 0);
    whiteKeys.setMatrixAt(i, matrix);
    whiteKeys.setColorAt(i, WHITE);
    keySlot.set(p, [whiteKeys, i, WHITE]);
  });
  blacks.forEach((p, i) => {
    matrix.makeScale(KEY_W * 0.56, 0.34, 2.1).setPosition((keyPlace(p).x - WHITE_KEYS / 2) * KEY_W, 0.3, -0.65);
    blackKeys.setMatrixAt(i, matrix);
    blackKeys.setColorAt(i, EBONY);
    keySlot.set(p, [blackKeys, i, EBONY]);
  });
  keyboard.add(whiteKeys, blackKeys);

  // ── Fretboards ──
  function fretboard(kind, tuning, x) {
    const strings = tuning.length;
    const length = 17.5;
    const pitch = 0.62; // between strings
    const height = strings * pitch + 0.5;
    const group = new THREE.Group();
    group.position.set(x, 10.6, -4);
    group.rotation.x = -0.12;
    scene.add(group);
    const { stem, material } = trim(kind);
    part(box, matte(BODY), group, [0, 0, -0.2], [length + 1.2, height, 0.4]);
    part(box, material, group, [0, height / 2 + 0.12, -0.2], [length + 1.2, 0.14, 0.4]);
    part(box, material, group, [0, -height / 2 - 0.12, -0.2], [length + 1.2, 0.14, 0.4]);
    const left = -length / 2 + 0.6;
    const span = length - 1;
    // Fret wires and the nut.
    const wires = new THREE.InstancedMesh(box, glowing(0x414c58), MAX_FRET + 1);
    for (let f = 0; f <= MAX_FRET; f++) {
      // One straight piece from the top string to the bottom one.
      matrix.makeScale(f === 0 ? 0.22 : 0.085, (strings - 1) * pitch + 0.24, 0.02).setPosition(left + fretWire(f) * span, 0, 0.02);
      wires.setMatrixAt(f, matrix);
    }
    group.add(wires);
    // Strings: the lowest at the bottom, as on a tab.
    const stringY = (s) => (s - (strings - 1) / 2) * pitch;
    const lines = new THREE.InstancedMesh(box, glowing(0x5c6773), strings);
    for (let s = 0; s < strings; s++) {
      // Every string wide enough to draw; the low ones a little heavier.
      matrix.makeScale(length, 0.07 + (strings - 1 - s) * 0.008, 0.02).setPosition(0, stringY(s), 0.04);
      lines.setMatrixAt(s, matrix);
    }
    group.add(lines);
    // One spot per string and fret. Until its note sounds a spot is shrunk
    // to nothing, so the board is strings and frets and no chequer of squares.
    const spots = new THREE.InstancedMesh(box, glowing(0xffffff), strings * (MAX_FRET + 1));
    const spotAt = [];
    for (let s = 0; s < strings; s++) {
      for (let f = 0; f <= MAX_FRET; f++) {
        const i = s * (MAX_FRET + 1) + f;
        // Never wider than the gap between its fret wires.
        const gap = f === 0 ? 0.5 : (fretWire(f) - fretWire(f - 1)) * span;
        spotAt[i] = { x: left + fretSpot(f) * span, y: stringY(s), w: Math.min(0.44, gap * 0.72) };
        spots.setMatrixAt(i, matrix.makeScale(0, 0, 0));
        spots.setColorAt(i, black);
      }
    }
    spots.frustumCulled = false;
    group.add(spots);
    return { stem, tuning, spots, spotAt, shown: new Set(), slot: (string, fret) => string * (MAX_FRET + 1) + fret };
  }
  const guitar = fretboard("guitar", GUITAR_TUNING, -11.2);
  const bass = fretboard("bass", BASS_TUNING, 11.2);

  // ── Drum kit ──
  const kit = new THREE.Group();
  kit.position.set(0, 0, -2.5);
  scene.add(kit);
  const kitTrim = trim("kit");
  const pieces = {};
  function piece(name, geometry, position, scale, tilt = [0, 0, 0]) {
    // Dark until it is hit; then the whole piece lights.
    const material = keep(new THREE.MeshLambertMaterial({ color: 0x343f4c, flatShading: true }));
    const mesh = part(geometry, material, kit, position, scale);
    mesh.rotation.set(...tilt);
    pieces[name] = { material, shown: -1 };
    return mesh;
  }
  // The kick's shell stays dark; only its front head lights.
  const shell = part(drum, matte(0x343f4c), kit, [0, 2.2, -0.05], [2.2, 1.6, 2.2]);
  shell.rotation.x = Math.PI / 2;
  piece("kick", drum, [0, 2.2, 0.8], [2.08, 0.1, 2.08], [Math.PI / 2, 0, 0]);
  piece("snare", drum, [-3.3, 2.7, 2], [1.35, 0.6, 1.35], [0.25, 0, 0]);
  piece("hihat", drum, [-5.8, 3.9, 1.4], [1.2, 0.12, 1.2], [0.2, 0, 0]);
  piece("tomHigh", drum, [-1.5, 5, -0.6], [1.0, 0.8, 1.0], [0.5, 0, 0.12]);
  piece("tomMid", drum, [1.5, 5, -0.6], [1.1, 0.85, 1.1], [0.5, 0, -0.12]);
  piece("tomFloor", drum, [4.1, 2.3, 2], [1.5, 1.7, 1.5], [0.12, 0, 0]);
  piece("crash", drum, [-4.2, 7, -1.4], [1.8, 0.08, 1.8], [0.35, 0, 0.18]);
  piece("ride", drum, [5.2, 6.4, -1], [2.0, 0.08, 2.0], [0.35, 0, -0.18]);
  // Stands and a hoop, so the kit reads as a kit; the hoop is its trim.
  for (const [x, y, z, h] of [[-5.8, 1.95, 1.4, 3.9], [-4.2, 3.5, -1.4, 7], [5.2, 3.2, -1, 6.4], [-3.3, 1.2, 2, 2.4]]) {
    part(box, matte(0x39434e), kit, [x, y, z], [0.1, h, 0.1]);
  }
  // A thin hoop round the kick's head: a ring, so the head itself stays dark.
  const hoopGeometry = keep(new THREE.TorusGeometry(2.2, 0.075, 6, 20));
  part(hoopGeometry, kitTrim.material, kit, [0, 2.2, 0.86], [1, 1, 1]);

  // ── The voice: a light on a rail, as high as the note is ──
  const voice = stemOf("voice");
  const voiceTrim = trim("voice");
  const range = voiceRange(voice.notes);
  const RAIL = { x: 0, low: 7.8, high: 13.4, z: 3 }; // it ends below the lamp bar
  part(box, voiceTrim.material, scene, [RAIL.x, (RAIL.low + RAIL.high) / 2, RAIL.z], [0.07, RAIL.high - RAIL.low, 0.07]);
  const voiceMaterial = glowing(0x000000);
  const voiceLight = part(ball, voiceMaterial, scene, [RAIL.x, RAIL.low, RAIL.z], [0.75, 0.75, 0.75]);
  voiceLight.visible = false;

  // ── The "other" stem: twelve lamps along the back ──
  const lampTrim = trim("lamps");
  const LAMP_OFF = new THREE.Color(0x2b3542);
  part(box, lampTrim.material, scene, [0, 16.1, -7], [23.5, 0.1, 0.1]);
  const lamps = new THREE.InstancedMesh(ball, glowing(0xffffff), 12);
  for (let i = 0; i < 12; i++) {
    matrix.makeScale(0.42, 0.42, 0.42).setPosition((i - 5.5) * 2, 15.5, -7);
    lamps.setMatrixAt(i, matrix);
    lamps.setColorAt(i, LAMP_OFF);
  }
  scene.add(lamps);

  // What is lit, for the tests and the caption.
  const state = { keys: [], guitar: [], bass: [], kit: [], lamps: [], voice: null };

  // Stems that are in the song and have no notes yet.
  const unlit = Object.values(stems).filter((s) => !s.notes).map((s) => s.name);
  const caption = unlit.length ? text("noNotes", { list: unlit.map((n) => stemLabel?.(n) || n).join(", ") }) : "";

  function paintTrims() {
    for (const t of trims) {
      const stem = stemOf(t.kind);
      const want = !stem.notes ? "none" : stem.on ? "on" : "muted";
      if (want === t.shown) continue;
      t.shown = want;
      if (want === "none") t.material.color.set(TRIM_NONE).multiplyScalar(0.5);
      else t.material.color.copy(stem.color).multiplyScalar(want === "on" ? 0.4 : MUTED * 0.4);
    }
  }

  // A lit thing's colour: its stem's, pushed brighter as it glows.
  const litColour = (stem, g) => shade.copy(stem.color).multiplyScalar(0.2 + g * (stem.peak - 0.2));

  function update(frame) {
    const time = frame.time;
    for (const stem of Object.values(stems)) stem.on = frame.stems[stem.name]?.lit !== false;
    paintTrims();
    const sounding = (kind, keyOf) => {
      const stem = stemOf(kind);
      // Muted, or no notes: nothing lights.
      if (!stem.notes || !stem.on) return new Map();
      return litThings(stem.notes, time, keyOf, { longest: stem.longest, fade });
    };

    // Keyboard.
    const keys = sounding("keyboard", (n) => keyFor(n.pitch));
    for (const [p, [mesh, slot, rest]] of keySlot) {
      const g = keys.get(p) || 0;
      mesh.setColorAt(slot, g > 0 ? litColour(stemOf("keyboard"), g) : rest);
    }
    whiteKeys.instanceColor.needsUpdate = true;
    blackKeys.instanceColor.needsUpdate = true;
    state.keys = [...keys.keys()].sort((a, b) => a - b);

    // Fretboards.
    for (const [kind, board] of [["guitar", guitar], ["bass", bass]]) {
      const spots = sounding(kind, (n) => {
        const at = fretFor(n.pitch, board.tuning);
        return board.slot(at.string, at.fret);
      });
      // Spots lit last frame and no longer: shrink them away again.
      for (const i of board.shown) {
        if (!spots.has(i)) board.spots.setMatrixAt(i, matrix.makeScale(0, 0, 0));
      }
      board.shown.clear();
      for (const [i, g] of spots) {
        const at = board.spotAt[i];
        board.spots.setMatrixAt(i, matrix.makeScale(at.w, 0.44, 0.1).setPosition(at.x, at.y, 0.1));
        board.spots.setColorAt(i, litColour(board.stem, g));
        board.shown.add(i);
      }
      board.spots.instanceMatrix.needsUpdate = true;
      board.spots.instanceColor.needsUpdate = true;
      state[kind] = [...spots.keys()].sort((a, b) => a - b).map((i) => [Math.floor(i / (MAX_FRET + 1)), i % (MAX_FRET + 1)]);
    }

    // Kit.
    const hits = sounding("kit", (n) => drumPiece(n.pitch));
    const kitStem = stemOf("kit");
    for (const name of PIECES) {
      const g = hits.get(name) || 0;
      const p = pieces[name];
      if (Math.abs(g - p.shown) < 0.004) continue;
      p.shown = g;
      // The kick's head is the biggest lit thing on stage: lit less hard still.
      if (g > 0) p.material.emissive.copy(kitStem.color).multiplyScalar(g * kitStem.peak * (name === "kick" ? BIG * 0.6 : BIG));
      else p.material.emissive.setScalar(0);
    }
    state.kit = PIECES.filter((name) => hits.has(name));

    // Voice.
    const sung = voice.notes && voice.on ? sungAt(voice.notes, time, { longest: voice.longest, fade }) : null;
    voiceLight.visible = Boolean(sung);
    if (sung) {
      const h = voiceHeight(sung.pitch, range);
      voiceLight.position.y = RAIL.low + h * (RAIL.high - RAIL.low);
      voiceMaterial.color.copy(voice.color).multiplyScalar(0.3 + sung.glow * (voice.peak * BIG - 0.3));
      state.voice = { height: h, glow: sung.glow, pitch: sung.pitch };
    } else state.voice = null;

    // Lamps.
    const lit = sounding("lamps", (n) => lampFor(n.pitch));
    for (let i = 0; i < 12; i++) {
      const g = lit.get(i) || 0;
      lamps.setColorAt(i, g > 0 ? litColour(stemOf("lamps"), g) : LAMP_OFF);
    }
    lamps.instanceColor.needsUpdate = true;
    state.lamps = [...lit.keys()].sort((a, b) => a - b);
  }

  function resize(next) {
    camera.aspect = next.width / next.height;
    frameCamera(camera.aspect);
    camera.updateProjectionMatrix();
  }

  function dispose() {
    scene.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
    });
    for (const d of disposables) d.dispose();
  }

  return {
    scene,
    camera,
    bloom: calm ? null : { strength: 0.5, radius: 0.1, threshold: 0.5 },
    update,
    resize,
    setQuality() {},
    dispose,
    caption: () => caption,
    debug: () => ({
      calm,
      unlit,
      caption,
      lit: state,
      trims: Object.fromEntries(trims.map((t) => [t.kind, t.shown])),
      voiceRange: range,
    }),
  };
}

export default { id: "lit-stage", needs: { notes: true }, strings, create };
