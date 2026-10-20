// A mech's body: movement physics (walk, boost-ascend, dash), world collision, damage and the
// hand-off to the visual model. Players and AI both drive it by passing an `intent` to update().

import * as THREE from 'three';
import { MECHS } from './data.js';
import { buildMech, MECH_HEIGHT } from './mechModel.js';
import { ARENA } from './world.js';
import { clamp, damp, dampAngle, lerp, rand, segSegDistSq } from './util.js';

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
 */
export class Mech {
  constructor(game, type, team) {
    this.game = game;
    this.type = type;
    this.team = team;
    this.def = MECHS[type];
    this.spec = this.def.spec;

    this.model = buildMech(this.spec);
    this.root = this.model.root;
    this.root.scale.setScalar(this.spec.scale);
    game.scene.add(this.root);

    const s = this.spec.scale;
    this.radius = 5.5 * s;
    this.height = MECH_HEIGHT * s;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

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
    this.dead = false;
    this.saberOut = false;
    this.tintColor = null; // [r, g, b] steady glow, e.g. burst aura

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
    this.flashT = Math.max(0, this.flashT - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.enDelay = Math.max(0, this.enDelay - dt);

    const staggered = this.stagger > 0;
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
    } else {
      // ---- horizontal
      const top = (this.grounded ? def.speed : def.airSpeed) * speedMul;
      const lambda = staggered ? 1.5 : this.grounded ? 11 : mx || mz ? 3.2 : 1.2;
      this.vel.x = damp(this.vel.x, mx * top, lambda, dt);
      this.vel.z = damp(this.vel.z, mz * top, lambda, dt);

      // ---- vertical
      if (it.ascend && !this.overheat && this.en > 0 && !staggered) {
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

    // ---- integrate & collide
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

    // ---- facing
    let faceYaw = it.faceYaw;
    if (faceYaw === undefined && (mx || mz)) faceYaw = Math.atan2(-mx, -mz);
    if (faceYaw !== undefined) this.yaw = dampAngle(this.yaw, faceYaw, def.turn, dt);
    this.pitch = damp(this.pitch, it.pitch ?? 0, 10, dt);

    this._syncModel(dt, it);
  }

  _landed(speed) {
    this.game.fx.dust(this.pos, Math.min(16, 6 + speed / 10), 18);
    if (speed > 70) this.game.shakeFrom(this.pos, 0.25, 200);
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
      boost: this.thrusting ? 1 : this.grounded ? 0 : 0.12,
      pitch: this.pitch,
      attack: it.attack ?? null,
      stagger: clamp(this.stagger / 0.5, 0, 1),
      charge: it.charge ?? 0,
    });

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
    this.hp -= amount;
    this.flashT = 0.12;

    if (info.knock) this.vel.addScaledVector(info.knock, this.def.boss ? 0.3 : 1);
    if (amount >= this.def.staggerAt || (info.stagger && this.def.staggerAt !== Infinity)) {
      this.stagger = Math.max(this.stagger, info.stagger ? 0.55 : 0.4);
      this.dashT = 0;
    }
    this.game.onDamaged(this, amount, info);
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.game.onDestroyed(this, info);
    }
    return amount;
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
    this.game.scene.remove(this.root);
    this.root.traverse((o) => o.material?.dispose?.());
  }
}
