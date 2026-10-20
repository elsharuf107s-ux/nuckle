// Projectiles: beam shots, tracer bullets, cannon shells and homing missiles.
// Movement is swept in small sub-steps so fast beams cannot tunnel through buildings or mechs.

import * as THREE from 'three';

const Y_AXIS = new THREE.Vector3(0, 1, 0);

// Shared geometry and materials (projectiles are created constantly; nothing per-shot is allocated on the GPU).
const geo = {
  beamCore: new THREE.CylinderGeometry(0.3, 0.3, 9, 6),
  beamGlow: new THREE.CylinderGeometry(1.0, 1.0, 10, 8),
  bulletCore: new THREE.CylinderGeometry(0.16, 0.16, 4.5, 5),
  bulletGlow: new THREE.CylinderGeometry(0.5, 0.5, 5.5, 6),
  orb: new THREE.SphereGeometry(1, 12, 8),
  missile: new THREE.CylinderGeometry(0.42, 0.42, 3.4, 8),
};
const addMat = (color, opacity = 0.7) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
});
const matCache = new Map();
const glowMat = (color, opacity) => {
  const k = `${color}:${opacity}`;
  if (!matCache.has(k)) matCache.set(k, addMat(color, opacity));
  return matCache.get(k);
};
const WHITE = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
const MISSILE_BODY = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, roughness: 0.5, metalness: 0.3 });

/** Per-type defaults. Callers override damage, speed, etc. through spawn(). */
const TYPES = {
  beam:    { speed: 780, radius: 1.8, life: 1.8 },
  bullet:  { speed: 420, radius: 1.0, life: 2.4 },
  cannon:  { speed: 230, radius: 3.0, life: 4.0 },
  missile: { speed: 150, radius: 2.0, life: 5.0 },
};

function makeMesh(type, color) {
  const g = new THREE.Group();
  if (type === 'beam') {
    g.add(new THREE.Mesh(geo.beamCore, WHITE), new THREE.Mesh(geo.beamGlow, glowMat(color, 0.55)));
  } else if (type === 'bullet') {
    g.add(new THREE.Mesh(geo.bulletCore, WHITE), new THREE.Mesh(geo.bulletGlow, glowMat(color, 0.6)));
  } else if (type === 'cannon') {
    const core = new THREE.Mesh(geo.orb, WHITE);
    core.scale.setScalar(1.6);
    const glow = new THREE.Mesh(geo.orb, glowMat(color, 0.55));
    glow.scale.setScalar(3.6);
    g.add(core, glow);
  } else {
    const body = new THREE.Mesh(geo.missile, MISSILE_BODY);
    const flame = new THREE.Mesh(geo.orb, glowMat(color, 0.9));
    flame.scale.set(0.9, 0.9, 1.8);
    flame.position.y = -2.1;
    g.add(body, flame);
  }
  return g;
}

export class Projectiles {
  constructor(game) {
    this.game = game;
    this.list = [];
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
  }

  /**
   * opts: type, team ('player'|'enemy'), source (Mech), pos, dir (unit), damage, color,
   *       speed?, life?, radius?, knock?, target? (Mech, for homing), turn? (rad/s), splash? { radius, damage }
   */
  spawn(opts) {
    const base = TYPES[opts.type];
    const p = {
      type: opts.type,
      team: opts.team,
      source: opts.source,
      pos: opts.pos.clone(),
      dir: opts.dir.clone().normalize(),
      speed: opts.speed ?? base.speed,
      maxSpeed: opts.maxSpeed ?? opts.speed ?? base.speed,
      radius: opts.radius ?? base.radius,
      life: opts.life ?? base.life,
      age: 0,
      damage: opts.damage,
      knock: opts.knock ?? 0,
      target: opts.target ?? null,
      turn: opts.turn ?? 0,
      delay: opts.delay ?? 0,
      splash: opts.splash ?? null,
      color: opts.color,
      trailT: 0,
      mesh: makeMesh(opts.type, opts.color),
    };
    p.mesh.position.copy(p.pos);
    p.mesh.quaternion.setFromUnitVectors(Y_AXIS, p.dir);
    this.game.scene.add(p.mesh);
    this.list.push(p);
    return p;
  }

  update(dt) {
    const game = this.game;
    const world = game.world;
    const mechs = game.allMechs();

    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.age += dt;
      if (p.age > p.life) { this._remove(i); continue; }

      // ---- steering and acceleration
      if (p.target && !p.target.dead && p.turn > 0 && p.age >= p.delay) {
        const want = p.target.center(this._a).sub(p.pos).normalize();
        const cos = Math.min(1, Math.max(-1, p.dir.dot(want)));
        const ang = Math.acos(cos);
        if (ang > 1e-4) {
          const k = Math.min(1, (p.turn * dt) / ang);
          p.dir.lerp(want, k).normalize();
        }
      }
      if (p.type === 'missile') {
        if (p.age >= p.delay) p.speed = Math.min(p.maxSpeed, p.speed + 420 * dt);
        p.trailT -= dt;
        if (p.trailT <= 0) {
          p.trailT = 0.025;
          game.fx.smokePuff(p.pos, 1.6, 1.1);
          game.fx.glow.spawn(p.pos.x, p.pos.y, p.pos.z, 0, 0, 0, 0.18, 2.4, 0.5, [1, 0.8, 0.4], [1, 0.3, 0.1], 0.9);
        }
      }

      // ---- swept movement
      const step = p.speed * dt;
      const n = Math.max(1, Math.ceil(step / 6));
      const sub = step / n;
      let hit = false;
      for (let s = 0; s < n && !hit; s++) {
        const a = this._a.copy(p.pos);
        p.pos.addScaledVector(p.dir, sub);
        const b = p.pos;

        for (const m of mechs) {
          if (m.dead || m.team === p.team) continue;
          if (m.hitBySegment(a.x, a.y, a.z, b.x, b.y, b.z, p.radius)) {
            this._impact(p, b, m);
            hit = true;
            break;
          }
        }
        if (!hit && world.pointBlocked(b.x, b.y, b.z)) {
          this._impact(p, a, null);
          hit = true;
        }
      }
      if (hit) { this._remove(i); continue; }

      p.mesh.position.copy(p.pos);
      p.mesh.quaternion.setFromUnitVectors(Y_AXIS, p.dir);
    }
  }

  _impact(p, atScratch, mech) {
    const game = this.game;
    const at = atScratch.clone(); // callers pass scratch vectors that the splash pass would overwrite
    const knock = this._c.copy(p.dir).multiplyScalar(p.knock);
    if (mech) {
      mech.takeDamage(p.damage, { source: p.source, knock: knock.clone(), point: at.clone(), kind: p.type });
    }
    const normal = this._b.copy(p.dir).negate();
    if (p.type === 'cannon' || p.type === 'missile') {
      const r = p.type === 'cannon' ? 11 : 6;
      game.fx.explosion(at, r, { shake: p.type === 'cannon' ? 0.8 : 0.35 });
      if (p.splash) this._splash(p, at, mech);
    } else {
      game.fx.sparks(at, normal, p.type === 'beam' ? 12 : 6, p.type === 'beam' ? [1, 0.6, 0.95] : undefined);
      if (!mech) game.audio.hit(at);
      else if (p.team === 'player') game.audio.hit(at);
    }
  }

  _splash(p, at, directHit) {
    const t = this._a;
    for (const m of this.game.allMechs()) {
      if (m.dead || m.team === p.team || m === directHit) continue;
      const d = m.center(t).distanceTo(at) - m.radius;
      if (d > p.splash.radius) continue;
      const f = 1 - Math.max(0, d) / p.splash.radius;
      const kn = m.center(this._b).sub(at).normalize().multiplyScalar(60 * f);
      m.takeDamage(p.splash.damage * f, { source: p.source, knock: kn, point: at.clone(), kind: p.type });
    }
  }

  _remove(i) {
    const p = this.list[i];
    this.game.scene.remove(p.mesh);
    this.list.splice(i, 1);
  }

  /** Number of live enemy missiles homing on a mech (drives the MISSILE ALERT). */
  incomingAt(mech) {
    let n = 0;
    for (const p of this.list) if (p.type === 'missile' && p.target === mech) n++;
    return n;
  }

  clear() {
    for (const p of this.list) this.game.scene.remove(p.mesh);
    this.list.length = 0;
  }
}
