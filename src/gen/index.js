// The generator's entry points (stage 3a: climate, biomes and water). Pure: no DOM, no G, no Math.random, no
// Date (design 3.0). Node tools and tests import this module directly; the worker (stage 4a) will too.
//
//   makeGen(desc, inputs)   desc = { type: 'wild' | 'kanto', seed: int or text }; inputs = { kantoZone } for a
//                           Kanto World (Classic's zone array), and optionally { th } (thresholds from a plan)
//   genChunk(g, cx, cy)     one 32 x 32 data chunk, overworld-local chunk coordinates (0..49): stage 3a's fields
//   genRegion(g, x0, y0, w, h)
//   chunkHash(g, cx, cy)
// Stage 3b (the painters; inputs.terrain = terrain.json, parsed, and for a Kanto World optionally
// inputs.kantoGrid = Classic's grid for Kanto's own cells):
//   paintChunk(g, cx, cy)   tile, ground, deco and cls per cell of a data chunk, plus the 3a fields
//   paintRegion(g, x0, y0, w, h, { debug })
//   paintHash(g, cx, cy)
// Stage 3c (the plan, plan.js): makePlan(g) with g = makeGen(desc, { terrain, ... }) computes the world plan from the
// coarse grid makeGen keeps (g.coarse), attaches its stamps (village bounds, the spawn meadow) to g and returns
// { json, hash, ... }; planJSON / planHash / canonical give its canonical JSON and hash (the co-op probe, 9.1).
// inputs.cache = true keeps per-world caches (the worker, stage 4a): the lattice's raw point fields (about 25 MB), the
// painter's land field (patches.js, about 11 MB) and its level-0 supers (chunk.js, about 1.5 MB), so chunks generated
// one after another share the work of their overlapping aprons; outputs are identical either way (paint_seams.mjs).
import { GEN_VERSION } from './version.js';
import { worldSeed } from './hash.js';
import { cmpStr } from './order.js';
import { makeLayers, sampleCoarse, thresholdsFrom } from './climate.js';
import { kantoFootprint, kantoCandidates, makeInfluence, K_SEA } from './kanto.js';
import { fbm, smooth, clamp } from './noise.js';
import { edgeDist, edgeGuard } from './climate.js';
import { genRegion, hashRegion, WATER, makeLatticeCache } from './region.js';
import { prepTerrain } from './terrain.js';
import { preparePaint, paintRegion, hashPainted } from './chunk.js';

export const CHUNK = 32;
export const OW_CHUNKS = 50;

export function makeGen(desc = {}, inputs = {}) {
  const type = desc.type || desc.kind || 'wild';
  if (type !== 'wild' && type !== 'kanto') throw new Error('unknown generated world type ' + type);
  const seed = worldSeed(desc.seed ?? 0);
  // inputs.tune overrides region.js WATER (tuning tools only; the game never passes it)
  const W = inputs.tune ? Object.freeze({ ...WATER, ...inputs.tune }) : WATER;
  const layers = makeLayers(seed, W);
  // the coarse grid (3.11 step 2) is kept for the plan (plan.js), which reads its biome and water maps from it
  const coarse = inputs.th ? null : sampleCoarse(layers);
  const th = inputs.th || thresholdsFrom(coarse);
  let kanto = null, kantoCheck = null;
  if (type === 'kanto') {
    // stage 6a: Kanto's context (classes, seams, holes, slots, distance fields) needs Classic's grid and the class of
    // every world.json entry (kanto.js kantoMatTable); the placement is the first of the seed's candidates that passes
    // the plan check (3.12), or the plan's own choice (inputs.kantoAt) when the thresholds come from a plan
    if (!inputs.kantoZone || !inputs.kantoGrid || !inputs.kantoMat) throw new Error('a Kanto World needs kantoZone, kantoGrid and kantoMat');
    const zw = inputs.kantoZoneW || 408;
    const make = (at) => kantoFootprint(seed, inputs.kantoZone, zw, at, inputs.kantoGrid, inputs.kantoMat);
    if (inputs.kantoAt) kanto = make(inputs.kantoAt);
    else if (!coarse) kanto = make(null);
    else {
      let best = null;
      for (const at of kantoCandidates(seed)) {
        const k = make(at), chk = kantoSeaCheck(coarse, th, layers, k);
        if (!best || chk.share > best.chk.share) best = { k, chk };
        if (chk.pass) break;
      }
      kanto = best.k; kantoCheck = best.chk;
    }
    layers.kinf = makeInfluence(kanto, layers, th, fbm, smooth, clamp);
    if (coarse) influenceCoarse(coarse, layers);
  }
  const g = { v: GEN_VERSION, type, seed, layers, th, coarse, kanto, kantoCheck, W, paint: null, kantoGrid: inputs.kantoGrid || null,
    kantoGround: inputs.kantoGround || null, latCache: inputs.cache ? makeLatticeCache() : null };
  if (type === 'kanto') g.kantoMat = inputs.kantoMat;   // (6b: the openings' search reads the entries' walk bit)
  if (inputs.terrain) {
    const T = inputs.terrain.ve ? inputs.terrain : prepTerrain(inputs.terrain);
    g.terrain = T;
    g.paint = preparePaint(seed, T);
  }
  return g;
}

// Kanto's influence field on the coarse sample (in place, after the thresholds; plan.js reads the coarse C and M):
// the points within the field's reach of Kanto's box (kanto.js PAD)
function influenceCoarse(S, L) {
  const n = S.n, st = S.step, o = {};
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const q = j * n + i;
      o.C = S.C[q]; o.M = S.M[q];
      L.kinf.C(i * st, j * st, o); L.kinf.M(i * st, j * st, o);
      S.C[q] = o.C; S.M[q] = o.M;
    }
  }
}

// The plan check of Kanto's placement (3.12) on the coarse grid: Kanto's outward sea boundary cells (beside a void
// region that reaches the box's edge) must face the world's ocean: a coarse point within 8 cells of the cell is
// generated sea connected through generated sea to the overworld's edge. `share` is the part that does.
// Coarse values are taken with the candidate's influence field (the thresholds do not depend on it).
// As built (6a): about a tenth of the outward sea cells face land by design (the beaches of exterior pockets walled
// partly by trees, where the tree pull wins), so a placement whose south sea meets the ocean scores 0.84 to 0.92 and one
// whose south sea is cut off by coastal land about 0.5: the pass mark is 0.8.
export const KANTO_PASS = 0.8;
export function kantoSeaCheck(S, th, L, k) {
  const n = S.n, st = S.step, N = n * n;
  const kinf = makeInfluence(k, L, th, fbm, smooth, clamp);
  const kan = (px, py) => { const lx = px - k.x, ly = py - k.y; return lx >= 0 && ly >= 0 && lx < k.w && ly < k.h && k.mask[ly * k.w + lx] === 1; };
  const sea = new Uint8Array(N), o = {};
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const q = j * n + i, px = i * st, py = j * st;
      if (kan(px, py)) continue;
      o.C = S.C[q];
      if (kinf) kinf.C(px, py, o);
      const guard = edgeGuard(px, py);
      sea[q] = o.C < th.cOcean || (guard > 0 && o.C - guard < th.cOcean) ? 1 : 0;
    }
  }
  // the world's ocean: generated sea connected to the outer ring (within 48 cells of the overworld's edge)
  const ocean = new Uint8Array(N), stack = [];
  for (let q = 0; q < N; q++) if (sea[q] && edgeDist((q % n) * st, Math.floor(q / n) * st) < 48) { ocean[q] = 1; stack.push(q); }
  while (stack.length) {
    const q = stack.pop(), i = q % n, j = (q - i) / n;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const r = jj * n + ii;
      if (sea[r] && !ocean[r]) { ocean[r] = 1; stack.push(r); }
    }
  }
  const out = k.ctx ? k.ctx.out[K_SEA] : [];
  let ok = 0, tot = 0;
  for (let t = 0; t < out.length; t += 2) {
    const x = out[t] + k.x, y = out[t + 1] + k.y;
    tot++;
    let hit = false;
    for (let j = Math.floor((y - 8) / st); j <= Math.floor((y + 8) / st) + 1 && !hit; j++) {
      for (let i = Math.floor((x - 8) / st); i <= Math.floor((x + 8) / st) + 1; i++) {
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const px = i * st, py = j * st;
        if (Math.max(Math.abs(px - x), Math.abs(py - y)) > 8 || !ocean[j * n + i]) continue;
        hit = true; break;
      }
    }
    if (hit) ok++;
  }
  const share = tot ? ok / tot : 1;
  return { kx: k.x, ky: k.y, share, ok, tot, pass: share >= KANTO_PASS };
}

export function paintChunk(g, cx, cy) {
  return paintRegion(g, cx * CHUNK, cy * CHUNK, CHUNK, CHUNK);
}

export function paintHash(g, cx, cy) {
  return hashPainted(paintChunk(g, cx, cy));
}

export function genChunk(g, cx, cy) {
  return genRegion(g, cx * CHUNK, cy * CHUNK, CHUNK, CHUNK);
}

export function chunkHash(g, cx, cy) {
  return hashRegion(genChunk(g, cx, cy));
}

// The canonical JSON of the thresholds (numbers as JS prints them, which ECMAScript fixes exactly), for hashes.
export function thresholdsJSON(th) {
  const keys = Object.keys(th).sort(cmpStr);
  return JSON.stringify(keys.map((k) => [k, th[k]]));
}

export { genRegion, hashRegion, paintRegion, hashPainted, prepTerrain };
export { makePlan, attachPlan, planJSON, planHash, canonical } from './plan.js';
