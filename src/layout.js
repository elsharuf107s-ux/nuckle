// World layouts (the world update's design, sections 2.1 to 2.3): the grid a world is built on, where its
// overworld lies, and the world.json data (maps, warps, towns, people, lava, the Nether, the stronghold, The End)
// the World instance reads as `world.meta`.
//
// Three kinds share one engine. `classic` is today's 408 x 1062 grid with Kanto at (0, 0): every save from before
// the world update, built exactly as before (its meta IS A.world, nothing is copied). `kanto` and `wild` are the
// generated 2016 x 1600 plane: the room band keeps its own coordinates in the west strip and the overworld fills
// x 416..2015. Every new behaviour is gated on `layout.gen`, so Classic runs today's code paths.
import { A } from './assets.js';

// the generated plane (2.2, 2.4): 63 x 50 data chunks of 32 x 32 cells
export const PLANE = Object.freeze({ W: 2016, H: 1600, OX: 416, OY: 0, OW: 1600, OH: 1600, CHUNK: 32, CW: 63, CHH: 50, BORDER: 8 });
export const KINDS = Object.freeze(['classic', 'kanto', 'wild']);

// The layout descriptor for a world descriptor ({ kind, ... }). Pure data, frozen.
//   { kind, gen, W, H, ox, oy, ow, oh, border: { x0, y0, x1, y1 } (inclusive, the playable area),
//     kanto: { x, y } | null (where Kanto's outdoor block's (0, 0) lies), band: { x0, y0, x1, y1 } | null }
// `band` is the room band of a generated plane (Kanto's rooms, the Nether, the stronghold, The End), copied from
// Classic's grid at the same x, y (2.2); Classic has none, its rooms are simply part of its grid.
export function makeLayout(desc = {}) {
  const kind = desc.kind || 'classic';
  if (kind === 'classic') {
    const W = A.world.w, H = A.world.h, o = A.world.outdoor || { w: W, h: H };
    return Object.freeze({
      kind, gen: false, W, H, ox: 0, oy: 0, ow: o.w, oh: o.h,
      border: Object.freeze({ x0: 0, y0: 0, x1: o.w - 1, y1: o.h - 1 }),
      kanto: Object.freeze({ x: 0, y: 0 }), band: null,
    });
  }
  if (kind === 'kanto' || kind === 'wild') {
    const P = PLANE, o = A.world.outdoor || { w: A.world.w, h: A.world.h }, b = P.BORDER;
    // Kanto's block sits at (416 + kx, ky) on the island's south-west coast; kx and ky come from the plan (3.12)
    const kanto = kind === 'kanto' ? Object.freeze({ x: P.OX + (desc.kx ?? 64), y: P.OY + (desc.ky ?? 1024) }) : null;
    return Object.freeze({
      kind, gen: true, W: P.W, H: P.H, ox: P.OX, oy: P.OY, ow: P.OW, oh: P.OH,
      border: Object.freeze({ x0: P.OX + b, y0: P.OY + b, x1: P.OX + P.OW - 1 - b, y1: P.OY + P.OH - 1 - b }),
      kanto, band: Object.freeze({ x0: 0, y0: o.h, x1: A.world.w - 1, y1: A.world.h - 1 }),
      meta: desc.meta || null,
    });
  }
  throw new Error('unknown world type ' + kind);
}

// The world.json data a World of this layout reads (`world.meta`). Classic: A.world itself (identity, so every
// object and list is the same one as before the update). Generated layouts get a relocated (Kanto World) or
// disabled (Wild World) deep copy, built with the plan (3.12, 3.13); until that exists they cannot be built.
export function metaFor(layout) {
  if (!layout.gen) return A.world;
  if (layout.meta) return layout.meta;
  throw new Error('generated worlds are not built yet (' + layout.kind + ')');
}

// A Wild World's meta (2.3, 3.11 steps 9 and 10; stage 4a): a deep copy of the world.json data with Kanto's outdoor
// part switched off, plus the plan's maps. Kanto's 37 outdoor maps stay in the list (their indices never move) with
// `off: true`; its towns are dropped; every warp whose source or arrival lies on Kanto's outdoor block (an integer
// y or ay under 400) is kept in place with `off: true` and is not indexed; dead warps keep their null arrivals. The
// room band (Kanto's rooms, the Nether, the stronghold, The End) keeps its coordinates. The stronghold's entrance is
// stage 6c's (null until then). The caves' warps are appended (5b: World.initRooms digs their rooms); the house doors
// wait for their interiors (7a), so a door never leads into the void.
export function wildMeta(plan) {
  const W0 = A.world, clone = (v) => JSON.parse(JSON.stringify(v));
  const out = (y) => Number.isInteger(y) && y < (W0.outdoor ? W0.outdoor.h : 400);
  const maps = W0.maps.map((m) => (m.kind === 'outdoor' && !m.room ? { ...m, off: true } : { ...m }));
  for (const m of plan.maps) maps.push({ ...m });
  const warps = W0.warps.map((w) => (out(w.y) || out(w.ay) ? { ...w, off: true } : { ...w }));
  // the caves' warps (5b): mouths, exits and ladders come first in the plan's list, so they keep their indices
  // (warpBase + k); the house doors and mats wait for their interiors (7a)
  if (warps.length === plan.warpBase) {
    for (const w of plan.warps) { if (!/^GEN_(CAVE|HOUSE)_/.test(w.map) && !/^GEN_(CAVE|HOUSE)_/.test(w.dest)) break; warps.push({ ...w }); }   // (7a: house doors and mats too)
  }
  // (6c, 3.13) the stronghold's entrance is the plan's: the entrance warp's source and the three stair warps' arrival
  // move to it in this copy (A.world is never changed), so warpIdx, noPlaceCells and w.i (World constructor) come from
  // the rewired list and Route 23's old cell is neither blocked nor a warp. Without a planned entrance it stays null.
  const stronghold = W0.stronghold ? { ...clone(W0.stronghold), entrance: null } : null;
  const sh = plan.stronghold;
  if (stronghold && sh && Array.isArray(W0.stronghold.warps)) {
    const ent = { x: sh.px, y: sh.py }, [first, last] = W0.stronghold.warps, smap = (W0.maps[W0.stronghold.map] || {}).id;
    stronghold.entrance = ent;
    stronghold.rung = sh.rung;
    for (let i = first; i <= last && i < warps.length; i++) {
      const w = warps[i];
      if (w.map !== smap && w.dest === smap) { w.x = ent.x; w.y = ent.y; delete w.off; }
      else if (w.map === smap) { w.ax = ent.x; w.ay = ent.y; delete w.off; }
    }
  }
  return { ...W0, maps, warps, towns: [], stronghold, nether: W0.nether, end: W0.end, npcs: W0.npcs, lava: W0.lava.slice(), planWarps: plan.warps,
    genCaves: plan.caves, genRooms: plan.rooms.filter((r) => r.kind === 'cave'), genVillages: plan.villages, genHouses: plan.rooms.filter((r) => r.kind === 'house') };
}

// A Kanto World's meta (2.3, 3.12; stage 6a): a deep copy of the world.json data with everything on Kanto's outdoor
// block moved to where the plan put the block (T(x, y) = (x + 416 + kx, y + ky) for y < 400), plus the plan's maps and
// the caves' warps as in a Wild World. Moved: the 37 outdoor maps' rectangles, the 11 towns (x, y and land), every warp
// source with an integer y under 400 (145) and every arrival with an integer ay under 400 (300), and the stronghold's
// entrance (Route 23's cell). The 37 dead warps (ax, ay, to and adir all null: their rooms are not in world.json) keep
// their nulls: the test is Number.isInteger, since `null < 400` is true in JS. The room band (rooms, the Nether, the
// stronghold, The End, people, lava) keeps its coordinates. A.world itself is never changed.
export function kantoMeta(plan) {
  const W0 = A.world, H0 = W0.outdoor ? W0.outdoor.h : 400;
  const clone = typeof structuredClone === 'function' ? structuredClone : (v) => JSON.parse(JSON.stringify(v));
  const dx = PLANE.OX + plan.kanto.x, dy = PLANE.OY + plan.kanto.y;
  const out = (y) => Number.isInteger(y) && y < H0;
  const maps = W0.maps.map((m) => {
    const c = clone(m);
    if (m.kind === 'outdoor' && !m.room && out(m.y)) { c.x = m.x + dx; c.y = m.y + dy; }
    return c;
  });
  for (const m of plan.maps) maps.push({ ...m });
  const towns = W0.towns.map((t) => {
    const c = clone(t);
    if (out(t.y)) { c.x = t.x + dx; c.y = t.y + dy; }
    if (t.land && out(t.land.y)) c.land = { ...t.land, x: t.land.x + dx, y: t.land.y + dy };
    return c;
  });
  const moved = { src: 0, arr: 0 };
  const warps = W0.warps.map((w) => {
    const c = clone(w);
    if (out(w.y)) { c.x = w.x + dx; c.y = w.y + dy; moved.src++; }
    if (out(w.ay)) { c.ax = w.ax + dx; c.ay = w.ay + dy; moved.arr++; }
    return c;
  });
  if (warps.length === plan.warpBase) {
    for (const w of plan.warps) { if (!/^GEN_(CAVE|HOUSE)_/.test(w.map) && !/^GEN_(CAVE|HOUSE)_/.test(w.dest)) break; warps.push({ ...w }); }   // (7a: house doors and mats too)
  }
  const stronghold = W0.stronghold ? clone(W0.stronghold) : null;
  if (stronghold && stronghold.entrance && out(stronghold.entrance.y)) stronghold.entrance = { ...stronghold.entrance, x: stronghold.entrance.x + dx, y: stronghold.entrance.y + dy };
  // (6b) the kept openings in plane cells, each with the Kanto map its cut reaches (wild.js levelFor blends toward
  // that map's levels near its out cell) and the box of Kanto cells it re-tiles (world.js: those chunks are generated)
  const ox = PLANE.OX, oy = PLANE.OY, kx = plan.kanto.x, ky = plan.kanto.y;
  const openings = (plan.openings || []).map((o) => {
    const lx = o.in[0] - kx, ly = o.in[1] - ky;
    const m = W0.maps.find((mm) => mm.kind === 'outdoor' && !mm.room && lx >= mm.x && ly >= mm.y && lx < mm.x + mm.w && ly < mm.y + mm.h);
    return { id: o.id, kind: o.kind, n: o.n.slice(), out: [ox + o.out[0], oy + o.out[1]], in: [ox + o.in[0], oy + o.in[1]], map: m ? m.id : null,
      box: [ox + o.box[0], oy + o.box[1], ox + o.box[2], oy + o.box[3]] };
  });
  return { ...W0, maps, warps, towns, stronghold, nether: W0.nether, end: W0.end, npcs: W0.npcs, lava: W0.lava.slice(), planWarps: plan.warps,
    genCaves: plan.caves, genRooms: plan.rooms.filter((r) => r.kind === 'cave'), genVillages: plan.villages, genHouses: plan.rooms.filter((r) => r.kind === 'house'), kantoAt: { x: dx, y: dy }, relocated: moved,
    openings };
}
