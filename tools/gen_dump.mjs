#!/usr/bin/env node
// Dump a rectangle of a generated world (design 4.8): the per-cell biome, land-biome and water arrays, the world's
// thresholds, the biome census, the shape-check counts and (with --chunks) the hash of every data chunk inside.
//
//   node tools/gen_dump.mjs --type wild|kanto --seed S [--rect x,y,w,h] [--out dir] [--chunks] [--no-bins]
//        [--tune '{"jitter": 6}']   (overrides region.js WATER, for tuning only)
//        [--paint]                  stage 3b: also paint the rectangle (tile.bin, ground.bin u16; deco.bin, cls.bin, pbiome.bin u8)
//                                   and run the painter's shape checks (checks.js paintChecks)
//        [--plan]                   stage 3c: compute the world plan first (plan.json; its stamps then shape the painting),
//                                   and put its villages, caves and spawn in meta.json for gen_render's overview markers
//
// The rectangle is in overworld-local cells (default the whole 1600 x 1600 overworld). Writes <out>/meta.json and,
// unless --no-bins, biome.bin, land.bin and water.bin (w * h bytes each, row-major). Prints a one-line summary.
// RS_NO_FETCH is irrelevant here: nothing is downloaded.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGen, genRegion, chunkHash, thresholdsJSON, CHUNK, paintRegion, makePlan, planJSON } from '../src/gen/index.js';
import { paintChecks } from '../src/gen/checks.js';
import { BIOMES } from '../src/gen/biomes.js';
import { regionChecks, census } from '../src/gen/checks.js';
import { GEN_VERSION } from '../src/gen/version.js';
import { fnv1a } from '../src/gen/hash.js';
import { kantoInputs } from './gen_tests/kanto_inputs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

export function kantoZone() {
  const z = readFileSync(path.join(ROOT, 'assets', 'world', 'zone.bin'));
  return new Uint8Array(z.buffer, z.byteOffset, 408 * 400).slice();
}

export function parseSeed(s) {
  if (s === undefined) return 1;
  return /^[-+]?\d+$/.test(String(s)) ? Number(s) : String(s);
}

let TERRAIN = null, KGRID = null;
export function terrainJSON() {
  if (!TERRAIN) TERRAIN = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'world', 'terrain.json'), 'utf8'));
  return TERRAIN;
}
export function kantoGrid() {
  if (!KGRID) { const z = readFileSync(path.join(ROOT, 'assets', 'world', 'grid.bin')); KGRID = new Uint16Array(z.buffer, z.byteOffset, 408 * 400).slice(); }
  return KGRID;
}

export function makeWorld(type, seed, tune, paint = false) {
  const inputs = type === 'kanto' ? { ...kantoInputs() } : {};
  if (paint) inputs.terrain = terrainJSON();
  if (tune) inputs.tune = tune;
  return makeGen({ type, seed }, inputs);
}

export function dump(type, seed, { rect = [0, 0, 1600, 1600], chunks = false, tune = null, paint = false, plan = false } = {}) {
  const t0 = performance.now();
  const g = makeWorld(type, seed, tune, paint || plan);
  const t1 = performance.now();
  const [x0, y0, w, h] = rect;
  const r = genRegion(g, x0, y0, w, h);
  const t2 = performance.now();
  const checks = regionChecks(r);
  const cen = census(r.biome);
  const meta = {
    v: GEN_VERSION, type, seed: g.seed, seedInput: seed, rect,
    thresholdsHash: fnv1a(thresholdsJSON(g.th)).toString(16).padStart(8, '0'),
    th: { ...g.th, tK: undefined, hK: undefined },
    kanto: g.kanto ? { x: g.kanto.x, y: g.kanto.y, w: g.kanto.w, h: g.kanto.h } : null,
    census: Object.fromEntries(BIOMES.map((b) => [b.key, cen[b.id]]).filter(([, c]) => c > 0)),
    checks,
    ms: { gen: Math.round(t1 - t0), region: Math.round(t2 - t1) },
  };
  let p = null, pl = null;
  if (plan) {
    const t3 = performance.now();
    pl = makePlan(g);
    meta.ms.plan = Math.round(performance.now() - t3);
    const j = pl.json;
    meta.plan = {
      hash: pl.hash, spawn: j.spawn, meadow: j.meadow, stats: pl.stats, demand: pl.demand, warnings: pl.warnings,
      villages: j.villages.map((v) => ({ id: v.id, x0: v.x0, y0: v.y0, w: v.w, h: v.h, style: v.style, houses: v.houses.length })),
      caves: j.caves.map((c) => ({ id: c.id, x: c.x, y: c.y, family: c.family, b2: c.b2 })),
      rooms: j.rooms.length, maps: j.maps.length, warps: j.warps.length,
    };
  }
  if (paint) {
    const t3 = performance.now();
    p = paintRegion(g, x0, y0, w, h, { debug: true });
    meta.ms.paint = Math.round(performance.now() - t3);
    meta.paintChecks = paintChecks(p, g);
  }
  if (chunks) {
    meta.chunks = {};
    for (let cy = Math.floor(y0 / CHUNK); cy * CHUNK < y0 + h; cy++) {
      for (let cx = Math.floor(x0 / CHUNK); cx * CHUNK < x0 + w; cx++) meta.chunks[`${cx},${cy}`] = chunkHash(g, cx, cy);
    }
  }
  return { g, r, meta, p, plan: pl };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const type = opt('--type', 'wild');
  const seed = parseSeed(opt('--seed'));
  const rect = (opt('--rect', '0,0,1600,1600')).split(',').map(Number);
  const out = path.resolve(opt('--out', path.join(ROOT, 'out', 'gen', 'dump', `${type}_${seed}`)));
  const tune = opt('--tune') ? JSON.parse(opt('--tune')) : null;
  const paint = argv.includes('--paint');
  const { r, meta, p, plan } = dump(type, seed, { rect, chunks: argv.includes('--chunks'), tune, paint, plan: argv.includes('--plan') });
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 1));
  if (plan) {
    writeFileSync(path.join(out, 'plan.json'), planJSON(plan));
    console.log(`plan ${plan.hash}: ${plan.json.villages.length} villages, ${plan.json.caves.length} caves, spawn ${plan.json.spawn.x},${plan.json.spawn.y} rung ${plan.json.spawn.rung}, ${meta.ms.plan} ms`);
  }
  if (!argv.includes('--no-bins')) {
    writeFileSync(path.join(out, 'biome.bin'), r.biome);
    writeFileSync(path.join(out, 'land.bin'), r.land);
    writeFileSync(path.join(out, 'water.bin'), r.water);
    if (p) {
      writeFileSync(path.join(out, 'tile.bin'), Buffer.from(p.tile.buffer));
      writeFileSync(path.join(out, 'ground.bin'), Buffer.from(p.ground.buffer));
      writeFileSync(path.join(out, 'deco.bin'), p.deco);
      writeFileSync(path.join(out, 'cls.bin'), p.cls);
      writeFileSync(path.join(out, 'pbiome.bin'), p.biome);
    }
  }
  if (p) console.log('paint checks', JSON.stringify(meta.paintChecks.counts), 'ore', JSON.stringify(meta.paintChecks.ore), `paint ${meta.ms.paint} ms`);
  const c = meta.checks;
  console.log(`${type} seed ${seed} (${meta.seed}): rect ${rect.join(',')}  tint pairs ${c.tintPairs}  straight seams ${c.seams} (longest run ${c.longestRun})  gen ${meta.ms.gen} ms, region ${meta.ms.region} ms  -> ${out}`);
}
