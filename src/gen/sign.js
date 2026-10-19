// The Kanto signpost (minimap design, Track SIGN, sections 2.2, 2.3 and 2.8): in a Kanto World, a wooden route sign one
// cell from where Steve first appears, its arrow pointing the way into Kanto. Pure (design 3.0): computed in the worker
// right after makePlan from the same modules and the same painted cells as the chunks, so it is a function of the
// world's type and seed alone, and it is not part of the plan's hashed JSON (the generator's goldens and the co-op
// probe's plan hash are unchanged). The main thread writes the sign tile into the chunk's result before
// world.applyChunk stores it (src/kantosign.js).
//
//   kantoSigns(g, plan)  ->  null (not a Kanto World) or
//     { v: 1, target: { x, y, kind: 'opening' | 'edge', id }, signs: [{ x, y, dir, kind: 'spawn', steps },
//       { x, y, dir, kind: 'gate', id }], warn: [] }                   (plane cells; dir 0 N, 1 NE ... 7 NW)
//   sector8(dx, dy)      the 8-direction sector of a bearing (north is dy < 0); src/mapcore.js keeps a copy
//   coarseCode(cm)       the plan's coarse grid as one byte per point for the minimap (255 sea, 254 rock, 253 fresh
//                        water, else the biome id)
import { OX, BORDER } from './plan.js';
import { paintRegion, D, C_GRASS, C_SAND, C_SNOW, C_MUD } from './chunk.js';
import { isKantoCell, K_WALK, K_OTHER, K_SEA } from './kanto.js';
import { fbm, clamp } from './noise.js';
import { byScoreThenId } from './order.js';
import { B, NB } from './biomes.js';

export const SIGN_V = 1;
const WIN = 24, HALF = 12;
// where the spawn sign may stand, relative to the spawn, in this order (2.2 step 4): directly south first, so Steve
// faces it as the world opens
export const SPAWN_CANDS = Object.freeze([[0, 1], [-1, 1], [1, 1], [-1, 0], [1, 0], [0, 2], [-2, 1], [2, 1], [-1, 2], [1, 2],
  [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1], [0, -2]]);

// The sector of the bearing (dx, dy) in plane cells, y growing downward on screen: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW,
// 6 W, 7 NW. tan(22.5 degrees) is sqrt(2) - 1 (sqrt is correctly rounded everywhere, so every browser agrees).
export function sector8(dx, dy) {
  const t = Math.SQRT2 - 1, ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
  if (ay <= ax * t) return dx > 0 ? 2 : 6;
  if (ax <= ay * t) return dy < 0 ? 0 : 4;
  if (dx > 0) return dy < 0 ? 1 : 3;
  return dy > 0 ? 5 : 7;
}

// steps rounded to tens (the lint bans Math.round), at least 10
export const roundSteps = (d) => Math.max(10, Math.floor(d / 10 + 0.5) * 10);

export function coarseCode(cm) {
  const N = cm.n * cm.n, code = new Uint8Array(N);
  for (let q = 0; q < N; q++) code[q] = cm.sea[q] ? 255 : cm.rock[q] ? 254 : cm.wet[q] ? 253 : cm.bio[q];
  return { n: cm.n, st: cm.st, code };
}

// The cells of a 24 x 24 painted window (x0, y0 overworld-local) that may hold a sign, and those Steve walks on.
// walk: the spawn's final test's rule (plan.js finalTest): class grass, sand, snow or mud; no tree, no solid
// decoration; no decoration but a dandelion or a poppy; an entry Steve walks on. hold (2.2 step 3): walk, no decoration
// at all, not tall grass, not a ledge, the cell's tile is its own ground (plain ground: no flower tile, path or edge
// piece the sign would hide, and a blast that breaks the sign leaves exactly what was there), no top piece in the cell
// above (a blast that breaks the sign would take it too) and no decoration in the cell below (a cactus draws its top
// over the sign). FireRed's own entries (below genBase: plain grass and sand) are known here only by kantoMat's class
// and walk bit.
function cellTests(g, p, x0, y0) {
  const T = g.terrain, gb = T.genBase, km = g.kantoMat, N = WIN * WIN;
  const walk = new Uint8Array(N), hold = new Uint8Array(N);
  const ent = (t) => (t >= gb ? T.entries[t - gb] : null);
  for (let k = 0; k < N; k++) {
    const c = p.cls[k], t = p.tile[k], d = p.deco[k];
    if (!(c === C_GRASS || c === C_SAND || c === C_SNOW || c === C_MUD)) continue;
    if (p.dbg.tree[k] || p.dbg.solid[k]) continue;
    if (d && d !== D.DANDELION && d !== D.POPPY) continue;
    const e = ent(t);
    if (e ? e[3] !== 0 : km && !(km[t] & K_WALK)) continue;
    if (isKantoCell(g.kanto, x0 + (k % WIN), y0 + Math.floor(k / WIN))) continue;
    walk[k] = 1;
  }
  for (let k = 0; k < N; k++) {
    if (!walk[k] || p.deco[k]) continue;
    const t = p.tile[k], e = ent(t), x = k % WIN, y = (k - x) / WIN;
    if (t !== p.ground[k]) continue;
    if (e && (e[2] === 0x02 || (e[2] >= 0x38 && e[2] <= 0x3b) || e[4] === 'tallgrass' || e[4] === 'ledge')) continue;
    if (y === 0 || y === WIN - 1) continue;
    // the cell above: a generated entry without a top piece, or one of FireRed's own that a broken sign never takes
    // with it (plain ground, a tree, water or rock, or a solid tile: world.breakTile)
    const ut = p.tile[k - WIN], up = ent(ut);
    if (!(up ? up[6] === 0 : ut === p.ground[k - WIN] || !km || (km[ut] & 7) !== K_OTHER || !(km[ut] & K_WALK))) continue;
    if (p.deco[k + WIN]) continue;
    hold[k] = 1;
  }
  return { walk, hold };
}

// the window cells reachable from (sx, sy) over walk (4-connected), with `block` (a window index, or -1) solid
function reach(walk, sk, block) {
  const seen = new Uint8Array(WIN * WIN), q = [sk];
  seen[sk] = 1;
  for (let h = 0; h < q.length; h++) {
    const k = q[h], x = k % WIN, y = (k - x) / WIN;
    const nb = [y > 0 ? k - WIN : -1, x < WIN - 1 ? k + 1 : -1, y < WIN - 1 ? k + WIN : -1, x > 0 ? k - 1 : -1];
    for (const r of nb) if (r >= 0 && r !== block && walk[r] && !seen[r]) { seen[r] = 1; q.push(r); }
  }
  return seen;
}

// The first candidate (dx, dy from the window's anchor cell) that passes the cell tests and cuts no path: every window
// cell reachable from the anchor before stays reachable with the sign standing there (2.2 step 5).
function placeIn(g, ax, ay, cands, extra) {
  const x0 = ax - HALF, y0 = ay - HALF;
  const p = paintRegion(g, x0, y0, WIN, WIN, { debug: true });
  const { walk, hold } = cellTests(g, p, x0, y0);
  const sk = HALF * WIN + HALF;
  const before = walk[sk] ? reach(walk, sk, -1) : null;
  for (const [dx, dy] of cands) {
    const lx = HALF + dx, ly = HALF + dy;
    if (lx < 1 || ly < 1 || lx >= WIN - 1 || ly >= WIN - 1 || (dx === 0 && dy === 0)) continue;
    const k = ly * WIN + lx;
    if (!hold[k] || (extra && !extra(x0 + lx, y0 + ly))) continue;
    if (before) {
      const after = reach(walk, sk, k);
      let cut = false;
      for (let r = 0; r < WIN * WIN; r++) if (before[r] && r !== k && !after[r]) { cut = true; break; }
      if (cut) continue;
    }
    return { x: x0 + lx, y: y0 + ly };
  }
  return null;
}

// whether a coarse point lies on a mountain pass (the painter's passAt, widened), memoised per point
export const PASS_WIDEN = 6;
export function passCheck(g, cm) {
  const L = g.paint && g.paint.L, n = cm.n, st = cm.st, memo = new Int8Array(n * n);
  if (!L) return () => false;
  return (q) => {
    if (memo[q]) return memo[q] > 0;
    const px = (q % n) * st, py = Math.floor(q / n) * st;
    const v = fbm(L.pass, px, py);
    const gx = (fbm(L.pass, px + 4, py) - fbm(L.pass, px - 4, py)) / 8, gy = (fbm(L.pass, px, py + 4) - fbm(L.pass, px, py - 4)) / 8;
    const gm = Math.sqrt(gx * gx + gy * gy) + 1e-9, hw = 3 + 2 * clamp(fbm(L.passw, px, py) + 0.5, 0, 1);
    const on = (v < 0 ? -v : v) / gm < hw + PASS_WIDEN;
    memo[q] = on ? 1 : -1;
    return on;
  };
}

// What Steve can do on a cell, by the game's own movement rules (world.js solid, isWater, jumpDir; player.js tryStep;
// the decorations' blocks, world.js DECO_WALK and farmland's flush look): per tile, 0 blocked, 1 dry land (ice
// included), 2 water, 4 + d a ledge he jumps toward d (0 north, 1 east, 2 south, 3 west); a decoration outside
// WALK_DECO blocks the cell. FireRed's own entries (below genBase) by kantoMat's walk bit and class.
const WATER_BEH = new Set([0x10, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x19, 0x1A, 0x1B]);   // (world.js WATER)
const JUMP_BEH = [0x3A, 0x38, 0x3B, 0x39];                                                // (world.js MB.JUMP)
const WALK_DECO = new Set([0, D.DANDELION, D.POPPY, D.SUGAR_CANE, D.DEAD_BUSH, D.LILY_PAD, D.TORCH, D.FARMLAND]);
function moveKinds(g) {
  const T = g.terrain, gb = T.genBase, km = g.kantoMat, mk = new Uint8Array(gb + T.entries.length);
  for (let t = 0; t < mk.length; t++) {
    if (t >= gb) {
      const e = T.entries[t - gb], j = JUMP_BEH.indexOf(e[2]);
      mk[t] = j >= 0 ? 4 + j : e[3] !== 0 ? 0 : WATER_BEH.has(e[2]) ? 2 : 1;
    } else if (km) mk[t] = !(km[t] & K_WALK) ? 0 : (km[t] & 7) === K_SEA ? 2 : 1;
  }
  return mk;
}

// Whether an opening's mouth opens onto the wider land (as built, and fixed after review): the corridor the painter
// cuts is clear, but where it ends in a forest or among rocks the trees are not cleared, and many kept outward
// openings lead into a closed pocket (on dry land, 258 of the 644 on seeds 1 to 80: up to 7,380 cells, reaching at
// most 64 cells farther from Kanto's box than the corridor is long; the strip between Kanto's west side and the
// world's border holds long thin ones). A best-first walk backward from the out cell over the painted chunks (4
// neighbours; dry land Steve walks on, and a ledge crossed the way he would jump it toward the opening; no water, no
// Kanto cell; the cell farthest from Kanto's box first, then the lower cell index) must get MOUTH_BEYOND cells
// farther from Kanto's box than the corridor is long (twice the deepest pocket seen; a pocket in the west strip is
// never farther from the box than the strip is wide) or see MOUTH_CAP cells (four times the largest), else the mouth
// is closed. Dry land only (the sign points the way on foot, so a mouth that opens only across water is closed too),
// unless `swim` (findTarget's second try when no mouth opens on foot): then water passes too, and the walk must still
// end on dry land. `paint` is a per-world cache of painted chunks, `mk` moveKinds(g).
export const MOUTH_BEYOND = 128, MOUTH_CAP = 30000;
const DX4 = [0, 1, 0, -1], DY4 = [-1, 0, 1, 0];
function mouthOpen(g, o, paint, mk, swim) {
  const k = g.kanto, ox = o.out[0], oy = o.out[1], goal = (o.n[0] === 0 ? o.corr[3] : o.corr[2]) + MOUTH_BEYOND;
  const chunk = (x, y) => {
    const ck = (y >> 5) * 64 + (x >> 5);
    let c = paint.get(ck);
    if (!c) { c = paintRegion(g, x & ~31, y & ~31, 32, 32); paint.set(ck, c); }
    return c;
  };
  const kind = (x, y) => {
    if (x < BORDER.x0 || y < BORDER.y0 || x > BORDER.x1 || y > BORDER.y1 || isKantoCell(k, x, y)) return 0;
    const c = chunk(x, y), i = (y & 31) * 32 + (x & 31);
    return WALK_DECO.has(c.deco[i]) ? mk[c.tile[i]] : 0;
  };
  // the Chebyshev distance from Kanto's box
  const far = (x, y) => {
    const dx = x < k.x ? k.x - x : x >= k.x + k.w ? x - (k.x + k.w - 1) : 0, dy = y < k.y ? k.y - y : y >= k.y + k.h ? y - (k.y + k.h - 1) : 0;
    return dx > dy ? dx : dy;
  };
  // a binary heap of [-far, cell] (the least first: farthest from Kanto first, then the lower cell index)
  const heap = [], seen = new Set();
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (!less(heap[i], heap[q])) break; const t = heap[q]; heap[q] = heap[i]; heap[i] = t; i = q; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const a = 2 * i + 1, b = a + 1;
        let m = i;
        if (a < heap.length && less(heap[a], heap[m])) m = a;
        if (b < heap.length && less(heap[b], heap[m])) m = b;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
      }
    }
    return top;
  };
  const key = (x, y) => y * 2048 + x;
  seen.add(key(ox, oy));
  push([-far(ox, oy), key(ox, oy)]);
  while (heap.length) {
    const [, c] = pop(), x = c % 2048, y = (c - x) / 2048;
    for (let d = 0; d < 4; d++) {
      let xx = x + DX4[d], yy = y + DY4[d], w = kind(xx, yy);
      // backward over a ledge: Steve jumps it from the far side, so its jump direction is the opposite of d
      if (w >= 4) {
        if (((w - 2) & 3) !== d) continue;
        xx += DX4[d]; yy += DY4[d]; w = kind(xx, yy);
      }
      if (w !== 1 && !(swim && w === 2)) continue;
      const kk = key(xx, yy);
      if (seen.has(kk)) continue;
      seen.add(kk);
      const f = far(xx, yy);
      if (w === 1 && f >= goal) return true;
      push([-f, kk]);
    }
    if (seen.size > MOUTH_CAP) return true;
  }
  return false;
}

// The coarse walk's step weights by biome (fixed after review), in quarters of a step on open land: a forest's 1.5
// (a birch forest's 1.25, a dark forest's or a jungle's 2), and WET_STEP times that by fresh water. Chosen against
// the shortest walks on land over the painted chunks (55 seeds: the sign's opening is the nearest on foot on 42, its
// walk at most 1.62 times the nearest's, median 1.00; without the forest weights 34).
export const WET_STEP = 4;
const STEP_W = (() => {
  const w = new Uint8Array(NB).fill(4);
  w[B.FOREST] = 6; w[B.BIRCH_FOREST] = 5; w[B.DARK_FOREST] = 8; w[B.TAIGA] = 6; w[B.SNOWY_TAIGA] = 6; w[B.SWAMP] = 6; w[B.JUNGLE] = 8;
  return w;
})();

// The target (2.3): the nearest kept outward opening by land: a search over the plan's coarse grid from the sign's
// coarse point with openingReach's passability (no sea, no Kanto, rock only inside a corridor grown by 8) plus the
// painter's mountain passes, 8 neighbours in a fixed order, its steps weighted by STEP_W; the openings by their walk
// (to the grown corridor, then on to the out cell), cheapest first, the lowest id on a tie; the first whose mouth
// opens onto dry land (mouthOpen) wins, else the first whose mouth opens across water. Its `out` cell (the first
// generated cell outside the cut) and `walk`, the walk's length in cells. Fallback (no coarse way to any opening, or
// no mouth open even across water): Kanto's nearest coarse point.
function findTarget(g, plan, sx, sy, usePasses = true, useMouths = true) {
  const cm = plan.cm, n = cm.n, st = cm.st, N = n * n, j = plan.json;
  const outer = (j.openings || []).filter((o) => o.kind === 'outer');
  const inC = new Uint8Array(N);
  for (const o of outer) {
    const x0 = o.corr[0] - 8, y0 = o.corr[1] - 8, x1 = o.corr[0] + o.corr[2] + 8, y1 = o.corr[1] + o.corr[3] + 8;
    for (let jj = Math.max(0, -Math.floor(-y0 / st)); jj < n && jj * st < y1; jj++) {
      for (let i = Math.max(0, -Math.floor(-x0 / st)); i < n && i * st < x1; i++) {
        inC[jj * n + i] = 1;
      }
    }
  }
  // (as built) a coarse rock point also passes on one of the painter's mountain passes (chunk.js passAt: no rock within
  // 3 to 5 cells of the 1/90 pass noise's zero contour), widened by 6 cells so the pass stays connected between the
  // coarse points: rock masses are crossed where the chunks cross them, and the target is the nearest way in on foot
  const passes = usePasses ? passCheck(g, cm) : () => false;
  const pass = (q) => !cm.sea[q] && !cm.kan[q] && (!cm.rock[q] || inC[q] === 1 || passes(q));
  const cl = (v) => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);
  const ci = cl(Math.floor((sx + 4) / st)), cj = cl(Math.floor((sy + 4) / st));
  let start = cj * n + ci;
  if (!pass(start)) {
    // the start fallback: the first passable point of the 5 x 5 coarse square around it, ring by ring
    start = -1;
    for (let r = 1; r <= 2 && start < 0; r++) {
      for (let dj = -r; dj <= r && start < 0; dj++) {
        for (let di = -r; di <= r; di++) {
          if ((dj < 0 ? -dj : dj) !== r && (di < 0 ? -di : di) !== r) continue;
          const i = ci + di, jj = cj + dj;
          if (i < 0 || jj < 0 || i >= n || jj >= n || !pass(jj * n + i)) continue;
          start = jj * n + i; break;
        }
      }
    }
  }
  // (as built) the walk's length, not the first corridor point met: a Dijkstra over the coarse grid with a step's cost
  // its cells walked on the grid (8 straight, 16 diagonal, in units of 8 cells), then for each opening the cheapest of
  // its corridor's points plus the walk on from there to its out cell. A corridor lengthened through rock (up to 128
  // cells) no longer wins by reaching out toward the spawn, and a diagonal coarse step is not counted as one straight.
  // (fixed after review) a step's cost is weighted by the point it enters (STEP_W, in quarters of a step on open
  // land): a forest's trees make Steve wind, and by fresh water (cm.wet: a lake or river within about 4 cells) he
  // would swim, so the walk keeps to open dry land where it can. `len` keeps the walk's own length (unweighted) along
  // the cheapest way, for the sign's step count.
  let found = -1, coarseSteps = -1, walk = -1, swum = false;
  const costs = [], closed = [], walkOf = new Map();
  if (start >= 0 && outer.length) {
    const wt = new Uint8Array(N);
    for (let q = 0; q < N; q++) wt[q] = STEP_W[cm.bio[q]] * (cm.wet[q] ? WET_STEP : 1);
    const dist = new Int32Array(N).fill(-1), len = new Int32Array(N), buckets = [[start]];
    dist[start] = 0;
    for (let c = 0; c < buckets.length; c++) {
      const list = buckets[c];
      if (!list) continue;
      for (let h = 0; h < list.length; h++) {
        const q = list[h];
        if (dist[q] !== c) continue;
        const i = q % n, jj = (q - i) / n;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, j2 = jj + dj;
          if ((di === 0 && dj === 0) || ii < 0 || j2 < 0 || ii >= n || j2 >= n) continue;
          const r = j2 * n + ii, step = di !== 0 && dj !== 0 ? 2 : 1, nc = c + step * wt[r];
          if ((dist[r] >= 0 && dist[r] <= nc) || !pass(r)) continue;
          dist[r] = nc; len[r] = len[q] + step;
          while (buckets.length <= nc) buckets.push(null);
          if (!buckets[nc]) buckets[nc] = [];
          buckets[nc].push(r);
        }
      }
      buckets[c] = null;
    }
    for (const o of outer) {
      const oi = cl(Math.floor((o.out[0] + 4) / st)), oj = cl(Math.floor((o.out[1] + 4) / st));
      const x0 = o.corr[0] - 8, y0 = o.corr[1] - 8, x1 = o.corr[0] + o.corr[2] + 8, y1 = o.corr[1] + o.corr[3] + 8;
      let best = -1, bestLen = -1;
      for (let jj = Math.max(0, -Math.floor(-y0 / st)); jj < n && jj * st < y1; jj++) {
        for (let i = Math.max(0, -Math.floor(-x0 / st)); i < n && i * st < x1; i++) {
          const d = dist[jj * n + i];
          if (d < 0) continue;
          const on = (i > oi ? i - oi : oi - i) + (jj > oj ? jj - oj : oj - jj), c = d + on * STEP_W[B.PLAINS];
          if (best < 0 || c < best) { best = c; bestLen = len[jj * n + i] + on; }
        }
      }
      if (best >= 0) { costs.push({ id: o.id, score: -best }); walkOf.set(o.id, bestLen); }
    }
    // the cheapest whose mouth opens on foot; if none does (fixed after review: the release then took the cheapest, a
    // closed pocket), the cheapest whose mouth opens across water too (`swum`); if none does, Kanto's edge below
    costs.sort(byScoreThenId);
    const paint = new Map(), mk = useMouths ? moveKinds(g) : null;
    for (const c of costs) {
      if (!useMouths || mouthOpen(g, outer.find((q) => q.id === c.id), paint, mk, false)) { found = c.id; coarseSteps = -c.score; break; }
      closed.push(c.id);
    }
    if (found < 0) {
      for (const c of costs) if (mouthOpen(g, outer.find((q) => q.id === c.id), paint, mk, true)) { found = c.id; coarseSteps = -c.score; swum = true; break; }
    }
    if (found >= 0) walk = walkOf.get(found) * st;
  }
  if (found >= 0) {
    const o = outer.find((c) => c.id === found);
    return { x: OX + o.out[0], y: o.out[1], kind: 'opening', id: o.id, coarseSteps, walk, opening: o, closed, swum };
  }
  // the fallback: Kanto proper's nearest coarse point (not its box, whose corners are generated land)
  let best = -1, bd = 0;
  for (let q = 0; q < N; q++) {
    if (!cm.kan[q]) continue;
    const dx = (q % n) * st - sx, dy = Math.floor(q / n) * st - sy, d = dx * dx + dy * dy;
    if (best < 0 || d < bd) { best = q; bd = d; }
  }
  if (best < 0) return null;
  return { x: OX + (best % n) * st, y: Math.floor(best / n) * st, kind: 'edge', id: -1, coarseSteps: -1, walk: -1, opening: null, closed, allClosed: costs.length > 0 };
}

// The gate sign (2.8): beside the target opening's path where it leaves Kanto's tree line, 2 to 4 cells outward from
// its out cell, just outside the corridor, the nearest cell to the path first (up to 5 cells beside it), the positive
// side first; not a Kanto cell. (As built: the design's "outside the corridor grown by 4" put it 8 cells from the
// path's middle, often behind the trees that line it; the path-cut test keeps it from closing any way through.) Its
// arrow is the inward normal.
function gateSign(g, o) {
  const [nx, ny] = o.n, [cx0, cy0, cw, ch] = o.corr, ox = o.out[0], oy = o.out[1];
  const cands = [];
  for (let d = 0; d <= 4; d++) {
    const side = nx === 0 ? [cx0 + cw + d - ox, cx0 - 1 - d - ox] : [cy0 + ch + d - oy, cy0 - 1 - d - oy];
    for (const s of side) for (let t = 2; t <= 4; t++) cands.push(nx === 0 ? [s, ny * t] : [nx * t, s]);
  }
  const hit = placeIn(g, ox, oy, cands, (x, y) => !isKantoCell(g.kanto, x, y));
  if (!hit) return null;
  return { x: OX + hit.x, y: hit.y, dir: sector8(-nx, -ny), kind: 'gate', id: o.id };
}

export function kantoSigns(g, plan, opts = {}) {
  if (!g || g.type !== 'kanto' || !g.kanto || !plan || !plan.json || !plan.cm) return null;
  const sp = plan.json.spawn, warn = [];
  const at = placeIn(g, sp.x, sp.y, SPAWN_CANDS, null);
  const target = findTarget(g, plan, at ? at.x : sp.x, at ? at.y : sp.y, opts.passes !== false, opts.mouths !== false);   // (opts: tools only)
  const out = { v: SIGN_V, target: target ? { x: target.x, y: target.y, kind: target.kind, id: target.id } : null, signs: [], warn };
  if (!target) warn.push('no way into Kanto was found for the spawn sign');
  if (!at) warn.push('no room for the spawn sign');
  if (target && target.swum) warn.push('no way into Kanto opens on foot; the sign points to one across water');
  if (target && target.allClosed) warn.push('every way into Kanto the sign could point to ends in a closed pocket');
  if (at && target) {
    // (fixed after review) the steps: the coarse walk's length (at least the grid distance) and a quarter more for the
    // trees it cannot see, rounded to tens (on 55 seeds the shortest walk on land was a median 1.22 times the coarse
    // walk and 1.27 times the grid distance the release gave)
    const dx = target.x - (OX + at.x), dy = target.y - at.y, grid = (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
    out.signs.push({ x: OX + at.x, y: at.y, dir: sector8(dx, dy), kind: 'spawn', steps: roundSteps((target.walk > grid ? target.walk : grid) * 5 / 4) });
  }
  if (target && target.opening && opts.gate !== false) {
    const gs = gateSign(g, target.opening);
    if (gs) out.signs.push(gs);
  }
  return out;
}
