// Minecraft's HUD over the FireRed world: hotbar, hearts, hunger, armor and the experience bar, item
// icons with stack counts and durability bars, tooltips and action-bar text. Everything here is drawn
// on the full-resolution canvas (480x320), where one GBA pixel is two canvas pixels.
import { A } from './assets.js';
import { mcText, mcWidth, MC_COLOR } from './mcfont.js';
import { item, toolOf } from './items.js';

export const HW = 480, HH = 320;

export function drawIcon(ctx, id, x, y, size = 16) {
  const it = item(id);
  if (!it) return;
  const i = it.iconIndex;
  ctx.drawImage(A.mc.icons, (i % 32) * 16, Math.floor(i / 32) * 16, 16, 16, Math.round(x), Math.round(y), size, size);
}
// a one-pixel coloured outline round an item icon (its silhouette drawn at the four neighbouring offsets)
const rimCache = new Map();
export function iconRim(ctx, id, x, y, color) {
  const it = item(id);
  if (!it || !A.mc.icons) return;
  const key = id + color;
  let c = rimCache.get(key);
  if (!c) {
    const i = it.iconIndex;
    c = document.createElement('canvas'); c.width = 16; c.height = 16;
    const g = c.getContext('2d');
    g.drawImage(A.mc.icons, (i % 32) * 16, Math.floor(i / 32) * 16, 16, 16, 0, 0, 16, 16);
    g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, 16, 16);
    rimCache.set(key, c);
  }
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) ctx.drawImage(c, Math.round(x) + dx, Math.round(y) + dy);
}
// An inventory stack: icon, count in the corner, durability bar under damaged tools.
export function drawStack(ctx, s, x, y) {
  if (!s) return;
  drawIcon(ctx, s.id, x, y);
  const t = toolOf(s);
  if (t && s.dmg) {
    const f = Math.max(0, 1 - s.dmg / t.dur);
    const w = Math.round(13 * f);
    ctx.fillStyle = '#000'; ctx.fillRect(x + 2, y + 13, 13, 2);
    const hue = Math.round(f * 120);
    ctx.fillStyle = `hsl(${hue},100%,50%)`; ctx.fillRect(x + 2, y + 13, w, 1);
  }
  if (s.n > 1) { const txt = String(s.n); mcText(ctx, txt, x + 17 - mcWidth(txt), y + 9, '#ffffff'); }
}

// Experience: points needed for the next level, as in Java Edition.
export function xpForLevel(l) { return l >= 30 ? 9 * l - 158 : l >= 15 ? 5 * l - 38 : 2 * l + 7; }

export function drawHUD(ctx, G, t) {
  const P = G.P, inv = G.inv;
  // generated worlds' modes (the world update's 6.1): Creative draws the hotbar only, a spectator nothing, Hardcore
  // its own hearts (G.hcHearts, src/ui/hardcore.js); Classic (no G.mr) as ever
  const hud = G.mr ? G.mr.hud : 'full', bars = hud !== 'hotbar';
  if (hud === 'none') return;
  const x0 = Math.round((HW - 182) / 2), yb = HH - 22;
  ctx.drawImage(A.mc.gui_hotbar, x0, yb);
  ctx.drawImage(A.mc.gui_hotbar_selection, x0 - 1 + inv.sel * 20, yb - 1);
  for (let i = 0; i < 9; i++) drawStack(ctx, inv.slots[i], x0 + 3 + i * 20, yb + 3);
  // experience bar and level
  const yx = yb - 7;
  if (bars) ctx.drawImage(A.mc.gui_xp_bg, x0, yx);
  const need = xpForLevel(P.level);
  const w = bars ? Math.floor((P.xpProgress / need) * 183) : 0;
  if (w > 0) ctx.drawImage(A.mc.gui_xp_fill, 0, 0, w, 5, x0, yx, w, 5);
  if (bars && P.level > 0) {
    const s = String(P.level), lx = Math.round(HW / 2 - mcWidth(s) / 2), ly = yx - 7;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) mcText(ctx, s, lx + dx, ly + dy, '#000000', false);
    mcText(ctx, s, lx, ly, '#80ff20', false);
  }
  // hearts (left) and hunger (right), 10 each, 8px apart
  const yh = yx - 10;
  const hp = Math.ceil(P.health), max = 20;
  const blink = P.hurtFlash > 0 && Math.floor(P.hurtFlash * 10) % 2 === 0;
  const low = hp <= 4;
  if (hud === 'hardcore' && G.hcHearts) G.hcHearts(ctx, P, x0, yh, G.tick);
  else if (bars) for (let i = 0; i < max / 2; i++) {
    const x = x0 + i * 8;
    let y = yh;
    if (low) y += ((G.tick * 7 + i * 13) % 3) - 1;
    if (P.regenFlash > 0 && i === Math.floor((1 - P.regenFlash) * 10)) y -= 2;
    ctx.drawImage(blink ? A.mc.gui_heart_container_blinking : A.mc.gui_heart_container, x, y);
    const kind = P.poisoned ? 'poisoned_' : '';
    if (hp >= i * 2 + 2) ctx.drawImage(A.mc[`gui_heart_${kind}full`], x, y);
    else if (hp === i * 2 + 1) ctx.drawImage(A.mc[`gui_heart_${kind}half`], x, y);
  }
  if (P.absorb > 0 && bars && !(hud === 'hardcore' && G.hcHearts)) {
    for (let i = 0; i < Math.ceil(P.absorb / 2); i++) {
      const x = x0 + i * 8, y = yh - 10;
      ctx.drawImage(A.mc.gui_heart_container, x, y);
      ctx.drawImage(P.absorb >= i * 2 + 2 ? A.mc.gui_heart_absorbing_full : A.mc.gui_heart_absorbing_half, x, y);
    }
  }
  const hunger = P.hungerEffect > 0 ? '_hunger' : '';
  for (let i = 0; i < (bars ? 10 : 0); i++) {
    const x = x0 + 182 - 9 - i * 8;
    let y = yh;
    if (P.sat <= 0 && (G.tick + i * 7) % 24 < 2) y += 1;
    ctx.drawImage(A.mc[`gui_food_empty${hunger}`], x, y);
    if (P.food >= i * 2 + 2) ctx.drawImage(A.mc[`gui_food_full${hunger}`], x, y);
    else if (P.food === i * 2 + 1) ctx.drawImage(A.mc[`gui_food_half${hunger}`], x, y);
  }
  const armor = bars ? inv.armorPoints() : 0;
  if (armor > 0) {
    const ya = yh - 10 - (P.absorb > 0 ? 10 : 0);
    for (let i = 0; i < 10; i++) {
      const x = x0 + i * 8;
      ctx.drawImage(armor >= i * 2 + 2 ? A.mc.gui_armor_full : armor === i * 2 + 1 ? A.mc.gui_armor_half : A.mc.gui_armor_empty, x, ya);
    }
  }
  // held item name after switching, then action bar messages
  if (G.heldName && G.heldName.t > 0) {
    const a = Math.min(1, G.heldName.t / 0.5);
    ctx.globalAlpha = a;
    const s = G.heldName.text;
    mcText(ctx, s, Math.round(HW / 2 - mcWidth(s) / 2), yh - (armor > 0 ? 22 : 12), '#ffffff');
    ctx.globalAlpha = 1;
  }
  if (G.actionBar && G.actionBar.t > 0) {
    const a = Math.min(1, G.actionBar.t / 0.6);
    ctx.globalAlpha = a;
    const s = G.actionBar.text;
    mcText(ctx, s, Math.round(HW / 2 - mcWidth(s) / 2), yh - (armor > 0 ? 34 : 24), G.actionBar.color || '#ffffff');
    ctx.globalAlpha = 1;
  }
  void t;
}

// Minecraft's tooltip: a dark purple-bordered box with the item name (and extra lines).
export function drawTooltip(ctx, lines, x, y) {
  const w = Math.max(...lines.map((l) => mcWidth(l.text))) + 8;
  const h = lines.length * 10 + 4 + (lines.length > 1 ? 2 : 0);
  let tx = x + 12, ty = y - 12;
  if (tx + w > HW) tx = x - w - 4;
  if (ty + h > HH) ty = HH - h - 2;
  if (ty < 2) ty = 2;
  ctx.fillStyle = 'rgba(16,0,16,0.94)';
  ctx.fillRect(tx + 1, ty, w - 2, h); ctx.fillRect(tx, ty + 1, w, h - 2);
  const g = ctx.createLinearGradient(0, ty, 0, ty + h);
  g.addColorStop(0, 'rgba(80,0,255,0.31)'); g.addColorStop(1, 'rgba(40,0,127,0.31)');
  ctx.strokeStyle = g; ctx.lineWidth = 1; ctx.strokeRect(tx + 1.5, ty + 1.5, w - 3, h - 3);
  lines.forEach((l, i) => mcText(ctx, l.text, tx + 4, ty + 3 + i * 10 + (i > 0 ? 2 : 0), l.color || '#ffffff'));
}
export function tooltipLines(s) {
  const it = item(s.id);
  if (!it) return [{ text: s.id }];
  const lines = [{ text: it.name, color: it.ball ? MC_COLOR.aqua : (s.id.includes('diamond') || s.id === 'golden_apple') ? MC_COLOR.aqua : '#ffffff' }];
  const t = it.tool;
  if (t && ['sword', 'axe', 'pickaxe', 'shovel', 'hoe'].includes(t.kind)) {
    lines.push({ text: '' });
    lines.push({ text: 'When in Main Hand:', color: MC_COLOR.gray });
    lines.push({ text: ` ${t.dmg} Attack Damage`, color: MC_COLOR.darkGreen });
    lines.push({ text: ` ${t.rate} Attack Speed`, color: MC_COLOR.darkGreen });
  }
  if (t && s.dmg) lines.push({ text: `Durability: ${t.dur - s.dmg} / ${t.dur}`, color: '#ffffff' });
  if (it.armor) lines.push({ text: `+${it.armor.points} Armor`, color: MC_COLOR.blue });
  if (it.ball) lines.push({ text: 'Catches wild POKéMON', color: MC_COLOR.gray });
  return lines;
}

// Minecraft's advancement toast: slides in at the top right, holds for five seconds, slides out.
export function drawToast(ctx, toast, y0 = 0) {
  if (!toast) return;
  const t = toast.t, total = 5.6;
  const k = t < 0.5 ? t / 0.5 : t > total - 0.5 ? Math.max(0, (total - t) / 0.5) : 1;
  const e = 1 - (1 - k) * (1 - k);
  const x = Math.round(HW - 160 * e), y = y0;
  ctx.drawImage(A.mc.gui_toast, x, y);
  // the dragon egg is near-black on the toast's dark grey: a soft violet rim makes it read
  if (toast.icon === 'dragon_egg') iconRim(ctx, toast.icon, x + 8, y + 8, '#9a6ad0');
  drawIcon(ctx, toast.icon, x + 8, y + 8);
  mcText(ctx, toast.kind === 'challenge' ? 'Challenge Complete!' : toast.kind === 'goal' ? 'Goal Reached!' : 'Advancement Made!', x + 30, y + 7, toast.kind === 'challenge' ? '#ff88ff' : '#ffff00', false);
  mcText(ctx, toast.title, x + 30, y + 18, '#ffffff', false);
}
