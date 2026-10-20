// Touch / mobile test: drives the game in an emulated phone (real multi-touch through the DevTools protocol)
// and checks the layouts, every on-screen control, tap-to-target, the soft aim and that desktop is untouched.
//   node scripts/test-touch.mjs            (SHOTS=0 skips screenshots, DEBUG=1 prints raw numbers)
// Screenshots go to out/test/touch-*.png.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'out', 'test');
mkdirSync(OUT, { recursive: true });
const SHOTS = process.env.SHOTS !== '0';
const DEBUG = !!process.env.DEBUG;

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const t of [() => req('playwright'), () => createRequire('/opt/node-tools/node_modules/')('playwright')]) {
    try { return t(); } catch { /* try next */ }
  }
  console.error('Could not load playwright. Install it with: npm i -D playwright');
  process.exit(2);
}
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
});

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const dump = (label, obj) => { if (DEBUG) console.log(`      ${label}: ${JSON.stringify(obj)}`); };

const port = await freePort();
const server = spawn('python3', [path.join(root, 'serve.py'), String(port)], { stdio: 'ignore' });
const { chromium } = loadPlaywright();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const URL = `http://localhost:${port}/`;
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const problems = [];
const watch = (page) => {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.stack || e.message}`));
};
// deterministic pointer lock, as in the main suite (and a counter so we can prove touch never asks for it)
const lockStub = () => {
  window.__lockRequests = 0;
  window.__fakeLock = null;
  HTMLCanvasElement.prototype.requestPointerLock = function requestPointerLock() {
    window.__lockRequests++;
    window.__fakeLock = this;
    document.dispatchEvent(new Event('pointerlockchange'));
  };
  Object.defineProperty(document, 'pointerLockElement', { get: () => window.__fakeLock, configurable: true });
  document.exitPointerLock = () => {
    if (!window.__fakeLock) return;
    window.__fakeLock = null;
    document.dispatchEvent(new Event('pointerlockchange'));
  };
};

async function openPage(opts = {}, url = URL) {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: PHONE_UA, ...opts,
  });
  const page = await context.newPage();
  watch(page);
  await page.addInitScript(lockStub);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game);
  await page.waitForTimeout(800);
  return { context, page };
}

// real multi-touch: several fingers down at once, each moving independently
function fingers(cdp) {
  const pts = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...pts].map(([id, p]) => ({ id, x: p.x, y: p.y })) });
  return {
    async down(id, x, y) { pts.set(id, { x, y }); await send('touchStart'); },
    async move(id, x, y) { pts.set(id, { x, y }); await send('touchMove'); },
    async up(id) { pts.delete(id); await send('touchEnd'); },
  };
}

const W = 844, H = 390;
const inside = (r, w, h) => r.x >= -0.5 && r.y >= -0.5 && r.r <= w + 0.5 && r.b <= h + 0.5;
const overlap = (a, b) => a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1;

try {
  const { context, page } = await openPage();
  const cdp = await context.newCDPSession(page);
  const touch = fingers(cdp);
  const rect = (sel) => page.$eval(sel, (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom, shown: r.width > 0 && getComputedStyle(e).display !== 'none' };
  });
  const centre = async (sel) => { const r = await rect(sel); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
  // a real finger scrolls a list item into view before pressing it
  const tap = async (sel) => {
    await page.locator(sel).first().scrollIntoViewIfNeeded();
    const c = await centre(sel);
    await page.touchscreen.tap(c.x, c.y);
  };
  const G = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (name) => {
    if (!SHOTS) return;
    await G(() => window.__game.render());
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `touch-${name}.png`) });
  };

  // ------------------------------------------------------------ 1. boot and detection
  const boot = await G(() => ({
    touchClass: document.documentElement.classList.contains('touch'),
    active: window.__game.touch.active,
    layer: document.getElementById('touch').classList.contains('hidden'),
    shadows: window.__game.renderer.shadowMap.enabled,
    ratio: window.__game.renderer.getPixelRatio(),
    assist: window.__game.settings.aimAssist,
  }));
  check('a phone is detected: the page gets the touch class', boot.touchClass && boot.active, JSON.stringify(boot));
  check('the controls stay hidden on the title screen', boot.layer);
  check('phones default to no shadows and 75% resolution', !boot.shadows && Math.abs(boot.ratio - 0.75) < 1e-6, JSON.stringify({ shadows: boot.shadows, ratio: boot.ratio }));
  const title = await G(() => ({
    kbd: getComputedStyle(document.querySelector('.controls')).display,
    tips: getComputedStyle(document.querySelector('.controls-touch')).display,
    block: (({ bottom, right }) => ({ bottom, right }))(document.querySelector('.title-block').getBoundingClientRect()),
    scroll: [document.getElementById('screen-title').scrollHeight, document.getElementById('screen-title').clientHeight],
  }));
  check('the title shows touch tips instead of the keyboard list', title.kbd === 'none' && title.tips !== 'none');
  check('the title fits a landscape phone without scrolling', title.block.bottom <= H && title.scroll[0] <= title.scroll[1], JSON.stringify(title));
  await shot('01-title');

  // ------------------------------------------------------------ 2. garage on a phone
  await tap('#btn-garage');
  await page.waitForFunction(() => window.__game.state === 'garage');
  await page.waitForTimeout(400);
  const gar = {
    left: await rect('.g-left'), right: await rect('.g-right'), opts: await rect('#g-options'), tabs: await rect('#g-tabs'),
    go: await rect('#g-go'), back: await rect('#g-back'), random: await rect('#g-random'), reset: await rect('#g-reset'),
    toggle: await rect('#g-stats-toggle'),
  };
  dump('garage 844x390', gar);
  check('garage: both panels fit side by side with room for the mech', gar.right.shown && gar.left.r < gar.right.x - 150 && inside(gar.left, W, H) && inside(gar.right, W, H));
  check('garage: the parts list has room to scroll through', gar.opts.h >= 120, `${Math.round(gar.opts.h)}px`);
  check('garage: the action buttons are on screen and do not overlap', [gar.go, gar.back, gar.random, gar.reset].every((r) => inside(r, W, H) && r.h >= 32)
    && !overlap(gar.go, gar.reset) && !overlap(gar.random, gar.reset) && !overlap(gar.back, gar.random));
  check('garage: the STATS toggle is not needed at this width', !gar.toggle.shown);
  const tabScroll = await G(() => { const t = document.getElementById('g-tabs'); return { scrolls: t.scrollWidth > t.clientWidth, h: t.getBoundingClientRect().height }; });
  check('garage: the 13 tabs form one scrollable row', tabScroll.scrolls && tabScroll.h < 60, JSON.stringify(tabScroll));
  await shot('02-garage');

  // tapping equips; the stats and the mech follow
  await tap('.g-tab[data-tab="torso"]');
  await tap('.opt[data-id="heavy"]');
  const eq = await G(() => ({ torso: window.__game.player.build.torso, selected: document.querySelector('.opt.selected')?.dataset.id }));
  check('garage: tapping a part equips it', eq.torso === 'heavy' && eq.selected === 'heavy', JSON.stringify(eq));
  await tap('.g-tab[data-tab="tuning"]');
  const plus = await rect('.tune-btn[data-dir="1"]');
  check('garage: tuning buttons are big enough to tap', plus.w >= 36 && plus.h >= 36, `${Math.round(plus.w)}x${Math.round(plus.h)}`);
  await tap('.tune-btn[data-dial="plating"][data-dir="1"]');
  check('garage: tapping + spends a tuning point', (await G(() => Object.values(window.__game.player.build.tuning ?? {}).reduce((a, b) => a + b, 0))) >= 1);

  // one finger turns the turntable, two fingers zoom it
  const cam0 = await G(() => ({ ...window.__game.garageCam }));
  await touch.down(1, 420, 200);
  for (let i = 1; i <= 6; i++) await touch.move(1, 420 + i * 12, 200);
  await touch.up(1);
  const cam1 = await G(() => ({ ...window.__game.garageCam }));
  check('garage: dragging a finger rotates the mech', Math.abs(cam1.yaw - cam0.yaw) > 0.3 && !cam1.dragging, `${(cam1.yaw - cam0.yaw).toFixed(2)} rad`);
  await touch.down(1, 400, 200);
  await touch.down(2, 440, 200);
  for (let i = 1; i <= 6; i++) { await touch.move(1, 400 - i * 12, 200); await touch.move(2, 440 + i * 12, 200); }
  await touch.up(2);
  await touch.up(1);
  const cam2 = await G(() => ({ ...window.__game.garageCam }));
  check('garage: spreading two fingers zooms in', cam2.dist < cam1.dist - 5 && !cam2.dragging, `${cam1.dist.toFixed(1)} -> ${cam2.dist.toFixed(1)}`);
  await touch.down(1, 380, 200);
  await touch.down(2, 480, 200);
  for (let i = 1; i <= 6; i++) { await touch.move(1, 380 + i * 10, 200); await touch.move(2, 480 - i * 10, 200); }
  await touch.up(2);
  await touch.up(1);
  const cam3 = await G(() => ({ ...window.__game.garageCam }));
  check('garage: pinching two fingers together zooms out', cam3.dist > cam2.dist + 5, `${cam2.dist.toFixed(1)} -> ${cam3.dist.toFixed(1)}`);

  // narrower screens: one panel at a time with a STATS / PARTS switch
  await page.setViewportSize({ width: 667, height: 375 });
  await page.waitForTimeout(300);
  const narrow = { right: await rect('.g-right'), left: await rect('.g-left'), toggle: await rect('#g-stats-toggle'), go: await rect('#g-go'), back: await rect('#g-back'), reset: await rect('#g-reset'), random: await rect('#g-random') };
  check('garage at 667 wide: parts panel only, with a STATS button', !narrow.right.shown && narrow.left.shown && narrow.toggle.shown);
  check('garage at 667 wide: the five action buttons fit', [narrow.go, narrow.toggle, narrow.back, narrow.random, narrow.reset].every((r) => inside(r, 667, 375)) && !overlap(narrow.go, narrow.reset) && !overlap(narrow.toggle, narrow.back) && !overlap(narrow.toggle, narrow.random));
  await tap('#g-stats-toggle');
  const swapped = { right: await rect('.g-right'), left: await rect('.g-left'), label: await page.textContent('#g-stats-toggle') };
  check('garage: STATS swaps in the stat bars and the button becomes PARTS', swapped.right.shown && !swapped.left.shown && swapped.label === 'PARTS' && inside(swapped.right, 667, 375));
  await shot('03-garage-stats-667');
  await tap('#g-stats-toggle');
  check('garage: PARTS swaps back', (await rect('.g-left')).shown && !(await rect('.g-right')).shown);
  await page.setViewportSize({ width: W, height: H });
  await page.waitForTimeout(200);

  // ------------------------------------------------------------ 3. sortie: layout of the controls and the HUD
  await tap('#g-go');
  await page.waitForFunction(() => window.__game.state === 'playing');
  await page.waitForFunction(() => !document.getElementById('touch').classList.contains('hidden'));
  await G(() => {
    const g = window.__game;
    g.setBuild({ ...window.__garage.build, torso: 'std', tuning: {} }); // a plain loadout for the controls tests
    g.startMission();
    g.manual = true;
    g.missions.state = 'idle';
    for (const e of g.enemies) e.mech.destroy();
    g.enemies.length = 0;
    g.projectiles.clear();
    g.cheat.invincible = true;
    g.hud.reset();
    g.step(5);
  });
  await page.waitForTimeout(250);
  const lay = await G(() => {
    const vis = (e) => e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
    const out = { locks: window.__lockRequests, weapons: vis(document.getElementById('weapons')), gone: {}, scale: getComputedStyle(document.documentElement).getPropertyValue('--tc').trim() };
    for (const id of ['fire', 'saber', 'missile', 'dash', 'boost', 'burst', 'cannon', 'sub', 'lock', 'switch', 'reload']) out.gone[id] = !vis(document.getElementById(`tc-${id}`));
    out.radar = window.__game.hud.radarGeom();
    return out;
  });
  dump('sortie layout', lay);
  check('the sortie never asks for pointer lock on touch', lay.locks === 0, `${lay.locks} requests`);
  check('the keyboard weapon panel is hidden (state lives on the buttons)', !lay.weapons);
  check('stock loadout shows fire, saber, missile, dash, boost, lock, switch, reload', ['fire', 'saber', 'missile', 'dash', 'boost', 'lock', 'switch', 'reload'].every((id) => !lay.gone[id]), JSON.stringify(lay.gone));
  check('cannon, sub-weapon and burst buttons stay away until they matter', lay.gone.cannon && lay.gone.sub && lay.gone.burst);
  const shown = [];
  for (const id of ['fire', 'saber', 'missile', 'dash', 'boost', 'lock', 'switch', 'reload']) shown.push({ id, ...(await rect(`#tc-${id}`)) });
  check('every control is on screen', shown.every((r) => inside(r, W, H)), JSON.stringify(shown.filter((r) => !inside(r, W, H)).map((r) => r.id)));
  const big = shown.filter((r) => ['fire', 'saber', 'missile', 'dash', 'boost'].includes(r.id));
  check('the main buttons are at least 56px (a thumb)', big.every((r) => r.w >= 56 && r.h >= 56), big.map((r) => `${r.id}:${Math.round(r.w)}`).join(' '));
  const smalls = shown.filter((r) => ['lock', 'switch', 'reload'].includes(r.id));
  check('the utility buttons are at least 40px', smalls.every((r) => r.w >= 40 && r.h >= 40), smalls.map((r) => `${r.id}:${Math.round(r.w)}`).join(' '));
  let clash = [];
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i], b = shown[j];
      const d = Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
      if (d < (a.w + b.w) / 2 - 1) clash.push(`${a.id}/${b.id}`);
    }
  }
  check('no two buttons overlap', clash.length === 0, clash.join(' '));
  const radarBox = { x: lay.radar.cx - lay.radar.R, y: lay.radar.cy - lay.radar.R, r: lay.radar.cx + lay.radar.R, b: lay.radar.cy + lay.radar.R };
  const pause = await rect('#tc-pause');
  check('the radar is smaller on a phone, and the pause button and utility row stay clear of it',
    lay.radar.R < 60 && inside(radarBox, W, H) && !overlap(radarBox, pause) && smalls.every((r) => !overlap(radarBox, r)) && inside(pause, W, H),
    `R=${lay.radar.R}`);
  const mission = await rect('#mission'), status = await rect('#status');
  const cluster = shown.reduce((m, r) => Math.min(m, r.x), W);
  check('the HUD panels are compact, on screen and clear of each other and of the buttons',
    inside(mission, W, H) && inside(status, W, H) && !overlap(mission, status) && status.r < cluster && status.b < H * 0.5, JSON.stringify({ mission: Math.round(mission.b), status: Math.round(status.b) }));
  await shot('04-sortie');

  // ------------------------------------------------------------ 4. the move stick
  const mechPos = () => G(() => { const m = window.__game.player.mech.pos; return { x: m.x, y: m.y, z: m.z }; });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  await G(() => { const g = window.__game; g.player.reset(0, 0); g.step(30); });
  const start = await mechPos();
  await touch.down(1, 150, 300);
  await touch.move(1, 150, 232);
  const a1 = await G(() => ({ ...window.__game.input.axis, base: document.getElementById('tc-base').classList.contains('on') }));
  check('putting a thumb down on the left draws a stick that follows it', a1.base && a1.y > 0.9 && Math.abs(a1.x) < 0.1, JSON.stringify(a1));
  await G(() => window.__game.step(60));
  const afterFull = await mechPos();
  const full = dist(start, afterFull);
  const dir = await G(() => { const y = window.__game.rig.yaw; return { x: -Math.sin(y), z: -Math.cos(y) }; });
  const along = ((afterFull.x - start.x) * dir.x + (afterFull.z - start.z) * dir.z) / (full || 1);
  check('pushing the stick up walks the mech forward, relative to the camera', full > 20 && along > 0.95, `${full.toFixed(1)} units, ${along.toFixed(2)} along the camera`);
  await touch.move(1, 150, 271); // about half deflection
  const half = await G(() => window.__game.input.axis.y);
  const p0 = await mechPos();
  await G(() => window.__game.step(60));
  const halfDist = dist(p0, await mechPos());
  check('a half push walks slower: movement is analog', half > 0.25 && half < 0.6 && halfDist < full * 0.75, `axis ${half.toFixed(2)}, ${halfDist.toFixed(1)} vs ${full.toFixed(1)}`);
  await touch.move(1, 150 + 2, 300 - 3); // inside the dead zone
  const dz = await G(() => Math.hypot(window.__game.input.axis.x, window.__game.input.axis.y));
  check('the dead zone ignores tiny thumb movements', dz === 0, `${dz}`);
  await touch.move(1, 90, 300);
  const left = await G(() => window.__game.input.axis);
  check('pushing left strafes left', left.x < -0.9 && Math.abs(left.y) < 0.1, JSON.stringify(left));
  await touch.up(1);
  const released = await G(() => ({ ...window.__game.input.axis, base: document.getElementById('tc-base').classList.contains('on') }));
  check('letting go stops the mech and hides the stick', released.x === 0 && released.y === 0 && !released.base);
  await touch.down(1, 150, 300);
  await touch.move(1, 150, 232);
  const stolen = await G(() => {
    const t = window.__game.touch;
    document.getElementById('tc-zone').dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: t._stick.id })); // the system took the finger away
    return { y: window.__game.input.axis.y, stick: !!t._stick, base: document.getElementById('tc-base').classList.contains('on') };
  });
  check('a finger the system takes away does not leave the stick stuck on', stolen.y === 0 && !stolen.stick && !stolen.base, JSON.stringify(stolen));
  await touch.up(1);

  // ------------------------------------------------------------ 5. look
  await G(() => { const g = window.__game; g.player.reset(0, 0); g.player.lock = null; g.player.lockEnabled = false; g.step(10); });
  const yaw0 = await G(() => window.__game.rig.yaw);
  await touch.down(2, 600, 200);
  for (let i = 1; i <= 5; i++) await touch.move(2, 600 + i * 20, 200 - i * 6);
  await touch.up(2);
  await G(() => window.__game.step(2));
  const look = await G(() => ({ yaw: window.__game.rig.yaw, axis: window.__game.input.axis, pitch: window.__game.rig.pitch }));
  check('dragging on the right side turns the camera (right drag turns right)', look.yaw - yaw0 < -0.25 && look.yaw - yaw0 > -0.6, `${(look.yaw - yaw0).toFixed(2)} rad`);
  check('dragging up raises the camera pitch', look.pitch > -0.05 + 0.03, look.pitch.toFixed(3));
  check('looking does not move the mech', look.axis.x === 0 && look.axis.y === 0);

  // ------------------------------------------------------------ 6. action buttons
  const st = () => G(() => {
    const g = window.__game, p = g.player;
    return { ammo: p.ammo, mag: p.magSize, reload: p.reloadT, missiles: p.missiles, melee: !!p.melee, dash: p.mech.dashT, en: p.mech.en, y: p.mech.pos.y, space: g.input.down('Space'), keys: [...g.input.keys] };
  });
  await G(() => { const p = window.__game.player; p.reset(0, 0); p.lockEnabled = false; window.__game.step(5); });
  const s0 = await st();
  const fire = await centre('#tc-fire');
  await touch.down(3, fire.x, fire.y);
  await touch.up(3); // the briefest tap
  await G(() => window.__game.step(4));
  const tapShot = await st();
  check('even the quickest tap on FIRE fires a shot', tapShot.ammo < s0.ammo, `${s0.ammo} -> ${tapShot.ammo}`);
  await page.waitForTimeout(150);
  check('FIRE lets go of its key when the finger lifts', !(await st()).keys.includes('Mouse0'));
  await touch.down(3, fire.x, fire.y);
  await G(() => window.__game.step(70));
  const held = await st();
  await touch.up(3);
  check('holding FIRE keeps shooting and empties the magazine into a reload', held.ammo < tapShot.ammo - 1 || held.reload > 0, `${tapShot.ammo} -> ${held.ammo}, reload ${held.reload.toFixed(2)}`);
  await G(() => { const p = window.__game.player; p.ammo = 3; p.reloadT = 0; window.__game.step(2); });
  await page.waitForTimeout(100);
  const fireLabel = await page.textContent('#tc-fire i');
  check('the FIRE button shows the ammo left', fireLabel === '3', fireLabel);
  await tap('#tc-reload');
  await G(() => window.__game.step(3));
  check('RELOAD starts a reload', (await st()).reload > 0);
  await G(() => { const p = window.__game.player; p.reloadT = 0; p.ammo = p.magSize; p.missiles = p.stats.missileCharges; p.fireCd = 0; window.__game.step(70); });

  const m0 = (await st()).missiles;
  await tap('#tc-missile');
  await G(() => window.__game.step(3));
  const m1 = (await st()).missiles;
  await page.waitForTimeout(150);
  check('MISSILE launches a salvo and uses a charge', m1 === m0 - 1, `${m0} -> ${m1}`);
  check('the MISSILE button shows charges and a recharge fill', /^\d\/\d$/.test(await page.textContent('#tc-missile i')) && (await page.$eval('#tc-missile', (e) => e.style.getPropertyValue('--fill'))) !== '');

  await G(() => { const p = window.__game.player; p.mech.en = p.mech.maxEn; p.mech.dashCd = 0; p.mech.overheat = false; });
  const e0 = (await st()).en;
  await tap('#tc-dash');
  await G(() => window.__game.step(3));
  const d1 = await st();
  check('DASH quick-boosts and spends boost fuel', d1.dash > 0 && d1.en < e0, `dashT ${d1.dash.toFixed(2)}, en ${e0} -> ${d1.en.toFixed(0)}`);
  await G(() => window.__game.step(40));

  // boost: a tap latches it on, another tap lets go; a long press is hold-to-boost
  await G(() => { const p = window.__game.player; p.reset(0, 0); p.lockEnabled = false; window.__game.step(30); });
  const yb = (await st()).y;
  await tap('#tc-boost');
  await page.waitForTimeout(150);
  const latched = await st();
  await G(() => window.__game.step(40));
  const risen = await st();
  check('tapping BOOST latches it on: the mech keeps climbing with the finger off', latched.space && risen.y > yb + 8, `y ${yb.toFixed(1)} -> ${risen.y.toFixed(1)}`);
  check('the BOOST button shows it is latched', await page.$eval('#tc-boost', (e) => e.classList.contains('on')));
  await tap('#tc-boost');
  await page.waitForTimeout(150);
  check('a second tap turns boost off', !(await st()).space && !(await page.$eval('#tc-boost', (e) => e.classList.contains('on'))));
  const bc = await centre('#tc-boost');
  await touch.down(3, bc.x, bc.y);
  await page.waitForTimeout(420);
  const holdOn = (await st()).space;
  await touch.up(3);
  await G(() => window.__game.step(2)); // (the simulation is stepped by hand here; a release waits for a step to see the press)
  check('a long press is hold-to-boost: releasing ends it', holdOn && !(await st()).space);
  await G(() => { const p = window.__game.player; p.reset(0, 0); window.__game.step(60); });

  await tap('#tc-saber');
  await G(() => window.__game.step(3));
  check('SABER starts the beam saber swing', (await st()).melee);
  await G(() => { const p = window.__game.player; p.reset(0, 0); window.__game.step(5); });

  // two thumbs at once: walk and shoot together
  const fire2 = await centre('#tc-fire');
  await G(() => { const p = window.__game.player; p.reset(0, 0); p.lockEnabled = false; window.__game.step(30); });
  const w0 = await mechPos();
  const ammoBefore = (await st()).ammo;
  await touch.down(1, 150, 300);
  await touch.move(1, 150, 232);
  await touch.down(3, fire2.x, fire2.y);
  await G(() => window.__game.step(45));
  const both = await G(() => ({ axis: window.__game.input.axis.y, mouse: window.__game.input.down('Mouse0') }));
  const wDist = dist(w0, await mechPos());
  const ammoAfter = (await st()).ammo;
  await touch.up(3);
  await touch.up(1);
  check('stick and FIRE work together (two thumbs)', both.axis > 0.9 && both.mouse && wDist > 15 && ammoAfter < ammoBefore, `moved ${wDist.toFixed(1)}, ammo ${ammoBefore} -> ${ammoAfter}`);
  await page.waitForTimeout(150);
  check('lifting every finger leaves no key stuck down', (await st()).keys.length === 0, JSON.stringify((await st()).keys));

  // ------------------------------------------------------------ 7. lock-on: tap to target, buttons, auto
  const spawn = (type, dx, dz, freeze = true) => G(async ({ type, dx, dz, freeze }) => {
    const g = window.__game, m = g.player.mech;
    const { createEnemy } = await import('/src/ai.js');
    const e = createEnemy(g, type, 1);
    e.mech.place(m.pos.x + dx, m.pos.z + dz, 0, 0);
    if (freeze) e.update = () => {};
    g.enemies.push(e);
    return g.enemies.length - 1;
  }, { type, dx, dz, freeze });
  const clearAll = () => G(() => { const g = window.__game; for (const e of g.enemies) e.mech.destroy(); g.enemies.length = 0; g.projectiles.clear(); });
  const screenOf = (i) => G((i) => {
    const g = window.__game;
    g.render();
    const s = g.hud.toScreen(g.enemies[i].mech.center(new g.camera.position.constructor()), { x: 0, y: 0, visible: false, dist: 0 });
    return { x: s.x, y: s.y, visible: s.visible };
  }, i);
  const lockedIs = (i) => G((i) => window.__game.player.lock === window.__game.enemies[i].mech, i);

  await clearAll();
  await G(() => { const g = window.__game, p = g.player; p.reset(0, 0); g.rig.reset(0); p.lock = null; p.lockEnabled = false; g.step(20); });
  const ia = await spawn('drone', 0, -120);
  const ib = await spawn('drone', 40, -150);
  await G(() => window.__game.step(10));
  const sa = await screenOf(ia), sb = await screenOf(ib);
  await page.touchscreen.tap(sa.x, sa.y);
  check('tapping an enemy locks onto it', await lockedIs(ia));
  await page.touchscreen.tap(sb.x, sb.y);
  check('tapping a different enemy switches the lock', await lockedIs(ib));
  await tap('#tc-switch');
  await G(() => window.__game.step(2));
  check('SWITCH cycles to the other target', await lockedIs(ia));
  check('the LOCK button lights up while locked', await page.$eval('#tc-lock', (e) => e.classList.contains('on')));
  await tap('#tc-lock');
  await G(() => window.__game.step(2));
  const off = await G(() => ({ lock: !!window.__game.player.lock, en: window.__game.player.lockEnabled }));
  check('LOCK turns the lock-on off', !off.lock && !off.en);
  await tap('#tc-lock');
  await G(() => window.__game.step(2));
  check('LOCK turns it back on and picks a target', (await G(() => !!window.__game.player.lock)));
  await G(() => { const p = window.__game.player; p.lock = null; p.lockEnabled = false; window.__game.step(2); });
  await page.touchscreen.tap(W / 2 + 200, 60); // empty sky
  check('tapping empty space does not lock onto anything', !(await G(() => !!window.__game.player.lock)));
  await G(() => { window.__game.player.lockEnabled = true; window.__game.step(3); });
  check('auto lock-on acquires a target by itself', await G(() => !!window.__game.player.lock));
  await shot('05-locked');

  // ------------------------------------------------------------ 8. soft aim
  await clearAll();
  const aim = await G(async () => {
    const g = window.__game, p = g.player, m = p.mech, THREE = await import('/vendor/three/three.module.min.js');
    const { createEnemy } = await import('/src/ai.js');
    const out = {};
    p.reset(0, 0); p.lock = null; p.lockEnabled = false; g.rig.reset(0); g.step(20);
    const cam = g.camera.position, f = g.rig.forward;
    // an enemy 200 units out, about 6 degrees to the right of the crosshair
    const spawnOff = (deg, dist) => {
      for (const e of g.enemies) e.mech.destroy();
      g.enemies.length = 0;
      const e = createEnemy(g, 'drone', 1);
      const ang = Math.atan2(f.x, f.z) - deg * Math.PI / 180; // rotate about Y
      e.mech.place(cam.x + Math.sin(ang) * dist, cam.z + Math.cos(ang) * dist, 0, 0);
      e.update = () => {};
      g.enemies.push(e);
      return e;
    };
    const angleTo = (e, dir, from) => {
      const c = e.mech.center(new THREE.Vector3()).sub(from).normalize();
      return Math.acos(Math.min(1, c.dot(dir))) * 180 / Math.PI;
    };
    const probe = (deg, dist = 200) => {
      const e = spawnOff(deg, dist);
      g.step(1);
      p._updateAimPoint();
      const from = new THREE.Vector3();
      m.model.muzzleWorld(from);
      const dir = p._aimDir(from, p.weapon.speed, new THREE.Vector3());
      const ray = p.aimPoint.clone().sub(from).normalize(); // where the shot would go without the assist
      return { target: p.assistTarget === e.mech, towards: angleTo(e, dir, from), ray: angleTo(e, ray, from) };
    };
    g.settings.aimAssist = true;
    out.near = probe(6);
    out.centre = probe(0);
    out.far = probe(25);
    out.tooClose = probe(6, 15);
    g.settings.aimAssist = false;
    out.off = probe(6);
    g.settings.aimAssist = true;
    // the whole thing for real: fire one shot and see whether it connects
    const shoot = (assist) => {
      g.settings.aimAssist = assist;
      p.reset(0, 0); p.lock = null; p.lockEnabled = false; g.rig.reset(0); g.step(20);
      const e = spawnOff(6, 200);
      const hp0 = e.mech.hp;
      g.step(1);
      g.input.keyDown('Mouse0');
      g.step(3);
      g.input.keyUp('Mouse0');
      g.step(100);
      return hp0 - e.mech.hp;
    };
    out.hitWith = shoot(true);
    out.hitWithout = shoot(false);
    g.settings.aimAssist = true;
    return out;
  });
  dump('aim', aim);
  check('soft aim picks the enemy near the crosshair', aim.near.target && aim.centre.target, JSON.stringify(aim.near));
  check('soft aim pulls the shot toward the enemy', aim.near.towards < aim.near.ray * 0.3 && aim.near.towards < 3.5, `${aim.near.ray.toFixed(1)}° off -> ${aim.near.towards.toFixed(1)}°`);
  check('soft aim ignores enemies far from the crosshair', !aim.far.target && Math.abs(aim.far.towards - aim.far.ray) < 0.01);
  check('soft aim ignores enemies too close to aim at', !aim.tooClose.target);
  check('with the option off, shots go where the camera points', !aim.off.target && Math.abs(aim.off.towards - aim.off.ray) < 0.01);
  check('a shot that would miss lands with the assist and misses without', aim.hitWith > 0 && aim.hitWithout === 0, `damage ${aim.hitWith} vs ${aim.hitWithout}`);

  // ------------------------------------------------------------ 9. pause, options, orientation
  await clearAll();
  await G(() => { const p = window.__game.player; p.reset(0, 0); p.lockEnabled = false; window.__game.step(5); });
  const f3 = await centre('#tc-fire');
  await touch.down(3, f3.x, f3.y); // a finger still on FIRE when the game pauses
  await tap('#tc-pause');
  await page.waitForFunction(() => window.__game.state === 'paused');
  await touch.up(3);
  const pz = await G(() => ({ keys: [...window.__game.input.keys], layer: document.getElementById('touch').classList.contains('hidden'),
    assist: getComputedStyle(document.getElementById('opt-assist').parentElement).display, size: getComputedStyle(document.getElementById('opt-tscale').parentElement).display }));
  check('the pause button pauses; nothing stays held and the controls hide', pz.keys.length === 0 && pz.layer, JSON.stringify(pz));
  check('the pause menu offers aim assist and control size on touch', pz.assist !== 'none' && pz.size !== 'none');
  const dlg = await rect('#screen-pause .dialog');
  const dlgScroll = await G(() => { const d = document.querySelector('#screen-pause .dialog'); return [d.scrollHeight, d.clientHeight]; });
  check('the pause menu fits a landscape phone', inside(dlg, W, H) && dlgScroll[0] <= dlgScroll[1] + 1, JSON.stringify({ b: Math.round(dlg.b), dlgScroll }));
  await shot('06-pause');
  await G(() => { const el = document.getElementById('opt-tscale'); el.value = '1.4'; el.dispatchEvent(new Event('input')); });
  const sc = await G(() => ({ tc: getComputedStyle(document.documentElement).getPropertyValue('--tc').trim(), stored: localStorage.getItem('steel-vanguard.tscale') }));
  check('control size scales the layer and is remembered', Math.abs(Number(sc.tc) - 1.4) < 0.01 && sc.stored === '1.4', JSON.stringify(sc));
  await G(() => { const el = document.getElementById('opt-tscale'); el.value = '1'; el.dispatchEvent(new Event('input')); });
  await G(() => { const el = document.getElementById('opt-assist'); el.checked = false; el.dispatchEvent(new Event('change')); });
  check('the aim assist option switches it off', (await G(() => window.__game.player.assistOn)) === false);
  await G(() => { const el = document.getElementById('opt-assist'); el.checked = true; el.dispatchEvent(new Event('change')); });
  await tap('#btn-resume');
  await page.waitForFunction(() => window.__game.state === 'playing');
  await page.waitForFunction(() => !document.getElementById('touch').classList.contains('hidden'));
  check('RESUME brings the sortie and the controls back, still without pointer lock', (await G(() => window.__lockRequests)) === 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const port1 = await G(() => ({ state: window.__game.state, rotate: getComputedStyle(document.getElementById('rotate')).display }));
  check('turning the phone upright pauses and asks for landscape', port1.state === 'paused' && port1.rotate !== 'none', JSON.stringify(port1));
  await shot('07-rotate');
  await page.setViewportSize({ width: W, height: H });
  await page.waitForTimeout(400);
  check('turning it back hides the prompt', (await G(() => getComputedStyle(document.getElementById('rotate')).display)) === 'none');
  await tap('#btn-resume');
  await page.waitForFunction(() => window.__game.state === 'playing');

  // ------------------------------------------------------------ 10. contextual buttons for other loadouts
  const shapes = await G(async () => {
    const g = window.__game, out = {};
    const vis = (id) => { const e = document.getElementById(`tc-${id}`); return getComputedStyle(e).display !== 'none'; };
    const field = async (patch, label) => {
      g.setBuild({ ...window.__garage.build, ...patch });
      g.startMission(); g.manual = true; g.missions.state = 'idle'; g.hud.reset(); g.step(3);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      out[label] = { cannon: vis('cannon'), sub: vis('sub'), saber: vis('saber'), reload: vis('reload'), fire: document.querySelector('#tc-fire b').textContent, subLabel: document.querySelector('#tc-sub b').textContent, cannonLabel: document.querySelector('#tc-cannon b').textContent };
    };
    await field({ offhand: 'cannon', sub: 'vulcan' }, 'cannonVulcan');
    await field({ weapon: 'sabers', offhand: 'none', sub: 'flare' }, 'sabersFlare');
    await field({ weapon: 'rifle', offhand: 'swarm', sub: 'injector' }, 'swarmInject');
    await field({ weapon: 'rifle', offhand: 'shield', sub: 'pulse' }, 'pulse');
    await field({ weapon: 'rifle', offhand: 'shield', sub: 'none' }, 'stock');
    g.cheat.invincible = true;
    return out;
  });
  check('a shoulder cannon and vulcans add their buttons', shapes.cannonVulcan.cannon && shapes.cannonVulcan.sub && shapes.cannonVulcan.subLabel === 'VULCAN', JSON.stringify(shapes.cannonVulcan));
  check('twin sabers turn FIRE into SABER and drop the reload and extra saber buttons', shapes.sabersFlare.fire === 'SABER' && !shapes.sabersFlare.saber && !shapes.sabersFlare.reload && shapes.sabersFlare.sub && shapes.sabersFlare.subLabel === 'FLARE', JSON.stringify(shapes.sabersFlare));
  check('the micro-missile arm labels its button SWARM, and the EN injector gets an INJECT button', shapes.swarmInject.cannon && shapes.swarmInject.cannonLabel === 'SWARM' && shapes.swarmInject.sub && shapes.swarmInject.subLabel === 'INJECT' && shapes.pulse.subLabel === 'PULSE', JSON.stringify([shapes.swarmInject, shapes.pulse.subLabel]));
  check('back to a stock loadout the extras disappear again', !shapes.stock.cannon && !shapes.stock.sub && shapes.stock.saber && shapes.stock.fire === 'FIRE');
  await G(() => { const p = window.__game.player; p.reset(0, 0); p.burst = 100; window.__game.step(3); });
  await page.waitForTimeout(150);
  check('BURST appears when the gauge is full', await page.$eval('#tc-burst', (e) => getComputedStyle(e).display !== 'none'));
  await tap('#tc-burst');
  await G(() => window.__game.step(3));
  check('tapping BURST starts it', await G(() => window.__game.player.burstT > 0));

  // ------------------------------------------------------------ 10b. the pit stop between waves, on a phone
  await G(() => {
    const g = window.__game;
    g.setBuild({ ...window.__garage.build, weapon: 'rifle', offhand: 'shield', sub: 'none', torso: 'std' });
    g.settings.pitStops = true;
    g.startMission();
    g.manual = true;
    g.cheat.invincible = true;
    g.hud.reset();
    g.step(60 * 4);
    g.player.mech.place(90, -60, 0, 0.7);
    g.player.mech.hp = g.player.mech.maxHp * 0.5;
    for (const e of [...g.enemies]) e.mech.takeDamage(1e6, { kind: 'beam' });
    g.step(1);
    g.step(60 * 5);
  });
  await page.waitForFunction(() => !document.getElementById('screen-garage').classList.contains('hidden'));
  await page.waitForTimeout(400);
  const pitPhone = {
    state: await G(() => window.__game.state), layer: await G(() => document.getElementById('touch').classList.contains('hidden')),
    card: await rect('#g-pit'), opts: await rect('#g-options'), go: await rect('#g-go'), left: await rect('.g-left'), back: await rect('#g-back'),
    name: await rect('.g-name'), label: await page.textContent('#g-go'),
  };
  dump('pit phone', pitPhone);
  check('the pit stop on a phone: the touch controls hide and the garage appears', pitPhone.state === 'intermission' && pitPhone.layer);
  check('the pit card fits inside the panel and the parts list keeps room to scroll', pitPhone.card.shown && inside(pitPhone.card, W, H) && pitPhone.card.b <= pitPhone.left.b && pitPhone.opts.h >= 100, `list ${Math.round(pitPhone.opts.h)}px`);
  check('the pit stop hides BACK and the callsign field, and offers a big LAUNCH button', !pitPhone.back.shown && !pitPhone.name.shown && /^LAUNCH WAVE 2$/.test(pitPhone.label) && inside(pitPhone.go, W, H) && pitPhone.go.h >= 32);
  await shot('09-pit');
  await tap('.g-tab[data-tab="shoulder"]');
  await tap('.opt[data-id="bulwark"]');
  check('tapping a part in the pit equips it', (await G(() => window.__game.player.build.shoulder)) === 'bulwark');
  await touch.down(1, 420, 200);
  for (let i = 1; i <= 5; i++) await touch.move(1, 420 + i * 10, 200);
  await touch.up(1);
  check('dragging the mech around in the pit turns the turntable', !(await G(() => window.__game.garageCam.dragging)));
  await tap('#g-go');
  await page.waitForFunction(() => window.__game.state === 'playing');
  await page.waitForFunction(() => !document.getElementById('touch').classList.contains('hidden'));
  const afterPit = await G(() => { const m = window.__game.player.mech; return { at: [Math.round(m.pos.x), Math.round(m.pos.z)], wave: window.__game.missions.waveNumber, share: m.hp / m.maxHp, garage: document.getElementById('screen-garage').classList.contains('hidden') }; });
  check('LAUNCH by touch returns to the sortie with the controls back, the armor carried over and the position kept', afterPit.garage && afterPit.at[0] === 90 && afterPit.at[1] === -60 && afterPit.wave === 2 && Math.abs(afterPit.share - 0.75) < 0.02, JSON.stringify(afterPit));
  await touch.down(1, 150, 300);
  await touch.move(1, 150, 232);
  check('the stick still works after the pit stop', (await G(() => window.__game.input.axis.y)) > 0.9);
  await touch.up(1);
  await G(() => { const g = window.__game; g.settings.pitStops = false; g.cheat.invincible = true; });

  // ------------------------------------------------------------ 11. end screen, and the input device in use wins
  await G(() => { const g = window.__game; g.cheat.invincible = true; g.endMission(true); g.endTimer = 0; g.step(3); });
  await page.waitForFunction(() => !document.getElementById('screen-end').classList.contains('hidden'));
  const end = await rect('#screen-end .dialog');
  const endScroll = await G(() => { const d = document.querySelector('#screen-end .dialog'); return [d.scrollHeight, d.clientHeight]; });
  check('the end screen fits a landscape phone', inside(end, W, H) && endScroll[0] <= endScroll[1] + 1, JSON.stringify({ b: Math.round(end.b), endScroll }));
  await page.waitForTimeout(200); // a frame or two for the layer to notice the sortie is over
  const endLayer = await G(() => ({ hidden: document.getElementById('touch').classList.contains('hidden'), state: window.__game.state, visible: window.__game.touch.visible }));
  check('the controls are gone on the end screen', endLayer.hidden, JSON.stringify(endLayer));
  await shot('08-end');
  await tap('#btn-again');
  await page.waitForFunction(() => window.__game.state === 'playing');
  await page.waitForFunction(() => !document.getElementById('touch').classList.contains('hidden'));
  check('SORTIE AGAIN by touch restarts with the controls up', true);

  await G(() => { const g = window.__game; g.endMission(false); g.endTimer = 0; g.step(3); });
  await page.waitForFunction(() => !document.getElementById('screen-end').classList.contains('hidden'));
  await tap('#btn-garage-end');
  await page.waitForFunction(() => window.__game.state === 'garage');
  await tap('#g-back');
  await page.waitForFunction(() => window.__game.state === 'title');
  await page.mouse.click(30, 30);
  await page.waitForTimeout(100);
  check('picking up a mouse switches the touch controls off between sorties', !(await G(() => window.__game.touch.active)) && !(await G(() => document.documentElement.classList.contains('touch'))));
  await page.touchscreen.tap(30, 30);
  await page.waitForTimeout(100);
  check('and a finger switches them back on', await G(() => window.__game.touch.active && document.documentElement.classList.contains('touch')));

  check('no console errors or warnings in the phone session', problems.length === 0, problems.slice(0, 3).join(' | '));
  await context.close();

  // ------------------------------------------------------------ 12. desktop is untouched
  const desk = await openPage({ isMobile: false, hasTouch: false, viewport: { width: 1280, height: 720 }, userAgent: undefined, deviceScaleFactor: 1 });
  const d = desk.page;
  const dinfo = await d.evaluate(() => ({ touchClass: document.documentElement.classList.contains('touch'), active: window.__game.touch.active, ctl: getComputedStyle(document.querySelector('.controls')).display,
    tips: getComputedStyle(document.querySelector('.controls-touch')).display, assistRow: getComputedStyle(document.getElementById('opt-assist').parentElement).display, ratio: window.__game.renderer.getPixelRatio(), shadows: localStorage.getItem('steel-vanguard.shadows') }));
  check('desktop: no touch class, the keyboard controls list is shown', !dinfo.touchClass && !dinfo.active && dinfo.ctl !== 'none' && dinfo.tips === 'none', JSON.stringify(dinfo));
  check('desktop: graphics defaults are unchanged', dinfo.ratio === 1 && dinfo.shadows !== 'false');
  check('desktop: touch-only options are hidden', dinfo.assistRow === 'none');
  await d.click('#btn-start');
  await d.waitForFunction(() => window.__game.state === 'playing');
  await d.waitForTimeout(300);
  const dplay = await d.evaluate(() => ({ locks: window.__lockRequests, layer: getComputedStyle(document.getElementById('touch')).display, weapons: getComputedStyle(document.getElementById('weapons')).display,
    radar: window.__game.hud.radarGeom().R, assist: window.__game.player.assistOn, mission: getComputedStyle(document.querySelector('#mission .row:last-child')).display }));
  check('desktop: the sortie still captures the mouse and shows the keyboard HUD', dplay.locks > 0 && dplay.layer === 'none' && dplay.weapons !== 'none' && dplay.radar === 72 && dplay.mission !== 'none', JSON.stringify(dplay));
  check('desktop: soft aim stays off even though the option defaults on', dplay.assist === false);
  check('no console errors on desktop', problems.length === 0, problems.slice(0, 3).join(' | '));
  await desk.context.close();

  // ?touch=1 forces the touch interface on a desktop browser (handy for trying it with a mouse)
  const forced = await openPage({ isMobile: false, hasTouch: false, viewport: { width: 900, height: 420 }, userAgent: undefined, deviceScaleFactor: 1 }, `${URL}?touch=1`);
  const fp = forced.page;
  await fp.click('#btn-start');
  await fp.waitForFunction(() => window.__game.state === 'playing');
  await fp.waitForFunction(() => !document.getElementById('touch').classList.contains('hidden'));
  await fp.mouse.click(30, 30); // a mouse does not turn a forced touch UI off
  const fin = await fp.evaluate(() => ({ active: window.__game.touch.active, locks: window.__lockRequests }));
  check('?touch=1 forces the touch controls on a desktop browser', fin.active && fin.locks === 0, JSON.stringify(fin));
  await forced.context.close();
  check('no console errors with ?touch=1', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (err) {
  failures++;
  console.error('FAIL  test harness crashed:', err);
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
