// Shared by tools/gen_tests/determinism.mjs in Node and in the headless browser page (it imports only src/gen,
// so the same file runs in both): the chunk hashes and threshold hashes the golden file records.
import { makeGen, chunkHash, thresholdsJSON } from '../../src/gen/index.js';
import { fnv1a } from '../../src/gen/hash.js';
import { GEN_VERSION } from '../../src/gen/version.js';

export const SEEDS = [1, 2, 123456, -7, 'hello'];
export const TYPES = ['wild', 'kanto'];

// 64 central chunks (inland on every seed: the "different seeds differ" test uses these) and 36 spread over the
// whole overworld (sea, coasts, Kanto's box), in overworld-local chunk coordinates
export const CENTRAL = [];
for (let cy = 21; cy < 29; cy++) for (let cx = 21; cx < 29; cx++) CENTRAL.push([cx, cy]);
export const SPREAD = [];
for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) SPREAD.push([4 + 8 * i, 4 + 8 * j]);

export const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');

// kin: a Kanto World's inputs (kanto_inputs.mjs; stage 6a: zone, grid, ground and the entries' classes)
export function worldHashes(type, seed, kin) {
  const g = makeGen({ type, seed }, type === 'kanto' ? kin : {});
  return {
    seed: g.seed,
    th: hex(fnv1a(thresholdsJSON(g.th))),
    central: CENTRAL.map(([cx, cy]) => chunkHash(g, cx, cy)),
    spread: SPREAD.map(([cx, cy]) => chunkHash(g, cx, cy)),
  };
}

export function allHashes(kin) {
  const worlds = {};
  for (const type of TYPES) for (const seed of SEEDS) worlds[`${type}:${seed}`] = worldHashes(type, seed, kin);
  return { v: GEN_VERSION, worlds };
}
