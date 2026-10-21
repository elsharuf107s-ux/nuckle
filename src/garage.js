// The garage screen. You rotate the mech on the turntable (the game canvas itself) and click a hardpoint on
// it, a marker that floats over the head, a shoulder, a hand and so on, to open that spot's parts in an
// inventory grid. Hovering a part previews its effect on every stat bar (a white marker and a +/- delta);
// clicking equips it. The shoulders are separate left and right hardpoints, with a symmetry switch that
// keeps them matched. Up to six builds live in the hangar bar at the top.
//
// The build is saved to localStorage on every change. Two bars carry a limit marker: LOAD (weight vs the
// legs' limit) and POWER (draw vs the torso's output).

import {
  DEFAULT_BUILD, ENERGY, HARDPOINTS, MARKS, MIRROR, PAINTS, PROPORTIONS, PROP_STEP, SLOT_LABELS, THRUSTERS, TUNING, TUNING_MAX, TUNING_POOL,
  cleanName, deriveStats, hardpointSlots, partOf, partsFor, poolOf, randomBuild, sanitizeBuild, statRanges, tuningSpent, withPart,
} from './parts.js';
import {
  HANGAR_SIZE, activeBuild, clearSlot, copyActive, filledCount, loadHangar, saveHangar, selectSlot, stockBuild, updateActive,
} from './hangar.js';

/** localStorage can be missing or full (private windows): every access is guarded. */
const store = {
  getItem(k) { try { return localStorage.getItem(k); } catch { return null; } },
  setItem(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore: the hangar just will not persist */ } },
};

/** One-line summary for the title screen. */
export function describeBuild(build) {
  const { counts } = deriveStats(sanitizeBuild(build));
  const rig = [counts.legs !== 2 ? partOf('layout', sanitizeBuild(build).layout).name : '', counts.arms > 2 ? `${counts.arms} ARMS` : '', counts.heads > 1 ? `${counts.heads} HEADS` : '']
    .filter(Boolean);
  return [build.name, partOf('weapon', build.weapon).name, partOf('offhand', build.offhand).name, ...rig].join(' · ');
}

/**
 * The tabs: the hardpoints of the body, then the rig (every socket for more parts), the proportions, and the two
 * screens that are not about a part. The sockets themselves are markers on the mech and cards on the rig tab.
 */
const TABS = [...HARDPOINTS.filter((h) => !h.socket).map((h) => [h.id, h.name]), ['rig', 'RIG'], ['size', 'SIZE'], ['tuning', 'TUNING'], ['paint', 'PAINT']];

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
  salvoBonus: ['MISSILES / SALVO', 1], supply: ['POWER OUTPUT', 1], load: ['LOAD LIMIT', 1], regen: ['REPAIR /s', 1], burstTime: ['BURST TIME', 1, (v) => `+${v}s`],
  dashInvuln: ['DASH INVULN', 1, (v) => `+${v}s`], radar: ['RADAR', 1], resupplyHeal: ['WAVE REPAIR', 1, (v) => `+${Math.round(v * 100)}%`],
  jam: ['MISSILE JAMMING', 1, (v) => `${Math.round(v * 100)}%`], barrier: ['BARRIER', 1],
};
const MUL_LABELS = {
  mobility: 'SPEED', dash: 'DASH', melee: 'MELEE', fireRate: 'FIRE RATE', reload: 'RELOAD SPEED',
  gunDamage: 'GUN DAMAGE', missileDamage: 'MISSILE DMG', burstGain: 'BURST GAIN',
};

function chipsFor(slot, part) {
  const pool = poolOf(slot);
  const chips = [];
  const sign = (v) => (v > 0 ? `+${v}` : String(v));
  if (pool === 'crest') return [['COSMETIC', '']];
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
  if (part.guard) chips.push([`${Math.round(part.guard * 100)}% ${pool === 'weapon' ? 'DEFLECT' : 'GUARD'}`, 'up']);
  if (pool === 'weapon' && part.weapon.kind !== 'melee') {
    const w = part.weapon;
    chips.push([w.pellets ? `DMG ${w.damage} ×${w.pellets}` : `DMG ${w.damage}`, '']);
    chips.push([`MAG ${w.mag}`, '']);
    chips.push([`${(1 / w.cooldown).toFixed(1)}/s`, '']);
    if (w.splash) chips.push(['BLAST', 'up']);
    if (w.pellets) chips.push(['SHORT RANGE', 'down'], ['SPREAD', '']);
    if (w.homing) chips.push(['HOMING', 'up']);
    if (w.pierce) chips.push(['PIERCES', 'up']);
  }
  if (pool === 'weapon' && part.weapon.kind === 'melee' && part.weapon.reach) chips.push([`REACH ${part.weapon.reach}`, 'up']);
  if (pool === 'mount' && part.ability) {
    const a = part.ability;
    chips.push([a.kind === 'swarm' ? `${a.count} × ${a.damage} DMG · ${a.cooldown}s` : `${a.damage} DMG · ${a.cooldown}s`, 'up']);
    if (a.kind === 'swarm') chips.push(['HOMING', 'up']);
    if (a.kind === 'rail') chips.push(['PIERCES', 'up']);
  }
  if (pool === 'sub' && part.sub) {
    const u = part.sub;
    if (u.kind === 'vulcan') chips.push([`DMG ${u.damage}`, ''], [`${(1 / u.interval).toFixed(0)}/s`, ''], ['SHOOTS DOWN MISSILES', 'up']);
    else if (u.kind === 'flare') chips.push([`RECHARGE ${u.cooldown}s`, ''], ['DECOYS MISSILES', 'up']);
    else if (u.kind === 'injector') chips.push([`RECHARGE ${u.cooldown}s`, ''], ['REFILLS BOOST', 'up']);
    else if (u.kind === 'pulse') chips.push([`RECHARGE ${u.cooldown}s`, ''], [`DMG ${u.damage}`, ''], ['STAGGERS', 'up']);
    else if (u.kind === 'field') chips.push([`RECHARGE ${u.cooldown}s`, ''], [`${u.duration}s INVULNERABLE`, 'up']);
    else chips.push([`HEAL ${Math.round(u.heal * 100)}%`, 'up'], [`${u.charges} USE / WAVE`, '']);
  }
  if (pool === 'shoulder') chips.push(['PER SIDE', '']);
  if (pool === 'layout' && part.id !== 'biped') chips.push([part.legScale > 0 ? `${part.legs} LEGS` : part.id === 'tread' ? 'TREADS' : 'HOVERS', 'up']);
  if (pool === 'limb' && part.limb) {
    const l = part.limb;
    if (l.kind === 'gun') chips.push([`DMG ${l.damage}`, ''], [`${(1 / l.interval).toFixed(0)}/s`, ''], ['FIRES WITH THE GUN BUTTON', 'up']);
    else if (l.kind === 'cannon') chips.push([`DMG ${l.damage}`, ''], ['BLAST', 'up'], ['FIRES WITH THE GUN BUTTON', 'up']);
    else if (l.kind === 'blade') chips.push(['STRIKES WITH THE SABER', 'up']);
    else if (l.kind === 'launcher') chips.push(['BIGGER SALVOS', 'up']);
  }
  if (pool === 'head2' && part.id !== 'none') chips.push(['LOCK-ON +1', 'up'], ['HALF STRENGTH', 'down']);
  if (pool === 'pod' || pool === 'tail') chips.push([pool === 'pod' ? 'PER SIDE' : 'AT THE REAR', '']);
  return chips;
}

// ------------------------------------------------------------------ the screen

export class Garage {
  /**
   * @param game   the Game (provides setBuild, enterGarage/exitGarage, garagePose, garageFocus, camera)
   * @param hooks  { onBack(), onSortie(), onChange(build) }
   */
  constructor(game, hooks) {
    this.game = game;
    this.hooks = hooks;
    this.root = document.getElementById('screen-garage');
    this.tabsEl = document.getElementById('g-tabs');
    this.slotsEl = document.getElementById('g-slots');
    this.headEl = document.getElementById('g-hphead');
    this.optionsEl = document.getElementById('g-options');
    this.detailEl = document.getElementById('g-detail');
    this.statsEl = document.getElementById('g-stats');
    this.summaryEl = document.getElementById('g-summary');
    this.nameEl = document.getElementById('g-name');
    this.hangarEl = document.getElementById('g-hangar');
    this.markersEl = document.getElementById('g-markers');
    this.hangar = loadHangar(store);
    this.build = activeBuild(this.hangar);
    this.pit = false; // true while the screen is the pit stop between waves
    this.tab = 'head'; // a hardpoint id, 'tuning' or 'paint'
    this.slot = 'head'; // the slot shown in the grid while a hardpoint tab is open
    this._statRefs = null;
    this._paintRaf = 0;
    this._markerRefs = {};
    this._detailPart = null;

    this._buildTabs();
    this._buildMarkers();
    this._buildStats();
    this._wire();
    this._renderHangar();
    game.onGarageFrame = () => this.tick();
  }

  // ------------------------------------------------------------------ open / close

  open() {
    this._setPit(null);
    this.game.enterGarage();
    this.root.classList.remove('hidden');
    this._showStats(false);
    this.nameEl.value = this.build.name;
    this._setPose('idle');
    this._openTab('head');
    this._renderStats();
    this.game.garageFocus('all');
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
    this._openTab('head');
    this._renderStats();
    this.game.garageFocus('all');
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

  /** Equip a whole new build: rebuild the model, save the hangar, refresh the panels. */
  commit(build) {
    const before = this.build;
    this.build = sanitizeBuild(build);
    this.hangar = updateActive(this.hangar, this.build);
    saveHangar(this.hangar, store);
    this.game.setBuild(this.build);
    this.hooks.onChange?.(this.build);
    this.nameEl.value = this.build.name;
    this._refreshSelection();
    this._syncRig();
    this._renderStats();
    this._renderHangar();
    this._updateDetail(this._detailPart);
    // a part bolted on to a socket: sparks and a clank where it went
    for (const hp of HARDPOINTS) {
      const slot = hp.slots[0];
      if (hp.socket && this.build[slot] !== before[slot] && this.build[slot] !== 'none') this.game.garageWeld(hp.id);
    }
  }

  /** The build changed under an open tab: a new layout changes which leg slots exist, and the rig and size screens show the build. */
  _syncRig() {
    const hp = HARDPOINTS.find((h) => h.id === this.tab);
    if (hp) {
      const slots = hardpointSlots(hp, this.build);
      if (slots.join() !== this._slotSig) this._openTab(this.tab);
    } else if (this.tab === 'rig') {
      this.optionsEl.textContent = '';
      this._renderRig();
    } else if (this.tab === 'size') {
      this._syncSize();
    }
  }

  /** Whether a change to `slot` also changes the other side (the symmetry switch). */
  _mirrors(slot) {
    return !!MIRROR[slot] && this.build.sym;
  }

  _select(slot, id) {
    const next = withPart(this.build, slot, id, this._mirrors(slot));
    if (JSON.stringify(next) !== JSON.stringify(this.build)) this.commit(next);
  }

  // ------------------------------------------------------------------ the hangar

  /** Make hangar slot `index` the active build (an empty slot starts from the stock mech). */
  _switchSlot(index) {
    if (index === this.hangar.active) return;
    this.hangar = selectSlot(this.hangar, index);
    this._loadActive();
  }

  /** The active hangar build changed (switch, copy, clear): refit it and redraw everything. */
  _loadActive() {
    this.build = activeBuild(this.hangar);
    saveHangar(this.hangar, store);
    this.game.setBuild(this.build);
    this.hooks.onChange?.(this.build);
    this.nameEl.value = this.build.name;
    this._renderHangar();
    this._renderOptions();
    this._renderStats();
  }

  _renderHangar() {
    const box = this.hangarEl;
    if (!this._hangarBuilt) {
      this._hangarBuilt = true;
      box.textContent = '';
      this._hgSlots = [];
      for (let i = 0; i < HANGAR_SIZE; i++) {
        const b = el('button', 'hg-slot');
        b.type = 'button';
        b.dataset.slot = String(i);
        b.addEventListener('click', () => this._switchSlot(i));
        box.append(b);
        this._hgSlots.push(b);
      }
      const copy = el('button', 'hg-act', 'COPY');
      copy.type = 'button';
      copy.id = 'hg-copy';
      copy.title = 'Copy this build into the next empty hangar slot';
      copy.addEventListener('click', () => {
        const next = copyActive(this.hangar);
        if (next === this.hangar) return;
        this.hangar = next;
        this._loadActive();
      });
      const clear = el('button', 'hg-act', 'CLEAR');
      clear.type = 'button';
      clear.id = 'hg-clear';
      clear.title = 'Empty this hangar slot';
      clear.addEventListener('click', () => {
        const next = clearSlot(this.hangar, this.hangar.active);
        if (next === this.hangar) return;
        this.hangar = next;
        this._loadActive();
      });
      this._hgCopy = copy;
      this._hgClear = clear;
      box.append(copy, clear);
    }
    this._hgSlots.forEach((b, i) => {
      const build = this.hangar.slots[i];
      b.classList.toggle('active', i === this.hangar.active);
      b.classList.toggle('empty', !build);
      b.textContent = build ? String(i + 1) : '+';
      b.title = build ? `${build.name}: ${partOf('weapon', build.weapon).name}` : 'Empty: click to start a new build';
    });
    this._hgCopy.disabled = filledCount(this.hangar) >= HANGAR_SIZE;
    this._hgClear.disabled = filledCount(this.hangar) <= 1;
  }

  // ------------------------------------------------------------------ wiring

  _wire() {
    document.getElementById('g-back').addEventListener('click', () => this.hooks.onBack());
    // narrow screens have room for one panel at a time: this swaps the parts list and the stat bars
    document.getElementById('g-stats-toggle').addEventListener('click', () => this._showStats(!this.root.classList.contains('show-stats')));
    document.getElementById('g-go').addEventListener('click', () => this.hooks.onSortie());
    document.getElementById('g-random').addEventListener('click', () => this.commit(randomBuild()));
    document.getElementById('g-reset').addEventListener('click', () => this.commit({
      ...stockBuild(this.hangar.active), tuning: { ...DEFAULT_BUILD.tuning },
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

  // ------------------------------------------------------------------ tabs, markers and the grid

  _buildTabs() {
    for (const [id, label] of TABS) {
      const b = el('button', 'g-tab', label);
      b.type = 'button';
      b.dataset.tab = id;
      b.addEventListener('click', () => this.selectHardpoint(id));
      this.tabsEl.append(b);
    }
  }

  /** The clickable markers drawn over the mech, one per hardpoint. They are positioned every frame by tick(). */
  _buildMarkers() {
    for (const hp of HARDPOINTS) {
      const b = el('button', 'g-marker');
      b.type = 'button';
      b.dataset.hp = hp.id;
      if (hp.socket) b.classList.add('socket'); // a glowing socket to bolt something on to
      b.setAttribute('aria-label', hp.name);
      b.append(el('i'), el('span', '', hp.name));
      b.addEventListener('click', () => this.selectHardpoint(hp.id));
      b.addEventListener('pointerdown', (e) => e.stopPropagation()); // pressing a marker must not start a turntable drag
      this.markersEl.append(b);
      this._markerRefs[hp.id] = { el: b, x: -1, y: -1, behind: null, off: null };
    }
  }

  /** Open a hardpoint (or 'tuning' / 'paint') and swing the camera to it. */
  selectHardpoint(id) {
    this._openTab(id);
    this._renderStats();
    this.game.garageFocus(HARDPOINTS.some((h) => h.id === id) ? id : 'all');
  }

  _openTab(id) {
    this.tab = id;
    const hp = HARDPOINTS.find((h) => h.id === id);
    if (hp) {
      const slots = hardpointSlots(hp, this.build);
      if (!slots.includes(this.slot)) this.slot = slots[0];
    }
    this._renderOptions();
  }

  _selectSlot(slot) {
    this.slot = slot;
    this._renderOptions();
    this._renderStats();
  }

  /** The sub-tabs of a hardpoint that holds several slots (a shoulder's armor and mount, a helmet and its crest). */
  _renderSlotTabs(hp) {
    this.slotsEl.textContent = '';
    const slots = hp ? hardpointSlots(hp, this.build) : [];
    this._slotSig = slots.join();
    const multi = slots.length > 1;
    const sided = slots.some((s) => MIRROR[s]);
    this.slotsEl.classList.toggle('hidden', !multi && !sided);
    if (!hp) return;
    if (multi) {
      for (const slot of slots) {
        const b = el('button', 'g-slot', SLOT_LABELS[slot]);
        b.type = 'button';
        b.dataset.slot = slot;
        b.classList.toggle('active', slot === this.slot);
        b.addEventListener('click', () => this._selectSlot(slot));
        this.slotsEl.append(b);
      }
    }
    if (sided) {
      const sym = el('button', 'g-sym');
      sym.type = 'button';
      sym.id = 'g-sym';
      sym.title = 'Keep the left and right sides matched';
      sym.addEventListener('click', () => this._toggleSym());
      this.slotsEl.append(sym);
      this._syncSym();
    }
  }

  _syncSym() {
    const sym = document.getElementById('g-sym');
    if (!sym) return;
    sym.textContent = `SYMMETRY ${this.build.sym ? 'ON' : 'OFF'}`;
    sym.classList.toggle('on', this.build.sym);
  }

  _toggleSym() {
    let next = { ...this.build, sym: !this.build.sym };
    // turning it on matches the other side to the one you are looking at
    if (next.sym && MIRROR[this.slot]) next = withPart(next, this.slot, next[this.slot], true);
    this.commit(next);
  }

  _renderOptions() {
    const hp = HARDPOINTS.find((h) => h.id === this.tab);
    const lit = hp?.socket ? 'rig' : this.tab; // a socket is opened from the rig tab
    this.root.classList.toggle('rigmode', lit === 'rig'); // (small screens show the sockets, not the body markers, while it is open)
    for (const b of this.tabsEl.children) b.classList.toggle('active', b.dataset.tab === lit);
    this.optionsEl.textContent = '';
    this.optionsEl.scrollTop = 0;
    this._renderSlotTabs(hp);
    this.detailEl.classList.toggle('hidden', !hp);
    this.headEl.textContent = hp ? `${hp.name}  ·  ${SLOT_LABELS[this.slot]}` : this.tab.toUpperCase();
    this._syncMarkers();
    if (this.tab === 'rig') {
      this._renderRig();
      return;
    }
    if (this.tab === 'size') {
      this._renderSize();
      return;
    }
    if (this.tab === 'paint') {
      this._renderPaint();
      return;
    }
    if (this.tab === 'tuning') {
      this._renderTuning();
      return;
    }
    const slot = this.slot;
    for (const part of partsFor(slot)) {
      const card = el('button', 'opt');
      card.type = 'button';
      card.dataset.id = part.id;
      const name = el('div', 'o-name');
      name.append(el('span', '', part.name), el('i', 'o-tag'));
      const chips = el('div', 'o-chips');
      for (const [text, kind] of chipsFor(slot, part).slice(0, 3)) chips.append(el('span', `chip ${kind}`, text));
      card.append(name, el('div', 'o-desc', part.desc), chips);

      card.addEventListener('click', () => { this._select(slot, part.id); this._updateDetail(part); });
      const preview = () => {
        this._renderStats(withPart(this.build, slot, part.id, this._mirrors(slot)));
        this._updateDetail(part);
      };
      const unpreview = () => { this._renderStats(); this._updateDetail(null); };
      card.addEventListener('mouseenter', preview);
      card.addEventListener('focus', preview);
      card.addEventListener('mouseleave', unpreview);
      card.addEventListener('blur', unpreview);
      this.optionsEl.append(card);
    }
    this._refreshSelection();
    this._updateDetail(null);
  }

  /** The strip under the grid: the full description and every stat chip of the part under the pointer, else the equipped one. */
  _updateDetail(part) {
    this._detailPart = part;
    const hp = HARDPOINTS.find((h) => h.id === this.tab);
    if (!hp) return;
    const shown = part ?? partOf(this.slot, this.build[this.slot]);
    const box = this.detailEl;
    box.textContent = '';
    const head = el('div', 'd-name', shown.name);
    if (shown.id === this.build[this.slot]) head.append(el('i', '', 'EQUIPPED'));
    box.append(head, el('div', 'd-desc', shown.desc));
    const chips = el('div', 'o-chips');
    for (const [text, kind] of chipsFor(this.slot, shown)) chips.append(el('span', `chip ${kind}`, text));
    box.append(chips);
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
      const on = card.dataset.id === this.build[this.slot];
      card.classList.toggle('selected', on);
      card.querySelector('.o-tag').textContent = on ? 'EQUIPPED' : '';
    }
    this._syncSym();
    this._syncMarkers();
  }

  // ------------------------------------------------------------------ markers over the 3D mech

  _syncMarkers() {
    const hp = HARDPOINTS.find((h) => h.id === this.tab);
    const linked = hp && this.build.sym && MIRROR[hp.id] ? MIRROR[hp.id] : null;
    for (const [id, ref] of Object.entries(this._markerRefs)) {
      ref.el.classList.toggle('active', id === this.tab);
      ref.el.classList.toggle('linked', id === linked);
      const socket = HARDPOINTS.find((h) => h.id === id);
      if (socket?.socket) ref.el.classList.toggle('empty', this.build[socket.slots[0]] === 'none');
    }
  }

  /** Called every frame while the garage is up: pin each marker to its hardpoint on the mech. */
  tick() {
    if (this.root.classList.contains('hidden')) return;
    const game = this.game;
    const mech = game.player.mech;
    const cam = game.camera;
    const w = window.innerWidth, h = window.innerHeight;
    const center = mech.center(this._c ?? (this._c = mech.pos.clone()));
    const p = this._p ?? (this._p = mech.pos.clone());
    for (const id of Object.keys(this._markerRefs)) {
      const ref = this._markerRefs[id];
      mech.model.anchorWorld(id, p);
      // which side of the mech is it on, as seen from the camera? (the far side is dimmed)
      const away = (p.x - center.x) * (cam.position.x - center.x) + (p.z - center.z) * (cam.position.z - center.z);
      p.project(cam);
      const off = p.z > 1 || p.x < -1.05 || p.x > 1.05 || p.y < -1.05 || p.y > 1.05;
      const x = Math.round((p.x * 0.5 + 0.5) * w), y = Math.round((-p.y * 0.5 + 0.5) * h);
      const behind = away < -4;
      if (x !== ref.x || y !== ref.y) {
        ref.el.style.transform = `translate(${x}px, ${y}px)`;
        ref.x = x;
        ref.y = y;
      }
      if (off !== ref.off) { ref.el.classList.toggle('off', off); ref.off = off; }
      if (behind !== ref.behind) { ref.el.classList.toggle('behind', behind); ref.behind = behind; }
    }
  }

  // ------------------------------------------------------------------ rig tab: what the machine is made of

  _renderRig() {
    const wrap = this.optionsEl;
    const stats = deriveStats(this.build);
    const asm = el('div', 'paint-section');
    asm.append(el('h4', '', 'ASSEMBLY'));
    const counts = el('div', 'rig-counts');
    for (const [n, label] of [[stats.counts.arms, 'ARMS'], [stats.counts.legs, 'LEGS'], [stats.counts.heads, 'HEADS']]) {
      const c = el('div', 'rig-count');
      c.append(el('b', '', String(n)), el('span', '', label));
      counts.append(c);
    }
    asm.append(counts, el('div', 'o-desc', 'Click a glowing socket on the machine, or pick one below, to bolt something on. Every part adds weight and draws power: watch the LOAD and POWER bars. Leg layouts are under LEGS.'));
    const sockets = el('div', 'paint-section');
    sockets.append(el('h4', '', 'SOCKETS'));
    const grid = el('div', 'sockets');
    for (const hp of HARDPOINTS.filter((h) => h.socket)) {
      const part = partOf(hp.slots[0], this.build[hp.slots[0]]);
      const b = el('button', 'socket-btn');
      b.type = 'button';
      b.dataset.hp = hp.id;
      b.classList.toggle('filled', part.id !== 'none');
      b.append(el('span', 'sb-name', hp.name), el('span', 'sb-part', part.id === 'none' ? 'EMPTY  +' : part.name));
      b.addEventListener('click', () => this.selectHardpoint(hp.id));
      grid.append(b);
    }
    sockets.append(grid);
    wrap.append(asm, sockets);
  }

  _renderSize() {
    const wrap = this.optionsEl;
    const intro = el('div', 'paint-section');
    const head = el('div', 'tune-head');
    const reset = el('button', 'tune-btn size-reset', 'RESET');
    reset.type = 'button';
    reset.title = 'Back to stock proportions';
    reset.addEventListener('click', () => this.commit({ ...this.build, prop: { ...DEFAULT_BUILD.prop } }));
    head.append(el('h4', '', 'PROPORTIONS'), reset);
    intro.append(head, el('div', 'o-desc', 'Stretch or shrink the machine. Each change is a trade: a bigger machine carries more armor but weighs more and moves slower; longer legs run faster but topple easier.'));
    wrap.append(intro);
    this._sizeRows = {};
    for (const p of PROPORTIONS) {
      const row = el('div', 'tune-row');
      const top = el('div', 'tune-head');
      const val = el('b', 'size-val');
      top.append(el('span', 'tune-name', p.name), val);
      const input = el('input');
      input.type = 'range';
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = String(PROP_STEP);
      input.dataset.prop = p.id;
      input.addEventListener('input', () => {
        // dragging fires continuously and each change rebuilds the machine: collect the changes and apply them once per frame
        this._sizePend = { ...this._sizePend, [p.id]: Number(input.value) };
        if (this._sizeRaf) return;
        this._sizeRaf = requestAnimationFrame(() => {
          const patch = this._sizePend;
          this._sizePend = null;
          this._sizeRaf = 0;
          this.commit({ ...this.build, prop: { ...this.build.prop, ...patch } });
        });
      });
      row.append(top, input, el('div', 'o-desc', p.effect));
      this._sizeRows[p.id] = { input, val };
      wrap.append(row);
    }
    this._syncSize();
  }

  _syncSize() {
    if (!this._sizeRows || this.tab !== 'size') return;
    for (const p of PROPORTIONS) {
      const ref = this._sizeRows[p.id];
      const v = this.build.prop[p.id];
      if (document.activeElement !== ref.input) ref.input.value = String(v);
      ref.val.textContent = `×${v.toFixed(2)}`;
      ref.val.classList.toggle('changed', v !== 1);
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

    const marks = el('div', 'paint-section');
    marks.append(el('h4', '', 'MARKINGS'));
    const mRow = el('div', 'marks');
    this._markBtns = {};
    for (const m of MARKS) {
      const b = el('button', 'mark', m.name);
      b.type = 'button';
      b.dataset.mark = m.id;
      b.addEventListener('click', () => this.commit({ ...this.build, marks: m.id }));
      this._markBtns[m.id] = b;
      mRow.append(b);
    }
    marks.append(mRow);

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

    wrap.append(presets, colors, marks, energy, thr);
    this._syncPaint();
  }

  _syncPaint() {
    if (!this._energySw || this.tab !== 'paint') return;
    for (const [k, input] of Object.entries(this._colorInputs)) {
      if (document.activeElement !== input) input.value = this.build.paint[k];
    }
    for (const [id, b] of Object.entries(this._energySw)) b.classList.toggle('selected', id === this.build.energy);
    for (const [id, b] of Object.entries(this._thrusterSw)) b.classList.toggle('selected', id === this.build.thruster);
    for (const [id, b] of Object.entries(this._markBtns)) b.classList.toggle('selected', id === this.build.marks);
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
    const rigBits = [];
    if (stats.layout.id !== 'biped') rigBits.push(partOf('layout', build.layout).name);
    if (stats.counts.legs > 2) rigBits.push(`${stats.counts.legs} legs`);
    if (stats.counts.arms > 2) rigBits.push(`${stats.counts.arms} arms`);
    if (stats.counts.heads > 1) rigBits.push(`${stats.counts.heads} heads`);
    if (rigBits.length) line('RIG', rigBits.join(' · '));
    const armGuns = stats.limbs.filter((l) => l.kind === 'gun' || l.kind === 'cannon');
    if (armGuns.length) line('ARM GUNS', `${armGuns.map((l) => l.name.replace('ARM ', '').toLowerCase()).join(', ')}: fire with ${w.weapon.kind === 'melee' ? 'H' : 'the gun button'}`);
    if (stats.lock > 1) line('LOCK-ON', `${stats.lock} targets at once: missiles are shared out among them`);
    if (stats.salvo > 4) line('SALVO', `${stats.salvo} missiles each time`);
    line('WEAPON', w.weapon.kind === 'melee' ? `${w.name}: LMB and RMB swing the saber` : `${w.name}: ${w.weapon.mag} rounds, ${per}`);
    line('OFF-HAND', o.name);
    stats.abilities.forEach((a, i) => line(i === 0 ? 'MOUNT F' : 'MOUNT G', `${a.name} (${a.side === 'L' ? 'left' : 'right'} shoulder)`));
    if (stats.barrier > 0) line('BARRIER', `soaks ${stats.barrier} damage, recharges 5s after the last hit`);
    if (stats.jam > 0) line('ECM', `enemy missiles lose ${Math.round(stats.jam * 100)}% of their turning`);
    if (build.sub !== 'none') line('SUB-WEAPON', `${u.name} (V)`);
    line('MOBILITY', `weight ${stats.weight} gives ${Math.round(stats.weightFactor * stats.loadFactor * 100)}% of base speed`);
    line('DASH', `${Math.round(stats.dashSpeed)} u/s · ${stats.dashCost} EN each · ${stats.dashInvuln.toFixed(2)}s invulnerable`);
    line('BURST', `lasts ${stats.burstTime}s`);
  }
}
