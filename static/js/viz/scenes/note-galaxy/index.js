// Note galaxy: one spiral arm per stem, and a burst of particles for each note
// as it sounds, at a distance from the centre set by its pitch and with a size
// set by how hard it was played. Needs notes.
//
// The mapping is map.js (plain numbers, tested under node). This file only
// turns it into points. LOOK.md has the art direction.

import { strings } from "./strings.js";
import {
  R_MAX, BURST_SECONDS, MAX_POINTS, ARM_STARS,
  pitchRange, velocitySize, burstCount, notePoint, particle, window as noteWindow, holdGlow, armStars,
} from "./map.js";

const BACKGROUND = 0x04070d;
const ARM_DIM = 0.26; // an arm's stars when its stem is quiet: six arms can be counted
const ARM_LOUD = 0.18; // how much brighter at most when it is loud
const ARM_MUTED = 0.035; // and when it is muted

const VERTEX = `
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  uniform float scale;
  varying vec3 vTint;
  varying float vAlpha;
  void main() {
    vTint = tint;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
// A soft round dot: bright in the middle, gone at the edge.
const FRAGMENT = `
  varying vec3 vTint;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float soft = smoothstep(1.0, 0.0, d);
    gl_FragColor = vec4(vTint * vAlpha * soft * soft, 1.0);
  }
`;

function create({ THREE, song, size, reducedMotion }) {
  const calm = Boolean(reducedMotion);
  const range = pitchRange(song.stems);
  const count = song.stems.length;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  const camera = new THREE.PerspectiveCamera(42, size.width / size.height, 1, 400);
  function frameCamera(aspect) {
    // The whole disc in the picture, whatever the view's shape.
    const fit = Math.max(1, 1.5 / Math.max(0.4, aspect));
    camera.position.set(0, 52.5 * fit, 60 * fit);
    // Aimed a little toward the near side, so the margin is the same top and bottom.
    camera.lookAt(0, 0, 3.4);
  }
  frameCamera(size.width / size.height);

  const disposables = [];
  const keep = (x) => {
    disposables.push(x);
    return x;
  };
  const uniforms = { scale: { value: size.height * 0.9 } };
  const pointsMaterial = () =>
    keep(new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }));

  // The galaxy turns slowly as a whole; everything hangs off this.
  const galaxy = new THREE.Group();
  scene.add(galaxy);

  const stems = song.stems.map((stem, index) => {
    const color = new THREE.Color(stem.color);
    const notes = stem.notes || [];
    let longest = 0;
    for (const n of notes) longest = Math.max(longest, n.end - n.start);
    // A pale stem's faint stars are harder to see than a vivid one's: lift them.
    const most = Math.max(color.r, color.g, color.b);
    const saturation = most > 0 ? (most - Math.min(color.r, color.g, color.b)) / most : 0;
    const armGain = 1 + (1 - saturation) * 0.9;
    return { name: stem.name, index, color, notes, longest, armGain, on: true, level: 0, arm: null, bursts: 0 };
  });

  // The arms: faint stars along each spiral, that shimmer with the stem's loudness.
  function buildArm(stem, howMany) {
    const stars = armStars(stem.index, count, howMany);
    const geometry = keep(new THREE.BufferGeometry());
    const position = new Float32Array(stars.length * 3);
    const sizes = new Float32Array(stars.length);
    const tint = new Float32Array(stars.length * 3);
    const alpha = new Float32Array(stars.length);
    stars.forEach((s, i) => {
      position.set([s.x, s.y, s.z], i * 3);
      sizes[i] = s.size;
      tint.set([stem.color.r, stem.color.g, stem.color.b], i * 3);
      alpha[i] = ARM_DIM;
    });
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("tint", new THREE.BufferAttribute(tint, 3));
    geometry.setAttribute("alpha", new THREE.BufferAttribute(alpha, 1));
    const points = new THREE.Points(geometry, pointsMaterial());
    points.frustumCulled = false;
    galaxy.add(points);
    return { points, geometry, count: stars.length, shown: -1 };
  }

  function dropArm(stem) {
    if (!stem.arm) return;
    galaxy.remove(stem.arm.points);
    stem.arm.geometry.dispose();
    stem.arm.points.material.dispose();
    for (const d of [stem.arm.geometry, stem.arm.points.material]) {
      const i = disposables.indexOf(d);
      if (i >= 0) disposables.splice(i, 1);
    }
    stem.arm = null;
  }

  // The core: a small white heart with a faint wide halo, for the arms to wind out of.
  const coreGeometry = keep(new THREE.BufferGeometry());
  coreGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 0]), 3));
  coreGeometry.setAttribute("size", new THREE.BufferAttribute(new Float32Array([4.2, 13]), 1));
  coreGeometry.setAttribute("tint", new THREE.BufferAttribute(new Float32Array([0.93, 0.95, 1, 0.75, 0.85, 1]), 3));
  coreGeometry.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array([1, 0.1]), 1));
  galaxy.add(new THREE.Points(coreGeometry, pointsMaterial()));

  // The notes: one pool of points, refilled every frame from the song's time.
  let quality = 2;
  let pool = null;
  function buildPool() {
    if (pool) {
      galaxy.remove(pool.points);
      pool.geometry.dispose();
      disposables.splice(disposables.indexOf(pool.geometry), 1);
    }
    const max = MAX_POINTS[quality];
    const geometry = keep(new THREE.BufferGeometry());
    const attr = (n) => {
      const a = new THREE.BufferAttribute(new Float32Array(max * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geometry.setAttribute("position", attr(3));
    geometry.setAttribute("size", attr(1));
    geometry.setAttribute("tint", attr(3));
    geometry.setAttribute("alpha", attr(1));
    const material = pool ? pool.points.material : pointsMaterial();
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    galaxy.add(points);
    pool = { points, geometry, max, used: 0 };
  }

  function rebuild() {
    for (const stem of stems) {
      dropArm(stem);
      stem.arm = buildArm(stem, ARM_STARS[quality]);
    }
    buildPool();
  }
  rebuild();

  function update(frame) {
    const time = frame.time;
    if (!calm) galaxy.rotation.y = -time * 0.035;

    const position = pool.geometry.attributes.position.array;
    const sizes = pool.geometry.attributes.size.array;
    const tint = pool.geometry.attributes.tint.array;
    const alpha = pool.geometry.attributes.alpha.array;
    let n = 0;
    const put = (x, y, z, s, c, a) => {
      if (n >= pool.max) return;
      position[n * 3] = x;
      position[n * 3 + 1] = y;
      position[n * 3 + 2] = z;
      sizes[n] = s;
      tint[n * 3] = c.r;
      tint[n * 3 + 1] = c.g;
      tint[n * 3 + 2] = c.b;
      alpha[n] = a;
      n++;
    };

    for (const stem of stems) {
      const light = frame.stems[stem.name];
      stem.on = light?.lit !== false;
      stem.level = light?.level || 0;
      stem.bursts = 0;

      // The arm shimmers with the stem's loudness; a muted arm is nearly gone.
      const armAlpha = stem.on ? (ARM_DIM + Math.min(ARM_LOUD, stem.level * 0.3)) * stem.armGain : ARM_MUTED;
      if (Math.abs(armAlpha - stem.arm.shown) > 0.004) {
        stem.arm.shown = armAlpha;
        stem.arm.geometry.attributes.alpha.array.fill(armAlpha);
        stem.arm.geometry.attributes.alpha.needsUpdate = true;
      }
      // A muted stem's notes make no light.
      if (!stem.on || !stem.notes.length) continue;

      const [from, to] = noteWindow(stem.notes, time, stem.longest);
      for (let i = from; i < to; i++) {
        const note = stem.notes[i];
        const age = time - note.start;
        const at = notePoint(note, stem.index, count, range);
        const big = velocitySize(note.velocity);
        const glow = holdGlow(note, time);
        // The note itself, for as long as it sounds.
        // Clearly brighter than any particle of its burst.
        if (glow > 0) put(at.x, 0, at.z, big * 2.1, stem.color, glow);
        // Its burst.
        if (age <= BURST_SECONDS) {
          stem.bursts++;
          const seed = stem.index * 100003 + i;
          const many = calm ? 0 : burstCount(note.velocity, quality);
          for (let k = 0; k < many; k++) {
            const p = particle(seed, k, age);
            put(at.x + p.dx, p.dy, at.z + p.dz, big * 0.5, stem.color, p.alpha);
          }
        }
      }
    }
    pool.used = n;
    pool.geometry.setDrawRange(0, n);
    for (const key of ["position", "size", "tint", "alpha"]) pool.geometry.attributes[key].needsUpdate = true;
  }

  function resize(next) {
    camera.aspect = next.width / next.height;
    frameCamera(camera.aspect);
    camera.updateProjectionMatrix();
    uniforms.scale.value = next.height * 0.9;
  }

  function setQuality(level) {
    const next = Math.max(0, Math.min(2, level));
    if (next === quality) return;
    quality = next;
    rebuild();
  }

  function dispose() {
    for (const d of disposables.slice()) d.dispose();
  }

  return {
    scene,
    camera,
    bloom: calm ? null : { strength: 0.4, radius: 0.18, threshold: 0.55 },
    update,
    resize,
    setQuality,
    dispose,
    debug: () => ({
      range,
      calm,
      quality,
      rim: R_MAX,
      points: pool.used,
      turn: galaxy.rotation.y,
      stems: stems.map((s) => ({ name: s.name, notes: s.notes.length, bursts: s.bursts, on: s.on, arm: s.arm.shown, stars: s.arm.count })),
    }),
  };
}

export default { id: "note-galaxy", needs: { notes: true }, strings, create };
