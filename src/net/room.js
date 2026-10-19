// Co-op transport: one WebSocket to the room relay, loaded only when a player hosts or joins. The relay is a
// separate server and is not part of this repository; without one, co-op reports that it cannot connect.
//
// Wire format. Client to relay, one binary message per network tick, made of sub-frames:
//   [u8 mask][u8 flags][u32 len LE][len bytes of UTF-8 JSON]...      mask bit k = deliver to slot k
// Relay to client: the same, with the mask replaced by the sender's slot (stamped by the relay, so it is
// trustworthy): [u8 from][u8 flags][u32 len][payload]...
// Every JSON payload carries k (stream: B host broadcast, G host to one guest, M movement to everyone else,
// I guest to host), s (sequence of that stream), t (sender clock, ms since its connection began), and on the
// host-guest pairs a (ack: highest contiguous reliable sequence received from the addressee) and r (reliable items
// [rs, type, ...fields], resent until acknowledged).
//
// Everything here is wrapped so that a network error can never throw into the game loop.
import { A } from '../assets.js';
import { G } from '../game.js';
import { NET } from './flag.js';
import { APP, SITE } from '../app.js';

export const PROTO_VERSION = 1;
export const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
export const SKINS = ['steve', 'alex', 'zuri', 'sunny', 'noor', 'makena', 'kai', 'efe', 'ari'];

// player-visible text (Minecraft voice, no em dashes)
export const TEXT = {
  busy: 'Co-op is busy right now. Try again later.',
  offline: 'Co-op needs the internet. Check your connection.',   // (the apps play offline; the room server is online)
  rate: 'Too many tries. Wait a few minutes and try again.',
  nocode: "There's no world with that code.",
  full: 'That world is full.',
  name: 'That name is already playing.',
  away: 'The host is away. Try again in a minute.',
  version: 'This world is on another version. Refresh, and get the host to refresh.',   // (two lines in the box)
  hostgone: 'The host left the game.',
  lost: 'The connection was lost.',
  badname: 'Use letters A to Z and numbers in your name.',
};
const CLOSE_TEXT = {
  4000: TEXT.hostgone, 4403: TEXT.full, 4404: TEXT.nocode, 4409: TEXT.name, 4410: TEXT.away,
  4413: TEXT.lost, 4426: TEXT.version, 4429: TEXT.rate,
};

const HOST_CAP = 256 * 1024, GUEST_CAP = 32 * 1024;   // the relay's per-message caps
const CHUNK = 24 * 1024;                               // blob chunk (join snapshot), two in flight at most
const PING_MS = 10000, DEAD_MS = 25000, CONNECT_MS = 10000, PROBE_MS = 8000;
const RETRY_GUEST = [500, 2000, 5000, 10000, 20000, 28000];                                   // inside the 30 s hold
const RETRY_HOST = [500, 2000, 5000, 10000, 20000, 30000, 45000, 60000, 75000, 88000];       // inside the 90 s hold
const enc = new TextEncoder(), dec = new TextDecoder();
const now = () => performance.now();

let buildId = null, genPart = null;
// the build id: a guest on another build must never edit the host's world (the relay refuses it with 4426). The world
// update (9.7) adds the generator's version and the first 8 hex digits of a hash of terrain.json, so two builds that
// would generate different worlds never share a room (prepareBuild fetches them before the first connection).
export function netBuild() {
  if (!buildId) {
    const w = A.world || {}, items = (A.items && A.items.items) || {};
    buildId = [PROTO_VERSION, w.layoutId || '0', (w.entries || []).length, Array.isArray(items) ? items.length : Object.keys(items).length, ...(genPart || [])].join('.');
  }
  return buildId;
}
export async function prepareBuild() {
  if (genPart) return;
  let v = 0, h = '0';
  try { v = (await import('../gen/version.js')).GEN_VERSION; } catch (e) { reportError(e); }
  try {
    const r = await fetch('assets/world/terrain.json');
    if (r.ok) {
      const t = await r.text();
      let x = 2166136261;
      for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = Math.imul(x, 16777619); }
      h = (x >>> 0).toString(16).padStart(8, '0');
    }
  } catch (e) { reportError(e); }
  genPart = [v, h];
  buildId = null;
}

// where the relay is: the page's own origin (/api/room/<code>), or, on a local dev server only, ?coop=ws://127.0.0.1:<port>
// (a relay running locally); in the apps (src/app.js) SITE's, when it is set
export function roomBase() {
  const q = new URLSearchParams(location.search).get('coop');
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (q && local && /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(q)) return q;
  if (APP && SITE) return SITE.replace(/^https:/, 'wss:');
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

// accents come off (the Minecraft font draws only ASCII and é): Zoë plays as Zoe, ça as ca
export function foldText(s) {
  let t = String(s || '');
  try { t = t.normalize('NFD').replace(/e\u0301/g, '\u00e9').replace(/[\u0300-\u036f]/g, '').normalize('NFC'); } catch (e) { /* old browser */ }
  return t;
}
// a name: 1 to 10 characters the name tags can draw (printable ASCII and é)
export function cleanName(s) {
  const n = foldText(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim();
  return n.length >= 1 && n.length <= 10 && /^[\x20-\x7e\u00e9]+$/.test(n) ? n : null;
}
export function cleanCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// a GET that resolves to its response, to null when it fails (no network, refused, or no CORS for this page), or to
// 'late' when nothing came back within PROBE_MS
async function reach(url, opt = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let late = false;
  const timer = ctl ? setTimeout(() => { late = true; ctl.abort(); }, PROBE_MS) : 0;
  try { return await fetch(url, { cache: 'no-store', ...opt, ...(ctl ? { signal: ctl.signal } : {}) }); } catch (e) { return late ? 'late' : null; } finally { clearTimeout(timer); }
}

function reportError(e) {
  const m = 'net: ' + String((e && e.stack) || e);
  G.errors = G.errors || [];
  if (G.errors.includes(m) || G.errors.length >= 30) return;   // (each error once: an error every frame floods nothing)
  G.errors.push(m);
  try { console.error(e); } catch (x) { /* no console */ }
}

// ------------------------------------------------------------ envelope
export function packFrames(parts) {   // parts: [[mask, flags, Uint8Array]]
  let n = 0;
  for (const p of parts) n += 6 + p[2].length;
  const out = new Uint8Array(n), dv = new DataView(out.buffer);
  let o = 0;
  for (const [mask, flags, b] of parts) { out[o] = mask; out[o + 1] = flags; dv.setUint32(o + 2, b.length, true); out.set(b, o + 6); o += 6 + b.length; }
  return out;
}
export function unpackFrames(buf) {   // -> [[from, flags, Uint8Array]] or null when malformed
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out = [];
  let o = 0;
  while (o < b.length) {
    if (o + 6 > b.length) return null;
    const len = dv.getUint32(o + 2, true);
    if (o + 6 + len > b.length) return null;
    out.push([b[o], b[o + 1], b.subarray(o + 6, o + 6 + len)]);
    o += 6 + len;
  }
  return out;
}

// ------------------------------------------------------------ blobs (the join snapshot): deflate, base64, chunks
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function packBlob(str) {
  if (typeof CompressionStream === 'function') {
    try {
      const buf = await new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
      return { z: 1, data: b64(new Uint8Array(buf)) };
    } catch (e) { /* fall through to plain */ }
  }
  return { z: 0, data: b64(enc.encode(str)) };
}
async function unpackBlob(z, data) {
  const bytes = unb64(data);
  if (!z) return dec.decode(bytes);
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
}

// ------------------------------------------------------------ the client
export class RoomClient {
  constructor({ role, code = null, name, skin = '', base = roomBase() }) {
    this.role = role; this.code = code; this.name = name; this.skin = skin; this.base = base;
    this.build = netBuild();
    this.status = 'idle';
    this.slot = role === 'host' ? 0 : -1;
    this.token = null; this.everWelcomed = false; this.error = null; this.hostAway = false;
    this.roster = new Map();
    this.ws = null; this.errCode = 0; this.leaving = false;
    this.t0 = now();
    // outgoing: per-stream data for this tick, sequences, reliable outboxes per peer slot
    this.out = new Map(); this.seq = {};
    this.rsOut = [0, 0, 0, 0]; this.outbox = [[], [], [], []];
    this.blobsOut = [[], [], [], []]; this.blobId = 0;
    // incoming
    this.rin = [0, 0, 0, 0]; this.early = [new Map(), new Map(), new Map(), new Map()];
    this.ackOwed = [0, 0, 0, 0]; this.lastIn = new Map();
    this.blobIn = [null, null, null, null]; this.hold = [null, null, null, null];
    this.inbox = []; this.events = []; this.log = []; this.eventLog = [];
    this.echoes = new Map(); this.echoN = 0;
    // timing and pacing
    this.rate = 5;                // host network ticks per second (10 while free movers are near a guest, later stages)
    this.minGap = 100;            // a guest sends at most one message per 100 ms
    this.lastSend = -1e9; this.lastPing = -1e9; this.pingAt = 0; this.lastPong = 0;
    this.rtt = 0; this.srtt = 0; this.rttvar = 0;   // to the relay, from pings
    this.peerRtt = [null, null, null, null];        // per peer, from echoed send times (te): includes the peer's tick and ack delay
    this.echoT = [null, null, null, null];          // the newest t of a frame with reliable items from that peer, echoed once as te
    this.sim = { lat: 0, jit: 0, drop: 0, pauseUntil: 0 }; this.outDue = 0; this.inDue = 0;
    this.c = { out: 0, outBytes: 0, in: 0, inBytes: 0, pings: 0, simDropOut: 0, simDropIn: 0, rejected: 0, gaps: 0, dups: 0, resends: 0, bad: 0, errors: 0, overCap: 0 };
    this.sentTimes = []; this.inTimes = [];
    this.retry = 0; this.dropAt = 0; this.retryTimer = 0; this.connectTimer = 0;
    this.onDeliver = null; this.onEvent = null;
    this.clock = null;
    this.waiters = null;
  }

  // ---------------------------------------------------------- connecting
  start() {
    return prepareBuild().then(() => {
      this.build = netBuild();
      return new Promise((resolve, reject) => {
        this.waiters = { resolve, reject };
        this.startClock();
        this.connect(false);
      });
    });
  }

  url(resume) {
    const q = new URLSearchParams({ name: this.name, v: this.build });
    if (this.skin) q.set('skin', this.skin);
    if (resume) q.set('resume', this.token);
    return this.base + '/api/room/' + (this.role === 'host' && !resume ? 'NEW' : this.code) + '?' + q.toString();
  }

  connect(resume) {
    this.status = resume ? 'reconnecting' : 'connecting';
    this.errCode = 0;
    let ws;
    try { ws = new WebSocket(this.url(resume)); } catch (e) { reportError(e); this.finish('busy'); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e) => this.arrive(ws, e.data);
    ws.onclose = (e) => this.closed(ws, e.code);
    ws.onerror = () => {};
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => { if (this.ws === ws && this.status !== 'open') { try { ws.close(); } catch (e) { /* closed */ } } }, CONNECT_MS);
  }

  // the socket closed: say why, or try to get the slot back
  closed(ws, code) {
    if (ws !== this.ws) return;           // an old socket replaced by a resume
    this.ws = null;
    clearTimeout(this.connectTimer);
    if (this.status === 'closed') return;
    code = this.errCode || code;
    if (this.leaving) { this.finish(null); return; }
    if (code === 4000) { this.finish(4000); return; }
    if (!this.everWelcomed) {
      if (CLOSE_TEXT[code]) { this.finish(code); return; }
      this.probe();                       // a refused upgrade (429) or an exhausted free tier looks like 1006
      return;
    }
    if (code === 4404 && this.status === 'reconnecting') { this.finish('lost'); return; }
    if (CLOSE_TEXT[code]) { this.finish(code); return; }
    this.reconnect();
  }

  // (no answer at all, or none in PROBE_MS: offline, unless an opaque request gets through, when the server answered
  // without CORS for this page's origin; any answer that is not the relay's: busy. A browser that knows it is offline
  // is not asked)
  async probe() {
    let why = 'busy';
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { this.finish('offline'); return; }
      const http = this.url(false).replace(/^ws/, 'http').replace(/\?.*$/, '') + '?why=1';
      const r = await reach(http);
      if (r && r !== 'late') { const j = await r.json(); if (j && j.e === 'rate') why = 'rate'; }
      else if (r === 'late') why = 'offline';
      else { const o = await reach(http, { mode: 'no-cors' }); if (!o || o === 'late') why = 'offline'; }
    } catch (e) { /* busy */ }
    this.finish(why);
  }

  reconnect() {
    if (this.noResume) { this.finish('lost'); return; }
    if (this.status !== 'reconnecting') { this.dropAt = now(); this.retry = 0; this.emit({ t: 'reconnecting' }); }
    this.status = 'reconnecting';
    const plan = this.role === 'host' ? RETRY_HOST : RETRY_GUEST;
    if (this.retry >= plan.length) { this.finish('lost'); return; }
    const wait = Math.max(0, this.dropAt + plan[this.retry] - now());
    this.retry++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (this.status === 'reconnecting' && !this.ws) this.connect(true); }, wait);
  }

  // end of the room for this page: why is null (left), a close code, or 'busy' / 'offline' / 'rate' / 'lost'
  finish(why) {
    if (this.status === 'closed') return;
    this.status = 'closed';
    clearTimeout(this.retryTimer); clearTimeout(this.connectTimer);
    this.error = why == null ? null : { code: why, text: CLOSE_TEXT[why] || TEXT[why] || TEXT.lost };
    if (this.ws) { const ws = this.ws; this.ws = null; try { ws.close(1000); } catch (e) { /* closed */ } }
    this.stopClock();
    if (NET.room === this) { NET.on = false; NET.host = false; NET.guest = false; NET.room = null; }
    NET.last = this;
    const ev = { t: 'closed', why, text: this.error ? this.error.text : null, unloading: !!this.unloading };
    this.emit(ev);
    // the game's frame no longer polls this room (NET.on is false now), so the session hears of it here
    if (this.onClosed) { try { this.onClosed(ev); } catch (e) { reportError(e); } }
    if (this.waiters) { const w = this.waiters; this.waiters = null; w.reject(new Error(this.error ? this.error.text : 'left')); }
  }

  leave() {
    if (this.status === 'closed') return;
    this.leaving = true;
    const ws = this.ws;
    if (ws && ws.readyState === 1) { try { ws.send('leave'); this.c.out++; this.sentTimes.push(now()); } catch (e) { /* closing */ } }
    this.finish(null);
  }

  // tests: lose the connection without saying goodbye (the relay holds the slot; this page resumes)
  drop() { if (this.ws) { try { this.ws.close(3001, 'drop'); } catch (e) { /* closed */ } } }
  // tests: vanish without a goodbye and never resume (a crashed tab or a dead phone; the relay holds the slot, then
  // lets it go)
  cut() { this.noResume = true; this.drop(); }

  // ---------------------------------------------------------- clock: pings, liveness, the hidden-tab tick
  startClock() {
    const beat = () => { try { this.heartbeat(); } catch (e) { reportError(e); } };
    try {
      const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 100);'], { type: 'text/javascript' }));
      this.clock = new Worker(url);
      URL.revokeObjectURL(url);
      this.clock.onmessage = beat;
    } catch (e) {
      this.clockTimer = setInterval(beat, 100);
    }
    // the page is going away (closed, reloaded, navigated): say goodbye now (a host's guests learn at once); the
    // session leaves sessionStorage alone then, so a reloaded guest tab boots back into this room as itself
    this.onHide = (e) => { if (!e.persisted && this.status !== 'closed') { this.unloading = true; this.leave(); } };
    window.addEventListener('pagehide', this.onHide);
  }
  stopClock() {
    if (this.clock) { try { this.clock.terminate(); } catch (e) { /* gone */ } this.clock = null; }
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = 0; }
    if (this.onHide) { window.removeEventListener('pagehide', this.onHide); this.onHide = null; }
  }
  heartbeat() {
    const t = now(), ws = this.ws;
    if (!ws || ws.readyState !== 1 || this.status !== 'open') return;
    // one ping in flight at a time (a pong carries nothing, so it must answer the ping we timed)
    if (!this.pingAt && t - this.lastPing >= PING_MS) { this.lastPing = t; this.pingAt = t; this.sendText('ping'); this.c.pings++; }
    if (this.lastPong && t - this.lastPong > DEAD_MS) { try { ws.close(3002, 'silent'); } catch (e) { /* closed */ } return; }
    // a hidden tab gets no animation frames: keep the network tick going from here (the host's world tick joins
    // it in a later stage)
    if (typeof document !== 'undefined' && document.hidden) { if (NET.hiddenTick) NET.hiddenTick(); else this.tick(t); }
  }

  // ---------------------------------------------------------- incoming
  arrive(ws, data) {
    try {
      const t = now(), size = typeof data === 'string' ? data.length : data.byteLength;
      this.c.in++; this.c.inBytes += size; this.inTimes.push(t);
      if (this.inTimes.length > 4000) this.inTimes.splice(0, 2000);
      const s = this.sim;
      if (typeof data !== 'string' && s.drop && Math.random() < s.drop) { this.c.simDropIn++; return; }
      const delay = s.lat || s.jit ? Math.max(0, s.lat + (Math.random() * 2 - 1) * s.jit) : 0;
      const due = Math.max(t + delay, this.inDue, s.pauseUntil);
      if (due <= t) { this.handle(data); return; }
      this.inDue = due;                     // TCP keeps order: a late message holds back the ones behind it
      setTimeout(() => { try { this.handle(data); } catch (e) { reportError(e); } }, due - t);
    } catch (e) { reportError(e); }
  }

  handle(data) {
    if (typeof data === 'string') {
      if (data === 'pong') { this.pong(); return; }
      let m;
      try { m = JSON.parse(data); } catch (e) { this.c.bad++; return; }
      if (m && typeof m === 'object') this.control(m);
      return;
    }
    const subs = unpackFrames(data);
    if (!subs) { this.c.bad++; return; }
    for (const [from, flags, bytes] of subs) {
      if (flags !== 0 || from > 3 || from === this.slot) { this.c.rejected++; continue; }
      let p;
      try { p = JSON.parse(dec.decode(bytes)); } catch (e) { this.c.bad++; continue; }
      if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.k !== 'string' || !Number.isInteger(p.s)) { this.c.bad++; continue; }
      this.payload(from, p);
    }
  }

  pong() {
    if (!this.pingAt) return;
    const r = now() - this.pingAt;
    this.pingAt = 0; this.lastPong = now();
    this.sample(r);
  }
  samplePeer(k, r) {
    const p = this.peerRtt[k];
    if (!p) { this.peerRtt[k] = { srtt: r, rttvar: r / 2 }; return; }
    p.rttvar = 0.75 * p.rttvar + 0.25 * Math.abs(p.srtt - r); p.srtt = 0.875 * p.srtt + 0.125 * r;
  }
  sample(r) {
    this.rtt = r;
    if (!this.srtt) { this.srtt = r; this.rttvar = r / 2; } else { this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r); this.srtt = 0.875 * this.srtt + 0.125 * r; }
  }

  // receiver rules: world streams only from the host; from a guest only movement (M), and intents (I) to the host
  payload(from, p) {
    const k = p.k;
    const ok = k === 'M' || ((k === 'B' || k === 'G') && from === 0 && this.role === 'guest') || (k === 'I' && from !== 0 && this.role === 'host');
    if (!ok) { this.c.rejected++; return; }
    const key = from + k, last = this.lastIn.get(key);
    if (last != null) {
      if (p.s <= last) { this.c.dups++; return; }
      if (p.s > last + 1) { this.c.gaps++; this.emit({ t: 'gap', from, k, first: last + 1, last: p.s - 1 }); }
    }
    this.lastIn.set(key, p.s);
    const peer = (k === 'G' || k === 'I') ? from : -1;   // the host-guest pair this frame belongs to
    if (peer >= 0) {
      if (Number.isInteger(p.a)) this.acked(peer, p.a, Array.isArray(p.sk) ? p.sk : null);
      // round trip to this peer, unambiguous even for resent items: it echoes our send time
      if (Number.isInteger(p.te)) { const r = now() - this.t0 - p.te; if (r >= 0 && r < 60000) this.samplePeer(peer, r); }
      if (Array.isArray(p.r)) {
        this.echoT[peer] = p.t;
        const t = now();
        for (let it of p.r) {
          if (!Array.isArray(it) || !Number.isInteger(it[0])) { this.c.bad++; continue; }
          // a numbered item with a bad body still takes its place in the sequence (as nothing), so the items after
          // it are not held back forever
          if (typeof it[1] !== 'string') { this.c.bad++; it = [it[0], '_nop']; }
          if (it[0] <= this.rin[peer]) { this.c.dups++; } else if (it[0] <= this.rin[peer] + 4096) this.early[peer].set(it[0], it);
          if (!this.ackOwed[peer]) this.ackOwed[peer] = t;   // owed even for a duplicate: our last ack may be lost
        }
        const q = this.early[peer];
        while (q.has(this.rin[peer] + 1)) { const it = q.get(this.rin[peer] + 1); q.delete(this.rin[peer] + 1); this.rin[peer]++; this.item(peer, it); }
      }
    }
    this.queue({ from, kind: 'frame', k, data: p });
  }

  // a reliable item, in order; a blob's chunks are put back together (and delivery from that peer waits for it)
  item(peer, it) {
    if (this.hold[peer]) { this.hold[peer].push(it); return; }
    if (it[1] === '_blob') {
      const [, , id, i, n, z, type, chunk] = it;
      if (i === 0) this.blobIn[peer] = { id, n, z, type, parts: [] };
      const b = this.blobIn[peer];
      if (!b || b.id !== id || typeof chunk !== 'string') { this.c.bad++; return; }
      b.parts.push(chunk);
      if (b.parts.length < n) return;
      this.blobIn[peer] = null;
      this.hold[peer] = [];
      unpackBlob(z, b.parts.join('')).then((str) => {
        this.queue({ from: peer, kind: 'item', data: [it[0], b.type, str], blob: { bytes: str.length, chunks: n, z } });
      }, (e) => { this.c.bad++; reportError(e); }).finally(() => {
        const rest = this.hold[peer] || [];
        this.hold[peer] = null;
        for (const x of rest) this.item(peer, x);
      });
      return;
    }
    if (it[1] === '_nop') return;
    if (it[1] === '_echo') { this.reliable(peer, '_echoed', it[2]); return; }   // test hook: transport round trip
    if (it[1] === '_echoed') { const e = this.echoes.get(it[2]); if (e) { this.echoes.delete(it[2]); e(now()); } return; }
    this.queue({ from: peer, kind: 'item', data: it });
  }

  // a: everything up to a arrived; sk: items past a gap that arrived too (selective ack), so only the gap is resent
  acked(peer, a, sk) {
    const box = this.outbox[peer];
    if (!box.length) return;
    const got = sk && sk.length ? new Set(sk.slice(0, 64)) : null;
    if (box[0].rs > a && !got) return;
    this.outbox[peer] = box.filter((x) => x.rs > a && !(got && got.has(x.rs)));
  }

  queue(d) {
    if (this.inbox.length > 20000) { this.inbox.splice(0, 10000); this.c.errors++; }
    this.inbox.push(d);
  }

  control(m) {
    switch (m.t) {
      case 'welcome': {
        if (!Number.isInteger(m.slot) || m.slot < 0 || m.slot > 3) { this.c.bad++; return; }
        const resumed = this.everWelcomed;
        this.slot = m.slot; this.code = m.code; this.token = m.token;
        const before = this.roster;
        this.roster = new Map();
        for (const r of m.roster || []) if (Array.isArray(r)) this.roster.set(r[0], { name: r[1], skin: r[2], away: r[3] ? 1 : 0 });
        // anyone who joined or left while this page was away starts a fresh stream
        for (const k of [0, 1, 2, 3]) {
          const a = before.get(k), b = this.roster.get(k);
          if (resumed && (!a || !b || a.name !== b.name)) this.resetPeer(k);
        }
        this.status = 'open'; this.everWelcomed = true; this.retry = 0; this.hostAway = false;
        this.lastPong = now(); this.lastPing = -1e9; this.pingAt = 0;
        clearTimeout(this.connectTimer);
        if (resumed) {
          for (const box of this.outbox) for (const x of box) x.next = 0;   // resend everything unacknowledged
          this.emit({ t: 'resumed', slot: this.slot });
        } else {
          NET.on = true; NET.host = this.role === 'host'; NET.guest = this.role === 'guest'; NET.slot = this.slot; NET.room = this;
          this.emit({ t: 'welcome', slot: this.slot, code: this.code });
          if (this.waiters) { const w = this.waiters; this.waiters = null; w.resolve(this.role === 'host' ? this.code : this.slot); }
        }
        return;
      }
      case 'join':
        if (!Number.isInteger(m.slot)) return;
        this.resetPeer(m.slot);
        this.roster.set(m.slot, { name: String(m.name || ''), skin: String(m.skin || ''), away: 0 });
        this.emit(m); return;
      case 'lost': { const r = this.roster.get(m.slot); if (r) r.away = 1; this.emit(m); return; }
      case 'back': {
        const r = this.roster.get(m.slot); if (r) r.away = 0;
        if (this.outbox[m.slot]) for (const x of this.outbox[m.slot]) x.next = 0;
        this.emit(m); return;
      }
      case 'leave': this.roster.delete(m.slot); this.resetPeer(m.slot); this.emit(m); return;
      case 'hostwait': { this.hostAway = true; const r = this.roster.get(0); if (r) r.away = 1; this.emit(m); return; }
      case 'hostback': {
        this.hostAway = false; const r = this.roster.get(0); if (r) r.away = 0;
        for (const x of this.outbox[0]) x.next = 0;
        this.emit(m); return;
      }
      case 'hostgone': this.finish(4000); return;
      case 'err':   // the relay refused us; it closes the socket too, but do not wait for that
        if (Number.isInteger(m.e)) this.errCode = m.e;
        if (this.ws) { const ws = this.ws; try { ws.close(1000); } catch (e) { /* closed */ } this.closed(ws, this.errCode); }
        return;
      default: this.c.bad++;
    }
  }

  resetPeer(k) {
    if (!(k >= 0 && k <= 3)) return;
    for (const key of [...this.lastIn.keys()]) if (key[0] === String(k)) this.lastIn.delete(key);
    this.rin[k] = 0; this.early[k].clear(); this.ackOwed[k] = 0;
    this.rsOut[k] = 0; this.outbox[k] = []; this.blobsOut[k] = []; this.blobIn[k] = null; this.hold[k] = null; this.peerRtt[k] = null; this.echoT[k] = null;
  }

  emit(ev) {
    ev.at = Math.round(now());
    this.events.push(ev);
    this.eventLog.push(ev);
    if (this.eventLog.length > 200) this.eventLog.splice(0, 100);
  }

  // frame start (main.js update, through NET.pre): hand everything that arrived to the game, one at a time, each
  // inside its own try/catch so one bad message can never stop the frame
  recv() {
    try {
      if (this.events.length) {
        const evs = this.events; this.events = [];
        for (const ev of evs) { try { if (this.onEvent) this.onEvent(ev); } catch (e) { this.c.errors++; reportError(e); } }
      }
      if (!this.inbox.length) return;
      const box = this.inbox; this.inbox = [];
      const t = Math.round(now());
      for (const d of box) {
        d.got = t; d.wall = Date.now();
        this.log.push(d);
        try { if (this.onDeliver) this.onDeliver(d); } catch (e) { this.c.errors++; reportError(e); }
      }
      if (this.log.length > 400) this.log.splice(0, this.log.length - 200);
    } catch (e) { reportError(e); }
  }

  // ---------------------------------------------------------- outgoing
  // stream data for the next tick: set(stream, key, value) replaces, add(stream, key, item) appends
  set(stream, key, value) { let o = this.out.get(stream); if (!o) this.out.set(stream, (o = {})); o[key] = value; }
  add(stream, key, value) { let o = this.out.get(stream); if (!o) this.out.set(stream, (o = {})); (o[key] || (o[key] = [])).push(value); }
  // a reliable item to one peer (host: a guest slot; guest: 0)
  reliable(peer, type, ...fields) {
    if (!(peer >= 0 && peer <= 3) || peer === this.slot) return 0;
    const rs = ++this.rsOut[peer];
    this.outbox[peer].push({ rs, item: [rs, type, ...fields], tries: 0, at: 0, next: 0 });
    return rs;
  }
  // a large string (the join snapshot) to one peer: deflated, then 24 KiB chunks paced by acks and bufferedAmount
  async blob(peer, type, str) {
    const packed = await packBlob(str);
    const parts = [];
    for (let i = 0; i < packed.data.length; i += CHUNK) parts.push(packed.data.slice(i, i + CHUNK));
    if (!parts.length) parts.push('');
    this.blobsOut[peer].push({ id: ++this.blobId, type, z: packed.z, parts, next: 0 });
    return { chunks: parts.length, bytes: packed.data.length, raw: str.length, z: packed.z };
  }
  echo(peer) {
    const id = ++this.echoN, t = now();
    return new Promise((resolve) => {
      this.echoes.set(id, (t2) => resolve(Math.round(t2 - t)));
      this.reliable(peer, '_echo', id);
    });
  }

  rto(peer) {
    // how long the peer may sit on an ack: a guest acks within its 250 ms ack-late limit plus its 100 ms gap; the
    // host acks with its next 5 Hz tick (200 ms) plus a frame
    // (only until acks from that peer have given a measured round trip, which already includes it)
    const p = this.peerRtt[peer];
    // Over a WebSocket nothing is lost in transit (TCP); items go missing only when the relay's rate cap drops a
    // message, in a resume (which resends everything at once anyway) or under the simulated network. So the timer
    // errs late (at least 600 ms): a spurious resend costs a billed message, a late one only delays a rare repair.
    if (p) return Math.min(3000, Math.max(600, p.srtt + 4 * p.rttvar + 200));
    const ackDelay = this.role === 'host' ? 350 : 250;
    const base = this.srtt ? this.srtt + 4 * this.rttvar : 600;
    return Math.min(3000, Math.max(600, base + ackDelay + 200));
  }

  peers() {
    if (this.role === 'guest') return [0];
    const out = [];
    for (const k of [1, 2, 3]) { const r = this.roster.get(k); if (r && !r.away) out.push(k); }
    return out;
  }

  // the network tick (main.js update end, through NET.post): at most one message, only when there is something
  tick(t = now()) {
    try {
      const ws = this.ws;
      if (this.status !== 'open' || !ws || ws.readyState !== 1 || this.hostAway) return;
      const gap = this.role === 'host' ? 1000 / this.rate : this.minGap;
      if (t - this.lastSend < gap - 1) return;
      // the host's world (host.js) adds what this tick carries: changed cells, entities, the dragon
      if (this.onTick) { try { this.onTick(t); } catch (e) { reportError(e); } }
      const peers = this.peers();
      // pace blob chunks into the outboxes: two unacknowledged at a time, and only while the socket drains
      for (const k of peers) {
        const q = this.blobsOut[k];
        while (q.length && ws.bufferedAmount < 64 * 1024) {
          const b = q[0];
          if (this.outbox[k].filter((x) => x.item[1] === '_blob').length >= 2) break;
          this.reliable(k, '_blob', b.id, b.next, b.parts.length, b.z, b.type, b.parts[b.next]);
          if (++b.next >= b.parts.length) q.shift();
        }
      }
      // a guest owes the host acks: one ack-only message after 1 s of saying nothing else (the host ticks anyway, so a
      // late ack costs it bytes, not messages); the host acks with its next tick
      const ackLate = this.role === 'host' ? 150 : 1000;
      let any = false;
      for (const o of this.out.values()) if (Object.keys(o).length) { any = true; break; }
      if (!any) for (const k of peers) {
        if (this.outbox[k].some((x) => x.next <= t) || (this.ackOwed[k] && t - this.ackOwed[k] >= ackLate)) { any = true; break; }
      }
      if (!any) return;
      const cap = (this.role === 'host' ? HOST_CAP : GUEST_CAP) - 512;
      const frames = [];
      const T = Math.round(t - this.t0);
      const build = (stream, k, mask, peer) => {
        const data = this.out.get(stream);
        const has = data && Object.keys(data).length;
        const due = peer >= 0 ? this.outbox[peer].filter((x) => x.next <= t) : [];
        const owes = peer >= 0 && this.ackOwed[peer];
        if (!has && !due.length && !owes) return;
        const p = { k, s: (this.seq[stream] = (this.seq[stream] || 0) + 1), t: T };
        if (has) Object.assign(p, data);
        if (peer >= 0) {
          if (this.rin[peer] || this.early[peer].size) p.a = this.rin[peer];
          if (this.early[peer].size) p.sk = [...this.early[peer].keys()].slice(0, 64);
          if (this.echoT[peer] != null) { p.te = this.echoT[peer]; this.echoT[peer] = null; }
          this.ackOwed[peer] = 0;
          let size = JSON.stringify(p).length;
          const items = [];
          for (const x of due) {
            const n = JSON.stringify(x.item).length + 1;
            if (items.length && size + n > cap) break;
            size += n; items.push(x);
          }
          if (items.length) {
            p.r = items.map((x) => x.item);
            for (const x of items) {
              if (x.tries) this.c.resends++;
              x.tries++; x.at = t;
              x.next = t + Math.min(3000, this.rto(peer) * 2 ** (x.tries - 1));
            }
          }
        }
        frames.push([mask, 0, enc.encode(JSON.stringify(p))]);
      };
      if (this.role === 'host') {
        build('B', 'B', 0b1110, -1);
        for (const k of peers) build('G' + k, 'G', 1 << k, k);
      } else {
        build('I', 'I', 0b0001, 0);
      }
      build('M', 'M', 0b1111 & ~(1 << this.slot), -1);
      this.out.clear();
      if (!frames.length) return;
      this.lastSend = t;
      // one message, unless (rarely) the batch is over the relay's cap: then as few as fit
      let batch = [], size = 0;
      for (const f of frames) {
        if (batch.length && size + 6 + f[2].length > cap) { this.sendBinary(packFrames(batch)); batch = []; size = 0; }
        if (6 + f[2].length > cap) { this.c.overCap++; continue; }
        batch.push(f); size += 6 + f[2].length;
      }
      if (batch.length) this.sendBinary(packFrames(batch));
    } catch (e) { reportError(e); }
  }

  // every message sent is counted (each one is 1/20 of a Durable Object request); the simulated network then
  // delays it (latency, jitter, in order) or drops it (binary game frames only, never pings or control text)
  sendBinary(bytes, droppable = true) {
    const t = now();
    this.c.out++; this.c.outBytes += bytes.length; this.sentTimes.push(t);
    if (this.sentTimes.length > 4000) this.sentTimes.splice(0, 2000);
    if (droppable && this.sim.drop && Math.random() < this.sim.drop) { this.c.simDropOut++; return; }
    this.later(bytes);
  }
  sendText(s) { this.later(s); }
  later(data) {
    const ws = this.ws, s = this.sim, t = now();
    if (!ws) return;
    const delay = s.lat || s.jit ? Math.max(0, s.lat + (Math.random() * 2 - 1) * s.jit) : 0;
    const due = Math.max(t + delay, this.outDue);
    if (due <= t) { try { ws.send(data); } catch (e) { /* closing */ } return; }
    this.outDue = due;
    setTimeout(() => { try { if (ws.readyState === 1) ws.send(data); } catch (e) { /* closing */ } }, due - t);
  }

  // test hook: raw messages straight to the relay (oversized or flooding), bypassing the tick
  raw({ size = 100, count = 1, mask = 0b1111 } = {}) {
    const body = enc.encode(JSON.stringify({ k: 'M', s: 0, t: 0, pad: 'x'.repeat(Math.max(0, size - 40)) }));
    for (let i = 0; i < count; i++) this.sendBinary(packFrames([[mask & ~(1 << this.slot), 0, body]]), false);
    return body.length + 6;
  }

  setSim({ lat, jit, drop, pause } = {}) {
    if (lat != null) this.sim.lat = Math.max(0, +lat || 0);
    if (jit != null) this.sim.jit = Math.max(0, +jit || 0);
    if (drop != null) this.sim.drop = Math.min(1, Math.max(0, +drop || 0));
    if (pause) this.sim.pauseUntil = now() + pause;
    return { ...this.sim };
  }

  state() {
    const t = now();
    const perMin = (arr) => arr.filter((x) => t - x <= 60000).length;
    return {
      role: this.role, status: this.status, code: this.code, slot: this.slot, name: this.name, build: this.build,
      players: [...this.roster.entries()].map(([k, r]) => [k, r.name, r.skin, r.away]).sort((a, b) => a[0] - b[0]),
      rtt: Math.round(this.rtt), srtt: Math.round(this.srtt), peerRtt: this.peerRtt.map((p) => (p ? Math.round(p.srtt) : null)), mpm: perMin(this.sentTimes), mpmIn: perMin(this.inTimes),
      ...this.c, pending: this.outbox.reduce((n, b) => n + b.length, 0), inbox: this.inbox.length,
      hostAway: this.hostAway, error: this.error, sim: { ...this.sim, pauseUntil: undefined },
    };
  }
}

// ------------------------------------------------------------ entry points (window.__rs.net through flag.js)
export async function host({ name = 'STEVE' } = {}) {
  if (NET.room) throw new Error('A room is already open.');
  const n = cleanName(name) || 'STEVE';
  const r = new RoomClient({ role: 'host', name: n, skin: 'steve' });
  NET.room = r;            // claimed while connecting; NET.on turns true on welcome
  try { return await r.start(); } finally { if (r.status === 'closed' && NET.room === r) NET.room = null; }
}

export async function join({ code, name, skin = '' } = {}) {
  if (NET.room) throw new Error('A room is already open.');
  const c = cleanCode(code);
  if (!CODE_RE.test(c)) throw new Error(TEXT.nocode);
  const n = cleanName(name);
  if (!n) throw new Error(TEXT.badname);
  const r = new RoomClient({ role: 'guest', code: c, name: n, skin: SKINS.includes(skin) ? skin : '' });
  NET.room = r;
  try { return await r.start(); } finally { if (r.status === 'closed' && NET.room === r) NET.room = null; }
}

export const api = {
  host, join,
  leave: () => { if (NET.room) NET.room.leave(); },
  drop: () => { if (NET.room) NET.room.drop(); },
  sim: (o) => (NET.room ? NET.room.setSim(o) : null),
  set: (stream, key, value) => NET.room && NET.room.set(stream, key, value),
  add: (stream, key, value) => NET.room && NET.room.add(stream, key, value),
  reliable: (peer, type, ...f) => (NET.room ? NET.room.reliable(peer, type, ...f) : 0),
  blob: (peer, type, str) => (NET.room ? NET.room.blob(peer, type, str) : null),
  echo: (peer) => (NET.room ? NET.room.echo(peer) : null),
  raw: (o) => (NET.room ? NET.room.raw(o) : 0),
  flush: () => { if (NET.room) { NET.room.lastSend = -1e9; NET.room.tick(); } },
};
