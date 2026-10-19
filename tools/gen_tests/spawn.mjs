#!/usr/bin/env node
// The spawn test (design 11.3, stage 3c's "Must prove"): for N seeds of a world type, the plan is computed and its
// spawn is checked on the finished arrays of the 3 x 3 data chunks around it (painted as one 96 x 96 region, which
// the seam test makes byte-identical to the chunks painted one by one), with the game's own collision and behaviour
// data (world.json's General entries, terrain.json's generated ones):
//   * the spawn cell is zone 0 (inside the border, not Kanto's), walkable (collision 0, no solid decoration), not
//     water or ice, not tall grass, not a ledge, not under a tree;
//   * a 5 x 5 block of such cells contains it (3 x 3 on rung 3, where the ladder shrinks the clearing);
//   * at least 4 trees are drawn within 12 cells (Chebyshev; crowns of the painted tree lattice whose cells carry tree
//     entries);
//   * its painted biome is PLAINS, FOREST, BIRCH FOREST or TAIGA (rung 2 and 3 add DARK FOREST and SAVANNA; rung 4 is a
//     meadow), and the plan reports that biome;
//   * no village within 96 cells, no cave mouth within 32;
//   * Wild World: at least 240 cells inside the border (180 on rung 3, whose band widens by 25%); Kanto World: 280 to
//     460 cells from Kanto's box (210 to 575 on rung 3), and (6b) on Kanto's land side: a coarse land path (a
//     breadth-first search over the plan's coarse grid, land, rivers and beaches passing, the sea, rock and Kanto not)
//     from the spawn's coarse point to a point along a kept outward opening's corridor.
// It records the rung each seed needed (target: rung 1 for at least 98%), the plan time (in parallel workers, so
// inflated by contention: plan_perf.mjs measures it alone), the room-slot demand and the village and cave counts.
//
//   node tools/gen_tests/spawn.mjs [--type wild] [--seeds 1000] [--from 1] [--workers 6] [--json out.json] [--min-rung 2|3|4]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const rd = (f) => readFileSync(path.join(ROOT, 'assets', 'world', f));

async function worker() {
  const { makeGen, makePlan, paintRegion, prepTerrain } = await import('../../src/gen/index.js');
  const { BORDER, PLAN } = await import('../../src/gen/plan.js');
  const { D } = await import('../../src/gen/chunk.js');
  const { BIOMES } = await import('../../src/gen/biomes.js');
  const { kantoBoxDist, isKantoCell } = await import('../../src/gen/kanto.js');
  const raw = JSON.parse(rd('terrain.json'));
  const terrain = prepTerrain(raw);
  const world = JSON.parse(rd('world.json'));
  const z = rd('zone.bin'), zone = new Uint8Array(z.buffer, z.byteOffset, 408 * 400).slice();
  const gb = rd('grid.bin'), kgrid = new Uint16Array(gb.buffer.slice(gb.byteOffset, gb.byteOffset + 408 * 400 * 2));
  const { kantoInputs } = await import('./kanto_inputs.mjs'), kin = kantoInputs();
  const GB = raw.genBase;
  const ent = (t) => (t < GB ? world.entries[t] : raw.entries[t - GB]);
  const WALK_DECO = new Set([0, D.DANDELION, D.POPPY]);
  const R1 = ['PLAINS', 'FOREST', 'BIRCH_FOREST', 'TAIGA'], R2 = [...R1, 'DARK_FOREST', 'SAVANNA'];
  parentPort.on('message', (job) => {
    if (!job) process.exit(0);
    const { type, seed } = job;
    const out = { type, seed, ok: false, why: [] };
    try {
      const t0 = performance.now();
      const g = makeGen({ type, seed }, { terrain, ...(type === 'kanto' ? kin : {}) });
      const plan = makePlan(g, { minRung: job.minRung || 1 });
      out.planMs = performance.now() - t0;
      const j = plan.json, s = j.spawn;
      Object.assign(out, { x: s.x, y: s.y, rung: s.rung, biome: s.biome, villages: j.villages.length, caves: j.caves.length,
        demand: plan.demand, rooms: j.rooms.length, warnings: plan.warnings, hash: plan.hash, stats: plan.stats });
      // the 3 x 3 data chunks around the spawn, painted
      const cx = Math.floor(s.x / 32), cy = Math.floor(s.y / 32), X0 = (cx - 1) * 32, Y0 = (cy - 1) * 32, W = 96;
      const p = paintRegion(g, X0, Y0, W, W, { debug: true });
      const walk = (x, y) => {
        const k = (y - Y0) * W + (x - X0);
        if (x < BORDER.x0 || y < BORDER.y0 || x > BORDER.x1 || y > BORDER.y1) return false;   // zone 3
        if (g.kanto && isKantoCell(g.kanto, x, y)) return false;
        const e = ent(p.tile[k]);
        if (e[3] !== 0 || e[4] === 'water' || e[4] === 'ice' || e[4] === 'tallgrass' || e[4] === 'ledge' || e[4] === 'tree') return false;
        return WALK_DECO.has(p.deco[k]);
      };
      const why = out.why;
      if (!walk(s.x, s.y)) why.push('spawn cell not walkable (' + ent(p.tile[(s.y - Y0) * W + s.x - X0])[4] + ')');
      const r = s.rung === 3 ? 1 : 2;
      let block = false;
      for (let oy = -2 * r; oy <= 0 && !block; oy++) for (let ox = -2 * r; ox <= 0 && !block; ox++) {
        let all = true;
        for (let yy = 0; yy <= 2 * r && all; yy++) for (let xx = 0; xx <= 2 * r; xx++) if (!walk(s.x + ox + xx, s.y + oy + yy)) { all = false; break; }
        if (all) block = true;
      }
      if (!block) why.push(`no ${2 * r + 1} x ${2 * r + 1} walkable block`);
      let trees = 0;
      for (let i = 0; i < p.dbg.slots.length; i += 2) {
        const tx = p.dbg.slots[i], ty = p.dbg.slots[i + 1];
        if (Math.max(Math.abs(tx - s.x), Math.abs(ty - s.y)) > 12) continue;
        if (ent(p.tile[(ty - Y0) * W + tx - X0])[4] === 'tree') trees++;
      }
      out.trees = trees;
      if (trees < 4) why.push(`${trees} trees within 12`);
      const pb = BIOMES[p.biome[(s.y - Y0) * W + s.x - X0]].key;
      out.pbiome = pb;
      if (pb !== s.biome) why.push(`plan says ${s.biome}, painted ${pb}`);
      if (s.rung < 4 && !(s.rung === 1 ? R1 : R2).includes(pb)) why.push('biome ' + pb);
      for (const v of j.villages) {
        const dx = s.x < v.x0 ? v.x0 - s.x : s.x >= v.x0 + v.w ? s.x - (v.x0 + v.w - 1) : 0;
        const dy = s.y < v.y0 ? v.y0 - s.y : s.y >= v.y0 + v.h ? s.y - (v.y0 + v.h - 1) : 0;
        if (Math.max(dx, dy) < 96) why.push('village ' + v.id + ' within 96');
      }
      for (const c of j.caves) if (Math.max(Math.abs(c.x - s.x), Math.abs(c.y - s.y)) < 32) why.push('cave ' + c.id + ' within 32');
      const widen = s.rung >= 3;
      if (type === 'wild') {
        const m = widen ? PLAN.spawnInside * 0.75 : PLAN.spawnInside;
        const inside = Math.min(s.x - BORDER.x0, s.y - BORDER.y0, BORDER.x1 - s.x, BORDER.y1 - s.y);
        out.inside = inside;
        if (inside < m) why.push(`only ${inside} inside the border`);
      } else {
        const d = kantoBoxDist(g.kanto, s.x, s.y);
        out.kantoDist = d;
        if (d < PLAN.kantoBand[0] * (widen ? 0.75 : 1) || d > PLAN.kantoBand[1] * (widen ? 1.25 : 1)) why.push(`${d} from Kanto`);
        // (6b) the land path to a kept opening
        const ops = (j.openings || []).filter((o) => o.kind === 'outer');
        out.openings = (j.openings || []).length; out.outer = ops.length;
        if (!ops.length) why.push('no outward opening kept');
        else {
          // the corridors (grown by their rock clearing's 4-cell jitter and 4 more): their coarse points are the goal,
          // and rock there passes (the painter clears it)
          const cm = plan.cm, n = cm.n, st = cm.st, goal = new Uint8Array(n * n);
          for (const o of ops) {
            const [cx, cy, cw, ch] = o.corr;
            for (let jj = 0; jj < n; jj++) for (let i = 0; i < n; i++) if (i * st >= cx - 8 && i * st < cx + cw + 8 && jj * st >= cy - 8 && jj * st < cy + ch + 8) goal[jj * n + i] = 1;
          }
          const pass = (q) => !cm.sea[q] && !cm.kan[q] && (!cm.rock[q] || goal[q] === 1);
          const s0 = Math.round(s.y / st) * n + Math.round(s.x / st), seen = new Uint8Array(n * n), qq = [s0];
          seen[s0] = 1;
          let hit = false;
          for (let h = 0; h < qq.length && !hit; h++) {
            const q = qq[h], i = q % n, jj = (q - i) / n;
            if (goal[q] && pass(q)) { hit = true; break; }
            for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
              const ii = i + di, j2 = jj + dj, r = j2 * n + ii;
              if (ii < 0 || j2 < 0 || ii >= n || j2 >= n || seen[r] || !pass(r)) continue;
              seen[r] = 1; qq.push(r);
            }
          }
          if (!hit) why.push('no coarse land path to a kept opening');
        }
      }
      out.ok = why.length === 0;
    } catch (e) {
      out.why.push('error ' + (e && e.stack || e));
    }
    parentPort.postMessage(out);
  });
}

if (!isMainThread) await worker();
else {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const type = opt('--type', 'wild'), N = Number(opt('--seeds', 1000)), from = Number(opt('--from', 1));
  const nw = Number(opt('--workers', 6)), minRung = Number(opt('--min-rung', 1));
  const todo = [];
  for (let s = from; s < from + N; s++) todo.push({ type, seed: s, minRung });
  const results = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    let next = 0, live = nw;
    for (let k = 0; k < nw; k++) {
      const w = new Worker(SELF);
      const feed = () => { if (next < todo.length) w.postMessage(todo[next++]); else { w.postMessage(null); if (--live === 0) resolve(); } };
      w.on('message', (r) => {
        results.push(r);
        if (!r.ok) console.log(`FAIL ${r.type} ${r.seed}: ${r.why.join('; ')}`);
        if (results.length % 100 === 0) console.log(`${results.length} / ${todo.length} (${Math.round((performance.now() - t0) / 1000)} s)`);
        feed();
      });
      w.on('error', (e) => { console.log('worker error', e); });
      feed();
    }
  });
  results.sort((a, b) => a.seed - b.seed);
  const pass = results.filter((r) => r.ok).length;
  const rungs = [0, 0, 0, 0, 0];
  for (const r of results) if (r.rung) rungs[r.rung]++;
  const q = (arr, f) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(f * (a.length - 1)))]; };
  const ms = results.map((r) => r.planMs).filter((v) => v > 0);
  const vil = results.map((r) => r.villages), cav = results.map((r) => r.caves), dem = results.map((r) => r.demand);
  const warn = results.filter((r) => r.warnings && r.warnings.length);
  const finals = results.map((r) => r.stats ? r.stats.finalTests : 0);
  console.log(`spawn ${type}: ${pass} / ${results.length} pass; rungs 1..4: ${rungs.slice(1).join(', ')} (rung 1 ${(100 * rungs[1] / results.length).toFixed(1)}%)`);
  console.log(`  plan ms (parallel, ${nw} workers): median ${q(ms, 0.5).toFixed(0)}, p90 ${q(ms, 0.9).toFixed(0)}, max ${Math.max(...ms).toFixed(0)}`);
  console.log(`  villages min ${Math.min(...vil)} median ${q(vil, 0.5)} max ${Math.max(...vil)}; caves min ${Math.min(...cav)} median ${q(cav, 0.5)} max ${Math.max(...cav)}`);
  console.log(`  room demand max ${Math.max(...dem)} cells (median ${q(dem, 0.5)}); final tests median ${q(finals, 0.5)} max ${Math.max(...finals)}; plans with warnings ${warn.length}`);
  console.log(`  trees within 12: min ${Math.min(...results.map((r) => r.trees ?? 99))}; time ${Math.round((performance.now() - t0) / 1000)} s`);
  if (type === 'kanto') {
    const op = results.map((r) => r.openings ?? 0), ou = results.map((r) => r.outer ?? 0);
    console.log(`  (6b) openings kept: min ${Math.min(...op)} median ${q(op, 0.5)} max ${Math.max(...op)}; outward min ${Math.min(...ou)} median ${q(ou, 0.5)} max ${Math.max(...ou)}`);
  }
  if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(results.map(({ stats, ...r }) => r)));
  const rung1 = rungs[1] / results.length;
  // --min-rung N (N > 1) exercises the later rungs: every seed must pass on them, the 98% target does not apply
  const ok = pass === results.length && (minRung > 1 || rung1 >= 0.98);
  console.log(ok ? 'spawn: all passed' : 'spawn: FAILED');
  process.exit(ok ? 0 : 1);
}
