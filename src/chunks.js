// Streaming the generated overworld (design 2.4, 2.7, 10.1, 10.3; stage 4a). Generated layouts only: Classic never
// loads this module.
//
// Every frame (`update`) the streamer
//   1. applies the chunks the generator has returned, at most APPLY_MS of main-thread time a frame (world.applyChunk:
//      the arrays, then the overrides that waited; the chunk is ready at once);
//   2. keeps, for each player, the wanted set: the data chunks within 2 (Chebyshev) of the player's chunk, the row 3
//      chunks ahead in the direction they face, and every chunk of a structure group any of those touch; the missing
//      ones are requested nearest first, at most MAX_IN_FLIGHT at a time (without a worker, one chunk a frame is
//      painted here);
//   3. with frame time left, draws one draw chunk just outside the view ahead of the player (the prefetch of 10.3),
//      so walking onto new ground never builds its canvases in the frame that first shows them.
// `ensure(x, y, r)` makes the (2r + 1)^2 chunks around a cell ready: true when they are, else a promise; requests go
// to the head of the queue and, if the worker has not answered within ENSURE_TIMEOUT, they are painted here.
import { PLANE } from './layout.js';
import { hash32, fnv1a } from './gen/hash.js';

const C = PLANE.CHUNK, CW = PLANE.CW, OCX = PLANE.OX / C, N = PLANE.OW / C;   // 32, 63, 13, 50
export const APPLY_MS = 2, MAX_IN_FLIGHT = 4, RADIUS = 2, AHEAD = 3, ENSURE_TIMEOUT = 1500;
// population and parking (2.11, 3.17; stage 5c)
export const PARK_FAR = 3, UNPARK_NEAR = 2, ITEM_LIFE = 300, HERD_RATE = 0.5, SNOWY_RATE = 0.3;
const FOREST_HERD = ['pig', 'chicken', 'sheep'];
export const HERDS = { PLAINS: ['cow', 'sheep', 'pig', 'chicken'], FOREST: FOREST_HERD, BIRCH_FOREST: FOREST_HERD, DARK_FOREST: FOREST_HERD,
  TAIGA: ['sheep', 'pig'], SNOWY_TAIGA: ['sheep'], SNOWY_PLAINS: ['sheep'], SAVANNA: ['cow', 'sheep'], JUNGLE: ['chicken', 'pig'] };
const SNOWY = new Set(['SNOWY_TAIGA', 'SNOWY_PLAINS']);
const HERD_SALT = fnv1a('herds');
// the plane cell an entity stands on (a dropped item by its pixel position)
export function entCell(e) { return e.type === 'item' || e.type === 'xp' ? [Math.floor(e.x / 16), Math.floor(e.y / 16)] : [e.tx, e.ty]; }
const DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const now = () => performance.now();

export class Streamer {
  constructor(world, gen) {
    this.w = world; this.gen = gen;
    this.urgent = [];                    // local keys asked for by ensure(), requested before anything else
    this.groupsOf = new Map();           // local chunk key -> the structure groups' chunk keys
    for (const gr of gen.plan.groups || []) {
      const keys = [];
      for (let cy = gr.cy0; cy <= gr.cy1; cy++) for (let cx = gr.cx0; cx <= gr.cx1; cx++) if (cx >= 0 && cy >= 0 && cx < N && cy < N) keys.push(cy * N + cx);
      for (const k of keys) { if (!this.groupsOf.has(k)) this.groupsOf.set(k, []); this.groupsOf.get(k).push(keys); }
    }
    this.ms = 0;                         // main-thread time spent here, in total (the perf test reads it per frame)
    this.stats = { applied: 0, requested: 0, synced: 0, prefetched: 0, maxApplyMs: 0, wantMax: 0 };
  }
  // overworld-local chunk key of a data chunk (local cx, cy), and the plane's chunk index
  ck(lx, ly) { return ly * CW + lx + OCX; }
  state(lx, ly) { return this.w.cstate[this.ck(lx, ly)]; }
  // the local chunk of a plane cell, or null outside the overworld
  localOf(x, y) {
    const lx = (x >> 5) - OCX, ly = y >> 5;
    return lx >= 0 && ly >= 0 && lx < N && ly < N ? [lx, ly] : null;
  }

  // ---- 1. applying results
  applyResults(budget) {
    const q = this.gen.results;
    const t0 = now();
    let n = 0;
    while (q.length && (n === 0 || now() - t0 < budget)) {
      const res = q.shift();
      const ta = now();
      if (this.w.applyChunk(res)) { this.stats.applied++; n++; }
      this.stats.maxApplyMs = Math.max(this.stats.maxApplyMs, now() - ta);
    }
    return n;
  }

  // ---- 2. what each player needs
  wanted(players) {
    const out = new Map();   // local key -> priority (lower first)
    const add = (lx, ly, p) => {
      if (lx < 0 || ly < 0 || lx >= N || ly >= N) return;
      const k = ly * N + lx, was = out.get(k);
      if (was === undefined || p < was) out.set(k, p);
    };
    for (const P of players) {
      const c = this.localOf(P.tx, P.ty);
      if (!c) continue;
      const [lx, ly] = c;
      for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++) add(lx + dx, ly + dy, Math.max(Math.abs(dx), Math.abs(dy)));
      const d = DIRV[P.dir] || [0, 0];
      if (d[0] || d[1]) for (let s = -RADIUS; s <= RADIUS; s++) add(lx + d[0] * AHEAD + d[1] * s, ly + d[1] * AHEAD + d[0] * s, AHEAD);
    }
    // whole structure groups (2.4)
    for (const [k, p] of [...out]) {
      const gs = this.groupsOf.get(k);
      if (gs) for (const keys of gs) for (const g of keys) { const was = out.get(g); if (was === undefined || p < was) out.set(g, p); }
    }
    return out;
  }
  requestMissing(players) {
    const gen = this.gen, cs = this.w.cstate;
    // a worker that died: what it had in flight is asked for again (here, one a frame)
    if (gen.lost) { gen.lost = false; for (let k = 0; k < cs.length; k++) if (cs[k] === 1) cs[k] = 0; }
    const want = this.wanted(players);
    this.stats.wantMax = Math.max(this.stats.wantMax, want.size);
    const list = [];
    for (const k of this.urgent) if (cs[this.ck(k % N, (k / N) | 0)] === 0) list.push([k, -1]);
    for (const [k, p] of want) if (cs[this.ck(k % N, (k / N) | 0)] === 0) list.push([k, p]);
    if (!list.length) { this.urgent = this.urgent.filter((k) => cs[this.ck(k % N, (k / N) | 0)] !== 2); return; }
    list.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    if (gen.worker) {
      for (const [k] of list) {
        if (gen.inFlight >= MAX_IN_FLIGHT) break;
        const lx = k % N, ly = (k / N) | 0;
        if (cs[this.ck(lx, ly)] !== 0) continue;
        if (gen.request(lx, ly)) { cs[this.ck(lx, ly)] = 1; this.stats.requested++; }
      }
    } else {
      // no worker: one chunk a frame, painted here (10.1's fallback)
      const [k] = list[0], lx = k % N, ly = (k / N) | 0;
      gen.results.push(gen.sync(lx, ly)); this.stats.synced++;
      cs[this.ck(lx, ly)] = 1;
    }
  }

  // ---- 3. the prefetch: one draw chunk around the view, ahead first
  prefetch(cam, vw, vh, P) {
    const S = 16 * 16, w = this.w;
    const x0 = Math.floor(cam.x / S) - 1, x1 = Math.floor((cam.x + vw) / S) + 1, y0 = Math.floor(cam.y / S) - 1, y1 = Math.floor((cam.y + vh) / S) + 1;
    const d = DIRV[P.dir] || [0, 0];
    let best = null, bs = Infinity;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      if (cx < 0 || cy < 0 || cx >= w.cw || cy >= w.ch) continue;
      if (w.chunks.has(cy * w.cw + cx)) continue;
      if (w.cstate[(cy >> 1) * CW + (cx >> 1)] !== 2) continue;
      const s = -((cx - mx) * d[0] + (cy - my) * d[1]) * 4 + Math.abs(cx - mx) + Math.abs(cy - my);
      if (s < bs) { bs = s; best = [cx, cy]; }
    }
    if (best) { w.chunk(best[0], best[1]); this.stats.prefetched++; return true; }
    return false;
  }

  update(players, cam, vw, vh) {
    const t0 = now(), b0 = this.w.genStats.buildMs;
    this.applyResults(APPLY_MS);
    this.requestMissing(players);
    if (now() - t0 < APPLY_MS && cam && players[0]) this.prefetch(cam, vw, vh, players[0]);
    const dt = now() - t0;
    this.ms += dt - (this.w.genStats.buildMs - b0);   // (canvas drawing is counted by the world's genStats)
    return dt;
  }

  // ---- population (2.11, 3.17): a data chunk's herds the first time it is applied while population is on (main.js
  // turns it on once a save or a new world is in; a co-op guest never does). The herd is a pure function of the seed,
  // the chunk and its cells: about one herd per two chunks, 2 to 4 of one kind from the biome's list on open grass
  // (snow in the snowy biomes, where herds are rarer), none in villages (their pens are 7b's), deserts, swamps, rock or
  // water. `spawn(kind, x, y)` makes the mob. Returns how many were made.
  herdsOf(ck, isFree) {
    const w = this.w, lx = (ck % CW) - OCX, ly = (ck / CW) | 0;
    if (lx < 0 || lx >= N || ly >= N) return [];
    const seed = w.seed | 0, r = (k) => hash32(seed, HERD_SALT, ck, k) / 4294967296;
    if (r(0) >= HERD_RATE) return [];
    const x0 = (ck % CW) * C, y0 = ly * C, L = w.layout;
    let cx = -1, cy = -1, key = null;
    for (let t = 0; t < 6 && !key; t++) {
      const x = x0 + 2 + Math.floor(r(1 + t * 2) * (C - 4)), y = y0 + 2 + Math.floor(r(2 + t * 2) * (C - 4));
      const m = w.biomeAt(x, y), k = m && typeof m.id === 'string' ? m.id.replace(/^GEN_/, '') : null;
      if (k && HERDS[k]) { cx = x; cy = y; key = k; }
    }
    if (!key || (SNOWY.has(key) && r(20) >= SNOWY_RATE)) return [];
    for (const v of (this.gen.plan && this.gen.plan.villages) || []) {
      const vx = cx - L.ox, vy = cy - L.oy;
      if (vx >= v.x0 - 4 && vy >= v.y0 - 4 && vx < v.x0 + v.w + 4 && vy < v.y0 + v.h + 4) return [];
    }
    const list = HERDS[key], kind = list[Math.floor(r(21) * list.length)], n = 2 + Math.floor(r(22) * 3), want = SNOWY.has(key) ? 'snow' : 'grass';
    const out = [], used = new Set();
    for (let t = 0; t < 40 && out.length < n; t++) {
      const x = cx + Math.floor(r(30 + t * 2) * 7) - 3, y = cy + Math.floor(r(31 + t * 2) * 7) - 3, i = y * w.W + x;
      if (x < x0 || y < y0 || x >= x0 + C || y >= y0 + C || used.has(i)) continue;
      if (w.zone[i] !== 0 || !w.isFloor(x, y) || w.tallGrass(x, y) || w.block(x, y) || w.warpIdx.has(i) || w.prot[i]) continue;
      const soil = w.soilAt(x, y);
      if (soil !== want && soil !== 'grass') continue;
      if (isFree && !isFree(x, y)) continue;
      used.add(i); out.push([kind, x, y]);
    }
    return out;
  }
  populate(ck, spawn, isFree) {
    const w = this.w, bit = 1 << (ck & 7);
    if (!w.pop || (w.pop[ck >> 3] & bit) || w.cstate[ck] !== 2) return 0;
    w.pop[ck >> 3] |= bit;
    const list = this.herdsOf(ck, isFree);
    for (const [k, x, y] of list) spawn(k, x, y);
    this.stats.herds = (this.stats.herds || 0) + (list.length ? 1 : 0); this.stats.animals = (this.stats.animals || 0) + list.length;
    return list.length;
  }
  // every ready overworld chunk not yet populated (when population is turned on)
  populateAll(spawn, isFree) {
    let n = 0;
    for (let ck = 0; ck < this.w.cstate.length; ck++) if (ck % CW >= OCX && this.w.cstate[ck] === 2) n += this.populate(ck, spawn, isFree);
    return n;
  }

  // ---- parking (2.11): once a second (single-player and a co-op host). Every parkable entity (`canPark`: persistent
  // mobs, dropped items, boats nobody rides) whose data chunk is more than PARK_FAR chunks (Chebyshev) from every
  // player goes into world.parked by chunk; a parked chunk within UNPARK_NEAR of a player comes back once its chunk is
  // ready. Time keeps running for parked items: one parked past ITEM_LIFE seconds of play is gone when it would return.
  // `now` is the play clock in seconds (G.playTime). Returns the entity list to keep (the same array when nothing moved).
  park(ents, players, now, canPark, onReturn) {
    const w = this.w, pc = [];
    for (const p of players) if (p && Number.isInteger(p.tx) && Number.isInteger(p.ty)) pc.push(p.tx >> 5, p.ty >> 5);
    if (!pc.length) return ents;
    const far = (cx, cy, r) => { for (let k = 0; k < pc.length; k += 2) if (Math.max(Math.abs(pc[k] - cx), Math.abs(pc[k + 1] - cy)) <= r) return false; return true; };
    let moved = null;
    for (const e of ents) {
      if (e.dead || !canPark(e)) continue;
      const [x, y] = entCell(e);
      if (!w.inside(x, y) || !far(x >> 5, y >> 5, PARK_FAR)) continue;
      const ck = (y >> 5) * CW + (x >> 5);
      e.parkT = now;
      if (!w.parked.has(ck)) w.parked.set(ck, []);
      w.parked.get(ck).push(e);
      (moved || (moved = new Set())).add(e);
    }
    let out = moved ? ents.filter((e) => !moved.has(e)) : ents;
    this.stats.parked = (this.stats.parked || 0) + (moved ? moved.size : 0);
    // coming back: the parked chunks near a player (at most 25 lookups a player)
    if (w.parked.size) {
      for (let k = 0; k < pc.length; k += 2) {
        for (let dy = -UNPARK_NEAR; dy <= UNPARK_NEAR; dy++) for (let dx = -UNPARK_NEAR; dx <= UNPARK_NEAR; dx++) {
          const cx = pc[k] + dx, cy = pc[k + 1] + dy;
          if (cx < 0 || cy < 0 || cx >= CW || cy >= PLANE.CHH) continue;
          const ck = cy * CW + cx, list = w.parked.get(ck);
          if (!list || w.cstate[ck] !== 2) continue;
          w.parked.delete(ck);
          if (out === ents) out = ents.slice();
          for (const e of list) {
            if (e.type === 'item' || e.type === 'xp') { e.age = (e.age || 0) + Math.max(0, now - e.parkT); if (e.age > ITEM_LIFE) { this.stats.expired = (this.stats.expired || 0) + 1; continue; } }
            delete e.parkT;
            out.push(e);
            this.stats.unparked = (this.stats.unparked || 0) + 1;
            if (onReturn) onReturn(e);
          }
        }
      }
    }
    return out;
  }
  parkedCount() { let n = 0; for (const l of this.w.parked.values()) n += l.length; return n; }

  // ---- ensure (2.13): the chunks around a cell, now or soon
  // `sync`: the missing chunks are painted here at once (results already back are applied first); true.
  ensure(x, y, r = 1, sync = false) {
    const c = this.localOf(x, y);
    if (!c) return true;
    const keys = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const lx = c[0] + dx, ly = c[1] + dy;
      if (lx >= 0 && ly >= 0 && lx < N && ly < N && this.state(lx, ly) !== 2) keys.push(ly * N + lx);
    }
    if (!keys.length) return true;
    if (sync) {
      this.applyResults(50);
      for (const k of keys) { const lx = k % N, ly = (k / N) | 0; if (this.state(lx, ly) !== 2) { this.w.applyChunk(this.gen.sync(lx, ly)); this.stats.synced++; } }
      return true;
    }
    for (const k of keys) if (!this.urgent.includes(k)) this.urgent.unshift(k);
    const t0 = now();
    return new Promise((resolve) => {
      const tick = () => {
        this.applyResults(50);
        this.requestMissing([]);
        const left = keys.filter((k) => this.state(k % N, (k / N) | 0) !== 2);
        if (this.onProgress) this.onProgress(1 - left.length / keys.length);
        if (!left.length) { resolve(true); return; }
        if (now() - t0 > ENSURE_TIMEOUT) {
          // the worker is late: the rest is painted here, at once
          for (const k of left) { const lx = k % N, ly = (k / N) | 0; this.w.applyChunk(this.gen.sync(lx, ly)); this.stats.synced++; }
          resolve(true); return;
        }
        setTimeout(tick, 4);
      };
      tick();
    });
  }
}
