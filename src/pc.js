// The POKéMON CENTER's PC (the metatile FireRed marks MB_PC, beside the nurse's counter): a small POKéMON Storage
// System. WITHDRAW takes a POKéMON out into the party (Steve walks with up to five), DEPOSIT puts one away. This is
// where a POKéMON caught with a full party ends up (main.js G.addCaught), the ENDER DRAGON included.
import { A } from './assets.js';
import { G } from './game.js';
import { VW, VH, FG, SH, drawWindow, cursorArrow, wrap } from './ui.js';
import { drawText, textWidth, drawFit } from './font.js';
import { sfx } from './audio.js';

export const PARTY_MAX = 5;          // Steve himself fills the sixth place
const ROWS = 6;

export class PCScreen {
  constructor() {
    this.mode = 'menu'; this.menu = 0; this.cursor = 0; this.top = 0;
    this.note = null; this.done = false;
  }
  say(text, then) { this.note = { text, then }; }
  list() { return this.mode === 'withdraw' ? G.pc : G.party; }
  update(input) {
    if (this.note) {
      if (input.just('a') || input.just('b')) { const t = this.note.then; this.note = null; sfx.select(); if (t) t(); }
      return;
    }
    if (this.mode === 'menu') {
      if (input.just('up')) { this.menu = (this.menu + 2) % 3; sfx.move(); }
      if (input.just('down')) { this.menu = (this.menu + 1) % 3; sfx.move(); }
      if (input.just('b') || (input.just('a') && this.menu === 2)) { sfx.cancel(); this.done = true; return; }
      if (input.just('a')) {
        sfx.select();
        if (this.menu === 0) {
          if (!G.pc.length) { this.say('There are no POKéMON\nin the PC.'); return; }
          if (G.party.length >= PARTY_MAX) { this.say('Your party is full!'); return; }
          this.mode = 'withdraw';
        } else {
          if (!G.party.length) { this.say('There are no POKéMON\nin your party.'); return; }
          this.mode = 'deposit';
        }
        this.cursor = 0; this.top = 0;
      }
      return;
    }
    const L = this.list(), n = L.length + 1;           // the last row is CANCEL
    if (input.just('up')) { this.cursor = (this.cursor + n - 1) % n; sfx.move(); }
    if (input.just('down')) { this.cursor = (this.cursor + 1) % n; sfx.move(); }
    this.top = Math.max(0, Math.min(this.cursor - ROWS + 1, this.top, n - ROWS));
    if (this.cursor < this.top) this.top = this.cursor;
    if (input.just('b') || (input.just('a') && this.cursor === L.length)) { sfx.cancel(); this.mode = 'menu'; return; }
    if (!input.just('a')) return;
    sfx.select();
    const mon = L[this.cursor];
    if (this.mode === 'withdraw') {
      if (G.party.length >= PARTY_MAX) { this.say('Your party is full!'); return; }
      G.pc.splice(this.cursor, 1); G.party.push(mon);
      this.say(`${mon.name} was taken out\nof the PC.`, () => this.back());
    } else {
      G.party.splice(this.cursor, 1); G.pc.push(mon);
      this.say(`${mon.name} was stored\nin the PC.`, () => this.back());
    }
  }
  back() {
    const L = this.list();
    if (!L.length || (this.mode === 'withdraw' && G.party.length >= PARTY_MAX)) { this.mode = 'menu'; return; }
    this.cursor = Math.min(this.cursor, L.length - 1);
  }

  // ---------------------------------------------------------------- drawing (GBA space, over the room)
  draw(ctx) {
    const text = (t, x, y, c = FG, s = SH) => drawText(ctx, t, x, y, c, s);
    const message = (t) => { drawWindow(ctx, 0, VH - 48, VW, 48); wrap(t, VW - 24).slice(0, 2).forEach((l, i) => text(l, 12, VH - 40 + i * 16)); };
    if (this.mode === 'menu') {
      drawWindow(ctx, 0, 0, 136, 60);
      ['WITHDRAW POKéMON', 'DEPOSIT POKéMON', 'SEE YA!'].forEach((l, i) => text(l, 22, 6 + i * 16));
      cursorArrow(ctx, 12, 9 + this.menu * 16);
      message(this.note ? this.note.text : ['Take a POKéMON out of the PC\nto join your party.', 'Store a POKéMON from your party\nin the PC.', 'Log off the PC.'][this.menu]);
      return;
    }
    const L = this.list(), rows = [...L.map((m) => m), null];
    const title = this.mode === 'withdraw' ? `PC  ${G.pc.length}` : `PARTY  ${G.party.length}/${PARTY_MAX}`;
    drawWindow(ctx, 0, 0, 84, 28); text(title, 10, 6);
    drawWindow(ctx, 88, 0, 152, ROWS * 16 + 12);
    rows.slice(this.top, this.top + ROWS).forEach((m, i) => {
      const y = 6 + i * 16;
      if (!m) { text('CANCEL', 106, y); return; }
      const ic = A.mon[m.species] && A.mon[m.species].icon;
      if (ic) ctx.drawImage(ic, 0, 0, 32, 32, 100, y - 10, 32, 32);
      drawFit(ctx, m.name, 130, y, 80, FG, SH);
      const lv = `{Lv}${m.level}`;
      drawText(ctx, lv, 232 - textWidth(lv, 'small'), y + 2, FG, SH, 'small');
    });
    cursorArrow(ctx, 95, 9 + (this.cursor - this.top) * 16);
    const tri = (y, dn) => { ctx.fillStyle = '#e04040'; for (let k = 0; k < 4; k++) ctx.fillRect(164 - k, dn ? y + 3 - k : y + k, 1 + k * 2, 1); };
    if (this.top > 0) tri(1, false);
    if (this.top + ROWS < rows.length) tri(ROWS * 16 + 5, true);
    if (this.note) { message(this.note.text); return; }
    const cur = L[this.cursor];
    message(cur ? (this.mode === 'withdraw' ? `Take out ${cur.name}?` : `Store ${cur.name} in the PC?`) : 'Go back.');
  }
}
