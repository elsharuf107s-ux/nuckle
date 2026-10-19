// Minecraft items, recipes, smelting and the inventory, from assets/mc/items.json (tools/mcdata.py).
import { A } from './assets.js';

export const item = (id) => A.items.items[id];
export const maxStack = (id) => (item(id) ? item(id).stack : 64);
export const toolOf = (s) => (s && item(s.id) && item(s.id).tool) || null;
export const foodOf = (s) => (s && item(s.id) && item(s.id).food) || null;
export const nameOf = (id) => (item(id) ? item(id).name : id);
export const stack = (id, n = 1) => ({ id, n });
// Axe and hoe icons carry the blade on one side of the handle (which runs bottom-left to top-right).
// In Steve's hand it would trail the swing, so the in-hand drawings mirror these icons across the
// handle line, texel (x, y) from (15 - y, 15 - x): same grip, same head, blade on the leading side.
export const bladeSided = (id) => { const t = item(id) && item(id).tool; return !!t && (t.kind === 'axe' || t.kind === 'hoe'); };

// Seconds to break something with `held`, the way Minecraft computes it: tool speed over hardness,
// divided by 30 when the block can be harvested with what you hold and by 100 when it can't.
export function breakInfo(spec, held) {
  if (!spec || spec.hard < 0) return null;
  if (spec.hard === 0) return { ticks: 1, harvest: true };
  const t = toolOf(held);
  let speed = 1;
  const right = t && spec.tool && t.kind === spec.tool;
  if (right) speed = t.speed;
  if (t && t.kind === 'sword' && spec.sound === 'grass') speed = 1.5;
  if (t && t.kind === 'shears' && (spec.tool === 'shears' || spec.tool === 'hoe')) speed = 5;
  // a cobweb: a sword or shears cut through it fifteen times as fast as a hand
  if (t && spec.cut && spec.cut.includes(t.kind)) speed = 15;
  let harvest = true;
  if (spec.need) harvest = !!right && t.tier >= spec.need;
  const dmg = speed / spec.hard / (harvest ? 30 : 100);
  return { ticks: Math.max(1, Math.ceil(1 / dmg)), harvest };
}

// ---------------------------------------------------------------- crafting
// Recipe tags (Minecraft's #planks, #logs): a recipe key or ingredient '#name' takes any member of items.json `tags`
export const tagOf = (k) => (typeof k === 'string' && k[0] === '#' && A.items.tags && A.items.tags[k.slice(1)]) || null;
export const fits = (want, id) => { if (want === id) return true; const t = tagOf(want); return !!(t && id && t.includes(id)); };
// the inventory item a recipe key stands for: itself, or the first member of its tag the inventory has
export function pickFor(inv, k) { const t = tagOf(k); if (!t) return k; for (const id of t) if (inv.has(id)) return id; return t[0]; }
function trim(grid, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (grid[y * w + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 < 0) return null;
  const rows = [];
  for (let y = y0; y <= y1; y++) { const r = []; for (let x = x0; x <= x1; x++) r.push(grid[y * w + x] ? grid[y * w + x].id : null); rows.push(r); }
  return rows;
}
function matchShaped(rec, rows) {
  const R = rec.rows;
  if (R.length !== rows.length) return false;
  for (const mirror of [false, true]) {
    let ok = true;
    for (let y = 0; y < R.length && ok; y++) {
      const line = R[y];
      if (line.length !== rows[y].length) { ok = false; break; }
      for (let x = 0; x < line.length; x++) {
        const ch = mirror ? line[line.length - 1 - x] : line[x];
        const want = ch === ' ' ? null : rec.key[ch];
        if (want === null ? rows[y][x] !== null : !fits(want, rows[y][x])) { ok = false; break; }
      }
    }
    if (ok) return true;
  }
  return false;
}
function matchShapeless(rec, grid) {
  const have = grid.filter(Boolean).map((s) => s.id).sort();
  const want = [...rec.ins].sort();
  if (have.length !== want.length) return false;
  if (!want.some(tagOf)) return have.every((v, i) => v === want[i]);
  // with tags: every ingredient finds its own stack (a small backtracking match, at most nine of each)
  const used = new Array(have.length).fill(false);
  const go = (k) => {
    if (k === want.length) return true;
    for (let i = 0; i < have.length; i++) if (!used[i] && fits(want[k], have[i])) { used[i] = true; if (go(k + 1)) return true; used[i] = false; }
    return false;
  };
  return go(0);
}
// grid: array of w*h stacks (or null). Returns { recipe, id, n } or null.
export function craft(grid, w, h) {
  const rows = trim(grid, w, h);
  if (!rows) return null;
  if (rows.length > h || rows[0].length > w) return null;
  for (const r of A.items.recipes) {
    if (r.rows) { if (r.rows.length <= h && Math.max(...r.rows.map((l) => l.length)) <= w && matchShaped(r, rows)) return { recipe: r, id: r.out, n: r.n }; }
    else if (r.ins.length <= w * h && matchShapeless(r, grid)) return { recipe: r, id: r.out, n: r.n };
  }
  return null;
}
// Recipes the player could make right now from the inventory (for the recipe book).
export function craftable(inv, size) {
  const counts = new Map();
  for (const s of inv.slots) if (s) counts.set(s.id, (counts.get(s.id) || 0) + s.n);
  const have = (k) => { const t = tagOf(k); if (!t) return counts.get(k) || 0; let n = 0; for (const id of t) n += counts.get(id) || 0; return n; };
  const seen = new Set(), out = [];
  for (const r of A.items.recipes) {
    const need = new Map();
    if (r.rows) {
      if (r.rows.length > size || Math.max(...r.rows.map((l) => l.length)) > size) continue;
      for (const line of r.rows) for (const ch of line) if (ch !== ' ') need.set(r.key[ch], (need.get(r.key[ch]) || 0) + 1);
    } else {
      if (r.ins.length > size * size) continue;
      for (const i of r.ins) need.set(i, (need.get(i) || 0) + 1);
    }
    let ok = true;
    for (const [id, n] of need) if (have(id) < n) ok = false;
    const key = r.out + ':' + JSON.stringify(r.rows || r.ins);
    if (ok && !seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}
export const smeltOf = (id) => A.items.smelt[id] || null;
export const campfireOf = (id) => (A.items.campfire && A.items.campfire[id]) || null;
export const fuelOf = (id) => (item(id) && item(id).fuel) || 0;

// ---------------------------------------------------------------- inventory: hotbar 0-8, main 9-35, armor
export const ARMOR = ['helmet', 'chestplate', 'leggings', 'boots'];
export class Inventory {
  constructor() { this.slots = new Array(36).fill(null); this.armor = [null, null, null, null]; this.sel = 0; }
  get held() { return this.slots[this.sel]; }
  count(id) { let n = 0; for (const s of this.slots) if (s && s.id === id) n += s.n; return n; }
  has(id, n = 1) { return this.count(id) >= n; }
  // Add as much of (id, n) as fits: existing stacks first, then empty slots, hotbar before the rest.
  add(id, n = 1, extra = {}) {
    const max = maxStack(id);
    if (max > 1) {
      for (let i = 0; i < 36 && n > 0; i++) {
        const s = this.slots[i];
        if (s && s.id === id && s.n < max && !s.dmg) { const k = Math.min(n, max - s.n); s.n += k; n -= k; }
      }
    }
    for (let i = 0; i < 36 && n > 0; i++) {
      if (!this.slots[i]) { const k = Math.min(n, max); this.slots[i] = { id, n: k, ...extra }; n -= k; }
    }
    return n;
  }
  remove(id, n = 1) {
    for (let i = 35; i >= 0 && n > 0; i--) {
      const s = this.slots[i];
      if (s && s.id === id) { const k = Math.min(n, s.n); s.n -= k; n -= k; if (s.n <= 0) this.slots[i] = null; }
    }
    return n === 0;
  }
  // use one of the held stack (Creative, the world update's 6.1: `infinite`, set only in generated worlds, never uses
  // anything up and never wears a tool)
  useHeld() { const s = this.held; if (!s || this.infinite) return; s.n--; if (s.n <= 0) this.slots[this.sel] = null; }
  // an item spent from anywhere in the inventory (a POKe Ball thrown, an arrow shot): Creative keeps it
  spend(id, n = 1) { return this.infinite ? this.has(id, 1) : this.remove(id, n); }
  // damage the held tool; returns true when it breaks
  wearHeld(amount = 1) {
    const s = this.held, t = toolOf(s);
    if (!t || this.infinite) return false;
    s.dmg = (s.dmg || 0) + amount;
    if (s.dmg >= t.dur) { this.slots[this.sel] = null; return true; }
    return false;
  }
  armorPoints() { let p = 0; for (const a of this.armor) if (a) p += item(a.id).armor.points; return p; }
  armorToughness() { let t = 0; for (const a of this.armor) if (a) { const ar = item(a.id).armor; t += ar.tough ?? (ar.mat === 'diamond' ? 2 : 0); } return t; }
  serialize() { return { slots: this.slots, armor: this.armor, sel: this.sel }; }
  restore(d) { this.slots = d.slots.map((s) => (s && item(s.id) ? s : null)); this.armor = (d.armor || [null, null, null, null]).map((s) => (s && item(s.id) ? s : null)); this.sel = d.sel || 0; }
}
