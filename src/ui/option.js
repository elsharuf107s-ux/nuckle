// START > OPTION in generated worlds (the world update's design, 6.5): FireRed's option window (pokefirered
// option_menu.c: a title window over a list window, each row's label on the left and its current choice on the right in
// red, left and right change it). Rows from modes.js optionRows: MUSIC ON / OFF (the M key's toggle), WILD POKeMON
// ON / OFF (Creative only), DIFFICULTY (Survival only). Changes apply at once; B or START closes.
//
// A small screen-shaped object for main.js's 'option' state: update(dt, input), draw(ctx), done. The caller passes the
// rows and a getter and a setter per row, so this module holds no game state. It never throws: a fault closes it.
import { VW, VH, FG, SH, drawWindow, cursorArrow } from '../ui.js';
import { drawText, textWidth } from '../font.js';

const RED = '#e83828', RED_SH = '#f8b8a8';   // FireRed's option choice colour
const DIFFS = ['peaceful', 'easy', 'normal', 'hard'];

// rows: ['MUSIC', 'WILD POKéMON', 'DIFFICULTY', 'MINIMAP', 'A BUTTON'] (any subset); io: { music(), setMusic(on), wild(), setWild(on), diff(),
// setDiff(d), minimap(), setMinimap(on), padA(), setPadA('bottom' | 'right'), sfx }. A BUTTON (shown once a controller was
// used, src/pad.js): which face button is A, BOTTOM (Xbox, PlayStation) or RIGHT (Nintendo).
export class OptionWindow {
  constructor(rows, io) {
    this.rows = Array.isArray(rows) && rows.length ? rows.slice() : ['MUSIC'];
    this.io = io || {}; this.cursor = 0; this.done = false; this.t = 0;
  }
  value(row) {
    const io = this.io;
    if (row === 'MUSIC') return io.music && io.music() ? 'ON' : 'OFF';
    if (row === 'WILD POKéMON') return io.wild && io.wild() ? 'ON' : 'OFF';
    if (row === 'DIFFICULTY') return String((io.diff && io.diff()) || 'normal').toUpperCase();
    if (row === 'MINIMAP') return io.minimap && io.minimap() ? 'ON' : 'OFF';
    if (row === 'A BUTTON') return io.padA && io.padA() === 'right' ? 'RIGHT' : 'BOTTOM';
    return '';
  }
  change(row, dir) {
    const io = this.io;
    if (row === 'MUSIC' && io.setMusic) io.setMusic(!io.music());
    else if (row === 'WILD POKéMON' && io.setWild) io.setWild(!io.wild());
    else if (row === 'MINIMAP' && io.setMinimap) io.setMinimap(!(io.minimap && io.minimap()));
    else if (row === 'A BUTTON' && io.setPadA) io.setPadA(io.padA && io.padA() === 'right' ? 'bottom' : 'right');
    else if (row === 'DIFFICULTY' && io.setDiff) {
      const i = Math.max(0, DIFFS.indexOf(io.diff()));
      io.setDiff(DIFFS[(i + (dir < 0 ? DIFFS.length - 1 : 1)) % DIFFS.length]);
    } else return;
    if (io.sfx) io.sfx.move();
  }
  update(dt, input) {
    try {
      this.t += dt;
      if (this.done) return;
      const n = this.rows.length, s = this.io.sfx;
      if (input.just('b') || input.just('start')) { this.done = true; if (s) s.cancel(); return; }
      if (input.just('up')) { this.cursor = (this.cursor + n - 1) % n; if (s) s.move(); }
      if (input.just('down')) { this.cursor = (this.cursor + 1) % n; if (s) s.move(); }
      const row = this.rows[this.cursor];
      if (input.just('left')) this.change(row, -1);
      else if (input.just('right') || input.just('a')) this.change(row, 1);
    } catch (e) { console.error(e); this.done = true; }
  }
  draw(ctx) {
    try {
      drawWindow(ctx, 0, 0, VW, 32);
      drawText(ctx, 'OPTION', 12, 8, FG, SH);
      const h = this.rows.length * 16 + 12;
      drawWindow(ctx, 0, 32, VW, Math.max(h, VH - 32));
      this.rows.forEach((row, i) => {
        const y = 38 + i * 16, v = this.value(row);
        drawText(ctx, row, 18, y, FG, SH);
        drawText(ctx, v, VW - 18 - textWidth(v), y, RED, RED_SH);
        if (i === this.cursor) cursorArrow(ctx, 9, y + 3);
      });
    } catch (e) { console.error(e); this.done = true; }
  }
}
