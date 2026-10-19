// Villager trades (world update design 5.6): the offers a villager has, Minecraft's levels, the daily restock and
// demand pricing. Pure functions over plain data, no DOM: the trade screen (tradeui.js), the villager behaviour and
// co-op's host validation all call the same code. The tables live in assets/mc/villagers/trades.json
// (tools/villager_trades.py, built by tools/build_villagers.py, proven by tools/trade_check.py).
//
// A villager's trade state is { vid, prof, lvl, xp, uses: {}, demand: {} }. Its offers are not saved: they are chosen
// per level from the profession's pool by a hash of vid, the level and each offer's id, so they never change.
// Every offer has a stable key "<level>:<id>" (the id is the table's tenth field), and `uses` and `demand` are keyed
// by it, never by a position. So retuning trades.json (adding, removing, reordering or repricing an offer) never moves
// a saved count onto another offer, and the pick is rendezvous hashing: each offer of a level gets its own score from
// (vid, level, id) and the villager takes the lowest two, so adding an offer to a pool changes a villager's offers only
// if the new one scores into its two, and removing or reordering an unpicked offer changes nothing. The hash is the
// world generator's (src/gen/hash.js hash32 and fnv1a), so there is one integer hash in the game.

import { hash32, fnv1a } from './gen/hash.js';

export { hash32 };
export const NO_TRADES = new Set(['none', 'nitwit']);
export const TRADE_SALT = fnv1a('villager.trades');

const F = ['costA', 'nA', 'costB', 'nB', 'result', 'nR', 'maxUses', 'xp', 'priceMul', 'id'];
export const offerKey = (lvl, id) => `${lvl}:${id}`;
const rowId = (row) => (row[9] != null ? String(row[9]) : `${row[0]}>${row[4]}`);
const toOffer = (row, lvl, slot) => {
  const o = { lvl, slot };
  F.forEach((k, i) => { o[k] = row[i] === undefined ? null : row[i]; });
  o.id = rowId(row);
  o.key = offerKey(lvl, o.id);
  return o;
};

// The ids a level's pool offers: the villager gets the `want` with the lowest hash32(vid, lvl, fnv1a(id), salt),
// returned as pool indexes in pool order.
export function pickFromPool(ids, vid, lvl, want = 2) {
  const n = ids.length;
  if (n <= want) return [...Array(n).keys()];
  return ids.map((id, i) => [hash32(vid | 0, lvl | 0, fnv1a(id), TRADE_SALT), i])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, want).map((x) => x[1]).sort((a, b) => a - b);
}

// Every offer the villager has now, level 1's first. `has(id)` (optional) hides offers that name an item the game does
// not define yet (the trade screen passes items.json's own lookup); the pick itself never depends on it, so an offer
// simply appears once its item lands.
export function offersFor(v, data, has = null) {
  if (!v || NO_TRADES.has(v.prof) || !data || !data.trades[v.prof]) return [];
  const out = [];
  const top = Math.max(1, Math.min(5, v.lvl || 1));
  for (let l = 1; l <= top; l++) {
    const pool = data.trades[v.prof][String(l)] || [];
    for (const i of pickFromPool(pool.map(rowId), v.vid | 0, l, data.offersPerLevel || 2)) {
      const o = toOffer(pool[i], l, i);
      if (has && !(has(o.costA) && (!o.costB || has(o.costB)) && has(o.result))) continue;
      out.push(o);
    }
  }
  return out;
}

// the offer a reference names: an offer object, its key, or an index into offersFor(v, data) (unfiltered)
export function findOffer(v, data, ref) {
  const all = offersFor(v, data);
  if (ref && typeof ref === 'object') ref = ref.key;
  if (typeof ref === 'string') return all.find((o) => o.key === ref) || null;
  return Number.isInteger(ref) ? all[ref] || null : null;
}

export function ensureState(v) {
  if (!v.lvl) v.lvl = 1;
  if (!v.xp) v.xp = 0;
  // keyed by offer key; anything else (an array from an early build) is dropped rather than guessed at
  if (!v.uses || typeof v.uses !== 'object' || Array.isArray(v.uses)) v.uses = {};
  if (!v.demand || typeof v.demand !== 'object' || Array.isArray(v.demand)) v.demand = {};
  return v;
}
export const usesOf = (v, o) => (v.uses && v.uses[o.key]) || 0;
export const demandOf = (v, o) => (v.demand && v.demand[o.key]) || 0;

// Minecraft's thresholds: Novice 0, Apprentice 10, Journeyman 70, Expert 150, Master 250 villager xp.
export function levelForXp(xp, data) {
  const L = (data && data.levels) || [0, 10, 70, 150, 250];
  let l = 1;
  for (let i = 1; i < L.length; i++) if (xp >= L[i]) l = i + 1;
  return l;
}
export function levelName(lvl, data) { return ((data && data.levelNames) || ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master'])[Math.max(0, Math.min(4, lvl - 1))]; }
// the experience bar: progress inside the current level as 0..1 (null at Master, where Minecraft hides it)
export function xpProgress(v, data, extra = 0) {
  const L = (data && data.levels) || [0, 10, 70, 150, 250];
  if (v.lvl >= 5) return null;
  const lo = L[v.lvl - 1], hi = L[v.lvl];
  return { cur: Math.max(0, Math.min(1, (v.xp - lo) / (hi - lo))), next: Math.max(0, Math.min(1, (v.xp + extra - lo) / (hi - lo))) };
}

// The first cost as shown and paid: base + max(0, floor(base * demand * priceMul)), clamped to 1..max stack.
export function costA(o, demand = 0, maxStack = 64) {
  const extra = Math.max(0, Math.floor(o.nA * Math.max(0, demand) * o.priceMul));
  return Math.max(1, Math.min(maxStack, o.nA + extra));
}
export const outOfStock = (v, o) => usesOf(v, o) >= o.maxUses;

// Restock once a day (at the start of the work period, at the job site): demand first, then the uses reset. Counts
// kept for offers the villager no longer has (a retuned table) are dropped.
export function restock(v, data) {
  ensureState(v);
  const offers = offersFor(v, data);
  const uses = {}, demand = {};
  for (const o of offers) {
    const u = usesOf(v, o);
    const d = Math.max(0, demandOf(v, o) + u - (o.maxUses - u));
    if (d) demand[o.key] = d;
  }
  v.uses = uses; v.demand = demand;
  return offers.length;
}

// Does a pair of payment stacks satisfy offer o? (Minecraft's MerchantOffer.satisfiedBy: same item, enough of it.)
export function satisfies(o, a, b, demand, maxStackOf = () => 64) {
  const need = costA(o, demand, maxStackOf(o.costA));
  if (!a || a.id !== o.costA || a.n < need || a.dmg) return false;
  if (o.costB) return !!(b && b.id === o.costB && b.n >= o.nB && !b.dmg);
  return !b;   // an offer with one cost needs the second payment slot empty, as in Minecraft
}
// The offer the payment slots make, as an index into `offers` (the list the caller shows): the selected one when they
// satisfy it, else the first that they satisfy.
export function matchOffer(v, offers, a, b, prefer, maxStackOf) {
  const ok = (i) => offers[i] && !outOfStock(v, offers[i]) && satisfies(offers[i], a, b, demandOf(v, offers[i]), maxStackOf);
  if (prefer != null && ok(prefer)) return prefer;
  for (let i = 0; i < offers.length; i++) if (ok(i)) return i;
  return -1;
}

// Book one trade of an offer (an offer object, its key, or an index into offersFor(v, data)); the costs are taken by
// the caller from wherever they sit: uses, villager xp and the level-up. Returns { leveled, lvl, playerXp, key } or
// null when the villager has no such offer or it is out of stock.
export function recordTrade(v, ref, data, rand = Math.random) {
  ensureState(v);
  const o = findOffer(v, data, ref);
  if (!o || outOfStock(v, o)) return null;
  v.uses[o.key] = usesOf(v, o) + 1;
  v.xp += o.xp;
  const px = (data && data.playerXp) || [3, 6];
  let playerXp = px[0] + Math.floor(rand() * (px[1] - px[0] + 1));
  let leveled = false;
  // Minecraft raises a villager one level at a time
  if (v.lvl < 5 && v.xp >= ((data && data.levels) || [0, 10, 70, 150, 250])[v.lvl]) { v.lvl++; leveled = true; playerXp += (data && data.levelUpPlayerXp) || 5; }
  return { leveled, lvl: v.lvl, playerXp, key: o.key };
}

// A whole trade against an inventory-like object ({ count(id), remove(id, n), add(id, n) -> leftover }): used by
// tests, by co-op's host validation (send the offer's key, never a list position) and by anything that trades without
// the screen. `has` as in offersFor: an offer naming an item the game lacks is refused.
export function tradeFromInventory(v, ref, inv, data, maxStackOf = () => 64, has = null) {
  ensureState(v);
  const o = findOffer(v, data, ref);
  if (!o) return { ok: false, why: 'no offer' };
  if (has && !(has(o.costA) && (!o.costB || has(o.costB)) && has(o.result))) return { ok: false, why: 'unknown item' };
  if (outOfStock(v, o)) return { ok: false, why: 'out of stock' };
  const nA = costA(o, demandOf(v, o), maxStackOf(o.costA));
  if (inv.count(o.costA) < nA || (o.costB && inv.count(o.costB) < o.nB)) return { ok: false, why: 'cannot pay' };
  inv.remove(o.costA, nA);
  if (o.costB) inv.remove(o.costB, o.nB);
  const left = inv.add(o.result, o.nR);
  const r = recordTrade(v, o, data);
  return { ok: true, paid: nA, left, ...r };
}
