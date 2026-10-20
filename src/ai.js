// Enemy pilots. Each one drives a Mech through the same intent interface the player uses.
//   Drone    mono-eye grunt: keeps its distance and fires 3-round bursts
//   Striker  fast blade fighter: dashes in for a three-hit sabre combo, then backs off
//   Bulwark  slow artillery: telegraphs, then lobs a splash cannon shell
//   Baron    boss ace: rifle volleys, rushes with sabre combos, missile salvos, dodges your shots

import * as THREE from 'three';
import { Mech } from './mech.js';
import { angleDiff, clamp, pick, rand, randSign, yawToward } from './util.js';

const SLASHES = ['slash1', 'slash2', 'slash3'];
const DODGEABLE = new Set(['beam', 'bullet', 'cannon']);

class Enemy {
  constructor(game, type, skill = 1) {
    this.game = game;
    this.type = type;
    this.skill = skill; // grows with the wave number: tighter aim, shorter cooldowns
    this.mech = new Mech(game, type, 'enemy');
    this.mech.enemy = this;

    this.t = 0;
    this.strafe = randSign();
    this.strafeT = rand(1.5, 3.5);
    this.hopT = 0;
    this.dodgeCd = rand(0, 1);
    this.stunned = 0;

    this._to = new THREE.Vector3();
    this._muz = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  get target() {
    return this.game.player.mech;
  }

  update(dt) {
    const m = this.mech;
    if (m.dead) return;
    const p = this.target;
    this.t += dt;

    this._to.set(p.pos.x - m.pos.x, 0, p.pos.z - m.pos.z);
    this.dist = this._to.length();
    if (this.dist > 1e-3) this._to.divideScalar(this.dist);

    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafe = -this.strafe;
      this.strafeT = rand(1.5, 3.5);
    }

    const it = p.dead ? { faceYaw: m.yaw } : this.think(dt) ?? {};
    if (!p.dead) {
      this._dodge(dt, it);
      this._hop(dt, it);
    }
    m.update(dt, it);
  }

  // ------------------------------------------------------------------ shared behaviours

  /** Move to hold a band of distances, strafing around the target and avoiding crowding. */
  steer(minR, maxR, strafeAmt = 0.85) {
    const m = this.mech;
    const to = this._to;
    const radial = this.dist > maxR ? 1 : this.dist < minR ? -1 : 0;
    let x = to.x * radial;
    let z = to.z * radial;
    const s = strafeAmt * (radial === 0 ? 1 : 0.6) * this.strafe;
    x += -to.z * s;
    z += to.x * s;
    for (const e of this.game.enemies) {
      if (e === this || e.mech.dead) continue;
      const dx = m.pos.x - e.mech.pos.x, dz = m.pos.z - e.mech.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 32 && d > 0.01) { x += (dx / d) * (1 - d / 32) * 1.5; z += (dz / d) * (1 - d / 32) * 1.5; }
    }
    return { moveX: x, moveZ: z };
  }

  /** Boost over buildings that block the way, or climb toward a target far above. */
  _hop(dt, it) {
    const m = this.mech;
    this.hopT = Math.max(0, this.hopT - dt);
    if (m.blocked > 0 && m.grounded && (it.moveX || it.moveZ)) this.hopT = 0.9;
    const p = this.target;
    if (p.pos.y - m.pos.y > 30 && this.dist < 160) this.hopT = Math.max(this.hopT, 0.3);
    if (this.hopT > 0 && !m.overheat) it.ascend = true;
  }

  /** React to an incoming shot (beam, bullet or shell) by dashing sideways. */
  _dodge(dt, it) {
    const m = this.mech;
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    const chance = this.def_dodge ?? 0;
    if (chance <= 0 || this.dodgeCd > 0 || it.dash || m.dashT > 0 || m.stagger > 0) return;
    for (const pr of this.game.projectiles.list) {
      if (pr.team === m.team || !DODGEABLE.has(pr.type)) continue; // beams, bullet streams and shells; not homing missiles
      const to = m.center(this._tmp).sub(pr.pos);
      const d = to.length();
      if (d > 170 || d < 25) continue;
      if (pr.dir.dot(to.divideScalar(d)) < 0.985) continue;
      this.dodgeCd = 1.1;
      if (Math.random() < chance) {
        const side = randSign();
        it.dash = new THREE.Vector3(pr.dir.z * side, 0, -pr.dir.x * side);
        it.moveX = it.moveZ = 0;
      }
      return;
    }
  }

  /** Direction from the muzzle to the target, with lead and a random cone of error. */
  aim(speed, lead = 0.7, spread = 0.05) {
    const m = this.mech;
    const p = this.target;
    m.model.muzzleWorld(this._muz);
    const c = p.center(this._dir);
    const t = c.distanceTo(this._muz) / speed;
    c.addScaledVector(p.vel, t * lead);
    const dir = c.sub(this._muz).normalize();
    const s = spread / this.skill;
    dir.x += rand(-s, s); dir.y += rand(-s, s); dir.z += rand(-s, s);
    return dir.normalize();
  }

  fire(opts) {
    const dir = this.aim(opts.speed, opts.lead ?? 0.7, opts.spread ?? 0.05).clone();
    this.game.projectiles.spawn({ team: 'enemy', source: this.mech, pos: this._muz, dir, ...opts, target: opts.target ?? null });
  }

  /** Resolve a sabre hit on the player: a close, in-front check. Returns true on contact. */
  meleeHit(damage, reach, stagger = false) {
    const m = this.mech;
    const p = this.target;
    const v = this._tmp.set(p.pos.x - m.pos.x, 0, p.pos.z - m.pos.z);
    const d = v.length();
    if (d > reach + p.radius + m.radius * 0.5 || Math.abs(p.pos.y - m.pos.y) > 22) return false;
    if (d > 1e-3 && v.divideScalar(d).dot(m.forward()) < 0.1) return false;
    const knock = v.clone().multiplyScalar(stagger ? 90 : 40);
    const dealt = p.takeDamage(damage, { source: m, knock, stagger, kind: 'saber', point: p.center(new THREE.Vector3()) });
    if (dealt > 0) {
      this.game.fx.sparks(p.center(new THREE.Vector3()), m.forward(), 20, [1, 0.6, 0.9]);
      this.game.audio.saberHit(p.pos);
      this.game.shake(0.8);
    }
    return true;
  }

  faceTarget() {
    return yawToward(this.mech.pos.x, this.mech.pos.z, this.target.pos.x, this.target.pos.z);
  }

  /** Dash toward (+1) or away from (-1) the target. */
  dashDirection(sign = 1) {
    return new THREE.Vector3(this._to.x * sign, 0, this._to.z * sign);
  }
}

// ==================================================================== Drone

class Drone extends Enemy {
  constructor(game, skill) {
    super(game, 'drone', skill);
    this.def_dodge = 0.2 * skill;
    this.cd = rand(0.8, 2.2);
    this.burst = 0;
    this.burstT = 0;
    this.repoT = rand(3, 6);
  }

  think(dt) {
    const m = this.mech;
    const it = this.steer(75, 150);
    it.faceYaw = this.faceTarget();
    it.pitch = 0;

    this.cd -= dt;
    this.repoT -= dt;
    if (this.repoT <= 0 && m.en > 60) {
      this.repoT = rand(4, 7);
      it.dash = new THREE.Vector3(-this._to.z * this.strafe, 0, this._to.x * this.strafe);
    }

    if (this.burst > 0) {
      this.burstT -= dt;
      if (this.burstT <= 0 && m.stagger <= 0) {
        this.burstT = 0.12;
        this.burst--;
        this.fire({ type: 'bullet', speed: 420, damage: 24, color: 0xffb040, spread: 0.04 });
        this.game.audio.gun(m.pos);
      }
    } else if (this.cd <= 0 && this.dist < 230 && m.stagger <= 0) {
      const face = Math.abs(angleDiff(m.yaw, it.faceYaw));
      if (face < 0.4) {
        this.burst = 3;
        this.burstT = 0;
        this.cd = rand(1.4, 2.5) / this.skill;
      }
    }
    return it;
  }
}

// ==================================================================== Striker

class Striker extends Enemy {
  constructor(game, skill) {
    super(game, 'striker', skill);
    this.def_dodge = 0.45 * skill;
    this.mode = 'approach';
    this.modeT = 0;
    this.combo = null;
    this.mgCd = rand(1, 2);
    this.mgLeft = 0;
    this.mgT = 0;
  }

  think(dt) {
    const m = this.mech;
    const faceYaw = this.faceTarget();
    this.modeT += dt;
    let it;

    if (this.mode === 'approach') {
      it = this.steer(10, 26, 0.5);
      it.faceYaw = faceYaw;
      // dash across the gap when far away
      if (this.dist > 70 && m.en >= m.def.dashCost + 5 && m.dashCd <= 0 && m.grounded) it.dash = this.dashDirection(1);
      if (this.dist < 34) this._startCombo();
      else if (this.dist > 55) this._gunfire(it, dt);
    } else if (this.mode === 'slash') {
      it = this._slash(dt, faceYaw);
    } else {
      // retreat: back away, strafe and pepper the player
      it = this.steer(70, 110, 1);
      it.faceYaw = faceYaw;
      this._gunfire(it, dt);
      if (this.modeT > rand(1.6, 2.6)) { this.mode = 'approach'; this.modeT = 0; }
    }
    return it;
  }

  _gunfire(it, dt) {
    const m = this.mech;
    this.mgCd -= dt;
    if (this.mgLeft > 0) {
      this.mgT -= dt;
      if (this.mgT <= 0 && m.stagger <= 0) {
        this.mgT = 0.14;
        this.mgLeft--;
        this.fire({ type: 'bullet', speed: 400, damage: 16, color: 0xd9a0ff, spread: 0.06 });
        this.game.audio.gun(m.pos);
      }
    } else if (this.mgCd <= 0 && this.dist < 200 && Math.abs(angleDiff(m.yaw, this.faceTarget())) < 0.4) {
      this.mgLeft = 3;
      this.mgT = 0;
      this.mgCd = rand(2, 3.4) / this.skill;
    }
    it.pitch = 0;
  }

  _startCombo() {
    this.mode = 'slash';
    this.modeT = 0;
    this.combo = { i: 0, t: 0, hit: false, arc: false };
    this.mech.setSaber(true);
    this.game.audio.slash(this.mech.pos);
  }

  _slash(dt, faceYaw) {
    const m = this.mech;
    const c = this.combo;
    const dur = c.i === 2 ? 0.75 : 0.55;
    c.t += dt;
    const p = c.t / dur;
    const it = { faceYaw, attack: { kind: SLASHES[c.i], t: Math.min(1, p) }, hover: true, moveX: 0, moveZ: 0 };
    if (p < 0.4 && this.dist > 12) {
      it.velocity = this._tmp.set(this._to.x * 190, 0, this._to.z * 190).clone();
    }
    if (!c.arc && p >= 0.28) {
      c.arc = true;
      this.game.fx.slashArc(m, SLASHES[c.i], 0xb26bff);
      this.game.audio.slash(m.pos);
    }
    if (!c.hit && p >= 0.45) {
      c.hit = true;
      this.meleeHit(c.i === 2 ? 340 : 230, 26, c.i === 2);
    }
    if (p >= 1) {
      c.i++;
      c.t = 0; c.hit = false; c.arc = false;
      if (c.i >= SLASHES.length || this.dist > 48) {
        this.combo = null;
        this.mode = 'retreat';
        this.modeT = 0;
        m.setSaber(false);
        this.strafe = randSign();
      }
    }
    // staggered mid-combo: abort
    if (m.stagger > 0 && this.mode === 'slash') {
      this.combo = null;
      this.mode = 'retreat';
      this.modeT = 0;
      m.setSaber(false);
    }
    return it;
  }
}

// ==================================================================== Bulwark

class Bulwark extends Enemy {
  constructor(game, skill) {
    super(game, 'bulwark', skill);
    this.def_dodge = 0;
    this.cd = rand(2, 4);
    this.chargeT = 0;
    this.charging = false;
  }

  think(dt) {
    const m = this.mech;
    const faceYaw = this.faceTarget();
    const it = this.charging ? { moveX: 0, moveZ: 0 } : this.steer(120, 210, 0.5);
    it.faceYaw = faceYaw;

    // pitch the cannon at the target
    const c = this.target.center(this._tmp);
    it.pitch = Math.atan2(c.y - (m.pos.y + 12), this.dist);

    if (this.charging) {
      this.chargeT += dt;
      it.charge = clamp(this.chargeT / 1.1, 0, 1);
      if (m.stagger > 0) { this.charging = false; this.chargeT = 0; this.cd = 2; }
      else if (this.chargeT >= 1.1) {
        this.charging = false;
        this.chargeT = 0;
        this.cd = rand(4, 6) / this.skill;
        this.fire({
          type: 'cannon', speed: 250, damage: 220, color: 0xff9030, lead: 0.9, spread: 0.02, radius: 3.4,
          splash: { radius: 24, damage: 120 }, knock: 40,
        });
        this.game.audio.cannon(m.pos);
        this.game.shakeFrom(m.pos, 0.4, 300);
      }
    } else {
      this.cd -= dt;
      if (this.cd <= 0 && this.dist < 330 && m.stagger <= 0 && Math.abs(angleDiff(m.yaw, faceYaw)) < 0.3) {
        this.charging = true;
        this.chargeT = 0;
        this.game.audio.alert();
      }
    }
    return it;
  }
}

// ==================================================================== Baron (boss)

class Baron extends Enemy {
  constructor(game, skill) {
    super(game, 'baron', skill);
    this.def_dodge = 0.4;
    this.mode = 'volley';
    this.modeT = 0;
    this.volleyShots = 0;
    this.shotT = 0;
    this.combo = null;
    this.rushDashes = 0;
    this.salvo = 0;
    this.salvoT = 0;
    this.next = ['volley', 'rush'];
  }

  get phase() {
    const r = this.mech.hp / this.mech.maxHp;
    return r > 0.66 ? 1 : r > 0.33 ? 2 : 3;
  }

  _choose() {
    const phase = this.phase;
    const pool = ['volley', 'rush', 'evade'];
    if (phase >= 2) pool.push('missiles', 'rush');
    if (phase >= 3) pool.push('rush', 'volley');
    let mode = pick(pool);
    if (mode === this.mode) mode = pick(pool);
    this.mode = mode;
    this.modeT = 0;
    this.volleyShots = 0;
    this.salvo = 0;
    this.rushDashes = 2;
    this.combo = null;
    this.mech.setSaber(false);
    this.strafe = randSign();
    if (mode === 'missiles') this.game.audio.alert();
  }

  think(dt) {
    const m = this.mech;
    const faceYaw = this.faceTarget();
    this.modeT += dt;
    const enraged = this.phase === 3;
    m.tintColor = enraged ? [0.25 + 0.15 * Math.sin(this.t * 8), 0.02, 0.02] : null;
    let it;

    switch (this.mode) {
      case 'volley': {
        it = this.steer(95, 170, 1);
        it.faceYaw = faceYaw;
        it.pitch = 0;
        this.shotT -= dt;
        const total = enraged ? 6 : 3;
        if (this.shotT <= 0 && this.volleyShots < total && m.stagger <= 0 && this.modeT > 0.4) {
          this.shotT = enraged ? 0.22 : 0.3;
          this.volleyShots++;
          this.fire({ type: 'beam', speed: 700, damage: 110, color: 0xff3a6a, lead: 0.7, spread: 0.03, knock: 10 });
          this.game.audio.beam(m.pos);
        }
        if (this.volleyShots >= total && this.modeT > 1.8) this._choose();
        break;
      }
      case 'rush': {
        it = this.steer(8, 22, 0.3);
        it.faceYaw = faceYaw;
        if (this.dist > 55 && this.rushDashes > 0 && m.dashCd <= 0 && m.en >= m.def.dashCost) {
          it.dash = this.dashDirection(1);
          this.rushDashes--;
        }
        if (this.dist < 36) this._startCombo();
        else if (this.modeT > 6) this._choose();
        if (this.combo) it = this._slash(dt, faceYaw);
        break;
      }
      case 'missiles': {
        it = this.steer(110, 190, 0.6);
        it.faceYaw = faceYaw;
        it.charge = clamp(this.modeT / 0.9, 0, 1);
        if (this.modeT > 0.9) {
          this.salvoT -= dt;
          if (this.salvoT <= 0 && this.salvo < (enraged ? 8 : 6)) {
            this.salvoT = 0.1;
            this.salvo++;
            this._fireMissile(this.salvo % 2 ? 1 : -1);
          }
          if (this.salvo >= (enraged ? 8 : 6) && this.modeT > 2.4) this._choose();
        }
        break;
      }
      default: {
        // evade: reposition quickly, sometimes climbing
        it = this.steer(120, 200, 1);
        it.faceYaw = faceYaw;
        if (this.modeT < 0.1 && m.dashCd <= 0) it.dash = new THREE.Vector3(-this._to.z * this.strafe, 0, this._to.x * this.strafe);
        if (this.modeT > 0.2 && this.modeT < 1.0) it.ascend = true;
        if (this.modeT > 1.6) this._choose();
      }
    }
    if (m.stagger > 0 && this.combo) { this.combo = null; m.setSaber(false); this._choose(); }
    return it;
  }

  _fireMissile(side) {
    const m = this.mech;
    const right = this._tmp.set(Math.cos(m.yaw), 0, -Math.sin(m.yaw));
    const pos = new THREE.Vector3(m.pos.x, m.pos.y + 20, m.pos.z).addScaledVector(right, side * 6);
    const dir = new THREE.Vector3(0, 1, 0).addScaledVector(right, side * rand(0.15, 0.5)).addScaledVector(m.forward(), 0.5).normalize();
    this.game.projectiles.spawn({
      type: 'missile', team: 'enemy', source: m, pos, dir, color: 0xff6040,
      damage: 80, speed: 90, maxSpeed: 230, delay: 0.4, turn: 3.0, target: this.target,
      splash: { radius: 18, damage: 45 }, knock: 20,
    });
    this.game.audio.missile(pos);
  }

  _startCombo() {
    if (this.combo) return;
    this.combo = { i: 0, t: 0, hit: false, arc: false };
    this.mech.setSaber(true);
    this.game.audio.slash(this.mech.pos);
  }

  _slash(dt, faceYaw) {
    const m = this.mech;
    const c = this.combo;
    const dur = c.i === 2 ? 0.62 : 0.42;
    c.t += dt;
    const p = c.t / dur;
    const it = { faceYaw, attack: { kind: SLASHES[c.i], t: Math.min(1, p) }, hover: true, moveX: 0, moveZ: 0 };
    if (p < 0.4 && this.dist > 10) it.velocity = new THREE.Vector3(this._to.x * 230, 0, this._to.z * 230);
    if (!c.arc && p >= 0.28) {
      c.arc = true;
      this.game.fx.slashArc(m, SLASHES[c.i], 0xff4040);
      this.game.audio.slash(m.pos);
    }
    if (!c.hit && p >= 0.45) {
      c.hit = true;
      this.meleeHit(c.i === 2 ? 380 : 240, 32, c.i === 2);
    }
    if (p >= 1) {
      c.i++;
      c.t = 0; c.hit = false; c.arc = false;
      if (c.i >= SLASHES.length || this.dist > 55) {
        this.combo = null;
        m.setSaber(false);
        this._choose();
        this.mode = 'evade';
      }
    }
    return it;
  }
}

export function createEnemy(game, type, skill) {
  switch (type) {
    case 'drone': return new Drone(game, skill);
    case 'striker': return new Striker(game, skill);
    case 'bulwark': return new Bulwark(game, skill);
    case 'baron': return new Baron(game, skill);
    default: throw new Error(`unknown enemy type: ${type}`);
  }
}
