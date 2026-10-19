// Village layouts (design 5.1, 5.2, 4.4; stage 7a). Pure (3.0): a layout is a function of the village's seed, its
// bounds and its style only, so the plan computes it once and the chunk painter and the runtime read it.
//
//   layoutVillage(vs, x0, y0, S, style)  -> the plan's village record fields (overworld-local cells) or null when
//                                           fewer than PLAN_HOUSES[0] houses fit (the plan then rejects the site)
//   villageRaster(v)                     -> { S, x0, y0, kind: Uint8Array(S * S), aux: Int16Array(S * S) }, cached on v
//   checkVillage(v)                      -> the list of failed checks of 5.1 / 4.7 item 9 (empty when all hold)
//
// The shape: a 9 x 9 plaza at the centre; 3 or 4 roads 2 cells wide leave it (each overlapping it by 2 cells),
// straight segments of 10 to 28 cells with up to two right-angle bends. Houses stand on the north side of east-west
// segments with their door's front cell on the road, or beside north-south segments with a door spur 2 cells wide
// from the door's front cell to the road. Plaza, roads and spurs are one mask of one material (the style's recolour
// of quarter set C). A 3 x 3 well (a ring of cobblestone, sandstone in deserts, round one pond water cell) on the
// plaza, a bell in villages of 8 or more houses, outdoor job sites beside their house, farms of 7 x 5 (two farmland
// rows, a water row, two farmland rows), a pen of 6 x 6 oak fence and lamp posts (torches) beside the roads.
//
// Templates: the plan needs only sizes and doors, kept here as constants equal to terrain.json `villages`
// (tools/build_terrain_villages.py; tools/gen_tests/villages.mjs checks they agree), so the plan never depends on
// the art file.
import { hash32 } from './hash.js';
import { byNum } from './order.js';

export const EXTERIORS = Object.freeze({
  plains: [{ w: 5, h: 4, door: [1, 3] }, { w: 4, h: 4, door: [1, 3] }, { w: 5, h: 5, door: [1, 4] }],
  desert: [{ w: 5, h: 4, door: [1, 3] }, { w: 4, h: 4, door: [1, 3] }],
  savanna: [{ w: 5, h: 4, door: [1, 3] }, { w: 4, h: 4, door: [1, 3] }],
  taiga: [{ w: 5, h: 4, door: [1, 3] }, { w: 4, h: 4, door: [1, 3] }],
  snowy: [{ w: 5, h: 4, door: [1, 3] }, { w: 4, h: 4, door: [1, 3] }],
});
export const INTERIORS = Object.freeze([
  { w: 11, h: 9, mat: [4, 7] }, { w: 11, h: 9, mat: [4, 7] }, { w: 11, h: 9, mat: [4, 7] },
  { w: 11, h: 9, mat: [3, 7] }, { w: 11, h: 9, mat: [4, 7] },
]);
// 13 professions with job sites (5.4), in this order; indoor ones keep their job site in the interior
export const PROFS = Object.freeze(['farmer', 'librarian', 'cleric', 'armorer', 'weaponsmith', 'toolsmith', 'butcher',
  'fletcher', 'cartographer', 'leatherworker', 'mason', 'shepherd', 'fisherman']);
export const JOB_BLOCK = Object.freeze(['composter', 'lectern', 'brewing_stand', 'blast_furnace', 'grindstone',
  'smithing_table', 'smoker', 'fletching_table', 'cartography_table', 'cauldron', 'stonecutter', 'loom', 'barrel']);
export const INDOOR = Object.freeze(new Set(['librarian', 'cleric', 'cartographer', 'shepherd']));
export const PLAN_HOUSES = Object.freeze([6, 12]);
export const FARM = Object.freeze({ w: 7, h: 5, water: 2 });   // the water row
export const PEN = 6;

// raster kinds (villageRaster)
export const K = Object.freeze({ NONE: 0, PATH: 1, HOUSE: 2, WELL: 3, WELLW: 4, FARM: 5, FARMW: 6, FENCE: 7, LAMP: 8, JOB: 9, BELL: 10 });
const WALK = new Uint8Array([1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0]);   // per kind: a villager or the player can stand there
const ON_PATH = new Uint8Array([0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 1]); // per kind: part of the path mask (the plaza's well and bell)

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // N E S W

// ---------------------------------------------------------------- layout
export function layoutVillage(vs, x0, y0, S, style) {
  const tpl = EXTERIORS[style] || EXTERIORS.plains;
  const c = S >> 1, lo = 2, hi = S - 3;               // local cells lo..hi are usable (the edge stays plain ground)
  const occ = new Uint8Array(S * S);                  // K kinds while placing
  const at = (x, y) => (x < lo || y < lo || x > hi || y > hi ? 255 : occ[y * S + x]);
  const fill = (x, y, w, h, k) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) occ[yy * S + xx] = k; };
  const free = (x, y, w, h) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (at(xx, yy) !== K.NONE) return false;
    return true;
  };
  const rects = [];                                   // the path mask as rectangles (local)
  const path = (x, y, w, h) => {
    const ax = Math.max(lo, Math.min(x, x + w - 1)), bx = Math.min(hi, Math.max(x, x + w - 1));
    const ay = Math.max(lo, Math.min(y, y + h - 1)), by = Math.min(hi, Math.max(y, y + h - 1));
    if (bx < ax || by < ay) return null;
    rects.push([ax, ay, bx - ax + 1, by - ay + 1]);
    fill(ax, ay, bx - ax + 1, by - ay + 1, K.PATH);
    return [ax, ay, bx - ax + 1, by - ay + 1];
  };
  path(c - 4, c - 4, 9, 9);                           // the plaza
  // roads: arms N, E, S, W from inside the plaza (2 cells of overlap); one arm dropped in a third of villages
  const drop = hash32(vs, 11) % 3 === 0 ? hash32(vs, 12) & 3 : -1;
  const segs = [];                                    // { ew, x, y, len } of each straight segment (local, 2 wide)
  for (let d = 0; d < 4; d++) {
    if (d === drop) continue;
    const [dx, dy] = DIRS[d];
    // the road's two columns (N, S) or rows (E, W) are c - 1 and c: the arm starts 3 cells from the centre (2 inside)
    let x = dx ? c + dx * 3 : c - 1, y = dy ? c + dy * 3 : c - 1;
    let dir = d;
    const bends = hash32(vs, 20, d) % 3;              // 0, 1 or 2 bends
    for (let k = 0; k <= bends; k++) {
      const [ex, ey] = DIRS[dir];
      const room = ex > 0 ? hi - x : ex < 0 ? x - lo : ey > 0 ? hi - y : y - lo;
      let len = Math.min(10 + (hash32(vs, 21, d, k) % 19), room);
      if (len < (k ? 6 : 4)) break;
      // a 2-wide strip from (x, y) along dir: its cells
      const ew = ex !== 0;
      const sx = ex < 0 ? x - len + 1 : x, sy = ey < 0 ? y - len + 1 : y;
      const r = ew ? path(sx, y, len, 2) : path(x, sy, 2, len);
      if (!r) break;
      segs.push({ id: segs.length, ew, x: r[0], y: r[1], w: r[2], h: r[3] });
      // the far end; a bend turns left or right and keeps the 2-wide join (the corner square is the old strip's end)
      const fx = ex > 0 ? sx + len - 2 : ex < 0 ? sx : x, fy = ey > 0 ? sy + len - 2 : ey < 0 ? sy : y;
      const turn = hash32(vs, 22, d, k) & 1 ? 1 : 3;
      dir = (dir + turn) & 3;
      const [nx, ny] = DIRS[dir];
      x = nx > 0 ? fx + 2 : nx < 0 ? fx - 1 : fx;
      y = ny > 0 ? fy + 2 : ny < 0 ? fy - 1 : fy;
    }
  }
  // the well on the plaza's north-west quadrant (clear of the roads), the bell later
  const well = [c - 4, c - 4];
  fill(c - 4, c - 4, 3, 3, K.WELL); occ[(c - 3) * S + c - 3] = K.WELLW;

  // houses: east-west segments first (doors straight onto the road), then north-south ones with spurs
  const target = PLAN_HOUSES[0] + (hash32(vs, 2) % (PLAN_HOUSES[1] - PLAN_HOUSES[0] + 1));
  const houses = [];
  const order = segs.map((s) => ({ id: s.id, key: (s.ew ? 0 : 0x80000000) + (hash32(vs, 30, s.id) >>> 1) }));
  order.sort(byNum('key'));
  const gapFree = (x, y, w, h) => free(x - 1, y - 1, w + 2, h + 1);   // one free cell around (the road side excepted)
  for (const o of order) {
    const s = segs[o.id];
    if (houses.length >= target) break;
    if (s.ew) {
      // north side: the house's bottom row is the row above the road
      let x = s.x + 1;
      while (x < s.x + s.w - 2 && houses.length < target) {
        const t = hash32(vs, 31, x, s.y) % tpl.length, T = tpl[t];
        const hx = x, hy = s.y - T.h;
        if (hx + T.w <= s.x + s.w && gapFree(hx, hy, T.w, T.h)) {
          fill(hx, hy, T.w, T.h, K.HOUSE);
          houses.push({ t, x: hx, y: hy, w: T.w, h: T.h, door: [hx + T.door[0], hy + T.door[1]], spur: null });
          x += T.w + 1 + (hash32(vs, 32, x) % 2);
        } else x++;
      }
    } else {
      // beside the road, west and east in turn; the spur runs along the 2 rows under the house to the road
      for (const side of [-1, 1]) {
        let y = s.y + 1;
        while (y < s.y + s.h - 2 && houses.length < target) {
          const t = hash32(vs, 33, s.x, y, side + 2) % tpl.length, T = tpl[t];
          const gap = 1 + (hash32(vs, 34, y, side + 2) % 2);
          const hx = side < 0 ? s.x - gap - T.w : s.x + 2 + gap, hy = y;
          const dx = hx + T.door[0], fy = hy + T.h;     // the door's front cell (dx, fy); the spur's rows fy, fy + 1
          const sx0 = side < 0 ? dx : s.x + 2, sx1 = side < 0 ? s.x - 1 : dx + 1;
          if (fy + 1 <= s.y + s.h - 1 && gapFree(hx, hy, T.w, T.h) && free(sx0, fy, sx1 - sx0 + 1, 2)
            && free(hx - 1, fy, T.w + 2, 1) && (side < 0 ? at(sx0 - 1, fy) !== K.PATH : at(sx1 + 1, fy) !== K.PATH)) {
            fill(hx, hy, T.w, T.h, K.HOUSE);
            const sp = path(sx0, fy, sx1 - sx0 + 1, 2);
            houses.push({ t, x: hx, y: hy, w: T.w, h: T.h, door: [dx, hy + T.door[1]], spur: sp });
            y += T.h + 3;
          } else y++;
        }
      }
    }
  }
  if (houses.length < PLAN_HOUSES[0]) return null;
  // reading order of the houses (top to bottom, then left to right) gives their ids
  houses.forEach((h, i) => { h.id = i; h.key = h.y * 256 + h.x; });
  houses.sort(byNum('key'));
  houses.forEach((h, i) => { h.id = i; delete h.key; });

  // job sites (5.4): one profession per house (about 1 in 8 none), outdoor ones beside the house on its bottom row
  // or beside its spur's start, indoor ones in its interior; interiors and beds per house
  for (const h of houses) {
    const hv = hash32(vs, 40, h.id);
    h.room = hv % INTERIORS.length;
    h.beds = 1 + ((hv >>> 8) & 1);
    let prof = (hv >>> 12) % 8 === 0 ? -1 : (hv >>> 16) % PROFS.length;
    h.job = null; h.jobIn = false;
    if (prof >= 0 && INDOOR.has(PROFS[prof])) h.jobIn = true;
    else if (prof >= 0) {
      const by = h.y + h.h - 1, fy = h.y + h.h;
      const cands = h.spur
        ? [[h.door[0] + (h.spur[0] < h.door[0] ? 2 : -1), fy], [h.x - 1, by], [h.x + h.w, by]]
        : [[h.x - 1, by], [h.x + h.w, by]];
      const first = (hv >>> 20) & 1;
      for (let k = 0; k < cands.length; k++) {
        const [jx, jy] = cands[(k + first) % cands.length];
        if (at(jx, jy) !== K.NONE) continue;
        // never shut a neighbour in: no path cell beside it may lose its only way (a job site never touches a door's front)
        let byFront = false;
        for (const g of houses) if (Math.abs(g.door[0] - jx) + Math.abs(g.door[1] + 1 - jy) <= 1) byFront = true;
        if (byFront) continue;
        occ[jy * S + jx] = K.JOB; h.job = [jx, jy];
        break;
      }
      if (!h.job) prof = -1;
    }
    h.prof = prof;
  }
  const bell = houses.length >= 8 ? [c + 1, c - 3] : null;
  if (bell) occ[bell[1] * S + bell[0]] = K.BELL;

  // farms and the pen: in hashed order over a coarse grid of positions, one free cell around, and within 2 cells of
  // the path mask (so a road or the plaza is a step away). Rectangle tests by summed-area tables (cells taken, path
  // cells), so each candidate costs O(1), and against the farms placed since.
  const S1 = S + 1, taken = new Int32Array(S1 * S1), pathN = new Int32Array(S1 * S1);
  // the tables: taken (outside lo..hi, or any kind but NONE) and path cells
  const sat = (tab, path) => {
    for (let y = 0; y < S; y++) {
      let row = 0;
      const out = y < lo || y > hi, r0 = y * S, t0 = (y + 1) * S1, u0 = y * S1;
      for (let x = 0; x < S; x++) {
        const k = occ[r0 + x];
        row += path ? (k === K.PATH ? 1 : 0) : (out || x < lo || x > hi || k !== K.NONE ? 1 : 0);
        tab[t0 + x + 1] = tab[u0 + x + 1] + row;
      }
    }
  };
  const sum = (tab, x, y, w, h) => {
    const ax = x < 0 ? 0 : x, ay = y < 0 ? 0 : y, bx = x + w > S ? S : x + w, by = y + h > S ? S : y + h;
    if (bx <= ax || by <= ay) return 0;
    return tab[by * S1 + bx] - tab[ay * S1 + bx] - tab[by * S1 + ax] + tab[ay * S1 + ax];
  };
  const reTaken = () => sat(taken, false);
  sat(pathN, true);
  reTaken();
  const placedR = [];   // farms placed since the table was built: [x, y, w, h]
  const fits = (x, y, w, h) => x - 1 >= lo && y - 1 >= lo && x + w <= hi && y + h <= hi
    && sum(taken, x - 1, y - 1, w + 2, h + 2) === 0 && sum(pathN, x - 2, y - 2, w + 4, h + 4) > 0
    && placedR.every(([px, py, pw, ph]) => x + w + 1 <= px || px + pw + 1 <= x || y + h + 1 <= py || py + ph + 1 <= y);
  const cands = (w, h) => {
    const out = [];
    for (let y = lo + 1; y <= hi - 1; y += 2) for (let x = lo + 1; x <= hi - 1; x += 2) if (fits(x, y, w, h)) out.push({ id: out.length, x, y, key: hash32(vs, 50, x, y) });
    out.sort(byNum('key'));
    return out;
  };
  const farms = [], pens = [];
  const nFarm = 1 + (hash32(vs, 51) % 3), nPen = hash32(vs, 52) % 3 === 0 ? 0 : 1;
  for (const p of cands(FARM.w, FARM.h)) {
    if (farms.length >= nFarm) break;
    if (!fits(p.x, p.y, FARM.w, FARM.h)) continue;
    fill(p.x, p.y, FARM.w, FARM.h, K.FARM); fill(p.x, p.y + FARM.water, FARM.w, 1, K.FARMW);
    placedR.push([p.x, p.y, FARM.w, FARM.h]);
    // a farm's rows: each farmland row's replant phase (ticks before the world's first tick), 2.12
    const rows = [];
    for (let r = 0; r < FARM.h; r++) if (r !== FARM.water) rows.push(hash32(vs, 53, farms.length, r) % 24000);
    farms.push({ x: p.x, y: p.y, w: FARM.w, h: FARM.h, water: FARM.water, rows });
  }
  for (const p of nPen ? cands(PEN, PEN) : []) {
    if (pens.length >= nPen) break;
    for (let k = 0; k < PEN; k++) { occ[p.y * S + p.x + k] = K.FENCE; occ[(p.y + PEN - 1) * S + p.x + k] = K.FENCE; occ[(p.y + k) * S + p.x] = K.FENCE; occ[(p.y + k) * S + p.x + PEN - 1] = K.FENCE; }
    pens.push([p.x, p.y, PEN, PEN]);
  }
  // lamp posts: every 9th cell along a segment, on a free cell beside it, never beside a door's front
  const lamps = [];
  for (const s of segs) {
    const n = s.ew ? s.w : s.h;
    for (let k = 4; k < n - 1; k += 9) {
      const cands = s.ew ? [[s.x + k, s.y + 2], [s.x + k, s.y - 1]] : [[s.x + 2, s.y + k], [s.x - 1, s.y + k]];
      for (const [lx, ly] of cands) {
        if (at(lx, ly) !== K.NONE) continue;
        let bad = false;
        for (let dy = -1; dy <= 1 && !bad; dy++) for (let dx = -1; dx <= 1; dx++) { const q = at(lx + dx, ly + dy); if (q === K.HOUSE || q === K.JOB || q === K.FENCE || q === K.FARM || q === K.FARMW) { bad = true; break; } }
        if (bad) continue;
        occ[ly * S + lx] = K.LAMP; lamps.push([lx, ly]);
        break;
      }
    }
  }
  const g = (p) => [p[0] + x0, p[1] + y0];
  return {
    plaza: [c - 4 + x0, c - 4 + y0, 9, 9],
    paths: rects.map((r) => [r[0] + x0, r[1] + y0, r[2], r[3]]),
    houses: houses.map((h) => ({ id: h.id, t: h.t, x: h.x + x0, y: h.y + y0, w: h.w, h: h.h, door: g(h.door), room: h.room, beds: h.beds,
      prof: h.prof, job: h.job ? g(h.job) : null, jobIn: h.jobIn })),
    well: g(well), bell: bell ? g(bell) : null,
    farms: farms.map((f) => ({ x: f.x + x0, y: f.y + y0, w: f.w, h: f.h, water: f.water, rows: f.rows })),
    pens: pens.map((p) => [p[0] + x0, p[1] + y0, p[2], p[3]]), lamps: lamps.map(g),
  };
}

// ---------------------------------------------------------------- raster (for the painter, the runtime and the checks)
// kind per cell of the bounds; aux: a house cell's house id * 64 + its template cell, a job site's profession
export function villageRaster(v) {
  if (v._raster) return v._raster;
  const S = v.w, x0 = v.x0, y0 = v.y0, kind = new Uint8Array(S * S), aux = new Int16Array(S * S).fill(-1);
  const set = (x, y, k, a = -1) => { const lx = x - x0, ly = y - y0; if (lx < 0 || ly < 0 || lx >= S || ly >= S) return; kind[ly * S + lx] = k; aux[ly * S + lx] = a; };
  for (const [x, y, w, h] of v.paths) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, K.PATH);
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) set(v.well[0] + dx, v.well[1] + dy, dx === 1 && dy === 1 ? K.WELLW : K.WELL);
  if (v.bell) set(v.bell[0], v.bell[1], K.BELL);
  for (const h of v.houses) {
    for (let yy = 0; yy < h.h; yy++) for (let xx = 0; xx < h.w; xx++) set(h.x + xx, h.y + yy, K.HOUSE, h.id * 64 + yy * h.w + xx);
    if (h.job) set(h.job[0], h.job[1], K.JOB, h.prof);
  }
  for (const f of v.farms) for (let yy = 0; yy < f.h; yy++) for (let xx = 0; xx < f.w; xx++) set(f.x + xx, f.y + yy, yy === f.water ? K.FARMW : K.FARM, yy);
  for (const [x, y, w, h] of v.pens) for (let k = 0; k < w; k++) { set(x + k, y, K.FENCE); set(x + k, y + h - 1, K.FENCE); set(x, y + k, K.FENCE); set(x + w - 1, y + k, K.FENCE); }
  for (const [x, y] of v.lamps) set(x, y, K.LAMP);
  const r = { S, x0, y0, kind, aux };
  Object.defineProperty(v, '_raster', { value: r, enumerable: false });   // never in the plan's JSON or hash
  return r;
}
export const onPath = (k) => ON_PATH[k] === 1;
export const walkable = (k) => WALK[k] === 1;

// ---------------------------------------------------------------- checks (5.1, 4.7 item 9)
// opts.blocked(x, y): an extra test from painted output (water, rock, a tree), so the tests can check painted cells
export function checkVillage(v, opts = {}) {
  const fails = [];
  const { S, x0, y0, kind } = villageRaster(v);
  const kAt = (x, y) => { const lx = x - x0, ly = y - y0; return lx < 0 || ly < 0 || lx >= S || ly >= S ? -1 : kind[ly * S + lx]; };
  const blocked = opts.blocked || (() => false);
  if (v.houses.length < PLAN_HOUSES[0] || v.houses.length > PLAN_HOUSES[1]) fails.push(`houses ${v.houses.length}`);
  // the path mask: one 4-connected component containing the plaza; 2 wide everywhere (every cell in a 2 x 2 of path)
  const isP = (x, y) => { const k = kAt(x, y); return k >= 0 && onPath(k); };
  const seen = new Uint8Array(S * S);
  const [px, py] = v.plaza;
  const stack = [[px + 4, py + 4]];
  seen[(py + 4 - y0) * S + px + 4 - x0] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!isP(nx, ny) || seen[(ny - y0) * S + nx - x0]) continue;
      seen[(ny - y0) * S + nx - x0] = 1; stack.push([nx, ny]);
    }
  }
  let total = 0, inComp = 0, thin = 0;
  for (let ly = 0; ly < S; ly++) for (let lx = 0; lx < S; lx++) {
    if (!onPath(kind[ly * S + lx])) continue;
    total++; if (seen[ly * S + lx]) inComp++;
    const x = lx + x0, y = ly + y0;
    let wide = false;
    for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) if (isP(x + ox, y + oy) && isP(x + ox + 1, y + oy) && isP(x + ox, y + oy + 1) && isP(x + ox + 1, y + oy + 1)) wide = true;
    if (!wide) thin++;
  }
  if (inComp !== total) fails.push(`path mask in ${total - inComp} cells outside the plaza's component`);
  if (thin) fails.push(`path mask under 2 wide at ${thin} cells`);
  // every door's front cell is path, beside another path cell (2 wide), and walks over path to the plaza
  for (const h of v.houses) {
    const fx = h.door[0], fy = h.door[1] + 1;
    if (!isP(fx, fy) || !(isP(fx - 1, fy) || isP(fx + 1, fy))) fails.push(`house ${h.id}: the door's front is not on a 2-wide path`);
    else if (!seen[(fy - y0) * S + fx - x0]) fails.push(`house ${h.id}: the door's path does not reach the plaza`);
    if (kAt(h.door[0], h.door[1]) !== K.HOUSE) fails.push(`house ${h.id}: door off its house`);
  }
  // every walkable path cell is clear in the painted world, and a walk over walkable cells reaches the plaza
  const wseen = new Uint8Array(S * S);
  const wq = [[px + 4, py + 6]];
  const walkAt = (x, y) => { const k = kAt(x, y); return k >= 0 && walkable(k) && !blocked(x, y); };
  if (walkAt(px + 4, py + 6)) wseen[(py + 6 - y0) * S + px + 4 - x0] = 1;
  while (wq.length) {
    const [x, y] = wq.pop();
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!walkAt(nx, ny) || wseen[(ny - y0) * S + nx - x0]) continue;
      wseen[(ny - y0) * S + nx - x0] = 1; wq.push([nx, ny]);
    }
  }
  for (const h of v.houses) {
    const fx = h.door[0], fy = h.door[1] + 1;
    if (!(fx - x0 >= 0 && fx - x0 < S && fy - y0 < S && wseen[(fy - y0) * S + fx - x0])) fails.push(`house ${h.id}: no walk from the door to the plaza`);
  }
  // job sites: beside their own house's footprint (4-neighbour), or inside its interior
  for (const h of v.houses) {
    if (!h.job) continue;
    const [jx, jy] = h.job;
    const adj = (jx >= h.x - 1 && jx <= h.x + h.w && jy >= h.y && jy < h.y + h.h) || (jy >= h.y - 1 && jy <= h.y + h.h && jx >= h.x && jx < h.x + h.w);
    if (!adj) fails.push(`house ${h.id}: job site off its house`);
    if (kAt(jx, jy) !== K.JOB) fails.push(`house ${h.id}: job site overwritten`);
  }
  // nothing on the path mask but the plaza's well and bell; nothing built over water, rock or trees (painted)
  for (let ly = 0; ly < S; ly++) for (let lx = 0; lx < S; lx++) {
    const k = kind[ly * S + lx];
    if (k !== K.NONE && k !== K.FARMW && k !== K.WELLW && blocked(lx + x0, ly + y0)) { fails.push(`kind ${k} on blocked ground at ${lx + x0},${ly + y0}`); break; }
  }
  // the well: a 3 x 3 ring round one water cell, on the plaza
  const [wx, wy] = v.well;
  if (!(wx >= px && wy >= py && wx + 3 <= px + 9 && wy + 3 <= py + 9)) fails.push('well off the plaza');
  if (kAt(wx + 1, wy + 1) !== K.WELLW) fails.push('well without water');
  if ((v.houses.length >= 8) !== !!v.bell) fails.push('bell rule');
  return fails;
}

// ---------------------------------------------------------------- painting (chunk.js, after the decorations)
// The village's cells inside the painter's window: the path mask in the style's recolour of quarter set C (its blob
// codes from the mask alone, so a chunk and a larger region paint the same cells: the seam test holds), the house
// templates' entries, the well's water and the farms' water rows (FireRed's plain pond water), and decoration codes
// for the well's ring, the bell, farmland, fences, lamps and outdoor job sites (D: chunk.js's codes by name).
// win: { X0, Y0, W, H } (overworld-local), out: the window's tile, gr and deco arrays; clearTall(o) mows a cell;
// groundKind(o) is 'grass', 'sand' or 'snow' (the painted class of the cell).
export const VILLAGE_DECOS = Object.freeze(['cobblestone', 'sandstone', 'farmland', 'oak_fence', 'torch', 'bell', ...JOB_BLOCK]);
export function paintVillage(v, T, win, out, D, blobBits, clearTall = null, groundKind = null) {
  const V = T.villages;
  if (!V) return;
  const R = villageRaster(v), S = R.S, kind = R.kind, aux = R.aux;
  const st = V.styles[v.style] || V.styles.plains, set = T.sets.C[st.path] || T.sets.C.path;
  const ext = V.exteriors[v.style] || V.exteriors.plains;
  const kAt = (x, y) => { const lx = x - v.x0, ly = y - v.y0; return lx < 0 || ly < 0 || lx >= S || ly >= S ? 0 : kind[ly * S + lx]; };
  const inPath = (x, y) => ON_PATH[kAt(x, y)] === 1;
  const xa = Math.max(v.x0, win.X0), xb = Math.min(v.x0 + S, win.X0 + win.W), ya = Math.max(v.y0, win.Y0), yb = Math.min(v.y0 + S, win.Y0 + win.H);
  const { tile, gr, deco } = out;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const q = (y - v.y0) * S + x - v.x0, k = kind[q];
      const o = (y - win.Y0) * win.W + x - win.X0;
      // a village's open ground is mown (FireRed's towns have no tall grass between their houses)
      if (clearTall) clearTall(o);
      if (k === K.NONE) continue;
      deco[o] = 0;
      switch (k) {
        case K.PATH: case K.WELL: case K.BELL: {
          const code = T.lut[blobBits(inPath, x, y)];
          tile[o] = code === 0 || !set.ov ? set.home[code] : set.ov[code];
          if (k === K.WELL) deco[o] = D[st.well.toUpperCase()] || D.COBBLESTONE;
          else if (k === K.BELL) deco[o] = D.BELL;
          break;
        }
        case K.WELLW: case K.FARMW: tile[o] = T.pondTile; break;
        case K.HOUSE: {
          // the house cell drawn on the cell's own ground (grass, sand or snow), so a village across a biome edge fits
          const a = aux[q], h = v.houses[a >> 6], cs = ext[Math.min(h.t, ext.length - 1)].cells;
          tile[o] = (Array.isArray(cs) ? cs : cs[groundKind ? groundKind(o) : 'grass'] || cs.grass)[a & 63];
          break;
        }
        case K.FARM: tile[o] = gr[o]; deco[o] = D.FARMLAND; break;
        case K.FENCE: tile[o] = gr[o]; deco[o] = D.OAK_FENCE; break;
        case K.LAMP: tile[o] = gr[o]; deco[o] = D.TORCH; break;
        case K.JOB: tile[o] = gr[o]; deco[o] = D[JOB_BLOCK[aux[q]].toUpperCase()] || 0; break;
        default: break;
      }
    }
  }
}
