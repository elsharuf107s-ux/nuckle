// Wild battles on FireRed's battle screen, with Steve fighting in person. The Gen 3 rules engine
// (from Sky Anywhere) resolves a whole turn into a queue of presentation events that the screen plays
// in order. Steve is a battler of his own: hearts instead of an HP bar, moves taken from his gear
// (a weapon's durability is its PP, a bow's PP is the arrows in his inventory), food that heals,
// and the Poké Balls he crafted. Damage he takes is scaled onto his 20 health and his armor.
import { A } from './assets.js';
import { G as GAME } from './game.js';
import { species, move, typeRows, isPhysical, expFor, recalc, movesAt } from './data.js';
import { rand, randInt, range, chance } from './rng.js';
import { drawText, textWidth, drawFit } from './font.js';
import { cursorArrow, wrap, moreArrow, drawWindow, drawList, VW, VH, FG, SH } from './ui.js';
import { item, toolOf, foodOf, nameOf, bladeSided } from './items.js';
import { xpForLevel, drawIcon } from './hud.js';
import { mc } from './audio.js';
import { PartyScreen } from './partyui.js';
import { sfx, music, cry } from './audio.js';

import { silhouette } from './sprites.js';

const STAGE = [[10, 40], [10, 35], [10, 30], [10, 25], [10, 20], [10, 15], [10, 10], [15, 10], [20, 10], [25, 10], [30, 10], [35, 10], [40, 10]];
const ACC = [[33, 100], [36, 100], [43, 100], [50, 100], [60, 100], [75, 100], [1, 1], [133, 100], [166, 100], [2, 1], [233, 100], [133, 50], [3, 1]];
const CRIT = [16, 8, 4, 3, 2];
const STAT_NAME = { atk: 'ATTACK', def: 'DEFENSE', spe: 'SPEED', spa: 'SP. ATK', spd: 'SP. DEF', acc: 'accuracy', eva: 'evasiveness' };
const TYPE_COLOR = {
  NORMAL: '#f8f8f0', FIRE: '#f86830', WATER: '#4890f8', ELECTRIC: '#f8d830', GRASS: '#60c858', ICE: '#98e0f8',
  FIGHTING: '#d04028', POISON: '#b050c0', GROUND: '#e0c068', FLYING: '#d8e8ff', PSYCHIC: '#f86898', BUG: '#b0c028',
  ROCK: '#c0a040', GHOST: '#7860a8', DRAGON: '#8050f8', DARK: '#705848', STEEL: '#c0c0d8', MYSTERY: '#f8f8f0',
};
const TYPE_SFX = { FLYING: 'gust', ELECTRIC: 'zap', FIRE: 'flame', WATER: 'splash', PSYCHIC: 'psychic', GHOST: 'psychic', ICE: 'splash' };
const HITS_INVULN = new Set(['GUST', 'TWISTER', 'THUNDER', 'SKY_UPPERCUT']);
const STAT_EFFECTS = {
  ATTACK_UP: ['atk', 1], ATTACK_UP_2: ['atk', 2], DEFENSE_UP: ['def', 1], DEFENSE_UP_2: ['def', 2], SPEED_UP: ['spe', 1],
  SPEED_UP_2: ['spe', 2], SPECIAL_ATTACK_UP: ['spa', 1], SPECIAL_ATTACK_UP_2: ['spa', 2], SPECIAL_DEFENSE_UP: ['spd', 1],
  SPECIAL_DEFENSE_UP_2: ['spd', 2], EVASION_UP: ['eva', 1], ATTACK_DOWN: ['atk', -1], ATTACK_DOWN_2: ['atk', -2],
  DEFENSE_DOWN: ['def', -1], DEFENSE_DOWN_2: ['def', -2], SPEED_DOWN: ['spe', -1], SPEED_DOWN_2: ['spe', -2],
  SPECIAL_DEFENSE_DOWN_2: ['spd', -2], ACCURACY_DOWN: ['acc', -1], EVASION_DOWN: ['eva', -1],
};
const HIT_STAT = {
  SPEED_DOWN_HIT: ['spe', -1, 'def'], DEFENSE_DOWN_HIT: ['def', -1, 'def'], ATTACK_DOWN_HIT: ['atk', -1, 'def'],
  SPECIAL_DEFENSE_DOWN_HIT: ['spd', -1, 'def'], SPECIAL_ATTACK_DOWN_HIT: ['spa', -1, 'def'], ACCURACY_DOWN_HIT: ['acc', -1, 'def'],
  DEFENSE_UP_HIT: ['def', 1, 'att'], ATTACK_UP_HIT: ['atk', 1, 'att'],
};
const HIT_STATUS = { PARALYZE_HIT: 'PAR', BURN_HIT: 'BRN', FREEZE_HIT: 'FRZ', POISON_HIT: 'PSN', POISON_FANG: 'PSN', THUNDER: 'PAR' };
const TEXT_WHITE = '#f8f8f8', TEXT_SHADOW = '#685870';
const MENU_FG = '#484848', MENU_SH = '#d0d0c8';

function stageApply(v, s) { const [n, d] = STAGE[s + 6]; return Math.floor((v * n) / d); }
function tinted(img, color) { return silhouette(img, color); }

const BOSS_PANT = 0.4;      // the ENDER DRAGON's lost turns (see useMove)
function newBattler(mon, idx) {
  return { mon, idx, stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 }, conf: 0, flinch: false, recharge: false,
    charge: null, invuln: false, protect: false, protectChain: 0, trap: 0, trapName: '', focus: false, fainted: false };
}

// the player's name in the battle's text: a co-op player's own (G.myName), STEVE in single-player
const ME = () => GAME.myName || 'STEVE';
const HIS = () => (GAME.mySkin && GAME.mySkin !== 'steve' ? 'their' : 'his');

export class Battle {
  // opts (The End's legendary battle): music (a track in place of the wild theme), boss (RUN can't escape and ROAR
  // fails, as befits the ENDER DRAGON)
  constructor(game, wild, terrain = 'grass', opts = {}) {
    this.game = game;
    this.terrain = terrain;
    this.opts = opts;
    this.boss = !!opts.boss;
    this.steve = steveMon(game);
    this.party = [this.steve, ...game.party];
    this.xpGained = 0;
    const firstIdx = 0;
    this.P = newBattler(this.party[firstIdx], firstIdx);
    // The boss (FireRed's lead rule): the first healthy POKéMON goes out and STEVE stays back while it can fight
    this.lead = this.boss ? this.party.findIndex((m, i) => i > 0 && m.hp > 0) : -1;
    this.E = newBattler(wild, -1);
    this.sides = { player: { mist: 0, reflect: 0 }, enemy: { mist: 0, reflect: 0 } };
    this.participants = new Set([this.P.mon.uid]);
    this.runTries = 0;
    this.q = []; this.cur = null; this.after = null;
    this.ui = 'intro';
    this.t = 0;
    this.over = false; this.outcome = null; this.finished = null;
    this.menu = 0; this.moveCursor = 0; this.bagCursor = 0; this.yesno = 0;
    this.party_ui = null;
    this.fx = [];     // transient particles
    this.dp = this.dispOf(this.P.mon, 'player');
    this.de = this.dispOf(wild, 'enemy');
    this.de.dark = 1; this.de.slide = 1; this.dp.slide = 1; this.dp.hb = 1; this.de.hb = 1;
    game.dex.seen.add(wild.species);
    music.play(opts.music || 'battle');
    this.intro();
  }

  dispOf(mon, side) {
    return { mon, side, hp: mon.hp, maxHp: mon.maxHp, level: mon.level, name: mon.name, status: mon.status, species: mon.species,
      shiny: mon.shiny, exp: this.expFrac(mon), visible: true, offX: 0, offY: 0, scale: 1, white: 0, blink: false, tint: null,
      clip: 64, hb: 1, slide: 0, dark: 0, hidden: false };
  }
  expFrac(mon) {
    const g = species(mon.species).growth;
    if (mon.level >= 100) return 0;
    const lo = expFor(g, mon.level), hi = expFor(g, mon.level + 1);
    return Math.max(0, Math.min(1, (mon.exp - lo) / (hi - lo)));
  }
  nameOf(b) { return b === this.E ? 'Wild ' + b.mon.name : b.mon.name; }
  bagItems() { return bagFrom(this.game.inv); }
  sideOf(b) { return b === this.P ? 'player' : 'enemy'; }
  dispFor(b) { return b === this.P ? this.dp : this.de; }
  foe(b) { return b === this.P ? this.E : this.P; }

  // ---------------------------------------------------------------- event helpers
  push(ev) { this.q.push(ev); }
  msg(text, press = false) { this.push({ type: 'msg', text, press }); }
  set(fn) { this.push({ type: 'set', fn }); }
  sound(name) { this.push({ type: 'sfx', name }); }
  hpTo(b, value) { this.push({ type: 'hp', disp: this.dispFor(b), to: value }); }
  status(b) { const d = this.dispFor(b), s = b.mon.status; this.set(() => { d.status = s; }); }

  intro() {
    const w = this.E.mon;
    this.push({ type: 'intro' });
    this.push({ type: 'cry', key: w.species });
    if (w.shiny) { this.sound('shiny'); this.push({ type: 'sparkle', disp: this.de }); }
    this.push({ type: 'hbslide', disp: this.de });
    this.msg(`Wild ${w.name} appeared!`, true);
    if (this.lead > 0) {
      // STEVE steps aside and throws out his lead, as FireRed's trainer does
      const i = this.lead, mon = this.party[i];
      this.push({ type: 'steveaway', disp: this.dp });
      this.set(() => { this.P = newBattler(mon, i); this.participants.delete(this.steve.uid); this.participants.add(mon.uid); });
      this.msg(`Go! ${mon.name}!`);
      this.push({ type: 'sendout', disp: this.dp, apply: () => { Object.assign(this.dp, this.dispOf(mon, 'player'), { hb: 1, slide: 0 }); } });
      this.push({ type: 'hbslide', disp: this.dp });
      this.after = () => this.beginTurnInput();
      return;
    }
    this.push({ type: 'hbslide', disp: this.dp });
    this.set(() => { if (this.P.mon.isSteve) mc('attack.weak', { vol: 0.3, pitch: 0.7 }); });
    this.after = () => this.beginTurnInput();
  }

  // Called whenever the queue drains and the player must act (or a forced action happens).
  beginTurnInput() {
    if (this.over) return;
    if (this.P.charge || this.P.recharge) { this.resolveTurn({ type: 'move', move: this.P.charge || 'RECHARGE' }); return; }
    this.ui = 'action';
  }

  // ---------------------------------------------------------------- per-frame
  update(dt, input) {
    this.t += dt;
    if (this.dp.redT > 0) this.dp.redT -= dt;
    if (this.flash > 0) this.flash -= dt;
    for (let i = this.fx.length - 1; i >= 0; i--) { const p = this.fx[i]; p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.life <= 0) this.fx.splice(i, 1); }
    for (let guard = 0; guard < 40; guard++) {
      if (!this.cur) {
        if (!this.q.length) break;
        this.cur = this.q.shift(); this.cur.t = 0; this.startEvent(this.cur);
      }
      const done = this.stepEvent(this.cur, guard === 0 ? dt : 0, input);
      if (!done) break;
      this.cur = null;
    }
    if (this.cur || this.q.length) return;
    if (this.after) { const f = this.after; this.after = null; f(); return; }
    if (this.finished) return;
    this.handleInput(input);
  }

  startEvent(e) {
    switch (e.type) {
      case 'msg': {
        const lines = wrap(e.text, 212);
        e.pages = []; for (let i = 0; i < lines.length; i += 2) e.pages.push(lines.slice(i, i + 2));
        e.page = 0; e.shown = 0; e.hold = 0;
        break;
      }
      case 'sfx': sfx[e.name](); break;
      case 'cry': cry(e.key, e.pitch || 1); break;
      case 'music': music.play(e.name); break;
      case 'hp': e.from = e.disp.hp; break;
      case 'exp': e.from = e.disp.exp; break;
    }
  }

  stepEvent(e, dt, input) {
    e.t += dt;
    switch (e.type) {
      case 'set': e.fn(); return true;
      case 'sfx': case 'cry': case 'music': return true;
      case 'wait': return e.t >= e.dur;
      case 'msg': {
        const page = e.pages[e.page];
        const total = page.reduce((n, l) => n + l.length, 0);
        if (e.shown < total) {
          e.shown = Math.min(total, e.shown + dt * 55);
          if (input.just('a') || input.just('b')) e.shown = total;
          return false;
        }
        e.hold += dt;
        const last = e.page === e.pages.length - 1;
        const needPress = e.press || !last;
        if (needPress ? (input.just('a') || input.just('b')) : (e.hold >= 0.75 || input.just('a') || input.just('b'))) {
          if (needPress) sfx.select();
          if (last) { this.lastMsg = e; return true; }
          e.page++; e.shown = 0; e.hold = 0;
        }
        return false;
      }
      case 'intro': {
        const k = Math.min(1, e.t / 0.9);
        const s = 1 - (1 - k) * (1 - k);
        this.de.slide = 1 - s; this.dp.slide = 1 - s;
        if (k >= 1) { this.de.dark = Math.max(0, 1 - (e.t - 0.9) / 0.25); }
        return e.t >= 1.15;
      }
      case 'hbslide': {
        const k = Math.min(1, e.t / 0.3);
        e.disp.hb = e.out ? k : 1 - k;
        return k >= 1;
      }
      case 'sparkle': {
        if (Math.floor(e.t * 20) !== Math.floor((e.t - dt) * 20)) this.burst(e.disp, '#f8f0a0', 4, 30);
        return e.t >= 0.6;
      }
      case 'hp': {
        const d = e.disp, target = Math.max(0, Math.min(d.maxHp, e.to));
        const rate = Math.max(d.maxHp / 48, 1) * 60 * 0.9; // about one bar pixel per frame
        if (d.hp < target) d.hp = Math.min(target, d.hp + rate * dt); else d.hp = Math.max(target, d.hp - rate * dt);
        return d.hp === target;
      }
      case 'exp': {
        const d = e.disp;
        d.exp = Math.min(e.to, d.exp + dt * 0.9);
        if (Math.floor(e.t * 12) !== Math.floor((e.t - dt) * 12)) sfx.expTick();
        return d.exp >= e.to;
      }
      case 'anim': return this.stepAnim(e, dt);
      case 'faint': {
        const d = e.disp;
        if (e.t - dt <= 0) { if (d.species === 'STEVE') mc('hurt', { vol: 0.9, pitch: 0.8 }); else cry(d.species, 0.8); }
        d.offY = Math.min(64, (e.t / 0.35) * 64);
        if (e.t >= 0.35) { d.visible = false; d.offY = 0; return e.t >= 0.5; }
        return false;
      }
      case 'withdraw': {
        const d = e.disp;
        if (e.t - dt <= 0) sfx.recall();
        const k = Math.min(1, e.t / 0.35);
        d.tint = '#f07070'; d.white = Math.min(1, k * 2); d.scale = 1 - k;
        if (k >= 1) { d.visible = false; d.scale = 1; d.white = 0; d.tint = null; return true; }
        return false;
      }
      case 'sendout': {
        const d = e.disp;
        if (e.t - dt <= 0) { e.apply(); d.visible = false; sfx.throw(); }
        if (e.t < 0.45) { e.ball = { x: 20 + (72 - 20) * (e.t / 0.45), y: 90 - Math.sin((e.t / 0.45) * Math.PI) * 30 }; return false; }
        if (!e.opened) { e.opened = true; e.ball = null; sfx.ballOpen(); d.visible = true; d.scale = 0; d.white = 1; this.burst(d, '#f8f8f8', 10, 50); }
        const k = Math.min(1, (e.t - 0.45) / 0.3);
        d.scale = k; d.white = 1 - k;
        if (k >= 1) { d.scale = 1; d.white = 0; cry(d.species); return e.t >= 1.0; }
        return false;
      }
      case 'steveaway': {
        // STEVE walks off to the left before his lead is thrown out
        const d = e.disp, k = Math.min(1, e.t / 0.45);
        if (e.t - dt <= 0) d.pose = 'throw';
        d.slide = -k * k;
        if (k >= 1) { d.visible = false; d.pose = 'idle'; return true; }
        return false;
      }
      case 'stevein': {
        const d = e.disp;
        if (e.t - dt <= 0) e.apply();
        const k = Math.min(1, e.t / 0.45);
        d.slide = 1 - (1 - (1 - k) * (1 - k));
        return k >= 1;
      }
      case 'hide': { // Fly: up out of sight
        const d = e.disp; const k = Math.min(1, e.t / 0.3);
        d.offY = -k * 110; if (k >= 1) { d.hidden = true; d.offY = 0; return true; }
        return false;
      }
      case 'show': {
        const d = e.disp; d.hidden = false; const k = Math.min(1, e.t / 0.2);
        d.offY = -(1 - k) * 110; return k >= 1;
      }
      case 'status': return true;
      case 'ballthrow': return this.stepBall(e, dt);
      case 'statanim': {
        const d = e.disp;
        if (e.t - dt <= 0) sfx[e.up ? 'statUp' : 'statDown']();
        d.tint = e.up ? '#f8a040' : '#5080f8';
        d.white = 0.45 * (0.5 + 0.5 * Math.sin(e.t * 20));
        if (e.t >= 0.6) { d.tint = null; d.white = 0; return true; }
        return false;
      }
      case 'end': this.finished = e.outcome; return true;
      case 'learn': return this.stepLearn(e, input);
    }
    return true;
  }

  burst(disp, color, n, speed) {
    const c = this.spriteCenter(disp);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      this.fx.push({ x: c.x, y: c.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 0.35 + Math.random() * 0.2, color, size: 2 });
    }
  }
  spriteCenter(d) { return d.side === 'enemy' ? { x: 176, y: 40 } : { x: 72, y: 84 }; }

  stepAnim(e, dt) {
    const att = e.attDisp, def = e.defDisp;
    const dir = att.side === 'player' ? 1 : -1;
    const mv = e.move;
    if (e.kind === 'self') {
      if (e.t - dt <= 0) sfx.statUp();
      att.tint = TYPE_COLOR[mv.type] || '#ffffff'; att.white = 0.5 * Math.abs(Math.sin(e.t * 10));
      if (e.t >= 0.5) { att.tint = null; att.white = 0; return true; }
      return false;
    }
    const hitAt = e.kind === 'contact' ? 0.14 : 0.36;
    if (att.species === 'STEVE') att.pose = e.t < (e.kind === 'contact' ? 0.1 : 0.2) ? 'raise' : e.t < hitAt + 0.25 ? 'strike' : 'idle';
    if (e.kind === 'contact') {
      const k = e.t < 0.14 ? e.t / 0.14 : Math.max(0, 1 - (e.t - 0.14) / 0.14);
      att.offX = dir * 10 * k; att.offY = -dir * 5 * k;
    } else {
      // projectile / wave in the move's type colour
      if (e.t < hitAt && Math.floor(e.t * 40) !== Math.floor((e.t - dt) * 40)) {
        const a = this.spriteCenter(att), b = this.spriteCenter(def);
        const k = e.t / hitAt;
        for (let i = 0; i < 2; i++) this.fx.push({ x: a.x + (b.x - a.x) * k + (Math.random() - 0.5) * 10, y: a.y + (b.y - a.y) * k + (Math.random() - 0.5) * 10, vx: (Math.random() - 0.5) * 20, vy: (Math.random() - 0.5) * 20, life: 0.25, color: TYPE_COLOR[mv.type] || '#fff', size: 3 });
      }
      if (e.t - dt <= 0 && TYPE_SFX[mv.type]) sfx[TYPE_SFX[mv.type]]();
    }
    if (e.t >= hitAt && !e.hitDone) {
      e.hitDone = true;
      if (e.damage) {
        if (att.mon && att.species === 'STEVE') mc(e.move.id === 'MC_BOW' ? 'bowhit' : e.move.id === 'MC_TNT' ? 'explode' : 'attack.strong', { vol: 0.8 });
        if (def.species === 'STEVE') { mc('hurt', { vol: 0.9 }); def.redT = 0.4; }
        sfx[e.eff > 1 ? 'hitSuper' : e.eff < 1 ? 'hitWeak' : 'hit']();
        this.burst(def, TYPE_COLOR[mv.type] || '#fff', 8, 60);
      } else if (e.kind !== 'contact') this.burst(def, TYPE_COLOR[mv.type] || '#fff', 6, 40);
    }
    if (e.damage && e.t >= hitAt) def.blink = Math.floor((e.t - hitAt) * 16) % 2 === 0;
    const end = hitAt + (e.damage ? 0.36 : 0.2);
    if (e.t >= end) { att.offX = 0; att.offY = 0; def.blink = false; return true; }
    return false;
  }

  stepBall(e, dt) {
    const d = this.de;
    const target = { x: 176, y: 40 + 8 };
    const P0 = { x: 30, y: 120 };
    if (e.t - dt <= 0) sfx.throw();
    const T_ARC = 0.55, T_ABSORB = 0.45, T_DROP = 0.35, T_SHAKE = 0.7;
    if (e.t < T_ARC) {
      const k = e.t / T_ARC;
      e.pos = { x: P0.x + (target.x - P0.x) * k, y: P0.y + (target.y - 10 - P0.y) * k - Math.sin(k * Math.PI) * 40, frame: 0, rot: k * 6 };
      return false;
    }
    let t = e.t - T_ARC;
    if (t < T_ABSORB) {
      if (!e.opened) { e.opened = true; sfx.ballOpen(); this.burst(d, '#f8f8f8', 10, 40); }
      e.pos = { x: target.x, y: target.y - 12, frame: 2, rot: 0 };
      const k = t / T_ABSORB;
      d.tint = '#f8f8f8'; d.white = Math.min(1, k * 3); d.scale = Math.max(0, 1 - k);
      return false;
    }
    if (!e.absorbed) { e.absorbed = true; d.visible = false; d.scale = 1; d.white = 0; d.tint = null; }
    t -= T_ABSORB;
    if (t < T_DROP) {
      const k = t / T_DROP;
      const bounce = k < 0.6 ? (k / 0.6) : 1 - Math.sin(((k - 0.6) / 0.4) * Math.PI) * 0.25;
      e.pos = { x: target.x, y: target.y - 12 + bounce * 24, frame: 0, rot: 0 };
      return false;
    }
    t -= T_DROP;
    const shakesShown = Math.min(e.shakes, 3);
    const si = Math.floor(t / T_SHAKE);
    if (si < shakesShown) {
      const k = (t - si * T_SHAKE) / T_SHAKE;
      if (!e.shook || e.shook <= si) { e.shook = si + 1; }
      if (k < 0.5 && Math.floor(k * 100) === 0 && !e['s' + si]) { e['s' + si] = true; sfx.wobble(); }
      const rot = k < 0.5 ? Math.sin(k * 2 * Math.PI * 2) * 0.45 : 0;
      e.pos = { x: target.x + rot * 4, y: target.y + 12, frame: 0, rot };
      return false;
    }
    t -= shakesShown * T_SHAKE;
    if (e.caught) {
      if (!e.clicked) { e.clicked = true; sfx.click(); for (let i = 0; i < 3; i++) this.fx.push({ x: target.x - 6 + i * 6, y: target.y + 8, vx: (i - 1) * 25, vy: -40, life: 0.6, color: '#f8e060', size: 3, star: true }); }
      e.pos = { x: target.x, y: target.y + 12, frame: 0, rot: 0, dim: t > 0.4 };
      return t >= 0.9;
    }
    // broke free
    if (!e.broke) { e.broke = true; sfx.breakFree(); d.visible = true; d.scale = 0; d.white = 1; d.tint = '#f8f8f8'; this.burst(d, '#f8f8f8', 10, 50); }
    const k = Math.min(1, t / 0.3);
    d.scale = k; d.white = 1 - k; e.pos = k < 1 ? { x: target.x, y: target.y + 12, frame: 2, rot: 0 } : null;
    if (k >= 1) { d.scale = 1; d.white = 0; d.tint = null; return t >= 0.45; }
    return false;
  }

  // ---------------------------------------------------------------- input / menus
  handleInput(input) {
    switch (this.ui) {
      case 'action': {
        const c = this.menu;
        if (input.just('left') && c % 2 === 1) { this.menu--; sfx.move(); }
        if (input.just('right') && c % 2 === 0) { this.menu++; sfx.move(); }
        if (input.just('up') && c >= 2) { this.menu -= 2; sfx.move(); }
        if (input.just('down') && c < 2) { this.menu += 2; sfx.move(); }
        if (input.just('b') && this.menu !== 3) { this.menu = 3; sfx.move(); }
        if (input.just('a')) {
          sfx.select();
          if (this.menu === 0) {
            if (this.P.mon.isSteve) this.P.mon.moves = steveMoves(this.game);
            if (this.P.mon.moves.every((m) => m.pp <= 0)) { this.msg(`${this.P.mon.name} has no\nmoves left!`, true); this.after = () => this.resolveTurn({ type: 'move', move: 'STRUGGLE' }); this.ui = 'busy'; return; }
            this.ui = 'moves'; this.moveCursor = Math.min(this.moveCursor, this.P.mon.moves.length - 1);
          } else if (this.menu === 1) { this.ui = 'bag'; this.bagCursor = 0; }
          else if (this.menu === 2) this.openParty('battle');
          else this.tryRun();
        }
        break;
      }
      case 'moves': {
        const n = this.P.mon.moves.length, c = this.moveCursor;
        if (input.just('left') && c % 2 === 1) { this.moveCursor--; sfx.move(); }
        if (input.just('right') && c % 2 === 0 && c + 1 < n) { this.moveCursor++; sfx.move(); }
        if (input.just('up') && c >= 2) { this.moveCursor -= 2; sfx.move(); }
        if (input.just('down') && c + 2 < n) { this.moveCursor += 2; sfx.move(); }
        if (input.just('b')) { this.ui = 'action'; sfx.cancel(); }
        else if (input.just('a')) {
          const m = this.P.mon.moves[this.moveCursor];
          if (m.pp <= 0) { sfx.cancel(); this.msg(this.P.mon.isSteve ? `${ME()} doesn't have\nwhat that needs!` : "There's no PP left for\nthis move!", true); this.ui = 'moves'; return; }
          sfx.select();
          if (this.P.mon.isSteve) { prepareSteveMove(m); this.steveWeapon = m.weapon || null; }
          this.ui = 'busy';
          this.resolveTurn({ type: 'move', move: m.id });
        }
        break;
      }
      case 'bag': {
        const entries = this.bagItems();
        const n = entries.length + 1;
        if (input.just('up')) { this.bagCursor = (this.bagCursor + n - 1) % n; sfx.move(); }
        if (input.just('down')) { this.bagCursor = (this.bagCursor + 1) % n; sfx.move(); }
        if (input.just('b') || (input.just('a') && this.bagCursor === n - 1)) { this.ui = 'action'; sfx.cancel(); return; }
        if (input.just('a')) {
          sfx.select();
          const it = entries[this.bagCursor];
          if (it.ball) { this.ui = 'busy'; this.resolveTurn({ type: 'ball', item: it.key }); }
          else this.openParty('item', it);
        }
        break;
      }
      case 'party': this.party_ui.update(1 / 60, input); break;
      case 'yesno': {
        if (input.just('up') || input.just('down')) { this.yesno ^= 1; sfx.move(); }
        if (input.just('a')) {
          sfx.select();
          if (this.yesno === 0) this.openParty('forced');
          else { this.ui = 'busy'; this.tryRunFromFaint(); }
        }
        break;
      }
    }
  }

  openParty(mode, item) {
    this.ui = 'party';
    const prompt = mode === 'item' ? 'Use on which POKéMON?' : 'Choose a POKéMON.';
    const screen = new PartyScreen({
      party: this.party, mode: mode === 'item' ? 'item' : 'battle', prompt, activeIdx: this.P.idx,
      canCancel: mode !== 'forced',
      onDone: (i) => {
        if (i == null) { this.party_ui = null; this.ui = mode === 'item' ? 'bag' : 'action'; return; }
        // item target picked
        const mon = this.party[i];
        const res = itemEffect(item.key, mon);
        if (!res) { screen.say('It won\'t have any effect.'); return; }
        this.party_ui = null; this.ui = 'busy';
        this.resolveTurn({ type: 'item', item: item.key, target: i, result: res });
      },
      actionsFor: (mon, i) => [
        { label: mode === 'forced' ? (mon.isSteve ? 'STEP UP' : 'SEND OUT') : 'SHIFT', run: () => {
          if (mon.hp <= 0) { screen.say(`${mon.name} has no energy\nleft to battle!`); return; }
          if (i === this.P.idx && !this.P.fainted) { screen.say(`${mon.name} is already\nin battle!`); return; }
          this.party_ui = null; this.ui = 'busy';
          if (mode === 'forced') this.forcedSwitch(i); else this.resolveTurn({ type: 'switch', target: i });
        } },
        { label: 'CANCEL', run: () => {} },
      ],
    });
    this.party_ui = screen;
  }

  // ---------------------------------------------------------------- turn engine
  speedOf(b) { let s = stageApply(b.mon.spe, b.stages.spe); if (b.mon.status === 'PAR') s = Math.floor(s / 4); return s; }
  enemyChoice() {
    const E = this.E;
    if (E.recharge) return 'RECHARGE';
    if (E.charge) return E.charge;
    const usable = E.mon.moves.filter((m) => m.pp > 0);
    if (!usable.length) return 'STRUGGLE';
    return usable[randInt(usable.length)].id;
  }

  resolveTurn(action) {
    const P = this.P, E = this.E;
    this.ui = 'busy';
    const em = this.enemyChoice();
    let order;
    if (action.type !== 'move') {
      this.playerNonMove(action);
      if (this.over || this.waitingSwitch) { this.finishTurnFlow(); return; }
      order = [[E, em]];
    } else {
      const pm = action.move;
      const pp = pm === 'RECHARGE' ? 0 : move(pm).priority, ep = em === 'RECHARGE' ? 0 : move(em).priority;
      let playerFirst;
      if (pp !== ep) playerFirst = pp > ep;
      else { const sp = this.speedOf(P), se = this.speedOf(E); playerFirst = sp !== se ? sp > se : chance(0.5); }
      order = playerFirst ? [[P, pm], [E, em]] : [[E, em], [P, pm]];
    }
    this.firstMover = order[0][0];
    for (const [b, m] of order) {
      if (this.over || this.waitingSwitch) break;
      if (b.mon.hp <= 0 || this.foe(b).mon.hp <= 0) continue;
      this.useMove(b, m);
      if (this.checkFaints()) break;
    }
    if (!this.over && !this.waitingSwitch) this.endOfTurn();
    this.finishTurnFlow();
  }

  finishTurnFlow() {
    P_reset(this.P); P_reset(this.E);
    if (this.over) return;
    if (this.waitingSwitch) {
      this.waitingSwitch = false;
      if (this.party.some((m, i) => m.hp > 0 && i !== this.P.idx)) {
        this.msg('Use next POKéMON?');
        this.after = () => { this.ui = 'yesno'; this.yesno = 0; };
      }
      return;
    }
    this.after = () => this.beginTurnInput();
  }

  playerNonMove(a) {
    const P = this.P;
    if (a.type === 'switch') {
      this.doSwitch(a.target, true);
    } else if (a.type === 'item') {
      this.game.inv.spend(a.item, 1);
      const mon = this.party[a.target];
      const nm = nameOf(a.item).toUpperCase();
      const med = !!item(a.item).med;
      this.msg(med ? `${ME()} used\n${(item(a.item).frName || nm)}!` : mon.isSteve ? `${ME()} ate the\n${nm}!` : `${ME()} gave the ${nm}\nto ${mon.name}!`);
      if (mon.isSteve && !med) { this.sound('eat'); this.set(() => { mc('eat', { vol: 0.5 }); }); this.set(() => { mc('burp', { vol: 0.5 }); }); }
      applyItem(a.item, mon, a.result, this.game);
      if (mon === P.mon) {
        this.hpTo(P, mon.hp);
        this.status(P);
      }
      if (!mon.isSteve) this.sound('heal');
      this.msg(a.result.text, true);
    } else if (a.type === 'ball') {
      this.throwBall(a.item);
    } else if (a.type === 'run') {
      // handled in tryRun
    }
  }

  doSwitch(i, voluntary) {
    const P = this.P;
    const old = P.mon, mon = this.party[i];
    if (old.hp > 0) {
      this.msg(old.isSteve ? `${ME()} stepped back!` : `${old.name}, come back!`);
      this.push({ type: 'withdraw', disp: this.dp });
      this.push({ type: 'hbslide', disp: this.dp, out: true });
    }
    const nb = newBattler(mon, i);
    this.P = nb;
    this.participants.add(mon.uid);
    if (mon.isSteve) {
      this.msg(`${ME()} stepped up!`);
      this.push({ type: 'stevein', disp: this.dp, apply: () => { Object.assign(this.dp, this.dispOf(mon, 'player'), { hb: 1, slide: 1 }); } });
    } else {
      this.msg(`Go! ${mon.name}!`);
      this.push({ type: 'sendout', disp: this.dp, apply: () => { Object.assign(this.dp, this.dispOf(mon, 'player'), { hb: 1, slide: 0 }); } });
    }
    this.push({ type: 'hbslide', disp: this.dp });
    if (voluntary) void 0;
  }

  forcedSwitch(i) {
    this.doSwitch(i, false);
    this.after = () => this.beginTurnInput();
  }

  tryRun() {
    const P = this.P, E = this.E;
    this.ui = 'busy';
    if (P.trap > 0 || this.boss) { this.msg("Can't escape!", true); this.after = () => this.resolveTurnAfterFailedRun(); return; }
    this.runTries++;
    let ok = P.mon.spe >= E.mon.spe;
    if (!ok) { const odds = Math.floor((P.mon.spe * 128) / Math.max(1, E.mon.spe)) + this.runTries * 30; ok = odds > 255 || randInt(256) < odds; }
    if (ok) { this.sound('flee'); this.msg('Got away safely!', true); this.endBattle('ran'); return; }
    this.msg("Can't escape!", true);
    this.after = () => this.resolveTurnAfterFailedRun();
  }
  resolveTurnAfterFailedRun() {
    // The enemy gets its move.
    const E = this.E;
    this.firstMover = E;
    this.useMove(E, this.enemyChoice());
    this.checkFaints();
    if (!this.over && !this.waitingSwitch) this.endOfTurn();
    this.finishTurnFlow();
  }
  tryRunFromFaint() {
    const E = this.E;
    // no running from the boss, not even between POKéMON
    if (this.boss) { this.msg("Can't escape!", true); this.after = () => this.openParty('forced'); return; }
    this.runTries++;
    const sp = this.party.filter((m) => m.hp > 0).map((m) => m.spe);
    const best = Math.max(...sp, 1);
    let ok = best >= E.mon.spe;
    if (!ok) { const odds = Math.floor((best * 128) / Math.max(1, E.mon.spe)) + this.runTries * 30; ok = odds > 255 || randInt(256) < odds; }
    if (ok) { this.sound('flee'); this.msg('Got away safely!', true); this.endBattle('ran'); return; }
    this.msg("Can't escape!", true);
    this.after = () => this.openParty('forced');
  }

  endBattle(outcome, extra = {}) {
    this.over = true; this.outcome = outcome; Object.assign(this, extra);
    this.push({ type: 'end', outcome });
  }

  // Apply damage and queue the HP drain.
  damage(b, amount) {
    const dealt = Math.min(b.mon.hp, Math.max(0, amount));
    b.mon.hp -= dealt;
    this.hpTo(b, b.mon.hp);
    return dealt;
  }
  heal(b, amount) {
    const h = Math.min(b.mon.maxHp - b.mon.hp, Math.max(0, amount));
    b.mon.hp += h;
    this.hpTo(b, b.mon.hp);
    return h;
  }

  useMove(att, moveId) {
    const def = this.foe(att);
    const aName = this.nameOf(att);
    if (moveId === 'RECHARGE' || att.recharge) { att.recharge = false; this.msg(`${aName} must\nrecharge!`); return; }
    // --- status checks before moving
    if (att.mon.status === 'SLP') {
      att.mon.sleep--;
      if (att.mon.sleep <= 0) { att.mon.status = null; att.mon.sleep = 0; this.msg(`${aName} woke up!`); this.status(att); }
      else { this.msg(`${aName} is fast\nasleep.`); this.push({ type: 'anim', kind: 'self', attDisp: this.dispFor(att), defDisp: this.dispFor(def), move: { type: 'NORMAL' } }); att.charge = null; att.invuln = false; return; }
    }
    if (att.mon.status === 'FRZ') {
      if (chance(0.2)) { att.mon.status = null; this.msg(`${aName} was\ndefrosted!`); this.status(att); }
      else { this.msg(`${aName} is\nfrozen solid!`); return; }
    }
    if (att.flinch) { att.flinch = false; this.msg(`${aName} flinched!`); att.charge = null; att.invuln = false; if (att.hidden) this.push({ type: 'show', disp: this.dispFor(att) }); return; }
    if (att.conf > 0) {
      att.conf--;
      if (att.conf === 0) this.msg(`${aName} snapped out of\nconfusion!`);
      else {
        this.msg(`${aName} is\nconfused!`);
        if (chance(0.5)) {
          const dmg = this.confusionDamage(att);
          this.msg('It hurt itself in its\nconfusion!');
          this.sound('hit'); this.damage(att, dmg);
          att.charge = null; if (att.invuln) { att.invuln = false; this.push({ type: 'show', disp: this.dispFor(att) }); }
          return;
        }
      }
    }
    if (att.mon.status === 'PAR' && chance(0.25)) { this.msg(`${aName} is paralyzed!\nIt can't move!`); att.charge = null; if (att.invuln) { att.invuln = false; this.push({ type: 'show', disp: this.dispFor(att) }); } return; }
    // The boss comes to battle exhausted from the fight in The End: it loses some turns catching its breath (in place
    // of the healing and guarding turns FireRed's MEWTWO spends), so a careful team can wear it down and throw balls
    if (att === this.E && this.boss && !att.charge && chance(BOSS_PANT)) { this.msg(`${aName} is\ncatching its breath!`); return; }

    const mv = move(moveId);
    // PP is paid when the move starts (not on the second turn of a charging move).
    if (moveId !== 'STRUGGLE' && !att.charge) { const slot = att.mon.moves.find((m) => m.id === moveId); if (slot) slot.pp = Math.max(0, slot.pp - 1); }
    if (att.mon.isSteve) { this.msg(steveVerb(moveId, mv)); this.steveUse(moveId); }
    else this.msg(`${aName} used\n${mv.name}!`);

    if (mv.effect === 'RAMPAGE') {
      if (att.charge !== moveId) { att.charge = moveId; att.rampage = range(2, 3); }
      if (--att.rampage <= 0) { att.charge = null; att.rampageDone = true; }
    }
    if (mv.effect === 'SEMI_INVULNERABLE') {
      if (!att.charge) {
        att.charge = moveId; att.invuln = true;
        this.push({ type: 'hide', disp: this.dispFor(att) });
        this.msg(`${aName} flew\nup high!`);
        return;
      }
      att.charge = null; att.invuln = false;
      this.push({ type: 'show', disp: this.dispFor(att) });
    }

    const targetsFoe = mv.target !== 'USER' && !(mv.power === 0 && STAT_EFFECTS[mv.effect] && STAT_EFFECTS[mv.effect][1] > 0) &&
      !['FOCUS_ENERGY', 'DRAGON_DANCE', 'HAZE', 'PROTECT', 'REFLECT', 'MIST'].includes(mv.effect);
    if (targetsFoe && def.protect) { this.msg(`${this.nameOf(def)}\nprotected itself!`); return; }
    if (targetsFoe && def.invuln && !HITS_INVULN.has(moveId)) { this.msg(`${aName}'s\nattack missed!`); this.afterMiss(att, mv); return; }
    if (targetsFoe && !this.accuracyHits(att, def, mv)) { this.msg(`${aName}'s\nattack missed!`); this.afterMiss(att, mv); return; }

    if (mv.power > 0 || ['LEVEL_DAMAGE', 'SONICBOOM', 'DRAGON_RAGE'].includes(mv.effect)) this.damagingMove(att, def, mv, moveId);
    else this.statusMove(att, def, mv, moveId);
  }

  // gear wears out as in Minecraft: one point of durability per hit, an arrow per shot, the TNT itself
  steveUse(moveId) {
    const inv = this.game.inv;
    if (moveId === 'MC_BOW') { inv.spend('arrow', 1); this.set(() => mc('bow', { vol: 0.8 })); return; }
    if (moveId === 'MC_TNT') { inv.spend('tnt', 1); this.set(() => mc('fuse', { vol: 0.8 })); this.push({ type: 'wait', dur: 0.9 }); this.set(() => { mc('explode', { vol: 1 }); this.flash = 0.6; }); return; }
    const w = this.steveWeapon;
    if (w && !inv.infinite && (moveId === 'MC_SWORD' || moveId === 'MC_JUMP')) {
      const s = inv.slots.find((x) => x === w);
      if (s) { s.dmg = (s.dmg || 0) + 1; if (s.dmg >= toolOf(s).dur) { const i = inv.slots.indexOf(s); inv.slots[i] = null; this.set(() => mc('break', { vol: 0.8 })); this.msg(`${ME()}'s ${nameOf(s.id).toUpperCase()}\nbroke!`); } }
    }
  }
  afterMiss(att, mv) {
    if (mv.effect === 'EXPLOSION') { this.damage(att, att.mon.hp); }
    if (mv.effect === 'RAMPAGE') { att.charge = null; att.rampage = 0; att.rampageDone = false; }   // a miss ends the rampage
  }

  accuracyHits(att, def, mv) {
    if (mv.acc === 0 || mv.effect === 'ALWAYS_HIT') return true;
    const st = Math.max(-6, Math.min(6, att.stages.acc - def.stages.eva));
    const [n, d] = ACC[st + 6];
    const calc = Math.floor((mv.acc * n) / d);
    return randInt(100) + 1 <= calc;
  }

  confusionDamage(b) {
    const L = b.mon.level;
    const atk = stageApply(b.mon.atk, b.stages.atk), def = stageApply(b.mon.def, b.stages.def);
    let d = Math.floor(Math.floor((atk * 40 * (Math.floor((2 * L) / 5) + 2)) / Math.max(1, def)) / 50);
    if (b.mon.status === 'BRN') d = Math.floor(d / 2);
    return b.mon.isSteve ? steveTakes(Math.max(1, d) + 2, b.mon, this.game) : Math.max(1, d) + 2;
  }

  // Gen 3 damage: base damage, crit, STAB, type rows one at a time, then the 85-100% roll.
  calcDamage(att, def, mv, moveId, opts = {}) {
    const type = mv.type;
    const rows = typeRows(type, species(def.mon.species).types);
    const eff = rows.reduce((m, r) => m * (r / 10), 1);
    if (mv.effect === 'LEVEL_DAMAGE' || mv.effect === 'SONICBOOM' || mv.effect === 'DRAGON_RAGE') {
      if (eff === 0) return { immune: true };
      const fixed = mv.effect === 'LEVEL_DAMAGE' ? att.mon.level : mv.effect === 'SONICBOOM' ? 20 : 40;
      return { dmg: def.mon.isSteve ? steveTakes(fixed, def.mon, this.game) : fixed, crit: false, eff: 1, fixed: true };
    }
    if (eff === 0) return { immune: true };
    const phys = isPhysical(type);
    const critStage = Math.min(4, (mv.effect === 'HIGH_CRITICAL' ? 1 : 0) + (att.focus ? 2 : 0));
    const crit = randInt(CRIT[critStage]) === 0;
    let aS = phys ? att.stages.atk : att.stages.spa, dS = phys ? def.stages.def : def.stages.spd;
    if (crit) { if (aS < 0) aS = 0; if (dS > 0) dS = 0; }
    let A_ = stageApply(phys ? att.mon.atk : att.mon.spa, aS);
    let D_ = stageApply(phys ? def.mon.def : def.mon.spd, dS);
    if (mv.effect === 'EXPLOSION') D_ = Math.max(1, Math.floor(D_ / 2));
    let power = mv.power;
    if (moveId === 'GUST' && def.invuln) power *= 2;
    let dmg = Math.floor(Math.floor((A_ * power * (Math.floor((2 * att.mon.level) / 5) + 2)) / Math.max(1, D_)) / 50);
    if (phys && att.mon.status === 'BRN') dmg = Math.floor(dmg / 2);
    const side = this.sides[this.sideOf(def)];
    if (phys && side.reflect > 0 && !crit) dmg = Math.floor(dmg / 2);
    if (dmg === 0) dmg = 1;
    dmg += 2;
    if (crit) dmg *= 2;
    const types = species(att.mon.species).types;
    if (type !== 'MYSTERY' && (types[0] === type || types[1] === type)) dmg = Math.floor((dmg * 15) / 10);
    for (const r of rows) dmg = Math.floor((dmg * r) / 10);
    dmg = Math.floor((dmg * (100 - randInt(16))) / 100);
    if (dmg < 1) dmg = 1;
    if (def.mon.isSteve) dmg = steveTakes(dmg, def.mon, this.game);
    return { dmg, crit, eff };
  }

  damagingMove(att, def, mv, moveId) {
    const aD = this.dispFor(att), dD = this.dispFor(def);
    const contact = mv.contact && isPhysical(mv.type);
    let hits = 1;
    if (mv.effect === 'MULTI_HIT') { const r = randInt(8); hits = r < 3 ? 2 : r < 6 ? 3 : r < 7 ? 4 : 5; }
    if (mv.effect === 'DOUBLE_HIT' || mv.effect === 'TWINEEDLE') hits = 2;
    let landed = 0, total = 0, lastEff = 1, immune = false;
    for (let h = 0; h < hits; h++) {
      if (def.mon.hp <= 0) break;
      const r = this.calcDamage(att, def, mv, moveId);
      if (r.immune) { immune = true; break; }
      const anim = { type: 'anim', kind: contact ? 'contact' : 'projectile', attDisp: aD, defDisp: dD, move: mv, damage: true, eff: r.eff };
      this.push(anim);
      const dealt = this.damage(def, r.dmg);
      total += dealt; landed++; lastEff = r.eff;
      if (r.crit) this.msg('A critical hit!');
      if (mv.effect === 'TWINEEDLE' && def.mon.hp > 0 && chance(0.2)) this.inflict(def, 'PSN', false);
    }
    if (immune) { this.msg(`It doesn't affect\n${this.nameOf(def)}…`); return; }
    if (hits > 1) this.msg(`Hit ${landed} time(s)!`);
    if (!['LEVEL_DAMAGE', 'SONICBOOM', 'DRAGON_RAGE'].includes(mv.effect)) {
      if (lastEff > 1) this.msg("It's super effective!");
      else if (lastEff < 1) this.msg("It's not very effective…");
    }
    // --- after-damage effects
    const eff = mv.effect;
    if (eff === 'ABSORB' && total > 0) { this.heal(att, Math.max(1, Math.floor(total / 2))); this.msg(`${this.nameOf(def)} had its\nenergy drained!`); }
    if ((eff === 'RECOIL' || eff === 'DOUBLE_EDGE') && total > 0 && att.mon.hp > 0) {
      const rec = Math.max(1, Math.floor(total / (eff === 'DOUBLE_EDGE' ? 3 : 4)));
      this.damage(att, rec); this.msg(`${this.nameOf(att)} is hit\nwith recoil!`);
    }
    if (eff === 'EXPLOSION') this.damage(att, att.mon.hp);
    if (eff === 'RECHARGE') att.recharge = true;
    if (eff === 'RAMPAGE' && att.rampageDone) {
      att.rampageDone = false;
      if (att.mon.hp > 0 && att.conf === 0) { att.conf = range(2, 5) + 1; this.push({ type: 'statanim', disp: this.dispFor(att), up: false }); this.msg(`${this.nameOf(att)} became\nconfused due to fatigue!`); }
    }
    if (def.mon.hp <= 0) return;
    if (eff === 'FREEZE_HIT' && def.mon.status === 'FRZ') return;
    if (def.mon.status === 'FRZ' && mv.type === 'FIRE') { def.mon.status = null; this.msg(`${this.nameOf(def)} was\ndefrosted!`); this.status(def); }
    const ch = mv.chance || 0;
    if (HIT_STATUS[eff] && ch && chance(ch / 100)) this.inflict(def, HIT_STATUS[eff], false);
    if (eff === 'TRI_ATTACK' && chance(0.2)) this.inflict(def, ['PAR', 'BRN', 'FRZ'][randInt(3)], false);
    if (eff === 'CONFUSE_HIT' && ch && chance(ch / 100)) this.confuse(def, false);
    if ((eff === 'FLINCH_HIT' || eff === 'FLINCH_MINIMIZE_HIT') && ch && chance(ch / 100) && this.firstMover === att) def.flinch = true;
    if (HIT_STAT[eff] && chance((ch || 100) / 100)) {
      const [st, d, who] = HIT_STAT[eff];
      this.statChange(who === 'att' ? att : def, st, d, false, who !== 'att');
    }
    if (eff === 'ALL_STATS_UP_HIT' && ch && chance(ch / 100)) for (const s of ['atk', 'def', 'spe', 'spa', 'spd']) this.statChange(att, s, 1, false, false);
    if (eff === 'TRAP' && def.trap === 0) { def.trap = range(2, 5); def.trapName = mv.name; this.msg(`${this.nameOf(def)} was trapped!`); }
  }

  statusMove(att, def, mv, moveId) {
    const eff = mv.effect;
    const aD = this.dispFor(att), dD = this.dispFor(def);
    const onFoe = !(STAT_EFFECTS[eff] && STAT_EFFECTS[eff][1] > 0) && !['FOCUS_ENERGY', 'DRAGON_DANCE', 'HAZE', 'PROTECT', 'REFLECT', 'MIST'].includes(eff);
    this.push({ type: 'anim', kind: onFoe ? 'projectile' : 'self', attDisp: aD, defDisp: dD, move: mv, damage: false });
    if (STAT_EFFECTS[eff]) { const [st, d] = STAT_EFFECTS[eff]; this.statChange(d > 0 ? att : def, st, d, true, d < 0); return; }
    switch (eff) {
      case 'SLEEP': this.inflict(def, 'SLP', true); return;
      case 'POISON': case 'TOXIC': this.inflict(def, 'PSN', true); return;
      case 'PARALYZE':
        if (mv.type === 'ELECTRIC' && typeRows('ELECTRIC', species(def.mon.species).types).includes(0)) { this.msg(`It doesn't affect\n${this.nameOf(def)}…`); return; }
        this.inflict(def, 'PAR', true); return;
      case 'CONFUSE': this.confuse(def, true); return;
      case 'ROAR': {
        // Gen 3 in a wild battle (TryDoForceSwitchOut): the target leaves and the battle ends, always when the user's
        // level is at least the target's, else unless a level roll fails. The ENDER DRAGON's battle can't end so.
        const L = att.mon.level, T = def.mon.level;
        if (this.boss || (L < T && Math.floor((randInt(256) * (L + T)) / 256) + 1 <= Math.floor(T / 4))) { this.msg('But it failed!'); return; }
        this.push({ type: 'withdraw', disp: dD });
        this.endBattle('ran');
        return;
      }
      case 'DRAGON_DANCE': this.statChange(att, 'atk', 1, true, false); this.statChange(att, 'spe', 1, true, false); return;
      case 'FOCUS_ENERGY':
        if (att.focus) { this.msg('But it failed!'); return; }
        att.focus = true; this.msg(`${this.nameOf(att)} is getting\npumped!`); return;
      case 'HAZE':
        for (const b of [this.P, this.E]) for (const k in b.stages) b.stages[k] = 0;
        this.msg('All stat changes were\neliminated!'); return;
      case 'PROTECT': {
        const ok = randInt(1 << Math.min(att.protectChain, 3)) === 0 && this.firstMover === att;
        if (ok) { att.protect = true; att.protectChain++; this.msg(`${this.nameOf(att)} protected\nitself!`); }
        else { att.protectChain = 0; this.msg('But it failed!'); }
        return;
      }
      case 'REFLECT': {
        const s = this.sides[this.sideOf(att)];
        if (s.reflect > 0) { this.msg('But it failed!'); return; }
        s.reflect = 5; this.msg(`${this.nameOf(att)}'s REFLECT\nraised DEFENSE!`); return;
      }
      case 'MIST': {
        const s = this.sides[this.sideOf(att)];
        if (s.mist > 0) { this.msg('But it failed!'); return; }
        s.mist = 5; this.msg(`${this.nameOf(att)}'s party is\nshrouded in MIST!`); return;
      }
    }
    this.msg('But nothing happened!');
  }

  inflict(b, st, primary) {
    const name = this.nameOf(b);
    const types = species(b.mon.species).types;
    if (b.mon.status) {
      if (!primary) return;
      const already = { SLP: `${name} is\nalready asleep!`, PSN: `${name} is already\npoisoned.`, BRN: `${name} already\nhas a burn.`, PAR: `${name} is\nalready paralyzed!` };
      this.msg(b.mon.status === st && already[st] ? already[st] : 'But it failed!');
      return;
    }
    if ((st === 'PSN' && (types.includes('POISON') || types.includes('STEEL'))) || (st === 'BRN' && types.includes('FIRE')) || (st === 'FRZ' && types.includes('ICE'))) {
      if (primary) this.msg(`It doesn't affect\n${name}…`);
      return;
    }
    const side = this.sides[this.sideOf(b)];
    b.mon.status = st;
    if (st === 'SLP') b.mon.sleep = range(2, 5);
    this.status(b);
    this.push({ type: 'statanim', disp: this.dispFor(b), up: false });
    this.msg({
      SLP: `${name}\nfell asleep!`, PSN: `${name}\nwas poisoned!`, BRN: `${name} was burned!`, FRZ: `${name} was\nfrozen solid!`,
      PAR: `${name} is paralyzed!\nIt may be unable to move!`,
    }[st]);
    if (st === 'SLP' && b.charge) { b.charge = null; if (b.invuln) { b.invuln = false; this.push({ type: 'show', disp: this.dispFor(b) }); } }
    void side;
  }

  confuse(b, primary) {
    const name = this.nameOf(b);
    if (b.conf > 0) { if (primary) this.msg(`${name} is\nalready confused!`); return; }
    b.conf = range(2, 5) + 1;
    this.push({ type: 'statanim', disp: this.dispFor(b), up: false });
    this.msg(`${name} became\nconfused!`);
  }

  statChange(b, st, delta, primary, byFoe) {
    const name = this.nameOf(b);
    if (byFoe && delta < 0 && this.sides[this.sideOf(b)].mist > 0) { if (primary) this.msg(`${name} is protected\nby MIST!`); return; }
    const cur = b.stages[st];
    if ((delta > 0 && cur >= 6) || (delta < 0 && cur <= -6)) {
      if (primary) this.msg(`${name}'s ${STAT_NAME[st]}\nwon't go ${delta > 0 ? 'higher' : 'lower'}!`);
      return;
    }
    b.stages[st] = Math.max(-6, Math.min(6, cur + delta));
    this.push({ type: 'statanim', disp: this.dispFor(b), up: delta > 0 });
    const how = delta > 0 ? (delta > 1 ? 'sharply rose!' : 'rose!') : (delta < -1 ? 'harshly fell!' : 'fell!');
    this.msg(`${name}'s ${STAT_NAME[st]}\n${how}`);
  }

  endOfTurn() {
    const order = this.speedOf(this.P) >= this.speedOf(this.E) ? [this.P, this.E] : [this.E, this.P];
    for (const b of order) {
      if (b.mon.hp <= 0) continue;
      const name = this.nameOf(b);
      if (b.mon.status === 'PSN' || b.mon.status === 'BRN') {
        const d = Math.max(1, Math.floor(b.mon.maxHp / 8));
        this.msg(b.mon.status === 'PSN' ? `${name} is hurt\nby poison!` : `${name} is hurt\nby its burn!`);
        this.push({ type: 'statanim', disp: this.dispFor(b), up: false });
        this.damage(b, d);
        if (this.checkFaints()) return;
      }
      if (b.trap > 0 && b.mon.hp > 0) {
        b.trap--;
        if (b.trap === 0) this.msg(`${name} was freed\nfrom ${b.trapName}!`);
        else {
          this.msg(`${name} is hurt\nby ${b.trapName}!`);
          this.damage(b, Math.max(1, Math.floor(b.mon.maxHp / 16)));
          if (this.checkFaints()) return;
        }
      }
    }
    for (const s of Object.values(this.sides)) { if (s.mist > 0) s.mist--; if (s.reflect > 0) s.reflect--; }
  }

  checkFaints() {
    let any = false;
    if (this.E.mon.hp <= 0 && !this.E.fainted) {
      this.E.fainted = true; any = true;
      this.push({ type: 'faint', disp: this.de });
      this.push({ type: 'hbslide', disp: this.de, out: true });
      this.msg(`Wild ${this.E.mon.name}\nfainted!`, true);
      this.giveExp();
      this.push({ type: 'music', name: 'victory' });
      // FireRed pays nothing for wild wins; here a little, so battles help fund the Mart
      const prize = this.E.mon.level * 4;
      this.set(() => { this.game.money = Math.min(999999, (this.game.money || 0) + prize); });
      this.msg(`${ME()} got ¥${prize}\nfor winning!`, true);
      this.endBattle('win');
    }
    if (this.P.mon.hp <= 0 && !this.P.fainted && this.P.mon.isSteve) {
      this.P.fainted = true; any = true;
      this.push({ type: 'faint', disp: this.dp });
      this.push({ type: 'hbslide', disp: this.dp, out: true });
      this.msg(`${ME()} was slain by\n${this.E.mon.name}`, true);
      this.endBattle('dead');
      return any;
    }
    if (this.P.mon.hp <= 0 && !this.P.fainted) {
      this.P.fainted = true; any = true;
      this.P.charge = null; this.P.invuln = false;
      this.push({ type: 'faint', disp: this.dp });
      this.push({ type: 'hbslide', disp: this.dp, out: true });
      this.msg(`${this.P.mon.name}\nfainted!`, true);
      if (!this.over) {
        if (this.party.some((m) => m.hp > 0)) this.waitingSwitch = true;
        else {
          this.msg(`${ME()} is out of\nusable POKéMON!`, true);
          this.msg(`${ME()} whited out!`, true);
          this.endBattle('whiteout');
        }
      }
    }
    return any;
  }

  giveExp() {
    const E = this.E.mon;
    const base = Math.floor((species(E.species).expYield * E.level) / 7);
    if (this.participants.has(this.steve.uid)) this.xpGained += Math.max(1, Math.floor(base / 3));
    const parts = this.party.filter((m) => !m.isSteve && this.participants.has(m.uid) && m.hp > 0);
    if (!parts.length) return;
    const each = Math.max(1, Math.floor(base / parts.length));
    for (const m of parts) {
      if (m.level >= 100) continue;
      const active = m === this.P.mon;
      this.msg(`${m.name} gained\n${each} EXP. Points!`, true);
      m.exp += each;
      const g = species(m.species).growth;
      while (m.level < 100 && m.exp >= expFor(g, m.level + 1)) {
        if (active) this.push({ type: 'exp', disp: this.dp, to: 1 });
        m.level++;
        const oldMax = m.maxHp;
        recalc(m);
        const lvl = m.level, hp = m.hp, max = m.maxHp;
        if (active) this.set(() => { this.dp.level = lvl; this.dp.maxHp = max; this.dp.hp = hp; this.dp.exp = 0; });
        this.sound('levelUp');
        this.msg(`${m.name} grew to\nLV. ${m.level}!`, true);
        // New level-up move, if there is room for it.
        const learned = species(m.species).learnset.filter(([lv, id]) => lv === m.level && !m.moves.some((x) => x.id === id));
        for (const [, id] of learned) {
          if (m.moves.length < 4) { m.moves.push({ id, pp: move(id).pp, maxPp: move(id).pp }); this.msg(`${m.name} learned\n${move(id).name}!`, true); }
          // FireRed's delete-a-move prompt, for the ENDER DRAGON (whose level 70 set is full before OUTRAGE at 78). Kanto
          // POKéMON keep this game's earlier rule (a full set learns nothing), so Kanto battles and the film scripts
          // play exactly as before.
          else if (m.species === 'ENDER_DRAGON') this.learnPrompt(m, id);
        }
        void oldMax;
      }
      if (active) this.push({ type: 'exp', disp: this.dp, to: this.expFrac(m) });
    }
  }

  // FireRed's prompt when a POKéMON with four moves reaches a new one: delete a move to make room for it, or stop
  // learning it (the 'learn' event in stepEvent, drawn by drawLearn)
  learnPrompt(m, id) {
    this.msg(`${m.name} is trying to\nlearn ${move(id).name}.`, true);
    this.msg(`But, ${m.name} can't learn\nmore than four moves.`, true);
    this.push({ type: 'learn', mon: m, id, stage: 'ask', yes: 0, cursor: 0 });
  }
  stepLearn(e, input) {
    const mon = e.mon, nm = move(e.id).name;
    // the A that closed the message before it doesn't answer the question too
    if (!e.armed) { e.armed = true; return false; }
    if (e.stage === 'ask' || e.stage === 'stop') {
      if (input.just('up') || input.just('down')) { e.yes ^= 1; sfx.move(); }
      if (!input.just('a') && !input.just('b')) return false;
      const yes = input.just('a') && e.yes === 0;
      if (input.just('a')) sfx.select(); else sfx.cancel();
      if (e.stage === 'ask') { if (yes) { e.stage = 'pick'; e.cursor = 0; } else { e.stage = 'stop'; e.yes = 0; } return false; }
      if (yes) { this.q.unshift({ type: 'msg', text: `${mon.name} did not learn\n${nm}.`, press: true }); return true; }
      e.stage = 'ask'; e.yes = 0; return false;
    }
    // which move to forget
    const n = mon.moves.length, c = e.cursor;
    if (input.just('left') && c % 2 === 1) { e.cursor--; sfx.move(); }
    if (input.just('right') && c % 2 === 0 && c + 1 < n) { e.cursor++; sfx.move(); }
    if (input.just('up') && c >= 2) { e.cursor -= 2; sfx.move(); }
    if (input.just('down') && c + 2 < n) { e.cursor += 2; sfx.move(); }
    if (input.just('b')) { sfx.cancel(); e.stage = 'stop'; e.yes = 0; return false; }
    if (!input.just('a')) return false;
    sfx.select();
    const old = move(mon.moves[e.cursor].id).name;
    mon.moves[e.cursor] = { id: e.id, pp: move(e.id).pp, maxPp: move(e.id).pp };
    this.q.unshift({ type: 'msg', text: '1, 2, and... ... ... Poof!', press: true }, { type: 'msg', text: `${mon.name} forgot\n${old}.`, press: true },
      { type: 'msg', text: 'And...', press: true }, { type: 'msg', text: `${mon.name} learned\n${nm}!`, press: true });
    return true;
  }
  drawLearn(ctx, e, y) {
    const mon = e.mon, nm = move(e.id).name;
    if (e.stage === 'pick') {
      ctx.drawImage(A.img.tbMoves, 0, y);
      for (let i = 0; i < 4; i++) {
        const m = mon.moves[i], ox = 16 + (i % 2) * 72, oy = y + 9 + Math.floor(i / 2) * 16;
        drawText(ctx, m ? move(m.id).name : '-', ox, oy, MENU_FG, MENU_SH, 'small');
        if (i === e.cursor) cursorArrow(ctx, ox - 9, oy + 4, MENU_FG);
      }
      drawText(ctx, 'FORGET', 168, y + 10, MENU_FG, MENU_SH, 'small');
      drawText(ctx, 'B: KEEP ALL', 168, y + 26, MENU_FG, MENU_SH, 'small');
      return;
    }
    ctx.drawImage(A.img.tbMsg, 0, y);
    const lines = e.stage === 'ask' ? ['Delete a move to make', `room for ${nm}?`] : ['Stop learning', `${nm}?`];
    lines.forEach((l, i) => drawText(ctx, l, 10, y + 10 + i * 16, TEXT_WHITE, TEXT_SHADOW));
    const bx = 168, by = 64;
    ctx.fillStyle = '#586878'; ctx.fillRect(bx, by, 64, 44);
    ctx.fillStyle = '#f8f8f8'; ctx.fillRect(bx + 2, by + 2, 60, 40);
    drawText(ctx, 'YES', bx + 18, by + 5, MENU_FG, MENU_SH);
    drawText(ctx, 'NO', bx + 18, by + 21, MENU_FG, MENU_SH);
    cursorArrow(ctx, bx + 8, by + 8 + e.yes * 16, MENU_FG);
  }

  throwBall(itemKey) {
    const def = item(itemKey);
    const it = { ...def.ball, ball: def.ball.kind, name: def.name.toUpperCase() };
    this.game.inv.spend(itemKey, 1);
    const E = this.E.mon;
    this.msg(`${ME()} threw a\n${it.name}!`);
    const steveThrows = this.P.mon.isSteve;
    const sp = species(E.species);
    let odds = Math.floor((sp.catchRate * it.mult) / 10);
    odds = Math.floor((odds * (E.maxHp * 3 - E.hp * 2)) / (E.maxHp * 3));
    if (E.status === 'SLP' || E.status === 'FRZ') odds *= 2;
    else if (E.status) odds = Math.floor((odds * 15) / 10);
    let shakes;
    if (odds > 254) shakes = 4;
    else {
      const b = Math.floor(1048560 / Math.floor(Math.sqrt(Math.floor(Math.sqrt(Math.floor(16711680 / Math.max(1, odds)))))));
      for (shakes = 0; shakes < 4 && randInt(65536) < b; shakes++);
    }
    const caught = shakes === 4;
    if (steveThrows) this.set(() => { this.dp.pose = 'throw'; });
    this.push({ type: 'ballthrow', ball: it.ball, shakes: caught ? 3 : shakes, caught });
    if (steveThrows) this.set(() => { this.dp.pose = 'idle'; });
    if (caught) {
      this.set(() => music.play('caught', { loop: false }));
      this.msg(`Gotcha!\n${E.name} was caught!`, true);
      const firstCatch = !this.game.dex.caught.has(E.species);
      E.ball = it.ball;
      const where = this.party.length < 6 ? 'party' : 'pc';
      this.set(() => this.game.addCaught(E));
      if (firstCatch) this.msg(`${E.name}'s data was\nadded to the POKéDEX.`, true);
      if (where === 'pc') this.msg(`${E.name} was transferred\nto someone's PC.`, true);
      this.endBattle('caught', { caughtMon: E });
    } else {
      this.msg(['Oh, no!\nThe POKéMON broke free!', 'Aww!\nIt appeared to be caught!', 'Aargh!\nAlmost had it!', 'Shoot!\nIt was so close, too!'][shakes]);
    }
  }

  // ---------------------------------------------------------------- drawing
  draw(ctx) {
    if (this.ui === 'party' && this.party_ui) { this.party_ui.draw(ctx); return; }
    if (this.ui === 'bag') { drawBattleBag(ctx, this.bagItems(), this.bagCursor); return; }
    const t = this.t;
    // FireRed's terrain: the upper half (the foe's platform) slides in from the left, the lower from the right
    const slideE = Math.round(-this.de.slide * 240), slideP = Math.round(this.dp.slide * 240);
    const bg = A.img['bg_' + this.terrain] || A.img.bg_grass;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, VW, VH);
    ctx.drawImage(bg, 0, 0);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, VW, 80); ctx.clip();
    ctx.drawImage(bg, slideE, 0); if (slideE) ctx.drawImage(bg, slideE + (slideE < 0 ? VW : -VW), 0);
    ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(0, 80, VW, 32); ctx.clip();
    ctx.drawImage(bg, slideP, 0); if (slideP) ctx.drawImage(bg, slideP + (slideP < 0 ? VW : -VW), 0);
    ctx.restore();
    void t;
    this.drawEnemy(ctx, slideE);
    this.drawPlayer(ctx, slideP);
    for (const p of this.fx) {
      ctx.fillStyle = p.color; ctx.globalAlpha = Math.min(1, p.life * 3);
      if (p.star) { ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y), 3, 1); ctx.fillRect(Math.round(p.x), Math.round(p.y) - 1, 1, 3); }
      else ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
    if (this.cur && this.cur.type === 'ballthrow' && this.cur.pos) this.drawBall(ctx, this.cur.pos, this.cur.ball);
    if (this.cur && this.cur.type === 'sendout' && this.cur.ball) this.drawBall(ctx, this.cur.ball, 'poke');

    this.drawHealthboxEnemy(ctx);
    this.drawHealthboxPlayer(ctx);
    this.drawTextbox(ctx);
    if (this.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${Math.min(1, this.flash * 2)})`; ctx.fillRect(0, 0, VW, VH); }
  }

  drawMonSprite(ctx, d, img, x, y) {
    if (!d.visible || d.hidden) return;
    if (d.blink) return;
    let w = 64, h = 64;
    const s = d.scale;
    if (s !== 1) {
      const sw = Math.max(1, Math.round(w * s)), sh = Math.max(1, Math.round(h * s));
      ctx.drawImage(img, Math.round(x + (w - sw) / 2), Math.round(y + (h - sh)), sw, sh);
      if (d.white > 0) { ctx.globalAlpha = d.white; ctx.drawImage(tinted(img, d.tint || '#fff'), Math.round(x + (w - sw) / 2), Math.round(y + (h - sh)), sw, sh); ctx.globalAlpha = 1; }
      return;
    }
    ctx.drawImage(img, Math.round(x), Math.round(y));
    if (d.dark > 0) { ctx.globalAlpha = d.dark * 0.75; ctx.drawImage(tinted(img, '#202838'), Math.round(x), Math.round(y)); ctx.globalAlpha = 1; }
    if (d.white > 0) { ctx.globalAlpha = Math.min(1, d.white); ctx.drawImage(tinted(img, d.tint || '#fff'), Math.round(x), Math.round(y)); ctx.globalAlpha = 1; }
  }

  drawEnemy(ctx, slide) {
    const d = this.de; if (!d.species) return;
    const sp = species(d.species);
    const img = d.shiny ? A.mon[d.species].frontShiny : A.mon[d.species].front;
    const elev = sp.elevation;
    const bob = elev > 0 && !this.over ? Math.round(Math.sin(this.t * 2.2) * 1.2) : 0;
    const x = 176 - 32 + slide + d.offX, y = 40 - 32 + sp.front.y - elev + d.offY + bob;
    if (elev > 0 && d.visible && !d.hidden) ctx.drawImage(A.img.enemyShadow, 176 - 16 + slide, 40 + 29 - 4);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, VW, 80 + (d.offY > 0 ? 0 : 32)); ctx.clip();
    this.drawMonSprite(ctx, d, img, x, y);
    ctx.restore();
  }
  drawPlayer(ctx, slide) {
    const d = this.dp; if (!d.species) return;
    if (d.species === 'STEVE') { this.drawSteve(ctx, slide); return; }
    const sp = species(d.species);
    const img = d.shiny ? A.mon[d.species].backShiny : A.mon[d.species].back;
    const x = 72 - 32 + slide + d.offX, y = 80 - 32 + sp.back.y + d.offY;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, VW, 112); ctx.clip();
    this.drawMonSprite(ctx, d, img, x, y);
    ctx.restore();
  }
  drawSteve(ctx, slide) {
    const d = this.dp;
    if (!d.visible || d.blink) return;
    const poses = A.items.back.frames;
    const f = Math.max(0, poses.indexOf(d.pose || 'idle'));
    const x = 72 - 32 + slide + d.offX - 8, y = 112 - 64 + d.offY;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, VW, 112); ctx.clip();
    // the weapon in his right hand, drawn before him when it is held low
    const w = this.game.inv && steveWeapon(this.game.inv);
    const [hx, hy] = A.items.back.hands[f];
    const drawWeapon = () => {
      if (!w && d.pose !== 'throw') return;
      ctx.save();
      ctx.translate(Math.round(x + hx), Math.round(y + hy));
      const ang = { idle: -0.2, raise: -0.9, strike: 0.9, throw: 0 }[d.pose || 'idle'];
      ctx.rotate(ang);
      if (d.pose === 'throw') { const b = A.img.ballPoke; ctx.drawImage(b, 0, 0, 16, 16, -8, -12, 16, 16); }
      else if (bladeSided(w.id)) ctx.drawImage(bladeForwardIcon(w.id), -5, -27, 32, 32);
      else drawIcon(ctx, w.id, -5, -27, 32);
      ctx.restore();
    };
    if ((d.pose || 'idle') === 'idle') drawWeapon();
    ctx.drawImage(A.mc.back, f * 64, 0, 64, 64, Math.round(x), Math.round(y), 64, 64);
    if (d.redT > 0) { ctx.globalAlpha = Math.min(1, d.redT * 2) * 0.6; ctx.drawImage(tinted(steveBackFrame(f), '#ff2020'), Math.round(x), Math.round(y)); ctx.globalAlpha = 1; }
    if ((d.pose || 'idle') !== 'idle') drawWeapon();
    ctx.restore();
  }
  drawBall(ctx, b, kind) {
    const frames = { poke: 'ballPoke', great: 'ballGreat', ultra: 'ballUltra' };
    const img = A.img[frames[kind] || 'ballPoke'];
    ctx.save();
    ctx.translate(Math.round(b.x), Math.round(b.y));
    if (b.rot) ctx.rotate(b.rot);
    if (b.dim) ctx.globalAlpha = 0.85;
    ctx.drawImage(img, 0, (b.frame || 0) * 16, 16, 16, -8, -8, 16, 16);
    ctx.restore();
  }

  // Health bar sprite: "HP" label + six 8px bar tiles, placed by its subsprite table right under the name row.
  drawBar(ctx, x, y, hp, max, statused) {
    const tiles = A.img.barTiles;
    const px = hp <= 0 ? 0 : Math.max(1, Math.ceil((hp / max) * 48));
    const base = px > 24 ? 3 : px > 9 ? 47 : 56;
    // on the opponent's box a status condition swaps the "HP" label for the bar's plain left end
    if (statused) ctx.drawImage(tiles, 65 * 8, 0, 8, 8, x - 8, y, 8, 8);
    else ctx.drawImage(tiles, 8, 0, 16, 8, x - 16, y, 16, 8);
    for (let i = 0; i < 6; i++) {
      const lvl = Math.max(0, Math.min(8, px - i * 8));
      ctx.drawImage(tiles, (base + lvl) * 8, 0, 8, 8, x + i * 8, y, 8, 8);
    }
  }
  drawStatus(ctx, status, x, y, side) {
    const col = { PSN: 0, PAR: 1, SLP: 2, FRZ: 3, BRN: 4 }[status];
    if (col == null) return;
    ctx.drawImage(A.img.statusHb, col * 24, side === 'enemy' ? 8 : 0, 24, 8, x, y, 24, 8);
  }
  // FireRed prints the nickname and level into text windows that overwrite the box's tiles
  // (src/battle_interface.c): rows 5-15 of each window are copied, filled with the box colour.
  // The small "Lv" symbol is the one baked into the box graphic, which those windows cover.
  drawNameAndLevel(ctx, d, bx, by, nameX, nameW, lvX) {
    const box = A.battleColors.box;
    const fg = box[1], sh = box[3];
    ctx.fillStyle = `rgb(${box[2].join(',')})`;
    ctx.fillRect(bx + nameX, by + 5, nameW, 11);
    ctx.fillRect(bx + lvX, by + 5, 24, 11);
    const lv = String(d.level);
    // a long name may run into the blank left of a one- or two-digit level (ENDER DRAGON keeps a 3 px space)
    drawFit(ctx, d.name, bx + nameX, by + 3, nameW + Math.max(0, 5 * (3 - lv.length) - 3), fg, sh, 'small');
    const x = bx + lvX + 5 * (3 - lv.length);
    ctx.drawImage(A.img.hbOpp, 56, 10, 8, 6, x, by + 9, 8, 6); // the "Lv" symbol: 7px glyph + shadow column
    drawText(ctx, lv, x + 8, by + 3, fg, sh, 'small');
  }

  drawHealthboxEnemy(ctx) {
    const d = this.de; if (!d.species) return;
    const ox = Math.round(-d.hb * 130);
    const bx = 12 + ox, by = 14;
    ctx.drawImage(A.img.hbOpp, bx, by);
    this.drawNameAndLevel(ctx, d, bx, by, 8, 56, 64);
    // SpriteCB_HealthBar: the opponent's bar sits 8px in from its box's centre, the player's 16px
    this.drawBar(ctx, bx + 40, by + 16, Math.round(d.hp), d.maxHp, !!d.status);
    if (d.status) this.drawStatus(ctx, d.status, bx + 8, by + 16, 'enemy');
    // caught before: a ball on the bar's third subsprite (32px left of its centre), hidden by a status icon
    else if (this.game.dex.caught.has(d.species)) ctx.drawImage(A.img.barTiles, 70 * 8, 0, 8, 8, bx + 8, by + 16, 8, 8);
  }
  drawHealthboxPlayer(ctx) {
    const d = this.dp; if (!d.species) return;
    const ox = Math.round(d.hb * 130);
    const bx = 126 + ox, by = 72;
    ctx.drawImage(A.img.hbPlayer, bx, by);
    this.drawNameAndLevel(ctx, d, bx, by, 16, 56, 72);
    if (d.species === 'STEVE') { this.drawSteveBox(ctx, d, bx, by); return; }
    // HP text, as UpdateHpTextInHealthbox does it in the English release: "cur/" printed 4px into a
    // 24px window at box x 56 and the max into a 16px window at x 80, both at window y 5 with rows
    // 5-15 copied into the box from y 16 (so the window hides the box's own slash).
    const box = A.battleColors.box;
    const fg = box[1], sh = box[3];
    const pad3 = (v) => String(v).padStart(3, ' ');
    ctx.save();
    ctx.beginPath(); ctx.rect(bx + 56, by + 21, 40, 11); ctx.clip();
    ctx.fillStyle = `rgb(${box[2].join(',')})`;
    ctx.fillRect(bx + 56, by + 21, 40, 11);
    drawText(ctx, pad3(Math.ceil(d.hp)) + '/', bx + 60, by + 21, fg, sh, 'small');
    drawText(ctx, pad3(d.maxHp), bx + 80, by + 21, fg, sh, 'small');
    ctx.restore();
    this.drawBar(ctx, bx + 48, by + 16, Math.round(d.hp), d.maxHp, false); // singles keep the HP label
    // EXP bar: 8 tiles at box (32, 32), the first four in the main sprite, the rest in the second
    const epx = Math.round(Math.max(0, Math.min(1, d.exp)) * 64);
    for (let i = 0; i < 8; i++) {
      const lvl = Math.max(0, Math.min(8, epx - i * 8));
      ctx.drawImage(A.img.barTiles, (12 + lvl) * 8, 0, 8, 8, bx + 32 + i * 8, by + 32, 8, 8);
    }
    if (d.status) this.drawStatus(ctx, d.status, bx + 16, by + 24, 'player');
  }

  // Steve's box: Minecraft hearts where the HP bar goes (drawn in drawHi at full resolution), his
  // health under them, and his experience progress in the EXP bar.
  drawSteveBox(ctx, d, bx, by) {
    const box = A.battleColors.box;
    ctx.fillStyle = `rgb(${box[2].join(',')})`;
    ctx.fillRect(bx + 30, by + 16, 70, 8);
    const fg = box[1], sh = box[3];
    ctx.save(); ctx.beginPath(); ctx.rect(bx + 56, by + 21, 40, 11); ctx.clip();
    ctx.fillRect(bx + 56, by + 21, 40, 11);
    drawText(ctx, `${String(Math.ceil(d.hp)).padStart(3, ' ')}/`, bx + 60, by + 21, fg, sh, 'small');
    drawText(ctx, ' 20', bx + 80, by + 21, fg, sh, 'small');
    ctx.restore();
    const P = this.game.P;
    const epx = Math.round(Math.max(0, Math.min(1, P.xpProgress / xpForLevel(P.level))) * 64);
    for (let i = 0; i < 8; i++) {
      const lvl = Math.max(0, Math.min(8, epx - i * 8));
      ctx.drawImage(A.img.barTiles, (12 + lvl) * 8, 0, 8, 8, bx + 32 + i * 8, by + 32, 8, 8);
    }
    this._steveBox = { bx, by, hp: d.hp };
  }
  drawHi(ctx) {
    const b = this._steveBox;
    if (!b || !this.dp.species || this.dp.species !== 'STEVE' || this.ui === 'party' || this.ui === 'bag') { this._steveBox = null; return; }
    const hp = Math.ceil(b.hp);
    const x0 = (b.bx + 31) * 2, y0 = (b.by + 15) * 2 + 1;
    for (let i = 0; i < 10; i++) {
      const x = x0 + i * 8;
      ctx.drawImage(A.mc.gui_heart_container, x, y0);
      if (hp >= i * 2 + 2) ctx.drawImage(A.mc.gui_heart_full, x, y0);
      else if (hp === i * 2 + 1) ctx.drawImage(A.mc.gui_heart_half, x, y0);
    }
    this._steveBox = null;
  }
  // The FIGHT menu's text, fitted to its boxes: a move name in its column (a long weapon name such as NETHERITE
  // SWORD gets its first word cut short: NETHER. SWORD), Steve's DUR count beside its label (small
  // digits, then the count alone, when 2031/2031 would run into DUR), and the player's own name as the type
  // (TYPE/STEVE in single-player). Text that fits is drawn exactly as before. Also a test hook (ok: all fit).
  movesLayout() {
    const moves = this.P.mon.moves, W = (t, f = 'small') => textWidth(t, f);
    const names = [], cols = [64, 64];   // (the left column ends where the right column's cursor starts)
    for (let i = 0; i < 4; i++) names.push(moves[i] ? fitLabel(moves[i].label || move(moves[i].id).name, cols[i % 2]) : '-');
    const m = moves[this.moveCursor];
    const out = { names, unit: '', pp: '', ppFont: 'normal', type: '', ok: true };
    out.ok = names.every((n, i) => W(n) <= cols[i % 2]);
    if (m && this.P.mon.isSteve) {
      out.unit = m.unit || 'DUR';
      const room = 232 - (168 + W(out.unit) + 3);
      out.pp = m.maxPp ? `${m.pp}/${m.maxPp}` : m.pp >= 0 ? String(m.pp) : '--';
      if (W(out.pp, 'normal') > room) { out.ppFont = 'small'; if (W(out.pp) > room) out.pp = String(m.pp); }
      const who = ME().toUpperCase(), skin = GAME.mySkin && GAME.mySkin !== 'steve' ? GAME.mySkin.toUpperCase() : 'STEVE';
      out.type = W('TYPE/' + who) <= 64 ? 'TYPE/' + who : W('TYPE/' + skin) <= 64 ? 'TYPE/' + skin : fitLabel('TYPE/' + who, 64);
      out.ok = out.ok && W(out.pp, out.ppFont) <= room && W(out.type) <= 64;
    }
    return out;
  }
  drawTextbox(ctx) {
    const y = 112;
    if (this.cur && this.cur.type === 'learn') { this.drawLearn(ctx, this.cur, y); return; }
    const showMenu = !this.cur && !this.q.length && (this.ui === 'action' || this.ui === 'moves' || this.ui === 'yesno');
    if (showMenu && this.ui === 'action') {
      ctx.drawImage(A.img.tbAction, 0, y);
      drawText(ctx, 'What will', 10, y + 10, TEXT_WHITE, TEXT_SHADOW);
      drawText(ctx, `${this.P.mon.name} do?`, 10, y + 26, TEXT_WHITE, TEXT_SHADOW);
      const opts = ['FIGHT', 'BAG', 'POKéMON', 'RUN'];
      opts.forEach((o, i) => {
        const ox = 136 + (i % 2) * 56, oy = y + 10 + Math.floor(i / 2) * 16;
        drawText(ctx, o, ox, oy, MENU_FG, MENU_SH);
        if (i === this.menu) cursorArrow(ctx, ox - 9, oy + 3, MENU_FG);
      });
      return;
    }
    if (showMenu && this.ui === 'moves') {
      ctx.drawImage(A.img.tbMoves, 0, y);
      const moves = this.P.mon.moves;
      const L = this.movesLayout();
      for (let i = 0; i < 4; i++) {
        const ox = 16 + (i % 2) * 72, oy = y + 9 + Math.floor(i / 2) * 16;
        drawText(ctx, L.names[i], ox, oy, MENU_FG, MENU_SH, 'small');
        if (i === this.moveCursor) cursorArrow(ctx, ox - 9, oy + 4, MENU_FG);
      }
      const m = moves[this.moveCursor];
      if (m && this.P.mon.isSteve) {
        drawText(ctx, L.unit, 168, y + 10, MENU_FG, MENU_SH, 'small');
        drawText(ctx, L.pp, 232 - textWidth(L.pp, L.ppFont), y + 10 + (L.ppFont === 'small' ? 1 : 0), m.pp === 0 ? '#e03020' : MENU_FG, MENU_SH, L.ppFont);
        drawText(ctx, L.type, 168, y + 26, MENU_FG, MENU_SH, 'small');
      } else if (m) {
        const low = m.pp === 0 ? '#e03020' : m.pp <= m.maxPp / 4 ? '#e07020' : m.pp <= m.maxPp / 2 ? '#c8a000' : MENU_FG;
        drawText(ctx, 'PP', 168, y + 10, MENU_FG, MENU_SH, 'small');
        const pp = `${m.pp}/${m.maxPp}`;
        drawText(ctx, pp, 232 - textWidth(pp), y + 10, low, MENU_SH);
        drawText(ctx, 'TYPE/' + (move(m.id).type === 'MYSTERY' ? '???' : move(m.id).type), 168, y + 26, MENU_FG, MENU_SH, 'small');
      }
      return;
    }
    ctx.drawImage(A.img.tbMsg, 0, y);
    const e = this.cur && this.cur.type === 'msg' ? this.cur : this.lastMsg && !this.finished ? this.lastMsg : null;
    if (e && e.pages) {
      const page = e.pages[this.cur ? e.page : e.pages.length - 1];
      let left = this.cur ? e.shown : 1e9;
      page.forEach((l, i) => { drawText(ctx, l.slice(0, Math.max(0, Math.floor(left))), 10, y + 10 + i * 16, TEXT_WHITE, TEXT_SHADOW); left -= l.length; });
      const total = page.reduce((n, l) => n + l.length, 0);
      if (this.cur && e.shown >= total && (e.press || e.page < e.pages.length - 1)) moreArrow(ctx, 224, y + 34, this.t);
    }
    if (this.ui === 'yesno' && !this.cur && !this.q.length) {
      ctx.fillStyle = '#f8f8f8';
      const bx = 168, by = 64;
      // YES/NO window in the battle style: white box with dark frame
      ctx.fillStyle = '#586878'; ctx.fillRect(bx, by, 64, 44);
      ctx.fillStyle = '#f8f8f8'; ctx.fillRect(bx + 2, by + 2, 60, 40);
      drawText(ctx, 'YES', bx + 18, by + 5, MENU_FG, MENU_SH);
      drawText(ctx, 'NO', bx + 18, by + 21, MENU_FG, MENU_SH);
      cursorArrow(ctx, bx + 8, by + 8 + this.yesno * 16, MENU_FG);
    }
  }
}

function P_reset(b) { b.flinch = false; b.protect = false; }

// Names for UI outside the battle.
export function typeLabel(t) { return t === 'MYSTERY' ? '???' : t; }
export { movesAt };


// a label in a box maxW pixels wide (small font): as it is when it fits, else its first word cut short with a
// full stop (NETHERITE SWORD: NETHER. SWORD), else cut at the end
function fitLabel(text, maxW) {
  const W = (t) => textWidth(t, 'small');
  if (W(text) <= maxW) return text;
  const words = text.split(' ');
  if (words.length > 1) {
    const rest = ' ' + words.slice(1).join(' ');
    for (let n = words[0].length - 1; n >= 3; n--) { const t = words[0].slice(0, n) + '.' + rest; if (W(t) <= maxW) return t; }
  }
  let t = text;
  while (t.length > 1 && W(t) > maxW) t = t.slice(0, -1);
  return t;
}

// ---------------------------------------------------------------- Steve as a battler
export function steveLevel(P) { return Math.max(8, Math.min(100, 8 + P.level * 2)); }
export function steveWeapon(inv) {
  const held = inv.held, t = toolOf(held);
  if (t && (t.kind === 'sword' || t.kind === 'axe')) return held;
  let best = null, bd = 0;
  for (const s of inv.slots) { const tt = toolOf(s); if (tt && (tt.kind === 'sword' || tt.kind === 'axe') && tt.dmg > bd) { bd = tt.dmg; best = s; } }
  return best;
}
export function steveMon(game) {
  const P = game.P, L = steveLevel(P);
  // Steve fights like a sturdy Pokémon of his level: base 80 HP, Attack and Defense
  const st = (b) => Math.floor(((2 * b + 15) * L) / 100) + 5;
  const vMax = Math.floor(((2 * 80 + 15) * L) / 100) + L + 10;
  return { uid: -1, isSteve: true, species: 'STEVE', name: game.myName || 'STEVE', level: L, exp: 0, ivs: [15, 15, 15, 15, 15, 15],
    hp: P.health, maxHp: 20, vMax, atk: st(80), def: st(80), spa: st(50), spd: st(50), spe: st(60),
    moves: steveMoves(game), status: null, sleep: 0, toxic: 0, shiny: false };
}
// Steve's four moves, read off his inventory each time FIGHT is opened.
export function steveMoves(game) {
  const inv = game.inv, out = [];
  const w = steveWeapon(inv), t = toolOf(w);
  if (w) {
    const left = t.dur - (w.dmg || 0);
    out.push({ id: 'MC_SWORD', label: nameOf(w.id).toUpperCase(), pp: left, maxPp: t.dur, power: t.dmg * 12, weapon: w, unit: 'DUR' });
    out.push({ id: 'MC_JUMP', label: 'JUMP ATTACK', pp: left, maxPp: t.dur, power: t.dmg * 15, weapon: w, unit: 'DUR' });
  } else out.push({ id: 'MC_PUNCH', label: 'PUNCH', pp: -1, maxPp: 0, power: 15, unit: '' });
  if (inv.has('bow') && inv.count('arrow') > 0) out.push({ id: 'MC_BOW', label: 'BOW', pp: inv.count('arrow'), maxPp: 0, power: 60, unit: 'ARROWS' });
  if (inv.has('tnt') && inv.has('flint_and_steel')) out.push({ id: 'MC_TNT', label: 'TNT', pp: inv.count('tnt'), maxPp: 0, power: 130, unit: 'TNT' });
  // punch never runs out
  for (const m of out) if (m.pp < 0) m.pp = 99;
  return out.slice(0, 4);
}
// Register the chosen move's numbers with the engine's move table before the turn resolves.
export function prepareSteveMove(m) {
  const base = { MC_SWORD: { effect: 'HIT', acc: 100, contact: true }, MC_JUMP: { effect: 'HIGH_CRITICAL', acc: 85, contact: true },
    MC_PUNCH: { effect: 'HIT', acc: 100, contact: true }, MC_BOW: { effect: 'HIT', acc: 95, contact: false }, MC_TNT: { effect: 'RECOIL', acc: 90, contact: false } }[m.id];
  A.dex.moves[m.id] = { name: m.label, type: 'MYSTERY', power: m.power, pp: 99, chance: 0, priority: 0, target: 'SELECTED', ...base };
}
function steveVerb(id, mv) {
  if (id === 'MC_BOW') return `${ME()} fired an\nARROW!`;
  if (id === 'MC_TNT') return `${ME()} lit the TNT!`;
  if (id === 'MC_JUMP') return `${ME()} jumped and\nswung!`;
  if (id === 'MC_PUNCH') return `${ME()} punched!`;
  return `${ME()} swung ${HIS()}\n${mv.name}!`;
}
// Damage from a Pokémon lands on Steve's 20 health: scaled from the size he'd be as a Pokémon of his
// level, then cut by his armor the way Minecraft cuts it, in half-heart steps.
export function steveTakes(dmg, mon, game) {
  let d = (dmg * 20) / Math.max(1, mon.vMax);
  const def = game.inv.armorPoints(), tough = game.inv.armorToughness();
  if (def > 0) d = d * (1 - Math.min(20, Math.max(def / 5, def - d / (2 + tough / 4))) / 25);
  return Math.max(0.5, Math.round(d * 2) / 2);
}
export function syncSteve(game, battle) {
  const s = battle.steve;
  game.P.health = Math.max(0, Math.min(20, s.hp));
  if (battle.caughtMon) void 0;
}

// ---------------------------------------------------------------- the bag in battle: Minecraft items
function bagFrom(inv) {
  const counts = new Map();
  for (const s of inv.slots) if (s) counts.set(s.id, (counts.get(s.id) || 0) + s.n);
  const out = [];
  for (const [id, n] of counts) {
    const it = item(id);
    if (it.ball || it.food || it.med) out.push({ key: id, name: (it.frName || it.name).toUpperCase(), count: n, ball: !!it.ball, food: it.food, med: it.med, desc: it.desc });
  }
  out.sort((a, b) => (!!b.med - !!a.med) || (b.ball - a.ball) || a.name.localeCompare(b.name));
  return out;
}
// FireRed medicine on a POKéMON, or on Steve (his hearts scale like the damage he takes)
function medEffect(key, mon) {
  const fx = item(key).med, name = mon.isSteve ? ME() : mon.name;
  if (fx.revive) {
    if (mon.isSteve || mon.hp > 0) return null;
    const hp = Math.floor(mon.maxHp / 2);
    return { kind: 'med', hp, status: null, text: `${name}'s HP was restored\nby ${hp} point(s).` };
  }
  if (mon.hp <= 0) return null;
  let want = fx.hp === 'full' ? mon.maxHp : fx.hp || 0;
  if (mon.isSteve && fx.hp && fx.hp !== 'full') want = Math.max(1, Math.round((fx.hp * 20 / Math.max(1, mon.vMax)) * 2) / 2);
  const healed = Math.min(mon.maxHp - mon.hp, want);
  const cures = fx.cure === 'all' ? ['PSN', 'PAR', 'SLP', 'BRN', 'FRZ'] : fx.cure ? [fx.cure] : [];
  const cured = mon.status && cures.includes(mon.status) ? mon.status : null;
  if (healed <= 0 && !cured) return null;
  const T = { PSN: `${name} was cured of its\npoisoning.`, PAR: `${name} was cured of\nparalysis.`, SLP: `${name} woke up.`, BRN: `${name}'s burn was healed.`, FRZ: `${name} was thawed out.` };
  const text = healed > 0 ? (mon.isSteve ? `${ME()} recovered\n${healed / 2} heart(s)!` : `${name}'s HP was restored\nby ${healed} point(s).`) : T[cured];
  return { kind: 'med', hp: mon.hp + healed, status: cured ? null : mon.status, text };
}
function itemEffect(key, mon) {
  if (item(key).med) return medEffect(key, mon);
  const fd = foodOf({ id: key });
  if (!fd) return null;
  if (mon.isSteve) {
    if (mon.hp >= mon.maxHp && !fd.regen) return null;
    const h = Math.min(mon.maxHp - mon.hp, Math.max(1, fd.hunger) + (fd.regen ? 4 : 0));
    return { kind: 'heal', amount: h, text: `${ME()} recovered\n${h / 2} heart(s)!` };
  }
  if (mon.hp <= 0 || mon.hp >= mon.maxHp) return null;
  const amt = Math.min(Math.max(5, fd.hunger * 5), mon.maxHp - mon.hp);
  return { kind: 'heal', amount: amt, text: `${mon.name}'s HP was restored\nby ${amt} point(s).` };
}
function applyItem(key, mon, res, game) {
  if (res.kind === 'med') { mon.hp = res.hp; mon.status = res.status; if (!res.status) { mon.sleep = 0; mon.toxic = 0; } if (mon.isSteve && game.P) game.P.health = mon.hp; return; }
  mon.hp = Math.min(mon.maxHp, mon.hp + res.amount);
  if (mon.isSteve) {
    const fd = foodOf({ id: key });
    const P = game.P;
    P.food = Math.min(20, P.food + fd.hunger); P.sat = Math.min(P.food, P.sat + fd.sat);
  }
}
function drawBattleBag(ctx, entries, cursor) {
  ctx.fillStyle = '#f8e0a0'; ctx.fillRect(0, 0, VW, VH);
  ctx.fillStyle = '#e8c070'; for (let y = 0; y < VH; y += 4) ctx.fillRect(0, y, VW, 1);
  drawWindow(ctx, 4, 4, 80, 28);
  drawText(ctx, 'BAG', 14, 10, FG, SH);
  const rows = [...entries.map((e) => ({ label: e.name.length > 13 ? e.name.slice(0, 13) : e.name, right: '×' + String(e.count).padStart(2, ' ') })), { label: 'CLOSE BAG' }];
  const visible = 6;
  const top = Math.max(0, Math.min(cursor - visible + 1, rows.length - visible));
  drawList(ctx, 88, 4, 148, rows.slice(top, top + visible), cursor - top);
  const cur = entries[cursor];
  drawWindow(ctx, 0, VH - 48, VW, 48);
  const desc = !cur ? 'Close the BAG.' : cur.med ? cur.desc.replace(/\n/g, ' ') : cur.ball ? `A ball ${ME()} crafted from iron and redstone. Throw it at a wild POKéMON.` : `Eat it, or share it with a POKéMON. Restores ${cur.food.hunger} food.`;
  wrap(desc, VW - 24).slice(0, 2).forEach((l, i) => drawText(ctx, l, 12, VH - 40 + i * 16, FG, SH));
  if (cur) drawIcon(ctx, cur.key, 4 + 8, 40, 16);
}
const backFrames = new Map();
let backFramesOf = null;   // the sheet they were cut from (a co-op guest's A.mc.back is its own skin's)
function steveBackFrame(f) {
  if (backFramesOf !== A.mc.back) { backFrames.clear(); backFramesOf = A.mc.back; }
  if (!backFrames.has(f)) { const c = document.createElement('canvas'); c.width = 64; c.height = 64; c.getContext('2d').drawImage(A.mc.back, f * 64, 0, 64, 64, 0, 0, 64, 64); backFrames.set(f, c); }
  return backFrames.get(f);
}
// An axe or hoe icon mirrored across its handle line, texel (x, y) from (15 - y, 15 - x), so the blade
// faces the foe instead of trailing back toward Steve (see bladeSided).
const bladeIcons = new Map();
function bladeForwardIcon(id) {
  if (bladeIcons.has(id)) return bladeIcons.get(id);
  const i = item(id).iconIndex;
  const src = document.createElement('canvas'); src.width = 16; src.height = 16;
  src.getContext('2d').drawImage(A.mc.icons, (i % 32) * 16, Math.floor(i / 32) * 16, 16, 16, 0, 0, 16, 16);
  const a = src.getContext('2d').getImageData(0, 0, 16, 16);
  const c = document.createElement('canvas'); c.width = 16; c.height = 16;
  const g = c.getContext('2d'), b = g.createImageData(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const o = (y * 16 + x) * 4, s = ((15 - x) * 16 + (15 - y)) * 4;
    for (let k = 0; k < 4; k++) b.data[o + k] = a.data[s + k];
  }
  g.putImageData(b, 0, 0);
  bladeIcons.set(id, c);
  return c;
}
