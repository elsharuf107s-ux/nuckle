// Co-op flag: the only part of src/net/ that single-player ever loads. Everything else in src/net/ is imported on
// demand when a player opens the CO-OP menu, hosts or joins, so with no room open there is no socket, no timer, no
// DOM and no extra work: main.js only reads NET.on / NET.guest / NET.s, which stay false and null.
// The world helpers below (players, target, busy, vuln, hurt, near, far) are only called from co-op branches
// (behind a NET.on check); the shared world itself lives in host.js and guest.js.
import { G } from '../game.js';
let mod = null, smod = null;
const SOLO = [null];

export const NET = {
  on: false,        // a room is open (connected, or reconnecting after a drop)
  host: false,      // this page hosts the room (slot 0)
  guest: false,     // this page is a guest (slot 1 to 3); true from the co-op boot on
  slot: 0,
  room: null,       // the RoomClient (src/net/room.js) while a room is open or opening
  last: null,       // the last RoomClient, kept after it closed so tests and menus can read its counters and error
  h: null, g: null, // host and guest modules (later stages)
  s: null,          // the co-op session (src/net/session.js) once loaded: players, avatars, chat, records
  ui: null,         // the co-op menus and overlays (src/net/ui.js) once loaded
  bridge: null,     // main.js internals the co-op modules call (closures; set once at boot, never called in single-player)
  boot: null,       // a co-op boot request carried through a page reload (sessionStorage 'rs.coop'), or null
  titleMsg: null,   // a one-shot line for the title after leaving a friend's world ("The host left the game.")
  hiddenTick: null, // set by the session: keeps the network going while the tab is hidden
  // ---- the shared world (co-op branches only): every player the host simulates around, the player a mob goes
  // for, whether a player can be hurt, damage to any player (a guest gets it as a 'hit'), and whether a world event
  // at (x, y) is near enough this page's player to be heard and felt
  players() { if (NET.h) return NET.h.players(); SOLO[0] = G.P; return SOLO; },
  target(m) { return NET.h ? NET.h.target(m) : G.P; },
  busy(p) { return p === G.P ? G.busy() : !!(p && p.busy); },
  vuln(p) { return NET.h ? NET.h.vuln(p) : !!p && !p.dead; },
  hurt(p, dmg, cause, from, ranged, opts, extra) {
    if (NET.h) return NET.h.hurt(p, dmg, cause, from, ranged, opts || {}, extra || {});
    // (a room with no shared world on top, as the transport tests open: Steve is hurt as ever)
    return p === G.P && G.hurtPlayer ? G.hurtPlayer(dmg, `${p.name || 'Steve'} died`, from, ranged, opts || {}) : false;
  },
  near(x, y, r = 24) { return NET.s ? NET.s.near(x, y, r) : true; },
  board(boat, on) { if (NET.g) NET.g.board(boat, on); else if (NET.h) NET.h.boardSelf(boat, on); },
  far(x, y, rx = 30, ry = 24) { for (const p of NET.players()) if (Math.abs(x - p.tx) <= rx && Math.abs(y - p.ty) <= ry) return false; return true; },
  // called by main.js update() only while NET.on: deliver what arrived (frame start) and send this tick's batch
  pre(dt) { if (NET.s) NET.s.pre(dt); else if (NET.room) NET.room.recv(); },
  post(dt) { if (NET.s) NET.s.post(dt); else if (NET.room) NET.room.tick(); },
  load: () => (mod ? Promise.resolve(mod) : import('./room.js').then((m) => (mod = m))),
  session: () => (smod ? Promise.resolve(smod) : import('./session.js').then((m) => (smod = m))),
  // open a co-op screen ('menu' from START > CO-OP, 'join' from the title); loads the co-op modules first
  open(what, arg) {
    return NET.session().then((m) => m.open(what, arg)).catch((e) => {
      G_err(e);
      if (NET.bridge) { NET.bridge.setState('play'); NET.bridge.say('Co-op is busy right now. Try again later.'); }
    });
  },
};
function G_err(e) { try { console.error(e); } catch (x) { /* no console */ } }

// A co-op boot (JOIN reloads the page) and the one-shot title line, read once. Absent in single-player: nothing
// else happens here then.
try {
  const raw = sessionStorage.getItem('rs.coop');
  if (raw) { const b = JSON.parse(raw); if (b && b.op === 'join' && typeof b.code === 'string') NET.boot = b; else sessionStorage.removeItem('rs.coop'); }
  const m = sessionStorage.getItem('rs.coopmsg');
  if (m) { NET.titleMsg = m.slice(0, 120); sessionStorage.removeItem('rs.coopmsg'); }
} catch (e) { /* no storage: no co-op boot */ }

// window.__rs.net: test hooks. Nothing is loaded until one of them is called.
const via = (fn) => (...a) => (mod ? mod.api[fn](...a) : NET.load().then((m) => m.api[fn](...a)));
const viaS = (fn) => (...a) => NET.session().then((m) => m.api[fn](...a));
const cur = () => NET.room || NET.last;
export const netHooks = {
  // the game's own co-op: host() resolves the room code; join() reloads the page into the host's world (the
  // harness waits for state().joined after the reload); leave() leaves as the menu does
  host: (name) => viaS('host')(name),
  join: (code, name, skin) => viaS('join')(code, name, skin),
  leave: () => (NET.s ? viaS('leave')() : mod ? mod.api.leave() : undefined),
  chat: (text) => viaS('chat')(text),
  info: () => (NET.s ? NET.s.info() : { role: null }),
  titleMsg: () => NET.titleMsg,
  avatars: () => (NET.s ? NET.s.avatarInfo() : []),
  lines: (n = 20) => (NET.s ? NET.s.lines.slice(-n).map((l) => ({ text: l.text, color: l.color })) : []),
  records: () => viaS('records')(),
  digest: (...a) => viaS('digest')(...a),
  dump: () => viaS('dump')(),
  world: () => (NET.s && NET.s.world ? NET.s.world.info() : null),
  tmNow: () => { if (NET.s) NET.s.tmAt = -1e9; return !!NET.s; },   // the host's time sync goes out at the next tick
  ui: () => (NET.ui ? NET.ui.info() : null),
  uiDo: (...a) => viaS('uiDo')(...a),
  // transport only (stage 1 tests): a raw room with no session on top
  hostRaw: (name) => { NET.s = null; return via('host')({ name }); },
  joinHere: (code, name, skin) => via('join')({ code, name, skin }),
  drop: () => (mod ? mod.api.drop() : undefined),
  cut: () => (NET.room ? NET.room.cut() : undefined),
  sim: via('sim'), set: via('set'), add: via('add'), reliable: via('reliable'), blob: via('blob'),
  echo: via('echo'), raw: via('raw'), flush: via('flush'),
  state: () => {
    const r = cur(), s = r ? r.state() : { role: null, status: 'none' };
    if (NET.s) Object.assign(s, NET.s.info());
    return s;
  },
  log: (n = 50) => { const r = cur(); return r ? r.log.slice(-n) : []; },
  events: (n = 50) => { const r = cur(); return r ? r.eventLog.slice(-n) : []; },
  loaded: () => !!mod,
};
