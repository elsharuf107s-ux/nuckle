// The Ender Dragon's fight in The End: its phases (circling the pillars, strafing with fireballs, charging, perching
// on the exit fountain to breathe, exhaustion), the end crystals that heal it (and their cages and explosions),
// dragon's breath clouds, the boss bar, the death sequence, the shared ending (exit portal, egg, XP, advancements)
// and the respawn ritual. Its sprites are pre-rendered by tools/build_end_assets.py (items.json end).
// Positions are in cells (x, y: the ground point under the body, cell centres at whole numbers, as mobs);
// alt is its height above the ground in GBA pixels. State that outlives a visit is G.end.dragon (saved).
import { A } from './assets.js';
import { G, TILE, DIRS, dirTo } from './game.js';
import { mc } from './audio.js';
import * as E from './entities.js';
import { toolOf } from './items.js';
import { mcText, mcWidth } from './mcfont.js';
import { NET } from './net/flag.js';   // co-op: false in single-player (the host flies the dragon; guests draw it)

const W = () => G.world;
const N = () => G.world.end;
export const MAX_HP = 200, EXHAUST_HP = 50, HEAL_RANGE = 16;
const TAU = Math.PI * 2;
const rnd = () => Math.random();

let D = null;                 // the live dragon (while Steve is in The End)
const clouds = [];            // dragon's breath: { x, y (cell), r (cells), t, life, hurtT }
const balls = [];             // dragon fireballs: { x, y, z (px), vx, vy, tx, ty, t }
let death = null;             // the death sequence: { t, xp, given, first }
let ritual = null;            // the respawn ritual: { t, step }
let flash = 0;                // a crystal's white flash
let eggShow = 0;              // after the first dragon: the view leans to the egg on the pillar for a moment

export function reset() { D = null; clouds.length = 0; balls.length = 0; death = null; ritual = null; eggShow = 0; G.camFocus = null; }
export const busy = () => !!death || !!ritual;
export const dying = () => !!death;
export const ritualOn = () => !!ritual;
// the boss bar is up (main.js moves the advancement toasts below it)
export const cloudCells = () => clouds.map((c) => [c.x, c.y]);   // for the tests
export const bossBarShown = () => !!death || (!!D && S().alive);
const S = () => G.end.dragon;
function centre() { const f = N().fountain.centre; return { x: f[0], y: f[1] }; }
const steveIn = () => !!N() && (NET.on && NET.h ? NET.h.anyIn('end') : W().inEnd(G.P.tx, G.P.ty));
// co-op: the player it is after, picked at its decision points (the nearest one on the island it can hurt);
// single-player: Steve
let TG = null;
function tgt() {
  if (!NET.on || !NET.h) return G.P;
  if (!TG || !NET.h.dragonOk(TG)) TG = NET.h.dragonTarget(D, N().island);
  return TG || G.P;
}
// Steve on the island and in reach of an attack (not on the platform, dead, or knocked out of the world)
function steveTarget() {
  const P = tgt();
  if (!steveIn() || P.dead || P.voidFall) return false;
  if (NET.on && !(NET.h && NET.h.dragonOk(P))) return false;
  const I = N().island;
  return Math.hypot(P.tx - I.cx, P.ty - I.cy) <= I.r + 1;
}
// co-op: hurt one player (the host's own Steve as single-player does; a guest gets a 'hit' with its knockback)
function hurtOne(p, dmg, cause, text, from, kn) {
  if (p === G.P) { p.invuln = 0; G.hurtPlayer(dmg, text, from, false, from ? undefined : { noKnock: true }); if (kn) knock(kn[0], kn[1], kn[2]); return; }
  NET.hurt(p, dmg, cause, from, false, from ? {} : { noKnock: true }, { inv0: 1, kn: kn || 0 });
}

// ---------------------------------------------------------------- the live dragon
export function ensure() {
  if (D || !S().alive || !N()) return D;
  const c = centre();
  D = { x: c.x + 24, y: c.y + 2, alt: 60, vx: 0, vy: -6, ang: -Math.PI / 2, heading: 12, phase: 'circle', t: 0, decide: 5 + rnd() * 4,
    flap: 0, hurt: 0, perchDmg: 0, healT: 0, healer: null, wingT: 0, growlT: 4, hit: false, alpha: 1, breathT: 3, roarT: 6 };
  if (S().exhausted) { Object.assign(D, { x: c.x, y: c.y, alt: 0, phase: 'exhausted' }); D.heading = headingTo(c, tgt()); }
  return D;
}
export const live = () => D;
export function state() {
  const s = S();
  return { alive: s.alive, hp: s.hp, exhausted: s.exhausted, phase: D ? D.phase : s.alive ? 'away' : 'gone', x: D && D.x, y: D && D.y, alt: D && D.alt,
    heading: D && D.heading, healer: D && D.healer, crystals: G.end.crystals.map((c) => (c.alive ? (c.cage ? 'caged' + c.cage : 'alive') : 'dead')),
    clouds: clouds.length, fireballs: balls.length, death: death ? death.t : null, ritual: ritual ? ritual.t : null, exitActive: G.end.exitActive, kills: G.end.kills,
    target: TG ? (TG === G.P ? 0 : TG.slot) : null };
}
function headingOf(vx, vy) { return ((Math.round(Math.atan2(vy, vx) / (TAU / 16)) % 16) + 16) % 16; }
function headingTo(a, b) { return headingOf((b.tx ?? b.x) - a.x, (b.ty ?? b.y) - a.y); }
// steer toward (tx, ty) at `speed` cells/s, turning at most `turn` rad/s
function steer(tx, ty, speed, turn, dt) {
  const cur = Math.atan2(D.vy, D.vx), want = Math.atan2(ty - D.y, tx - D.x);
  let da = ((want - cur + Math.PI * 3) % TAU) - Math.PI;
  da = Math.max(-turn * dt, Math.min(turn * dt, da));
  const a = cur + da, sp = Math.hypot(D.vx, D.vy), ns = sp + (speed - sp) * Math.min(1, dt * 2);
  D.vx = Math.cos(a) * ns; D.vy = Math.sin(a) * ns;
  D.x += D.vx * dt; D.y += D.vy * dt;
  D.heading = headingOf(D.vx, D.vy);
}
const toAlt = (alt, k, dt) => { D.alt += (alt - D.alt) * Math.min(1, dt * k); };
function nearVol(x, y) { const P = G.P; return Math.max(0.08, 1 - Math.hypot(x - P.fx, y - P.fy) / 30); }
// the head: about 2.6 cells ahead of the body along its heading
// its mouth, where the head is drawn (on the ground a head turned toward the camera is drawn a little aside)
function head() { const a = shownHeading() * TAU / 16; return { x: D.x + Math.cos(a) * 2.6, y: D.y + Math.sin(a) * 2.6, a }; }
// Is its body (drawn D.alt px above its ground point) within dx cells across and dyPx pixels up or down of Steve?
// The view is 15 by 10 cells round him.
function inView(P, dx, dyPx) { return Math.abs(D.x - P.fx) <= dx && Math.abs((D.y - P.fy) * TILE - D.alt - 20) <= dyPx; }

function go(phase, extra = {}) { D.phase = phase; D.t = 0; Object.assign(D, extra); }
export function update(dt, state) {
  if (NET.guest) { netVisual(dt); return; }   // co-op guest: the host's dragon, drawn from its packets
  flash = Math.max(0, flash - dt * 3);
  updateClouds(dt);
  updateBalls(dt);
  if (ritual) updateRitual(dt);
  if (eggShow > 0) {
    // the egg has just appeared on the fountain's pillar: the view leans up to it (Steve kept in view)
    eggShow -= dt;
    const N0 = N(), e = N0 && N0.fountain.egg, k0 = G.camFocus && G.camFocus.egg ? G.camFocus.k : 0;
    if (e && G.end.egg === 'pillar' && steveIn() && Math.hypot(G.P.fx - N0.fountain.centre[0], G.P.fy - N0.fountain.centre[1]) < 14) {
      G.camFocus = { x: e[0], y: e[1] - 14, k: eggShow > 0.8 ? Math.min(1, k0 + dt * 2) : Math.max(0, eggShow / 0.8), clamp: true, loose: true, egg: true };
    } else eggShow = 0;
    if (eggShow <= 0 && G.camFocus && G.camFocus.egg) G.camFocus = null;
  }
  // a set piece over: the view eases back to Steve
  if (!ritual && !death && !(eggShow > 0) && G.camFocus) { G.camFocus.k -= dt / 0.8; if (G.camFocus.k <= 0) G.camFocus = null; }
  if (death) { updateDeath(dt); return; }
  if (!S().alive) { D = null; return; }
  if (!steveIn()) { D = null; return; }
  ensure();
  if (!NET.on && state !== 'play' && state !== 'screen') return;   // (co-op: it flies on for the others)
  D.t += dt; D.flap += dt; D.hurt = Math.max(0, D.hurt - dt); D.invuln = Math.max(0, (D.invuln || 0) - dt);
  const P = tgt(), c = centre();
  // sounds: the wings while it flies, a growl now and then
  const flying = !['perch', 'breathWind', 'breath', 'exhausted', 'descend'].includes(D.phase);
  D.wingT -= dt;
  if (flying && D.wingT <= 0) { D.wingT = 1.1 + rnd() * 0.4; mc('dragon.wings', { vol: 0.55 * nearVol(D.x, D.y) }); }
  D.growlT -= dt;
  if (D.growlT <= 0) { D.growlT = 8 + rnd() * 8; mc('dragon.growl', { vol: 0.7 * nearVol(D.x, D.y), pitch: 0.9 + rnd() * 0.2 }); }
  // the crystals heal it (not once exhausted)
  heal(dt);
  if (S().hp <= EXHAUST_HP && !S().exhausted && !['toRest', 'exhausted'].includes(D.phase)) exhaust();
  switch (D.phase) {
    case 'circle': {
      const a = Math.atan2(D.y - c.y, D.x - c.x) + 0.4;
      steer(c.x + Math.cos(a) * 25, c.y + Math.sin(a) * 25, 6, 1.8, dt);
      toAlt(58 + Math.sin(D.t * 0.8) * 6, 1, dt);
      D.decide -= dt;
      if (D.decide <= 0) {
        if (NET.on) TG = null;   // co-op: it picks whom to go for now
        if (!steveTarget()) { D.decide = 2; break; }
        const n = aliveCrystals();
        if (rnd() < 1 / (n + 3)) go('land');
        else go('approach', { next: rnd() < 0.62 ? 'strafe' : 'charge', side: null, lock: null });
      }
      break;
    }
    case 'approach': {
      // it first swings in beside Steve, into his view, so the wind-up is something he can see
      if (!steveTarget()) { go('circle', { decide: 3 }); break; }
      if (D.side == null) D.side = Math.sign(D.x - P.fx) || 1;
      steer(P.fx + D.side * 6, P.fy + 2.4, 9, 2.6, dt);
      toAlt(44, 1.5, dt);
      if (inView(P, 6.5, 52) || D.t > 6) {
        go('windup', { next: D.next });
        mc('dragon.growl', { vol: 1, pitch: D.next === 'charge' ? 0.8 : 1 });
      }
      break;
    }
    case 'windup': {
      // the tell, in view: it all but stops, swings its head round to Steve and roars before it comes. Halfway
      // through it fixes on where he stands, and that is where the charge or the fireball goes: a step aside
      // after that, before it comes, gets him out of the way.
      if (D.t >= 0.6 && !D.lock) D.lock = { x: P.fx, y: P.fy };
      const aim = D.lock || P;
      steer(aim.x ?? aim.fx, aim.y ?? aim.fy, 1.2, 3.2, dt);
      D.heading = D.lock ? headingOf(D.lock.x - D.x, D.lock.y - D.y) : headingTo(D, P);
      toAlt(40, 1.5, dt);
      if (D.t >= 1.2) {
        if (!steveTarget()) { go('circle', { decide: 3, lock: null }); break; }
        const L = D.lock || { x: P.fx, y: P.fy };
        D.lock = null;
        if (D.next === 'charge') {
          const dx = L.x - D.x, dy = L.y - D.y, d = Math.hypot(dx, dy) || 1;
          go('charge', { dir: { x: dx / d, y: dy / d }, target: { x: L.x, y: L.y }, hit: false });
          D.vx = D.dir.x * 4; D.vy = D.dir.y * 4;
        } else go('strafe', { fired: false, aimAt: L });
      }
      break;
    }
    case 'strafe': {
      steer(P.fx, P.fy, 9, 2.4, dt);
      toAlt(40, 1.5, dt);
      const d = Math.hypot(P.fx - D.x, P.fy - D.y);
      if (!D.fired && (d <= 10 || D.t > 5)) { D.fired = true; fireball(D.aimAt); go('away'); }
      break;
    }
    case 'charge': {
      // a straight dive through where Steve stood when it set off (slow to start, so a quick step aside beats it)
      const sp = Math.min(14, 4 + D.t * 10);
      D.vx = D.dir.x * sp; D.vy = D.dir.y * sp;
      D.x += D.vx * dt; D.y += D.vy * dt; D.heading = headingOf(D.vx, D.vy);
      const along = (D.x - D.target.x) * D.dir.x + (D.y - D.target.y) * D.dir.y;
      toAlt(along < -1 ? 10 : 30, 2.2, dt);
      if (NET.on) {
        // co-op: whoever it flies through (not only the one it went for)
        if (!D.hit && D.alt < 26) for (const p of NET.players()) {
          if (!NET.h || !NET.h.dragonOk(p) || Math.hypot(p.fx - D.x, p.fy - D.y) >= 1.8) continue;
          D.hit = true;
          if (NET.near(D.x, D.y)) mc('dragon.growl', { vol: 1, pitch: 1.2 });
          hurtOne(p, 10, ['dragon'], `${p.name} was slain by Ender Dragon`, null, [D.dir.x + (p.fx - D.x) * 0.5, D.dir.y + (p.fy - D.y) * 0.5, 3]);
          break;
        }
      } else if (!D.hit && D.alt < 26 && Math.hypot(P.fx - D.x, P.fy - D.y) < 1.8 && !P.dead && !P.voidFall) {
        D.hit = true;
        mc('dragon.growl', { vol: 1, pitch: 1.2 });
        P.invuln = 0;
        G.hurtPlayer(10, `${P.name} was slain by Ender Dragon`, null, false, { noKnock: true });
        knock(D.dir.x + (P.fx - D.x) * 0.5, D.dir.y + (P.fy - D.y) * 0.5, 3);
      }
      if (along > 7 || D.t > 4) go('away');
      break;
    }
    case 'away': {
      // carry on outward, climbing, then back to the circle
      const a = Math.atan2(D.y - c.y, D.x - c.x);
      steer(c.x + Math.cos(a) * 27, c.y + Math.sin(a) * 27, 8, 1.4, dt);
      toAlt(58, 1, dt);
      if (D.t > 2) go('circle', { decide: 6 + rnd() * 5 });
      break;
    }
    case 'land': case 'toRest': {
      steer(c.x, c.y, 6, 2.6, dt);
      toAlt(30, 1, dt);
      if (Math.hypot(c.x - D.x, c.y - D.y) < 1.6) go('descend', { from: { x: D.x, y: D.y, alt: D.alt }, rest: D.phase === 'toRest' });
      if (D.t > 12) { D.x = c.x; D.y = c.y; }
      break;
    }
    case 'descend': {
      const k = Math.min(1, D.t / 1.2);
      D.x = D.from.x + (c.x - D.from.x) * k; D.y = D.from.y + (c.y - D.from.y) * k; D.alt = D.from.alt * (1 - k);
      D.vx = 0; D.vy = 0;
      if (k >= 1) {
        mc('dragon.growl', { vol: 0.9, pitch: 0.85 });
        G.shake = Math.max(G.shake || 0, 0.25);
        if (D.rest) go('exhausted', { roarT: 4 });
        else go('perch', { dur: 10 + rnd() * 10, perchDmg: 0, breathT: 2.5, roarT: 5 });
      }
      break;
    }
    case 'perch': {
      // sitting on the fountain, watching Steve, breathing on him now and then; it takes off after 50 damage or
      // when its time is up (Minecraft)
      turnTo(P, dt);
      D.breathT -= dt; D.roarT -= dt;
      if (D.roarT <= 0) { D.roarT = 6 + rnd() * 4; mc('dragon.growl', { vol: 0.9 }); }
      if (D.breathT <= 0 && steveTarget() && Math.hypot(P.fx - c.x, P.fy - c.y) < 14) { go('breathWind', { dur: D.dur, perchDmg: D.perchDmg, started: D.started || 0 }); mc('dragon.growl', { vol: 1, pitch: 0.75 }); break; }
      D.perched = (D.perched || 0) + dt;
      if (D.perchDmg >= 50 || D.perched >= D.dur) takeoff();
      break;
    }
    case 'breathWind': {
      D.heading = headingTo(D, P);
      D.perched = (D.perched || 0) + dt;
      if (D.t >= 0.9) { go('breath', { puffs: 0 }); mc('dragon.shoot', { vol: 0.8, pitch: 0.7 }); }
      break;
    }
    case 'breath': {
      // a cone of dragon's breath in front of its head
      D.perched = (D.perched || 0) + dt;
      const want = Math.floor(D.t / 0.45);
      while (D.puffs <= Math.min(3, want)) { breathCone(D.puffs); D.puffs++; }
      if (D.t >= 2.2) { go('perch', { breathT: 4 + rnd() * 2.5 }); if (D.perchDmg >= 50 || D.perched >= D.dur) takeoff(); }
      break;
    }
    case 'takeoff': {
      const a = D.heading * TAU / 16;
      D.x += Math.cos(a) * 4 * dt; D.y += Math.sin(a) * 4 * dt;
      toAlt(60, 1.2, dt);
      if (D.t > 1.6) { D.vx = Math.cos(a) * 5; D.vy = Math.sin(a) * 5; go('circle', { decide: 7 + rnd() * 5 }); }
      break;
    }
    case 'exhausted': {
      // panting on the fountain: it stays, roaring now and then, until Steve faces it and presses A
      D.x = c.x; D.y = c.y; D.alt = 0;
      turnTo(P, dt, 0.8);
      D.roarT -= dt;
      if (D.roarT <= 0) { D.roarT = 7 + rnd() * 5; mc('dragon.growl', { vol: 0.8, pitch: 0.7 }); }
      break;
    }
    default: go('circle');
  }
  // the view leans toward the dragon while it sits on the fountain, so its body is in sight and not just its head
  // (Steve kept in view: main.js clamps a leaning focus)
  if (!death && !ritual && groundPose() && Math.hypot(P.fx - D.x, P.fy - D.y) < 12) {
    const k0 = G.camFocus && G.camFocus.clamp ? G.camFocus.k : 0;
    // the lean aims above its body (the sprite reaches far up from its feet), with a looser hold on Steve
    G.camFocus = { x: D.x * TILE + 8, y: D.y * TILE + 8 - 64, k: Math.min(0.75, k0 + dt * 3), clamp: true, loose: true };
  } else if (!death && !ritual && ['approach', 'windup', 'strafe', 'charge'].includes(D.phase) && Math.hypot(P.fx - D.x, P.fy - D.y) < 14) {
    // an attack coming in: the view leans a little toward it, so the head turning to Steve is in sight
    const k0 = G.camFocus && G.camFocus.clamp ? G.camFocus.k : 0;
    G.camFocus = { x: D.x * TILE + 8, y: D.y * TILE + 8 - D.alt - 20, k: Math.min(0.35, k0 + dt * 2), clamp: true };
  }
  // never off the map, wherever a chase took it
  const n = N();
  D.x = Math.max(n.x + 4, Math.min(n.x + n.w - 5, D.x)); D.y = Math.max(n.y + 4, Math.min(n.y + n.h - 5, D.y));
}
function takeoff() { go('takeoff', { perched: 0, dur: 0 }); mc('dragon.wings', { vol: 0.9 }); mc('dragon.growl', { vol: 0.9 }); }
function turnTo(P, dt, rate = 2.5) {
  D.turnT = (D.turnT || 0) - dt;
  if (D.turnT > 0) return;
  D.turnT = 1 / rate;
  const want = headingTo(D, P);
  const diff = ((want - D.heading + 24) % 16) - 8;
  if (diff) D.heading = (D.heading + Math.sign(diff) + 16) % 16;
}
function exhaust() {
  S().exhausted = true;
  if (D) go('toRest', { roarT: 2 });
  mc('dragon.growl', { vol: 1, pitch: 0.6 });
}

// ---------------------------------------------------------------- crystals
// Pillar crystals (G.end.crystals, one per pillar of world.json end.pillars) and the ones Steve placed (G.end.placed).
function crystalList() {
  const out = [];
  N().pillars.forEach((p, i) => { const c = G.end.crystals[i]; if (c && c.alive) out.push({ kind: 'pillar', i, p, c, px: p.crystal[0], py: p.crystal[1], lift: 22 }); });
  G.end.placed.forEach((c, i) => out.push({ kind: 'placed', i, c, px: c.x * TILE + 8, py: c.y * TILE + 6, lift: 12 }));
  return out;
}
export const aliveCrystals = () => G.end.crystals.filter((c) => c.alive).length;
function heal(dt) {
  if (!D || S().exhausted || D.phase === 'toRest') { if (D) D.healer = null; return; }
  let best = null, bd = HEAL_RANGE;
  for (const k of crystalList()) {
    const d = Math.hypot(k.px / TILE - 0.5 - D.x, k.py / TILE - 0.5 - D.y);
    if (d < bd) { bd = d; best = k; }
  }
  D.healer = best ? best.kind + ':' + best.i : null;
  if (!best) { D.healT = 0; return; }
  D.healT += dt;
  while (D.healT >= 0.5) { D.healT -= 0.5; if (S().hp < MAX_HP) S().hp = Math.min(MAX_HP, S().hp + 1); }
}
// A crystal is hit by a projectile: a caged one loses its cage first (two hits), then it explodes.
function hitCrystal(k) {
  if (k.kind === 'pillar' && k.c.cage > 0) {
    k.c.cage--;
    mc('bars_break', { vol: 0.9 });
    E.breakParticles(k.px - 8, k.py - 30, ['#6c6c6c', '#9a9a9a', '#3c3c3c'], 14, 30);
    return;
  }
  explodeCrystal(k);
}
export function explodeCrystal(k, quiet = false) {
  const healing = D && D.healer === k.kind + ':' + k.i;
  if (k.kind === 'pillar') k.c.alive = false; else G.end.placed.splice(k.i, 1);
  if (quiet) { E.poof(k.px, k.py - k.lift, 10); return; }
  const near = !NET.on || NET.near(k.px / TILE, k.py / TILE);
  if (NET.h) NET.h.fx(['c', Math.round(k.px), Math.round(k.py), k.lift]);   // co-op: the burst on the guests' screens
  if (near) mc('crystal.explode', { vol: 1, pitch: 0.8 + rnd() * 0.2 });
  if (near) { flash = 1; G.shake = Math.max(G.shake || 0, 0.45); }
  for (let i = 0; i < 18; i++) E.spriteParticle(A.mc.pExplosion, 16, k.px + (rnd() - 0.5) * 60, k.py - k.lift + (rnd() - 0.5) * 40, { life: 0.5 + rnd() * 0.4, z: 4 + rnd() * 10, fw: 32, scale: 1.8 });
  // power 6, but it breaks nothing; it hurts what is within 3 cells of it (of the pillar it stands on)
  const P = G.P;
  const rect = k.kind === 'pillar' ? k.p.cells : [Math.round(k.px / TILE - 0.5), Math.round(k.py / TILE - 0.5), 1, 1];
  const distTo = (x, y) => Math.hypot(Math.max(rect[0] - x, 0, x - (rect[0] + rect[2] - 1)), Math.max(rect[1] - y, 0, y - (rect[1] + rect[3] - 1)));
  const d = distTo(P.fx, P.fy);
  if (NET.on) {
    const cx = rect[0] + rect[2] / 2 - 0.5, cy = rect[1] + rect[3] / 2 - 0.5;
    for (const p of NET.players()) { const dp = distTo(p.fx, p.fy); if (NET.vuln(p) && dp <= 3) hurtOne(p, 4 + 9 * (1 - dp / 3), ['crystal'], `${p.name} was blown up by End Crystal`, { tx: Math.round(cx), ty: Math.round(cy) }); }
  } else if (!P.dead && d <= 3) {
    P.invuln = 0;
    const cx = rect[0] + rect[2] / 2 - 0.5, cy = rect[1] + rect[3] / 2 - 0.5;
    G.hurtPlayer(4 + 9 * (1 - d / 3), `${P.name} was blown up by End Crystal`, { tx: Math.round(cx), ty: Math.round(cy) });
  }
  for (const m of G.ents) if (m.type === 'mob' && !m.dying && distTo(m.fx, m.fy) <= 3) { m.invuln = 0; E.hurtMob(m, 8, { x: Math.round(k.px / TILE), y: Math.round(k.py / TILE) }); }
  // Minecraft: a crystal blown up while it heals the dragon costs the dragon 10 health
  if (healing) hurtDragon(10, 'crystal');
}
// The arrow hook (entities.js): an arrow into any cell of a pillar's footprint hits that pillar's crystal; one into
// a placed crystal's cell hits it; one that reaches the dragon's body hits the dragon.
export function arrowHook(a, tx, ty) {
  if (!N() || !W().inEnd(tx, ty)) return false;
  for (const k of crystalList()) {
    if (k.kind === 'pillar') { const [x, y, w, h] = k.p.cells; if (tx >= x && tx < x + w && ty >= y && ty < y + h) { hitCrystal(k); mc('bowhit', { vol: 0.5 }); return true; } }
    else if (k.c.x === tx && k.c.y === ty) { hitCrystal(k); return true; }
  }
  if (D && S().alive && !death) {
    const bx = D.x * TILE + 8, by = D.y * TILE + 8 - D.alt - 16;
    if (Math.hypot(a.x - bx, a.y - 6 - by) < (D.alt < 8 ? 30 : 26)) {
      if (hurtDragon(a.dmg, 'arrow')) { mc('bowhit', { vol: 0.6 }); if (NET.h && a.ownerSlot) NET.h.adv(a.ownerSlot, 'take_aim'); else if (G.onArrowHit) G.onArrowHit(); }
      return true;
    }
  }
  return false;
}
// X with an end crystal: only on obsidian or bedrock (a placed block, the platform, the fountain's rim)
export function placeCrystal(P, f) {
  const w = W(), b = w.block(f.x, f.y), mat = w.mat(f.x, f.y);
  if (!N() || !w.inEnd(f.x, f.y)) return false;            // only The End draws, hits and blows them up
  const ok = (b && (b.id === 'obsidian' || b.id === 'bedrock')) || (!b && (mat === 'obsidian_floor' || mat === 'bedrock' || mat === 'obsidian' || mat === 'end_pillar'));
  if (!ok || G.end.placed.some((c) => c.x === f.x && c.y === f.y)) return false;
  if (P.tx === f.x && P.ty === f.y) return false;
  if (NET.g) { NET.g.placeCrystal(f); G.inv.useHeld(); mc('dig.glass', { vol: 0.6, pitch: 1.3 }); P.placeT = 0.18; return true; }   // co-op: the host places it
  G.end.placed.push({ x: f.x, y: f.y });
  G.inv.useHeld();
  mc('dig.glass', { vol: 0.6, pitch: 1.3 });
  P.placeT = 0.18;
  checkRitual();
  return true;
}

// ---------------------------------------------------------------- fireballs and dragon's breath
function fireball(at) {
  const P = tgt(), h = head(), T = at || { x: P.fx, y: P.fy };
  const sx = h.x * TILE + 8, sy = h.y * TILE + 8, tx = T.x * TILE + 8, ty = T.y * TILE + 8;
  const d = Math.hypot(tx - sx, ty - sy) || 1;
  balls.push({ x: sx, y: sy, z: Math.max(12, D.alt), z0: Math.max(12, D.alt), vx: (tx - sx) / d * 110, vy: (ty - sy) / d * 110, tx, ty, t: 0, d0: d });
  mc('dragon.shoot', { vol: 0.9 });
}
function updateBalls(dt) {
  const P = G.P;   // (co-op: any player it reaches)
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    b.t += dt;
    b.x += b.vx * dt; b.y += b.vy * dt;
    const left = Math.hypot(b.tx - b.x, b.ty - b.y);
    b.z = Math.max(2, 4 + (b.z0 - 4) * Math.min(1, left / Math.max(1, b.d0)));
    if (rnd() < 0.8) E.spriteParticle(A.mc.pDragonBreath, 8, b.x + (rnd() - 0.5) * 6, b.y, { life: 0.6, z: b.z, vz: 4, fw: 8, scale: 1.3 });
    const cx = Math.floor(b.x / TILE), cy = Math.floor(b.y / TILE);
    const wall = !W().inside(cx, cy) || (W().solid(cx, cy) && !W().isEndVoid(cx, cy));
    const hitP = NET.on ? !!(NET.h && NET.h.victim(b.x, b.y, 9)) : !P.dead && Math.hypot(P.fx * TILE + 8 - b.x, P.fy * TILE + 8 - b.y) < 9;
    if (left < 6 || hitP || (wall && b.t > 0.2) || b.t > 5) {
      balls.splice(i, 1);
      if (!NET.on || NET.near(b.x / TILE, b.y / TILE)) mc('dragon_fireball.explode', { vol: 0.9 * nearVol(b.x / TILE, b.y / TILE) + 0.1 });
      // over the void the cloud is lost below; on the ground it lingers
      const gx = Math.round((b.x - 8) / TILE), gy = Math.round((b.y - 8) / TILE);
      for (let k = 0; k < 14; k++) E.spriteParticle(A.mc.pDragonBreath, 8, b.x + (rnd() - 0.5) * 30, b.y + (rnd() - 0.5) * 20, { life: 0.8 + rnd() * 0.6, z: 3, vz: 6 + rnd() * 10, vx: (rnd() - 0.5) * 30, fw: 8, scale: 1.6 });
      if (!W().isEndVoid(gx, gy)) clouds.push({ x: gx, y: gy, r: 1, t: 0, life: 6, hurtT: 0.3 });
    }
  }
}
function breathCone(i) {
  // out of the drawn mouth, toward where Steve stood when it began breathing (along its heading if he is behind it)
  const h = head(), P = tgt();
  if (i === 0) {
    const ta = Math.atan2(P.fy - h.y, P.fx - h.x), ha = D.heading * TAU / 16;
    D.breathA = Math.cos(ta - ha) > 0.5 ? ta : ha;
  }
  const a = D.breathA ?? h.a;
  const dist = [1.4, 3.2, 5.0, 6.8][i] || 6.8;
  const x = Math.round(h.x + Math.cos(a) * dist), y = Math.round(h.y + Math.sin(a) * dist);
  if (W().isEndVoid(x, y)) return;
  clouds.push({ x, y, r: 1, t: 0, life: 3.5, hurtT: 0.2 });
  for (let k = 0; k < 10; k++) E.spriteParticle(A.mc.pDragonBreath, 8, x * TILE + 8 + (rnd() - 0.5) * 30, y * TILE + 8 + (rnd() - 0.5) * 20, { life: 0.8, z: 6, vz: 6, vx: Math.cos(a) * 20, fw: 8, scale: 1.5 });
}
function updateClouds(dt) {
  const P = G.P;
  for (let i = clouds.length - 1; i >= 0; i--) {
    const c = clouds[i];
    c.t += dt;
    if (c.t >= c.life) { clouds.splice(i, 1); continue; }
    if (rnd() < dt * 8) E.spriteParticle(A.mc.pDragonBreath, 8, c.x * TILE + 8 + (rnd() - 0.5) * 40, c.y * TILE + 8 + (rnd() - 0.5) * 36, { life: 1, z: 2, vz: 5 + rnd() * 6, fw: 8, scale: 1.2 });
    c.hurtT -= dt;
    // standing in it hurts: 4 every second (armor helps)
    if (NET.on) {
      if (c.hurtT <= 0) {
        let hit = false;
        for (const p of NET.players()) if (NET.h && NET.h.dragonOk(p, true) && Math.abs(p.tx - c.x) <= c.r && Math.abs(p.ty - c.y) <= c.r) { hit = true; hurtOne(p, 4, ['breath'], `${p.name} was killed by Ender Dragon using magic`, null, null); }
        if (hit) c.hurtT = 1;
      }
    } else if (!P.dead && !P.voidFall && Math.abs(P.tx - c.x) <= c.r && Math.abs(P.ty - c.y) <= c.r && c.hurtT <= 0) {
      c.hurtT = 1;
      P.invuln = 0;
      G.hurtPlayer(4, `${P.name} was killed by Ender Dragon using magic`, null, false, { noKnock: true });
    }
  }
}
// Knock Steve up to n cells along (dx, dy): into the void if it lies that way (falling out of the world).
// (exported: a co-op guest runs it on itself when the host's dragon hits it)
export function knock(dx, dy, n) {
  const P = G.P, w = W();
  if (P.dead) return;
  const d = DIRS[dirTo(0, 0, dx, dy)];
  let x = P.tx, y = P.ty;
  for (let k = 0; k < n; k++) {
    const nx = x + d.x, ny = y + d.y;
    if (w.isEndVoid(nx, ny)) {
      if (x !== P.tx || y !== P.ty) { P.tx = P.fromX = P.fx = x; P.ty = P.fromY = P.fy = y; P.moving = false; }
      if (G.fallIntoVoid) G.fallIntoVoid(nx, ny);
      return;
    }
    if (w.solid(nx, ny) || E.mobAt(nx, ny)) break;
    x = nx; y = ny;
  }
  if (x === P.tx && y === P.ty) return;
  P.fromX = P.tx; P.fromY = P.ty; P.tx = x; P.ty = y; P.moving = true; P.prog = 0; P.speed = 0.08 * Math.max(1, Math.abs(x - P.fromX) + Math.abs(y - P.fromY)); P.dist = 1; P.knocked = true;
  P.mining = null;
}

// ---------------------------------------------------------------- damage
// Returns whether the hit landed. Exhausted, it never drops below 1 (it waits for Steve on the fountain).
export function hurtDragon(dmg, src) {
  if (!D || !S().alive || death || dmg <= 0) return false;
  // exhausted, it is past fighting in the world: it waits on the fountain for the battle, its health as the fight left it
  if (S().exhausted) return false;
  if (src === 'melee' && D.invuln > 0) return false;
  if (NET.g) { NET.g.dragonHit(dmg, src); D.hurt = 0.4; if (src === 'melee') D.invuln = 0.45; mc('dragon.hurt', { vol: 0.9, pitch: 0.9 + rnd() * 0.2 }); return true; }   // co-op: the host's dragon
  const s = S();
  s.hp = Math.max(s.exhausted ? 1 : 0, s.hp - dmg);
  if (s.hp <= 0) s.hp = 1;
  D.hurt = 0.4; if (src === 'melee') D.invuln = 0.45;
  if (['perch', 'breathWind', 'breath'].includes(D.phase)) D.perchDmg = (D.perchDmg || 0) + dmg;
  mc('dragon.hurt', { vol: 0.9, pitch: 0.9 + rnd() * 0.2 });
  if (s.hp <= EXHAUST_HP && !s.exhausted) exhaust();
  return true;
}
const perched = () => D && ['perch', 'breathWind', 'breath', 'exhausted'].includes(D.phase);
// Can Steve's melee reach it? Perched on the fountain: within 3.6 cells of it and facing it. Swooping low: close.
function inReach(P) {
  if (!D || death) return false;
  const dx = D.x - P.tx, dy = D.y - P.ty, d = Math.hypot(dx, dy), f = DIRS[P.dir];
  const facing = d < 0.5 || (dx * f.x + dy * f.y) / d > 0.45;
  if (perched()) return d <= 3.6 && facing;
  return D.alt < 28 && d <= 2.4 && facing;
}
// Z (main.js): the legendary encounter once it is exhausted, else a melee hit while it is in reach
export function encounterReady(P) { return !!D && D.phase === 'exhausted' && !death && inReach(P); }
export function meleeReady(P) { return !!D && !death && D.phase !== 'exhausted' && inReach(P); }
export function attack(P) {
  const held = G.inv.held, t = toolOf(held);
  const base = t ? t.dmg : 1, rate = t ? t.rate : 4;
  const charge = Math.min(1, P.attackCd * rate);
  let dmg = base * (0.2 + charge * charge * 0.8);
  const crit = P.jumpT > 0.18 && charge > 0.9;
  if (crit) dmg *= 1.5;
  // only a perched dragon takes a blow in full (Minecraft: anything but its head takes a quarter, plus one)
  if (!perched()) dmg = dmg / 4 + 1;
  P.attackCd = 0; P.swingT = 0.001;
  if (hurtDragon(dmg, 'melee')) {
    mc(crit ? 'attack.crit' : charge > 0.9 ? 'attack.strong' : 'attack.weak', { vol: 0.7 });
    if (crit) for (let i = 0; i < 8; i++) E.spriteParticle(A.mc.pCrit, 1, D.x * TILE + 8 + (rnd() - 0.5) * 24, D.y * TILE - D.alt, { life: 0.5, vz: 30, vx: (rnd() - 0.5) * 60, z: 6, g: -40, fw: 8, scale: 2 });
    if (t && G.inv.wearHeld(t.kind === 'sword' ? 1 : 2)) mc('break');
    return true;
  }
  mc('attack.weak', { vol: 0.4 });
  return false;
}

// ---------------------------------------------------------------- after the battle (main.js)
// caught: it is simply gone; fainted: Minecraft's death sequence; Steve's side lost: it recovers to 40% (or keeps
// more) and goes back to circling.
export function battleOver(outcome) {
  const s = S();
  if (outcome === 'caught') { D = null; s.alive = false; s.exhausted = false; s.hp = 0; ending(true); return; }
  if (outcome === 'win') { startDeath(); return; }
  if (outcome === 'ran') return;              // the boss can't be fled (battle.js); nothing changes if it ever were
  if (outcome === 'dead' || outcome === 'whiteout') {
    s.hp = Math.max(Math.round(MAX_HP * 0.4), s.hp); s.exhausted = false;
    if (D) { go('takeoff', { perched: 0 }); }
  }
}
export function startDeath() {
  ensure();
  const c = centre();
  const first = G.end.kills === 0 && !G.end.respawned;
  death = { t: 0, xp: first ? 12000 : 500, given: 0, first, rays: Array.from({ length: 22 }, () => ({ a: rnd() * TAU, l: 0.5 + rnd() * 0.5, s: (rnd() - 0.5) * 0.6, w: 0.05 + rnd() * 0.08, t0: rnd() * 6 })) };
  if (D) Object.assign(D, { phase: 'dying', t: 0, from: { x: D.x, y: D.y, alt: D.alt } });
  // the outcome is settled now, not when the sequence ends: a save made during it keeps the dragon dead, and the
  // ending is finished on loading (finishDying)
  Object.assign(S(), { alive: false, hp: 0, exhausted: false, dying: { xp: death.xp } });
  mc('dragon.death', { vol: 1 });
  void c;
}
// XP from the death sequence not yet picked up: the orbs still to come and those lying in The End (orbs aren't saved)
export function deathXpLeft() {
  if (!death) return 0;
  let lying = 0;
  for (const e of G.ents) if (e.type === 'xp' && W().inEnd(Math.floor(e.x / TILE), Math.floor(e.y / TILE))) lying += e.value;
  return Math.max(0, death.xp - death.given) + lying;
}
// A game saved during the death sequence was loaded: the ending happens now, with the XP that was still to come.
export function finishDying(left) {
  const s = S();
  delete s.dying;
  Object.assign(s, { alive: false, hp: 0, exhausted: false });
  death = null; D = null;
  ending(false, true);
  if (left > 0) { const c = centre(); E.dropOrbs(left, c.x * TILE, (c.y + 1) * TILE); }
}
function updateDeath(dt) {
  const d = death, c = centre();
  d.t += dt;
  // the view moves to the spectacle, centred on its drawn body (its sprite reaches about 27 px above its ground point)
  if (D) G.camFocus = { x: D.x * TILE + 8, y: D.y * TILE + 8 - D.alt - 27, k: Math.min(1, d.t / 0.9) * (d.t > 9 ? Math.max(0, (9.6 - d.t) / 0.6) : 1) };
  if (D) {
    const k = Math.min(1, d.t / 2);
    D.x = D.from.x + (c.x - D.from.x) * k; D.y = D.from.y + (c.y - D.from.y) * k;
    D.alt = D.from.alt + (40 - D.from.alt) * k + Math.max(0, d.t - 1) * 5;
    D.flap += dt * 0.3; D.hurt = 0;
    D.alpha = d.t < 8 ? 1 : Math.max(0, 1 - (d.t - 8) / 1.6);
  }
  // XP orbs shower down over the fountain from the third second
  if (d.t > 2.5 && d.t < 8.5) {
    const want = Math.floor(d.xp * 0.7 * (d.t - 2.5) / 6);
    if (want - d.given >= Math.max(1, d.xp * 0.02) || (d.t > 8.4 && want > d.given)) {
      const n = want - d.given; d.given = want;
      E.dropOrbs(n, (c.x + (rnd() - 0.5) * 4) * TILE, (c.y + (rnd() - 0.5) * 3) * TILE);
    }
  }
  if (d.t >= 9.6) {
    E.dropOrbs(d.xp - d.given, c.x * TILE, c.y * TILE);
    death = null; D = null; G.camFocus = null;
    const s = S(); s.alive = false; s.hp = 0; s.exhausted = false; delete s.dying;
    ending(false, true);
  }
}
// The shared ending: the exit portal opens, the first dragon leaves its egg on the pillar, the XP (already showered
// by a death), the advancements, and the calm music.
function ending(caught, xpGiven = false) {
  const first = G.end.kills === 0 && !G.end.respawned;
  G.end.kills++;
  activateExit(true);
  if (first) { G.end.egg = 'pillar'; eggShow = 3.2; }
  if (!xpGiven) {
    const c = centre(), xp = first ? 12000 : 500;
    // as orbs, in a few bursts round the fountain
    for (let i = 0; i < 6; i++) E.dropOrbs(Math.floor(xp / 6) + (i === 0 ? xp % 6 : 0), (c.x + (rnd() - 0.5) * 3) * TILE, (c.y + 1 + (rnd() - 0.5) * 2) * TILE);
  }
  G.end.respawned = false;
  G.advance('free_end');
  if (caught) G.advance('dragon_tamer');
  if (NET.h) { NET.h.advIn('end', 'free_end'); if (caught) NET.h.advIn('end', 'dragon_tamer'); }   // co-op: everyone in The End
}
export function activateExit(on, sound = true) {
  const w = W();
  for (const [x, y] of N().fountain.inner) {
    if (on) w.setBlock(x, y, { id: 'end_portal', walk: true });
    else if (w.isEndPortal(x, y)) w.setBlock(x, y, null);
  }
  G.end.exitActive = on;
  // standing in the basin as it opens: he has to step off and on again before it takes him
  if (on && w.isEndPortal(G.P.tx, G.P.ty)) G.endCool = true;
  if (on && sound) mc('end_portal_spawn', { vol: 1 });
}

// ---------------------------------------------------------------- the respawn ritual
// Four end crystals on the four sides of the active exit portal (the middle of each side of its bedrock rim):
// beams to the pillar tops, the pillars' crystals and cages come back, the portal closes, the dragon returns at full
// health. A respawned dragon gives 500 XP and no egg.
export function sideSpots() { const c = centre(); return [[c.x, c.y - 3], [c.x + 3, c.y], [c.x, c.y + 3], [c.x - 3, c.y]]; }
export function checkRitual() {
  if (ritual || S().alive || !G.end.exitActive) return;
  const sides = sideSpots();
  if (sides.every(([x, y]) => G.end.placed.some((c) => c.x === x && c.y === y))) startRitual();
}
export function startRitual() { ritual = { t: 0, rebuilt: 0 }; mc('end_portal_spawn', { vol: 0.8, pitch: 0.7 }); }
function updateRitual(dt) {
  const r = ritual;
  r.t += dt;
  { const c = centre(); G.camFocus = { x: c.x * TILE + 8, y: c.y * TILE + 8 - 50, k: Math.min(1, r.t / 1.5) }; }
  // from 3 s the pillars' crystals come back one by one
  const want = Math.min(N().pillars.length, Math.floor(Math.max(0, r.t - 3) / 0.45));
  while (r.rebuilt < want) {
    const i = r.rebuilt++, p = N().pillars[i];
    G.end.crystals[i] = { alive: true, cage: p.caged ? 2 : 0 };
    mc('crystal.explode', { vol: 0.35, pitch: 1.6 });
    E.portalPuff(p.crystal[0], p.crystal[1] - 22, 14, 18);
  }
  if (r.t >= 8.4 && !r.closed) {
    r.closed = true;
    activateExit(false);
    // the four placed crystals are used up
    const sides = sideSpots();
    for (let i = G.end.placed.length - 1; i >= 0; i--) { const c = G.end.placed[i]; if (sides.some(([x, y]) => x === c.x && y === c.y)) explodeCrystal({ kind: 'placed', i, c, px: c.x * TILE + 8, py: c.y * TILE + 6, lift: 12 }, true); }
  }
  if (r.t >= 9.5) {
    ritual = null;
    Object.assign(S(), { alive: true, hp: MAX_HP, exhausted: false });
    G.end.respawned = true;
    D = null; ensure();
    const c = centre();
    Object.assign(D, { x: c.x, y: c.y - 2, alt: 90, vx: 6, vy: 0, phase: 'circle', decide: 6 });
    mc('dragon.growl', { vol: 1 });
    G.advance('end_again');
  }
}

// ---------------------------------------------------------------- drawing (GBA pixels)
const SH = () => A.items.end;
function frameOf() {
  const d = SH().dragon, rows = d.rows;
  let row;
  if (D.phase === 'dying') row = rows.death0;
  else if (D.phase === 'exhausted') row = rows['pant' + (Math.floor(D.flap / 0.42) % 4)];
  else if (D.phase === 'breathWind') row = rows.breath0;
  else if (D.phase === 'breath') row = rows.breath1;
  else if (D.phase === 'perch' || (D.phase === 'descend' && D.alt < 8)) row = rows['perch' + (Math.floor(D.flap / 0.7) % 2)];
  else {
    const rate = D.phase === 'windup' ? 11 : D.phase === 'charge' ? 4 : 8;
    row = rows['fly' + (Math.floor(D.flap * rate) % 8)];
  }
  return { col: shownHeading(), row };
}
// Headings 3 to 5 (facing the camera) hide its lowered head under its body: on the ground and in the wind-up it is
// drawn turned a little aside (2 or 6, toward Steve's side), so its face and eyes show
function shownHeading() {
  const h = D.heading;
  if (h < 3 || h > 5 || !(groundPose() || D.phase === 'windup')) return h;
  return G.P.fx >= D.x ? 2 : 6;
}
// Steve stands in front of (south of) the dragon on the fountain: main.js draws him again over it, so its head,
// lowered toward him, does not hide him
export function steveInFront() { const P = G.P; return !!D && !death && groundPose() && P.fy > D.y + 0.6 && Math.abs(P.fx - D.x) < 6 && P.fy - D.y < 6; }
const groundPose = () => ['perch', 'breathWind', 'breath', 'exhausted'].includes(D.phase) || (D.phase === 'descend' && D.alt < 8);
// on the ground pass: the dragon's shadow and the breath clouds
export function drawGround(ctx, cam) {
  for (const c of clouds) {
    const k = Math.min(1, c.t / 0.3) * Math.min(1, (c.life - c.t) / 1.2), f = Math.floor(c.t * 8) % 8;
    ctx.save();
    const s = (c.r * 2 + 1) * TILE, cx = c.x * TILE + 8 - cam.x, cy = c.y * TILE + 8 - cam.y;
    // the lingering cloud: a soft purple haze over its cells, the breath sprite swirling in it
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, s * 0.62);
    g.addColorStop(0, `rgba(190,60,230,${0.42 * k})`); g.addColorStop(0.7, `rgba(150,40,200,${0.3 * k})`); g.addColorStop(1, 'rgba(120,20,170,0)');
    ctx.fillStyle = g; ctx.fillRect(cx - s * 0.65, cy - s * 0.65, s * 1.3, s * 1.3);
    ctx.globalAlpha = 0.9 * k;
    ctx.drawImage(A.mc.dragonBreath, f * 48, 0, 48, 48, Math.round(c.x * TILE + 8 - s / 2 - cam.x), Math.round(c.y * TILE + 8 - s / 2 - cam.y), s, s);
    ctx.restore();
  }
  if (!D || !A.mc.dragonShadow) return;
  const sh = SH().dragon.shadow, row = groundPose() ? sh.rows.perch : sh.rows.fly;
  const a = Math.max(0.12, 0.55 - D.alt / 220) * (D.alpha ?? 1) * (D.phase === 'windup' ? 1.35 : 1);
  ctx.save(); ctx.globalAlpha = Math.min(0.8, a);
  ctx.drawImage(A.mc.dragonShadow, D.heading * sh.w, row * sh.h, sh.w, sh.h, Math.round(D.x * TILE + 8 - sh.origin[0] - cam.x), Math.round(D.y * TILE + 8 - sh.origin[1] - cam.y), sh.w, sh.h);
  ctx.restore();
}
function crystalDraw(ctx, k, cam) {
  const C = SH().crystal, t = G.clock + (k.i || 0) * 0.37;
  const x = Math.round(k.px - cam.x), y = Math.round(k.py - cam.y);
  const bob = Math.sin(t * 4 * 0.5) * 3;
  const caged = k.kind === 'pillar' && k.c.cage > 0, dmg = caged && k.c.cage === 1;
  const cg = SH().cage;
  if (caged) ctx.drawImage(A.mc.crystalCage, (dmg ? 2 : 0) * cg.w, 0, cg.w, cg.h, x - cg.origin[0], y - cg.origin[1], cg.w, cg.h);
  const B = SH().base;
  ctx.drawImage(A.mc.crystalBase, x - B.origin[0], y - B.origin[1]);
  const f = Math.floor(t * (C.spinFps || 4)) % C.frames;
  ctx.drawImage(A.mc.crystal, f * C.w, 0, C.w, C.h, x - C.centre[0], Math.round(y - k.lift - bob - C.centre[1]), C.w, C.h);
  if (caged) ctx.drawImage(A.mc.crystalCage, (dmg ? 3 : 1) * cg.w, 0, cg.w, cg.h, x - cg.origin[0], y - cg.origin[1], cg.w, cg.h);
  k.cx = k.px; k.cy = k.py - k.lift - bob;
}
let drawnCrystals = [];
// after the top layer: crystals on their pillars, then the dragon over everything
export function drawAir(ctx, cam) {
  drawnCrystals = crystalList();
  for (const k of drawnCrystals) crystalDraw(ctx, k, cam);
  if (!D) return;
  const d = SH().dragon, { col, row } = frameOf();
  const x = Math.round(D.x * TILE + 8 - d.origin[0] - cam.x), y = Math.round(D.y * TILE + 8 - d.origin[1] - D.alt - cam.y);
  ctx.save();
  if ((D.alpha ?? 1) < 1) ctx.globalAlpha = Math.max(0, D.alpha);
  ctx.drawImage(A.mc.dragon, col * d.w, row * d.h, d.w, d.h, x, y, d.w, d.h);
  if (D.hurt > 0) { ctx.globalAlpha = Math.min(1, D.hurt * 1.6) * (D.alpha ?? 1); ctx.drawImage(E.tintedFrame(A.mc.dragon, col * d.w, row * d.h, d.w, d.h, '#ff2020'), x, y); }
  ctx.restore();
}
// after the lighting: the crystals' glow and healing beam, the dragon's eyes, fireballs, the death rays, the flash
export function drawGlow(ctx, cam) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const k of drawnCrystals) {
    if (k.cx == null) continue;
    ctx.globalAlpha = 0.55 + 0.2 * Math.sin(G.clock * 3 + k.px);
    ctx.drawImage(A.mc.crystalGlow, Math.round(k.cx - 24 - cam.x), Math.round(k.cy - 24 - cam.y));
  }
  ctx.globalAlpha = 1;
  if (D && D.healer && !death) {
    const k = drawnCrystals.find((c) => c.kind + ':' + c.i === D.healer);
    if (k && k.cx != null) beam(ctx, k.cx - cam.x, k.cy - cam.y, D.x * TILE + 8 - cam.x, D.y * TILE + 8 - D.alt - 18 - cam.y, 0.85);
  }
  if (D && A.mc.dragonEyes) {
    const d = SH().dragon, { col, row } = frameOf();
    ctx.globalAlpha = (D.alpha ?? 1) * (D.phase === 'windup' || D.phase === 'breathWind' ? 1 : 0.85);
    ctx.drawImage(A.mc.dragonEyes, col * d.w, row * d.h, d.w, d.h, Math.round(D.x * TILE + 8 - d.origin[0] - cam.x), Math.round(D.y * TILE + 8 - d.origin[1] - D.alt - cam.y), d.w, d.h);
    if (D.phase === 'windup' || D.phase === 'breathWind') ctx.drawImage(A.mc.dragonEyes, col * d.w, row * d.h, d.w, d.h, Math.round(D.x * TILE + 8 - d.origin[0] - cam.x), Math.round(D.y * TILE + 8 - d.origin[1] - D.alt - cam.y), d.w, d.h);
    ctx.globalAlpha = 1;
  }
  for (const b of balls) {
    const x = b.x - cam.x, y = b.y - b.z - cam.y;
    const g = ctx.createRadialGradient(x, y, 1, x, y, 14);
    g.addColorStop(0, 'rgba(230,120,255,0.75)'); g.addColorStop(1, 'rgba(120,0,200,0)');
    ctx.fillStyle = g; ctx.fillRect(x - 14, y - 14, 28, 28);
    ctx.save(); ctx.translate(Math.round(x), Math.round(y)); ctx.rotate(Math.floor(b.t * 10) * Math.PI / 2);
    ctx.drawImage(A.mc.dragonFireball, -8, -8, 16, 16); ctx.restore();
  }
  if (death && D) {
    // beams of light bursting out of it, more and longer as it goes
    const cx = D.x * TILE + 8 - cam.x, cy = D.y * TILE + 8 - D.alt - 18 - cam.y, t = death.t;
    for (const r of death.rays) {
      if (t < r.t0 * 0.5 || t > 9.4) continue;
      const k = Math.min(1, (t - r.t0 * 0.5) / 1.5) * Math.min(1, (9.4 - t) / 1);
      const a = r.a + t * r.s, L = (40 + 120 * r.l) * k;
      const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * L, cy + Math.sin(a) * L);
      g.addColorStop(0, `rgba(255,255,255,${0.8 * k})`); g.addColorStop(0.5, `rgba(255,170,255,${0.45 * k})`); g.addColorStop(1, 'rgba(160,0,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a - r.w) * L, cy + Math.sin(a - r.w) * L); ctx.lineTo(cx + Math.cos(a + r.w) * L, cy + Math.sin(a + r.w) * L); ctx.closePath(); ctx.fill();
    }
  }
  if (ritual) {
    // beams from the four crystals on the rim up into the sky, then from the sky to each pillar top
    const c = centre(), sx = c.x * TILE + 8 - cam.x, sy = c.y * TILE + 8 - 120 - cam.y, k = Math.min(1, ritual.t / 0.8);
    for (const [x, y] of sideSpots()) beam(ctx, x * TILE + 8 - cam.x, y * TILE - 6 - cam.y, sx, sy, 0.9 * k);
    if (ritual.t > 2.6 && ritual.t < 8.4) for (const p of N().pillars.slice(0, Math.min(N().pillars.length, ritual.rebuilt + 1))) beam(ctx, sx, sy, p.crystal[0] - cam.x, p.crystal[1] - 22 - cam.y, 0.9);
    // a glow where the beams meet
    const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, 18);
    g.addColorStop(0, `rgba(255,230,255,${0.8 * k})`); g.addColorStop(1, 'rgba(200,120,255,0)');
    ctx.fillStyle = g; ctx.fillRect(sx - 18, sy - 18, 36, 36);
  }
  ctx.restore();
  if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${0.5 * flash})`; ctx.fillRect(0, 0, 240, 160); }
}
// an end crystal's beam (end_crystal_beam.png) from (x0, y0) to (x1, y1), its texture flowing along it (GBA pixels)
function beam(ctx, x0, y0, x1, y1, alpha = 1) {
  const len = Math.hypot(x1 - x0, y1 - y0), a = Math.atan2(y1 - y0, x1 - x0);
  if (len < 1 || !A.mc.crystalBeam) return;
  ctx.save(); ctx.translate(x0, y0); ctx.rotate(a);
  // a violet edge and a bright core under the flowing texture, so the beam reads on pale end stone as on the void
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = alpha * 0.55; ctx.fillStyle = '#6a2a9a'; ctx.fillRect(0, -2, len, 4);
  ctx.globalAlpha = alpha * 0.85; ctx.fillStyle = '#ffe6ff'; ctx.fillRect(0, -0.5, len, 1);
  ctx.globalCompositeOperation = 'lighter';
  const off = (G.clock * 40) % 64;
  ctx.globalAlpha = alpha;
  for (let s = -off; s < len; s += 64) {
    const from = Math.max(0, s), to = Math.min(len, s + 64);
    if (to > from) ctx.drawImage(A.mc.crystalBeam, from - s, 0, to - from, 5, from, -2.5, to - from, 5);
  }
  ctx.restore();
}
// Minecraft's boss bar: "Ender Dragon" over the pink bar at the top of the screen (canvas pixels)
export function drawBossBar(ctx) {
  if (!S().alive && !death) return;
  if (!D && !death) return;
  const bg = A.mc.gui_boss_pink_background, fg = A.mc.gui_boss_pink_progress;
  if (!bg || !fg) return;
  const x = Math.round((480 - 182) / 2), y = 14, frac = death ? 0 : Math.max(0, Math.min(1, S().hp / MAX_HP));
  const a = G.bossBarAlpha ?? 1;
  if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a;
  ctx.drawImage(bg, x, y);
  const w = Math.round(182 * frac);
  if (w > 0) ctx.drawImage(fg, 0, 0, w, 5, x, y, w, 5);
  const name = 'Ender Dragon';
  mcText(ctx, name, Math.round(240 - mcWidth(name) / 2), y - 10, '#ffffff', true);
  ctx.restore();
}

// ---------------------------------------------------------------- co-op (src/net/): the host's dragon on a guest
// The host flies the dragon; every guest in The End gets a packet about ten times a second and draws it from that:
// its body (eased toward the packet, carried on by its velocity in between), the breath clouds and fireballs, the
// death and ritual set pieces, the crystal flash. Nothing here runs in single-player.
const r2 = (v) => Math.round(v * 100) / 100;
export function netPacket() {
  if (!D && !death && !ritual && !clouds.length && !balls.length && flash <= 0) return 0;
  return {
    d: D ? [r2(D.x), r2(D.y), Math.round(D.alt), D.heading, D.phase, D.hurt > 0 ? 1 : 0, D.healer || 0, r2(D.alpha ?? 1), r2(D.vx || 0), r2(D.vy || 0)] : 0,
    c: clouds.map((c) => [c.x, c.y, c.r, r2(c.t), c.life]),
    b: balls.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.z), Math.round(b.vx), Math.round(b.vy)]),
    de: death ? [r2(death.t), death.first ? 1 : 0] : 0,
    ri: ritual ? [r2(ritual.t), ritual.rebuilt] : 0,
    fl: flash > 0 ? r2(flash) : 0,
  };
}
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
export function applyNet(p) {
  if (!p || typeof p !== 'object') { D = null; clouds.length = 0; balls.length = 0; death = null; ritual = null; return; }
  if (Array.isArray(p.d) && fin(p.d[0]) && fin(p.d[1])) {
    const [x, y, alt, h, ph, hu, heal, al, vx, vy] = p.d;
    if (!D) D = { x, y, alt, vx: 0, vy: 0, heading: 0, phase: ph, t: 0, flap: 0, hurt: 0, alpha: 1, invuln: 0, nx: x, ny: y, nalt: alt };
    if (Math.hypot(D.x - x, D.y - y) > 6) { D.x = x; D.y = y; D.alt = alt; }
    D.nx = x; D.ny = y; D.nalt = fin(alt) ? alt : D.alt; D.vx = fin(vx) ? vx : 0; D.vy = fin(vy) ? vy : 0;
    if (Number.isInteger(h) && h >= 0 && h < 16) D.heading = h;
    if (typeof ph === 'string' && ph !== D.phase) { D.phase = ph; D.t = 0; }
    if (hu && !(D.hurt > 0)) { D.hurt = 0.4; if (NET.near(x, y)) mc('dragon.hurt', { vol: 0.9, pitch: 0.9 + rnd() * 0.2 }); }
    D.healer = typeof heal === 'string' ? heal : null;
    D.alpha = fin(al) ? al : 1;
  } else D = null;
  clouds.length = 0;
  for (const c of Array.isArray(p.c) ? p.c.slice(0, 40) : []) if (Array.isArray(c) && fin(c[0]) && fin(c[1])) clouds.push({ x: c[0], y: c[1], r: c[2] || 1, t: c[3] || 0, life: c[4] || 3, hurtT: 9 });
  balls.length = 0;
  for (const b of Array.isArray(p.b) ? p.b.slice(0, 20) : []) if (Array.isArray(b) && fin(b[0]) && fin(b[1])) balls.push({ x: b[0], y: b[1], z: b[2] || 8, vx: b[3] || 0, vy: b[4] || 0, t: 0 });
  if (Array.isArray(p.de)) {
    if (!death) death = { t: p.de[0], xp: 0, given: 0, first: !!p.de[1], rays: Array.from({ length: 22 }, () => ({ a: rnd() * TAU, l: 0.5 + rnd() * 0.5, s: (rnd() - 0.5) * 0.6, w: 0.05 + rnd() * 0.08, t0: rnd() * 6 })) };
    else death.t = p.de[0];
  } else death = null;
  if (Array.isArray(p.ri)) { if (!ritual) ritual = { t: p.ri[0], rebuilt: p.ri[1] || 0 }; else { ritual.t = p.ri[0]; ritual.rebuilt = p.ri[1] || 0; } }
  else ritual = null;
  if (fin(p.fl) && p.fl > flash) flash = p.fl;
}
// a guest's frame: the host's dragon eased toward its last packet, and this player's view of the set pieces
function netVisual(dt) {
  flash = Math.max(0, flash - dt * 3);
  for (const c of clouds) { c.t += dt; if (rnd() < dt * 8) E.spriteParticle(A.mc.pDragonBreath, 8, c.x * TILE + 8 + (rnd() - 0.5) * 40, c.y * TILE + 8 + (rnd() - 0.5) * 36, { life: 1, z: 2, vz: 5 + rnd() * 6, fw: 8, scale: 1.2 }); }
  for (const b of balls) { b.t += dt; b.x += b.vx * dt; b.y += b.vy * dt; if (rnd() < 0.8) E.spriteParticle(A.mc.pDragonBreath, 8, b.x + (rnd() - 0.5) * 6, b.y, { life: 0.6, z: b.z, vz: 4, fw: 8, scale: 1.3 }); }
  if (death) death.t += dt;
  if (ritual) ritual.t += dt;
  const P = G.P;
  if (D) {
    D.t += dt; D.flap += dt; D.hurt = Math.max(0, D.hurt - dt); D.invuln = Math.max(0, (D.invuln || 0) - dt);
    D.nx += D.vx * dt; D.ny += D.vy * dt;
    const k = Math.min(1, dt * 10);
    D.x += (D.nx - D.x) * k; D.y += (D.ny - D.y) * k; D.alt += (D.nalt - D.alt) * k;
    const flying = !['perch', 'breathWind', 'breath', 'exhausted', 'descend', 'dying'].includes(D.phase);
    D.wingT = (D.wingT || 0) - dt;
    if (flying && D.wingT <= 0) { D.wingT = 1.1 + rnd() * 0.4; mc('dragon.wings', { vol: 0.55 * nearVol(D.x, D.y) }); }
    D.growlT = (D.growlT ?? 4) - dt;
    if (D.growlT <= 0) { D.growlT = 8 + rnd() * 8; mc('dragon.growl', { vol: 0.7 * nearVol(D.x, D.y), pitch: 0.9 + rnd() * 0.2 }); }
  }
  // this player's view: the set pieces take it over, the perched dragon leans it, then it eases back
  if (death && D) G.camFocus = { x: D.x * TILE + 8, y: D.y * TILE + 8 - D.alt - 27, k: Math.min(1, death.t / 0.9) * (death.t > 9 ? Math.max(0, (9.6 - death.t) / 0.6) : 1) };
  else if (ritual) { const c = centre(); G.camFocus = { x: c.x * TILE + 8, y: c.y * TILE + 8 - 50, k: Math.min(1, ritual.t / 1.5) }; }
  else if (D && groundPose() && Math.hypot(P.fx - D.x, P.fy - D.y) < 12) {
    const k0 = G.camFocus && G.camFocus.clamp ? G.camFocus.k : 0;
    G.camFocus = { x: D.x * TILE + 8, y: D.y * TILE + 8 - 64, k: Math.min(0.75, k0 + dt * 3), clamp: true, loose: true };
  } else if (G.camFocus) { G.camFocus.k -= dt / 0.8; if (G.camFocus.k <= 0) G.camFocus = null; }
}
// a crystal's burst on a guest's screen (the host blew it up)
export function crystalFx(px, py, lift) {
  const near = NET.near(px / TILE, py / TILE);
  if (near) { mc('crystal.explode', { vol: 1, pitch: 0.8 + rnd() * 0.2 }); flash = 1; G.shake = Math.max(G.shake || 0, 0.45); }
  for (let i = 0; i < 18; i++) E.spriteParticle(A.mc.pExplosion, 16, px + (rnd() - 0.5) * 60, py - lift + (rnd() - 0.5) * 40, { life: 0.5 + rnd() * 0.4, z: 4 + rnd() * 10, fw: 32, scale: 1.8 });
}
// co-op host: the dragon is fighting (a guest in The End gets packets while this is true)
export const netLive = () => !!D || !!death || !!ritual || clouds.length > 0 || balls.length > 0;
