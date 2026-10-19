// Minecraft's endgame at runtime: the stronghold (its pre-placed blocks, infested bricks, the silverfish spawner,
// the twelve end portal frames and the portal they open), eyes of ender that lead to Route 23's entrance, ender
// pearls, the trip to The End and the exit portal home, The End's own rules (the animated void, bridging, falling
// out of the world, its music), the dragon egg, and the hooks the rest of the game calls into. The dragon fight
// itself is src/dragon.js. The regions are tools/build_stronghold.py's and tools/build_end.py's.
// Cosmetics use Math.random, never the seeded battle RNG.
import { A } from './assets.js';
import { G, TILE, DIRS } from './game.js';
import { mc, music } from './audio.js';
import * as E from './entities.js';
import { item } from './items.js';
import { animFrame } from './nether.js';
import * as DR from './dragon.js';
import { NET } from './net/flag.js';   // co-op: a guest spawns nothing (the host's world is the shared one)

const W = () => G.world;

// ---------------------------------------------------------------- the update loop must never throw
// Every End and stronghold system runs through safe(): an error is logged once (and kept in G.errors for the tests)
// and the game goes on.
const seenErr = new Set();
export function safe(name, fn) {
  try { return fn(); } catch (e) {
    G.errors = G.errors || [];
    if (G.errors.length < 30) G.errors.push(name + ': ' + ((e && e.stack) || e));
    if (!seenErr.has(name)) { seenErr.add(name); console.warn('[end] ' + name, e); }
    return undefined;
  }
}

// ---------------------------------------------------------------- state (saved with the game)
export function freshState() {
  const pillars = (W().end && W().end.pillars) || [];
  return {
    eyeMsg: false,                       // "The EYE OF ENDER only seems to work outdoors." shown once
    eyeShort: false,                     // the line for an eye that stopped short of a barrier, shown once
    crystals: pillars.map((p) => ({ alive: true, cage: p.caged ? 2 : 0 })),
    placed: [],                          // end crystals Steve put down: [{ x, y }]
    dragon: { alive: true, hp: 200, exhausted: false },
    kills: 0,                            // dragons defeated or caught
    respawned: false,                    // the dragon alive now came back through the ritual
    exitActive: false,
    egg: null,                           // 'pillar' while the egg sits on the fountain's pillar
    eggHops: 0, eggHint: false,
    hofSeen: false,
    ritualOn: false,                     // saved during the respawn ritual: it starts again on loading
  };
}
export function initState() { G.end = freshState(); resume = null; }
// A save made during one of the dragon's set pieces: the death sequence (G.end.dragon.dying, set when it starts; the
// XP still to come is noted) or the respawn ritual. Loading finishes or restarts them (resumeSetPieces).
export function serialize() {
  const out = JSON.parse(JSON.stringify(G.end));
  if (out.dragon && out.dragon.dying) out.dragon.dying.left = DR.dying() ? DR.deathXpLeft() : (out.dragon.dying.left ?? out.dragon.dying.xp);
  out.ritualOn = DR.ritualOn();
  return out;
}
let resume = null;
function resumeSetPieces() {
  const r = resume; resume = null;
  if (!r || !W().end) return;
  if (r.dying) DR.finishDying(Math.max(0, Number(r.dying.left ?? r.dying.xp) || 0));
  else if (r.ritual && !G.end.dragon.alive) DR.startRitual();
  // four crystals already on the sides of the open exit portal (the ritual's own condition)
  else DR.checkRitual();
  G.end.ritualOn = false;
}
export function restore(d) {
  const s = freshState();
  if (d && typeof d === 'object') {
    for (const k of Object.keys(s)) if (d[k] !== undefined) s[k] = d[k];
    if (!Array.isArray(s.crystals) || s.crystals.length !== freshState().crystals.length) s.crystals = freshState().crystals;
    if (!Array.isArray(s.placed)) s.placed = [];
    s.dragon = { ...freshState().dragon, ...(d.dragon || {}) };
  }
  G.end = s;
  DR.reset();
  resume = { dying: s.dragon.dying || null, ritual: !!s.ritualOn };
}

// ---------------------------------------------------------------- what a new world (or an old save) starts with
// The stronghold's chests, cobwebs, iron bars, spawner, portal-room lava and the twelve frames (two with an eye).
// Old saves get them the first time they load (G.seeded 4).
export function seedStronghold() {
  const w = W(), S = w.stronghold;
  if (!S) return 0;
  let n = 0;
  for (const [x, y, rec] of S.blocks || []) {
    if (w.block(x, y)) continue;
    w.setBlock(x, y, JSON.parse(JSON.stringify(rec)));
    n++;
  }
  G.seeded = Math.max(G.seeded || 0, 4);
  return n;
}
// Route 23's entrance block: an old save may have changed that cell before it was the entrance (its boulder
// mined): it is the closed cracked block again unless it is already the open stairway.
export function fixEntrance() {
  const w = W(), S = w.stronghold;
  if (!S || !S.entrance) return;
  const { x, y } = S.entrance;
  // (a Wild World's planned entrance, 6c: its chunk may not be made yet, where tile() reads 0 and a fix would only
  // record an override over a saved open stairway; the generator draws it closed, so nothing to fix until it is)
  if (w.layout && w.layout.gen && !w.ready(x, y)) return;
  const t = w.tile(x, y), T = S.entranceTiles;
  const b = w.block(x, y);
  if (t !== T.closed && t !== T.open) w.setTile(x, y, T.closed);
  if (b) {
    // something the player built there before it was the entrance comes off as items on the grass south of it,
    // with what it held, as breaking it would give
    const drop = (id, n = 1, extra) => E.dropItem(id, n, x * TILE, (y + 1) * TILE, extra);
    const it = item(b.id);
    if (it && it.block && it.block.drop !== null && !b.flush) drop(b.id === 'white_bed' ? 'white_bed' : (it.block.drop || b.id));
    if (b.id === 'chest') for (const st of b.slots || []) if (st) drop(st.id, st.n, st.dmg ? { dmg: st.dmg } : undefined);
    if (b.id === 'furnace') for (const st of [b.input, b.fuel, b.output]) if (st) drop(st.id, st.n);
    if (b.id === 'campfire') for (const st of b.items || []) if (st) drop(st.id, 1);
    if (b.id === 'white_bed' && b.other) w.setBlock(b.other[0], b.other[1], null);
    w.setBlock(x, y, null);
    if (G.spawnBed && ((G.spawnBed[0] === x && G.spawnBed[1] === y) || (b.other && G.spawnBed[0] === b.other[0] && G.spawnBed[1] === b.other[1]))) G.spawnBed = null;
  }
  // a save made standing on that cell: he steps off it onto the grass
  const P = G.P;
  if (P && P.tx === x && P.ty === y && !entranceOpen()) {
    for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1], [-1, 1], [1, 1]]) {
      if (!w.solid(x + dx, y + dy) && !w.isWater(x + dx, y + dy)) { P.tx = P.fromX = P.fx = x + dx; P.ty = P.fromY = P.fy = y + dy; P.moving = false; break; }
    }
  }
}
export function entranceOpen() { const S = W().stronghold; return !!S && !!S.entrance && W().tile(S.entrance.x, S.entrance.y) === S.entranceTiles.open; }
export function revealEntrance() {
  const S = W().stronghold;
  if (!S || !S.entrance || entranceOpen()) return false;   // (a Wild World's entrance is the plan's, 6c)
  W().setTile(S.entrance.x, S.entrance.y, S.entranceTiles.open);
  return true;
}

// ---------------------------------------------------------------- the portal room
export function frameCells() { const S = W().stronghold; return S ? S.frames.map(([x, y]) => [x, y]) : []; }
export function eyesIn() { let n = 0; for (const [x, y] of frameCells()) { const b = W().block(x, y); if (b && b.id === 'end_portal_frame' && b.eye) n++; } return n; }
export function portalOpen() { const S = W().stronghold; return !!S && S.portal.centre.every(([x, y]) => W().isEndPortal(x, y)); }
// X with an eye of ender at an empty frame: the eye goes in; the twelfth opens the portal.
function useFrame(x, y, b) {
  if (b.eye) return false;
  b.eye = true;
  W().setBlock(x, y, b);
  G.inv.useHeld();
  mc('eye_place', { vol: 0.9 });
  E.portalPuff(x * TILE + 8, y * TILE + 2, 6, 8);
  if (eyesIn() >= 12) openPortal();
  return true;
}
export function openPortal() {
  const S = W().stronghold;
  if (!S) return;
  for (const [x, y] of S.portal.centre) W().setBlock(x, y, { id: 'end_portal', walk: true });
  mc('end_portal_spawn', { vol: 1 });
  G.shake = Math.max(G.shake || 0, 0.25);
  for (const [x, y] of S.portal.centre) E.portalPuff(x * TILE + 8, y * TILE + 8, 6, 14);
}
export function fillFrames(n = 12) {
  let put = 0;
  for (const [x, y] of frameCells()) {
    if (eyesIn() >= n) break;
    const b = W().block(x, y);
    if (b && b.id === 'end_portal_frame' && !b.eye) { b.eye = true; W().setBlock(x, y, b); put++; }
  }
  if (eyesIn() >= 12 && !portalOpen()) openPortal();
  return put;
}

// ---------------------------------------------------------------- infested bricks, silverfish, the spawner
// An infested block was mined (player.js): its silverfish comes out where it stood.
export function onInfested(x, y) {
  const m = E.spawnMob('silverfish', x, y);
  m.angry = true;
  E.breakParticles(x * TILE, y * TILE, ['#8a8a8a', '#6f6f6f', '#a0a0a0'], 10);
  mc('silverfish.say', { vol: 0.7 });
  return m;
}
// A silverfish was hurt: every infested block within five cells lets its silverfish out (after a moment, as the
// call goes round in Minecraft), and leaves a hole where it was.
const wakeQueue = [];
export function onSilverfishHurt(m) { if (!wakeQueue.some((q) => Math.hypot(q.x - m.tx, q.y - m.ty) < 2)) wakeQueue.push({ x: m.tx, y: m.ty, t: 0.5 }); }
export function infestedCells() {
  const S = W().stronghold;
  return S ? S.infested.filter(([x, y]) => String(W().mat(x, y)).startsWith('infested_')) : [];
}
function wakeFriends(dt) {
  for (let i = wakeQueue.length - 1; i >= 0; i--) {
    const q = wakeQueue[i];
    q.t -= dt;
    if (q.t > 0) continue;
    wakeQueue.splice(i, 1);
    let n = 0;
    for (const [x, y] of infestedCells()) {
      if (Math.hypot(x - q.x, y - q.y) > 5 || n >= 6) continue;
      W().breakTile(x, y);
      onInfested(x, y);
      n++;
    }
  }
}
// The portal room's monster spawner: while Steve is within 16 cells, every 10 to 40 s it puts up to four
// silverfish on the floor around it, if fewer than six are about (Minecraft's numbers).
let spawnT = 3, caveT = 20;
function spawner(dt, around = G.P) {
  const S = W().stronghold, P = around;
  if (!S || !S.spawner || !P) return;
  const [sx, sy] = S.spawner, b = W().block(sx, sy);
  if (!b || b.id !== 'spawner') return;
  if (Math.hypot(P.tx - sx, P.ty - sy) > 16 || !W().inStronghold(P.tx, P.ty)) return;
  if (Math.random() < dt * 6) E.particle({ x: sx * TILE + 3 + Math.random() * 10, y: sy * TILE + 4 + Math.random() * 6, z: 6 + Math.random() * 8, vz: 8, life: 0.6, img: A.mc.pFlame, frames: 1, fw: 8, size: 0, scale: 1 });
  if (Math.random() < dt * 3) E.particle({ x: sx * TILE + 8, y: sy * TILE + 6, z: 10, vz: 10, life: 0.9, img: A.mc.pSmoke, frames: 12, fw: 16, size: 0, scale: 0.9 });
  spawnT -= dt;
  if (spawnT > 0 || !G.rules.mobs) return;
  spawnT = 10 + Math.random() * 30;
  const near = G.ents.filter((e) => e.type === 'mob' && e.kind === 'silverfish' && !e.dying && Math.hypot(e.tx - sx, e.ty - sy) < 9).length;
  let put = 0;
  for (let k = 0; k < 16 && put < 4 && near + put < 6; k++) {
    const x = sx + Math.floor(Math.random() * 9) - 4, y = sy + Math.floor(Math.random() * 9) - 4;
    if (!W().inStronghold(x, y) || W().isLava(x, y) || !E.cellFree(x, y) || W().isEndPortal(x, y)) continue;
    const bb = W().block(x, y);
    if (bb && !bb.walk) continue;
    E.spawnMob('silverfish', x, y).angry = true;
    E.poof(x * TILE + 8, y * TILE + 8, 6);
    put++;
  }
}

// ---------------------------------------------------------------- eyes of ender and ender pearls
const flying = [];               // { kind: 'eye' | 'pearl', ... } (world pixels; z the height above the ground)
export const projectiles = flying;
function entranceCell() { const S = W().stronghold; return S && S.entrance ? S.entrance : null; }
// X with an eye of ender. Outdoors in Kanto it flies about four cells toward Route 23's entrance (the nearest of
// eight directions), hovers, and comes down as an item (80%) or shatters (20%); within three cells of the
// entrance it dives into the ground there. Anywhere else it rises, hovers and drops back with no direction.
// Generated layouts (3.13, stage 6c): it flies eight cells, in the exact direction of the entrance while Steve is
// more than 64 cells from it (the nearest of eight within 64), and where it may come down is a local reachability
// test (a BFS over the cells around him) instead of the labelling of all of outdoor Kanto.
const EYE_EXACT = 64, EYE_FLY_GEN = 8, EYE_REACH = 14;
export function throwEye(P, opts = {}) {
  const w = W(), sx = P.fx * TILE + 8, sy = P.fy * TILE + 8, ent = entranceCell(), gen = !!(w.layout && w.layout.gen);
  G.inv.useHeld();
  mc('eye_launch', { vol: 0.8, pitch: 0.9 + Math.random() * 0.2 });
  P.swingT = 0.001;
  const e = { kind: 'eye', t: 0, x0: sx, y0: sy, x: sx, y: sy, z: 10, x1: sx, y1: sy, mode: 'lost', fate: opts.fate || null };
  if (ent && w.isOutdoor(P.tx, P.ty)) {
    const ex = ent.x * TILE + 8, ey = ent.y * TILE + 8, d = Math.hypot(ex - sx, ey - sy) / TILE;
    if (d <= 3) { e.mode = 'dive'; e.x1 = ex; e.y1 = ey; }
    else {
      const exact = gen && d > EYE_EXACT, ang = Math.atan2(ey - sy, ex - sx);
      const a = exact ? ang : Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      e.mode = 'seek'; e.dir = Math.round(((a / (Math.PI / 4)) % 8 + 8) % 8); e.exact = exact;
      // it stops over the last cell of its four (eight) whose item Steve can still reach (never over the sea filler
      // or the map's edge, where it would be lost)
      const from = gen ? null : outdoorPart(P.tx, P.ty);
      const reach = gen ? localReach(P.tx, P.ty, EYE_FLY_GEN + EYE_REACH) : null;
      let k = gen ? EYE_FLY_GEN : 4;
      while (k > 0 && !eyeReach(sx + Math.cos(a) * k * TILE, sy + Math.sin(a) * k * TILE, from, reach)) k--;
      e.x1 = sx + Math.cos(a) * k * TILE; e.y1 = sy + Math.sin(a) * k * TILE;
      e.short = k < (gen ? EYE_FLY_GEN : 4);
    }
  } else if (!G.end.eyeMsg) {
    G.end.eyeMsg = true;
    e.msg = true;
  }
  flying.push(e);
  return e;
}
// Can Steve get an eye that comes down at pixel (ix, iy)? Some cell he can walk or swim to, or mine his way into,
// close enough that standing there picks it up (the pickup reach is 1.6 cells from his feet). The cell must also be
// joined to where he stands: a pen fenced by buildings or a floor cell shut inside a gatehouse is out of reach even
// though it is open ground.
function eyeReach(ix, iy, from, reach = null) {
  const w = W(), cx = Math.floor(ix / TILE), cy = Math.floor(iy / TILE);
  for (let Y = cy - 2; Y <= cy + 2; Y++) for (let X = cx - 2; X <= cx + 2; X++) {
    if (Math.hypot(X * TILE + 8 - ix, Y * TILE + 10 - iy) > 23) continue;
    if (!w.isOutdoor(X, Y) || w.isVoid(X, Y)) continue;
    if (reach ? !reach.has(Y * w.W + X) : from && outdoorPart(X, Y) !== from) continue;
    if (passable(X, Y)) return true;
  }
  return false;
}
// a cell Steve can stand in, swim through, jump down onto, or mine open (protected and unbreakable cells are walls)
function passable(X, Y) {
  const w = W();
  if (w.isVoid(X, Y)) return false;
  if (!w.solid(X, Y) || w.isWater(X, Y) || w.jumpDir(X, Y)) return true;
  if (w.noBreak(X, Y)) return false;
  const m = w.mat(X, Y), sp = A.world.materials[m];
  return !!(A.world.ores[m] || (sp && sp.hard >= 0));
}
// Generated layouts (6c): the outdoor cells within r (Chebyshev) of (x, y) that Steve can reach from there through
// passable cells without leaving that square (a cell index set; unmade chunks are void, so never in it).
export function localReach(x, y, r) {
  const w = W(), out = new Set(), n = 2 * r + 1, seen = new Uint8Array(n * n), q = [];
  const at = (X, Y) => (Y - y + r) * n + (X - x + r);
  if (!w.isOutdoor(x, y)) return out;
  seen[at(x, y)] = 1; q.push(x, y); out.add(y * w.W + x);
  for (let h = 0; h < q.length; h += 2) {
    const x1 = q[h], y1 = q[h + 1];
    for (let d = 0; d < 4; d++) {
      const X = x1 + (d === 0 ? 1 : d === 1 ? -1 : 0), Y = y1 + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (X < x - r || X > x + r || Y < y - r || Y > y + r || seen[at(X, Y)]) continue;
      seen[at(X, Y)] = 1;
      if (!w.isOutdoor(X, Y) || !passable(X, Y)) continue;
      out.add(Y * w.W + X); q.push(X, Y);
    }
  }
  return out;
}
// Outdoor Kanto split into the parts that connect through passable cells. Placed blocks count as walls, so the
// labelling is redone on the next throw after any outdoor block changes (world.outdoorVer).
let parts = null;
export function outdoorPart(x, y) {
  const w = W(), ow = w.outdoor.w, oh = w.outdoor.h;
  if (!w.isOutdoor(x, y)) return 0;
  if (!parts || parts.w !== ow || parts.world !== w || parts.ver !== (w.outdoorVer || 0)) {
    const lab = new Int32Array(ow * oh), q = new Int32Array(ow * oh);
    let n = 0;
    for (let i = 0; i < ow * oh; i++) {
      if (lab[i]) continue;
      const x0 = i % ow, y0 = (i / ow) | 0;
      if (!passable(x0, y0)) { lab[i] = -1; continue; }
      n++; lab[i] = n; let h = 0, t = 0; q[t++] = i;
      while (h < t) {
        const j = q[h++], x1 = j % ow, y1 = (j / ow) | 0;
        for (let d = 0; d < 4; d++) {
          const X = x1 + (d === 0 ? 1 : d === 1 ? -1 : 0), Y = y1 + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (X < 0 || Y < 0 || X >= ow || Y >= oh) continue;
          const k = Y * ow + X;
          if (lab[k]) continue;
          if (!passable(X, Y)) { lab[k] = -1; continue; }
          lab[k] = n; q[t++] = k;
        }
      }
    }
    parts = { w: ow, world: w, lab, ver: w.outdoorVer || 0 };
  }
  const v = parts.lab[y * ow + x];
  return v > 0 ? v : 0;
}
// X with an ender pearl: it flies up to 10 cells ahead in an arc, over water and The End's void, and stops at the
// first wall (landing in front of it). Steve teleports where it lands and takes 5 damage; over the void it is lost.
export function throwPearl(P) {
  const w = W(), d = DIRS[P.dir];
  // generated layouts (2.13): every cell the pearl can reach exists before its path is read (the streaming keeps
  // them ready already; after a teleport they are painted here)
  if (w.layout.gen) w.ensureAround(P.tx + d.x * 10, P.ty + d.y * 10, 0, true);
  G.inv.useHeld();
  mc('pearl_throw', { vol: 0.7, pitch: 0.4 / (Math.random() * 0.4 + 0.8) + 0.5 });
  P.swingT = 0.001;
  const cells = [];
  for (let k = 1; k <= 10; k++) {
    const x = P.tx + d.x * k, y = P.ty + d.y * k;
    if (!w.inside(x, y)) break;
    if (w.isEndVoid(x, y)) { cells.push([x, y, true]); continue; }
    if (w.solid(x, y) && !w.isWater(x, y)) break;
    cells.push([x, y, false]);
  }
  // nobody stands where he lands: back off past a mob, a person or a POKeMON in the way
  while (cells.length) {
    const [x, y, v] = cells[cells.length - 1];
    if (v || !(E.mobAt(x, y) || (G.npcAt && G.npcAt(x, y)) || (G.wildAt && G.wildAt(x, y)))) break;
    cells.pop();
  }
  const last = cells[cells.length - 1];
  const sx = P.fx * TILE + 8, sy = P.fy * TILE + 8;
  const e = { kind: 'pearl', t: 0, x0: sx, y0: sy, x: sx, y: sy, z: 8, from: regionOf(P.tx, P.ty) };
  if (!last) { e.x1 = sx; e.y1 = sy; e.land = null; }
  else { e.x1 = last[0] * TILE + 8; e.y1 = last[1] * TILE + 8; e.land = { x: last[0], y: last[1], void: last[2] }; }
  e.dur = Math.max(0.25, 0.09 * (cells.length || 1));
  flying.push(e);
  return e;
}
// Where a cell belongs for a pearl in flight: all of outdoor Kanto is one region (a pearl may cross from one town
// or route into the next); every room, cave, the Nether, the stronghold and The End is its own.
function regionOf(x, y) { const w = W(); return w.isOutdoor(x, y) ? 'kanto' : w.areaOf(x, y); }
function updateFlying(dt) {
  const P = G.P;
  for (let i = flying.length - 1; i >= 0; i--) {
    const e = flying[i];
    e.t += dt;
    if (e.kind === 'pearl') {
      const k = Math.min(1, e.t / e.dur);
      e.x = e.x0 + (e.x1 - e.x0) * k; e.y = e.y0 + (e.y1 - e.y0) * k; e.z = 8 + Math.sin(k * Math.PI) * (10 + 3 * e.dur * 10) - k * 6;
      if (Math.random() < 0.6) E.portalPuff(e.x, e.y - e.z, 1, 4);
      if (k >= 1) { flying.splice(i, 1); pearlLands(e); }
      continue;
    }
    // eyes
    if (Math.random() < 0.7) E.portalPuff(e.x, e.y - e.z, 1, 3);
    if (e.mode === 'lost') {
      e.z = 10 + Math.min(1, e.t / 0.8) * 22 + (e.t > 0.8 ? Math.sin((e.t - 0.8) * 5) * 1.5 : 0);
      if (e.t >= 2.2) {
        flying.splice(i, 1);
        E.dropItem('eye_of_ender', 1, P.fx * TILE, P.fy * TILE, {}, { delay: 0.4 });
        if (e.msg) G.say('The EYE OF ENDER only seems to work outdoors.');
      }
      continue;
    }
    const FLY = e.mode === 'dive' ? 0.9 : 1.3, HOVER = e.mode === 'dive' ? 0.5 : 1.3;
    if (e.t < FLY) {
      const k = e.t / FLY, s = 1 - Math.pow(1 - k, 2.2);
      e.x = e.x0 + (e.x1 - e.x0) * s; e.y = e.y0 + (e.y1 - e.y0) * s; e.z = 10 + Math.sin(k * Math.PI * 0.5) * 22;
    } else if (e.t < FLY + HOVER) {
      e.x = e.x1; e.y = e.y1; e.z = 32 + Math.sin((e.t - FLY) * 6) * 1.5;
    } else if (e.mode === 'dive') {
      // straight down into the ground at the entrance
      e.z = 32 - (e.t - FLY - HOVER) * 120;
      if (e.z <= 0) {
        flying.splice(i, 1);
        E.portalPuff(e.x, e.y, 16, 10);
        E.breakParticles(e.x - 8, e.y - 8, ['#5a5a5a', '#7a7a7a', '#3c8c5c'], 8, 2);
        mc('eye_death', { vol: 0.35, pitch: 0.6 });
        const it = E.dropItem('eye_of_ender', 1, e.x - 8, e.y - 8, {}, { delay: 0.4 });
        if (it) { it.vx = 0; it.vy = 0; it.vz = 30; }
        if (G.onEyeDive) G.onEyeDive();
      }
    } else {
      flying.splice(i, 1);
      const shatter = e.fate ? e.fate === 'shatter' : Math.random() < 0.2;
      if (shatter) {
        mc('eye_death', { vol: 0.8 });
        E.breakParticles(e.x - 8, e.y - e.z - 8, ['#2e8c5a', '#6ed29a', '#1a4a32', '#e0e0a0'], 12, 2);
        E.portalPuff(e.x, e.y - e.z, 10, 8);
        G.lastEye = { fate: 'shatter', x: e.x, y: e.y };
      } else {
        const it = E.dropItem('eye_of_ender', 1, e.x - 8, e.y - 8, {}, { delay: 0.3 });
        if (it) { it.z = 30; it.vx = 0; it.vy = 0; it.vz = 0; }
        G.lastEye = { fate: 'drop', x: e.x, y: e.y, dir: e.dir };
      }
      if (e.short && !G.end.eyeShort) { G.end.eyeShort = true; G.say("The EYE OF ENDER couldn't fly on.\nThe way must go around."); }
    }
  }
}
function pearlLands(e) {
  const P = G.P, w = W();
  if (!e.land) return;
  E.portalPuff(e.x, e.y, 14, 10);
  if (e.land.void) { mc('enderman.portal', { vol: 0.25, pitch: 0.6 }); return; }        // lost in the void
  if (P.dead || P.voidFall || P.sleeping) return;
  const { x, y } = e.land;
  // he went through a door, warp or portal while it flew: the pearl is spent and he stays where he is
  const here = regionOf(P.tx, P.ty);
  if (here !== e.from || regionOf(x, y) !== here) return;
  if (w.solid(x, y) && !w.isWater(x, y)) return;
  E.portalPuff(P.fx * TILE + 8, P.fy * TILE + 4, 16, 12);
  P.riding = null; P.mining = null; P.using = null;
  P.tx = P.fromX = P.fx = x; P.ty = P.fromY = P.fy = y; P.moving = false; P.prog = 0;
  P.swimming = w.isWater(x, y);
  mc('enderman.portal', { vol: 0.8 });
  E.portalPuff(x * TILE + 8, y * TILE + 4, 16, 12);
  P.invuln = 0;
  G.hurtPlayer(5, `${P.name} fell from a high place`, null, false, { noArmor: true });
  if (G.onTeleported) G.onTeleported();
}
// eyes and pearls in the air, at full resolution like dropped items, with their shadows
export function drawFlying(ctx, cam) {
  for (const e of flying) {
    const id = e.kind === 'eye' ? 'eye_of_ender' : 'ender_pearl', it = item(id);
    if (!it) continue;
    const sx = (e.x - cam.x) * 2, sy = (e.y - cam.y) * 2;
    if (e.z > 0) { ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(Math.round(sx - 4), Math.round(sy + 4), 8, 2); }
    const i = it.iconIndex, s = e.kind === 'eye' ? 16 : 12;
    if (e.kind === 'eye') {
      // a faint green glow round the eye, so it reads against grass and trees
      const gx = sx, gy = sy - Math.max(0, e.z) * 2, g = ctx.createRadialGradient(gx, gy, 1, gx, gy, 14);
      g.addColorStop(0, 'rgba(160,255,200,0.55)'); g.addColorStop(1, 'rgba(60,200,140,0)');
      ctx.fillStyle = g; ctx.fillRect(gx - 14, gy - 14, 28, 28);
    }
    ctx.drawImage(A.mc.icons, (i % 32) * 16, Math.floor(i / 32) * 16, 16, 16, Math.round(sx - s / 2), Math.round(sy - Math.max(0, e.z) * 2 - s / 2), s, s);
  }
}
// X with an ender pearl, an eye of ender or an end crystal (player.js useItem)
export function useEndItem(P, held, f) {
  const id = held.id;
  if (id === 'ender_pearl') { if (flying.some((e) => e.kind === 'pearl')) return true; throwPearl(P); return true; }
  if (id === 'eye_of_ender') {
    const b = W().block(f.x, f.y);
    if (b && b.id === 'end_portal_frame') return useFrame(f.x, f.y, b);
    if (flying.some((e) => e.kind === 'eye')) return true;
    throwEye(P);
    return true;
  }
  if (id === 'end_crystal') return DR.placeCrystal(P, f);
  return false;
}

// ---------------------------------------------------------------- The End: arrival, the exit portal, falling
export function inEnd(x = G.P.tx, y = G.P.ty) { return W().inEnd(x, y); }
// Minecraft rebuilds the obsidian platform every time someone arrives: mined cells come back, and blocks on it go.
export function regenPlatform() {
  const w = W(), N = w.end;
  if (!N) return;
  const [px, py, pw, ph] = N.platform;
  for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) {
    const i = y * w.W + x, orig = w.baseTile(i);
    const b = w.block(x, y);
    if (b && b.id !== 'chest') w.setBlock(x, y, null);
    if (w.tile(x, y) !== orig) { w.setTile(x, y, orig); w.reedgeEnd(x, y); }
  }
}
export function arrival() { const N = W().end; return N ? N.arrival : null; }
// the island proper (not the platform, a bridge out to it, or the void): the dragon's battle music plays here
export function onIsland(x = G.P.tx, y = G.P.ty) {
  const N = W().end;
  if (!N || !W().inEnd(x, y)) return false;
  return Math.hypot(x - N.island.cx, y - N.island.cy) <= N.island.r + 2;
}
// Steve was knocked into a void cell: he slides into it, drops out of sight and dies ("fell out of the world").
// His things stay on the last cell he stood on (the deliberate mercy).
export function fallIntoVoid(x, y) {
  const P = G.P;
  if (P.voidFall || P.dead) return;
  P.voidFall = { t: 0, safe: { x: P.tx, y: P.ty } };
  P.mining = null; P.using = null; P.riding = null; P.sprinting = false;
  P.fromX = P.tx; P.fromY = P.ty; P.tx = x; P.ty = y; P.moving = true; P.prog = 0; P.speed = 0.16; P.dist = 1; P.knocked = true;
  mc('hurt', { vol: 0.9 });
}
function updateFall(dt) {
  const P = G.P;
  if (!P.voidFall || P.dead) return;
  P.voidFall.t += dt;
  if (P.voidFall.t >= 1.1) {
    P.health = 0; P.dead = true; P.deathT = 0;
    P.deathMsg = `${P.name} fell out of the world`;
    P.deathDrop = P.voidFall.safe;
  }
}

// ---------------------------------------------------------------- the dragon egg
// Hit or used, it teleports to a random open floor cell within 7 cells, with portal particles. Landing on a torch
// knocks it off as an item (the top-down torch trick). After its third hop, one hint.
export function eggAt(x, y) {
  const b = W().block(x, y);
  if (b && b.id === 'dragon_egg') return 'block';
  const N = W().end;
  if (G.end.egg === 'pillar' && N && x === N.fountain.pillar[0] && y === N.fountain.pillar[1]) return 'pillar';
  return null;
}
export function pokeEgg(x, y) {
  const w = W(), P = G.P, where = eggAt(x, y);
  if (!where) return false;
  const area = w.areaOf(x, y), cands = [];
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    const X = x + dx, Y = y + dy;
    if ((!dx && !dy) || Math.hypot(dx, dy) > 7.5 || !w.inside(X, Y) || w.areaOf(X, Y) !== area) continue;
    if (X === P.tx && Y === P.ty) continue;
    const b = w.block(X, Y);
    const torch = b && b.id === 'torch';
    if (b && !torch) continue;
    if (!w.isFloor(X, Y) || w.noPlace(X, Y) || w.isLava(X, Y) || E.mobAt(X, Y) || (G.npcAt && G.npcAt(X, Y))) continue;
    cands.push([X, Y, torch]);
  }
  if (!cands.length) return true;
  const [nx, ny, torch] = cands[Math.floor((G.eggRoll ? G.eggRoll(cands.length) : Math.random() * cands.length))];
  if (where === 'pillar') G.end.egg = null; else w.removeBlock(x, y);        // a bridge under it stays
  const fx = where === 'pillar' ? w.end.fountain.egg[0] : x * TILE + 8, fy = where === 'pillar' ? w.end.fountain.egg[1] : y * TILE + 4;
  E.portalPuff(fx, fy, 18, 12);
  mc('enderman.portal', { vol: 0.6, pitch: 1.2 });
  G.end.eggHops = (G.end.eggHops || 0) + 1;
  if (torch) {
    // it comes down on the torch and pops off as an item
    const it = E.dropItem('dragon_egg', 1, nx * TILE, ny * TILE, {}, { delay: 0.3 });
    if (it) { it.vz = 70; }
    mc('pop', { vol: 0.5, pitch: 0.8 });
  } else w.setBlock(nx, ny, { id: 'dragon_egg' });
  E.portalPuff(nx * TILE + 8, ny * TILE + 4, 18, 12);
  G.lastEgg = { x: nx, y: ny, torch };
  if (G.end.eggHops >= 3 && !G.end.eggHint && !torch) {
    G.end.eggHint = true;
    G.say('The DRAGON EGG keeps vanishing from under your hand... Perhaps something set on the ground could catch it.');
  }
  return true;
}

// ---------------------------------------------------------------- hooks (player.js and main.js)
// X in front of something of ours: an eye into a frame, the egg, an end crystal on the exit portal, water on an
// enderman. True when it was handled.
// The egg in reach: in the cell ahead, or on the fountain's pillar across the exit portal's basin (Steve can't stand
// in the portal beside it, so he reaches over it from the rim, up to three cells)
function eggAhead(P) {
  const d = DIRS[P.dir];
  for (let k = 1; k <= 3; k++) {
    const x = P.tx + d.x * k, y = P.ty + d.y * k;
    const where = eggAt(x, y);
    if (where) return k === 1 || where === 'pillar' ? { x, y } : null;
    if (!W().isEndPortal(x, y) && !(W().inEnd(x, y) && W().mat(x, y) === 'bedrock_floor')) return null;
  }
  return null;
}
export function useHook(P, f, held, b) {
  const egg = eggAhead(P);
  if (egg) return pokeEgg(egg.x, egg.y);
  if (b && b.id === 'end_portal_frame') {
    if (held && held.id === 'eye_of_ender') return useFrame(f.x, f.y, b);
    return true;                      // nothing else goes on a frame
  }
  if (held && held.id === 'water_bucket') {
    const m = E.mobAt(f.x, f.y);
    if (m && m.kind === 'enderman') { E.wetMob(m); return false; }      // then the water is poured as usual
  }
  return false;
}
// Z in front: the egg teleports. True when it was handled.
export function hitHook(P, f) {
  const egg = eggAhead(P);
  if (egg) { P.swingT = 0.001; return pokeEgg(egg.x, egg.y); }
  return false;
}

// ---------------------------------------------------------------- music and ambience
let wantMusic = null;
function updateMusic(state) {
  const P = G.P;
  if (state !== 'play' && state !== 'screen') return;
  if (W().inEnd(P.tx, P.ty)) {
    const want = (G.end.dragon.alive || DR.dying()) && onIsland() && !P.dead ? 'end_boss' : 'the_end';
    if (G.musicHold > 0) return;
    if (music.current !== want) music.play(want);
    wantMusic = want;
  }
}
export const musicWanted = () => wantMusic;
function updateCave(dt) {
  const P = G.P;
  if (!W().inStronghold(P.tx, P.ty)) return;
  caveT -= dt;
  if (caveT <= 0) { caveT = 30 + Math.random() * 60; mc('cave', { vol: 0.5 + Math.random() * 0.2 }); }
}

// ---------------------------------------------------------------- the frame
let lastIn = null;
export function update(dt, state) {
  const P = G.P;
  if (resume) { if (NET.guest) resume = null; else safe('resume', resumeSetPieces); }   // (a co-op guest's set pieces are the host's)
  safe('flying', () => updateFlying(dt));
  safe('fall', () => updateFall(dt));
  safe('wake', () => wakeFriends(dt));
  if (G.musicHold > 0) G.musicHold -= dt;
  const where = W().inEnd(P.tx, P.ty) ? 'end' : W().inStronghold(P.tx, P.ty) ? 'stronghold' : null;
  if (where !== lastIn) {
    if (where === 'stronghold') G.advance('eye_spy');
    if (where === 'end') G.advance('end_q');
    lastIn = where;
  }
  if (where === 'stronghold') { if (!NET.on) safe('spawner', () => spawner(dt)); safe('cave', () => updateCave(dt)); }
  // co-op host: the spawner works for whoever is near it; the dragon flies while anyone is in The End
  if (NET.host && NET.h) safe('spawner', () => spawner(dt, NET.h.near('stronghold', W().stronghold && W().stronghold.spawner, 16)));
  if (where === 'end' || DR.busy() || (NET.host && NET.h && NET.h.anyIn('end'))) safe('dragon', () => DR.update(dt, state));
  if (where === 'end' && !NET.guest && G.rules.mobs && Math.random() < dt * 0.9) safe('spawnEnd', () => E.trySpawnEnd());
  safe('portals', () => portals(state));
  safe('music', () => updateMusic(state));
}
// Standing in an End portal: the stronghold's takes him to The End at once (no wait, unlike the Nether's); the exit
// portal takes him home.
// (main.js calls portalStep from onStep when a step ends on a portal; this catches standing still on one)
export function portalStep(state) { const P = G.P; if (!W().isEndPortal(P.tx, P.ty)) return false; P.moving = false; portals(state); return !W().isEndPortal(P.tx, P.ty) || state !== 'play'; }
function portals(state) {
  const P = G.P;
  if (state !== 'play' || P.dead || P.moving || P.voidFall) return;
  // loaded standing in a portal: he has to step off it before it takes him
  if (G.endCool) { if (!W().isEndPortal(P.tx, P.ty)) G.endCool = false; return; }
  if (!W().isEndPortal(P.tx, P.ty)) return;
  if (W().inStronghold(P.tx, P.ty)) { if (G.toEnd) G.toEnd(); }
  else if (W().inEnd(P.tx, P.ty) && G.end.exitActive) { if (G.fromEnd) G.fromEnd(); }
}

// ---------------------------------------------------------------- drawing
// The void: Minecraft's End sky as a slow starfield, three layers at different depths so it drifts as Steve moves,
// over every void cell in view (the island's cliff faces stay over it in the top layer).
let tiled = null;
function tiles() {
  if (tiled) return tiled;
  const mk = (img) => { const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d'); for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) g.drawImage(img, x * 128, y * 128); return c; };
  tiled = { base: mk(A.mc.endVoid), far: mk(A.mc.endStarsFar), near: mk(A.mc.endStarsNear) };
  return tiled;
}
export function drawGround(ctx, cam, vw, vh) {
  const w = W(), N = w.end;
  const x0 = Math.floor(cam.x / TILE), x1 = Math.floor((cam.x + vw) / TILE), y0 = Math.floor(cam.y / TILE), y1 = Math.floor((cam.y + vh) / TILE);
  // the void
  if (N && (w.inEnd(G.P.tx, G.P.ty) || (cam.y + vh > N.y * TILE && cam.y < (N.y + N.h) * TILE))) {
    const path = new Path2D();
    let any = false;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!w.inEnd(x, y)) continue;
      const k = w.etiles.get(w.grid[y * w.W + x]);
      if (!k || (k[0] !== 'void' && k[0] !== 'face')) continue;
      path.rect(x * TILE - cam.x, y * TILE - cam.y, TILE, TILE); any = true;
    }
    if (any && A.mc.endVoid) {
      const T = tiles(), t = G.clock;
      ctx.save(); ctx.clip(path);
      const layer = (img, f, dx, dy, alpha = 1) => {
        const ox = ((-(cam.x * f + dx)) % 128 + 128) % 128 - 128, oy = ((-(cam.y * f + dy)) % 128 + 128) % 128 - 128;
        ctx.globalAlpha = alpha;
        for (let y = oy; y < vh; y += 256) for (let x = ox; x < vw; x += 256) ctx.drawImage(img, Math.round(x), Math.round(y));
      };
      layer(T.base, 0.15, t * 0.6, t * 0.3);
      layer(T.far, 0.3, t * 1.6, t * 0.9, 0.9);
      layer(T.near, 0.55, t * 3.2, t * 1.4, 0.75 + 0.25 * Math.sin(t * 1.3));
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }
  // End portals: the animated starfield, tiled across the cells so a portal of any shape is seamless
  const img = A.mc.endPortal;
  if (img) {
    const f = animFrame('end_portal');
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!w.inside(x, y)) continue;
      const b = w.blocks.get(y * w.W + x);
      if (!b || b.id !== 'end_portal') continue;
      ctx.drawImage(img, (x * 16) % 128, f * 128 + (y * 16) % 128, 16, 16, x * TILE - cam.x, y * TILE - cam.y, 16, 16);
      // a dark inner edge where the portal meets its frame
      const open = (X, Y) => w.isEndPortal(X, Y);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      if (!open(x, y - 1)) ctx.fillRect(x * TILE - cam.x, y * TILE - cam.y, 16, 2);
      if (!open(x - 1, y)) ctx.fillRect(x * TILE - cam.x, y * TILE - cam.y, 1, 16);
      if (!open(x + 1, y)) ctx.fillRect(x * TILE - cam.x + 15, y * TILE - cam.y, 1, 16);
    }
  }
  if (N && w.inEnd(G.P.tx, G.P.ty)) DR.drawGround(ctx, cam);
}
// the egg on the fountain's pillar (GBA pixels, after the top layer: the pillar's upper half is drawn there)
export function drawAir(ctx, cam) {
  const N = W().end;
  if (N && G.end.egg === 'pillar' && W().inEnd(G.P.tx, G.P.ty)) {
    const look = A.items.blocks.dragon_egg;
    if (look != null) {
      const [cw, chh] = A.items.cell, per = 32, [ex, ey] = N.fountain.egg;
      ctx.drawImage(A.mc.blocks, (look % per) * cw, Math.floor(look / per) * chh, cw, chh, Math.round(ex - 8 - cam.x), Math.round(ey - chh + 4 - cam.y), cw, chh);
    }
  }
  if (N && W().inEnd(G.P.tx, G.P.ty)) DR.drawAir(ctx, cam);
}
export function drawGlow(ctx, cam) { if (W().end && W().inEnd(G.P.tx, G.P.ty)) DR.drawGlow(ctx, cam); }
export function drawHUD(ctx) { if (W().end && W().inEnd(G.P.tx, G.P.ty)) DR.drawBossBar(ctx); }
export function resetTransient() { flying.length = 0; wakeQueue.length = 0; }
