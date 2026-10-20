// Keyboard + mouse state. Mouse buttons are folded into the same key set as 'Mouse0' (left),
// 'Mouse1' (middle) and 'Mouse2' (right) so game code asks one question for everything.
//
// `pressed()` is an edge trigger that stays set until `endStep()` runs, which the game calls
// after each fixed simulation step, so no press is lost or double-counted when the render
// rate and the simulation rate disagree.

export class Input {
  constructor() {
    this.keys = new Set();
    this.edges = new Set();
    this.dx = 0;
    this.dy = 0;
    this.enabled = false; // only gather look input while the game is running
  }

  attach(target = window) {
    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (this.enabled && GAME_KEYS.has(e.code)) e.preventDefault();
      this.keyDown(e.code);
    });
    target.addEventListener('keyup', (e) => this.keyUp(e.code));
    target.addEventListener('mousedown', (e) => {
      if (this.enabled) this.keyDown(`Mouse${e.button}`);
    });
    target.addEventListener('mouseup', (e) => this.keyUp(`Mouse${e.button}`));
    target.addEventListener('mousemove', (e) => {
      if (this.enabled) this.addLook(e.movementX || 0, e.movementY || 0);
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener('blur', () => this.clear());
  }

  keyDown(code) {
    if (!this.keys.has(code)) this.edges.add(code);
    this.keys.add(code);
  }

  keyUp(code) {
    this.keys.delete(code);
  }

  addLook(dx, dy) {
    this.dx += dx;
    this.dy += dy;
  }

  down(code) {
    return this.keys.has(code);
  }

  pressed(code) {
    return this.edges.has(code);
  }

  /** Returns accumulated mouse movement since the last call. */
  consumeLook() {
    const out = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  endStep() {
    this.edges.clear();
  }

  clear() {
    this.keys.clear();
    this.edges.clear();
    this.dx = 0;
    this.dy = 0;
  }
}

const GAME_KEYS = new Set([
  'Space', 'Tab', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);
