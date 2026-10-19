#!/usr/bin/env node
// Renders the Pokémon Redstone showcase deterministically: drives the game one frame at a time through
// window.__rs.tick() in headless Chrome, records every sound against game time, renders the audio
// offline in the page, and assembles an MP4 with ffmpeg.
//
//   node tools/render_video.mjs [out.mp4]          the whole film
//   SEG=mine,smelt node tools/render_video.mjs     only some segments (each sets up its own state)
//   PREVIEW=1 ...                                   also writes a contact sheet of every 20th frame
//
// The run: title; Steve arrives in Pallet Town and punches a tree; crafts planks, a crafting table and a
// wooden pickaxe; tunnels into Route 22's cliffs for stone, coal, iron, redstone and a diamond; smelts
// iron; crafts Poké Balls; catches a wild MANKEY; builds a house in Pallet Town; fights zombies and a
// skeleton at night; a creeper kills him; respawns at his bed, sleeps to morning while the zombies burn;
// eats; fishes up a MAGIKARP and fights it; rows a boat down the channel and around a sandbar on Route 21.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'pokemon-redstone.mp4'));
const WORK = path.join(ROOT, 'out', 'work');
const FRAMES = path.join(WORK, 'frames');
const PORT = 5302;
const FPS = 30;
const ONLY = process.env.SEG ? process.env.SEG.split(',') : null;

const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
const { chromium } = createRequire(import.meta.url)(pwDir);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(path.dirname(OUT), { recursive: true });

const server = spawn('python3', [path.join(ROOT, 'serve.py'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/?new&video`);
await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 60000 });
await page.evaluate(() => { const h = window.__rs; h.pause(); h.seed(2026); h.startAudio(); h.rules.encounters = false; h.rules.warps = false; h.rules.wild = false; localStorage.removeItem('poke-redstone-music'); });

// ---------------------------------------------------------------- frame capture
let n = 0;
let skip = 1;            // time-lapse: capture one frame in `skip`
let skipCount = 0;
async function tick(opts = {}) {
  const capture = (skipCount++ % skip) === 0;
  const url = await page.evaluate((o) => window.__rs.tick(o), { dt: 1 / FPS, capture, ...opts });
  if (url) writeFileSync(path.join(FRAMES, String(n++).padStart(5, '0') + '.png'), Buffer.from(url.split(',')[1], 'base64'));
}
const idle = async (frames) => { for (let i = 0; i < frames; i++) await tick(); };
const press = async (key, after = 6) => { await tick({ press: key }); await idle(after - 1); };
const holdFor = async (key, frames) => { for (let i = 0; i < frames; i++) await tick({ hold: key, press: i === 0 ? key : undefined }); };
const R = (expr) => page.evaluate(new Function('return (() => { const h = window.__rs, G = h.G, P = h.P, W = h.world; return ' + expr + '; })()'));
const run = (fn, arg) => page.evaluate(fn, arg);
async function timelapse(k, fn) { const s = skip; skip = k; skipCount = 0; await fn(); skip = s; skipCount = 0; }

// Wait on the game, pressing A through messages once each has been on screen for `read` frames.
async function until(pred, { max = 3000, read = 30, pressMsgs = true } = {}) {
  let shownFor = 0;
  for (let i = 0; i < max; i++) {
    const st = await page.evaluate((p) => {
      const h = window.__rs, b = h.battle();
      let msgDone = false, needPress = false;
      if (h.state() === 'battle' && b && b.cur && b.cur.type === 'msg') {
        msgDone = b.cur.shown >= b.cur.pages[b.cur.page].join('').length; needPress = b.cur.press || b.cur.page < b.cur.pages.length - 1;
      } else if (h.msg()) {
        const m = h.msg(); msgDone = m.shown >= m.pages[m.page].join('').length; needPress = !m.ask;
      }
      return { done: new Function('h', 'b', 'G', 'P', 'return ' + p)(h, b, h.G, h.P), msgDone, needPress };
    }, pred);
    if (st.done) return;
    if (pressMsgs && st.msgDone && st.needPress) { if (++shownFor >= read) { shownFor = 0; await tick({ press: 'a' }); continue; } }
    else shownFor = 0;
    await tick();
  }
  throw new Error('timed out waiting for: ' + pred);
}
const battleIdle = (ui) => `h.state() === 'battle' && b && !b.cur && !b.q.length && b.ui === '${ui}'`;

// ---------------------------------------------------------------- moving Steve
async function walkTo(tx, ty, { run: sprint = false, max = 2000 } = {}) {
  // a waypoint something has since been built on is skipped; the next one routes around it
  if (await page.evaluate(([x, y]) => window.__rs.world.solid(x, y), [tx, ty])) return true;
  let detour = false;
  for (let g = 0; g < max; g++) {
    const [x, y, moving, st, dir, routed] = await page.evaluate(([tx, ty, detour]) => {
      const h = window.__rs, P = h.P, W = h.world;
      let dir = P.tx < tx ? 'right' : P.tx > tx ? 'left' : P.ty > ty ? 'up' : 'down';
      // straight lines as before; a breadth-first detour only when a block stands in the way
      const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const mob = new Set(h.G.ents.filter((e) => e.type === 'mob' && !e.dying).map((e) => e.tx + ',' + e.ty));
      const blocked = (x, y) => W.solid(x, y) || mob.has(x + ',' + y);
      const open = (x, y) => !blocked(x, y) && !W.isWater(x, y) && !W.jumpDir(x, y) && !W.pcDoor(x, y);
      let routed = false;
      // once off the straight line, stay on the route: mixing the two walks back and forth
      if ((P.tx !== tx || P.ty !== ty) && (detour || blocked(P.tx + D[dir][0], P.ty + D[dir][1]))) {
        const key = (x, y) => x + ',' + y, from = new Map([[key(tx, ty), null]]), q = [[tx, ty]];
        while (q.length && !from.has(key(P.tx, P.ty)) && from.size < 4000) {
          const [cx, cy] = q.shift();
          for (const [d, [dx, dy]] of Object.entries(D)) {
            const nx = cx + dx, ny = cy + dy, k = key(nx, ny);
            if (from.has(k) || (!open(nx, ny) && !(nx === P.tx && ny === P.ty))) continue;
            from.set(k, { up: 'down', down: 'up', left: 'right', right: 'left' }[d]); q.push([nx, ny]);
          }
        }
        if (from.get(key(P.tx, P.ty))) { dir = from.get(key(P.tx, P.ty)); routed = true; }
      }
      return [P.tx, P.ty, P.moving, h.state(), dir, routed];
    }, [tx, ty, detour]);
    if (routed) detour = true;
    if (st !== 'play') return false;
    if (x === tx && y === ty) { if (!moving) return true; await tick(); continue; }
    await tick({ hold: sprint ? [dir, 'sprint'] : dir });
  }
  const grid = await page.evaluate(([tx, ty]) => {
    const h = window.__rs, P = h.P, W = h.world, rows = [];
    const mob = new Set(h.G.ents.filter((e) => e.type === 'mob' && !e.dying).map((e) => e.tx + ',' + e.ty));
    for (let y = P.ty - 6; y <= P.ty + 6; y++) {
      let r = '';
      for (let x = P.tx - 9; x <= P.tx + 9; x++) r += x === P.tx && y === P.ty ? 'P' : x === tx && y === ty ? 'T' : mob.has(x + ',' + y) ? 'm' : W.solid(x, y) ? '#' : W.isWater(x, y) ? '~' : W.jumpDir(x, y) ? 'j' : '.';
      rows.push(r);
    }
    return `P at ${P.tx},${P.ty}\n` + rows.join('\n');
  }, [tx, ty]);
  throw new Error(`walkTo ${tx},${ty} stuck\n${grid}`);
}
async function walkPath(points, opts) { for (const [x, y] of points) await walkTo(x, y, opts); }
async function face(dir) {
  const cur = await R('P.dir');
  if (cur !== dir) { await tick({ press: dir }); await idle(5); }
}
async function slot(k) { await press('slot' + (k + 1), 8); }
async function selectItem(id) {
  const i = await R(`G.inv.slots.findIndex((s) => s && s.id === '${id}')`);
  if (i < 0) throw new Error('no ' + id);
  if (i >= 9) { await run((a) => { const inv = window.__rs.G.inv; const t = inv.slots[a.i]; inv.slots[a.i] = inv.slots[8]; inv.slots[8] = t; }, { i }); return slot(8); }
  return slot(i);
}
// Hold Z on whatever is in front until it breaks.
async function mine(maxFrames = 300) {
  for (let i = 0; i < maxFrames; i++) {
    await tick({ hold: 'a', press: i === 0 ? 'a' : undefined });
    const mining = await R('!!P.mining');
    if (i > 2 && !mining) { await idle(4); return true; }
  }
  return false;
}
async function use(after = 8) { await press('b', after); }
// Wait (briefly) for any animal standing on the target cell to wander off, then nudge it if needed.
async function clearFront() {
  for (let i = 0; i < 45; i++) {
    const busy = await R(`(() => { const f = h.PL.facing(P); return !!h.E.mobAt(f.x, f.y); })()`);
    if (!busy) return;
    await tick();
  }
  await run(() => {
    const h = window.__rs, f = h.PL.facing(h.P), m = h.E.mobAt(f.x, f.y);
    if (!m) return;
    for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [4, 2], [-4, 2]]) { const x = f.x + dx, y = f.y + dy; if (h.E.cellFree(x, y) && h.world.isFloor(x, y)) { m.tx = m.fx = m.fromX = x; m.ty = m.fy = m.fromY = y; m.moving = false; return; } }
  });
}
async function place(dir, id, after = 6) { await face(dir); if (id) await selectItem(id); await clearFront(); await use(after); }

// ---------------------------------------------------------------- container screens, with the slot cursor
async function screenSlot(kind, idx) {
  return run((a) => { const s = window.__rs.screen(); return s.slots.findIndex((q) => q.kind === a.kind && (a.idx == null || q.idx === a.idx)); }, { kind, idx });
}
async function cursorTo(kind, idx, gap = 3) {
  const target = await screenSlot(kind, idx);
  if (target < 0) throw new Error('no slot ' + kind + idx);
  for (let g = 0; g < 40; g++) {
    const st = await run((t) => { const s = window.__rs.screen(); return { sel: s.sel, dir: s.routeTo(t) }; }, target);
    if (st.sel === target) return;
    if (!st.dir) break;
    await press(st.dir, gap);
  }
  throw new Error('cursor stuck');
}
const invSlotOf = (id) => R(`G.inv.slots.findIndex((s) => s && s.id === '${id}')`);
async function leftClick(after = 5) { await press('a', after); }
async function rightClick(after = 4) { await press('b', after); }
async function shiftClick(after = 7) { await tick({ press: 'a', hold: 'sprint' }); await idle(after - 1); }
async function pickUp(id) { await cursorTo('inv', await invSlotOf(id)); await leftClick(); }
async function putBack() {
  // drop whatever the cursor holds into the first empty slot or a matching stack
  const t = await R(`(() => { const s = h.screen(); const c = s.cursor; if (!c) return -1; let i = G.inv.slots.findIndex((x) => x && x.id === c.id); if (i < 0) i = G.inv.slots.findIndex((x) => !x); return i; })()`);
  if (t >= 0) { await cursorTo('inv', t); await leftClick(); }
}
// Lay out a recipe in the grid by hand: rows of item ids (or null), one right-click per cell.
async function layRecipe(rows, offset = 0, times = 1) {
  const size = await R('h.screen().size');
  const cells = [];
  rows.forEach((r, y) => r.forEach((id, x) => { if (id) cells.push({ id, i: (y + offset) * size + x }); }));
  const ids = [...new Set(cells.map((c) => c.id))];
  for (const id of ids) {
    await pickUp(id);
    for (const c of cells.filter((q) => q.id === id)) { await cursorTo('grid', c.i); for (let k = 0; k < times; k++) await rightClick(); }
    await putBack();
  }
}
async function takeResult(shift = true) { await cursorTo('result'); if (shift) await shiftClick(); else { await leftClick(); await putBack(); } }
async function openInv() { await press('inv', 8); }
async function closeScreen() { await press('inv', 8); }

// ---------------------------------------------------------------- cuts
async function fadeOut(frames = 12) { for (let i = 1; i <= frames; i++) { await run((a) => window.__rs.setFade(a), i / frames); await tick(); } }
async function fadeIn(frames = 12) { for (let i = frames - 1; i >= 0; i--) { await run((a) => window.__rs.setFade(a), i / frames); await tick(); } }
async function setup(js, arg) { await run(js, arg); }
const wanted = (name) => !ONLY || ONLY.includes(name);

// The cliff the film tunnels into. The world keeps diamonds, redstone and lapis underground, so the film
// paints its own seam of ores into the rock (the atlas carries every ore over these rock pieces).
const FILM_ORES = [
  [14, 210, 'diamond'], [16, 210, 'iron'], [18, 210, 'iron'], [23, 210, 'redstone'], [25, 210, 'diamond'],
  [27, 210, 'coal'], [28, 210, 'coal'], [15, 211, 'diamond'], [22, 211, 'redstone'], [23, 211, 'iron'],
  [24, 211, 'coal'], [33, 211, 'coal'], [15, 212, 'coal'], [12, 213, 'coal'], [14, 213, 'iron'], [18, 213, 'coal'],
  [23, 213, 'coal'], [30, 213, 'lapis'], [24, 214, 'coal'], [17, 215, 'lapis'], [14, 216, 'iron'],
  [14, 217, 'diamond'], [16, 217, 'redstone'], [29, 217, 'iron'], [18, 218, 'coal'], [36, 218, 'gold'],
  [17, 219, 'iron'], [31, 219, 'emerald'], [34, 219, 'redstone'], [36, 219, 'coal'], [17, 220, 'coal'],
  [24, 220, 'redstone'], [36, 220, 'coal']
];
const paintOres = (cells) => {
  const W = window.__rs.world;
  for (const [x, y, ore] of cells) {
    const t = W.entries.findIndex((e) => e[4] === ore + '_ore' && e[5] === W.tile(x, y));
    if (t < 0) throw new Error(`no ${ore} ore over tile ${W.tile(x, y)} at ${x},${y}`);
    W.setTile(x, y, t);
  }
};

// ================================================================ the film
const segments = [];
const seg = (name, fn) => segments.push({ name, fn });

seg('title', async () => {
  await run(() => { window.__rs.playMusic('title'); });
  await idle(150);
  await press('start', 4);
  await idle(26);
});

seg('arrive', async () => {
  if (ONLY) await setup(() => { const h = window.__rs; h.startGame(); });
  await idle(30);
  await walkPath([[66, 270], [63, 270], [62, 270]]);
  await face('left');
  await idle(10);
});

seg('tree', async () => {
  if (ONLY) await setup(() => { const h = window.__rs; h.startGame(); h.teleport(62, 270, 'left'); });
  await mine(200);
  await idle(40);
  // a second tree, down the forest edge
  await walkTo(62, 272); await face('left');
  await mine(200);
  await idle(40);
});

seg('craft', async () => {
  if (ONLY) await setup(() => { const h = window.__rs; h.startGame(); h.teleport(62, 272, 'left'); h.give('oak_log', 8); });
  await openInv();
  await idle(15);
  // logs -> planks: the whole stack into the grid, then shift-click the result
  await pickUp('oak_log');
  await cursorTo('grid', 0); await leftClick(8);
  await takeResult(true);
  await idle(10);
  // planks -> crafting table
  await layRecipe([['oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks']]);
  await idle(8);
  await takeResult(true);
  await idle(10);
  // planks -> sticks (two crafts' worth)
  await layRecipe([['oak_planks'], ['oak_planks']], 0, 2);
  await takeResult(true);
  await idle(20);
  await closeScreen();
  await idle(10);
});

seg('table', async () => {
  if (ONLY) await setup(() => { const h = window.__rs; h.startGame(); h.teleport(62, 272, 'left'); h.give('crafting_table', 1); h.give('oak_planks', 8); h.give('stick', 8); });
  await walkTo(63, 273);
  await place('right', 'crafting_table', 10);
  await use(10);
  await idle(10);
  await layRecipe([['oak_planks', 'oak_planks', 'oak_planks'], [null, 'stick', null], [null, 'stick', null]]);
  await idle(8);
  await takeResult(true);
  await idle(16);
  await closeScreen();
  await selectItem('wooden_pickaxe');
  await idle(20);
});

seg('mine', async () => {
  await fadeOut();
  await setup(() => {
    const h = window.__rs, G = h.G;
    if (!G.inv.has('wooden_pickaxe')) { h.give('wooden_pickaxe', 1); h.give('stick', 6); h.give('crafting_table', 1); h.give('oak_planks', 4); }
    if (!G.inv.has('crafting_table')) h.give('crafting_table', 1);
    h.startGame(); h.teleport(24, 208, 'down'); h.setTime(2000);
  });
  await setup(paintOres, FILM_ORES);
  await selectItem('wooden_pickaxe');
  await fadeIn();
  await idle(20);
  await mine();                                      // (24,209)
  await walkTo(24, 209);
  await face('left'); await mine();                  // (23,209)
  await face('right'); await mine();                 // (25,209)
  await face('down'); await mine();                  // (24,210)
  await idle(20);
  // a crafting table in the tunnel, and a stone pickaxe
  await place('left', 'crafting_table', 8);
  await use(10);
  await timelapse(2, async () => {
    await layRecipe([['cobblestone', 'cobblestone', 'cobblestone'], [null, 'stick', null], [null, 'stick', null]]);
    await takeResult(true);
  });
  await idle(10);
  await closeScreen();
  await selectItem('stone_pickaxe');
  await idle(10);
  await walkTo(24, 210);
  await face('down'); await mine();                  // coal (24,211)
  await idle(10);
  await walkTo(24, 211);
  await face('left'); await mine();                  // iron (23,211)
  await idle(10);
  // one more block of stone, to show how quick the stone pickaxe is
  await face('right'); await mine();
  await idle(20);
});

seg('smelt', async () => {
  if (ONLY) await setup(() => { const h = window.__rs; h.startGame(); h.teleport(24, 211, 'up'); h.give('stone_pickaxe', 1); h.give('cobblestone', 10); h.give('coal', 3); h.give('raw_iron', 1); h.give('stick', 4); });
  // the crafting table is at (23,209); craft a furnace there
  await setup(() => { const h = window.__rs; h.give('cobblestone', Math.max(0, 11 - h.G.inv.count('cobblestone'))); });
  await walkTo(24, 209);
  await face('left'); await use(10);
  await timelapse(2, async () => {
    await layRecipe([['cobblestone', 'cobblestone', 'cobblestone'], ['cobblestone', null, 'cobblestone'], ['cobblestone', 'cobblestone', 'cobblestone']]);
    await takeResult(true);
  });
  await idle(8);
  await timelapse(2, async () => {
    await layRecipe([[null, 'cobblestone', null], [null, 'cobblestone', null], [null, 'stick', null]]);
    await takeResult(true);
  });
  await closeScreen();
  await idle(8);
  // (more iron and coal came out of the cliff off camera)
  await setup(() => { const h = window.__rs; h.give('raw_iron', 6 - h.G.inv.count('raw_iron')); h.give('coal', Math.max(0, 4 - h.G.inv.count('coal'))); });
  await place('right', 'furnace', 10);
  await use(12);
  await pickUp('raw_iron'); await cursorTo('fin'); await leftClick(6);
  await putBack();
  await pickUp('coal'); await cursorTo('fuel'); await leftClick(6);
  await putBack();
  await idle(30);
  // smelting takes ten seconds an ingot: run it eight times faster
  await timelapse(16, () => idle(60 * 30));
  await idle(20);
  await cursorTo('fout'); await shiftClick(10);
  await idle(20);
  // one cobblestone into stone, for a button
  await pickUp('cobblestone'); await cursorTo('fin'); await rightClick(4); await putBack();
  await timelapse(12, () => idle(11 * 30));
  await cursorTo('fout'); await shiftClick(10);
  await idle(10);
  await closeScreen();
});

seg('ironpick', async () => {
  if (ONLY) await setup(() => { const h = window.__rs; h.startGame(); h.teleport(24, 209, 'down'); h.give('iron_ingot', 6); h.give('stick', 4); h.give('stone', 1); h.give('stone_pickaxe', 1); });
  if (ONLY && !ONLY.includes('mine')) await setup(paintOres, FILM_ORES);
  await walkTo(24, 209);
  await face('left'); await use(10);
  await timelapse(2, async () => {
    await layRecipe([['iron_ingot', 'iron_ingot', 'iron_ingot'], [null, 'stick', null], [null, 'stick', null]]);
    await takeResult(true);
  });
  await closeScreen();
  await selectItem('iron_pickaxe');
  await walkTo(24, 210);
  await face('left'); await mine();                  // redstone (23,210)
  await idle(16);
  await face('right'); await mine();                 // diamond (25,210)
  await idle(40);
});

seg('balls', async () => {
  if (ONLY) await setup(() => { const h = window.__rs; h.startGame(); h.teleport(24, 210, 'up'); h.give('iron_ingot', 3); h.give('redstone', 4); h.give('stone', 1); });
  await walkTo(24, 209);
  await face('left'); await use(10);
  // a stone button, then the ball: redstone cap, iron shell, the button in the middle
  await layRecipe([[null, 'stone', null]], 1);
  await takeResult(true);
  await idle(8);
  await layRecipe([[null, 'redstone', null], ['iron_ingot', 'stone_button', 'iron_ingot'], [null, 'iron_ingot', null]]);
  await idle(20);
  await takeResult(true);
  await idle(30);
  await closeScreen();
  await idle(20);
});

seg('catch', async () => {
  await fadeOut();
  await setup(() => {
    const h = window.__rs, G = h.G, W = h.world;
    if (!G.inv.has('poke_ball')) h.give('poke_ball', 4);
    if (!G.inv.has('stone_sword')) h.give('stone_sword', 1);
    // the tall grass along Route 22's north side
    let spot = null;
    const r22 = W.maps.find((m) => m.id === 'MAP_ROUTE22');
    for (let y = r22.y; y < r22.y + r22.h && !spot; y++) for (let x = r22.x + 8; x < r22.x + r22.w; x++) if (W.tallGrass(x, y) && W.tallGrass(x + 1, y) && W.tallGrass(x + 2, y) && W.tallGrass(x + 3, y)) { spot = [x, y]; break; }
    h.startGame(); h.teleport(spot[0], spot[1], 'right'); h.setTime(4000);
    window.__spot = spot;
  });
  await selectItem('stone_sword');
  await fadeIn();
  await idle(15);
  await run(() => { const h = window.__rs; h.rules.encounters = true; h.seed(777); h.nextEncounter('MANKEY', 5); });
  await holdFor('right', 10);
  await until(`h.state() === 'battle'`);
  await until(battleIdle('action'), { read: 34 });
  await idle(12);
  // Two Poké Balls: the first shakes three times and MANKEY breaks out, MANKEY scratches back, the
  // second holds. Both are Gen 3's own capture formula; the film picks seeds for those outcomes the way
  // a speedrun picks its RNG.
  for (const want of ['almost', 'catch']) {
    await run((want) => {
      const h = window.__rs, b = h.battle(), E = b.E.mon, sp = h.A.dex.species[E.species];
      let odds = Math.floor((sp.catchRate * 10) / 10);
      odds = Math.floor((odds * (E.maxHp * 3 - E.hp * 2)) / (E.maxHp * 3));
      if (E.status) odds = Math.floor(odds * (E.status === 'SLP' || E.status === 'FRZ' ? 2 : 1.5));
      const B = Math.floor(1048560 / Math.floor(Math.sqrt(Math.floor(Math.sqrt(Math.floor(16711680 / Math.max(1, odds)))))));
      const usable = E.moves.filter((m) => m.pp > 0);
      const mul = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
      for (let seed = 1; seed < 20000; seed++) {
        const r = mul(seed);
        const mv = usable[Math.floor(r() * usable.length)];
        let k = 0; for (; k < 4 && Math.floor(r() * 65536) < B; k++);
        if (want === 'catch' ? k === 4 : (k === 3 && mv && mv.id === 'SCRATCH')) { h.seed(seed); return seed; }
      }
      return -1;
    }, want);
    if ((await R('h.battle().menu')) !== 1) await press('right', 8);
    await press('a', 14);
    await idle(16); await press('a', 4);
    await until(`h.state() !== 'battle' || (${battleIdle('action')})`, { read: 34, max: 4000 });
    if ((await R('h.state()')) !== 'battle') break;
    await idle(8);
  }
  await until(`h.state() === 'play'`, { read: 30 });
  await run(() => { window.__rs.rules.encounters = false; });
  await idle(80);
  await holdFor('left', 18);
  await idle(30);
});

seg('house', async () => {
  await fadeOut();
  await setup(() => { const h = window.__rs; h.give('oak_planks', 40); h.give('glass', 4); h.give('oak_door', 1); h.give('white_bed', 1); h.give('torch', 8); h.startGame(); h.teleport(64, 276, 'up'); h.setTime(9000); });
  await fadeIn();
  await idle(10);
  await timelapse(2, async () => {
    await walkTo(62, 276); await place('up', 'oak_planks');
    await walkTo(62, 277); await place('down', 'oak_planks');
    await walkTo(63, 277); await place('left', 'oak_planks'); await place('down', 'glass');
    await walkTo(63, 276); await place('left', 'oak_planks'); await place('up', 'oak_planks');
    await walkTo(64, 277); await place('down', 'oak_planks');
    await walkTo(65, 277); await place('down', 'glass');
    await walkTo(66, 277); await place('down', 'oak_planks');
    await walkTo(66, 276); await place('up', 'oak_planks');
    await walkTo(65, 276); await place('right', 'oak_planks'); await place('up', 'oak_planks');
    await walkTo(65, 277); await place('right', 'oak_planks');
    await walkTo(64, 276); await place('up', 'oak_door');
    await walkTo(65, 277); await place('left', 'white_bed');
    await walkTo(65, 276); await face('left'); await selectItem('torch'); await use(6);
  });
  await idle(20);
  // out through the door
  await walkTo(64, 276); await face('up'); await use(10);
  await walkTo(64, 274); await face('down'); await idle(10);
  await use(8); // shut the door behind him
  await walkPath([[63, 274], [63, 272]]); await face('down');
  await idle(40);
});

seg('night', async () => {
  await setup(() => { const h = window.__rs, G = h.G; if (!G.inv.has('stone_sword')) h.give('stone_sword', 1); if (!G.inv.has('torch')) h.give('torch', 4); h.startGame(); h.teleport(68, 272, 'down'); h.rules.mobs = false; h.setTime(11200);
    G.inv.armor = [{ id: 'iron_helmet', n: 1 }, { id: 'iron_chestplate', n: 1 }, { id: 'iron_leggings', n: 1 }, { id: 'iron_boots', n: 1 }]; });
  await selectItem('stone_sword');
  // sunset to night, sped up
  await timelapse(10, () => idle(30 * 60));
  await run(() => { window.__rs.music.stop(1.5); });
  await idle(30);
  await selectItem('torch'); await place('right', null, 10);
  await selectItem('stone_sword');
  await face('down');
  await setup(() => { const h = window.__rs; h.spawn('zombie', 72, 268); h.spawn('zombie', 64, 273); h.spawn('skeleton', 76, 268); });
  // fight: swing whenever something is in front
  for (let i = 0; i < 520; i++) {
    const s = await R(`(() => { const f = h.PL.target(P); const z = G.ents.filter((e) => e.type === 'mob' && (e.kind === 'zombie') && !e.dying); if (!z.length) return 'clear'; if (f && f.kind === 'mob' && P.attackCd > 0.62) return 'hit'; const m = z.sort((a, b) => Math.abs(a.tx - P.tx) + Math.abs(a.ty - P.ty) - Math.abs(b.tx - P.tx) - Math.abs(b.ty - P.ty))[0]; return 'face:' + (Math.abs(m.tx - P.tx) + Math.abs(m.ty - P.ty) === 1 ? (m.tx > P.tx ? 'right' : m.tx < P.tx ? 'left' : m.ty > P.ty ? 'down' : 'up') : ''); })()`);
    if (s === 'clear') break;
    if (s === 'hit') await tick({ press: 'a' });
    else if (s.startsWith('face:') && s.length > 5) { const d = s.slice(5); if ((await R('P.dir')) !== d) await tick({ press: d }); else await tick(); }
    else await tick();
  }
  await idle(40);
});

seg('creeper', async () => {
  await setup(() => { const h = window.__rs, G = h.G; h.rules.mobs = false; h.startGame(); if (G.time < 13800 || G.time > 22000) h.setTime(16000); G.ents = G.ents.filter((e) => !(e.type === 'mob' && ['zombie', 'skeleton', 'creeper', 'spider'].includes(e.kind) && !e.dying)); h.P.health = Math.min(h.P.health, 4); if (!G.spawnBed) G.spawnBed = [63, 277]; });
  await face('down');
  await idle(20);
  // it comes from behind
  await setup(() => { const h = window.__rs; h.spawn('creeper', h.P.tx, h.P.ty - 4); });
  await until(`P.dead || h.state() === 'dead'`, { max: 900, pressMsgs: false });
  await until(`h.state() === 'dead'`, { max: 200, pressMsgs: false });
  await idle(100);
  await press('a', 10);
  await idle(30);
});

seg('sleep', async () => {
  await setup(() => { const h = window.__rs, G = h.G, W = h.world; if (!W.block(63, 277)) { W.setBlock(64, 277, { id: 'white_bed', orient: 'left', part: 'foot', other: [63, 277] }); W.setBlock(63, 277, { id: 'white_bed', orient: 'left', part: 'head', other: [64, 277] }); } G.spawnBed = [63, 277]; h.startGame(); if (G.time < 13800 || G.time > 22000) h.setTime(17000); h.teleport(65, 277, 'left'); });
  await walkTo(65, 277); await face('left');
  await idle(10);
  await use(10);
  await until(`h.state() === 'play'`, { max: 400, pressMsgs: false });
  await idle(20);
  // the zombies that were still out at dawn
  await setup(() => { const h = window.__rs; h.spawn('zombie', 70, 272); h.spawn('zombie', 72, 274); h.spawn('skeleton', 68, 270); });
  await run(() => { const h = window.__rs; h.playMusic('pallet'); });
  await walkTo(65, 276); await walkTo(64, 276); await face('up'); await use(8);
  await walkTo(64, 274);
  await idle(150);
});

seg('eat', async () => {
  await setup(() => { const h = window.__rs, G = h.G; G.ents = G.ents.filter((e) => !(e.type === 'mob' && ['zombie', 'skeleton', 'creeper', 'spider'].includes(e.kind))); h.P.food = 9; h.P.sat = 0; if (!G.inv.has('bread')) h.give('bread', 3); });
  await selectItem('bread');
  // turn away from the crafting table: X on a block uses the block, as in Minecraft
  await run(() => { const h = window.__rs, P = h.P, W = h.world; window.__eatDir = ['left', 'right', 'down', 'up'].find((d) => { const v = { left: [-1, 0], right: [1, 0], down: [0, 1], up: [0, -1] }[d]; return !W.block(P.tx + v[0], P.ty + v[1]) && !W.solid(P.tx + v[0], P.ty + v[1]); }) || 'left'; });
  await face(await R('window.__eatDir'));
  await tick({ press: 'b', hold: 'b' });
  for (let i = 0; i < 52; i++) await tick({ hold: 'b' });
  await idle(30);
});

seg('fish', async () => {
  await setup(() => { const h = window.__rs; if (!h.G.inv.has('fishing_rod')) h.give('fishing_rod', 1); if (!h.G.inv.has('stone_sword')) h.give('stone_sword', 1); if (!h.G.party.length) h.addMon('MANKEY', 6); h.startGame(); h.rules.mobs = false; if (!h.G.isDay()) h.setTime(1500); h.G.ents = h.G.ents.filter((e) => !(e.type === 'mob' && ['zombie', 'skeleton', 'creeper', 'spider'].includes(e.kind))); h.seed(31); });
  await walkPath([[64, 273], [67, 273], [67, 276]]);
  await face('down');
  await selectItem('fishing_rod');
  await use(30);
  await setup(() => { const b = window.__rs.G.ents.find((e) => e.type === 'bobber'); if (b) { b.forceBite = 2.2; b.forcePokemon = true; b.forceEnc = { species: 'MAGIKARP', level: 5 }; } });
  await until(`G.ents.some((e) => e.type === 'bobber' && e.state === 'bite')`, { max: 400, pressMsgs: false });
  await idle(6);
  await use(4);
  await until(`h.state() === 'battle'`, { read: 32 });
  await until(battleIdle('action'), { read: 34 });
  await idle(10);
  // Steve takes the MAGIKARP on himself
  for (let k = 0; k < 10; k++) {
    if ((await R('h.state()')) !== 'battle') break;
    if ((await R('h.battle().menu')) !== 0) await press('up', 8);
    await run(() => { const h = window.__rs, inv = h.G.inv; const i = inv.slots.findIndex((s) => s && s.id === 'stone_sword'); if (i >= 0 && i < 9) inv.sel = i; });
    await press('a', 12); await idle(6); await press('a', 4);
    await until(`h.state() !== 'battle' || (${battleIdle('action')})`, { read: 32, max: 4000 });
  }
  await until(`h.state() === 'play'`, { read: 30 });
  await idle(60);
});

seg('boat', async () => {
  await setup(() => { const h = window.__rs; if (!h.G.inv.has('oak_boat')) h.give('oak_boat', 1); h.startGame(); h.setTime(11500); });
  // launch from the middle of the channel south of Pallet Town (x 67..70), not against its bank
  if ((await R('P.tx + "," + P.ty')) === '67,276') await walkTo(68, 276);
  else await walkPath([[64, 273], [68, 273], [68, 276]]);
  await place('down', 'oak_boat', 12);
  await use(16);
  // down the channel, out into Route 21's open water, and once around the sandbar
  await walkPath([[68, 292], [74, 292], [74, 302], [64, 302], [64, 312], [72, 312], [72, 306]]);
  await idle(12);
});

seg('end', async () => {
  await setup(() => {
    const h = window.__rs;
    h.setOverlay((ctx, U) => {
      const t = (window.__endT = (window.__endT || 0) + 1 / 30);
      const a = Math.min(1, t / 1.2);
      ctx.fillStyle = `rgba(0,0,0,${0.55 * a})`; ctx.fillRect(0, 0, U.HW, U.HH);
      ctx.globalAlpha = a;
      ctx.drawImage(U.A.img.titleLogo, 64, 40, 352, 118);
      const r = 'REDSTONE', v = 'VERSION';
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) U.mcText(ctx, r, 152 + dx, 164 + dy, '#3a0000', false, 3);
      U.mcText(ctx, r, 152, 164, '#ff3020', false, 3);
      U.mcText(ctx, v, 204, 194, '#f0f0f0', false, 2);
      const s = "Steve's in Kanto.";
      U.mcText(ctx, s, Math.round(U.HW / 2 - U.mcWidth(s, 2) / 2), 250, '#ffffff', true, 2);
      ctx.globalAlpha = 1;
    });
  });
  await holdFor('down', 40);
  await idle(130);
  await fadeOut(30);
});

for (const s of segments) {
  if (!wanted(s.name)) continue;
  const n0 = n;
  console.log(`segment ${s.name}…`);
  await s.fn();
  console.log(`  ${s.name}: ${n - n0} frames`);
}

const duration = n / FPS;
console.log(`captured ${n} frames (${duration.toFixed(1)}s), rendering audio…`);
const wav = await page.evaluate((d) => window.__rs.renderAudio(d), duration + 0.5);
writeFileSync(path.join(WORK, 'audio.wav'), Buffer.from(wav, 'base64'));
await browser.close();
server.kill();

if (process.env.PREVIEW) {
  const files = readdirSync(FRAMES).filter((f) => f.endsWith('.png')).sort().filter((_, i) => i % 20 === 0);
  const list = files.map((f) => path.join(FRAMES, f));
  execFileSync('python3', ['-c', `
import sys
from PIL import Image
fs=sys.argv[1:]; cols=8; w,h=240,160
rows=-(-len(fs)//cols)
out=Image.new('RGB',(cols*w,rows*h))
for i,f in enumerate(fs):
    im=Image.open(f).convert('RGB').resize((w,h))
    out.paste(im,((i%cols)*w,(i//cols)*h))
out.save('${path.join(WORK, 'contact.png')}')
`, ...list]);
}

execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(FRAMES, '%05d.png'), '-i', path.join(WORK, 'audio.wav'),
  '-vf', 'scale=1440:960:flags=neighbor', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow',
  '-af', 'loudnorm=I=-15:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
console.log(`wrote ${OUT}`);
