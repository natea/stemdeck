// Slit-scan score: the whole song as one strip, a column per moment and a band
// per stem. Brightness is loudness, bright marks inside a band are notes at
// their pitch, a white line is the present moment, and a click on the strip
// seeks there.
//
// The mapping is map.js (plain numbers and bytes, tested under node). This
// file only puts it on screen. LOOK.md has the art direction.

import { strings } from "./strings.js";
import { COLUMNS, ROWS, STRIP, bandRects, bandPixels, timeToX, pointToTime } from "./map.js";

const BACKGROUND = 0x050b10;
// How much of its light a muted band keeps, marks and all. A material's colour
// is linear light: this is about a tenth of the brightness on screen.
const MUTED = 0.012;
// How bright the part of the song still to come is drawn, against what has
// played: a plain black veil over it, so colours dim and keep their hue.
const AHEAD = 0.48;
const SECTION_TOP = 0.034; // the section bar's top edge, above the strip
const SECTION_BOTTOM = 0.02;

function create({ THREE, song, size, reducedMotion }) {
  const calm = Boolean(reducedMotion);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  // One unit is one pixel of the view, y up.
  const camera = new THREE.OrthographicCamera(0, size.width, size.height, 0, -10, 10);

  const disposables = [];
  const keep = (x) => {
    disposables.push(x);
    return x;
  };
  const plane = keep(new THREE.PlaneGeometry(1, 1));
  const flat = (color, opacity = 1) =>
    keep(new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false }));

  let view = { width: size.width, height: size.height };
  // A rectangle given in fractions of the view (y from the top).
  function place(mesh, x0, x1, y0, y1, z = 0) {
    mesh.position.set(((x0 + x1) / 2) * view.width, (1 - (y0 + y1) / 2) * view.height, z);
    mesh.scale.set(Math.max(1, (x1 - x0) * view.width), Math.max(1, (y1 - y0) * view.height), 1);
  }

  // The bands.
  const rects = bandRects(song.stems.length);
  const bands = song.stems.map((stem, i) => {
    const texture = keep(new THREE.DataTexture(bandPixels(stem, song.duration), COLUMNS, ROWS, THREE.RGBAFormat));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    const material = keep(new THREE.MeshBasicMaterial({ map: texture, depthTest: false }));
    const mesh = new THREE.Mesh(plane, material);
    mesh.renderOrder = 1;
    scene.add(mesh);
    return { name: stem.name, mesh, material, rect: rects[i], shownLit: null };
  });

  // Sections: a bar of their colours above the strip.
  const sections = song.sections.map((s) => {
    const material = flat(s.color || "#88a8c8");
    material.color.multiplyScalar(0.7);
    const mesh = new THREE.Mesh(plane, material);
    mesh.renderOrder = 1;
    scene.add(mesh);
    return { mesh, start: s.start, end: s.end };
  });

  // Bars: ticks on a ruler below the strip.
  let ticks = null;
  if (song.bars.length) {
    ticks = new THREE.InstancedMesh(plane, flat(0x5a7088), song.bars.length);
    ticks.renderOrder = 1;
    ticks.frustumCulled = false;
    scene.add(ticks);
  }

  // What is still to come is drawn darker, so the strip fills as the song plays.
  // One veil per band and one for the section bar, not one sheet over all:
  // the gaps between them stay the background's own colour.
  const veilMaterial = flat(0x000000, 1 - AHEAD);
  const veiled = song.sections.length ? [...rects, { y0: STRIP.y0 - SECTION_TOP, y1: STRIP.y0 - SECTION_BOTTOM }] : rects;
  const veils = veiled.map((rect) => {
    const mesh = new THREE.Mesh(plane, veilMaterial);
    mesh.renderOrder = 2;
    scene.add(mesh);
    return { mesh, rect };
  });

  // The present moment: a thin white line with a soft halo its whole length.
  // The halo is drawn here, not by the host's glow, so it is the same on every
  // song: light that falls away smoothly to nothing either side of the line
  // and tapers at its ends.
  const HALO_W = 32;
  const HALO_H = 64;
  const haloPixels = new Uint8Array(HALO_W * HALO_H * 4);
  for (let y = 0; y < HALO_H; y++) {
    const fromEnd = Math.min(y, HALO_H - 1 - y) / (HALO_H * 0.06);
    const taper = Math.min(1, fromEnd);
    for (let x = 0; x < HALO_W; x++) {
      const d = (x + 0.5 - HALO_W / 2) / (HALO_W / 2); // -1..1 across
      // Slight: it must not wash out the band colour or the marks beside the
      // line. Eased to exactly nothing at its outer edge.
      const edge = Math.min(1, (1 - Math.abs(d)) * 4);
      const v = Math.round(255 * 0.16 * Math.exp(-d * d * 6) * edge * taper);
      haloPixels.set([v, v, v, 255], (y * HALO_W + x) * 4);
    }
  }
  const haloTexture = keep(new THREE.DataTexture(haloPixels, HALO_W, HALO_H, THREE.RGBAFormat));
  haloTexture.magFilter = THREE.LinearFilter;
  haloTexture.minFilter = THREE.LinearFilter;
  haloTexture.needsUpdate = true;
  const halo = new THREE.Mesh(plane, keep(new THREE.MeshBasicMaterial({
    map: haloTexture, blending: THREE.AdditiveBlending, transparent: true, depthTest: false,
  })));
  halo.renderOrder = 3;
  scene.add(halo);
  const head = new THREE.Mesh(plane, flat(0xffffff));
  head.renderOrder = 4;
  scene.add(head);

  const matrix = new THREE.Matrix4();
  let headX = STRIP.x0;

  function layout() {
    for (const band of bands) place(band.mesh, STRIP.x0, STRIP.x1, band.rect.y0, band.rect.y1);
    for (const s of sections) {
      const x0 = timeToX(s.start, song.duration);
      const x1 = timeToX(s.end, song.duration);
      // A hair of space between neighbours.
      place(s.mesh, x0, Math.max(x0, x1 - 0.0015), STRIP.y0 - SECTION_TOP, STRIP.y0 - SECTION_BOTTOM);
    }
    if (ticks) {
      song.bars.forEach((time, i) => {
        const x = timeToX(time, song.duration) * view.width;
        const tall = i % 4 === 0;
        const h = (tall ? 0.03 : 0.012) * view.height;
        matrix.makeScale(1, h, 1).setPosition(x, (1 - STRIP.y1 - 0.012) * view.height - h / 2, 0);
        ticks.setMatrixAt(i, matrix);
      });
      ticks.instanceMatrix.needsUpdate = true;
    }
    moveHead();
  }

  function moveHead() {
    // On whole pixels, so the line is as crisp over the bands as beside them.
    const w = Math.max(2, Math.round(view.width * 0.0016));
    const x = Math.round(headX * view.width) + (w % 2 ? 0.5 : 0);
    const tall = Math.round((STRIP.y1 - STRIP.y0 + 0.09) * view.height);
    const y = Math.round((1 - (STRIP.y0 + STRIP.y1) / 2) * view.height);
    head.position.set(x, y, 0);
    head.scale.set(w, tall, 1);
    halo.position.set(x, y, 0);
    halo.scale.set(w * 9, tall + 6, 1);
    for (const veil of veils) {
      place(veil.mesh, Math.min(STRIP.x1, headX), STRIP.x1, veil.rect.y0, veil.rect.y1);
      veil.mesh.visible = headX < STRIP.x1 - 1e-4;
    }
  }

  function update(frame) {
    headX = timeToX(frame.time, song.duration);
    moveHead();
    for (const band of bands) {
      const on = frame.stems[band.name]?.lit !== false;
      if (on !== band.shownLit) {
        band.shownLit = on;
        band.material.color.setScalar(on ? 1 : MUTED);
      }
    }
  }

  function resize(next) {
    view = { width: next.width, height: next.height };
    camera.right = next.width;
    camera.top = next.height;
    camera.updateProjectionMatrix();
    layout();
  }

  layout();

  return {
    scene,
    camera,
    // The line's halo is its own (see above): nothing here needs the host's glow.
    bloom: null,
    update,
    resize,
    setQuality() {},
    dispose() {
      ticks?.dispose();
      for (const d of disposables) d.dispose();
    },
    /** A click on the strip is a moment of the song. */
    timeAt: ({ x, y }) => pointToTime(x, y, song.duration),
    debug: () => ({
      headX,
      strip: STRIP,
      calm,
      bands: bands.map((b) => ({ name: b.name, tint: b.material.color.getHex(), rect: b.rect })),
      sections: sections.length,
      bars: song.bars.length,
    }),
  };
}

export default { id: "slit-scan", needs: { notes: false }, strings, create };
