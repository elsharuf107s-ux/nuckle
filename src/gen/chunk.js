// The painters (design 3.4 to 3.9, 4.2, 4.3): from stage 3a's biomes and water to atlas entries, ground entries and
// decoration codes for any rectangle of the overworld. A data chunk is paintRegion(g, 32 cx, 32 cy, 32, 32).
//
// Every output cell depends only on stage 3a's pointwise fields, the lattice and cells within CELL_APRON (12) of it,
// so a region and the chunks that tile it are byte-identical (the seam test). The chains are in radius.js.
//
// The step rule (3.4), as built: every blob mask (land and water, sand, snow, mud, ice, tall grass, rock) is decided
// on a 4-cell grid aligned to absolute coordinates ("supers"): each 4 x 4 super takes its value from 4 samples at
// cells (1, 1), (3, 1), (1, 3), (3, 3) of it (2 or more set, or any for rivers and lakes). So every boundary step is
// at least 4 cells and every straight run at least 4 (design: steps at least 2). Later levels (lone water, the beach
// and ice rules, the run breakers, specks, tints) each read one ring of supers more; level 0 is pointwise, so the
// painter computes SUPER_M supers past its working grid (radius.js) and, with the world caches, keeps it per world.
// The land biome comes from patches.js (stage 3a's lattice biome without thin parts and small patches), looked up at
// each sample with the painter's own LAND_JITTER.
// Outputs per cell (Uint16 tile, ground; Uint8 deco, cls; and stage 3a's biome, land, water):
//   tile    the atlas entry drawn in the cell (General < genBase <= terrain.json's)
//   ground  the plain ground entry under it: drawn under an overlay entry, and what a broken cell leaves
//   deco    a decoration code (DECO), 0 none
//   cls     the cell's class (C_*), for the checks and the later stages
import { evalLattice, latticeWindow, cellContext, cellAt, W_NONE, W_OCEAN, W_DEEP, W_RIVER, W_LAKE } from './region.js';
import { riverSignedAt } from './region.js';   // (generator polish: narrow rivers)
import { isKantoCell, kantoClassAt, kantoSeamAt, kantoSlotAt, K_SEA, K_ROCK, K_TREE } from './kanto.js';
import { kantoGoneAt, kantoOpenCellAt, kantoCutAt } from './kanto.js';   // (stage 6b: Kanto's openings)
import { B, TINT_OF, T_TEMPERATE, T_COOL, T_DRY, T_LUSH, T_SWAMP, isSnowy } from './biomes.js';
import { makeLandField } from './patches.js';
import { LAT } from './climate.js';
import { makeFbm, fbm, clamp } from './noise.js';
import { hash32, fnv1a } from './hash.js';
import { CELL_APRON, SPECK_R, SUPER_M } from './radius.js';
import { SPECK_CLASH } from './radius.js';   // (generator polish)
import { SWEEP_R } from './radius.js';       // (genpolish fixer)
import { lookup, blobBits, rockPick } from './autotile.js';
import { VILLAGE_DECOS, paintVillage } from './village.js';   // (stage 7a)
import { treeTileFor, slotRowOf } from './trees.js';
import { ORE_KINDS, STYLES } from './terrain.js';

export const C_NONE = 0, C_GRASS = 1, C_SAND = 2, C_SNOW = 3, C_MUD = 4, C_ROCK = 5, C_SEA = 6, C_FRESH = 7,
  C_ICE = 8, C_ICEP = 9, C_KANTO = 10, C_TALL = 11, C_LEDGE = 12;
export const CLASS_NAMES = ['none', 'grass', 'sand', 'snow', 'mud', 'rock', 'sea', 'fresh', 'ice', 'pond ice', 'kanto', 'tall grass', 'ledge'];
const isWaterC = (c) => c === C_SEA || c === C_FRESH;
const isLandC = (c) => !(c === C_SEA || c === C_ICE || c === C_FRESH || c === C_ICEP);
const isFreshC = (c) => c === C_FRESH || c === C_ICEP;
const isSeaC = (c) => c === C_SEA || c === C_ICE;
const beachC = (c) => c === C_SAND || c === C_SNOW;
const isGrassC = (c) => c === C_GRASS || c === C_TALL || c === C_LEDGE || c === C_KANTO;

// Decoration codes (2.7): append only (they are part of GEN_VERSION's output). Stage 4a maps them to frozen blocks.
// (6c appends the stronghold ruin's two brick blocks)
export const DECO = Object.freeze(['', 'dandelion', 'poppy', 'sugar_cane', 'cactus', 'dead_bush', 'pumpkin', 'melon', 'lily_pad',
  'mossy_stone_bricks', 'cracked_stone_bricks',
  // (7a appends the villages' blocks: village.js VILLAGE_DECOS, in its order)
  ...VILLAGE_DECOS]);
export const D = Object.freeze(Object.fromEntries(DECO.map((n, i) => [n.toUpperCase() || 'NONE', i])));

export const STYLE_BROWN = 0, STYLE_GREY = 1, STYLE_SNOWY = 2, STYLE_SANDSTONE = 3;

// Plan structures stamped into chunks (3.4 rule 4; stage 3c): kinds, and setStamps(g, list) with list entries
// { k, x0, y0, x1, y1, grove } (overworld-local cells, x1 and y1 exclusive, every edge a multiple of 4; grove: the
// crowns' slots [lx, cy] a meadow forces). The plan (plan.js attachPlan) calls it once, before any chunk is painted;
// changing the stamps drops the world's level-0 super cache, which holds stamped values.
export const STAMP_VILLAGE = 1, STAMP_MEADOW = 2;
export function setStamps(g, list) {
  for (const st of list) {
    if ((st.x0 | st.y0 | st.x1 | st.y1) & 3) throw new Error('a stamp must be aligned to the 4-cell supers');
  }
  g.stamps = list.slice();
  g.superCache = null;
}
// Cave hills (3.10, stage 5b): the plan's cave mouths, stamped per cell (not per super, so they need no alignment):
// the hill rectangle [x0, y0, w, h] is rock, the mouth (mx, my) on its bottom row shows FireRed's cave entrance
// (General mid 169 in the rock's style), and the 3 x 2 apron under the mouth is walkable ground. No tree comes within
// 2 cells of the hill and its apron, and no ledge or decoration lies in them. A pure function of the plan and the
// position, so the seam test still holds. Entries { mx, my, x0, y0, x1, y1 } (x1, y1 exclusive, apron included).
export const STAMP_CAVE = 3;
export function caveStampsOf(caves) {
  return caves.map((c) => ({ mx: c.x, my: c.y, hx0: c.hill[0], hy0: c.hill[1], hx1: c.hill[0] + c.hill[2], hy1: c.hill[1] + c.hill[3],
    x0: c.hill[0], y0: c.hill[1], x1: c.hill[0] + c.hill[2], y1: c.y + 3 }));
}
export function setCaveStamps(g, list) { g.caveStamps = list.slice(); }
// The Wild World stronghold's ruin (3.13, stage 6c): the plan stamps a STAMP_RUIN rectangle around the entrance (the
// meadow's rules: plain grass, no tall grass, no water, no tree within 2 cells) and lists the entrance cell with
// setRuins(g, [{ x, y }]). The painter puts Route 23's closed entrance on the cell with the open stairs as its ground
// (world.json's stronghold.entranceTiles, entries below genBase; tools/gen_tests/stronghold.mjs checks they agree),
// and 8 mossy and cracked stone brick decorations on the ring at radius 3, its south side open.
export const STAMP_RUIN = 4;
export const RUIN_CLOSED = 8046, RUIN_OPEN = 8047;
export const RUIN_RING = Object.freeze([[-3, -3], [-1, -3], [1, -3], [3, -3], [-3, 0], [3, 0], [-3, 3], [3, 3]]);
export function setRuins(g, list) { g.ruins = list.slice(); }
// A Kanto World's openings (3.12, stage 6b): the plan's kept openings (kanto.js openingState, on g.kanto.open). Their
// corridors are marked STAMP_CORRIDOR in the painter's stamp mask (no ledge or decoration there).
export const STAMP_CORRIDOR = 5;

// Biome records (3.3, 3.8): ground, trees (species, density), tall grass threshold on the 1/40 noise (null: none),
// flowers, decorations. Kept here rather than in terrain.json (they are generator rules, not art).
const REC = (() => {
  const r = [];
  const set = (id, o) => { r[id] = Object.freeze({ ground: 'grass', species: null, density: 0, tall: null, flowers: false, ...o }); };
  for (let i = 0; i < 24; i++) set(i, {});
  set(B.PLAINS, { species: 'round_oak', density: 0.06, tall: 0.05, flowers: true, pumpkin: true });
  set(B.FOREST, { species: 'oak', density: 0.55, tall: 0.35, flowers: true, bush: true });
  set(B.BIRCH_FOREST, { species: 'birch', density: 0.5, tall: 0.3, flowers: true, bush: true });
  set(B.DARK_FOREST, { species: 'dark_oak', density: 0.85, tall: 0.5, cluster: true });
  set(B.TAIGA, { species: 'spruce', density: 0.5, tall: 0.35, pumpkin: true });
  set(B.SNOWY_TAIGA, { ground: 'snow', species: 'snowy_spruce', density: 0.45 });
  set(B.SNOWY_PLAINS, { ground: 'snow', species: 'snowy_spruce', density: 0.02 });
  set(B.DESERT, { ground: 'sand' });
  set(B.SAVANNA, { species: 'acacia', density: 0.06, tall: 0.0, deadBush: true });
  set(B.SWAMP, { species: 'swamp_oak', density: 0.2, tall: 0.4, mud: true });
  set(B.JUNGLE, { species: 'jungle', density: 0.7, tall: 0.2, melon: true, bush: true });
  set(B.STONY_HILLS, { species: 'spruce', density: 0.04, tall: 0.3, ledges: true, boulders: true });
  set(B.MOUNTAINS, { species: 'spruce', density: 0.05, tall: 0.45, boulders: true });
  set(B.SNOWY_MOUNTAINS, { ground: 'snow', boulders: true });
  set(B.KANTO, { species: 'oak', density: 0 });
  return Object.freeze(r);
})();
export const BIOME_REC = REC;
const SPECIES_ID = ['', 'oak', 'round_oak', 'birch', 'dark_oak', 'spruce', 'snowy_spruce', 'acacia', 'jungle', 'swamp_oak'];
const SPEC_OAK = 1;
const SPEC_OF = new Uint8Array(24);
for (let i = 0; i < 24; i++) SPEC_OF[i] = REC[i].species ? SPECIES_ID.indexOf(REC[i].species) : 0;

const STYLE_OF = new Uint8Array(24);
for (const b of [B.SNOWY_TAIGA, B.SNOWY_PLAINS, B.SNOWY_MOUNTAINS, B.SNOWY_BEACH]) STYLE_OF[b] = STYLE_SNOWY;
STYLE_OF[B.TAIGA] = STYLE_GREY; STYLE_OF[B.STONY_SHORE] = STYLE_GREY; STYLE_OF[B.DESERT] = STYLE_SANDSTONE;

// Ores (3.9): coverage per band (surface, inner, core) in % of interior faces, and the mean vein size.
const ORE_TABLE = [
  // kind,        surface, inner, core, mean, where
  ['coal_ore', 2.0, 1.5, 1.0, 4, 0],
  ['copper_ore', 1.0, 1.0, 0.5, 4, 0],
  ['iron_ore', 0.8, 1.4, 1.2, 4, 0],
  ['gold_ore', 0.1, 0.3, 0.5, 3, 0],
  ['redstone_ore', 0.1, 0.3, 0.5, 3, 0],
  ['lapis_ore', 0.05, 0.2, 0.35, 3, 0],
  ['emerald_ore', 0, 0.15, 0.25, 2, 1],    // mountains and snowy mountains only
  ['diamond_ore', 0, 0, 0.12, 2, 2],       // mountains only
].map(([kind, s, i, c, mean, where]) => ({ kind, k: ORE_KINDS.indexOf(kind), cov: [s, i, c], mean, where }));
export const ORE_REGION = 96;           // cells: one pair of kinds per aligned 96 x 96 region
const ORE_REACH = 2;                    // a vein's cells lie within 2 cells (Chebyshev) of its start
const SCREEN_W = 15, SCREEN_H = 10;
// a start is allowed only if every ore region within a screen of every cell it could share a screen with has the
// same pair of kinds, so no 15 x 10 window ever shows more than two kinds (4.7 item 5)
const ORE_GUARD_X = SCREEN_W - 1 + 2 * ORE_REACH, ORE_GUARD_Y = SCREEN_H - 1 + 2 * ORE_REACH;
export const ORE_TUNE = 2.7;            // the overall factor tuned so coverage is 4 to 6% (stage 3b measured it)

const TALL_W = 40;
export const LAND_JITTER = 6;     // cells
export const PUDDLE_FADE = 20;    // cells from a village's bounds where swamp puddles start to fade (3c fix)

// Per-world painting state: the noise layers and the prepared tile bank (terrain.js).
export function preparePaint(seed, terrain) {
  const s = seed | 0;
  const L = {
    variety: makeFbm(s, 'paint.variety', 40, 2), tall: makeFbm(s, 'paint.tall', TALL_W, 2),
    grove: makeFbm(s, 'paint.grove', 60, 2), rjit: makeFbm(s, 'paint.rock.jitter', 16, 2),
    pass: makeFbm(s, 'paint.pass', 90, 2), passw: makeFbm(s, 'paint.pass.width', 200, 1),
    outcrop: makeFbm(s, 'paint.outcrop', 60, 2), mud: makeFbm(s, 'paint.mud', 30, 2),
    puddle: makeFbm(s, 'paint.puddle', 24, 2), ledge: makeFbm(s, 'paint.ledge', 56, 2),
    snowgrass: makeFbm(s, 'paint.snow.grass', 40, 2), band: makeFbm(s, 'paint.band', 10, 1),
    // (generator polish) the desert's features: cactus clumps, dead bush patches, sandstone outcrops
    dcactus: makeFbm(s, 'paint.desert.cactus', 14, 2), dbush: makeFbm(s, 'paint.desert.bush', 20, 2),
    drock: makeFbm(s, 'paint.desert.rock', 40, 2),
  };
  const T = terrain;
  const tintVar = new Uint8Array(6);
  tintVar[T_COOL] = T.tints.cool.var; tintVar[T_DRY] = T.tints.dry.var; tintVar[T_LUSH] = T.tints.lush.var; tintVar[T_SWAMP] = T.tints.swamp.var;
  const bandVar = [];
  bandVar[T_COOL] = T.bands.cool; bandVar[T_DRY] = T.bands.dry; bandVar[T_LUSH] = T.bands.lush; bandVar[T_SWAMP] = T.bands.swamp;
  const styleVar = STYLES.map((n) => T.rockStyles[n].var);
  // pure ore faces: interior pieces with no ground pixels (2b: 104, 106 and 120 show a corner of ground)
  const pureFace = new Uint8Array(640);
  for (const f of T.ores.faces) { const cp = T.rock.compat.get(f); if (!cp || (!cp[0] && !cp[1])) pureFace[f] = 1; }
  return {
    L, T, tintVar, bandVar, styleVar, pureFace,
    seedTree: hash32(s, fnv1a('paint.trees')), seedDeco: hash32(s, fnv1a('paint.deco')),
    seedOre: hash32(s, fnv1a('paint.ores')), seedBoulder: hash32(s, fnv1a('paint.boulders')),
  };
}

// the per-world cache of level-0 supers (absolute super coordinates -32 .. 431, about 1.5 MB)
function makeSuperCache() {
  const n = 464, N = n * n, u = () => new Uint8Array(N);
  return { o: -32, n, flag: u(), cls: u(), landCls: u(), tall: u(), land: u(), biome: u(), wk: u(), kc: u() };
}

const r01 = (a, b, c, d) => hash32(a, b, c, d) / 4294967296;

// The pair of ore kinds of a 96 x 96 region (absolute overworld cells), weighted by the table's total coverage.
function orePair(P, rx, ry) {
  const h1 = r01(P.seedOre, rx, ry, 1), h2 = r01(P.seedOre, rx, ry, 2);
  const w = ORE_WEIGHTS;
  let a = 0, acc = 0;
  for (let i = 0; i < w.length; i++) { acc += w[i] / W_TOTAL; if (h1 < acc) { a = i; break; } a = i; }
  const rest = W_TOTAL - w[a];
  let b = a === 0 ? 1 : 0; acc = 0;
  for (let i = 0; i < w.length; i++) { if (i === a) continue; acc += w[i] / rest; b = i; if (h2 < acc) break; }
  return a < b ? a * 8 + b : b * 8 + a;
}
const ORE_WEIGHTS = ORE_TABLE.map((o) => o.cov[0] + o.cov[1] + o.cov[2] + 0.4);
const W_TOTAL = ORE_WEIGHTS.reduce((s, v) => s + v, 0);
// how often each kind is in a region's pair (for the boost that keeps world-wide coverage as tabled)
const ORE_PAIR_P = (() => {
  const p = new Float64Array(ORE_TABLE.length);
  for (let a = 0; a < ORE_TABLE.length; a++) {
    const pa = ORE_WEIGHTS[a] / W_TOTAL;
    p[a] += pa;
    for (let b = 0; b < ORE_TABLE.length; b++) if (b !== a) p[b] += pa * ORE_WEIGHTS[b] / (W_TOTAL - ORE_WEIGHTS[a]);
  }
  return p;
})();

// (genpolish fixer) the world caches hold values of the plan's structures too (stamps, cave hills, the ruin, which the
// desert outcrops keep clear of, and Kanto's openings): when any of them changes (the plan sets them one after another,
// painting in between), every painter cache of the world is dropped, so a cached value is always the uncached one
function syncCaches(g) {
  const sig = [g.stamps, g.caveStamps, g.ruins, g.kanto ? g.kanto.open : null];
  if (g.cacheSig && g.cacheSig.every((v, i) => v === sig[i])) return;
  if (g.cacheSig) { g.superCache = null; g.blockCache = null; g.rockLat = null; }
  g.cacheSig = sig;
}
// (genpolish fixer) the supers of a chunk inside one aligned block, from the block's own painting (paintRegion with
// supersOnly), kept per world in g.blockCache (the last BLOCK_KEEP blocks). Only chunk-sized regions (the worker's and
// the main thread's paintChunk) take this path: a larger one (the plan's 96 x 96 tests) paints its own supers.
export const SUPER_BLOCK = 256;         // cells: 8 x 8 chunks
const SM_TILED = 3, BLOCK_KEEP = 12, TILED_MAX = 32;
const SUP_KEYS = ['sCls', 'sTall', 'sLand', 'sTint', 'sWk', 'sGround', 'sVar', 'sBank', 'sNear', 'sBar', 'kAlt', 'pBiome'];
function blockSupers(g, x0, y0, S0x, S0y, SW, SH) {
  const bc = g.blockCache ||= { map: new Map() };
  const bx = Math.floor(x0 / SUPER_BLOCK), by = Math.floor(y0 / SUPER_BLOCK), key = bx + ',' + by;
  let bd = bc.map.get(key);
  if (!bd) {
    bd = paintRegion(g, bx * SUPER_BLOCK, by * SUPER_BLOCK, SUPER_BLOCK, SUPER_BLOCK, { supersOnly: true });
    if (bc.map.size >= BLOCK_KEEP) bc.map.delete(bc.map.keys().next().value);
    bc.map.set(key, bd);
  }
  const out = {}, N = SW * SH, ox = S0x - bd.S0x, oy = S0y - bd.S0y;
  if (ox < 0 || oy < 0 || ox + SW > bd.SW || oy + SH > bd.SH) throw new Error('blockSupers: the region leaves its block');
  for (const k of SUP_KEYS) {
    const src = bd[k], dst = out[k] = new Uint8Array(N);
    for (let y = 0; y < SH; y++) dst.set(src.subarray((y + oy) * bd.SW + ox, (y + oy) * bd.SW + ox + SW), y * SW);
  }
  return out;
}

// (genpolish fixer) the per-world cache of the lattice stage's raw rock flags and pass field (lattice points -64 .. 463,
// about 2.8 MB; dropped by syncCaches)
function rockLatCache(g) {
  if (!g.rockLat) { const n = 528, N = n * n; g.rockLat = { o: -64, n, flag: new Uint8Array(N), raw: new Uint8Array(N), pf: new Float64Array(N) }; }
  return g.rockLat;
}

export function paintRegion(g, x0, y0, w, h, opts = {}) {
  const P = g.paint;
  if (!P) throw new Error('paintRegion needs makeGen(..., { terrain })');
  const T = P.T, L = P.L, th = g.th;
  const A = CELL_APRON;
  // (genpolish fixer) with the world caches (the worker's walk) a region inside one aligned SUPER_BLOCK x SUPER_BLOCK
  // block (a chunk) takes its supers from the block's own painting (supersOnly below, kept per world in g.blockCache), so the
  // wide windows the super levels need (SUPER_M supers) are worked out once per 64 chunks instead of per chunk (chunk-sized regions only). The
  // region's own windows then need only SM_TILED supers past its working grid (the cells read supers 2 beyond their
  // own). The block's supers are the same pure functions of the position (its region holds the chunk's), so the
  // result is byte for byte the uncached one (gen_tests/paint_seams.mjs paints its chunks with and without the caches).
  if (g.latCache) syncCaches(g);
  const tiled = !!(g.latCache && !opts.supersOnly && w <= TILED_MAX && h <= TILED_MAX && Math.floor(x0 / SUPER_BLOCK) === Math.floor((x0 + w - 1) / SUPER_BLOCK)
    && Math.floor(y0 / SUPER_BLOCK) === Math.floor((y0 + h - 1) / SUPER_BLOCK));
  const SMQ = tiled ? SM_TILED : SUPER_M;
  const WX0 = Math.floor((x0 - A) / 4) * 4, WY0 = Math.floor((y0 - A) / 4) * 4;
  const WX1 = -Math.floor(-(x0 + w + A) / 4) * 4, WY1 = -Math.floor(-(y0 + h + A) / 4) * 4;
  const WW = WX1 - WX0, WH = WY1 - WY0, N = WW * WH;
  // stage 3a's lattice over the working grid; its per-cell fields are evaluated only where they are read: at the supers' samples and the region's own cells
  // (the supers reach SM supers past the working grid; their samples read the lattice at their jittered positions)
  const SMC = 4 * SMQ;
  const win = latticeWindow(WX0 - SMC, WY0 - SMC, WW + 2 * SMC, WH + 2 * SMC);
  // the land biome without thin parts and small patches (4.7 item 10, patches.js); cells take their land biome from
  // it, rock masses keep the unfiltered one (a small hill stays as an outcrop). It is a pure function of the point,
  // so it is filled for the whole window but its edge (the cells' jittered nearest points and the painter's own
  // lattice grid below read it).
  const lat0 = evalLattice(g, win.lx0, win.ly0, win.lw, win.lh);
  const FI = 2;
  const LF = makeLandField(g, win.lx0 + FI, win.ly0 + FI, win.lw - 2 * FI, win.lh - 2 * FI);
  const fbio = Uint8Array.from(lat0.bio);
  // (generator polish: filled only over the painter's own lattice grid below, SUPER_M + 6 points past the working grid,
  // which holds every point a sample's or a cell's jittered lookup can reach; the land field's work grows with it)
  const FM = SMQ + 6, fi0 = Math.max(FI, WX0 / LAT - FM - win.lx0), fj0 = Math.max(FI, WY0 / LAT - FM - win.ly0);
  const fi1 = Math.min(win.lw - FI, WX1 / LAT + FM + 1 - win.lx0), fj1 = Math.min(win.lh - FI, WY1 / LAT + FM + 1 - win.ly0);
  for (let j = fj0; j < fj1; j++) for (let i = fi0; i < fi1; i++) fbio[j * win.lw + i] = LF.final(win.lx0 + i, win.ly0 + j);
  const lat = { ...lat0, bio: fbio };
  const ctx = cellContext(g, lat);
  const at3 = (x, y) => cellAt(ctx, WX0 + x, WY0 + y);
  // Kanto World (stage 6a): Kanto's context (kanto.js) and the influence field's forest rule
  const KK = g.kanto && g.kanto.ctx ? g.kanto : null, KINF = KK ? g.layers.kinf : null;
  // (6b) Kanto's kept openings: `inCorr` a cell of a corridor (null when no corridor comes near this window), `inCorr4`
  // the same with each corridor grown to whole 4-cell supers (where rock is cleared, so the masses keep their 4-cell rule)
  // and 4 cells wider on one side or the other in turn every 4 cells along it, so a cleared rock edge never runs straight
  // for more than 8 cells (4.7's straight seams)
  const KOP = KK && KK.open ? KK.open : null;
  const corrNear = KOP && KOP.box[0] - 8 < WX1 && KOP.box[2] + 8 > WX0 && KOP.box[1] - 8 < WY1 && KOP.box[3] + 8 > WY0;
  const inCorr = corrNear ? (ax, ay) => { for (const r of KOP.corr) if (ax >= r[0] && ay >= r[1] && ax < r[2] && ay < r[3]) return true; return false; } : null;
  const inCorr4 = corrNear ? (ax, ay) => {
    for (const r of KOP.corr) {
      let x0 = r[0] & ~3, y0 = r[1] & ~3, x1 = (r[2] + 3) & ~3, y1 = (r[3] + 3) & ~3;
      // (the ends too, 4 cells longer every other 4 cells across, so an end never lines up with a boundary beside it)
      if (r[3] - r[1] > r[2] - r[0]) { const b = ((ay >> 2) % 3 + 3) % 3; if (b === 0) x0 -= 4; else if (b === 1) x1 += 4; if ((ax >> 2) & 1) { y0 -= 4; y1 += 4; } }
      else { const b = ((ax >> 2) % 3 + 3) % 3; if (b === 0) y0 -= 4; else if (b === 1) y1 += 4; if ((ay >> 2) & 1) { x0 -= 4; x1 += 4; } }
      if (ax >= x0 && ay >= y0 && ax < x1 && ay < y1) return true;
    }
    return false;
  } : null;

  // ---------------------------------------------------------------- plan structures (3.4 rule 4, stage 3c)
  // the plan's stamps (setStamps) that reach the super grid: rectangles aligned to the 4-cell supers, so a super is
  // wholly inside or outside one. A pure function of the plan and the position, so the seam test still holds.
  // (PUDDLE_FADE more cells: a village's bounds plus 4 are left out of the run breakers below, and puddles fade out
  // toward a village from PUDDLE_FADE cells away)
  const SMX = 4 * SMQ + PUDDLE_FADE;
  const stamps = (g.stamps || []).filter((st) => st.x1 > WX0 - SMX && st.x0 < WX1 + SMX && st.y1 > WY0 - SMX && st.y0 < WY1 + SMX);
  const stampAt = (ax, ay) => {
    for (const st of stamps) if (ax >= st.x0 && ax < st.x1 && ay >= st.y0 && ay < st.y1) return st.k;
    return 0;
  };
  // cave hills (stage 5b): 1 a hill cell (rock), 2 an apron cell (walkable ground), 0 neither
  const cstamps = (g.caveStamps || []).filter((st) => st.x1 > WX0 - 4 && st.x0 < WX1 + 4 && st.y1 > WY0 - 4 && st.y0 < WY1 + 4);
  const caveCell = (ax, ay) => {
    for (const st of cstamps) {
      if (ax >= st.hx0 && ax < st.hx1 && ay >= st.hy0 && ay < st.hy1) return 1;
      if (ay > st.my && ay <= st.my + 2 && ax >= st.mx - 1 && ax <= st.mx + 1) return 2;
    }
    return 0;
  };
  // a natural tree slot keeps its footprint (lx .. lx + 1, cy - 1 .. cy + 1) 2 cells clear of every stamp, so a stamp's
  // own grove (oak, 3.14's meadow) never joins a natural crown of another species
  const slotStamped = (ax, ay) => {
    for (const st of stamps) if (ax + 1 >= st.x0 - 2 && ax < st.x1 + 2 && ay + 1 >= st.y0 - 2 && ay - 1 < st.y1 + 2) return true;
    for (const st of cstamps) if (ax + 1 >= st.x0 - 2 && ax < st.x1 + 2 && ay + 1 >= st.y0 - 2 && ay - 1 < st.y1 + 2) return true;
    return false;
  };
  // a super kept out of the run breakers (3c fix): inside any stamp, or within 4 cells of a village's bounds (the plan's
  // site test proves the bounds plus 4 dry and rock-free at level 1; a breaker would carry water or rock into them from
  // the super beside them)
  const breakerKept = (ax, ay) => {
    for (const st of stamps) {
      const m = st.k === STAMP_VILLAGE ? 4 : 0;
      if (ax >= st.x0 - m && ax < st.x1 + m && ay >= st.y0 - m && ay < st.y1 + m) return true;
    }
    return false;
  };
  // the swamp puddles' threshold at a sample (3c fix): 0.45, rising in a straight ramp to 1 from
  // PUDDLE_FADE cells to 4 cells (Euclidean) from a village's bounds, with no puddle nearer, so a puddle never
  // lies in the bounds plus 4 (where the stamp would hide it or cut it straight) and its outline near a village is the
  // smooth contour of noise minus ramp. Puddles are not cellAt's water, so the plan's site test does not see them.
  const vstamps = stamps.filter((st) => st.k === STAMP_VILLAGE);
  const puddleTh = (ax, ay) => {
    let t = 0.45;
    for (const st of vstamps) {
      const dx = ax < st.x0 ? st.x0 - ax : ax >= st.x1 ? ax - st.x1 + 1 : 0, dy = ay < st.y0 ? st.y0 - ay : ay >= st.y1 ? ay - st.y1 + 1 : 0;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 4) return Infinity;
      if (d < PUDDLE_FADE) t = Math.max(t, 0.45 + 0.55 * (PUDDLE_FADE - d) / (PUDDLE_FADE - 4));
    }
    return t;
  };
  const grove = new Set();
  for (const st of stamps) for (const [gx, gy] of st.grove || []) grove.add((gx + 4096) * 8192 + gy + 4096);

  // ---------------------------------------------------------------- the lattice: rock masses and styles (3.6)
  // local lattice grid: points WX0/4 - 6 .. WX1/4 + 6 (stage 3a's biomes are valid there: majority 2 + hub 4)
  // (it reaches past the supers' samples, SM supers beyond the working grid, by the 5 points the morphology below
  // needs plus one for the interpolation, so level 0 of every super is a pure function of its position)
  const LM = SMQ + 6, lgx0 = WX0 / LAT - LM, lgy0 = WY0 / LAT - LM;
  const LW = WW / LAT + 2 * LM + 1, LH = WH / LAT + 2 * LM + 1, LN = LW * LH;
  const raw = new Uint8Array(LN), sty = new Uint8Array(LN), pf = new Float64Array(LN);
  const lbio = new Uint8Array(LN), lM = new Float64Array(LN), lt = new Float64Array(LN);
  const mHill = th.mRock + 0.4 * (th.mMount - th.mRock);
  // (generator polish) sandstone outcrops in deserts (3.6): lattice points of the desert where the 1/40 desert rock
  // noise is high, the same closing and opening as every mass below (so at least 3 x 3 points), never within
  // DESERT_ROCK_CLEAR cells of a plan stamp, cave hill or ruin (the plan's site tests do not know these masses)
  const dClear = [...(g.stamps || []), ...(g.caveStamps || []), ...(g.ruins || []).map((r) => ({ x0: r.x - 4, y0: r.y - 4, x1: r.x + 5, y1: r.y + 5 }))];
  const nearPlan = (px, py) => {
    for (const st of dClear) if (px >= st.x0 - DESERT_ROCK_CLEAR && px < st.x1 + DESERT_ROCK_CLEAR && py >= st.y0 - DESERT_ROCK_CLEAR && py < st.y1 + DESERT_ROCK_CLEAR) return true;
    return false;
  };
  const RLC = g.latCache ? rockLatCache(g) : null;
  for (let j = 0; j < LH; j++) {
    for (let i = 0; i < LW; i++) {
      const p = j * LW + i, q = (lgy0 + j - lat.ly0) * lat.lw + (lgx0 + i - lat.lx0);
      const b = lat.bio[q], b0 = lat0.bio[q], m = lat.M[q], px = (lgx0 + i) * LAT, py = (lgy0 + j) * LAT;
      lbio[p] = b; lM[p] = m; lt[p] = lat.t[q];
      sty[p] = STYLE_OF[b];
      // (genpolish fixer) a point's rock and pass values are pure functions of the point and the plan: kept per world
      let rci = -1;
      if (RLC) {
        const cx = lgx0 + i - RLC.o, cy = lgy0 + j - RLC.o;
        if (cx >= 0 && cy >= 0 && cx < RLC.n && cy < RLC.n) {
          rci = cy * RLC.n + cx;
          if (RLC.flag[rci]) { raw[p] = RLC.raw[rci]; pf[p] = RLC.pf[rci]; continue; }
        }
      }
      let rock = false;
      if (b0 === B.MOUNTAINS || b0 === B.SNOWY_MOUNTAINS) rock = m >= th.mRock;
      else if (b0 === B.STONY_HILLS) rock = m >= mHill;
      else if (b0 !== B.KANTO) rock = m >= th.mRiverFade && fbm(L.outcrop, px, py) > 0.5;
      if (!rock && b === B.DESERT && fbm(L.drock, px, py) > DESERT_ROCK && !nearPlan(px, py)) rock = true;   // (generator polish)
      raw[p] = rock ? 1 : 0;
      pf[p] = fbm(L.pass, px, py);
      if (rci >= 0) { RLC.raw[rci] = raw[p]; RLC.pf[rci] = pf[p]; RLC.flag[rci] = 1; }
    }
  }
  // closing then opening of radius 1 point (no spur or hole narrower than 4 cells), then a gap of one point
  // between masses of different styles, so one mass never has two styles
  const morph = (src, dil) => {
    const out = new Uint8Array(LN);
    for (let j = 1; j < LH - 1; j++) {
      for (let i = 1; i < LW - 1; i++) {
        const p = j * LW + i;
        let v = dil ? 0 : 1;
        // (genpolish fixer: stops at the first point that decides it)
        scan: for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const s = src[p + dj * LW + di];
          if (dil ? s : !s) { v = dil ? 1 : 0; break scan; }
        }
        out[p] = v;
      }
    }
    return out;
  };
  const opened = morph(morph(morph(morph(raw, true), false), false), true);
  const rockL = new Float64Array(LN);
  for (let j = 1; j < LH - 1; j++) {
    for (let i = 1; i < LW - 1; i++) {
      const p = j * LW + i;
      if (!opened[p]) continue;
      let same = true;
      for (let dj = -1; dj <= 1 && same; dj++) for (let di = -1; di <= 1; di++) if (sty[p + dj * LW + di] !== sty[p]) { same = false; break; }
      rockL[p] = same ? 1 : 0;
    }
  }
  // bilinear interpolation of a lattice field at a cell (working-grid coordinates)
  const li = (F, x, y) => {
    const ax = WX0 + x, ay = WY0 + y;
    const lx = Math.floor(ax / LAT), ly = Math.floor(ay / LAT);
    const tx = (ax - lx * LAT) / LAT, ty = (ay - ly * LAT) / LAT;
    const p = (ly - lgy0) * LW + (lx - lgx0);
    return F[p] * (1 - tx) * (1 - ty) + F[p + 1] * tx * (1 - ty) + F[p + LW] * (1 - tx) * ty + F[p + LW + 1] * tx * ty;
  };
  // the style of a rock cell: its rock lattice corners (one style by the gap rule), else its biome's
  const styleAt = (x, y) => {
    const ax = WX0 + x, ay = WY0 + y;
    const p = (Math.floor(ay / LAT) - lgy0) * LW + (Math.floor(ax / LAT) - lgx0);
    if (rockL[p]) return sty[p];
    if (rockL[p + 1]) return sty[p + 1];
    if (rockL[p + LW]) return sty[p + LW];
    if (rockL[p + LW + 1]) return sty[p + LW + 1];
    return sty[p];
  };
  // a mountain pass: within 3 to 5 cells of the zero contour of the pass noise (a signed distance in cells)
  const passAt = (x, y) => {
    const ax = WX0 + x, ay = WY0 + y;
    const lx = Math.floor(ax / LAT), ly = Math.floor(ay / LAT);
    const p = (ly - lgy0) * LW + (lx - lgx0);
    const v = li(pf, x, y);
    const gx = (pf[p + 1] - pf[p - 1]) / (2 * LAT), gy = (pf[p + LW] - pf[p - LW]) / (2 * LAT);
    const gm = Math.sqrt(gx * gx + gy * gy) + 1e-9;
    const hw = 3 + 2 * clamp(fbm(L.passw, ax, ay) + 0.5, 0, 1);
    return (v < 0 ? -v : v) / gm < hw;
  };

  // ---------------------------------------------------------------- supers: every blob mask on the 4-cell grid
  // Level 0 (pointwise): each super's class, tall grass flag and land biome from its 4 samples.
  // the super grid reaches SM supers past the working grid, so every level read by the region's cells is valid
  const SM = SMQ, SW = WW / 4 + 2 * SM, SH = WH / 4 + 2 * SM, SN = SW * SH;
  const sIdx = (x, y) => ((y >> 2) + SM) * SW + (x >> 2) + SM;
  // (genpolish fixer) the super levels below, or (tiled) their results copied from the block's painting
  const SUP = tiled ? blockSupers(g, x0, y0, WX0 / 4 - SM, WY0 / 4 - SM, SW, SH) : (() => {
  const pCls = new Uint8Array(SN), pLandCls = new Uint8Array(SN), pTall = new Uint8Array(SN), pLand = new Uint8Array(SN);
  const pBiome = new Uint8Array(SN), pWk = new Uint8Array(SN);
  // a mostly-Kanto super's Kanto class (6a): K_SEA or K_ROCK when 2 of its samples are Kanto's sea or rock, else K_TREE
  const pK = new Uint8Array(SN);
  const SO = [[1, 1], [3, 1], [1, 3], [3, 3]];
  // level 0 is a pure function of the super's absolute position: with the world's lattice cache (the worker) it is
  // kept per world, so neighbouring chunks share the supers of their aprons
  const SC = g.latCache ? (g.superCache ||= makeSuperCache()) : null;
  const SX0a = WX0 / 4 - SM, SY0a = WY0 / 4 - SM;
  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < SW; sx++) {
      const s = sy * SW + sx;
      let ci = -1;
      if (SC) {
        const cx = SX0a + sx - SC.o, cy = SY0a + sy - SC.o;
        if (cx >= 0 && cy >= 0 && cx < SC.n && cy < SC.n) {
          ci = cy * SC.n + cx;
          if (SC.flag[ci]) {
            pCls[s] = SC.cls[ci]; pLandCls[s] = SC.landCls[ci]; pTall[s] = SC.tall[ci]; pLand[s] = SC.land[ci]; pBiome[s] = SC.biome[ci]; pWk[s] = SC.wk[ci];
            pK[s] = SC.kc[ci];
            continue;
          }
        }
      }
      let sea = 0, deep = 0, fresh = 0, sand = 0, snow = 0, rock = 0, mud = 0, pud = 0, tall = 0, kanto = 0, ksea = 0, krock = 0;
      let rv = 0, lk = 0;   // (generator polish) river and lake samples
      for (let k = 0; k < 4; k++) {
        const x = (sx - SM) * 4 + SO[k][0], y = (sy - SM) * 4 + SO[k][1], v = at3(x, y);
        const wv = v >> 16, b = v & 255, ax = WX0 + x, ay = WY0 + y;
        // the land biome with the painter's own, smaller jitter (stage 3a's 12 cells would cut the necks of narrow
        // regions into specks; the breakers below keep boundaries from running straight)
        let la = b === B.KANTO ? b : fbio[(Math.floor((ay + LAND_JITTER * fbm(g.layers.jy, ax, ay)) / LAT + 0.5) - win.ly0) * win.lw
          + Math.floor((ax + LAND_JITTER * fbm(g.layers.jx, ax, ay)) / LAT + 0.5) - win.lx0];
        // a Kanto World (6a): land within 16 cells of Kanto's tree walls is FOREST (Kanto's own oak, 3.12)
        if (KINF && b !== B.KANTO && TINT_OF[la] === T_TEMPERATE && la !== B.KANTO && KINF.tree(ax, ay) < 16) la = B.FOREST;
        if (k === 0) { pLand[s] = la; pBiome[s] = b; }   // the super's land biome: its first sample's
        if (b === B.KANTO) {
          kanto++;
          const kc = kantoClassAt(KK, ax, ay);
          if (kc === K_SEA) ksea++; else if (kc === K_ROCK) krock++;
          continue;
        }
        if (wv === W_OCEAN || wv === W_DEEP) { sea++; if (wv === W_DEEP) deep++; continue; }
        if (wv === W_RIVER || wv === W_LAKE) { fresh = fresh || wv; if (wv === W_RIVER) rv++; else lk++; continue; }
        if (b === B.BEACH || b === B.STONY_SHORE || la === B.DESERT) sand++;
        if (b === B.SNOWY_BEACH || (isSnowy(la) && !(la !== B.SNOWY_MOUNTAINS && fbm(L.snowgrass, ax, ay) > 0.42))) snow++;
        if (b !== B.BEACH && b !== B.SNOWY_BEACH && b !== B.STONY_SHORE) {
          const rl = li(rockL, x, y);
          if (rl > 0.2 && rl + 0.3 * fbm(L.rjit, ax, ay) > 0.5 && !passAt(x, y)) rock++;
        }
        if (la === B.SWAMP) {
          if (fbm(L.mud, ax, ay) > 0.12) mud++;
          if (fbm(L.puddle, ax, ay) > (vstamps.length ? puddleTh(ax, ay) : 0.45)) pud++;
        }
        const tr = REC[la].tall;
        if (tr !== null && fbm(L.tall, ax, ay) > tr) tall++;
      }
      // (generator polish) a river super only where the river's centre line passes through it (its signed distance
      // changes sign between the super's corners) or where all 4 samples are river: a 3 to 7 cell river is 1 or 2
      // supers wide (4 to 8 cells), as 3a drew it, instead of every super any sample touched (which doubled the width
      // and, where a river wandered, left braided channels round 4 x 4 islands). The centre line passes through a
      // chain of edge-sharing supers, so the river stays connected; lakes keep the any-sample rule
      if (rv && !lk && rv < 4) {
        const cx0 = WX0 + (sx - SM) * 4, cy0 = WY0 + (sy - SM) * 4;
        const d0 = riverSignedAt(ctx, cx0, cy0), d1 = riverSignedAt(ctx, cx0 + 4, cy0);
        const d2 = riverSignedAt(ctx, cx0, cy0 + 4), d3 = riverSignedAt(ctx, cx0 + 4, cy0 + 4);
        if ((d0 > 0 && d1 > 0 && d2 > 0 && d3 > 0) || (d0 < 0 && d1 < 0 && d2 < 0 && d3 < 0)) fresh = 0;
      }
      let wk = W_NONE;
      if (fresh) wk = fresh;
      else if (sea >= 2) wk = deep >= 2 ? W_DEEP : W_OCEAN;
      else if (pud >= 2) wk = W_LAKE;
      let lc = rock >= 2 ? C_ROCK : sand >= 2 ? C_SAND : snow >= 2 ? C_SNOW : mud >= 2 ? C_MUD : C_GRASS;
      // a stamped super (3.4 rule 4): village bounds are dry land with no rock (its own ground: sand, snow or grass);
      // a spawn meadow is plain grass with no tall grass
      const sk = stamps.length && kanto < 2 ? stampAt((SX0a + sx) * 4, (SY0a + sy) * 4) : 0;
      if (sk) {
        wk = W_NONE;
        if (sk === STAMP_MEADOW || sk === STAMP_RUIN) { lc = C_GRASS; tall = 0; }
        else if (lc === C_ROCK) lc = sand >= 2 ? C_SAND : snow >= 2 ? C_SNOW : C_GRASS;
      }
      pWk[s] = wk;
      pTall[s] = tall >= 2 ? 1 : 0;
      pLandCls[s] = kanto >= 2 ? C_KANTO : lc;
      pCls[s] = kanto >= 2 ? C_KANTO : wk === W_OCEAN || wk === W_DEEP ? C_SEA : wk ? C_FRESH : lc;
      pK[s] = kanto >= 2 ? (ksea >= 2 ? K_SEA : krock >= 2 ? K_ROCK : K_TREE) : 0;
      if (ci >= 0) {
        SC.cls[ci] = pCls[s]; SC.landCls[ci] = pLandCls[s]; SC.tall[ci] = pTall[s]; SC.land[ci] = pLand[s]; SC.biome[ci] = pBiome[s]; SC.wk[ci] = pWk[s];
        SC.kc[ci] = pK[s];
        SC.flag[ci] = 1;
      }
    }
  }
  // Level 1 (reads level 0 of the 8 neighbours): a water super with no water beside it takes its land class (a lake
  // is at least 5 x 4, 4.7 item 10); the beach rule (land beside the sea is sand, snow on snowy shores, so a sand
  // cell touching the sea never touches grass: stage 2a's "no mixed A and B codes"); the ice rule (cold water beside
  // land freezes, 3.5).
  const SX0 = WX0 / 4 - SM, SY0 = WY0 / 4 - SM;
  const c1 = new Uint8Array(SN), t1 = new Uint8Array(SN), l1 = new Uint8Array(SN), k1 = new Uint8Array(SN), sBeach = new Uint8Array(SN);
  const sBar = new Uint8Array(SN);   // (generator polish) a river mouth's or lake's sand bar
  // (generator polish) a block island: the fresh kind round the super (or 0) when it has fresh water on all 4 sides, or
  // on 3 with its fourth neighbour a land super with fresh water on its other 3 (a 1 x 2 island), or when it joins two
  // fresh supers that meet only at a corner (below). Reads 2 supers out
  // (out of the grid: land), within the class chain's budget (the cells read classes 4 levels in, SUPER_M is 13)
  const islandAt = (cl, wk, s) => {
    const sx = s % SW, sy = (s - sx) / SW;
    const fr = (q) => isFreshC(cl[q]);
    let n = 0, land = -1, k = 0;
    for (let d4 = 0; d4 < 4; d4++) { const dx = NB4X[d4], dy = NB4Y[d4];
      const x = sx + dx, y = sy + dy;
      if (x < 0 || y < 0 || x >= SW || y >= SH) { land = -2; continue; }
      const q = y * SW + x;
      if (fr(q)) { n++; k = k || wk[q] || W_LAKE; } else land = q;
    }
    if (n === 4) return k;
    // a corner joint: two fresh supers that touch only at a corner (the river's centre line crossing a super corner)
    // are joined through the upper of the two land supers between them, so a river never breaks into pieces that
    // meet diagonally
    const sd = sy + 1 < SH ? s + SW : -1;
    if (sd >= 0 && fr(sd)) {
      if (sx > 0 && fr(s - 1) && !fr(sd - 1)) return wk[sd] || W_LAKE;
      if (sx + 1 < SW && fr(s + 1) && !fr(sd + 1)) return wk[sd] || W_LAKE;
    }
    if (n !== 3 || land < 0) return 0;
    const lc = cl[land];
    if (!(lc === C_GRASS || lc === C_SAND || lc === C_SNOW || lc === C_MUD)) return 0;
    const lx = land % SW, ly = (land - lx) / SW;
    for (let d4 = 0; d4 < 4; d4++) { const dx = NB4X[d4], dy = NB4Y[d4];
      const x = lx + dx, y = ly + dy;
      if (x === sx && y === sy) continue;
      if (x < 0 || y < 0 || x >= SW || y >= SH || !fr(y * SW + x)) return 0;
    }
    return k;
  };
  // (generator polish) supers the island fill below leaves alone: the plan's stamps and a village's bounds plus 4 (which
  // the plan's site test proves dry: breakerKept), and Kanto's openings' corridors
  const fillKept = (s) => {
    const ax = (SX0 + (s % SW)) * 4, ay = (SY0 + Math.floor(s / SW)) * 4;
    return (stamps.length && (stampAt(ax, ay) || breakerKept(ax, ay))) || (inCorr4 && inCorr4(ax, ay));
  };
  // the class of the generated cells inside a mostly-Kanto super (6a): Kanto's sea or rock runs on into them (one water
  // mask, one rock mask), else land, sand beside the sea (so generated grass never touches Kanto's sea either)
  const kAlt = new Uint8Array(SN);
  const cnt = new Uint8Array(32);
  // Kanto's sea counts as sea for the lone-water and beach rules (6a)
  const seaS = (q) => pCls[q] === C_SEA || (pCls[q] === C_KANTO && pK[q] === K_SEA);
  const waterS = (q) => isWaterC(pCls[q]) || (pCls[q] === C_KANTO && pK[q] === K_SEA);
  for (let sy = 1; sy < SH - 1; sy++) {
    for (let sx = 1; sx < SW - 1; sx++) {
      const s = sy * SW + sx;
      let c = pCls[s];
      if (isWaterC(c) && !waterS(s - 1) && !waterS(s + 1) && !waterS(s - SW) && !waterS(s + SW)) c = pLandCls[s];
      let nearSea = false, nearLand = false, fk = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const q = s + dy * SW + dx, n = pCls[q];
        if (seaS(q)) nearSea = true;
        else if (n !== C_FRESH) nearLand = true;
      }
      // (generator polish) the island fill: a land super that is a block island in fresh water (1 x 1 or 1 x 2 supers,
      // islandAt) is water too, so no river or lake keeps a 4 x 4 or 4 x 8 block island (islands left are at least
      // 2 x 2 supers, their corners rounded by the pond pieces)
      if (pCls[s] === c && (c === C_GRASS || c === C_SAND || c === C_SNOW || c === C_MUD) && (fk = islandAt(pCls, pWk, s)) && !fillKept(s)) c = C_FRESH;
      else fk = 0;
      // (generator polish) the sand bar: fresh water never meets the sea (FireRed has no piece between pond water and the
      // sea); a fresh super beside the sea (or Kanto's sea) is the beach's sand instead, so a river ends in a lagoon
      // behind a bar of the beach and a lake by the sea is cut off from it by a strip of sand
      if (c === C_FRESH && nearSea && pCls[s] !== C_KANTO) { c = pLandCls[s] === C_SNOW || isSnowy(pLand[s]) ? C_SNOW : C_SAND; sBar[s] = 1; fk = 0; }
      if (c === C_KANTO) kAlt[s] = pK[s] === K_SEA ? C_SEA : pK[s] === K_ROCK ? C_ROCK : nearSea ? (isSnowy(pLand[s]) ? C_SNOW : C_SAND) : C_GRASS;
      if (!isWaterC(c) && c !== C_KANTO && nearSea) { sBeach[s] = 1; if (c !== C_SAND && c !== C_SNOW) c = isSnowy(pLand[s]) || pBiome[s] === B.SNOWY_BEACH ? C_SNOW : C_SAND; }
      if (isWaterC(c) && nearLand && li(lt, (sx - SM) * 4 + 2, (sy - SM) * 4 + 2) < 0.18) c = c === C_SEA ? C_ICE : C_ICEP;
      c1[s] = c; t1[s] = c === C_GRASS ? pTall[s] : 0; k1[s] = isLandC(c) && c !== C_ICE && c !== C_ICEP ? W_NONE : fk || pWk[s] || W_LAKE;
      // the land biome: the commonest of the 3 x 3 supers (the super's own on a tie), so no biome speck is under
      // 3 x 3 supers (Kanto's own supers are kept as they are)
      let lb = pLand[s];
      if (lb !== B.KANTO) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cnt[pLand[s + dy * SW + dx]]++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const b = pLand[s + dy * SW + dx]; if (b !== B.KANTO && cnt[b] > m) m = cnt[b]; }
        if (cnt[lb] < m) {
          let best = 255;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const b = pLand[s + dy * SW + dx]; if (b !== B.KANTO && cnt[b] === m && b < best) best = b; }
          lb = best;
        }
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cnt[pLand[s + dy * SW + dx]] = 0;
      }
      l1[s] = lb;
    }
  }
  // Level 2 (reads level 1 of the 4 neighbours): the run breakers. Every 6th super along each super-grid line is a
  // breaker pair (the two supers across the line); where the line is a boundary there (any difference of class or
  // tall grass), the loser takes the winner's class, so no boundary runs straight for more than 5 supers (20 cells,
  // 4.7 item 8). The pairs follow a fixed 6 x 6 pattern in which no super is in two pairs (so one flip never undoes
  // another): across row line r at column 2r mod 6, across column line q at row RV6[q mod 6]. Winners keep every rule
  // above: fresh water beats land and the sea (a river is never cut, and the sea never reaches grass through it), land
  // beats the sea and its ice (the sea never grows toward grass), sand and snow beat other land (a beach never
  // shrinks), else the super above or to the left wins. Kanto's supers never change. The land biome (tints, trees,
  // records) has breakers of its own.
  const m6 = (v) => ((v % 6) + 6) % 6;
  const brkH = (sx, sy) => m6(SX0 + sx) === m6(2 * (SY0 + sy));      // the pair (sx, sy - 1) and (sx, sy)
  const brkV = (sx, sy) => m6(SY0 + sy) === RV6[m6(SX0 + sx)];       // the pair (sx - 1, sy) and (sx, sy)
  // 1: the first of the pair wins, 2: the second, 0: no change
  const winner = (a, b) => {
    if (a === C_KANTO || b === C_KANTO) return 0;
    if (isFreshC(a) && !isFreshC(b)) return 1;
    if (isFreshC(b) && !isFreshC(a)) return 2;
    if (isSeaC(a) && isLandC(b)) return 2;
    if (isSeaC(b) && isLandC(a)) return 1;
    if (isLandC(a) && isLandC(b) && beachC(a) !== beachC(b)) return beachC(a) ? 1 : 2;
    return 1;
  };
  const sLand0 = new Uint8Array(SN);
  const sCls = new Uint8Array(SN), sTall = new Uint8Array(SN), sLand = new Uint8Array(SN), sTint = new Uint8Array(SN), sWk = new Uint8Array(SN);
  const sGround = new Uint8Array(SN), sVar = new Uint8Array(SN), sBank = new Uint8Array(SN), sNear = new Uint8Array(SN);
  // the land biome's breakers (on level 1; the second of a pair takes the first's biome)
  for (let sy = 2; sy < SH - 2; sy++) {
    for (let sx = 2; sx < SW - 2; sx++) {
      const s = sy * SW + sx;
      let lb = l1[s];
      if (brkH(sx, sy) && l1[s - SW] !== lb && l1[s - SW] !== B.KANTO && lb !== B.KANTO) lb = l1[s - SW];
      else if (brkV(sx, sy) && l1[s - 1] !== lb && l1[s - 1] !== B.KANTO && lb !== B.KANTO) lb = l1[s - 1];
      sLand0[s] = lb;
    }
  }
  // specks (4.7 item 10): a super whose land-biome component (4-connected, on the super grid) has an extent of at
  // most SPECK_R supers takes the commonest biome of the supers beside the component (lowest id on a tie). Each super
  // looks at the window of SPECK_R supers around it: a component that small lies inside every member's window without
  // touching its edge, so all its members agree.
  // (generator polish) SPECK_R is 9 supers (36 cells), so every patch under 40 x 40 cells merges into its neighbour (4.7
  // item 10; 3b left 121 such patches in 20 worlds), and the tint rule is judged on the component itself, the same for
  // every member: a temperate biome, or one of the patch's own tint, is always taken; a new non-temperate tint only when
  // every super beside the component has that tint (so two small patches never take two different tints side by side)
  // and no other non-temperate tint lies within SPECK_CLASH supers of any member (the hub rule's temperate band stays).
  // Failing every candidate the patch keeps its biome.
  const SR = SPECK_R, RC = SPECK_CLASH, SPK = SR + RC - 1;
  // (as built: the components are labelled once over the super grid rows and columns 2 .. S - 3, where sLand0 is
  // valid, instead of a flood per super; a component is small when its extent is at most SR in both directions and it
  // stays off that range's edge. For a super SPK or more in from the grid, a component small in its window is exactly
  // one small here, so the result is the window rule's, a pure function of the position)
  const comp = new Int32Array(SN).fill(-1), cstack = [], crep = [];
  for (let sy = 2 + SPK; sy < SH - 2 - SPK; sy++) {
    for (let sx = 2 + SPK; sx < SW - 2 - SPK; sx++) {
      const s0 = sy * SW + sx, lb0 = sLand0[s0];
      if (lb0 === B.KANTO || comp[s0] >= 0) continue;
      const id = crep.length, members = [];
      let bx0 = sx, bx1 = sx, by0 = sy, by1 = sy, big = false;
      comp[s0] = id; cstack.length = 0; cstack.push(s0);
      while (cstack.length) {
        const q = cstack.pop(), qx = q % SW, qy = (q - qx) / SW;
        members.push(q);
        if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx; if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
        if (qx <= 2 || qy <= 2 || qx >= SW - 3 || qy >= SH - 3) big = true;
        for (let d4 = 0; d4 < 4; d4++) { const dx = NB4X[d4], dy = NB4Y[d4];
          const r = q + dy * SW + dx;
          if (comp[r] < 0 && sLand0[r] === lb0) { comp[r] = id; cstack.push(r); }
        }
      }
      if (big || bx1 - bx0 + 1 > SR || by1 - by0 + 1 > SR) { crep.push(-1); continue; }
      let tmask = 0;
      for (const q of members) {
        for (let d4 = 0; d4 < 4; d4++) { const dx = NB4X[d4], dy = NB4Y[d4];
          const r = q + dy * SW + dx;
          if (comp[r] === id) continue;
          const b = sLand0[r];
          if (b !== B.KANTO) { cnt[b]++; tmask |= 1 << TINT_OF[b]; } else tmask |= 128;
        }
      }
      const own = TINT_OF[lb0];
      let rep = -1;
      for (;;) {
        let best = -1;
        for (let v = 1; v < 24; v++) if (cnt[v] > 0 && (best < 0 || cnt[v] > cnt[best])) best = v;
        if (best < 0) break;
        const tn = TINT_OF[best];
        let clash = false;
        if (tn > T_TEMPERATE && tn !== own) {
          clash = tmask !== 1 << tn;
          for (let m = 0; m < members.length && !clash; m++) {
            const sq = members[m];
            for (let dy = -RC; dy <= RC && !clash; dy++) for (let dx = -RC; dx <= RC; dx++) {
              const tq = TINT_OF[sLand0[sq + dy * SW + dx]];
              if (tq > T_TEMPERATE && tq !== tn) { clash = true; break; }
            }
          }
        }
        if (!clash) { rep = best; break; }
        cnt[best] = 0;
      }
      cnt.fill(0);
      crep.push(rep);
    }
  }
  for (let sy = 2 + SPK; sy < SH - 2 - SPK; sy++) {
    for (let sx = 2 + SPK; sx < SW - 2 - SPK; sx++) {
      const s = sy * SW + sx;
      let lb = sLand0[s];
      if (comp[s] >= 0 && crep[comp[s]] > 0) lb = crep[comp[s]];
      sLand[s] = lb; sTint[s] = TINT_OF[lb];
    }
  }
  for (let sy = 2; sy < SH - 2; sy++) {
    for (let sx = 2; sx < SW - 2; sx++) {
      const s = sy * SW + sx;
      let c = c1[s], t = t1[s], k = k1[s], cDone = false;
      const lb = sLand[s];
      // a stamped super, or one within 4 cells of a village, keeps its level-1 class (3c fix: breakerKept); its partner
      // outside still follows the rule, so nothing else changes
      if (stamps.length && pLandCls[s] !== C_KANTO && breakerKept((SX0 + sx) * 4, (SY0 + sy) * 4)) cDone = true;
      const pairs = [];
      if (brkH(sx, sy)) pairs.push([s - SW, s, 2]);
      if (brkH(sx, sy + 1)) pairs.push([s, s + SW, 1]);
      if (brkV(sx, sy)) pairs.push([s - 1, s, 2]);
      if (brkV(sx + 1, sy)) pairs.push([s, s + 1, 1]);
      for (const [a, b, me] of pairs) {
        if (!cDone && (c1[a] !== c1[b] || t1[a] !== t1[b])) {
          let wn = winner(c1[a], c1[b]);
          // (generator polish) fresh water never takes a super beside the sea (the sand bar stays): there the beach wins,
          // so a river that runs along the bar is notched like any other boundary instead of running straight
          if (wn && isFreshC(c1[wn === 1 ? a : b]) && sBeach[wn === 1 ? b : a]) wn = 3 - wn;
          if (wn && wn !== me) { const w = wn === 1 ? a : b; c = c1[w]; t = t1[w]; k = k1[w]; cDone = true; }
        }
      }
      sCls[s] = c; sTall[s] = t; sWk[s] = k;
      const rec = REC[lb];
      sGround[s] = c === C_ROCK ? (rec.ground === 'sand' || pBiome[s] === B.BEACH ? C_SAND : rec.ground === 'snow' ? C_SNOW : C_GRASS) : c;
      // pond banks by the ground (their water is FireRed's one pond colour; the swamp recolour's teal water is not
      // used: where a river leaves a swamp it would meet ordinary pond water along a straight colour line)
      sBank[s] = lb === B.DESERT || pBiome[s] === B.BEACH ? 1 : isSnowy(lb) || pBiome[s] === B.SNOWY_BEACH ? 2 : 0;
    }
  }
  // a fresh-water super left alone by the rules above (no fresh water beside it: a 4 x 4 pond, under FireRed's
  // smallest lake) becomes land: sand beside the sea, else its own land class
  const lone = [];
  for (let sy = 3; sy < SH - 3; sy++) {
    for (let sx = 3; sx < SW - 3; sx++) {
      const s = sy * SW + sx;
      if (!isFreshC(sCls[s]) || isFreshC(sCls[s - 1]) || isFreshC(sCls[s + 1]) || isFreshC(sCls[s - SW]) || isFreshC(sCls[s + SW])) continue;
      let sea = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (sCls[s + dy * SW + dx] === C_SEA || sCls[s + dy * SW + dx] === C_ICE) sea = true;
      const lc = pLandCls[s] === C_KANTO ? C_GRASS : pLandCls[s];
      lone.push(s, sea && lc !== C_SAND && lc !== C_SNOW ? (isSnowy(sLand[s]) ? C_SNOW : C_SAND) : lc);
    }
  }
  for (let k = 0; k < lone.length; k += 2) { const s = lone[k]; sCls[s] = lone[k + 1]; sGround[s] = lone[k + 1] === C_ROCK ? C_GRASS : lone[k + 1]; sWk[s] = W_NONE; sTall[s] = 0; }
  // (generator polish) the island fill once more on the final classes (the breakers above can close water round a
  // super level 1 left as land): a land super with fresh water on 3 of its 4 sides or 6 of its 8, not beside the sea and
  // not kept for the plan, takes its fresh neighbour's water
  const fill = [];
  for (let sy = 4; sy < SH - 4; sy++) {
    for (let sx = 4; sx < SW - 4; sx++) {
      const s = sy * SW + sx, c = sCls[s];
      if (!(c === C_GRASS || c === C_SAND || c === C_SNOW || c === C_MUD) || sBeach[s] || pLandCls[s] === C_KANTO) continue;
      const k = islandAt(sCls, sWk, s);
      if (!k || fillKept(s)) continue;
      let w = -1;
      for (let d4 = 0; d4 < 4; d4++) { const dx = NB4X[d4], dy = NB4Y[d4]; if (w < 0 && isFreshC(sCls[s + dy * SW + dx])) w = s + dy * SW + dx; }
      fill.push(s, w);
    }
  }
  for (let k = 0; k < fill.length; k += 2) { const s = fill[k], w = fill[k + 1]; sCls[s] = sCls[w]; sGround[s] = sCls[w]; sWk[s] = sWk[w] || W_LAKE; sTall[s] = 0; }
  // (generator polish) straight runs on the final classes: a level-2 pair whose two supers were both land at level 1
  // does nothing, and another pair can then turn one of them into water beside a straight bank (a one-super river ran
  // straight for 40 cells). Every 3rd super along each super-grid line, where the boundary across the line runs
  // straight for 7 supers or more (read 6 each way), the pair's loser takes the winner's class (level 2's winners; water
  // never takes a super beside the sea, the beach wins there). Read from a copy, so the order does not matter.
  const c2 = Uint8Array.from(sCls), w2 = Uint8Array.from(sWk), t2 = Uint8Array.from(sTall);
  const key2 = (q) => c2[q] * 2 + (c2[q] === C_GRASS ? t2[q] : 0);
  const RUN = 7, RR = RUN - 1;
  for (let sy = 3 + RR; sy < SH - 3 - RR; sy++) {
    for (let sx = 3 + RR; sx < SW - 3 - RR; sx++) {
      const s = sy * SW + sx;
      if (pLandCls[s] === C_KANTO) continue;
      // the 4 lines through this super's sides: [the other super, the step along the line]
      for (let e = 0; e < 4; e++) {
        const o = e === 0 ? s + 1 : e === 1 ? s - 1 : e === 2 ? s + SW : s - SW, st = e < 2 ? SW : 1, ph = e < 2 ? SY0 + sy : SX0 + sx;   // (genpolish fixer: no arrays per super)
        if (m6(ph) % 3 !== 0 || pLandCls[o] === C_KANTO || key2(s) === key2(o)) continue;
        let run = 1;
        for (let k = 1; k <= RR && key2(s - k * st) !== key2(o - k * st) && pLandCls[s - k * st] !== C_KANTO && pLandCls[o - k * st] !== C_KANTO; k++) run++;
        for (let k = 1; k <= RR && key2(s + k * st) !== key2(o + k * st) && pLandCls[s + k * st] !== C_KANTO && pLandCls[o + k * st] !== C_KANTO; k++) run++;
        if (run < RUN) continue;
        // the pair (first: above or left), its winner as level 2's
        const first = o < s ? o : s, second = o < s ? s : o;
        let wn = winner(c2[first], c2[second]);
        if (wn && isFreshC(c2[wn === 1 ? first : second]) && sBeach[wn === 1 ? second : first]) wn = 3 - wn;
        if (!wn || (wn === 1 ? first : second) === s || fillKept(s)) continue;
        sCls[s] = c2[o]; sGround[s] = c2[o] === C_ROCK ? sGround[o] : c2[o]; sWk[s] = w2[o]; sTall[s] = t2[o];
        break;
      }
    }
  }
  // (genpolish fixer) the island sweep on the final classes: the fills above see only 1 x 1 and 1 x 2 islands, and the
  // straight-run breakers can cut new ones out of a bank after them (4 x 16 strips of trees, two 4 x 4 blocks meeting at
  // a corner). A component of non-fresh supers (4-connected) that fresh water encloses, of extent at most SWEEP_R
  // supers, with no sea, ice, rock or Kanto in it, nothing the plan keeps (fillKept), no beach and no cave hill near
  // it, becomes water when it is small (at most 3 x 3 supers), one super thin, or an exact rectangle; islands left
  // are at least 16 cells across and never a rectangle (their corners are the pond pieces' round ones). Labelled
  // once over the range where the classes above are valid (from super 13 in, radius.js CLASS_CHAIN); a component is
  // small only when it stays off that range's edge, so for a super SWEEP_R + 1 or more inside it the answer is the
  // window rule's, a pure function of the position. Every member takes the water of the fresh super beside the
  // component's first member (row by row), so the result does not depend on the window either.
  {
    const lo = 13, RW = SWEEP_R;
    const scav = (g.caveStamps || []).filter((st) => st.x1 > (SX0 + lo) * 4 - 8 && st.x0 < (SX0 + SW - lo) * 4 + 8
      && st.y1 > (SY0 + lo) * 4 - 8 && st.y0 < (SY0 + SH - lo) * 4 + 8);
    const lab = new Int32Array(SN).fill(-1), stk = [], mem = [], wfill = [];
    for (let sy = lo; sy < SH - lo; sy++) {
      for (let sx = lo; sx < SW - lo; sx++) {
        const s0 = sy * SW + sx;
        if (lab[s0] >= 0 || isFreshC(sCls[s0])) continue;
        lab[s0] = s0; stk.length = 0; mem.length = 0; stk.push(s0);
        let bx0 = sx, bx1 = sx, by0 = sy, by1 = sy, ok = true;
        while (stk.length) {
          const q = stk.pop(), qx = q % SW, qy = (q - qx) / SW;
          mem.push(q);
          if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx; if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
          if (qx <= lo || qy <= lo || qx >= SW - lo - 1 || qy >= SH - lo - 1) ok = false;
          const c = sCls[q];
          if (!(c === C_GRASS || c === C_SAND || c === C_SNOW || c === C_MUD) || sBeach[q] || pLandCls[q] === C_KANTO) ok = false;
          if (bx1 - bx0 >= RW || by1 - by0 >= RW) ok = false;
          for (let d4 = 0; d4 < 4; d4++) { const dx = NB4X[d4], dy = NB4Y[d4];
            const r = q + dy * SW + dx, rx = qx + dx, ry = qy + dy;
            if (rx < lo || ry < lo || rx >= SW - lo || ry >= SH - lo) { ok = false; continue; }
            if (lab[r] < 0 && !isFreshC(sCls[r])) { lab[r] = s0; stk.push(r); }
          }
        }
        if (!ok) continue;
        const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
        if (!((w <= 3 && h <= 3) || w === 1 || h === 1 || mem.length === w * h)) continue;
        let kept = false;
        for (const q of mem) {
          const ax = (SX0 + (q % SW)) * 4, ay = (SY0 + Math.floor(q / SW)) * 4;
          if (fillKept(q)) { kept = true; break; }
          for (const st of scav) if (ax + 4 > st.x0 - 4 && ax < st.x1 + 4 && ay + 4 > st.y0 - 4 && ay < st.y1 + 4) { kept = true; break; }
          if (kept) break;
        }
        if (kept) continue;
        // the first member row by row (the component's top row, its leftmost super) and its first fresh neighbour
        let first = mem[0];
        for (const q of mem) if (q < first) first = q;
        let wsrc = -1;
        for (let d4 = 0; d4 < 4; d4++) { const dx = NB4X[d4], dy = NB4Y[d4]; if (wsrc < 0 && isFreshC(sCls[first + dy * SW + dx])) wsrc = first + dy * SW + dx; }
        if (wsrc < 0) continue;
        for (const q of mem) wfill.push(q, wsrc);
      }
    }
    // the same for a block of pond ice that open water encloses (a 4 x 4 square of ice in a river, Wild World 'hello'):
    // it thaws, by the same window rule (read from the classes before the fill above, so the two never meet)
    const ilab = new Uint8Array(SN), thaw = [];
    for (let sy = lo; sy < SH - lo; sy++) {
      for (let sx = lo; sx < SW - lo; sx++) {
        const s0 = sy * SW + sx;
        if (ilab[s0] || sCls[s0] !== C_ICEP) continue;
        ilab[s0] = 1; stk.length = 0; mem.length = 0; stk.push(s0);
        let bx0 = sx, bx1 = sx, by0 = sy, by1 = sy, ok = true;
        while (stk.length) {
          const q = stk.pop(), qx = q % SW, qy = (q - qx) / SW;
          mem.push(q);
          if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx; if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
          if (qx <= lo || qy <= lo || qx >= SW - lo - 1 || qy >= SH - lo - 1 || bx1 - bx0 >= RW || by1 - by0 >= RW) ok = false;
          for (let d4 = 0; d4 < 4; d4++) { const dx = NB4X[d4], dy = NB4Y[d4];
            const r = q + dy * SW + dx, rx = qx + dx, ry = qy + dy;
            if (rx < lo || ry < lo || rx >= SW - lo || ry >= SH - lo) { ok = false; continue; }
            if (sCls[r] === C_ICEP) { if (!ilab[r]) { ilab[r] = 1; stk.push(r); } } else if (sCls[r] !== C_FRESH) ok = false;
          }
        }
        if (!ok) continue;
        const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
        if ((w <= 3 && h <= 3) || w === 1 || h === 1 || mem.length === w * h) for (const q of mem) thaw.push(q);
      }
    }
    for (let k = 0; k < wfill.length; k += 2) { const s = wfill[k], w = wfill[k + 1]; sCls[s] = sCls[w]; sGround[s] = sCls[w]; sWk[s] = sWk[w] || W_LAKE; sTall[s] = 0; }
    for (const s of thaw) { sCls[s] = C_FRESH; sGround[s] = C_FRESH; }
  }
  // grass tints (3.7): a non-temperate super has its tint; temperate cells within 3 cells (Euclidean) of one get its
  // two-thirds band and within 6 its one-third band, so a tint change is a gradient that follows the stepped boundary
  // with rounded corners
  // (sTint is valid from super 2 + SPK in, so sNear, reading 2 supers around, from super 4 + SPK)
  const TV = 2 + SPK, NV = 4 + SPK;
  for (let sy = TV; sy < SH - TV; sy++) {
    for (let sx = TV; sx < SW - TV; sx++) {
      const s = sy * SW + sx, tn = sTint[s];
      if (tn > T_TEMPERATE) { sVar[s] = P.tintVar[tn]; continue; }
      if (sy < NV || sx < NV || sy >= SH - NV || sx >= SW - NV) continue;
      for (let dy = -2; dy <= 2 && !sNear[s]; dy++) for (let dx = -2; dx <= 2; dx++) {
        const tq = sTint[s + dy * SW + dx];
        if (tq > T_TEMPERATE) { sNear[s] = tq; break; }
      }
    }
  }
  return { sCls, sTall, sLand, sTint, sWk, sGround, sVar, sBank, sNear, sBar, kAlt, pBiome };
  })();
  // (genpolish fixer) a block's painting stops here and hands its supers to blockSupers
  if (opts.supersOnly) return { S0x: WX0 / 4 - SM, S0y: WY0 / 4 - SM, SW, SH, ...SUP };
  const { sCls, sTall, sLand, sTint, sWk, sGround, sVar, sBank, sNear, sBar, kAlt, pBiome } = SUP;
  // the band ripple (3b fix): a band edge follows a straight tint boundary at the band's width, and the 1/10 noise
  // can stay flat for 25 cells (Kanto seed 9), while the breakers' one-super notches in the boundary are filled by
  // the band from both sides. Half of each band width's wander (0.75 of its 1.5 cells) is now a triangle wave of
  // -1..1 along x + y (period 16), so every band edge, and the tinted side's edge, sweeps 1.5 cells every 8 cells
  // along any row or column. The widths keep their old range, so the hub rule's spacing still holds (a wider reach
  // looked past the 2-super window and let two tints' bands touch).
  const bandRipple = (x, y) => {
    const t = (((WX0 + x + WY0 + y) % 16) + 16) % 16;
    return Math.abs(t - 8) / 4 - 1;
  };
  const cellVar = (x, y) => {
    const sx = (x >> 2) + SM, sy = (y >> 2) + SM, s = sy * SW + sx;
    if (sTint[s] > T_TEMPERATE) {
      // the tinted side's edge wanders too: cells within 0 to 3 cells (1/10 noise) of a temperate super take the
      // two-thirds band, so the tint boundary is never the super grid's straight line
      // (half of the wander is the band ripple below, 3b fix)
      const e = 1.5 + 0.75 * fbm(L.band, WX0 + x + 50, WY0 + y) + 0.75 * bandRipple(x, y), e2 = e * e;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (sTint[s + dy * SW + dx] !== T_TEMPERATE) continue;
          const qx = (sx + dx - SM) * 4, qy = (sy + dy - SM) * 4;
          const ddx = x < qx ? qx - x : x > qx + 3 ? x - qx - 3 : 0, ddy = y < qy ? qy - y : y > qy + 3 ? y - qy - 3 : 0;
          if (ddx * ddx + ddy * ddy <= e2) return P.bandVar[sTint[s]][1];
        }
      }
      return sVar[s];
    }
    if (!sNear[s]) return sVar[s];
    // the nearest super of each non-temperate tint within 2 supers (squared Euclidean cell distance to its rect)
    let best = 999, bt = 0, other = 999;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const q = s + dy * SW + dx, tq = sTint[q];
        if (tq <= T_TEMPERATE) continue;
        const qx = (sx + dx - SM) * 4, qy = (sy + dy - SM) * 4;
        const ddx = x < qx ? qx - x : x > qx + 3 ? x - qx - 3 : 0, ddy = y < qy ? qy - y : y > qy + 3 ? y - qy - 3 : 0;
        const d = ddx * ddx + ddy * ddy;
        if (tq === bt) { if (d < best) best = d; continue; }
        if (d < best) { if (bt) other = Math.min(other, best); best = d; bt = tq; } else other = Math.min(other, d);
      }
    }
    // a cell within band reach of two different tints stays temperate (with 2 cells to spare, so two bands of
    // different tints never touch: only the hub pairs meet, 3.3)
    // the band widths wander by up to 1.5 cells (1/10 noise), so two offset curves never line up into a straight seam
    // (half of the wander is the band ripple, 3b fix: the noise alone can stay flat for 25 cells along a straight
    // tint boundary)
    const r2 = 3 + 0.75 * fbm(L.band, WX0 + x, WY0 + y) + 0.75 * bandRipple(x, y), r1 = r2 + 3;
    if (other <= (r1 + 2.5) * (r1 + 2.5)) return 0;
    return best <= r2 * r2 ? P.bandVar[bt][1] : best <= r1 * r1 ? P.bandVar[bt][0] : 0;
  };


  // ---------------------------------------------------------------- cells: classes and plain grounds
  const cls = new Uint8Array(N), gr = new Uint16Array(N), tile = new Uint16Array(N), deco = new Uint8Array(N);
  const cvar = new Uint8Array(N);
  const kmask = !!g.kanto;
  const kgrid = g.kanto && g.kantoGrid ? g.kantoGrid : null;
  const kground = KK && g.kantoGround ? g.kantoGround : null;
  const S = T.sets, snowyV = P.styleVar[STYLE_SNOWY];
  // grass variety (3.7): FireRed's 2 x 2 tuft pattern (8 9 / 16 17) in patches of the 1/40 noise, per super
  const sVariety = new Uint8Array(SN);
  for (let sy = 0; sy < SH; sy++) for (let sx = 0; sx < SW; sx++) sVariety[sy * SW + sx] = fbm(L.variety, WX0 + (sx - SM) * 4 + 2, WY0 + (sy - SM) * 4 + 2) > 0.25 ? 1 : 0;
  const grassG = (v, x, y, s) => T.grass[v][sVariety[s] ? 1 + (((WX0 + x) & 1) | (((WY0 + y) & 1) << 1)) : 0];
  const groundOf = (c, x, y, s, v) => {
    switch (c) {
      case C_SAND: return 277;
      case C_SNOW: return grassG(snowyV, x, y, s);
      case C_MUD: return S.B.mud.home[0];
      case C_SEA: return T.waterTile;
      case C_ICE: return S.A.ice.home[0];
      case C_ICEP: return S.A.ice_pond.home[0];
      case C_FRESH: return S.P[BANKS[sBank[s]]].home[0];
      default: return grassG(v, x, y, s);
    }
  };
  for (let y = 0; y < WH; y++) {
    for (let x = 0; x < WW; x++) {
      const o = y * WW + x, s = sIdx(x, y);
      let c = sCls[s];
      if (kmask && isKantoCell(g.kanto, WX0 + x, WY0 + y)) c = C_KANTO;
      else if (c === C_KANTO) c = KK ? kAlt[s] || C_GRASS : C_GRASS;
      else if (c === C_GRASS && sTall[s]) c = C_TALL;
      if (cstamps.length && c !== C_KANTO) {
        const kc = caveCell(WX0 + x, WY0 + y);
        if (kc === 1) c = C_ROCK;
        else if (kc === 2 && !(c === C_GRASS || c === C_TALL || c === C_SAND || c === C_SNOW || c === C_MUD)) {
          const gk = REC[sLand[s]].ground;
          c = gk === 'snow' ? C_SNOW : gk === 'sand' ? C_SAND : C_GRASS;
        }
      }
      // (6b) a Kanto opening's corridor: walkable generated ground, a clear path (no rock, no tall grass, over the
      // corridor grown to whole supers with its jitter, so the edges stay on the 4-cell grid and never run straight; the
      // bank has no bridge, so rivers and lakes stay, crossed by swimming or boat as the plan's connectivity counts
      // them); the sea, the stamps and the cave hills stay
      if (inCorr && (c === C_ROCK || c === C_TALL) && inCorr4(WX0 + x, WY0 + y)
        && !(stamps.length && stampAt(WX0 + x, WY0 + y)) && !(cstamps.length && caveCell(WX0 + x, WY0 + y))) {
        const gk = REC[sLand[s]].ground;
        c = gk === 'snow' ? C_SNOW : gk === 'sand' ? C_SAND : C_GRASS;
      }
      cls[o] = c;
      cvar[o] = cellVar(x, y);
      if (c === C_KANTO && kground) { gr[o] = kground[(WY0 + y - g.kanto.y) * 408 + (WX0 + x - g.kanto.x)]; continue; }
      if (c === C_ROCK) {
        const gc = sGround[s];
        gr[o] = gc === C_SAND ? 277 : gc === C_SNOW ? grassG(snowyV, x, y, s) : grassG(cvar[o], x, y, s);
      } else gr[o] = groundOf(c, x, y, s, cvar[o]);
    }
  }
  // the masks see Kanto's sea and rock cells as sea and rock (6a: one water mask and one rock mask across the seam)
  let kmc = null;
  if (KK) {
    kmc = new Uint8Array(N);
    for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) {
      const o = y * WW + x;
      if (cls[o] !== C_KANTO) continue;
      const kc = kantoClassAt(KK, WX0 + x, WY0 + y);
      kmc[o] = kc === K_SEA ? C_SEA : kc === K_ROCK && !(KOP && kantoCutAt(KK, WX0 + x, WY0 + y)) ? C_ROCK : C_KANTO;   // (6b: a cut is not rock)
    }
    // one rock mask 4 thick across the seam (4.7): Kanto's ragged map edges cut the 4-cell supers, so a generated rock
    // cell within 3 cells of a Kanto cell is kept only if some 4 x 4 square of the union mask (generated rock and
    // Kanto's rock) holds it (an opening, radius 3: radius.js kantoRockOpen); the others take their super's ground
    // (a 2-cell finger of rock beside Kanto's trees, seed 24, was the case)
    const rU = (x, y) => x >= 0 && y >= 0 && x < WW && y < WH && (cls[y * WW + x] === C_ROCK || kmc[y * WW + x] === C_ROCK);
    const nearK = (x, y) => { for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (isKantoCell(KK, WX0 + x + dx, WY0 + y + dy)) return true; return false; };
    const drop = [];
    for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) {
      if (cls[y * WW + x] !== C_ROCK || (cstamps.length && caveCell(WX0 + x, WY0 + y)) || !nearK(x, y)) continue;
      let held = false;
      for (let sy = y - 3; sy <= y && !held; sy++) for (let sx = x - 3; sx <= x && !held; sx++) {
        let all = true;
        for (let qy = sy; qy < sy + 4 && all; qy++) for (let qx = sx; qx < sx + 4; qx++) if (!rU(qx, qy)) { all = false; break; }
        held = all;
      }
      if (!held) drop.push(y * WW + x);
    }
    for (const o of drop) {
      const x = o % WW, y = (o - x) / WW, s = sIdx(x, y), gc = sGround[s];
      const c = gc === C_SAND ? C_SAND : gc === C_SNOW ? C_SNOW : C_GRASS;
      cls[o] = c; gr[o] = groundOf(c, x, y, s, cvar[o]);
    }
  }
  const cl = kmc
    ? (x, y) => { if (x < 0 || y < 0 || x >= WW || y >= WH) return C_NONE; const o = y * WW + x, c = cls[o]; return c === C_KANTO ? kmc[o] : c; }
    : (x, y) => (x < 0 || y < 0 || x >= WW || y >= WH ? C_NONE : cls[y * WW + x]);
  const smask = new Uint8Array(N);
  if (stamps.length) for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) smask[y * WW + x] = stampAt(WX0 + x, WY0 + y);
  if (cstamps.length) for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) if (caveCell(WX0 + x, WY0 + y)) smask[y * WW + x] = STAMP_CAVE;
  if (inCorr) for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) if (!smask[y * WW + x] && cls[y * WW + x] !== C_KANTO && inCorr(WX0 + x, WY0 + y)) smask[y * WW + x] = STAMP_CORRIDOR;

  // ---------------------------------------------------------------- ledges (3.6): stony hills only, on grass
  // a ledge runs where a contour of the gentle hill noise crosses between a cell and the one below (taken per
  // 2-cell column pair, so runs are even), with walkable ground above and below and no rock or water around it
  const cand = new Uint8Array(N);
  for (let y = 1; y < WH - 1; y++) {
    for (let x = 0; x < WW; x++) {
      const o = y * WW + x;
      if (sLand[sIdx(x, y)] !== B.STONY_HILLS || cls[o] !== C_GRASS || smask[o]) continue;
      const hx = WX0 + (x & ~1), ay = WY0 + y;
      if (Math.floor(fbm(L.ledge, hx, ay) * 4) === Math.floor(fbm(L.ledge, hx, ay + 1) * 4)) continue;
      cand[o] = 1;
    }
  }
  function ledgeOk(x, y) {
    const o = y * WW + x;
    if (!cand[o]) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const c = cl(x + dx, y + dy);
      if (c === C_ROCK || c === C_NONE || isWaterC(c) || c === C_ICE || c === C_ICEP) return false;
    }
    if (cand[o - WW] || cand[o + WW]) return false;
    const u = cl(x, y - 1), d = cl(x, y + 1);
    return (u === C_GRASS || u === C_TALL) && (d === C_GRASS || d === C_TALL);
  }
  const ledge = new Uint8Array(N);
  for (let y = 2; y < WH - 2; y++) {
    for (let x = 2; x < WW - 2; x++) {
      if (!ledgeOk(x, y)) continue;
      let run = 1;
      for (let k = 1; k <= 2 && ledgeOk(x - k, y); k++) run++;
      for (let k = 1; k <= 2 && ledgeOk(x + k, y); k++) run++;
      if (run >= 3) ledge[y * WW + x] = 1;
    }
  }
  for (let o = 0; o < N; o++) if (ledge[o]) cls[o] = C_LEDGE;

  // ---------------------------------------------------------------- trees (3.8)
  const SPN = ((WW + 1) >> 1) * ((WH + 1) >> 1);
  const slotMemo = new Uint8Array(SPN); // 0 unknown, 1 no, 2 yes
  const SPW = (WW + 1) >> 1;
  const specAt = (x, y) => SPEC_OF[sLand[sIdx(x, y)]];
  const isGrove = (lx, cy) => grove.size > 0 && grove.has((WX0 + lx + 4096) * 8192 + WY0 + cy + 4096);
  const slotSpec = (lx, cy) => (isGrove(lx, cy) ? SPEC_OAK : specAt(lx, cy));
  const varAt = (x, y) => cvar[y * WW + x];
  function slotCompute(lx, cy) {
    // lx, cy: working-grid coordinates (absolute even, WX0 and WY0 are multiples of 4)
    if (lx < 4 || cy < 4 || lx + 6 > WW || cy + 4 > WH) return false;
    const ax = WX0 + lx, ay = WY0 + cy;
    if (isGrove(lx, cy)) return true;
    if ((stamps.length || cstamps.length) && slotStamped(ax, ay)) return false;
    // (6b) no tree in a Kanto opening's corridor
    if (inCorr) for (let dy = -1; dy <= 1; dy++) if (inCorr(ax, ay + dy) || inCorr(ax + 1, ay + dy)) return false;
    const sp = specAt(lx, cy);
    if (!sp) return false;
    const rec = REC[sLand[sIdx(lx, cy)]];
    // groves (3.8): the 1/60 grove noise scales the biome's density from about a fifth (meadows) to nearly solid
    // (FireRed's forests), so a forest is groves of packed trees with clearings and a plain has the odd copse
    let pr = clamp(rec.density * (1 + 2.5 * fbm(L.grove, ax, ay)), 0, 0.95);
    // a Kanto World (6a): oak forest within 24 cells of Kanto's tree walls is at least 0.6 dense (Kanto's oak)
    if (KINF && sp === SPEC_OAK && pr < 0.6 && KINF.tree(ax, ay) < 24) pr = 0.6;
    const roll = rec.cluster ? r01(P.seedTree, ax >> 2, ay >> 2, 7) : r01(P.seedTree, ax, ay);
    if (!(roll < pr)) return false;
    const v = varAt(lx, cy);
    if (v >= 5 && v <= 12) return false;               // never in a transition band
    for (let dy = -1; dy <= 1; dy++) for (let dx = 0; dx < 2; dx++) {
      const c = cls[(cy + dy) * WW + lx + dx];
      if (!(c === C_GRASS || c === C_TALL || (c === C_SNOW && (sp === 6 || sp === 5)) || (c === C_MUD && sp === 9))) return false;
      if (varAt(lx + dx, cy + dy) !== v) return false;
    }
    // no slot within lattice distance 1 of a different species or tint (a gap at species and tint changes)
    for (let dy = -2; dy <= 2; dy += 2) for (let dx = -2; dx <= 2; dx += 2) {
      if (!dx && !dy) continue;
      const nsp = specAt(lx + dx + 1, cy + dy);
      if (nsp && nsp !== sp) return false;
      if (varAt(lx + dx + 1, cy + dy) !== v) return false;
    }
    return true;
  }
  const isSlot = (lx, cy) => {
    if ((lx & 1) || (cy & 1) || lx < 0 || cy < 0 || lx >= WW || cy >= WH) return false;
    const k = (cy >> 1) * SPW + (lx >> 1);
    if (!slotMemo[k]) slotMemo[k] = slotCompute(lx, cy) ? 2 : 1;
    return slotMemo[k] === 2;
  };
  // a Kanto World (6a): Kanto's own tree slots join the lattice (Kanto's lattice is on even x and y too), so a generated
  // forest and Kanto's tree walls are one forest: Kanto's seam cells are re-tiled with it, and the generated cells under a
  // Kanto crown cut off by the void complete it
  // (6b: less the slots a kept opening took off)
  const isSlotU = KK ? (lx, cy) => (isKantoCell(KK, WX0 + lx, WY0 + cy) ? kantoSlotAt(KK, WX0 + lx, WY0 + cy) && !(KOP && kantoGoneAt(KK, WX0 + lx, WY0 + cy)) : isSlot(lx, cy)) : isSlot;
  const FILL_TREE = (t) => t === 20 || t === 21 || t === 28 || t === 29;
  const treeCell = new Uint8Array(N);
  for (let y = 3; y < WH - 3; y++) {
    for (let x = 3; x < WW - 3; x++) {
      const left = (x & 1) === 0, lx = left ? x : x - 1;
      let openC = false;
      if (KK) {
        const c0 = cls[y * WW + x];
        if (c0 === C_KANTO) {
          // only Kanto's zone 1 tree fill within 3 cells of the seam is re-tiled (3.12), and (6b) the trees around a
          // kept opening's cut
          const ax = WX0 + x, ay = WY0 + y;
          openC = KOP && kantoOpenCellAt(KK, ax, ay) && kantoClassAt(KK, ax, ay) === K_TREE;
          if (!openC && (!kantoSeamAt(KK, ax, ay) || kantoClassAt(KK, ax, ay) !== K_TREE || !kgrid || !FILL_TREE(kgrid[(ay - KK.y) * 408 + (ax - KK.x)]))) continue;
        } else if (!(c0 === C_GRASS || c0 === C_TALL)) {
          // a generated cell under a Kanto crown takes it only on grass (generated slots' own footprints are grass)
          if (treeTileFor(isSlot, lx, y, left) < 0) continue;
        }
      }
      const mid = treeTileFor(isSlotU, lx, y, left);
      if (mid < 0) continue;
      const cy = slotRowOf(isSlotU, lx, y);
      const sp = SPECIES_ID[KK && isKantoCell(KK, WX0 + lx, WY0 + cy) ? SPEC_OAK : slotSpec(lx, cy)];
      const o = y * WW + x;
      const spec = T.species[sp];
      const ground = gr[o];
      const homeFam = spec.ground === 'snow' ? T.fam.snow : T.fam.grass;
      // (6b: a Kanto tree around an opening keeps FireRed's own piece, as Classic draws it on any ground)
      tile[o] = openC || homeFam.has(ground) ? spec.home[mid] : spec.ov[mid];
      treeCell[o] = 1;
    }
  }

  // ---------------------------------------------------------------- tiles
  const under = (x, y, outside) => {
    // the ground of the first outside neighbour (N, E, S, W, then the diagonals)
    for (let d8 = 0; d8 < 8; d8++) { const dx = NB8X[d8], dy = NB8Y[d8];
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= WW || yy >= WH) continue;
      const c = cls[yy * WW + xx];
      if (outside(c)) return gr[yy * WW + xx];
    }
    return gr[y * WW + x];
  };
  const quarter = (set, code, x, y, outside, homeFam) => {
    if (code === 0 || !set.ov) return { t: set.home[code], gnd: -1 };
    const u = under(x, y, outside);
    return homeFam.has(u) ? { t: set.home[code], gnd: u } : { t: set.ov[code], gnd: u };
  };
  const rockMask = (x, y) => cl(x, y) === C_ROCK;
  // a Kanto World (6a): Kanto's map edges give the rock mask notches the generated masks never have, where the 5 x 5
  // table can answer a piece FireRed never draws with those sides open (a plain face beside Kanto's trees); then the
  // 3 x 3 answer is taken, as the shape check (checks.js, 4.7 item 2) demands
  const rockSure = (m, x, y, sand) => {
    if (m < 0) return m;
    const open = (rockMask(x, y - 1) ? 0 : 1) | (rockMask(x + 1, y) ? 0 : 2) | (rockMask(x, y + 1) ? 0 : 4) | (rockMask(x - 1, y) ? 0 : 8);
    if (!open || rockSides(T).has(m * 16 + open)) return m;
    const m1 = lookup(T.rock, -1, keyOf3(rockMask, x, y), sand);
    return m1 >= 0 && rockSides(T).has(m1 * 16 + open) ? m1 : m;
  };
  const ledgeMask = (x, y) => cl(x, y) === C_LEDGE;
  const notSea = (x, y) => cl(x, y) !== C_SEA;
  const notOpen = (x, y) => { const c = cl(x, y); return c !== C_SEA && c !== C_FRESH; };
  const waterIn = (x, y) => { const c = cl(x, y); return c === C_SEA || c === C_FRESH || c === C_ICE || c === C_ICEP || c === C_NONE; };
  const outB = (c) => c === C_GRASS || c === C_TALL || c === C_LEDGE || c === C_KANTO || c === C_SNOW || c === C_MUD;
  const outSnow = (c) => c === C_GRASS || c === C_TALL || c === C_LEDGE || c === C_KANTO || c === C_MUD;
  const outMud = (c) => c === C_GRASS || c === C_TALL || c === C_LEDGE || c === C_KANTO;
  const outP = (c) => !(c === C_SEA || c === C_FRESH || c === C_ICE || c === C_ICEP || c === C_NONE);
  const inB = (fn) => (x, y) => { const c = cl(x, y); return c === C_NONE || !fn(c); };
  const inSand = inB(outB), inSnowB = inB(outSnow), inMud = inB(outMud);
  const nearSea = (x, y) => {
    for (let d8 = 0; d8 < 8; d8++) { const dx = NB8X[d8], dy = NB8Y[d8]; if (cl(x + dx, y + dy) === C_SEA) return true; }
    return false;
  };
  const oreAt = new Uint8Array(N);   // 0 none, 1 + kind index into ORE_KINDS
  const face = new Uint8Array(N);    // 1 an interior rock cell (its 3 x 3 all rock), 2 also a pure face (ore-capable)
  const rockMid = new Int16Array(N).fill(-1);
  const styleC = new Uint8Array(N);
  for (let y = 2; y < WH - 2; y++) {
    for (let x = 2; x < WW - 2; x++) {
      const o = y * WW + x, c = cls[o], s = sIdx(x, y);
      if (treeCell[o]) continue;
      let t = gr[o];
      switch (c) {
        case C_SEA: t = T.waterTile; break;
        case C_FRESH: {
          const set = S.P[BANKS[sBank[s]]];
          const q = quarter(set, T.lut[blobBits(waterIn, x, y)], x, y, outP, T.fam.grass);
          t = q.t; if (q.gnd >= 0) gr[o] = q.gnd;
          break;
        }
        case C_ICE: t = S.A.ice.home[T.lut[blobBits(notOpen, x, y)]]; break;
        case C_ICEP: t = S.A.ice_pond.home[T.lut[blobBits(notOpen, x, y)]]; break;
        case C_SAND: {
          if (nearSea(x, y)) t = S.A.sand.home[T.lut[blobBits(notSea, x, y)]];
          else {
            const q = quarter(S.B.sand, T.lut[blobBits(inSand, x, y)], x, y, outB, T.fam.grass);
            t = q.t; if (q.gnd >= 0) gr[o] = q.gnd;
          }
          break;
        }
        case C_SNOW: {
          if (nearSea(x, y)) t = S.A.snow.home[T.lut[blobBits(notSea, x, y)]];
          else {
            const code = T.lut[blobBits(inSnowB, x, y)];
            if (code === 0) t = gr[o];
            else { const q = quarter(S.B.snow, code, x, y, outSnow, T.fam.grass); t = q.t; if (q.gnd >= 0) gr[o] = q.gnd; }
          }
          break;
        }
        case C_MUD: {
          const code = T.lut[blobBits(inMud, x, y)];
          if (code === 0) t = gr[o];
          else { const q = quarter(S.B.mud, code, x, y, outMud, T.fam.grass); t = q.t; if (q.gnd >= 0) gr[o] = q.gnd; }
          break;
        }
        case C_TALL: t = T.ve(cvar[o], 13); break;
        case C_LEDGE: {
          const m = lookup(T.ledge, keyOf5(ledgeMask, x, y), keyOf3(ledgeMask, x, y), false);
          // the overlay off grass, and on grass for a piece FireRed draws over beach sand (px, 3b fix: 151)
          const lp = m < 0 ? null : T.ledge.px.get(m);
          t = m < 0 ? gr[o] : (T.fam.grass.has(gr[o]) && !(lp && lp[1]) ? m : T.ov(0, m) >= 0 ? T.ov(0, m) : m);
          break;
        }
        case C_ROCK: {
          const st = styleAt(x, y);
          styleC[o] = st;
          const sand = sGround[s] === C_SAND;
          let m = rockPick(T.rock, keyOf5(rockMask, x, y), keyOf3(rockMask, x, y), sand);
          if (KK) m = rockSure(m, x, y, sand);
          rockMid[o] = m;
          if (m < 0) { t = gr[o]; break; }
          const v = P.styleVar[st];
          const fam = st === STYLE_BROWN ? T.fam.grass : st === STYLE_GREY ? T.fam.grey : st === STYLE_SNOWY ? T.fam.snow : T.fam.sand;
          const ovE = T.ov(v, m);
          // the overlay when the cell's ground is not the style's own, or when the piece's ground pixels disagree with
          // the ground (a fill pick, or a corner or foot FireRed draws over beach sand: the overlay shows the cell's
          // ground there instead). px, not compat: compat misses the beach sand colours
          const cp = T.rock.px.get(m), clash = !!cp && ((sand && cp[0]) || (!sand && cp[1]));
          t = ovE < 0 || (fam.has(gr[o]) && !clash) ? T.ve(v, m) : ovE;
          let all = true;
          for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (cl(x + dx, y + dy) !== C_ROCK) { all = false; break; }
          if (all) face[o] = P.pureFace[m] ? 2 : 1;
          break;
        }
        case C_KANTO: {
          t = kgrid ? kgrid[(WY0 + y - g.kanto.y) * 408 + (WX0 + x - g.kanto.x)] : 0;
          // (6b) around a kept opening's cut: bare ground on the cut and where no crown is left (the tree pass drew the
          // rest), Kanto's rock re-tiled with the cut out of the mask (as the seam's below)
          if (KOP && kantoOpenCellAt(KK, WX0 + x, WY0 + y)) {
            const kcl = kantoClassAt(KK, WX0 + x, WY0 + y);
            // (a cut cell's ground off FireRed's grass, a town's tile under a wall or the dirt under the rock fill,
            // becomes plain grass: one even path, not stripes of whatever lay under each row)
            if ((kcl === K_TREE || kantoCutAt(KK, WX0 + x, WY0 + y)) && !T.fam.grass.has(gr[o])) gr[o] = 1;
            if (kcl === K_TREE || kantoCutAt(KK, WX0 + x, WY0 + y)) t = gr[o];
            else if (kcl === K_ROCK) {
              if (!T.fam.grass.has(gr[o])) gr[o] = 1;   // (the cut's own plain grass along its new rim)
              const m = rockSure(rockPick(T.rock, keyOf5(rockMask, x, y), keyOf3(rockMask, x, y), false), x, y, false);
              if (m < 0) t = gr[o];
              else {
                const ovE = T.ov(0, m), cp = T.rock.px.get(m), clash = !!cp && cp[1];
                t = ovE < 0 || (T.fam.grass.has(gr[o]) && !clash) ? T.ve(0, m) : ovE;
              }
            }
          } else
          // a Kanto World (6a): Kanto's rock fill within 3 cells of the seam is re-tiled with the generated rock as one
          // mask (one rim, never a double cliff), in General's own brown style
          if (KK && t === 113 && kantoSeamAt(KK, WX0 + x, WY0 + y) && kantoClassAt(KK, WX0 + x, WY0 + y) === K_ROCK) {
            const m = rockSure(rockPick(T.rock, keyOf5(rockMask, x, y), keyOf3(rockMask, x, y), false), x, y, false);
            if (m >= 0) {
              const ovE = T.ov(0, m), cp = T.rock.px.get(m), clash = !!cp && cp[1];
              t = ovE < 0 || (T.fam.grass.has(gr[o]) && !clash) ? T.ve(0, m) : ovE;
            }
          }
          break;
        }
        default: break;
      }
      tile[o] = t;
    }
  }

  // ---------------------------------------------------------------- ores (3.9): veins in pure interior faces
  const regionPair = (ax, ay) => orePair(P, Math.floor(ax / ORE_REGION), Math.floor(ay / ORE_REGION));
  const startKind = (x, y) => {
    // -1, or the ore table index of a vein starting at this cell
    const o = y * WW + x;
    if (face[o] !== 2) return -1;
    const ax = WX0 + x, ay = WY0 + y;
    const pair = regionPair(ax, ay);
    // the guard: every region within reach has the same pair
    if (regionPair(ax - ORE_GUARD_X, ay - ORE_GUARD_Y) !== pair || regionPair(ax + ORE_GUARD_X, ay - ORE_GUARD_Y) !== pair
      || regionPair(ax - ORE_GUARD_X, ay + ORE_GUARD_Y) !== pair || regionPair(ax + ORE_GUARD_X, ay + ORE_GUARD_Y) !== pair) return -1;
    let surface = false;
    for (let dy = -2; dy <= 2 && !surface; dy++) for (let dx = -2; dx <= 2; dx++) if (cl(x + dx, y + dy) !== C_ROCK) { surface = true; break; }
    const band = surface ? 0 : li(lM, x, y) >= th.mCore ? 2 : 1;
    const lb = sLand[sIdx(x, y)];
    const roll = r01(P.seedOre, ax, ay, 3);
    let acc = 0;
    for (const i of [pair >> 3, pair & 7]) {
      const ot = ORE_TABLE[i];
      if (ot.where === 1 && lb !== B.MOUNTAINS && lb !== B.SNOWY_MOUNTAINS) continue;
      if (ot.where === 2 && lb !== B.MOUNTAINS) continue;
      let cov = ot.cov[band];
      if (ot.kind === 'gold_ore' && styleC[o] === STYLE_SANDSTONE) cov *= 2;
      acc += ORE_TUNE * cov / 100 / ORE_PAIR_P[i] / ot.mean;
      if (roll < acc) return i;
    }
    return -1;
  };
  // vein cells: a hashed walk of 2 to 6 steps (mean per kind) from the start, within ORE_REACH
  const veinHas = (sx, sy, i, dx, dy) => {
    const ax = WX0 + sx, ay = WY0 + sy;
    const mean = ORE_TABLE[i].mean;
    const n = Math.max(2, Math.min(6, mean - 1 + (hash32(P.seedOre, ax, ay, 5) % 3)));
    let cx = 0, cy = 0;
    if (dx === 0 && dy === 0) return true;
    for (let k = 1; k < n; k++) {
      const d = DIR8[hash32(P.seedOre, ax, ay, 16 + k) & 7];
      let nx = cx + d[0], ny = cy + d[1];
      if (nx > ORE_REACH || nx < -ORE_REACH || ny > ORE_REACH || ny < -ORE_REACH) { nx = cx - d[0]; ny = cy - d[1]; }
      cx = nx; cy = ny;
      if (cx === dx && cy === dy) return true;
    }
    return false;
  };
  const startMemo = new Int8Array(N).fill(-2);
  const startAt = (x, y) => { const o = y * WW + x; if (startMemo[o] === -2) startMemo[o] = startKind(x, y); return startMemo[o]; };
  for (let y = 4; y < WH - 4; y++) {
    for (let x = 4; x < WW - 4; x++) {
      const o = y * WW + x;
      if (face[o] !== 2) continue;
      let best = -1, bestH = 0;
      for (let dy = -ORE_REACH; dy <= ORE_REACH; dy++) {
        for (let dx = -ORE_REACH; dx <= ORE_REACH; dx++) {
          const sx = x - dx, sy = y - dy;
          const i = startAt(sx, sy);
          if (i < 0 || !veinHas(sx, sy, i, dx, dy)) continue;
          const hh = hash32(P.seedOre, WX0 + sx, WY0 + sy, 9);
          if (best < 0 || hh < bestH) { best = i; bestH = hh; }
        }
      }
      if (best < 0) continue;
      const kind = ORE_TABLE[best].kind;
      const e = T.ores.entry(STYLES[styleC[o]], rockMid[o], kind);
      if (e >= 0) { tile[o] = e; oreAt[o] = 1 + ORE_KINDS.indexOf(kind); }
    }
  }

  // ---------------------------------------------------------------- cave mouths (stage 5b): FireRed's entrance in the hill's rock style
  for (const st of cstamps) {
    const x = st.mx - WX0, y = st.my - WY0;
    if (x < 2 || y < 2 || x >= WW - 2 || y >= WH - 2) continue;
    const o = y * WW + x;
    if (cls[o] === C_ROCK && !treeCell[o]) { tile[o] = T.ve(P.styleVar[styleC[o]], CAVE_MOUTH); oreAt[o] = 0; }
  }

  // ---------------------------------------------------------------- flowers, bushes, boulders, decorations
  const solidD = new Uint8Array(N);   // bushes and boulders (solid tiles drawn on walkable classes)
  for (let y = 4; y < WH - 4; y++) {
    for (let x = 4; x < WW - 4; x++) {
      const o = y * WW + x, c = cls[o];
      if (treeCell[o] || smask[o]) continue;
      const lb = sLand[sIdx(x, y)], rec = REC[lb], ax = WX0 + x, ay = WY0 + y;
      if (c === C_GRASS) {
        if (rec.flowers) {
          // clusters of 3 to 7: one candidate centre per 8 x 8 block
          const bx = ax >> 3, by = ay >> 3;
          if (r01(P.seedDeco, bx, by, 1) < 0.3) {
            const fx = (bx << 3) + 2 + (hash32(P.seedDeco, bx, by, 2) % 4), fy = (by << 3) + 2 + (hash32(P.seedDeco, bx, by, 3) % 4);
            const ddx = ax - fx, ddy = ay - fy;
            if (ddx >= -1 && ddx <= 1 && ddy >= -1 && ddy <= 1 && r01(P.seedDeco, ax, ay, 4) < 0.55) { tile[o] = T.ve(cvar[o], 4); continue; }
          }
          const rr = r01(P.seedDeco, ax, ay, 5);
          if (rr < 0.012) { deco[o] = rr < 0.006 ? D.DANDELION : D.POPPY; continue; }
        }
        if (rec.bush) {
          let byTree = false;
          for (let d4 = 0; d4 < 4; d4++) { const dx = NB4X[d4], dy = NB4Y[d4]; if (treeCell[(y + dy) * WW + x + dx]) { byTree = true; break; } }
          if (byTree && r01(P.seedDeco, ax, ay, 6) < 0.05) { tile[o] = T.ve(cvar[o], 5); solidD[o] = 1; continue; }
        }
        if (rec.boulders && r01(P.seedBoulder, ax, ay) < 0.006) {
          const v = P.styleVar[STYLE_OF[lb]];
          tile[o] = T.ve(v, BOULDERS[hash32(P.seedBoulder, ax, ay, 1) % 3]);
          solidD[o] = 1;
          continue;
        }
        if ((rec.pumpkin || rec.melon) && patchAt(P, ax, ay, 0.02)) { deco[o] = rec.melon ? D.MELON : D.PUMPKIN; continue; }
        if (rec.deadBush && r01(P.seedDeco, ax, ay, 7) < 0.004) { deco[o] = D.DEAD_BUSH; continue; }
      }
      if (c === C_SAND && lb === B.DESERT && tile[o] === 277) {
        // cacti on a 3 x 3 cell lattice (never touching), the top drawn over the plain sand cell above
        // (generator polish: in clumps, where the 1/14 cactus noise is high, and alone elsewhere; dead bushes in
        // patches of the 1/20 bush noise; sandstone boulders strewn round the outcrops, where the outcrop noise is
        // just under the rock's threshold)
        const bx = Math.floor(ax / 3), by = Math.floor(ay / 3);
        if (ax === bx * 3 + 1 && ay === by * 3 + 1 && cls[o - WW] === C_SAND && tile[o - WW] === 277
          && r01(P.seedDeco, bx, by, 8) < 0.07 + 0.55 * clamp((fbm(L.dcactus, ax, ay) - 0.2) * 3, 0, 1)) { deco[o] = D.CACTUS; continue; }
        if (r01(P.seedDeco, ax, ay, 9) < 0.007 + 0.035 * clamp((fbm(L.dbush, ax, ay) - 0.1) * 3, 0, 1)) { deco[o] = D.DEAD_BUSH; continue; }
        const nb = clamp((fbm(L.drock, ax, ay) - DESERT_ROCK + 0.25) * 5, 0, 1);
        if (r01(P.seedBoulder, ax, ay, 2) < 0.002 + 0.025 * nb) {
          const m = BOULDERS[hash32(P.seedBoulder, ax, ay, 3) % 3], v = P.styleVar[STYLE_SANDSTONE];
          tile[o] = T.ov(v, m) >= 0 ? T.ov(v, m) : T.ve(v, m);
          solidD[o] = 1;
          continue;
        }
      }
      if ((c === C_GRASS || c === C_SAND) && li(lt, x, y) > 0.25) {
        // sugar cane beside fresh water (never frozen), in rows along the bank
        let byWater = false;
        for (let d4 = 0; d4 < 4; d4++) { const dx = NB4X[d4], dy = NB4Y[d4]; if (cls[(y + dy) * WW + x + dx] === C_FRESH) { byWater = true; break; } }
        if (byWater && r01(P.seedDeco, ax >> 2, ay >> 2, 10) < 0.35 && r01(P.seedDeco, ax, ay, 11) < 0.7 && tile[o] === gr[o]) { deco[o] = D.SUGAR_CANE; continue; }
      }
      if (c === C_FRESH && lb === B.SWAMP && tile[o] === gr[o] && r01(P.seedDeco, ax, ay, 12) < 0.07) deco[o] = D.LILY_PAD;
    }
  }

  // ---------------------------------------------------------------- desert wells (generator polish)
  // Minecraft's desert well, FireRed sized: a ring of 8 sandstone blocks round one pond water cell (a village well's
  // look, on open sand). One candidate per aligned WELL_BLOCK square (hashed, about half of them), kept only where the
  // 5 x 5 around it is plain desert sand with nothing on it; the 5 x 5 is then cleared. A pure function of the position
  // and the cells within 2 of the candidate, so the seam test holds.
  for (let wy = Math.floor((WY0 + 4) / WELL_BLOCK); wy * WELL_BLOCK < WY0 + WH - 4; wy++) {
    for (let wx = Math.floor((WX0 + 4) / WELL_BLOCK); wx * WELL_BLOCK < WX0 + WW - 4; wx++) {
      if (!(r01(P.seedDeco, wx, wy, 40) < WELL_P)) continue;
      const span = WELL_BLOCK - 16;
      const cx = wx * WELL_BLOCK + 8 + (hash32(P.seedDeco, wx, wy, 41) % span) - WX0, cy = wy * WELL_BLOCK + 8 + (hash32(P.seedDeco, wx, wy, 42) % span) - WY0;
      if (cx < 6 || cy < 6 || cx >= WW - 6 || cy >= WH - 6) continue;
      let ok = true;
      for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) {
        const o = (cy + dy) * WW + cx + dx;
        if (cls[o] !== C_SAND || tile[o] !== 277 || treeCell[o] || solidD[o] || smask[o] || sLand[sIdx(cx + dx, cy + dy)] !== B.DESERT) { ok = false; break; }
      }
      if (!ok) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) deco[(cy + dy) * WW + cx + dx] = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const o = (cy + dy) * WW + cx + dx;
        if (dx || dy) deco[o] = D.SANDSTONE; else tile[o] = T.pondTile;
      }
    }
  }

  // ---------------------------------------------------------------- the stronghold's ruin (stage 6c)
  for (const ru of g.ruins || []) {
    if (ru.x + 3 < WX0 || ru.x - 3 >= WX1 || ru.y + 3 < WY0 || ru.y - 3 >= WY1) continue;
    const ex = ru.x - WX0, ey = ru.y - WY0;
    if (ex >= 0 && ey >= 0 && ex < WW && ey < WH) { const o = ey * WW + ex; tile[o] = RUIN_CLOSED; gr[o] = RUIN_OPEN; deco[o] = 0; }
    for (const [dx, dy] of RUIN_RING) {
      const x = ex + dx, y = ey + dy;
      if (x < 0 || y < 0 || x >= WW || y >= WH) continue;
      const o = y * WW + x;
      if (treeCell[o] || !isLandC(cls[o])) continue;
      tile[o] = gr[o];
      deco[o] = hash32(P.seedDeco, ru.x + dx, ru.y + dy, 30) & 1 ? D.MOSSY_STONE_BRICKS : D.CRACKED_STONE_BRICKS;
    }
  }


  // ---------------------------------------------------------------- villages (stage 7a): the plan's layouts (village.js)
  if (g.plan && g.plan.villages && T.villages) {
    for (const v of g.plan.villages) {
      if (v.x0 >= WX0 + WW || v.x0 + v.w <= WX0 || v.y0 >= WY0 + WH || v.y0 + v.h <= WY0) continue;
      paintVillage(v, T, { X0: WX0, Y0: WY0, W: WW, H: WH }, { tile, gr, deco }, D, blobBits,
        (o) => { if (cls[o] === C_TALL) { cls[o] = C_GRASS; tile[o] = gr[o]; } },
        (o) => (cls[o] === C_SAND ? 'sand' : cls[o] === C_SNOW ? 'snow' : 'grass'));
    }
  }

  // ---------------------------------------------------------------- crop to the region
  const out = {
    x0, y0, w, h, tile: new Uint16Array(w * h), ground: new Uint16Array(w * h), deco: new Uint8Array(w * h), cls: new Uint8Array(w * h),
    biome: new Uint8Array(w * h), land: new Uint8Array(w * h), water: new Uint8Array(w * h),
  };
  const dbg = opts.debug ? { sland: new Uint8Array(w * h), tint: new Uint8Array(w * h), ore: new Uint8Array(w * h), face: new Uint8Array(w * h), tree: new Uint8Array(w * h), style: new Uint8Array(w * h), solid: new Uint8Array(w * h), stamp: new Uint8Array(w * h), slots: [] } : null;
  const ox = x0 - WX0, oy = y0 - WY0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y + oy) * WW + x + ox, k = y * w + x;
      out.tile[k] = tile[o]; out.ground[k] = gr[o]; out.deco[k] = deco[o]; out.cls[k] = cls[o];
      const s = sIdx(x + ox, y + oy), c = cls[o];
      if (c === C_KANTO) { out.biome[k] = B.KANTO; out.land[k] = B.KANTO; out.water[k] = W_NONE; }
      else {
        // the cell's own stage 3a answer decides between the kinds a class allows (deep or shallow sea, river or
        // lake, shore or inland), so those boundaries wander as 3a's do instead of following the super grid
        // (grass, tall grass, ledges and mud are inland whatever 3a says: no need to ask)
        // (a generated cell inside a mostly-Kanto super, 6a, takes its land biome from its own stage 3a answer)
        const inK = sLand[s] === B.KANTO;
        const v3 = !inK && (c === C_GRASS || c === C_TALL || c === C_LEDGE || c === C_MUD) ? 0 : at3(x + ox, y + oy), w3 = v3 >> 16, b3 = v3 & 255;
        const lb = inK ? (v3 >> 8) & 255 : sLand[s];
        let wk = isLandC(c) ? W_NONE : sWk[s] || (isSeaC(c) ? W_OCEAN : W_LAKE);
        if (wk === W_OCEAN || wk === W_DEEP) { if (w3 === W_OCEAN || w3 === W_DEEP) wk = w3; }
        else if (wk === W_RIVER || wk === W_LAKE) { if (w3 === W_RIVER || w3 === W_LAKE) wk = w3; }
        out.land[k] = lb; out.water[k] = wk;
        if (wk === W_DEEP) out.biome[k] = B.DEEP_OCEAN;
        else if (wk === W_OCEAN) out.biome[k] = c === C_ICE || (w3 === W_OCEAN ? b3 === B.FROZEN_OCEAN : pBiome[s] === B.FROZEN_OCEAN) ? B.FROZEN_OCEAN : B.OCEAN;
        else if (wk) out.biome[k] = wk === W_RIVER ? B.RIVER : B.LAKE;
        else if (beachC(c) && (b3 === B.BEACH || b3 === B.SNOWY_BEACH || b3 === B.STONY_SHORE)) out.biome[k] = c === C_SNOW ? B.SNOWY_BEACH : b3 === B.SNOWY_BEACH ? B.BEACH : b3;
        else if (beachC(c) && sBar[s]) out.biome[k] = c === C_SNOW ? B.SNOWY_BEACH : B.BEACH;   // (generator polish: a sand bar)
        else if (c === C_ROCK && b3 === B.STONY_SHORE) out.biome[k] = B.STONY_SHORE;
        else out.biome[k] = lb;
      }
      if (dbg) {
        dbg.sland[k] = sLand[sIdx(x + ox, y + oy)]; dbg.tint[k] = cvar[o]; dbg.ore[k] = oreAt[o]; dbg.face[k] = face[o]; dbg.tree[k] = treeCell[o]; dbg.style[k] = styleC[o];
        dbg.solid[k] = solidD[o]; dbg.stamp[k] = smask[o];
        if (!(x & 1) && !(y & 1) && isSlot(x + ox, y + oy)) dbg.slots.push(x0 + x, y0 + y);
      }
    }
  }
  if (dbg) out.dbg = dbg;
  return out;
}

// every (piece, open sides) pair FireRed draws: some 3 x 3 pattern of the learned rock table with those sides open lists
// that piece (the same set as checks.js builds for 4.7 item 2, cached on the table)
function rockSides(T) {
  if (T.rock.sides) return T.rock.sides;
  const ok = new Set();
  const add = (k, list) => {
    const open = ((k >> 7) & 1 ? 0 : 1) | ((k >> 3) & 1 ? 0 : 2) | ((k >> 1) & 1 ? 0 : 4) | ((k >> 5) & 1 ? 0 : 8);
    for (const c of list) ok.add(c * 16 + open);
  };
  for (const [k, list] of T.rock.r1) add(k, list);
  for (const [kg, list] of T.rock.g1) add(kg >> 1, list);
  T.rock.sides = ok;
  return ok;
}

const BANKS = ['grass', 'sand', 'snow', 'swamp'];
const RV6 = [4, 1, 2, 5, 0, 3];
const BOULDERS = [159, 175, 183];
// (generator polish) the desert's features
const DESERT_ROCK = 0.42;          // the 1/40 desert rock noise over which a desert lattice point is a sandstone outcrop
const DESERT_ROCK_CLEAR = 24;      // cells: no outcrop point this near a plan stamp, cave hill or the ruin
const WELL_BLOCK = 80, WELL_P = 0.5;
const CAVE_MOUTH = 169;   // General's cave entrance (Mt Moon, Rock Tunnel): behaviour 0x60, walkable
const NB4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const NB8 = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];
// (genpolish fixer) the same as flat arrays, for the hot loops (no destructuring per step)
const NB4X = NB4.map((d) => d[0]), NB4Y = NB4.map((d) => d[1]), NB8X = NB8.map((d) => d[0]), NB8Y = NB8.map((d) => d[1]);
const DIR8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function keyOf5(m, x, y) {
  let b = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) b = b * 2 + (m(x + dx, y + dy) ? 1 : 0);
  return b;
}
function keyOf3(m, x, y) {
  let b = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) b = b * 2 + (m(x + dx, y + dy) ? 1 : 0);
  return b;
}

// a rare patch of 2 to 5 fruits: one candidate centre per 16 x 16 block, cells within 1 of it
function patchAt(P, ax, ay, p) {
  const bx = ax >> 4, by = ay >> 4;
  if (!(r01(P.seedDeco, bx, by, 20) < p)) return false;
  const fx = (bx << 4) + 3 + (hash32(P.seedDeco, bx, by, 21) % 10), fy = (by << 4) + 3 + (hash32(P.seedDeco, bx, by, 22) % 10);
  const dx = ax - fx, dy = ay - fy;
  return dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1 && r01(P.seedDeco, ax, ay, 23) < 0.45;
}

// A stable hash of a painted region's outputs (FNV-1a over every output array), as 8 hex digits.
export function hashPainted(p) {
  let hh = 0x811c9dc5;
  for (const arr of [p.tile, p.ground, p.deco, p.cls, p.biome, p.land, p.water]) {
    for (let i = 0; i < arr.length; i++) { const v = arr[i]; hh ^= v & 255; hh = Math.imul(hh, 16777619); hh ^= v >> 8; hh = Math.imul(hh, 16777619); }
  }
  return (hh >>> 0).toString(16).padStart(8, '0');
}
