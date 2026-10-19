// FireRed's Hall of Fame (src/hall_of_fame.c), shown the first time Steve takes the exit portal home after the first
// dragon: each party POKeMON slides into its place in turn with its name and level, then the whole team with
// "Welcome to the HALL OF FAME!" under falling confetti, then Steve with his time, then a closing card in the game's
// own words. Layout from assets/ui/hof.json (tools/build_ender_dragon.py); the decomp's music (hall_of_fame).
import { A } from './assets.js';
import { G } from './game.js';
import { drawText, textWidth } from './font.js';
import { drawWindow, VW, VH, FG, SH } from './ui.js';
import { mcText, mcWidth } from './mcfont.js';
import { music, cry, sfx } from './audio.js';

const SLIDE = 0.6, HOLD = 1.7, WELCOME = 4.2, STEVE = 3.2, CARD_MIN = 2.2, CARD_MAX = 7;
export class HallOfFame {
  constructor(party, steve) {
    this.mons = party.slice(0, 6);
    this.steve = steve;
    this.layout = (this.mons.length > 3 ? HOF().full : HOF().half) || [];
    this.t = 0; this.i = 0; this.phase = this.mons.length ? 'mon' : 'welcome'; this.pt = 0;
    this.confetti = [];
    this.done = false;
    music.play(HOF().music || 'hall_of_fame');
    if (this.mons.length) cry(this.mons[0].species);
  }
  update(dt, input) {
    this.t += dt; this.pt += dt;
    const skip = input.just('a') || input.just('b');
    if (this.phase === 'mon') {
      if (this.pt >= SLIDE + HOLD || (skip && this.pt > SLIDE)) {
        this.i++; this.pt = 0;
        if (this.i >= this.mons.length) { this.phase = 'welcome'; sfx.select(); }
        else cry(this.mons[this.i].species);
      }
    } else if (this.phase === 'welcome') {
      if (Math.random() < dt * 30) this.confetti.push({ x: Math.random() * VW, y: -8, f: Math.floor(Math.random() * 17), vy: 30 + Math.random() * 30, ph: Math.random() * 6 });
      if (this.pt >= WELCOME || (skip && this.pt > 1)) { this.phase = 'steve'; this.pt = 0; }
    } else if (this.phase === 'steve') {
      if (this.pt >= STEVE || (skip && this.pt > 0.8)) { this.phase = 'card'; this.pt = 0; }
    } else if (this.phase === 'card') {
      if (this.pt >= CARD_MAX || (skip && this.pt > CARD_MIN)) { this.phase = 'out'; this.pt = 0; music.stop(1.2); }
    } else if (this.phase === 'out') {
      if (this.pt >= 1.2) this.done = true;
    }
    for (const c of this.confetti) { c.y += c.vy * dt; c.x += Math.sin(this.t * 3 + c.ph) * 12 * dt; }
    this.confetti = this.confetti.filter((c) => c.y < VH + 8);
  }
  pos(k, slide) {
    const L = this.layout[k] || [120, 64, 120, 64];
    const e = 1 - Math.pow(1 - Math.min(1, slide), 3);
    return [L[0] + (L[2] - L[0]) * e, L[1] + (L[3] - L[1]) * e];
  }
  drawMon(ctx, m, k, slide) {
    const img = A.mon[m.species] && ((m.shiny && A.mon[m.species].frontShiny) || A.mon[m.species].front);
    if (!img) return;
    const [cx, cy] = this.pos(k, slide);
    ctx.drawImage(img, 0, 0, 64, 64, Math.round(cx - 32), Math.round(cy - 32), 64, 64);
  }
  textBox(ctx, l1, l2) {
    // below the bottom row of sprites (their centres sit at y 88)
    drawWindow(ctx, 0, VH - 42, VW, 42);
    drawText(ctx, l1, 12, VH - 36, FG, SH);
    if (l2) drawText(ctx, l2, 12, VH - 20, FG, SH);
  }
  // GBA pixels
  draw(ctx) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, VW, VH);
    if (this.phase === 'card' || this.phase === 'out') { this.drawCard(ctx); return; }
    if (A.img.hofBg) ctx.drawImage(A.img.hofBg, 0, 0);
    if (this.phase === 'mon') {
      for (let k = 0; k < this.i; k++) this.drawMon(ctx, this.mons[k], k, 1);
      const m = this.mons[this.i];
      this.drawMon(ctx, m, this.i, this.pt / SLIDE);
      if (this.pt >= SLIDE) {
        const sp = A.dex.species[m.species], no = sp && sp.id ? String(sp.id).padStart(3, '0') : '???';
        this.textBox(ctx, `No. ${no}  ${m.name}`, `Lv. ${m.level}`);
      }
    } else if (this.phase === 'welcome') {
      for (let k = 0; k < this.mons.length; k++) this.drawMon(ctx, this.mons[k], k, 1);
      this.textBox(ctx, 'Welcome to the HALL OF FAME!', null);
      const cf = A.img.hofConfetti;
      if (cf) for (const c of this.confetti) ctx.drawImage(cf, 0, c.f * 8, 8, 8, Math.round(c.x), Math.round(c.y), 8, 8);
    } else if (this.phase === 'steve') {
      const k = Math.min(1, this.pt / 0.5);
      ctx.globalAlpha = 1 - k * 0.7;
      for (let j = 0; j < this.mons.length; j++) this.drawMon(ctx, this.mons[j], j, 1);
      ctx.globalAlpha = 1;
      const img = A.mc.portrait;
      if (img) ctx.drawImage(img, Math.round(VW / 2 - img.width / 2), Math.round(18 + (1 - k) * 20));
      const s = Math.floor(G.playTime || 0);
      this.textBox(ctx, G.myName || 'STEVE', `TIME  ${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`);
    }
  }
  drawCard(ctx) {
    const a = this.phase === 'out' ? Math.max(0, 1 - this.pt / 1.1) : Math.min(1, this.pt / 0.8);
    ctx.save();
    ctx.globalAlpha = a;
    const l1 = 'POKéMON REDSTONE VERSION', l2 = 'Thanks for playing!';
    drawText(ctx, l1, Math.round(VW / 2 - textWidth(l1) / 2), 58, '#f8f8f8', '#585858');
    drawText(ctx, l2, Math.round(VW / 2 - textWidth(l2) / 2), 84, '#f8f8f8', '#585858');
    ctx.restore();
  }
  // canvas pixels: a small Minecraft-font line on the card
  drawHi(ctx) {
    if (this.phase !== 'card') return;
    const a = Math.min(1, this.pt / 0.8);
    ctx.globalAlpha = a;
    const s = 'The End.';
    mcText(ctx, s, Math.round(240 - mcWidth(s) / 2), 220, '#a080c0', true);
    ctx.globalAlpha = 1;
  }
}
const HOF = () => A.hof || { full: [], half: [], music: 'hall_of_fame' };
