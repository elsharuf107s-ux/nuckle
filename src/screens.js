// Minecraft's container screens, drawn from its own GUI textures with its own slot positions:
// the inventory (2x2 crafting, armor, the player model), the crafting table (3x3), the furnace and the
// chest. Mouse works as in Minecraft (left/right click, shift-click, number keys over a slot); without a
// mouse the arrow keys move a slot cursor, Z is left-click, X right-click, E or Esc closes.
import { A } from './assets.js';
import { mcText, mcWidth } from './mcfont.js';
import { drawStack, drawTooltip, tooltipLines, drawIcon, HW, HH } from './hud.js';
import { item, maxStack, craft, craftable, smeltOf, fuelOf, ARMOR, nameOf, pickFor } from './items.js';
import { mc } from './audio.js';
import { NET } from './net/flag.js';   // co-op: a guest's smelting XP is paid by the host

const LABEL = '#404040';
const G_smelt = (G) => !!G.onSmelt;
const same = (a, b) => a && b && a.id === b.id && !a.dmg && !b.dmg;

export class Screen {
  // kind: 'inventory' | 'craft' | 'furnace' | 'chest'
  constructor(G, kind, target = null) {
    this.G = G; this.kind = kind; this.target = target;
    this.size = kind === 'craft' ? 3 : 2;
    this.grid = new Array(this.size * this.size).fill(null);
    this.cursor = null;              // the stack held on the mouse cursor
    this.sel = 0;                    // keyboard slot cursor
    this.book = false; this.bookScroll = 0; this.bookSel = 0;
    this.t = 0;
    this.tex = { inventory: A.mc.gui_inventory, craft: A.mc.gui_crafting_table, furnace: A.mc.gui_furnace, chest: A.mc.gui_chest }[kind];
    this.w = 176; this.h = kind === 'chest' ? 168 : 166;
    this.slots = this.buildSlots();
    this.sel = this.slots.findIndex((s) => s.kind === 'inv' && s.idx === G.inv.sel);
    if (this.sel < 0) this.sel = 0;
    this.lastMouse = { x: -1, y: -1 };
    this.useMouse = false;
  }
  get x0() { return Math.round((HW - this.w) / 2) + (this.book ? 77 : 0); }
  get y0() { return Math.round((HH - this.h) / 2); }

  buildSlots() {
    const G = this.G, inv = G.inv, S = [];
    const invY = this.kind === 'chest' ? 85 : 84, hotY = this.kind === 'chest' ? 143 : 142;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) {
      const idx = 9 + r * 9 + c;
      S.push({ kind: 'inv', idx, x: 8 + c * 18, y: invY + r * 18, get: () => inv.slots[idx], set: (s) => { inv.slots[idx] = s; } });
    }
    for (let c = 0; c < 9; c++) S.push({ kind: 'inv', idx: c, x: 8 + c * 18, y: hotY, get: () => inv.slots[c], set: (s) => { inv.slots[c] = s; } });
    if (this.kind === 'inventory' || this.kind === 'craft') {
      const n = this.size;
      const gx = this.kind === 'craft' ? 30 : 98, gy = this.kind === 'craft' ? 17 : 18;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        const i = r * n + c;
        S.push({ kind: 'grid', idx: i, x: gx + c * 18, y: gy + r * 18, get: () => this.grid[i], set: (s) => { this.grid[i] = s; } });
      }
      S.push({ kind: 'result', x: this.kind === 'craft' ? 124 : 154, y: this.kind === 'craft' ? 35 : 28, get: () => this.result(), set: () => {} });
    }
    if (this.kind === 'inventory') {
      ARMOR.forEach((piece, i) => S.push({ kind: 'armor', idx: i, piece, x: 8, y: 8 + i * 18, get: () => inv.armor[i], set: (s) => { inv.armor[i] = s; },
        accept: (s) => !s || (item(s.id).armor && item(s.id).armor.slot === piece) }));
    }
    if (this.kind === 'furnace') {
      const f = this.target;
      S.push({ kind: 'fin', x: 56, y: 17, get: () => f.input, set: (s) => { f.input = s; } });
      S.push({ kind: 'fuel', x: 56, y: 53, get: () => f.fuel, set: (s) => { f.fuel = s; }, accept: (s) => !s || fuelOf(s.id) > 0 || s.id === 'bucket' });
      S.push({ kind: 'fout', x: 116, y: 35, get: () => f.output, set: (s) => { f.output = s; }, accept: (s) => !s });
    }
    if (this.kind === 'chest') {
      const ch = this.target;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) {
        const i = r * 9 + c;
        S.push({ kind: 'chest', idx: i, x: 8 + c * 18, y: 18 + r * 18, get: () => ch.slots[i], set: (s) => { ch.slots[i] = s; } });
      }
    }
    return S;
  }
  result() {
    const r = craft(this.grid, this.size, this.size);
    return r ? { id: r.id, n: r.n } : null;
  }
  takeResult(shift) {
    const G = this.G;
    let made = 0;
    for (let guard = 0; guard < 64; guard++) {
      const r = this.result();
      if (!r) break;
      if (shift) {
        const left = G.inv.add(r.id, r.n);
        if (left > 0) { G.inv.remove(r.id, r.n - left); break; }
      } else {
        if (this.cursor && !(same(this.cursor, r) && this.cursor.n + r.n <= maxStack(r.id))) break;
        if (this.cursor) this.cursor.n += r.n; else this.cursor = { id: r.id, n: r.n };
      }
      for (let i = 0; i < this.grid.length; i++) {
        const s = this.grid[i];
        if (!s) continue;
        s.n--;
        if (s.n <= 0) this.grid[i] = s.id === 'water_bucket' || s.id === 'milk_bucket' ? { id: 'bucket', n: 1 } : null;
      }
      made++;
      G.onCraft && G.onCraft(r.id);
      if (!shift) break;
    }
    if (made) mc('click', { vol: 0.15, pitch: 1.6 }) ;
    return made;
  }

  // ---------------------------------------------------------------- clicks
  click(slot, button, shift) {
    const G = this.G;
    if (slot.kind === 'result') { this.takeResult(shift); return; }
    const cur = slot.get();
    if (slot.kind === 'fout') {
      if (!cur) return;
      if (shift) { const left = G.inv.add(cur.id, cur.n); this.giveSmeltXp(cur.n - left); slot.set(left ? { ...cur, n: left } : null); if (G.onSmelt) G.onSmelt(cur.id); return; }
      if (!this.cursor) { this.cursor = cur; slot.set(null); this.giveSmeltXp(cur.n); }
      if (G_smelt(this.G)) this.G.onSmelt(cur.id);
      else if (same(this.cursor, cur) && this.cursor.n + cur.n <= maxStack(cur.id)) { this.cursor.n += cur.n; slot.set(null); this.giveSmeltXp(cur.n); }
      return;
    }
    if (shift && cur) { this.quickMove(slot); return; }
    const accept = slot.accept || (() => true);
    if (button === 0) {
      if (!this.cursor) { if (cur) { this.cursor = cur; slot.set(null); } return; }
      if (!accept(this.cursor)) return;
      if (!cur) { slot.set(this.cursor); this.cursor = null; return; }
      if (same(cur, this.cursor)) {
        const room = maxStack(cur.id) - cur.n, k = Math.min(room, this.cursor.n);
        cur.n += k; this.cursor.n -= k; if (this.cursor.n <= 0) this.cursor = null;
        return;
      }
      slot.set(this.cursor); this.cursor = cur;
    } else {
      if (!this.cursor) { if (cur) { const half = Math.ceil(cur.n / 2); this.cursor = { ...cur, n: half }; cur.n -= half; if (cur.n <= 0) slot.set(null); } return; }
      if (!accept(this.cursor)) return;
      if (!cur) { slot.set({ ...this.cursor, n: 1 }); this.cursor.n--; if (this.cursor.n <= 0) this.cursor = null; return; }
      if (same(cur, this.cursor) && cur.n < maxStack(cur.id)) { cur.n++; this.cursor.n--; if (this.cursor.n <= 0) this.cursor = null; return; }
      slot.set(this.cursor); this.cursor = cur;
    }
  }
  giveSmeltXp(n) {
    const f = this.target;
    if (!f || !n) return;
    if (NET.guest) { this.wantXp = true; return; }
    const xp = (f.xp || 0);
    f.xp = 0;
    if (xp > 0) this.G.giveXp(Math.floor(xp + Math.random() * 0.999));
  }
  // Shift-click: armor to its slot, inventory to the open container (furnace input/fuel, chest), and back.
  quickMove(slot) {
    const G = this.G, s = slot.get();
    const into = (kinds) => {
      let n = s.n;
      for (const k of kinds) {
        for (const t of this.slots) {
          if (t.kind !== k.kind || (k.filter && !k.filter(t)) || n <= 0) continue;
          if (t.accept && !t.accept(s)) continue;
          const c = t.get();
          if (c && same(c, s)) { const m = Math.min(n, maxStack(s.id) - c.n); c.n += m; n -= m; }
        }
        for (const t of this.slots) {
          if (t.kind !== k.kind || (k.filter && !k.filter(t)) || n <= 0) continue;
          if (t.accept && !t.accept(s)) continue;
          if (!t.get()) { t.set({ ...s, n }); n = 0; }
        }
      }
      if (n <= 0) slot.set(null); else s.n = n;
    };
    if (slot.kind === 'inv') {
      const it = item(s.id);
      if (this.kind === 'inventory' && it.armor) { const t = this.slots.find((q) => q.kind === 'armor' && q.piece === it.armor.slot); if (t && !t.get()) { t.set(s); slot.set(null); return; } }
      if (this.kind === 'furnace') { into(smeltOf(s.id) ? [{ kind: 'fin' }] : fuelOf(s.id) ? [{ kind: 'fuel' }] : []); return; }
      if (this.kind === 'chest') { into([{ kind: 'chest' }]); return; }
      into(slot.idx < 9 ? [{ kind: 'inv', filter: (t) => t.idx >= 9 }] : [{ kind: 'inv', filter: (t) => t.idx < 9 }]);
      return;
    }
    into([{ kind: 'inv', filter: (t) => t.idx < 9 }, { kind: 'inv', filter: (t) => t.idx >= 9 }]);
  }
  // recipe book: put a recipe's ingredients into the grid from the inventory
  fillRecipe(r) {
    const G = this.G, n = this.size;
    this.returnGrid();
    const place = (x, y, k) => { const id = pickFor(G.inv, k); if (!G.inv.remove(id, 1)) return false; this.grid[y * n + x] = { id, n: 1 }; return true; };
    if (r.rows) {
      const ox = n === 3 && r.rows[0].length < 3 ? 0 : 0;
      r.rows.forEach((line, y) => [...line].forEach((ch, x) => { if (ch !== ' ') place(x + ox, y, r.key[ch]); }));
    } else r.ins.forEach((id, i) => place(i % n, Math.floor(i / n), id));
    mc('click', { vol: 0.15 });
  }
  returnGrid() {
    for (let i = 0; i < this.grid.length; i++) {
      const s = this.grid[i];
      if (s) { const left = this.G.inv.add(s.id, s.n, s.dmg ? { dmg: s.dmg } : {}); if (left) this.G.dropStack({ ...s, n: left }); this.grid[i] = null; }
    }
  }
  close() {
    this.returnGrid();
    if (this.cursor) { const left = this.G.inv.add(this.cursor.id, this.cursor.n, this.cursor.dmg ? { dmg: this.cursor.dmg } : {}); if (left) this.G.dropStack({ ...this.cursor, n: left }); this.cursor = null; }
  }

  // ---------------------------------------------------------------- input
  slotAt(mx, my) {
    const x0 = this.x0, y0 = this.y0;
    return this.slots.findIndex((s) => mx >= x0 + s.x - 1 && mx < x0 + s.x + 17 && my >= y0 + s.y - 1 && my < y0 + s.y + 17);
  }
  bookRect() { return { x: this.x0 - 147 - 4, y: this.y0, w: 147, h: 166 }; }
  bookButton() { return this.kind === 'inventory' ? { x: this.x0 + 104, y: this.y0 + 61 } : this.kind === 'craft' ? { x: this.x0 + 5, y: this.y0 + 34 } : null; }
  update(dt, input) {
    this.t += dt;
    const m = input.mouse;
    if (m.x !== this.lastMouse.x || m.y !== this.lastMouse.y) { if (m.inside) this.useMouse = true; this.lastMouse = { x: m.x, y: m.y }; }
    if (['up', 'down', 'left', 'right'].some((d) => input.just(d))) this.useMouse = false;
    if (input.just('inv') || input.just('esc')) { this.done = true; return; }
    const shift = input.held('sprint');
    // recipe book toggle and clicks
    const bb = this.bookButton();
    if (input.just('mouseL') && bb && m.x >= bb.x && m.x < bb.x + 20 && m.y >= bb.y && m.y < bb.y + 18) { this.book = !this.book; mc('click', { vol: 0.15 }); return; }
    if (this.book) {
      const list = craftable(this.G.inv, this.size), br = this.bookRect();
      if (input.just('mouseL') && m.x >= br.x && m.x < br.x + br.w && m.y >= br.y && m.y < br.y + br.h) {
        const c = Math.floor((m.x - br.x - 11) / 25), r = Math.floor((m.y - br.y - 31) / 25);
        const i = r * 5 + c;
        if (c >= 0 && c < 5 && r >= 0 && list[i]) this.fillRecipe(list[i]);
        return;
      }
    }
    if (this.useMouse) {
      const i = this.slotAt(m.x, m.y);
      if (i >= 0) this.sel = i;
      if (input.just('mouseL') && i >= 0) this.click(this.slots[i], 0, shift);
      else if (input.just('mouseR') && i >= 0) this.click(this.slots[i], 1, shift);
      else if ((input.just('mouseL') || input.just('mouseR')) && i < 0 && this.cursor) {
        const outside = m.x < this.x0 || m.x >= this.x0 + this.w || m.y < this.y0 || m.y >= this.y0 + this.h;
        if (outside) { this.G.dropStack(input.just('mouseR') ? { ...this.cursor, n: 1 } : this.cursor, true); if (input.just('mouseR')) { this.cursor.n--; if (this.cursor.n <= 0) this.cursor = null; } else this.cursor = null; }
      }
    } else {
      for (const d of ['up', 'down', 'left', 'right']) if (input.just(d)) this.moveSel(d);
      if (input.just('a')) this.click(this.slots[this.sel], 0, shift);
      if (input.just('b')) this.click(this.slots[this.sel], 1, shift);
    }
    for (let k = 1; k <= 9; k++) {
      if (!input.just('slot' + k)) continue;
      const s = this.slots[this.sel];
      if (!s || s.kind === 'result') continue;
      const hb = this.G.inv;
      const a = s.get(), b = hb.slots[k - 1];
      if (s.accept && !s.accept(b)) continue;
      s.set(b); hb.slots[k - 1] = a;
    }
    if (input.just('drop')) {
      const s = this.slots[this.sel], st = s && s.get();
      if (st && s.kind !== 'result') { const n = input.ctrl ? st.n : 1; this.G.dropStack({ ...st, n }, true); st.n -= n; if (st.n <= 0) s.set(null); }
    }
  }
  moveSel(d) { const n = this.neighbor(this.sel, d); if (n >= 0) this.sel = n; }
  // The slot the cursor goes to from slot i in direction d (nearest along that direction).
  neighbor(i, d) {
    const cur = this.slots[i];
    const dx = d === 'left' ? -1 : d === 'right' ? 1 : 0, dy = d === 'up' ? -1 : d === 'down' ? 1 : 0;
    let best = -1, bd = Infinity;
    this.slots.forEach((s, j) => {
      if (j === i) return;
      const vx = s.x - cur.x, vy = s.y - cur.y;
      const along = vx * dx + vy * dy;
      if (along <= 0) return;
      const across = Math.abs(dx ? vy : vx);
      const score = along + across * 2.5;
      if (score < bd) { bd = score; best = j; }
    });
    return best;
  }
  // First direction to press to get from the cursor to slot t (breadth-first over neighbor()).
  routeTo(t) {
    const prev = new Map([[this.sel, null]]), q = [this.sel];
    while (q.length) {
      const i = q.shift();
      if (i === t) break;
      for (const d of ['up', 'down', 'left', 'right']) {
        const j = this.neighbor(i, d);
        if (j >= 0 && !prev.has(j)) { prev.set(j, [i, d]); q.push(j); }
      }
    }
    if (!prev.has(t) || t === this.sel) return null;
    let k = t, step = prev.get(k);
    while (step[0] !== this.sel) { k = step[0]; step = prev.get(k); }
    return step[1];
  }

  // ---------------------------------------------------------------- drawing (full-resolution canvas)
  draw(ctx) {
    const x0 = this.x0, y0 = this.y0;
    ctx.fillStyle = 'rgba(16,16,16,0.72)'; ctx.fillRect(0, 0, HW, HH);
    if (this.kind === 'chest') {
      ctx.drawImage(this.tex, 0, 0, 176, 71, x0, y0, 176, 71);
      ctx.drawImage(this.tex, 0, 126, 176, 96, x0, y0 + 71, 176, 96);
    } else ctx.drawImage(this.tex, 0, 0, 176, 166, x0, y0, 176, 166);
    // labels
    const title = { inventory: 'Crafting', craft: 'Crafting', furnace: 'Furnace', chest: 'Chest' }[this.kind];
    if (this.kind === 'inventory') mcText(ctx, title, x0 + 97, y0 + 8, LABEL, false);
    else if (this.kind === 'furnace') mcText(ctx, title, x0 + 88 - mcWidth(title) / 2, y0 + 6, LABEL, false);
    else mcText(ctx, title, x0 + (this.kind === 'craft' ? 28 : 8), y0 + 6, LABEL, false);
    if (this.kind !== 'inventory') mcText(ctx, 'Inventory', x0 + 8, y0 + (this.kind === 'chest' ? 73 : 72), LABEL, false);
    if (this.kind === 'inventory') {
      // the player in the black box, turned a little toward the cursor like Minecraft's model
      ctx.save(); ctx.beginPath(); ctx.rect(x0 + 26, y0 + 8, 49, 70); ctx.clip();
      ctx.drawImage(A.mc.portrait, x0 + 26 + Math.round((49 - A.mc.portrait.width) / 2), y0 + 78 - A.mc.portrait.height + 2);
      ctx.restore();
    }
    if (this.kind === 'furnace') {
      const f = this.target;
      if (f.burn > 0) {
        const h = Math.ceil((f.burn / Math.max(1, f.burnMax)) * 13) + 1;
        ctx.drawImage(A.mc.gui_lit_progress, 0, 14 - h, 14, h, x0 + 56, y0 + 36 + 14 - h, 14, h);
      }
      const w = Math.ceil((f.cook / 200) * 24);
      if (w > 0) ctx.drawImage(A.mc.gui_burn_progress, 0, 0, w, 16, x0 + 79, y0 + 34, w, 16);
    }
    const bb = this.bookButton();
    if (bb) {
      const hover = this.useMouse && this.G.input.mouse.x >= bb.x && this.G.input.mouse.x < bb.x + 20 && this.G.input.mouse.y >= bb.y && this.G.input.mouse.y < bb.y + 18;
      ctx.drawImage(hover ? A.mc.gui_recipe_button_highlighted : A.mc.gui_recipe_button, bb.x, bb.y);
    }
    // slots
    this.slots.forEach((s, i) => {
      const st = s.get();
      const x = x0 + s.x, y = y0 + s.y;
      if (s.kind === 'armor' && !st) { ctx.globalAlpha = 0.35; drawIcon(ctx, ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'][s.idx], x, y); ctx.globalAlpha = 1; }
      if (st) drawStack(ctx, st, x, y);
      if (i === this.sel) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(x, y, 16, 16);
        if (!this.useMouse) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.strokeRect(x - 1.5, y - 1.5, 19, 19); }
      }
    });
    if (this.book) this.drawBook(ctx);
    // the stack on the cursor follows the mouse (or sits over the selected slot)
    if (this.cursor) {
      if (this.useMouse) drawStack(ctx, this.cursor, this.G.input.mouse.x - 8, this.G.input.mouse.y - 8);
      else { const s = this.slots[this.sel]; drawStack(ctx, this.cursor, x0 + s.x + 6, y0 + s.y - 6); }
    } else {
      const s = this.slots[this.sel], st = s && s.get();
      if (st) {
        const px = this.useMouse ? this.G.input.mouse.x : x0 + s.x + 16, py = this.useMouse ? this.G.input.mouse.y : y0 + s.y;
        drawTooltip(ctx, tooltipLines(st), px, py);
      }
    }
  }
  drawBook(ctx) {
    const br = this.bookRect();
    // Minecraft's recipe book panel: grey panel, a grid of recipe buttons (green when craftable)
    ctx.fillStyle = '#c6c6c6'; ctx.fillRect(br.x, br.y, br.w, br.h);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(br.x, br.y, br.w, 1); ctx.fillRect(br.x, br.y, 1, br.h);
    ctx.fillStyle = '#555555'; ctx.fillRect(br.x, br.y + br.h - 1, br.w, 1); ctx.fillRect(br.x + br.w - 1, br.y, 1, br.h);
    mcText(ctx, 'Recipe Book', br.x + 8, br.y + 10, LABEL, false);
    const list = craftable(this.G.inv, this.size);
    list.slice(0, 25).forEach((r, i) => {
      const x = br.x + 11 + (i % 5) * 25, y = br.y + 31 + Math.floor(i / 5) * 25;
      ctx.fillStyle = '#8bbf6a'; ctx.fillRect(x, y, 25, 25);
      ctx.fillStyle = '#5c8a3f'; ctx.fillRect(x, y + 24, 25, 1); ctx.fillRect(x + 24, y, 1, 25);
      drawStack(ctx, { id: r.out, n: r.n }, x + 4, y + 4);
    });
    if (!list.length) mcText(ctx, 'Nothing to craft', br.x + 18, br.y + 70, '#555555', false);
  }
}

// ---------------------------------------------------------------- furnaces tick in the world, open or not
export function tickFurnace(f, onLit) {
  const recipe = f.input && smeltOf(f.input.id);
  const canOut = recipe && (!f.output || (f.output.id === recipe[0] && f.output.n < maxStack(recipe[0])));
  if (f.burn > 0) f.burn--;
  if (f.burn <= 0 && canOut && f.fuel) {
    const ticks = fuelOf(f.fuel.id);
    if (ticks > 0) {
      f.burn = f.burnMax = ticks;
      f.fuel.n--;
      if (f.fuel.n <= 0) f.fuel = f.fuel.id === 'lava_bucket' ? { id: 'bucket', n: 1 } : null;
      if (onLit) onLit(true);
    }
  }
  if (f.burn > 0 && canOut) {
    f.cook++;
    if (f.cook >= 200) {
      f.cook = 0;
      f.input.n--; if (f.input.n <= 0) f.input = null;
      if (f.output) f.output.n++; else f.output = { id: recipe[0], n: 1 };
      f.xp = (f.xp || 0) + recipe[1];
    }
  } else if (f.cook > 0) f.cook = Math.max(0, f.cook - 2);
  void nameOf;
}
