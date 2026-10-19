// The minimap's core (minimap-design.md 3.4 to 3.7, 3.12; Track MAP): the explored mask (a bit per 4 x 4 cells over the
// whole plane), revealing around a cell, the mask's save record (a run-length code in base64), the palette (Minecraft's
// map colours in its four shades), the per-cell and per-block colour rules and the 8-direction sector rule.
//
// No DOM and no imports: Node tests load it as it is (tools/gen_tests/minimap_core.mjs), and Classic never requests
// anything under src/gen/ through it (the sector rule is a copy of src/gen/sign.js's, compared by that test).

export const BLOCK = 4;            // cells per block side
export const REVEAL = 13;          // cells: a block whose centre is this close is revealed
const REVEAL2 = REVEAL * REVEAL;

// palette: index = class * 4 + shade; shade 0 LOW, 1 NORMAL, 2 HIGH, 3 LOWEST (Minecraft's brightness ids)
export const LOW = 0, NORMAL = 1, HIGH = 2, LOWEST = 3;
export const FOG_A = 252, FOG_B = 253, PENDING = 254;
export const UNEXPLORED = 0;       // overview bytes: class 0 is reserved

// ---------------------------------------------------------------- the mask
export class Mask {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.bits = new Uint8Array((w * h + 7) >> 3);
    this.n = 0;                    // blocks set
    this.ver = 0;                  // bumped on every change (the save record is cached by it)
  }
  get(bx, by) {
    if (bx < 0 || by < 0 || bx >= this.w || by >= this.h) return false;
    const k = by * this.w + bx;
    return ((this.bits[k >> 3] >> (k & 7)) & 1) === 1;
  }
  getK(k) { return ((this.bits[k >> 3] >> (k & 7)) & 1) === 1; }
  // true when the block was not set before
  set(bx, by) {
    if (bx < 0 || by < 0 || bx >= this.w || by >= this.h) return false;
    const k = by * this.w + bx, m = 1 << (k & 7);
    if (this.bits[k >> 3] & m) return false;
    this.bits[k >> 3] |= m; this.n++; this.ver++;
    return true;
  }
  count() { return this.n; }
  recount() { let n = 0; for (let i = 0; i < this.bits.length; i++) { let v = this.bits[i]; while (v) { v &= v - 1; n++; } } this.n = n; return n; }
  // FNV-1a over the bits, hex
  hash() {
    let h = 2166136261;
    for (let i = 0; i < this.bits.length; i++) { h ^= this.bits[i]; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
export const maskSize = (W, H) => ({ w: Math.ceil(W / BLOCK), h: Math.ceil(H / BLOCK) });

// Reveal the blocks around cell (x, y): every block whose centre (bx * 4 + 2, by * 4 + 2) lies within REVEAL cells
// and which overlaps `rect` ({ x, y, w, h } in cells) is set; onNew(bx, by) for each new one. Returns how many.
export function revealAround(mask, x, y, rect, onNew) {
  if (!rect) return 0;
  const B = BLOCK, rx0 = rect.x, ry0 = rect.y, rx1 = rect.x + rect.w - 1, ry1 = rect.y + rect.h - 1;
  const bx0 = Math.max(Math.floor((x - REVEAL - 2) / B), Math.floor(rx0 / B), 0), bx1 = Math.min(Math.floor((x + REVEAL + 2) / B), Math.floor(rx1 / B), mask.w - 1);
  const by0 = Math.max(Math.floor((y - REVEAL - 2) / B), Math.floor(ry0 / B), 0), by1 = Math.min(Math.floor((y + REVEAL + 2) / B), Math.floor(ry1 / B), mask.h - 1);
  let n = 0;
  for (let by = by0; by <= by1; by++) {
    const dy = by * B + 2 - y;
    for (let bx = bx0; bx <= bx1; bx++) {
      const dx = bx * B + 2 - x;
      if (dx * dx + dy * dy > REVEAL2) continue;
      if (mask.set(bx, by)) { n++; if (onNew) onNew(bx, by); }
    }
  }
  return n;
}

// ---------------------------------------------------------------- the save record
// { v: 1, b: 4, w, h, n, m, k }: n the byte length of the bits, m the base64 of the run-length code (repeated
// `varint zeros, varint k, k literal bytes`), k the reached-Kanto flag.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; return t; })();
export function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i], b = i + 1 < u8.length ? u8[i + 1] : 0, c = i + 2 < u8.length ? u8[i + 2] : 0;
    const v = (a << 16) | (b << 8) | c;
    s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (i + 1 < u8.length ? B64[(v >> 6) & 63] : '=') + (i + 2 < u8.length ? B64[v & 63] : '=');
  }
  return s;
}
// null when the text is not base64
export function fromB64(s) {
  if (typeof s !== 'string' || s.length % 4) return null;
  let pad = 0;
  if (s.endsWith('==')) pad = 2; else if (s.endsWith('=')) pad = 1;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const ch = s.charCodeAt(i + k);
      if (ch === 61 && i + k >= s.length - pad) { v <<= 6; continue; }
      const d = ch < 128 ? B64I[ch] : -1;
      if (d < 0) return null;
      v = (v << 6) | d;
    }
    if (o < out.length) out[o++] = (v >> 16) & 255;
    if (o < out.length) out[o++] = (v >> 8) & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}
function putVar(arr, v) { while (v >= 128) { arr.push((v & 127) | 128); v = Math.floor(v / 128); } arr.push(v); }
// the run-length code of a byte array: zero runs and literal runs (a literal run ends at 4 or more zeros in a row)
export function rleEncode(u8) {
  const out = [];
  let i = 0;
  const n = u8.length;
  while (i < n) {
    let z = 0;
    while (i + z < n && u8[i + z] === 0) z++;
    i += z;
    let j = i;
    while (j < n) {
      if (u8[j] === 0) { let r = 0; while (j + r < n && u8[j + r] === 0 && r < 4) r++; if (r >= 4 || j + r >= n) break; j += r; } else j++;
    }
    putVar(out, z); putVar(out, j - i);
    for (let k = i; k < j; k++) out.push(u8[k]);
    i = j;
  }
  return Uint8Array.from(out);
}
// null when the code is malformed or does not total exactly n bytes
export function rleDecode(code, n) {
  if (!code) return null;
  const out = new Uint8Array(n);
  let p = 0, o = 0;
  const getVar = () => {
    let v = 0, mul = 1;
    for (let k = 0; k < 5; k++) {
      if (p >= code.length) return -1;
      const b = code[p++];
      v += (b & 127) * mul; mul *= 128;
      if (!(b & 128)) return v;
    }
    return -1;
  };
  while (p < code.length) {
    const z = getVar(); if (z < 0 || o + z > n) return null;
    o += z;
    const k = getVar(); if (k < 0 || o + k > n || p + k > code.length) return null;
    out.set(code.subarray(p, p + k), o); p += k; o += k;
  }
  return o === n ? out : null;
}
export function encode(mask, k = false) {
  return { v: 1, b: BLOCK, w: mask.w, h: mask.h, n: mask.bits.length, m: toB64(rleEncode(mask.bits)), k: !!k };
}
// { mask, k } or null (wrong version, block size, dimensions, byte count, or a code that does not total n); never throws
export function decode(rec, w, h) {
  try {
    if (!rec || typeof rec !== 'object' || rec.v !== 1 || rec.b !== BLOCK || rec.w !== w || rec.h !== h) return null;
    const n = (w * h + 7) >> 3;
    if (rec.n !== n || typeof rec.m !== 'string') return null;
    const bits = rleDecode(fromB64(rec.m), n);
    if (!bits) return null;
    // bits past w * h must be clear
    const tail = w * h;
    for (let k = tail; k < n * 8; k++) if ((bits[k >> 3] >> (k & 7)) & 1) return null;
    const mask = new Mask(w, h);
    mask.bits = bits; mask.recount();
    return { mask, k: !!rec.k };
  } catch (e) { return null; }
}
// Classic's sibling record belongs to the loaded save only when its play time matches (3.12)
export const siblingOk = (rec, pt) => !!rec && typeof rec === 'object' && typeof rec.pt === 'number' && rec.pt === pt;

// co-op guests' masks (3.12): the key and a least-recently-written list of at most `max` keys
export function guestKey(type, gen, seed) {
  return type === 'classic' ? 'poke-redstone-map:classic' : `poke-redstone-map:${type}:${gen | 0}:${seed | 0}`;
}
export function lruTouch(list, key, max = 4) {
  const l = (Array.isArray(list) ? list : []).filter((k) => typeof k === 'string' && k !== key);
  l.push(key);
  const drop = [];
  while (l.length > max) drop.push(l.shift());
  return { list: l, drop };
}

// ---------------------------------------------------------------- the 8-direction sector (a copy of src/gen/sign.js's)
// dx, dy in cells with y growing downward (north is dy < 0): 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW
export function sector8(dx, dy) {
  const ax = Math.abs(dx), ay = Math.abs(dy), t = Math.SQRT2 - 1;
  if (ay <= ax * t) return dx > 0 ? 2 : 6;
  if (ax <= ay * t) return dy < 0 ? 0 : 4;
  if (dx > 0) return dy < 0 ? 1 : 3;
  return dy > 0 ? 5 : 7;
}

// ---------------------------------------------------------------- the palette
// rgba: Uint32Array(256) in the platform's ImageData byte order (little-endian: 0xAABBGGRR); css: the same as strings
export function expandPalette(mc, littleEndian = true) {
  const rgba = new Uint32Array(256), css = new Array(256).fill('#000000'), rgb = new Array(256).fill(null);
  const put = (i, r, g, b) => {
    r = Math.max(0, Math.min(255, r | 0)); g = Math.max(0, Math.min(255, g | 0)); b = Math.max(0, Math.min(255, b | 0));
    rgba[i] = littleEndian ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
    css[i] = '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    rgb[i] = [r, g, b];
  };
  const shades = (mc && mc.shades) || [180, 220, 255, 135];
  const classes = (mc && mc.classes) || [];
  for (let c = 1; c < classes.length && c < 63; c++) {
    const [r, g, b] = classes[c][1];
    for (let s = 0; s < 4; s++) put(c * 4 + s, Math.floor((r * shades[s]) / 255), Math.floor((g * shades[s]) / 255), Math.floor((b * shades[s]) / 255));
  }
  const hex = (h, d) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const v = m ? parseInt(m[1], 16) : d; return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
  const fog = (mc && mc.fog) || ['#2a2318', '#30281b'];
  put(FOG_A, ...hex(fog[0], 0x2a2318)); put(FOG_B, ...hex(fog[1], 0x30281b)); put(PENDING, ...hex(mc && mc.pending, 0x4a3f2c));
  put(0, ...hex(fog[0], 0x2a2318));
  return { rgba, css, rgb };
}

// ---------------------------------------------------------------- per-entry classes
// A Uint8Array per atlas entry (class | 0x80 for tall grass) from mapcolor.json: Classic's table for world.json's
// entries, the generated table after them; an entry past both (Track SIGN's sign entries), or tables that do not
// match the loaded ones (counts, the generated atlas's hash), take their material's class.
export function entryClasses(entries, mc, opts = {}) {
  const n = entries.length, out = new Uint8Array(n);
  const mat = (mc && mc.mat) || {}, fallback = mat.stone || 1;
  for (let t = 0; t < n; t++) { const e = entries[t], c = e ? mat[e[4]] : null; out[t] = c != null ? c : fallback; }
  const genBase = opts.genBase != null ? opts.genBase : n;
  let exact = !!mc;
  const classic = mc && mc.classic ? fromB64(mc.classic.b64) : null;
  if (classic && classic.length === mc.classic.n && mc.classic.n === Math.min(genBase, n)) out.set(classic);
  else exact = false;
  if (opts.gen) {
    const g = mc && mc.gen ? fromB64(mc.gen.b64) : null;
    if (g && g.length === mc.gen.n && mc.gen.n === opts.genCount && mc.gen.base === genBase && genBase + g.length <= n
      && (!opts.atlasHash || mc.gen.atlasHash === opts.atlasHash)) out.set(g, genBase);
    else exact = false;
  }
  return { cls: out, exact };
}

// ---------------------------------------------------------------- per-cell and per-block colours
// world: { W, H, grid, zone, area, cstate (null in Classic), blocks (Map), maps, layout, kmask?, isKantoCell? }
// tables: { cls (entryClasses), heights (Uint8Array per class), water (class id), blockCls ({ id: class }),
//           areaShade (Uint8Array per area value: the water shade), coarse: { n, st, code } | null, coarseCls (Uint8Array(256)),
//           ox (the overworld's plane x), CW (data chunks per row), path (its class), farm (the farmland decoration code) }
export function makeClassifier(world, t) {
  const W = world.W, grid = world.grid, zone = world.zone, area = world.area, cstate = world.cstate || null;
  const cls = t.cls, H8 = t.heights, WATER = t.water, blockCls = t.blockCls || {}, areaShade = t.areaShade, CW = t.CW || 63;
  const kmask = world.kmask || null;
  const blocks = world.blocks;
  const isK = kmask && world.isKantoCell ? (x, y) => world.isKantoCell(x, y) : null;
  const coarse = t.coarse && t.coarse.code && t.coarse.n ? t.coarse : null, coarseCls = t.coarseCls, ox = t.ox || 0;
  const ready = (x, y) => !cstate || cstate[(y >> 5) * CW + (x >> 5)] === 2 || (isK !== null && isK(x, y));
  // a cell's class, its placed block first (glass and other see-through blocks show the ground)
  // a village farm's farmland (a generated decoration code) shows as tilled earth
  const deco = t.farm ? world.deco : null, FARM = t.farm || 0, bover = world.bover || null, PATHC = t.path || 0;
  const farmAt = (i, x, y) => {
    const d = deco[(y >> 5) * CW + (x >> 5)];
    return !!d && d[(y & 31) * 32 + (x & 31)] === FARM && !(bover && bover.has(i));
  };
  // a cell's class: a placed block first (flush ones too: a dug path, farmland, a bridge; glass and other
  // see-through blocks have no class and show the ground), then the tile's
  const clsAt = (i, x, y) => {
    if (blocks.size) {
      const b = blocks.get(i);
      if (b && !b.gen) { const c = blockCls[b.id]; if (c) return c; }
    }
    if (deco && PATHC && farmAt(i, x, y)) return PATHC;
    return cls[grid[i]] & 127;
  };
  const coarsePal = (x, y) => {
    if (!coarse) return PENDING;
    const n = coarse.n, st = coarse.st || 8;
    const i = Math.min(n - 1, Math.max(0, Math.floor((x - ox + st / 2) / st))), j = Math.min(n - 1, Math.max(0, Math.floor((y + st / 2) / st)));
    const c = coarseCls[coarse.code[j * n + i]];
    return c ? c * 4 + LOW : PENDING;
  };
  // the palette index of cell i (x, y)
  function cellPal(i, x = i % W, y = (i - (i % W)) / W) {
    if (!ready(x, y)) return coarsePal(x, y);
    if (zone[i] === 2) return FOG_A + ((x + y) & 1);
    let c, tall = false;
    const b = blocks.size ? blocks.get(i) : undefined;
    if (b && !b.gen && blockCls[b.id]) c = blockCls[b.id];
    else if (deco && PATHC && farmAt(i, x, y)) c = PATHC;
    else { const e = cls[grid[i]]; c = e & 127; tall = (e & 128) !== 0; }
    if (c === WATER) return c * 4 + (areaShade ? areaShade[area[i]] : NORMAL);
    if (tall) return c * 4 + LOW;
    if (y <= 0) return c * 4 + NORMAL;
    const j = i - W;
    if (zone[j] === 2 || !ready(x, y - 1)) return c * 4 + NORMAL;
    const h = H8[c], hn = H8[clsAt(j, x, y - 1)];
    return c * 4 + (h > hn ? HIGH : h < hn ? LOW : NORMAL);
  }
  // A block's overview byte (bx, by in blocks): the majority class of its 16 cells, where water wins with 6 of 16,
  // path with 6 and a building with 4 (thin features survive); ties go to the lowest class. Void blocks: fog.
  const cnt = new Uint8Array(64), shadeOf = new Uint8Array(64), seen = new Uint8Array(16);
  const PATH = t.path || 0, building = t.building || null;
  // out16 (optional, a Uint8Array(16)): each cell's palette index, row by row (fog past the plane's edge), so a caller
  // painting the block's pixels need not classify its cells twice
  function blockPal(bx, by, out16) {
    let any = 0, pend = 0, pendPal = PENDING, ns = 0;
    for (let yy = 0; yy < BLOCK; yy++) {
      const y = by * BLOCK + yy;
      for (let xx = 0; xx < BLOCK; xx++) {
        const x = bx * BLOCK + xx;
        let p;
        if (x >= W || y >= world.H) p = FOG_A + ((x + y) & 1);
        else if (!ready(x, y)) { p = coarsePal(x, y); pend++; pendPal = p; }
        else {
          p = cellPal(y * W + x, x, y);
          if (p < FOG_A) {
            const c = p >> 2;
            if (!cnt[c]) { shadeOf[c] = p & 3; seen[ns++] = c; }
            cnt[c]++; any++;
          }
        }
        if (out16) out16[yy * BLOCK + xx] = p;
      }
    }
    let res;
    if (!any) res = pend ? pendPal : FOG_A;
    else if (WATER && cnt[WATER] >= 6) res = WATER * 4 + shadeOf[WATER];
    else if (PATH && cnt[PATH] >= 6) res = PATH * 4 + NORMAL;
    else {
      let bc = 0, bn = 0, tot = 0, best = 0, mn = 0;
      for (let k = 0; k < ns; k++) {
        const c = seen[k], n = cnt[c];
        if (building && building[c]) { tot += n; if (n > bn || (n === bn && c < bc)) { bn = n; bc = c; } }
        if (n > mn || (n === mn && c < best)) { mn = n; best = c; }
      }
      res = building && tot >= 4 ? bc * 4 + NORMAL : best * 4 + (best === WATER ? shadeOf[WATER] : NORMAL);
    }
    for (let k = 0; k < ns; k++) cnt[seen[k]] = 0;
    return res;
  }
  return { cellPal, blockPal, ready, clsAt };
}

// the overview's majority rule on its own (Node tests): counts of 16 classes -> class
export function majority16(classes, t) {
  const cnt = new Uint8Array(64);
  for (const c of classes) if (c > 0 && c < 64) cnt[c]++;
  if (t.water && cnt[t.water] >= 6) return t.water;
  if (t.path && cnt[t.path] >= 6) return t.path;
  if (t.building) { let bc = 0, bn = 0, tot = 0; for (let c = 1; c < 64; c++) if (t.building[c]) { tot += cnt[c]; if (cnt[c] > bn) { bn = cnt[c]; bc = c; } } if (tot >= 4) return bc; }
  let best = 0, bn = 0;
  for (let c = 1; c < 64; c++) if (cnt[c] > bn) { bn = cnt[c]; best = c; }
  return best;
}
