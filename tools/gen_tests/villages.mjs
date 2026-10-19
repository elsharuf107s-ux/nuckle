#!/usr/bin/env node
// Village layouts and interiors (stage 7a; design 5.1, 5.2, 4.4, 4.7 item 9, 11.6's "village checks over 200 villages").
//
//   node tools/gen_tests/villages.mjs [--seeds 1..12] [--type wild] [--render DIR]
//
// For every village of every seed's plan: village.js checkVillage on the plan's layout (6 to 12 houses, the path mask
// one 4-connected component with the plaza and 2 wide everywhere, every door's front on a 2-wide path that reaches the
// plaza, job sites beside their own house, the well a 3 x 3 ring round water on the plaza, the bell rule), then the
// same checks against the painted bounds (nothing built over water, rock or trees; a walk over walkable cells from every
// door to the plaza), and the painted cells themselves: each house cell is its template's entry (on the cell's own ground: grass, sand or snow; the door keeps
// FireRed's door behaviour), each path cell an entry of the style's path recolour of quarter set C, the well's ring,
// water, farms, fences, lamps, the bell and the outdoor job sites as the layout says, every walkable cell free of
// collision. Also: the plan's templates equal terrain.json's `villages`, every house has a room of its interior's size,
// a door warp to the interior's mat and back, and the interior's beds, chest and job site are free floor.
// --render DIR writes gen_render.py dumps of the first two villages of each style (DIR/<style>_<n>/).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGen, paintRegion, makePlan } from '../../src/gen/index.js';
import { DECO, C_ROCK, C_SEA, C_FRESH, C_ICE, C_ICEP, C_SAND, C_SNOW } from '../../src/gen/chunk.js';
import { checkVillage, villageRaster, K, EXTERIORS, INTERIORS, JOB_BLOCK, INDOOR, PROFS, walkable } from '../../src/gen/village.js';
import { kantoInputs } from './kanto_inputs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const range = (s) => { const [a, b] = s.split('..').map(Number); const o = []; for (let i = a; i <= (b ?? a); i++) o.push(i); return o; };
const seeds = range(opt('--seeds', '1..12'));
const type = opt('--type', 'wild');
const renderDir = opt('--render', null);
const terrain = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'world', 'terrain.json'), 'utf8'));
const world = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'world', 'world.json'), 'utf8'));
const TV = terrain.villages;
let fails = 0, checks = 0;
const check = (ok, msg) => { checks++; if (!ok) { fails++; console.log('FAIL ' + msg); } };

// templates: the plan's constants equal the built art's sizes and doors
check(!!TV, 'terrain.json has villages (run tools/build_terrain.py)');
for (const [st, list] of Object.entries(EXTERIORS)) {
  const t = TV.exteriors[st] || [];
  check(t.length === list.length && list.every((e, i) => t[i].w === e.w && t[i].h === e.h && t[i].door[0] === e.door[0] && t[i].door[1] === e.door[1] && ['grass', 'sand', 'snow'].every((k) => t[i].cells[k].length === e.w * e.h)),
    `exterior templates of ${st} agree with village.js`);
}
check(TV.interiors.length === INTERIORS.length && INTERIORS.every((e, i) => TV.interiors[i].w === e.w && TV.interiors[i].h === e.h && TV.interiors[i].mat[0] === e.mat[0] && TV.interiors[i].mat[1] === e.mat[1]),
  'interior templates agree with village.js');
const G0 = terrain.genBase;
const row = (t) => (t >= G0 ? terrain.entries[t - G0] : world.entries[t]);
const colOf = (t) => row(t)[3], behOf = (t) => row(t)[2];
for (const it of TV.interiors) {
  const free = (x, y) => { const t = it.cells[y * it.w + x]; return colOf(t) === 0 && behOf(t) === 0; };
  const sp = it.spots, cells = [...sp.beds.flatMap(([x, y]) => [[x, y], [x, y + 1]]), sp.chest, sp.job];
  check(cells.every(([x, y]) => free(x, y)) && behOf(it.cells[it.mat[1] * it.w + it.mat[0]]) === 0x65, `interior ${it.name}: beds, chest and job site on free floor, the mat at its cell`);
}

const kin = type === 'kanto' ? kantoInputs() : {};
const BLOCKED = new Set([C_ROCK, C_SEA, C_FRESH, C_ICE, C_ICEP]);
const stats = { villages: 0, houses: {}, styles: {}, profs: {}, interiors: {}, farms: 0, pens: 0, bells: 0, lamps: 0, planMs: [] };
const rendered = {};
let planFails = 0, paintFails = 0;
for (const seed of seeds) {
  const g = makeGen({ type, seed }, { terrain, ...kin });
  const t0 = performance.now();
  const plan = makePlan(g);
  stats.planMs.push(Math.round(performance.now() - t0));
  const J = plan.json, roomOf = new Map(J.rooms.map((r) => [r.id, r]));
  const warpAt = new Map(J.warps.map((w, k) => [`${w.x},${w.y}`, { ...w, k }]));
  for (const v of J.villages) {
    stats.villages++;
    stats.houses[v.houses.length] = (stats.houses[v.houses.length] || 0) + 1;
    stats.styles[v.style] = (stats.styles[v.style] || 0) + 1;
    stats.farms += v.farms.length; stats.pens += v.pens.length; stats.lamps += v.lamps.length; if (v.bell) stats.bells++;
    const tag = `${type}:${seed} village ${v.id} (${v.style})`;
    const f0 = checkVillage(v);
    if (f0.length) { planFails++; check(false, `${tag} plan: ${f0.join('; ')}`); }
    // painted: the bounds plus 4
    const M = 4, px0 = v.x0 - M, py0 = v.y0 - M, pw = v.w + 2 * M;
    const p = paintRegion(g, px0, py0, pw, pw, { debug: true });
    const at = (x, y) => (y - py0) * pw + x - px0;
    const blocked = (x, y) => { const o = at(x, y); return BLOCKED.has(p.cls[o]) || p.dbg.tree[o] > 0; };
    const f1 = checkVillage(v, { blocked });
    const R = villageRaster(v), S = R.S;
    const set = terrain.quarter.sets.C.recolours[TV.styles[v.style].path];
    const pathOk = new Set([...set.home, ...(set.ov || [])]);
    const ext = TV.exteriors[v.style];
    const bad = [];
    for (let ly = 0; ly < S; ly++) for (let lx = 0; lx < S; lx++) {
      const k = R.kind[ly * S + lx], x = lx + v.x0, y = ly + v.y0, o = at(x, y), t = p.tile[o], d = DECO[p.deco[o]];
      if (k === K.NONE) continue;
      if ((k === K.PATH || k === K.WELL || k === K.BELL) && !pathOk.has(t)) bad.push(`path tile ${t} at ${x},${y}`);
      if (k === K.HOUSE) {
        const a = R.aux[ly * S + lx], h = v.houses[a >> 6], gk = p.cls[o] === C_SAND ? 'sand' : p.cls[o] === C_SNOW ? 'snow' : 'grass', e = ext[h.t].cells[gk][a & 63];
        if (t !== e) bad.push(`house cell ${x},${y}`);
        if (x === h.door[0] && y === h.door[1] && behOf(t) !== 105) bad.push(`door behaviour ${behOf(t)} at ${x},${y}`);
      }
      if ((k === K.WELLW || k === K.FARMW) && t !== terrain.pondTile) bad.push(`water at ${x},${y}`);
      const want = { [K.WELL]: TV.styles[v.style].well, [K.BELL]: 'bell', [K.FARM]: 'farmland', [K.FENCE]: 'oak_fence', [K.LAMP]: 'torch', [K.JOB]: JOB_BLOCK[R.aux[ly * S + lx]] }[k] || '';
      if ((d || '') !== want) bad.push(`deco ${d} (want ${want}) at ${x},${y}`);
      if (walkable(k) && colOf(t) !== 0) bad.push(`walkable cell ${x},${y} has collision`);
    }
    // the houses: rooms, warps both ways, interiors
    for (const h of v.houses) {
      const r = roomOf.get(`GEN_HOUSE_${v.id}_${h.id}`), it = INTERIORS[h.room];
      stats.interiors[h.room] = (stats.interiors[h.room] || 0) + 1;
      const pk = h.prof >= 0 ? PROFS[h.prof] : 'none';
      stats.profs[pk] = (stats.profs[pk] || 0) + 1;
      if (!r || r.w !== it.w || r.h !== it.h) { bad.push(`house ${h.id}: room`); continue; }
      const dw = warpAt.get(`${416 + h.door[0]},${h.door[1]}`), mw = warpAt.get(`${r.x + it.mat[0]},${r.y + it.mat[1]}`);
      if (!dw || !mw || dw.trig !== 'bump' || dw.dest !== r.id || dw.ax !== mw.x || dw.ay !== mw.y || mw.ax !== dw.x || mw.ay !== dw.y || J.warpBase + mw.k !== dw.to)
        bad.push(`house ${h.id}: door and mat warps`);
      if (h.prof >= 0 && INDOOR.has(PROFS[h.prof]) !== !!h.jobIn) bad.push(`house ${h.id}: indoor rule`);
    }
    if (f1.length || bad.length) { paintFails++; check(false, `${tag} painted: ${[...f1, ...bad.slice(0, 6)].join('; ')}${bad.length > 6 ? ` (+${bad.length - 6})` : ''}`); }
    if (renderDir && (rendered[v.style] || 0) < 2) {
      rendered[v.style] = (rendered[v.style] || 0) + 1;
      const dir = path.join(renderDir, `${v.style}_${rendered[v.style]}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'tile.bin'), Buffer.from(p.tile.buffer, p.tile.byteOffset, p.tile.byteLength));
      writeFileSync(path.join(dir, 'ground.bin'), Buffer.from(p.ground.buffer, p.ground.byteOffset, p.ground.byteLength));
      writeFileSync(path.join(dir, 'deco.bin'), Buffer.from(p.deco));
      writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ rect: [px0, py0, pw, pw], type, seed, village: v.id, style: v.style, houses: v.houses.length }));
    }
  }
}
check(stats.villages >= 200, `at least 200 villages checked (${stats.villages})`);
check(planFails === 0, `plan checks: ${planFails} villages fail`);
check(paintFails === 0, `painted checks: ${paintFails} villages fail`);
for (const st of Object.keys(EXTERIORS)) check((stats.styles[st] || 0) >= 2, `style ${st}: ${stats.styles[st] || 0} villages (2 or more)`);
check(PROFS.every((p) => stats.profs[p] > 0), 'every profession has a job site somewhere');
console.log(JSON.stringify(stats));
console.log(`${checks - fails} of ${checks} checks pass`);
process.exit(fails ? 1 : 0);
