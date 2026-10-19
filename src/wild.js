// Wild POKéMON you can see: drawn from each place's own FireRed table, wandering the grass, caves and
// water. Some keep to themselves, some run when Steve comes close, some spot him and give chase, and some
// lie in wait (a GEODUDE that looks like a rock, a VOLTORB passing for an item ball, a DIGLETT under the
// ground) until he is right next to them. Touching one, or pressing Z at it, starts the battle.
// Spawning uses Math.random, never the seeded battle RNG, and G.rules.wild switches it all off.
import { A } from './assets.js';
import { G, TILE, DIRS, DIR_LIST, dirTo } from './game.js';
import { NET } from './net/flag.js';   // co-op: false in single-player

// (the world update's species, which only generated worlds have, join the sets at the end of each line)
const AGGRESSIVE = new Set(['SPEAROW', 'FEAROW', 'MANKEY', 'PRIMEAPE', 'EKANS', 'ARBOK', 'ZUBAT', 'GOLBAT', 'MACHOP', 'MACHOKE', 'TENTACOOL',
  'TENTACRUEL', 'GYARADOS', 'NIDORAN_M', 'NIDORINO', 'GROWLITHE', 'GRIMER', 'KOFFING', 'ONIX', 'GRAVELER', 'MAROWAK', 'HAUNTER', 'GASTLY',
  'TAUROS', 'RHYHORN', 'SCYTHER', 'PINSIR']);
const SKITTISH = new Set(['PIDGEY', 'PIDGEOTTO', 'RATTATA', 'NIDORAN_F', 'DODUO', 'ABRA', 'CLEFAIRY', 'DITTO', 'MAGIKARP', 'GOLDEEN', 'HORSEA',
  'POLIWAG', 'PSYDUCK', 'CUBONE', 'PONYTA', 'PARAS', 'VENONAT', 'MEOWTH', 'JIGGLYPUFF', 'SANDSHREW']);
const DISGUISE = { GEODUDE: 'rock', VOLTORB: 'ball', ELECTRODE: 'ball', DIGLETT: 'hidden', DUGTRIO: 'hidden' };
const CAP = 6;                    // around Steve at once
// the Nether's table (world MAP_NETHER) also names who keeps to the lava (SLUGMA, MAGCARGO) and who hunts in
// packs (HOUNDOUR, HOUNDOOM: aggressive, spotting Steve from further off and coming on together)
const tableOf = (mapId) => (A.dex.wild && A.dex.wild[mapId] && A.dex.wild[mapId].land) || null;
// a map's wild table id: a generated biome or cave map names its table (`wild`, 3.15), Kanto's maps are their own
export const wildId = (map) => (map ? map.wild || map.id : null);
const lavaNear = (x, y, r = 2) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (G.world.isLava(x + dx, y + dy)) return true; return false; };
const archOf = (sp, mapId) => { const t = mapId && tableOf(mapId); if (t && t.packs && t.packs.includes(sp)) return 'pack'; return DISGUISE[sp] ? 'ambush' : AGGRESSIVE.has(sp) ? 'aggressive' : SKITTISH.has(sp) ? 'skittish' : 'passive'; };
const stepFor = (sp) => { const b = A.dex.species[sp]; const spe = b ? b.base[5] : 50; return Math.max(0.2, Math.min(0.62, 0.6 - spe * 0.0033)); };

export const wilds = () => G.ents.filter((e) => e.type === 'wild');
export const wildAt = (x, y) => G.ents.find((e) => e.type === 'wild' && !e.gone && ((e.tx === x && e.ty === y) || (e.moving && e.fromX === x && e.fromY === y))) || null;

// ---------------------------------------------------------------- levels in generated land (3.15, stage 5d)
// A generated encounter's table level (2 to 5) rises gently with the Chebyshev distance d from the world spawn:
// + clamp(floor((d - 64) / 32), 0, 40), plus the biome's bonus. In a cave, d is the cave mouth's. In a Kanto World
// (stage 6b fills world.meta.openings with { out: [x, y] or { x, y }, map: the Kanto route's map id }) d is the
// smaller of that and the distance to the nearest opening's out cell, and within 48 cells of an opening the level is
// lerp(routeLevel, generatedLevel, dOpen / 48), routeLevel rolled from that route's own land table. Then the cap:
// never above max(steveLevel + 6, partyBest + 4) of the player who battles, never below the table's own level.
// Kanto's maps (and Classic, which has no generated map) keep their levels exactly.
export const SLOPE = 32, FREE_D = 64, MAX_BONUS = 40, BLEND = 48;
const BIOME_BONUS = { dark_forest: 2, swamp: 2, jungle: 2, stony_hills: 3, mountains: 3, snowy_mountains: 3 };
export function biomeBonus(map) {
  if (!map || !map.gen) return 0;
  if (map.room) return map.kind === 'cave' ? (map.depth === 2 ? 8 : 4) : 0;
  return BIOME_BONUS[map.biome] || 0;
}
export const distBonus = (d) => Math.max(0, Math.min(MAX_BONUS, Math.floor((d - FREE_D) / SLOPE)));
export const capOf = (steve, best) => Math.max(steve + 6, (best | 0) + 4);
// the battling player's cap applied to a level: { steve: steveLevel(P), best: the party's best level }
export function capLevel(level, base, who) {
  if (!who) return level;
  const floor = base == null ? 1 : Math.min(base, level);   // (a co-op guest is not told the table level)
  return Math.max(floor, Math.min(level, capOf(who.steve, who.best)));
}
// where a generated map's cell counts from: its own cell outdoors, the cave's mouth in a cave room (null: no anchor)
const caveMouths = new WeakMap();
function anchorOf(map, x, y) {
  if (!map.room) return { x, y };
  if (map.kind !== 'cave') return null;
  let a = caveMouths.get(map);
  if (a === undefined) {
    const m = /^GEN_CAVE_(\d+)_B\dF$/.exec(map.id), caves = (G.world.meta && G.world.meta.genCaves) || [];
    const c = m ? caves.find((cv) => String(cv.id) === m[1]) : null;
    a = c ? { x: c.x, y: c.y } : null;
    caveMouths.set(map, a);
  }
  return a;
}
const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
function nearestOpening(x, y) {
  const list = G.world.meta && G.world.meta.openings;
  if (!list || !list.length) return null;
  let best = null, bd = Infinity;
  for (const o of list) {
    const p = Array.isArray(o.out) ? { x: o.out[0], y: o.out[1] } : o.out;
    if (!p) continue;
    const d = cheb(x, y, p.x, p.y);
    if (d < bd) { bd = d; best = { o, d }; }
  }
  return best;
}
function routeLevel(mapId, rnd) {
  const t = tableOf(mapId);
  if (!t || !t.mons.length) return null;
  let r = rnd() * t.slots.reduce((a, b) => a + b, 0), i = 0;
  for (; i < t.slots.length - 1; i++) { r -= t.slots[i]; if (r < 0) break; }
  const [, lo, hi] = t.mons[Math.min(i, t.mons.length - 1)];
  return lo + Math.floor(rnd() * (hi - lo + 1));
}
// map: the encounter's map; (x, y): its cell; level: the table's roll; who: the battling player's cap values or null
// (a visible spawn gets its level here and the cap when it battles); rnd: the route roll's random source
export function levelFor(map, x, y, level, who = null, rnd = Math.random) {
  if (!map || !map.gen || !G.world || !G.world.layout.gen) return level;
  const a = anchorOf(map, x, y), sp = G.worldSpawn;
  let lv = level;
  if (a && sp) {
    const op = nearestOpening(a.x, a.y);
    const d = op ? Math.min(cheb(a.x, a.y, sp.x, sp.y), op.d) : cheb(a.x, a.y, sp.x, sp.y);
    lv = level + distBonus(d) + biomeBonus(map);
    if (op && op.d < BLEND && !map.room) {
      const rl = routeLevel(op.o.map, rnd);
      if (rl != null) lv = Math.round(rl + (lv - rl) * (op.d / BLEND));
    }
  } else lv = level + biomeBonus(map);
  lv = Math.max(1, Math.min(100, lv));
  return capLevel(lv, level, who);
}

// one slot of the table, by FireRed's slot weights (Math.random: spawning isn't part of a battle)
function pickFrom(mapId, kind) {
  const t = A.dex.wild && A.dex.wild[mapId] && A.dex.wild[mapId][kind];
  if (!t || !t.mons || !t.mons.length) return null;
  let r = Math.random() * t.slots.reduce((a, b) => a + b, 0);
  let i = 0;
  for (; i < t.slots.length - 1; i++) { r -= t.slots[i]; if (r < 0) break; }
  const [sp, lo, hi] = t.mons[Math.min(i, t.mons.length - 1)];
  return A.dex.species[sp] ? { species: sp, level: lo + Math.floor(Math.random() * (hi - lo + 1)) } : null;
}
// generated biomes with no tall grass at all (snow, sand, shores, snowy peaks): POKeMON come out on the open ground
const OPEN_GROUND = new Set(['snowy_taiga', 'snowy_plains', 'snowy_beach', 'desert', 'beach', 'stony_shore', 'snowy_mountains']);
function free(x, y, swim) {
  const W = G.world, P = G.P;
  if (!W.inside(x, y) || W.zone[W.idx(x, y)] !== 0 || W.warpAt(x, y)) return false;
  // never inside a portal (its frame shuts it in) or on the Nether's protected edge and portal cells
  if (W.isPortal(x, y) || (W.inNether(x, y) && W.protAt(x, y))) return false;
  if (swim ? !W.isWater(x, y) : (W.solid(x, y) || W.isWater(x, y) || W.jumpDir(x, y))) return false;
  if (NET.on) { for (const p of NET.players()) if ((p.tx === x && p.ty === y) || (p.moving && p.fromX === x && p.fromY === y)) return false; }
  else if ((P.tx === x && P.ty === y) || (P.moving && P.fromX === x && P.fromY === y)) return false;
  if (G.npcAt && G.npcAt(x, y)) return false;
  return !G.ents.some((e) => (e.type === 'mob' || e.type === 'wild' || e.type === 'boat') && e.tx === x && e.ty === y);
}

export function trySpawn(around = G.P) {
  if (!G.rules.wild || !G.rules.encounters) return;
  const W = G.world, P = around;
  const near = wilds().filter((e) => Math.abs(e.tx - P.tx) < 20 && Math.abs(e.ty - P.ty) < 16).length;
  if (near >= CAP) return;
  const here = W.mapAt(P.tx, P.ty);
  for (let tries = 0; tries < 10; tries++) {
    const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 8;
    const x = Math.round(P.tx + Math.cos(a) * r), y = Math.round(P.ty + Math.sin(a) * r * 0.75);
    const map = W.mapAt(x, y);
    if (!map || (here && map.room !== here.room) || (here && here.room && map !== here)) continue;
    if (map.kind === 'indoor' && map.id.indexOf('POWER_PLANT') < 0 && map.id.indexOf('POKEMON_TOWER') < 0) continue;
    let kind = null;
    if (W.isWater(x, y) && !W.block(x, y)) kind = 'water';
    else if (W.tallGrass(x, y)) kind = 'land';
    else if (map.room && W.entry(x, y)[7] === 1) kind = 'land';                 // cave floors, the forest, the Tower
    else if (!map.room && W.isGrass(x, y) && Math.random() < 0.35) {           // near tall grass, out in the open
      let g = false; for (let dy = -2; dy <= 2 && !g; dy++) for (let dx = -2; dx <= 2 && !g; dx++) g = W.tallGrass(x + dx, y + dy);
      if (g) kind = 'land';
    }
    else if (map.gen && !map.room && OPEN_GROUND.has(map.biome) && Math.random() < 0.35) kind = 'land';
    if (!kind || !free(x, y, kind === 'water')) continue;
    const tid = wildId(map);
    let enc = pickFrom(tid, kind);
    if (!enc) continue;
    // generated land: the level by distance and biome (3.15; the cap comes when it battles), the table's own kept
    if (map.gen) { enc.base = enc.level; enc.level = levelFor(map, x, y, enc.level); }
    // lava dwellers only beside lava; beside lava, they are who you mostly meet
    const t = kind === 'land' && tableOf(tid), lavaList = t && t.lava;
    if (lavaList) {
      const nearLava = lavaNear(x, y);
      if (lavaList.includes(enc.species) && !nearLava) continue;
      if (nearLava && Math.random() < 0.45) {
        const sp = lavaList[Math.floor(Math.random() * lavaList.length)], row = t.mons.find((m) => m[0] === sp);
        if (row) enc = { species: sp, level: row[1] + Math.floor(Math.random() * (row[2] - row[1] + 1)) };
      }
    }
    const arch = archOf(enc.species, tid);
    const add = (cx, cy, e) => G.ents.push({ type: 'wild', ...e, arch, swim: kind === 'water', tx: cx, ty: cy, fx: cx, fy: cy, fromX: cx, fromY: cy, moving: false, prog: 0,
      step: stepFor(e.species), dir: DIR_LIST[Math.floor(Math.random() * 4)], home: { x: cx, y: cy }, think: Math.random() * 2, calm: 0,
      state: 'idle', emote: 0, disguise: DISGUISE[e.species] || null, shiny: Math.random() < 1 / 8192, map, pack: arch === 'pack' ? pack : null });
    const pack = arch === 'pack' ? {} : null;
    add(x, y, enc);
    // a pack: one or two more of its kind close by
    if (pack) {
      const more = 1 + Math.floor(Math.random() * 2);
      for (let i = 0, k = 0; i < more && k < 16; k++) {
        const cx = x + Math.floor(Math.random() * 5) - 2, cy = y + Math.floor(Math.random() * 5) - 2;
        if (W.mapAt(cx, cy) !== map || !free(cx, cy, false)) continue;
        const row = t && t.mons.find((m) => m[0] === enc.species);
        add(cx, cy, { species: enc.species, level: row ? row[1] + Math.floor(Math.random() * (row[2] - row[1] + 1)) : enc.level });
        i++;
      }
    }
    return;
  }
}

// Put one visible wild POKéMON down at (x, y) (tests and scripts); a pack species brings no packmates here.
export function spawnWildAt(species, level, x, y, opts = {}) {
  const map = G.world.mapAt(x, y), arch = opts.arch || archOf(species, wildId(map));
  const e = { type: 'wild', species, level, arch, swim: false, tx: x, ty: y, fx: x, fy: y, fromX: x, fromY: y, moving: false, prog: 0, step: stepFor(species),
    dir: DIR_LIST[Math.floor(Math.random() * 4)], home: { x, y }, think: Math.random() * 2, calm: 0, state: 'idle', emote: 0, disguise: DISGUISE[species] || null,
    shiny: false, map, pack: arch === 'pack' ? opts.pack || {} : null };
  G.ents.push(e);
  return e;
}
function stepTo(e, dir, mul = 1) {
  const x = e.tx + DIRS[dir].x, y = e.ty + DIRS[dir].y;
  e.dir = dir;
  if (!free(x, y, e.swim)) return false;
  if (G.world.mapAt(x, y) !== e.map) return false;
  e.fromX = e.tx; e.fromY = e.ty; e.tx = x; e.ty = y; e.moving = true; e.prog = 0; e.mul = mul;
  if (NET.h) NET.h.step(e, e.step / (mul || 1));
  return true;
}
// gone when far away or in another place
const strayed = (e, P, W) => Math.abs(P.tx - e.tx) > 26 || Math.abs(P.ty - e.ty) > 20 || W.mapAt(P.tx, P.ty) !== e.map && !(e.map && !e.map.room && !W.roomAt(P.tx, P.ty));
// co-op: the nearest player it still belongs with (null: every player is far away or somewhere else)
function nearestOf(e, W) {
  let best = null, bd = 1e9;
  for (const p of NET.players()) { if (strayed(e, p, W)) continue; const d = Math.abs(p.tx - e.tx) + Math.abs(p.ty - e.ty); if (d < bd) { bd = d; best = p; } }
  return best;
}
export function updateWild(dt, engage) {
  const W = G.world;
  for (const e of G.ents) {
    if (e.type !== 'wild') continue;
    if (e.gone) continue;   // co-op: in someone's battle (never set in single-player)
    const P = NET.on ? nearestOf(e, W) : G.P;
    if (!P) { e.dead = true; continue; }
    const dx = P.tx - e.tx, dy = P.ty - e.ty, dist = Math.abs(dx) + Math.abs(dy);
    if (!NET.on && strayed(e, P, W)) { e.dead = true; continue; }
    if (e.emote > 0) e.emote -= dt;
    if (e.calm > 0) e.calm -= dt;
    if (e.pack && e.pack.hunt > 0) e.pack.hunt -= dt / Math.max(1, G.ents.filter((o) => o.type === 'wild' && o.pack === e.pack).length);
    if (e.moving) {
      e.prog += dt / (e.step / (e.mul || 1));
      if (e.prog >= 1) { e.moving = false; e.prog = 0; e.fx = e.tx; e.fy = e.ty; }
      else { e.fx = e.fromX + (e.tx - e.fromX) * e.prog; e.fy = e.fromY + (e.ty - e.fromY) * e.prog; }
      continue;
    }
    if ((NET.on ? NET.busy(P) : G.busy()) || P.dead) continue;
    // lying in wait: a rock, an item ball, a patch of ground, until Steve is right beside it
    if (e.disguise) {
      if (dist <= 1 && e.calm <= 0) { e.disguise = null; e.emote = 0.8; e.dir = dirTo(e.tx, e.ty, P.tx, P.ty); if (NET.h && P !== G.P) NET.h.engage(e, P, true); else engage(e, true); return; }
      continue;
    }
    // a pack hunts together: when one spots Steve (from further off than a lone chaser), they all come
    if (e.arch === 'pack' && e.calm <= 0 && dist <= 8 && e.pack) e.pack.hunt = 6;
    const hunting = e.arch === 'pack' && e.pack && e.pack.hunt > 0 && dist <= 14;
    if ((e.arch === 'aggressive' && e.calm <= 0 && dist <= 5 && !P.riding === !e.swim) || (hunting && e.calm <= 0)) {
      if (e.state !== 'chase') { e.state = 'chase'; e.emote = 0.6; e.think = 0.5; continue; }
      if (dist === 1) { e.dir = dirTo(e.tx, e.ty, P.tx, P.ty); if (NET.h && P !== G.P) NET.h.engage(e, P, true); else engage(e, true); return; }
      e.think -= dt;
      if (e.think > 0) continue;
      e.think = 0.05;
      const first = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      const second = Math.abs(dx) >= Math.abs(dy) ? (dy > 0 ? 'down' : dy < 0 ? 'up' : null) : (dx > 0 ? 'right' : dx < 0 ? 'left' : null);
      if (!stepTo(e, first, 1.15) && second) stepTo(e, second, 1.15);
      continue;
    }
    if (e.state === 'chase' && dist > 9) e.state = 'idle';
    if (e.arch === 'skittish' && dist <= (P.sprinting ? 6 : 4) && e.calm <= 0) {
      const away = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'left' : 'right') : (dy > 0 ? 'up' : 'down');
      if (!stepTo(e, away, 1.6)) stepTo(e, DIR_LIST[Math.floor(Math.random() * 4)], 1.6);
      continue;
    }
    e.think -= dt;
    if (e.think > 0) continue;
    e.think = 1 + Math.random() * 2.5;
    const dir = DIR_LIST[Math.floor(Math.random() * 4)];
    const x = e.tx + DIRS[dir].x, y = e.ty + DIRS[dir].y;
    // wanderers stay near home and in their own kind of ground
    if (Math.abs(x - e.home.x) > 4 || Math.abs(y - e.home.y) > 4) { e.dir = dir; continue; }
    if (Math.random() < 0.6) stepTo(e, dir); else e.dir = dir;
  }
}

// drawing: the walking sprite (pokeemerald-expansion overworld sheets, like the follower), or its disguise
function bubble(ctx, x, y) {
  ctx.fillStyle = '#202020'; ctx.fillRect(x - 5, y - 1, 10, 12);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 4, y, 8, 10);
  ctx.fillStyle = '#e02020'; ctx.fillRect(x - 1, y + 1, 2, 5); ctx.fillRect(x - 1, y + 7, 2, 2);
}
export function wildSprites(cam, list, owFrame) {
  for (const e of G.ents) {
    if (e.type !== 'wild' || e.gone) continue;   // (gone: co-op, in someone's battle)
    list.push({ y: e.fy + 0.01, fn: (ctx) => {
      const bx = Math.round(e.fx * TILE - cam.x), by = Math.round(e.fy * TILE - cam.y);
      if (e.disguise === 'hidden') return;
      if (e.disguise === 'rock') { ctx.fillStyle = '#7a6a58'; ctx.fillRect(bx + 3, by + 5, 10, 9); ctx.fillStyle = '#a89480'; ctx.fillRect(bx + 4, by + 5, 7, 4); ctx.fillStyle = '#3a3028'; ctx.fillRect(bx + 3, by + 13, 10, 1); return; }
      if (e.disguise === 'ball') { const img = A.img.healBall; if (img) ctx.drawImage(img, bx + 4, by + 6); return; }
      const f = owFrame(e.species, e.dir, e.moving ? Math.floor(e.prog * 2) % 2 : Math.floor(G.clock * 2 + e.home.x) % 2, e.shiny);
      if (!f) return;
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(bx + 8, by + 13, 6, 2, 0, 0, Math.PI * 2); ctx.fill();
      if (e.swim) { ctx.save(); ctx.beginPath(); ctx.rect(bx - 8, by - 16, 32, 26); ctx.clip(); }
      ctx.drawImage(f, bx - 8, by - 16);
      if (e.swim) ctx.restore();
      if (e.emote > 0) bubble(ctx, bx + 8, by - 26);
    } });
  }
}
