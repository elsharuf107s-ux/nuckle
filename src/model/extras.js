// The parts that bolt on to the sockets beyond the stock body: extra arms (a lower pair at the waist, a back
// pair over the shoulders), side heads, a tail and back pods. Each builder reads the spec, adds its meshes and
// leaves nodes in the rig for the motion layer: `rig.limbs`, `rig.sideHeads`, `rig.tail`, `rig.pods2`.
//
// An extra arm is a small copy of the real one: a shoulder joint, an upper arm, an elbow and a forearm, with its
// tool in the hand (pointing along the forearm, -y, like every gun in gear.js).

import { HEADS } from './head.js';

const PI = Math.PI;

export const LIMB_UPPER = 2.6; // shoulder to elbow of an extra arm
export const LIMB_FORE = 2.8;  // elbow to the hand

/** Where each socket is on the torso (x is scaled by the torso's width): [slot, row, side]. */
export const LIMB_SOCKETS = [['armLowerL', 'lower', -1], ['armLowerR', 'lower', 1], ['armUpperL', 'upper', -1], ['armUpperR', 'upper', 1]];

/** The socket's position in torso space. */
export function limbMount(row, side, bulk, depth) {
  return row === 'lower' ? [side * 2.3 * bulk, 1.55, 0.25] : [side * 1.75 * bulk, 4.15, depth / 2 + 0.6];
}

function tool(rig, hand, id, limb) {
  const { k } = rig;
  const { add, group, node, M, box, cyl, sph, glow, greenGlow, warmGlow, energyGlow, THREE } = k;
  if (id === 'gun') {
    add(hand, box(0.7, 1.1, 1.0), M.sub, 0, -0.7, 0, { edge: true });
    add(hand, box(0.4, 3.0, 0.4), M.steel, 0, -2.5, 0);
    add(hand, box(0.6, 0.5, 0.6), M.trim, 0, -1.3, 0);
    add(hand, box(0.3, 0.3, 0.3), glow, 0, -4.1, 0, { shadow: false });
    limb.muzzle = node(hand, 0, -4.4, 0);
  } else if (id === 'cannon') {
    add(hand, box(1.5, 1.9, 1.6), M.sub, 0, -1.0, 0, { edge: true });
    add(hand, cyl(0.55, 0.65, 3.6, 10), M.steel, 0, -3.5, 0);
    add(hand, cyl(0.8, 0.8, 0.5, 10), M.dark, 0, -5.2, 0);
    add(hand, cyl(0.6, 0.6, 0.12, 10), glow, 0, -5.5, 0, { shadow: false });
    add(hand, box(0.4, 1.0, 1.7), M.accent, 0, -1.6, 0, { edge: true });
    limb.muzzle = node(hand, 0, -5.8, 0);
  } else if (id === 'blade') {
    add(hand, cyl(0.3, 0.3, 1.5), M.metal, 0, -0.9, 0);
    add(hand, box(1.5, 0.25, 0.5), M.trim, 0, -0.2, 0, { edge: true });
    const blade = group(hand, 0, -1.7, 0);
    const len = 5.6;
    const core = new THREE.Mesh(k.cyl(0.18, 0.18, len, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
    core.position.y = -len / 2;
    const halo = new THREE.Mesh(k.cyl(0.5, 0.5, len + 0.6, 8), new THREE.MeshBasicMaterial({
      color: k.P.blade, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    halo.position.y = -len / 2;
    blade.add(core, halo);
    blade.scale.y = 0.001;
    limb.blade = blade;
    void energyGlow;
  } else if (id === 'shield') {
    // a plate across the end of the forearm (it faces the front when the arm is raised in guard)
    add(hand, box(3.0, 0.4, 3.6), M.main, 0, -1.4, 0, { edge: true });
    add(hand, box(2.2, 0.5, 0.6), M.accent, 0, -1.4, 0);
    add(hand, box(3.1, 0.5, 0.6), M.trim, 0, -1.4, 1.5);
    add(hand, box(0.7, 1.4, 0.7), M.dark, 0, -0.6, 0);
  } else if (id === 'launcher') {
    add(hand, box(1.8, 2.6, 1.8), M.sub, 0, -1.5, 0, { edge: true });
    for (const ox of [-0.45, 0.45]) for (const oz of [-0.45, 0.45]) {
      add(hand, cyl(0.34, 0.34, 0.6, 8), M.dark, ox, -3.0, oz);
      add(hand, cyl(0.24, 0.24, 0.1, 8), warmGlow, ox, -3.32, oz, { shadow: false });
    }
    add(hand, box(1.9, 0.4, 1.9), M.accent, 0, -0.5, 0, { edge: true });
    limb.muzzle = node(hand, 0, -3.5, 0);
  } else if (id === 'repair') {
    add(hand, cyl(0.5, 0.35, 2.4, 10), M.metal, 0, -1.5, 0);
    add(hand, cyl(0.75, 0.75, 0.3, 10), M.accent, 0, -2.2, 0, { edge: true });
    add(hand, cyl(0.2, 0.2, 1.3, 6), M.dark, 0.7, -1.2, 0);
    limb.glow = add(hand, sph(0.6, 10, 8), greenGlow, 0, -3.0, 0, { shadow: false });
    limb.muzzle = node(hand, 0, -3.1, 0);
  }
}

/** The extra arms. Each is `{ slot, row, side, kind, arm, elbow, hand, muzzle?, blade?, glow? }` in `rig.limbs`. */
export function buildLimbs(rig) {
  const { k, torso, spec, bulk, depth } = rig;
  const { add, group, M, box, cyl, sph } = k;
  rig.limbs = [];
  for (const [slot, row, side] of LIMB_SOCKETS) {
    const id = spec[slot];
    if (!id || id === 'none') continue;
    const [x, y, z] = limbMount(row, side, bulk, depth ?? 3.4);
    const base = group(torso, x, y, z);
    add(base, box(1.7, 1.5, 1.5), M.dark, 0, 0, 0, { edge: true });
    if (row === 'upper') add(base, box(1.4, 1.0, 1.0), M.sub, 0, 0.2, 0.55);
    const arm = group(base, 0, 0, 0);
    arm.rotation.order = 'YXZ';
    add(arm, sph(0.78), M.dark);
    add(arm, box(1.15, 2.2, 1.25), M.main, 0, -1.4, 0, { edge: true });
    add(arm, box(1.25, 0.35, 1.35), M.trim, 0, -0.5, 0);
    const elbow = group(arm, 0, -LIMB_UPPER, 0);
    add(elbow, cyl(0.6, 0.6, 1.4), M.dark, 0, 0, 0, { rz: PI / 2 });
    add(elbow, box(1.35, 2.4, 1.5), M.sub, 0, -1.4, 0, { edge: true });
    add(elbow, box(1.45, 0.4, 1.6), M.accent, 0, -2.4, 0);
    const hand = group(elbow, 0, -LIMB_FORE, 0);
    add(hand, box(0.9, 1.0, 1.0), M.dark, 0, -0.35, 0);
    const limb = { slot, row, side, kind: id, base, arm, elbow, hand, muzzle: null, blade: null, glow: null };
    tool(rig, hand, id, limb);
    rig.limbs.push(limb);
  }
}

// ------------------------------------------------------------------ side heads

/** Where a side head sits: on the collar, beside the main head. */
export function sideHeadMount(side, bulk) {
  return [side * 2.6 * bulk, 6.0, 0.35];
}

/** Extra heads on the shoulders: a smaller copy of any helmet, on a short stalk, looking about on its own. */
export function buildSideHeads(rig) {
  const { k, torso, spec, bulk } = rig;
  const { add, group, M, cyl } = k;
  rig.sideHeads = [];
  for (const [slot, side] of [['headL', -1], ['headR', 1]]) {
    const id = spec[slot];
    if (!id || id === 'none') continue;
    const [x, y, z] = sideHeadMount(side, bulk);
    const stalk = group(torso, x, y - 0.4, z);
    add(stalk, cyl(0.5, 0.7, 1.0, 8), M.dark, 0, 0.1, 0);
    const head = group(stalk, 0, 0.5, 0);
    head.scale.setScalar(0.78);
    head.rotation.y = -side * 0.3; // turned a little outward
    const sub = { whips: rig.whips, eyeNode: null };
    (HEADS[id] ?? HEADS.v).build(k, head, sub);
    rig.sideHeads.push({ slot, side, head, stalk, rest: -side * 0.3 });
  }
}

// ------------------------------------------------------------------ tail

const TAIL_SEGS = 5;

/** A tail: a chain of segments that trails behind the body. `rig.tail.segs` are the hinges the motion swings. */
export function buildTail(rig) {
  const { k, hips, spec, makeFlame } = rig;
  const { add, group, M, box, cyl, sph, glow, cone } = k;
  const id = spec.tail;
  rig.tail = null;
  if (!id || id === 'none') return;
  const at = rig.tailAt ?? { x: 0, y: -0.2, z: 2.0 };
  const root = group(hips, at.x, at.y, at.z);
  add(root, box(1.6, 1.3, 1.4), M.dark, 0, 0, 0.2, { edge: true });
  add(root, sph(0.8), M.sub, 0, 0, 0.9);
  const segs = [];
  let parent = root;
  const len = id === 'stabilizer' ? 2.6 : id === 'booster' ? 2.3 : 2.0;
  for (let i = 0; i < TAIL_SEGS; i++) {
    const g = group(parent, 0, 0, i === 0 ? 0.9 : len);
    g.rotation.x = -0.1;
    const t = 1 - i / (TAIL_SEGS + 1);
    const w = (id === 'stabilizer' ? 0.95 : 0.8) * t + 0.25;
    add(g, box(w, w * 0.85, len + 0.15), i % 2 ? M.sub : M.main, 0, 0, len / 2, { edge: true });
    add(g, cyl(w * 0.45, w * 0.45, w * 1.1, 8), M.dark, 0, 0, len, { rz: PI / 2 });
    segs.push(g);
    parent = g;
  }
  // what is on the tip
  const tip = group(parent, 0, 0, len);
  if (id === 'stabilizer') {
    add(tip, box(2.2, 1.8, 2.6), M.accent, 0, 0, 1.0, { edge: true });
    add(tip, box(2.4, 0.4, 2.8), M.trim, 0, 0.95, 1.0);
    add(tip, box(0.3, 1.2, 0.3), glow, 0, -0.2, 2.35, { shadow: false });
  } else if (id === 'lash') {
    const blade = group(tip, 0, 0, 0.2);
    add(blade, box(0.2, 1.6, 4.8), M.metal, 0, 0, 2.2, { edge: true });
    add(blade, cone(0.8, 2.2, 4), M.trim, 0, 0, 5.6, { rx: PI / 2 });
    add(blade, box(0.12, 0.7, 4.4), glow, 0, 0, 2.3, { shadow: false });
  } else if (id === 'booster') {
    add(tip, cyl(0.9, 1.3, 1.8, 10), M.metal, 0, 0, 1.0, { rx: PI / 2, edge: true });
    add(tip, cyl(1.0, 1.0, 0.3, 10), M.accent, 0, 0, 0.1, { rx: PI / 2 });
    makeFlame(tip, 0, 0, 2.0, PI / 2, 0.8, 4.2);
  }
  rig.tail = { id, root, segs, tip };
}

// ------------------------------------------------------------------ back pods

/** Where a back pod sits (torso space). */
export function podMount(side, bulk, depth) {
  return [side * 3.0 * bulk, 3.1, depth / 2 + 0.8];
}

/** A pod on each side of the back: a thruster, a missile rack or a slab of armour. */
export function buildPods(rig) {
  const { k, torso, spec, bulk, depth, makeFlame } = rig;
  const { add, group, M, box, cyl, cone, warmGlow } = k;
  rig.pods2 = [];
  for (const [slot, side] of [['podL', -1], ['podR', 1]]) {
    const id = spec[slot];
    if (!id || id === 'none') continue;
    const [x, y, z] = podMount(side, bulk, depth ?? 3.4);
    const g = group(torso, x, y, z);
    add(g, box(1.2, 1.2, 1.0), M.dark, 0, 0, -0.2, { edge: true });
    if (id === 'thruster') {
      add(g, cyl(0.95, 1.1, 2.6, 10), M.metal, 0, -0.2, 1.1, { rx: PI / 2 + 0.25, edge: true });
      add(g, cyl(1.2, 1.2, 0.35, 10), M.accent, 0, 0.1, 0.25, { rx: PI / 2 + 0.25 });
      add(g, cone(0.7, 0.9, 10), M.dark, 0, -0.55, 2.55, { rx: -PI / 2 + 0.25 });
      makeFlame(g, 0, -0.55, 2.7, PI / 2 + 0.4, 0.75, 3.6);
    } else if (id === 'missile') {
      add(g, box(2.2, 2.8, 3.2), M.sub, 0, 0.4, 1.4, { edge: true });
      for (const ox of [-0.5, 0.5]) for (const oy of [-0.2, 1.0]) {
        add(g, cyl(0.38, 0.38, 0.4, 8), M.dark, ox, oy, 3.1, { rx: PI / 2 });
        add(g, cyl(0.26, 0.26, 0.1, 8), warmGlow, ox, oy, 3.33, { rx: PI / 2, shadow: false });
      }
      add(g, box(2.3, 0.4, 3.3), M.accent, 0, 1.75, 1.4, { edge: true });
    } else if (id === 'plate') {
      add(g, box(2.4, 4.2, 0.9), M.main, 0, 0.5, 0.7, { edge: true });
      add(g, box(1.6, 3.0, 0.5), M.accent, 0, 0.5, 1.3);
      add(g, box(2.5, 0.5, 1.0), M.trim, 0, 2.2, 0.7);
    }
    rig.pods2.push({ slot, side, kind: id, g });
  }
}
