// The test page's driver for tools/gen_tests/menus.mjs: loads the game's assets, builds one menu screen at a time and
// steps it one frame per tick, with the game's real Input (keys, mouse, taps and the touch pad). window.__menus is the
// hook the runner uses. Nothing here touches the game's saves.
import { A, loadAssets } from '../../src/assets.js';
import { initFont } from '../../src/font.js';
import { mcText } from '../../src/mcfont.js';
import { Input } from '../../src/input.js';
import { Inventory } from '../../src/items.js';
import { drawHUD } from '../../src/hud.js';
import * as MD from '../../src/modes.js';
import { WorldMenus, TitleMenu, CreateWorld, SelectWorld, LoadingScreen, bootRequest, fmtDate, seedOf } from '../../src/ui/worldmenu.js';
import { CreativeScreen, TABS, tabContents, searchItems, tabsOf } from '../../src/ui/creative.js';
import { HardcoreDeathScreen, SpectatorOverlay, drawHardcoreHearts, ghost } from '../../src/ui/hardcore.js';
import { loadMenuAssets, setMenuSound } from '../../src/ui/mcgui.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
function fit() {
  const scale = Math.max(0.5, Math.min(window.innerWidth / 480, (window.innerHeight - 16) / 320));
  const s = scale >= 2 ? Math.floor(scale) : scale;
  canvas.style.width = Math.round(480 * s) + 'px'; canvas.style.height = Math.round(320 * s) + 'px';
}
window.addEventListener('resize', fit); fit();
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));

await loadAssets();
initFont();
const missing = await loadMenuAssets();
const input = new Input(canvas);
const sounds = [];
setMenuSound((k) => sounds.push(k));   // silent and logged

// the game's title art, simplified (gradient, logo, Steve and the fan notice in their places)
function titleArt(c) {
  const g = c.createLinearGradient(0, 0, 0, 320);
  g.addColorStop(0, '#000000'); g.addColorStop(0.6, '#140404'); g.addColorStop(1, '#3a0808');
  c.fillStyle = g; c.fillRect(0, 0, 480, 320);
  const ts = A.mc.titleSteve; c.drawImage(ts, 480 - ts.width - 22, 320 - ts.height - 18);
  c.drawImage(A.img.titleLogo, 24, 18, 352, 118);
  ['Unofficial fan project. Free: no ads, no donations.', 'Not affiliated with Nintendo, Game Freak,', 'The Pokémon Company, Mojang or Microsoft.']
    .forEach((l, i) => mcText(c, l, 6, 320 - 34 + i * 11, '#a07474', false));
}
// a world view stand-in behind the in-game screens
function worldArt(c) {
  c.fillStyle = '#3f7f3a'; c.fillRect(0, 0, 480, 320);
  c.fillStyle = '#5a9a4a'; for (let y = 0; y < 320; y += 32) for (let x = (y / 32) % 2 ? 0 : 32; x < 480; x += 64) c.fillRect(x, y, 32, 32);
}

let worlds = [];
const deleted = [];
const G = { inv: new Inventory(), input, dropped: [], dropStack(s) { this.dropped.push({ ...s }); } };
const P = { health: 13, hurtFlash: 0, regenFlash: 0, poisoned: false, absorb: 0, food: 20, sat: 5, level: 3, xpProgress: 4, hungerEffect: 0 };
let screen = null, backdrop = null, overlay = null, kind = '';

function open(name, opts = {}) {
  kind = name; overlay = null; backdrop = null;
  if (opts.worlds) worlds = opts.worlds.map((w) => ({ ...w }));
  const wl = () => worlds;
  const onDelete = (id) => { deleted.push(id); worlds = worlds.filter((w) => w.id !== id); };
  if (name === 'flow') screen = new WorldMenus({ cont: opts.cont, bootedId: opts.bootedId, worlds: wl, onDelete, maxWorlds: opts.max, backdrop: titleArt, start: opts.start });
  else if (name === 'title') screen = new TitleMenu({ cont: opts.cont, worldCount: worlds.length, backdrop: titleArt });
  else if (name === 'create') screen = new CreateWorld({ count: worlds.length, maxWorlds: opts.max });
  else if (name === 'select') screen = new SelectWorld({ worlds: wl, onDelete, maxWorlds: opts.max });
  else if (name === 'loading') { screen = new LoadingScreen({ joining: !!opts.joining }); screen.set(opts.set || {}); }
  else if (name === 'death') { screen = new HardcoreDeathScreen({ cause: opts.cause, score: opts.score }); backdrop = worldArt; }
  else if (name === 'spectator') { screen = null; overlay = new SpectatorOverlay({ cause: opts.cause }); backdrop = worldArt; }
  else if (name === 'hearts') { screen = null; backdrop = worldArt; }
  else if (name === 'creative') {
    G.inv = new Inventory();
    for (const [i, s] of Object.entries(opts.slots || {})) G.inv.slots[i] = { ...s };
    screen = new CreativeScreen(G, { tab: opts.tab }); backdrop = worldArt;
  }
  draw();
  return true;
}
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 480, 320);
  if (backdrop) backdrop(ctx);
  if (kind === 'spectator') {
    // Steve as a spectator (35%) with no HUD
    ghost(ctx, () => ctx.drawImage(A.mc.steve, 0, 0, 24, 32, 228, 136, 48, 64));
    overlay.draw(ctx);
  } else if (kind === 'hearts') {
    // the survival HUD, then the hardcore hearts drawn over its heart row (hud.js's coordinates)
    drawHUD(ctx, { P, inv: G.inv, tick: 0, heldName: null, actionBar: null }, 0);
    const x0 = Math.round((480 - 182) / 2), yh = 320 - 22 - 7 - 10;
    drawHardcoreHearts(ctx, P, x0, yh, 0);
    drawHardcoreHearts(ctx, { ...P, health: 20 }, x0, 60, 0);
    drawHardcoreHearts(ctx, { ...P, health: 7, poisoned: true }, x0, 80, 0);
    drawHardcoreHearts(ctx, { ...P, health: 3, hurtFlash: 0.3 }, x0, 100, 0);
  }
  if (screen) screen.draw(ctx);
}
function tick({ press, hold, dt = 1 / 30, mouse } = {}) {
  if (mouse) { input.mouse.x = mouse.x; input.mouse.y = mouse.y; input.mouse.inside = true; if (mouse.click) input.press(mouse.click); }
  if (press) for (const k of [].concat(press)) input.press(k);
  if (hold) for (const k of [].concat(hold)) input.down.add(k);
  try {
    if (screen && !screen.done) screen.update(dt, input);
    if (overlay) overlay.update(dt);
    draw();
  } catch (e) { errors.push('update/draw: ' + (e && e.stack || e)); }
  input.endFrame();
  if (press) for (const k of [].concat(press)) if (!(hold && [].concat(hold).includes(k))) input.release(k);
  if (hold) for (const k of [].concat(hold)) input.down.delete(k);
  if (mouse && mouse.click) input.release(mouse.click);
  input.endFrame();
}
const entryEl = () => document.getElementById('rs-text-entry');
window.__menus = {
  ready: true, A, MD, TABS, G, P, errors, sounds, missing, deleted,
  open, tick, draw,
  frame: () => canvas.toDataURL('image/png'),
  screen: () => screen,
  top: () => (screen && screen.top ? screen.top : screen),
  kind: () => kind,
  worlds: () => worlds,
  result: () => (screen ? screen.result : null),
  done: () => !!(screen && screen.done),
  bootRequest, fmtDate, seedOf, tabContents, searchItems, tabsOf,
  overlay: () => overlay,
  entry: () => { const el = entryEl(); if (!el) return null; const i = el.querySelector('input'); const r = el.getBoundingClientRect();
    return { open: true, value: i.value, focused: document.activeElement === i, attrs: Object.fromEntries(['autocapitalize', 'autocorrect', 'autocomplete', 'spellcheck', 'enterkeyhint', 'maxlength'].map((a) => [a, i.getAttribute(a)])),
      label: (el.querySelector('label') || {}).textContent || '', rect: { x: r.x, y: r.y, w: r.width, h: r.height } }; },
  canvasRect: () => { const r = canvas.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
};
