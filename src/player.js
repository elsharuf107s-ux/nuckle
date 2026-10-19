// Steve: FireRed grid movement with Minecraft's verbs. Z mines and attacks (hold), X uses whatever is
// in hand or the block in front, Space jumps, Shift sprints. Survival follows Java Edition: 20 health,
// 20 food, saturation and exhaustion, natural regeneration, starving, armor, knockback, XP levels.
import { A } from './assets.js';
import { G, TILE, DIRS, OPP, dirTo } from './game.js';
import { item, toolOf, foodOf, breakInfo, nameOf, campfireOf, bladeSided } from './items.js';
import { blockLook, drawLook, isDoor, PROT } from './world.js';
import { mc, sfx } from './audio.js';
import { breakParticles, dropItem, dropOrbs, hurtMob, mobAt, flyerNear, cellFree, noEntityAt, particle, spriteParticle, shootArrow, primeTNT, splash, poof } from './entities.js';
import { lightPortal, breakPortalNear, scoopLava, pourLava, waterOn, isFrame, portalInterior } from './nether.js';
import { xpForLevel } from './hud.js';
import { npcHome } from './npcs.js';
import * as RNG from './rng.js';
import { NET } from './net/flag.js';   // co-op: false in single-player

export const WALK_T = 0.24, SPRINT_T = 0.15, SWIM_T = 0.42, BOAT_T = 0.17;
const FOOT = 13;

export function makePlayer(x, y) {
  return { name: 'Steve', tx: x, ty: y, fx: x, fy: y, fromX: x, fromY: y, moving: false, prog: 0, speed: WALK_T, dist: 1, dir: 'down',
    health: 20, food: 20, sat: 5, exh: 0, foodTimer: 0, absorb: 0, regen: 0, hungerEffect: 0, poisoned: false,
    hurtFlash: 0, regenFlash: 0, invuln: 0, xpTotal: 0, level: 0, xpProgress: 0,
    jumpT: 0, z: 0, swingT: 0, swingN: 0, mining: null, useT: 0, using: null, bowT: 0, placeT: 0, attackCd: 1,
    swimming: false, riding: null, sleeping: null, dead: false, deathT: 0, sprinting: false, visible: true, turnHold: 0, stepSound: 0, fireT: 0 };
}
export function placePlayer(P, x, y, dir) { P.tx = P.fromX = P.fx = x; P.ty = P.fromY = P.fy = y; P.moving = false; P.prog = 0; if (dir) P.dir = dir; }
export const facing = (P) => ({ x: P.tx + DIRS[P.dir].x, y: P.ty + DIRS[P.dir].y });

// ---------------------------------------------------------------- what is in front of Steve
// Returns the thing Z would act on: a mob, a placed block, a breakable tile, a floor to dig, a building's
// door, or a protected cell (kind 'protected': Z only bumps it).
export function target(P) {
  const W = G.world, f = facing(P);
  const m = mobAt(f.x, f.y) || flyerNear(f.x, f.y, 1.1);
  if (m) return { kind: 'mob', mob: m, ...f };
  const boat = G.ents.find((e) => e.type === 'boat' && e.tx === f.x && e.ty === f.y && e !== P.riding);
  if (boat) return { kind: 'boat', boat, ...f, spec: { hard: 0.4, sound: 'wood', tool: 'axe' } };
  const b = W.block(f.x, f.y);
  if (b) {
    const spec = blockSpec(b);
    if (spec && spec.hard >= 0) return { kind: 'block', block: b, ...f, spec };
    if (spec) return null;            // lava, a portal: nothing to mine, and nothing to dig under it
  }
  if (W.isVoid(f.x, f.y)) {
    // (playfix: a cave room's outer wall, the margin around the room, bumps like a building instead of doing nothing)
    if (W.layout.gen && W.inside(f.x, f.y)) { const r = W.roomAt(P.tx, P.ty); if (r && r.kind === 'cave') return { kind: 'protected', ...f }; }
    return null;
  }
  // a building's door comes off with an axe and drops that style of door
  const door = W.doorClosed(f.x, f.y);
  if (door) return { kind: 'tile', mat: 'door', door, ...f, spec: { hard: 3.0, tool: 'axe', sound: door.sound === 'sliding' ? 'stone' : 'wood', drop: 'door_' + door.style } };
  const tg = tileTarget(W, f);
  // buildings, monuments, openings, doorways and rooms: whatever Z would mine there, it doesn't
  if ((W.noBreak(f.x, f.y) || W.protAt(f.x, f.y) === PROT.DOOR) && (tg || W.baseBlocked(f.x, f.y))) return { kind: 'protected', ...f };
  // walkable pieces of a building or a sign drawn over the ground (roof eaves, the mailbox top): no shovel either
  if (W.overhang(f.x, f.y)) return { kind: 'protected', ...f };
  if (tg && tg.kind === 'dig' && W.noPlace(f.x, f.y)) return null;
  return tg;
}
function tileTarget(W, f) {
  const mat = W.mat(f.x, f.y);
  const ore = A.world.ores[mat];
  if (ore) return { kind: 'tile', mat, ...f, spec: { hard: ore.hard, tool: 'pickaxe', need: ore.tier, sound: 'stone', drop: ore.drop, ore: mat } };
  const m2 = A.world.materials[mat];
  if (m2 && m2.hard >= 0) {
    // the Nether's soft floors (soul sand, soul soil, magma) come up only with their own tool in hand
    if (!W.baseBlocked(f.x, f.y) && W.inNether(f.x, f.y)) { const t = toolOf(G.inv.held); if (!t || t.kind !== m2.tool) return null; }
    return { kind: 'tile', mat, ...f, spec: m2 };
  }
  // generated ice: anything breaks it, a pickaxe fastest, and it turns back into water (3.5)
  if (mat === 'ice' && W.isIce(f.x, f.y)) return { kind: 'tile', mat, ...f, spec: { hard: 0.5, tool: 'pickaxe', sound: 'glass', drop: null } };
  // floors: a shovel digs them (grass to a dirt path, sand stays sand); not the Nether's netherrack
  const held = G.inv.held, t = toolOf(held);
  // the generated grounds (4.5): snow gives a snowball and stays snow, clay four clay balls, mud and podzol dirt;
  // all but snow leave a dirt path, as grass does
  const gd = GEN_DIG[mat];
  if (gd && t && t.kind === 'shovel' && !W.baseBlocked(f.x, f.y) && !W.isWater(f.x, f.y)) return { kind: 'dig', mat, ...f, spec: { hard: 0.6, tool: 'shovel', ...gd } };
  if (t && t.kind === 'shovel' && (mat === 'floor' || mat === 'sand') && !W.baseBlocked(f.x, f.y) && !W.isWater(f.x, f.y) && !W.inNether(f.x, f.y) && !W.inEnd(f.x, f.y) && !W.inStronghold(f.x, f.y))
    return { kind: 'dig', mat, ...f, spec: { hard: 0.6, tool: 'shovel', sound: mat === 'sand' ? 'sand' : 'gravel', drop: mat === 'sand' ? 'sand' : 'dirt' } };
  return null;
}
// Holding Z on a protected cell: a dull knock and the reason, no progress and no cracks.
export function bumpProtected(P, first) {
  P.swingT = P.swingT > 0 ? P.swingT : 0.001;
  mc('step.stone', { vol: first ? 0.45 : 0.3, pitch: 0.5 });
  if (G.toast) G.toast("It's too sturdy to break.");
}
function blockSpec(b) {
  if (b.crop) return { hard: 0, sound: 'grass', crop: true };
  if (b.id === 'farmland' || b.id === 'dirt_path') return { hard: 0.6, tool: 'shovel', sound: 'gravel', drop: 'dirt' };
  if (b.id === 'fire') return { hard: 0, sound: 'grass' };
  if (b.id === 'nether_wart') return { hard: 0, sound: 'grass', wart: true };
  const it = item(b.id);
  if (!it || !it.block) return null;
  return it.block;
}

const isSapling = (id) => typeof id === 'string' && id.endsWith('_sapling');   // oak and the world update's five woods
// shovel digs of the generated grounds (stage 5a): what comes up, the sound, and whether a dirt path is left
const GEN_DIG = {
  snow: { sound: 'sand', drop: 'snowball' }, clay: { sound: 'gravel', drop: 'clay_ball', dropN: 4, path: true },
  mud: { sound: 'gravel', drop: 'dirt', path: true }, podzol: { sound: 'gravel', drop: 'dirt', path: true },
};
// ---------------------------------------------------------------- breaking
function crackStage(P) { return P.mining ? Math.min(9, Math.floor(P.mining.progress * 10)) : -1; }
function colorsOf(tg) {
  // sample the target's pixels for break particles
  const c = document.createElement('canvas'); c.width = 16; c.height = 16;
  const x = c.getContext('2d');
  const W = G.world;
  if (tg.kind === 'block' || tg.kind === 'boat') {
    const it = item(tg.block ? tg.block.id : 'oak_planks');
    const i = it ? it.iconIndex : 0;
    x.drawImage(A.mc.icons, (i % 32) * 16, Math.floor(i / 32) * 16, 16, 16, 0, 0, 16, 16);
  } else {
    const t = W.tile(tg.x, tg.y);
    const cols = A.world.cols;
    x.drawImage(A.img.atlas, (t % cols) * 16, Math.floor(t / cols) * 16, 16, 16, 0, 0, 16, 16);
    x.drawImage(A.img.atlasTop, (t % cols) * 16, Math.floor(t / cols) * 16, 16, 16, 0, 0, 16, 16);
  }
  const d = x.getImageData(0, 0, 16, 16).data, out = [];
  for (let i = 0; i < d.length; i += 4 * 7) if (d[i + 3] > 0) out.push(`rgb(${d[i]},${d[i + 1]},${d[i + 2]})`);
  return out.length ? out : ['#888'];
}
export function finishBreak(P, tg) {
  const nEnts = G.ents.length;
  finishBreak0(P, tg);
  // The End: what comes out of a cell that is now void (a mined bridge, the platform's obsidian) lands at Steve's
  // feet instead of falling out of the world
  const W = G.world;
  if (W.isEndVoid(tg.x, tg.y)) for (let i = nEnts; i < G.ents.length; i++) { const e = G.ents[i]; if (e.type === 'item' || e.type === 'xp') { e.x = P.fx * TILE + 8; e.y = P.fy * TILE + 8; e.vx = 0; e.vy = 0; } }
}
function finishBreak0(P, tg) {
  const W = G.world, spec = tg.spec, held = G.inv.held;
  // Creative (generated worlds, G.mr: the world update's 6.1): the block's own drop never comes out (no harvest, no
  // RNG draws, no XP), while a chest's, a furnace's or a campfire's contents still spill (`spill`)
  const own = !G.mr || G.mr.blockDrops;
  const info = own ? breakInfo(spec, held) || { harvest: true } : { ticks: 1, harvest: false, creative: true };
  mc('dig.' + (spec.sound || 'stone'), { vol: 1, pitch: 0.8 });
  breakParticles(tg.x * TILE, tg.y * TILE, colorsOf(tg), tg.kind === 'tile' && tg.mat === 'tree' ? 26 : 16);
  const spill = (id, n = 1, extra) => { if (id && n > 0) dropItem(id, n, tg.x * TILE, tg.y * TILE, extra); };
  const drop = own ? spill : () => {};
  if (tg.kind === 'boat') { if (NET.g && tg.boat.nid != null) NET.g.breakBoat(tg.boat); else { drop('oak_boat'); tg.boat.dead = true; } }
  else if (tg.kind === 'block') {
    const b = tg.block;
    if (b.crop) {
      // harvesting leaves the farmland behind, as in Minecraft
      if (b.crop.stage >= 7) { drop('wheat', 1); drop('wheat_seeds', 1 + RNG.randInt(3)); } else drop('wheat_seeds', 1);
      delete b.crop; W.setBlock(tg.x, tg.y, b);
      exhaust(P, 0.005);
      if (G.onBreak) G.onBreak(tg, true);
      return;
    }
    if (info.harvest) {
      if (b.id === 'wheat') { if (b.stage >= 7) { drop('wheat', 1); drop('wheat_seeds', 1 + RNG.randInt(3)); } else drop('wheat_seeds', 1); }
      else if (b.id === 'white_bed') drop('white_bed');
      else if (b.id === 'nether_wart') drop('nether_wart', (b.stage || 0) >= 2 ? 2 + RNG.randInt(3) : 1);
      // a cobweb gives string only to a sword or shears
      else if (b.id === 'cobweb') { const t = toolOf(held); if (t && (spec.cut || []).includes(t.kind)) drop('string'); }
      else if (b.id !== 'fire' && b.id !== 'soul_fire') drop(spec.drop === undefined ? b.id : spec.drop, dropCount(spec));
    }
    if (b.id === 'chest') for (const s of b.slots) if (s) spill(s.id, s.n, s.dmg ? { dmg: s.dmg } : undefined);
    if (spec.xp && own) dropOrbs(spec.xp[0] + RNG.randInt(spec.xp[1] - spec.xp[0] + 1), tg.x * TILE, tg.y * TILE);      // a spawner
    if (b.id === 'campfire') for (const s of b.items || []) if (s) spill(s.id, 1);
    if (b.id === 'furnace') for (const s of [b.input, b.fuel, b.output]) if (s) spill(s.id, s.n);
    if (b.id === 'white_bed' && b.other) W.setBlock(b.other[0], b.other[1], null);
    if (b.flush && b.under != null) W.setTile(tg.x, tg.y, b.under);
    // a block built on an End bridge leaves the bridge; a bridge mined leaves the void (and the edges around it)
    W.setBlock(tg.x, tg.y, b.onBridge || null);
    if (b.bridge) W.reedgeEnd(tg.x, tg.y);
    if (G.spawnBed && G.spawnBed[0] === tg.x && G.spawnBed[1] === tg.y) G.spawnBed = null;
    if (b.id === 'obsidian') breakPortalNear(tg.x, tg.y);
  } else if (tg.door) {
    // the door comes off its hinges and the doorway stays: still solid, still the way in
    drop(spec.drop);
    W.openDoor(tg.x, tg.y);
    mc('door_open', { vol: 0.5, pitch: 0.9 });
  } else if (tg.kind === 'dig') {
    drop(spec.drop, spec.dropN || 1);
    if (tg.mat === 'floor' || spec.path) W.setBlock(tg.x, tg.y, { id: 'dirt_path', flush: true, flushLook: 'dirt_path', walk: true, drop: 'dirt' });
  } else {
    const mat = tg.mat;
    if (info.harvest) {
      if (spec.ore) {
        const n = mat === 'redstone_ore' ? 4 + RNG.randInt(2) : mat === 'lapis_ore' ? 4 + RNG.randInt(6) : mat === 'copper_ore' ? 2 + RNG.randInt(4) : 1;   // (playfix: copper drops 2 to 5 raw copper, as in Minecraft)
        drop(spec.drop, n);
        const xp = { coal_ore: [0, 2], redstone_ore: [1, 5], lapis_ore: [2, 5], diamond_ore: [3, 7], emerald_ore: [3, 7] }[mat];
        if (xp) dropOrbs(xp[0] + RNG.randInt(xp[1] - xp[0] + 1), tg.x * TILE, tg.y * TILE);
      } else if (mat === 'tree') {
        // the tree's own wood (generated species, 4.5; Classic's trees are oak)
        const wood = W.treeWood(tg.x, tg.y);
        drop(wood + '_log', 3 + RNG.randInt(3));
        if (RNG.rand() < 0.4) drop(wood + '_sapling', 1);
        if (RNG.rand() < 0.12) drop('apple', 1);
        if (RNG.rand() < 0.2) drop('stick', 1 + RNG.randInt(2));
      } else if (mat === 'tallgrass') { if (RNG.rand() < 0.125) drop('wheat_seeds'); }
      else if (mat === 'flower') drop(RNG.rand() < 0.7 ? 'poppy' : 'dandelion');
      else if (mat === 'leaves') { if (RNG.rand() < 0.12) drop('oak_sapling'); if (RNG.rand() < 0.06) drop('stick'); if (RNG.rand() < 0.03) drop('apple'); }
      else if (mat === 'bush') { if (RNG.rand() < 0.5) drop('oak_sapling'); if (RNG.rand() < 0.15) drop('apple'); if (RNG.rand() < 0.3) drop('stick'); }
      else if (mat === 'boulder') { drop('cobblestone'); if (RNG.rand() < 0.35) drop('flint'); }
      else if (spec.drop) {
        drop(spec.drop, dropCount(spec));
        if (spec.xp) dropOrbs(spec.xp[0] + RNG.randInt(spec.xp[1] - spec.xp[0] + 1), tg.x * TILE, tg.y * TILE);
      }
    }
    const tree = mat === 'tree';
    const cells = mat === 'ice' && W.isIce(tg.x, tg.y) && W.meltIce(tg.x, tg.y) ? [[tg.x, tg.y]] : W.breakTile(tg.x, tg.y);
    // an infested block: a silverfish comes out of it
    if (spec.infested && G.onInfested) G.onInfested(tg.x, tg.y);
    if (tree) for (const [cx, cy] of cells) if (cx !== tg.x || cy !== tg.y) breakParticles(cx * TILE, cy * TILE, ['#3c8c3c', '#5ab45a', '#2a6a30', '#7a5030'], 8, 10);
  }
  // tools wear: one point per block (two for swords), none on instant blocks
  if (spec.hard > 0 && held && toolOf(held)) {
    const broke = G.inv.wearHeld(toolOf(held).kind === 'sword' ? 2 : 1);
    if (broke) toolBroke(P, held);
  }
  exhaust(P, 0.005);
  if (G.onBreak) G.onBreak(tg, info.harvest);
}
// how many of a block's drop come out: a fixed count, or a range (glowstone 2-4 dust, nether gold 2-6 nuggets)
const dropCount = (spec) => (spec.dropMax ? spec.dropN + RNG.randInt(spec.dropMax - spec.dropN + 1) : spec.dropN || 1);
function toolBroke(P, s) {
  mc('break', { vol: 0.8 });
  const x = P.fx * TILE + 8, y = P.fy * TILE + 4;
  for (let i = 0; i < 10; i++) particle({ x, y, z: 8, vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 30, vz: 40, g: -160, life: 0.6, color: '#8a8a8a', size: 2, bounce: true });
  G.toast && G.toast(`Your ${nameOf(s.id)} broke!`);
}

// ---------------------------------------------------------------- combat
export function attack(P, m) {
  const held = G.inv.held, t = toolOf(held);
  const base = t ? t.dmg : 1;
  const rate = t ? t.rate : 4;
  // Minecraft's attack cooldown: hitting before the swing recharges does far less damage
  const charge = Math.min(1, P.attackCd * rate);
  let dmg = base * (0.2 + charge * charge * 0.8);
  const crit = P.jumpT > 0.18 && charge > 0.9;
  if (crit) dmg *= 1.5;
  P.attackCd = 0;
  P.swingT = 0.001;
  if (hurtMob(m, dmg, { x: P.tx, y: P.ty }, { crit, knock: P.sprinting && charge > 0.9 ? 2 : 1, player: true, melee: true })) {
    mc(crit ? 'attack.crit' : charge > 0.9 ? (t && t.kind === 'sword' ? 'attack.sweep' : 'attack.strong') : 'attack.weak', { vol: 0.7 });
    if (charge > 0.9 && t && t.kind === 'sword' && !crit) spriteParticle(A.mc.pSweep, 8, m.fx * TILE + 8 + DIRS[P.dir].x * -6, m.fy * TILE + 6, { life: 0.3, fw: 32, scale: 1.25 });
    if (t && G.inv.wearHeld(t.kind === 'sword' ? 1 : 2)) toolBroke(P, held);
    exhaust(P, 0.1);
    if (m.dying) m.byPlayer = true;
  } else mc('attack.weak', { vol: 0.4 });
}
export function exhaust(P, v) { if (G.rules.hunger && (!G.mr || G.mr.hunger)) P.exh += v; }

export function hurtPlayer(P, amount, cause, from = null, ranged = false, opts = {}) {
  if (P.dead || P.invuln > 0 || amount <= 0 || P.voidFall) return false;
  // Creative and spectators take no damage (the End's void still kills a creative player: end.js updateFall)
  if (G.mr && !G.mr.damage) return false;
  // armor: Minecraft's damage reduction (not for a fall, the ender pearl's landing)
  const def = opts.noArmor ? 0 : G.inv.armorPoints(), tough = G.inv.armorToughness();
  if (def > 0) amount = amount * (1 - Math.min(20, Math.max(def / 5, def - amount / (2 + tough / 4))) / 25);
  if (P.absorb > 0) { const a = Math.min(P.absorb, amount); P.absorb -= a; amount -= a; }
  P.health = Math.max(0, P.health - amount);
  P.invuln = 0.5; P.hurtFlash = 0.5;
  mc('hurt', { vol: 0.9 });
  exhaust(P, 0.1);
  for (let i = 0; i < 4; i++) if (G.inv.armor[i]) { const a = G.inv.armor[i]; a.dmg = (a.dmg || 0) + 1; if (a.dmg >= item(a.id).armor.dur) { G.inv.armor[i] = null; mc('break'); } }
  // knockback away from the attacker
  if (from && !P.moving && !P.riding && !P.sleeping) {
    const fx = from.tx ?? Math.floor(from.x / TILE), fy = from.ty ?? Math.floor(from.y / TILE);
    const d = DIRS[dirTo(fx, fy, P.tx, P.ty)];
    const nx = P.tx + d.x, ny = P.ty + d.y;
    if (canEnter(P, nx, ny) === 'walk') { P.fromX = P.tx; P.fromY = P.ty; P.tx = nx; P.ty = ny; P.moving = true; P.prog = 0; P.speed = 0.12; P.dist = 1; P.knocked = true; }
    // knocked off the edge of The End
    else if (G.world.isEndVoid(nx, ny) && G.fallIntoVoid && !opts.noKnock) { G.fallIntoVoid(nx, ny); return true; }
  }
  if (P.sleeping) wake(P);
  if (P.health <= 0) { P.dead = true; P.deathT = 0; P.deathMsg = cause; G.onDeath && G.onDeath(cause); }
  void ranged;
  return true;
}
export function heal(P, n) { P.health = Math.min(20, P.health + n); }

// ---------------------------------------------------------------- food and experience
export function survivalTick(P) {
  // one Minecraft tick (1/20 s) of the hunger system
  if (P.dead) return;
  // generated worlds' modes (6.1, 6.2): no hunger in Creative, Peaceful or as a spectator; Peaceful heals 1 every 2 s
  // and fills the food bar back up
  const mr = G.mr;
  if (mr && !mr.hunger) {
    P.exh = 0; P.hungerEffect = 0;
    if (mr.peacefulRegen > 0 && (P.peaceT = (P.peaceT || 0) + 1) >= 40) { P.peaceT = 0; if (P.health < 20) { heal(P, 1); P.regenFlash = 0.25; } if (P.food < 20) P.food++; }
  }
  if (P.hungerEffect > 0) { P.hungerEffect--; exhaust(P, 0.005); }
  if (P.exh >= 4) { P.exh -= 4; if (P.sat > 0) P.sat = Math.max(0, P.sat - 1); else P.food = Math.max(0, P.food - 1); }
  if (P.regen > 0) { P.regen--; if (P.regen % 25 === 0 && P.health < 20) { heal(P, 1); P.regenFlash = 0.4; } }
  if (P.sat > 0 && P.food >= 20 && P.health < 20) {
    P.foodTimer++;
    if (P.foodTimer >= 10) { const h = Math.min(P.sat, 6); heal(P, h / 6); P.exh += h; P.foodTimer = 0; P.regenFlash = 0.25; }
  } else if (P.food >= 18 && P.health < 20) {
    P.foodTimer++;
    if (P.foodTimer >= 80) { heal(P, 1); exhaust(P, 6); P.foodTimer = 0; P.regenFlash = 0.25; }
  } else if (P.food <= 0) {
    P.foodTimer++;
    if (P.foodTimer >= 80) { if (P.health > (mr ? mr.starveFloor : 1)) hurtPlayer(P, 1, `${P.name} starved to death`); P.foodTimer = 0; }
  } else P.foodTimer = 0;
}
export function giveXp(P, n) {
  P.xpTotal += n; P.xpProgress += n;
  let leveled = false;
  while (P.xpProgress >= xpForLevel(P.level)) { P.xpProgress -= xpForLevel(P.level); P.level++; leveled = true; }
  if (leveled && P.level % 5 === 0) mc('levelup', { vol: 0.75 });
  else mc('orb', { vol: 0.25, pitch: 0.55 + Math.random() * 0.85 });
}

// ---------------------------------------------------------------- movement
// What happens if Steve steps into (x, y): 'walk', 'swim', 'boat' or null.
export function canEnter(P, x, y) {
  const W = G.world;
  if (P.riding) return W.isWater(x, y) && noEntityAt(x, y, P.riding) ? 'boat' : null;
  // a spectator (6.4) moves through solid cells and creatures, inside the current place, never into the void or past
  // the world border
  if (G.mr && G.mr.noclip && P === G.P) return !W.isVoid(x, y) && W.inBorder(x, y) && !W.isEndVoid(x, y) && W.samePlace(P.tx, P.ty, x, y) ? 'walk' : null;
  if (W.solid(x, y)) return null;
  if (mobAt(x, y) || (G.npcAt && G.npcAt(x, y)) || (G.wildAt && G.wildAt(x, y))) return null;
  if (G.ents.some((e) => (e.type === 'boat' || e.type === 'tnt') && e.tx === x && e.ty === y)) return null;
  if (W.isWater(x, y)) return 'swim';
  return 'walk';
}
// a two-cell step over a lit portal's obsidian frame: a flat stride through the doorway, not a ledge hop
export function frameHop(o) {
  if (o.dist !== 2) return false;
  const mx = (o.fromX + o.tx) / 2, my = (o.fromY + o.ty) / 2;
  return Number.isInteger(mx) && Number.isInteger(my) && isFrame(mx, my);
}
export function tryStep(P, dir, input) {
  const W = G.world, d = DIRS[dir];
  P.dir = dir;
  // standing in a lit portal: the first portal cell he reaches is where he waits for the trip (he doesn't wade on
  // through it); after arriving (portalCool) he moves freely, and he can always step back out over the frame
  if (!P.riding && !G.portalCool && W.isPortal(P.tx, P.ty) && W.isPortal(P.tx + d.x, P.ty + d.y)) return false;
  let nx = P.tx + d.x, ny = P.ty + d.y, dist = 1;
  const j = !P.riding && !(G.mr && G.mr.noclip) && W.jumpDir(nx, ny);
  if (j) { if (j !== dir) return false; nx += d.x; ny += d.y; dist = 2; }
  // a lit portal's obsidian frame is stepped over, into the portal or back out of it
  // (and out of a ring whose portal went out, so Steve is never shut in by his own frame)
  else if (!P.riding && isFrame(nx, ny) && (W.isPortal(nx + d.x, ny + d.y) || W.isPortal(P.tx, P.ty) || portalInterior(P.tx, P.ty)) && canEnter(P, nx + d.x, ny + d.y) === 'walk') { nx += d.x; ny += d.y; dist = 2; }
  const how = canEnter(P, nx, ny);
  if (!how) {
    // walking into a cactus pricks (Minecraft: 1 damage, at most every half second)
    const cb = !P.riding && W.block(nx, ny), ci = cb && item(cb.id);
    if (ci && ci.block && ci.block.prick && !cb.flush) hurtPlayer(P, ci.block.prick, `${P.name} was pricked to death`);
    return false;
  }
  P.fromX = P.tx; P.fromY = P.ty; P.tx = nx; P.ty = ny; P.moving = true; P.prog = 0; P.dist = dist;
  P.sprinting = input.held('sprint') && P.food > 6 && how === 'walk';
  P.speed = how === 'boat' ? BOAT_T : how === 'swim' ? SWIM_T : P.sprinting ? SPRINT_T : WALK_T;
  // soul sand holds Steve back: 60% of his speed
  if (how === 'walk' && (W.mat(P.fromX, P.fromY) === 'soul_sand' || W.mat(nx, ny) === 'soul_sand')) P.speed /= 0.6;
  // a cobweb holds him far more: a quarter of his speed in and out of it
  const web = (X, Y) => { const b = W.block(X, Y); return b && b.id === 'cobweb'; };
  if (how === 'walk' && (web(P.fromX, P.fromY) || web(nx, ny))) P.speed /= (item('cobweb') && item('cobweb').block.slow) || 0.25;
  // a stray's arrow (5d): half his walking speed for a few seconds, sprinting or not
  if (how === 'walk' && P.slowT > 0) P.speed = Math.max(P.speed, WALK_T) * 2;
  if (dist === 2) { P.speed = 0.36; mc('step.grass', { vol: 0.3 }); }
  if (P.riding) { P.riding.fromX = P.riding.tx; P.riding.fromY = P.riding.ty; P.riding.tx = nx; P.riding.ty = ny; P.riding.dir = dir; if (Math.random() < 0.6) mc('paddle', { vol: 0.25 }); }
  if (how === 'swim') { if (!P.swimming) { mc('water_splash', { vol: 0.35 }); splash(nx * TILE + 8, ny * TILE + 10, 8); } mc('swim', { vol: 0.25 }); exhaust(P, 0.01); }
  if (P.sprinting) exhaust(P, 0.1);
  return true;
}
export function updateActor(P, dt) {
  if (!P.moving) { P.fx = P.tx; P.fy = P.ty; return false; }
  P.prog += dt / P.speed;
  if (P.prog >= 1) {
    P.prog = 0; P.moving = false; P.fx = P.tx; P.fy = P.ty; P.knocked = false;
    if (P.riding) { P.riding.fx = P.tx; P.riding.fy = P.ty; }
    return true;
  }
  P.fx = P.fromX + (P.tx - P.fromX) * P.prog; P.fy = P.fromY + (P.ty - P.fromY) * P.prog;
  if (P.riding) { P.riding.fx = P.fx; P.riding.fy = P.fy; }
  return false;
}
export function stepSound(P) {
  const W = G.world;
  if (P.swimming || P.riding) return;
  const b = W.block(P.tx, P.ty);
  const mat = W.mat(P.tx, P.ty);
  const nk = W.inNether(P.tx, P.ty) ? W.nInfo(P.tx, P.ty) : null;
  const nether = nk && ({ floor: 'step.netherrack', brick_floor: 'step.nether_bricks', soul_sand: 'step.soul_sand', soul_soil: 'step.soul_soil', magma_block: 'step.stone' })[nk[1]];
  const group = b && b.flush ? 'step.' + ((item(b.id) && item(b.id).block && item(b.id).block.sound) || 'gravel') : nether ? nether : mat === 'sand' || mat === 'snow' ? 'step.sand' : mat === 'mud' || mat === 'podzol' || mat === 'clay' ? 'step.gravel' : W.isGrass(P.tx, P.ty) || mat === 'tallgrass' ? 'step.grass' : 'step.stone';
  mc(group, { vol: 0.15, pitch: 1 });
}

// ---------------------------------------------------------------- using things (X)
export function useInFront(P) {
  const W = G.world, f = facing(P), b = W.block(f.x, f.y), held = G.inv.held;
  // The End's and the stronghold's things (portal frames, the dragon egg, end crystals on the exit portal, water on
  // an enderman) come first
  if (G.useHook && G.useHook(P, f, held, b)) return true;
  // blocks you right-click in Minecraft
  if (b && !b.flush) {
    if (b.id === 'crafting_table') { G.openScreen('craft'); return true; }
    if (b.id === 'furnace') { G.openScreen('furnace', b); return true; }
    if (b.id === 'chest') { mc('chest_open', { vol: 0.5 }); G.openScreen('chest', b); return true; }
    if (isDoor(b)) { b.open = !b.open; W.setBlock(f.x, f.y, b); mc(b.open ? 'door_open' : 'door_close', { vol: 0.6 }); return true; }
    if (b.id === 'white_bed') { G.useBed(f.x, f.y, b); return true; }
    if (b.id === 'tnt' && held && held.id === 'flint_and_steel') { primeTNT(f.x, f.y); mc('ignite'); if (G.inv.wearHeld(1)) toolBroke(P, held); return true; }
    if (b.id === 'oak_sign') { G.say(b.text || 'STEVE\'S HOUSE'); return true; }
    if (b.id === 'campfire') {
      // a shovel or water puts it out, flint and steel lights it, raw food goes on one of its four spots
      const t = held && toolOf(held);
      if (b.lit && t && t.kind === 'shovel') { b.lit = false; W.setBlock(f.x, f.y, b); mc('fizz', { vol: 0.5 }); if (G.inv.wearHeld(1)) toolBroke(P, held); return true; }
      if (b.lit && held && held.id === 'water_bucket') { b.lit = false; W.setBlock(f.x, f.y, b); G.inv.slots[G.inv.sel] = { id: 'bucket', n: 1 }; mc('fizz', { vol: 0.5 }); return true; }
      if (!b.lit && held && held.id === 'flint_and_steel') { b.lit = true; W.setBlock(f.x, f.y, b); mc('ignite'); if (G.inv.wearHeld(1)) toolBroke(P, held); return true; }
      if (held && campfireOf(held.id)) {
        const i = b.items.findIndex((s) => !s);
        if (i >= 0) { b.items[i] = { id: held.id, t: 0 }; W.touch(f.x, f.y); G.inv.useHeld(); P.placeT = 0.18; mc('dig.wood', { vol: 0.4, pitch: 1.4 }); }
        return true;
      }
    }
  }
  if (b && held && held.id === 'bone_meal' && (b.crop || isSapling(b.id))) { boneMeal(f.x, f.y, b); return true; }
  const boat = G.ents.find((e) => e.type === 'boat' && e.tx === f.x && e.ty === f.y);
  if (boat && !P.riding) { board(P, boat); return true; }
  if (P.riding) { if (canEnter({ ...P, riding: null }, f.x, f.y) === 'walk') { unboard(P, f); return true; } }
  const m = G.ents.find((e) => e.type === 'mob' && e.tx === f.x && e.ty === f.y && !e.dying);
  if (m && held && held.id === 'shears' && m.kind === 'sheep' && !m.sheared) {
    if (NET.g && m.nid != null) { NET.g.mobAct(m, 'shear'); mc('shear', { vol: 0.8 }); }   // co-op: the host shears its sheep and drops the wool
    else { m.sheared = true; mc('shear', { vol: 0.8 }); dropItem('white_wool', 1 + RNG.randInt(3), f.x * TILE, f.y * TILE); }
    if (G.inv.wearHeld(1)) toolBroke(P, held);
    return true;
  }
  if (m && held && held.id === 'bucket' && m.kind === 'cow') { G.inv.useHeld(); G.inv.add('milk_bucket'); mc('bucket_fill'); return true; }
  if (!held) return false;
  return useItem(P, held, f);
}
function boneMeal(x, y, b) {
  G.inv.useHeld();
  mc('bonemeal', { vol: 0.7 });
  for (let i = 0; i < 10; i++) particle({ x: x * TILE + 3 + Math.random() * 10, y: y * TILE + 2 + Math.random() * 10, z: 4, vz: 10, life: 0.8, color: '#7cf06a', size: 2 });
  if (b.crop) { b.crop.stage = Math.min(7, b.crop.stage + 2 + RNG.randInt(4)); G.world.setBlock(x, y, b); }
  else if (isSapling(b.id) && RNG.rand() < 0.6) G.growSapling(x, y);
}
function board(P, boat) {
  if (NET.on) NET.board(boat, true);   // co-op: one rider per boat (the host's word)
  P.riding = boat; P.swimming = false;
  P.fromX = P.tx; P.fromY = P.ty; P.tx = boat.tx; P.ty = boat.ty; P.moving = true; P.prog = 0; P.speed = 0.25; P.dist = 1;
  mc('step.wood', { vol: 0.4 });
}
function unboard(P, f) {
  const boat = P.riding;
  if (NET.on) NET.board(boat, false);
  boat.fx = boat.tx; boat.fy = boat.ty;
  P.riding = null;
  P.fromX = P.tx; P.fromY = P.ty; P.tx = f.x; P.ty = f.y; P.moving = true; P.prog = 0; P.speed = 0.25; P.dist = 1;
}
export function useItem(P, held, f) {
  const W = G.world, it = item(held.id);
  if (!it) return false;
  if (it.ball) { G.say(`OAK: ${G.myName || 'STEVE'}! This isn't the time to use that!`); return true; }
  // ender pearls, eyes of ender and end crystals (src/end.js)
  if (it.use === 'pearl' || it.use === 'eye' || it.use === 'end_crystal') return G.useEndItem ? !!G.useEndItem(P, held, f) : false;
  if (it.armor) {
    const slot = ['helmet', 'chestplate', 'leggings', 'boots'].indexOf(it.armor.slot);
    const old = G.inv.armor[slot];
    G.inv.armor[slot] = held; G.inv.slots[G.inv.sel] = old;
    mc(it.armor.mat === 'netherite' ? 'equip_netherite' : 'click', { vol: it.armor.mat === 'netherite' ? 0.6 : 0.2 });
    sfx.select();
    return true;
  }
  if (it.food) { P.using = 'eat'; P.useT = 0; return true; }
  if (held.id === 'bow') { if (G.inv.has('arrow')) { P.using = 'bow'; P.bowT = 0; } return true; }
  if (held.id === 'fishing_rod') { G.castRod(); return true; }
  if (held.id === 'oak_boat') {
    if (W.isWater(f.x, f.y) && noEntityAt(f.x, f.y)) { G.ents.push({ type: 'boat', tx: f.x, ty: f.y, fx: f.x, fy: f.y, dir: P.dir }); G.inv.useHeld(); mc('step.wood', { vol: 0.5 }); }
    return true;
  }
  if (held.id === 'bucket') {
    if (W.isWater(f.x, f.y)) { G.inv.useHeld(); if (G.inv.add('water_bucket')) G.dropStack({ id: 'water_bucket', n: 1 }); mc('bucket_fill', { vol: 0.7 }); return true; }
    if (W.isLava(f.x, f.y) && scoopLava(f.x, f.y)) {
      G.inv.useHeld(); if (G.inv.add('lava_bucket')) G.dropStack({ id: 'lava_bucket', n: 1 });
      mc('bucket_fill_lava', { vol: 0.7 });
      if (G.advance) G.advance('hot_stuff');
      return true;
    }
    return false;
  }
  if (held.id === 'lava_bucket') {
    if (!pourLava(f.x, f.y)) return false;
    G.inv.slots[G.inv.sel] = { id: 'bucket', n: 1 };
    mc('bucket_empty_lava', { vol: 0.7 });
    return true;
  }
  if (held.id === 'water_bucket') {
    // on lava it sets into obsidian; in the Nether anywhere else it boils away
    if (waterOn(f.x, f.y)) { G.inv.slots[G.inv.sel] = { id: 'bucket', n: 1 }; return true; }
    const b = W.block(f.x, f.y);
    if (b && b.bridge) return false;            // an End bridge is a floor over the void: water doesn't wash it away
    if (b && b.flush && b.under != null) { W.setTile(f.x, f.y, b.under); W.setBlock(f.x, f.y, null); }
    else if (W.isFloor(f.x, f.y) && !W.block(f.x, f.y) && !mobAt(f.x, f.y) && !W.noBreak(f.x, f.y) && !W.noPlace(f.x, f.y)) W.setTile(f.x, f.y, G.waterTile);
    else return false;
    G.inv.slots[G.inv.sel] = { id: 'bucket', n: 1 };
    mc('bucket_empty', { vol: 0.7 }); splash(f.x * TILE + 8, f.y * TILE + 10, 8);
    return true;
  }
  if (it.tool && it.tool.kind === 'hoe') {
    const m = W.mat(f.x, f.y);
    if (W.isFloor(f.x, f.y) && !W.block(f.x, f.y) && !W.noBreak(f.x, f.y) && !W.noPlace(f.x, f.y) && (W.isGrass(f.x, f.y) || m === 'tallgrass' || m === 'flower')) {
      if (m === 'tallgrass' || m === 'flower') W.setTile(f.x, f.y, W.groundFor(f.x, f.y));
      W.setBlock(f.x, f.y, { id: 'farmland', flush: true, flushLook: 'farmland', walk: true, drop: 'dirt' });
      mc('till', { vol: 0.7 });
      if (G.inv.wearHeld(1)) toolBroke(P, held);
      return true;
    }
    return false;
  }
  if (it.tool && it.tool.kind === 'shovel') {
    if (W.isFloor(f.x, f.y) && !W.block(f.x, f.y) && !W.noBreak(f.x, f.y) && !W.noPlace(f.x, f.y) && W.isGrass(f.x, f.y)) {
      W.setBlock(f.x, f.y, { id: 'dirt_path', flush: true, flushLook: 'dirt_path', walk: true, drop: 'dirt' });
      mc('dig.gravel', { vol: 0.5 });
      if (G.inv.wearHeld(1)) toolBroke(P, held);
      return true;
    }
    return false;
  }
  if (held.id === 'flint_and_steel' || held.id === 'fire_charge') {
    // a fire charge is used up; flint and steel wears
    const spend = () => { if (held.id === 'fire_charge') G.inv.useHeld(); else if (G.inv.wearHeld(1)) toolBroke(P, held); };
    if (lightPortal(f.x, f.y, P.dir)) { spend(); return true; }
    if (W.isFloor(f.x, f.y) && !W.block(f.x, f.y) && !W.noPlace(f.x, f.y)) {
      W.setBlock(f.x, f.y, { id: 'fire', walk: true, t: 0 });
      mc(held.id === 'fire_charge' ? 'fireball' : 'ignite', { vol: held.id === 'fire_charge' ? 0.8 : 1 });
      spend();
      return true;
    }
    return false;
  }
  if (it.plant === 'soul_sand') {
    // nether wart takes root in soul sand
    if (W.mat(f.x, f.y) === 'soul_sand' && !W.block(f.x, f.y) && !W.noPlace(f.x, f.y) && !mobAt(f.x, f.y)) {
      W.setBlock(f.x, f.y, { id: 'nether_wart', stage: 0, walk: true }); G.inv.useHeld(); mc('dig.soul_sand', { vol: 0.5 }); if (G.onPlant) G.onPlant(); return true;
    }
    return false;
  }
  if (held.id === 'bone_meal') {
    const b = W.block(f.x, f.y);
    if (b && (b.crop || isSapling(b.id))) { boneMeal(f.x, f.y, b); return true; }
    if (W.isGrass(f.x, f.y) && !b && !W.noBreak(f.x, f.y) && !W.noPlace(f.x, f.y)) {
      G.inv.useHeld(); mc('bonemeal', { vol: 0.7 });
      for (let i = 0; i < 6; i++) {
        const x = f.x + RNG.randInt(5) - 2, y = f.y + RNG.randInt(5) - 2;
        if (W.isFloor(x, y) && W.isGrass(x, y) && !W.block(x, y) && !W.noBreak(x, y) && !W.noPlace(x, y) && cellFree(x, y) && !(x === P.tx && y === P.ty)) W.setBlock(x, y, { id: RNG.rand() < 0.5 ? 'poppy' : 'dandelion', walk: true });
      }
      return true;
    }
    return false;
  }
  if (held.id === 'wheat_seeds') {
    const b = W.block(f.x, f.y);
    if (b && b.id === 'farmland' && !b.crop) { W.setBlock(f.x, f.y, { ...b, crop: { stage: 0, t: 0 } }); G.inv.useHeld(); mc('dig.grass', { vol: 0.5 }); if (G.onPlant) G.onPlant(); return true; }
    return false;
  }
  if (it.block) return placeBlock(P, held, f);
  return false;
}
// Put the held block down in front of Steve.
export function placeBlock(P, held, f) {
  const W = G.world, it = item(held.id), spec = it.block;
  const x = f.x, y = f.y;
  if (!W.inside(x, y) || mobAt(x, y) || (P.tx === x && P.ty === y)) return false;
  if (G.ents.some((e) => (e.type === 'boat' || e.type === 'tnt') && e.tx === x && e.ty === y)) return false;
  // never on a person, or on the spot a person of the room stands on
  if ((G.npcAt && G.npcAt(x, y)) || npcHome(x, y)) return false;
  // a building door goes back into its own doorway
  if (W.doorAt(x, y)) {
    if (!spec.style || !W.closeDoor(x, y, spec.style)) return false;
    G.inv.useHeld();
    mc('door_close', { vol: 0.6 });
    P.placeT = 0.18;
    if (G.onPlace) G.onPlace(held.id, x, y);
    return true;
  }
  if (W.noPlace(x, y)) return false;
  const existing = W.block(x, y);
  let rec = null;
  if (existing && (existing.id === 'end_portal_frame' || existing.id === 'end_portal' || existing.id === 'dragon_egg')) return false;
  if (W.isEndVoid(x, y)) {
    // The End: a full block put over the void becomes a bridge, floor of that block Steve can walk on
    if (spec.look !== 'raised' || existing) return false;
    const under = W.tile(x, y), t = W.endFloorTile(x, y, held.id === 'obsidian' ? 'obsidian' : 'end_stone');
    if (t == null) return false;
    W.setTile(x, y, t);
    W.setBlock(x, y, { id: held.id, flush: true, walk: true, under, bridge: true });
    W.reedgeEnd(x, y);
    G.inv.useHeld();
    mc('dig.' + (spec.sound || 'stone'), { vol: 0.8, pitch: 0.8 });
    P.placeT = 0.18;
    if (G.onPlace) G.onPlace(held.id, x, y);
    return true;
  }
  if (W.isWater(x, y) && spec.plant === 'water') {
    // a lily pad floats on water (never on another block)
    if (existing) return false;
    rec = { id: held.id, walk: true };
  } else if (spec.plant === 'water') return false;
  else if (W.isWater(x, y)) {
    if (spec.look !== 'raised' || spec.see || spec.plant) return false;
    // a block dropped into water fills it to the brim: a floor you can walk on, like a Minecraft bridge
    rec = { id: held.id, flush: true, walk: true, under: W.tile(x, y) };
  } else {
    if (!W.isFloor(x, y) || (existing && !(existing.walk && !existing.crop && existing.id !== 'farmland' && existing.id !== 'dirt_path' && existing.id !== 'nether_portal' && existing.id !== 'nether_wart'))) return false;
    if (spec.plant && spec.plant !== 'water' && !W.plantOk(x, y, spec.plant)) {
      // generated layouts say why (4.5); Classic refuses quietly, as it always has
      if (W.layout.gen && G.toast) G.toast("It won't grow here.");
      return false;
    }
    if (W.mat(x, y) === 'tallgrass' || W.mat(x, y) === 'flower') W.setTile(x, y, W.groundFor(x, y));
    rec = { id: held.id };
    if (existing && existing.bridge) rec.onBridge = existing;        // built on an End bridge: the bridge stays under it
    if (spec.walk) rec.walk = true;
    if (held.id === 'furnace') Object.assign(rec, { input: null, fuel: null, output: null, burn: 0, burnMax: 0, cook: 0, xp: 0 });
    if (held.id === 'chest') rec.slots = new Array(27).fill(null);
    if (isSapling(held.id)) rec.t = 0;
    if (held.id === 'campfire') Object.assign(rec, { lit: true, items: [null, null, null, null] });
    if (spec.use === 'door') rec.open = false;
    if (held.id === 'white_bed') {
      const d = DIRS[P.dir], hx = x + d.x, hy = y + d.y;
      if (!W.isFloor(hx, hy) || W.block(hx, hy) || mobAt(hx, hy) || W.noPlace(hx, hy) || W.noBreak(hx, hy)) return false;
      rec = { id: 'white_bed', orient: P.dir, part: 'foot', other: [hx, hy] };
      W.setBlock(hx, hy, { id: 'white_bed', orient: P.dir, part: 'head', other: [x, y] });
    }
  }
  W.setBlock(x, y, rec);
  G.inv.useHeld();
  mc('dig.' + (spec.sound || 'stone'), { vol: 0.8, pitch: 0.8 });
  P.placeT = 0.18;
  if (G.onPlace) G.onPlace(held.id, x, y);
  return true;
}
export function finishEating(P) {
  const held = G.inv.held, fd = foodOf(held);
  if (!fd) return;
  if (fd.milk) { P.hungerEffect = 0; P.poisoned = false; G.inv.slots[G.inv.sel] = { id: 'bucket', n: 1 }; mc('drink'); return; }
  P.food = Math.min(20, P.food + fd.hunger);
  P.sat = Math.min(P.food, P.sat + fd.sat);
  if (fd.hungerEffect && RNG.rand() < fd.hungerEffect) P.hungerEffect = 600;
  if (fd.regen) { P.regen = 100; P.absorb = Math.max(P.absorb, fd.absorb); }
  G.inv.useHeld();
  mc('burp', { vol: 0.5, pitch: 0.9 + Math.random() * 0.2 });
  if (G.onEat) G.onEat(held.id);
}
export function canEat(P) { const fd = foodOf(G.inv.held); return fd && (P.food < 20 || fd.regen || fd.milk); }
export function releaseBow(P) {
  const draw = Math.min(1, P.bowT / 1.0);
  P.using = null;
  if (draw < 0.15 || !G.inv.has('arrow')) return;
  G.inv.spend('arrow', 1);
  const dmg = Math.round(1 + draw * 5 + (draw >= 1 ? RNG.randInt(3) : 0));
  shootArrow(P, P.dir, dmg, true, 0.5 + draw * 0.5);
  const held = G.inv.held;
  if (G.inv.wearHeld(1)) toolBroke(P, held);
}

// ---------------------------------------------------------------- sleeping
export function sleep(P, bed) { P.sleeping = bed; P.prevSpot = { x: P.tx, y: P.ty, dir: P.dir }; }
export function wake(P) {
  if (!P.sleeping) return;
  P.sleeping = null;
  if (P.prevSpot) placePlayer(P, P.prevSpot.x, P.prevSpot.y, P.prevSpot.dir);
}

// ---------------------------------------------------------------- drawing
const S = () => A.items.steve;
export function steveFrame(P, held = G.inv.held) {
  const st = S();
  const pick = (pose, dir, i) => { const p = st.poses[pose]; const d = p[dir] || p.down; return d[Math.min(i, d.length - 1)]; };
  if (P.dead) return pick('death', 'down', Math.min(3, Math.floor(P.deathT / 0.1)));
  if (P.sleeping) return pick('sleep', 'down', 0);
  const walkIdx = P.moving ? [0, 1, 0, 2][Math.floor(P.prog * 4) % 4] : 0;
  if (P.riding) return pick('boat', P.dir, P.moving ? Math.floor(G.clock * 4) % 2 : 0);
  if (P.using === 'eat') return pick('eat', P.dir, Math.floor(P.useT * 8) % 2);
  if (P.using === 'bow') return pick('aim', P.dir, 0);
  if (P.swingT > 0) return pick('swing', P.dir, Math.min(2, Math.floor(P.swingT / 0.3 * 3)));
  if (P.placeT > 0) return pick('place', P.dir, 0);
  if (held) return pick('hold', P.dir, walkIdx);
  return pick('walk', P.dir, walkIdx);
}
const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
// look (co-op, src/net/skins.js): another player's skin and gear, { key, img, heldUv, armorImgs, hands, held,
// armor }. Without it this draws this page's own Steve from A.mc and G.inv, as single-player always has.
export function drawSteve(ctx, P, cam, look) {
  if (!P.visible) return;
  const st = S();
  const held = look ? look.held : G.inv.held;
  const f = steveFrame(P, look ? held : undefined);
  const lift = P.z + (P.moving && P.dist === 2 && !frameHop(P) ? Math.sin(P.prog * Math.PI) * 8 : 0);
  let x = P.fx * TILE + 8 - st.origin[0] - cam.x, y = P.fy * TILE + FOOT - st.origin[1] - cam.y - lift;
  if (P.sleeping) { x = P.sleeping.hx * TILE + 8 - st.origin[0] - cam.x; y = P.sleeping.hy * TILE + 14 - st.origin[1] - cam.y; }
  // seated in the hull: broadside, the long near wall is in front of him, so he sits higher to show over it
  if (P.riding) y += P.riding.dir === 'left' || P.riding.dir === 'right' ? -3 : 3;
  const [hx, hy, behind, tx, ty] = ((look && look.hands) || st.hands)[f];
  const handX = x + hx, handY = y + hy;
  P.handX = handX + cam.x; P.handY = handY + cam.y;
  // the held item's far end (the fishing line leaves the rod's tip)
  P.tipX = tx != null ? x + tx + cam.x : null; P.tipY = ty != null ? y + ty + cam.y : null;
  const cube = held && heldAsCube(held);
  const drawItem = () => {
    if (!held || P.dead || P.sleeping || P.riding) return;
    if (cube) { drawHeldCube(ctx, held, handX, handY, P); return; }
    const layer = heldLayer(f, held.id, look);
    if (!layer) return;
    ctx.save();
    if (P.swimming) { ctx.beginPath(); ctx.rect(x - 4, y - 4, st.w + 8, st.h - 9 + 4); ctx.clip(); }
    const pad = st.heldPad || 0;
    ctx.drawImage(layer, Math.round(x) - pad, Math.round(y) - pad, st.w + 2 * pad, st.h + 2 * pad);
    ctx.restore();
  };
  // shadow (not while swimming)
  if (!P.swimming && !P.sleeping) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(Math.round(P.fx * TILE + 8 - cam.x), Math.round(P.fy * TILE + FOOT - cam.y), 6 - Math.min(2, lift / 6), 2.2, 0, 0, Math.PI * 2); ctx.fill();
  }
  // blocks are a small cube in the fist, behind him when the hand is; everything else is drawn from the
  // frame's item map, which already leaves out whatever his body hides
  if (behind && cube) drawItem();
  ctx.save();
  if (P.swimming) { ctx.beginPath(); ctx.rect(x - 4, y - 4, st.w + 8, st.h - 9 + 4); ctx.clip(); }
  const red = P.hurtFlash > 0.25 || P.dead ? 0.55 : 0;
  ctx.save();
  if (P.sleeping) {
    // lying down: the standing frame turned onto its back, head on the pillow
    ctx.translate(Math.round(x + st.origin[0]), Math.round(y + st.origin[1] - 8));
    ctx.rotate(P.sleeping.orient === 'left' ? -Math.PI / 2 : P.sleeping.orient === 'right' ? Math.PI / 2 : P.sleeping.orient === 'down' ? Math.PI : 0);
    ctx.translate(-st.origin[0], -st.origin[1] + 8);
    drawSteveLayers(ctx, f, 0, 0, red, look);
  } else drawSteveLayers(ctx, f, x, y, red, look);
  ctx.restore();
  ctx.restore();
  if (!(behind && cube)) drawItem();
  drawGrassOver(ctx, P.tx, P.ty, P.moving, cam);
  if (P.swimming) {
    // FireRed's surf ripple at the waterline
    const wy = Math.round(y + st.h - 10), wx = Math.round(P.fx * TILE + 8 - cam.x);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    const ph = Math.floor(G.clock * 4) % 2;
    ctx.fillRect(wx - 7 - ph, wy, 4, 1); ctx.fillRect(wx + 3 + ph, wy, 4, 1); ctx.fillRect(wx - 3, wy + 2, 6, 1);
  }
}
// FireRed covers the legs of anyone standing in tall grass with the grass field effect.
export function drawGrassOver(ctx, tx, ty, moving, cam) {
  if (moving || !G.world.tallGrass(tx, ty)) return;
  ctx.drawImage(A.img.fxTallGrass, 0, 0, 16, 16, Math.round(tx * TILE - cam.x), Math.round(ty * TILE - cam.y + 4), 16, 12);
}
function drawSteveLayers(ctx, f, x, y, red, look) {
  const st = S();
  drawFrameLocal(ctx, look ? look.img : A.mc.steve, f, st.w, st.h, x, y, red, look ? look.key : null);
  const armor = look ? look.armor || [] : G.inv.armor;
  ARMOR_PIECES.slice().reverse().forEach((piece) => {
    const a = armor[ARMOR_PIECES.indexOf(piece)];
    if (!a) return;
    const mat = item(a.id).armor.mat;
    const img = look && look.armorImgs ? look.armorImgs[`${mat}_${piece}`] : A.mc[`armor_${mat}_${piece}`];
    if (img) ctx.drawImage(img, f * st.w, 0, st.w, st.h, Math.round(x), Math.round(y), st.w, st.h);
  });
}
const redCache = new Map();
function drawFrameLocal(ctx, img, f, w, h, x, y, red, key = null) {
  ctx.drawImage(img, f * w, 0, w, h, Math.round(x), Math.round(y), w, h);
  if (red > 0) {
    const k = key == null ? f : key + ':' + f;
    let c = redCache.get(k);
    if (!c) { c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, f * w, 0, w, h, 0, 0, w, h); g.globalCompositeOperation = 'source-atop'; g.fillStyle = '#ff2020'; g.fillRect(0, 0, w, h); redCache.set(k, c); }
    ctx.globalAlpha = red; ctx.drawImage(c, Math.round(x), Math.round(y)); ctx.globalAlpha = 1;
  }
}
// co-op: a guest's own Steve takes its skin's sheets in A.mc (src/net/skins.js), so the frames cut from the
// old ones are dropped
export function resetSteveArt() { redCache.clear(); heldCache.clear(); uvPixelsOf.clear(); }
// The held item at Steve's hand: tools are held by the handle and tilt through the swing, blocks are
// carried as small cubes. Drawn at full resolution (an 8x8 GBA-pixel item is 16x16 canvas pixels).
const heldAsCube = (s) => { const it = item(s.id); return !!(it && it.block && (it.block.look === 'raised' || it.block.look === 'chest')); };
function drawHeldCube(ctx, s, hx, hy, P) {
  const i = item(s.id).iconIndex;
  ctx.save();
  ctx.translate(hx, hy);
  if (P.dir === 'left' || P.dir === 'down') ctx.scale(-1, 1);
  ctx.drawImage(A.mc.icons, (i % 32) * 16, Math.floor(i / 32) * 16, 16, 16, -3, -6, 7, 7);
  ctx.restore();
}
// A held item as Minecraft draws it: the 16x16 sprite gripped in his right fist, following the arm. The
// build ray-casts that plane against each frame (held_uv.png, two pixels per GBA pixel): each covered
// pixel stores which item texel lands there and how lit it is, so any item paints through the same map.
// Its frames reach heldPad GBA pixels past Steve's on every side, for a tool held out at his side.
const heldCache = new Map(), iconPixels = new Map(), uvPixelsOf = new Map();
function heldLayer(f, id, look) {
  const key = look ? look.key + ':' + f + ':' + id : f + ':' + id;
  if (heldCache.has(key)) return heldCache.get(key);
  const uv = look ? look.heldUv : A.mc.heldUv, it = item(id);
  if (!uv || !it) return null;
  let uvPixels = uvPixelsOf.get(uv);
  if (!uvPixels) {
    const c = document.createElement('canvas'); c.width = uv.width; c.height = uv.height;
    const g = c.getContext('2d'); g.drawImage(uv, 0, 0); uvPixels = g.getImageData(0, 0, uv.width, uv.height).data;
    uvPixelsOf.set(uv, uvPixels);
  }
  let ic = iconPixels.get(id);
  if (!ic) {
    const c = document.createElement('canvas'); c.width = 16; c.height = 16;
    const g = c.getContext('2d'), i = it.iconIndex;
    g.drawImage(A.mc.icons, (i % 32) * 16, Math.floor(i / 32) * 16, 16, 16, 0, 0, 16, 16);
    ic = g.getImageData(0, 0, 16, 16).data; iconPixels.set(id, ic);
  }
  const st = S(), pad = st.heldPad || 0, W = (st.w + 2 * pad) * 2, H = (st.h + 2 * pad) * 2;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), out = g.createImageData(W, H);
  // an axe or hoe is mirrored across its handle so the blade leads the swing (see bladeSided)
  const flip = bladeSided(id);
  let any = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const si = (y * uv.width + f * W + x) * 4;
    if (uvPixels[si + 3] < 128) continue;
    const u = uvPixels[si] >> 4, v = uvPixels[si + 1] >> 4;
    const ti = (flip ? (15 - u) * 16 + (15 - v) : v * 16 + u) * 4;
    if (ic[ti + 3] < 128) continue;
    const lit = uvPixels[si + 2] / 255, o = (y * W + x) * 4;
    out.data[o] = ic[ti] * lit; out.data[o + 1] = ic[ti + 1] * lit; out.data[o + 2] = ic[ti + 2] * lit; out.data[o + 3] = 255;
    any = true;
  }
  g.putImageData(out, 0, 0);
  const layer = any ? c : null;
  heldCache.set(key, layer);
  return layer;
}
export function drawCrack(ctx, P, cam) {
  const st = crackStage(P);
  if (st < 0 || !P.mining) return;
  const m = P.mining;
  const x = m.x * TILE - cam.x, y = m.y * TILE - cam.y;
  ctx.globalAlpha = 0.75;
  if (m.kind === 'block' && m.block && !m.block.flush && blockLook(m.block.id) != null) {
    ctx.drawImage(A.mc.destroy, st * 16, 0, 16, 16, Math.round(x), Math.round(y), 16, 16);
    ctx.drawImage(A.mc.destroy, st * 16, 0, 16, 7, Math.round(x), Math.round(y - 7), 16, 7);
  } else ctx.drawImage(A.mc.destroy, st * 16, 0, 16, 16, Math.round(x), Math.round(y), 16, 16);
  ctx.globalAlpha = 1;
  void drawLook;
}
export { OPP, poof, sfx };
