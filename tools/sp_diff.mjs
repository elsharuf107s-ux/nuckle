#!/usr/bin/env node
// Single-player differential harness: later work must leave single-player (Classic) byte-for-byte the same.
// Serves a baseline snapshot (port 5902; since the world update's stage 0 the baseline is v7-pre-world, before that it
// was v5-end) and the current tree (port 5903), opens both in headless Chrome with the
// same seeded Math.random, the clock pinned until the game is ready (src/rng.js seeds from it) and an empty localStorage, drives them with the same scripted and pseudo-random input
// through window.__rs.tick, and every 30 frames compares a state digest (Steve, inventory, party, time, entities,
// the world, The End state, the number of Math.random draws) and a canvas hash. Then: a save written by the baseline
// loads in the current tree to the same state, and the frame time is compared.
// The START menu is masked from the canvas comparison only for a baseline without co-op (no src/net/session.js),
// whose START menu lacks CO-OP; against a co-op baseline every checkpoint is compared.
//
//   node tools/sp_diff.mjs [--frames 3000] [--base out/baselines/v7-pre-world] [--out dir] [--ports 5902,5903]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const FRAMES = Number(opt('--frames', 3000));
const BASE = path.resolve(opt('--base', path.join(ROOT, 'out', 'baselines', 'v7-pre-world')));
const MASK_MENU = !existsSync(path.join(BASE, 'src', 'net', 'session.js'));   // a baseline from before co-op
const OUT = path.resolve(opt('--out', path.join(ROOT, 'out', 'sp_diff')));
const [PA, PB] = String(opt('--ports', '5902,5903')).split(',').map(Number);   // base, current
mkdirSync(OUT, { recursive: true });
const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
const { chromium } = createRequire(import.meta.url)(pwDir);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
function serve(root, port, seen = null) {
  const s = createServer(async (req, res) => {
    try {
      let u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (seen) seen.push(u);   // every request the server sees, from any page, context or worker
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

// every page gets the same Math.random (counted, so an extra draw anywhere shows up) and an empty save
const INIT = `(() => {
  let s = 12345 >>> 0; window.__mr = 0;
  Math.random = () => { window.__mr++; s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try { if (!sessionStorage.getItem('keepSave')) localStorage.clear(); } catch (e) {}
  // the game's own RNG (src/rng.js) is seeded from Date.now() until __rs.seed(), and loading a save already draws
  // from it (spawnMob picks a facing): the clock is pinned until the page is ready, as in classic_fixture.mjs
  const realNow = Date.now.bind(Date);
  Date.now = () => (window.__rs && window.__rs.ready ? realNow() : 1767225600000);
  // no live frames at all: the harness is the only clock, from the first frame on, in both trees
  // (main.js's loop is the function named frame; anything else that waits for a frame still gets one)
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => (cb && cb.name === 'frame' ? 0 : raf(cb));
})();`;

const DIGEST = () => {
  const h = window.__rs, G = h.G, P = h.P;
  const hs = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return x; };
  const r = (v) => (typeof v === 'number' ? Math.round(v * 1000) : v);
  const ents = G.ents.map((e) => [e.type, e.kind || e.species || '', e.tx, e.ty, r(e.x), r(e.y), r(e.fx), r(e.fy), e.hp, e.dead ? 1 : 0, e.dying ? 1 : 0, e.dir ?? null]);
  return {
    state: h.state(),
    P: [P.tx, P.ty, P.dir, r(P.fx), r(P.fy), P.health, P.food, r(P.sat), P.level, P.xpTotal, P.moving ? 1 : 0, P.dead ? 1 : 0],
    inv: hs(JSON.stringify(G.inv.serialize())), time: r(G.time), day: G.day, money: G.money, score: G.score,
    nEnts: G.ents.length, ents: hs(JSON.stringify(ents)), parts: G.parts.length,
    world: hs(JSON.stringify(h.world.serialize())), end: hs(JSON.stringify(G.end)),
    party: hs(JSON.stringify(G.party.map((m) => [m.species, m.level, m.hp, m.exp]))), mr: window.__mr,
  };
};

const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
function mulberry(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// the script: scripted events at fixed frames, pseudo-random play in between
const EVENTS = {
  5: 'h.give("cobblestone", 32); h.give("oak_log", 16); h.give("wooden_pickaxe", 1); h.give("bread", 8); h.give("torch", 16)',
  400: 'h.setTime(14000); h.spawn("zombie", h.P.tx + 4, h.P.ty); h.spawn("creeper", h.P.tx - 4, h.P.ty); h.spawn("skeleton", h.P.tx, h.P.ty + 5)',
  900: 'h.setTime(1000); h.addMon("PIKACHU", 12); h.encounter("PIDGEY", 4)',
  1300: 'h.setState("play"); h.enterNether()',
  1800: 'h.leaveNether()',
  2100: 'h.giveEndKit(); h.enterEnd()',
  2700: 'h.leaveEnd()',
};
const KEYS = ['up', 'down', 'left', 'right'];
function script(n) {
  const rnd = mulberry(777), out = [];
  let hold = null, left = 0;
  for (let i = 0; i < n; i++) {
    if (left <= 0) {
      const r = rnd();
      hold = r < 0.6 ? KEYS[Math.floor(rnd() * 4)] : r < 0.75 ? 'a' : null;
      left = 4 + Math.floor(rnd() * 30);
    }
    left--;
    const o = { hold: hold ? [hold] : undefined };
    const p = rnd();
    if (p < 0.03) o.press = 'b'; else if (p < 0.04) o.press = 'jump'; else if (p < 0.045) o.press = 'slot' + (1 + Math.floor(rnd() * 5));
    else if (p < 0.047) o.press = 'inv'; else if (p < 0.049) o.press = 'start'; else if (p < 0.052) o.press = 'a';
    if (hold === 'a' && o.press === 'a') delete o.press;
    if (EVENTS[i]) o.event = EVENTS[i];
    out.push(o);
  }
  return out;
}

const failures = [];
const check = (c, m) => { if (!c) { failures.push(m); console.error('FAIL', m); } else console.log('ok  ', m); return c; };
let browser; const servers = [];
const curSeen = [];   // every path the current tree's server was asked for (pages, the saved-game pages, workers)
const curReqs = [];   // every request any current-tree browser context made
try {
  servers.push(await serve(BASE, PA), await serve(ROOT, PB, curSeen));
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const open = async (port, q = '?new&play', save = null) => {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } });
    await ctx.addInitScript(INIT);
    if (save) await ctx.addInitScript(`try { sessionStorage.setItem('keepSave', '1'); localStorage.setItem('poke-redstone-v1', ${JSON.stringify(save)}); } catch (e) {}`);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const reqs = [], sockets = [];
    page.on('request', (r) => reqs.push(r.url()));
    if (port === PB) { ctx.on('request', (r) => curReqs.push(r.url())); page.on('worker', (w) => curReqs.push(w.url())); }
    page.on('websocket', (w) => sockets.push(w.url()));
    await page.goto(`http://127.0.0.1:${port}/${q}`);
    await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
    await page.evaluate(() => { window.__rs.pause(); window.__rs.seed(2026); });
    // the minimap (minimap-design.md 3.14) is hidden for the canvas comparison: an in-memory override, never saved; a
    // no-op in a baseline without it
    await page.evaluate(() => { if (window.__rs.minimap) window.__rs.minimap({ show: false }); });
    return { page, ctx, errors, reqs, sockets };
  };
  const A = await open(PA), B = await open(PB);
  const steps = script(FRAMES);
  let firstDiff = null, compared = 0, canvasDiff = 0, menuFrames = 0;
  const run = () => (x) => {
    const h = window.__rs;
    if (x.event) new Function('h', x.event)(h);
    return h.tick({ hold: x.hold, press: x.press, dt: 1 / 30, capture: x.capture });
  };
  for (let i = 0; i < steps.length; i++) {
    const capture = i % 30 === 29;
    const x = { ...steps[i], capture };
    const [ca, cb] = await Promise.all([A.page.evaluate(run(), x), B.page.evaluate(run(), x)]);
    if (capture) {
      const [da, db] = await Promise.all([A.page.evaluate(DIGEST), B.page.evaluate(DIGEST)]);
      compared++;
      const sa = JSON.stringify(da), sb = JSON.stringify(db);
      if (sa !== sb && !firstDiff) { firstDiff = { frame: i, a: da, b: db }; }
      // against a pre-co-op baseline the START menu gained CO-OP (the one intended difference then): not compared
      if (MASK_MENU && da.state === 'menu' && db.state === 'menu') menuFrames++;
      else if (sha(ca) !== sha(cb)) { canvasDiff++; if (canvasDiff === 1) { writeFileSync(path.join(OUT, 'diff_a.png'), Buffer.from(ca.split(',')[1], 'base64')); writeFileSync(path.join(OUT, 'diff_b.png'), Buffer.from(cb.split(',')[1], 'base64')); console.log('  first canvas difference at frame', i); } }
      if (i % 600 === 599) console.log(`  frame ${i + 1}: state ${da.state}, Steve (${da.P[0]}, ${da.P[1]}) hp ${da.P[5]}, ents ${da.nEnts}, Math.random draws ${da.mr} vs ${db.mr}`);
    }
  }
  if (firstDiff) console.error('  first state difference:', JSON.stringify(firstDiff));
  check(!firstDiff, `state digests identical at all ${compared} checkpoints over ${FRAMES} frames (incl. Math.random draw counts)`);
  check(canvasDiff === 0, MASK_MENU ? `canvas identical at all ${compared - menuFrames} checkpoints outside the START menu (${canvasDiff} differ; ${menuFrames} START-menu checkpoints not compared)`
    : `canvas identical at all ${compared} checkpoints, START menu included (${canvasDiff} differ)`);
  check(!A.errors.length && !B.errors.length, 'no page errors: ' + [...A.errors, ...B.errors].join(' | '));
  const gErr = await B.page.evaluate(() => (window.__rs.G.errors || []).length);
  check(gErr === 0, 'G.errors empty in the current tree');
  const netReq = B.reqs.filter((u) => /\/src\/net\//.test(u)).map((u) => u.replace(/^.*\/src\//, 'src/'));
  check(netReq.join() === 'src/net/flag.js' && !B.sockets.length, `single-player network footprint: ${netReq.join(', ')}; sockets ${B.sockets.length}`);

  // a save written by the baseline loads in the current tree to the same state
  const saved = await A.page.evaluate(() => { window.__rs.save(); return localStorage.getItem('poke-redstone-v1'); });
  const A2 = await open(PA, '?play', saved), B2 = await open(PB, '?play', saved);
  for (let i = 0; i < 60; i++) await Promise.all([A2.page.evaluate(() => window.__rs.tick({ dt: 1 / 30, capture: false })), B2.page.evaluate(() => window.__rs.tick({ dt: 1 / 30, capture: false }))]);
  const [la, lb] = await Promise.all([A2.page.evaluate(DIGEST), B2.page.evaluate(DIGEST)]);
  if (JSON.stringify(la) !== JSON.stringify(lb)) console.error('  loaded:', JSON.stringify(la), '\n  vs    :', JSON.stringify(lb));
  check(JSON.stringify(la) === JSON.stringify(lb), `old save (${(saved.length / 1024).toFixed(0)} KiB from the baseline) loads identically in the current tree`);
  const resaved = await B2.page.evaluate(() => { window.__rs.save(); return localStorage.getItem('poke-redstone-v1'); });
  const resavedA = await A2.page.evaluate(() => { window.__rs.save(); return localStorage.getItem('poke-redstone-v1'); });
  check(resaved === resavedA, 'saving again writes byte-identical saves in both trees');
  // the world update (design 4.3, 4.6, 10.1): a Classic world, new or loaded from a save, loads no generator module,
  // worker, terrain table or second atlas. Checked over every current-tree context's requests (workers included) and
  // over everything the current tree's server was asked for.
  const GEN = /\/src\/gen\/|terrain\.json|atlas_gen\.png/;
  const genReq = [...new Set([...curReqs.map((u) => u.replace(/^https?:\/\/[^/]+/, '')), ...curSeen].filter((u) => GEN.test(u)))];
  check(curSeen.length > 0 && !genReq.length, `Classic (new game and loaded save) loads nothing of the generated worlds (src/gen/, terrain.json, atlas_gen.png): ${curSeen.length} server requests, ${curReqs.length} context requests${genReq.length ? '; requested: ' + genReq.join(', ') : ''}`);

  // frame time. Per-frame times are below the timer's resolution, so each sample is the mean of a block of 50
  // frames. The two pages alternate block by block (which page goes first alternates too), so machine drift and
  // other load hit both alike, and the pages of the long run above are closed first. The figure compared is the
  // 20th percentile of 120 samples per page: the cost of a frame when the machine is not busy elsewhere. (The median
  // of 250-frame blocks, used before, moved by 10 to 55% between two copies of the same tree on a loaded machine.)
  // A result over 10% is measured once more before it fails, and both measurements are printed.
  await Promise.all([A.ctx.close(), B.ctx.close()]);
  const block = [() => { const h = window.__rs, t = performance.now(); for (let i = 0; i < 50; i++) h.tick({ dt: 1 / 30, capture: false, hold: i % 40 < 20 ? 'left' : 'right' }); return (performance.now() - t) / 50; }];
  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; };
  const measure = async () => {
    const ta = [], tb = [];
    for (let k = 0; k < 120; k++) {
      if (k % 2) { tb.push(await B2.page.evaluate(...block)); ta.push(await A2.page.evaluate(...block)); }
      else { ta.push(await A2.page.evaluate(...block)); tb.push(await B2.page.evaluate(...block)); }
    }
    const pa = pct(ta, 0.2), pb = pct(tb, 0.2);
    console.log(`  frame time (update + draw), 20th percentile of 120 blocks of 50 frames: baseline ${pa.toFixed(3)} ms, current ${pb.toFixed(3)} ms (${((pb / pa - 1) * 100).toFixed(1)}%); medians ${pct(ta, 0.5).toFixed(3)} and ${pct(tb, 0.5).toFixed(3)} ms`);
    return pb / pa - 1;
  };
  // ...and shown again for the frame time, so the 10% check measures the minimap's real cost
  await B2.page.evaluate(() => { if (window.__rs.minimap) window.__rs.minimap({ show: true }); });
  let dt = await measure();
  if (Math.abs(dt) >= 0.1) { console.log('  over 10%: measuring again'); dt = await measure(); }
  check(Math.abs(dt) < 0.1, 'frame time within 10% (machine noise; the design target is 3% on a quiet machine)');
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
