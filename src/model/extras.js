// The parts that bolt on to the sockets beyond the stock body: extra arms (a lower, a middle and a back pair),
// side heads, a tail, back pods, wings, flank pods and a chest module. Each builder reads the spec, adds its
// meshes and leaves nodes in the rig for the motion layer: `rig.limbs`, `rig.sideHeads`, `rig.tail`, `rig.pods2`,
// `rig.wings2`, `rig.flanks`, `rig.moduleNode`, `rig.turrets` (the parts that aim themselves) and `rig.spinners`.
// Every fitted part's root node is also kept in `rig.sockets[slot]`, which is how the garage pops a new part in
// and how a part that is shot off is torn away.
//
// An extra arm is a small copy of the real one: a shoulder joint, an upper arm, an elbow and a forearm, with its
// tool in the hand (pointing along the forearm, -y, like every gun in gear.js).

import { HEADS } from './head.js';

const PI = Math.PI;

export const LIMB_UPPER = 2.6; // shoulder to elbow of an extra arm
export const LIMB_FORE = 2.8;  // elbow to the hand

/** Where each socket is on the torso (x is scaled by the torso's width): [slot, row, side]. */
export const LIMB_SOCKETS = [['armLowerL', 'lower', -1], ['armLowerR', 'lower', 1], ['armMidL', 'mid', -1], ['armMidR', 'mid', 1], ['armUpperL', 'upper', -1], ['armUpperR', 'upper', 1]];

/** The socket's position in torso space. */
export function limbMount(row, side, bulk, depth) {
  if (row === 'lower') return [side * 2.3 * bulk, 1.55, 0.25];
  if (row === 'mid') return [side * 2.2 * bulk, 2.75, 0.95];
  return [side * 2.05 * bulk, 4.3, depth / 2 + 0.5];
}

function tool(rig, hand, id, limb) {
  const { k } = rig;
  const { add, group, node, M, box, cyl, cone, sph, glow, greenGlow, warmGlow, energyGlow, THREE } = k;
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
  } else if (id === 'shotgun') {
    add(hand, box(1.7, 1.7, 1.9), M.sub, 0, -1.0, 0, { edge: true });
    add(hand, box(1.3, 2.4, 1.1), M.steel, 0, -2.8, 0, { edge: true });
    for (const ox of [-0.35, 0.35]) add(hand, cyl(0.3, 0.3, 0.5, 8), M.dark, ox, -4.2, 0);
    add(hand, box(1.8, 0.3, 2.0), M.accent, 0, -0.3, 0, { edge: true });
    add(hand, box(0.3, 0.3, 0.3), glow, 0, -1.9, -1.0, { shadow: false });
    limb.muzzle = node(hand, 0, -4.6, 0);
  } else if (id === 'rail') {
    add(hand, box(1.1, 1.5, 1.3), M.sub, 0, -0.9, 0, { edge: true });
    for (const ox of [-0.42, 0.42]) add(hand, box(0.22, 5.6, 0.34), M.steel, ox, -4.0, 0);
    add(hand, box(0.2, 5.0, 0.2), energyGlow, 0, -3.8, 0, { shadow: false });
    for (const y of [-2.2, -3.4, -4.6]) add(hand, cyl(0.62, 0.62, 0.25, 8), M.trim, 0, y, 0);
    limb.muzzle = node(hand, 0, -6.9, 0);
  } else if (id === 'sensor') {
    add(hand, cyl(0.22, 0.22, 2.2, 6), M.metal, 0, -1.2, 0);
    const dish = group(hand, 0, -2.4, 0);
    add(dish, cyl(1.7, 0.3, 0.6, 14), M.main, 0, 0, 0, { rx: PI / 2 + 0.5, edge: true });
    add(dish, sph(0.3), glow, 0, 0, -0.5, { shadow: false });
    add(dish, cyl(0.1, 0.1, 1.2, 6), M.dark, 0, 0, -0.9, { rx: PI / 2 });
    limb.dish = dish;
    rig.spinners.push({ node: dish, axis: 'y', speed: 0.9, when: 'always' });
  } else if (id === 'drill') {
    add(hand, cyl(0.7, 0.7, 1.4, 10), M.dark, 0, -0.9, 0);
    add(hand, box(1.5, 0.3, 1.5), M.trim, 0, -0.2, 0, { edge: true });
    const bit = group(hand, 0, -1.6, 0);
    add(bit, cone(0.95, 3.8, 8), M.metal, 0, -1.9, 0, { rx: PI, edge: true });
    for (const y of [-0.7, -1.5, -2.3]) add(bit, cyl(0.85 - (-y - 0.7) * 0.2, 0.85 - (-y - 0.7) * 0.2, 0.18, 8), M.trim, 0, y, 0);
    limb.drill = bit;
    rig.spinners.push({ node: bit, axis: 'y', speed: 14, when: 'fight', limb });
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
    if (row === 'mid') add(base, box(1.3, 1.1, 1.3), M.sub, side * 0.25, 0, 0, { edge: true });
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
    const limb = { slot, row, side, kind: id, base, arm, elbow, hand, muzzle: null, blade: null, glow: null, dish: null, drill: null };
    tool(rig, hand, id, limb);
    rig.limbs.push(limb);
    rig.sockets[slot] = base;
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
    rig.sockets[slot] = stalk;
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
  } else if (id === 'turret') {
    add(tip, box(1.8, 1.5, 1.8), M.sub, 0, 0, 0.9, { edge: true });
    add(tip, box(2.0, 0.3, 2.0), M.trim, 0, 0.8, 0.9);
    turretGun(rig, tip, 'tail', { y: 1.1, z: 0.9, rx: -0.6, barrels: 1, len: 3.0 });
  }
  rig.tail = { id, root, segs, tip };
  rig.sockets.tail = root;
}

// ------------------------------------------------------------------ back pods

/** Where a back pod sits (torso space). */
export function podMount(side, bulk, depth) {
  return [side * 3.0 * bulk, 3.1, depth / 2 + 0.8];
}

/** A pod on each side of the back: a thruster, a missile rack or a slab of armour. */
export function buildPods(rig) {
  const { k, torso, spec, bulk, depth, makeFlame } = rig;
  const { add, group, M, box, cyl, cone, sph, warmGlow } = k;
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
    } else if (id === 'turret') {
      add(g, box(1.8, 1.6, 1.8), M.sub, 0, 0.9, 0.9, { edge: true });
      add(g, cyl(1.0, 1.1, 0.5, 10), M.accent, 0, 1.8, 0.9, { edge: true });
      turretGun(rig, g, slot, { y: 2.1, z: 0.9, rx: -0.7, barrels: 1, len: 3.0 });
    } else if (id === 'barrier') {
      add(g, cyl(0.5, 0.7, 1.8, 8), M.metal, 0, 0.9, 0.9);
      add(g, cyl(1.5, 1.5, 0.3, 14), M.accent, 0, 2.0, 0.9, { edge: true });
      add(g, sph(1.0, 12, 8), k.cyanGlow, 0, 2.5, 0.9, { shadow: false });
      add(g, cyl(1.7, 1.7, 0.12, 14), k.cyanGlow, 0, 2.1, 0.9, { shadow: false });
    } else if (id === 'radar') {
      add(g, cyl(0.3, 0.4, 2.4, 8), M.metal, 0, 1.2, 0.9);
      const dish = group(g, 0, 2.6, 0.9);
      add(dish, cyl(1.9, 0.3, 0.5, 16), M.main, 0, 0.1, 0, { edge: true });
      add(dish, box(0.2, 0.2, 1.6), M.trim, 0, 0.7, 0.4);
      add(dish, sph(0.25), k.glow, 0, 0.9, 0.9, { shadow: false });
      rig.spinners.push({ node: dish, axis: 'y', speed: 1.4, when: 'always' });
    }
    rig.pods2.push({ slot, side, kind: id, g });
    rig.sockets[slot] = g;
  }
}

// ------------------------------------------------------------------ auto-turrets

/**
 * A gun that aims itself: a ball on `parent` with its barrel along +z (so Object3D.lookAt points it at a target). The
 * motion layer swings it onto whatever the player code hands it (see `aimTurret` in motion.js) and eases it back to
 * its resting pose. `rx`/`ry` are the resting angles; the part is found again by its slot in `rig.turrets`.
 */
function turretGun(rig, parent, slot, o) {
  const { k } = rig;
  const { add, group, node, M, cyl, sph, glow } = k;
  const aim = group(parent, o.x ?? 0, o.y ?? 0, o.z ?? 0);
  aim.rotation.set(o.rx ?? 0, o.ry ?? 0, 0);
  add(aim, sph(0.8, 10, 8), M.dark);
  const n = o.barrels ?? 1;
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : (i - (n - 1) / 2) * 0.7;
    add(aim, cyl(0.26, 0.3, o.len ?? 2.8, 8), M.steel, x, 0, (o.len ?? 2.8) / 2 + 0.3, { rx: PI / 2 });
    add(aim, cyl(0.34, 0.34, 0.3, 8), M.trim, x, 0, (o.len ?? 2.8) + 0.2, { rx: PI / 2 });
    add(aim, cyl(0.16, 0.16, 0.1, 6), glow, x, 0, (o.len ?? 2.8) + 0.38, { rx: PI / 2, shadow: false });
  }
  const muzzle = node(aim, 0, 0, (o.len ?? 2.8) + 0.5);
  rig.turrets.push({ slot, aim, muzzle, rest: aim.quaternion.clone(), hold: 0, tgt: null });
}

// ------------------------------------------------------------------ wings

/** Where a wing's hinge is (torso space): the middle of the back, a little above the shoulder blades. */
export function wingMount(side, bulk, depth) {
  return [side * 1.05 * bulk, 3.9, depth / 2 + 1.7];
}

/**
 * Wings are built stretched out sideways from their hinge; the motion folds them down against the back and spreads
 * them under thrust (`rig.wings2`, each `{ g, side }`: the hinge group turns about z).
 */
export function buildWings(rig) {
  const { k, torso, spec, bulk, depth } = rig;
  const { add, group, M, box, cyl, cyanGlow, glow } = k;
  rig.wings2 = [];
  for (const [slot, side] of [['wingL', -1], ['wingR', 1]]) {
    const id = spec[slot];
    if (!id || id === 'none') continue;
    const [x, y, z] = wingMount(side, bulk, depth ?? 3.4);
    const g = group(torso, x, y, z);
    add(g, box(1.4, 1.2, 1.4), M.dark, 0, 0, 0, { edge: true });
    const at = (len) => side * (len / 2 + 0.6);
    if (id === 'fighter') {
      add(g, box(6.2, 0.16, 1.9), M.main, at(6.2), 0, 0.7, { edge: true });
      add(g, box(4.2, 0.16, 1.7), M.sub, at(4.2) + side * 0.5, 0, 2.2, { edge: true });
      add(g, box(0.2, 1.5, 1.8), M.accent, side * 6.4, 0.65, 1.9, { edge: true });
      add(g, box(5.4, 0.2, 0.25), M.trim, at(5.4), 0.1, -0.35);
      add(g, cyl(0.5, 0.45, 2.6, 8), M.metal, side * 1.8, -0.1, 1.2, { rx: PI / 2, edge: true });
      add(g, cyl(0.4, 0.4, 0.15, 8), cyanGlow, side * 1.8, -0.1, 2.55, { rx: PI / 2, shadow: false });
    } else if (id === 'angel') {
      for (let i = 0; i < 4; i++) {
        const f = group(g, 0, 0, 0.1 + i * 0.5);
        f.rotation.z = -side * (0.02 + i * 0.2);
        add(f, box(6.0 - i * 0.6, 0.14, 1.1), i % 2 ? M.sub : M.main, at(6.0 - i * 0.6), 0, 0, { edge: true });
        add(f, box(5.0 - i * 0.6, 0.18, 0.2), glow, at(5.0 - i * 0.6), 0.04, -0.4, { shadow: false });
      }
    } else if (id === 'blade') {
      add(g, box(8.4, 0.12, 1.0), M.metal, at(8.4), 0, 0.8, { edge: true });
      add(g, box(8.0, 0.16, 0.22), glow, at(8.0), 0, 0.35, { shadow: false });
      add(g, box(2.0, 0.3, 1.6), M.accent, at(2.0), 0, 0.5, { edge: true });
      add(g, box(1.6, 0.14, 0.6), M.trim, at(1.6) + side * 4, 0, 1.2);
    } else if (id === 'plate') {
      add(g, box(5.2, 0.5, 3.4), M.main, at(5.2), 0, 1.2, { edge: true });
      add(g, box(3.6, 0.55, 2.2), M.accent, at(3.6), 0, 1.2);
      add(g, box(5.3, 0.55, 0.5), M.trim, at(5.3), 0, 2.8);
    } else if (id === 'solar') {
      add(g, box(5.2, 0.14, 3.3), M.dark, at(5.2), 0, 1.0, { edge: true });
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) add(g, box(1.4, 0.18, 1.4), cyanGlow, side * (1.4 + i * 1.6), 0.02, 0.4 + j * 1.6, { shadow: false });
      add(g, box(5.3, 0.2, 0.2), M.trim, at(5.3), 0.05, -0.7);
    }
    rig.wings2.push({ slot, side, kind: id, g });
    rig.sockets[slot] = g;
  }
}

// ------------------------------------------------------------------ chest module

/** Where the chest module sits (torso space): the middle of the chest's front. */
export function moduleMount(rig) {
  return [0, 3.0, rig.zf - 0.3];
}

/** The chest module: a radar array, a second reactor, a self-aiming vulcan, a barrier emitter or a missile bay. */
export function buildModule(rig) {
  const { k, torso, spec } = rig;
  const { add, group, M, box, cyl, sph, glow, cyanGlow, energyGlow, warmGlow, greenGlow } = k;
  rig.moduleNode = null;
  rig.moduleSpin = null;
  const id = spec.chestMod;
  if (!id || id === 'none') return;
  const [x, y, z] = moduleMount(rig);
  const g = group(torso, x, y, z);
  if (id === 'radar') {
    add(g, box(3.2, 1.8, 0.5), M.dark, 0, 0, 0, { edge: true });
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) add(g, box(0.8, 0.6, 0.2), cyanGlow, (i - 1) * 1.0, (j - 0.5) * 0.7, -0.3, { shadow: false });
    add(g, box(3.4, 0.2, 0.7), M.trim, 0, 1.0, 0);
  } else if (id === 'reactor') {
    add(g, box(2.6, 2.4, 0.5), M.dark, 0, 0, 0, { edge: true });
    add(g, cyl(0.85, 0.85, 0.4, 14), glow, 0, 0, -0.3, { rx: PI / 2, shadow: false });
    add(g, cyl(1.2, 1.2, 0.2, 14), M.trim, 0, 0, -0.15, { rx: PI / 2 });
    for (const sx of [-1, 1]) add(g, box(0.3, 2.0, 0.4), M.accent, sx * 1.5, 0, 0);
    rig.moduleSpin = g.children[1];
  } else if (id === 'vulcan') {
    add(g, box(2.6, 1.8, 0.6), M.sub, 0, 0, 0, { edge: true });
    add(g, cyl(0.95, 1.0, 0.5, 12), M.accent, 0, 0.1, -0.5, { rx: PI / 2, edge: true });
    turretGun(rig, g, 'chestMod', { y: 0.1, z: -0.8, ry: PI, barrels: 2, len: 2.2 });
  } else if (id === 'emitter') {
    add(g, cyl(1.5, 1.5, 0.5, 16), M.dark, 0, 0, 0, { rx: PI / 2, edge: true });
    add(g, cyl(1.15, 1.15, 0.2, 16), energyGlow, 0, 0, -0.35, { rx: PI / 2, shadow: false });
    add(g, sph(0.55, 10, 8), cyanGlow, 0, 0, -0.55, { shadow: false });
    rig.moduleSpin = g.children[1];
  } else if (id === 'bay') {
    add(g, box(3.0, 2.2, 0.6), M.dark, 0, 0, 0, { edge: true });
    for (const ox of [-0.7, 0.7]) for (const oy of [-0.5, 0.5]) {
      add(g, cyl(0.38, 0.38, 0.4, 8), M.sub, ox, oy, -0.4, { rx: PI / 2 });
      add(g, cyl(0.26, 0.26, 0.1, 8), warmGlow, ox, oy, -0.62, { rx: PI / 2, shadow: false });
    }
    add(g, box(3.2, 0.25, 0.7), M.accent, 0, 1.2, 0, { edge: true });
    void greenGlow;
  }
  rig.moduleNode = g;
  rig.sockets.chestMod = g;
}

// ------------------------------------------------------------------ flank pods

/** A pod on each hip: a missile rack, side thrusters, armour plates or saber hilts. The hip's position depends on the layout. */
export function buildFlanks(rig) {
  const { k, hips, spec, makeFlame } = rig;
  const { add, group, M, box, cyl, cone, warmGlow, glow } = k;
  rig.flanks = [];
  const at = rig.flankAt ?? { x: 3.25, y: -0.1, z: 0.5 };
  for (const [slot, side] of [['flankL', -1], ['flankR', 1]]) {
    const id = spec[slot];
    if (!id || id === 'none') continue;
    const g = group(hips, side * at.x, at.y, at.z);
    add(g, box(1.0, 1.4, 1.6), M.dark, -side * 0.2, 0, 0, { edge: true });
    if (id === 'rack') {
      add(g, box(1.5, 1.9, 3.0), M.sub, side * 0.4, -0.1, -0.2, { edge: true });
      for (const oy of [-0.5, 0.5]) {
        add(g, cyl(0.32, 0.32, 0.3, 8), M.dark, side * 0.4, oy - 0.1, -1.75, { rx: PI / 2 });
        add(g, cyl(0.22, 0.22, 0.1, 8), warmGlow, side * 0.4, oy - 0.1, -1.95, { rx: PI / 2, shadow: false });
      }
      add(g, box(1.6, 0.3, 3.1), M.accent, side * 0.4, 1.0, -0.2, { edge: true });
    } else if (id === 'vernier') {
      add(g, cyl(0.8, 0.65, 2.0, 10), M.metal, side * 0.5, 0, 0.9, { rx: PI / 2, edge: true });
      add(g, cyl(0.9, 0.9, 0.3, 10), M.accent, side * 0.5, 0, -0.1, { rx: PI / 2 });
      add(g, cone(0.6, 0.8, 10), M.dark, side * 0.5, 0, 2.0, { rx: -PI / 2 });
      makeFlame(g, side * 0.5, 0, 2.2, PI / 2, 0.55, 3.0);
    } else if (id === 'plate') {
      add(g, box(0.7, 3.4, 2.8), M.main, side * 0.6, -1.2, 0, { edge: true });
      add(g, box(0.75, 2.4, 1.6), M.accent, side * 0.65, -1.2, 0);
      add(g, box(0.8, 0.5, 2.9), M.trim, side * 0.6, 0.5, 0);
    } else if (id === 'blade') {
      for (const oz of [-0.7, 0.7]) {
        add(g, cyl(0.26, 0.26, 2.6, 8), M.metal, side * 0.5, oz * 0.3, oz, { rz: PI / 2 });
        add(g, box(0.7, 0.5, 0.5), M.trim, side * 1.7, oz * 0.3, oz, { edge: true });
        add(g, cyl(0.18, 0.18, 0.12, 6), glow, side * 1.9, oz * 0.3, oz, { rz: PI / 2, shadow: false });
      }
    }
    rig.flanks.push({ slot, side, kind: id, g });
    rig.sockets[slot] = g;
  }
}
