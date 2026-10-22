// The test range: your machine, a few practice dummies and a damage meter. Nothing here can end the sortie: the pilot
// cannot be destroyed (armor stops at 1), so a build can be tried against anything, then repaired from the pause menu.
// Sparring partners (the ordinary enemies and the rigged ones) can be called in and cleared away from the same menu.

import * as THREE from 'three';
import { createEnemy } from './ai.js';
import { RIGGED_TYPES } from './rigged.js';

const WINDOW = 3;     // seconds the DPS reading looks back over
const RESPAWN = 2;    // a destroyed dummy is replaced after this long
const MAX_SPARRING = 4;
/** Where the dummies stand, in front of the start: [sideways, distance]. */
const SPOTS = [[0, 75], [-55, 125], [55, 125], [0, 175]];

export const SPARRING = ['drone', 'striker', 'bulwark', ...RIGGED_TYPES];

export class Range {
  constructor(game) {
    this.game = game;
    this.slots = [];
    this.resetMeter();
  }

  /** Put the dummies out. Called when the range opens, after the sortie has been cleared. */
  start() {
    const world = this.game.world;
    const taken = [];
    this.slots = SPOTS.map(([dx, dist]) => {
      let spot = { x: dx, z: -dist };
      if (!world.isOpen(spot.x, spot.z)) spot = world.findSpawn(60, 190, taken);
      taken.push(spot);
      return { ...spot, enemy: null, respawnT: 0 };
    });
    for (const s of this.slots) this._spawnDummy(s);
    this.resetMeter();
  }

  stop() {
    this.slots = [];
  }

  _spawnDummy(slot) {
    const game = this.game;
    const e = createEnemy(game, 'dummy', 1);
    e.mech.place(slot.x, slot.z, 0, Math.atan2(-slot.x, -slot.z + 1));
    game.enemies.push(e);
    slot.enemy = e;
  }

  /** Zero the damage meter. */
  resetMeter() {
    const stats = this.game.stats;
    this.time = 0;
    this.base = stats.damageDealt;
    this.baseParts = stats.partsShot ?? 0;
    this.samples = [];
    this.total = 0;
    this.dps = 0;
    this.peak = 0;
    this.average = 0;
    this.partsShot = 0;
    this.firstT = -1;
    this.lastT = -1;
  }

  update(dt) {
    const game = this.game;
    this.time += dt;
    for (const s of this.slots) {
      if (s.enemy && s.enemy.mech.dead) { s.enemy = null; s.respawnT = RESPAWN; }
      if (!s.enemy && (s.respawnT -= dt) <= 0) this._spawnDummy(s);
    }
    // the meter: everything you deal counts (guns, saber, missiles, turrets, the lot)
    const dealt = game.stats.damageDealt - this.base;
    if (dealt > this.total + 1e-6) {
      if (this.firstT < 0) this.firstT = this.time;
      this.lastT = this.time;
    }
    this.total = Math.max(0, dealt);
    this.samples.push([this.time, this.total]);
    while (this.samples.length > 1 && this.time - this.samples[0][0] > WINDOW) this.samples.shift();
    this.dps = (this.total - this.samples[0][1]) / WINDOW;
    this.peak = Math.max(this.peak, this.dps);
    this.average = this.firstT < 0 ? 0 : this.total / Math.max(1, this.lastT - this.firstT);
    this.partsShot = (game.stats.partsShot ?? 0) - this.baseParts;
  }

  /** Enemies that are not dummies. */
  sparring() {
    return this.game.enemies.filter((e) => e.type !== 'dummy' && !e.mech.dead);
  }

  /** Call in a sparring partner at a distance, dropping in from above. Returns false when the range is full. */
  spar(type) {
    const game = this.game;
    if (!SPARRING.includes(type) || this.sparring().length >= MAX_SPARRING) return false;
    const spot = game.world.findSpawn(120, 230, game.enemies.map((e) => e.mech.pos));
    const e = createEnemy(game, type, 1);
    e.mech.place(spot.x, spot.z, 40, Math.random() * Math.PI * 2);
    e.mech.vel.y = -20;
    game.enemies.push(e);
    game.fx.sparks(e.mech.center(new THREE.Vector3()), null, 14, [0.5, 0.9, 1]);
    return true;
  }

  clearSparring() {
    const game = this.game;
    for (let i = game.enemies.length - 1; i >= 0; i--) {
      const e = game.enemies[i];
      if (e.type === 'dummy') continue;
      e.mech.destroy();
      game.enemies.splice(i, 1);
    }
  }

  /** Back to full armor, a full loadout and every part replaced. */
  repair() {
    const p = this.game.player;
    p.resupply(1);
    p.mech.hp = p.mech.maxHp;
    p.mech.barrier = p.mech.barrierMax;
    this.game.hud.message('REPAIRED', 'good');
  }
}
