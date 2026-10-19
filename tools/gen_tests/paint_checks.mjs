#!/usr/bin/env node
// The painters' shape checks over whole worlds (design 4.7 and 11.2, stage 3b): every check of checks.js
// paintChecks on the whole 1600 x 1600 overworld of 10 seeds per type, in worker threads: the 8 the painter was tuned
// on and two it never saw (5 and 9, where the 3b quick check found a straight tint band edge on Kanto 9).
//
//   node tools/gen_tests/paint_checks.mjs [--seeds 1,2,3] [--types wild,kanto] [--jobs 3] [--json out.json]
//
// Fails on any non-zero count except small_biome, which is reported with every case (4.7 item 10: each non-zero
// case is looked at and explained: dump the world with `node tools/gen_dump.mjs --paint`, render each case with
// `python3 tools/gen_render.py DUMP --crop x,y,w,h` and gather the crops with `gen_render.py --sheet`). Ore coverage must be 4 to 6% of
// interior faces in every world.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SEEDS8 = [1, 2, 3, 123456, -7, 'hello', 42, 2026, 5, 9];

if (isMainThread) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const seeds = opt('--seeds') ? opt('--seeds').split(',').map((s) => (/^-?\d+$/.test(s) ? Number(s) : s)) : SEEDS8;
  const types = opt('--types', 'wild,kanto').split(',');
  const jobs = Number(opt('--jobs', 3));
  const todo = [];
  for (const type of types) for (const seed of seeds) todo.push({ type, seed });
  const results = [];
  let fails = 0;
  await new Promise((resolve) => {
    let next = 0, running = 0;
    const launch = () => {
      if (next >= todo.length) { if (!running) resolve(); return; }
      const job = todo[next++];
      running++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: job });
      w.on('message', (r) => {
        results.push(r);
        const c = r.counts, bad = Object.entries(c).filter(([k, v]) => v && k !== 'small_biome');
        const oreOk = r.ore.coverage >= 4 && r.ore.coverage <= 6;
        const ok = !bad.length && oreOk;
        if (!ok) fails++;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.type}:${r.seed}  ${bad.length ? 'non-zero ' + JSON.stringify(Object.fromEntries(bad)) : 'every check 0'}`
          + `  small_biome ${c.small_biome || 0}  ore ${r.ore.coverage}% of ${r.ore.faces} faces ${JSON.stringify(r.ore.byKind)}  longest run ${r.longestRun}  paint ${r.ms} ms`);
      });
      w.on('error', (e) => { fails++; console.log('FAIL', job, e.message); });
      w.on('exit', () => { running--; launch(); });
    };
    for (let k = 0; k < jobs; k++) launch();
  });
  const tot = results.reduce((s, r) => s + (r.counts.small_biome || 0), 0);
  console.log(`small_biome: ${tot} cases in ${results.length} worlds (listed in --json)`);
  if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(results, null, 1));
  console.log(fails ? `paint checks: ${fails} failed` : 'paint checks: all passed');
  process.exit(fails ? 1 : 0);
} else {
  const { makeGen, paintRegion } = await import('../../src/gen/index.js');
  const { paintChecks } = await import('../../src/gen/checks.js');
  const { type, seed } = workerData;
  const rd = (f) => readFileSync(path.join(ROOT, 'assets', 'world', f));
  const inputs = { terrain: JSON.parse(rd('terrain.json').toString('utf8')) };
  if (type === 'kanto') {
    const z = rd('zone.bin'), gb = rd('grid.bin');
    inputs.kantoZone = new Uint8Array(z.buffer, z.byteOffset, 408 * 400).slice();
    inputs.kantoGrid = new Uint16Array(gb.buffer.slice(gb.byteOffset, gb.byteOffset + 408 * 400 * 2));
    Object.assign(inputs, (await import('./kanto_inputs.mjs')).kantoInputs());
  }
  const g = makeGen({ type, seed }, inputs);
  const t0 = performance.now();
  const p = paintRegion(g, 0, 0, 1600, 1600, { debug: true });
  const ms = Math.round(performance.now() - t0);
  const c = paintChecks(p, g);
  parentPort.postMessage({ type, seed, counts: c.counts, samples: c.samples, ore: c.ore, longestRun: c.longestRun, ms });
}
