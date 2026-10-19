#!/usr/bin/env node
// THE SHOWCASE: raw gameplay of the new world, no captions, rendered the same way as tools/render_video.mjs,
// whose helpers it shares. Math.random is seeded too, so wild POKéMON, NPCs, mobs and particles repeat
// exactly from run to run. It drives the game one frame at a time through window.__rs.tick() in headless
// Chrome, records every sound against game time, renders the audio offline in the page, and assembles an
// MP4 with ffmpeg.
//
//   node tools/render_showcase.mjs [out.mp4]       the whole film (out/pokemon-redstone-showcase.mp4)
//   SEG=title,home,wood node tools/render_showcase.mjs   only some segments; they share state (inventory,
//                                                  time, the base), so include the ones a scene builds on
//   PREVIEW=1 ...                                   also writes a contact sheet of every 20th frame
//   FIGHTLOG=1 ...                                  logs the night fight's choices and positions
//
// The run: title; out of Red's house; a tree punched down by hand, three more felled with an axe; a tiny
// plank hut south of the forest (bed, torch, crafting table, chest, door); walls that can't be griefed and
// the rival's door taken off; wild POKéMON scattering on Route 1; the nurse in Viridian's POKéMON CENTER;
// a MANKEY that hunts Steve into a battle; Mt Moon lit with torches and a ZUBAT battle; a diamond on the
// deepest floor of the Seafoam Islands; Rock Tunnel lit torch by torch; back at the base at sundown,
// zombies, a skeleton and a creeper fought off in diamond armor, then sleep to morning; a campfire by the
// base the next night; the end card.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'pokemon-redstone-showcase.mp4'));
const WORK = path.join(ROOT, 'out', 'work-showcase');
const FRAMES = path.join(WORK, 'frames');
const PORT = 5304;
const FPS = 30;
const ONLY = process.env.SEG ? process.env.SEG.split(',') : null;

const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
const { chromium } = createRequire(import.meta.url)(pwDir);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(path.dirname(OUT), { recursive: true });

const server = spawn('python3', [path.join(ROOT, 'serve.py'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => server.kill());   // a scene that throws still frees the port
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
await page.addInitScript(() => {
  let s = 20261003 >>> 0;
  Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
});
await page.goto(`http://127.0.0.1:${PORT}/?new&video`);
await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 60000 });
// the game's own tick, kept before startAudio() wraps it with the clock that times every recorded sound
await page.evaluate(() => { const h = window.__rs; window.__rawTick = h.tick; h.pause(); h.seed(2026); h.startAudio(); h.rules.encounters = false; h.rules.warps = true; h.rules.wild = false; h.G.money = 3000; localStorage.removeItem('poke-redstone-music'); });

// ---------------------------------------------------------------- frame capture
let n = 0;
let skip = 1;            // time-lapse: capture one frame in `skip`
let skipCount = 0;
let offCamera = false;   // set-up moves made while the screen is faded out: played, not filmed
// Only filmed frames advance the sound clock, so the soundtrack stays on the video's timeline: the
// sounds of a time-lapse's skipped frames land, sped up, in the frames that show it.
async function tick(opts = {}) {
  const capture = !offCamera && (skipCount++ % skip) === 0;
  const url = await page.evaluate((o) => (o.capture ? window.__rs.tick(o) : window.__rawTick(o)), { dt: 1 / FPS, capture, ...opts });
  if (url) writeFileSync(path.join(FRAMES, String(n++).padStart(5, '0') + '.png'), Buffer.from(url.split(',')[1], 'base64'));
}
async function unfilmed(fn) { offCamera = true; try { await fn(); } finally { offCamera = false; } }
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
  if (i === (await R('G.inv.sel'))) return;
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
// A cut ends any advancement toast still on screen, so one earned in a scene never hangs over the next.
async function fadeOut(frames = 12) { for (let i = 1; i <= frames; i++) { await run((a) => window.__rs.setFade(a), i / frames); await tick(); } await run(() => { window.__rs.toasts.length = 0; }); }
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


// ================================================================ the showcase
const segments = [];
const seg = (name, fn) => segments.push({ name, fn });

// FIGHT with the first move until the wild POKéMON goes down
async function winBattle() {
  await until(battleIdle('action'), { read: 30, max: 1500 });
  for (let k = 0; k < 8; k++) {
    if ((await R('h.state()')) !== 'battle') break;
    if ((await R('h.battle().menu')) !== 0) await press('up', 6);
    await press('a', 12); await idle(6); await press('a', 6);
    await until(`h.state() !== 'battle' || (${battleIdle('action')})`, { read: 28, max: 3000 });
  }
  await until(`h.state() === 'play'`, { read: 28, max: 900 });
}
const pushWild = (a) => {
  const h = window.__rs, W = h.world, [species, level, arch, x, y, extra] = a;
  h.G.ents.push({ type: 'wild', species, level, arch, swim: false, tx: x, ty: y, fx: x, fy: y, fromX: x, fromY: y, moving: false, prog: 0,
    step: 0.42, dir: 'down', home: { x, y }, think: 0.5, calm: 0, state: 'idle', emote: 0, disguise: null, shiny: false, map: W.mapAt(x, y), ...(extra || {}) });
};

// Fight the hostile mobs that are out, the way a player does: swing only on a full charge, let zombies
// come, run skeletons down, and jump for critical hits on a hissing creeper (two crits from a diamond
// sword kill it before its fuse runs out). Returns when none are left.
async function fight(maxFrames = 1200) {
  for (let i = 0; i < maxFrames; i++) {
    const act = await run(() => {
      const h = window.__rs, G = h.G, P = h.P, W = h.world;
      const foes = G.ents.filter((e) => e.type === 'mob' && ['zombie', 'skeleton', 'creeper', 'spider'].includes(e.kind) && !e.dying);
      if (!foes.length) return { done: true };
      // decided afresh every frame, from the cell he is stepping into: a held direction only takes
      // effect when the current step ends
      const man = (m) => Math.abs(m.tx - P.tx) + Math.abs(m.ty - P.ty);
      const dirOf = (m) => (Math.abs(m.tx - P.tx) >= Math.abs(m.ty - P.ty) ? (m.tx > P.tx ? 'right' : 'left') : (m.ty > P.ty ? 'down' : 'up'));
      const adj = foes.filter((m) => man(m) === 1);
      const fusing = foes.find((m) => m.kind === 'creeper' && m.fuse > 0);
      const m = adj.find((q) => q.kind === 'creeper') || adj[0] || fusing || foes.slice().sort((a, b) => man(a) - man(b))[0];
      const press = [];
      // jump ahead of the swing that will hit a hissing creeper, so it lands in the air as a crit (the
      // jump lasts 0.42 s and only counts after 0.18 s; a swing in the last frames would land after it)
      const wantCrit = m.kind === 'creeper';
      const airborne = P.jumpT > 0.19 && P.jumpT < 0.36;
      if (wantCrit && P.jumpT <= 0 && P.attackCd >= 0.4 && (m.fuse > 0 || man(m) === 1)) press.push('jump');
      if (man(m) === 1) {
        const d = dirOf(m);
        if (P.dir !== d) return { press: [...press, d] };
        // swing only at something actually in front (a mob mid-step counts in both cells, as in the game)
        const inFront = h.E.mobAt(P.tx + { up: 0, down: 0, left: -1, right: 1 }[d], P.ty + { up: -1, down: 1, left: 0, right: 0 }[d]);
        if (inFront && P.attackCd >= 0.63 && (!wantCrit || airborne)) press.push('a');
        return { press };
      }
      // he meets zombies halfway; a creeper he lets come until it starts to hiss
      const chase = m.kind === 'skeleton' || (m.kind === 'creeper' ? m.fuse > 0 : man(m) >= 3);
      if (!chase) { const d = dirOf(m); return { press: P.dir !== d ? [d] : press }; }
      // a breadth-first distance map out from the cells beside it; step to whichever neighbour is closer,
      // along the longer axis first, so he runs straight at it instead of shadowing it
      const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const mobs = new Set(foes.map((e) => e.tx + ',' + e.ty));
      const key = (x, y) => x + ',' + y;
      const open = (x, y) => (x === P.tx && y === P.ty) || (!W.solid(x, y) && !W.isWater(x, y) && !W.jumpDir(x, y) && !W.warpAt(x, y) && !W.pcDoor(x, y)
        && !mobs.has(key(x, y)) && !(G.npcAt && G.npcAt(x, y)) && !(G.wildAt && G.wildAt(x, y)));
      const dist = new Map(), q = [];
      for (const [dx, dy] of Object.values(D)) { const x = m.tx + dx, y = m.ty + dy; if (open(x, y)) { dist.set(key(x, y), 0); q.push([x, y]); } }
      while (q.length && !dist.has(key(P.tx, P.ty)) && dist.size < 4000) {
        const [cx, cy] = q.shift(), cd = dist.get(key(cx, cy));
        for (const [dx, dy] of Object.values(D)) {
          const nx = cx + dx, ny = cy + dy;
          if (dist.has(key(nx, ny)) || !open(nx, ny) || Math.abs(nx - P.tx) > 20 || Math.abs(ny - P.ty) > 20) continue;
          dist.set(key(nx, ny), cd + 1); q.push([nx, ny]);
        }
      }
      const here = dist.get(key(P.tx, P.ty));
      if (here == null) return { press };
      const order = Math.abs(m.tx - P.tx) >= Math.abs(m.ty - P.ty) ? ['left', 'right', 'up', 'down'] : ['up', 'down', 'left', 'right'];
      const d = order.find((k) => { const n = dist.get(key(P.tx + D[k][0], P.ty + D[k][1])); return n != null && n < here; });
      if (!d) return { press };
      return { hold: d, press };
    });
    if (act.done) return true;
    // FIGHTLOG=1 prints the fight every ten frames, for re-choreographing it
    if (process.env.FIGHTLOG && i % 10 === 0) console.log(i, JSON.stringify(act), await R(`G.ents.filter((e) => e.type === 'mob' && !e.dying && ['zombie', 'skeleton', 'creeper', 'spider'].includes(e.kind)).map((e) => e.kind[0] + [e.tx, e.ty, Math.round(e.hp), e.moving ? 'm' : '', +e.cool.toFixed(1)].join(',')).join(' ') + ' | P ' + [P.tx, P.ty, P.dir, P.moving ? 'm' : '', Math.round(P.health), P.attackCd.toFixed(2)].join(',')`));
    await tick({ hold: act.hold || undefined, press: act.press && act.press.length ? act.press : undefined });
  }
  throw new Error('fight did not finish');
}

// Every cell of the base must be open ground that takes blocks (no warps, doorsteps or protected tiles).
const HUT = { x0: 62, y0: 275, x1: 66, y1: 278 };
async function checkHutSite() {
  const bad = await run((s) => {
    const W = window.__rs.world, out = [];
    for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) if (!W.isFloor(x, y) || W.noPlace(x, y) || W.block(x, y)) out.push(`${x},${y}`);
    return out;
  }, HUT);
  if (bad.length) throw new Error('hut site not buildable at ' + bad.join(' '));
}

seg('title', async () => {
  await run(() => { window.__rs.playMusic('title'); });
  await idle(120);
  await press('start', 4);
  await setup(() => {
    const h = window.__rs; h.rules.mobs = false; h.setTime(2500); h.P.level = 15;
    h.give('diamond_sword', 1, 0); h.give('iron_axe', 1, 1); h.give('diamond_pickaxe', 1, 2); h.give('torch', 16, 3);
    h.give('white_bed', 1, 6); h.give('glass', 2, 7); h.G.inv.sel = 8;
  });
});

// Pallet Town's chickens wander the lawn where the film chops trees and builds: walk them over to the
// east side of town first, so none gets boxed into the hut or stands where a block goes.
const herdAnimals = () => {
  const h = window.__rs, W = h.world, spots = [];
  for (let y = 275; y <= 279; y++) for (let x = 76; x <= 81; x++) if (W.isFloor(x, y) && !W.noPlace(x, y) && !W.block(x, y)) spots.push([x, y]);
  for (const m of h.G.ents) {
    if (m.type !== 'mob' || ['zombie', 'skeleton', 'creeper', 'spider'].includes(m.kind) || m.tx < 56 || m.tx > 84 || m.ty < 258 || m.ty > 282) continue;
    const s = spots.shift();
    if (!s) { m.dead = true; continue; }
    m.tx = m.fx = m.fromX = s[0]; m.ty = m.fy = m.fromY = s[1]; m.moving = false;
    spots.shift();
  }
};

seg('home', async () => {
  // inside Red's house: Mom at the table, out through the door into Pallet Town
  await setup(() => { const h = window.__rs; h.teleport(312, 686, 'down'); });
  await setup(herdAnimals);
  await fadeIn(14);
  await idle(16);
  await walkTo(312, 688);
  await holdFor('down', 10);
  await until(`h.state() === 'play' && P.ty < 400`, { max: 300 });
  await idle(14);
});

seg('wood', async () => {
  // the forest edge west of Red's house: a tree punched down by hand, then the iron axe
  if (ONLY && !ONLY.includes('home')) { await setup(() => { const h = window.__rs; h.teleport(66, 268, 'down'); }); await setup(herdAnimals); }
  await walkPath([[66, 269], [62, 269], [62, 268]]);
  await face('left');
  await slot(8);                                    // bare hands
  await mine(300);                                  // the tree at (61,268) comes down whole
  await idle(22);                                   // the logs fly into the inventory
  await slot(1);                                    // the iron axe
  for (const y of [270, 272, 274]) {
    await walkTo(62, y); await face('left');
    await mine(120);
    await idle(18);
  }
  // a few more logs for the base, should the drops have run short
  await setup(() => { const h = window.__rs; const n = h.G.inv.count('oak_log'); if (n < 10) h.give('oak_log', 10 - n); });
});

seg('base', async () => {
  // a tiny plank hut on the open grass south of the forest: logs to planks, walls, a bed, a torch,
  // a crafting table, a chest and a door
  if (ONLY && !ONLY.includes('wood')) await setup(() => { const h = window.__rs; h.teleport(62, 274, 'left'); h.give('oak_log', 12); });
  await checkHutSite();
  await openInv();
  await idle(6);
  await timelapse(2, async () => {
    await pickUp('oak_log');
    await cursorTo('grid', 0); await leftClick(8);
    await takeResult(true);
    await idle(8);
    await layRecipe([['oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks']]);
    await takeResult(true);
  });
  await idle(10);
  await closeScreen();
  await timelapse(3, async () => {
    await walkTo(62, 276); await place('up', 'oak_planks');                                  // (62,275)
    await walkTo(62, 277); await place('down', 'oak_planks');                                // (62,278)
    await walkTo(63, 277); await place('left', 'oak_planks'); await place('down', 'glass');  // (62,277) (63,278)
    await walkTo(63, 276); await place('left', 'oak_planks'); await place('up', 'oak_planks'); // (62,276) (63,275)
    await walkTo(64, 277); await place('down', 'oak_planks');                                // (64,278)
    await walkTo(65, 277); await place('down', 'glass');                                     // (65,278)
    await walkTo(66, 277); await place('down', 'oak_planks');                                // (66,278)
    await walkTo(66, 276); await place('up', 'oak_planks');                                  // (66,275)
    await walkTo(65, 276); await place('right', 'oak_planks'); await place('up', 'oak_planks'); // (66,276) (65,275)
    await walkTo(65, 277); await place('right', 'oak_planks');                               // (66,277)
    await place('left', 'white_bed');                                                        // foot (64,277), head (63,277)
    await walkTo(65, 276); await place('down', 'torch');                                     // (65,277)
    await walkTo(64, 276); await place('left', 'crafting_table');                            // (63,276)
  });
  // at the table: a chest and a door
  await face('left'); await use(10);
  await timelapse(3, async () => {
    await layRecipe([['oak_planks', 'oak_planks', 'oak_planks'], ['oak_planks', null, 'oak_planks'], ['oak_planks', 'oak_planks', 'oak_planks']]);
    await takeResult(true);
    await layRecipe([['oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks']]);
    await takeResult(true);
  });
  await idle(6);
  await closeScreen();
  await place('right', 'chest', 10);                // (65,276)
  await place('up', 'oak_door', 12);                // (64,275)
  const missing = await run(() => {
    const W = window.__rs.world, want = { '63,276': 'crafting_table', '65,276': 'chest', '65,277': 'torch', '64,277': 'white_bed', '63,277': 'white_bed', '64,275': 'oak_door', '63,278': 'glass', '65,278': 'glass' };
    for (const [x, y] of [[62, 275], [63, 275], [65, 275], [66, 275], [62, 276], [66, 276], [62, 277], [66, 277], [62, 278], [64, 278], [66, 278]]) want[x + ',' + y] = 'oak_planks';
    return Object.entries(want).filter(([k, id]) => { const [x, y] = k.split(',').map(Number), b = W.block(x, y); return !b || b.id !== id; }).map(([k, id]) => id + '@' + k);
  });
  if (missing.length) throw new Error('hut incomplete: ' + missing.join(' '));
  await idle(10);
  // out through the door, and shut it behind him; then round to the east side, where the camera has the
  // whole hut above the hotbar (from the north side its front row with the windows sits under the HUD)
  await use(10);
  await walkTo(64, 274);
  await face('down'); await idle(4); await use(10);
  await walkPath([[68, 274], [68, 276]]); await face('left');
  await idle(40);
  await fadeOut(12);
});

seg('door', async () => {
  // the rival's house: walls shrug off a diamond pickaxe, the door comes off with an axe
  await setup(() => { const h = window.__rs; h.G.inv.armor = [null, null, null, null]; h.teleport(71, 270, 'right'); });
  await unfilmed(() => selectItem('diamond_pickaxe'));
  await fadeIn(12);
  await walkPath([[74, 270], [74, 268]]);
  await face('up');
  await holdFor('a', 34);
  await idle(8);
  await walkTo(75, 268); await face('up');
  await slot(1);
  await mine(160);
  await idle(16);
  await walkPath([[75, 270], [71, 270]]);
  await place('down', 'door_pallet', 12);
  await use(14);
  await walkPath([[71, 271], [71, 273]]);
  await idle(14);
  await fadeOut(12);
});

seg('wild', async () => {
  // Route 1: POKéMON out in the grass; Pidgey and Rattata scatter when Steve walks through
  await setup(() => { const h = window.__rs; h.rules.wild = true; h.teleport(70, 252, 'up'); });
  await run(pushWild, ['PIDGEY', 3, 'skittish', 72, 246]);
  await run(pushWild, ['RATTATA', 2, 'skittish', 68, 244]);
  await run(pushWild, ['PIDGEY', 4, 'skittish', 74, 241]);
  await run(pushWild, ['RATTATA', 3, 'skittish', 70, 238]);
  await fadeIn(12);
  await walkPath([[70, 244], [70, 234]]);
  await idle(16);
  await fadeOut(12);
  await setup(() => { const h = window.__rs; h.rules.wild = false; h.G.ents = h.G.ents.filter((e) => e.type !== 'wild'); });
});

seg('center', async () => {
  // Viridian's POKéMON CENTER: the sliding door, the nurse, the healing machine
  await setup(() => { const h = window.__rs; h.P.health = 9; h.teleport(74, 209, 'up'); });
  await fadeIn(12);
  await walkTo(74, 207);
  await holdFor('up', 6);
  await until(`h.state() === 'play' && P.ty > 400`, { max: 300 });
  const n = await R('h.npcs().find((x) => x.role === "nurse")');
  await walkPath([[n.tx, n.ty + 2]]);
  await face('up');
  await press('a', 8);
  await until('!!h.msg() && !!h.msg().ask', { max: 400 });
  await idle(24);
  for (let i = 0; i < 8 && (await R('h.state()')) !== 'heal'; i++) await press('a', 10);
  await until(`h.state() === 'play'`, { read: 24, max: 900 });
  await idle(16);
  await fadeOut(12);
});

seg('hunt', async () => {
  // Route 22: a MANKEY spots Steve and comes for him
  const spot = await R('(() => { for (let y = 192; y < 212; y++) for (let x = 8; x < 46; x++) { let ok = true; for (let k = 0; k <= 5; k++) if (W.solid(x, y + k) || W.jumpDir(x, y + k) || W.isWater(x, y + k)) ok = false; if (ok) return [x, y]; } return null; })()');
  await setup((s) => { const h = window.__rs; h.rules.wild = true; h.teleport(s[0], s[1], 'down'); h.seed(4040); }, spot);
  await run(pushWild, ['MANKEY', 5, 'aggressive', spot[0], spot[1] + 5]);
  await fadeIn(12);
  await until(`h.state() === 'battle'`, { max: 300, pressMsgs: false });
  await winBattle();
  await idle(24);
  await setup(() => { const h = window.__rs; h.rules.wild = false; h.G.ents = h.G.ents.filter((e) => e.type !== 'wild'); });
  await fadeOut(12);
});

seg('cave', async () => {
  // Mt Moon: into the dark with torches; a ZUBAT swarm finds Steve
  await setup(() => { const h = window.__rs; h.teleport(175, 57, 'up'); });
  await fadeIn(12);
  await holdFor('up', 18);
  await until(`h.state() === 'play' && P.ty > 400`, { max: 300 });
  await idle(12);
  await selectItem('torch');
  await place('left', null, 10);
  const pc = await R('[P.tx, P.ty]'); await walkPath([[pc[0], pc[1] - 3]]).catch(() => {});
  await place('right', null, 10);
  await idle(16);
  await setup(() => { window.__rs.rules.wild = true; });
  // two ZUBAT on open floor in straight lines from Steve, so they can reach him
  const lanes = await R(`(() => { const out = []; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { for (let k = 1; k <= 5; k++) { const x = P.tx + dx * k, y = P.ty + dy * k; if (W.solid(x, y) || W.warpAt(x, y) || W.block(x, y)) break; if (k >= 3) { out.push([x, y]); break; } } } return out; })()`);
  for (const [i, [x, y]] of lanes.slice(0, 2).entries()) await run(pushWild, ['ZUBAT', 9 - i, 'aggressive', x, y]);
  await until(`h.state() === 'battle'`, { max: 400, pressMsgs: false });
  await winBattle();
  await setup(() => { const h = window.__rs; h.rules.wild = false; h.G.ents = h.G.ents.filter((e) => e.type !== 'wild'); });
  await idle(10);
  await fadeOut(12);
});

seg('deep', async () => {
  // Seafoam Islands B3F: the deepest floors are where diamonds are
  // a rock face on the deepest floor with open ground below it; the film sets a diamond into it (the
  // atlas has every ore over these cave pieces), the way tools/render_video.mjs paints its seam
  const spot = await R(`(() => { const m = W.maps.find((q) => q.id === 'MAP_SEAFOAM_ISLANDS_B3F'); for (let y = m.y + 4; y < m.y + m.h - 3; y++) for (let x = m.x + 4; x < m.x + m.w - 4; x++) { if (W.mat(x, y) !== 'rock' || W.noBreak(x, y) || W.solid(x, y + 1) || W.isWater(x, y + 1) || W.solid(x - 1, y + 1) || W.isWater(x - 1, y + 1) || W.solid(x, y + 2) || W.isWater(x, y + 2)) continue; const d = W.entries.findIndex((e) => e[4] === 'diamond_ore' && e[5] === W.tile(x, y)); if (d >= 0) return [x, y + 1, d]; } return null; })()`);
  await setup((s) => { const h = window.__rs; h.world.setTile(s[0], s[1] - 1, s[2]); h.teleport(s[0], s[1], 'up'); }, spot);
  // the torch goes down beside the ore, then Steve starts a step back so the diamond ore is in view (right
  // under it, his head hides it) before he walks up and mines it
  await unfilmed(async () => { await selectItem('torch'); await place('left', null, 6); await selectItem('diamond_pickaxe'); });
  await setup((s) => { window.__rs.teleport(s[0], s[1] + 1, 'up'); }, spot);
  await fadeIn(12);
  await idle(14);
  await walkTo(spot[0], spot[1]); await face('up');
  await mine(200);
  await idle(76);                                   // long enough to read the Diamonds! toast before the cut
  await fadeOut(12);
});

seg('dark', async () => {
  // Rock Tunnel needs FLASH in FireRed; here it needs torches
  // a straight run of open floor with nobody standing within two steps of it: the floor's people only load
  // once Steve is on it, so he goes there first (still faded out), then to the spot (a HIKER standing just
  // above the old spot ended up sitting on Steve's head like a hat)
  const find = (avoidNpcs) => R(`(() => { const m = W.maps.find((q) => q.id === 'MAP_ROCK_TUNNEL_1F'); const near = (x, y) => ${avoidNpcs} && h.npcs().some((n) => Math.abs(n.tx - x) <= 2 && Math.abs(n.ty - y) <= 2); for (let y = m.y + 18; y < m.y + m.h - 4; y++) for (let x = m.x + 14; x < m.x + m.w - 8; x++) { let ok = true; for (let k = 0; k <= 6; k++) if (W.solid(x + k, y) || W.warpAt(x + k, y) || near(x + k, y)) ok = false; if (ok) return [x, y]; } return null; })()`);
  await setup((s) => { window.__rs.teleport(s[0], s[1], 'right'); }, await find(false));
  const spot = await find(true);
  if (!spot) throw new Error('no clear run of floor in Rock Tunnel');
  await setup((s) => { const h = window.__rs; h.teleport(s[0], s[1], 'right'); }, spot);
  await fadeIn(12);
  await idle(16);
  await selectItem('torch');
  for (let i = 0; i < 3; i++) { await holdFor('right', 16); await idle(4); await place('left', null, 6); }
  await idle(26);
  await fadeOut(12);
});

seg('night', async () => {
  // back at the base at sundown, in diamond armor with the diamond sword; a torch by the door
  await setup(() => {
    const h = window.__rs, G = h.G;
    h.rules.wild = false; h.rules.mobs = false; h.setTime(10900); h.P.health = 20; h.P.food = 20;
    G.ents = G.ents.filter((e) => !(e.type === 'mob' && ['zombie', 'skeleton', 'creeper', 'spider'].includes(e.kind)));
    G.inv.armor = [{ id: 'diamond_helmet', n: 1 }, { id: 'diamond_chestplate', n: 1 }, { id: 'diamond_leggings', n: 1 }, { id: 'diamond_boots', n: 1 }];
    h.teleport(64, 274, 'right');
  });
  await unfilmed(() => selectItem('diamond_sword'));
  await fadeIn(12);
  await idle(10);
  await place('left', 'torch', 8);                  // (63,274)
  await selectItem('diamond_sword');
  await face('right');
  // sunset to night, sped up twenty times
  await timelapse(20, () => idle(2320));
  await run(() => { window.__rs.music.stop(1.5); });
  await idle(8);
  // two zombies come out of the dark, from the north and the east, with a skeleton behind them
  await setup(() => { const h = window.__rs; h.spawn('zombie', 64, 268); h.spawn('zombie', 72, 274); h.spawn('skeleton', 73, 277); });
  await fight();
  await idle(10);
  // then a creeper creeps up behind him, from wherever is open about five steps back
  await run(() => {
    const h = window.__rs, P = h.P, W = h.world;
    const back = { right: [-1, 0], left: [1, 0], up: [0, 1], down: [0, -1] }[P.dir];
    const side = [back[1], back[0]];
    const tries = [[5, 0], [5, 1], [5, -1], [4, 2], [4, -2], [6, 0], [3, 3], [3, -3]].map(([b, s]) => [P.tx + back[0] * b + side[0] * s, P.ty + back[1] * b + side[1] * s]);
    const ok = ([x, y]) => W.isFloor(x, y) && !W.solid(x, y) && !W.block(x, y) && !W.warpAt(x, y) && !h.E.mobAt(x, y);
    const at = tries.find(ok) || [64, 268];
    h.spawn('creeper', at[0], at[1]);
  });
  await fight();
  await idle(24);
  // clear: into the hut, shut the door, and sleep to morning
  await walkTo(64, 274); await face('down'); await use(10);
  await walkTo(64, 276);
  await face('up'); await use(8);
  await face('down'); await idle(6);
  await use(10);
  await until(`h.state() === 'play'`, { max: 400, pressMsgs: false });
  await run(() => { window.__rs.playMusic('pallet'); });
  await idle(20);
  await face('up'); await use(8);
  await walkTo(64, 274);
  await idle(16);
  await fadeOut(12);
});

seg('camp', async () => {
  // the next night: a campfire by the base, porkchops on, cooked ones off
  await setup(() => { const h = window.__rs; h.setTime(16500); h.give('campfire', 1, 5); h.give('porkchop', 3, 6); h.teleport(66, 274, 'right'); });
  await unfilmed(() => selectItem('campfire'));
  await fadeIn(14);
  await place('right', null, 10);                   // (67,274), beside the base
  await selectItem('porkchop');
  for (let i = 0; i < 3; i++) await use(8);
  await idle(36);
  await timelapse(8, () => idle(8 * 120));
  await idle(36);
  await fadeOut(12);
});

seg('end', async () => {
  await setup(() => {
    const h = window.__rs;
    h.setTime(16500);
    h.setOverlay((ctx, U) => {
      const t = (window.__endT = (window.__endT || 0) + 1 / 30);
      const a = Math.min(1, t / 0.8);
      ctx.fillStyle = `rgba(0,0,0,${0.6 * a})`; ctx.fillRect(0, 0, U.HW, U.HH);
      ctx.globalAlpha = a;
      ctx.drawImage(U.A.img.titleLogo, 64, 30, 352, 118);
      const r = 'REDSTONE', v = 'VERSION';
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) U.mcText(ctx, r, 152 + dx, 154 + dy, '#3a0000', false, 3);
      U.mcText(ctx, r, 152, 154, '#ff3020', false, 3);
      U.mcText(ctx, v, 204, 184, '#f0f0f0', false, 2);
      const s = 'Build it yourself from the code:';
      U.mcText(ctx, s, Math.round(U.HW / 2 - U.mcWidth(s, 2) / 2), 228, '#ffffff', true, 2);
      const url = 'github.com/Mozetech/pokemon-redstone';
      U.mcText(ctx, url, Math.round(U.HW / 2 - U.mcWidth(url, 2) / 2), 256, '#ffff55', true, 2);
      ctx.globalAlpha = 1;
    });
  });
  await fadeIn(10);
  await idle(84);
  await fadeOut(26);
});

// the base, then the night it has to survive, then the diamond, then the rest of Kanto
const ORDER = ['title', 'home', 'wood', 'base', 'night', 'deep', 'door', 'wild', 'center', 'hunt', 'cave', 'dark', 'camp', 'end'];
segments.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
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
  // loudnorm resamples internally; without -ar the AAC track comes out at 96 kHz
  '-af', 'loudnorm=I=-15:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
console.log(`wrote ${OUT}`);
