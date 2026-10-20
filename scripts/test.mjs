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

// ---------------------------------------------------------------- parts logic (plain Node, no browser)

{
  const P = await import(path.join(root, 'src', 'parts.js'));
  const def = P.deriveStats(P.DEFAULT_BUILD);
  const vary = (slot, id) => P.deriveStats({ ...P.DEFAULT_BUILD, [slot]: id });

  check('default build matches the original Vanguard', Math.abs(def.hp - 2600) <= 50 && def.speed === 40 && def.en === 100 && def.weapon.mag === 8, `armor ${def.hp}`);

  const every = [];
  for (const slot of P.SLOTS) for (const part of P.PARTS[slot]) every.push([slot, part.id, vary(slot, part.id)]);
  const finite = every.every(([, , s]) => [s.hp, s.speed, s.airSpeed, s.en, s.dashSpeed, s.dashCost, s.dps, s.melee, s.weight, s.turn].every(Number.isFinite) && s.hp > 0 && s.speed > 0);
  check('every part yields finite, positive stats', finite, `${every.length} parts`);

  const dir = (label, ok) => check(`part effect: ${label}`, ok);
  dir('heavy torso: more armor, slower', vary('torso', 'heavy').hp > def.hp && vary('torso', 'heavy').speed < def.speed);
  dir('light torso: less armor, faster', vary('torso', 'light').hp < def.hp && vary('torso', 'light').speed > def.speed);
  dir('reactor torso: more boost fuel and burst gain', vary('torso', 'reactor').en > def.en && vary('torso', 'reactor').burstGain > 1);
  dir('tank legs: armor and stagger resistance, slow', vary('legs', 'tank').hp > def.hp && vary('legs', 'tank').staggerAt > def.staggerAt && vary('legs', 'tank').speed < def.speed);
  dir('sprint legs: faster, cheaper dashes', vary('legs', 'sprint').speed > def.speed && vary('legs', 'sprint').dashCost < def.dashCost);
  dir('jump legs: stronger climb and air EN regen', vary('legs', 'jump').ascendSpeed > def.ascendSpeed && vary('legs', 'jump').enAir > def.enAir);
  dir('booster pack: more boost fuel', vary('backpack', 'booster').en > def.en);
  dir('missile pod: third charge and stronger missiles', vary('backpack', 'pod').missileCharges === 3 && vary('backpack', 'pod').missileDamage > 1);
  dir('wing pack: faster, cheaper dash', vary('backpack', 'wing').dashSpeed > def.dashSpeed && vary('backpack', 'wing').dashCost < def.dashCost);
  dir('visor head: tougher and harder to stagger', vary('head', 'visor').hp > def.hp && vary('head', 'visor').staggerAt > def.staggerAt);
  dir('scout head: tighter missile homing', vary('head', 'scout').missileTurn > 0);
  dir('commander head: faster burst gain', vary('head', 'horn').burstGain > 1);
  dir('blade arms: heavy melee', vary('arms', 'blade').melee > 1.2);
  dir('precision arms: faster weapon cycling', vary('arms', 'precision').weapon.cooldown < def.weapon.cooldown && vary('arms', 'precision').weapon.reload < def.weapon.reload);
  dir('assault arms: more armor, slower reload', vary('arms', 'assault').hp > def.hp && vary('arms', 'assault').weapon.reload > def.weapon.reload);
  dir('twin sabers: melee-only with a melee bonus', vary('weapon', 'sabers').weapon.kind === 'melee' && vary('weapon', 'sabers').melee > 1.3);
  dir('shield guards, no off-hand is lighter', vary('offhand', 'shield').guard > 0 && vary('offhand', 'none').weight < def.weight && vary('offhand', 'none').guard === 0);
  dir('shoulder cannon grants an ability', !!vary('offhand', 'cannon').ability && vary('offhand', 'cannon').ability.cooldown > 0);
  dir('weapon kinds differ as advertised', vary('weapon', 'mg').weapon.kind === 'bullet' && vary('weapon', 'bazooka').weapon.kind === 'cannon' && !!vary('weapon', 'bazooka').weapon.splash && vary('weapon', 'sniper').weapon.speed > vary('weapon', 'rifle').weapon.speed);

  // weight really is what slows a mech down: the heaviest build is slower than the lightest
  const heavy = P.deriveStats({ ...P.DEFAULT_BUILD, head: 'visor', torso: 'heavy', arms: 'assault', legs: 'tank', backpack: 'booster', weapon: 'bazooka', offhand: 'cannon' });
  const light = P.deriveStats({ ...P.DEFAULT_BUILD, head: 'scout', torso: 'light', arms: 'precision', legs: 'sprint', backpack: 'wing', weapon: 'rifle', offhand: 'none' });
  check('heaviest build is slower than the lightest', heavy.speed < def.speed && light.speed > def.speed && heavy.weight > light.weight && heavy.hp > light.hp, `${heavy.speed.toFixed(1)} vs ${light.speed.toFixed(1)}`);

  // sanitising: bad saved data can never break the game
  const dirty = P.sanitizeBuild({ name: '<script>x</script> mech', head: 'nope', torso: 'heavy', legs: 7, paint: { main: 'red', sub: '#ABCDEF', accent: null }, energy: 'x', thruster: 'green', extra: 1 });
  check('sanitizeBuild repairs invalid data', dirty.head === 'vfin' && dirty.torso === 'heavy' && dirty.legs === 'std' && dirty.paint.main === P.DEFAULT_BUILD.paint.main && dirty.paint.sub === '#abcdef'
    && dirty.energy === 'pink' && dirty.thruster === 'green' && !('extra' in dirty) && /^[A-Z0-9 -]{1,14}$/.test(dirty.name), JSON.stringify(dirty.name));
  check('sanitizeBuild is idempotent and tolerates junk', JSON.stringify(P.sanitizeBuild(dirty)) === JSON.stringify(dirty) && ['x', 5, null, undefined, [], {}].every((j) => P.sanitizeBuild(j).head === 'vfin'));
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const randoms = Array.from({ length: 200 }, () => P.randomBuild(rng));
  check('random builds are always valid', randoms.every((b) => JSON.stringify(P.sanitizeBuild(b)) === JSON.stringify(b) && Number.isFinite(P.deriveStats(b).hp)));
  check('random builds actually vary', new Set(randoms.map((b) => JSON.stringify(b))).size > 150);
  const r = P.statRanges();
  check('stat ranges are sane', Object.values(r).every((v) => v.max > v.min), JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [Math.round(v.min), Math.round(v.max)]]))));
  const d = P.deriveMech(P.DEFAULT_BUILD);
  check('deriveMech yields a full mech def', d.def.hp === d.stats.hp && d.def.spec.palette.main === 0xeceff6 && d.def.spec.head === 'v' && d.def.spec.offhand === 'shield' && d.def.guard > 0);

  // ---- deeper building: shoulders, cores, pilots, sub-weapons
  dir('bulwark shoulders: armor, stagger resist and a little guard', vary('shoulder', 'bulwark').hp > def.hp && vary('shoulder', 'bulwark').guard > def.guard && vary('shoulder', 'bulwark').staggerAt > def.staggerAt);
  dir('spike shoulders: melee bonus', vary('shoulder', 'spike').melee > 1.1);
  dir('vernier shoulders: turning and dashing', vary('shoulder', 'vernier').turn > def.turn && vary('shoulder', 'vernier').dashSpeed > def.dashSpeed && vary('shoulder', 'vernier').dashCost < def.dashCost);
  dir('capacitor core: boost fuel and EN regen', vary('core', 'capacitor').en > def.en && vary('core', 'capacitor').enGround > def.enGround);
  dir('overclock core: longer BURST', vary('core', 'overclock').burstTime === 18 && def.burstTime === 12 && vary('core', 'overclock').burstGain > 1);
  dir('nano-repair core: repairs armor', vary('core', 'regen').regen === 7 && def.regen === 0);
  dir('phase governor: longer dash invulnerability', Math.abs(vary('core', 'phase').dashInvuln - 0.45) < 1e-9 && def.dashInvuln === 0.2);
  dir('recon head: bigger radar', vary('head', 'recon').radar > def.radar && vary('head', 'recon').missileTurn > 0);
  dir('gunner pilot: faster reload and fire rate', vary('pilot', 'gunner').weapon.reload < def.weapon.reload && vary('pilot', 'gunner').weapon.cooldown < def.weapon.cooldown);
  dir('duelist pilot: melee and dash invulnerability', vary('pilot', 'duelist').melee > 1.1 && vary('pilot', 'duelist').dashInvuln > def.dashInvuln);
  dir('engineer pilot: half armor back between waves', def.resupplyHeal === 0.25 && vary('pilot', 'engineer').resupplyHeal === 0.5 && vary('pilot', 'engineer').supply > def.supply);
  dir('evader pilot: cheaper dashes, sharper turning', vary('pilot', 'evader').dashCost < def.dashCost && vary('pilot', 'evader').turn > def.turn && vary('pilot', 'evader').speed > def.speed);
  dir('veteran pilot: harder to stagger', vary('pilot', 'veteran').staggerAt > def.staggerAt && vary('pilot', 'veteran').burstGain > 1);
  dir('sub-weapons are defined', def.sub === null && vary('sub', 'vulcan').sub.kind === 'vulcan' && vary('sub', 'flare').sub.kind === 'flare' && vary('sub', 'repair').sub.kind === 'repair');

  // ---- the expanded catalogue: two to four new parts in every slot
  check('the catalogue has 75 parts across 11 slots', P.SLOTS.length === 11 && P.SLOTS.reduce((n, s) => n + P.PARTS[s].length, 0) === 75);
  check('every part id is unique within its slot and every part has a name, a description and a model', P.SLOTS.every((slot) => new Set(P.PARTS[slot].map((p) => p.id)).size === P.PARTS[slot].length
    && P.PARTS[slot].every((p) => p.name && p.desc.length > 20 && typeof p.model === 'string')));
  dir('ace visor: faster trigger and burst gauge, a little melee', vary('head', 'ace').weapon.cooldown < def.weapon.cooldown && vary('head', 'ace').burstGain > 1 && vary('head', 'ace').melee > 1);
  dir('ECM crown: jams enemy missiles', vary('head', 'jammer').jam === 0.4 && def.jam === 0);
  dir('missile bay chest: an extra missile charge and harder missiles', vary('torso', 'bay').missileCharges === 3 && vary('torso', 'bay').missileDamage > 1);
  dir('command chest: radar, burst gain and wave repair', vary('torso', 'command').radar > def.radar && vary('torso', 'command').burstGain > 1 && vary('torso', 'command').resupplyHeal > def.resupplyHeal);
  dir('guard arms: armor, stagger resistance and guard', vary('arms', 'guard').hp > def.hp && vary('arms', 'guard').staggerAt > def.staggerAt && vary('arms', 'guard').guard > def.guard);
  dir('recoil arms: a harder-hitting but slower gun', vary('arms', 'recoil').weapon.damage > def.weapon.damage && vary('arms', 'recoil').weapon.cooldown > def.weapon.cooldown);
  dir('strider legs: quicker on foot, longer dash', vary('legs', 'strider').speed > def.speed && vary('legs', 'strider').dashSpeed > def.dashSpeed);
  dir('siege legs: big stagger resistance and a steadier gun, but slow', vary('legs', 'siege').staggerAt > def.staggerAt + 100 && vary('legs', 'siege').weapon.reload < def.weapon.reload && vary('legs', 'siege').speed < def.speed);
  dir('missile racks: an extra missile charge and tighter homing', vary('shoulder', 'rack').missileCharges === 3 && vary('shoulder', 'rack').missileTurn > def.missileTurn);
  dir('aegis emitters: 10% more gunfire absorption', Math.abs(vary('shoulder', 'aegis').guard - 0.32) < 1e-9);
  dir('generator pack: more power output, and it draws less than the standard pack', vary('backpack', 'gen').supply === def.supply + 28 && vary('backpack', 'gen').draw < def.draw);
  dir('armor backplate: armor and stagger resistance, a weaker climb', vary('backpack', 'plate').hp > def.hp && vary('backpack', 'plate').staggerAt > def.staggerAt && vary('backpack', 'plate').ascendSpeed < def.ascendSpeed);
  dir('burst siphon: a much faster burst gauge', vary('core', 'siphon').burstGain === 1.5);
  dir('barrier generator: a 240-point barrier', vary('core', 'barrier').barrier === 240 && def.barrier === 0);
  dir('marksman: a harder-hitting gun and a bigger radar', vary('pilot', 'marksman').weapon.damage > def.weapon.damage && vary('pilot', 'marksman').radar > def.radar);
  dir('tactician: harder missiles that track tighter', vary('pilot', 'tactician').missileDamage > 1 && vary('pilot', 'tactician').missileTurn > 0);
  dir('guardian: guard, stagger resistance and wave repair', vary('pilot', 'guardian').guard > def.guard && vary('pilot', 'guardian').staggerAt > def.staggerAt && vary('pilot', 'guardian').resupplyHeal > def.resupplyHeal);
  dir('beam shotgun: seven short-ranged pellets', vary('weapon', 'scatter').weapon.pellets === 7 && vary('weapon', 'scatter').weapon.life < 1);
  dir('seeker rifle: homing beams', vary('weapon', 'seeker').weapon.homing > 1);
  dir('arc lance: a piercing beam', vary('weapon', 'lance').weapon.pierce === true && vary('weapon', 'lance').weapon.damage > vary('weapon', 'sniper').weapon.damage);
  dir('greatsword: melee only, the biggest melee bonus and the longest reach', vary('weapon', 'greatsword').weapon.kind === 'melee' && vary('weapon', 'greatsword').melee > vary('weapon', 'sabers').melee && vary('weapon', 'greatsword').reach > vary('weapon', 'sabers').reach);
  dir('buckler and tower shield: guard, the tower heavier and slower', vary('offhand', 'buckler').guard < def.guard && vary('offhand', 'buckler').guard > 0 && vary('offhand', 'tower').guard > def.guard && vary('offhand', 'tower').weight > def.weight && vary('offhand', 'tower').speed < def.speed);
  dir('micro-missile arm: a swarm ability', vary('offhand', 'swarm').ability.kind === 'swarm' && vary('offhand', 'swarm').ability.count === 6);
  dir('the three new sub-weapons are defined', ['injector', 'pulse', 'field'].every((id) => vary('sub', id).sub?.kind === id));
  const stackedGuard2 = P.deriveStats({ ...P.DEFAULT_BUILD, offhand: 'tower', shoulder: 'aegis', pilot: 'guardian', arms: 'guard' });
  check('guard from every kind of part stacks, up to the cap', P.deriveStats({ ...P.DEFAULT_BUILD, offhand: 'buckler', arms: 'guard' }).guard > 0.15 && stackedGuard2.guard === 0.35);
  check('missile charges are capped at four', P.deriveStats({ ...P.DEFAULT_BUILD, backpack: 'pod', torso: 'bay', shoulder: 'rack' }).missileCharges === 4);
  check('the burst gauge never fills more than twice as fast', P.deriveStats({ ...P.DEFAULT_BUILD, head: 'horn', torso: 'reactor', core: 'siphon', pilot: 'veteran' }).burstGain === 2);
  check('ECM jamming is capped', P.deriveStats({ ...P.DEFAULT_BUILD, head: 'jammer' }).jam <= 0.8);
  check('the firepower bar counts a shotgun by its pellets', vary('weapon', 'scatter').dps > 150 && vary('weapon', 'scatter').dps < 400, `${vary('weapon', 'scatter').dps}`);
  check('every new weapon has a sane firepower rating next to the rifle', ['scatter', 'seeker', 'lance'].every((id) => vary('weapon', id).dps > def.dps * 0.6 && vary('weapon', id).dps < def.dps * 1.3), ['scatter', 'seeker', 'lance'].map((id) => vary('weapon', id).dps).join(' '));

  // ---- budgets: weight against the legs' load limit, power draw against the torso's output
  check('the stock build is inside both budgets', def.overload === 0 && def.loadFactor === 1 && def.powerFactor === 1 && def.draw < def.supply && def.weight < def.load, `${def.weight}/${def.load}, ${def.draw}/${def.supply}`);
  const overloaded = P.deriveStats({ ...P.DEFAULT_BUILD, legs: 'sprint', torso: 'heavy', shoulder: 'bulwark', arms: 'assault', backpack: 'booster' });
  const sameParts = P.deriveStats({ ...P.DEFAULT_BUILD, legs: 'tank', torso: 'heavy', shoulder: 'bulwark', arms: 'assault', backpack: 'booster' });
  check('exceeding the load limit slows the mech down', overloaded.overload > 0 && overloaded.loadFactor < 1 && overloaded.speed < sameParts.speed * 1.2 && overloaded.dashSpeed < P.deriveStats(P.DEFAULT_BUILD).dashSpeed,
    `over by ${overloaded.overload}, factor ${overloaded.loadFactor.toFixed(2)}`);
  const crushed = P.deriveStats({ ...P.DEFAULT_BUILD, legs: 'sprint', torso: 'heavy', shoulder: 'bulwark', arms: 'assault', backpack: 'booster', weapon: 'bazooka', offhand: 'cannon', sub: 'repair', head: 'visor' });
  check('overload never stops the mech: the slowdown has a floor', crushed.loadFactor === 0.55 && crushed.speed > 0);
  const hungryBuild = { ...P.DEFAULT_BUILD, torso: 'light', head: 'recon', arms: 'precision', legs: 'jump', shoulder: 'vernier', backpack: 'booster', core: 'phase', weapon: 'sniper', offhand: 'cannon', sub: 'vulcan' };
  const hungry = P.deriveStats(hungryBuild);
  const fed = P.deriveStats({ ...hungryBuild, torso: 'reactor', shoulder: 'std', offhand: 'none', sub: 'none' }); // same gun and arms, but inside the power budget
  check('a power shortfall slows EN recovery and weapon cycling by the power factor', hungry.draw > hungry.supply && hungry.powerFactor < 1 && fed.powerFactor === 1
    && Math.abs(fed.weapon.cooldown / hungry.weapon.cooldown - hungry.powerFactor) < 0.01 && Math.abs(fed.weapon.reload / hungry.weapon.reload - hungry.powerFactor) < 0.01
    && hungry.enAir < (hungry.enAir / hungry.powerFactor) - 1, `power factor ${hungry.powerFactor.toFixed(2)}`);
  check('a power shortfall has a floor too', hungry.powerFactor >= 0.4 && Number.isFinite(hungry.weapon.cooldown) && P.deriveStats({ ...hungryBuild, torso: 'light', backpack: 'booster', weapon: 'bazooka', offhand: 'cannon' }).powerFactor >= 0.4);
  check('a power shortfall bites harder than the raw shortfall', hungry.powerFactor < hungry.supply / hungry.draw, `${hungry.powerFactor.toFixed(2)} vs ${(hungry.supply / hungry.draw).toFixed(2)}`);
  check('the reactor torso out-supplies the light frame', vary('torso', 'reactor').supply > vary('torso', 'light').supply && vary('torso', 'heavy').supply > def.supply);
  check('tank legs carry the most, sprint legs the least', vary('legs', 'tank').load > vary('legs', 'std').load && vary('legs', 'std').load > vary('legs', 'sprint').load);

  // ---- stacking is capped so no single trick runs away
  const stackedMelee = P.deriveStats({ ...P.DEFAULT_BUILD, weapon: 'sabers', arms: 'blade', shoulder: 'spike', pilot: 'duelist', head: 'horn' });
  check('melee bonuses are soft-capped (raw product would be about x2.5)', stackedMelee.melee > 1.9 && stackedMelee.melee < 2.2, `x${stackedMelee.melee.toFixed(2)}`);
  const stackedGuard = P.deriveStats({ ...P.DEFAULT_BUILD, weapon: 'sabers', offhand: 'shield', shoulder: 'bulwark' });
  check('gunfire absorption is capped at 35%', stackedGuard.guard === 0.35, `${stackedGuard.guard}`);

  // ---- tuning points
  const tune = (t) => P.deriveStats({ ...P.DEFAULT_BUILD, tuning: t });
  check('plating raises armor', tune({ plating: 6 }).hp > def.hp * 1.2 && tune({ plating: 6 }).hp < def.hp * 1.3);
  check('servos raise speed, dash and turning', tune({ servos: 6 }).speed > def.speed * 1.1 && tune({ servos: 6 }).dashSpeed > def.dashSpeed * 1.1 && tune({ servos: 6 }).turn > def.turn);
  check('thrusters raise boost fuel and climb', tune({ thrusters: 6 }).en > def.en * 1.2 && tune({ thrusters: 6 }).ascendSpeed > def.ascendSpeed);
  check('weapons raise damage output', tune({ weapons: 6 }).damage > 1.15 && tune({ weapons: 6 }).dps > def.dps * 1.15);
  const capped = P.cleanTuning({ plating: 99, servos: 99, thrusters: 99, weapons: 99 });
  check('tuning is capped per dial and in total', Object.values(capped).every((v) => v <= P.TUNING_MAX) && P.tuningSpent(capped) === P.TUNING_POOL, JSON.stringify(capped));
  check('tuning survives junk input', JSON.stringify(P.cleanTuning({ plating: 'x', servos: -4, thrusters: 2.6, weapons: null })) === JSON.stringify({ plating: 0, servos: 0, thrusters: 3, weapons: 0 }) && P.tuningSpent(P.cleanTuning(undefined)) === 0);
  check('an older save (before these slots existed) loads with sensible defaults', (() => {
    const old = P.sanitizeBuild({ name: 'OLD ONE', head: 'horn', weapon: 'mg', offhand: 'none' });
    return old.shoulder === 'std' && old.core === 'std' && old.pilot === 'rookie' && old.sub === 'none' && P.tuningSpent(old.tuning) === 0 && old.head === 'horn';
  })());
  const t0 = Date.now();
  const sampled = P.statRanges();
  check('stat ranges are quick to compute and cover load and power', Date.now() - t0 < 2000 && sampled.load.max > sampled.load.min && sampled.draw.max > sampled.supply.min, `${Date.now() - t0} ms`);
}

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

  // ------------------------------------------------------------ garage UI (real clicks)
  const counts = { head: 7, torso: 6, arms: 6, legs: 6, shoulder: 6, backpack: 6, core: 7, pilot: 9, weapon: 9, offhand: 6, sub: 7 };
  await page.click('#btn-garage');
  const opened = await page.evaluate(() => ({ state: window.__game.state, shown: !document.getElementById('screen-garage').classList.contains('hidden'), titleHidden: document.getElementById('screen-title').classList.contains('hidden') }));
  check('GARAGE button opens the garage', opened.state === 'garage' && opened.shown && opened.titleHidden);
  check('garage has a tab for each of the 11 slots, tuning and paint', (await page.$$('.g-tab')).length === 13);

  const tabIds = Object.keys(counts);
  const optionCounts = {};
  for (const id of tabIds) {
    await page.click(`.g-tab[data-tab="${id}"]`);
    optionCounts[id] = (await page.$$('.opt')).length;
  }
  check('every slot lists all its parts', tabIds.every((id) => optionCounts[id] === counts[id]), JSON.stringify(optionCounts));

  // equip a part by clicking it: the build, stats and live model all change
  await page.click('.g-tab[data-tab="torso"]');
  const armorText = () => page.$eval('#g-stats .stat:nth-child(1) .s-head b', (e) => e.firstChild.textContent);
  const armorBefore = Number(await armorText());
  await page.click('.opt[data-id="heavy"]');
  const eq = await page.evaluate(() => {
    const g = window.__game;
    return { torso: g.player.build.torso, spec: g.player.mech.def.spec.torso, hp: g.player.mech.maxHp, statHp: g.player.stats.hp,
      selected: document.querySelector('.opt.selected')?.dataset.id, tag: document.querySelector('.opt.selected .o-tag')?.textContent,
      stored: JSON.parse(localStorage.getItem('steel-vanguard.build') || '{}').torso };
  });
  const armorAfter = Number(await armorText());
  check('clicking a part equips it and rebuilds the mech', eq.torso === 'heavy' && eq.spec === 'heavy' && eq.hp === eq.statHp && eq.hp > 2600 && eq.selected === 'heavy' && eq.tag === 'EQUIPPED', JSON.stringify(eq));
  check('stat bars update with the build', armorAfter > armorBefore, `${armorBefore} -> ${armorAfter}`);
  check('the build is saved on every change', eq.stored === 'heavy');

  // hovering previews without equipping
  await page.hover('.opt[data-id="light"]');
  const hover = await page.evaluate(() => ({ build: window.__game.player.build.torso, delta: document.querySelector('#g-stats .stat:nth-child(1) .d')?.textContent, text: document.querySelector('#g-stats .stat:nth-child(1) .s-head b').firstChild.textContent }));
  check('hover previews a part without equipping it', hover.build === 'heavy' && /−/.test(hover.delta) && Number(hover.text) < armorAfter, JSON.stringify(hover));
  await page.mouse.move(700, 120);
  await page.waitForTimeout(100);
  const unhover = await page.evaluate(() => document.querySelector('#g-stats .stat:nth-child(1) .d')?.textContent);
  check('moving off a part clears the preview', unhover === '');

  // paint
  await page.click('.g-tab[data-tab="paint"]');
  check('paint tab offers schemes, colour pickers and swatches', (await page.$$('.preset')).length === 6 && (await page.$$('input[type=color]')).length === 4 && (await page.$$('.swatch')).length === 11);
  await page.click('.preset:nth-child(2)'); // CRIMSON
  const paint = await page.evaluate(() => {
    const g = window.__game;
    return { main: g.player.build.paint.main, mat: g.player.mech.model.flashMats[0].color.getHex() };
  });
  check('a paint scheme recolours the model', paint.main === '#c0282f' && paint.mat === 0xc0282f, JSON.stringify(paint));
  await page.evaluate(() => {
    const i = document.querySelectorAll('input[type=color]')[1];
    i.value = '#00ff00';
    i.dispatchEvent(new Event('input'));
  });
  // the picker applies on the next animation frame (drag events are coalesced), so wait for it
  await page.waitForFunction(() => window.__game.player.build.paint.sub === '#00ff00', null, { timeout: 10000 }).catch(() => {});
  const custom = await page.evaluate(() => ({ sub: window.__game.player.build.paint.sub, mat: window.__game.player.mech.model.flashMats[1].color.getHex() }));
  check('a custom colour applies live', custom.sub === '#00ff00' && custom.mat === 0x00ff00, JSON.stringify(custom));
  await page.click('.swatch:nth-of-type(3)');
  check('energy and thruster swatches change the build', (await page.evaluate(() => window.__game.player.build.energy)) === 'green');

  // tuning points
  await page.click('.g-tab[data-tab="tuning"]');
  const left = () => page.$eval('.tune-left', (e) => e.textContent);
  check('tuning starts with the full pool of 12 points', /^12 OF 12/.test(await left()));
  const armorNow = Number(await armorText());
  await page.click('.tune-btn[data-dial="plating"][data-dir="1"]');
  await page.click('.tune-btn[data-dial="plating"][data-dir="1"]');
  const tuned = await page.evaluate(() => ({ plating: window.__game.player.build.tuning.plating, hp: window.__game.player.mech.maxHp, pips: document.querySelectorAll('.tune-row:nth-of-type(1) .tune-pips i.on').length }));
  check('+ spends tuning points and the stats follow', tuned.plating === 2 && /^10 OF 12/.test(await left()) && Number(await armorText()) > armorNow && tuned.hp === Number(await armorText()), JSON.stringify(tuned));
  check('the minus button is disabled at zero', await page.$eval('.tune-btn[data-dial="servos"][data-dir="-1"]', (b) => b.disabled));
  for (let i = 0; i < 6; i++) await page.click('.tune-btn[data-dial="servos"][data-dir="1"]:not([disabled])').catch(() => {});
  for (let i = 0; i < 6; i++) await page.click('.tune-btn[data-dial="thrusters"][data-dir="1"]:not([disabled])').catch(() => {});
  const spentAll = await page.evaluate(() => Object.values(window.__game.player.build.tuning).reduce((a, b) => a + b, 0));
  check('the pool cannot be overspent and the plus buttons lock', spentAll === 12 && /^0 OF 12/.test(await left()) && await page.$eval('.tune-btn[data-dial="weapons"][data-dir="1"]', (b) => b.disabled), `spent ${spentAll}`);
  await page.click('.tune-btn[data-dial="servos"][data-dir="-1"]');
  check('refunding a point frees the plus buttons', /^1 OF 12/.test(await left()));

  // budgets are shown with warnings
  await page.evaluate(() => {
    const g = window.__garage;
    g.commit({ ...g.build, torso: 'heavy', legs: 'sprint', shoulder: 'bulwark', arms: 'assault', backpack: 'booster', weapon: 'bazooka', offhand: 'cannon', sub: 'repair', head: 'visor' });
    g.tab = 'weapon'; g._renderOptions(); g._renderStats();
  });
  await page.mouse.move(720, 120);
  const warned = await page.evaluate(() => ({ warns: [...document.querySelectorAll('.g-summary .warn')].map((e) => e.textContent), loadOver: document.querySelector('#g-stats .stat:nth-child(7) .s-bar i').classList.contains('over'),
    loadText: document.querySelector('#g-stats .stat:nth-child(7) .s-head b').firstChild.textContent, powerText: document.querySelector('#g-stats .stat:nth-child(8) .s-head b').firstChild.textContent }));
  check('the LOAD bar and summary flag an overloaded build', warned.loadOver && warned.warns.some((w) => /OVERLOADED/.test(w)) && /\d+ \/ 100/.test(warned.loadText), JSON.stringify(warned));
  await page.click('#g-reset');
  const clean = await page.evaluate(() => ({ warns: document.querySelectorAll('.g-summary .warn').length, over: document.querySelector('#g-stats .stat:nth-child(7) .s-bar i').classList.contains('over') }));
  check('the stock build shows no warnings', clean.warns === 0 && !clean.over, JSON.stringify(clean));

  // name, pose, randomise, reset
  await page.fill('#g-name', 'tank-01 <b>!!');
  await page.keyboard.press('Enter');
  check('callsign is sanitised', (await page.evaluate(() => window.__game.player.build.name)) === 'TANK-01 B');
  await page.click('.pose[data-pose="boost"]');
  check('preview pose can be switched', (await page.evaluate(() => window.__game.garagePose)) === 'boost');
  await page.click('.pose[data-pose="idle"]');
  const rand1 = await page.evaluate(() => { document.getElementById('g-random').click(); return JSON.stringify(window.__game.player.build); });
  const rand2 = await page.evaluate(() => { document.getElementById('g-random').click(); return JSON.stringify(window.__game.player.build); });
  check('RANDOMIZE produces different valid builds', rand1 !== rand2);
  await page.click('#g-reset');
  const reset = await page.evaluate(() => { const b = window.__game.player.build; return { head: b.head, torso: b.torso, weapon: b.weapon, name: b.name }; });
  check('RESET restores the stock Vanguard build', reset.head === 'vfin' && reset.torso === 'std' && reset.weapon === 'rifle' && reset.name === 'AEGIS-01');

  // persistence across a reload, and the title screen reflects it
  await page.click('.g-tab[data-tab="weapon"]');
  await page.click('.opt[data-id="sniper"]');
  await page.fill('#g-name', 'longshot');
  await page.keyboard.press('Enter');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__garage);
  const persisted = await page.evaluate(() => ({ weapon: window.__game.player.build.weapon, name: window.__game.player.build.name, title: document.getElementById('title-build').textContent,
    hudName: window.__game.player.weapon.name }));
  check('the saved build is restored after a reload', persisted.weapon === 'sniper' && persisted.name === 'LONGSHOT' && /LONGSHOT/.test(persisted.title) && persisted.hudName === 'BEAM SNIPER', JSON.stringify(persisted));

  // navigation: Esc goes back, SORTIE from the garage launches with the build
  await page.click('#btn-garage');
  await page.keyboard.press('Escape');
  const back = await page.evaluate(() => ({ state: window.__game.state, title: !document.getElementById('screen-title').classList.contains('hidden'), garage: document.getElementById('screen-garage').classList.contains('hidden') }));
  check('Esc leaves the garage for the title screen', back.state === 'title' && back.title && back.garage);
  await page.click('#btn-garage');
  await page.click('#g-go');
  await page.waitForTimeout(200);
  const launched = await page.evaluate(() => ({ state: window.__game.state, name: document.getElementById('mech-name').textContent, weapon: document.getElementById('weapon-name').textContent, garage: document.getElementById('screen-garage').classList.contains('hidden') }));
  check('SORTIE from the garage launches with the built mech', launched.state === 'playing' && launched.name === 'LONGSHOT' && launched.weapon === 'BEAM SNIPER' && launched.garage, JSON.stringify(launched));
  // return to the stock build for the rest of the suite
  await page.evaluate(() => { window.__game.toTitle(); window.__garage.commit({ ...window.__garage.build, name: 'AEGIS-01', weapon: 'rifle' }); document.getElementById('screen-title').classList.remove('hidden'); });

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

  // ------------------------------------------------------------ 5b. custom loadouts change how the mech fights
  const loadouts = await page.evaluate(async () => {
    const g = window.__game, T = window.__t;
    const P = await import('/src/parts.js');
    const { createEnemy } = await import('/src/ai.js');
    const out = {};
    const fresh = (patch) => {
      g.cheat.invincible = true;
      g.setBuild({ ...P.DEFAULT_BUILD, paint: { ...P.DEFAULT_BUILD.paint }, ...patch });
      g.startMission();
      g.manual = true;
      g.missions.state = 'idle'; // no waves: we place our own dummies
      g.hud.reset();
      g.player.mech.place(0, 0, 0, 0);
      g.rig.reset(0);
    };
    const dummy = (x, z) => {
      const e = createEnemy(g, 'bulwark', 1);
      e.mech.place(x, z, 0, 0);
      e.think = () => ({ faceYaw: 0 });
      e.def_dodge = 0;
      e.mech.hp = e.mech.maxHp = 100000;
      g.enemies.push(e);
      return e;
    };
    const dealt = (e) => e.mech.maxHp - e.mech.hp;
    const playerShots = () => g.projectiles.list.filter((p) => p.team === 'player');

    // --- each gun fires its own kind of projectile
    out.guns = {};
    for (const wid of ['rifle', 'mg', 'bazooka', 'sniper']) {
      fresh({ weapon: wid });
      const d = dummy(0, -80);
      g.step(3);
      const kinds = new Set(), speeds = new Set();
      let ammoMin = g.player.ammo;
      T.keys(['Mouse0']);
      for (let i = 0; i < 100; i++) {
        g.step(1);
        for (const p of playerShots()) { kinds.add(p.type); speeds.add(Math.round(p.speed)); }
        ammoMin = Math.min(ammoMin, g.player.ammo);
      }
      T.keys([], ['Mouse0']);
      g.step(120); // let the last shots land
      out.guns[wid] = { kinds: [...kinds], speeds: [...speeds], dealt: dealt(d), mag: g.player.magSize, ammoMin, name: g.player.weapon.name };
    }

    // --- bazooka shells explode: a bystander next to the target takes splash damage
    fresh({ weapon: 'bazooka' });
    const a = dummy(0, -80);
    const b = dummy(14, -80);
    g.step(3);
    T.keys(['Mouse0']); g.step(2); T.keys([], ['Mouse0']);
    g.step(120);
    out.splash = { target: dealt(a), bystander: dealt(b) };

    // --- rapid gun: big magazine drains, then reloads
    fresh({ weapon: 'mg' });
    g.step(3);
    out.mgMag = g.player.ammo;
    g.player.ammo = 1; g.player.fireCd = 0;
    T.keys(['Mouse0']); g.step(12); T.keys([], ['Mouse0']);
    out.mgReload = { reloading: g.player.reloadT > 0, ammo: g.player.ammo };
    g.step(60 * 3);
    out.mgReloaded = g.player.ammo;

    // --- twin sabers: no gun, left mouse swings the blade
    fresh({ weapon: 'sabers' });
    const s = dummy(0, -26);
    g.step(3);
    let swung = false, stages = new Set();
    // tap, then tap again during each swing so the combo chains: stage 0 -> 1 -> 2
    for (const wait of [15, 30, 45]) {
      T.tap('Mouse0');
      for (let i = 0; i < wait; i++) { g.step(1); if (g.player.melee) { swung = true; stages.add(g.player.melee.stage); } }
    }
    g.step(60);
    out.sabers = {
      swung, dealt: dealt(s), noProjectiles: playerShots().every((p) => p.type === 'missile'), stages: [...stages],
      meleeOnly: g.player.meleeOnly, gunRowShown: document.getElementById('ammo-pips').style.display !== 'none',
      key: document.getElementById('weapon-key').textContent, saberRowHidden: document.getElementById('saber-row').style.display === 'none',
    };
    // the same build deals more melee damage than the stock one
    fresh({});
    const s2 = dummy(0, -26);
    g.step(3);
    T.tap('Mouse2'); g.step(40);
    const stockHit = dealt(s2);
    fresh({ weapon: 'sabers' });
    const s3 = dummy(0, -26);
    g.step(3);
    T.tap('Mouse2'); g.step(40);
    out.meleeBonus = { stock: stockHit, sabers: dealt(s3) };

    // --- shoulder cannon (F): fires once, then cools down
    fresh({ offhand: 'cannon' });
    const c = dummy(0, -90);
    g.step(3);
    out.cannonRowShown = document.getElementById('cannon-row').style.display !== 'none';
    T.tap('KeyF');
    g.step(4);
    out.cannon = { shells: playerShots().filter((p) => p.type === 'cannon').length, cd: g.player.cannonCd };
    T.tap('KeyF'); g.step(3);
    out.cannonSecond = playerShots().filter((p) => p.type === 'cannon').length; // still just the one
    g.step(120);
    out.cannonDealt = dealt(c);
    fresh({ offhand: 'shield' });
    out.noCannonRow = document.getElementById('cannon-row').style.display === 'none';

    // --- shield guard soaks gunfire but not saber hits
    const hitFor = (offhand, kind) => {
      fresh({ offhand });
      g.cheat.invincible = false;
      const m = g.player.mech;
      m.invuln = 0;
      const before = m.hp;
      m.takeDamage(100, { kind });
      return before - m.hp;
    };
    out.guard = { shieldBullet: hitFor('shield', 'bullet'), shieldSaber: hitFor('shield', 'saber'), noneBullet: hitFor('none', 'bullet') };
    g.cheat.invincible = true;

    // --- missile pod: three charges, harder hits; scout head: tighter homing
    fresh({ backpack: 'pod', head: 'scout' });
    dummy(0, -120);
    g.step(3);
    out.pod = { charges: g.player.missiles, pips: document.getElementById('missile-pips').children.length };
    T.tap('KeyE'); g.step(26);
    const missile = g.projectiles.list.find((p) => p.type === 'missile');
    out.podMissile = missile ? { damage: missile.damage, turn: missile.turn } : null;
    fresh({});
    out.stockMissile = (() => { dummy(0, -120); g.step(3); T.tap('KeyE'); g.step(26); const m2 = g.projectiles.list.find((p) => p.type === 'missile'); return m2 ? { damage: m2.damage, turn: m2.turn } : null; })();

    // --- build stats reach the mech: armor, boost fuel and dash cost
    fresh({ torso: 'heavy', legs: 'tank', backpack: 'booster' });
    const m1 = g.player.mech;
    out.heavyMech = { hp: m1.maxHp, en: m1.maxEn, speed: m1.def.speed, stagger: m1.def.staggerAt };
    fresh({ backpack: 'wing' });
    out.wingMech = { dashCost: g.player.mech.def.dashCost, dashSpeed: g.player.mech.def.dashSpeed };

    // --- weight is felt on the ground: a light sprinter outruns a heavy tank over the same time
    const sprintDistance = (patch) => {
      fresh(patch);
      g.rig.yaw = 0;
      g.step(10);
      const z0 = g.player.mech.pos.z;
      T.keys(['KeyW']); g.step(90); T.keys([], ['KeyW']);
      return z0 - g.player.mech.pos.z;
    };
    out.run = {
      sprinter: sprintDistance({ torso: 'light', legs: 'sprint', backpack: 'wing', offhand: 'none', head: 'scout' }),
      tank: sprintDistance({ torso: 'heavy', legs: 'tank', backpack: 'booster', offhand: 'cannon', head: 'visor', weapon: 'bazooka' }),
    };
    return out;
  });
  dump('loadouts', loadouts);
  const G = loadouts.guns;
  check('beam rifle fires beams', G.rifle.kinds.includes('beam') && G.rifle.dealt > 300, `${G.rifle.dealt} dmg`);
  check('rapid gun fires a stream of light bullets', G.mg.kinds.includes('bullet') && G.mg.dealt > 300 && G.mg.mag === 30 && G.mg.ammoMin < 24, `${G.mg.dealt} dmg, ammo down to ${G.mg.ammoMin}`);
  check('bazooka lobs slow explosive shells', G.bazooka.kinds.includes('cannon') && G.bazooka.speeds.every((v) => v === 300) && G.bazooka.dealt > 400 && G.bazooka.ammoMin >= 0, `${G.bazooka.dealt} dmg`);
  check('sniper fires very fast heavy beams', G.sniper.kinds.includes('beam') && G.sniper.speeds.some((v) => v >= 1300) && G.sniper.dealt > 400, `${G.sniper.dealt} dmg`);
  check('bazooka splash hurts bystanders', loadouts.splash.target > 500 && loadouts.splash.bystander > 150, `target ${Math.round(loadouts.splash.target)}, bystander ${Math.round(loadouts.splash.bystander)}`);
  check('rapid gun reloads its big magazine', loadouts.mgMag === 30 && loadouts.mgReload.reloading && loadouts.mgReloaded === 30);
  check('twin sabers: LMB swings a 3-stage combo and there is no gun', loadouts.sabers.swung && loadouts.sabers.stages.length === 3 && loadouts.sabers.dealt > 500 && loadouts.sabers.noProjectiles && loadouts.sabers.meleeOnly, JSON.stringify(loadouts.sabers.stages));
  check('twin sabers HUD hides the ammo row and shows LMB / RMB', !loadouts.sabers.gunRowShown && loadouts.sabers.key === 'LMB / RMB' && loadouts.sabers.saberRowHidden);
  check('twin sabers hit harder than the stock saber', loadouts.meleeBonus.sabers > loadouts.meleeBonus.stock * 1.2, `${Math.round(loadouts.meleeBonus.sabers)} vs ${Math.round(loadouts.meleeBonus.stock)}`);
  check('shoulder cannon: F fires one shell then cools down', loadouts.cannonRowShown && loadouts.cannon.shells === 1 && loadouts.cannon.cd > 6 && loadouts.cannonSecond === 1 && loadouts.cannonDealt > 300 && loadouts.noCannonRow, JSON.stringify(loadouts.cannon));
  check('shield absorbs gunfire but not saber hits', Math.abs(loadouts.guard.shieldBullet - 78) < 1 && loadouts.guard.shieldSaber === 100 && loadouts.guard.noneBullet === 100, JSON.stringify(loadouts.guard));
  check('missile pod adds a charge and hits harder; scout head homes tighter',
    loadouts.pod.charges === 3 && loadouts.pod.pips === 3 && loadouts.podMissile && loadouts.stockMissile && loadouts.podMissile.damage > loadouts.stockMissile.damage * 1.2 && loadouts.podMissile.turn > loadouts.stockMissile.turn,
    JSON.stringify([loadouts.podMissile, loadouts.stockMissile]));
  check('build stats reach the mech (armor, boost fuel, stagger)', loadouts.heavyMech.hp >= 3000 && loadouts.heavyMech.en > 140 && loadouts.heavyMech.stagger > 300, JSON.stringify(loadouts.heavyMech));
  check('wing pack makes dashes cheaper and faster', loadouts.wingMech.dashCost < 22 && loadouts.wingMech.dashSpeed > 230, JSON.stringify(loadouts.wingMech));
  check('a light sprinter outruns a heavy tank', loadouts.run.sprinter > loadouts.run.tank * 1.25, `${loadouts.run.sprinter.toFixed(1)} vs ${loadouts.run.tank.toFixed(1)}`);

  // random builds: field 25 of them through a short, busy fight each; nothing may throw or go non-finite
  const smoke = await page.evaluate(async () => {
    const g = window.__game, T = window.__t;
    const P = await import('/src/parts.js');
    const { createEnemy } = await import('/src/ai.js');
    let bad = 0, shots = 0, rendered = 0;
    for (let n = 0; n < 25; n++) {
      g.cheat.invincible = true;
      g.setBuild(P.randomBuild());
      g.startMission();
      g.manual = true;
      g.missions.state = 'idle';
      for (const type of ['drone', 'striker']) {
        const e = createEnemy(g, type, 1);
        e.mech.place((type === 'drone' ? 1 : -1) * 40, -70, 0, 0);
        g.enemies.push(e);
      }
      for (let i = 0; i < 150; i++) {
        T.pilot({ lastDash: -1 });
        if (i % 40 === 0) { T.tap('KeyF'); T.tap('Mouse0'); T.tap('KeyV'); }
        if (i % 40 === 5) T.keys(['KeyV']);
        if (i % 40 === 25) T.keys([], ['KeyV']);
        g.step(1);
        if (!T.allFinite()) { bad++; break; }
        shots += g.projectiles.list.filter((p) => p.team === 'player').length ? 1 : 0;
      }
      g.render();
      rendered++;
    }
    T.keys([], ['Mouse0', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'Mouse2']);
    return { bad, rendered, shots };
  });
  check('25 random builds fight and render without errors', smoke.bad === 0 && smoke.rendered === 25, JSON.stringify(smoke));

  // ------------------------------------------------------------ 5c. deeper building: sub-weapons, cores, pilots, budgets in combat
  const systems = await page.evaluate(async () => {
    const g = window.__game, T = window.__t;
    const P = await import('/src/parts.js');
    const { createEnemy } = await import('/src/ai.js');
    const THREE = await import('three');
    const out = {};
    const fresh = (patch) => {
      g.cheat.invincible = true;
      g.setBuild({ ...P.DEFAULT_BUILD, paint: { ...P.DEFAULT_BUILD.paint }, tuning: { ...P.DEFAULT_BUILD.tuning }, ...patch });
      g.startMission();
      g.manual = true;
      g.missions.state = 'idle';
      g.hud.reset();
      g.player.mech.place(0, 0, 0, 0);
      g.rig.reset(0);
    };
    const dummy = (x, z) => {
      const e = createEnemy(g, 'bulwark', 1);
      e.mech.place(x, z, 0, 0);
      e.think = () => ({ faceYaw: 0 });
      e.def_dodge = 0;
      e.mech.hp = e.mech.maxHp = 100000;
      g.enemies.push(e);
      return e;
    };
    const hostileMissile = (from, speed = 120) => {
      const m = g.player.mech;
      return g.projectiles.spawn({ type: 'missile', team: 'enemy', source: null, pos: new THREE.Vector3(from.x, from.y, from.z),
        dir: new THREE.Vector3(m.pos.x - from.x, m.center().y - from.y, m.pos.z - from.z).normalize(), damage: 300, speed, maxSpeed: speed, turn: 2.5, target: m, life: 6, color: 0xff6040 });
    };

    // --- head vulcans: stream of bullets, heat, lockout, cooling
    fresh({ sub: 'vulcan' });
    const d = dummy(0, -80);
    g.step(3);
    out.subRowShown = document.getElementById('sub-row').style.display !== 'none' && document.getElementById('sub-name').textContent === 'HEAD VULCANS';
    const seen = { intercept: false, bullets: 0 };
    T.keys(['KeyV']);
    let maxHeat = 0, lockedAt = -1;
    for (let i = 0; i < 400; i++) {
      g.step(1);
      for (const p of g.projectiles.list) if (p.team === 'player' && p.type === 'bullet' && p.intercept) { seen.intercept = true; }
      maxHeat = Math.max(maxHeat, g.player.subHeat);
      if (g.player.subLocked && lockedAt < 0) lockedAt = i;
    }
    T.keys([], ['KeyV']);
    out.vulcan = { dealt: d.mech.maxHp - d.mech.hp, intercept: seen.intercept, maxHeat, lockedAt, lockedNow: g.player.subLocked,
      barWhileHot: document.getElementById('sub-fill').style.width, state: document.getElementById('sub-state').textContent };
    g.step(60 * 3);
    out.vulcanCooled = { heat: g.player.subHeat, locked: g.player.subLocked };

    // --- vulcans shoot down incoming missiles
    fresh({ sub: 'vulcan' });
    dummy(0, -80);
    g.step(3);
    const hp0 = g.player.mech.hp;
    g.cheat.invincible = false;
    const m1 = hostileMissile({ x: 0, y: 14, z: -70 }, 110);
    T.keys(['KeyV']);
    let missileGone = false;
    for (let i = 0; i < 90; i++) {
      g.step(1);
      if (m1.dead || !g.projectiles.list.includes(m1)) { missileGone = true; break; }
    }
    T.keys([], ['KeyV']);
    g.step(10);
    out.intercept = { gone: missileGone, hpLost: hp0 - g.player.mech.hp };
    g.cheat.invincible = true;

    // --- decoy flares: every missile homing on us detonates; then a cooldown
    fresh({ sub: 'flare' });
    g.step(3);
    g.cheat.invincible = false;
    hostileMissile({ x: 0, y: 30, z: -140 }, 90);
    hostileMissile({ x: 40, y: 30, z: -140 }, 90);
    g.step(10);
    const before = g.projectiles.list.filter((p) => p.type === 'missile' && !p.dead).length;
    T.tap('KeyV');
    g.step(3);
    const after = g.projectiles.list.filter((p) => p.type === 'missile' && !p.dead).length;
    const cd = g.player.subCd;
    const f3 = hostileMissile({ x: 0, y: 30, z: -140 }, 90);
    T.tap('KeyV');
    g.step(3);
    out.flare = { before, after, cd, secondIgnored: !f3.dead && g.projectiles.list.includes(f3), hp: g.player.mech.hp === g.player.mech.maxHp };
    g.cheat.invincible = true;

    // --- repair kit: heals over time, one use per wave, restocked by the resupply
    fresh({ sub: 'repair' });
    g.step(3);
    const rm = g.player.mech;
    g.cheat.invincible = false;
    rm.invuln = 0;
    rm.takeDamage(1400, { kind: 'beam' });
    const hurt = rm.hp;
    T.tap('KeyV');
    g.step(30);
    const midHeal = rm.hp - hurt;
    g.step(60 * 4);
    const healed = rm.hp - hurt;
    const charges = g.player.repairCharges;
    const afterFirst = rm.hp;
    rm.invuln = 0;
    rm.takeDamage(200, { kind: 'beam' });
    const hurtAgain = rm.hp;
    T.tap('KeyV'); g.step(90);
    out.repair = { hurt, midHeal, healed, expected: rm.maxHp * 0.15, charges, secondUse: rm.hp - hurtAgain, afterFirst };
    g.player.resupply(0.25);
    out.repairRestocked = g.player.repairCharges;
    g.cheat.invincible = true;

    // --- nano-repair core: mends armor in a lull, and a hit interrupts it
    fresh({ core: 'regen' });
    g.step(3);
    const nm = g.player.mech;
    g.cheat.invincible = false;
    nm.invuln = 0;
    nm.takeDamage(1000, { kind: 'beam' });
    const n0 = nm.hp;
    g.step(60 * 2);
    const during = nm.hp - n0; // still inside the 3 s grace period
    g.step(60 * 4);
    const after4 = nm.hp - n0;
    nm.invuln = 0;
    nm.takeDamage(50, { kind: 'beam' });
    const n1 = nm.hp;
    g.step(60 * 2);
    out.regen = { during, after: after4, interrupted: nm.hp - n1 };
    g.cheat.invincible = true;
    fresh({});
    g.step(60 * 6);
    out.noRegen = g.player.mech.hp === g.player.mech.maxHp;

    // --- overclock burst length, phase governor invulnerability, recon radar, overload speed, power fire rate
    fresh({ core: 'overclock' });
    g.player.burst = 100;
    T.tap('KeyX'); g.step(2);
    out.burstTime = g.player.burstT;
    fresh({});
    g.player.burst = 100;
    T.tap('KeyX'); g.step(2);
    out.burstTimeStock = g.player.burstT;
    fresh({ core: 'phase' });
    g.step(30);
    T.keys(['KeyW']); T.tap('ShiftLeft'); g.step(2); T.keys([], ['KeyW']);
    out.phaseInvuln = g.player.mech.invuln;
    fresh({});
    g.step(30);
    T.keys(['KeyW']); T.tap('ShiftLeft'); g.step(2); T.keys([], ['KeyW']);
    out.stockInvuln = g.player.mech.invuln;
    fresh({ head: 'recon' });
    out.radar = g.player.stats.radar;

    // overload: the same parts, one set of legs over its limit and one inside it
    const runDistance = (patch) => {
      fresh(patch);
      g.rig.yaw = 0; g.step(10);
      const z0 = g.player.mech.pos.z;
      T.keys(['KeyW']); g.step(90); T.keys([], ['KeyW']);
      return z0 - g.player.mech.pos.z;
    };
    const heavyParts = { torso: 'heavy', shoulder: 'bulwark', arms: 'assault', backpack: 'booster', weapon: 'bazooka', offhand: 'cannon' };
    out.overloadRun = { over: runDistance({ ...heavyParts, legs: 'sprint' }), ok: runDistance({ ...heavyParts, legs: 'sprint', torso: 'std', shoulder: 'std', arms: 'std', backpack: 'std', weapon: 'rifle', offhand: 'none' }) };
    out.overloadStat = (() => { fresh({ ...heavyParts, legs: 'sprint' }); return g.player.stats.overload; })();

    // power shortfall: a power-starved build fires the same gun measurably slower
    const shotsFired = (patch) => {
      fresh({ weapon: 'rifle', ...patch });
      dummy(0, -90);
      g.step(3);
      let shots = 0, last = g.player.ammo;
      T.keys(['Mouse0']);
      for (let i = 0; i < 70; i++) { g.step(1); if (g.player.ammo < last) shots++; last = g.player.ammo; if (g.player.reloadT > 0) break; }
      T.keys([], ['Mouse0']);
      return { shots, cd: g.player.weapon.cooldown, pf: g.player.stats.powerFactor };
    };
    // ...and the shoulder cannon recharges slower too (the same cannon, with and without a power shortfall)
    const cannonRecovery = (patch) => {
      fresh({ offhand: 'cannon', ...patch });
      dummy(0, -90);
      g.step(3);
      T.tap('KeyF'); g.step(2);
      const c0 = g.player.cannonCd;
      g.step(60);
      return { drop: c0 - g.player.cannonCd, pf: g.player.stats.powerFactor };
    };
    out.cannonRecovery = {
      starved: cannonRecovery({ torso: 'light', head: 'recon', arms: 'precision', legs: 'jump', shoulder: 'vernier', backpack: 'booster', core: 'phase', weapon: 'sniper' }),
      ok: cannonRecovery({}),
    };
    out.fireRate = { starved: shotsFired({ torso: 'light', head: 'recon', arms: 'precision', legs: 'jump', shoulder: 'vernier', backpack: 'booster', core: 'phase', offhand: 'cannon', sub: 'vulcan' }), ok: shotsFired({}) };

    // --- tuning: weapons dial raises shot damage, plating raises armor in the real mech
    const shotDamage = (tuning) => {
      fresh({ tuning });
      dummy(0, -90);
      g.step(3);
      T.tap('Mouse0'); T.keys(['Mouse0']); g.step(2); T.keys([], ['Mouse0']);
      const p = g.projectiles.list.find((q) => q.team === 'player' && q.type === 'beam');
      return p ? p.damage : 0;
    };
    out.tuneDamage = { stock: shotDamage({ plating: 0, servos: 0, thrusters: 0, weapons: 0 }), tuned: shotDamage({ plating: 0, servos: 0, thrusters: 0, weapons: 6 }) };
    fresh({ tuning: { plating: 6, servos: 0, thrusters: 6, weapons: 0 } });
    out.tuneMech = { hp: g.player.mech.maxHp, en: g.player.mech.maxEn };
    fresh({});
    out.stockMech = { hp: g.player.mech.maxHp, en: g.player.mech.maxEn };

    // --- shoulder shells stack with the shield (capped), and the engineer's resupply is bigger
    fresh({ shoulder: 'bulwark', offhand: 'shield' });
    g.cheat.invincible = false;
    g.player.mech.invuln = 0;
    const gh = g.player.mech.hp;
    g.player.mech.takeDamage(100, { kind: 'bullet' });
    out.guardStack = gh - g.player.mech.hp;
    g.cheat.invincible = true;

    const waveHeal = (pilot) => {
      fresh({ pilot });
      g.cheat.invincible = false;
      const m = g.player.mech;
      m.invuln = 0;
      m.takeDamage(m.maxHp * 0.8, { kind: 'beam' });
      const low = m.hp;
      g.missions.state = 'combat';
      g.enemies.length = 0;
      g.missions.update(0.01); // no hostiles left: the wave is cleared and the resupply runs
      g.cheat.invincible = true;
      return (m.hp - low) / m.maxHp;
    };
    out.resupply = { rookie: waveHeal('rookie'), engineer: waveHeal('engineer') };
    fresh({});
    return out;
  });
  dump('systems', systems);
  const V = systems.vulcan;
  check('head vulcans fire point-defence bullets and do damage', systems.subRowShown && V.intercept && V.dealt > 300, `${Math.round(V.dealt)} dmg`);
  check('vulcans overheat, lock out, then cool down and work again', V.maxHeat >= 1 && V.lockedAt > 0 && systems.vulcanCooled.heat < 0.05 && !systems.vulcanCooled.locked, JSON.stringify([V.maxHeat, V.lockedAt, systems.vulcanCooled]));
  check('the HUD shows the vulcan heat bar', /%/.test(V.barWhileHot) && ['HEAT', 'OVERHEATED', 'READY'].includes(V.state), `${V.barWhileHot} ${V.state}`);
  check('vulcans shoot down an incoming missile before it hits', systems.intercept.gone && systems.intercept.hpLost === 0, JSON.stringify(systems.intercept));
  check('decoy flares detonate every missile on you, then recharge', systems.flare.before === 2 && systems.flare.after === 0 && systems.flare.cd > 11 && systems.flare.secondIgnored && systems.flare.hp, JSON.stringify(systems.flare));
  const R = systems.repair;
  check('repair kit heals 15% over a few seconds', R.midHeal > 0 && R.midHeal < R.expected * 0.6 && Math.abs(R.healed - R.expected) < R.expected * 0.06, `${Math.round(R.healed)} of ${Math.round(R.expected)}`);
  check('repair kit is one use per wave, and the resupply restocks it', R.charges === 0 && R.secondUse <= 0 && systems.repairRestocked === 1, JSON.stringify([R.charges, R.secondUse, systems.repairRestocked]));
  check('nano-repair core waits for a lull, repairs, and is interrupted by hits', systems.regen.during < 5 && systems.regen.after > 15 && systems.regen.interrupted < 9 && systems.noRegen, JSON.stringify(systems.regen));

  // ------------------------------------------------------------ 5d. the expanded catalogue in combat
  const expanded = await page.evaluate(async () => {
    const g = window.__game, T = window.__t;
    const P = await import('/src/parts.js');
    const { createEnemy } = await import('/src/ai.js');
    const THREE = await import('three');
    const out = {};
    // a seeded generator keeps the shotgun's spread (and everything else random) repeatable
    const realRandom = Math.random;
    let seed = 12345;
    Math.random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const fresh = (patch) => {
      g.cheat.invincible = true;
      g.setBuild({ ...P.DEFAULT_BUILD, paint: { ...P.DEFAULT_BUILD.paint }, tuning: { ...P.DEFAULT_BUILD.tuning }, ...patch });
      g.startMission();
      g.manual = true;
      g.missions.state = 'idle';
      g.hud.reset();
      g.player.mech.place(0, 0, 0, 0);
      g.player.lock = null;
      g.player.lockEnabled = false;
      g.rig.reset(0);
      g.step(5);
    };
    const dummy = (x, z) => {
      const e = createEnemy(g, 'bulwark', 1);
      e.mech.place(x, z, 0, 0);
      e.update = () => {};
      e.mech.hp = e.mech.maxHp = 100000;
      g.enemies.push(e);
      return e;
    };
    const lost = (e) => e.mech.maxHp - e.mech.hp;
    const clear = () => { for (const e of g.enemies) e.mech.destroy(); g.enemies.length = 0; g.projectiles.clear(); };
    const fire = () => { const p = g.player; p.fireCd = 0; p.reloadT = 0; p.ammo = p.magSize; p._fireWeapon(); };
    const mine = () => g.projectiles.list.filter((q) => q.team === 'player');

    // --- beam shotgun: seven pellets per shot, brutal close and thin far away
    fresh({ weapon: 'scatter' });
    fire();
    const pellets = mine();
    const dirs = pellets.map((q) => q.dir.clone());
    out.shotgun = { count: pellets.length, spread: Math.max(...dirs.map((d) => Math.acos(Math.min(1, d.dot(dirs[0]))))), life: pellets[0].life };
    clear();
    const near = dummy(0, -60);
    for (let i = 0; i < 4; i++) { fire(); g.step(40); }
    out.shotgunNear = lost(near);
    clear();
    const far = dummy(0, -300);
    for (let i = 0; i < 4; i++) { fire(); g.step(90); }
    out.shotgunFar = lost(far);
    clear();

    // --- seeker rifle: curves onto a target that the crosshair is not quite on
    // (the camera sits 13 units to the mech's right, so the crosshair line runs at x = 13: the dummy is 21 units off it)
    const offAxis = (weapon) => {
      fresh({ weapon });
      const e = dummy(34, -200);
      g.step(2);
      fire();
      const q = mine()[0];
      const homing = { turn: q.turn, target: q.target === e.mech };
      g.step(120);
      const r = { dealt: lost(e), ...homing };
      clear();
      return r;
    };
    out.seeker = offAxis('seeker');
    out.rifleMiss = offAxis('rifle');

    // --- arc lance: goes through the first enemy and hits the one behind it
    const inLine = (weapon) => {
      fresh({ weapon });
      const a = dummy(0, -100), b = dummy(0, -170);
      g.step(2);
      fire();
      g.step(60);
      const r = { first: lost(a), second: lost(b) };
      clear();
      return r;
    };
    out.lance = inLine('lance');
    out.sniperInLine = inLine('sniper');

    // --- melee reach: a greatsword hits an enemy that sabers cannot reach
    const reachTest = (weapon) => {
      fresh({ weapon });
      const e = dummy(0, -43);
      g.step(2);
      g.player._meleeHit({ damage: 280, stagger: false });
      const r = lost(e);
      clear();
      return r;
    };
    out.sabersReach = reachTest('sabers');
    out.swordReach = reachTest('greatsword');

    // --- barrier core: soaks first, spills into armor, recharges after five quiet seconds (no shield, so the numbers are plain)
    fresh({ core: 'barrier', offhand: 'none' });
    g.cheat.invincible = false;
    const m = g.player.mech;
    m.invuln = 0;
    const hp0 = m.hp;
    m.takeDamage(100, { kind: 'beam' });
    const afterSoak = { barrier: m.barrier, hp: m.hp };
    m.takeDamage(300, { kind: 'beam' });
    const afterSpill = { barrier: m.barrier, lost: hp0 - m.hp };
    g.step(60 * 4);
    const early = m.barrier;
    g.step(60 * 3);
    const mid = m.barrier;
    g.step(60 * 3);
    out.barrier = { afterSoak, afterSpill, early, mid, full: m.barrier, max: m.barrierMax, row: document.getElementById('barrier-row').classList.contains('on'), text: document.getElementById('barrier-text').textContent };
    g.cheat.invincible = true;

    // --- ECM crown: enemy missiles turn slower, so they are still off-course after the same flight time
    const missileResidual = (head) => {
      fresh({ head });
      const q = g.projectiles.spawn({ type: 'missile', team: 'enemy', source: null, pos: new THREE.Vector3(150, 15, 0),
        dir: new THREE.Vector3(0, 0, -1), damage: 100, speed: 120, maxSpeed: 120, turn: 2.5, target: g.player.mech, life: 6, color: 0xff6040 });
      g.step(20);
      const want = g.player.mech.center().sub(q.pos).normalize();
      const r = Math.acos(Math.min(1, q.dir.dot(want)));
      clear();
      return r;
    };
    out.ecm = { plain: missileResidual('vfin'), jammed: missileResidual('jammer') };

    // --- micro-missile arm: F launches six small homing missiles
    fresh({ offhand: 'swarm' });
    const target = dummy(0, -120);
    g.player.lock = target.mech;
    g.player.lockEnabled = true;
    g.step(2);
    T.tap('KeyF');
    g.step(22);
    const swarm = mine().filter((q) => q.type === 'missile');
    out.swarm = { count: swarm.length, homing: swarm.every((q) => q.target === target.mech && q.turn > 5), cd: g.player.cannonCd, name: document.getElementById('cannon-name').textContent };
    g.step(150);
    out.swarm.dealt = lost(target);
    clear();

    // --- EN injector: refills boost fuel and clears an overheat, then recharges
    fresh({ sub: 'injector' });
    g.player.mech.en = 15;
    g.player.mech.overheat = true;
    T.tap('KeyV');
    g.step(2);
    const inj = { en: g.player.mech.en, max: g.player.mech.maxEn, overheat: g.player.mech.overheat, cd: g.player.subCd };
    g.player.mech.en = 10;
    T.tap('KeyV');
    g.step(2);
    out.injector = { ...inj, again: g.player.mech.en };

    // --- shock pulse: hurts and staggers what is close, ignores what is far
    fresh({ sub: 'pulse' });
    const close = dummy(0, -35), distant = dummy(0, -220);
    g.step(2);
    T.tap('KeyV');
    g.step(2);
    out.pulse = { close: lost(close), stagger: close.mech.stagger, far: lost(distant), cd: g.player.subCd };
    clear();

    // --- aegis field: nothing gets through for 2.5 seconds, then it is over
    fresh({ sub: 'field' });
    g.cheat.invincible = false;
    const f = g.player.mech;
    f.invuln = 0;
    T.tap('KeyV');
    g.step(2);
    const hpF = f.hp;
    const blocked1 = f.takeDamage(500, { kind: 'beam' });
    g.step(60 * 2);
    const blocked2 = f.takeDamage(500, { kind: 'beam' });
    const text = g.hud.el.subState.textContent;
    g.step(60 * 0.7);
    const late = f.takeDamage(100, { kind: 'beam' });
    out.field = { blocked1, blocked2, hpKept: hpF === hpF, text, late, cd: g.player.subCd };
    g.cheat.invincible = true;
    clear();
    Math.random = realRandom;
    return out;
  });
  dump('expanded', expanded);
  const E = expanded;
  check('a shotgun blast fires seven spread pellets with a short life', E.shotgun.count === 7 && E.shotgun.spread > 0.02 && E.shotgun.life < 1, JSON.stringify(E.shotgun));
  check('the shotgun is brutal up close and weak at range', E.shotgunNear > 1200 && E.shotgunFar < E.shotgunNear * 0.6, `${Math.round(E.shotgunNear)} near vs ${Math.round(E.shotgunFar)} far`);
  check('the seeker rifle curves onto a target the crosshair misses, where a rifle shot misses', E.seeker.turn > 3 && E.seeker.target && E.seeker.dealt > 100 && E.rifleMiss.dealt === 0, JSON.stringify([E.seeker, E.rifleMiss.dealt]));
  check('the arc lance pierces the first enemy and hits the one behind it; a sniper shot stops at the first', E.lance.first > 300 && E.lance.second > 300 && E.sniperInLine.first > 300 && E.sniperInLine.second === 0, JSON.stringify([E.lance, E.sniperInLine]));
  check('the greatsword reaches an enemy that twin sabers cannot', E.swordReach > 200 && E.sabersReach === 0, `${Math.round(E.swordReach)} vs ${E.sabersReach}`);
  const B = E.barrier;
  check('the barrier soaks a hit completely', B.afterSoak.barrier === 140 && B.afterSoak.hp === B.afterSpill.lost + B.afterSoak.hp - B.afterSpill.lost && B.afterSpill.barrier === 0, JSON.stringify([B.afterSoak, B.afterSpill]));
  check('a hit bigger than the barrier spills the rest into armor', Math.abs(B.afterSpill.lost - 160) < 1, `${B.afterSpill.lost}`);
  check('the barrier waits five quiet seconds, then recharges', B.early === 0 && B.mid > 100 && B.mid < 240 && B.full === B.max && B.max === 240, JSON.stringify([B.early, B.mid, B.full]));
  check('the HUD shows the barrier meter', B.row && B.text === '240', JSON.stringify([B.row, B.text]));
  check('an ECM crown leaves enemy missiles further off course', E.ecm.jammed > E.ecm.plain + 0.15, `${E.ecm.plain.toFixed(2)} vs ${E.ecm.jammed.toFixed(2)} rad`);
  check('the micro-missile arm launches six homing missiles and puts the arm on cooldown', E.swarm.count === 6 && E.swarm.homing && E.swarm.cd > 8 && E.swarm.name === 'MICRO-MISSILES', JSON.stringify(E.swarm));
  check('the micro-missiles hit what they were sent at', E.swarm.dealt > 250, `${Math.round(E.swarm.dealt)}`);
  check('the EN injector refills boost fuel, clears an overheat, and then recharges', E.injector.en >= E.injector.max - 5 && !E.injector.overheat && E.injector.cd > 14 && E.injector.again < 40, JSON.stringify(E.injector));
  check('the shock pulse hurts and staggers what is close and ignores what is far', E.pulse.close > 150 && E.pulse.stagger > 0 && E.pulse.far === 0 && E.pulse.cd > 12, JSON.stringify(E.pulse));
  check('the aegis field blocks everything for 2.5 s and then ends', E.field.blocked1 === 0 && E.field.blocked2 === 0 && /FIELD UP/.test(E.field.text) && E.field.late > 0 && E.field.cd > 19, JSON.stringify(E.field));

  // ------------------------------------------------------------ 5e. the pit stop between waves
  const pitTest = await page.evaluate(() => {
    const g = window.__game;
    g.cheat.invincible = true;
    g.setBuild({ ...window.__garage.build, name: 'PITTER', head: 'vfin', torso: 'std', arms: 'std', legs: 'std', shoulder: 'std', backpack: 'std', core: 'std', pilot: 'rookie', weapon: 'rifle', offhand: 'shield', sub: 'none', tuning: { plating: 0, servos: 0, thrusters: 0, weapons: 0 } });
    g.settings.pitStops = true;
    g.startMission();
    g.manual = true;
    g.hud.reset();
    const out = {};
    g.step(60 * 4); // the wave-1 intro, then three drones spawn
    out.spawned = g.enemies.length;
    g.player.mech.place(130, -90, 0, 1.2);
    g.player.mech.hp = g.player.mech.maxHp * 0.5;
    const timeBefore = g.stats.time;
    for (const e of [...g.enemies]) e.mech.takeDamage(1e6, { kind: 'beam' });
    g.step(1);
    out.cleared = g.missions.state;
    g.step(60 * 3);
    out.beforeTimer = g.state; // the clear banner is still showing
    g.step(60 * 2);
    out.state = g.state;
    out.mission = g.missions.state;
    out.hostiles = g.enemies.length;
    out.hudHidden = document.getElementById('hud').classList.contains('hidden');
    const hc = document.getElementById('hud2d');
    const px = hc.getContext('2d').getImageData(0, 0, hc.width, hc.height).data;
    out.hudPixels = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) out.hudPixels++;
    out.garageShown = !document.getElementById('screen-garage').classList.contains('hidden');
    out.inGarage = g.inGarage;
    out.timeStopped = g.stats.time - timeBefore;
    out.card = document.getElementById('g-pit').textContent.replace(/\s+/g, ' ').trim();
    out.go = document.getElementById('g-go').textContent;
    out.backShown = getComputedStyle(document.getElementById('g-back')).display !== 'none';
    out.armorShare = g.player.mech.hp / g.player.mech.maxHp;
    out.at = [g.player.mech.pos.x, g.player.mech.pos.z];
    return out;
  });
  dump('pit', pitTest);
  check('clearing a wave starts a short clear banner and then the pit stop', pitTest.spawned === 3 && pitTest.cleared === 'clear' && pitTest.beforeTimer === 'playing' && pitTest.state === 'intermission' && pitTest.mission === 'pit', JSON.stringify([pitTest.cleared, pitTest.beforeTimer, pitTest.state, pitTest.mission]));
  check('in the pit stop: no hostiles, the HUD is hidden and the garage screen is up', pitTest.hostiles === 0 && pitTest.hudHidden && pitTest.garageShown && pitTest.inGarage);
  check('the HUD canvas is wiped when the pit stop begins (no stray crosshair over the mech)', pitTest.hudPixels === 0, `${pitTest.hudPixels} pixels`);
  check('the pit card names the next wave, its hostiles and your armor', /WAVE 1 OF 5 CLEARED/.test(pitTest.card) && /NEXT: WAVE 2/.test(pitTest.card) && /PINCER/.test(pitTest.card) && /4 × DR-12 DRONE/.test(pitTest.card) && /1 × ST-21 STRIKER/.test(pitTest.card) && /ARMOR 75%/.test(pitTest.card), pitTest.card);
  check('the only way out of the pit is to launch the next wave', pitTest.go === 'LAUNCH WAVE 2' && !pitTest.backShown);
  check('time stands still in the pit stop', pitTest.timeStopped < 12, `${pitTest.timeStopped.toFixed(1)} s passed since the wave began`);
  await page.click('.g-tab[data-tab="torso"]');
  await page.locator('.opt[data-id="heavy"]').scrollIntoViewIfNeeded();
  await page.click('.opt[data-id="heavy"]');
  await page.click('.g-tab[data-tab="weapon"]');
  await page.locator('.opt[data-id="scatter"]').scrollIntoViewIfNeeded();
  await page.click('.opt[data-id="scatter"]');
  const swapped = await page.evaluate(() => {
    const g = window.__game, p = g.player;
    return { torso: p.build.torso, weapon: p.weapon.name, share: p.mech.hp / p.mech.maxHp, max: p.mech.maxHp, ammo: p.ammo, mag: p.magSize,
      stored: JSON.parse(localStorage.getItem('steel-vanguard.build') || '{}').weapon, state: g.state, keys: [...g.input.keys] };
  });
  check('parts can be swapped in the pit; the new machine keeps your share of armor (no free repair)', swapped.torso === 'heavy' && swapped.weapon === 'BEAM SHOTGUN' && Math.abs(swapped.share - 0.75) < 0.01 && swapped.max > 2800 && swapped.state === 'intermission', JSON.stringify(swapped));
  check('a swapped machine comes with a full magazine, and the build is saved', swapped.ammo === swapped.mag && swapped.stored === 'scatter');
  await page.screenshot({ path: path.join(OUT, '04_pit.png') });
  await page.click('#g-go');
  const pitLaunch = await page.evaluate(() => {
    const g = window.__game, m = g.player.mech;
    const out = { state: g.state, mission: g.missions.state, wave: g.missions.waveNumber, at: [Math.round(m.pos.x), Math.round(m.pos.z)], yaw: m.yaw, hud: !document.getElementById('hud').classList.contains('hidden'),
      garageHidden: document.getElementById('screen-garage').classList.contains('hidden'), grounded: m.grounded, locks: window.__lockRequests, platform: g.world.garage.visible };
    g.step(60 * 4);
    out.afterIntro = { mission: g.missions.state, enemies: g.enemies.length };
    return out;
  });
  check('LAUNCH returns to the sortie at the same spot with the next wave starting', pitLaunch.state === 'playing' && pitLaunch.mission === 'intro' && pitLaunch.wave === 2 && pitLaunch.at[0] === 130 && pitLaunch.at[1] === -90 && Math.abs(pitLaunch.yaw - 1.2) < 0.2, JSON.stringify(pitLaunch));
  check('after launching the HUD is back, the garage is gone and the next wave spawns', pitLaunch.hud && pitLaunch.garageHidden && !pitLaunch.platform && pitLaunch.afterIntro.mission === 'combat' && pitLaunch.afterIntro.enemies === 5, JSON.stringify(pitLaunch.afterIntro));
  check('launching recaptures the mouse', pitLaunch.locks >= 2, `${pitLaunch.locks} requests`);
  const skip = await page.evaluate(() => {
    const g = window.__game;
    g.settings.pitStops = false;
    for (const e of [...g.enemies]) e.mech.takeDamage(1e6, { kind: 'beam' });
    g.step(1);
    g.step(60 * 5);
    return { state: g.state, mission: g.missions.state, wave: g.missions.waveNumber };
  });
  check('with pit stops switched off the next wave simply follows', skip.state === 'playing' && skip.mission === 'intro' && skip.wave === 3, JSON.stringify(skip));
  const lastWave = await page.evaluate(() => {
    const g = window.__game;
    g.settings.pitStops = true;
    g.missions.index = 3;
    g.missions.state = 'combat';
    g.enemies.length = 0;
    g.step(1);
    g.step(60 * 5);
    const wave4Pit = g.state;
    g.leaveIntermission(); // the next wave is the boss
    g.missions.state = 'combat';
    g.enemies.length = 0;
    g.step(1);
    g.step(60 * 5);
    return { wave4Pit, afterBoss: g.state, finished: g.missions.finished };
  });
  check('a pit stop follows every wave except the last: clearing the boss wins the sortie', lastWave.wave4Pit === 'intermission' && lastWave.afterBoss === 'ended' && lastWave.finished, JSON.stringify(lastWave));
  await page.evaluate(() => {
    const g = window.__game;
    g.settings.pitStops = true;
    for (const id of ['screen-end', 'screen-pause', 'screen-title', 'screen-garage']) document.getElementById(id).classList.add('hidden');
    g.world.setGarage(false);
    g.cheat.invincible = true;
    g.setBuild({ ...window.__garage.build, weapon: 'rifle', torso: 'std', offhand: 'shield' });
    g.player.mech.place(0, 0, 0, 0);
  });
  check('overclock core makes BURST last 18 s instead of 12', systems.burstTime > 17 && systems.burstTimeStock > 11 && systems.burstTimeStock < 12.1 && systems.burstTime > systems.burstTimeStock + 5, `${systems.burstTime.toFixed(1)} vs ${systems.burstTimeStock.toFixed(1)}`);
  check('phase governor lengthens dash invulnerability', systems.phaseInvuln > systems.stockInvuln + 0.2, `${systems.phaseInvuln.toFixed(2)} vs ${systems.stockInvuln.toFixed(2)}`);
  check('recon head widens the radar', systems.radar === 670);
  check('exceeding the load limit really slows you down in play', systems.overloadStat > 0 && systems.overloadRun.over < systems.overloadRun.ok * 0.8, `${systems.overloadRun.over.toFixed(1)} vs ${systems.overloadRun.ok.toFixed(1)}`);
  check('a power shortfall really slows weapon cycling in play', systems.fireRate.starved.pf < 1 && systems.fireRate.starved.shots < systems.fireRate.ok.shots && systems.fireRate.starved.cd > systems.fireRate.ok.cd * 1.2, JSON.stringify(systems.fireRate));
  check('a power shortfall also slows the shoulder cannon recharge', systems.cannonRecovery.starved.pf < 1 && systems.cannonRecovery.starved.drop < systems.cannonRecovery.ok.drop * 0.8 && systems.cannonRecovery.ok.drop > 0.9, JSON.stringify(systems.cannonRecovery));
  check('the weapons tuning dial raises real shot damage', systems.tuneDamage.tuned > systems.tuneDamage.stock * 1.15 && systems.tuneDamage.stock === 210, JSON.stringify(systems.tuneDamage));
  check('plating and thrusters tuning reach the mech', systems.tuneMech.hp > systems.stockMech.hp * 1.2 && systems.tuneMech.en > systems.stockMech.en * 1.2, JSON.stringify([systems.tuneMech, systems.stockMech]));
  check('shoulder shells stack with the shield', Math.abs(systems.guardStack - 74) < 0.5, `${systems.guardStack}`);
  check('the engineer pilot repairs twice as much between waves', Math.abs(systems.resupply.rookie - 0.25) < 0.02 && Math.abs(systems.resupply.engineer - 0.5) < 0.02, JSON.stringify(systems.resupply));
  await page.evaluate(() => { // back to a stock mech for the rest of the suite
    const g = window.__game;
    g.setBuild(window.__garage.build.name ? { ...window.__garage.build, head: 'vfin', torso: 'std', arms: 'std', legs: 'std', backpack: 'std', weapon: 'rifle', offhand: 'shield' } : null);
    g.startMission(); g.manual = true; g.missions.state = 'idle'; g.hud.reset();
    for (const e of g.enemies) e.mech.destroy();
    g.enemies.length = 0; g.projectiles.clear();
  });

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
  const pits = []; // what the pit-stop screen said each time the bot was dropped into it
  for (let chunk = 0; chunk < 240 && !finished; chunk++) {
    const s = await page.evaluate(() => {
      const g = window.__game, T = window.__t;
      for (let i = 0; i < 120; i++) {
        T.pilot(window.__state);
        g.step(1);
        window.__wavesSeen.add(g.missions.waveNumber);
        if (!T.allFinite()) return { bad: true };
        if (window.__ended || g.state === 'intermission') break;
      }
      return {
        state: g.state, ended: !!window.__ended, wave: g.missions.waveNumber, enemies: g.enemies.length, time: g.stats.time,
        boss: g.enemies.some((e) => e.mech.def.boss), kills: g.stats.kills, hp: g.player.mech.hp, lock: !!g.player.lock,
      };
    });
    if (s.bad) { check('simulation stays finite during the mission', false); break; }
    for (const [name, cond] of wanted) {
      if (!shotsTaken.has(name) && cond(s)) { shotsTaken.add(name); await shot(name); }
    }
    if (s.state === 'intermission') {
      // between waves the bot visits the pit stop, then launches the next wave with the real button
      pits.push(await page.evaluate(() => ({ shown: !document.getElementById('screen-garage').classList.contains('hidden'), go: document.getElementById('g-go').textContent, wave: window.__game.missions.waveNumber })));
      await page.click('#g-go');
      continue;
    }
    if (s.ended) finished = true;
    if (chunk % 10 === 0) console.log(`      …wave ${s.wave}, ${s.enemies} hostile, ${s.kills} kills, t=${s.time.toFixed(0)}s, armor ${Math.round(s.hp)}`);
  }
  const result = await page.evaluate(() => ({ r: window.__ended, waves: [...window.__wavesSeen], state: window.__game.state }));
  check('bot clears all five waves and wins', !!result.r && result.r.victory === true, result.r ? `rank ${result.r.rank}` : 'mission never ended');
  check('every wave was reached', [1, 2, 3, 4, 5].every((w) => result.waves.includes(w)), `waves ${result.waves}`);
  check('the bot visited the pit stop after waves 1 to 4 and launched each next wave from its screen', pits.length === 4 && pits.every((p, i) => p.shown && p.wave === i + 1 && p.go === `LAUNCH WAVE ${i + 2}`), JSON.stringify(pits));
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

  // the results screen leads to the garage, and SORTIE from there starts a fresh run with the same build
  await page.click('#btn-garage-end');
  const fromEnd = await page.evaluate(() => ({ state: window.__game.state, garage: !document.getElementById('screen-garage').classList.contains('hidden'),
    endHidden: document.getElementById('screen-end').classList.contains('hidden'), dead: window.__game.player.mech.dead }));
  check('results screen GARAGE button opens the garage with a repaired mech', fromEnd.state === 'garage' && fromEnd.garage && fromEnd.endHidden && !fromEnd.dead, JSON.stringify(fromEnd));
  await page.click('#g-go');
  const relaunch = await page.evaluate(() => ({ state: window.__game.state, enemies: window.__game.enemies.length, hp: window.__game.player.mech.hp, max: window.__game.player.mech.maxHp }));
  check('SORTIE from the garage after a defeat starts a clean run', relaunch.state === 'playing' && relaunch.enemies === 0 && relaunch.hp === relaunch.max, JSON.stringify(relaunch));

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
