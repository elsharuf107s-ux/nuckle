// Co-op players on the wire and on screen. Loaded only when a room opens.
//
// Mover (the sender): watches this page's own Steve after every frame and turns what he did into a few events,
// not positions. Players move cell to cell, so walking is sent as "walking from cell (x, y) toward d, one step
// every p ms" and the others play it forward until the next event: a straight walk costs one event, a turn or a
// stop one more. Each event carries the sender's net clock (wall ms since its session began), so the receiver can
// play it at the right moment. Design: multiplayer-design.md 4.3 and 8.2.
//
//   ['w', x, y, d, p]          walking from (x, y) in direction d (index into DL), a step every p ms
//   ['j', x, y, tx, ty, ms]    one step that is not part of a walk (a ledge hop, a knockback, a portal frame)
//   ['s', x, y, d]             standing at (x, y) facing d (a stop, a turn on the spot, a teleport)
//   ['l', {look}]              look keys that changed (held item, armor, using, mining, sleeping, dead, busy...)
//   ['sw'] ['pl'] ['hu'] ['jp'] a swing, a place pose, a hurt flash, a jump
//   ['F', x, y, d, moving, {look}]  the whole state (after joining, resuming, and once after each stop)
//
// Avatar (the receiver): one per other player. Events are played at (my clock - offset - D): the offset is the
// smallest (arrival - send time) seen recently, so latency spikes never pull it, and D is a buffer that adapts to
// how late events actually arrive (the sender's batching, jitter): the latest of the last 40 frames plus 40 ms. A correction (a late stop, a lost frame) is
// eased out over about 120 ms of wall time; anything more than a cell and a half away snaps.
import { A } from '../assets.js';
import { G, TILE } from '../game.js';
import { item } from '../items.js';
import * as PL from '../player.js';
import * as E from '../entities.js';
import * as SK from './skins.js';
import { okItem } from './proto.js';
import { mcWidth } from '../mcfont.js';

export const DL = ['up', 'down', 'left', 'right'];
const DV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const dirOf = (dx, dy) => (Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up'));
const int = (v) => Number.isInteger(v);
const cellOk = (x, y) => int(x) && int(y) && x >= 0 && y >= 0 && x < 100000 && y < 100000;
const dirOk = (c) => int(c) && c >= 0 && c < 4;

// ------------------------------------------------------------------------------------------------ the sender
export class Mover {
  constructor() {
    this.pending = [];        // [time, ...event] not yet sent
    this.again = [];          // the events of the last message sent, sent once more with the next (a lost message loses nothing)
    this.seg = null;          // what the receivers are playing now: { k: 'w', x, y, d, p, t0, n } / { k: 'j', ... } / { k: 's', key }
    this.sent = {};           // look keys as last sent
    this.prev = null;         // last frame's P fields (step key, swing, place, hurt, jump)
    this.mine = null;         // { key, t0, p0, ticks }
    this.wantFull = true;     // send the whole state at the next chance
    this.trailAt = 0;         // after a stop: send the whole state once more (a lost stop must never leave a ghost walking)
  }
  // (times are whole ms from the start: an event repeated in the next message must decode to the very same time, or
  // the receiver takes the repeat for a new, late event and its buffer grows to the maximum)
  push(t, ...ev) { this.pending.push([Math.round(t), ...ev]); if (this.pending.length > 200) { this.pending.splice(0, 100); this.wantFull = true; } }

  look(P, busy) {
    const inv = G.inv, held = inv.held;
    const l = {
      h: held ? held.id : 0,
      ar: inv.armor.map((a) => (a ? a.id : 0)),
      u: P.using === 'eat' ? 1 : P.using === 'bow' ? 2 : 0,
      mn: 0,
      sl: P.sleeping ? [P.sleeping.hx, P.sleeping.hy, Math.max(0, DL.indexOf(P.sleeping.orient))] : 0,
      d: P.dead ? 1 : 0, b: busy, f: P.fireT > 0 ? 1 : 0, v: P.voidFall ? 1 : 0, rd: P.riding ? 1 : 0,
    };
    // generated worlds' modes (9.5, stage 10): a spectator (sp: not drawn, not hurt, picks nothing up) and a player
    // hostiles ignore (hd: creative or spectator). Classic frames carry neither.
    if (G.mr) { l.sp = G.mr.mode === 'spectator' ? 1 : 0; l.hd = P.hidden ? 1 : 0; }
    // mining: the target and how long the whole break takes (in 20ths of a second), measured from the progress
    // made, so the others loop the swing and draw the crack themselves (one look change per block, not per swing)
    const m = P.mining;
    if (m && m.key) {
      if (!this.mine || this.mine.key !== m.key) this.mine = { key: m.key, t0: G.clock, p0: m.progress, ticks: 0 };
      const mi = this.mine;
      if (!mi.ticks && m.progress > mi.p0 && G.clock > mi.t0) {
        mi.ticks = Math.max(1, Math.round(((G.clock - mi.t0) * 20) / (m.progress - mi.p0)));
        // sent once per target (the progress so far lets the crack start where it is)
        mi.mn = [m.x, m.y, Math.min(100000, mi.ticks), Math.round(Math.min(1, m.progress) * 100)];
      }
      if (mi.mn) l.mn = mi.mn;
    } else this.mine = null;
    return l;
  }

  // after every frame: what changed. clock: this page's net clock (wall ms); dt: the frame (s, game time); busy:
  // the busy code; rate: wall ms per game ms lately (above 1 on a page too slow for its frames' dt), so the times
  // and periods sent are wall times
  capture(P, clock, dt, busy, rate = 1) {
    const prev = this.prev || {};
    const stepKey = P.moving ? `${P.fromX},${P.fromY},${P.tx},${P.ty}` : null;
    // a step began this frame (it may have begun part-way: a knockback starts inside the frame)
    if (stepKey && (stepKey !== prev.stepKey || !prev.moving)) {
      const start = clock - (P.prog || 0) * P.speed * 1000 * rate;
      const dx = P.tx - P.fromX, dy = P.ty - P.fromY, dist = Math.abs(dx) + Math.abs(dy);
      const frames = Math.max(1, Math.ceil(P.speed / Math.max(0.001, dt) - 1e-6));
      const period = Math.round(frames * dt * 1000 * rate);
      const d = dirOf(dx, dy);
      if (dist === 1 && !P.knocked) {
        const s = this.seg;
        let fits = false;
        if (s && s.k === 'w' && s.d === d) {
          const n = s.n + 1, [vx, vy] = DV[d];
          if (s.x + n * vx === P.fromX && s.y + n * vy === P.fromY && Math.abs(start - (s.t0 + n * s.p)) <= 45 && Math.abs(period - s.p) <= Math.max(6, s.p * 0.04)) { s.n = n; fits = true; }
          else if (s.x + n * vx === P.fromX && s.y + n * vy === P.fromY && n >= 2 && Math.abs(period - s.p) <= Math.max(12, s.p * 0.1)) {
            // the same walk, but the frames ran slower or faster than predicted: re-anchor with the measured pace
            const p = Math.round((start - s.t0) / n);
            this.push(start, 'w', P.fromX, P.fromY, DL.indexOf(d), p > 40 && p < 4000 ? p : period);
            this.seg = { k: 'w', x: P.fromX, y: P.fromY, d, p: p > 40 && p < 4000 ? p : period, t0: start, n: 0 };
            fits = true;
          }
        }
        if (!fits) { this.push(start, 'w', P.fromX, P.fromY, DL.indexOf(d), period); this.seg = { k: 'w', x: P.fromX, y: P.fromY, d, p: period, t0: start, n: 0 }; }
      } else {
        this.push(start, 'j', P.fromX, P.fromY, P.tx, P.ty, period);
        this.seg = { k: 'j' };
      }
      this.trailAt = 0;
    }
    // standing: a stop, a turn on the spot, a teleport, a respawn
    if (!P.moving) {
      const key = `${P.tx},${P.ty},${P.dir}`;
      if (!this.seg || this.seg.k !== 's' || this.seg.key !== key) {
        this.push(clock, 's', P.tx, P.ty, DL.indexOf(P.dir));
        this.seg = { k: 's', key };
        this.trailAt = clock + 600;
      }
    }
    // one-off animations (a swing while mining is looped by the receivers, so it is not sent)
    if (P.swingT > 0 && !P.mining && (!prev.swingT || P.swingT < prev.swingT)) this.push(clock - P.swingT * 1000 * rate, 'sw');
    if (P.placeT > (prev.placeT || 0) + 1e-6) this.push(clock, 'pl');
    if (P.hurtFlash > (prev.hurtFlash || 0) + 1e-6) this.push(clock, 'hu');
    if (P.jumpT > 0 && !(prev.jumpT > 0)) this.push(clock - P.jumpT * 1000 * rate, 'jp');
    // look keys that changed
    const l = this.look(P, busy), ch = {};
    let any = false;
    for (const k of Object.keys(l)) { const v = JSON.stringify(l[k]); if (v !== this.sent[k]) { ch[k] = l[k]; this.sent[k] = v; any = true; } }
    if (any) { this.push(clock, 'l', ch); if (!P.moving) this.trailAt = clock + 600; }
    if (this.trailAt && clock >= this.trailAt && !P.moving) { this.trailAt = 0; this.wantFull = true; }
    if (this.wantFull) {
      this.wantFull = false;
      this.push(clock, 'F', P.tx, P.ty, DL.indexOf(P.dir), P.moving ? 1 : 0, l);
      for (const k of Object.keys(l)) this.sent[k] = JSON.stringify(l[k]);
    }
    this.prev = { stepKey, moving: P.moving, swingT: P.swingT, placeT: P.placeT, hurtFlash: P.hurtFlash, jumpT: P.jumpT };
  }
  // the pending events as an M payload relative to the frame's clock (dt <= 0), or null
  payload(clock) {
    if (!this.pending.length) return null;
    const gc = Math.round(clock), again = this.again.filter((e) => gc - e[0] < 1500);
    return { gc, ev: [...again, ...this.pending].map(([t, ...e]) => [Math.min(0, t - gc), ...e]) };
  }
  sent_() { if (this.pending.length) this.again = this.pending; this.pending = []; }
}

// ------------------------------------------------------------------------------------------------ the receiver
const LOOK0 = { h: 0, ar: [0, 0, 0, 0], u: 0, mn: 0, sl: 0, d: 0, b: 0, f: 0, v: 0, rd: 0 };
export class Avatar {
  // live: the host's copy for the simulation (no playback buffer: mobs and pickups use where the guest is now)
  constructor(slot, name, skin, live = false) {
    this.slot = slot; this.name = name; this.skin = skin; this.away = 0; this.live = live;
    this.q = [];                         // [t (sender clock), op, ...args], in time order
    this.samples = []; this.offset = null; this.lates = []; this.D = 150; this.Dt = 150;
    this.seg = null; this.lk = { ...LOOK0 }; this.known = false;
    this.err = [0, 0];
    // the fields PL.drawSteve reads, as on P
    Object.assign(this, PL.makePlayer(0, 0));
    this.name = name;
    this.useT = 0; this.mineT = 0; this.voidT = 0; this.lastRt = 0; this.bad = 0;
    this.hist = [];   // the last events played (tests and debugging)
  }

  // a movement frame from this player (already through the receiver rules). now: my net clock (ms)
  ingest(p, now) {
    if (!p || !int(p.gc) || !Array.isArray(p.ev)) { this.bad++; return; }
    const sample = now - p.gc;
    this.samples.push(sample);
    if (this.samples.length > 64) this.samples.shift();
    const prevOff = this.offset;
    this.offset = Math.min(...this.samples);
    // the very first frame, or the clock jumped (the sender reloaded): start playback afresh
    if (prevOff == null || Math.abs(sample - prevOff) > 20000) { this.samples = [sample]; this.offset = sample; this.lastRt = 0; }
    let oldest = 0;
    const seen = this.seen || (this.seen = new Map());
    for (const e of p.ev.slice(0, 400)) {
      if (!Array.isArray(e) || !int(e[0]) || typeof e[1] !== 'string' || e[0] > 0 || e[0] < -600000) { this.bad++; continue; }
      const t = p.gc + e[0];
      // (each message repeats the previous one's events: play each once)
      const key = t + JSON.stringify(e.slice(1));
      if (seen.has(key)) continue;
      seen.set(key, t);
      oldest = Math.min(oldest, e[0]);
      // keep time order (a frame's events already are; frames arrive in order)
      let i = this.q.length;
      while (i > 0 && this.q[i - 1][0] > t) i--;
      this.q.splice(i, 0, [t, ...e.slice(1)]);
    }
    if (this.q.length > 600) this.q.splice(0, this.q.length - 600);
    if (seen.size > 300) for (const [k, t] of seen) if (t < p.gc - 5000) seen.delete(k);
    // how late this frame's oldest event arrived, past the best case: the buffer has to cover that
    this.lates.push(Math.max(0, sample - this.offset - oldest));
    if (this.lates.length > 40) this.lates.shift();
    // the latest of the last 40 frames, plus a margin: an event that comes later than that is played late (eased)
    this.Dt = Math.min(700, Math.max(80, Math.max(...this.lates) + 40));
  }

  // where the current segment puts the player at time rt: [fx, fy, moving, prog, fromX, fromY, tx, ty, dir, dist]
  posAt(rt) {
    const s = this.seg;
    if (!s) return null;
    if (s.k === 'w') {
      if (!DV[s.d]) return null;
      const [vx, vy] = DV[s.d], el = Math.max(0, rt - s.t0), n = Math.floor(el / s.p), f = (el - n * s.p) / s.p;
      const fx = s.x + n * vx, fy = s.y + n * vy;
      return [fx + vx * f, fy + vy * f, true, f, fx, fy, fx + vx, fy + vy, s.d, 1];
    }
    if (s.k === 'j') {
      const f = Math.min(1, Math.max(0, (rt - s.t0) / s.ms));
      if (f >= 1) return [s.tx, s.ty, false, 0, s.tx, s.ty, s.tx, s.ty, s.d, 1];
      return [s.x + (s.tx - s.x) * f, s.y + (s.ty - s.y) * f, true, f, s.x, s.y, s.tx, s.ty, s.d, Math.abs(s.tx - s.x) + Math.abs(s.ty - s.y)];
    }
    return [s.x, s.y, false, 0, s.x, s.y, s.x, s.y, s.d, 1];
  }

  setSeg(seg, rt) {
    const before = this.posAt(rt);
    this.seg = seg;
    const after = this.posAt(rt);
    if (!before || !after) { this.err = [0, 0]; return; }
    const ex = before[0] - after[0] + this.err[0], ey = before[1] - after[1] + this.err[1];
    // more than a cell and a half off: snap (a teleport, a long gap); a small difference is eased out
    if (Math.hypot(ex, ey) > 1.6) { this.err = [0, 0]; if (Math.hypot(ex, ey) > 3 && this.known && this.visibleNow) this.puff = true; }
    else this.err = [ex, ey];
  }

  apply(e, rt) {
    const [t, op, a, b, c, d, f] = e;
    switch (op) {
      case 'w':
        if (!cellOk(a, b) || !dirOk(c) || !(d >= 40 && d <= 5000)) { this.bad++; return; }
        this.setSeg({ k: 'w', x: a, y: b, d: DL[c], p: d, t0: t }, rt); this.dir = DL[c]; return;
      case 'j':
        if (!cellOk(a, b) || !cellOk(c, d) || !(f >= 20 && f <= 5000)) { this.bad++; return; }
        this.setSeg({ k: 'j', x: a, y: b, tx: c, ty: d, ms: f, t0: t, d: dirOf(c - a, d - b) }, rt); return;
      case 's':
        if (!cellOk(a, b) || !dirOk(c)) { this.bad++; return; }
        this.setSeg({ k: 's', x: a, y: b, d: DL[c] }, rt); this.dir = DL[c]; return;
      case 'F':
        if (!cellOk(a, b) || !dirOk(c)) { this.bad++; return; }
        // the whole state: a standing player is put exactly there; a walking one keeps its walk unless it is
        // somewhere else entirely
        if (!d || !this.seg || this.seg.k === 's') this.setSeg({ k: 's', x: a, y: b, d: DL[c] }, rt);
        else { const p = this.posAt(rt); if (!p || Math.hypot(p[0] - a, p[1] - b) > 2) this.setSeg({ k: 's', x: a, y: b, d: DL[c] }, rt); }
        if (!d) this.dir = DL[c];
        if (e[6] && typeof e[6] === 'object') this.setLook(e[6]);
        this.known = true;
        return;
      case 'l': if (a && typeof a === 'object') this.setLook(a); return;
      case 'sw': this.swingT = 0.001 + Math.max(0, (rt - t) / 1000); if (this.swingT >= 0.3) this.swingT = 0; return;
      case 'pl': this.placeT = 0.25; return;
      case 'hu': this.hurtFlash = 0.5; return;
      case 'jp': this.jumpT = 0.001 + Math.max(0, (rt - t) / 1000); return;
      default: this.bad++;
    }
  }

  setLook(l) {
    const k = this.lk;
    if (typeof l.h === 'string' || l.h === 0) k.h = l.h && okItem(l.h) ? l.h : 0;
    if (Array.isArray(l.ar) && l.ar.length === 4) k.ar = l.ar.map((id) => (okItem(id) && item(id).armor ? id : 0));
    if (l.u === 0 || l.u === 1 || l.u === 2) { if (l.u !== k.u) this.useT = 0; k.u = l.u; }
    if (l.mn === 0 || (Array.isArray(l.mn) && cellOk(l.mn[0], l.mn[1]) && l.mn[2] > 0)) {
      if (JSON.stringify(l.mn) !== JSON.stringify(k.mn) && (!l.mn || !k.mn || l.mn[0] !== k.mn[0] || l.mn[1] !== k.mn[1])) this.mineT = l.mn ? (l.mn[3] || 0) / 100 * l.mn[2] / 20 : 0;
      k.mn = l.mn;
    }
    if (l.sl === 0 || (Array.isArray(l.sl) && cellOk(l.sl[0], l.sl[1]))) k.sl = l.sl;
    if (l.d === 0 || l.d === 1) { if (l.d && !k.d) this.deathT = 0; k.d = l.d; }
    if (int(l.b) && l.b >= 0 && l.b <= 5) k.b = l.b;
    if (l.f === 0 || l.f === 1) k.f = l.f;
    if (l.v === 0 || l.v === 1) { if (l.v && !k.v) this.voidT = 0; k.v = l.v; }
    if (l.rd === 0 || l.rd === 1) k.rd = l.rd;
    if (l.sp === 0 || l.sp === 1) k.sp = l.sp;   // (stage 10)
    if (l.hd === 0 || l.hd === 1) k.hd = l.hd;
    this.known = true;
  }

  // one frame: play everything due, then lay out the P-like fields for drawing. now: my net clock (ms)
  update(now, dt) {
    if (this.offset == null) return;
    if (this.live) this.D = 0; else this.D += (this.Dt - this.D) * Math.min(1, dt * 2);
    const rt = now - this.offset - this.D;
    // far behind (a long burst after a pause): skip ahead instead of replaying seconds of walking
    while (this.q.length && this.q[0][0] <= rt) {
      const e = this.q.shift();
      try { this.apply(e, rt); } catch (x) { this.bad++; }
      this.hist.push([Math.round(rt), ...e.slice(0, 6).map((v) => (typeof v === 'number' ? Math.round(v) : typeof v === 'object' ? '{}' : v))]);
      if (this.hist.length > 24) this.hist.shift();
    }
    this.lastRt = rt;
    // a correction is eased out in wall time (the net clock's), over about 120 ms: a frame that took long removes more
    const wdt = this.lastNow == null ? dt : Math.max(0, Math.min(1, (now - this.lastNow) / 1000));
    this.lastNow = now;
    const k = this.err, decay = this.live ? 0 : Math.exp(-wdt / 0.12);
    k[0] *= decay; k[1] *= decay;
    if (Math.abs(k[0]) < 0.002) k[0] = 0;
    if (Math.abs(k[1]) < 0.002) k[1] = 0;
    const p = this.posAt(rt);
    if (p) {
      const [fx, fy, moving, prog, fromX, fromY, tx, ty, dir, dist] = p;
      this.fx = fx + k[0]; this.fy = fy + k[1];
      this.moving = moving; this.prog = prog; this.fromX = fromX; this.fromY = fromY; this.dist = dist;
      // the cell it stands on (or is stepping into, as P's tx is)
      this.tx = moving ? tx : Math.round(this.fx); this.ty = moving ? ty : Math.round(this.fy);
      if (moving) this.dir = dir;
    }
    // looks and timers
    const L = this.lk;
    this.using = L.u === 1 ? 'eat' : L.u === 2 ? 'bow' : null;
    if (this.using) this.useT += dt;
    this.sleeping = L.sl ? { hx: L.sl[0], hy: L.sl[1], orient: DL[L.sl[2]] || 'up' } : null;
    this.dead = !!L.d;
    this.busy = L.b; this.voidFall = L.v ? 1 : 0;   // (the host's simulation reads these, as it reads P's)
    this.spectator = !!L.sp; this.hidden = !!L.hd;   // (stage 10, 9.5: entities.js canSee reads hidden as it reads P's)
    if (this.dead) this.deathT += dt;
    this.fireT = L.f ? 1 : 0;
    this.riding = L.rd ? { dir: this.dir, fx: this.fx, fy: this.fy, tx: this.tx } : null;
    this.swimming = !this.riding && !this.sleeping && G.world.isWater(this.tx, this.ty);
    if (L.v) this.voidT += dt;
    if (L.mn) {
      this.mineT += dt;
      if (this.swingT <= 0) this.swingT = 0.001;
    }
    if (this.swingT > 0) { this.swingT += dt; if (this.swingT >= 0.3) this.swingT = L.mn ? 0.001 : 0; }
    if (this.jumpT > 0) { this.jumpT += dt; this.z = Math.sin(Math.min(1, this.jumpT / 0.42) * Math.PI) * 7; if (this.jumpT >= 0.42) { this.jumpT = 0; this.z = 0; } }
    for (const key of ['hurtFlash', 'placeT']) if (this[key] > 0) this[key] = Math.max(0, this[key] - dt);
    this.visibleNow = this.known && !L.sp && (!this.dead || this.deathT < 1.2) && !(L.v && this.voidT > 1);   // (a spectator is never drawn)
  }

  gear() {
    const L = this.lk;
    const held = L.h ? { id: L.h, n: 1 } : null;
    const armor = L.ar.map((id) => (id ? { id, n: 1 } : null));
    return SK.withGear(SK.lookNow(this.skin), held, armor);
  }
  battling() { return this.lk.b === 2 || this.lk.b === 4; }
  info() {
    return { slot: this.slot, name: this.name, skin: this.skin, away: this.away, fx: +this.fx.toFixed(3), fy: +this.fy.toFixed(3), tx: this.tx, ty: this.ty, dir: this.dir,
      moving: this.moving, known: this.known, visible: !!this.visibleNow, look: { ...this.lk }, D: Math.round(this.D), queue: this.q.length, bad: this.bad,
      seg: this.seg ? { ...this.seg } : null, err: this.err.map((v) => +v.toFixed(3)), hist: this.hist.slice(-12) };
  }
}

// ------------------------------------------------------------------------------------------------ drawing
// Avatars in the viewer's own place (the same room, or both outdoors) join the y-sorted sprite list, so they are
// sorted with everything else and lit by the lighting pass like Steve.
export function sameView(av, P) {
  const W = G.world;
  return W.roomAt(av.tx, av.ty) === W.roomAt(P.tx, P.ty);
}
function poofAt(av) { try { E.poof(av.fx * TILE + 8, av.fy * TILE + 8); } catch (e) { /* cosmetic */ } }
export function sprites(avatars, P, cam, list) {
  for (const av of avatars) {
    if (!av.visibleNow || !sameView(av, P)) { av.puff = false; continue; }
    if (av.puff) { av.puff = false; poofAt(av); }
    const look = av.gear();
    if (!look) continue;
    const alpha = av.away ? 0.5 : 1;
    if (av.riding) {
      const boat = { fx: av.fx, fy: av.fy, tx: av.tx, dir: av.dir };
      list.push({ y: av.fy - 0.02, fn: (ctx) => { ctx.globalAlpha = alpha; E.drawBoat(ctx, boat, cam, 0); ctx.globalAlpha = 1; } });
      list.push({ y: av.fy + 0.04, fn: (ctx) => { ctx.globalAlpha = alpha; E.drawBoat(ctx, boat, cam, 1); ctx.globalAlpha = 1; } });
    }
    list.push({ y: (av.sleeping ? av.sleeping.hy + 0.2 : av.fy) + 0.02, fn: (ctx) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      if (av.lk.v) {
        const k = Math.min(1, av.voidT / 1.0), cx = av.fx * TILE + 8 - cam.x, cy = av.fy * TILE + 13 - cam.y;
        ctx.globalAlpha = alpha * Math.max(0, 1 - k); ctx.translate(cx, cy + k * 12); ctx.scale(1 - 0.7 * k, 1 - 0.7 * k); ctx.translate(-cx, -cy);
      }
      PL.drawSteve(ctx, av, cam, look);
      if (av.fireT > 0 && !av.dead && A.mc.fireStrip) {
        const f = Math.floor(G.clock * 20) % Math.max(1, Math.floor(A.mc.fireStrip.height / 16));
        ctx.globalAlpha = 0.85 * alpha;
        ctx.drawImage(A.mc.fireStrip, 0, f * 16, 16, 16, Math.round(av.fx * TILE - cam.x), Math.round(av.fy * TILE - cam.y - 18 - av.z), 16, 24);
      }
      ctx.restore();
      // the crack on the block it is mining, from the look's target and pace
      const mn = av.lk.mn;
      if (mn && !av.dead) {
        const b = G.world.block(mn[0], mn[1]);
        const progress = Math.min(0.99, (av.mineT * 20) / mn[2]);
        PL.drawCrack(ctx, { mining: { x: mn[0], y: mn[1], kind: b ? 'block' : 'tile', block: b, progress } }, cam);
      }
    } });
  }
}
// Name tags (and the Poké Ball over a player in a battle), at canvas resolution after the lighting
export function tags(avatars, P, ctx, cam) {
  // players side by side: a tag that would overlap one already placed (the lower player's) moves up a line
  const list = [];
  for (const av of avatars) {
    if (!av.visibleNow || av.dead || !sameView(av, P)) continue;
    const a = SK.tagAnchor(av, cam), w = mcWidth(String(av.name || '')) + 2, battling = av.battling();
    list.push({ av, a, w, battling, h: 9 + (battling ? 18 : 0) });
  }
  list.sort((p, q) => q.a.y - p.a.y);
  const placed = [];
  for (const t of list) {
    const hits = () => placed.find((o) => Math.abs(o.a.x - t.a.x) < (o.w + t.w) / 2 + 1 && t.a.y > o.a.y - o.h - 1 && t.a.y - t.h < o.a.y + 1);
    for (let k = 0; k < 4 && hits(); k++) { const o = hits(); t.a = { x: t.a.x, y: o.a.y - o.h - 1 }; }
    placed.push(t);
    SK.drawTagFor(ctx, t.av, cam, t.av.name, { battling: t.battling, clock: G.clock, alpha: t.av.away ? 0.5 : 1, anchor: t.a });
  }
}
