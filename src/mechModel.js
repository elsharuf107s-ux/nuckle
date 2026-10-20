// Procedural mobile-suit model + animation rig. Everything is built from boxes, cylinders and
// cones, so no model files are needed. Geometry is shared between all mechs; materials are
// per-mech so a hit-flash only lights up the mech that was hit.

import * as THREE from 'three';
import { clamp, damp, lerp } from './util.js';

export const HIP_Y = 9.9; // hip height that puts the soles of the feet at y = 0
export const MECH_HEIGHT = 18.5;

// ------------------------------------------------------------------ shared geometry

const geoCache = new Map();
const edgeCache = new Map();
const cached = (key, make) => {
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = make()));
  return g;
};
const boxGeo = (w, h, d) => cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cylGeo = (rt, rb, h, seg = 12) => cached(`c${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
const sphGeo = (r, ws = 14, hs = 10) => cached(`s${r},${ws},${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
const coneGeo = (r, h, seg = 10) => cached(`k${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg, 1, true));
const edgesOf = (geo) => {
  let e = edgeCache.get(geo);
  if (!e) edgeCache.set(geo, (e = new THREE.EdgesGeometry(geo)));
  return e;
};
const EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x0a0d14, transparent: true, opacity: 0.6 });

// ------------------------------------------------------------------ builder

export function buildMech(spec) {
  const P = spec.palette;
  const bulk = spec.bulk ?? 1;
  const flashMats = [];

  const std = (color, { metal = 0.3, rough = 0.5 } = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });
    flashMats.push(m);
    return m;
  };
  const M = {
    main: std(P.main),
    sub: std(P.sub),
    accent: std(P.accent),
    trim: std(P.trim),
    dark: std(P.dark, { metal: 0.5, rough: 0.6 }),
    metal: std(0x8a92a6, { metal: 0.85, rough: 0.35 }),
  };
  const glowMat = new THREE.MeshBasicMaterial({ color: P.glow });

  const add = (parent, geo, mat, x = 0, y = 0, z = 0, opts = {}) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    if (opts.rx) mesh.rotation.x = opts.rx;
    if (opts.ry) mesh.rotation.y = opts.ry;
    if (opts.rz) mesh.rotation.z = opts.rz;
    mesh.castShadow = opts.shadow !== false;
    if (opts.edge) mesh.add(new THREE.LineSegments(edgesOf(geo), EDGE_MAT));
    parent.add(mesh);
    return mesh;
  };
  const group = (parent, x = 0, y = 0, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };

  const root = new THREE.Group();
  const hips = group(root, 0, HIP_Y, 0);

  // ---- pelvis & skirt armour
  add(hips, boxGeo(3.8, 1.5, 2.8), M.dark, 0, 0, 0, { edge: true });
  add(hips, boxGeo(1.9, 2.0, 0.6), M.accent, 0, -1.2, -1.55, { rx: 0.15, edge: true });
  add(hips, boxGeo(2.6, 1.6, 0.6), M.accent, 0, -0.9, 1.6, { rx: -0.1, edge: true });
  for (const s of [-1, 1]) add(hips, boxGeo(0.7, 2.0, 2.3), M.accent, s * 2.3, -1.0, 0, { rz: s * 0.12, edge: true });

  // ---- legs
  const legs = [];
  const flames = [];
  const makeFlame = (parent, x, y, z, rx, radius, length) => {
    const g = group(parent, x, y, z);
    g.rotation.x = rx;
    const mat = new THREE.MeshBasicMaterial({
      color: P.flame ?? 0x58c8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const cone = new THREE.Mesh(coneGeo(radius, length), mat);
    cone.position.y = length / 2; // base on the nozzle, tip pointing out along +Y
    g.add(cone);
    const core = new THREE.Mesh(coneGeo(radius * 0.45, length * 0.7), new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    core.position.y = length * 0.35;
    g.add(core);
    g.scale.y = 0.0001;
    g.visible = false;
    flames.push(g);
    return g;
  };

  // leg styles change widths and add armour; heights stay put so the feet always meet the ground
  const LEG = {
    std:    { x: 1.8,  thigh: [2.1, 3.7, 2.3], shin: [2.2, 4.0, 2.6], foot: [2.4, 1.0, 4.2] },
    sprint: { x: 1.7,  thigh: [1.7, 3.7, 1.9], shin: [1.8, 4.0, 2.1], foot: [2.0, 1.0, 4.4] },
    tank:   { x: 2.15, thigh: [2.7, 3.7, 2.9], shin: [2.9, 4.0, 3.3], foot: [3.1, 1.0, 4.6] },
    jump:   { x: 1.85, thigh: [2.0, 3.7, 2.2], shin: [2.2, 4.0, 2.6], foot: [2.4, 1.0, 4.2] },
  };
  const legStyle = spec.legs && LEG[spec.legs] ? spec.legs : 'std';
  const L = LEG[legStyle];

  for (const s of [-1, 1]) {
    const leg = group(hips, s * L.x, -0.5, 0);
    add(leg, sphGeo(1.0), M.dark);
    add(leg, boxGeo(...L.thigh), M.main, 0, -2.0, 0, { edge: true });
    add(leg, boxGeo(L.thigh[0] - 0.2, 1.0, 0.5), M.sub, 0, -3.5, -(L.thigh[2] / 2 + 0.15), { edge: true });
    const shin = group(leg, 0, -4.0, 0);
    add(shin, cylGeo(0.95, 0.95, L.thigh[0] - 0.1), M.dark, 0, 0, 0, { rz: Math.PI / 2 });
    add(shin, boxGeo(...L.shin), M.main, 0, -2.3, 0.2, { edge: true });
    add(shin, boxGeo(L.shin[0] - 0.4, 2.6, 1.2), M.sub, 0, -2.0, L.shin[2] / 2 + 0.5, { edge: true });
    add(shin, boxGeo(L.shin[0] - 0.6, 2.6, 0.4), M.accent, 0, -2.4, -(L.shin[2] / 2), { edge: true });
    add(shin, boxGeo(1.4, 0.8, 1.6), M.dark, 0, -4.4, 0);
    const foot = group(shin, 0, -4.8, 0);
    add(foot, boxGeo(...L.foot), M.sub, 0, -0.1, -0.7, { edge: true });
    add(foot, boxGeo(L.foot[0] - 0.4, 0.7, 1.2), M.main, 0, 0, -3.0, { edge: true });
    add(foot, boxGeo(L.foot[0] - 0.8, 0.8, 0.9), M.main, 0, 0, 1.4);

    if (legStyle === 'sprint') {
      add(foot, boxGeo(0.4, 1.4, 1.8), M.trim, 0, 0.2, 2.3, { rx: 0.45 });            // heel spur
      add(shin, boxGeo(0.3, 3.0, 0.5), M.trim, 0, -2.3, -(L.shin[2] / 2 + 0.1));      // shin stripe
    } else if (legStyle === 'tank') {
      add(leg, boxGeo(L.thigh[0] + 0.2, 1.7, 1.1), M.accent, 0, -3.7, -(L.thigh[2] / 2 + 0.2), { edge: true }); // knee armour
      add(shin, boxGeo(L.shin[0] + 0.4, 0.8, L.shin[2] + 0.4), M.dark, 0, -3.9, 0.2);                          // ankle skirt
      add(foot, boxGeo(L.foot[0], 0.5, 1.6), M.accent, 0, 0.45, -2.7, { edge: true });                          // toe plate
    } else if (legStyle === 'jump') {
      add(shin, cylGeo(1.1, 1.3, 3.6, 10), M.metal, 0, -2.1, 3.0);                    // calf booster pod
      add(shin, cylGeo(1.15, 1.15, 0.4, 10), M.accent, 0, -0.8, 3.0);
    }

    // calf thruster (points down and back); jump legs carry a much bigger one
    if (legStyle === 'jump') makeFlame(shin, 0, -3.9, 3.0, Math.PI - 0.2, 0.95, 4.8);
    else makeFlame(shin, 0, -3.4, 2.4, Math.PI - 0.35, 0.55, 3.6);
    legs.push({ leg, shin, foot, side: s });
  }

  // ---- torso
  const torsoStyle = spec.torso ?? 'std';
  const torso = group(hips, 0, 0.8, 0);
  const depth = torsoStyle === 'light' ? 3.2 : 3.7;
  const zf = -(depth / 2 + 0.1); // chest front face
  add(torso, cylGeo(1.8, 2.0, 1.0), M.dark, 0, 0.3, 0);
  add(torso, boxGeo(5.2 * bulk, 3.2, depth), M.sub, 0, 2.1, 0, { edge: true });
  add(torso, boxGeo(5.5 * bulk, 1.0, depth + 0.2), M.main, 0, 4.1, 0, { edge: true });
  for (const s of [-1, 1]) add(torso, boxGeo(1.4, 0.9, 0.3), M.trim, s * 1.4 * bulk, 2.6, zf, { edge: true });
  add(torso, boxGeo(1.7, 1.5, 0.3), M.accent, 0, 1.1, zf, { edge: true });
  add(torso, cylGeo(0.6, 0.7, 0.8), M.dark, 0, 4.8, 0);
  if (torsoStyle === 'light') {
    for (let i = 0; i < 3; i++) add(torso, boxGeo(3.4 * bulk, 0.22, 0.3), M.dark, 0, 1.6 + i * 0.55, zf + 0.15);
  } else if (torsoStyle === 'heavy') {
    add(torso, boxGeo(4.6 * bulk, 2.4, 0.7), M.main, 0, 2.3, zf - 0.3, { edge: true });             // slab armour
    add(torso, boxGeo(6.0 * bulk, 0.5, depth + 0.4), M.accent, 0, 4.85, 0, { edge: true });         // collar
    for (const s of [-1, 1]) add(torso, boxGeo(0.9, 2.8, 2.6), M.dark, s * 3.0 * bulk, 2.0, 0);      // side cheeks
  } else if (torsoStyle === 'reactor') {
    add(torso, boxGeo(2.3, 2.3, 0.4), M.dark, 0, 2.3, zf - 0.05, { edge: true });
    add(torso, boxGeo(1.4, 1.4, 0.5), glowMat, 0, 2.3, zf - 0.2, { shadow: false });                 // glowing core
    for (const s of [-1, 1]) add(torso, boxGeo(0.4, 2.2, 1.7), M.trim, s * 2.75 * bulk, 2.1, -0.4, { edge: true });
  }

  // ---- head
  const head = group(torso, 0, 5.2, 0);
  let eyeNode = null;
  if (spec.head === 'mono') {
    const dome = add(head, sphGeo(1.25, 16, 12), M.main, 0, 1.0, 0, { edge: false });
    dome.scale.set(1, 0.9, 1.05);
    add(head, boxGeo(1.9, 0.8, 1.9), M.dark, 0, 0.2, 0);
    add(head, boxGeo(1.7, 0.3, 0.25), M.dark, 0, 1.0, -1.15);
    eyeNode = add(head, sphGeo(0.3), glowMat, 0, 1.0, -1.25, { shadow: false });
    for (const s of [-1, 1]) add(head, cylGeo(0.2, 0.2, 1.5), M.dark, s * 1.0, 0.7, 0.6, { rx: -0.5 });
    add(head, cylGeo(0.05, 0.05, 2.2), M.dark, -0.7, 2.3, 0.2);
    if (spec.blade) add(head, boxGeo(0.15, 1.9, 1.0), M.trim, 0, 2.2, 0.0, { rx: -0.25 });
  } else if (spec.head === 'visor') {
    add(head, boxGeo(2.3, 1.9, 2.3), M.main, 0, 0.95, 0, { edge: true });
    add(head, boxGeo(2.1, 0.85, 0.4), M.dark, 0, 0.95, -1.15);
    add(head, boxGeo(1.8, 0.3, 0.14), glowMat, 0, 1.0, -1.38, { shadow: false });                    // wide visor slit
    add(head, boxGeo(1.2, 0.5, 0.6), M.accent, 0, 0.2, -1.15, { edge: true });
    add(head, boxGeo(0.3, 0.8, 1.9), M.trim, 0, 2.1, 0.1, { edge: true });                           // crest
    for (const s of [-1, 1]) add(head, boxGeo(0.45, 1.3, 1.8), M.sub, s * 1.3, 0.9, 0.05, { rz: s * 0.08, edge: true });
  } else {
    add(head, boxGeo(2.1, 1.8, 2.2), M.main, 0, 0.9, 0, { edge: true });
    add(head, boxGeo(1.5, 1.0, 0.35), M.dark, 0, 0.8, -1.15);
    add(head, boxGeo(1.0, 0.45, 0.5), M.accent, 0, 0.2, -1.15, { edge: true });
    add(head, boxGeo(0.5, 0.6, 1.6), M.main, 0, 2.0, 0.1, { edge: true });
    for (const s of [-1, 1]) {
      add(head, boxGeo(0.52, 0.2, 0.12), glowMat, s * 0.55, 1.0, -1.36, { shadow: false });
      add(head, boxGeo(0.15, spec.head === 'horn' ? 2.2 : 1.6, 0.12), M.trim, s * 0.5, 2.1, -1.0, { rz: -s * (spec.head === 'horn' ? 0.8 : 0.45) });
      add(head, boxGeo(0.35, 0.3, 0.2), M.trim, s * 0.85, 0.4, -1.1);
    }
    add(head, sphGeo(0.2), M.accent, 0, 1.75, -1.05);
    if (spec.head === 'horn') add(head, coneGeo(0.35, 2.8, 8), M.trim, 0, 2.9, -0.7, { rx: -0.35 }).material.side = THREE.DoubleSide;
  }

  // ---- backpack, thrusters and sabre hilts
  const pack = spec.backpack ?? 'std';
  const packW = { std: 3.6, heavy: 4.6, booster: 4.4, pod: 4.0, wing: 3.6 }[pack] ?? 3.6;
  const big = pack === 'booster'; // oversized nozzles and flames
  add(torso, boxGeo(packW, 3.6, 1.5), M.dark, 0, 2.4, 2.3, { edge: true });
  if (pack === 'heavy') {
    for (const s of [-1, 1]) add(torso, boxGeo(1.2, 1.2, 2.6), M.accent, s * 2.7, 4.4, 2.3, { edge: true });
  } else if (pack === 'booster') {
    for (const s of [-1, 1]) {
      add(torso, cylGeo(0.9, 0.9, 4.2, 10), M.metal, s * 2.8, 2.7, 2.7);                              // fuel tanks
      add(torso, cylGeo(0.96, 0.96, 0.4, 10), M.accent, s * 2.8, 3.8, 2.7);
      add(torso, cylGeo(0.96, 0.96, 0.4, 10), M.accent, s * 2.8, 1.6, 2.7);
    }
  } else if (pack === 'pod') {
    for (const s of [-1, 1]) {
      add(torso, boxGeo(1.8, 1.7, 3.2), M.dark, s * 2.6, 4.9, 2.6, { rx: -0.2, edge: true });          // missile rack
      for (const ox of [-0.45, 0.45]) for (const oy of [-0.38, 0.38]) {
        add(torso, cylGeo(0.3, 0.3, 0.3, 8), M.trim, s * 2.6 + ox, 4.9 + oy, 0.95, { rx: Math.PI / 2 }); // launch tubes
      }
    }
  } else if (pack === 'wing') {
    for (const s of [-1, 1]) {
      add(torso, boxGeo(0.35, 6.0, 2.4), M.main, s * 3.4, 5.4, 2.6, { rz: -s * 0.55, edge: true });   // vernier wings
      add(torso, boxGeo(0.45, 1.4, 2.5), M.accent, s * 4.97, 7.95, 2.6, { rz: -s * 0.55 });
    }
  }
  const NOZZLE_TILT = Math.PI / 2 + 0.5;
  const nk = big ? 1.25 : 1;
  for (const s of [-1, 1]) {
    add(torso, cylGeo(0.95 * nk, 0.6 * nk, 1.4), M.metal, s * 1.1, 0.9, 3.0, { rx: NOZZLE_TILT });
    // flame base: nozzle centre pushed along its axis (0, cos, sin)
    const nx = s * 1.1;
    const ny = 0.9 + Math.cos(NOZZLE_TILT) * 0.7;
    const nz = 3.0 + Math.sin(NOZZLE_TILT) * 0.7;
    makeFlame(torso, nx, ny, nz, NOZZLE_TILT, big ? 1.1 : 0.8, big ? 6.5 : 5.0);
    add(torso, cylGeo(0.18, 0.18, 1.9), M.metal, s * 1.9, 3.7, 2.4, { rz: s * 0.3 });
  }

  // ---- shoulders & arms
  const ARM = {
    std:       { upper: [1.6, 3.0, 1.7], fore: [1.9, 3.4, 2.2] },
    assault:   { upper: [1.9, 3.0, 2.0], fore: [2.5, 3.6, 2.7] },
    precision: { upper: [1.3, 3.0, 1.4], fore: [1.5, 3.4, 1.8] },
    blade:     { upper: [1.6, 3.0, 1.7], fore: [1.9, 3.4, 2.2] },
  };
  const armStyle = spec.arms && ARM[spec.arms] ? spec.arms : 'std';
  const A = ARM[armStyle];
  const arms = {};
  for (const s of [-1, 1]) {
    add(torso, boxGeo(2.6, 2.4, 3.2), spec.shoulder === 'spike' ? M.sub : M.accent, s * (3.95 * bulk), 4.0, 0, { rz: s * 0.1, edge: true });
    add(torso, boxGeo(2.7, 0.4, 3.3), M.trim, s * (3.95 * bulk), 4.95, 0, { rz: s * 0.1 });
    if (spec.shoulder === 'spike') {
      add(torso, coneGeo(0.5, 2.2, 6), M.trim, s * (4.6 * bulk), 5.9, 0, { rz: -s * 0.4 }).material.side = THREE.DoubleSide;
    }
    const arm = group(torso, s * (3.7 * bulk), 3.4, 0);
    arm.rotation.order = 'YXZ';
    add(arm, sphGeo(1.0), M.dark);
    add(arm, boxGeo(...A.upper), M.main, 0, -2.0, 0, { edge: true });
    const elbow = group(arm, 0, -3.6, 0);
    add(elbow, cylGeo(0.8, 0.8, 1.8), M.dark, 0, 0, 0, { rz: Math.PI / 2 });
    add(elbow, boxGeo(...A.fore), M.main, 0, -1.9, 0, { edge: true });
    add(elbow, boxGeo(A.fore[0] + 0.1, 0.6, A.fore[2] + 0.1), M.trim, 0, -3.1, 0);
    if (armStyle === 'assault') {
      add(elbow, boxGeo(A.fore[0] + 0.3, 0.9, A.fore[2] + 0.3), M.accent, 0, -0.5, 0, { edge: true });  // elbow guard
      add(arm, boxGeo(A.upper[0] + 0.3, 1.0, A.upper[2] + 0.3), M.accent, 0, -1.2, 0, { edge: true });
    } else if (armStyle === 'precision') {
      add(elbow, boxGeo(0.35, 1.6, 0.35), M.trim, 0, -1.0, -(A.fore[2] / 2 + 0.1));                       // sensor mast
      add(elbow, sphGeo(0.28), glowMat, 0, -0.2, -(A.fore[2] / 2 + 0.1), { shadow: false });
    } else if (armStyle === 'blade') {
      add(elbow, boxGeo(0.25, 3.4, 1.3), M.trim, s * 1.15, -1.9, -0.4, { rz: s * 0.12, edge: true });     // forearm blade fins
      add(elbow, boxGeo(0.2, 4.4, 0.9), M.metal, s * 1.05, -2.1, 0.95, { rx: 0.1 });
    }
    const hand = group(elbow, 0, -3.8, 0);
    add(hand, boxGeo(1.2, 1.4, 1.4), M.dark, 0, -0.5, 0);
    arms[s] = { arm, elbow, hand };
  }
  const armR = arms[1];
  const armL = arms[-1];

  // ---- weapon in the right hand (barrel runs along the hand's -Y axis)
  const rifle = group(armR.hand, 0, 0, 0);
  const muzzle = new THREE.Object3D();
  if (spec.weapon === 'cannon') {
    add(rifle, cylGeo(0.75, 0.75, 6.0), M.dark, 0, -2.5, 0, { edge: true });
    add(rifle, cylGeo(1.1, 0.9, 1.4), M.metal, 0, -6.0, 0);
    add(rifle, boxGeo(1.5, 1.6, 1.6), M.accent, 0, -1.0, 0, { edge: true });
    add(rifle, boxGeo(0.5, 1.5, 0.5), M.trim, 0, -2.5, -1.0);
    muzzle.position.set(0, -6.9, 0);
  } else if (spec.weapon === 'mg') {
    add(rifle, boxGeo(0.95, 3.4, 1.2), M.dark, 0, -1.5, 0, { edge: true });
    add(rifle, cylGeo(0.2, 0.2, 2.2), M.metal, 0, -4.1, 0);
    add(rifle, boxGeo(0.7, 1.6, 0.8), M.accent, 0, -0.5, 0.9, { rx: 0.2 });
    muzzle.position.set(0, -5.3, 0);
  } else if (spec.weapon === 'sniper') {
    add(rifle, boxGeo(0.9, 6.6, 1.1), M.dark, 0, -2.8, 0, { edge: true });
    add(rifle, boxGeo(1.0, 1.2, 1.3), M.sub, 0, -0.9, 0, { edge: true });
    add(rifle, cylGeo(0.18, 0.18, 4.2), M.metal, 0, -7.4, 0);
    add(rifle, cylGeo(0.32, 0.32, 2.2, 10), M.sub, 0, -2.2, -0.95);                                      // scope
    add(rifle, sphGeo(0.28), glowMat, 0, -3.4, -0.95, { shadow: false });
    add(rifle, boxGeo(0.6, 0.5, 0.6), M.metal, 0, -9.5, 0);                                              // muzzle brake
    muzzle.position.set(0, -9.9, 0);
  } else if (spec.weapon === 'saber') {
    add(rifle, cylGeo(0.24, 0.24, 1.7), M.metal, 0, -0.9, 0);                                            // just a hilt
    add(rifle, cylGeo(0.3, 0.3, 0.3), M.trim, 0, -1.8, 0);
    muzzle.position.set(0, -2.0, 0);
  } else {
    add(rifle, boxGeo(0.95, 5.2, 1.3), M.dark, 0, -2.0, 0, { edge: true });
    add(rifle, boxGeo(1.0, 1.4, 1.4), M.sub, 0, -1.2, 0, { edge: true });
    add(rifle, boxGeo(0.4, 1.6, 0.4), M.sub, 0, -1.6, -0.9);
    add(rifle, cylGeo(0.22, 0.22, 2.6), M.metal, 0, -5.2, 0);
    add(rifle, boxGeo(0.5, 0.5, 0.5), glowMat, 0, -6.5, 0, { shadow: false });
    muzzle.position.set(0, -6.8, 0);
  }
  rifle.add(muzzle);

  // muzzle charge glow (telegraphs heavy enemy attacks)
  const chargeMat = new THREE.MeshBasicMaterial({
    color: P.blade, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const chargeGlow = new THREE.Mesh(sphGeo(1, 12, 8), chargeMat);
  chargeGlow.visible = false;
  muzzle.add(chargeGlow);

  // ---- beam sabre (hidden until swung)
  const SABER_LEN = 10;
  const saber = group(armR.hand, 0, 0, 0);
  add(saber, cylGeo(0.24, 0.24, 1.6), M.metal, 0, -0.8, 0);
  const blade = group(saber, 0, -1.6, 0);
  const bladeCore = new THREE.Mesh(cylGeo(0.22, 0.22, SABER_LEN, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  bladeCore.position.y = -SABER_LEN / 2;
  const bladeGlow = new THREE.Mesh(cylGeo(0.6, 0.6, SABER_LEN + 0.8, 8), new THREE.MeshBasicMaterial({
    color: P.blade, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  bladeGlow.position.y = -SABER_LEN / 2;
  blade.add(bladeCore, bladeGlow);
  saber.visible = false;
  blade.scale.y = 0.001;

  // ---- off-hand: shield on the left forearm, a shoulder cannon, or nothing
  const offhand = spec.offhand ?? (spec.shield ? 'shield' : 'none');
  let shoulderMuzzle = null;
  if (offhand === 'shield') {
    const sh = group(armL.elbow, -1.5, -1.5, -0.5);
    add(sh, boxGeo(0.5, 5.8, 3.6), M.main, 0, 0, 0, { edge: true });
    add(sh, boxGeo(0.6, 5.0, 0.7), M.accent, 0, 0, 0);
    add(sh, boxGeo(0.62, 1.1, 3.7), M.trim, 0, 1.6, 0);
    add(sh, boxGeo(0.62, 1.1, 3.7), M.sub, 0, -1.6, 0);
  } else if (offhand === 'cannon') {
    const cg = group(torso, -(3.95 * bulk), 6.0, 0.3);
    add(cg, boxGeo(1.9, 1.0, 2.6), M.dark, 0, 0, 0, { edge: true });
    add(cg, cylGeo(0.5, 0.62, 5.6, 10), M.sub, 0, 0.45, -2.4, { rx: Math.PI / 2, edge: true });          // barrel along -Z
    add(cg, cylGeo(0.78, 0.62, 0.8, 10), M.metal, 0, 0.45, -5.3, { rx: Math.PI / 2 });                   // muzzle brake
    add(cg, boxGeo(1.2, 0.5, 1.5), M.trim, 0, 0.85, -0.6);
    shoulderMuzzle = new THREE.Object3D();
    shoulderMuzzle.position.set(0, 0.45, -5.8);
    cg.add(shoulderMuzzle);
  }

  // =================================================================== animation
  const st = {
    phase: 0, air: 0, lean: 0, roll: 0, boost: 0, saberExt: 0, flameTime: Math.random() * 10,
  };
  let saberOn = false;

  // sweep poses for the three sabre swings: [yaw, pitch, torsoTwist] keyframes
  const SWING = {
    slash1: { from: [-1.1, 1.5, 0.5], to: [1.5, 1.45, -0.6] },
    slash2: { from: [1.4, 1.5, -0.6], to: [-1.2, 1.45, 0.5] },
    slash3: { from: [0.2, 3.0, 0.3], to: [0.0, 0.6, -0.1] },
  };
  const ease = (t) => t * t * (3 - 2 * t);

  function update(dt, s) {
    // ---- locomotion
    const speed = s.speed;
    const moving = s.grounded ? clamp(speed / 36, 0, 1.3) : 0;
    st.phase += dt * clamp(speed * 0.22, 0, 11) * (s.grounded ? 1 : 0);
    st.air = damp(st.air, s.grounded ? 0 : 1, 9, dt);
    const strideAmp = 0.75 * moving;

    for (let i = 0; i < 2; i++) {
      const { leg, shin, foot } = legs[i];
      const ph = st.phase + (i === 0 ? 0 : Math.PI);
      let thigh = Math.sin(ph) * strideAmp;
      let knee = -Math.max(0, Math.cos(ph)) * strideAmp * 1.5;
      thigh = lerp(thigh, -0.35 - (i === 0 ? 0.12 : -0.12) + st.lean * 0.5, st.air);
      knee = lerp(knee, -0.55 - (i === 0 ? 0.0 : 0.25), st.air);
      leg.rotation.x = thigh;
      shin.rotation.x = knee;
      foot.rotation.x = lerp(-(thigh + knee) * 0.7, 0.5, st.air);
    }
    hips.position.y = HIP_Y + Math.abs(Math.sin(st.phase)) * 0.35 * moving - st.air * 0.2;

    // ---- body lean follows velocity
    const targetLean = clamp(s.localFwd / 110, -0.3, 0.75) * (s.grounded ? 0.5 : 1);
    const targetRoll = clamp(s.localRight / 140, -0.4, 0.4);
    st.lean = damp(st.lean, targetLean, 8, dt);
    st.roll = damp(st.roll, targetRoll, 8, dt);
    hips.rotation.x = -st.lean * 0.45;
    hips.rotation.z = -st.roll * 0.5;
    torso.rotation.x = -st.lean * 0.5 + s.stagger * 0.4;
    torso.rotation.z = -st.roll * 0.4;
    torso.rotation.y = 0;

    // ---- arms
    const swing = Math.sin(st.phase) * 0.35 * moving;
    const aimUp = clamp(s.pitch, -0.7, 0.9);
    armL.arm.rotation.set(0.25 + swing + st.air * 0.2 - s.stagger * 0.9, -0.05, 0.1);
    armL.elbow.rotation.x = 0.5;

    const atk = s.attack;
    if (atk && SWING[atk.kind]) {
      // phases: wind-up (0-0.3), swing (0.3-0.65), recover (0.65-1)
      const k = SWING[atk.kind];
      const t = clamp(atk.t, 0, 1);
      let yaw, pitch, twist;
      if (t < 0.3) {
        const u = ease(t / 0.3);
        yaw = lerp(1.0, k.from[0], u);
        pitch = lerp(1.1, k.from[1], u);
        twist = lerp(0, k.from[2], u);
      } else if (t < 0.65) {
        const u = ease((t - 0.3) / 0.35);
        yaw = lerp(k.from[0], k.to[0], u);
        pitch = lerp(k.from[1], k.to[1], u);
        twist = lerp(k.from[2], k.to[2], u);
      } else {
        const u = ease((t - 0.65) / 0.35);
        yaw = lerp(k.to[0], 0.12, u);
        pitch = lerp(k.to[1], 1.05, u);
        twist = lerp(k.to[2], 0, u);
      }
      armR.arm.rotation.set(pitch, yaw, 0);
      armR.elbow.rotation.x = 0.25;
      torso.rotation.y = twist;
    } else if (saberOn) {
      armR.arm.rotation.set(1.0 + swing * 0.5 + aimUp * 0.4, -0.1, 0);
      armR.elbow.rotation.x = 0.7;
    } else {
      // rifle ready: forearm points along the aim direction
      armR.arm.rotation.set(1.05 + aimUp * 0.9 - s.stagger * 0.8 + swing * 0.15, 0.12, 0);
      armR.elbow.rotation.x = 0.45 + s.charge * 0.2;
    }

    // ---- sabre blade extends / retracts
    st.saberExt = damp(st.saberExt, saberOn ? 1 : 0, 22, dt);
    blade.scale.y = Math.max(0.001, st.saberExt);
    if (!saberOn && st.saberExt < 0.02) saber.visible = false;

    // ---- thrusters
    st.boost = damp(st.boost, s.boost, 14, dt);
    st.flameTime += dt * 40;
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i];
      const isCalf = i < 2; // creation order: two calf thrusters, then two backpack nozzles
      const power = st.boost * (isCalf ? 0.8 : 1);
      f.visible = power > 0.04;
      const flicker = 0.85 + 0.15 * Math.sin(st.flameTime + i * 2.1) + 0.08 * Math.sin(st.flameTime * 2.7 + i);
      f.scale.set(0.6 + power * 0.5, Math.max(0.001, power * flicker), 0.6 + power * 0.5);
    }

    // ---- muzzle charge glow
    if (s.charge > 0.02) {
      chargeGlow.visible = true;
      const r = 0.4 + s.charge * 2.2;
      chargeGlow.scale.setScalar(r);
      chargeMat.opacity = 0.35 + s.charge * 0.6;
    } else chargeGlow.visible = false;

    // ---- mono-eye sweep
    if (eyeNode) eyeNode.position.x = Math.sin(st.flameTime * 0.05) * 0.55;
  }

  function setSaber(on) {
    saberOn = on;
    if (on) saber.visible = true;
    rifle.visible = !on;
  }

  /** Emissive tint on every armour material: white for hit flashes, any colour for auras. */
  function tint(r, g, b) {
    for (const m of flashMats) m.emissive.setRGB(r, g, b);
  }

  const tmp = new THREE.Vector3();
  function muzzleWorld(out = tmp) {
    root.updateWorldMatrix(true, true);
    return muzzle.getWorldPosition(out);
  }

  /** World position of the shoulder cannon's muzzle (falls back to the main muzzle if there is none). */
  function shoulderMuzzleWorld(out = tmp) {
    if (!shoulderMuzzle) return muzzleWorld(out);
    root.updateWorldMatrix(true, true);
    return shoulderMuzzle.getWorldPosition(out);
  }

  return { root, update, setSaber, tint, muzzleWorld, shoulderMuzzleWorld, flashMats, hips, torso, armR, head };
}
