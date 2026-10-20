// The pilot: turns keyboard/mouse input into mech intent, and owns the player's weapons —
// beam rifle, homing missiles, a three-hit beam-sabre combo, lock-on and the BURST mode.

import * as THREE from 'three';
import { Mech } from './mech.js';
import { clamp, rand, yawToward } from './util.js';

const RIFLE_DAMAGE = 210;
const RIFLE_COOLDOWN = 0.34;
const MAG_SIZE = 8;
const RELOAD_TIME = 1.9;
const MISSILE_CHARGES = 2;
const MISSILE_RECHARGE = 7;
const MISSILES_PER_SALVO = 4;
const MELEE = [
  { kind: 'slash1', dur: 0.5, damage: 280, stagger: false },
  { kind: 'slash2', dur: 0.5, damage: 280, stagger: false },
  { kind: 'slash3', dur: 0.72, damage: 470, stagger: true },
];
const BURST_TIME = 12;
const LOCK_RANGE = 800;

export class Player {
  constructor(game) {
    this.game = game;
    this.mech = new Mech(game, 'vanguard', 'player');

    this.ammo = MAG_SIZE;
    this.reloadT = 0;
    this.reloadDur = RELOAD_TIME;
    this.fireCd = 0;
    this.missiles = MISSILE_CHARGES;
    this.missileT = 0;
    this.missileQueue = []; // seconds until each queued missile launches
    this.melee = null;
    this.saberHold = 0;
    this.burst = 0;      // 0..100 gauge
    this.burstT = 0;     // seconds of burst remaining
    this.lock = null;
    this.lockEnabled = true;
    this.lastFired = -10;
    this.aimPoint = new THREE.Vector3();
    this.dmgMul = 1;

    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._lunge = new THREE.Vector3();
  }

  reset(x, z) {
    const m = this.mech;
    this.game.scene.add(m.root); // a destroyed mech was removed from the scene
    m.place(x, z, 0, 0);
    m.hp = m.maxHp;
    m.en = m.maxEn;
    m.dead = false;
    m.overheat = false;
    m.stagger = m.invuln = m.dashT = m.flashT = 0;
    m.setSaber(false);
    m.tintColor = null;
    this.ammo = MAG_SIZE;
    this.reloadT = 0;
    this.fireCd = 0;
    this.missiles = MISSILE_CHARGES;
    this.missileT = 0;
    this.missileQueue.length = 0;
    this.melee = null;
    this.burst = 0;
    this.burstT = 0;
    this.lock = null;
    this.lockEnabled = true;
    this.dmgMul = 1;
  }

  get burstActive() {
    return this.burstT > 0;
  }

  /** Restock between waves: ammo and missiles refill, armour is partly repaired. */
  resupply(healFraction) {
    this.ammo = MAG_SIZE;
    this.reloadT = 0;
    this.missiles = MISSILE_CHARGES;
    this.mech.en = this.mech.maxEn;
    this.mech.overheat = false;
    this.mech.heal(this.mech.maxHp * healFraction);
  }

  // ------------------------------------------------------------------ lock-on

  _candidates() {
    const out = [];
    const p = this.mech.pos;
    for (const e of this.game.enemies) {
      if (e.mech.dead) continue;
      if (Math.hypot(e.mech.pos.x - p.x, e.mech.pos.z - p.z) > LOCK_RANGE) continue;
      out.push(e.mech);
    }
    return out;
  }

  /** Enemy closest to the screen centre (within a generous cone), else the nearest. */
  _bestTarget(list) {
    const rig = this.game.rig;
    const cam = this.game.camera.position;
    let best = null, bestScore = Infinity;
    for (const m of list) {
      const v = m.center(this._v).sub(cam);
      const dist = v.length();
      const ang = Math.acos(clamp(v.normalize().dot(rig.forward), -1, 1));
      const score = ang * 400 + dist * 0.3 - (ang < 0.7 ? 1000 : 0);
      if (score < bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  _updateLock(input) {
    const list = this._candidates();
    if (input.pressed('KeyQ')) {
      if (this.lock) {
        this.lock = null;
        this.lockEnabled = false;
        this.game.audio.lockOff();
      } else if (list.length) {
        this.lock = this._bestTarget(list);
        this.lockEnabled = true;
        this.game.audio.lockOn();
      }
    }
    if (input.pressed('Tab') && list.length) {
      const sorted = list.sort((a, b) => a.pos.distanceToSquared(this.mech.pos) - b.pos.distanceToSquared(this.mech.pos));
      const i = sorted.indexOf(this.lock);
      this.lock = sorted[(i + 1) % sorted.length];
      this.lockEnabled = true;
      this.game.audio.lockOn();
    }
    if (this.lock && (this.lock.dead || !list.includes(this.lock))) this.lock = null;
    if (!this.lock && this.lockEnabled && list.length) {
      this.lock = this._bestTarget(list);
      if (this.lock) this.game.audio.lockOn();
    }
  }

  // ------------------------------------------------------------------ aiming

  /** World point under the crosshair: first building, ground or enemy along the camera ray. */
  _updateAimPoint() {
    const cam = this.game.camera.position;
    const f = this.game.rig.forward;
    let t = Math.min(700, this.game.world.raycast(cam.x, cam.y, cam.z, f.x, f.y, f.z, 700));
    for (const e of this.game.enemies) {
      const m = e.mech;
      if (m.dead) continue;
      const c = m.center(this._v);
      const ox = c.x - cam.x, oy = c.y - cam.y, oz = c.z - cam.z;
      const proj = ox * f.x + oy * f.y + oz * f.z;
      if (proj < 5 || proj > t) continue;
      const d2 = ox * ox + oy * oy + oz * oz - proj * proj;
      const r = m.radius * 1.3;
      if (d2 < r * r) t = proj;
    }
    this.aimPoint.set(cam.x + f.x * t, cam.y + f.y * t, cam.z + f.z * t);
  }

  /** Unit direction from `from` toward where a shot should go (lead-compensated when locked on). */
  _aimDir(from, speed, out) {
    if (this.lock) {
      const c = this.lock.center(out);
      const dist = c.distanceTo(from);
      const t = dist / speed;
      c.addScaledVector(this.lock.vel, t * 0.85);
      return c.sub(from).normalize();
    }
    return out.copy(this.aimPoint).sub(from).normalize();
  }

  // ------------------------------------------------------------------ update

  update(dt, input) {
    const mech = this.mech;
    if (mech.dead) return;
    const game = this.game;
    const rig = game.rig;

    this._updateLock(input);
    this._updateAimPoint();

    // ---- timers
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.burstT = Math.max(0, this.burstT - dt);
    this.dmgMul = this.burstT > 0 ? 1.5 : 1;
    if (this.missiles < MISSILE_CHARGES) {
      this.missileT += dt * (this.burstT > 0 ? 1.8 : 1);
      if (this.missileT >= MISSILE_RECHARGE) { this.missiles++; this.missileT = 0; }
    }
    if (this.saberHold > 0) {
      this.saberHold -= dt;
      if (this.saberHold <= 0 && !this.melee) mech.setSaber(false);
    }

    // ---- burst
    if ((input.pressed('KeyX') || input.pressed('KeyC')) && this.burst >= 100 && this.burstT <= 0) {
      this.burstT = BURST_TIME;
      this.burst = 0;
      mech.heal(mech.maxHp * 0.15);
      mech.en = mech.maxEn;
      mech.overheat = false;
      game.audio.burst();
      game.hud.message('BURST ACTIVE', 'good');
      game.shake(0.8);
    }
    if (this.burstT > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(game.time * 12);
      mech.tintColor = [0.04 + 0.05 * pulse, 0.28 + 0.22 * pulse, 0.42 + 0.2 * pulse];
    } else if (mech.tintColor) {
      mech.tintColor = null;
    }

    // ---- reload
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) { this.ammo = MAG_SIZE; game.audio.reload(); }
    } else if (input.pressed('KeyR') && this.ammo < MAG_SIZE) {
      this._startReload();
    }

    // ---- missiles
    if (input.pressed('KeyE') && this.missiles > 0 && !this.melee) this._fireMissiles();
    for (let i = this.missileQueue.length - 1; i >= 0; i--) {
      this.missileQueue[i].t -= dt;
      if (this.missileQueue[i].t <= 0) {
        this._launchMissile(this.missileQueue[i]);
        this.missileQueue.splice(i, 1);
      }
    }

    // ---- melee state machine
    const dashPressed = input.pressed('ShiftLeft') || input.pressed('ShiftRight');
    if (this.melee && dashPressed && this.melee.t > this.melee.dur * 0.5) this._endMelee(); // dash-cancel the recovery
    if (input.pressed('Mouse2')) this._pressMelee();
    const meleeIntent = this._updateMelee(dt);

    // ---- movement intent
    const it = meleeIntent ?? this._moveIntent(input);

    // ---- rifle
    if (!this.melee && input.down('Mouse0') && this.fireCd <= 0 && this.reloadT <= 0) {
      if (this.ammo > 0) this._fireRifle();
      else this._startReload();
    }
    if (this.lock && !this.melee) {
      const c = this.lock.center(this._w);
      const m = mech.center(this._v);
      it.pitch = Math.atan2(c.y - m.y, Math.hypot(c.x - m.x, c.z - m.z));
    } else if (!this.melee) {
      it.pitch = rig.pitch;
    }

    if (this.burstT > 0) {
      it.speedMul = (it.speedMul ?? 1) * 1.25;
      it.freeBoost = true;
    }

    mech.update(dt, it);

    // ---- thruster audio follows the mech
    game.audio.setBoost(mech.thrusting ? 1 : 0);
  }

  _moveIntent(input) {
    const mech = this.mech;
    const rig = this.game.rig;
    const fz = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const rx = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const sy = Math.sin(rig.yaw), cy = Math.cos(rig.yaw);
    // camera-relative: forward = (-sin, -cos), right = (cos, -sin)
    const moveX = -sy * fz + cy * rx;
    const moveZ = -cy * fz - sy * rx;

    const it = { moveX, moveZ, ascend: input.down('Space') };

    if (input.pressed('ShiftLeft') || input.pressed('ShiftRight')) {
      const d = new THREE.Vector3(moveX, 0, moveZ);
      if (d.lengthSq() < 0.01) {
        // no direction held: dash at the locked target, else straight ahead
        if (this.lock) {
          d.copy(this.lock.center(this._v)).sub(mech.center(this._w));
          d.y *= 0.5;
        } else d.set(-sy, 0, -cy);
      }
      it.dash = d;
    }

    if (this.lock) {
      it.faceYaw = yawToward(mech.pos.x, mech.pos.z, this.lock.pos.x, this.lock.pos.z);
    } else if (input.down('Mouse0') || this.game.time - this.lastFired < 0.7) {
      it.faceYaw = rig.yaw;
    }
    return it;
  }

  // ------------------------------------------------------------------ rifle

  _startReload() {
    if (this.reloadT > 0) return;
    const missing = MAG_SIZE - this.ammo;
    this.reloadDur = this.ammo === 0 ? RELOAD_TIME : Math.max(0.8, (RELOAD_TIME * missing) / MAG_SIZE);
    this.reloadT = this.reloadDur;
    this.game.audio.reload();
  }

  _fireRifle() {
    const game = this.game;
    const mech = this.mech;
    mech.model.muzzleWorld(this._muzzle);
    const dir = this._aimDir(this._muzzle, 780, this._w);
    // never shoot backwards through our own body when the crosshair is very close
    if (dir.dot(mech.forward()) < -0.2) dir.copy(mech.forward());

    game.projectiles.spawn({
      type: 'beam', team: 'player', source: mech, pos: this._muzzle, dir,
      damage: RIFLE_DAMAGE * this.dmgMul, color: 0xff6ad5, knock: 6,
      target: this.lock, turn: this.lock ? 0.9 : 0,
    });
    const m = this._muzzle;
    game.fx.glow.spawn(m.x, m.y, m.z, 0, 0, 0, 0.09, 8, 3, [1, 0.8, 1], [1, 0.3, 0.8], 0.9);
    game.audio.beam();
    game.shake(0.07);
    this.ammo--;
    this.fireCd = RIFLE_COOLDOWN * (this.burstT > 0 ? 0.6 : 1);
    this.lastFired = game.time;
    if (this.ammo <= 0) this._startReload();
  }

  // ------------------------------------------------------------------ missiles

  _fireMissiles() {
    this.missiles--;
    if (this.missiles === MISSILE_CHARGES - 1) this.missileT = 0;
    // target: lock, else whatever is closest to the crosshair
    let target = this.lock;
    if (!target) {
      const list = this._candidates();
      target = list.length ? this._bestTarget(list) : null;
      if (target) {
        const v = target.center(this._v).sub(this.game.camera.position).normalize();
        if (v.dot(this.game.rig.forward) < 0.8) target = null;
      }
    }
    for (let i = 0; i < MISSILES_PER_SALVO; i++) {
      this.missileQueue.push({ t: i * 0.09, side: i % 2 ? 1 : -1, target });
    }
    this.game.audio.missile(this.mech.pos);
  }

  _launchMissile(q) {
    const mech = this.mech;
    const game = this.game;
    const fwd = mech.forward(this._v).clone();
    const right = new THREE.Vector3(Math.cos(mech.yaw), 0, -Math.sin(mech.yaw));
    const pos = new THREE.Vector3(mech.pos.x, mech.pos.y + 15, mech.pos.z).addScaledVector(right, q.side * 4.5).addScaledVector(fwd, -1);
    const dir = new THREE.Vector3(0, 0.9, 0)
      .addScaledVector(fwd, 0.7)
      .addScaledVector(right, q.side * rand(0.12, 0.35))
      .normalize();
    game.projectiles.spawn({
      type: 'missile', team: 'player', source: mech, pos, dir, color: 0xffb060,
      damage: 150 * this.dmgMul, speed: 120, maxSpeed: 270, delay: 0.3, turn: 5.6, target: q.target,
      splash: { radius: 16, damage: 70 * this.dmgMul }, knock: 14,
      life: 5,
    });
    game.audio.missile(pos);
  }

  // ------------------------------------------------------------------ sabre

  _pressMelee() {
    if (!this.melee) {
      this._startMelee(0);
    } else if (this.melee.stage < MELEE.length - 1 && this.melee.t > this.melee.dur * 0.25) {
      this.melee.queued = true;
    }
  }

  _meleeTarget() {
    if (this.lock) return this.lock;
    // nearest enemy within a forward cone
    const mech = this.mech;
    const fwd = mech.forward(this._w);
    let best = null, bd = 150;
    for (const e of this.game.enemies) {
      const m = e.mech;
      if (m.dead) continue;
      const v = this._v.set(m.pos.x - mech.pos.x, 0, m.pos.z - mech.pos.z);
      const d = v.length();
      if (d < bd && v.normalize().dot(fwd) > 0.5) { bd = d; best = m; }
    }
    return best;
  }

  _startMelee(stage) {
    const def = MELEE[stage];
    this.melee = { stage, kind: def.kind, dur: def.dur, t: 0, hitDone: false, arcDone: false, queued: false, target: this._meleeTarget() };
    this.saberHold = 0.5;
    this.mech.setSaber(true);
    this.game.audio.setSaber(true);
    this.game.audio.slash(this.mech.pos);
  }

  _endMelee() {
    this.melee = null;
    this.saberHold = 0.35;
    this.game.audio.setSaber(false);
  }

  /** Returns the movement intent for this step while swinging, or null when not in melee. */
  _updateMelee(dt) {
    const melee = this.melee;
    if (!melee) return null;
    const mech = this.mech;
    const game = this.game;
    melee.t += dt;
    const p = melee.t / melee.dur;
    const def = MELEE[melee.stage];

    const it = { attack: { kind: def.kind, t: Math.min(1, p) }, hover: true, moveX: 0, moveZ: 0 };

    // face and lunge toward the target
    const tgt = melee.target && !melee.target.dead ? melee.target : null;
    let faceYaw = mech.yaw;
    if (tgt) {
      faceYaw = yawToward(mech.pos.x, mech.pos.z, tgt.pos.x, tgt.pos.z);
      it.faceYaw = faceYaw;
    }
    if (p < 0.42) {
      const lunge = this._lunge;
      if (tgt) {
        lunge.copy(tgt.center(this._v)).sub(mech.center(this._w));
        const dist = lunge.length();
        const contact = tgt.radius + mech.radius + 6;
        if (dist > contact) {
          lunge.normalize().multiplyScalar(Math.min(260, (dist - contact) / Math.max(dt, 0.001)));
        } else lunge.set(0, 0, 0);
      } else {
        lunge.set(-Math.sin(mech.yaw), 0, -Math.cos(mech.yaw)).multiplyScalar(70);
      }
      it.velocity = lunge;
    }

    if (!melee.arcDone && p >= 0.28) {
      melee.arcDone = true;
      game.fx.slashArc(mech, def.kind, 0xff7fdc);
      game.audio.slash(mech.pos);
    }
    if (!melee.hitDone && p >= 0.45) {
      melee.hitDone = true;
      this._meleeHit(def);
    }
    if (p >= 1) {
      if (melee.queued) this._startMelee(melee.stage + 1);
      else this._endMelee();
    }
    return it;
  }

  _meleeHit(def) {
    const mech = this.mech;
    const game = this.game;
    const fwd = mech.forward(this._w);
    let landed = false;
    for (const e of game.enemies) {
      const m = e.mech;
      if (m.dead) continue;
      const v = m.center(this._v).sub(mech.center(new THREE.Vector3()));
      const dist = v.length();
      if (dist > 30 + m.radius) continue;
      v.y = 0;
      if (v.lengthSq() > 1e-4 && v.normalize().dot(fwd) < 0.2) continue;
      const knock = fwd.clone().multiplyScalar(def.stagger ? 130 : 45);
      knock.y = def.stagger ? 40 : 0;
      m.takeDamage(def.damage * this.dmgMul, { source: mech, knock, kind: 'saber', stagger: def.stagger, point: m.center(new THREE.Vector3()) });
      game.fx.sparks(m.center(new THREE.Vector3()), fwd, 22, [1, 0.6, 0.95]);
      landed = true;
    }
    if (landed) {
      game.audio.saberHit(mech.pos);
      game.shake(def.stagger ? 0.9 : 0.5);
      game.hitstop(def.stagger ? 0.11 : 0.07);
    }
  }
}
