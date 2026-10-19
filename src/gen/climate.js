// Climate layers on the 4-cell lattice (design 3.2): continentalness with the island falloff, temperature with
// a seed-chosen gradient, humidity, mountains, rivers, lakes, the beach and river width fields; the per-world
// quantile thresholds from the 200 x 200 coarse grid; and the evaluation of a lattice window.
//
// Coordinates are overworld-local cells (0..1599); lattice point (lx, ly) is cell (4 lx, 4 ly). A lattice
// point's fields are a pure function of (seed, lx, ly), so any window of the lattice gives the same values.
import { DIR8, hash32, fnv1a } from './hash.js';
import { makeFbm, makeRidged, fbm, ridged, clamp, smooth } from './noise.js';
import { sortedNums, quantileSorted, knots } from './order.js';

export const LAT = 4;          // cells per lattice step
export const OW = 1600;        // overworld size in cells
export const COARSE = 8;       // the plan's coarse grid samples every 8th cell (every 2nd lattice point)

// Tuned values (starting points from the prototype's gen.py, adjusted against the 3a overviews)
export const CLIMATE = Object.freeze({
  warpAmp: 140, warpWave: 380,
  contWave: 760, falloffDrop: 1.15, falloffMin: 150, falloffSpan: 80, falloffWave: 500, cornerR: 320,
  shoreDrop: 1.0, shoreStart: 110, edgeWobble: 24, edgeWobbleWave: 120,
  guardEdge: 24, guardRamp: 16, guardDrop: 3,
  deepEdge: 56, deepEdgeAmp: 14, deepEdgeWave: 90,
  tempWave: 820, tempGrad: 0.30, humWave: 640,
  mountWave: 300, mountRangeWave: 520,
  riverWave: 560, riverWarpAmp: 60, riverWarpWave: 200, riverWidthWave: 300,
  lakeWave: 150, beachWave: 90,
  // quantiles (3.2): deep ocean, ocean over all coarse points; rock, mountains, core, river fade over land
  qDeep: 0.10, qOcean: 0.24, qRock: 0.86, qMount: 0.95, qCore: 0.97, qRiverFade: 0.70, qLake: 0.03,
});

// `w` holds the detail noise settings (region.js WATER: jitterWave, jitterOct, shiftWave, shiftOct).
export function makeLayers(seed, w) {
  const c = CLIMATE, s = seed | 0;
  return {
    wx: makeFbm(s, 'warp.x', c.warpWave, 3), wy: makeFbm(s, 'warp.y', c.warpWave, 3),
    cont: makeFbm(s, 'cont', c.contWave, 4), fall: makeFbm(s, 'falloff', c.falloffWave, 2),
    temp: makeFbm(s, 'temp', c.tempWave, 3), hum: makeFbm(s, 'hum', c.humWave, 3),
    mount: makeRidged(s, 'mount', c.mountWave, 4), mrange: makeFbm(s, 'mount.range', c.mountRangeWave, 2),
    rwx: makeFbm(s, 'river.warp.x', c.riverWarpWave, 2), rwy: makeFbm(s, 'river.warp.y', c.riverWarpWave, 2),
    river: makeFbm(s, 'river', c.riverWave, 3), rwidth: makeFbm(s, 'river.width', c.riverWidthWave, 2),
    lake: makeFbm(s, 'lake', c.lakeWave, 3), beach: makeFbm(s, 'beach', c.beachWave, 2),
    jx: makeFbm(s, 'jitter.x', w.jitterWave, w.jitterOct), jy: makeFbm(s, 'jitter.y', w.jitterWave, w.jitterOct),
    sn: makeFbm(s, 'shift', w.shiftWave, w.shiftOct),
    kpull: makeFbm(s, 'kanto.pull', 90, 2), ewob: makeFbm(s, 'edge.wobble', c.edgeWobbleWave, 2),
    dedge: makeFbm(s, 'deep.edge', c.deepEdgeWave, 2), kedge: makeFbm(s, 'kanto.edge', 60, 2),
    tdir: DIR8[hash32(s, fnv1a('temp.dir')) & 7],
  };
}

// Distance in cells to the nearest overworld edge, with the corners rounded (radius cornerR), so the island's
// falloff contours have no right-angled corners.
export function edgeDist(px, py) {
  const R = CLIMATE.cornerR;
  const dx = px < OW - 1 - px ? px : OW - 1 - px;
  const dy = py < OW - 1 - py ? py : OW - 1 - py;
  if (dx < R && dy < R) {
    const ax = R - dx, ay = R - dy;
    return R - Math.sqrt(ax * ax + ay * ay);
  }
  return dx < dy ? dx : dy;
}

// The edge distance as the island's falloff sees it: wobbled by 24 cells of 1/120 noise, so no contour of the
// falloff (the coast, the shelf, the deep water's edge) ever runs parallel to the overworld's straight edge.
export function edgeDistW(L, px, py) {
  return edgeDist(px, py) + CLIMATE.edgeWobble * fbm(L.ewob, px, py);
}

// The island falloff (3.2): C drops by up to 1.15 over the outer 150 to 230 cells (an organic start), and by
// up to 1.0 more over the outer 110, so even the highest land meets the sea at least about 60 cells from the edge.
// FALL_FREE: with the edge distance at least this far in, both terms are exactly 0 whatever the wobble and the start
// noise (the wobble moves e by at most edgeWobble cells, the start s is at most falloffMin + falloffSpan, shoreStart
// is smaller), so the noise is not evaluated there (stage 3c: the result is the same number, 0)
const FALL_FREE = CLIMATE.falloffMin + CLIMATE.falloffSpan + 2 * CLIMATE.edgeWobble;
export function falloff(L, px, py) {
  if (edgeDist(px, py) >= FALL_FREE) return 0;
  const c = CLIMATE, e = edgeDistW(L, px, py);
  const s = c.falloffMin + c.falloffSpan * clamp(fbm(L.fall, px, py) + 0.5, 0, 1);
  return c.falloffDrop * smooth(clamp((s - e) / s, 0, 1)) + c.shoreDrop * smooth(clamp((c.shoreStart - e) / c.shoreStart, 0, 1));
}

// The edge guard, applied per cell after the quantiles: within 24 to 40 cells of the edge C is pushed far
// under the ocean threshold, so the border (8 cells in) is always sea. The falloff alone already makes this sea
// on every seed tried; the guard only makes it certain, and it is not part of the quantile sample.
export function edgeGuard(px, py) {
  const c = CLIMATE;
  return c.guardDrop * smooth(clamp((c.guardEdge + c.guardRamp - edgeDist(px, py)) / c.guardRamp, 0, 1));
}

// Deep ocean also lies beyond a noise contour of the edge distance: the field E = wobbled edge distance + 14 cells
// of 1/90 noise is under 56 there (about 42 to 70 cells in), so the last 30 cells before the edge are always
// deep and the deep water's inner edge is a natural curve (3.2, 3.5). region.js turns E into a signed distance.
export function edgeField(L, px, py, n) {
  return edgeDistW(L, px, py) + CLIMATE.deepEdgeAmp * n;
}

// The raw fields of one point (cells px, py), in two parts so a chunk evaluates the expensive wide apron only
// for what the biome filters need:
//   climateAt: T, H, M (the biome table's inputs; `o.wx`, `o.wy` keep the warped position for C)
//   waterAt:   C, L, E, KE, R, RW, BW (continentalness, lakes, the edge contour, Kanto's, rivers, widths)
export function climateAt(L, px, py, o) {
  const c = CLIMATE;
  const wx = px + c.warpAmp * fbm(L.wx, px, py), wy = py + c.warpAmp * fbm(L.wy, px, py);
  o.wx = wx; o.wy = wy;
  const d = L.tdir, len = d[0] !== 0 && d[1] !== 0 ? Math.sqrt(2) : 1;
  o.T = fbm(L.temp, wx, wy) + c.tempGrad * (((px - 800) * d[0] + (py - 800) * d[1]) / (1600 * len));
  o.H = fbm(L.hum, wx, wy);
  o.M = ridged(L.mount, wx, wy) * (0.6 + 0.4 * clamp(fbm(L.mrange, px, py) + 0.4, 0, 1));
  if (L.kinf) L.kinf.M(px, py, o);   // Kanto's influence field (kanto.js, stage 6a; set after the thresholds)
  return o;
}

export function waterAt(L, px, py, o, full = true) {
  const c = CLIMATE;
  o.C = fbm(L.cont, o.wx, o.wy) - falloff(L, px, py);
  if (L.kinf) L.kinf.C(px, py, o);
  o.L = fbm(L.lake, px, py);
  if (!full) return o;
  o.E = edgeField(L, px, py, fbm(L.dedge, px, py));
  o.KE = fbm(L.kedge, px, py);
  const rx = px + c.riverWarpAmp * fbm(L.rwx, px, py), ry = py + c.riverWarpAmp * fbm(L.rwy, px, py);
  o.R = fbm(L.river, rx, ry);
  o.RW = fbm(L.rwidth, px, py);
  o.BW = fbm(L.beach, px, py);
  return o;
}

export function fieldsAt(L, px, py, o, full = true) {
  climateAt(L, px, py, o);
  return waterAt(L, px, py, o, full);
}

// The coarse grid (3.2, 3.11 step 2): the threshold fields at every 8th cell of the overworld (200 x 200 lattice
// points with even indices). The plan (plan.js) keeps it and reads its biome and water maps from it.
export function sampleCoarse(L) {
  const n = OW / COARSE, o = {};
  const C = new Float64Array(n * n), T = new Float64Array(n * n), H = new Float64Array(n * n);
  const M = new Float64Array(n * n), LK = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      fieldsAt(L, i * COARSE, j * COARSE, o, false);
      const k = j * n + i;
      C[k] = o.C; T[k] = o.T; H[k] = o.H; M[k] = o.M; LK[k] = o.L;
    }
  }
  return { n, step: COARSE, C, T, H, M, LK };
}

// The per-world thresholds (3.2) from the coarse grid. Quantiles by order.js (index floor(q (n - 1)) of a
// total-order sort). T and H become 101 knots each, so t and h are ranks over land in 0..1.
export function thresholdsFrom(S) {
  const c = CLIMATE, n = S.n, { C, T, H, M, LK } = S;
  const sc = sortedNums(C);
  const cDeep = quantileSorted(sc, c.qDeep), cOcean = quantileSorted(sc, c.qOcean);
  // the land points' T, H and M in index order (typed arrays: the same values as lists, sorted faster)
  let nl = 0;
  for (let k = 0; k < n * n; k++) if (C[k] >= cOcean) nl++;
  const lt = new Float64Array(nl), lh = new Float64Array(nl), lm = new Float64Array(nl);
  for (let k = 0, m = 0; k < n * n; k++) if (C[k] >= cOcean) { lt[m] = T[k]; lh[m] = H[k]; lm[m] = M[k]; m++; }
  const sm = sortedNums(lm);
  const mRock = quantileSorted(sm, c.qRock);
  const ll = [];
  for (let k = 0; k < n * n; k++) if (C[k] >= cOcean && M[k] < mRock) ll.push(LK[k]);
  return {
    cDeep, cOcean,
    tK: knots(sortedNums(lt)), hK: knots(sortedNums(lh)),
    mRock, mMount: quantileSorted(sm, c.qMount), mCore: quantileSorted(sm, c.qCore),
    mRiverFade: quantileSorted(sm, c.qRiverFade),
    lLake: quantileSorted(sortedNums(ll), c.qLake),
    land: nl / (n * n),
  };
}

export function computeThresholds(L) {
  return thresholdsFrom(sampleCoarse(L));
}

// The few fields the plan's village site test reads at a lattice point (3.11 step 4): C, M, L, R and RW exactly as
// climateAt and waterAt compute them (the same expressions, so the same numbers), without the ones it does not need
// (river false: without R and RW).
export function siteFieldsAt(L, px, py, o, river = true) {
  const c = CLIMATE;
  const wx = px + c.warpAmp * fbm(L.wx, px, py), wy = py + c.warpAmp * fbm(L.wy, px, py);
  o.M = ridged(L.mount, wx, wy) * (0.6 + 0.4 * clamp(fbm(L.mrange, px, py) + 0.4, 0, 1));
  o.C = fbm(L.cont, wx, wy) - falloff(L, px, py);
  if (L.kinf) { L.kinf.M(px, py, o); L.kinf.C(px, py, o); }
  o.L = fbm(L.lake, px, py);
  if (!river) return o;
  const rx = px + c.riverWarpAmp * fbm(L.rwx, px, py), ry = py + c.riverWarpAmp * fbm(L.rwy, px, py);
  o.R = fbm(L.river, rx, ry);
  o.RW = fbm(L.rwidth, px, py);
  return o;
}

// M alone at a point (the plan's rock tests)
export function mountAt(L, px, py) {
  const c = CLIMATE;
  const wx = px + c.warpAmp * fbm(L.wx, px, py), wy = py + c.warpAmp * fbm(L.wy, px, py);
  const m = ridged(L.mount, wx, wy) * (0.6 + 0.4 * clamp(fbm(L.mrange, px, py) + 0.4, 0, 1));
  if (!L.kinf) return m;
  const o = { M: m }; L.kinf.M(px, py, o);
  return o.M;
}

// R alone at a point (the plan's coarse river test)
export function riverAt(L, px, py) {
  const c = CLIMATE;
  const rx = px + c.riverWarpAmp * fbm(L.rwx, px, py), ry = py + c.riverWarpAmp * fbm(L.rwy, px, py);
  return fbm(L.river, rx, ry);
}
