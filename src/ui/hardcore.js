// Hardcore's screens (the world update's design, 6.4): Minecraft's hardcore death screen ("Game over!", the death
// message, the score, then "Spectate World" and "Title Screen"), the spectator overlay, and the hardcore hearts for
// hud.js. Not wired into the game yet (stage 8a does that); tools/gen_tests/menus.mjs drives them headless.
//
// The death screen does not save anything itself: the caller writes the world list's dead marker
// (modes.js hardcoreDeath) and starts the full save BEFORE it opens this screen, so no button press, reload or failed
// save can bring the world back. Its result is { op: 'spectate' } or { op: 'title' }.
import { A } from '../assets.js';
import { mcText, mcWidth } from '../mcfont.js';
import { GHOST_ALPHA } from '../modes.js';
import { W, H, WHITE, M, drawButton, inside, PointerMode, sound, loadMenuAssets } from './mcgui.js';

export { GHOST_ALPHA };

export class HardcoreDeathScreen {
  // opts: { cause (the death message), score }
  constructor({ cause = '', score = 0 } = {}) {
    this.kind = 'hardcoreDeath';
    this.cause = String(cause || ''); this.score = Number(score) || 0;
    this.t = 0; this.sel = 0; this.done = false; this.result = null; this.pm = new PointerMode(); this.hover = -1;
    loadMenuAssets();
    const bx = Math.round(W / 2 - 100);
    this.buttons = [
      { label: 'Spectate World', op: 'spectate', x: bx, y: Math.round(H / 4 + 72), w: 200, h: 20 },
      { label: 'Title Screen', op: 'title', x: bx, y: Math.round(H / 4 + 96), w: 200, h: 20 },
    ];
  }
  // Minecraft enables the buttons after 20 ticks, so a held key cannot skip the screen
  get active() { return this.t >= 1; }
  update(dt, input) { try { this.step(dt, input); } catch (e) { if (!this.fault) console.error(e); this.fault = true; } }
  step(dt, input) {
    this.t += dt;
    const useMouse = this.pm.update(input);
    this.hover = useMouse ? this.buttons.findIndex((b) => inside(input.mouse, b)) : -1;
    if (!this.active) return;
    if (input.just('up') || input.just('down')) { this.sel ^= 1; sound('click'); return; }
    if (input.just('mouseL')) { const i = this.buttons.findIndex((b) => inside(input.mouse, b)); if (i >= 0) this.choose(i); return; }
    if (input.just('a') || input.just('start')) this.choose(this.sel);
  }
  choose(i) { sound('click'); this.result = { op: this.buttons[i].op }; this.done = true; }
  draw(ctx) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    // Minecraft's red gradient over the frozen world
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(80,0,0,0.38)'); g.addColorStop(1, 'rgba(128,48,48,0.63)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const t1 = 'Game over!';
    mcText(ctx, t1, Math.round(W / 2 - mcWidth(t1, 2) / 2), Math.round(H / 4 - 12), WHITE, true, 2);
    if (this.cause) mcText(ctx, this.cause, Math.round(W / 2 - mcWidth(this.cause) / 2), Math.round(H / 4 + 18), WHITE);
    const st = 'Score: ', num = String(this.score), sw = mcWidth(st + num);
    mcText(ctx, st, Math.round(W / 2 - sw / 2), Math.round(H / 4 + 34), WHITE);
    mcText(ctx, num, Math.round(W / 2 - sw / 2 + mcWidth(st) + 1), Math.round(H / 4 + 34), '#ffff55');
    this.buttons.forEach((b, i) => drawButton(ctx, b.x, b.y, b.w, b.h, b.label,
      { hover: this.active && (i === this.hover || (!this.pm.useMouse && i === this.sel)), active: this.active }));
    ctx.restore();
  }
}

// The spectator overlay: no HUD (6.1), Steve drawn at 35% (the caller wraps his drawing in ghost()), and for the
// first seconds after the death (and again whenever show() is called) the death message as an action-bar line.
export class SpectatorOverlay {
  constructor({ cause = '' } = {}) { this.kind = 'spectator'; this.cause = String(cause || ''); this.t = 0; this.shownT = 4; }
  show(seconds = 4) { this.shownT = seconds; }
  update(dt) { this.t += dt; if (this.shownT > 0) this.shownT = Math.max(0, this.shownT - dt); }
  draw(ctx) {
    if (!(this.shownT > 0) || !this.cause) return;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = Math.min(1, this.shownT / 0.6);
    mcText(ctx, this.cause, Math.round(W / 2 - mcWidth(this.cause) / 2), H - 46, '#ffffff');
    ctx.restore();
  }
}
// Draw something (Steve, his held item) as a spectator: at 35% alpha.
export function ghost(ctx, fn) { ctx.save(); ctx.globalAlpha *= GHOST_ALPHA; try { fn(); } finally { ctx.restore(); } }

// Hardcore hearts in hud.js's layout (ten hearts 8 px apart from x0, at y), with the same blinking, low-health shake
// and regeneration bounce as the survival row. P is the player (health, hurtFlash, regenFlash, poisoned, absorb).
export function drawHardcoreHearts(ctx, P, x0, y, tick = 0) {
  const hp = Math.ceil(P.health || 0);
  const blink = P.hurtFlash > 0 && Math.floor(P.hurtFlash * 10) % 2 === 0;
  const low = hp <= 4;
  const cont = M(blink ? 'heart_hardcore_container_blinking' : 'heart_hardcore_container') || A.mc.gui_heart_container;
  const kind = P.poisoned ? 'poisoned_' : '';
  for (let i = 0; i < 10; i++) {
    const x = x0 + i * 8;
    let yy = y;
    if (low) yy += ((tick * 7 + i * 13) % 3) - 1;
    if (P.regenFlash > 0 && i === Math.floor((1 - P.regenFlash) * 10)) yy -= 2;
    if (cont) ctx.drawImage(cont, x, yy);
    const full = M(`heart_hardcore_${kind}full`), half = M(`heart_hardcore_${kind}half`);
    if (hp >= i * 2 + 2 && full) ctx.drawImage(full, x, yy);
    else if (hp === i * 2 + 1 && half) ctx.drawImage(half, x, yy);
  }
  if (P.absorb > 0) {
    for (let i = 0; i < Math.ceil(P.absorb / 2); i++) {
      const x = x0 + i * 8, yy = y - 10, img = M(P.absorb >= i * 2 + 2 ? 'heart_hardcore_absorbing_full' : 'heart_hardcore_absorbing_half');
      if (cont) ctx.drawImage(cont, x, yy);
      if (img) ctx.drawImage(img, x, yy);
    }
  }
}
