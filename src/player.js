// The pilot: turns keyboard/mouse input into mech intent, and owns the player's weapons —
// the equipped gun, homing missiles, a boost lunge into a four-hit beam-sabre combo, the shoulder mounts,
// lock-on and the BURST mode. Everything about the mech itself comes from the garage build
// (see parts.js), so applyBuild() swaps the whole machine and its loadout.

import * as THREE from 'three';
import { Mech } from './mech.js';
import { DEFAULT_BUILD, deriveMech } from './parts.js';
import { clamp, rand, yawToward } from './util.js';

const MISSILE_RECHARGE = 7;
// the saber combo: forehand, backhand, a thrust, and an overhead chop that knocks the target down
const MELEE = [
  { kind: 'slash1', dur: 0.46, damage: 240, stagger: false },
  { kind: 'slash2', dur: 0.46, damage: 240, stagger: false },
  { kind: 'thrust', dur: 0.48, damage: 280, stagger: false },
  { kind: 'slash3', dur: 0.72, damage: 470, stagger: true, finisher: true },
];
// a melee press with a target out of reach (but this close) first boosts in at it, blade trailing
const LUNGE_RANGE = 135;
const LUNGE_SPEED = 300;
const LUNGE_TIME = 0.5; // the longest a lunge chases before it swings anyway
const LOCK_RANGE = 800;
const FIRING_LIMBS = new Set(['gun', 'cannon', 'shotgun', 'rail']); // the arm weapons that fire with the gun button
const MOUNT_KEYS = ['KeyF', 'KeyG']; // the first shoulder mount fitted fires on F, the second on G
// Touch aim assist: with no lock-on, shots bend toward the enemy nearest the crosshair
const ASSIST_CONE = 0.14;   // radians off the crosshair (less the target's own angular size)
const ASSIST_PULL = 0.8;    // how far toward the target the shot is pulled (0 = none, 1 = dead centre)
const ASSIST_RANGE = 650;

const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

export class Player {
  constructor(game) {
    this.game = game;
    this.mech = null;

    this.ammo = 0;
    this.reloadT = 0;
    this.reloadDur = 1;
    this.fireCd = 0;
    this.missiles = 0;
    this.missileT = 0;
    this.missileQueue = []; // seconds until each queued missile launches
    this.limbGuns = [];     // the guns on extra arms: { def, cd, idx } (see applyBuild); they fire with the gun button
    this.turrets = [];      // the self-aiming guns (tail, pods, chest): { def, cd } (see applyBuild)
    this.lost = new Set();  // the slots of parts shot off this sortie (the stats are worked out without them)
    this.extraLocks = [];   // the other targets a many-headed machine has locked: missiles are shared out among them
    this._limbShots = 0;
    this.mounts = [];       // fitted shoulder mounts: { def, cd, key } (see applyBuild)
    this.subHeat = 0;       // head vulcans: 0..1, locked out when it reaches 1 until it has cooled
    this.subLocked = false;
    this.subCd = 0;         // decoy flares cooldown, and the vulcans' fire interval timer
    this.repairCharges = 0; // repair kit uses left this wave
    this.repairT = 0;       // seconds of repair remaining
    this.melee = null;
    this.saberHold = 0;
    this.burst = 0;      // 0..100 gauge
    this.burstT = 0;     // seconds of burst remaining
    this.lock = null;
    this.lockEnabled = true;
    this.lastFired = -10;
    this.aimPoint = new THREE.Vector3();
    this.assistTarget = null; // enemy the soft aim is pulling toward this frame (touch only)
    this.dmgMul = 1;

    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._lunge = new THREE.Vector3();

    this.applyBuild(DEFAULT_BUILD);
  }

  /**
   * Field a (new) garage build: replaces the mech model, stats, weapon and off-hand.
   * Only meant for between sorties: the mech is put back on its feet with a full loadout.
   */
  applyBuild(build) {
    const d = deriveMech(build);
    const old = this.mech;
    const keep = old ? { x: old.pos.x, z: old.pos.z, yaw: old.yaw } : { x: 0, z: 0, yaw: 0 };
    if (old) old.destroy();

    this.build = d.build;
    this.stats = d.stats;
    this.weapon = d.stats.weapon;
    // one entry per fitted shoulder mount: its ability, its own cooldown and the key that fires it
    this.mounts = d.stats.abilities.map((def, i) => ({ def, cd: 0, key: MOUNT_KEYS[i] }));
    this.sub = d.stats.sub;
    this.energy = d.energy;
    this.mech = new Mech(this.game, 'custom', 'player', d.def);
    this.mech.place(keep.x, keep.z, 0, keep.yaw);
    // extra arms that carry a gun: each has its own cooldown and finds its muzzle on the model
    const limbs = this.mech.model.rig.limbs;
    this.limbGuns = d.stats.limbs
      .filter((l) => FIRING_LIMBS.has(l.kind))
      .map((def) => ({ def, cd: 0, idx: limbs.findIndex((l) => l.slot === def.slot) }));
    this.turrets = d.stats.turrets.map((def) => ({ def, cd: Math.random() * def.interval }));
    this.extraLocks = [];
    this.lost.clear();
    this.lock = null;
    this._resetLoadout();
  }

  /** The F ability and its cooldown (the single-mount view that older code and the tests use). */
  get ability() { return this.mounts[0]?.def ?? null; }
  get cannonCd() { return this.mounts[0]?.cd ?? 0; }
  set cannonCd(v) { if (this.mounts[0]) this.mounts[0].cd = v; }

  get magSize() {
    return this.weapon.mag;
  }

  /** Twin sabers: no gun, the left mouse button swings the saber too. */
  get meleeOnly() {
    return this.weapon.kind === 'melee';
  }

  _resetLoadout() {
    this.ammo = this.magSize;
    this.reloadT = 0;
    this.fireCd = 0;
    this.missiles = this.stats.missileCharges;
    this.missileT = 0;
    this.missileQueue.length = 0;
    for (const m of this.mounts) m.cd = 0; // shoulder mount cooldowns (0 = ready)
    this.subHeat = 0;
    this.subLocked = false;
    this.subCd = 0;
    this.repairCharges = this.sub?.kind === 'repair' ? this.sub.charges : 0;
    this.repairT = 0;
    this.fieldT = 0;        // aegis field: seconds of invulnerability left
    this.melee = null;
    this.saberHold = 0;
  }

  reset(x, z) {
    const m = this.mech;
    this.game.scene.add(m.root); // a destroyed mech was removed from the scene
    m.place(x, z, 0, 0);
    m.hp = m.maxHp;
    m.en = m.maxEn;
    m.barrier = m.barrierMax;
    m.dead = false;
    m.overheat = false;
    m.stagger = m.invuln = m.dashT = m.flashT = m.skidT = m.jumpT = 0;
    m.knock = null;
    m.setSaber(false);
    m.tintColor = null;
    this._resetLoadout();
    this.burst = 0;
    this.burstT = 0;
    this.lock = null;
    this.lockEnabled = true;
    this.assistTarget = null;
    this.dmgMul = 1;
  }

  /** Touch players get a soft aim (see _updateAimPoint) when the option is on. */
  get assistOn() {
    return !!(this.game.touch?.active && this.game.settings.aimAssist);
  }

  get burstActive() {
    return this.burstT > 0;
  }

  /** Restock between waves: ammo and missiles refill, armour is partly repaired. */
  /** A part of the machine was shot off: work the machine out without it. */
  onPartBroken(part) {
    this.lost.add(part.slot);
    this.refreshStats();
  }

  /** The stats of the machine as it is now (parts shot off are gone), applied without rebuilding the mech. */
  refreshStats() {
    const lostSlots = [...this.lost].filter((s) => !s.startsWith('leg'));
    const lostLegs = this.lost.size - lostSlots.length;
    const d = deriveMech(this.build, { lost: lostSlots, lostLegs });
    const mech = this.mech;
    this.stats = d.stats;
    this.weapon = d.stats.weapon;
    Object.assign(mech.def, d.def, { spec: mech.def.spec, parts: mech.def.parts });
    mech.maxHp = d.def.hp;
    mech.hp = Math.min(mech.hp, mech.maxHp);
    mech.maxEn = d.def.en;
    mech.en = Math.min(mech.en, mech.maxEn);
    mech.barrierMax = d.def.barrier ?? 0;
    mech.barrier = Math.min(mech.barrier, mech.barrierMax);
    this.missiles = Math.min(this.missiles, this.stats.missileCharges);
    // the firing lists follow the stats: a gun shot off drops out, a part replaced in the pit stop is back (keeping the cooldowns of those that stayed)
    const limbs = mech.model.rig.limbs;
    this.limbGuns = d.stats.limbs
      .filter((l) => FIRING_LIMBS.has(l.kind))
      .map((def) => ({ def, cd: this.limbGuns.find((L) => L.def.slot === def.slot)?.cd ?? 0, idx: limbs.findIndex((l) => l.slot === def.slot) }));
    this.turrets = d.stats.turrets
      .map((def) => ({ def, cd: this.turrets.find((T) => T.def.slot === def.slot)?.cd ?? Math.random() * def.interval }));
    this.extraLocks.length = Math.min(this.extraLocks.length, Math.max(0, this.stats.lock - 1));
    this.game.hud.configure();
  }

  /** Between waves the parts that were shot off are replaced. Returns how many. */
  repairParts() {
    const n = this.mech.restoreParts();
    if (this.lost.size) { this.lost.clear(); this.refreshStats(); }
    return n;
  }

  resupply(healFraction) {
    this.ammo = this.magSize;
    this.reloadT = 0;
    this.missiles = this.stats.missileCharges;
    for (const m of this.mounts) m.cd = 0;
    this.subCd = 0;
    this.repairCharges = this.sub?.kind === 'repair' ? this.sub.charges : 0;
    this.mech.en = this.mech.maxEn;
    this.mech.overheat = false;
    this.mech.heal(this.mech.maxHp * healFraction);
    const replaced = this.repairParts();
    if (replaced > 0) this.game.hud.message(replaced > 1 ? `${replaced} PARTS REPLACED` : 'PART REPLACED', 'good');
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
    let best = null, bestScore = Infinity;
    for (const m of list) {
      const score = this._lockScore(m);
      if (score < bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  /** How good a lock-on target is: lower is better (near the screen centre, then close). */
  _lockScore(m) {
    const v = m.center(this._v).sub(this.game.camera.position);
    const dist = v.length();
    const ang = Math.acos(clamp(v.normalize().dot(this.game.rig.forward), -1, 1));
    return ang * 400 + dist * 0.3 - (ang < 0.7 ? 1000 : 0);
  }

  /** A machine with more heads holds more locks: the best of the others, for missiles to be shared out among. */
  _updateExtraLocks(list) {
    const n = this.stats.lock - 1;
    const before = this.extraLocks.length ? this.extraLocks.slice() : [];
    this.extraLocks.length = 0;
    if (n > 0 && this.lock) {
      const others = list.filter((m) => m !== this.lock).sort((a, b) => this._lockScore(a) - this._lockScore(b));
      for (let i = 0; i < n && i < others.length; i++) this.extraLocks.push(others[i]);
    }
    if (this.extraLocks.some((m) => !before.includes(m))) this.game.audio.lockOn();
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
    this._updateExtraLocks(list);
  }

  /** Lock onto the enemy drawn nearest a screen point (a tap). Returns whether one was close enough. */
  pickTarget(x, y, radius = 64) {
    const hud = this.game.hud;
    const s = this._pick || (this._pick = { x: 0, y: 0, visible: false, dist: 0 });
    let best = null, bestD = radius;
    for (const m of this._candidates()) {
      hud.toScreen(m.center(this._v), s);
      if (!s.visible) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (!best) return false;
    this.lock = best;
    this.lockEnabled = true;
    this.game.audio.lockOn();
    return true;
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

    // soft aim: the enemy closest to the crosshair that is in the open (not behind a building)
    this.assistTarget = null;
    if (!this.lock && this.assistOn) {
      let bestOff = ASSIST_CONE;
      for (const e of this.game.enemies) {
        const m = e.mech;
        if (m.dead) continue;
        const c = m.center(this._v);
        const ox = c.x - cam.x, oy = c.y - cam.y, oz = c.z - cam.z;
        const len = Math.hypot(ox, oy, oz);
        if (len < 30 || len > ASSIST_RANGE) continue;
        const off = Math.acos(clamp((ox * f.x + oy * f.y + oz * f.z) / len, -1, 1)) - m.radius / len;
        if (off >= bestOff) continue;
        if (this.game.world.raycast(cam.x, cam.y, cam.z, ox / len, oy / len, oz / len, len) < len - m.radius) continue;
        bestOff = off;
        this.assistTarget = m;
      }
    }
  }

  /** Unit direction from `from` toward where a shot should go (lead-compensated when locked on). */
  _aimDir(from, speed, out) {
    const target = this.lock ?? this.assistTarget;
    if (target) {
      const c = target.center(out);
      const dist = c.distanceTo(from);
      const t = dist / speed;
      c.addScaledVector(target.vel, t * 0.85);
      const toTarget = c.sub(from).normalize();
      if (this.lock) return toTarget;
      // soft aim: blend the two directions, so the shot closes most of the gap however far the crosshair point is
      const toCrosshair = this._a.copy(this.aimPoint).sub(from).normalize();
      return toTarget.lerp(toCrosshair, 1 - ASSIST_PULL).normalize();
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
    this.dmgMul = (this.burstT > 0 ? 1.5 : 1) * this.stats.damage; // BURST and the weapons tuning dial
    // a power shortfall (stats.powerFactor < 1) slows every recharge, not just the main gun
    const recharge = this.stats.powerFactor * (this.burstT > 0 ? 1.8 : 1);
    if (this.missiles < this.stats.missileCharges) {
      this.missileT += dt * recharge;
      if (this.missileT >= MISSILE_RECHARGE) { this.missiles++; this.missileT = 0; }
    }
    for (const m of this.mounts) m.cd = Math.max(0, m.cd - dt * recharge);
    if (this.saberHold > 0) {
      this.saberHold -= dt;
      if (this.saberHold <= 0 && !this.melee) mech.setSaber(false);
    }

    // ---- burst
    if ((input.pressed('KeyX') || input.pressed('KeyC')) && this.burst >= 100 && this.burstT <= 0) {
      this.burstT = this.stats.burstTime;
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
    } else if (this.fieldT > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(game.time * 16);
      mech.tintColor = [0.02, 0.22 + 0.2 * pulse, 0.38 + 0.2 * pulse];
    } else if (mech.tintColor) {
      mech.tintColor = null;
    }

    // ---- reload
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) { this.ammo = this.magSize; game.audio.reload(); }
    } else if (input.pressed('KeyR') && this.ammo < this.magSize) {
      this._startReload();
    }

    // ---- missiles
    if (input.pressed('KeyE') && this.missiles > 0 && !this.melee) this._fireMissiles();
    for (const m of this.mounts) if (input.pressed(m.key) && m.cd <= 0 && !this.melee) this._fireMount(m);
    for (let i = this.missileQueue.length - 1; i >= 0; i--) {
      this.missileQueue[i].t -= dt;
      if (this.missileQueue[i].t <= 0) {
        this._launchMissile(this.missileQueue[i]);
        this.missileQueue.splice(i, 1);
      }
    }

    // ---- knocked down: nothing to do but get up again
    if (mech.knock) {
      if (this.melee) this._endMelee();
      this.missileQueue.length = 0;
      mech.update(dt, { pitch: 0 });
      game.audio.setBoost(0);
      return;
    }

    this._updateSub(dt, input);
    this._updatePassives(dt);

    // ---- melee state machine
    const dashPressed = input.pressed('ShiftLeft') || input.pressed('ShiftRight');
    if (this.melee && dashPressed && this.melee.t > this.melee.dur * 0.5) this._endMelee(); // dash-cancel the recovery
    if (input.pressed('Mouse2') || (this.meleeOnly && input.pressed('Mouse0'))) this._pressMelee();
    const meleeIntent = this._updateMelee(dt);

    // ---- movement intent
    const it = meleeIntent ?? this._moveIntent(input);

    // ---- gun
    if (!this.meleeOnly && !this.melee && input.down('Mouse0') && this.fireCd <= 0 && this.reloadT <= 0) {
      if (this.ammo > 0) this._fireWeapon();
      else this._startReload();
    }
    // ---- extra arms: their guns fire with the gun button (the H key on a melee build, where the button swings the blade)
    const limbTrigger = this.meleeOnly ? input.down('KeyH') : input.down('Mouse0');
    this._updateLimbs(dt, limbTrigger && !this.melee);
    this._updateTurrets(dt);
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
    // keys give -1/0/1; the touch stick adds an analog axis on top of them
    const fz = clamp((input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0) + input.axis.y, -1, 1);
    const rx = clamp((input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0) + input.axis.x, -1, 1);
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

  // ------------------------------------------------------------------ gun

  _startReload() {
    if (this.reloadT > 0 || this.meleeOnly) return;
    const w = this.weapon;
    const missing = w.mag - this.ammo;
    this.reloadDur = this.ammo === 0 ? w.reload : Math.max(0.8, (w.reload * missing) / w.mag);
    this.reloadT = this.reloadDur;
    this.game.audio.reload();
  }

  /** Fire the equipped gun: rifle, rapid gun, bazooka, sniper, shotgun, seeker or lance (see parts.js). */
  _fireWeapon() {
    const game = this.game;
    const mech = this.mech;
    const w = this.weapon;
    mech.model.muzzleWorld(this._muzzle);
    const aim = this._aimDir(this._muzzle, w.speed, this._w);
    // never shoot backwards through our own body when the crosshair is very close
    if (aim.dot(mech.forward()) < -0.2) aim.copy(mech.forward());

    // a seeker curves onto your lock, or onto whatever is near the crosshair; ordinary beams only nudge toward a lock
    const pellets = w.pellets ?? 1;
    const target = w.homing ? this.lock ?? this._missileTarget() : this.lock;
    const turn = w.homing ? w.homing : this.lock && w.kind === 'beam' && pellets === 1 ? 0.9 : 0;
    const color = w.kind === 'cannon' ? 0xffa040 : this.energy.beam;
    for (let i = 0; i < pellets; i++) {
      const dir = this._d.copy(aim);
      if (w.spread) {
        dir.x += rand(-w.spread, w.spread);
        dir.y += rand(-w.spread, w.spread);
        dir.z += rand(-w.spread, w.spread);
        dir.normalize();
      }
      game.projectiles.spawn({
        type: w.kind, team: 'player', source: mech, pos: this._muzzle, dir,
        damage: w.damage * this.dmgMul, color, knock: w.knock, speed: w.speed, radius: w.radius, life: w.life,
        target, turn, pierce: w.pierce,
        splash: w.splash ? { radius: w.splash.radius, damage: w.splash.damage * this.dmgMul } : null,
      });
    }
    mech.model.recoil(w.kind === 'cannon' ? 1 : w.pellets ? 0.8 : w.kind === 'bullet' ? 0.16 : w.damage > 300 ? 0.75 : 0.42);
    const m = this._muzzle;
    const c = rgb(color);
    game.fx.glow.spawn(m.x, m.y, m.z, 0, 0, 0, 0.09, w.kind === 'cannon' ? 12 : 8, 3, [1, 1, 1], c, 0.9);
    if (w.kind === 'beam') game.audio.beam();
    else if (w.kind === 'bullet') game.audio.gun();
    else game.audio.cannon();
    game.shake(w.shake);
    this.ammo--;
    this.fireCd = w.cooldown * (this.burstT > 0 ? 0.6 : 1);
    this.lastFired = game.time;
    if (this.ammo <= 0) this._startReload();
  }

  // ------------------------------------------------------------------ extra arms

  _updateLimbs(dt, firing) {
    for (const L of this.limbGuns) {
      L.cd = Math.max(0, L.cd - dt * this.stats.powerFactor); // a machine that draws too much power fires slower
      if (firing && L.cd <= 0 && !this.mech.dead) this._fireLimb(L);
    }
  }

  /** One extra arm fires: a beam gun's bolt, a cannon's shell, a shotgun's pellets or a railgun's slug, from its own muzzle toward the aim. */
  _fireLimb(L) {
    const game = this.game, mech = this.mech, def = L.def;
    const cannon = def.kind === 'cannon', shotgun = def.kind === 'shotgun', rail = def.kind === 'rail';
    mech.model.limbMuzzleWorld(L.idx, this._muzzle);
    const aim = this._aimDir(this._muzzle, def.speed, this._w);
    if (aim.dot(mech.forward()) < -0.2) aim.copy(mech.forward());
    const color = cannon ? 0xffa040 : rail ? 0xffffff : this.energy.beam;
    const pellets = shotgun ? def.pellets : 1;
    for (let i = 0; i < pellets; i++) {
      const dir = this._d.copy(aim);
      if (def.spread) {
        dir.x += rand(-def.spread, def.spread);
        dir.y += rand(-def.spread, def.spread);
        dir.z += rand(-def.spread, def.spread);
        dir.normalize();
      }
      game.projectiles.spawn({
        type: cannon ? 'cannon' : 'beam', team: 'player', source: mech, pos: this._muzzle, dir,
        damage: def.damage * this.dmgMul, color, speed: def.speed, knock: cannon ? 20 : rail ? 14 : 0,
        life: shotgun ? 0.42 : rail ? 1.3 : undefined, pierce: rail,
        target: this.lock, turn: this.lock && !cannon && !shotgun && !rail ? 0.9 : 0,
        splash: def.splash ? { radius: def.splash.radius, damage: def.splash.damage * this.dmgMul } : null,
      });
    }
    mech.model.fireLimb(L.idx, cannon ? 0.9 : rail ? 0.85 : shotgun ? 0.6 : 0.3);
    const m = this._muzzle;
    game.fx.glow.spawn(m.x, m.y, m.z, 0, 0, 0, 0.08, cannon || rail ? 9 : shotgun ? 7 : 5, 3, [1, 1, 1], rgb(color), 0.9);
    if (cannon || rail) { game.audio.cannon(m); game.shake(rail ? 0.3 : 0.25); } else if (shotgun) { game.audio.gun(m); game.shake(0.15); } else if (this._limbShots++ % 3 === 0) game.audio.beam(m);
    L.cd = def.interval * (this.burstT > 0 ? 0.6 : 1);
    this.lastFired = game.time;
  }

  // ------------------------------------------------------------------ self-aiming guns

  /**
   * The tail gun, the turret pods and the chest vulcan pick the nearest enemy in range and keep firing at it without
   * your aim. The vulcan goes for missiles that are coming at you first. They draw power like everything else.
   */
  _updateTurrets(dt) {
    if (!this.turrets.length) return;
    const game = this.game, mech = this.mech;
    for (const T of this.turrets) {
      const def = T.def;
      T.cd = Math.max(0, T.cd - dt * this.stats.powerFactor);
      if (mech.dead) continue;
      mech.model.turretMuzzleWorld(def.slot, this._muzzle);
      const from = this._muzzle;
      let at = null;
      if (def.intercept) {
        const q = game.projectiles.incomingNear(mech, from, def.range);
        if (q) at = this._a.copy(q.pos);
      }
      if (!at) {
        let best = null, bd = def.range * def.range;
        for (const e of game.enemies) {
          if (e.mech.dead) continue;
          const c = e.mech.center(this._v);
          const d2 = c.distanceToSquared(from);
          if (d2 < bd) { bd = d2; best = e.mech; }
        }
        if (best) {
          const c = best.center(this._a);
          c.addScaledVector(best.vel, (Math.sqrt(bd) / def.speed) * 0.85);
          at = c;
        }
      }
      if (!at) continue;
      mech.model.aimTurret(def.slot, at);
      if (T.cd > 0) continue;
      const dir = this._d.copy(at).sub(from).normalize();
      dir.x += rand(-0.02, 0.02); dir.y += rand(-0.02, 0.02); dir.z += rand(-0.02, 0.02);
      dir.normalize();
      game.projectiles.spawn({
        type: 'beam', team: 'player', source: mech, pos: from, dir, damage: def.damage * this.dmgMul, color: this.energy.beam,
        speed: def.speed, life: def.range / def.speed + 0.1, knock: 0.5, intercept: !!def.intercept,
      });
      if (Math.random() < 0.25) game.audio.gun(from);
      T.cd = def.interval;
    }
  }

  // ------------------------------------------------------------------ sub-weapon (V) and passives

  _updateSub(dt, input) {
    const sub = this.sub;
    this.subCd = Math.max(0, this.subCd - dt * this.stats.powerFactor); // cooldowns of every sub-weapon, and the vulcan fire interval
    this.fieldT = Math.max(0, this.fieldT - dt);
    if (this.repairT > 0) {
      const amount = (sub.heal * this.mech.maxHp * Math.min(dt, this.repairT)) / sub.duration;
      this.mech.heal(amount);
      this.repairT = Math.max(0, this.repairT - dt);
    }
    if (!sub) return;

    if (sub.kind === 'vulcan') {
      const firing = input.down('KeyV') && !this.melee && !this.subLocked;
      if (firing) {
        this.subHeat = Math.min(1, this.subHeat + sub.heatPerSecond * dt);
        if (this.subCd <= 0) {
          this._fireVulcan();
          this.subCd = sub.interval;
        }
        if (this.subHeat >= 1) this.subLocked = true;
      } else {
        this.subHeat = Math.max(0, this.subHeat - sub.coolPerSecond * dt);
        if (this.subLocked && this.subHeat <= sub.lockout) this.subLocked = false;
      }
    } else if (sub.kind === 'flare' && input.pressed('KeyV') && this.subCd <= 0) {
      this._fireFlares();
    } else if (sub.kind === 'injector' && input.pressed('KeyV') && this.subCd <= 0) {
      this._fireInjector();
    } else if (sub.kind === 'pulse' && input.pressed('KeyV') && this.subCd <= 0 && !this.melee) {
      this._firePulse();
    } else if (sub.kind === 'field' && input.pressed('KeyV') && this.subCd <= 0) {
      this._fireField();
    } else if (sub.kind === 'repair' && input.pressed('KeyV') && this.repairCharges > 0 && this.repairT <= 0 && this.mech.hp < this.mech.maxHp) {
      this.repairCharges--;
      this.repairT = sub.duration;
      this.game.audio.repair();
      this.game.hud.message('REPAIRING', 'good');
    }
  }

  _fireVulcan() {
    const game = this.game;
    const mech = this.mech;
    const sub = this.sub;
    mech.model.headMuzzleWorld(this._muzzle);
    const dir = this._aimDir(this._muzzle, sub.speed, this._w);
    if (dir.dot(mech.forward()) < -0.2) dir.copy(mech.forward());
    dir.x += rand(-0.03, 0.03); dir.y += rand(-0.03, 0.03); dir.z += rand(-0.03, 0.03);
    dir.normalize();
    game.projectiles.spawn({
      type: 'bullet', team: 'player', source: mech, pos: this._muzzle, dir,
      damage: sub.damage * this.dmgMul, color: this.energy.beam, knock: 0.5, speed: sub.speed, life: 0.55, intercept: true,
    });
    if (Math.random() < 0.4) game.audio.gun();
    this.lastFired = game.time;
  }

  /** Decoy flares: every enemy missile homing on us detonates harmlessly. */
  _fireFlares() {
    const game = this.game;
    const mech = this.mech;
    this.subCd = this.sub.cooldown;
    const n = game.projectiles.decoyMissilesAt(mech);
    const c = mech.center(this._v);
    for (let i = 0; i < 14; i++) {
      game.fx.glow.spawn(c.x + rand(-4, 4), c.y + rand(-2, 4), c.z + rand(-4, 4), rand(-30, 30), rand(10, 45), rand(-30, 30),
        rand(0.5, 1.1), 2.2, 0.4, [1, 0.9, 0.5], [1, 0.4, 0.1], 1, -20, 0.6);
    }
    game.audio.flare();
    if (n > 0) game.hud.message(n > 1 ? `${n} MISSILES DECOYED` : 'MISSILE DECOYED', 'good');
  }

  /** EN injector: refill boost fuel and clear an overheat (not worth firing when the tank is already near full). */
  _fireInjector() {
    const mech = this.mech;
    if (mech.en > mech.maxEn * 0.85 && !mech.overheat) return;
    mech.en = mech.maxEn;
    mech.overheat = false;
    this.subCd = this.sub.cooldown;
    const c = mech.center(this._v);
    for (let i = 0; i < 12; i++) {
      this.game.fx.glow.spawn(c.x + rand(-3, 3), c.y + rand(-6, 2), c.z + rand(-3, 3), rand(-20, 20), rand(15, 50), rand(-20, 20),
        rand(0.4, 0.8), 2.0, 0.3, [0.7, 1, 1], [0.2, 0.7, 1], 1, -20, 0.6);
    }
    this.game.audio.repair();
    this.game.hud.message('BOOST FUEL RESTORED', 'good');
  }

  /** Shock pulse: damages, shoves and staggers every enemy close to us. */
  _firePulse() {
    const game = this.game;
    const mech = this.mech;
    const sub = this.sub;
    this.subCd = sub.cooldown;
    const c = mech.center(this._v);
    let hit = 0;
    for (const e of game.enemies) {
      const m = e.mech;
      if (m.dead) continue;
      const away = m.center(this._w).sub(c);
      const d = away.length() - m.radius;
      if (d > sub.radius) continue;
      away.y = 0;
      away.normalize().multiplyScalar(90 * (1 - Math.max(0, d) / sub.radius * 0.5));
      m.takeDamage(sub.damage * this.dmgMul, { source: mech, knock: away, kind: 'pulse', stagger: true, point: m.center(new THREE.Vector3()) });
      hit++;
    }
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      game.fx.glow.spawn(c.x, c.y - 4, c.z, Math.cos(a) * 120, 0, Math.sin(a) * 120, 0.5, 3.2, 0.5, [0.8, 1, 1], [0.2, 0.7, 1], 1);
    }
    game.fx.explosion(new THREE.Vector3(mech.pos.x, mech.pos.y, mech.pos.z), 14, { sound: false, shake: 0.4 });
    game.audio.cannon(mech.pos);
    game.shake(0.5);
    if (hit > 0) game.hitstop(0.05);
  }

  /** Aegis field: a short spell of total invulnerability. */
  _fireField() {
    const mech = this.mech;
    this.subCd = this.sub.cooldown;
    this.fieldT = this.sub.duration;
    mech.invuln = Math.max(mech.invuln, this.sub.duration);
    const c = mech.center(this._v);
    for (let i = 0; i < 16; i++) {
      this.game.fx.glow.spawn(c.x + rand(-5, 5), c.y + rand(-7, 7), c.z + rand(-5, 5), rand(-25, 25), rand(-10, 25), rand(-25, 25),
        rand(0.5, 1.0), 2.4, 0.4, [0.7, 1, 1], [0.2, 0.6, 1], 1, 0, 0.6);
    }
    this.game.audio.flare();
    this.game.hud.message('AEGIS FIELD', 'good');
  }

  /** Always-on core effects: the nano-repair core mends armor once you have been left alone for a moment. */
  _updatePassives(dt) {
    const mech = this.mech;
    if (this.stats.regen > 0 && mech.hp < mech.maxHp && this.game.time - mech.lastHitAt > 3) {
      mech.heal(this.stats.regen * dt);
    }
  }

  /** Fire one shoulder mount (cannon, micro-missile pod or rail lance), then it cools down. */
  _fireMount(mount) {
    if (mount.def.kind === 'swarm') { this._fireSwarm(mount); return; }
    if (mount.def.kind === 'rail') { this._fireRail(mount); return; }
    const game = this.game;
    const mech = this.mech;
    const a = mount.def;
    mech.model.mountMuzzleWorld(a.side, this._muzzle);
    const dir = this._aimDir(this._muzzle, a.speed, this._w);
    if (dir.dot(mech.forward()) < -0.2) dir.copy(mech.forward());
    game.projectiles.spawn({
      type: 'cannon', team: 'player', source: mech, pos: this._muzzle, dir,
      damage: a.damage * this.dmgMul, color: 0xffa040, knock: a.knock, speed: a.speed,
      splash: { radius: a.splash.radius, damage: a.splash.damage * this.dmgMul },
    });
    const m = this._muzzle;
    game.fx.glow.spawn(m.x, m.y, m.z, 0, 0, 0, 0.12, 14, 4, [1, 1, 1], [1, 0.55, 0.2], 0.9);
    game.audio.cannon();
    game.shake(0.4);
    mech.model.recoil(0.8, a.side);
    mount.cd = a.cooldown;
    this.lastFired = game.time;
  }

  /** Rail lance: a fast slug that pierces everything along its line. */
  _fireRail(m) {
    const game = this.game;
    const mech = this.mech;
    const a = m.def;
    mech.model.mountMuzzleWorld(a.side, this._muzzle);
    const dir = this._aimDir(this._muzzle, a.speed, this._w);
    if (dir.dot(mech.forward()) < -0.2) dir.copy(mech.forward());
    game.projectiles.spawn({
      type: 'beam', team: 'player', source: mech, pos: this._muzzle, dir,
      damage: a.damage * this.dmgMul, color: 0xbfe6ff, knock: a.knock, speed: a.speed, radius: 2.2, life: 0.9, pierce: true,
    });
    const p = this._muzzle;
    game.fx.glow.spawn(p.x, p.y, p.z, 0, 0, 0, 0.12, 14, 4, [1, 1, 1], [0.6, 0.85, 1], 0.9);
    game.audio.beam();
    game.shake(0.35);
    mech.model.recoil(0.7, a.side);
    m.cd = a.cooldown;
    this.lastFired = game.time;
  }

  // ------------------------------------------------------------------ missiles

  /** Where homing weapons go: the lock, else whatever is closest to the crosshair (null if nothing is near it). */
  _missileTarget() {
    if (this.lock) return this.lock;
    const list = this._candidates();
    const target = list.length ? this._bestTarget(list) : null;
    if (!target) return null;
    const v = target.center(this._v).sub(this.game.camera.position).normalize();
    return v.dot(this.game.rig.forward) < 0.8 ? null : target;
  }

  /** Micro-missile pod: a quick volley of small homing missiles from the shoulder it is mounted on. */
  _fireSwarm(m) {
    const a = m.def;
    const target = this._missileTarget();
    for (let i = 0; i < a.count; i++) this.missileQueue.push({ t: i * 0.07, side: i % 2 ? 1 : -1, target, micro: m });
    m.cd = a.cooldown;
    this.lastFired = this.game.time;
    this.game.audio.missile(this.mech.pos);
  }

  _fireMissiles() {
    this.missiles--;
    if (this.missiles === this.stats.missileCharges - 1) this.missileT = 0;
    // the salvo (bigger with launcher arms) is shared out among every locked target
    const targets = [this._missileTarget(), ...this.extraLocks].filter(Boolean);
    for (let i = 0; i < this.stats.salvo; i++) {
      this.missileQueue.push({ t: i * 0.09, side: i % 2 ? 1 : -1, target: targets.length ? targets[i % targets.length] : null });
    }
    this.game.audio.missile(this.mech.pos);
  }

  _launchMissile(q) {
    const mech = this.mech;
    const game = this.game;
    const fwd = mech.forward(this._v).clone();
    const right = new THREE.Vector3(Math.cos(mech.yaw), 0, -Math.sin(mech.yaw));
    if (q.micro) {
      // micro-missiles leave the shoulder launcher in a fan, leaning to the side they are mounted on
      const a = q.micro.def;
      mech.model.mountMuzzleWorld(a.side, this._muzzle);
      const lean = (a.side === 'L' ? -1 : 1) * rand(0.05, 0.3) + q.side * rand(0.05, 0.2);
      const dir = new THREE.Vector3(0, 0.35, 0).addScaledVector(fwd, 1)
        .addScaledVector(right, lean).add(new THREE.Vector3(0, rand(0, 0.4), 0)).normalize();
      game.projectiles.spawn({
        type: 'missile', team: 'player', source: mech, pos: this._muzzle, dir, color: 0xffd070,
        damage: a.damage * this.dmgMul, speed: 130, maxSpeed: 290, delay: 0.18, turn: 6.2 + this.stats.missileTurn, target: q.target,
        splash: { radius: a.splash.radius, damage: a.splash.damage * this.dmgMul }, knock: 8, life: 4.5, radius: 1.5,
      });
      mech.model.recoil(0.25, a.side);
      game.audio.missile(this._muzzle);
      return;
    }
    const pos = new THREE.Vector3(mech.pos.x, mech.pos.y + 15, mech.pos.z).addScaledVector(right, q.side * 4.5).addScaledVector(fwd, -1);
    const dir = new THREE.Vector3(0, 0.9, 0)
      .addScaledVector(fwd, 0.7)
      .addScaledVector(right, q.side * rand(0.12, 0.35))
      .normalize();
    game.projectiles.spawn({
      type: 'missile', team: 'player', source: mech, pos, dir, color: 0xffb060,
      damage: 150 * this.stats.missileDamage * this.dmgMul, speed: 120, maxSpeed: 270, delay: 0.3,
      turn: 5.6 + this.stats.missileTurn, target: q.target,
      splash: { radius: 16, damage: 70 * this.stats.missileDamage * this.dmgMul }, knock: 14,
      life: 5,
    });
    game.audio.missile(pos);
  }

  // ------------------------------------------------------------------ sabre

  _pressMelee() {
    if (!this.melee) {
      const target = this._meleeTarget();
      const mech = this.mech;
      if (target && mech.en >= mech.def.dashCost * 0.5) {
        const dist = target.center(this._v).distanceTo(mech.center(this._w));
        if (dist > target.radius + mech.radius + 14 && dist < LUNGE_RANGE) { this._startLunge(target); return; }
      }
      this._startMelee(0);
    } else if (this.melee.stage >= 0 && this.melee.stage < MELEE.length - 1 && this.melee.t > this.melee.dur * 0.25) {
      this.melee.queued = true;
    }
  }

  /** Boost in at the target with the saber drawn and trailing, then open the combo on contact. */
  _startLunge(target) {
    const mech = this.mech;
    this.melee = { stage: -1, kind: 'lunge', dur: LUNGE_TIME, t: 0, hitDone: true, arcDone: true, queued: false, target };
    if (!this.burstActive) mech.en -= mech.def.dashCost * 0.5;
    mech.enDelay = 0.9;
    this.saberHold = 0.5;
    mech.setSaber(true);
    mech.model.flare(1);
    this.game.audio.setSaber(true);
    this.game.audio.dash(mech.pos);
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

  _startMelee(stage, target = this._meleeTarget()) {
    const def = MELEE[stage];
    this.melee = { stage, kind: def.kind, dur: def.dur, t: 0, hitDone: false, arcDone: false, queued: false, target };
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
    if (melee.stage < 0) return this._updateLunge(melee, p);
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
      game.fx.slashArc(mech, def.kind, this.energy.blade);
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

  /** The lunge: home in on the target at full boost; on contact (or when it runs out) the first swing starts. */
  _updateLunge(melee, p) {
    const mech = this.mech;
    const tgt = melee.target && !melee.target.dead ? melee.target : null;
    const lunge = this._lunge;
    let contact = !tgt || p >= 1;
    if (tgt) {
      lunge.copy(tgt.center(this._v)).sub(mech.center(this._w));
      const dist = lunge.length();
      const reach = tgt.radius + mech.radius + 8;
      if (dist <= reach) contact = true;
      else lunge.normalize().multiplyScalar(Math.min(LUNGE_SPEED, (dist - reach + 2) / Math.max(1 / 60, 0.001)));
    }
    if (contact) {
      this._startMelee(0, tgt);
      return this._updateMelee(0);
    }
    return {
      attack: { kind: 'lunge', t: Math.min(1, p) }, hover: true, moveX: 0, moveZ: 0, velocity: lunge,
      faceYaw: yawToward(mech.pos.x, mech.pos.z, tgt.pos.x, tgt.pos.z),
    };
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
      if (dist > this.stats.reach + m.radius) continue;
      v.y = 0;
      if (v.lengthSq() > 1e-4 && v.normalize().dot(fwd) < 0.2) continue;
      const knock = fwd.clone().multiplyScalar(def.stagger ? 130 : 45);
      knock.y = def.stagger ? 40 : 0;
      m.takeDamage(def.damage * this.stats.melee * this.dmgMul, { source: mech, knock, kind: 'saber', stagger: def.stagger, down: !!def.finisher, point: m.center(new THREE.Vector3()) });
      game.fx.sparks(m.center(new THREE.Vector3()), fwd, def.finisher ? 40 : 22, [1, 0.6, 0.95]);
      landed = true;
    }
    // a stroke that reaches a wall cuts into it as well (the finisher, a good deal deeper)
    if (game.destruction.slash(mech, this.stats.reach, def.damage * this.stats.melee * this.dmgMul * (def.finisher ? 1.5 : 0.6))) {
      game.audio.saberHit(mech.pos);
      game.shake(0.3);
    }
    if (landed) {
      game.audio.saberHit(mech.pos);
      game.shake(def.stagger ? 0.9 : 0.5);
      game.hitstop(def.stagger ? 0.11 : 0.07);
      if (def.finisher) game.cinematic('finisher');
    }
  }
}
