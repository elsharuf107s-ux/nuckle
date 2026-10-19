// FireRed's Kanto as an editable grid. Every cell points at an atlas tile (tools/build_world.py); the
// view is drawn into 256px chunk canvases from that atlas and a cell is redrawn whenever Steve (or a
// creeper) changes it. Placed Minecraft blocks live in `blocks` beside the base grid.
import { A } from './assets.js';
import { makeLayout, metaFor, PLANE } from './layout.js';

export const TILE = 16;
const CH = 16;                         // tiles per chunk side
const WATER = new Set([0x10, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x19, 0x1A, 0x1B]);
export const MB = { TALL_GRASS: 0x02, SAND: 0x21, JUMP: { 0x38: 'right', 0x39: 'left', 0x3A: 'up', 0x3B: 'down' } };
const T_LEFT = new Set([14, 20, 22, 28, 30, 36, 38]), T_RIGHT = new Set([15, 21, 23, 29, 31, 37, 39]);
const T_STD = new Set([...T_LEFT, ...T_RIGHT]);
export const PROT = { STRUCTURE: 1, DOOR: 2, OPENING: 3, MONUMENT: 4 };
const MB_COUNTER = 0x80;
// placed blocks Steve walks through (fire, soul fire and nether wart grow on the floor); pre-placed ones in an
// older world.json or save may lack the flag
const WALK_IDS = new Set(['fire', 'soul_fire', 'nether_wart']);

export class World {
  // `layout` (src/layout.js) fixes the grid and where the overworld lies; `meta` is the world.json data this world
  // reads (maps, warps, towns, people, lava, the Nether, the stronghold, The End). In Classic, meta === A.world and
  // everything below is built exactly as it was before the world update.
  constructor(layout = makeLayout({ kind: 'classic' })) {
    this.layout = layout;
    const M = this.meta = metaFor(layout);
    const W = layout.W, H = layout.H;
    this.W = W; this.H = H;
    if (layout.gen) this.initPlane();              // generated layouts: the plane, the band copied in, the rest void (2.2)
    else {
      this.grid = new Uint16Array(A.grid);          // mutable copies
      this.col = new Uint8Array(A.col);
      this.beh = new Uint8Array(A.beh);
      this.zone = A.zone;
      this.ground = A.ground;
    }
    this.entries = layout.gen ? A.world.entries.concat(A.terrain.entries, layout.kind === 'kanto' ? SIGN_ENTRIES : []) : A.world.entries;   // [mid, pair, beh, col, mat, base, hasTop, encounter, ...]
    this.signBase = layout.gen && layout.kind === 'kanto' ? this.entries.length - SIGN_ENTRIES.length : 0;   // (a Kanto World's spawn sign, src/kantosign.js: signBase + dir)
    this.maps = M.maps;
    this.towns = M.towns;
    if (!layout.gen) {
      this.area = A.area;                         // map index + 1 per cell, 0 outside every map
      this.prot = A.prot;                         // PROT per cell, 0 for anything that breaks normally
    }
    this.outdoor = M.outdoor || { w: W, h: H };
    // building doors by their closed and open atlas entries
    this.doorByEntry = new Map();
    for (const d of M.doors || []) { this.doorByEntry.set(d.closed, d); this.doorByEntry.set(d.open, d); }
    // warps by cell: doors, mats, ladders and stairs (tools/build_world.py follows FireRed's rules)
    this.warps = M.warps || [];
    this.warpIdx = new Map();
    // (a Wild World keeps Kanto's outdoor warps in the list, switched off: never indexed, 2.3)
    this.warps.forEach((w, i) => { w.i = i; if (!w.off) this.warpIdx.set(w.y * W + w.x, w); });
    // nothing gets placed on a warp or where a warp drops Steve
    this.noPlaceCells = new Set();
    for (const w of M.warps || []) {
      if (w.off) continue;
      this.noPlaceCells.add(w.y * W + w.x);
      if (w.amove === 'walk') this.noPlaceCells.add((w.ay + 1) * W + w.ax);
    }
    // learned wall (and forest tree) autotilers for the rooms, by tileset pair
    this.families = new Map();
    for (const f of Object.values(A.autotile.families || {})) this.families.set(f.pair, { ...f, mem: new Set(f.members), keep: new Set(f.keep) });
    this.blocks = new Map();                      // cell -> { id, ... } placed Minecraft blocks
    this.ticking = layout.gen ? new Set() : null;  // generated layouts: the cells of blocks that tick (2.12; Classic loops over blocks)
    this.edits = new Map();                       // cell -> atlas index (changes to the base grid, for saving)
    this.chunks = new Map();                      // draw canvases by draw chunk, least recently drawn first (an LRU, 10.3)
    this.chunkCap = chunkCap();
    this.cw = Math.ceil(W / CH); this.ch = Math.ceil(H / CH);
    // Mid space (4.5): the General mid each atlas entry shows (entries 0..639 are General's own; generated variants
    // map to their source's mid, everything else to -1), each entry's palette variant (0 = none) and whether it is an
    // overlay drawn over its cell's ground. Classic grids hold no variant or overlay entries, so these are identities.
    // Entries from GEN_BASE on live in the second atlas (atlas_gen.png, generated layouts only).
    this.genBase = A.world.entries.length;
    this.midOf = new Int16Array(this.entries.length);
    for (let t = 0; t < this.midOf.length; t++) this.midOf[t] = t < 640 ? t : -1;
    this.varOf = new Uint8Array(this.entries.length);
    this.ovOf = new Uint8Array(this.entries.length);
    this.ventry = null;                           // [variant][src mid] -> entry (terrain.json), generated layouts only
    if (layout.gen) {
      const T = A.terrain;
      for (let t = this.genBase; t < this.entries.length; t++) {
        const e = this.entries[t];
        this.midOf[t] = e[0]; this.varOf[t] = e[9] || 0; this.ovOf[t] = e[10] ? 1 : 0;
      }
      this.ventry = [];
      for (const [v, m] of Object.entries(T.ventry || {})) { const a = []; for (const [k, e] of Object.entries(m)) a[Number(k)] = e; this.ventry[Number(v)] = a; }
      this.initSpecies(T);
    }
    // Generated layouts only (2.4, 2.5): per data chunk, the pristine tile and ground of generated cells; the Kanto
    // blit's pristine tiles and ground; the streaming hook that makes chunks ready around a cell
    this.cbase = null; this.cground = null; this.kblit = null; this.ensureHook = null;
    if (layout.gen) this.initChunks();
    this.rbase = null; this.rground = null; this.mouths = null; this.roomInfo = null;
    this.mountain = new Set(A.autotile.mountain);
    this.lights = new Map();                      // cell -> light level of placed light sources (and lit Nether tiles)
    this.lightB = new Map();                      // the same lights bucketed by 16x16 cells, so a lookup only visits nearby ones
    this.tileLights = new Map();                  // cell -> light of the world tile itself (glowstone, lava, the portal, magma)
    this.onChange = null;
    // co-op (src/net/): the host's changed cells and a guest's touched cells; null in single-player
    this.dirty = null; this.capture = null;
    // the Nether (tools/build_nether.py): its map, and what each of its atlas entries is, for re-edging
    this.nether = M.nether || null;
    this.netherMap = this.nether ? this.maps[this.nether.map] : null;
    this.ntiles = new Map();
    if (this.nether) for (const [k, v] of Object.entries(this.nether.tiles)) this.ntiles.set(Number(k), v);
    // the stronghold and The End (tools/build_stronghold.py, tools/build_end.py): generated regions whose tiles
    // can give off light (wall torches, the exit fountain's torches), like the Nether's
    this.stronghold = M.stronghold || null;
    this.end = M.end || null;
    this.litMaps = new Set([this.nether, this.stronghold, this.end].filter(Boolean).map((r) => r.map + 1));
    // what each of their atlas entries is ([kind, mat, key, variant]), for re-edging after a change at runtime
    this.stiles = new Map(); this.etiles = new Map(); this.efloor = new Map(); this.eface = new Map();
    if (this.stronghold) for (const [k, v] of Object.entries(this.stronghold.tiles || {})) this.stiles.set(Number(k), v);
    if (this.end) {
      for (const [k, v] of Object.entries(this.end.tiles || {})) {
        this.etiles.set(Number(k), v);
        if (v[0] === 'floor') this.efloor.set(`${v[1]}|${v[2]}|${v[3]}`, Number(k));
      }
      for (const [k, v] of Object.entries(this.end.face || {})) this.eface.set(k, v);
    }
    this.refreshNetherLights();
  }
  // ---- the stronghold and The End (tools/build_stronghold.py, tools/build_end.py)
  inStronghold(x, y) { return !!this.stronghold && this.inside(x, y) && this.area[y * this.W + x] === this.stronghold.map + 1; }
  inEnd(x, y) { return !!this.end && this.inside(x, y) && this.area[y * this.W + x] === this.end.map + 1; }
  // a cell of The End's void (bridged cells and the platform are floor)
  isEndVoid(x, y) { return this.inEnd(x, y) && this.mat(x, y) === 'void'; }
  isEndPortal(x, y) { const b = this.block(x, y); return !!b && b.id === 'end_portal'; }
  // the floor tile (end stone or obsidian) a bridge over the void at (x, y) shows, rimmed for its void sides
  endFloorTile(x, y, look = 'end_stone') {
    const N = this.end;
    if (!N) return null;
    const vo = (X, Y) => { const k = this.inEnd(X, Y) ? this.etiles.get(this.grid[Y * this.W + X]) : null; return !k || k[0] === 'void' || k[0] === 'face'; };
    const key = (vo(x, y - 1) ? 1 : 0) | (vo(x + 1, y) ? 2 : 0) | (vo(x, y + 1) ? 4 : 0) | (vo(x - 1, y) ? 8 : 0);
    const v = variant(x - N.x, y - N.y, 4);
    return this.efloor.get(`${look}|${key}|${v * 3 + 1}`) ?? null;
  }
  // A stronghold cell changed (a wall mined, an infested block burst): walls around it take the piece their new
  // open mask calls for (two rows up too: a wall two cells deep is the upper half of a two-high face), and the
  // floors and water below it their contact shadow, as build_stronghold.py's assign() picks them.
  reedgeStronghold(x, y) {
    const S = this.stronghold, kind = (X, Y) => {
      if (!this.inStronghold(X, Y)) return 'wall';
      const k = this.stiles.get(this.grid[Y * this.W + X]);
      return k ? k[0] : 'wall';
    };
    const inR = (X, Y) => X >= S.x && Y >= S.y && X < S.x + S.w && Y < S.y + S.h;
    for (let Y = y - 2; Y <= y + 1; Y++) for (let X = x - 1; X <= x + 1; X++) {
      if (!this.inStronghold(X, Y)) continue;
      const info = this.stiles.get(this.tile(X, Y));
      if (!info) continue;
      const lx = X - S.x, ly = Y - S.y;
      let t = null;
      if (info[0] === 'wall') {
        const op = (XX, YY) => inR(XX, YY) && kind(XX, YY) !== 'wall';
        let k = canon((op(X, Y - 1) ? 1 : 0) | (op(X + 1, Y) ? 2 : 0) | (op(X, Y + 1) ? 4 : 0) | (op(X - 1, Y) ? 8 : 0)
          | (op(X + 1, Y - 1) ? 16 : 0) | (op(X + 1, Y + 1) ? 32 : 0) | (op(X - 1, Y + 1) ? 64 : 0) | (op(X - 1, Y - 1) ? 128 : 0));
        if (!(k & 4) && inR(X, Y + 2) && kind(X, Y + 1) === 'wall' && kind(X, Y + 2) !== 'wall') k |= 256;
        const list = S.wall[info[1]] && S.wall[info[1]][k];
        if (list && list.length) t = list[variant(lx, ly, 4) % list.length];
      } else if (info[0] === 'floor') {
        const sh = kind(X, Y - 1) === 'wall' ? 1 : 0, list = S.floor[info[1]] && S.floor[info[1]][sh];
        if (list && list.length) t = list[(info[3] || 0) % list.length];
      } else if (info[0] === 'water') {
        const sh = kind(X, Y - 1) === 'wall' ? 1 : 0;
        if (S.water && S.water[sh] != null) t = S.water[sh];
      }
      if (t != null && t !== this.tile(X, Y)) this.setTile(X, Y, t);
    }
  }
  // A block leaves its cell (blown up, primed, teleported away): what it stood on comes back. A block sunk flush into
  // water or the void gives its old tile back, one built on an End bridge leaves the bridge, and a bridge that goes
  // leaves the void with its edges redone.
  removeBlock(x, y) {
    const b = this.block(x, y);
    if (!b) return null;
    if (b.flush && b.under != null) this.setTile(x, y, b.under);
    this.setBlock(x, y, b.onBridge || null);
    if (b.bridge) this.reedgeEnd(x, y);
    return b;
  }
  // the cell has a piece of the top layer (a roof, a wall top, a tree's crown) that is drawn over sprites
  hasTop(x, y) { return this.inside(x, y) && !!this.entries[this.grid[y * this.W + x]][6]; }
  // An End cell changed between void and floor (a bridge built or mined, the platform mined): the floors around it
  // take the rims their void sides call for, and the void below a floor shows a thin face (as the platform's).
  reedgeEnd(x, y) {
    const N = this.end;
    const info = (X, Y) => (this.inEnd(X, Y) ? this.etiles.get(this.grid[Y * this.W + X]) || null : null);
    const voidish = (X, Y) => { const k = info(X, Y); return !k || k[0] === 'void' || k[0] === 'face'; };
    for (let Y = y - 1; Y <= y + 1; Y++) for (let X = x - 1; X <= x + 1; X++) {
      const k = info(X, Y);
      if (!k || k[0] !== 'floor') continue;
      let key = (voidish(X, Y - 1) ? 1 : 0) | (voidish(X + 1, Y) ? 2 : 0) | (voidish(X, Y + 1) ? 4 : 0) | (voidish(X - 1, Y) ? 8 : 0);
      const up = info(X, Y - 1);
      if (up && (up[0] === 'wall' || up[0] === 'pillar' || up[0] === 'fountain')) key |= 16;
      const t = this.efloor.get(`${k[1]}|${key}|${k[3]}`);
      if (t != null && t !== this.tile(X, Y)) this.setTile(X, Y, t);
    }
    // the void cells under (x, y) and under its neighbours: a face hangs one cell below any floor, else plain void
    for (let X = x - 1; X <= x + 1; X++) for (let Y = y; Y <= y + 1; Y++) {
      const k = info(X, Y);
      if (!k || (k[0] !== 'void' && k[0] !== 'face')) continue;
      // keep the island's own faces that hang from the same floor as before
      const above = info(X, Y - 1);
      const lx = X - N.x, ly = Y - N.y;
      let t;
      if (above && above[0] === 'floor') {
        const b = this.block(X, Y - 1), thin = above[1] === 'obsidian' || (b && b.bridge);
        if (!thin && k[0] === 'face') continue;
        const face = (XX) => { const a = info(XX, Y - 1); return !!a && a[0] === 'floor'; };
        const sides = (face(X - 1) || !voidish(X - 1, Y) ? 0 : 1) | (face(X + 1) || !voidish(X + 1, Y) ? 0 : 2);
        t = this.eface.get(`${thin ? 'obsidian' : 'end_stone'},1,${thin ? 1 : 2},${sides},${Math.floor(h01(lx, 0, 9) * 4)}`);
      } else if (k[0] === 'face' && above && (above[0] === 'face' || above[0] === 'void')) {
        const ak = above[0] === 'face' ? String(above[2]).split(',') : null;
        if (ak && Number(ak[0]) + 1 <= Number(ak[1])) continue;      // still part of a face from higher up
        t = N.voidTiles[(lx % 8) + (ly % 8) * 8];
      } else continue;
      if (t != null && t !== this.tile(X, Y)) this.setTile(X, Y, t);
    }
  }
  inside(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; }

  // ---------------------------------------------------------------- generated layouts (2.2 to 2.8, stage 4a)
  // The plane's arrays: every cell void (zone 2) but the room band, copied from Classic's grid at the same x, y.
  initPlane() {
    const L = this.layout, W = L.W, N = W * L.H, B = L.band, sw = A.world.w;
    this.grid = new Uint16Array(N); this.col = new Uint8Array(N); this.beh = new Uint8Array(N);
    this.zone = new Uint8Array(N).fill(2); this.area = new Uint16Array(N); this.prot = new Uint8Array(N);
    this.ground = null;                           // groundFor reads the band's copy, the chunks' arrays and the Kanto blit (2.5)
    for (let y = B.y0; y <= B.y1; y++) {
      const s0 = y * sw, d0 = y * W;
      this.grid.set(A.grid.subarray(s0 + B.x0, s0 + B.x1 + 1), d0 + B.x0);
      this.col.set(A.col.subarray(s0 + B.x0, s0 + B.x1 + 1), d0 + B.x0);
      this.beh.set(A.beh.subarray(s0 + B.x0, s0 + B.x1 + 1), d0 + B.x0);
      this.zone.set(A.zone.subarray(s0 + B.x0, s0 + B.x1 + 1), d0 + B.x0);
      this.area.set(A.area.subarray(s0 + B.x0, s0 + B.x1 + 1), d0 + B.x0);
      this.prot.set(A.prot.subarray(s0 + B.x0, s0 + B.x1 + 1), d0 + B.x0);
    }
    // a Kanto World (2.9, stage 6a): Kanto's outdoor block at (416 + kx, ky), its zone 0 and 1 cells with all their
    // arrays (its zone 2 cells are overworld cells, generated). `kmask` (Kanto-local) marks Kanto's own cells; their
    // pristine tiles and grounds are Classic's (`kblit`), except the seam cells a chunk re-tiles (applyChunk).
    const K = L.kanto;
    if (L.kind === 'kanto' && K) {
      const o = this.meta.outdoor, ow = o.w, oh = o.h, km = new Uint8Array(ow * oh);   // (this.outdoor is set later)
      for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
          const s = y * sw + x, ks = y * ow + x;
          if (A.zone[s] >= 2) continue;
          const d = (K.y + y) * W + K.x + x;
          km[ks] = 1;
          this.grid[d] = A.grid[s]; this.col[d] = A.col[s]; this.beh[d] = A.beh[s];
          this.zone[d] = A.zone[s]; this.area[d] = A.area[s]; this.prot[d] = A.prot[s];
        }
      }
      this.kmask = km;
      this.kblit = { base: A.grid, ground: A.ground };
    }
  }
  // a Kanto World (6b): whether the square (x .. x + n - 1, y .. y + n - 1) meets the box of Kanto cells a kept opening
  // re-tiles (world.meta.openings, plane cells)
  inOpening(x, y, n = 1) {
    const list = this.meta && this.meta.openings;
    if (!list || !list.length) return false;
    for (const o of list) if (o.box && x + n - 1 >= o.box[0] && y + n - 1 >= o.box[1] && x <= o.box[2] && y <= o.box[3]) return true;
    return false;
  }
  // a Kanto World: Kanto's own cell (zone 0 or 1 of its block), by plane cell
  isKantoCell(x, y) {
    const K = this.layout.kanto, km = this.kmask;
    if (!km || !K) return false;
    const lx = x - K.x, ly = y - K.y;
    return lx >= 0 && ly >= 0 && lx < this.outdoor.w && ly < this.outdoor.h && km[ly * this.outdoor.w + lx] === 1;
  }
  // Data chunks (2.4): cstate per chunk (0 not generated, 1 requested, 2 ready); the west strip (the band, the
  // gutter and the generated-room areas) is ready from the start. Per chunk: the pristine tiles and grounds and the
  // decoration codes; the cells' tile overrides that wait for their chunk; block overrides (`bover`, 0 = a generated
  // decoration removed).
  initChunks() {
    const C = PLANE.CHUNK, CW = PLANE.CW, NC = CW * PLANE.CHH, ocx = PLANE.OX / C;
    this.cstate = new Uint8Array(NC);
    for (let ck = 0; ck < NC; ck++) if (ck % CW < ocx) this.cstate[ck] = 2;
    // a Kanto World: the data chunks wholly of Kanto's cells with no seam cell (none within 3 cells of a generated
    // one) are ready from the start: nothing in them is generated (3.12)
    if (this.kmask) {
      const K = this.layout.kanto, ow = this.outdoor.w, oh = this.outdoor.h, km = this.kmask;
      const kAt = (x, y) => x >= 0 && y >= 0 && x < ow && y < oh && km[y * ow + x] === 1;
      for (let cy = K.y / C; cy < (K.y + oh) / C; cy++) {
        for (let cx = K.x / C; cx < (K.x + ow) / C; cx++) {
          let all = true;
          for (let y = cy * C - K.y - 3; y < (cy + 1) * C - K.y + 3 && all; y++) for (let x = cx * C - K.x - 3; x < (cx + 1) * C - K.x + 3; x++) if (!kAt(x, y)) { all = false; break; }
          // (6b) a chunk with cells a kept opening re-tiles is generated too (its cut comes from the painter)
          if (all && this.inOpening(cx * C, cy * C, C)) all = false;
          if (all) this.cstate[cy * CW + cx] = 2;
        }
      }
    }
    this.cbase = new Array(NC).fill(null); this.cground = new Array(NC).fill(null); this.deco = new Array(NC).fill(null);
    this.pend = new Map(); this.bover = new Map();
    // population and parking (2.11, stage 5c): a bit per data chunk whose herds have been spawned (saved), and the
    // entities parked by chunk while no player is near (src/chunks.js)
    this.pop = new Uint8Array((NC + 7) >> 3); this.parked = new Map();
    // biome id -> map index + 1 for `area` (the plan's biome maps, 2.10)
    this.biomeArea = new Uint16Array(64);
    this.maps.forEach((m, k) => { if (m.gen && !m.room && m.biomeId != null) this.biomeArea[m.biomeId] = k + 1; });
    this.genStats = { applied: 0, applyMs: 0, buildMs: 0, built: 0 };
    // each entry's collision and behaviour as flat tables, for applying chunks
    this.colOf = Uint8Array.from(this.entries, (e) => e[3]); this.behOf = Uint8Array.from(this.entries, (e) => e[2]);
  }
  // Caves as rooms (3.10; stage 5b). Every cave of the plan (world.meta.genCaves, wildMeta) is dug into its room slots
  // at once when the world is made, before a save or a co-op snapshot is applied (about 1 to 2 ms a floor), so a room
  // cell is always final, like the band's. `dig` and `families` are src/gen/cave.js's digCave and CAVE_FAMILY (handed
  // in by main.js, so Classic never loads the generator). Per room: the arrays, the room's map in `area`, the warp
  // cells protected as Kanto's are, the pristine tiles and grounds (`rbase`, `rground`, per west-strip chunk, 0xffff
  // where no room lies), the lava pools appended to `meta.lava` (refillPools fills them when someone comes in), and
  // the mouth cells protected when their overworld chunk is applied.
  initRooms(dig, families) {
    const M = this.meta, caves = M.genCaves, rooms = M.genRooms;
    if (!caves || !rooms || !dig) return;
    const t0 = performance.now(), C = PLANE.CHUNK, CW = PLANE.CW, W = this.W;
    const NC = this.cstate.length;
    this.rbase = new Array(NC).fill(null); this.rground = new Array(NC).fill(null);
    this.mouths = new Map(); this.roomInfo = new Map();
    const mapIdx = new Map(this.maps.map((m, k) => [m.id, k]));
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const lava = [];
    const tablesOf = new Map();
    for (const c of caves) {
      const F = families[c.family] || families.temperate;
      if (!tablesOf.has(F.key)) {
        const fam = A.autotile.families[F.key], ores = (A.terrain.ores.caves || {})[F.key] || {};
        tablesOf.set(F.key, { fam, col: (e) => (this.entries[e] ? this.entries[e][3] : 0), ores });
      }
      const T = tablesOf.get(F.key);
      for (const fl of c.b2 ? [1, 2] : [1]) {
        const r = byId.get(`GEN_CAVE_${c.id}_B${fl}F`);
        if (!r) continue;
        let res;
        try { res = dig({ w: r.w, h: r.h, floor: fl, seed: c.seed, family: c.family, b2: c.b2 }, T); }
        catch (e) { (this.genErrors || (this.genErrors = [])).push('cave ' + r.id + ': ' + String((e && e.stack) || e)); continue; }
        const ai = (mapIdx.get(r.id) ?? -1) + 1;
        for (let y = 0; y < r.h; y++) {
          for (let x = 0; x < r.w; x++) {
            const X = r.x + x, Y = r.y + y, i = Y * W + X, k = y * r.w + x, t = res.tile[k];
            this.grid[i] = t; this.col[i] = this.colOf[t]; this.beh[i] = this.behOf[t];
            this.zone[i] = 0; this.area[i] = ai; this.prot[i] = 0;
            const ck = (Y >> 5) * CW + (X >> 5), o = (Y & 31) * C + (X & 31);
            if (!this.rbase[ck]) { this.rbase[ck] = new Uint16Array(C * C).fill(0xffff); this.rground[ck] = new Uint16Array(C * C).fill(0xffff); }
            this.rbase[ck][o] = t; this.rground[ck][o] = res.ground[k];
          }
        }
        for (const [lx, ly] of res.lava) lava.push({ x: r.x + lx, y: r.y + ly, map: r.id });
        this.roomInfo.set(r.id, { x: r.x, y: r.y, w: r.w, h: r.h, pair: res.pair, stats: res.stats, lava: res.lava.length });
      }
      // the mouth: an opening once its chunk is applied
      const mx = this.layout.ox + c.x, my = this.layout.oy + c.y, mck = (my >> 5) * CW + (mx >> 5);
      if (!this.mouths.has(mck)) this.mouths.set(mck, []);
      this.mouths.get(mck).push(my * W + mx);
    }
    // the warp cells inside the rooms (exits and ladders) are openings, as Kanto's are
    for (const w of this.warps) if (!w.off && /^GEN_CAVE_/.test(w.map) && this.inside(w.x, w.y) && !this.isOutdoor(w.x, w.y)) this.prot[w.y * W + w.x] = PROT.OPENING;
    if (lava.length) M.lava = (M.lava || []).concat(lava);
    this.roomMs = performance.now() - t0;
  }
  // a generated room's pristine tiles as a 32-bit FNV-1a hash in hex (the co-op probe, 9.1), null if it is not dug
  roomHash(id) {
    const r = this.roomInfo && this.roomInfo.get(id);
    if (!r) return null;
    let h = 2166136261;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { h ^= this.baseTile(y * this.W + x) & 0xffff; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  // Villages (5.1, 5.2; stage 7a). Every house of the plan (world.meta.genVillages, its rooms genHouses) gets its
  // interior written into its room slot when the world is made, like the caves (initRooms): the template's cells
  // (terrain.json villages.interiors, Classic's own room entries), the room's map in `area`, the mat an opening, and its
  // furniture as live blocks: one or two white beds, a chest with the house's loot (rolled from the village's seed and
  // the house) and an indoor profession's job site. Those blocks are remembered as generated (`genLive`, their JSON),
  // so a save or a co-op catch-up carries one only when a player changed it, and a taken one as a removal (`bover`).
  // Outdoors: the houses' cells are structures and their doors openings once their chunk is applied (`vprot`), and a
  // farm cell's wheat is a function of the time and its row's replant time (2.12: `farms`, `farmBlock`).
  initHouses() {
    const M = this.meta, vs = M.genVillages, rooms = M.genHouses, TV = A.terrain && A.terrain.villages;
    if (!vs || !rooms || !TV || !this.cstate) return;
    const t0 = performance.now(), C = PLANE.CHUNK, CW = PLANE.CW, W = this.W, NC = this.cstate.length;
    if (!this.rbase) { this.rbase = new Array(NC).fill(null); this.rground = new Array(NC).fill(null); }
    if (!this.roomInfo) this.roomInfo = new Map();
    const mapIdx = new Map(this.maps.map((m, k) => [m.id, k]));
    const byId = new Map(rooms.map((r) => [r.id, r]));
    this.genLive = new Map(); this.vprot = new Map(); this.farmAt = new Map(); this.farms = new Map();
    const ox = this.layout.ox, oy = this.layout.oy;
    const live = (x, y, b) => { const i = y * W + x; this.blocks.set(i, b); this.genLive.set(i, { b, snap: snapBlock(b) }); };
    for (const v of vs) {
      for (const h of v.houses) {
        for (let yy = 0; yy < h.h; yy++) for (let xx = 0; xx < h.w; xx++) {
          const x = ox + h.x + xx, y = oy + h.y + yy, ck = (y >> 5) * CW + (x >> 5);
          if (!this.vprot.has(ck)) this.vprot.set(ck, []);
          this.vprot.get(ck).push(y * W + x, h.x + xx === h.door[0] && h.y + yy === h.door[1] ? PROT.OPENING : PROT.STRUCTURE);
        }
        const r = byId.get(`GEN_HOUSE_${v.id}_${h.id}`), it = TV.interiors[h.room];
        if (!r || !it || it.w !== r.w || it.h !== r.h) continue;
        const ai = (mapIdx.get(r.id) ?? -1) + 1;
        for (let y = 0; y < r.h; y++) {
          for (let x = 0; x < r.w; x++) {
            const X = r.x + x, Y = r.y + y, i = Y * W + X, t = it.cells[y * r.w + x];
            this.grid[i] = t; this.col[i] = this.colOf[t]; this.beh[i] = this.behOf[t];
            this.zone[i] = 0; this.area[i] = ai; this.prot[i] = 0;
            const ck = (Y >> 5) * CW + (X >> 5), o = (Y & 31) * C + (X & 31);
            if (!this.rbase[ck]) { this.rbase[ck] = new Uint16Array(C * C).fill(0xffff); this.rground[ck] = new Uint16Array(C * C).fill(0xffff); }
            this.rbase[ck][o] = t; this.rground[ck][o] = t;
          }
        }
        this.prot[(r.y + it.mat[1]) * W + r.x + it.mat[0]] = PROT.OPENING;
        const sp = it.spots;
        for (let k = 0; k < Math.min(h.beds || 1, sp.beds.length); k++) {
          const hx = r.x + sp.beds[k][0], hy = r.y + sp.beds[k][1];
          live(hx, hy, { id: 'white_bed', orient: 'up', part: 'head', other: [hx, hy + 1] });
          live(hx, hy + 1, { id: 'white_bed', orient: 'up', part: 'foot', other: [hx, hy] });
        }
        live(r.x + sp.chest[0], r.y + sp.chest[1], { id: 'chest', slots: villageLoot(v.seed, h.id) });
        if (h.jobIn && h.prof >= 0) live(r.x + sp.job[0], r.y + sp.job[1], { id: VILLAGE_JOBS[h.prof] });
        this.roomInfo.set(r.id, { x: r.x, y: r.y, w: r.w, h: r.h, house: true });
      }
      v.farms.forEach((f, fi) => {
        const key = v.id * 8 + fi, rows = Int32Array.from(f.rows, (ph) => -ph);
        this.farms.set(key, rows);
        let k = 0;
        for (let yy = 0; yy < f.h; yy++) {
          if (yy === f.water) continue;
          for (let xx = 0; xx < f.w; xx++) this.farmAt.set((oy + f.y + yy) * W + ox + f.x + xx, key * 8 + k);
          k++;
        }
      });
    }
    this.houseMs = performance.now() - t0;
  }
  // a generated live block (7a) still as the generator made it
  genSame(i) {
    const g = this.genLive && this.genLive.get(i), b = this.blocks.get(i);
    if (!g || !b) return false;
    // the block the generator placed, untouched (a bed or a job site never changes in place; a chest's slots do)
    if (b === g.b && b.id !== 'chest') return true;
    return sameBlock(b, g.snap);
  }
  // a village farm cell's block (2.12): farmland with wheat whose stage follows the time since its row's replant
  // (about one stage per 3,000 ticks); a fresh object each read, so a player's harvest or bone meal on it becomes an
  // ordinary placed block (a player change). `farmNow` (main.js) gives the absolute time in ticks.
  farmBlock(i) {
    const fk = this.farmAt && this.farmAt.get(i);
    if (fk == null) return { id: 'farmland', flush: true };
    const rows = this.farms.get(fk >> 3), t = this.farmNow ? this.farmNow() : 0;
    const age = t - (rows ? rows[fk & 7] : 0);
    const stage = age <= 0 ? 0 : Math.min(7, Math.floor(age / 3000));
    return { id: 'farmland', flush: true, crop: { stage, t: 0 } };
  }
  chunkKey(x, y) { return (y >> 5) * PLANE.CW + (x >> 5); }
  ready(x, y) { return !this.cstate || (this.inside(x, y) && this.cstate[(y >> 5) * PLANE.CW + (x >> 5)] === 2); }
  // inside the playable area (2.8): Classic, the whole grid
  inBorder(x, y) { const b = this.layout.border; return this.layout.gen ? x >= b.x0 && y >= b.y0 && x <= b.x1 && y <= b.y1 : this.inside(x, y); }
  // the biome map a generated overworld cell belongs to (null elsewhere)
  biomeAt(x, y) { const m = this.layout.gen ? this.mapAt(x, y) : null; return m && m.gen && !m.room ? m : null; }
  // Step 1 of applying a generated chunk (2.7): its 1,024 cells into the arrays, its pristine copies and decorations,
  // then the overrides that waited for it; its draw canvases are dropped. The chunk is ready (cstate 2) at once.
  // res: { cx, cy } (overworld-local data chunk) and Uint16 tile, ground, Uint8 deco and biome per cell (row-major).
  applyChunk(res) {
    if (this.chunkPatch) { try { res = this.chunkPatch(res) || res; } catch (e) { /* the sign's (src/kantosign.js) */ } }
    const C = PLANE.CHUNK, CW = PLANE.CW, pcx = res.cx + PLANE.OX / C, ck = res.cy * CW + pcx;
    if (!this.cstate || ck < 0 || ck >= this.cstate.length || this.cstate[ck] === 2) return false;
    const t0 = performance.now();
    const W = this.W, x0 = pcx * C, y0 = res.cy * C, b = this.layout.border, E = this.entries, ba = this.biomeArea;
    const tile = res.tile, bio = res.biome, grid = this.grid, col = this.col, beh = this.beh, zone = this.zone, area = this.area, colOf = this.colOf, behOf = this.behOf;
    const km = this.kmask;
    for (let ly = 0; ly < C; ly++) {
      const y = y0 + ly, row = y * W + x0, inY = y >= b.y0 && y <= b.y1;
      if (km) {
        // a Kanto World: Kanto's own cells keep their zone, map and protection; their tile is the chunk's (Classic's,
        // or the seam's re-tiled piece)
        for (let lx = 0, k = ly * C; lx < C; lx++, k++) {
          const x = x0 + lx, i = row + lx, t = tile[k];
          grid[i] = t; col[i] = colOf[t]; beh[i] = behOf[t];
          if (this.isKantoCell(x, y)) continue;
          zone[i] = inY && x >= b.x0 && x <= b.x1 ? 0 : 3;
          area[i] = ba[bio[k]];
          this.prot[i] = 0;
        }
        continue;
      }
      for (let lx = 0, k = ly * C; lx < C; lx++, k++) {
        const x = x0 + lx, i = row + lx, t = tile[k];
        grid[i] = t; col[i] = colOf[t]; beh[i] = behOf[t];
        zone[i] = inY && x >= b.x0 && x <= b.x1 ? 0 : 3;
        area[i] = ba[bio[k]];
      }
      this.prot.fill(0, row, row + C);
    }
    // a cave mouth (5b) is an opening: nothing breaks it
    const mo = this.mouths && this.mouths.get(ck);
    if (mo) for (const i of mo) this.prot[i] = PROT.OPENING;
    // a village's houses (7a): walls and roofs are structures, the door an opening; its lamps give light
    const vp = this.vprot && this.vprot.get(ck);
    if (vp) for (let k = 0; k < vp.length; k += 2) this.prot[vp[k]] = vp[k + 1];
    if (res.deco) for (let k = 0; k < res.deco.length; k++) if (res.deco[k] === DECO_LAMP) { const i = (y0 + (k >> 5)) * W + x0 + (k & 31); this.tileLights.set(i, 14); this.refreshLight(i); }
    this.cbase[ck] = tile; this.cground[ck] = res.ground;
    let any = false; for (let k = 0; k < res.deco.length; k++) if (res.deco[k]) { any = true; break; }
    this.deco[ck] = any ? res.deco : null;
    this.cstate[ck] = 2;
    const pend = this.pend.get(ck);
    if (pend) {
      this.pend.delete(ck);
      for (const i of pend) { const t = this.edits.get(i); if (t == null) continue; const e = E[t]; this.grid[i] = t; this.col[i] = e[3]; this.beh[i] = e[2]; }
    }
    // its four draw chunks are drawn afresh; a cactus on the chunk's top row has its top in the chunk above
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) this.chunks.delete((res.cy * 2 + dy) * this.cw + pcx * 2 + dx);
    if (this.deco[ck]) for (let x = 0; x < C; x++) if (this.deco[ck][x] === DECO_CACTUS) this.redraw(x0 + x, y0 - 1);
    if (this.onChunk) this.onChunk(res.cx, res.cy);
    if (this.mapHook) { try { this.mapHook(res.cx, res.cy); } catch (e) { /* the minimap's (src/minimap.js): it only marks */ } }
    if (this.popHook) this.popHook(ck);           // its herds, the first time (2.11; main.js, never on a co-op guest)
    this.genStats.applied++; this.genStats.applyMs += performance.now() - t0;
    return true;
  }
  // the decoration code of a generated cell (0 none or removed)
  decoAt(i) {
    const C = PLANE.CHUNK, x = i % this.W, y = (i / this.W) | 0, d = this.deco[(y >> 5) * PLANE.CW + (x >> 5)];
    if (!d) return 0;
    const v = d[(y & 31) * C + (x & 31)];
    return v && !this.bover.has(i) ? v : 0;
  }
  idx(x, y) { return y * this.W + x; }
  tile(x, y) { return this.inside(x, y) ? this.grid[y * this.W + x] : 0; }
  entry(x, y) { return this.entries[this.tile(x, y)]; }
  mat(x, y) { return this.inside(x, y) ? this.entries[this.grid[y * this.W + x]][4] : 'void'; }
  behaviorAt(x, y) { return this.inside(x, y) ? this.beh[y * this.W + x] : 0; }
  block(x, y) {
    if (!this.inside(x, y)) return null;
    const i = y * this.W + x, b = this.blocks.get(i);
    if (b || !this.deco) return b || null;
    // generated layouts: a generated decoration (2.7), one frozen block shared by every cell with its code
    const d = this.decoAt(i);
    if (d === DECO_FARM) return this.farmBlock(i);
    return d ? DECO_BLOCKS[d] || null : null;
  }
  // Co-op (stage 4c): a cell's block by index as the players see it. Classic: the `blocks` map, exactly as co-op
  // always read it. Generated layouts: also a generated decoration (a frozen block with `gen: true`, never mutated).
  blockAt(i) {
    const b = this.blocks.get(i);
    if (b || !this.deco) return b || null;
    const d = this.decoAt(i);
    if (d === DECO_FARM) return this.farmBlock(i);
    return d ? DECO_BLOCKS[d] || null : null;
  }
  // the generated decoration of a cell whatever players did to it (null: none, or its chunk is not ready)
  genBlockAt(i) {
    if (!this.deco) return null;
    const C = PLANE.CHUNK, x = i % this.W, y = (i / this.W) | 0, d = this.deco[(y >> 5) * PLANE.CW + (x >> 5)];
    const v = d ? d[(y & 31) * C + (x & 31)] : 0;
    return v ? DECO_BLOCKS[v] || null : null;
  }
  // Co-op in generated layouts: the cell's block goes back to what the generator made (its decoration, or nothing):
  // the placed block and the removal record go. A host's or guest's wire block with `gen: true` means this.
  restoreGen(x, y) {
    if (!this.deco || !this.inside(x, y)) return;
    const i = y * this.W + x;
    this.blocks.delete(i); this.bover.delete(i);
    if (this.ready(x, y)) {
      if (this.decoAt(i) === DECO_CACTUS) this.redraw(x, y - 1);
      if (this.isOutdoor(x, y)) this.outdoorVer = (this.outdoorVer || 0) + 1;
      this.refreshLight(i);
      this.redraw(x, y);
      for (const [dx, dy] of [[1, 0], [-1, 0]]) this.redraw(x + dx, y + dy);
    }
    if (this.dirty) this.dirty.add(i);
    if (this.capture) this.capture(i);
  }
  // Co-op's full catch-up (9.3): every cell a player changed, as [cell, tile, block | 0]. A cell of a chunk this page
  // has not generated says -1 for "the generated one" (its tile when it has no edit, its decoration when it has no
  // block override); the guest resolves that against its own chunks.
  overrideCells() {
    // (7a: a village's bed, chest or job site as generated is not an override)
    const live = this.genLive ? [...this.blocks.keys()].filter((i) => !this.genSame(i)) : this.blocks.keys();
    const cells = new Set([...this.edits.keys(), ...live, ...(this.bover ? this.bover.keys() : [])]);
    const out = [];
    for (const i of cells) {
      const x = i % this.W, y = (i / this.W) | 0;
      if (this.ready(x, y)) out.push([i, this.grid[i], this.blockAt(i) || 0]);
      else out.push([i, this.edits.has(i) ? this.edits.get(i) : -1, this.blocks.get(i) || (this.bover && this.bover.has(i) ? 0 : -1)]);
    }
    return out;
  }
  // A generated data chunk's own output (its pristine tiles, grounds and decoration codes) as a 32-bit FNV-1a hash
  // in hex, or null before it is ready: the co-op probe (9.1) and the tests compare these between pages.
  chunkHash(ck) {
    const t = this.cbase && this.cbase[ck];
    if (!t || this.cstate[ck] !== 2) return null;
    let h = 2166136261;
    const mix = (v) => { h ^= v & 0xffff; h = Math.imul(h, 16777619); };
    for (let k = 0; k < t.length; k++) mix(t[k]);
    const g = this.cground[ck]; if (g) for (let k = 0; k < g.length; k++) mix(g[k]); else mix(0xffff);
    const d = this.deco[ck]; if (d) for (let k = 0; k < d.length; k++) mix(d[k]); else mix(0xfffe);
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  // zone 2 is void (never drawn or entered); zone 3, generated land past the world border (2.6, 2.8), is drawn but
  // counts as void for movement, mining and placing. Classic has no zone 3 cells.
  isVoid(x, y) { return !this.inside(x, y) || this.zone[y * this.W + x] >= 2; }
  // the map's own collision, ignoring placed blocks
  baseBlocked(x, y) { return !this.inside(x, y) || this.zone[y * this.W + x] >= 2 || this.col[y * this.W + x] === 1; }
  isWater(x, y) {
    if (!this.inside(x, y) || this.zone[y * this.W + x] === 3) return false;   // no boat or swim past the border
    const b = this.blocks.get(y * this.W + x);
    if (b && b.flush) return false;
    return WATER.has(this.beh[y * this.W + x]) && this.col[y * this.W + x] === 0;
  }
  // a placed block that stops movement (torches, flowers, crops, open doors and floors don't)
  blockSolid(x, y) {
    const b = this.block(x, y);
    if (!b) return false;
    if (b.flush || b.walk) return false;
    if (isDoor(b)) return !b.open;
    return true;
  }
  solid(x, y) { return this.baseBlocked(x, y) || this.blockSolid(x, y); }
  jumpDir(x, y) { return MB.JUMP[this.behaviorAt(x, y)] || null; }
  tallGrass(x, y) { return this.behaviorAt(x, y) === MB.TALL_GRASS && !this.block(x, y); }
  // Plain ground a block can be placed on, a sapling planted in, and so on.
  isFloor(x, y) {
    if (!this.inside(x, y) || this.baseBlocked(x, y) || this.isWater(x, y)) return false;
    if (this.entries[this.grid[y * this.W + x]][6]) return false;   // walkable but under a roof or a treetop
    const m = this.mat(x, y);
    return m === 'floor' || m === 'sand' || m === 'tallgrass' || m === 'flower' || m === 'soul_sand' || m === 'soul_soil' || m === 'magma_block' || m === 'obsidian_floor'
      || GEN_FLOORS.has(m);      // the generated grounds (4.5): snow, mud, podzol, clay, ice (never in Classic)
  }
  // ---- the Nether region
  inNether(x, y) { return !!this.netherMap && this.inside(x, y) && this.area[y * this.W + x] === this.nether.map + 1; }
  // what a Nether cell's tile is: [kind, material or look, key, variant] (kind wall, floor, lava, portal, fence)
  nInfo(x, y) { return this.inside(x, y) ? this.ntiles.get(this.grid[y * this.W + x]) || null : null; }
  // lava, as a world tile (the Nether's lakes) or a placed block (the deep caves' pools, or poured)
  isLava(x, y) { const b = this.block(x, y); return (b && b.id === 'lava') || this.mat(x, y) === 'lava'; }
  isPortal(x, y) { const b = this.block(x, y); return (b && b.id === 'nether_portal') || this.mat(x, y) === 'nether_portal'; }
  // A Nether cell's tile for its current kind and neighbours, as tools/build_nether.py's assign() picks it.
  netherTileFor(x, y) {
    const info = this.nInfo(x, y), N = this.nether;
    if (!info) return null;
    const lx = x - N.x, ly = y - N.y;
    const kindAt = (X, Y) => { const k = this.nInfo(X, Y); return k ? k[0] : null; };
    if (info[0] === 'wall') {
      const open = (X, Y) => { const k = kindAt(X, Y); return k !== null && k !== 'wall'; };
      const key = canon((open(x, y - 1) ? 1 : 0) | (open(x + 1, y) ? 2 : 0) | (open(x, y + 1) ? 4 : 0) | (open(x - 1, y) ? 8 : 0)
        | (open(x + 1, y - 1) ? 16 : 0) | (open(x + 1, y + 1) ? 32 : 0) | (open(x - 1, y + 1) ? 64 : 0) | (open(x - 1, y - 1) ? 128 : 0));
      const list = N.wall[info[1]] && N.wall[info[1]][key];
      return list ? list[variant(lx, ly, 4) % list.length] : null;
    }
    if (info[0] === 'floor') {
      const nk = kindAt(x, y - 1), sh = nk === null || nk === 'wall' ? 1 : 0;
      const list = N.floor[info[1]] && N.floor[info[1]][sh];
      return list ? list[variant(lx, ly, 8) % list.length] : null;
    }
    if (info[0] === 'lava') {
      const notLava = (X, Y) => kindAt(X, Y) !== 'lava';
      const key = (notLava(x, y - 1) ? 1 : 0) | (notLava(x + 1, y) ? 2 : 0) | (notLava(x, y + 1) ? 4 : 0) | (notLava(x - 1, y) ? 8 : 0);
      let lip = 'netherrack';
      if (key & 1) {
        const up = this.nInfo(x, y - 1);
        const look = !up ? 'netherrack' : up[0] === 'fence' ? 'fence' : up[0] === 'portal' ? 'portal' : up[1];
        lip = N.lipOf[look] || 'netherrack';
      }
      const t = N.lava[lip] || N.lava.netherrack;
      return t[String(key)] ?? t[key ? String(key) : 'False'] ?? null;
    }
    if (info[0] === 'fence') {
      const c = (X, Y) => { const k = this.nInfo(X, Y); return !!k && (k[0] === 'fence' || (k[0] === 'wall' && k[1] === 'nether_bricks')); };
      const key = (c(x, y - 1) ? 1 : 0) | (c(x + 1, y) ? 2 : 0) | (c(x, y + 1) ? 4 : 0) | (c(x - 1, y) ? 8 : 0);
      return N.fence[String(key)] ?? N.fence[key ? String(key) : 'False'] ?? null;
    }
    return null;
  }
  // After a Nether cell changed (a wall mined, lava turned to stone): every cell around it takes the piece
  // its new neighbourhood calls for: wall outlines and faces, the floor's contact shadow, lava banks.
  reedgeNether(x, y) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (!this.inNether(X, Y)) continue;
      const t = this.netherTileFor(X, Y);
      if (t != null && t !== this.tile(X, Y)) this.setTile(X, Y, t);
    }
  }
  // A Nether floor tile (plain netherrack unless `look` says otherwise) at (x, y), shaded for its north side.
  netherFloorTile(x, y, look = 'floor') {
    const N = this.nether, up = this.nInfo(x, y - 1), sh = !up || up[0] === 'wall' ? 1 : 0;
    const list = N.floor[look][sh];
    return list[variant(x - N.x, y - N.y, 8) % list.length];
  }
  // fire on netherrack burns forever (the Nether's plain floor, not the fortress's bricks)
  eternalFire(x, y) { const k = this.nInfo(x, y); return !!k && k[0] === 'floor' && k[1] === 'floor'; }
  isGrass(x, y) {
    // generated layouts (4.5): a palette variant is grass when the variant says so and its source piece is grass
    const v = this.varOf[this.tile(x, y)];
    if (v && this.varInfo) { const V = this.varInfo[v]; return !!(V && V.grass) && GRASS_PIECES.has(this.mid(x, y)); }
    const e = this.entry(x, y);
    if (!e || e[1] !== -1) return this.mat(x, y) === 'floor' && this.grassy(x, y);
    return [1, 8, 9, 16, 17, 13].includes(e[0]) || this.grassy(x, y);
  }
  // grass judged from the tile's look: most FireRed grass shares a few greens
  grassy(x, y) {
    const t = this.tile(x, y);
    if (this._grassCache === undefined) this._grassCache = new Map();
    if (this._grassCache.has(t)) return this._grassCache.get(t);
    const c = document.createElement('canvas'); c.width = 16; c.height = 16;
    const g = c.getContext('2d');
    this.blitEntry(g, t, false, 0, 0);
    const d = g.getImageData(0, 0, 16, 16).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 25 && d[i + 1] > d[i + 2]) n++;
    const v = n > 160 && this.mat(x, y) === 'floor';
    this._grassCache.set(t, v);
    return v;
  }
  // the map (outdoor map or room) a cell belongs to, from area.bin
  areaOf(x, y) {
    if (!this.inside(x, y)) return null;
    const a = this.area[y * this.W + x];
    return a ? this.maps[a - 1] : null;
  }
  mapAt(x, y) { return this.areaOf(x, y); }
  areaAt(x, y) { const m = this.mapAt(x, y); return m ? m.name : null; }
  warpAt(x, y) { return this.inside(x, y) ? this.warpIdx.get(y * this.W + x) || null : null; }
  // the room (interior or cave map) Steve is in, or null outdoors
  roomAt(x, y) { const m = this.areaOf(x, y); return m && m.room ? m : null; }
  // under the sky, in the shared outdoors: Kanto's outdoor block in Classic, the overworld rectangle in generated layouts
  isOutdoor(x, y) { const L = this.layout; return x >= L.ox && y >= L.oy && x < L.ox + L.ow && y < L.oy + L.oh; }
  // The place a cell belongs to (2.10): Classic, the map id (null outside every map). Generated layouts: a Kanto
  // map's id for Kanto's cells, 'WILD' for every generated overworld cell (biomes are not places), the room's id
  // in rooms. Entities are culled, and mobs spawn and teleport, only within one place.
  regionKey(x, y) {
    const m = this.mapAt(x, y);
    if (!this.layout.gen) return m ? m.id : null;
    if (this.isOutdoor(x, y)) return m && !m.gen && !m.off ? m.id : 'WILD';
    return m ? m.id : null;
  }
  // Two cells in the same place: Classic, the same map and both outdoors or both not (today's test); generated
  // layouts, the same regionKey.
  samePlace(ax, ay, bx, by) {
    if (!this.layout.gen) return this.areaOf(ax, ay) === this.areaOf(bx, by) && this.isOutdoor(ax, ay) === this.isOutdoor(bx, by);
    return this.regionKey(ax, ay) === this.regionKey(bx, by);
  }
  // Make the data chunks within r of a cell ready before anything reads it (2.13). Classic's world is all there:
  // true at once. Generated layouts hand it to the streaming (true when ready now, else a promise).
  // `sync`: paint what is missing here and now (a pearl's landing, 10.1's other synchronous path); always true then.
  ensureAround(x, y, r = 1, sync = false) { return !this.layout.gen || !this.ensureHook ? true : this.ensureHook(x, y, r, sync); }
  // border cells take the closest map of their own region (outdoor Kanto or the rooms below it)
  nearestMap(x, y) {
    const hit = this.mapAt(x, y);
    if (hit) return hit;
    const out = this.isOutdoor(x, y);
    let best = null, bd = Infinity;
    for (const m of this.maps) {
      if (!m.room !== out || m.off || (m.gen && m.x == null)) continue;   // (Kanto's switched-off maps, the biome maps: 2.10)
      const d = Math.max(0, m.x - x, x - (m.x + m.w - 1)) + Math.max(0, m.y - y, y - (m.y + m.h - 1));
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }
  pcDoor(x, y) { const m = this.mat(x, y); return this.towns.some((t) => t.land.x === x && t.land.y - 1 === y) && (m === 'door' || m === 'doorway'); }
  townByDoor(x, y) { return this.towns.find((t) => t.land.x === x && t.land.y - 1 === y) || null; }

  // ---------------------------------------------------------------- protection (tools/build_world.py prot.bin)
  protAt(x, y) { return this.inside(x, y) ? this.prot[y * this.W + x] : 0; }
  // Cells nothing breaks: buildings, monuments, openings and warps, and everything inside an indoor room.
  // Doors are the exception: they come off and leave the doorway.
  noBreak(x, y) {
    const p = this.protAt(x, y);
    if (p === PROT.DOOR) return false;
    if (p) return true;
    const m = this.areaOf(x, y);
    return !!(m && m.kind === 'indoor');
  }
  // Cells nothing is put on (or dug, tilled, flooded): protected cells, warps, arrival cells, counters.
  noPlace(x, y) {
    if (!this.inside(x, y)) return true;
    const i = y * this.W + x;
    return this.prot[i] !== 0 || this.noPlaceCells.has(i) || this.beh[i] === MB_COUNTER;
  }
  // A walkable cell drawn over by a building or a sign (a roof eave, the mailbox top): nothing to mine there.
  overhang(x, y) {
    if (this.baseBlocked(x, y) || !this.entries[this.tile(x, y)][6]) return false;
    const p = this.protAt(x, y);
    return p === PROT.STRUCTURE || p === PROT.MONUMENT || this.mat(x, y) === 'floor';
  }
  // the building door style at a door cell, closed or opened
  doorAt(x, y) { return this.protAt(x, y) === PROT.DOOR ? this.doorByEntry.get(this.tile(x, y)) || null : null; }
  doorClosed(x, y) { const d = this.doorAt(x, y); return d && this.tile(x, y) === d.closed ? d : null; }
  // Take a building's door off its hinges: the open doorway stays solid with the door warp behaviour.
  openDoor(x, y) {
    const d = this.doorClosed(x, y);
    if (!d) return null;
    this.setTile(x, y, d.open);
    return d;
  }
  // Hang a door back in its own doorway.
  closeDoor(x, y, style) {
    const d = this.doorAt(x, y);
    if (!d || d.style !== style || this.tile(x, y) !== d.open) return null;
    this.setTile(x, y, d.closed);
    return d;
  }

  // ---------------------------------------------------------------- editing
  setTile(x, y, t) {
    if (!this.inside(x, y)) return;
    const i = y * this.W + x;
    // generated layouts: a cell whose chunk is not ready only records its override, applied with the chunk (2.7)
    if (this.cstate && this.cstate[(y >> 5) * PLANE.CW + (x >> 5)] !== 2) {
      this.edits.set(i, t);
      const ck = (y >> 5) * PLANE.CW + (x >> 5);
      if (!this.pend.has(ck)) this.pend.set(ck, []);
      this.pend.get(ck).push(i);
      return;
    }
    const e = this.entries[t];
    this.grid[i] = t;
    this.col[i] = e[3];
    this.beh[i] = e[2];
    this.edits.set(i, t);
    this.redraw(x, y);
    if (this.inLitRegion(x, y)) for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) this.refreshTileLight(x + dx, y + dy);
    if (this.onChange) this.onChange(x, y);
    if (this.dirty) this.dirty.add(i);
    if (this.capture) this.capture(i);
  }
  setBlock(x, y, b) {
    const i = y * this.W + x;
    if (b && WALK_IDS.has(b.id)) b.walk = true;
    if (b) this.blocks.set(i, b); else this.blocks.delete(i);
    if (this.ticking) { if (b && tickingBlock(b)) this.ticking.add(i); else this.ticking.delete(i); }
    // generated layouts, a cell whose chunk is not ready (2.7): only the override is recorded (a clear may be a
    // generated decoration's removal, which the chunk's codes cannot tell yet); nothing is drawn
    if (this.cstate && this.inside(x, y) && this.cstate[(y >> 5) * PLANE.CW + (x >> 5)] !== 2) {
      if (b) this.bover.delete(i); else this.bover.set(i, 0);
      this.refreshLight(i);
      if (this.dirty) this.dirty.add(i);
      if (this.capture) this.capture(i);
      return;
    }
    // generated layouts: clearing a cell with a generated decoration records its removal (2.7); a cactus's top lies
    // in the cell above
    if (this.deco && this.inside(x, y)) {
      if (!b && this.decoAt(i)) { const was = this.decoAt(i); this.bover.set(i, 0); if (was === DECO_CACTUS) this.redraw(x, y - 1); if (was === DECO_LAMP) { this.tileLights.delete(i); } }
      else if (!b && this.genLive && this.genLive.has(i)) this.bover.set(i, 0);   // (7a: a village's bed, chest or job site taken)
      else if (b) this.bover.delete(i);
      // a placed cactus's top lies in the cell above too (placed or removed: setBlock(null) has deleted it already)
      this.redraw(x, y - 1);
    }
    if (this.isOutdoor(x, y)) this.outdoorVer = (this.outdoorVer || 0) + 1;   // eyes of ender relabel Kanto after this
    this.refreshLight(i);
    this.redraw(x, y);
    // fences and beds look at their neighbours
    for (const [dx, dy] of [[1, 0], [-1, 0]]) this.redraw(x + dx, y + dy);
    if (this.onChange) this.onChange(x, y);   // (the minimap marks the cell's block: src/minimap.js, never throws)
    if (this.dirty && this.inside(x, y)) this.dirty.add(i);
    if (this.capture && this.inside(x, y)) this.capture(i);
  }
  // co-op: a block object was changed in place without setBlock (a campfire's food, a furnace's slots); nothing in
  // single-player, where dirty and capture are null
  touch(x, y) {
    if (!this.inside(x, y)) return;
    const i = y * this.W + x;
    if (this.dirty) this.dirty.add(i);
    if (this.capture) this.capture(i);
  }
  // What a broken cell leaves (its ground), and a cell's pristine tile before any player change (2.5). Classic reads
  // build_world.py's arrays as before; generated layouts read the chunk's own arrays, the room band's and the Kanto
  // blit's copies.
  groundFor(x, y) {
    if (!this.layout.gen) return this.ground[y * this.W + x];
    // a Kanto World: Kanto's own cells leave Classic's ground (a re-tiled seam cell's too), except around a kept
    // opening (6b), whose cut cells show the painter's ground (its chunk's)
    if (this.kmask && this.isKantoCell(x, y) && !this.inOpening(x, y)) return A.ground[(y - this.layout.kanto.y) * A.world.w + (x - this.layout.kanto.x)];
    return this.pristine(y * this.W + x, this.cground, A.ground, this.kblit && this.kblit.ground, this.rground);
  }
  baseTile(i) {
    if (!this.layout.gen) return A.grid[i];
    return this.pristine(i, this.cbase, A.grid, this.kblit && this.kblit.base, this.rbase);
  }
  pristine(i, perChunk, band, kanto, rooms) {
    const x = i % this.W, y = (i / this.W) | 0, L = this.layout, C = PLANE.CHUNK;
    const c = perChunk && perChunk[Math.floor(y / C) * PLANE.CW + Math.floor(x / C)];
    if (c) return c[(y % C) * C + (x % C)];
    // a generated room's cell (5b): its dug tiles and grounds per west-strip chunk, 0xffff where no room lies
    const r = rooms && rooms[Math.floor(y / C) * PLANE.CW + Math.floor(x / C)];
    if (r && r[(y % C) * C + (x % C)] !== 0xffff) return r[(y % C) * C + (x % C)];
    const B = L.band, K = L.kanto, sw = A.world.w, ow = this.outdoor.w, oh = this.outdoor.h;
    if (B && x >= B.x0 && x <= B.x1 && y >= B.y0 && y <= B.y1) return band[y * sw + x];
    if (K && kanto && x >= K.x && y >= K.y && x < K.x + ow && y < K.y + oh) return kanto[(y - K.y) * ow + (x - K.x)];
    return 0;
  }

  // Break the base tile at (x, y). Trees come down whole and the forest around them re-tiles; cliffs
  // re-edge themselves. Returns the cells that changed.
  // Protected cells refuse; a building door only opens.
  breakTile(x, y) {
    if (this.protAt(x, y) === PROT.DOOR) return this.openDoor(x, y) ? [[x, y]] : [];
    if (this.noBreak(x, y)) return [];
    const mat = this.mat(x, y);
    const fam = this.familyAt(x, y);
    if (mat === 'tree' && !fam) {
      const tr = this.findTree(x, y);
      if (tr) return this.removeTree(tr.lx, tr.cy);
    }
    const changed = [[x, y]];
    this.setTile(x, y, this.groundFor(x, y));
    if (this.inNether(x, y)) { this.reedgeNether(x, y); return changed; }
    if (this.inStronghold(x, y)) { this.reedgeStronghold(x, y); return changed; }
    if (this.inEnd(x, y)) { this.reedgeEnd(x, y); return changed; }
    // a sign or mailbox takes its top piece (drawn in the cell above) with it
    const up = this.entry(x, y - 1);
    if (mat === 'sign' && up && up[6] && !this.col[(y - 1) * this.W + x] && !this.protAt(x, y - 1) && up[4] !== 'tree' && up[4] !== 'water') {
      this.setTile(x, y - 1, this.groundFor(x, y - 1));
      changed.push([x, y - 1]);
    }
    if (fam) this.reedgeFamily(x, y, fam);
    else if (mat === 'rock' || mat.endsWith('_ore') || mat === 'boulder') this.reedgeCliffs(x, y);
    return changed;
  }

  // ---- FireRed trees: crowns on one row, the tip of the next tree sharing a row with this one's base.
  // the General mid a cell shows (-1 for anything else), through the mid-space table (4.5)
  mid(x, y) { return this.midOf[this.tile(x, y)]; }
  // the entry that shows General mid `src` in palette variant `v` (the mid itself for variant 0, so in Classic)
  entryFor(v, src) {
    if (!v || !this.ventry) return src;
    const m = this.ventry[v], e = m ? m[src] : undefined;
    return e == null ? src : e;
  }
  slotAt(lx, cy) { const a = this.mid(lx, cy), b = this.mid(lx + 1, cy); return (a === 28 || a === 30) && (b === 29 || b === 31); }
  findTree(x, y) {
    const t = this.mid(x, y);
    const lx = T_LEFT.has(t) ? x : T_RIGHT.has(t) ? x - 1 : null;
    if (lx === null) return null;
    let cy = null;
    if (t >= 28 && t <= 31) cy = y;
    else if (t === 14 || t === 15) cy = y + 1;
    else if (t >= 36 && t <= 39) cy = y - 1;
    else if (t >= 20 && t <= 23) cy = this.slotAt(lx, y + 1) ? y + 1 : y - 1;
    return cy !== null && this.slotAt(lx, cy) ? { lx, cy } : null;
  }
  removeTree(lx, cy) {
    const gone = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = 0; dx < 2; dx++) gone.push([lx + dx, cy + dy]);
    // clear the crown first so the slot no longer exists, then repaint the neighbourhood by rule
    this.grid[cy * this.W + lx] = this.groundFor(lx, cy);
    this.grid[cy * this.W + lx + 1] = this.groundFor(lx + 1, cy);
    const cells = [];
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = lx - 2; x <= lx + 3; x++) {
      const isGone = gone.some(([gx, gy]) => gx === x && gy === y);
      if (!isGone && !T_STD.has(this.mid(x, y))) continue;
      const left = isGone ? x === lx : T_LEFT.has(this.mid(x, y));
      const pl = left ? x : x - 1;
      const t = this.treeTileFor(pl, y, left);
      cells.push([x, y, t === null ? this.groundFor(x, y) : this.pieceFor(t, this.treeVarAt(pl, y), this.groundFor(x, y))]);
    }
    for (const [x, y, t] of cells) this.setTile(x, y, t);
    return gone;
  }
  treeTileFor(lx, y, left) {
    const s = (a, b) => this.slotAt(a, b);
    if (s(lx, y)) return left ? (s(lx - 2, y) ? 28 : 30) : (s(lx + 2, y) ? 29 : 31);
    const above = s(lx, y - 1), below = s(lx, y + 1);
    if (above && below) return left ? (s(lx - 2, y - 1) && s(lx - 2, y + 1) ? 20 : 22) : (s(lx + 2, y - 1) && s(lx + 2, y + 1) ? 21 : 23);
    if (above) return left ? (s(lx - 2, y - 1) ? 36 : 38) : (s(lx + 2, y - 1) ? 37 : 39);
    if (below) return left ? 14 : 15;
    return null;
  }
  // A sapling grows into a FireRed tree when there is room for its crown and trunk.
  canGrowTree(x, y) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = 0; dx < 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (this.noPlace(xx, yy) || this.noBreak(xx, yy)) return false;     // never over a warp, a door's step or a house
      if (!(xx === x && yy === y) && (!this.isFloor(xx, yy) || this.block(xx, yy))) return false;
    }
    return true;
  }
  growTree(x, y) {
    const lx = x, cy = y;
    // generated layouts: the sapling's species (a spruce on snow grows the snowy spruce's look); Classic: oak, as ever
    const sv = this.specVar ? this.saplingVar(this.block(x, y), x, y) : 0;
    this.setBlock(x, y, null);
    const v = this.specVar ? sv : this.varOf[this.tile(x, y)];
    this.grid[cy * this.W + lx] = this.pieceFor(28, v, this.groundFor(lx, cy)); this.grid[cy * this.W + lx + 1] = this.pieceFor(29, v, this.groundFor(lx + 1, cy));   // provisional crown so the slot exists
    for (let yy = cy - 1; yy <= cy + 1; yy++) for (let xx = lx - 2; xx <= lx + 3; xx++) {
      const own = xx >= lx && xx <= lx + 1;
      if (!own && !T_STD.has(this.mid(xx, yy))) continue;
      const left = own ? xx === lx : T_LEFT.has(this.mid(xx, yy));
      const pl = left ? xx : xx - 1;
      const t = this.treeTileFor(pl, yy, left);
      if (t !== null) this.setTile(xx, yy, this.pieceFor(t, this.specVar ? this.treeVarAt(pl, yy) : this.varOf[this.tile(xx, yy)], this.groundFor(xx, yy)));
    }
  }
  // ---- tree species (generated layouts, 3.8 and 4.5); Classic has only oak (variant 0) and these return its values
  initSpecies(T) {
    this.varInfo = []; for (const V of T.variants || []) this.varInfo[V.id] = V;
    this.specVar = new Map(); this.specOfVar = []; this.specs = [];
    for (const [name, sp] of Object.entries(T.species || {})) {
      const home = [], ov = [];
      for (const [k, e] of Object.entries(sp.home)) home[Number(k)] = e;
      for (const [k, e] of Object.entries(sp.ov)) ov[Number(k)] = e;
      this.specVar.set(name, sp.var); this.specOfVar[sp.var] = name; this.specs[sp.var] = { name, home, ov, ground: sp.ground, wood: sp.wood };
    }
    // the grounds a species' home look was drawn on (terrain.js fam): General's grasses, and the snowy style's
    const grassOf = (v) => new Set([1, 8, 9, 16, 17].map((m) => this.entryFor(v, m)));
    this.famGrass = grassOf(0);
    this.famSnow = T.rockStyles && T.rockStyles.snowy ? grassOf(T.rockStyles.snowy.var) : new Set();
    // ice over sea and over fresh water (quarter set A's recolours) and the water each melts back into
    const A_ = T.quarter && T.quarter.sets && T.quarter.sets.A && T.quarter.sets.A.recolours;
    this.iceOf = new Map();
    if (A_) for (const [name, water] of [['ice', T.waterTile], ['ice_pond', T.pondTile]]) {
      const r = A_[name]; if (!r) continue;
      for (const e of r.home) this.iceOf.set(e, { home: r.home, water });
    }
    this.blobLut = T.quarter && T.quarter.lut;
  }
  // the entry for General tree piece `mid` of the species with variant `v` over ground entry `ground`: its home look
  // on the ground it was drawn on, its overlay anywhere else (4.3). Classic: the mid itself (entryFor, variant 0).
  pieceFor(mid, v, ground) {
    const sp = this.specs && this.specs[v || 0];
    if (!sp) return this.entryFor(v, mid);
    const fam = sp.ground === 'snow' ? this.famSnow : this.famGrass;
    const e = fam.has(ground) ? sp.home[mid] : sp.ov[mid];
    return e == null || e < 0 ? this.entryFor(v, mid) : e;
  }
  // the species variant of the tree a piece belongs to (its own row's slot, else the one above, else below: trees.js)
  treeVarAt(lx, y) {
    const row = this.slotAt(lx, y) ? y : this.slotAt(lx, y - 1) ? y - 1 : this.slotAt(lx, y + 1) ? y + 1 : null;
    return row === null ? 0 : this.varOf[this.tile(lx, row)];
  }
  // the wood a tree cell gives (oak, birch, spruce, dark_oak, acacia, jungle): 'oak' in Classic
  treeWood(x, y) {
    if (!this.specs) return 'oak';
    const tr = this.findTree(x, y), v = tr ? this.varOf[this.tile(tr.lx, tr.cy)] : this.varOf[this.tile(x, y)];
    const sp = this.specs[v] || this.specs[0];
    return (sp && sp.wood) || 'oak';
  }
  saplingVar(b, x, y) {
    let name = b && typeof b.id === 'string' && b.id.endsWith('_sapling') ? b.id.slice(0, -8) : 'oak';
    if (name === 'spruce' && this.soilAt(x, y) === 'snow') name = 'snowy_spruce';
    return this.specVar.has(name) ? this.specVar.get(name) : 0;
  }
  // What a cell's ground is for planting (generated layouts): grass (any tint), snow (snowy grass), podzol, mud,
  // clay, ice, sand, path, water, or the material. Classic: 'grass' for grass and tall grass, else the material.
  soilAt(x, y) {
    const m = this.mat(x, y);
    if (!this.varInfo) return this.isGrass(x, y) || m === 'tallgrass' ? 'grass' : m;
    if (GEN_FLOORS.has(m) || m === 'sand') return m;
    if (this.isWater(x, y)) return 'water';
    const v = this.varOf[this.tile(x, y)], V = v ? this.varInfo[v] : null;
    if (V) {
      if (V.grass && GRASS_PIECES.has(this.mid(x, y))) return 'grass';
      if (V.ground && V.ground !== 'grass') return V.ground;
    }
    if (m === 'tallgrass' || m === 'flower' || this.isGrass(x, y)) return 'grass';
    return m;
  }
  // May a block with planting rule `plant` (items.json) go down at (x, y)? Classic keeps its one rule (grass or tall
  // grass); generated layouts follow Minecraft's soils (4.5)
  plantOk(x, y, plant) {
    const k = this.soilAt(x, y);
    if (plant === 'grass') return this.varInfo ? SOILS.has(k) : k === 'grass';
    if (plant === 'sand') return k === 'sand';
    if (plant === 'bush') return k === 'sand' || SOILS.has(k);
    if (plant === 'cane') {
      if (!(k === 'sand' || (SOILS.has(k) && k !== 'snow'))) return false;
      return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => this.isWater(x + dx, y + dy));
    }
    return true;
  }
  // Ice broken with a pickaxe turns back into its water (3.5), and the ice around re-picks its edge pieces
  isIce(x, y) { return !!(this.iceOf && this.iceOf.has(this.tile(x, y))); }
  meltIce(x, y) {
    const r = this.iceOf && this.iceOf.get(this.tile(x, y));
    if (!r) return false;
    this.setTile(x, y, r.water);
    const open = (X, Y) => this.isWater(X, Y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy, n = this.iceOf.get(this.tile(X, Y));
      if (!n || !this.blobLut) continue;
      const bits = (open(X, Y - 1) ? 0 : 1) | (open(X + 1, Y) ? 0 : 2) | (open(X, Y + 1) ? 0 : 4) | (open(X - 1, Y) ? 0 : 8)
        | (open(X + 1, Y - 1) ? 0 : 16) | (open(X + 1, Y + 1) ? 0 : 32) | (open(X - 1, Y + 1) ? 0 : 64) | (open(X - 1, Y - 1) ? 0 : 128);
      const t = n.home[this.blobLut[bits]];
      if (t != null && t !== this.tile(X, Y)) this.setTile(X, Y, t);
    }
    return true;
  }
  // a placed block drawn into the draw canvas from the tile bank's top-down pictures (generated layouts) rather
  // than as a placed look: generated decorations, and placed sugar cane, cactus, dead bushes, lily pads, pumpkins, melons
  baked(b) { return !!b && (b.baked || (!!this.deco && !b.flush && !!SYNTH_BLOCKS[b.id] && !!A.terrain)); }

  // ---- cliffs: re-pick the edges around a mined cell with the autotiler learned from FireRed's maps
  isMountainCell(x, y) {
    if (!this.inside(x, y)) return true;
    const m = this.mat(x, y);
    return m === 'rock' || m.endsWith('_ore');
  }
  groundClass(x, y) {
    let g = 0, s = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const m = this.mat(x + dx, y + dy);
      if (m === 'floor' || m === 'tallgrass' || m === 'flower') g++;
      else if (m === 'sand') s++;
    }
    return s > g ? 's' : 'g';
  }
  keyOf(x, y, r) {
    let bits = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = Math.min(this.W - 1, Math.max(0, x + dx)), yy = Math.min(this.H - 1, Math.max(0, y + dy));
      bits = bits * 2 + (this.isMountainCell(xx, yy) ? 1 : 0);
    }
    return bits;
  }
  reedgeCliffs(x, y) {
    const T = A.autotile;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      const m = this.mid(xx, yy);
      if (m < 0 || !this.mountain.has(m)) continue;
      const g = this.groundClass(xx, yy);
      let pick = null;
      for (const r of [2, 1]) {
        const k = this.keyOf(xx, yy, r);
        for (const cands of [T[`g${r}`][`${k}|${g}`], T[`r${r}`][String(k)]]) {
          if (!cands) continue;
          for (const c of cands) {
            const cp = T.compat[c];
            if (cp && ((g === 's' && cp[0]) || (g === 'g' && cp[1]))) continue;
            pick = c; break;
          }
          if (pick !== null) break;
        }
        if (pick !== null) break;
      }
      if (pick !== null && pick !== m) this.setTile(xx, yy, this.entryFor(this.varOf[this.tile(xx, yy)], pick));
    }
  }

  // ---- cave walls and forest trees in the rooms: re-edge with the pieces FireRed draws for that tileset
  baseEntry(t) { const e = this.entries[t]; return e[5] >= 0 && e[4].endsWith('_ore') ? e[5] : t; }
  familyAt(x, y) {
    const m = this.areaOf(x, y);
    if (!m || !m.room) return null;
    const f = this.families.get(this.entries[this.baseEntry(this.tile(x, y))][1]);
    return f && f.mem.has(this.baseEntry(this.tile(x, y))) ? { ...f, map: m } : null;
  }
  // The mined cell is already ground. Every wall cell whose 3x3 changed takes the piece FireRed uses for
  // its new pattern (5x5, else 3x3, else the nearest 3x3), keeping its own piece when that is one of the
  // candidates. Cells further out, protected cells, ladders and holes, and ores are left alone.
  reedgeFamily(x, y, fam) {
    const m = fam.map;
    const inRoom = (X, Y) => X >= m.x && X < m.x + m.w && Y >= m.y && Y < m.y + m.h;
    const isIn = (X, Y) => (X === x && Y === y ? false : !inRoom(X, Y) || fam.mem.has(this.baseEntry(this.tile(X, Y))));   // past the room edge counts as wall
    const key = (X, Y, r) => {
      let k = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) k = k * 2 + (isIn(X + dx, Y + dy) ? 1 : 0);
      return String(k);
    };
    const free = (X, Y) => {
      if (!inRoom(X, Y) || !isIn(X, Y) || this.protAt(X, Y)) return false;
      const t = this.tile(X, Y);
      return !fam.keep.has(t) && this.entries[t][5] < 0;
    };
    const span = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) span.push([x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy))]);
    // the 3x3 patterns before the mined cell went (it reads as wall here)
    const was = new Map();
    for (const [X, Y] of span) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const XX = X + dx, YY = Y + dy;
        k = k * 2 + (XX === x && YY === y ? 1 : isIn(XX, YY) ? 1 : 0);
      }
      was.set(X + ',' + Y, String(k));
    }
    const changed = (X, Y) => key(X, Y, 1) !== was.get(X + ',' + Y);
    // only the mined cell opens: neighbours are re-skinned, never knocked out
    for (const [X, Y] of span) {
      // walkable platform tops stay as they are: a re-skin never turns ground into wall
      if (!free(X, Y) || !changed(X, Y) || !this.col[Y * this.W + X]) continue;
      const c = (fam.r2[key(X, Y, 2)] || fam.r1[key(X, Y, 1)] || fam.fill[key(X, Y, 1)] || []).filter((e) => this.entries[e][3]);
      const t = this.tile(X, Y);
      if (c.length && !c.includes(t)) this.setTile(X, Y, c[0]);
    }
  }

  // ---------------------------------------------------------------- drawing
  // A draw chunk's canvases, drawn from the arrays when first needed. The cache is an LRU (10.3): every use moves the
  // chunk to the back, and above the cap the least recently drawn pair is dropped (it is redrawn from the arrays,
  // identically, if it is needed again). The `above` canvas exists only once a cell of the chunk has a top piece.
  chunk(cx, cy) {
    const key = cy * this.cw + cx;
    let c = this.chunks.get(key);
    if (c) { this.chunks.delete(key); this.chunks.set(key, c); return c; }
    const t0 = this.genStats ? performance.now() : 0;
    c = { below: mkCanvas(), above: null, cx, cy, actx: null };
    c.bctx = c.below.getContext('2d');
    this.chunks.set(key, c);
    for (let y = 0; y < CH; y++) for (let x = 0; x < CH; x++) this.drawCell(c, cx * CH + x, cy * CH + y);
    if (this.genStats) { this.genStats.buildMs += performance.now() - t0; this.genStats.built++; }
    while (this.chunks.size > this.chunkCap) this.chunks.delete(this.chunks.keys().next().value);
    return c;
  }
  redraw(x, y) {
    if (!this.inside(x, y)) return;
    const key = Math.floor(y / CH) * this.cw + Math.floor(x / CH);
    const c = this.chunks.get(key);
    if (c) this.drawCell(c, x, y);
  }
  drawCell(c, x, y) {
    if (!this.inside(x, y)) return;
    const px = (x - c.cx * CH) * TILE, py = (y - c.cy * CH) * TILE;
    c.bctx.clearRect(px, py, TILE, TILE); if (c.actx) c.actx.clearRect(px, py, TILE, TILE);
    const i = y * this.W + x;
    if (this.zone[i] === 2) return;
    const t = this.grid[i];
    if (t >= this.genBase) this.drawGenCell(c, i, t, px, py);
    else {
      const sx = (t % A.world.cols) * TILE, sy = Math.floor(t / A.world.cols) * TILE;
      c.bctx.drawImage(A.img.atlas, sx, sy, TILE, TILE, px, py, TILE, TILE);
      if (this.entries[t][6]) this.aboveCtx(c).drawImage(A.img.atlasTop, sx, sy, TILE, TILE, px, py, TILE, TILE);
    }
    const b = this.blocks.get(i) || (this.deco && this.decoAt(i) === DECO_FARM ? FARMLAND_LOOK : null);   // (7a: a village farm's farmland)
    if (b && b.flush) {
      const look = blockLook(b.flushLook || (b.id + ':flush'));
      if (look != null) drawLook(c.bctx, look, px, py - 8);
    }
    if (this.deco && (!b || this.baked(b))) this.drawDeco(c, i, px, py, b);
  }
  // Generated decorations drawn into the canvas (2.7, 4a): the synthesized sprites' overlays (stage 2b) over the
  // cell's ground; a cactus's top piece in the cell above it, over sprites. Flowers are drawn as placed blocks.
  drawDeco(c, i, px, py, b = null) {
    const sp = A.terrain && A.terrain.synth.sprites, d = b ? 0 : this.decoAt(i);
    if (!sp) return;
    // (a placed sugar cane, cactus, dead bush, lily pad, pumpkin or melon: the same picture as a generated one)
    const name = b ? (SYNTH_BLOCKS[b.id] ? b.id : null) : d ? DECO_SPRITE[d] : null;
    if (name && sp[name]) this.blitEntry(c.bctx, sp[name].ov, false, px, py);
    const below = i + this.W < this.grid.length ? this.blocks.get(i + this.W) : null;
    if (i + this.W < this.grid.length && ((this.decoAt(i + this.W) === DECO_CACTUS && !below) || (below && below.id === 'cactus' && !below.flush)) && sp.cactus_top) {
      const t = sp.cactus_top.ov;
      this.blitEntry(c.bctx, t, false, px, py);
      this.blitEntry(this.aboveCtx(c), t, true, px, py);
    }
  }
  aboveCtx(c) {
    if (!c.actx) { c.above = mkCanvas(); c.actx = c.above.getContext('2d'); }
    return c.actx;
  }
  // An entry of the second atlas (atlas_gen.png, entries from genBase on; generated layouts only, 4.3, 4.5): an
  // overlay entry (a tree, rock-edge or path piece with its ground cut out) is drawn over the cell's ground entry.
  drawGenCell(c, i, t, px, py) {
    if (this.ovOf[t]) {
      const g = this.groundFor(i % this.W, (i / this.W) | 0);
      if (g !== t) this.blitEntry(c.bctx, g, false, px, py);
    }
    this.blitEntry(c.bctx, t, false, px, py);
    if (this.entries[t][6]) this.blitEntry(this.aboveCtx(c), t, true, px, py);
  }
  // one atlas entry from whichever atlas holds it (top: the layer drawn over sprites)
  blitEntry(g, t, top, px, py) {
    if (this.signBase > 0 && t >= this.signBase) { if (!top) { const im = A.img.kantoSign, k = im ? t - this.signBase : 3; g.drawImage(im || A.img.atlas, im ? k * TILE : (k % A.world.cols) * TILE, im ? 0 : Math.floor(k / A.world.cols) * TILE, TILE, TILE, px, py, TILE, TILE); } return; }   // (the Kanto sign's 8 arrows, kanto_sign.png; FireRed's own sign, entry 3, without it)
    const gen = t >= this.genBase, k = gen ? t - this.genBase : t, cols = gen ? A.genCols : A.world.cols;
    const img = gen ? (top ? A.img.atlasGenTop : A.img.atlasGen) : (top ? A.img.atlasTop : A.img.atlas);
    if (!img || !cols) return;
    g.drawImage(img, (k % cols) * TILE, Math.floor(k / cols) * TILE, TILE, TILE, px, py, TILE, TILE);
  }
  // Draw the ground (below sprites) or the overhang layer (above sprites) for a camera rect in pixels.
  drawLayer(ctx, cam, w, h, layer) {
    const S = CH * TILE;
    const x0 = Math.max(0, Math.floor(cam.x / S)), x1 = Math.min(this.cw - 1, Math.floor((cam.x + w) / S));
    const y0 = Math.max(0, Math.floor(cam.y / S)), y1 = Math.min(this.ch - 1, Math.floor((cam.y + h) / S));
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      // generated layouts: a draw chunk whose data chunk is not ready is not drawn (and not cached)
      if (this.cstate && this.cstate[(cy >> 1) * PLANE.CW + (cx >> 1)] !== 2) continue;
      const c = this.chunk(cx, cy), img = layer === 'above' ? c.above : c.below;
      if (img) ctx.drawImage(img, Math.round(cx * S - cam.x), Math.round(cy * S - cam.y));
    }
  }

  // ---------------------------------------------------------------- light
  // light reaches only cells of the same map (or the same outdoor region): never through a room's walls
  blockLight(x, y, src) {
    let best = 0;
    const a = this.inside(x, y) ? this.area[y * this.W + x] : 0, out = this.isOutdoor(x, y);
    const bx0 = (x - 15) >> 4, bx1 = (x + 15) >> 4, by0 = (y - 15) >> 4, by1 = (y + 15) >> 4;
    for (let by = by0; by <= by1; by++) for (let bxx = bx0; bxx <= bx1; bxx++) {
      const bucket = this.lightB.get(by * 4096 + bxx);
      if (!bucket) continue;
      for (const [i, L] of bucket) {
        const lx = i % this.W, ly = (i / this.W) | 0;
        const d = Math.abs(lx - x) + Math.abs(ly - y);
        if (L - d <= best) continue;
        if (out ? !this.isOutdoor(lx, ly) : this.area[i] !== a) continue;
        best = L - d;
        if (src) src.i = i;
      }
    }
    return best;
  }
  // a cell's light: the brighter of its placed block and its own tile
  refreshLight(i) {
    const L = Math.max(lightOf(this.blocks.get(i)), this.tileLights.get(i) || 0);
    const x = i % this.W, y = (i / this.W) | 0, k = (y >> 4) * 4096 + (x >> 4);
    let bucket = this.lightB.get(k);
    if (L > 0) {
      this.lights.set(i, L);
      if (!bucket) { bucket = new Map(); this.lightB.set(k, bucket); }
      bucket.set(i, L);
    } else {
      this.lights.delete(i);
      if (bucket) { bucket.delete(i); if (!bucket.size) this.lightB.delete(k); }
    }
  }
  // The light a world tile gives off itself (the Nether's glowstone, lava shores, portal and magma floors).
  // A lake's middle adds nothing its shore doesn't, so only lava beside something else glows.
  tileLightAt(x, y) {
    const s = A.world.materials[this.mat(x, y)];
    if (!s || !s.light) return 0;
    if (this.mat(x, y) === 'lava') {
      const shore = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => this.inNether(x + dx, y + dy) && this.mat(x + dx, y + dy) !== 'lava');
      if (!shore) return 0;
    }
    return s.light;
  }
  refreshTileLight(x, y) {
    if (!this.inside(x, y)) return;
    const i = y * this.W + x, L = this.inLitRegion(x, y) ? this.tileLightAt(x, y) : 0;
    if (L) this.tileLights.set(i, L); else this.tileLights.delete(i);
    this.refreshLight(i);
  }
  // a cell of a generated region whose tiles may light up (the Nether, the stronghold, The End)
  inLitRegion(x, y) { return this.inside(x, y) && this.litMaps.has(this.area[y * this.W + x]); }
  refreshNetherLights() {
    for (const N of [this.nether, this.stronghold, this.end]) {
      if (!N) continue;
      for (let y = N.y; y < N.y + N.h; y++) for (let x = N.x; x < N.x + N.w; x++) this.refreshTileLight(x, y);
    }
  }

  // ---------------------------------------------------------------- saving
  serialize() {
    const blocks = [];
    for (const [i, b] of this.blocks) blocks.push([i, b]);
    return { edits: [...this.edits], blocks };
  }
  restore(d) {
    for (const [i, t0] of d.edits || []) {
      let t = t0;
      if (t >= this.entries.length || i >= this.grid.length) continue;
      // saves from before buildings were protected may hold holes in them: the building comes back, and a
      // mined house door comes back as its open doorway (still the way in, and its door item fits it)
      const p = this.prot[i];
      if (p === PROT.STRUCTURE || p === PROT.OPENING || p === PROT.MONUMENT) continue;
      if (p === PROT.DOOR && !this.doorByEntry.has(t)) {
        const dd = this.doorByEntry.get(this.baseTile(i));
        if (!dd) continue;
        t = dd.open;
      }
      const e = this.entries[t];
      this.grid[i] = t; this.col[i] = e[3]; this.beh[i] = e[2]; this.edits.set(i, t);
    }
    for (const [i, b] of d.blocks || []) { if (b && WALK_IDS.has(b.id)) b.walk = true; this.blocks.set(i, b); this.refreshLight(i); }
    this.refreshNetherLights();
    this.chunks.clear();
  }
  // Generated layouts (8.3): only what players changed. `e`: the tile overrides as base64 varints (the cell-index
  // delta from the previous edit, ascending, then the tile); `b`: [delta, block | 0] in ascending cell order, the
  // placed blocks (live blocks are all placed ones until villages bring generated chests, 7a) and the removed
  // generated decorations (0). The farm records, the populated bitset and the rooms entered are empty until their
  // stages (7a, 5c, 5b) fill them.
  // `b` is kept as that array's JSON text: IndexedDB's structured clone of thousands of small arrays and blocks costs
  // about eight times the clone of one string plus JSON.stringify (measured in stage 4b). The work is in two halves a
  // save may run in separate frames (the world held still between them): `serialize2Begin` copies what changed,
  // `serialize2End` encodes it.
  serialize2() { return this.serialize2End(this.serialize2Begin()); }
  serialize2Begin() {
    // (cell and tile packed in one double, so one native sort orders them with no lookups)
    const ks = new Float64Array(this.edits.size);
    let n = 0;
    for (const [i, t] of this.edits) ks[n++] = i * 65536 + t;
    ks.sort();
    const nb = this.blocks.size + (this.bover ? this.bover.size : 0), cells = new Int32Array(nb), vals = new Array(nb);
    let m = 0;
    const gl = this.genLive, ox = PLANE.OX, WW = this.W;   // (7a: generated furniture lies in the rooms west of the overworld)
    for (const [i, b] of this.blocks) { if (gl && i % WW < ox && gl.has(i) && this.genSame(i)) continue; cells[m] = i; vals[m++] = b; }
    if (this.bover) for (const i of this.bover.keys()) if (!this.blocks.has(i)) { cells[m] = i; vals[m++] = 0; }
    return { ks, cells: cells.subarray(0, m), vals, pop: this.pop ? this.pop.slice() : null };
  }
  serialize2End(snap) {
    const ks = snap.ks, out = new Uint8Array(ks.length * 8 + 8);
    let n = 0, prev = 0;
    const put = (v) => { while (v >= 128) { out[n++] = (v & 127) | 128; v >>>= 7; } out[n++] = v; };
    for (let k = 0; k < ks.length; k++) { const i = Math.floor(ks[k] / 65536); put(i - prev); put(ks[k] - i * 65536); prev = i; }
    // blocks in ascending cell order: sort the positions by cell
    const m = snap.cells.length, ord = new Float64Array(m);
    for (let k = 0; k < m; k++) ord[k] = snap.cells[k] * 1048576 + k;
    ord.sort();
    const b = new Array(m);
    prev = 0;
    for (let k = 0; k < m; k++) { const i = Math.floor(ord[k] / 1048576), j = ord[k] - i * 1048576; b[k] = [i - prev, snap.vals[j]]; prev = i; }
    return { e: b64(out.subarray(0, n)), b: JSON.stringify(b), pop: snap.pop ? b64(snap.pop) : '', rooms: '', farms: {}, vacant: {} };
  }
  // A `v: 2` save's world (2.7): cells of ready chunks take their overrides at once (with Classic's rules for the
  // protected cells of the band), the rest wait for their chunk; blocks and removed decorations go into their maps.
  restore2(d) {
    const W = this.W, n = this.grid.length, E = this.entries;
    const raw = unb64(d && typeof d.e === 'string' ? d.e : '');
    let p = 0, i = 0;
    const get = () => { let v = 0, m = 1, c; do { if (p >= raw.length) return -1; c = raw[p++]; v += (c & 127) * m; m *= 128; } while (c & 128); return v; };
    while (p < raw.length) {
      const di = get(), t0 = get();
      if (di < 0 || t0 < 0) break;
      i += di;
      if (t0 >= E.length || i >= n) continue;
      const x = i % W, y = (i / W) | 0;
      if (!this.ready(x, y)) {
        this.edits.set(i, t0);
        const ck = (y >> 5) * PLANE.CW + (x >> 5);
        if (!this.pend.has(ck)) this.pend.set(ck, []);
        this.pend.get(ck).push(i);
        continue;
      }
      let t = t0;
      const pr = this.prot[i];
      if (pr === PROT.STRUCTURE || pr === PROT.OPENING || pr === PROT.MONUMENT) continue;
      if (pr === PROT.DOOR && !this.doorByEntry.has(t)) {
        const dd = this.doorByEntry.get(this.baseTile(i));
        if (!dd) continue;
        t = dd.open;
      }
      const e = E[t];
      this.grid[i] = t; this.col[i] = e[3]; this.beh[i] = e[2]; this.edits.set(i, t);
    }
    i = 0;
    let rows = d && d.b;
    if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch (e) { rows = null; } }
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (!Array.isArray(r) || !Number.isInteger(r[0])) continue;
      i += r[0];
      if (i < 0 || i >= n) continue;
      const b = r[1];
      if (b && typeof b === 'object' && typeof b.id === 'string') { if (WALK_IDS.has(b.id)) b.walk = true; this.blocks.set(i, b); if (this.ticking && tickingBlock(b)) this.ticking.add(i); this.refreshLight(i); }
      else if (b === 0 && this.bover) { this.bover.set(i, 0); if (this.genLive && this.genLive.has(i)) this.blocks.delete(i); }
    }
    // the populated chunks (5c): a save from before stage 5c has none, so its chunks get their herds again
    if (this.pop && d && typeof d.pop === 'string' && d.pop) { const u = unb64(d.pop); if (u.length === this.pop.length) this.pop.set(u); }
    this.refreshNetherLights();
    this.chunks.clear();
  }
}
// The blocks that tick (2.12): crops, saplings of every wood, fire, furnaces, campfires and nether wart (main.js mcTick)
const TICK_IDS = new Set(['fire', 'furnace', 'campfire', 'nether_wart']);
export function tickingBlock(b) { return !!b && (!!b.crop || TICK_IDS.has(b.id) || (typeof b.id === 'string' && b.id.endsWith('_sapling'))); }
function b64(u8) {
  let s = '';
  for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
  return btoa(s);
}
function unb64(s) {
  try { const r = atob(s), u = new Uint8Array(r.length); for (let k = 0; k < r.length; k++) u[k] = r.charCodeAt(k); return u; } catch (e) { return new Uint8Array(0); }
}

// Generated decoration codes (src/gen/chunk.js DECO, append only; tools/gen_tests/stream.mjs checks they agree) and
// the frozen blocks they read as (2.7). `baked`: drawn into the draw canvas from the synthesized sprites (drawDeco),
// not as a placed block's look. Flowers and the pumpkin are the items players place too.
const DECO_IDS = ['', 'dandelion', 'poppy', 'sugar_cane', 'cactus', 'dead_bush', 'pumpkin', 'melon', 'lily_pad',
  'mossy_stone_bricks', 'cracked_stone_bricks',   // (6c: the stronghold ruin's bricks, drawn and solid as placed blocks)
  // (7a: the villages' blocks, src/gen/village.js VILLAGE_DECOS: the well's ring, farmland (its wheat from the farm's
  // record, World.farmBlock), fences, lamps, the bell and the job sites)
  'cobblestone', 'sandstone', 'farmland', 'oak_fence', 'torch', 'bell', 'composter', 'lectern', 'brewing_stand', 'blast_furnace',
  'grindstone', 'smithing_table', 'smoker', 'fletching_table', 'cartography_table', 'cauldron', 'stonecutter', 'loom', 'barrel'];
const DECO_FARM = DECO_IDS.indexOf('farmland'), DECO_LAMP = DECO_IDS.indexOf('torch');
const DECO_CACTUS = 4;
const DECO_WALK = new Set(['dandelion', 'poppy', 'sugar_cane', 'dead_bush', 'lily_pad', 'torch']);
const DECO_BAKED = new Set(['sugar_cane', 'cactus', 'dead_bush', 'pumpkin', 'melon', 'lily_pad']);
const DECO_BLOCKS = DECO_IDS.map((id) => (id ? Object.freeze({ id, gen: true, ...(DECO_WALK.has(id) ? { walk: true } : {}), ...(DECO_BAKED.has(id) ? { baked: true } : {}) }) : null));
const DECO_SPRITE = DECO_IDS.map((id) => (DECO_BAKED.has(id) ? id : null));
const SIGN_ENTRIES = Object.freeze(Array.from({ length: 8 }, () => Object.freeze([-1, -1, 0x84, 1, 'sign', -1, 0, 0, -1, 0, 1])));   // a Kanto World's spawn sign, one per arrow (src/kantosign.js)
const FARMLAND_LOOK = Object.freeze({ id: 'farmland', flush: true });
// placed blocks with a top-down picture in the tile bank (terrain.json synth.sprites), drawn like the generated ones
const SYNTH_BLOCKS = { sugar_cane: 1, cactus: 1, dead_bush: 1, lily_pad: 1, pumpkin: 1, melon: 1 };
const GEN_FLOORS = new Set(['snow', 'mud', 'podzol', 'clay', 'ice']);
const GRASS_PIECES = new Set([1, 8, 9, 16, 17, 13]);
// Minecraft's soils for saplings and flowers (4.5): grass of any tint, snowy grass, podzol, mud
const SOILS = new Set(['grass', 'snow', 'podzol', 'mud']);
export { DECO_IDS };
// (7a) job-site blocks by profession (src/gen/village.js PROFS / JOB_BLOCK order) and a house chest's loot (5.2: bread,
// apples, wheat, an emerald or two, iron ingots), rolled from the village's seed and the house (world.js does not load
// src/gen, so its own small hash)
const VILLAGE_JOBS = ['composter', 'lectern', 'brewing_stand', 'blast_furnace', 'grindstone', 'smithing_table', 'smoker',
  'fletching_table', 'cartography_table', 'cauldron', 'stonecutter', 'loom', 'barrel'];
function vhash(a, b, c) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return h >>> 0;
}
// a generated live block's snapshot (its fields, arrays copied one level, a chest's slots as [id, n, dmg]) and the
// comparison a save makes against it: no JSON per block per save
function snapBlock(b) {
  const o = {};
  for (const k of Object.keys(b)) { const v = b[k]; o[k] = Array.isArray(v) ? v.map((e) => (e && typeof e === 'object' ? [e.id, e.n, e.dmg] : e)) : v; }
  return o;
}
function sameBlock(b, o) {
  const ks = Object.keys(b);
  if (ks.length !== Object.keys(o).length) return false;
  for (const k of ks) {
    const v = b[k], w = o[k];
    if (Array.isArray(v)) {
      if (!Array.isArray(w) || v.length !== w.length) return false;
      for (let j = 0; j < v.length; j++) {
        const e = v[j], f = w[j];
        if (e && typeof e === 'object') { if (!Array.isArray(f) || e.id !== f[0] || e.n !== f[1] || e.dmg !== f[2] || Object.keys(e).some((q) => q !== 'id' && q !== 'n' && q !== 'dmg')) return false; }
        else if (e !== f) return false;
      }
    } else if (v !== w) return false;
  }
  return true;
}
function villageLoot(seed, house) {
  const slots = new Array(27).fill(null);
  const pool = [['bread', 1, 4], ['apple', 1, 3], ['wheat', 2, 6], ['emerald', 1, 2], ['iron_ingot', 1, 3]];
  let k = 0;
  pool.forEach(([id, lo, hi], j) => {
    const r = vhash(seed, house, j);
    if (r % 100 < (id === 'emerald' ? 45 : id === 'iron_ingot' ? 35 : 70)) slots[(k++ * 5 + (r >>> 8) % 3) % 27] = { id, n: lo + ((r >>> 12) % (hi - lo + 1)) };
  });
  return slots;
}

function mkCanvas() { const k = document.createElement('canvas'); k.width = CH * TILE; k.height = CH * TILE; return k; }
// How many draw-chunk canvas pairs stay cached (10.3): fewer on phones (a coarse pointer).
function chunkCap() {
  try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 48 : 96; } catch (e) { return 96; }
}

// ---------------------------------------------------------------- placed block looks (assets/mc/blocks.png)
export function blockLook(key) { const v = A.items.blocks[key]; return v === undefined ? null : v; }
export function drawLook(ctx, look, x, y, alpha = 1) {
  const [cw, chh] = A.items.cell;
  const per = 32;
  if (alpha < 1) ctx.globalAlpha = alpha;
  ctx.drawImage(A.mc.blocks, (look % per) * cw, Math.floor(look / per) * chh, cw, chh, Math.round(x), Math.round(y), cw, chh);
  if (alpha < 1) ctx.globalAlpha = 1;
}
export function isDoor(b) { const it = b && A.items.items[b.id]; return !!(it && it.block && it.block.use === 'door'); }
// tools/build_nether.py's canon() and variant(): an open mask without the corners whose sides aren't both
// wall, and the per-cell variety hash (h01) of the region's local coordinates
function canon(key) {
  const n = key & 1, e = key & 2, s = key & 4, w = key & 8;
  let out = key & 15;
  if (!n && !e && key & 16) out |= 16;
  if (!s && !e && key & 32) out |= 32;
  if (!s && !w && key & 64) out |= 64;
  if (!n && !w && key & 128) out |= 128;
  return out;
}
function h01(x, y, salt) {
  let v = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 1442695041)) >>> 0;
  v = Math.imul(v ^ (v >>> 13), 1274126177) >>> 0;
  v = (v ^ (v >>> 16)) >>> 0;
  return v / 4294967296;
}
const variant = (x, y, n) => Math.floor(h01(x, y, 7) * n);
export function lightOf(b) {
  if (!b) return 0;
  if (b.id === 'furnace') return b.burn > 0 ? 13 : 0;
  if (b.id === 'fire') return 15;
  if (b.id === 'campfire') return b.lit ? 15 : 0;
  const it = A.items.items[b.id];
  return it && it.block && it.block.light ? it.block.light : 0;
}
