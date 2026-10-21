// Everything that bolts onto the frame: the backpack, shoulder armor and weapon mounts, the hand weapon
// and saber, the off-hand item, hip and head sub-weapons, and the cosmetic markings.

import { SHOULDER_X } from './skeleton.js';

const PI = Math.PI;

// ------------------------------------------------------------------ backpack

export function buildBackpack(rig) {
  const { k, torso, spec, makeFlame, depth } = rig;
  const { add, M, box, cyl, glow } = k;
  const pack = spec.backpack ?? 'std';
  const zb = depth / 2 + 0.75;
  const w = { std: 3.6, heavy: 4.6, booster: 4.4, pod: 4.0, wing: 3.6, gen: 4.4, plate: 5.0 }[pack] ?? 3.6;
  const big = pack === 'booster';
  add(torso, box(w, 3.6, 1.5), M.dark, 0, 2.4, zb, { edge: true });
  if (pack === 'std') {
    // a pair of saber hilts racked at the top corners, pointing up and out
    for (const s of [-1, 1]) {
      add(torso, cyl(0.24, 0.24, 2.2, 8), M.metal, s * 1.7, 4.7, zb - 0.1, { rz: -s * 0.25 });
      add(torso, cyl(0.3, 0.3, 0.3, 8), M.trim, s * 1.7 + s * 0.28, 5.7, zb - 0.1, { rz: -s * 0.25 });
    }
  } else if (pack === 'heavy') {
    for (const s of [-1, 1]) add(torso, box(1.2, 1.2, 2.6), M.accent, s * 2.7, 4.4, zb, { edge: true });
  } else if (pack === 'booster') {
    for (const s of [-1, 1]) {
      add(torso, cyl(0.9, 0.9, 4.2, 10), M.metal, s * 2.8, 2.7, zb + 0.4);
      add(torso, cyl(0.96, 0.96, 0.4, 10), M.accent, s * 2.8, 3.8, zb + 0.4);
      add(torso, cyl(0.96, 0.96, 0.4, 10), M.accent, s * 2.8, 1.6, zb + 0.4);
    }
  } else if (pack === 'pod') {
    for (const s of [-1, 1]) {
      add(torso, box(1.8, 1.7, 3.2), M.dark, s * 2.6, 4.9, zb + 0.2, { rx: -0.2, edge: true });
      for (const ox of [-0.45, 0.45]) for (const oy of [-0.38, 0.38]) add(torso, cyl(0.3, 0.3, 0.3, 8), M.trim, s * 2.6 + ox, 4.9 + oy, zb - 1.35, { rx: PI / 2 });
    }
  } else if (pack === 'wing') {
    for (const s of [-1, 1]) {
      add(torso, box(0.35, 6.0, 2.4), M.main, s * 3.4, 5.4, zb + 0.2, { rz: -s * 0.55, edge: true });
      add(torso, box(0.45, 1.4, 2.5), M.accent, s * 4.97, 7.95, zb + 0.2, { rz: -s * 0.55 });
    }
  } else if (pack === 'gen') {
    for (const s of [-1, 1]) {
      add(torso, cyl(1.05, 1.05, 4.6, 12), M.dark, s * 2.8, 3.3, zb + 0.5, { edge: true });
      for (const y of [1.5, 3.3, 5.1]) add(torso, cyl(1.12, 1.12, 0.22, 12), glow, s * 2.8, y, zb + 0.5, { shadow: false });
      add(torso, cyl(0.5, 0.5, 0.5, 8), M.trim, s * 2.8, 5.8, zb + 0.5);
    }
  } else if (pack === 'plate') {
    add(torso, box(5.0, 4.4, 0.8), M.main, 0, 4.0, zb + 0.7, { edge: true });
    for (const y of [2.2, 5.8]) add(torso, box(4.0, 0.5, 0.9), M.accent, 0, y, zb + 0.7, { edge: true });
    for (const y of [3.3, 4.0, 4.7]) add(torso, box(3.2, 0.26, 0.95), M.dark, 0, y, zb + 0.75);
  }
  // the two main thruster nozzles (and their flames, which are flames 2 and 3 after the calf thrusters)
  const TILT = PI / 2 + 0.5;
  const nk = big ? 1.25 : 1;
  for (const s of [-1, 1]) {
    add(torso, cyl(0.95 * nk, 0.6 * nk, 1.4), M.metal, s * 1.1, 0.9, zb + 0.55, { rx: TILT });
    makeFlame(torso, s * 1.1, 0.9 + Math.cos(TILT) * 0.7, zb + 0.55 + Math.sin(TILT) * 0.7, TILT, big ? 1.1 : 0.8, big ? 6.5 : 5.0);
    add(torso, cyl(0.18, 0.18, 1.9), M.metal, s * 1.9, 3.7, zb - 0.3, { rz: s * 0.3 });
  }
}

// ------------------------------------------------------------------ shoulders and weapon mounts

/** One shoulder pad on side `s` (-1 left, +1 right). */
function shoulderPad(rig, style, s) {
  const { k, torso, bulk, makeFlame } = rig;
  const { add, M, box, cyl, cone, sph, glow } = k;
  const sx = s * (3.5 * bulk);
  const pad = k.group(torso, sx, 4.1, 0);
  const body = (w, h, d, mat = M.accent) => add(pad, box(w, h, d), mat, 0, 0, 0, { rz: s * 0.1, edge: true });
  if (style === 'bulwark') {
    body(3.3, 3.0, 3.9);
    add(pad, box(3.4, 0.6, 4.0), M.trim, 0, 1.4, 0, { rz: s * 0.1 });
    add(pad, box(0.5, 2.4, 3.3), M.dark, s * 2.2, -0.1, 0, { rz: s * 0.1 });
    add(pad, box(2.6, 0.3, 3.2), M.sub, 0, -1.0, 0);
  } else if (style === 'dome') {
    const d = add(pad, sph(1.9, 16, 10), M.accent, 0, -0.2, 0);
    d.scale.set(1.0, 0.8, 1.15);
    add(pad, box(2.6, 0.4, 3.0), M.trim, 0, -1.0, 0);
  } else {
    body(2.8, 2.2, 3.4, style === 'spike' ? M.sub : M.accent);
    add(pad, box(2.9, 0.5, 3.5), M.main, 0, 1.2, 0, { rz: s * 0.1, edge: true });                 // white cap
    add(pad, box(1.6, 0.6, 0.12), M.dark, 0, 0.15, -1.76, { rz: s * 0.1 });                       // front vent
    add(pad, box(2.5, 0.14, 0.1), M.trim, 0, -0.55, -1.76, { rz: s * 0.1 });                      // trim stripe
    add(pad, box(0.3, 1.5, 2.4), M.dark, s * 1.5, -0.1, 0, { rz: s * 0.1 });                      // outer side plate
  }
  if (style === 'spike') {
    add(pad, cone(0.5, 2.2, 6), M.trim, s * 0.6, 2.2, 0, { rz: -s * 0.4 });
  } else if (style === 'vernier') {
    const tilt = PI / 2 + 0.3;
    const x = s * 1.0, y = 1.4, z = 1.3;
    add(pad, cyl(0.7, 0.45, 1.4, 8), M.metal, x, y, z, { rx: tilt });
    makeFlame(pad, x, y + Math.cos(tilt) * 0.7, z + Math.sin(tilt) * 0.7, tilt, 0.5, 3.4);
  } else if (style === 'rack') {
    add(pad, box(1.8, 1.0, 2.4), M.dark, 0, 1.7, 0.2, { rx: -0.2, edge: true });
    for (const ox of [-0.45, 0.45]) add(pad, cyl(0.28, 0.28, 0.3, 8), M.trim, ox, 1.75, -1.05, { rx: PI / 2 });
  } else if (style === 'aegis') {
    add(pad, box(0.25, 2.8, 2.2), M.trim, s * 1.95, 0.6, 0, { rz: s * 0.25, edge: true });
    add(pad, box(0.12, 2.2, 0.5), glow, s * 2.08, 0.6, 0, { rz: s * 0.25, shadow: false });
  } else if (style === 'wing') {
    add(pad, box(0.2, 2.6, 3.2), M.main, s * 1.8, 1.5, 0.3, { rz: s * 0.5, rx: 0.15, edge: true });
    add(pad, box(0.25, 1.0, 1.6), M.trim, s * 2.5, 2.7, 0.6, { rz: s * 0.5 });
  }
  return pad;
}

/** A weapon mount on top of the pad: its muzzle node (where shots come from) is stored on the rig. */
function mountOn(rig, style, s, pad) {
  const { k } = rig;
  const { add, group, node, M, box, cyl } = k;
  if (style === 'none') return null;
  const g = group(pad, s * 0.2, 1.6, 0.3);
  const side = s < 0 ? 'L' : 'R';
  let muzzle;
  if (style === 'cannon') {
    add(g, box(1.9, 1.0, 2.6), M.dark, 0, 0.1, 0, { edge: true });
    add(g, cyl(0.5, 0.62, 5.6, 10), M.sub, 0, 0.55, -2.4, { rx: PI / 2, edge: true });
    add(g, cyl(0.78, 0.62, 0.8, 10), M.metal, 0, 0.55, -5.3, { rx: PI / 2 });
    add(g, box(1.2, 0.5, 1.5), M.trim, 0, 0.95, -0.6);
    muzzle = node(g, 0, 0.55, -5.8);
  } else if (style === 'swarm') {
    add(g, box(2.4, 2.0, 3.2), M.dark, 0, 0.5, -0.2, { edge: true });
    add(g, box(2.5, 0.35, 3.3), M.sub, 0, 1.6, -0.2);
    for (const ox of [-0.7, 0, 0.7]) for (const oy of [0.0, 0.8]) add(g, cyl(0.3, 0.3, 0.4, 8), M.trim, ox, oy + 0.3, -1.95, { rx: PI / 2 });
    muzzle = node(g, 0, 0.8, -2.3);
  } else if (style === 'rail') {
    add(g, box(1.6, 1.0, 3.0), M.dark, 0, 0.1, 0.2, { edge: true });
    for (const ox of [-0.4, 0.4]) add(g, cyl(0.18, 0.18, 6.4, 8), M.metal, ox, 0.65, -2.7, { rx: PI / 2 });
    add(g, box(1.4, 0.3, 4.4), M.accent, 0, 0.95, -1.4, { edge: true });
    add(g, cyl(0.5, 0.5, 0.2, 10), k.cyanGlow, 0, 0.65, -5.95, { rx: PI / 2, shadow: false });
    muzzle = node(g, 0, 0.65, -6.0);
  }
  rig.mountMuzzle[side] = muzzle;
  return g;
}

export function buildShoulders(rig) {
  const { spec } = rig;
  rig.mountMuzzle = { L: null, R: null };
  rig.pads = {};
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const style = (side === 'L' ? spec.shoulderL : spec.shoulderR) ?? spec.shoulder ?? 'std';
    const pad = shoulderPad(rig, style, s);
    rig.pads[side] = pad;
    mountOn(rig, (side === 'L' ? spec.mountL : spec.mountR) ?? 'none', s, pad);
  }
}

// ------------------------------------------------------------------ hand weapon and saber

export function buildWeapon(rig) {
  const { k, armR, spec } = rig;
  const { add, group, node, M, box, cyl, sph, glow, THREE } = k;
  const rifle = group(armR.hand, 0, 0, 0);
  const muzzle = new THREE.Object3D();
  const style = spec.weapon ?? 'rifle';
  if (style === 'cannon') {
    add(rifle, cyl(0.75, 0.75, 6.0), M.dark, 0, -2.5, 0, { edge: true });
    add(rifle, cyl(1.1, 0.9, 1.4), M.metal, 0, -6.0, 0);
    add(rifle, box(1.5, 1.6, 1.6), M.accent, 0, -1.0, 0, { edge: true });
    add(rifle, box(0.5, 1.5, 0.5), M.trim, 0, -2.5, -1.0);
    muzzle.position.set(0, -6.9, 0);
  } else if (style === 'mg') {
    add(rifle, box(0.95, 3.4, 1.2), M.dark, 0, -1.5, 0, { edge: true });
    add(rifle, cyl(0.2, 0.2, 2.2), M.metal, 0, -4.1, 0);
    add(rifle, box(0.7, 1.6, 0.8), M.accent, 0, -0.5, 0.9, { rx: 0.2 });
    muzzle.position.set(0, -5.3, 0);
  } else if (style === 'sniper') {
    add(rifle, box(0.9, 6.6, 1.1), M.dark, 0, -2.8, 0, { edge: true });
    add(rifle, box(1.0, 1.2, 1.3), M.sub, 0, -0.9, 0, { edge: true });
    add(rifle, cyl(0.18, 0.18, 4.2), M.metal, 0, -7.4, 0);
    add(rifle, cyl(0.32, 0.32, 2.2, 10), M.sub, 0, -2.2, -0.95);
    add(rifle, sph(0.28), glow, 0, -3.4, -0.95, { shadow: false });
    add(rifle, box(0.6, 0.5, 0.6), M.metal, 0, -9.5, 0);
    muzzle.position.set(0, -9.9, 0);
  } else if (style === 'saber') {
    add(rifle, cyl(0.24, 0.24, 1.7), M.metal, 0, -0.9, 0);
    add(rifle, cyl(0.3, 0.3, 0.3), M.trim, 0, -1.8, 0);
    muzzle.position.set(0, -2.0, 0);
  } else if (style === 'greatsword') {
    add(rifle, cyl(0.34, 0.34, 2.4), M.metal, 0, -1.2, 0);
    add(rifle, box(2.4, 0.4, 0.7), M.trim, 0, -2.5, 0, { edge: true });
    add(rifle, sph(0.4), M.accent, 0, 0, 0);
    muzzle.position.set(0, -2.8, 0);
  } else if (style === 'scatter') {
    add(rifle, box(1.5, 3.8, 1.7), M.dark, 0, -1.7, 0, { edge: true });
    add(rifle, box(2.0, 1.3, 2.3), M.metal, 0, -4.3, 0, { edge: true });
    add(rifle, box(1.7, 1.0, 1.9), M.accent, 0, -1.0, 0, { edge: true });
    for (const ox of [-0.5, 0, 0.5]) add(rifle, cyl(0.2, 0.2, 0.4, 6), glow, ox, -5.0, 0, { shadow: false });
    add(rifle, box(0.5, 1.4, 0.5), M.trim, 0, -2.4, -1.1);
    muzzle.position.set(0, -5.4, 0);
  } else if (style === 'seeker') {
    add(rifle, box(0.95, 5.2, 1.3), M.dark, 0, -2.0, 0, { edge: true });
    add(rifle, box(1.0, 1.4, 1.4), M.sub, 0, -1.2, 0, { edge: true });
    add(rifle, cyl(0.22, 0.22, 2.6), M.metal, 0, -5.2, 0);
    for (const s of [-1, 1]) add(rifle, box(0.15, 1.8, 1.7), M.trim, s * 0.8, -4.4, 0, { rz: s * 0.25, edge: true });
    add(rifle, sph(0.36), glow, 0, -2.6, -0.85, { shadow: false });
    muzzle.position.set(0, -6.8, 0);
  } else if (style === 'lance') {
    add(rifle, box(0.7, 7.4, 0.9), M.dark, 0, -3.4, 0, { edge: true });
    add(rifle, box(1.0, 1.3, 1.2), M.sub, 0, -1.0, 0, { edge: true });
    for (const s of [-1, 1]) add(rifle, cyl(0.14, 0.14, 7.6, 6), M.metal, s * 0.5, -5.6, 0);
    add(rifle, cyl(0.5, 0.5, 0.3, 10), glow, 0, -9.2, 0, { shadow: false });
    add(rifle, cyl(0.3, 0.3, 1.6, 8), M.accent, 0, -10.0, 0);
    muzzle.position.set(0, -10.9, 0);
  } else {
    // the beam rifle: a boxy body with a top sensor and a long barrel
    add(rifle, box(0.95, 5.2, 1.3), M.dark, 0, -2.0, 0, { edge: true });
    add(rifle, box(1.0, 1.4, 1.4), M.sub, 0, -1.2, 0, { edge: true });
    add(rifle, box(0.4, 1.6, 0.4), M.sub, 0, -1.6, -0.9);
    add(rifle, cyl(0.22, 0.22, 2.6), M.metal, 0, -5.2, 0);
    add(rifle, box(0.5, 0.5, 0.5), glow, 0, -6.5, 0, { shadow: false });
    muzzle.position.set(0, -6.8, 0);
  }
  rifle.add(muzzle);
  rig.rifle = rifle;
  rig.muzzle = muzzle;

  // muzzle charge glow (telegraphs heavy enemy attacks)
  const chargeMat = new THREE.MeshBasicMaterial({
    color: k.P.blade, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const chargeGlow = new THREE.Mesh(k.sph(1, 12, 8), chargeMat);
  chargeGlow.visible = false;
  muzzle.add(chargeGlow);
  rig.chargeMat = chargeMat;
  rig.chargeGlow = chargeGlow;

  // ---- the beam saber (hidden until swung): a hilt in the hand and a blade that extends
  const huge = style === 'greatsword';
  const SABER_LEN = huge ? 14 : 10;
  const saber = group(armR.hand, 0, 0, 0);
  add(saber, cyl(0.24, 0.24, 1.6), M.metal, 0, -0.8, 0);
  if (huge) add(saber, box(2.4, 0.4, 0.7), M.trim, 0, -1.6, 0, { edge: true });
  const blade = group(saber, 0, -1.6, 0);
  const bladeCore = new THREE.Mesh(k.cyl(huge ? 0.4 : 0.22, huge ? 0.4 : 0.22, SABER_LEN, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  bladeCore.position.y = -SABER_LEN / 2;
  const bladeGlow = new THREE.Mesh(k.cyl(huge ? 1.05 : 0.6, huge ? 1.05 : 0.6, SABER_LEN + 0.8, 8), new THREE.MeshBasicMaterial({
    color: k.P.blade, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  bladeGlow.position.y = -SABER_LEN / 2;
  blade.add(bladeCore, bladeGlow);
  saber.visible = false;
  blade.scale.y = 0.001;
  rig.saber = saber;
  rig.blade = blade;
  void node;
}

// ------------------------------------------------------------------ off-hand

export function buildOffhand(rig) {
  const { k, armL, spec } = rig;
  const { add, group, M, box } = k;
  const style = spec.offhand ?? (spec.shield ? 'shield' : 'none');
  if (style === 'shield') {
    // the beam shield: a long kite of armour with a V-shaped emblem
    const sh = group(armL.elbow, -1.6, -1.6, -0.5);
    add(sh, box(0.5, 6.2, 3.6), M.main, 0, 0, 0, { edge: true });
    add(sh, box(0.6, 5.2, 0.7), M.accent, 0, 0, 0);
    add(sh, box(0.62, 1.1, 3.7), M.trim, 0, 1.8, 0);
    add(sh, box(0.62, 1.1, 3.7), M.sub, 0, -1.8, 0);
    for (const o of [-1, 1]) add(sh, box(0.64, 1.7, 0.3), M.trim, 0, -0.2, o * 0.8, { rx: -o * 0.5 });
  } else if (style === 'buckler') {
    const sh = group(armL.elbow, -1.4, -1.7, -0.3);
    add(sh, box(0.4, 3.2, 2.6), M.main, 0, 0, 0, { edge: true });
    add(sh, box(0.5, 2.6, 0.5), M.accent, 0, 0, 0);
    add(sh, box(0.5, 0.7, 2.7), M.trim, 0, 1.2, 0);
  } else if (style === 'tower') {
    const sh = group(armL.elbow, -1.8, -2.0, -0.6);
    add(sh, box(0.7, 8.4, 4.4), M.main, 0, 0, 0, { edge: true });
    add(sh, box(0.8, 7.4, 0.8), M.accent, 0, 0, 0);
    for (const y of [-3.2, 3.2]) add(sh, box(0.82, 1.2, 4.5), M.trim, 0, y, 0);
    add(sh, box(0.4, 1.6, 1.6), k.glow, -0.4, 0, 1.4, { shadow: false });
  }
}

// ------------------------------------------------------------------ sub-weapons

export function buildSub(rig) {
  const { k, hips, head, spec } = rig;
  const { add, node, M, box, cyl, cyanGlow, greenGlow } = k;
  const style = spec.sub ?? 'none';
  rig.headMuzzle = null;
  if (style === 'flare') {
    for (const s of [-1, 1]) {
      add(hips, box(0.8, 0.7, 1.5), M.dark, s * 3.05, -0.2, 0.5, { edge: true });
      for (let q = -1; q <= 1; q++) add(hips, cyl(0.18, 0.18, 0.5, 6), M.trim, s * 3.05, 0.3, 0.5 + q * 0.45);
    }
  } else if (style === 'repair') {
    add(hips, box(1.2, 1.2, 0.8), M.main, -3.0, -0.3, 1.0, { edge: true });
    add(hips, box(0.1, 0.8, 0.25), greenGlow, -3.62, -0.3, 1.0, { shadow: false });
    add(hips, box(0.1, 0.25, 0.8), greenGlow, -3.62, -0.3, 1.0, { shadow: false });
  } else if (style === 'injector') {
    for (const s of [-1, 1]) {
      add(hips, cyl(0.5, 0.5, 1.9, 8), M.metal, s * 1.5, -0.1, 2.35);
      add(hips, cyl(0.54, 0.54, 0.3, 8), cyanGlow, s * 1.5, 0.95, 2.35, { shadow: false });
    }
  } else if (style === 'pulse') {
    for (const s of [-1, 1]) {
      add(hips, cyl(0.95, 0.95, 0.5, 14), M.accent, s * 3.15, -0.2, 0.2, { rz: PI / 2, edge: true });
      add(hips, cyl(0.62, 0.62, 0.54, 14), cyanGlow, s * 3.15, -0.2, 0.2, { rz: PI / 2, shadow: false });
    }
  } else if (style === 'field') {
    for (const s of [-1, 1]) {
      add(hips, k.sph(0.6, 12, 8), cyanGlow, s * 3.1, -0.1, 0.6, { shadow: false });
      add(hips, box(0.25, 1.3, 0.25), M.metal, s * 3.1, -0.9, 0.6);
      add(hips, box(0.9, 0.2, 0.2), M.metal, s * 2.7, -0.1, 0.6);
    }
  } else if (style === 'vulcan') {
    for (const s of [-1, 1]) {
      add(head, box(0.4, 0.4, 0.7), M.dark, s * 0.95, 1.5, -0.95, { edge: true });
      add(head, cyl(0.13, 0.13, 0.9, 8), M.metal, s * 0.95, 1.5, -1.55, { rx: PI / 2 });
    }
    rig.headMuzzle = node(head, 0, 1.5, -2.1);
  }
}

// ------------------------------------------------------------------ cosmetic markings

export function buildMarks(rig) {
  const { k, torso, spec, bulk, legs, armL, armR, zf } = rig;
  const { add, M, box } = k;
  const marks = spec.marks ?? 'none';
  if (marks === 'none') return;
  const mat = M.trim;
  if (marks === 'stripe') {
    for (const s of [-1, 1]) {
      for (const o of [-0.5, 0.5]) add(rig.pads[s < 0 ? 'L' : 'R'], box(0.3, 0.06, 3.3), mat, o, 1.4, 0);
      add(torso, box(0.3, 1.9, 0.08), mat, s * 0.9, 2.3, zf - 0.02);
    }
    for (const l of legs) add(l.leg, box(0.3, 3.6, 0.08), mat, 0, -2.2, -1.2);
    for (const a of [armL, armR]) add(a.arm, box(rig.A.upper[0] + 0.12, 0.25, rig.A.upper[2] + 0.12), mat, 0, -2.3, 0);
  } else if (marks === 'chevron') {
    for (const s of [-1, 1]) {
      add(torso, box(1.5, 0.3, 0.08), mat, s * 0.65, 3.55, zf - 0.02, { rz: -s * 0.55 });
      add(torso, box(1.5, 0.3, 0.08), mat, s * 0.65, 3.95, zf - 0.02, { rz: -s * 0.55 });
    }
    for (const l of legs) for (const dy of [-1.0, -1.6]) add(l.shin, box(1.0, 0.25, 0.08), mat, 0, dy - 2.0, -rig.L.shin[2] / 2 - 0.1);
  } else if (marks === 'hazard') {
    for (const s of [-1, 1]) {
      const pad = rig.pads[s < 0 ? 'L' : 'R'];
      for (let i = 0; i < 5; i++) add(pad, box(0.4, 0.5, 0.06), i % 2 ? M.dark : mat, -0.9 + i * 0.45, -0.1, -1.75);
    }
    for (let i = 0; i < 6; i++) add(torso, box(0.5, 0.35, 0.06), i % 2 ? M.dark : mat, -1.25 + i * 0.5, 0.95, zf + 0.15);
  }
  void bulk;
}

export { SHOULDER_X };
