// End-to-end test: loads the game in headless Chromium and plays it with a scripted bot.
//   node scripts/test.mjs            run everything
//   SHOTS=0 node scripts/test.mjs    skip screenshots
// Needs the `playwright` package (npm i -D playwright, or a global install) and a Chromium build.
// Screenshots and the log go to out/test/.

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
const DEBUG = !!process.env.DEBUG; // dump the raw numbers behind each section

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [() => req('playwright'), () => createRequire('/opt/node-tools/node_modules/')('playwright')];
  for (const t of tries) {
    try { return t(); } catch { /* try next */ }
  }
  console.error('Could not load playwright. Install it with: npm i -D playwright');
  process.exit(2);
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const dump = (label, obj) => { if (DEBUG) console.log(`      ${label}: ${JSON.stringify(obj)}`); };
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- start server + browser

const port = await freePort();
const server = spawn('python3', [path.join(root, 'serve.py'), String(port)], { stdio: 'ignore' });
const { chromium } = loadPlaywright();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.stack || e.message}`));

// Simulate pointer lock deterministically (request -> locked, exit -> unlocked, both fire the event).
await page.addInitScript(() => {
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
});

const shot = async (name) => {
  if (!SHOTS) return;
  await page.evaluate(() => window.__game.render());
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
};

try {
  // ------------------------------------------------------------ 1. boot
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game);
  await page.waitForTimeout(1500);
  check('page boots without console errors', problems.length === 0, problems.slice(0, 3).join(' | '));
  check('title screen is visible', await page.isVisible('#screen-title'));

  // Install helpers inside the page: a scripted pilot, and building-collision invariants.
  await page.evaluate(() => {
    const g = window.__game;
    g.manual = true; // the test drives the simulation itself
    window.__uiOnEnd = g.onEnd; // main.js's end-screen handler
    window.__t = {
      keys(down, up = []) {
        for (const k of up) g.input.keyUp(k);
        for (const k of down) g.input.keyDown(k);
      },
      tap(code) { g.input.keyDown(code); g.input.keyUp(code); },
      insideBuilding() {
        const m = g.player.mech;
        for (const b of g.world.boxes) {
          if (m.pos.y < b.top - 0.5 && m.pos.x > b.minX && m.pos.x < b.maxX && m.pos.z > b.minZ && m.pos.z < b.maxZ) return true;
        }
        return false;
      },
      finite(v) { return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z); },
      allFinite() {
        const ms = [g.player.mech, ...g.enemies.map((e) => e.mech)];
        return ms.every((m) => this.finite(m.pos) && this.finite(m.vel) && Number.isFinite(m.hp));
      },
      // one tick of a simple but competent pilot
      pilot(state) {
        const inp = g.input, p = g.player, m = p.mech, t = g.time;
        const tgt = p.lock;
        const dist = tgt ? Math.hypot(tgt.pos.x - m.pos.x, tgt.pos.z - m.pos.z) : 0;
        const set = (c, on) => (on ? inp.keyDown(c) : inp.keyUp(c));
        set('Mouse0', !!tgt && p.ammo > 0 && !p.melee);
        const ph = Math.floor(t / 1.3) % 2;
        set('KeyA', !!tgt && ph === 0);
        set('KeyD', !!tgt && ph === 1);
        set('KeyW', !!tgt && dist > 110);
        set('KeyS', !!tgt && dist < 45 && !state.melee);
        set('Space', m.blocked > 0 || (!!tgt && m.pos.y < 18 && m.en > 60 && Math.floor(t / 2.5) % 3 === 0));
        if (Math.floor(t * 1.5) !== state.lastDash && m.en > 40) { state.lastDash = Math.floor(t * 1.5); this.tap('ShiftLeft'); }
        if (tgt && dist < 38) this.tap('Mouse2');
        if (tgt && p.missiles > 0 && dist > 70 && Math.floor(t * 4) % 7 === 0) this.tap('KeyE');
        if (p.burst >= 100) this.tap('KeyX');
      },
    };
  });

  // ------------------------------------------------------------ 2. start through the real button
  await page.click('#btn-start');
  const started = await page.evaluate(() => ({ state: window.__game.state, hudHidden: document.getElementById('hud').classList.contains('hidden') }));
  check('SORTIE button starts the mission', started.state === 'playing' && !started.hudHidden);
  check('starting the mission captures the mouse', (await page.evaluate(() => window.__lockRequests)) >= 1);
  await page.evaluate(() => { const g = window.__game; g.missions.state = 'idle'; g.hud.reset(); });

  // ------------------------------------------------------------ 3. movement
  const move = await page.evaluate(() => {
    const g = window.__game, T = window.__t, m = g.player.mech;
    const out = {};
    g.step(30);
    out.groundedAtStart = m.grounded && Math.abs(m.pos.y) < 0.01;
    // boost up
    T.keys(['Space']);
    g.step(70);
    out.peak = m.pos.y;
    out.enUsed = m.maxEn - m.en;
    out.thrusting = m.thrusting;
    T.keys([], ['Space']);
    g.step(360);
    out.landed = m.grounded && Math.abs(m.pos.y) < 0.01;
    // walk
    g.step(120); // let EN refill
    const x0 = m.pos.x, z0 = m.pos.z;
    g.rig.yaw = 0;
    T.keys(['KeyW']);
    g.step(60);
    T.keys([], ['KeyW']);
    out.walked = Math.hypot(m.pos.x - x0, m.pos.z - z0);
    out.walkedForward = (m.pos.z - z0) < 0; // yaw 0 faces -Z
    // dash
    g.step(60);
    const dx0 = m.pos.x, dz0 = m.pos.z;
    T.keys(['KeyW']);
    T.tap('ShiftLeft');
    g.step(14);
    T.keys([], ['KeyW']);
    out.dashed = Math.hypot(m.pos.x - dx0, m.pos.z - dz0);
    out.dashSpent = m.maxEn - m.en;
    return out;
  });
  dump('move', move);
  check('player idles grounded at y=0', move.groundedAtStart);
  check('boost lifts the mech and costs EN', move.peak > 30 && move.enUsed > 5, `peak ${move.peak.toFixed(1)}, EN used ${move.enUsed.toFixed(1)}`);
  check('mech falls back and lands', move.landed);
  check('W walks forward relative to the camera', move.walked > 20 && move.walkedForward, `${move.walked.toFixed(1)} units`);
  check('dash covers ground fast and costs EN', move.dashed > 35 && move.dashSpent > 10, `${move.dashed.toFixed(1)} units`);

  // ------------------------------------------------------------ 4. collision
  const coll = await page.evaluate(() => {
    const g = window.__game, T = window.__t, m = g.player.mech;
    const out = { insideCount: 0, finite: true };
    // pick a building and run at its west face from open street
    const b = g.world.boxes.find((bx) => bx.maxX - bx.minX > 20 && bx.top > 25 && bx.minX > 100);
    const cz = (b.minZ + b.maxZ) / 2;
    m.place(b.minX - 40, cz, 0, -Math.PI / 2);
    g.rig.yaw = -Math.PI / 2;
    g.step(20);
    T.keys(['KeyW']);
    for (let i = 0; i < 240; i++) {
      g.step(1);
      if (T.insideBuilding()) out.insideCount++;
      if (!T.allFinite()) out.finite = false;
    }
    T.keys([], ['KeyW']);
    out.stopX = m.pos.x;
    out.faceX = b.minX;
    // fly onto its roof and land
    m.place((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, b.top + 25, 0);
    g.step(120);
    out.roofY = m.pos.y;
    out.roofTop = b.top;
    out.roofGrounded = m.grounded;
    // walk off the edge and drop to the street
    T.keys(['KeyD']);
    g.rig.yaw = -Math.PI / 2; // right of -x-facing camera is -z... any direction eventually leaves the roof
    g.step(400);
    T.keys([], ['KeyD']);
    out.afterWalkY = m.pos.y;
    // arena limit
    m.place(0, 0, 0, 0);
    g.rig.yaw = -Math.PI / 2;
    T.keys(['KeyW', 'Space']);
    g.step(60 * 12);
    T.keys([], ['KeyW', 'Space']);
    out.arenaX = m.pos.x;
    out.arenaOk = Math.abs(m.pos.x) < 400 && Math.abs(m.pos.z) < 400;
    m.place(0, 0, 0, 0);
    g.step(60);
    return out;
  });
  dump('collision', coll);
  check('mech never ends up inside a building', coll.insideCount === 0 && coll.finite, `inside on ${coll.insideCount} frames`);
  check('mech is stopped by the building face', coll.stopX <= coll.faceX - 4, `stopped at x=${coll.stopX.toFixed(1)} (face ${coll.faceX.toFixed(1)})`);
  check('mech lands on a rooftop', Math.abs(coll.roofY - coll.roofTop) < 0.6 && coll.roofGrounded, `y=${coll.roofY.toFixed(2)} top=${coll.roofTop.toFixed(2)}`);
  check('mech walks off a roof and falls to the street', coll.afterWalkY < coll.roofTop - 1, `y=${coll.afterWalkY.toFixed(1)}`);
  check('arena boundary holds', coll.arenaOk, `x=${coll.arenaX.toFixed(0)}`);

  // Randomised stress: many short runs at random buildings with random inputs.
  const stress = await page.evaluate(() => {
    const g = window.__game, T = window.__t, m = g.player.mech, boxes = g.world.boxes;
    const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'];
    const deep = () => boxes.some((b) => m.pos.y < b.top - 0.5 && m.pos.x > b.minX + m.radius * 0.5 && m.pos.x < b.maxX - m.radius * 0.5 &&
      m.pos.z > b.minZ + m.radius * 0.5 && m.pos.z < b.maxZ - m.radius * 0.5);
    let deepFrames = 0, bad = 0;
    for (let run = 0; run < 80; run++) {
      const b = boxes[Math.floor(Math.random() * boxes.length)];
      m.place((b.minX + b.maxX) / 2 + (Math.random() - 0.5) * 120, (b.minZ + b.maxZ) / 2 + (Math.random() - 0.5) * 120, Math.random() < 0.3 ? Math.random() * 80 : 0, 0);
      m.en = m.maxEn;
      g.rig.yaw = Math.random() * Math.PI * 2;
      for (let f = 0; f < 200; f++) {
        if (f % 20 === 0) {
          T.keys([], keys);
          for (const k of keys) if (Math.random() < 0.4) g.input.keyDown(k);
          if (Math.random() < 0.3) T.tap('ShiftLeft');
        }
        g.step(1);
        if (!T.finite(m.pos)) { bad++; break; }
        if (deep()) deepFrames++;
      }
    }
    T.keys([], keys);
    m.place(0, 0, 0, 0);
    g.step(30);
    return { deepFrames, bad };
  });
  check('random flying/walking never puts the mech inside a building', stress.deepFrames === 0 && stress.bad === 0, `${stress.deepFrames} deep frames, ${stress.bad} non-finite runs`);

  // ------------------------------------------------------------ 5. weapons
  await shot('00_idle');
  const weapons = await page.evaluate(async () => {
    const g = window.__game, T = window.__t, p = g.player, m = p.mech;
    const { createEnemy } = await import('/src/ai.js');
    const out = {};
    const place = (type, dx, dz) => {
      const e = createEnemy(g, type, 1);
      e.mech.place(m.pos.x + dx, m.pos.z + dz, 0, 0);
      g.enemies.push(e);
      return e;
    };
    const clearEnemies = () => { for (const e of g.enemies) e.mech.destroy(); g.enemies.length = 0; g.projectiles.clear(); };
    g.cheat.invincible = true;
    m.place(0, 0, 0, 0);
    g.rig.yaw = 0;
    g.step(5);

    // --- beam rifle + lock-on
    const d = place('drone', 0, -90);
    d.think = () => ({ faceYaw: 0 }); // stand still so the test measures weapons, not dodging
    d.def_dodge = 0;
    g.step(2);
    out.locked = p.lock === d.mech;
    const hp0 = d.mech.hp, ammo0 = p.ammo;
    T.keys(['Mouse0']);
    g.step(75);
    T.keys([], ['Mouse0']);
    out.rifleDamage = hp0 - d.mech.hp;
    out.ammoUsed = ammo0 - p.ammo;
    out.killedByRifle = d.mech.dead;
    // reload
    p.ammo = 0; p.reloadT = 0; p.fireCd = 0;
    g.step(1);
    T.keys(['Mouse0']);
    g.step(2);
    T.keys([], ['Mouse0']);
    out.reloading = p.reloadT > 0;
    g.step(60 * 2.2);
    out.reloaded = p.ammo === 8;
    clearEnemies();

    // --- sabre combo
    const s = place('striker', 0, -30);
    s.think = () => ({ faceYaw: 0 });
    s.def_dodge = 0;
    s.mech.hp = s.mech.maxHp = 5000;
    g.step(2);
    const shp = s.mech.hp;
    let stages = [];
    for (let i = 0; i < 3; i++) {
      T.tap('Mouse2');
      for (let k = 0; k < 20; k++) { g.step(1); if (p.melee) stages.push(p.melee.stage); }
      g.step(10);
    }
    g.step(60);
    out.sabreDamage = shp - s.mech.hp;
    out.comboStages = [...new Set(stages)];
    clearEnemies();

    // --- missiles
    m.place(0, 0, 0, 0);
    const mt = place('bulwark', 0, -140);
    mt.think = () => ({ faceYaw: 0 });
    mt.mech.hp = mt.mech.maxHp = 9000;
    g.step(2);
    const mhp = mt.mech.hp, charges = p.missiles;
    T.tap('KeyE');
    g.step(26); // the four missiles launch 0.09 s apart
    out.missilesInFlight = g.projectiles.list.filter((q) => q.type === 'missile').length;
    g.step(60 * 3);
    out.missileDamage = mhp - mt.mech.hp;
    out.chargeSpent = charges - p.missiles;
    clearEnemies();
    return out;
  });
  dump('weapons', weapons);
  check('lock-on acquires the nearest hostile', weapons.locked);
  check('beam rifle damages and kills a drone', weapons.rifleDamage >= 400 && weapons.killedByRifle, `${weapons.rifleDamage} dmg, ${weapons.ammoUsed} rounds`);
  check('empty magazine reloads', weapons.reloading && weapons.reloaded);
  check('sabre combo chains three stages', weapons.comboStages.length === 3, `stages ${weapons.comboStages}`);
  check('sabre deals melee damage', weapons.sabreDamage >= 700, `${weapons.sabreDamage} dmg`);
  check('missile salvo launches and hits', weapons.missilesInFlight === 4 && weapons.missileDamage >= 300 && weapons.chargeSpent === 1, `${weapons.missileDamage} dmg`);

  // ------------------------------------------------------------ 6. enemies fight back
  const enemies = await page.evaluate(async () => {
    const g = window.__game, p = g.player, m = p.mech;
    const { createEnemy } = await import('/src/ai.js');
    const out = {};
    const run = (type, dx, dz, seconds) => {
      for (const e of g.enemies) e.mech.destroy();
      g.enemies.length = 0; g.projectiles.clear();
      g.cheat.invincible = false;
      g.state = 'playing'; // an earlier fight may have killed the pilot and ended the "mission"
      p.reset(0, 0);
      p.lock = null; p.lockEnabled = false;
      const e = createEnemy(g, type, 1);
      e.mech.place(dx, dz, 0, 0);
      g.enemies.push(e);
      const modes = new Set();
      for (let i = 0; i < 60 * seconds; i++) { g.step(1); if (e.mode) modes.add(e.mode); }
      const lost = m.maxHp - m.hp;
      return { lost, modes: [...modes] };
    };
    out.drone = run('drone', 0, -100, 25);
    out.striker = run('striker', 0, -90, 25);
    out.bulwark = run('bulwark', 0, -150, 30);
    out.baron = run('baron', 0, -120, 30);
    for (const e of g.enemies) e.mech.destroy();
    g.enemies.length = 0; g.projectiles.clear();
    return out;
  });
  dump('enemies', enemies);
  check('drone shoots the player', enemies.drone.lost > 0, `-${Math.round(enemies.drone.lost)} armor`);
  check('striker closes in and cuts the player', enemies.striker.lost > 0, `-${Math.round(enemies.striker.lost)} armor, modes ${enemies.striker.modes}`);
  check('bulwark lobs cannon shells', enemies.bulwark.lost > 0, `-${Math.round(enemies.bulwark.lost)} armor`);
  check('baron attacks with several patterns', enemies.baron.lost > 0 && enemies.baron.modes.length >= 3, `-${Math.round(enemies.baron.lost)} armor, modes ${enemies.baron.modes}`);

  // ------------------------------------------------------------ 7. full mission with the pilot bot
  // (the fights above may have "ended" the mission and raised the end dialog; start from a clean screen)
  await page.evaluate(() => {
    for (const id of ['screen-end', 'screen-pause', 'screen-title']) document.getElementById(id).classList.add('hidden');
  });
  await page.evaluate(() => {
    const g = window.__game;
    g.cheat.invincible = true;
    g.player.lockEnabled = true;
    const uiOnEnd = window.__uiOnEnd;
    g.startMission();
    g.manual = true;
    window.__ended = null;
    g.onEnd = (r) => { window.__ended = r; uiOnEnd?.(r); }; // capture the result, then let the real UI show it
    window.__wavesSeen = new Set();
    window.__state = { lastDash: -1 };
  });
  let shotsTaken = new Set();
  const wanted = [['01_wave_combat', (s) => s.wave === 2 && s.enemies >= 3], ['02_boss', (s) => s.wave === 5 && s.boss]];
  let finished = false;
  for (let chunk = 0; chunk < 240 && !finished; chunk++) {
    const s = await page.evaluate(() => {
      const g = window.__game, T = window.__t;
      for (let i = 0; i < 120; i++) {
        T.pilot(window.__state);
        g.step(1);
        window.__wavesSeen.add(g.missions.waveNumber);
        if (!T.allFinite()) return { bad: true };
        if (window.__ended) break;
      }
      return {
        ended: !!window.__ended, wave: g.missions.waveNumber, enemies: g.enemies.length, time: g.stats.time,
        boss: g.enemies.some((e) => e.mech.def.boss), kills: g.stats.kills, hp: g.player.mech.hp, lock: !!g.player.lock,
      };
    });
    if (s.bad) { check('simulation stays finite during the mission', false); break; }
    for (const [name, cond] of wanted) {
      if (!shotsTaken.has(name) && cond(s)) { shotsTaken.add(name); await shot(name); }
    }
    if (s.ended) finished = true;
    if (chunk % 10 === 0) console.log(`      …wave ${s.wave}, ${s.enemies} hostile, ${s.kills} kills, t=${s.time.toFixed(0)}s, armor ${Math.round(s.hp)}`);
  }
  const result = await page.evaluate(() => ({ r: window.__ended, waves: [...window.__wavesSeen], state: window.__game.state }));
  check('bot clears all five waves and wins', !!result.r && result.r.victory === true, result.r ? `rank ${result.r.rank}` : 'mission never ended');
  check('every wave was reached', [1, 2, 3, 4, 5].every((w) => result.waves.includes(w)), `waves ${result.waves}`);
  check('result screen reports stats', !!result.r && result.r.rows.length >= 6 && result.r.rows.some((r) => r[0] === 'Total'));
  await page.waitForTimeout(300);
  check('end screen is displayed', await page.isVisible('#screen-end'));
  await shot('03_victory');

  // ------------------------------------------------------------ 8. defeat path
  await page.evaluate(() => {
    const g = window.__game;
    document.getElementById('screen-end').classList.add('hidden');
    g.cheat.invincible = false;
    const uiOnEnd = window.__uiOnEnd;
    g.startMission();
    g.manual = true;
    window.__ended = null;
    g.onEnd = (r) => { window.__ended = r; uiOnEnd?.(r); }; // capture the result, then let the real UI show it
  });
  const defeat = await page.evaluate(() => {
    const g = window.__game;
    for (let i = 0; i < 60 * 240 && !window.__ended; i++) g.step(1); // stand still and get shot
    return { r: window.__ended, dead: g.player.mech.dead, state: g.state };
  });
  check('an idle pilot is destroyed and the mission fails', !!defeat.r && defeat.r.victory === false && defeat.dead, defeat.r ? 'defeat reported' : 'never died');
  await shot('04_defeat');

  // ------------------------------------------------------------ 9. restart + pause flow
  await page.evaluate(() => { document.getElementById('screen-end').classList.add('hidden'); });
  await page.evaluate(() => { const g = window.__game; g.startMission(); g.manual = true; });
  const restart = await page.evaluate(() => {
    const g = window.__game;
    g.step(60);
    const ok = g.state === 'playing' && !g.player.mech.dead && g.player.mech.hp === g.player.mech.maxHp && g.enemies.length === 0;
    g.pause();
    const paused = g.state === 'paused';
    g.resume();
    return { ok, paused, resumed: g.state === 'playing' };
  });
  check('restart after defeat resets the mech and the field', restart.ok);
  check('pause and resume work', restart.paused && restart.resumed);

  // losing the pointer lock (what Esc does while the mouse is captured) pauses the game
  const lockLoss = await page.evaluate(() => {
    const g = window.__game;
    g.startMission();
    g.manual = true;
    for (const id of ['screen-end', 'screen-pause', 'screen-title']) document.getElementById(id).classList.add('hidden');
    g.canvas.requestPointerLock(); // main.js notes that the mouse is captured
    g.step(10);
    const before = g.state;
    document.exitPointerLock();
    return { before, after: g.state, shown: !document.getElementById('screen-pause').classList.contains('hidden') };
  });
  check('losing the pointer lock pauses the game', lockLoss.before === 'playing' && lockLoss.after === 'paused' && lockLoss.shown);
  await page.click('#btn-resume');
  check('resuming recaptures the mouse', (await page.evaluate(() => window.__game.state === 'playing' && !!window.__fakeLock)));

  // Esc pauses through the real UI, and Resume continues
  await page.keyboard.press('Escape');
  const paused = await page.evaluate(() => ({ state: window.__game.state, shown: !document.getElementById('screen-pause').classList.contains('hidden') }));
  check('Esc opens the pause screen', paused.state === 'paused' && paused.shown);
  await page.click('#btn-resume');
  const resumed = await page.evaluate(() => ({ state: window.__game.state, hidden: document.getElementById('screen-pause').classList.contains('hidden') }));
  check('Resume button returns to the game', resumed.state === 'playing' && resumed.hidden);

  // graphics options apply live and persist
  const gfx = await page.evaluate(() => {
    const g = window.__game;
    const set = (id, prop, value) => {
      const el = document.getElementById(id);
      el[prop] = value;
      el.dispatchEvent(new Event('change'));
    };
    set('opt-shadows', 'checked', false);
    set('opt-scale', 'value', '0.5');
    g.render();
    const low = { shadows: g.renderer.shadowMap.enabled, sunShadow: g.world.sun.castShadow, ratio: g.renderer.getPixelRatio(), stored: localStorage.getItem('steel-vanguard.shadows') };
    set('opt-shadows', 'checked', true);
    set('opt-scale', 'value', '1');
    g.render();
    return { low, high: { shadows: g.renderer.shadowMap.enabled, ratio: g.renderer.getPixelRatio() } };
  });
  check('shadow and resolution options apply and persist', !gfx.low.shadows && !gfx.low.sunShadow && gfx.low.ratio === 0.5 && gfx.low.stored === 'false' && gfx.high.shadows && gfx.high.ratio === 1, JSON.stringify(gfx));

  check('no console errors or warnings during the whole run', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (err) {
  failures++;
  console.error('FAIL  test harness crashed:', err);
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
