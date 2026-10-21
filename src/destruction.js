// The destructible city. Every building is a stack of floors (one row of windows each) with a structural
// strength that grows toward the ground, because the floors below carry the ones above. Every shot, blast, saber
// stroke and wrecked mech damages the floors around where it lands; when a floor gives way, it and everything above
// it comes down: the roof section pancakes onto the stump in a cloud of dust, chunks fly, the roof machinery falls
// off, mechs standing on the roof fall with it and anything near the base is hit by the debris. Bring down the lowest
// floors and nothing is left but a mound of rubble that mechs can walk over.
//
// The collision volume of a building is its own record in world.boxes, so lowering `top` is all it takes for cover to
// vanish, a roof to give way under a mech, or a shot to fly through the gap. Visual damage is cheap: one instanced
// mesh of scorch marks for the whole city, one merged mesh for a ruined crown or a rubble mound, and a handful of
// falling slabs and chunks at a time.

import * as THREE from 'three';
import { clamp, rand } from './util.js';
import { FLOOR_H } from './world.js';

const DECALS = 240;          // scorch marks alive at once (a ring: the oldest are reused)
const SLACK = 7;             // how far from a wall a stopped shot can be recorded and still count as touching it
const RUBBLE_FLOORS = 1;     // a collapse that leaves this many floors or fewer flattens the building
const MAX_SLABS = 6;         // falling roof sections animated at once
const MAX_EMITTERS = 12;     // smouldering ruins at once
const SLAB_TIME = 1.1;       // seconds a roof section takes to pancake
const COLLAPSE_DMG_COOLDOWN = 0.9; // a mech hit by debris cannot be hit by more for this long

/** Strength of floor f of a building (original floor numbering, so damage already taken does not suddenly count for more). */
const hpOf = (b, f) => 260 + 90 * (b.n0 - 1 - f);

const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpM = new THREE.Matrix4(), tmpE = new THREE.Euler();
const Z_AXIS = new THREE.Vector3(0, 0, 1), Y_AXIS = new THREE.Vector3(0, 1, 0);

/** One merged mesh of tilted boxes, each tinted its own colour: the broken crown of a building, or a rubble mound. */
function mergedBoxes(parts, material) {
  const pos = [], nor = [], col = [], idx = [];
  const unit = unitBox();
  const P = unit.attributes.position, N = unit.attributes.normal, I = unit.index;
  const v = new THREE.Vector3(), nm = new THREE.Matrix3(), c = new THREE.Color();
  let base = 0;
  for (const p of parts) {
    tmpM.compose(tmpV.set(p.x, p.y, p.z), tmpQ.setFromEuler(tmpE.set(p.rx || 0, p.ry || 0, p.rz || 0)), tmpS.set(p.w, p.h, p.d));
    nm.getNormalMatrix(tmpM);
    c.set(p.color);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(tmpM);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      nor.push(v.x, v.y, v.z);
      const shade = v.y > 0.5 ? 1 : 0.72; // the tops catch the light
      col.push(c.r * shade, c.g * shade, c.b * shade);
    }
    for (let i = 0; i < I.count; i++) idx.push(I.getX(i) + base);
    base += P.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
let _unit = null;
const unitBox = () => _unit ?? (_unit = new THREE.BoxGeometry(1, 1, 1));

const CONCRETE = [0x6f7078, 0x5a5b63, 0x82828a, 0x4a4b52, 0x8a857c, 0x3c3d44];
const pickConcrete = () => CONCRETE[Math.floor(Math.random() * CONCRETE.length)];

export class Destruction {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.scene = game.scene;
    this.slabs = [];        // roof sections pancaking: { group, mesh, t, dur, h }
    this.emitters = [];     // smouldering ruins: { x, y, z, t, life, fire, acc }
    this.collapses = 0;     // roof sections brought down this sortie
    this.leveled = 0;       // buildings flattened this sortie
    this._cand = [];
    this._decalNext = 0;
    this._decalOwner = new Array(DECALS).fill(null);
    this._decalY = new Float32Array(DECALS);
    this._decalR = new Float32Array(DECALS);
    this._rubbleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    this._chunkMats = CONCRETE.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0.05 }));
    this._buildDecals();
  }

  // ------------------------------------------------------------------ scorch marks

  /** One instanced mesh for every scorch mark in the city: a single draw call whatever the count. */
  _buildDecals() {
    const S = 64, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(6,5,5,0.95)');
    grad.addColorStop(0.55, 'rgba(12,10,10,0.8)');
    grad.addColorStop(1, 'rgba(12,10,10,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 40; i++) { // ragged edge: pitting and flaking round the blast
      const a = Math.random() * Math.PI * 2, r = S * (0.28 + Math.random() * 0.2);
      g.fillStyle = Math.random() < 0.5 ? 'rgba(10,8,8,0.9)' : 'rgba(0,0,0,0)';
      g.beginPath(); g.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 1.5 + Math.random() * 3.5, 0, Math.PI * 2); g.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, DECALS);
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decals.frustumCulled = false;
    this._hideAllDecals();
    this.scene.add(this.decals);
  }

  _hideAllDecals() {
    tmpM.makeScale(0, 0, 0);
    for (let i = 0; i < DECALS; i++) { this.decals.setMatrixAt(i, tmpM); this._decalOwner[i] = null; }
    this.decals.instanceMatrix.needsUpdate = true;
  }

  /** Burn a mark into the wall of `b` where the point (x, y, z) is. */
  _scorch(b, x, y, z, size) {
    if (y > b.top - 0.5) return;
    // which face: the nearest wall
    const dxl = Math.abs(x - b.minX), dxr = Math.abs(b.maxX - x), dzl = Math.abs(z - b.minZ), dzr = Math.abs(b.maxZ - z);
    const m = Math.min(dxl, dxr, dzl, dzr);
    let nx = 0, nz = 0, px = x, pz = z;
    if (m === dxl) { nx = -1; px = b.minX; } else if (m === dxr) { nx = 1; px = b.maxX; } else if (m === dzl) { nz = -1; pz = b.minZ; } else { nz = 1; pz = b.maxZ; }
    px = clamp(px, b.minX + 1, b.maxX - 1);
    pz = clamp(pz, b.minZ + 1, b.maxZ - 1);
    // a plane faces +z; turn it to the wall, then spin it a random amount about its own normal
    const face = Math.atan2(nx, nz);
    tmpQ.setFromAxisAngle(Y_AXIS, face).multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, Math.random() * Math.PI * 2));
    tmpM.compose(tmpV.set(px + nx * 0.14, y, pz + nz * 0.14), tmpQ, tmpS.set(size, size, 1));
    const i = this._decalNext;
    this._decalNext = (i + 1) % DECALS;
    this.decals.setMatrixAt(i, tmpM);
    this.decals.instanceMatrix.needsUpdate = true;
    this._decalOwner[i] = b;
    this._decalY[i] = y;
    this._decalR[i] = size / 2;
  }

  /** Remove the marks on the part of `b` that is no longer there (everything above `top`). */
  _clearDecals(b, top) {
    let any = false;
    tmpM.makeScale(0, 0, 0);
    for (let i = 0; i < DECALS; i++) {
      const above = this._decalY[i] - this._decalR[i] * 0.5 >= top - 0.01; // the mark sits on the part that came down
      if (this._decalOwner[i] !== b || !above) continue;
      this.decals.setMatrixAt(i, tmpM);
      this._decalOwner[i] = null;
      any = true;
    }
    if (any) this.decals.instanceMatrix.needsUpdate = true;
  }

  /** How many scorch marks are showing (for the tests). */
  get decalCount() {
    return this._decalOwner.reduce((n, o) => n + (o ? 1 : 0), 0);
  }

  // ------------------------------------------------------------------ damage

  /**
   * Damage the floors of every building near (x, y, z). `amount` is structural damage at the centre, falling off to
   * nothing at `radius`; `contact` means the point is on the wall of a building (a stopped shot), so the few units
   * between the point and the wall do not count against it. Returns true if anything was hit.
   */
  damageAt(x, y, z, amount, radius = 3, contact = false) {
    if (amount <= 0) return false;
    const cand = this._cand;
    cand.length = 0;
    const reach = radius + (contact ? SLACK : 0);
    for (const b of this.world.boxes) {
      const dx = Math.max(b.minX - x, 0, x - b.maxX), dz = Math.max(b.minZ - z, 0, z - b.maxZ);
      if (dx > reach || dz > reach || y < -radius) continue;
      const dh = Math.hypot(dx, dz);
      if (dh > reach) continue;
      cand.push(b, dh);
    }
    if (!cand.length) return false;
    const hits = cand.slice(); // collapses change world.boxes while we work through the list
    for (let k = 0; k < hits.length; k += 2) this._damageBuilding(hits[k], hits[k + 1], x, y, z, amount, radius, contact);
    return true;
  }

  _damageBuilding(b, dh, x, y, z, amount, radius, contact) {
    if (b.rubble || b.n <= 0) return;
    if (y - radius - 2 >= b.top) return; // a blast above the roof (the roof is already down): nothing here to hit
    const fh = contact ? 1 : Math.max(0, 1 - dh / radius);
    if (fh <= 0) return;
    const lo = clamp(Math.floor((y - radius - 2) / FLOOR_H), 0, b.n - 1);
    const hi = clamp(Math.floor((y + radius + 2) / FLOOR_H), 0, b.n - 1);
    let worst = 0;
    for (let f = lo; f <= hi; f++) {
      const dy = Math.max(0, f * FLOOR_H - y, y - (f + 1) * FLOOR_H);
      const fv = 1 - dy / (radius + 2);
      if (fv <= 0) continue;
      b.floorDmg[f] += amount * fh * fv;
      const frac = b.floorDmg[f] / hpOf(b, f);
      if (frac > worst) worst = frac;
    }
    // the lowest floor that has given way brings down everything above it
    for (let f = 0; f < b.n; f++) {
      if (b.floorDmg[f] >= hpOf(b, f)) { this._collapse(b, f); return; }
    }
    // not down yet: leave a mark, and start to smoulder once the structure is in a bad way
    const now = this.game.time;
    const e = amount * fh;
    if (contact && e >= 30 && now - b.lastDecal > 0.05) {
      b.lastDecal = now;
      this._scorch(b, x, y, z, clamp(2.5 + e / 90, 2.5, 9));
    }
    if (worst > 0.45 && e >= 50 && now > b.smokeUntil) {
      b.smokeUntil = now + 6;
      this._emitter(clamp(x, b.minX + 1, b.maxX - 1), y, clamp(z, b.minZ + 1, b.maxZ - 1), 6, worst > 0.8);
    }
  }

  /** A blast of `amount` at a point that need not be touching a wall: a shell bursting, a machine blowing up. */
  explode(x, y, z, amount, radius) {
    return this.damageAt(x, y, z, amount, radius, false);
  }

  /** A saber stroke from `mech`: the wall in front of it, if any is within reach. Returns true if one was cut. */
  slash(mech, reach, damage) {
    const s = mech.spec.scale;
    const fx = -Math.sin(mech.yaw), fz = -Math.cos(mech.yaw);
    const oy = mech.pos.y + 11 * s;
    const t = this.world.raycast(mech.pos.x, oy, mech.pos.z, fx, 0, fz, reach + mech.radius);
    if (!Number.isFinite(t)) return false;
    const x = mech.pos.x + fx * t, z = mech.pos.z + fz * t;
    this.damageAt(x - fx * 0.3, oy, z - fz * 0.3, damage, 3.5, true);
    this.game.fx.sparks(tmpV.set(x, oy, z), null, 14, [1, 0.6, 0.95]);
    return true;
  }

  // ------------------------------------------------------------------ collapse

  /** Floor `f` of `b` has given way: it and everything above it come down. */
  _collapse(b, f) {
    const game = this.game, fx = game.fx, world = this.world;
    const oldTop = b.top;
    const rubble = f <= RUBBLE_FLOORS;
    const newTop = rubble ? 0 : f * FLOOR_H;
    const lost = Math.max(1, Math.round((oldTop - newTop) / FLOOR_H));
    const cx = b.cx, cz = b.cz;
    b.changed = true;
    this.collapses++;
    game.stats.collapses = (game.stats.collapses ?? 0) + 1;

    // ---- the roof section: pancakes onto what is left
    if (this.slabs.length < MAX_SLABS) this._slab(b, newTop, oldTop);

    // ---- what stands afterwards
    for (let i = f; i < b.n0; i++) b.floorDmg[i] = 0;
    b.n = rubble ? 0 : f;
    b.top = newTop;
    this._clearDecals(b, newTop);
    this._drop(b.crown);
    b.crown = null;
    if (rubble) {
      b.mesh.visible = false;
      const i = world.boxes.indexOf(b);
      if (i >= 0) world.boxes.splice(i, 1); // no longer solid: the rubble can be walked over
      b.rubble = this._rubble(b);
      this.leveled++;
      game.stats.leveled = (game.stats.leveled ?? 0) + 1;
    } else {
      b.mesh.geometry.dispose();
      b.mesh.geometry = world.buildingGeo(b, 0, newTop);
      b.mesh.position.y = newTop / 2;
      b.crown = this._crown(b, newTop);
    }

    // ---- roof machinery goes with the roof
    for (const p of b.props) {
      if (p.gone || p.base < newTop) continue;
      p.gone = true;
      p.mesh.visible = false;
      this._chunks(p.mesh.position, 1, Math.max(2, p.size * 0.6), 0.6);
    }

    // ---- flying chunks, dust, fire and noise
    const wide = Math.max(b.w, b.d);
    const mid = tmpV.set(cx, (oldTop + newTop) / 2, cz);
    this._chunks(mid, lost, 3.2, 1, b, newTop, oldTop);
    fx.dustCloud(cx, 0, cz, wide / 2 + 5, clamp(12 + lost * 3, 14, 46));
    fx.dustCloud(cx, newTop, cz, Math.min(b.w, b.d) / 2, clamp(6 + lost, 6, 18), 1.4);
    const flashes = Math.min(3, Math.ceil(lost / 3));
    for (let i = 0; i < flashes; i++) {
      fx.explosion(new THREE.Vector3(cx + rand(-b.w, b.w) * 0.35, newTop + rand(0, 3), cz + rand(-b.d, b.d) * 0.35), rand(6, 11), { sound: false, shake: 0 });
    }
    this._emitter(cx, newTop + 1, cz, 9 + lost * 0.5, true);
    const where = new THREE.Vector3(cx, newTop + (oldTop - newTop) * 0.3, cz);
    game.audio.collapse(lost / 4, where);
    game.shakeFrom(where, clamp(0.2 + lost * 0.04, 0.2, 0.85), 380);
    game.world.flashAt(where, clamp(lost / 6, 0.3, 1.4));

    // ---- anyone caught in it
    this._hurtMechs(b, oldTop, newTop, lost);
  }

  /** The roof section: a copy of the walls from `y0` to `y1` that shrinks onto the stump. */
  _slab(b, y0, y1) {
    const world = this.world;
    const geo = world.buildingGeo(b, y0, y1);
    geo.translate(0, (y1 - y0) / 2, 0); // origin at the foot, so it can squash down onto the stump
    const group = new THREE.Group();
    group.position.set(b.cx, y0, b.cz);
    const mesh = new THREE.Mesh(geo, [b.side, b.side, world.cityAssets.roofMat, world.cityAssets.roofMat, b.side, b.side]);
    mesh.castShadow = true;
    group.add(mesh);
    this.scene.add(group);
    this.slabs.push({ group, mesh, t: 0, dur: SLAB_TIME * clamp(0.7 + (y1 - y0) / 90, 0.7, 1.6), lean: rand(-0.06, 0.06), spin: rand(-0.12, 0.12) });
  }

  _chunks(origin, lost, size, power, b = null, y0 = 0, y1 = 0) {
    const fx = this.game.fx;
    const n = b ? clamp(Math.round(6 + lost * 1.8), 6, 26) : 3;
    const v = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      if (b) p.set(b.cx + rand(-b.w, b.w) * 0.45, y0 + rand(0, 1) * (y1 - y0), b.cz + rand(-b.d, b.d) * 0.45);
      else p.copy(origin);
      let ox = b ? p.x - b.cx : rand(-1, 1), oz = b ? p.z - b.cz : rand(-1, 1);
      const l = Math.hypot(ox, oz) || 1;
      ox /= l; oz /= l;
      const sp = rand(10, 34) * power;
      v.set(ox * sp, rand(4, 22) * power, oz * sp);
      const mat = Math.random() < 0.4 ? this.world.cityAssets.sideMats[i % this.world.cityAssets.sideMats.length] : this._chunkMats[i % this._chunkMats.length];
      fx.chunk(p, v, size * rand(0.7, 1.5), mat);
    }
  }

  /** The jagged stump left when the top of a building comes off: broken slabs and bent rebar on the new roof. */
  _crown(b, top) {
    const parts = [];
    const n = clamp(Math.round((b.w * b.d) / 60), 6, 16);
    for (let i = 0; i < n; i++) {
      const hh = rand(0.6, 3.2);
      parts.push({ w: rand(2.5, 7), h: hh, d: rand(2.5, 7), x: b.cx + rand(-b.w, b.w) * 0.42, y: top + hh / 2 - 0.1, z: b.cz + rand(-b.d, b.d) * 0.42,
        ry: rand(0, Math.PI), rx: rand(-0.25, 0.25), rz: rand(-0.25, 0.25), color: pickConcrete() });
    }
    for (let i = 0; i < 6; i++) {
      const hh = rand(2.5, 6);
      parts.push({ w: 0.2, h: hh, d: 0.2, x: b.cx + rand(-b.w, b.w) * 0.45, y: top + hh / 2, z: b.cz + rand(-b.d, b.d) * 0.45,
        rx: rand(-0.5, 0.5), rz: rand(-0.5, 0.5), color: 0x6b3a22 });
    }
    const mesh = mergedBoxes(parts, this._rubbleMat);
    this.world.cityGroup.add(mesh);
    return mesh;
  }

  /**
   * What is left of a flattened building: a mound of broken concrete and bent rebar, as high as the building was tall
   * allows, with a few whole floors lying tilted in it and a scorched patch under it.
   */
  _rubble(b) {
    const parts = [];
    const peak = clamp(b.h0 * 0.09, 2.5, 8);
    parts.push({ w: b.w * 1.08, h: 0.12, d: b.d * 1.08, x: b.cx, y: 0.07, z: b.cz, color: 0x16161a }); // the scorch
    const n = clamp(Math.round((b.w * b.d) / 30), 12, 44);
    for (let i = 0; i < n; i++) {
      const x = b.cx + rand(-1, 1) * b.w * 0.48, z = b.cz + rand(-1, 1) * b.d * 0.48;
      const centre = 1 - Math.max(Math.abs(x - b.cx) / (b.w / 2), Math.abs(z - b.cz) / (b.d / 2)); // taller toward the middle
      const hh = rand(0.8, 2.2) + centre * rand(0.5, 1) * peak;
      parts.push({ w: rand(2.5, 8), h: hh, d: rand(2.5, 8), x, y: hh / 2 - 0.3, z, ry: rand(0, Math.PI), rx: rand(-0.3, 0.3), rz: rand(-0.3, 0.3), color: pickConcrete() });
    }
    for (let i = 0; i < 5; i++) { // whole floors, slumped
      const y = rand(0.6, peak * 0.75);
      parts.push({ w: rand(b.w * 0.3, b.w * 0.65), h: 0.55, d: rand(b.d * 0.3, b.d * 0.65), x: b.cx + rand(-1, 1) * b.w * 0.25, y, z: b.cz + rand(-1, 1) * b.d * 0.25,
        ry: rand(0, Math.PI), rx: rand(-0.45, 0.45), rz: rand(-0.45, 0.45), color: 0x8f8f98 });
    }
    for (let i = 0; i < 9; i++) {
      const hh = rand(2.5, 7);
      parts.push({ w: 0.22, h: hh, d: 0.22, x: b.cx + rand(-1, 1) * b.w * 0.4, y: peak * 0.4 + hh / 2, z: b.cz + rand(-1, 1) * b.d * 0.4, rx: rand(-0.6, 0.6), rz: rand(-0.6, 0.6), color: 0x6b3a22 });
    }
    const mesh = mergedBoxes(parts, this._rubbleMat);
    this.world.cityGroup.add(mesh);
    return mesh;
  }

  /** Take a merged mesh (a crown or a rubble mound) out of the city and free its geometry. */
  _drop(mesh) {
    if (!mesh) return;
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }

  /** Debris on anything near the foot of the building or on the roof that is falling. */
  _hurtMechs(b, oldTop, newTop, lost) {
    const game = this.game, now = game.time;
    const R = clamp(14 + lost * 0.6, 14, 26);
    for (const m of game.allMechs()) {
      if (m.dead || now - (m._collapseT ?? -9) < COLLAPSE_DMG_COOLDOWN) continue;
      const dx = Math.max(b.minX - m.pos.x, 0, m.pos.x - b.maxX), dz = Math.max(b.minZ - m.pos.z, 0, m.pos.z - b.maxZ);
      const dh = Math.hypot(dx, dz);
      let dmg = 0, knock = null;
      if (dh <= m.radius * 0.6 && m.pos.y >= newTop - 1.5 && m.pos.y <= oldTop + 3) {
        // standing or hovering on the part that is coming down: it falls with it
        dmg = clamp(60 + 35 * lost, 60, 380);
      } else if (dh <= R && m.pos.y < oldTop) {
        const k = 1 - dh / R;
        dmg = clamp((40 + 22 * lost) * k, 0, 300);
        const ax = m.pos.x - b.cx, az = m.pos.z - b.cz, al = Math.hypot(ax, az) || 1;
        knock = new THREE.Vector3((ax / al) * 85 * k, 22 * k, (az / al) * 85 * k);
      }
      if (dmg < 20) continue;
      m._collapseT = now;
      m.takeDamage(dmg, { kind: 'collapse', knock, stagger: dmg >= 110, point: m.center(new THREE.Vector3()) });
    }
  }

  // ------------------------------------------------------------------ smoke

  _emitter(x, y, z, life, fire) {
    if (this.emitters.length >= MAX_EMITTERS) this.emitters.shift();
    this.emitters.push({ x, y, z, t: 0, life, fire, acc: 0 });
  }

  // ------------------------------------------------------------------ per step

  update(dt) {
    // roof sections squashing down
    for (let i = this.slabs.length - 1; i >= 0; i--) {
      const s = this.slabs[i];
      s.t += dt;
      const u = clamp(s.t / s.dur, 0, 1);
      const e = u * u; // slow at first, then it gives way
      const squash = Math.max(0.02, 1 - e);
      s.group.scale.set(1 + 0.1 * e, squash, 1 + 0.1 * e);
      s.group.rotation.x = s.lean * Math.sin(u * Math.PI);
      s.group.rotation.y = s.spin * u;
      if (u >= 1) {
        this.scene.remove(s.group);
        s.mesh.geometry.dispose();
        this.slabs.splice(i, 1);
      }
    }
    // smouldering ruins
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.t += dt;
      if (e.t >= e.life) { this.emitters.splice(i, 1); continue; }
      e.acc += dt * 9 * (1 - e.t / e.life * 0.6);
      while (e.acc >= 1) { e.acc -= 1; this.game.fx.plume(e.x, e.y, e.z, e.fire); }
    }
  }

  /** Put the whole city back (a new sortie): every standing building at full height, every ruin rebuilt. */
  reset() {
    const world = this.world;
    for (const s of this.slabs) { this.scene.remove(s.group); s.mesh.geometry.dispose(); }
    this.slabs.length = 0;
    this.emitters.length = 0;
    this.collapses = 0;
    this.leveled = 0;
    for (const b of world.allBuildings) {
      if (!b.changed) { b.floorDmg.fill(0); continue; }
      b.changed = false;
      this._drop(b.crown);
      this._drop(b.rubble);
      b.crown = b.rubble = null;
      if (!world.boxes.includes(b)) world.boxes.push(b);
      b.top = b.h0;
      b.n = b.n0;
      b.floorDmg.fill(0);
      b.mesh.geometry.dispose();
      b.mesh.geometry = world.buildingGeo(b, 0, b.h0);
      b.mesh.position.y = b.h0 / 2;
      b.mesh.visible = true;
      for (const p of b.props) { p.gone = false; p.mesh.visible = true; }
      b.lastDecal = -1;
      b.smokeUntil = -1;
    }
    this._hideAllDecals();
    this._decalNext = 0;
  }
}
