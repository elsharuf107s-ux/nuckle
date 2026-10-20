// Fully procedural audio: every sound effect and the music loop are synthesised with WebAudio,
// so the game ships no audio files. Nothing is created until init() is called from a user gesture.

import { clamp } from './util.js';

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI note -> Hz

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.volume = 0.7;
    this.muted = false;
    this.listener = { x: 0, z: 0, yaw: 0 };
    this.musicLevel = 0;
    this._musicTimer = null;
  }

  // ---------------------------------------------------------------- setup

  init() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);
    this._applyVolume();

    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = 0.2;
    this.music.connect(this.master);

    // One second of white noise, reused by every noise-based sound.
    const len = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this._initBoostLoop();
    this._initSaberHum();
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    this._applyVolume();
  }

  setMuted(m) {
    this.muted = m;
    this._applyVolume();
  }

  _applyVolume() {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  setListener(x, z, yaw) {
    this.listener.x = x;
    this.listener.z = z;
    this.listener.yaw = yaw;
  }

  /** Distance attenuation and stereo pan for a world position (null = centred, full volume). */
  _spatial(pos) {
    if (!pos) return { vol: 1, pan: 0 };
    const dx = pos.x - this.listener.x;
    const dz = pos.z - this.listener.z;
    const dist = Math.hypot(dx, dz);
    const vol = 1 / (1 + (dist / 160) * (dist / 160));
    const rx = Math.cos(this.listener.yaw);
    const rz = -Math.sin(this.listener.yaw);
    const pan = dist > 1 ? clamp((dx * rx + dz * rz) / dist, -1, 1) * 0.8 : 0;
    return { vol, pan };
  }

  // ---------------------------------------------------------------- primitives

  _out(pan) {
    const ctx = this.ctx;
    if (!ctx.createStereoPanner) return this.sfx;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.sfx);
    return p;
  }

  /** Oscillator with a pitch glide and an attack/decay envelope. */
  _tone({ type = 'sine', f0, f1 = f0, dur = 0.2, vol = 0.3, attack = 0.005, delay = 0, pan = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this._out(pan));
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** Filtered noise burst with a filter sweep. */
  _noise({ type = 'lowpass', f0 = 1000, f1 = f0, q = 1, dur = 0.3, vol = 0.3, attack = 0.002, delay = 0, pan = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(this._out(pan));
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------- sound effects

  /** Run `fn(volume, pan)` if audio is live, applying positional attenuation. */
  _play(pos, minVol, fn) {
    if (!this.ctx) return;
    const { vol, pan } = this._spatial(pos);
    if (vol < minVol) return;
    fn(vol, pan);
  }

  beam(pos) {
    this._play(pos, 0.04, (v, pan) => {
      this._tone({ type: 'sawtooth', f0: 1500, f1: 180, dur: 0.22, vol: 0.2 * v, pan });
      this._tone({ type: 'square', f0: 700, f1: 90, dur: 0.18, vol: 0.1 * v, pan });
      this._noise({ type: 'highpass', f0: 3000, f1: 800, dur: 0.12, vol: 0.12 * v, pan });
    });
  }

  gun(pos) {
    this._play(pos, 0.05, (v, pan) => {
      this._noise({ type: 'bandpass', f0: 1800, f1: 600, q: 1.2, dur: 0.08, vol: 0.14 * v, pan });
      this._tone({ type: 'square', f0: 240, f1: 90, dur: 0.07, vol: 0.07 * v, pan });
    });
  }

  cannon(pos) {
    this._play(pos, 0.03, (v, pan) => {
      this._tone({ type: 'sawtooth', f0: 240, f1: 40, dur: 0.5, vol: 0.3 * v, pan });
      this._noise({ type: 'lowpass', f0: 2400, f1: 150, dur: 0.45, vol: 0.28 * v, pan });
    });
  }

  missile(pos) {
    this._play(pos, 0.05, (v, pan) => {
      this._noise({ type: 'bandpass', f0: 600, f1: 3500, q: 0.8, dur: 0.45, vol: 0.2 * v, pan });
    });
  }

  explosion(size = 1, pos = null) {
    this._play(pos, 0.02, (v, pan) => {
      const s = clamp(size, 0.3, 3);
      this._noise({ type: 'lowpass', f0: 3000, f1: 80, dur: 0.5 + s * 0.45, vol: Math.min(0.9, 0.45 * s) * v, pan });
      this._tone({ type: 'sine', f0: 130, f1: 28, dur: 0.5 + s * 0.35, vol: Math.min(0.9, 0.5 * s) * v, pan });
    });
  }

  hit(pos) {
    this._play(pos, 0.05, (v, pan) => {
      this._noise({ type: 'bandpass', f0: 2400, f1: 900, q: 2, dur: 0.07, vol: 0.18 * v, pan });
      this._tone({ type: 'triangle', f0: 520, f1: 200, dur: 0.08, vol: 0.12 * v, pan });
    });
  }

  /** Player took a hit: lower and heavier than an enemy hit. */
  playerHit() {
    if (!this.ctx) return;
    this._noise({ type: 'lowpass', f0: 1600, f1: 120, dur: 0.3, vol: 0.4 });
    this._tone({ type: 'square', f0: 160, f1: 50, dur: 0.25, vol: 0.2 });
  }

  slash(pos) {
    this._play(pos, 0.05, (v, pan) => {
      this._noise({ type: 'bandpass', f0: 500, f1: 4200, q: 1.5, dur: 0.22, vol: 0.28 * v, pan });
      this._tone({ type: 'sawtooth', f0: 320, f1: 900, dur: 0.18, vol: 0.1 * v, pan });
    });
  }

  saberHit(pos) {
    this._play(pos, 0.05, (v, pan) => {
      this._tone({ type: 'sawtooth', f0: 900, f1: 120, dur: 0.25, vol: 0.25 * v, pan });
      this._noise({ type: 'highpass', f0: 2000, f1: 600, dur: 0.2, vol: 0.25 * v, pan });
    });
  }

  dash(pos) {
    this._play(pos, 0.05, (v, pan) => {
      this._noise({ type: 'bandpass', f0: 300, f1: 2500, q: 0.7, dur: 0.35, vol: 0.28 * v, pan });
    });
  }

  reload() {
    if (!this.ctx) return;
    this._tone({ type: 'square', f0: 220, f1: 330, dur: 0.06, vol: 0.08 });
    this._tone({ type: 'square', f0: 440, f1: 660, dur: 0.08, vol: 0.08, delay: 0.09 });
  }

  /** Decoy flares popping. */
  flare() {
    if (!this.ctx) return;
    this._noise({ type: 'highpass', f0: 1500, f1: 5000, dur: 0.5, vol: 0.22 });
    this._tone({ type: 'square', f0: 1200, f1: 600, dur: 0.25, vol: 0.08 });
  }

  /** Repair kit starting: a short rising chime. */
  repair() {
    if (!this.ctx) return;
    [523, 659, 880].forEach((f, i) => this._tone({ type: 'triangle', f0: f, dur: 0.22, vol: 0.12, delay: i * 0.08 }));
  }

  lockOn() {
    if (!this.ctx) return;
    this._tone({ type: 'sine', f0: 1200, dur: 0.07, vol: 0.12 });
    this._tone({ type: 'sine', f0: 1800, dur: 0.1, vol: 0.12, delay: 0.07 });
  }

  lockOff() {
    if (!this.ctx) return;
    this._tone({ type: 'sine', f0: 900, f1: 500, dur: 0.12, vol: 0.1 });
  }

  alert() {
    if (!this.ctx) return;
    this._tone({ type: 'square', f0: 880, dur: 0.09, vol: 0.09 });
    this._tone({ type: 'square', f0: 880, dur: 0.09, vol: 0.09, delay: 0.14 });
  }

  burst() {
    if (!this.ctx) return;
    this._tone({ type: 'sawtooth', f0: 110, f1: 880, dur: 0.9, vol: 0.25, attack: 0.1 });
    this._noise({ type: 'bandpass', f0: 200, f1: 5000, q: 0.6, dur: 0.9, vol: 0.3 });
  }

  ui(kind = 'click') {
    if (!this.ctx) return;
    if (kind === 'click') this._tone({ type: 'square', f0: 660, f1: 880, dur: 0.07, vol: 0.08 });
    else if (kind === 'wave') {
      this._tone({ type: 'sawtooth', f0: 220, f1: 220, dur: 0.5, vol: 0.12, attack: 0.05 });
      this._tone({ type: 'sawtooth', f0: 330, f1: 330, dur: 0.5, vol: 0.1, attack: 0.05, delay: 0.12 });
      this._tone({ type: 'sawtooth', f0: 440, f1: 440, dur: 0.7, vol: 0.1, attack: 0.05, delay: 0.24 });
    } else if (kind === 'clear') {
      [523, 659, 784, 1047].forEach((f, i) => this._tone({ type: 'triangle', f0: f, dur: 0.3, vol: 0.14, delay: i * 0.09 }));
    } else if (kind === 'fail') {
      [330, 262, 196, 130].forEach((f, i) => this._tone({ type: 'sawtooth', f0: f, dur: 0.5, vol: 0.14, delay: i * 0.2 }));
    }
  }

  // ---------------------------------------------------------------- continuous loops

  _initBoostLoop() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    this._boostFilter = ctx.createBiquadFilter();
    this._boostFilter.type = 'bandpass';
    this._boostFilter.frequency.value = 500;
    this._boostFilter.Q.value = 0.6;
    this._boostGain = ctx.createGain();
    this._boostGain.gain.value = 0;
    src.connect(this._boostFilter).connect(this._boostGain).connect(this.sfx);
    src.start();
  }

  /** level 0..1 — how hard the thrusters are firing. */
  setBoost(level) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._boostGain.gain.setTargetAtTime(level * 0.16, t, 0.08);
    this._boostFilter.frequency.setTargetAtTime(380 + level * 700, t, 0.1);
  }

  _initSaberHum() {
    const ctx = this.ctx;
    this._humGain = ctx.createGain();
    this._humGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    for (const f of [96, 98.5, 192]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start();
    }
    lp.connect(this._humGain).connect(this.sfx);
  }

  setSaber(on) {
    if (!this.ctx) return;
    this._humGain.gain.setTargetAtTime(on ? 0.07 : 0, this.ctx.currentTime, 0.05);
  }

  // ---------------------------------------------------------------- music

  /** A looping A-minor synth track. `level` (0..1) adds layers as the fight heats up. */
  startMusic() {
    if (!this.ctx || this._musicTimer) return;
    this._step = 0;
    this._nextTime = this.ctx.currentTime + 0.1;
    this._musicTimer = setInterval(() => this._scheduleMusic(), 40);
  }

  stopMusic() {
    clearInterval(this._musicTimer);
    this._musicTimer = null;
  }

  setMusicLevel(level) {
    this.musicLevel = level;
  }

  _scheduleMusic() {
    const ctx = this.ctx;
    const stepDur = 60 / 108 / 4; // 16th notes at 108 BPM
    while (this._nextTime < ctx.currentTime + 0.2) {
      this._musicStep(this._step, this._nextTime, stepDur);
      this._nextTime += stepDur;
      this._step = (this._step + 1) % 128; // 8 bars
    }
  }

  _musicStep(step, t, dur) {
    const bar = Math.floor(step / 16) % 4;
    const s = step % 16;
    const roots = [45, 41, 48, 43]; // A2 F2 C3 G2
    const root = roots[bar];
    const lvl = this.musicLevel;

    // Driving bass on off-beat 16ths.
    if ([0, 3, 6, 8, 11, 14].includes(s)) this._musicNote('sawtooth', NOTE(root - 12), t, dur * 1.6, 0.5, 380);
    // Kick on the quarter notes, snare-ish noise on 2 and 4.
    if (s % 4 === 0) this._musicKick(t);
    if (s === 4 || s === 12) this._musicNoise(t, 0.14, 1800, 0.35);
    if (lvl > 0.3 && s % 2 === 0) this._musicNoise(t, 0.04, 7000, 0.18);
    // Pad chord at the start of each bar.
    if (s === 0) {
      for (const iv of [0, 7, 12, bar === 0 || bar === 3 ? 15 : 16]) this._musicNote('sawtooth', NOTE(root + 12 + iv), t, dur * 15, 0.12, 900, 0.3);
    }
    // Arpeggio once the action picks up.
    if (lvl > 0.6 && s % 2 === 1) {
      const arp = [0, 7, 12, 15, 19, 15, 12, 7];
      this._musicNote('square', NOTE(root + 24 + arp[(s >> 1) % 8]), t, dur * 1.2, 0.16, 2400);
    }
  }

  _musicNote(type, freq, t, dur, vol, cutoff, attack = 0.005) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.25), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.music);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  _musicKick(t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.14);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(this.music);
    o.start(t);
    o.stop(t + 0.2);
  }

  _musicNoise(t, dur, freq, vol) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.music);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }
}
