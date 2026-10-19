// Minecraft's merchant screen (world update design 5.7), drawn from its own GUI texture and sprites
// (assets/mc/villagers/gui, tools/build_villagers.py) at Minecraft's positions on the 480x320 layer: the offer list on the
// left (7 buttons of 88x20, a scroller), two payment slots and the result on the right, the inventory and hotbar below,
// "<Profession> - <Level>" and the villager's experience bar on top.
//
// It is a Screen (screens.js) with kind 'trade', so the inventory slots, the cursor stack, shift-click, number keys,
// Q and the keyboard slot cursor work exactly as in every other container. Selecting an offer moves what it costs from
// the inventory into the payment slots (Minecraft's behaviour); taking the result trades once; shift-click on the result
// trades as many times as the payment and the uses allow. Phones: tap an offer, tap the result; the pad's arrows move
// the cursor (the offer list is part of it) and A takes or selects. E, Esc or the pad's INV closes.
//
// Not wired into the game yet. To use it: await loadTradeAssets() once (generated worlds), then
// G.openTradeScreen = (v) => { screen = new TradeScreen(G, v); state = 'screen'; } with v the villager's trade state
// ({ vid, prof, vtype, lvl, xp, uses, demand }). opts.onTrade(v, offerKey, result, offer) runs after every trade (co-op's
// 'tr' message goes there, with the offer's stable key, never its list position); opts.sound(key) plays a sound key
// (default: audio.js mc(), silent while a key has no files). opts.has(id) decides which offers show (default: only those
// whose items items.json defines, so a trade can never put an unknown item id into the inventory; the standalone test
// page passes its own to show every sample offer).
import { Screen } from './screens.js';
import { A } from './assets.js';
import { mcText, mcWidth } from './mcfont.js';
import { drawStack, drawTooltip, tooltipLines, HW, HH } from './hud.js';
import { item, maxStack } from './items.js';
import { mc } from './audio.js';
import { offersFor, ensureState, costA, demandOf, outOfStock, matchOffer, recordTrade, levelName, xpProgress, NO_TRADES } from './trades.js';

const LABEL = '#404040';
const VISIBLE = 7;
export const TA = { data: null, meta: null, img: {}, icons: null, ready: false };

function loadImage(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('failed to load ' + url)); i.src = url; });
}
// The trade tables, the villager metadata, the merchant GUI and the icons of trade items items.json lacks yet.
export async function loadTradeAssets(base = 'assets/mc/villagers/') {
  if (TA.ready) return TA;
  const [data, meta] = await Promise.all([fetch(base + 'trades.json').then((r) => r.json()), fetch(base + 'villagers.json').then((r) => r.json())]);
  TA.data = data; TA.meta = meta;
  const jobs = Object.entries(meta.gui).map(([k, f]) => loadImage(base + f).then((img) => { TA.img[k] = img; }));
  jobs.push(loadImage(base + meta.icons.file).then((img) => { TA.icons = img; }));
  await Promise.all(jobs);
  TA.ready = true;
  return TA;
}

// ---------------------------------------------------------------- items that may not exist in items.json yet
const extraIcon = (id) => TA.meta && TA.meta.icons.items[id];
export const tradeName = (id) => (item(id) ? item(id).name : extraIcon(id) ? extraIcon(id).name : id);
const stackOf = (id) => (item(id) ? maxStack(id) : 64);
function drawItem(ctx, s, x, y) {
  if (!s) return;
  if (item(s.id)) { drawStack(ctx, s, x, y); return; }
  const e = extraIcon(s.id);
  if (e && TA.icons) {
    const c = TA.meta.icons.cols;
    ctx.drawImage(TA.icons, (e.i % c) * 16, Math.floor(e.i / c) * 16, 16, 16, Math.round(x), Math.round(y), 16, 16);
  }
  if (s.n > 1) { const t = String(s.n); mcText(ctx, t, x + 17 - mcWidth(t), y + 9, '#ffffff'); }
}
const tipLines = (s) => (item(s.id) ? tooltipLines(s) : [{ text: tradeName(s.id) }]);

export class TradeScreen extends Screen {
  constructor(G, villager, opts = {}) {
    super(G, 'trade', villager);
    this.v = ensureState(villager);
    this.opts = opts;
    this.data = opts.data || TA.data;
    this.w = 276; this.h = 166;
    this.pay = [null, null];
    this.has = opts.has || ((id) => !!item(id));
    this.offers = offersFor(this.v, this.data, this.has);
    this.pick = -1;            // the selected offer (Minecraft's shopItem)
    this.scroll = 0;
    this.focus = 'slot';       // keyboard cursor: 'slot' (this.sel) or 'offer' (this.offerCur)
    this.offerCur = 0;
    this.flash = 0;            // the level-up glow on the title
    this.slots = this.buildSlots();
    this.sel = this.slots.findIndex((s) => s.kind === 'inv' && s.idx === G.inv.sel);
    if (this.sel < 0) this.sel = 0;
    if (this.offers.length) { this.focus = 'offer'; }
    this.sound(NO_TRADES.has(this.v.prof) ? 'villager.no' : 'villager.trade');
  }
  sound(key) { try { (this.opts.sound || ((k) => mc(k, { vol: 0.6 })))(key); } catch (e) { /* never throw from a sound */ } }
  get x0() { return Math.round((HW - (this.w || 276)) / 2); }

  buildSlots() {
    const inv = this.G.inv, S = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) {
      const idx = 9 + r * 9 + c;
      S.push({ kind: 'inv', idx, x: 108 + c * 18, y: 84 + r * 18, get: () => inv.slots[idx], set: (s) => { inv.slots[idx] = s; } });
    }
    for (let c = 0; c < 9; c++) S.push({ kind: 'inv', idx: c, x: 108 + c * 18, y: 142, get: () => inv.slots[c], set: (s) => { inv.slots[c] = s; } });
    S.push({ kind: 'pay', idx: 0, x: 136, y: 37, get: () => (this.pay ? this.pay[0] : null), set: (s) => { this.pay[0] = s; } });
    S.push({ kind: 'pay', idx: 1, x: 162, y: 37, get: () => (this.pay ? this.pay[1] : null), set: (s) => { this.pay[1] = s; } });
    S.push({ kind: 'result', x: 220, y: 37, get: () => this.result(), set: () => {} });
    return S;
  }
  // ---------------------------------------------------------------- the trade itself
  matched() { return this.pay ? matchOffer(this.v, this.offers, this.pay[0], this.pay[1], this.pick >= 0 ? this.pick : null, stackOf) : -1; }
  result() {
    const i = this.matched();
    return i < 0 ? null : { id: this.offers[i].result, n: this.offers[i].nR };
  }
  // take the result: once onto the cursor, or (shift) as many times as the payment, the uses and the inventory allow
  takeResult(shift) {
    const G = this.G;
    let made = 0;
    for (let guard = 0; guard < 64; guard++) {
      const i = this.matched();
      if (i < 0) break;
      const o = this.offers[i];
      if (shift) {
        const left = G.inv.add(o.result, o.nR);
        if (left > 0) { G.inv.remove(o.result, o.nR - left); break; }
      } else {
        if (this.cursor && !(this.cursor.id === o.result && !this.cursor.dmg && this.cursor.n + o.nR <= stackOf(o.result))) break;
        if (this.cursor) this.cursor.n += o.nR; else this.cursor = { id: o.result, n: o.nR };
      }
      const nA = costA(o, demandOf(this.v, o), stackOf(o.costA));
      this.pay[0].n -= nA; if (this.pay[0].n <= 0) this.pay[0] = null;
      if (o.costB) { this.pay[1].n -= o.nB; if (this.pay[1].n <= 0) this.pay[1] = null; }
      const r = recordTrade(this.v, o.key, this.data);
      made++;
      if (r) {
        if (G.giveXp) G.giveXp(r.playerXp);
        if (r.leveled) { this.offers = offersFor(this.v, this.data, this.has); this.flash = 1.5; this.sound('villager.celebrate'); }
      }
      if (this.opts.onTrade) this.opts.onTrade(this.v, o.key, r, o);
      if (!shift) break;
    }
    if (made) this.sound('villager.yes');
    return made;
  }
  // Minecraft's tryMoveItems: the payment goes back to the inventory, then the offer's costs come out of it (each
  // payment slot filled up to a stack of its item)
  selectOffer(i) {
    const o = this.offers[i];
    if (!o) return;
    this.pick = i;
    this.returnPay();
    const fill = (slot, id) => {
      if (!id) return;
      let n = Math.min(stackOf(id), this.G.inv.count(id));
      if (n <= 0) return;
      this.G.inv.remove(id, n);
      this.pay[slot] = { id, n };
    };
    fill(0, o.costA);
    fill(1, o.costB);
    const ok = this.matched() === i;
    this.sound(ok ? 'villager.yes' : outOfStock(this.v, o) ? 'villager.no' : 'villager.trade');
    mc('click', { vol: 0.15 });
  }
  returnPay() {
    for (let k = 0; k < 2; k++) {
      const s = this.pay[k];
      if (!s) continue;
      const left = this.G.inv.add(s.id, s.n, s.dmg ? { dmg: s.dmg } : {});
      if (left && this.G.dropStack) this.G.dropStack({ ...s, n: left });
      this.pay[k] = null;
    }
  }
  close() { this.returnPay(); super.close(); }

  // ---------------------------------------------------------------- input
  offerRect(row) { return { x: this.x0 + 5, y: this.y0 + 18 + row * 20, w: 88, h: 20 }; }
  offerAt(mx, my) {
    for (let row = 0; row < VISIBLE; row++) {
      const i = this.scroll + row, r = this.offerRect(row);
      if (i < this.offers.length && mx >= r.x && mx < r.x + r.w && my >= r.y && my < r.y + r.h) return i;
    }
    return -1;
  }
  maxScroll() { return Math.max(0, this.offers.length - VISIBLE); }
  showOffer(i) { if (i < this.scroll) this.scroll = i; if (i >= this.scroll + VISIBLE) this.scroll = i - VISIBLE + 1; this.scroll = Math.max(0, Math.min(this.maxScroll(), this.scroll)); }
  update(dt, input) {
    this.t += dt;
    this.flash = Math.max(0, this.flash - dt);
    const m = input.mouse;
    if (m.x !== this.lastMouse.x || m.y !== this.lastMouse.y) { if (m.inside) this.useMouse = true; this.lastMouse = { x: m.x, y: m.y }; }
    if (['up', 'down', 'left', 'right'].some((d) => input.just(d))) this.useMouse = false;
    if (input.just('inv') || input.just('esc')) { this.done = true; return; }
    const shift = input.held('sprint');
    const wheel = input.takeWheel ? input.takeWheel() : 0;
    if (wheel) this.scroll = Math.max(0, Math.min(this.maxScroll(), this.scroll + wheel));
    if (this.useMouse) {
      const oi = this.offerAt(m.x, m.y);
      const si = this.slotAt(m.x, m.y);
      if (oi >= 0) { this.focus = 'offer'; this.offerCur = oi; } else if (si >= 0) { this.focus = 'slot'; this.sel = si; }
      if (input.just('mouseL') && oi >= 0) { this.selectOffer(oi); return; }
      // the scroller: a click on its track jumps there
      const sx = this.x0 + 94, sy = this.y0 + 18;
      if (input.just('mouseL') && this.maxScroll() > 0 && m.x >= sx && m.x < sx + 6 && m.y >= sy && m.y < sy + 139) {
        this.scroll = Math.round(((m.y - sy - 13) / (139 - 27)) * this.maxScroll()); this.scroll = Math.max(0, Math.min(this.maxScroll(), this.scroll)); return;
      }
      if (input.just('mouseL') && si >= 0) this.click(this.slots[si], 0, shift);
      else if (input.just('mouseR') && si >= 0) this.click(this.slots[si], 1, shift);
      else if ((input.just('mouseL') || input.just('mouseR')) && si < 0 && oi < 0 && this.cursor) {
        const outside = m.x < this.x0 || m.x >= this.x0 + this.w || m.y < this.y0 || m.y >= this.y0 + this.h;
        if (outside && this.G.dropStack) {
          if (input.just('mouseR')) { this.G.dropStack({ ...this.cursor, n: 1 }, true); this.cursor.n--; if (this.cursor.n <= 0) this.cursor = null; } else { this.G.dropStack(this.cursor, true); this.cursor = null; }
        }
      }
    } else if (this.focus === 'offer' && this.offers.length) {
      if (input.just('up')) { this.offerCur = Math.max(0, this.offerCur - 1); this.showOffer(this.offerCur); }
      if (input.just('down')) { this.offerCur = Math.min(this.offers.length - 1, this.offerCur + 1); this.showOffer(this.offerCur); }
      if (input.just('right')) { this.focus = 'slot'; this.sel = this.slots.findIndex((s) => s.kind === (this.result() ? 'result' : 'pay')); }
      if (input.just('a') || input.just('b')) this.selectOffer(this.offerCur);
    } else {
      // leaving the payment slots or the inventory's left column to the left goes back to the offer list
      if (input.just('left') && this.offers.length && this.neighbor(this.sel, 'left') < 0) { this.focus = 'offer'; this.showOffer(this.offerCur); }
      else for (const d of ['up', 'down', 'left', 'right']) if (input.just(d)) this.moveSel(d);
      if (this.focus === 'slot') {
        if (input.just('a')) this.click(this.slots[this.sel], 0, shift);
        if (input.just('b')) this.click(this.slots[this.sel], 1, shift);
      }
    }
    for (let k = 1; k <= 9; k++) {
      if (!input.just('slot' + k) || this.focus !== 'slot') continue;
      const s = this.slots[this.sel];
      if (!s || s.kind === 'result') continue;
      const hb = this.G.inv, a = s.get(), b = hb.slots[k - 1];
      s.set(b); hb.slots[k - 1] = a;
    }
    if (input.just('drop') && this.focus === 'slot') {
      const s = this.slots[this.sel], st = s && s.get();
      if (st && s.kind !== 'result' && this.G.dropStack) { const n = input.ctrl ? st.n : 1; this.G.dropStack({ ...st, n }, true); st.n -= n; if (st.n <= 0) s.set(null); }
    }
  }

  // ---------------------------------------------------------------- drawing
  title() {
    const names = (TA.meta && TA.meta.names) || {};
    const prof = names[this.v.prof] || this.v.prof;
    return NO_TRADES.has(this.v.prof) ? prof : `${prof} - ${levelName(this.v.lvl, this.data)}`;
  }
  drawButton(ctx, r, hot) {
    const img = TA.img[hot ? 'button_highlighted' : 'button'];
    if (!img) { ctx.fillStyle = hot ? '#a0a0ff' : '#8b8b8b'; ctx.fillRect(r.x, r.y, r.w, r.h); return; }
    // Minecraft's 200x20 button, nine-sliced to 88 wide: the left part and the 2-px right edge
    ctx.drawImage(img, 0, 0, r.w - 2, 20, r.x, r.y, r.w - 2, 20);
    ctx.drawImage(img, 198, 0, 2, 20, r.x + r.w - 2, r.y, 2, 20);
  }
  draw(ctx) {
    const x0 = this.x0, y0 = this.y0, G = this.G, mouse = G.input ? G.input.mouse : { x: -1, y: -1 };
    ctx.fillStyle = 'rgba(16,16,16,0.72)'; ctx.fillRect(0, 0, HW, HH);
    if (TA.img.panel) ctx.drawImage(TA.img.panel, 0, 0, 276, 166, x0, y0, 276, 166);
    // labels
    const title = this.title();
    mcText(ctx, title, x0 + 49 + 138 - Math.floor(mcWidth(title) / 2), y0 + 6, this.flash > 0 && Math.floor(this.flash * 6) % 2 ? '#2a7f1a' : LABEL, false);
    mcText(ctx, 'Trades', x0 + 5 - Math.floor(mcWidth('Trades') / 2) + 48, y0 + 6, LABEL, false);
    mcText(ctx, 'Inventory', x0 + 107, y0 + 72, LABEL, false);
    // the villager's experience bar (and what the selected offer would add)
    const pi = this.pick >= 0 ? this.pick : this.matched();
    const prog = !NO_TRADES.has(this.v.prof) && xpProgress(this.v, this.data, pi >= 0 && this.offers[pi] ? this.offers[pi].xp : 0);
    if (prog && TA.img.experience_bar_background) {
      ctx.drawImage(TA.img.experience_bar_background, x0 + 136, y0 + 16);
      const wc = Math.floor(102 * prog.cur), wn = Math.min(102, Math.floor(102 * prog.next));
      if (wn > wc) ctx.drawImage(TA.img.experience_bar_result, wc, 0, wn - wc, 5, x0 + 136 + wc, y0 + 16, wn - wc, 5);
      if (wc > 0) ctx.drawImage(TA.img.experience_bar_current, 0, 0, wc, 5, x0 + 136, y0 + 16, wc, 5);
    }
    // the offer list
    let tip = null;
    for (let row = 0; row < VISIBLE; row++) {
      const i = this.scroll + row, o = this.offers[i];
      if (!o) break;
      const r = this.offerRect(row);
      const hot = (this.useMouse && i === this.offerAt(mouse.x, mouse.y)) || (!this.useMouse && this.focus === 'offer' && i === this.offerCur) || i === this.pick;
      this.drawButton(ctx, r, hot);
      const iy = y0 + 19 + row * 20;
      const real = costA(o, demandOf(this.v, o), stackOf(o.costA));
      if (real === o.nA) drawItem(ctx, { id: o.costA, n: real }, x0 + 10, iy);
      else {
        // Minecraft's raised (or discounted) price: the base count struck through, the real count beside it
        drawItem(ctx, { id: o.costA, n: o.nA }, x0 + 10, iy);
        if (o.nA === 1) mcText(ctx, '1', x0 + 10 + 17 - mcWidth('1'), iy + 9, '#ffffff');
        const t = String(real); mcText(ctx, t, x0 + 24 + 17 - mcWidth(t), iy + 9, '#ffffff');
        if (TA.img.discount_strikethrough) ctx.drawImage(TA.img.discount_strikethrough, x0 + 17, iy + 12);
      }
      if (o.costB) drawItem(ctx, { id: o.costB, n: o.nB }, x0 + 40, iy);
      const arrow = TA.img[outOfStock(this.v, o) ? 'trade_arrow_out_of_stock' : 'trade_arrow'];
      if (arrow) ctx.drawImage(arrow, x0 + 60, iy + 3);
      drawItem(ctx, { id: o.result, n: o.nR }, x0 + 73, iy);
      if (hot && this.useMouse) {
        const mx = mouse.x;
        const at = mx < x0 + 36 ? { id: o.costA, n: real } : mx < x0 + 58 ? (o.costB ? { id: o.costB, n: o.nB } : null) : mx >= x0 + 72 ? { id: o.result, n: o.nR } : null;
        if (at) tip = [tipLines(at), mouse.x, mouse.y];
      }
    }
    if (!this.offers.length) { const t = NO_TRADES.has(this.v.prof) ? 'Hrmm' : 'No trades'; mcText(ctx, t, x0 + 49 - Math.floor(mcWidth(t) / 2), y0 + 80, '#555555', false); }
    // the scroller
    const sc = TA.img[this.maxScroll() > 0 ? 'scroller' : 'scroller_disabled'];
    if (sc) ctx.drawImage(sc, x0 + 94, y0 + 18 + (this.maxScroll() > 0 ? Math.round((this.scroll / this.maxScroll()) * (139 - 27)) : 0));
    // out of stock: Minecraft's red cross over the trade arrow of the main panel
    if (this.pick >= 0 && this.offers[this.pick] && outOfStock(this.v, this.offers[this.pick]) && TA.img.out_of_stock) ctx.drawImage(TA.img.out_of_stock, x0 + 182, y0 + 35);
    // slots
    this.slots.forEach((s, i) => {
      const st = s.get(), x = x0 + s.x, y = y0 + s.y;
      if (st) drawItem(ctx, st, x, y);
      if (this.focus === 'slot' && i === this.sel) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(x, y, 16, 16);
        if (!this.useMouse) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.strokeRect(x - 1.5, y - 1.5, 19, 19); }
      }
    });
    if (!this.useMouse && this.focus === 'offer' && this.offers.length) {
      const row = this.offerCur - this.scroll;
      if (row >= 0 && row < VISIBLE) { const r = this.offerRect(row); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1); }
    }
    // the cursor stack, then a tooltip
    if (this.cursor) {
      if (this.useMouse) drawItem(ctx, this.cursor, mouse.x - 8, mouse.y - 8);
      else if (this.focus === 'slot') { const s = this.slots[this.sel]; drawItem(ctx, this.cursor, x0 + s.x + 6, y0 + s.y - 6); }
    } else if (tip) drawTooltip(ctx, tip[0], tip[1], tip[2]);
    else if (this.focus === 'slot') {
      const s = this.slots[this.sel], st = s && s.get();
      // with the mouse, only while it is over that slot (Minecraft's hover tooltip)
      if (st && (!this.useMouse || this.slotAt(mouse.x, mouse.y) === this.sel)) drawTooltip(ctx, tipLines(st), this.useMouse ? mouse.x : x0 + s.x + 16, this.useMouse ? mouse.y : y0 + s.y);
    } else if (!this.useMouse && this.offers[this.offerCur]) {
      const o = this.offers[this.offerCur], r = this.offerRect(this.offerCur - this.scroll);
      drawTooltip(ctx, tipLines({ id: o.result, n: o.nR }), r.x + r.w, r.y + 4);
    }
  }
}
