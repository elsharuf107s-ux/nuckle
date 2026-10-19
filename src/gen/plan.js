// The world plan (design 3.11, 3.14; stage 3c): computed once per world load from the descriptor alone, so nothing
// of it is saved. Pure (3.0): no DOM, no G, no time limits; every list is ordered with order.js comparators; work is
// bounded by counts.
//
//   makePlan(g)        g = makeGen(desc, { terrain, kantoZone, kantoGrid }) (the spawn's final test paints)
//                      -> { json, hash, coarse, groupsOf, ... } and the plan's stamps attached to g (attachPlan)
//   planJSON(plan)     the canonical JSON (keys sorted, numbers as ECMAScript prints them) the hash covers
//   attachPlan(g, p)   the stamps the chunk painter honours (village bounds, the spawn meadow)
//
// Coordinates: structures (villages, caves, the spawn, the meadow, groups) are in overworld-local cells (0..1599) and
// overworld-local data chunks (0..49), as the generator's; rooms, `maps` and `warps` are in plane cells (the overworld's
// cell (x, y) is the plane's (416 + x, y)), ready to append to world.meta's lists (2.2, 3.11 steps 9 and 10).
//
// As built in stage 3c (see the design's "Stage 3c as built"): village layouts are stubs (bounds, a plaza and house
// rectangles with south doors; stage 7a replaces the layout generator), caves are sites with their hill rectangle and
// rooms (stage 5b stamps the hill and digs the rooms), the Wild World stronghold entrance is stage 6c's and a Kanto
// World's spawn only has its distance band (6b adds the land side and the connectivity to an opening: done, see
// planOpenings and openingReach below).
import { GEN_VERSION } from './version.js';
import { hash32, fnv1a } from './hash.js';
import { cmpStr, byNum, byScoreThenId, rankOf } from './order.js';
import { COARSE, OW, LAT, edgeGuard, siteFieldsAt, riverAt, mountAt } from './climate.js';
import { B, BIOMES, classify, majority, hubRule } from './biomes.js';
import { fbm, clamp, smooth, lerp, makeFbm } from './noise.js';
import { WATER } from './region.js';
import { isKantoCell, kantoBoxDist } from './kanto.js';
import { kantoOpeningCands, openingState, OPEN } from './kanto.js';   // (stage 6b: Kanto's openings)
import { genRegion, W_NONE } from './region.js';
import { paintRegion, setStamps, setCaveStamps, caveStampsOf, STAMP_VILLAGE, STAMP_MEADOW, BIOME_REC, D, C_GRASS, C_SAND, C_SNOW, C_MUD } from './chunk.js';
import { STAMP_RUIN, setRuins } from './chunk.js';   // (stage 6c: the Wild World stronghold's ruin)
import { layoutVillage, INTERIORS } from './village.js';   // (stage 7a: village layouts and interiors)

export const OX = 416;                       // the plane's x of overworld-local x 0
export const BORDER = Object.freeze({ x0: 8, y0: 8, x1: 1591, y1: 1591 });   // overworld-local, inclusive (2.8)
export const MAP_BASE = 192, WARP_BASE = 701; // world.json's list lengths: appended maps and warps start here
export const AREAS = Object.freeze([
  Object.freeze({ id: 'A', x: 0, y: 0, w: 408, h: 408 }),
  Object.freeze({ id: 'B', x: 0, y: 1062, w: 408, h: 538 }),
]);
export const CAVE_B1 = Object.freeze({ w: 48, h: 36 }), CAVE_B2 = Object.freeze({ w: 40, h: 30 });
export const HOUSE_ROOM = Object.freeze({ w: 11, h: 9 });    // (unused since 7a: each interior's template sets its size)
export const PLAN = Object.freeze({
  villageRegion: 128, villageInner: 64, villageSpacing: 160, villageClear: 24, villageCoast: 48,
  villageMin: 56, villageMax: 72, houseMin: 6, houseMax: 12, villageTests: 64,
  caveRegion: 96, caveRock: 0.30, caveCoast: 48, caveCap: 48,
  spawnInside: 240, kantoBand: [280, 460], spawnVillage: 96, spawnCave: 32,
  coarseCands: 400, classTests: [12, 8, 8], finalTests: [4, 2, 1], classWin: 48, finalSearch: 4, finalTrees: 4,
  candSpacing: 48,
  // the Wild World stronghold entrance (3.13, stage 6c): Chebyshev band from the spawn, cells inside the coast and the
  // border, hashed candidates
  strongholdBand: [250, 450], strongholdInside: 48, strongholdCands: 64,
});

const VILLAGE_BIOMES = new Set([B.PLAINS, B.DESERT, B.SAVANNA, B.TAIGA, B.SNOWY_PLAINS, B.SNOWY_TAIGA]);
const STYLE_OF_BIOME = { [B.PLAINS]: 'plains', [B.DESERT]: 'desert', [B.SAVANNA]: 'savanna', [B.TAIGA]: 'taiga',
  [B.SNOWY_PLAINS]: 'snowy', [B.SNOWY_TAIGA]: 'snowy' };
const SPAWN_BIOMES = [
  [B.PLAINS, B.FOREST, B.BIRCH_FOREST, B.TAIGA],
  [B.PLAINS, B.FOREST, B.BIRCH_FOREST, B.TAIGA, B.DARK_FOREST, B.SAVANNA],
];

// biome maps (2.10): wild table, music and battle terrain per biome (music and terrain are starting values for 4a)
const WILD_OF = {
  PLAINS: 'PLAINS', FOREST: 'FOREST', BIRCH_FOREST: 'BIRCH_FOREST', DARK_FOREST: 'DARK_FOREST', TAIGA: 'TAIGA',
  SNOWY_TAIGA: 'SNOWY', SNOWY_PLAINS: 'SNOWY', SNOWY_BEACH: 'SNOWY', DESERT: 'DESERT', SAVANNA: 'SAVANNA', SWAMP: 'SWAMP',
  JUNGLE: 'JUNGLE', BEACH: 'BEACH', STONY_SHORE: 'BEACH', OCEAN: 'OCEAN', FROZEN_OCEAN: 'OCEAN', DEEP_OCEAN: 'OCEAN',
  RIVER: 'RIVER', LAKE: 'RIVER', STONY_HILLS: 'MOUNTAINS', MOUNTAINS: 'MOUNTAINS', SNOWY_MOUNTAINS: 'MOUNTAINS',
};
const MUSIC_OF = {
  PLAINS: 'MUS_ROUTE1', FOREST: 'MUS_ROUTE3', BIRCH_FOREST: 'MUS_ROUTE3', DARK_FOREST: 'MUS_VIRIDIAN_FOREST',
  TAIGA: 'MUS_ROUTE24', SNOWY_TAIGA: 'MUS_ROUTE24', SNOWY_PLAINS: 'MUS_ROUTE24', SNOWY_BEACH: 'MUS_ROUTE24',
  DESERT: 'MUS_ROUTE11', SAVANNA: 'MUS_ROUTE11', SWAMP: 'MUS_VIRIDIAN_FOREST', JUNGLE: 'MUS_VIRIDIAN_FOREST',
  BEACH: 'MUS_ROUTE11', STONY_SHORE: 'MUS_ROUTE11', OCEAN: 'MUS_ROUTE11', FROZEN_OCEAN: 'MUS_ROUTE11', DEEP_OCEAN: 'MUS_ROUTE11',
  RIVER: 'MUS_ROUTE1', LAKE: 'MUS_ROUTE1', STONY_HILLS: 'MUS_ROUTE3', MOUNTAINS: 'MUS_ROUTE3', SNOWY_MOUNTAINS: 'MUS_ROUTE24',
};
const TERRAIN_OF = (b) => (b.kind === 'water' ? (b.key === 'RIVER' || b.key === 'LAKE' ? 'pond' : 'water')
  : b.kind === 'rock' ? 'mountain' : b.key === 'DESERT' || b.kind === 'shore' ? 'sand' : 'grass');
export const mapIdOfBiome = (id) => 'GEN_' + BIOMES[id].key;

// layer names as sub-seed keys (fnv1a once, not per call)
const K_VILLAGE_SITE = fnv1a('village.site');
const K_VILLAGE = fnv1a('village');
const K_CAVE_MOUTH = fnv1a('cave.mouth');
const K_CAVE_KEEP = fnv1a('cave.keep');
const K_CAVE = fnv1a('cave');
const K_SPAWN_COARSE = fnv1a('spawn.coarse');
const K_STRONGHOLD = fnv1a('stronghold');
const r01 = (a, b, c, d) => hash32(a, b, c, d) / 4294967296;
const cheb = (ax, ay, bx, by) => { const dx = ax > bx ? ax - bx : bx - ax, dy = ay > by ? ay - by : by - ay; return dx > dy ? dx : dy; };
// Chebyshev distance from a cell to a rectangle (0 inside)
const rectDist = (x, y, r) => {
  const dx = x < r.x0 ? r.x0 - x : x >= r.x0 + r.w ? x - (r.x0 + r.w - 1) : 0;
  const dy = y < r.y0 ? r.y0 - y : y >= r.y0 + r.h ? y - (r.y0 + r.h - 1) : 0;
  return dx > dy ? dx : dy;
};

// ---------------------------------------------------------------- the coarse grid (3.11 step 2)
// From makeGen's coarse sample (the thresholds' own 200 x 200 points): the coarse biome map (the biome table at each
// point with Kanto's pull, 3 x 3 majority twice, the hub rule over 2 points = 4 lattice points), sea, rock, Kanto,
// fresh water near the point, and two Chebyshev distance fields in coarse steps: to the sea, and to anything a
// structure must keep away from (water, rock, Kanto).
function coarseMaps(g) {
  const S = g.coarse, n = S.n, st = S.step, th = g.th, L = g.layers, k = g.kanto, Wt = g.W || WATER;
  const N = n * n;
  const raw = new Uint8Array(N), hr = new Float64Array(N);
  const sea = new Uint8Array(N), rock = new Uint8Array(N), kan = new Uint8Array(N), wet = new Uint8Array(N);
  const mEnd = th.mRiverFade + Wt.riverEndAt * (th.mRock - th.mRiverFade);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const q = j * n + i, px = i * st, py = j * st;
      let t = rankOf(th.tK, S.T[q]), h = rankOf(th.hK, S.H[q]);
      if (k && kantoBoxDist(k, px, py) < Wt.kantoPull + 42) {
        const dk = kantoBoxDist(k, px, py) + 60 * (fbm(L.kpull, px, py) + 0.3);
        const a = smooth(clamp(1 - dk / Wt.kantoPull, 0, 1));
        t = lerp(t, Wt.kantoT, a); h = lerp(h, Wt.kantoH, a);
      }
      hr[q] = h;
      raw[q] = classify(t, h, S.M[q] >= th.mRock, S.M[q] >= th.mMount);
      const guard = edgeGuard(px, py);
      sea[q] = S.C[q] < th.cOcean || (guard > 0 && S.C[q] - guard < th.cOcean) ? 1 : 0;
      rock[q] = S.M[q] >= th.mRock ? 1 : 0;
      kan[q] = k && isKantoCell(k, px, py) ? 1 : 0;
    }
  }
  const bio = hubRule(majority(majority(raw, n, n), n, n), hr, n, n, 2);
  for (let q = 0; q < N; q++) if (kan[q]) bio[q] = B.KANTO;
  // fresh water near a point (within about 4 cells of it): lakes and rivers from their signed distances in cells,
  // with gradients from the neighbouring coarse points (R is evaluated only where a river can run)
  // R is evaluated at every other coarse point (16 cells; hasR 1, exact) and interpolated between them (hasR 2: the
  // coarse flags are heuristics for choosing candidates, and latFields reuses only the exact values); a point whose
  // neighbours lack R is evaluated too
  const R = new Float64Array(N), hasR = new Uint8Array(N);
  const needR = (q) => !sea[q] && S.M[q] < mEnd + 0.05;
  const exact = (q) => { R[q] = riverAt(L, (q % n) * st, Math.floor(q / n) * st); hasR[q] = 1; };
  for (let j = 0; j < n; j += 2) for (let i = 0; i < n; i += 2) { const q = j * n + i; if (needR(q)) exact(q); }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const q = j * n + i;
      if (hasR[q] || !needR(q)) continue;
      const ia = i & ~1, ja = j & ~1, ib = Math.min(ia + 2, n - 2), jb = Math.min(ja + 2, n - 2);
      const a = ja * n + ia, b = ja * n + ib, c = jb * n + ia, d = jb * n + ib;
      if (hasR[a] === 1 && hasR[b] === 1 && hasR[c] === 1 && hasR[d] === 1 && ib > ia && jb > ja) {
        const tx = (i - ia) / 2, ty = (j - ja) / 2;
        R[q] = (R[a] * (1 - tx) + R[b] * tx) * (1 - ty) + (R[c] * (1 - tx) + R[d] * tx) * ty;
        hasR[q] = 2;
      } else exact(q);
    }
  }
  const inv = 1 / (2 * st);
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const q = j * n + i;
      if (sea[q] || kan[q]) continue;
      const lgx = (S.LK[q + 1] - S.LK[q - 1]) * inv, lgy = (S.LK[q + n] - S.LK[q - n]) * inv;
      const gl = Math.sqrt(lgx * lgx + lgy * lgy) + 1e-9;
      if (bio[q] !== B.DESERT && S.M[q] < th.mRock && (S.LK[q] - th.lLake) / gl < 4) { wet[q] = 1; continue; }
      if (hasR[q] && hasR[q - 1] && hasR[q + 1] && hasR[q - n] && hasR[q + n] && S.M[q] < mEnd) {
        const rgx = (R[q + 1] - R[q - 1]) * inv, rgy = (R[q + n] - R[q - n]) * inv;
        const gr = Math.sqrt(rgx * rgx + rgy * rgy) + 1e-9, d = R[q] / gr;
        if ((d < 0 ? -d : d) < Wt.riverMax + 4) wet[q] = 1;
      }
    }
  }
  const dSea = chebDist(sea, n), bad = new Uint8Array(N);
  for (let q = 0; q < N; q++) bad[q] = sea[q] | rock[q] | kan[q] | wet[q];
  const dBad = chebDist(bad, n);
  // what the village site test (siteClear) rejects, at coarse points: sea, a lake or a river within 2 cells of the
  // point (without the shift), or rock by the painter's widened rule; dFine is the Chebyshev distance to it, so a
  // village's bounds are chosen where the fine test is likely to pass
  const fineBad = new Uint8Array(N), sh = 2;
  const g2 = (F, q) => { const gx = (F[q + 1] - F[q - 1]) * inv, gy = (F[q + n] - F[q - n]) * inv; return Math.sqrt(gx * gx + gy * gy) + 1e-9; };
  const outcrop = makeFbm(g.seed, 'paint.outcrop', 60, 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const q = j * n + i;
      if (sea[q] || kan[q] || i === 0 || j === 0 || i === n - 1 || j === n - 1) { fineBad[q] = 1; continue; }
      const M = S.M[q];
      if (M >= th.mRiverFade && (M >= th.mRock || fbm(outcrop, i * st, j * st) > 0.5)) { fineBad[q] = 1; continue; }
      if ((S.C[q] - th.cOcean) / g2(S.C, q) < sh || (S.LK[q] - th.lLake) / g2(S.LK, q) < sh) { fineBad[q] = 1; continue; }
      if (hasR[q] && hasR[q - 1] && hasR[q + 1] && hasR[q - n] && hasR[q + n]) {
        const d = R[q] / g2(R, q);
        if ((d < 0 ? -d : d) < Wt.riverMax + sh) fineBad[q] = 1;
      }
    }
  }
  const dFine = chebDist(fineBad, n);
  return { n, st, bio, sea, rock, kan, wet, bad, dSea, dBad, dFine, mEnd, S, R, hasR };
}

// Chebyshev distance (in steps) from every point to the nearest set point of `m` (two passes; 255 = none within 254)
function chebDist(m, n) {
  const d = new Uint8Array(n * n);
  for (let q = 0; q < n * n; q++) d[q] = m[q] ? 0 : 255;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const q = j * n + i;
      let v = d[q];
      if (i > 0 && d[q - 1] + 1 < v) v = d[q - 1] + 1;
      if (j > 0) {
        if (d[q - n] + 1 < v) v = d[q - n] + 1;
        if (i > 0 && d[q - n - 1] + 1 < v) v = d[q - n - 1] + 1;
        if (i < n - 1 && d[q - n + 1] + 1 < v) v = d[q - n + 1] + 1;
      }
      d[q] = v;
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const q = j * n + i;
      let v = d[q];
      if (i < n - 1 && d[q + 1] + 1 < v) v = d[q + 1] + 1;
      if (j < n - 1) {
        if (d[q + n] + 1 < v) v = d[q + n] + 1;
        if (i < n - 1 && d[q + n + 1] + 1 < v) v = d[q + n + 1] + 1;
        if (i > 0 && d[q + n - 1] + 1 < v) v = d[q + n - 1] + 1;
      }
      d[q] = v;
    }
  }
  return d;
}

// C, M, L, R and RW at a lattice point (cells px, py) as siteFieldsAt computes them, taking C, M, L and R from the
// coarse grid where the point is one of its points (the same expressions at the same position, so the same numbers)
function latFields(g, cm, px, py, o, river = true) {
  const st = cm.st;
  if (px >= 0 && py >= 0 && px < OW && py < OW && px % st === 0 && py % st === 0) {
    const q = (py / st) * cm.n + px / st, S = cm.S;
    o.C = S.C[q]; o.M = S.M[q]; o.L = S.LK[q];
    if (river) riverFields(g, cm, px, py, o);
    return o;
  }
  return siteFieldsAt(g.layers, px, py, o, river);
}
// R and RW alone (R from the coarse grid where it has it)
function riverFields(g, cm, px, py, o) {
  const st = cm.st;
  const q = px >= 0 && py >= 0 && px < OW && py < OW && px % st === 0 && py % st === 0 ? (py / st) * cm.n + px / st : -1;
  o.R = q >= 0 && cm.hasR[q] === 1 ? cm.R[q] : riverAt(g.layers, px, py);
  o.RW = fbm(g.layers.rwidth, px, py);
  return o;
}

// the nearest coarse point of a cell
const cIdx = (cm, x, y) => {
  const n = cm.n, i = clamp(Math.floor((x + 4) / COARSE), 0, n - 1), j = clamp(Math.floor((y + 4) / COARSE), 0, n - 1);
  return j * n + i;
};

// ---------------------------------------------------------------- villages (3.11 step 4, 5.1 as a stub)
// The full-resolution site test, as built: every cell of the bounds plus 4 (the reach of the painter's 4-cell supers)
// goes through the chunk generator's own water expressions (region.js cellAt): C, L, M, R and RW at the lattice
// points with their central-difference gradients (components for C and R, magnitudes for L and M, as evalLattice),
// bilinear interpolation to the cell, the signed distances in cells, and the detail noise's shift (evaluated only for
// cells whose boundary it can reach). Two of cellAt's exclusions are left out (no lake in a desert, no fresh water near
// Kanto), which can only reject more. Rock follows the painter's lattice rule (3.6) with the outcrop rule widened to
// every biome, then its closing and opening (monotone, so the widened mask covers every rock the painter draws), and a
// cell is rejected when a rock point is one of its interpolation corners. The painter also forces the bounds dry and
// rock-free (3.4 rule 4); this test is what keeps that from ever cutting a river.
// 3c fix: two gaps between this test and the painter, found by the quick check, are closed in the painter (chunk.js):
// its run breakers (level 2) no longer let a super of a village's bounds plus 4 take the class of the super beside it
// (that carried water and rock into the margin and the bounds), so every such super keeps its level-1 class, which
// this test proves dry and rock-free; and its swamp puddles (not cellAt's water, so not tested here) fade out toward a
// village and never form within 4 cells of its bounds.
function siteClear(g, cm, outcrop, x0, y0, w, h) {
  const L = g.layers, mEnd = cm.mEnd;
  const th = g.th, Wt = g.W || WATER, m = 4, MR = 4, EPS = 1e-9;
  // lattice points: the cells' corners plus one for the gradients, plus MR for the rock morphology
  const lx0 = Math.floor((x0 - m) / LAT) - 1 - MR, ly0 = Math.floor((y0 - m) / LAT) - 1 - MR;
  const lx1 = Math.floor((x0 + w - 1 + m) / LAT) + 2 + MR, ly1 = Math.floor((y0 + h - 1 + m) / LAT) + 2 + MR;
  const lw = lx1 - lx0 + 1, lh = ly1 - ly0 + 1, n = lw * lh;
  const C = new Float64Array(n), M = new Float64Array(n), LK = new Float64Array(n), R = new Float64Array(n), RW = new Float64Array(n);
  const raw = new Uint8Array(n), o = {};
  for (let j = 0; j < lh; j++) {
    for (let i = 0; i < lw; i++) {
      const p = j * lw + i, px = (lx0 + i) * LAT, py = (ly0 + j) * LAT;
      const inner = i >= MR && j >= MR && i < lw - MR && j < lh - MR;
      if (inner) {
        latFields(g, cm, px, py, o, false);
        C[p] = o.C; M[p] = o.M; LK[p] = o.L;
      } else M[p] = px >= 0 && py >= 0 && px < OW && py < OW && px % cm.st === 0 && py % cm.st === 0 ? cm.S.M[(py / cm.st) * cm.n + px / cm.st] : mountAt(L, px, py);
      raw[p] = M[p] >= th.mRiverFade && (M[p] >= th.mRock || fbm(outcrop, px, py) > 0.5) ? 1 : 0;
    }
  }
  // rock: the painter's closing then opening of radius 1 point (chunk.js; monotone, so the widened raw mask gives a
  // superset of the painter's masses), then any corner of any cell
  const morph = (src, dil) => {
    const out = new Uint8Array(n);
    for (let j = 1; j < lh - 1; j++) for (let i = 1; i < lw - 1; i++) {
      const p = j * lw + i;
      let v = dil ? 0 : 1;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const q = src[p + dj * lw + di]; if (dil) { if (q) v = 1; } else if (!q) v = 0; }
      out[p] = v;
    }
    return out;
  };
  let any = 0;
  for (let q = 0; q < n; q++) any |= raw[q];
  const rock = any ? morph(morph(morph(morph(raw, true), false), false), true) : raw;
  const inv = 1 / (2 * LAT);
  const gCx = new Float64Array(n), gCy = new Float64Array(n), gRx = new Float64Array(n), gRy = new Float64Array(n);
  const gL = new Float64Array(n), gM = new Float64Array(n);
  const mag = (F, p) => { const gx = (F[p + 1] - F[p - 1]) * inv, gy = (F[p + lw] - F[p - lw]) * inv; return Math.sqrt(gx * gx + gy * gy); };
  for (let j = MR + 1; j < lh - MR - 1; j++) for (let i = MR + 1; i < lw - MR - 1; i++) {
    const p = j * lw + i;
    gCx[p] = (C[p + 1] - C[p - 1]) * inv; gCy[p] = (C[p + lw] - C[p - lw]) * inv;
    gL[p] = mag(LK, p); gM[p] = mag(M, p);
  }
  // R and RW only where a river can reach (most of a site is far from any): evaluated per lattice point on demand,
  // with R's gradient at a block's corners
  const hasRv = new Uint8Array(n), hasG = new Uint8Array(n);
  const needR = (p) => {
    if (hasRv[p]) return;
    const i = p % lw, j = (p - i) / lw;
    riverFields(g, cm, (lx0 + i) * LAT, (ly0 + j) * LAT, o);
    R[p] = o.R; RW[p] = o.RW; hasRv[p] = 1;
  };
  const ensureR = (q) => {
    for (const c of [q, q + 1, q + lw, q + lw + 1]) {
      if (hasG[c]) continue;
      needR(c); needR(c - 1); needR(c + 1); needR(c - lw); needR(c + lw);
      gRx[c] = (R[c + 1] - R[c - 1]) * inv; gRy[c] = (R[c + lw] - R[c - lw]) * inv; hasG[c] = 1;
    }
  };
  const fadeSpan = mEnd - th.mRiverFade, SH = Wt.shift;
  let p = 0, a = 0, b = 0, c = 0, d = 0;
  const ip = (F) => F[p] * a + F[p + 1] * b + F[p + lw] * c + F[p + lw + 1] * d;
  // corner bounds of a lattice block: an interpolated value lies between its corners' values, and an interpolated
  // gradient is no longer than its longest corner gradient, so (min value - v0) / (max gradient) bounds the signed
  // distance of every cell of the block from below
  const lo = (F, v0, q) => Math.min(F[q], F[q + 1], F[q + lw], F[q + lw + 1]) - v0;
  const hi = (G, q) => Math.max(G[q], G[q + 1], G[q + lw], G[q + lw + 1]);
  const hi2 = (X, Y, q) => { let m2 = 0; for (const k of [q, q + 1, q + lw, q + lw + 1]) { const v = X[k] * X[k] + Y[k] * Y[k]; if (v > m2) m2 = v; } return Math.sqrt(m2); };
  const cx0 = x0 - m, cx1 = x0 + w + m, cy0 = y0 - m, cy1 = y0 + h + m;
  for (let by = Math.floor(cy0 / LAT); by * LAT < cy1; by++) {
    for (let bx = Math.floor(cx0 / LAT); bx * LAT < cx1; bx++) {
      const q = (by - ly0) * lw + bx - lx0;
      if (rock[q] || rock[q + 1] || rock[q + lw] || rock[q + lw + 1]) return 'rock';
      // the whole block is out of reach of the sea, lakes and rivers: no cell needs its own evaluation (no cell of a
      // block where riverOk holds can have de + sh > 0, so R is needed only in the others)
      const riverOk = -lo(M, mEnd, q) / (hi(gM, q) + EPS) + SH <= 0;
      if (!riverOk) ensureR(q);
      const far = lo(C, th.cOcean, q) / (hi2(gCx, gCy, q) + EPS) >= SH + Wt.beachMax
        && lo(LK, th.lLake, q) / (hi(gL, q) + EPS) >= SH
        && (riverOk
          || Math.min(Math.abs(R[q]), Math.abs(R[q + 1]), Math.abs(R[q + lw]), Math.abs(R[q + lw + 1])) / (hi2(gRx, gRy, q) + EPS) >= Wt.riverMax + SH
          && (R[q] > 0) === (R[q + 1] > 0) && (R[q] > 0) === (R[q + lw] > 0) && (R[q] > 0) === (R[q + lw + 1] > 0));
      if (far) continue;
      for (let y = Math.max(by * LAT, cy0); y < Math.min(by * LAT + LAT, cy1); y++) {
        const ty = (y - by * LAT) / LAT;
        for (let x = Math.max(bx * LAT, cx0); x < Math.min(bx * LAT + LAT, cx1); x++) {
          const tx = (x - bx * LAT) / LAT;
          p = q;
          a = (1 - tx) * (1 - ty); b = tx * (1 - ty); c = (1 - tx) * ty; d = tx * ty;
          // the sea (cellAt: dc < 0, the shift taken at the cell's foot on the coast)
          const cv = ip(C), cgx = ip(gCx), cgy = ip(gCy), gc = Math.sqrt(cgx * cgx + cgy * cgy) + EPS;
          const dc0 = (cv - th.cOcean) / gc;
          if (dc0 < SH) {
            const dc = dc0 + (dc0 > -Wt.footReach && dc0 < Wt.footReach ? SH * fbm(L.sn, x - dc0 * cgx / gc, y - dc0 * cgy / gc) : 0);
            if (dc < 0) return 'sea';
          }
          const mv = ip(M), gm = ip(gM) + EPS, dl = (ip(LK) - th.lLake) / (ip(gL) + EPS), de = (mEnd - mv) / gm;
          if (dl - SH >= 0 && de + SH <= 0) continue;    // no lake and no river can reach this cell
          const sh = SH * fbm(L.sn, x, y);
          if ((mv - th.mRock) / gm + sh < 0 && dl + sh < 0) return 'lake';
          if (de + sh > 0) {
            const fade = 1 - smooth(clamp((mv - th.mRiverFade) / fadeSpan, 0, 1));
            const hw = Wt.riverMin + (Wt.riverMax - Wt.riverMin) * clamp(ip(RW) * 1.5 + 0.5, 0, 1) * fade;
            const rgx = ip(gRx), rgy = ip(gRy), gr = Math.sqrt(rgx * rgx + rgy * rgy) + EPS;
            const dr0 = ip(R) / gr;
            if ((dr0 < 0 ? -dr0 : dr0) < hw + SH) {
              const dr = dr0 + SH * fbm(L.sn, x - dr0 * rgx / gr, y - dr0 * rgy / gr);
              if ((dr < 0 ? -dr : dr) < hw) return 'river';
            }
          }
        }
      }
    }
  }
  return null;
}

function placeVillages(g, cm, outcrop, stats) {
  const P = PLAN, seed = g.seed, n = cm.n, villages = [];
  const nr = -Math.floor(-OW / P.villageRegion), per = P.villageRegion / COARSE;
  const coastC = P.villageCoast / COARSE, sp2 = P.villageSpacing * P.villageSpacing;
  // candidates (as built): per 128 x 128 region, up to 3 coarse points with a village biome, far enough inland, whose
  // distance to anything the fine test rejects leaves room for the smallest village, best room first (ties by hash),
  // 32 cells apart. A hashed position alone found a site in under a tenth of the regions: rivers, lakes, outcrops and
  // hills are dense at a village's scale. All regions' candidates are then taken best first (so the roomiest sites
  // win the 160-cell spacing), at most one village per region and at most P.villageTests fine tests.
  const all = [];
  for (let ry = 0; ry < nr; ry++) {
    for (let rx = 0; rx < nr; rx++) {
      const i0 = rx * per, j0 = ry * per;
      if (i0 >= n || j0 >= n) continue;
      stats.candidates++;
      const list = [];
      for (let j = j0; j < j0 + per && j < n; j++) {
        for (let i = i0; i < i0 + per && i < n; i++) {
          const q = j * n + i;
          if (!VILLAGE_BIOMES.has(cm.bio[q]) || cm.dSea[q] < coastC) continue;
          const room = cm.dFine[q] * COARSE - 4;               // about the cells from the point to a rejected cell
          if (room < P.villageMin / 2 + 4) continue;
          list.push({ id: q, score: Math.min(cm.dFine[q], 10) * 65536 + (hash32(seed, K_VILLAGE_SITE, i, j) >>> 16), i, j, q, room, region: ry * nr + rx, rx, ry });
        }
      }
      list.sort(byScoreThenId);
      const kept = [];
      for (const c of list) {
        if (kept.length >= 3) break;
        if (kept.some((t) => cheb(t.i, t.j, c.i, c.j) < 4)) continue;
        kept.push(c);
      }
      all.push(...kept);
    }
  }
  all.sort(byScoreThenId);
  const done = new Uint8Array(nr * nr), placed = [];
  for (const c of all) {
    if (done[c.region] || stats.fine >= P.villageTests) continue;
    const vs = hash32(seed, K_VILLAGE, c.rx, c.ry);
    const cx = c.i * COARSE, cy = c.j * COARSE;
    const fit = Math.floor(2 * (c.room - 4) / 4) * 4;
    const S = Math.min(fit, P.villageMin + 4 * (vs % ((P.villageMax - P.villageMin) / 4 + 1)));
    const x0 = Math.floor((cx - S / 2) / 4) * 4, y0 = Math.floor((cy - S / 2) / 4) * 4;
    const vx = x0 + S / 2, vy = y0 + S / 2;
    if (placed.some((v) => (v.x - vx) * (v.x - vx) + (v.y - vy) * (v.y - vy) < sp2)) { stats.spacing++; continue; }
    stats.fine++;
    const why = siteClear(g, cm, outcrop, x0, y0, S, S);
    if (why) { stats.rejected[why] = (stats.rejected[why] || 0) + 1; continue; }
    // (7a) the layout: a site where fewer than 6 houses fit is rejected
    const lay = layoutVillage(vs, x0, y0, S, STYLE_OF_BIOME[cm.bio[c.q]]);
    if (!lay) { stats.rejected.layout = (stats.rejected.layout || 0) + 1; continue; }
    done[c.region] = 1;
    placed.push({ x: vx, y: vy, region: c.region, vs, x0, y0, S, biome: cm.bio[c.q], lay });
  }
  // ids in reading order of the village centres (rows of 8 cells, then x)
  for (const v of placed) v.order = (v.y >> 3) * 4096 + v.x;
  placed.sort(byNum('order'));
  for (const v of placed) villages.push(villageRecord(villages.length, v));
  return villages;
}

// The plan's village record (stage 7a): bounds, centre, biome and style, and the layout of village.js (plaza, path
// rectangles, houses with doors, interiors, beds and job sites, well, bell, farms, pens, lamps).
function villageRecord(id, v) {
  return { id, seed: v.vs, x: v.x0 + v.S / 2, y: v.y0 + v.S / 2, x0: v.x0, y0: v.y0, w: v.S, h: v.S, biome: BIOMES[v.biome].key,
    style: STYLE_OF_BIOME[v.biome], ...v.lay };
}

// ---------------------------------------------------------------- caves (3.11 step 5)
function placeCaves(g, cm, villages, stats, avoid = null) {   // (6b: avoid(x, y), a mouth whose hill meets a Kanto opening's corridor)
  const P = PLAN, seed = g.seed, n = cm.n, per = P.caveRegion / COARSE, nr = -Math.floor(-OW / P.caveRegion);
  const coastC = P.caveCoast / COARSE, cands = [];
  const lab = new Int32Array(per * per), stack = [];
  for (let ry = 0; ry < nr; ry++) {
    for (let rx = 0; rx < nr; rx++) {
      const i0 = rx * per, j0 = ry * per, i1 = Math.min(n, i0 + per), j1 = Math.min(n, j0 + per);
      let rock = 0, all = 0;
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { all++; if (cm.rock[j * n + i] && !cm.kan[j * n + i]) rock++; }
      if (!all || rock < P.caveRock * all) continue;
      // the region's largest 4-connected rock patch (ties: the first found in reading order)
      lab.fill(0);
      let best = 0, bestN = 0, nl = 0;
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
          const li = (j - j0) * per + (i - i0);
          if (lab[li] || !cm.rock[j * n + i] || cm.kan[j * n + i]) continue;
          nl++; lab[li] = nl; stack.push(li);
          let cnt = 0;
          while (stack.length) {
            const v = stack.pop(), vi = v % per, vj = (v - vi) / per;
            cnt++;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const ai = vi + di, aj = vj + dj;
              if (ai < 0 || aj < 0 || ai >= i1 - i0 || aj >= j1 - j0) continue;
              const w = aj * per + ai, q = (j0 + aj) * n + i0 + ai;
              if (!lab[w] && cm.rock[q] && !cm.kan[q]) { lab[w] = nl; stack.push(w); }
            }
          }
          if (cnt > bestN) { bestN = cnt; best = nl; }
        }
      }
      // south-facing edge points of that patch: open land below (no sea, fresh water, rock or Kanto), far enough
      // inland, away from villages
      const opts = [];
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
          const li = (j - j0) * per + (i - i0);
          if (lab[li] !== best || j + 1 >= n) continue;
          const below = (j + 1) * n + i;
          if (cm.bad[below] || cm.dSea[below] < coastC) continue;
          const mx = i * COARSE, my = j * COARSE + 4;
          if (villages.some((v) => rectDist(mx, my, v) < 24)) continue;
          if (avoid && avoid(mx, my)) continue;
          opts.push({ id: j * n + i, score: hash32(seed, K_CAVE_MOUTH, i, j), i, j });
        }
      }
      if (!opts.length) continue;
      opts.sort(byScoreThenId);
      const o = opts[0], q = o.j * n + o.i;
      cands.push({ id: cands.length, score: hash32(seed, K_CAVE_KEEP, rx, ry), order: ry * 1000 + rx, rx, ry, i: o.i, j: o.j, biome: cm.bio[q] });
    }
  }
  stats.caveCandidates = cands.length;
  cands.sort(byScoreThenId);
  const kept = cands.slice(0, PLAN.caveCap).sort(byNum('order'));
  return kept.map((c, id) => {
    const x = c.i * COARSE, y = c.j * COARSE + 4;
    const fam = c.biome === B.SNOWY_MOUNTAINS ? 'snowy' : c.biome === B.MOUNTAINS ? 'mountain' : 'temperate';
    const cs = hash32(g.seed, K_CAVE, c.rx, c.ry);
    return { id, seed: cs, x, y, hill: [x - 3, y - 4, 7, 5], biome: BIOMES[c.biome].key, family: fam, b2: fam === 'mountain' || (cs & 1) === 1 };
  });
}

// ---------------------------------------------------------------- Kanto's openings (3.12, stage 6b)
// The seed-independent candidates (kanto.js kantoOpeningCands) kept where the first OPEN.keep cells of their corridor
// (the cut's width) are generated land: no Kanto cell, no water of stage 3a's fields (the sea; rivers and lakes keep 16
// cells from Kanto), and where the corridor keeps 12 cells off every cave hill and village. Kept candidates are applied to the generator (g.kanto.open: the painter cuts them and their
// corridors) before the spawn's tests paint anything.
function planOpenings(g, stats, villages, caves, cm) {
  const k = g.kanto;
  if (!k || !k.ctx || !g.kantoGrid || !g.kantoMat) return [];
  const cands = kantoOpeningCands(k.ctx, g.kantoGrid, g.kantoMat), kept = [];
  // a corridor (grown by its rock clearing's 4-cell jitter and 4 more) keeps off cave hills and villages, so neither is
  // cut and no rock edge meets a hill's own
  const meets = (c) => {
    const x0 = k.x + c.corr[0] - 12, y0 = k.y + c.corr[1] - 12, x1 = k.x + c.corr[0] + c.corr[2] + 12, y1 = k.y + c.corr[1] + c.corr[3] + 12;
    const hit = (ax, ay, bx, by) => ax < x1 && bx > x0 && ay < y1 && by > y0;
    return caves.some((cv) => hit(cv.hill[0], cv.hill[1], cv.hill[0] + cv.hill[2], cv.y + 3)) || villages.some((v) => hit(v.x0, v.y0, v.x0 + v.w, v.y0 + v.h));
  };
  // an outward corridor runs on past the generated rock it meets (Kanto's rock pulls the mountains on beside it) until
  // 16 cells after the last coarse rock point on its middle line, up to OPEN.corridorMax; the sea ends it
  const lengthen = (c0) => {
    if (c0.kind !== 'outer') return c0;
    const [dx, dy] = c0.n, ox = k.x + c0.out[0], oy = k.y + c0.out[1], n = cm.n, st = cm.st;
    let need = OPEN.corridor;
    for (let t = 0; t < OPEN.corridorMax && t <= need; t += 4) {
      const i = Math.floor((ox + dx * t) / st + 0.5), j = Math.floor((oy + dy * t) / st + 0.5);
      if (i < 0 || j < 0 || i >= n || j >= n || cm.sea[j * n + i]) break;
      if (cm.rock[j * n + i]) need = Math.max(need, t + 16);
    }
    const L = Math.min(OPEN.corridorMax, need);
    if (L === OPEN.corridor) return c0;
    const [x0, y0, w, h] = c0.corr, lx = c0.out[0], ly = c0.out[1];
    const corr = dx === 0 ? [x0, dy < 0 ? ly - L + 1 : ly, w, L] : [dx < 0 ? lx - L + 1 : lx, y0, L, h];
    return { ...c0, corr };
  };
  for (const c0 of cands) {
    const c = lengthen(c0);
    if (meets(c)) continue;
    const [dx, dy] = c.n, ox = k.x + c.out[0], oy = k.y + c.out[1], [cx0, cy0, cw, ch] = c.corr, K = OPEN.keep;
    const x0 = dx === 0 ? k.x + cx0 + 1 : dx < 0 ? ox - K + 1 : ox, y0 = dy === 0 ? k.y + cy0 + 1 : dy < 0 ? oy - K + 1 : oy;
    const w = dx === 0 ? cw - 2 : K, h = dy === 0 ? ch - 2 : K;
    if (x0 < 0 || y0 < 0 || x0 + w > OW || y0 + h > OW) continue;
    const r = genRegion(g, x0, y0, w, h);
    let ok = true;
    for (let j = 0; j < h && ok; j++) for (let i = 0; i < w; i++) if (isKantoCell(k, x0 + i, y0 + j) || r.water[j * w + i] !== W_NONE) { ok = false; break; }
    if (ok) kept.push(c);
  }
  stats.openings = { candidates: cands.length, kept: kept.length, outer: kept.filter((c) => c.kind === 'outer').length };
  k.open = openingState(k, kept);
  return kept;
}
// The coarse points with a land path to a kept outward opening (3.12's connectivity check): a breadth-first search over
// the coarse grid (land, rivers and beaches pass; the sea, rock and Kanto do not, but rock inside a corridor does: the
// painter clears it) from the passable points of the outward openings' corridors. null when none is passable (the
// spawn then has no land path to Kanto: a warning).
function openingReach(g, cm, kept) {
  const n = cm.n, st = cm.st, k = g.kanto, reach = new Uint8Array(n * n), queue = [], inC = new Uint8Array(n * n);
  for (const c of kept) {
    if (c.kind !== 'outer') continue;
    // the corridor grown by its rock clearing's jitter (chunk.js inCorr4)
    const x0 = k.x + c.corr[0] - 8, y0 = k.y + c.corr[1] - 8, x1 = k.x + c.corr[0] + c.corr[2] + 8, y1 = k.y + c.corr[1] + c.corr[3] + 8;
    for (let j = Math.max(0, -Math.floor(-y0 / st)); j < n && j * st < y1; j++) for (let i = Math.max(0, -Math.floor(-x0 / st)); i < n && i * st < x1; i++) inC[j * n + i] = 1;
  }
  const pass = (q) => !cm.sea[q] && !cm.kan[q] && (!cm.rock[q] || inC[q] === 1);
  for (let q = 0; q < n * n; q++) if (inC[q] && pass(q)) { reach[q] = 1; queue.push(q); }
  if (!queue.length) return null;
  for (let h = 0; h < queue.length; h++) {
    const q = queue[h], i = q % n, j = (q - i) / n;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const r = jj * n + ii;
      if (!reach[r] && pass(r)) { reach[r] = 1; queue.push(r); }
    }
  }
  return reach;
}

// ---------------------------------------------------------------- the spawn (3.14)
function spawnSearch(g, cm, villages, caves, outcrop, stats, lap, minRung = 1, reach = null) {
  const P = PLAN, seed = g.seed, n = cm.n, k = g.kanto;
  const nearStructure = (x, y) => villages.some((v) => rectDist(x, y, v) < P.spawnVillage)
    || caves.some((c) => cheb(x, y, c.x, c.y) < P.spawnCave);
  const inBand = (x, y, widen) => {
    if (x < BORDER.x0 || y < BORDER.y0 || x > BORDER.x1 || y > BORDER.y1) return false;
    if (!k) {
      const m = widen ? P.spawnInside * 0.75 : P.spawnInside;
      return x >= BORDER.x0 + m && y >= BORDER.y0 + m && x <= BORDER.x1 - m && y <= BORDER.y1 - m;
    }
    const d = kantoBoxDist(k, x, y), lo = P.kantoBand[0] * (widen ? 0.75 : 1), hi = P.kantoBand[1] * (widen ? 1.25 : 1);
    return d >= lo && d <= hi;
  };
  // a spawn cell's own rules (the class and final tests move the cell up to 16 cells from its coarse point)
  const allowed = (widen) => (x, y) => inBand(x, y, widen) && !nearStructure(x, y);
  const central = (x, y) => (k ? 0 : x >= 320 && x <= 1280 && y >= 320 && y <= 1280 ? 1 : 0);
  // coarse candidates of a rung, best first
  const coarse = (biomes, wr, widen) => {
    const set = new Set(biomes), out = [];
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const q = j * n + i, x = i * COARSE, y = j * COARSE;
        if (cm.dBad[q] <= wr || !inBand(x, y, widen)) continue;
        if (reach && !reach[q]) continue;   // (6b) a Kanto World: a coarse land path to a kept opening
        let ok = true;
        for (let dj = -1; dj <= 1 && ok; dj++) for (let di = -1; di <= 1; di++) if (!set.has(cm.bio[q + dj * n + di])) { ok = false; break; }
        if (!ok || nearStructure(x, y)) continue;
        const score = 10 * Math.min(cm.dBad[q], 6) + 15 * central(x, y) + 10 * r01(seed, K_SPAWN_COARSE, i, j);
        out.push({ id: q, score, x, y });
      }
    }
    out.sort(byScoreThenId);
    return out.slice(0, P.coarseCands);
  };
  // the best candidates, at least candSpacing cells apart, so the class tests look at different places
  const spread = (list, count) => {
    const out = [];
    for (const c of list) {
      if (out.length >= count) break;
      if (out.some((o) => cheb(o.x, o.y, c.x, c.y) < P.candSpacing)) continue;
      out.push(c);
    }
    return out;
  };
  const rungs = [
    { biomes: SPAWN_BIOMES[0], wr: 2, clear: 2, widen: false },
    { biomes: SPAWN_BIOMES[1], wr: 1, clear: 2, widen: false },
    { biomes: SPAWN_BIOMES[1], wr: 1, clear: 1, widen: true },
  ];
  let rung3Best = null;
  for (let r = 0; r < rungs.length; r++) {
    const R = rungs[r];
    if (r + 1 < minRung && r !== 2) continue;
    const cands = coarse(R.biomes, R.wr, R.widen);
    stats.spawnCoarse.push(cands.length);
    if (r === 2 && cands.length) rung3Best = cands[0];
    if (r + 1 < minRung) continue;
    const tested = [];
    if (lap) lap('spawnCoarse' + (r + 1));
    for (const c of spread(cands, P.classTests[r])) {
      stats.classTests++;
      const t = classTest(g, cm, c.x, c.y, R.clear, outcrop, allowed(R.widen));
      if (t) tested.push({ id: tested.length, score: t.score, x: t.x, y: t.y });
    }
    tested.sort(byScoreThenId);
    if (lap) lap('spawnClass' + (r + 1));
    for (const t of tested.slice(0, P.finalTests[r])) {
      stats.finalTests++;
      const f = finalTest(g, t.x, t.y, R.clear, null, allowed(R.widen), R.biomes);
      if (f) return { x: f.x, y: f.y, rung: r + 1, biome: BIOMES[f.biome].key, meadow: null };
    }
  }
  // rung 4: a spawn meadow at the best coarse candidate of rung 3 (or, failing one, the best open land in the
  // widened band, or the overworld's centre), decided before the spawn chunks are generated
  let c = rung3Best;
  if (!c) {
    // (6b) a point with the land path and away from villages and caves first, then with the land path only, then
    // without it (and the warning)
    let out = [];
    for (const [need, far] of reach ? [[reach, true], [reach, false], [null, true], [null, false]] : [[null, true], [null, false]]) {
      for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
        const q = j * n + i, x = i * COARSE, y = j * COARSE;
        if (cm.bad[q] || !inBand(x, y, true) || (need && !need[q]) || (far && nearStructure(x, y))) continue;
        out.push({ id: q, score: 10 * Math.min(cm.dBad[q], 6) + 10 * r01(seed, K_SPAWN_COARSE, i, j), x, y });
      }
      if (out.length) break;
    }
    out.sort(byScoreThenId);
    c = out[0] || { x: 800, y: 800 };
    stats.spawnFallback = true;
  }
  const meadow = meadowAt(c.x, c.y);
  setStamps(g, [...(g.stamps || []), meadow.stamp]);
  stats.finalTests++;
  const f = finalTest(g, c.x, c.y, 1, null, null, null);
  return { x: f ? f.x : c.x, y: f ? f.y : c.y, rung: 4, biome: BIOMES[f ? f.biome : cm.bio[cIdx(cm, c.x, c.y)]].key, meadow: meadow.rec, finalOk: !!f };
}

// The spawn meadow (3.14 rung 4): an 11 x 11 clearing of plain grass in a stamp of the supers covering 19 x 19 cells
// around the spawn, with 6 oak crowns at 8 cells east and west of it (never in the clearing; natural trees keep 2 cells
// away from the stamp, 2.4's structure group covers it).
export function meadowAt(x, y) {
  const x0 = Math.floor((x - 9) / 4) * 4, y0 = Math.floor((y - 9) / 4) * 4;
  const x1 = -Math.floor(-(x + 10) / 4) * 4, y1 = -Math.floor(-(y + 10) / 4) * 4;
  const bx = x - (x & 1), by = y - (y & 1);
  const grove = [];
  for (const dx of [-8, 8]) for (const dy of [-6, 0, 6]) grove.push([bx + dx, by + dy]);
  return { stamp: { k: STAMP_MEADOW, x0, y0, x1, y1, grove }, rec: { x, y, x0, y0, w: x1 - x0, h: y1 - y0, clear: [x - 5, y - 5, 11, 11], grove } };
}

// The class test (3.14 test 2): on a 48 x 48 window around a coarse candidate, every cell's class from the lattice
// fields the chunk generator uses (sea, rivers and lakes as signed distances, rock by the painter's rule) and the real
// tree slots of trees.js's lattice (the painter's own roll and density, without its band and species exclusions, so
// the class test may only overcount trees: the final test has the last word). Returns the best cell for a clearing
// (open cells around it, trees within 12, distance from water and rock) or null.
function classTest(g, cm, cx, cy, clear, outcrop, allow) {
  const P = g.paint, th = g.th, L = g.layers, Wt = g.W || WATER;
  const half = PLAN.classWin / 2, x0 = cx - half, y0 = cy - half, W = PLAN.classWin;
  const lx0 = Math.floor(x0 / LAT) - 1, ly0 = Math.floor(y0 / LAT) - 1, lw = W / LAT + 3, n = lw * lw;
  const C = new Float64Array(n), M = new Float64Array(n), LK = new Float64Array(n), R = new Float64Array(n);
  const o = {};
  for (let j = 0; j < lw; j++) for (let i = 0; i < lw; i++) {
    const p = j * lw + i;
    latFields(g, cm, (lx0 + i) * LAT, (ly0 + j) * LAT, o);
    C[p] = o.C; M[p] = o.M; LK[p] = o.L; R[p] = o.R;
  }
  const inv = 1 / (2 * LAT);
  const grad = (F, p) => { const gx = (F[p + 1] - F[p - 1]) * inv, gy = (F[p + lw] - F[p - lw]) * inv; return Math.sqrt(gx * gx + gy * gy) + 1e-9; };
  const badL = new Uint8Array(n);
  for (let j = 1; j < lw - 1; j++) for (let i = 1; i < lw - 1; i++) {
    const p = j * lw + i, px = (lx0 + i) * LAT, py = (ly0 + j) * LAT;
    let b = (C[p] - th.cOcean) / grad(C, p) < Wt.beachMax + 2 || (LK[p] - th.lLake) / grad(LK, p) < 3;
    if (!b && M[p] < cm.mEnd) { const d = R[p] / grad(R, p); b = (d < 0 ? -d : d) < Wt.riverMax + 2; }
    if (!b && M[p] >= th.mRiverFade && (M[p] >= th.mRock || fbm(outcrop, px, py) > 0.5)) b = true;
    badL[p] = b ? 1 : 0;
  }
  const cls = new Uint8Array(W * W);   // 0 open, 1 water or rock, 2 under a tree, 3 tall grass
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const p = (Math.floor((y0 + y) / LAT + 0.5) - ly0) * lw + Math.floor((x0 + x) / LAT + 0.5) - lx0;
    cls[y * W + x] = badL[p] ? 1 : 0;
  }
  // tall grass as the painter decides it (chunk.js level 0): a 4-cell super whose 4 samples are mostly over its land
  // biome's threshold on the 1/40 noise (the window is a multiple of 4 from an aligned corner: x0, y0 are multiples of 8)
  for (let sy = 0; sy < W; sy += 4) for (let sx = 0; sx < W; sx += 4) {
    let tall = 0;
    for (const [ox, oy] of [[1, 1], [3, 1], [1, 3], [3, 3]]) {
      const ax = x0 + sx + ox, ay = y0 + sy + oy, tr = BIOME_REC[cm.bio[cIdx(cm, ax, ay)]].tall;
      if (tr !== null && fbm(P.L.tall, ax, ay) > tr) tall++;
    }
    if (tall >= 2) for (let y = sy; y < sy + 4; y++) for (let x = sx; x < sx + 4; x++) if (!cls[y * W + x]) cls[y * W + x] = 3;
  }
  const slots = [];
  for (let y = 2; y < W - 2; y++) {
    const ay = y0 + y;
    if (ay & 1) continue;
    for (let x = 0; x < W - 1; x++) {
      const ax = x0 + x;
      if (ax & 1) continue;
      const rec = BIOME_REC[cm.bio[cIdx(cm, ax, ay)]];
      if (!rec.species) continue;
      const pr = clamp(rec.density * (1 + 2.5 * fbm(P.L.grove, ax, ay)), 0, 0.95);
      const roll = rec.cluster ? r01(P.seedTree, ax >> 2, ay >> 2, 7) : r01(P.seedTree, ax, ay);
      if (!(roll < pr)) continue;
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = 0; dx < 2; dx++) if (cls[(y + dy) * W + x + dx] === 1 || cls[(y + dy) * W + x + dx] === 3) { ok = false; break; }
      if (!ok) continue;
      slots.push(ax, ay);
      for (let dy = -1; dy <= 1; dy++) for (let dx = 0; dx < 2; dx++) cls[(y + dy) * W + x + dx] = 2;
    }
  }
  let best = null;
  for (let dy = -12; dy <= 12; dy += 2) {
    for (let dx = -12; dx <= 12; dx += 2) {
      const x = half + dx, y = half + dy;
      if (allow && !allow(x0 + x, y0 + y)) continue;
      let ok = true;
      for (let yy = -clear; yy <= clear && ok; yy++) for (let xx = -clear; xx <= clear; xx++) if (cls[(y + yy) * W + x + xx]) { ok = false; break; }
      if (!ok) continue;
      let trees = 0;
      for (let s = 0; s < slots.length; s += 2) if (cheb(slots[s], slots[s + 1], x0 + x, y0 + y) <= 12) trees++;
      if (trees < PLAN.finalTrees + 1) continue;
      let open = 0;
      for (let r = clear + 1; r <= 6; r++) {
        let ring = true;
        for (let yy = -r; yy <= r && ring; yy++) for (let xx = -r; xx <= r; xx++) {
          if ((yy === -r || yy === r || xx === -r || xx === r) && cls[(y + yy) * W + x + xx]) { ring = false; break; }
        }
        if (!ring) break;
        open++;
      }
      const score = 4 * Math.min(trees, 10) + 6 * open - ((dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy)) / 4;
      if (!best || score > best.score) best = { score, x: x0 + x, y: y0 + y };
    }
  }
  return best;
}

// The final test (3.14 test 3), on finished tiles: the painter's own output for the cells around the class
// test's cell (32 x 32: the search's 4 cells plus the 12 of the tree count). The spawn is the nearest cell (within 4) that is inside the border, in one of the rung's biomes (the
// painted biome), walkable (generated land of a walkable class, no tree, no solid decoration, a walkable entry), not
// tall grass, not a ledge, not water or ice, at the centre of a walkable (2 clear + 1)^2 block, with at least 4 trees
// (slots of the painted lattice) within 12 cells.
export function finalTest(g, cx, cy, clear, painted, allow, biomes) {
  const S = 32, x0 = cx - S / 2, y0 = cy - S / 2;
  const p = painted || paintRegion(g, x0, y0, S, S, { debug: true });
  const T = g.terrain, gb = T.genBase;
  const walk = new Uint8Array(S * S);
  for (let k = 0; k < S * S; k++) {
    const c = p.cls[k], t = p.tile[k], d = p.deco[k];
    if (!(c === C_GRASS || c === C_SAND || c === C_SNOW || c === C_MUD)) continue;
    if (p.dbg.tree[k] || p.dbg.solid[k]) continue;
    if (d && d !== D.DANDELION && d !== D.POPPY) continue;
    if (t >= gb && T.entries[t - gb][3] !== 0) continue;
    walk[k] = 1;
  }
  const slots = p.dbg.slots;
  for (let r = 0; r <= PLAN.finalSearch; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x < BORDER.x0 || y < BORDER.y0 || x > BORDER.x1 || y > BORDER.y1) continue;
        if (allow && !allow(x, y)) continue;
        const lx = x - x0, ly = y - y0;
        if (biomes && !biomes.includes(p.biome[ly * S + lx])) continue;
        let ok = true;
        for (let yy = -clear; yy <= clear && ok; yy++) for (let xx = -clear; xx <= clear; xx++) if (!walk[(ly + yy) * S + lx + xx]) { ok = false; break; }
        if (!ok) continue;
        let trees = 0;
        for (let s = 0; s < slots.length; s += 2) if (cheb(slots[s], slots[s + 1], x, y) <= 12) trees++;
        if (trees >= PLAN.finalTrees) return { x, y, trees, biome: p.biome[ly * S + lx] };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- the Wild World stronghold entrance (3.13, stage 6c)
// The stronghold's hand-built interior stays in the room band; only its entrance is planned. Candidates are coarse
// points 250 to 450 cells (Chebyshev) from the spawn, at least 48 cells inside the coast and the border, not Kanto;
// the first 64 in hash order. Each rung is tried over all of them (in that order) before the next is:
//   1. PLAINS or FOREST at least 64 cells from water, villages and caves;  2. the same with 32 cells from water;
//   3. the same with 16;  4. any temperate land point that is not rock, 16 cells from water, villages and caves;
//   5. the best candidate by rung 4's distances, with a larger forced clearing (always succeeds).
// Distances are coarse: water is a coarse sea or fresh-water point (cm.sea, cm.wet), counted in 8-cell steps.
// The entrance is the coarse point itself; the painter stamps the ruin around it (chunk.js setRuins).
const STRONGHOLD_GOOD = new Set([B.PLAINS, B.FOREST]);
const STRONGHOLD_TEMPERATE = new Set([B.PLAINS, B.FOREST, B.BIRCH_FOREST, B.DARK_FOREST]);
function placeStronghold(g, cm, villages, caves, spawn, stats) {
  const P = PLAN, n = cm.n, seed = g.seed, [lo, hi] = P.strongholdBand, m = P.strongholdInside;
  const water = new Uint8Array(n * n);
  for (let q = 0; q < n * n; q++) water[q] = cm.sea[q] | cm.wet[q];
  const dWater = chebDist(water, n);
  const pts = [];
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const q = j * n + i, x = i * COARSE, y = j * COARSE, d = cheb(x, y, spawn.x, spawn.y);
      if (d < lo || d > hi || cm.sea[q] || cm.kan[q] || cm.dSea[q] * COARSE < m) continue;
      if (x < BORDER.x0 + m || y < BORDER.y0 + m || x > BORDER.x1 - m || y > BORDER.y1 - m) continue;
      pts.push({ id: q, score: hash32(seed, K_STRONGHOLD, i, j), i, j, q, x, y });
    }
  }
  pts.sort(byScoreThenId);
  const cands = pts.slice(0, P.strongholdCands);
  stats.strongholdCands = cands.length;
  for (const c of cands) {
    let dv = 9999, dc = 9999;
    for (const v of villages) dv = Math.min(dv, rectDist(c.x, c.y, v));
    for (const k of caves) dc = Math.min(dc, rectDist(c.x, c.y, { x0: k.hill[0], y0: k.hill[1], w: k.hill[2], h: k.hill[3] + 3 }));
    c.dw = dWater[c.q] * COARSE; c.dv = dv; c.dc = dc;
  }
  const rungs = [
    (c) => STRONGHOLD_GOOD.has(cm.bio[c.q]) && !cm.rock[c.q] && c.dw >= 64 && c.dv >= 64 && c.dc >= 64,
    (c) => STRONGHOLD_GOOD.has(cm.bio[c.q]) && !cm.rock[c.q] && c.dw >= 32 && c.dv >= 64 && c.dc >= 64,
    (c) => STRONGHOLD_GOOD.has(cm.bio[c.q]) && !cm.rock[c.q] && c.dw >= 16 && c.dv >= 64 && c.dc >= 64,
    (c) => STRONGHOLD_TEMPERATE.has(cm.bio[c.q]) && !cm.rock[c.q] && c.dw >= 16 && c.dv >= 16 && c.dc >= 16,
  ];
  let pick = null, rung = 0;
  for (let r = 0; r < rungs.length && !pick; r++) {
    for (const c of cands) if (rungs[r](c)) { pick = c; rung = r + 1; break; }
  }
  if (!pick) {
    // rung 5: the candidate farthest (by the smallest of rung 4's three distances, temperate land first) from what
    // rung 4 avoids, in hash order on ties; with no candidate at all (never seen), the band's point nearest the
    // overworld's centre on the spawn's far side
    let best = -1;
    for (const c of cands) {
      const s = Math.min(c.dw, c.dv, c.dc, 400) + (STRONGHOLD_TEMPERATE.has(cm.bio[c.q]) && !cm.rock[c.q] ? 1000 : 0);
      if (s > best) { best = s; pick = c; }
    }
    rung = 5;
    if (!pick) {
      const dx = spawn.x < 800 ? 1 : -1, dy = spawn.y < 800 ? 1 : -1;
      pick = { x: Math.floor((spawn.x + dx * lo) / COARSE) * COARSE, y: Math.floor((spawn.y + dy * lo) / COARSE) * COARSE };
      pick.q = cIdx(cm, pick.x, pick.y);
      stats.strongholdFallback = true;
    }
  }
  stats.strongholdRung = rung;
  return { x: pick.x, y: pick.y, px: OX + pick.x, py: pick.y, rung, biome: BIOMES[cm.bio[pick.q]].key, ruin: ruinAt(pick.x, pick.y, rung) };
}

// The ruin around a Wild World stronghold entrance (3.13): a stamp of the supers (plain grass, no tall grass, no water,
// no tree within 2 cells: the meadow's rules) 16 x 16 cells around the entrance, 24 x 24 on rung 5's forced clearing.
// The painter draws the entrance's closed tile on the cell (its ground the open stairs), 8 mossy and cracked stone
// brick decorations on the ring at radius 3 with the south side open, and nothing else in the clearing.
export function ruinAt(x, y, rung) {
  const r = rung === 5 ? 12 : 8;
  const x0 = Math.floor((x - r) / 4) * 4, y0 = Math.floor((y - r) / 4) * 4;
  const x1 = -Math.floor(-(x + r) / 4) * 4, y1 = -Math.floor(-(y + r) / 4) * 4;
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- groups, rooms, maps, warps
const groupRect = (id, kind, ref, x, y, w, h) => {
  const cx0 = clamp(Math.floor((x - 2) / 32), 0, 49), cy0 = clamp(Math.floor((y - 2) / 32), 0, 49);
  const cx1 = clamp(Math.floor((x + w - 1 + 2) / 32), 0, 49), cy1 = clamp(Math.floor((y + h - 1 + 2) / 32), 0, 49);
  return { id, kind, ref, cx0, cy0, cx1, cy1 };
};

// shelf packing with a 1-cell void margin, area A then area B (3.11 step 8)
function packRooms(list, warnings) {
  let a = 0, x = 1, y = 1, shelf = 0;
  const out = [];
  for (const r of list) {
    for (;;) {
      if (a >= AREAS.length) break;
      const A = AREAS[a];
      if (x + r.w + 1 > A.w) { x = 1; y += shelf + 1; shelf = 0; }
      if (y + r.h + 1 > A.h) { a++; x = 1; y = 1; shelf = 0; continue; }
      break;
    }
    if (a >= AREAS.length) { warnings.push(`room ${r.id} does not fit`); out.push(null); continue; }
    const A = AREAS[a];
    out.push({ ...r, x: A.x + x, y: A.y + y, area: A.id });
    x += r.w + 1;
    if (r.h > shelf) shelf = r.h;
  }
  return out;
}

export function makePlan(g, opts = {}) {
  if (!g.coarse) throw new Error('makePlan needs makeGen without a given th (the coarse sample)');
  if (!g.paint) throw new Error('makePlan needs makeGen(..., { terrain }) for the spawn final test');
  const stats = { candidates: 0, spacing: 0, fine: 0, rejected: {}, caveCandidates: 0, spawnCoarse: [], classTests: 0, finalTests: 0, spawnFallback: false };
  const warnings = [];
  if (g.kantoCheck && !g.kantoCheck.pass) warnings.push(`Kanto's sea meets the ocean on only ${Math.floor(g.kantoCheck.share * 100)}% of its outward edge`);
  // opts.clock: an optional time source for the tools' breakdown (never read by the plan itself: 3.0 rule 1)
  const clock = opts.clock || null, ms = {};
  let t = clock ? clock() : 0;
  const lap = (k) => { if (clock) { const n = clock(); ms[k] = n - t; t = n; } };
  const outcrop = makeFbm(g.seed, 'paint.outcrop', 60, 2);   // the painter's outcrop layer (chunk.js preparePaint)
  const cm = coarseMaps(g);
  lap('coarse');
  setStamps(g, []);
  setCaveStamps(g, []);
  setRuins(g, []);
  const villages = placeVillages(g, cm, outcrop, stats);
  lap('villages');
  setStamps(g, villages.map((v) => ({ k: STAMP_VILLAGE, x0: v.x0, y0: v.y0, x1: v.x0 + v.w, y1: v.y0 + v.h })));
  // (6b) a Kanto World's openings before the caves, so a cave's hill keeps off their corridors (12 cells, as the
  // openings keep off villages)
  const openings = g.kanto ? planOpenings(g, stats, villages, [], cm) : null;
  const corrHit = openings && openings.length ? (mx, my) => openings.some((c) => {
    const k = g.kanto, x0 = k.x + c.corr[0] - 12, y0 = k.y + c.corr[1] - 12, x1 = k.x + c.corr[0] + c.corr[2] + 12, y1 = k.y + c.corr[1] + c.corr[3] + 12;
    return mx - 3 < x1 && mx + 4 > x0 && my - 4 < y1 && my + 4 > y0;
  }) : null;
  const caves = placeCaves(g, cm, villages, stats, corrHit);
  setCaveStamps(g, caveStampsOf(caves));   // (the spawn's final test paints the hills as the chunks will, 5b)
  lap('caves');
  // opts.minRung (tests only) starts the ladder at a later rung, so its rungs 2 to 4 can be tested on seeds that never need them
  // (6b) the land a Kanto World's openings reach (they were applied before the caves, so before the spawn's tests paint)
  const reach = openings ? openingReach(g, cm, openings) : null;
  if (openings && !reach) warnings.push('no opening out of Kanto was kept');
  lap('openings');
  const sp = spawnSearch(g, cm, villages, caves, outcrop, stats, clock ? (k) => lap(k) : null, opts.minRung || 1, reach);
  lap('spawn');
  const spawn = { x: sp.x, y: sp.y, px: OX + sp.x, py: sp.y, rung: sp.rung, biome: sp.biome };
  if (sp.rung === 4 && !sp.finalOk) warnings.push('the spawn meadow failed its final test');
  // the Wild World stronghold entrance (3.13, stage 6c), after the spawn it is measured from; its ruin stamp joins the
  // others in attachPlan's order (villages, the meadow, the ruin)
  const stronghold = g.type === 'wild' ? placeStronghold(g, cm, villages, caves, sp, stats) : null;
  if (stronghold) {
    const r = stronghold.ruin;
    setStamps(g, [...(g.stamps || []), { k: STAMP_RUIN, x0: r.x0, y0: r.y0, x1: r.x0 + r.w, y1: r.y0 + r.h }]);
    setRuins(g, [{ x: stronghold.x, y: stronghold.y }]);
    if (stronghold.rung === 5) warnings.push('the stronghold entrance needed a forced clearing');
  }
  lap('stronghold');

  // structure groups (2.4)
  const groups = [];
  for (const v of villages) groups.push(groupRect(groups.length, 'village', v.id, v.x0, v.y0, v.w, v.h));
  for (const c of caves) groups.push(groupRect(groups.length, 'cave', c.id, c.hill[0], c.hill[1], c.hill[2], c.hill[3]));
  if (sp.meadow) groups.push(groupRect(groups.length, 'meadow', 0, sp.meadow.x0, sp.meadow.y0, sp.meadow.w, sp.meadow.h));
  if (stronghold) groups.push(groupRect(groups.length, 'ruin', 0, stronghold.ruin.x0, stronghold.ruin.y0, stronghold.ruin.w, stronghold.ruin.h));

  // rooms: caves (B1F then B2F) in id order, then house interiors in village order
  const want = [];
  for (const c of caves) {
    want.push({ id: `GEN_CAVE_${c.id}_B1F`, kind: 'cave', ref: c.id, floor: 1, ...CAVE_B1 });
    if (c.b2) want.push({ id: `GEN_CAVE_${c.id}_B2F`, kind: 'cave', ref: c.id, floor: 2, ...CAVE_B2 });
  }
  for (const v of villages) for (const h of v.houses) want.push({ id: `GEN_HOUSE_${v.id}_${h.id}`, kind: 'house', ref: v.id, house: h.id, floor: 0, w: INTERIORS[h.room].w, h: INTERIORS[h.room].h });
  const packed = packRooms(want, warnings);
  const rooms = [];
  for (let i = 0; i < want.length; i++) {
    if (packed[i]) { rooms.push(packed[i]); continue; }
    if (want[i].kind === 'cave') throw new Error('cave rooms must always fit');
  }
  const demand = want.reduce((s, r) => s + r.w * r.h, 0);
  const roomOf = new Map(rooms.map((r) => [r.id, r]));

  // maps (2.10, 3.11 step 9): one per biome, then one per room in slot order
  const maps = [];
  for (const b of BIOMES) {
    if (b.id === 0 || b.id === B.KANTO) continue;
    maps.push({ id: mapIdOfBiome(b.id), mapsec: mapIdOfBiome(b.id), name: b.name, type: 'MAP_TYPE_ROUTE', kind: 'outdoor', room: false,
      gen: true, biome: b.key.toLowerCase(), music: MUSIC_OF[b.key], wild: 'GEN_' + WILD_OF[b.key], terrain: TERRAIN_OF(b),
      depth: 0, show: true, flash: false, parent: null });
  }
  const parentOf = (key) => 'GEN_' + key;
  for (const r of rooms) {
    if (r.kind === 'cave') {
      const c = caves[r.ref];
      maps.push({ id: r.id, mapsec: 'GEN_CAVE', name: 'CAVE', type: 'MAP_TYPE_UNDERGROUND', x: r.x, y: r.y, w: r.w, h: r.h, kind: 'cave',
        room: true, gen: true, depth: r.floor, music: 'MUS_MT_MOON', wild: r.floor === 1 ? 'GEN_CAVE1' : 'GEN_CAVE2', family: c.family,
        show: true, flash: r.floor === 2, parent: parentOf(c.biome) });
    } else {
      const v = villages[r.ref];
      maps.push({ id: r.id, mapsec: 'GEN_VILLAGE', name: 'VILLAGE', type: 'MAP_TYPE_INDOOR', x: r.x, y: r.y, w: r.w, h: r.h, kind: 'indoor',
        room: true, gen: true, depth: 0, music: MUSIC_OF[v.biome], show: false, flash: false, parent: parentOf(v.biome) });
    }
  }

  // warps (3.11 step 10), Kanto's pattern: a door (bump) arrives on its interior mat, and the mat (arrowS) walks out
  // through the door; a cave mouth (step) arrives on the B1F exit (arrowS); ladders (step) arrive on each other
  const warps = [];
  const add = (w) => { warps.push(w); return WARP_BASE + warps.length - 1; };
  const pair = (a, b) => {
    const ia = add({ ...a, to: 0 }), ib = add({ ...b, to: 0 });
    warps[ia - WARP_BASE].to = ib; warps[ib - WARP_BASE].to = ia;
    warps[ia - WARP_BASE].ax = b.x; warps[ia - WARP_BASE].ay = b.y;
    warps[ib - WARP_BASE].ax = a.x; warps[ib - WARP_BASE].ay = a.y;
  };
  for (const c of caves) {
    const b1 = roomOf.get(`GEN_CAVE_${c.id}_B1F`), b2 = roomOf.get(`GEN_CAVE_${c.id}_B2F`);
    const exit = { x: b1.x + (b1.w >> 1), y: b1.y + b1.h - 3 };
    pair({ x: OX + c.x, y: c.y, map: parentOf(c.biome), trig: 'step', dest: b1.id, adir: 'up', amove: 'none', door: null },
      { x: exit.x, y: exit.y, map: b1.id, trig: 'arrowS', dest: parentOf(c.biome), adir: 'down', amove: 'walk', door: null });
    if (b2) {
      pair({ x: b1.x + (b1.w >> 1), y: b1.y + 2, map: b1.id, trig: 'step', dest: b2.id, adir: null, amove: 'none', door: null },
        { x: b2.x + (b2.w >> 1), y: b2.y + b2.h - 3, map: b2.id, trig: 'step', dest: b1.id, adir: null, amove: 'none', door: null });
    }
  }
  for (const v of villages) {
    for (const h of v.houses) {
      const r = roomOf.get(`GEN_HOUSE_${v.id}_${h.id}`);
      if (!r) continue;   // overflow: the house keeps a closed door
      pair({ x: OX + h.door[0], y: h.door[1], map: parentOf(v.biome), trig: 'bump', dest: r.id, adir: 'up', amove: 'none', door: null },
        { x: r.x + INTERIORS[h.room].mat[0], y: r.y + INTERIORS[h.room].mat[1], map: r.id, trig: 'arrowS', dest: parentOf(v.biome), adir: 'down', amove: 'walk', door: null });
    }
  }
  // arrival fields in the order Kanto's warps list them
  const W = warps.map((w) => ({ x: w.x, y: w.y, map: w.map, trig: w.trig, to: w.to, dest: w.dest, ax: w.ax, ay: w.ay, adir: w.adir, amove: w.amove, door: w.door }));

  const json = {
    v: GEN_VERSION, type: g.type, seed: g.seed, th: g.th,
    // (6a) the placement and its plan check: the share of Kanto's outward sea cells that face the world's ocean, in
    // thousandths (index.js kantoSeaCheck)
    kanto: g.kanto ? { x: g.kanto.x, y: g.kanto.y, w: g.kanto.w, h: g.kanto.h, sea: g.kantoCheck ? Math.floor(g.kantoCheck.share * 1000 + 0.5) : null } : null,
    villages, caves, spawn, meadow: sp.meadow, groups, rooms, maps, warps: W, mapBase: MAP_BASE, warpBase: WARP_BASE,
    // (6c) the Wild World stronghold entrance and its ruin (undefined in a Kanto World, so its hash is unchanged)
    stronghold: stronghold || undefined,
    // (6b) a Kanto World's kept openings (undefined in a Wild World, so its hash is unchanged), overworld-local: the
    // candidate's id (kanto.js, seed-independent), its kind, the void cell it opens on, the map cell it reaches, the
    // outward normal, the corridor [x0, y0, w, h] and the box [x0, y0, x1, y1] (inclusive) of the Kanto cells it re-tiles
    openings: openings ? openings.map((c) => openingRecord(g.kanto, c)) : undefined,
  };
  const plan = { json, hash: planHash(json), cm, stats, warnings, demand, groupsOf: groupsByChunk(groups), ms };
  attachPlan(g, plan);
  lap('rest');
  return plan;
}

function openingRecord(k, c) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < c.cells.length; i += 2) { x0 = Math.min(x0, c.cells[i]); x1 = Math.max(x1, c.cells[i]); y0 = Math.min(y0, c.cells[i + 1]); y1 = Math.max(y1, c.cells[i + 1]); }
  return { id: c.id, kind: c.kind, dir: c.dir, n: c.n.slice(), out: [k.x + c.out[0], k.y + c.out[1]], in: [k.x + c.in[0], k.y + c.in[1]],
    corr: [k.x + c.corr[0], k.y + c.corr[1], c.corr[2], c.corr[3]], box: [k.x + x0, k.y + y0, k.x + x1, k.y + y1] };
}

// chunk key (overworld-local cy * 50 + cx) -> group ids, for the streaming code (4a)
function groupsByChunk(groups) {
  const m = new Map();
  for (const gr of groups) {
    for (let cy = gr.cy0; cy <= gr.cy1; cy++) for (let cx = gr.cx0; cx <= gr.cx1; cx++) {
      const k = cy * 50 + cx;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(gr.id);
    }
  }
  return m;
}

// The stamps the chunk painter honours: village bounds, the spawn meadow and the cave hills (5b).
export function attachPlan(g, plan) {
  const j = plan.json || plan;
  const list = j.villages.map((v) => ({ k: STAMP_VILLAGE, x0: v.x0, y0: v.y0, x1: v.x0 + v.w, y1: v.y0 + v.h }));
  if (j.meadow) list.push({ k: STAMP_MEADOW, x0: j.meadow.x0, y0: j.meadow.y0, x1: j.meadow.x0 + j.meadow.w, y1: j.meadow.y0 + j.meadow.h, grove: j.meadow.grove });
  // (6c) the stronghold's ruin, last, as makePlan stamps it
  const sh = j.stronghold;
  if (sh) list.push({ k: STAMP_RUIN, x0: sh.ruin.x0, y0: sh.ruin.y0, x1: sh.ruin.x0 + sh.ruin.w, y1: sh.ruin.y0 + sh.ruin.h });
  setStamps(g, list);
  setCaveStamps(g, caveStampsOf(j.caves || []));
  setRuins(g, sh ? [{ x: sh.x, y: sh.y }] : []);
  // (6b) a Kanto World's kept openings, from their seed-independent candidates
  if (g.kanto && g.kanto.ctx && j.openings && g.kantoGrid && g.kantoMat) {
    const cands = kantoOpeningCands(g.kanto.ctx, g.kantoGrid, g.kantoMat), k = g.kanto;
    // (each with the plan's own corridor: it may be longer than the candidate's)
    g.kanto.open = openingState(k, j.openings.filter((o) => cands[o.id]).map((o) => ({ ...cands[o.id], corr: [o.corr[0] - k.x, o.corr[1] - k.y, o.corr[2], o.corr[3]] })));
  }
  g.plan = j;
}

// ---------------------------------------------------------------- canonical JSON and the hash (9.1)
export function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('plan JSON: a number that is not finite');
    return JSON.stringify(v);
  }
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return '[' + Array.from(v, canonical).join(',') + ']';
  const own = Object.keys(v), sig = own.join('\u0001');
  let keys = KEY_ORDER.get(sig);
  if (!keys) { keys = own.slice().sort(cmpStr); KEY_ORDER.set(sig, keys); }
  let out = '{', first = true;
  for (const k of keys) {
    if (v[k] === undefined) continue;
    out += (first ? '' : ',') + JSON.stringify(k) + ':' + canonical(v[k]);
    first = false;
  }
  return out + '}';
}
// sorted key lists by an object's own key order (the plan's records share a few shapes)
const KEY_ORDER = new Map();

export function planJSON(plan) { return canonical(plan.json || plan); }

// 16 hex digits: FNV-1a over the UTF-8 bytes and a murmur-mixed hash of the UTF-16 code units
export function planHash(json) {
  const s = canonical(json);
  let h = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    let k = Math.imul(s.charCodeAt(i), 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, 0x1b873593);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= s.length; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(fnv1a(s)) + hex(h);
}
