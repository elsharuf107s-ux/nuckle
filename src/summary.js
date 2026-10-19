// Two FireRed-style picture pages: a party POKeMON's summary (from the party screen's SUMMARY) and a POKeDEX entry
// (A on a seen species in the dex list). Both show the species' front sprite, as FireRed's do. GBA pixels.
import { A } from './assets.js';
import { drawText, textWidth, drawFit } from './font.js';
import { drawWindow, VW, VH, FG, SH, wrap } from './ui.js';
import { move, species, expFor } from './data.js';

const front = (key, shiny) => { const m = A.mon[key]; return m && ((shiny && m.frontShiny) || m.front); };
function header(ctx, title, bg, band) {
  ctx.fillStyle = bg; ctx.fillRect(0, 0, VW, VH);
  ctx.fillStyle = band; ctx.fillRect(0, 0, VW, 18);
  drawText(ctx, title, 8, 1, '#f8f8f8', '#404040');
}
export function drawSummary(ctx, mon) {
  const sp = species(mon.species) || {};
  header(ctx, 'POKéMON INFO', '#88b8e8', '#3870b8');
  drawWindow(ctx, 4, 22, 96, 96);
  const img = front(mon.species, mon.shiny);
  if (img) ctx.drawImage(img, 0, 0, 64, 64, 20, 30, 64, 64);
  drawFit(ctx, mon.name, 12, 92, 84, FG, SH, 'small');
  drawText(ctx, `{Lv}${mon.level}`, 12, 102, FG, SH, 'small');
  drawWindow(ctx, 104, 22, 132, 96);
  const types = (sp.types || []).filter((t, i, a) => a.indexOf(t) === i).join('/');
  const rows = [['TYPE', types], ['HP', `${Math.ceil(mon.hp)}/${mon.maxHp}`], ['ATTACK', String(mon.atk)], ['DEFENSE', String(mon.def)], ['SP. ATK', String(mon.spa)], ['SP. DEF', String(mon.spd)], ['SPEED', String(mon.spe)]];
  rows.forEach(([k, v], i) => { drawText(ctx, k, 112, 27 + i * 11, FG, SH, 'small'); drawText(ctx, v, 228 - textWidth(v, 'small'), 27 + i * 11, FG, SH, 'small'); });
  if (sp.growth && mon.level < 100) {
    const lo = expFor(sp.growth, mon.level), hi = expFor(sp.growth, mon.level + 1), k = Math.max(0, Math.min(1, (mon.exp - lo) / (hi - lo)));
    drawText(ctx, 'EXP', 112, 106, FG, SH, 'small');
    ctx.fillStyle = '#505050'; ctx.fillRect(136, 110, 90, 4); ctx.fillStyle = '#40c8f8'; ctx.fillRect(136, 110, Math.round(90 * k), 4);
  }
  drawWindow(ctx, 4, 120, VW - 8, 36);
  (mon.moves || []).slice(0, 4).forEach((m, i) => {
    const mv = move(m.id), x = 12 + (i % 2) * 116, y = 126 + Math.floor(i / 2) * 13;
    drawText(ctx, mv ? mv.name : m.id, x, y, FG, SH, 'small');
    const pp = `${m.pp}/${m.maxPp}`;
    drawText(ctx, pp, x + 104 - textWidth(pp, 'small'), y, FG, SH, 'small');
  });
}
// an uncaught species' front sprite as a grey shape, made once per sprite
const shadows = new Map();
function shadowOf(img) {
  let c = shadows.get(img);
  if (!c) {
    c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = '#585858'; g.fillRect(0, 0, 64, 64);
    shadows.set(img, c);
  }
  return c;
}
export function drawDexEntry(ctx, key, caught) {
  const sp = species(key) || {}, dex = sp.dex || null;
  header(ctx, 'POKéDEX', '#d84040', '#b02828');
  drawWindow(ctx, 4, 22, 84, 76);
  const img = front(key, false);
  if (img) {
    if (caught) ctx.drawImage(img, 0, 0, 64, 64, 14, 28, 64, 64);
    else ctx.drawImage(shadowOf(img), 14, 28);
  }
  drawWindow(ctx, 92, 22, 144, 76);
  // the ENDER DRAGON and the WITHER are from beyond Kanto's 151: their numbers are where they come from (END, NETHER)
  const no = sp.id ? String(sp.id).padStart(3, '0') : dex && dex.no ? dex.no : dex && dex.category === 'END' ? 'END' : '???';
  drawText(ctx, `No. ${no}`, 100, 27, FG, SH);
  drawFit(ctx, sp.name || key, 100, 41, 128, FG, SH);
  const cat = dex ? `${dex.category} POKéMON` : (sp.types || []).filter((t, i, a) => a.indexOf(t) === i).join('/');
  drawText(ctx, cat, 100, 56, FG, SH, 'small');
  if (dex && caught) {
    drawText(ctx, `HT  ${dex.heightText}`, 100, 68, FG, SH, 'small');
    drawText(ctx, `WT  ${dex.weightText}`, 100, 80, FG, SH, 'small');
  }
  drawWindow(ctx, 4, 100, VW - 8, 56);
  if (caught && !(dex && dex.text) && sp.base) {
    // no entry text for this species: what Steve knows of it from his own, its base stats
    const b = sp.base, cells = [['HP', b[0]], ['ATTACK', b[1]], ['DEFENSE', b[2]], ['SP. ATK', b[3]], ['SP. DEF', b[4]], ['SPEED', b[5]]];
    drawText(ctx, 'BASE STATS', 12, 104, FG, SH, 'small');
    cells.forEach(([k, v], i) => {
      const x = 12 + (i % 3) * 76, y = 118 + Math.floor(i / 3) * 14, t = String(v);
      drawText(ctx, k, x, y, FG, SH, 'small'); drawText(ctx, t, x + 68 - textWidth(t, 'small'), y, FG, SH, 'small');
    });
    return;
  }
  const text = dex && caught ? dex.text : 'Catch it to learn more about it.';
  wrap(text, VW - 28, 'small').slice(0, 4).forEach((l, i) => drawText(ctx, l, 12, 104 + i * 12, FG, SH, 'small'));
}
