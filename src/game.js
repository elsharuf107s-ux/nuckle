// Shared game state. Modules import G and call the helpers main.js attaches at boot (G.say, G.giveXp...).
export const TILE = 16;
export const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
export const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
export const DIR_LIST = ['up', 'down', 'left', 'right'];
export function dirTo(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up'); }

export const G = {
  world: null, inv: null, P: null, input: null,
  ents: [], parts: [],
  time: 1000,           // Minecraft day time in ticks: 0 sunrise, 6000 noon, 12000 sunset, 18000 midnight
  day: 0, tick: 0, clock: 0,
  party: [], pc: [], dex: { seen: new Set(), caught: new Set() },
  spawn: null, score: 0, steps: 0, playTime: 0, money: 3000,
  heldName: null, actionBar: null,
  rules: { mobs: true, encounters: true, daylight: true, hunger: true, warps: true, wild: true, nether: true },
};
export const MC_TICK = 1 / 20;
