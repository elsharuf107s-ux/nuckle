#!/usr/bin/env node
// The Wild World stronghold entrance (design 3.13, stage 6c's "Must prove": the entrance placed on 1,000 seeds).
// For N Wild World seeds the plan is computed and its entrance checked, then the 48 x 48 cells around it are painted
// with the plan's stamps (as the game's chunks are) and checked on the finished arrays with world.json's and
// terrain.json's collision and material data:
//   * the plan has an entrance on rung 1..5, 250 to 450 cells (Chebyshev) from the spawn, at least 48 cells inside the
//     border and the coast (coarse sea distance), not in Kanto; rungs 1 to 3 at least 64 cells from villages and caves,
//     rung 4 at least 16; so the spawn has no stronghold within 128 (3.14);
//   * a 'ruin' structure group covers the ruin stamp;
//   * the entrance cell shows the closed entrance (RUIN_CLOSED) with the open stairs as its ground (RUIN_OPEN), and these
//     are world.json's stronghold.entranceTiles;
//   * the 8 ring cells carry mossy or cracked stone brick decorations;
//   * every other cell within 2 of the entrance is walkable plain ground, and from the cell south of the entrance (the
//     stairs' arrival walks down onto it) a walk over walkable cells leaves the ruin's clearing (reaches 10 cells away).
//
//   node tools/gen_tests/stronghold.mjs [--seeds 1000] [--from 1] [--workers 4] [--json out.json]
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const rd = (f) => readFileSync(path.join(ROOT, 'assets', 'world', f));

async function worker() {
  const { makeGen, makePlan, paintRegion, prepTerrain } = await import('../../src/gen/index.js');
  const { BORDER, PLAN } = await import('../../src/gen/plan.js');
  const { D, RUIN_CLOSED, RUIN_OPEN, RUIN_RING } = await import('../../src/gen/chunk.js');
  const { BIOMES } = await import('../../src/gen/biomes.js');
  const raw = JSON.parse(rd('terrain.json'));
  const terrain = prepTerrain(raw);
  const world = JSON.parse(rd('world.json'));
  const GB = raw.genBase;
  const ent = (t) => (t < GB ? world.entries[t] : raw.entries[t - GB]);
  const tilesOk = world.stronghold.entranceTiles.closed === RUIN_CLOSED && world.stronghold.entranceTiles.open === RUIN_OPEN;
  const BRICKS = new Set([D.MOSSY_STONE_BRICKS, D.CRACKED_STONE_BRICKS]);
  const rectD = (x, y, x0, y0, w, h) => Math.max(x < x0 ? x0 - x : x >= x0 + w ? x - (x0 + w - 1) : 0, y < y0 ? y0 - y : y >= y0 + h ? y - (y0 + h - 1) : 0);
  parentPort.on('message', (job) => {
    if (!job) process.exit(0);
    const { seed } = job;
    const out = { seed, ok: false, why: [] }, why = out.why;
    try {
      const t0 = performance.now();
      const g = makeGen({ type: 'wild', seed }, { terrain });
      const plan = makePlan(g);
      out.planMs = performance.now() - t0;
      const j = plan.json, s = j.stronghold, sp = j.spawn;
      if (!tilesOk) why.push('RUIN_CLOSED / RUIN_OPEN differ from world.json stronghold.entranceTiles');
      if (!s) { why.push('no stronghold in the plan'); parentPort.postMessage(out); return; }
      Object.assign(out, { x: s.x, y: s.y, rung: s.rung, biome: s.biome, warnings: plan.warnings, fallback: !!plan.stats.strongholdFallback });
      const d = Math.max(Math.abs(s.x - sp.x), Math.abs(s.y - sp.y));
      out.dist = d;
      if (!(s.rung >= 1 && s.rung <= 5)) why.push('rung ' + s.rung);
      if (d < PLAN.strongholdBand[0] || d > PLAN.strongholdBand[1]) why.push(`${d} cells from the spawn`);
      if (d < 128) why.push('within 128 of the spawn');
      const inside = Math.min(s.x - BORDER.x0, s.y - BORDER.y0, BORDER.x1 - s.x, BORDER.y1 - s.y);
      if (inside < 48) why.push(`only ${inside} inside the border`);
      const n = plan.cm.n, q = Math.round(s.y / 8) * n + Math.round(s.x / 8);
      out.coast = plan.cm.dSea[q] * 8;
      if (plan.cm.dSea[q] * 8 < 48) why.push(`only ${plan.cm.dSea[q] * 8} inside the coast`);
      if (s.px !== s.x + 416 || s.py !== s.y) why.push('plane cell');
      let dv = 9999, dc = 9999;
      for (const v of j.villages) dv = Math.min(dv, rectD(s.x, s.y, v.x0, v.y0, v.w, v.h));
      for (const c of j.caves) dc = Math.min(dc, rectD(s.x, s.y, c.hill[0], c.hill[1], c.hill[2], c.hill[3] + 3));
      out.dv = dv; out.dc = dc;
      const need = s.rung <= 3 ? 64 : s.rung === 4 ? 16 : 0;
      if (dv < need) why.push(`village ${dv} cells away on rung ${s.rung}`);
      if (dc < need) why.push(`cave ${dc} cells away on rung ${s.rung}`);
      const r = s.ruin, gr = j.groups.find((x) => x.kind === 'ruin');
      if (!gr || gr.cx0 > Math.floor(r.x0 / 32) || gr.cx1 < Math.floor((r.x0 + r.w - 1) / 32) || gr.cy0 > Math.floor(r.y0 / 32) || gr.cy1 < Math.floor((r.y0 + r.h - 1) / 32)) why.push('no ruin group over the stamp');
      // the painted ruin
      const S = 48, X0 = s.x - 24, Y0 = s.y - 24;
      const p = paintRegion(g, X0, Y0, S, S, {});
      const k = (x, y) => (y - Y0) * S + (x - X0);
      const walk = (x, y) => { const i = k(x, y), e = ent(p.tile[i]); return e[3] === 0 && e[4] !== 'water' && e[4] !== 'ice' && e[4] !== 'tree' && (p.deco[i] === 0 || p.deco[i] === D.DANDELION || p.deco[i] === D.POPPY); };
      const ke = k(s.x, s.y);
      out.pbiome = BIOMES[p.biome[ke]].key;
      if (p.tile[ke] !== RUIN_CLOSED || p.ground[ke] !== RUIN_OPEN) why.push(`entrance cell tile ${p.tile[ke]} ground ${p.ground[ke]}`);
      let bricks = 0;
      for (const [dx, dy] of RUIN_RING) if (BRICKS.has(p.deco[k(s.x + dx, s.y + dy)])) bricks++;
      out.bricks = bricks;
      if (bricks !== 8) why.push(`${bricks} ring bricks`);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        if (!walk(s.x + dx, s.y + dy)) why.push(`cell (${dx}, ${dy}) not walkable (${ent(p.tile[k(s.x + dx, s.y + dy)])[4]})`);
      }
      // out of the clearing from the arrival cell
      const seen = new Uint8Array(S * S), st = [[s.x, s.y + 1]];
      seen[k(s.x, s.y + 1)] = 1;
      let far = 0;
      while (st.length) {
        const [x, y] = st.pop();
        far = Math.max(far, Math.max(Math.abs(x - s.x), Math.abs(y - s.y)));
        if (far >= 10) break;
        for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + ax, Y = y + ay;
          if (X < X0 || Y < Y0 || X >= X0 + S || Y >= Y0 + S || seen[k(X, Y)] || !walk(X, Y)) continue;
          seen[k(X, Y)] = 1; st.push([X, Y]);
        }
      }
      out.far = far;
      if (far < 10) why.push(`a walk from the arrival cell reaches only ${far} cells`);
      out.ok = why.length === 0;
    } catch (e) {
      why.push('error ' + (e && e.stack || e));
    }
    parentPort.postMessage(out);
  });
}

if (!isMainThread) await worker();
else {
  const argv = process.argv.slice(2);
  const opt = (nm, d) => { const i = argv.indexOf(nm); return i >= 0 ? argv[i + 1] : d; };
  const N = Number(opt('--seeds', 1000)), from = Number(opt('--from', 1)), nw = Number(opt('--workers', 4));
  const todo = [];
  for (let s = from; s < from + N; s++) todo.push({ seed: s });
  const results = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    let next = 0, live = nw;
    for (let w = 0; w < nw; w++) {
      const wk = new Worker(SELF);
      const feed = () => { if (next < todo.length) wk.postMessage(todo[next++]); else { wk.postMessage(null); if (--live === 0) resolve(); } };
      wk.on('message', (r) => {
        results.push(r);
        if (!r.ok) console.log(`FAIL wild ${r.seed}: ${r.why.join('; ')}`);
        if (results.length % 100 === 0) console.log(`${results.length} / ${todo.length} (${Math.round((performance.now() - t0) / 1000)} s)`);
        feed();
      });
      wk.on('error', (e) => { console.log('worker error', e); });
      feed();
    }
  });
  results.sort((a, b) => a.seed - b.seed);
  const pass = results.filter((r) => r.ok).length;
  const rungs = [0, 0, 0, 0, 0, 0];
  for (const r of results) if (r.rung) rungs[r.rung]++;
  const q = (arr, f) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(f * (a.length - 1)))]; };
  const dist = results.map((r) => r.dist).filter((v) => v > 0), coast = results.map((r) => r.coast).filter((v) => v >= 0);
  const pb = {};
  for (const r of results) if (r.pbiome) pb[r.pbiome] = (pb[r.pbiome] || 0) + 1;
  console.log(`stronghold wild: ${pass} / ${results.length} pass; rungs 1..5: ${rungs.slice(1).join(', ')}; no-candidate fallbacks ${results.filter((r) => r.fallback).length}`);
  console.log(`  distance from the spawn min ${Math.min(...dist)} median ${q(dist, 0.5)} max ${Math.max(...dist)}; coast min ${Math.min(...coast)}; painted biomes ${JSON.stringify(pb)}`);
  console.log(`  time ${Math.round((performance.now() - t0) / 1000)} s`);
  if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(results));
  const ok = pass === results.length;
  console.log(ok ? 'stronghold: all passed' : 'stronghold: FAILED');
  process.exit(ok ? 0 : 1);
}
