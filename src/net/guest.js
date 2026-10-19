// A co-op guest's side of the shared world. The guest plays its own Steve with the game's own code against a
// replica of the host's world, and:
//   * keeps a shadow of the host-confirmed state of every cell; whatever its own code changes in a frame (setTile,
//     setBlock, touch, plus a safety net on the cell ahead and the cell it stands on) goes to the host as one
//     transaction with the cells' "before" taken from that shadow, together with the entities its code made (drops,
//     orbs, arrows, TNT, a boat, a silverfish) and the dragon egg's keys; the host applies all of it or none of it,
//     and a refusal puts the cells back and undoes the inventory change by count, never by slot;
//   * draws the host's entities from records and step events played through a short buffer, never running their AI;
//   * turns its actions on the host's things into intents (hits, shearing, boats, fireballs, the dragon, crystals,
//     wild battles, containers, a bed's blast, respawning) and applies what the host sends back (damage in its own
//     name, pickups, battles, the morning, catch-up).
// Design: multiplayer-design.md sections 6, 7, 9.6, 10, 12; deviations in section 26.
import { A } from '../assets.js';
import { G, TILE, DIRS } from '../game.js';
import { item } from '../items.js';
import * as E from '../entities.js';
import * as PL from '../player.js';
import * as DR from '../dragon.js';
import { mc } from '../audio.js';
import { NET } from './flag.js';
import { contentKey, stackKey, fullKey, clone, okCell, okTile, okBlock, okItem, okKind, okSpecies, isInt, num, FL, DL, putBlock } from './proto.js';
import { PLANE } from '../layout.js';
import { costA, demandOf, offersFor } from '../trades.js';
import { xpForLevel } from '../hud.js';

const SWEEP = new Set(['item', 'xp', 'boat', 'tnt', 'arrow', 'mob']);
const SHARED_END = ['crystals', 'placed', 'dragon', 'kills', 'respawned', 'exitActive', 'egg', 'eggHops'];
const bridge = () => NET.bridge;
function report(e) {
  const m = 'net guest: ' + String((e && e.stack) || e);
  G.errors = G.errors || [];
  if (G.errors.includes(m) || G.errors.length >= 30) return;   // (each error once: an error every frame floods nothing)
  G.errors.push(m);
  try { console.error(e); } catch (x) { /* no console */ }
}

// the host's clock as this page sees it: the smallest (arrival - send time) of recent frames is the offset, and
// the buffer covers how late frames (and the events batched in them) arrive past that
class NetClock {
  constructor() { this.samples = []; this.off = null; this.lates = []; this.D = 250; this.Dt = 250; }
  sample(now, gc, oldest = 0) {
    const s = now - gc;
    this.samples.push(s); if (this.samples.length > 64) this.samples.shift();
    const prev = this.off;
    this.off = Math.min(...this.samples);
    if (prev == null || Math.abs(s - prev) > 20000) { this.samples = [s]; this.off = s; this.lates = []; }
    this.lates.push(Math.max(0, s - this.off) + Math.max(0, -oldest));
    if (this.lates.length > 40) this.lates.shift();
    this.Dt = Math.min(700, Math.max(150, Math.max(...this.lates) + 60));
  }
  rt(now, dt) {
    if (this.off == null) return null;
    this.D += (this.Dt - this.D) * Math.min(1, dt * 2);
    return now - this.off - this.D;
  }
}

export class GuestWorld {
  constructor(S) {
    this.S = S;
    this.reps = new Map();             // nid -> replica (an object in G.ents the game's drawing code reads)
    this.shadowTile = null; this.shadowKey = new Map();
    this.pendingAfter = new Map();     // cell -> [tile, key, tx] this page's unconfirmed predictions
    this.stash = new Map();            // cell -> [tile, block, B seq] the host's state for a cell with a prediction pending
    this.cellSeq = new Map();          // cell -> the B frame that last set it (an older answer never overwrites it)
    this.pending = new Map();          // tx -> { cells: [[i, t, key]], delta, end }
    this.txN = 0;
    this.touched = new Set();
    this.out = [];                     // intents of this frame (sent after its transaction)
    this.bBuf = [];                    // world frames that came before the snapshot was in
    this.booted = false; this.bs = 0;
    this.clock = new NetClock();
    this.inv0 = null; this.end0 = null;
    this.scrOpen = null; this.csWait = null;
    this.invSeq = 0;                   // inventory states sent with transactions and container clicks (invState)
    this.lock = null;                  // who is in the legendary battle (host slot), or null
    this.kfAsked = -1e9;
    this.c = { tx: 0, ok: 0, no: 0, cells: 0, spawns: 0, stash: 0, applied: 0, recs: 0, steps: 0, gone: 0, kf: 0, cu: 0, hits: 0, got: 0, bad: 0, unknown: 0 };
    this.noLog = [];
    this.rt = null;
  }
  get room() { return this.S.room; }
  send(type, ...fields) { this.out.push([type, ...fields]); }

  // ------------------------------------------------------------ boot: the snapshot is in
  boot(d) {
    const W = G.world;
    this.shadowTile = W.grid.slice();
    this.shadowKey.clear();
    for (const [i, b] of W.blocks) this.shadowKey.set(i, contentKey(b));
    // generated layouts (9.2): the decorations of the chunks made so far, and every chunk made from now on
    if (W.cstate) {
      const C = PLANE.CHUNK, CW = PLANE.CW;
      for (let ck = 0; ck < W.deco.length; ck++) {
        const d = W.deco[ck];
        if (!d || W.cstate[ck] !== 2) continue;
        const x0 = (ck % CW) * C, y0 = Math.floor(ck / CW) * C;
        for (let k = 0; k < d.length; k++) if (d[k]) { const i = (y0 + (k >> 5)) * W.W + x0 + (k & 31), b = W.blockAt(i); if (b) this.shadowKey.set(i, contentKey(b)); else this.shadowKey.delete(i); }
      }
      W.onChunk = (cx, cy) => { try { this.fillShadow(cx, cy); } catch (e) { report(e); } };
    }
    this.bs = Number.isInteger(d.bs) ? d.bs : 0;
    this.lock = d.lock ?? null;
    this.booted = true;
    W.capture = (i) => this.touched.add(i);
    const buf = this.bBuf; this.bBuf = [];
    for (const p of buf) this.frameB(p);
    this.inv0 = this.sig(); this.end0 = this.endSig();
    this.askKf(true);   // the host's entities near here, all of them, as soon as it knows where this player is
  }

  // Generated layouts (9.2): a chunk this page just made (overworld-local cx, cy) is the host-confirmed state of its
  // cells (the host's changes that arrived before it already wait in the override maps and are applied with it)
  fillShadow(cx, cy) {
    const W = G.world, C = PLANE.CHUNK, x0 = cx * C + PLANE.OX, y0 = cy * C;
    if (!this.shadowTile) return;
    for (let ly = 0; ly < C; ly++) for (let lx = 0; lx < C; lx++) {
      const i = (y0 + ly) * W.W + x0 + lx;
      if (this.pendingAfter.has(i)) continue;
      this.shadowTile[i] = W.grid[i];
      const b = W.blockAt(i);
      if (b) this.shadowKey.set(i, contentKey(b)); else this.shadowKey.delete(i);
    }
    this.c.shadowFills = (this.c.shadowFills || 0) + 1;
  }

  // ------------------------------------------------------------ per frame
  // frame start (after the frame's messages): this frame's "before" for the inventory and the egg, and the replicas
  pre(dt) {
    if (!this.booted) return;
    this.inv0 = this.sig(); this.end0 = this.endSig();
    // (cells touched since the last frame's transaction stay: a change made between frames goes in this one)
    const rt = this.clock.rt(this.S.clock, dt);
    this.rt = rt;
    if (rt != null) for (const r of [...this.reps.values()]) { try { this.play(r, rt, dt); } catch (e) { this.c.bad++; report(e); } }
  }
  // frame end: the transaction of whatever this frame changed, then its intents
  post() {
    if (!this.booted || !this.room || this.room.status === 'closed') { this.out = []; return; }
    this.txNow();
    for (const it of this.out) this.room.reliable(0, ...it);
    this.out = [];
  }
  // what this frame changed so far goes out now, as its own transaction (main.js respawn: the death drop leaves
  // before the player moves to its respawn point, so the host checks it where the player fell)
  flush() {
    if (!this.booted || !this.room || this.room.status === 'closed') return;
    this.txNow();
    this.inv0 = this.sig(); this.end0 = this.endSig();
  }
  txNow() {
    const W = G.world, P = G.P;
    try {
      // the safety net: the cell ahead and the cell underfoot, in case something changed in place with no hook
      const f = PL.facing(P);
      for (const [x, y] of [[f.x, f.y], [P.tx, P.ty]]) {
        if (!W.inside(x, y)) continue;
        const i = y * W.W + x;
        if (!this.touched.has(i) && this.differs(i)) this.touched.add(i);
      }
      // an open chest or furnace changes through its own compare-and-set ('cs'), never through a transaction
      const box = this.boxCells();
      const pre = [], post = [];
      for (const i of this.touched) {
        if (box.has(i)) continue;
        const bf = this.before(i), b = W.blockAt(i), t = W.grid[i];
        if (t === bf[0] && contentKey(b) === bf[1]) continue;
        pre.push([i, bf[0], bf[1]]); post.push([i, t, b ? clone(b) : 0]);
      }
      this.touched.clear();
      const sp = [];
      for (let j = G.ents.length - 1; j >= 0; j--) {
        const e = G.ents[j];
        if (e.nid != null || !SWEEP.has(e.type) || e.dead) continue;
        const s = this.spawnOf(e);
        if (s) sp.push(s);
        G.ents.splice(j, 1);
      }
      const end = {};
      const e1 = this.endSig();
      for (const k of ['egg', 'eggHops']) if (e1[k] !== this.end0[k]) end[k] = [JSON.parse(this.end0[k]), G.end[k] ?? null];
      const hasEnd = Object.keys(end).length > 0;
      if (pre.length || sp.length || hasEnd) {
        const n = ++this.txN;
        const cells = post.map(([i, t, b]) => [i, t, contentKey(b || null)]);
        const delta = this.delta(this.inv0, this.sig());
        this.pending.set(n, { cells, delta, end: hasEnd ? end : null, at: this.S.clock });
        for (const c of cells) this.pendingAfter.set(c[0], [c[1], c[2], n]);
        this.room.reliable(0, 'tx', n, pre, post, sp, hasEnd ? end : null, this.invState(delta));
        this.c.tx++; this.c.cells += pre.length; this.c.spawns += sp.length;
      }
    } catch (e) { report(e); this.touched.clear(); }
  }
  // what this player carries after a change the host is about to apply (items into the world or a container): the
  // host keeps it in this character's record at once, so a crash before the next record push cannot hand the
  // same items back on rejoining (the record would still have them). v orders it against the record pushes.
  invState(delta) {
    if (!delta || (!delta.gained.length && !delta.lost.length)) return 0;
    const P = G.P;
    // (dead: the death drop; the host's record then says so, so a crash on the death screen comes back dead)
    try { return { v: ++this.invSeq, inv: JSON.parse(JSON.stringify(G.inv.serialize())), xp: [P.level, P.xpProgress, P.xpTotal], ...(P.dead ? { dead: 1 } : {}) }; } catch (e) { report(e); return 0; }
  }
  // the container screen this page had open is gone (its block went, or the game closed it some other way): the
  // host stops sending its furnace, and its cell is no longer kept out of this page's transactions
  screenClosed() {
    if (!this.scrOpen) return;
    this.scrOpen = null;
    this.send('cl');
  }
  boxCells() {
    const W = G.world, out = new Set();
    const B = bridge();
    if (this.scrOpen && (!B || B.screen() !== this.scrOpen.scr)) this.screenClosed();
    if (this.scrOpen && this.scrOpen.x >= 0) out.add(this.scrOpen.y * W.W + this.scrOpen.x);
    if (this.csWait) out.add(this.csWait.y * W.W + this.csWait.x);
    return out;
  }
  before(i) {
    const p = this.pendingAfter.get(i);
    return p ? [p[0], p[1]] : [this.shadowTile[i], this.shadowKey.get(i) || ''];
  }
  differs(i) { const W = G.world, bf = this.before(i); return W.grid[i] !== bf[0] || contentKey(W.blockAt(i)) !== bf[1]; }
  endSig() { const o = {}; for (const k of ['egg', 'eggHops']) o[k] = JSON.stringify(G.end && G.end[k] !== undefined ? G.end[k] : null); return o; }

  // the inventory as a multiset of stacks (a tool's wear is part of its identity), and the change between two
  sig(cursor = null) {
    const m = new Map(), inv = G.inv;
    const add = (s) => { if (!s) return; const k = stackKey(s); m.set(k, (m.get(k) || 0) + s.n); };
    for (const s of inv.slots) add(s);
    for (const s of inv.armor) add(s);
    add(cursor);
    return m;
  }
  delta(a, b) {
    const gained = [], lost = [];
    for (const [k, n] of b) { const d = n - (a.get(k) || 0); if (d > 0) gained.push([k, d]); }
    for (const [k, n] of a) { const d = n - (b.get(k) || 0); if (d > 0) lost.push([k, d]); }
    return { gained, lost };
  }
  // a refused change: the inventory goes back by count (whatever it gained comes off, whatever it spent comes back)
  undo(delta, scr = null) {
    if (!delta) return;
    const inv = G.inv;
    for (const [k, n0] of delta.gained) {
      let n = n0;
      if (scr && scr.cursor && stackKey(scr.cursor) === k) { const t = Math.min(n, scr.cursor.n); scr.cursor.n -= t; n -= t; if (scr.cursor.n <= 0) scr.cursor = null; }
      for (let i = inv.slots.length - 1; i >= 0 && n > 0; i--) { const s = inv.slots[i]; if (s && stackKey(s) === k) { const t = Math.min(n, s.n); s.n -= t; n -= t; if (s.n <= 0) inv.slots[i] = null; } }
      for (let i = 0; i < 4 && n > 0; i++) { const s = inv.armor[i]; if (s && stackKey(s) === k) { inv.armor[i] = null; n -= 1; } }
    }
    for (const [k, n] of delta.lost) {
      let st;
      try { st = JSON.parse(k); } catch (e) { continue; }
      if (!st || !okItem(st.id)) continue;
      const extra = { ...st }; delete extra.id; delete extra.n;
      const left = inv.add(st.id, n, extra);
      if (left > 0) G.dropStack({ ...st, n: left }, false);
    }
  }
  // what this page's code put in the world, as a spawn for the host (it comes back as the host's entity)
  spawnOf(e) {
    const r = Math.round;
    switch (e.type) {
      case 'item': return ['i', e.stack.id, e.stack.n, e.stack.dmg ? { dmg: e.stack.dmg } : 0, r(e.x), r(e.y), r(e.z || 0), r(e.vx || 0), r(e.vy || 0), r(e.vz || 0), e.delay ?? 0.5, e.skipMe ? 1 : 0];
      case 'xp': return ['o', e.value, r(e.x), r(e.y), r(e.z || 0), r(e.vx || 0), r(e.vy || 0), r(e.vz || 0)];
      case 'mob': return e.kind === 'silverfish' ? ['m', 'silverfish', e.tx, e.ty, 0] : null;
      case 'tnt': return ['t', e.tx, e.ty, e.fuse];
      case 'boat': return ['b', e.tx, e.ty, e.dir];
      case 'arrow': return ['a', r(e.x), r(e.y), r(e.vx), r(e.vy), e.dir, e.dmg, e.crit ? 1 : 0];
      default: return null;
    }
  }

  // ------------------------------------------------------------ the host's world frames
  frameB(p) {
    if (!this.booted) { this.bBuf.push(p); if (this.bBuf.length > 900) this.bBuf.shift(); return; }
    if (isInt(p.s) && p.s <= this.bs) return;
    if (isInt(p.s)) this.bs = p.s;
    if (Array.isArray(p.w)) this.cells(p.w, isInt(p.s) ? p.s : 0);
    if (p.e && typeof p.e === 'object') this.endPatch(p.e);
    if (Array.isArray(p.fx)) for (const f of p.fx.slice(0, 64)) { try { this.effect(f); } catch (e) { this.c.bad++; } }
    if (p.sl !== undefined) this.S.sleepCount = Array.isArray(p.sl) ? p.sl : null;
    if (Array.isArray(p.fm)) this.farms(Object.fromEntries(p.fm.filter((r) => Array.isArray(r) && isInt(r[0])).slice(0, 64)));   // (stage 10)
  }
  // the farm rows the host's farmers replanted (stage 10): the wheat's stage here follows the host's
  farms(d) {
    if (!G.vil || !G.vil.farmsIn) return;
    try { this.c.farms = (this.c.farms || 0) + G.vil.farmsIn(d); } catch (e) { report(e); }
  }
  // the host's cells: from a B frame (seq s), or from an answer as of B frame `asOf` (a refusal, a catch-up), which
  // never overwrites what a later B frame already brought
  cells(list, s = 0, asOf = null) {
    for (const c of list) {
      if (!Array.isArray(c)) { this.c.bad++; continue; }
      const [i, t, b] = c;
      if (!okCell(i) || !okTile(t) || !okBlock(b)) { this.c.bad++; continue; }
      if (asOf != null && (this.cellSeq.get(i) || 0) > asOf) continue;
      if (this.pendingAfter.has(i)) {
        const st = this.stash.get(i);
        if (!(asOf != null && st && st[2] > asOf)) this.stash.set(i, [t, b || 0, asOf != null ? asOf : s]);
        this.c.stash++; continue;
      }
      if (s) this.cellSeq.set(i, s);
      this.applyCell(i, t, b || null);
    }
  }
  // the host's state of one cell (with this page's capture hook off): exact keys, the same object kept where it can be
  // (an open chest's screen holds it)
  applyCell(i, t, b, own = false) {
    const W = G.world, x = i % W.W, y = (i / W.W) | 0;
    const cap = W.capture; W.capture = null;
    try {
      // (before: what is there, a generated decoration included; live: the block object kept and changed in place,
      // never a generated decoration's frozen one. Classic: both are the blocks map's)
      const before = W.blockAt(i), live = W.blocks.get(i) || null;
      const beforeId = before ? before.id : null, wasOpen = before ? before.open : undefined;
      if (W.grid[i] !== t) W.setTile(x, y, t);
      if (b) {
        if (b.gen && W.deco) putBlock(W, x, y, b);
        else if (live && live.id === b.id) { for (const k of Object.keys(live)) if (!(k in b)) delete live[k]; Object.assign(live, b); W.setBlock(x, y, live); }
        else W.setBlock(x, y, b);
      } else if (before || (W.cstate && !W.ready(x, y))) W.setBlock(x, y, null);   // (a chunk not made here: its removal record)
      this.shadowTile[i] = t;
      if (b) this.shadowKey.set(i, contentKey(b)); else this.shadowKey.delete(i);
      this.c.applied++;
      // an open container whose block went
      const B = bridge(), scr = B && B.screen();
      if (scr && scr.target === before && (!b || beforeId !== b.id)) { B.closeScreen(); this.screenClosed(); }
      // a bed this player sleeps in went (broken, blown up): it wakes
      const P = G.P, sl = P && P.sleeping;
      if (sl && beforeId === 'white_bed' && (!b || b.id !== 'white_bed') && ((x === sl.hx && y === sl.hy) || (Array.isArray(before.other) && before.other[0] === sl.hx && before.other[1] === sl.hy))) PL.wake(P);
      if (!own) this.derived(x, y, beforeId, wasOpen, b);
    } finally { W.capture = cap; }
  }
  // what a change made by someone else sounds like here (only near this player)
  derived(x, y, beforeId, wasOpen, b) {
    if (!NET.near(x, y, 16)) return;
    if (beforeId && !b) {
      const it = item(beforeId), snd = (it && it.block && it.block.sound) || 'stone';
      if (beforeId !== 'fire' && beforeId !== 'lava') { mc('dig.' + snd, { vol: 0.5, pitch: 0.8 }); E.breakParticles(x * TILE, y * TILE, ['#8a8a8a', '#6a6a6a', '#a8a8a8'], 8); }
    } else if (b && beforeId === b.id && wasOpen !== undefined && b.open !== wasOpen) mc(b.open ? 'door_open' : 'door_close', { vol: 0.5 });
    else if (b && b.id === 'end_portal_frame' && b.eye && beforeId === b.id) mc('eye_place', { vol: 0.6 });
    else if (b && !beforeId) { const it = item(b.id), snd = (it && it.block && it.block.sound) || 'stone'; if (b.id !== 'fire' && b.id !== 'nether_portal' && b.id !== 'end_portal') mc('dig.' + snd, { vol: 0.35, pitch: 0.8 }); }
  }
  endPatch(e) {
    if (!G.end) return;
    const wasExit = G.end.exitActive;
    for (const k of SHARED_END) if (k in e) G.end[k] = clone(e[k]);
    if ('_lock' in e) this.lock = e._lock;
    // the exit portal opened under this player: step off before it takes him
    if (!wasExit && G.end.exitActive && G.world.isEndPortal(G.P.tx, G.P.ty)) G.endCool = true;
  }
  effect(f) {
    if (!Array.isArray(f)) return;
    if (f[0] === 'x' && isInt(f[1]) && isInt(f[2]) && num(f[3], 0, 10)) { const B = bridge(); if (B) B.explodeFx(f[1], f[2], f[3]); }
    else if (f[0] === 'c' && num(f[1], -1e6, 1e7) && num(f[2], -1e6, 1e7)) DR.crystalFx(f[1], f[2], f[3] || 12);
    else if (f[0] === 'p' && isInt(f[1]) && isInt(f[2]) && NET.near(f[1], f[2])) E.poof(f[1] * TILE + 8, f[2] * TILE + 8);
    // a village bell rung by someone else (stage 10): heard near it
    else if (f[0] === 'bell' && isInt(f[1]) && isInt(f[2]) && f[3] !== (this.room && this.room.slot) && NET.near(f[1], f[2], 32) && G.vil && G.vil.bellSound) { G.vil.bellSound(); this.c.bells = (this.c.bells || 0) + 1; }
  }
  // a missed world frame: everything since it again
  gap(ev) {
    if (ev.k === 'B' && ev.from === 0 && this.booted) this.send('rs', ev.first);
    else if (ev.k === 'G' && ev.from === 0) this.askKf();
  }
  resumed() { if (!this.booted) return; this.send('rs', this.bs + 1); this.askKf(true); }
  askKf(force = false) { if (!force && this.S.clock - this.kfAsked < 500) return; this.kfAsked = this.S.clock; this.send('kf'); this.c.kf++; }
  catchUp(str) {
    let d;
    try { d = JSON.parse(str); } catch (e) { this.c.bad++; return; }
    if (!d || !Array.isArray(d.cells)) return;
    this.c.cu++;
    const W = G.world;
    if (d.full) {
      // every cell the host never changed is the world's own again; every block the host does not have goes
      const keep = new Set(d.cells.map((c) => (Array.isArray(c) ? c[0] : -1)));
      if (W.cstate) {
        // generated layouts (9.3): a cell the host never changed goes back to what the generator made; in a chunk
        // this page has not made, only its waiting overrides go
        for (const i of new Set([...W.blocks.keys(), ...W.bover.keys(), ...W.edits.keys()])) if (!keep.has(i) && !this.pendingAfter.has(i)) this.pristineCell(i);
      } else {
        for (const i of [...W.blocks.keys()]) if (!keep.has(i) && !this.pendingAfter.has(i)) this.applyCell(i, W.grid[i], null, true);
        for (const i of [...W.edits.keys()]) if (!keep.has(i) && !this.pendingAfter.has(i) && W.grid[i] !== W.baseTile(i)) this.applyCell(i, W.baseTile(i), W.blocks.get(i) || null, true);
      }
    }
    this.cells(W.cstate ? this.genCells(d.cells) : d.cells, 0, isInt(d.bs) ? d.bs : 0);
    if (d.end) this.endPatch({ ...d.end, _lock: d.lock ?? null });
    if (d.vf && typeof d.vf === 'object') this.farms(d.vf);   // (stage 10: the farm rows too)
    if (isInt(d.bs) && d.bs > this.bs) this.bs = d.bs;
  }

  // generated layouts: one cell back to the generator's state
  pristineCell(i) {
    const W = G.world, x = i % W.W, y = (i / W.W) | 0;
    if (W.ready(x, y)) { this.applyCell(i, W.baseTile(i), W.genBlockAt(i), true); return; }
    W.edits.delete(i); W.blocks.delete(i); W.bover.delete(i);
  }
  // generated layouts: a full catch-up's -1 values ("generated") resolved against this page's chunks; cells of chunks
  // this page has not made go straight into the override maps (nothing of this page's own can be pending there)
  genCells(list) {
    const W = G.world, out = [];
    for (const c of list) {
      if (!Array.isArray(c) || !okCell(c[0])) { out.push(c); continue; }
      let [i, t, b] = c;
      const x = i % W.W, y = (i / W.W) | 0;
      if (W.ready(x, y)) {
        if (t === -1) t = W.baseTile(i);
        if (b === -1) b = W.genBlockAt(i) || 0;
        out.push([i, t, b]);
        continue;
      }
      if (t !== -1 && !okTile(t)) { this.c.bad++; continue; }
      if (b !== -1 && !okBlock(b)) { this.c.bad++; continue; }
      const cap = W.capture; W.capture = null;
      try {
        if (t === -1) W.edits.delete(i); else W.setTile(x, y, t);
        if (b === -1) { W.blocks.delete(i); W.bover.delete(i); } else putBlock(W, x, y, b || null);
      } finally { W.capture = cap; }
    }
    return out;
  }

  // ------------------------------------------------------------ the host's entities
  frameG(p) {
    if (!this.booted || !isInt(p.gc)) return;
    let oldest = 0;
    if (Array.isArray(p.st)) for (const s of p.st) if (Array.isArray(s) && isInt(s[5])) oldest = Math.min(oldest, s[5]);
    this.clock.sample(this.S.clock, p.gc, oldest);
    const seen = p.kf === 1 ? new Set() : null;
    // the steps first (a record's cell is then where they lead, not a jump), then the records, then the steps of
    // entities this frame introduced
    const later = [];
    const step = (s, last) => {
      const r = this.reps.get(s[0]);
      if (!r) { if (last) { this.c.unknown++; this.askKf(); } else later.push(s); return; }
      this.c.steps++;
      this.addEvent(r, { t: p.gc + s[5], k: 's', fx: s[1], fy: s[2], tx: s[3], ty: s[4], dur: Math.max(20, s[6]) });
    };
    if (Array.isArray(p.st)) for (const s of p.st.slice(0, 600)) { if (!Array.isArray(s) || !s.slice(0, 7).every(isInt)) { this.c.bad++; continue; } step(s, false); }
    if (Array.isArray(p.en)) for (const r of p.en.slice(0, 600)) { try { const nid = this.upsert(r, p.gc); if (seen && nid != null) seen.add(nid); } catch (e) { this.c.bad++; } }
    for (const s of later) step(s, true);
    if (Array.isArray(p.g)) for (const nid of p.g) { const r = this.reps.get(nid); if (r) { r.goneAt = p.gc; this.c.gone++; } }
    if (seen) { for (const [nid, r] of this.reps) if (!seen.has(nid)) this.remove(r, false); }
    if (p.dr !== undefined) { try { DR.applyNet(p.dr); } catch (e) { this.c.bad++; report(e); } }
    if (Array.isArray(p.fv) && p.fv.slice(0, 5).every((v) => typeof v === 'number')) {
      const b = G.world.block(p.fv[0], p.fv[1]);
      if (b && b.id === 'furnace') { b.burn = p.fv[2]; b.burnMax = p.fv[3]; b.cook = p.fv[4]; }
    }
  }
  addEvent(r, ev) {
    const q = r.track;
    let i = q.length;
    while (i > 0 && q[i - 1].t > ev.t) i--;
    q.splice(i, 0, ev);
    if (q.length > 40) q.splice(0, q.length - 40);
  }
  // a record: a new replica, or the latest look of one already here
  upsert(rec, gc) {
    if (!Array.isArray(rec) || typeof rec[0] !== 'string' || !isInt(rec[1])) { this.c.bad++; return null; }
    const [type, nid] = rec;
    let r = this.reps.get(nid);
    const mk = (o) => { r = { nid, track: [], samples: [], flags: 0, goneAt: null, ...o }; this.reps.set(nid, r); G.ents.push(r); return r; };
    this.c.recs++;
    if (r) r.goneAt = null;   // (back in view before it was taken away)
    switch (type) {
      case 'm': {
        const [, , kind, size, tx, ty, d, f] = rec;
        if (!okKind(kind) || !isInt(tx) || !isInt(ty)) { this.c.bad++; return null; }
        const def = A.items.mobs[kind];
        if (!r) mk({ type: 'mob', kind, tx, ty, fx: tx, fy: ty, fromX: tx, fromY: ty, moving: false, prog: 0, dir: DL[d] || 'down', hp: def.hp, maxHp: def.hp, hurt: 0, invuln: 0, fuse: 0, aim: 0, attackT: 0, charge: 0, burst: 0, squash: 0, phase: 0, step: def.step, size: size || undefined });
        else {
          // a cell the steps do not lead to (a teleport, a lost step): it goes there at this record's time
          const end = r.track.length ? r.track[r.track.length - 1] : null;
          const at = end ? (end.k === 's' ? [end.tx, end.ty] : [end.x, end.y]) : r.cur ? [r.cur.tx, r.cur.ty] : [r.tx, r.ty];
          if (at[0] !== tx || at[1] !== ty) this.addEvent(r, { t: gc, k: 'a', x: tx, y: ty });
          r.dirRec = DL[d] || r.dir;
        }
        if (!r.moving) r.dir = DL[d] || r.dir;
        // a villager's or golem's look ('<type>_<profession>' or a crack row, '|z' asleep; 7b): its sheet row
        if (kind === 'villager' || kind === 'iron_golem') { const s = typeof size === 'string' ? size : String(size || '0'); r.look = s.split('|')[0]; r.sleep = s.includes('|z'); r.size = undefined; }
        this.setFlags(r, f | 0);
        return nid;
      }
      case 'f': {
        const [, , kind, x100, y100, d, f, size] = rec;
        if (!okKind(kind) || !num(x100, -1e7, 1e8) || !num(y100, -1e7, 1e8)) { this.c.bad++; return null; }
        const x = x100 / 100, y = y100 / 100, def = A.items.mobs[kind];
        if (!r) mk({ type: 'mob', kind, fly: true, tx: Math.round(x), ty: Math.round(y), fx: x, fy: y, fromX: x, fromY: y, moving: false, prog: 0, dir: DL[d] || 'down', hp: def.hp, maxHp: def.hp, hurt: 0, invuln: 0, phase: Math.random() * 6, charge: 0, burst: 0, home: { x, y }, size: size || undefined });
        r.samples.push([gc, x, y]); if (r.samples.length > 12) r.samples.shift();
        r.dir = DL[d] || r.dir;
        this.setFlags(r, f | 0);
        return nid;
      }
      case 'w': {
        const [, , species, shiny, tx, ty, d, disguise, emote, swim, gone] = rec;
        if (!okSpecies(species) || !isInt(tx) || !isInt(ty)) { this.c.bad++; return null; }
        if (!r) mk({ type: 'wild', species, shiny: !!shiny, tx, ty, fx: tx, fy: ty, fromX: tx, fromY: ty, moving: false, prog: 0, dir: DL[d] || 'down', home: { x: tx, y: ty }, emote: 0, calm: 0 });
        else {
          const end = r.track.length ? r.track[r.track.length - 1] : null;
          const at = end ? (end.k === 's' ? [end.tx, end.ty] : [end.x, end.y]) : r.cur ? [r.cur.tx, r.cur.ty] : [r.tx, r.ty];
          if (at[0] !== tx || at[1] !== ty) this.addEvent(r, { t: gc, k: 'a', x: tx, y: ty });
        }
        if (!r.moving) r.dir = DL[d] || r.dir;
        r.disguise = typeof disguise === 'string' ? disguise : null;
        if (emote && !(r.emote > 0)) r.emote = 0.6;
        r.swim = !!swim; r.gone = !!gone;
        return nid;
      }
      case 'i': case 'o': {
        const isItem = type === 'i';
        const [px, py, pz] = isItem ? [rec[4], rec[5], rec[6]] : [rec[3], rec[4], rec[5]];
        if ((isItem && (!okItem(rec[2]) || !isInt(rec[3]))) || !num(px, -1e6, 1e7) || !num(py, -1e6, 1e7)) { this.c.bad++; return null; }
        if (!r) mk(isItem ? { type: 'item', stack: { id: rec[2], n: rec[3] }, x: px, y: py, z: pz || 0, age: 0, spin: Math.random() * 6, delay: 9 } : { type: 'xp', value: rec[2], x: px, y: py, z: pz || 0, age: 0, delay: 9 });
        if (isItem) { r.stack.id = rec[2]; r.stack.n = rec[3]; if (rec[7]) r.stack.dmg = rec[7]; } else r.value = rec[2];
        r.samples.push([gc, px, py, pz || 0]); if (r.samples.length > 12) r.samples.shift();
        return nid;
      }
      case 'a': {
        const [, , x, y, vx, vy, stuck, d] = rec;
        if (!num(x, -1e6, 1e7) || !num(y, -1e6, 1e7)) { this.c.bad++; return null; }
        if (!r) mk({ type: 'arrow', x, y, vx, vy, dir: DL[d] || 'down', life: 0, stuck: 0 });
        r.vx = vx; r.vy = vy; r.stuck = stuck ? 1 : 0;
        r.samples.push([gc, x, y, 0]); if (r.samples.length > 12) r.samples.shift();
        return nid;
      }
      case 'b': {
        const [, , large, x, y, z, vx, vy] = rec;
        if (!num(x, -1e6, 1e7) || !num(y, -1e6, 1e7)) { this.c.bad++; return null; }
        if (!r) mk({ type: 'fireball', size: large ? 'large' : 'small', x, y, z: z || 8, vx, vy, t: 0 });
        r.vx = vx; r.vy = vy;
        r.samples.push([gc, x, y, z || 8]); if (r.samples.length > 12) r.samples.shift();
        return nid;
      }
      case 't': {
        const [, , tx, ty, fuse10, t10] = rec;
        if (!isInt(tx) || !isInt(ty)) { this.c.bad++; return null; }
        if (!r) mk({ type: 'tnt', tx, ty, fuse: fuse10 / 10, t: t10 / 10 });
        r.tx = tx; r.ty = ty; r.fuse = fuse10 / 10; if (Math.abs(r.t - t10 / 10) > 0.3) r.t = t10 / 10;
        return nid;
      }
      case 'B': {
        const [, , x100, y100, d, tx, ty, rider] = rec;
        if (!isInt(tx) || !isInt(ty)) { this.c.bad++; return null; }
        if (!r) mk({ type: 'boat', tx, ty, fx: x100 / 100, fy: y100 / 100, dir: DL[d] || 'down' });
        r.rider = rider >= 0 ? rider : null;
        if (G.P.riding !== r) { r.tx = tx; r.ty = ty; r.dir = DL[d] || r.dir; r.samples.push([gc, x100 / 100, y100 / 100, 0]); if (r.samples.length > 12) r.samples.shift(); }
        return nid;
      }
      default: this.c.bad++; return null;
    }
  }
  // the host's flags: the timers the drawing code reads start and stop here
  setFlags(r, f) {
    const was = r.flags || 0, on = (b) => (f & b) && !(was & b), off = (b) => !(f & b) && (was & b);
    if (on(FL.hurt)) { r.hurt = 0.5; if (NET.near(r.fx, r.fy, 16)) { const k = r.kind; if (A.sfx[k + '.hurt']) mc(k + '.hurt', { vol: 0.6 }); else if (A.sfx[k + '.say']) mc(k + '.say', { vol: 0.6, pitch: 1.1 }); } }
    if (on(FL.dying)) { r.dying = 0.001; if (NET.near(r.fx, r.fy, 16) && A.sfx[r.kind + '.death']) mc(r.kind + '.death', { vol: 0.8 }); }
    if (on(FL.fuse)) { r.fuse = 0.001; if (NET.near(r.fx, r.fy, 16)) mc('fuse', { vol: 0.9 }); } else if (off(FL.fuse)) r.fuse = 0;
    r.sheared = !!(f & FL.sheared); r.angry = !!(f & FL.angry);
    if (on(FL.aim)) r.aim = 0.001; else if (off(FL.aim)) r.aim = 0;
    if (on(FL.attack)) r.attackT = 0.25;
    if (on(FL.charge)) r.charge = 0.001; else if (off(FL.charge)) r.charge = 0;
    if (on(FL.burst)) r.burst = 3; else if (off(FL.burst)) r.burst = 0;
    r.watch = !!(f & FL.watch);
    r.stareT = f & FL.stare ? 0.1 : 0;
    if (on(FL.scream)) r.screamT = 0.75; else if (off(FL.scream)) r.screamT = 0;
    r.hop = !!(f & FL.hop);
    if (on(FL.squash)) r.squash = 0.2;
    r.burn = f & FL.burn ? 1 : 0;
    r.flags = f;
  }
  remove(r, poof = true) {
    this.reps.delete(r.nid);
    const i = G.ents.indexOf(r);
    if (i >= 0) G.ents.splice(i, 1);
    if (poof && r.type === 'mob' && r.dying && NET.near(r.fx, r.fy, 20)) E.poof(r.fx * TILE + 8, r.fy * TILE + 8, 10);
    if (G.P.riding === r) { /* the boat went from under this player: it swims on */ G.P.riding = null; G.P.swimming = G.world.isWater(G.P.tx, G.P.ty); }
  }
  // one frame of a replica at render time rt (host clock)
  play(r, rt, dt) {
    if (r.goneAt != null && rt >= r.goneAt) { this.remove(r); return; }
    if (r.type === 'mob' || r.type === 'wild') {
      if (r.fly) this.lerp(r, rt, (s, k, t) => { r.fx = s[1] + (t[1] - s[1]) * k; r.fy = s[2] + (t[2] - s[2]) * k; });
      else this.walk(r, rt);
      r.tx = r.fly ? Math.round(r.fx) : r.tx; r.ty = r.fly ? Math.round(r.fy) : r.ty;
      if (r.hurt > 0) r.hurt -= dt;
      if (r.invuln > 0) r.invuln -= dt;
      if (r.attackT > 0) r.attackT -= dt;
      if (r.squash > 0) r.squash -= dt;
      if (r.screamT > 0) r.screamT -= dt;
      if (r.dying) r.dying = Math.min(0.69, r.dying + dt);
      if (r.fuse > 0) r.fuse += dt;
      if (r.aim > 0) r.aim += dt;
      if (r.charge > 0) r.charge += dt;
      if (r.fly) r.phase += dt;
      if (r.emote > 0) r.emote -= dt;
      return;
    }
    if (r.type === 'item' || r.type === 'xp') { r.age += dt; this.lerp(r, rt, (s, k, t) => { r.x = s[1] + (t[1] - s[1]) * k; r.y = s[2] + (t[2] - s[2]) * k; r.z = s[3] + (t[3] - s[3]) * k; }); return; }
    if (r.type === 'arrow' || r.type === 'fireball') {
      r.life = (r.life || 0) + dt; if (r.type === 'fireball') r.t += dt;
      this.lerp(r, rt, (s, k, t) => { r.x = s[1] + (t[1] - s[1]) * k; r.y = s[2] + (t[2] - s[2]) * k; if (r.type === 'fireball') r.z = s[3] + (t[3] - s[3]) * k; }, true);
      return;
    }
    if (r.type === 'tnt') { r.t += dt; return; }
    if (r.type === 'boat' && G.P.riding !== r) this.lerp(r, rt, (s, k, t) => { r.fx = s[1] + (t[1] - s[1]) * k; r.fy = s[2] + (t[2] - s[2]) * k; });
  }
  // free movers: between the two samples around rt (held at the last one; projectiles fly on along their velocity)
  lerp(r, rt, set, fly = false) {
    const S = r.samples;
    if (!S.length) return;
    while (S.length > 2 && S[1][0] <= rt) S.shift();
    const a = S[0], b = S[1];
    if (!b || rt <= a[0]) {
      if (fly && rt > a[0] && !r.stuck) { const s = Math.min(0.3, (rt - a[0]) / 1000); set(a, 0, a); r.x = a[1] + (r.vx || 0) * s; r.y = a[2] + (r.vy || 0) * s; }
      else set(a, 0, a);
      return;
    }
    const k = Math.max(0, Math.min(1, (rt - a[0]) / Math.max(1, b[0] - a[0])));
    set(a, k, b);
  }
  // grid movers: the steps play exactly (start cell, end cell, start time, duration); an anchor puts it in a cell
  walk(r, rt) {
    const q = r.track;
    while (q.length && q[0].t <= rt) {
      const ev = q.shift();
      if (ev.k === 's') { r.cur = ev; r.fromX = ev.fx; r.fromY = ev.fy; r.tx = ev.tx; r.ty = ev.ty; r.dir = dirOf(ev.tx - ev.fx, ev.ty - ev.fy) || r.dir; }
      else { r.cur = null; r.fromX = r.tx = ev.x; r.fromY = r.ty = ev.y; r.fx = ev.x; r.fy = ev.y; r.moving = false; r.prog = 0; }
    }
    const c = r.cur;
    if (c) {
      const k = (rt - c.t) / c.dur;
      if (k >= 1) { r.cur = null; r.fx = c.tx; r.fy = c.ty; r.fromX = c.tx; r.fromY = c.ty; r.moving = false; r.prog = 0; r.knocked = false; if (r.dirRec) r.dir = r.dirRec; }
      else { r.prog = Math.max(0, k); r.fx = c.fx + (c.tx - c.fx) * r.prog; r.fy = c.fy + (c.ty - c.fy) * r.prog; r.moving = true; r.knocked = c.dur < (r.step || 0.5) * 500; }
    }
  }
  // E.updateEntities on a guest: only what is this page's own (the fishing bobber); the replicas are played in pre()
  updateEntities(dt) {
    for (const e of G.ents) if (e.type === 'bobber' && !e.dead) E.updateBobber(e, dt);
    for (let i = G.ents.length - 1; i >= 0; i--) { const e = G.ents[i]; if (e.dead && e.nid == null) G.ents.splice(i, 1); }
  }

  // ------------------------------------------------------------ this player's actions on the host's things
  hitMob(m, dmg, from, opts) {
    m.invuln = 0.5; m.hurt = 0.5;
    const k = m.kind;
    if (A.sfx[k + '.hurt']) mc(k + '.hurt', { vol: 0.8 }); else if (A.sfx[k + '.say']) mc(k + '.say', { vol: 0.8, pitch: 1.1 });
    this.send('mh', m.nid, Math.round(dmg * 100) / 100, from ? [from.x, from.y] : 0, { crit: opts.crit ? 1 : 0, knock: opts.knock || 1, melee: opts.melee ? 1 : 0 });
    return true;
  }
  mobAct(m, act) { this.send('ma', m.nid, act); }
  breakBoat(b) { this.send('bb', b.nid); }
  board(b, on) {
    if (!b || b.nid == null) return;
    if (on) { b.rider = NET.slot; this.send('bd', b.nid); }
    else { b.rider = null; this.send('ub', b.nid, b.tx, b.ty); }
  }
  deflect(P) {
    const d = DIRS[P.dir], hx = P.fx * TILE + 8 + d.x * 10, hy = P.fy * TILE + 8 + d.y * 10;
    const f = G.ents.find((e) => e.type === 'fireball' && e.nid != null && Math.hypot(e.x - hx, e.y - hy) < 26);
    if (!f) return false;
    this.send('df', f.nid, P.dir);
    mc('attack.strong', { vol: 0.8 });
    return true;
  }
  explode(tx, ty, power, src, opts) { this.send('ex', tx, ty, power, opts && opts.fire ? 1 : 0); }
  placeCrystal(f) { this.send('cr', f.x, f.y); }
  dragonHit(dmg, src) { this.send('dh', Math.round(dmg * 100) / 100, src); }
  askLegend() { this.send('lg'); }
  legendOver(outcome) { this.send('lge', outcome); }
  engage(e) { e.disguise = null; this.send('en', e.nid); }
  wildOver(nid, outcome) { this.send('we', nid, outcome); }
  respawned(tx, ty) { this.send('rsp', tx, ty); }

  // ------------------------------------------------------------ what the host sends this player
  item(type, a) {
    const B = bridge(), P = G.P;
    switch (type) {
      case 'ok': return this.ok(a[0]);
      case 'no': return this.no(...a);
      case 'hit': return this.hit(...a);
      case 'got': return this.got(...a);
      case 'enc': {
        const [nid, species, level, shiny, swim] = a;
        if (!okSpecies(species) || !isInt(level)) return;
        const ok = B && B.encounter({ species, level, shiny: !!shiny }, swim ? 'water' : 'land', { nid, remote: true });
        if (!ok) this.send('we', nid, 'ran');
        return;
      }
      case 'encno': if (B && B.state() === 'play' && !P.dead) B.say('It got away!'); return;
      case 'cs': return this.csReply(...a);
      case 'bdk': {
        const [nid, ok] = a, r = this.reps.get(nid);
        if (!ok && r && P.riding === r) { P.riding = null; r.rider = null; PL.placePlayer(P, P.fromX, P.fromY, P.dir); P.swimming = G.world.isWater(P.tx, P.ty); }
        return;
      }
      case 'leg': {
        // (the answer takes a round trip: a player who died, or is somewhere else by now, gives the lock back)
        const free = B && B.state() === 'play' && !P.dead && !P.sleeping;
        if (a[0]) { if (free) B.beginLegend(); else this.send('lge', 'ran'); }
        else if (free) B.say('Someone is battling the ENDER DRAGON.');
        return;
      }
      case 'adv': if (typeof a[0] === 'string' && G.advance) G.advance(a[0]); return;
      case 'kill': { const [kind, hostile, by] = a; if (hostile) G.score++; if (by && G.onKill && typeof kind === 'string') G.onKill(kind); return; }
      case 'wake': if (B) B.coopWake(); return;
      case 'unbed': if (P.sleeping) { PL.wake(P); if (typeof a[0] === 'string') G.toast(a[0]); } return;
      case 'say': if (B && typeof a[0] === 'string' && B.state() === 'play' && !P.dead) B.say(a[0].slice(0, 200)); return;
      case 'cu': return this.catchUp(a[0]);
      case 'tv': return this.tradeView(...a);
      case 'trk': return this.tradeAck(...a);
      default: this.c.bad++;
    }
  }
  ok(n) {
    const t = this.pending.get(n);
    if (!t) return;
    this.pending.delete(n);
    this.c.ok++;
    for (const [i, tile, key] of t.cells) {
      const pa = this.pendingAfter.get(i);
      if (pa && pa[2] !== n) { this.shadowTile[i] = tile; if (key) this.shadowKey.set(i, key); else this.shadowKey.delete(i); continue; }   // a later prediction still waits
      this.pendingAfter.delete(i);
      const st = this.stash.get(i);
      if (st) { this.stash.delete(i); if (st[2]) this.cellSeq.set(i, st[2]); this.applyCell(i, st[0], st[1] || null, true); }
      else { this.shadowTile[i] = tile; if (key) this.shadowKey.set(i, key); else this.shadowKey.delete(i); }
    }
  }
  no(n, cells, end, why, extra, asOf) {
    const t = this.pending.get(n);
    this.c.no++;
    if (this.noLog.length < 50) this.noLog.push({ n, why, at: Math.round(this.S.clock) });
    if (!t) return;
    this.pending.delete(n);
    const seq = isInt(asOf) ? asOf : 0;
    for (const c of Array.isArray(cells) ? cells : []) {
      if (!Array.isArray(c) || !okCell(c[0]) || !okTile(c[1]) || !okBlock(c[2])) continue;
      const i = c[0], pa = this.pendingAfter.get(i), st = this.stash.get(i);
      if (pa && pa[2] !== n) { if (!(st && st[2] > seq)) this.stash.set(i, [c[1], c[2] || 0, seq]); continue; }
      this.pendingAfter.delete(i); this.stash.delete(i);
      // (a later B frame's state for this cell, here or stashed, is newer than the refusal's)
      if (st && st[2] > seq) { this.cellSeq.set(i, st[2]); this.applyCell(i, st[0], st[1] || null, true); continue; }
      if ((this.cellSeq.get(i) || 0) > seq) continue;
      this.applyCell(i, c[1], c[2] || null, true);
    }
    for (const [i] of t.cells) { const pa = this.pendingAfter.get(i); if (pa && pa[2] === n) this.pendingAfter.delete(i); }
    if (end && typeof end === 'object' && G.end) for (const k of ['egg', 'eggHops']) if (k in end) G.end[k] = end[k];
    this.undo(t.delta);
  }
  // damage the host worked out for this player (a mob, a projectile, a blast, the dragon), in its own name
  hit(dmg, cause, from, opts, extra) {
    const P = G.P, B = bridge();
    if (!num(dmg, 0, 100)) return;
    if (B && B.busyCode() >= 2) return;            // in a battle by now: nothing reaches it
    extra = extra && typeof extra === 'object' ? extra : {};
    if (extra.inv0) P.invuln = 0;
    const f = Array.isArray(from) && isInt(from[0]) && isInt(from[1]) ? { tx: from[0], ty: from[1] } : null;
    const o = opts && typeof opts === 'object' ? { noArmor: !!opts.noArmor, noKnock: !!opts.noKnock } : {};
    const r = PL.hurtPlayer(P, dmg, this.S.causeText(cause, P.name), f, false, o);
    this.c.hits++;
    if (r && num(extra.fire, 0.1, 10)) P.fireT = Math.max(P.fireT || 0, extra.fire);
    if (r && num(extra.slow, 0.1, 10)) P.slowT = Math.max(P.slowT || 0, extra.slow);   // a stray's arrow (5d)
    if (r && Array.isArray(extra.kn) && G.world.inEnd(P.tx, P.ty)) { try { DR.knock(+extra.kn[0] || 0, +extra.kn[1] || 0, Math.min(4, extra.kn[2] | 0)); } catch (e) { report(e); } }
  }
  // the host gave this player what reached it
  got(stack, xp) {
    this.c.got++;
    if (!stack && isInt(xp) && xp > 0) { G.giveXp(xp); return; }
    if (!stack || !okItem(stack.id) || !isInt(stack.n) || stack.n < 1) return;
    const left = G.inv.add(stack.id, stack.n, stack.dmg ? { dmg: stack.dmg } : {});
    if (left < stack.n) { mc('pop', { vol: 0.2, pitch: 1.4 + Math.random() * 0.6 }); if (G.onPickup) G.onPickup(stack.id, stack.n - left); }
    // what does not fit goes back down, and is not pulled straight back to this player
    if (left > 0) { const P = G.P; const e = E.dropItem(stack.id, left, P.tx * TILE, P.ty * TILE, stack.dmg ? { dmg: stack.dmg } : {}, { delay: 1 }); if (e) e.skipMe = true; }
  }

  // ------------------------------------------------------------ trades (the world update 7c; design 9.4)
  // Z or X on a villager replica: ask the host ('tro'); its answer ('tv') opens the screen on a copy of the villager's
  // trade state. Each trade is predicted here (the inventory changes at once) and sent as 'tr' with the offer's key;
  // the host's 'trk' brings the villager's real state, and a refusal (out of stock, too far) reverses this player's
  // inventory change as a refused container click does.
  openTrade(m) {
    if (!m || m.nid == null) return false;
    if (this.troWait && this.S.clock - this.troWait.at < 3000) return true;
    this.troWait = { nid: m.nid, at: this.S.clock };
    this.send('tro', m.nid);
    return true;
  }
  tradeView(nid, ok, st) {
    const w = this.troWait, B = bridge();
    this.troWait = null;
    if (!w || w.nid !== nid) return;
    const v = this.tradeCopy(nid, st);
    if (!ok || !v) { if (B && B.state() === 'play') { mc('villager.no', { vol: 0.7 }); G.toast('Hrmm'); } return; }
    if (!B || B.state() !== 'play' || G.P.dead || !G.showTrade) { this.send('trc', nid); return; }
    G.showTrade(v, { onTrade: (vv, key, r, o) => this.tradeDone(vv, key, o, r) });
  }
  tradeCopy(nid, st) {
    if (!st || typeof st !== 'object' || typeof st.prof !== 'string') return null;
    const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, n]) => isInt(n) && n >= 0)) : {});
    return { nid, vid: isInt(st.vid) ? st.vid : 0, prof: st.prof, lvl: isInt(st.lvl) ? Math.max(1, Math.min(5, st.lvl)) : 1, xp: isInt(st.xp) ? st.xp : 0, uses: obj(st.uses), demand: obj(st.demand) };
  }
  // one trade on this page's screen: its inventory change, sent once the screen's frame is over (tradeFlush)
  tradeDone(v, key, o, r) {
    if (!o) return;
    const paid = costA(o, demandOf(v, o), 64);
    // (stage 10: the player xp the screen gave, taken back if the host refuses)
    (this.trBuf = this.trBuf || []).push({ key, xp: r && isInt(r.playerXp) ? r.playerXp : 0, gained: [[stackKey({ id: o.result }), o.nR]], lost: [[stackKey({ id: o.costA }), paid], ...(o.costB ? [[stackKey({ id: o.costB }), o.nB]] : [])] });
  }
  // a refused trade's player xp comes off again (levels down if it must; never below 0)
  takeXp(n) {
    const P = G.P;
    if (!(n > 0) || !P) return;
    P.xpTotal = Math.max(0, (P.xpTotal || 0) - n);
    P.xpProgress = (P.xpProgress || 0) - n;
    while (P.xpProgress < 0 && P.level > 0) { P.level--; P.xpProgress += xpForLevel(P.level); }
    if (P.xpProgress < 0) P.xpProgress = 0;
  }
  tradeFlush(scr) {
    const buf = this.trBuf;
    this.trBuf = null;
    if (!buf || !buf.length) return;
    const by = new Map();
    for (const t of buf) {
      const g = by.get(t.key) || { times: 0, xp: 0, gained: new Map(), lost: new Map() };
      g.times++; g.xp += t.xp || 0;
      for (const [k, n] of t.gained) g.gained.set(k, (g.gained.get(k) || 0) + n);
      for (const [k, n] of t.lost) g.lost.set(k, (g.lost.get(k) || 0) + n);
      by.set(t.key, g);
    }
    for (const [key, g] of by) {
      this.trN = (this.trN || 0) + 1;
      const n = this.trN;
      const delta = { gained: [...g.gained], lost: [...g.lost] };
      (this.trPend = this.trPend || new Map()).set(n, { delta, scr, nid: scr.v.nid, xp: g.xp });
      this.send('tr', n, scr.v.nid, key, g.times, this.invState(delta));
      this.c.tr = (this.c.tr || 0) + 1;
    }
  }
  tradeAck(n, nid, key, ok, st) {
    const w = this.trPend && this.trPend.get(n);
    if (w) this.trPend.delete(n);
    const B = bridge(), scr = B && B.screen();
    const open = scr && scr.kind === 'trade' && scr.v && scr.v.nid === nid ? scr : null;
    if (!ok) {
      this.c.trNo = (this.c.trNo || 0) + 1;
      if (w) { this.undo(w.delta, open); this.takeXp(w.xp); }
      mc('villager.no', { vol: 0.7 });
    }
    // the villager's real state (another player's trades, the host's own count): the screen shows it at once
    const v = this.tradeCopy(nid, st);
    if (open && v && !(this.trPend && [...this.trPend.values()].some((p) => p.nid === nid))) {
      const lv0 = open.v.lvl;
      Object.assign(open.v, { lvl: v.lvl, xp: v.xp, uses: v.uses, demand: v.demand });
      if (v.lvl !== lv0) open.offers = offersFor(open.v, open.data, open.has);
    }
  }
  // ------------------------------------------------------------ containers: each click's changes to the host
  screen(scr, dt, input) {
    if (scr.kind === 'trade') {
      if (this.troWait == null) { scr.update(dt, input); this.tradeFlush(scr); }
      if (scr.done) { this.tradeFlush(scr); this.send('trc', scr.v.nid); }
      return;
    }
    const b = scr.target, W = G.world;
    if (!this.scrOpen || this.scrOpen.scr !== scr) {
      let cell = null;
      for (const [i, v] of W.blocks) if (v === b) { cell = i; break; }
      this.scrOpen = { scr, x: cell == null ? -1 : cell % W.W, y: cell == null ? -1 : (cell / W.W) | 0 };
      if (cell != null) this.send('op', this.scrOpen.x, this.scrOpen.y, scr.kind);
    }
    if (this.csWait) {
      // clicks wait for the host's answer to the last one (about one round trip); closing still works
      if (input.just('inv') || input.just('esc')) scr.done = true;
      this.closed(scr);
      return;
    }
    const kind = b.id === 'chest' ? 'chest' : b.id === 'furnace' ? 'furnace' : null;
    if (!kind || this.scrOpen.x < 0) { scr.update(dt, input); this.closed(scr); return; }
    const before = this.slots(b), inv0 = this.sig(scr.cursor);
    scr.wantXp = false;
    scr.update(dt, input);
    const after = this.slots(b), ops = [];
    // each changed slot: what it held before the click (the host checks it still does) and what it holds now
    for (const key of Object.keys(after)) if (fullKey(after[key]) !== fullKey(before[key])) ops.push([isNaN(+key) ? key : +key, before[key] ? fullKey(before[key]) : '', after[key] ? clone(after[key]) : null]);
    if (ops.length || scr.wantXp) {
      const delta = this.delta(inv0, this.sig(scr.cursor));
      this.csWait = { x: this.scrOpen.x, y: this.scrOpen.y, delta, scr, at: this.S.clock };
      this.send('cs', this.scrOpen.x, this.scrOpen.y, ops, scr.wantXp ? 1 : 0, this.invState(delta));
    }
    this.closed(scr);
  }
  closed(scr) { if (scr.done && this.scrOpen && this.scrOpen.scr === scr) { this.send('cl'); this.scrOpen = null; } }
  slots(b) {
    const o = {};
    if (b.id === 'chest') (b.slots || []).forEach((s, i) => { o[i] = s ? { ...s } : null; });
    else if (b.id === 'furnace') { o.in = b.input ? { ...b.input } : null; o.fu = b.fuel ? { ...b.fuel } : null; o.out = b.output ? { ...b.output } : null; }
    return o;
  }
  csReply(x, y, ok, slots, xp, asOf) {
    const w = this.csWait;
    this.csWait = null;
    this.c.cs = (this.c.cs || 0) + 1;
    if (!ok) { this.c.csNo = (this.c.csNo || 0) + 1; if (w) this.undo(w.delta, w.scr); }
    const b = isInt(x) && isInt(y) ? G.world.block(x, y) : null;
    const newer = b && isInt(asOf) && (this.cellSeq.get(y * G.world.W + x) || 0) > asOf;
    if (b && slots && !newer) {
      const clean = (s) => (s && okItem(s.id) && isInt(s.n) && s.n > 0 ? { ...s } : null);
      if (b.id === 'chest' && Array.isArray(slots)) b.slots = slots.slice(0, 54).map(clean);
      else if (b.id === 'furnace' && typeof slots === 'object') { b.input = clean(slots.in); b.fuel = clean(slots.fu); b.output = clean(slots.out); }
      // the screen reads the block's slots through closures over the same object, so it shows them at once
      const i = y * G.world.W + x;
      this.shadowKey.set(i, contentKey(b));
    }
    if (isInt(xp) && xp > 0) G.giveXp(xp);
  }

  info() {
    return { ...this.c, reps: this.reps.size, pendingTx: this.pending.size, pendingCells: this.pendingAfter.size, stash: this.stash.size, bs: this.bs, D: Math.round(this.clock.D), csWait: !!this.csWait, lock: this.lock, noLog: this.noLog.slice(-10) };
  }
}
const dirOf = (dx, dy) => (dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : dy < 0 ? 'up' : null);
