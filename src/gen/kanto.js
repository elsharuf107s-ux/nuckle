// Kanto inside a generated world (design 3.12). Stage 3a placed Kanto's footprint (its zone 0 and 1 cells) as fixed
// context. Stage 6a adds what the generator needs to meet Kanto well: the placement on the island's south-west coast
// (chosen per seed by the plan check, plan.js), Kanto's boundary classes (tree, sea, rock, other) and their distance
// fields (the influence field), the holes (zone 2 regions inside the box that do not reach its edge), the seam cells
// (zone 1 border fill within 3 cells of a generated cell, re-tiled by the painter) and Kanto's own tree slots (so the
// tree lattice runs on across the seam). Everything here is a pure function of Classic's arrays and the seed.
import { hash32, fnv1a } from './hash.js';
import { edgeDistW } from './climate.js';
import { treeTileFor } from './trees.js';
import { byNum } from './order.js';

export const KANTO_W = 408, KANTO_H = 400;
// placement candidates (overworld-local cells, multiples of 32 so Kanto's block is aligned to the data chunks).
// Stage 6a tuned them against the plan check: Kanto's south sea must face the world's ocean (its box bottom 80 to
// 112 cells from the overworld's edge, where the coast lies 60 to 120 cells in; 48 for the last resort) and Route
// 21's sea its west coast.
export const KX = Object.freeze([64, 96]);
export const KY = Object.freeze([1088, 1120]);
// tried last, when none of the four passes (the coast lies far in): Kanto's box 48 cells from the edge always meets it
export const KY_LAST = 1152;

// Kanto's boundary classes (3.12)
export const K_VOID = 0, K_OTHER = 1, K_TREE = 2, K_SEA = 3, K_ROCK = 4;
export const K_NAMES = ['void', 'other', 'tree', 'sea', 'rock'];
export function matClass(mat) {
  if (mat === 'tree') return K_TREE;
  if (mat === 'water' || mat === 'water_rock') return K_SEA;
  if (mat === 'rock' || mat === 'boulder' || (typeof mat === 'string' && mat.endsWith('_ore'))) return K_ROCK;
  return K_OTHER;
}
// the class of every world.json entry ([mid, pair, beh, col, mat, ...]), the input `kantoMat`; (6b) bit K_WALK is set
// for an entry Steve walks on (collision 0), which the openings' search reads (the class is the low 3 bits)
export const K_WALK = 8;
export function kantoMatTable(entries) {
  const t = new Uint8Array(entries.length);
  for (let i = 0; i < entries.length; i++) t[i] = matClass(entries[i][4]) | (entries[i][3] === 0 ? K_WALK : 0);
  return t;
}

// The placement candidates in this seed's order (hash32 of the seed): the plan takes the first that passes its check.
export function kantoCandidates(seed) {
  const h = hash32(seed | 0, fnv1a('kanto.place'));
  const out = [];
  for (let k = 0; k < KX.length * KY.length; k++) {
    const j = (h + k) % (KX.length * KY.length);
    out.push({ kx: KX[j % KX.length], ky: KY[Math.floor(j / KX.length)] });
  }
  for (let k = 0; k < KX.length; k++) out.push({ kx: KX[(h + k) % KX.length], ky: KY_LAST });
  return out;
}
// the first candidate (Kanto's placement when nothing else is known)
export function kantoPlacement(seed) { return kantoCandidates(seed)[0]; }

export const PAD = 64;         // the distance fields reach this far outside Kanto's box
export const SEAM = 3;         // zone 1 cells within this many cells (Chebyshev) of a generated cell are re-tiled
const FAR = 255;

// The context of Kanto's block (seed-independent; cached per input arrays):
//   kc[i]    class of a Kanto-local cell (K_VOID for zone 2)
//   seam[i]  1: a zone 1 cell within SEAM cells of a zone 2 cell or of the box's outside (re-tiled by the painter)
//   hole[i]  1: a zone 2 cell whose region does not reach the box's edge (a hole, 3.12)
//   slot[i]  1: a Kanto tree slot (the crown's left base piece, General mid 28 or 30, on even x and y)
//   dist[c]  per class (tree, sea, rock, other), the chamfer distance in cells (capped at 255) from the class's
//            boundary cells (Kanto cells beside a void cell), on the box grown by PAD on every side
//   out      the boundary cells of each class that face the outside (a void region reaching the box edge), for the
//            plan's sea check
let CACHE = null;
export function kantoContext(zone, grid, mat, zoneW = KANTO_W) {
  if (CACHE && CACHE.zone === zone && CACHE.grid === grid && CACHE.mat === mat) return CACHE.ctx;
  const W = KANTO_W, H = KANTO_H, N = W * H;
  const kc = new Uint8Array(N), z = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, zz = zone[y * zoneW + x];
      z[i] = zz;
      kc[i] = zz >= 2 ? K_VOID : mat ? (mat[grid[y * zoneW + x]] & 7) || K_OTHER : K_OTHER;
    }
  }
  const voidAt = (x, y) => x < 0 || y < 0 || x >= W || y >= H || z[y * W + x] >= 2;
  // holes: 4-connected zone 2 regions that never touch the box's edge
  const hole = new Uint8Array(N), seen = new Uint8Array(N), stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (seen[s] || z[s] < 2) continue;
    let sp = 0, edge = false;
    const members = [];
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const q = stack[--sp], qx = q % W, qy = (q - qx) / W;
      members.push(q);
      if (qx === 0 || qy === 0 || qx === W - 1 || qy === H - 1) edge = true;
      if (qx > 0 && !seen[q - 1] && z[q - 1] >= 2) { seen[q - 1] = 1; stack[sp++] = q - 1; }
      if (qx < W - 1 && !seen[q + 1] && z[q + 1] >= 2) { seen[q + 1] = 1; stack[sp++] = q + 1; }
      if (qy > 0 && !seen[q - W] && z[q - W] >= 2) { seen[q - W] = 1; stack[sp++] = q - W; }
      if (qy < H - 1 && !seen[q + W] && z[q + W] >= 2) { seen[q + W] = 1; stack[sp++] = q + W; }
    }
    if (!edge) for (const q of members) hole[q] = 1;
  }
  // seam cells: zone 1 cells under the void mask dilated by SEAM cells (Chebyshev: a row pass, then a column pass)
  const seam = new Uint8Array(N), rowD = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let dx = -SEAM; dx <= SEAM && !v; dx++) if (voidAt(x + dx, y)) v = 1;
      rowD[y * W + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (z[y * W + x] !== 1) continue;
      let v = 0;
      for (let dy = -SEAM; dy <= SEAM && !v; dy++) { const yy = y + dy; if (yy < 0 || yy >= H || rowD[yy * W + x]) v = 1; }
      seam[y * W + x] = v;
    }
  }
  // tree slots
  const slot = new Uint8Array(N);
  if (grid) {
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const t = grid[y * zoneW + x];
      if (z[y * W + x] < 2 && (t === 28 || t === 30)) slot[y * W + x] = 1;
    }
  }
  // boundary cells per class, and the chamfer distance fields (3-4 weights, in thirds of a cell)
  const PW = W + 2 * PAD, PH = H + 2 * PAD, PN = PW * PH;
  const classes = [K_TREE, K_SEA, K_ROCK, K_OTHER];
  const dist = [], out = [];
  const ext = new Uint8Array(N);   // 1: a void cell of a region that reaches the edge
  for (let i = 0; i < N; i++) ext[i] = z[i] >= 2 && !hole[i] ? 1 : 0;
  const extAt = (x, y) => x < 0 || y < 0 || x >= W || y >= H || ext[y * W + x] === 1;
  // boundary cells (beside a void cell; 2: beside an outside one), found once for every class
  const bnd = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!kc[i]) continue;
      let b = 0;
      for (let dy = -1; dy <= 1 && b < 2; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (voidAt(x + dx, y + dy)) { b = 1; if (extAt(x + dx, y + dy)) { b = 2; break; } }
      }
      bnd[i] = b;
    }
  }
  for (const c of classes) {
    const d = new Uint16Array(PN).fill(65535);
    const o = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (kc[i] !== c || !bnd[i]) continue;
        d[(y + PAD) * PW + x + PAD] = 0;
        if (bnd[i] === 2) o.push(x, y);
      }
    }
    // two passes of the 3-4 chamfer
    for (let y = 0; y < PH; y++) {
      for (let x = 0; x < PW; x++) {
        const p = y * PW + x;
        let v = d[p];
        if (x > 0 && d[p - 1] + 3 < v) v = d[p - 1] + 3;
        if (y > 0) {
          if (d[p - PW] + 3 < v) v = d[p - PW] + 3;
          if (x > 0 && d[p - PW - 1] + 4 < v) v = d[p - PW - 1] + 4;
          if (x < PW - 1 && d[p - PW + 1] + 4 < v) v = d[p - PW + 1] + 4;
        }
        d[p] = v;
      }
    }
    for (let y = PH - 1; y >= 0; y--) {
      for (let x = PW - 1; x >= 0; x--) {
        const p = y * PW + x;
        let v = d[p];
        if (x < PW - 1 && d[p + 1] + 3 < v) v = d[p + 1] + 3;
        if (y < PH - 1) {
          if (d[p + PW] + 3 < v) v = d[p + PW] + 3;
          if (x < PW - 1 && d[p + PW + 1] + 4 < v) v = d[p + PW + 1] + 4;
          if (x > 0 && d[p + PW - 1] + 4 < v) v = d[p + PW - 1] + 4;
        }
        d[p] = v;
      }
    }
    const d8 = new Uint8Array(PN);
    for (let p = 0; p < PN; p++) { const v = Math.floor(d[p] / 3); d8[p] = v > FAR ? FAR : v; }
    dist[c] = d8; out[c] = o;
  }
  const ctx = { W, H, PAD, PW, PH, kc, seam, hole, slot, dist, out, z };
  CACHE = { zone, grid, mat, ctx };
  return ctx;
}

// The footprint for a world: `zone` is Classic's zone array (408 wide, at least 400 rows; zone 0 and 1 are
// Kanto's own cells, 2 is void and is generated). Returns { x, y, w, h, mask, ctx } in overworld-local cells; `at`
// ({ kx, ky }) overrides the seed's first candidate (the plan's choice).
export function kantoFootprint(seed, zone, zoneW = KANTO_W, at = null, grid = null, mat = null) {
  const { kx, ky } = at || kantoPlacement(seed);
  const mask = new Uint8Array(KANTO_W * KANTO_H);
  for (let y = 0; y < KANTO_H; y++) for (let x = 0; x < KANTO_W; x++) mask[y * KANTO_W + x] = zone[y * zoneW + x] < 2 ? 1 : 0;
  const ctx = grid && mat ? kantoContext(zone, grid, mat, zoneW) : null;
  return { x: kx, y: ky, w: KANTO_W, h: KANTO_H, mask, ctx };
}

// Chebyshev distance from a cell to Kanto's bounding box (0 inside it)
export function kantoBoxDist(k, x, y) {
  const dx = x < k.x ? k.x - x : x >= k.x + k.w ? x - (k.x + k.w - 1) : 0;
  const dy = y < k.y ? k.y - y : y >= k.y + k.h ? y - (k.y + k.h - 1) : 0;
  return dx > dy ? dx : dy;
}

export function isKantoCell(k, x, y) {
  if (!k) return false;
  const lx = x - k.x, ly = y - k.y;
  return lx >= 0 && ly >= 0 && lx < k.w && ly < k.h && k.mask[ly * k.w + lx] === 1;
}

// Kanto's class at an overworld-local cell (K_VOID outside Kanto's cells)
export function kantoClassAt(k, x, y) {
  if (!k || !k.ctx) return K_VOID;
  const lx = x - k.x, ly = y - k.y;
  return lx >= 0 && ly >= 0 && lx < k.w && ly < k.h ? k.ctx.kc[ly * k.w + lx] : K_VOID;
}
export function kantoSeamAt(k, x, y) {
  if (!k || !k.ctx) return false;
  const lx = x - k.x, ly = y - k.y;
  return lx >= 0 && ly >= 0 && lx < k.w && ly < k.h && k.ctx.seam[ly * k.w + lx] === 1;
}
export function kantoSlotAt(k, x, y) {
  if (!k || !k.ctx) return false;
  const lx = x - k.x, ly = y - k.y;
  return lx >= 0 && ly >= 0 && lx < k.w && ly < k.h && k.ctx.slot[ly * k.w + lx] === 1;
}
export function kantoHoleAt(k, x, y) {
  if (!k || !k.ctx) return false;
  const lx = x - k.x, ly = y - k.y;
  return lx >= 0 && ly >= 0 && lx < k.w && ly < k.h && k.ctx.hole[ly * k.w + lx] === 1;
}
// the distance in cells from (x, y) to Kanto's boundary cells of class c (255: 255 or more, or no context)
export function kantoDist(k, c, x, y) {
  if (!k || !k.ctx) return FAR;
  const C = k.ctx, px = x - k.x + C.PAD, py = y - k.y + C.PAD;
  if (px < 0 || py < 0 || px >= C.PW || py >= C.PH) return FAR;
  return C.dist[c][py * C.PW + px];
}

// ---------------------------------------------------------------- the influence field (3.12, stage 6a)
// Near Kanto the climate fields continue Kanto's boundary classes. With d the distance to the class's boundary cells
// plus 10 cells of the 1/60 Kanto edge noise (so no contour runs parallel to Kanto's straight map edges) and
// k = 1 - smooth((d - 16) / 40):
//   sea:   C is pulled toward the ocean (Kanto's sea runs on until it meets the world's ocean or a beach)
//   tree, rock, other: C is pulled toward land (a tree wall always has land outside it, over the island falloff)
//   rock:  M is pulled toward the mountains (the rock fill continues as one mass)
// The classes mix by their weights; in a hole (3.12) the pull is total (k = 1) with an island weight added to land,
// so a hole walled by sea is a bay: Kanto's sea (weighing 1.4 times as much there) for 20 to 40 cells, a beach, then land. It is applied after the
// thresholds (makeGen sets L.kinf once they exist), so a Kanto World keeps the thresholds of its seed.
export const INF = Object.freeze({ near: 16, span: 40, noise: 10, oceanDrop: 0.25, landRise: 0.3, island: 0.6, baySea: 1.4, seaSpan: 64, edgeFade: 40, treeLand: 4 });
export function makeInfluence(k, L, th, fbm, smooth, clamp) {
  if (!k || !k.ctx) return null;
  const C = k.ctx, ocean = th.cOcean - INF.oceanDrop, land = th.cOcean + INF.landRise;
  const mT = (th.mMount + th.mCore) / 2;
  const x0 = k.x - C.PAD, y0 = k.y - C.PAD, x1 = x0 + C.PW, y1 = y0 + C.PH;
  const kf = (d, n) => (d >= FAR ? 0 : 1 - smooth(clamp((d + n - INF.near) / INF.span, 0, 1)));
  // the sea's pull reaches further (Kanto's south sea must meet the world's ocean across the coastal land, 3a's note)
  const kfs = (d, n) => (d >= FAR ? 0 : 1 - smooth(clamp((d + n - INF.near) / INF.seaSpan, 0, 1)));
  const at = (px, py) => (py - y0) * C.PW + (px - x0);
  const inside = (px, py) => px >= x0 && py >= y0 && px < x1 && py < y1;
  const holeAt = (px, py) => { const lx = px - k.x, ly = py - k.y; return lx >= 0 && ly >= 0 && lx < k.w && ly < k.h && C.hole[ly * k.w + lx] === 1; };
  return {
    C(px, py, o) {
      if (!inside(px, py)) return;
      const p = at(px, py), n = INF.noise * fbm(L.kedge, px, py);
      // a tree wall keeps land outside it: the sea's pull fades within 4 to 16 cells of Kanto's trees
      const dt = C.dist[K_TREE][p];
      const ws = kfs(C.dist[K_SEA][p], n) * (dt >= FAR ? 1 : smooth(clamp((dt + n * 0.4 - INF.treeLand) / 12, 0, 1)));
      // the land pull fades out 40 to 70 cells (wobbled) from the overworld's edge, so the coast there is the island
      // falloff's wobbled one, never the edge guard's straight line
      const ef = smooth(clamp((edgeDistW(L, px, py) - INF.edgeFade) / 30, 0, 1));
      const wl0 = ef * Math.max(kf(C.dist[K_TREE][p], n), kf(C.dist[K_ROCK][p], n), kf(C.dist[K_OTHER][p], n));
      const hole = holeAt(px, py);
      // in a hole the sea weighs a little more (Kanto's sea runs on into the bay) and the island adds to land
      const wsh = hole ? INF.baySea * ws : ws, wl = hole ? wl0 + INF.island : wl0;
      const a = hole ? 1 : Math.max(ws, wl0);
      if (!(a > 0) || !(wsh + wl > 0)) return;
      const target = (wsh * ocean + wl * land) / (wsh + wl);
      o.C += a * (target - o.C);
    },
    M(px, py, o) {
      if (!inside(px, py)) return;
      const p = at(px, py), d = C.dist[K_ROCK][p];
      if (d >= FAR) return;
      const w = kf(d, INF.noise * fbm(L.kedge, px, py));
      if (w > 0) o.M += w * (mT - o.M);
    },
    tree(px, py) {
      // the distance to Kanto's tree boundary with the edge noise (the painter's forest rules)
      if (!inside(px, py)) return FAR;
      const d = C.dist[K_TREE][at(px, py)];
      return d >= FAR ? FAR : d + INF.noise * fbm(L.kedge, px, py);
    },
    seaD(px, py) { return inside(px, py) ? C.dist[K_SEA][at(px, py)] : FAR; },
  };
}

// ---------------------------------------------------------------- openings (3.12, stage 6b)
// Paths out of Kanto through its tree walls and rock fill. Candidates are a pure function of Classic's arrays
// (seed-independent, cached on the context; computed here rather than in build_terrain.py, so terrain.json is
// unchanged): a band 4 cells wide of tree or rock cells beside the void, straight inward through Kanto's trees and rock
// until the band reaches 4 walkable cells of a map (zone 0) within `reach` cells. The band's rock cells are cut (bare
// ground, Classic's own ground under them) and the trees on it are taken off Kanto's lattice (`gone`, slots); the
// painter re-tiles the cells around the cut (FireRed's tree rule, trees.js, and its rock pieces), so the cut has
// proper edges. A candidate is dropped when the lattice does not explain Classic's trees where the cut changes them
// (the identity test), when any changed cell or a cell beside one is water, or when the cut does not connect the void
// to a walkable map cell. Kept outward candidates are at least `spacing` cells apart (best first: the shortest cut),
// plus the best one into every hole larger than `holeMin` cells.
//   cand: { id, kind: 'outer' | 'hole', dir, n: [dx, dy], out: [x, y] (the void cell the cut opens on), in: [x, y]
//          (the map cell it reaches), cut (cells crossed), gone: [lx, cy, ...] (slots taken off), rock: [x, y, ...]
//          (rock cells cut), cells: [x, y, ...] (every Kanto cell the painter re-tiles: the trees whose piece changes
//          and those near the void beside them, the rock within 2 cells of the cut, the cut itself),
//          corr: [x0, y0, w, h] (the corridor: `corridor` cells long and 6 wide, from the out cell outward) }
// All coordinates are Kanto-local.
// (corridorMax: the plan lengthens a corridor that would end in generated rock, plan.js planOpenings)
export const OPEN = Object.freeze({ reach: 18, band: 4, spacing: 48, holeMin: 400, corridor: 40, corridorMax: 128, keep: 8, margin: 3 });
const ODIRS = [[0, -1, 'N'], [1, 0, 'E'], [0, 1, 'S'], [-1, 0, 'W']];
export function kantoOpeningCands(ctx, grid, mat) {
  if (ctx.openCands) return ctx.openCands;
  const W = ctx.W, H = ctx.H, N = W * H, z = ctx.z, kc = ctx.kc, slot = ctx.slot, hole = ctx.hole, BW = OPEN.band;
  // hole regions (4-connected) and their sizes
  const hid = new Int32Array(N).fill(-1), hsize = [], st = [];
  for (let s = 0; s < N; s++) {
    if (!hole[s] || hid[s] >= 0) continue;
    const id = hsize.length;
    let n = 0;
    hid[s] = id; st.push(s);
    while (st.length) {
      const q = st.pop(), qx = q % W;
      n++;
      for (const r of [qx > 0 ? q - 1 : -1, qx < W - 1 ? q + 1 : -1, q - W, q + W]) if (r >= 0 && r < N && hole[r] && hid[r] < 0) { hid[r] = id; st.push(r); }
    }
    hsize.push(n);
  }
  const isK = (x, y) => x >= 0 && y >= 0 && x < W && y < H && z[y * W + x] < 2;
  // 0 a Kanto cell, 1 outside (a void region reaching the box's edge, or beyond the box), 2 + hole id a hole's cell
  const vk = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 1 : z[y * W + x] < 2 ? 0 : hid[y * W + x] >= 0 ? 2 + hid[y * W + x] : 1);
  const tree = (x, y) => isK(x, y) && kc[y * W + x] === K_TREE;
  const rock = (x, y) => isK(x, y) && kc[y * W + x] === K_ROCK;
  // per cell: 1 tree or rock, 2 a walkable map cell (zone 0, class other, collision 0)
  const sw = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (z[i] >= 2) continue;
    if (kc[i] === K_TREE || kc[i] === K_ROCK) sw[i] = 1;
    else if (z[i] === 0 && (mat[grid[i]] & 7) === K_OTHER && (mat[grid[i]] & K_WALK) !== 0) sw[i] = 2;
  }
  const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && sw[y * W + x] === 1;
  const walk = (x, y) => x >= 0 && y >= 0 && x < W && y < H && sw[y * W + x] === 2;
  const S0 = (a, b) => a >= 0 && b >= 0 && a < W && b < H && slot[b * W + a] === 1;
  // within 2 cells (Chebyshev) of the void or the box's edge
  const nv2 = new Uint8Array(N), row2 = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (let a = -2; a <= 2; a++) if (!isK(x + a, y)) { v = 1; break; }
    row2[y * W + x] = v;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (let b = -2; b <= 2; b++) if (y + b < 0 || y + b >= H || row2[(y + b) * W + x]) { v = 1; break; }
    nv2[y * W + x] = v;
  }
  const nearVoid = (x, y) => nv2[y * W + x] === 1;
  const all = [];
  // band: the cut's cells (Kanto-local); edge: the void cells it opens on (in the band's order)
  const tryCand = (dir, dx, dy, band, edge, cross) => {
    const inBand = new Set(band.map(([a, b]) => b * W + a));
    // the slots whose crown covers a tree cell of the band, and the band's rock
    const removed = [], had = new Set(), rcut = [];
    for (const [a, b] of band) {
      if (rock(a, b)) { rcut.push(a, b); continue; }
      if (!tree(a, b)) continue;
      const lx = a & ~1;
      for (const cy of [b - 1, b, b + 1]) if (!(cy & 1) && S0(lx, cy) && !had.has(cy * W + lx)) { had.add(cy * W + lx); removed.push([lx, cy]); }
    }
    if (!removed.length && !rcut.length) return null;
    const rm = new Set(removed.map(([a, b]) => b * W + a));
    const S1 = (a, b) => S0(a, b) && !rm.has(b * W + a);
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (const [a, b] of band) { x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b); }
    for (const [a, b] of removed) { x0 = Math.min(x0, a); x1 = Math.max(x1, a + 1); y0 = Math.min(y0, b - 1); y1 = Math.max(y1, b + 1); }
    const M = OPEN.margin;
    x0 = Math.max(0, x0 - M); y0 = Math.max(0, y0 - M); x1 = Math.min(W - 1, x1 + M); y1 = Math.min(H - 1, y1 + M);
    const cells = [], cleared = new Set(), changed = [];
    const rset = new Set();
    for (let t = 0; t < rcut.length; t += 2) { rset.add(rcut[t + 1] * W + rcut[t]); cleared.add(rcut[t + 1] * W + rcut[t]); }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (tree(x, y)) {
          const left = (x & 1) === 0, lx = left ? x : x - 1;
          const o = treeTileFor(S0, lx, y, left), n = treeTileFor(S1, lx, y, left), nv = nearVoid(x, y);
          if (n === o) { if (nv && removed.length) cells.push(x, y); continue; }
          // where the cut changes a piece, the lattice must explain Classic's tree (within 2 cells of the void,
          // Kanto's crowns run on into generated cells the painter's lattice completes, so those are not compared)
          if (o !== grid[y * W + x] && !nv) return null;
          cells.push(x, y); changed.push(x, y);
          if (n < 0) cleared.add(y * W + x);
        } else if (rock(x, y) && rset.size) {
          // rock within 2 cells of the cut is re-tiled (the painter's 5 x 5 rock rule), the cut's own rock is bare
          let near = false;
          for (let b = -2; b <= 2 && !near; b++) for (let a = -2; a <= 2; a++) if (rset.has((y + b) * W + x + a)) { near = true; break; }
          if (near) { cells.push(x, y); changed.push(x, y); }
        }
      }
    }
    if (!cleared.size) return null;
    // no water among or beside the changed cells
    for (let p = 0; p < changed.length; p += 2) {
      for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) {
        const ax = changed[p] + xx, ay = changed[p + 1] + yy;
        if (isK(ax, ay) && kc[ay * W + ax] === K_SEA) return null;
      }
    }
    // the cut connects the void to a walkable map cell: a breadth-first search over cleared and walkable Kanto cells
    // inside the window, from the edge's void cells
    const seen = new Set(), q = [];
    for (const [a, b] of edge) { seen.add(b * W + a); q.push([a, b]); }
    let found = null;
    for (let h = 0; h < q.length && !found; h++) {
      const [a, b] = q[h];
      for (const [ex, ey] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = a + ex, ny = b + ey, key = ny * W + nx;
        if (nx < x0 || ny < y0 || nx > x1 || ny > y1 || seen.has(key) || !isK(nx, ny)) continue;
        if (walk(nx, ny) && !inBand.has(key) && !cleared.has(key)) { found = [nx, ny]; break; }
        if (!cleared.has(key) && !walk(nx, ny)) continue;
        seen.add(key); q.push([nx, ny]);
      }
    }
    if (!found) return null;
    const kind = vk(edge[0][0], edge[0][1]);
    const mid = edge[edge.length >> 1], L = OPEN.corridor;
    // the corridor: 6 cells wide, centred on the band (4 wide), `corridor` cells outward from the edge
    const corr = dx === 0 ? [edge[0][0] - 1, dy < 0 ? mid[1] - L + 1 : mid[1], BW + 2, L] : [dx < 0 ? mid[0] - L + 1 : mid[0], edge[0][1] - 1, L, BW + 2];
    return { kind: kind === 1 ? 'outer' : 'hole', hole: kind >= 2 ? kind - 2 : -1, dir, n: [dx, dy], out: [mid[0], mid[1]], in: found,
      cut: cross, gone: removed.flat(), rock: rcut, cells, corr };
  };
  for (const [dx, dy, dir] of ODIRS) {
    // the band runs across the march: columns x .. x + 3 (north, south) or rows y .. y + 3 (east, west), x or y even
    const px = dy !== 0 ? 1 : 0, py = dx !== 0 ? 1 : 0;
    for (let a = 0; a + BW <= (dy !== 0 ? W : H); a += 2) {
      for (let b = 0; b < (dy !== 0 ? H : W); b++) {
        const x = dy !== 0 ? a : b, y = dy !== 0 ? b : a;
        if (!solid(x, y) || solid(x + dx, y + dy) || walk(x + dx, y + dy)) continue;   // (quick: the band's first cell beside the void)
        let v = -1, ok = true;
        for (let w = 0; w < BW && ok; w++) {
          const cx = x + px * w, cy = y + py * w, vv = vk(cx + dx, cy + dy);
          if (!solid(cx, cy) || !vv || (v >= 0 && vv !== v)) ok = false;
          v = vv;
        }
        if (!ok) continue;
        const band = [];
        let k = 0, found = false;
        for (; k <= OPEN.reach; k++) {
          let allW = true, fine = true;
          for (let w = 0; w < BW; w++) {
            const cx = x + px * w - dx * k, cy = y + py * w - dy * k;
            if (!walk(cx, cy)) allW = false;
            if (!(walk(cx, cy) || solid(cx, cy))) fine = false;
          }
          if (allW) { found = true; break; }
          if (!fine) break;
          for (let w = 0; w < BW; w++) band.push([x + px * w - dx * k, y + py * w - dy * k]);
        }
        if (!found || k < 1) continue;
        const edge = [];
        for (let w = 0; w < BW; w++) edge.push([x + px * w + dx, y + py * w + dy]);
        const v0 = vk(edge[0][0], edge[0][1]);
        all.push({ dir, dx, dy, band, edge, k, kind: v0 === 1 ? 'outer' : 'hole', hole: v0 >= 2 ? v0 - 2 : -1, out: edge[edge.length >> 1], id: all.length });
      }
    }
  }
  // the kept set: the shortest cuts first (then the search order), each tested only when the spacing (outward) or its
  // hole (a hole's first) still wants it
  const best = all.slice().sort(byNum('k'));   // (ties by the search order, `id`)
  const keep = [], holes = new Set();
  const cheb2 = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  let tried = 0;
  for (const s of best) {
    if (s.kind === 'outer' ? keep.some((o) => o.kind === 'outer' && cheb2(o.out, s.out) < OPEN.spacing) : hsize[s.hole] <= OPEN.holeMin || holes.has(s.hole)) continue;
    tried++;
    const c = tryCand(s.dir, s.dx, s.dy, s.band, s.edge, s.k);
    if (!c) continue;
    if (c.kind === 'hole') holes.add(c.hole);
    keep.push({ ...c, id: s.id });
  }
  keep.sort(byNum('id'));
  const out = keep.map((c, id) => Object.freeze({ ...c, id }));
  ctx.openCands = out;
  ctx.openStats = { starts: all.length, tried, holes: hsize.filter((n) => n > OPEN.holeMin).length };
  return out;
}

// The painter's view of a world's kept openings (overworld-local corridors, Kanto-local flags): `gone` the slots taken
// off Kanto's lattice, `cell` the cells the painter re-tiles (FireRed's tree rule and its rock pieces, bare ground
// where no tree or rock is left), `cut` the rock cells cut (bare ground, out of the rock mask), `corr` the corridors
// [x0, y0, x1, y1) where generated ground is forced walkable.
export function openingState(k, kept) {
  if (!k || !k.ctx || !kept || !kept.length) return null;
  const W = k.w, N = W * k.h, gone = new Uint8Array(N), cell = new Uint8Array(N), cut = new Uint8Array(N), corr = [];
  for (const c of kept) {
    for (let i = 0; i < c.gone.length; i += 2) gone[c.gone[i + 1] * W + c.gone[i]] = 1;
    for (let i = 0; i < c.cells.length; i += 2) cell[c.cells[i + 1] * W + c.cells[i]] = 1;
    for (let i = 0; i < c.rock.length; i += 2) cut[c.rock[i + 1] * W + c.rock[i]] = 1;
    const [x0, y0, w, h] = c.corr;
    corr.push([k.x + x0, k.y + y0, k.x + x0 + w, k.y + y0 + h]);
  }
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const r of corr) { bx0 = Math.min(bx0, r[0]); by0 = Math.min(by0, r[1]); bx1 = Math.max(bx1, r[2]); by1 = Math.max(by1, r[3]); }
  return { gone, cell, cut, corr, box: [bx0, by0, bx1, by1] };
}
export function kantoGoneAt(k, x, y) {
  const o = k && k.open;
  if (!o) return false;
  const lx = x - k.x, ly = y - k.y;
  return lx >= 0 && ly >= 0 && lx < k.w && ly < k.h && o.gone[ly * k.w + lx] === 1;
}
export function kantoOpenCellAt(k, x, y) {
  const o = k && k.open;
  if (!o) return false;
  const lx = x - k.x, ly = y - k.y;
  return lx >= 0 && ly >= 0 && lx < k.w && ly < k.h && o.cell[ly * k.w + lx] === 1;
}
export function kantoCutAt(k, x, y) {
  const o = k && k.open;
  if (!o) return false;
  const lx = x - k.x, ly = y - k.y;
  return lx >= 0 && ly >= 0 && lx < k.w && ly < k.h && o.cut[ly * k.w + lx] === 1;
}
// inside a kept opening's corridor (`pad` cells more on every side)
export function corridorAt(k, x, y, pad = 0) {
  const o = k && k.open;
  if (!o || x < o.box[0] - pad || y < o.box[1] - pad || x >= o.box[2] + pad || y >= o.box[3] + pad) return false;
  for (const r of o.corr) if (x >= r[0] - pad && y >= r[1] - pad && x < r[2] + pad && y < r[3] + pad) return true;
  return false;
}
