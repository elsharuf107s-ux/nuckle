// Everything that moves in the world besides Steve: Minecraft mobs (grid-walking the way FireRed's
// people do), dropped items, experience orbs, arrows, primed TNT, boats, the fishing bobber, and
// particles. Mobs, TNT and boats are drawn in the GBA layer; items, orbs and particles in the
// full-resolution layer, as Minecraft draws them finer than the world.
import { A } from './assets.js';
import { G, TILE, DIRS, OPP, DIR_LIST, dirTo } from './game.js';
import { item } from './items.js';
import { mc } from './audio.js';
import * as RNG from './rng.js';
import { NET } from './net/flag.js';   // co-op: false in single-player (src/net/host.js runs the shared world)

const MOBS = () => A.items.mobs;
export const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'ghast', 'magma_cube', 'blaze', 'wither_skeleton', 'silverfish', 'husk', 'stray']);
// a skeleton or a stray (5d: a snowy biome's skeleton, whose arrows slow Steve); a husk is a zombie that never burns
const ARCHER = (k) => k === 'skeleton' || k === 'stray';
// A mob's hit on the player by difficulty (generated worlds: main.js sets G.mobDmg from src/modes.js; Peaceful's
// spawner mobs deal nothing). Classic: the number as ever.
const hit = (d) => (G.mobDmg ? G.mobDmg(d) : d);
// Peaceful (6.2): no natural hostile spawns (endermen stay, so pearls still drop; spawners keep working)
const peaceful = () => !!(G.mr && !G.mr.naturalHostiles);
// the Nether's neutral mob: leaves Steve alone until he hits one, then the whole group comes for him
export const NEUTRAL = new Set(['zombified_piglin', 'enderman']);
const FOOT = 13;   // feet sit this far down a tile
// seconds a ghast or blaze rests after firing, on top of its own 3 to 5: with no cover to duck behind in a
// top-down world, Minecraft's own rate wore a player down too fast
const FLYER_REST = 2;

// ---------------------------------------------------------------- sprite helpers
const tintCache = new Map();
export function tintedFrame(img, sx, sy, w, h, color) {
  const key = img.src + '|' + sx + '|' + sy + '|' + color;
  let c = tintCache.get(key);
  if (!c) {
    c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.drawImage(img, sx, sy, w, h, 0, 0, w, h);
    x.globalCompositeOperation = 'source-atop'; x.fillStyle = color; x.fillRect(0, 0, w, h);
    tintCache.set(key, c);
  }
  return c;
}
// Draw a frame with Minecraft's damage tint, a white flash and an optional death tilt.
export function drawFrame(ctx, img, frame, fw, fh, x, y, { red = 0, white = 0, tilt = 0, origin = null, alpha = 1 } = {}) {
  const sx = frame * fw;
  ctx.save();
  if (alpha < 1) ctx.globalAlpha = alpha;
  if (tilt) {
    const ox = x + (origin ? origin[0] : fw / 2), oy = y + (origin ? origin[1] : fh);
    ctx.translate(ox, oy); ctx.rotate(tilt); ctx.translate(-ox, -oy);
  }
  ctx.drawImage(img, sx, 0, fw, fh, Math.round(x), Math.round(y), fw, fh);
  if (red > 0) { ctx.globalAlpha = alpha * Math.min(1, red); ctx.drawImage(tintedFrame(img, sx, 0, fw, fh, '#ff2020'), Math.round(x), Math.round(y)); }
  if (white > 0) { ctx.globalAlpha = alpha * Math.min(1, white); ctx.drawImage(tintedFrame(img, sx, 0, fw, fh, '#ffffff'), Math.round(x), Math.round(y)); }
  ctx.restore();
}

// ---------------------------------------------------------------- particles (world px, drawn at full res)
export function particle(p) { G.parts.push({ z: 0, vz: 0, g: 0, life: 0.5, age: 0, size: 2, ...p }); }
// Fragments of whatever broke, coloured from its own pixels.
export function breakParticles(x, y, colors, n = 14, lift = 6) {
  for (let i = 0; i < n; i++) {
    particle({ x: x + 2 + Math.random() * 12, y: y + 4 + Math.random() * 10, z: lift * Math.random(), vx: (Math.random() - 0.5) * 50, vy: (Math.random() - 0.5) * 30,
      vz: 30 + Math.random() * 40, g: -160, life: 0.5 + Math.random() * 0.5, color: colors[(Math.random() * colors.length) | 0], size: 1 + Math.random() * 2, bounce: true });
  }
}
export function spriteParticle(img, frames, x, y, opts = {}) {
  particle({ x, y, img, frames, fw: opts.fw || img.height, life: opts.life || 0.6, scale: opts.scale || 1, vx: opts.vx || 0, vy: opts.vy || 0, vz: opts.vz || 0, z: opts.z || 0, g: opts.g || 0, size: 0 });
}
export function poof(x, y, n = 8) {
  for (let i = 0; i < n; i++) spriteParticle(A.mc.pGeneric, 8, x + (Math.random() - 0.5) * 10, y + (Math.random() - 0.5) * 6, { life: 0.4 + Math.random() * 0.5, vz: 10 + Math.random() * 20, z: 6, vx: (Math.random() - 0.5) * 20, scale: 2 });
}
export function updateParticles(dt) {
  for (let i = G.parts.length - 1; i >= 0; i--) {
    const p = G.parts[i];
    p.age += dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vz += p.g * dt;
    if (p.bounce && p.z < 0) { p.z = 0; p.vz = -p.vz * 0.25; p.vx *= 0.5; p.vy *= 0.5; }
    if (p.age >= p.life) G.parts.splice(i, 1);
  }
}
export function drawParticles(ctx, cam) {
  for (const p of G.parts) {
    const sx = (p.x - cam.x) * 2, sy = (p.y - p.z - cam.y) * 2;
    if (p.img) {
      const f = Math.min(p.frames - 1, Math.floor((p.age / p.life) * p.frames));
      const w = p.fw * p.scale, h = p.img.height * p.scale;
      ctx.globalAlpha = p.alpha || 1;
      ctx.drawImage(p.img, f * p.fw, 0, p.fw, p.img.height, Math.round(sx - w / 2), Math.round(sy - h / 2), w, h);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = p.color;
      const s = Math.max(1, Math.round(p.size * (1 - 0.4 * p.age / p.life)));
      ctx.fillRect(Math.round(sx), Math.round(sy), s, s);
    }
  }
}

// ---------------------------------------------------------------- dropped items and XP orbs
export function dropItem(id, n, x, y, extra = {}, opts = {}) {
  if (!id || n <= 0) return;
  const e = { type: 'item', stack: { id, n, ...extra }, x: x + 8, y: y + 8, z: 4, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 20, vz: 50 + Math.random() * 20,
    age: 0, delay: opts.delay != null ? opts.delay : 0.5, spin: Math.random() * 6 };
  if (opts.thrown) { const d = DIRS[G.P.dir]; e.vx = d.x * 70; e.vy = d.y * 70; e.vz = 40; e.delay = 2; }
  G.ents.push(e);
  return e;
}
export function dropOrbs(total, x, y) {
  // Minecraft splits experience into orbs of 1, 3, 7, 17...
  const sizes = [2477, 1237, 617, 307, 149, 73, 37, 17, 7, 3, 1];
  while (total > 0) {
    const v = sizes.find((s) => s <= total) || 1;
    total -= v;
    G.ents.push({ type: 'xp', value: v, x: x + 8 + (Math.random() - 0.5) * 8, y: y + 8 + (Math.random() - 0.5) * 8, z: 3, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 30, vz: 40 + Math.random() * 30, age: 0, delay: 0.4 });
  }
}
function updateDrops(e, dt) {
  const P = NET.h ? NET.h.picker(e) : G.P;   // co-op host: the nearest player who can take it
  e.age += dt;
  const ox = e.x, oy = e.y;
  e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt; e.vz -= 200 * dt;
  // thrown by a blast, it stops at the first wall (lava doesn't stop it: it burns there) instead of flying
  // on into the rock, where nobody could reach it
  if (e.blast) {
    const W = G.world, wall = (x, y) => { const cx = Math.floor(x / TILE), cy = Math.floor(y / TILE); return W.solid(cx, cy) && !W.isLava(cx, cy); };
    if (!wall(ox, oy)) {
      if (wall(e.x, oy)) { e.x = ox; e.vx = 0; }
      if (wall(e.x, e.y)) { e.y = oy; e.vy = 0; }
    }
  }
  if (e.z < 0) { e.z = 0; e.vz = -e.vz * 0.3; e.vx *= 0.4; e.vy *= 0.4; if (Math.abs(e.vz) < 8) e.vz = 0; }
  e.vx *= Math.pow(0.2, dt); e.vy *= Math.pow(0.2, dt);
  // an item that comes down in lava burns up (netherite doesn't)
  if (e.type === 'item' && e.z <= 0.5 && G.world.isLava(Math.floor(e.x / TILE), Math.floor(e.y / TILE)) && !(item(e.stack.id) && item(e.stack.id).fireproof)) {
    e.dead = true;
    mc('fizz', { vol: 0.35, pitch: 2 + Math.random() * 0.4 });
    for (let i = 0; i < 5; i++) particle({ x: e.x + (Math.random() - 0.5) * 6, y: e.y, z: 2, vz: 12 + Math.random() * 10, vx: (Math.random() - 0.5) * 8, life: 0.8, img: A.mc.pSmoke, frames: 12, fw: 16, size: 0, scale: 0.9 });
    return;
  }
  // The End's void takes whatever comes down over it (a bridge or the platform holds it up)
  if (e.z <= 0.5 && G.world.isEndVoid && G.world.isEndVoid(Math.floor(e.x / TILE), Math.floor(e.y / TILE))) { e.dead = true; return; }
  if (!P || P.dead || P.sleeping || e.age < e.delay) return;
  if (P === G.P && G.mr && !G.mr.pickUp) return;   // a spectator picks nothing up (6.4)
  const px = P.fx * TILE + 8, py = P.fy * TILE + 10;
  const d = Math.hypot(px - e.x, py - e.y);
  const range = e.type === 'xp' ? 7 * TILE : 1.6 * TILE;
  if (d < range) {
    const pull = e.type === 'xp' ? 140 * (1 - d / range) + 40 : 120;
    if (d > 3) { e.x += ((px - e.x) / d) * pull * dt; e.y += ((py - e.y) / d) * pull * dt; }
    if (d < 9) {
      if (P !== G.P) { NET.h.give(P, e); return; }   // co-op: a guest's pickup (the host sends it over)
      if (e.type === 'xp') { G.giveXp(e.value); e.dead = true; return; }
      const left = G.inv.add(e.stack.id, e.stack.n, e.stack.dmg ? { dmg: e.stack.dmg } : {});
      if (left < e.stack.n) {
        mc('pop', { vol: 0.2, pitch: 1.4 + Math.random() * 0.6 });
        if (G.onPickup) G.onPickup(e.stack.id, e.stack.n - left);
      }
      e.stack.n = left;
      if (left <= 0) e.dead = true;
    }
  }
  if (e.age > 300) e.dead = true;
}
function drawDrop(ctx, e, cam) {
  const bob = Math.sin(e.age * 3 + e.spin) * 1.5;
  const sx = (e.x - cam.x) * 2, sy = (e.y - cam.y - e.z - bob - 3) * 2;
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(Math.round(sx - 5), Math.round((e.y - cam.y + 2) * 2), 10, 2);
  if (e.type === 'xp') {
    const f = Math.min(10, e.value >= 17 ? 6 : e.value >= 7 ? 4 : e.value >= 3 ? 2 : 0) + (Math.floor(e.age * 8) % 2);
    const hue = Math.sin(e.age * 6) * 0.5 + 0.5;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(A.mc.orb, (f % 4) * 16, Math.floor(f / 4) * 16, 16, 16, Math.round(sx - 8), Math.round(sy - 8), 16, 16);
    ctx.globalAlpha = 0.25 * hue; ctx.drawImage(A.mc.orb, (f % 4) * 16, Math.floor(f / 4) * 16, 16, 16, Math.round(sx - 8), Math.round(sy - 8), 16, 16);
    ctx.globalAlpha = 1;
    return;
  }
  // Minecraft spins dropped items; flat icons squash horizontally to fake it
  const it = item(e.stack.id);
  const flat = it && !(it.block && it.block.look === 'raised');
  const w = flat ? Math.max(2, Math.abs(Math.cos(e.age * 1.6 + e.spin)) * 14) : 14;
  const i = it.iconIndex;
  ctx.drawImage(A.mc.icons, (i % 32) * 16, Math.floor(i / 32) * 16, 16, 16, Math.round(sx - w / 2), Math.round(sy - 7), Math.round(w), 14);
  if (e.stack.n > 1) ctx.drawImage(A.mc.icons, (i % 32) * 16, Math.floor(i / 32) * 16, 16, 16, Math.round(sx - w / 2 + 2), Math.round(sy - 9), Math.round(w), 14);
}

// ---------------------------------------------------------------- mobs
// a mob standing in (or stepping out of) a cell; ghasts and blazes float above the ground and block nothing
export function mobAt(x, y) { return G.ents.find((e) => e.type === 'mob' && !e.dying && !e.fly && ((e.tx === x && e.ty === y) || (e.moving && e.fromX === x && e.fromY === y))) || null; }
// a floating mob over a point (cells), within r cells (a ghast's bulk counts half as much again)
export function flyerNear(x, y, r = 1) { return G.ents.find((e) => e.type === 'mob' && e.fly && !e.dying && Math.hypot(e.fx - x, e.fy - y) <= r * (e.kind === 'ghast' ? 1.6 : 1)) || null; }
export function cellFree(x, y, forMob = null) {
  const W = G.world;
  // a lit portal's cells hold nobody but Steve (its frame would shut a mob in)
  if (W.solid(x, y) || W.isWater(x, y) || W.jumpDir(x, y) || W.isPortal(x, y)) return false;
  if (W.pcDoor(x, y) || W.warpAt(x, y) || (G.npcAt && G.npcAt(x, y)) || (G.wildAt && G.wildAt(x, y))) return false;
  const P = G.P;
  if (NET.on) { for (const p of NET.players()) if (p && !p.dead && ((p.tx === x && p.ty === y) || (p.moving && p.fromX === x && p.fromY === y))) return false; }
  else if (P && !P.dead && ((P.tx === x && P.ty === y) || (P.moving && P.fromX === x && P.fromY === y))) return false;
  const m = mobAt(x, y);
  if (m && m !== forMob) return false;
  if (G.ents.some((e) => (e.type === 'boat' || e.type === 'tnt') && e.tx === x && e.ty === y)) return false;
  return true;
}
// nothing standing or floating in the cell (water allowed)
export function noEntityAt(x, y, except = null) {
  if (mobAt(x, y)) return false;
  return !G.ents.some((e) => e !== except && (e.type === 'boat' || e.type === 'tnt') && e.tx === x && e.ty === y);
}
export function spawnMob(kind, tx, ty, opts = {}) {
  const def = MOBS()[kind];
  const m = { type: 'mob', kind, tx, ty, fx: tx, fy: ty, fromX: tx, fromY: ty, moving: false, prog: 0, dir: DIR_LIST[RNG.randInt(4)],
    hp: def.hp, maxHp: def.hp, hurt: 0, invuln: 0, think: Math.random(), cool: 0, fuse: 0, burn: 0, panic: 0, step: def.step,
    sheared: false, aim: 0, persistent: !!opts.persistent, age: 0, knock: null };
  if (def.fly) Object.assign(m, { fly: true, home: { x: tx, y: ty }, phase: Math.random() * 6, charge: 0, burst: 0, cool: 1.5 + Math.random() * 2 });
  if (def.sizes) { m.size = def.sizes[opts.size] ? opts.size : 'large'; m.hp = m.maxHp = def.sizes[m.size].hp; m.hopT = Math.random(); }
  G.ents.push(m);
  return m;
}
const sheetKey = (m) => (m.kind === 'magma_cube' ? 'magma_cube_' + (m.size || 'large') : m.look != null ? m.kind + '_' + m.look : m.kind);   // (7b: a villager's or golem's look, src/villagers.js)
function stepMob(m, dir, speedMul = 1) {
  const d = DIRS[dir];
  m.dir = dir;
  const nx = m.tx + d.x, ny = m.ty + d.y;
  if (!cellFree(nx, ny, m)) return false;
  m.fromX = m.tx; m.fromY = m.ty; m.tx = nx; m.ty = ny; m.moving = true; m.prog = 0; m.speedMul = speedMul;
  if (NET.h) NET.h.step(m, m.step / (speedMul || 1));
  const def = MOBS()[m.kind];
  if (Math.random() < 0.35 && A.sfx[m.kind + '.step']) mc(m.kind + '.step', { vol: 0.12 * nearVol(m) });
  void def;
  return true;
}
// Breadth-first search for the first step toward a cell next to (gx, gy).
function pathStep(m, gx, gy, limit = 700) {
  const W = G.world;
  const key = (x, y) => x * 4096 + y;
  const start = key(m.tx, m.ty);
  const prev = new Map([[start, null]]);
  const q = [[m.tx, m.ty]];
  let found = null, n = 0;
  while (q.length && n++ < limit) {
    const [x, y] = q.shift();
    if (Math.abs(x - gx) + Math.abs(y - gy) === 1) { found = [x, y]; break; }
    for (const dname of DIR_LIST) {
      const d = DIRS[dname];
      const nx = x + d.x, ny = y + d.y, k = key(nx, ny);
      if (prev.has(k)) continue;
      if (Math.abs(nx - m.tx) > 18 || Math.abs(ny - m.ty) > 18) continue;
      if (!(nx === gx && ny === gy) && !cellFree(nx, ny, m)) continue;
      if (nx === gx && ny === gy) continue;
      prev.set(k, [x, y]);
      q.push([nx, ny]);
    }
  }
  if (!found) return null;
  let cur = found, p = prev.get(key(cur[0], cur[1]));
  if (!p) return null;
  while (p && !(p[0] === m.tx && p[1] === m.ty)) { cur = p; p = prev.get(key(cur[0], cur[1])); }
  return dirTo(m.tx, m.ty, cur[0], cur[1]);
  void W;
}
function nearVol(m) { const P = G.P; const d = Math.hypot(m.fx - P.fx, m.fy - P.fy); return Math.max(0, 1 - d / 16); }
// the world update's villagers and golems (stage 7b, src/villagers.js) walk with these
export const mobKit = { stepMob, pathStep, nearVol };
const isDark = () => G.lightAt ? (x, y) => G.lightAt(x, y) < 8 : () => true;

// One map for Classic (as before); in generated layouts the same regionKey, so a biome edge never hides Steve (2.10).
const sameArea = (W, ax, ay, bx, by) => (W.layout.gen ? W.regionKey(ax, ay) === W.regionKey(bx, by) : W.areaOf(ax, ay) === W.areaOf(bx, by));

// ---------------------------------------------------------------- the Nether's floating mobs and magma cubes
// Ghasts and blazes float free of the grid (fx, fy in cells), over walls and lava: a ghast keeps 6 to 12 cells
// from Steve and every few seconds opens its mouth and spits a fireball; a blaze hovers near where it
// appeared, lights up and fires three small fireballs. Their tx, ty are the cell under them.
function updateFlyer(m, dt, def) {
  const P = NET.on ? NET.target(m) : G.P, W = G.world;
  m.phase += dt;
  if (m.cool > 0) m.cool -= dt;
  const area = W.areaOf(m.home.x, m.home.y);
  const dx = P.fx - m.fx, dy = P.fy - m.fy, dist = Math.hypot(dx, dy);
  const canSee = !P.dead && !P.hidden && !(NET.on ? NET.busy(P) : G.busy()) && W.areaOf(P.tx, P.ty) === area;
  m.think -= dt;
  if (m.think <= 0 || !m.goal) {
    m.think = 2 + Math.random() * 3;
    const a = Math.random() * Math.PI * 2;
    if (m.kind === 'ghast') {
      // keep[0] (6) cells or more off, low and to one side, its whole body where Steve can see it: the view is
      // 15 x 10 cells around him and the 72-px body hangs above its cell, so 2.6 to 3.9 cells down and at most
      // 5.6 across (6.2 to 6.5 cells off) keeps every pixel of it on screen and clear of the hotbar. (The far
      // half of keep, up to 12, would be off screen.) One that doesn't see him drifts anywhere.
      const lo = (def.keep || [6, 12])[0], side = (m.fx < P.fx ? -1 : 1) * (Math.random() < 0.8 ? 1 : -1);
      if (canSee && dist < 26) {
        const oy = 2.6 + Math.random() * 1.3;
        const ox = Math.min(5.6, Math.max(4.9, Math.sqrt(Math.max(0, (lo + 0.5) * (lo + 0.5) - oy * oy))));
        m.goal = { x: P.fx + side * ox, y: P.fy + oy };
      } else m.goal = { x: m.fx + (Math.random() - 0.5) * 12, y: m.fy + (Math.random() - 0.5) * 8 };
    } else {
      const r = 2.5 + Math.random() * 3;
      const near = canSee && dist < 14;
      m.goal = near ? { x: P.fx + Math.cos(a) * r, y: P.fy + Math.sin(a) * r * 0.75 } : { x: m.home.x + Math.cos(a) * r, y: m.home.y + Math.sin(a) * r * 0.6 };
      // a blaze never wanders far from its platform
      const hx = m.goal.x - m.home.x, hy = m.goal.y - m.home.y, hd = Math.hypot(hx, hy);
      if (hd > 7) { m.goal.x = m.home.x + hx / hd * 7; m.goal.y = m.home.y + hy / hd * 7; }
    }
    // never out of its own map (the Nether's edge)
    if (area) { m.goal.x = Math.max(area.x + 2, Math.min(area.x + area.w - 3, m.goal.x)); m.goal.y = Math.max(area.y + 2, Math.min(area.y + area.h - 3, m.goal.y)); }
  }
  let gx = m.goal.x - m.fx, gy = m.goal.y - m.fy, gd = Math.hypot(gx, gy);
  // a ghast opening its mouth hangs almost still, so the warning stays where Steve saw it
  const sp = (m.kind === 'ghast' ? (m.charge > 0 ? 0.25 : 1.3) : 1.6) * dt;
  if (m.kind === 'ghast' && canSee && dist > 0.01) {
    // keep its distance: never fly in through Steve's ring of keep[0] cells. Inside or on it, the part of its course
    // that heads toward him is turned into a sweep round the ring (over or under him, whichever side it is on), plus
    // a push straight out when it is already too close.
    const lo = (def.keep || [6, 12])[0] - 0.2, ux = -dx / dist, uy = -dy / dist;
    if (dist < lo + 0.3) {
      let ax = gd > 0.05 ? gx / gd : 0, ay = gd > 0.05 ? gy / gd : 0;
      const inward = ax * ux + ay * uy;
      if (inward < 0) {
        ax -= inward * ux; ay -= inward * uy;
        // crossing to Steve's other side, it goes round below him: its body hangs above its cell, so passing
        // over him would take it off the top of the screen
        const crossing = Math.sign(m.goal.x - P.fx) !== Math.sign(m.fx - P.fx);
        if (crossing || (Math.hypot(ax, ay) < 0.2 && gd > 0.5)) { ax = -uy; ay = ux; if (ay < 0 || (ay === 0 && ax * (m.goal.x - m.fx) < 0)) { ax = -ax; ay = -ay; } }
      }
      const out = dist < lo ? Math.min(1.5, (lo - dist) * 0.8) : 0;
      const vx = ax + ux * out, vy = ay + uy * out, vd = Math.hypot(vx, vy);
      if (vd > 0.01) { const k = Math.min(sp, Math.max(gd, out) ) / vd; m.fx += vx * k; m.fy += vy * k; }
    } else if (gd > 0.05) { const k = Math.min(gd, sp) / gd; m.fx += gx * k; m.fy += gy * k; }
  } else if (gd > 0.05) { const k = Math.min(gd, sp) / gd; m.fx += gx * k; m.fy += gy * k; }
  // never out over the void past its own map's edge, whatever the keep-distance push says (as its goal)
  if (area) { m.fx = Math.max(area.x + 2, Math.min(area.x + area.w - 3, m.fx)); m.fy = Math.max(area.y + 2, Math.min(area.y + area.h - 3, m.fy)); }
  m.watch = canSee && dist < 18;
  m.dir = m.watch ? dirTo(m.fx, m.fy, P.fx, P.fy) : gd > 0.3 ? dirTo(0, 0, gx, gy) : m.dir;
  m.tx = Math.round(m.fx); m.ty = Math.round(m.fy);
  // sounds: the ghast's moan, the blaze's breathing
  if (Math.random() < dt / (m.kind === 'ghast' ? 6 : 5)) mc(m.kind === 'ghast' ? 'ghast.moan' : 'blaze.say', { vol: 0.6 * nearVol(m) });
  // attacking
  // a ghast only opens its mouth where Steve can see its face (on screen and not behind the hotbar); if he
  // turns it off screen mid wind-up, it shuts its mouth and starts again once he can see it
  const seen = m.kind !== 'ghast' || faceInView(m, NET.on ? P : null);
  if (canSee && seen && dist <= (m.kind === 'ghast' ? 16 : 12) && m.cool <= 0 && !m.charge && !m.burst) {
    m.charge = 0.001;
    mc(m.kind === 'ghast' ? 'ghast.warn' : 'blaze.burn', { vol: 0.8 * nearVol(m) + 0.1 });
  }
  if (m.charge && m.kind === 'ghast' && (!canSee || !seen)) m.charge = 0;
  if (m.charge) {
    m.charge += dt;
    if (m.kind === 'ghast' && m.charge >= 0.6) { shootFireball(m, 'large', NET.on ? { x: P.fx * TILE + 8, y: P.fy * TILE + 8 } : null); m.charge = 0; m.attackT = 0.4; m.cool = FLYER_REST + (def.fireball.every[0] + Math.random() * (def.fireball.every[1] - def.fireball.every[0])); }
    if (m.kind === 'blaze' && m.charge >= 1.0) { m.charge = 0; m.burst = def.fireball.burst || 3; m.burstT = 0; }
  }
  if (m.burst > 0) {
    m.burstT -= dt;
    if (m.burstT <= 0) { shootFireball(m, 'small', NET.on ? { x: P.fx * TILE + 8, y: P.fy * TILE + 8 } : null); m.burst--; m.burstT = 0.3; if (!m.burst) m.cool = FLYER_REST + def.fireball.every[0] + Math.random() * (def.fireball.every[1] - def.fireball.every[0]); }
  }
  // a blaze right beside Steve also burns him by touch
  if (m.kind === 'blaze' && canSee && dist < 1.2 && (m.touchT || 0) <= 0) { m.touchT = 1; if (NET.on) NET.hurt(P, hit(def.dmg), ['blaze'], m); else G.hurtPlayer(hit(def.dmg), `${P.name} was slain by Blaze`, m); }
  if (m.touchT > 0) m.touchT -= dt;
}
// Whether Steve can see a ghast's face (its eyes and mouth), placed as drawFlyers draws it against the camera
// (GBA pixels): its body (the drawn part of its 48 x 72 frame) wholly inside the 240 x 160 view, side to side
// and at the top (only the tentacle tips may hang off the bottom), and the face box clear of the HUD (the
// hotbar, experience bar, hearts, hunger and armor rows: x 74 to 166, from y 135 down).
const GHAST_BODY = [7, 16, 41, 72], GHAST_FACE = [10, 34, 38, 62], HUD_BOX = [74, 135, 166, 160];
export function faceInView(m, viewer = null) {
  const cam = viewer && viewer !== G.P ? { x: viewer.fx * TILE + 8 - 120, y: viewer.fy * TILE + 8 - 80 } : G.cam, sheet = A.items.mobSheets && A.items.mobSheets[sheetKey(m)];
  if (!cam || !sheet) return true;
  const sx = m.fx * TILE + 8 - sheet.origin[0] - cam.x, sy = m.fy * TILE + FOOT - sheet.origin[1] - cam.y - mobLift(m);
  if (sx + GHAST_BODY[0] < 0 || sx + GHAST_BODY[2] > 240 || sy + GHAST_BODY[1] < 0 || sy + GHAST_BODY[3] > 168) return false;
  const x0 = sx + GHAST_FACE[0], y0 = sy + GHAST_FACE[1], x1 = sx + GHAST_FACE[2], y1 = sy + GHAST_FACE[3];
  if (y1 > 160) return false;
  return !(x1 > HUD_BOX[0] && x0 < HUD_BOX[2] && y1 > HUD_BOX[1] && y0 < HUD_BOX[3]);
}
// Magma cubes hop: a crouch, a leap of one cell (toward Steve when they see him), a squash on landing.
// Damage by size when they reach him.
function updateCube(m, dt, def) {
  const P = NET.on ? NET.target(m) : G.P, sz = def.sizes[m.size] || def.sizes.large;
  if (m.squash > 0) m.squash -= dt;
  if (m.cool > 0) m.cool -= dt;
  m.hopT -= dt;
  const dx = P.tx - m.tx, dy = P.ty - m.ty, man = Math.abs(dx) + Math.abs(dy);
  const canSee = !P.dead && !P.hidden && !(NET.on ? NET.busy(P) : G.busy()) && G.world.areaOf(P.tx, P.ty) === G.world.areaOf(m.tx, m.ty);
  if (canSee && man === 1 && m.cool <= 0) {
    m.dir = dirTo(m.tx, m.ty, P.tx, P.ty); m.cool = 1; m.squash = 0.2;
    if (NET.on) NET.hurt(P, hit(sz.dmg), ['magma'], m); else G.hurtPlayer(hit(sz.dmg), `${P.name} was slain by Magma Cube`, m);
    return;
  }
  if (m.hopT > 0) { if (m.hopT < 0.18) m.squash = Math.max(m.squash, m.hopT); return; }
  const chase = canSee && man < 16;
  m.hopT = chase ? 0.55 + Math.random() * 0.5 : 1.4 + Math.random() * 2.4;
  const dir = chase ? pathStep(m, P.tx, P.ty) || dirTo(m.tx, m.ty, P.tx, P.ty) : DIR_LIST[Math.floor(Math.random() * 4)];
  if (stepMob(m, dir, 1.5)) { m.hop = true; mc('magma_cube.jump', { vol: 0.45 * nearVol(m) }); }
}

// ---------------------------------------------------------------- fireballs
// A ghast's fireball flies slowly in a straight line (any angle) and explodes where it hits: power 1, setting
// fires, never breaking protected cells. Steve can bat it back with an attack: it flies home at its ghast.
// A blaze's small fireballs don't explode; they burn what they hit. Positions are world pixels on the
// ground plane, z the height it flies at.
export function shootFireball(owner, size, aim = null) {
  const P = G.P, def = MOBS()[owner.kind];
  const ox = owner.fx * TILE + 8, oy = owner.fy * TILE + 8;
  const tx = aim ? aim.x : P.fx * TILE + 8, ty = aim ? aim.y : P.fy * TILE + 8;
  let dx = tx - ox, dy = ty - oy;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  if (size === 'small') { const a = (Math.random() - 0.5) * 0.22, c = Math.cos(a), s = Math.sin(a); [dx, dy] = [dx * c - dy * s, dx * s + dy * c]; }
  const speed = size === 'large' ? 80 : 125;
  G.ents.push({ type: 'fireball', size, x: ox + dx * 10, y: oy + dy * 10, z: size === 'large' ? 30 : 16, vx: dx * speed, vy: dy * speed, owner, t: 0, armed: false,
    fromPlayer: false, power: def.fireball ? def.fireball.power : 1, dmg: def.fireball ? def.fireball.dmg : 5, last: null });
  mc('fireball', { vol: 0.7 * nearVol(owner) + 0.1, pitch: size === 'small' ? 1.25 : 1 });
}
function updateFireball(f, dt) {
  const P = G.P, W = G.world;
  f.t += dt;
  const steps = 3;
  for (let i = 0; i < steps; i++) {
    f.x += (f.vx * dt) / steps; f.y += (f.vy * dt) / steps;
    f.z += (7 - f.z) * Math.min(1, (dt * 1.1) / steps);
    const cx = Math.floor(f.x / TILE), cy = Math.floor(f.y / TILE);
    // walls stop it; it flies over lava and portals. Shot from above a wall, it arms once it is over open ground.
    const wall = !W.inside(cx, cy) || W.isVoid(cx, cy) || (W.solid(cx, cy) && !W.isLava(cx, cy));
    if (!wall) { f.armed = true; f.last = [cx, cy]; }
    else if (f.armed) {
      // a small fireball burns the last open cell it crossed; one batted back before it ever crossed open
      // ground has none, so it just fizzles on the wall cell (fireballHit sets fire only on floor)
      const at = f.size === 'large' || !f.last ? [cx, cy] : f.last;
      fireballHit(f, at[0], at[1], null); return;
    }
    if (NET.on) { const v = !f.fromPlayer && NET.h && NET.h.victim(f.x, f.y, 9); if (v) { fireballHit(f, v.tx, v.ty, v); return; } }
    else if (!f.fromPlayer && !P.dead && Math.hypot(P.fx * TILE + 8 - f.x, P.fy * TILE + 8 - f.y) < 9) { fireballHit(f, P.tx, P.ty, P); return; }
    if (f.fromPlayer) {
      const m = mobAt(cx, cy) || flyerNear((f.x - 8) / TILE, (f.y - 8) / TILE, 1);
      if (m && (m !== f.owner || f.t > 0.25)) { fireballHit(f, cx, cy, m); return; }
    }
  }
  if (Math.random() < dt * (f.size === 'large' ? 22 : 12)) particle({ x: f.x, y: f.y, z: f.z, vz: 4, life: 0.5, img: A.mc.pSmoke, frames: 12, fw: 16, size: 0, scale: f.size === 'large' ? 1 : 0.6 });
  if (f.t > 8) f.dead = true;
}
function fireballHit(f, cx, cy, who) {
  const P = G.P, W = G.world;
  f.dead = true;
  if (who && who !== P && (!NET.on || who.type === 'mob')) {
    // sent back: a ghast's own fireball kills it outright (Minecraft gives it 1000 damage)
    const dmg = who.kind === 'ghast' ? 1000 : f.size === 'large' ? 6 : f.dmg;
    if (hurtMob(who, dmg, { x: Math.round(f.x / TILE - f.vx / 200), y: Math.round(f.y / TILE - f.vy / 200) }, { player: true })) {
      who.byPlayer = true;
      // co-op: batted back by a guest, the kill and the advancement are that guest's
      if (NET.h && f.ownerSlot) { who.bySlot = who.aggroSlot = f.ownerSlot; if (who.dying && who.kind === 'ghast' && f.size === 'large') NET.h.adv(f.ownerSlot, 'return_to_sender'); }
      else if (who.dying && who.kind === 'ghast' && f.size === 'large' && G.advance) G.advance('return_to_sender');
    }
  }
  if (f.size === 'large') {
    G.explode(cx, cy, f.power || 1, { kind: 'fireball', deathMsg: `${P.name} was fireballed by Ghast`, cause: ['fireball', 'Ghast'] }, { fire: true, noCrater: true });
    return;
  }
  // a small fireball: no blast; it burns Steve, or sets fire where it lands
  mc('fire', { vol: 0.5 * Math.max(0.2, 1 - Math.hypot(cx - P.tx, cy - P.ty) / 16), pitch: 1.4 });
  for (let i = 0; i < 6; i++) spriteParticle(A.mc.pFlame, 1, f.x + (Math.random() - 0.5) * 8, f.y, { life: 0.4 + Math.random() * 0.3, z: f.z, vz: 10 + Math.random() * 20, vx: (Math.random() - 0.5) * 30, fw: 8, scale: 1.5 });
  if (NET.on && who && who.type !== 'mob') { if (hit(f.dmg) > 0) NET.hurt(who, hit(f.dmg), ['fireball', 'Blaze'], f.owner, true, {}, { fire: 3 }); return; }
  if (who === P) { G.hurtPlayer(hit(f.dmg), `${P.name} was fireballed by Blaze`, f.owner, true); if (hit(f.dmg) > 0 && !(G.mr && !G.mr.damage)) P.fireT = Math.max(P.fireT || 0, 3); return; }
  if (!who && W.isFloor(cx, cy) && !W.block(cx, cy) && !W.noPlace(cx, cy) && !(P.tx === cx && P.ty === cy) && Math.random() < 0.6) W.setBlock(cx, cy, { id: 'fire', walk: true, t: 0, blast: true });
}
// Z near a fireball: Steve bats it away, back at the ghast if he is facing its way, else straight ahead.
export function deflectFireball(P, only = null) {
  if (NET.g && !only) return NET.g.deflect(P);
  const d = DIRS[P.dir];
  const hx = P.fx * TILE + 8 + d.x * 10, hy = P.fy * TILE + 8 + d.y * 10;
  const f = only ? (!only.dead && !only.fromPlayer && Math.hypot(only.x - hx, only.y - hy) < 30 ? only : null) : G.ents.find((e) => e.type === 'fireball' && !e.dead && !e.fromPlayer && Math.hypot(e.x - hx, e.y - hy) < 22);
  if (!f) return false;
  const speed = Math.hypot(f.vx, f.vy) * 1.3;
  let vx = d.x, vy = d.y;
  const o = f.owner;
  if (o && !o.dead && !o.dying) {
    const ox = o.fx * TILE + 8 - f.x, oy = o.fy * TILE + 8 - f.y, od = Math.hypot(ox, oy) || 1;
    if ((ox * d.x + oy * d.y) / od > 0) { vx = ox / od; vy = oy / od; }
  }
  f.vx = vx * speed; f.vy = vy * speed; f.fromPlayer = true; f.armed = true; f.t = 0;
  if (!f.last) f.last = [Math.floor(f.x / TILE), Math.floor(f.y / TILE)];
  mc('attack.strong', { vol: 0.8 });
  return true;
}
function drawFireball(ctx, f, cam) {
  const x = f.x - cam.x, y = f.y - f.z - cam.y;
  const s = f.size === 'large' ? 16 : 8;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 1, x, y, s);
  g.addColorStop(0, 'rgba(255,170,60,0.55)'); g.addColorStop(1, 'rgba(255,80,0,0)');
  ctx.fillStyle = g; ctx.fillRect(x - s, y - s, s * 2, s * 2);
  ctx.restore();
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y)); ctx.rotate(Math.floor(f.t * 12) * Math.PI / 2);
  ctx.drawImage(A.mc.fireball, -s / 2, -s / 2, s, s);
  ctx.restore();
  // its shadow on the ground
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.ellipse(Math.round(f.x - cam.x), Math.round(f.y - cam.y + 4), s / 3, 1.5, 0, 0, Math.PI * 2); ctx.fill();
}

export function hurtMob(m, dmg, from = null, opts = {}) {
  if (m.dying || m.invuln > 0) return false;
  if (NET.g && m.nid != null) return NET.g.hitMob(m, dmg, from, opts);
  // generated worlds (7b): nobody but a zombie hurts a villager; a golem a player hits turns on that player
  if (G.vil && (m.kind === 'villager' || m.kind === 'iron_golem') && !G.vil.onHurt(m, dmg, from, opts)) return false;   // co-op: the host's mob
  // an enderman dodges everything but a hand-to-hand blow: it teleports away (projectiles never touch it at all)
  const dodge = m.kind === 'enderman' && !(opts.player && opts.melee);
  if (dodge && opts.projectile) { teleportMob(m); return false; }
  m.hp -= dmg; m.hurt = 0.5; m.invuln = 0.5;
  // co-op host: a player's blow is the host's own unless the caller says whose (a guest's hit, arrow or fireball
  // sets bySlot after this), so the kill goes to whoever struck last
  if (NET.h && opts.player) m.bySlot = m.aggroSlot = 0;
  const def = MOBS()[m.kind];
  const small = m.size === 'small' || m.size === 'medium';
  const loud = !NET.on || NET.near(m.fx, m.fy);   // co-op: a fight beside a far-off guest is not heard here
  if (!loud) { /* silent */ } else if (small && A.sfx[m.kind + '.hurt_small']) mc(m.kind + '.hurt_small', { vol: 0.8 });
  else if (A.sfx[m.kind + '.hurt']) mc(m.kind + '.hurt', { vol: 0.8 }); else if (A.sfx[m.kind + '.say']) mc(m.kind + '.say', { vol: 0.8, pitch: 1.1 });
  if (opts.crit) for (let i = 0; i < 8; i++) spriteParticle(A.mc.pCrit, 1, m.fx * TILE + 8 + (Math.random() - 0.5) * 12, m.fy * TILE + 4, { life: 0.5, vz: 20 + Math.random() * 30, vx: (Math.random() - 0.5) * 60, z: 6, g: -40, fw: 8, scale: 2 });
  // knockback, one tile away from the hit if there is room
  if (from && m.hp > 0 && !m.fly) {
    const dname = dirTo(from.x, from.y, m.tx, m.ty);
    const d = DIRS[dname];
    const nx = m.tx + d.x * (opts.knock || 1), ny = m.ty + d.y * (opts.knock || 1);
    if (!m.moving && cellFree(nx, ny, m)) { m.fromX = m.tx; m.fromY = m.ty; m.tx = nx; m.ty = ny; m.moving = true; m.prog = 0; m.speedMul = 3.2; m.knocked = true; if (NET.h) NET.h.step(m, m.step / 3.2); }
  }
  if (!def.hostile && !def.neutral) m.panic = 4;
  if (m.kind === 'spider' || HOSTILE.has(m.kind)) m.angry = true;
  if (def.neutral && opts.player && m.kind !== 'enderman') angerGroup(m, def);
  if (m.kind === 'enderman' && opts.player) { m.angry = true; m.angerT = 30; m.stareT = 0; }
  // a hurt silverfish calls the others out of the infested blocks around it
  if (m.kind === 'silverfish' && G.onSilverfishHurt) G.onSilverfishHurt(m);
  if (m.hp <= 0) {
    m.dying = 0.001;
    m.killer = from;
    if (!loud) { /* silent */ } else if (A.sfx[m.kind + '.death']) mc(m.kind + '.death', { vol: 0.9 }); else if (small && A.sfx[m.kind + '.hurt_small']) mc(m.kind + '.hurt_small', { vol: 0.9, pitch: 0.8 }); else if (A.sfx[m.kind + '.hurt']) mc(m.kind + '.hurt', { vol: 0.9, pitch: 0.8 });
    m.fuse = 0;
  }
  if (dodge && m.hp > 0) teleportMob(m);
  return true;
}
// Hit one zombified piglin and every one within its group range turns on Steve, with the angry squeal.
function angerGroup(m, def) {
  let first = !m.angry;
  for (const e of G.ents) {
    if (e.type !== 'mob' || e.kind !== m.kind || e.dying || Math.hypot(e.tx - m.tx, e.ty - m.ty) > (def.group || 16)) continue;
    if (!e.angry) first = true;
    e.angry = true; e.angerT = 25 + Math.random() * 15;
  }
  if (first) mc(m.kind + '.angry', { vol: 0.9 * nearVol(m) + 0.1 });
}
function killMob(m) {
  const def = MOBS()[m.kind];
  const x = m.fx * TILE, y = m.fy * TILE;
  poof(x + 8, y + 8, 10);
  const sz = def.sizes && def.sizes[m.size];
  if (m.byPlayer !== false) {
    for (const [id, lo, hi, ch] of def.drops) {
      if (Math.random() > ch) continue;
      let n = lo + RNG.randInt(hi - lo + 1);
      if (id === 'white_wool' && m.sheared) n = 0;
      if (sz && m.size === 'small') n = 0;             // the smallest magma cubes drop nothing
      if (m.burnt && ['beef', 'porkchop', 'chicken', 'mutton'].includes(id)) { dropItem('cooked_' + id, n, x, y); continue; }
      if (n > 0) dropItem(id, n, x, y);
    }
    dropOrbs(sz ? sz.xp : def.xp, x, y);
  }
  // a magma cube breaks into two to four of the next size down
  if (sz && sz.splits) {
    const n = 2 + Math.floor(Math.random() * 3);
    const spots = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]].map(([dx, dy]) => [m.tx + dx, m.ty + dy]).filter(([cx, cy]) => cellFree(cx, cy));
    for (let i = 0; i < n; i++) {
      const [cx, cy] = spots[i % Math.max(1, spots.length)] || [m.tx, m.ty];
      const c = spawnMob(m.kind, cx, cy, { size: sz.splits });
      c.hopT = 0.3 + Math.random() * 0.6; c.angry = true;
    }
  }
  if (NET.h && m.bySlot) NET.h.kill(m, def);   // co-op: a guest's kill (its score, its advancement)
  else {
    G.score += def.hostile ? 1 : 0;
    if (m.byPlayer && G.onKill) G.onKill(m.kind);
  }
  m.dead = true;
}

function updateMob(m, dt) {
  const P = NET.on ? NET.target(m) : G.P, W = G.world, def = MOBS()[m.kind];
  m.age += dt;
  if (m.hurt > 0) m.hurt -= dt;
  if (m.wetT > 0) m.wetT -= dt;
  if (m.invuln > 0) m.invuln -= dt;
  if (m.dying) { m.dying += dt; if (m.dying > 0.7) killMob(m); return; }
  if (m.attackT > 0) m.attackT -= dt;
  if (m.fly) { updateFlyer(m, dt, def); return; }
  // sunlight burns zombies and skeletons (and strays; never a husk)
  if ((m.kind === 'zombie' || ARCHER(m.kind)) && G.isDay() && (!G.hasSky || G.hasSky(m.tx, m.ty))) {
    m.burn += dt;
    if (m.burn > 0.5 && Math.floor(m.burn) !== Math.floor(m.burn - dt)) { m.burnt = true; hurtMob(m, 1, null); if (Math.random() < 0.6) mc('fire', { vol: 0.3 * nearVol(m) }); }
  }
  if (m.moving) {
    m.prog += dt / (m.step / (m.speedMul || 1));
    if (m.prog >= 1) {
      m.moving = false; m.prog = 0; m.fx = m.tx; m.fy = m.ty; m.knocked = false;
      if (m.hop) { m.hop = false; m.squash = 0.2; mc(m.size === 'large' ? 'magma_cube.squish' : 'magma_cube.squish_small', { vol: 0.5 * nearVol(m) }); }
    } else { m.fx = m.fromX + (m.tx - m.fromX) * m.prog; m.fy = m.fromY + (m.ty - m.fromY) * m.prog; return; }
  }
  if (m.kind === 'magma_cube') { updateCube(m, dt, def); return; }
  if (m.kind === 'enderman') { updateEnderman(m, dt, def); return; }
  if (m.cool > 0) m.cool -= dt;
  // generated worlds (7b, src/villagers.js): villagers and iron golems; a zombie near an outdoor villager
  if (m.kind === 'villager' || m.kind === 'iron_golem') { if (G.vil) G.vil.update(m, dt); return; }
  if (G.vil && (m.kind === 'zombie' || m.kind === 'husk') && G.vil.zombie(m, dt, P, def)) return;
  const dx = P.tx - m.tx, dy = P.ty - m.ty, dist = Math.hypot(dx, dy), man = Math.abs(dx) + Math.abs(dy);
  const canSee = !P.dead && !P.hidden && !(NET.on ? NET.busy(P) : G.busy());
  // idle sounds
  if (Math.random() < dt / 7 && A.sfx[m.kind + '.say'] && m.kind !== 'creeper') mc(m.kind + (m.angry && A.sfx[m.kind + '.angry'] ? '.angry' : '.say'), { vol: 0.5 * nearVol(m) });
  // a zombified piglin's anger wears off once Steve has been out of reach for a while
  if (def.neutral && m.angry) { m.angerT -= dt; if (m.angerT <= 0 && dist > 12) m.angry = false; }
  if (def.hostile || (def.neutral && m.angry)) {
    const hostileNow = m.kind !== 'spider' || m.angry || !G.isDay() || (G.hasSky && !G.hasSky(m.tx, m.ty));
    if (m.kind === 'creeper') {
      if (m.fuse > 0) {
        m.fuse += dt;
        if (dist > 4.5 || !canSee) { m.fuse = 0; }
        else if (m.fuse >= 1.5) { G.explode(m.tx, m.ty, 3, m); m.dead = true; return; }
        return;
      }
      if (canSee && dist <= 2.3) { m.fuse = 0.001; if (!NET.on || NET.near(m.fx, m.fy)) mc('fuse', { vol: 0.9 }); m.dir = dirTo(m.tx, m.ty, P.tx, P.ty); return; }
    }
    if (canSee && hostileNow && dist < 16) {
      if (ARCHER(m.kind)) {
        const aligned = (dx === 0 || dy === 0) && man <= 8 && man >= 2 && clearLine(m.tx, m.ty, P.tx, P.ty);
        if (m.aim > 0) {
          m.aim += dt;
          m.dir = dirTo(m.tx, m.ty, P.tx, P.ty);
          if (m.aim > 0.9) { m.aim = 0; m.cool = 1.4 + Math.random(); if (aligned) shootArrow(m, m.dir, 3 + RNG.randInt(2)); }
          return;
        }
        if (aligned && m.cool <= 0) { m.aim = 0.001; m.dir = dirTo(m.tx, m.ty, P.tx, P.ty); return; }
        if (man < 3) { const away = dirTo(P.tx, P.ty, m.tx, m.ty); if (stepMob(m, away, 1)) return; }
        // line up with the player
        const want = Math.abs(dx) < Math.abs(dy) ? (dx > 0 ? 'right' : dx < 0 ? 'left' : null) : (dy > 0 ? 'down' : dy < 0 ? 'up' : null);
        if (want && stepMob(m, want)) return;
        const s = pathStep(m, P.tx, P.ty);
        if (s && man > 6) stepMob(m, s);
        return;
      }
      if (man === 1) {
        m.dir = dirTo(m.tx, m.ty, P.tx, P.ty);
        if (m.kind !== 'creeper' && m.cool <= 0) {
          m.cool = m.kind === 'spider' ? 0.9 : 1.0;
          m.attackT = 0.25;
          if (NET.on) NET.hurt(P, hit(def.dmg), ['mob', def.name], m); else G.hurtPlayer(hit(def.dmg), `${G.P.name} was slain by ${def.name}`, m);
        }
        return;
      }
      const s = pathStep(m, P.tx, P.ty);
      if (s) { stepMob(m, s, m.kind === 'spider' ? 1 : 1); return; }
    }
  } else if (m.panic > 0) {
    m.panic -= dt;
    const away = dirTo(P.tx, P.ty, m.tx, m.ty);
    const opts = [away, ...DIR_LIST.filter((d) => d !== OPP[away])];
    for (const d of opts) if (stepMob(m, d, 2)) return;
    return;
  }
  // wander
  m.think -= dt;
  if (m.think <= 0) {
    m.think = 1 + Math.random() * 3;
    if (Math.random() < 0.6) stepMob(m, DIR_LIST[RNG.randInt(4)]);
    else m.dir = DIR_LIST[RNG.randInt(4)];
  }
  void W; void isDark;
}
// ---------------------------------------------------------------- endermen
// Neutral until hit, or until Steve looks at one: facing it along his line (within a cell of it), 8 cells or
// closer, for half a second. Then it stares back (shaking, mouth open, the stare sound), teleports beside him
// and chases him. Anything but a hand-to-hand blow makes it teleport away (hurtMob), water too.
function updateEnderman(m, dt, def) {
  let P = NET.on ? NET.target(m) : G.P;
  const W = G.world;
  if (m.cool > 0) m.cool -= dt;
  if (m.tpCool > 0) m.tpCool -= dt;
  let dx = P.tx - m.tx, dy = P.ty - m.ty, dist = Math.hypot(dx, dy), man = Math.abs(dx) + Math.abs(dy);
  const canSee = !P.dead && !P.hidden && !(NET.on ? NET.busy(P) : G.busy()) && sameArea(W, P.tx, P.ty, m.tx, m.ty);
  // co-op: any player who stares at it (not only the nearest) makes it angry, and it goes for that one
  if (NET.on && !m.angry) {
    for (const p of NET.players()) {
      if (p.dead || NET.busy(p) || !sameArea(W, p.tx, p.ty, m.tx, m.ty)) continue;
      const qx = p.tx - m.tx, qy = p.ty - m.ty, d = DIRS[p.dir] || DIRS.down, along = -qx * d.x + -qy * d.y, perp = d.x ? Math.abs(qy) : Math.abs(qx);
      if (!p.moving && along >= 1 && along <= (def.stare || 8) && perp <= 1) { P = p; m.aggroSlot = p.slot || 0; dx = qx; dy = qy; dist = Math.hypot(dx, dy); man = Math.abs(dx) + Math.abs(dy); break; }
    }
  }
  // standing in water hurts it and sends it away
  if (W.isWater(m.tx, m.ty)) { wetMob(m); return; }
  if (Math.random() < dt / 7) mc(m.angry ? 'enderman.scream' : 'enderman.say', { vol: 0.5 * nearVol(m) });
  if (!m.angry) {
    // being looked at
    const d = DIRS[P.dir], along = -dx * d.x + -dy * d.y, perp = d.x ? Math.abs(dy) : Math.abs(dx);
    // top-down, "looking" is standing still facing it: walking past one, or turning to go another way, is not a stare
    const looked = canSee && !P.moving && along >= 1 && along <= (def.stare || 8) && perp <= 1;
    m.stareT = looked ? (m.stareT || 0) + dt : Math.max(0, (m.stareT || 0) - dt * 2);
    if (looked) m.dir = dirTo(m.tx, m.ty, P.tx, P.ty);
    if (m.stareT >= 0.5) {
      m.angry = true; m.angerT = 30; m.stareT = 0; m.screamT = 0.75;
      mc('enderman.stare', { vol: 0.9 });
      return;
    }
    if (m.stareT > 0) return;          // frozen, staring back
  }
  if (m.screamT > 0) {
    m.screamT -= dt; m.dir = dirTo(m.tx, m.ty, P.tx, P.ty);
    if (m.screamT <= 0 && canSee) teleportMob(m, P);
    return;
  }
  if (m.angry) {
    m.angerT -= dt;
    if (!canSee || (m.angerT <= 0 && dist > 12)) { if (!canSee && P.dead) m.angry = false; else if (m.angerT <= 0) m.angry = false; }
    if (canSee) {
      if (man === 1) {
        m.dir = dirTo(m.tx, m.ty, P.tx, P.ty);
        if (m.cool <= 0) { m.cool = 1.0; m.attackT = 0.3; if (NET.on) NET.hurt(P, hit(def.dmg), ['mob', 'Enderman'], m); else G.hurtPlayer(hit(def.dmg), `${P.name} was slain by Enderman`, m); }
        return;
      }
      const s = dist < 18 ? pathStep(m, P.tx, P.ty) : null;
      if (s && stepMob(m, s, 1.25)) return;
      // no way through (or far off): it teleports to him now and then
      if ((m.tpCool || 0) <= 0) { m.tpCool = 2.5 + Math.random() * 2; teleportMob(m, P); }
      return;
    }
  }
  m.think -= dt;
  if (m.think <= 0) {
    m.think = 1 + Math.random() * 3;
    if (Math.random() < 0.6) stepMob(m, DIR_LIST[RNG.randInt(4)]);
    else m.dir = DIR_LIST[RNG.randInt(4)];
  }
}
// Teleport a mob (an enderman) with the portal particles and sound at both ends: next to `near` (Steve) if given,
// else to a random open cell 4 to 12 cells away in the same place. Returns whether it went.
export function teleportMob(m, near = null) {
  const W = G.world;
  const ok = (x, y) => W.inside(x, y) && W.samePlace(x, y, m.tx, m.ty) && cellFree(x, y, m) && !W.isLava(x, y) && !W.isEndPortal(x, y);
  let dest = null;
  for (let k = 0; k < 40 && !dest; k++) {
    let x, y;
    if (near) { const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 1.6; x = Math.round(near.tx + Math.cos(a) * r); y = Math.round(near.ty + Math.sin(a) * r); if (x === near.tx && y === near.ty) continue; }
    else { const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 8; x = Math.round(m.tx + Math.cos(a) * r); y = Math.round(m.ty + Math.sin(a) * r * 0.8); }
    if (ok(x, y)) dest = [x, y];
  }
  if (!dest) return false;
  portalPuff(m.fx * TILE + 8, m.fy * TILE + 4, 14);
  mc('enderman.portal', { vol: 0.7 * nearVol(m) + 0.15 });
  m.tx = m.fromX = m.fx = dest[0]; m.ty = m.fromY = m.fy = dest[1]; m.moving = false; m.prog = 0;
  if (near) m.dir = dirTo(m.tx, m.ty, near.tx, near.ty);
  portalPuff(m.tx * TILE + 8, m.ty * TILE + 4, 14);
  mc('enderman.portal', { vol: 0.7 * nearVol(m) + 0.15, pitch: 1.1 });
  return true;
}
// water on an enderman (a bucket poured on it, a step into water): it is hurt and teleports away
export function wetMob(m) {
  if (m.kind !== 'enderman' || m.dying) return;
  if (!(m.wetT > 0)) { m.hp -= 1; m.hurt = 0.4; m.wetT = 0.5; mc('enderman.hurt', { vol: 0.7 }); if (m.hp <= 0) { m.dying = 0.001; mc('enderman.death', { vol: 0.9 }); return; } }
  teleportMob(m);
}
// Minecraft's portal particles (the purple motes endermen, pearls and eyes trail)
export function portalPuff(x, y, n = 8, spread = 10) {
  const img = A.mc.pPortal;
  for (let i = 0; i < n; i++) {
    if (img) spriteParticle(img, 8, x + (Math.random() - 0.5) * spread, y + (Math.random() - 0.5) * spread, { life: 0.5 + Math.random() * 0.6, z: 2 + Math.random() * 14, vz: (Math.random() - 0.5) * 30, vx: (Math.random() - 0.5) * 24, fw: 8, scale: 1 + Math.random() });
    else particle({ x: x + (Math.random() - 0.5) * spread, y, z: 6, vz: 10, life: 0.6, color: '#c060ff', size: 2 });
  }
}
export function clearLine(x0, y0, x1, y1) {
  const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0);
  let x = x0 + dx, y = y0 + dy;
  while (!(x === x1 && y === y1)) { if (G.world.solid(x, y)) return false; x += dx; y += dy; }
  return true;
}
function mobFrame(m) {
  const sheet = A.items.mobSheets[sheetKey(m)];
  let pose = 'walk';
  if (ARCHER(m.kind) && m.aim > 0) pose = 'aim';
  if (m.kind === 'creeper' && m.fuse > 0) pose = Math.floor(m.fuse * 6) % 2 ? 'fuse2' : 'fuse1';
  if (m.kind === 'sheep' && m.sheared) pose = 'sheared';
  if (m.kind === 'zombified_piglin' && m.angry) pose = 'angry';
  if (m.kind === 'wither_skeleton' && m.attackT > 0) pose = 'attack';
  if (m.kind === 'ghast' && (m.charge > 0 || m.attackT > 0)) pose = 'shoot';
  if (m.kind === 'blaze' && (m.charge > 0 || m.burst > 0)) pose = 'shoot';
  if (m.kind === 'magma_cube') pose = m.moving && m.hop ? 'jump' : m.squash > 0 ? 'squash' : 'walk';
  if (m.kind === 'enderman') pose = m.attackT > 0 ? 'attack' : (m.stareT > 0.05 || m.screamT > 0) ? 'stare' : m.angry ? 'angry' : 'walk';
  if (m.kind === 'silverfish' && m.moving && (m.angry || G.P && Math.abs(G.P.tx - m.tx) + Math.abs(G.P.ty - m.ty) < 10)) pose = 'scurry';
  if (m.kind === 'villager') pose = m.sleep ? 'sleep' : m.shakeT > 0 ? 'shake' : 'walk';
  if (m.kind === 'iron_golem' && m.attackT > 0) pose = 'attack';
  // a ghast always turns its face to Steve, and a magma cube and a blaze look at him too: facing him sideways they use the
  // front frames (the side frames show no face, and the mouth opening before a fireball is the warning). A ghast
  // or blaze watching him from below him shows its face too, never the back of its head.
  const face = ((m.kind === 'ghast' || m.kind === 'magma_cube' || m.kind === 'blaze') && (m.dir === 'left' || m.dir === 'right')) || (m.fly && m.watch && m.dir === 'up') ? 'down' : m.dir;
  const frames = (sheet.poses[pose] || sheet.poses.walk)[face];
  let f;
  if (m.fly) f = frames[Math.floor(m.phase * (m.kind === 'blaze' ? 8 : 4)) % frames.length];       // always animating: tentacles, spinning rods
  else if (pose === 'stare' || pose === 'attack' || pose === 'shake') f = frames[Math.floor(G.clock * 14) % frames.length];   // shaking, or the swing
  else if (pose === 'scurry') f = frames[Math.floor(m.prog * 4 + G.clock * 6) % frames.length];
  else f = frames.length > 1 && m.moving ? frames[1 + (Math.floor(m.prog * 2 + (m.tx + m.ty)) % 2)] : frames[0];
  return { sheet, f };
}
// an angry or staring enderman trembles
function mobShake(m) { return m.kind === 'enderman' && !m.dying && (m.stareT > 0.05 || m.screamT > 0 || m.angry) ? (Math.floor(G.clock * 30) % 2 ? 1 : -1) * (m.angry && !(m.screamT > 0) ? 0.5 : 1) : 0; }
// how high a mob is drawn above its cell: a floating ghast or blaze bobs, a magma cube arcs through its hop
function mobLift(m) {
  if (m.kind === 'ghast') return 8 + Math.sin(m.phase * 1.3) * 3;
  if (m.kind === 'blaze') return 7 + Math.sin(m.phase * 2.1) * 2.5;
  if (m.hop && m.moving) return Math.sin(m.prog * Math.PI) * (m.size === 'large' ? 11 : m.size === 'medium' ? 8 : 6);
  if (m.sleep) return -12;   // (7b: a villager asleep lies along its two-cell bed)
  return 0;
}
function drawMob(ctx, m, cam) {
  if (m.look != null && !A.mob[sheetKey(m)] && !(G.vil && G.vil.ensureLook(m))) return;   // (7b: a look whose sheet is not in yet)
  const { sheet, f } = mobFrame(m);
  const img = A.mob[sheetKey(m)];
  const x = m.fx * TILE + 8 - sheet.origin[0] - cam.x + mobShake(m), y = m.fy * TILE + FOOT - sheet.origin[1] - cam.y - mobLift(m);
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath(); ctx.ellipse(Math.round(m.fx * TILE + 8 - cam.x), Math.round(m.fy * TILE + FOOT - cam.y), Math.min(10, sheet.w / 3), 2.5, 0, 0, Math.PI * 2); ctx.fill();
  const white = m.kind === 'creeper' && m.fuse > 0 ? (Math.floor(m.fuse * 8) % 2 ? 0.75 : 0) : 0;
  const tilt = m.dying ? Math.min(1, m.dying / 0.35) * Math.PI / 2 : 0;
  drawFrame(ctx, img, f, sheet.w, sheet.h, x, y, { red: m.hurt > 0 || m.dying ? 0.55 : 0, white, tilt, origin: sheet.origin });
  if (!m.moving && !m.dying && G.world.tallGrass(m.tx, m.ty)) ctx.drawImage(A.img.fxTallGrass, 0, 0, 16, 16, Math.round(m.tx * TILE - cam.x), Math.round(m.ty * TILE - cam.y + 4), 16, 12);
  if (m.burn > 0.5 && !m.dying && G.isDay() && (!G.hasSky || G.hasSky(m.tx, m.ty)) && (m.kind === 'zombie' || ARCHER(m.kind))) {
    const fl = Math.floor(G.clock * 12) % 2;
    ctx.globalAlpha = 0.85;
    ctx.drawImage(A.mc.fire, 0, 0, 16, 16, Math.round(m.fx * TILE - cam.x) + (fl ? 1 : 0), Math.round(m.fy * TILE + FOOT - 22 - cam.y), 16, 20);
    ctx.globalAlpha = 1;
  }
}

// An enderman is two and a half cells tall: standing in front of a house or a tree, its head and body reach up into
// cells whose top layer (a roof, a wall top, a crown) is drawn over sprites. After the top layer, it is drawn again,
// clipped to those cells only, so it stays in front of what it stands in front of. One whose feet are under the top
// layer is behind it, and stays hidden.
export function drawTallOverTop(ctx, cam) {
  const W = G.world;
  for (const m of G.ents) {
    if (m.type !== 'mob' || m.kind !== 'enderman' || m.fly) continue;
    const fx = Math.round(m.fx), fy = Math.round(m.fy);
    if (Math.abs(m.fx * TILE - cam.x - 120) > 160 || Math.abs(m.fy * TILE - cam.y - 80) > 120) continue;
    if (W.hasTop(fx, fy)) continue;
    const rects = [];
    for (let y = fy - 3; y <= fy - 1; y++) for (let x = Math.floor(m.fx) - 1; x <= Math.ceil(m.fx) + 1; x++) if (W.hasTop(x, y)) rects.push([x * TILE - cam.x, y * TILE - cam.y]);
    if (!rects.length) continue;
    ctx.save();
    ctx.beginPath();
    for (const [x, y] of rects) ctx.rect(x, y, TILE, TILE);
    ctx.clip();
    drawMob(ctx, m, cam);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- arrows
export function shootArrow(owner, dir, dmg, fromPlayer = false, power = 1) {
  const d = DIRS[dir];
  const ox = (owner.fx ?? owner.tx) * TILE + 8, oy = (owner.fy ?? owner.ty) * TILE + 6;
  G.ents.push({ type: 'arrow', x: ox + d.x * 8, y: oy + d.y * 8, vx: d.x * 230 * power, vy: d.y * 230 * power, dir, dmg, fromPlayer, owner, life: 0, stuck: 0, crit: fromPlayer && power >= 1 });
  mc('bow', { vol: 0.8, pitch: 1 / (0.8 + Math.random() * 0.4) + 0.2 });
}
// a stray's arrow: the seconds of slowness it gives (mcdata MOBS.stray.slow), else 0
const strayArrow = (a) => (a.owner && a.owner.kind === 'stray' && (MOBS().stray && MOBS().stray.slow)) || 0;
function updateArrow(a, dt) {
  a.life += dt;
  if (a.stuck) { a.stuck += dt; if (a.stuck > 4) a.dead = true; return; }
  const steps = 4;
  for (let i = 0; i < steps; i++) {
    a.x += (a.vx * dt) / steps; a.y += (a.vy * dt) / steps;
    const tx = Math.floor(a.x / TILE), ty = Math.floor(a.y / TILE);
    // The End: an arrow into a pillar's footprint hits its crystal (or cage); one near the dragon hits the dragon
    if (a.fromPlayer && G.arrowHook && G.arrowHook(a, tx, ty)) { a.dead = true; return; }
    // arrows fly over lava (a pool or a lake), as fireballs do, and over The End's void
    if (G.world.solid(tx, ty) && !G.world.isLava(tx, ty) && !G.world.isEndVoid(tx, ty)) { a.stuck = 0.001; mc('bowhit', { vol: 0.5 }); return; }
    if (a.fromPlayer) {
      const m = mobAt(tx, ty) || flyerNear((a.x - 8) / TILE, (a.y - 8) / TILE, 1);
      // an enderman is never hit by an arrow: it teleports away and the arrow flies on
      if (m && m.kind === 'enderman') { hurtMob(m, a.dmg, null, { player: true, projectile: true }); continue; }
      if (m && m.kind === 'villager') continue;   // (7b: arrows pass villagers)
      if (m && m !== a.owner) {
        hurtMob(m, a.dmg, { x: tx - Math.sign(a.vx), y: ty - Math.sign(a.vy) }, { crit: a.crit, player: true }); if (m.dying) m.byPlayer = true;
        // co-op: a guest's arrow: the kill and Take Aim are that guest's
        if (NET.h && a.ownerSlot) { m.bySlot = m.aggroSlot = a.ownerSlot; if (NET.near(m.fx, m.fy)) mc('bowhit', { vol: 0.6 }); NET.h.adv(a.ownerSlot, 'take_aim'); a.dead = true; return; }
        mc('bowhit', { vol: 0.6 }); if (G.onArrowHit) G.onArrowHit(); a.dead = true; return;
      }
    } else if (NET.on) {
      const v = NET.h && NET.h.victim(a.x, a.y, 0, 7, 8);
      if (v) { NET.hurt(v, hit(a.dmg), ['arrow', strayArrow(a) ? 'Stray' : 'Skeleton'], a.owner, true, null, strayArrow(a) ? { slow: strayArrow(a) } : null); a.dead = true; return; }
    } else {
      const P = G.P;
      if (!P.dead && Math.abs(P.fx * TILE + 8 - a.x) < 7 && Math.abs(P.fy * TILE + 8 - a.y) < 8) {
        const sl = strayArrow(a);
        if (G.hurtPlayer(hit(a.dmg), `${P.name} was shot by ${sl ? 'Stray' : 'Skeleton'}`, a.owner, true) && sl) P.slowT = Math.max(P.slowT || 0, sl);
        a.dead = true; return;
      }
    }
  }
  if (a.life > 2) a.dead = true;
}
function drawArrow(ctx, a, cam) {
  const sx = (a.x - cam.x) * 2, sy = (a.y - cam.y - 6) * 2;
  ctx.save();
  ctx.translate(Math.round(sx), Math.round(sy));
  // the arrow icon points up-right; turn it along its flight
  const ang = Math.atan2(a.vy || (a.dir === 'down' ? 1 : a.dir === 'up' ? -1 : 0), a.vx || (a.dir === 'right' ? 1 : a.dir === 'left' ? -1 : 0)) + Math.PI / 4;
  ctx.rotate(ang);
  ctx.drawImage(A.mc.arrow, -8, -8, 16, 16);
  ctx.restore();
}

// ---------------------------------------------------------------- TNT and explosions
export function primeTNT(tx, ty, fuse = 4) {
  // a TNT bridge over The End's void leaves the void behind (world.removeBlock)
  G.world.removeBlock(tx, ty);
  G.ents.push({ type: 'tnt', tx, ty, fuse, t: 0 });
  mc('fuse', { vol: 1 });
}
function updateTNT(e, dt) {
  e.t += dt;
  if (Math.random() < dt * 10) particle({ x: e.tx * TILE + 8 + (Math.random() - 0.5) * 3, y: e.ty * TILE - 4, z: 0, vz: 20, life: 0.5, img: A.mc.pSmoke, frames: 12, fw: 16, size: 0, scale: 1 });
  if (e.t >= e.fuse) { e.dead = true; G.explode(e.tx, e.ty, 4, e); }
}
function drawTNT(ctx, e, cam) {
  const look = A.items.blocks.tnt;
  const per = 32, [cw, chh] = A.items.cell;
  const sw = 1 + Math.min(0.1, Math.max(0, (e.t - e.fuse + 0.3)) * 0.3);
  const x = e.tx * TILE - cam.x, y = e.ty * TILE - 8 - cam.y;
  ctx.drawImage(A.mc.blocks, (look % per) * cw, Math.floor(look / per) * chh, cw, chh, Math.round(x - (sw - 1) * 8), Math.round(y - (sw - 1) * 12), cw * sw, chh * sw);
  if (Math.floor(e.t * 4) % 2 === 1) { ctx.globalAlpha = 0.6; ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(x), Math.round(y + 1), 16, 23); ctx.globalAlpha = 1; }
}

// ---------------------------------------------------------------- boats and the fishing bobber
// boat.png: 48x48 frames per direction, the hull centre at (24, 27); row 0 is the whole boat, row 1 its
// near rim alone, drawn after Steve so he sits inside the hull.
export function drawBoat(ctx, e, cam, layer = 0) {
  const x = e.fx * TILE - cam.x, y = e.fy * TILE - cam.y;
  const bob = Math.round(Math.sin(G.clock * 2.4 + e.tx) * 0.8);
  const img = A.mc.boat;
  if (img) {
    const fr = { down: 0, up: 1, left: 2, right: 3 }[e.dir] || 0;
    ctx.drawImage(img, fr * 48, layer * 48, 48, 48, Math.round(x + 8 - 24), Math.round(y + 10 - 27 + bob), 48, 48);
  }
}
export function updateBobber(b, dt) {
  b.t += dt;
  if (b.state === 'fly') {
    const k = Math.min(1, b.t / 0.45);
    b.x = b.x0 + (b.x1 - b.x0) * k; b.y = b.y0 + (b.y1 - b.y0) * k; b.z = Math.sin(k * Math.PI) * 18;
    if (k >= 1) {
      if (G.world.isWater(b.tx, b.ty)) { b.state = 'wait'; b.t = 0; b.wait = 3.5 + Math.random() * 9; mc('water_splash', { vol: 0.25, pitch: 1.4 }); splash(b.x, b.y, 4); }
      else { b.state = 'ground'; b.t = 0; }
    }
  } else if (b.state === 'wait') {
    if (b.forceBite != null) { b.wait = Math.min(b.wait, b.forceBite); b.forceBite = null; }
    if (b.t > b.wait - 1.2 && b.t < b.wait && Math.random() < dt * 14) particle({ x: b.x + (Math.random() - 0.5) * 30 * (b.wait - b.t), y: b.y + (Math.random() - 0.5) * 4, life: 0.4, color: '#e8f4ff', size: 2 });
    if (b.t >= b.wait) { b.state = 'bite'; b.t = 0; mc('water_splash', { vol: 0.5 }); splash(b.x, b.y, 10); G.onBite && G.onBite(b); }
  } else if (b.state === 'bite') {
    if (b.t > 1.1) { b.state = 'wait'; b.t = 0; b.wait = 3 + Math.random() * 8; }
  }
}
export function splash(x, y, n = 6) {
  for (let i = 0; i < n; i++) particle({ x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 4, z: 1, vz: 40 + Math.random() * 40, g: -200, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 10, life: 0.6, color: Math.random() < 0.5 ? '#ffffff' : '#a8d8f8', size: 2, bounce: false });
}
function drawBobber(ctx, b, cam) {
  const P = G.P;
  const hx = (P.tipX ?? P.handX ?? P.fx * TILE + 4) - cam.x, hy = (P.tipY ?? P.handY ?? P.fy * TILE) - cam.y;
  const dip = b.state === 'bite' ? 2 : b.state === 'wait' ? Math.sin(b.t * 3) * 0.6 : 0;
  const bx = b.x - cam.x, by = b.y - b.z + dip - cam.y;
  ctx.strokeStyle = 'rgba(30,30,30,0.85)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(hx * 2, hy * 2);
  const mx = (hx + bx) / 2, my = Math.max(hy, by) + 6;
  ctx.quadraticCurveTo(mx * 2, my * 2, bx * 2, by * 2); ctx.stroke();
  ctx.drawImage(A.mc.hook, 0, 0, 8, 8, Math.round(bx * 2 - 8), Math.round(by * 2 - 12), 16, 16);
}

// ---------------------------------------------------------------- update + draw entry points
export function updateEntities(dt) {
  if (NET.g) { NET.g.updateEntities(dt); return; }   // co-op guest: the host's entities are replicas
  const P = G.P;
  for (const e of G.ents) {
    if (e.dead) continue;
    if (e.type === 'mob') {
      // (7b: a village's villagers and golem run while their village is in, indoors too: src/villagers.js parks them)
      const far = G.vil && (e.kind === 'villager' || e.kind === 'iron_golem') ? false : NET.on ? NET.far(e.tx, e.ty) : Math.abs(e.tx - P.tx) > 30 || Math.abs(e.ty - P.ty) > 24;
      if (far) { if ((HOSTILE.has(e.kind) || NEUTRAL.has(e.kind)) && !e.persistent) e.dead = true; continue; }
      updateMob(e, dt);
    } else if (e.type === 'item' || e.type === 'xp') updateDrops(e, dt);
    else if (e.type === 'arrow') updateArrow(e, dt);
    else if (e.type === 'fireball') updateFireball(e, dt);
    else if (e.type === 'tnt') updateTNT(e, dt);
    else if (e.type === 'bobber') updateBobber(e, dt);
  }
  // merge nearby identical item stacks like Minecraft does
  for (let i = G.ents.length - 1; i >= 0; i--) if (G.ents[i].dead) G.ents.splice(i, 1);
}
// Sprites for the y-sorted world pass (GBA layer) and the full-resolution pass.
export function worldSprites(cam, list) {
  // generated layouts (5c): a ground mob well off the view is not drawn (herds keep tens of them in G.ents; Classic
  // draws every one as before)
  const cull = G.world.layout.gen;
  for (const e of G.ents) {
    if (cull && e.type === 'mob' && !e.fly && (e.fx * TILE < cam.x - 96 || e.fx * TILE > cam.x + 640 || e.fy * TILE < cam.y - 96 || e.fy * TILE > cam.y + 480)) continue;
    if (e.type === 'mob' && e.fly) list.push({ y: e.fy - 0.3, fn: (ctx) => flyerShadow(ctx, e, cam) });
    else if (e.type === 'mob') list.push({ y: e.fy + (e.sleep ? 1.05 : 0.01), fn: (ctx) => drawMob(ctx, e, cam) });   // (a villager asleep lies over its bed's foot)
    else if (e.type === 'tnt') list.push({ y: e.ty, fn: (ctx) => drawTNT(ctx, e, cam) });
    else if (e.type === 'boat') {
      if (NET.on && e.rider != null && e.rider >= 0 && e.rider !== NET.slot) continue;   // co-op: drawn with its rider
      list.push({ y: e.fy - 0.02, fn: (ctx) => drawBoat(ctx, e, cam, 0) });
      if (G.P && G.P.riding === e) list.push({ y: e.fy + 0.04, fn: (ctx) => drawBoat(ctx, e, cam, 1) });
    }
  }
}
function flyerShadow(ctx, m, cam) {
  const big = m.kind === 'ghast';
  ctx.fillStyle = `rgba(0,0,0,${big ? 0.22 : 0.18})`;
  ctx.beginPath(); ctx.ellipse(Math.round(m.fx * TILE + 8 - cam.x), Math.round(m.fy * TILE + FOOT - cam.y), big ? 15 : 7, big ? 4 : 2.5, 0, 0, Math.PI * 2); ctx.fill();
}
// Floating mobs go over everything on the ground (walls' tops and lava banks included), in GBA pixels.
export function drawFlyers(ctx, cam) {
  const fl = G.ents.filter((e) => e.type === 'mob' && e.fly).sort((a, b) => a.fy - b.fy);
  for (const m of fl) {
    const { sheet, f } = mobFrame(m);
    const img = A.mob[sheetKey(m)];
    const x = m.fx * TILE + 8 - sheet.origin[0] - cam.x, y = m.fy * TILE + FOOT - sheet.origin[1] - cam.y - mobLift(m);
    const tilt = m.dying ? Math.min(1, m.dying / 0.35) * Math.PI / 2 : 0;
    drawFrame(ctx, img, f, sheet.w, sheet.h, x, y, { red: m.hurt > 0 || m.dying ? 0.55 : 0, tilt, origin: sheet.origin });
  }
}
// Fireballs glow: drawn after the lighting, in GBA pixels.
// A magma cube's glow and a wither skeleton's rim go on after the lighting too, but a ghast or blaze floating in
// front of one still covers it: with a flyer about, they are drawn on a layer of their own, every flyer's sprite
// is cut out of that layer where drawFlyers put it, and only then is the layer laid over the frame.
let glowLayer = null;
export function drawGlowing(ctx, cam) {
  for (const e of G.ents) if (e.type === 'fireball') drawFireball(ctx, e, cam);
  const lit = G.ents.filter((e) => e.type === 'mob' && (e.kind === 'magma_cube' || e.kind === 'wither_skeleton' || e.kind === 'enderman') && !e.dying);
  if (!lit.length) return;
  const flyers = G.ents.filter((e) => e.type === 'mob' && e.fly);
  let g = ctx;
  if (flyers.length) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    if (!glowLayer || glowLayer.width !== cw || glowLayer.height !== ch) { glowLayer = document.createElement('canvas'); glowLayer.width = cw; glowLayer.height = ch; }
    g = glowLayer.getContext('2d'); g.imageSmoothingEnabled = false;   // keep the glow and rims as crisp as the main canvas
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cw, ch);
    g.setTransform(ctx.getTransform());
  }
  for (const e of lit) if (e.kind === 'magma_cube') drawCubeGlow(g, e, cam);
  for (const e of lit) if (e.kind === 'wither_skeleton') drawRim(g, e, cam);
  for (const e of lit) if (e.kind === 'enderman' && !G.world.hasTop(Math.round(e.fx), Math.round(e.fy))) drawEyes(g, e, cam);
  if (g === ctx) return;
  g.globalCompositeOperation = 'destination-out';
  for (const m of flyers) {
    const { sheet, f } = mobFrame(m);
    const x = m.fx * TILE + 8 - sheet.origin[0] - cam.x, y = m.fy * TILE + FOOT - sheet.origin[1] - cam.y - mobLift(m);
    const tilt = m.dying ? Math.min(1, m.dying / 0.35) * Math.PI / 2 : 0;
    drawFrame(g, A.mob[sheetKey(m)], f, sheet.w, sheet.h, x, y, { tilt, origin: sheet.origin });
  }
  g.globalCompositeOperation = 'source-over';
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(glowLayer, 0, 0); ctx.restore();
}
// An enderman's purple eyes glow through the dark: its eye layer (same frames as its sheet) after the lighting.
function drawEyes(ctx, m, cam) {
  const sheet = A.items.mobSheets[sheetKey(m)], img = sheet && sheet.eyes && A.mob[sheet.eyes];
  if (!img) return;
  const { f } = mobFrame(m);
  const x = Math.round(m.fx * TILE + 8 - sheet.origin[0] - cam.x + mobShake(m)), y = Math.round(m.fy * TILE + FOOT - sheet.origin[1] - cam.y - mobLift(m));
  ctx.drawImage(img, f * sheet.w, 0, sheet.w, sheet.h, x, y, sheet.w, sheet.h);
}
// A wither skeleton is near-black on the fortress's dark brick, and nothing on it glows: after the lighting it
// gets a faint bone-grey rim one pixel outside its silhouette, strongest in the dark and fading out in light.
const rimCache = {};
function rimMask(key) {
  if (rimCache[key]) return rimCache[key];
  const img = A.mob[key], sh = A.items.mobSheets[key];
  if (!img || !img.width) return null;
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const W = c.width, H = c.height, src = g.getImageData(0, 0, W, H).data, out = g.createImageData(W, H), px = out.data;
  const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && src[(y * W + x) * 4 + 3] > 40;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (on(x, y)) continue;
    const lx = x % sh.w, k = (y * W + x) * 4;
    if ((lx > 0 && on(x - 1, y)) || (lx < sh.w - 1 && on(x + 1, y)) || on(x, y - 1) || on(x, y + 1)) { px[k] = 176; px[k + 1] = 168; px[k + 2] = 160; px[k + 3] = 255; }
  }
  g.putImageData(out, 0, 0);
  return (rimCache[key] = c);
}
function drawRim(ctx, m, cam) {
  const mask = rimMask(sheetKey(m));
  if (!mask) return;
  const { sheet, f } = mobFrame(m);
  const x = Math.round(m.fx * TILE + 8 - sheet.origin[0] - cam.x), y = Math.round(m.fy * TILE + FOOT - sheet.origin[1] - cam.y - mobLift(m));
  const bl = G.lightAt ? G.lightAt(m.tx, m.ty) : 0;
  ctx.save();
  ctx.globalAlpha = 0.5 - 0.38 * Math.max(0, Math.min(1, (bl - 7) / 8));
  ctx.drawImage(mask, f * sheet.w, 0, sheet.w, sheet.h, x, y, sheet.w, sheet.h);
  ctx.restore();
}
// A magma cube's eyes and the molten core between its slices glow through the dark: its bright pixels (and,
// as it springs, the seams the slices open up) are drawn again after the lighting.
const glowCache = {};
function cubeGlow(key) {
  if (glowCache[key]) return glowCache[key];
  const img = A.mob[key], sh = A.items.mobSheets[key];
  if (!img || !img.width) return null;
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), px = d.data, boxes = [];
  for (let f = 0; f * sh.w < c.width; f++) boxes.push([1e9, 1e9, -1, -1]);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const k = (y * c.width + x) * 4;
    if (px[k + 3] > 0) { const b = boxes[Math.floor(x / sh.w)], lx = x % sh.w; b[0] = Math.min(b[0], lx); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], lx); b[3] = Math.max(b[3], y); }
    if (!(px[k] >= 200 && px[k + 1] >= 50 && px[k + 3] > 0)) px[k + 3] = 0;       // keep only the eyes' orange and yellow
  }
  g.putImageData(d, 0, 0);
  return (glowCache[key] = { mask: c, boxes });
}
function drawCubeGlow(ctx, m, cam) {
  const key = sheetKey(m), gl = cubeGlow(key);
  if (!gl) return;
  const { sheet, f } = mobFrame(m);
  const x = Math.round(m.fx * TILE + 8 - sheet.origin[0] - cam.x), y = Math.round(m.fy * TILE + FOOT - sheet.origin[1] - cam.y - mobLift(m));
  ctx.drawImage(gl.mask, f * sheet.w, 0, sheet.w, sheet.h, x, y, sheet.w, sheet.h);
  const [bx0, by0, bx1, by1] = gl.boxes[f] || [];
  if (bx1 < 0 || bx0 == null) return;
  // the seams: faint at rest, wide open mid-leap (Minecraft's slices separate as it jumps)
  const jump = m.moving && m.hop, n = m.size === 'small' ? 1 : 2, h = by1 - by0 + 1, w = bx1 - bx0 - 1;
  const pulse = 0.75 + 0.25 * Math.sin(G.clock * 3 + m.tx);
  for (let i = 1; i <= n; i++) {
    const sy = y + by0 + Math.round(h * (0.3 + 0.55 * i / (n + 1)));
    ctx.fillStyle = jump ? `rgba(255,150,40,${0.95 * pulse})` : `rgba(255,110,30,${0.45 * pulse})`;
    ctx.fillRect(x + bx0 + 1, sy, w, 1);
    if (jump) { ctx.fillStyle = `rgba(255,220,90,${0.8 * pulse})`; ctx.fillRect(x + bx0 + 3, sy, Math.max(1, w - 4), 1); ctx.fillStyle = `rgba(255,120,30,${0.5 * pulse})`; ctx.fillRect(x + bx0 + 1, sy + 1, w, 1); }
  }
}
export function drawHiresEntities(ctx, cam) {
  for (const e of G.ents) {
    if (e.type === 'item' || e.type === 'xp') drawDrop(ctx, e, cam);
    else if (e.type === 'arrow') drawArrow(ctx, e, cam);
    else if (e.type === 'bobber') drawBobber(ctx, e, cam);
  }
}

// ---------------------------------------------------------------- spawning
export function countKind(k, r = 24, around = G.P) { const P = around; return G.ents.filter((e) => e.type === 'mob' && e.kind === k && !e.dying && Math.abs(e.tx - P.tx) < r && Math.abs(e.ty - P.ty) < r).length; }
// The End: endermen roam the island (about ten within 24 cells of Steve), on its end stone, away from the fountain
// While the dragon is alive they keep out of the fight: fewer of them (six), none put down within 12 cells of Steve
// or 10 of the fountain, so the dragon stays the danger
export function trySpawnEnd(around = G.P) {
  const P = around, W = G.world, E = W.end;
  const fight = !!(G.end && G.end.dragon && G.end.dragon.alive);
  if (!E || !W.inEnd(P.tx, P.ty) || countKind('enderman', 24, P) >= (fight ? 6 : 10)) return null;
  const cx = E.fountain ? E.fountain.centre[0] : E.island.cx, cy = E.fountain ? E.fountain.centre[1] : E.island.cy;
  for (let tries = 0; tries < 10; tries++) {
    const a = Math.random() * Math.PI * 2, r = (fight ? 12 : 9) + Math.random() * 10;
    const x = Math.round(P.tx + Math.cos(a) * r), y = Math.round(P.ty + Math.sin(a) * r * 0.75);
    if (!W.inEnd(x, y) || W.mat(x, y) !== 'floor' || W.block(x, y) || !cellFree(x, y) || Math.hypot(x - cx, y - cy) < (fight ? 10 : 5)) continue;
    // on the island itself, not on a bridge or the platform
    if (E.island && Math.hypot(x - E.island.cx, y - E.island.cy) > E.island.r) continue;
    if (fight && Math.hypot(x - P.tx, y - P.ty) < 12) continue;
    return spawnMob('enderman', x, y);
  }
  return null;
}
export function hostileCount(r = 24, around = G.P) { const P = around; return G.ents.filter((e) => e.type === 'mob' && HOSTILE.has(e.kind) && Math.abs(e.tx - P.tx) < r && Math.abs(e.ty - P.ty) < r).length; }
// generated land (3.16, stage 5d): in a desert a rolled zombie is a husk 80% of the time, in a snowy biome a rolled
// skeleton a stray 80% of the time (outdoors only: a cave room has no biome)
export function biomeKind(W, x, y, kind) {
  const bm = W.biomeAt(x, y), b = bm && bm.biome;
  if (!b) return kind;
  if (kind === 'zombie' && b === 'desert' && MOBS().husk && Math.random() < 0.8) return 'husk';
  if (kind === 'skeleton' && b.startsWith('snowy') && MOBS().stray && Math.random() < 0.8) return 'stray';
  return kind;
}
// (playfix, generated layouts only; Classic keeps 7 within 24 cells, 9 to 17 cells away, at once):
// - a cave room's cap follows its size (2 to 4; a 48 x 36 room is 4), nothing spawns for 8 s after a player comes
//   in, and a spawn is at least 12 cells from the player and 8 from the cell where the player arrived;
// - the open overworld's cap is 3 on the first night and 5 on the second (7 after), and spawns are 13 to 19 cells away.
const arrivals = new WeakMap();   // player -> { room, t, x, y }: where and when the player came into the room it is in
function genSpawnRule(P, W) {
  const room = W.roomAt(P.tx, P.ty);
  if (room && room.kind === 'cave') {
    let ar = arrivals.get(P);
    if (!ar || ar.room !== room.id) { ar = { room: room.id, t: G.clock, x: P.tx, y: P.ty }; arrivals.set(P, ar); }
    if (G.clock - ar.t < 8) return null;
    return { cap: Math.max(2, Math.min(4, Math.round((room.w * room.h) / 450))), rMin: 12, rSpan: 8, ar };
  }
  arrivals.delete(P);
  if (room || !W.isOutdoor(P.tx, P.ty)) return { cap: 7, rMin: 9, rSpan: 8, ar: null };
  const night = (G.time >= 12000 ? G.day : G.day - 1) | 0;   // 0: the first night (its end falls on day 1)
  return { cap: night <= 0 ? 3 : night === 1 ? 5 : 7, rMin: 13, rSpan: 6, ar: null };
}
export function trySpawnHostile(around = G.P) {
  const P = around, W = G.world;
  const rule = W.layout.gen ? genSpawnRule(P, W) : null;
  if (W.layout.gen && !rule) return null;
  if (hostileCount(24, P) >= (rule ? rule.cap : 7)) return null;
  for (let tries = 0; tries < 12; tries++) {
    const a = Math.random() * Math.PI * 2, r = rule ? rule.rMin + Math.random() * rule.rSpan : 9 + Math.random() * 8;
    const x = Math.round(P.tx + Math.cos(a) * r), y = Math.round(P.ty + Math.sin(a) * r * 0.75);
    if (!W.inside(x, y) || W.zone[W.idx(x, y)] !== 0 || !cellFree(x, y) || !W.isFloor(x, y)) continue;
    if (rule && rule.ar && Math.abs(x - rule.ar.x) + Math.abs(y - rule.ar.y) < 8) continue;
    if (!W.samePlace(x, y, P.tx, P.ty)) continue;   // only where Steve is
    if (G.lightAt(x, y) >= 8) continue;
    // outdoors, about one spawn in fifteen is an enderman (two at most near Steve)
    if (W.isOutdoor(x, y) && Math.random() < 1 / 15 && countKind('enderman', 24, P) < 2) return spawnMob('enderman', x, y);
    if (peaceful()) continue;
    const roll = Math.random();
    let kind = roll < 0.36 ? 'zombie' : roll < 0.6 ? 'skeleton' : roll < 0.84 ? 'creeper' : 'spider';
    if (W.layout.gen && (kind === 'zombie' || kind === 'skeleton')) kind = biomeKind(W, x, y, kind);
    return spawnMob(kind, x, y);
  }
  return null;
}
// The Nether's own spawner: by the zone the cell is in (world.json nether.spawns: wastes, soul sand valley,
// lava sea, fortress, blaze platform), capped like the overworld's. Nothing here ever spawns in Kanto.
// The blaze platform's walkable cells (zone B), worked out once per world.
let blazeCells = null, blazeOf = null;
function platformCells(W, N) {
  if (blazeOf === N) return blazeCells;
  blazeOf = N; blazeCells = [];
  for (let y = 0; y < N.h; y++) for (let x = 0; x < N.w; x++) if (N.biome[y][x] === 'B') blazeCells.push([N.x + x, N.y + y]);
  return blazeCells;
}
// Blazes come from the platform like a Minecraft spawner: a random free cell of the platform itself, at least
// 3 cells from Steve, while he is within about 20 cells of it. They keep their own cap (2 within 24 cells), so
// piglins and wither skeletons filling the shared hostile cap never starve them.
function trySpawnBlaze(W, N, count, around = G.P) {
  const P = around, cells = platformCells(W, N);
  if (!cells.length || count('blaze', 24) >= NETHER_CAP.blaze) return null;
  let near = false;
  for (const [x, y] of cells) if (Math.abs(x - P.tx) <= 20 && Math.abs(y - P.ty) <= 20) { near = true; break; }
  if (!near) return null;
  for (let tries = 0; tries < 8; tries++) {
    const [x, y] = cells[Math.floor(Math.random() * cells.length)];
    if (Math.max(Math.abs(x - P.tx), Math.abs(y - P.ty)) < 3) continue;
    if (W.protAt(x, y) || W.isLava(x, y) || W.isPortal(x, y) || !cellFree(x, y) || flyerNear(x, y, 1)) continue;
    return spawnMob('blaze', x, y);
  }
  return null;
}
// How many of each kind may be around Steve at once (within 24 cells, ghasts within 40; a magma cube's splits
// count too), and how often a pick of that kind is kept. Without these the fortress filled with wither
// skeletons and the wastes with magma cubes faster than a geared player could clear them.
const NETHER_CAP = { wither_skeleton: 2, magma_cube: 2, ghast: 1, blaze: 2 };
const NETHER_KEEP = { wither_skeleton: 0.35, magma_cube: 0.3 };
const ARRIVAL_CLEAR = 20;
export function trySpawnNether(around = G.P) {
  const P = around, W = G.world, N = W.nether;
  if (!N || !W.inNether(P.tx, P.ty)) return null;
  const count = (k, r) => G.ents.filter((e) => e.type === 'mob' && e.kind === k && !e.dying && Math.abs(e.tx - P.tx) < r && Math.abs(e.ty - P.ty) < r).length;
  // the platform's spawner gets a try on about one call in three (one every 3 to 4 s near it), outside the shared cap
  if (Math.random() < 0.1) { const b = trySpawnBlaze(W, N, count, P); if (b) return b; }
  if (hostileCount(24, P) >= 8) return null;
  for (let tries = 0; tries < 12; tries++) {
    const a = Math.random() * Math.PI * 2, r = 9 + Math.random() * 9;
    const x = Math.round(P.tx + Math.cos(a) * r), y = Math.round(P.ty + Math.sin(a) * r * 0.75);
    if (!W.inNether(x, y) || W.protAt(x, y)) continue;
    const row = N.biome[y - N.y], zone = row && row[x - N.x], list = zone && N.spawns[zone];
    if (!list || !list.length) continue;
    let kind = list[Math.floor(Math.random() * list.length)];
    // the soul sand valley has a few endermen too
    if (zone === 'V' && Math.random() < 0.12 && MOBS().enderman) { if (count('enderman', 24) >= 2) continue; kind = 'enderman'; }
    if (!MOBS()[kind]) continue;
    if (peaceful() && kind !== 'enderman') continue;   // (the blaze platform's spawner above still works)
    // a pick of a kind that is thinned out ends this try (another kind does not take its place), and a kind at
    // its cap gives way to the others
    if (NETHER_KEEP[kind] && Math.random() >= NETHER_KEEP[kind]) return null;
    if (NETHER_CAP[kind] && kind !== 'ghast' && count(kind, 24) >= NETHER_CAP[kind]) continue;
    if (kind === 'ghast') {
      // over open ground or a lake with room around it, never inside the rock
      if (count('ghast', 40) >= NETHER_CAP.ghast || (W.solid(x, y) && !W.isLava(x, y))) continue;
      let open = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (!W.solid(x + dx, y + dy) || W.isLava(x + dx, y + dy)) open++;
      if (open < 18) continue;
      return spawnMob('ghast', x, y);
    }
    if (W.isLava(x, y) || !cellFree(x, y) || W.isPortal(x, y)) continue;
    if (kind === 'blaze') continue;   // blazes only come from the platform's spawner above
    // the ground around the arrival portal gives a newcomer room to look about: no magma cube starts there
    if (kind === 'magma_cube' && N.stepOut && Math.hypot(x - N.stepOut[0], y - N.stepOut[1]) < ARRIVAL_CLEAR) continue;
    if (kind === 'zombified_piglin') {
      if (count(kind, 24) >= 7) continue;
      // in a group of two to four
      const m = spawnMob(kind, x, y), n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0, k = 0; i < n && k < 12; k++) {
        const gx = x + Math.floor(Math.random() * 5) - 2, gy = y + Math.floor(Math.random() * 5) - 2;
        if (W.inNether(gx, gy) && !W.protAt(gx, gy) && !W.isLava(gx, gy) && cellFree(gx, gy)) { spawnMob(kind, gx, gy); i++; }
      }
      return m;
    }
    const size = kind === 'magma_cube' ? ['large', 'medium', 'small'][Math.floor(Math.random() * 3)] : undefined;
    return spawnMob(kind, x, y, { size });
  }
  return null;
}
// Farm animals live in Kanto's open grass, a few herds per route, placed once per world.
export function seedAnimals(rng) {
  const W = G.world;
  const kinds = ['sheep', 'sheep', 'cow', 'pig', 'chicken', 'chicken'];
  let placed = 0;
  for (const m of W.maps) {
    if (m.room || (m.type !== 'MAP_TYPE_ROUTE' && m.id !== 'MAP_PALLET_TOWN')) continue;
    const herds = Math.max(1, Math.round((m.w * m.h) / 900));
    for (let h = 0; h < herds; h++) {
      const kind = kinds[Math.floor(rng() * kinds.length)];
      const cx = m.x + Math.floor(rng() * m.w), cy = m.y + Math.floor(rng() * m.h);
      const n = 2 + Math.floor(rng() * 3);
      for (let i = 0, tries = 0; i < n && tries < 40; tries++) {
        const x = cx + Math.floor(rng() * 7) - 3, y = cy + Math.floor(rng() * 7) - 3;
        if (!W.inside(x, y) || W.zone[W.idx(x, y)] !== 0 || !W.isFloor(x, y) || W.tallGrass(x, y) || !W.isGrass(x, y) || !cellFree(x, y)) continue;
        spawnMob(kind, x, y, { persistent: true }); i++; placed++;
      }
    }
  }
  return placed;
}
