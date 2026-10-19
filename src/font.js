// FireRed's latin_normal and latin_small fonts: glyph atlases (black = foreground, red = shadow),
// variable advance widths, and the game's own charmap.
import { A } from './assets.js';

const fonts = {};
const colored = new Map();

export function initFont() {
  const make = (img, widths, cellW, cellH, cols) => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    return { atlas: x.getImageData(0, 0, img.width, img.height), widths, cellW, cellH, cols };
  };
  fonts.normal = make(A.img.font, A.font.widths, 16, 16, 16);
  fonts.small = make(A.img.fontSmall, A.fontSmall.widths, 8, 16, 32);
}

function atlasFor(font, fg, shadow) {
  const key = font + '|' + fg + '|' + shadow;
  if (colored.has(key)) return colored.get(key);
  const { atlas } = fonts[font];
  const c = document.createElement('canvas');
  c.width = atlas.width; c.height = atlas.height;
  const x = c.getContext('2d');
  const out = x.createImageData(atlas.width, atlas.height);
  const f = hex(fg), s = hex(shadow);
  const src = atlas.data, dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] === 0) continue;
    const col = src[i] > 128 ? s : f; // red channel high = shadow pixel
    if (!col) continue;
    dst[i] = col[0]; dst[i + 1] = col[1]; dst[i + 2] = col[2]; dst[i + 3] = 255;
  }
  x.putImageData(out, 0, 0);
  colored.set(key, c);
  return c;
}
// Colours may be '#rrggbb', 'rgb(r,g,b)' or [r, g, b].
function hex(h) {
  if (!h) return null;
  if (Array.isArray(h)) return h;
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(h);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) throw new Error('bad text colour ' + h);
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function glyphId(ch) {
  const map = A.font.map;
  if (ch in map) return map[ch];
  if (ch === '"') return map['”'];          // inches in a dex entry's height (26'03")
  return map['?'];
}
// Special glyphs that are not single characters in the charmap.
const SPECIAL = { '♂': 0xB5, '♀': 0xB6, 'Lv': 0x34 };
function* glyphs(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { const j = text.indexOf('}', i); const name = text.slice(i + 1, j); i = j; yield SPECIAL[name] ?? glyphId('?'); continue; }
    yield ch === ' ' ? -1 : glyphId(ch);
  }
}

export function drawText(ctx, text, x, y, fg = '#383838', shadow = '#d8d8d8', font = 'normal') {
  const F = fonts[font];
  const sheet = atlasFor(font, fg, shadow);
  let cx = Math.round(x);
  for (const id of glyphs(text)) {
    const gid = id < 0 ? glyphId(' ') : id;
    const w = F.widths[gid] || (font === 'small' ? 5 : 6);
    if (id >= 0) ctx.drawImage(sheet, (gid % F.cols) * F.cellW, Math.floor(gid / F.cols) * F.cellH, F.cellW, F.cellH, cx, Math.round(y), F.cellW, F.cellH);
    cx += w;
  }
  return cx - Math.round(x);
}
export function textWidth(text, font = 'normal') {
  const F = fonts[font];
  let w = 0;
  for (const id of glyphs(text)) w += F.widths[id < 0 ? glyphId(' ') : id] || (font === 'small' ? 5 : 6);
  return w;
}
// A name in a fixed-width field (FireRed's 10-character name windows): drawn as it is when it fits, else with its
// word spaces narrowed to one pixel (ENDER DRAGON, the one 12-character name, in the battle and party boxes).
// The narrowed space is as wide as the field allows (at least 1 px), so the words still read as two.
export function drawFit(ctx, text, x, y, maxW, fg, shadow, font = 'normal') {
  if (textWidth(text, font) <= maxW || !text.includes(' ')) return drawText(ctx, text, x, y, fg, shadow, font);
  const words = text.split(' '), ww = words.reduce((n, w) => n + textWidth(w, font), 0);
  const gap = Math.max(1, Math.min(textWidth(' ', font), Math.floor((maxW - ww) / (words.length - 1))));
  let cx = x;
  for (const word of words) cx += drawText(ctx, word, cx, y, fg, shadow, font) + gap;
  return cx - gap - x;
}
export function drawSmall(ctx, text, x, y, fg, shadow) { return drawText(ctx, text, x, y, fg, shadow, 'small'); }
