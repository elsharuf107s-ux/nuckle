// Minecraft 1.21's screen widgets for the world update's menus (design 6.3, 6.4, 7): nine-slice buttons, text fields
// and tabs from Minecraft's own sprites (assets/mc/menu/, tools/build_menu_assets.py), the dirt-style background with
// the header and footer separators, tooltips, and a small focus model so every screen works with a mouse, with taps
// and with the pad (arrows move the focus, A presses, B goes back).
//
// The textures load on first use (loadMenuAssets), never on a Classic page that opens none of these screens. Drawing
// with a texture that has not arrived yet falls back to flat colours, so nothing here can throw in the update loop.
import { A } from '../assets.js';
import { mcText, mcWidth } from '../mcfont.js';
import { sfx, mc } from '../audio.js';

export const W = 480, H = 320;          // the hi-res canvas (one GUI pixel per canvas pixel)
export const WHITE = '#ffffff', GREY = '#a0a0a0', DARK = '#808080', LABEL = '#404040', RED = '#ff5555', DARK_RED = '#aa0000';

const MENU_KEYS = ['button', 'button_highlighted', 'button_disabled', 'text_field', 'text_field_highlighted', 'tab', 'tab_highlighted',
  'tab_selected', 'tab_selected_highlighted', 'scroller', 'scroller_background', 'menu_background', 'menu_list_background',
  'header_separator', 'footer_separator', 'join', 'join_highlighted', 'dirt', 'creative_items', 'creative_search',
  'creative_inventory', 'creative_scroller', 'creative_scroller_disabled', 'creative_tabs', 'heart_hardcore_container',
  'heart_hardcore_container_blinking', 'heart_hardcore_full', 'heart_hardcore_half', 'heart_hardcore_full_blinking',
  'heart_hardcore_half_blinking', 'heart_hardcore_poisoned_full', 'heart_hardcore_poisoned_half', 'heart_hardcore_absorbing_full',
  'heart_hardcore_absorbing_half'];
// A.mc.menu_<key> once loaded
export const M = (k) => (A.mc ? A.mc['menu_' + k] : null);
let loading = null;
export function loadMenuAssets(base = 'assets/mc/menu/') {
  if (loading) return loading;
  const one = (k) => new Promise((resolve) => {
    if (M(k)) { resolve(); return; }
    const img = new Image();
    img.onload = () => { A.mc['menu_' + k] = img; resolve(); };
    img.onerror = () => resolve();   // a missing texture draws as flat colour
    img.src = base + k + '.png';
  });
  loading = Promise.all(MENU_KEYS.map(one)).then(() => MENU_KEYS.filter((k) => !M(k)));
  return loading;
}
export const menuAssetsReady = () => MENU_KEYS.every((k) => !!M(k));

// ------------------------------------------------------------------------------------------- drawing primitives
// Nine-slice with tiled edges and centre (Minecraft's nine_slice scaling); border = n or {l, t, r, b}.
export function nineSlice(ctx, img, x, y, w, h, border, sx = 0, sy = 0, sw = img ? img.width : 0, sh = img ? img.height : 0) {
  if (!img || w <= 0 || h <= 0) return;
  const b = typeof border === 'number' ? { l: border, t: border, r: border, b: border } : border;
  const l = Math.min(b.l, w / 2), r = Math.min(b.r, w / 2), t = Math.min(b.t, h / 2), bt = Math.min(b.b, h / 2);
  const cw = sw - b.l - b.r, ch = sh - b.t - b.b;
  const tile = (srcX, srcY, srcW, srcH, dx, dy, dw, dh) => {
    if (dw <= 0 || dh <= 0 || srcW <= 0 || srcH <= 0) return;
    for (let oy = 0; oy < dh; oy += srcH) for (let ox = 0; ox < dw; ox += srcW) {
      const ww = Math.min(srcW, dw - ox), hh = Math.min(srcH, dh - oy);
      ctx.drawImage(img, sx + srcX, sy + srcY, ww, hh, dx + ox, dy + oy, ww, hh);
    }
  };
  // corners
  tile(0, 0, l, t, x, y, l, t);
  tile(sw - r, 0, r, t, x + w - r, y, r, t);
  tile(0, sh - bt, l, bt, x, y + h - bt, l, bt);
  tile(sw - r, sh - bt, r, bt, x + w - r, y + h - bt, r, bt);
  // edges and centre
  tile(b.l, 0, cw, t, x + l, y, w - l - r, t);
  tile(b.l, sh - bt, cw, bt, x + l, y + h - bt, w - l - r, bt);
  tile(0, b.t, l, ch, x, y + t, l, h - t - bt);
  tile(sw - r, b.t, r, ch, x + w - r, y + t, r, h - t - bt);
  tile(b.l, b.t, cw, ch, x + l, y + t, w - l - r, h - t - bt);
}
export function textC(ctx, text, cx, y, color = WHITE, shadow = true, scale = 1) { return mcText(ctx, text, Math.round(cx - mcWidth(text, scale) / 2), y, color, shadow, scale); }
// Cut a string to fit maxW pixels, with "..." when it was cut.
export function fit(text, maxW) {
  const s = String(text);
  if (mcWidth(s) <= maxW) return s;
  let k = s.length;
  while (k > 0 && mcWidth(s.slice(0, k) + '...') > maxW) k--;
  return s.slice(0, k) + '...';
}
// Word-wrap for Minecraft's font.
export function wrapMc(text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const wd of para.split(' ')) {
      const cand = line ? line + ' ' + wd : wd;
      if (line && mcWidth(cand) > maxW) { out.push(line); line = wd; } else line = cand;
    }
    out.push(line);
  }
  return out;
}

// The old dirt-style menu background (design 7.6): Minecraft's dirt texture tiled at 2x, darkened to a quarter.
export function drawDirt(ctx, x = 0, y = 0, w = W, h = H, shade = 0.75, scroll = 0) {
  const d = M('dirt');
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  if (d) {
    const off = Math.round(scroll) % 32;
    for (let ty = y - off - 32; ty < y + h; ty += 32) for (let tx = x - (x % 32); tx < x + w; tx += 32) ctx.drawImage(d, 0, 0, 16, 16, tx, ty, 32, 32);
  } else { ctx.fillStyle = '#6b4a2f'; ctx.fillRect(x, y, w, h); }
  ctx.fillStyle = `rgba(0,0,0,${shade})`; ctx.fillRect(x, y, w, h);
  ctx.restore();
}
// The list area of a menu (Minecraft's menu_list_background over the background) between the separators.
export function drawListArea(ctx, y0, y1) {
  const t = M('menu_list_background');
  if (t) { for (let y = y0; y < y1; y += 16) for (let x = 0; x < W; x += 16) ctx.drawImage(t, 0, 0, 16, Math.min(16, y1 - y), x, y, 16, Math.min(16, y1 - y)); }
  else { ctx.fillStyle = 'rgba(0,0,0,0.44)'; ctx.fillRect(0, y0, W, y1 - y0); }
}
export function drawSeparator(ctx, y, which = 'header') {
  const s = M(which + '_separator');
  if (s) for (let x = 0; x < W; x += 32) ctx.drawImage(s, x, y);
  else { ctx.fillStyle = which === 'header' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.75)'; ctx.fillRect(0, y, W, 1); ctx.fillStyle = which === 'header' ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.2)'; ctx.fillRect(0, y + 1, W, 1); }
}
// Minecraft's tooltip box (the purple-rimmed one).
export function drawTip(ctx, lines, x, y) {
  const ls = lines.map((l) => (typeof l === 'string' ? { text: l } : l));
  const w = Math.max(...ls.map((l) => mcWidth(l.text))) + 8, h = ls.length * 10 + 4;
  let tx = x + 12, ty = y - 12;
  if (tx + w > W) tx = Math.max(2, x - w - 4);
  if (ty + h > H) ty = H - h - 2;
  if (ty < 2) ty = 2;
  ctx.fillStyle = 'rgba(16,0,16,0.94)'; ctx.fillRect(tx + 1, ty, w - 2, h); ctx.fillRect(tx, ty + 1, w, h - 2);
  ctx.strokeStyle = 'rgba(80,0,255,0.31)'; ctx.lineWidth = 1; ctx.strokeRect(tx + 1.5, ty + 1.5, w - 3, h - 3);
  ls.forEach((l, i) => mcText(ctx, l.text, tx + 4, ty + 3 + i * 10, l.color || WHITE));
}

// ------------------------------------------------------------------------------------------- widgets
// A widget is { kind, x, y, w, h, label() | text, active(), press(dir), ... }. Screens keep them in a list and pass
// the focused one to drawWidget.
export function drawButton(ctx, x, y, w, h, label, { hover = false, active = true } = {}) {
  const img = !active ? M('button_disabled') : hover ? M('button_highlighted') : M('button');
  if (img) nineSlice(ctx, img, x, y, w, h, 3);
  else {
    ctx.fillStyle = active ? (hover ? '#8c8c8c' : '#6c6c6c') : '#2c2c2c'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = hover && active ? WHITE : '#000000'; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
  const s = fit(label, w - 8);
  mcText(ctx, s, Math.round(x + w / 2 - mcWidth(s) / 2), y + Math.round((h - 8) / 2), active ? WHITE : GREY, true);
}
// Minecraft's edit box: a 1-px framed black field, white text, a blinking "_" cursor while focused, a grey hint when empty.
export function drawField(ctx, x, y, w, h, value, { focus = false, hint = '', t = 0, editing = false } = {}) {
  const img = focus ? M('text_field_highlighted') : M('text_field');
  if (img) nineSlice(ctx, img, x, y, w, h, 1);
  else { ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = focus ? WHITE : GREY; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); }
  const ty = y + Math.round((h - 8) / 2);
  const v = String(value || '');
  if (!v && hint && !editing) { mcText(ctx, fit(hint, w - 8), x + 4, ty, DARK, true); }
  // the text scrolls to keep its end (and the cursor) visible
  let shown = v;
  while (shown && mcWidth(shown) > w - 14) shown = shown.slice(1);
  const end = mcText(ctx, shown, x + 4, ty, '#e0e0e0', true);
  if (focus && Math.floor(t * 3) % 2 === 0) mcText(ctx, '_', x + 4 + (shown ? end + 1 : 0), ty, '#d0d0d0', true);
}
// A header tab (Minecraft 1.21's TabButton): selected tabs use tab_selected and a white underline under the label.
export function drawTab(ctx, x, y, w, h, label, { selected = false, hover = false } = {}) {
  const key = (selected ? 'tab_selected' : 'tab') + (hover ? '_highlighted' : '');
  const img = M(key);
  if (img) nineSlice(ctx, img, x, y, w, h, { l: 2, t: 2, r: 2, b: 0 });
  else { ctx.fillStyle = selected ? '#3c3c3c' : '#242424'; ctx.fillRect(x, y, w, h); }
  const s = fit(label, w - 8), tw = mcWidth(s), tx = Math.round(x + w / 2 - tw / 2), ty = y + Math.round((h - 8) / 2) + (selected ? 0 : 1);
  mcText(ctx, s, tx, ty, selected ? WHITE : GREY, true);
  if (selected) { ctx.fillStyle = WHITE; ctx.fillRect(tx, ty + 10, tw, 1); }
}

// ------------------------------------------------------------------------------------------- pointer helpers
export const inside = (m, r) => !!m && !!r && m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h;
// Tracks whether the player is using the mouse (hover shows) or the keys and pad (the focus ring shows), the way
// screens.js does: a mouse move inside the canvas switches to mouse, an arrow key switches back.
export class PointerMode {
  constructor(input = null) { this.useMouse = false; this.last = input && input.mouse ? { x: input.mouse.x, y: input.mouse.y } : null; }
  update(input) {
    const m = input.mouse;
    // where the pointer was when the screen opened is not a move (a stale position must not steal the keys)
    if (!this.last) this.last = { x: m.x, y: m.y };
    if (m.x !== this.last.x || m.y !== this.last.y) { if (m.inside) this.useMouse = true; this.last = { x: m.x, y: m.y }; }
    if ((input.just('mouseL') || input.just('mouseR')) && m.inside) this.useMouse = true;   // a click or a tap is the pointer's
    if (['up', 'down', 'left', 'right'].some((d) => input.just(d))) this.useMouse = false;
    return this.useMouse;
  }
}
// Canvas touches routed to the menu screen in front (7.5). input.js turns a tap into mousedown and mouseup in the same
// frame, which is fine for buttons but not for two things a phone needs: (1) an iPhone raises its keyboard only for a
// focus() made inside the touch's own event handler, not from the next animation frame, so a text field must open its
// box in touchend; (2) a finger dragging the creative scroller sends no mouse moves at all. The screen in front calls
// claimTouch(this) every update and gets onTouch(type, m) with m in canvas pixels for touchstart, touchmove, touchend and
// touchcancel; returning true marks the touch as used (preventDefault, so the browser sends no mouse events for it and
// the same tap is not handled twice). A screen that is done, released, or has not updated for 3 s gets nothing.
let touchOwner = null, touchStamp = 0, touchHooked = false;
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
export function claimTouch(owner) { touchOwner = owner; touchStamp = nowMs(); hookTouch(); }
export function releaseTouch(owner) { if (!owner || touchOwner === owner) touchOwner = null; }
function hookTouch() {
  if (touchHooked || typeof document === 'undefined') return;
  const c = document.getElementById('game');
  if (!c) return;
  touchHooked = true;
  const handler = (e) => {
    const o = touchOwner;
    if (!o || o.done || typeof o.onTouch !== 'function' || nowMs() - touchStamp > 3000) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const m = { x: ((t.clientX - r.left) / r.width) * c.width, y: ((t.clientY - r.top) / r.height) * c.height };
    let used = false;
    try { used = !!o.onTouch(e.type, m); } catch (err) { console.error(err); }
    if (used && e.cancelable) e.preventDefault();
  };
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) c.addEventListener(type, handler, { passive: false });
}

// The menus' sounds: Minecraft's button click for its screens, FireRed's beeps for the FireRed menu ('move', 'select',
// 'cancel'). Replaceable (setMenuSound) for a test that wants silence or a log; a failing sound never throws.
let soundHook = (kind) => { if (kind === 'click') mc('click', { vol: 0.2 }); else sfx[kind](); };
export function setMenuSound(fn) { soundHook = fn; }
export function sound(kind) { try { if (soundHook) soundHook(kind); } catch (e) { /* sound is never fatal */ } }
