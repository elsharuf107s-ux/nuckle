// The minimap (minimap-design.md section 3; Track MAP): Minecraft's map in the top-left corner of the HUD, the land
// Steve has seen in Minecraft's map colours, the rest dark, with his pointer, the spawn or home banner, discovered
// villages, the way into Kanto (an edge arrow until he has been there), co-op teammates and the world border.
//
// main.js imports this lazily (with src/ui/mapscreen.js) at the first frame, never under ?video. It binds to G.world
// (again whenever a co-op guest's world replaces it), keeps the explored mask (src/mapcore.js) and draws it
// incrementally: 32 x 32 cell tiles (the generator's data chunks) built on demand into an LRU of 64; a change (cells
// revealed, a chunk generated, a cell edited) only marks its 4 x 4 block dirty, and the dirty blocks are recoloured
// once a frame inside a 0.3 ms budget, so bursts of edits never make a long frame. The full map (mapscreen.js) reads
// the overview: one palette byte per block.
//
// It never imports src/gen/ or the co-op modules (only net/flag.js, which single-player loads anyway), and it adds no
// network traffic: teammates' dots come from the avatars co-op already keeps. Nothing here throws to the game loop.
import { A } from './assets.js';
import { G } from './game.js';
import { NET } from './net/flag.js';
import * as MC from './mapcore.js';
import { DECO_IDS } from './world.js';

const PREF_KEY = 'poke-redstone-minimap', SIB_KEY = 'poke-redstone-v1-map', GUEST_IDX = 'poke-redstone-map:guests';
// the HUD's geometry in canvas pixels (480 x 320): the frame 81 x 81 at (4, 4), the map 73 x 73 at (8, 8)
export const FRAME = { x: 4, y: 4, w: 81, h: 81 }, INNER = { x: 8, y: 8, w: 73, h: 73 };
export const TAP = { x: 0, y: 0, w: 88, h: 88 }, BUTTON = { x: 4, y: 4, w: 20, h: 20 }, TAP_BUTTON = { x: 0, y: 0, w: 40, h: 40 };
const HALF = 36, CX = INNER.x + HALF, CY = INNER.y + HALF;   // Steve's pixel (44, 44)
const T = 32, LRU = 64, BUDGET = 0.3, MARGIN = 16, VS = INNER.w + 2 * MARGIN;
const REVEAL_STATES = new Set(['play', 'msg', 'screen', 'sleep', 'dead']);
const DIR_NAME = { up: 'player_up', right: 'player_right', down: 'player_down', left: 'player_left' };
const CLIP = { x0: INNER.x, y0: INNER.y, x1: INNER.x + INNER.w, y1: INNER.y + INNER.h };

let MAPC = null, ICONS = null, BG = null, loading = null;
// mapcolor.json, the icon strip and the parchment; resolves true when the colours are in (pictures are optional)
export function loadMinimap() {
  if (loading) return loading;
  const img = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; });
  loading = Promise.all([
    fetch('assets/world/mapcolor.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    img('assets/mc/map/icons.png'), img('assets/mc/map/background.png'),
  ]).then(([m, i, b]) => { MAPC = m; ICONS = i; BG = b; return !!m; });
  return loading;
}
export const mapColors = () => MAPC;
export const mapIcons = () => ICONS;
export const mapBackground = () => BG;
const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* none */ } },
};
export const touchDevice = () => { try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } };
function canvas(w, h, soft = false) { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d', soft ? { willReadFrequently: true } : undefined); g.imageSmoothingEnabled = false; return [c, g]; }
// Minecraft's nine-slice with tiled edges (the parchment's ragged border stays crisp at any size)
export function nine(g, img, x, y, w, h, b) {
  const sw = img.width, sh = img.height, cw = sw - 2 * b, ch = sh - 2 * b;
  const tile = (sx, sy, tw, th, dx, dy, dw, dh) => {
    for (let oy = 0; oy < dh; oy += th) for (let ox = 0; ox < dw; ox += tw) {
      const ww = Math.min(tw, dw - ox), hh = Math.min(th, dh - oy);
      g.drawImage(img, sx, sy, ww, hh, dx + ox, dy + oy, ww, hh);
    }
  };
  tile(0, 0, b, b, x, y, b, b); tile(sw - b, 0, b, b, x + w - b, y, b, b); tile(0, sh - b, b, b, x, y + h - b, b, b); tile(sw - b, sh - b, b, b, x + w - b, y + h - b, b, b);
  tile(b, 0, cw, b, x + b, y, w - 2 * b, b); tile(b, sh - b, cw, b, x + b, y + h - b, w - 2 * b, b);
  tile(0, b, b, ch, x, y + b, b, h - 2 * b); tile(sw - b, b, b, ch, x + w - b, y + b, b, h - 2 * b);
  tile(b, b, cw, ch, x + b, y + b, w - 2 * b, h - 2 * b);
}
export function parchment(g, x, y, w, h, b = 8) {
  if (BG) { nine(g, BG, x, y, w, h, Math.min(b, Math.floor(w / 2), Math.floor(h / 2))); return; }
  g.fillStyle = '#998770'; g.fillRect(x, y, w, h); g.fillStyle = '#d6be96'; g.fillRect(x + 2, y + 2, w - 4, h - 4);
}
// an 8 x 8 icon of the strip (mapcolor.json icons names it)
export function icon(g, name, x, y) {
  const k = MAPC && MAPC.icons ? MAPC.icons[name] : null;
  if (ICONS && k != null) g.drawImage(ICONS, k * 8, 0, 8, 8, Math.round(x), Math.round(y), 8, 8);
}
// ...cut to a rectangle { x0, y0, x1, y1 } (no canvas clip state to save and restore)
function iconClip(g, name, x, y, c) {
  const k = MAPC && MAPC.icons ? MAPC.icons[name] : null;
  if (!ICONS || k == null) return;
  x = Math.round(x); y = Math.round(y);
  const l = Math.max(x, c.x0), t = Math.max(y, c.y0), r = Math.min(x + 8, c.x1), b = Math.min(y + 8, c.y1);
  if (r > l && b > t) g.drawImage(ICONS, k * 8 + l - x, t - y, r - l, b - t, l, t, r - l, b - t);
}

const inRect = (m, r) => !!m && m.x >= r.x && m.y >= r.y && m.x < r.x + r.w && m.y < r.y + r.h;
// a teammate dot's rim: black, or light grey around a dark colour (Kai's #351939 is as dark as the fog)
const RIMS = new Map();
function rimOf(c) {
  let r = RIMS.get(c);
  if (!r) {
    const m = /^#([0-9a-f]{6})$/i.exec(c), v = m ? parseInt(m[1], 16) : 0xffffff;
    r = 0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255) < 72 ? '#d8d8d8' : '#000000';
    RIMS.set(c, r);
  }
  return r;
}

export class MiniMap {
  constructor() {
    this.world = null; this.mask = null; this.k = false; this.kseen = false;
    this.stats = { frames: 0, ms: 0, maxMs: 0, builds: 0, flushes: 0, flushed: 0, reveals: 0, revealed: 0, updMs: 0, drawMs: 0, cur: 0 };
    this.skipNext = false; this.override = null; this.lastShown = null;
    this.prefOn = store.get(PREF_KEY) !== 'off';
    this.pal = MC.expandPalette(MAPC, LE);
    this.guest = null; this.screenOpen = false;
    const [fc, fg] = canvas(FRAME.w, FRAME.h, true);
    parchment(fg, 0, 0, FRAME.w, FRAME.h, 8);
    fg.clearRect(INNER.x - FRAME.x, INNER.y - FRAME.y, INNER.w, INNER.h);
    this.frameCv = fc;
    const [bc, bg] = canvas(BUTTON.w, BUTTON.h, true);
    parchment(bg, 0, 0, BUTTON.w, BUTTON.h, 4);
    this.buttonCv = bc; this.buttonG = bg; this.buttonIcon = false;
    // The map's pixels are composed in memory from the tiles into a view a margin wider than the map (VS x VS) and
    // handed to a software canvas (willReadFrequently) with one putImageData: a putImageData into a GPU canvas waits
    // for the GPU, up to a millisecond in the middle of a frame. Each frame draws the map's 73 x 73 window of it, so
    // the view is composed again only when a tile changed or Steve walked out of the margin; drawing an unchanged
    // software canvas reuses its uploaded texture. The fog is a 1-pixel checker on the plane's parity: two rows, one
    // starting on each colour.
    const [vc, vg] = canvas(VS, VS, true);
    this.viewCv = vc; this.viewG = vg; this.viewImg = vg.createImageData(VS, VS); this.viewU = new Uint32Array(this.viewImg.data.buffer);
    this.fogRows = [0, 1].map((p) => Uint32Array.from({ length: VS }, (_, x) => this.pal.rgba[MC.FOG_A + ((x + p) & 1)]));
    this.vx0 = 0; this.vy0 = 0; this.vReg = null; this.vVer = -1; this.viewVer = 0; this.found = 0; this.mk = null; this.mkList = [];
    this.onNewB = (bx, by) => this.onNew(bx, by);
    this.cells16 = new Uint8Array(16);
    if (typeof addEventListener === 'function') addEventListener('pagehide', () => { try { this.saveGuest(true); } catch (e) { /* never */ } });
  }
  pref() { return this.prefOn; }
  setPref(on) { this.prefOn = !!on; store.set(PREF_KEY, on ? 'on' : 'off'); }

  // ---------------------------------------------------------------- binding to a world
  bind(world) {
    this.world = world;
    this.bound = false;
    if (!world) return;
    const L = world.layout, gen = !!L.gen, W = world.W, H = world.H;
    const { w, h } = MC.maskSize(W, H);
    this.BW = w; this.BH = h;
    this.mask = new MC.Mask(w, h); this.k = false; this.kseen = false;
    this.tiles = new Map(); this.dirty = new Set(); this.ov = new Uint8Array(w * h); this.viewVer++; this.tileGen = (this.tileGen || 0) + 1; this.viewTiles = -1;
    this.ovCv = null; this.ovImg = null; this.ovU = null; this.ovBox = null; this.ovAll = false; this.ovCursor = 0;
    this.lastCell = -1; this.regionCache = null; this.lastOut = null; this.guest = null; this.guestKey = null; this.guestT = 0; this.guestVer = -1;
    this.saved = { ver: -1, k: null, rec: null };
    // the colour tables
    const mc = MAPC || {}, classes = mc.classes || [];
    const id = (name) => { const k = classes.findIndex((c) => c[0] === name); return k > 0 ? k : 0; };
    const ec = MC.entryClasses(world.entries, MAPC, gen ? { gen: true, genBase: world.genBase, genCount: A.terrain ? A.terrain.entries.length : 0, atlasHash: A.terrain && A.terrain.atlasHash } : { genBase: world.genBase });
    if (!ec.exact) console.warn('minimap: mapcolor.json does not match the loaded tile tables; colours by material');
    const heights = new Uint8Array(64); classes.forEach((c, k) => { if (k < 64) heights[k] = c[2]; });
    const building = new Uint8Array(64); classes.forEach((c, k) => { if (k < 64 && /^(roof_|wall_|brick)/.test(c[0])) building[k] = 1; });
    const water = id('water');
    const areaShade = new Uint8Array(world.maps.length + 1).fill(gen ? MC.NORMAL : MC.LOW);
    world.maps.forEach((m, k) => { areaShade[k + 1] = m.gen ? ((mc.depth || {})[m.id] ?? MC.NORMAL) : MC.LOW; });
    const coarseCls = MC.fromB64(mc.coarse || '') || new Uint8Array(256);
    this.tables = { cls: ec.cls, heights, water, blockCls: mc.blocks || {}, areaShade, coarseCls, ox: L.ox, CW: 63, path: id('path'), building,
      farm: gen && world.deco ? Math.max(0, DECO_IDS.indexOf('farmland')) : 0,
      coarse: gen && world.gen && world.gen.coarse ? world.gen.coarse : null };
    this.C = MC.makeClassifier(world, this.tables);
    this.cellPal = this.C.cellPal; this.blockPal = this.C.blockPal;
    world.mapHook = (cx, cy) => this.onChunk(cx, cy);
    world.onChange = (x, y) => this.onCell(x, y);
    // Kanto (a Kanto World): its blocks (any block holding one of Kanto's own cells), its label's place, the way in
    this.kanto = L.kind === 'kanto' && world.kmask && L.kanto ? L.kanto : null;
    this.kb = null; this.fallbackTarget = null;
    if (this.kanto) {
      const kb = new Uint8Array(w * h), km = world.kmask, ow = world.outdoor.w, oh = world.outdoor.h, K = this.kanto;
      for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) if (km[y * ow + x]) kb[((K.y + y) >> 2) * w + ((K.x + x) >> 2)] = 1;
      this.kb = kb;
      this.fallbackTarget = this.findFallbackTarget();
    }
    // villages (the plan's records, overworld-local: + ox to plane x)
    this.villages = (world.meta && world.meta.genVillages ? world.meta.genVillages : []).map((v) => ({
      x: L.ox + Math.round(v.x), y: Math.round(v.y), style: v.style || 'plains',
      bx0: (L.ox + v.x0) >> 2, by0: v.y0 >> 2, bx1: (L.ox + v.x0 + v.w - 1) >> 2, by1: (v.y0 + v.h - 1) >> 2, found: false,
    }));
    this.found = 0;
    // a loaded mask (3.12): the generated save's own field, or Classic's sibling key tied to the save by play time
    const ld = G.mapLoad;
    if (ld && ld.world === world && !NET.boot && !NET.guest) {
      let rec = null;
      if (ld.v === 2) rec = ld.map;
      else if (ld.v === 1) { try { const r = JSON.parse(store.get(SIB_KEY) || 'null'); if (MC.siblingOk(r, ld.pt)) rec = r; } catch (e) { rec = null; } }
      if (rec) this.adopt(rec, ld.v === 1 ? 'the Classic map' : 'the map');
    }
    this.bound = true;
  }
  // a decoded record becomes the mask (an empty one when it is wrong in any way)
  adopt(rec, what) {
    const d = MC.decode(rec, this.BW, this.BH);
    if (!d) { console.warn('minimap: ' + what + ' record was not usable; starting with an empty map'); return false; }
    this.mask = d.mask; this.k = this.k || d.k;
    this.rescan();
    return true;
  }
  // what the mask implies: Kanto seen, villages found (after a load or a guest's merge)
  rescan() {
    const m = this.mask;
    this.kseen = false;
    if (this.kb) for (let k = 0; k < this.kb.length; k++) if (this.kb[k] && m.getK(k)) { this.kseen = true; break; }
    for (const v of this.villages) {
      v.found = false;
      for (let by = v.by0; by <= v.by1 && !v.found; by++) for (let bx = v.bx0; bx <= v.bx1; bx++) if (m.get(bx, by)) { v.found = true; break; }
    }
    this.found = this.villages.filter((v) => v.found).length;
    this.tiles.clear(); this.dirty.clear(); this.ov.fill(0); this.ovAll = false; this.ovCursor = 0; this.ovCv = null; this.ovImg = null; this.ovU = null; this.viewVer++; this.tileGen++;
  }
  // before Track SIGN's target exists: the nearest outer opening's out cell from the spawn by straight line, else
  // the nearest of Kanto's own cells sampled every 8 cells
  findFallbackTarget() {
    const w = this.world, sp = G.worldSpawn || { x: 0, y: 0 };
    let best = null, bd = Infinity;
    for (const o of (w.meta && w.meta.openings) || []) {
      if (!o || !Array.isArray(o.out) || (o.kind && o.kind !== 'outer')) continue;
      const d = (o.out[0] - sp.x) ** 2 + (o.out[1] - sp.y) ** 2;
      if (d < bd) { bd = d; best = { x: o.out[0], y: o.out[1] }; }
    }
    if (best) return best;
    const K = this.kanto, ow = w.outdoor.w, oh = w.outdoor.h, km = w.kmask;
    for (let y = 0; y < oh; y += 8) for (let x = 0; x < ow; x += 8) {
      if (!km[y * ow + x]) continue;
      const d = (K.x + x - sp.x) ** 2 + (K.y + y - sp.y) ** 2;
      if (d < bd) { bd = d; best = { x: K.x + x, y: K.y + y }; }
    }
    return best;
  }
  target() { const w = this.world; return (w && w.kantoTarget) || this.fallbackTarget; }

  // ---------------------------------------------------------------- marking (O(1): never recolour here, 3.6)
  onCell(x, y) {
    try {
      const bx = x >> 2, by = y >> 2;
      if (bx < 0 || by < 0 || bx >= this.BW || by >= this.BH) return;
      const k = by * this.BW + bx;
      if (this.mask.getK(k)) this.dirty.add(k);
      // the block below reads this cell for its relief
      if (((y + 1) & 3) === 0 && by + 1 < this.BH && this.mask.getK(k + this.BW)) this.dirty.add(k + this.BW);
    } catch (e) { /* the minimap's own */ }
  }
  onChunk(cx, cy) {
    const pcx = cx + (this.world.layout.ox >> 5), bw = this.BW;
    for (let by = cy * 8; by <= cy * 8 + 8 && by < this.BH; by++) for (let bx = pcx * 8; bx < pcx * 8 + 8 && bx < bw; bx++) {
      const k = by * bw + bx;
      if (this.mask.getK(k)) this.dirty.add(k);
    }
  }
  onNew(bx, by) {
    const k = by * this.BW + bx;
    this.dirty.add(k);
    if (this.kb && this.kb[k]) this.kseen = true;
    for (const v of this.villages) if (!v.found && bx >= v.bx0 && bx <= v.bx1 && by >= v.by0 && by <= v.by1) { v.found = true; this.found++; }
  }

  // ---------------------------------------------------------------- regions
  // the rectangle Steve's cell belongs to: the overworld outdoors, the room's map rectangle in a cave, field, the
  // Nether, the stronghold or The End; null inside buildings
  region(x, y) {
    const w = this.world, a = w.inside(x, y) ? w.area[y * w.W + x] : 0, out = w.isOutdoor(x, y);
    const c = this.regionCache;
    if (c && c.a === a && c.out === out) return c.r;
    let r = null;
    if (out) { const L = w.layout; r = { x: L.ox, y: L.oy, w: L.ow, h: L.oh, kind: 'outdoor', key: 'outdoor', name: null }; }
    else {
      const m = w.roomAt(x, y);
      if (m && m.kind !== 'indoor' && Number.isFinite(m.x) && Number.isFinite(m.w)) r = { x: m.x, y: m.y, w: m.w, h: m.h, kind: m.kind, key: m.id, name: m.name };
    }
    this.regionCache = { a, out, r };
    return r;
  }

  // ---------------------------------------------------------------- the frame's work
  // st: main.js's state. Reveals (when Steve's cell changed), the guest's periodic save, the dirty flush and the
  // view's missing tiles, inside the budget.
  update(dt, st) {
    const t0 = performance.now();
    this.lastShown = null;   // (set again by this frame's drawHud, if the frame draws the play view at all)
    try {
      const w = G.world;
      if (w !== this.world) this.bind(w);
      if (!this.bound || !MAPC) return;
      const P = G.P;
      if (REVEAL_STATES.has(st) && P) {
        if (this.guest === null) this.decideGuest();
        const cell = P.ty * w.W + P.tx;
        if (cell !== this.lastCell) {
          this.lastCell = cell;
          const r = this.region(P.tx, P.ty);
          if (r) {
            this.stats.reveals++;
            this.stats.revealed += MC.revealAround(this.mask, P.tx, P.ty, r, this.onNewB);
            if (r.kind === 'outdoor') this.lastOut = { x: P.tx, y: P.ty };
          }
          if (this.kanto && !this.k && w.isKantoCell(P.tx, P.ty)) this.k = true;
        }
      }
      if (this.guest) { this.guestT += dt; if (this.guestT >= 30) { this.guestT = 0; this.saveGuest(false); } }
      const end = t0 + BUDGET, t1 = performance.now();
      this.flush(end);
      const t2 = performance.now();
      if (this.wantView(st)) this.ensureView(end);
      if (!this.ovAll) this.fillOverview(end);
      const la = this.stats.last || (this.stats.last = [0, 0, 0]);   // (reveal, flush, tiles: the last frame's ms; no garbage a frame)
      la[0] = t1 - t0; la[1] = t2 - t1; la[2] = performance.now() - t2;
    } finally {
      const ms = performance.now() - t0;
      this.stats.frames++; this.stats.updMs += ms; this.stats.ms += ms; this.stats.cur = ms;
      if (ms > this.stats.maxMs) this.stats.maxMs = ms;
    }
  }
  wantView(st) {
    if (st !== 'play' && st !== 'msg') return false;
    if (this.override === false) return false;
    return this.override === true || this.prefOn;
  }
  // the dirty blocks: their tile pixels and overview bytes (the view is composed again when a tile changed)
  flush(end) {
    if (!this.dirty.size) return;
    const bw = this.BW;
    let n = 0;
    for (const k of this.dirty) {
      if (n && (n & 1) === 0 && performance.now() > end) break;
      this.dirty.delete(k);
      n++;
      const bx = k % bw, by = (k - bx) / bw, cells = this.cells16;
      const p = this.blockPal(bx, by, cells);
      this.ov[k] = p;
      if (this.ovU) { this.ovU[k] = this.pal.rgba[p]; this.growOvBox(bx, by); }
      const tk = (by >> 3) * 64 + (bx >> 3), t = this.tiles.get(tk);
      if (!t) continue;
      this.paintBlock(t, bx, by, cells);
      this.viewVer++;
    }
    this.stats.flushes++; this.stats.flushed += n;
  }
  growOvBox(bx, by) {
    const b = this.ovBox;
    if (!b) this.ovBox = { x0: bx, y0: by, x1: bx, y1: by };
    else { if (bx < b.x0) b.x0 = bx; if (by < b.y0) b.y0 = by; if (bx > b.x1) b.x1 = bx; if (by > b.y1) b.y1 = by; }
  }
  // one block's 16 cells into its tile's pixels (explored: their colours, or `cells`, the palettes blockPal just
  // worked out; not explored: the fog)
  paintBlock(t, bx, by, cells = null) {
    const w = this.world, W = w.W, u = t.u, rgba = this.pal.rgba, lx0 = (bx & 7) * 4, ly0 = (by & 7) * 4;
    const seen = this.mask.get(bx, by);
    for (let yy = 0; yy < 4; yy++) {
      const y = by * 4 + yy;
      for (let xx = 0; xx < 4; xx++) {
        const x = bx * 4 + xx, o = (ly0 + yy) * T + lx0 + xx;
        u[o] = !seen || x >= W || y >= w.H ? rgba[MC.FOG_A + ((x + y) & 1)] : cells ? rgba[cells[yy * 4 + xx]] : rgba[this.cellPal(y * W + x, x, y)];
      }
    }
  }
  // a tile: the 32 x 32 cells of one data chunk as pixels (no canvas: the view is composed from these)
  buildTile(tx, ty) {
    const t = { tx, ty, u: new Uint32Array(T * T) };
    for (let by = ty * 8; by < ty * 8 + 8; by++) for (let bx = tx * 8; bx < tx * 8 + 8; bx++) this.paintBlock(t, bx, by);
    this.tiles.set(ty * 64 + tx, t);
    this.viewVer++;
    while (this.tiles.size > LRU) { this.tiles.delete(this.tiles.keys().next().value); this.tileGen++; }
    this.stats.builds++;
    return t;
  }
  // the view's tiles, built while the budget lasts (at least one a frame); nothing to do while the view stays on the
  // same tiles and they are all there
  ensureView(end) {
    const P = G.P, cx0 = Math.round(P.fx) - HALF, cy0 = Math.round(P.fy) - HALF, w = this.world;
    const tx0 = Math.max(0, Math.floor(cx0 / T)), ty0 = Math.max(0, Math.floor(cy0 / T));
    const tx1 = Math.min(Math.ceil(w.W / T) - 1, Math.floor((cx0 + INNER.w - 1) / T)), ty1 = Math.min(Math.ceil(w.H / T) - 1, Math.floor((cy0 + INNER.h - 1) / T));
    const vk = ((ty0 * 64 + tx0) * 64 + tx1) * 64 + ty1;
    if (vk === this.viewTiles && this.viewTilesVer === this.tileGen) return;
    if (!this.region(P.tx, P.ty)) return;
    let built = 0;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const k = ty * 64 + tx, t = this.tiles.get(k);
      if (t) { this.tiles.delete(k); this.tiles.set(k, t); continue; }   // (recently used)
      if (built && performance.now() > end) { this.viewTiles = -1; return; }
      this.buildTile(tx, ty); built++;
    }
    this.viewTiles = vk; this.viewTilesVer = this.tileGen;
  }

  // ---------------------------------------------------------------- the HUD
  // visible: main.js's rules (3.11); the preference, the test override and the phone button decide the rest
  drawHud(ctx, visible) {
    const t0 = performance.now();
    try {
      if (this.skipNext) { this.skipNext = false; this.lastShown = null; return; }
      let mode = null;
      if (visible && this.bound && MAPC && this.world === G.world && this.override !== false) mode = this.override === true || this.prefOn ? 'map' : touchDevice() ? 'button' : null;
      if (mode === 'map' && !this.region(G.P.tx, G.P.ty)) mode = null;
      this.lastShown = mode;
      if (mode === 'map') this.drawMap(ctx);
      else if (mode === 'button') this.drawButton(ctx);
    } finally {
      const ms = performance.now() - t0;
      this.stats.drawMs += ms; this.stats.ms += ms; this.stats.cur += ms;
      if (this.stats.cur > this.stats.maxMs) this.stats.maxMs = this.stats.cur;
    }
  }
  drawButton(ctx) {
    if (!this.buttonIcon && ICONS) { icon(this.buttonG, 'player_up', 6, 6); this.buttonIcon = true; }
    ctx.drawImage(this.buttonCv, BUTTON.x, BUTTON.y);
  }
  // the 73 x 73 view from the tiles (fog where a tile is not built yet, outside the region and off the plane)
  compose(cx0, cy0, reg) {
    const u = this.viewU, N = VS, w = this.world, W = w.W, H = w.H, tiles = this.tiles;
    let rx0 = 0, ry0 = 0, rx1 = N, ry1 = N;
    if (reg) { rx0 = Math.max(0, reg.x - cx0); ry0 = Math.max(0, reg.y - cy0); rx1 = Math.min(N, reg.x + reg.w - cx0); ry1 = Math.min(N, reg.y + reg.h - cy0); }
    rx0 = Math.max(rx0, -cx0); rx1 = Math.min(rx1, W - cx0);
    for (let yy = 0; yy < N; yy++) {
      const y = cy0 + yy, row = yy * N;
      u.set(this.fogRows[(cx0 + y) & 1], row);
      if (yy < ry0 || yy >= ry1 || y < 0 || y >= H) continue;
      const tr = (y >> 5) * 64, ly = (y & 31) * T;
      for (let xx = rx0; xx < rx1;) {
        const x = cx0 + xx, lx = x & 31, n = Math.min(T - lx, rx1 - xx), t = tiles.get(tr + (x >> 5));
        if (t) u.set(t.u.subarray(ly + lx, ly + lx + n), row + xx);
        xx += n;
      }
    }
    this.viewG.putImageData(this.viewImg, 0, 0);
  }
  drawMap(ctx) {
    const P = G.P, I = INNER, sx = Math.round(P.fx), sy = Math.round(P.fy), cx0 = sx - HALF, cy0 = sy - HALF;
    const reg = this.region(P.tx, P.ty), rk = reg ? reg.key : '';
    if (this.vVer !== this.viewVer || this.vReg !== rk || cx0 < this.vx0 || cy0 < this.vy0 || cx0 + I.w > this.vx0 + VS || cy0 + I.h > this.vy0 + VS) {
      this.vx0 = cx0 - MARGIN; this.vy0 = cy0 - MARGIN; this.vVer = this.viewVer; this.vReg = rk;
      this.compose(this.vx0, this.vy0, reg);
      this.stats.renders = (this.stats.renders || 0) + 1;
    }
    ctx.drawImage(this.viewCv, cx0 - this.vx0, cy0 - this.vy0, I.w, I.h, I.x, I.y, I.w, I.h);
    const clip = CLIP, X = (x) => I.x + x - cx0, Y = (y) => I.y + y - cy0;
    // the world border (generated worlds, outdoors): a cyan line just outside the playable area, clipped to the map
    if (this.world.layout.gen && reg && reg.kind === 'outdoor') {
      const b = this.world.layout.border, lx = X(b.x0 - 1), rx = X(b.x1 + 1), ty = Y(b.y0 - 1), by = Y(b.y1 + 1);
      ctx.fillStyle = (MAPC && MAPC.border) || '#5fd3ff';
      const v0 = Math.max(ty, clip.y0), v1 = Math.min(by + 1, clip.y1), h0 = Math.max(lx, clip.x0), h1 = Math.min(rx + 1, clip.x1);
      if (v1 > v0) { if (lx >= clip.x0 && lx < clip.x1) ctx.fillRect(lx, v0, 1, v1 - v0); if (rx >= clip.x0 && rx < clip.x1) ctx.fillRect(rx, v0, 1, v1 - v0); }
      if (h1 > h0) { if (ty >= clip.y0 && ty < clip.y1) ctx.fillRect(h0, ty, h1 - h0, 1); if (by >= clip.y0 && by < clip.y1) ctx.fillRect(h0, by, h1 - h0, 1); }
    }
    // markers (the list is worked out again only when it can have changed)
    for (const m of this.hudMarkers(reg)) {
      if ((m.kind === 'spawn' || m.kind === 'home') && m.x === P.tx && m.y === P.ty) continue;   // (under his own pointer)
      iconClip(ctx, m.icon, X(m.x) - 4, Y(m.y) - 4, clip);
    }
    // teammates (co-op): a 3 x 3 dot in their colour with a 1-pixel rim (black, or light around a dark colour such as
    // Kai's, which would vanish into the fog) on their cell; past the edge, the same dot pinned just inside it
    if (NET.on) {
      for (const d of this.mates(reg)) {
        const px = Math.max(clip.x0 + 2, Math.min(clip.x1 - 3, X(d.x))), py = Math.max(clip.y0 + 2, Math.min(clip.y1 - 3, Y(d.y)));
        ctx.fillStyle = d.rim; ctx.fillRect(px - 2, py - 2, 5, 5);
        ctx.fillStyle = d.color; ctx.fillRect(px - 1, py - 1, 3, 3);
      }
    }
    // Kanto's way in (a Kanto World, outdoors, until Steve has stood in Kanto): the target marker on it when it is on
    // the map, else a red arrow at the map's edge toward it (the sign's 8-direction rule)
    const tg = this.kanto && !this.k && reg && reg.kind === 'outdoor' ? this.target() : null;
    if (tg) {
      const dx = tg.x - sx, dy = tg.y - sy;
      if (Math.abs(dx) <= HALF && Math.abs(dy) <= HALF) iconClip(ctx, 'target_point', X(tg.x) - 4, Y(tg.y) - 4, clip);
      else {
        const f = (HALF - 6) / Math.max(Math.abs(dx), Math.abs(dy));
        icon(ctx, 'arrow_' + MC.sector8(dx, dy), Math.round(CX + dx * f) - 3, Math.round(CY + dy * f) - 3);
      }
    }
    icon(ctx, DIR_NAME[P.dir] || 'player_down', CX - 4, CY - 4);
    ctx.drawImage(this.frameCv, FRAME.x, FRAME.y);
  }
  // the HUD's markers for a region, kept until the bed, the spawn, the villages found or the region change
  hudMarkers(reg) {
    const bed = G.spawnBed, sp = G.worldSpawn, k = this.mk;
    if (k && k[0] === reg && k[1] === (bed ? bed[0] : -1) && k[2] === (bed ? bed[1] : -1) && k[3] === (sp ? sp.x : -1) && k[4] === (sp ? sp.y : -1) && k[5] === this.found) return this.mkList;
    this.mk = [reg, bed ? bed[0] : -1, bed ? bed[1] : -1, sp ? sp.x : -1, sp ? sp.y : -1, this.found];
    this.mkList = this.markers(reg, true);
    return this.mkList;
  }
  // the region's markers: the home bed (red banner) or the spawn (white banner) when in the region; discovered
  // villages (outdoors); on the full map, Kanto's way in (always in a Kanto World)
  markers(reg, hud) {
    const out = [];
    if (!reg) return out;
    const inR = (x, y) => x >= reg.x && y >= reg.y && x < reg.x + reg.w && y < reg.y + reg.h;
    const bed = G.spawnBed;
    if (Array.isArray(bed) && inR(bed[0], bed[1])) out.push({ icon: 'red_banner', x: bed[0], y: bed[1], kind: 'home' });
    else if (G.worldSpawn && inR(G.worldSpawn.x, G.worldSpawn.y)) out.push({ icon: 'white_banner', x: G.worldSpawn.x, y: G.worldSpawn.y, kind: 'spawn' });
    if (reg.kind === 'outdoor') for (const v of this.villages) if (v.found) out.push({ icon: v.style + '_village', x: v.x, y: v.y, kind: 'village' });
    if (!hud && this.kanto && reg.kind === 'outdoor') { const t = this.target(); if (t) out.push({ icon: 'target_point', x: t.x, y: t.y, kind: 'kanto' }); }
    return out;
  }
  // the teammates to show: on the HUD, those in Steve's own place; on the full map (full), those in the region it
  // shows (indoors, it shows the overworld, so the teammates outdoors)
  mates(reg, full = false) {
    const out = [];
    if (!NET.on || !NET.s || !NET.s.avatars || !reg) return out;
    const skins = (MAPC && MAPC.skins) || {}, w = this.world, P = G.P;
    for (const av of NET.s.avatars.values()) {
      if (!av || !av.visibleNow || av.spectator || !Number.isInteger(av.tx)) continue;
      const out1 = w.isOutdoor(av.tx, av.ty);
      const show = full
        ? (reg.kind === 'outdoor' ? out1 : !out1 && av.tx >= reg.x && av.ty >= reg.y && av.tx < reg.x + reg.w && av.ty < reg.y + reg.h)
        : w.samePlace(av.tx, av.ty, P.tx, P.ty) || (out1 && w.isOutdoor(P.tx, P.ty));
      if (!show) continue;
      const color = skins[av.skin] || '#ffffff';
      out.push({ x: av.tx, y: av.ty, color, rim: rimOf(color), name: av.name });
    }
    return out;
  }
  // a tap or click on the minimap (or the phone button) as it was last drawn: a click or a lone tap (mouseL), or a
  // second finger's tap while the first holds the pad (input.js's tap2)
  tapped(input) {
    if (!this.lastShown) return false;
    const r = this.lastShown === 'map' ? TAP : TAP_BUTTON;
    if (input.just('mouseL') && input.mouse.inside !== false && inRect(input.mouse, r)) return true;
    return input.just('tap2') && inRect(input.tap2, r);
  }

  // ---------------------------------------------------------------- the full map's overview
  // every explored block's byte, then one RGBA pixel per block over the plane (fog where unexplored); kept while the
  // world lives and updated block by block by the flush
  overview() {
    if (!this.bound) return null;
    const w = this.BW, h = this.BH, m = this.mask, rgba = this.pal.rgba;
    if (!this.ovAll) this.fillOverview(Infinity);
    if (!this.ovCv) {
      const [cv, g] = canvas(w, h, true), img = g.createImageData(w, h), u = new Uint32Array(img.data.buffer), fog = rgba[MC.FOG_A];
      for (let k = 0; k < w * h; k++) u[k] = m.getK(k) && this.ov[k] ? rgba[this.ov[k]] : fog;
      g.putImageData(img, 0, 0);
      this.ovCv = cv; this.ovG = g; this.ovImg = img; this.ovU = u; this.ovBox = null;
    } else if (this.ovBox) {
      const b = this.ovBox;
      this.ovG.putImageData(this.ovImg, 0, 0, b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1);
      this.ovBox = null;
    }
    return this.ovCv;
  }
  // the overview bytes of explored blocks that have none yet (a loaded mask's): a few each frame in what is left of
  // the budget, so the full map opens at once later; the rest when it opens
  fillOverview(end) {
    const n = this.BW * this.BH, m = this.mask, bw = this.BW;
    let k = this.ovCursor || 0, work = 0;
    for (; k < n; k++) {
      if (!this.ov[k] && m.getK(k)) { const bx = k % bw; this.ov[k] = this.blockPal(bx, (k - bx) / bw); work += 64; }
      if (++work >= 4096) { work = 0; if (performance.now() > end) { this.ovCursor = k + 1; return; } }
    }
    this.ovCursor = 0; this.ovAll = true;
  }
  // the explored blocks' bounding box inside a region (in blocks), or null
  exploredBox(reg) {
    const m = this.mask, bx0 = Math.max(0, reg.x >> 2), by0 = Math.max(0, reg.y >> 2), bx1 = Math.min(this.BW - 1, (reg.x + reg.w - 1) >> 2), by1 = Math.min(this.BH - 1, (reg.y + reg.h - 1) >> 2);
    let b = null;
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      if (!m.get(bx, by)) continue;
      if (!b) b = { x0: bx, y0: by, x1: bx, y1: by };
      else { if (bx < b.x0) b.x0 = bx; if (bx > b.x1) b.x1 = bx; if (by < b.y0) b.y0 = by; if (by > b.y1) b.y1 = by; }
    }
    return b;
  }

  // ---------------------------------------------------------------- saving
  // the save record (cached until the mask or the Kanto flag changes); null when not bound to this world
  serialize(world) {
    if (!this.bound || !this.mask || world !== this.world || this.guest) return null;
    const s = this.saved;
    if (s.rec && s.ver === this.mask.ver && s.k === this.k) return s.rec;
    const rec = MC.encode(this.mask, this.k);
    this.saved = { ver: this.mask.ver, k: this.k, rec };
    return rec;
  }
  // Classic (3.12): the sibling key, written only after the save itself landed; never throws
  saveClassic(pt) {
    try {
      if (NET.guest || this.guest) return false;
      const rec = this.serialize(G.world);
      if (!rec) return false;
      if (!store.set(SIB_KEY, JSON.stringify({ ...rec, pt }))) { store.del(SIB_KEY); return false; }
      return true;
    } catch (e) { store.del(SIB_KEY); return false; }
  }
  // co-op guests (3.12): settled at the first reveal; the mask of this world's terrain from localStorage
  decideGuest() {
    this.guest = !!NET.guest;
    if (!this.guest) return;
    const w = this.world, wd = w.wd || {};
    this.guestKey = w.layout.gen ? MC.guestKey(wd.type || w.layout.kind, w.genVersion, w.seed) : MC.guestKey('classic');
    try { const r = JSON.parse(store.get(this.guestKey) || 'null'); if (r) this.adopt(r, 'the co-op map'); } catch (e) { /* empty */ }
    this.guestVer = this.mask.ver;
  }
  saveGuest(force) {
    if (!this.guest || !this.guestKey || !this.mask) return;
    if (this.mask.ver === this.guestVer) return;   // (unchanged since the last write; `force` is the page closing)
    void force;
    this.guestVer = this.mask.ver;
    const rec = MC.encode(this.mask, this.k);
    let idx = [];
    try { idx = JSON.parse(store.get(GUEST_IDX) || '[]'); } catch (e) { idx = []; }
    const { list, drop } = MC.lruTouch(idx, this.guestKey, 4);
    for (const k of drop) store.del(k);
    store.set(this.guestKey, JSON.stringify(rec));
    store.set(GUEST_IDX, JSON.stringify(list));
  }

  // ---------------------------------------------------------------- tests (window.__rs.minimap)
  info() {
    const r = this.world && G.P ? this.region(G.P.tx, G.P.ty) : null;
    return { on: this.prefOn, shown: this.lastShown, k: this.k, kseen: this.kseen, explored: this.mask ? this.mask.count() : 0, hash: this.mask ? this.mask.hash() : null,
      region: r ? { x: r.x, y: r.y, w: r.w, h: r.h, kind: r.kind, key: r.key } : null, override: this.override, guest: this.guest, guestKey: this.guestKey,
      villages: (this.villages || []).filter((v) => v.found).map((v) => [v.x, v.y, v.style]), target: this.target ? this.target() : null,
      tiles: this.tiles ? this.tiles.size : 0, dirty: this.dirty ? this.dirty.size : 0, stats: { ...this.stats } };
  }
}
