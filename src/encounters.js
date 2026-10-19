// FireRed's own wild encounters: each map's land, water and fishing tables from
// src/data/wild_encounters.json, the slot percentages, and the step clock from src/wild_encounter.c.
import { A } from './assets.js';
import { rand, range } from './rng.js';

export function tableFor(mapId, kind) {
  const t = A.dex.wild[mapId];
  return t ? t[kind] || null : null;
}
function pickSlot(slots, mons, from = 0, to = slots.length) {
  let total = 0;
  for (let i = from; i < to; i++) total += slots[i];
  let r = rand() * total;
  for (let i = from; i < to; i++) { r -= slots[i]; if (r < 0) return mons[i]; }
  return mons[to - 1];
}
// kind: 'land' | 'water' | 'fishing'; rod for fishing: 'old_rod' | 'good_rod' | 'super_rod'
export function roll(mapId, kind, rod = 'old_rod') {
  const t = tableFor(mapId, kind);
  if (!t) return null;
  let m;
  if (kind === 'fishing') { const g = t.groups[rod]; m = pickSlot(t.slots, t.mons, g[0], g[g.length - 1] + 1); }
  else m = pickSlot(t.slots, t.mons);
  return { species: m[0], level: range(m[1], m[2]) };
}
export function rateFor(mapId, kind) { const t = tableFor(mapId, kind); return t ? t.rate : 0; }

// FireRed's step logic: a cooldown after each encounter during which only 5% of steps may roll, then
// (rate*16 + buff*16/200)/1600 per step, the buff growing by `rate` on every quiet step.
export class EncounterClock {
  constructor() { this.steps = 0; this.buff = 0; this.prev = null; }
  reset() { this.steps = 0; this.buff = 0; }
  step(rate, zoneKey) {
    if (!rate) return false;
    const minSteps = rate >= 80 ? 0 : rate < 10 ? 8 : 8 - Math.floor(rate / 10);
    const changed = this.prev !== null && this.prev !== zoneKey;
    this.prev = zoneKey;
    if (this.steps < minSteps) { this.steps++; if (rand() * 100 >= 5) return false; }
    if (changed && rand() * 100 >= 60) return false;
    const p = Math.min(1600, rate * 16 + Math.floor((this.buff * 16) / 200));
    if (rand() * 1600 < p) { this.reset(); return true; }
    this.buff += rate;
    return false;
  }
}
