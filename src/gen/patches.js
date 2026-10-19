// The land biome the painter uses (design 4.7 item 10, stage 3b): stage 3a's lattice biome with its thin parts and
// small patches removed, as a lazily evaluated field of lattice points. Every value is a pure function of the
// lattice point (no window edge takes part in any decision), so chunks generated in any order agree.
//
// Per point, in this order (each step reads only the one before):
//   raw     the biome table's answer (region.js pointClimate), from the world's lattice cache when it has one
//   m1, m2  the 3 x 3 majority, twice (biomes.js majority's tie rule)
//   bio     the hub rule (biomes.js hubRule): stage 3a's lattice biome, point for point
//   s1      thin parts: a point in no 3 x 3 block of its own biome (a strip or spur under 3 points, 12 cells, which
//           the cells' jitter would break into specks) takes the commonest biome among its 8 neighbours that do lie in
//           such a block (lowest id on a tie); a non-temperate one other than the point's own tint only if no other
//           non-temperate tint lies within HUB_R + 1 points (so two neighbouring thin points never break the hub rule)
//   final   small patches, twice (the second pass takes the patches the first leaves, such as a temperate buffer whose
//           cause was itself a small patch): a 4-connected patch whose extent is under PATCH_MIN points in both directions takes
//           the commonest biome among the large patches beside it (lowest id on a tie); a non-temperate one other than
//           its own tint only if no other non-temperate tint and no other small patch lies within HUB_R points of it
//           (tints then change only where nothing else can change at the same time); failing all, the
//           temperate biome for its humidity (PLAINS when most of its points have h < 0.5, else FOREST).
// A patch is found by a flood fill that stops as soon as its extent reaches PATCH_MIN (then it is large whatever lies
// beyond), so the work stays near the points asked for. PATCH_MIN is 13 points (52 cells): the cells' jitter, the
// 4-cell supers and the breakers trim a lattice patch by up to 3 points, and the cells' patch must be 40 across.
import { B, NB, TINT_OF, T_TEMPERATE, HUB_R, majorityAt } from './biomes.js';
import { pointClimate } from './region.js';
import { LAT } from './climate.js';

export const PATCH_MIN = 13;
// how far (lattice points) the final value of a point reaches: a small patch spans PATCH_MIN - 1, the hub check
// HUB_R beyond it, a small patch found there PATCH_MIN - 1 more; s1 reads HUB_R + 2, bio 1 + 1 + HUB_R
// (2 PATCH_MIN + HUB_R for the floods and the hub check of each of the two patch passes, then s1's HUB_R + 2 and
// bio's HUB_R + 2)
export const PATCH_PASSES = 2;
export const FIELD_REACH = PATCH_PASSES * (2 * PATCH_MIN + HUB_R) + 2 * (HUB_R + 2);

const UNK = 255;
// the world-wide field (with the lattice cache) covers lattice points -WORLD_PAD .. 399 + WORLD_PAD
const WORLD_PAD = 128;

// A field over the lattice points lx0 .. lx0 + lw - 1, ly0 .. ly0 + lh - 1 (and the reach around them). With the
// world's lattice cache (makeGen's inputs.cache, the worker) one field serves the whole world, so chunks generated
// one after another share its work; values are the same either way.
export function makeLandField(g, lx0, ly0, lw, lh) {
  const cc = g.latCache;
  if (cc) {
    if (!g.landField) g.landField = buildField(g, -WORLD_PAD, -WORLD_PAD, 400 + 2 * WORLD_PAD, 400 + 2 * WORLD_PAD, cc);
    return g.landField;
  }
  const R = FIELD_REACH + 2;
  return buildField(g, lx0 - R, ly0 - R, lw + 2 * R, lh + 2 * R, null);
}

function buildField(g, ox, oy, W, H, cc) {
  const N = W * H;
  const rawA = new Uint8Array(N).fill(UNK), hA = new Float64Array(N);
  const m1A = new Uint8Array(N).fill(UNK), m2A = new Uint8Array(N).fill(UNK), bioA = new Uint8Array(N).fill(UNK);
  const thA = new Uint8Array(N).fill(UNK), s1A = new Uint8Array(N).fill(UNK);
  const o = {};
  const idx = (x, y) => {
    const i = x - ox, j = y - oy;
    if (i < 0 || j < 0 || i >= W || j >= H) throw new Error('land field: point outside its reach');
    return j * W + i;
  };
  const raw = (x, y) => {
    const i = idx(x, y);
    if (rawA[i] === UNK) {
      let done = false;
      if (cc) {
        const cx = x - cc.o, cy = y - cc.o;
        if (cx >= 0 && cy >= 0 && cx < cc.n && cy < cc.n && cc.flag[cy * cc.n + cx] >= 1) {
          const ci = cy * cc.n + cx;
          rawA[i] = cc.raw[ci]; hA[i] = cc.h[ci]; done = true;
        }
      }
      if (!done) { pointClimate(g, x * LAT, y * LAT, o); rawA[i] = o.raw; hA[i] = o.hr; }
    }
    return rawA[i];
  };
  const hr = (x, y) => { raw(x, y); return hA[idx(x, y)]; };
  const m1 = (x, y) => { const i = idx(x, y); if (m1A[i] === UNK) m1A[i] = majorityAt(raw, x, y); return m1A[i]; };
  const m2 = (x, y) => { const i = idx(x, y); if (m2A[i] === UNK) m2A[i] = majorityAt(m1, x, y); return m2A[i]; };
  const PRIO = [0, 0, 1, 2, 3, 4];
  const bio = (x, y) => {
    const i = idx(x, y);
    if (bioA[i] === UNK) {
      const b = m2(x, y), tn = TINT_OF[b];
      let out = b;
      if (tn > T_TEMPERATE) {
        const pr = PRIO[tn];
        let hit = false;
        for (let dy = -HUB_R; dy <= HUB_R && !hit; dy++) {
          for (let dx = -HUB_R; dx <= HUB_R; dx++) {
            const tq = TINT_OF[m2(x + dx, y + dy)];
            if (tq > T_TEMPERATE && tq !== tn && PRIO[tq] > pr) { hit = true; break; }
          }
        }
        if (hit) out = hr(x, y) < 0.5 ? B.PLAINS : B.FOREST;
      }
      bioA[i] = out;
    }
    return bioA[i];
  };
  const thick = (x, y) => {
    const i = idx(x, y);
    if (thA[i] === UNK) {
      const b = bio(x, y);
      let any = 0;
      for (let oy2 = -1; oy2 <= 1 && !any; oy2++) {
        for (let ox2 = -1; ox2 <= 1 && !any; ox2++) {
          let all = true;
          for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (bio(x + ox2 + dx, y + oy2 + dy) !== b) { all = false; break; }
          if (all) any = 1;
        }
      }
      thA[i] = any;
    }
    return thA[i] === 1;
  };
  const cnt = new Int32Array(NB);
  const s1 = (x, y) => {
    const i = idx(x, y);
    if (s1A[i] === UNK) {
      const b = bio(x, y);
      let out = b;
      if (b !== B.KANTO && !thick(x, y)) {
        cnt.fill(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const q = bio(x + dx, y + dy);
          if (q !== B.KANTO && thick(x + dx, y + dy)) cnt[q]++;
        }
        const RR = HUB_R + 1;
        for (;;) {
          let best = -1;
          for (let c = 1; c < NB; c++) if (cnt[c] > 0 && (best < 0 || cnt[c] > cnt[best])) best = c;
          if (best < 0) break;
          const tn = TINT_OF[best];
          let clash = false;
          if (tn > T_TEMPERATE && tn !== TINT_OF[b]) {
            for (let dy = -RR; dy <= RR && !clash; dy++) for (let dx = -RR; dx <= RR; dx++) {
              const tq = TINT_OF[bio(x + dx, y + dy)];
              if (tq > T_TEMPERATE && tq !== tn) { clash = true; break; }
            }
          }
          if (!clash) { out = best; break; }
          cnt[best] = 0;
        }
      }
      s1A[i] = out;
    }
    return s1A[i];
  };
  // the patch record of a point: a flood fill of src that stops once the extent reaches PATCH_MIN
  const layer = (src) => {
  const comp = new Int32Array(N).fill(-1), recs = [], fA = new Uint8Array(N).fill(UNK);
  const stack = [];
  const patchOf = (x, y) => {
    const i0 = idx(x, y);
    if (comp[i0] >= 0) return recs[comp[i0]];
    const b = src(x, y), id = recs.length, rec = { b, small: false, pts: [], rep: -1 };
    recs.push(rec);
    let bx0 = x, bx1 = x, by0 = y, by1 = y, big = false;
    stack.length = 0; stack.push(x, y); comp[i0] = id;
    const seen = [i0];
    while (stack.length) {
      const yy = stack.pop(), xx = stack.pop();
      rec.pts.push(xx, yy);
      if (xx < bx0) bx0 = xx; if (xx > bx1) bx1 = xx; if (yy < by0) by0 = yy; if (yy > by1) by1 = yy;
      if (bx1 - bx0 + 1 >= PATCH_MIN || by1 - by0 + 1 >= PATCH_MIN) { big = true; break; }
      for (let d = 0; d < 4; d++) {
        const nx = xx + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = yy + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (src(nx, ny) !== b) continue;
        const j = idx(nx, ny);
        if (comp[j] === id) continue;
        if (comp[j] >= 0) { big = true; break; }   // a point already known: only large patches stop early
        comp[j] = id; seen.push(j); stack.push(nx, ny);
      }
      if (big) break;
    }
    if (big) {
      // every point reached belongs to the same large patch; points not reached find it again later
      rec.small = false; rec.pts = null;
      return rec;
    }
    rec.small = b !== B.KANTO;
    rec.box = [bx0, by0, bx1, by1];
    return rec;
  };
  const repOf = (rec) => {
    if (rec.rep >= 0) return rec.rep;
    const { b, pts } = rec, n = pts.length >> 1;
    const c2 = new Int32Array(NB);
    let dry = 0;
    for (let k = 0; k < pts.length; k += 2) {
      const x = pts[k], y = pts[k + 1];
      if (hr(x, y) < 0.5) dry++;
      for (let d = 0; d < 4; d++) {
        const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        const q = src(nx, ny);
        if (q === b || q === B.KANTO) continue;
        if (!patchOf(nx, ny).small) c2[q]++;
      }
    }
    const near = (tn) => {
      for (let k = 0; k < pts.length; k += 2) {
        const x = pts[k], y = pts[k + 1];
        for (let dy = -HUB_R; dy <= HUB_R; dy++) {
          for (let dx = -HUB_R; dx <= HUB_R; dx++) {
            const q = src(x + dx, y + dy), tq = TINT_OF[q];
            if (tq > T_TEMPERATE && tq !== tn) return true;
            const r = patchOf(x + dx, y + dy);
            if (r !== rec && r.small) return true;
          }
        }
      }
      return false;
    };
    let rep = -1;
    for (;;) {
      let best = -1;
      for (let c = 1; c < NB; c++) if (c2[c] > 0 && (best < 0 || c2[c] > c2[best])) best = c;
      if (best < 0) break;
      const tn = TINT_OF[best];
      if (tn <= T_TEMPERATE || tn === TINT_OF[b] || !near(tn)) { rep = best; break; }
      c2[best] = 0;
    }
    if (rep < 0) rep = dry * 2 > n ? B.PLAINS : B.FOREST;
    rec.rep = rep;
    return rep;
  };
  const final = (x, y) => {
    const i = idx(x, y);
    if (fA[i] === UNK) {
      const rec = patchOf(x, y);
      fA[i] = rec.small ? repOf(rec) : rec.b;
    }
    return fA[i];
  };
  return final;
  };
  const final = layer(layer(s1));
  return { final, bio, s1 };
}
