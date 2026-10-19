#!/usr/bin/env node
// The painters' seam test (design 11.1, stage 3b) and their golden hashes.
//
//   node tools/gen_tests/paint_seams.mjs [--update | --add]
//
// For both world types and the seeds 1, 2, 123456, -7 and 'hello', at 6 places per world (open land, a coast, a
// mountain, a river, a lake, and a Kanto seam in a Kanto World or a tint border in a Wild World): a 5 x 5 block of chunks painted one at a time in a shuffled order equals the same 160 x 160 cells
// painted as one region, byte for byte, in every output array (tile, ground, deco, cls, biome, land, water). The same
// chunks are painted a third time, in another shuffled order, by a generator with the per-world caches the worker
// uses (makeGen's inputs.cache), which must change nothing. Then the painted hashes of 16 chunks per world are
// compared with gen_paint_golden_v1.json (written by --update).
// Stage 3c adds two places per world painted with the world's plan attached (makePlan's stamps): a village group (the
// first village's bounds, no trees, rock or water inside) and a spawn meadow (a meadow stamped at the plan's spawn, as
// rung 4 of the ladder would, since no tested seed needs that rung), with the same three ways of painting, the stamps'
// own rules checked on the region (no natural tree touching a stamp, the meadow's 11 x 11 clearing plain walkable grass,
// its 6 oak crowns drawn), and the chunks' hashes in the golden file under `type:seed:plan`.
// The 3c fix adds every village of those worlds: its bounds plus 4 dry and rock-free when painted with the plan, and
// free of the generator's water (what the plan's site test proves) with or without it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGen, genRegion, paintRegion, paintChunk, hashPainted, CHUNK, makePlan, attachPlan } from '../../src/gen/index.js';
import { meadowAt } from '../../src/gen/plan.js';
import { setStamps, C_GRASS, STAMP_MEADOW, C_SEA, C_FRESH, C_ICE, C_ICEP, C_ROCK } from '../../src/gen/chunk.js';
import { B, TINT_OF, T_TEMPERATE } from '../../src/gen/biomes.js';
import { W_OCEAN, W_DEEP, W_RIVER, W_LAKE } from '../../src/gen/region.js';
import { hash32 } from '../../src/gen/hash.js';
import { GEN_VERSION } from '../../src/gen/version.js';
import { kantoInputs } from './kanto_inputs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GOLDEN = path.join(HERE, 'gen_paint_golden_v1.json');
const argv = process.argv.slice(2);
const SEEDS = [1, 2, 123456, -7, 'hello'];
const TYPES = ['wild', 'kanto'];
const KEYS = ['tile', 'ground', 'deco', 'cls', 'biome', 'land', 'water'];

const rd = (f, n) => { const b = readFileSync(path.join(ROOT, 'assets', 'world', f)); return b; };
const zone = (() => { const z = rd('zone.bin'); return new Uint8Array(z.buffer, z.byteOffset, 408 * 400).slice(); })();
const kgrid = (() => { const z = rd('grid.bin'); return new Uint16Array(z.buffer.slice(z.byteOffset, z.byteOffset + 408 * 400 * 2)); })();
const terrain = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'world', 'terrain.json'), 'utf8'));

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const kin = kantoInputs();
const mk = (type, seed, cache) => makeGen({ type, seed }, { terrain, cache, ...(type === 'kanto' ? kin : {}) });

function findPlaces(g, r) {
  const score = { coast: [], river: [], lake: [], rock: [], kanto: [], tint: [] };
  for (let cy = 3; cy < 47; cy++) {
    for (let cx = 3; cx < 47; cx++) {
      let sea = 0, land = 0, riv = 0, lak = 0, rock = 0, kan = 0, gen = 0;
      const tints = new Set();
      for (let y = cy * CHUNK; y < cy * CHUNK + CHUNK; y += 4) {
        for (let x = cx * CHUNK; x < cx * CHUNK + CHUNK; x += 4) {
          const i = y * 1600 + x, w = r.water[i], b = r.biome[i];
          if (w === W_OCEAN || w === W_DEEP) sea++; else land++;
          if (w === W_RIVER) riv++;
          if (w === W_LAKE) lak++;
          if (b === B.MOUNTAINS || b === B.STONY_HILLS || b === B.SNOWY_MOUNTAINS) rock++;
          if (b === B.KANTO) kan++; else gen++;
          if (!w) tints.add(TINT_OF[r.land[i]]);
        }
      }
      if (sea > 12 && land > 12) score.coast.push([cx, cy]);
      if (riv > 4) score.river.push([cx, cy]);
      if (lak > 6) score.lake.push([cx, cy]);
      if (rock > 30) score.rock.push([cx, cy]);
      if (kan > 10 && gen > 10) score.kanto.push([cx, cy]);
      if (sea === 0 && tints.size >= 2 && [...tints].some((t) => t > T_TEMPERATE)) score.tint.push([cx, cy]);
    }
  }
  const places = [['land', [23, 23]]];
  for (const k of ['coast', 'rock', 'river', 'lake', g.kanto ? 'kanto' : 'tint']) {
    const L = score[k];
    if (L.length) places.push([k, L[hash32(g.seed, L.length, k.length) % L.length]]);
  }
  return places;
}

function shuffled(seed, cx0, cy0, salt) {
  const order = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) order.push([i, j]);
  for (let k = order.length - 1; k > 0; k--) { const m = hash32(seed, k, cx0 * 64 + cy0, salt) % (k + 1); const t = order[k]; order[k] = order[m]; order[m] = t; }
  return order;
}

function seam(g, gc, cx0, cy0) {
  const N = 5, x0 = (cx0 - 2) * CHUNK, y0 = (cy0 - 2) * CHUNK;
  const reg = paintRegion(g, x0, y0, N * CHUNK, N * CHUNK);
  let bad = 0, badC = 0;
  const cmp = (c, i, j) => {
    let d = 0;
    for (const key of KEYS) {
      for (let y = 0; y < CHUNK; y++) for (let x = 0; x < CHUNK; x++) if (c[key][y * CHUNK + x] !== reg[key][(j * CHUNK + y) * N * CHUNK + i * CHUNK + x]) d++;
    }
    return d;
  };
  for (const [i, j] of shuffled(g.seed, cx0, cy0, 1)) bad += cmp(paintChunk(g, cx0 - 2 + i, cy0 - 2 + j), i, j);
  for (const [i, j] of shuffled(g.seed, cx0, cy0, 2)) badC += cmp(paintChunk(gc, cx0 - 2 + i, cy0 - 2 + j), i, j);
  return [bad, badC];
}

const GOLD_CHUNKS = [];
for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) GOLD_CHUNKS.push([6 + 12 * i, 6 + 12 * j]);
const mine = { v: GEN_VERSION, worlds: {} };

for (const type of TYPES) {
  for (const seed of SEEDS) {
    const g = mk(type, seed, false), gc = mk(type, seed, true);
    const r = genRegion(g, 0, 0, 1600, 1600);
    const places = findPlaces(g, r);
    const t0 = performance.now();
    const res = places.map(([k, [cx, cy]]) => [k, cx, cy, ...seam(g, gc, Math.min(47, Math.max(2, cx)), Math.min(47, Math.max(2, cy)))]);
    const bad = res.reduce((s, p) => s + p[3], 0), badC = res.reduce((s, p) => s + p[4], 0);
    check(bad === 0 && badC === 0 && res.length === 6,
      `paint seams ${type}:${seed}: ${res.length} places (${res.map((p) => `${p[0]} ${p[1]},${p[2]}`).join('; ')}), ${bad} cells differ chunk by chunk, ${badC} with the caches (${Math.round(performance.now() - t0)} ms)`);
    mine.worlds[`${type}:${seed}`] = GOLD_CHUNKS.map(([cx, cy]) => hashPainted(paintChunk(g, cx, cy)));
  }
}

// stage 3c: the plan's stamps
for (const type of TYPES) {
  for (const seed of SEEDS) {
    const gp = mk(type, seed, false), gpc = mk(type, seed, true);
    const plan = makePlan(gp);
    attachPlan(gpc, plan);
    const sp = plan.json.spawn, md = meadowAt(sp.x, sp.y);
    for (const g of [gp, gpc]) setStamps(g, [...g.stamps, md.stamp]);
    const v = plan.json.villages[0];
    const places = [['village', (v.x0 + v.w / 2) >> 5, (v.y0 + v.h / 2) >> 5], ['meadow', sp.x >> 5, sp.y >> 5]];
    const t0 = performance.now();
    const res = places.map(([k, cx, cy]) => [k, cx, cy, ...seam(gp, gpc, Math.min(47, Math.max(2, cx)), Math.min(47, Math.max(2, cy)))]);
    const bad = res.reduce((s, p) => s + p[3], 0), badC = res.reduce((s, p) => s + p[4], 0);
    check(bad === 0 && badC === 0, `plan seams ${type}:${seed}: ${res.map((p) => `${p[0]} ${p[1]},${p[2]}`).join('; ')}: ${bad} cells differ chunk by chunk, ${badC} with the caches (${Math.round(performance.now() - t0)} ms)`);
    // the stamps' rules on the painted cells
    const vr = paintRegion(gp, v.x0 - 8, v.y0 - 8, v.w + 16, v.h + 16, { debug: true }), VW = v.w + 16;
    let treesIn = 0;
    for (let y = 0; y < v.h + 4; y++) for (let x = 0; x < v.w + 4; x++) if (vr.dbg.tree[(y + 6) * VW + x + 6]) treesIn++;
    const mr = paintRegion(gp, sp.x - 20, sp.y - 20, 40, 40, { debug: true });
    let clearBad = 0;
    for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) {
      const k = (20 + y) * 40 + 20 + x;
      if (mr.cls[k] !== C_GRASS || mr.deco[k] || mr.dbg.tree[k] || mr.dbg.solid[k]) clearBad++;
    }
    const grove = md.stamp.grove.filter(([gx, gy]) => mr.dbg.tree[(gy - sp.y + 20) * 40 + gx - sp.x + 20]).length;
    check(treesIn === 0 && clearBad === 0 && grove === 6, `plan stamps ${type}:${seed}: ${treesIn} tree cells within 2 of village ${v.id}'s bounds, ${clearBad} cells of the meadow's clearing not plain grass, ${grove} of 6 grove crowns drawn`);
    mine.worlds[`${type}:${seed}:plan`] = places.map(([, cx, cy]) => hashPainted(paintChunk(gp, cx, cy)));
    // 3c fix: every village's bounds plus 4, painted with the plan, has no water, ice or rock (3.11 step 4); no cell of
    // it is the generator's water (cellAt, which the site test evaluates); and without the plan, the painter's only
    // water there is what the plan's painting removes on purpose: swamp puddles (faded out near a village) and
    // breaker notches in the 4-cell margin (the margin is kept out of the breakers)
    const g0 = mk(type, seed, false);
    let vBad = 0, vCell = 0, vOther = 0, vHid = 0;
    const isW = (c) => c === C_SEA || c === C_FRESH || c === C_ICE || c === C_ICEP;
    for (const vv of plan.json.villages) {
      const x0 = vv.x0 - 4, y0 = vv.y0 - 4, w = vv.w + 8, h = vv.h + 8;
      const pp = paintRegion(gp, x0, y0, w, h), p0 = paintRegion(g0, x0, y0, w, h), rr = genRegion(g0, x0, y0, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const k = y * w + x, margin = x < 4 || y < 4 || x >= w - 4 || y >= h - 4;
          if (isW(pp.cls[k]) || pp.cls[k] === C_ROCK) vBad++;
          if (rr.water[k]) vCell++;
          if (isW(p0.cls[k])) { vHid++; if (!(p0.land[k] === B.SWAMP || margin)) vOther++; }
          // (generator polish) a desert's sandstone outcrops keep 24 cells from every plan stamp, so without the plan they
          // can lie where the plan put a village: removed by the plan on purpose, as the puddles are
          else if (p0.cls[k] === C_ROCK && !margin) { if (p0.land[k] === B.DESERT) vHid++; else vOther++; }
        }
      }
    }
    check(vBad === 0 && vCell === 0 && vOther === 0, `plan villages ${type}:${seed}: ${plan.json.villages.length} villages' bounds plus 4: ${vBad} water, ice or rock cells with the plan, ${vCell} cells of cellAt water, ${vOther} cells of other water or rock without the plan (${vHid} puddle or margin water cells without the plan, removed by it)`);
  }
}

if (!existsSync(GOLDEN) || argv.includes('--update')) { writeFileSync(GOLDEN, JSON.stringify(mine, null, 1) + '\n'); console.log('wrote', GOLDEN); }
// --add writes only the worlds the golden file lacks (stage 3c's `:plan` entries), so the existing ones are still checked
if (argv.includes('--add')) {
  const g0 = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const added = Object.keys(mine.worlds).filter((k) => !g0.worlds[k]);
  for (const k of added) g0.worlds[k] = mine.worlds[k];
  writeFileSync(GOLDEN, JSON.stringify(g0, null, 1) + '\n');
  console.log(`added ${added.length} worlds to`, GOLDEN);
}
const gold = JSON.parse(readFileSync(GOLDEN, 'utf8'));
for (const [k, h] of Object.entries(mine.worlds)) {
  const d = gold.worlds[k] ? h.filter((x, i) => x !== gold.worlds[k][i]).length : -1;
  check(d === 0, `paint golden ${k}: ${d} of ${h.length} chunks differ`);
}
console.log(fails ? `paint seams: ${fails} failed` : 'paint seams: all passed');
process.exit(fails ? 1 : 0);
