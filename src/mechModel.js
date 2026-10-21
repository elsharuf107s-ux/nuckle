// Procedural mobile-suit model + animation rig. Everything is built from boxes, cylinders and cones, so no
// model files are needed. The geometry for each part lives in src/model/ (one small builder per part style);
// this file assembles a mech from a spec, then animates it. Geometry is shared between all mechs; materials
// are per-mech so a hit-flash only lights up the mech that was hit.

import * as THREE from 'three';
import { clamp, damp, lerp } from './util.js';
import { makeKit } from './model/kit.js';
import { HIP_Y, MECH_HEIGHT, PIVOT, SHIN, SOLE, THIGH } from './model/skeleton.js';
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
  const rig = { k, spec, bulk, root, hips, flames, makeFlame };
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
  const { torso, head, legs, armL, armR, saber, blade, chargeGlow, chargeMat, eyeNode, rifle, L } = rig;

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

  // =================================================================== animation
  //
  // Locomotion is driven by distance travelled, so the feet do not slide: the stride phase advances by how
  // far the mech moved, and the pelvis height comes from the legs' own geometry (the more extended leg is
  // the one touching the ground, which also gives the walk its natural bob). The lower body turns toward the
  // direction of travel, so strafing and backing up read as steps rather than a moonwalk, while the chest
  // keeps facing the aim. Dashes and lunges glide in a skating stance instead of sprinting, landings crouch,
  // idle mechs breathe, and the saber swings anticipate, strike and follow through on a wrist that whips.

  const PELVIS = PIVOT; // the hip joint's drop below the pelvis centre (the segment lengths come from skeleton.js)
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
    root, update, land, recoil, setSaber, tint, muzzleWorld, mountMuzzleWorld, headMuzzleWorld, anchorWorld,
    flashMats, hips, torso, armR, head, saber, feet: legs.map((l) => l.foot),
  };
}
