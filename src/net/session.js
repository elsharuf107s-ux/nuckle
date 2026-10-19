// The co-op session: who is in the room, their characters on screen, chat, the join snapshot and the guests'
// characters kept in the host's save. Loaded only when a player opens the CO-OP menu, hosts or joins.
// Design: multiplayer-design.md sections 4, 8, 11; transport in room.js, looks in skins.js, avatars in avatars.js,
// menus and overlays in ui.js.
//
// Reliable items on the host-guest pairs (room.js resends them until acknowledged):
//   host to guest: wd (a generated world's descriptor, before the snapshot: the world update's 9.1), snap (the join
//                  snapshot, a deflated blob), ro (final skins), chat (a chat line), rq (push your character record now)
//   guest to host: ch (chat text, or a death line), rec (the guest's character record, a blob)
// Broadcast B from the host: tm [time, day, timeScale] every 5 s. Movement M from everyone: avatars.js.
import { G } from '../game.js';
import { A } from '../assets.js';
import { NET } from './flag.js';
import { RoomClient, TEXT, cleanName, cleanCode, foldText, CODE_RE, SKINS } from './room.js';
import * as SK from './skins.js';
import { Mover, Avatar, sprites as drawSprites, tags as drawTags } from './avatars.js';
import * as UI from './ui.js';
import { HostWorld } from './host.js';
import { GuestWorld } from './guest.js';
import { causeText, contentKey } from './proto.js';

const GUEST_SKINS = SKINS.slice(1);
// a guest's character goes to the host when it changed, at most every 5 s (a crash loses at most that much)
const REC_MAX = 64 * 1024, REC_KEEP = 16, REC_EVERY = 5000, TM_EVERY = 5000;
export const CHAT_MAX = 100;
export const YELLOW = '#ffff55', WHITE = '#ffffff';
const PER_PLAYER_END = ['eyeMsg', 'eyeShort', 'eggHint', 'hofSeen'];
// a guest whose browser builds a different world from the host's descriptor (the probe, 9.1)
export const PROBE_TEXT = "This world can't be shared with this browser.";

function report(e) {
  const m = 'net: ' + String((e && e.stack) || e);
  G.errors = G.errors || [];
  if (G.errors.includes(m) || G.errors.length >= 30) return;   // (each error once: an error every frame floods nothing)
  G.errors.push(m);
  try { console.error(e); } catch (x) { /* no console */ }
}
const bridge = () => NET.bridge;
export const label = (skin) => SK.skinLabel(skin).toUpperCase();
export function cleanChat(s) { return foldText(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX); }
const keyOf = (name) => String(name || '').toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Session {
  constructor(role) {
    this.role = role;
    this.room = null;
    this.clock = 0;                // net clock: wall ms since the session began (performance.now)
    this.t0 = null;
    this.paceR = []; this.rate = 1;   // wall ms per game ms lately (see pre)
    this.avatars = new Map();      // slot -> Avatar (every other player)
    this.skinOver = new Map();     // slot -> skin, the host's final word (a returning guest keeps its own)
    this.mover = new Mover();
    this.lines = [];               // chat: { text, color, at (G.clock) }
    this.joined = role === 'host'; // a guest: the snapshot is applied and it plays
    this.myName = null; this.mySkin = role === 'host' ? 'steve' : null;
    this.tmAt = -1e9; this.lastDay = null;
    this.recAt = 0; this.recKey = '';
    this.chatRate = new Map();
    this.wasDead = false;
    this.leaving = false; this.closeAt = 0; this.closed = false;
    this.hiddenAt = null;
    this.c = { recIn: 0, recRefused: 0, chatIn: 0, snapBytes: 0, snapChunks: 0, badItems: 0 };
    // generated worlds (the world update, 9.1): the order the descriptor and the snapshot came in, the guest's world
    // build, the probe, and the join's timings (ms since the session began)
    this.g = { order: [], wdAt: null, snapAt: null, worldAt: null, applyAt: null, joinAt: null, probe: null, wdSent: 0 };
    this.worldP = null;
    this.applying = false; this.held = [];
    this.snapMs = 0;
    // stage 4: the shared world (host.js or guest.js), the host's live copies of the guests (for its simulation:
    // no playback buffer), and the sleep count shown in bed
    this.world = null;
    this.live = new Map();
    this.sleepCount = null;
  }

  attach(room) {
    this.room = room;
    room.onEvent = (ev) => this.event(ev);
    room.onDeliver = (d) => this.deliver(d);
    // (while a guest boots, each refused try is bootGuest's to handle: a taken name tries the next one)
    room.onClosed = (ev) => { if (this.room === room && !this.closed && !this.booting) this.ended(ev); };
    room.onTick = () => { if (this.world && this.role === 'host' && this.room === room) this.world.compose(); };
    NET.hiddenTick = () => this.hidden();
  }

  // ------------------------------------------------------------ per frame (main.js update, through NET.pre / post)
  pre(dt) {
    try {
      this.hiddenAt = null;
      // The net clock is wall time, never game time: a page below 20 fps clamps its frame dt (game time runs slow
      // there), and the others play its events in their own wall time. rate (wall ms per game ms over about the
      // last 60 frames) turns its game-timed walks and steps into wall time for them (Mover, HostWorld.step).
      const wall = performance.now();
      if (this.t0 == null) this.t0 = wall - this.clock - dt * 1000;
      const was = this.clock;
      this.clock = wall - this.t0;
      if (dt > 0) {
        // (the median of the last 31 frames' ratios: a page that is slow all the time is followed within half a
        // second, while one long frame, a hitch, leaves the walks sent after it untouched)
        this.paceR.push(Math.max(0, this.clock - was) / (dt * 1000));
        if (this.paceR.length > 31) this.paceR.shift();
        const s = [...this.paceR].sort((a, b) => a - b), m = s[s.length >> 1];
        this.rate = Number.isFinite(m) ? Math.max(0.2, Math.min(5, m)) : 1;
      }
      if (this.room) this.room.recv();
      for (const av of this.avatars.values()) { try { av.update(this.clock, dt); } catch (e) { av.bad++; report(e); } }
      for (const av of this.live.values()) { try { av.update(this.clock, dt); } catch (e) { av.bad++; report(e); } }
      // the shared world: the host handles the guests' intents now that their movement is in; a guest plays the
      // host's entities and notes this frame's "before"
      if (this.world) { try { if (this.role === 'host') this.world.afterRecv(); else this.world.pre(dt); } catch (e) { report(e); } }
      const B = bridge();
      // a guest waiting for its host: the game holds still (nothing the guest does could reach anyone)
      if (this.role === 'guest' && this.room && this.room.hostAway && B && B.state() === 'play') B.holdInput();
      if (this.role === 'guest' && this.joined && this.room && this.room.status === 'open' && this.clock - this.recAt >= REC_EVERY) this.pushRecord(false);
      if (this.closeAt && this.clock >= this.closeAt) { this.closeAt = 0; if (this.room) this.room.leave(); }
    } catch (e) { report(e); }
  }
  post(dt, hidden = false) {
    const room = this.room;
    try {
      const B = bridge(), P = G.P;
      // a guest's transaction and intents of this frame (before the movement, so the host checks them against it)
      if (this.world && this.role === 'guest' && this.joined) this.world.post();
      if (room && room.status === 'open' && this.joined && B && P) {
        if (!hidden) this.mover.capture(P, this.clock, dt, B.busyCode(), this.rate);
        // alone in the room: nobody to tell (whoever joins gets the whole state first)
        if (room.roster.size < 2) { this.mover.sent_(); this.mover.wantFull = true; }
        const p = this.mover.payload(this.clock);
        if (p) { room.set('M', 'gc', p.gc); room.set('M', 'ev', p.ev); }
        // a death line for everyone, in the dying player's own words
        if (P.dead && !this.wasDead && typeof P.deathMsg === 'string' && P.deathMsg) this.sendChat(P.deathMsg, true);
        // a guest's death goes into its record at once (a crash on the death screen then comes back dead)
        // (and its respawn, so the record stops saying it is dead)
        if (!!P.dead !== this.wasDead && this.role === 'guest') this.pushRecord(true);
        this.wasDead = !!P.dead;
        if (this.role === 'host' && (this.clock - this.tmAt >= TM_EVERY || G.day !== this.lastDay)) {
          room.set('B', 'tm', [Math.round(G.time), G.day, G.timeScale]);
          this.tmAt = this.clock; this.lastDay = G.day;
        }
      }
    } catch (e) { report(e); }
    if (room) {
      room.tick();
      if (!room.out.has('M')) this.mover.sent_();
    }
  }
  // the tab is hidden (no animation frames): room.js's clock calls this every 100 ms
  hidden() {
    const t = performance.now(), dt = this.hiddenAt == null ? 0.1 : Math.min(1, (t - this.hiddenAt) / 1000);
    // a host's world goes on for its friends (the game's own frame, without drawing: no animation frames come)
    if (this.role === 'host' && this.joined && bridge() && this.room && this.room.status === 'open') {
      try { bridge().holdInput(); bridge().update(Math.min(0.1, dt)); } catch (e) { report(e); }   // (no keys held while away)
      this.hiddenAt = performance.now();
      return;
    }
    this.pre(dt);
    this.hiddenAt = t;
    this.post(dt, true);
  }

  // ------------------------------------------------------------ the room's events
  avatar(slot) {
    if (!(slot >= 0 && slot <= 3) || (this.room && slot === this.room.slot)) return null;
    let av = this.avatars.get(slot);
    const r = this.room && this.room.roster.get(slot);
    if (!av) {
      if (!r) return null;
      av = new Avatar(slot, r.name, this.skinOf(slot));
      av.away = r.away ? 1 : 0;
      this.avatars.set(slot, av);
    }
    // the host simulates around where each guest is now (its own copy, no playback buffer)
    if (this.role === 'host' && slot > 0 && !this.live.has(slot)) { const lv = new Avatar(slot, r ? r.name : av.name, av.skin, true); lv.away = av.away; this.live.set(slot, lv); }
    return av;
  }
  setAway(slot, v) { const a = this.avatars.get(slot), b = this.live.get(slot); if (a) a.away = v; if (b) b.away = v; }
  skinOf(slot) {
    if (this.skinOver.has(slot)) return this.skinOver.get(slot);
    const r = this.room && this.room.roster.get(slot);
    return r && SKINS.includes(r.skin) ? r.skin : slot === 0 ? 'steve' : 'alex';
  }
  nameOf(slot) { const r = this.room && this.room.roster.get(slot); return r ? r.name : '?'; }

  event(ev) {
    switch (ev.t) {
      case 'welcome':
        for (const k of this.room.roster.keys()) this.avatar(k);
        if (this.role === 'host') UI.chatButton(true);
        return;
      case 'join': {
        this.avatars.delete(ev.slot); this.live.delete(ev.slot);
        this.skinOver.delete(ev.slot);
        if (this.role === 'host') { if (this.world) this.world.peerJoined(ev.slot); this.hostJoin(ev.slot); }
        const av = this.avatar(ev.slot);
        if (av) av.skin = this.skinOf(ev.slot);
        this.addLine(`${this.nameOf(ev.slot)} joined the game`, YELLOW);
        this.mover.wantFull = true;   // the newcomer needs to see where everyone is
        return;
      }
      case 'lost': this.setAway(ev.slot, 1); return;
      case 'back': this.setAway(ev.slot, 0); this.mover.wantFull = true; if (this.world && this.role === 'host') this.world.peerBack(ev.slot); return;
      case 'leave': {
        const av = this.avatars.get(ev.slot);
        const name = av ? av.name : null;
        this.avatars.delete(ev.slot); this.live.delete(ev.slot); this.skinOver.delete(ev.slot);
        if (this.world && this.role === 'host') this.world.peerLeft(ev.slot);
        if (name) this.addLine(`${name} left the game`, YELLOW);
        return;
      }
      case 'hostwait': { const av = this.avatars.get(0); if (av) av.away = 1; return; }
      case 'hostback': { const av = this.avatars.get(0); if (av) av.away = 0; this.mover.wantFull = true; if (this.world && this.role === 'guest') this.world.resumed(); return; }
      case 'resumed': this.mover.wantFull = true; if (this.world && this.role === 'guest') this.world.resumed(); if (this.world && this.role === 'host') for (const k of this.room.peers()) this.world.peerBack(k); return;
      case 'gap': if (this.world && this.role === 'guest') this.world.gap(ev); return;
      case 'closed': if (!this.closed && !this.booting) this.ended(ev); return;
      default:
    }
  }

  // a host's own name back to single-player's when its room is over
  restoreName() {
    if (this.role !== 'host' || !this.prevName) return;
    const [n, pn] = this.prevName; this.prevName = null;
    G.myName = n; if (G.P && pn != null) G.P.name = pn;
  }
  // the room ended for this page
  ended(ev) {
    this.closed = true;
    this.restoreName();
    this.avatars.clear(); this.live.clear();
    NET.hiddenTick = null;
    if (this.role === 'host' && this.world) { try { this.world.stop(); } catch (e) { report(e); } if (NET.h === this.world) NET.h = null; this.world = null; }
    UI.chatButton(false);
    if (this.role === 'host') {
      if (ev.why != null && bridge()) bridge().toast(ev.text || TEXT.lost);
      return;
    }
    if (this.leaving) return;
    // the tab is closing or reloading (pagehide): nothing to show, and 'rs.coop' stays as it is, so a reload boots
    // straight back into this room as the same player (a closed tab takes its sessionStorage with it)
    if (ev.unloading) return;
    if (!this.joined) { UI.joinFailed(ev.text || TEXT.lost, ev.why); return; }
    // the connection is gone for good: try a fresh join (the host still remembers this character by name)
    if (ev.why === 'lost') {
      const b = NET.boot || {};
      // (as the same character: its name and skin, even if the first join took them from a blank name)
      if ((b.tries || 0) < 3) { goJoin({ ...b, op: 'join', name: this.myName, skin: this.mySkin, tries: (b.tries || 0) + 1 }); return; }
    }
    goHome(ev.text || TEXT.lost);
  }

  // ------------------------------------------------------------ what arrived
  deliver(d) {
    if (this.leaving) return;
    if (d.kind === 'frame') {
      if (d.k === 'M') { const av = this.avatar(d.from); if (av) av.ingest(d.data, this.clock); const lv = this.live.get(d.from); if (lv) lv.ingest(d.data, this.clock); return; }
      if (d.k === 'B' && this.role === 'guest' && this.joined && Array.isArray(d.data.tm)) this.applyTime(d.data.tm);
      if (this.role === 'guest' && this.world && d.from === 0) {
        if (d.k === 'B') this.world.frameB(d.data);
        else if (d.k === 'G' && this.joined) this.world.frameG(d.data);
      }
      return;
    }
    if (d.kind !== 'item' || !Array.isArray(d.data)) return;
    const [, type, a, b] = d.data;
    if (this.role === 'guest') {
      if (d.from !== 0) return;
      if (type === 'wd') this.gotWd(a);
      else if (type === 'snap') this.applySnapshot(a, d.blob);
      else if (type === 'ro') this.applyRoster(a);
      else if (type === 'chat') { if (typeof a === 'string') this.addLine(cleanChat(a), b === YELLOW ? YELLOW : WHITE); }
      else if (type === 'rq') this.pushRecord(true);
      else if (this.world && this.joined) this.world.item(type, d.data.slice(2));
      else if (this.applying && this.held.length < 500) this.held.push([type, d.data.slice(2)]);   // (an async apply: after it)
      else this.c.badItems++;
      return;
    }
    // host: from a guest
    if (type === 'ch') this.hostChat(d.from, a, b);
    else if (type === 'rec') this.storeRecord(d.from, a);
    else if (this.world) this.world.intent(d.from, type, d.data.slice(2));
    else this.c.badItems++;
  }

  applyTime(tm) {
    const [t, day, scale] = tm;
    if (Number.isFinite(t) && t >= 0 && t < 24000) G.time = t;
    if (Number.isInteger(day) && day >= 0) G.day = day;
    if (Number.isFinite(scale) && scale > 0 && scale <= 1000) G.timeScale = scale;
  }

  // ------------------------------------------------------------ host: a guest joined
  hostJoin(slot) {
    const room = this.room, r = room.roster.get(slot);
    if (!r) return;
    const rec = this.record(r.name);
    // skins: a returning guest keeps its own unless someone here already wears it; nobody shares one
    const used = new Set(['steve']);
    for (const [k] of room.roster) if (k !== slot && k !== 0) used.add(this.skinOf(k));
    let skin = SKINS.includes(r.skin) && r.skin !== 'steve' ? r.skin : 'alex';
    if (rec && GUEST_SKINS.includes(rec.skin) && !used.has(rec.skin)) skin = rec.skin;
    if (used.has(skin)) skin = GUEST_SKINS.find((s) => !used.has(s)) || skin;
    this.skinOver.set(slot, skin);
    const roster = [...room.roster.entries()].map(([k, x]) => [k, x.name, k === slot ? skin : this.skinOf(k), x.away ? 1 : 0]);
    const send = (probe) => {
      try {
        // (a generated world's probe can take a moment: the guest may be gone by then)
        if (this.room !== room || !room.roster.get(slot) || room.roster.get(slot).name !== r.name) return;
        const rec2 = this.record(r.name);
        const snap = bridge().coopSnapshot();
        for (const k of PER_PLAYER_END) if (snap.end) delete snap.end[k];
        Object.assign(snap, { v: 1, build: room.build, name: r.name, skin, you: rec2 || null, roster }, this.world ? this.world.snapshotExtra() : {});
        if (probe !== undefined) snap.probe = probe;
        const str = JSON.stringify(snap);
        const t0 = performance.now();
        room.blob(slot, 'snap', str).then((info) => { this.c.snapBytes = info.bytes; this.c.snapChunks = info.chunks; this.c.snapRaw = info.raw; this.snapMs = Math.round(performance.now() - t0); }, report);
        if (rec2) rec2._iv = 0;   // (the guest's page counts its inventory states afresh)
      } catch (e) { report(e); }
    };
    // A generated world (9.1): its descriptor goes first, so the guest builds the world while the snapshot comes;
    // the snapshot carries the probe. Classic rooms send no descriptor, exactly as before.
    let wd = null;
    try { wd = bridge().coopWd ? bridge().coopWd() : null; } catch (e) { report(e); }
    if (wd) {
      room.reliable(slot, 'wd', wd); this.g.wdSent++;
      bridge().coopProbe().then((p) => send(p), (e) => { report(e); send(null); });
    } else send();
    // everyone else learns the newcomer's final skin
    for (const k of room.peers()) if (k !== slot) room.reliable(k, 'ro', [[slot, skin]]);
  }

  // ------------------------------------------------------------ guest: the snapshot
  // guest: a generated world's descriptor (9.1): the world is built now (worker, plan, plane) while the snapshot comes
  gotWd(wd) {
    // (stage 10: a descriptor after the join is the host's difficulty change, 9.1)
    if (this.joined) { if (wd && typeof wd === 'object' && bridge().coopModes) { try { bridge().coopModes(wd); } catch (e) { report(e); } } return; }
    if (this.worldP) return;
    this.g.order.push('wd'); this.g.wdAt = Math.round(this.clock);
    UI.joining('Generating world');
    this.worldP = this.buildWorld(wd);
  }
  buildWorld(wd) {
    const p = Promise.resolve().then(() => bridge().useWorld(wd)).then((w) => { this.g.worldAt = Math.round(this.clock); return w; });
    p.catch(() => {});   // (applySnapshot reports it)
    return p;
  }
  // guest: this browser built another world from the host's descriptor: say so on the title and leave
  probeFailed() {
    this.leaving = true;
    try { if (this.room) this.room.leave(); } catch (e) { report(e); }
    goHome(PROBE_TEXT);
  }
  async applySnapshot(str, blob) {
    if (this.joined || this.applying) return;
    let d;
    try { d = JSON.parse(str); } catch (e) { report(e); return; }
    if (!d || typeof d !== 'object' || d.v !== 1 || !d.world) { report(new Error('bad snapshot')); return; }
    this.g.order.push('snap'); this.g.snapAt = Math.round(this.clock);
    this.c.snapBytes = str.length; if (blob) this.c.snapChunks = blob.chunks;
    const room = this.room;
    this.myName = room.name;
    for (const row of Array.isArray(d.roster) ? d.roster : []) if (Array.isArray(row) && SKINS.includes(row[2])) { this.skinOver.set(row[0], row[2]); const av = this.avatars.get(row[0]); if (av) av.skin = row[2]; }
    this.mySkin = SKINS.includes(d.skin) ? d.skin : this.skinOf(room.slot);
    G.myName = this.myName; G.mySkin = this.mySkin;
    this.applying = true;
    try {
      // a generated world (9.1): the world started on the descriptor, the probe, then the save path's world part,
      // this character and the chunks around it (coopApply, async)
      if (d.wd) {
        if (!this.worldP) this.worldP = this.buildWorld(d.wd);   // (no descriptor came first: build it now)
        try { await this.worldP; } catch (e) { report(e); UI.joinFailed(TEXT.lost); return; }
        let mine = null;
        try { mine = await bridge().coopProbe(); } catch (e) { report(e); }
        this.g.probe = { host: d.probe ?? null, mine };
        if (typeof d.probe === 'string' && mine !== d.probe) { this.probeFailed(); return; }
        UI.joining('Preparing spawn area');
      }
      // (Classic: coopApply is synchronous, so a Classic join runs in one go exactly as before)
      try {
        const r = bridge().coopApply(d, d.you && typeof d.you === 'object' ? d.you : null, (k) => UI.joining(`Preparing spawn area: ${Math.round(k * 100)}%`));
        if (r && typeof r.then === 'function') await r;
      } catch (e) { report(e); UI.joinFailed(TEXT.lost); return; }
      if (this.closed || this.leaving) return;
      this.g.applyAt = Math.round(this.clock);
    } finally { this.applying = false; }
    this.wasDead = !!(G.P && G.P.dead);   // (back on its death screen: its death line was said already)
    try { if (this.world) this.world.boot(d); } catch (e) { report(e); }
    this.joined = true;
    this.recAt = this.clock;
    this.mover = new Mover();
    UI.joined();
    UI.chatButton(true);
    this.g.joinAt = Math.round(this.clock);
    // what the host sent while the world was being applied
    const held = this.held; this.held = [];
    for (const [type, rest] of held) { try { this.world.item(type, rest); } catch (e) { report(e); } }
    this.addLine(`${this.myName} joined the game`, YELLOW);
    try { localStorage.setItem('rs.coop.name', this.myName); } catch (e) { /* no storage */ }
    // a reload of this tab (or a fresh join after a lost connection) comes back as this same character
    NET.boot = { op: 'join', code: room.code, name: this.myName, skin: this.mySkin, tries: 0, again: 1 };
    try { sessionStorage.setItem('rs.coop', JSON.stringify(NET.boot)); } catch (e) { /* no storage */ }
    // the guest's own Steve wears its skin (the sheets load in a moment; Steve's are drawn until then)
    if (this.mySkin !== 'steve') SK.applyOwnSkin(this.mySkin).catch(report);
    // a generated world (9.5, stage 10): this device's player id, so a hardcore death's dead list knows it renamed
    if (d.wd) { try { room.reliable(0, 'pid', this.pid()); } catch (e) { report(e); } }
  }
  // this device's player id (9.5): 64 random bits, made once and kept in localStorage
  pid() {
    if (this._pid) return this._pid;
    let v = null;
    try { v = localStorage.getItem('rs.pid'); } catch (e) { /* no storage */ }
    if (!v || !/^[0-9a-f]{16}$/.test(v)) {
      const b = new Uint8Array(8);
      try { crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < 8; i++) b[i] = Math.floor(Math.random() * 256); }
      v = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      try { localStorage.setItem('rs.pid', v); } catch (e) { /* this session only */ }
    }
    this._pid = v;
    return v;
  }
  // guest: a hardcore death (9.5): 'hcd' goes after this frame's transaction (its death drop), so the host takes the
  // drop before this slot becomes a spectator's
  hcDied(cause) {
    if (this.role !== 'guest' || !this.joined || !this.world) return;
    this.world.send('hcd', typeof cause === 'string' ? cause.slice(0, 120) : '', this.pid());
  }
  // host: the descriptor again (a difficulty change, 9.1)
  resendWd() {
    const room = this.room;
    if (this.role !== 'host' || !room || room.status !== 'open') return;
    const wd = bridge().coopWd ? bridge().coopWd() : null;
    if (!wd) return;
    for (const k of room.peers()) room.reliable(k, 'wd', wd);
    this.g.wdSent++;
  }
  applyRoster(list) {
    if (!Array.isArray(list)) return;
    for (const row of list) {
      if (!Array.isArray(row) || !(row[0] >= 0 && row[0] <= 3) || !SKINS.includes(row[1])) continue;
      this.skinOver.set(row[0], row[1]);
      const av = this.avatars.get(row[0]); if (av) av.skin = row[1];
      if (this.room && row[0] === this.room.slot && row[1] !== this.mySkin) { this.mySkin = G.mySkin = row[1]; SK.applyOwnSkin(row[1]).catch(report); }
    }
  }

  // ------------------------------------------------------------ guests' characters in the host's save
  record(name) { const k = keyOf(name); return G.coop && G.coop.players && G.coop.players[k] ? G.coop.players[k] : null; }
  storeRecord(slot, str) {
    const r = this.room.roster.get(slot);
    if (!r || typeof str !== 'string') return;
    if (str.length > REC_MAX) { this.c.recRefused++; return; }
    let rec;
    try { rec = JSON.parse(str); } catch (e) { this.c.recRefused++; return; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || !rec.P || !rec.inv) { this.c.recRefused++; return; }
    // a spectating guest (9.5, stage 10): its record was cleared at its hardcore death and stays cleared
    if (this.world && this.world.isSpec && this.world.isSpec(slot)) { this.c.recSpec = (this.c.recSpec || 0) + 1; return; }
    rec.name = r.name; rec.skin = this.skinOf(slot); rec.seen_at = Date.now();
    // a record made before the guest's last transaction or container click (records travel compressed, so one can
    // arrive after a later click): what it carries is the host's newer copy
    const old = this.record(r.name);
    if (old && old.inv && (old._iv || 0) > (Number.isInteger(rec._iv) ? rec._iv : 0)) {
      rec.inv = old.inv; rec._iv = old._iv;
      if (old.P && rec.P) { for (const k of ['level', 'xpProgress', 'xpTotal']) rec.P[k] = old.P[k]; if (old.P.dead) { rec.P.dead = 1; rec.P.health = 0; } }
    }
    if (!G.coop || typeof G.coop !== 'object' || !G.coop.players) G.coop = { v: 1, players: {} };
    G.coop.players[keyOf(r.name)] = rec;
    const keys = Object.keys(G.coop.players);
    if (keys.length > REC_KEEP) keys.sort((a, b) => (G.coop.players[a].seen_at || 0) - (G.coop.players[b].seen_at || 0)).slice(0, keys.length - REC_KEEP).forEach((k) => delete G.coop.players[k]);
    this.c.recIn++;
    // a hardcore host (living or spectating) saves on guests' record pushes, at most every 5 s (9.5, stage 10)
    if (G.mr && G.mr.autosave && bridge() && bridge().autosave && this.clock - (this.recSaveAt || -1e9) >= 5000) {
      this.recSaveAt = this.clock; this.c.recSaves = (this.c.recSaves || 0) + 1;
      try { bridge().autosave('record'); } catch (e) { report(e); }
    }
  }
  // guest: send this character's record to the host: within 5 s of a change to what it carries (inventory, party,
  // dex, money, spawn...), within 15 s when only its position or health and hunger moved, at once on request and
  // before leaving. (Play time and saturation ride along but never trigger a push.)
  pushRecord(force) {
    this.recAt = this.clock;
    const room = this.room;
    if (!room || room.status !== 'open' || !this.joined) return null;
    let rec;
    try { rec = bridge().coopRecord(); } catch (e) { report(e); return null; }
    // (the inventory state sent last with a transaction: the host keeps whichever of the two is newer)
    if (this.world && this.world.invSeq) rec._iv = this.world.invSeq;
    const str = JSON.stringify(rec);
    const things = JSON.stringify({ ...rec, playTime: 0, P: 0 }), stats = JSON.stringify({ ...rec.P, sat: 0 });
    if (!force) {
      if (things === this.recKey && stats === this.recStats) return null;
      if (things === this.recKey && this.clock - (this.recSentAt || 0) < 15000) return null;
    }
    if (str.length > REC_MAX) return null;     // the host would refuse it: its last record stays
    this.recKey = things; this.recStats = stats; this.recSentAt = this.clock;
    return room.blob(0, 'rec', str);
  }

  // ------------------------------------------------------------ chat
  addLine(text, color = WHITE) {
    if (!text) return;
    this.lines.push({ text, color, at: G.clock });
    if (this.lines.length > 60) this.lines.splice(0, this.lines.length - 60);
  }
  // this player says something (or, sys, a death line in its own words)
  sendChat(text, sys = false) {
    const t = cleanChat(text);
    if (!t || !this.room) return false;
    if (this.role === 'host') {
      const line = sys ? t : `<${this.room.name}> ${t}`;
      this.addLine(line, WHITE);
      for (const k of this.room.peers()) this.room.reliable(k, 'chat', line, WHITE);
    } else {
      if (!this.joined) return false;
      this.room.reliable(0, 'ch', t, sys ? 1 : 0);
    }
    return true;
  }
  hostChat(slot, text, sys) {
    const r = this.room.roster.get(slot);
    const t = cleanChat(text);
    if (!r || !t) return;
    // at most 5 lines in 5 seconds from one guest
    const now = this.clock, q = (this.chatRate.get(slot) || []).filter((x) => now - x < 5000);
    if (q.length >= 5) { this.chatRate.set(slot, q); return; }
    q.push(now); this.chatRate.set(slot, q);
    // a death line must be about the guest who sent it
    const line = sys && t.startsWith(r.name + ' ') ? t : `<${r.name}> ${t}`;
    this.c.chatIn++;
    this.addLine(line, WHITE);
    for (const k of this.room.peers()) this.room.reliable(k, 'chat', line, WHITE);
  }

  // ------------------------------------------------------------ leaving
  // guest: save the character with the host, say goodbye, and go back to this player's own world
  async leave(msg = null) {
    if (this.leaving) return;
    const room = this.room;
    try {
      if (room && room.status === 'open' && this.joined) {
        await this.pushRecord(true);
        this.leaving = true;
        const t0 = performance.now();
        while (performance.now() - t0 < 2500 && room.status === 'open' && (room.outbox[0].length || room.blobsOut[0].length)) { room.tick(); await sleep(50); }
      }
    } catch (e) { report(e); }
    this.leaving = true;
    try { if (room) room.leave(); } catch (e) { report(e); }
    goHome(msg);
  }
  // host: SAVE asks the guests for their characters (the next save has them all up to date)
  askRecords() { if (this.role === 'host' && this.room) for (const k of this.room.peers()) this.room.reliable(k, 'rq'); }
  // host: CLOSE. The guests push their characters first; the room closes a moment later.
  close() {
    const room = this.room;
    if (!room || this.role !== 'host') return;
    for (const k of room.peers()) room.reliable(k, 'rq');
    this.closeAt = this.clock + (room.peers().length ? 1200 : 0) + 1;
  }

  // ------------------------------------------------------------ the shared world's helpers (flag.js, main.js)
  // a world event at cell (x, y) this player would hear and feel: same place, within r cells, tab in view
  near(x, y, r = 24) {
    const P = G.P, W = G.world;
    if (!P || !W || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return false;
    if (Math.abs(x - P.fx) > r || Math.abs(y - P.fy) > r) return false;
    const cx = Math.round(x), cy = Math.round(y);
    if (W.layout.gen) return W.samePlace(cx, cy, P.tx, P.ty);   // (generated layouts: the same place, 2.10)
    return (W.isOutdoor(cx, cy) && W.isOutdoor(P.tx, P.ty)) || W.areaOf(cx, cy) === W.areaOf(P.tx, P.ty);
  }
  // somebody else lies in the bed with its head at (hx, hy)
  bedTaken(hx, hy) {
    for (const av of this.avatars.values()) { const s = av.lk && av.lk.sl; if (s && s[0] === hx && s[1] === hy && !av.away) return true; }
    return false;
  }
  causeText(cause, name) { return causeText(cause, name); }
  // main.js's screen loop with a container open
  screen(scr, dt, input) {
    if (this.world && (this.role === 'host' || this.joined)) { try { this.world.screen(scr, dt, input); } catch (e) { report(e); } return; }
    scr.update(dt, input);
  }

  // ------------------------------------------------------------ drawing (main.js)
  sprites(cam, list) { if (G.P) drawSprites([...this.avatars.values()], G.P, cam, list); }
  tags(ctx, cam) { if (G.P) drawTags([...this.avatars.values()], G.P, ctx, cam); }
  drawHud(ctx, state, toastBottom = 0) { UI.drawHud(ctx, this, state, toastBottom); }

  // ------------------------------------------------------------ tests
  info() {
    const r = this.room;
    return { role: this.role, joined: this.joined, closed: this.closed, me: this.myName, mySkin: this.mySkin, clock: Math.round(this.clock),
      avatars: this.avatars.size, skins: [...this.avatars.values()].map((a) => [a.slot, a.name, a.skin]), lines: this.lines.length,
      hostAway: !!(r && r.hostAway), sess: { ...this.c, snapMs: this.snapMs }, gen: { ...this.g, order: this.g.order.slice() }, records: G.coop && G.coop.players ? Object.keys(G.coop.players) : [],
      world: this.world ? this.world.info() : null, sleepCount: this.sleepCount };
  }
  avatarInfo() { return [...this.avatars.values()].map((a) => a.info()); }
}

// ------------------------------------------------------------ going places (page reloads)
function goJoin(req) {
  try { sessionStorage.setItem('rs.coop', JSON.stringify(req)); } catch (e) { /* no storage */ }
  setTimeout(() => location.reload(), 0);
}
export function goHome(msg) {
  try { sessionStorage.removeItem('rs.coop'); if (msg) sessionStorage.setItem('rs.coopmsg', msg); } catch (e) { /* no storage */ }
  setTimeout(() => location.reload(), 0);
}
// JOIN (title or START menu): the page reloads straight into the host's world; this player's own save is never
// touched while it is there. A blank name takes the skin's name (ALEX, then ZURI... if that one is playing).
export function requestJoin(code, name, skin) {
  const c = cleanCode(code);
  if (!CODE_RE.test(c)) return TEXT.nocode;
  const n = String(name || '').trim();
  if (n && !cleanName(n)) return TEXT.badname;
  goJoin({ op: 'join', code: c, name: n ? cleanName(n) : '', skin: SKINS.includes(skin) && skin !== 'steve' ? skin : '', tries: 0 });
  return null;
}

// ------------------------------------------------------------ starting
export async function startHost(name = 'STEVE') {
  if (NET.room) throw new Error('A room is already open.');
  const n = cleanName(name) || 'STEVE';
  const S = new Session('host');
  const room = new RoomClient({ role: 'host', name: n, skin: 'steve' });
  NET.s = S; NET.room = room;
  S.attach(room); S.myName = n;
  S.world = new HostWorld(S); NET.h = S.world;
  // the host plays under its name too (death lines, the bed's blast, the menus), as its tag shows it
  S.prevName = [G.myName, G.P ? G.P.name : null];
  G.myName = n; if (G.P) G.P.name = n;
  try { return await room.start(); } catch (e) {
    S.restoreName();
    if (NET.room === room) NET.room = null;
    if (NET.s === S) NET.s = null;
    NET.hiddenTick = null;
    try { S.world.stop(); } catch (x) { /* nothing to undo */ }
    if (NET.h === S.world) NET.h = null;
    throw e;
  }
}

// the co-op boot after JOIN's reload: never loads or makes a single-player world
export async function bootGuest(req) {
  const S = new Session('guest');
  NET.s = S; NET.guest = true;
  S.world = new GuestWorld(S); NET.g = S.world;
  S.booting = true;
  UI.joining('Joining...');
  const auto = !req.name;
  let idx = Math.max(0, GUEST_SKINS.indexOf(req.skin)), waits = 0;
  for (;;) {
    const skin = auto ? GUEST_SKINS[idx] : req.skin || '';
    const name = auto ? label(skin) : req.name;
    const room = new RoomClient({ role: 'guest', code: req.code, name, skin });
    NET.room = room;
    S.attach(room);
    try { await room.start(); S.booting = false; break; } catch (e) {
      const code = room.error && room.error.code;
      if (NET.room === room) NET.room = null;
      NET.guest = true;
      // a blank name: that skin's name is playing, so try the next skin
      if (code === 4409 && auto && idx < GUEST_SKINS.length - 1) { idx++; continue; }
      // rejoining after a lost connection: the room may still hold the old slot (that name, or the room counts it
      // as full) until its hold window runs out
      // (also a reloaded tab of a player who was in: its old socket may not have closed yet)
      if ((code === 4409 || code === 4403 || code === 4410) && ((req.tries || 0) > 0 || req.again) && waits < 16) { waits++; await sleep(2500); continue; }
      S.booting = false; S.closed = true;
      UI.joinFailed((room.error && room.error.text) || TEXT.busy, code);
      return;
    }
  }
  UI.joining('Loading the world...');
  // the snapshot normally takes a second or two
  setTimeout(() => { if (!S.joined && !S.closed && NET.s === S) UI.joinFailed(TEXT.lost); }, 60000);
}

// main.js entry (NET.open)
export function open(what, arg) {
  if (what === 'boot') return bootGuest(arg || NET.boot);
  return UI.open(what, arg);
}

// the cells of a list of plane data chunks (ascending chunk keys; row by row inside each)
function* cellsOf(W, chunks) {
  const C = 32, CW = Math.ceil(W.W / C);
  for (const ck of [...new Set(chunks)].filter((k) => Number.isInteger(k) && k >= 0 && W.cstate[k] === 2).sort((a, b) => a - b)) {
    const x0 = (ck % CW) * C, y0 = Math.floor(ck / CW) * C;
    for (let ly = 0; ly < C; ly++) for (let lx = 0; lx < C; lx++) { const x = x0 + lx, y = y0 + ly; if (x < W.W && y < W.H) yield y * W.W + x; }
  }
}

// window.__rs.net hooks
export const api = {
  host: (name) => startHost(name),
  join: (code, name, skin) => { const err = requestJoin(code, name, skin); if (err) throw new Error(err); return 'reloading'; },
  leave: () => (NET.s ? (NET.s.role === 'host' ? NET.s.close() : NET.s.leave()) : null),
  chat: (text) => (NET.s ? NET.s.sendChat(text) : false),
  records: () => (G.coop ? JSON.parse(JSON.stringify(G.coop)) : null),
  uiDo: (...a) => UI.testDo(...a),
  // tests: every block and changed tile as this page has it (to find where two pages differ)
  // (generated layouts, 9.3: only over the chunk list given, normally the chunks both pages have made; a generated
  // decoration counts as the cell's block)
  dump: (chunks = null) => {
    const W = G.world, out = {};
    if (W.cstate && Array.isArray(chunks)) {
      for (const i of cellsOf(W, chunks)) { const b = W.blockAt(i); if (b) out[i] = contentKey(b); if (W.grid[i] !== W.baseTile(i)) out['t' + i] = W.grid[i]; }
      return out;
    }
    for (const [i, b] of W.blocks) out[i] = contentKey(b);
    for (let i = 0; i < W.grid.length; i++) if (W.grid[i] !== W.baseTile(i)) out['t' + i] = W.grid[i];
    return out;
  },
  // tests: the world as this page has it (every cell's tile, every block by its content key), and the entities near
  // a point (the host's own, or a guest's replicas) by network id
  digest: (x = null, y = null, r = 20, chunks = null) => {
    const W = G.world, g = W.grid;
    let h = 2166136261, blocks;
    if (W.cstate && Array.isArray(chunks)) {
      blocks = [];
      for (const i of cellsOf(W, chunks)) { h ^= g[i]; h = Math.imul(h, 16777619); const b = W.blockAt(i); if (b) blocks.push(i + ':' + contentKey(b)); }
      blocks.sort();
    } else {
      for (let i = 0; i < g.length; i++) { h ^= g[i]; h = Math.imul(h, 16777619); }
      blocks = [...W.blocks.entries()].map(([i, b]) => i + ':' + contentKey(b)).sort();
    }
    let hb = 2166136261;
    for (const s of blocks) for (let i = 0; i < s.length; i++) { hb ^= s.charCodeAt(i); hb = Math.imul(hb, 16777619); }
    const ents = x == null ? [] : G.ents.filter((e) => e.nid != null && !e.dead && Math.abs((e.tx ?? Math.floor(e.x / 16)) - x) <= r && Math.abs((e.ty ?? Math.floor(e.y / 16)) - y) <= r)
      .map((e) => [e.nid, e.type, e.kind || e.species || (e.stack && e.stack.id) || '', e.type === 'item' || e.type === 'xp' || e.type === 'arrow' || e.type === 'fireball' ? [Math.floor(e.x / 16), Math.floor(e.y / 16)] : [e.tx, e.ty]]).sort((a, b) => a[0] - b[0]);
    const end = {}; for (const k of ['crystals', 'placed', 'dragon', 'kills', 'respawned', 'exitActive', 'egg', 'eggHops']) end[k] = G.end ? G.end[k] : null;
    return { grid: h >>> 0, blocks: hb >>> 0, nBlocks: blocks.length, ents, end: JSON.stringify(end), time: Math.round(G.time), day: G.day };
  },
};
