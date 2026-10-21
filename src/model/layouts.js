// The lower body of the layouts that are not a biped: the frame that quad and spider legs hang from, tank
// treads, and the hover pods. buildLegs() (body.js) hands over here; each builder fills in part of the rig
// (`rig.treads`, `rig.pods`, ...) for the motion layer to animate.

import * as THREE from 'three';

const PI = Math.PI;

/** The chassis under the torso of a quad or a spider: a spine with a hip yoke at every row of legs. */
export function buildFrame(rig) {
  const { k, hips, sk } = rig;
  const { add, M, box, cyl, sph, prow, glow, cyanGlow } = k;
  const rows = sk.lay.rows;
  const front = rows[0].z, rear = rows[rows.length - 1].z;
  const span = rear - front;
  const mid = (front + rear) / 2;

  add(hips, box(2.8, 1.5, span + 3.2), M.dark, 0, -0.15, mid, { edge: true });
  add(hips, box(2.0, 0.5, span + 1.4), M.sub, 0, 0.75, mid, { edge: true });
  add(hips, box(1.2, 0.7, span + 2.6), M.metal, 0, -1.05, mid);
  for (const r of rows) {
    // the yoke each pair of hips swings from, and a drum at every hip joint
    add(hips, box(r.hipX * 2 + 1.2, 1.4, 2.4), M.sub, 0, -0.3, r.z, { edge: true });
    add(hips, box(r.hipX * 2 - 1.0, 0.4, 2.0), M.accent, 0, 0.55, r.z, { edge: true });
    for (const s of [-1, 1]) {
      add(hips, cyl(1.35, 1.35, 1.5, 12), M.metal, s * (r.hipX - 0.2), -0.35, r.z, { rz: PI / 2 });
      add(hips, sph(0.55), glow, s * (r.hipX + 0.6), -0.35, r.z, { shadow: false });
    }
  }
  // a prow plate at the front, an engine block with its vents at the back
  add(hips, prow(3.2, 1.3, 2.2, 0.5), M.accent, 0, 0, front - 2.2, { edge: true });
  const engine = rear + 2.5;
  add(hips, box(3.6, 1.9, 2.6), M.sub, 0, 0.35, engine, { edge: true });
  for (const s of [-1, 1]) add(hips, box(1.1, 0.5, 0.2), cyanGlow, s * 0.95, 0.5, engine + 1.35, { shadow: false });
  add(hips, box(2.4, 0.3, 2.0), M.trim, 0, 1.35, engine);
  rig.holsterAt = { x: -2.9, y: 0.6, z: engine + 0.6 };
  rig.tailAt = { x: 0, y: 0.3, z: engine + 1.4 };
  rig.hullClear = 1.6; // how far the lowest part of the frame hangs below the hip joints' centre line
}

// ------------------------------------------------------------------ treads

const CLEAT = 1.15; // the length of one cleat along the belt
let cleatTex = null;
/** The belt texture: dark rubber with a lighter cleat across each repeat. */
function cleatTexture() {
  if (cleatTex) return cleatTex;
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 32;
  const c = cv.getContext('2d');
  c.fillStyle = '#23272f'; c.fillRect(0, 0, 64, 32);
  c.fillStyle = '#4a5160'; c.fillRect(6, 0, 30, 32);
  c.fillStyle = '#6b7488'; c.fillRect(6, 0, 4, 32);
  c.fillStyle = '#14171c'; c.fillRect(40, 4, 16, 24);
  cleatTex = new THREE.CanvasTexture(cv);
  cleatTex.wrapS = THREE.RepeatWrapping;
  cleatTex.wrapT = THREE.ClampToEdgeWrapping;
  cleatTex.colorSpace = THREE.SRGBColorSpace;
  return cleatTex;
}

const beltCache = new Map();
/** A belt: a stadium loop (two half-circles joined by straights) in the y-z plane, `w` wide, with UVs along its length. */
function beltGeo(R, half, w) {
  const key = `${R},${half},${w}`;
  if (beltCache.has(key)) return beltCache.get(key);
  const seg = 56;
  const per = 4 * half + 2 * PI * R; // the straights are 2 * (2 * half); the ends make one full circle
  const repeats = Math.round(per / CLEAT);
  const pos = [], uv = [], nrm = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const s = (i / seg) * per;
    // walk the loop starting at the bottom, heading back (+z): bottom straight, rear half-circle, top straight, front half-circle
    let y, z, ny, nz;
    const a = 2 * half, c = PI * R;
    if (s < a) { z = -half + s; y = -R; ny = -1; nz = 0; }
    else if (s < a + c) { const t = (s - a) / R; y = -Math.cos(t) * R; z = half + Math.sin(t) * R; ny = -Math.cos(t); nz = Math.sin(t); }
    else if (s < 2 * a + c) { z = half - (s - a - c); y = R; ny = 1; nz = 0; }
    else { const t = (s - 2 * a - c) / R; y = Math.cos(t) * R; z = -half - Math.sin(t) * R; ny = Math.cos(t); nz = -Math.sin(t); }
    for (const [x, v] of [[-w / 2, 0], [w / 2, 1]]) {
      pos.push(x, y, z); nrm.push(0, ny, nz); uv.push((s / per) * repeats, v);
    }
    if (i < seg) { const o = i * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.userData = { per, repeats };
  beltCache.set(key, g);
  return g;
}

const plateCache = new Map();
/** The flat stadium-shaped side plate of a track unit. */
function plateGeo(R, half) {
  const key = `${R},${half}`;
  if (plateCache.has(key)) return plateCache.get(key);
  const sh = new THREE.Shape();
  sh.moveTo(-half, -R);
  sh.lineTo(half, -R);
  sh.absarc(half, 0, R, -PI / 2, PI / 2, false);
  sh.lineTo(-half, R);
  sh.absarc(-half, 0, R, PI / 2, PI * 1.5, false);
  const g = new THREE.ShapeGeometry(sh, 10);
  g.rotateY(-PI / 2); // shape x -> world z, so the plate stands in the y-z plane facing +x
  plateCache.set(key, g);
  return g;
}

/** Two track units under a low hull. `rig.treads` carries each belt's texture and wheels so the motion can roll them. */
export function buildTreads(rig) {
  const { k, hips, sk } = rig;
  const { add, group, M, box, cyl, prow, cyanGlow, flashMats } = k;
  const lay = sk.lay;
  const R = 1.75, half = 3.5, W = 2.7, X = lay.trackX;
  rig.treads = [];

  // the hull between the tracks
  add(hips, box(X * 2 - W - 0.6, 2.0, half * 2 + 1.0), M.dark, 0, -1.5, 0, { edge: true });
  add(hips, box(X * 2 - W - 1.6, 0.5, half * 2 - 0.4), M.sub, 0, -0.4, 0.2, { edge: true });
  add(hips, prow(X * 2 - W - 0.4, 1.8, 3.0, 0.55), M.accent, 0, -1.2, -half - 1.4, { edge: true });
  add(hips, box(3.8, 1.6, 2.4), M.sub, 0, -0.9, half + 0.8, { edge: true });
  for (const s of [-1, 1]) add(hips, box(1.0, 0.4, 0.2), cyanGlow, s * 1.0, -0.8, half + 2.05, { shadow: false });
  rig.holsterAt = { x: -2.9, y: -0.2, z: half + 1.2 };
  rig.tailAt = { x: 0, y: -0.9, z: half + 2.2 };

  const tex = cleatTexture();
  for (const s of [-1, 1]) {
    const unit = group(hips, s * X, -sk.hipY + R, 0);
    const t = tex.clone();
    t.needsUpdate = true;
    t.repeat.set(1, 1);
    const mat = new THREE.MeshStandardMaterial({ map: t, color: 0xffffff, metalness: 0.3, roughness: 0.75, side: THREE.DoubleSide });
    flashMats.push(mat);
    const belt = new THREE.Mesh(beltGeo(R, half, W), mat);
    belt.castShadow = true;
    unit.add(belt);
    // side plate, wheels and a fender
    const wheels = [];
    for (const o of [-1, 1]) {
      const plate = new THREE.Mesh(plateGeo(R - 0.2, half), M.main);
      plate.position.x = o * (W / 2 - 0.05);
      if (o < 0) plate.rotation.y = PI;
      unit.add(plate);
    }
    for (const z of [-half, -half / 2, 0, half / 2, half]) {
      const end = Math.abs(z) === half;
      const w = group(unit, 0, 0, z);
      add(w, cyl(end ? R - 0.15 : 1.05, end ? R - 0.15 : 1.05, W + 0.3, 14), M.steel, 0, 0, 0, { rz: PI / 2 });
      for (const o of [-1, 1]) {
        add(w, cyl(end ? 0.8 : 0.55, end ? 0.8 : 0.55, 0.3, 10), M.trim, o * (W / 2 + 0.2), 0, 0, { rz: PI / 2 });
        add(w, box(0.12, end ? 1.1 : 0.7, 0.2), M.dark, o * (W / 2 + 0.36), 0, 0);
      }
      wheels.push({ g: w, r: end ? R : 1.05 });
    }
    // armoured fender over the belt, and the track's outer guard
    add(unit, box(W + 0.5, 0.45, half * 2 + 3.0), M.accent, 0, R + 0.35, 0, { edge: true });
    add(unit, box(0.3, 1.3, half * 2 + 2.0), M.main, s * (W / 2 + 0.25), R - 0.3, 0, { edge: true });
    rig.treads.push({ unit, tex: t, wheels, side: s, per: beltGeo(R, half, W).userData.per, repeats: beltGeo(R, half, W).userData.repeats, R });
  }
  rig.calfFlames = 0;
  rig.legAnchor = k.node(hips, X, -sk.hipY * 0.55, 0);
}

// ------------------------------------------------------------------ hover

/** A hull riding on four thruster pods. `rig.pods` carries each pod's glow and jet for the motion to pulse. */
export function buildHover(rig) {
  const { k, hips, sk, root } = rig;
  const { add, group, M, box, cyl, sph, cyanGlow } = k;
  const lay = sk.lay;
  rig.pods = [];

  // the hull: a broad octagonal saucer under the pelvis, with a keel
  add(hips, cyl(4.6, 3.6, 1.6, 8), M.dark, 0, -1.1, 0, { edge: true });
  add(hips, cyl(3.6, 3.0, 0.6, 8), M.sub, 0, -2.2, 0, { edge: true });
  add(hips, cyl(2.1, 1.6, 0.8, 8), M.metal, 0, -2.9, 0);
  add(hips, sph(1.0), cyanGlow, 0, -3.35, 0, { shadow: false });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * PI * 2 + PI / 8;
    add(hips, box(0.9, 0.3, 1.5), M.trim, Math.sin(a) * 4.5, -0.6, Math.cos(a) * 4.5, { ry: a, edge: true });
  }
  rig.holsterAt = { x: -2.9, y: -0.5, z: 3.4 };
  rig.tailAt = { x: 0, y: -1.2, z: 3.6 };

  const lift = sk.hipY; // the pods' height above the ground is hipY - 2.2
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * lay.podX, pz = sz * lay.podZ;
      add(hips, box(Math.abs(px) * 0.9, 0.5, 0.7), M.sub, px * 0.5, -1.6, pz * 0.55, { ry: Math.atan2(px, pz) + PI / 2, edge: true }); // strut
      const pod = group(hips, px, -2.2, pz);
      add(pod, cyl(2.0, 1.7, 1.2, 14), M.sub, 0, 0, 0, { edge: true });
      add(pod, cyl(2.15, 2.15, 0.25, 14), M.accent, 0, 0.45, 0, { edge: true });
      add(pod, cyl(1.35, 1.35, 0.15, 14), cyanGlow, 0, -0.65, 0, { shadow: false });
      add(pod, cyl(0.55, 0.55, 0.9, 8), M.metal, 0, 0.9, 0);
      // the jet: a soft cone from the pod's underside toward the ground
      const jetLen = lift - 2.2 - 1.3; // stops short of the ground, so a dip of the hull never pushes it through
      const jet = new THREE.Mesh(k.cone(1.35, jetLen), new THREE.MeshBasicMaterial({
        color: 0x6adfff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      }));
      jet.position.y = -0.7 - jetLen / 2;
      jet.rotation.x = PI; // wide at the pod, narrowing to the ground
      jet.scale.set(0.6, 1, 0.6);
      pod.add(jet);
      rig.pods.push({ g: pod, jet, jetMat: jet.material, len: jetLen, sx, sz });
    }
  }
  // a glowing ring on the ground under the hull, pulsing with the lift
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 5.6, 32), new THREE.MeshBasicMaterial({
    color: 0x6adfff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  ring.rotation.x = -PI / 2;
  ring.position.y = 0.08;
  root.add(ring);
  rig.groundRing = ring;
  rig.calfFlames = 0;
  rig.legAnchor = k.node(hips, 0, -2.9, 0);
}
