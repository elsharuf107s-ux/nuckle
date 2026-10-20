// The garage screen: pick a part for each slot, tune and paint it, and watch the mech rebuild on
// the showroom turntable (the game canvas itself). Panels are plain DOM floating over the canvas.
//
// Hovering an option previews its effect on the stat bars (a white marker and a +/- delta)
// without equipping it; clicking equips it. The build is saved to localStorage on every change.
// Two bars carry a limit marker: LOAD (weight vs the legs' limit) and POWER (draw vs the torso's output).

import {
  DEFAULT_BUILD, ENERGY, PAINTS, PARTS, THRUSTERS, TUNING, TUNING_MAX, TUNING_POOL,
  cleanName, deriveStats, partOf, randomBuild, sanitizeBuild, statRanges, tuningSpent,
} from './parts.js';

const STORE_KEY = 'steel-vanguard.build';

/** Saved build, or the default if there is none / it is unreadable (storage can be unavailable). */
export function loadBuild() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return sanitizeBuild(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeBuild(null);
  }
}

export function saveBuild(build) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(build));
  } catch {
    // ignore: the build just will not persist
  }
}

/** One-line summary for the title screen. */
export function describeBuild(build) {
  return `${build.name} · ${partOf('weapon', build.weapon).name} · ${partOf('offhand', build.offhand).name}`;
}

const TABS = [
  ['head', 'HEAD'], ['torso', 'TORSO'], ['arms', 'ARMS'], ['legs', 'LEGS'],
  ['shoulder', 'SHOULDER'], ['backpack', 'PACK'], ['core', 'CORE'], ['pilot', 'PILOT'],
  ['weapon', 'WEAPON'], ['offhand', 'OFF-HAND'], ['sub', 'SUB-WPN'], ['tuning', 'TUNING'],
  ['paint', 'PAINT'],
];

/**
 * Stat rows shown on the right. `better` says which direction is an improvement. Rows with a `limit`
 * draw a marker on the bar and turn red when the value goes past it; `scale` sets their bar range.
 */
const ROWS = [
  { id: 'hp', label: 'ARMOR', get: (s) => s.hp, text: (s) => String(Math.round(s.hp)), better: 1 },
  { id: 'speed', label: 'SPEED', get: (s) => s.speed, text: (s) => s.speed.toFixed(1), better: 1 },
  { id: 'en', label: 'BOOST FUEL', get: (s) => s.en, text: (s) => String(Math.round(s.en)), better: 1 },
  { id: 'dps', label: 'FIREPOWER', get: (s) => s.dps, text: (s) => String(s.dps), better: 1 },
  { id: 'melee', label: 'MELEE', get: (s) => s.melee * s.damage, text: (s) => `×${(s.melee * s.damage).toFixed(2)}`, better: 1 },
  { id: 'missiles', label: 'MISSILES', get: (s) => s.missileCharges * s.missileDamage * s.damage,
    text: (s) => `${s.missileCharges} × ${Math.round(150 * s.missileDamage * s.damage)}`, better: 1 },
  { id: 'weight', label: 'LOAD', get: (s) => s.weight, text: (s) => `${s.weight} / ${s.load}`, better: -1,
    limit: (s) => s.load, scale: (r) => Math.max(r.weight.max, r.load.max) },
  { id: 'draw', label: 'POWER', get: (s) => s.draw, text: (s) => `${s.draw} / ${s.supply}`, better: -1,
    limit: (s) => s.supply, scale: (r) => Math.max(r.draw.max, r.supply.max) },
];

const el = (tag, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

// ------------------------------------------------------------------ chips describing a part

/** [label, +1 if a bigger number is good / -1 if bad, formatter] */
const ADD_LABELS = {
  hp: ['ARMOR', 1], en: ['BOOST FUEL', 1], enGround: ['EN REGEN', 1], enAir: ['AIR EN REGEN', 1],
  ascendSpeed: ['CLIMB', 1], dashSpeed: ['DASH SPEED', 1], dashCost: ['DASH COST', -1], turn: ['TURNING', 1],
  staggerAt: ['STAGGER RESIST', 1], missileCharges: ['MISSILES', 1], missileTurn: ['HOMING', 1],
  supply: ['POWER OUTPUT', 1], load: ['LOAD LIMIT', 1], regen: ['REPAIR /s', 1], burstTime: ['BURST TIME', 1, (v) => `+${v}s`],
  dashInvuln: ['DASH INVULN', 1, (v) => `+${v}s`], radar: ['RADAR', 1], resupplyHeal: ['WAVE REPAIR', 1, (v) => `+${Math.round(v * 100)}%`],
  jam: ['MISSILE JAMMING', 1, (v) => `${Math.round(v * 100)}%`], barrier: ['BARRIER', 1],
};
const MUL_LABELS = {
  mobility: 'SPEED', dash: 'DASH', melee: 'MELEE', fireRate: 'FIRE RATE', reload: 'RELOAD SPEED',
  gunDamage: 'GUN DAMAGE', missileDamage: 'MISSILE DMG', burstGain: 'BURST GAIN',
};

function chipsFor(slot, part) {
  const chips = [];
  const sign = (v) => (v > 0 ? `+${v}` : String(v));
  if (part.add?.weight !== undefined) chips.push([`WEIGHT ${part.add.weight}`, '']);
  if (part.add?.draw) chips.push([`POWER DRAW ${part.add.draw}`, '']);
  for (const [k, v] of Object.entries(part.add ?? {})) {
    const info = ADD_LABELS[k];
    if (!info) continue;
    const shown = info[2] ? info[2](v) : sign(v);
    chips.push([`${info[0]} ${shown}`, v * info[1] > 0 ? 'up' : 'down']);
  }
  for (const [k, v] of Object.entries(part.mul ?? {})) {
    if (MUL_LABELS[k]) chips.push([`${MUL_LABELS[k]} ×${v}`, v > 1 ? 'up' : 'down']);
  }
  if (part.guard) chips.push([`${Math.round(part.guard * 100)}% ${slot === 'weapon' ? 'DEFLECT' : 'GUARD'}`, 'up']);
  if (slot === 'weapon' && part.weapon.kind !== 'melee') {
    const w = part.weapon;
    chips.push([w.pellets ? `DMG ${w.damage} ×${w.pellets}` : `DMG ${w.damage}`, '']);
    chips.push([`MAG ${w.mag}`, '']);
    chips.push([`${(1 / w.cooldown).toFixed(1)}/s`, '']);
    if (w.splash) chips.push(['BLAST', 'up']);
    if (w.pellets) chips.push(['SHORT RANGE', 'down'], ['SPREAD', '']);
    if (w.homing) chips.push(['HOMING', 'up']);
    if (w.pierce) chips.push(['PIERCES', 'up']);
  }
  if (slot === 'weapon' && part.weapon.kind === 'melee' && part.weapon.reach) chips.push([`REACH ${part.weapon.reach}`, 'up']);
  if (slot === 'offhand' && part.ability) {
    const a = part.ability;
    chips.push([a.kind === 'swarm' ? `F: ${a.count} × ${a.damage} DMG · ${a.cooldown}s` : `F: ${a.damage} DMG · ${a.cooldown}s`, 'up']);
    if (a.kind === 'swarm') chips.push(['HOMING', 'up']);
  }
  if (slot === 'sub' && part.sub) {
    const u = part.sub;
    if (u.kind === 'vulcan') chips.push([`DMG ${u.damage}`, ''], [`${(1 / u.interval).toFixed(0)}/s`, ''], ['SHOOTS DOWN MISSILES', 'up']);
    else if (u.kind === 'flare') chips.push([`RECHARGE ${u.cooldown}s`, ''], ['DECOYS MISSILES', 'up']);
    else if (u.kind === 'injector') chips.push([`RECHARGE ${u.cooldown}s`, ''], ['REFILLS BOOST', 'up']);
    else if (u.kind === 'pulse') chips.push([`RECHARGE ${u.cooldown}s`, ''], [`DMG ${u.damage}`, ''], ['STAGGERS', 'up']);
    else if (u.kind === 'field') chips.push([`RECHARGE ${u.cooldown}s`, ''], [`${u.duration}s INVULNERABLE`, 'up']);
    else chips.push([`HEAL ${Math.round(u.heal * 100)}%`, 'up'], [`${u.charges} USE / WAVE`, '']);
  }
  return chips;
}

// ------------------------------------------------------------------ the screen

export class Garage {
  /**
   * @param game   the Game (provides setBuild, enterGarage/exitGarage, garagePose)
   * @param hooks  { onBack(), onSortie(), onChange(build) }
   */
  constructor(game, hooks) {
    this.game = game;
    this.hooks = hooks;
    this.root = document.getElementById('screen-garage');
    this.tabsEl = document.getElementById('g-tabs');
    this.optionsEl = document.getElementById('g-options');
    this.statsEl = document.getElementById('g-stats');
    this.summaryEl = document.getElementById('g-summary');
    this.nameEl = document.getElementById('g-name');
    this.build = loadBuild();
    this.pit = false; // true while the screen is the pit stop between waves
    this.tab = 'head';
    this._statRefs = null;
    this._paintRaf = 0;

    this._buildTabs();
    this._buildStats();
    this._wire();
  }

  // ------------------------------------------------------------------ open / close

  open() {
    this._setPit(null);
    this.game.enterGarage();
    this.root.classList.remove('hidden');
    this._showStats(false);
    this.nameEl.value = this.build.name;
    this._setPose('idle');
    this._renderOptions();
    this._renderStats();
  }

  /**
   * The pit stop between waves: the same garage, over the same turntable, but there is no way back to the
   * title: the only exit launches the next wave. The game has already moved to its 'intermission' state.
   */
  openPit(info) {
    this._setPit(info);
    this.root.classList.remove('hidden');
    this.nameEl.value = this.build.name;
    this._setPose('idle');
    this._showStats(false);
    this._renderOptions();
    this._renderStats();
  }

  closePit() {
    this.root.classList.add('hidden');
    this._setPit(null);
  }

  /** Switch the pit card, the exit button and the screen's styling between garage and pit-stop mode. */
  _setPit(info) {
    this.pit = !!info;
    this.root.classList.toggle('pit', this.pit);
    const card = document.getElementById('g-pit');
    card.classList.toggle('hidden', !this.pit);
    const go = document.getElementById('g-go');
    go.textContent = info?.next ? `LAUNCH WAVE ${info.next.number}` : 'SORTIE';
    if (!info) return;
    const set = (id, text) => { document.getElementById(id).textContent = text; };
    set('p-cleared', `WAVE ${info.cleared} OF ${info.total} CLEARED`);
    const next = document.getElementById('p-next');
    next.classList.toggle('boss', !!info.next?.boss);
    next.textContent = info.next ? `NEXT: WAVE ${info.next.number}  ·  ${info.next.title}${info.next.boss ? '  ·  BOSS' : ''}` : '';
    set('p-hostiles', info.next ? info.next.hostiles.map((h) => `${h.count} × ${h.name}`).join('  ·  ') : '');
    const status = document.getElementById('p-status');
    status.classList.toggle('low', info.armor < 40);
    status.textContent = `ARMOR ${info.armor}%  ·  SCORE ${info.score.toLocaleString('en-US')}  ·  ${info.kills} KILLS`;
  }

  _showStats(on) {
    this.root.classList.toggle('show-stats', on);
    document.getElementById('g-stats-toggle').textContent = on ? 'PARTS' : 'STATS';
  }

  close() {
    this.root.classList.add('hidden');
    this.game.exitGarage();
  }

  // ------------------------------------------------------------------ build changes

  /** Equip a whole new build: rebuild the model, save, refresh the panels. */
  commit(build) {
    this.build = sanitizeBuild(build);
    this.game.setBuild(this.build);
    saveBuild(this.build);
    this.hooks.onChange?.(this.build);
    this.nameEl.value = this.build.name;
    this._refreshSelection();
    this._renderStats();
  }

  _select(slot, id) {
    if (this.build[slot] !== id) this.commit({ ...this.build, [slot]: id });
  }

  // ------------------------------------------------------------------ wiring

  _wire() {
    document.getElementById('g-back').addEventListener('click', () => this.hooks.onBack());
    // narrow screens have room for one panel at a time: this swaps the parts list and the stat bars
    document.getElementById('g-stats-toggle').addEventListener('click', () => this._showStats(!this.root.classList.contains('show-stats')));
    document.getElementById('g-go').addEventListener('click', () => this.hooks.onSortie());
    document.getElementById('g-random').addEventListener('click', () => this.commit(randomBuild()));
    document.getElementById('g-reset').addEventListener('click', () => this.commit({
      ...DEFAULT_BUILD, paint: { ...DEFAULT_BUILD.paint }, tuning: { ...DEFAULT_BUILD.tuning },
    }));

    const rename = () => {
      const name = cleanName(this.nameEl.value);
      this.nameEl.value = name;
      if (name !== this.build.name) this.commit({ ...this.build, name });
    };
    this.nameEl.addEventListener('change', rename);
    this.nameEl.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not trigger game keys
      if (e.key === 'Enter') this.nameEl.blur();
    });

    for (const btn of this.root.querySelectorAll('.pose')) {
      btn.addEventListener('click', () => this._setPose(btn.dataset.pose));
    }
  }

  _setPose(pose) {
    this.game.garagePose = pose;
    for (const btn of this.root.querySelectorAll('.pose')) btn.classList.toggle('active', btn.dataset.pose === pose);
  }

  // ------------------------------------------------------------------ tabs and options

  _buildTabs() {
    for (const [id, label] of TABS) {
      const b = el('button', 'g-tab', label);
      b.type = 'button';
      b.dataset.tab = id;
      b.addEventListener('click', () => {
        this.tab = id;
        this._renderOptions();
        this._renderStats();
      });
      this.tabsEl.append(b);
    }
  }

  _renderOptions() {
    for (const b of this.tabsEl.children) b.classList.toggle('active', b.dataset.tab === this.tab);
    this.optionsEl.textContent = '';
    this.optionsEl.scrollTop = 0;
    if (this.tab === 'paint') {
      this._renderPaint();
      return;
    }
    if (this.tab === 'tuning') {
      this._renderTuning();
      return;
    }
    for (const part of PARTS[this.tab]) {
      const card = el('button', 'opt');
      card.type = 'button';
      card.dataset.id = part.id;
      const name = el('div', 'o-name');
      name.append(el('span', '', part.name), el('i', 'o-tag'));
      card.append(name, el('div', 'o-desc', part.desc));
      const chips = el('div', 'o-chips');
      for (const [text, kind] of chipsFor(this.tab, part)) chips.append(el('span', `chip ${kind}`, text));
      if (chips.children.length) card.append(chips);

      const slot = this.tab;
      card.addEventListener('click', () => this._select(slot, part.id));
      const preview = () => this._renderStats({ ...this.build, [slot]: part.id });
      card.addEventListener('mouseenter', preview);
      card.addEventListener('focus', preview);
      card.addEventListener('mouseleave', () => this._renderStats());
      card.addEventListener('blur', () => this._renderStats());
      this.optionsEl.append(card);
    }
    this._refreshSelection();
  }

  _refreshSelection() {
    if (this.tab === 'paint') {
      this._syncPaint();
      return;
    }
    if (this.tab === 'tuning') {
      this._syncTuning();
      return;
    }
    for (const card of this.optionsEl.querySelectorAll('.opt')) {
      const on = card.dataset.id === this.build[this.tab];
      card.classList.toggle('selected', on);
      card.querySelector('.o-tag').textContent = on ? 'EQUIPPED' : '';
    }
  }

  // ------------------------------------------------------------------ tuning tab

  _renderTuning() {
    const wrap = this.optionsEl;
    const intro = el('div', 'paint-section');
    intro.append(el('h4', '', 'TUNING POINTS'));
    this._tuneLeft = el('div', 'tune-left');
    intro.append(this._tuneLeft, el('div', 'o-desc', `Spend up to ${TUNING_POOL} points, at most ${TUNING_MAX} on one dial. Points are free bonuses on top of your parts.`));
    wrap.append(intro);

    this._tuneRows = {};
    for (const dial of TUNING) {
      const row = el('div', 'tune-row');
      const head = el('div', 'tune-head');
      head.append(el('span', 'tune-name', dial.name));
      const controls = el('div', 'tune-controls');
      const minus = el('button', 'tune-btn', '−');
      const plus = el('button', 'tune-btn', '+');
      minus.type = plus.type = 'button';
      minus.dataset.dial = plus.dataset.dial = dial.id;
      minus.dataset.dir = '-1';
      plus.dataset.dir = '1';
      const pips = el('div', 'tune-pips');
      for (let i = 0; i < TUNING_MAX; i++) pips.append(el('i'));
      controls.append(minus, pips, plus);
      head.append(controls);
      row.append(head, el('div', 'o-desc', dial.effect));
      minus.addEventListener('click', () => this._tune(dial.id, -1));
      plus.addEventListener('click', () => this._tune(dial.id, 1));
      this._tuneRows[dial.id] = { pips, minus, plus };
      wrap.append(row);
    }
    this._syncTuning();
  }

  _tune(id, dir) {
    const t = { ...this.build.tuning };
    t[id] += dir;
    this.commit({ ...this.build, tuning: t }); // sanitising enforces the per-dial cap and the pool
  }

  _syncTuning() {
    if (!this._tuneRows || this.tab !== 'tuning') return;
    const spent = tuningSpent(this.build.tuning);
    this._tuneLeft.textContent = `${TUNING_POOL - spent} OF ${TUNING_POOL} POINTS LEFT`;
    for (const dial of TUNING) {
      const v = this.build.tuning[dial.id];
      const ref = this._tuneRows[dial.id];
      [...ref.pips.children].forEach((p, i) => p.classList.toggle('on', i < v));
      ref.minus.disabled = v <= 0;
      ref.plus.disabled = v >= TUNING_MAX || spent >= TUNING_POOL;
    }
  }

  // ------------------------------------------------------------------ paint tab

  _renderPaint() {
    const wrap = this.optionsEl;

    const presets = el('div', 'paint-section');
    presets.append(el('h4', '', 'PAINT SCHEMES'));
    const grid = el('div', 'presets');
    for (const p of PAINTS) {
      const b = el('button', 'preset');
      b.type = 'button';
      const sw = el('div', 'sw');
      for (const k of ['main', 'sub', 'accent', 'trim']) {
        const i = el('i');
        i.style.background = p[k];
        sw.append(i);
      }
      b.append(sw, document.createTextNode(p.name));
      b.addEventListener('click', () => this.commit({ ...this.build, paint: { main: p.main, sub: p.sub, accent: p.accent, trim: p.trim } }));
      grid.append(b);
    }
    presets.append(grid);

    const colors = el('div', 'paint-section');
    colors.append(el('h4', '', 'CUSTOM COLOURS'));
    const cgrid = el('div', 'colors');
    this._colorInputs = {};
    for (const [key, label] of [['main', 'ARMOUR'], ['sub', 'FRAME'], ['accent', 'ACCENT'], ['trim', 'TRIM']]) {
      const row = el('label', '', label);
      const input = el('input');
      input.type = 'color';
      input.value = this.build.paint[key];
      input.addEventListener('input', () => {
        // colour pickers fire continuously while dragging: apply at most once per frame
        cancelAnimationFrame(this._paintRaf);
        this._paintRaf = requestAnimationFrame(() => this.commit({ ...this.build, paint: { ...this.build.paint, [key]: input.value } }));
      });
      this._colorInputs[key] = input;
      row.append(input);
      cgrid.append(row);
    }
    colors.append(cgrid);

    const energy = el('div', 'paint-section');
    energy.append(el('h4', '', 'ENERGY COLOUR  (BEAMS · SABER · EYES)'));
    const eRow = el('div', 'swatches');
    this._energySw = {};
    for (const [id, e] of Object.entries(ENERGY)) {
      const b = el('button', 'swatch');
      b.type = 'button';
      b.title = e.name;
      b.style.background = e.css;
      b.addEventListener('click', () => this.commit({ ...this.build, energy: id }));
      this._energySw[id] = b;
      eRow.append(b);
    }
    energy.append(eRow);

    const thr = el('div', 'paint-section');
    thr.append(el('h4', '', 'THRUSTER COLOUR'));
    const tRow = el('div', 'swatches');
    this._thrusterSw = {};
    for (const [id, t] of Object.entries(THRUSTERS)) {
      const b = el('button', 'swatch');
      b.type = 'button';
      b.title = t.name;
      b.style.background = t.css;
      b.addEventListener('click', () => this.commit({ ...this.build, thruster: id }));
      this._thrusterSw[id] = b;
      tRow.append(b);
    }
    thr.append(tRow);

    wrap.append(presets, colors, energy, thr);
    this._syncPaint();
  }

  _syncPaint() {
    if (!this._energySw || this.tab !== 'paint') return;
    for (const [k, input] of Object.entries(this._colorInputs)) {
      if (document.activeElement !== input) input.value = this.build.paint[k];
    }
    for (const [id, b] of Object.entries(this._energySw)) b.classList.toggle('selected', id === this.build.energy);
    for (const [id, b] of Object.entries(this._thrusterSw)) b.classList.toggle('selected', id === this.build.thruster);
  }

  // ------------------------------------------------------------------ stat bars

  _buildStats() {
    this._statRefs = {};
    for (const row of ROWS) {
      const box = el('div', 'stat');
      const head = el('div', 's-head');
      const value = el('b');
      const delta = el('span', 'd');
      value.append(document.createTextNode(''), delta);
      head.append(el('span', '', row.label), value);
      const bar = el('div', 's-bar');
      const fill = el('i');
      const mark = el('u');
      const lim = el('b', 'lim');
      bar.append(fill, mark, lim);
      box.append(head, bar);
      this.statsEl.append(box);
      this._statRefs[row.id] = { value, delta, fill, mark, lim };
    }
  }

  /** `preview` is a hypothetical build: shown as a marker and +/- deltas against the equipped one. */
  _renderStats(preview = null) {
    const ranges = statRanges();
    const cur = deriveStats(this.build);
    const pre = preview ? deriveStats(sanitizeBuild(preview)) : null;
    const shown = pre ?? cur;
    for (const row of ROWS) {
      const ref = this._statRefs[row.id];
      const scale = row.scale ? row.scale(ranges) : null;
      const norm = (v) => {
        if (scale) return Math.min(1, Math.max(0.02, v / scale));
        const r = ranges[row.id];
        return Math.min(1, Math.max(0.03, (v - r.min) / (r.max - r.min || 1)));
      };
      ref.value.firstChild.textContent = row.text(shown);
      ref.fill.style.width = `${norm(row.get(cur)) * 100}%`;
      if (row.limit) {
        ref.lim.style.display = '';
        ref.lim.style.left = `calc(${norm(row.limit(shown)) * 100}% - 1px)`;
        ref.fill.classList.toggle('over', row.get(cur) > row.limit(cur));
      } else {
        ref.lim.style.display = 'none';
      }
      if (pre && Math.abs(row.get(pre) - row.get(cur)) > 1e-6) {
        const d = row.get(pre) - row.get(cur);
        ref.mark.style.display = '';
        ref.mark.style.left = `calc(${norm(row.get(pre)) * 100}% - 1px)`;
        ref.delta.textContent = `${d > 0 ? '+' : '−'}${Math.abs(d) >= 10 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(2)}`;
        ref.delta.className = `d ${d * row.better > 0 ? 'up' : 'down'}`;
      } else {
        ref.mark.style.display = 'none';
        ref.delta.textContent = '';
        ref.delta.className = 'd';
      }
    }
    this._renderSummary(shown, preview ? sanitizeBuild(preview) : this.build);
  }

  _renderSummary(stats, build) {
    const w = partOf('weapon', build.weapon);
    const o = partOf('offhand', build.offhand);
    const u = partOf('sub', build.sub);
    this.summaryEl.textContent = '';
    const line = (label, text, cls = '') => {
      const div = el('div', cls);
      div.append(el('b', '', `${label} `), document.createTextNode(text));
      this.summaryEl.append(div);
    };
    // the two budgets first: these are the problems a builder needs to notice
    if (stats.overload > 0) line('OVERLOADED', `${stats.overload} over the limit: speed and dash −${Math.round((1 - stats.loadFactor) * 100)}%`, 'warn');
    if (stats.powerFactor < 1) line('POWER SHORT', `${stats.draw} drawn from ${stats.supply}: EN recovery, weapon speed and cooldowns −${Math.round((1 - stats.powerFactor) * 100)}%`, 'warn');
    const per = stats.weapon.pellets ? `${Math.round(stats.weapon.damage)} × ${stats.weapon.pellets} pellets` : `${Math.round(stats.weapon.damage)} per shot`;
    line('WEAPON', w.weapon.kind === 'melee' ? `${w.name}: LMB and RMB swing the saber` : `${w.name}: ${w.weapon.mag} rounds, ${per}`);
    if (stats.barrier > 0) line('BARRIER', `soaks ${stats.barrier} damage, recharges 5s after the last hit`);
    if (stats.jam > 0) line('ECM', `enemy missiles lose ${Math.round(stats.jam * 100)}% of their turning`);
    line('OFF-HAND', o.name);
    if (build.sub !== 'none') line('SUB-WEAPON', `${u.name} (V)`);
    line('MOBILITY', `weight ${stats.weight} gives ${Math.round(stats.weightFactor * stats.loadFactor * 100)}% of base speed`);
    line('DASH', `${Math.round(stats.dashSpeed)} u/s · ${stats.dashCost} EN each · ${stats.dashInvuln.toFixed(2)}s invulnerable`);
    line('BURST', `lasts ${stats.burstTime}s`);
  }
}
