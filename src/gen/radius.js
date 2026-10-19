// The radius budget (design 3.0 rule 4). A chunk reads only position-derived noise and the plan, never another
// chunk, so every filter that looks at neighbours must fit in the apron the chunk computes around itself:
//   * on the lattice: a 12-point apron (48 cells); lattice filters may chain up to 12 points;
//   * at full resolution: a 12-cell apron (a 56 x 56 working grid); only filters of radius 3 or less, and a
//     chain (a mask, then the filters reading it, then the painter) may sum to at most 12.
// gen_tests/radius.mjs sums every chain below and fails if one exceeds its budget; the seam test
// (gen_tests/determinism.mjs) checks the result byte for byte.
import { HUB_R } from './biomes.js';

export const LAT_APRON = 12;
// the water fields (C, R, L, E...) are read only through a gradient and an interpolation: region.js evaluates
// them only this many lattice points beyond the region's own (radius 1 + 1, plus 1 for the point at the far side)
export const WATER_REACH = 3;
export const CELL_APRON = 12;
export const MAX_CELL_FILTER = 3;

// Lattice filters and their radii in lattice points.
export const LATTICE_FILTERS = Object.freeze({
  majority: 1,          // biomes.js majority (3 x 3), run twice
  hub: HUB_R,           // biomes.js hubRule
  gradient: 1,          // region.js central differences of C and R (beaches and rivers)
  interp: 1,            // region.js bilinear interpolation to cells (the point to the right and below)
  cellLookup: 4,        // region.js nearest lattice point of a cell jittered by up to 12 cells (WATER.jitter)
});

export const LATTICE_CHAINS = Object.freeze({
  biome: ['majority', 'majority', 'hub', 'cellLookup'],
  water: ['gradient', 'interp'],   // evaluated within WATER_REACH (radius.mjs checks the chain fits it)
  coldOcean: ['cellLookup'],
});

// Full-resolution filters (stage 3b fills these in as the painters land; the chains are the design's).
export const CELL_FILTERS = Object.freeze({
  runFilter: 2, ice: 3, treeSlotExclusion: 2, slotNeighbours: 4, treeTiles: 2,
  rockRim: 1, oreEdge: 2, painter: 2, tallGrassClose: 1,
});

export const CELL_CHAINS = Object.freeze({
  runFilter: ['runFilter'],
  iceShore: ['ice'],
  trees: ['runFilter', 'treeSlotExclusion', 'slotNeighbours', 'treeTiles'],
  rock: ['rockRim', 'oreEdge', 'painter'],
  tallGrass: ['tallGrassClose', 'painter'],
});

// Exceptions to the "radius 3 or less" rule: tree slot neighbours are counted in cells on a 2-cell lattice of
// slots (lattice distance 1 is up to 4 cells) and are a lookup of hashed slots, not a filter over a mask.
export const CELL_FILTER_EXCEPTIONS = Object.freeze(['slotNeighbours']);

export function chainSum(filters, chain) {
  let s = 0;
  for (const f of chain) {
    if (!(f in filters)) throw new Error('unknown filter ' + f);
    s += filters[f];
  }
  return s;
}

// ---------------------------------------------------------------- stage 3b as built (chunk.js, patches.js)
// The step rule is drawn on 4-cell "supers" aligned to absolute coordinates (chunk.js). Level 0 of a super is a
// pure function of its position (its 4 samples), so the painter computes supers SUPER_M beyond the working grid
// (a ring of pointwise work, not an apron read from neighbours) and each later level reads one ring less:
// (generator polish: the speck rule now takes every land-biome patch under 40 x 40 cells, components of extent up to
// 9 supers, and judges a new tint over the whole component grown by SPECK_CLASH supers, so all its members agree)
export const SPECK_R = 9;            // supers: the speck rule's window (components of extent up to 9 supers, 36 cells)
export const SPECK_CLASH = 2;        // supers: the tint clash test's reach around the component's members
export const SUPER_FILTERS = Object.freeze({ level1: 1, breakers: 1, speck: SPECK_R + SPECK_CLASH - 1, tintNear: 2 });
export const SUPER_CHAIN = Object.freeze(['level1', 'breakers', 'speck', 'tintNear']);
// the region's cells and every cell they read lie at least one super inside the working grid (they read cells up to
// PAINT_CELL_REACH away, and the working grid is CELL_APRON wider than the region on each side)
// (genpolish fixer) raised to fit the class chain's island sweep below (13 + SWEEP_R + 1 = 19, with the one super of the
// apron the cells never read): the speck rule alone needs 3 + SPECK_R + SPECK_CLASH - 1 = 13
export const SWEEP_R = 5;            // supers: the island sweep's window (enclosed islands of extent up to 5 supers, 20 cells)
export const SUPER_M = Math.max(3 + SPECK_R + SPECK_CLASH - 1, 13 + SWEEP_R);
// (generator polish) the classes' own chain of super levels: level 1 (2: the island fill's 1 x 2 test), the breakers,
// the lone-water rule, the island fill again (2) and the straight-run breakers (7: a run read 6 each way, then the
// pair). It must fit SUPER_M, as the cells read the classes of the working grid's supers.
// (genpolish fixer) then the island sweep (SWEEP_R + 1: a land component enclosed by fresh water, labelled in a window
// of SWEEP_R supers, plus its fresh neighbours). The cells read classes from the working grid's super 1 on (radius.mjs:
// the chain fits SUPER_M plus the unread super, as the super chain does)
export const CLASS_FILTERS = Object.freeze({ level1: 2, breakers: 1, lone: 1, fill: 2, straight: 7, sweep: SWEEP_R + 1 });
export const CLASS_CHAIN = Object.freeze(['level1', 'breakers', 'lone', 'fill', 'straight', 'sweep']);
// how far (cells) a painted cell reads other cells' classes, tints and tiles: trees (a tile reads the slots beside it,
// a slot reads the cells and slots beside it), ores (a vein start 2 away and its surface test 2 more, plus the rock
// painter's 5 x 5), decorations (a bush beside a tree tile), the rock and ledge painters, the quarter-tile codes
export const PAINT_CELL_REACH = Object.freeze({ trees: 6, ores: 6, decorations: 7, rock: 2, ledges: 3, quarter: 1 });
// The land biome the cells use (patches.js) is a lazily evaluated field over the lattice: a pure function of each
// point, read through no window, so it has no apron; patches.js FIELD_REACH bounds how far a point's value reads
// (its arrays throw past it, which the seam test would show).
// Stage 3c's plan stamps (chunk.js setStamps: village bounds, the spawn meadow) are rectangles aligned to the supers and
// read by position only: level 0 of a super inside one is forced (pointwise), and a tree slot tests its own footprint
// grown by 2 cells against them (inside the trees' reach above). They add no neighbour reads to any chain.
