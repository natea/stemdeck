// Drive the song: a road that passes at the song's tempo. Bar lines are
// markers across it, drum hits are bumps on it, the other stems are rows of
// posts beside it as tall as they are loud, and each section is a change of
// scenery: the colour of the land and the sky.
//
// The mapping is map.js (plain numbers, tested under node). This file only
// builds the road. LOOK.md has the art direction.

import { strings } from "./strings.js";
import {
  UNITS_PER_BEAT, ROAD_WIDTH, VIEW_DISTANCE, CALM_PAGE_BEATS,
  makeTrack, barMarkers, levelAt, drumHits, bumpAt, laneOffset, balanceRows, postHeight, postPlaces, sectionAt, placement,
} from "./map.js";

const SKY = 0x060a12;
const LAND = 0x0c141d;
const ROAD = 0x151c25;
// How much of its light a muted stem keeps. A material's colour is linear
// light: this is about a seventh of the brightness on screen.
const MUTED = 0.02;
const EYE = 2.3; // the viewer's height above the road
const FAR = 4000;

function create({ THREE, song, size, reducedMotion }) {
  const calm = Boolean(reducedMotion);
  const track = makeTrack(song);
  const drums = song.stems.find((s) => s.name === "drums") || null;
  const found = drumHits(drums, song.duration);
  const hitTimes = found.hits.map((h) => h.time);
  const others = song.stems.filter((s) => s.name !== "drums");

  const scene = new THREE.Scene();
  const sky = new THREE.Color(SKY);
  scene.background = sky;
  scene.fog = new THREE.Fog(SKY, 30, VIEW_DISTANCE[2]);
  const camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.3, 600);

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x0a0f16, 1.3));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(-8, 20, 6);
  scene.add(sun);

  const disposables = [];
  const keep = (x) => {
    disposables.push(x);
    return x;
  };
  const box = keep(new THREE.BoxGeometry(1, 1, 1));
  const flat = (color) => keep(new THREE.MeshBasicMaterial({ color }));
  const matrix = new THREE.Matrix4();
  const tint = new THREE.Color();
  const length = track.length + 40;

  // The world: everything at its distance along -z.
  const world = new THREE.Group();
  scene.add(world);

  // Land either side, coloured by section; the road down the middle.
  const landMaterial = keep(new THREE.MeshBasicMaterial({ color: LAND }));
  const land = new THREE.Mesh(box, landMaterial);
  land.scale.set(FAR, 0.1, length + FAR);
  land.position.set(0, -0.12, -length / 2);
  world.add(land);
  const road = new THREE.Mesh(box, flat(ROAD));
  road.scale.set(ROAD_WIDTH, 0.1, length + 200);
  road.position.set(0, -0.05, -length / 2);
  world.add(road);
  // Kerbs, so the road's edges read at any distance.
  for (const side of [-1, 1]) {
    const kerb = new THREE.Mesh(box, flat(0x33404e));
    kerb.scale.set(0.18, 0.12, length + 200);
    kerb.position.set(side * (ROAD_WIDTH / 2 + 0.09), 0.01, -length / 2);
    world.add(kerb);
  }

  // Sections: a strip of land either side in the section's colour.
  const sections = song.sections.map((s) => ({ ...s, from: track.distanceAt(s.start), to: track.distanceAt(s.end), color: new THREE.Color(s.color || "#88a8c8") }));
  if (sections.length) {
    const strips = new THREE.InstancedMesh(box, keep(new THREE.MeshBasicMaterial()), sections.length * 2);
    sections.forEach((s, i) => {
      const span = Math.max(0.5, s.to - s.from - 0.6);
      tint.copy(s.color).multiplyScalar(0.035);
      for (const [k, side] of [[0, -1], [1, 1]]) {
        matrix.makeScale(60, 0.1, span).setPosition(side * (ROAD_WIDTH / 2 + 30.4), -0.06, -(s.from + 0.3 + span / 2));
        strips.setMatrixAt(i * 2 + k, matrix);
        strips.setColorAt(i * 2 + k, tint);
      }
    });
    strips.frustumCulled = false;
    world.add(strips);
  }

  // Bar lines across the road, and a dash down the middle on every beat.
  const bars = barMarkers(song, track);
  if (bars.length) {
    const lines = new THREE.InstancedMesh(box, flat(0xb8c4d0), bars.length);
    // A step toward the viewer, so a bump on the downbeat does not hide it.
    bars.forEach((d, i) => lines.setMatrixAt(i, matrix.makeScale(ROAD_WIDTH, 0.04, 0.2).setPosition(0, 0.02, -d + 0.42)));
    lines.frustumCulled = false;
    world.add(lines);
  }
  if (track.beatsKnown) {
    const dashes = new THREE.InstancedMesh(box, flat(0x4a5766), song.beats.length);
    song.beats.forEach((time, i) => dashes.setMatrixAt(i, matrix.makeScale(0.16, 0.03, 1.6).setPosition(0, 0.015, -track.distanceAt(time))));
    dashes.frustumCulled = false;
    world.add(dashes);
  }

  // Drum hits: a bump across the road, taller for a harder hit.
  const drumColor = new THREE.Color(drums?.color || "#e89048");
  // Darker than the posts' caps, which are the brightest things on the road.
  const BUMP = 0.4;
  const bumpMaterial = keep(new THREE.MeshLambertMaterial({ color: drumColor.clone().multiplyScalar(BUMP), flatShading: true }));
  if (found.hits.length) {
    const bumps = new THREE.InstancedMesh(box, bumpMaterial, found.hits.length);
    found.hits.forEach((h, i) => {
      // Low and thin: dark road shows between them even in a busy drum part.
      const tall = 0.05 + h.strength * 0.2;
      bumps.setMatrixAt(i, matrix.makeScale(ROAD_WIDTH * (0.4 + 0.5 * h.strength), tall, 0.24).setPosition(0, tall / 2, -track.distanceAt(h.time)));
    });
    bumps.frustumCulled = false;
    world.add(bumps);
  }

  // The other stems: a row of posts each, as tall as the stem is loud there.
  let quality = 2;
  // Rows are shared out so both sides of the road carry about the same number
  // of posts; a stem that is silent all through takes no row.
  const allPlaces = postPlaces(track);
  const rows = balanceRows(others.map((stem) => allPlaces.reduce((n, p) => n + (levelAt(stem.peaks, song.duration, p.time) > 0.004 ? 1 : 0), 0)));
  const stems = others.map((stem, i) => ({
    name: stem.name,
    source: stem,
    color: new THREE.Color(stem.color),
    x: rows[i] >= 0 ? laneOffset(rows[i]) : 0,
    material: keep(new THREE.MeshLambertMaterial({ flatShading: true })),
    cap: keep(new THREE.MeshBasicMaterial()),
    meshes: [],
    posts: 0,
    on: null,
  }));
  function buildPosts() {
    const places = postPlaces(track, quality === 0 ? 2 : 1);
    for (const stem of stems) {
      for (const m of stem.meshes) {
        world.remove(m);
        m.dispose();
      }
      const shafts = new THREE.InstancedMesh(box, stem.material, places.length);
      const caps = new THREE.InstancedMesh(box, stem.cap, places.length);
      let n = 0;
      for (const p of places) {
        const level = levelAt(stem.source.peaks, song.duration, p.time);
        if (!(level > 0.004)) continue; // silence is an empty verge
        const tall = postHeight(level);
        shafts.setMatrixAt(n, matrix.makeScale(0.5, tall, 0.5).setPosition(stem.x, tall / 2, -p.distance));
        caps.setMatrixAt(n, matrix.makeScale(0.58, 0.2, 0.58).setPosition(stem.x, tall + 0.1, -p.distance));
        n++;
      }
      shafts.count = caps.count = n;
      shafts.frustumCulled = caps.frustumCulled = false;
      world.add(shafts, caps);
      stem.meshes = [shafts, caps];
      stem.posts = n;
    }
  }
  buildPosts();

  // The calm version's marker: a small car that travels the page.
  const car = new THREE.Mesh(box, flat(0xf2f5f8));
  car.scale.set(1.5, 0.7, 2.6);
  car.visible = calm;
  world.add(car);

  let distance = 0;
  let pace = track.paceAt(0);
  let lift = 0;
  let section = -1;
  let drumsOn = true;

  function update(frame) {
    const time = frame.time;
    distance = track.distanceAt(time);
    pace = track.paceAt(time);
    const at = placement(distance, calm);

    for (const stem of stems) {
      const on = frame.stems[stem.name]?.lit !== false;
      if (on === stem.on) continue;
      stem.on = on;
      stem.material.color.copy(stem.color).multiplyScalar(on ? 0.62 : MUTED);
      // Caps are lit to the same brightness whatever the stem's hue, enough to glow.
      const light = 0.2126 * stem.color.r + 0.7152 * stem.color.g + 0.0722 * stem.color.b;
      // Bright, but short of burning out: a cap stays its stem's colour.
      stem.cap.color.copy(stem.color).multiplyScalar(on ? Math.min(2.4, 0.85 / Math.max(0.05, light)) : MUTED * 2);
    }
    const dOn = frame.stems.drums?.lit !== false;
    if (dOn !== drumsOn) {
      drumsOn = dOn;
      bumpMaterial.color.copy(drumColor).multiplyScalar(dOn ? BUMP : MUTED);
    }

    // Scenery: the sky and the far land take the section's colour.
    const s = sectionAt(time, song.sections);
    if (s !== section) {
      section = s;
      if (s >= 0) {
        // A tint: it is still night.
        sky.set(SKY).lerp(sections[s].color, 0.025);
        landMaterial.color.set(LAND).lerp(sections[s].color, 0.02);
      } else {
        sky.set(SKY);
        landMaterial.color.set(LAND);
      }
      scene.fog.color.copy(sky);
    }

    if (calm) {
      // Nothing travels but the marker: the viewer stands above one page.
      const page = CALM_PAGE_BEATS * UNITS_PER_BEAT;
      lift = 0;
      camera.position.set(0, 46, -(at.viewer - 22));
      camera.lookAt(0, 0, -(at.viewer + page * 0.45));
      car.position.set(0, 0.4, -at.marker);
    } else {
      // A muted drum stem makes no bumps.
      lift = drumsOn ? bumpAt(found.hits, time, hitTimes) : 0;
      camera.position.set(0, EYE + lift * 0.55, -(distance - 5));
      camera.lookAt(0, EYE * 0.55 + lift * 0.2, -(distance + 30));
    }
  }

  function setFog() {
    // The fog starts close: seen from eye height, the last stretch of road is
    // only a few pixels tall, and a fog that began far away would never show.
    const far = calm ? 400 : VIEW_DISTANCE[quality];
    scene.fog.near = calm ? 140 : far * 0.14;
    scene.fog.far = far;
  }
  setFog();

  function resize(next) {
    camera.aspect = next.width / next.height;
    camera.updateProjectionMatrix();
  }

  function setQuality(level) {
    const next = Math.max(0, Math.min(2, level));
    if (next === quality) return;
    const rebuild = (next === 0) !== (quality === 0);
    quality = next;
    setFog();
    if (rebuild) buildPosts();
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
    bloom: calm ? null : { strength: 0.25, radius: 0.08, threshold: 0.7 },
    update,
    resize,
    setQuality,
    dispose,
    debug: () => ({
      calm,
      quality,
      distance,
      pace,
      lift,
      section,
      beatsKnown: track.beatsKnown,
      bars: bars.length,
      hits: found.hits.length,
      hitsFrom: found.from,
      drumsOn,
      cameraZ: camera.position.z,
      cameraY: camera.position.y,
      stems: stems.map((s) => ({ name: s.name, posts: s.posts, x: s.x, tint: s.cap.color.getHex() })),
    }),
  };
}

export default { id: "drive-the-song", needs: { notes: false }, strings, create };
