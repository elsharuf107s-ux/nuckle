// Shared by tools/gen_tests/plan_hash.mjs in Node and in the headless browser page (it imports only src/gen, so the
// same file runs in both): the world plans of the determinism seeds, their hashes, and how long each took.
import { makeGen, makePlan } from '../../src/gen/index.js';
import { GEN_VERSION } from '../../src/gen/version.js';

export const SEEDS = [1, 2, 123456, -7, 'hello'];
export const TYPES = ['wild', 'kanto'];

// one plan: makeGen (the coarse grid and the thresholds, plan step 2) and makePlan; `terrain` is prepTerrain's
// kin: a Kanto World's inputs (kanto_inputs.mjs, stage 6a); the fifth argument is unused (it was the grid)
export function onePlan(type, seed, terrain, kin, _unused, clock) {
  const t0 = clock();
  const g = makeGen({ type, seed }, { terrain, ...(type === 'kanto' ? kin : {}) });
  const t1 = clock();
  const p = makePlan(g, { clock });
  const ms = clock() - t0;
  const parts = { gen: Math.round(t1 - t0), ...Object.fromEntries(Object.entries(p.ms).map(([k, v]) => [k, Math.round(v)])) };
  const j = p.json;
  return {
    h: { hash: p.hash, spawn: [j.spawn.x, j.spawn.y, j.spawn.rung], villages: j.villages.length, caves: j.caves.length, rooms: j.rooms.length, warps: j.warps.length },
    ms, parts,
  };
}

export function allPlans(terrain, zone, kgrid, clock) {
  const worlds = {}, ms = {};
  for (const type of TYPES) {
    for (const seed of SEEDS) {
      const r = onePlan(type, seed, terrain, zone, kgrid, clock);
      worlds[`${type}:${seed}`] = r.h;
      ms[`${type}:${seed}`] = r.ms;
    }
  }
  return { h: { v: GEN_VERSION, worlds }, ms };
}
