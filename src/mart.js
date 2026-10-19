// FireRed's Poké Mart, behind each Mart clerk's counter: BUY, SELL, SEE YA!, a priced list with the item's
// description, a quantity box (up/down by one, left/right by ten), YES/NO, and the MONEY box. Stock is
// that Mart's FireRed list (tools/build_world.py exports them) plus a few Minecraft goods; a Mart pays
// half price for anything Steve sells, as in FireRed.
import { A } from './assets.js';
import { G } from './game.js';
import { VW, VH, FG, SH, drawWindow, cursorArrow, wrap } from './ui.js';
import { drawText, textWidth } from './font.js';
import { item, nameOf, maxStack } from './items.js';
import { drawIcon } from './hud.js';
import { sfx, mc } from './audio.js';

const FR_IDS = { POKE_BALL: 'poke_ball', GREAT_BALL: 'great_ball', ULTRA_BALL: 'ultra_ball', POTION: 'potion', SUPER_POTION: 'super_potion',
  HYPER_POTION: 'hyper_potion', MAX_POTION: 'max_potion', FULL_RESTORE: 'full_restore', REVIVE: 'revive', ANTIDOTE: 'antidote',
  PARALYZE_HEAL: 'paralyze_heal', AWAKENING: 'awakening', BURN_HEAL: 'burn_heal', ICE_HEAL: 'ice_heal', FULL_HEAL: 'full_heal' };
const EXTRA = {
  ViridianCity_Mart_Items: ['torch', 'bread', 'wheat_seeds'],
  PewterCity_Mart_Items: ['torch', 'stone_pickaxe', 'cooked_porkchop'],
  CeruleanCity_Mart_Items: ['fishing_rod', 'bucket', 'oak_boat'],
  VermilionCity_Mart_Items: ['oak_boat', 'cooked_cod', 'campfire'],
  LavenderTown_Mart_Items: ['torch', 'jack_o_lantern', 'bone_meal'],
  CeladonCity_DepartmentStore_2F_Items: ['white_bed', 'chest', 'glass', 'bookshelf', 'shears', 'bow', 'arrow'],
  CeladonCity_DepartmentStore_4F_Items: ['campfire', 'oak_sapling', 'hay_block'],
  FuchsiaCity_Mart_Items: ['hay_block', 'oak_sapling', 'campfire'],
  SaffronCity_Mart_Items: ['iron_sword', 'iron_pickaxe'],
  CinnabarIsland_Mart_Items: ['flint_and_steel', 'cooked_salmon'],
  IndigoPlateau_PokemonCenter_1F_Items: ['golden_apple', 'cooked_beef'],
};
export function stockFor(listId) {
  const fr = ((A.world.marts || {})[listId] || []).map((k) => FR_IDS[k]).filter(Boolean);
  const all = [...fr, ...(EXTRA[listId] || [])].filter((id) => item(id) && item(id).price);
  return all.length ? [...new Set(all)] : ['poke_ball', 'potion', 'antidote', 'paralyze_heal', 'torch', 'bread'];
}
const label = (id) => (item(id).frName || nameOf(id).toUpperCase());
const yen = (n, w = 0) => '¥' + String(n).padStart(w, ' ');
export const salePrice = (s) => {
  const it = item(s.id);
  if (!it || !it.price) return 0;
  let p = it.sell != null ? it.sell : Math.floor(it.price / 2);
  // generated worlds only (the world update's economy, design section 20): Marts pay less for what villagers sell
  // cheaply (assets/mc/villagers/trades.json martGen, proven by tools/trade_check.py); Classic never sets G.martGen
  const gen = G.martGen && G.martGen.sell;
  if (gen && Object.prototype.hasOwnProperty.call(gen, s.id) && Number.isFinite(gen[s.id])) p = Math.min(p, gen[s.id]);
  const d = it.tool ? it.tool.dur : it.armor ? it.armor.dur : 0;
  if (s.dmg && d) p = Math.floor(p * (1 - s.dmg / d));
  return p;
};
function room(inv, id) {
  const m = maxStack(id); let r = 0;
  for (const s of inv.slots) r += !s ? m : s.id === id && !s.dmg ? m - s.n : 0;
  return r;
}

export class Mart {
  constructor(listId) {
    this.stock = stockFor(listId);
    this.mode = 'menu'; this.menu = 0; this.cursor = 0; this.top = 0; this.qty = 1; this.yes = 0;
    this.note = null; this.done = false; this.selling = false;
  }
  rows() {
    if (!this.selling) return this.stock.map((id) => ({ id, label: label(id), right: yen(item(id).price, 4) }));
    const seen = new Map();
    for (const s of G.inv.slots) if (s) { const k = s.id + (s.dmg ? ':' + s.dmg : ''); if (!seen.has(k)) seen.set(k, { id: s.id, dmg: s.dmg, count: 0 }); seen.get(k).count += s.n; }
    return [...seen.values()].map((r) => ({ ...r, label: label(r.id), right: '×' + String(r.count).padStart(2, ' ') }));
  }
  say(text, then) { this.note = { text, then }; }
  update(input) {
    if (this.note) {
      if (input.just('a') || input.just('b')) { const t = this.note.then; this.note = null; sfx.select(); if (t) t(); }
      return;
    }
    const up = input.just('up'), down = input.just('down'), A_ = input.just('a'), B_ = input.just('b');
    if (this.mode === 'menu') {
      if (up || down) { this.menu = (this.menu + (up ? 2 : 1)) % 3; sfx.move(); }
      if (B_ || (A_ && this.menu === 2)) { this.done = true; sfx.cancel(); return; }
      if (A_) { sfx.select(); this.selling = this.menu === 1; this.mode = 'list'; this.cursor = 0; this.top = 0; }
      return;
    }
    const rows = this.rows(), n = rows.length + 1;      // + CANCEL
    if (this.mode === 'list') {
      if (up && this.cursor > 0) { this.cursor--; sfx.move(); }
      if (down && this.cursor < n - 1) { this.cursor++; sfx.move(); }
      this.top = Math.max(0, Math.min(this.top, this.cursor), this.cursor - 5);
      if (B_ || (A_ && this.cursor === n - 1)) { sfx.cancel(); this.mode = 'menu'; return; }
      if (!A_) return;
      sfx.select();
      const r = rows[this.cursor];
      if (!this.selling) {
        const price = item(r.id).price;
        if ((G.money || 0) < price) { this.say("You don't have enough money."); return; }
        this.say(`${r.label}? Certainly.\nHow many would you like?`, () => { this.mode = 'qty'; this.qty = 1; });
      } else {
        const p = salePrice({ id: r.id, dmg: r.dmg });
        if (!p) { this.say(`${r.label}? Oh, no.\nI can't buy that.`); return; }
        if (r.count === 1) { this.qty = 1; this.ask(); return; }
        this.say(`${r.label}?\nHow many would you like to sell?`, () => { this.mode = 'qty'; this.qty = 1; });
      }
      return;
    }
    const r = rows[this.cursor];
    if (this.mode === 'qty') {
      const max = this.selling ? Math.min(99, r.count) : Math.max(1, Math.min(99, Math.floor((G.money || 0) / item(r.id).price)));
      const before = this.qty;
      if (up) this.qty = this.qty >= max ? 1 : this.qty + 1;
      if (down) this.qty = this.qty <= 1 ? max : this.qty - 1;
      if (input.just('right')) this.qty = Math.min(max, this.qty + 10);
      if (input.just('left')) this.qty = Math.max(1, this.qty - 10);
      if (this.qty !== before) sfx.move();
      if (B_) { sfx.cancel(); this.mode = 'list'; return; }
      if (A_) { sfx.select(); this.ask(); }
      return;
    }
    if (this.mode === 'confirm') {
      if (up || down) { this.yes ^= 1; sfx.move(); }
      if (B_ || (A_ && this.yes === 1)) { sfx.cancel(); this.mode = 'list'; return; }
      if (A_) this.deal(r);
    }
  }
  ask() {
    const r = this.rows()[this.cursor];
    const total = this.selling ? salePrice({ id: r.id, dmg: r.dmg }) * this.qty : item(r.id).price * this.qty;
    this.prompt = this.selling ? `I can pay ${yen(total)}.\nWould that be okay?` : `${r.label}, and you want ${this.qty}.\nThat will be ${yen(total)}. Okay?`;
    this.total = total; this.mode = 'confirm'; this.yes = 0;
  }
  deal(r) {
    if (this.selling) {
      if (r.dmg) { const i = G.inv.slots.findIndex((s) => s && s.id === r.id && s.dmg === r.dmg); if (i >= 0) G.inv.slots[i] = null; }
      else G.inv.remove(r.id, this.qty);
      G.money = Math.min(999999, (G.money || 0) + this.total);
      mc('orb', { vol: 0.4, pitch: 1.2 });
      this.say(`Turned over the ${r.label}\nworth ${yen(this.total)}.`, () => { this.mode = 'list'; this.cursor = Math.min(this.cursor, this.rows().length); });
      return;
    }
    if (room(G.inv, r.id) < this.qty) { this.say('You have no more room for this\nitem.', () => { this.mode = 'list'; }); return; }
    G.money -= this.total;
    G.inv.add(r.id, this.qty);
    mc('orb', { vol: 0.4, pitch: 1.2 });
    this.say('Here you are!\nThank you!', () => { this.mode = 'list'; });
  }

  // ---------------------------------------------------------------- drawing (GBA space, over the store)
  draw(ctx) {
    const box = (x, y, w, h) => drawWindow(ctx, x, y, w, h);
    const text = (t, x, y, c = FG, s = SH) => drawText(ctx, t, x, y, c, s);
    const message = (t) => { box(0, VH - 48, VW, 48); wrap(t, VW - 24).slice(0, 2).forEach((l, i) => text(l, 12, VH - 40 + i * 16)); };
    if (this.mode === 'menu') {
      box(0, 0, 104, 60);
      ['BUY', 'SELL', 'SEE YA!'].forEach((l, i) => text(l, 22, 6 + i * 16));
      cursorArrow(ctx, 12, 9 + this.menu * 16);
      message(this.note ? this.note.text : 'Hi, there!\nMay I help you?');
      return;
    }
    // money box, list, description (FireRed's layout, drawn with the game's own windows)
    box(0, 0, 84, 40); text('MONEY', 10, 6); const m = yen(G.money || 0); text(m, 76 - textWidth(m), 22);
    const rows = this.rows(), all = [...rows, { label: 'CANCEL' }];
    const vis = all.slice(this.top, this.top + 6);
    box(88, 0, 152, 108);
    vis.forEach((r, i) => {
      text(r.label.length > 12 ? r.label.slice(0, 12) : r.label, 106, 6 + i * 16);
      if (r.right) text(r.right, 232 - textWidth(r.right), 6 + i * 16);
    });
    cursorArrow(ctx, 97, 9 + (this.cursor - this.top) * 16);
    // scroll arrows when the list runs past six rows
    const tri = (y, dn) => { ctx.fillStyle = '#e04040'; for (let k = 0; k < 4; k++) ctx.fillRect(160 - k, dn ? y + 3 - k : y + k, 1 + k * 2, 1); };
    if (this.top > 0) tri(1, false);
    if (this.top + 6 < all.length) tri(101, true);
    const cur = rows[this.cursor];
    if (this.note) { message(this.note.text); return; }
    if (this.mode === 'confirm') {
      message(this.prompt);
      box(VW - 56, VH - 48 - 40, 56, 40);
      text('YES', VW - 40, VH - 48 - 34); text('NO', VW - 40, VH - 48 - 18);
      cursorArrow(ctx, VW - 49, VH - 48 - 31 + this.yes * 16);
      return;
    }
    box(0, VH - 48, VW, 48);
    if (cur) {
      ctx.fillStyle = '#f8f8f8'; ctx.fillRect(8, VH - 40, 24, 24);
      drawIcon(ctx, cur.id, 12, VH - 36, 16);
      const it = item(cur.id), d = it.desc ? it.desc.replace(/\n/g, ' ') : nameOf(cur.id) + (this.selling ? '' : '. A Minecraft good from the back room.');
      wrap(d, VW - 52).slice(0, 2).forEach((l, i) => text(l, 40, VH - 40 + i * 16));
    } else text(this.selling ? 'Quit selling.' : 'Quit shopping.', 40, VH - 40);
    if (this.mode === 'qty' && cur) {
      box(VW - 112, 108 - 40, 112, 36);
      const unit = this.selling ? salePrice({ id: cur.id, dmg: cur.dmg }) : item(cur.id).price;
      text('×' + String(this.qty).padStart(2, '0'), VW - 102, 108 - 32);
      const t = yen(unit * this.qty); text(t, VW - 10 - textWidth(t), 108 - 32);
      if (!this.selling) { box(0, 44, 84, 28); text('IN BAG: ' + G.inv.count(cur.id), 10, 50); }
    }
  }
}
