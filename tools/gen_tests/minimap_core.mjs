// Track MAP's Node test (minimap-design.md 5.2): src/mapcore.js on its own, plus the static checks.
//
//   node tools/gen_tests/minimap_core.mjs
//
// The mask (get, set, count, hash); the reveal geometry (the 13-cell circle of block centres, clipped to a rectangle,
// the right onNew calls); the save record (round trips for empty, sparse, full and random masks at Classic's and the
// generated plane's sizes; every malformed record gives null); the majority rule with its priorities; palette expansion
// (Minecraft's four shades, index 0 never a class); the Classic sibling's play-time check; the guest keys' LRU of 4;
// sector8 against src/gen/sign.js's rule (once that file exists); cellPal of a cell whose chunk is not ready (the coarse
// or "not there yet" colour, never fog); mapcolor.json against the loaded tables; and a static check that the minimap's
// modules import nothing under src/gen/ or src/net/ but net/flag.js and reference no send path.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as MC from '../../src/mapcore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fails = [];
const check = (c, m) => { if (!c) { fails.push(m); console.error('FAIL', m); } else console.log('ok  ', m); };
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };

// ---- the mask
{
  const m = new MC.Mask(10, 7);
  check(m.bits.length === 9 && m.count() === 0 && !m.get(3, 3), 'a new mask is empty (10 x 7 blocks in 9 bytes)');
  check(m.set(3, 3) === true && m.set(3, 3) === false && m.get(3, 3) && m.count() === 1, 'set reports a new block once; get and count follow');
  check(m.set(-1, 0) === false && m.set(10, 0) === false && m.set(0, 7) === false && !m.get(-1, 2) && m.count() === 1, 'out-of-range blocks are never set');
  const h1 = m.hash(); m.set(9, 6);
  check(h1 !== m.hash() && m.count() === 2 && m.recount() === 2, 'the hash changes with the bits; recount agrees');
}
// ---- reveal geometry
{
  const sizes = MC.maskSize(2016, 1600);
  const m = new MC.Mask(sizes.w, sizes.h), got = [];
  const rect = { x: 416, y: 0, w: 1600, h: 1600 };
  const n = MC.revealAround(m, 1000, 800, rect, (bx, by) => got.push([bx, by]));
  let expect = 0, wrong = 0;
  for (let by = 0; by < sizes.h; by++) for (let bx = 0; bx < sizes.w; bx++) {
    const dx = bx * 4 + 2 - 1000, dy = by * 4 + 2 - 800, inside = dx * dx + dy * dy <= 169;
    if (inside) expect++;
    if (inside !== m.get(bx, by)) wrong++;
  }
  check(n === expect && got.length === n && wrong === 0, `reveal sets exactly the blocks whose centre is within 13 cells (${n})`);
  check(new Set(got.map((p) => p.join())).size === got.length, 'onNew is called once per new block');
  const again = MC.revealAround(m, 1000, 800, rect, () => { throw new Error('no'); });
  check(again === 0, 'revealing the same place again sets nothing');
  // clipped to a rectangle: a cave room's
  const m2 = new MC.Mask(sizes.w, sizes.h);
  const room = { x: 100, y: 1200, w: 30, h: 20 };
  MC.revealAround(m2, 102, 1202, room, null);
  let outside = 0, inside = 0;
  for (let by = 0; by < sizes.h; by++) for (let bx = 0; bx < sizes.w; bx++) {
    if (!m2.get(bx, by)) continue;
    const ov = bx * 4 + 3 >= room.x && bx * 4 <= room.x + room.w - 1 && by * 4 + 3 >= room.y && by * 4 <= room.y + room.h - 1;
    if (ov) inside++; else outside++;
  }
  check(inside > 0 && outside === 0, `a reveal never sets a block that misses its region rectangle (${inside} set)`);
  check(MC.revealAround(m2, 5, 5, null, null) === 0, 'no region (inside a building): nothing is revealed');
}
// ---- the save record
{
  const sizes = [[102, 266], [504, 400]];
  for (const [w, h] of sizes) {
    const masks = { empty: new MC.Mask(w, h), sparse: new MC.Mask(w, h), full: new MC.Mask(w, h), random: new MC.Mask(w, h) };
    for (let i = 0; i < 40; i++) masks.sparse.set(Math.floor(rnd() * w), Math.floor(rnd() * h));
    for (let by = 0; by < h; by++) for (let bx = 0; bx < w; bx++) { masks.full.set(bx, by); if (rnd() < 0.5) masks.random.set(bx, by); }
    for (const [name, m] of Object.entries(masks)) {
      const rec = MC.encode(m, name === 'sparse');
      const back = MC.decode(JSON.parse(JSON.stringify(rec)), w, h);
      check(!!back && back.mask.hash() === m.hash() && back.mask.count() === m.count() && back.k === (name === 'sparse'),
        `${w} x ${h} ${name}: the record round-trips (${rec.m.length} characters, ${m.count()} blocks)`);
    }
    check(MC.encode(masks.empty).m.length < 400, `${w} x ${h}: an empty mask's record is small`);
  }
  const m = new MC.Mask(102, 266); m.set(5, 5); m.set(50, 200);
  const rec = MC.encode(m, true), bad = [];
  const variants = {
    'null': null, 'a string': 'x', 'v 2': { ...rec, v: 2 }, 'block 8': { ...rec, b: 8 }, 'wrong w': { ...rec, w: 101 }, 'wrong h': { ...rec, h: 265 },
    'wrong n': { ...rec, n: rec.n + 1 }, 'not base64': { ...rec, m: '!!!!' }, 'short code': { ...rec, m: MC.toB64(MC.rleEncode(new Uint8Array(10))) },
    'long code': { ...rec, m: MC.toB64(MC.rleEncode(new Uint8Array(rec.n + 5))) }, 'no m': { ...rec, m: null }, 'garbage varint': { ...rec, m: MC.toB64(Uint8Array.from([255, 255, 255, 255, 255, 255])) },
    'odd length': { ...rec, m: rec.m.slice(1) },
  };
  // a set bit past w * h
  const tail = new Uint8Array(rec.n); tail[rec.n - 1] = 0x80;
  variants['tail bit'] = { ...rec, m: MC.toB64(MC.rleEncode(tail)) };
  for (const [k, v] of Object.entries(variants)) if (MC.decode(v, 102, 266) !== null) bad.push(k);
  check(bad.length === 0, 'every malformed record decodes to null' + (bad.length ? ': ' + bad.join(', ') : ''));
  check(MC.decode(rec, 102, 266) !== null, 'the well-formed record still decodes');
  // base64 against Node's
  const u = new Uint8Array(257); for (let i = 0; i < u.length; i++) u[i] = (i * 37) & 255;
  check(MC.toB64(u) === Buffer.from(u).toString('base64') && Buffer.compare(Buffer.from(MC.fromB64(MC.toB64(u))), Buffer.from(u)) === 0, 'base64 matches Node\'s both ways');
}
// ---- palette and colour tables
const mc = JSON.parse(readFileSync(path.join(ROOT, 'assets/world/mapcolor.json'), 'utf8'));
const cid = (n) => mc.classes.findIndex((c) => c[0] === n);
{
  const pal = MC.expandPalette(mc, true);
  const water = cid('water');
  const [r, g, b] = mc.classes[water][1];
  const sh = mc.shades;
  const ok = [0, 1, 2, 3].every((s) => { const p = pal.rgb[water * 4 + s]; return p[0] === Math.floor(r * sh[s] / 255) && p[1] === Math.floor(g * sh[s] / 255) && p[2] === Math.floor(b * sh[s] / 255); });
  check(ok && sh.join() === '180,220,255,135', "palette expansion: Minecraft's four shades (180, 220, 255, 135)");
  check(mc.classes[0][0] === 'none' && mc.classes.length <= 62 && mc.classes.length * 4 <= MC.FOG_A, 'class 0 is reserved (palette index 0 never a class) and the classes fit below the fog indices');
  check(pal.css[MC.FOG_A] === mc.fog[0] && pal.css[MC.FOG_B] === mc.fog[1] && pal.css[MC.PENDING] === mc.pending, 'the fog and "not there yet" colours are their own indices');
  const world = JSON.parse(readFileSync(path.join(ROOT, 'assets/world/world.json'), 'utf8')), terrain = JSON.parse(readFileSync(path.join(ROOT, 'assets/world/terrain.json'), 'utf8'));
  const classic = MC.entryClasses(world.entries, mc, { genBase: world.entries.length });
  const gen = MC.entryClasses(world.entries.concat(terrain.entries, [[-1, -1, 0x84, 1, 'sign', -1, 0, 0, -1, 0, 1]]), mc, { gen: true, genBase: world.entries.length, genCount: terrain.entries.length, atlasHash: terrain.atlasHash });
  check(classic.exact && gen.exact, 'mapcolor.json matches world.json and terrain.json (counts, generated base, atlas hash)');
  check(gen.cls[gen.cls.length - 1] === cid('wood'), "an entry past the tables (Track SIGN's sign) takes its material's class (wood)");
  const stale = MC.entryClasses(world.entries.concat(terrain.entries), mc, { gen: true, genBase: world.entries.length, genCount: terrain.entries.length, atlasHash: 'other' });
  check(!stale.exact && stale.cls[world.entries.length] > 0, 'a different atlas hash falls back to the material table (never 0)');
  // a few known entries
  check((classic.cls[473] & 127) === water && (classic.cls[13] & 128) && (classic.cls[13] & 127) === cid('grass_temperate'), 'Kanto: sea is water, tall grass is grass with the tall flag');
}
// ---- the majority rule
{
  const t = { water: cid('water'), path: cid('path'), building: new Uint8Array(64) };
  for (const n of ['roof_red', 'wall_white']) t.building[cid(n)] = 1;
  const G = cid('grass_temperate'), Wt = cid('water'), Pa = cid('path'), R = cid('roof_red'), S = cid('sand');
  const arr = (spec) => spec.flatMap(([c, n]) => new Array(n).fill(c));
  check(MC.majority16(arr([[G, 10], [Wt, 6]]), t) === Wt, 'water wins with 6 of 16');
  check(MC.majority16(arr([[G, 11], [Wt, 5]]), t) === G, 'water with 5 of 16 does not');
  check(MC.majority16(arr([[G, 10], [Pa, 6]]), t) === Pa, 'a path wins with 6 of 16');
  check(MC.majority16(arr([[G, 12], [R, 4]]), t) === R, 'a building wins with 4 of 16');
  check(MC.majority16(arr([[G, 13], [R, 3]]), t) === G, 'a building with 3 of 16 does not');
  check(MC.majority16(arr([[S, 8], [G, 8]]), t) === Math.min(S, G), 'a tie goes to the lowest class');
}
// ---- the Classic sibling and the guest keys
{
  check(MC.siblingOk({ pt: 12.5 }, 12.5) && !MC.siblingOk({ pt: 12.5 }, 12.6) && !MC.siblingOk(null, 0) && !MC.siblingOk({}, 0), "the Classic sibling is the save's only when its play time matches");
  let list = [];
  const drops = [];
  for (const k of ['a', 'b', 'c', 'd', 'e', 'b', 'f']) { const r = MC.lruTouch(list, k, 4); list = r.list; drops.push(...r.drop); }
  check(list.join() === 'd,e,b,f' && drops.join() === 'a,c', `the guest keys keep the 4 written last (${list.join()}; dropped ${drops.join()})`);
  check(MC.guestKey('wild', 1, -7) === 'poke-redstone-map:wild:1:-7' && MC.guestKey('classic') === 'poke-redstone-map:classic', 'guest keys name the type, generator version and seed');
}
// ---- sector8 against Track SIGN's rule
{
  const ref = (dx, dy) => { const t = Math.SQRT2 - 1, ax = Math.abs(dx), ay = Math.abs(dy); if (ay <= ax * t) return dx > 0 ? 2 : 6; if (ax <= ay * t) return dy < 0 ? 0 : 4; return dx > 0 ? (dy < 0 ? 1 : 3) : (dy > 0 ? 5 : 7); };
  let bad = 0, worst = 0;
  for (let dy = -60; dy <= 60; dy++) for (let dx = -60; dx <= 60; dx++) {
    if (MC.sector8(dx, dy) !== ref(dx, dy)) bad++;
    if (dx || dy) { const a = (Math.atan2(-dy, dx) * 180) / Math.PI, s = MC.sector8(dx, dy), c = (90 - s * 45 + 360) % 360; let d = Math.abs(((a - c) % 360 + 540) % 360 - 180); worst = Math.max(worst, d); }
  }
  check(bad === 0 && worst <= 22.5 + 1e-9, `sector8 is the design's rule (2.3) and within 22.5 degrees of the bearing (worst ${worst.toFixed(2)})`);
  check(MC.sector8(0, -5) === 0 && MC.sector8(5, 0) === 2 && MC.sector8(0, 5) === 4 && MC.sector8(-5, 0) === 6 && MC.sector8(5, -5) === 1, 'north is up: N 0, E 2, S 4, W 6, NE 1');
  const signFile = path.join(ROOT, 'src/gen/sign.js');
  if (existsSync(signFile)) {
    const S = await import(pathToFileURL(signFile).href);
    const fn = S.sector8 || S.dirOf || S.sectorOf || S.dir8;
    if (typeof fn === 'function') {
      let diff = 0;
      for (let dy = -60; dy <= 60; dy++) for (let dx = -60; dx <= 60; dx++) if (fn(dx, dy) !== MC.sector8(dx, dy)) diff++;
      check(diff === 0, `sector8 equals src/gen/sign.js's ${fn.name} on every (dx, dy) in -60..60 squared`);
    } else console.log('note: src/gen/sign.js exports no sector function yet; compared with the design rule only');
  } else console.log('note: src/gen/sign.js not there yet; compared with the design rule only');
}
// ---- cellPal of cells whose chunk is not ready
{
  const W = 2016, H = 1600, cstate = new Uint8Array(63 * 50);
  const world = { W, H, grid: new Uint16Array(W * H), zone: new Uint8Array(W * H).fill(2), area: new Uint16Array(W * H), cstate, blocks: new Map(), layout: { ox: 416 } };
  const coarseCls = MC.fromB64(mc.coarse);
  const t = { cls: new Uint8Array(20000).fill(cid('grass_temperate')), heights: new Uint8Array(64), water: cid('water'), blockCls: {}, areaShade: new Uint8Array(4).fill(1), coarseCls, ox: 416, CW: 63 };
  const code = new Uint8Array(40000).fill(255);   // sea everywhere
  const a = MC.makeClassifier(world, { ...t, coarse: null }), b = MC.makeClassifier(world, { ...t, coarse: { n: 200, st: 8, code } });
  const x = 1000, y = 800, i = y * W + x;
  check(a.cellPal(i) === MC.PENDING, 'an unready cell without the coarse plan is "not there yet", not fog');
  check(b.cellPal(i) === cid('water') * 4 + MC.LOW, 'an unready cell with the coarse plan takes its coarse colour in the low shade');
  cstate[(y >> 5) * 63 + (x >> 5)] = 2;
  check(a.cellPal(i) === MC.FOG_A + ((x + y) & 1), 'once ready, a void cell (zone 2) is drawn as fog');
}
// ---- static: imports and send paths
{
  const files = ['src/minimap.js', 'src/mapcore.js', 'src/ui/mapscreen.js'];
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    const imports = [...src.matchAll(/(?:import\s[^'"]*from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const badImp = imports.filter((p) => /(^|\/)gen\//.test(p) || (/(^|\/)net\//.test(p) && !/net\/flag\.js$/.test(p)));
    check(badImp.length === 0, `${f} imports nothing under src/gen/ or src/net/ but net/flag.js (${imports.join(', ')})`);
    const code = src.replace(/\/\/[^\n]*/g, '');
    const sends = ['reliable', 'send(', '.post(', 'blob('].filter((s) => code.includes(s));
    check(sends.length === 0, `${f} references no send path` + (sends.length ? ': ' + sends.join(', ') : ''));
  }
}
console.log(fails.length ? `\n${fails.length} failure(s)` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
