#!/usr/bin/env node
// Stage 6a: Kanto in a generated world, in Node (design 3.12, 3.5, 4.7, 13 6a).
//
//   node tools/gen_tests/kanto.mjs [--seeds 200] [--paint 1,2,3,hello,-7,123456] [--out dir]
//
//   1. placement: on --seeds seeds the plan check passes (index.js kantoSeaCheck: the share of Kanto's outward sea
//      cells that face the world's ocean, pass mark 0.8); the placements used and the lowest share are printed;
//   2. per painted seed, over Kanto's box and the land and sea around it down to the overworld's south and west edges:
//      a. Kanto's cells equal Classic's except the listed border cells (zone 1 fill within 3 cells of the seam), and
//         every changed cell is tree or rock fill;
//      b. no void: every generated cell has a tile;
//      c. Kanto's sea tile band: generated sea within 24 cells of Kanto's sea is Kanto's open-sea entry;
//      d. no deep ocean within 40 cells of Kanto's sea (the 48-cell rule's contour wanders by up to 8 cells), except
//         in the last 18 cells of the overworld (region.js kantoEdgeDeep: with Kanto at ky 1152 its south sea lies 41
//         cells from the strip past the border), and there not within 30;
//      e. the strip past the border (the overworld's last 8 cells) beside Kanto is deep ocean everywhere (the 3a note:
//         it was shallow at kx 64, and below Kanto's south sea at ky 1152);
//      f. one rim: every rock cell of the union mask (generated rock and Kanto's rock) with an open side shows a piece
//         FireRed draws for those sides (generated and re-tiled Kanto cells; no double cliff, no cut rim);
//      g. the painter's shape checks (4.7) over the area are zero (small biome patches are reported, not failed);
//   --out writes each seed's painted area (gen_render.py-compatible: meta.json, tile.bin, ground.bin, deco.bin) for crops.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeGen, paintRegion } from '../../src/gen/index.js';
import { paintChecks } from '../../src/gen/checks.js';
import { C_SEA, C_ROCK, C_KANTO } from '../../src/gen/chunk.js';
import { kantoClassAt, kantoDist, K_SEA, K_ROCK, SEAM } from '../../src/gen/kanto.js';
import { W_DEEP } from '../../src/gen/region.js';
import { kantoInputs } from './kanto_inputs.mjs';
import { terrainJSON, ROOT } from '../gen_dump.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const NSEEDS = Number(opt('--seeds', '200'));
const PAINT = String(opt('--paint', '1,2,3,hello,-7,123456,24,40')).split(',').filter(Boolean).map((s) => (/^-?\d+$/.test(s) ? Number(s) : s));
const OUT = opt('--out', null);
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const kin = kantoInputs();

// ---------------------------------------------------------------- 1. placement
{
  const t0 = performance.now(), used = {};
  let low = 1, lowSeed = null, failed = [];
  for (let s = 1; s <= NSEEDS; s++) {
    const g = makeGen({ type: 'kanto', seed: s }, kin), c = g.kantoCheck;
    used[`${c.kx},${c.ky}`] = (used[`${c.kx},${c.ky}`] || 0) + 1;
    if (c.share < low) { low = c.share; lowSeed = s; }
    if (!c.pass) failed.push(s);
  }
  check(!failed.length, `placement check on seeds 1..${NSEEDS}: ${NSEEDS - failed.length} pass; lowest share ${low.toFixed(3)} (seed ${lowSeed}); placements ${JSON.stringify(used)} (${Math.round(performance.now() - t0)} ms)${failed.length ? ' failed: ' + failed.slice(0, 10).join(',') : ''}`);
}

// ---------------------------------------------------------------- 2. painted seeds
const terrain = terrainJSON();
const W0 = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'world', 'world.json'), 'utf8'));
const FILL = new Set([113, 20, 21, 28, 29]);
for (const seed of PAINT) {
  const t0 = performance.now();
  const g = makeGen({ type: 'kanto', seed }, { terrain, cache: true, ...kin });
  const k = g.kanto, T = g.terrain;
  const x0 = 0, y0 = k.y - 64, w = k.x + k.w + 64, h = 1600 - y0;
  const p = paintRegion(g, x0, y0, w, h, { debug: true });
  const pc = paintChecks(p, g);
  const ms = Math.round(performance.now() - t0);
  const at = (x, y) => (y - y0) * w + (x - x0);
  // a. Kanto's cells
  let cells = 0, diff = 0, notSeam = 0, notFill = 0;
  const seamAt = (lx, ly) => {
    const zv = (x, y) => (x < 0 || y < 0 || x >= 408 || y >= 400 ? 2 : kin.kantoZone[y * 408 + x]);
    if (zv(lx, ly) !== 1) return false;
    for (let dy = -SEAM; dy <= SEAM; dy++) for (let dx = -SEAM; dx <= SEAM; dx++) if (zv(lx + dx, ly + dy) >= 2) return true;
    return false;
  };
  for (let ly = 0; ly < 400; ly++) for (let lx = 0; lx < 408; lx++) {
    if (kin.kantoZone[ly * 408 + lx] >= 2) continue;
    cells++;
    const t = p.tile[at(k.x + lx, k.y + ly)], c = kin.kantoGrid[ly * 408 + lx];
    if (t === c) continue;
    diff++;
    if (!seamAt(lx, ly)) notSeam++;
    if (!FILL.has(c)) notFill++;
  }
  check(cells === 105978 && notSeam === 0 && notFill === 0, `${seed} (Kanto at ${k.x},${k.y}): Kanto's ${cells} cells equal Classic's except ${diff} border cells, all zone 1 fill within ${SEAM} cells of the seam (${notSeam} elsewhere, ${notFill} not fill)`);
  // b. no void, c. Kanto's sea tile band, d. no deep near Kanto's sea, e. the edge beside Kanto, f. one rim
  let voids = 0, band = 0, bandBad = 0, minDeep = 255, minDeepEdge = 255, edge = 0, edgeDeep = 0, rimBad = 0, rimCells = 0;
  const rockU = (x, y) => {
    if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return true;
    const c = p.cls[at(x, y)];
    return c === C_ROCK || (c === C_KANTO && kantoClassAt(k, x, y) === K_ROCK);
  };
  const midOf = (t) => (t < T.genBase ? t : T.entries[t - T.genBase][0]);
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = at(x, y), c = p.cls[i];
    if (c === C_KANTO) {
      // f. Kanto's re-tiled rock cells (their tile changed) take part in the one-rim check
      if (kantoClassAt(k, x, y) === K_ROCK && p.tile[i] !== kin.kantoGrid[(y - k.y) * 408 + (x - k.x)]) {
        const open = (!rockU(x, y - 1) ? 1 : 0) | (!rockU(x + 1, y) ? 2 : 0) | (!rockU(x, y + 1) ? 4 : 0) | (!rockU(x - 1, y) ? 8 : 0);
        rimCells++;
        if (open && !T.rock.sides.has(midOf(p.tile[i]) * 16 + open)) rimBad++;
      }
      continue;
    }
    if (!p.tile[i]) voids++;
    const ds = kantoDist(k, K_SEA, x, y);
    if (c === C_SEA && ds <= 24) { band++; if (p.tile[i] !== T.waterTile) bandBad++; }
    const ed = Math.min(x, y, 1599 - x, 1599 - y);
    if (p.water[i] === W_DEEP && ed >= 18 && ds < minDeep) minDeep = ds;
    if (p.water[i] === W_DEEP && ed < 18 && ds < minDeepEdge) minDeepEdge = ds;
    if (ed < 8) { edge++; if (p.water[i] === W_DEEP) edgeDeep++; }
  }
  check(voids === 0, `${seed}: no void (${voids} generated cells without a tile)`);
  check(band > 200 && bandBad === 0, `${seed}: Kanto's sea tile band: ${band} generated sea cells within 24 of Kanto's sea are entry ${T.waterTile} (${bandBad} not)`);
  check(minDeep >= 40 && minDeepEdge >= 30, `${seed}: no deep ocean within 40 cells of Kanto's sea (nearest deep cell ${minDeep} cells; in the overworld's last 18 cells ${minDeepEdge})`);
  check(edge > 400 && edgeDeep === edge, `${seed}: the strip past the border beside Kanto is deep ocean (${edgeDeep} of ${edge} cells in the overworld's last 8 rows and columns)`);
  check(rimBad === 0 && pc.counts.cliff_dangling === 0, `${seed}: one rim across the seam: ${rimCells} re-tiled Kanto rock cells (${rimBad} with a piece FireRed does not draw for their open sides), generated cliffs dangling ${pc.counts.cliff_dangling}`);
  const nz = Object.entries(pc.counts).filter(([kk, v]) => v && kk !== 'small_biome');
  check(!nz.length, `${seed}: shape checks over ${w} x ${h} cells all zero${nz.length ? ': ' + JSON.stringify(Object.fromEntries(nz)) : ''} (small biome patches ${pc.counts.small_biome}); painted in ${ms} ms`);
  if (OUT) {
    const d = path.join(OUT, `kanto_${seed}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'tile.bin'), Buffer.from(p.tile.buffer));
    writeFileSync(path.join(d, 'ground.bin'), Buffer.from(p.ground.buffer));
    writeFileSync(path.join(d, 'deco.bin'), Buffer.from(p.deco.buffer));
    writeFileSync(path.join(d, 'cls.bin'), Buffer.from(p.cls.buffer));
    writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ type: 'kanto', seed, rect: [x0, y0, w, h], kanto: { x: k.x, y: k.y, w: k.w, h: k.h }, paint: true }));
  }
}
void W0;
console.log(fails ? `kanto: ${fails} failed` : 'kanto: all passed');
process.exit(fails ? 1 : 0);
