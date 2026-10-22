// Enemy pilots. Each one drives a Mech through the same intent interface the player uses.
//   Drone    mono-eye grunt: keeps its distance and fires 3-round bursts
//   Striker  fast blade fighter: dashes in for a three-hit sabre combo, then backs off
//   Bulwark  slow artillery: telegraphs, then lobs a splash cannon shell
//   Baron    boss ace: rifle volleys, rushes with sabre combos, missile salvos, dodges your shots

import * as THREE from 'three';
import { Mech } from './mech.js';
import { DUMMY_DEF, riggedOf } from './rigged.js';
import { angleDiff, clamp, pick, rand, randSign, yawToward } from './util.js';

const SLASHES = ['slash1', 'slash2', 'slash3'];
const DODGEABLE = new Set(['beam', 'bullet', 'cannon']);
const FIRING_LIMBS = new Set(['gun', 'cannon', 'shotgun', 'rail']); // the arm weapons a rigged enemy fires

class Enemy {
  /** `def` is for machines that are not in data.js: the rigged enemies and the practice dummy (see rigged.js). */
  constructor(game, type, skill = 1, def = null) {
    this.game = game;
    this.type = type;
    this.skill = skill; // grows with the wave number: tighter aim, shorter cooldowns
    this.mech = new Mech(game, type, 'enemy', def);
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
    this.mech.model.recoil(opts.type === 'cannon' ? 1 : opts.type === 'bullet' ? 0.15 : 0.4);
  }

  /** Resolve a sabre hit on the player: a close, in-front check. Returns true on contact. A staggering blow (a combo's last) knocks down. */
  meleeHit(damage, reach, stagger = false) {
    const m = this.mech;
    const p = this.target;
    this.game.destruction.slash(m, reach, damage * 0.8); // a swing that reaches a wall cuts into it, whoever is in front
    const v = this._tmp.set(p.pos.x - m.pos.x, 0, p.pos.z - m.pos.z);
    const d = v.length();
    if (d > reach + p.radius + m.radius * 0.5 || Math.abs(p.pos.y - m.pos.y) > 22) return false;
    if (d > 1e-3 && v.divideScalar(d).dot(m.forward()) < 0.1) return false;
    const knock = v.clone().multiplyScalar(stagger ? 90 : 40);
    const dealt = p.takeDamage(damage, { source: m, knock, stagger, down: stagger, kind: 'saber', point: p.center(new THREE.Vector3()) });
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

// ==================================================================== Dummy (the test range)

class Dummy extends Enemy {
  constructor(game, skill) {
    super(game, 'dummy', skill, DUMMY_DEF);
    this.home = null; // where it was put: a knock sends it sliding, and it walks back
  }

  _hop() {} // it never climbs after you
  _dodge() {}

  think(dt) {
    const m = this.mech;
    this.home ??= { x: m.pos.x, z: m.pos.z };
    // it mends itself once left alone, so the range is always ready for the next test
    if (m.hp < m.maxHp && this.game.time - m.lastHitAt > 3) m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.4 * dt);
    const dx = this.home.x - m.pos.x, dz = this.home.z - m.pos.z;
    const d = Math.hypot(dx, dz);
    const it = { faceYaw: this.faceTarget() };
    if (d > 4) { it.moveX = dx / d; it.moveZ = dz / d; it.speedMul = 0.5; }
    return it;
  }
}

// ==================================================================== Rigged (built from the garage's rig)
//   Crawler  six legs and four arm guns: closes to mid range and fires in bursts from every barrel
//   Hydra    three heads, missile pods and a heavy rifle: keeps its distance, shoots missiles down with the chest vulcan
// Each gun is a part with health of its own: shoot an arm (or a pod) off and that weapon is gone.

const RIG_AI = {
  crawler: {
    band: [55, 130], strafe: 1.1, range: 230, volley: [1.2, 1.9], gunMul: 0.27, dodge: 0.12, color: 0xff9a30,
    main: { type: 'bullet', speed: 420, damage: 6, interval: 0.22, spread: 0.06, color: 0xff9a30 },
  },
  hydra: {
    band: [110, 210], strafe: 0.5, range: 340, volley: [1.6, 1.5], gunMul: 0.5, dodge: 0.05, color: 0x5dffa5,
    main: { type: 'beam', speed: 560, damage: 70, interval: 1.5, spread: 0.03, color: 0x5dffa5, knock: 10 },
    missiles: { perPod: 2, damage: 45, every: 9 },
  },
};

class Rigged extends Enemy {
  constructor(game, type, skill) {
    const r = riggedOf(type);
    super(game, type, skill, r.def);
    this.cfg = RIG_AI[type];
    this.def_dodge = this.cfg.dodge * skill;
    const limbs = this.mech.model.rig.limbs;
    this.guns = r.stats.limbs
      .filter((l) => FIRING_LIMBS.has(l.kind))
      .map((def) => ({ def, slot: def.slot, idx: limbs.findIndex((l) => l.slot === def.slot), cd: rand(0.2, 1), broken: false }));
    this.turrets = r.stats.turrets.map((def) => ({ def, slot: def.slot, cd: rand(0, def.interval), broken: false }));
    this.pods = new Set(['podL', 'podR'].filter((slot) => r.build[slot] === 'missile'));
    this.legsLost = 0;
    this.volleyOn = false;
    this.volleyT = rand(0.5, 1.5);
    this.mainCd = rand(0.4, 1.2);
    this.missileCd = this.cfg.missiles ? rand(3, 5) : Infinity;
    this._a = new THREE.Vector3();
  }

  /** A part was shot off (see Game.onPartBroken): its weapon goes with it, and a lost leg slows the machine. */
  onPartBroken(part) {
    for (const g of this.guns) if (g.slot === part.slot) g.broken = true;
    for (const t of this.turrets) if (t.slot === part.slot) t.broken = true;
    this.pods.delete(part.slot);
    if (part.kind === 'leg') this.legsLost++;
  }

  think(dt) {
    const m = this.mech, cfg = this.cfg;
    const it = this.steer(cfg.band[0], cfg.band[1], cfg.strafe);
    it.faceYaw = this.faceTarget();
    it.speedMul = Math.pow(0.88, this.legsLost);
    const c = this.target.center(this._a);
    it.pitch = clamp(Math.atan2(c.y - (m.pos.y + m.height * 0.6), Math.max(20, this.dist)), -0.5, 0.6);

    this._turrets(dt);
    this.mainCd -= dt;
    this.missileCd -= dt;
    for (const g of this.guns) g.cd = Math.max(0, g.cd - dt);
    if (m.stagger > 0) return it; // reeling from a hit: nothing fires

    this.volleyT -= dt;
    if (this.volleyT <= 0) {
      this.volleyOn = !this.volleyOn;
      this.volleyT = this.volleyOn ? cfg.volley[0] : (cfg.volley[1] * rand(0.8, 1.3)) / this.skill;
    }
    const facing = Math.abs(angleDiff(m.yaw, it.faceYaw)) < 0.5;
    if (this.volleyOn && facing && this.dist < cfg.range) {
      for (const g of this.guns) if (!g.broken && g.cd <= 0) this._fireGun(g);
      if (cfg.main && this.mainCd <= 0) {
        this.fire(cfg.main);
        this.mainCd = (cfg.main.interval * rand(1, 1.4)) / this.skill;
        this.game.audio[cfg.main.type === 'beam' ? 'beam' : 'gun'](m.pos);
      }
    }
    if (cfg.missiles && this.missileCd <= 0 && this.pods.size > 0 && this.dist > 60) this._salvo();
    return it;
  }

  /** One arm gun: from its own muzzle, with a little lead and a lot of spread. */
  _fireGun(g) {
    const m = this.mech;
    m.model.limbMuzzleWorld(g.idx, this._muz);
    const speed = g.def.speed ?? 420;
    const c = this.target.center(this._dir);
    c.addScaledVector(this.target.vel, (c.distanceTo(this._muz) / speed) * 0.6);
    const dir = c.sub(this._muz).normalize();
    const s = 0.05 / this.skill;
    dir.x += rand(-s, s); dir.y += rand(-s, s); dir.z += rand(-s, s);
    dir.normalize();
    this.game.projectiles.spawn({
      type: 'bullet', team: 'enemy', source: m, pos: this._muz, dir, damage: g.def.damage * this.cfg.gunMul, color: this.cfg.color, speed,
    });
    m.model.fireLimb(g.idx, 0.3);
    if (Math.random() < 0.3) this.game.audio.gun(this._muz);
    g.cd = g.def.interval * rand(1, 1.5);
  }

  /** The tail gun and the pods fire on their own at the player; the chest vulcan only shoots down missiles. */
  _turrets(dt) {
    const m = this.mech, game = this.game;
    for (const t of this.turrets) {
      t.cd = Math.max(0, t.cd - dt);
      if (t.broken || m.dead) continue;
      m.model.turretMuzzleWorld(t.slot, this._muz);
      let at = null;
      if (t.def.intercept) {
        const q = game.projectiles.incomingNear(m, this._muz, t.def.range);
        if (q) at = this._tmp.copy(q.pos);
      } else if (this.dist < t.def.range) {
        at = this.target.center(this._tmp);
      }
      if (!at) continue;
      m.model.aimTurret(t.slot, at);
      if (t.cd > 0) continue;
      const dir = this._dir.copy(at).sub(this._muz).normalize();
      dir.x += rand(-0.04, 0.04); dir.y += rand(-0.04, 0.04); dir.z += rand(-0.04, 0.04);
      dir.normalize();
      game.projectiles.spawn({
        type: 'bullet', team: 'enemy', source: m, pos: this._muz, dir, damage: t.def.damage * this.cfg.gunMul, color: this.cfg.color,
        speed: t.def.speed, life: t.def.range / t.def.speed + 0.1, intercept: !!t.def.intercept,
      });
      t.cd = t.def.interval * rand(1, 1.5);
    }
  }

  /** The pods that are still on the machine loose a pair of homing missiles each. */
  _salvo() {
    const m = this.mech, cfg = this.cfg.missiles;
    this.missileCd = cfg.every * rand(0.85, 1.2);
    const right = this._tmp.set(Math.cos(m.yaw), 0, -Math.sin(m.yaw)).clone();
    for (const slot of this.pods) {
      const side = slot === 'podL' ? -1 : 1;
      const pos = m.model.anchorWorld(slot, new THREE.Vector3());
      for (let i = 0; i < cfg.perPod; i++) {
        const dir = new THREE.Vector3(0, 1, 0).addScaledVector(right, side * rand(0.15, 0.5)).addScaledVector(m.forward(), 0.5).normalize();
        this.game.projectiles.spawn({
          type: 'missile', team: 'enemy', source: m, pos, dir, color: 0x5dffa5,
          damage: cfg.damage, speed: 90, maxSpeed: 220, delay: 0.35 + i * 0.12, turn: 2.6, target: this.target,
          splash: { radius: 16, damage: 35 }, knock: 16,
        });
      }
      this.game.audio.missile(pos);
    }
  }
}

export function createEnemy(game, type, skill) {
  switch (type) {
    case 'drone': return new Drone(game, skill);
    case 'striker': return new Striker(game, skill);
    case 'bulwark': return new Bulwark(game, skill);
    case 'baron': return new Baron(game, skill);
    case 'dummy': return new Dummy(game, skill);
    case 'crawler':
    case 'hydra': return new Rigged(game, type, skill);
    default: throw new Error(`unknown enemy type: ${type}`);
  }
}
