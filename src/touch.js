// On-screen controls for touch devices. Every control feeds the same Input object the keyboard and
// mouse use ('Mouse0' = fire, 'KeyE' = missiles, ...), so the player code cannot tell a finger from a key.
//
// Landscape layout: a floating move stick appears wherever the left thumb lands, dragging anywhere on
// the right side looks around, tapping an enemy locks onto it, and the action buttons sit under the right
// thumb. The whole layer scales with the screen (the --tc CSS variable) and a size option.
//
// Touch is switched on by a coarse pointer (phones, tablets), by the first finger that touches the
// page (touch laptops), or with ?touch=1 in the address. The last input device used wins between sorties.

import { clamp } from './util.js';

const STICK_R = 58;      // stick travel, in design pixels (scaled by --tc)
const DEAD = 0.14;       // inner dead zone, as a fraction of the travel
const LOOK_GAIN = 1.7;   // a finger drag turns the camera this much faster than the same mouse movement
const TAP_MS = 260;      // a touch shorter than this that barely moved is a tap
const TAP_PX = 14;
const LEFT_ZONE = 0.42;  // the left 42% of the screen steers, the rest looks
const LATCH_MS = 260;    // a boost tap shorter than this latches boost on; a longer press is hold-to-boost

// id, label, input code, where it lives
const BUTTONS = [
  ['fire', 'FIRE', 'Mouse0', 'cluster'],
  ['saber', 'SABER', 'Mouse2', 'cluster'],
  ['missile', 'MISSILE', 'KeyE', 'cluster'],
  ['dash', 'DASH', 'ShiftLeft', 'cluster'],
  ['boost', 'BOOST', 'Space', 'cluster'],
  ['burst', 'BURST', 'KeyX', 'cluster'],
  ['cannon', 'CANNON', 'KeyF', 'cluster'],
  ['cannon2', 'MOUNT', 'KeyG', 'cluster'],
  ['sub', 'SUB', 'KeyV', 'cluster'],
  ['arms', 'ARMS', 'KeyH', 'cluster'], // the arm guns of a saber build (on a gun build FIRE fires them too)
  ['lock', 'LOCK', 'KeyQ', 'util'],
  ['switch', 'SWITCH', 'Tab', 'util'],
  ['reload', 'RELOAD', 'KeyR', 'util'],
];
const MOUNT_LABEL = { cannon: 'CANNON', swarm: 'SWARM', rail: 'RAIL' };
const SUB_LABEL = { vulcan: 'VULCAN', flare: 'FLARE', repair: 'REPAIR', injector: 'INJECT', pulse: 'PULSE', field: 'FIELD' };

export class TouchControls {
  constructor(game) {
    this.game = game;
    game.touch = this; // the HUD and player consult it (radar size, aim assist), so register before laying out
    this.active = false;
    this.forced = false;     // ?touch=1 / ?touch=0: ignore device detection
    this.userScale = 1;
    this.scale = 1;
    this.inset = { top: 0, right: 0, bottom: 0, left: 0 }; // safe-area insets in px (notches)
    this.onPause = null;
    this.visible = false;
    this.boostLatched = false;

    this._held = new Map();  // button id -> { since, noop }
    this._stick = null;      // { id, ox, oy }
    this._look = null;       // { id, x, y, x0, y0, t0 }
    this._shape = '';
    this._cache = {};
    this.btn = {};

    this._build();
    this._probe = document.createElement('div');
    this._probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;inset:0;'
      + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.append(this._probe);

    const q = new URLSearchParams(location.search).get('touch');
    if (q === '1' || q === '0') {
      this.forced = true;
      this.enable(q === '1');
    } else {
      this.enable(window.matchMedia?.('(pointer: coarse)').matches ?? false);
    }

    // hybrids: the most recent kind of pointer decides, but never mid-sortie
    window.addEventListener('pointerdown', (e) => {
      if (this.forced || game.state === 'playing' || e.pointerType === 'pen') return;
      const touch = e.pointerType === 'touch';
      if (touch !== this.active) this.enable(touch);
    }, { capture: true, passive: true });
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    this.layout();
  }

  // ------------------------------------------------------------------ setup

  _build() {
    const root = document.createElement('div');
    root.id = 'touch';
    root.className = 'hidden';
    const btn = ([id, label, , group], g) => (group === g
      ? `<button type="button" class="tc-btn" id="tc-${id}" data-btn="${id}"><b>${label}</b><i></i></button>` : '');
    root.innerHTML = `
      <div id="tc-zone"></div>
      <div id="tc-ghost"></div>
      <div id="tc-base"><div id="tc-knob"></div></div>
      <div id="tc-cluster">${BUTTONS.map((b) => btn(b, 'cluster')).join('')}</div>
      <div id="tc-util">${BUTTONS.map((b) => btn(b, 'util')).join('')}</div>
      <button type="button" id="tc-pause" aria-label="Pause">II</button>`;
    document.body.append(root);
    this.root = root;
    this.zone = root.querySelector('#tc-zone');
    this.ghost = root.querySelector('#tc-ghost');
    this.base = root.querySelector('#tc-base');
    this.knob = root.querySelector('#tc-knob');
    this.util = root.querySelector('#tc-util');
    this.pauseBtn = root.querySelector('#tc-pause');

    for (const [id, , code] of BUTTONS) {
      const el = root.querySelector(`#tc-${id}`);
      this.btn[id] = { el, label: el.querySelector('b'), sub: el.querySelector('i'), code };
      const down = (e) => {
        if (!this.visible) return;
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        this._press(id);
      };
      const up = (e) => { e.preventDefault(); this._release(id); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
    }
    this.pauseBtn.addEventListener('click', () => this.onPause?.());

    const z = this.zone;
    z.addEventListener('pointerdown', (e) => this._zoneDown(e));
    z.addEventListener('pointermove', (e) => this._zoneMove(e));
    z.addEventListener('pointerup', (e) => this._zoneUp(e, true));
    z.addEventListener('pointercancel', (e) => this._zoneUp(e, false));
    z.addEventListener('lostpointercapture', (e) => this._zoneUp(e, false)); // a finger the system took away must not leave a stale stick
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Turn the touch interface on or off (the page gets a `touch` class that the CSS keys off). */
  enable(on) {
    this.active = !!on;
    document.documentElement.classList.toggle('touch', this.active);
    if (!this.active) {
      this.releaseAll();
      this.root.classList.add('hidden');
      this.visible = false;
    }
    this.layout();
  }

  setUserScale(v) {
    this.userScale = clamp(Number(v) || 1, 0.7, 1.5);
    this.layout();
  }

  /** Recompute the scale, the safe-area insets and the spots that depend on the radar. */
  layout() {
    const w = window.innerWidth, h = window.innerHeight;
    this.scale = clamp(Math.min(w / 844, h / 390), 0.7, 1.3) * this.userScale;
    const cs = getComputedStyle(this._probe);
    this.inset = {
      top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0,
    };
    document.documentElement.style.setProperty('--tc', this.scale.toFixed(3));
    document.documentElement.style.setProperty('--ins-top', `${this.inset.top}px`);
    document.documentElement.style.setProperty('--ins-right', `${this.inset.right}px`);
    document.documentElement.style.setProperty('--ins-bottom', `${this.inset.bottom}px`);
    document.documentElement.style.setProperty('--ins-left', `${this.inset.left}px`);
    if (this.active && this.game.hud) {
      // the radar lives top-right; the utility buttons hang under it and the pause button sits beside it
      const r = this.game.hud.radarGeom();
      this.util.style.top = `${r.cy + r.R + 8}px`;
      this.util.style.right = `${Math.max(8, this.game.hud.w - (r.cx + r.R))}px`;
      this.pauseBtn.style.top = `${r.cy - r.R}px`;
      this.pauseBtn.style.right = `${this.game.hud.w - (r.cx - r.R) + 10}px`;
    }
  }

  // ------------------------------------------------------------------ buttons

  _press(id) {
    const input = this.game.input;
    const b = this.btn[id];
    if (id === 'boost' && this.boostLatched) {
      // a tap on a latched boost turns it off
      this.boostLatched = false;
      input.keyUp(b.code);
      this._held.set(id, { since: performance.now(), noop: true });
    } else {
      input.keyDown(b.code);
      this._held.set(id, { since: performance.now(), noop: false });
    }
    b.el.classList.add('down');
    try { navigator.vibrate?.(8); } catch { /* no haptics */ }
  }

  _release(id) {
    const st = this._held.get(id);
    if (!st) return;
    const b = this.btn[id];
    const input = this.game.input;
    b.el.classList.remove('down');
    const held = performance.now() - st.since;
    if (id === 'boost') {
      this._held.delete(id);
      if (st.noop) return;
      if (held < LATCH_MS) this.boostLatched = true; // a tap latches boost on
      else input.keyUp(b.code);                       // a long press is hold-to-boost
      return;
    }
    input.keyUp(b.code); // Input keeps a very short tap down until a simulation step has seen it
    this._held.delete(id);
  }

  /** Let go of everything: used when the sortie stops, the page loses focus or touch is switched off. */
  releaseAll() {
    if (!this.game?.input) return;
    for (const id of this._held.keys()) {
      this.game.input.keyUp(this.btn[id].code);
      this.btn[id].el.classList.remove('down');
    }
    this._held.clear();
    if (this.boostLatched) this.game.input.keyUp('Space');
    this.boostLatched = false;
    this._stick = null;
    this._look = null;
    this.game.input.axis.x = 0;
    this.game.input.axis.y = 0;
    this.base?.classList.remove('on');
    this.ghost?.classList.remove('off');
    this._cache = {};
  }

  // ------------------------------------------------------------------ stick and look

  _zoneDown(e) {
    if (!this.visible) return;
    e.preventDefault();
    this.zone.setPointerCapture?.(e.pointerId);
    const w = window.innerWidth;
    if (e.clientX < w * LEFT_ZONE && !this._stick) {
      const r = STICK_R * this.scale + 10;
      const ox = clamp(e.clientX, this.inset.left + r, w * LEFT_ZONE);
      const oy = clamp(e.clientY, this.inset.top + r, window.innerHeight - this.inset.bottom - r);
      this._stick = { id: e.pointerId, ox, oy };
      this.base.style.left = `${ox}px`;
      this.base.style.top = `${oy}px`;
      this.base.classList.add('on');
      this.ghost.classList.add('off');
      this._stickMove(e);
    } else if (e.clientX >= w * LEFT_ZONE && !this._look) {
      this._look = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() };
    }
  }

  _zoneMove(e) {
    if (this._stick && e.pointerId === this._stick.id) this._stickMove(e);
    else if (this._look && e.pointerId === this._look.id) {
      const l = this._look;
      this.game.input.addLook((e.clientX - l.x) * LOOK_GAIN, (e.clientY - l.y) * LOOK_GAIN);
      l.x = e.clientX;
      l.y = e.clientY;
    }
  }

  _stickMove(e) {
    const s = this._stick;
    const R = STICK_R * this.scale;
    let nx = (e.clientX - s.ox) / R, ny = (e.clientY - s.oy) / R;
    const len = Math.hypot(nx, ny);
    if (len > 1) { nx /= len; ny /= len; }
    const mag = Math.min(len, 1);
    const k = mag < DEAD ? 0 : (mag - DEAD) / (1 - DEAD) / (mag || 1);
    this.game.input.axis.x = nx * k;
    this.game.input.axis.y = -ny * k;
    this.knob.style.transform = `translate(calc(-50% + ${nx * R}px), calc(-50% + ${ny * R}px))`;
  }

  _zoneUp(e, ok) {
    if (this._stick && e.pointerId === this._stick.id) {
      this._stick = null;
      this.game.input.axis.x = 0;
      this.game.input.axis.y = 0;
      this.base.classList.remove('on');
      this.ghost.classList.remove('off');
      this.knob.style.transform = 'translate(-50%, -50%)';
    } else if (this._look && e.pointerId === this._look.id) {
      const l = this._look;
      this._look = null;
      const tap = ok && performance.now() - l.t0 < TAP_MS && Math.hypot(e.clientX - l.x0, e.clientY - l.y0) < TAP_PX;
      if (tap && this.game.state === 'playing') this.game.player.pickTarget(e.clientX, e.clientY, 56 * Math.max(1, this.scale));
    }
  }

  // ------------------------------------------------------------------ per frame

  /** Show or hide the layer with the sortie, and keep the buttons' labels and gauges current. */
  update() {
    const g = this.game;
    const show = this.active && g.state === 'playing';
    if (show !== this.visible) {
      this.visible = show;
      this.root.classList.toggle('hidden', !show);
      if (!show) this.releaseAll();
      else this.layout();
    }
    if (!show) return;

    const p = g.player;
    const shape = `${p.meleeOnly}|${p.mounts.map((m) => m.def.kind).join(',')}|${p.sub?.kind ?? ''}|${p.limbGuns.length}`;
    if (shape !== this._shape) {
      this._shape = shape;
      this._hide('saber', p.meleeOnly);
      this._hide('reload', p.meleeOnly);
      this._hide('cannon', !p.mounts[0]);
      this._hide('cannon2', !p.mounts[1]);
      this._hide('sub', !p.sub);
      this._hide('arms', !(p.meleeOnly && p.limbGuns.length));
      this._text('fire', 'label', p.meleeOnly ? 'SABER' : 'FIRE');
      this._text('sub', 'label', SUB_LABEL[p.sub?.kind] ?? 'SUB');
      this._text('cannon', 'label', MOUNT_LABEL[p.mounts[0]?.def.kind] ?? 'CANNON');
      this._text('cannon2', 'label', MOUNT_LABEL[p.mounts[1]?.def.kind] ?? 'MOUNT');
    }
    if (this.boostLatched && p.mech.overheat) {
      // out of boost fuel: the latch lets go on its own
      this.boostLatched = false;
      g.input.keyUp('Space');
    }

    const reloading = p.reloadT > 0;
    this._text('fire', 'sub', p.meleeOnly ? '' : reloading ? 'RELOAD' : String(p.ammo));
    this._gauge('fire', reloading ? 1 - p.reloadT / p.reloadDur : 0);
    const max = p.stats.missileCharges;
    this._text('missile', 'sub', `${p.missiles}/${max}`);
    this._gauge('missile', p.missiles < max ? p.missileT / 7 : 0);
    this._flag('missile', 'empty', p.missiles === 0);
    for (const [i, id] of ['cannon', 'cannon2'].entries()) {
      const m = p.mounts[i];
      if (!m) continue;
      this._gauge(id, 1 - m.cd / m.def.cooldown);
      this._flag(id, 'empty', m.cd > 0);
    }
    if (p.sub) {
      const el = g.hud.el;
      this._text('sub', 'sub', el.subState.textContent.replace(/^RECHARGING /, ''));
      this._gauge('sub', (parseFloat(el.subFill.style.width) || 0) / 100);
      const cooling = p.sub.kind !== 'vulcan' && p.sub.kind !== 'repair' && p.subCd > 0;
      this._flag('sub', 'empty', el.subBar.classList.contains('danger') || cooling);
    }
    const burstReady = p.burst >= 100 && p.burstT <= 0;
    this._hide('burst', !burstReady);
    this._flag('lock', 'on', !!p.lock);
    this._flag('boost', 'on', this.boostLatched || this._held.has('boost'));
  }

  // cached DOM writes: only touch an element when its value actually changed
  _text(id, part, text) {
    const key = `${id}.${part}`;
    if (this._cache[key] === text) return;
    this._cache[key] = text;
    this.btn[id][part].textContent = text;
  }

  _gauge(id, k) {
    const v = Math.round(clamp(k, 0, 1) * 50) / 50;
    const key = `${id}.g`;
    if (this._cache[key] === v) return;
    this._cache[key] = v;
    this.btn[id].el.style.setProperty('--fill', `${v * 100}%`);
  }

  _flag(id, cls, on) {
    const key = `${id}.${cls}`;
    if (this._cache[key] === on) return;
    this._cache[key] = on;
    this.btn[id].el.classList.toggle(cls, on);
  }

  _hide(id, hidden) {
    this._flag(id, 'gone', hidden);
  }
}
