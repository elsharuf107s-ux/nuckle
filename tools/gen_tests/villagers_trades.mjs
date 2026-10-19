#!/usr/bin/env node
// The trade logic (src/trades.js) against the built tables (assets/mc/villagers/trades.json), in Node, no browser:
//   node tools/gen_tests/villagers_trades.mjs
// offers per level and their determinism, Minecraft's level thresholds, a trade with every profession's first offer,
// level-ups, the daily restock, demand pricing after a sold-out day, out of stock, the two-cost offers, and the
// "no path around the Nether" rule over every villager id 0..4095.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../../src/trades.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const data = JSON.parse(readFileSync(path.join(ROOT, 'assets/mc/villagers/trades.json'), 'utf8'));
const meta = JSON.parse(readFileSync(path.join(ROOT, 'assets/mc/villagers/villagers.json'), 'utf8'));
const fails = [];
let checks = 0;
const check = (c, msg) => { checks++; if (!c) { fails.push(msg); console.error('FAIL', msg); } };

// a tiny inventory with the game's Inventory interface (count, remove, add -> leftover)
class Inv {
  constructor(o = {}) { this.c = { ...o }; }
  count(id) { return this.c[id] || 0; }
  remove(id, n) { if (this.count(id) < n) return false; this.c[id] -= n; return true; }
  add(id, n) { this.c[id] = this.count(id) + n; return 0; }
}
const profs = meta.professions.filter((p) => !T.NO_TRADES.has(p));

// ---- offers: 2 per level (or the whole pool when smaller), deterministic, distinct, growing only at the end
for (const prof of profs) {
  for (let vid = 0; vid < 64; vid++) {
    let prev = [];
    for (let lvl = 1; lvl <= 5; lvl++) {
      const v = { vid, prof, lvl };
      const a = T.offersFor(v, data), b = T.offersFor({ ...v }, data);
      check(JSON.stringify(a) === JSON.stringify(b), `${prof} vid ${vid} L${lvl}: offers differ between two calls`);
      const pool = data.trades[prof][String(lvl)].length;
      check(a.length === prev.length + Math.min(2, pool), `${prof} vid ${vid} L${lvl}: ${a.length} offers, expected ${prev.length + Math.min(2, pool)}`);
      check(JSON.stringify(a.slice(0, prev.length)) === JSON.stringify(prev), `${prof} vid ${vid} L${lvl}: earlier offers changed on a level-up`);
      const mine = a.filter((o) => o.lvl === lvl).map((o) => o.slot);
      check(new Set(mine).size === mine.length, `${prof} vid ${vid} L${lvl}: an offer twice`);
      prev = a;
    }
  }
}
// the toolsmith's 3-offer Novice pool: every pair shows up across villagers
{
  const seen = new Set();
  for (let vid = 0; vid < 200; vid++) seen.add(T.offersFor({ vid, prof: 'toolsmith', lvl: 1 }, data).map((o) => o.slot).join(','));
  check(seen.size === 3, `toolsmith Novice: ${seen.size} of the 3 possible pairs across 200 villagers (${[...seen].join(' | ')})`);
}
check(T.offersFor({ vid: 1, prof: 'nitwit', lvl: 5 }, data).length === 0 && T.offersFor({ vid: 1, prof: 'none', lvl: 1 }, data).length === 0, 'nitwits and the unemployed have no offers');

// ---- levels: Minecraft's thresholds
for (const [xp, l] of [[0, 1], [9, 1], [10, 2], [69, 2], [70, 3], [149, 3], [150, 4], [249, 4], [250, 5], [9999, 5]]) check(T.levelForXp(xp, data) === l, `xp ${xp} is level ${T.levelForXp(xp, data)}, expected ${l}`);
check(T.levelName(1, data) === 'Novice' && T.levelName(5, data) === 'Master', 'level names');

// ---- a trade with each profession's first offer, from an inventory that can pay
for (const prof of profs) {
  const v = T.ensureState({ vid: 3, prof, lvl: 1 });
  const o = T.offersFor(v, data)[0];
  const inv = new Inv({ [o.costA]: 64, ...(o.costB ? { [o.costB]: 64 } : {}) });
  const before = inv.count(o.result);
  const r = T.tradeFromInventory(v, 0, inv, data);
  check(r.ok && r.key === o.key && inv.count(o.result) === before + o.nR - (o.result === o.costA ? o.nA : 0) && v.uses[o.key] === 1 && v.xp === o.xp,
    `${prof}: first offer trade (${o.nA} ${o.costA} -> ${o.nR} ${o.result}): ${JSON.stringify(r)} uses ${JSON.stringify(v.uses)} xp ${v.xp}`);
}
// cannot pay
{
  const v = T.ensureState({ vid: 3, prof: 'farmer', lvl: 1 });
  const r = T.tradeFromInventory(v, 0, new Inv({ wheat: 19 }), data);
  check(!r.ok && r.why === 'cannot pay' && Object.keys(v.uses).length === 0, `19 wheat must not buy an emerald: ${JSON.stringify(r)}`);
}

// ---- level up after enough trades (farmer: wheat for emeralds, 2 xp each: Apprentice after 5 trades)
{
  const v = T.ensureState({ vid: 11, prof: 'farmer', lvl: 1 });
  const inv = new Inv({ wheat: 9999 });
  const i = T.offersFor(v, data).findIndex((o) => o.costA === 'wheat');
  let n = 0, leveled = null;
  while (v.lvl === 1 && n < 20) { const r = T.tradeFromInventory(v, i, inv, data); n++; if (r.leveled) leveled = n; }
  check(leveled === 5 && v.lvl === 2 && T.offersFor(v, data).length === 4, `farmer reached Apprentice after ${leveled} trades (expected 5), lvl ${v.lvl}, ${T.offersFor(v, data).length} offers`);
  check(T.xpProgress(v, data).cur === 0, `xp bar starts empty at Apprentice: ${JSON.stringify(T.xpProgress(v, data))}`);
  v.xp = 250; v.lvl = 5;
  check(T.xpProgress(v, data) === null, 'no experience bar at Master');
}

// ---- out of stock, restock once a day, demand pricing after a sold-out day
{
  const v = T.ensureState({ vid: 5, prof: 'farmer', lvl: 1 });
  const offers = T.offersFor(v, data);
  const i = offers.findIndex((o) => o.costA === 'wheat');
  const o = offers[i];
  const inv = new Inv({ wheat: 99999 });
  for (let k = 0; k < o.maxUses; k++) T.tradeFromInventory(v, i, inv, data);
  check(T.outOfStock(v, o) && v.uses['1:buy_wheat'] === o.maxUses, `wheat offer out of stock after ${o.maxUses} trades (uses ${JSON.stringify(v.uses)})`);
  const r = T.tradeFromInventory(v, i, inv, data);
  check(!r.ok && r.why === 'out of stock', `a 17th trade is refused: ${JSON.stringify(r)}`);
  T.restock(v, data);
  // demand = max(0, 0 + 16 - (16 - 16)) = 16; price = 20 + floor(20 * 16 * 0.05) = 36
  check(T.usesOf(v, o) === 0 && T.demandOf(v, o) === 16, `restock: uses ${T.usesOf(v, o)}, demand ${T.demandOf(v, o)} (expected 0 and 16)`);
  check(T.costA(o, T.demandOf(v, o)) === 36, `after a sold-out day 20 wheat costs ${T.costA(o, T.demandOf(v, o))} (expected 36)`);
  const before = inv.count('wheat');
  T.tradeFromInventory(v, i, inv, data);
  check(before - inv.count('wheat') === 36, `the raised price is what is paid: ${before - inv.count('wheat')}`);
  // a quiet day brings demand down: uses 1 of 16 -> demand 16 + 1 - 15 = 2; then a day with no trades: max(0, 2 - 16) = 0
  T.restock(v, data);
  check(T.demandOf(v, o) === 2, `after a day with one trade demand is ${T.demandOf(v, o)} (expected 2)`);
  T.restock(v, data);
  check(T.demandOf(v, o) === 0 && T.costA(o, 0) === 20, `after an idle day demand is ${T.demandOf(v, o)} and the price back to 20`);
  // a food sale (0.2): bread 1 emerald, demand 10 -> 1 + floor(1 * 10 * 0.2) = 3; clamped to a stack of 64
  const bread = offers.find((x) => x.result === 'bread');
  check(bread && T.costA(bread, 10) === 3 && T.costA(bread, 100000) === 64, `bread price under demand: ${bread && T.costA(bread, 10)}, ${bread && T.costA(bread, 100000)}`);
}

// ---- two-cost offers (the fisherman's cooking) and payment matching
{
  const v = T.ensureState({ vid: 2, prof: 'fisherman', lvl: 2 });
  const offers = T.offersFor(v, data);
  const i = offers.findIndex((o) => o.costB === 'cod');
  check(i >= 0, 'the fisherman has its emerald + cod offer at Apprentice');
  const o = offers[i];
  check(T.satisfies(o, { id: 'emerald', n: 1 }, { id: 'cod', n: 6 }, 0) && !T.satisfies(o, { id: 'emerald', n: 1 }, { id: 'cod', n: 5 }, 0) && !T.satisfies(o, { id: 'emerald', n: 1 }, null, 0),
    'emerald + 6 cod pays, 5 cod or no cod does not');
  const w = offers.findIndex((x) => x.costA === 'string');
  check(T.matchOffer(v, offers, { id: 'string', n: 20 }, null, null) === w, 'matchOffer finds the string offer from the payment alone');
  check(T.matchOffer(v, offers, { id: 'string', n: 20 }, { id: 'cod', n: 1 }, null) === -1, 'a one-cost offer needs the second slot empty');
  const inv = new Inv({ emerald: 3, cod: 12 });
  const r = T.tradeFromInventory(v, i, inv, data);
  check(r.ok && inv.count('cooked_cod') === 6 && inv.count('cod') === 6 && inv.count('emerald') === 2, `emerald + 6 cod -> 6 cooked cod: ${JSON.stringify(inv.c)}`);
}

// ---- no path around the Nether, for every villager id: no eyes or blaze items, pearls only from the Master cleric
{
  let pearls = 0, bad = 0;
  for (const prof of profs) for (let vid = 0; vid < 4096; vid += 1) {
    for (const o of T.offersFor({ vid, prof, lvl: 5 }, data)) {
      if (data.neverSold.includes(o.result)) bad++;
      if (o.result === 'ender_pearl') { pearls++; if (!(prof === 'cleric' && o.lvl === 5)) bad++; }
    }
  }
  check(bad === 0 && pearls > 0, `Nether rule over ${profs.length} professions x 4096 villagers: ${bad} bad offers, ${pearls} Master clerics sell pearls`);
}
// ---- the hash is the generator's (co-op: every client picks the same offers), with golden values
{
  const G = await import('../../src/gen/hash.js');
  check(T.hash32 === G.hash32 && T.TRADE_SALT === G.fnv1a('villager.trades'), 'trades use src/gen/hash.js hash32 and fnv1a');
  const gold = [[7, 'toolsmith', 1], [8, 'toolsmith', 1], [9, 'toolsmith', 1], [7, 'farmer', 5], [100, 'cleric', 5], [4095, 'mason', 5]].map(([vid, prof, lvl]) => T.offersFor({ vid, prof, lvl }, data).map((o) => o.key).join(' '));
  const GOLD = ['1:buy_coal 1:sell_stone_pickaxe', '1:buy_coal 1:sell_stone_pickaxe', '1:buy_coal 1:sell_stone_axe', '1:buy_wheat 1:sell_bread 2:buy_pumpkin 2:sell_apple 3:buy_melon 3:sell_cooked_chicken 4:sell_sugar 4:sell_hay_block 5:sell_golden_apple', '1:buy_rotten_flesh 1:sell_redstone 2:buy_gold_ingot 2:sell_potion 3:sell_lapis_lazuli 3:sell_super_potion 4:sell_revive 5:sell_ender_pearl 5:sell_full_heal', '1:buy_clay_ball 1:sell_brick 2:buy_stone 2:sell_chiseled_stone_bricks 3:buy_cobblestone 3:sell_stone_bricks 4:buy_sandstone 5:sell_clay'];
  check(JSON.stringify(gold) === JSON.stringify(GOLD), `golden picks ${JSON.stringify(gold)}`);
}

// ---- stable keys: retuning the table never remaps a villager's offers or its saved counts
{
  const clone = () => JSON.parse(JSON.stringify(data));
  let reorderSame = 0, removeSame = 0, addMoved = 0, addOk = 0, total = 0;
  for (const prof of profs) for (let lvl = 1; lvl <= 5; lvl++) for (let vid = 0; vid < 256; vid++) {
    const v = { vid, prof, lvl };
    const keys = (d) => T.offersFor(v, d).map((o) => o.key).sort().join(' ');
    const base = keys(data);
    total++;
    // reorder every pool of this profession: the same offers
    const r = clone(); for (const l of Object.keys(r.trades[prof])) r.trades[prof][l].reverse();
    if (keys(r) === base) reorderSame++;
    // remove an offer this villager does not have: the same offers
    const pool = data.trades[prof][String(lvl)];
    const mine = new Set(T.offersFor(v, data).filter((o) => o.lvl === lvl).map((o) => o.slot));
    const drop = pool.findIndex((_, i) => !mine.has(i));
    if (drop >= 0) { const d = clone(); d.trades[prof][String(lvl)].splice(drop, 1); if (keys(d) === base) removeSame++; } else removeSame++;
    // add an offer: the villager keeps all its offers, or swaps exactly one of this level's for the new one
    const a = clone(); a.trades[prof][String(lvl)].push(['emerald', 1, null, 0, 'torch', 4, 12, 1, 0.05, 'sell_new_torch']);
    const before = new Set(base.split(' ')), after = new Set(keys(a).split(' '));
    const lost = [...before].filter((k) => !after.has(k)), gained = [...after].filter((k) => !before.has(k));
    if (lost.length === 0 && (gained.length === 0 || (pool.length < 2 && gained.length === 1))) addOk++;
    else if (lost.length === 1 && gained.length === 1 && gained[0] === `${lvl}:sell_new_torch` && lost[0].startsWith(`${lvl}:`)) { addOk++; addMoved++; }
  }
  check(reorderSame === total, `reordering every pool keeps every villager's offers (${reorderSame}/${total})`);
  check(removeSame === total, `removing an offer a villager lacks keeps its offers (${removeSame}/${total})`);
  check(addOk === total && addMoved > 0 && addMoved < total, `adding an offer changes at most one offer of that level (${addOk}/${total}, ${addMoved} took the new one)`);
  // saved counts follow the offer, not a position: uses kept under a key survive a reordered table
  const v = T.ensureState({ vid: 5, prof: 'farmer', lvl: 1 });
  const inv = new Inv({ wheat: 999 });
  for (let k = 0; k < 3; k++) T.tradeFromInventory(v, '1:buy_wheat', inv, data);
  const r = clone(); r.trades.farmer['1'].reverse();
  const o = T.offersFor(v, r).find((x) => x.costA === 'wheat');
  check(T.usesOf(v, o) === 3 && T.offersFor(v, r)[0].key === '1:sell_bread', `uses stay on the wheat offer after a reorder (${T.usesOf(v, o)})`);
  // an early array state is dropped, not reinterpreted; restock drops counts of offers the villager no longer has
  const old = T.ensureState({ vid: 5, prof: 'farmer', lvl: 1, uses: [16, 3], demand: [4] });
  check(!Array.isArray(old.uses) && Object.keys(old.uses).length === 0 && Object.keys(old.demand).length === 0, 'array uses and demand are dropped');
  const w = T.ensureState({ vid: 5, prof: 'farmer', lvl: 1, uses: { '1:buy_wheat': 16, '1:gone': 9 }, demand: { '1:gone': 5 } });
  T.restock(w, data);
  check(!('1:gone' in w.uses) && !('1:gone' in w.demand) && w.demand['1:buy_wheat'] === 16, `restock keeps only current offers (${JSON.stringify(w)})`);
  check(T.tradeFromInventory(w, 0, new Inv({ wheat: 99 }), data).key === '1:buy_wheat' && T.findOffer(w, data, 'nope') === null, 'refs by index and by key; unknown keys find nothing');
}

// ---- unknown items: offersFor(has) hides them, tradeFromInventory(has) refuses them; the pick does not move
{
  const items = JSON.parse(readFileSync(path.join(ROOT, 'assets/mc/items.json'), 'utf8')).items;
  const has = (id) => !!items[id];
  let hidden = 0, shownBad = 0, moved = 0;
  for (const prof of profs) for (let vid = 0; vid < 256; vid++) {
    const v = { vid, prof, lvl: 5 };
    const all = T.offersFor(v, data), shown = T.offersFor(v, data, has);
    hidden += all.length - shown.length;
    for (const o of shown) if (!has(o.costA) || (o.costB && !has(o.costB)) || !has(o.result)) shownBad++;
    if (shown.some((o) => !all.find((x) => x.key === o.key))) moved++;
  }
  check(hidden > 0 && shownBad === 0 && moved === 0, `has() hides ${hidden} offers naming unknown items, shows none (${shownBad}), moves none (${moved})`);
  // (7c: stage 5a made bricks an item; leather armor is still missing)
  const v = T.ensureState({ vid: 0, prof: 'leatherworker', lvl: 1 });
  const r = T.tradeFromInventory(v, '1:sell_leather_leggings', new Inv({ emerald: 5 }), data, () => 64, has);
  check(!r.ok && r.why === 'unknown item' && Object.keys(v.uses).length === 0, `leather leggings (not in items.json yet) are refused: ${JSON.stringify(r)}`);
}

console.log(`villagers_trades: ${checks} checks, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
