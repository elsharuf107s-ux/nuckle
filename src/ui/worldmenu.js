// The world update's title menus (design section 7): FireRed's main menu (CONTINUE, NEW GAME, WORLDS) over the title
// art, and Minecraft 1.21's Select World, Create New World, the delete confirmation and the loading screens.
//
// Each screen is Screen-shaped like src/screens.js: update(dt, input), draw(ctx), done, plus result once done. They
// read input.just(...) and input.mouse only, so the pad, the keys, the mouse and taps all work. WorldMenus chains them
// for the title (title menu -> Create New World / Select World -> confirmations) and ends with one of:
//   { op: 'continue' }                                   play the booted world (no reload)
//   { op: 'new', name, type, mode, diff, seedText }      write sessionStorage['rs.world'] and reload (7.4)
//   { op: 'load', id }                                   the same with { op: 'load', id }
//   { op: 'back' }                                       B on the main menu: back to PRESS START
//   { op: 'reboot' }                                     the booted world was deleted in Select World: reload with no
//                                                        request (the boot picks the last played world, 7.1) and never
//                                                        save the deleted world again
// Deleting goes through the onDelete(id) callback the caller gives (worlds.js owns the list and the saves). The caller
// names the booted world with bootedId (or cont.id); once that id leaves the list, CONTINUE is gone from the main menu.
//
// Wired into the title by main.js (stage 9); tools/gen_tests/menus.mjs drives every screen headless and
// tools/gen_tests/title_menus.mjs drives them in the game.
import { A } from '../assets.js';
import { mcText, mcWidth } from '../mcfont.js';
import { drawText, textWidth } from '../font.js';
import { drawWindow } from '../ui.js';
import { drawIcon } from '../hud.js';
import * as MD from '../modes.js';
import { W, H, WHITE, GREY, DARK, RED, DARK_RED, M, nineSlice, textC, fit, wrapMc, drawDirt, drawListArea, drawSeparator, drawTip,
  drawButton, drawField, drawTab, inside, PointerMode, sound, loadMenuAssets, claimTouch, releaseTouch } from './mcgui.js';
import { openTextEntry, closeTextEntry, textEntryOpen } from './textentry.js';
import { isButtonKey } from '../input.js';

export { loadMenuAssets };

// ------------------------------------------------------------------------------------------- small helpers
const pad2 = (n) => String(n).padStart(2, '0');
// "10/8/26, 3:12 PM" (Minecraft's short date and time), in the player's own time zone
export function fmtDate(ms) {
  const d = new Date(Number(ms) || 0);
  if (!Number.isFinite(d.getTime()) || !ms) return '';
  const h = d.getHours(), h12 = h % 12 || 12;
  return `${d.getMonth() + 1}/${d.getDate()}/${pad2(d.getFullYear() % 100)}, ${h12}:${pad2(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}
// the seed a list entry shows: the text the player typed, else the number (a random seed), else nothing (Classic)
export function seedOf(e) {
  if (!e || e.id === 'classic' || e.type === 'classic') return '';
  if (typeof e.seedText === 'string' && e.seedText.trim()) return e.seedText.trim();
  return Number.isFinite(e.seed) ? String(e.seed) : '';
}
// (playfix) a new world's name, with Minecraft's " (2)", " (3)" ... when a listed world has it already
export function uniqueName(name, names) {
  const have = new Set((names || []).map((n) => String(n || '')));
  if (!have.has(name)) return name;
  for (let k = 2; k < 1000; k++) { const sfx = ` (${k})`, n = name.slice(0, MD.NAME_MAX - sfx.length) + sfx; if (!have.has(n)) return n; }
  return name;
}
// FireRed's play time: hours:minutes
export const fmtTime = (s) => { const t = Math.max(0, Math.floor(Number(s) || 0)); return `${Math.floor(t / 3600)}:${pad2(Math.floor(t / 60) % 60)}`; };
function fitFr(text, maxW) {
  const s = String(text);
  if (textWidth(s) <= maxW) return s;
  let k = s.length;
  while (k > 0 && textWidth(s.slice(0, k) + '...') > maxW) k--;
  return s.slice(0, k) + '...';
}
// Arrow key -> the nearest widget that way (centres compared, sideways distance weighted like screens.js neighbor()).
function neighbor(list, i, d) {
  const cur = list[i];
  if (!cur) return list.length ? 0 : -1;
  const c = (w) => ({ x: w.x + w.w / 2, y: w.y + w.h / 2 });
  const a = c(cur), dx = d === 'left' ? -1 : d === 'right' ? 1 : 0, dy = d === 'up' ? -1 : d === 'down' ? 1 : 0;
  let best = -1, bd = Infinity;
  list.forEach((w, j) => {
    if (j === i || w.hidden) return;
    const b = c(w), vx = b.x - a.x, vy = b.y - a.y, along = vx * dx + vy * dy;
    if (along <= 0) return;
    const score = along + Math.abs(dx ? vy : vx) * 2.5;
    if (score < bd) { bd = score; best = j; }
  });
  return best;
}

// (playfix) the widget a click or tap is on: exactly, else, on a touch screen, the nearest within 8 px (the drawn buttons
// are about 16 CSS px tall on a phone, so a finger that lands in the gap between two still gets the nearer one)
const COARSE = (() => { try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } })();
function hitIndex(list, m) {
  const i = list.findIndex((w) => inside(m, w));
  if (i >= 0 || !COARSE || !m) return i;
  let best = -1, bd = 8.01;
  list.forEach((w, j) => {
    if (w.kind === 'list') return;
    const dx = Math.max(w.x - m.x, 0, m.x - (w.x + w.w)), dy = Math.max(w.y - m.y, 0, m.y - (w.y + w.h)), d = Math.max(dx, dy);
    if (d < bd) { bd = d; best = j; }
  });
  return best;
}
// ------------------------------------------------------------------------------------------- a Minecraft-style screen
// Widgets: { kind: 'button' | 'cycle' | 'field' | 'tab', x, y, w, h, label, active, hidden, press(dir), tip }.
class McScreen {
  constructor() { this.t = 0; this.done = false; this.result = null; this.focus = -1; this.pm = new PointerMode(); this.tipT = 0; this.tipFor = null; this.lockT = 0; }
  widgets() { return []; }
  visible() { return this.widgets().filter((w) => !w.hidden); }
  back() { sound('click'); this.finish({ op: 'back' }); }
  finish(r) { closeTextEntry(false); releaseTouch(this); this.result = r; this.done = true; }
  // a tap on a text field opens its box inside the touchend handler, so an iPhone raises its keyboard (mcgui claimTouch)
  onTouch(type, m) {
    if (this.done || textEntryOpen()) return false;
    const list = this.visible();
    const i = list.findIndex((w) => w.kind === 'field' && w.active !== false && inside(m, w));
    if (type === 'touchstart') { this.touchField = i >= 0 ? list[i] : null; return false; }
    if (type !== 'touchend') return false;
    const w = this.touchField; this.touchField = null;
    if (i < 0 || list[i] !== w) return false;
    this.focus = i; this.ptrFocus = i; this.pm.useMouse = true;
    this.activate(w, 'click', m);
    return true;
  }
  update(dt, input) {
    this.t += dt;
    claimTouch(this);
    if (this.tipT > 0) this.tipT -= dt;
    if (textEntryOpen()) return;          // the page-level box has the keys until it closes
    // (playfix: a screen that replaced another in place ignores input for its first moments, so the second click of a
    // double click never presses the button that took the first one's place)
    if (this.t < this.lockT) { this.pm.update(input); return; }
    const useMouse = this.pm.update(input);
    const list = this.visible(), m = input.mouse;
    if (this.focus >= list.length) this.focus = list.length - 1;
    // (playfix: keys typed with a text field focused go into that field, opening its box with them, as in Minecraft)
    // (Z, the A button, still opens the box with the text as it is)
    // (playfix2: a field focused by the arrow keys or WASD leaves game-button keys (W/S, X, E, Z ...) to the menu; only a
    // field focused by a click or tap takes every key)
    if (this.ptrFocus !== this.focus) this.ptrFocus = -1;
    const fw = list[this.focus], byPtr = this.ptrFocus === this.focus && this.focus >= 0;
    const typed = (input.typed || []).filter((k) => (byPtr ? k !== 'z' && k !== 'Z' : !isButtonKey(k)));
    if (fw && fw.kind === 'field' && fw.active !== false && typed.length && !input.just('mouseL')) { if (fw.typeInto) fw.typeInto(typed.join('')); return; }
    if (useMouse) { const i = list.findIndex((w) => inside(m, w)); this.hover = i; } else this.hover = -1;
    if (input.just('mouseL')) {
      const i = hitIndex(list, m);
      if (i >= 0) { this.focus = i; this.ptrFocus = i; this.activate(list[i], 'click', m); return; }
      if (this.click) this.click(m);
      return;
    }
    if (input.just('b')) { this.back(); return; }
    for (const d of ['up', 'down', 'left', 'right']) {
      if (!input.just(d)) continue;
      const w = list[this.focus];
      if ((d === 'left' || d === 'right') && w && w.side && w.active !== false) { w.side(d === 'left' ? -1 : 1); sound('click'); return; }
      if (this.focus < 0) { this.focus = list.findIndex((x) => x.first) >= 0 ? list.findIndex((x) => x.first) : 0; return; }
      const n = neighbor(list, this.focus, d);
      if (n >= 0) this.focus = n;
      return;
    }
    if ((input.just('a') || input.just('start')) && list[this.focus]) this.activate(list[this.focus], 'key');
  }
  activate(w, how, m) {
    if (w.active === false) { if (w.tip) { this.tipT = 2.5; this.tipFor = w; } return; }
    if (w.kind !== 'field') sound('click');
    if (w.press) w.press(how, m);
  }
  drawWidgets(ctx) {
    const list = this.visible();
    list.forEach((w, i) => {
      const hot = i === this.hover || (!this.pm.useMouse && i === this.focus);
      if (w.kind === 'button' || w.kind === 'cycle') drawButton(ctx, w.x, w.y, w.w, w.h, typeof w.label === 'function' ? w.label() : w.label, { hover: hot, active: w.active !== false });
      else if (w.kind === 'field') drawField(ctx, w.x, w.y, w.w, w.h, w.value(), { focus: hot || w.editing(), hint: w.hint || '', t: this.t, editing: w.editing() });
      else if (w.kind === 'tab') drawTab(ctx, w.x, w.y, w.w, w.h, w.label, { selected: w.selected(), hover: hot });
      else if (w.draw) w.draw(ctx, hot);
    });
    // a disabled button's reason, as Minecraft's tooltip: on hover, on focus, or for a moment after a tap
    const tipW = (this.hover >= 0 && list[this.hover]) || (!this.pm.useMouse && list[this.focus]) || null;
    const show = this.tipT > 0 && this.tipFor ? this.tipFor : tipW && tipW.active === false && tipW.tip ? tipW : null;
    if (show && show.tip) drawTip(ctx, [show.tip], show.x + show.w / 2 - 20, show.y - 6);
  }
}
// Open the page-level box for a field widget; the value updates live and Cancel restores it.
function editField(screen, w, label, max, get, set, opt = {}) {
  const old = get();
  w.editingNow = true;
  if (opt.typed) set(String(old + opt.typed).slice(0, max));
  openTextEntry({ label, value: get(), maxLength: max, rect: { x: w.x, y: w.y, w: w.w, h: w.h }, canvasW: W, selectAll: !!opt.selectAll,
    onInput: (v) => set(v), onDone: (v) => { set(v); w.editingNow = false; }, onCancel: () => { set(old); w.editingNow = false; } });
}

// ------------------------------------------------------------------------------------------- Create New World (7.4)
export class CreateWorld extends McScreen {
  // opts: { count (worlds listed now), maxWorlds, name, type, mode, diff, seedText, types (the world types offered,
  //         MD.WORLD_TYPES by default; main.js passes both since stage 6a, Wild World only with KANTO_WORLDS false) }
  constructor(opts = {}) {
    super();
    this.kind = 'createWorld';
    this.full = (opts.count || 0) >= (opts.maxWorlds || MD.MAX_WORLDS);
    this.name = opts.name || 'New World';
    this.names = Array.isArray(opts.names) ? opts.names : [];   // (playfix: the listed worlds' names, for the (2) suffix)
    this.types = Array.isArray(opts.types) && opts.types.filter((t) => MD.WORLD_TYPES.includes(t)).length ? opts.types.filter((t) => MD.WORLD_TYPES.includes(t)) : MD.WORLD_TYPES;
    this.type = this.types.includes(opts.type) ? opts.type : this.types[0];
    this.mode = MD.PLAYABLE_MODES.includes(opts.mode) ? opts.mode : 'survival';
    this.diff = MD.DIFFS.includes(opts.diff) ? opts.diff : 'normal';
    this.seedText = opts.seedText || '';
    this.tab = 0;
    const cx = W / 2;
    const tw = 124, ty = 16, th = 24;
    this.w = {
      tabGame: { kind: 'tab', label: 'Game', x: cx - tw, y: ty, w: tw, h: th, selected: () => this.tab === 0, press: () => { this.tab = 0; }, side: (d) => { this.tab = d > 0 ? 1 : 0; } },
      tabWorld: { kind: 'tab', label: 'World', x: cx, y: ty, w: tw, h: th, selected: () => this.tab === 1, press: () => { this.tab = 1; }, side: (d) => { this.tab = d > 0 ? 1 : 0; } },
      name: { kind: 'field', x: cx - 104, y: 62, w: 208, h: 20, value: () => this.name, editing: () => !!this.w.name.editingNow,
        press: () => editField(this, this.w.name, 'World Name', MD.NAME_MAX, () => this.name, (v) => { this.name = v; }, { selectAll: true }),
        typeInto: (k) => editField(this, this.w.name, 'World Name', MD.NAME_MAX, () => this.name, (v) => { this.name = v; }, { typed: k }) },
      mode: { kind: 'cycle', x: cx - 105, y: 90, w: 210, h: 20, first: true, label: () => 'Game Mode: ' + MD.modeName(this.mode),
        press: () => this.cycleMode(1), side: (d) => this.cycleMode(d) },
      diff: { kind: 'cycle', x: cx - 105, y: 0, w: 210, h: 20, label: () => 'Difficulty: ' + MD.diffName(this.mode === 'hardcore' ? 'hard' : this.diff),
        press: () => { this.diff = MD.nextDiff(this.diff); }, side: (d) => { this.diff = d > 0 ? MD.nextDiff(this.diff) : MD.prevDiff(this.diff); } },
      type: { kind: 'cycle', x: cx - 105, y: 56, w: 210, h: 20, first: true, label: () => 'World Type: ' + MD.typeName(this.type),
        press: () => this.cycleType(), side: () => this.cycleType() },
      seed: { kind: 'field', x: cx - 154, y: 110, w: 308, h: 20, value: () => this.seedText, editing: () => !!this.w.seed.editingNow,
        press: () => editField(this, this.w.seed, 'Seed for the World Generator', MD.SEED_MAX, () => this.seedText, (v) => { this.seedText = v; }),
        typeInto: (k) => editField(this, this.w.seed, 'Seed for the World Generator', MD.SEED_MAX, () => this.seedText, (v) => { this.seedText = v; }, { typed: k }) },
      create: { kind: 'button', label: 'Create New World', x: cx - 154, y: H - 28, w: 150, h: 20, tip: 'You have too many worlds',
        press: () => this.finish(MD.newWorldRequest({ ...this, name: uniqueName(MD.cleanName(this.name), this.names) })) },
      cancel: { kind: 'button', label: 'Cancel', x: cx + 4, y: H - 28, w: 150, h: 20, press: () => this.finish({ op: 'back' }) },
    };
    this.w.create.active = !this.full;
    this.focus = this.visible().indexOf(this.w.mode);
  }
  cycleMode(d) { this.mode = d > 0 ? MD.nextMode(this.mode) : MD.prevMode(this.mode); }
  cycleType() { this.type = this.types[(this.types.indexOf(this.type) + 1) % this.types.length]; }
  // the Game tab's rows move with the mode's description (it is two or three lines)
  descLines() {
    const lines = wrapMc(MD.MODE_DESC[this.mode], 204).map((text) => ({ text, color: GREY }));   // (playfix: inside the 210-wide button)
    if (this.mode === 'hardcore') lines.push({ text: MD.HARDCORE_BATTLE_LINE, color: GREY });
    return lines;
  }
  widgets() {
    const w = this.w, game = this.tab === 0;
    w.diff.y = 90 + 24 + this.descLines().length * 10 + 6;
    w.diff.hidden = !game || this.mode === 'creative';
    w.diff.active = this.mode !== 'hardcore';
    w.name.hidden = !game; w.mode.hidden = !game;
    w.type.hidden = game; w.seed.hidden = game;
    return [w.tabGame, w.tabWorld, w.name, w.mode, w.diff, w.type, w.seed, w.create, w.cancel];
  }
  click() { /* a tap on empty space does nothing */ }
  draw(ctx) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    drawDirt(ctx);
    textC(ctx, 'Create New World', W / 2, 5, WHITE, true);
    drawSeparator(ctx, 40, 'header');
    drawSeparator(ctx, H - 36, 'footer');
    const cx = W / 2;
    if (this.tab === 0) {
      mcText(ctx, 'World Name', cx - 104, 51, GREY, true);
      this.descLines().forEach((l, i) => mcText(ctx, l.text, cx - 105 + 2, 114 + i * 10, l.color, true));
    } else {
      mcText(ctx, MD.TYPE_DESC[this.type], cx - 105 + 2, 80, GREY, true);
      mcText(ctx, 'Seed for the World Generator', cx - 154, 99, GREY, true);
      mcText(ctx, 'Leave blank for a random seed', cx - 154 + 2, 134, GREY, true);   // Minecraft's -6250336, lighter on a phone
    }
    this.drawWidgets(ctx);
    ctx.restore();
  }
}

// ------------------------------------------------------------------------------------------- confirmations
// Minecraft's ConfirmScreen: a title, message lines, and two buttons.
export class ConfirmScreen extends McScreen {
  constructor({ title, lines = [], yes = 'Delete', no = 'Cancel', onYes = null, onNo = null, lock = 0 }) {
    super();
    this.kind = 'confirm';
    this.lockT = lock;
    this.title = title; this.lines = [];
    for (const l of lines) for (const text of wrapMc(typeof l === 'string' ? l : l.text, 400)) this.lines.push({ text, color: (typeof l === 'string' ? null : l.color) || WHITE });
    const by = Math.min(90 + this.lines.length * 12 + 18, H / 6 + 120);
    this.w = {
      yes: { kind: 'button', label: yes, x: W / 2 - 155, y: by, w: 150, h: 20, press: () => { this.finish({ op: 'yes' }); if (onYes) onYes(); } },
      no: { kind: 'button', label: no, x: W / 2 + 5, y: by, w: 150, h: 20, first: true, press: () => { this.finish({ op: 'no' }); if (onNo) onNo(); } },
    };
    this.onNo = onNo;
    this.focus = 1;   // Cancel first, so a stray A never deletes
  }
  widgets() { return [this.w.yes, this.w.no]; }
  back() { sound('click'); this.finish({ op: 'no' }); if (this.onNo) this.onNo(); }
  draw(ctx) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    drawDirt(ctx);
    textC(ctx, this.title, W / 2, 70, WHITE, true);
    this.lines.forEach((l, i) => textC(ctx, l.text, W / 2, 90 + i * 12, l.color, true));
    this.drawWidgets(ctx);
    ctx.restore();
  }
}
// The delete flow for one world (7.3): one confirmation, two for Classic Kanto (the second's button reads
// "Delete Classic Kanto"), since NEW GAME cannot make Classic again.
export function deleteConfirm(entry, onDeleted, onKept) {
  const classic = entry.id === 'classic' || entry.type === 'classic';
  const name = entry.name || (classic ? 'Classic Kanto' : 'New World');
  const lines = [`'${name}' will be lost forever! (A long time!)`];
  if (classic) lines.push({ text: "Classic Kanto can't be made again.", color: RED });
  const title = 'Are you sure you want to delete this world?';
  if (!classic) return new ConfirmScreen({ title, lines, onYes: onDeleted, onNo: onKept });
  let second = null;
  const first = new ConfirmScreen({ title, lines, onYes: () => { second = new ConfirmScreen({ title, lines, yes: 'Delete Classic Kanto', onYes: onDeleted, onNo: onKept, lock: 0.5 }); }, onNo: onKept });
  first.next = () => second;
  return first;
}

// ------------------------------------------------------------------------------------------- Select World (7.3)
const ROW_H = 36, ROW_W = 270, LIST_Y0 = 26, LIST_Y1 = H - 62;
export class SelectWorld extends McScreen {
  // opts: { worlds: entries or () => entries, maxWorlds, onDelete(id) }
  constructor(opts = {}) {
    super();
    this.kind = 'selectWorld';
    this.src = opts.worlds || [];
    this.max = opts.maxWorlds || MD.MAX_WORLDS;
    this.onDelete = opts.onDelete || null;
    this.sel = -1; this.scroll = 0; this.child = null; this.lastClick = { id: null, t: -9 };
    this.refresh();
    if (this.list.length) this.sel = 0;
    const cx = W / 2;
    this.w = {
      list: { kind: 'list', x: cx - ROW_W / 2, y: LIST_Y0, w: ROW_W, h: LIST_Y1 - LIST_Y0, first: true, press: (how, m) => this.listPress(how, m), draw: (ctx, hot) => this.drawList(ctx, hot) },
      play: { kind: 'button', label: 'Play Selected World', x: cx - 154, y: H - 52, w: 150, h: 20, press: () => this.play() },
      create: { kind: 'button', label: 'Create New World', x: cx + 4, y: H - 52, w: 150, h: 20, tip: 'You have too many worlds', press: () => this.finish({ op: 'create' }) },
      del: { kind: 'button', label: 'Delete', x: cx - 154, y: H - 28, w: 150, h: 20, press: () => this.askDelete() },
      cancel: { kind: 'button', label: 'Cancel', x: cx + 4, y: H - 28, w: 150, h: 20, press: () => this.finish({ op: 'back' }) },
    };
    this.focus = 0;
  }
  refresh() {
    let l = [];
    try { l = (typeof this.src === 'function' ? this.src() : this.src) || []; } catch (e) { l = []; }
    this.list = l.filter((e) => e && e.id).slice().sort((a, b) => (Number(b.played) || 0) - (Number(a.played) || 0));
    if (this.sel >= this.list.length) this.sel = this.list.length - 1;
  }
  widgets() {
    const has = this.sel >= 0 && !!this.list[this.sel];
    this.w.play.active = has; this.w.del.active = has;
    this.w.create.active = this.list.length < this.max;
    return [this.w.list, this.w.play, this.w.create, this.w.del, this.w.cancel];
  }
  play() { const e = this.list[this.sel]; if (e) this.finish({ op: 'load', id: e.id }); }
  askDelete() {
    const e = this.list[this.sel];
    if (!e) return;
    this.child = deleteConfirm(e, () => {
      Promise.resolve().then(() => (this.onDelete ? this.onDelete(e.id) : null)).catch((err) => console.error(err)).then(() => { this.refresh(); if (this.sel < 0 && this.list.length) this.sel = 0; });
    }, () => {});
  }
  rowAt(m) {
    if (!inside(m, this.w.list)) return -1;
    const i = Math.floor((m.y - LIST_Y0 - 4 + this.scroll) / ROW_H);
    return i >= 0 && i < this.list.length ? i : -1;
  }
  listPress(how, m) {
    if (how === 'click') {
      const i = this.rowAt(m);
      if (i < 0) return;
      // a second tap (or a double click) on the selected world plays it, like Minecraft's double click
      const id = this.list[i].id;
      if (i === this.sel && this.lastClick.id === id && this.t - this.lastClick.t < 0.5) { this.play(); return; }
      this.sel = i; this.lastClick = { id, t: this.t };
      return;
    }
    this.play();
  }
  update(dt, input) {
    if (this.child) {
      this.child.update(dt, input);
      if (this.child.done) { const nx = this.child.next && this.child.next(); this.child = nx || null; this.lastClick = { id: null, t: -9 }; }
      this.t += dt;
      return;
    }
    // up and down inside the list move the selection (the list is one focus stop, as in Minecraft)
    const list = this.visible();
    if (list[this.focus] === this.w.list && !textEntryOpen()) {
      if (input.just('up') && this.sel > 0) { this.sel--; this.keepVisible(); input.pressed.delete('up'); sound('click'); }
      else if (input.just('down') && this.sel < this.list.length - 1) { this.sel++; this.keepVisible(); input.pressed.delete('down'); sound('click'); }
    }
    const wheel = input.takeWheel ? input.takeWheel() : 0;
    if (wheel) this.scroll = Math.max(0, Math.min(this.maxScroll(), this.scroll + wheel * ROW_H / 2));
    super.update(dt, input);
  }
  maxScroll() { return Math.max(0, this.list.length * ROW_H + 8 - (LIST_Y1 - LIST_Y0)); }
  keepVisible() {
    const top = this.sel * ROW_H, vis = LIST_Y1 - LIST_Y0 - 8;
    if (top < this.scroll) this.scroll = top;
    if (top + ROW_H > this.scroll + vis) this.scroll = top + ROW_H - vis;
  }
  drawIconFor(ctx, e, x, y) {
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(x, y, 32, 32);
    const id = e.type === 'wild' ? 'oak_sapling' : e.type === 'kanto' ? 'poke_ball' : 'door_pallet';
    ctx.save(); ctx.imageSmoothingEnabled = false; drawIcon(ctx, id, x, y, 32); ctx.restore();
  }
  drawList(ctx, hot) {
    const x0 = this.w.list.x;
    ctx.save(); ctx.beginPath(); ctx.rect(0, LIST_Y0, W, LIST_Y1 - LIST_Y0); ctx.clip();
    if (!this.list.length) textC(ctx, 'No worlds yet', W / 2, LIST_Y0 + 20, GREY, true);
    this.list.forEach((e, i) => {
      const y = LIST_Y0 + 4 + i * ROW_H - this.scroll;
      if (y + ROW_H < LIST_Y0 || y > LIST_Y1) return;
      if (i === this.sel) {
        ctx.fillStyle = hot || this.pm.useMouse ? WHITE : DARK; ctx.fillRect(x0 - 2, y - 2, ROW_W + 4, ROW_H);
        ctx.fillStyle = '#000000'; ctx.fillRect(x0 - 1, y - 1, ROW_W + 2, ROW_H - 2);
      }
      this.drawIconFor(ctx, e, x0 + 1, y + 1);
      if (i === this.sel) {
        ctx.fillStyle = 'rgba(144,144,144,0.63)'; ctx.fillRect(x0 + 1, y + 1, 32, 32);
        const j = M('join'); if (j) ctx.drawImage(j, x0 + 1, y + 1);
      }
      const tx = x0 + 36;
      mcText(ctx, fit(e.name || (e.id === 'classic' ? 'Classic Kanto' : 'New World'), ROW_W - 40), tx, y + 2, WHITE, true);
      const ln = MD.worldLine(e);
      let lx = tx;
      if (ln.type) lx += mcText(ctx, ln.type + ', ', lx, y + 13, DARK, true);
      mcText(ctx, ln.mode, lx, y + 13, ln.red ? DARK_RED : DARK, true);
      // the third line: the last played date, then the seed (7.4: "shown ... in the world list's details")
      const seed = seedOf(e), date = fmtDate(e.played);
      const third = [date, seed ? 'Seed: ' + seed : ''].filter(Boolean).join('  ');
      if (third) mcText(ctx, fit(third, ROW_W - 40), tx, y + 24, DARK, true);
    });
    ctx.restore();
    if (this.maxScroll() > 0) {
      const sx = x0 + ROW_W + 6, track = LIST_Y1 - LIST_Y0, kh = Math.max(16, Math.round(track * track / (this.list.length * ROW_H + 8)));
      const ky = LIST_Y0 + Math.round((track - kh) * this.scroll / this.maxScroll());
      ctx.fillStyle = '#000'; ctx.fillRect(sx, LIST_Y0, 6, track);
      const s = M('scroller'); if (s) nineSlice(ctx, s, sx, ky, 6, kh, 1); else { ctx.fillStyle = '#c0c0c0'; ctx.fillRect(sx, ky, 6, kh); }
    }
  }
  draw(ctx) {
    if (this.child) { this.child.draw(ctx); return; }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    drawDirt(ctx);
    drawListArea(ctx, LIST_Y0, LIST_Y1);
    textC(ctx, 'Select World', W / 2, 9, WHITE, true);
    drawSeparator(ctx, LIST_Y0 - 2, 'header');
    drawSeparator(ctx, LIST_Y1, 'footer');
    this.drawWidgets(ctx);
    ctx.restore();
  }
}

// ------------------------------------------------------------------------------------------- FireRed's main menu (7.2)
// FireRed's own layout (pokefirered src/main_menu.c): windows 24 tiles wide at tile column 3, CONTINUE with its stats
// in blue, the rest darkened by 7/16 except the selected window. The stats rows are 14 px apart (FireRed's are 16) and
// WORLDS sits where MYSTERY GIFT does, so the three windows end above the fan notice at the bottom of the title.
const FR_FG = '#626262', FR_SH = '#d5d5cd', FR_BLUE = '#2080f8';
// CONTINUE's rows: WORLD and TIME for Classic; WORLD, TYPE, MODE and TIME for a generated world (a dead hardcore world
// shows MODE Spectator, so the box says the world is over)
function contRows(c) {
  if (!c.type || c.type === 'classic') return [['WORLD', c.name || 'Classic Kanto'], ['TIME', fmtTime(c.playTime)]];
  const mode = c.mode === 'spectator' || c.dead ? 'Spectator' : MD.modeName(c.mode || 'survival');
  return [['WORLD', c.name || 'New World'], ['TYPE', MD.typeName(c.type)], ['MODE', mode], ['TIME', fmtTime(c.playTime)]];
}
export class TitleMenu {
  // opts: { cont: { name, type, mode, playTime } | null, worldCount, backdrop(ctx) }
  constructor(opts = {}) {
    this.kind = 'titleMenu';
    this.cont = opts.cont || null;
    this.backdrop = opts.backdrop || null;
    this.items = [];
    let y = 0;
    // (playfix: Classic's box drops the TYPE row that repeated its name; a generated world's adds its MODE row)
    if (this.cont) { this.items.push({ id: 'continue', label: 'CONTINUE', x: 16, y, w: 208, h: 76 }); y += 76; }
    this.items.push({ id: 'new', label: 'NEW GAME', x: 16, y, w: 208, h: 32 }); y += 32;
    if ((opts.worldCount || 0) > 1) this.items.push({ id: 'worlds', label: 'WORLDS', x: 16, y, w: 208, h: 32 });
    this.sel = 0; this.t = 0; this.done = false; this.result = null;
  }
  update(dt, input) {
    this.t += dt;
    if (input.just('up') && this.sel > 0) { this.sel--; sound('move'); }
    else if (input.just('down') && this.sel < this.items.length - 1) { this.sel++; sound('move'); }
    else if (input.just('b')) { sound('cancel'); this.finish({ op: 'back' }); }
    else if (input.just('a') || input.just('start')) { sound('select'); this.finish({ op: this.items[this.sel].id }); }
    else if (input.just('mouseL')) {
      const m = input.mouse, gx = m.x / 2, gy = m.y / 2;
      const i = this.items.findIndex((it) => gx >= it.x && gx < it.x + it.w && gy >= it.y && gy < it.y + it.h);
      if (i >= 0) { this.sel = i; sound('select'); this.finish({ op: this.items[i].id }); }
    }
  }
  finish(r) { this.result = r; this.done = true; }
  draw(ctx) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    if (this.backdrop) { try { this.backdrop(ctx); } catch (e) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); } }
    // (playfix: the title art is dimmed under the windows, so the logo's edges no longer show between them)
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    for (const it of this.items) {
      drawWindow(ctx, it.x, it.y, it.w, it.h);
      drawText(ctx, it.label, it.x + 10, it.y + 10, FR_FG, FR_SH);
      if (it.id === 'continue' && this.cont) {
        const c = this.cont, vx = it.x + 70, maxW = it.x + it.w - 10 - vx;
        const rows = contRows(c);
        // (four rows sit 12 px apart from y 24, so the box keeps its height and the three windows clear the fan notice)
        const y0 = rows.length > 3 ? 23 : 26, dy = rows.length > 3 ? 12 : 14;
        rows.forEach(([k, v], i) => {
          drawText(ctx, k, it.x + 10, it.y + y0 + i * dy, FR_BLUE, FR_SH);
          drawText(ctx, fitFr(v, maxW), vx, it.y + y0 + i * dy, FR_BLUE, FR_SH);
        });
      }
    }
    // FireRed darkens everything but the window under the cursor (BLDY 7 of 16)
    const s = this.items[this.sel];
    ctx.fillStyle = 'rgba(0,0,0,0.4375)';
    ctx.beginPath(); ctx.rect(0, 0, 240, 160); ctx.rect(s.x, s.y, s.w, s.h); ctx.fill('evenodd');
    ctx.restore();
  }
}

// ------------------------------------------------------------------------------------------- loading screens (7.6)
// "Generating world" with the plan's progress, then "Preparing spawn area" with the chunks ready of 9 and Minecraft's
// little chunk map; a co-op guest sees the same lines under "Joining...".
export class LoadingScreen {
  constructor({ joining = false } = {}) { this.kind = 'loading'; this.joining = joining; this.phase = 'plan'; this.progress = 0; this.ready = 0; this.total = 9; this.t = 0; this.done = false; }
  set({ phase, progress, ready, total } = {}) {
    if (phase) this.phase = phase;
    if (progress != null) this.progress = Math.max(0, Math.min(1, Number(progress) || 0));
    if (ready != null) this.ready = Math.max(0, Number(ready) || 0);
    if (total != null) this.total = Math.max(1, Number(total) || 1);
  }
  percent() { return Math.floor(100 * (this.phase === 'spawn' ? Math.min(1, this.ready / this.total) : this.progress)); }
  update(dt) { this.t += dt; }
  draw(ctx) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    drawDirt(ctx);
    const label = this.phase === 'spawn' ? 'Preparing spawn area' : 'Generating world';
    let y = H / 2 - 40;
    if (this.joining) { textC(ctx, 'Joining...', W / 2, y - 16, WHITE, true); }
    textC(ctx, `${label}: ${this.percent()}%`, W / 2, y, WHITE, true);
    // the chunk map: 3 x 3 squares, green when ready (Minecraft's colour for a full chunk), dark while waiting
    const n = Math.round(Math.sqrt(this.total)) || 3, cell = 10, x0 = Math.round(W / 2 - (n * cell) / 2), y0 = y + 22;
    ctx.fillStyle = '#000000'; ctx.fillRect(x0 - 2, y0 - 2, n * cell + 4, n * cell + 4);
    for (let i = 0; i < n * n; i++) {
      const ready = this.phase === 'spawn' ? i < this.ready : false;
      ctx.fillStyle = ready ? '#00e000' : this.phase === 'plan' ? '#303030' : '#5a5a5a';
      ctx.fillRect(x0 + (i % n) * cell + 1, y0 + Math.floor(i / n) * cell + 1, cell - 2, cell - 2);
    }
    if (this.phase === 'plan') {
      const bw = 182, bx = Math.round(W / 2 - bw / 2), by = y0 + n * cell + 14;
      ctx.fillStyle = '#000'; ctx.fillRect(bx - 1, by - 1, bw + 2, 7);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(bx, by, Math.round(bw * this.progress), 5);
    }
    ctx.restore();
  }
}

// ------------------------------------------------------------------------------------------- the flow
// opts: { cont (CONTINUE's stats, or a getter), bootedId, worlds (entries or a getter), onDelete(id), maxWorlds, backdrop(ctx),
//         start: 'title' | 'create' | 'select' }
export class WorldMenus {
  constructor(opts = {}) {
    this.opts = opts || {};
    this.kind = 'worldMenus';
    this.done = false; this.result = null; this.bootedDeleted = false;
    this.stack = [];
    loadMenuAssets();
    const start = opts.start || 'title';
    this.push(start === 'create' ? this.makeCreate() : start === 'select' ? this.makeSelect() : this.makeTitle());
  }
  entries() { try { const w = this.opts.worlds; return (typeof w === 'function' ? w() : w) || []; } catch (e) { return []; } }
  // the booted world: CONTINUE's stats while its id is still in the list, else null (it was deleted in Select World)
  bootedId() { const c = this.rawCont(); return this.opts.bootedId != null ? this.opts.bootedId : c && c.id != null ? c.id : null; }
  rawCont() { try { const c = this.opts.cont; return (typeof c === 'function' ? c() : c) || null; } catch (e) { return null; } }
  cont() {
    const c = this.rawCont(), id = this.bootedId();
    // (playfix: once the booted world is deleted, CONTINUE offers the newest world left, as the boot would pick it)
    if (this.bootedDeleted) { const n = this.replacement(); return n ? { id: n.id, name: n.name || (n.id === 'classic' ? 'Classic Kanto' : 'New World'), type: n.type || (n.id === 'classic' ? 'classic' : 'wild'), mode: n.mode, dead: !!(n.hc && n.hc.dead) || n.dead, playTime: Math.max(0, Number(n.playTime) || 0), replacement: true } : null; }
    if (!c) return null;
    if (id != null && !this.entries().some((e) => e && e.id === id)) return null;
    return c;
  }
  replacement() { return this.entries().filter((e) => e && e.id).sort((a, b) => (Number(b.played) || 0) - (Number(a.played) || 0))[0] || null; }
  makeTitle() { return new TitleMenu({ cont: this.cont(), worldCount: this.entries().length, backdrop: this.opts.backdrop }); }
  makeCreate() { return new CreateWorld({ count: this.entries().length, maxWorlds: this.opts.maxWorlds, types: this.opts.types, names: this.entries().map((e) => e && e.name) }); }
  makeSelect() {
    const onDelete = (id) => {
      const booted = this.bootedId();
      if (booted != null && id === booted) this.bootedDeleted = true;
      return this.opts.onDelete ? this.opts.onDelete(id) : null;
    };
    return new SelectWorld({ worlds: () => this.entries(), maxWorlds: this.opts.maxWorlds, onDelete });
  }
  push(s) { this.stack.push(s); }
  get top() { return this.stack[this.stack.length - 1]; }
  update(dt, input) {
    const s = this.top;
    if (!s || this.done) return;
    try { s.update(dt, input); } catch (e) { console.error(e); this.stack.pop(); if (!this.stack.length) this.end({ op: 'back' }); return; }
    if (!s.done) return;
    const r = s.result || { op: 'back' };
    this.stack.pop();
    if (s.kind === 'titleMenu') {
      if (r.op === 'new') { this.push(this.makeTitle()); this.push(this.makeCreate()); return; }
      if (r.op === 'worlds') { this.push(this.makeTitle()); this.push(this.makeSelect()); return; }
      this.end(r); return;
    }
    if (s.kind === 'selectWorld' && r.op === 'create') { this.push(this.makeSelect()); this.push(this.makeCreate()); return; }
    if (r.op === 'back') {
      if (this.stack.length) {
        // the screen below is rebuilt so it shows the current world list
        const below = this.stack.pop();
        this.push(below.kind === 'selectWorld' ? this.makeSelect() : below.kind === 'titleMenu' ? this.makeTitle() : below);
        return;
      }
      this.end(r); return;
    }
    this.end(r);
  }
  end(r) {
    closeTextEntry(false);
    // the world in memory is gone from the list: back (or a stray continue) must not return to it
    if (this.bootedDeleted && r && r.op === 'continue') { const n = this.replacement(); r = n ? { op: 'load', id: n.id } : { op: 'reboot' }; }
    else if (this.bootedDeleted && r && r.op === 'back') r = { op: 'reboot' };
    this.result = r; this.done = true;
  }
  draw(ctx) { const s = this.top; if (s) { try { s.draw(ctx); } catch (e) { console.error(e); } } }
}

// The boot request (7.1): written by the caller to sessionStorage['rs.world'] before it reloads.
export function bootRequest(r) {
  if (!r) return null;
  if (r.op === 'new') return MD.newWorldRequest(r);
  if (r.op === 'load' && r.id) return { op: 'load', id: String(r.id) };
  return null;
}
void A; void mcWidth;
