// Villagers and iron golems in generated worlds (the world update, design 5.3, 5.5, 5.8, 5.9, 5.10; stage 7b).
// Classic never loads this module: main.js imports it only for a generated world and sets G.vil, and every hook in
// entities.js and main.js is behind `G.vil`.
//
//   install(W)          the villager and golem sheets (tools/build_villagers.py, assets/mc/villagers/) and mob defs; per
//                       village a record for the plan's villages (W.meta.genVillages)
//   populate()          a village whose chunks are all made gets its villagers (one per bed), its golem (8 or more
//                       houses) and its pen animals, once (design 2.11's structure-group population)
//   tick(dt)            once a second (single-player and the co-op host): a village with a player near (or a player in
//                       one of its houses) is active, its villagers and golem in G.ents, each first placed where its
//                       schedule says it is at this time (placeBySchedule); a village nobody is near is parked here
//                       (its mobs leave G.ents) and comes back placed by the clock. At each dawn (and when a village
//                       comes back) empty beds refill after 2 days, a golem after 3, and unemployed villagers claim
//                       free job sites.
//   update(m, dt)       a villager's or golem's frame (entities.js updateMob dispatches here)
//   zombie(m, dt, P)    a zombie or husk near an outdoor villager goes for the nearer of Steve and the villager
//   onHurt(m, ...)      players, arrows and explosions never hurt villagers; a golem hit by a player is angry 30 s
//   talk / useInFront   Z or X on a villager (the trade screen is stage 7c's: G.openTrade), X on a village bell
//   serialize/restore   the villages' records in the save (`vil`): villagers, golems, empty beds, farm rows
//
// Deviation from 2.11: villagers and golems are parked per village here, not by chunks.js Streamer.park. Their
// schedule takes them between the village and its interiors, which lie in a different part of the plane, so a
// chunk-keyed park would strand a villager asleep in its room when morning comes. The effect is 2.11's: far villages
// cost nothing, and a village coming back is placed by the clock (a villager unparked at night is in its bed).
import { A } from './assets.js';
import { G, DIRS, DIR_LIST, dirTo } from './game.js';
import { mc } from './audio.js';
import { NET } from './net/flag.js';
import * as E from './entities.js';
import { villageRaster, K as VK, PROFS as JOB_PROFS, JOB_BLOCK } from './gen/village.js';
import { hash32 } from './gen/hash.js';
import { restock as restockTrades } from './trades.js';

const VTYPE = { plains: 'plains', desert: 'desert', savanna: 'savanna', taiga: 'taiga', snowy: 'snow' };
const DEF_VILLAGER = { name: 'Villager', hp: 20, dmg: 0, xp: 0, step: 0.75, drops: [] };
const DEF_GOLEM = { name: 'Iron Golem', hp: 100, dmg: 14, xp: 0, step: 0.8, drops: [['iron_ingot', 3, 5, 1.0], ['poppy', 0, 2, 1.0]] };
const NEAR_ON = 40, NEAR_OFF = 56;     // cells beyond a village's bounds: active within the first, parked beyond the second
const PATH_NODES = 2000, PATH_BOX = 40; // 5.5: the path search's node limit and box
const ZOMBIE_SEE = 12, FLEE_SEE = 8, BELL_RANGE = 32;
const PROF_OF_BLOCK = Object.fromEntries(JOB_BLOCK.map((b, k) => [b, JOB_PROFS[k]]));

let S = null;   // this world's villages

const absNow = () => G.day * 24000 + G.time;
const W = () => G.world;
const near = (m) => { const P = G.P; if (!P) return 0; const d = Math.hypot(m.fx - P.fx, m.fy - P.fy); return Math.max(0, 1 - d / 16); };
const say = (m, key, vol = 0.6) => { const v = vol * near(m); if (v > 0.02 && A.sfx[key]) mc(key, { vol: v, pitch: 0.9 + Math.random() * 0.2 }); };
export const owns = (e) => !!e && e.type === 'mob' && (e.kind === 'villager' || e.kind === 'iron_golem');

// ---------------------------------------------------------------- the schedule (5.5)
export function planAt(t) {
  if (t >= 12000 || t < 300) return 'sleep';       // 12000..23000 asleep, 23000..24000 stays in, up at 300
  if (t < 2000) return 'wake';
  if (t < 9000) return 'work';
  if (t < 11000) return 'gather';
  return 'home';
}

// ---------------------------------------------------------------- install
export async function install(Wd) {
  S = { recs: new Map(), geo: new Map(), roomOf: new Map(), data: null, imgs: {}, golemImg: null, acc: 0, lastDay: null, entsRef: null };
  const vs = (Wd.meta && Wd.meta.genVillages) || [];
  const ox = Wd.layout.ox, oy = Wd.layout.oy;
  const TV = A.terrain && A.terrain.villages;
  const rooms = new Map(((Wd.meta && Wd.meta.genHouses) || []).map((r) => [r.id, r]));
  for (const v of vs) {
    S.recs.set(v.id, { v, pop: false, list: [], golem: null, golemDead: null, vacant: {}, active: false, next: 0 });
    for (const h of v.houses) {
      const r = rooms.get(`GEN_HOUSE_${v.id}_${h.id}`), it = TV && TV.interiors[h.room];
      const g = { v, h, door: [ox + h.door[0], oy + h.door[1] + 1], room: null, inside: null, beds: [], jobIn: null, jobOut: h.job ? [ox + h.job[0], oy + h.job[1]] : null };
      if (r && it) {
        g.room = { x: r.x, y: r.y, w: r.w, h: r.h };
        g.inside = [r.x + it.mat[0], r.y + it.mat[1] - 1];
        for (let k = 0; k < Math.min(h.beds || 1, it.spots.beds.length); k++) g.beds.push([r.x + it.spots.beds[k][0], r.y + it.spots.beds[k][1]]);
        if (h.jobIn && h.prof >= 0) g.jobIn = [r.x + it.spots.job[0], r.y + it.spots.job[1]];
        S.roomOf.set(r.id, g);
      }
      S.geo.set(v.id * 64 + h.id, g);
    }
  }
  if (!A.items.mobs.villager) A.items.mobs.villager = DEF_VILLAGER;
  if (!A.items.mobs.iron_golem) A.items.mobs.iron_golem = DEF_GOLEM;
  // the sheets: villagers.json and only the villager types this world's villages use, and the golem
  try {
    const base = 'assets/mc/villagers/';
    S.data = await (await fetch(base + 'villagers.json')).json();
    const types = [...new Set(vs.map((v) => VTYPE[v.style] || 'plains'))];
    const load = (f) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = base + f; });
    const imgs = await Promise.all(types.map((t) => load(S.data.villager.files[t])));
    types.forEach((t, k) => { if (imgs[k]) S.imgs[t] = imgs[k]; });
    S.golemImg = await load(S.data.golem.file);
  } catch (e) { (G.errors = G.errors || []).push('villagers: ' + String(e)); }
  return api;
}

// A villager's look ('<type>_<profession>') or a golem's crack row ('0'..'3') as a one-row sheet in A.mob and
// A.items.mobSheets (entities.js draws one-row sheets), made the first time it is drawn.
export function ensureLook(m) {
  const key = m.kind + '_' + m.look;
  if (A.mob[key]) return true;
  if (!S || !S.data) return false;
  let img, row, L;
  if (m.kind === 'villager') {
    const [t, p] = String(m.look).split('_');
    img = S.imgs[t]; L = S.data.villager; row = L.rows.indexOf(p);
    if (!img && S.data.villager.files[t] && !S.imgs['_' + t]) {   // a type this world did not preload (a co-op replica): fetch it once
      S.imgs['_' + t] = 1;
      const im = new Image(); im.onload = () => { S.imgs[t] = im; }; im.src = 'assets/mc/villagers/' + S.data.villager.files[t];
    }
  } else if (m.kind === 'iron_golem') { img = S.golemImg; L = S.data.golem; row = Number(m.look) | 0; }
  if (!img || !L || row < 0) return false;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = L.h;
  c.getContext('2d').drawImage(img, 0, row * L.h, img.width, L.h, 0, 0, img.width, L.h);
  const poses = JSON.parse(JSON.stringify(L.poses));
  if (poses.sleep) { const f = poses.sleep.down; poses.sleep = { down: f, up: f, left: f, right: f }; }
  A.mob[key] = c;
  A.items.mobSheets[key] = { w: L.w, h: L.h, origin: L.origin, poses };
  return true;
}

// ---------------------------------------------------------------- cells
function walkable(x, y) {
  const w = W();
  return w.inside(x, y) && w.ready(x, y) && !w.solid(x, y) && !w.isWater(x, y) && !w.jumpDir(x, y) && !w.isPortal(x, y) && !w.warpAt(x, y) && !(w.pcDoor && w.pcDoor(x, y));
}
const inRect = (x, y, r) => !!r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
function boundsOf(v) { const w = W(); return { x: w.layout.ox + v.x0, y: w.layout.oy + v.y0, w: v.w, h: v.h }; }
// the nearest free cell to (x, y) within r cells, in the same place (a room or outdoors), or null
function freeNear(x, y, r = 4, self = null, test = null) {
  const w = W(), key = w.regionKey(x, y);
  for (let d = 0; d <= r; d++) for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
    const a = x + dx, b = y + dy;
    if (!walkable(a, b) || w.regionKey(a, b) !== key || !E.cellFree(a, b, self)) continue;
    if (test && !test(a, b)) continue;
    return [a, b];
  }
  return null;
}
function setCell(m, x, y) {
  m.tx = m.fx = m.fromX = x; m.ty = m.fy = m.fromY = y;
  m.moving = false; m.prog = 0; m.path = null; m.stuck = 0;
}
function putNear(m, x, y, r = 6) { const c = freeNear(x, y, r, m); if (c) { setCell(m, c[0], c[1]); return true; } return false; }

// ---------------------------------------------------------------- a villager's places
const geoOf = (m) => S && S.geo.get(m.home.v * 64 + m.home.h);
const bedOf = (m) => { const g = geoOf(m); return g && g.beds[m.home.bed] ? g.beds[m.home.bed] : g && g.beds[0]; };
// the cell beside its job site where it stands to work (the job site's own cell is a block)
function standOf(m) {
  if (!m.job) return null;
  if (m.stand && m.stand[2] === m.job[0] && m.stand[3] === m.job[1]) return m.stand;
  const [jx, jy] = m.job;
  for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) if (walkable(jx + dx, jy + dy)) { m.stand = [jx + dx, jy + dy, jx, jy]; return m.stand; }
  return null;
}
const inHome = (m) => { const g = geoOf(m); return !!g && inRect(m.tx, m.ty, g.room); };
const jobInside = (m) => { const g = geoOf(m); return !!m.job && !!g && inRect(m.job[0], m.job[1], g.room); };
function plazaCell(m, salt) {
  const v = S.recs.get(m.home.v).v, w = W(), [px, py, pw, ph] = v.plaza;
  for (let k = 0; k < 12; k++) {
    const r = hash32(m.vid, salt, k, G.day);
    const x = w.layout.ox + px + (r % pw), y = w.layout.oy + py + ((r >>> 8) % ph);
    if (walkable(x, y)) return [x, y];
  }
  return [w.layout.ox + px + 4, w.layout.oy + py + 4];
}

// Where its plan says it is at time t (5.5): in bed (sleep), at its job site (work; the unemployed near their door),
// on a plaza cell (gather), at its door outside (the walking windows; an indoor worker inside, by its job, at wake).
export function placeBySchedule(m, t = G.time) {
  if (m.kind === 'iron_golem') return placeGolem(m);
  const g = geoOf(m);
  if (!g) return;
  const plan = planAt(t);
  m.sleep = false; m.path = null; m.goal = null; m.flee = 0; m.alarm = 0;
  const bed = bedOf(m);
  if (plan === 'sleep' && bed) { lieDown(m, bed); return; }
  let at = null;
  if (plan === 'work' && m.job) at = standOf(m);
  else if (plan === 'work') at = g.door;
  else if (plan === 'gather') at = plazaCell(m, 1);
  else if (plan === 'wake' && jobInside(m)) at = standOf(m);
  else at = g.door;
  if (!at || !putNear(m, at[0], at[1])) putNear(m, g.door[0], g.door[1], 8);
  m.dir = 'down';
}
function lieDown(m, bed) {
  setCell(m, bed[0], bed[1]);
  m.sleep = true; m.dir = 'down';
}
function wakeUp(m) {
  m.sleep = false;
  const b = bedOf(m) || [m.tx, m.ty];
  putNear(m, b[0] + 1, b[1], 4);
}
function placeGolem(m) {
  const rec = S.recs.get(m.home.v);
  if (!rec) return;
  const v = rec.v, w = W(), [px, py] = v.plaza;
  const r = hash32(v.seed, 81, G.day, m.hp | 0);
  putNear(m, w.layout.ox + px + (r % 9), w.layout.oy + py + ((r >>> 8) % 9), 8);
}

// ---------------------------------------------------------------- path search (5.5): A* with a node limit, roads first
function heapPush(h, n) { h.push(n); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } }
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < h.length && h[l][0] < h[s][0]) s = l; if (r < h.length && h[r][0] < h[s][0]) s = r; if (s === i) break; [h[s], h[i]] = [h[i], h[s]]; i = s; } }
  return top;
}
// cells from the next step to the goal (or to a cell beside it when adj), or null. `box`: the area searched.
function findPath(sx, sy, gx, gy, adj, box, roadOf) {
  const bx0 = Math.max(box.x, Math.min(sx, gx) - PATH_BOX), by0 = Math.max(box.y, Math.min(sy, gy) - PATH_BOX);
  const bx1 = Math.min(box.x + box.w - 1, Math.max(sx, gx) + PATH_BOX), by1 = Math.min(box.y + box.h - 1, Math.max(sy, gy) + PATH_BOX);
  const BW = bx1 - bx0 + 1, BH = by1 - by0 + 1;
  if (BW <= 0 || BH <= 0) return null;
  const idx = (x, y) => (y - by0) * BW + (x - bx0);
  const g = new Map(), prev = new Map(), open = [];
  const s = idx(sx, sy);
  g.set(s, 0); heapPush(open, [1.5 * (Math.abs(gx - sx) + Math.abs(gy - sy)), s]);
  let n = 0, end = -1;
  while (open.length && n++ < PATH_NODES) {
    const [, c] = heapPop(open);
    const x = bx0 + (c % BW), y = by0 + ((c / BW) | 0);
    const man = Math.abs(gx - x) + Math.abs(gy - y);
    if (man === 0 || (adj && man === 1)) { end = c; break; }
    const gc = g.get(c);
    for (const dn of DIR_LIST) {
      const d = DIRS[dn], nx = x + d.x, ny = y + d.y;
      if (nx < bx0 || ny < by0 || nx > bx1 || ny > by1) continue;
      const k = idx(nx, ny);
      if (!walkable(nx, ny)) continue;
      const cost = gc + (roadOf && !roadOf(nx, ny) ? 2 : 1);
      if (g.has(k) && g.get(k) <= cost) continue;
      g.set(k, cost); prev.set(k, c);
      heapPush(open, [cost + 1.5 * (Math.abs(gx - nx) + Math.abs(gy - ny)), k]);   // (weighted: roads cost 1, the rest 2)
    }
  }
  if (end < 0) return null;
  const out = [];
  for (let c = end; c !== s; c = prev.get(c)) { if (c === undefined) return null; out.push([bx0 + (c % BW), by0 + ((c / BW) | 0)]); }
  return out.reverse();
}
function roadTest(v) {
  const r = villageRaster(v), ox = W().layout.ox + r.x0, oy = W().layout.oy + r.y0;
  return (x, y) => { const lx = x - ox, ly = y - oy; return lx >= 0 && ly >= 0 && lx < r.S && ly < r.S && r.kind[ly * r.S + lx] === VK.PATH; };
}
// One step along a path to (gx, gy), re-planned at most once a second. True once there (or beside it when adj).
function goTo(m, gx, gy, { adj = false, speed = 1, dt = 0 } = {}) {
  const man = Math.abs(gx - m.tx) + Math.abs(gy - m.ty);
  if (man === 0 || (adj && man === 1)) { m.path = null; m.stuck = 0; return true; }
  const key = gx * 65536 + gy;
  if (!m.path || m.goal !== key || (m.repath <= 0 && m.stuck > 0)) {
    if (m.repath > 0 && m.goal === key && !m.path) { m.stuck = (m.stuck || 0) + dt; return false; }
    m.goal = key; m.repath = 1 + Math.random() * 0.3;
    const g = geoOf(m), rec = S.recs.get(m.home.v);
    const room = g && g.room && inRect(m.tx, m.ty, g.room) ? g.room : null;
    let box;
    if (room) box = room;
    else if (rec) { const b = boundsOf(rec.v), pad = m.flee > 0 || m.target ? 24 : 1; box = { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }; }
    else box = { x: m.tx - PATH_BOX, y: m.ty - PATH_BOX, w: 2 * PATH_BOX + 1, h: 2 * PATH_BOX + 1 };
    m.path = findPath(m.tx, m.ty, gx, gy, adj, box, room || !rec ? null : roadTest(rec.v));
    S.searches = (S.searches || 0) + 1;
    if (!m.path) S.pathFails = (S.pathFails || 0) + 1;
  }
  if (!m.path || !m.path.length) { m.path = null; m.stuck = (m.stuck || 0) + dt; return false; }
  const [nx, ny] = m.path[0];
  if (Math.abs(nx - m.tx) + Math.abs(ny - m.ty) !== 1) { m.path = null; return false; }
  if (E.mobKit.stepMob(m, dirTo(m.tx, m.ty, nx, ny), speed)) { m.path.shift(); m.stuck = 0; }
  else { m.stuck = (m.stuck || 0) + dt; m.dir = dirTo(m.tx, m.ty, nx, ny); if (m.stuck > 1.2) m.path = null; }
  return false;
}
// a random step now and then, kept inside a rectangle
function wander(m, dt, rect) {
  m.think = (m.think || 0) - dt;
  if (m.think > 0) return;
  m.think = 1.5 + Math.random() * 3;
  if (Math.random() < 0.4) { m.dir = DIR_LIST[(Math.random() * 4) | 0]; return; }
  const dn = DIR_LIST[(Math.random() * 4) | 0], d = DIRS[dn];
  if (rect && !inRect(m.tx + d.x, m.ty + d.y, rect)) return;
  if (walkable(m.tx + d.x, m.ty + d.y)) E.mobKit.stepMob(m, dn, 1);
}

// ---------------------------------------------------------------- a villager's frame
export function update(m, dt) {
  if (!S) return;
  if (m.kind === 'iron_golem') { updateGolem(m, dt); return; }
  const g = geoOf(m);
  if (!g) return;
  const now = absNow();
  // the clock jumped (a night slept through, a long time out of range): it is where its plan says, now
  if (m.vT == null || now - m.vT > 600 || now < m.vT - 1) { m.vT = now; placeBySchedule(m); return; }
  m.vT = now;
  // (this runs between steps only: the timers count the play time since the last call)
  const el = m.lastU != null && G.playTime >= m.lastU ? Math.min(2, G.playTime - m.lastU) : dt;
  m.lastU = G.playTime;
  if (m.shakeT > 0) m.shakeT -= el;
  if (m.hold > 0) { m.hold -= el; return; }   // standing still for whoever talks to it
  if (m.repath > 0) m.repath -= el;
  if (m.alarm > 0) m.alarm -= el;
  if (m.panic > 0) { m.flee = Math.max(m.flee || 0, m.panic); m.panic = 0; }
  if (m.flee > 0) m.flee -= el;
  dt = el;
  const w = W(), out = w.isOutdoor(m.tx, m.ty);
  // a zombie close by outdoors: it runs to its door (5.5, 5.9)
  if (out && (m.scanT = (m.scanT || 0) - dt) <= 0) {
    m.scanT = 0.5;
    for (const z of G.ents) if (z.type === 'mob' && (z.kind === 'zombie' || z.kind === 'husk') && !z.dying && Math.abs(z.tx - m.tx) + Math.abs(z.ty - m.ty) <= FLEE_SEE) { m.flee = 5; break; }
  }
  let plan = planAt(G.time);
  const hurry = m.flee > 0 || m.alarm > 0;
  if (hurry) plan = 'home';
  m.plan = plan;
  if (plan === 'sleep' && m.sleep) return;
  if (m.sleep) wakeUp(m);
  if (!m.sleep && Math.random() < dt / 14) say(m, 'villager.ambient', 0.5);
  const speed = hurry ? 1.7 : 1;
  if (plan === 'sleep' || plan === 'home') { goBed(m, dt, plan === 'sleep', speed); return; }
  if (plan === 'gather') {
    if (!out) { leaveHouse(m, dt); return; }
    const v = S.recs.get(m.home.v).v, [px, py, pw, ph] = v.plaza, rect = { x: w.layout.ox + px, y: w.layout.oy + py, w: pw, h: ph };
    if (inRect(m.tx, m.ty, rect)) { wander(m, dt, rect); return; }
    if (!m.gather || m.gather[2] !== G.day) { const c = plazaCell(m, 2); m.gather = [c[0], c[1], G.day]; }
    if (goTo(m, m.gather[0], m.gather[1], { dt }) || m.stuck > 6) { m.gather = null; m.stuck = 0; }
    return;
  }
  // wake and work: to its job site (an indoor worker stays in), or wander about its door
  const inside = jobInside(m);
  if (inside) {
    if (out) { goHomeDoor(m, dt, speed); return; }
    const st = standOf(m);
    if (st && goTo(m, st[0], st[1], { dt })) atWork(m, dt, plan === 'work');
    return;
  }
  if (!out) { leaveHouse(m, dt); return; }
  if (m.prof === 'farmer' && plan === 'work' && m.harvestDay !== G.day && farmerHarvest(m, dt)) return;
  const st = standOf(m);
  if (st) { if (goTo(m, st[0], st[1], { dt })) atWork(m, dt, plan === 'work'); return; }
  const b = boundsOf(S.recs.get(m.home.v).v);
  const home = { x: g.door[0] - 6, y: g.door[1] - 2, w: 13, h: 9 };
  if (Math.abs(m.tx - g.door[0]) > 8 || Math.abs(m.ty - g.door[1]) > 6) { if (goTo(m, g.door[0], g.door[1], { dt }) || m.stuck > 6) m.stuck = 0; return; }
  wander(m, dt, inRect(m.tx, m.ty, home) ? home : b);
}
function atWork(m, dt, working) {
  if (m.job) m.dir = dirTo(m.tx, m.ty, m.job[0], m.job[1]);
  if (working && Math.random() < dt / 9) say(m, 'villager.work_' + m.prof, 0.5);
  // the day it last stood at its job site in the work period, and (7c, 5.6) its trades restock once a day, at the start
  // of the work period at its job site: demand first (Minecraft's), then the uses back to 0
  if (working) {
    m.workDay = G.day;
    if (m.restockT !== G.day && G.time >= 2000 && G.tradeData) { restockTrades(m, G.tradeData); m.restockT = G.day; S.restocks = (S.restocks || 0) + 1; }
  }
}
// (7c) a villager reaching a level: Minecraft's celebrate sound and green sparkles (the happy_villager particle)
export function celebrate(m) {
  if (!m) return;
  say(m, 'villager.celebrate', 0.8);
  const img = G.tradeUI && G.tradeUI.TA.img.glint;
  if (!img) return;
  const x = (m.fx ?? m.tx) * 16 + 8, y = (m.fy ?? m.ty) * 16;
  for (let i = 0; i < 9; i++) E.spriteParticle(img, 1, x + (Math.random() - 0.5) * 20, y - 4 - Math.random() * 18, { life: 0.7 + Math.random() * 0.6, vz: 6 + Math.random() * 10, z: 4, fw: 8, scale: 1 });
  S.celebrations = (S.celebrations || 0) + 1;
}
// outdoors to its door, then in (teleported to the interior's mat), then to its bed; lies down when `lie`
function goBed(m, dt, lie, speed) {
  const g = geoOf(m);
  if (!inHome(m)) { goHomeDoor(m, dt, speed); return; }
  const bed = bedOf(m);
  if (!bed) return;
  if (goTo(m, bed[0], bed[1], { adj: true, dt })) { if (lie) lieDown(m, bed); else m.dir = 'left'; return; }
  if (m.stuck > 8 && lie) lieDown(m, bed);
  void g;
}
function goHomeDoor(m, dt, speed) {
  const g = geoOf(m);
  if (!W().isOutdoor(m.tx, m.ty)) { placeBySchedule(m); return; }   // somewhere it does not belong: by the clock
  if (goTo(m, g.door[0], g.door[1], { dt, speed }) || m.stuck > 10) {
    // in through the door: on the interior's mat side (mobs never take warps, so this is the villager's own move)
    if (g.inside && putNear(m, g.inside[0], g.inside[1], 3)) m.dir = 'up';   // (a bell's alarm or a fright keeps it in until it runs out)
    m.stuck = 0;
  }
}
function leaveHouse(m, dt) {
  const g = geoOf(m);
  if (!g.inside || !inHome(m)) { placeBySchedule(m); return; }
  if (goTo(m, g.inside[0], g.inside[1], { dt }) || m.stuck > 8) {
    if (putNear(m, g.door[0], g.door[1], 4)) m.dir = 'down';
    m.stuck = 0;
  }
}
// The farmer (5.5): once a work period it walks to its village's farm nearest its house and replants the ripe rows
// (up to 4), which writes the farm record's row times (2.12), never cells. True while it is busy with it.
function farmerHarvest(m, dt) {
  const rec = S.recs.get(m.home.v), v = rec.v, w = W(), g = geoOf(m);
  if (!v.farms.length || !w.farms) { m.harvestDay = G.day; return false; }
  let fi = 0, bd = 1e9;
  v.farms.forEach((f, k) => { const d = Math.abs(w.layout.ox + f.x - g.door[0]) + Math.abs(w.layout.oy + f.y - g.door[1]); if (d < bd) { bd = d; fi = k; } });
  const f = v.farms[fi], fx = w.layout.ox + f.x, fy = w.layout.oy + f.y;
  if (!goTo(m, fx, fy, { adj: true, dt }) && m.stuck < 6) return true;
  harvestFarm(v.id * 8 + fi, 4);
  say(m, 'dig.grass', 0.6);
  m.harvestDay = G.day; m.stuck = 0;
  return false;
}
export function harvestFarm(key, max = 4) {
  const w = W(), rows = w.farms && w.farms.get(key), now = absNow();
  if (!rows) return 0;
  let n = 0;
  for (let r = 0; r < rows.length && n < max; r++) if (now - rows[r] >= 7 * 3000) { rows[r] = now; n++; }
  if (n) { S.farmsTouched = S.farmsTouched || new Set(); S.farmsTouched.add(key); }
  if (n && NET.h && NET.h.farm) NET.h.farm(key, [...rows]);   // (co-op, stage 10: the guests' wheat follows)
  return n;
}
// co-op (stage 10): the farm rows farmers replanted, for a joining guest's snapshot, and a guest applying the host's
export function farmsOut() {
  const w = W(), out = {};
  if (S && S.farmsTouched && w.farms) for (const k of S.farmsTouched) { const r = w.farms.get(k); if (r) out[k] = [...r]; }
  return out;
}
export function farmsIn(d) {
  const w = W();
  if (!d || typeof d !== 'object' || !w.farms) return 0;
  let n = 0;
  for (const [k, rows] of Object.entries(d)) {
    const cur = w.farms.get(Number(k));
    if (cur && Array.isArray(rows) && rows.length === cur.length && rows.every(Number.isFinite)) { rows.forEach((t, i) => { cur[i] = t; }); n++; }
  }
  return n;
}

// ---------------------------------------------------------------- iron golems (5.8)
const HOSTILE_GOLEM = new Set(['zombie', 'husk', 'skeleton', 'stray', 'spider', 'creeper', 'silverfish']);
function updateGolem(m, dt) {
  const el = m.lastU != null && G.playTime >= m.lastU ? Math.min(2, G.playTime - m.lastU) : dt;
  m.lastU = G.playTime; dt = el;
  m.look = String(m.hp < m.maxHp * 0.25 ? 3 : m.hp < m.maxHp * 0.5 ? 2 : m.hp < m.maxHp * 0.75 ? 1 : 0);
  if (m.repath > 0) m.repath -= dt;
  if (m.angerT > 0) m.angerT -= dt; else m.angryAt = null;
  const w = W();
  if ((m.scanT = (m.scanT || 0) - dt) <= 0 || (m.target && (m.target.dead || m.target.dying))) {
    m.scanT = 0.5; m.target = null;
    const p = m.angryAt;
    if (p && !p.dead && Math.abs(p.tx - m.tx) + Math.abs(p.ty - m.ty) < 24 && w.regionKey(p.tx, p.ty) === w.regionKey(m.tx, m.ty)) m.target = p;
    else {
      let bd = 101;
      for (const e of G.ents) {
        if (e.type !== 'mob' || e.dying || e.fly || !HOSTILE_GOLEM.has(e.kind)) continue;
        const d = (e.tx - m.tx) ** 2 + (e.ty - m.ty) ** 2;
        if (d < bd && w.regionKey(e.tx, e.ty) === w.regionKey(m.tx, m.ty)) { bd = d; m.target = e; }
      }
    }
  }
  const t = m.target;
  if (t) {
    const man = Math.abs(t.tx - m.tx) + Math.abs(t.ty - m.ty);
    if (man === 1 || (man === 2 && t.tx !== m.tx && t.ty !== m.ty)) {   // (a golem's long arms reach a diagonal cell)
      m.dir = dirTo(m.tx, m.ty, t.tx, t.ty);
      if (m.cool <= 0) {
        m.cool = 1.5; m.attackT = 0.5;
        const dmg = 7 + Math.floor(Math.random() * 15);
        say(m, 'iron_golem.attack', 0.9);
        if (t === m.angryAt) {
          if (NET.on) NET.hurt(t, G.mobDmg ? G.mobDmg(dmg) : dmg, ['mob', 'Iron Golem'], m);
          else G.hurtPlayer(G.mobDmg ? G.mobDmg(dmg) : dmg, `${G.P.name} was slain by Iron Golem`, m);
        } else E.hurtMob(t, dmg, { x: m.tx, y: m.ty }, { knock: 2, golem: true });
        S.golemHits = (S.golemHits || 0) + 1;
      }
      return;
    }
    goTo(m, t.tx, t.ty, { adj: true, dt, speed: 1.35 });
    return;
  }
  const rec = S.recs.get(m.home.v);
  if (!rec) return;
  const b = boundsOf(rec.v);
  if (!inRect(m.tx, m.ty, b) && w.isOutdoor(m.tx, m.ty)) { goTo(m, b.x + (b.w >> 1), b.y + (b.h >> 1), { adj: true, dt }); return; }
  wander(m, dt, b);
}

// ---------------------------------------------------------------- zombies (5.9)
// A zombie (or husk) within 12 cells of an outdoor villager goes for the nearer of Steve and that villager. True when
// it went for the villager this frame (entities.js then skips its own chase).
export function zombie(m, dt, P, def) {
  if (!S) return false;
  const w = W();
  let v = null, bd = ZOMBIE_SEE + 0.01;
  for (const e of G.ents) {
    if (e.type !== 'mob' || e.kind !== 'villager' || e.dying || e.sleep || !w.isOutdoor(e.tx, e.ty)) continue;
    const d = Math.hypot(e.tx - m.tx, e.ty - m.ty);
    if (d < bd && w.regionKey(e.tx, e.ty) === w.regionKey(m.tx, m.ty)) { bd = d; v = e; }
  }
  if (!v) return false;
  const dp = P && !P.dead && !P.hidden && !P.spectator ? Math.hypot(P.tx - m.tx, P.ty - m.ty) : Infinity;
  if (dp <= bd) return false;
  const man = Math.abs(v.tx - m.tx) + Math.abs(v.ty - m.ty);
  if (man === 1) {
    m.dir = dirTo(m.tx, m.ty, v.tx, v.ty);
    if (m.cool <= 0) {
      m.cool = 1; m.attackT = 0.25;
      E.hurtMob(v, G.mobDmg ? G.mobDmg(def.dmg) : def.dmg, { x: m.tx, y: m.ty }, { zombie: true });
      S.zombieHits = (S.zombieHits || 0) + 1;
    }
    return true;
  }
  const s = E.mobKit.pathStep(m, v.tx, v.ty);
  if (s) E.mobKit.stepMob(m, s, 1);
  m.chasing = v.vid;
  return true;
}

// players never hurt villagers (5.10): Z is talk, arrows and explosions pass them; only a zombie's blow does. A golem
// hit by a player turns on that player for 30 s.
export function onHurt(m, dmg, from, opts) {
  if (m.kind === 'villager') return !!(opts && opts.zombie);
  if (m.kind === 'iron_golem' && opts && opts.player) {
    let p = G.P;
    if (NET.on && from) { let bd = 1e9; for (const q of NET.players()) { if (!q) continue; const d = Math.abs(q.tx - from.x) + Math.abs(q.ty - from.y); if (d < bd) { bd = d; p = q; } } }
    m.angryAt = p; m.angerT = 30; m.scanT = 0;
  }
  return true;
}

// ---------------------------------------------------------------- talking and the bell (5.10, 5.1)
const profOf = (m) => m.prof || (m.look ? String(m.look).split('_')[1] : 'none');
export function talk(m, P) {
  if (!m || m.kind !== 'villager') return false;
  if (!NET.guest && !m.sleep) { m.dir = dirTo(m.tx, m.ty, P.tx, P.ty); m.hold = 2; }
  const prof = profOf(m);
  if (prof === 'nitwit' || prof === 'none' || m.sleep) {
    m.shakeT = 0.6;
    if (A.sfx['villager.no']) mc('villager.no', { vol: 0.7 });
    if (G.toast) G.toast('Hrmm');
    return true;
  }
  if (G.openTrade && G.openTrade(m)) return true;   // stage 7c: the trade screen
  if (A.sfx['villager.yes']) mc('villager.yes', { vol: 0.7 });
  return true;
}
// X facing a villager talks; facing a village bell rings it: every villager within 32 cells runs home
export function useInFront(P) {
  const w = W(), d = DIRS[P.dir], x = P.tx + d.x, y = P.ty + d.y;
  const m = E.mobAt(x, y);
  if (m && m.kind === 'villager') return talk(m, P);
  const b = w.block(x, y);
  if (b && b.id === 'bell') { ringBell(x, y); P.swingT = 0.001; return true; }
  return false;
}
export function ringBell(x, y, slot = 0) {
  // (co-op: a ring by a guest, slot > 0, is heard here only near it)
  if (!slot || !NET.on || NET.near(x, y, 32)) bellSound();
  // co-op (stage 10): a guest's ring is the host's to act on; every ring is heard by the guests near it (but its ringer)
  if (NET.guest) { if (NET.g && NET.g.send) NET.g.send('bel', x, y); return 0; }
  if (NET.h && NET.h.fx) NET.h.fx(['bell', x, y, slot]);
  let n = 0;
  for (const e of G.ents) if (e.type === 'mob' && e.kind === 'villager' && !e.dying && Math.hypot(e.tx - x, e.ty - y) <= BELL_RANGE && !e.sleep) { e.alarm = 30; e.path = null; n++; }
  if (S) S.rang = (S.rang || 0) + 1;
  return n;
}

export function bellSound() {
  if (A.sfx['bell.use']) mc('bell.use', { vol: 0.9 });
  if (A.sfx['bell.resonate']) setTimeout(() => mc('bell.resonate', { vol: 0.35 }), 400);
}
// the hostile spawn rate around a player (5.9): doubled at night inside a village's bounds
export function spawnMul(p) {
  if (!S || !p) return 1;
  for (const rec of S.recs.values()) if (inRect(p.tx, p.ty, boundsOf(rec.v))) return 2;
  return 1;
}

// ---------------------------------------------------------------- population (2.11) and parking per village
function chunksReady(v) {
  const b = boundsOf(v), w = W();
  for (let y = b.y; y < b.y + b.h + 31; y += 32) for (let x = b.x; x < b.x + b.w + 31; x += 32) if (!w.ready(Math.min(x, b.x + b.w - 1), Math.min(y, b.y + b.h - 1))) return false;
  return true;
}
function newMob(kind, x, y) {
  const m = E.spawnMob(kind, x, y, { persistent: true });
  const i = G.ents.lastIndexOf(m);
  if (i >= 0) G.ents.splice(i, 1);   // villages keep their own; tick() brings them in
  return m;
}
function makeVillager(rec, h, bed, prof) {
  const v = rec.v, g = S.geo.get(v.id * 64 + h.id);
  const m = newMob('villager', g.door[0], g.door[1]);
  m.vid = v.id * 64 + rec.next++;
  m.vtype = VTYPE[v.style] || 'plains';
  m.home = { v: v.id, h: h.id, bed };
  m.lvl = 1; m.xp = 0; m.uses = {}; m.demand = {}; m.restockT = -1;
  setProf(m, prof, prof !== 'none' && prof !== 'nitwit' ? (g.jobIn || g.jobOut) : null);
  rec.list.push(m);
  return m;
}
function setProf(m, prof, job) {
  m.prof = prof; m.job = job ? [job[0], job[1]] : null; m.stand = null;
  m.look = m.vtype + '_' + prof;
}
function makeGolem(rec) {
  const v = rec.v, w = W();
  const m = newMob('iron_golem', w.layout.ox + v.plaza[0] + 4, w.layout.oy + v.plaza[1] + 4);
  m.home = { v: v.id }; m.look = '0';
  rec.golem = m;
  return m;
}
// one villager per bed (5.1): a house's first villager has the house's profession; the others are unemployed, about
// one in five of them a nitwit (about 1 in 12 overall)
function populateVillage(rec) {
  const v = rec.v;
  for (const h of v.houses) {
    const hasJob = h.prof >= 0 && (h.job || h.jobIn);
    for (let k = 0; k < (h.beds || 1); k++) {
      const prof = k === 0 && hasJob ? JOB_PROFS[h.prof] : hash32(v.seed, 70, h.id, k) % 5 === 0 ? 'nitwit' : 'none';
      makeVillager(rec, h, k, prof);
    }
  }
  if (v.houses.length >= 8) makeGolem(rec);
  // pen animals (5.1): 2 to 4 of one kind inside each pen, ordinary persistent animals (parked by chunks like herds)
  const w = W(), kinds = ['cow', 'pig', 'sheep', 'chicken'].filter((k) => A.items.mobs[k]);
  v.pens.forEach(([px, py, pw, ph], k) => {
    if (!kinds.length) return;
    const kind = kinds[hash32(v.seed, 90, k) % kinds.length], n = 2 + (hash32(v.seed, 91, k) % 3);
    let made = 0;
    for (let t = 0; t < 30 && made < n; t++) {
      const r = hash32(v.seed, 92, k, t), x = w.layout.ox + px + 1 + (r % (pw - 2)), y = w.layout.oy + py + 1 + ((r >>> 8) % (ph - 2));
      if (!walkable(x, y) || !E.cellFree(x, y)) continue;
      E.spawnMob(kind, x, y, { persistent: true }); made++;
    }
    S.penAnimals = (S.penAnimals || 0) + made;
  });
  rec.pop = true;
}
// every village whose chunks are all made and that has no population yet (host and single-player; world.popOn)
export function populate() {
  if (!S || NET.guest) return 0;
  const w = W();
  if (!w.popOn) return 0;
  let n = 0;
  for (const rec of S.recs.values()) if (!rec.pop && chunksReady(rec.v)) { populateVillage(rec); n++; }
  if (n) S.acc = 1;   // (in at the next frame when a player is near)
  return n;
}
function playersNow() { return NET.h ? NET.players().filter(Boolean) : G.P ? [G.P] : []; }
function wanted(rec, players, margin) {
  const b = boundsOf(rec.v), w = W();
  for (const p of players) {
    if (!Number.isInteger(p.tx)) continue;
    if (w.isOutdoor(p.tx, p.ty)) { if (p.tx >= b.x - margin && p.ty >= b.y - margin && p.tx < b.x + b.w + margin && p.ty < b.y + b.h + margin) return true; continue; }
    const r = w.roomAt(p.tx, p.ty), g = r && S.roomOf.get(r.id);
    if (g && g.v.id === rec.v.id) return true;
  }
  return false;
}
function activate(rec) {
  for (const m of rec.list) { m.vT = absNow(); placeBySchedule(m); G.ents.push(m); }
  if (rec.golem) { placeGolem(rec.golem); G.ents.push(rec.golem); }
  rec.active = true;
  S.activations = (S.activations || 0) + 1;
  dawn(rec);
}
function deactivate(rec) {
  const set = new Set(rec.list);
  if (rec.golem) set.add(rec.golem);
  G.ents = G.ents.filter((e) => !set.has(e));
  for (const m of set) { m.path = null; m.target = null; }
  rec.active = false;
}
// the dead leave their village's list; a bed's empty day is noted
function reap(rec) {
  if (rec.list.some((m) => m.dead)) {
    rec.list = rec.list.filter((m) => { if (!m.dead) return true; rec.vacant[m.home.h + ':' + m.home.bed] = G.day; S.deaths = (S.deaths || 0) + 1; return false; });
  }
  if (rec.golem && rec.golem.dead) { rec.golem = null; rec.golemDead = G.day; }
}
// at each dawn and when a village comes back (5.9): beds empty for 2 days refill with an unemployed villager at that
// house's door; a golem killed 3 days ago comes back while 8 or more villagers live there; the unemployed claim free
// job sites (generated ones whose villager is gone, and job-site blocks a player placed within the bounds)
function dawn(rec) {
  const v = rec.v;
  for (const h of v.houses) for (let k = 0; k < (h.beds || 1); k++) {
    const key = h.id + ':' + k;
    if (rec.list.some((m) => m.home.h === h.id && m.home.bed === k)) { delete rec.vacant[key]; continue; }
    if (rec.vacant[key] == null) { rec.vacant[key] = G.day; continue; }
    if (G.day - rec.vacant[key] >= 2 && rec.next < 64) {
      const m = makeVillager(rec, h, k, 'none');
      m.vT = absNow(); placeBySchedule(m);
      if (rec.active) G.ents.push(m);
      delete rec.vacant[key];
      S.refills = (S.refills || 0) + 1;
    }
  }
  if (v.houses.length >= 8 && !rec.golem && rec.golemDead != null && G.day - rec.golemDead >= 3 && rec.list.length >= 8) {
    const gm = makeGolem(rec); rec.golemDead = null;
    if (rec.active) { placeGolem(gm); G.ents.push(gm); }
  }
  const idle = rec.list.filter((m) => m.prof === 'none');
  if (idle.length) for (const site of freeSites(rec)) { const m = idle.shift(); if (!m) break; setProf(m, site.prof, site.at); S.claims = (S.claims || 0) + 1; }
}
function freeSites(rec) {
  const v = rec.v, w = W(), taken = new Set(rec.list.filter((m) => m.job).map((m) => m.job[0] * 65536 + m.job[1])), out = [];
  const see = (x, y) => { const b = w.block(x, y), p = b && PROF_OF_BLOCK[b.id]; if (p && !taken.has(x * 65536 + y)) { taken.add(x * 65536 + y); out.push({ prof: p, at: [x, y] }); } };
  for (const h of v.houses) { const g = S.geo.get(v.id * 64 + h.id); if (g.jobIn) see(g.jobIn[0], g.jobIn[1]); }
  const b = boundsOf(v);
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (w.ready(x, y) && w.block(x, y)) see(x, y);
  return out;
}
export function tick(dt) {
  if (!S || NET.guest) return;
  S.acc += Math.max(0, dt);
  if (S.acc < 1) return;
  S.acc = 0;
  // the entity list replaced (a load, a new world): what is active is checked again
  if (G.ents !== S.entsRef) {
    S.entsRef = G.ents;
    const here = new Set(G.ents);
    for (const rec of S.recs.values()) if (rec.active && ![...rec.list, rec.golem].some((m) => m && here.has(m))) rec.active = false;
  }
  const players = playersNow(), dawnNow = S.lastDay !== null && G.day !== S.lastDay;
  S.lastDay = G.day;
  for (const rec of S.recs.values()) {
    if (!rec.pop) continue;
    reap(rec);
    const want = rec.active ? wanted(rec, players, NEAR_OFF) : wanted(rec, players, NEAR_ON) && chunksReady(rec.v);
    if (want && !rec.active) activate(rec);
    else if (!want && rec.active) deactivate(rec);
    else if (rec.active && dawnNow) dawn(rec);
  }
  S.entsRef = G.ents;
}

// ---------------------------------------------------------------- the save (`vil`)
export function serialize() {
  if (!S) return null;
  const out = { v: 1, recs: {}, farms: {} };
  for (const rec of S.recs.values()) {
    if (!rec.pop) continue;
    reap(rec);
    out.recs[rec.v.id] = {
      n: rec.next, vac: rec.vacant, g: rec.golem ? Math.round(rec.golem.hp) : -1, gd: rec.golemDead,
      m: rec.list.map((m) => [m.vid, m.home.h, m.home.bed, m.prof, m.lvl, m.xp, Math.round(m.hp), m.job || 0, m.uses || 0, m.demand || 0, m.restockT ?? -1, m.harvestDay ?? -1]),
    };
  }
  const w = W();
  if (S.farmsTouched && w.farms) for (const k of S.farmsTouched) { const r = w.farms.get(k); if (r) out.farms[k] = [...r]; }
  return out;
}
export function restore(d) {
  if (!S) return;
  for (const rec of S.recs.values()) { rec.pop = false; rec.list = []; rec.golem = null; rec.golemDead = null; rec.vacant = {}; rec.active = false; rec.next = 0; }
  S.entsRef = null;
  if (!d || typeof d !== 'object' || !d.recs) return;
  const w = W();
  for (const [id, r] of Object.entries(d.recs)) {
    const rec = S.recs.get(Number(id));
    if (!rec || !r || typeof r !== 'object') continue;
    try {
      rec.pop = true; rec.next = Number.isInteger(r.n) ? r.n : 0; rec.vacant = r.vac && typeof r.vac === 'object' ? r.vac : {};
      rec.golemDead = Number.isInteger(r.gd) ? r.gd : null;
      for (const a of Array.isArray(r.m) ? r.m : []) {
        const h = rec.v.houses[a[1]];
        if (!Array.isArray(a) || !h || !JOB_PROFS.concat(['none', 'nitwit']).includes(a[3])) continue;
        const g = S.geo.get(rec.v.id * 64 + h.id), m = newMob('villager', g.door[0], g.door[1]);
        m.vid = a[0]; m.vtype = VTYPE[rec.v.style] || 'plains'; m.home = { v: rec.v.id, h: h.id, bed: a[2] | 0 };
        m.lvl = a[4] || 1; m.xp = a[5] || 0; if (Number.isFinite(a[6]) && a[6] > 0) m.hp = Math.min(m.maxHp, a[6]);
        setProf(m, a[3], Array.isArray(a[7]) ? a[7] : null);
        m.uses = a[8] && typeof a[8] === 'object' ? a[8] : {}; m.demand = a[9] && typeof a[9] === 'object' ? a[9] : {};
        m.restockT = Number.isFinite(a[10]) ? a[10] : -1; if (Number.isFinite(a[11]) && a[11] >= 0) m.harvestDay = a[11];
        rec.list.push(m);
        rec.next = Math.max(rec.next, (m.vid % 64) + 1);
      }
      if (Number.isFinite(r.g) && r.g > 0) { const gm = makeGolem(rec); gm.hp = Math.min(gm.maxHp, r.g); }
    } catch (e) { /* one bad village */ }
  }
  if (d.farms && w.farms) for (const [k, rows] of Object.entries(d.farms)) {
    const cur = w.farms.get(Number(k));
    if (cur && Array.isArray(rows) && rows.length === cur.length) { rows.forEach((t, i) => { if (Number.isFinite(t)) cur[i] = t; }); (S.farmsTouched = S.farmsTouched || new Set()).add(Number(k)); }
  }
}

// ---------------------------------------------------------------- hooks for the tests
export function stats() {
  if (!S) return null;
  let pop = 0, active = 0, villagers = 0, golems = 0;
  for (const rec of S.recs.values()) { if (rec.pop) pop++; if (rec.active) active++; villagers += rec.list.length; if (rec.golem) golems++; }
  return { villages: S.recs.size, pop, active, villagers, golems, searches: S.searches || 0, pathFails: S.pathFails || 0, activations: S.activations || 0, refills: S.refills || 0,
    claims: S.claims || 0, deaths: S.deaths || 0, golemHits: S.golemHits || 0, zombieHits: S.zombieHits || 0, rang: S.rang || 0, penAnimals: S.penAnimals || 0,
    restocks: S.restocks || 0, celebrations: S.celebrations || 0 };
}
export const recOf = (id) => (S ? S.recs.get(id) : null);
export const geo = (m) => geoOf(m);
export const state = () => S;

export const api = { install, ensureLook, owns, planAt, placeBySchedule, update, zombie, onHurt, talk, useInFront, ringBell, spawnMul,
  populate, tick, serialize, restore, stats, recOf, geo, state, harvestFarm, celebrate, farmsOut, farmsIn, bellSound };
