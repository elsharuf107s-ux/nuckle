#!/usr/bin/env node
// Frame time while sprinting across chunks (design 10.6, 11.8; the stage 4a part: no saves yet). Runs the game in
// headless Chrome with its own requestAnimationFrame loop (never __rs.tick), moves Steve at sprint speed (6.7 cells a
// second) along a line with an in-page rAF driver that ignores collisions (so the path never stops at a tree or a
// lake), and records every real frame through the game's perf hook: its interval, the main-thread work of update and
// draw, and the part of that work that was generation (applying chunks, the prefetch, drawing new chunks' canvases).
//
//   node tools/gen_tests/perf.mjs [--port 5620] [--seed 1] [--cells 600] [--classic-cells 300] [--no-throttle]
//
// Runs: Classic (a straight line across Kanto, the baseline), a Wild World straight and zigzag on desktop
// (960 x 720), and a Wild World straight with 4x CPU throttling on a 390 x 844 touch profile. Reports per run the frame
// counts over 25 / 50 ms, which of them had generation work, the largest generation share of one frame, and means;
// plus the boot (plan, spawn area), teleport waits into unexplored land and the JS heap. Exits 1 if a desktop frame
// over 25 ms or a throttled frame over 50 ms was caused by generation (a frame whose work minus its generation
// would have been under the limit), if the Wild World's mean frame work is more than 10% over Classic's plus 0.5 ms
// (a floor for sub-millisecond means), or if the throttled spawn area (terrain files, plan, 3 x 3 chunks and canvases) took
// 2 s or more.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('--port', 5620)), SEED = opt('--seed', '1'), CELLS = Number(opt('--cells', 600)), CCELLS = Number(opt('--classic-cells', 300));
const THROTTLE = !argv.includes('--no-throttle');
const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
const { chromium } = createRequire(import.meta.url)(pwDir);

const server = spawn('python3', [path.join(ROOT, 'serve.py'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const failures = [];
const report = {};

// the in-page driver: legs [dx, dy, cells] at 6.7 cells a second in the page's own rAF
const GLIDE = (legs) => new Promise((resolve) => {
  const h = window.__rs, P = h.P, W = h.world;
  let fx = P.tx, fy = P.ty, leg = 0, left = legs[0][2], last = null, lastCell = '';
  const step = (now) => {
    if (last === null) last = now;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    let d = 6.7 * dt;
    while (d > 0 && leg < legs.length) {
      const [dx, dy] = legs[leg], m = Math.min(d, left);
      fx += dx * m; fy += dy * m; left -= m; d -= m;
      P.dir = dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up';
      if (left <= 0) { leg++; if (leg < legs.length) left = legs[leg][2]; }
    }
    P.tx = P.fromX = Math.round(fx); P.ty = P.fromY = Math.round(fy); P.fx = fx; P.fy = fy; P.moving = false; P.swimming = false;
    const cell = P.tx + ',' + P.ty;
    if (cell !== lastCell) { lastCell = cell; if (h.gen) h.gen.step(); }
    if (leg >= legs.length) { resolve({ end: [P.tx, P.ty], unready: W.ready ? !W.ready(P.tx, P.ty) : false }); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});

function summarize(log, limit) {
  const n = log.length, work = log.map((f) => f[1]), sorted = [...work].sort((a, b) => a - b), iv = log.map((f) => f[0]).filter((x) => x > 0).sort((a, b) => a - b);
  const q = (a, p) => +(a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] || 0).toFixed(2);
  const over = log.filter((f) => f[1] > limit), overGen = over.filter((f) => f[2] > 0), causedByGen = over.filter((f) => f[1] - f[2] < limit);
  return {
    frames: n, meanWork: +(work.reduce((a, b) => a + b, 0) / n).toFixed(3), p50: q(sorted, 0.5), p95: q(sorted, 0.95), p99: q(sorted, 0.99), max: q(sorted, 1),
    meanInterval: +(iv.reduce((a, b) => a + b, 0) / iv.length).toFixed(2), p99Interval: q(iv, 0.99),
    genFrames: log.filter((f) => f[2] > 0).length, maxGen: +Math.max(0, ...log.map((f) => f[2])).toFixed(2), meanGen: +(log.reduce((a, f) => a + f[2], 0) / n).toFixed(3),
    over: over.length, overWithGen: overGen.length, overCausedByGen: causedByGen.length, limit,
    worst: [...log].sort((a, b) => b[1] - a[1]).slice(0, 5).map((f) => f.map((x) => +x.toFixed(1))),
  };
}

async function open(params, { throttle = false, phone = false } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 960, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (throttle) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/${params}`);
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 180000 });
  const readyMs = Date.now() - t0;
  await page.evaluate(() => { const h = window.__rs; h.rules.encounters = false; h.rules.mobs = false; h.setTime(6000); });
  return { ctx, page, errors, readyMs };
}
async function run(page, legs) {
  await page.evaluate(() => window.__rs.perf(true));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__rs.perf(true));
  const end = await page.evaluate(GLIDE, legs);
  const log = await page.evaluate(() => window.__rs.perfLog().slice());
  await page.evaluate(() => window.__rs.perf(false));
  return { end, log };
}
const gerrs = (page) => page.evaluate(() => window.__rs.G.errors || []);

try {
  // ---- Classic: the baseline
  {
    const { ctx, page, errors, readyMs } = await open('?new&play');
    await page.evaluate(() => { const h = window.__rs; h.teleport(10, 150); });
    const r = await run(page, [[1, 0, CCELLS]]);
    report.classic = { readyMs, ...summarize(r.log, 25), errors: [...errors, ...(await gerrs(page))] };
    console.log('classic', JSON.stringify(report.classic));
    await ctx.close();
  }
  // ---- Wild World, desktop
  {
    const { ctx, page, errors, readyMs } = await open(`?new&play&world=wild&wseed=${SEED}`);
    const boot = await page.evaluate(() => { const h = window.__rs; return { bootMs: h.gen.bootMs(), planMs: h.gen.planMs(), planWallMs: h.gen.planWallMs(), spawn: h.gen.plan().spawn, border: h.world.layout.border }; });
    const sp = boot.spawn, b = boot.border;
    const east = b.x1 - sp.px > CELLS + 20 ? 1 : -1, down = b.y1 - sp.py > CELLS / 2 + 20 ? 1 : -1;
    const s = await run(page, [[east, 0, CELLS]]);
    const zz = []; for (let k = 0; k < Math.round(CELLS / 24); k++) zz.push(k % 2 ? [0, down, 24] : [-east, 0, 24]);
    const z = await run(page, zz);
    // teleport waits into unexplored land (ensure, 3 x 3 chunks)
    const waits = await page.evaluate(async () => {
      const h = window.__rs, W = h.world, out = [];
      for (const [x, y] of [[700, 300], [1700, 1300], [1100, 1450]]) { const t = performance.now(); await h.ensure(x, y, 1); out.push(+(performance.now() - t).toFixed(1)); }
      return out;
    });
    const mem = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
    const stats = await page.evaluate(() => ({ ...window.__rs.gen.stream.stats, workerMs: (() => { const a = [...window.__rs.gen.client.workerMs].sort((x, y) => x - y); return { n: a.length, p50: +a[a.length >> 1].toFixed(1), max: +a[a.length - 1].toFixed(1) }; })() }));
    report.wild = { readyMs, boot, straight: summarize(s.log, 25), zigzag: summarize(z.log, 25), ends: [s.end, z.end], teleportWaitMs: waits, heapMB: mem, stream: stats, errors: [...errors, ...(await gerrs(page))] };
    console.log('wild', JSON.stringify(report.wild));
    await ctx.close();
  }
  // ---- Wild World, 4x CPU throttling, 390 x 844 touch profile
  if (THROTTLE) {
    const { ctx, page, errors, readyMs } = await open(`?new&play&world=wild&wseed=${SEED}`, { throttle: true, phone: true });
    const boot = await page.evaluate(() => { const h = window.__rs; return { bootMs: h.gen.bootMs(), planMs: h.gen.planMs(), planWallMs: h.gen.planWallMs(), cap: h.world.chunkCap, spawn: h.gen.plan().spawn, border: h.world.layout.border }; });
    const sp = boot.spawn, b = boot.border, east = b.x1 - sp.px > CELLS + 20 ? 1 : -1;
    const s = await run(page, [[east, 0, CELLS]]);
    const stats = await page.evaluate(() => ({ ...window.__rs.gen.stream.stats, workerMs: (() => { const a = [...window.__rs.gen.client.workerMs].sort((x, y) => x - y); return { n: a.length, p50: +a[a.length >> 1].toFixed(1), max: +a[a.length - 1].toFixed(1) }; })() }));
    report.throttled = { readyMs, boot, straight: summarize(s.log, 50), end: s.end, stream: stats, errors: [...errors, ...(await gerrs(page))] };
    console.log('throttled', JSON.stringify(report.throttled));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}

// ---- verdicts
const C = report.classic, Wd = report.wild, T = report.throttled;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failures.push(msg); };
for (const [k, r] of [['straight', Wd.straight], ['zigzag', Wd.zigzag]]) {
  check(r.overCausedByGen === 0, `desktop ${k}: no frame over 25 ms caused by generation (${r.over} over 25 ms, ${r.overWithGen} of them with generation work, max generation in a frame ${r.maxGen} ms)`);
}
const lim = C.meanWork * 1.1 + 0.5;
check(Wd.straight.meanWork <= lim, `desktop straight: mean frame work ${Wd.straight.meanWork} ms within 10% of Classic's ${C.meanWork} ms (+0.5 ms floor)`);
check(Wd.zigzag.meanWork <= lim, `desktop zigzag: mean frame work ${Wd.zigzag.meanWork} ms within 10% of Classic's ${C.meanWork} ms (+0.5 ms floor)`);
if (T) {
  check(T.straight.overCausedByGen === 0, `throttled straight: no frame over 50 ms caused by generation (${T.straight.over} over 50 ms, ${T.straight.overWithGen} with generation work, max generation in a frame ${T.straight.maxGen} ms)`);
  check(T.boot.bootMs < 2000, `throttled: the spawn area ready ${Math.round(T.boot.bootMs)} ms after the world's boot began (target under 2 s; of it terrain files and the plan ${Math.round(T.boot.planWallMs)} ms, the plan in the worker ${Math.round(T.boot.planMs)} ms)`);
}
const errs = [...C.errors, ...Wd.errors, ...(T ? T.errors : [])];
check(errs.length === 0, 'no page errors or G.errors ' + errs.join(' | ').slice(0, 300));
console.log(failures.length ? `${failures.length} failure(s)` : 'all checks passed');
process.exit(failures.length ? 1 : 0);
