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

  // core module: small, but visible at the waist and rear skirt
  const greenGlow = new THREE.MeshBasicMaterial({ color: 0x6dff9a, fog: false });
  const cyanGlow = new THREE.MeshBasicMaterial({ color: 0x6adfff, fog: false });
  const energyGlow = new THREE.MeshBasicMaterial({ color: P.blade, fog: false });
  const coreStyle = spec.core ?? 'std';
  if (coreStyle === 'capacitor') {
    for (const s of [-1, 1]) {
      add(hips, cylGeo(0.7, 0.7, 2.6, 10), M.accent, s * 2.0, -0.1, 2.0, { edge: true });             // capacitor cells
      add(hips, cylGeo(0.76, 0.76, 0.4, 10), M.trim, s * 2.0, 0.75, 2.0);
    }
  } else if (coreStyle === 'overclock') {
    add(hips, cylGeo(2.5, 2.5, 0.3, 20), glowMat, 0, 0.9, 0, { shadow: false });                        // glowing waist ring
    for (const s of [-1, 1]) add(hips, boxGeo(0.7, 0.5, 0.7), M.trim, s * 2.5, 0.9, 0, { edge: true });
  } else if (coreStyle === 'regen') {
    add(hips, boxGeo(1.9, 0.55, 0.3), greenGlow, 0, -0.9, 1.98, { shadow: false });                      // repair cross on the rear skirt
    add(hips, boxGeo(0.55, 1.9, 0.3), greenGlow, 0, -0.9, 1.98, { shadow: false });
  } else if (coreStyle === 'phase') {
    for (const s of [-1, 1]) {
      add(hips, boxGeo(0.3, 1.8, 1.3), M.accent, s * 1.7, -0.6, 2.1, { rz: s * 0.25, edge: true });      // phase vanes
      add(hips, boxGeo(0.12, 1.5, 0.5), glowMat, s * 1.92, -0.6, 2.55, { rz: s * 0.25, shadow: false });
    }
  } else if (coreStyle === 'siphon') {
    for (const y of [-0.1, 0.7]) add(hips, cylGeo(2.55, 2.55, 0.2, 20), energyGlow, 0, y, 0, { shadow: false }); // twin siphon rings
    for (const s of [-1, 1]) add(hips, boxGeo(0.5, 1.5, 0.5), M.trim, s * 2.55, 0.3, 0, { edge: true });
  } else if (coreStyle === 'barrier') {
    add(hips, cylGeo(1.0, 1.2, 0.5, 12), M.metal, 0, -0.5, 2.05, { rx: Math.PI / 2 });                     // emitter base on the rear skirt
    add(hips, sphGeo(0.95, 14, 10), cyanGlow, 0, -0.5, 2.5, { shadow: false });                             // barrier emitter
    for (const s of [-1, 1]) add(hips, boxGeo(0.22, 1.5, 0.22), M.metal, s * 1.15, -0.5, 2.1);            // prongs
  }

  // hip-mounted sub-weapons
  const subStyle = spec.sub ?? 'none';
  if (subStyle === 'flare') {
    for (const s of [-1, 1]) {
      add(hips, boxGeo(0.8, 0.7, 1.5), M.dark, s * 3.05, -0.2, 0.5, { edge: true });                    // flare launchers
      for (let k = -1; k <= 1; k++) add(hips, cylGeo(0.18, 0.18, 0.5, 6), M.trim, s * 3.05, 0.3, 0.5 + k * 0.45);
    }
  } else if (subStyle === 'repair') {
    add(hips, boxGeo(1.2, 1.2, 0.8), M.main, -3.0, -0.3, 1.0, { edge: true });                          // repair unit with a green cross
    add(hips, boxGeo(0.1, 0.8, 0.25), greenGlow, -3.62, -0.3, 1.0, { shadow: false });
    add(hips, boxGeo(0.1, 0.25, 0.8), greenGlow, -3.62, -0.3, 1.0, { shadow: false });
  } else if (subStyle === 'injector') {
    for (const s of [-1, 1]) {
      add(hips, cylGeo(0.5, 0.5, 1.9, 8), M.metal, s * 1.5, -0.1, 2.35);                                // twin EN canisters on the rear skirt
      add(hips, cylGeo(0.54, 0.54, 0.3, 8), cyanGlow, s * 1.5, 0.95, 2.35, { shadow: false });
    }
  } else if (subStyle === 'pulse') {
    for (const s of [-1, 1]) {
      add(hips, cylGeo(0.95, 0.95, 0.5, 14), M.accent, s * 3.15, -0.2, 0.2, { rz: Math.PI / 2, edge: true }); // shock emitters on the hips
      add(hips, cylGeo(0.62, 0.62, 0.54, 14), cyanGlow, s * 3.15, -0.2, 0.2, { rz: Math.PI / 2, shadow: false });
    }
  } else if (subStyle === 'field') {
    for (const s of [-1, 1]) {
      add(hips, sphGeo(0.6, 12, 8), cyanGlow, s * 3.1, -0.1, 0.6, { shadow: false });                    // field projectors
      add(hips, boxGeo(0.25, 1.3, 0.25), M.metal, s * 3.1, -0.9, 0.6);
      add(hips, boxGeo(0.9, 0.2, 0.2), M.metal, s * 2.7, -0.1, 0.6);
    }
  }

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
    strider: { x: 1.7, thigh: [1.8, 3.7, 2.0], shin: [1.9, 4.0, 2.2], foot: [2.1, 1.0, 4.8] },
    siege:  { x: 2.3,  thigh: [2.5, 3.7, 2.7], shin: [2.7, 4.0, 3.1], foot: [3.5, 1.0, 5.0] },
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
    } else if (legStyle === 'strider') {
      add(shin, boxGeo(0.3, 3.4, 0.5), M.trim, 0, -2.2, -(L.shin[2] / 2 + 0.1));       // shin blade
      add(foot, boxGeo(0.5, 0.5, 2.6), M.trim, 0, -0.1, -3.6, { edge: true });         // toe blade
      add(leg, boxGeo(L.thigh[0] + 0.1, 0.6, L.thigh[2] + 0.1), M.accent, 0, -0.9, 0, { edge: true }); // hip band
    } else if (legStyle === 'siege') {
      add(leg, boxGeo(L.thigh[0] + 0.3, 1.9, 1.2), M.accent, 0, -3.7, -(L.thigh[2] / 2 + 0.25), { edge: true }); // knee shield
      add(shin, coneGeo(0.55, 2.4, 6), M.trim, s * (L.shin[0] / 2 + 0.7), -3.6, 0.4, { rz: -s * 1.2 }).material.side = THREE.DoubleSide; // stabiliser spike
      add(foot, boxGeo(L.foot[0] + 0.4, 0.5, 1.4), M.trim, 0, 0.5, -3.2, { edge: true }); // toe plate
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
  } else if (torsoStyle === 'bay') {
    for (const s of [-1, 1]) {
      add(torso, boxGeo(1.9, 1.9, 0.5), M.dark, s * 1.55 * bulk, 2.2, zf - 0.15, { edge: true });    // missile bay hatches
      for (const ox of [-0.4, 0.4]) for (const oy of [-0.4, 0.4]) {
        add(torso, cylGeo(0.26, 0.26, 0.4, 8), M.trim, s * 1.55 * bulk + ox, 2.2 + oy, zf - 0.5, { rx: Math.PI / 2 });
      }
    }
    add(torso, boxGeo(0.5, 2.2, 0.4), M.accent, 0, 2.2, zf - 0.1, { edge: true });
  } else if (torsoStyle === 'command') {
    add(torso, boxGeo(2.4, 1.1, 0.5), glowMat, 0, 3.3, zf - 0.1, { shadow: false });                 // canopy
    add(torso, boxGeo(2.8, 0.3, 0.6), M.trim, 0, 3.95, zf - 0.1);
    for (const s of [-1, 1]) add(torso, boxGeo(0.3, 2.4, 1.8), M.accent, s * 3.0 * bulk, 2.4, -0.2, { edge: true }); // side fins
    add(torso, cylGeo(0.07, 0.07, 3.2, 6), M.metal, 2.2 * bulk, 6.3, 1.0);                           // sensor mast and dish
    add(torso, cylGeo(0.75, 0.2, 0.3, 12), M.metal, 2.2 * bulk, 7.9, 1.0, { rz: 0.5, edge: true });
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
  } else if (spec.head === 'ace') {
    add(head, boxGeo(2.0, 1.7, 2.2), M.main, 0, 0.9, 0, { edge: true });
    add(head, boxGeo(1.7, 0.7, 0.35), M.dark, 0, 0.9, -1.15);
    add(head, boxGeo(1.5, 0.26, 0.12), glowMat, 0, 1.0, -1.35, { shadow: false });                   // wide visor
    add(head, boxGeo(0.9, 0.4, 0.5), M.accent, 0, 0.15, -1.15, { edge: true });                      // chin guard
    add(head, boxGeo(0.35, 0.9, 1.8), M.main, 0, 2.0, 0.3, { rx: -0.2, edge: true });                // rear fin
    for (const s of [-1, 1]) {
      add(head, boxGeo(0.14, 0.9, 2.4), M.trim, s * 1.12, 1.35, 0.5, { rx: 0.35, edge: true });      // swept side blades
      add(head, boxGeo(0.3, 0.3, 0.2), M.trim, s * 0.85, 0.4, -1.1);
    }
  } else if (spec.head === 'jammer') {
    add(head, boxGeo(2.1, 1.7, 2.2), M.main, 0, 0.9, 0, { edge: true });
    add(head, boxGeo(1.6, 0.9, 0.35), M.dark, 0, 0.8, -1.15);
    for (const s of [-1, 1]) add(head, boxGeo(0.5, 0.22, 0.12), glowMat, s * 0.5, 1.0, -1.36, { shadow: false });
    add(head, boxGeo(1.0, 0.45, 0.5), M.accent, 0, 0.2, -1.15, { edge: true });
    [-0.9, -0.45, 0, 0.45, 0.9].forEach((x, i) => {                                                  // crown of antennae
      const h = i % 2 ? 1.5 : 2.4;
      const lean = -x * 0.3;                                                                          // outer spikes fan outward
      add(head, coneGeo(0.17, h, 6), M.trim, x, 1.8 + h / 2, 0.1, { rz: lean }).material.side = THREE.DoubleSide;
      add(head, sphGeo(0.14), glowMat, x - (h / 2) * Math.sin(lean), 1.8 + h / 2 + (h / 2) * Math.cos(lean), 0.1, { shadow: false });
    });
    add(head, cylGeo(0.55, 0.12, 0.3, 12), M.metal, 1.4, 1.0, 0.1, { rz: -1.2, edge: true });         // jamming dish
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

  if (spec.head === 'recon') {
    add(head, cylGeo(1.15, 0.25, 0.35, 16), M.metal, 1.55, 1.55, 0.1, { rz: -0.95, edge: true });    // sensor dish
    add(head, cylGeo(0.08, 0.08, 1.4, 6), M.metal, 1.15, 0.95, 0.1);
    add(head, cylGeo(0.05, 0.05, 2.6, 6), M.dark, -0.6, 2.5, 0.2);                                   // tall antenna
  }
  let headMuzzle = null;
  if (spec.sub === 'vulcan') {
    for (const s of [-1, 1]) {
      add(head, boxGeo(0.4, 0.4, 0.7), M.dark, s * 0.95, 1.5, -0.95, { edge: true });
      add(head, cylGeo(0.13, 0.13, 0.9, 8), M.metal, s * 0.95, 1.5, -1.55, { rx: Math.PI / 2 });      // vulcan barrels
    }
    headMuzzle = new THREE.Object3D();
    headMuzzle.position.set(0, 1.5, -2.1);
    head.add(headMuzzle);
  }

  // ---- backpack, thrusters and sabre hilts
  const pack = spec.backpack ?? 'std';
  const packW = { std: 3.6, heavy: 4.6, booster: 4.4, pod: 4.0, wing: 3.6, gen: 4.4, plate: 5.0 }[pack] ?? 3.6;
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
  } else if (pack === 'gen') {
    for (const s of [-1, 1]) {
      add(torso, cylGeo(1.05, 1.05, 4.6, 12), M.dark, s * 2.8, 3.3, 2.8, { edge: true });             // generator cells
      for (const y of [1.5, 3.3, 5.1]) add(torso, cylGeo(1.12, 1.12, 0.22, 12), glowMat, s * 2.8, y, 2.8, { shadow: false });
      add(torso, cylGeo(0.5, 0.5, 0.5, 8), M.trim, s * 2.8, 5.8, 2.8);
    }
  } else if (pack === 'plate') {
    add(torso, boxGeo(5.0, 4.4, 0.8), M.main, 0, 4.0, 3.3, { edge: true });                           // slab backplate
    for (const y of [2.2, 5.8]) add(torso, boxGeo(4.0, 0.5, 0.9), M.accent, 0, y, 3.3, { edge: true });
    for (const y of [3.3, 4.0, 4.7]) add(torso, boxGeo(3.2, 0.26, 0.95), M.dark, 0, y, 3.35);       // cooling slats
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
    guard:     { upper: [1.9, 3.0, 2.0], fore: [2.6, 3.4, 2.8] },
    recoil:    { upper: [1.7, 3.0, 1.8], fore: [2.1, 3.6, 2.4] },
  };
  const armStyle = spec.arms && ARM[spec.arms] ? spec.arms : 'std';
  const A = ARM[armStyle];
  const arms = {};
  for (const s of [-1, 1]) {
    const shoulder = spec.shoulder ?? 'std';
    const sx = s * (3.95 * bulk);
    if (shoulder === 'bulwark') {
      add(torso, boxGeo(3.2, 3.0, 3.9), M.accent, sx, 4.1, 0, { rz: s * 0.1, edge: true });            // layered armour shells
      add(torso, boxGeo(3.3, 0.6, 4.0), M.trim, sx, 5.45, 0, { rz: s * 0.1 });
      add(torso, boxGeo(0.5, 2.4, 3.3), M.dark, s * (5.65 * bulk), 4.0, 0, { rz: s * 0.1 });
    } else {
      add(torso, boxGeo(2.6, 2.4, 3.2), shoulder === 'spike' ? M.sub : M.accent, sx, 4.0, 0, { rz: s * 0.1, edge: true });
      add(torso, boxGeo(2.7, 0.4, 3.3), M.trim, sx, 4.95, 0, { rz: s * 0.1 });
    }
    if (shoulder === 'spike') {
      add(torso, coneGeo(0.5, 2.2, 6), M.trim, s * (4.6 * bulk), 5.9, 0, { rz: -s * 0.4 }).material.side = THREE.DoubleSide;
    } else if (shoulder === 'rack') {
      add(torso, boxGeo(1.8, 1.0, 2.4), M.dark, sx, 5.6, 0.2, { rx: -0.2, edge: true });                // missile rack on top
      for (const ox of [-0.45, 0.45]) add(torso, cylGeo(0.28, 0.28, 0.3, 8), M.trim, sx + ox, 5.65, -1.05, { rx: Math.PI / 2 });
    } else if (shoulder === 'aegis') {
      add(torso, boxGeo(0.25, 2.8, 2.2), M.trim, s * (5.45 * bulk), 4.7, 0, { rz: s * 0.25, edge: true });   // emitter fin
      add(torso, boxGeo(0.12, 2.2, 0.5), glowMat, s * (5.58 * bulk), 4.7, 0, { rz: s * 0.25, shadow: false });
    } else if (shoulder === 'vernier') {
      const tilt = Math.PI / 2 + 0.3;                                                                   // nozzle points back and slightly down
      const vx = s * (4.5 * bulk), vy = 5.5, vz = 1.3;
      add(torso, cylGeo(0.7, 0.45, 1.4, 8), M.metal, vx, vy, vz, { rx: tilt });
      makeFlame(torso, vx, vy + Math.cos(tilt) * 0.7, vz + Math.sin(tilt) * 0.7, tilt, 0.5, 3.4);
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
    } else if (armStyle === 'guard') {
      add(elbow, boxGeo(0.5, 3.0, A.fore[2] + 0.5), M.accent, s * (A.fore[0] / 2 + 0.2), -1.9, 0, { edge: true }); // outer vambrace
      add(elbow, boxGeo(A.fore[0] + 0.2, 0.6, A.fore[2] + 0.2), M.trim, 0, -0.4, 0);
    } else if (armStyle === 'recoil') {
      for (const ox of [-0.8, 0.8]) add(elbow, cylGeo(0.16, 0.16, 3.4, 6), M.metal, ox, -2.0, -(A.fore[2] / 2 + 0.2)); // recoil pistons
      add(elbow, boxGeo(A.fore[0] + 0.3, 0.7, 0.9), M.dark, 0, -0.5, -(A.fore[2] / 2 + 0.1), { edge: true });
      add(elbow, boxGeo(A.fore[0] + 0.1, 0.5, A.fore[2] + 0.1), M.accent, 0, -3.1, 0);
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
  } else if (spec.weapon === 'greatsword') {
    add(rifle, cylGeo(0.34, 0.34, 2.4), M.metal, 0, -1.2, 0);                                            // a longer hilt with a crossguard
    add(rifle, boxGeo(2.4, 0.4, 0.7), M.trim, 0, -2.5, 0, { edge: true });
    add(rifle, sphGeo(0.4), M.accent, 0, 0, 0);
    muzzle.position.set(0, -2.8, 0);
  } else if (spec.weapon === 'scatter') {
    add(rifle, boxGeo(1.5, 3.8, 1.7), M.dark, 0, -1.7, 0, { edge: true });                               // short, fat shotgun body
    add(rifle, boxGeo(2.0, 1.3, 2.3), M.metal, 0, -4.3, 0, { edge: true });                              // wide muzzle
    add(rifle, boxGeo(1.7, 1.0, 1.9), M.accent, 0, -1.0, 0, { edge: true });
    for (const ox of [-0.5, 0, 0.5]) add(rifle, cylGeo(0.2, 0.2, 0.4, 6), glowMat, ox, -5.0, 0, { shadow: false });
    add(rifle, boxGeo(0.5, 1.4, 0.5), M.trim, 0, -2.4, -1.1);                                            // foregrip
    muzzle.position.set(0, -5.4, 0);
  } else if (spec.weapon === 'seeker') {
    add(rifle, boxGeo(0.95, 5.2, 1.3), M.dark, 0, -2.0, 0, { edge: true });
    add(rifle, boxGeo(1.0, 1.4, 1.4), M.sub, 0, -1.2, 0, { edge: true });
    add(rifle, cylGeo(0.22, 0.22, 2.6), M.metal, 0, -5.2, 0);
    for (const s of [-1, 1]) add(rifle, boxGeo(0.15, 1.8, 1.7), M.trim, s * 0.8, -4.4, 0, { rz: s * 0.25, edge: true }); // guidance vanes
    add(rifle, sphGeo(0.36), glowMat, 0, -2.6, -0.85, { shadow: false });                                // seeker eye
    muzzle.position.set(0, -6.8, 0);
  } else if (spec.weapon === 'lance') {
    add(rifle, boxGeo(0.7, 7.4, 0.9), M.dark, 0, -3.4, 0, { edge: true });
    add(rifle, boxGeo(1.0, 1.3, 1.2), M.sub, 0, -1.0, 0, { edge: true });
    for (const s of [-1, 1]) add(rifle, cylGeo(0.14, 0.14, 7.6, 6), M.metal, s * 0.5, -5.6, 0);          // twin rails
    add(rifle, cylGeo(0.5, 0.5, 0.3, 10), glowMat, 0, -9.2, 0, { shadow: false });
    add(rifle, cylGeo(0.3, 0.3, 1.6, 8), M.accent, 0, -10.0, 0);
    muzzle.position.set(0, -10.9, 0);
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
  const huge = spec.weapon === 'greatsword'; // the greatsword is a longer, fatter blade
  const SABER_LEN = huge ? 14 : 10;
  const saber = group(armR.hand, 0, 0, 0);
  add(saber, cylGeo(0.24, 0.24, 1.6), M.metal, 0, -0.8, 0);
  if (huge) add(saber, boxGeo(2.4, 0.4, 0.7), M.trim, 0, -1.6, 0, { edge: true });
  const blade = group(saber, 0, -1.6, 0);
  const bladeCore = new THREE.Mesh(cylGeo(huge ? 0.4 : 0.22, huge ? 0.4 : 0.22, SABER_LEN, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  bladeCore.position.y = -SABER_LEN / 2;
  const bladeGlow = new THREE.Mesh(cylGeo(huge ? 1.05 : 0.6, huge ? 1.05 : 0.6, SABER_LEN + 0.8, 8), new THREE.MeshBasicMaterial({
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
  } else if (offhand === 'buckler') {
    const sh = group(armL.elbow, -1.3, -1.7, -0.3);
    add(sh, boxGeo(0.4, 3.2, 2.6), M.main, 0, 0, 0, { edge: true });
    add(sh, boxGeo(0.5, 2.6, 0.5), M.accent, 0, 0, 0);
    add(sh, boxGeo(0.5, 0.7, 2.7), M.trim, 0, 1.2, 0);
  } else if (offhand === 'tower') {
    const sh = group(armL.elbow, -1.7, -2.0, -0.6);
    add(sh, boxGeo(0.7, 8.4, 4.4), M.main, 0, 0, 0, { edge: true });
    add(sh, boxGeo(0.8, 7.4, 0.8), M.accent, 0, 0, 0);
    for (const y of [-3.2, 3.2]) add(sh, boxGeo(0.82, 1.2, 4.5), M.trim, 0, y, 0);
    add(sh, boxGeo(0.4, 1.6, 1.6), glowMat, -0.4, 0, 1.4, { shadow: false });
  } else if (offhand === 'swarm') {
    const cg = group(torso, -(3.95 * bulk), 6.0, 0.3);
    add(cg, boxGeo(2.6, 2.0, 3.2), M.dark, 0, 0.4, -0.2, { edge: true });                                 // micro-missile pod
    add(cg, boxGeo(2.7, 0.35, 3.3), M.sub, 0, 1.5, -0.2);
    for (const ox of [-0.7, 0, 0.7]) for (const oy of [0.0, 0.8]) add(cg, cylGeo(0.3, 0.3, 0.4, 8), M.trim, ox, oy + 0.2, -1.95, { rx: Math.PI / 2 });
    shoulderMuzzle = new THREE.Object3D();
    shoulderMuzzle.position.set(0, 0.7, -2.3);
    cg.add(shoulderMuzzle);
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
  //
  // Locomotion is driven by distance travelled, so the feet do not slide: the stride phase advances by how
  // far the mech moved, and the pelvis height comes from the legs' own geometry (the more extended leg is
  // the one touching the ground, which also gives the walk its natural bob). The lower body turns toward the
  // direction of travel, so strafing and backing up read as steps rather than a moonwalk, while the chest
  // keeps facing the aim. Dashes and lunges glide in a skating stance instead of sprinting, landings crouch,
  // idle mechs breathe, and the saber swings anticipate, strike and follow through on a wrist that whips.

  const THIGH = 4.0, SHIN = 4.8, SOLE = 0.6, PELVIS = 0.5; // leg pivot drop and segment lengths (see the legs above)
  const REACH = THIGH + SHIN - 0.05;
  /**
   * Two-bone IK in a leg's plane: the thigh and knee angles that put the ankle at (fx ahead of the hip joint,
   * fy above it; negative is below). The knee bends backward, like a person's. Out of reach, the leg straightens.
   */
  const ik = (fx, fy, out) => {
    const d = clamp(Math.hypot(fx, fy), Math.abs(THIGH - SHIN) + 0.05, REACH);
    const toward = Math.atan2(fx, -fy); // the target's angle forward of straight down
    const hip = Math.acos(clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1));
    const knee = Math.acos(clamp((THIGH * THIGH + SHIN * SHIN - d * d) / (2 * THIGH * SHIN), -1, 1));
    out[0] = toward + hip;
    out[1] = -(Math.PI - knee);
    return out;
  };
  const gait = [{ fx: 0, fz: 0, lift: 0, swing: 0 }, { fx: 0, fz: 0, lift: 0, swing: 0 }];
  const scale = spec.scale ?? 1;
  hips.rotation.order = 'YXZ';
  torso.rotation.order = 'YXZ';
  const TORSO_Y = torso.position.y;
  const st = {
    phase: 0, back: false, legYaw: 0, air: 0, skate: 0, idle: 1, fight: 0, lean: 0, roll: 0, crouch: 0,
    land: 0, recoil: 0, boost: 0, saberExt: 0, flameTime: Math.random() * 10, t: Math.random() * 10,
  };
  let saberOn = false;

  const ease = (t) => t * t * (3 - 2 * t);
  const easeOut = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const TAU = Math.PI * 2;

  // ---- saber swings. Each is four poses: wind-up, strike, follow-through, then back to the guard.
  // y/x/z: right arm yaw (positive swings it to the mech's left), pitch (0 hanging, PI/2 forward, PI up) and roll;
  // el: elbow bend; wr: wrist (tilts the blade forward from the line of the forearm); tw: torso twist (positive
  // turns left); ln: torso pitch (negative leans forward); cr: crouch. The strike spans the moment the player's
  // code spawns the arc (t = 0.28) and lands the hit (t = 0.45).
  const GUARD = { y: 0.4, x: 0.75, z: -0.15, el: 1.15, wr: 0.55, tw: 0.12, ln: -0.04, cr: 0.25 };
  const SWING = {
    slash1: [ // forehand: right to left
      { t: 0.28, y: -1.25, x: 1.3, z: 0.1, el: 1.05, wr: 0.7, tw: -0.6, ln: 0.02, cr: 0.3 },
      { t: 0.48, y: 1.05, x: 1.45, z: 0, el: 0.12, wr: 0.05, tw: 0.62, ln: -0.16, cr: 0.55 },
      { t: 0.7, y: 1.45, x: 1.25, z: 0, el: 0.4, wr: -0.15, tw: 0.75, ln: -0.18, cr: 0.5 },
    ],
    slash2: [ // backhand: left to right
      { t: 0.28, y: 1.35, x: 1.35, z: -0.1, el: 1.2, wr: -0.35, tw: 0.7, ln: 0.0, cr: 0.35 },
      { t: 0.48, y: -1.0, x: 1.45, z: 0, el: 0.15, wr: 0.05, tw: -0.55, ln: -0.14, cr: 0.55 },
      { t: 0.7, y: -1.4, x: 1.3, z: 0, el: 0.35, wr: 0.2, tw: -0.68, ln: -0.16, cr: 0.5 },
    ],
    slash3: [ // overhead chop that finishes the combo
      { t: 0.3, y: 0.2, x: 2.95, z: 0, el: 0.95, wr: 0.75, tw: 0.15, ln: 0.26, cr: 0.15 },
      { t: 0.5, y: 0.05, x: 1.55, z: 0, el: 0.1, wr: 0.0, tw: -0.05, ln: -0.42, cr: 0.8 },
      { t: 0.74, y: 0.0, x: 1.4, z: 0, el: 0.25, wr: -0.1, tw: -0.05, ln: -0.38, cr: 0.7 },
    ],
  };
  const KEYS = ['y', 'x', 'z', 'el', 'wr', 'tw', 'ln', 'cr'];
  const swingPose = (kind, t, out) => {
    const k = SWING[kind];
    const frames = [{ t: 0, ...GUARD }, ...k, { t: 1, ...GUARD }];
    let i = 0;
    while (i < frames.length - 2 && t > frames[i + 1].t) i++;
    const a = frames[i], b = frames[i + 1];
    const u = clamp((t - a.t) / (b.t - a.t), 0, 1);
    const e = i === 1 ? easeOut(u) : ease(u); // the strike snaps; everything else eases
    for (const key of KEYS) out[key] = lerp(a[key], b[key], e);
    return out;
  };
  const pose = {};

  function update(dt, s) {
    st.t += dt;
    const v = s.speed / scale; // ground speed in model units
    const grounded = s.grounded;
    const atk = s.attack && SWING[s.attack.kind] ? s.attack : null;
    st.air = damp(st.air, grounded ? 0 : 1, grounded ? 16 : 7, dt);
    st.land = Math.max(0, st.land - dt * 2.6);
    st.recoil = Math.max(0, st.recoil - dt * 7);

    // ---- which way the legs face: toward travel, or away from it when backing up (with hysteresis)
    const turning = grounded && v < 6 ? clamp((Math.abs(s.turnRate ?? 0) - 0.6) / 2.2, 0, 1) : 0;
    let wantYaw = 0;
    if (v > 3 && !atk) {
      const ang = Math.atan2(s.localRight, s.localFwd); // 0 straight ahead, +PI/2 to the right
      if (st.back ? Math.abs(ang) < 0.55 * Math.PI : Math.abs(ang) > 0.68 * Math.PI) st.back = !st.back;
      wantYaw = -clamp(st.back ? wrapAngle(ang - Math.PI) : ang, -1.3, 1.3); // right of travel = negative yaw
    } else if (turning > 0) {
      wantYaw = -clamp((s.turnRate ?? 0) * 0.2, -0.5, 0.5); // turning on the spot: the legs lag behind the chest
    }
    st.legYaw = damp(st.legYaw, wantYaw, v > 3 ? 8 : 5, dt);
    const dir = st.back ? -1 : 1;

    // ---- gait blends
    const skateWant = grounded ? Math.max(s.dash > 0 ? 1 : 0, clamp((v - 90) / 50, 0, 1)) : 0;
    st.skate = damp(st.skate, skateWant, skateWant > st.skate ? 34 : 5, dt);
    st.idle = damp(st.idle, grounded && v < 4 && turning === 0 ? 1 : 0, 6, dt);
    st.fight = damp(st.fight, saberOn || atk ? 1 : 0, 9, dt);

    // ---- stride. The feet are planned and the legs solved to reach them (two-bone IK), so a planted foot
    // cannot slide or sink. Each foot spends half the cycle planted, moving back under the body at exactly the
    // body's speed, and half arcing forward with its knee lifted. Played backwards, the same cycle backs up.
    const walk = 1 - st.skate;
    const cy = Math.cos(st.legYaw), sy = Math.sin(st.legYaw);
    const along = (s.localFwd * cy - s.localRight * sy) / scale;   // speed the way the legs face
    const lateral = (s.localFwd * sy + s.localRight * cy) / scale; // and across them
    st.pace = damp(st.pace ?? 0, Math.min(Math.abs(along), 70), 8, dt); // (a dash glides: the stride stops at a run)
    const stride = Math.max(clamp(0.8 + st.pace * 0.15, 0.8, 8), turning * 1.6); // one step, foot to foot
    const clearance = clamp(0.25 + st.pace * 0.03, 0.25, 1.5) + turning * 0.4;
    // what the legs' turn cannot absorb of a strafe is stepped sideways on the same cycle
    const sideStride = st.pace > 1 ? clamp((lateral / Math.max(st.pace, 1)) * stride, -3, 3) * walk : 0;
    if (grounded) st.phase += dir * ((st.pace * Math.PI) / stride + turning * 8) * dt;

    // ---- lean into travel (measured along the way the legs face), harder when skating; bank into turns
    const leanWant = clamp(along / 170, -0.2, 0.32) * (1 - st.air) + st.skate * 0.22 * Math.sign(along || 1) + clamp(s.localFwd / scale / 140, -0.3, 0.6) * st.air;
    const rollWant = clamp(-lateral / 260, -0.22, 0.22) + clamp((s.turnRate ?? 0) * v / 900, -0.15, 0.15);
    st.lean = damp(st.lean, leanWant, 7, dt);
    st.roll = damp(st.roll, rollWant, 7, dt);

    // ---- crouch: weight in the idle stance, a fighting stance, skating, landing impacts and the swing itself
    if (atk) swingPose(atk.kind, atk.t, pose);
    const crouchWant = (0.12 * st.idle + 0.2 * st.fight + 0.15 * st.skate) * (1 - st.air) + (atk ? pose.cr * 0.7 : 0) + st.land * 1.1;
    st.crouch = damp(st.crouch, crouchWant, st.land > 0.5 ? 30 : 12, dt);

    const hipPitch = -st.lean * 0.32;
    const hipRoll = st.roll * 0.5;
    hips.rotation.set(hipPitch, st.legYaw, hipRoll);

    // ---- where each ankle wants to be: fx ahead of the hip (along the legs' heading), lift above the ground
    const still = st.idle * (1 - turning);
    for (let i = 0; i < 2; i++) {
      const g = gait[i];
      const lead = legs[i].side < 0; // the left foot leads in a stance and a skate
      const psi = (((st.phase + (i ? Math.PI : 0)) % TAU) + TAU) % TAU;
      if (psi >= Math.PI / 2 && psi < 1.5 * Math.PI) {
        const u = (psi - Math.PI / 2) / Math.PI;          // planted: from heel strike to toe off
        g.fx = (stride / 2) * (1 - 2 * u);
        g.fz = (sideStride / 2) * (1 - 2 * u);
        g.lift = 0;
        g.swing = 0;
      } else {
        const w = ((psi - 1.5 * Math.PI + TAU) % TAU) / Math.PI; // swinging through
        g.fx = -(stride / 2) * Math.cos(Math.PI * w);
        g.fz = -(sideStride / 2) * Math.cos(Math.PI * w);
        g.swing = Math.sin(Math.PI * w);
        g.lift = clearance * g.swing;
      }
      // standing: weight a little on one leg; with the saber out, a fighting stance; dashing, a skating stance
      const standX = lerp(lead ? 0.9 : -0.3, lead ? 2.4 : -2.0, st.fight);
      g.fx = lerp(g.fx, standX, still);
      g.lift *= 1 - still;
      g.fx = lerp(g.fx, lead ? 2.2 : -2.6, st.skate);
      g.lift *= 1 - st.skate;
      g.fz *= (1 - still) * (1 - st.skate);
    }

    // ---- the pelvis: as high as the stance allows, lower in a crouch, and never higher than the planted legs reach
    let hipH = HIP_Y - 0.3 - st.crouch * 2.6;
    const legDrop = HIP_Y - PELVIS - SOLE; // hip joint to ankle, standing
    const splays = [0, 1].map((i) => legs[i].side * (0.04 + 0.04 * st.idle + 0.07 * st.skate + 0.05 * st.air) + Math.atan2(gait[i].fz, legDrop));
    for (let i = 0; i < 2; i++) {
      const g = gait[i];
      if (g.lift > 0.02) continue;
      const pivotDrop = PELVIS * Math.cos(hipRoll) - legs[i].side * L.x * Math.sin(hipRoll);
      const reachY = Math.sqrt(Math.max(0, REACH * REACH - g.fx * g.fx)) * Math.cos(splays[i]) * Math.cos(hipRoll);
      hipH = Math.min(hipH, reachY + pivotDrop + SOLE);
    }

    // ---- legs: solve for the ankle targets, blend into the air pose, keep the feet flat on the ground
    const vy = s.vy ?? 0;
    const falling = clamp(-vy / 60, 0, 1);
    const airTrail = clamp(s.localFwd / scale / 150, 0, 0.45);
    const solved = [0, 0];
    for (let i = 0; i < 2; i++) {
      const { leg, shin, foot, side } = legs[i];
      const g = gait[i];
      const lead = side < 0;
      const splay = splays[i];
      const pivotY = hipH - PELVIS * Math.cos(hipRoll) + side * L.x * Math.sin(hipRoll); // the hip joint's height
      const fy = (SOLE + g.lift - pivotY) / (Math.cos(splay) * Math.cos(hipRoll));
      ik(g.fx, fy, solved);
      let th = solved[0], kn = solved[1];
      let ft = g.swing * 0.12 * walk * (1 - still); // toes come up a little through the swing
      // airborne: one knee up and the other leg trailing while rising, both reaching for the ground when falling
      const airTh = lerp(lead ? 0.45 : -0.14, lead ? 0.22 : 0.04, falling) - airTrail;
      const airKn = lerp(lead ? -1.15 : -0.38, lead ? -0.6 : -0.3, falling);
      th = lerp(th, airTh + st.crouch * 0.3, st.air);
      kn = lerp(kn, airKn - st.crouch * 0.6, st.air);
      ft = lerp(ft, lerp(-0.5, -0.05, falling), st.air);

      leg.rotation.x = th - hipPitch; // th is relative to the ground, so undo the pelvis tilt
      shin.rotation.x = kn;
      foot.rotation.x = ft - th - kn; // ft is the foot's angle to the ground (positive = toes up)
      leg.rotation.z = splay;
      foot.rotation.z = -splay - hipRoll;
    }
    hips.position.y = lerp(hipH, HIP_Y - 0.4, st.air);

    // ---- chest: counter the legs' turn so it keeps facing the aim, then lean, bank, breathe and swing
    const breathe = Math.sin(st.t * 1.7) * st.idle;
    const aimUp = clamp(s.pitch, -0.7, 0.9);
    torso.rotation.y = -st.legYaw + (atk ? pose.tw : st.fight * GUARD.tw * st.idle);
    torso.rotation.x = -st.lean * 0.42 + s.stagger * 0.45 + (atk ? pose.ln : 0) - st.crouch * 0.1 + breathe * 0.014 + st.recoil * 0.05 - st.land * 0.25;
    torso.rotation.z = st.roll * 0.35;
    torso.position.y = TORSO_Y + breathe * 0.05;
    head.rotation.x = clamp(aimUp * 0.5, -0.3, 0.45) - torso.rotation.x * 0.6;
    head.rotation.y = s.relaxed ? Math.sin(st.t * 0.37) * 0.22 * st.idle : 0;

    // ---- left arm: counter-swings with the stride, balances in the air and on landing, guards with the saber
    const leftStride = (gait[0].fx / 8) * (1 - st.air) * (1 - still) * walk; // the left arm swings against the left leg
    let lx = 0.22 - leftStride * 0.9 - s.stagger * 0.9, ly = -0.05, lz = 0.1, le = 0.45;
    lx = lerp(lx, 0.5, st.air); lz = lerp(lz, 0.38, st.air); le = lerp(le, 0.65, st.air);
    lx = lerp(lx, -0.4, st.skate); lz = lerp(lz, 0.3, st.skate); le = lerp(le, 0.35, st.skate);
    lx = lerp(lx, 0.7, st.fight * (1 - st.skate)); ly = lerp(ly, 0.38, st.fight); le = lerp(le, 1.2, st.fight);
    if (atk) lx -= 0.25 * Math.sin(Math.PI * clamp((atk.t - 0.2) / 0.5, 0, 1)); // drawn back as the blade comes through
    lz += st.land * 0.55;
    armL.arm.rotation.set(lx, ly, lz);
    armL.elbow.rotation.x = le;

    // ---- right arm: aims the gun, holds the saber in guard, or swings it
    const bob = Math.sin(st.phase * 2) * 0.04 * clamp(st.pace / 40, 0, 1) * walk;
    if (atk) {
      armR.arm.rotation.set(pose.x, pose.y, pose.z);
      armR.elbow.rotation.x = pose.el;
      saber.rotation.x = pose.wr;
    } else if (saberOn) {
      armR.arm.rotation.set(GUARD.x + bob + aimUp * 0.2 - s.stagger * 0.6, GUARD.y, GUARD.z);
      armR.elbow.rotation.x = GUARD.el;
      saber.rotation.x = GUARD.wr;
    } else if (s.relaxed) {
      // at ease: the rifle lowered, pointing at the ground ahead
      armR.arm.rotation.set(0.32 + bob, 0.16, 0.06);
      armR.elbow.rotation.x = 0.72;
      saber.rotation.x = 0;
    } else {
      // rifle ready: the forearm points along the aim; a shot kicks the arm up
      armR.arm.rotation.set(1.05 + aimUp * 0.9 - s.stagger * 0.8 + bob - st.land * 0.3 + st.recoil * 0.32, 0.12, 0);
      armR.elbow.rotation.x = 0.45 + s.charge * 0.2 + st.recoil * 0.3;
      saber.rotation.x = 0;
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
      const isCalf = i < 2; // creation order: two calf thrusters, then the backpack (and any shoulder) nozzles
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

  /** A landing: `k` (0..1) is how hard; the knees soak it up and the arms flare out. */
  function land(k) {
    st.land = Math.max(st.land, clamp(k, 0, 1));
  }

  /** A shot: the gun arm kicks up by `k` (a bazooka is 1, a rapid beam gun a fraction). */
  function recoil(k) {
    st.recoil = Math.min(1, Math.max(st.recoil, k));
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

  /** World position of the head vulcans' muzzle (falls back to the main muzzle if there are none). */
  function headMuzzleWorld(out = tmp) {
    if (!headMuzzle) return muzzleWorld(out);
    root.updateWorldMatrix(true, true);
    return headMuzzle.getWorldPosition(out);
  }

  return { root, update, land, recoil, setSaber, tint, muzzleWorld, shoulderMuzzleWorld, headMuzzleWorld, flashMats, hips, torso, armR, head, saber, feet: legs.map((l) => l.foot) };
}
