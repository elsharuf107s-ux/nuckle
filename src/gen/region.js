// Stage 3a's region generator: biomes and water for any rectangle of the overworld (design 3.2 to 3.5, the
// first rule of 3.4). A data chunk is genRegion(g, 32 cx, 32 cy, 32, 32); a whole-world overview is one region.
// Every output cell depends only on lattice points within the radius budget (radius.js), so a region and the
// chunks that tile it are byte-identical (the seam test).
//
// Per cell it returns:
//   biome  the cell's biome id (biomes.js), water biomes and shores included
//   land   the land biome under the cell (what the cell would be without water or shore)
//   water  W_NONE, W_OCEAN, W_DEEP, W_RIVER or W_LAKE
import { LAT, CLIMATE, OW, climateAt, waterAt, edgeGuard } from './climate.js';
import { B, classify, majority, hubRule, isSnowy, isRock } from './biomes.js';
import { fbm, clamp, smooth, lerp } from './noise.js';
import { rankOf } from './order.js';
import { LAT_APRON, WATER_REACH } from './radius.js';
import { kantoBoxDist } from './kanto.js';

export const W_NONE = 0, W_OCEAN = 1, W_DEEP = 2, W_RIVER = 3, W_LAKE = 4;
export const WATER_NAMES = ['none', 'ocean', 'deep', 'river', 'lake'];

export const WATER = Object.freeze({
  // Boundaries never follow a lattice line or a straight contour: the land biome is the nearest lattice point of
  // the cell displaced by `jitter` cells of the 1/20 and 1/10 detail noise (radius.js cellLookup), and every water
  // boundary is shifted along its normal by `shift` cells of the 1/20, 1/10 and 1/5 detail noise (3.2). Coasts and
  // rivers take the shift at the cell's foot on the contour, so both banks of a river and both edges of a beach
  // move together and widths stay what the fields say (footReach: beyond it nothing depends on the shift).
  jitter: 12, jitterWave: 20, jitterOct: 2,
  shift: 8, shiftWave: 20, shiftOct: 3, footReach: 40,
  beachMin: 3, beachMax: 6, shelfMin: 10, shelfMax: 20,
  riverMin: 1.5, riverMax: 3.5,   // half widths: rivers are 3 to 7 cells wide
  riverEndAt: 0.5,       // rivers end where M is half way from its 70th to its rock (86th) percentile
  noDeepNearKanto: 48, noFreshNearKanto: 16, kantoEdgeAmp: 16, kantoEdgeDeep: 14,
  coldOcean: 0.12, kantoPull: 170, kantoT: 0.55, kantoH: 0.30,
});

// Evaluate a lattice window: points lx0 .. lx0 + lw - 1, ly0 .. ly0 + lh - 1. The biome inputs (T, H, M) are
// evaluated on the whole window; the water fields only `inner` points in from its edge (they feed only the
// gradient and the interpolation, radius 2), which saves most of the work. Returns the fields, the quantile
// ranks, the climate biome after smoothing and the hub rule, and the gradient magnitudes.
export function evalLattice(g, lx0, ly0, lw, lh, inner = LAT_APRON - WATER_REACH) {
  const n = lw * lh, th = g.th, L = g.layers;
  const C = new Float64Array(n), M = new Float64Array(n), R = new Float64Array(n);
  const RW = new Float64Array(n), LK = new Float64Array(n), BW = new Float64Array(n);
  const E = new Float64Array(n), KE = new Float64Array(n);
  const t = new Float64Array(n), h = new Float64Array(n);
  const Wt = g.W || WATER;
  const raw = new Uint8Array(n);
  const o = {};
  const k = g.kanto;
  // an optional per-world cache of the raw point fields (makeGen's inputs.cache): a point's fields are a pure
  // function of the point, so a cached value is exactly the computed one; streaming chunks share their aprons
  const cc = g.latCache;
  for (let j = 0; j < lh; j++) {
    for (let i = 0; i < lw; i++) {
      const p = j * lw + i, px = (lx0 + i) * LAT, py = (ly0 + j) * LAT;
      const needW = i >= inner && j >= inner && i < lw - inner && j < lh - inner;
      const ci = cc ? cacheIndex(cc, lx0 + i, ly0 + j) : -1;
      if (ci >= 0 && cc.flag[ci] >= (needW ? 2 : 1)) {
        M[p] = cc.M[ci]; t[p] = cc.t[ci]; h[p] = cc.h[ci]; raw[p] = cc.raw[ci];
        if (needW) { C[p] = cc.C[ci]; R[p] = cc.R[ci]; RW[p] = cc.RW[ci]; LK[p] = cc.LK[ci]; BW[p] = cc.BW[ci]; E[p] = cc.E[ci]; KE[p] = cc.KE[ci]; }
        continue;
      }
      pointClimate(g, px, py, o);
      M[p] = o.M;
      if (needW) {
        waterAt(L, px, py, o, true);
        C[p] = o.C; R[p] = o.R; RW[p] = o.RW; LK[p] = o.L; BW[p] = o.BW; E[p] = o.E; KE[p] = o.KE;
      }
      const tr = o.tr, hr = o.hr;
      t[p] = tr; h[p] = hr;
      raw[p] = o.raw;
      if (ci >= 0) {
        cc.M[ci] = M[p]; cc.t[ci] = tr; cc.h[ci] = hr; cc.raw[ci] = raw[p];
        if (needW) { cc.C[ci] = C[p]; cc.R[ci] = R[p]; cc.RW[ci] = RW[p]; cc.LK[ci] = LK[p]; cc.BW[ci] = BW[p]; cc.E[ci] = E[p]; cc.KE[ci] = KE[p]; }
        cc.flag[ci] = needW ? 2 : 1;
      }
    }
  }
  const bio = hubRule(majority(majority(raw, lw, lh), lw, lh), h, lw, lh);
  // gradients per cell (central differences), for the signed distances to the coast, river, lake, rock and edge
  // contours: f / |grad f| is in cells, so widths are cells, not field units. C and R keep their components (the
  // foot of a cell on the coast or a river's centre line is cell - d * grad / |grad|); the others their magnitude.
  const gCx = new Float64Array(n), gCy = new Float64Array(n), gRx = new Float64Array(n), gRy = new Float64Array(n);
  const gL = new Float64Array(n), gE = new Float64Array(n), gM = new Float64Array(n);
  const gKx = new Float64Array(n), gKy = new Float64Array(n);
  const inv = 1 / (2 * LAT);
  const mag = (F, p) => { const gx = (F[p + 1] - F[p - 1]) * inv, gy = (F[p + lw] - F[p - lw]) * inv; return Math.sqrt(gx * gx + gy * gy); };
  const i0 = Math.max(1, inner + 1);
  for (let j = i0; j < lh - i0; j++) {
    for (let i = i0; i < lw - i0; i++) {
      const p = j * lw + i;
      gCx[p] = (C[p + 1] - C[p - 1]) * inv; gCy[p] = (C[p + lw] - C[p - lw]) * inv;
      gRx[p] = (R[p + 1] - R[p - 1]) * inv; gRy[p] = (R[p + lw] - R[p - lw]) * inv;
      gL[p] = mag(LK, p); gE[p] = mag(E, p); gM[p] = mag(M, p);
      gKx[p] = (KE[p + 1] - KE[p - 1]) * inv; gKy[p] = (KE[p + lw] - KE[p - lw]) * inv;
    }
  }
  return { lx0, ly0, lw, lh, C, M, R, RW, LK, BW, E, KE, t, h, raw, bio, gCx, gCy, gRx, gRy, gL, gE, gM, gKx, gKy };
}

// One lattice point's climate (cells px, py): o.M, o.tr and o.hr (t and h as ranks over land, with Kanto's pull) and
// o.raw (the biome table's answer before smoothing). evalLattice and the painter's lazy biome field share it.
export function pointClimate(g, px, py, o) {
  const th = g.th, L = g.layers, k = g.kanto, Wt = g.W || WATER;
  climateAt(L, px, py, o);
  let tr = rankOf(th.tK, o.T), hr = rankOf(th.hK, o.H);
  if (k) {
    // Kanto sits in temperate land: t and h are pulled toward plains and forest near it (3.12)
    const dk = kantoBoxDist(k, px, py) + 60 * (fbm(L.kpull, px, py) + 0.3);
    const a = smooth(clamp(1 - dk / Wt.kantoPull, 0, 1));
    tr = lerp(tr, Wt.kantoT, a); hr = lerp(hr, Wt.kantoH, a);
  }
  o.tr = tr; o.hr = hr;
  o.raw = classify(tr, hr, o.M >= th.mRock, o.M >= th.mMount);
  return o;
}

// The per-world lattice cache (points -64 .. 463 in both axes, about 22 MB): makeGen creates it when asked.
export function makeLatticeCache() {
  const n = 528, N = n * n;
  const f = () => new Float64Array(N);
  return { o: -64, n, flag: new Uint8Array(N), M: f(), t: f(), h: f(), raw: new Uint8Array(N), C: f(), R: f(), RW: f(), LK: f(), BW: f(), E: f(), KE: f() };
}
function cacheIndex(cc, lx, ly) {
  const x = lx - cc.o, y = ly - cc.o;
  return x >= 0 && y >= 0 && x < cc.n && y < cc.n ? y * cc.n + x : -1;
}

// The lattice window a region needs (its points plus the apron).
export function latticeWindow(x0, y0, w, h) {
  const lx0 = Math.floor(x0 / LAT) - LAT_APRON, ly0 = Math.floor(y0 / LAT) - LAT_APRON;
  const lx1 = Math.floor((x0 + w - 1) / LAT) + 1 + LAT_APRON, ly1 = Math.floor((y0 + h - 1) / LAT) + 1 + LAT_APRON;
  return { lx0, ly0, lw: lx1 - lx0 + 1, lh: ly1 - ly0 + 1 };
}

const EPS = 1e-9;

// The per-cell context of a lattice window (cellAt reads it); `lat` comes from evalLattice.
export function cellContext(g, lat) {
  const th = g.th, Wt = g.W || WATER;
  const mEnd = th.mRiverFade + Wt.riverEndAt * (th.mRock - th.mRiverFade);
  return { g, lat, th, L: g.layers, k: g.kanto, Wt, mEnd, fadeSpan: mEnd - th.mRiverFade };
}

const pack = (b, l, wt) => b | (l << 8) | (wt << 16);
export const unpackBiome = (v) => v & 255, unpackLand = (v) => (v >> 8) & 255, unpackWater = (v) => v >> 16;

// One cell's biome, land biome and water (packed: biome | land << 8 | water << 16), a pure function of the cell
// and the lattice (any window that covers the cell with its apron gives the same value).
export function cellAt(ctx, x, y) {
  const { lat, th, L, k, Wt, mEnd, fadeSpan } = ctx;
  const { lx0, ly0, lw, C, M, R, RW, LK, BW, E, KE, t, bio, gCx, gCy, gRx, gRy, gL, gE, gM, gKx, gKy } = lat;
  const ly = Math.floor(y / LAT), ty = (y - ly * LAT) / LAT, rowL = (ly - ly0) * lw;
  if (k) {
    const kx = x - k.x, ky = y - k.y;
    if (kx >= 0 && ky >= 0 && kx < k.w && ky < k.h && k.mask[ky * k.w + kx] === 1) {
      return pack(B.KANTO, B.KANTO, W_NONE);
    }
  }
  // the land biome: the nearest lattice point of the jittered cell (3.3)
  const jn = fbm(L.jx, x, y);
  const jx = x + Wt.jitter * jn, jy = y + Wt.jitter * fbm(L.jy, x, y);
  const q = (Math.floor(jy / LAT + 0.5) - ly0) * lw + Math.floor(jx / LAT + 0.5) - lx0;
  const lb = bio[q];
  // the fields at the cell, interpolated bilinearly
  const lx = Math.floor(x / LAT), tx = (x - lx * LAT) / LAT;
  const p = rowL + lx - lx0;
  const a = (1 - tx) * (1 - ty), b = tx * (1 - ty), c = (1 - tx) * ty, d = tx * ty;
  const ip = (F) => F[p] * a + F[p + 1] * b + F[p + lw] * c + F[p + lw + 1] * d;
  const sh = Wt.shift * fbm(L.sn, x, y);
  // Kanto's exclusions follow noise contours of the distance to its box (never its straight sides), as signed
  // distances in cells like every other boundary: no deep water within 48 to 80 cells, no fresh water within 16 to 48
  let noDeep = false, fresh = true;
  if (k) {
    const bx = x < k.x ? k.x - x : x >= k.x + k.w ? x - (k.x + k.w - 1) : 0;
    const by = y < k.y ? k.y - y : y >= k.y + k.h ? y - (k.y + k.h - 1) : 0;
    const db = bx > by ? bx : by;
    const sbx = bx > by ? (x < k.x ? -1 : 1) : 0, sby = bx > by ? 0 : by > 0 ? (y < k.y ? -1 : 1) : 0;
    const gx = sbx - Wt.kantoEdgeAmp * ip(gKx), gy = sby - Wt.kantoEdgeAmp * ip(gKy), gk = Math.sqrt(gx * gx + gy * gy) + EPS;
    const dkr = db - Wt.kantoEdgeAmp * (1 + ip(KE));
    noDeep = (dkr - Wt.noDeepNearKanto) / gk + sh < 0;
    fresh = (dkr - Wt.noFreshNearKanto) / gk + sh >= 0;
  }
  // water (3.5). dc is the signed distance in cells to the coast (negative at sea), shifted by the detail noise
  // taken at the cell's foot on the coast, so the coast wanders while the beach behind it keeps its width
  const cv = ip(C), cgx = ip(gCx), cgy = ip(gCy), gc = Math.sqrt(cgx * cgx + cgy * cgy) + EPS;
  const dc0 = (cv - th.cOcean) / gc;
  const dc = dc0 + (dc0 > -Wt.footReach && dc0 < Wt.footReach ? Wt.shift * fbm(L.sn, x - dc0 * cgx / gc, y - dc0 * cgy / gc) : 0);
  const guard = edgeGuard(x, y);
  if (dc < 0 || (guard > 0 && cv - guard < th.cOcean)) {
    // deep: beyond the edge contour (so the last 42 cells are always deep), or under the deep quantile with a
    // shallow shelf of 10 to 20 cells off every coast; never near Kanto
    const shelf = Wt.shelfMin + (Wt.shelfMax - Wt.shelfMin) * clamp(ip(BW) * 1.5 + 0.5, 0, 1);
    const edgeDeep = (ip(E) - CLIMATE.deepEdge) / (ip(gE) + EPS) + sh < 0;
    const deep = edgeDeep || ((cv - th.cDeep) / gc + sh < 0 && dc < -shelf);
    // (6a) the edge's deep water runs along the whole border, beside Kanto too, except within 48 cells of Kanto's own
    // sea (a noise contour of its distance): Kanto's sea always meets shallow ocean first. The last 10 to 18 cells of
    // the overworld (the 8 past the border and a wobbling band inside it, half the shift noise around 14 cells from
    // the straight edge) are deep even there: with Kanto's box 48 cells from the edge (the last placement, kanto.js
    // KY_LAST) its south sea lies 41 cells from the border strip, and the strip past the border is always deep (2.8)
    if (deep && (!noDeep || (edgeDeep && k && L.kinf && (L.kinf.seaD(x, y) - Wt.noDeepNearKanto + sh > 0
      || Math.min(x, y, OW - 1 - x, OW - 1 - y) + 0.5 * sh < Wt.kantoEdgeDeep)))) return pack(B.DEEP_OCEAN, lb, W_DEEP);
    return pack(t[q] < Wt.coldOcean ? B.FROZEN_OCEAN : B.OCEAN, lb, W_OCEAN);
  }
  const mv = ip(M);
  if (fresh && (mv - th.mRock) / (ip(gM) + EPS) + sh < 0 && lb !== B.DESERT && (ip(LK) - th.lLake) / (ip(gL) + EPS) + sh < 0) {
    return pack(B.LAKE, lb, W_LAKE);
  }
  // rivers narrow to 3 cells as the land rises toward the hills and end at the contour mEnd of M (shifted
  // like every boundary), before the rock: a spring at the foot of the hills, never a beaded trickle
  if (fresh && (mEnd - mv) / (ip(gM) + EPS) + sh > 0) {
    const fade = 1 - smooth(clamp((mv - th.mRiverFade) / fadeSpan, 0, 1));
    const hw = Wt.riverMin + (Wt.riverMax - Wt.riverMin) * clamp(ip(RW) * 1.5 + 0.5, 0, 1) * fade;
    {
      // the river's centre line wanders by the detail noise at the cell's foot on it, so both banks move
      // together and the width is exactly 2 hw
      const rgx = ip(gRx), rgy = ip(gRy), gr = Math.sqrt(rgx * rgx + rgy * rgy) + EPS;
      const dr0 = ip(R) / gr;
      if ((dr0 < 0 ? -dr0 : dr0) < hw + Wt.shift) {
        const dr = dr0 + Wt.shift * fbm(L.sn, x - dr0 * rgx / gr, y - dr0 * rgy / gr);
        if ((dr < 0 ? -dr : dr) < hw) return pack(B.RIVER, lb, W_RIVER);
      }
    }
  }
  // the beach's inner edge wanders on its own (the jitter noise), not only with the coast
  const bw = Wt.beachMin + (Wt.beachMax - Wt.beachMin) * clamp(ip(BW) * 1.5 + 0.5 + 0.6 * jn, 0, 1);
  if (dc < bw) {
    return pack(isSnowy(lb) ? B.SNOWY_BEACH : isRock(lb) ? B.STONY_SHORE : B.BEACH, lb, W_NONE);
  }
  return pack(lb, lb, W_NONE);
}

// (generator polish) The river's signed distance at a cell (cells; its zero contour is the river's centre line, the
// shift at the foot included exactly as cellAt takes it), or NaN where cellAt can give no river (Kanto, near Kanto,
// past the river's end contour). The painter (chunk.js level 0) draws a river super only where this centre line
// passes through it, so painted rivers keep 3a's course without the 4-cell supers doubling their width.
export function riverSignedAt(ctx, x, y) {
  const { lat, th, k, Wt, mEnd } = ctx;
  const { lx0, ly0, lw, R, M, KE, gRx, gRy, gM, gKx, gKy } = lat;
  const L = ctx.L;
  if (k) {
    const kx = x - k.x, ky = y - k.y;
    if (kx >= 0 && ky >= 0 && kx < k.w && ky < k.h && k.mask[ky * k.w + kx] === 1) return NaN;
  }
  const ly = Math.floor(y / LAT), ty = (y - ly * LAT) / LAT, lx = Math.floor(x / LAT), tx = (x - lx * LAT) / LAT;
  const p = (ly - ly0) * lw + lx - lx0;
  const a = (1 - tx) * (1 - ty), b = tx * (1 - ty), c = (1 - tx) * ty, d = tx * ty;
  const ip = (F) => F[p] * a + F[p + 1] * b + F[p + lw] * c + F[p + lw + 1] * d;
  const sh = Wt.shift * fbm(L.sn, x, y);
  if (k) {
    const bx = x < k.x ? k.x - x : x >= k.x + k.w ? x - (k.x + k.w - 1) : 0;
    const by = y < k.y ? k.y - y : y >= k.y + k.h ? y - (k.y + k.h - 1) : 0;
    const db = bx > by ? bx : by;
    const sbx = bx > by ? (x < k.x ? -1 : 1) : 0, sby = bx > by ? 0 : by > 0 ? (y < k.y ? -1 : 1) : 0;
    const gx = sbx - Wt.kantoEdgeAmp * ip(gKx), gy = sby - Wt.kantoEdgeAmp * ip(gKy), gk = Math.sqrt(gx * gx + gy * gy) + EPS;
    const dkr = db - Wt.kantoEdgeAmp * (1 + ip(KE));
    if (!((dkr - Wt.noFreshNearKanto) / gk + sh >= 0)) return NaN;
  }
  if (!((mEnd - ip(M)) / (ip(gM) + EPS) + sh > 0)) return NaN;
  const rgx = ip(gRx), rgy = ip(gRy), gr = Math.sqrt(rgx * rgx + rgy * rgy) + EPS;
  const dr0 = ip(R) / gr;
  if ((dr0 < 0 ? -dr0 : dr0) >= Wt.riverMax + Wt.shift) return dr0;
  return dr0 + Wt.shift * fbm(L.sn, x - dr0 * rgx / gr, y - dr0 * rgy / gr);
}

export function genRegion(g, x0, y0, w, h) {
  const win = latticeWindow(x0, y0, w, h);
  const lat = evalLattice(g, win.lx0, win.ly0, win.lw, win.lh);
  const ctx = cellContext(g, lat);
  const biome = new Uint8Array(w * h), land = new Uint8Array(w * h), water = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const v = cellAt(ctx, x0 + xx, y0 + yy), o = yy * w + xx;
      biome[o] = v & 255; land[o] = (v >> 8) & 255; water[o] = v >> 16;
    }
  }
  return { x0, y0, w, h, biome, land, water, lat };
}

// A stable hash of a region's outputs (FNV-1a over every output array), as 8 hex digits.
export function hashRegion(r) {
  let hh = 0x811c9dc5;
  for (const arr of [r.biome, r.land, r.water]) {
    for (let i = 0; i < arr.length; i++) { hh ^= arr[i]; hh = Math.imul(hh, 16777619); }
  }
  return (hh >>> 0).toString(16).padStart(8, '0');
}
