#!/usr/bin/env node
// Unit checks of the generator's primitives (design 3.1): seeds from text as Minecraft makes them, the hash, the
// permutation, simplex and fbm ranges, the total-order quantiles and ranks, the biome table and the hub rule.
//
//   node tools/gen_tests/primitives.mjs
import { hash32, fnv1a, seedFromText, worldSeed, sub } from '../../src/gen/hash.js';
import { makePerm, simplex2, makeFbm, fbm, makeRidged, ridged } from '../../src/gen/noise.js';
import { sortedNums, quantile, knots, rankOf, byNum, byScoreThenId } from '../../src/gen/order.js';
import { B, classify, majority, hubRule, TINT_OF, T_TEMPERATE } from '../../src/gen/biomes.js';

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

// seeds: blank is random (null), integers are themselves (int32), text is Java's hashCode (Minecraft's 'hello' is 99162322)
check(seedFromText('') === null && seedFromText('   ') === null, 'blank seed text means random (null)');
check(seedFromText('123') === 123 && seedFromText(' -7 ') === -7 && seedFromText('+5') === 5, 'integer text is the integer (trimmed)');
check(seedFromText('hello') === 99162322, `text seed 'hello' is Java hashCode 99162322 (got ${seedFromText('hello')})`);
check(seedFromText('4294967297') === 1, 'integers wrap to int32 (4294967297 -> 1)');
check(worldSeed(-7) === -7 && worldSeed('hello') === 99162322 && worldSeed(2.9) === 2, 'worldSeed of numbers and text');
check(hash32(1, 2, 3, 4) === hash32(1, 2, 3, 4) && hash32(1, 2) !== hash32(2, 1), 'hash32 is deterministic and order-sensitive');
check(fnv1a('') === 0x811c9dc5 && fnv1a('a') === 0xe40c292c, 'fnv1a matches the reference values');
check(sub(1, 'temp') !== sub(1, 'hum') && sub(1, 'temp') !== sub(2, 'temp'), 'sub-seeds differ by name and seed');
// hash spread: 100,000 draws fill 16 buckets within 3%
{
  const b = new Array(16).fill(0);
  for (let i = 0; i < 100000; i++) b[hash32(7, i) >>> 28]++;
  check(Math.max(...b) < 6250 * 1.03 && Math.min(...b) > 6250 * 0.97, `hash32 buckets even (${Math.min(...b)}..${Math.max(...b)})`);
}

// noise
{
  const P = makePerm(42);
  const seen = new Set(P.perm.slice(0, 256));
  check(seen.size === 256 && P.perm[300] === P.perm[44], 'the permutation is a permutation of 0..255, doubled');
  let lo = 1, hi = -1, s = 0, s2 = 0, n = 0;
  for (let i = 0; i < 200000; i++) { const v = simplex2(P, i * 0.0731, (i * 0.0377) % 97); lo = Math.min(lo, v); hi = Math.max(hi, v); s += v; s2 += v * v; n++; }
  check(lo >= -1 && hi <= 1 && Math.abs(s / n) < 0.01, `simplex in [-1, 1] (${lo.toFixed(3)}..${hi.toFixed(3)}), mean ${(s / n).toFixed(4)}`);
  const F = makeFbm(42, 'x', 100, 4), R = makeRidged(42, 'x', 100, 4);
  let flo = 1, fhi = -1, rlo = 1, rhi = 0;
  for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) { const v = fbm(F, x * 3, y * 3), r = ridged(R, x * 3, y * 3); flo = Math.min(flo, v); fhi = Math.max(fhi, v); rlo = Math.min(rlo, r); rhi = Math.max(rhi, r); }
  check(flo >= -1 && fhi <= 1 && rlo >= 0 && rhi <= 1, `fbm in [-1, 1] (${flo.toFixed(2)}..${fhi.toFixed(2)}), ridged in [0, 1] (${rlo.toFixed(2)}..${rhi.toFixed(2)})`);
}

// order
{
  const a = [5, 1, 4, 1, 3, 9, 2, 6];
  check(sortedNums(a).join() === '1,1,2,3,4,5,6,9' && quantile(a, 0) === 1 && quantile(a, 1) === 9 && quantile(a, 0.5) === 3, 'sorted numbers and floor-index quantiles');
  const K = knots(sortedNums(Array.from({ length: 1001 }, (_, i) => i)));
  check(rankOf(K, -5) === 0 && rankOf(K, 2000) === 1 && Math.abs(rankOf(K, 250) - 0.25) < 1e-12, 'ranks against knots (0, 1 and linear between)');
  const objs = [{ id: 3, score: 1 }, { id: 1, score: 2 }, { id: 2, score: 1 }];
  check(objs.slice().sort(byScoreThenId).map((o) => o.id).join() === '1,2,3', 'byScoreThenId: best first, ties by id');
  check(objs.slice().sort(byNum('score')).map((o) => o.id).join() === '2,3,1', 'byNum: ascending, ties by id');
}

// biome table (3.3) and the hub rule
{
  check(classify(0.1, 0.6, false, false) === B.SNOWY_TAIGA && classify(0.1, 0.3, false, false) === B.SNOWY_PLAINS, 'cold rows');
  check(classify(0.3, 0.5, false, false) === B.TAIGA && classify(0.5, 0.6, false, false) === B.BIRCH_FOREST, 'cool and temperate rows');
  check(classify(0.9, 0.2, false, false) === B.DESERT && classify(0.9, 0.7, false, false) === B.SWAMP && classify(0.9, 0.9, false, false) === B.JUNGLE, 'hot rows');
  check(classify(0.2, 0.5, true, true) === B.SNOWY_MOUNTAINS && classify(0.5, 0.5, true, true) === B.MOUNTAINS && classify(0.5, 0.5, true, false) === B.STONY_HILLS, 'rock rows');
  // a savanna block touching a jungle block: the hub rule leaves no non-temperate pair within 4 points
  const w = 30, h = 20, src = new Uint8Array(w * h), hr = new Float64Array(w * h).fill(0.6);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y * w + x] = x < 15 ? B.SAVANNA : B.JUNGLE;
  const out = hubRule(src, hr, w, h);
  let bad = 0;
  // (points within 4 of the window's edge are apron: the rule leaves them as they were, so check 8 in)
  for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) {
    const t = TINT_OF[out[y * w + x]];
    if (t <= T_TEMPERATE) continue;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const u = TINT_OF[out[(y + dy) * w + x + dx]]; if (u > T_TEMPERATE && u !== t) bad++; }
  }
  check(bad === 0 && out[10 * w + 20] === B.JUNGLE && out[10 * w + 14] === B.FOREST, 'hub rule: jungle (higher priority) keeps its side, savanna within 4 points becomes FOREST (h >= 0.5)');
  const m = majority(Uint8Array.from([1, 1, 1, 1, 2, 1, 1, 1, 1]), 3, 3);
  check(m[4] === 1, 'majority removes a single speck');
}

console.log(fails ? `primitives: ${fails} failed` : 'primitives: all passed');
process.exit(fails ? 1 : 0);
