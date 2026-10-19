#!/usr/bin/env node
// The world update's menus, headless (design 6.3, 6.4, 7; stages 8a, 8b and 9 without the generator): opens every new
// screen on a desktop page (1280 x 800, mouse and keys) and on a phone (390 x 844, touch, the pad and the phone keyboard
// path) through tools/gen_tests/menus.html, drives them, checks what they return, and saves a picture of each state.
//
//   node tools/gen_tests/menus.mjs [--port 5550] [--out <dir>] [--only desktop|phone]
//
// Also runs the pure checks of src/modes.js (tools/gen_tests/menus_modes.mjs) first. Exit 1 on any failed check or
// page error. Pictures: <out>/desktop-*.png and <out>/phone-*.png (canvas captures, 480 x 320) and <out>/*-page-*.png
// (whole-page screenshots, where the page-level text box or the touch pad matters).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runModeChecks } from './menus_modes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('--port', 5550));
if (PORT === 5300 || PORT === 5301) throw new Error('ports 5300 and 5301 are reserved for the dev server');
const OUT = path.resolve(opt('--out', path.join(ROOT, 'out', 'gen-tests', 'menus')));
const ONLY = opt('--only', null);
mkdirSync(OUT, { recursive: true });
const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
const { chromium } = createRequire(import.meta.url)(pwDir);

const failures = [];
const check = (cond, msg) => { if (!cond) { failures.push(msg); console.error('FAIL', msg); } else console.log('ok  ', msg); };
const log = (...a) => console.log(...a);
const shots = [];

// ------------------------------------------------------------------------------------------- pure checks first
for (const [ok, msg] of runModeChecks()) check(ok, 'modes: ' + msg);

const server = spawn('python3', [path.join(ROOT, 'serve.py'), String(PORT)], { stdio: 'ignore' });
let browser;
try {
  await new Promise((r) => setTimeout(r, 700));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const profiles = [
    { name: 'desktop', ctx: { viewport: { width: 1280, height: 800 } }, touch: false },
    { name: 'phone', ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, touch: true },
  ].filter((p) => !ONLY || p.name === ONLY);
  const typed = {};
  for (const prof of profiles) typed[prof.name] = await runProfile(prof);
  if (typed.desktop && typed.phone) {
    check(JSON.stringify(typed.desktop.req) === JSON.stringify(typed.phone.req), `the same seed text typed on desktop and phone gives the same request (${JSON.stringify(typed.phone.req)})`);
    check(typed.desktop.seed === typed.phone.seed && typed.phone.seed === 99162322, `"hello" is seed ${typed.phone.seed} on both (Java's "hello".hashCode() is 99162322)`);
  }
} catch (e) {
  failures.push('harness: ' + (e && e.stack || e));
  console.error(e);
} finally {
  if (browser) await browser.close();
  server.kill();
}
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ failures, shots }, null, 2));
console.log(`\n${shots.length} pictures in ${OUT}`);
console.log(failures.length ? `${failures.length} failure(s)` : 'all checks passed');
process.exit(failures.length ? 1 : 0);

// ------------------------------------------------------------------------------------------- one device
async function runProfile(prof) {
  log(`\n== ${prof.name} ==`);
  const context = await browser.newContext(prof.ctx);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.error('PAGE ERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) console.error('HTTP', r.status(), r.url()); });
  page.on('requestfailed', (r) => console.error('request failed', r.url(), r.failure() && r.failure().errorText));
  await page.goto(`http://127.0.0.1:${PORT}/tools/gen_tests/menus.html`);
  await page.waitForFunction(() => window.__menus && window.__menus.ready, null, { timeout: 90000 });
  const P = prof.name;
  const M = (expr) => page.evaluate(new Function('return (() => { const m = window.__menus, s = m.screen(), t = m.top(); return (' + expr + '); })()'));
  const tick = (o = {}) => page.evaluate((x) => window.__menus.tick(x), o);
  const idle = async (n) => { for (let i = 0; i < n; i++) await tick(); };
  const press = async (k, after = 2) => { await tick({ press: k }); await idle(after - 1); };
  const shot = async (name) => {
    const url = await page.evaluate(() => window.__menus.frame());
    const file = path.join(OUT, `${P}-${name}.png`);
    writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    shots.push(file);
    return file;
  };
  const pageShot = async (name) => { const file = path.join(OUT, `${P}-page-${name}.png`); await page.screenshot({ path: file }); shots.push(file); return file; };
  const open = (name, opts = {}) => page.evaluate(([n, o]) => window.__menus.open(n, o), [name, opts]);
  // a tap (phone) or a click (desktop) at canvas coordinates
  const at = async (cx, cy) => { const r = await M('m.canvasRect()'); return [r.x + (cx + 0.5) * r.w / 480, r.y + (cy + 0.5) * r.h / 320]; };
  const tap = async (cx, cy, frames = 2) => {
    const [x, y] = await at(cx, cy);
    if (prof.touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
    await idle(frames);
  };
  const tapW = async (wexpr, frames = 2) => {
    let w;
    try { w = await M(wexpr); } catch (err) { throw new Error(`${wexpr} on ${await M('t && t.kind')} (${await M('JSON.stringify(s.result)')}): ${err.message}`); }
    await tap(w.x + w.w / 2, w.y + w.h / 2, frames);
  };
  const pad = async (k, frames = 2) => { await page.tap(`#pad button[data-k="${k}"]`); await idle(frames); };
  // a button: the pad on the phone, the keyboard on the desktop
  const key = async (k, frames = 2) => {
    if (prof.touch) { await pad(k, frames); return; }
    const K = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: 'z', b: 'x', start: 'Enter', inv: 'e', esc: 'Escape' }[k] || k;
    await page.keyboard.press(K); await idle(frames);
  };
  const worldsSample = [
    { id: 'classic', name: 'Classic Kanto', type: 'classic', played: Date.UTC(2026, 8, 30, 18, 5) },
    { id: 'w1', name: 'Pallet Getaway', type: 'kanto', mode: 'survival', diff: 'normal', seedText: 'hello', played: Date.UTC(2026, 9, 7, 21, 40), playTime: 7300 },
    { id: 'w2', name: 'Frozen North', type: 'wild', mode: 'hardcore', diff: 'hard', played: Date.UTC(2026, 9, 6, 9, 12), hc: { dead: true, at: 1, cause: 'Steve fell from a high place' } },
    { id: 'w3', name: 'Sandbox', type: 'wild', mode: 'creative', diff: 'normal', seed: -1407346542, played: Date.UTC(2026, 9, 8, 7, 3) },
  ];
  const cont = { name: 'Pallet Getaway', type: 'kanto', mode: 'survival', playTime: 7300 };

  // ----------------------------------------------------------------- the title flow: FireRed's menu
  await open('flow', { cont, worlds: worldsSample });
  await idle(2);
  check(await M("t.kind === 'titleMenu' && t.items.map((i) => i.id).join() === 'continue,new,worlds'"), `${P}: the main menu has CONTINUE, NEW GAME, WORLDS (more than one world)`);
  await shot('title-continue');
  await key('down');
  check(await M('t.sel === 1'), `${P}: down moves to NEW GAME`);
  await shot('title-newgame');
  // the windows end above the fan notice (its first line is at y 286)
  check(await M('t.items.every((i) => (i.y + i.h) * 2 <= 284)'), `${P}: the menu windows end above the fan notice`);
  await key('a');
  check(await M("t.kind === 'createWorld'"), `${P}: A on NEW GAME opens Create New World`);

  // ----------------------------------------------------------------- Create New World
  await shot('create-game');
  check(await M("t.w.mode.label() === 'Game Mode: Survival' && t.w.diff.label() === 'Difficulty: Normal' && !t.w.diff.hidden"), `${P}: Survival on Normal by default`);
  // A on Game Mode (it has the focus) cycles to Hardcore
  if (prof.touch) await tapW('t.w.mode'); else await key('a');
  check(await M("t.mode === 'hardcore' && t.w.diff.label() === 'Difficulty: Hard' && t.w.diff.active === false"), `${P}: Hardcore locks the difficulty at Hard (disabled)`);
  check(await M("t.descLines().some((l) => l.text === 'Losing a POKéMON battle counts as dying.')"), `${P}: Hardcore says a lost battle counts as dying`);
  await shot('create-hardcore');
  if (prof.touch) await tapW('t.w.mode'); else await key('right');
  check(await M("t.mode === 'creative' && t.w.diff.hidden"), `${P}: Creative hides the difficulty`);
  await shot('create-creative');
  if (prof.touch) await tapW('t.w.mode'); else { await key('left'); await key('left'); }
  check(await M("t.mode === 'survival'"), `${P}: Game Mode cycles back to Survival`);
  // difficulty: the pad's down then right (phone) or the mouse (desktop)
  if (prof.touch) { await pad('down'); await pad('right'); } else await tapW('t.w.diff');
  check(await M("t.diff === 'hard'"), `${P}: Difficulty cycles Normal to Hard (${await M('t.diff')})`);
  // the World Name field: the page-level text box (on a phone it opens inside the tap's own touchend, before any frame
  // runs, which is what lets an iPhone raise its keyboard on the first tap)
  await tapW('t.w.name', prof.touch ? 0 : 2);
  let e = await M('m.entry()');
  if (prof.touch) check(e && e.open && e.focused, `${P}: the box opened and took the focus inside the tap's touchend, 0 frames after it`);
  await idle(prof.touch ? 2 : 0);
  if (prof.touch) check(await M("t.kind === 'createWorld' && !!m.entry()"), `${P}: the same tap is not handled twice (the box stays open, still on Create New World)`);
  e = await M('m.entry()');
  check(e && e.open && e.focused && e.label === 'World Name' && e.value === 'New World', `${P}: tapping World Name opens the text box with the name, focused`);
  check(e && e.attrs.autocapitalize === 'off' && e.attrs.autocorrect === 'off' && e.attrs.autocomplete === 'off' && e.attrs.spellcheck === 'false', `${P}: the text box has autocapitalize, autocorrect, autocomplete and spellcheck off (${e && JSON.stringify(e.attrs)})`);
  for (let i = 0; i < 9; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('Route Thirty');
  await idle(1);
  check(await M("t.name === 'Route Thirty'"), `${P}: the name updates as it is typed (${await M('t.name')})`);
  await pageShot('create-name-entry');
  if (prof.touch) await page.tap('#rs-text-entry button[type=submit]'); else await page.keyboard.press('Enter');
  await idle(2);
  check(!(await M('m.entry()')) && (await M("t.name === 'Route Thirty'")), `${P}: OK (or Enter) closes the box and keeps the name`);
  // the World tab
  await tapW('t.w.tabWorld');
  check(await M('t.tab === 1 && !t.w.type.hidden && !t.w.seed.hidden && t.w.name.hidden'), `${P}: the World tab shows World Type and the seed`);
  check(await M("t.w.type.label() === 'World Type: Kanto World'"), `${P}: Kanto World by default`);
  await shot('create-world-tab');
  await tapW('t.w.type');
  check(await M("t.type === 'wild' && t.w.type.label() === 'World Type: Wild World'"), `${P}: World Type cycles to Wild World`);
  await shot('create-world-wild');
  // the seed: typed on the phone keyboard path (tap, type, the overlay's OK) or the desktop keyboard (A, type, Enter)
  if (prof.touch) await tapW('t.w.seed');
  else { const vis = await M('t.visible().indexOf(t.w.seed)'); await page.evaluate((i) => { window.__menus.top().focus = i; }, vis); await key('a'); }
  e = await M('m.entry()');
  check(e && e.open && e.label === 'Seed for the World Generator' && e.value === '', `${P}: the seed field opens the text box, empty`);
  await page.keyboard.type('hello');
  await idle(1);
  await pageShot('create-seed-entry');
  if (prof.touch) await page.tap('#rs-text-entry button[type=submit]'); else await page.keyboard.press('Enter');
  await idle(2);
  check(await M("t.seedText === 'hello' && !m.entry()"), `${P}: the seed reads "hello" (${await M('t.seedText')})`);
  await shot('create-seed');
  // Cancel in the box restores the old value
  await tapW('t.w.seed');
  await page.keyboard.type('XYZ');
  await idle(1);
  if (prof.touch) await page.tap('#rs-text-entry button.cancel'); else await page.keyboard.press('Escape');
  await idle(2);
  check(await M("t.seedText === 'hello'"), `${P}: Cancel in the text box keeps the old seed`);
  if (prof.touch) {
    // the pad answers the box and never reaches the screen behind it: B cancels, A commits
    await tapW('t.w.seed');
    await page.keyboard.type('zzz');
    await idle(1);
    await pad('b', 3);
    check(!(await M('m.entry()')) && (await M("t.kind === 'createWorld' && t.seedText === 'hello' && t.diff === 'hard' && t.name === 'Route Thirty' && t.tab === 1")),
      `${P}: the pad's B with the box open cancels the box and stays in Create New World, the form kept (${await M("t.kind + ' ' + JSON.stringify([t.seedText, t.diff, t.name])")})`);
    await pageShot('create-after-pad-b');
    await tapW('t.w.seed');
    await pad('a', 3);
    check(!(await M('m.entry()')) && (await M("t.kind === 'createWorld' && t.seedText === 'hello'")), `${P}: the pad's A with the box open commits it and does not reopen it`);
    await tapW('t.w.seed');
    await pad('start', 3);
    check(!(await M('m.entry()')) && (await M("t.kind === 'createWorld'")), `${P}: the pad's MENU with the box open commits it and stays`);
  }
  // Create New World
  await tapW('t.w.create', 3);
  const r = await M('s.result');
  check(await M('s.done') && r && r.op === 'new' && r.name === 'Route Thirty' && r.type === 'wild' && r.mode === 'survival' && r.diff === 'hard' && r.seedText === 'hello',
    `${P}: Create New World ends the flow with ${JSON.stringify(r)}`);
  const req = await M('m.bootRequest(s.result)');
  const seed = await M("m.MD.seedFromText(s.result.seedText).seed");

  // ----------------------------------------------------------------- B goes back: create -> title -> PRESS START
  await open('flow', { cont, worlds: worldsSample });
  await key('down'); await key('a');
  await key('b');
  check(await M("t.kind === 'titleMenu' && !s.done"), `${P}: B in Create New World goes back to the main menu`);
  await key('b');
  check(await M("s.done && s.result.op === 'back'"), `${P}: B on the main menu goes back to PRESS START`);
  await open('flow', { cont, worlds: worldsSample });
  await key('a');
  check(await M("s.done && s.result.op === 'continue'"), `${P}: A on CONTINUE plays the booted world`);
  // deleting the booted world in Select World takes CONTINUE away, and the flow ends with reboot, never continue
  await open('flow', { cont, bootedId: 'w1', worlds: worldsSample });
  await key('down'); await key('down'); await key('a');
  await page.evaluate(() => { const s = window.__menus.top(); s.sel = s.list.findIndex((w) => w.id === 'w1'); s.focus = s.visible().indexOf(s.w.del); });
  await key('a');
  if (prof.touch) await tapW('t.child.w.yes', 3); else { await key('left'); await key('a', 3); }
  check(await M("m.deleted.includes('w1') && t.kind === 'selectWorld' && !t.list.some((w) => w.id === 'w1')"), `${P}: the booted world can be deleted from Select World`);
  await key('b');
  // (playfix: CONTINUE moves to the newest world left, w3, and plays it with a load; it was gone before)
  check(await M("t.kind === 'titleMenu' && t.items.map((i) => i.id).join() === 'continue,new,worlds' && t.cont && t.cont.id === 'w3'"), `${P}: back on the main menu CONTINUE is the newest world left (${await M("t.items.map((i) => i.id).join()")}, ${await M('t.cont && t.cont.id')})`);
  await shot('title-after-booted-delete');
  await key('b');
  check(await M("s.done && s.result.op === 'reboot'"), `${P}: B then ends the flow with reboot, so the caller reloads (${JSON.stringify(await M('s.result'))})`);

  // ----------------------------------------------------------------- Select World
  await open('flow', { cont, worlds: worldsSample });
  if (prof.touch) await tap(120 * 2, (108 + 16) * 2); else { await key('down'); await key('down'); await key('a'); }
  check(await M("t.kind === 'selectWorld' && t.list.length === 4"), `${P}: WORLDS opens Select World with 4 worlds`);
  check(await M("t.list.map((w) => w.id).join() === 'w3,w1,w2,classic'"), `${P}: the list is newest played first (${await M("t.list.map((w) => w.id).join()")})`);
  check(await M("m.seedOf(t.list[1]) === 'hello' && m.seedOf(t.list[0]) === '-1407346542' && m.seedOf(t.list[3]) === ''"), `${P}: the list's third line shows the seed (typed text, else the number; none for Classic)`);
  await shot('select');
  // pick the hardcore world and check its line
  if (prof.touch) await tap(240, 26 + 4 + 2 * 36 + 18); else { await key('down'); await key('down'); }
  check(await M("t.sel === 2 && t.list[2].id === 'w2'"), `${P}: the third row is selected`);
  check(await M("m.MD.worldLine(t.list[2]).mode === 'Hardcore Mode!' && m.MD.worldLine(t.list[2]).red"), `${P}: a hardcore world shows "Hardcore Mode!" in red`);
  await shot('select-hardcore-row');
  // delete it: one confirmation
  if (prof.touch) await tapW('t.w.del'); else { await page.evaluate(() => { const s = window.__menus.top(); s.focus = s.visible().indexOf(s.w.del); }); await key('a'); }
  check(await M("t.child && t.child.kind === 'confirm' && t.child.title === 'Are you sure you want to delete this world?'"), `${P}: Delete asks "Are you sure you want to delete this world?"`);
  check(await M("t.child.lines[0].text === \"'Frozen North' will be lost forever! (A long time!)\""), `${P}: with "'Frozen North' will be lost forever! (A long time!)"`);
  check(await M('t.child.focus === 1'), `${P}: the confirmation starts on Cancel`);
  await shot('delete-confirm');
  if (prof.touch) await tapW('t.child.w.yes', 3); else { await key('left'); await key('a', 3); }
  check(await M("!t.child && m.deleted.includes('w2') && t.list.length === 3"), `${P}: Delete removes the world (deleted ${await M('JSON.stringify(m.deleted)')})`);
  // Classic Kanto: two confirmations, the second button reads "Delete Classic Kanto"
  const ci = await M("t.list.findIndex((w) => w.id === 'classic')");
  if (prof.touch) await tap(240, 26 + 4 + ci * 36 + 18); else { await page.evaluate((i) => { const s = window.__menus.top(); s.sel = i; s.focus = 0; }, ci); await idle(1); }
  if (prof.touch) await tapW('t.w.del'); else { await page.evaluate(() => { const s = window.__menus.top(); s.focus = s.visible().indexOf(s.w.del); }); await key('a'); }
  check(await M("t.child && t.child.lines.some((l) => l.text === \"Classic Kanto can't be made again.\") && t.child.w.yes.label === 'Delete'"), `${P}: deleting Classic Kanto adds "Classic Kanto can't be made again."`);
  await shot('delete-classic-1');
  if (prof.touch) await tapW('t.child.w.yes', 3); else { await key('left'); await key('a', 3); }
  check(await M("t.child && t.child.w.yes.label === 'Delete Classic Kanto' && !m.deleted.includes('classic')"), `${P}: a second confirmation reads "Delete Classic Kanto", nothing deleted yet`);
  await shot('delete-classic-2');
  await idle(18);   // (playfix: the second confirmation ignores input for its first half second, a double click's guard)
  if (prof.touch) await tapW('t.child.w.no', 3); else await key('a', 3);
  check(await M("!t.child && !m.deleted.includes('classic') && t.list.some((w) => w.id === 'classic')"), `${P}: Cancel on the second confirmation keeps Classic Kanto`);
  // the keys: down at the end of the list moves on to the buttons
  if (!prof.touch) {
    await page.evaluate(() => { const s = window.__menus.top(); s.focus = 0; s.sel = s.list.length - 1; });
    await key('down');
    check(await M("t.visible()[t.focus] === t.w.play"), `${P}: down past the last world moves the focus to Play Selected World`);
    await key('down');
    check(await M("t.visible()[t.focus] === t.w.del"), `${P}: and down again to Delete`);
  }
  // play a world
  if (prof.touch) { await tap(240, 26 + 4 + 18); await tapW('t.w.play', 3); }
  else { await page.evaluate(() => { const s = window.__menus.top(); s.focus = 0; s.sel = 1; }); await key('up'); await key('a', 3); }
  check(await M("s.done && s.result.op === 'load' && s.result.id === 'w3'"), `${P}: Play Selected World loads it (${JSON.stringify(await M('s.result'))})`);

  // ----------------------------------------------------------------- too many worlds
  const five = [1, 2, 3, 4, 5].map((i) => ({ id: 'f' + i, name: 'World ' + i, type: i % 2 ? 'kanto' : 'wild', mode: 'survival', played: Date.UTC(2026, 9, i) }));
  await open('flow', { cont, worlds: five, start: 'select' });
  check(await M('t.w.create.active === false'), `${P}: Create New World is disabled at 5 worlds`);
  await tapW('t.w.create');
  check(await M("t.kind === 'selectWorld' && t.tipT > 0 && t.tipFor === t.w.create"), `${P}: tapping it shows "You have too many worlds"`);
  await shot('select-full');
  await open('create', { worlds: five });
  check(await M('t.w.create.active === false'), `${P}: and Create New World's own Create button too`);
  await tapW('t.w.create');
  await shot('create-full');
  check(await M('!s.done'), `${P}: a disabled Create does nothing`);

  // ----------------------------------------------------------------- loading screens
  await open('loading', { set: { phase: 'plan', progress: 0.4 } });
  check(await M("t.percent() === 40"), `${P}: Generating world: 40%`);
  await shot('loading-plan');
  await open('loading', { set: { phase: 'spawn', ready: 4, total: 9 } });
  check(await M("t.percent() === 44"), `${P}: Preparing spawn area: 44% (4 of 9 chunks)`);
  await shot('loading-spawn');
  await open('loading', { joining: true, set: { phase: 'spawn', ready: 9, total: 9 } });
  await shot('loading-join');

  // ----------------------------------------------------------------- hardcore death and spectating
  await open('death', { cause: 'Steve was slain by Zombie', score: 37 });
  await key('a'); await key('down');
  check(await M('!s.done && s.sel === 0'), `${P}: the buttons do nothing for the first second`);
  await shot('death-early');
  await idle(30);
  await shot('death');
  if (prof.touch) { await tapW('s.buttons[1]', 2); check(await M("s.done && s.result.op === 'title'"), `${P}: tapping Title Screen ends with title`); }
  else { await key('down'); await key('up'); await key('a'); check(await M("s.done && s.result.op === 'spectate'"), `${P}: A on Spectate World ends with spectate`); }
  await open('death', { cause: 'Steve blacked out', score: 0 });
  await idle(31);
  if (prof.touch) { await pad('down'); await pad('a'); check(await M("s.done && s.result.op === 'title'"), `${P}: the pad's down and A choose Title Screen`); }
  else { await tapW('s.buttons[0]'); check(await M("s.done && s.result.op === 'spectate'"), `${P}: clicking Spectate World ends with spectate`); }
  await open('spectator', { cause: 'Steve was slain by Zombie' });
  await idle(5);
  await shot('spectator');
  await idle(150);
  check(await M('m.overlay().shownT === 0'), `${P}: the spectator's death line fades after a few seconds`);
  await open('hearts');
  await shot('hearts');

  // ----------------------------------------------------------------- the creative inventory
  const tabs = await M('m.TABS.map((t) => t.id)');
  const contents = await M('m.tabContents()');
  const all = await M('Object.keys(m.A.items.items)');
  const offered = new Set(Object.values(contents).flat());
  const protectedIds = ['end_portal_frame', 'bedrock', 'spawner', 'infested_stone_bricks', 'infested_mossy_stone_bricks', 'nether_portal', 'end_portal', 'dragon_egg', 'lava', 'soul_fire'];
  check(protectedIds.every((id) => !offered.has(id)), `${P}: no protected item is in any tab`);
  check(['wither_skeleton_skull', 'nether_star', 'beacon', 'wither_rose'].every((id) => !offered.has(id)), `${P}: the paused Wither's items are in no tab`);
  const shouldOffer = await M("Object.keys(m.A.items.items).filter((id) => m.MD.inCreativeTabs(id, m.A.items.items[id]))");
  check(shouldOffer.every((id) => offered.has(id)), `${P}: every other item (${shouldOffer.length} of ${all.length}) is in a tab; missing: ${shouldOffer.filter((id) => !offered.has(id)).join(', ') || 'none'}`);
  check(Object.values(contents).every((l) => l.length > 0), `${P}: every item tab has items (${Object.entries(contents).map(([k, l]) => k + ' ' + l.length).join(', ')})`);
  if (P === 'desktop') {
    for (let i = 0; i < tabs.length; i++) { await open('creative', { tab: i, slots: { 0: { id: 'oak_planks', n: 12 }, 4: { id: 'iron_pickaxe', n: 1 } } }); await shot(`creative-${tabs[i]}`); }
  } else {
    for (const i of [0, 7, 9]) { await open('creative', { tab: i, slots: { 0: { id: 'oak_planks', n: 12 } } }); await shot(`creative-${tabs[i]}`); }
  }
  // take a stack from the grid and put it in the hotbar: keys/pad
  await open('creative', { tab: 0 });
  const first = await M('s.gridItem(0)');
  if (prof.touch) { await pad('right'); await pad('left'); }   // the pad moves the key cursor (first press may just switch from the pointer)
  await key('a');
  check(await M(`s.cursor && s.cursor.id === '${first}' && s.cursor.n === 64`), `${P}: A on the first item takes a full stack of ${first}`);
  // (down on the grid's last row scrolls while the tab has more rows: since 5a's items the first tab is longer than 5 rows)
  for (let i = 0; i < 60 && !(await M("s.sel.area === 'hot'")); i++) await key('down');
  check(await M("s.sel.area === 'hot'"), `${P}: down from the grid reaches the hotbar (${JSON.stringify(await M('s.sel'))})`);
  await key('a');
  check(await M(`!s.cursor && m.G.inv.slots[s.sel.i] && m.G.inv.slots[s.sel.i].id === '${first}' && m.G.inv.slots[s.sel.i].n === 64`), `${P}: A on the hotbar places the stack`);
  // B (X) takes one
  for (let i = 0; i < 6; i++) await key('up');
  check(await M("s.sel.area === 'grid' || s.sel.area === 'tab'"), `${P}: up goes back to the grid`);
  await open('creative', { tab: 1 });
  if (prof.touch) { await pad('right'); await pad('left'); }
  await key('b');
  check(await M('s.cursor && s.cursor.n === 1'), `${P}: B takes one`);
  await key('a');
  check(await M('s.cursor && s.cursor.n === 2'), `${P}: A on the same item adds one to the cursor`);
  await key('right'); await key('a');
  check(await M('!s.cursor'), `${P}: A on a different item deletes the cursor stack (the grid is the destroy slot)`);
  // the mouse or a tap: an item, then a hotbar slot
  await open('creative', { tab: 4 });
  const sword = await M('s.gridItem(2)');
  await tapW('s.gridRect(2)');
  check(await M(`s.cursor && s.cursor.id === '${sword}'`), `${P}: tapping an item puts a stack on the cursor (${sword})`);
  await shot('creative-cursor');
  await tapW('s.hotRect(3)');
  check(await M(`!s.cursor && m.G.inv.slots[3] && m.G.inv.slots[3].id === '${sword}'`), `${P}: tapping hotbar slot 4 places it`);
  // tabs by tap
  await tapW('s.tabRect(7)');
  check(await M("s.tabDef.id === 'pokemon' && s.list().includes('poke_ball')"), `${P}: the POKéMON Items tab has Poké Balls`);
  // scrolling a long tab
  await tapW('s.tabRect(0)');
  const ms = await M('s.maxScroll()');
  check(ms > 0, `${P}: Building Blocks is longer than one page`);
  if (ms > 0) {
    if (prof.touch) { for (let i = 0; i < 8; i++) await pad('down'); }
    else { const [x, y] = await at(240, 150); await page.mouse.move(x, y); await page.mouse.wheel(0, 300); await idle(2); }
    check(await M('s.scroll > 0'), `${P}: the Building Blocks tab scrolls (${await M('s.scroll')} of ${ms})`);
    await shot('creative-scrolled');
  }
  // the scroller by a tap or a click on its track, and by a finger drag, on the longest list (Search with no query)
  await open('creative', { tab: 8 });
  await idle(1);
  const ms8 = await M('s.maxScroll()'), srr = await M('s.scrollRect()');
  check(ms8 >= 10, `${P}: Search with no query is ${await M('s.rows()')} rows (${ms8} to scroll)`);
  await tap(srr.x + 6, srr.y + srr.h - 3, 2);
  check(await M(`s.scroll === ${ms8}`), `${P}: a ${prof.touch ? 'tap' : 'click'} at the bottom of the scroller's track scrolls to the end (${await M('s.scroll')} of ${ms8})`);
  await shot('creative-search-end');
  await tap(srr.x + 6, srr.y + srr.h / 2, 2);
  check(await M(`Math.abs(s.scroll - ${ms8} / 2) <= 1`), `${P}: one in the middle scrolls halfway (${await M('s.scroll')} of ${ms8})`);
  await tap(srr.x + 6, srr.y + 2, 2);
  check(await M('s.scroll === 0 && !s.cursor'), `${P}: one at the top scrolls back to the start, and no tap took an item (${await M('s.scroll')})`);
  if (prof.touch) {
    // a finger dragging the scroller from the top to the bottom (input.js sends no mouse moves for a drag)
    const cr = await M('m.canvasRect()'), X = cr.x + (srr.x + 6) * cr.w / 480, Y = (cy) => cr.y + cy * cr.h / 320;
    const cdp = await context.newCDPSession(page);
    const tp = (type, cy) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: X, y: Y(cy) }] });
    await tp('touchStart', srr.y + 4); await idle(1);
    const seen = [await M('s.scroll')];
    for (let k = 1; k <= 10; k++) { await tp('touchMove', srr.y + 4 + k * (srr.h - 8) / 10); await idle(1); seen.push(await M('s.scroll')); }
    await tp('touchEnd'); await idle(2);
    check(seen[seen.length - 1] === ms8 && new Set(seen).size >= 8 && seen.every((v, i) => i === 0 || v >= seen[i - 1]) && (await M('!s.cursor')),
      `${P}: a finger drag down the scroller moves the list with it to the end (${seen.join(' ')}) and takes no item`);
    await cdp.detach();
  }
  // search: the page-level text box filters as you type
  await tapW('s.tabRect(8)');
  check(await M("s.tabDef.id === 'search'"), `${P}: the Search tab opens`);
  await tapW('s.searchRect()', prof.touch ? 0 : 2);
  e = await M('m.entry()');
  if (prof.touch) check(e && e.open && e.focused, `${P}: tapping the search field opens its box inside the touchend, 0 frames after it`);
  await idle(prof.touch ? 2 : 0);
  check(e && e.open && e.label === 'Search' && e.attrs.autocapitalize === 'off', `${P}: the search field opens the text box`);
  const panelTop = await M('(() => { const c = m.canvasRect(); return c.y + (s.y0 - 28) * c.h / 320; })()');
  check(e && e.rect.y + e.rect.h <= panelTop + 1, `${P}: the search box sits above the creative tabs, so the results stay visible (box bottom ${e && Math.round(e.rect.y + e.rect.h)}, tabs top ${Math.round(panelTop)})`);
  await page.keyboard.type('pick');
  await idle(1);
  const found = await M('s.list()');
  check(found.length === 6 && found.every((id) => id.endsWith('_pickaxe')), `${P}: "pick" finds the 6 pickaxes (${found.join(', ')})`);
  await pageShot('creative-search-entry');
  if (prof.touch) await page.tap('#rs-text-entry button[type=submit]'); else await page.keyboard.press('Enter');
  await idle(2);
  await shot('creative-search');
  // the survival inventory: a slot, the destroy slot
  await open('creative', { tab: 9, slots: { 9: { id: 'cobblestone', n: 30 } } });
  const invIdx = await M("s.invSlots().findIndex((x) => x.idx === 9)");
  await tapW(`(() => { const x = s.invSlots()[${invIdx}]; return { x: s.x0 + x.x, y: s.y0 + x.y, w: 16, h: 16 }; })()`);
  check(await M("s.cursor && s.cursor.id === 'cobblestone' && s.cursor.n === 30 && !m.G.inv.slots[9]"), `${P}: the survival tab picks up a stack`);
  await tapW("(() => { const x = s.invSlots().find((q) => q.kind === 'destroy'); return { x: s.x0 + x.x, y: s.y0 + x.y, w: 16, h: 16 }; })()");
  check(await M('!s.cursor'), `${P}: the destroy slot deletes it`);
  await shot('creative-inventory-after');
  // number key (desktop): over a grid item, 5 fills hotbar slot 5
  if (!prof.touch) {
    await open('creative', { tab: 2 });
    const [x, y] = await at(...(await M('[s.gridRect(1).x + 8, s.gridRect(1).y + 8]')));
    await page.mouse.move(x, y); await idle(1);
    await page.keyboard.press('5'); await idle(1);
    check(await M('m.G.inv.slots[4] && m.G.inv.slots[4].id === s.gridItem(1) && m.G.inv.slots[4].n === s.G.inv.slots[4].n'), `${P}: 5 over an item fills hotbar slot 5`);
    await shot('creative-hover');
  }
  // closing returns the cursor stack to the inventory
  await open('creative', { tab: 0 });
  await tapW('s.gridRect(0)');
  if (prof.touch) await pad('inv'); else await key('inv');
  check(await M('s.done'), `${P}: E (INV) closes the creative inventory`);
  await page.evaluate(() => window.__menus.screen().close());
  check(await M('!s.cursor && m.G.inv.count(s.gridItem(0)) === 64'), `${P}: closing puts the cursor stack in the inventory`);

  // ----------------------------------------------------------------- never throws: random input on every screen
  // Sessions on the screens in turn: each runs until the screen is done (then the next opens at once) or 300 frames, and a
  // text box that opens is answered with random text and OK or Cancel. Every count below is of frames actually ticked.
  const fz = await page.evaluate(([cont, worlds, seed, total]) => {
    const m = window.__menus;
    const ks = ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'prev', 'next', 'slot3', 'inv', 'esc', 'mouseL', 'mouseR'];
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const opens = [['flow', { cont, bootedId: 'w1' }], ['flow', { cont, start: 'select' }], ['flow', { cont, start: 'create' }], ['create', {}], ['select', {}],
      ['death', { cause: 'x' }], ['creative', { tab: 0 }], ['creative', { tab: 8 }], ['creative', { tab: 9 }], ['loading', {}]];
    const st = { frames: 0, sessions: 0, boxes: 0, byScreen: {}, results: {} };
    let left = 0, name = '';
    while (st.frames < total) {
      const sc = m.screen();
      if (!left || !sc || sc.done) {
        if (sc && sc.done) { const op = (sc.result || {}).op || (sc.kind === 'creative' ? 'closed' : '?'); st.results[op] = (st.results[op] || 0) + 1; }
        // the screen with the fewest frames so far opens next (a random one among ties), so every screen gets its share
        const key = ([n, o]) => n + (o.start ? '/' + o.start : o.tab != null ? '/' + o.tab : '');
        const least = Math.min(...opens.map((x) => st.byScreen[key(x)] || 0));
        const pool = opens.filter((x) => (st.byScreen[key(x)] || 0) === least);
        const [n, o] = pool[Math.floor(rnd() * pool.length)];
        m.open(n, { ...o, worlds: worlds.map((w) => ({ ...w })) });
        name = key([n, o]); left = 300; st.sessions++;
      }
      const box = document.getElementById('rs-text-entry');
      if (box) {
        st.boxes++;
        const inp = box.querySelector('input');
        inp.value = rnd() < 0.5 ? 'Seed ' + Math.floor(rnd() * 1e6) : '';
        inp.dispatchEvent(new Event('input'));
        (rnd() < 0.5 ? box.querySelector('button.cancel') : box.querySelector('button[type=submit]')).click();
      }
      const k = ks[Math.floor(rnd() * ks.length)], mouse = { x: Math.floor(rnd() * 480), y: Math.floor(rnd() * 320) };
      m.tick(k.startsWith('mouse') ? { mouse: { ...mouse, click: k } } : { press: k, mouse });
      st.frames++; left--; st.byScreen[name] = (st.byScreen[name] || 0) + 1;
    }
    return st;
  }, [cont, worldsSample, P === 'desktop' ? 7 : 11, 4000]);
  log(`${P} fuzz: ${JSON.stringify(fz)}`);
  const frames = fz.frames;
  check(Object.keys(fz.byScreen).length >= 10 && fz.boxes > 0 && Object.values(fz.byScreen).every((n) => n >= 100), `${P}: the fuzz reached all ${Object.keys(fz.byScreen).length} screens (fewest frames on one: ${Math.min(...Object.values(fz.byScreen))}) and answered ${fz.boxes} text boxes over ${fz.sessions} sessions`);
  const errs = await M('m.errors.slice()');
  check(errs.length === 0 && errors.length === 0, `${P}: ${frames} frames (counted as ticked) of random keys, clicks and taps on every screen: no error (${errs.concat(errors).slice(0, 3).join(' | ')})`);
  check((await M('m.missing.length')) === 0, `${P}: every menu texture loaded`);
  await context.close();
  return { req, seed };
}
