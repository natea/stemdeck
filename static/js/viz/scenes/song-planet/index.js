// Song planet: the whole song wrapped once around a small world. Each stem is
// a band of terrain raised by its loudness, each section a region of ground in
// its own colour, and the viewpoint travels round the planet as the song plays,
// so that one lap is one song. Where a stem has notes, small crystals stand on
// its band at their pitches.
//
// The mapping is map.js (plain numbers, tested under node). This file only
// builds the meshes. LOOK.md has the art direction.

import { strings } from "./strings.js";
import {
  RADIUS, LIFT, SEGMENTS, NOTE_CAP, CAMERA_DISTANCE,
  timeToAngle, surfacePoint, cameraPlace, angleOf, bandLatitudes, stepLevel, lift, loudestOf, profile,
  sectionAt, pitchSpan, notePlace, thin,
} from "./map.js";

const BACKGROUND = 0x04070d;
const GROUND = 0x1a2633; // ground that belongs to no section
// How much of its light a muted band keeps. A material's colour is linear
// light: this is about a seventh of the brightness on screen.
const MUTED = 0.02;
// How much of its light the half of the song still to come keeps (linear
// light again: about half the brightness on screen).
const AHEAD = 0.36;
const ROWS = 4; // strips across one band

function create({ THREE, song, size, reducedMotion }) {
  const calm = Boolean(reducedMotion);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  const camera = new THREE.PerspectiveCamera(40, size.width / size.height, 1, 400);
  scene.add(camera);
  let fit = 1;
  function setFit(aspect) {
    fit = Math.max(1, 1.25 / Math.max(0.4, aspect));
  }
  setFit(size.width / size.height);

  // The light rides with the viewpoint, so the side being looked at is the lit one.
  // The light from below is not dark: the southern rings face away from the sun.
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x4a5a70, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.position.set(-14, 16, 10);
  camera.add(sun);

  const disposables = [];
  const keep = (x) => {
    disposables.push(x);
    return x;
  };
  const box = keep(new THREE.BoxGeometry(1, 1, 1));
  const matrix = new THREE.Matrix4();
  const tint = new THREE.Color();
  const sectionTint = new THREE.Color();
  const bands = bandLatitudes(song.stems.length);

  // The planet turns in the calm version; in motion it holds still and the
  // viewpoint goes round it.
  const planet = new THREE.Group();
  scene.add(planet);
  // What marks the present moment hangs off this, turned to its meridian.
  const present = new THREE.Group();
  scene.add(present);

  // A patch of the sphere as a grid of quads: `columns` around, `rows` across,
  // each vertex placed and coloured by `at(column, row)`.
  function patch(columns, rows, at) {
    const position = new Float32Array((columns + 1) * (rows + 1) * 3);
    const color = new Float32Array((columns + 1) * (rows + 1) * 3);
    for (let c = 0; c <= columns; c++) {
      for (let r = 0; r <= rows; r++) {
        const v = at(c % columns, r, c);
        const i = (c * (rows + 1) + r) * 3;
        position.set([v.x, v.y, v.z], i);
        color.set([v.r, v.g, v.b], i);
      }
    }
    const index = [];
    for (let c = 0; c < columns; c++) {
      for (let r = 0; r < rows; r++) {
        const a = c * (rows + 1) + r;
        const b = (c + 1) * (rows + 1) + r;
        // Wound so the face looks outward (r runs north to south).
        index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const geometry = keep(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    return geometry;
  }

  let quality = 2;
  let built = [];
  const stems = song.stems.map((stem, i) => ({
    name: stem.name,
    source: stem,
    band: bands[i],
    color: new THREE.Color(stem.color),
    loudest: loudestOf(stem.peaks),
    span: pitchSpan(stem.notes),
    material: keep(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })),
    crystal: keep(new THREE.MeshLambertMaterial({ flatShading: true })),
    on: null,
    crystals: 0,
  }));

  function build() {
    for (const mesh of built) {
      planet.remove(mesh);
      if (mesh.isInstancedMesh) mesh.dispose();
      mesh.geometry !== box && mesh.geometry.dispose();
      const i = disposables.indexOf(mesh.geometry);
      if (i >= 0 && mesh.geometry !== box) disposables.splice(i, 1);
    }
    built = [];
    const columns = SEGMENTS[quality];

    // The ground: each section's stretch in its own colour, pole to pole.
    const ground = patch(columns, 18, (c, r) => {
      const time = ((c + 0.5) / columns) * song.duration;
      const s = sectionAt(time, song.sections);
      // A tint of the section's colour over the ground, not a bright ribbon.
      tint.set(GROUND);
      if (s >= 0) tint.lerp(sectionTint.set(song.sections[s].color || "#88a8c8"), 0.16);
      const p = surfacePoint((c / columns) * Math.PI * 2, 90 - (r / 18) * 180, RADIUS);
      return { ...p, r: tint.r, g: tint.g, b: tint.b };
    });
    const groundMesh = new THREE.Mesh(ground, groundMaterial);
    planet.add(groundMesh);
    built.push(groundMesh);

    for (const stem of stems) {
      // Terrain: a ridge along the band, as high as the stem is loud there.
      const levels = Array.from({ length: columns }, (_, c) => stepLevel(stem.source.peaks, c, columns));
      const terrain = patch(columns, ROWS, (c, r) => {
        const across = r / ROWS; // 0 at the north edge
        const level = Math.max(levels[c], levels[(c + columns - 1) % columns]);
        const shape = profile(across);
        const p = surfacePoint(
          (c / columns) * Math.PI * 2,
          stem.band.north - across * (stem.band.north - stem.band.south),
          RADIUS + 0.04 + lift(level, stem.loudest) * shape,
        );
        // Brighter where it is louder and along the crest.
        const loud = stem.loudest > 0 ? level / stem.loudest : 0;
        const k = (0.16 + 0.84 * Math.pow(loud, 1.3)) * (0.5 + 0.5 * shape);
        return { ...p, r: stem.color.r * k, g: stem.color.g * k, b: stem.color.b * k };
      });
      const mesh = new THREE.Mesh(terrain, stem.material);
      planet.add(mesh);
      built.push(mesh);

      // Notes: a crystal each, at its moment and its pitch, as tall as it was hit.
      stem.crystals = 0;
      const notes = stem.source.notes;
      if (!notes || !notes.length || !stem.span) continue;
      const stride = thin(notes.length, NOTE_CAP[quality]);
      const count = Math.ceil(notes.length / stride);
      const crystals = new THREE.InstancedMesh(box, stem.crystal, count);
      const up = new THREE.Vector3(0, 1, 0);
      const normal = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const where = new THREE.Vector3();
      let n = 0;
      for (let i = 0; i < notes.length; i += stride) {
        const at = notePlace(notes[i], stem.band, stem.span, song.duration);
        // Standing on the terrain as it is drawn there (the lower of the two
        // steps either side), rooted a little below it. Where the ring has
        // sunk to the ground there is nothing to stand on: no crystal.
        const step = Math.min(columns - 1, Math.floor((at.angle / (Math.PI * 2)) * columns));
        const here = Math.min(levels[step], levels[(step + 1) % columns]);
        const rise = lift(here, stem.loudest) * profile(1 - at.across);
        if (rise < 0.1) continue;
        const root = 0.25;
        at.height += root;
        const p = surfacePoint(at.angle, at.latitude, RADIUS + rise - root + at.height / 2);
        where.set(p.x, p.y, p.z);
        normal.copy(where).normalize();
        q.setFromUnitVectors(up, normal);
        scale.set(0.09, at.height, 0.09);
        crystals.setMatrixAt(n++, matrix.compose(where, q, scale));
      }
      crystals.count = n;
      crystals.instanceMatrix.needsUpdate = true;
      crystals.frustumCulled = false;
      planet.add(crystals);
      built.push(crystals);
      stem.crystals = n;
    }
  }
  const groundMaterial = keep(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  build();

  // The present moment: a bright meridian from pole to pole.
  const lineMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const STEPS = 48;
  const meridian = new THREE.InstancedMesh(box, lineMaterial, STEPS);
  {
    const where = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const north = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const east = new THREE.Vector3(1, 0, 0);
    const basis = new THREE.Matrix4();
    const reach = RADIUS + LIFT + 0.85;
    const arc = (160 / STEPS) * (Math.PI / 180) * reach;
    for (let i = 0; i < STEPS; i++) {
      const latitude = -80 + ((i + 0.5) / STEPS) * 160;
      const p = surfacePoint(0, latitude, reach);
      where.set(p.x, p.y, p.z);
      normal.copy(where).normalize();
      north.crossVectors(normal, east).normalize();
      q.setFromRotationMatrix(basis.makeBasis(east, north, normal));
      meridian.setMatrixAt(i, matrix.compose(where, q, new THREE.Vector3(0.07, arc * 1.02, 0.07)));
    }
  }
  meridian.frustumCulled = false;
  present.add(meridian);

  // The half of the song still to come lies under a thin shadow.
  // High enough to lie over the crystals too.
  const veilGeometry = keep(new THREE.SphereGeometry(RADIUS + LIFT + 0.75, 40, 20, 0, Math.PI));
  const veil = new THREE.Mesh(veilGeometry, keep(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 1 - AHEAD, depthWrite: false })));
  veil.rotation.y = Math.PI / 2; // the half toward growing longitude
  present.add(veil);

  // A thin rim of air: clear over the planet's face, a faint blue at its limb.
  const air = new THREE.Mesh(
    keep(new THREE.SphereGeometry(RADIUS + LIFT + 1.0, 72, 36)),
    keep(new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          float rim = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 5.0);
          gl_FragColor = vec4(vec3(0.16, 0.36, 0.62) * rim * 0.45, 1.0);
        }`,
    })),
  );
  scene.add(air);
  // Far stars that do not move.
  const starPositions = new Float32Array(500 * 3);
  for (let i = 0; i < 500; i++) {
    // Evenly over a far sphere, the same every time.
    const y = 1 - (2 * (i + 0.5)) / 500;
    const around = i * 2.399963;
    const ring = Math.sqrt(1 - y * y);
    starPositions.set([Math.cos(around) * ring * 150, y * 150, Math.sin(around) * ring * 150], i * 3);
  }
  const starGeometry = keep(new THREE.BufferGeometry());
  starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  scene.add(new THREE.Points(starGeometry, keep(new THREE.PointsMaterial({ color: 0x8fa3b8, size: 1.6, sizeAttenuation: false }))));

  let angle = 0;

  function place() {
    if (calm) {
      // Nothing travels: the viewpoint stays and the planet turns under it.
      planet.rotation.y = -angle;
      present.rotation.y = 0;
      const p = cameraPlace(0, CAMERA_DISTANCE * fit);
      camera.position.set(p.x, p.y, p.z);
    } else {
      planet.rotation.y = 0;
      present.rotation.y = angle;
      const p = cameraPlace(angle, CAMERA_DISTANCE * fit);
      camera.position.set(p.x, p.y, p.z);
    }
    camera.lookAt(0, 0, 0);
  }

  function update(frame) {
    angle = timeToAngle(frame.time, song.duration);
    place();
    for (const stem of stems) {
      const on = frame.stems[stem.name]?.lit !== false;
      if (on === stem.on) continue;
      stem.on = on;
      stem.material.color.setScalar(on ? 1 : MUTED);
      // Crystals are a paler shade of the stem, so they stand off the terrain.
      stem.crystal.color.copy(stem.color).lerp(tint.set(0xffffff), 0.45).multiplyScalar(on ? 1 : MUTED);
    }
  }

  function resize(next) {
    camera.aspect = next.width / next.height;
    setFit(camera.aspect);
    camera.updateProjectionMatrix();
    place();
  }

  function setQuality(level) {
    const next = Math.max(0, Math.min(2, level));
    if (next === quality) return;
    quality = next;
    build();
  }

  function dispose() {
    scene.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
    });
    for (const d of disposables.slice()) d.dispose();
  }

  place();

  return {
    scene,
    camera,
    bloom: calm ? null : { strength: 0.3, radius: 0.25, threshold: 0.92 },
    update,
    resize,
    setQuality,
    dispose,
    debug: () => ({
      calm,
      quality,
      // The longitude of the present moment, and the one the viewpoint is over.
      angle,
      viewAngle: calm ? (((-planet.rotation.y) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) : angleOf(camera.position.x, camera.position.z),
      cameraDistance: camera.position.length(),
      sections: song.sections.length,
      bands,
      stems: stems.map((s) => ({ name: s.name, tint: s.material.color.getHex(), crystals: s.crystals })),
    }),
  };
}

export default { id: "song-planet", needs: { notes: false }, strings, create };
