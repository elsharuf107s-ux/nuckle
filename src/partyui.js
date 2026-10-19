// FireRed's party screen, rebuilt from its own tiles (graphics/party_menu) and layout
// (src/data/party_menu.h): a large box for the lead, five wide boxes on the right, CANCEL below.
import { A } from './assets.js';
import { drawText, textWidth, drawFit } from './font.js';
import { drawWindow, drawList, cursorArrow, wrap, moreArrow, FG, SH, VW, VH } from './ui.js';
import { species } from './data.js';
import { sfx } from './audio.js';

const STATUS_X = { PSN: 0, PAR: 32, SLP: 64, FRZ: 96, BRN: 128, FNT: 192 };
const MAIN = { x: 8, y: 24 };
const wideY = (i) => 8 + (i - 1) * 24;
const CANCEL = { x: 184, y: 136 };
const WHITE = '#f8f8f8', GREY = '#707070';

export function drawStatusIcon(ctx, status, x, y) {
  if (!status || !(status in STATUS_X)) return;
  ctx.drawImage(A.img.statusIcons, STATUS_X[status], 0, 32, 8, x, y, 32, 8);
}

function hpColors(hp, max) {
  const px = Math.ceil((hp / max) * 48);
  const c = A.partyColors;
  return px > 24 ? c.green : px > 9 ? c.yellow : c.red;
}
function drawHpFill(ctx, x, y, hp, max) {
  const w = hp <= 0 ? 0 : Math.max(1, Math.ceil((hp / max) * 48));
  const [main, shade] = hpColors(hp, max);
  ctx.fillStyle = `rgb(${main.join(',')})`; ctx.fillRect(x, y, w, 2);
  ctx.fillStyle = `rgb(${shade.join(',')})`; ctx.fillRect(x, y + 2, w, 1);
}

export class PartyScreen {
  // mode: 'field' | 'battle' | 'forced' | 'item'
  constructor({ party, mode, prompt, activeIdx = -1, flyingIdx = -1, onDone, actionsFor, canCancel = true }) {
    Object.assign(this, { party, mode, prompt, activeIdx, flyingIdx, onDone, actionsFor, canCancel });
    this.cursor = 0;
    this.sub = null;        // { options: [{label, color, run}], cursor }
    this.msg = null;        // { lines, then }
    this.switchFrom = -1;
    this.t = 0;
  }
  get count() { return this.party.length; }
  say(text, then) { this.msg = { lines: wrap(text, 160), then }; }

  update(dt, input) {
    this.t += dt;
    if (this.msg) {
      if (input.just('a') || input.just('b')) { const then = this.msg.then; this.msg = null; sfx.select(); if (then) then(); }
      return;
    }
    if (this.sub) {
      const n = this.sub.options.length;
      if (input.just('up')) { this.sub.cursor = (this.sub.cursor + n - 1) % n; sfx.move(); }
      if (input.just('down')) { this.sub.cursor = (this.sub.cursor + 1) % n; sfx.move(); }
      if (input.just('b')) { this.sub = null; sfx.cancel(); return; }
      if (input.just('a')) { const o = this.sub.options[this.sub.cursor]; this.sub = null; sfx.select(); o.run(); }
      return;
    }
    const n = this.count;
    const CAN = n; // cursor index of CANCEL
    const hasCancel = this.canCancel || this.switchFrom >= 0;
    const maxIdx = hasCancel ? CAN : n - 1;
    let moved = false;
    if (input.just('up')) { this.cursor = this.cursor === 0 ? maxIdx : this.cursor - 1; moved = true; }
    if (input.just('down')) { this.cursor = this.cursor >= maxIdx ? 0 : this.cursor + 1; moved = true; }
    if (input.just('left') && this.cursor !== 0 && this.cursor !== CAN) { this.lastRight = this.cursor; this.cursor = 0; moved = true; }
    if (input.just('right') && this.cursor === 0 && n > 1) { this.cursor = Math.min(this.lastRight || 1, n - 1); moved = true; }
    if (moved) sfx.move();
    if (input.just('b')) {
      if (this.switchFrom >= 0) { this.switchFrom = -1; sfx.cancel(); return; }
      if (this.canCancel) { sfx.cancel(); this.onDone(null); }
      return;
    }
    if (input.just('a')) {
      if (this.cursor === CAN) { if (this.switchFrom >= 0) { this.switchFrom = -1; sfx.cancel(); } else if (this.canCancel) { sfx.cancel(); this.onDone(null); } return; }
      sfx.select();
      if (this.switchFrom >= 0) {
        const a = this.switchFrom, b = this.cursor;
        if (a !== b) { const tmp = this.party[a]; this.party[a] = this.party[b]; this.party[b] = tmp; }
        this.switchFrom = -1;
        if (this.onSwitch) this.onSwitch(a, b);
        return;
      }
      if (this.mode === 'item') { this.onDone(this.cursor); return; }
      const options = this.actionsFor(this.party[this.cursor], this.cursor, this);
      this.sub = { options, cursor: 0 };
    }
  }
  beginSwitch(i) { this.switchFrom = i; }

  draw(ctx) {
    ctx.drawImage(A.img.partyBg, 0, 0);
    for (let i = 0; i < 6; i++) this.drawSlot(ctx, i);
    const cancelSel = this.cursor === this.count;
    ctx.drawImage(cancelSel ? A.img.partyCancelSelected : A.img.partyCancelNormal, CANCEL.x, CANCEL.y);
    drawText(ctx, 'CANCEL', CANCEL.x + 14, CANCEL.y, WHITE, GREY);
    // message window (bottom-left) and the action submenu
    const text = this.msg ? null : this.sub ? 'Do what with this POKéMON?' : this.switchFrom >= 0 ? 'Move to where?' : this.prompt;
    const lines = this.msg ? this.msg.lines : wrap(text || '', 160);
    const h = lines.length > 1 ? 48 : 32;
    drawWindow(ctx, 0, VH - h, this.sub ? 152 : 180, h);
    lines.slice(0, 2).forEach((l, i) => drawText(ctx, l, 10, VH - h + 8 + i * 16, FG, SH));
    if (this.msg) moreArrow(ctx, 160, VH - 14, this.t);
    if (this.sub) {
      const items = this.sub.options.map((o) => ({ label: o.label, color: o.color }));
      const w = 84, hh = items.length * 16 + 12;
      const x = VW - w, y = VH - hh;
      drawWindow(ctx, x, y, w, hh);
      items.forEach((it, i) => {
        const blue = it.color === 'blue';
        drawText(ctx, it.label, x + 18, y + 6 + i * 16, blue ? '#3058c8' : FG, blue ? '#a8c0f0' : SH);
        if (i === this.sub.cursor) cursorArrow(ctx, x + 9, y + 9 + i * 16);
      });
    }
  }

  drawSlot(ctx, i) {
    const mon = this.party[i];
    const selected = this.cursor === i;
    if (i > 0 && !mon) { ctx.drawImage(A.img.partyWideEmpty, 96, wideY(i)); return; }
    if (!mon) return;
    const fainted = mon.hp <= 0;
    let st = selected ? (fainted ? 'fainted_selected' : 'selected') : fainted ? 'fainted' : 'normal';
    if (this.switchFrom === i) st = 'switching';
    else if (this.switchFrom >= 0 && selected) st = 'switch_target';
    const main = i === 0;
    const bx = main ? MAIN.x : 96, by = main ? MAIN.y : wideY(i);
    ctx.drawImage(A.img[(main ? 'partyMain_' : 'partyWide_') + st], bx, by);
    // Pokéball (opens when selected), then the icon on top; the selected icon hops.
    const ball = main ? { x: 16, y: 34 } : { x: 102, y: 25 + (i - 1) * 24 };
    ctx.drawImage(A.img.partyBall, 0, selected ? 32 : 0, 32, 32, ball.x - 16, ball.y - 16, 32, 32);
    const ic = main ? { x: 16, y: 40 } : { x: 104, y: 18 + (i - 1) * 24 };
    const frame = fainted ? 0 : Math.floor(this.t * (selected ? 6 : 3)) % 2;
    const hop = selected && !fainted && frame ? -2 : 0;
    ctx.drawImage(A.mon[mon.species].icon, 0, frame * 32, 32, 32, ic.x - 16, ic.y - 16 + hop, 32, 32);
    // Text rectangles from sPartyBoxInfoRects (src/data/party_menu.h); everything is FONT_SMALL.
    const R = main
      ? { name: [24, 11], lvl: [32, 20], hpEnd: 77, hpY: 36, bar: [24, 35] }
      : { name: [22, 3], lvl: [32, 12], hpEnd: 141, hpY: 12, bar: [88, 10] };
    // FireRed's name fields hold ten characters. The one longer name (ENDER DRAGON) fits the main box with its space
    // narrowed; in a list box it runs past the "HP" tag, so the tag is painted over with the box's own colour there.
    if (!main && textWidth(mon.name, 'small') > 50) ctx.drawImage(A.img['partyWide_' + st], 59, 8, 14, 7, bx + 73, by + 8, 14, 7);
    // (in a list box the painted-over tag leaves room for a full word space)
    drawFit(ctx, mon.name, bx + R.name[0], by + R.name[1], main ? 56 : 60, WHITE, GREY, 'small');
    if (mon.status || fainted) drawStatusIcon(ctx, fainted ? 'FNT' : mon.status, bx + R.lvl[0] - 4, by + R.lvl[1] + 2);
    else drawText(ctx, `{Lv}${mon.level}`, bx + R.lvl[0], by + R.lvl[1], WHITE, GREY, 'small');
    const hpText = `${Math.ceil(mon.hp)}/${mon.maxHp}`;
    drawText(ctx, hpText, bx + R.hpEnd - textWidth(hpText, 'small'), by + R.hpY, WHITE, GREY, 'small');
    drawHpFill(ctx, bx + R.bar[0], by + R.bar[1], mon.hp, mon.maxHp);
    if (i === this.flyingIdx) {
      // a small wing marker on the Pokémon you are riding
      ctx.fillStyle = '#f8f8f8'; ctx.fillRect(bx + (main ? 66 : 128), by + (main ? 12 : 4), 6, 2); ctx.fillRect(bx + (main ? 68 : 130), by + (main ? 10 : 2), 4, 2);
    }
  }
}

// Actions offered on the field party screen.
export function fieldActions(game) {
  return (mon, i, screen) => {
    const opts = [];
    const sp = species(mon.species);
    if (sp.canFly) {
      opts.push({ label: game.flying ? 'RIDE' : 'FLY', color: 'blue', run: () => game.partyFly(i, screen) });
    }
    opts.push({ label: 'SWITCH', run: () => screen.beginSwitch(i) });
    opts.push({ label: 'CANCEL', run: () => {} });
    return opts;
  };
}
