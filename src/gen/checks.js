// Shape checks (design 4.7), shared by tools/gen_dump.mjs and the tests. Stage 3a has the checks that concern
// climate, biomes and water: item 6 (no tint pair other than the four hub pairs adjacent), item 8 (no straight
// seam) and the biome census. Stage 3b adds the painter checks (steps, cliffs, ledges, ores, trees, void).
import { TINT_OF, T_TEMPERATE, B, NB } from './biomes.js';
import { C_GRASS, C_SAND, C_SNOW, C_MUD, C_ROCK, C_SEA, C_FRESH, C_ICE, C_ICEP, C_KANTO, C_TALL, C_LEDGE } from './chunk.js';
import { kantoClassAt, K_ROCK } from './kanto.js';

// Item 6: adjacent (8-neighbour) cells whose tints are both non-temperate and different. Water has no tint.
// Returns { count, samples: [[x, y, biomeA, biomeB], ...] } in the region's own coordinates plus (x0, y0).
export function tintPairs(biome, w, h, x0 = 0, y0 = 0, maxSamples = 8) {
  let count = 0;
  const samples = [];
  const NB4 = [[1, 0], [0, 1], [1, 1], [-1, 1]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = biome[y * w + x], ta = TINT_OF[a];
      if (ta <= T_TEMPERATE) continue;
      for (const [dx, dy] of NB4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny >= h || nx >= w) continue;
        const b = biome[ny * w + nx], tb = TINT_OF[b];
        if (tb > T_TEMPERATE && tb !== ta) {
          count++;
          if (samples.length < maxSamples) samples.push([x0 + x, y0 + y, a, b]);
        }
      }
    }
  }
  return { count, samples };
}

// Item 8: a boundary between two different classes that runs dead straight (along a row or a column) for more
// than maxRun cells. `cls` is any per-cell class array (biome, tint, water kind); `skip(i)` exempts cells (Kanto's
// own cells: its map edges are exempt). Returns { count, longest, samples: [[x, y, len, 'h' | 'v'], ...] }.
// With `pairs`, a run is one pair of classes (a line along which the pair changes is several boundaries).
export function straightSeams(cls, w, h, { maxRun = 24, skip = null, x0 = 0, y0 = 0, maxSamples = 8, pairs = false } = {}) {
  let count = 0, longest = 0;
  const samples = [];
  let last = -1;
  const edge = (i, j) => {
    if (cls[i] === cls[j] || (skip && (skip(i) || skip(j)))) { last = -1; return false; }
    if (!pairs) return true;
    const k = cls[i] * 65536 + cls[j];
    if (last >= 0 && k !== last) { last = k; return 'new'; }
    last = k;
    return true;
  };
  const note = (x, y, len, dir) => {
    if (len > longest) longest = len;
    if (len > maxRun) { count++; if (samples.length < maxSamples) samples.push([x0 + x, y0 + y, len, dir]); }
  };
  // horizontal boundaries: between rows y and y + 1
  for (let y = 0; y + 1 < h; y++) {
    let run = 0;
    last = -1;
    for (let x = 0; x <= w; x++) {
      const e = x < w ? edge(y * w + x, (y + 1) * w + x) : false;
      if (e === 'new') { note(x - run, y, run, 'h'); run = 1; } else if (e) run++;
      else { if (run) note(x - run, y, run, 'h'); run = 0; }
    }
  }
  // vertical boundaries: between columns x and x + 1
  for (let x = 0; x + 1 < w; x++) {
    let run = 0;
    last = -1;
    for (let y = 0; y <= h; y++) {
      const e = y < h ? edge(y * w + x, y * w + x + 1) : false;
      if (e === 'new') { note(x, y - run, run, 'v'); run = 1; } else if (e) run++;
      else { if (run) note(x, y - run, run, 'v'); run = 0; }
    }
  }
  return { count, longest, samples };
}

export function tintArray(biome) {
  const out = new Uint8Array(biome.length);
  for (let i = 0; i < biome.length; i++) out[i] = TINT_OF[biome[i]];
  return out;
}

// cells per biome id
export function census(biome) {
  const c = new Array(NB).fill(0);
  for (let i = 0; i < biome.length; i++) c[biome[i]]++;
  return c;
}

// Every stage 3a check over a region result ({ biome, water, w, h, x0, y0 }).
export function regionChecks(r) {
  const { biome, water, w, h, x0, y0 } = r;
  const skip = (i) => biome[i] === B.KANTO;
  const tp = tintPairs(biome, w, h, x0, y0);
  const sb = straightSeams(biome, w, h, { skip, x0, y0 });
  const st = straightSeams(tintArray(biome), w, h, { skip, x0, y0 });
  const sw = straightSeams(water, w, h, { skip, x0, y0 });
  return {
    tintPairs: tp.count, tintSamples: tp.samples,
    seams: sb.count + st.count + sw.count,
    seamBiome: sb.count, seamTint: st.count, seamWater: sw.count,
    longestRun: Math.max(sb.longest, st.longest, sw.longest),
    seamSamples: [...sb.samples, ...st.samples, ...sw.samples].slice(0, 12),
  };
}

// ---------------------------------------------------------------- stage 3b: the painter's checks (4.7 items 1 to 8, 10)
// p: a paintRegion result with { debug: true }; g: its generator (for the tile bank). Segments and patches that
// touch the region's edge are not judged (they continue outside it). Kanto's cells are exempt (6a's seams).

// Item 1 for one binary mask: the boundary as maximal straight segments (a segment ends where the boundary turns or
// the inside flips side). A 1-cell segment is a 1-cell step; two consecutive segments both under 4 cells are a
// staircase (a step must sit between runs of at least 4). Returns { oneCell, shortPairs, samples }.
export function blobSteps(m, w, h, skip = null, x0 = 0, y0 = 0) {
  const H = new Int32Array(w * h), Hb = new Uint8Array(w * h), V = new Int32Array(w * h), Vb = new Uint8Array(w * h);
  let oneCell = 0, shortPairs = 0;
  const samples = [];
  const sk = (i) => !!skip && i >= 0 && i < w * h && skip[i] === 1;
  // horizontal edge units: between (x, y - 1) and (x, y); stored at y * w + x
  for (let y = 1; y < h; y++) {
    let x = 0;
    while (x < w) {
      const a = y * w + x, o = m[a - w] !== m[a] && !sk(a) && !sk(a - w) ? (m[a - w] ? 1 : 2) : 0;
      if (!o) { x++; continue; }
      let e = x;
      while (e + 1 < w) { const b = y * w + e + 1; const ob = m[b - w] !== m[b] && !sk(b) && !sk(b - w) ? (m[b - w] ? 1 : 2) : 0; if (ob !== o) break; e++; }
      // a segment that ends at the region's edge or at an exempt cell continues where it is not judged
      const sx0 = y * w + x - 1, sx1 = y * w + e + 1;
      const border = x === 0 || e === w - 1 || sk(sx0) || sk(sx0 - w) || sk(sx1) || sk(sx1 - w);
      const len = e - x + 1;
      for (let k = x; k <= e; k++) { H[y * w + k] = len; Hb[y * w + k] = border ? 1 : 0; }
      if (len === 1 && !border) { oneCell++; if (samples.length < 6) samples.push(['1h', x0 + x, y0 + y]); }
      x = e + 1;
    }
  }
  // vertical edge units: between (x - 1, y) and (x, y); stored at y * w + x
  for (let x = 1; x < w; x++) {
    let y = 0;
    while (y < h) {
      const a = y * w + x, o = m[a - 1] !== m[a] && !sk(a) && !sk(a - 1) ? (m[a - 1] ? 1 : 2) : 0;
      if (!o) { y++; continue; }
      let e = y;
      while (e + 1 < h) { const b = (e + 1) * w + x; const ob = m[b - 1] !== m[b] && !sk(b) && !sk(b - 1) ? (m[b - 1] ? 1 : 2) : 0; if (ob !== o) break; e++; }
      const sy0 = (y - 1) * w + x, sy1 = (e + 1) * w + x;
      const border = y === 0 || e === h - 1 || sk(sy0) || sk(sy0 - 1) || sk(sy1) || sk(sy1 - 1);
      const len = e - y + 1;
      for (let k = y; k <= e; k++) { V[k * w + x] = len; Vb[k * w + x] = border ? 1 : 0; }
      if (len === 1 && !border) { oneCell++; if (samples.length < 6) samples.push(['1v', x0 + x, y0 + y]); }
      y = e + 1;
    }
  }
  // corners: a grid vertex (x, y) with exactly one horizontal and one vertical boundary unit
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const hl = H[y * w + x - 1], hr = H[y * w + x], vu = V[(y - 1) * w + x], vd = V[y * w + x];
      const nh = (hl ? 1 : 0) + (hr ? 1 : 0), nv = (vu ? 1 : 0) + (vd ? 1 : 0);
      if (nh !== 1 || nv !== 1) continue;
      const lh = hl || hr, lv = vu || vd;
      const bh = hl ? Hb[y * w + x - 1] : Hb[y * w + x], bv = vu ? Vb[(y - 1) * w + x] : Vb[y * w + x];
      if (lh < 4 && lv < 4 && !bh && !bv) { shortPairs++; if (samples.length < 6) samples.push(['stair', x0 + x, y0 + y]); }
    }
  }
  return { oneCell, shortPairs, samples };
}

// 4-connected components of a mask: calls f(bbox, size, touchesBorder) for each
function components(m, w, h, f) {
  const seen = new Uint8Array(w * h), st = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || seen[i]) continue;
    let n = 0, sp = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, border = false;
    st[sp++] = i; seen[i] = 1;
    while (sp) {
      const j = st[--sp], x = j % w, y = (j - x) / w;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && m[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; st[sp++] = j - 1; }
      if (x < w - 1 && m[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; st[sp++] = j + 1; }
      if (y > 0 && m[j - w] && !seen[j - w]) { seen[j - w] = 1; st[sp++] = j - w; }
      if (y < h - 1 && m[j + w] && !seen[j + w]) { seen[j + w] = 1; st[sp++] = j + w; }
    }
    f([x0, y0, x1 - x0 + 1, y1 - y0 + 1], n, border);
  }
}

export function paintChecks(p, g) {
  const { w, h, x0, y0, cls, tile, ground, dbg } = p;
  const n = w * h, T = g.terrain;
  // Kanto's cells and the generated cells within one super (4 cells) of them are Kanto's seam, re-tiled by stage 6a:
  // exempt here (design 4.7 item 8 already exempts Kanto's map edges)
  const kan = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (cls[y * w + x] !== C_KANTO) continue;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) kan[yy * w + xx] = 1;
    }
  }
  const mask = (pred) => { const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = pred(cls[i]) ? 1 : 0; return m; };
  // one rock mask across Kanto's seam (6a): Kanto's rock cells are rock to the cliff and thickness checks
  const RU = mask((c) => c === C_ROCK);
  if (g.kanto && g.kanto.ctx) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (cls[y * w + x] === C_KANTO && kantoClassAt(g.kanto, x0 + x, y0 + y) === K_ROCK) RU[y * w + x] = 1;
  const midOf = (t) => (t < T.genBase ? t : T.entries[t - T.genBase][0]);
  const counts = {};
  const samples = {};
  const note = (k, v, s) => { counts[k] = (counts[k] || 0) + v; if (s && s.length && !samples[k]) samples[k] = s; };

  // 1. steps and runs in every blob mask
  const masks = {
    water: (c) => c === C_SEA || c === C_FRESH || c === C_ICE || c === C_ICEP,
    sand: (c) => c === C_SAND, snow: (c) => c === C_SNOW, ice: (c) => c === C_ICE || c === C_ICEP,
    mud: (c) => c === C_MUD, tallGrass: (c) => c === C_TALL, rock: (c) => c === C_ROCK,
  };
  const M = {};
  for (const [k, pred] of Object.entries(masks)) {
    M[k] = mask(pred);
    const r = blobSteps(M[k], w, h, kan, x0, y0);
    note('step1_' + k, r.oneCell + r.shortPairs, r.samples);
  }
  // sand touching both the sea and grass (stage 2a: no mixed A and B codes)
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : cls[y * w + x]);
  let mixed = 0;
  const mixS = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cls[y * w + x];
    if ((c !== C_SAND && c !== C_SNOW) || kan[y * w + x]) continue;
    let sea = false, grass = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const q = at(x + dx, y + dy);
      if (q === C_SEA) sea = true;
      if (q === C_GRASS || q === C_TALL || q === C_LEDGE) grass = true;
    }
    if (sea && grass) { mixed++; if (mixS.length < 6) mixS.push([x0 + x, y0 + y]); }
  }
  note('step1_sandSeaGrass', mixed, mixS);

  // 2 and 3. cliffs: every rock cell has a piece (no miss); no dangling piece: every (piece, open sides) pair is one
  // FireRed draws (some 3 x 3 pattern of the learned table with those sides open lists that piece); compat with the
  // ground on the open side
  let miss = 0, dangling = 0, compatBad = 0, ledgeMiss = 0, sandPx = 0;
  const dangS = [], compS = [], sandS = [];
  if (!T.rock.sides) {
    const ok = new Set();
    const add = (k, list) => {
      const open = ((k >> 7) & 1 ? 0 : 1) | ((k >> 3) & 1 ? 0 : 2) | ((k >> 1) & 1 ? 0 : 4) | ((k >> 5) & 1 ? 0 : 8);
      for (const c of list) ok.add(c * 16 + open);
    };
    for (const [k, list] of T.rock.r1) add(k, list);
    for (const [kg, list] of T.rock.g1) add(kg >> 1, list);
    T.rock.sides = ok;
  }
  const sandG = new Set([277, ...T.fam.sand]);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, c = cls[i];
    if (c === C_LEDGE && (tile[i] === ground[i])) ledgeMiss++;
    if (c === C_LEDGE && tile[i] < T.genBase && !sandG.has(ground[i])) {
      // a ledge piece's home look showing sand pixels on a ground that is not sand (px, as for rock below)
      const lp = T.ledge.px.get(tile[i]);
      if (lp && lp[1]) { sandPx++; if (sandS.length < 6) sandS.push([x0 + x, y0 + y, tile[i], tile[i], ground[i], -1]); }
    }
    if (c !== C_ROCK) continue;
    if (dbg.tree[i]) continue;
    if (tile[i] === ground[i]) { miss++; continue; }
    const m = midOf(tile[i]);
    const open = (!RU[i - w] ? 1 : 0) | (!RU[i + 1] ? 2 : 0) | (!RU[i + w] ? 4 : 0) | (!RU[i - 1] ? 8 : 0);
    if (!open) continue;
    if (!dbg.ore[i] && !T.rock.sides.has(m * 16 + open)) { dangling++; if (dangS.length < 6) dangS.push([x0 + x, y0 + y, m, open]); }
    // an overlay entry shows none of its own ground pixels, so only home entries can disagree with the ground
    const isOv = tile[i] >= T.genBase && T.entries[tile[i] - T.genBase][10] === 1;
    // px: the piece's ground pixels with every FireRed grass and sand colour (terrain.js; compat misses beach sand)
    const cp = T.rock.px.get(m), s = sandG.has(ground[i]);
    if (!isOv && cp && ((s && cp[0]) || (!s && cp[1]))) { compatBad++; if (compS.length < 6) compS.push([x0 + x, y0 + y, m, tile[i], ground[i], dbg.style[i]]); }
    // the quick check's case by itself: a rock piece showing sand pixels beside grass with no sand cell nearby
    if (!isOv && cp && cp[1] && !s) {
      let nearSand = false, nearGrass = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = cls[i + dy * w + dx];
        if (q === C_SAND) nearSand = true;
        if (q === C_GRASS || q === C_TALL || q === C_LEDGE) nearGrass = true;
      }
      if (nearGrass && !nearSand) { sandPx++; if (sandS.length < 6) sandS.push([x0 + x, y0 + y, m, tile[i], ground[i], dbg.style[i]]); }
    }
  }
  note('misses', miss + ledgeMiss);
  note('cliff_dangling', dangling, dangS);
  note('compat', compatBad, compS);
  note('rock_sand_px', sandPx, sandS);

  // 4. ledges: never on or touching rock, runs of at least 3, one row
  let ledgeRock = 0, ledgeShort = 0, ledgeThick = 0;
  for (let y = 1; y < h - 1; y++) {
    let run = 0, start = 0;
    for (let x = 0; x <= w; x++) {
      const isL = x < w && cls[y * w + x] === C_LEDGE;
      if (isL) {
        if (!run) start = x;
        run++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === C_ROCK) { ledgeRock++; dy = 2; break; }
        if (at(x, y - 1) === C_LEDGE || at(x, y + 1) === C_LEDGE) ledgeThick++;
      } else if (run) {
        if (run < 3 && start > 0 && x < w) ledgeShort++;
        run = 0;
      }
    }
  }
  note('ledge_rock', ledgeRock); note('ledge_short', ledgeShort); note('ledge_thick', ledgeThick);

  // 5. ores: at most two kinds in any 15 x 10 window; coverage of interior faces
  const K = 8, SWD = 15, SHT = 10;
  const pre = [];
  for (let k = 0; k < K; k++) {
    const ps = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += dbg.ore[y * w + x] === k + 1 ? 1 : 0; ps[(y + 1) * (w + 1) + x + 1] = ps[y * (w + 1) + x + 1] + row; }
    }
    pre.push(ps);
  }
  let screens = 0;
  const scrS = [];
  for (let y = 0; y + SHT <= h; y++) for (let x = 0; x + SWD <= w; x++) {
    let kinds = 0;
    for (let k = 0; k < K; k++) {
      const ps = pre[k], W1 = w + 1;
      if (ps[(y + SHT) * W1 + x + SWD] - ps[y * W1 + x + SWD] - ps[(y + SHT) * W1 + x] + ps[y * W1 + x] > 0) kinds++;
    }
    if (kinds > 2) { screens++; if (scrS.length < 4) scrS.push([x0 + x, y0 + y, kinds]); }
  }
  note('ore_screens', screens, scrS);
  let faces = 0, pure = 0, ores = 0;
  const byKind = new Array(K).fill(0);
  for (let i = 0; i < n; i++) {
    if (dbg.face[i]) { faces++; if (dbg.face[i] === 2) pure++; }
    if (dbg.ore[i]) { ores++; byKind[dbg.ore[i] - 1]++; }
  }
  const ore = { faces, pureFaces: pure, ores, coverage: faces ? +(100 * ores / faces).toFixed(2) : 0, byKind };

  // 6. tints: only the four hub pairs touch; no tree slot in a transition band
  const fam = (v) => (v === 0 ? 0 : v <= 4 ? v : 1 + ((v - 5) >> 1));
  let tintBad = 0;
  const tintS = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!(cls[i] === C_GRASS || cls[i] === C_TALL || cls[i] === C_LEDGE)) continue;
    const a = fam(dbg.tint[i]);
    if (!a) continue;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (!(cls[j] === C_GRASS || cls[j] === C_TALL || cls[j] === C_LEDGE)) continue;
      const b = fam(dbg.tint[j]);
      if (b && b !== a) { tintBad++; if (tintS.length < 6) tintS.push([x0 + x, y0 + y, dbg.tint[i], dbg.tint[j]]); }
    }
  }
  note('tint_pairs', tintBad, tintS);
  let slotBand = 0;
  for (let k = 0; k < dbg.slots.length; k += 2) {
    const sx = dbg.slots[k] - x0, sy = dbg.slots[k + 1] - y0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = 0; dx < 2; dx++) {
      const xx = sx + dx, yy = sy + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const v = dbg.tint[yy * w + xx];
      if (v >= 5 && v <= 12) { slotBand++; dy = 2; break; }
    }
  }
  note('tree_slot_in_band', slotBand);

  // 7. no void: every generated cell has an entry
  let voids = 0;
  for (let i = 0; i < n; i++) if (!tile[i] && cls[i] !== C_KANTO) voids++;
  note('void', voids);

  // 8. no straight seam over 24 cells between ground classes (water kinds included) or tints
  const skip = (i) => kan[i] === 1;
  const gcls = new Uint8Array(n);
  for (let i = 0; i < n; i++) gcls[i] = cls[i] === C_LEDGE ? C_GRASS : cls[i];
  const tv = new Uint8Array(n);
  for (let i = 0; i < n; i++) tv[i] = cls[i] === C_GRASS || cls[i] === C_TALL || cls[i] === C_LEDGE ? 1 + dbg.tint[i] : 0;
  // (tints are judged between grass cells only: a grass cell beside water or sand is the ground check's)
  const s1 = straightSeams(gcls, w, h, { skip, x0, y0 }), s2 = straightSeams(tv, w, h, { skip: (i) => kan[i] === 1 || tv[i] === 0, x0, y0 });
  // and between the painted biomes (what the banner and the wild tables will read), one pair at a time: the classes
  // above are drawn on the step rule's 4-cell grid, so a grid line can carry a sea, a beach and a lake boundary one
  // after another, each short (they are counted as one line above, between ground classes, and pass)
  const s3 = straightSeams(p.biome, w, h, { skip, x0, y0, pairs: true });
  note('seam_ground', s1.count, s1.samples); note('seam_tint', s2.count, s2.samples); note('seam_biome', s3.count, s3.samples);
  const longest = Math.max(s1.longest, s2.longest, s3.longest);

  // 10. no feature smaller than FireRed's: tall grass 4 x 4, rock 4 thick, lakes 5 x 4, biome patches 40 x 40
  let tallSmall = 0, lakeSmall = 0, biomeSmall = 0;
  components(M.tallGrass, w, h, (bb, size, border) => { if (!border && (bb[2] < 4 || bb[3] < 4)) tallSmall++; });
  const fresh = mask((c) => c === C_FRESH || c === C_ICEP);
  const lakeS = [];
  // a lake is a body of fresh water that does not meet the sea (a river's mouth is part of the sea's water)
  components(fresh, w, h, (bb, size, border) => {
    if (border || (Math.max(bb[2], bb[3]) >= 5 && Math.min(bb[2], bb[3]) >= 4)) return;
    let sea = false;
    for (let y = Math.max(0, bb[1] - 1); y <= Math.min(h - 1, bb[1] + bb[3]) && !sea; y++) {
      for (let x = Math.max(0, bb[0] - 1); x <= Math.min(w - 1, bb[0] + bb[2]); x++) if (cls[y * w + x] === C_SEA || cls[y * w + x] === C_ICE) { sea = true; break; }
    }
    if (!sea) { lakeSmall++; if (lakeS.length < 6) lakeS.push([x0 + bb[0], y0 + bb[1], bb[2], bb[3]]); }
  });
  // rock 4 thick: every rock cell lies in some 4 x 4 all-rock square
  const R = RU, rp = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += R[y * w + x]; rp[(y + 1) * (w + 1) + x + 1] = rp[y * (w + 1) + x + 1] + row; } }
  const full = new Uint8Array(n);
  for (let y = 0; y + 4 <= h; y++) for (let x = 0; x + 4 <= w; x++) {
    const W1 = w + 1;
    if (rp[(y + 4) * W1 + x + 4] - rp[y * W1 + x + 4] - rp[(y + 4) * W1 + x] + rp[y * W1 + x] === 16) for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) full[(y + dy) * w + x + dx] = 1;
  }
  let thin = 0;
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) if (cls[y * w + x] === C_ROCK && !full[y * w + x]) thin++;
  // biome patches as the painter uses them (each 4 x 4 super's land biome, which continues under rivers and lakes),
  // Kanto aside; a patch with no land cell (all of it under the sea) is not seen and not counted, and one touching
  // Kanto's seam (within 4 cells of its cells) is stage 6a's
  const sl = dbg.sland;
  const smallS = [];
  for (let b = 1; b < 23; b++) {
    const bm = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) if (sl[i] === b && cls[i] !== C_KANTO) { bm[i] = 1; any = true; }
    if (!any) continue;
    components(bm, w, h, (bb, size, border) => {
      if (border || bb[2] >= 40 || bb[3] >= 40) return;
      let land = 0, seam = false;
      for (let y = bb[1]; y < bb[1] + bb[3]; y++) for (let x = bb[0]; x < bb[0] + bb[2]; x++) {
        const i = y * w + x;
        if (!bm[i]) continue;
        if (cls[i] !== C_SEA && cls[i] !== C_ICE) land++;
        if (kan[i]) seam = true;
      }
      // a patch cut off by Kanto's own cells is part of Kanto's seam (stage 6a)
      if (!land || seam) return;
      biomeSmall++;
      if (smallS.length < 64) smallS.push([x0 + bb[0], y0 + bb[1], bb[2], bb[3], b, land]);
    });
  }
  note('small_tallGrass', tallSmall); note('small_lake', lakeSmall, lakeS); note('thin_rock', thin); note('small_biome', biomeSmall, smallS);

  // (genpolish fixer) rectangular islands in fresh water: a 4-connected component of land cells (or of pond ice) that
  // fresh water alone encloses (open water for the ice) and that is an exact rectangle of 4 cells or more is a blocky
  // square or strip standing in a river or lake (the generator polish quick check). Rock outcrops are exempt, and so
  // are components on the region's edge or with Kanto's cells in them.
  {
    const seen = new Uint8Array(n), stk = [], rectS = [];
    let rect = 0;
    const freshW = (c) => c === C_FRESH || c === C_ICEP;
    for (let s0 = 0; s0 < n; s0++) {
      const c0 = cls[s0];
      if (seen[s0] || c0 === C_FRESH || c0 === C_SEA || c0 === C_ICE) continue;
      const ice = c0 === C_ICEP, same = ice ? (c) => c === C_ICEP : (c) => !(freshW(c) || c === C_SEA || c === C_ICE);
      seen[s0] = 1; stk.length = 0; stk.push(s0);
      let cnt = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1, ok = true;
      while (stk.length) {
        const i = stk.pop(), x = i % w, y = (i - x) / w, c = cls[i];
        cnt++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        if (c === C_ROCK || c === C_KANTO || x === 0 || y === 0 || x === w - 1 || y === h - 1) ok = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx, cj = cls[j];
          if (same(cj)) { if (!seen[j]) { seen[j] = 1; stk.push(j); } } else if (ice ? cj !== C_FRESH : !freshW(cj)) ok = false;
        }
      }
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
      if (ok && cnt >= 4 && cnt === bw * bh) { rect++; if (rectS.length < 32) rectS.push([x0 + bx0, y0 + by0, bw, bh, c0]); }
    }
    note('rect_island', rect, rectS);
  }

  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  return { counts, total, samples, ore, longestRun: longest };
}
