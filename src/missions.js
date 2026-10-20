// The sortie: five waves, resupply between them, and a boss at the end.

import { WAVES } from './data.js';
import { createEnemy } from './ai.js';

const INTRO_TIME = 2.8;
const CLEAR_TIME = 4.2;

export class Missions {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset() {
    this.index = -1;
    this.state = 'idle'; // idle | intro | combat | clear | done
    this.timer = 0;
    this.finished = false;
  }

  get total() { return WAVES.length; }
  get waveNumber() { return Math.min(WAVES.length, Math.max(1, this.index + 1)); }
  get title() { return WAVES[Math.min(this.index, WAVES.length - 1)]?.title ?? ''; }

  start() {
    this.reset();
    this._next();
  }

  _next() {
    this.index++;
    if (this.index >= WAVES.length) {
      this.state = 'done';
      this.finished = true;
      this.game.endMission(true);
      return;
    }
    const wave = WAVES[this.index];
    this.state = 'intro';
    this.timer = INTRO_TIME;
    if (wave.boss) {
      this.game.hud.message('WARNING', 'bad', 'ACE-CLASS SIGNATURE DETECTED');
      this.game.audio.alert();
    } else {
      this.game.hud.message(`WAVE ${this.index + 1}`, '', wave.title);
    }
    this.game.audio.ui('wave');
  }

  _spawnWave() {
    const game = this.game;
    const wave = WAVES[this.index];
    const skill = 1 + this.index * 0.1;
    const taken = [];
    for (const [type, count] of wave.spawn) {
      for (let i = 0; i < count; i++) {
        const spot = game.world.findSpawn(190, 330, taken);
        taken.push(spot);
        const boss = type === 'baron';
        const e = createEnemy(game, type, skill);
        e.mech.place(spot.x, spot.z, boss ? 90 : 55, Math.random() * Math.PI * 2);
        e.mech.vel.y = -20;
        game.enemies.push(e);
        game.fx.sparks(e.mech.center(), null, 14, [0.5, 0.9, 1]);
      }
    }
    game.audio.setMusicLevel(wave.boss ? 1 : Math.min(0.8, 0.3 + this.index * 0.15));
  }

  update(dt) {
    const game = this.game;
    switch (this.state) {
      case 'intro':
        this.timer -= dt;
        if (this.timer <= 0) {
          this._spawnWave();
          this.state = 'combat';
        }
        break;
      case 'combat':
        if (game.enemies.length === 0) {
          this.state = 'clear';
          this.timer = CLEAR_TIME;
          const bonus = 250 * (this.index + 1);
          game.stats.score += bonus;
          const last = this.index === WAVES.length - 1;
          if (!last) {
            game.player.resupply(game.player.stats.resupplyHeal);
            game.hud.message('WAVE CLEARED', 'good', `+${bonus} BONUS  ·  ARMOR REPAIRED`);
            game.audio.ui('clear');
          }
        }
        break;
      case 'clear':
        this.timer -= dt;
        if (this.timer <= 0) this._next();
        break;
      default:
    }
  }
}
