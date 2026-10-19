#!/usr/bin/env node
// Render generated worlds with flat biome colours (design 4.8; the tile renders come with stage 3b's painters).
//
//   node tools/gen_render.mjs --type wild|kanto --seed S [--px 800] [--out file.png] [--plan]
//        whole-world overview with a legend, the world border, Kanto's box and the shape-check counts; with --plan
//        (stage 3c) also the plan's villages (orange boxes), cave mouths (black dots) and spawn (red ring)
//   node tools/gen_render.mjs --type T --seed S --crop x,y,w,h [--zoom 4] [--out file.png]
//        a crop at `zoom` pixels per cell, biome boundaries outlined
//   node tools/gen_render.mjs --dump DIR [...]
//        render a gen_dump.mjs output instead of generating
//   node tools/gen_render.mjs --sheet T --seeds 1,2,3,4 [--px 400] [--out file.png]
//        a contact sheet of overviews
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Img } from './gen_png.mjs';
import { dump, parseSeed, ROOT } from './gen_dump.mjs';
import { BIOMES, B } from '../src/gen/biomes.js';

const BORDER = 8;

function fromDumpDir(dir) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const [x0, y0, w, h] = meta.rect;
  const rd = (f) => new Uint8Array(readFileSync(path.join(dir, f)));
  return { meta, r: { x0, y0, w, h, biome: rd('biome.bin'), water: rd('water.bin'), land: rd('land.bin') } };
}

// draw a region's biome colours into img at (ox, oy), `s` cells per pixel (s >= 1) or `z` pixels per cell
function paint(img, r, ox, oy, { s = 1, z = 1 } = {}) {
  const W = Math.floor(r.w / s) * z, H = Math.floor(r.h / s) * z;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const cx = Math.floor((px / z) * s), cy = Math.floor((py / z) * s);
      img.set(ox + px, oy + py, BIOMES[r.biome[cy * r.w + cx]].rgb);
    }
  }
  if (z >= 3) {
    // outline biome boundaries in a crop, so every step is visible
    for (let cy = 0; cy < r.h; cy++) {
      for (let cx = 0; cx < r.w; cx++) {
        const b = r.biome[cy * r.w + cx];
        if (cx + 1 < r.w && r.biome[cy * r.w + cx + 1] !== b) for (let k = 0; k < z; k++) img.set(ox + (cx + 1) * z - 1, oy + cy * z + k, [0, 0, 0]);
        if (cy + 1 < r.h && r.biome[(cy + 1) * r.w + cx] !== b) for (let k = 0; k < z; k++) img.set(ox + cx * z + k, oy + (cy + 1) * z - 1, [0, 0, 0]);
      }
    }
  }
  return { W, H };
}

function legend(img, x, y, census, total) {
  let yy = y;
  for (const b of BIOMES) {
    if (!b.id) continue;
    const n = census[b.key] || 0;
    img.fill(x, yy, 14, 10, b.rgb); img.rect(x, yy, 14, 10, [60, 60, 60]);
    img.text(x + 20, yy + 2, `${b.name || b.key} ${n ? ((100 * n) / total).toFixed(1) + '%' : '-'}`, n ? [20, 20, 20] : [170, 170, 170]);
    yy += 15;
  }
  return yy;
}

export function overview(meta, r, px = 800, out) {
  const s = r.w / px;
  const img = new Img(px + 230, Math.max(px, 470), [250, 250, 248]);
  paint(img, r, 0, 0, { s });
  const map = (v) => Math.round(v / s);
  // the world border (8 cells inside the overworld edge)
  if (r.w === 1600) img.rect(map(BORDER), map(BORDER), map(1600 - 2 * BORDER), map(1600 - 2 * BORDER), [255, 60, 60]);
  if (meta.kanto) { const k = meta.kanto; img.rect(map(k.x - r.x0), map(k.y - r.y0), map(k.w), map(k.h), [0, 0, 0]); }
  for (const sm of meta.checks.seamSamples || []) img.circle(map(sm[0] - r.x0), map(sm[1] - r.y0), 6, [255, 0, 255]);
  for (const sm of meta.checks.tintSamples || []) img.circle(map(sm[0] - r.x0), map(sm[1] - r.y0), 6, [255, 120, 0]);
  if (meta.plan) {
    for (const v of meta.plan.villages) {
      img.rect(map(v.x0 - r.x0), map(v.y0 - r.y0), Math.max(2, map(v.w)), Math.max(2, map(v.h)), [255, 120, 0]);
      img.rect(map(v.x0 - r.x0) + 1, map(v.y0 - r.y0) + 1, Math.max(1, map(v.w) - 2), Math.max(1, map(v.h) - 2), [255, 120, 0]);
    }
    for (const c of meta.plan.caves) img.circle(map(c.x - r.x0), map(c.y - r.y0), 3, [0, 0, 0]);
    const sp = meta.plan.spawn;
    img.circle(map(sp.x - r.x0), map(sp.y - r.y0), 9, [230, 0, 0]);
    img.circle(map(sp.x - r.x0), map(sp.y - r.y0), 8, [230, 0, 0]);
  }
  const x = px + 10;
  img.text(x, 6, `${meta.type} ${meta.seedInput}`, [0, 0, 0], 2);
  img.text(x, 26, `seed ${meta.seed}`);
  const c = meta.checks;
  img.text(x, 38, `tint pairs ${c.tintPairs}`, c.tintPairs ? [200, 0, 0] : [0, 120, 0]);
  img.text(x, 48, `straight seams ${c.seams} (max ${c.longestRun})`, c.seams ? [200, 0, 0] : [0, 120, 0]);
  legend(img, x, 64, meta.census, r.w * r.h);
  if (meta.plan) {
    const pl = meta.plan, y = Math.max(px, 470) - 50;
    img.text(x, y, `plan ${pl.hash}`);
    img.text(x, y + 10, `villages ${pl.villages.length} (orange)  caves ${pl.caves.length} (black)`);
    img.text(x, y + 20, `spawn ${pl.spawn.x},${pl.spawn.y} rung ${pl.spawn.rung} (red)`);
    img.text(x, y + 30, `rooms ${pl.rooms}  maps ${pl.maps}  warps ${pl.warps}`);
  }
  if (out) img.save(out);
  return img;
}

export function crop(meta, r, zoom, out) {
  const img = new Img(r.w * zoom, r.h * zoom + 14, [250, 250, 248]);
  paint(img, r, 0, 14, { z: zoom });
  img.text(2, 3, `${meta.type} ${meta.seedInput} (${r.x0},${r.y0}) ${r.w}X${r.h}`);
  if (out) img.save(out);
  return img;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const px = Number(opt('--px', 800));
  if (opt('--sheet')) {
    const type = opt('--sheet'), seeds = opt('--seeds', '1,2,3,4').split(',').map(parseSeed);
    const cols = Number(opt('--cols', 4)), rows = Math.ceil(seeds.length / cols);
    const cell = px + 230;
    const sheet = new Img(cols * cell, rows * Math.max(px, 470), [250, 250, 248]);
    seeds.forEach((sd, i) => {
      const { r, meta } = dump(type, sd, { tune: opt('--tune') ? JSON.parse(opt('--tune')) : null });
      const im = overview(meta, r, px);
      const ox = (i % cols) * cell, oy = Math.floor(i / cols) * Math.max(px, 470);
      for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) { const k = (y * im.w + x) * 3; sheet.set(ox + x, oy + y, [im.px[k], im.px[k + 1], im.px[k + 2]]); }
      console.log(`${type} ${sd}: tint pairs ${meta.checks.tintPairs}, seams ${meta.checks.seams}, longest ${meta.checks.longestRun}`);
    });
    console.log(sheet.save(path.resolve(opt('--out', path.join(ROOT, 'out', 'gen', `sheet_${type}.png`)))));
  } else {
    let meta, r;
    const cropArg = opt('--crop');
    if (opt('--dump')) ({ meta, r } = fromDumpDir(path.resolve(opt('--dump'))));
    else {
      const o = { tune: opt('--tune') ? JSON.parse(opt('--tune')) : null, plan: argv.includes('--plan') };
      if (cropArg) o.rect = cropArg.split(',').map(Number);
      ({ meta, r } = dump(opt('--type', 'wild'), parseSeed(opt('--seed')), o));
    }
    const out = path.resolve(opt('--out', path.join(ROOT, 'out', 'gen', `${meta.type}_${meta.seedInput}${cropArg ? '_crop' : ''}.png`)));
    if (cropArg) crop(meta, r, Number(opt('--zoom', 4)), out);
    else overview(meta, r, px, out);
    console.log(out, `tint pairs ${meta.checks.tintPairs}, seams ${meta.checks.seams}, longest ${meta.checks.longestRun}`);
  }
}

export { B };
