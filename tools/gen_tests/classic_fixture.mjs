#!/usr/bin/env node
// The Classic save fixture (world update, design 11.9 and stage 0): saves written by the pre-world-update game
// (an earlier build, v7-pre-world, kept in out/baselines/) with Nether, stronghold and End state, kept in tools/gen_tests/fixtures/, and
// the check that each still loads in the current tree to exactly the state it loads to in the baseline.
//
//   node tools/gen_tests/classic_fixture.mjs check   [--base out/baselines/v7-pre-world] [--ports 5643,5644] [--out dir]
//   node tools/gen_tests/classic_fixture.mjs capture [--from out/baselines/v7-pre-world] [--ports 5643]  [--out dir] [--to dir] [--force]
//
// capture writes its saves to --to (default <out>/captured), never into tools/gen_tests/fixtures unless --to names
// that folder and --force is given: the committed fixtures stand for saves players already have.
//
// capture plays one seeded game in the snapshot (hooks plus real key presses: placing, tilling, planting, a bed, a
// chest, a furnace, a tree, a Nether portal and a trip through it, the stronghold's entrance and frames, the dragon
// fight, its death and the Hall of Fame) and writes four saves taken at different moments:
//   classic-nether.json   back in Kanto beside the lit portal, the Nether visited and changed
//   classic-end-fight.json in The End mid-fight (crystals down, the dragon hurt), the stronghold's portal open
//   classic-end-dying.json in The End during the dragon's death sequence (loading finishes the ending)
//   classic-home.json     home at the bed after the Hall of Fame: the egg, the exit portal, kills 1
// check opens every fixture in the baseline and in the current tree (same seeded Math.random, empty storage apart
// from the save), runs 90 frames, and compares the sp_diff state digest plus G.end, the world's serialized edits and
// blocks, the canvas at three frames, and the bytes of a save written again by each tree. Any page error or
// G.errors entry fails it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIX = path.join(HERE, 'fixtures');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const MODE = argv[0] === 'capture' ? 'capture' : 'check';
const SNAP = path.join(ROOT, 'out', 'baselines', 'v7-pre-world');
const BASE = path.resolve(opt(MODE === 'capture' ? '--from' : '--base', SNAP));
const OUT = path.resolve(opt('--out', path.join(ROOT, 'out', 'gen-tests', 'classic_fixture')));
const CAP = path.resolve(opt('--to', path.join(OUT, 'captured')));   // where capture writes
const FORCE = argv.includes('--force');
const [PA, PB] = String(opt('--ports', '5643,5644')).split(',').map(Number);
mkdirSync(OUT, { recursive: true });
const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
const { chromium } = createRequire(import.meta.url)(pwDir);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.css': 'text/css' };
function serve(root, port) {
  const s = createServer(async (req, res) => {
    try {
      let u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (u.endsWith('/')) u += 'index.html';
      const f = path.join(root, u);
      if (!f.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end(); }
  });
  return new Promise((r, j) => { s.once('error', j); s.listen(port, '127.0.0.1', 511, () => r(s)); });
}
// the same page set-up as tools/sp_diff.mjs: counted, seeded Math.random, no live frames, empty storage
const INIT = `(() => {
  let s = 12345 >>> 0; window.__mr = 0;
  // the game's own RNG (src/rng.js) is seeded from Date.now() until __rs.seed(), and loading a save already draws from
  // it (spawnMob picks a facing), so the clock is pinned until the page is ready: both trees then load identically
  const realNow = Date.now.bind(Date);
  Date.now = () => (window.__rs && window.__rs.ready ? realNow() : 1767225600000);
  Math.random = () => { window.__mr++; s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try { if (!sessionStorage.getItem('keepSave')) localStorage.clear(); } catch (e) {}
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => (cb && cb.name === 'frame' ? 0 : raf(cb));
})();`;
// tools/sp_diff.mjs's digest, plus the whole End state and the place Steve stands
const DIGEST = () => {
  const h = window.__rs, G = h.G, P = h.P;
  const hs = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return x; };
  const r = (v) => (typeof v === 'number' ? Math.round(v * 1000) : v);
  const ents = G.ents.map((e) => [e.type, e.kind || e.species || '', e.tx, e.ty, r(e.x), r(e.y), r(e.fx), r(e.fy), e.hp, e.dead ? 1 : 0, e.dying ? 1 : 0, e.dir || '']);
  const m = h.world.mapAt(P.tx, P.ty);
  return {
    state: h.state(), map: m ? m.id : null,
    P: [P.tx, P.ty, P.dir, r(P.fx), r(P.fy), P.health, P.food, r(P.sat), P.level, P.xpTotal, P.moving ? 1 : 0, P.dead ? 1 : 0],
    inv: hs(JSON.stringify(G.inv.serialize())), time: r(G.time), day: G.day, money: G.money, score: G.score,
    nEnts: G.ents.length, ents: hs(JSON.stringify(ents)), parts: G.parts.length,
    world: hs(JSON.stringify(h.world.serialize())), end: JSON.stringify(G.end), lastPortal: JSON.stringify(G.lastPortal || null),
    spawnBed: JSON.stringify(G.spawnBed || null), seeded: G.seeded, adv: [...G.advancements].sort().join(),
    party: hs(JSON.stringify(G.party.map((m2) => [m2.species, m2.level, m2.hp, m2.exp]))), pc: G.pc.length, mr: window.__mr,
  };
};
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

const failures = [];
const check = (c, m) => { if (!c) { failures.push(m); console.error('FAIL', m); } else console.log('ok  ', m); return c; };
const log = (...a) => console.log(...a);
let browser; const servers = [];

async function open(port, q, save = null) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } });
  await ctx.addInitScript(INIT);
  if (save) await ctx.addInitScript(`try { sessionStorage.setItem('keepSave', '1'); localStorage.setItem('poke-redstone-v1', ${JSON.stringify(save)}); } catch (e) {}`);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/${q}`);
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
  await page.evaluate(() => { window.__rs.pause(); window.__rs.seed(2026); });
  // the minimap (minimap-design.md 3.14) is hidden for the canvas comparison (in memory only; a no-op in a baseline)
  await page.evaluate(() => { if (window.__rs.minimap) window.__rs.minimap({ show: false }); });
  return { page, ctx, errors };
}

// ---------------------------------------------------------------- capture
async function capture() {
  const { page, errors } = await open(PA, '?new&play');
  const R = (expr) => page.evaluate(new Function('return (() => { const h = window.__rs, G = h.G, P = h.P, W = h.world, A = h.A; return (' + expr + '); })()'));
  const tick = (o = {}) => page.evaluate((x) => window.__rs.tick(x), { dt: 1 / 30, capture: false, ...o });
  const idle = async (n) => { for (let i = 0; i < n; i++) await tick(); };
  const untilR = async (expr, max = 900, o = {}) => { for (let i = 0; i < max; i++) { if (await R(expr)) return true; await tick(o); } return false; };
  // page helpers: a free outdoor grass cell near a point (with a free cell south of it to stand on), and a w x h
  // rectangle of them for a portal ring
  await page.evaluate(() => {
    const h = window.__rs, W = h.world;
    const free = (x, y) => W.isOutdoor(x, y) && !W.block(x, y) && !W.solid(x, y) && !W.protAt(x, y) && !W.warpAt(x, y) && !W.isWater(x, y) && !W.jumpDir(x, y) && W.isGrass(x, y);
    const taken = new Set();
    window.__fx = {
      free,
      cellNear(x0, y0) {
        for (let r = 1; r < 20; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = x0 + dx, y = y0 + dy;
          if (taken.has(x + ',' + y) || taken.has(x + ',' + (y + 1))) continue;
          if (free(x, y) && free(x, y + 1)) { taken.add(x + ',' + y); return [x, y]; }
        }
        return null;
      },
      rectNear(x0, y0, w, hh) {
        for (let r = 2; r < 30; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          let ok = true;
          for (let y = y0 + dy - 1; y <= y0 + dy + hh + 1 && ok; y++) for (let x = x0 + dx - 1; x <= x0 + dx + w && ok; x++) if (!free(x, y) || taken.has(x + ',' + y)) ok = false;
          if (ok) { for (let y = y0 + dy - 1; y <= y0 + dy + hh + 1; y++) for (let x = x0 + dx - 1; x <= x0 + dx + w; x++) taken.add(x + ',' + y); return [x0 + dx, y0 + dy]; }
        }
        return null;
      },
    };
  });
  const save = async (name) => {
    const ok = await R('h.save()');
    const s = await page.evaluate(() => localStorage.getItem('poke-redstone-v1'));
    check(ok && !!s, `${name}: saved (${s ? (s.length / 1024).toFixed(1) : 0} KiB)`);
    const d = JSON.parse(s);
    writeFileSync(path.join(CAP, name + '.json'), s);
    log(`  ${name}: Steve (${d.P.tx}, ${d.P.ty}), ${d.world.edits.length} edits, ${d.world.blocks.length} blocks, ${d.ents.length} entities, lastPortal ${JSON.stringify(d.lastPortal)}, spawnBed ${JSON.stringify(d.spawnBed)}, end ${JSON.stringify({ kills: d.end.kills, egg: d.end.egg, exit: d.end.exitActive, hp: d.end.dragon.hp, dying: d.end.dragon.dying || null, crystals: d.end.crystals.filter((c) => c.alive).length })}`);
    const shot = await page.evaluate(() => window.__rs.frame());
    writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.split(',')[1], 'base64'));
    return d;
  };
  // a block or item used on the cell (x, y) from the cell south of it, through the game's own B (use)
  const use = async (id, n, x, y, slot = 8) => {
    await R(`(h.teleport(${x}, ${y + 1}, 'up'), G.inv.slots[${slot}] = { id: '${id}', n: ${n} }, G.inv.sel = ${slot}, 1)`);
    await tick({ press: 'b' }); await idle(5);
    return R(`W.block(${x}, ${y})`);
  };
  mkdirSync(CAP, { recursive: true });

  // ---- Kanto: a kit, a party, a box, money, time
  await R(`(h.giveEndKit(), h.addMon('PIKACHU', 14), h.addMon('BULBASAUR', 9), G.pc.push(h.addMon('RATTATA', 4)), G.party.pop(), h.money(4321), h.setTime(3000), 1)`);
  const start = await R('[P.tx, P.ty]');
  log('  start', start);
  // placed blocks, a chest with things in it, a furnace smelting, farmland with wheat, a sapling, a lit campfire, a bed
  const c1 = await R(`__fx.cellNear(${start[0]}, ${start[1]})`);
  check(!!(await use('cobblestone', 64, ...c1)), 'cobblestone placed by B');
  const c2 = await R(`__fx.cellNear(${start[0]}, ${start[1]})`);
  const chest = await use('chest', 1, ...c2);
  check(chest && chest.id === 'chest', 'chest placed by B');
  await R(`(() => { const b = W.block(${c2[0]}, ${c2[1]}); b.slots = b.slots || new Array(27).fill(null); b.slots[0] = { id: 'iron_ingot', n: 7 }; b.slots[4] = { id: 'bread', n: 3 }; b.slots[26] = { id: 'diamond', n: 1 }; W.setBlock(${c2[0]}, ${c2[1]}, b); h.setState('play'); return 1; })()`);
  await idle(3); await R(`(h.setState('play'), 1)`);
  const c3 = await R(`__fx.cellNear(${start[0]}, ${start[1]})`);
  const furnace = await use('furnace', 1, ...c3);
  check(furnace && furnace.id === 'furnace', 'furnace placed by B');
  await R(`(() => { const b = W.block(${c3[0]}, ${c3[1]}); Object.assign(b, { input: { id: 'raw_iron', n: 5 }, fuel: { id: 'coal', n: 2 } }); W.setBlock(${c3[0]}, ${c3[1]}, b); return 1; })()`);
  const c4 = await R(`__fx.cellNear(${start[0]}, ${start[1]})`);
  await use('wooden_hoe', 1, ...c4);
  const crop = await use('wheat_seeds', 8, ...c4);
  check(!!crop, `wheat planted by B on tilled ground (${crop && crop.id})`);
  const c5 = await R(`__fx.cellNear(${start[0]}, ${start[1]})`);
  const sap = await use('oak_sapling', 2, ...c5);
  check(!!sap, `sapling planted by B (${sap && sap.id})`);
  const c6 = await R(`__fx.cellNear(${start[0]}, ${start[1]})`);
  const camp = await use('campfire', 1, ...c6);
  check(!!camp, `campfire placed by B (${camp && camp.id})`);
  const c7 = await R(`__fx.cellNear(${start[0] + 3}, ${start[1] + 3})`);
  const bed = await use('white_bed', 1, ...c7);
  check(bed && bed.id === 'white_bed', 'bed placed by B');
  if (!(await R('G.spawnBed'))) { await R(`(h.setTime(13000), 1)`); await use('white_bed', 1, ...c7); await untilR(`h.state() === 'play' && !P.sleeping`, 900, { press: 'a' }); }
  if (!(await R('G.spawnBed'))) await R(`(G.spawnBed = [${c7[0]}, ${c7[1]}], 1)`);
  log('  spawnBed', await R('G.spawnBed'), 'time', await R('G.time'), 'state', await R('h.state()'));
  await R(`(h.setState('play'), 1)`);
  // a tree cut down with A (an edit of tiles), a dropped stack, a boat
  const tree = await R(`(() => { for (let r = 1; r < 25; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = P.tx + dx, y = P.ty + dy; if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; if (W.findTree(x, y) && W.isOutdoor(x, y + 1) && !W.solid(x, y + 1) && !W.block(x, y + 1) && !W.isWater(x, y + 1)) return [x, y]; } return null; })()`);
  const edits0 = await R('W.edits.size');
  if (tree) {
    await R(`(h.teleport(${tree[0]}, ${tree[1] + 1}, 'up'), G.inv.slots[8] = { id: 'diamond_axe', n: 1 }, G.inv.sel = 8, 1)`);
    for (let i = 0; i < 240 && (await R(`!!W.findTree(${tree[0]}, ${tree[1]})`)); i++) await tick({ hold: 'a' });
  }
  check(tree && (await R('W.edits.size')) > edits0, `a tree cut down with A at ${JSON.stringify(tree)} (edits ${edits0} -> ${await R('W.edits.size')})`);
  await R(`(h.E.dropItem('apple', 5, (P.tx + 1) * 16, P.ty * 16), 1)`);
  await idle(40);

  // ---- the Nether: a portal ring near Pallet Town, lit, through it, a change there, and back
  const pr = await R(`__fx.rectNear(${start[0]}, ${start[1] - 4}, 2, 3)`);
  check(!!pr, `room for a portal at ${JSON.stringify(pr)}`);
  await R(`(h.buildPortal(${pr[0]}, ${pr[1]}), h.lightPortal(${pr[0]}, ${pr[1]}), 1)`);
  check(await R(`W.isPortal(${pr[0]}, ${pr[1] + 2})`), 'portal lit');
  await R(`(h.teleport(${pr[0]}, ${pr[1] + 2}, 'down'), h.enterNether(), 1)`);
  await idle(30);
  check(await R('W.inNether(P.tx, P.ty)'), 'in the Nether');
  const nArr = await R('[P.tx, P.ty]');
  const nc = await R(`(() => { for (let r = 1; r < 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = P.tx + dx, y = P.ty + dy; if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; if (W.inNether(x, y) && !W.solid(x, y) && !W.block(x, y) && !W.solid(x, y + 1) && !W.block(x, y + 1) && !W.isLava(x, y) && !W.isLava(x, y + 1) && !W.isPortal(x, y + 1) && !W.isPortal(x, y)) return [x, y]; } return null; })()`);
  check(!!(await use('cobblestone', 64, ...nc)), `cobblestone placed in the Nether at ${JSON.stringify(nc)}`);
  // netherrack mined with A
  const rack = await R(`(() => { for (let r = 1; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = P.tx + dx, y = P.ty + dy; if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; if (W.inNether(x, y) && W.mat(x, y) === 'netherrack' && W.inNether(x, y + 1) && !W.solid(x, y + 1) && !W.block(x, y + 1) && !W.isLava(x, y + 1) && !W.isPortal(x, y + 1)) return [x, y]; } return null; })()`);
  if (rack) {
    const t0 = await R(`W.tile(${rack[0]}, ${rack[1]})`);
    await R(`(h.teleport(${rack[0]}, ${rack[1] + 1}, 'up'), G.inv.slots[8] = { id: 'diamond_pickaxe', n: 1 }, G.inv.sel = 8, 1)`);
    for (let i = 0; i < 120 && (await R(`W.tile(${rack[0]}, ${rack[1]}) === ${t0}`)); i++) await tick({ hold: 'a' });
    check(await R(`W.tile(${rack[0]}, ${rack[1]}) !== ${t0}`), `netherrack mined with A at ${JSON.stringify(rack)}`);
  } else check(false, 'netherrack found near the arrival');
  await idle(20);
  await R(`(h.teleport(${nArr[0]}, ${nArr[1]}, 'down'), h.leaveNether(), 1)`);
  await idle(40);
  check(await R(`!W.inNether(P.tx, P.ty) && W.isPortal(P.tx, P.ty)`), 'back in Kanto, on the portal');
  // step off the portal (south), so the fixture loads standing beside it
  await R(`(h.teleport(${pr[0]}, ${pr[1] + 4}, 'down'), 1)`);
  await idle(10);
  await save('classic-nether');

  // ---- the stronghold: Route 23's entrance opened, a chest taken from, the frames filled (portal open)
  check(await R('h.revealEntrance()'), "Route 23's stronghold entrance opened");
  await R(`(h.enterStronghold(), 1)`);
  await idle(20);
  check(await R('W.inStronghold(P.tx, P.ty)'), 'in the stronghold');
  const sChest = await R(`(() => { for (const [i, b] of W.blocks) { if (b.id !== 'chest') continue; const x = i % W.W, y = Math.floor(i / W.W); if (W.inStronghold(x, y) && (b.slots || []).some(Boolean)) return [x, y]; } return null; })()`);
  if (sChest) await R(`(() => { const b = W.block(${sChest[0]}, ${sChest[1]}); const k = b.slots.findIndex(Boolean); G.inv.add(b.slots[k].id, b.slots[k].n); b.slots[k] = null; W.setBlock(${sChest[0]}, ${sChest[1]}, b); return 1; })()`);
  check(!!sChest, `a stronghold chest emptied of one stack at ${JSON.stringify(sChest)}`);
  await R('h.fillFrames(12)');
  check(await R('h.END.portalOpen()'), 'the twelve frames filled and the portal open');

  // ---- The End: crystals destroyed, the dragon hurt, a block placed, fighting for a while
  await R(`(h.enterEnd(), 1)`);
  await idle(30);
  check(await R('W.inEnd(P.tx, P.ty)'), 'in The End');
  await R(`(h.killCrystals(4), h.setDragonHP(130), 1)`);
  const ec = await R(`(() => { for (let r = 1; r < 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = P.tx + dx, y = P.ty + dy; if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; if (W.inEnd(x, y) && !W.isEndVoid(x, y) && !W.solid(x, y) && !W.block(x, y) && !W.isEndVoid(x, y + 1) && !W.solid(x, y + 1) && !W.block(x, y + 1)) return [x, y]; } return null; })()`);
  check(!!(await use('obsidian', 16, ...ec)), `obsidian placed in The End at ${JSON.stringify(ec)}`);
  await R(`(P.health = 20, 1)`);
  for (let i = 0; i < 150; i++) { await tick(); if (await R('P.dead')) break; }
  await R(`(P.health = 20, P.food = 20, 1)`);
  check(await R('!P.dead && W.inEnd(P.tx, P.ty) && h.state() === "play"'), 'still alive in The End after 5 s of the fight');
  await save('classic-end-fight');

  // ---- the dragon's death: saved during the sequence, then the ending, the egg, the exit portal
  await R(`(h.DR.startDeath(), 1)`);
  await idle(90);
  check(await R('!!G.end.dragon.dying'), 'the death sequence running');
  await R(`(P.health = 20, 1)`);
  await save('classic-end-dying');
  await untilR('!G.end.dragon.dying && G.end.kills === 1', 600);
  check(await R('G.end.kills === 1 && G.end.exitActive && G.end.egg === "pillar"'), 'the ending: kills 1, the exit portal active, the egg on its pillar');
  await idle(60);
  // home through the exit portal: the Hall of Fame first, then the bed
  await R(`(h.leaveEnd(), 1)`);
  check(await R('h.state() === "hof"'), 'the Hall of Fame');
  await untilR('h.state() === "play"', 3000, { press: 'a' });
  check(await R('h.state() === "play" && !W.inEnd(P.tx, P.ty) && G.end.hofSeen'), `home after the Hall of Fame at (${await R('[P.tx, P.ty]')})`);
  await idle(30);
  await save('classic-home');
  check(!errors.length, 'no page errors: ' + errors.join(' | '));
  const gErr = await R('(G.errors || []).slice(0, 3)');
  check(!gErr.length, 'G.errors empty: ' + gErr.join(' | '));
  writeFileSync(path.join(CAP, 'README.txt'), [
    'Classic save fixtures for the world update (design 11.9). Written by:',
    '  node tools/gen_tests/classic_fixture.mjs capture --from out/baselines/v7-pre-world',
    'on ' + new Date().toISOString().slice(0, 10) + ' from the v7-pre-world snapshot (the co-op release plus the portal-walk fix and the dormant',
    'Wither data). Each is the localStorage value of poke-redstone-v1 (v: 1). Checked by the same tool without "capture".',
    'Do not regenerate them from a later tree: they stand for saves players already have.', ''].join('\n'));
}

// ---------------------------------------------------------------- check
async function checkAll() {
  const files = readdirSync(FIX).filter((f) => f.endsWith('.json')).sort();
  check(files.length >= 4, `${files.length} fixtures in ${path.relative(ROOT, FIX)}`);
  for (const f of files) {
    const save = readFileSync(path.join(FIX, f), 'utf8');
    const A = await open(PA, '?play', save), B = await open(PB, '?play', save);
    const step = () => (x) => window.__rs.tick(x);
    let canvasDiff = 0, firstDiff = null;
    for (let i = 0; i < 90; i++) {
      const capture = i === 0 || i === 44 || i === 89;
      const x = { dt: 1 / 30, capture };
      const [ca, cb] = await Promise.all([A.page.evaluate(step(), x), B.page.evaluate(step(), x)]);
      if (capture) {
        const [da, db] = await Promise.all([A.page.evaluate(DIGEST), B.page.evaluate(DIGEST)]);
        if (JSON.stringify(da) !== JSON.stringify(db) && !firstDiff) firstDiff = { frame: i, a: da, b: db };
        if (sha(ca) !== sha(cb)) { canvasDiff++; writeFileSync(path.join(OUT, f.replace('.json', `_f${i}_base.png`)), Buffer.from(ca.split(',')[1], 'base64')); writeFileSync(path.join(OUT, f.replace('.json', `_f${i}_cur.png`)), Buffer.from(cb.split(',')[1], 'base64')); }
        if (i === 89) log(`  ${f}: state ${db.state}, map ${db.map}, Steve (${db.P[0]}, ${db.P[1]}), ents ${db.nEnts}, end ${db.end.slice(0, 160)}...`);
      }
    }
    if (firstDiff) console.error('  first difference:', JSON.stringify(firstDiff).slice(0, 2000));
    check(!firstDiff, `${f}: state identical to the baseline's at frames 1, 45 and 90 (Steve, inventory, party, entities with their facing, world, G.end, lastPortal, bed, Math.random draws)`);
    check(canvasDiff === 0, `${f}: canvas identical at the 3 checkpoints (${canvasDiff} differ)`);
    const [ra, rb] = await Promise.all([A.page.evaluate(() => { window.__rs.save(); return localStorage.getItem('poke-redstone-v1'); }), B.page.evaluate(() => { window.__rs.save(); return localStorage.getItem('poke-redstone-v1'); })]);
    check(ra === rb, `${f}: saving again writes byte-identical saves in both trees (${(rb.length / 1024).toFixed(1)} KiB)`);
    check(!A.errors.length && !B.errors.length, `${f}: no page errors ` + [...A.errors, ...B.errors].join(' | '));
    const gErr = await B.page.evaluate(() => (window.__rs.G.errors || []).slice(0, 3));
    check(!gErr.length, `${f}: G.errors empty in the current tree ` + gErr.join(' | '));
    await Promise.all([A.ctx.close(), B.ctx.close()]);
  }
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  if (MODE === 'capture') {
    const existing = (() => { try { return readdirSync(CAP).filter((f) => f.endsWith('.json')); } catch (e) { return []; } })();
    if (path.resolve(CAP) === path.resolve(FIX) && !FORCE) throw new Error(`refusing to capture into the committed fixtures (${path.relative(ROOT, FIX)}) without --force`);
    if (existing.length && !FORCE) throw new Error(`refusing to overwrite ${existing.length} saves in ${CAP} without --force`);
    servers.push(await serve(BASE, PA)); log(`capturing from ${BASE} into ${CAP}`); await capture();
  }
  else { servers.push(await serve(BASE, PA), await serve(ROOT, PB)); log(`baseline ${BASE}, current ${ROOT}`); await checkAll(); }
} catch (e) {
  failures.push('harness: ' + ((e && e.stack) || e));
  console.error(e);
} finally {
  if (browser) await browser.close();
  for (const s of servers) s.close();
}
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ failures }, null, 2));
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
