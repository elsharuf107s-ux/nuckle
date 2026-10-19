#!/usr/bin/env node
// Headless test harness: serves the game on its own port, opens it in headless Chrome, runs a test
// script against window.__rs one frame at a time, and reports failures.
//
//   node tools/headless.mjs path/to/test.mjs [--out dir] [--params '?new&play'] [--port 5400]
//
// The test module's default export receives a toolkit:
//   page                   the Playwright page
//   R(expr)                evaluate an expression with h (=__rs), G, P, W (=world), A in scope
//   run(fn, arg)           page.evaluate(fn, arg)
//   tick(opts)             one 1/30 s frame: {hold, press, dt}
//   idle(n)                n plain frames
//   press(key, after=6)    tap a key, then idle
//   hold(key, n)           hold a key for n frames
//   walkTo(x, y)           step toward a cell (straight lines, x first) until there or stuck
//   until(pred, {max})     tick until the expression is true; presses A through field and battle messages
//   shot(name)             save the canvas as <out>/<name>.png and return the path
//   check(cond, msg)       record a failure (the run exits 1 if any check failed or the page threw)
//   log(...)               print
// The page never touches the player's real save: ?new skips loading it and nothing here saves.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const script = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (!script) { console.error('usage: node tools/headless.mjs test.mjs [--out dir] [--params ?new&play] [--port n]'); process.exit(2); }
const PORT = Number(opt('--port', 5400 + (process.pid % 400)));
const OUT = path.resolve(opt('--out', path.join(ROOT, 'out', 'headless')));
const PARAMS = opt('--params', '?new&play');
mkdirSync(OUT, { recursive: true });

const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
const { chromium } = createRequire(import.meta.url)(pwDir);

const server = spawn('python3', [path.join(ROOT, 'serve.py'), String(PORT)], { stdio: 'ignore' });
const failures = [];
const pageErrors = [];
let browser;
try {
  await new Promise((r) => setTimeout(r, 700));
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/${PARAMS}`);
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
  await page.evaluate(() => { const h = window.__rs; h.pause(); h.seed(2026); if (h.rules) { h.rules.encounters = false; } });

  const R = (expr) => page.evaluate(new Function('return (() => { const h = window.__rs, G = h.G, P = h.P, W = h.world, A = h.A; return (' + expr + '); })()'));
  const run = (fn, arg) => page.evaluate(fn, arg);
  const tick = (o = {}) => page.evaluate((x) => { window.__rs.tick(x); }, { dt: 1 / 30, capture: false, ...o });
  const idle = async (n) => { for (let i = 0; i < n; i++) await tick(); };
  const press = async (key, after = 6) => { await tick({ press: key }); await idle(after - 1); };
  const hold = async (key, n) => { for (let i = 0; i < n; i++) await tick({ hold: key, press: i === 0 ? key : undefined }); };
  const walkTo = async (x, y, max = 600) => {
    for (let i = 0; i < max; i++) {
      const [px, py, moving] = await R('[P.tx, P.ty, P.moving]');
      if (px === x && py === y && !moving) return true;
      const dir = px < x ? 'right' : px > x ? 'left' : py > y ? 'up' : 'down';
      await tick({ hold: dir });
    }
    return false;
  };
  const until = async (pred, { max = 3000, read = 20 } = {}) => {
    let shown = 0;
    for (let i = 0; i < max; i++) {
      const st = await page.evaluate((p) => {
        const h = window.__rs, b = h.battle && h.battle();
        let done = false, needPress = false;
        if (h.state() === 'battle' && b && b.cur && b.cur.type === 'msg') {
          done = b.cur.shown >= b.cur.pages[b.cur.page].join('').length; needPress = b.cur.press || b.cur.page < b.cur.pages.length - 1;
        } else if (h.msg && h.msg()) {
          const m = h.msg(); done = m.shown >= m.pages[m.page].join('').length; needPress = !m.ask;
        }
        return { ok: new Function('h', 'G', 'P', 'W', 'return ' + p)(h, h.G, h.P, h.world), done, needPress };
      }, pred);
      if (st.ok) return true;
      if (st.done && st.needPress && ++shown >= read) { shown = 0; await tick({ press: 'a' }); continue; }
      if (!st.done) shown = 0;
      await tick();
    }
    return false;
  };
  const shot = async (name) => {
    const url = await page.evaluate(() => window.__rs.frame());
    const file = path.join(OUT, name.endsWith('.png') ? name : name + '.png');
    writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    return file;
  };
  const check = (cond, msg) => { if (!cond) { failures.push(msg); console.error('FAIL', msg); } else console.log('ok  ', msg); };
  const log = (...a) => console.log(...a);

  const mod = await import(pathToFileURL(path.resolve(script)).href);
  await mod.default({ page, R, run, tick, idle, press, hold, walkTo, until, shot, check, log, OUT });
} catch (e) {
  failures.push('harness: ' + (e && e.stack || e));
  console.error(e);
} finally {
  if (browser) await browser.close();
  server.kill();
}
for (const e of pageErrors) failures.push('page error: ' + e);
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ failures }, null, 2));
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
