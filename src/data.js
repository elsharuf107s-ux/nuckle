// Species, moves, the type chart and Gen 3 formulas, all read from the decomp-derived pokemon.json.
import { A } from './assets.js';
import { range, randInt } from './rng.js';

export const SPECIES = () => A.dex.species;
export const MOVES = () => A.dex.moves;
export function species(key) { return A.dex.species[key]; }
export function move(key) { return key === 'STRUGGLE' ? STRUGGLE : A.dex.moves[key]; }
const STRUGGLE = { name: 'STRUGGLE', effect: 'RECOIL', power: 50, type: 'MYSTERY', acc: 0, pp: 1, chance: 0, priority: 0, target: 'SELECTED', contact: true };

// Gen 3 splits physical/special by type.
const PHYSICAL = new Set(['NORMAL', 'FIGHTING', 'FLYING', 'POISON', 'GROUND', 'ROCK', 'BUG', 'GHOST', 'STEEL', 'MYSTERY']);
export const isPhysical = (type) => PHYSICAL.has(type);

// Type effectiveness entries as the battle engine applies them: one integer step per matching row.
export function typeRows(moveType, defTypes) {
  const out = [];
  for (const [a, d, mul, foresight] of A.dex.types) {
    if (foresight) continue;
    if (a === moveType && (d === defTypes[0] || d === defTypes[1])) out.push(mul);
  }
  return out;
}
export function typeMultiplier(moveType, defTypes) {
  let m = 1;
  for (const mul of typeRows(moveType, defTypes)) m *= mul / 10;
  return m;
}

export function expFor(growth, level) { return A.dex.exp[growth][Math.max(1, Math.min(100, level))]; }

export function calcStats(sp, level, ivs) {
  const b = sp.base;
  const st = (i) => Math.floor(((2 * b[i] + ivs[i]) * level) / 100) + 5;
  return {
    maxHp: Math.floor(((2 * b[0] + ivs[0]) * level) / 100) + level + 10,
    atk: st(1), def: st(2), spa: st(3), spd: st(4), spe: st(5),
  };
}

// The last four distinct moves learned by `level` (level-up learnset, supported effects only).
export function movesAt(key, level) {
  const known = [];
  for (const [lv, m] of species(key).learnset) {
    if (lv > level) break;
    const i = known.indexOf(m);
    if (i >= 0) known.splice(i, 1);
    known.push(m);
  }
  return known.slice(-4);
}

let nextUid = 1;
export function makeMon(key, level, opts = {}) {
  const sp = species(key);
  const ivs = opts.ivs || [0, 0, 0, 0, 0, 0].map(() => randInt(32));
  const st = calcStats(sp, level, ivs);
  let moves = opts.moves || movesAt(key, level);
  if (opts.withFly && sp.canFly && !moves.includes('FLY')) moves = [...moves.slice(-3), 'FLY'];
  return {
    uid: nextUid++, species: key, name: sp.name, level, exp: expFor(sp.growth, level), ivs,
    hp: st.maxHp, ...st,
    moves: moves.map((m) => ({ id: m, pp: move(m).pp, maxPp: move(m).pp })),
    status: null, sleep: 0, toxic: 0,
    shiny: !!opts.shiny, ball: opts.ball || 'poke',
  };
}

export function recalc(mon) {
  const sp = species(mon.species);
  const before = mon.maxHp;
  Object.assign(mon, calcStats(sp, mon.level, mon.ivs));
  if (mon.hp > 0) mon.hp = Math.min(mon.maxHp, mon.hp + (mon.maxHp - before));
}

export function healMon(mon) {
  mon.hp = mon.maxHp; mon.status = null; mon.sleep = 0; mon.toxic = 0;
  for (const m of mon.moves) m.pp = m.maxPp;
}

// Restore saved party data (ids and numbers only) into full mon objects.
export function reviveMon(o) {
  if (!o || !species(o.species)) return null;
  const mon = makeMon(o.species, o.level, { ivs: o.ivs, moves: o.moves.map((m) => m.id).filter((id) => move(id)), shiny: o.shiny, ball: o.ball });
  mon.exp = o.exp; mon.hp = Math.max(0, Math.min(mon.maxHp, o.hp)); mon.status = o.status || null; mon.sleep = o.sleep || 0;
  o.moves.forEach((m, i) => { if (mon.moves[i] && mon.moves[i].id === m.id) mon.moves[i].pp = Math.max(0, Math.min(mon.moves[i].maxPp, m.pp)); });
  return mon;
}

export function levelFromRange(lo, hi) { return range(lo, hi); }

export const TYPE_LABEL = (t) => (t === 'MYSTERY' ? '???' : t);
