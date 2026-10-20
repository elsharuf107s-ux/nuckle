// Game: owns the renderer, scene and all systems, runs the fixed-timestep loop, and handles
// the rules — damage, kills, scoring, win and lose.

import * as THREE from 'three';
import { AudioEngine } from './audio.js';
import { CameraRig } from './camera.js';
import { Fx } from './fx.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { Missions } from './missions.js';
import { Player } from './player.js';
import { Projectiles } from './weapons.js';
import { World } from './world.js';
import { clamp, fmtTime } from './util.js';

const STEP = 1 / 60;
const ZERO = new THREE.Vector3();

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.settings = { shadows: true, scale: 1 }; // graphics options, see applySettings()
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(66, 1, 0.5, 7000);
    this.rig = new CameraRig(this.camera);

    this.state = 'title'; // title | garage | playing | paused | ended
    this.garageCam = { yaw: Math.PI * 0.82, pitch: 0.16, dist: 54, dragging: false };
    this.garagePose = 'idle'; // idle | saber | boost (preview only)
    this.time = 0;
    this.acc = 0;
    this.timeScale = 1;
    this.hitstopT = 0;
    this.slowmoT = 0;
    this.endTimer = 0;
    this.cheat = { invincible: false };
    this.manual = false;
    this.enemies = [];
    this.stats = this._freshStats();
    this.combo = { count: 0, t: 0 };
    this.onEnd = null; // set by main.js: (result) => void, called once the end-of-mission delay has passed
    this._endShown = false;

    this.input = new Input();
    this.input.attach();
    this.audio = new AudioEngine();
    this.world = new World(this.scene, this.renderer);
    this.fx = new Fx(this);
    this.projectiles = new Projectiles(this);
    this.hud = new Hud(this);
    this.player = new Player(this);
    this.missions = new Missions(this);
    this._mechs = [];

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.player.reset(0, 0);
    this.player.mech.update(STEP, {});
    this.last = performance.now();
  }

  _freshStats() {
    return { score: 0, kills: 0, time: 0, damageTaken: 0, damageDealt: 0 };
  }

  /** Apply graphics options: { shadows: bool, scale: render-resolution multiplier }. */
  applySettings(opts = {}) {
    Object.assign(this.settings, opts);
    const { shadows, scale } = this.settings;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75) * scale);
    this.renderer.shadowMap.enabled = shadows;
    this.world.sun.castShadow = shadows;
    this.scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) m.needsUpdate = true; // shader variants differ with and without shadows
    });
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ lifecycle

  startMission() {
    for (const e of this.enemies) e.mech.destroy();
    this.enemies.length = 0;
    this.projectiles.clear();
    this.fx.clear();
    this.hud.reset();
    this.stats = this._freshStats();
    this.combo = { count: 0, t: 0 };
    this.player.reset(0, 0);
    this.hud.configure();
    this.rig.reset(0);
    this.timeScale = 1;
    this.hitstopT = this.slowmoT = this.endTimer = 0;
    this._endShown = false;
    this.acc = 0;
    this.input.clear();
    this.input.enabled = true;
    this.state = 'playing';
    this.hud.show(true);
    this.audio.init();
    this.audio.startMusic();
    this.audio.setMusicLevel(0.2);
    this.missions.start();
  }

  /** Abandon the sortie and return to the title flyaround. */
  toTitle() {
    for (const e of this.enemies) e.mech.destroy();
    this.enemies.length = 0;
    this.projectiles.clear();
    this.fx.clear();
    this.hud.reset();
    this.hud.show(false);
    this.player.reset(0, 0);
    this.input.enabled = false;
    this.input.clear();
    this.timeScale = 1;
    this.hitstopT = this.slowmoT = 0;
    this.audio.setBoost(0);
    this.audio.setSaber(false);
    this.audio.stopMusic();
    this.missions.reset();
    this.state = 'title';
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.enabled = false;
    this.input.clear();
    this.audio.setBoost(0);
    this.audio.setSaber(false);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.input.enabled = true;
    this.last = performance.now();
  }

  endMission(victory) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.victory = victory;
    this.endTimer = victory ? 2.4 : 2.6;
    this.input.enabled = false;
    this.input.clear();
    this.audio.setBoost(0);
    this.audio.setSaber(false);
    this.audio.setMusicLevel(0);
    if (victory) {
      this.hud.message('MISSION COMPLETE', 'good');
      this.audio.ui('clear');
    } else {
      this.hud.message('MECH DESTROYED', 'bad');
      this.audio.ui('fail');
    }
  }

  _result() {
    const s = this.stats;
    const hpLeft = this.player.mech.hp;
    const timeBonus = Math.max(0, Math.round((600 - s.time) * 4));
    const armorBonus = Math.round(hpLeft * 0.8);
    const total = this.victory ? s.score + timeBonus + armorBonus : s.score;
    let rank = 'C';
    if (total >= 16000) rank = 'S';
    else if (total >= 13500) rank = 'A';
    else if (total >= 11000) rank = 'B';
    return {
      victory: this.victory,
      rank: this.victory ? rank : null,
      rows: [
        ['Hostiles destroyed', String(s.kills)],
        ['Mission time', fmtTime(s.time)],
        ['Damage dealt', Math.round(s.damageDealt).toLocaleString('en-US')],
        ['Damage taken', Math.round(s.damageTaken).toLocaleString('en-US')],
        ['Combat score', s.score.toLocaleString('en-US')],
        ...(this.victory ? [['Time bonus', timeBonus.toLocaleString('en-US')], ['Armor bonus', armorBonus.toLocaleString('en-US')]] : []),
        ['Total', total.toLocaleString('en-US')],
      ],
    };
  }

  // ------------------------------------------------------------------ loop

  start() {
    const frame = (now) => {
      const real = Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      this.advance(real);
      this.render();
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  /** Advance by real elapsed seconds using fixed simulation steps. */
  advance(real) {
    if (this.state === 'paused' || this.manual) return; // `manual`: tests drive step() themselves
    if (this.hitstopT > 0) this.hitstopT -= real;
    if (this.slowmoT > 0) this.slowmoT -= real;
    const scale = this.hitstopT > 0 ? 0.05 : this.slowmoT > 0 ? 0.3 : 1;
    this.acc += real * scale;
    let steps = 0;
    while (this.acc >= STEP && steps < 5) {
      this.update(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps === 5) this.acc = 0;
  }

  /** Run n fixed steps directly (used by the automated tests). */
  step(n = 1) {
    for (let i = 0; i < n; i++) this.update(STEP);
  }

  render() {
    this.fx.setView(this.renderer.domElement.height, this.camera.fov);
    this.renderer.render(this.scene, this.camera);
  }

  update(dt) {
    this.time += dt;
    const player = this.player;
    this._mechs.length = 0;
    this._mechs.push(player.mech);
    for (const e of this.enemies) this._mechs.push(e.mech);

    if (this.state === 'title' || this.state === 'garage') {
      this._updateShowroom(dt);
      this.world.update(dt, player.mech.pos, this.camera.position);
      this.fx.update(dt);
      this.input.endStep();
      return;
    }

    if (this.state === 'playing') {
      this.stats.time += dt;
      if (this.input.pressed('KeyM')) this.audio.setMuted(!this.audio.muted);
      const look = this.input.consumeLook();
      if (!player.lock) this.rig.look(look.dx, look.dy);
      player.update(dt, this.input);
    } else if (this.state === 'ended') {
      this.endTimer -= dt;
      if (this.endTimer <= 0 && !this._endShown) {
        this._endShown = true;
        this.onEnd?.(this._result());
      }
      if (!player.mech.dead) player.mech.update(dt, {});
    }

    for (const e of this.enemies) e.update(dt);
    this._separate();
    this.projectiles.update(dt);
    if (this.state === 'playing') this.missions.update(dt);
    this.fx.update(dt);

    if (this.combo.count > 0) {
      this.combo.t -= dt;
      if (this.combo.t <= 0) this.combo.count = 0;
    }

    this.rig.update(dt, player, this.world);
    this.world.update(dt, player.mech.pos, this.camera.position);
    this.audio.setListener(player.mech.pos.x, player.mech.pos.z, this.rig.yaw);
    this.hud.update(dt);
    this.input.endStep();
  }

  // ------------------------------------------------------------------ garage / showroom

  /** Swap in a garage build (replaces the player's mech, stats and loadout). */
  setBuild(build) {
    this.player.applyBuild(build);
    this.player.mech.update(STEP, {});
    this.hud.configure();
  }

  enterGarage() {
    this.state = 'garage';
    this.input.enabled = false;
    this.world.setGarage(true);
    this.garagePose = 'idle';
    this.player.mech.place(0, 0, 0, 0);
    this.garageCam.dragging = false;
  }

  exitGarage() {
    this.state = 'title';
    this.world.setGarage(false);
    this.garagePose = 'idle';
    this.player.mech.setSaber(false);
    this.player.mech.place(0, 0, 0, 0);
  }

  garageLook(dx, dy) {
    const c = this.garageCam;
    c.yaw -= dx * 0.008;
    c.pitch = clamp(c.pitch + dy * 0.006, -0.15, 0.75);
  }

  garageZoom(delta) {
    const c = this.garageCam;
    c.dist = clamp(c.dist + delta * 0.04, 30, 95);
  }

  /** Idle flyaround on the title; a draggable turntable with preview poses in the garage. */
  _updateShowroom(dt) {
    const mech = this.player.mech;
    const c = mech.pos;
    const cam = this.camera;
    const garage = this.state === 'garage';
    const fov = garage ? 42 : 66;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    if (!garage) {
      mech.update(dt, {});
      const a = this.time * 0.15;
      const cx = Math.cos(a), cz = Math.sin(a);
      cam.position.set(c.x + cx * 62, 16, c.z + cz * 62);
      // aim left of the mech so it sits on the right of the frame, clear of the title text
      cam.lookAt(c.x - cz * 26, 11, c.z + cx * 26);
    } else {
      const g = this.garageCam;
      if (!g.dragging) g.yaw += dt * 0.3;
      this._garagePose(dt);
      const cp = Math.cos(g.pitch);
      cam.position.set(c.x + Math.sin(g.yaw) * cp * g.dist, 10 + Math.sin(g.pitch) * g.dist, c.z + Math.cos(g.yaw) * cp * g.dist);
      cam.lookAt(c.x, c.y + 10, c.z);
    }
    cam.updateMatrixWorld(true);
  }

  _garagePose(dt) {
    const m = this.player.mech;
    if (this.garagePose === 'saber') {
      if (!m.saberOut) m.setSaber(true);
      const kinds = ['slash1', 'slash2', 'slash3'];
      const period = 1.7;
      m.pos.y = 0;
      m.update(dt, { attack: { kind: kinds[Math.floor(this.time / period) % 3], t: (this.time % period) / period } });
      return;
    }
    if (m.saberOut) m.setSaber(false);
    if (this.garagePose === 'boost') {
      m.pos.y = 7; // hover with the thrusters lit
      m.update(dt, { velocity: ZERO });
      return;
    }
    m.pos.y = 0;
    m.update(dt, {});
  }

  /** Mechs are solid: push overlapping bodies apart. */
  _separate() {
    const list = [this.player.mech, ...this.enemies.map((e) => e.mech)];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.dead) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.dead) continue;
        const dy = a.pos.y - b.pos.y;
        if (dy > b.height * 0.8 || -dy > a.height * 0.8) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const min = (a.radius + b.radius) * 0.9;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 0.001;
        const push = (min - d) * 0.5;
        const nx = d > 0.002 ? dx / d : 1, nz = d > 0.002 ? dz / d : 0;
        a.pos.x -= nx * push; a.pos.z -= nz * push;
        b.pos.x += nx * push; b.pos.z += nz * push;
      }
    }
  }

  allMechs() {
    return this._mechs;
  }

  // ------------------------------------------------------------------ effects hooks

  shake(amount) {
    this.rig.addTrauma(amount);
  }

  shakeFrom(pos, amount, range) {
    const d = pos.distanceTo(this.player.mech.pos);
    this.rig.addTrauma(amount * clamp(1 - d / range, 0, 1));
  }

  hitstop(seconds) {
    this.hitstopT = Math.max(this.hitstopT, seconds);
  }

  // ------------------------------------------------------------------ rules

  onDamaged(mech, amount, info) {
    if (mech.team === 'enemy') {
      this.stats.damageDealt += amount;
      const p = this.player;
      if (!p.burstActive) p.burst = Math.min(100, p.burst + amount * 0.035 * p.stats.burstGain);
      this.hud.damageNumber(info.point ?? mech.center(), amount, info.kind === 'saber' ? 'saber' : 'enemy');
      this.hud.enemyHit();
    } else {
      this.stats.damageTaken += amount;
      this.hud.playerHit(amount);
      this.audio.playerHit();
      this.shake(clamp(amount / 350, 0.15, 0.9));
    }
  }

  onDestroyed(mech) {
    const center = mech.center();
    if (mech.team === 'enemy') {
      const boss = !!mech.def.boss;
      const i = this.enemies.indexOf(mech.enemy);
      if (i >= 0) this.enemies.splice(i, 1);
      mech.setSaber(false);
      mech.destroy();

      this.combo.count++;
      this.combo.t = 5;
      const mult = 1 + 0.25 * Math.min(this.combo.count - 1, 4);
      this.stats.score += Math.round(mech.def.score * mult);
      this.stats.kills++;
      const p = this.player;
      if (!p.burstActive) p.burst = Math.min(100, p.burst + 8);

      const r = (boss ? 62 : 32) * mech.spec.scale;
      this.fx.explosion(center, r, { shake: boss ? 1.4 : 1 });
      this.fx.debrisBurst(center, mech.spec.palette, mech.spec.scale);
      if (boss) {
        this.fx.explosion(center.clone().add(new THREE.Vector3(8, 6, -4)), r * 0.7, { sound: false });
        this.slowmoT = 1.6;
        this.hitstopT = 0.15;
        this.hud.message('BARON DESTROYED', 'good');
      }
      if (mech.def.boss && this.missions.index === 4) this.audio.setMusicLevel(0.3);
    } else {
      this.fx.explosion(center, 40, { shake: 1.2 });
      this.fx.debrisBurst(center, mech.spec.palette, mech.spec.scale);
      mech.setSaber(false);
      mech.destroy();
      this.slowmoT = 1.2;
      this.endMission(false);
    }
  }
}
