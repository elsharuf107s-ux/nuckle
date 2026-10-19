// Sound for Redstone: Minecraft's own sound files for everything Steve does, FireRed-style synth blips
// for the menus, the real Gen 3 cries, and music loops rendered from FireRed's own song data
// (tools/build_music.py).
//
// Every sound goes through play functions of the form (ctx, out, t0, ...) so the same call can play
// live or be replayed into an OfflineAudioContext: while recording (the video renderer) each call is
// logged against game time and rendered afterwards.
import { A } from './assets.js';

let ctx = null, master = null, musicBus = null, sfxBus = null;
// music on/off (M key); remembered between visits. The video renderer records music regardless.
let musicMuted = (() => { try { return localStorage.getItem('poke-redstone-music') === 'off'; } catch (e) { return false; } })();
export function setMusicMuted(v) {
  musicMuted = !!v;
  try { localStorage.setItem('poke-redstone-music', musicMuted ? 'off' : 'on'); } catch (e) {}
  if (musicBus) musicBus.gain.setValueAtTime(musicMuted ? 0 : 0.55, ctx.currentTime);
}
export const isMusicMuted = () => musicMuted;
let recording = null; // { events: [], now: () => seconds }

function ac() {
  if (recording) return null;
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = musicMuted ? 0 : 0.55; musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// ---------------------------------------------------------------- instruments
const waves = new WeakMap();
function pulseWave(c, duty) {
  let m = waves.get(c);
  if (!m) { m = {}; waves.set(c, m); }
  if (m[duty]) return m[duty];
  const n = 48, re = new Float32Array(n), im = new Float32Array(n);
  for (let k = 1; k < n; k++) im[k] = (2 / (k * Math.PI)) * Math.sin(Math.PI * k * duty) * Math.exp(-k / 18); // soften upper harmonics
  m[duty] = c.createPeriodicWave(re, im);
  return m[duty];
}
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function env(c, g, t0, a, peak, d, sus, rel, end) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + a);
  g.gain.linearRampToValueAtTime(peak * sus, t0 + a + d);
  g.gain.setValueAtTime(peak * sus, Math.max(t0 + a + d, end));
  g.gain.linearRampToValueAtTime(0.0001, end + rel);
}
function tone(c, out, t0, { freq, dur, type = 'square', duty = 0.25, vol = 0.1, a = 0.004, d = 0.08, sus = 0.6, rel = 0.05, slide = 0, cutoff = 3000 }) {
  const o = c.createOscillator();
  if (type === 'pulse') o.setPeriodicWave(pulseWave(c, duty)); else o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.linearRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  const g = c.createGain();
  env(c, g, t0, a, vol, d, sus, rel, t0 + dur);
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = 0.3;
  o.connect(f).connect(g).connect(out);
  o.start(t0); o.stop(t0 + dur + rel + 0.02);
}
const noiseCache = new WeakMap();
function noiseBuf(c) {
  let b = noiseCache.get(c);
  if (!b) {
    b = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = b.getChannelData(0);
    let x = 12345;
    for (let i = 0; i < d.length; i++) { x = (x * 1103515245 + 12345) >>> 0; d[i] = ((x >>> 8) / 8388608) - 1; }
    noiseCache.set(c, b);
  }
  return b;
}
function noise(c, out, t0, { dur, vol = 0.1, lp = 2000, hp = 60, a = 0.003, rel = 0.05, sweep = 0 }) {
  const s = c.createBufferSource(); s.buffer = noiseBuf(c); s.loop = true;
  const f1 = c.createBiquadFilter(); f1.type = 'lowpass'; f1.frequency.setValueAtTime(lp, t0);
  if (sweep) f1.frequency.linearRampToValueAtTime(Math.max(80, lp + sweep), t0 + dur);
  const f2 = c.createBiquadFilter(); f2.type = 'highpass'; f2.frequency.value = hp;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(vol, t0 + a);
  g.gain.setValueAtTime(vol, t0 + Math.max(a, dur * 0.3)); g.gain.linearRampToValueAtTime(0.0001, t0 + dur + rel);
  s.connect(f1).connect(f2).connect(g).connect(out);
  s.start(t0, Math.random() * 0.5); s.stop(t0 + dur + rel + 0.02);
}

// ---------------------------------------------------------------- sound effects
const SFX = {
  move: (c, o, t) => tone(c, o, t, { freq: 1046, dur: 0.035, type: 'pulse', duty: 0.5, vol: 0.045, cutoff: 1800 }),
  select: (c, o, t) => { tone(c, o, t, { freq: 784, dur: 0.04, type: 'pulse', duty: 0.5, vol: 0.06, cutoff: 1900 }); tone(c, o, t + 0.045, { freq: 1175, dur: 0.06, type: 'pulse', duty: 0.5, vol: 0.06, cutoff: 1900 }); },
  cancel: (c, o, t) => tone(c, o, t, { freq: 523, dur: 0.07, type: 'pulse', duty: 0.5, vol: 0.06, slide: -180, cutoff: 2200 }),
  bump: (c, o, t) => tone(c, o, t, { freq: 110, dur: 0.06, type: 'triangle', vol: 0.14 }),
  pop: (c, o, t) => tone(c, o, t, { freq: 330, dur: 0.1, type: 'pulse', duty: 0.25, vol: 0.08, slide: 420, cutoff: 2400 }),
  throw: (c, o, t) => noise(c, o, t, { dur: 0.25, vol: 0.06, lp: 900, sweep: 1600, hp: 300 }),
  ballOpen: (c, o, t) => { noise(c, o, t, { dur: 0.12, vol: 0.07, lp: 1800, hp: 500 }); [1047, 1319, 1568].forEach((f, i) => tone(c, o, t + 0.05 + i * 0.05, { freq: f, dur: 0.08, type: 'sine', vol: 0.05, sus: 0.3 })); },
  recall: (c, o, t) => tone(c, o, t, { freq: 880, dur: 0.22, type: 'sine', vol: 0.07, slide: -600 }),
  wobble: (c, o, t) => { tone(c, o, t, { freq: 220, dur: 0.05, type: 'pulse', duty: 0.5, vol: 0.08, cutoff: 1500 }); noise(c, o, t, { dur: 0.04, vol: 0.05, lp: 1800, hp: 400 }); },
  click: (c, o, t) => { tone(c, o, t, { freq: 1568, dur: 0.03, type: 'pulse', duty: 0.5, vol: 0.05, cutoff: 1900 }); tone(c, o, t + 0.04, { freq: 784, dur: 0.05, type: 'pulse', duty: 0.5, vol: 0.05, cutoff: 1900 }); },
  breakFree: (c, o, t) => { noise(c, o, t, { dur: 0.15, vol: 0.09, lp: 1600, hp: 250 }); tone(c, o, t, { freq: 392, dur: 0.12, type: 'pulse', vol: 0.07, slide: 300, cutoff: 1900 }); },
  hit: (c, o, t) => { noise(c, o, t, { dur: 0.09, vol: 0.18, lp: 1600, hp: 80, sweep: -900 }); tone(c, o, t, { freq: 140, dur: 0.08, type: 'triangle', vol: 0.18, slide: -60 }); },
  hitSuper: (c, o, t) => { noise(c, o, t, { dur: 0.14, vol: 0.2, lp: 2400, hp: 80, sweep: -1500 }); tone(c, o, t, { freq: 180, dur: 0.12, type: 'triangle', vol: 0.2, slide: -100 }); noise(c, o, t + 0.07, { dur: 0.08, vol: 0.12, lp: 1400, hp: 100 }); },
  hitWeak: (c, o, t) => noise(c, o, t, { dur: 0.07, vol: 0.12, lp: 900, hp: 80 }),
  gust: (c, o, t) => noise(c, o, t, { dur: 0.5, vol: 0.1, lp: 700, sweep: 1400, hp: 200, a: 0.12 }),
  zap: (c, o, t) => { for (let i = 0; i < 4; i++) noise(c, o, t + i * 0.06, { dur: 0.05, vol: 0.08, lp: 2200, hp: 900 }); },
  flame: (c, o, t) => noise(c, o, t, { dur: 0.5, vol: 0.12, lp: 1100, hp: 100, a: 0.08, sweep: 400 }),
  splash: (c, o, t) => noise(c, o, t, { dur: 0.3, vol: 0.1, lp: 2200, hp: 500, sweep: -1200 }),
  psychic: (c, o, t) => { tone(c, o, t, { freq: 440, dur: 0.4, type: 'sine', vol: 0.06, slide: 440 }); tone(c, o, t + 0.05, { freq: 660, dur: 0.35, type: 'sine', vol: 0.04, slide: -220 }); },
  statUp: (c, o, t) => [523, 659, 784, 1047].forEach((f, i) => tone(c, o, t + i * 0.06, { freq: f, dur: 0.07, type: 'sine', vol: 0.06, sus: 0.4 })),
  statDown: (c, o, t) => [1047, 784, 659, 523].forEach((f, i) => tone(c, o, t + i * 0.06, { freq: f, dur: 0.07, type: 'sine', vol: 0.06, sus: 0.4 })),
  faint: (c, o, t) => tone(c, o, t, { freq: 420, dur: 0.5, type: 'pulse', duty: 0.25, vol: 0.06, slide: -330, cutoff: 1400 }),
  expTick: (c, o, t) => tone(c, o, t, { freq: 1568, dur: 0.02, type: 'sine', vol: 0.025, sus: 0.3 }),
  flee: (c, o, t) => noise(c, o, t, { dur: 0.35, vol: 0.08, lp: 600, sweep: 1800, hp: 200, a: 0.05 }),
  flap: (c, o, t) => noise(c, o, t, { dur: 0.09, vol: 0.035, lp: 500, hp: 90, a: 0.03 }),
  whoosh: (c, o, t) => noise(c, o, t, { dur: 0.7, vol: 0.09, lp: 400, sweep: 1500, hp: 120, a: 0.25 }),
  land: (c, o, t) => { tone(c, o, t, { freq: 90, dur: 0.14, type: 'triangle', vol: 0.16, slide: -40 }); noise(c, o, t, { dur: 0.12, vol: 0.06, lp: 700, hp: 80 }); },
  shiny: (c, o, t) => [1568, 2093, 2349].forEach((f, i) => tone(c, o, t + i * 0.07, { freq: f, dur: 0.09, type: 'sine', vol: 0.035, sus: 0.3 })),
  heal: (c, o, t) => [[72, 0], [76, 0.14], [79, 0.28], [84, 0.42], [79, 0.62], [84, 0.76]].forEach(([m, dt]) => tone(c, o, t + dt, { freq: midiHz(m), dur: 0.16, type: 'pulse', duty: 0.5, vol: 0.06, cutoff: 2400, sus: 0.5 })),
  levelUp: (c, o, t) => [[72, 0], [76, 0.1], [79, 0.2], [84, 0.3], [83, 0.5], [84, 0.62]].forEach(([m, dt]) => tone(c, o, t + dt, { freq: midiHz(m), dur: 0.12, type: 'pulse', duty: 0.5, vol: 0.06, cutoff: 2400, sus: 0.5 })),
  caught: (c, o, t) => [[67, 0], [72, 0.12], [76, 0.24], [79, 0.36], [76, 0.56], [79, 0.68], [84, 0.8]].forEach(([m, dt]) => tone(c, o, t + dt, { freq: midiHz(m), dur: dt === 0.8 ? 0.5 : 0.14, type: 'pulse', duty: 0.5, vol: 0.06, cutoff: 2400, sus: 0.5 })),
  save: (c, o, t) => [[79, 0], [84, 0.12], [88, 0.24]].forEach(([m, dt]) => tone(c, o, t + dt, { freq: midiHz(m), dur: 0.14, type: 'pulse', duty: 0.5, vol: 0.05, cutoff: 2400, sus: 0.5 })),
};


// ---------------------------------------------------------------- sample files (Minecraft sounds, cries, music)
const bytesCache = new Map();          // url -> Promise<ArrayBuffer>
const liveBuf = new Map();             // url -> AudioBuffer (live context)
function fetchBytes(url) {
  if (!bytesCache.has(url)) bytesCache.set(url, fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
  return bytesCache.get(url);
}
async function liveBuffer(url) {
  if (liveBuf.has(url)) return liveBuf.get(url);
  const c = ac(); if (!c) return null;
  const b = await fetchBytes(url);
  if (!b) { liveBuf.set(url, null); return null; }
  try { const buf = await c.decodeAudioData(b.slice(0)); liveBuf.set(url, buf); return buf; } catch (e) { liveBuf.set(url, null); return null; }
}
function playBuffer(c, out, t0, buf, { gain = 1, rate = 1, pan = 0, lp = 0 } = {}) {
  if (!buf) return null;
  const s = c.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
  let node = s;
  if (lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; f.Q.value = 0.5; node.connect(f); node = f; }
  const g = c.createGain(); g.gain.value = gain;
  node.connect(g);
  if (pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(out); } else g.connect(out);
  s.start(t0);
  return s;
}
const sfxUrl = (file) => `assets/sfx/${file}.ogg`;

// Minecraft sound by group ('dig.stone', 'pop', 'zombie.say'...), a random variant like the game picks.
export function mc(group, { vol = 1, pitch = 1, pan = 0 } = {}) {
  const files = A.sfx[group];
  if (!files || !files.length) return;
  const file = files[Math.floor(Math.random() * files.length)];
  const url = sfxUrl(file);
  if (rec('buf', { url, gain: vol * 0.55, rate: pitch, pan })) return;
  liveBuffer(url).then((buf) => { try { const c = ac(); if (c && buf) playBuffer(c, sfxBus, c.currentTime + 0.005, buf, { gain: vol * 0.55, rate: pitch, pan }); } catch (e) {} });
}
// preload a set of groups so the first dig does not arrive late
export function preloadMc(groups) { for (const g of groups) for (const f of A.sfx[g] || []) liveBuffer(sfxUrl(f)); }

// FireRed's own jingles stand in for the synth versions; they pause the background music like the game.
const FANFARES = { heal: 'heal', levelUp: 'levelup', obtain: 'obtain' };
export const sfx = new Proxy({}, {
  get(_, name) {
    if (name === 'unlock') return () => { try { ac(); } catch (e) {} };
    if (FANFARES[name]) return () => music.fanfare(FANFARES[name]);
    return () => {
      if (rec('sfx', { name })) return;
      try { const c = ac(); if (c && SFX[name]) SFX[name](c, sfxBus, c.currentTime + 0.005); } catch (e) {}
    };
  },
});

const cryUrl = (key) => `assets/cries/${A.dex.species[key].file}.wav`;
export function cry(key, pitch = 1) {
  if (!A.dex.species[key] || key === 'STEVE') return;   // Steve has no cry file: his sounds are Minecraft's
  const url = cryUrl(key);
  if (rec('buf', { url, gain: 0.2, rate: pitch, lp: 2900 })) return;
  liveBuffer(url).then((buf) => { try { const c = ac(); if (c && buf) playBuffer(c, sfxBus, c.currentTime + 0.01, buf, { gain: 0.2, rate: pitch, lp: 2900 }); } catch (e) {} });
}
export function preloadCries(keys) { for (const k of keys) if (A.dex.species[k] && k !== 'STEVE') liveBuffer(cryUrl(k)); }

// ---------------------------------------------------------------- music: rendered FireRed songs
// assets/music/<name>.ogg with loop points in assets/music/music.json ({ name: { loopStart, loopEnd, gain } }).
let musicInfo = null;
fetch('assets/music/music.json').then((r) => (r.ok ? r.json() : {})).then((j) => { musicInfo = j; }).catch(() => { musicInfo = {}; });
const musicUrl = (name) => `assets/music/${name}.ogg`;
let current = null, live = null, fanfare = null;
function startMusic(c, out, t0, buf, info, loop = true) {
  const s = c.createBufferSource(); s.buffer = buf;
  if (loop && info && info.loopEnd) { s.loop = true; s.loopStart = info.loopStart; s.loopEnd = info.loopEnd; }
  else if (loop) s.loop = true;
  const g = c.createGain(); g.gain.value = (info && info.gain) || 1;
  s.connect(g).connect(out); s.start(t0);
  return { s, g };
}
// Minecraft's End tracks run 6 and 15 minutes (music.json `stream`): decoded whole they would take hundreds of MB, so
// they play through a media element routed into the music bus instead. Same { s, g } shape as startMusic for fadeOut.
function startStream(c, out, url, info, loop) {
  const el = new Audio();
  el.src = url; el.loop = loop; el.preload = 'auto';
  const src = c.createMediaElementSource(el);
  const g = c.createGain(); g.gain.value = (info && info.gain) || 1;
  src.connect(g).connect(out);
  el.play().catch(() => {});
  const stop = (t) => {
    setTimeout(() => { try { el.pause(); src.disconnect(); el.removeAttribute('src'); el.load(); } catch (e) {} }, Math.max(0, (t - c.currentTime) * 1000));
  };
  return { s: { stop }, g };
}
export const music = {
  play(name, { loop = true } = {}) {
    if (current === name) return;
    current = name;
    if (rec('music', { name, loop })) return;
    const c = ac(); if (!c) return;
    const prev = live; live = null;
    if (prev) fadeOut(c, prev, 0.3);
    const token = {};
    music._token = token;
    const sinfo = musicInfo && musicInfo[name];
    if (sinfo && sinfo.stream) { live = startStream(c, musicBus, musicUrl(name), sinfo, loop); return; }
    liveBuffer(musicUrl(name)).then((buf) => {
      if (music._token !== token || !buf) return;
      const info = musicInfo && musicInfo[name];
      live = startMusic(c, musicBus, c.currentTime + 0.05, buf, info, loop);
    });
  },
  // play a jingle over the music: the music drops out and comes back when it ends
  fanfare(name) {
    const info = musicInfo && musicInfo[name];
    const dur = info ? info.duration : 2;
    const resume = current;
    if (rec('fanfare', { name, dur, resume })) return;
    const c = ac(); if (!c) return;
    if (live) { fadeOut(c, live, 0.08); live = null; }
    const token = {}; music._token = token;
    liveBuffer(musicUrl(name)).then((buf) => {
      if (!buf) return;
      const node = startMusic(c, musicBus, c.currentTime + 0.05, buf, null, false);
      setTimeout(() => {
        if (music._token !== token) return;
        try { node.s.stop(); } catch (e) {}
        if (resume) { current = null; music.play(resume); }
      }, dur * 1000 + 120);
    });
    current = null;
  },
  stop(fade = 0.4) {
    if (!current) return;
    current = null; music._token = null;
    if (rec('musicStop', { fade })) return;
    const c = ac(); if (c && live) fadeOut(c, live, fade);
    live = null;
  },
  get current() { return current; },
};
function fadeOut(c, node, fade) {
  try { node.g.gain.setValueAtTime(node.g.gain.value, c.currentTime); node.g.gain.linearRampToValueAtTime(0.0001, c.currentTime + fade); node.s.stop(c.currentTime + fade + 0.05); } catch (e) {}
}

// ---------------------------------------------------------------- ambience: Minecraft's looping biome sound (the Nether)
// One loop at a time ('nether_wastes', 'soul_sand_valley': the '<name>.loop' sound group), crossfaded on change;
// its random additions and moods are ordinary mc() calls. Not part of the music, so M leaves it playing.
let amb = null;          // { name, node, token }
export const ambience = {
  play(name, { vol = 0.6 } = {}) {
    if (amb && amb.name === name) return;
    this.stop(1.5);
    const files = A.sfx[name + '.loop'];
    if (!files || !files.length) return;
    const token = {};
    amb = { name, node: null, token };
    if (rec('ambience', { name })) return;
    const c = ac(); if (!c) return;
    liveBuffer(sfxUrl(files[0])).then((buf) => {
      if (!amb || amb.token !== token || !buf) return;
      const s = c.createBufferSource(); s.buffer = buf; s.loop = true;
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.linearRampToValueAtTime(vol * 0.55, c.currentTime + 1.5);
      s.connect(g).connect(sfxBus); s.start(c.currentTime + 0.02);
      amb.node = { s, g };
    });
  },
  stop(fade = 1) {
    if (!amb) return;
    const prev = amb; amb = null;
    if (rec('ambienceStop', { fade })) return;
    const c = ac(); if (c && prev.node) fadeOut(c, prev.node, fade);
  },
  get current() { return amb ? amb.name : null; },
};

// ---------------------------------------------------------------- recording (video renderer)
function rec(type, data) { if (recording) { recording.events.push({ t: recording.now(), type, ...data }); return true; } return false; }
export function startRecording(now) { recording = { events: [], now }; current = null; }
export function recordedEvents() { return recording ? recording.events : []; }
// Render the recorded events into a WAV (base64) with an OfflineAudioContext.
export async function renderRecording(duration, sampleRate = 44100) {
  const events = recording ? recording.events : [];
  const c = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const m = c.createGain(); m.gain.value = 0.9; m.connect(c.destination);
  const mb = c.createGain(); mb.gain.value = 0.55; mb.connect(m);
  const sb = c.createGain(); sb.gain.value = 0.9; sb.connect(m);
  const bufs = new Map();
  const need = new Set();
  for (const e of events) { if (e.type === 'buf') need.add(e.url); if (e.type === 'music') need.add(musicUrl(e.name)); if (e.type === 'fanfare') { need.add(musicUrl(e.name)); if (e.resume) need.add(musicUrl(e.resume)); } }
  const pendingResume = [];
  for (const url of need) { const b = await fetchBytes(url); bufs.set(url, b ? await c.decodeAudioData(b.slice(0)).catch(() => null) : null); }
  let mus = null;
  const endMusic = (t, fade) => {
    if (!mus) return;
    try { mus.node.g.gain.setValueAtTime((mus.info && mus.info.gain) || 1, t); mus.node.g.gain.linearRampToValueAtTime(0.0001, t + fade); mus.node.s.stop(t + fade + 0.05); } catch (e) {}
    mus = null;
  };
  const flushResume = (upTo) => {
    while (pendingResume.length && pendingResume[0].t <= upTo) {
      const r = pendingResume.shift();
      if (!mus) mus = { info: r.info, node: startMusic(c, mb, r.t, r.rb, r.info, true) };
    }
  };
  for (const e of events) {
    const t = e.t + 0.02;
    flushResume(t);
    if (e.type === 'music' || e.type === 'fanfare' || e.type === 'musicStop') pendingResume.length = 0;
    if (e.type === 'sfx' && SFX[e.name]) SFX[e.name](c, sb, t);
    else if (e.type === 'buf') playBuffer(c, sb, t, bufs.get(e.url), e);
    else if (e.type === 'music') {
      endMusic(t, 0.3);
      const buf = bufs.get(musicUrl(e.name));
      if (buf) { const info = musicInfo && musicInfo[e.name]; mus = { info, node: startMusic(c, mb, t + 0.05, buf, info, e.loop !== false) }; }
    } else if (e.type === 'musicStop') endMusic(t, e.fade || 0.4);
    else if (e.type === 'fanfare') {
      const prev = mus;
      endMusic(t, 0.08);
      const buf = bufs.get(musicUrl(e.name));
      if (buf) startMusic(c, mb, t + 0.05, buf, null, false);
      if (e.resume && prev) {
        const rb = bufs.get(musicUrl(e.resume));
        const info = musicInfo && musicInfo[e.resume];
        if (rb) pendingResume.push({ t: t + e.dur + 0.12, name: e.resume, node: null, info, rb });
      }
    }
  }
  flushResume(Infinity);
  const out = await c.startRendering();
  return wavBase64(out);
}
function wavBase64(buf) {
  const n = buf.length, ch = buf.numberOfChannels, sr = buf.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true); data.setUint32(24, sr, true);
  data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const chans = [...Array(ch).keys()].map((i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) for (let k = 0; k < ch; k++) { const v = Math.max(-1, Math.min(1, chans[k][i])); data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  const bytes = new Uint8Array(data.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
