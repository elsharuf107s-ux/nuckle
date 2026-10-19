// Keyboard, mouse and touch input with "just pressed" edge detection.
// GBA buttons: A = Z, B = X (and Escape). Minecraft keys: Space jump, Shift sprint, E inventory,
// Q drop, 1-9 / wheel / C V hotbar, Enter the FireRed start menu. Controllers (src/pad.js) press the same buttons.
import { Pad } from './pad.js';
const MAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right',
  z: 'a', Z: 'a', x: 'b', X: 'b', Escape: 'esc', Backspace: 'b', Enter: 'start',
  ' ': 'jump', Shift: 'sprint', e: 'inv', E: 'inv', q: 'drop', Q: 'drop',
  c: 'prev', C: 'prev', v: 'next', V: 'next', '[': 'prev', ']': 'next', m: 'mute', M: 'mute',
  j: 'map', J: 'map',   // the full map (minimap-design.md 3.10; J is JourneyMap's key, M is mute)
};
for (let i = 1; i <= 9; i++) MAP[String(i)] = 'slot' + i;
const DIRS = ['up', 'down', 'left', 'right'];
// (playfix2: a printable key that is a game button (WASD, Z, X, E, Q, C, V, M; not digits or space): a canvas text field
// focused by the keyboard leaves these to the menu, so arrow-key players can still move, take and close)
// (the map's J stays typable: "j" belongs in world names and seeds)
export function isButtonKey(k) { const b = MAP[k]; return !!b && !/^slot/.test(b) && b !== 'jump' && b !== 'map'; }

export class Input {
  constructor(canvas) {
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.lastDir = null;
    this.mouse = { x: -1, y: -1, inside: false, wheel: 0 };
    this.ctrl = false;
    this.typed = [];
    // keys typed into a text field on the page (the email sign-up) belong to that field, not to Steve
    const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    window.addEventListener('focusin', (e) => { if (typing(e.target)) { for (const k of this.down) this.released.add(k); this.down.clear(); } });
    window.addEventListener('keydown', (e) => {
      if (typing(e.target)) return;
      // (playfix: the printable characters typed this frame, for a focused canvas text field to take, as Minecraft's do)
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) this.typed.push(e.key);
      const k = MAP[e.key];
      this.ctrl = e.ctrlKey || e.metaKey;
      if (!k) return;
      e.preventDefault();
      this.press(k);
      if (k === 'esc') this.press('b');
    });
    window.addEventListener('keyup', (e) => {
      const k = MAP[e.key];
      this.ctrl = e.ctrlKey || e.metaKey;
      if (!k) return;
      this.release(k);
      if (k === 'esc') this.release('b');
    });
    window.addEventListener('blur', () => { for (const k of this.down) this.released.add(k); this.down.clear(); });
    if (canvas) {
      const pos = (e) => {
        const r = canvas.getBoundingClientRect();
        this.mouse.x = ((e.clientX - r.left) / r.width) * canvas.width;
        this.mouse.y = ((e.clientY - r.top) / r.height) * canvas.height;
        this.mouse.inside = this.mouse.x >= 0 && this.mouse.y >= 0 && this.mouse.x < canvas.width && this.mouse.y < canvas.height;
      };
      canvas.addEventListener('mousemove', pos);
      canvas.addEventListener('mouseleave', () => { this.mouse.inside = false; });
      canvas.addEventListener('mousedown', (e) => { pos(e); e.preventDefault(); this.press(e.button === 2 ? 'mouseR' : 'mouseL'); });
      window.addEventListener('mouseup', (e) => { this.release(e.button === 2 ? 'mouseR' : 'mouseL'); });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      // a second finger on the canvas (a touch that is not the primary pointer, so the browser sends no mousedown for
      // it) is 'tap2' at tap2.x, tap2.y: the minimap's tap while the other finger holds the pad (minimap-design 3.10);
      // nothing else reads it, so the menus' own touch handling is unchanged
      this.tap2 = { x: -1, y: -1 };
      canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch' || e.isPrimary) return;
        const r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return;
        this.tap2.x = ((e.clientX - r.left) / r.width) * canvas.width; this.tap2.y = ((e.clientY - r.top) / r.height) * canvas.height;
        this.press('tap2');
      });
      for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, (e) => { if (e.pointerType === 'touch' && !e.isPrimary) this.release('tap2'); });
      canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.mouse.wheel += Math.sign(e.deltaY); }, { passive: false });
    }
    for (const b of document.querySelectorAll('#pad button')) {
      const k = b.dataset.k;
      const on = (e) => { e.preventDefault(); this.press(k); };
      const off = (e) => { e.preventDefault(); this.release(k); };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      b.addEventListener('pointerleave', off);
    }
    this.pad = new Pad(this);
  }
  // once a frame, before the game reads its buttons (main.js update, with the frame's dt): the controllers, if any has
  // connected
  poll(dt) { if (this.pad) this.pad.poll(dt); }
  press(k) {
    if (!this.down.has(k)) this.pressed.add(k);
    this.down.add(k);
    if (DIRS.includes(k)) this.lastDir = k;
  }
  release(k) { if (this.down.has(k)) this.released.add(k); this.down.delete(k); }
  held(k) { return this.down.has(k); }
  just(k) { return this.pressed.has(k); }
  up(k) { return this.released.has(k); }
  dir() {
    if (this.lastDir && this.down.has(this.lastDir)) return this.lastDir;
    for (const d of DIRS) if (this.down.has(d)) return d;
    return null;
  }
  takeWheel() { const w = this.mouse.wheel; this.mouse.wheel = 0; return w; }
  endFrame() { this.pressed.clear(); this.released.clear(); this.typed.length = 0; }
}
