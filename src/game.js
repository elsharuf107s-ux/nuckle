// Game: owns the renderer, scene and all systems, runs the fixed-timestep loop, and handles
// the rules — damage, kills, scoring, win and lose.

import * as THREE from 'three';
import { AudioEngine } from './audio.js';
import { CameraRig } from './camera.js';
import { Destruction } from './destruction.js';
import { Fx } from './fx.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { Missions } from './missions.js';
import { Player } from './player.js';
import { Projectiles } from './weapons.js';
import { World } from './world.js';
import { clamp, damp, dampAngle, fmtTime, lerp, rand } from './util.js';

const STEP = 1 / 60;
const ease = (t) => t * t * (3 - 2 * t);
const ZERO = new THREE.Vector3();
// the catapult launch that opens a sortie: crouched on the shuttle, thrown down the deck, airborne
const LAUNCH_STANDBY = 1.05; // the lights count down
const LAUNCH_RUN = 0.5;      // the shuttle runs the length of the deck
const LAUNCH_BLEND = 0.7;    // the camera hands back to the chase view
// a destroyed machine sparks and convulses this long before it blows
const WRECK_TIME = 1.15;
const WRECK_TIME_BOSS = 2.3;
// Where the garage camera goes when a hardpoint is picked: the height it looks at, its distance, and the
// side it looks from (yaw PI is straight in front of the mech; a larger yaw is the mech's left).
const GARAGE_FOCUS = {
  all:       { y: 10, dist: 54, yaw: null },
  head:      { y: 17.8, dist: 27, yaw: Math.PI + 0.3 },
  chest:     { y: 13.2, dist: 35, yaw: Math.PI },
  arms:      { y: 10.5, dist: 38, yaw: Math.PI - 0.6 },
  legs:      { y: 5.5, dist: 42, yaw: Math.PI + 0.25 },
  shoulderL: { y: 15, dist: 31, yaw: Math.PI + 0.85 },
  shoulderR: { y: 15, dist: 31, yaw: Math.PI - 0.85 },
  back:      { y: 12.5, dist: 40, yaw: 0.25 },
  waist:     { y: 9.5, dist: 34, yaw: Math.PI },
  handR:     { y: 9, dist: 38, yaw: Math.PI - 1.0 },
  handL:     { y: 9, dist: 38, yaw: Math.PI + 1.0 },
  hips:      { y: 9.5, dist: 36, yaw: Math.PI - 0.7 },
  // the sockets for more parts (left is the mech's left; yaw 0 looks at its back)
  armLowerL: { y: 8.5, dist: 32, yaw: Math.PI + 0.9 },
  armLowerR: { y: 8.5, dist: 32, yaw: Math.PI - 0.9 },
  armUpperL: { y: 14.5, dist: 32, yaw: -0.7 },
  armUpperR: { y: 14.5, dist: 32, yaw: 0.7 },
  headL:     { y: 18, dist: 26, yaw: Math.PI + 0.7 },
  headR:     { y: 18, dist: 26, yaw: Math.PI - 0.7 },
  tail:      { y: 8, dist: 44, yaw: 0.35 },
  podL:      { y: 11.5, dist: 34, yaw: -0.65 },
  podR:      { y: 11.5, dist: 34, yaw: 0.65 },
};

// the garage's saber preview: the player's combo (see player.js) and a pause in guard
const GARAGE_COMBO = [['slash1', 0.46], ['slash2', 0.46], ['thrust', 0.48], ['slash3', 0.72], [null, 1.1]];
const GARAGE_COMBO_LENGTH = GARAGE_COMBO.reduce((n, [, d]) => n + d, 0);

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.settings = { shadows: true, scale: 1, aimAssist: true, pitStops: true }; // graphics (see applySettings), touch aim assist, pit stops between waves
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(66, 1, 0.5, 7000);
    this.rig = new CameraRig(this.camera);

    this.state = 'title'; // title | garage | playing | paused | intermission (the pit stop between waves) | ended
    // yaw/pitch/dist orbit the mech; lookY is the height looked at; `goal` (see garageFocus) eases the view toward a hardpoint
    this.garageCam = { yaw: Math.PI * 0.82, pitch: 0.16, dist: 54, lookY: 10, dragging: false, spin: true, goal: null };
    this.garagePose = 'idle'; // idle | saber | boost (preview only)
    this._pops = [];          // parts just bolted on in the garage, growing into place: { node, t }
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
    this.onIntermission = null; // set by main.js: (info) => void, called when the pit stop begins
    this.pit = null;           // where the mech was standing when it went into the pit
    this._endShown = false;
    this.wrecks = [];          // destroyed machines breaking down before they explode: { mech, t, dur, spark }
    this.launchIntro = true;   // open each sortie with the catapult launch (the tests turn it off)
    this.launch = null;        // the launch in progress: { t, released }

    this.input = new Input();
    this.input.attach();
    this.audio = new AudioEngine();
    this.world = new World(this.scene, this.renderer);
    this.fx = new Fx(this);
    this.destruction = new Destruction(this);
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
    return { score: 0, kills: 0, time: 0, damageTaken: 0, damageDealt: 0, collapses: 0, leveled: 0 };
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
    this._clearWrecks();
    this.projectiles.clear();
    this.fx.clear();
    this.destruction.reset(); // a new sortie: the whole city is standing again
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
    this.launch = null;
    this.rig.cine = null;
    this.world.showCatapult(false);
    if (this.launchIntro) this._beginLaunch();
    this.missions.start(this.launch ? 0.9 : 0);
  }

  /** Abandon the sortie and return to the title flyaround. */
  toTitle() {
    for (const e of this.enemies) e.mech.destroy();
    this.enemies.length = 0;
    this._clearWrecks();
    this.launch = null;
    this.rig.cine = null;
    this.world.showCatapult(false);
    this.projectiles.clear();
    this.fx.clear();
    this.destruction.reset();
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
        ...(s.collapses > 0 ? [['Structures brought down', `${s.collapses}${s.leveled ? ` (${s.leveled} flattened)` : ''}`]] : []),
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
    this.touch?.update();
    if (this.inGarage) this.onGarageFrame?.(); // the garage keeps its hardpoint markers on the mech
    this.fx.setView(this.renderer.domElement.height, this.camera.fov);
    this.renderer.render(this.scene, this.camera);
  }

  update(dt) {
    this.time += dt;
    const player = this.player;
    this._mechs.length = 0;
    this._mechs.push(player.mech);
    for (const e of this.enemies) this._mechs.push(e.mech);

    if (this.state === 'title' || this.inGarage) {
      this._updateShowroom(dt);
      this.world.update(dt, player.mech.pos, this.camera.position);
      this.fx.update(dt);
      this.destruction.update(dt);
      this.input.endStep();
      return;
    }

    if (this.state === 'playing') {
      this.stats.time += dt;
      if (this.input.pressed('KeyM')) this.audio.setMuted(!this.audio.muted);
      const look = this.input.consumeLook();
      if (this.launch && !this.launch.released) this._updateLaunch(dt); // the pilot takes over once the shuttle lets go
      else {
        if (!player.lock) this.rig.look(look.dx, look.dy);
        player.update(dt, this.input);
        if (this.launch) this._updateLaunch(dt);
      }
    } else if (this.state === 'ended') {
      this.endTimer -= dt;
      if (this.endTimer <= 0 && !this._endShown) {
        this._endShown = true;
        this.onEnd?.(this._result());
      }
      if (!player.mech.dead) player.mech.update(dt, {});
    }

    for (const e of this.enemies) e.update(dt);
    this._updateWrecks(dt);
    this._separate();
    this.projectiles.update(dt);
    if (this.state === 'playing') this.missions.update(dt);
    this.fx.update(dt);
    this.destruction.update(dt);

    if (this.combo.count > 0) {
      this.combo.t -= dt;
      if (this.combo.t <= 0) this.combo.count = 0;
    }

    this.rig.update(dt, player, this.world);
    this.world.update(dt, player.mech.pos, this.camera.position);
    this.audio.setListener(player.mech.pos.x, player.mech.pos.z, this.rig.yaw);
    if (this.state !== 'intermission') this.hud.update(dt); // the pit stop began this step: the HUD is already hidden
    this.input.endStep();
  }

  // ------------------------------------------------------------------ garage / showroom

  /** The garage screen is up: from the title or results screens, or in the pit stop between waves. */
  get inGarage() {
    return this.state === 'garage' || this.state === 'intermission';
  }

  /**
   * Swap in a garage build (replaces the player's mech, stats and loadout). In the pit stop the new
   * machine inherits the old one's share of armor, so swapping parts is not a free repair.
   */
  setBuild(build) {
    const old = this.player.mech;
    const share = this.state === 'intermission' ? old.hp / old.maxHp : null;
    this.player.applyBuild(build);
    if (share !== null) this.player.mech.hp = Math.max(1, this.player.mech.maxHp * share);
    this.player.mech.update(STEP, {});
    this.hud.configure();
  }

  // ------------------------------------------------------------------ pit stop

  /** What the pit-stop screen shows: the wave just cleared, the next one, and the state of the machine. */
  pitInfo() {
    const m = this.player.mech;
    return {
      ...this.missions.pitInfo(),
      armor: Math.round((m.hp / m.maxHp) * 100),
      score: this.stats.score,
      kills: this.stats.kills,
    };
  }

  /** Between waves: drop into the garage. Armor and position are kept; ammo is restocked by any build change. */
  enterIntermission() {
    if (this.state !== 'playing') return;
    const p = this.player, m = p.mech;
    this.pit = { x: m.pos.x, z: m.pos.z, yaw: m.yaw };
    for (const e of this.enemies) e.mech.destroy();
    this.enemies.length = 0;
    this._clearWrecks();
    this.projectiles.clear();
    this.fx.clear();
    this.state = 'intermission';
    this.input.enabled = false;
    this.input.clear();
    this.audio.setBoost(0);
    this.audio.setSaber(false);
    this.audio.setMusicLevel(0.12);
    this.hud.show(false);
    this.world.setGarage(true);
    this.garagePose = 'idle';
    Object.assign(this.garageCam, { dragging: false, goal: null, spin: true, lookY: 10, dist: 54 });
    p.lock = null;
    p.melee = null;
    p.fieldT = 0;
    m.setSaber(false);
    m.tintColor = null;
    m.place(0, 0, 0, 0);
    this.onIntermission?.(this.pitInfo());
  }

  /** Back out of the pit: the mech returns to where it stood and the next wave begins. */
  leaveIntermission() {
    if (this.state !== 'intermission') return;
    const p = this.player, m = p.mech, pit = this.pit;
    this.world.setGarage(false);
    m.setSaber(false);
    m.place(pit.x, pit.z, 0, pit.yaw);
    this.garagePose = 'idle';
    this.rig.reset(pit.yaw);
    p.lock = null;
    p.lockEnabled = true;
    p.resupply(0); // a full loadout whatever was fitted
    this.pit = null;
    this.input.clear();
    this.input.enabled = true;
    this.state = 'playing';
    this.hud.show(true);
    this.hud.configure();
    this.audio.setMusicLevel(0.3);
    this.acc = 0;
    this.last = performance.now();
    this.missions.resume();
  }

  enterGarage() {
    this.state = 'garage';
    this.input.enabled = false;
    this.world.setGarage(true);
    this.garagePose = 'idle';
    this.player.mech.place(0, 0, 0, 0);
    this.garageCam.dragging = false;
    this.garageCam.goal = null;
    this.garageCam.spin = true;
    this.garageCam.lookY = 10;
    this.garageCam.dist = 54;
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
    c.goal = null; // the player has taken over the camera
    c.yaw -= dx * 0.008;
    c.pitch = clamp(c.pitch + dy * 0.006, -0.15, 0.75);
  }

  garageZoom(delta) {
    const c = this.garageCam;
    c.goal = null;
    c.dist = clamp(c.dist + delta * 0.04, 18, 95);
  }

  /** Swing the garage camera toward a hardpoint (a key of GARAGE_FOCUS; 'all' returns to the whole mech and the slow spin). */
  garageFocus(id) {
    const f = GARAGE_FOCUS[id] ?? GARAGE_FOCUS.all;
    const c = this.garageCam;
    c.goal = f;
    c.spin = id === 'all';
  }

  /** A part was bolted on in the garage: sparks, a flash and a clank at its socket. */
  garageWeld(hardpoint) {
    const p = this.player.mech.model.anchorWorld(hardpoint, new THREE.Vector3());
    this.fx.sparks(p, null, 22, [1, 0.85, 0.5]);
    this.fx.glow.spawn(p.x, p.y, p.z, 0, 0, 0, 0.18, 7, 2, [1, 1, 1], [1, 0.8, 0.4], 0.9);
    this.audio.weld();
    const node = this.player.mech.model.partNode(hardpoint);
    if (node) {
      node.scale.setScalar(0.05);
      this._pops.push({ node, t: 0 });
    }
  }

  /** Idle flyaround on the title; a draggable turntable with preview poses in the garage. */
  _updateShowroom(dt) {
    const mech = this.player.mech;
    const c = mech.pos;
    const cam = this.camera;
    const garage = this.inGarage;
    for (let i = this._pops.length - 1; i >= 0; i--) { // a part just welded on grows into place, overshooting a little
      const p = this._pops[i];
      p.t = Math.min(1, p.t + dt / 0.32);
      const x = p.t - 1;
      p.node.scale.setScalar(p.t >= 1 ? 1 : Math.max(0.05, 1 + 2.7 * x * x * x + 1.7 * x * x));
      if (p.t >= 1) this._pops.splice(i, 1);
    }
    const fov = garage ? 42 : 66;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    if (!garage) {
      mech.update(dt, { relaxed: true });
      const a = this.time * 0.15;
      const cx = Math.cos(a), cz = Math.sin(a);
      cam.position.set(c.x + cx * 62, 16, c.z + cz * 62);
      // aim left of the mech so it sits on the right of the frame, clear of the title text
      cam.lookAt(c.x - cz * 26, 11, c.z + cx * 26);
    } else {
      const g = this.garageCam;
      if (g.dragging) g.goal = null;
      if (g.goal) {
        g.lookY = damp(g.lookY, g.goal.y, 6, dt);
        g.dist = damp(g.dist, g.goal.dist, 5, dt);
        if (g.goal.yaw !== null) g.yaw = dampAngle(g.yaw, g.goal.yaw, 5, dt);
      } else if (!g.dragging && g.spin) {
        g.yaw += dt * 0.3;
      }
      this._garagePose(dt);
      const cp = Math.cos(g.pitch);
      cam.position.set(c.x + Math.sin(g.yaw) * cp * g.dist, g.lookY + Math.sin(g.pitch) * g.dist, c.z + Math.cos(g.yaw) * cp * g.dist);
      cam.lookAt(c.x, c.y + g.lookY, c.z);
    }
    cam.updateMatrixWorld(true);
  }

  _garagePose(dt) {
    const m = this.player.mech;
    if (this.garagePose === 'saber') {
      // the real four-hit combo at its real speed, arcs and all, then a moment in guard before it repeats
      if (!m.saberOut) m.setSaber(true);
      m.pos.y = 0;
      let t = this.time % GARAGE_COMBO_LENGTH;
      const cycle = Math.floor(this.time / GARAGE_COMBO_LENGTH);
      let attack = null;
      for (const [kind, dur] of GARAGE_COMBO) {
        if (t < dur) {
          if (kind) attack = { kind, t: t / dur };
          break;
        }
        t -= dur;
      }
      if (attack && attack.t >= 0.28 && this._garageArc !== `${cycle}${attack.kind}`) {
        this._garageArc = `${cycle}${attack.kind}`;
        this.fx.slashArc(m, attack.kind, m.spec.palette.blade);
      }
      m.update(dt, { attack, hover: true });
      return;
    }
    if (m.saberOut) m.setSaber(false);
    if (this.garagePose === 'boost') {
      m.pos.y = 7; // hover with the thrusters lit
      m.update(dt, { velocity: ZERO, relaxed: true });
      return;
    }
    m.pos.y = 0;
    m.update(dt, { relaxed: true });
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

  /**
   * A beat of slow motion and a camera punch: 'kill' (any kill), 'lastKill' (the wave's last enemy) or
   * 'finisher' (a saber combo's last blow landing).
   */
  cinematic(kind) {
    if (kind === 'lastKill') { this.slowmoT = Math.max(this.slowmoT, 0.85); this.rig.punch(1); }
    else if (kind === 'finisher') { this.slowmoT = Math.max(this.slowmoT, 0.22); this.rig.punch(0.8); }
    else { this.slowmoT = Math.max(this.slowmoT, 0.16); this.rig.punch(0.45); }
  }

  // ------------------------------------------------------------------ the catapult launch

  /** Put the mech on the catapult's shuttle, crouched, with the camera on it. */
  _beginLaunch() {
    const c = this.world.catapult;
    const m = this.player.mech;
    this.world.showCatapult(true);
    m.place(0, c.start, 0, 0);
    this.rig.reset(0);
    this.launch = { t: 0, released: false };
    this.hud.message('LAUNCH', 'good', `${this.player.build.name}, LAUNCHING!`);
    this.audio.ui('wave');
  }

  /** One step of the launch: the countdown, the run down the deck, the release, then the camera handing back. */
  _updateLaunch(dt) {
    const L = this.launch, c = this.world.catapult, m = this.player.mech, rig = this.rig;
    L.t += dt;
    const run = L.t - LAUNCH_STANDBY;
    if (!L.released) {
      const len = c.start - c.end;
      if (run < 0) {
        // standby: crouched on the shuttle, the thrusters building up while the lights count down
        m.pos.set(0, 0, c.start);
        m.update(dt, { velocity: ZERO, launch: 1, boost: 0.2 + 0.7 * (L.t / LAUNCH_STANDBY), faceYaw: 0 });
        this.audio.setBoost(0.3 + 0.5 * (L.t / LAUNCH_STANDBY));
        c.setLights(L.t / LAUNCH_STANDBY);
        c.setShuttle(c.start);
      } else {
        // the run: the shuttle accelerates down the deck with the mech on it
        const u = Math.min(1, run / LAUNCH_RUN);
        const speed = (2 * len * u) / LAUNCH_RUN;
        m.update(dt, { velocity: new THREE.Vector3(0, 0, -speed), launch: 1, boost: 1, faceYaw: 0 });
        this.audio.setBoost(1);
        c.setShuttle(m.pos.z);
        c.setLights(1, u);
        if (Math.random() < 0.8) this.fx.sparks(new THREE.Vector3(rand(-3, 3), 0.4, m.pos.z + 3), new THREE.Vector3(0, 0.4, 1), 3, [1, 0.8, 0.4]);
        if (u >= 1) {
          // the shuttle lets go at the end of the deck: the mech is thrown into the air
          L.released = true;
          L.releasedAt = L.t;
          m.vel.set(0, 50, -speed * 0.92);
          m.pos.y = 0.6;
          m.grounded = false;
          m.model.flare(1);
          this.fx.dust(m.pos, 16, 30);
          this.shake(0.5);
          this.audio.dash(m.pos);
          this.input.clear();
        }
      }
    } else {
      c.setShuttle(lerp(c.end, c.start, clamp((L.t - L.releasedAt - 0.6) / 1.5, 0, 1)));
      c.setLights(1, 1);
      if (L.t - L.releasedAt > 2.6) { this.world.showCatapult(false); this.launch = null; rig.cine = null; return; }
    }

    // the camera: low beside the deck during the countdown, then watching the run go past, then back behind the pilot
    const k = L.released ? 1 - ease(clamp((L.t - L.releasedAt) / LAUNCH_BLEND, 0, 1)) : 1;
    const cine = rig.cine ?? (rig.cine = { pos: new THREE.Vector3(), look: new THREE.Vector3(), w: 1 });
    if (run < 0) {
      const a = L.t / LAUNCH_STANDBY;
      cine.pos.set(21 - a * 5, 5 + a * 2.5, c.start - 30 + a * 5);
      cine.look.set(-2, 8.5, c.start + 2);
    } else {
      cine.pos.set(17, 7, c.end - 26);
      cine.look.set(0, 9 + Math.max(0, m.pos.y * 0.6), m.pos.z);
    }
    cine.w = k;
  }

  // ------------------------------------------------------------------ wrecks

  /** A machine was destroyed: it breaks down for a moment (sparking, sinking to its knees) before it explodes. */
  _addWreck(mech) {
    const boss = !!mech.def.boss;
    const c = mech.center();
    this.fx.sparks(c, null, 30, [1, 0.8, 0.45]);
    this.fx.explosion(c, 7 * mech.spec.scale, { shake: 0.4 });
    mech.setSaber(false);
    mech.tintColor = null;
    this.wrecks.push({ mech, t: 0, dur: boss ? WRECK_TIME_BOSS : WRECK_TIME, spark: 0 });
  }

  _updateWrecks(dt) {
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i], m = w.mech;
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      m.updateWreck(dt, k);
      // sparks from the joints, small blasts, smoke
      w.spark -= dt;
      if (w.spark <= 0) {
        w.spark = rand(0.04, 0.1);
        const s = m.spec.scale;
        const p = new THREE.Vector3(m.pos.x + rand(-4, 4) * s, m.pos.y + rand(3, 16) * s, m.pos.z + rand(-4, 4) * s);
        this.fx.sparks(p, null, 8, [1, 0.85, 0.5]);
        if (Math.random() < 0.18) this.fx.explosion(p, rand(3, 6) * s, { shake: 0.15, sound: Math.random() < 0.5 });
        this.fx.smokePuff(p, 2 * s, 1.6);
      }
      if (k >= 1) {
        this.wrecks.splice(i, 1);
        this._explodeWreck(m);
      }
    }
  }

  _explodeWreck(mech) {
    const center = mech.center();
    const boss = !!mech.def.boss;
    const player = mech === this.player.mech;
    const r = player ? 40 : (boss ? 62 : 32) * mech.spec.scale;
    this.fx.explosion(center, r, { shake: boss ? 1.4 : player ? 1.2 : 1 });
    this.destruction.explode(center.x, center.y, center.z, boss ? 900 : 450, r * 1.1); // a machine blowing up next to a building hurts it
    this.fx.debrisBurst(center, mech.spec.palette, mech.spec.scale);
    if (boss) this.fx.explosion(center.clone().add(new THREE.Vector3(8, 6, -4)), r * 0.7, { sound: false });
    mech.destroy();
  }

  /** Drop any wrecks still breaking down (a new sortie, the pit, the title), without the fireworks. */
  _clearWrecks() {
    for (const w of this.wrecks) {
      if (w.mech === this.player.mech) this.scene.remove(w.mech.root); // the pilot's machine is reset, not thrown away
      else w.mech.destroy();
    }
    this.wrecks.length = 0;
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

  /** A barrier soaked part of a hit: a cyan spark and a tick, without the red flash of real damage. */
  onBarrierHit(mech, amount, info) {
    this.fx.sparks(info.point ?? mech.center(), null, 10, [0.4, 0.9, 1]);
    this.audio.hit(mech.pos);
    if (mech.team === 'player') this.shake(clamp(amount / 600, 0.05, 0.4));
  }

  onDestroyed(mech) {
    if (mech.team === 'enemy') {
      const boss = !!mech.def.boss;
      const i = this.enemies.indexOf(mech.enemy);
      if (i >= 0) this.enemies.splice(i, 1);
      this._addWreck(mech);

      this.combo.count++;
      this.combo.t = 5;
      const mult = 1 + 0.25 * Math.min(this.combo.count - 1, 4);
      this.stats.score += Math.round(mech.def.score * mult);
      this.stats.kills++;
      const p = this.player;
      if (!p.burstActive) p.burst = Math.min(100, p.burst + 8);

      if (boss) {
        this.slowmoT = 1.6;
        this.hitstopT = 0.15;
        this.rig.punch(1);
        this.hud.message('BARON DESTROYED', 'good');
      } else {
        this.cinematic(this.enemies.length === 0 && this.missions.state === 'combat' ? 'lastKill' : 'kill');
      }
      if (mech.def.boss && this.missions.index === 4) this.audio.setMusicLevel(0.3);
    } else {
      this._addWreck(mech);
      this.slowmoT = 1.2;
      this.endMission(false);
    }
  }
}
