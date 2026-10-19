// The Kanto signpost on the main thread (minimap design, Track SIGN, 2.4 to 2.7). The worker computes where a Kanto
// World's signs stand and which way they point (src/gen/sign.js kantoSigns, from the world's type and seed alone);
// install() puts them in the world:
//   world.kantoSign     { v, target, signs: [{ x, y, dir, kind: 'spawn' | 'gate', steps | id }], warn } (plane cells)
//   world.kantoTarget   { x, y }: the way into Kanto (the minimap's marker and edge arrow read it)
//   world.chunkPatch    called first in world.applyChunk: a chunk result holding a sign cell comes back as a copy with
//                       the sign's tile (world.signBase + dir) written in, so the grid, the pristine copy (cbase), the
//                       co-op guest's shadow and world.chunkHash all hold it on every page, and a player's edit of that
//                       cell (a blast breaking it) is an ordinary edit applied after it
//   G.signHook          main.js updatePlay asks it once a frame (after a step has ended): facing a sign, A or X reads it
//                       in FireRed's message box, and every A at it is the hook's, so it is never mined by hand (2.7)
// Never throws: install has its own try, the hook answers false on any error.
import { G, DIRS } from './game.js';
import { PLANE } from './layout.js';

export const DIR_WORDS = Object.freeze(['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']);
export const SIGN_FRAMES = 8;

// The sign's message (FireRed's voice, place names in capitals, two lines of FireRed's 212-pixel box). Every line
// stays under 170 font pixels (the widest: "About 1990 steps southwest." 153, "This way to CINNABAR ISLAND." 163): on
// a landscape phone the HTML INV button covers the box's lines from about 176 pixels on.
export function signText(world, s) {
  if (s.kind === 'gate') {
    const o = world.meta && Array.isArray(world.meta.openings) ? world.meta.openings.find((q) => q.id === s.id) : null;
    const m = o && o.map ? (world.maps || []).find((q) => q.id === o.map) : null;
    return m && m.name ? `KANTO starts here.\nThis way to ${m.name}.` : 'KANTO starts here.\nWelcome to KANTO!';
  }
  return `KANTO is this way!\nAbout ${s.steps} steps ${DIR_WORDS[s.dir]}.`;
}

// the sign Steve faces, or null (its tile still a sign entry and no placed block on it)
export function facedSign(world, P) {
  const ks = world && world.kantoSign, d = DIRS[P.dir];
  if (!ks || !ks.signs.length || !d) return null;
  const x = P.tx + d.x, y = P.ty + d.y;
  const s = ks.signs.find((q) => q.x === x && q.y === y);
  if (!s) return null;
  const t = world.tile(x, y);
  if (!(t >= world.signBase && t < world.signBase + SIGN_FRAMES)) return null;
  if (world.block(x, y)) return null;
  return s;
}

function signHook(P, input, queuedA) {
  try {
    const press = input.just('a') || input.just('b') || !!queuedA;
    if (!press && !input.held('a')) return false;
    const s = facedSign(G.world, P);
    if (!s) return false;
    if (press) G.say(signText(G.world, s));
    return true;
  } catch (e) { return false; }
}

export function install(world, sign) {
  try {
    if (!world || !world.layout || world.layout.kind !== 'kanto' || !(world.signBase > 0)) return false;
    if (!sign || sign.v !== 1 || !Array.isArray(sign.signs)) return false;
    const C = PLANE.CHUNK, signs = [];
    for (const s of sign.signs) {
      if (!s || !Number.isInteger(s.x) || !Number.isInteger(s.y) || !Number.isInteger(s.dir) || s.dir < 0 || s.dir >= SIGN_FRAMES) continue;
      if (!world.inside(s.x, s.y) || (s.kind !== 'spawn' && s.kind !== 'gate')) continue;
      signs.push(s.kind === 'spawn' ? { x: s.x, y: s.y, dir: s.dir, kind: 'spawn', steps: Math.max(10, s.steps | 0) } : { x: s.x, y: s.y, dir: s.dir, kind: 'gate', id: s.id | 0 });
    }
    const tg = sign.target && Number.isInteger(sign.target.x) && Number.isInteger(sign.target.y) ? sign.target : null;
    world.kantoSign = { v: 1, target: tg ? { x: tg.x, y: tg.y, kind: tg.kind === 'edge' ? 'edge' : 'opening', id: tg.id | 0 } : null, signs, warn: (sign.warn || []).map(String) };
    world.kantoTarget = tg ? { x: tg.x, y: tg.y } : null;
    // plane data chunk -> its signs
    const byChunk = new Map();
    for (const s of signs) {
      const ck = Math.floor(s.y / C) * PLANE.CW + Math.floor(s.x / C);
      if (!byChunk.has(ck)) byChunk.set(ck, []);
      byChunk.get(ck).push(s);
    }
    const base = world.signBase, ocx = PLANE.OX / C;
    world.chunkPatch = (res) => {
      const list = res && res.tile ? byChunk.get(res.cy * PLANE.CW + res.cx + ocx) : null;
      if (!list) return res;
      const tile = res.tile.slice();
      for (const s of list) tile[(s.y % C) * C + (s.x % C)] = base + s.dir;
      return { ...res, tile };
    };
    G.signHook = signHook;
    return true;
  } catch (e) { return false; }
}
