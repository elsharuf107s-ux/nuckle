// The biome table (design 3.3): ids, records, the climate classification of a lattice point, the 3 x 3
// majority smoothing and the tint hub rule. Ids are part of GEN_VERSION's output: never renumber, only append.
//
// Tints: grass is temperate, cool, dry, lush or swamp, and only temperate may touch the other four (the hub
// rule), so every tint change is a temperate gradient band (3.7). Water has no tint.

export const T_NONE = 0, T_TEMPERATE = 1, T_COOL = 2, T_DRY = 3, T_LUSH = 4, T_SWAMP = 5;
export const TINT_NAMES = ['none', 'temperate', 'cool', 'dry', 'lush', 'swamp'];

// id, key, display name (FireRed banner, no em dashes), tint, kind, overview colour
const ROWS = [
  [0, 'NONE', '', T_NONE, 'none', [0, 0, 0]],
  [1, 'PLAINS', 'PLAINS', T_TEMPERATE, 'land', [128, 200, 110]],
  [2, 'FOREST', 'FOREST', T_TEMPERATE, 'land', [52, 140, 60]],
  [3, 'BIRCH_FOREST', 'BIRCH FOREST', T_TEMPERATE, 'land', [150, 196, 92]],
  [4, 'DARK_FOREST', 'DARK FOREST', T_TEMPERATE, 'land', [30, 84, 36]],
  [5, 'TAIGA', 'TAIGA', T_COOL, 'land', [60, 120, 100]],
  [6, 'SNOWY_TAIGA', 'SNOWY TAIGA', T_COOL, 'land', [190, 214, 220]],
  [7, 'SNOWY_PLAINS', 'SNOWY PLAINS', T_COOL, 'land', [240, 244, 250]],
  [8, 'DESERT', 'DESERT', T_DRY, 'land', [232, 200, 120]],
  [9, 'SAVANNA', 'SAVANNA', T_DRY, 'land', [190, 178, 84]],
  [10, 'SWAMP', 'SWAMP', T_SWAMP, 'land', [84, 104, 64]],
  [11, 'JUNGLE', 'JUNGLE', T_LUSH, 'land', [40, 170, 40]],
  [12, 'BEACH', 'BEACH', T_TEMPERATE, 'shore', [236, 222, 150]],
  [13, 'SNOWY_BEACH', 'SNOWY BEACH', T_COOL, 'shore', [214, 222, 232]],
  [14, 'STONY_SHORE', 'STONY SHORE', T_TEMPERATE, 'shore', [120, 120, 120]],
  [15, 'OCEAN', 'OCEAN', T_NONE, 'water', [48, 96, 190]],
  [16, 'FROZEN_OCEAN', 'FROZEN OCEAN', T_NONE, 'water', [112, 150, 214]],
  [17, 'DEEP_OCEAN', 'DEEP OCEAN', T_NONE, 'water', [24, 52, 120]],
  [18, 'RIVER', 'RIVER', T_NONE, 'water', [70, 140, 230]],
  [19, 'LAKE', 'LAKE', T_NONE, 'water', [60, 120, 220]],
  [20, 'STONY_HILLS', 'STONY HILLS', T_TEMPERATE, 'rock', [150, 150, 140]],
  [21, 'MOUNTAINS', 'MOUNTAINS', T_TEMPERATE, 'rock', [130, 110, 100]],
  [22, 'SNOWY_MOUNTAINS', 'SNOWY MOUNTAINS', T_COOL, 'rock', [200, 206, 222]],
  [23, 'KANTO', 'KANTO', T_TEMPERATE, 'kanto', [250, 120, 160]],
];

export const BIOMES = Object.freeze(ROWS.map(([id, key, name, tint, kind, rgb]) => Object.freeze({ id, key, name, tint, kind, rgb })));
export const B = Object.freeze(Object.fromEntries(BIOMES.map((b) => [b.key, b.id])));
export const NB = BIOMES.length;
export const TINT_OF = Uint8Array.from(BIOMES, (b) => b.tint);

// Friendly biomes (the spec's spawn biomes, 3.14 adds birch forest) and the land biomes every world should have.
export const FRIENDLY = Object.freeze([B.PLAINS, B.FOREST, B.BIRCH_FOREST, B.TAIGA]);
export const LAND_BIOMES = Object.freeze([B.PLAINS, B.FOREST, B.BIRCH_FOREST, B.DARK_FOREST, B.TAIGA, B.SNOWY_TAIGA,
  B.SNOWY_PLAINS, B.DESERT, B.SAVANNA, B.SWAMP, B.JUNGLE, B.STONY_HILLS, B.MOUNTAINS, B.SNOWY_MOUNTAINS]);
export const SNOWY = Object.freeze([B.SNOWY_TAIGA, B.SNOWY_PLAINS, B.SNOWY_MOUNTAINS]);
const IS_SNOWY = new Uint8Array(NB); for (const b of SNOWY) IS_SNOWY[b] = 1;
const IS_ROCK = new Uint8Array(NB); for (const b of BIOMES) if (b.kind === 'rock') IS_ROCK[b.id] = 1;
export const isSnowy = (b) => IS_SNOWY[b] === 1;
export const isRock = (b) => IS_ROCK[b] === 1;

// The climate classification of one lattice point (3.3, the land rows): t and h are quantile ranks over land
// in 0..1, rock says M is over the rock quantile, mount that it is over the mountain quantile.
export function classify(t, h, rock, mount) {
  if (rock) return t < 0.25 ? B.SNOWY_MOUNTAINS : mount ? B.MOUNTAINS : B.STONY_HILLS;
  if (t < 0.18) return h > 0.5 ? B.SNOWY_TAIGA : B.SNOWY_PLAINS;
  if (t < 0.40) return h > 0.45 ? B.TAIGA : B.PLAINS;
  if (t < 0.76) return h < 0.25 ? B.PLAINS : h < 0.50 ? B.FOREST : h < 0.75 ? B.BIRCH_FOREST : B.DARK_FOREST;
  return h < 0.35 ? B.DESERT : h < 0.60 ? B.SAVANNA : h < 0.80 ? B.SWAMP : B.JUNGLE;
}

// One 3 x 3 majority pass over a lattice window (w x h, row-major). The most frequent biome of the 9 wins;
// the centre keeps its biome when it ties for the most, otherwise the lowest id among the tied wins. Points on
// the window's edge are copied (they lie in the apron and are never used).
export function majority(src, w, h) {
  const out = new Uint8Array(src.length);
  const cnt = new Uint8Array(NB);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { out[i] = src[i]; continue; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cnt[src[i + dy * w + dx]]++;
      const c = src[i];
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const k = cnt[src[i + dy * w + dx]]; if (k > m) m = k; }
      let best = c;
      if (cnt[c] !== m) {
        best = 255;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) { const b = src[i + dy * w + dx]; if (cnt[b] === m && b < best) best = b; }
        }
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cnt[src[i + dy * w + dx]] = 0;
      out[i] = best;
    }
  }
  return out;
}

// majority() at one point of a field f(x, y) (the same rule, for the painter's lazy biome field, patches.js)
const CNT1 = new Uint8Array(NB);
export function majorityAt(f, x, y) {
  const v = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v.push(f(x + dx, y + dy));
  for (const b of v) CNT1[b]++;
  const c = v[4];
  let m = 0;
  for (const b of v) if (CNT1[b] > m) m = CNT1[b];
  let best = c;
  if (CNT1[c] !== m) { best = 255; for (const b of v) if (CNT1[b] === m && b < best) best = b; }
  for (const b of v) CNT1[b] = 0;
  return best;
}

// The tint hub rule, as a pure filter of radius HUB_R lattice points (so a chunk computes it from its apron
// alone and the result never depends on which chunk asked). A point whose tint is not temperate becomes the
// temperate biome for its humidity (PLAINS when h < 0.5, else FOREST) when a point of another non-temperate tint
// with a higher priority lies within HUB_R points (Chebyshev) in the smoothed map. So two different
// non-temperate tints that survive are always more than HUB_R points apart: they never touch.
// Priority: swamp, then lush (jungle), then dry, then cool (the rarest bands keep their ground).
export const HUB_R = 4;
const PRIO = [0, 0, 1, 2, 3, 4]; // by tint: none, temperate, cool, dry, lush, swamp
export function hubRule(src, hrank, w, h, r = HUB_R) {
  const out = Uint8Array.from(src);
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const i = y * w + x, tn = TINT_OF[src[i]];
      if (tn <= T_TEMPERATE) continue;
      const pr = PRIO[tn];
      let hit = false;
      for (let dy = -r; dy <= r && !hit; dy++) {
        const row = i + dy * w;
        for (let dx = -r; dx <= r; dx++) {
          const tq = TINT_OF[src[row + dx]];
          if (tq > T_TEMPERATE && tq !== tn && PRIO[tq] > pr) { hit = true; break; }
        }
      }
      if (hit) out[i] = hrank[i] < 0.5 ? B.PLAINS : B.FOREST;
    }
  }
  return out;
}
