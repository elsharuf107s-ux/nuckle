#!/usr/bin/env node
// The radius budget test (design 3.0 rule 4): every chain of lattice filters fits the 12-point lattice apron,
// every chain of full-resolution filters fits the 12-cell apron, and no full-resolution filter (bar the listed
// exceptions) has a radius over 3. The jitter's reach is derived from the code's own constant, not assumed.
//
//   node tools/gen_tests/radius.mjs
import { LAT_APRON, WATER_REACH, CELL_APRON, MAX_CELL_FILTER, LATTICE_FILTERS, LATTICE_CHAINS, CELL_FILTERS, CELL_CHAINS,
  CELL_FILTER_EXCEPTIONS, chainSum, SUPER_FILTERS, SUPER_CHAIN, SUPER_M, PAINT_CELL_REACH } from '../../src/gen/radius.js';
import { CLASS_FILTERS, CLASS_CHAIN } from '../../src/gen/radius.js';
import { FIELD_REACH, PATCH_MIN, PATCH_PASSES } from '../../src/gen/patches.js';
import { HUB_R } from '../../src/gen/biomes.js';
import { WATER } from '../../src/gen/region.js';
import { LAT } from '../../src/gen/climate.js';

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

// a cell's jittered position is at most WATER.jitter cells away (fbm is in [-1, 1]); its nearest lattice point
// and the 2 x 2 points it interpolates between are then at most this many lattice points from its own
let reach = 0;
for (let x = 0; x < LAT; x++) {
  for (const j of [-WATER.jitter, WATER.jitter]) reach = Math.max(reach, Math.abs(Math.floor((x + j) / LAT + 0.5)));
}
check(LATTICE_FILTERS.cellLookup >= reach, `cellLookup radius ${LATTICE_FILTERS.cellLookup} covers the jitter's reach ${reach} (jitter ${WATER.jitter} cells)`);
for (const [name, chain] of Object.entries(LATTICE_CHAINS)) {
  const s = chainSum(LATTICE_FILTERS, chain);
  const budget = name === 'water' ? WATER_REACH : LAT_APRON;
  check(s <= budget, `lattice chain ${name} = ${chain.join(' + ')} = ${s} <= ${budget}${name === 'water' ? ' (WATER_REACH)' : ''}`);
}
for (const [name, r] of Object.entries(CELL_FILTERS)) {
  if (CELL_FILTER_EXCEPTIONS.includes(name)) continue;
  check(r <= MAX_CELL_FILTER, `cell filter ${name} radius ${r} <= ${MAX_CELL_FILTER}`);
}
for (const [name, chain] of Object.entries(CELL_CHAINS)) {
  const s = chainSum(CELL_FILTERS, chain);
  check(s <= CELL_APRON, `cell chain ${name} = ${chain.join(' + ')} = ${s} <= ${CELL_APRON}`);
}
// stage 3b as built: the super levels fit the ring of supers computed past the working grid, given that the cells
// read reach at most PAINT_CELL_REACH, which leaves at least one super of the apron unread
const cellReach = Math.max(...Object.values(PAINT_CELL_REACH));
const unread = Math.floor((CELL_APRON - cellReach) / 4);
check(unread >= 1, `painted cells read at most ${cellReach} cells, leaving ${unread} super(s) of the ${CELL_APRON}-cell apron unread`);
const sc = chainSum(SUPER_FILTERS, SUPER_CHAIN);
check(sc <= SUPER_M + unread, `super chain ${SUPER_CHAIN.join(' + ')} = ${sc} <= SUPER_M ${SUPER_M} + ${unread}`);
const cc = chainSum(CLASS_FILTERS, CLASS_CHAIN);
check(cc <= SUPER_M + unread, `class chain ${CLASS_CHAIN.join(' + ')} = ${cc} <= SUPER_M ${SUPER_M} + ${unread} (generator polish; the sweep: genpolish fixer)`);
check(FIELD_REACH >= PATCH_PASSES * (2 * PATCH_MIN + HUB_R) + (HUB_R + 2) + (HUB_R + 2), `land field reach ${FIELD_REACH} covers ${PATCH_PASSES} patch passes (two floods and the hub check each), s1's and bio's own reach`);
// negative control: an over-long chain must fail
check(chainSum(LATTICE_FILTERS, ['hub', 'hub', 'hub', 'cellLookup']) > LAT_APRON, 'negative control: hub x 3 + cellLookup exceeds the apron');
console.log(fails ? `radius: ${fails} failed` : 'radius: all passed');
process.exit(fails ? 1 : 0);
