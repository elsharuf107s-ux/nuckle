// Co-op wire helpers shared by the host and guest world modules: stable JSON and content keys (what counts as a
// change to a placed block), stack keys for inventory deltas, decode validation, the entity record encoders and the
// death-message templates for damage the host computes for a guest. Loaded only when a room opens.
// Design: multiplayer-design.md 3.8, 6.1, 6.2, 7.3, 9.5.
import { A } from '../assets.js';
import { G } from '../game.js';

// ------------------------------------------------------------ stable JSON and content keys
export function stable(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
// fields that change on their own (timers, smelting progress, light flags set by setBlock): never part of a key
const VOL = new Set(['t', 'burn', 'burnMax', 'cook', 'xp', 'kids', 'walk']);
export function contentKey(b) {
  if (!b) return '';
  const o = {};
  for (const k of Object.keys(b)) {
    if (VOL.has(k) || b[k] === undefined) continue;
    if (k === 'items' && Array.isArray(b.items)) o.items = b.items.map((s) => (s ? { id: s.id } : null));   // a campfire's cooking time is volatile
    else o[k] = b[k];
  }
  return stable(o);
}
// a stack's identity without its count (a tool's wear is part of it), for inventory deltas
export const stackKey = (s) => (s ? stable({ ...s, n: undefined }) : '');
// a whole stack (count included), for container compare-and-set
export const fullKey = (s) => (s ? stable(s) : '');
export const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// ------------------------------------------------------------ validation
const WORLD_ONLY = ['fire', 'soul_fire', 'nether_portal', 'end_portal', 'end_gateway', 'lava', 'farmland', 'dirt_path', 'dirt', 'wheat', 'spawner',
  'bedrock', 'end_portal_frame', 'dragon_egg', 'nether_wart', 'poppy', 'dandelion', 'oak_sapling', 'obsidian', 'cobweb', 'iron_bars', 'chest', 'torch',
  // generated decorations (the world update, 2.7), some without an item yet: a wire block with `gen: true` names one
  'sugar_cane', 'cactus', 'dead_bush', 'pumpkin', 'melon', 'lily_pad'];
let ids = null;
export function blockIds() {
  if (ids) return ids;
  ids = new Set([...Object.keys((A.items && A.items.items) || {}), ...WORLD_ONLY]);
  // whatever the world already holds (the stronghold's and the Nether's own blocks) is a block id too
  if (G.world) for (const b of G.world.blocks.values()) if (b && typeof b.id === 'string') ids.add(b.id);
  return ids;
}
export const isInt = (v) => Number.isInteger(v);
// A cell's block as the players see it (Classic: the blocks map; generated layouts: a generated decoration too), and
// a wire block put into a cell: `gen: true` means "what the generator made here" (world.restoreGen), never a copy
// of the frozen decoration. Classic never has `gen` blocks, so it is setBlock as ever.
export const cellBlock = (W, i) => W.blockAt(i);
export function putBlock(W, x, y, b) {
  if (b && b.gen && W.deco) W.restoreGen(x, y);
  else W.setBlock(x, y, b || null);
}
export const okCell = (i) => isInt(i) && i >= 0 && G.world && i < G.world.W * G.world.H;
export const okTile = (t) => isInt(t) && t >= 0 && G.world && t < G.world.entries.length;
export function okBlock(b) {
  if (b === 0 || b === null) return true;
  if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.id !== 'string') return false;
  if (!blockIds().has(b.id)) return false;
  try { return JSON.stringify(b).length <= 4096; } catch (e) { return false; }
}
// (own keys only: 'constructor', 'toString' or '__proto__' are not items, mobs or species)
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k) && !!o[k];
export const okItem = (id) => typeof id === 'string' && !!A.items && own(A.items.items, id);
export const okKind = (k) => typeof k === 'string' && !!A.items && own(A.items.mobs, k);
export const okSpecies = (s) => typeof s === 'string' && !!A.dex && own(A.dex.species, s);
export const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// ------------------------------------------------------------ death messages (the victim's own name goes in)
const CAUSE = {
  creeper: '%s was blown up by Creeper', tnt: '%s was blown up by TNT', mob: '%s was slain by %a', arrow: '%s was shot by %a',
  fireball: '%s was fireballed by %a', dragon: '%s was slain by Ender Dragon', breath: '%s was killed by Ender Dragon using magic',
  crystal: '%s was blown up by End Crystal', bed: '%s was killed by [Intentional Game Design]', explosion: '%s was blown up',
  fire: '%s burned to death', magma: '%s was slain by Magma Cube', blaze: '%s was slain by Blaze',
};
export function causeText(cause, name) {
  const c = Array.isArray(cause) ? cause : [cause];
  const t = CAUSE[c[0]] || '%s died';
  return t.replace('%s', name || 'Steve').replace('%a', String(c[1] || '').slice(0, 30));
}

// ------------------------------------------------------------ directions
export const DL = ['up', 'down', 'left', 'right'];
export const dirIdx = (d) => Math.max(0, DL.indexOf(d));

// mob flags: what the drawing code and the sounds read, as bits (the guest runs the timers itself)
export const FL = { hurt: 1, dying: 2, fuse: 4, sheared: 8, angry: 16, aim: 32, attack: 64, charge: 128, burst: 256, watch: 512, stare: 1024, scream: 2048, hop: 4096, squash: 8192, burn: 16384, knocked: 32768 };
export function mobFlags(m) {
  let f = 0;
  if (m.hurt > 0) f |= FL.hurt;
  if (m.dying) f |= FL.dying;
  if (m.fuse > 0) f |= FL.fuse;
  if (m.sheared) f |= FL.sheared;
  if (m.angry) f |= FL.angry;
  if (m.aim > 0) f |= FL.aim;
  if (m.attackT > 0) f |= FL.attack;
  if (m.charge > 0) f |= FL.charge;
  if (m.burst > 0) f |= FL.burst;
  if (m.watch) f |= FL.watch;
  if (m.stareT > 0.05) f |= FL.stare;
  if (m.screamT > 0) f |= FL.scream;
  if (m.hop && m.moving) f |= FL.hop;
  if (m.squash > 0) f |= FL.squash;
  if (m.burn > 0.5) f |= FL.burn;
  if (m.knocked) f |= FL.knocked;
  return f;
}
