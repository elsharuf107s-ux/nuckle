// Minecraft's bitmap font (textures/font/ascii.png): 8x8 cells, widths measured from the glyphs the
// way Minecraft measures them, drawn with its quarter-brightness drop shadow.
import { A } from './assets.js';

const tinted = new Map();
function atlas(color) {
  if (tinted.has(color)) return tinted.get(color);
  const img = A.mc.font;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  tinted.set(color, c);
  return c;
}
const eTinted = new Map();
function eSheet(color) {
  if (eTinted.has(color)) return eTinted.get(color);
  const c = document.createElement('canvas'); c.width = 9; c.height = 12;
  const x = c.getContext('2d'); x.drawImage(A.mc.fontE, 0, 0);
  x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, 9, 12);
  eTinted.set(color, c); return c;
}
function shadowOf(color) {
  const n = parseInt(color.slice(1), 16);
  const r = ((n >> 16) & 255) >> 2, g = ((n >> 8) & 255) >> 2, b = (n & 255) >> 2;
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
const code = (ch) => { const c = ch.charCodeAt(0); return c < 128 ? c : 63; };
// é comes from Minecraft's accented sheet (taller cells, three pixels higher)
const eac = () => A.mcFont.eacute;
export function mcWidth(text, scale = 1) {
  let w = 0;
  for (const ch of String(text)) w += ch === 'é' ? eac().w : (A.mcFont.widths[code(ch)] || 6);
  return (w - 1) * scale;
}
export function mcText(ctx, text, x, y, color = '#ffffff', shadow = true, scale = 1) {
  text = String(text);
  if (shadow) draw(ctx, text, x + scale, y + scale, shadowOf(color), scale);
  draw(ctx, text, x, y, color, scale);
  return mcWidth(text, scale);
}
function draw(ctx, text, x, y, color, scale) {
  const sheet = atlas(color);
  let cx = Math.round(x);
  for (const ch of text) {
    if (ch === 'é') {
      ctx.drawImage(eSheet(color), 0, 0, 9, 12, cx, Math.round(y) + eac().dy * scale, 9 * scale, 12 * scale);
      cx += eac().w * scale; continue;
    }
    const c = code(ch);
    if (c !== 32) ctx.drawImage(sheet, (c % 16) * 8, Math.floor(c / 16) * 8, 8, 8, cx, Math.round(y), 8 * scale, 8 * scale);
    cx += (A.mcFont.widths[c] || 6) * scale;
  }
}
// Minecraft's formatting colours, for tooltips and chat-style messages.
export const MC_COLOR = { white: '#ffffff', gray: '#aaaaaa', darkGray: '#555555', yellow: '#ffff55', gold: '#ffaa00', red: '#ff5555',
  green: '#55ff55', aqua: '#55ffff', blue: '#5555ff', lightPurple: '#ff55ff', darkGreen: '#00aa00', label: '#404040', xp: '#80ff20' };
