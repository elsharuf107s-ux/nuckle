#!/usr/bin/env node
// Stage 3a's census over many seeds (design 13, stage 3a's "Must prove"): for every seed and both world types,
// the whole 1600 x 1600 overworld is generated and checked:
//   * every friendly biome (PLAINS, FOREST, BIRCH FOREST, TAIGA) is present, each with at least 0.5% of the
//     overworld and one connected patch of at least 40 x 40 cells' worth (1,600 cells);
//   * no non-hub tint pair is adjacent (4.7 item 6);
//   * no straight seam over 24 cells between biomes, tints or water kinds (4.7 item 8).
// It also reports, per biome, in how many worlds it appears, its median share, and the timing.
//
//   node tools/gen_tests/biomes200.mjs [--seeds 200] [--from 1] [--workers 4] [--types wild,kanto]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { kantoInputs } from './kanto_inputs.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const FRIENDLY_MIN_SHARE = 0.005, FRIENDLY_MIN_PATCH = 1600;

async function runWorld(type, seed, zone) {
  const { makeGen, genRegion } = await import('../../src/gen/index.js');
  const { regionChecks, census } = await import('../../src/gen/checks.js');
  const { FRIENDLY, NB } = await import('../../src/gen/biomes.js');
  const t0 = performance.now();
  const g = makeGen({ type, seed }, type === 'kanto' ? kantoInputs() : {});
  const r = genRegion(g, 0, 0, 1600, 1600);
  const ms = performance.now() - t0;
  const c = regionChecks(r);
  const cen = census(r.biome);
  // largest 4-connected patch of each friendly biome
  const N = 1600, seen = new Uint8Array(N * N), stack = new Int32Array(N * N);
  const patch = {};
  for (const b of FRIENDLY) {
    seen.fill(0);
    let best = 0;
    for (let i = 0; i < N * N; i++) {
      if (r.biome[i] !== b || seen[i]) continue;
      let sp = 0, n = 0; stack[sp++] = i; seen[i] = 1;
      while (sp) {
        const k = stack[--sp]; n++;
        const x = k % N;
        if (x > 0 && !seen[k - 1] && r.biome[k - 1] === b) { seen[k - 1] = 1; stack[sp++] = k - 1; }
        if (x < N - 1 && !seen[k + 1] && r.biome[k + 1] === b) { seen[k + 1] = 1; stack[sp++] = k + 1; }
        if (k >= N && !seen[k - N] && r.biome[k - N] === b) { seen[k - N] = 1; stack[sp++] = k - N; }
        if (k < N * N - N && !seen[k + N] && r.biome[k + N] === b) { seen[k + N] = 1; stack[sp++] = k + N; }
      }
      if (n > best) best = n;
    }
    patch[b] = best;
  }
  return { type, seed, ms, tint: c.tintPairs, seams: c.seams, longest: c.longestRun, samples: c.seamSamples.slice(0, 2), census: cen.slice(0, NB), patch };
}

if (!isMainThread) {
  const zone = new Uint8Array(workerData.zone);
  parentPort.on('message', async (job) => {
    if (!job) { process.exit(0); }
    parentPort.postMessage(await runWorld(job.type, job.seed, zone));
  });
} else {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const nSeeds = Number(opt('--seeds', 200)), from = Number(opt('--from', 1)), nw = Number(opt('--workers', 4));
  const types = opt('--types', 'wild,kanto').split(',');
  const { BIOMES, FRIENDLY, B } = await import('../../src/gen/biomes.js');
  const z = readFileSync(path.join(ROOT, 'assets', 'world', 'zone.bin'));
  const zone = new Uint8Array(z.buffer, z.byteOffset, 408 * 400).slice();
  const jobs = [];
  for (const type of types) for (let s = from; s < from + nSeeds; s++) jobs.push({ type, seed: s });
  const results = [];
  const t0 = Date.now();
  await new Promise((done) => {
    let active = 0;
    for (let w = 0; w < Math.min(nw, jobs.length); w++) {
      const wk = new Worker(SELF, { workerData: { zone: zone.buffer.slice(0) } });
      active++;
      const next = () => { const j = jobs.shift(); if (j) wk.postMessage(j); else { wk.postMessage(null); } };
      wk.on('message', (res) => { results.push(res); if (results.length % 50 === 0) console.log(`  ${results.length} worlds, ${Math.round((Date.now() - t0) / 1000)} s`); next(); });
      wk.on('exit', () => { if (--active === 0) done(); });
      wk.on('error', (e) => { console.error('worker error', e); });
      next();
    }
  });
  let fails = 0;
  const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
  for (const type of types) {
    const R = results.filter((r) => r.type === type).sort((a, b) => a.seed - b.seed);
    const total = 1600 * 1600;
    const friendlyBad = R.filter((r) => FRIENDLY.some((b) => r.census[b] / total < FRIENDLY_MIN_SHARE || r.patch[b] < FRIENDLY_MIN_PATCH));
    check(friendlyBad.length === 0, `${type}: ${R.length} seeds, every friendly biome present with >= 0.5% and a patch >= 1,600 cells` +
      (friendlyBad.length ? ` (failing seeds: ${friendlyBad.map((r) => r.seed).join(', ')})` : ''));
    const minShare = FRIENDLY.map((b) => `${BIOMES[b].key} ${(100 * Math.min(...R.map((r) => r.census[b] / total))).toFixed(2)}% / patch ${Math.min(...R.map((r) => r.patch[b]))}`);
    console.log(`     smallest over the seeds: ${minShare.join('; ')}`);
    const tint = R.filter((r) => r.tint > 0);
    check(tint.length === 0, `${type}: no non-hub tint pair adjacent in any seed (${tint.length} seeds with pairs${tint.length ? ': ' + tint.map((r) => r.seed).join(',') : ''})`);
    const seams = R.filter((r) => r.seams > 0);
    const events = R.reduce((s, r) => s + r.seams, 0);
    check(seams.length === 0, `${type}: straight-seam check zero in ${R.length - seams.length} of ${R.length} seeds (${events} runs over 24 cells in all; longest run anywhere ${Math.max(...R.map((r) => r.longest))})`);
    for (const r of seams) console.log(`     seed ${r.seed}: ${r.seams} (longest ${r.longest}) at ${JSON.stringify(r.samples)}`);
    const pres = BIOMES.filter((b) => b.id && b.id !== B.KANTO).map((b) => {
      const shares = R.map((r) => r.census[b.id] / total).sort((x, y) => x - y);
      return `${b.key} ${R.filter((r) => r.census[b.id] > 0).length}/${R.length} med ${(100 * shares[Math.floor(shares.length / 2)]).toFixed(1)}%`;
    });
    console.log(`     presence: ${pres.join(', ')}`);
    const ms = R.map((r) => r.ms).sort((a, b) => a - b);
    console.log(`     whole-world generation: median ${Math.round(ms[ms.length >> 1])} ms, max ${Math.round(ms[ms.length - 1])} ms`);
  }
  console.log(`biomes200: ${results.length} worlds in ${Math.round((Date.now() - t0) / 1000)} s; ${fails ? fails + ' failed' : 'all passed'}`);
  process.exit(fails ? 1 : 0);
}
