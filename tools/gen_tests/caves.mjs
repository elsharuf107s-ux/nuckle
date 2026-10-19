#!/usr/bin/env node
// Caves as rooms (design 3.10; stage 5b), the Node part: the family constants against Kanto's caves, and over the
// plan's caves of several worlds: determinism, every fixed cell where the plan's warps expect it, the exit and the
// ladders reachable from each other, every wall drawn with a colliding piece of its family, ore coverage per level
// and at most two kinds per screen, lava pools only on mountain B2F floors.
//
//   node tools/gen_tests/caves.mjs [--seeds 1,2,3] [--rooms N]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digCave, CAVE_FAMILY } from '../../src/gen/cave.js';
import { makeGen, makePlan } from '../../src/gen/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const J = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const world = J('assets/world/world.json'), auto = J('assets/world/autotile.json'), terrain = J('assets/world/terrain.json');
const entries = world.entries.concat(terrain.entries);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const seeds = opt('--seeds', '1,2,3').split(',').map(Number);
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };

export function caveTables(family) {
  const F = CAVE_FAMILY[family], fam = auto.families[F.key];
  return { fam, col: (e) => entries[e] && entries[e][3], ores: terrain.ores.caves[F.key] || {} };
}

// 1. the family constants are Kanto's: floor 641, ladder 645 (beh 0x61), exit 647 (beh 0x65), exit row 712..714
for (const [name, F] of Object.entries(CAVE_FAMILY)) {
  const e = (t) => entries[t];
  const ok = e(F.floor)[0] === 641 && e(F.floor)[1] === F.pair && e(F.ladder)[0] === 645 && e(F.ladder)[2] === 0x61
    && e(F.exit)[0] === 647 && e(F.exit)[2] === 0x65 && F.exitRow.every((t, k) => e(t)[0] === 712 + k && e(t)[3] === 1 && e(t)[1] === F.pair)
    && auto.families[F.key].pair === F.pair;
  check(ok, `${name}: ${F.key} floor ${F.floor}, ladder ${F.ladder}, exit ${F.exit} and its row are world.json's`);
}

const tally = { 1: { faces: 0, ore: 0, rooms: 0 }, 2: { faces: 0, ore: 0, rooms: 0 } };
let b2n = 0, b2bad = 0;
let rooms = 0, undrawn = 0, unreach = 0, screens = 0, dets = 0, lavaBad = 0, ms = 0, kinds = {};
for (const seed of seeds) {
  const g = makeGen({ type: 'wild', seed }, { terrain, cache: true });
  const plan = makePlan(g).json;
  const roomOf = new Map(plan.rooms.map((r) => [r.id, r]));
  for (const c of plan.caves) {
    for (const fl of c.b2 ? [1, 2] : [1]) {
      const r = roomOf.get(`GEN_CAVE_${c.id}_B${fl}F`);
      const spec = { w: r.w, h: r.h, floor: fl, seed: c.seed, family: c.family, b2: c.b2 };
      const T = caveTables(c.family);
      const t0 = performance.now();
      const a = digCave(spec, T);
      ms += performance.now() - t0;
      const b = digCave(spec, T);
      if (Buffer.compare(Buffer.from(a.tile.buffer), Buffer.from(b.tile.buffer)) !== 0) dets++;
      rooms++;
      undrawn += a.stats.undrawn;
      tally[fl].faces += a.stats.faces; tally[fl].rooms++;
      for (const [k, n] of Object.entries(a.stats.ores)) { tally[fl].ore += n; kinds[k] = (kinds[k] || 0) + n; }
      if (fl === 2) { b2n++; if (!(a.stats.ores.diamond_ore >= 2) || !a.pair.includes('diamond_ore')) b2bad++; }   // (playfix: diamond on every B2F)
      // the plan's warp cells (room-local)
      const F = CAVE_FAMILY[c.family], W = r.w, cx = W >> 1;
      const at = (x, y) => a.tile[y * W + x];
      const fixedOk = fl === 1 ? at(cx, r.h - 3) === F.exit && (!c.b2 || at(cx, 2) === F.ladder) : at(cx, r.h - 3) === F.ladder;
      if (!fixedOk) { unreach++; console.log('  fixed cells wrong in', r.id); }
      // reachability from the first anchor over non-colliding cells (lava is solid)
      const solid = new Uint8Array(W * r.h);
      for (let i = 0; i < solid.length; i++) solid[i] = entries[a.tile[i]][3] ? 1 : 0;
      for (const [x, y] of a.lava) solid[y * W + x] = 1;
      const start = fl === 1 ? (r.h - 3) * W + cx : (r.h - 3) * W + cx, seen = new Uint8Array(W * r.h), q = [start];
      seen[start] = 1;
      while (q.length) { const i = q.pop(), x = i % W, y = (i - x) / W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= r.h) continue; const j = Y * W + X; if (!seen[j] && !solid[j]) { seen[j] = 1; q.push(j); } } }
      let open = 0, reached = 0;
      for (let i = 0; i < solid.length; i++) if (!solid[i]) { open++; if (seen[i]) reached++; }
      if (fl === 1 && c.b2 && !seen[2 * W + cx]) { unreach++; console.log('  ladder unreachable in', r.id); }
      if (reached < open) { unreach++; console.log(`  ${open - reached} open cells unreachable in ${r.id}`); }
      // at most two ore kinds in any 15 x 10 window
      const kindAt = (i) => { const e = entries[a.tile[i]]; return e[4].endsWith('_ore') ? e[4] : null; };
      for (let y = 0; y + 10 <= r.h; y += 2) for (let x = 0; x + 15 <= W; x += 2) {
        const s = new Set();
        for (let yy = y; yy < y + 10; yy++) for (let xx = x; xx < x + 15; xx++) { const k = kindAt(yy * W + xx); if (k) s.add(k); }
        if (s.size > 2) screens++;
      }
      // lava: mountain B2F only, on the family's floor
      if (a.lava.length && !(fl === 2 && c.family === 'mountain')) lavaBad++;
      for (const [x, y] of a.lava) if (at(x, y) !== F.floor) lavaBad++;
      if (fl === 2 && c.family === 'mountain' && !a.lava.length) console.log('  no lava pool in', r.id);
    }
  }
}
const cov = (fl) => (100 * tally[fl].ore / Math.max(1, tally[fl].faces)).toFixed(2);
console.log(`rooms ${rooms}, dig ${(ms / rooms).toFixed(2)} ms a room; ore kinds ${JSON.stringify(kinds)}`);
check(dets === 0, 'two digs of every room are identical');
check(undrawn === 0, `every wall cell has a colliding piece of its family (${undrawn} not)`);
check(unreach === 0, 'the exit and ladders sit on the plan\'s cells and every open cell is reachable from the way in');
check(screens === 0, `no 15 x 10 window shows more than two ore kinds (${screens})`);
check(lavaBad === 0, 'lava only in mountain B2F, on floor');
check(+cov(1) >= 4.5 && +cov(1) <= 7.5, `B1F ore coverage ${cov(1)}% of interior faces (design about 6)`);
check(+cov(2) >= 3 && +cov(2) <= 5.5, `B2F ore coverage ${cov(2)}% of interior faces (design about 4)`);
check(b2n > 0 && b2bad === 0, `every B2F has diamond as one of its kinds and at least 2 diamond ores (${b2n - b2bad} of ${b2n})`);
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
