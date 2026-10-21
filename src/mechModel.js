// Procedural mobile-suit model + animation rig. Everything is built from boxes, cylinders and cones, so no
// model files are needed. The geometry for each part lives in src/model/ (one small builder per part style);
// this file assembles a mech from a spec and hands it to the motion layer (src/model/motion.js), which
// animates it. Geometry is shared between all mechs; materials are per-mech so a hit-flash only lights up
// the mech that was hit.

import * as THREE from 'three';
import { makeKit } from './model/kit.js';
import { createMotion } from './model/motion.js';
import { HIP_Y, MECH_HEIGHT, makeSkeleton } from './model/skeleton.js';
import { buildArms, buildLegs, buildPelvis, buildTorso } from './model/body.js';
import { buildHead } from './model/head.js';
import { buildFlanks, buildLimbs, buildModule, buildPods, buildSideHeads, buildTail, buildWings, limbMount, moduleMount, podMount, sideHeadMount, wingMount } from './model/extras.js';
import { buildBackpack, buildMarks, buildOffhand, buildShoulders, buildSub, buildWeapon } from './model/gear.js';

export { HIP_Y, MECH_HEIGHT };

/** The names of the garage hardpoints a model can locate (see HARDPOINTS in parts.js). */
export const ANCHORS = ['head', 'chest', 'arms', 'legs', 'shoulderL', 'shoulderR', 'back', 'waist', 'handR', 'handL', 'hips',
  'armLowerL', 'armLowerR', 'armUpperL', 'armUpperR', 'headL', 'headR', 'tail', 'podL', 'podR',
  'armMidL', 'armMidR', 'wingL', 'wingR', 'chestMod', 'flankL', 'flankR'];

/** Accept the older spec shapes (one `shoulder`, a boolean `shield`) alongside the current ones. */
function normalise(spec) {
  return {
    ...spec,
    shoulderL: spec.shoulderL ?? spec.shoulder ?? 'std',
    shoulderR: spec.shoulderR ?? spec.shoulder ?? 'std',
    offhand: spec.offhand ?? (spec.shield ? 'shield' : 'none'),
    crest: spec.crest ?? 'auto',
  };
}

export function buildMech(rawSpec) {
  const spec = normalise(rawSpec);
  const k = makeKit(spec);
  const { P, flashMats, group, node } = k;
  const bulk = spec.bulk ?? 1;

  const sk = makeSkeleton(spec); // this mech's own proportions: leg and arm lengths, leg layout
  const root = new THREE.Group();
  const hips = group(root, 0, sk.hipY, 0);
  const flames = [];
  const makeFlame = (parent, x, y, z, rx, radius, length) => {
    const g = group(parent, x, y, z);
    g.rotation.x = rx;
    const mat = new THREE.MeshBasicMaterial({
      color: P.flame ?? 0x58c8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const cone = new THREE.Mesh(k.cone(radius, length), mat);
    cone.position.y = length / 2; // base on the nozzle, tip pointing out along +Y
    g.add(cone);
    const core = new THREE.Mesh(k.cone(radius * 0.45, length * 0.7), new THREE.MeshBasicMaterial({
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

  // the order matters: the two calf thrusters must be flames 0 and 1, then the backpack's, then any shoulder verniers
  const rig = { k, spec, sk, bulk, root, hips, flames, makeFlame, whips: [], wings: [], sockets: {}, turrets: [], turretsOff: [], spinners: [] };
  // every part is built with the kit of its paint zone: the body's colours, or the zone's own (see ZONES in parts.js)
  const built = (zone, fn) => {
    const pal = spec.zones?.[zone];
    rig.k = pal ? k.variant(pal, zone) : k;
    fn(rig);
    rig.k = k;
  };
  built('legs', buildPelvis);
  built('legs', buildLegs);
  built('chest', buildTorso);
  built('head', buildHead);
  built('back', buildBackpack);
  built('shoulders', buildShoulders);
  built('arms', buildArms);
  built('weapon', buildWeapon);
  built('weapon', buildOffhand);
  built('weapon', buildSub);
  buildMarks(rig);
  built('rig', buildLimbs);
  built('head', buildSideHeads);
  built('rig', buildTail);
  built('rig', buildPods);
  built('rig', buildWings);
  built('rig', buildModule);
  built('rig', buildFlanks);
  const { torso, head, legs, armL, armR, saber } = rig;

  // hardpoint anchors: where the garage draws its clickable markers
  const anchors = {
    head: node(head, 0, 1.2, 0),
    chest: node(torso, 0, 2.6, 0),
    arms: node(armR.elbow, 0, -1.6, 0),
    legs: rig.legAnchor ?? node(legs[1].leg, 0, -2.6, 0),
    shoulderL: node(rig.pads.L, 0, 1.3, 0),
    shoulderR: node(rig.pads.R, 0, 1.3, 0),
    back: node(torso, 0, 2.8, rig.depth / 2 + 1.7),
    waist: node(hips, 0, -0.2, 0),
    handR: node(armR.hand, 0, -3.0, 0),
    handL: node(armL.elbow, -2.0, -2.0, -0.4),
    hips: node(hips, 3.4, -0.4, 0.4),
    // the sockets for the extra parts: empty or not, the garage marks them
    armLowerL: node(torso, ...limbMount('lower', -1, bulk, rig.depth)),
    armLowerR: node(torso, ...limbMount('lower', 1, bulk, rig.depth)),
    armUpperL: node(torso, ...limbMount('upper', -1, bulk, rig.depth)),
    armUpperR: node(torso, ...limbMount('upper', 1, bulk, rig.depth)),
    headL: node(torso, ...sideHeadMount(-1, bulk)),
    headR: node(torso, ...sideHeadMount(1, bulk)),
    tail: node(hips, (rig.tailAt ?? { x: 0 }).x, (rig.tailAt ?? { y: -0.2 }).y, (rig.tailAt ?? { z: 2.0 }).z + 1.5),
    podL: node(torso, ...podMount(-1, bulk, rig.depth)),
    podR: node(torso, ...podMount(1, bulk, rig.depth)),
    armMidL: node(torso, ...limbMount('mid', -1, bulk, rig.depth)),
    armMidR: node(torso, ...limbMount('mid', 1, bulk, rig.depth)),
    wingL: node(torso, ...wingMount(-1, bulk, rig.depth)),
    wingR: node(torso, ...wingMount(1, bulk, rig.depth)),
    chestMod: node(torso, ...moduleMount(rig)),
    flankL: node(hips, -(rig.flankAt ?? { x: 3.25 }).x, (rig.flankAt ?? { y: -0.1 }).y, (rig.flankAt ?? { z: 0.5 }).z),
    flankR: node(hips, (rig.flankAt ?? { x: 3.25 }).x, (rig.flankAt ?? { y: -0.1 }).y, (rig.flankAt ?? { z: 0.5 }).z),
  };

  // the motion layer (src/model/motion.js) owns every moving part from here on
  const motion = createMotion(rig);

  /** Emissive tint on every armour material: white for hit flashes, any colour for auras. */
  function tint(r, g, b) {
    for (const m of flashMats) m.emissive.setRGB(r, g, b);
  }

  const tmp = new THREE.Vector3();
  function muzzleWorld(out = tmp) {
    root.updateWorldMatrix(true, true);
    return rig.muzzle.getWorldPosition(out);
  }

  /** World position of a shoulder mount's muzzle (`side` is 'L' or 'R'); falls back to the main muzzle if that shoulder has no mount. */
  function mountMuzzleWorld(side, out = tmp) {
    const m = rig.mountMuzzle[side];
    if (!m) return muzzleWorld(out);
    root.updateWorldMatrix(true, true);
    return m.getWorldPosition(out);
  }

  /** World position of the head vulcans' muzzle (falls back to the main muzzle if there are none). */
  function headMuzzleWorld(out = tmp) {
    if (!rig.headMuzzle) return muzzleWorld(out);
    root.updateWorldMatrix(true, true);
    return rig.headMuzzle.getWorldPosition(out);
  }

  /** World position of the muzzle of extra arm `i` (an index into rig.limbs); falls back to the main muzzle. */
  function limbMuzzleWorld(i, out = tmp) {
    const m = rig.limbs[i]?.muzzle;
    if (!m) return muzzleWorld(out);
    root.updateWorldMatrix(true, true);
    return m.getWorldPosition(out);
  }

  // ---- parts with health of their own: where they are, and tearing one off or putting it back
  const _pp = new THREE.Vector3();
  const legOf = (slot) => (slot.startsWith('leg') ? rig.legs[Number(slot.slice(3))] ?? null : null);

  /** How far `point` (world) is from the nearest part of the socket or leg in `slot`; Infinity if it is gone. */
  function partDistance(slot, point) {
    root.updateWorldMatrix(true, true);
    const leg = legOf(slot);
    if (leg) {
      if (leg.lost) return Infinity;
      return Math.min(leg.shin.getWorldPosition(_pp).distanceTo(point), leg.foot.getWorldPosition(_pp).distanceTo(point));
    }
    const node = rig.sockets[slot];
    if (!node || node.userData.broken) return Infinity;
    let d = node.getWorldPosition(_pp).distanceTo(point);
    const limb = rig.limbs.find((l) => l.slot === slot);
    if (limb) d = Math.min(d, limb.elbow.getWorldPosition(_pp).distanceTo(point), limb.hand.getWorldPosition(_pp).distanceTo(point));
    const wing = rig.wings2?.find((w) => w.slot === slot);
    if (wing) d = Math.min(d, wing.g.localToWorld(_pp.set(wing.side * 3.2, 0, 1.2)).distanceTo(point));
    if (slot === 'tail' && rig.tail) for (const seg of rig.tail.segs.slice(1, 4)) d = Math.min(d, seg.getWorldPosition(_pp).distanceTo(point));
    return d;
  }

  /** Tear a part (a socket's, or a leg) off: its parts stop animating and its guns stop; `shed` gets the node (still in place) to fly off. Returns false if there was nothing to break. */
  function breakPart(slot, shed) {
    const leg = legOf(slot);
    const node = leg ? (leg.lost ? null : leg.leg) : rig.sockets[slot];
    if (!node || node.userData.broken) return false;
    if (leg) leg.lost = true;
    node.userData.broken = true;
    const limb = rig.limbs.find((l) => l.slot === slot);
    if (limb) limb.broken = true;
    const head = rig.sideHeads.find((h) => h.slot === slot);
    if (head) head.broken = true;
    const ti = rig.turrets.findIndex((t) => t.slot === slot);
    if (ti >= 0) { rig.turretsOff.push(rig.turrets[ti]); rig.turrets.splice(ti, 1); }
    shed?.(node);
    node.visible = false;
    return true;
  }

  /** Put a torn-off part back (the pit stop). */
  function restorePart(slot) {
    const leg = legOf(slot);
    const node = leg ? leg.leg : rig.sockets[slot];
    if (!node || !node.userData.broken) return;
    node.userData.broken = false;
    node.visible = true;
    if (leg) leg.lost = false;
    const limb = rig.limbs.find((l) => l.slot === slot);
    if (limb) limb.broken = false;
    const head = rig.sideHeads.find((h) => h.slot === slot);
    if (head) head.broken = false;
    const ti = rig.turretsOff.findIndex((t) => t.slot === slot);
    if (ti >= 0) rig.turrets.push(...rig.turretsOff.splice(ti, 1));
  }

  /** The node of the part fitted in a socket (an extra arm, side head, tail or pod), so the garage can pop it in; null if the socket is empty. */
  function partNode(slot) {
    return rig.sockets[slot] ?? null;
  }

  /** World position of the muzzle of the self-aiming gun in `slot` (tail, a pod or the chest); falls back to the main muzzle. */
  function turretMuzzleWorld(slot, out = tmp) {
    const t = rig.turrets.find((x) => x.slot === slot);
    if (!t) return muzzleWorld(out);
    root.updateWorldMatrix(true, true);
    return t.muzzle.getWorldPosition(out);
  }

  /** World position of a garage hardpoint (one of ANCHORS). */
  function anchorWorld(name, out = tmp) {
    root.updateWorldMatrix(true, true);
    return anchors[name].getWorldPosition(out);
  }

  return {
    root, tint, muzzleWorld, mountMuzzleWorld, headMuzzleWorld, limbMuzzleWorld, turretMuzzleWorld, partNode, partDistance, breakPart, restorePart, anchorWorld,
    update: motion.update, land: motion.land, recoil: motion.recoil, setSaber: motion.setSaber, hit: motion.hit, flare: motion.flare, fireLimb: motion.fireLimb, aimTurret: motion.aimTurret,
    motion: motion.state, rig, sk, height: sk.height, radius: sk.radius,
    flashMats, hips, torso, armR, armL, head, saber, feet: legs.map((l) => l.foot),
  };
}
