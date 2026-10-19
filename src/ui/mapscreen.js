// The full map (minimap-design.md 3.9; Track MAP): the explored part of the region Steve is in (the overworld, a cave
// floor, the Nether, the stronghold, The End) scaled to fit on Minecraft's parchment, with the world border, the
// markers, Steve, and a "Minimap: ON/OFF" button. A screen for main.js's 'screen' state (the world keeps running):
// update(dt, input), draw(ctx), close(), done, kind 'map'.
//
// Controls: arrows pan by a quarter view (held: every 4 frames); A (Z) zooms in, wrapping from 4 to 0.5 canvas pixels
// per block; the mouse wheel zooms; START (Enter), or a click or tap on the button, switches the minimap; B (X, Esc)
// or J closes. The controls sit in a left column, clear of the hotbar drawn under every screen and of the phone pad;
// on a phone whose pad buttons reach up into the panel (a 667 x 375 landscape phone's INV and MENU), the panel is
// made shorter so it ends above them. The view keeps the centre the player chose (the fit, or where the arrows
// moved it) apart from the centre it is drawn at, which is only clamped to the region: a zoom that shows the whole
// region (0.5) never loses that centre, and a zoom in that would push Steve out of a view he was in centres on him.
// It never throws: a fault closes it.
import { G } from '../game.js';
import { mcText, mcWidth } from '../mcfont.js';
import { drawButton, loadMenuAssets } from './mcgui.js';
import { parchment, icon, touchDevice, mapColors } from '../minimap.js';

export const PANEL = { x: 96, y: 18, w: 272, h: 272 }, AREA = { x: 100, y: 22, w: 264, h: 264 }, BTN = { x: 8, y: 22, w: 80, h: 20 };
export const HINT_Y = [48, 60, 72, 84];
const ZOOMS = [0.5, 1, 2, 4];
const DIRS = ['up', 'down', 'left', 'right'];
const STEVE = { up: 'player_up', right: 'player_right', down: 'player_down', left: 'player_left' };
// a phone's pad: the canvas y of the highest pad button (or the co-op CHAT button) in the lower half of the canvas that
// meets the columns x0..x1, or Infinity (no pad, a desktop, or nothing there)
function padTop(x0, x1) {
  try {
    if (!touchDevice() || typeof document === 'undefined') return Infinity;
    const c = document.getElementById('game'), r = c ? c.getBoundingClientRect() : null;
    if (!r || !r.width || !r.height) return Infinity;
    let top = Infinity;
    for (const b of document.querySelectorAll('#pad button, #coop-chatbtn')) {
      const q = b.getBoundingClientRect();
      if (!q.width || !q.height) continue;
      const bx0 = ((q.left - r.left) / r.width) * c.width, bx1 = ((q.right - r.left) / r.width) * c.width, by0 = ((q.top - r.top) / r.height) * c.height;
      if (bx1 <= x0 || bx0 >= x1 || by0 < c.height / 2) continue;
      top = Math.min(top, by0);
    }
    return top;
  } catch (e) { return Infinity; }
}

export class MapScreen {
  // mm: the MiniMap; io: { sfx }
  constructor(mm, io = {}) {
    this.kind = 'map'; this.done = false; this.mm = mm; this.io = io; this.t = 0; this.world = G.world;
    this.held = { up: 0, down: 0, left: 0, right: 0 };
    try { loadMenuAssets().catch(() => {}); } catch (e) { /* the plain button */ }
    const w = G.world, P = G.P, L = w.layout;
    let reg = mm.region(P.tx, P.ty);
    this.indoor = !reg;
    if (!reg) reg = { x: L.ox, y: L.oy, w: L.ow, h: L.oh, kind: 'outdoor', key: 'outdoor', name: null };
    this.reg = reg;
    // the panel and its map area (shorter on a phone whose pad reaches into the panel, never under 120 pixels)
    this.P = { ...PANEL }; this.A = { ...AREA };
    const pt = padTop(PANEL.x, PANEL.x + PANEL.w);
    if (pt < PANEL.y + PANEL.h) { this.P.h = Math.max(120, Math.floor(pt) - 2 - PANEL.y); this.A.h = this.P.h - 8; }
    this.title = reg.kind === 'outdoor' ? (L.gen ? (w.wd && w.wd.name) || 'New World' : 'Kanto')
      : reg.kind === 'nether' ? 'The Nether' : reg.kind === 'stronghold' ? 'Stronghold' : reg.kind === 'end' ? 'The End' : reg.name || 'Cave';
    const pc = document.createElement('canvas');
    pc.width = this.P.w; pc.height = this.P.h;
    const g = pc.getContext('2d'); g.imageSmoothingEnabled = false;
    parchment(g, 0, 0, this.P.w, this.P.h, 8);
    this.panel = pc;
    mm.overview();
    // the region in blocks
    this.rb = { x0: reg.x >> 2, y0: reg.y >> 2, x1: (reg.x + reg.w - 1) >> 2, y1: (reg.y + reg.h - 1) >> 2 };
    // "fit": the largest zoom at which the explored part (plus 4 blocks) fits; centred on Steve, shifted so the
    // explored part shows whole, clamped to the region
    const box = mm.exploredBox(reg), me = this.me();
    this.zi = 1;
    if (box) {
      const bw = box.x1 - box.x0 + 1 + 8, bh = box.y1 - box.y0 + 1 + 8;
      this.zi = 0;
      for (let i = ZOOMS.length - 1; i >= 0; i--) if (bw * ZOOMS[i] <= this.A.w && bh * ZOOMS[i] <= this.A.h) { this.zi = i; break; }
    }
    // (ux, uy): the centre the player is using, in blocks; (cx, cy): the one drawn, clamped to the region
    this.ux = me.x / 4; this.uy = me.y / 4;
    if (box) {
      const vw = this.A.w / this.zoom(), vh = this.A.h / this.zoom();
      const fitX = (lo, hi, c, v) => (hi - lo + 1 + 8 <= v ? Math.max(hi + 4 + 1 - v / 2, Math.min(lo - 4 + v / 2, c)) : c);
      this.ux = fitX(box.x0, box.x1, this.ux, vw); this.uy = fitX(box.y0, box.y1, this.uy, vh);
    }
    this.clamp();
    mm.screenOpen = true;
  }
  zoom() { return ZOOMS[this.zi]; }
  // where Steve is shown: his cell, or indoors his last outdoor cell this session (or the spawn)
  me() {
    const P = G.P;
    if (!this.indoor) return { x: P.tx, y: P.ty, dir: P.dir };
    const o = this.mm.lastOut || G.worldSpawn || { x: 0, y: 0 };
    return { x: o.x, y: o.y, dir: P.dir };
  }
  // the drawn centre: the player's, clamped to the region (centred on an axis where the whole region fits)
  clamp() {
    const z = this.zoom(), vw = this.A.w / z, vh = this.A.h / z, r = this.rb;
    const c = (v, lo, hi, view) => (hi - lo + 1 <= view ? (lo + hi + 1) / 2 : Math.max(lo + view / 2, Math.min(hi + 1 - view / 2, v)));
    this.cx = c(this.ux, r.x0, r.x1, vw); this.cy = c(this.uy, r.y0, r.y1, vh);
  }
  // Steve's block inside the drawn view
  meInView() {
    const me = this.me(), { left, top, vw, vh } = this.origin(), bx = (me.x + 0.5) / 4, by = (me.y + 0.5) / 4;
    return bx >= left && bx < left + vw && by >= top && by < top + vh;
  }
  // a new zoom index around the player's centre; a zoom that would lose a Steve who was in view centres on him
  setZoom(zi) {
    const was = this.meInView();
    this.zi = zi; this.clamp();
    if (was && !this.meInView()) { const me = this.me(); this.ux = (me.x + 0.5) / 4; this.uy = (me.y + 0.5) / 4; this.clamp(); }
  }
  // the arrows: from the drawn centre, on an axis the view can move along (where the whole region fits, the player's
  // centre stays as it was)
  pan(dx, dy) {
    const z = this.zoom(), r = this.rb;
    if (dx && r.x1 - r.x0 + 1 > this.A.w / z) this.ux = this.cx + dx;
    if (dy && r.y1 - r.y0 + 1 > this.A.h / z) this.uy = this.cy + dy;
    this.clamp();
  }
  // the view's top-left block, snapped so every block lands on whole canvas pixels
  origin() {
    const z = this.zoom(), vw = this.A.w / z, vh = this.A.h / z, step = z < 1 ? 1 / z : 1;
    return { left: Math.round((this.cx - vw / 2) / step) * step, top: Math.round((this.cy - vh / 2) / step) * step, vw, vh, z };
  }
  update(dt, input) {
    try {
      this.t += dt;
      if (this.done) return;
      const s = this.io.sfx;
      if (G.P.dead || G.world !== this.world) { this.done = true; return; }
      if (input.just('b') || input.just('map')) { this.done = true; if (s) s.cancel(); return; }
      if (input.just('a')) { this.setZoom((this.zi + 1) % ZOOMS.length); if (s) s.move(); }
      const wh = input.takeWheel ? input.takeWheel() : 0;
      if (wh) this.setZoom(Math.max(0, Math.min(ZOOMS.length - 1, this.zi + (wh < 0 ? 1 : -1))));
      const m = input.mouse;
      if (input.just('start') || (input.just('mouseL') && m && m.x >= BTN.x && m.y >= BTN.y && m.x < BTN.x + BTN.w && m.y < BTN.y + BTN.h)) {
        this.mm.setPref(!this.mm.pref()); if (s) s.select();
      }
      const q = 64 / this.zoom();   // a quarter of the 264-pixel view, in blocks
      for (const d of DIRS) {
        if (input.held(d) || input.just(d)) this.held[d]++; else this.held[d] = 0;
        const n = this.held[d];
        if (n === 1 || (n > 1 && (n - 1) % 4 === 0)) this.pan(d === 'left' ? -q : d === 'right' ? q : 0, d === 'up' ? -q : d === 'down' ? q : 0);
      }
    } catch (e) { console.error(e); this.done = true; }
  }
  draw(ctx) {
    try {
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = 'rgba(16,16,16,0.72)'; ctx.fillRect(0, 0, 480, 320);
      const PN = this.P;
      ctx.fillStyle = 'rgba(16,16,16,0.9)'; ctx.fillRect(PN.x, 0, PN.w, PN.y);   // (the title's strip: a map-name banner fades under it)
      mcText(ctx, this.title, Math.round(PN.x + PN.w / 2 - mcWidth(this.title) / 2), 6, '#ffffff', true);
      ctx.drawImage(this.panel, PN.x, PN.y);
      const mc = mapColors() || {}, fog = (mc.fog && mc.fog[0]) || '#2a2318';
      const { left, top, vw, vh, z } = this.origin(), A2 = this.A, r = this.rb;
      const px = (bx) => A2.x + (bx - left) * z, py = (by) => A2.y + (by - top) * z;
      ctx.save();
      ctx.beginPath(); ctx.rect(A2.x, A2.y, A2.w, A2.h); ctx.clip();
      ctx.fillStyle = fog; ctx.fillRect(A2.x, A2.y, A2.w, A2.h);
      // the region's blocks of the overview
      const ov = this.mm.overview();
      const sx0 = Math.max(left, r.x0), sy0 = Math.max(top, r.y0), sx1 = Math.min(left + vw, r.x1 + 1), sy1 = Math.min(top + vh, r.y1 + 1);
      if (ov && sx1 > sx0 && sy1 > sy0) ctx.drawImage(ov, sx0, sy0, sx1 - sx0, sy1 - sy0, px(sx0), py(sy0), (sx1 - sx0) * z, (sy1 - sy0) * z);
      const cell = (x, y) => [A2.x + (x / 4 - left) * z, A2.y + (y / 4 - top) * z];
      const w = this.world, L = w.layout;
      if (L.gen && this.reg.kind === 'outdoor') {
        const b = L.border, [x0, y0] = cell(b.x0, b.y0), [x1, y1] = cell(b.x1 + 1, b.y1 + 1);
        ctx.strokeStyle = mc.border || '#5fd3ff'; ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x0) - 0.5, Math.round(y0) - 0.5, Math.round(x1 - x0) + 1, Math.round(y1 - y0) + 1);
      }
      for (const m of this.mm.markers(this.reg, false)) { const [x, y] = cell(m.x + 0.5, m.y + 0.5); icon(ctx, m.icon, Math.round(x) - 4, Math.round(y) - 4); }
      for (const d of this.mm.mates(this.reg, true)) {   // (the region shown, not Steve's own place: indoors, the overworld's)
        const [x, y] = cell(d.x + 0.5, d.y + 0.5), X = Math.round(x), Y = Math.round(y);
        ctx.fillStyle = d.rim; ctx.fillRect(X - 2, Y - 2, 5, 5); ctx.fillStyle = d.color; ctx.fillRect(X - 1, Y - 1, 3, 3);
      }
      if (this.mm.kanto && this.mm.kseen && this.reg.kind === 'outdoor') {
        const K = this.mm.kanto, [x, y] = cell(K.x + w.outdoor.w / 2, K.y + w.outdoor.h / 2), s = 'Kanto';
        mcText(ctx, s, Math.round(x - mcWidth(s) / 2), Math.round(y - 4), '#ffffff', true);
      }
      const me = this.me(), [mx, my] = cell(me.x + 0.5, me.y + 0.5);
      icon(ctx, STEVE[me.dir] || 'player_down', Math.round(mx) - 4, Math.round(my) - 4);
      ctx.restore();
      // the left column: the switch and the hints
      const m = G.input && G.input.mouse, hover = !!m && m.inside && m.x >= BTN.x && m.y >= BTN.y && m.x < BTN.x + BTN.w && m.y < BTN.y + BTN.h;
      drawButton(ctx, BTN.x, BTN.y, BTN.w, BTN.h, `Minimap: ${this.mm.pref() ? 'ON' : 'OFF'}`, { hover });
      const hints = touchDevice() ? ['A: zoom', 'B: close', 'MENU: on/off'] : ['Arrows: move', 'Z: zoom', 'X: close', 'J: close'];
      hints.forEach((h, i) => mcText(ctx, h, BTN.x, HINT_Y[i], '#a0a0a0', true));
    } catch (e) { console.error(e); this.done = true; }
  }
  close() { this.mm.screenOpen = false; }
  info() { const o = this.origin(); return { zoom: o.z, cx: this.cx, cy: this.cy, ux: this.ux, uy: this.uy, left: o.left, top: o.top, vw: o.vw, vh: o.vh, region: this.reg.key, title: this.title, indoor: this.indoor, panel: { ...this.P }, area: { ...this.A } }; }
}
