// Note terrain: the song as a landscape of blocks travelling toward the viewer.
// Time runs into the screen, pitch across, a block's height is how hard the
// note was played, its colour is its stem's, and the blocks on the present
// line are lit. A stem with no notes is a ridge whose height is its loudness.
//
// The mapping is map.js (plain numbers, tested under node). This file only
// turns it into meshes. LOOK.md has the art direction.

import { strings } from "./strings.js";
import {
  SPEED, VIEW_AHEAD, FUTURE, FOV, HOLD_SECONDS, FADE_SECONDS,
  pitchRange, layout, stemBlocks, extent, cameraFor, chunkOf, chunkVisible, litAmount, shadeFor, litValue, upperBound, placement,
} from "./map.js";

const BACKGROUND = 0x050b10;
const GROUND = 0x0a121a;
// A muted stem keeps its shape and loses its colour: a grey no brighter than
// the coloured stems' blocks to come, and as dark as theirs once past.
const MUTED_GREY = 0.32;
const MUTED_TO_COME = 0.55;
const MUTED_PAST = 0.12;
const CALM_PAGE = 12; // seconds of song on one still page
const FAR = 2000; // "as far as anyone can see", for the ground and its lines

function create({ THREE, song, size, reducedMotion }) {
  const calm = Boolean(reducedMotion);
  const plan = layout(song.stems);
  const range = pitchRange(song.stems);
  const blocksOf = song.stems.map((stem) => stemBlocks(stem, song, plan, range));
  // The picture is framed on what is actually drawn, not on empty lanes.
  const reach = extent(blocksOf) || { min: -10, max: 10 };
  const centre = (reach.min + reach.max) / 2;
  const half = Math.max(8, (reach.max - reach.min) / 2 + 1.5);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.Fog(BACKGROUND, 40, VIEW_AHEAD[2] * SPEED);
  let ahead = VIEW_AHEAD[2];

  const camera = new THREE.PerspectiveCamera(FOV, size.width / size.height, 2, 600);
  const target = new THREE.Vector3();
  let stand = cameraFor(half, size.width / size.height);
  function aim(drift = 0) {
    // The drift moves the camera and what it looks at together: no turning,
    // so the present line stays level.
    camera.position.set(centre + drift, stand.height, stand.back);
    target.set(centre + drift, 0, -stand.lookAhead);
    camera.lookAt(target);
  }
  // Fog is measured from the camera, and the camera stands further back for a
  // wider landscape: the fog starts and ends at the same moments of the song
  // wherever the camera is.
  function setFog() {
    // The far end is whichever comes first: the view distance for this level
    // of detail, or the top of the picture. The landscape fades out there.
    const end = Math.min(ahead * SPEED, stand.sees * 0.9);
    scene.fog.near = Math.hypot(stand.height, stand.back + end * 0.45);
    scene.fog.far = Math.hypot(stand.height, stand.back + end);
  }
  aim();
  setFog();

  scene.add(new THREE.HemisphereLight(0xdcebff, 0x1a2530, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-18, 30, 12);
  scene.add(sun);
  // A fill from the viewer's side, so the faces turned to the viewer are not
  // lost and a lit block is lit on the side we see.
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(0, 6, 20);
  scene.add(fill);

  const disposables = [];
  const keep = (x) => {
    disposables.push(x);
    return x;
  };
  const box = keep(new THREE.BoxGeometry(1, 1, 1));
  const matrix = new THREE.Matrix4();
  const shade = new THREE.Color();

  // Everything that belongs to a moment of the song hangs off this group.
  const landscape = new THREE.Group();
  scene.add(landscape);

  // The ground reaches past every edge of the picture; fog takes its far end.
  const groundLength = Math.max(song.duration, 1) * SPEED + FAR;
  const ground = new THREE.Mesh(keep(new THREE.PlaneGeometry(FAR, groundLength)), keep(new THREE.MeshBasicMaterial({ color: GROUND })));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(centre, -0.05, -groundLength / 2 + FAR / 2);
  landscape.add(ground);

  // Beat and bar lines: whole strips across the ground, just above it, never
  // fighting it for depth.
  function lines(times, color, depth) {
    if (!times.length) return;
    const material = keep(new THREE.MeshBasicMaterial({ color, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const mesh = new THREE.InstancedMesh(box, material, times.length);
    times.forEach((time, i) => {
      matrix.makeScale(FAR, 0.02, depth).setPosition(centre, 0.05, -time * SPEED);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.frustumCulled = false;
    landscape.add(mesh);
  }
  lines(song.beats, 0x141f2a, 0.06);
  lines(song.bars, 0x30465c, 0.12);

  // Sections: a coloured rail just outside the blocks on each side.
  if (song.sections.length) {
    const rails = new THREE.InstancedMesh(box, keep(new THREE.MeshBasicMaterial()), song.sections.length * 2);
    song.sections.forEach((s, i) => {
      const length = Math.max(0.2, (s.end - s.start) * SPEED - 0.4);
      const z = -(s.start * SPEED + 0.2 + length / 2);
      shade.set(s.color || "#88a8c8").multiplyScalar(0.8);
      for (const [k, side] of [[0, -1], [1, 1]]) {
        matrix.makeScale(0.5, 0.3, length).setPosition(centre + side * (half - 0.4), 0.15, z);
        rails.setMatrixAt(i * 2 + k, matrix);
        rails.setColorAt(i * 2 + k, shade);
      }
    });
    rails.frustumCulled = false;
    landscape.add(rails);
  }

  // One set of slabs per stem, so a mute is one colour change.
  const stems = song.stems.map((stem, s) => {
    const blocks = blocksOf[s];
    const color = new THREE.Color(stem.color);
    const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    const material = keep(new THREE.MeshLambertMaterial({ color: color.clone() }));
    const byChunk = new Map();
    blocks.forEach((b, index) => {
      const c = chunkOf(b.start);
      if (!byChunk.has(c)) byChunk.set(c, []);
      byChunk.get(c).push(index);
    });
    // Where each block is: [slab mesh, slot].
    const where = new Array(blocks.length);
    const chunks = [];
    for (const [chunk, indices] of byChunk) {
      const mesh = new THREE.InstancedMesh(box, material, indices.length);
      indices.forEach((i, slot) => {
        const b = blocks[i];
        where[i] = [mesh, slot];
        matrix.makeScale(b.w, b.h, b.d).setPosition(b.x, b.y, b.z);
        mesh.setMatrixAt(slot, matrix);
        mesh.setColorAt(slot, shade.setScalar(FUTURE));
      });
      mesh.frustumCulled = false;
      mesh.visible = false;
      landscape.add(mesh);
      chunks.push({ chunk, mesh });
    }
    let longest = 0;
    for (const b of blocks) longest = Math.max(longest, b.end - b.start);
    return { name: stem.name, color, material, blocks, where, chunks, longest, lit: litValue(luminance, calm), on: null };
  });

  function paint(stem, index, time) {
    const [mesh, slot] = stem.where[index];
    const amount = litAmount(stem.blocks[index], time);
    // Muted: grey, and nothing lights up; what is past is still darker.
    const value = stem.on === false ? shadeFor(amount, MUTED_TO_COME, MUTED_PAST, MUTED_TO_COME) : shadeFor(amount, stem.lit);
    mesh.setColorAt(slot, shade.setScalar(value));
    mesh.instanceColor.needsUpdate = true;
  }

  function repaint(stem, time) {
    for (let i = 0; i < stem.blocks.length; i++) paint(stem, i, time);
  }

  // The present moment: one bright strip from edge to edge, drawn over all.
  const lineMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
  const line = new THREE.Mesh(box, lineMaterial);
  line.position.set(centre, 0.05, 0);
  // As thick on screen from a far camera as from a near one.
  const sizeLine = () => line.scale.set(FAR, 0.02, Math.max(0.14, stand.back * 0.011));
  sizeLine();
  line.renderOrder = 10;
  scene.add(line);

  let lastTime = null;

  function update(frame) {
    const time = frame.time;
    const place = placement(time, { calm, page: CALM_PAGE });
    landscape.position.z = place.landscapeZ;
    line.position.z = place.lineZ;
    // What can be seen: from the present in motion, the whole page when calm.
    const from = calm ? place.landscapeZ / SPEED : time;
    const far = calm ? CALM_PAGE + 2 : ahead;
    const all = lastTime === null || frame.jumped || time < lastTime;

    for (const stem of stems) {
      const on = frame.stems[stem.name]?.lit !== false;
      const changed = on !== stem.on;
      if (changed) {
        stem.on = on;
        if (on) stem.material.color.copy(stem.color);
        else stem.material.color.setScalar(MUTED_GREY);
      }
      if (all || changed) repaint(stem, time);
      else {
        // Only what the line has reached or left since the last frame.
        const first = upperBound(stem.blocks, lastTime - stem.longest - HOLD_SECONDS - FADE_SECONDS);
        const last = upperBound(stem.blocks, time);
        for (let i = first; i < last; i++) paint(stem, i, time);
      }
      for (const c of stem.chunks) c.mesh.visible = chunkVisible(c.chunk, from, far);
    }
    lastTime = time;

    if (!calm) aim(Math.sin(time * 0.1) * Math.min(0.6, half * 0.03));
  }

  function resize(next) {
    camera.aspect = next.width / next.height;
    stand = cameraFor(half, camera.aspect);
    aim();
    setFog();
    sizeLine();
    camera.updateProjectionMatrix();
  }

  function setQuality(level) {
    ahead = VIEW_AHEAD[Math.max(0, Math.min(2, level))];
    setFog();
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
    // A gentle glow on the lit blocks only; none in the calm version.
    bloom: calm ? null : { strength: 0.45, radius: 0.2, threshold: 0.85 },
    update,
    resize,
    setQuality,
    dispose,
    // For the tests: what the mapping came to.
    debug: () => ({
      plan,
      range,
      calm,
      centre,
      half,
      landscapeZ: landscape.position.z,
      lineZ: line.position.z,
      stems: stems.map((s) => ({
        name: s.name,
        blocks: s.blocks.length,
        chunks: s.chunks.length,
        visible: s.chunks.filter((c) => c.mesh.visible).length,
        tint: s.material.color.getHex(),
        lit: s.lit,
      })),
    }),
  };
}

export default { id: "note-terrain", needs: { notes: false }, strings, create };
