// Caves as rooms (design 3.10; stage 5b). A cave's floors (B1F 48 x 36, B2F 40 x 30) are dug by a cellular automaton
// on the room's own seed and painted with one FireRed cave family's learned wall tables (autotile.json: r2, r1,
// fill), the same lookup world.js reedgeFamily performs, so a mined wall re-edges exactly as a Kanto cave's does.
// Pure (3.0): no DOM, no time, integer hashing only; the same input gives the same room in every browser.
//
//   digCave(spec, tables) -> { w, h, tile: Uint16Array, ground: Uint16Array, lava: [[x, y], ...], ores: {...}, stats }
//     spec   { w, h, floor (1 | 2), seed (the cave's), family ('temperate' | 'mountain' | 'snowy') }
//     tables { fam: { r2, r1, fill } (autotile.json's family), col: (entry) -> 0 | 1, ores: { <wall entry>: { <ore>: entry } } }
//   The room's fixed cells (room-local): the B1F exit at (w >> 1, h - 3) with FireRed's three exit pieces under it,
//   the B1F ladder down at (w >> 1, 2), the B2F ladder up at (w >> 1, h - 3) (the plan's warps, plan.js).
import { hash32 } from './hash.js';

// The three FireRed cave families (3.10): Mt Moon's for temperate caves, Rock Tunnel's for mountain caves, Seafoam's
// for snowy caves. Their floor, ladder, exit and exit-row entries are world.json's (checked against Kanto's caves:
// tools/gen_tests/caves.mjs).
export const CAVE_FAMILY = Object.freeze({
  temperate: Object.freeze({ key: 'cave:Cave', pair: 14, floor: 2160, ladder: 2252, exit: 2399, exitRow: [2407, 2408, 2409] }),
  mountain: Object.freeze({ key: 'cave:RockTunnel', pair: 16, floor: 2474, ladder: 2522, exit: 2806, exitRow: [2807, 2808, 2809] }),
  snowy: Object.freeze({ key: 'cave:SeafoamIslands', pair: 19, floor: 2563, ladder: 2595, exit: 2770, exitRow: [2778, 2779, 2780] }),
});

// Ores by level (3.10): coverage in % of interior wall faces, and the mean vein size.
// where: 0 every cave, 1 mountain caves only
const ORES = {
  1: [['coal_ore', 2.5, 4, 0], ['copper_ore', 1.2, 4, 0], ['iron_ore', 1.6, 4, 0], ['lapis_ore', 0.3, 3, 0], ['redstone_ore', 0.4, 3, 0], ['gold_ore', 0.2, 3, 0]],
  2: [['iron_ore', 1.6, 4, 0], ['gold_ore', 0.6, 3, 0], ['redstone_ore', 0.8, 3, 0], ['lapis_ore', 0.5, 3, 0], ['diamond_ore', 0.25, 2, 0], ['emerald_ore', 0.12, 2, 1]],
};
export const CAVE_ORE_TUNE = 1.6;     // overlap of veins and faces without ore entries (stage 5b measured it)
const ORE_REACH = 2;
const FILL = 0.46, STEPS = 5, KEEP_MIN = 20, MARGIN = 2;
const CANDS = new WeakMap();
const DIR8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

export function digCave(spec, tables) {
  const { w, h, floor } = spec, fam = CAVE_FAMILY[spec.family] || CAVE_FAMILY.temperate;
  const seed = hash32(spec.seed | 0, floor, 0x5b);
  const N = w * h, cx = w >> 1;
  const r01 = (a, b, c) => hash32(seed, a, b, c) / 4294967296;
  // ---- the automaton: 1 wall, 0 floor
  let m = new Uint8Array(N);
  const edge = (x, y) => x < MARGIN || y < MARGIN || x >= w - MARGIN || y >= h - MARGIN;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = edge(x, y) || r01(x, y, 1) < FILL ? 1 : 0;
  const wallAt = (a, x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 1 : a[y * w + x]);
  for (let s = 0; s < STEPS; s++) {
    const n = new Uint8Array(N);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (edge(x, y)) { n[y * w + x] = 1; continue; }
        const o = y * w + x;   // (an edge cell is never smoothed, so its 8 neighbours are inside)
        const k = m[o - w - 1] + m[o - w] + m[o - w + 1] + m[o - 1] + m[o + 1] + m[o + w - 1] + m[o + w] + m[o + w + 1];
        n[y * w + x] = k >= 5 || (k >= 4 && m[y * w + x]) ? 1 : 0;
      }
    }
    m = n;
  }
  // ---- the fixed places: clearings around the exit and the ladders (kept floor whatever the automaton made)
  const fixed = new Uint8Array(N);       // 1 exit, 2 exit row piece, 3 ladder
  const clear = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= MARGIN && y >= 1 && x < w - MARGIN && y < h - 1) m[y * w + x] = 0; };
  const anchors = [];
  if (floor === 1) {
    clear(cx - 2, h - 6, cx + 2, h - 3);
    for (let dx = -1; dx <= 1; dx++) { m[(h - 2) * w + cx + dx] = 1; fixed[(h - 2) * w + cx + dx] = 2; }
    fixed[(h - 3) * w + cx] = 1; anchors.push([cx, h - 3]);
    if (spec.b2) { clear(cx - 2, 2, cx + 2, 4); fixed[2 * w + cx] = 3; anchors.push([cx, 2]); }
  } else {
    clear(cx - 2, h - 6, cx + 2, h - 3);
    fixed[(h - 3) * w + cx] = 3; anchors.push([cx, h - 3]);
  }
  // ---- regions: the main one holds the first anchor; every other anchor's and every region over KEEP_MIN cells are
  // tunnelled to it (2 wide), smaller ones are filled
  const label = new Int32Array(N);
  const regions = () => {
    label.fill(0);
    const out = [];
    for (let i = 0; i < N; i++) {
      if (m[i] || label[i]) continue;
      const id = out.length + 1, cells = [i];
      label[i] = id;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k], x = c % w, y = (c - x) / w;
        if (x > 0 && !m[c - 1] && !label[c - 1]) { label[c - 1] = id; cells.push(c - 1); }
        if (x < w - 1 && !m[c + 1] && !label[c + 1]) { label[c + 1] = id; cells.push(c + 1); }
        if (y > 0 && !m[c - w] && !label[c - w]) { label[c - w] = id; cells.push(c - w); }
        if (y < h - 1 && !m[c + w] && !label[c + w]) { label[c + w] = id; cells.push(c + w); }
      }
      out.push(cells);
    }
    return out;
  };
  const carve = (x, y) => { for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const xx = x + dx, yy = y + dy; if (xx >= MARGIN && yy >= 1 && xx < w - MARGIN && yy < h - 2 && !fixed[yy * w + xx]) m[yy * w + xx] = 0; } };
  const connect = (fillSmall) => {
  for (let pass = 0; pass < 8; pass++) {
    const rs = regions();
    const main = label[anchors[0][1] * w + anchors[0][0]];
    let joined = false;
    for (let r = 0; r < rs.length; r++) {
      const id = r + 1, cells = rs[r];
      if (id === main) continue;
      const anchored = anchors.some(([ax, ay]) => label[ay * w + ax] === id);
      if (fillSmall && cells.length <= KEEP_MIN && !anchored) { for (const c of cells) m[c] = 1; continue; }
      // the first cell in reading order to the nearest cell of the main region (Manhattan, ties in reading order)
      const s = cells[0], sx = s % w, sy = (s - sx) / w;
      let best = -1, bd = 1e9;
      for (const c of rs[main - 1]) { const x = c % w, y = (c - x) / w, d = Math.abs(x - sx) + Math.abs(y - sy); if (d < bd) { bd = d; best = c; } }
      const tx = best % w, ty = (best - tx) / w;
      let x = sx, y = sy;
      while (x !== tx) { carve(x, y); x += tx > x ? 1 : -1; }
      while (y !== ty) { carve(x, y); y += ty > y ? 1 : -1; }
      carve(x, y);
      joined = true;
    }
    if (!joined) break;
  }
  };
  // ---- what the family's tables can draw: a wall cell whose pattern has no colliding piece becomes floor (repeated
  // until none is left; the fixed exit row stays)
  const keyOf = (x, y, r) => {
    let k = 0;
    if (x >= r && y >= r && x < w - r && y < h - r) {
      // (inside: no edge tests)
      for (let dy = -r; dy <= r; dy++) { const o = (y + dy) * w + x; for (let dx = -r; dx <= r; dx++) k = k * 2 + m[o + dx]; }
      return k;
    }
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) k = k * 2 + wallAt(m, x + dx, y + dy);
    return k;
  };
  const F = tables.fam, col = tables.col;
  // (the family's tables with numeric keys and only colliding pieces, built once per table)
  let ft = CANDS.get(F);
  if (!ft) {
    const keep = (l) => { const c = (l || []).filter((e) => col(e)); return c.length ? c : null; };
    ft = { r2: new Map(), r1: new Array(512).fill(null), fill: new Array(512).fill(null) };
    for (const [k, l] of Object.entries(F.r2)) ft.r2.set(Number(k), (l || []).filter((e) => col(e)));
    for (let k = 0; k < 512; k++) { ft.r1[k] = F.r1[k] ? (F.r1[k] || []).filter((e) => col(e)) : null; ft.fill[k] = keep(F.fill[k]); }
    CANDS.set(F, ft);
  }
  const NONE = [];
  const cands = (x, y) => {
    const k5 = keyOf(x, y, 2);
    // reedgeFamily's order: r2's list (even if no piece of it collides), else r1's, else fill's
    if (ft.r2.has(k5)) return ft.r2.get(k5);
    const k3 = ((k5 >> 16) & 7) << 6 | ((k5 >> 11) & 7) << 3 | ((k5 >> 6) & 7);
    return ft.r1[k3] || ft.fill[k3] || NONE;
  };
  const cleanup = () => {
    // every wall cell once, then the 5 x 5 around each cell that opened (its neighbours' patterns changed)
    let changed = 0;
    const queued = new Uint8Array(N), list = [];
    for (let i = 0; i < N; i++) if (m[i] && !fixed[i]) { queued[i] = 1; list.push(i); }
    for (let q = 0; q < list.length; q++) {
      const i = list[q], x = i % w, y = (i - x) / w;
      queued[i] = 0;
      if (!m[i] || cands(x, y).length) continue;
      m[i] = 0; changed++;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (m[j] && !fixed[j] && !queued[j]) { queued[j] = 1; list.push(j); }
      }
    }
    return changed;
  };
  // connect and fill, then make every wall drawable; a cleanup can open a pocket, so again until nothing changes
  // (after the first round a pocket the cleanup opened is tunnelled, never filled again: filled, it could not be drawn)
  for (let round = 0; round < 6; round++) {
    connect(round === 0);
    if (!cleanup()) break;
  }
  // ---- paint
  const tile = new Uint16Array(N), ground = new Uint16Array(N).fill(fam.floor);
  let undrawn = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (fixed[i] === 1) { tile[i] = fam.exit; continue; }
      if (fixed[i] === 2) { tile[i] = fam.exitRow[x - cx + 1]; continue; }
      if (fixed[i] === 3) { tile[i] = fam.ladder; continue; }
      if (!m[i]) { tile[i] = fam.floor; continue; }
      const c = cands(x, y);
      if (!c.length) { undrawn++; tile[i] = fam.floor; m[i] = 0; continue; }
      tile[i] = c[hash32(seed, x, y, 2) % c.length];
    }
  }
  // ---- ores (3.10 with 3.9's veins): one pair of kinds per floor (the room is the district, so a screen never shows
  // more than two kinds), drawn by coverage; each kind's start rate scaled by how often it is drawn
  const oreTab = tables.ores || {};
  const kinds = ORES[floor === 2 ? 2 : 1].filter((o) => o[3] === 0 || spec.family === 'mountain');
  const wsum = kinds.reduce((s, o) => s + o[1], 0);
  const pick = (u, skip) => {
    let acc = 0;
    const tot = wsum - (skip >= 0 ? kinds[skip][1] : 0);
    for (let k = 0; k < kinds.length; k++) {
      if (k === skip) continue;
      acc += kinds[k][1] / tot;
      if (u < acc) return k;
    }
    return kinds.length - 1 === skip ? kinds.length - 2 : kinds.length - 1;
  };
  // (playfix: every B2F has diamond as one of its two kinds, as 3.10 promised; the other kind is drawn from the rest,
  // so its start rate is scaled by the chance of being that one)
  const dia = floor === 2 ? kinds.findIndex((o) => o[0] === 'diamond_ore') : -1;
  const k1 = dia >= 0 ? dia : pick(r01(0, 0, 3), -1), k2 = pick(r01(0, 0, 4), k1);
  const inPair = (k) => {
    if (dia >= 0) return k === dia ? 1 : kinds[k][1] / (wsum - kinds[dia][1]);
    // the probability that kind k is one of the two drawn (without replacement)
    let p = kinds[k][1] / wsum;
    for (let j = 0; j < kinds.length; j++) if (j !== k) p += (kinds[j][1] / wsum) * (kinds[k][1] / (wsum - kinds[j][1]));
    return p;
  };
  const face = new Uint8Array(N);
  let faces = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i] || fixed[i] || !oreTab[tile[i]]) continue;
      let all = true;
      for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (!wallAt(m, x + dx, y + dy) || (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && fixed[(y + dy) * w + x + dx])) { all = false; break; }
      if (all) { face[i] = 1; faces++; }
    }
  }
  const startRate = [k1, k2].map((k) => CAVE_ORE_TUNE * kinds[k][1] / 100 / inPair(k) / kinds[k][2]);
  const oreAt = new Uint8Array(N);
  const counts = {};
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!face[y * w + x]) continue;
      const u = r01(x, y, 5);
      const which = u < startRate[0] ? 0 : u < startRate[0] + startRate[1] ? 1 : -1;
      if (which < 0) continue;
      const kk = kinds[which ? k2 : k1], n = Math.max(2, Math.min(6, kk[2] - 1 + (hash32(seed, x, y, 6) % 3)));
      let vx = 0, vy = 0;
      for (let s = 0; s < n; s++) {
        if (s) {
          const d = DIR8[hash32(seed, x, y, 16 + s) & 7];
          let nx = vx + d[0], ny = vy + d[1];
          if (nx > ORE_REACH || nx < -ORE_REACH || ny > ORE_REACH || ny < -ORE_REACH) { nx = vx - d[0]; ny = vy - d[1]; }
          vx = nx; vy = ny;
        }
        const X = x + vx, Y = y + vy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (!face[j] || oreAt[j]) continue;
        const e = oreTab[tile[j]] && oreTab[tile[j]][kk[0]];
        if (e == null) continue;
        tile[j] = e; oreAt[j] = 1;
        counts[kk[0]] = (counts[kk[0]] || 0) + 1;
      }
    }
  }
  // (playfix: a B2F whose diamond veins all missed still gets one two-cell vein, at a hashed interior face)
  if (dia >= 0 && !(counts.diamond_ore >= 2)) {
    for (let t = 0, need = 2 - (counts.diamond_ore || 0); t < 400 && need > 0; t++) {
      const x = 1 + (hash32(seed, t, 1, 9) % Math.max(1, w - 2)), y = 1 + (hash32(seed, t, 2, 9) % Math.max(1, h - 2)), j = y * w + x;
      if (!face[j] || oreAt[j]) continue;
      const e = oreTab[tile[j]] && oreTab[tile[j]].diamond_ore;
      if (e == null) continue;
      tile[j] = e; oreAt[j] = 1; counts.diamond_ore = (counts.diamond_ore || 0) + 1; need--;
      for (const d of DIR8) {
        if (need <= 0) break;
        const X = x + d[0], Y = y + d[1], q = Y * w + X;
        if (X < 0 || Y < 0 || X >= w || Y >= h || !face[q] || oreAt[q]) continue;
        const e2 = oreTab[tile[q]] && oreTab[tile[q]].diamond_ore;
        if (e2 == null) continue;
        tile[q] = e2; oreAt[q] = 1; counts.diamond_ore++; need--;
      }
    }
  }
  // ---- lava (3.10): one or two 3 x 3 pools on B2F of a mountain cave, in open floor (a 5 x 5 of floor around each),
  // at least 8 cells from the ladder
  const lava = [];
  if (floor === 2 && spec.family === 'mountain') {
    const want = 1 + (hash32(seed, 0, 0, 7) & 1);
    const ok = (x, y) => {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 1 || Y < 1 || X >= w - 1 || Y >= h - 1) return false;
        const j = Y * w + X;
        if (m[j] || fixed[j] || tile[j] !== fam.floor) return false;
      }
      return Math.abs(x - anchors[0][0]) + Math.abs(y - anchors[0][1]) >= 8 && lava.every(([lx, ly]) => Math.abs(lx - x) > 5 || Math.abs(ly - y) > 5);
    };
    const spots = [];
    for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) if (ok(x, y)) spots.push(y * w + x);
    for (let t = 0; t < 40 && spots.length && lava.length < want * 9; t++) {
      const s = spots[hash32(seed, t, 0, 8) % spots.length], x = s % w, y = (s - x) / w;
      if (!ok(x, y)) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) lava.push([x + dx, y + dy]);
    }
  }
  let floorN = 0;
  for (let i = 0; i < N; i++) if (!m[i]) floorN++;
  return { w, h, tile, ground, lava, pair: [kinds[k1][0], kinds[k2][0]], stats: { faces, ores: counts, floor: floorN, undrawn } };
}
