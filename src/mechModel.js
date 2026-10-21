// Procedural mobile-suit model + animation rig. Everything is built from boxes, cylinders and cones, so no
// model files are needed. The geometry for each part lives in src/model/ (one small builder per part style);
// this file assembles a mech from a spec and hands it to the motion layer (src/model/motion.js), which
// animates it. Geometry is shared between all mechs; materials are per-mech so a hit-flash only lights up
// the mech that was hit.

import * as THREE from 'three';
import { makeKit } from './model/kit.js';
import { createMotion } from './model/motion.js';
import { HIP_Y, MECH_HEIGHT } from './model/skeleton.js';
import { buildArms, buildLegs, buildPelvis, buildTorso } from './model/body.js';
import { buildHead } from './model/head.js';
import { buildBackpack, buildMarks, buildOffhand, buildShoulders, buildSub, buildWeapon } from './model/gear.js';

export { HIP_Y, MECH_HEIGHT };

/** The names of the garage hardpoints a model can locate (see HARDPOINTS in parts.js). */
export const ANCHORS = ['head', 'chest', 'arms', 'legs', 'shoulderL', 'shoulderR', 'back', 'waist', 'handR', 'handL', 'hips'];

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

  const root = new THREE.Group();
  const hips = group(root, 0, HIP_Y, 0);
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
  const rig = { k, spec, bulk, root, hips, flames, makeFlame, whips: [], wings: [] };
  buildPelvis(rig);
  buildLegs(rig);
  buildTorso(rig);
  buildHead(rig);
  buildBackpack(rig);
  buildShoulders(rig);
  buildArms(rig);
  buildWeapon(rig);
  buildOffhand(rig);
  buildSub(rig);
  buildMarks(rig);
  const { torso, head, legs, armL, armR, saber } = rig;

  // hardpoint anchors: where the garage draws its clickable markers
  const anchors = {
    head: node(head, 0, 1.2, 0),
    chest: node(torso, 0, 2.6, 0),
    arms: node(armR.elbow, 0, -1.6, 0),
    legs: node(legs[1].leg, 0, -2.6, 0),
    shoulderL: node(rig.pads.L, 0, 1.3, 0),
    shoulderR: node(rig.pads.R, 0, 1.3, 0),
    back: node(torso, 0, 2.8, rig.depth / 2 + 1.7),
    waist: node(hips, 0, -0.2, 0),
    handR: node(armR.hand, 0, -3.0, 0),
    handL: node(armL.elbow, -2.0, -2.0, -0.4),
    hips: node(hips, 3.4, -0.4, 0.4),
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

  /** World position of a garage hardpoint (one of ANCHORS). */
  function anchorWorld(name, out = tmp) {
    root.updateWorldMatrix(true, true);
    return anchors[name].getWorldPosition(out);
  }

  return {
    root, tint, muzzleWorld, mountMuzzleWorld, headMuzzleWorld, anchorWorld,
    update: motion.update, land: motion.land, recoil: motion.recoil, setSaber: motion.setSaber, hit: motion.hit, flare: motion.flare,
    motion: motion.state, rig,
    flashMats, hips, torso, armR, armL, head, saber, feet: legs.map((l) => l.foot),
  };
}
