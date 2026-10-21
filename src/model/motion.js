// The mech's motion: everything that moves the rig once it is built. Mech._syncModel calls update(dt, s) every
// step with the body's state (speed and heading, ground contact, what the pilot is doing), and a few one-shot
// cues (land, recoil, hit, setSaber) come straight from the game code.
//
// The layers, from the ground up:
//  - locomotion: planted-foot walking solved with two-bone leg IK, a crouch before a jump and a push-off, a
//    skating glide on steps with a hard lean into them, a forward flight pose under thrust, skids after a step,
//    and landings that crouch (a hard one drops to one knee)
//  - the upper body: a rifle at the ready that snaps straight at the target when it fires and holds the pose for
//    a beat (both hands on a heavy gun), shoulder mounts that track the aim and kick back, the saber drawn from
//    the backpack and racked again afterwards, a lunge with the blade trailing, four keyframed swings
//  - reactions: hit flinches on springs, staggers, a knockdown with a get-up, the breakdown before a wreck blows
//  - secondary motion: skirt plates pushed out by the thighs and swinging on their hinges, shoulder pads riding
//    the arms, wings that spread under thrust, whip antennas that sway, crests that rattle on impact
//
// Poses snap in fast and settle slowly: every arm joint eases toward its target at a rate that depends on what
// is happening (a swing or a shot is near-instant, a change of stance takes a moment), so nothing pops.

import * as THREE from 'three';
import { clamp, damp, lerp } from '../util.js';
import { HIP_Y, PIVOT, SHIN, SOLE, THIGH } from './skeleton.js';

const TAU = Math.PI * 2;
const ease = (t) => t * t * (3 - 2 * t);
const easeOut = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const unit = (t) => clamp(t, 0, 1);

const UPPER = 3.8, FORE = 4.0;  // arm segments: shoulder to elbow, elbow to the grip (see buildArms)
const SHOT_HOLD = 0.5;          // seconds the firing pose is held after a shot
const DRAW_TIME = 0.26;         // reach back for the hilt, then out with the blade
const SHEATH_TIME = 0.42;       // blade off, rack the hilt, take the gun back

// ---- saber swings. Each is four poses: wind-up, strike, follow-through, then back to the guard.
// y/x/z: right arm yaw (positive swings it to the mech's left), pitch (0 hanging, PI/2 forward, PI up) and roll;
// el: elbow bend; wr: wrist (tilts the blade forward from the line of the forearm); tw: torso twist (positive
// turns left); ln: torso pitch (negative leans forward); cr: crouch. The strike spans the moment the game code
// spawns the arc (t = 0.28) and lands the hit (t = 0.45).
export const GUARD = { y: 0.4, x: 0.75, z: -0.15, el: 1.15, wr: 0.55, tw: 0.12, ln: -0.04, cr: 0.25 };
export const SWING = {
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
  thrust: [ // drawn back to the hip with the point forward, then a full-length stab down the centre line
    { t: 0.28, y: -0.35, x: 0.55, z: 0.25, el: 1.45, wr: -0.45, tw: -0.55, ln: 0.04, cr: 0.35 },
    { t: 0.48, y: -0.32, x: 1.8, z: -0.05, el: 0.04, wr: 0.02, tw: 0.42, ln: -0.3, cr: 0.62 },
    { t: 0.7, y: -0.3, x: 1.72, z: 0, el: 0.15, wr: 0.0, tw: 0.38, ln: -0.26, cr: 0.55 },
  ],
  slash3: [ // overhead chop: the finisher
    { t: 0.3, y: 0.2, x: 2.95, z: 0, el: 0.95, wr: 0.75, tw: 0.15, ln: 0.26, cr: 0.15 },
    { t: 0.5, y: 0.05, x: 1.55, z: 0, el: 0.1, wr: 0.0, tw: -0.05, ln: -0.42, cr: 0.8 },
    { t: 0.74, y: 0.0, x: 1.4, z: 0, el: 0.25, wr: -0.1, tw: -0.05, ln: -0.38, cr: 0.7 },
  ],
};
// the boost lunge before a combo: chest down, blade held low and trailing behind, the free arm reaching ahead
const LUNGE = { y: -0.55, x: 0.15, z: 0.3, el: 0.35, wr: -1.15, tw: -0.32, ln: -0.5, cr: 0.35 };
const KEYS = ['y', 'x', 'z', 'el', 'wr', 'tw', 'ln', 'cr'];
function swingPose(kind, t, out) {
  const k = SWING[kind];
  const frames = [{ t: 0, ...GUARD }, ...k, { t: 1, ...GUARD }];
  let i = 0;
  while (i < frames.length - 2 && t > frames[i + 1].t) i++;
  const a = frames[i], b = frames[i + 1];
  const u = unit((t - a.t) / (b.t - a.t));
  const e = i === 1 ? easeOut(u) : ease(u); // the strike snaps; everything else eases
  for (const key of KEYS) out[key] = lerp(a[key], b[key], e);
  return out;
}

/** A damped spring on one value: pulled toward `target`, kicked by adding to `v`; kept within `lim` of the target. */
function spring(sp, target, k, c, dt, lim = 1) {
  sp.v += (k * (target - sp.x) - c * sp.v) * dt;
  sp.x += sp.v * dt;
  if (sp.x > target + lim) { sp.x = target + lim; sp.v = Math.min(sp.v, 0); }
  else if (sp.x < target - lim) { sp.x = target - lim; sp.v = Math.max(sp.v, 0); }
  return sp.x;
}
const sp = () => ({ x: 0, v: 0 });

// scratch objects for the arm solver
const _d = new THREE.Vector3(), _h = new THREE.Vector3(), _e = new THREE.Vector3(), _n = new THREE.Vector3();
const _pp = new THREE.Vector3(), _ep = new THREE.Vector3(), _cr = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qh = new THREE.Quaternion(), _qd = new THREE.Quaternion(), _eu = new THREE.Euler(0, 0, 0, 'YXZ');
const X_AXIS = new THREE.Vector3(1, 0, 0), DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Two-bone IK for an arm, in torso space: the shoulder rotation (written to `outQ`) and the elbow bend (returned)
 * that put the grip at `target`, with the elbow swung toward `pole`.
 */
function solveArm(shoulder, target, pole, outQ) {
  _d.subVectors(target, shoulder);
  const d = clamp(_d.length(), Math.abs(UPPER - FORE) + 0.05, UPPER + FORE - 0.05);
  const bend = Math.acos(clamp((d * d - UPPER * UPPER - FORE * FORE) / (2 * UPPER * FORE), -1, 1));
  // the grip in the arm's own frame, with the forearm folded forward by `bend`
  _h.set(0, -UPPER - FORE * Math.cos(bend), -FORE * Math.sin(bend)).normalize();
  _n.copy(_d).normalize();
  outQ.setFromUnitVectors(_h, _n);
  // swivel about the shoulder-to-grip line so the elbow points toward the pole
  _e.set(0, -UPPER, 0).applyQuaternion(outQ);
  _ep.copy(_e).addScaledVector(_n, -_e.dot(_n));
  _pp.copy(pole).addScaledVector(_n, -pole.dot(_n));
  if (_ep.lengthSq() > 1e-6 && _pp.lengthSq() > 1e-6) {
    const phi = Math.atan2(_cr.crossVectors(_ep, _pp).dot(_n), _ep.dot(_pp));
    outQ.premultiply(_qa.setFromAxisAngle(_n, phi));
  }
  return bend;
}

/**
 * Two-bone IK in a leg's plane: the thigh and knee angles that put the ankle at (fx ahead of the hip joint,
 * fy above it; negative is below). The knee bends backward, like a person's. Out of reach, the leg straightens.
 */
const REACH = THIGH + SHIN - 0.05;
function ik(fx, fy, out) {
  const d = clamp(Math.hypot(fx, fy), Math.abs(THIGH - SHIN) + 0.05, REACH);
  const toward = Math.atan2(fx, -fy); // the target's angle forward of straight down
  const hip = Math.acos(clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1));
  const knee = Math.acos(clamp((THIGH * THIGH + SHIN * SHIN - d * d) / (2 * THIGH * SHIN), -1, 1));
  out[0] = toward + hip;
  out[1] = -(Math.PI - knee);
  return out;
}

export function createMotion(rig) {
  const { spec, hips, torso, head, legs, armL, armR, saber, blade, rifle, flames, chargeGlow, chargeMat, eyeNode, L } = rig;
  const scale = spec.scale ?? 1;
  const meleeOnly = spec.weapon === 'saber' || spec.weapon === 'greatsword'; // the "gun" is the hilt itself
  const twoHanded = rig.foregrip !== null && rig.foregrip !== undefined;
  const PELVIS = PIVOT; // the hip joint's drop below the pelvis centre
  const TORSO_Y = torso.position.y;
  hips.rotation.order = 'YXZ';
  torso.rotation.order = 'YXZ';
  const glowColor = rig.k.glow.color.clone();

  const gait = [{ fx: 0, fz: 0, lift: 0, swing: 0 }, { fx: 0, fz: 0, lift: 0, swing: 0 }];
  const st = {
    phase: 0, back: false, legYaw: 0, air: 0, skate: 0, idle: 1, fight: 0, lean: 0, roll: 0, crouch: 0, pace: 0,
    land: 0, kneel: 0, recoil: 0, shot: 0, aim: 0, brace: 0, boost: 0, saberExt: 0, flare: 0, takeoff: 0,
    flight: 0, step: 0, stepX: 0, stepZ: 0, skid: 0, launch: 0, knockW: 0, dieW: 0,
    mountRec: { L: 0, R: 0 }, mountPitch: { L: 0, R: 0 },
    draw: -1, sheath: -1, inHand: false, gunIn: true, grip: 0,
    wasGrounded: true, prevDash: 0, pf: 0, pr: 0, pvy: 0,
    flameTime: Math.random() * 10, t: Math.random() * 10,
  };
  let saberOn = false;

  // springs: hit reactions, then the secondary motion
  const hit = { p: sp(), r: sp(), hp: sp(), hy: sp(), arm: sp() };
  const crest = sp();
  const skirt = { FL: sp(), FR: sp(), FC: sp(), SL: sp(), SR: sp(), B: sp() };
  const pads = { L: { x: sp(), z: sp() }, R: { x: sp(), z: sp() } };
  const wings = rig.wings.map(() => sp());
  const whips = rig.whips.map(() => ({ x: sp(), z: sp() }));

  // the arms ease toward their targets (Euler angles in the YXZ order the arm groups use)
  const armRS = { y: 0.12, x: 1.05, z: 0, el: 0.45, wr: 0 };
  const armLS = { y: -0.05, x: 0.22, z: 0.1, el: 0.45 };
  const aR = { y: 0, x: 0, z: 0, el: 0, wr: 0 }, aL = { y: 0, x: 0, z: 0, el: 0 }; // this step's targets
  const pose = {};
  const ikQ = new THREE.Quaternion();
  const vT = new THREE.Vector3(), vS = new THREE.Vector3(), vPole = new THREE.Vector3();
  const gunAt = new THREE.Vector3(), gunDir = new THREE.Vector3();

  // The gun and the saber trade places: drawing first clips the gun to the rear skirt, then takes the hilt off the
  // backpack; putting the saber away racks the hilt, then takes the gun back. (A melee build's "gun" is its hilt.)
  /** The gun in the hand (true) or on the rear skirt (false). */
  function gunInHand(on) {
    st.gunIn = on;
    rifle.visible = on;
    if (rig.holster) rig.holster.visible = !on;
  }
  /** The saber in the hand (true) or racked on the backpack (false). */
  function saberInHand(on) {
    st.inHand = on;
    saber.visible = on;
    if (rig.hilts) rig.hilts.R.visible = !on;
  }
  gunInHand(true);
  saberInHand(false);

  function setSaber(on) {
    if (on === saberOn) return;
    saberOn = on;
    if (on) {
      st.sheath = -1;
      if (!st.inHand) {
        gunInHand(false);
        if (meleeOnly) saberInHand(true); // the hilt is already in the hand
        else st.draw = 0;
      }
    } else {
      if (st.draw >= 0 && !st.inHand) { st.draw = -1; gunInHand(true); } // let go before it was out: just take the gun back
      else if (st.inHand) st.sheath = meleeOnly ? 0.3 : 0; // a melee build just lets the blade die
      st.draw = -1;
    }
  }

  function update(dt, s) {
    st.t += dt;
    const v = s.speed / scale; // ground speed in model units
    const grounded = s.grounded;
    const vy = s.vy ?? 0;
    const atk = s.attack && (SWING[s.attack.kind] || s.attack.kind === 'lunge') ? s.attack : null;
    const lunge = atk && atk.kind === 'lunge' ? atk : null;
    const swing = atk && !lunge ? atk : null;
    const knock = s.knock ?? null;
    const dying = s.dying ?? 0;
    const relaxed = !!s.relaxed;

    // ---- what changed since the last step: velocity kicks drive the springs; takeoffs and steps start their poses
    const dF = (s.localFwd - st.pf) / scale, dR = (s.localRight - st.pr) / scale, dY = (vy - st.pvy) / scale;
    st.pf = s.localFwd; st.pr = s.localRight; st.pvy = vy;
    if (st.wasGrounded && !grounded && vy > 20) { st.takeoff = 1; st.flare = Math.max(st.flare, 1); }
    st.wasGrounded = grounded;
    if (s.dash > st.prevDash + 0.4) {
      st.flare = Math.max(st.flare, 0.8);
      const l = Math.hypot(s.localFwd, s.localRight) || 1;
      st.stepX = s.localRight / l;
      st.stepZ = s.localFwd / l;
    }
    st.prevDash = s.dash;

    st.air = damp(st.air, grounded ? 0 : 1, grounded ? 16 : 7, dt);
    st.land = Math.max(0, st.land - dt * 2.6);
    st.kneel = Math.max(0, st.kneel - dt * 1.5);
    st.recoil = Math.max(0, st.recoil - dt * 7);
    st.shot = Math.max(0, st.shot - dt);
    st.brace = Math.max(0, st.brace - dt * 2.5);
    st.takeoff = Math.max(0, st.takeoff - dt * 2.8);
    st.flare = Math.max(0, st.flare - dt * 3);
    for (const side of ['L', 'R']) st.mountRec[side] = Math.max(0, st.mountRec[side] - dt * 5);
    st.knockW = damp(st.knockW, knock ? (knock.phase === 'rise' ? 1 - unit((knock.t - 0.38) / 0.32) : 1) : 0, knock ? 18 : 8, dt);
    st.dieW = damp(st.dieW, dying > 0 ? 1 : 0, 14, dt);
    st.launch = damp(st.launch, s.launch ?? 0, 10, dt);
    const down = Math.max(st.knockW, st.dieW); // how far a knockdown or a breakdown has taken over

    // ---- the saber in and out of the hand
    if (st.draw >= 0) {
      st.draw += dt / DRAW_TIME;
      if (st.draw >= 0.5 && !st.inHand) saberInHand(true);
      if (st.draw >= 1) st.draw = -1;
    }
    if (st.sheath >= 0) {
      st.sheath += dt / SHEATH_TIME;
      if (st.sheath >= 0.55 && st.inHand) saberInHand(false);
      if ((st.sheath >= 0.9 || meleeOnly) && !st.inHand && !st.gunIn) gunInHand(true);
      if (st.sheath >= 1) { st.sheath = -1; if (!st.gunIn) gunInHand(true); }
    }
    // how far the right hand is reaching back over the shoulder for the hilt (out and back again)
    const reachOf = (u, peak) => (u < 0 ? 0 : u < peak ? ease(u / peak) : 1 - ease(unit((u - peak) / (1 - peak))));
    const reach = meleeOnly ? 0 : Math.max(reachOf(st.draw, 0.5), reachOf(st.sheath, 0.55)) * (1 - down);

    // ---- which way the legs face: toward travel, or away from it when backing up (with hysteresis)
    const turning = grounded && v < 6 ? clamp((Math.abs(s.turnRate ?? 0) - 0.6) / 2.2, 0, 1) : 0;
    let wantYaw = 0;
    if (v > 3 && !swing) {
      const ang = Math.atan2(s.localRight, s.localFwd); // 0 straight ahead, +PI/2 to the right
      if (st.back ? Math.abs(ang) < 0.55 * Math.PI : Math.abs(ang) > 0.68 * Math.PI) st.back = !st.back;
      wantYaw = -clamp(st.back ? wrapAngle(ang - Math.PI) : ang, -1.3, 1.3); // right of travel = negative yaw
    } else if (turning > 0) {
      wantYaw = -clamp((s.turnRate ?? 0) * 0.2, -0.5, 0.5); // turning on the spot: the legs lag behind the chest
    }
    if (down > 0.5) wantYaw = 0;
    st.legYaw = damp(st.legYaw, wantYaw, v > 3 ? 8 : 5, dt);
    const dir = st.back ? -1 : 1;

    // ---- gait blends
    const skateWant = grounded ? Math.max(s.dash > 0 || lunge ? 1 : 0, clamp((v - 90) / 50, 0, 1), st.launch) : 0;
    st.skate = damp(st.skate, skateWant, skateWant > st.skate ? 34 : 5, dt);
    st.idle = damp(st.idle, grounded && v < 4 && turning === 0 ? 1 : 0, 6, dt);
    st.fight = damp(st.fight, saberOn || atk ? 1 : 0, 9, dt);
    st.step = damp(st.step, s.dash > 0 ? 1 : 0, s.dash > 0 ? 30 : 5, dt);
    st.skid = damp(st.skid, grounded ? (s.skid ?? 0) * clamp(v / 70, 0, 1) : 0, 14, dt);
    const fwdAir = s.localFwd / scale;
    const flightWant = !grounded && !swing ? clamp((fwdAir - 45) / 110, 0, 1) * (s.boost > 0.5 ? 1 : 0.55) + (lunge ? 0.6 : 0) : 0;
    st.flight = damp(st.flight, Math.min(1, flightWant) * (1 - down), 5, dt);

    // ---- firing: a shot snaps the gun arm onto the target and holds it there
    const canAim = !saberOn && !atk && !relaxed && st.gunIn && down < 0.5;
    const charging = (s.charge ?? 0) > 0.02;
    const aimWant = canAim && (st.shot > 0 || charging) ? 1 : 0;
    st.aim = damp(st.aim, aimWant, aimWant ? 40 : 6, dt);

    // ---- stride. The feet are planned and the legs solved to reach them (two-bone IK), so a planted foot
    // cannot slide or sink. Each foot spends half the cycle planted, moving back under the body at exactly the
    // body's speed, and half arcing forward with its knee lifted. Played backwards, the same cycle backs up.
    const walk = 1 - st.skate;
    const cy = Math.cos(st.legYaw), sy = Math.sin(st.legYaw);
    const along = (s.localFwd * cy - s.localRight * sy) / scale;   // speed the way the legs face
    const lateral = (s.localFwd * sy + s.localRight * cy) / scale; // and across them
    st.pace = damp(st.pace, Math.min(Math.abs(along), 70), 8, dt); // (a dash glides: the stride stops at a run)
    const stride = Math.max(clamp(0.8 + st.pace * 0.15, 0.8, 8), turning * 1.6); // one step, foot to foot
    const clearance = clamp(0.25 + st.pace * 0.03, 0.25, 1.5) + turning * 0.4;
    // what the legs' turn cannot absorb of a strafe is stepped sideways on the same cycle
    const sideStride = st.pace > 1 ? clamp((lateral / Math.max(st.pace, 1)) * stride, -3, 3) * walk : 0;
    if (grounded) st.phase += dir * ((st.pace * Math.PI) / stride + turning * 8) * dt;

    // ---- lean into travel (measured along the way the legs face), harder on a step or a lunge; bank into turns
    const stepK = st.step * (1 - st.air * 0.3);
    let leanWant = clamp(along / 170, -0.2, 0.32) * (1 - st.air) + st.skate * 0.22 * Math.sign(along || 1)
      + clamp(fwdAir / 140, -0.3, 0.6) * st.air;
    leanWant += stepK * 0.4 * st.stepZ + st.launch * 0.35 - st.skid * 0.3 * Math.sign(along || 1);
    let rollWant = clamp(-lateral / 260, -0.22, 0.22) + clamp((s.turnRate ?? 0) * v / 900, -0.15, 0.15);
    rollWant -= stepK * 0.42 * st.stepX;
    st.lean = damp(st.lean, leanWant * (1 - down), 9, dt);
    st.roll = damp(st.roll, rollWant * (1 - down), 9, dt);

    // ---- crouch: weight in the idle stance, a fighting stance, skating, landings, braced shots, the swing itself
    if (swing) swingPose(swing.kind, swing.t, pose);
    const jumpCrouch = s.jumpCrouch ?? 0;
    const crouchWant = (0.12 * st.idle + 0.2 * st.fight + 0.15 * st.skate + 0.4 * st.brace + 0.55 * st.skid + 0.6 * st.launch) * (1 - st.air)
      + (swing ? pose.cr * 0.7 : 0) + st.land * 1.1 + jumpCrouch * 1.0 + (charging ? 0.35 : 0);
    st.crouch = damp(st.crouch, crouchWant, st.land > 0.5 || jumpCrouch > 0 ? 30 : 12, dt);
    const kneel = ease(Math.min(1, st.kneel * 1.6)) * (1 - st.air);

    const hipPitch = -st.lean * 0.32 - st.flight * 0.85;
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
      // standing: weight a little on one leg; with the saber out a fighting stance; braced to fire, a wider one
      const standX = lerp(lerp(lead ? 0.9 : -0.3, lead ? 2.4 : -2.0, st.fight), lead ? 2.2 : -1.8, Math.max(st.aim * 0.6, st.brace));
      g.fx = lerp(g.fx, standX, still);
      g.lift *= 1 - still;
      g.fx = lerp(g.fx, lead ? 2.2 : -2.6, st.skate);
      g.lift *= 1 - st.skate;
      g.fz *= (1 - still) * (1 - st.skate);
      // a skid plants the lead foot well forward; a hard landing drops the trailing knee, up on the toes
      g.fx = lerp(g.fx, lead ? 3.2 : -1.6, st.skid);
      g.fx = lerp(g.fx, lead ? 2.6 : -3.3, kneel);
      g.lift = lerp(g.lift, lead ? 0 : 2.5, kneel);
    }

    // ---- the pelvis: as high as the stance allows, lower in a crouch, and never higher than the planted legs reach
    let hipH = HIP_Y - 0.3 - st.crouch * 2.6 - kneel * 2.6;
    const legDrop = HIP_Y - PELVIS - SOLE; // hip joint to ankle, standing
    const splays = [0, 1].map((i) => legs[i].side * (0.04 + 0.04 * st.idle + 0.07 * st.skate + 0.05 * st.air + 0.08 * st.skid) + Math.atan2(gait[i].fz, legDrop));
    for (let i = 0; i < 2; i++) {
      const g = gait[i];
      if (g.lift > 0.02) continue;
      const pivotDrop = PELVIS * Math.cos(hipRoll) - legs[i].side * L.x * Math.sin(hipRoll);
      const reachY = Math.sqrt(Math.max(0, REACH * REACH - g.fx * g.fx)) * Math.cos(splays[i]) * Math.cos(hipRoll);
      hipH = Math.min(hipH, reachY + pivotDrop + SOLE);
    }

    // ---- legs: solve for the ankle targets, blend into the air poses, keep the feet flat on the ground
    const falling = clamp(-vy / 60, 0, 1);
    const airTrail = clamp(fwdAir / 150, 0, 0.45);
    const solved = [0, 0];
    const legOut = [];
    for (let i = 0; i < 2; i++) {
      const { side } = legs[i];
      const g = gait[i];
      const lead = side < 0;
      const splay = splays[i];
      const pivotY = hipH - PELVIS * Math.cos(hipRoll) + side * L.x * Math.sin(hipRoll); // the hip joint's height
      const fy = (SOLE + g.lift - pivotY) / (Math.cos(splay) * Math.cos(hipRoll));
      ik(g.fx, fy, solved);
      let th = solved[0], kn = solved[1];
      let ft = g.swing * 0.12 * walk * (1 - still); // toes come up a little through the swing
      if (!lead) ft = lerp(ft, -0.9, kneel);         // the kneeling leg is up on its toes
      // airborne: one knee up and the other leg trailing while rising, both reaching for the ground when falling;
      // just after a push-off both legs stretch down, toes pointed; in flight they trail in line with the body
      let airTh = lerp(lead ? 0.45 : -0.14, lead ? 0.22 : 0.04, falling) - airTrail;
      let airKn = lerp(lead ? -1.15 : -0.38, lead ? -0.6 : -0.3, falling);
      let airFt = lerp(-0.5, -0.05, falling);
      airTh = lerp(airTh, lead ? 0.08 : -0.05, st.takeoff);
      airKn = lerp(airKn, lead ? -0.2 : -0.12, st.takeoff);
      airFt = lerp(airFt, -0.75, st.takeoff);
      airTh = lerp(airTh, hipPitch * 0.85 + (lead ? 0.12 : -0.08), st.flight);
      airKn = lerp(airKn, lead ? -0.55 : -0.3, st.flight);
      airFt = lerp(airFt, -0.6, st.flight);
      th = lerp(th, airTh + st.crouch * 0.3, st.air);
      kn = lerp(kn, airKn - st.crouch * 0.6, st.air);
      ft = lerp(ft, airFt, st.air);
      legOut.push({ th: th - hipPitch, kn, ft: ft - th - kn, splay }); // th is relative to the ground: undo the pelvis tilt
    }
    let hipY = lerp(hipH, HIP_Y - 0.4, st.air);

    // ---- chest: counter the legs' turn so it keeps facing the aim, then lean, bank, breathe and swing
    const breathe = Math.sin(st.t * 1.7) * st.idle;
    const aimUp = clamp(s.pitch, -0.7, 0.9);
    const aimYaw = clamp(s.aimYaw ?? 0, -0.9, 0.9);
    const aimTwist = st.aim * (twoHanded ? -0.25 : 0.38); // one-handed: the gun shoulder forward; two-handed: the other
    const lungeK = lunge ? 1 : 0;
    let twist = swing ? pose.tw : lunge ? LUNGE.tw : st.fight * GUARD.tw * st.idle;
    twist += aimTwist;
    torso.rotation.y = -st.legYaw + twist;
    let chestX = -st.lean * 0.42 + st.flight * 0.3 + s.stagger * 0.4 + (swing ? pose.ln : 0) + lungeK * LUNGE.ln * 0.6 - st.crouch * 0.1
      + breathe * 0.014 + st.recoil * (twoHanded ? 0.14 : 0.06) - st.land * 0.25 - kneel * 0.15 + st.takeoff * 0.12 + st.skid * 0.12;
    torso.rotation.z = st.roll * 0.35;
    torso.position.y = TORSO_Y + breathe * 0.05;

    // ---- hit reactions: springs kicked by hit() snap the chest and head and let them settle
    const hp = spring(hit.p, 0, 260, 11, dt, 0.6), hr = spring(hit.r, 0, 260, 11, dt, 0.6);
    const hh = spring(hit.hp, 0, 320, 12, dt, 0.7), hhy = spring(hit.hy, 0, 320, 12, dt, 0.7);
    const flinch = spring(hit.arm, 0, 220, 12, dt, 0.8);
    chestX += hp;
    torso.rotation.z += hr;
    torso.rotation.y += s.stagger * 0.22;

    // ---- the right arm: aims the gun, holds the saber in guard, swings it, or trails it in a lunge
    const bob = Math.sin(st.phase * 2) * 0.04 * clamp(st.pace / 40, 0, 1) * walk;
    torso.rotation.x = chestX;
    const chestPitch = hipPitch + chestX; // to keep a gun level whatever the body is doing
    let rateR = 22;
    if (swing) {
      Object.assign(aR, { x: pose.x, y: pose.y, z: pose.z, el: pose.el, wr: pose.wr });
      rateR = 70;
    } else if (lunge) {
      Object.assign(aR, { x: LUNGE.x, y: LUNGE.y, z: LUNGE.z, el: LUNGE.el, wr: LUNGE.wr });
      rateR = 30;
    } else if (saberOn || st.inHand) {
      Object.assign(aR, { x: GUARD.x + bob + aimUp * 0.2 - s.stagger * 0.6, y: GUARD.y, z: GUARD.z, el: GUARD.el, wr: GUARD.wr });
    } else if (relaxed) {
      // at ease: the rifle lowered, pointing at the ground ahead
      Object.assign(aR, { x: 0.32 + bob, y: 0.16, z: 0.06, el: 0.72, wr: 0 });
    } else {
      // rifle ready: the forearm points along the aim; a shot kicks the arm up
      Object.assign(aR, { x: 1.05 + aimUp * 0.9 - s.stagger * 0.8 + bob - st.land * 0.3 + st.recoil * 0.32, y: 0.12, z: 0, el: 0.45 + (s.charge ?? 0) * 0.2 + st.recoil * 0.3, wr: 0 });
      // in flight the gun arm sweeps back unless it is shooting
      aR.x = lerp(aR.x, -0.35, st.flight * (1 - st.aim));
      aR.el = lerp(aR.el, 0.35, st.flight * (1 - st.aim));
      // the firing pose: the whole arm straight down the line of fire, the chest turned side-on
      if (st.aim > 0.001) {
        // the forearm (and the gun in the hand) points along the aim: the shoulder makes up for the elbow's bend,
        // and the kick lifts the gun by `kick` while the elbow folds a little
        const el = (twoHanded ? 0.32 : 0.05) + st.recoil * (twoHanded ? 0.15 : 0.4);
        const kick = st.recoil * (twoHanded ? 0.25 : 0.5);
        aR.x = lerp(aR.x, Math.PI / 2 + aimUp - chestPitch - el + kick, st.aim);
        aR.y = lerp(aR.y, -twist + aimYaw * 0.9, st.aim);
        aR.z = lerp(aR.z, twoHanded ? -0.12 : -0.04, st.aim);
        aR.el = lerp(aR.el, el, st.aim);
        rateR = 48;
      }
      // a skid or a hard landing points the gun at the ground ahead
      aR.x = lerp(aR.x, 0.6, Math.max(kneel, st.skid) * (1 - st.aim));
      // on the catapult, held low and close
      aR.x = lerp(aR.x, 0.5, st.launch);
      aR.el = lerp(aR.el, 0.9, st.launch);
    }
    aR.x -= flinch * 0.25;

    // ---- the left arm: counter-swings with the stride, balances in the air and on landing, guards, grips
    const leftStride = (gait[0].fx / 8) * (1 - st.air) * (1 - still) * walk; // the left arm swings against the left leg
    let lx = 0.22 - leftStride * 0.9 - s.stagger * 0.9, ly = -0.05, lz = 0.1, le = 0.45;
    lx = lerp(lx, 0.5, st.air); lz = lerp(lz, 0.38, st.air); le = lerp(le, 0.65, st.air);
    lx = lerp(lx, -0.4, st.skate); lz = lerp(lz, 0.3, st.skate); le = lerp(le, 0.35, st.skate);
    lx = lerp(lx, 0.7, st.fight * (1 - st.skate)); ly = lerp(ly, 0.38, st.fight); le = lerp(le, 1.2, st.fight);
    if (swing) lx -= 0.25 * Math.sin(Math.PI * unit((swing.t - 0.2) / 0.5)); // drawn back as the blade comes through
    if (lunge) { lx = 0.95; ly = 0.25; lz = 0.18; le = 0.5; }                // reaching ahead
    lx = lerp(lx, -0.3, st.flight * (1 - lungeK)); lz = lerp(lz, 0.28, st.flight * (1 - lungeK)); le = lerp(le, 0.25, st.flight * (1 - lungeK));
    // the shield arm comes across the body while the gun fires one-handed
    if (!twoHanded) { lx = lerp(lx, 0.62, st.aim); ly = lerp(ly, 0.55, st.aim); lz = lerp(lz, 0.12, st.aim); le = lerp(le, 1.35, st.aim); }
    // a skid puts the left hand down to the ground; a hard landing rests it on the knee
    lx = lerp(lx, 0.55, st.skid); lz = lerp(lz, 0.62, st.skid); le = lerp(le, 0.12, st.skid);
    lx = lerp(lx, 0.95, kneel); lz = lerp(lz, 0.12, kneel); le = lerp(le, 1.05, kneel);
    lx = lerp(lx, 0.35, st.launch); lz = lerp(lz, 0.22, st.launch); le = lerp(le, 0.8, st.launch);
    lz += st.land * 0.55 + flinch * 0.5 + s.stagger * 0.5;
    Object.assign(aL, { x: lx, y: ly, z: lz, el: le });

    // ---- knocked down, or breaking down: whole-body poses that take over from everything above
    let ov = null;
    if (down > 0.001) {
      ov = dying > 0 ? breakdownPose(dying) : knockPose(knock ?? { phase: 'rise', t: 1 });
      const w = down;
      hipY = lerp(hipY, ov.hipY, w);
      hips.rotation.x = lerp(hips.rotation.x, ov.hipX, w);
      hips.rotation.z = lerp(hips.rotation.z, 0, w);
      torso.rotation.x = lerp(torso.rotation.x, ov.chestX, w);
      torso.rotation.y = lerp(torso.rotation.y, ov.twist, w);
      for (let i = 0; i < 2; i++) {
        const o = legOut[i], t = ov.legs[i];
        o.th = lerp(o.th, t.th, w); o.kn = lerp(o.kn, t.kn, w); o.ft = lerp(o.ft, t.ft, w); o.splay = lerp(o.splay, legs[i].side * 0.08, w);
      }
      for (const k of ['x', 'y', 'z', 'el']) { aR[k] = lerp(aR[k], ov.armR[k], w); aL[k] = lerp(aL[k], ov.armL[k], w); }
      aR.wr = lerp(aR.wr, 0, w);
      rateR = Math.max(rateR, 26);
    }

    for (let i = 0; i < 2; i++) {
      const { leg, shin, foot } = legs[i];
      const o = legOut[i];
      leg.rotation.x = o.th;
      shin.rotation.x = o.kn;
      foot.rotation.x = o.ft;
      leg.rotation.z = o.splay;
      foot.rotation.z = -o.splay - hips.rotation.z;
    }
    hips.position.y = hipY;

    // ---- head: follows the aim (ahead of the body when a shot snaps round), scans when at ease, snaps on hits
    head.rotation.x = clamp(aimUp * 0.5, -0.3, 0.45) - torso.rotation.x * 0.6 + hh + s.stagger * 0.3 + (ov ? ov.headX * down : 0);
    head.rotation.y = (relaxed ? Math.sin(st.t * 0.37) * 0.22 * st.idle : 0) + aimYaw * 0.5 * st.aim - twist * 0.6 + hhy + (ov ? ov.headY * down : 0);

    // ---- ease the arms toward their targets
    const kR = 1 - Math.exp(-rateR * dt), kL = 1 - Math.exp(-(swing ? 30 : 18) * dt);
    for (const k of ['x', 'y', 'z', 'el', 'wr']) armRS[k] += (aR[k] - armRS[k]) * kR;
    for (const k of ['x', 'y', 'z', 'el']) armLS[k] += (aL[k] - armLS[k]) * kL;
    armR.arm.rotation.set(armRS.x, armRS.y, armRS.z);
    armR.elbow.rotation.x = armRS.el;
    saber.rotation.x = armRS.wr;
    armL.arm.rotation.set(armLS.x, armLS.y, armLS.z);
    armL.elbow.rotation.x = armLS.el;

    // ---- the right hand reaching over its shoulder for the saber hilt (or to rack it again)
    if (reach > 0.001) {
      const dp = rig.drawPoint;
      vT.set(dp.x, dp.y + 0.4, dp.z - 0.2);
      vS.copy(armR.arm.position);
      vPole.set(0.9, 0.5, -0.6);
      const bend = solveArm(vS, vT, vPole, ikQ);
      armR.arm.quaternion.slerp(ikQ, reach);
      armR.elbow.rotation.x = lerp(armR.elbow.rotation.x, bend, reach);
    }

    // ---- a heavy gun is posed for itself, in a rifleman's stance (left shoulder forward): placed in front of
    // the chest (raised to the shoulder line to fire), pointing along the aim, with both hands put on it by IK
    const gripWant = twoHanded && st.gunIn && !relaxed && !atk && reach < 0.01 ? 1 - Math.max(down, st.flight * (1 - st.aim), st.skid, kneel) : 0;
    st.grip = damp(st.grip, gripWant, gripWant > st.grip ? 16 : 10, dt);
    if (st.grip > 0.001) {
      const a = st.aim;
      const pitch = lerp((aimUp - chestPitch) * 0.9 - 0.1, aimUp - chestPitch, a) + st.recoil * 0.22;
      const yaw = -twist + aimYaw * 0.9 * a; // in torso space: the gun points where the chest's twist does not
      gunDir.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      gunAt.set(lerp(0.9, 0.7, a), lerp(2.2, 3.0, a), lerp(-2.2, -3.0, a) + st.recoil * 1.0); // the right hand's grip
      // the right hand onto the grip
      vS.copy(armR.arm.position);
      vPole.set(0.8, -1, 0.35);
      let bend = solveArm(vS, gunAt, vPole, ikQ);
      armR.arm.quaternion.slerp(ikQ, st.grip);
      armR.elbow.rotation.x = lerp(armR.elbow.rotation.x, bend, st.grip);
      // turn the gun in the hand so it points along gunDir, whatever the arm is doing
      _qh.copy(armR.arm.quaternion).multiply(_qa.setFromAxisAngle(X_AXIS, armR.elbow.rotation.x)).invert();
      _qh.multiply(_qd.setFromUnitVectors(DOWN, gunDir));
      rifle.quaternion.identity().slerp(_qh, st.grip);
      // the left hand onto the foregrip, further down the barrel
      vT.copy(gunAt).addScaledVector(gunDir, -rig.foregrip);
      vS.copy(armL.arm.position);
      vPole.set(-0.7, -1, 0.35);
      bend = solveArm(vS, vT, vPole, ikQ);
      armL.arm.quaternion.slerp(ikQ, st.grip);
      armL.elbow.rotation.x = lerp(armL.elbow.rotation.x, bend, st.grip);
    } else if (twoHanded) rifle.quaternion.identity();

    // ---- shoulder mounts: they follow the aim, and kick back when they fire
    for (const side of ['L', 'R']) {
      const m = rig.mounts[side];
      if (!m) continue;
      const want = relaxed ? 0 : clamp(aimUp - chestPitch, -0.4, 0.7);
      st.mountPitch[side] = damp(st.mountPitch[side], want * (1 - down), 10, dt);
      const rec = st.mountRec[side];
      m.g.rotation.x = st.mountPitch[side] + rec * 0.22;
      m.g.position.z = m.z + rec * (m.style === 'swarm' ? 0.2 : 1.0);
    }

    // ---- saber blade extends / retracts
    st.saberExt = damp(st.saberExt, saberOn && st.inHand ? 1 : 0, saberOn ? 22 : 30, dt);
    blade.scale.y = Math.max(0.001, st.saberExt);

    // ---- secondary motion
    secondary(dt, dF, dR, dY);

    // ---- thrusters: steady under boost, flaring on a push-off, a step, a lunge or a get-up
    st.boost = damp(st.boost, s.boost, 14, dt);
    st.flameTime += dt * 40;
    const flare = 1 + st.flare * 0.9;
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i];
      const isCalf = i < 2; // creation order: two calf thrusters, then the backpack (and any shoulder) nozzles
      let power = st.boost * (isCalf ? 0.8 : 1) * flare;
      if (dying > 0) power = Math.random() < 0.15 ? Math.random() * 0.6 : 0; // sputtering
      f.visible = power > 0.04;
      const flicker = 0.85 + 0.15 * Math.sin(st.flameTime + i * 2.1) + 0.08 * Math.sin(st.flameTime * 2.7 + i);
      f.scale.set(0.6 + Math.min(power, 1.4) * 0.5, Math.max(0.001, power * flicker), 0.6 + Math.min(power, 1.4) * 0.5);
    }

    // ---- muzzle charge glow
    if ((s.charge ?? 0) > 0.02) {
      chargeGlow.visible = true;
      chargeGlow.scale.setScalar(0.4 + s.charge * 2.2);
      chargeMat.opacity = 0.35 + s.charge * 0.6;
    } else chargeGlow.visible = false;

    // ---- eyes: the mono-eye sweeps; a breaking-down machine's eyes flicker out
    if (eyeNode) eyeNode.position.x = Math.sin(st.flameTime * 0.05) * 0.55;
    if (dying > 0) rig.k.glow.color.copy(glowColor).multiplyScalar(Math.random() < 0.3 + dying * 0.6 ? 0.08 : 1);
    else if (st.dieW > 0.5 || rig.k.glow.color.r !== glowColor.r) rig.k.glow.color.copy(glowColor);

    // ---- convulsions while breaking down
    if (dying > 0 && Math.random() < 0.25) {
      const j = 0.05 * (1 - dying * 0.5);
      hit.p.v += (Math.random() - 0.5) * j * 60;
      hit.r.v += (Math.random() - 0.5) * j * 60;
      hit.hp.v += (Math.random() - 0.5) * j * 80;
    }
  }

  // ------------------------------------------------------------------ whole-body poses

  const KO = { hipY: 0, hipX: 0, chestX: 0, twist: 0, headX: 0, headY: 0, legs: [{ th: 0, kn: 0, ft: 0 }, { th: 0, kn: 0, ft: 0 }],
    armR: { x: 0, y: 0, z: 0, el: 0 }, armL: { x: 0, y: 0, z: 0, el: 0 } };
  const setLegs = (o, lt, lk, lf, rt, rk, rf) => {
    o.legs[0].th = lt; o.legs[0].kn = lk; o.legs[0].ft = lf;
    o.legs[1].th = rt; o.legs[1].kn = rk; o.legs[1].ft = rf;
  };
  const setArm = (a, x, y, z, el) => { a.x = x; a.y = y; a.z = z; a.el = el; };

  /** Knocked down: thrown onto the back, a bounce, then up again (the last part hands back to the normal stance). */
  function knockPose(k) {
    const o = KO;
    if (k.phase === 'fall') {
      const e = ease(unit(k.t / 0.32));
      o.hipX = 1.15 * e; o.hipY = HIP_Y - 0.4 - 2.6 * e; o.chestX = 0.25 * e; o.twist = 0.15 * e;
      o.headX = 0.45 * e; o.headY = 0;
      setLegs(o, 0.3 + 0.5 * e, -0.3 - 0.5 * e, 0.2, 0.15 + 0.3 * e, -0.2 - 0.3 * e, 0.2);
      setArm(o.armR, 1.3 + 0.7 * e, 0.15, -0.5 * e, 0.5);
      setArm(o.armL, 1.1 + 0.8 * e, -0.1, 0.6 * e, 0.5);
    } else if (k.phase === 'lie') {
      const b = Math.exp(-7 * k.t) * Math.sin(16 * k.t) * 0.16; // the bounce off the ground
      o.hipX = 1.42 - b; o.hipY = 3.5 + b * 2; o.chestX = 0.08; o.twist = 0.1; o.headX = -0.15; o.headY = 0.35;
      setLegs(o, 0.6, -1.05, 0.45, 0.2, -0.3, 0.2);
      setArm(o.armR, 0.35, 0, -0.85, 0.35);
      setArm(o.armL, 0.3, 0, 0.9, 0.3);
    } else {
      // rise: sit up into a crouch with one knee raised, pushing off the ground, then stand
      const a = ease(unit(k.t / 0.42));
      o.hipX = lerp(1.42, -0.32, a); o.hipY = lerp(3.5, 6.6, a); o.chestX = lerp(0.08, -0.15, a); o.twist = 0; o.headX = lerp(-0.15, 0.1, a); o.headY = 0;
      setLegs(o, lerp(0.6, 1.5, a), lerp(-1.05, -2.2, a), lerp(0.45, 0.65, a), lerp(0.2, 0.25, a), lerp(-0.3, -2.0, a), lerp(0.2, 1.1, a));
      setArm(o.armR, lerp(0.35, 0.45, a), 0, lerp(-0.85, -0.2, a), lerp(0.35, 0.2, a));
      setArm(o.armL, lerp(0.3, 0.6, a), 0, lerp(0.9, 0.35, a), lerp(0.3, 0.15, a));
    }
    return o;
  }

  /** Breaking down before the wreck explodes: a jolt, then a slump onto both knees with the arms hanging. */
  function breakdownPose(d) {
    const o = KO;
    const sink = ease(unit((d - 0.15) / 0.6));
    o.hipX = -0.12 - 0.3 * sink; o.hipY = HIP_Y - 0.6 - 4.3 * sink; o.chestX = -0.1 - 0.35 * sink; o.twist = 0.25 * sink;
    o.headX = -0.55 * sink; o.headY = 0.3 * sink;
    setLegs(o, 0.15 + 0.5 * sink, -0.25 - 1.45 * sink, 0.1 + 0.5 * sink, 0.12 + 0.42 * sink, -0.2 - 1.5 * sink, 0.1 + 0.5 * sink);
    setArm(o.armR, 0.35 - 0.2 * sink, 0.05, -0.12, 0.45 - 0.25 * sink);
    setArm(o.armL, 0.25 - 0.15 * sink, 0, 0.22, 0.4 - 0.2 * sink);
    return o;
  }

  // ------------------------------------------------------------------ secondary motion

  function secondary(dt, dF, dR, dY) {
    const kick = clamp(dF, -260, 260) * 0.012, side = clamp(dR, -260, 260) * 0.012, bump = Math.min(Math.abs(dY), 200) * 0.006;

    // skirt plates: each is pushed out by the thigh behind it, and swings on its hinge
    const sk = rig.skirt;
    if (sk) {
      const thL = legs[0].leg.rotation.x, thR = legs[1].leg.rotation.x;
      const outF = (th) => Math.max(0, th - 0.12) * 0.95;
      const outB = (th) => Math.max(0, -th - 0.1) * 0.9;
      const plate = (g, s, target, kick0, outward) => {
        if (!g) return;
        s.v += kick0;
        const x = Math.max(target, spring(s, target, 420, 10, dt, 0.7)); // never back into the thigh
        if (outward === 'x') g.rotation.x = x;
        else if (outward === '-x') g.rotation.x = -x;
        else g.rotation.z = outward * x;
      };
      plate(sk.front.L, skirt.FL, outF(thL), -kick + bump, 'x');
      plate(sk.front.R, skirt.FR, outF(thR), -kick + bump, 'x');
      plate(sk.front.C, skirt.FC, Math.max(outF(thL), outF(thR)) * 0.85, -kick + bump, 'x');
      plate(sk.rear, skirt.B, Math.max(outB(thL), outB(thR)), kick + bump, '-x');
      plate(sk.side.L, skirt.SL, Math.max(0, -legs[0].leg.rotation.z * 0.9) + Math.abs(thL) * 0.12, side + bump, -1);
      plate(sk.side.R, skirt.SR, Math.max(0, legs[1].leg.rotation.z * 0.9) + Math.abs(thR) * 0.12, -side + bump, 1);
    }

    // shoulder pads ride the arms: tipping with a raised arm, and swinging out when it reaches across or up
    for (const [s, key, arm] of [[-1, 'L', armL.arm], [1, 'R', armR.arm]]) {
      const pad = rig.pads?.[key];
      if (!pad) continue;
      const p = pads[key];
      _eu.setFromQuaternion(arm.quaternion, 'YXZ');
      const raise = clamp(_eu.x, -0.6, 3.0);
      p.x.v += -kick * 0.4;
      p.z.v += side * 0.3 * -s + bump * 0.5;
      pad.rotation.x = spring(p.x, clamp((raise - 0.4) * 0.12, -0.1, 0.3), 380, 13, dt, 0.4);
      pad.rotation.z = s * spring(p.z, Math.max(0, raise - 1.6) * 0.16 + Math.max(0, s * _eu.z) * 0.3, 380, 13, dt, 0.4);
    }

    // wings spread under thrust
    for (let i = 0; i < rig.wings.length; i++) {
      const w = rig.wings[i];
      const open = 0.02 + st.boost * 0.42 + st.flight * 0.2 + st.flare * 0.2 + st.step * 0.15;
      wings[i].v += bump * 0.8;
      w.g.rotation.z = -w.side * spring(wings[i], open, 200, 12, dt, 0.6);
    }

    // whip antennas sway, lagging behind every change of speed
    for (let i = 0; i < rig.whips.length; i++) {
      const w = rig.whips[i], s = whips[i];
      s.x.v += kick * 1.6 + (Math.random() - 0.5) * bump * 2;
      s.z.v += side * 1.6;
      w.g.rotation.x = spring(s.x, 0, 150, 3.5, dt, 0.5);
      w.g.rotation.z = (w.rest ?? 0) + spring(s.z, 0, 150, 3.5, dt, 0.5);
    }

    // a rigid crest only rattles on impacts
    if (rig.crest) rig.crest.rotation.z = spring(crest, 0, 900, 14, dt, 0.12);
  }

  // ------------------------------------------------------------------ cues from the game

  /** A landing: `k` (0..1) is how hard; the knees soak it up and the arms flare out. A really hard one kneels. */
  function land(k) {
    const h = clamp(k, 0, 1);
    st.land = Math.max(st.land, h);
    if (h > 0.7) st.kneel = Math.max(st.kneel, 0.9);
    crest.v += h * 3;
  }

  /**
   * A shot. `k` (0..1) is how heavy (a bazooka is 1, a rapid beam gun a fraction). With a `side` ('L' or 'R') it is
   * that shoulder mount firing; otherwise it is the hand gun, which snaps onto the target and holds the pose.
   */
  function recoil(k, side) {
    if (side === 'L' || side === 'R') {
      st.mountRec[side] = Math.min(1, Math.max(st.mountRec[side], k));
      st.brace = Math.max(st.brace, k * 0.7);
      hit.p.v += k * 1.5;
      return;
    }
    st.recoil = Math.min(1, Math.max(st.recoil, k));
    st.shot = SHOT_HOLD;
    if (k >= 0.7) st.brace = Math.max(st.brace, k);
  }

  /** Took a hit: (x, z) is the push in the mech's own frame (+x right, +z back), `k` (0..1) how hard. */
  function onHit(x, z, k) {
    const f = clamp(k, 0, 1);
    hit.p.v += z * f * 11;
    hit.r.v += -x * f * 9;
    hit.hp.v += z * f * 20 + (Math.random() - 0.5) * f * 6;
    hit.hy.v += x * f * 12;
    hit.arm.v += f * 7;
    crest.v += (Math.random() - 0.5) * f * 6;
  }

  /** The catapult throws the mech off its deck (or a get-up fires the thrusters): flare the nozzles. */
  function flareThrusters(k = 1) {
    st.flare = Math.max(st.flare, k);
  }

  return { update, land, recoil, setSaber, hit: onHit, flare: flareThrusters, state: st };
}
