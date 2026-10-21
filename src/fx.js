// Visual effects: a pooled point-sprite particle system (fire/sparks additive, smoke alpha-blended),
// explosions, shockwaves, mech debris, beam-sabre slash arcs and thrust streaks, and afterimages.

import * as THREE from 'three';
import { rand } from './util.js';

// ------------------------------------------------------------------ particles

class Particles {
  constructor(scene, max, additive) {
    this.max = max;
    this.head = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.size = new Float32Array(max);
    // per-particle simulation state
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max).fill(1);
    this.life = new Float32Array(max).fill(1);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.fadeIn = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { uScale: { value: 600 } };
    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `
        attribute vec3 aColor; attribute float aAlpha; attribute float aSize;
        uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
          vColor = aColor; vAlpha = aAlpha;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, d);
          gl_FragColor = vec4(vColor, vAlpha * a * a);
        }`,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, a0 = 1, grav = 0, drag = 0, fadeIn = 0) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.age[i] = 0; this.life[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a0;
    this.c0[i3] = c0[0]; this.c0[i3 + 1] = c0[1]; this.c0[i3 + 2] = c0[2];
    this.c1[i3] = c1[0]; this.c1[i3 + 1] = c1[1]; this.c1[i3 + 2] = c1[2];
    this.grav[i] = grav; this.drag[i] = drag; this.fadeIn[i] = fadeIn;
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) {
        this.alpha[i] = 0;
        continue;
      }
      this.age[i] += dt;
      const t = Math.min(1, this.age[i] / this.life[i]);
      const i3 = i * 3;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= k;
      this.vel[i3 + 1] = this.vel[i3 + 1] * k + this.grav[i] * dt;
      this.vel[i3 + 2] *= k;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const ramp = this.fadeIn[i] > 0 ? Math.min(1, this.age[i] / this.fadeIn[i]) : 1;
      this.alpha[i] = this.a0[i] * ramp * (1 - t) * (1 - t * 0.3);
      this.col[i3] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      this.col[i3 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      this.col[i3 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.aColor.needsUpdate = a.aAlpha.needsUpdate = a.aSize.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ colours

const WHITE_HOT = [1, 0.8, 0.42];
const ORANGE = [1, 0.5, 0.12];
const EMBER = [0.5, 0.08, 0.02];
const YELLOW = [1, 0.85, 0.35];
const SMOKE_A = [0.28, 0.27, 0.3];
const SMOKE_B = [0.1, 0.1, 0.12];

const MAX_DEBRIS = 130;   // flying wreckage (mech parts and building chunks) alive at once
const DUST_A = [0.56, 0.5, 0.45];
const DUST_B = [0.3, 0.28, 0.27];
const GHOST_POOL = 6;     // afterimages per mech
const GHOST_LIFE = 0.26;  // seconds an afterimage takes to fade
const GHOST_ALPHA = 0.16; // its starting opacity (additive, and the meshes overlap, so it stays low)

const flashGeo = new THREE.SphereGeometry(1, 16, 12);
const ringGeo = new THREE.RingGeometry(0.82, 1, 48);
const debrisGeo = new THREE.BoxGeometry(1, 1, 1);
const thrustGlowGeo = new THREE.ConeGeometry(2.2, 28, 12, 1, true);
const thrustCoreGeo = new THREE.ConeGeometry(0.7, 26, 12, 1, true);

// ------------------------------------------------------------------ manager

export class Fx {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.glow = new Particles(this.scene, 3200, true);
    this.smoke = new Particles(this.scene, 1400, false);
    this.timed = []; // { obj, age, life, update(t, obj) , dispose() }
    this.debris = [];
    this._ghostPools = new Map(); // mech -> { list: [{ group, meshes, mat, age }], next }
    this._ghostsLive = new Set();
    this._debrisMats = new Map();
    this._tmp = new THREE.Vector3();
  }

  setView(heightPx, fovDeg) {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.glow.uniforms.uScale.value = s;
    this.smoke.uniforms.uScale.value = s;
  }

  update(dt) {
    this.glow.update(dt);
    this.smoke.update(dt);

    for (let i = this.timed.length - 1; i >= 0; i--) {
      const e = this.timed[i];
      e.age += dt;
      const t = e.age / e.life;
      if (t >= 1) {
        this.scene.remove(e.obj);
        e.obj.traverse?.((o) => o.material?.dispose?.());
        e.geo?.dispose();
        this.timed.splice(i, 1);
      } else e.update(t, e.obj);
    }

    for (const gh of this._ghostsLive) {
      gh.age += dt;
      const t = gh.age / GHOST_LIFE;
      if (t >= 1) { gh.group.visible = false; this._ghostsLive.delete(gh); continue; }
      gh.mat.opacity = GHOST_ALPHA * (1 - t) * (1 - t);
    }

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      d.vel.y -= 55 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.mesh.position.y < d.size * 0.5) {
        d.mesh.position.y = d.size * 0.5;
        d.vel.y *= -0.35;
        d.vel.x *= 0.7; d.vel.z *= 0.7;
        d.spin.multiplyScalar(0.6);
        if (Math.abs(d.vel.y) < 2) d.vel.y = 0;
      }
      if (d.age > 1 && Math.random() < dt * 14 && d.age < d.life - 0.5) {
        this.smoke.spawn(d.mesh.position.x, d.mesh.position.y, d.mesh.position.z, rand(-1, 1), rand(2, 6), rand(-1, 1), 1.0, 1.2, 4, SMOKE_A, SMOKE_B, 0.35, 0, 0.5);
      }
      const left = d.life - d.age;
      if (left < 0.6) d.mesh.scale.setScalar(Math.max(0.001, (left / 0.6) * d.size));
      if (left <= 0) {
        this.scene.remove(d.mesh);
        this.debris.splice(i, 1);
      }
    }
  }

  _addTimed(obj, life, update, geo = null) {
    this.scene.add(obj);
    this.timed.push({ obj, age: 0, life, update, geo });
  }

  // ------------------------------------------------------------------ one-shot effects

  explosion(pos, radius = 10, { sound = true, shake = 1 } = {}) {
    // bright flash
    const flash = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({
      color: 0xff9a45, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    flash.position.copy(pos);
    this._addTimed(flash, 0.32, (t, o) => {
      o.scale.setScalar(radius * (0.35 + t * 1.0));
      o.material.opacity = 0.85 * (1 - t) * (1 - t);
    });
    // ground shockwave
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0xffb060, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    ring.position.set(pos.x, Math.max(0.3, Math.min(pos.y, 0.6)), pos.z);
    ring.rotation.x = -Math.PI / 2;
    this._addTimed(ring, 0.55, (t, o) => {
      o.scale.setScalar(radius * (0.4 + t * 2.4));
      o.material.opacity = 0.8 * (1 - t);
    });

    const nFire = Math.round(14 + radius * 2.6);
    for (let i = 0; i < nFire; i++) {
      const dir = this._randDir();
      const sp = rand(0.15, 1) * radius * 2.4;
      this.glow.spawn(pos.x, pos.y, pos.z, dir.x * sp, dir.y * sp + radius * 0.5, dir.z * sp,
        rand(0.6, 1.5), radius * rand(0.5, 0.85), radius * rand(1.3, 2.0), WHITE_HOT, EMBER, 0.7, 6, 2.0);
    }
    const nSpark = Math.round(10 + radius * 1.6);
    for (let i = 0; i < nSpark; i++) {
      const dir = this._randDir();
      const sp = rand(30, 110) * (0.5 + radius / 20);
      this.glow.spawn(pos.x, pos.y, pos.z, dir.x * sp, Math.abs(dir.y) * sp + 14, dir.z * sp,
        rand(0.5, 1.3), 1.1, 0.2, YELLOW, ORANGE, 1, -60, 0.4);
    }
    const nSmoke = Math.round(6 + radius * 0.9);
    for (let i = 0; i < nSmoke; i++) {
      const dir = this._randDir();
      const sp = rand(3, 12);
      this.smoke.spawn(pos.x + dir.x * radius * 0.3, pos.y + dir.y * radius * 0.3, pos.z + dir.z * radius * 0.3,
        dir.x * sp, Math.abs(dir.y) * sp + 6, dir.z * sp,
        rand(2.2, 4.2), radius * 0.5, radius * rand(1.4, 2.4), SMOKE_A, SMOKE_B, 0.6, 3, 0.8, 0.25);
    }

    this.game.world.flashAt(pos, radius / 12);
    if (sound) this.game.audio.explosion(radius / 12, pos);
    this.game.shakeFrom(pos, shake * radius / 12, 380);
  }

  /** Small impact: sparks fly out along a normal. */
  sparks(pos, normal, n = 8, color = YELLOW) {
    for (let i = 0; i < n; i++) {
      const d = this._randDir();
      if (normal) d.addScaledVector(normal, 1.2).normalize();
      const sp = rand(20, 70);
      this.glow.spawn(pos.x, pos.y, pos.z, d.x * sp, d.y * sp, d.z * sp, rand(0.15, 0.45), 0.9, 0.1, color, ORANGE, 1, -80, 0.8);
    }
    this.glow.spawn(pos.x, pos.y, pos.z, 0, 0, 0, 0.12, 5, 8, WHITE_HOT, WHITE_HOT, 0.8);
  }

  /** Small burst of dust, e.g. when a mech lands. */
  dust(pos, n = 10, spread = 14) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(0.3, 1) * spread;
      this.smoke.spawn(pos.x, pos.y + 0.5, pos.z, Math.cos(a) * sp, rand(1, 5), Math.sin(a) * sp, rand(0.7, 1.4), 2, 6, [0.5, 0.45, 0.42], [0.3, 0.28, 0.28], 0.4, 0, 1.6);
    }
  }

  smokePuff(pos, size = 1.5, life = 1.2) {
    this.smoke.spawn(pos.x, pos.y, pos.z, rand(-1, 1), rand(0, 2), rand(-1, 1), life, size, size * 3, [0.6, 0.6, 0.62], SMOKE_B, 0.35, 0, 0.8);
  }

  /** Glowing exhaust particle, used for boost trails. */
  exhaust(pos, vel, color, size = 3) {
    this.glow.spawn(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, rand(0.2, 0.4), size, size * 0.3, color, [0.1, 0.1, 0.4], 0.7, 0, 1.5);
  }

  /** A big billow of dust rolling out from (x, y, z): a collapse, or a heavy impact on the ground. */
  dustCloud(x, y, z, radius, n = 16, rise = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * rand(0.3, 1.05);
      const sp = rand(6, 22) * (0.6 + radius / 40);
      this.smoke.spawn(x + Math.cos(a) * r, y + rand(0.5, 3), z + Math.sin(a) * r, Math.cos(a) * sp, rand(4, 12) * rise, Math.sin(a) * sp,
        rand(2.4, 4.4), rand(5, 9), rand(18, 36), DUST_A, DUST_B, 0.55, 0, 1.3, 0.1);
    }
  }

  /** One puff of a rising smoke column (a smouldering ruin); `fire` adds an ember now and then. */
  plume(x, y, z, fire = false) {
    this.smoke.spawn(x + rand(-3, 3), y, z + rand(-3, 3), rand(-2, 3), rand(10, 18), rand(-2, 2), rand(2.8, 4.6), 4, rand(14, 26), SMOKE_A, SMOKE_B, 0.5, 0, 0.5, 0.2);
    if (fire && Math.random() < 0.55) {
      this.glow.spawn(x + rand(-3, 3), y, z + rand(-3, 3), rand(-4, 4), rand(8, 20), rand(-4, 4), rand(0.5, 1.1), rand(1.5, 3), 0.4, WHITE_HOT, EMBER, 0.9, -10, 0.4);
    }
  }

  /**
   * A chunk of wreckage that flies and tumbles, lands, and fades: used for building collapses. `mat` is any shared
   * material; chunks past the cap are dropped so a big collapse cannot flood the scene.
   */
  chunk(pos, vel, size, mat, life = rand(3, 5)) {
    if (this.debris.length >= MAX_DEBRIS) return;
    const mesh = new THREE.Mesh(debrisGeo, mat);
    mesh.scale.set(size * rand(0.7, 1.4), size * rand(0.5, 1.1), size * rand(0.7, 1.4));
    mesh.position.copy(pos);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.debris.push({ mesh, size, age: 0, life, vel: vel.clone(), spin: new THREE.Vector3(rand(-5, 5), rand(-5, 5), rand(-5, 5)) });
  }

  /** A wrecked mech: hull chunks scatter and burn. */
  debrisBurst(pos, palette, scale = 1) {
    const colors = [palette.main, palette.sub, palette.accent, palette.dark];
    for (let i = 0; i < 14; i++) {
      const c = colors[i % colors.length];
      let mat = this._debrisMats.get(c);
      if (!mat) this._debrisMats.set(c, (mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.4 })));
      const size = rand(0.8, 2.6) * scale;
      const mesh = new THREE.Mesh(debrisGeo, mat);
      mesh.scale.set(size, size * rand(0.5, 1.4), size * rand(0.5, 1.2));
      mesh.position.set(pos.x + rand(-3, 3), pos.y + rand(-4, 5), pos.z + rand(-3, 3));
      mesh.castShadow = true;
      this.scene.add(mesh);
      const dir = this._randDir();
      this.debris.push({
        mesh, size, age: 0, life: rand(3.5, 5.5),
        vel: new THREE.Vector3(dir.x * rand(15, 55), Math.abs(dir.y) * rand(25, 60) + 15, dir.z * rand(15, 55)),
        spin: new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8)),
      });
    }
  }

  /**
   * A ghost of the mech frozen in its current pose, fading out: steps and lunges leave a trail of them.
   * Each mech gets a small pool of ghosts built once from its own meshes (minus the tiny details and the
   * flames); spawning one copies the live pose's world matrices into it.
   */
  afterimage(mech) {
    let pool = this._ghostPools.get(mech);
    if (!pool) this._ghostPools.set(mech, (pool = this._makeGhosts(mech)));
    const gh = pool.list[pool.next];
    pool.next = (pool.next + 1) % pool.list.length;
    mech.root.updateWorldMatrix(true, true);
    for (const m of gh.meshes) m.visible = false;
    mech.root.traverseVisible((o) => {
      const i = o.userData.ghost;
      if (i === undefined) return;
      const gm = gh.meshes[i];
      gm.visible = true;
      gm.matrix.copy(o.matrixWorld);
    });
    gh.age = 0;
    gh.mat.opacity = GHOST_ALPHA;
    gh.group.visible = true;
    this._ghostsLive.add(gh);
  }

  _makeGhosts(mech) {
    const sources = [];
    const v = new THREE.Vector3();
    mech.root.traverse((o) => {
      if (!o.isMesh || o.material.blending === THREE.AdditiveBlending) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      o.getWorldScale(v);
      if (o.geometry.boundingSphere.radius * Math.max(v.x, v.y, v.z) < 0.45 * mech.spec.scale) return; // skip the small details
      o.userData.ghost = sources.length;
      sources.push(o);
    });
    const color = mech.spec.palette.flame ?? 0x6fd0ff;
    const list = [];
    for (let i = 0; i < GHOST_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      const meshes = sources.map((src) => {
        const m = new THREE.Mesh(src.geometry, mat);
        m.matrixAutoUpdate = false;
        m.frustumCulled = false;
        group.add(m);
        return m;
      });
      group.visible = false;
      this.scene.add(group);
      list.push({ group, meshes, mat, age: 0 });
    }
    return { list, next: 0 };
  }

  /** A mech left the field: free its ghosts. */
  dropGhosts(mech) {
    const pool = this._ghostPools.get(mech);
    if (!pool) return;
    for (const gh of pool.list) {
      this.scene.remove(gh.group);
      gh.mat.dispose();
      this._ghostsLive.delete(gh);
    }
    this._ghostPools.delete(mech);
  }

  /**
   * The crescent a saber leaves. Its shape follows the blade's real path (see the swing poses in mechModel.js):
   * the two horizontal slashes sweep the front half at waist-to-chest height, from one side round to the other;
   * the overhead chop falls in a vertical plane just right of centre, from behind the head to low in front.
   * The crescent sweeps about as fast as the blade does, then fades.
   */
  slashArc(mech, kind, color) {
    if (kind === 'thrust') { this._thrustStreak(mech, color); return; }
    const vertical = kind === 'slash3';
    const thetaStart = vertical ? -0.55 : -0.05;
    const thetaLen = vertical ? 3.35 : Math.PI + 0.1;
    const inner = 7, outer = vertical ? 20 : 19;
    const geo = new THREE.RingGeometry(inner, outer, 48, 1, thetaStart, thetaLen);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
      uniforms: {
        uHead: { value: 0 }, uFade: { value: 1 }, uColor: { value: new THREE.Color(color) },
        uStart: { value: thetaStart }, uLen: { value: thetaLen }, uInner: { value: inner }, uWidth: { value: outer - inner },
        uDir: { value: kind === 'slash1' ? 1 : kind === 'slash2' ? -1 : -1 },
      },
      vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        varying vec2 vP; uniform float uHead, uFade, uStart, uLen, uDir, uInner, uWidth; uniform vec3 uColor;
        void main(){
          float u = (atan(vP.y, vP.x) - uStart) / uLen;
          if (uDir < 0.0) u = 1.0 - u;
          float r = (length(vP) - uInner) / uWidth;
          float body = smoothstep(uHead - 0.55, uHead, u) * step(u, uHead);
          float crescent = smoothstep(0.0, 0.85, r) * (1.0 - smoothstep(0.88, 1.0, r));
          gl_FragColor = vec4(mix(uColor, vec3(1.0), body * body * 0.7), body * crescent * uFade);
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const holder = new THREE.Group();
    holder.add(mesh);
    if (vertical) {
      mesh.rotation.y = Math.PI / 2; // ring +x points ahead, +y up
      mesh.position.x = 3.5;         // the right arm swings it
    } else {
      mesh.rotation.x = -Math.PI / 2; // ring +x is the mech's right, +y ahead
    }
    holder.position.set(mech.pos.x, mech.pos.y + (vertical ? 13 : 11) * mech.spec.scale, mech.pos.z);
    holder.rotation.y = mech.yaw;
    holder.scale.setScalar(mech.spec.scale);
    this._addTimed(holder, 0.38, (t) => {
      mat.uniforms.uHead.value = Math.min(1.15, t * 4.5); // t runs 0..1 over the 0.38 s: the crescent sweeps in about 0.1 s
      mat.uniforms.uFade.value = 1 - Math.max(0, t - 0.3) / 0.7;
    }, geo);
  }

  /** The thrust's trail: a spear of light shooting straight out ahead of the mech at chest height, then fading. */
  _thrustStreak(mech, color) {
    const holder = new THREE.Group();
    const mk = (geo, len, c, op) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      }));
      m.rotation.x = -Math.PI / 2; // the cone's tip points ahead (-z)
      m.position.set(1.2, 0, -(6 + len / 2));
      holder.add(m);
      return m;
    };
    const glow = mk(thrustGlowGeo, 28, color, 0.8);
    const core = mk(thrustCoreGeo, 26, 0xffffff, 0.9);
    holder.position.set(mech.pos.x, mech.pos.y + 11.5 * mech.spec.scale, mech.pos.z);
    holder.rotation.y = mech.yaw;
    holder.scale.setScalar(mech.spec.scale);
    this._addTimed(holder, 0.3, (t) => {
      const grow = Math.min(1, t * 6);
      holder.scale.set(mech.spec.scale * (1 - t * 0.5), mech.spec.scale * (1 - t * 0.5), mech.spec.scale * (0.2 + 0.8 * grow));
      glow.material.opacity = 0.8 * (1 - t);
      core.material.opacity = 0.9 * (1 - t) * (1 - t);
    });
    // a burst of light where the point ends up
    const f = mech.forward(this._tmp);
    const tip = { x: mech.pos.x + f.x * 30 * mech.spec.scale, y: mech.pos.y + 11.5 * mech.spec.scale, z: mech.pos.z + f.z * 30 * mech.spec.scale };
    const c = new THREE.Color(color);
    this.glow.spawn(tip.x, tip.y, tip.z, 0, 0, 0, 0.18, 4, 12, [1, 1, 1], [c.r, c.g, c.b], 0.9);
  }

  _randDir() {
    const v = this._tmp;
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    return v.set(s * Math.cos(a), u, s * Math.sin(a)).clone();
  }

  clear() {
    for (const e of this.timed) this.scene.remove(e.obj);
    this.timed.length = 0;
    for (const gh of this._ghostsLive) gh.group.visible = false;
    this._ghostsLive.clear();
    for (const d of this.debris) this.scene.remove(d.mesh);
    this.debris.length = 0;
    for (const p of [this.glow, this.smoke]) {
      p.age.fill(1);
      p.alpha.fill(0);
    }
  }
}
