#!/usr/bin/env node
// Chunk painting time in Node (design 13, stage 3b: under 8 ms). The worker (stage 4a) paints with the per-world
// caches (makeGen's inputs.cache) as the player walks, so the measure is a walk: a 12 x 12 block of chunks in raster
// order, after 4 chunks elsewhere (the caches warm). Reported too: the same chunks with no caches (each chunk alone,
// as after a teleport into an unexplored area). The JIT is warmed first on another seed.
//
//   node tools/gen_tests/paint_perf.mjs [--seed 1] [--type wild]     exits 1 if the walk's mean is 8 ms or more
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGen, paintChunk } from '../../src/gen/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const type = opt('--type', 'wild'), seed = /^-?\d+$/.test(opt('--seed', '1')) ? Number(opt('--seed', '1')) : opt('--seed');
const rd = (f) => readFileSync(path.join(ROOT, 'assets', 'world', f));
const inputs = { terrain: JSON.parse(rd('terrain.json').toString('utf8')) };
if (type === 'kanto') {
  const z = rd('zone.bin'), gb = rd('grid.bin');
  inputs.kantoZone = new Uint8Array(z.buffer, z.byteOffset, 408 * 400).slice();
  inputs.kantoGrid = new Uint16Array(gb.buffer.slice(gb.byteOffset, gb.byteOffset + 408 * 400 * 2));
  Object.assign(inputs, (await import('./kanto_inputs.mjs')).kantoInputs());
}
const stats = (ts) => {
  const s = [...ts].sort((a, b) => a - b), mean = ts.reduce((a, b) => a + b, 0) / ts.length;
  return { mean: +mean.toFixed(2), median: +s[s.length >> 1].toFixed(2), p90: +s[Math.floor(s.length * 0.9)].toFixed(2), max: +s[s.length - 1].toFixed(2) };
};
const walk = (cache) => {
  const g = makeGen({ type, seed }, { ...inputs, cache });
  for (const c of [[5, 5], [40, 40], [5, 40], [40, 5]]) paintChunk(g, ...c);
  const ts = [];
  for (let cy = 18; cy < 30; cy++) for (let cx = 18; cx < 30; cx++) { const t0 = performance.now(); paintChunk(g, cx, cy); ts.push(performance.now() - t0); }
  return stats(ts);
};
// warm the JIT on another seed's generator first (its caches are its own)
{ const gw = makeGen({ type, seed: 987654 }, { ...inputs, cache: true }); for (let k = 0; k < 40; k++) paintChunk(gw, 10 + (k % 8), 10 + (k >> 3)); }
const w = walk(true), c = walk(false);
console.log(`${type}:${seed} walk with the caches (144 chunks): ${JSON.stringify(w)} ms`);
console.log(`${type}:${seed} the same chunks, no caches:          ${JSON.stringify(c)} ms`);
const ok = w.mean < 8;
console.log(ok ? 'paint perf: passed (walk mean under 8 ms)' : 'paint perf: FAILED (walk mean 8 ms or more)');
process.exit(ok ? 0 : 1);
