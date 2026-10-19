#!/usr/bin/env node
// Stage 6b: Kanto's openings in Node (design 3.12, 4.7, 13 6b).
//
//   node tools/gen_tests/openings.mjs [--seeds 1,2,3,hello,-7,123456,24,40] [--out dir]
//
//   0. the candidates (kanto.js kantoOpeningCands, seed-independent): their count, every one through tree or rock
//      cells only, none touching water, at least 48 cells apart (outward ones), one into every hole over 400 cells
//      that has a candidate;
//   per seed (a Kanto World's plan, its openings applied), for every kept opening, painted over its re-tiled cells, its
//   corridor and 24 cells around them:
//   1. Kanto's cells: every cell that differs from Classic's is a seam cell (6a) or one of the opening's re-tiled cells,
//      and every one of those was a tree or rock cell in Classic (never a map's floor, a building, water or a warp);
//   2. walkable: a breadth-first search over walkable painted cells (collision 0, not water, no solid decoration) from
//      the corridor's far end reaches the opening's map cell (its `in`), through the out cell;
//   3. the corridor: no tree (but the pieces of Kanto's own crowns beside Kanto's cells), rock, ledge or solid decoration
//      in its cells (water stays: the sea may end it, a river or lake is swum);
//   4. one rim: every re-tiled Kanto rock cell with an open side shows a piece FireRed draws for those sides;
//   5. the painter's shape checks (4.7) over the window are zero (small biome patches reported), or no higher than the
//      same window's without the openings (a count the plan's other structures cause near Kanto is not the openings');
//   6. the seam test: the window painted as one region equals its data chunks painted one at a time, in a shuffled order;
//   --out writes each window (gen_render.py-compatible) for the crops.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeGen, makePlan, paintRegion } from '../../src/gen/index.js';
import { paintChecks } from '../../src/gen/checks.js';
import { C_ROCK, C_KANTO, C_FRESH, C_LEDGE, D } from '../../src/gen/chunk.js';
import { kantoContext, kantoOpeningCands, kantoClassAt, K_ROCK, K_TREE, K_SEA, SEAM, OPEN } from '../../src/gen/kanto.js';
import { kantoInputs } from './kanto_inputs.mjs';
import { terrainJSON, ROOT } from '../gen_dump.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SEEDS = String(opt('--seeds', '1,2,3,hello,-7,123456,24,40')).split(',').filter(Boolean).map((s) => (/^-?\d+$/.test(s) ? Number(s) : s));
const OUT = opt('--out', null);
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const kin = kantoInputs();
// shape counts of the painted seeds' windows looked at (the crops) and explained
const EXPLAINED = {
  '-7#2': { kinds: ['seam_ground'], text: 'a 32-cell straight line at y 1059 made of a tall grass edge, a pond\'s bottom and another tall grass edge; the corridor cleared the tall grass under the pond, which lies exactly across its cleared width' },
};
const W0 = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'world', 'world.json'), 'utf8'));
const terrain = terrainJSON();

// ---------------------------------------------------------------- 0. the candidates
{
  const ctx = kantoContext(kin.kantoZone, kin.kantoGrid, kin.kantoMat);
  const cands = kantoOpeningCands(ctx, kin.kantoGrid, kin.kantoMat);
  const W = 408, bad = [];
  for (const c of cands) {
    for (let i = 0; i < c.cells.length; i += 2) {
      const x = c.cells[i], y = c.cells[i + 1], kc = ctx.kc[y * W + x];
      if (kc !== K_TREE && kc !== K_ROCK) bad.push(`${c.id}: ${x},${y} class ${kc}`);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < 400 && ctx.z[yy * W + xx] < 2 && ctx.kc[yy * W + xx] === K_SEA) bad.push(`${c.id}: water beside ${x},${y}`);
      }
    }
  }
  const outer = cands.filter((c) => c.kind === 'outer');
  let minGap = Infinity;
  for (let i = 0; i < outer.length; i++) for (let j = i + 1; j < outer.length; j++) minGap = Math.min(minGap, Math.max(Math.abs(outer[i].out[0] - outer[j].out[0]), Math.abs(outer[i].out[1] - outer[j].out[1])));
  const holes = new Set(cands.filter((c) => c.kind === 'hole').map((c) => c.hole));
  check(!bad.length && minGap >= OPEN.spacing && outer.length >= 8,
    `candidates: ${cands.length} (${outer.length} outward, ${holes.size} into holes of the ${ctx.openStats.holes} over ${OPEN.holeMin} cells; ${ctx.openStats.starts} band starts, ${ctx.openStats.tried} tested), only tree and rock cells re-tiled, no water beside them, outward ones at least ${minGap} cells apart; by side ${JSON.stringify(cands.reduce((m, c) => { m[c.dir] = (m[c.dir] || 0) + 1; return m; }, {}))}; through rock ${cands.filter((c) => c.rock.length).length}, through trees ${cands.filter((c) => c.gone.length).length} ${bad.slice(0, 3).join('; ')}`);
}

// ---------------------------------------------------------------- per seed
const zv = (x, y) => (x < 0 || y < 0 || x >= 408 || y >= 400 ? 2 : kin.kantoZone[y * 408 + x]);
const seamAt = (lx, ly) => {
  if (zv(lx, ly) !== 1) return false;
  for (let dy = -SEAM; dy <= SEAM; dy++) for (let dx = -SEAM; dx <= SEAM; dx++) if (zv(lx + dx, ly + dy) >= 2) return true;
  return false;
};
const WARPS = new Set(W0.warps.filter((w) => Number.isInteger(w.y) && w.y < 400).map((w) => w.y * 408 + w.x));
let kept = 0, keptOuter = 0, windows = 0;
for (const seed of SEEDS) {
  const g = makeGen({ type: 'kanto', seed }, { terrain, cache: true, ...kin });
  const plan = makePlan(g), j = plan.json, k = g.kanto, T = g.terrain;
  const ops = j.openings || [];
  kept += ops.length; keptOuter += ops.filter((o) => o.kind === 'outer').length;
  const ent = (t) => (t < T.genBase ? W0.entries[t] : T.entries[t - T.genBase]);
  const WALK_DECO = new Set([0, D.DANDELION, D.POPPY]);
  const cell = k.open ? k.open.cell : null;
  const notes = [];
  for (const o of ops) {
    windows++;
    // the window: the re-tiled box, the corridor, 24 more around them, aligned to the data chunks (the seam test)
    const [cx0, cy0, cw, ch] = o.corr;
    let x0 = Math.min(o.box[0], cx0) - 24, y0 = Math.min(o.box[1], cy0) - 24, x1 = Math.max(o.box[2] + 1, cx0 + cw) + 24, y1 = Math.max(o.box[3] + 1, cy0 + ch) + 24;
    x0 = Math.max(0, Math.floor(x0 / 32) * 32); y0 = Math.max(0, Math.floor(y0 / 32) * 32);
    x1 = Math.min(1600, Math.ceil(x1 / 32) * 32); y1 = Math.min(1600, Math.ceil(y1 / 32) * 32);
    const w = x1 - x0, h = y1 - y0;
    const p = paintRegion(g, x0, y0, w, h, { debug: true });
    const at = (x, y) => (y - y0) * w + (x - x0);
    const tag = `${seed} #${o.id} ${o.kind} ${o.dir} out ${o.out}`;
    // 1. Kanto's cells
    let diff = 0, stray = 0, notSolid = 0, warp = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const lx = x - k.x, ly = y - k.y;
      if (zv(lx, ly) >= 2) continue;
      const c = kin.kantoGrid[ly * 408 + lx];
      if (p.tile[at(x, y)] === c) continue;
      diff++;
      const op = cell && cell[ly * 408 + lx] === 1;
      if (!op && !seamAt(lx, ly)) stray++;
      const kc = kantoClassAt(k, x, y);
      if (kc !== K_TREE && kc !== K_ROCK) notSolid++;
      if (WARPS.has(ly * 408 + lx)) warp++;
    }
    // 2. walkable from the corridor's far end to the map cell, through the out cell
    const walk = (x, y) => {
      if (x < x0 || y < y0 || x >= x1 || y >= y1) return false;
      const i = at(x, y), e = ent(p.tile[i]);
      if (e[3] !== 0 || e[4] === 'water' || e[4] === 'ice' || p.dbg.solid[i]) return false;
      return WALK_DECO.has(p.deco[i]);
    };
    // the walk starts where the corridor's middle line stops being walkable going out (a coast, a hole's far side), at
    // least OPEN.keep cells out (the plan's keep test)
    let start = null, run = 0;
    for (let tt = 0; tt < OPEN.corridor; tt++) {
      const x = o.out[0] + o.n[0] * tt, y = o.out[1] + o.n[1] * tt;
      if (!walk(x, y)) break;
      start = [x, y]; run = tt + 1;
    }
    if (run < OPEN.keep) start = null;
    let reached = false, viaOut = false;
    if (start) {
      const seen = new Uint8Array(w * h), q = [start], from = new Map();
      seen[at(start[0], start[1])] = 1;
      for (let hh = 0; hh < q.length; hh++) {
        const [x, y] = q[hh];
        if (x === o.in[0] && y === o.in[1]) { reached = true; break; }
        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          const nx = x + dx, ny = y + dy;
          if (!walk(nx, ny) || seen[at(nx, ny)]) continue;
          seen[at(nx, ny)] = 1; from.set(ny * 4096 + nx, y * 4096 + x); q.push([nx, ny]);
        }
      }
      // the out cell lies on the path back from the map cell (the cut, not another way round)
      if (reached) { let kk = o.in[1] * 4096 + o.in[0]; while (from.has(kk)) { if (kk === o.out[1] * 4096 + o.out[0] || Math.abs((kk % 4096) - o.out[0]) + Math.abs(Math.floor(kk / 4096) - o.out[1]) <= 2) { viaOut = true; break; } kk = from.get(kk); } }
    }
    // 3. the corridor's cells
    let cbad = 0, ccells = 0;
    const cwhy = [];
    for (let y = cy0; y < cy0 + ch; y++) for (let x = cx0; x < cx0 + cw; x++) {
      if (x < x0 || y < y0 || x >= x1 || y >= y1) continue;
      const i = at(x, y), c = p.cls[i];
      if (c === C_KANTO) continue;
      ccells++;
      // (a generated cell beside Kanto may carry the piece of a Kanto crown cut off by the void: 6a's rule)
      let byK = false;
      for (let dy = -1; dy <= 1 && !byK; dy++) for (let dx = -1; dx <= 1; dx++) if (zv(x + dx - k.x, y + dy - k.y) < 2) { byK = true; break; }
      if ((p.dbg.tree[i] && !byK) || c === C_ROCK || c === C_LEDGE || p.dbg.solid[i]) { cbad++; if (cwhy.length < 4) cwhy.push(`${x},${y}:${p.dbg.tree[i] ? 'tree' : c === C_ROCK ? 'rock' : c === C_LEDGE ? 'ledge' : c === C_FRESH ? 'fresh' : 'solid'}`); }
    }
    // 4. one rim over the re-tiled Kanto rock
    const rockU = (x, y) => {
      if (x < x0 || y < y0 || x >= x1 || y >= y1) return true;
      const c = p.cls[at(x, y)];
      return c === C_ROCK || (c === C_KANTO && kantoClassAt(k, x, y) === K_ROCK && !(k.open && k.open.cut[(y - k.y) * 408 + (x - k.x)]));
    };
    const midOf = (t) => (t < T.genBase ? t : T.entries[t - T.genBase][0]);
    let rim = 0, rimBad = 0;
    for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
      const i = at(x, y);
      if (p.cls[i] !== C_KANTO || kantoClassAt(k, x, y) !== K_ROCK || !cell || cell[(y - k.y) * 408 + (x - k.x)] !== 1) continue;
      if (k.open.cut[(y - k.y) * 408 + (x - k.x)]) continue;
      const open = (!rockU(x, y - 1) ? 1 : 0) | (!rockU(x + 1, y) ? 2 : 0) | (!rockU(x, y + 1) ? 4 : 0) | (!rockU(x - 1, y) ? 8 : 0);
      rim++;
      if (open && !T.rock.sides.has(midOf(p.tile[i]) * 16 + open)) rimBad++;
    }
    // 5. shape checks
    const pc = paintChecks(p, g);
    let nz = Object.entries(pc.counts).filter(([kk, v]) => v && kk !== 'small_biome');
    // a count the window has without the openings too is not theirs (the same window painted with k.open off)
    let base = null;
    if (nz.length) {
      const keep = k.open;
      k.open = null;
      try { base = paintChecks(paintRegion(g, x0, y0, w, h, { debug: true }), g).counts; } finally { k.open = keep; }
      nz = nz.filter(([kk, v]) => v > (base[kk] || 0));
    }
    // 6. the seam test: the window's chunks one at a time in a shuffled order
    const order = [];
    for (let cy = y0 / 32; cy < y1 / 32; cy++) for (let cx = x0 / 32; cx < x1 / 32; cx++) order.push([cx, cy]);
    for (let i = order.length - 1; i > 0; i--) { const r = (i * 7919 + 13) % (i + 1); [order[i], order[r]] = [order[r], order[i]]; }
    let seamDiff = 0;
    for (const [cx, cy] of order) {
      const c = paintRegion(g, cx * 32, cy * 32, 32, 32);
      for (let yy = 0; yy < 32; yy++) for (let xx = 0; xx < 32; xx++) {
        const a = at(cx * 32 + xx, cy * 32 + yy), b = yy * 32 + xx;
        if (c.tile[b] !== p.tile[a] || c.ground[b] !== p.ground[a] || c.deco[b] !== p.deco[a] || c.biome[b] !== p.biome[a]) seamDiff++;
      }
    }
    // shape counts looked at and explained (design 11.2: a non-zero count is allowed when each case is looked at)
    const why = EXPLAINED[`${seed}#${o.id}`];
    if (why && nz.length && nz.every(([kk]) => why.kinds.includes(kk))) { notes.push(`(#${o.id}: ${why.text})`); nz = []; }
    const ok = stray === 0 && notSolid === 0 && warp === 0 && reached && viaOut && cbad === 0 && rimBad === 0 && !nz.length && seamDiff === 0;
    if (!ok) check(false, `${tag}: ${diff} Kanto cells differ (${stray} outside the seam and the opening, ${notSolid} not tree or rock, ${warp} warps); walk from ${start} (${run} corridor cells) to the map cell ${o.in}: ${reached ? 'reached' : 'NOT reached'}${viaOut ? ' through the out cell' : ''}; corridor ${cbad} of ${ccells} cells blocked ${cwhy.join(' ')}; rim ${rimBad} of ${rim}; shape ${JSON.stringify(Object.fromEntries(nz))} ${JSON.stringify(nz.map(([kk]) => pc.samples && pc.samples[kk]))} (without the openings ${JSON.stringify(base && Object.fromEntries(nz.map(([kk]) => [kk, base[kk]])))}); seam ${seamDiff} cells differ`);
    else notes.push(`#${o.id}${o.dir}${o.kind === 'hole' ? 'h' : ''} ${diff}c/${rim}r/${ccells}k/${order.length}ch`);
    if (OUT) {
      const d = path.join(OUT, `open_${seed}_${o.id}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, 'tile.bin'), Buffer.from(p.tile.buffer));
      writeFileSync(path.join(d, 'ground.bin'), Buffer.from(p.ground.buffer));
      writeFileSync(path.join(d, 'deco.bin'), Buffer.from(p.deco.buffer));
      writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ type: 'kanto', seed, rect: [x0, y0, w, h], opening: o, paint: true }));
    }
  }
  check(ops.length >= 1 && ops.some((o) => o.kind === 'outer'), `${seed} (Kanto at ${k.x},${k.y}): ${ops.length} openings kept (${ops.filter((o) => o.kind === 'outer').length} outward), spawn rung ${j.spawn.rung}; all checks pass for ${notes.length}: ${notes.join(' ')}`);
}
console.log(`${kept} openings kept over ${SEEDS.length} seeds (${keptOuter} outward), ${windows} windows painted`);
console.log(fails ? `openings: ${fails} failed` : 'openings: all passed');
process.exit(fails ? 1 : 0);
