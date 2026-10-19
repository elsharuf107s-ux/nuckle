#!/usr/bin/env node
// The Kanto signpost's Node test (minimap design, Track SIGN, 5.1): for N Kanto World seeds the plan is computed and the
// spawn sign (src/gen/sign.js kantoSigns) is checked on the painter's own output for the 3 x 3 data chunks around the
// spawn (one 96 x 96 region, which the seam test makes byte-identical to the chunks), with the game's own entry data
// (world.json's General entries, terrain.json's generated ones):
//   * a spawn sign exists, within 2 cells (Chebyshev) of the spawn and not on it;
//   * its cell is walkable plain ground (collision 0, generated land, not Kanto, not water, ice, tall grass, a ledge or
//     a tree), with no decoration, its tile its own ground; the cell above has no top piece a broken sign would take
//     (world.breakTile's rule); the cell below has no decoration;
//   * with the sign standing, every cell of the 24 x 24 window reachable from the spawn before stays reachable;
//   * the target is a kept outward opening, the cheapest by the weighted coarse walk whose mouth opens onto dry land,
//     every cheaper one's mouth closed (an independent heap search and breadth-first mouth walk), or kind 'edge' with
//     the plan's warning;
//   * dir is the sector of the bearing (Math.atan2(-dy, dx), north up, within 22.5 degrees), sector8 itself on known
//     bearings; steps lies between the grid distance's and the coarse cost's walk, each plus a quarter, in tens;
//   * the texts fit two lines of FireRed's box at most 170 pixels wide (assets/ui/font.json widths; on a landscape
//     phone the INV button covers a line from about 176 pixels on);
//   * the gate sign (when there is one) is not a Kanto cell, lies outside its corridor but within 5 cells of it, 2 to 4
//     cells outward from the out cell, and points inward;
//   * a second run in another process gives byte-equal JSON; kantoSigns gives null for 20 Wild World seeds.
// Prints the histograms of offsets, directions and steps.
//
//   node tools/gen_tests/kanto_sign.mjs [--seeds 40] [--from 1] [--workers 6] [--json out.json]
//   (--child a,b,c: one process's JSON for those seeds, the determinism check's second run)
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const rd = (f) => readFileSync(path.join(ROOT, 'assets', f));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

async function setup() {
  const GI = await import('../../src/gen/index.js');
  const SG = await import('../../src/gen/sign.js');
  const { kantoInputs } = await import('./kanto_inputs.mjs');
  const raw = JSON.parse(rd('world/terrain.json'));
  return { GI, SG, raw, terrain: GI.prepTerrain(raw), kin: kantoInputs() };
}
const signsOf = (S, type, seed) => {
  const g = S.GI.makeGen({ type, seed }, { terrain: S.terrain, cache: true, ...(type === 'kanto' ? S.kin : {}) });   // (the worker's caches: the same cells, paint_seams.mjs)
  const plan = S.GI.makePlan(g);
  return { g, plan, r: S.SG.kantoSigns(g, plan) };
};

// FireRed's text width (src/font.js textWidth) from font.json
function fontWidth() {
  const F = JSON.parse(rd('ui/font.json'));
  const id = (ch) => (ch in F.map ? F.map[ch] : F.map['?']);
  return (text) => { let w = 0; for (const ch of text) w += F.widths[id(ch)] || 6; return w; };
}
const WORDS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

// --real n (a diagnostic, slow: a minute or more a seed): the shortest walk on dry land from the spawn sign to every
// outward opening's out cell over the painted chunks, by the game's movement rules (collision, water, ledges jumped
// one way, the decorations Steve walks through; Kanto's cells blocked), an A* search per opening (the grid distance as
// its heuristic, given up after 500,000 cells: then not reached)
function realCosts(g, ent, isKantoCell, BORDER, s, outer, GI, D) {
  const chunks = new Map(), sx = s.x - 416, sy = s.y;
  const WATER = new Set([0x10, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x19, 0x1A, 0x1B]), JUMP = { 0x3A: 0, 0x38: 1, 0x3B: 2, 0x39: 3 };
  const WALKD = new Set([0, D.DANDELION, D.POPPY, D.SUGAR_CANE, D.DEAD_BUSH, D.LILY_PAD, D.TORCH, D.FARMLAND]);
  const STEP = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  // 0 blocked, 1 dry land, 4 + d a ledge jumped toward d
  const kind = (x, y) => {
    if (x < BORDER.x0 || y < BORDER.y0 || x > BORDER.x1 || y > BORDER.y1 || isKantoCell(g.kanto, x, y)) return 0;
    const k = Math.floor(y / 32) * 64 + Math.floor(x / 32);
    if (!chunks.has(k)) chunks.set(k, GI.paintChunk(g, Math.floor(x / 32), Math.floor(y / 32)));
    const c = chunks.get(k), i = (y % 32) * 32 + (x % 32), e = ent(c.tile[i]);
    if (!WALKD.has(c.deco[i])) return 0;
    if (e[2] in JUMP) return 4 + JUMP[e[2]];
    return e[3] !== 0 || WATER.has(e[2]) ? 0 : 1;
  };
  const found = {};
  for (const o of outer) {
    const [tx, ty] = o.out, h = (x, y) => Math.abs(x - tx) + Math.abs(y - ty);
    const gs = new Map([[sy * 2048 + sx, 0]]), heap = [[h(sx, sy), 0, sx, sy]];
    const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] > b[1]);
    const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const down = () => { let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < heap.length && less(heap[a], heap[m])) m = a; if (b < heap.length && less(heap[b], heap[m])) m = b; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
    let n = 0;
    while (heap.length && n < 500000) {
      const [, d, x, y] = heap[0], last = heap.pop();
      if (heap.length) { heap[0] = last; down(); }
      if (gs.get(y * 2048 + x) < d) continue;
      n++;
      if (x === tx && y === ty) { found[o.id] = d; break; }
      for (let k = 0; k < 4; k++) {
        let nx = x + STEP[k][0], ny = y + STEP[k][1], c = 1, w = nx === tx && ny === ty ? 1 : kind(nx, ny);
        if (w >= 4) { if (w - 4 !== k) continue; nx += STEP[k][0]; ny += STEP[k][1]; c = 2; w = nx === tx && ny === ty ? 1 : kind(nx, ny); }
        if (w !== 1) continue;
        const nk = ny * 2048 + nx;
        if (gs.has(nk) && gs.get(nk) <= d + c) continue;
        gs.set(nk, d + c); heap.push([d + c + h(nx, ny), d + c, nx, ny]); up(heap.length - 1);
      }
    }
  }
  return found;
}

async function worker() {
  const S = await setup();
  const { GI, SG, raw } = S;
  const { BORDER } = await import('../../src/gen/plan.js');
  const { D } = await import('../../src/gen/chunk.js');
  const BI = await import('../../src/gen/biomes.js');
  const { isKantoCell } = await import('../../src/gen/kanto.js');
  const { fbm } = await import('../../src/gen/noise.js');
  const world = JSON.parse(rd('world/world.json'));
  const GB = raw.genBase, OX = 416;
  const ent = (t) => (t < GB ? world.entries[t] : raw.entries[t - GB]);
  const tw = fontWidth();
  const kmaps = world.maps.filter((m) => m.kind === 'outdoor' && !m.room && Number.isInteger(m.y) && m.y < 400);
  parentPort.on('message', (job) => {
    if (!job) process.exit(0);
    const { type, seed } = job, why = [], out = { type, seed, why };
    try {
      const { g, plan, r } = signsOf(S, type, seed);
      if (type === 'wild') { if (r !== null) why.push('a Wild World got signs'); parentPort.postMessage(out); return; }
      out.json = JSON.stringify(r);
      const j = plan.json, sp = j.spawn;
      const spawnSign = r && r.signs.find((s) => s.kind === 'spawn');
      if (!spawnSign) { why.push('no spawn sign: ' + (r ? r.warn.join('; ') : 'null')); parentPort.postMessage(out); return; }
      const sx = spawnSign.x - OX, sy = spawnSign.y, odx = sx - sp.x, ody = sy - sp.y;
      out.off = [odx, ody]; out.dir = spawnSign.dir; out.steps = spawnSign.steps; out.target = r.target;
      if (Math.max(Math.abs(odx), Math.abs(ody)) > 2 || (odx === 0 && ody === 0)) why.push(`sign at offset ${odx},${ody}`);
      // the 3 x 3 chunks around the spawn as the painter makes them
      const cx = Math.floor(sp.x / 32), cy = Math.floor(sp.y / 32), X0 = (cx - 1) * 32, Y0 = (cy - 1) * 32, W = 96;
      const p = GI.paintRegion(g, X0, Y0, W, W);
      const at = (x, y) => (y - Y0) * W + (x - X0);
      const walk = (x, y) => {
        if (x < BORDER.x0 || y < BORDER.y0 || x > BORDER.x1 || y > BORDER.y1 || isKantoCell(g.kanto, x, y)) return false;
        const e = ent(p.tile[at(x, y)]), d = p.deco[at(x, y)];
        if (e[3] !== 0 || ['water', 'ice', 'tallgrass', 'ledge', 'tree'].includes(e[4])) return false;
        return d === 0 || d === D.DANDELION || d === D.POPPY;
      };
      const k = at(sx, sy), e = ent(p.tile[k]);
      if (!walk(sx, sy)) why.push('sign cell not walkable (' + e[4] + ')');
      if (p.deco[k]) why.push('sign cell has a decoration');
      if (e[2] === 0x02 || (e[2] >= 0x38 && e[2] <= 0x3b)) why.push('sign cell is tall grass or a ledge');
      if (p.tile[k] !== p.ground[k]) why.push('sign cell is not plain ground');
      const up = ent(p.tile[at(sx, sy - 1)]), upCol = up[3];
      if (up[6] && !upCol && up[4] !== 'tree' && up[4] !== 'water') why.push('the cell above has a top piece a broken sign would take');
      if (p.deco[at(sx, sy + 1)]) why.push('the cell below has a decoration');
      // the debug paint the worker used for the window equals the chunks' cells
      const dp = GI.paintRegion(g, sp.x - 12, sp.y - 12, 24, 24, { debug: true });
      for (let yy = 0; yy < 24; yy++) for (let xx = 0; xx < 24; xx++) {
        const a = dp.tile[yy * 24 + xx], b = p.tile[at(sp.x - 12 + xx, sp.y - 12 + yy)];
        if (a !== b) { why.push(`window paint differs from the chunks at ${xx},${yy}`); yy = 24; break; }
      }
      // no path cut: the 24 x 24 window from the spawn, with and without the sign
      const reachSet = (block) => {
        const seen = new Set(), q = [[sp.x, sp.y]];
        seen.add(sp.x + ',' + sp.y);
        while (q.length) {
          const [x, y] = q.pop();
          for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
            const nx = x + dx, ny = y + dy, key = nx + ',' + ny;
            if (nx < sp.x - 12 || ny < sp.y - 12 || nx >= sp.x + 12 || ny >= sp.y + 12 || seen.has(key) || !walk(nx, ny)) continue;
            if (block && nx === block[0] && ny === block[1]) continue;
            seen.add(key); q.push([nx, ny]);
          }
        }
        return seen;
      };
      const before = reachSet(null), after = reachSet([sx, sy]);
      let lost = 0;
      for (const c of before) if (c !== sx + ',' + sy && !after.has(c)) lost++;
      if (lost) why.push(`the sign cuts off ${lost} cells of the spawn's window`);
      // the target: a kept outward opening, the cheapest by coarse walk (an independent search, its own heap: straight
      // steps 1, diagonal 2, times the entered point's weight: 4 on open land, a forest 6, a birch forest 5, a dark
      // forest or jungle 8, a taiga or snowy taiga 6, a swamp 6, all 4 times by fresh water; sea and Kanto block; rock
      // blocks outside the corridors grown by 8 and off the painter's mountain passes) whose mouth opens onto the
      // wider dry land (an independent breadth-first walk on painted chunks); every cheaper opening's mouth is a closed
      // pocket. Or Kanto's edge with the plan's warning.
      const cm = plan.cm, n = cm.n, st = cm.st, outer = (j.openings || []).filter((o) => o.kind === 'outer');
      const T = r.target;
      if (!T) why.push('no target');
      else {
        const o = T.kind === 'opening' ? outer.find((q) => q.id === T.id) : null;
        if (T.kind === 'opening' && !o) why.push('target ' + T.id + ' is not a kept outward opening');
        else if (o && (o.out[0] + OX !== T.x || o.out[1] !== T.y)) why.push('target is not the opening\'s out cell');
        const inC = new Uint8Array(n * n), goal = outer.map(() => new Uint8Array(n * n));
        outer.forEach((q, oi) => {
          const [x0, y0, w0, h0] = q.corr;
          for (let jj = 0; jj < n; jj++) for (let i = 0; i < n; i++) if (i * st >= x0 - 8 && i * st < x0 + w0 + 8 && jj * st >= y0 - 8 && jj * st < y0 + h0 + 8) { inC[jj * n + i] = 1; goal[oi][jj * n + i] = 1; }
        });
        const PL = g.paint.L, pf = (x, y) => fbm(PL.pass, x, y);
        const onPass = (q) => {
          const x = (q % n) * st, y = Math.floor(q / n) * st, v = pf(x, y);
          const gm = Math.hypot((pf(x + 4, y) - pf(x - 4, y)) / 8, (pf(x, y + 4) - pf(x, y - 4)) / 8) + 1e-9;
          return Math.abs(v) / gm < 3 + 2 * Math.min(1, Math.max(0, fbm(PL.passw, x, y) + 0.5)) + SG.PASS_WIDEN;
        };
        const pass = (q) => !cm.sea[q] && !cm.kan[q] && (!cm.rock[q] || inC[q] === 1 || onPass(q));
        const BW = { [BI.B.FOREST]: 6, [BI.B.BIRCH_FOREST]: 5, [BI.B.DARK_FOREST]: 8, [BI.B.JUNGLE]: 8, [BI.B.TAIGA]: 6, [BI.B.SNOWY_TAIGA]: 6, [BI.B.SWAMP]: 6 };
        const ci = Math.min(n - 1, Math.floor((sx + 4) / st)), cj = Math.min(n - 1, Math.floor((sy + 4) / st));
        const dist = new Map([[cj * n + ci, 0]]), heap = [[0, cj * n + ci]];
        const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
        const down = () => { let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
        while (heap.length) {
          const [d, q] = heap[0], last = heap.pop();
          if (heap.length) { heap[0] = last; down(); }
          if (dist.get(q) < d) continue;
          const i = q % n, jj = (q - i) / n;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const ii = i + di, j2 = jj + dj, rr = j2 * n + ii, nd = d + (di && dj ? 2 : 1) * (BW[cm.bio[rr]] || 4) * (cm.wet[rr] ? 4 : 1);
            if ((!di && !dj) || ii < 0 || j2 < 0 || ii >= n || j2 >= n || !pass(rr) || (dist.has(rr) && dist.get(rr) <= nd)) continue;
            dist.set(rr, nd); heap.push([nd, rr]); up(heap.length - 1);
          }
        }
        const costOf = (oi) => {
          const oo = outer[oi], oi2 = Math.min(n - 1, Math.floor((oo.out[0] + 4) / st)), oj2 = Math.min(n - 1, Math.floor((oo.out[1] + 4) / st));
          let b = -1;
          for (let q = 0; q < n * n; q++) if (goal[oi][q] && dist.has(q)) { const c = dist.get(q) + 4 * (Math.abs((q % n) - oi2) + Math.abs(Math.floor(q / n) - oj2)); if (b < 0 || c < b) b = c; }
          return b;
        };
        // the mouth (fixed after review): a breadth-first walk backward from the out cell over the painted chunks, by the
        // game's movement rules read here from the entries themselves (collision; world.js's water behaviours; a ledge
        // crossed only the way Steve jumps it, toward the opening; the decorations he walks through: world.js DECO_WALK
        // and farmland), dry land only (or across water too, `swim`, ending on dry land), no Kanto cell, gets 128 cells
        // farther from Kanto's box than the corridor is long, or finds more than 30,000 cells; else the mouth is closed
        // (the same verdict as the worker's best-first walk: both explore a closed region whole and stop in an open one)
        const WATER = new Set([0x10, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x19, 0x1A, 0x1B]), JUMP = { 0x3A: 0, 0x38: 1, 0x3B: 2, 0x39: 3 };
        const WALKD = new Set([0, D.DANDELION, D.POPPY, D.SUGAR_CANE, D.DEAD_BUSH, D.LILY_PAD, D.TORCH, D.FARMLAND]);
        const chunks = new Map();
        // 0 blocked, 1 dry land, 2 water, 4 + d a ledge jumped toward d (0 N, 1 E, 2 S, 3 W)
        const kindAt = (x, y) => {
          if (x < BORDER.x0 || y < BORDER.y0 || x > BORDER.x1 || y > BORDER.y1 || isKantoCell(g.kanto, x, y)) return 0;
          const ck = Math.floor(y / 32) * 64 + Math.floor(x / 32);
          if (!chunks.has(ck)) chunks.set(ck, GI.paintChunk(g, Math.floor(x / 32), Math.floor(y / 32)));
          const c = chunks.get(ck), i = (y % 32) * 32 + (x % 32), e = ent(c.tile[i]);
          if (!WALKD.has(c.deco[i])) return 0;
          if (e[2] in JUMP) return 4 + JUMP[e[2]];
          if (e[3] !== 0) return 0;
          return WATER.has(e[2]) ? 2 : 1;
        };
        const K = g.kanto, boxDist = (x, y) => Math.max(x < K.x ? K.x - x : x >= K.x + K.w ? x - (K.x + K.w - 1) : 0, y < K.y ? K.y - y : y >= K.y + K.h ? y - (K.y + K.h - 1) : 0);
        const STEP = [[0, -1], [1, 0], [0, 1], [-1, 0]];
        const mouthOpen = (oo, swim) => {
          const far = (oo.n[0] === 0 ? oo.corr[3] : oo.corr[2]) + SG.MOUTH_BEYOND, seen = new Set([oo.out[0] + ',' + oo.out[1]]), q = [oo.out];
          for (let h = 0; h < q.length; h++) {
            const [x, y] = q[h];
            for (let d = 0; d < 4; d++) {
              let xx = x + STEP[d][0], yy = y + STEP[d][1], w = kindAt(xx, yy);
              if (w >= 4) { if (w - 4 !== (d + 2) % 4) continue; xx += STEP[d][0]; yy += STEP[d][1]; w = kindAt(xx, yy); }
              if (w !== 1 && !(swim && w === 2)) continue;
              const key = xx + ',' + yy;
              if (seen.has(key)) continue;
              seen.add(key);
              if (w === 1 && boxDist(xx, yy) >= far) return true;
              q.push([xx, yy]);
            }
            if (seen.size > SG.MOUTH_CAP) return true;
          }
          return false;
        };
        const costs = outer.map((_, oi) => costOf(oi));
        // no mouth opens on foot: the sign's opening opens across water (a warning); none at all: Kanto's edge (a warning)
        const swum = r.warn.includes('no way into Kanto opens on foot; the sign points to one across water');
        const shut = r.warn.includes('every way into Kanto the sign could point to ends in a closed pocket');
        out.swum = swum; out.closed = [];
        if (o) {
          const mine = costs[outer.indexOf(o)];
          out.coarseSteps = mine;
          if (mine < 0) why.push('the coarse land search does not reach the target');
          if (!mouthOpen(o, swum)) why.push(`the target's mouth is a closed pocket${swum ? ' even across water' : ''}`);
          if (swum) outer.forEach((oo, oi) => { if (costs[oi] >= 0 && mouthOpen(oo, false)) why.push(`opening ${oo.id}'s mouth opens on foot, yet the sign says none does`); });
          outer.forEach((oo, oi) => {
            if (costs[oi] < 0 || oo === o || !(costs[oi] < mine || (costs[oi] === mine && oo.id < o.id))) return;
            if (mouthOpen(oo, swum)) why.push(`opening ${oo.id} is cheaper (${costs[oi]} < ${mine}) and its mouth is open`);
            else out.closed.push(oo.id);
          });
        } else if (shut) {
          outer.forEach((oo, oi) => { if (costs[oi] >= 0 && mouthOpen(oo, true)) why.push(`an edge target, yet opening ${oo.id}'s mouth is open`); });
        } else if (!plan.warnings.includes('no opening out of Kanto was kept')) why.push('an edge target without a warning');
        if (job.real) out.real = realCosts(g, ent, isKantoCell, BORDER, spawnSign, outer, GI, D);
      }
      // the arrow and the distance
      if (T) {
        const dx = T.x - spawnSign.x, dy = T.y - spawnSign.y;
        const deg = Math.atan2(-dy, dx) * 180 / Math.PI;                 // east 0, north 90
        const want = ((Math.round((90 - deg) / 45) % 8) + 8) % 8;     // N 0, NE 1, E 2 ...
        if (want !== spawnSign.dir) why.push(`dir ${spawnSign.dir}, bearing says ${want}`);
        // steps: the coarse walk's length plus a quarter, at least the grid distance's: between the grid distance's and
        // the coarse cost's (a walk of k points costs at least 4k), each plus a quarter, rounded to tens
        const grid = Math.abs(dx) + Math.abs(dy), r10 = (v) => Math.max(10, Math.round(v / 10) * 10);
        const hi = T.kind === 'opening' && out.coarseSteps > 0 ? Math.max(grid, out.coarseSteps * 2) : grid;
        if (spawnSign.steps < r10(grid * 1.25) || spawnSign.steps > r10(hi * 1.25)) why.push(`steps ${spawnSign.steps} for a grid distance of ${grid} and a coarse cost of ${out.coarseSteps}`);
      }
      // the texts fit FireRed's box: two lines of at most 170 pixels (clear of the phone's INV button)
      const texts = [`KANTO is this way!\nAbout ${spawnSign.steps} steps ${WORDS[spawnSign.dir]}.`];
      const gate = r.signs.find((s) => s.kind === 'gate');
      if (gate) {
        const o = outer.find((q) => q.id === gate.id);
        const lx = o.in[0] - g.kanto.x, ly = o.in[1] - g.kanto.y;
        const m = kmaps.find((mm) => lx >= mm.x && ly >= mm.y && lx < mm.x + mm.w && ly < mm.y + mm.h);
        out.gate = { off: [gate.x - OX - o.out[0], gate.y - o.out[1]], dir: gate.dir, map: m ? m.name : null };
        texts.push(m ? `KANTO starts here.\nThis way to ${m.name}.` : 'KANTO starts here.\nWelcome to KANTO!');
        const gx = gate.x - OX, gy = gate.y;
        if (isKantoCell(g.kanto, gx, gy)) why.push('the gate sign is on a Kanto cell');
        const [x0, y0, w0, h0] = o.corr;
        if (gx >= x0 && gx < x0 + w0 && gy >= y0 && gy < y0 + h0) why.push('the gate sign is inside the corridor');
        if (gx < x0 - 5 || gx >= x0 + w0 + 5 || gy < y0 - 5 || gy >= y0 + h0 + 5) why.push('the gate sign is not beside the corridor');
        const along = o.n[0] === 0 ? (gy - o.out[1]) * o.n[1] : (gx - o.out[0]) * o.n[0];
        if (along < 2 || along > 4) why.push(`the gate sign is ${along} cells outward from the out cell`);
        if (gate.dir !== SG.sector8(-o.n[0], -o.n[1]) || gate.dir % 2) why.push('the gate sign does not point inward');
        const gp = GI.paintRegion(g, gx - 1, gy - 1, 3, 3);
        const ge = ent(gp.tile[4]);
        if (ge[3] !== 0 || gp.deco[4] || gp.tile[4] !== gp.ground[4] || ['water', 'ice', 'tallgrass', 'ledge', 'tree'].includes(ge[4])) why.push('the gate sign\'s cell is not walkable plain ground');
        if (gp.deco[7]) why.push('the cell below the gate sign has a decoration');
      }
      for (const t of texts) {
        const lines = t.split('\n');
        if (lines.length !== 2) why.push('text is not two lines: ' + t);
        for (const l of lines) if (tw(l) > 170) why.push(`"${l}" is ${tw(l)} px wide`);
      }
      out.width = Math.max(...texts.flatMap((t) => t.split('\n').map(tw)));
    } catch (e) { why.push('error ' + (e && e.stack || e)); }
    parentPort.postMessage(out);
  });
}

async function child(list) {
  const S = await setup();
  const res = {};
  for (const s of list) res[s] = JSON.stringify(signsOf(S, 'kanto', s).r);
  process.stdout.write(JSON.stringify(res));
}

if (!isMainThread) await worker();
else if (opt('--child')) await child(opt('--child').split(',').map(Number));
else {
  const N = Number(opt('--seeds', 40)), from = Number(opt('--from', 1)), nw = Number(opt('--workers', 6));
  let fails = 0;
  const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
  // sector8 on known bearings (north is dy < 0)
  const { sector8, roundSteps } = await import('../../src/gen/sign.js');
  const known = [[0, -5, 0], [5, -5, 1], [5, 0, 2], [5, 5, 3], [0, 5, 4], [-5, 5, 5], [-5, 0, 6], [-5, -5, 7], [12, -4, 2], [12, -5, 1], [4, -12, 0], [5, -12, 1]];
  check(known.every(([dx, dy, d]) => sector8(dx, dy) === d), 'sector8 on 12 known bearings (due north 0, due east 2)');
  let agree = true;
  for (let dy = -60; dy <= 60 && agree; dy++) for (let dx = -60; dx <= 60; dx++) {
    if (!dx && !dy) continue;
    const deg = Math.atan2(-dy, dx) * 180 / Math.PI, want = ((Math.round((90 - deg) / 45) % 8) + 8) % 8;
    if (sector8(dx, dy) !== want) { agree = false; console.log('  sector8', dx, dy, '=', sector8(dx, dy), 'atan2 says', want); break; }
  }
  check(agree, 'sector8 equals the atan2 sector on every bearing in -60..60 squared');
  check(roundSteps(4) === 10 && roundSteps(344) === 340 && roundSteps(345) === 350 && roundSteps(1994) === 1990, 'steps rounded to tens, at least 10');
  const todo = [];
  const nReal = Number(opt('--real', 0));
  for (let s = from; s < from + N; s++) todo.push({ type: 'kanto', seed: s, real: s < from + nReal });
  for (let s = 1; s <= 20; s++) todo.push({ type: 'wild', seed: s });
  const results = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    let next = 0, live = nw;
    for (let k = 0; k < nw; k++) {
      const w = new Worker(SELF);
      const feed = () => { if (next < todo.length) w.postMessage(todo[next++]); else { w.postMessage(null); if (--live === 0) resolve(); } };
      w.on('message', (r) => {
        results.push(r);
        if (r.why.length) console.log(`FAIL ${r.type} ${r.seed}: ${r.why.join('; ')}`);
        if (results.length % 100 === 0) console.log(`${results.length} / ${todo.length} (${Math.round((performance.now() - t0) / 1000)} s)`);
        feed();
      });
      w.on('error', (e) => { console.log('worker error', e); fails++; });
      feed();
    }
  });
  results.sort((a, b) => (a.type === b.type ? a.seed - b.seed : a.type < b.type ? -1 : 1));
  const K = results.filter((r) => r.type === 'kanto'), Wd = results.filter((r) => r.type === 'wild');
  check(K.every((r) => !r.why.length), `${K.filter((r) => !r.why.length).length} / ${K.length} Kanto seeds pass every sign check`);
  check(Wd.every((r) => !r.why.length), `kantoSigns is null for ${Wd.filter((r) => !r.why.length).length} / ${Wd.length} Wild World seeds`);
  // the second run, in another process
  const some = K.slice(0, Math.min(12, K.length)).map((r) => r.seed);
  const again = JSON.parse(execFileSync(process.execPath, [SELF, '--child', some.join(',')], { maxBuffer: 1 << 26 }).toString());
  check(some.every((s) => again[s] === K.find((r) => r.seed === s).json), `a second run in another process gives byte-equal JSON (${some.length} seeds)`);
  const hist = (f) => { const m = new Map(); for (const r of K) { const v = f(r); if (v !== undefined) m.set(v, (m.get(v) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '); };
  const DN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  console.log('  offsets:', hist((r) => r.off && r.off.join(',')));
  console.log('  arrows:', hist((r) => (r.dir !== undefined ? DN[r.dir] : undefined)));
  const steps = K.map((r) => r.steps).filter((v) => v > 0).sort((a, b) => a - b);
  if (steps.length) console.log(`  steps: min ${steps[0]}, median ${steps[steps.length >> 1]}, max ${steps[steps.length - 1]}; widest line ${Math.max(...K.map((r) => r.width || 0))} px`);
  console.log('  targets:', hist((r) => (r.target ? r.target.kind + ' ' + r.target.id : 'none')));
  console.log(`  gate signs: ${K.filter((r) => r.gate).length} / ${K.length}; their places:`, hist((r) => (r.gate ? r.gate.map || '(no name)' : undefined)));
  const R = K.filter((r) => r.real);
  if (R.length) {
    const best = (r) => Object.entries(r.real).sort((a, b) => a[1] - b[1])[0];
    const same = R.filter((r) => best(r) && Number(best(r)[0]) === r.target.id).length;
    const reach = R.filter((r) => r.target && r.real[r.target.id] !== undefined).length;
    const ratio = R.filter((r) => best(r) && r.real[r.target.id] !== undefined).map((r) => r.real[r.target.id] / best(r)[1]).sort((a, b) => a - b);
    console.log(`  real walks (${R.length} seeds): the sign's opening is the nearest on foot for ${same}, reached on dry land for ${reach}; its walk over the nearest's: median ${ratio.length ? ratio[ratio.length >> 1].toFixed(2) : '-'}, max ${ratio.length ? ratio[ratio.length - 1].toFixed(2) : '-'}`);
    for (const r of R) console.log(`    seed ${r.seed}: sign ${r.target.id}, real ${JSON.stringify(r.real)}`);
  }
  console.log('  closed mouths passed over:', hist((r) => (r.closed && r.closed.length ? r.closed.join('+') : undefined)) || 'none');
  if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(K.map(({ json, ...r }) => r)));
  console.log(`time ${Math.round((performance.now() - t0) / 1000)} s`);
  console.log(fails ? `kanto_sign: ${fails} FAILED` : 'kanto_sign: all passed');
  process.exit(fails ? 1 : 0);
}
