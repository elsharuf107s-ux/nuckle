// Painters shared by the generator and (from stage 4a) world.js (design 3.6, 4.2): the learned 5 x 5 / 3 x 3 lookup
// of FireRed's rock and ledge pieces, and the quarter-tile blob codes. Pure functions of their inputs.
//
// lookup() mirrors tools/build_terrain.py `lookup` (classic=False) exactly: 5 x 5 with the ground context, 5 x 5,
// 3 x 3 with the context, 3 x 3, then the nearest learned 3 x 3 (`fill`). A candidate whose ground pixels disagree
// with the context ('g' grass, 's' sand) is skipped while another remains; if every candidate is skipped and the
// fill has none, the first skipped one is returned. -1 only if the tables have nothing at all (a miss).
// Classic's world.reedgeCliffs keeps its own loop (no fill, no fallback) until a stage switches it over behind
// world.layout.gen (stage 2a's note: lookup_parity.mjs guards Classic).

// the membership key of a cell: (2r + 1)^2 bits, row-major, from `inMask(x, y)` (the caller clamps)
export function keyOf(inMask, x, y, r) {
  let bits = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) bits = bits * 2 + (inMask(x + dx, y + dy) ? 1 : 0);
  return bits;
}

const ok = (L, c, s) => {
  const cp = L.compat.get(c);
  return !(cp && ((s && cp[0]) || (!s && cp[1])));
};

// L: a prepared learned table (terrain.js learnedMaps); k2, k1: the 5 x 5 and 3 x 3 keys; sand: the context is 's'
export function lookup(L, k2, k1, sand) {
  let first = -1;
  const g = sand ? 1 : 0;
  const lists = [L.g2.get(k2 * 2 + g), L.r2.get(k2), L.g1.get(k1 * 2 + g), L.r1.get(k1)];
  for (let i = 0; i < 4; i++) {
    const cands = lists[i];
    if (!cands) continue;
    for (let j = 0; j < cands.length; j++) {
      const c = cands[j];
      if (first < 0) first = c;
      if (ok(L, c, sand)) return c;
    }
  }
  const f = L.fill.get(k1);
  if (f && f.length) return f[0];
  return first;
}

// The quarter-tile blob code of a cell (4.2): neighbour bits N 1, E 2, S 4, W 8, NE 16, SE 32, SW 64, NW 128, set
// when that neighbour is inside the blob; terrain.json's `lut` maps the 256 patterns to the 47 codes (0 = all inside).
export function blobBits(inside, x, y) {
  return (inside(x, y - 1) ? 1 : 0) | (inside(x + 1, y) ? 2 : 0) | (inside(x, y + 1) ? 4 : 0) | (inside(x - 1, y) ? 8 : 0)
    | (inside(x + 1, y - 1) ? 16 : 0) | (inside(x + 1, y + 1) ? 32 : 0) | (inside(x - 1, y + 1) ? 64 : 0) | (inside(x - 1, y - 1) ? 128 : 0);
}

// The generator's rock pick (stage 3b): a cell whose 3 x 3 is all rock takes the 3 x 3 pick (the plain face); the
// 5 x 5 tables would draw FireRed's terrace lines inside a mass from its concave corners, and a generated mountain
// has one rim (3.6). Every other cell takes lookup(). World.js's re-edging of generated rock (stage 4a) uses this.
export function rockPick(L, k2, k1, sand) {
  return k1 === 511 ? lookup(L, -1, k1, sand) : lookup(L, k2, k1, sand);
}
