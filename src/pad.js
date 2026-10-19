// Controllers: the browser's Gamepad API (the standard mapping), polled once a frame by Input.poll() (main.js update)
// and fed into the same logical buttons the keyboard presses, so every screen, menu and battle works as with the keys.
// Until a controller connects (the gamepadconnected event, which the browser sends at the first button press) poll()
// returns at once: with no controller nothing changes and nothing is read.
//
//   standard button            logical button   keyboard
//   d-pad, left stick          up down left right   arrows / WASD (the stick past half way, let go under 0.45)
//   A (confirm)                'a'              Z: mine, attack, talk, select
//   B (cancel)                 'b'              X: use, place, eat, back
//   left face (Xbox X)         'jump'           Space
//   top face (Xbox Y)          'inv'            E (also closes Minecraft's screens)
//   LB / RB                    'prev' / 'next'  C / V (hotbar, creative tabs)
//   LT                         'drop'           Q
//   RT, left stick click       'sprint' (held)  Shift
//   SELECT (Back, View, -)     'map'            J (the full map)
//   START (Menu, +)            'start'          Enter (the FireRed menu)
//
// A and B: Xbox and PlayStation pads put A (confirm) on the bottom face button and B on the right one. Nintendo pads
// (Switch Pro, Joy-Con, and pads in Switch mode; found by the id: vendor 057e, "Pro Controller", "Joy-Con") have A on
// the right, so A is the right button for them. The player's own choice wins and is kept in localStorage
// ('redstone-pad-a': 'bottom' | 'right'): OPTION's A BUTTON row in generated worlds, or anywhere (Classic's START menu
// stays as it is) SELECT and START held together for 2 seconds, which shows a note. SELECT and START alone reach the
// game a moment late (0.1 s, or at once when let go sooner), so a swap pressed a frame or two apart opens nothing.
//
// The standard mapping: Chrome and the Android app give it to Xbox, PlayStation, Switch and most known pads. A device
// without it (a pad the browser has no layout for, a wheel, pedals, a throttle) is read by the same button positions as
// the best guess, and its stick only once it has rested near the centre for half a second, so an axis that rests at one
// end (pedals, throttles) never walks Steve.
//
// Text fields (the world menus' box, co-op's JOIN and chat): the keys belong to the field, as for the keyboard. A
// submits the box (OK, JOIN, send), B cancels it (as Escape), up and down move between JOIN's fields, left and right
// change its LOOK. Typing stays the keyboard's or the on-screen keyboard's job.
//
// A controller in use hides the phone's touch pad (#pad); the next touch brings it back. Handheld Android devices
// report both. Hot-plugging: a controller that goes away lets go of every button it held. Nothing here throws.
const LS_KEY = 'redstone-pad-a';
const NINTENDO = /057e|nintendo|joy-?con|pro controller|switch/i;
const FIXED = { 2: 'jump', 3: 'inv', 4: 'prev', 5: 'next', 6: 'drop', 7: 'sprint', 10: 'sprint', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
const SELECT = 8, START = 9, SWAP_MS = 2000;
const MENU_WAIT = 0.1;        // s: SELECT / START held back while the other one may still come (a swap)
const CALM_S = 0.5;           // s: a non-standard device's axis counts once it has rested near the centre this long
const STICK_ON = 0.5, STICK_OFF = 0.45;   // the stick counts past STICK_ON and lets go under STICK_OFF
const OVERLAYS = '#rs-text-entry, #coop-join, #coop-chat';   // the game's own text boxes (A submits them)
const isField = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.isContentEditable);
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export class Pad {
  constructor(input) {
    this.input = input;
    this.on = false;            // a controller is connected: poll() reads them
    this.seen = false;          // one was used this session (OPTION shows the A BUTTON row)
    this.held = new Set();      // the logical buttons the controllers hold
    this.stick = {};            // per controller index: the left stick's direction
    this.swallow = new Set();   // raw buttons ignored until let go: SELECT / START in the swap hold, A / B across a swap
    this.combo = 0; this.comboDone = false;
    this.wait = [0, 0];         // SELECT, START: how long each has been held back (s; 0 = not waiting)
    this.calm = {};             // per non-standard controller index: { id, t: [axis 0, axis 1] } (s rested near the centre)
    this.dt = 1 / 60;
    this.lastId = '';
    this.hidden = false;        // the touch pad, hidden by a controller
    this.noteEl = null; this.noteText = null; this.noteTimer = 0;
    this.pref = null;
    try { const v = localStorage.getItem(LS_KEY); if (v === 'bottom' || v === 'right') this.pref = v; } catch (e) { /* no storage */ }
    if (typeof window === 'undefined') return;
    window.addEventListener('gamepadconnected', () => { this.on = true; });
    // (a pad that went away is let go of at the next poll, which also notices when none is left)
    window.addEventListener('pointerdown', (e) => { if (this.hidden && e.pointerType === 'touch') this.showTouch(); }, true);
  }

  // ------------------------------------------------------------------ A and B
  layoutOf(id) { return this.pref || (NINTENDO.test(id || '') ? 'right' : 'bottom'); }
  aButton() { return this.layoutOf(this.lastId); }   // where A is on the controller used last: 'bottom' | 'right'
  setLayout(v) {
    if (v !== 'bottom' && v !== 'right') return;
    // the face button that made the change is still down: it must not press the other button when A and B trade places
    if (this.on && v !== this.aButton()) { this.swallow.add(0); this.swallow.add(1); }
    this.pref = v;
    try { localStorage.setItem(LS_KEY, v); } catch (e) { /* kept for this session */ }
  }
  swap() {
    this.setLayout(this.aButton() === 'right' ? 'bottom' : 'right');
    this.note(`A and B swapped: A is now the ${this.aButton()} button.`, 3000);
  }

  // ------------------------------------------------------------------ the frame's read
  pads() {
    let list = null;
    try { list = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { list = null; }
    const out = [];
    if (list) for (let i = 0; i < list.length; i++) { const g = list[i]; if (g && g.connected !== false) out.push(g); }
    return out;
  }
  poll(dt) {
    if (!this.on) return;
    this.dt = dt > 0 && dt < 1 ? dt : 1 / 60;
    try { this.read(); } catch (e) { /* a controller fault never stops the game */ }
  }
  read() {
    const pads = this.pads();
    if (!pads.length) { this.letGo(); this.on = false; return; }
    const want = new Set();
    let active = false;
    const down = new Set();   // the raw buttons pressed on any controller
    for (const g of pads) {
      const b = g.buttons || [], right = this.layoutOf(g.id) === 'right';
      let any = false;
      for (let i = 0; i < b.length && i < 17; i++) {
        const x = b[i];
        if (!(x && (typeof x === 'number' ? x > 0.5 : x.value > 0.5 || (!!x.pressed && !(x.value > 0))))) continue;
        any = true; down.add(i);
        if (this.swallow.has(i)) continue;
        if (i === 0) want.add(right ? 'b' : 'a');
        else if (i === 1) want.add(right ? 'a' : 'b');
        else if (FIXED[i]) want.add(FIXED[i]);   // (SELECT and START: below)
      }
      const n = g.index != null ? g.index : 0;
      const d = this.stickDir(n, g.mapping === 'standard' ? g.axes || [] : this.calmAxes(n, g));
      if (d) { want.add(d); any = true; }
      if (any) { active = true; this.lastId = String(g.id || ''); }
    }
    for (const i of this.swallow) if (!down.has(i)) this.swallow.delete(i);
    // SELECT + START held for 2 s swaps A and B; neither one starts while the other is held
    const sel = down.has(SELECT), start = down.has(START);
    if (sel && start) {
      if (!this.held.has('map')) this.swallow.add(SELECT);
      if (!this.held.has('start')) this.swallow.add(START);
      const t = nowMs();
      if (!this.combo) this.combo = t;
      else if (!this.comboDone && t - this.combo >= SWAP_MS) { this.comboDone = true; this.swap(); }
    } else { this.combo = 0; this.comboDone = false; }
    // alone, each is held back MENU_WAIT (the other may still come), then held as usual; let go sooner, it is a tap
    [[SELECT, 'map'], [START, 'start']].forEach(([i, k], j) => {
      if (down.has(i) && !this.swallow.has(i)) {
        if (this.held.has(k) || (this.wait[j] += this.dt) >= MENU_WAIT - 1e-6) { want.add(k); this.wait[j] = 0; }
      } else {
        if (!down.has(i) && this.wait[j] > 0) want.add(k);   // a short tap: pressed this frame, let go the next
        this.wait[j] = 0;
      }
    });
    if (active) {
      if (!this.hidden) this.hideTouch();
      if (!this.seen) { this.seen = true; this.note(`Controller ready: A is the ${this.aButton()} button.\nHold SELECT and START for 2 seconds to swap A and B.`, 4500); }
    }
    // a text field has the keys (as input.js leaves typed keys to it): the buttons answer the box, not the game
    const ae = typeof document !== 'undefined' ? document.activeElement : null;
    if (isField(ae)) {
      const prev = this.held, edge = (k) => want.has(k) && !prev.has(k);
      for (const k of prev) if (!want.has(k)) this.input.release(k);
      this.held = want;
      this.field(ae, edge);
      return;
    }
    for (const k of this.held) if (!want.has(k)) this.input.release(k);
    for (const k of want) if (!this.held.has(k)) this.input.press(k);
    this.held = want;
  }
  // the left stick as one direction (the stronger axis), kept while it stays out along it
  stickDir(n, axes) {
    const x = Number(axes[0]) || 0, y = Number(axes[1]) || 0, cur = this.stick[n] || null;
    let d = null;
    if (cur) {
      const along = cur === 'left' ? -x : cur === 'right' ? x : cur === 'up' ? -y : y;
      const across = cur === 'left' || cur === 'right' ? Math.abs(y) : Math.abs(x);
      if (along >= STICK_OFF && across <= along + 0.25) d = cur;
    }
    if (!d && Math.max(Math.abs(x), Math.abs(y)) >= STICK_ON) d = Math.abs(x) >= Math.abs(y) ? (x < 0 ? 'left' : 'right') : (y < 0 ? 'up' : 'down');
    this.stick[n] = d;
    return d;
  }
  // a controller without the standard mapping: its first two axes, each zero until it has rested near the centre for
  // CALM_S (pedals and throttles rest at one end, and the browser announces them for it)
  calmAxes(n, g) {
    const ax = g.axes || [], id = String(g.id || '');
    let c = this.calm[n];
    if (!c || c.id !== id) c = this.calm[n] = { id, t: [0, 0] };
    const out = [0, 0];
    for (let a = 0; a < 2; a++) {
      const v = Number(ax[a]) || 0;
      if (c.t[a] >= CALM_S) out[a] = v;
      else c.t[a] = Math.abs(v) < 0.2 ? c.t[a] + this.dt : 0;
    }
    return out;
  }
  letGo() {
    for (const k of this.held) this.input.release(k);
    this.held = new Set(); this.stick = {}; this.swallow.clear(); this.combo = 0; this.comboDone = false;
    this.wait = [0, 0]; this.calm = {};
  }

  // ------------------------------------------------------------------ text fields
  field(el, edge) {
    if (edge('b')) {
      // B is the field's Escape: the field's (or its form's) own handler closes the box. The key stops at the document,
      // so it never reaches input.js on the window, which does not leave a SELECT's keys to it (no B behind the box,
      // and no Escape left held, since no keyup follows)
      const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
      const stop = (e) => { if (e === ev) e.stopPropagation(); };
      document.addEventListener('keydown', stop);
      try { el.dispatchEvent(ev); } finally { document.removeEventListener('keydown', stop); }
      return;
    }
    const box = el.closest ? el.closest(OVERLAYS) : null;
    if (!box) return;
    if (edge('a')) {
      const f = el.form || (el.closest ? el.closest('form') : null), sb = f && f.querySelector('button[type=submit]');
      if (!f || (sb && sb.disabled)) return;
      if (typeof f.requestSubmit === 'function') f.requestSubmit(); else f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return;
    }
    if (edge('up') || edge('down')) {
      const list = [...box.querySelectorAll('input, select')].filter((x) => !x.disabled && x.type !== 'hidden' && x.tabIndex !== -1);
      const i = list.indexOf(el);
      if (list.length > 1 && i >= 0) list[(i + (edge('up') ? list.length - 1 : 1)) % list.length].focus();
      return;
    }
    if (el.tagName === 'SELECT' && (edge('left') || edge('right')) && el.options.length) {
      const n = el.options.length;
      el.selectedIndex = (Math.max(0, el.selectedIndex) + (edge('left') ? n - 1 : 1)) % n;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // ------------------------------------------------------------------ the touch pad and the note
  hideTouch() { this.hidden = true; try { const p = document.getElementById('pad'); if (p) p.style.display = 'none'; } catch (e) { /* no page */ } }
  showTouch() { this.hidden = false; try { const p = document.getElementById('pad'); if (p) p.style.display = ''; } catch (e) { /* no page */ } }
  // a short line over the top of the canvas (every state, the title screen too); player-visible text, no em dashes
  note(text, ms) {
    this.noteText = text;
    try {
      if (typeof document === 'undefined') return;
      let el = this.noteEl;
      if (!el || !el.isConnected) {
        el = document.createElement('div');
        el.id = 'rs-pad-note';
        Object.assign(el.style, { position: 'fixed', zIndex: '35', left: '50%', transform: 'translateX(-50%)', maxWidth: 'calc(100vw - 32px)',
          boxSizing: 'border-box', padding: '6px 10px', background: 'rgba(0,0,0,.82)', border: '1px solid #a0a0a0', color: '#e0e0e0',
          font: '13px ui-monospace, Menlo, monospace', lineHeight: '1.5', textAlign: 'center', whiteSpace: 'pre-line', pointerEvents: 'none' });
        document.body.appendChild(el);
        this.noteEl = el;
      }
      const c = document.getElementById('game'), r = c ? c.getBoundingClientRect() : null;
      el.style.top = Math.round(Math.max(8, r ? r.top + 8 : 8)) + 'px';
      el.textContent = text;
      clearTimeout(this.noteTimer);
      this.noteTimer = setTimeout(() => { try { el.remove(); } catch (e) { /* gone */ } this.noteText = null; }, ms || 3000);
    } catch (e) { /* the note is never fatal */ }
  }

  // tests (tools/gen_tests/gamepad.mjs)
  info() {
    let shown = null;
    try { const p = document.getElementById('pad'); shown = p ? getComputedStyle(p).display !== 'none' : null; } catch (e) { /* no page */ }
    return { on: this.on, seen: this.seen, aButton: this.aButton(), pref: this.pref, held: [...this.held].sort(), hidden: this.hidden, touchPadShown: shown, note: this.noteText, lastId: this.lastId };
  }
}
