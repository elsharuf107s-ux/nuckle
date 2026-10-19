// The tree lattice (design 3.8) and FireRed's tree tile rule, ported once from world.js treeTileFor so the generator
// and the game agree. A slot is a crown's left cell (lx, cy); slots sit on even columns and even rows (Kanto's own
// forests: 7,545 slots, 99.4% of them on even x and even y), so a dense forest is a grid of 2 x 2 crowns stacked
// every 2 rows with the overlap pieces between them. A tree covers (lx..lx + 1, cy - 1..cy + 1).
//
//   treeTileFor(s, lx, y, left)  the General mid of the cell (lx, y) (left column) or (lx + 1, y), or -1 for none;
//                                s(a, b) says whether (a, b) is a slot
//   slotOf(s, lx, y, mid)        the slot (as cy) the piece at (lx, y) belongs to

export const LATTICE_MIDS = Object.freeze([14, 15, 20, 21, 22, 23, 28, 29, 30, 31, 36, 37, 38, 39]);

export function treeTileFor(s, lx, y, left) {
  if (s(lx, y)) return left ? (s(lx - 2, y) ? 28 : 30) : (s(lx + 2, y) ? 29 : 31);
  const above = s(lx, y - 1), below = s(lx, y + 1);
  if (above && below) return left ? (s(lx - 2, y - 1) && s(lx - 2, y + 1) ? 20 : 22) : (s(lx + 2, y - 1) && s(lx + 2, y + 1) ? 21 : 23);
  if (above) return left ? (s(lx - 2, y - 1) ? 36 : 38) : (s(lx + 2, y - 1) ? 37 : 39);
  if (below) return left ? 14 : 15;
  return -1;
}

// the row of the slot a piece belongs to (overlap pieces belong to both: the one above is returned)
export function slotRowOf(s, lx, y) {
  if (s(lx, y)) return y;
  if (s(lx, y - 1)) return y - 1;
  if (s(lx, y + 1)) return y + 1;
  return null;
}
