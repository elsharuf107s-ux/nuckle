// The Nether at runtime: lava (pools in the deep caves and the Nether's lakes), buckets and obsidian,
// obsidian portals (find the ring, light it, break it), the pre-placed blocks a new world starts with, the
// animated lava and portal surfaces, lava pops and the portal hum, the Nether's ambience, and the nausea
// wobble of standing in a portal. The region itself is tools/build_nether.py's; travel lives in main.js.
// Cosmetics and spawning use Math.random, never the seeded battle RNG.
import { A } from './assets.js';
import { G, TILE } from './game.js';
import { mc, ambience } from './audio.js';
import { particle, spriteParticle, mobAt } from './entities.js';
import { NET } from './net/flag.js';   // co-op: no pool comes back under another player

const W = () => G.world;
const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// the strip frame an animation (items.json anim: lava, portal, fire, soul_fire, magma) shows at time t
export function animFrame(name, t = G.clock) {
  const a = A.items.anim && A.items.anim[name];
  if (!a) return 0;
  return a.seq[Math.floor((t * 20) / a.frametime) % a.seq.length];
}

// ---------------------------------------------------------------- portals
// A frame cell: a placed obsidian block, or the Nether's own obsidian ring.
export const isFrame = (x, y) => { const b = W().block(x, y); return (b && b.id === 'obsidian') || W().mat(x, y) === 'obsidian'; };

// The interior of an obsidian ring that (x, y) lies in: a rectangle of empty floor from 2x3 to 21x21 (either
// way round), closed by obsidian on all four sides. Corners are optional, as in Minecraft. Null if (x, y) is
// not inside such a ring.
export function portalInterior(x, y) {
  const w = W();
  const ok = (X, Y) => {
    if (!w.inside(X, Y) || isFrame(X, Y)) return false;
    const b = w.block(X, Y);
    // fire, an old portal block, or the dirt a blast left (a crater) may stand where the portal goes
    if (b && b.id !== 'fire' && b.id !== 'nether_portal' && !b.crater) return false;
    if (w.isPortal(X, Y)) return true;
    return w.isFloor(X, Y) && !w.noPlace(X, Y);
  };
  if (!ok(x, y)) return null;
  const seen = new Set([y * w.W + x]), q = [[x, y]], cells = [];
  let x0 = x, x1 = x, y0 = y, y1 = y;
  while (q.length) {
    const [cx, cy] = q.pop();
    cells.push([cx, cy]);
    x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
    if (x1 - x0 >= 21 || y1 - y0 >= 21) return null;
    for (const [dx, dy] of D4) {
      const nx = cx + dx, ny = cy + dy, k = ny * w.W + nx;
      if (seen.has(k) || isFrame(nx, ny)) continue;
      if (!ok(nx, ny)) return null;          // open to something that isn't floor: no closed ring here
      seen.add(k); q.push([nx, ny]);
    }
  }
  const iw = x1 - x0 + 1, ih = y1 - y0 + 1;
  if (cells.length !== iw * ih || Math.min(iw, ih) < 2 || Math.max(iw, ih) < 3) return null;
  return { x: x0, y: y0, w: iw, h: ih, cells };
}
// Flint and steel (or a fire charge) on an interior cell, or on a ring block facing the interior: the
// interior fills with portal blocks. Returns the interior, or null.
export function lightPortal(x, y, dir) {
  const w = W();
  let r = null;
  if (isFrame(x, y)) {
    if (!dir) return null;
    // the interior beyond the frame (used from outside), or on Steve's own side of it (used from inside)
    const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
    const unlit = (q) => q && !q.cells.every(([cx, cy]) => w.isPortal(cx, cy));
    r = [portalInterior(x + d[0], y + d[1]), portalInterior(x - d[0], y - d[1])].find(unlit) || null;
  } else r = portalInterior(x, y);
  if (!r || r.cells.every(([cx, cy]) => w.isPortal(cx, cy))) return null;
  for (const [cx, cy] of r.cells) if (!w.isPortal(cx, cy)) w.setBlock(cx, cy, { id: 'nether_portal', walk: true });
  mc('ignite', { vol: 0.8 });
  mc('portal', { vol: 0.5 });
  for (const [cx, cy] of r.cells) portalSparks(cx, cy, 6);
  return r;
}
// A ring block went: every portal block it held goes out (Minecraft breaks the whole portal).
export function breakPortalNear(x, y) {
  const w = W();
  const q = [];
  for (const [dx, dy] of D4) { const b = w.block(x + dx, y + dy); if (b && b.id === 'nether_portal') q.push([x + dx, y + dy]); }
  let n = 0;
  while (q.length) {
    const [cx, cy] = q.pop();
    const b = w.block(cx, cy);
    if (!b || b.id !== 'nether_portal') continue;
    w.setBlock(cx, cy, null); n++;
    portalSparks(cx, cy, 4);
    for (const [dx, dy] of D4) q.push([cx + dx, cy + dy]);
  }
  if (n) mc('dig.glass', { vol: 0.8 });
  return n;
}
export function portalSparks(x, y, n = 1) {
  for (let i = 0; i < n; i++) {
    particle({ x: x * TILE + 2 + Math.random() * 12, y: y * TILE + 2 + Math.random() * 12, z: Math.random() * 10, vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 10,
      vz: 6 + Math.random() * 14, life: 0.8 + Math.random() * 0.9, color: Math.random() < 0.5 ? '#b04cff' : Math.random() < 0.5 ? '#7a2ae0' : '#e0a0ff', size: 1 + Math.random() * 1.5 });
  }
}

// ---------------------------------------------------------------- lava, buckets and obsidian
// An empty bucket on lava. A pool cell in the caves is used up; the Nether's lakes refill from around it.
export function scoopLava(x, y) {
  const w = W(), b = w.block(x, y);
  if (b && b.id === 'lava') { w.setBlock(x, y, null); return true; }
  return w.mat(x, y) === 'lava';
}
// A lava bucket poured on bare floor (or onto fire) in front of Steve.
export function pourLava(x, y) {
  const w = W(), b = w.block(x, y), P = G.P;
  if (!w.isFloor(x, y) || w.noPlace(x, y) || w.noBreak(x, y) || mobAt(x, y) || (P.tx === x && P.ty === y)) return false;
  if (b && b.id !== 'fire' && b.id !== 'soul_fire') return false;
  if (G.ents.some((e) => (e.type === 'item' || e.type === 'wild') && e.tx === x && e.ty === y)) return false;
  // never under a person or the follower Pokemon (lava is solid to them too)
  if (G.npcAt && G.npcAt(x, y)) return false;
  const f = G.follower;
  if (f && f.visible && ((f.tx === x && f.ty === y) || (f.moving && f.fromX === x && f.fromY === y))) return false;
  w.setBlock(x, y, { id: 'lava' });
  return true;
}
// Water poured at (x, y): on lava it sets into obsidian; anywhere else in the Nether it boils away.
// Returns 'obsidian', 'evaporate' or null (ordinary water).
export function waterOn(x, y) {
  const w = W(), b = w.block(x, y);
  if (b && b.id === 'lava') { w.setBlock(x, y, { id: 'obsidian' }); hiss(x, y); return 'obsidian'; }
  if (!b && w.mat(x, y) === 'lava' && w.inNether(x, y) && !w.noBreak(x, y)) {
    // a lake cell cools into a block of obsidian standing on netherrack (mined away, it leaves the floor)
    w.setTile(x, y, w.netherFloorTile(x, y));
    w.reedgeNether(x, y);
    w.setBlock(x, y, { id: 'obsidian' });
    hiss(x, y);
    return 'obsidian';
  }
  if (w.inNether(G.P.tx, G.P.ty)) { hiss(x, y, false); return 'evaporate'; }
  return null;
}
function hiss(x, y, stone = true) {
  mc('fizz', { vol: 0.6, pitch: 2.6 / (1.6 + Math.random()) });
  for (let i = 0; i < 8; i++) particle({ x: x * TILE + 3 + Math.random() * 10, y: y * TILE + 4 + Math.random() * 8, z: 4, vz: 14 + Math.random() * 10, vx: (Math.random() - 0.5) * 8,
    life: 0.9 + Math.random() * 0.6, img: A.mc.pSmoke, frames: 12, fw: 16, size: 0, scale: stone ? 1.3 : 1 });
}

// ---------------------------------------------------------------- what a new world starts with
// The lava pools of the deep caves and the Nether's own blocks (fire, soul fire, nether wart, the fortress's
// two loot chests, the keep's lamps). Old saves get them the first time they load (G.seeded remembers it:
// 2 before the lamps, 3 with them).
export function seedPlaced(onlyMap = null, lampsOnly = false) {
  const w = W();
  let n = 0;
  // never under Steve (an old save may stand him in a pool's middle), a mob, a Pokemon, a person or a dropped item
  const P = G.P, taken = (x, y) => (P && P.tx === x && P.ty === y) || (NET.on && NET.players().some((p) => p.tx === x && p.ty === y)) || (G.npcAt && G.npcAt(x, y)) || (G.ents || []).some((e) => (e.type === 'mob' || e.type === 'wild' || e.type === 'item') && (e.tx === x && e.ty === y || (e.type === 'item' && Math.floor(e.x / TILE) === x && Math.floor(e.y / TILE) === y)));
  // (a save seeded at 2 already has its pools: lampsOnly leaves the pools Steve emptied empty)
  if (!lampsOnly) for (const l of w.meta.lava || []) if ((!onlyMap || l.map === onlyMap) && !w.block(l.x, l.y) && w.isFloor(l.x, l.y) && !taken(l.x, l.y)) { w.setBlock(l.x, l.y, { id: 'lava' }); n++; }
  if (onlyMap) return n;
  const put = (list) => { for (const [x, y, rec] of list || []) if (!w.block(x, y) && w.isFloor(x, y) && !taken(x, y)) { w.setBlock(x, y, JSON.parse(JSON.stringify(rec))); n++; } };
  // the fortress keep's glowstone lamps came later (G.seeded 3): a save seeded before them gets only those
  if (!lampsOnly) put(w.nether && w.nether.blocks);
  put(w.nether && w.nether.lamps);
  G.seeded = 3;
  return n;
}

// The deep caves' pools seep back: each time Steve comes into one of those caves, every pool cell he emptied
// (scooped, or cooled to obsidian and mined) is lava again, unless he built over it or something stands there.
// One pool (9 cells) is short of a 10-block ring, and the caves are the only lava in Kanto, so a second trip
// to the same cave is always enough. No randomness.
export function refillPools(map) {
  const w = W(), lava = w.meta.lava || [];
  if (!map || !lava.some((l) => l.map === map.id)) return 0;
  let n = 0;
  for (const l of lava) if (l.map === map.id && !w.block(l.x, l.y) && w.isFloor(l.x, l.y)) n++;
  return n ? seedPlaced(map.id) : 0;
}

// ---------------------------------------------------------------- drawing: lava and portals move
// Over the ground layer (GBA pixels): every visible lava or portal surface gets its current frame. The
// Nether's lakes keep their bank in the tile's top layer; a cave pool gets a sunken edge drawn here.
export function drawGround(ctx, cam, vw, vh) {
  const w = W();
  const x0 = Math.floor(cam.x / TILE), x1 = Math.floor((cam.x + vw) / TILE), y0 = Math.floor(cam.y / TILE), y1 = Math.floor((cam.y + vh) / TILE);
  const lf = animFrame('lava'), pf = animFrame('portal');
  const lava = A.mc.lava, portal = A.mc.portalAnim;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!w.inside(x, y)) continue;
    const sx = x * TILE - cam.x, sy = y * TILE - cam.y;
    const b = w.blocks.get(y * w.W + x);
    if (b && b.id === 'lava') {
      ctx.drawImage(lava, 0, lf * 16, 16, 16, sx, sy, 16, 16);
      const lavaAt = (X, Y) => w.isLava(X, Y);
      if (!lavaAt(x, y - 1)) { ctx.fillStyle = 'rgba(40,10,4,0.75)'; ctx.fillRect(sx, sy, 16, 2); ctx.fillStyle = 'rgba(40,10,4,0.35)'; ctx.fillRect(sx, sy + 2, 16, 2); }
      ctx.fillStyle = 'rgba(44,12,14,0.8)';
      if (!lavaAt(x - 1, y)) ctx.fillRect(sx, sy, 1, 16);
      if (!lavaAt(x + 1, y)) ctx.fillRect(sx + 15, sy, 1, 16);
      if (!lavaAt(x, y + 1)) ctx.fillRect(sx, sy + 15, 16, 1);
      continue;
    }
    if (b && b.id === 'nether_portal') {
      // opaque over a dark base, like the Nether's own portal: the ground under it doesn't show through
      ctx.fillStyle = '#1a0630'; ctx.fillRect(sx, sy, 16, 16); ctx.drawImage(portal, 0, pf * 16, 16, 16, sx, sy, 16, 16);
      continue;
    }
    const info = w.ntiles.size ? w.ntiles.get(w.grid[y * w.W + x]) : null;
    if (!info) continue;
    if (info[0] === 'lava') ctx.drawImage(lava, 0, lf * 16, 16, 16, sx, sy, 16, 16);
    else if (info[0] === 'portal') ctx.drawImage(portal, 0, pf * 16, 16, 16, sx, sy, 16, 16);
    else if (info[0] === 'fence') drawFence(ctx, sx, sy, Number(info[2]) || 0);
    else if (info[0] === 'floor' && SOUL_FLOOR.has(info[1])) soulEdge(ctx, w, x, y, sx, sy);
  }
}
// Where a soul sand or soul soil floor meets another floor, its edge gets a dark rim and a dithered row inside
// it, so the patch reads as a different ground and not as a band of light or shadow.
const SOUL_FLOOR = new Set(['soul_sand', 'soul_soil']);
function soulEdge(ctx, w, x, y, sx, sy) {
  const other = (X, Y) => { const k = w.ntiles.get(w.grid[Y * w.W + X]); return !!k && k[0] === 'floor' && !SOUL_FLOOR.has(k[1]); };
  const n = other(x, y - 1), e = other(x + 1, y), s = other(x, y + 1), wst = other(x - 1, y);
  if (!(n || e || s || wst)) return;
  ctx.fillStyle = 'rgba(28,14,8,0.55)';
  if (n) ctx.fillRect(sx, sy, 16, 1);
  if (s) ctx.fillRect(sx, sy + 15, 16, 1);
  if (wst) ctx.fillRect(sx, sy, 1, 16);
  if (e) ctx.fillRect(sx + 15, sy, 1, 16);
  ctx.fillStyle = 'rgba(28,14,8,0.3)';
  for (let i = 0; i < 16; i += 2) {
    if (n) ctx.fillRect(sx + i + (x & 1), sy + 1, 1, 1);
    if (s) ctx.fillRect(sx + i + (x & 1), sy + 14, 1, 1);
    if (wst) ctx.fillRect(sx + 1, sy + i + (y & 1), 1, 1);
    if (e) ctx.fillRect(sx + 14, sy + i + (y & 1), 1, 1);
  }
}
// A nether brick fence (the bridge's and the blaze platform's rails), drawn over its tile brighter than the deck,
// with a lit top edge and a dark outline so it reads as a raised rail and not as floor pattern.
// conn: the joined sides, N=1 E=2 S=4 W=8.
const F_DARK = '#120305', F_RAIL = '#6a262c', F_POST = '#7c2e34', F_TOP = '#c0585a';
function drawFence(ctx, sx, sy, conn) {
  const r = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(sx + x, sy + y, w, h); };
  if (conn & 8) { r(0, 5, 6, 5, F_DARK); r(0, 6, 6, 2, F_RAIL); r(0, 6, 6, 1, F_TOP); }
  if (conn & 2) { r(10, 5, 6, 5, F_DARK); r(10, 6, 6, 2, F_RAIL); r(10, 6, 6, 1, F_TOP); }
  if (conn & 1) { r(6, 0, 4, 5, F_DARK); r(7, 0, 2, 5, F_RAIL); r(7, 0, 1, 5, F_TOP); }
  if (conn & 4) { r(6, 10, 4, 6, F_DARK); r(7, 10, 2, 6, F_RAIL); r(7, 10, 1, 6, F_TOP); }
  r(4, 3, 8, 9, F_DARK);
  r(5, 4, 6, 7, F_POST);
  r(5, 4, 6, 1, F_TOP); r(5, 4, 1, 6, '#9a4044');
  r(5, 12, 6, 1, 'rgba(0,0,0,0.45)');
}

// ---------------------------------------------------------------- ambient life: lava pops, the portal hum
let lavaSoundT = 0, portalSoundT = 0, addT = 6, moodT = 50;
// any lava or portal block near (x, y)? (looked up through the light buckets: both give off light)
function hotNear(w, x, y) {
  for (let by = (y - 12) >> 4; by <= (y + 12) >> 4; by++) for (let bx = (x - 15) >> 4; bx <= (x + 15) >> 4; bx++) {
    const bucket = w.lightB.get(by * 4096 + bx);
    if (!bucket) continue;
    for (const i of bucket.keys()) { const b = w.blocks.get(i); if (b && (b.id === 'lava' || b.id === 'nether_portal')) return true; }
  }
  return false;
}
export function ambient(dt) {
  const w = W(), P = G.P;
  lavaSoundT -= dt; portalSoundT -= dt;
  // nothing to animate here: no randomness spent (the video scripts seed Math.random and replay it)
  if (!w.inNether(P.tx, P.ty) && !hotNear(w, P.tx, P.ty)) return;
  // sample a few random cells around Steve each frame
  for (let k = 0; k < 10; k++) {
    const x = P.tx + Math.floor(Math.random() * 27) - 13, y = P.ty + Math.floor(Math.random() * 21) - 10;
    if (!w.inside(x, y) || w.areaOf(x, y) !== w.areaOf(P.tx, P.ty)) continue;
    const d = Math.hypot(x - P.tx, y - P.ty), vol = Math.max(0, 1 - d / 16);
    if (w.isLava(x, y)) {
      if (Math.random() < 0.05) {
        // Minecraft's lava particle: an ember thrown up out of the surface, falling back as it fades
        spriteParticle(A.mc.pLava, 1, x * TILE + 3 + Math.random() * 10, y * TILE + 4 + Math.random() * 8, { life: 0.9 + Math.random() * 0.8, vz: 40 + Math.random() * 40, g: -110, vx: (Math.random() - 0.5) * 24, fw: 8, scale: 1.4 });
        if (lavaSoundT <= 0 && Math.random() < 0.35 && vol > 0) { mc('lava_pop', { vol: 0.35 * vol, pitch: 0.9 + Math.random() * 0.15 }); lavaSoundT = 0.6 + Math.random(); }
      }
      if (lavaSoundT <= 0 && Math.random() < 0.004 && vol > 0) { mc('lava', { vol: 0.4 * vol, pitch: 0.9 + Math.random() * 0.15 }); lavaSoundT = 2 + Math.random() * 2; }
    } else if (w.isPortal(x, y)) {
      if (Math.random() < 0.25) portalSparks(x, y, 1);
      if (portalSoundT <= 0 && d < 8 && Math.random() < 0.05) { mc('portal', { vol: 0.35 * vol, pitch: 0.8 + Math.random() * 0.4 }); portalSoundT = 4 + Math.random() * 4; }
    }
  }
  // the Nether's ambience: its loop for the biome Steve is in, with its additions and the rarer mood
  if (w.inNether(P.tx, P.ty)) {
    const b = biomeAt(P.tx, P.ty);
    const name = b === 'V' ? 'soul_sand_valley' : 'nether_wastes';
    if (ambience.current !== name && G.rules.nether !== false) ambience.play(name);
    addT -= dt; moodT -= dt;
    if (addT <= 0) { addT = 5 + Math.random() * 10; mc(name + '.additions', { vol: 0.35 + Math.random() * 0.25, pitch: 0.9 + Math.random() * 0.2 }); }
    if (moodT <= 0) { moodT = 50 + Math.random() * 60; mc(name + '.mood', { vol: 0.45 }); }
    if (b === 'V' && Math.random() < dt * 0.6) {
      // soul sand valley: drifting souls
      const x = P.tx + Math.floor(Math.random() * 21) - 10, y = P.ty + Math.floor(Math.random() * 15) - 7;
      if (w.mat(x, y) === 'soul_sand' || w.mat(x, y) === 'soul_soil') spriteParticle(A.mc.pSoul, 11, x * TILE + 8, y * TILE + 8, { life: 1.6, vz: 10, fw: 16, scale: 0.75 });
    }
  }
}
// the biome letter at a Nether cell (W wastes, V soul sand valley, L lava sea, F fortress, B blaze platform)
export function biomeAt(x, y) {
  const N = W().nether;
  if (!N) return null;
  const row = N.biome[y - N.y];
  return row ? row[x - N.x] || null : null;
}

// ---------------------------------------------------------------- the portal's nausea
// k from 0 to 1: the picture waves sideways, more and more, under a swirl of the portal's own texture.
let snap = null;
export function drawNausea(ctx, canvas, k) {
  if (k <= 0) return;
  const Wd = canvas.width, Hd = canvas.height;
  if (!snap || snap.width !== Wd) { snap = document.createElement('canvas'); snap.width = Wd; snap.height = Hd; }
  const g = snap.getContext('2d');
  g.clearRect(0, 0, Wd, Hd); g.drawImage(canvas, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const amp = 2 + k * 14, t = G.clock;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, Wd, Hd);
  for (let y = 0; y < Hd; y += 2) {
    const off = Math.sin(y / 23 + t * 5.2) * amp + Math.sin(y / 61 - t * 2.3) * amp * 0.5;
    const o = Math.round(off);
    ctx.drawImage(snap, 0, y, Wd, 2, o, y, Wd, 2);
    // the gap a shifted slice leaves at the edge is filled with that edge's own pixels, stretched (never black bands)
    if (o > 0) ctx.drawImage(snap, 0, y, 1, 2, 0, y, o, 2);
    else if (o < 0) ctx.drawImage(snap, Wd - 1, y, 1, 2, Wd + o, y, -o, 2);
  }
  // the portal's swirl over everything, as Minecraft draws it while you stand inside (here tiled, 6x)
  ctx.globalAlpha = Math.min(0.7, k * 0.75);
  ctx.imageSmoothingEnabled = false;
  const f = animFrame('portal'), T = 96, ox = Math.round((t * 7) % T);
  for (let y = -T; y < Hd; y += T) for (let x = -T; x < Wd; x += T) ctx.drawImage(A.mc.portalAnim, 0, f * 16, 16, 16, x + ox, y + Math.round(ox / 2), T, T);
  ctx.globalAlpha = 1;
  ctx.restore();
}
