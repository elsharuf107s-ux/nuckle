// A mech's body: movement physics (walk, boost-ascend, dash), world collision, damage and the
// hand-off to the visual model. Players and AI both drive it by passing an `intent` to update().

import * as THREE from 'three';
import { MECHS } from './data.js';
import { buildMech } from './mechModel.js';
import { ARENA } from './world.js';
import { angleDiff, clamp, damp, dampAngle, lerp, rand, segSegDistSq } from './util.js';

const GRAVITY = 78;
const MAX_FALL = 120;
const CEILING = 230;

/**
 * Intent fields (all optional):
 *   moveX, moveZ  desired world-space direction, magnitude 0..1
 *   ascend        hold vertical boost
 *   dash          THREE.Vector3 direction to quick-boost along (set for one update to trigger)
 *   faceYaw       yaw the mech should turn toward (defaults to its movement direction)
 *   pitch         aim pitch for the rifle arm
 *   speedMul      scales walking/flying speed
 *   freeBoost     boosting costs no EN (burst mode)
 *   attack        { kind, t } sabre swing pose for the model
 *   charge        0..1 muzzle glow
 *   velocity      THREE.Vector3 that overrides all movement this update (sabre lunges)
 *   hover         true to cancel gravity gently (floating during a melee swing)
 *   launch        0..1 the crouched stance on the catapult (see Game.updateLaunch)
 */
const BARRIER_DELAY = 5;  // seconds without a hit before the barrier recharges
const BARRIER_RATE = 70;  // barrier points restored per second once it does
const JUMP_CROUCH = 0.09; // a jump loads the legs this long before it leaves the ground
const SKID_TIME = 0.32;   // after a step (or a fast landing) the mech slides to a stop on its heels
// a knockdown: thrown down (until it hits the ground), lying there, then getting up
const KNOCK_LIE = 0.55;
const KNOCK_RISE = 0.7;
// parts with health of their own: a hit that lands near one is shared with it (and a blow with no clear point sometimes finds one)
const PART_SHARE = 0.4;    // the share of a hit a part near the impact soaks
const PART_REACH = 3.6;    // how near the impact has to be, in model units
const PART_BLIND = 0.35;   // the chance a saber stroke or a falling wall takes a random part instead

export class Mech {
  /** `defOverride` lets the garage field a custom build (see parts.js deriveMech) instead of a stock mech. */
  constructor(game, type, team, defOverride = null) {
    this.game = game;
    this.type = type;
    this.team = team;
    this.def = defOverride ?? MECHS[type];
    this.spec = this.def.spec;

    this.model = buildMech(this.spec);
    this.root = this.model.root;
    this.root.scale.setScalar(this.spec.scale);
    game.scene.add(this.root);

    const s = this.spec.scale;
    this.radius = this.model.radius * s; // a spider spreads wider than a biped, a tank is lower
    this.height = this.model.height * s;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    // the socketed parts and legs, each with its own health: { slot, name, kind, hp, maxHp, broken }
    this.parts = (this.def.parts ?? []).map((p) => ({ slot: p.slot, name: p.name, kind: p.kind, hp: p.hp, maxHp: p.hp, broken: false }));
    this.maxHp = this.hp = this.def.hp;
    this.maxEn = this.en = this.def.en;
    this.overheat = false;
    this.enDelay = 0;

    this.grounded = false;
    this.blocked = 0; // walls touched last update
    this.outOfBounds = false;
    this.thrusting = false;
    this.dashT = 0;
    this.dashCd = 0;
    this.dashDir = new THREE.Vector3();
    this.invuln = 0;
    this.stagger = 0;
    this.flashT = 0;
    this.lastHitAt = -99;
    this.turnRate = 0; // yaw change per second, for the animation (turning on the spot shuffles the feet)
    this.barrierMax = this.barrier = this.def.barrier ?? 0; // barrier core: soaks damage first, then recharges
    this.barrierHitAt = -99;
    this.dead = false;
    this.saberOut = false;
    this.tintColor = null; // [r, g, b] steady glow, e.g. burst aura
    this.jumpT = 0;        // the crouch before a jump
    this.skidT = 0;        // sliding to a stop after a step
    this.knock = null;     // knocked down: { phase: 'fall' | 'lie' | 'rise', t }
    this.ghostT = 0;       // afterimage timer
    this.ghosts = team === 'player' || type === 'striker' || type === 'baron'; // the fast machines leave afterimages

    this._fwd = new THREE.Vector3();
    this._trail = new THREE.Vector3();
    this._wasTinted = false;
  }

  place(x, z, y = 0, yaw = 0) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.root.position.copy(this.pos);
    this.root.rotation.y = yaw;
    this.grounded = y <= 0.01;
  }

  /** Point in the middle of the torso, for aiming and hit effects. */
  center(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + this.height * 0.55, this.pos.z);
  }

  forward(out = this._fwd) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  setSaber(on) {
    this.saberOut = on;
    this.model.setSaber(on);
  }

  // ------------------------------------------------------------------ per-frame

  update(dt, it = {}) {
    if (this.dead) return;
    const def = this.def;

    this.invuln = Math.max(0, this.invuln - dt);
    this.stagger = Math.max(0, this.stagger - dt);
    if (this.barrierMax > 0 && this.barrier < this.barrierMax && this.game.time - this.barrierHitAt > BARRIER_DELAY) {
      this.barrier = Math.min(this.barrierMax, this.barrier + BARRIER_RATE * dt);
    }
    this.flashT = Math.max(0, this.flashT - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.enDelay = Math.max(0, this.enDelay - dt);
    this.skidT = Math.max(0, this.skidT - dt);
    if (this.knock) this._updateKnock(dt);

    const staggered = this.stagger > 0 || !!this.knock;
    const speedMul = it.speedMul ?? 1;
    let mx = staggered ? 0 : it.moveX ?? 0;
    let mz = staggered ? 0 : it.moveZ ?? 0;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }

    // ---- dash (quick boost)
    if (it.dash && this.dashCd <= 0 && !this.overheat && !staggered && this.en >= def.dashCost) {
      this.dashDir.copy(it.dash);
      if (this.dashDir.lengthSq() < 1e-4) this.forward(this.dashDir);
      this.dashDir.normalize();
      this.dashT = def.dashTime;
      this.dashCd = def.dashTime + 0.2;
      if (!it.freeBoost) this.en -= def.dashCost;
      this.enDelay = 0.9;
      this.invuln = Math.max(this.invuln, def.dashInvuln);
      this.game.audio.dash(this.pos);
      this.game.fx.dust(this.pos, 6, 10);
    }

    // ---- a jump from the ground: the legs load for a moment, then push off
    const canJump = it.ascend && this.grounded && !this.overheat && this.en > 0 && !staggered && this.dashT <= 0 && !it.velocity && this.vel.y <= 0;
    if (this.jumpT <= 0 && canJump) this.jumpT = JUMP_CROUCH;
    let pushOff = false;
    if (this.jumpT > 0) {
      this.jumpT -= dt;
      if (staggered || this.dashT > 0 || it.velocity) this.jumpT = 0;
      else if (this.jumpT <= 0) pushOff = true;
    }

    this.thrusting = false;
    if (it.velocity) {
      this.vel.copy(it.velocity);
      this.dashT = 0;
      this.thrusting = true;
    } else if (this.dashT > 0) {
      this.dashT -= dt;
      const k = clamp(this.dashT / def.dashTime, 0, 1);
      const speed = lerp(def.speed * speedMul * 1.2, def.dashSpeed, Math.sqrt(k));
      this.vel.x = this.dashDir.x * speed;
      this.vel.z = this.dashDir.z * speed;
      this.vel.y = this.dashDir.y * speed * 0.7;
      this.thrusting = true;
      if (this.dashT <= 0 && this.grounded) this.skidT = SKID_TIME; // the step ends in a slide
    } else {
      // ---- horizontal (a skid lets the mech slide on a little)
      const top = (this.grounded ? def.speed : def.airSpeed) * speedMul;
      const lambda = this.knock ? (this.knock.phase === 'fall' ? 1.5 : 4) : staggered ? 1.5 : this.grounded ? (this.skidT > 0 ? 5 : 11) : mx || mz ? 3.2 : 1.2;
      this.vel.x = damp(this.vel.x, mx * top, lambda, dt);
      this.vel.z = damp(this.vel.z, mz * top, lambda, dt);

      // ---- vertical
      if (this.jumpT > 0) {
        this.vel.y = 0; // still crouching
      } else if (pushOff) {
        this.vel.y = def.ascendSpeed * 1.2;
        this.thrusting = true;
        this.model.flare(1);
        this.game.fx.dust(this.pos, 10, 16);
      } else if (it.ascend && !this.overheat && this.en > 0 && !staggered) {
        this.vel.y = damp(this.vel.y, def.ascendSpeed * (speedMul > 1 ? 1.1 : 1), 6, dt);
        if (!it.freeBoost) this.en -= def.ascendCost * dt;
        this.enDelay = 0.5;
        this.thrusting = true;
        if (this.en <= 0) { this.en = 0; this.overheat = true; }
      } else if (it.hover) {
        this.vel.y = damp(this.vel.y, 0, 8, dt);
      } else if (!this.grounded || this.vel.y > 0) {
        this.vel.y = Math.max(this.vel.y - GRAVITY * dt, -MAX_FALL);
      }
      if (this.pos.y > CEILING && this.vel.y > 0) this.vel.y = 0;
    }

    // ---- EN recovery
    if (!this.thrusting && this.enDelay <= 0) {
      this.en = Math.min(this.maxEn, this.en + (this.grounded ? def.enGround : def.enAir) * dt);
    }
    if (this.overheat && this.en >= this.maxEn * 0.3) this.overheat = false;

    this._integrate(dt);

    // ---- facing
    let faceYaw = it.faceYaw;
    if (faceYaw === undefined && (mx || mz) && !this.knock) faceYaw = Math.atan2(-mx, -mz);
    if (this.knock) faceYaw = undefined;
    const prevYaw = this.yaw;
    if (faceYaw !== undefined) this.yaw = dampAngle(this.yaw, faceYaw, def.turn, dt);
    this.turnRate = dt > 0 ? angleDiff(prevYaw, this.yaw) / dt : 0;
    this.pitch = damp(this.pitch, it.pitch ?? 0, 10, dt);
    this.aimYaw = it.faceYaw !== undefined ? angleDiff(this.yaw, it.faceYaw) : 0;

    // ---- afterimages trail a step or a lunge
    if (this.ghosts && (this.dashT > 0 || (it.velocity && it.attack?.kind === 'lunge'))) {
      this.ghostT -= dt;
      if (this.ghostT <= 0) {
        this.ghostT = 0.045;
        this.game.fx.afterimage(this);
      }
    } else this.ghostT = 0;

    this._syncModel(dt, it);
  }

  /** Move by the velocity and resolve the ground, rooftops, walls and the arena edge. */
  _integrate(dt) {
    const prevY = this.pos.y;
    this.pos.addScaledVector(this.vel, dt);

    // Land before wall collision: a fast fall can sink below a roof's top in one step, and the
    // wall push-out would otherwise shove the mech sideways instead of letting it land.
    const support = this.game.world.supportHeight(this.pos.x, this.pos.z, this.radius, prevY);
    if (this.pos.y <= support && this.vel.y <= 0) {
      if (!this.grounded && this.vel.y < -35) this._landed(-this.vel.y);
      this.pos.y = support;
      this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = this.pos.y <= support + 0.05;
    }
    this.blocked = this.game.world.collide(this.pos, this.vel, this.radius);

    // ---- arena edge: a firm push back inside
    for (const axis of ['x', 'z']) {
      const over = Math.abs(this.pos[axis]) - ARENA;
      if (over > 0) {
        const sign = Math.sign(this.pos[axis]);
        this.vel[axis] -= sign * Math.min(260, 80 + over * 6) * dt;
        if (over > 30) this.pos[axis] = sign * (ARENA + 30);
      }
    }
    this.outOfBounds = Math.abs(this.pos.x) > ARENA - 10 || Math.abs(this.pos.z) > ARENA - 10;
  }

  _landed(speed) {
    this.model.land(clamp((speed - 20) / 120, 0.2, 1));
    this.game.fx.dust(this.pos, Math.min(16, 6 + speed / 10), 18);
    if (speed > 70) this.game.shakeFrom(this.pos, 0.25, 200);
    if (Math.hypot(this.vel.x, this.vel.z) > 60) this.skidT = SKID_TIME; // a fast landing skids
  }

  // ------------------------------------------------------------------ knockdown

  /** Thrown to the ground by a finisher. Bosses and machines that cannot be staggered stay on their feet. */
  knockDown() {
    if (this.knock || this.dead || this.def.staggerAt === Infinity) return;
    this.knock = { phase: 'fall', t: 0 };
    this.dashT = 0;
    this.jumpT = 0;
    this.stagger = Math.max(this.stagger, 0.2);
    if (this.saberOut) this.setSaber(false);
  }

  _updateKnock(dt) {
    const k = this.knock;
    k.t += dt;
    this.stagger = Math.max(this.stagger, 0.1); // no control while down
    if (k.phase === 'fall' && ((this.grounded && k.t > 0.3) || k.t > 3)) {
      k.phase = 'lie';
      k.t = 0;
      this.game.fx.dust(this.pos, 14, 22);
      this.game.shakeFrom(this.pos, 0.35, 220);
      this.game.audio.hit(this.pos);
    } else if (k.phase === 'lie' && k.t > KNOCK_LIE) {
      k.phase = 'rise';
      k.t = 0;
      this.model.flare(1); // the thrusters help it up
      this.game.fx.dust(this.pos, 8, 14);
    } else if (k.phase === 'rise' && k.t > KNOCK_RISE) {
      this.knock = null;
      if (this.team === 'player') this.invuln = Math.max(this.invuln, 0.4);
      return;
    }
    // a pilot on the ground cannot be juggled: invulnerable from the moment it lands until it is back up
    if (this.team === 'player' && k.phase !== 'fall') this.invuln = Math.max(this.invuln, 0.1);
  }

  /** A destroyed machine breaking down before it explodes (see Game.updateWrecks): no pilot, only gravity. `k` runs 0..1. */
  updateWreck(dt, k) {
    this.knock = null;
    this.thrusting = false;
    this.dashT = 0;
    const lambda = this.grounded ? 5 : 0.8;
    this.vel.x = damp(this.vel.x, 0, lambda, dt);
    this.vel.z = damp(this.vel.z, 0, lambda, dt);
    if (!this.grounded || this.vel.y > 0) this.vel.y = Math.max(this.vel.y - GRAVITY * dt, -MAX_FALL);
    this._integrate(dt);
    this._syncModel(dt, { dying: Math.max(0.001, k) });
  }

  _syncModel(dt, it) {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;

    const sx = Math.sin(this.yaw), cz = Math.cos(this.yaw);
    const localFwd = -this.vel.x * sx - this.vel.z * cz;
    const localRight = this.vel.x * cz - this.vel.z * sx;
    this.model.update(dt, {
      speed: Math.hypot(this.vel.x, this.vel.z),
      localFwd, localRight,
      grounded: this.grounded,
      vy: this.vel.y,
      dash: this.dashT > 0 ? this.dashT / this.def.dashTime : 0,
      turnRate: this.turnRate,
      relaxed: !!it.relaxed,
      boost: it.boost ?? (this.thrusting ? 1 : this.grounded ? 0 : 0.12),
      pitch: this.pitch,
      aimYaw: this.aimYaw ?? 0,
      attack: it.attack ?? null,
      stagger: this.knock ? 0 : clamp(this.stagger / 0.5, 0, 1),
      charge: it.charge ?? 0,
      jumpCrouch: this.jumpT > 0 ? 1 - this.jumpT / JUMP_CROUCH : 0,
      skid: this.skidT / SKID_TIME,
      knock: this.knock,
      dying: it.dying ?? 0,
      launch: it.launch ?? 0,
    });

    // a skid scrapes sparks and dust from the heels
    if (this.skidT > 0 && this.grounded && Math.random() < 0.6) {
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (sp > 40) {
        const s = this.spec.scale;
        const side = Math.random() < 0.5 ? -1 : 1;
        const p = this._trail.set(this.pos.x + cz * side * 2 * s, this.pos.y + 0.4, this.pos.z - sx * side * 2 * s);
        this.game.fx.sparks(p, null, 2, [1, 0.75, 0.4]);
        if (Math.random() < 0.5) this.game.fx.dust(p, 2, 6);
      }
    }

    // hit flash over any steady tint
    const f = this.flashT > 0 ? (this.flashT / 0.12) * 0.7 : 0;
    const t = this.tintColor;
    if (f > 0 || t || this._wasTinted) {
      this.model.tint(Math.max(f, t ? t[0] : 0), Math.max(f, t ? t[1] : 0), Math.max(f, t ? t[2] : 0));
      this._wasTinted = f > 0 || !!t;
    }

    // exhaust glow trail while thrusting
    if (this.thrusting && Math.random() < 0.9) {
      const s = this.spec.scale;
      const b = this._trail.set(this.pos.x + sx * 3.5 * s, this.pos.y + 12 * s, this.pos.z + cz * 3.5 * s);
      this.game.fx.exhaust(b, { x: this.vel.x * 0.1 + rand(-3, 3), y: rand(-6, 0), z: this.vel.z * 0.1 + rand(-3, 3) }, this.spec.palette.flame, 3.2 * s);
    }
  }

  // ------------------------------------------------------------------ damage

  /**
   * Returns the damage actually dealt (0 if ignored). `info.knock` is a world-space velocity kick;
   * `info.stagger` forces an interrupt regardless of damage size.
   */
  takeDamage(amount, info = {}) {
    if (this.dead || this.invuln > 0 || amount <= 0) return 0;
    if (this.team === 'player' && this.game.cheat.invincible) return 0;
    // a shield soaks a share of everything except saber hits
    if (this.def.guard && info.kind && info.kind !== 'saber') amount *= 1 - this.def.guard;
    if (this.barrierMax > 0) {
      this.barrierHitAt = this.game.time; // any hit restarts the recharge delay
      if (this.barrier > 0) {
        const soaked = Math.min(this.barrier, amount);
        this.barrier -= soaked;
        amount -= soaked;
        this.lastHitAt = this.game.time;
        this.game.onBarrierHit(this, soaked, info);
        if (amount <= 0) return 0;
      }
    }
    if (this.parts.length) amount = this._hitParts(amount, info);
    if (this.team === 'player' && this.game.mode === 'range') amount = Math.min(amount, Math.max(0, this.hp - 1)); // the test range cannot destroy you
    this.hp -= amount;
    this.flashT = 0.12;
    this.lastHitAt = this.game.time; // the nano-repair core waits for a lull

    if (info.knock) this.vel.addScaledVector(info.knock, this.def.boss ? 0.3 : 1);
    if (amount >= this.def.staggerAt || (info.stagger && this.def.staggerAt !== Infinity)) {
      this.stagger = Math.max(this.stagger, info.stagger ? 0.55 : 0.4);
      this.dashT = 0;
    }
    if (info.down) this.knockDown();
    this._flinch(amount, info);
    this.game.onDamaged(this, amount, info);
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.game.onDestroyed(this, info);
    }
    return amount;
  }

  /**
   * A hit that lands near a part is shared with it: the part soaks a share and, once it is out of health, comes off.
   * Returns what is left for the body. A saber stroke or a collapse has no clear point, so it sometimes takes a part at random.
   */
  _hitParts(amount, info) {
    let hit = null;
    if (info.kind === 'saber' || info.kind === 'collapse' || info.kind === 'pulse' || !info.point) {
      const alive = this.parts.filter((p) => !p.broken);
      if (alive.length && info.kind !== 'pulse' && Math.random() < PART_BLIND) hit = alive[Math.floor(Math.random() * alive.length)];
    } else {
      let best = PART_REACH * this.spec.scale;
      for (const p of this.parts) {
        if (p.broken) continue;
        const d = this.model.partDistance(p.slot, info.point);
        if (d < best) { best = d; hit = p; }
      }
    }
    if (!hit) return amount;
    const share = amount * PART_SHARE;
    hit.hp -= share;
    if (hit.hp > 0) return amount - share;
    const over = -hit.hp;
    hit.hp = 0;
    this._breakPart(hit, info);
    return amount - share + over;
  }

  /** A part's health ran out: it comes off the model (see Game.onPartBroken for the sparks, the chunk and the stats). */
  _breakPart(part, info) {
    part.broken = true;
    this.game.onPartBroken(this, part, info);
  }

  /** Put every torn-off part back and give them all full health (the pit stop). Returns how many were replaced. */
  restoreParts() {
    let n = 0;
    for (const p of this.parts) {
      if (p.broken) { this.model.restorePart(p.slot); n++; }
      p.broken = false;
      p.hp = p.maxHp;
    }
    return n;
  }

  /** The model's hit reaction: which way the blow pushed us (in our own frame) and how hard, against what staggers us. */
  _flinch(amount, info) {
    let px = 0, pz = 0;
    if (info.knock && (info.knock.x || info.knock.z)) { px = info.knock.x; pz = info.knock.z; }
    else if (info.source) { px = this.pos.x - info.source.pos.x; pz = this.pos.z - info.source.pos.z; }
    const len = Math.hypot(px, pz);
    if (len < 1e-6) { px = 0; pz = 1; } else { px /= len; pz /= len; }
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const ref = Number.isFinite(this.def.staggerAt) ? this.def.staggerAt : 600;
    this.model.hit(px * c - pz * s, px * s + pz * c, clamp(amount / ref, 0.12, 1));
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  /** Does the segment a→b, thickened by `radius`, touch this mech's body capsule? */
  hitBySegment(ax, ay, az, bx, by, bz, radius) {
    const s = this.spec.scale;
    const r = this.radius * 0.92 + radius;
    const d2 = segSegDistSq(ax, ay, az, bx, by, bz,
      this.pos.x, this.pos.y + 3.5 * s, this.pos.z, this.pos.x, this.pos.y + 14.5 * s, this.pos.z);
    return d2 <= r * r;
  }

  /** Remove from the scene and free this mech's materials (geometry is shared, so it stays). */
  destroy() {
    this.game.fx.dropGhosts(this);
    this.game.scene.remove(this.root);
    this.root.traverse((o) => { o.material?.map?.dispose?.(); o.material?.dispose?.(); }); // (tank belts carry their own scrolling texture)
  }
}
