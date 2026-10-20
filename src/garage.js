// The garage screen: pick a part for each slot, paint it, and watch the mech rebuild on the
// showroom turntable (the game canvas itself). Panels are plain DOM floating over the canvas.
//
// Hovering an option previews its effect on the stat bars (a white marker and a +/- delta)
// without equipping it; clicking equips it. The build is saved to localStorage on every change.

import {
  DEFAULT_BUILD, ENERGY, PAINTS, PARTS, THRUSTERS,
  cleanName, deriveStats, partOf, randomBuild, sanitizeBuild, statRanges,
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
  ['backpack', 'PACK'], ['weapon', 'WEAPON'], ['offhand', 'OFF-HAND'], ['paint', 'PAINT'],
];

/** Stat rows shown on the right. `better` says which direction is an improvement. */
const ROWS = [
  { id: 'hp', label: 'ARMOR', get: (s) => s.hp, text: (s) => String(Math.round(s.hp)), better: 1 },
  { id: 'speed', label: 'SPEED', get: (s) => s.speed, text: (s) => s.speed.toFixed(1), better: 1 },
  { id: 'en', label: 'BOOST FUEL', get: (s) => s.en, text: (s) => String(Math.round(s.en)), better: 1 },
  { id: 'dps', label: 'FIREPOWER', get: (s) => s.dps, text: (s) => String(s.dps), better: 1 },
  { id: 'melee', label: 'MELEE', get: (s) => s.melee, text: (s) => `×${s.melee.toFixed(2)}`, better: 1 },
  { id: 'missiles', label: 'MISSILES', get: (s) => s.missileCharges * s.missileDamage,
    text: (s) => `${s.missileCharges} × ${Math.round(150 * s.missileDamage)}`, better: 1 },
  { id: 'weight', label: 'WEIGHT', get: (s) => s.weight, text: (s) => String(s.weight), better: -1 },
];

const el = (tag, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

// ------------------------------------------------------------------ chips describing a part

const ADD_LABELS = {
  hp: ['ARMOR', 1], en: ['BOOST FUEL', 1], enGround: ['EN REGEN', 1], enAir: ['AIR EN REGEN', 1],
  ascendSpeed: ['CLIMB', 1], dashSpeed: ['DASH SPEED', 1], dashCost: ['DASH COST', -1], turn: ['TURNING', 1],
  staggerAt: ['STAGGER RESIST', 1], missileCharges: ['MISSILES', 1], missileTurn: ['HOMING', 1],
};
const MUL_LABELS = {
  mobility: 'SPEED', dash: 'DASH', melee: 'MELEE', fireRate: 'FIRE RATE', reload: 'RELOAD SPEED',
  missileDamage: 'MISSILE DMG', burstGain: 'BURST GAIN',
};

function chipsFor(slot, part) {
  const chips = [];
  const sign = (v) => (v > 0 ? `+${v}` : String(v));
  if (part.add?.weight !== undefined) chips.push([`WEIGHT ${part.add.weight}`, '']);
  for (const [k, v] of Object.entries(part.add ?? {})) {
    const info = ADD_LABELS[k];
    if (!info) continue;
    chips.push([`${info[0]} ${sign(v)}`, v * info[1] > 0 ? 'up' : 'down']);
  }
  for (const [k, v] of Object.entries(part.mul ?? {})) {
    if (MUL_LABELS[k]) chips.push([`${MUL_LABELS[k]} ×${v}`, v > 1 ? 'up' : 'down']);
  }
  if (slot === 'weapon' && part.guard) chips.push([`${Math.round(part.guard * 100)}% DEFLECT`, 'up']);
  if (slot === 'weapon' && part.weapon.kind !== 'melee') {
    const w = part.weapon;
    chips.push([`DMG ${w.damage}`, '']);
    chips.push([`MAG ${w.mag}`, '']);
    chips.push([`${(1 / w.cooldown).toFixed(1)}/s`, '']);
    if (w.splash) chips.push(['BLAST', 'up']);
  }
  if (slot === 'offhand') {
    if (part.guard) chips.push([`${Math.round(part.guard * 100)}% GUARD`, 'up']);
    if (part.ability) chips.push([`F: ${part.ability.damage} DMG · ${part.ability.cooldown}s`, 'up']);
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
    this.tab = 'head';
    this._statRefs = null;
    this._paintRaf = 0;

    this._buildTabs();
    this._buildStats();
    this._wire();
  }

  // ------------------------------------------------------------------ open / close

  open() {
    this.game.enterGarage();
    this.root.classList.remove('hidden');
    this.nameEl.value = this.build.name;
    this._setPose('idle');
    this._renderOptions();
    this._renderStats();
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
    document.getElementById('g-go').addEventListener('click', () => this.hooks.onSortie());
    document.getElementById('g-random').addEventListener('click', () => this.commit(randomBuild()));
    document.getElementById('g-reset').addEventListener('click', () => this.commit({ ...DEFAULT_BUILD, paint: { ...DEFAULT_BUILD.paint } }));

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
    for (const part of PARTS[this.tab]) {
      const card = el('button', 'opt');
      card.type = 'button';
      card.dataset.id = part.id;
      const name = el('div', 'o-name');
      name.append(el('span', '', part.name), el('i', 'o-tag'));
      card.append(name, el('div', 'o-desc', part.desc));
      const chips = el('div', 'o-chips');
      for (const [text, kind] of chipsFor(this.tab, part)) chips.append(el('span', `chip ${kind}`, text));
      card.append(chips);

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
    for (const card of this.optionsEl.querySelectorAll('.opt')) {
      const on = card.dataset.id === this.build[this.tab];
      card.classList.toggle('selected', on);
      card.querySelector('.o-tag').textContent = on ? 'EQUIPPED' : '';
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
      bar.append(fill, mark);
      box.append(head, bar);
      this.statsEl.append(box);
      this._statRefs[row.id] = { value, delta, fill, mark };
    }
  }

  /** `preview` is a hypothetical build: shown as a marker and +/- deltas against the equipped one. */
  _renderStats(preview = null) {
    const ranges = statRanges();
    const cur = deriveStats(this.build);
    const pre = preview ? deriveStats(sanitizeBuild(preview)) : null;
    const norm = (id, v) => {
      const r = id === 'weight' ? ranges.weight : ranges[id];
      return Math.min(1, Math.max(0.03, (v - r.min) / (r.max - r.min || 1)));
    };
    for (const row of ROWS) {
      const ref = this._statRefs[row.id];
      const shown = pre ?? cur;
      ref.value.firstChild.textContent = row.text(shown);
      ref.fill.style.width = `${norm(row.id, row.get(cur)) * 100}%`;
      if (pre && Math.abs(row.get(pre) - row.get(cur)) > 1e-6) {
        const d = row.get(pre) - row.get(cur);
        ref.mark.style.display = '';
        ref.mark.style.left = `calc(${norm(row.id, row.get(pre)) * 100}% - 1px)`;
        ref.delta.textContent = `${d > 0 ? '+' : '−'}${Math.abs(d) >= 10 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(2)}`;
        ref.delta.className = `d ${d * row.better > 0 ? 'up' : 'down'}`;
      } else {
        ref.mark.style.display = 'none';
        ref.delta.textContent = '';
        ref.delta.className = 'd';
      }
    }
    this._renderSummary(pre ?? cur, preview ? sanitizeBuild(preview) : this.build);
  }

  _renderSummary(stats, build) {
    const w = partOf('weapon', build.weapon);
    const o = partOf('offhand', build.offhand);
    this.summaryEl.textContent = '';
    const line = (label, text) => {
      const div = el('div');
      div.append(el('b', '', `${label} `), document.createTextNode(text));
      this.summaryEl.append(div);
    };
    line('WEAPON', w.weapon.kind === 'melee' ? `${w.name}: LMB and RMB swing the saber` : `${w.name}: ${w.weapon.mag} rounds, ${w.weapon.damage} per shot`);
    line('OFF-HAND', o.name);
    const pct = Math.round(stats.weightFactor * 100);
    line('MOBILITY', `weight ${stats.weight} gives ${pct}% of base speed`);
    line('DASH', `${Math.round(stats.dashSpeed)} u/s · ${stats.dashCost} EN each`);
  }
}
