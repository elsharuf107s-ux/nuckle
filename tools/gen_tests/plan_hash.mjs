#!/usr/bin/env node
// The world plan's determinism and time (design 11.1 and 10.6, stage 3c's "Must prove").
//
//   node tools/gen_tests/plan_hash.mjs [--browser PORT] [--update] [--emit] [--parts]
//
// For both world types and the seeds 1, 2, 123456, -7 and 'hello':
//   1. golden: each plan's hash (the canonical JSON of villages, caves, the spawn, groups, rooms, maps, warps and the
//      thresholds, 9.1) and a few of its numbers equal gen_plan_golden_v1.json (written by --update when missing);
//   2. two runs: a second Node process computes the same plans;
//   3. --browser PORT: headless Chrome (serve.py on PORT) imports the same modules and computes the same plans; then the
//      plan's time is measured there, each plan in a fresh page (a cold start, as the worker has one plan per load),
//      for 4 seeds per type, without throttling and with Chrome's CPU throttled 4x (CDP Emulation.setCPUThrottlingRate).
//      Targets (10.6): under 300 ms on desktop, under 1 s throttled. The time covers makeGen (the coarse grid and the
//      thresholds) and makePlan; loading and preparing terrain.json is reported apart (the worker does it once).
// --emit prints the Node results as JSON and exits (used by check 2); --parts prints each timed plan's breakdown.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allPlans } from './plan_det_lib.mjs';
import { prepTerrain } from '../../src/gen/index.js';
import { kantoInputs } from './kanto_inputs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GOLDEN = path.join(HERE, 'gen_plan_golden_v1.json');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const rd = (f) => readFileSync(path.join(ROOT, 'assets', 'world', f));
const zone = kantoInputs();   // (stage 6a: all of a Kanto World's inputs)
const kgrid = (() => { const z = rd('grid.bin'); return new Uint16Array(z.buffer.slice(z.byteOffset, z.byteOffset + 408 * 400 * 2)); })();
const terrain = prepTerrain(JSON.parse(rd('terrain.json').toString('utf8')));
const clock = () => performance.now();

if (argv.includes('--emit')) { process.stdout.write(JSON.stringify(allPlans(terrain, zone, kgrid, clock).h)); process.exit(0); }

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const t0 = performance.now();
const mine = allPlans(terrain, zone, kgrid, clock);
console.log(`plans: ${Object.keys(mine.h.worlds).length} worlds in ${Math.round(performance.now() - t0)} ms (Node, one process: ${Object.entries(mine.ms).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')})`);

// 1. golden
if (!existsSync(GOLDEN) || argv.includes('--update')) {
  writeFileSync(GOLDEN, JSON.stringify(mine.h, null, 1) + '\n');
  console.log('wrote', GOLDEN);
}
const gold = JSON.parse(readFileSync(GOLDEN, 'utf8'));
check(gold.v === mine.h.v, `golden is for GEN_VERSION ${gold.v} (code ${mine.h.v})`);
for (const [k, w] of Object.entries(mine.h.worlds)) {
  const gw = gold.worlds[k];
  check(gw && JSON.stringify(gw) === JSON.stringify(w), `golden ${k}: plan ${w.hash}, spawn ${w.spawn.join(',')}, ${w.villages} villages, ${w.caves} caves, ${w.rooms} rooms, ${w.warps} warps${gw && gw.hash !== w.hash ? ' (golden ' + gw.hash + ')' : ''}`);
}

// 2. a second process
const second = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--emit'], { encoding: 'utf8', maxBuffer: 1 << 24 });
check(second.status === 0 && second.stdout === JSON.stringify(mine.h), `a second Node process gives identical plans (${second.stdout.length} bytes)`);

// 3. headless Chrome
if (opt('--browser')) {
  const PORT = Number(opt('--browser'));
  const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
  const { chromium } = createRequire(import.meta.url)(pwDir);
  const server = spawn('python3', [path.join(ROOT, 'serve.py'), String(PORT)], { stdio: 'ignore' });
  let browser;
  const setup = async () => {
    const lib = await import('/tools/gen_tests/plan_det_lib.mjs');
    const gen = await import('/src/gen/index.js');
    const t0 = performance.now();
    const raw = await (await fetch('/assets/world/terrain.json')).json();
    const terrain = gen.prepTerrain(raw);
    const prepMs = performance.now() - t0;
    const z = new Uint8Array(await (await fetch('/assets/world/zone.bin')).arrayBuffer()).slice(0, 408 * 400);
    const gb = await (await fetch('/assets/world/grid.bin')).arrayBuffer();
    const kgr = new Uint16Array(gb.slice(0, 408 * 400 * 2));
    const gd = new Uint16Array((await (await fetch('/assets/world/ground.bin')).arrayBuffer()).slice(0, 408 * 400 * 2));
    const K = await import('/src/gen/kanto.js'), wj = await (await fetch('/assets/world/world.json')).json();
    const kz = { kantoZone: z, kantoGrid: kgr, kantoGround: gd, kantoMat: K.kantoMatTable(wj.entries) };
    return { lib, terrain, z: kz, kg: null, prepMs };
  };
  try {
    await new Promise((r) => setTimeout(r, 800));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tools/gen_tests/plan_det_lib.mjs`);
    const t1 = Date.now();
    const theirs = await page.evaluate(`(async () => {
      const s = await (${setup.toString()})();
      return { ua: navigator.userAgent, r: s.lib.allPlans(s.terrain, s.z, s.kg, () => performance.now()), prepMs: s.prepMs };
    })()`);
    check(JSON.stringify(theirs.r.h) === JSON.stringify(mine.h), `headless Chrome (${theirs.ua.match(/Chrome\/[\d.]+/)?.[0]}) computes identical plans for all ${Object.keys(mine.h.worlds).length} worlds (${Date.now() - t1} ms; terrain.json load and prep ${Math.round(theirs.prepMs)} ms)`);
    await page.close();
    // the plan's time, cold: one plan per fresh page
    const timed = async (type, seed, rate) => {
      const pg = await browser.newPage();
      await pg.goto(`http://127.0.0.1:${PORT}/tools/gen_tests/plan_det_lib.mjs`);
      const cdp = await pg.context().newCDPSession(pg);
      await pg.evaluate(`(async () => { window.__s = await (${setup.toString()})(); })()`);
      if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      const r = await pg.evaluate(`(() => { const s = window.__s; const r = s.lib.onePlan(${JSON.stringify(type)}, ${JSON.stringify(seed)}, s.terrain, s.z, s.kg, () => performance.now()); return r; })()`);
      await pg.close();
      return r;
    };
    const runs = [['wild', 1], ['wild', 2], ['wild', 'hello'], ['wild', 7], ['kanto', 1], ['kanto', 2], ['kanto', 'hello'], ['kanto', 7]];
    for (const rate of [1, 4]) {
      const ms = [];
      for (const [type, seed] of runs) {
        const r = await timed(type, seed, rate);
        ms.push([`${type}:${seed}`, r.ms]);
        if (argv.includes('--parts')) console.log(`     ${rate}x ${type}:${seed} ${Math.round(r.ms)} ms: ${JSON.stringify(r.parts)}`);
      }
      const max = Math.max(...ms.map((m) => m[1])), lim = rate === 1 ? 300 : 1000;
      check(max < lim, `Chrome plan time ${rate === 1 ? 'desktop' : '4x CPU throttling'}, cold page each: ${ms.map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')} ms (max ${Math.round(max)}, target under ${lim})`);
    }
  } catch (e) {
    check(false, 'headless Chrome: ' + (e && e.stack || e));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

console.log(fails ? `plan hash: ${fails} failed` : 'plan hash: all passed');
process.exit(fails ? 1 : 0);
