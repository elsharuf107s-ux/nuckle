// The co-op host's side of the shared world. The host's page keeps running the whole simulation it runs in
// single-player; this module makes that simulation work for every player and tells the guests about it:
//   * players(), target(), vuln(), hurt(), picker(): the hooks the game's own code calls (through flag.js) so mobs,
//     projectiles, explosions, the dragon and dropped items treat a guest like Steve (a guest is its live avatar);
//   * the guests' intents (I stream, reliable): block transactions (validated, all or nothing), hits, shearing,
//     boats, fireballs, the dragon, crystals, wild battles, containers, explosions, respawns, catch-up requests;
//   * every network tick (room.onTick): changed cells, the shared End state, effects and the sleep count to
//     everyone (B), and to each guest the entities near it as records and step events, its furnace and the dragon
//     (G, unreliable; a keyframe every 4 s and on request repairs anything lost);
//   * the night's sleepers, and the locks (a wild POKeMON in a battle, the legendary battle, a boat's rider).
// Design: multiplayer-design.md sections 4 to 12; deviations in section 26.
import { G, TILE, DIRS } from '../game.js';
import { PROT } from '../world.js';
import * as E from '../entities.js';
import * as DR from '../dragon.js';
import { mc } from '../audio.js';
import { NET } from './flag.js';
import { contentKey, fullKey, clone, okCell, okTile, okBlock, okItem, isInt, num, mobFlags, dirIdx, putBlock } from './proto.js';
import { findOffer, recordTrade, usesOf, ensureState, NO_TRADES } from '../trades.js';

const SHARED_END = ['crystals', 'placed', 'dragon', 'kills', 'respawned', 'exitActive', 'egg', 'eggHops'];
const REPL = new Set(['mob', 'wild', 'item', 'xp', 'arrow', 'fireball', 'tnt', 'boat']);
const CREATIVE_KEEP = new Set(['end_portal_frame', 'bedrock', 'spawner', 'dragon_egg']);   // (modes.js PROTECTED_IDS' solid blocks; portals collapse with their frames)
const SPEC_OK = new Set(['kf', 'rs', 'cl', 'trc', 'pid', 'hcd']);   // (stage 10: what a spectating guest may still send)
const KF_EVERY = 4000, LOG_MS = 60000, REACH = 14, TRAIL_MS = 8000;
const r100 = (v) => Math.round(v * 100), r10 = (v) => Math.round(v * 10);
const docHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function report(e) {
  const m = 'net host: ' + String((e && e.stack) || e);
  G.errors = G.errors || [];
  if (G.errors.includes(m) || G.errors.length >= 30) return;   // (each error once: an error every frame floods nothing)
  G.errors.push(m);
  try { console.error(e); } catch (x) { /* no console */ }
}

export class HostWorld {
  constructor(S) {
    this.S = S;
    this.peers = new Map();             // slot -> { slot, sent, kf, kfAt, open, fv, dr }
    this.nidN = 0;
    this.log = [];                      // [{ s (B seq), cells, at }] for catch-up
    this.fxq = [];
    this.endSent = {};
    this.legend = null; this.legendSent = undefined;
    this.inq = [];                      // intents, handled after the frame's movement is in (6.6)
    this.sleepT = new Map(); this.unbedSent = new Map(); this.slSent = '';
    this.rejects = [];
    this.trail = new Map();             // slot -> [[clock, tx, ty]] the guest's recent cells (wasNear)
    this.c = { tx: 0, txOk: 0, txNo: 0, cells: 0, spawns: 0, hits: 0, got: 0, mh: 0, cs: 0, csNo: 0, cu: 0, kf: 0, recs: 0, steps: 0, badIntent: 0, syncGens: 0 };
    G.world.dirty = new Set();
    // stage 10 (9.5): hardcore guests who died this session (by player id and name: a renamed rejoin still
    // spectates), the slots spectating, each guest's player id; farm rows to send (9.4)
    this.hcDead = { pids: new Set(), names: new Set() };
    this.spec = new Set(); this.pids = new Map();
    this.fmq = new Map();
  }
  get room() { return this.S.room; }
  get W() { return G.world; }

  // ------------------------------------------------------------ players
  proxy(k) {
    const av = this.S.live.get(k), r = this.room && this.room.roster.get(k);
    if (!av || !av.known || !r || r.away || av.away) return null;
    return av;
  }
  players() {
    const out = [G.P];   // (a fresh array: the game's loops over players may nest)
    for (const k of [1, 2, 3]) { const p = this.proxy(k); if (p) out.push(p); }
    return out;
  }
  slotOf(p) { return p === G.P ? 0 : p.slot; }
  // a spectator (9.5, stage 10): the host after its hardcore death, or a guest the dead list or its own M frames say is one
  isSpec(k) {
    if (k === 0) return !!(G.mr && G.mr.mode === 'spectator');
    if (this.spec.has(k)) return true;
    const r = this.room && this.room.roster.get(k), pid = this.pids.get(k);
    if ((r && this.hcDead.names.has(String(r.name || '').toUpperCase())) || (pid && this.hcDead.pids.has(pid))) { this.spec.add(k); return true; }
    const av = this.S.live.get(k);
    return !!(av && av.spectator);
  }
  specP(p) { return !!p && (p === G.P ? this.isSpec(0) : !!p.spectator || this.isSpec(p.slot)); }
  // (generated layouts: the same place, 2.10; biomes are not places, so a guest one biome away keeps its mobs)
  sameRegion(ax, ay, bx, by) { const W = this.W; if (W.layout.gen) return W.samePlace(ax, ay, bx, by); return (W.isOutdoor(ax, ay) && W.isOutdoor(bx, by)) || W.areaOf(ax, ay) === W.areaOf(bx, by); }
  // Generated layouts (9.2, 9.3): a cell the host is about to read for a guest is made first if its chunk is not
  // ready here (should never happen: every guest's surroundings stream ahead; counted for the tests). Classic: no-op.
  readyCell(i) {
    const W = this.W;
    if (!W.cstate) return;
    const x = i % W.W, y = (i / W.W) | 0;
    if (!W.ready(x, y) && W.inside(x, y)) { W.ensureAround(x, y, 0, true); this.c.syncGens++; }
  }
  // a cell as the guests are told it: [cell, tile, block | 0]
  cellNow(i) { const W = this.W; this.readyCell(i); return [i, W.grid[i], W.blockAt(i) || 0]; }
  busy(p) { return p === G.P ? G.busy() || docHidden() : !!p.busy; }
  vuln(p) {
    if (!p || p.dead || p.voidFall) return false;
    if (this.specP(p)) return false;   // (stage 10: a spectator is nobody's to hurt)
    if (p === G.P) return !!(NET.bridge && NET.bridge.live()) && !docHidden();
    // (a guest who left is no longer anyone's target, even if something still holds its old avatar)
    return !p.busy && !p.away && !!p.known && this.S.live.get(p.slot) === p && !!(this.room && this.room.roster.has(p.slot));
  }
  // the player a mob goes for: the one that hit it (while it can), else the nearest that can be seen
  target(m) {
    const ok = (p) => p && !p.dead && !p.voidFall && !this.busy(p) && !p.hidden && !this.specP(p) && this.sameRegion(p.tx, p.ty, m.tx, m.ty);   // (stage 10: not a creative player or a spectator)
    if (m.aggroSlot != null) { const p = m.aggroSlot === 0 ? G.P : this.proxy(m.aggroSlot); if (ok(p)) return p; }
    let best = null, bd = 1e9;
    for (const p of this.players()) { if (!ok(p)) continue; const d = Math.abs(p.tx - m.tx) + Math.abs(p.ty - m.ty); if (d < bd) { bd = d; best = p; } }
    return best || G.P;
  }
  // damage the host worked out for a player: Steve here as single-player does, a guest by a 'hit' it applies itself
  hurt(p, dmg, cause, from, ranged, opts, extra) {
    if (!p) return false;
    if (p === G.P) {
      if (extra.inv0) p.invuln = 0;
      const text = NET.s ? NET.s.causeText(cause, p.name) : String(cause);
      const r = G.hurtPlayer(dmg, text, from, ranged, opts);
      if (r && extra.fire) p.fireT = Math.max(p.fireT || 0, extra.fire);
      if (r && extra.slow) p.slowT = Math.max(p.slowT || 0, extra.slow);   // a stray's arrow (5d)
      return r;
    }
    if (!this.vuln(p)) return false;
    const f = from ? [from.tx ?? Math.floor(from.x / TILE), from.ty ?? Math.floor(from.y / TILE)] : 0;
    this.room.reliable(p.slot, 'hit', Math.round(dmg * 100) / 100, cause, f, opts || {}, { inv0: extra.inv0 ? 1 : 0, fire: extra.fire || 0, kn: extra.kn || 0, ...(extra.slow ? { slow: extra.slow } : {}) });
    this.c.hits++;
    return true;
  }
  // a player whose middle is within r pixels of (x, y) (or inside the box ax by ay) and can be hurt
  victim(x, y, r, ax, ay) {
    for (const p of this.players()) {
      if (!this.vuln(p)) continue;
      const dx = p.fx * TILE + 8 - x, dy = p.fy * TILE + 8 - y;
      if (ax ? Math.abs(dx) < ax && Math.abs(dy) < ay : Math.hypot(dx, dy) < r) return p;
    }
    return null;
  }
  // dropped items and orbs: the nearest player who can take them
  picker(e) {
    let best = null, bd = 1e9;
    for (const p of this.players()) {
      if (p.dead || p.sleeping || p.voidFall || this.specP(p)) continue;   // (stage 10: a spectator picks nothing up)
      if (p === G.P ? !(NET.bridge && NET.bridge.live()) : p.busy >= 2) continue;
      const s = this.slotOf(p);
      if (e.skip && e.skip[s] > G.clock) continue;
      const d = Math.hypot(p.fx * TILE + 8 - e.x, p.fy * TILE + 10 - e.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  give(p, e) {
    if (e.type === 'xp') this.room.reliable(p.slot, 'got', 0, e.value);
    else this.room.reliable(p.slot, 'got', e.stack, 0);
    e.dead = true; this.c.got++;
  }
  anyIn(region) {
    const W = this.W, f = region === 'end' ? 'inEnd' : region === 'nether' ? 'inNether' : 'inStronghold';
    for (const p of this.players()) if (W[f](p.tx, p.ty)) return true;
    return false;
  }
  near(region, cell, r) {
    if (!cell) return null;
    const W = this.W, f = region === 'end' ? 'inEnd' : region === 'nether' ? 'inNether' : 'inStronghold';
    for (const p of this.players()) if (W[f](p.tx, p.ty) && Math.hypot(p.tx - cell[0], p.ty - cell[1]) <= r) return p;
    return null;
  }
  othersIn(map) { const W = this.W; for (const p of this.players()) if (p !== G.P && W.mapAt(p.tx, p.ty) === map) return true; return false; }
  // arriveArea's filter: what a guest is still beside stays
  keep(e) {
    const W = this.W;
    if (W.layout.gen) {
      const [cx, cy] = e.type === 'fireball' ? [Math.floor(e.x / TILE), Math.floor(e.y / TILE)] : [e.tx, e.ty], key = W.regionKey(cx, cy);
      for (const p of this.players()) if (p !== G.P && W.regionKey(p.tx, p.ty) === key) return true;
      return false;
    }
    const area = e.type === 'wild' ? e.map : e.type === 'fireball' ? W.areaOf(Math.floor(e.x / TILE), Math.floor(e.y / TILE)) : W.areaOf(e.tx, e.ty);
    for (const p of this.players()) if (p !== G.P && W.areaOf(p.tx, p.ty) === area) return true;
    return false;
  }
  // a step began (entities.js stepMob and knockback, wild.js stepTo): the guests play it exactly
  step(e, dur) {
    if (e.nid == null) return;
    const st = e._st || (e._st = []);
    st.push([e.fromX, e.fromY, e.tx, e.ty, Math.round(this.S.clock), Math.round(dur * 1000 * this.S.rate)]);   // (wall ms: see Session.pre)
    if (st.length > 8) st.shift();
  }
  kill(m, def) { this.room.reliable(m.bySlot, 'kill', m.kind, def.hostile ? 1 : 0, m.byPlayer ? 1 : 0); }
  adv(slot, key) { if (!slot) { if (G.advance) G.advance(key); return; } this.room.reliable(slot, 'adv', key); }
  advIn(region, key) { const W = this.W, f = region === 'end' ? 'inEnd' : 'inNether'; for (const p of this.players()) if (p !== G.P && W[f](p.tx, p.ty)) this.adv(p.slot, key); }
  fx(ev) { if (this.fxq.length < 64) this.fxq.push(ev); }
  ensureNid(e) { if (e.nid == null) e.nid = ++this.nidN; return e.nid; }
  byNid(nid) { if (!isInt(nid)) return null; for (const e of G.ents) if (e.nid === nid && !e.dead) return e; return null; }

  // ------------------------------------------------------------ wild battles, the legend, the dragon, boats
  engage(e, p, ambush) {
    if (!p || !p.slot || e.gone) return;
    this.ensureNid(e);
    e.gone = true; e.lock = p.slot;
    this.room.reliable(p.slot, 'enc', e.nid, e.species, e.level, e.shiny ? 1 : 0, e.swim ? 1 : 0, ambush ? 1 : 0);
  }
  legendLock(slot) { if (this.legend != null && this.legend !== slot) return false; this.legend = slot; return true; }
  legendFree(slot) { if (this.legend === slot) this.legend = null; }
  dragonOk(p) { return !!p && this.W.inEnd(p.tx, p.ty) && !p.dead && !p.voidFall && this.vuln(p); }
  dragonTarget(D, I) {
    let best = null, bd = 1e9;
    for (const p of this.players()) {
      if (!this.dragonOk(p) || Math.hypot(p.tx - I.cx, p.ty - I.cy) > I.r + 1) continue;
      const d = D ? Math.hypot(p.fx - D.x, p.fy - D.y) : 0;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  boardSelf(boat, on) { if (boat) boat.rider = on ? 0 : null; }
  // a boat a guest rides goes where that guest is
  boats() {
    for (const e of G.ents) {
      if (e.type !== 'boat' || e.rider == null || e.rider === 0) continue;
      const p = this.proxy(e.rider);
      if (!p) { e.rider = null; continue; }
      if (p.riding && this.W.isWater(p.tx, p.ty)) { e.tx = p.tx; e.ty = p.ty; e.fx = p.fx; e.fy = p.fy; e.dir = p.dir; }
    }
  }

  // ------------------------------------------------------------ sleeping: the night passes when everyone in the
  // Overworld is in bed (2.6 s, as single-player); the host referees (night, one sleeper per bed)
  sleepers(dt) {
    const W = this.W, B = NET.bridge;
    const over = (p) => !W.inNether(p.tx, p.ty) && !W.inEnd(p.tx, p.ty);
    const night = G.time >= 12542 && G.time < 23460;
    const ps = this.players().filter((p) => over(p) && !p.dead && !this.specP(p));   // (stage 10: spectators never sleep)
    let n = 0, all = ps.length > 0;
    const beds = new Map();
    for (const p of ps) {
      const s = this.slotOf(p);
      // (a guest's bed must still be there: its head cell holds a bed)
      const bedOk = (q) => { const b = q.sleeping && W.block(q.sleeping.hx, q.sleeping.hy); return !!b && b.id === 'white_bed'; };
      const asleep = p === G.P ? !!(B && B.sleeping()) : !!p.sleeping && bedOk(p);
      if (!asleep) { this.sleepT.delete(s); this.unbedSent.delete(s); all = false; continue; }
      const key = p.sleeping ? p.sleeping.hx + ',' + p.sleeping.hy : '';
      if (p !== G.P && !this.unbedSent.has(s)) {
        // (the host re-checks: it must be night here too, and nobody else may be in that bed)
        const other = beds.get(key);
        if (!night) { this.room.reliable(s, 'unbed', 'You can sleep only at night'); this.unbedSent.set(s, 1); all = false; continue; }
        if (other != null && other !== s) { this.room.reliable(s, 'unbed', 'This bed is occupied'); this.unbedSent.set(s, 1); all = false; continue; }
      }
      if (this.unbedSent.has(s)) { all = false; continue; }
      if (key) beds.set(key, s);
      this.sleepT.set(s, (this.sleepT.get(s) || 0) + dt);
      n++;
      if (this.sleepT.get(s) < 2.6) all = false;
    }
    const sl = [n, ps.length];
    this.S.sleepCount = n > 0 ? sl : null;
    const str = n > 0 ? sl.join() : '';
    if (str !== this.slSent) { this.slSent = str; this.slDirty = true; }
    if (all && night) this.morning(ps);
  }
  morning(ps) {
    const W = this.W;
    G.time = 0; G.day++;
    // the night's monsters go, in the Overworld only (a friend in the Nether keeps its ghasts)
    G.ents = G.ents.filter((e) => !(e.type === 'mob' && E.HOSTILE.has(e.kind) && e.kind !== 'creeper' && e.kind !== 'spider' && !W.inNether(e.tx, e.ty) && !W.inEnd(e.tx, e.ty)));
    for (const p of ps) if (p !== G.P) this.room.reliable(p.slot, 'wake');
    if (NET.bridge) NET.bridge.coopWake();
    this.sleepT.clear();   // (the time sync goes out at the next tick: the session sees the day change)
  }

  // ------------------------------------------------------------ guests joining and leaving
  peer(k) {
    let pr = this.peers.get(k);
    if (!pr) { pr = { slot: k, sent: new Map(), kf: true, kfAt: this.S.clock + KF_EVERY, open: null, fv: '', dr: false }; this.peers.set(k, pr); }
    return pr;
  }
  peerJoined(k) { this.peers.delete(k); this.trail.delete(k); this.peer(k).kf = true; }
  peerBack(k) { this.peer(k).kf = true; }
  peerLeft(k) {
    this.peers.delete(k); this.trail.delete(k);
    this.spec.delete(k); this.pids.delete(k);   // (the dead list keeps its id and name for the session)
    for (const e of G.ents) if (e.tradeOpen) e.tradeOpen.delete(k);
    this.freeLocks(k);
    this.sleepT.delete(k); this.unbedSent.delete(k);
  }
  freeLocks(k) {
    for (const e of G.ents) {
      if (e.type === 'wild' && e.lock === k) { e.gone = false; e.lock = null; e.calm = 5; }
      if (e.type === 'boat' && e.rider === k) e.rider = null;
      if (e.type === 'mob' && e.aggroSlot === k) e.aggroSlot = null;
    }
    this.legendFree(k);
  }
  // the room closed: single-player again
  stop() {
    if (this.W) this.W.dirty = null;
    for (const e of G.ents) { if (e.type === 'wild' && e.gone && e !== G.battleSrc) { e.gone = false; e.lock = null; } if (e.type === 'boat' && e.rider) e.rider = null; e._st = null; }
    this.legend = null;
  }
  // the last B frame sent: an answer made now reflects everything up to it (and the dirty cells still to go)
  asOf() { return (this.room && this.room.seq.B) || 0; }
  snapshotExtra() {
    const x = { bs: (this.room && this.room.seq.B) || 0, lock: this.legend };
    if (this.hcDead.pids.size || this.hcDead.names.size) x.hcDead = { p: [...this.hcDead.pids], n: [...this.hcDead.names] };   // (stage 10, 9.5)
    return x;
  }

  // ------------------------------------------------------------ intents (from a guest, reliable, in order)
  intent(k, type, a) {
    if (!this.proxy(k) && type !== 'kf' && type !== 'rs' && type !== 'cl' && type !== 'pid') { if (!this.S.live.get(k)) { this.c.badIntent++; return; } }
    // a spectator (9.5): nothing but chat and leaving (the session's), and the reads a replica needs
    if (!SPEC_OK.has(type) && this.isSpec(k)) {
      this.c.specNo = (this.c.specNo || 0) + 1;
      // (what waits for an answer gets a refusal: a change put back, a container click undone)
      try {
        if (type === 'tx' && Array.isArray(a)) this.reject(k, 'spectator', a[0], Array.isArray(a[2]) ? a[2].map((c) => (Array.isArray(c) ? c[0] : -1)) : []);
        else if (type === 'cs' && Array.isArray(a)) this.room.reliable(k, 'cs', a[0], a[1], 0, null, 0, this.asOf());
        else if (type === 'tr' && Array.isArray(a)) this.room.reliable(k, 'trk', a[0], a[1], a[2], 0, 0);
      } catch (e) { report(e); }
      return;
    }
    this.inq.push([k, type, a]);
    if (this.inq.length > 400) this.inq.splice(0, 200);
  }
  // after the frame's messages and the avatars' movement are in: range checks use where the guest is now
  afterRecv() {
    const q = this.inq; this.inq = [];
    try { this.noteTrail(); } catch (e) { report(e); }
    for (const [k, type, a] of q) {
      try { this.handle(k, type, a); } catch (e) { this.c.badIntent++; report(e); }
    }
    // the host's own chest or furnace screen on a block a guest's change took away (broken, blown up): it closes
    // (its contents just went into the world as drops; taking them from the stale screen too would copy them)
    if (q.length) { try { this.screenGone(); } catch (e) { report(e); } }
    try { this.boats(); } catch (e) { report(e); }
  }
  handle(k, type, a) {
    const p = this.S.live.get(k);
    switch (type) {
      case 'tx': return this.tx(k, p, ...a);
      case 'mh': return this.mobHit(k, p, ...a);
      case 'ma': return this.mobAct(k, p, ...a);
      case 'bb': return this.breakBoat(k, p, a[0]);
      case 'bd': return this.boardReq(k, p, a[0]);
      case 'ub': return this.unboardReq(k, p, ...a);
      case 'df': return this.deflect(k, p, ...a);
      case 'dh': return this.dragonHit(k, p, ...a);
      case 'cr': return this.crystal(k, p, ...a);
      case 'lg': return this.legendReq(k, p);
      case 'lge': if (this.legend === k) { END_safe(() => DR.battleOver(String(a[0]))); this.legendFree(k); } return;
      case 'en': return this.engageReq(k, p, a[0]);
      case 'we': return this.wildOver(k, ...a);
      case 'op': { const pr = this.peer(k); if (isInt(a[0]) && isInt(a[1])) { pr.open = { x: a[0], y: a[1] }; pr.fv = ''; } return; }
      case 'cl': this.peer(k).open = null; return;
      case 'cs': return this.container(k, p, ...a);
      case 'ex': return this.explodeReq(k, p, ...a);
      case 'rsp': return this.respawnAt(...a);
      case 'kf': this.peer(k).kf = true; this.c.kf++; return;
      case 'rs': return this.catchUp(k, a[0]);
      case 'tro': return this.tradeOpen(k, p, a[0]);
      case 'tr': return this.trade(k, p, ...a);
      case 'trc': { const m = this.byNid(a[0]); if (m && m.tradeOpen) m.tradeOpen.delete(k); if (m && m.kind === 'villager' && m.tradeBy === k) { m.tradeBy = null; m.hold = Math.min(m.hold || 0, 0.5); } return; }
      case 'hcd': return this.hcDied(k, a[0], a[1]);
      case 'pid': if (typeof a[0] === 'string' && /^[0-9a-f]{16}$/.test(a[0])) { this.pids.set(k, a[0]); this.isSpec(k); } return;
      case 'bel': return this.bell(k, p, a[0], a[1]);
      default: this.c.badIntent++;
    }
  }
  inReach(p, x, y, r = REACH) { return !!p && Math.max(Math.abs(x - p.tx), Math.abs(y - p.ty)) <= r; }
  // each guest's recent cells (its live avatar's, noted every frame before the intents are handled)
  noteTrail() {
    const now = this.S.clock;
    for (const [k, av] of this.S.live) {
      if (!av.known) continue;
      let t = this.trail.get(k);
      if (!t) { t = []; this.trail.set(k, t); }
      const last = t[t.length - 1];
      if (!last || last[1] !== av.tx || last[2] !== av.ty) t.push([now, av.tx, av.ty]); else last[0] = now;
      while (t.length > 1 && (now - t[0][0] > TRAIL_MS || t.length > 64)) t.shift();
    }
  }
  wasNear(p, x, y, r) {
    const t = p && this.trail.get(p.slot);
    if (!t) return false;
    for (const [at, tx, ty] of t) if (this.S.clock - at <= TRAIL_MS && Math.max(Math.abs(x - tx), Math.abs(y - ty)) <= r) return true;
    return false;
  }
  reject(k, why, n, cells, extra) {
    this.c.txNo++;
    if (this.rejects.length < 200) this.rejects.push({ why, slot: k, cell: cells && cells[0], at: Math.round(this.S.clock) });
    const W = this.W;
    const now = (cells || []).filter((i) => okCell(i)).map((i) => this.cellNow(i));
    const end = {}; for (const key of ['egg', 'eggHops']) end[key] = G.end[key] ?? null;
    this.room.reliable(k, 'no', n, now, end, why, extra || 0, this.asOf());
  }
  // a guest's block changes, its new entities and its End keys: checked, then all of it or none of it
  tx(k, p, n, pre, post, sp, end, inv) {
    this.c.tx++;
    const W = this.W;
    const cells = Array.isArray(post) ? post.map((c) => (Array.isArray(c) ? c[0] : -1)) : [];
    const why = this.check(p, pre, post, sp, end);
    if (why) { this.reject(k, why, n, cells); return; }
    for (const [i, t, b] of post) {
      const x = i % W.W, y = (i / W.W) | 0;
      if (W.grid[i] !== t) W.setTile(x, y, t);
      putBlock(W, x, y, b ? b : null);
    }
    this.c.cells += post.length;
    for (const s of sp || []) this.spawn(k, p, s);
    if (end) for (const key of Object.keys(end)) G.end[key] = clone(end[key][1]);
    this.keepInv(k, inv);
    this.c.txOk++;
    this.room.reliable(k, 'ok', n);
  }
  // what a guest carries now, sent with an accepted change that moved items: kept in its record at once
  keepInv(k, x) {
    if (!x || typeof x !== 'object' || !isInt(x.v) || !x.inv || typeof x.inv !== 'object') return;
    const r = this.room && this.room.roster.get(k), rec = r ? this.S.record(r.name) : null;
    if (!rec) return;
    const inv = x.inv;
    if (!Array.isArray(inv.slots) || inv.slots.length > 40 || (inv.armor != null && (!Array.isArray(inv.armor) || inv.armor.length > 4))) return;
    try { if (JSON.stringify(inv).length > 16384) return; } catch (e) { return; }
    if ((rec._iv || 0) > x.v) return;
    rec.inv = { slots: inv.slots, armor: inv.armor || [null, null, null, null], sel: isInt(inv.sel) ? inv.sel : 0 };
    rec._iv = x.v;
    if (rec.P && Array.isArray(x.xp) && x.xp.length === 3 && x.xp.every((v) => num(v, 0, 1e7))) [rec.P.level, rec.P.xpProgress, rec.P.xpTotal] = x.xp;
    // its death drop: the record says it died (it comes back on its death screen, carrying what this says)
    if (rec.P && x.dead === 1) { rec.P.dead = 1; rec.P.health = 0; }
  }
  // the host's open container screen whose block is no longer in the world
  screenGone() {
    const B = NET.bridge, scr = B && B.screen();
    if (!scr || !scr.target || typeof scr.target !== 'object' || !scr.target.id) return;
    for (const v of this.W.blocks.values()) if (v === scr.target) return;
    B.closeScreen();
  }
  check(p, pre, post, sp, end) {
    const W = this.W;
    if (!p || !p.known) return 'noplayer';
    if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length || post.length > 160) return 'shape';
    const creative = !!(W.wd && W.wd.mode === 'creative');
    if (sp != null && (!Array.isArray(sp) || sp.length > 96)) return 'spawns';   // (a death drops up to 40 stacks and its orbs)
    for (let j = 0; j < post.length; j++) {
      const a = pre[j], b = post[j];
      if (!Array.isArray(a) || !Array.isArray(b) || a[0] !== b[0] || !okCell(b[0]) || !okTile(a[1]) || !okTile(b[1]) || typeof a[2] !== 'string' || !okBlock(b[2])) return 'cell';
      const i = b[0], x = i % W.W, y = (i / W.W) | 0;
      if (!this.inReach(p, x, y)) return 'range';
      this.readyCell(i);
      // protected cells: a building's own tiles never change; its door only between closed and open
      if (b[1] !== W.grid[i] || b[1] !== a[1]) {
        const pr = W.protAt(x, y);
        if (pr === PROT.DOOR) { const d = W.doorAt(x, y); if (!d || (b[1] !== d.closed && b[1] !== d.open)) return 'protected'; }
        else if (pr && !(W.stronghold && W.stronghold.entrance && W.stronghold.entrance.x === x && W.stronghold.entrance.y === y)) return 'protected';
      }
      // compare-and-set against the host's world: somebody else got there first
      if (W.grid[i] !== a[1] || contentKey(W.blockAt(i)) !== a[2]) return 'cas';
      // a creative world (6.1, 9.5; stage 10): its protected blocks stay, whoever's page let them go
      if (creative) { const hb = W.blockAt(i); if (hb && (CREATIVE_KEEP.has(hb.id) || /^infested_/.test(hb.id)) && contentKey(b[2] || null) !== a[2]) return 'protected'; }
    }
    if (end != null) {
      if (typeof end !== 'object' || Array.isArray(end)) return 'end';
      for (const key of Object.keys(end)) {
        if (key !== 'egg' && key !== 'eggHops') return 'endkey';
        const v = end[key];
        if (!Array.isArray(v) || JSON.stringify(v[0] ?? null) !== JSON.stringify(G.end[key] ?? null)) return 'endcas';
      }
    }
    for (const s of sp || []) if (!this.okSpawn(p, s)) return 'spawn';
    return null;
  }
  okSpawn(p, s) {
    if (!Array.isArray(s) || typeof s[0] !== 'string') return false;
    // (or near where the guest was in the last few seconds: a death drop is checked against where it fell, even
    // when its respawn teleport came in the same message)
    const near = (x, y) => { const cx = Math.floor(x / TILE), cy = Math.floor(y / TILE); return this.inReach(p, cx, cy, 18) || this.wasNear(p, cx, cy, 18); };
    switch (s[0]) {
      case 'i': return okItem(s[1]) && isInt(s[2]) && s[2] >= 1 && s[2] <= 64 && num(s[4], -1e6, 1e7) && num(s[5], -1e6, 1e7) && near(s[4], s[5]);
      case 'o': return isInt(s[1]) && s[1] >= 1 && s[1] <= 20000 && num(s[2], -1e6, 1e7) && num(s[3], -1e6, 1e7) && near(s[2], s[3]);
      case 'm': return s[1] === 'silverfish' && isInt(s[2]) && isInt(s[3]) && this.inReach(p, s[2], s[3]);
      case 't': return isInt(s[1]) && isInt(s[2]) && this.inReach(p, s[1], s[2]) && num(s[3], 0, 10);
      case 'b': return isInt(s[1]) && isInt(s[2]) && this.inReach(p, s[1], s[2]);
      case 'a': return num(s[1], -1e6, 1e7) && num(s[2], -1e6, 1e7) && near(s[1], s[2]) && num(s[6], 0, 40);
      default: return false;
    }
  }
  spawn(k, p, s) {
    const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
    this.c.spawns++;
    switch (s[0]) {
      case 'i': {
        const [, id, n, extra, x, y, z, vx, vy, vz, delay, skip] = s;
        const st = { id, n };
        if (extra && isInt(extra.dmg)) st.dmg = extra.dmg;
        const e = { type: 'item', stack: st, x, y, z: fin(z, 4), vx: fin(vx), vy: fin(vy), vz: fin(vz), age: 0, delay: num(delay, 0, 10) ? delay : 0.5, spin: Math.random() * 6 };
        if (skip) e.skip = { [k]: G.clock + 10 };
        G.ents.push(e); return;
      }
      case 'o': { const [, v, x, y, z, vx, vy, vz] = s; G.ents.push({ type: 'xp', value: v, x, y, z: fin(z, 3), vx: fin(vx), vy: fin(vy), vz: fin(vz), age: 0, delay: 0.4 }); return; }
      case 'm': { if (!E.cellFree(s[2], s[3])) return; const m = E.spawnMob('silverfish', s[2], s[3]); m.angry = true; m.aggroSlot = k; return; }
      case 't': G.ents.push({ type: 'tnt', tx: s[1], ty: s[2], fuse: s[3], t: 0 }); if (NET.near(s[1], s[2])) mc('fuse', { vol: 1 }); return;
      case 'b': G.ents.push({ type: 'boat', tx: s[1], ty: s[2], fx: s[1], fy: s[2], dir: ['up', 'down', 'left', 'right'].includes(s[3]) ? s[3] : 'down' }); return;
      case 'a': {
        const [, x, y, vx, vy, dir, dmg, crit] = s;
        G.ents.push({ type: 'arrow', x, y, vx: fin(vx), vy: fin(vy), dir: DIRS[dir] ? dir : 'down', dmg, fromPlayer: true, owner: p, ownerSlot: k, life: 0, stuck: 0, crit: !!crit });
        if (NET.near(x / TILE, y / TILE)) mc('bow', { vol: 0.8, pitch: 1 / (0.8 + Math.random() * 0.4) + 0.2 });
        return;
      }
      default:
    }
  }
  mobHit(k, p, nid, dmg, from, o) {
    const m = this.byNid(nid);
    this.c.mh++;
    if (!m || m.type !== 'mob' || m.dying || !num(dmg, 0, 60) || !this.inReach(p, m.tx, m.ty, 4)) return;
    o = o && typeof o === 'object' ? o : {};
    const f = Array.isArray(from) && isInt(from[0]) && isInt(from[1]) ? { x: from[0], y: from[1] } : null;
    if (E.hurtMob(m, dmg, f, { crit: !!o.crit, knock: o.knock === 2 ? 2 : 1, player: true, melee: !!o.melee })) {
      m.aggroSlot = m.bySlot = k;
      if (m.dying) m.byPlayer = true;
    }
  }
  mobAct(k, p, nid, act) {
    const m = this.byNid(nid);
    if (!m || m.type !== 'mob' || m.dying || !this.inReach(p, m.tx, m.ty, 3)) return;
    if (act === 'shear' && m.kind === 'sheep' && !m.sheared) { m.sheared = true; E.dropItem('white_wool', 1 + Math.floor(Math.random() * 3), m.tx * TILE, m.ty * TILE); }
    else if (act === 'wet') E.wetMob(m);
  }
  breakBoat(k, p, nid) {
    const b = this.byNid(nid);
    if (!b || b.type !== 'boat' || (b.rider != null && b.rider !== k) || !this.inReach(p, b.tx, b.ty, 3)) return;
    b.dead = true;
    E.dropItem('oak_boat', 1, b.tx * TILE, b.ty * TILE);
  }
  boardReq(k, p, nid) {
    const b = this.byNid(nid);
    const ok = !!b && b.type === 'boat' && (b.rider == null || b.rider === k) && !(G.P.riding === b) && this.inReach(p, b.tx, b.ty, 3);
    if (ok) b.rider = k;
    this.room.reliable(k, 'bdk', nid, ok ? 1 : 0);
  }
  unboardReq(k, p, nid, x, y) {
    const b = this.byNid(nid);
    if (!b || b.type !== 'boat' || b.rider !== k) return;
    b.rider = null;
    if (isInt(x) && isInt(y) && this.W.isWater(x, y) && this.inReach(p, x, y, 3)) { b.tx = x; b.ty = y; }
    b.fx = b.tx; b.fy = b.ty;
  }
  deflect(k, p, nid, dir) {
    const f = this.byNid(nid);
    if (!f || f.type !== 'fireball' || !p || !DIRS[dir]) return;
    if (E.deflectFireball({ fx: p.fx, fy: p.fy, dir }, f)) { f.ownerSlot = k; f.owner = f.owner || null; }
  }
  dragonHit(k, p, dmg, src) {
    const D = DR.live();
    if (!D || !p || !this.W.inEnd(p.tx, p.ty) || !num(dmg, 0, 60) || Math.hypot(p.fx - D.x, p.fy - D.y) > 6) return;
    DR.hurtDragon(dmg, src === 'melee' ? 'melee' : 'arrow');
  }
  crystal(k, p, x, y) {
    const w = this.W;
    if (!isInt(x) || !isInt(y) || !w.end || !w.inEnd(x, y) || !this.inReach(p, x, y, 3)) return;
    const b = w.block(x, y), mat = w.mat(x, y);
    const ok = (b && (b.id === 'obsidian' || b.id === 'bedrock')) || (!b && (mat === 'obsidian_floor' || mat === 'bedrock' || mat === 'obsidian' || mat === 'end_pillar'));
    if (!ok || G.end.placed.some((c) => c.x === x && c.y === y)) { this.room.reliable(k, 'got', { id: 'end_crystal', n: 1 }, 0); return; }   // (refused: it comes back)
    G.end.placed.push({ x, y });
    END_safe(() => DR.checkRitual());
  }
  legendReq(k, p) {
    const D = DR.live();
    const ok = !!D && D.phase === 'exhausted' && !!p && this.W.inEnd(p.tx, p.ty) && this.legendLock(k);
    this.room.reliable(k, 'leg', ok ? 1 : 0);
  }
  engageReq(k, p, nid) {
    const e = this.byNid(nid);
    if (!e || e.type !== 'wild' || e.gone || !this.inReach(p, e.tx, e.ty, 3)) { this.room.reliable(k, 'encno', nid); return; }
    e.disguise = null;
    this.engage(e, p, false);
  }
  wildOver(k, nid, outcome) {
    const e = this.byNid(nid);
    if (!e || e.type !== 'wild' || e.lock !== k) return;
    e.lock = null;
    if (outcome === 'ran') { e.gone = false; e.calm = 15; e.state = 'idle'; return; }
    e.dead = true;
    if (outcome === 'win') { this.fx(['p', e.tx, e.ty]); if (NET.near(e.tx, e.ty)) E.poof(e.tx * TILE + 8, e.ty * TILE + 8); }
  }
  explodeReq(k, p, x, y, power, fire) {
    if (!isInt(x) || !isInt(y) || !num(power, 0.5, 5) || !this.inReach(p, x, y, 4)) return;
    G.explode(x, y, power, { kind: 'bed', cause: ['bed'], slot: k }, { fire: !!fire });
  }
  respawnAt(tx, ty) {
    if (!isInt(tx) || !isInt(ty)) return;
    G.ents = G.ents.filter((e) => !(e.type === 'mob' && E.HOSTILE.has(e.kind) && Math.abs(e.tx - tx) < 12 && Math.abs(e.ty - ty) < 10));
  }
  // a chest's or furnace's slots: each must still hold what the guest saw, then they all change
  container(k, p, x, y, ops, xp, inv) {
    this.c.cs++;
    const W = this.W, b = isInt(x) && isInt(y) ? W.block(x, y) : null;
    const KEYS = { in: 'input', fu: 'fuel', out: 'output' };
    const slotOk = (key) => (b.id === 'chest' ? isInt(key) && key >= 0 && key < (b.slots || []).length : !!KEYS[key]);
    const get = (key) => (b.id === 'chest' ? b.slots[key] : b[KEYS[key]]);
    const set = (key, v) => { if (b.id === 'chest') b.slots[key] = v; else b[KEYS[key]] = v; };
    let ok = !!b && (b.id === 'chest' || b.id === 'furnace') && this.inReach(p, x, y, 6) && Array.isArray(ops) && ops.length <= 40;
    if (ok) for (const op of ops) {
      if (!Array.isArray(op) || !slotOk(op[0]) || fullKey(get(op[0]) || null) !== op[1]) { ok = false; break; }
      const v = op[2];
      if (v && (typeof v !== 'object' || !okItem(v.id) || !isInt(v.n) || v.n < 1 || v.n > 64)) { ok = false; break; }
    }
    if (ok) { for (const [key, , v] of ops) set(key, v ? { ...v } : null); if (ops.length) W.touch(x, y); }
    let paid = 0;
    if (ok) this.keepInv(k, inv);
    if (ok && xp && b.id === 'furnace') { const v = b.xp || 0; b.xp = 0; if (v > 0) paid = Math.floor(v + Math.random() * 0.999); }
    if (!ok) this.c.csNo++;
    const slots = !b ? null : b.id === 'chest' ? b.slots : b.id === 'furnace' ? { in: b.input, fu: b.fuel, out: b.output } : null;
    this.room.reliable(k, 'cs', x, y, ok ? 1 : 0, slots, paid, this.asOf());
  }
  // ------------------------------------------------------------ trades (the world update 7c; design 9.4)
  // a villager a guest may trade with: a villager with a profession, awake, within 3 cells of the guest
  tradeVillager(p, nid) {
    const m = this.byNid(nid);
    if (!m || m.type !== 'mob' || m.kind !== 'villager' || m.dying || !G.tradeData || !this.inReach(p, m.tx, m.ty, 3)) return null;
    return m;
  }
  tradeState(m) { ensureState(m); return { vid: m.vid | 0, prof: m.prof || 'none', lvl: m.lvl, xp: m.xp, uses: { ...m.uses }, demand: { ...m.demand } }; }
  // 'tro': the guest opens its trade screen with the villager's state; it stands still for that guest
  tradeOpen(k, p, nid) {
    this.c.tro = (this.c.tro || 0) + 1;
    const m = this.tradeVillager(p, nid);
    const ok = !!m && !m.sleep && !NO_TRADES.has(m.prof || 'none');
    if (ok) { (m.tradeOpen = m.tradeOpen || new Set()).add(k); }   // (stage 10: whose screens show it)
    if (ok) { m.tradeBy = k; m.hold = Math.max(m.hold || 0, 30); m.path = null; if (p) m.dir = ['up', 'down', 'left', 'right'].find((d) => DIRS[d].x === Math.sign(p.tx - m.tx) && DIRS[d].y === Math.sign(p.ty - m.ty)) || m.dir; }
    this.room.reliable(k, 'tv', nid, ok ? 1 : 0, ok ? this.tradeState(m) : 0);
  }
  // 'tr': the guest traded `times` times on the offer with this key (its inventory already changed, a prediction);
  // the host checks the villager, the offer and its uses, books the trades (uses, xp, level-ups) and answers 'trk'.
  // A refusal makes the guest reverse its inventory change, exactly as a refused container click does.
  trade(k, p, n, nid, key, times, inv) {
    this.c.tr = (this.c.tr || 0) + 1;
    const m = this.tradeVillager(p, nid), data = G.tradeData;
    const o = m && typeof key === 'string' && key.length < 80 ? findOffer(m, data, key) : null;
    let ok = !!o && !m.sleep && isInt(times) && times >= 1 && times <= 64 && okItem(o.result) && okItem(o.costA) && (!o.costB || okItem(o.costB))
      && usesOf(m, o) + times <= o.maxUses;
    let leveled = false;
    if (ok) {
      for (let i = 0; i < times; i++) { const r = recordTrade(m, o, data); if (!r) { ok = false; break; } if (r.leveled) leveled = true; }
      m.hold = Math.max(m.hold || 0, 30); m.tradeBy = k;
      this.keepInv(k, inv);
      if (leveled && G.vil) { try { G.vil.celebrate(m); } catch (e) { report(e); } }
    }
    if (!ok) this.c.trNo = (this.c.trNo || 0) + 1;
    this.room.reliable(k, 'trk', n, nid, key, ok ? 1 : 0, m ? this.tradeState(m) : 0);
    // (stage 10) the other guests with this villager's screen open see its new state at once (n 0: not their trade)
    if (ok && m.tradeOpen) for (const k2 of m.tradeOpen) if (k2 !== k && this.room.roster.has(k2)) { this.room.reliable(k2, 'trk', 0, nid, key, 1, this.tradeState(m)); this.c.trPush = (this.c.trPush || 0) + 1; }
  }
  // the host's own screen on a chest or furnace: the guests see what it changed
  screen(scr, dt, input) {
    if (scr.kind === 'trade') { scr.update(dt, input); return; }   // (7c: a villager is not a block)
    const b = scr.target, W = this.W;
    if (scr._cell === undefined) { scr._cell = null; for (const [i, v] of W.blocks) if (v === b) { scr._cell = i; break; } }
    const k0 = contentKey(b);
    scr.update(dt, input);
    if (scr._cell != null && contentKey(b) !== k0) W.touch(scr._cell % W.W, (scr._cell / W.W) | 0);
  }
  // a guest missed some world frames: every cell changed since then (or the whole world's changes)
  catchUp(k, from) {
    this.c.cu++;
    const W = this.W;
    let cells, full = false;
    let list;
    // (full: every changed cell; generated layouts' cells of chunks not made here carry -1 for "generated", 9.3)
    if (!isInt(from) || !this.log.length || this.log[0].s > from) { full = true; list = W.overrideCells(); }
    else { cells = new Set(); for (const e of this.log) if (e.s >= from) for (const i of e.cells) cells.add(i); list = [...cells].map((i) => this.cellNow(i)); }
    const end = {}; for (const key of SHARED_END) end[key] = G.end[key] ?? null;
    const vf = G.vil && G.vil.farmsOut && this.W.layout.gen ? G.vil.farmsOut() : null;   // (stage 10: and the farm rows)
    const str = JSON.stringify({ full: full ? 1 : 0, cells: list, end, lock: this.legend, bs: (this.room.seq.B || 0), ...(vf ? { vf } : {}) });
    this.room.blob(k, 'cu', str).catch(report);
  }

  // ------------------------------------------------------------ stage 10: hardcore guests, the bell, farm rows
  // 'hcd': a hardcore guest died (9.5). Its player id and name go on the session's dead list (a rejoin, renamed or
  // not, spectates), its slot spectates from now on, and its record is cleared (a later session starts it fresh).
  hcDied(k, cause, pid) {
    const r = this.room && this.room.roster.get(k), wd = this.W.wd;
    if (!r || !wd || wd.mode !== 'hardcore') { this.c.badIntent++; return; }
    const name = String(r.name || '').toUpperCase();
    this.hcDead.names.add(name);
    if (typeof pid === 'string' && /^[0-9a-f]{16}$/.test(pid)) { this.hcDead.pids.add(pid); this.pids.set(k, pid); }
    const pk = this.pids.get(k); if (pk) this.hcDead.pids.add(pk);
    this.spec.add(k);
    if (G.coop && G.coop.players) delete G.coop.players[name];
    this.freeLocks(k);
    this.c.hcd = (this.c.hcd || 0) + 1;
    this.lastHcd = { slot: k, name, cause: typeof cause === 'string' ? cause.slice(0, 120) : '' };
  }
  // 'bel': a guest rang a village bell (5.10): the villagers near it go home, and the others near it hear it
  bell(k, p, x, y) {
    if (!isInt(x) || !isInt(y) || !this.inReach(p, x, y, 3)) return;
    const b = this.W.block(x, y);
    if (!b || b.id !== 'bell' || !G.vil) return;
    G.vil.ringBell(x, y, k);
    this.c.bells = (this.c.bells || 0) + 1;
  }
  // villagers.js harvestFarm: a farm's new row times, sent in the next B frame (and a joining guest's snapshot)
  farm(key, rows) { if (isInt(key) && Array.isArray(rows) && rows.length <= 8) this.fmq.set(key, rows); }

  // ------------------------------------------------------------ the network tick
  record(e) {
    switch (e.type) {
      case 'mob': return e.fly ? ['f', e.nid, e.kind, r100(e.fx), r100(e.fy), dirIdx(e.dir), mobFlags(e), e.size || 0]
        : ['m', e.nid, e.kind, e.look != null ? e.look + (e.sleep ? '|z' : '') : e.size || 0, e.tx, e.ty, dirIdx(e.dir), mobFlags(e)];   // (7b: a villager's or golem's look in the size field)
      case 'wild': return ['w', e.nid, e.species, e.shiny ? 1 : 0, e.tx, e.ty, dirIdx(e.dir), e.disguise || 0, e.emote > 0 ? 1 : 0, e.swim ? 1 : 0, e.gone ? 1 : 0];
      case 'item': return ['i', e.nid, e.stack.id, e.stack.n, Math.round(e.x), Math.round(e.y), Math.round(e.z), e.stack.dmg || 0];
      case 'xp': return ['o', e.nid, e.value, Math.round(e.x), Math.round(e.y), Math.round(e.z)];
      case 'arrow': return ['a', e.nid, Math.round(e.x), Math.round(e.y), Math.round(e.vx), Math.round(e.vy), e.stuck ? 1 : 0, dirIdx(e.dir)];
      case 'fireball': return ['b', e.nid, e.size === 'large' ? 1 : 0, Math.round(e.x), Math.round(e.y), Math.round(e.z), Math.round(e.vx), Math.round(e.vy)];
      case 'tnt': return ['t', e.nid, e.tx, e.ty, r10(e.fuse), r10(e.t)];
      case 'boat': return ['B', e.nid, r100(e.fx ?? e.tx), r100(e.fy ?? e.ty), dirIdx(e.dir), e.tx, e.ty, e.rider != null ? e.rider : G.P.riding === e ? 0 : -1];
      default: return null;
    }
  }
  cellOf(e) { return e.type === 'item' || e.type === 'xp' || e.type === 'arrow' || e.type === 'fireball' ? [Math.floor(e.x / TILE), Math.floor(e.y / TILE)] : [e.tx, e.ty]; }
  inAoi(e, c, p) {
    const big = e.type === 'mob' && e.kind === 'ghast', proj = e.type === 'arrow' || e.type === 'fireball';
    const rx = big ? 40 : proj ? 26 : 22, ry = big ? 30 : proj ? 20 : 16;
    return Math.abs(c[0] - p.tx) <= rx && Math.abs(c[1] - p.ty) <= ry && this.sameRegion(c[0], c[1], p.tx, p.ty);
  }
  // one guest's entities this tick: records that changed, the steps that started, those that left its view
  entities(pr, p, now) {
    const recs = [], steps = [], seen = new Set();
    let fast = false;
    for (const e of G.ents) {
      if (e.dead || !REPL.has(e.type)) continue;
      const c = this.cellOf(e);
      if (!this.inAoi(e, c, p)) continue;
      this.ensureNid(e);
      seen.add(e.nid);
      const rec = this.record(e);
      if (!rec) continue;
      const str = JSON.stringify(rec), old = pr.sent.get(e.nid);
      if (old !== str) { recs.push(rec); pr.sent.set(e.nid, str); }
      if ((e.type === 'mob' && !e.fly) || e.type === 'wild') {
        if (old === undefined) { if (e.moving) { const dur = (e.type === 'wild' ? e.step / (e.mul || 1) : e.step / (e.speedMul || 1)) * this.S.rate; steps.push([e.nid, e.fromX, e.fromY, e.tx, e.ty, Math.round(-(e.prog || 0) * dur * 1000), Math.round(dur * 1000)]); } }
        else if (e._st) for (const s of e._st) steps.push([e.nid, s[0], s[1], s[2], s[3], s[4] - now, s[5]]);
      } else if ((e.type === 'mob' && e.fly) || (e.type === 'boat' && e.rider != null)) { if (old !== str) fast = true; }
    }
    const gone = [];
    for (const nid of pr.sent.keys()) if (!seen.has(nid)) gone.push(nid);
    for (const nid of gone) pr.sent.delete(nid);
    return { recs, steps, gone, fast };
  }
  // room.onTick: just before this tick's message is built
  compose() {
    const room = this.room, W = this.W, now = Math.round(this.S.clock);
    if (!room || room.status !== 'open') return;
    // B: the cells that changed, the shared End state, effects, the sleep count
    if (W.dirty && W.dirty.size) {
      const cells = [...W.dirty]; W.dirty.clear();
      room.set('B', 'w', cells.map((i) => this.cellNow(i)));
      const s = (room.seq.B || 0) + 1;
      this.log.push({ s, cells, at: now });
      while (this.log.length && (now - this.log[0].at > LOG_MS || this.log.length > 900)) this.log.shift();
    }
    const patch = {};
    let any = false;
    for (const key of SHARED_END) {
      const str = JSON.stringify(G.end[key] ?? null);
      if (str !== this.endSent[key]) { patch[key] = G.end[key] ?? null; this.endSent[key] = str; any = true; }
    }
    if (this.legend !== this.legendSent) { patch._lock = this.legend; this.legendSent = this.legend; any = true; }
    if (any) room.set('B', 'e', patch);
    if (this.fxq.length) room.set('B', 'fx', this.fxq.splice(0));
    if (this.fmq.size) { room.set('B', 'fm', [...this.fmq]); this.fmq.clear(); }   // (stage 10: farm rows)
    if (this.slDirty) { this.slDirty = false; room.set('B', 'sl', this.slSent ? this.slSent.split(',').map(Number) : 0); }
    // Gk: each guest's entities, furnace and dragon
    let fast = false;
    const dragon = DR.netLive();
    for (const k of room.peers()) {
      const p = this.proxy(k);
      if (!p) continue;
      const pr = this.peer(k), g = {};
      // a keyframe: asked for (joining, coming back, a gap), or every 4 s riding a message that goes anyway
      let kf = pr.kf; pr.kf = false;
      if (kf) { pr.sent.clear(); pr.kfAt = now + KF_EVERY; }
      let part = this.entities(pr, p, now);
      const bHas = room.out.has('B') && Object.keys(room.out.get('B')).length > 0;
      if (!kf && now >= pr.kfAt && (part.recs.length || part.steps.length || part.gone.length || bHas)) {
        pr.sent.clear(); pr.kfAt = now + KF_EVERY; kf = true;
        part = this.entities(pr, p, now);
      }
      if (part.fast) fast = true;
      if (part.recs.length) g.en = part.recs;
      if (part.steps.length) g.st = part.steps;
      if (part.gone.length) g.g = part.gone;
      if (kf) g.kf = 1;   // (k is the stream's own key)
      this.c.recs += part.recs.length; this.c.steps += part.steps.length;
      // the furnace this guest has open: its progress (the slots come with the cell)
      if (pr.open) {
        const b = W.block(pr.open.x, pr.open.y);
        if (b && b.id === 'furnace') { const v = [pr.open.x, pr.open.y, b.burn || 0, b.burnMax || 0, b.cook || 0], s = v.join(); if (s !== pr.fv) { g.fv = v; pr.fv = s; } }
      }
      // the dragon, while this guest is in The End
      if (dragon && W.inEnd(p.tx, p.ty)) { g.dr = DR.netPacket(); pr.dr = true; fast = true; }
      else if (pr.dr) { g.dr = 0; pr.dr = false; }
      if (Object.keys(g).length) { g.gc = now; room.set('G' + k, 'gc', now); for (const key of Object.keys(g)) room.set('G' + k, key, g[key]); }
    }
    for (const e of G.ents) if (e._st) e._st = null;
    room.rate = fast ? 10 : 5;
  }
  info() {
    return { ...this.c, rejects: this.rejects.slice(-20), legend: this.legend, peers: [...this.peers.values()].map((p) => ({ slot: p.slot, sent: p.sent.size, open: p.open })), log: this.log.length };
  }
}
function END_safe(fn) { try { return fn(); } catch (e) { report(e); return undefined; } }
