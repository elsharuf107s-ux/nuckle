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

  for (const s of [-1, 1]) {
    const leg = group(hips, s * 1.8, -0.5, 0);
    add(leg, sphGeo(1.0), M.dark);
    add(leg, boxGeo(2.1, 3.7, 2.3), M.main, 0, -2.0, 0, { edge: true });
    add(leg, boxGeo(1.9, 1.0, 0.5), M.sub, 0, -3.5, -1.3, { edge: true });
    const shin = group(leg, 0, -4.0, 0);
    add(shin, cylGeo(0.95, 0.95, 2.0), M.dark, 0, 0, 0, { rz: Math.PI / 2 });
    add(shin, boxGeo(2.2, 4.0, 2.6), M.main, 0, -2.3, 0.2, { edge: true });
    add(shin, boxGeo(1.8, 2.6, 1.2), M.sub, 0, -2.0, 1.8, { edge: true });
    add(shin, boxGeo(1.6, 2.6, 0.4), M.accent, 0, -2.4, -1.3, { edge: true });
    add(shin, boxGeo(1.4, 0.8, 1.6), M.dark, 0, -4.4, 0);
    const foot = group(shin, 0, -4.8, 0);
    add(foot, boxGeo(2.4, 1.0, 4.2), M.sub, 0, -0.1, -0.7, { edge: true });
    add(foot, boxGeo(2.0, 0.7, 1.2), M.main, 0, 0, -3.0, { edge: true });
    add(foot, boxGeo(1.6, 0.8, 0.9), M.main, 0, 0, 1.4);
    // calf thruster (points down and back)
    makeFlame(shin, 0, -3.4, 2.4, Math.PI - 0.35, 0.55, 3.6);
    legs.push({ leg, shin, foot, side: s });
  }

  // ---- torso
  const torso = group(hips, 0, 0.8, 0);
  add(torso, cylGeo(1.8, 2.0, 1.0), M.dark, 0, 0.3, 0);
  add(torso, boxGeo(5.2 * bulk, 3.2, 3.7), M.sub, 0, 2.1, 0, { edge: true });
  add(torso, boxGeo(5.5 * bulk, 1.0, 3.9), M.main, 0, 4.1, 0, { edge: true });
  for (const s of [-1, 1]) add(torso, boxGeo(1.4, 0.9, 0.3), M.trim, s * 1.4 * bulk, 2.6, -1.95, { edge: true });
  add(torso, boxGeo(1.7, 1.5, 0.3), M.accent, 0, 1.1, -1.95, { edge: true });
  add(torso, cylGeo(0.6, 0.7, 0.8), M.dark, 0, 4.8, 0);

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
  const packW = spec.backpack === 'heavy' ? 4.6 : 3.6;
  add(torso, boxGeo(packW, 3.6, 1.5), M.dark, 0, 2.4, 2.3, { edge: true });
  if (spec.backpack === 'heavy') {
    for (const s of [-1, 1]) add(torso, boxGeo(1.2, 1.2, 2.6), M.accent, s * 2.7, 4.4, 2.3, { edge: true });
  }
  const NOZZLE_TILT = Math.PI / 2 + 0.5;
  for (const s of [-1, 1]) {
    add(torso, cylGeo(0.95, 0.6, 1.4), M.metal, s * 1.1, 0.9, 3.0, { rx: NOZZLE_TILT });
    // flame base: nozzle centre pushed along its axis (0, cos, sin)
    const nx = s * 1.1;
    const ny = 0.9 + Math.cos(NOZZLE_TILT) * 0.7;
    const nz = 3.0 + Math.sin(NOZZLE_TILT) * 0.7;
    makeFlame(torso, nx, ny, nz, NOZZLE_TILT, 0.8, 5.0);
    add(torso, cylGeo(0.18, 0.18, 1.9), M.metal, s * 1.9, 3.7, 2.4, { rz: s * 0.3 });
  }

  // ---- shoulders & arms
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
    add(arm, boxGeo(1.6, 3.0, 1.7), M.main, 0, -2.0, 0, { edge: true });
    const elbow = group(arm, 0, -3.6, 0);
    add(elbow, cylGeo(0.8, 0.8, 1.8), M.dark, 0, 0, 0, { rz: Math.PI / 2 });
    add(elbow, boxGeo(1.9, 3.4, 2.2), M.main, 0, -1.9, 0, { edge: true });
    add(elbow, boxGeo(2.0, 0.6, 2.3), M.trim, 0, -3.1, 0);
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

  // ---- shield on the left forearm
  if (spec.shield) {
    const sh = group(armL.elbow, -1.5, -1.5, -0.5);
    add(sh, boxGeo(0.5, 5.8, 3.6), M.main, 0, 0, 0, { edge: true });
    add(sh, boxGeo(0.6, 5.0, 0.7), M.accent, 0, 0, 0);
    add(sh, boxGeo(0.62, 1.1, 3.7), M.trim, 0, 1.6, 0);
    add(sh, boxGeo(0.62, 1.1, 3.7), M.sub, 0, -1.6, 0);
  } else if (spec.shoulderGun) {
    add(torso, cylGeo(0.5, 0.5, 4.5), M.dark, -4.0 * bulk, 6.2, 0.5, { rx: Math.PI / 2 });
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

  return { root, update, setSaber, tint, muzzleWorld, flashMats, hips, torso, armR, head };
}
