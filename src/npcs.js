// FireRed's people in the rooms: the nurse, Mart clerks, Mom and everyone else from each map's object
// events (tools/build_world.py exports them with their text). Only the room Steve is in is populated.
// They stand or wander, block the way, turn to face Steve when he talks, and talk across counters.
import { A } from './assets.js';
import { G, TILE, DIRS, OPP } from './game.js';

export const npcs = [];
let roomId = null;
const WALK = 0.27;                 // FireRed's walking pace, seconds a tile
const COUNTER = 0x80;

// Populate the room Steve is in (outdoors: nobody, FireRed's town people aren't exported).
export function syncNPCs(map) {
  const id = map && map.room ? map.id : null;
  if (id === roomId) return;
  roomId = id;
  npcs.length = 0;
  if (!id) return;
  for (const n of G.world.meta.npcs || []) {
    if (n.map !== id || n.hidden) continue;
    // a block an older save left on someone's spot: they stand on the nearest open cell of the room instead.
    // Only a placed block counts: FireRed's own objects (a POKéDEX on a table, a clipboard) stand on tiles that
    // are solid by design and stay where they are.
    const at = G.world.block(n.x, n.y) && G.world.solid(n.x, n.y) ? openNear(n.x, n.y, map) : { x: n.x, y: n.y };
    npcs.push({ ...n, tx: at.x, ty: at.y, fx: at.x, fy: at.y, fromX: at.x, fromY: at.y, dir: n.face || 'down', moving: false, prog: 0,
      think: 1 + Math.random() * 3, home: { x: at.x, y: at.y }, pose: null });
  }
}
function openNear(x0, y0, map) {
  const W = G.world;
  for (let r = 1; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const x = x0 + dx, y = y0 + dy;
    if (W.mapAt(x, y) !== map || W.solid(x, y) || W.isWater(x, y) || W.warpAt(x, y) || W.behaviorAt(x, y) === COUNTER || W.block(x, y) || npcAt(x, y)) continue;
    return { x, y };
  }
  return { x: x0, y: y0 };
}
// A person's own spot in a room (where syncNPCs stands them): no block goes there.
let homes = null, homesOf = null;
export function npcHome(x, y) {
  if (!homes || homesOf !== G.world) { homes = new Set(); homesOf = G.world; for (const n of G.world.meta.npcs || []) if (!n.hidden) homes.add(n.y * 4096 + n.x); }
  return homes.has(y * 4096 + x);
}
export const npcAt = (x, y) => npcs.find((n) => (n.tx === x && n.ty === y) || (n.moving && n.fromX === x && n.fromY === y)) || null;

// The person Steve is talking to: right in front, or across a counter.
export function npcFacing(P) {
  const d = DIRS[P.dir], x = P.tx + d.x, y = P.ty + d.y;
  const n = npcAt(x, y);
  if (n) return n;
  if (G.world.behaviorAt(x, y) === COUNTER) return npcAt(x + d.x, y + d.y);
  return null;
}
export function facePlayer(n, P) { n.dir = OPP[P.dir]; n.moving = false; n.fx = n.tx; n.fy = n.ty; }

function canWalk(n, x, y) {
  const W = G.world, P = G.P;
  if (Math.abs(x - n.home.x) > (n.range ? n.range[0] : 1) || Math.abs(y - n.home.y) > (n.range ? n.range[1] : 1)) return false;
  if (W.solid(x, y) || W.isWater(x, y) || W.warpAt(x, y) || W.behaviorAt(x, y) === COUNTER || W.block(x, y)) return false;
  if ((P.tx === x && P.ty === y) || (P.moving && P.fromX === x && P.fromY === y)) return false;
  const f = G.follower;
  if (f && f.visible && f.tx === x && f.ty === y) return false;
  if (npcAt(x, y)) return false;
  return !G.ents.some((e) => (e.type === 'mob' || e.type === 'wild') && e.tx === x && e.ty === y);
}

export function updateNPCs(dt, busy) {
  for (const n of npcs) {
    if (n.moving) {
      n.prog += dt / WALK;
      if (n.prog >= 1) { n.moving = false; n.prog = 0; n.fx = n.tx; n.fy = n.ty; }
      else { n.fx = n.fromX + (n.tx - n.fromX) * n.prog; n.fy = n.fromY + (n.ty - n.fromY) * n.prog; }
      continue;
    }
    if (busy || n.move !== 'wander') continue;
    n.think -= dt;
    if (n.think > 0) continue;
    n.think = 1.5 + Math.random() * 3;
    const dir = ['up', 'down', 'left', 'right'][Math.floor(Math.random() * 4)];
    n.dir = dir;
    const x = n.tx + DIRS[dir].x, y = n.ty + DIRS[dir].y;
    if (Math.random() < 0.6 && canWalk(n, x, y)) { n.fromX = n.tx; n.fromY = n.ty; n.tx = x; n.ty = y; n.moving = true; n.prog = 0; }
  }
}

// Frame order on FireRed's sheets: 0 S, 1 N, 2 W standing; 3/4 S, 5/6 N, 7/8 W walking; east is west
// mirrored. Three-frame sheets only stand; the nurse's fourth frame is her bow.
function frameOf(n, info) {
  if (n.pose === 'bow') return 3;
  const stand = { down: 0, up: 1, left: 2, right: 2 }[n.dir];
  if (!n.moving || info.n < 9) return stand;
  const step = n.prog < 0.5 ? 0 : 1;
  return { down: 3, up: 5, left: 7, right: 7 }[n.dir] + step;
}
export function npcSprites(cam, list) {
  for (const n of npcs) {
    const img = A.npc[n.gfx], info = (A.world.npcSheets || {})[n.gfx];
    if (!img || !info) continue;
    list.push({ y: n.fy + 0.01, fn: (ctx) => {
      const f = Math.min(frameOf(n, info), info.n - 1);
      const x = Math.round(n.fx * TILE + 8 - info.w / 2 - cam.x), y = Math.round(n.fy * TILE + 16 - info.h - cam.y);
      if (n.dir === 'right') {
        ctx.save(); ctx.translate(x + info.w, y); ctx.scale(-1, 1);
        ctx.drawImage(img, f * info.w, 0, info.w, info.h, 0, 0, info.w, info.h);
        ctx.restore();
      } else ctx.drawImage(img, f * info.w, 0, info.w, info.h, x, y, info.w, info.h);
    } });
  }
}
