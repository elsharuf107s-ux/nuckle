#!/usr/bin/env node
// Determinism and seams for the generator (design 11.1, stage 3a's part).
//
//   node tools/gen_tests/determinism.mjs [--browser PORT] [--update] [--emit]
//
// Checks, for both world types and the seeds 1, 2, 123456, -7 and 'hello':
//   1. golden: the threshold hash and 100 chunk hashes (64 central, 36 spread over the overworld) equal the
//      committed golden file gen_golden_v1.json (written by --update when it does not exist yet);
//   2. two runs: a second Node process computes the same hashes;
//   3. seeds differ: any two seeds of a type differ in at least 95% of the 64 central chunks;
//   4. seams: at 6 places per world (open land, a coast, a river, a lake, rock, and in a Kanto World a Kanto seam),
//      a 5 x 5 block of chunks generated one at a time in a shuffled order equals the same 160 x 160 cells
//      generated as one region, byte for byte, in every output array (biome, land, water);
//   5. --browser PORT: headless Chrome (serve.py on PORT, 5450..5499 for this track) imports the same modules and
//      computes the same hashes.
// --emit prints the hashes as JSON and exits (used by check 2).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allHashes, SEEDS, TYPES, CENTRAL } from './gen_det_lib.mjs';
import { kantoInputs } from './kanto_inputs.mjs';
import { makeGen, genRegion, genChunk, CHUNK } from '../../src/gen/index.js';
import { B } from '../../src/gen/biomes.js';
import { W_OCEAN, W_DEEP, W_RIVER, W_LAKE } from '../../src/gen/region.js';
import { hash32 } from '../../src/gen/hash.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GOLDEN = path.join(HERE, 'gen_golden_v1.json');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const zone = kantoInputs();   // (stage 6a: all of a Kanto World's inputs, not only the zone)

if (argv.includes('--emit')) { process.stdout.write(JSON.stringify(allHashes(zone))); process.exit(0); }

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const t0 = performance.now();
const mine = allHashes(zone);
console.log(`hashes: ${Object.keys(mine.worlds).length} worlds x 100 chunks in ${Math.round(performance.now() - t0)} ms`);

// 1. golden
if (!existsSync(GOLDEN) || argv.includes('--update')) {
  if (existsSync(GOLDEN) && !argv.includes('--force')) { console.log('golden exists: pass --force with --update to rewrite it'); process.exit(2); }
  writeFileSync(GOLDEN, JSON.stringify(mine, null, 1) + '\n');
  console.log('wrote', GOLDEN);
}
const gold = JSON.parse(readFileSync(GOLDEN, 'utf8'));
check(gold.v === mine.v, `golden is for GEN_VERSION ${gold.v} (code ${mine.v})`);
for (const [k, w] of Object.entries(mine.worlds)) {
  const gw = gold.worlds[k];
  const diff = !gw ? -1 : w.central.filter((h, i) => h !== gw.central[i]).length + w.spread.filter((h, i) => h !== gw.spread[i]).length;
  check(gw && gw.th === w.th && diff === 0, `golden ${k}: thresholds ${w.th}${gw && gw.th !== w.th ? ' (golden ' + gw.th + ')' : ''}, ${diff} of 100 chunks differ`);
}

// 2. a second process
const second = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--emit'], { encoding: 'utf8', maxBuffer: 1 << 24 });
check(second.status === 0 && second.stdout === JSON.stringify(mine), `a second Node process gives identical hashes (${second.stdout.length} bytes)`);

// 3. seeds differ
for (const type of TYPES) {
  let worst = 1;
  for (let i = 0; i < SEEDS.length; i++) {
    for (let j = i + 1; j < SEEDS.length; j++) {
      const a = mine.worlds[`${type}:${SEEDS[i]}`].central, b = mine.worlds[`${type}:${SEEDS[j]}`].central;
      worst = Math.min(worst, a.filter((h, k) => h !== b[k]).length / CENTRAL.length);
    }
  }
  check(worst >= 0.95, `${type}: any two seeds differ in at least ${(100 * worst).toFixed(1)}% of the 64 central chunks (>= 95%)`);
}

// 4. seams: find the places on a coarse scan (every 4th cell of the whole overworld) and compare
function findPlaces(g, r) {
  const want = {
    land: (b, w) => w === 0 && b !== B.KANTO,
    coast: null, river: null, lake: null, rock: null, kanto: null,
  };
  const score = { coast: [], river: [], lake: [], rock: [], kanto: [] };
  for (let cy = 2; cy < 48; cy += 1) {
    for (let cx = 2; cx < 48; cx += 1) {
      let sea = 0, land = 0, riv = 0, lak = 0, rock = 0, kan = 0, gen = 0;
      for (let y = cy * CHUNK; y < cy * CHUNK + CHUNK; y += 4) {
        for (let x = cx * CHUNK; x < cx * CHUNK + CHUNK; x += 4) {
          const i = y * 1600 + x, w = r.water[i], b = r.biome[i];
          if (w === W_OCEAN || w === W_DEEP) sea++; else land++;
          if (w === W_RIVER) riv++;
          if (w === W_LAKE) lak++;
          if (b === B.MOUNTAINS || b === B.STONY_HILLS || b === B.SNOWY_MOUNTAINS) rock++;
          if (b === B.KANTO) kan++; else gen++;
        }
      }
      if (sea > 12 && land > 12) score.coast.push([cx, cy]);
      if (riv > 4) score.river.push([cx, cy]);
      if (lak > 6) score.lake.push([cx, cy]);
      if (rock > 20) score.rock.push([cx, cy]);
      if (kan > 10 && gen > 10) score.kanto.push([cx, cy]);
    }
  }
  const places = [['land', [23, 23]]];
  for (const k of ['coast', 'river', 'lake', 'rock', 'kanto']) {
    const L = score[k];
    if (L.length) places.push([k, L[hash32(g.seed, L.length, k.length) % L.length]]);
  }
  return places;
}

function seamTest(g, cx0, cy0) {
  const N = 5, x0 = (cx0 - 2) * CHUNK, y0 = (cy0 - 2) * CHUNK;
  const reg = genRegion(g, x0, y0, N * CHUNK, N * CHUNK);
  const order = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) order.push([i, j]);
  for (let k = order.length - 1; k > 0; k--) { const m = hash32(g.seed, k, cx0, cy0) % (k + 1); const t = order[k]; order[k] = order[m]; order[m] = t; }
  let bad = 0;
  for (const [i, j] of order) {
    const c = genChunk(g, cx0 - 2 + i, cy0 - 2 + j);
    for (const key of ['biome', 'land', 'water']) {
      for (let y = 0; y < CHUNK; y++) {
        for (let x = 0; x < CHUNK; x++) {
          if (c[key][y * CHUNK + x] !== reg[key][(j * CHUNK + y) * N * CHUNK + i * CHUNK + x]) bad++;
        }
      }
    }
  }
  return bad;
}

for (const type of TYPES) {
  for (const seed of SEEDS) {
    const g = makeGen({ type, seed }, type === 'kanto' ? zone : {});
    const r = genRegion(g, 0, 0, 1600, 1600);
    const places = findPlaces(g, r);
    const res = places.map(([k, [cx, cy]]) => [k, cx, cy, seamTest(g, Math.min(47, Math.max(2, cx)), Math.min(47, Math.max(2, cy)))]);
    const kinds = res.map((p) => p[0]);
    const expect = type === 'kanto' ? 6 : 5;
    const bad = res.reduce((s, p) => s + p[3], 0);
    check(bad === 0 && res.length >= expect, `seams ${type}:${seed}: ${res.length} places (${res.map((p) => `${p[0]} ${p[1]},${p[2]}`).join('; ')}), ${bad} cells differ`);
    if (res.length < expect) console.log('     missing places:', ['land', 'coast', 'river', 'lake', 'rock', 'kanto'].filter((k) => !kinds.includes(k)).join(', '));
  }
}

// 5. headless Chrome
if (opt('--browser')) {
  const PORT = Number(opt('--browser'));
  const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
  const { chromium } = createRequire(import.meta.url)(pwDir);
  const server = spawn('python3', [path.join(ROOT, 'serve.py'), String(PORT)], { stdio: 'ignore' });
  let browser;
  try {
    await new Promise((r) => setTimeout(r, 800));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tools/gen_tests/gen_det_lib.mjs`);
    const t1 = Date.now();
    const theirs = await page.evaluate(async () => {
      const lib = await import('/tools/gen_tests/gen_det_lib.mjs');
      const z = new Uint8Array(await (await fetch('/assets/world/zone.bin')).arrayBuffer()).slice(0, 408 * 400);
      const gr = new Uint16Array((await (await fetch('/assets/world/grid.bin')).arrayBuffer()).slice(0, 408 * 400 * 2));
      const gd = new Uint16Array((await (await fetch('/assets/world/ground.bin')).arrayBuffer()).slice(0, 408 * 400 * 2));
      const K = await import('/src/gen/kanto.js'), wj = await (await fetch('/assets/world/world.json')).json();
      return { ua: navigator.userAgent, h: lib.allHashes({ kantoZone: z, kantoGrid: gr, kantoGround: gd, kantoMat: K.kantoMatTable(wj.entries) }) };
    });
    check(JSON.stringify(theirs.h) === JSON.stringify(mine), `headless Chrome (${theirs.ua.match(/Chrome\/[\d.]+/)?.[0]}) gives identical hashes (${Date.now() - t1} ms)`);
  } catch (e) {
    check(false, 'headless Chrome: ' + e.message);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

console.log(fails ? `determinism: ${fails} failed` : 'determinism: all passed');
process.exit(fails ? 1 : 0);
