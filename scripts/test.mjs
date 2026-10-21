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

// The slots were reorganised (the two shoulders are separate, and the cannon and micro-missile pod moved from the off-hand to the
// shoulder mounts). Most checks below are still written in terms of the old shape, so this translates it: `shoulder: X` fits both
// shoulders, `offhand: 'cannon'` / `'swarm'` fits that mount on the left shoulder (and leaves the off-hand empty), and any other
// off-hand clears the mounts (the old off-hand slot held either a shield or a cannon, never both).
const legacy = (patch) => {
  const q = { ...patch };
  if ('shoulder' in q) { q.shoulderL = q.shoulderR = q.shoulder; delete q.shoulder; }
  if ('offhand' in q) {
    if (q.offhand === 'cannon' || q.offhand === 'swarm') { q.mountL = q.offhand; q.offhand = 'none'; } else q.mountL = 'none';
  }
  return q;
};
const LEGACY_SRC = legacy.toString();

// ---------------------------------------------------------------- parts logic (plain Node, no browser)

{
  const P = await import(path.join(root, 'src', 'parts.js'));
  const def = P.deriveStats(P.DEFAULT_BUILD);
  const vary = (slot, id) => P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ [slot]: id }) });

  check('default build matches the original Vanguard', Math.abs(def.hp - 2600) <= 50 && def.speed === 40 && def.en === 100 && def.weapon.mag === 8, `armor ${def.hp}`);

  const every = [];
  for (const slot of P.SLOTS) for (const part of P.partsFor(slot)) every.push([slot, part.id, P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ [slot]: part.id }) })]);
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
  dir('shoulder cannon grants an ability', !!vary('offhand', 'cannon').ability && vary('offhand', 'cannon').ability.cooldown > 0 && vary('offhand', 'cannon').abilities.length === 1);
  dir('weapon kinds differ as advertised', vary('weapon', 'mg').weapon.kind === 'bullet' && vary('weapon', 'bazooka').weapon.kind === 'cannon' && !!vary('weapon', 'bazooka').weapon.splash && vary('weapon', 'sniper').weapon.speed > vary('weapon', 'rifle').weapon.speed);

  // weight really is what slows a mech down: the heaviest build is slower than the lightest
  const heavy = P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ head: 'visor', torso: 'heavy', arms: 'assault', legs: 'tank', backpack: 'booster', weapon: 'bazooka', offhand: 'cannon' }) });
  const light = P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ head: 'scout', torso: 'light', arms: 'precision', legs: 'sprint', backpack: 'wing', weapon: 'rifle', offhand: 'none' }) });
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
  dir('spike shoulders: melee bonus (per side, so a matched pair stacks)', vary('shoulder', 'spike').melee > 1.1 && P.deriveStats({ ...P.DEFAULT_BUILD, shoulderL: 'spike' }).melee > 1.05 && P.deriveStats({ ...P.DEFAULT_BUILD, shoulderL: 'spike' }).melee < vary('shoulder', 'spike').melee);
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
  const pools = [...new Set(P.SLOTS.map(P.poolOf))];
  check('the catalogue has 33 slots on 27 hardpoints and 156 distinct parts', P.SLOTS.length === 33 && P.HARDPOINTS.length === 27 && pools.reduce((n, pl) => n + P.PARTS[pl].length, 0) === 156, `${pools.reduce((n, pl) => n + P.PARTS[pl].length, 0)} parts`);
  check('every part id is unique within its pool and every part has a name, a description and a model', pools.every((pl) => new Set(P.PARTS[pl].map((p) => p.id)).size === P.PARTS[pl].length
    && P.PARTS[pl].every((p) => p.name && p.desc.length > 20 && typeof p.model === 'string')));
  check('every hardpoint holds real slots, and every slot belongs to exactly one hardpoint', P.HARDPOINTS.every((h) => h.slots.length >= 1 && h.slots.every((s) => P.SLOTS.includes(s)))
    && P.SLOTS.every((s) => P.HARDPOINTS.filter((h) => h.slots.includes(s)).length === 1));
  dir('ace visor: faster trigger and burst gauge, a little melee', vary('head', 'ace').weapon.cooldown < def.weapon.cooldown && vary('head', 'ace').burstGain > 1 && vary('head', 'ace').melee > 1);
  dir('ECM crown: jams enemy missiles', vary('head', 'jammer').jam === 0.4 && def.jam === 0);
  dir('missile bay chest: an extra missile charge and harder missiles', vary('torso', 'bay').missileCharges === 3 && vary('torso', 'bay').missileDamage > 1);
  dir('command chest: radar, burst gain and wave repair', vary('torso', 'command').radar > def.radar && vary('torso', 'command').burstGain > 1 && vary('torso', 'command').resupplyHeal > def.resupplyHeal);
  dir('guard arms: armor, stagger resistance and guard', vary('arms', 'guard').hp > def.hp && vary('arms', 'guard').staggerAt > def.staggerAt && vary('arms', 'guard').guard > def.guard);
  dir('recoil arms: a harder-hitting but slower gun', vary('arms', 'recoil').weapon.damage > def.weapon.damage && vary('arms', 'recoil').weapon.cooldown > def.weapon.cooldown);
  dir('strider legs: quicker on foot, longer dash', vary('legs', 'strider').speed > def.speed && vary('legs', 'strider').dashSpeed > def.dashSpeed);
  dir('siege legs: big stagger resistance and a steadier gun, but slow', vary('legs', 'siege').staggerAt > def.staggerAt + 100 && vary('legs', 'siege').weapon.reload < def.weapon.reload && vary('legs', 'siege').speed < def.speed);
  dir('missile racks: harder missiles and tighter homing', vary('shoulder', 'rack').missileDamage > 1.2 && vary('shoulder', 'rack').missileTurn > def.missileTurn);
  dir('aegis emitters: 5% per side, 10% as a pair', Math.abs(vary('shoulder', 'aegis').guard - 0.32) < 1e-9 && Math.abs(P.deriveStats({ ...P.DEFAULT_BUILD, shoulderL: 'aegis' }).guard - 0.27) < 1e-9);
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
  dir('micro-missile pod: a swarm ability', vary('offhand', 'swarm').ability.kind === 'swarm' && vary('offhand', 'swarm').ability.count === 6);
  dir('the three new sub-weapons are defined', ['injector', 'pulse', 'field'].every((id) => vary('sub', id).sub?.kind === id));
  const stackedGuard2 = P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ offhand: 'tower', shoulder: 'aegis', pilot: 'guardian', arms: 'guard' }) });
  check('guard from every kind of part stacks, up to the cap', P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ offhand: 'buckler', arms: 'guard' }) }).guard > 0.15 && stackedGuard2.guard === 0.35);
  check('missile charges top out at four (a pod pack and a bay chest)', P.deriveStats({ ...P.DEFAULT_BUILD, backpack: 'pod', torso: 'bay' }).missileCharges === 4 && P.deriveStats({ ...P.DEFAULT_BUILD, torso: 'bay' }).missileCharges === 3);
  check('the burst gauge never fills more than twice as fast', P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ head: 'horn', torso: 'reactor', core: 'siphon', pilot: 'veteran' }) }).burstGain === 2);
  check('ECM jamming is capped', P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ head: 'jammer' }) }).jam <= 0.8);
  check('the firepower bar counts a shotgun by its pellets', vary('weapon', 'scatter').dps > 150 && vary('weapon', 'scatter').dps < 400, `${vary('weapon', 'scatter').dps}`);
  check('every new weapon has a sane firepower rating next to the rifle', ['scatter', 'seeker', 'lance'].every((id) => vary('weapon', id).dps > def.dps * 0.6 && vary('weapon', id).dps < def.dps * 1.3), ['scatter', 'seeker', 'lance'].map((id) => vary('weapon', id).dps).join(' '));

  // ---- budgets: weight against the legs' load limit, power draw against the torso's output
  check('the stock build is inside both budgets', def.overload === 0 && def.loadFactor === 1 && def.powerFactor === 1 && def.draw < def.supply && def.weight < def.load, `${def.weight}/${def.load}, ${def.draw}/${def.supply}`);
  const overloaded = P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ legs: 'sprint', torso: 'heavy', shoulder: 'bulwark', arms: 'assault', backpack: 'booster' }) });
  const sameParts = P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ legs: 'tank', torso: 'heavy', shoulder: 'bulwark', arms: 'assault', backpack: 'booster' }) });
  check('exceeding the load limit slows the mech down', overloaded.overload > 0 && overloaded.loadFactor < 1 && overloaded.speed < sameParts.speed * 1.2 && overloaded.dashSpeed < P.deriveStats(P.DEFAULT_BUILD).dashSpeed,
    `over by ${overloaded.overload}, factor ${overloaded.loadFactor.toFixed(2)}`);
  const crushed = P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ legs: 'sprint', torso: 'heavy', shoulder: 'bulwark', arms: 'assault', backpack: 'booster', weapon: 'bazooka', offhand: 'cannon', sub: 'repair', head: 'visor' }) });
  check('overload never stops the mech: the slowdown has a floor', crushed.loadFactor === 0.55 && crushed.speed > 0);
  const hungryBuild = { ...P.DEFAULT_BUILD, ...legacy({ torso: 'light', head: 'recon', arms: 'precision', legs: 'jump', shoulder: 'vernier', backpack: 'booster', core: 'phase', weapon: 'sniper', offhand: 'cannon', sub: 'vulcan' }) };
  const hungry = P.deriveStats(hungryBuild);
  const fed = P.deriveStats({ ...hungryBuild, ...legacy({ torso: 'reactor', shoulder: 'std', offhand: 'none', sub: 'none' }) }); // same gun and arms, but inside the power budget
  check('a power shortfall slows EN recovery and weapon cycling by the power factor', hungry.draw > hungry.supply && hungry.powerFactor < 1 && fed.powerFactor === 1
    && Math.abs(fed.weapon.cooldown / hungry.weapon.cooldown - hungry.powerFactor) < 0.01 && Math.abs(fed.weapon.reload / hungry.weapon.reload - hungry.powerFactor) < 0.01
    && hungry.enAir < (hungry.enAir / hungry.powerFactor) - 1, `power factor ${hungry.powerFactor.toFixed(2)}`);
  check('a power shortfall has a floor too', hungry.powerFactor >= 0.4 && Number.isFinite(hungry.weapon.cooldown) && P.deriveStats({ ...hungryBuild, ...legacy({ torso: 'light', backpack: 'booster', weapon: 'bazooka', offhand: 'cannon' }) }).powerFactor >= 0.4);
  check('a power shortfall bites harder than the raw shortfall', hungry.powerFactor < hungry.supply / hungry.draw, `${hungry.powerFactor.toFixed(2)} vs ${(hungry.supply / hungry.draw).toFixed(2)}`);
  check('the reactor torso out-supplies the light frame', vary('torso', 'reactor').supply > vary('torso', 'light').supply && vary('torso', 'heavy').supply > def.supply);
  check('tank legs carry the most, sprint legs the least', vary('legs', 'tank').load > vary('legs', 'std').load && vary('legs', 'std').load > vary('legs', 'sprint').load);

  // ---- stacking is capped so no single trick runs away
  const stackedMelee = P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ weapon: 'sabers', arms: 'blade', shoulder: 'spike', pilot: 'duelist', head: 'horn' }) });
  check('melee bonuses are soft-capped (raw product would be about x2.5)', stackedMelee.melee > 1.9 && stackedMelee.melee < 2.2, `x${stackedMelee.melee.toFixed(2)}`);
  const stackedGuard = P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ weapon: 'sabers', offhand: 'shield', shoulder: 'bulwark' }) });
  check('gunfire absorption is capped at 35%', stackedGuard.guard === 0.35, `${stackedGuard.guard}`);

  // ---- tuning points
  const tune = (t) => P.deriveStats({ ...P.DEFAULT_BUILD, ...legacy({ tuning: t }) });
  check('plating raises armor', tune({ plating: 6 }).hp > def.hp * 1.2 && tune({ plating: 6 }).hp < def.hp * 1.3);
  check('servos raise speed, dash and turning', tune({ servos: 6 }).speed > def.speed * 1.1 && tune({ servos: 6 }).dashSpeed > def.dashSpeed * 1.1 && tune({ servos: 6 }).turn > def.turn);
  check('thrusters raise boost fuel and climb', tune({ thrusters: 6 }).en > def.en * 1.2 && tune({ thrusters: 6 }).ascendSpeed > def.ascendSpeed);
  check('weapons raise damage output', tune({ weapons: 6 }).damage > 1.15 && tune({ weapons: 6 }).dps > def.dps * 1.15);
  const capped = P.cleanTuning({ plating: 99, servos: 99, thrusters: 99, weapons: 99 });
  check('tuning is capped per dial and in total', Object.values(capped).every((v) => v <= P.TUNING_MAX) && P.tuningSpent(capped) === P.TUNING_POOL, JSON.stringify(capped));
  check('tuning survives junk input', JSON.stringify(P.cleanTuning({ plating: 'x', servos: -4, thrusters: 2.6, weapons: null })) === JSON.stringify({ plating: 0, servos: 0, thrusters: 3, weapons: 0 }) && P.tuningSpent(P.cleanTuning(undefined)) === 0);
  check('an older save (before these slots existed) loads with sensible defaults', (() => {
    const old = P.sanitizeBuild({ name: 'OLD ONE', head: 'horn', weapon: 'mg', offhand: 'none' });
    return old.shoulderL === 'std' && old.shoulderR === 'std' && old.core === 'std' && old.pilot === 'rookie' && old.sub === 'none' && old.crest === 'auto' && old.skirt === 'std' && old.marks === 'none' && P.tuningSpent(old.tuning) === 0 && old.head === 'horn';
  })());

  // ---- the rig: leg layouts, extra arms, side heads, tail, pods and proportions
  const rig = (patch) => P.deriveStats({ ...P.DEFAULT_BUILD, ...patch });
  const quad = rig({ layout: 'quad' }), hexa = rig({ layout: 'hexa' }), tread = rig({ layout: 'tread' }), hover = rig({ layout: 'hover' });
  check('a stock build is a biped with two arms, two legs and one head', def.layout.id === 'biped' && JSON.stringify(def.counts) === JSON.stringify({ arms: 2, legs: 2, heads: 1 }) && def.limbs.length === 0 && def.lock === 1 && def.salvo === 4, JSON.stringify(def.counts));
  check('leg layouts trade speed for stability: more legs carry more and are harder to stagger, but are slower and dash worse',
    quad.load > def.load && hexa.load > quad.load && quad.staggerAt > def.staggerAt && hexa.staggerAt > quad.staggerAt && quad.speed < def.speed && hexa.speed < quad.speed && hexa.dashSpeed < quad.dashSpeed && quad.dashSpeed < def.dashSpeed,
    `load ${def.load}/${quad.load}/${hexa.load} stagger ${def.staggerAt}/${quad.staggerAt}/${hexa.staggerAt}`);
  check('treads are fast, tough and bad in the air; hover pods are the reverse: quick in the air and on a dash, with little armor',
    tread.speed > def.speed && tread.hp > def.hp && tread.airSpeed < def.airSpeed && tread.ascendSpeed < def.ascendSpeed && hover.airSpeed > def.airSpeed && hover.dashSpeed > def.dashSpeed && hover.hp < def.hp, `tread ${tread.speed.toFixed(1)}/${Math.round(tread.hp)} hover ${hover.airSpeed.toFixed(1)}/${Math.round(hover.hp)}`);
  check('the leg style multiplies with the number of legs, and means nothing on treads or hover pods',
    rig({ layout: 'hexa', legs: 'tank' }).load > rig({ layout: 'hexa', legs: 'std' }).load * 1.2 && rig({ layout: 'tread', legs: 'tank' }).hp === rig({ layout: 'tread', legs: 'sprint' }).hp && rig({ layout: 'hover', legs: 'tank' }).load === rig({ layout: 'hover', legs: 'std' }).load);
  check('the leg-style slot is hidden for treads and hover pods, and the skirt for everything but a biped', (() => {
    const hp = (id) => P.HARDPOINTS.find((h) => h.id === id);
    return P.hardpointSlots(hp('legs'), { layout: 'biped' }).join() === 'layout,legs' && P.hardpointSlots(hp('legs'), { layout: 'tread' }).join() === 'layout' && P.hardpointSlots(hp('legs'), { layout: 'hover' }).join() === 'layout'
      && P.hardpointSlots(hp('waist'), { layout: 'biped' }).join() === 'core,skirt' && P.hardpointSlots(hp('waist'), { layout: 'quad' }).join() === 'core';
  })());

  const arm = (id) => rig({ armLowerL: id, armLowerR: id });
  check('every extra arm costs weight and power: a gun arm weighs 6 and draws 14, and two of them draw 28', rig({ armLowerL: 'gun' }).draw - def.draw === 14 && rig({ armLowerL: 'gun' }).weight - def.weight === 6 && arm('gun').draw - def.draw === 28);
  check('extra arms are listed with their row, side and weapon, and count toward the arms total', (() => {
    const s = rig({ armLowerL: 'gun', armUpperR: 'cannon', armUpperL: 'blade' });
    const by = Object.fromEntries(s.limbs.map((l) => [l.slot, l]));
    return s.counts.arms === 5 && by.armLowerL.kind === 'gun' && by.armLowerL.row === 'lower' && by.armLowerL.side === 'L' && by.armUpperR.kind === 'cannon' && by.armUpperR.row === 'upper' && by.armUpperR.side === 'R' && by.armUpperL.kind === 'blade' && s.limbs.length === 3;
  })());
  check('arm sabers add melee, arm shields guard and stagger resistance, launchers add missiles to a salvo, nano arms repair',
    arm('blade').melee > def.melee * 1.2 && arm('shield').guard > def.guard + 0.1 && arm('shield').staggerAt > def.staggerAt + 60 && arm('launcher').salvo === 8 && rig({ armLowerL: 'launcher' }).salvo === 6 && arm('repair').regen >= 12);
  check('arm guns and cannons carry real damage and a rate; the salvo is capped at ten', arm('gun').limbs[0].damage > 0 && arm('gun').limbs[0].interval > 0 && arm('cannon').limbs[0].splash.damage > 0 && rig({ armLowerL: 'launcher', armLowerR: 'launcher', armUpperL: 'launcher', armUpperR: 'launcher' }).salvo === 10);
  const many = rig({ armLowerL: 'cannon', armLowerR: 'cannon', armUpperL: 'gun', armUpperR: 'gun' });
  check('four armed sockets overdraw the power budget and slow everything: the price of a many-armed machine', many.draw > many.supply * 1.2 && many.powerFactor < 0.8 && many.weapon.cooldown > def.weapon.cooldown * 1.2, `draw ${many.draw} of ${many.supply}, power x${many.powerFactor.toFixed(2)}`);

  const head = (patch) => rig(patch);
  check('a side head adds one lock-on target and works at half strength (60% of the weight and power draw)', (() => {
    const base = head({ head: 'vfin' }), one = head({ headL: 'recon' }), main = head({ head: 'recon' });
    return one.lock === 2 && head({ headL: 'recon', headR: 'recon' }).lock === 3 && base.lock === 1 && one.radar > base.radar && one.radar < main.radar && Math.abs((one.radar - base.radar) - (main.radar - base.radar) * 0.5) < 1
      && Math.abs(one.draw - base.draw - 0.6 * (P.partOf('head', 'recon').add.draw)) <= 1; // (the budgets are whole numbers)
  })());
  check('lock-on targets are capped at three, and an empty side head adds nothing', head({ headL: 'recon', headR: 'jammer' }).lock === 3 && head({ headL: 'none' }).lock === 1 && JSON.stringify(head({ headL: 'none' }).counts) === JSON.stringify(def.counts));
  check('side heads can wear any helmet, and the counts show them', P.PARTS.head2.length === P.PARTS.head.length + 1 && head({ headL: 'hawk', headR: 'twin' }).counts.heads === 3);

  check('tails and pods: a boom resists staggers, a lash blade adds melee, a boost tail adds fuel; pods are per side', rig({ tail: 'stabilizer' }).staggerAt > def.staggerAt + 80 && rig({ tail: 'lash' }).melee > def.melee * 1.1 && rig({ tail: 'booster' }).en > def.en + 20
    && rig({ podL: 'thruster' }).en < rig({ podL: 'thruster', podR: 'thruster' }).en && rig({ podL: 'missile', podR: 'missile' }).missileCharges === 4 && rig({ podL: 'plate', podR: 'plate' }).hp > def.hp + 250);

  const prop = (p) => rig({ prop: { ...P.DEFAULT_BUILD.prop, ...p } });
  check('proportions are trades: size, leg length, arm length, torso width and head size', (() => {
    const big = prop({ size: 1.3 }), small = prop({ size: 0.85 });
    return big.hp > def.hp * 1.4 && big.speed < def.speed && big.weight > def.weight * 1.4 && small.hp < def.hp && small.speed > def.speed
      && prop({ legs: 1.4 }).speed > def.speed * 1.1 && prop({ legs: 1.4 }).staggerAt < def.staggerAt && prop({ legs: 0.7 }).speed < def.speed
      && prop({ arms: 1.4 }).reach > def.reach * 1.35 && prop({ arms: 1.4 }).melee > def.melee && prop({ torso: 1.4 }).hp > def.hp * 1.15 && prop({ torso: 1.4 }).supply > def.supply && prop({ torso: 1.4 }).dashSpeed < def.dashSpeed
      && prop({ head: 1.5 }).radar > def.radar * 1.2 && prop({ head: 0.7 }).radar < def.radar;
  })());
  check('leg length means nothing without legs, and every proportion is clamped to its limits in whole steps', (() => {
    const c = P.cleanProp({ size: 99, legs: -4, arms: 1.1234, torso: 'x', head: 1.07 });
    return rig({ layout: 'tread', prop: { ...P.DEFAULT_BUILD.prop, legs: 1.4 } }).speed === rig({ layout: 'tread' }).speed && c.size === 1.3 && c.legs === 0.7 && c.arms === 1.1 && c.torso === 1 && c.head === 1.05 && P.cleanProp(undefined).size === 1;
  })());
  check('the spec for the model carries the layout, the extra sockets and the proportions, and size scales the machine', (() => {
    const d = P.deriveMech({ ...P.DEFAULT_BUILD, layout: 'hexa', armLowerL: 'gun', headR: 'hawk', tail: 'lash', podL: 'missile', prop: { size: 1.2, legs: 1.1, arms: 1, torso: 1.2, head: 1 } });
    return d.spec.layout === 'hexa' && d.spec.armLowerL === 'gun' && d.spec.armLowerR === 'none' && d.spec.headR === 'hawk' && d.spec.headL === 'none' && d.spec.tail === 'lash' && d.spec.podL === 'missile' && d.spec.scale === 1.2 && d.spec.prop.legs === 1.1 && Math.abs(d.spec.bulk - 1.2) < 1e-9;
  })());
  check('the symmetry switch mirrors every pair: arms, side heads and pods as well as shoulders', ['armLowerL', 'armUpperL', 'headL', 'podL'].every((slot) => {
    const out = P.withPart(P.DEFAULT_BUILD, slot, P.partsFor(slot)[1].id, true);
    return out[P.MIRROR[slot]] === P.partsFor(slot)[1].id && P.withPart(P.DEFAULT_BUILD, slot, P.partsFor(slot)[1].id, false)[P.MIRROR[slot]] === 'none';
  }));
  check('an older save without any of the rig fields loads as a stock biped, and a bad layout falls back', (() => {
    const old = P.sanitizeBuild({ name: 'OLD ONE', weapon: 'mg', layout: 'spaceship', armLowerL: 'banana', prop: { size: 'big' } });
    return old.layout === 'biped' && old.armLowerL === 'none' && old.headL === 'none' && old.tail === 'none' && old.podR === 'none' && old.prop.size === 1 && old.weapon === 'mg';
  })());
  check('random builds are always valid, some are strange, and sanitising one changes nothing', (() => {
    let strange = 0, ok = true;
    for (let i = 0; i < 400; i++) {
      const b = P.randomBuild();
      if (JSON.stringify(P.sanitizeBuild(b)) !== JSON.stringify(b)) ok = false;
      const s = P.deriveStats(b);
      if (![s.hp, s.speed, s.weight, s.powerFactor, s.dps].every(Number.isFinite) || s.hp <= 0 || s.speed <= 0) ok = false;
      if (b.layout !== 'biped' || s.limbs.length || s.lock > 1) strange++;
    }
    return ok && strange > 60 && strange < 380;
  })());

  // ---- the expansion: more sockets and layouts, upgrades, set bonuses, paint zones, part health, build codes
  const S = await import(path.join(root, 'src', 'share.js'));
  const build = (patch) => ({ ...P.DEFAULT_BUILD, ...patch });
  const stats = (patch, opts) => P.deriveStats(build(patch), opts);
  check('the expanded rig: 33 slots on 27 hardpoints (16 sockets) and 156 distinct parts', P.SLOTS.length === 33 && P.HARDPOINTS.length === 27 && P.HARDPOINTS.filter((h) => h.socket).length === 16 && P.SOCKET_SLOTS.length === 16
    && pools.reduce((n, pl) => n + P.PARTS[pl].length, 0) === 156, `${pools.reduce((n, pl) => n + P.PARTS[pl].length, 0)} parts`);
  check('every new pair mirrors (mid arms, wings, flanks) and the chest module is a single socket', P.MIRROR.armMidL === 'armMidR' && P.MIRROR.wingR === 'wingL' && P.MIRROR.flankL === 'flankR' && !P.MIRROR.chestMod && P.poolOf('chestMod') === 'module');
  const lay = (id) => stats({ layout: id });
  check('layouts: three legs, eight legs and wheels join the five; every layout has its own trade-offs', [2, 3, 4, 6, 8, 0, 0, 0].join() === ['biped', 'tripod', 'quad', 'hexa', 'octo', 'wheel', 'tread', 'hover'].map((id) => lay(id).counts.legs).join()
    && lay('octo').staggerAt > lay('hexa').staggerAt && lay('octo').speed < lay('hexa').speed && lay('wheel').speed > lay('biped').speed * 1.15 && lay('wheel').staggerAt < lay('biped').staggerAt && lay('tripod').staggerAt > lay('biped').staggerAt && lay('tripod').speed > lay('quad').speed,
    JSON.stringify(['biped', 'tripod', 'quad', 'hexa', 'octo', 'wheel'].map((id) => [id, Math.round(lay(id).speed), lay(id).staggerAt])));
  check('the wheelbase and treads ignore the leg style, the octopod multiplies it by eight legs\' worth', stats({ layout: 'wheel', legs: 'tank' }).hp === stats({ layout: 'wheel', legs: 'sprint' }).hp && stats({ layout: 'octo', legs: 'tank' }).load > stats({ layout: 'hexa', legs: 'tank' }).load);
  const kind = (patch, key) => stats(patch)[key];
  check('new arm tools: shotgun (pellets), railgun (a heavy piercing slug), sensor (radar), drill (melee) all list as arms in the new mid sockets', (() => {
    const sh = stats({ armMidL: 'shotgun' }).limbs[0], rl = stats({ armMidR: 'rail' }).limbs[0];
    return sh.kind === 'shotgun' && sh.pellets === 7 && sh.row === 'mid' && sh.side === 'L' && rl.kind === 'rail' && rl.damage > 250 && rl.row === 'mid' && kind({ armMidL: 'sensor' }, 'radar') === 420 + 140
      && kind({ armMidL: 'drill' }, 'melee') > 1.15 && stats({ armMidL: 'sensor', armMidR: 'drill' }).counts.arms === 4;
  })());
  check('wings add their stats per side and the solar wing is free power', stats({ wingL: 'angel', wingR: 'angel' }).en === 100 + 72 && stats({ wingL: 'fighter' }).airSpeed > stats({}).airSpeed && stats({ wingL: 'solar', wingR: 'solar' }).supply === 100 + 48 && stats({ wingL: 'solar', wingR: 'solar' }).draw === stats({}).draw);
  check('chest modules, flank pods and the new pods and tail do what they say', stats({ chestMod: 'reactor' }).supply === 140 && stats({ chestMod: 'radar' }).radar === 580 && stats({ chestMod: 'emitter' }).barrier === 180 && stats({ chestMod: 'bay' }).missileCharges === 3
    && stats({ flankL: 'rack', flankR: 'rack' }).missileDamage > 1.2 && stats({ flankL: 'vernier' }).dashCost < stats({}).dashCost && stats({ flankL: 'plate', flankR: 'plate' }).hp === stats({}).hp + 240 && stats({ podL: 'barrier', podR: 'barrier' }).barrier === 260 && stats({ podL: 'radar' }).radar === 510);
  check('auto-turrets: the tail gun, the turret pods and the chest vulcan are listed with their slots, and only the vulcan shoots missiles down', (() => {
    const t = stats({ tail: 'turret', podL: 'turret', chestMod: 'vulcan' }).turrets;
    return t.map((x) => x.slot).join() === 'tail,podL,chestMod' && t.every((x) => x.damage > 0 && x.interval > 0 && x.range > 100) && t.filter((x) => x.intercept).map((x) => x.slot).join() === 'chestMod';
  })());

  // upgrades
  const gun = P.partOf('armLowerL', 'gun');
  const g3 = P.tunedPart(gun, 3);
  check('an upgrade makes a part\'s damage and benefits 12% better per level, at 8% more weight and 6% more power', Math.abs(g3.limb.damage - gun.limb.damage * 1.36) < 1e-9 && Math.abs(g3.add.weight - gun.add.weight * 1.24) < 1e-9 && Math.abs(g3.add.draw - gun.add.draw * 1.18) < 1e-9
    && P.tunedPart(gun, 0) === gun && P.tunedPart(P.partOf('armLowerL', 'none'), 3).id === 'none');
  check('upgrades keep whole numbers whole, improve penalties only where a bigger number is worse, and scale armor, guard and weapon damage', (() => {
    const bay = P.tunedPart(P.partOf('chestMod', 'bay'), 3);
    const vern = P.tunedPart(P.partOf('flankL', 'vernier'), 3);
    const shield = P.tunedPart(P.partOf('armLowerL', 'shield'), 2);
    const rifle = P.tunedPart(P.partOf('weapon', 'rifle'), 3);
    const plate = P.tunedPart(P.partOf('flankL', 'plate'), 3);
    return bay.add.missileCharges === 1 && vern.add.dashCost < -3 * 1.3 && shield.guard > 0.06 * 1.2 && rifle.weapon.damage > P.partOf('weapon', 'rifle').weapon.damage * 1.3 && plate.add.hp > 120 * 1.3 && P.tunedPart(P.partOf('layout', 'quad'), 3).add.ascendSpeed === -4;
  })());
  check('upgraded parts really change the build: more damage and armor, more weight and power draw', (() => {
    const a = stats({ armLowerL: 'gun', flankL: 'plate' }), b = stats({ armLowerL: 'gun', flankL: 'plate', up: { armLowerL: 3, flankL: 3 } });
    return b.limbs[0].damage > a.limbs[0].damage * 1.3 && b.hp > a.hp + 30 && b.weight > a.weight && b.draw > a.draw && b.up.armLowerL === 3;
  })());
  check('upgrade points: at most 3 per part and 10 in all, only on parts that exist, and they stay clear of cosmetic slots', (() => {
    const b = P.sanitizeBuild(build({ armLowerL: 'gun', armLowerR: 'gun', armUpperL: 'gun', armUpperR: 'gun', headL: 'ace', up: { armLowerL: 9, armLowerR: 3, armUpperL: 3, armUpperR: 3, headL: 3, headR: 3, crest: 3, layout: 2, sub: 3 } }));
    const spent = P.upgradeSpent(b.up);
    return spent === 10 && !('headR' in b.up) && !('crest' in b.up) && !('layout' in b.up) && !('sub' in b.up) && Object.values(b.up).every((v) => v >= 1 && v <= 3) && b.up.armLowerL === 3 && P.UPGRADE_POOL === 10 && P.UPGRADE_MAX === 3;
  })());
  check('fitting a different part (or clearing the socket) drops the old part\'s upgrades, on both sides under symmetry', (() => {
    const b = build({ armLowerL: 'gun', armLowerR: 'gun', up: { armLowerL: 2, armLowerR: 3 } });
    const both = P.withPart(b, 'armLowerL', 'cannon', true), single = P.withPart(b, 'armLowerL', 'cannon', false), same = P.withPart(b, 'armLowerL', 'gun', true);
    return !both.up.armLowerL && !both.up.armLowerR && !single.up.armLowerL && single.up.armLowerR === 3 && same.up.armLowerL === 2 && same.up.armLowerR === 3;
  })());

  // set bonuses
  const setIds = (patch) => stats(patch).sets.map((s) => s.id);
  check('a stock build has no set bonus', setIds({}).length === 0);
  check('MATCHED SET needs three identical pairs and gives stagger resistance and a little gun damage', setIds({ armLowerL: 'gun', armLowerR: 'gun', headL: 'ace', headR: 'ace' }).includes('matched') === false
    && setIds({ armLowerL: 'gun', armLowerR: 'gun', headL: 'ace', headR: 'ace', wingL: 'fighter', wingR: 'fighter' }).includes('matched')
    && stats({ armLowerL: 'gun', armLowerR: 'gun', headL: 'ace', headR: 'ace', wingL: 'fighter', wingR: 'fighter' }).staggerAt === stats({ armLowerL: 'gun', armLowerR: 'gun', headL: 'ace', headR: 'ace', wingL: 'fighter', wingR: 'fighter' }, { lost: [] }).staggerAt
    && stats({ armLowerL: 'gun', armLowerR: 'gun', headL: 'ace', headR: 'ace', wingL: 'fighter', wingR: 'fighter' }).staggerAt > stats({ armLowerL: 'gun', armLowerR: 'gun', headL: 'ace', headR: 'ace', wingL: 'fighter', wingR: 'none' }).staggerAt + 40);
  check('BATTERY (three arm guns) speeds up the guns, HYDRA (three heads) widens the radar, BLADE DANCER (three blades) lifts melee', setIds({ armLowerL: 'gun', armLowerR: 'shotgun', armMidL: 'rail' }).includes('battery')
    && Math.abs(stats({ armLowerL: 'gun', armLowerR: 'gun', armMidL: 'gun' }).weapon.cooldown - stats({ armLowerL: 'gun', armLowerR: 'gun', armMidL: 'sensor' }).weapon.cooldown / 1.1) < 1e-9
    && setIds({ headL: 'ace', headR: 'ace' }).includes('hydra') && stats({ headL: 'ace', headR: 'ace' }).radar > stats({ headL: 'ace' }).radar + 100
    && setIds({ armLowerL: 'blade', armLowerR: 'drill', tail: 'lash' }).includes('dancer') && setIds({ armLowerL: 'blade', armLowerR: 'drill' }).includes('dancer') === false);
  check('BASTION, AIR WING, ROCKET BARRAGE and GUN NEST each trigger from their own parts and not from the stock build', setIds({ armLowerL: 'shield', wingL: 'plate' }).includes('bastion') && setIds({ wingL: 'fighter', wingR: 'fighter', tail: 'booster' }).includes('airwing')
    && setIds({ wingL: 'fighter', wingR: 'fighter' }).includes('airwing') === false && setIds({ podL: 'missile', podR: 'missile', chestMod: 'bay' }).includes('barrage') && stats({ podL: 'missile', podR: 'missile', chestMod: 'bay' }).missileCharges === 4
    && setIds({ layout: 'octo', armLowerL: 'gun', armLowerR: 'gun' }).includes('nest') && setIds({ layout: 'biped', armLowerL: 'gun', armLowerR: 'gun' }).includes('nest') === false);
  check('every set has a name, a rule and a description, and they stack with the parts without breaking the caps', P.SETS.length === 8 && P.SETS.every((x) => x.name && x.need && x.desc && typeof x.test === 'function')
    && stats({ armLowerL: 'shield', armLowerR: 'shield', wingL: 'plate', wingR: 'plate', flankL: 'plate', flankR: 'plate', podL: 'barrier', podR: 'barrier', chestMod: 'emitter', offhand: 'tower', shoulderL: 'bulwark', shoulderR: 'bulwark' }).guard <= 0.35 + 1e-9);

  // paint zones
  check('paint zones: a zone keeps its own colours (the ones left out follow the body), unknown zones and bad colours are dropped', (() => {
    const b = P.sanitizeBuild(build({ zones: { head: { main: '#FF0000' }, legs: { main: 'red', sub: '#00ff00' }, banana: { main: '#ffffff' }, arms: 5, back: { main: 'nope' } } }));
    return Object.keys(b.zones).join() === 'head,legs' && b.zones.head.main === '#ff0000' && b.zones.head.sub === b.paint.sub && b.zones.legs.sub === '#00ff00' && b.zones.legs.main === b.paint.main;
  })());
  check('the model spec carries each zone as integer colours, and no zones means none', (() => {
    const z = P.deriveMech(build({ zones: { head: { main: '#ff0000', sub: '#00ff00', accent: '#0000ff', trim: '#ffffff' } } })).spec.zones;
    return z.head.main === 0xff0000 && z.head.sub === 0x00ff00 && z.head.accent === 0x0000ff && z.head.trim === 0xffffff && Object.keys(P.deriveMech(P.DEFAULT_BUILD).spec.zones).length === 0;
  })());

  // part health
  check('every socketed part has health from its weight, upgrades raise it, and many-legged layouts list each leg', (() => {
    const a = stats({ armLowerL: 'cannon', armLowerR: 'sensor', tail: 'lash', layout: 'hexa' });
    const heavy = a.parts.find((p) => p.slot === 'armLowerL'), light = a.parts.find((p) => p.slot === 'armLowerR');
    const up = stats({ armLowerL: 'cannon', up: { armLowerL: 3 } }).parts.find((p) => p.slot === 'armLowerL');
    return heavy.hp > light.hp && light.hp > 100 && up.hp === Math.round(heavy.hp * 1.36) && a.parts.filter((p) => p.kind === 'leg').length === 6 && a.parts.filter((p) => p.kind === 'part').length === 3
      && stats({}).parts.length === 0 && stats({ layout: 'biped' }).parts.length === 0 && stats({ layout: 'quad' }).parts.length === 4 && stats({ layout: 'wheel' }).parts.length === 0;
  })());
  check('a part shot off takes its effects with it: the gun stops, the lock-on goes, the weight and power draw come off', (() => {
    const full = stats({ armLowerL: 'cannon', headL: 'ace', podL: 'missile', tail: 'turret' });
    const lost = stats({ armLowerL: 'cannon', headL: 'ace', podL: 'missile', tail: 'turret' }, { lost: ['armLowerL', 'headL', 'podL', 'tail'] });
    return full.limbs.length === 1 && lost.limbs.length === 0 && full.lock === 2 && lost.lock === 1 && full.missileCharges === 3 && lost.missileCharges === 2 && full.turrets.length === 1 && lost.turrets.length === 0
      && lost.weight < full.weight && lost.draw < full.draw && JSON.stringify(lost.hp) === JSON.stringify(stats({}).hp + 0) && lost.parts.length === 0;
  })());
  check('each leg lost from a many-legged machine slows it and makes it easier to stagger, but it never stops', (() => {
    const a = stats({ layout: 'hexa' }), b = stats({ layout: 'hexa' }, { lostLegs: 2 }), c = stats({ layout: 'hexa' }, { lostLegs: 4 });
    return b.speed < a.speed * 0.85 && c.speed < b.speed && c.speed > a.speed * 0.3 && b.staggerAt < a.staggerAt && b.counts.legs === 4 && b.dashSpeed < a.dashSpeed;
  })());

  // build codes
  check('a build code round-trips every build: 300 random builds come back exactly, and the stock build is a tiny code', (() => {
    for (let i = 0; i < 300; i++) {
      const b = P.randomBuild();
      const d = S.decodeBuild(S.encodeBuild(b));
      if (!d.ok || JSON.stringify(d.build) !== JSON.stringify(P.sanitizeBuild(b))) return false;
    }
    return S.encodeBuild(P.DEFAULT_BUILD).length < 20 && S.encodeBuild(P.DEFAULT_BUILD).startsWith('SV1.');
  })());
  check('a build code survives whitespace and line breaks, and refuses damage, another version, nonsense and cut-off text with a plain message', (() => {
    const code = S.encodeBuild(build({ layout: 'octo', armLowerL: 'gun', name: 'HYDRA-7' }));
    const spaced = S.decodeBuild(`  ${code.slice(0, 12)}\n${code.slice(12)}  `);
    const bad = [S.decodeBuild(code.slice(0, -3)), S.decodeBuild(code.replace('SV1', 'SV9')), S.decodeBuild('hello'), S.decodeBuild(''), S.decodeBuild(null), S.decodeBuild(code.slice(0, 15) + 'Z' + code.slice(16)), S.decodeBuild('SV1.e30.0000')];
    return spaced.ok && spaced.build.layout === 'octo' && spaced.build.name === 'HYDRA-7' && bad.every((d) => !d.ok && d.error.length > 10);
  })());
  check('a hand-made code with junk inside is cleaned, not trusted', (() => {
    const json = JSON.stringify({ layout: 'spaceship', armLowerL: 'laser', prop: { size: 99 }, name: '<b>HAX</b>', up: { weapon: 99 }, zones: { head: { main: 'url(x)' } } });
    const body = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    let h = 0x1d0f; for (let i = 0; i < json.length; i++) h = ((h << 5) - h + json.charCodeAt(i) * 31) & 0xffff;
    const d = S.decodeBuild(`SV1.${body}.${h.toString(16).padStart(4, '0')}`);
    return d.ok && d.build.layout === 'biped' && d.build.armLowerL === 'none' && d.build.prop.size === 1.3 && /^[A-Z0-9 -]+$/.test(d.build.name) && d.build.up.weapon === 3 && Object.keys(d.build.zones).length === 0;
  })());
  check('random builds use the new sockets, upgrades and zones now and then, and are still all valid', (() => {
    const seen = { wing: 0, flank: 0, mid: 0, module: 0, up: 0, zone: 0 };
    for (let i = 0; i < 500; i++) {
      const b = P.randomBuild();
      if (b.wingL !== 'none') seen.wing++;
      if (b.flankL !== 'none') seen.flank++;
      if (b.armMidL !== 'none') seen.mid++;
      if (b.chestMod !== 'none') seen.module++;
      if (Object.keys(b.up).length) seen.up++;
      if (Object.keys(b.zones).length) seen.zone++;
      if (JSON.stringify(P.sanitizeBuild(b)) !== JSON.stringify(b)) return false;
    }
    return Object.values(seen).every((n) => n > 15);
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

await page.addInitScript(`window.__L = ${LEGACY_SRC};`); // the same old-to-new build translator, inside the page

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
  await page.evaluate(() => { window.__game.launchIntro = false; }); // the catapult launch has its own section (5h)
  await page.waitForTimeout(1500);
  check('page boots without console errors', problems.length === 0, problems.slice(0, 3).join(' | '));
  check('title screen is visible', await page.isVisible('#screen-title'));

  // ------------------------------------------------------------ garage UI (real clicks)
  // hardpoint tab -> the slots behind it (and how many parts each lists)
  const counts = {
    head: { head: 10, crest: 7 }, chest: { torso: 8, pilot: 9 }, arms: { arms: 6 }, legs: { layout: 5, legs: 6 },
    shoulderL: { shoulderL: 8, mountL: 4 }, shoulderR: { shoulderR: 8, mountR: 4 },
    back: { backpack: 6 }, waist: { core: 7, skirt: 6 }, handR: { weapon: 9 }, handL: { offhand: 4 }, hips: { sub: 7 },
  };
  await page.click('#btn-garage');
  const opened = await page.evaluate(() => ({ state: window.__game.state, shown: !document.getElementById('screen-garage').classList.contains('hidden'), titleHidden: document.getElementById('screen-title').classList.contains('hidden') }));
  check('GARAGE button opens the garage', opened.state === 'garage' && opened.shown && opened.titleHidden);
  check('garage has a tab for each of the 11 body hardpoints, the rig, size, tuning and paint', (await page.$$('.g-tab')).length === 15);

  const optionCounts = {};
  for (const [hp, slots] of Object.entries(counts)) {
    await page.click(`.g-tab[data-tab="${hp}"]`);
    for (const slot of Object.keys(slots)) {
      if (Object.keys(slots).length > 1) await page.click(`.g-slot[data-slot="${slot}"]`);
      optionCounts[slot] = (await page.$$('.opt')).length;
    }
  }
  const expectedCounts = Object.assign({}, ...Object.values(counts));
  check('every slot lists all its parts', Object.keys(expectedCounts).every((slot) => optionCounts[slot] === expectedCounts[slot]), JSON.stringify(optionCounts));

  // the markers on the 3D mech: one per hardpoint, on screen, and clicking one opens that hardpoint and swings the camera
  await page.evaluate(() => { window.__game.garageFocus('all'); window.__game.garageCam.goal = null; window.__game.render(); });
  const markers = await page.evaluate(() => [...document.querySelectorAll('.g-marker')].map((m) => ({ id: m.dataset.hp, off: m.classList.contains('off'), at: m.style.transform })));
  check('the garage floats a clickable marker over each of the 20 hardpoints (11 body parts and 9 sockets)', markers.length === 20 && markers.every((m) => !m.off && /translate/.test(m.at)), JSON.stringify(markers.filter((m) => m.off).map((m) => m.id)));
  const spread = await page.evaluate(() => {
    const pts = [...document.querySelectorAll('.g-marker')].map((m) => { const r = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(m.style.transform); return [Number(r[1]), Number(r[2])]; });
    const ys = pts.map((p) => p[1]);
    return { top: Math.min(...ys), bottom: Math.max(...ys), inView: pts.every(([x, y]) => x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight) };
  });
  check('the markers sit on the mech, head above feet, all inside the window', spread.inView && spread.bottom - spread.top > 150, JSON.stringify(spread));
  const focusLog = [];
  for (const hp of ['head', 'shoulderL', 'legs']) {
    await page.click(`.g-marker[data-hp="${hp}"] i`);
    focusLog.push(await page.evaluate(() => ({ tab: window.__garage.tab, activeTab: document.querySelector('.g-tab.active')?.dataset.tab, activeMarker: document.querySelector('.g-marker.active')?.dataset.hp, goal: window.__game.garageCam.goal?.y ?? null })));
  }
  check('clicking a marker opens that hardpoint and sends the camera to it', focusLog.every((f, i) => f.tab === ['head', 'shoulderL', 'legs'][i] && f.activeTab === f.tab && f.activeMarker === f.tab && f.goal !== null)
    && focusLog[0].goal > focusLog[2].goal, JSON.stringify(focusLog));
  const view = await page.evaluate(() => { const g = window.__game; g.step(240); return { y: g.garageCam.lookY, dist: g.garageCam.dist }; });
  check('the garage camera really moves to the hardpoint (low and wide for the legs)', view.y < 8 && view.dist > 35, JSON.stringify(view));
  await page.evaluate(() => window.__game.garageLook(40, 0));
  check('dragging the mech hands the camera back to you', (await page.evaluate(() => window.__game.garageCam.goal)) === null);
  await page.click('.g-tab[data-tab="paint"]');
  check('the paint and tuning tabs show the whole mech again', await page.evaluate(() => window.__game.garageCam.goal?.y === 10 && window.__game.garageCam.spin === true));

  // the rig: sockets for more parts (glowing + markers on the mech and cards on the RIG tab), layouts, proportions
  const sockets = await page.evaluate(() => {
    window.__welds = [];
    const g = window.__game, orig = g.garageWeld.bind(g);
    g.garageWeld = (id) => { window.__welds.push(id); orig(id); };
    const marks = [...document.querySelectorAll('.g-marker.socket')];
    return { n: marks.length, empty: marks.filter((m) => m.classList.contains('empty')).length, bodyEmpty: document.querySelectorAll('.g-marker:not(.socket).empty').length };
  });
  check('nine sockets glow on the machine, all empty on the stock build (the body markers never glow)', sockets.n === 9 && sockets.empty === 9 && sockets.bodyEmpty === 0, JSON.stringify(sockets));
  await page.click('.g-tab[data-tab="rig"]');
  const rigTab = await page.evaluate(() => ({
    counts: [...document.querySelectorAll('.rig-count b')].map((b) => b.textContent).join('/'),
    cards: [...document.querySelectorAll('.socket-btn')].map((b) => b.dataset.hp).join(','),
    allEmpty: [...document.querySelectorAll('.socket-btn')].every((b) => !b.classList.contains('filled')),
  }));
  check('the RIG tab counts the arms, legs and heads and lists all nine sockets', rigTab.counts === '2/2/1' && rigTab.cards === 'armLowerL,armLowerR,armUpperL,armUpperR,headL,headR,tail,podL,podR' && rigTab.allEmpty, JSON.stringify(rigTab));
  await page.click('.socket-btn[data-hp="armUpperL"]');
  const upper = await page.evaluate(() => ({
    tab: window.__garage.tab, lit: document.querySelector('.g-tab.active')?.dataset.tab, opts: [...document.querySelectorAll('.opt')].map((o) => o.dataset.id).join(','),
    marker: document.querySelector('.g-marker.active')?.dataset.hp, goal: window.__game.garageCam.goal?.yaw ?? null, sym: !!document.getElementById('g-sym'),
  }));
  check('a socket card opens that socket (the RIG tab stays lit, the marker and camera follow)', upper.tab === 'armUpperL' && upper.lit === 'rig' && upper.marker === 'armUpperL' && upper.goal !== null && upper.sym
    && upper.opts === 'none,gun,cannon,blade,shield,launcher,repair', JSON.stringify(upper));
  await page.click('.opt[data-id="cannon"]');
  const welded = await page.evaluate(() => {
    const g = window.__game, b = g.player.build, m = g.player.mech;
    return { L: b.armUpperL, R: b.armUpperR, limbs: m.model.rig.limbs.map((l) => `${l.slot}:${l.kind}`).join(','), welds: window.__welds.join(','), lEmpty: document.querySelector('.g-marker[data-hp="armUpperL"]').classList.contains('empty'),
      rEmpty: document.querySelector('.g-marker[data-hp="armUpperR"]').classList.contains('empty'), arms: g.player.stats.counts.arms, shown: document.querySelector('#g-summary')?.textContent.includes('4 arms') };
  });
  check('bolting a part on fills both sockets while SYMMETRY is on, with a weld flash at each new arm', welded.L === 'cannon' && welded.R === 'cannon' && welded.limbs === 'armUpperL:cannon,armUpperR:cannon' && welded.welds === 'armUpperL,armUpperR' && !welded.lEmpty && !welded.rEmpty && welded.arms === 4 && welded.shown, JSON.stringify(welded));
  const pop = await page.evaluate(() => { const g = window.__game; const during = g._pops.map((p) => p.node.scale.x); g.step(40); return { during, after: g._pops.length, back: g.player.mech.model.rig.limbs.map((l) => l.base.scale.x) }; });
  check('a part bolted on grows into place and settles at full size', pop.during.length === 2 && pop.during.every((x) => x < 1) && pop.after === 0 && pop.back.every((x) => x === 1), JSON.stringify(pop));
  await page.click('#g-sym');
  await page.click('.opt[data-id="gun"]');
  const asym = await page.evaluate(() => ({ L: window.__game.player.build.armUpperL, R: window.__game.player.build.armUpperR, sym: window.__game.player.build.sym }));
  check('with SYMMETRY off one side takes a different part', asym.L === 'gun' && asym.R === 'cannon' && !asym.sym, JSON.stringify(asym));
  await page.click('#g-sym');
  await page.click('.g-tab[data-tab="rig"]');
  const filled = await page.evaluate(() => ({ cards: [...document.querySelectorAll('.socket-btn.filled')].map((b) => b.dataset.hp).join(','), counts: [...document.querySelectorAll('.rig-count b')].map((b) => b.textContent).join('/') }));
  check('the rig tab shows the fitted sockets and the new arm count', filled.cards === 'armUpperL,armUpperR' && filled.counts === '4/2/1', JSON.stringify(filled));

  // leg layouts live under LEGS: treads and hover have no leg style to pick
  await page.click('.g-tab[data-tab="legs"]');
  const legTabs = async () => page.evaluate(() => ({ slots: [...document.querySelectorAll('.g-slot')].map((b) => b.dataset.slot).join(','), opts: [...document.querySelectorAll('.opt')].map((o) => o.dataset.id).join(',') }));
  const legsStock = await legTabs();
  check('LEGS offers the layout first (biped, quad, spider, treads, hover), then the leg style', legsStock.slots === 'layout,legs' && legsStock.opts === 'biped,quad,hexa,tread,hover', JSON.stringify(legsStock));
  await page.click('.opt[data-id="tread"]');
  const legsTread = await legTabs();
  const treadState = await page.evaluate(() => { const g = window.__game; return { layout: g.player.build.layout, legs: g.player.mech.model.rig.legs.length, treads: g.player.mech.model.rig.treads?.length ?? 0, tabHidden: document.getElementById('g-slots').classList.contains('hidden') }; });
  check('on treads the leg style slot is gone and the tracks are on the model', legsTread.slots === '' && treadState.layout === 'tread' && treadState.treads === 2 && treadState.legs === 0, JSON.stringify([legsTread, treadState]));
  await page.click('.opt[data-id="hexa"]');
  const legsHexa = await legTabs();
  check('a spider has six legs and brings the leg style back', legsHexa.slots === 'layout,legs' && await page.evaluate(() => window.__game.player.mech.model.rig.legs.length) === 6, JSON.stringify(legsHexa));
  await page.click('.opt[data-id="biped"]');

  // proportions: sliders that stretch the machine
  await page.click('.g-tab[data-tab="size"]');
  const sliders = await page.evaluate(() => [...document.querySelectorAll('.g-options input[type=range]')].map((i) => `${i.dataset.prop}:${i.min}-${i.max}`).join(' '));
  check('the SIZE tab has a slider for each of the five proportions', sliders === 'size:0.85-1.3 legs:0.7-1.4 arms:0.7-1.4 torso:0.8-1.4 head:0.7-1.5', sliders);
  await page.evaluate(() => {
    for (const [id, v] of [['size', 1.2], ['legs', 1.3]]) {
      const i = document.querySelector(`input[data-prop="${id}"]`);
      i.value = String(v);
      i.dispatchEvent(new Event('input'));
    }
  });
  await page.waitForFunction(() => window.__game.player.build.prop.legs === 1.3, null, { timeout: 8000 }); // the slider applies on the next animation frame
  const stretched = await page.evaluate(() => { const g = window.__game, m = g.player.mech; return { prop: g.player.build.prop, scale: m.spec.scale, hipY: m.model.sk.hipY, height: m.height, shown: [...document.querySelectorAll('.size-val')].map((e) => e.textContent).join(' ') }; });
  check('dragging a slider rebuilds the machine taller and larger', stretched.prop.size === 1.2 && stretched.prop.legs === 1.3 && stretched.scale === 1.2 && stretched.hipY > 13.5 && stretched.height > 24 && /×1.20/.test(stretched.shown), JSON.stringify(stretched));
  await page.click('.size-reset');
  const unstretched = await page.evaluate(() => ({ prop: window.__game.player.build.prop, scale: window.__game.player.mech.spec.scale }));
  check('RESET puts the proportions back', Object.values(unstretched.prop).every((v) => v === 1) && unstretched.scale === 1, JSON.stringify(unstretched));
  await page.click('#g-reset');
  const rigReset = await page.evaluate(() => ({ b: window.__game.player.build, limbs: window.__game.player.mech.model.rig.limbs.length }));
  check('RESET in the garage clears every socket and the layout', rigReset.b.armUpperL === 'none' && rigReset.b.armUpperR === 'none' && rigReset.b.layout === 'biped' && rigReset.limbs === 0, JSON.stringify([rigReset.b.armUpperL, rigReset.b.layout, rigReset.limbs]));

  // equip a part by clicking it: the build, stats and live model all change
  await page.click('.g-tab[data-tab="chest"]');
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
    g.commit({ ...g.build, ...window.__L({ torso: 'heavy', legs: 'sprint', shoulder: 'bulwark', arms: 'assault', backpack: 'booster', weapon: 'bazooka', offhand: 'cannon', sub: 'repair', head: 'visor' }) });
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

  // ---- shoulders, mounts and the symmetry switch
  await page.click('#g-reset');
  await page.click('.g-tab[data-tab="shoulderL"]');
  check('the shoulder hardpoint offers an armor slot and a weapon mount, with symmetry on by default', (await page.$$('#g-slots .g-slot')).length === 2 && /ON/.test(await page.textContent('#g-sym')));
  await page.click('.opt[data-id="bulwark"]');
  const symOn = await page.evaluate(() => ({ L: window.__game.player.build.shoulderL, R: window.__game.player.build.shoulderR, sym: window.__game.player.build.sym, spec: [window.__game.player.mech.def.spec.shoulderL, window.__game.player.mech.def.spec.shoulderR] }));
  check('with symmetry on, one pick fits both shoulders', symOn.L === 'bulwark' && symOn.R === 'bulwark' && symOn.sym && symOn.spec.every((x) => x === 'bulwark'), JSON.stringify(symOn));
  await page.click('#g-sym');
  check('the SYMMETRY switch turns off', /OFF/.test(await page.textContent('#g-sym')) && !(await page.evaluate(() => window.__game.player.build.sym)));
  await page.click('.opt[data-id="spike"]');
  const symOff = await page.evaluate(() => ({ L: window.__game.player.build.shoulderL, R: window.__game.player.build.shoulderR, hp: window.__game.player.stats.hp }));
  check('with symmetry off, the left shoulder changes alone and the two sides can differ', symOff.L === 'spike' && symOff.R === 'bulwark', JSON.stringify(symOff));
  await page.click('.g-tab[data-tab="shoulderR"]');
  check('the right shoulder tab shows its own pick', (await page.$eval('.opt.selected', (e) => e.dataset.id)) === 'bulwark');
  await page.click('#g-sym');
  const symBack = await page.evaluate(() => ({ L: window.__game.player.build.shoulderL, R: window.__game.player.build.shoulderR }));
  check('turning symmetry back on copies the side you are looking at across', symBack.L === 'bulwark' && symBack.R === 'bulwark', JSON.stringify(symBack));
  await page.click('#g-sym'); // off again for the mounts
  await page.click('.g-tab[data-tab="shoulderL"]');
  await page.click('.g-slot[data-slot="mountL"]');
  await page.click('.opt[data-id="cannon"]');
  await page.click('.g-tab[data-tab="shoulderR"]');
  await page.click('.g-slot[data-slot="mountR"]');
  await page.click('.opt[data-id="swarm"]');
  const mounts = await page.evaluate(() => {
    const p = window.__game.player;
    return { build: [p.build.mountL, p.build.mountR], mounts: p.mounts.map((m) => `${m.key}:${m.def.kind}:${m.def.side}`), spec: [p.mech.def.spec.mountL, p.mech.def.spec.mountR],
      rows: ['cannon-row', 'cannon2-row'].map((id) => getComputedStyle(document.getElementById(id)).display !== 'none'), summary: document.getElementById('g-summary').textContent };
  });
  check('each shoulder carries its own mount; the first fires on F and the second on G', mounts.build[0] === 'cannon' && mounts.build[1] === 'swarm' && mounts.mounts.join(',') === 'KeyF:cannon:L,KeyG:swarm:R' && mounts.spec.join() === 'cannon,swarm', JSON.stringify(mounts));
  check('the loadout panel lists both mounts', /MOUNT F[^]*cannon|MOUNT F\s*SHOULDER CANNON/i.test(mounts.summary) && /MOUNT G/.test(mounts.summary), mounts.summary.slice(0, 120));
  const markingsTab = await page.evaluate(() => { document.querySelector('.g-tab[data-tab="paint"]').click(); return [...document.querySelectorAll('.mark')].map((b) => b.dataset.mark); });
  check('the paint tab offers markings', markingsTab.join() === 'none,stripe,chevron,hazard', markingsTab.join());
  await page.click('.mark[data-mark="hazard"]');
  check('a marking is applied to the model and saved', await page.evaluate(() => window.__game.player.mech.def.spec.marks === 'hazard' && JSON.parse(localStorage.getItem('steel-vanguard.hangar')).slots[0].marks === 'hazard'));
  await page.click('.mark[data-mark="none"]');

  // ---- the hangar: six builds, one on the pad
  const hangar0 = await page.evaluate(() => ({ slots: document.querySelectorAll('.hg-slot').length, empty: document.querySelectorAll('.hg-slot.empty').length, active: document.querySelector('.hg-slot.active')?.textContent, copyOff: document.getElementById('hg-copy').disabled, clearOff: document.getElementById('hg-clear').disabled }));
  check('the hangar bar has six slots, one filled; CLEAR is disabled while it is the only build', hangar0.slots === 6 && hangar0.empty === 5 && hangar0.active === '1' && !hangar0.copyOff && hangar0.clearOff, JSON.stringify(hangar0));
  await page.click('.hg-slot[data-slot="2"]');
  const slot3 = await page.evaluate(() => ({ active: window.__game.player.build.name, weapon: window.__game.player.build.weapon, shoulder: window.__game.player.build.shoulderL, mount: window.__game.player.build.mountL }));
  check('an empty hangar slot starts a fresh stock mech', slot3.active === 'MECH-03' && slot3.weapon === 'rifle' && slot3.shoulder === 'std' && slot3.mount === 'none', JSON.stringify(slot3));
  await page.click('.g-tab[data-tab="handR"]');
  await page.click('.opt[data-id="lance"]');
  await page.click('.hg-slot[data-slot="0"]');
  check('switching back restores the first build, untouched', (await page.evaluate(() => [window.__game.player.build.name, window.__game.player.build.weapon, window.__game.player.build.mountL])).join() === 'AEGIS-01,rifle,cannon');
  await page.click('.hg-slot[data-slot="2"]');
  check('and the third kept its own weapon', (await page.evaluate(() => window.__game.player.build.weapon)) === 'lance');
  await page.click('#hg-copy');
  const copied = await page.evaluate(() => ({ active: window.__game.player.build.name, weapon: window.__game.player.build.weapon, slot: document.querySelector('.hg-slot.active')?.dataset.slot, filled: document.querySelectorAll('.hg-slot:not(.empty)').length }));
  check('COPY duplicates the build into the next empty slot', copied.weapon === 'lance' && copied.slot === '1' && copied.filled === 3 && /-2$/.test(copied.active), JSON.stringify(copied));
  await page.click('#hg-clear');
  const cleared = await page.evaluate(() => ({ filled: document.querySelectorAll('.hg-slot:not(.empty)').length, active: document.querySelector('.hg-slot.active')?.dataset.slot }));
  check('CLEAR empties the slot and moves to another build', cleared.filled === 2 && cleared.active !== '1', JSON.stringify(cleared));
  const savedHangar = await page.evaluate(() => { const h = JSON.parse(localStorage.getItem('steel-vanguard.hangar')); return { n: h.slots.filter(Boolean).length, active: h.active }; });
  check('the whole hangar is saved', savedHangar.n === 2, JSON.stringify(savedHangar));
  await page.evaluate(async () => { // back to a single stock build for the rest of the suite
    const H = await import('/src/hangar.js');
    window.__garage.hangar = H.cleanHangar(null);
    window.__garage._loadActive();
  });
  check('the hangar can be reset to one stock build', (await page.evaluate(() => [window.__game.player.build.name, document.querySelectorAll('.hg-slot:not(.empty)').length])).join() === 'AEGIS-01,1');

  // persistence across a reload, and the title screen reflects it
  await page.click('.g-tab[data-tab="handR"]');
  await page.click('.opt[data-id="sniper"]');
  await page.fill('#g-name', 'longshot');
  await page.keyboard.press('Enter');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__garage);
  await page.evaluate(() => { window.__game.launchIntro = false; }); // a fresh page launches from the catapult again
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
    // keep pressing through the combo: the lunge in, then forehand, backhand, thrust and the finisher
    for (let i = 0; i < 16; i++) {
      T.tap('Mouse2');
      for (let k = 0; k < 10; k++) { g.step(1); if (p.melee) stages.push(p.melee.stage); }
    }
    g.step(60);
    out.sabreDamage = shp - s.mech.hp;
    out.comboStages = [...new Set(stages)].filter((st) => st >= 0);
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
  check('sabre combo chains four stages', weapons.comboStages.length === 4, `stages ${weapons.comboStages}`);
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
      g.setBuild({ ...P.DEFAULT_BUILD, paint: { ...P.DEFAULT_BUILD.paint }, ...window.__L(patch) });
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
    // keep tapping so the combo chains all the way: stage 0 -> 1 -> 2 -> 3
    for (let k = 0; k < 16; k++) {
      T.tap('Mouse0');
      for (let i = 0; i < 10; i++) { g.step(1); if (g.player.melee) { swung = true; if (g.player.melee.stage >= 0) stages.add(g.player.melee.stage); } }
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
  check('twin sabers: LMB swings the 4-stage combo and there is no gun', loadouts.sabers.swung && loadouts.sabers.stages.length === 4 && loadouts.sabers.dealt > 500 && loadouts.sabers.noProjectiles && loadouts.sabers.meleeOnly, JSON.stringify(loadouts.sabers.stages));
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
      g.setBuild({ ...P.DEFAULT_BUILD, paint: { ...P.DEFAULT_BUILD.paint }, tuning: { ...P.DEFAULT_BUILD.tuning }, ...window.__L(patch) });
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
      g.setBuild({ ...P.DEFAULT_BUILD, paint: { ...P.DEFAULT_BUILD.paint }, tuning: { ...P.DEFAULT_BUILD.tuning }, ...window.__L(patch) });
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
    g.setBuild({ ...window.__garage.build, name: 'PITTER', head: 'vfin', torso: 'std', arms: 'std', legs: 'std', shoulderL: 'std', shoulderR: 'std', mountL: 'none', mountR: 'none', backpack: 'std', core: 'std', pilot: 'rookie', weapon: 'rifle', offhand: 'shield', sub: 'none', tuning: { plating: 0, servos: 0, thrusters: 0, weapons: 0 } });
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
  await page.click('.g-tab[data-tab="chest"]');
  await page.locator('.opt[data-id="heavy"]').scrollIntoViewIfNeeded();
  await page.click('.opt[data-id="heavy"]');
  await page.click('.g-tab[data-tab="handR"]');
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

  // ------------------------------------------------------------ 5g. models: every part builds, and the model exposes what the garage needs
  const models = await page.evaluate(async () => {
    const P = await import('/src/parts.js');
    const { buildMech, ANCHORS } = await import('/src/mechModel.js');
    const THREE = await import('three');
    const out = { failures: [], built: 0, meshCounts: {}, anchors: null, mountsNeeded: [], distinct: {} };
    const base = P.deriveMech(P.DEFAULT_BUILD).spec;
    const seen = new Map();
    const box = new THREE.Box3();
    for (const slot of P.SLOTS) {
      const pool = P.poolOf(slot);
      for (const part of P.partsFor(slot)) {
        try {
          const patch = { [slot]: part.id };
          const spec = P.deriveMech({ ...P.DEFAULT_BUILD, ...patch }).spec;
          const model = buildMech(spec);
          out.built++;
          model.update(1 / 60, { speed: 0, localFwd: 0, localRight: 0, grounded: true, boost: 0, pitch: 0, stagger: 0, charge: 0 });
          model.root.updateWorldMatrix(true, true);
          let n = 0;
          const sig = [];
          const mb = new THREE.Box3();
          model.root.traverse((o) => {
            if (!o.isMesh) return;
            n++;
            mb.setFromObject(o);
            sig.push([mb.min.x, mb.min.y, mb.min.z, mb.max.x, mb.max.y, mb.max.z].map((v) => Math.round(v * 10)).join(','));
          });
          const key = `${pool}:${part.id}`;
          out.meshCounts[key] = n;
          seen.set(key, sig.sort().join('|'));
          box.setFromObject(model.root);
          if (![box.min.x, box.max.x, box.min.y, box.max.y].every(Number.isFinite) || box.max.y < 10 || box.max.y > 40) out.failures.push(`${key} height ${box.max.y.toFixed(1)}`);
          if (box.min.y < -0.5) out.failures.push(`${key} below ground ${box.min.y.toFixed(2)}`);
        } catch (err) {
          out.failures.push(`${slot}:${part.id} ${err.message}`);
        }
      }
    }
    // the default mech: every anchor exists, and the markers' anchors are spread from the head to the feet
    const m = buildMech(base);
    m.update(1 / 60, { speed: 0, localFwd: 0, localRight: 0, grounded: true, boost: 0, pitch: 0, stagger: 0, charge: 0 });
    const ys = {};
    for (const a of ANCHORS) { const v = m.anchorWorld(a, new THREE.Vector3()); ys[a] = [Number(v.x.toFixed(1)), Number(v.y.toFixed(1)), Number(v.z.toFixed(1))]; }
    out.anchors = ys;
    // mounts: the muzzles of a cannon on the left shoulder and a pod on the right are on the right sides and above the shoulders
    const withMounts = buildMech(P.deriveMech({ ...P.DEFAULT_BUILD, mountL: 'cannon', mountR: 'swarm' }).spec);
    withMounts.update(1 / 60, { speed: 0, localFwd: 0, localRight: 0, grounded: true, boost: 0, pitch: 0, stagger: 0, charge: 0 });
    const mL = withMounts.mountMuzzleWorld('L', new THREE.Vector3()), mR = withMounts.mountMuzzleWorld('R', new THREE.Vector3());
    const mainMuzzle = withMounts.muzzleWorld(new THREE.Vector3());
    out.muzzles = { L: [mL.x, mL.y, mL.z].map((v) => Number(v.toFixed(1))), R: [mR.x, mR.y, mR.z].map((v) => Number(v.toFixed(1))), main: [mainMuzzle.x, mainMuzzle.y, mainMuzzle.z].map((v) => Number(v.toFixed(1))) };
    const bare = buildMech(base);
    const bareL = bare.mountMuzzleWorld('L', new THREE.Vector3());
    const bareMain = bare.muzzleWorld(new THREE.Vector3());
    out.fallback = bareL.distanceTo(bareMain);
    // different parts really look different: the shape signature (triangle count per part) is not the same for every option in a pool
    out.sameLook = [];
    for (const slot of ['head', 'torso', 'arms', 'legs', 'shoulderL', 'mountL', 'backpack', 'core', 'skirt', 'weapon', 'offhand', 'sub', 'crest']) {
      const ids = P.partsFor(slot).map((p) => p.id);
      const sigs = ids.map((id) => seen.get(`${P.poolOf(slot)}:${id}`));
      // every option is its own silhouette (the crest that comes with a helmet is the same as that crest picked by hand, so one repeat is fine there)
      const allowed = slot === 'crest' ? 1 : 0;
      const dupes = ids.filter((id, i) => sigs.indexOf(sigs[i]) !== i);
      if (dupes.length > allowed) out.sameLook.push(`${slot}: ${dupes.join(',')} repeat another option`);
    }
    // the redesign's proportions: a slim mech with long legs
    const dims = new THREE.Box3().setFromObject(m.root);
    out.size = { h: Number((dims.max.y - dims.min.y).toFixed(1)), w: Number((dims.max.x - dims.min.x).toFixed(1)) };
    return out;
  });
  dump('models', models);
  check('every part in every slot builds a model without errors, standing on the ground', models.failures.length === 0 && models.built >= 100, `${models.built} models${models.failures.length ? ': ' + models.failures.slice(0, 3).join(' | ') : ''}`);
  check('the model locates all 20 hardpoints, head highest and the legs lowest', Object.keys(models.anchors).length === 20 && models.anchors.head[1] > models.anchors.chest[1] && models.anchors.chest[1] > models.anchors.waist[1] && models.anchors.waist[1] > models.anchors.legs[1] && models.anchors.legs[1] > 0, JSON.stringify(models.anchors));
  check('the left and right shoulder anchors are on opposite sides', models.anchors.shoulderL[0] * models.anchors.shoulderR[0] < 0 && Math.abs(models.anchors.shoulderL[0] + models.anchors.shoulderR[0]) < 1.5);
  check('each shoulder mount fires from its own shoulder (L is the mech\'s left, R its right), well clear of the hand gun', models.muzzles.L[0] < -2 && models.muzzles.R[0] > 2 && models.muzzles.L[1] > 14 && models.muzzles.R[1] > 14 && models.fallback < 1e-6, JSON.stringify(models.muzzles));
  check('every option in every pool is its own silhouette (no part reuses another\'s model)', models.sameLook.length === 0, models.sameLook.join(' | '));
  check('the redesigned mech is slim and tall: taller than it is wide', models.size.h > 17 && models.size.w < models.size.h * 1.0, JSON.stringify(models.size));

  // ------------------------------------------------------------ 5k. the modular rig: layouts, proportions, extra arms, heads, a tail, pods
  const rigm = await page.evaluate(async () => {
    const P = await import('/src/parts.js');
    const { buildMech, ANCHORS } = await import('/src/mechModel.js');
    const THREE = await import('three');
    const idle = { speed: 0, localFwd: 0, localRight: 0, grounded: true, boost: 0, pitch: 0, stagger: 0, charge: 0 };
    const mk = (patch) => buildMech(P.deriveMech({ ...P.DEFAULT_BUILD, ...patch }).spec);
    const settle = (m, n = 40, s = idle) => { for (let i = 0; i < n; i++) m.update(1 / 60, s); m.root.updateWorldMatrix(true, true); };
    const box = (m) => new THREE.Box3().setFromObject(m.root);
    const out = { layouts: {}, errors: [] };

    // every layout: how many legs, how big, standing on the ground
    for (const id of ['biped', 'quad', 'hexa', 'tread', 'hover']) {
      try {
        const m = mk({ layout: id });
        settle(m);
        const b = box(m);
        out.layouts[id] = { legs: m.rig.legs.length, kind: m.sk.kind, hipY: Number(m.sk.hipY.toFixed(2)), top: Number(b.max.y.toFixed(1)), minY: Number(b.min.y.toFixed(2)), w: Number((b.max.x - b.min.x).toFixed(1)),
          height: Number(m.height.toFixed(1)), radius: m.radius, treads: m.rig.treads?.length ?? 0, pods: m.rig.pods?.length ?? 0, calf: m.rig.calfFlames };
      } catch (err) { out.errors.push(`${id}: ${err.message}`); }
    }

    // walking: every foot of a quad or a spider plants and lifts, none sinks, and a planted foot does not slide
    const walk = (patch) => {
      const m = mk(patch), feet = m.rig.legs.map((l) => l.foot), pos = new THREE.Vector3(), speed = 36;
      settle(m, 20);
      const prev = feet.map(() => null), travel = [];
      let minY = 99, maxY = -99, planted = 0, finite = true;
      for (let i = 0; i < 160; i++) {
        m.root.position.z -= speed / 60;
        m.update(1 / 60, { ...idle, speed, localFwd: speed });
        m.root.updateWorldMatrix(true, true);
        feet.forEach((f, j) => {
          f.getWorldPosition(pos);
          if (!Number.isFinite(pos.y)) finite = false;
          if (i > 50) { minY = Math.min(minY, pos.y); maxY = Math.max(maxY, pos.y); }
          if (prev[j] && i > 50 && pos.y < 0.9 && prev[j].y < 0.9) { planted++; travel.push(Math.hypot(pos.x - prev[j].x, pos.z - prev[j].z)); }
          prev[j] = pos.clone();
        });
      }
      travel.sort((a, b) => a - b);
      // a planted foot stays where it is on the ground, so the typical (median) low foot barely moves; only the first and last frames of a swing are fast
      return { minY: Number(minY.toFixed(2)), maxY: Number(maxY.toFixed(2)), slip: Number((travel[Math.floor(travel.length / 2)] ?? 0).toFixed(3)), planted, finite, body: speed / 60 };
    };
    out.walk = { quad: walk({ layout: 'quad' }), hexa: walk({ layout: 'hexa' }), biped: walk({}) };

    // treads roll with the ground and against each other when turning on the spot; hover bobs and pulses
    const t = mk({ layout: 'tread' });
    settle(t, 20);
    const off = () => t.rig.treads.map((x) => x.tex.offset.x);
    const wheel = () => t.rig.treads[0].wheels[0].g.rotation.x;
    const o0 = off(), w0 = wheel();
    settle(t, 40, { ...idle, speed: 50, localFwd: 50 });
    const o1 = off(), w1 = wheel();
    settle(t, 40, { ...idle, turnRate: 2.5 });
    const o2 = off();
    out.tread = { driven: [o1[0] - o0[0], o1[1] - o0[1]], wheel: w1 - w0, spin: [o2[0] - o1[0], o2[1] - o1[1]] };
    const h = mk({ layout: 'hover' });
    settle(h, 10);
    const ys = [];
    for (let i = 0; i < 90; i++) { h.update(1 / 60, idle); ys.push(h.hips.position.y); }
    out.hover = { bob: Math.max(...ys) - Math.min(...ys), jets: h.rig.pods.every((p) => p.jetMat.opacity > 0.05), ring: !!h.rig.groundRing };

    // proportions: legs, arms and the head really change the model
    const stock = mk({}); settle(stock);
    const longLegs = mk({ prop: { size: 1, legs: 1.4, arms: 1, torso: 1, head: 1 } }); settle(longLegs);
    const longArms = mk({ prop: { size: 1, legs: 1, arms: 1.4, torso: 1, head: 1 } }); settle(longArms);
    const bigHead = mk({ prop: { size: 1, legs: 1, arms: 1, torso: 1, head: 1.5 } }); settle(bigHead);
    const reach = (m) => m.anchorWorld('handR', new THREE.Vector3()).distanceTo(m.anchorWorld('shoulderR', new THREE.Vector3()));
    const headW = (m) => { const b = new THREE.Box3().setFromObject(m.head); return b.max.x - b.min.x; };
    out.prop = { stock: { hipY: stock.sk.hipY, top: box(stock).max.y, radius: stock.radius, height: stock.height, limbs: stock.rig.limbs.length, reach: reach(stock) },
      legs: { hipY: longLegs.sk.hipY, top: box(longLegs).max.y, minY: box(longLegs).min.y }, arms: { reach: reach(longArms), upper: longArms.sk.upper }, head: headW(bigHead) / headW(stock) };

    // extra arms: where they are, what they carry, how they aim
    const arms = mk({ armLowerL: 'gun', armLowerR: 'cannon', armUpperL: 'blade', armUpperR: 'launcher' });
    settle(arms);
    const at = (n, i) => { const v = arms.limbMuzzleWorld(i, new THREE.Vector3()); return n ? [Number(v.x.toFixed(1)), Number(v.y.toFixed(1)), Number(v.z.toFixed(1))] : v; };
    const main = arms.muzzleWorld(new THREE.Vector3());
    const handToMuzzle = (i) => { const l = arms.rig.limbs[i]; const a = l.hand.getWorldPosition(new THREE.Vector3()), b = l.muzzle.getWorldPosition(new THREE.Vector3()); return b.sub(a).normalize(); };
    arms.fireLimb(0, 0.5);
    settle(arms, 14, { ...idle, pitch: 0 });
    const aimed = handToMuzzle(0);
    out.arms = { kinds: arms.rig.limbs.map((l) => `${l.slot}:${l.kind}`), muzzles: arms.rig.limbs.map((l) => !!l.muzzle), gunAt: at(true, 0), cannonAt: at(true, 2 - 1), blade: !!arms.rig.limbs[2].blade, apart: at(false, 0).distanceTo(main),
      aimed: [aimed.x, aimed.y, aimed.z].map((v) => Number(v.toFixed(2))), lowerY: arms.rig.limbs[0].hand.getWorldPosition(new THREE.Vector3()).y, upperY: arms.rig.limbs[2].hand.getWorldPosition(new THREE.Vector3()).y };
    arms.setSaber(true);
    settle(arms, 40);
    out.arms.bladeOut = arms.rig.limbs[2].blade.scale.y;
    arms.setSaber(false);
    settle(arms, 40);
    out.arms.bladeIn = arms.rig.limbs[2].blade.scale.y;
    for (const kind of ['gun', 'cannon', 'blade', 'shield', 'launcher', 'repair']) {
      try { const m = mk({ armLowerL: kind, armUpperR: kind }); settle(m, 20, { ...idle, speed: 40, localFwd: 40 }); m.root.updateWorldMatrix(true, true); } catch (err) { out.errors.push(`arm ${kind}: ${err.message}`); }
    }

    // side heads, tail, pods
    const full = mk({ headL: 'ace', headR: 'hawk', tail: 'lash', podL: 'thruster', podR: 'missile' });
    settle(full);
    const stockFlames = stock.rig.flames.length;
    out.parts = { heads: full.rig.sideHeads.length, tail: full.rig.tail?.segs.length, pods: full.rig.pods2.map((p) => p.kind), flames: full.rig.flames.length - stockFlames };
    const yaw0 = full.rig.sideHeads.map((s) => s.head.rotation.y);
    settle(full, 90, { ...idle, relaxed: true });
    out.parts.scan = full.rig.sideHeads.some((s, i) => Math.abs(s.head.rotation.y - yaw0[i]) > 0.02);
    const seg0 = full.rig.tail.segs.map((s) => s.rotation.x + s.rotation.y);
    settle(full, 20, { ...idle, speed: 120, localFwd: 120 });
    settle(full, 1, { ...idle, speed: 0 });
    out.parts.tailMoved = full.rig.tail.segs.some((s, i) => Math.abs(s.rotation.x + s.rotation.y - seg0[i]) > 0.02);
    const an = {};
    for (const a of ANCHORS) { const v = full.anchorWorld(a, new THREE.Vector3()); an[a] = [v.x, v.y, v.z]; }
    out.anchors = an;
    for (const id of ['stabilizer', 'lash', 'booster']) { try { const m = mk({ tail: id }); settle(m, 30, { ...idle, speed: 40, localFwd: 40, boost: 1 }); } catch (err) { out.errors.push(`tail ${id}: ${err.message}`); } }
    for (const id of ['thruster', 'missile', 'plate']) { try { const m = mk({ podL: id, podR: id }); settle(m, 30, { ...idle, boost: 1 }); } catch (err) { out.errors.push(`pod ${id}: ${err.message}`); } }

    // every layout with every extra part at once: builds, runs, falls over and gets up without a non-finite number
    for (const id of ['biped', 'quad', 'hexa', 'tread', 'hover']) {
      try {
        const m = mk({ layout: id, armLowerL: 'gun', armLowerR: 'shield', armUpperL: 'blade', armUpperR: 'repair', headL: 'ace', headR: 'recon', tail: 'booster', podL: 'thruster', podR: 'plate' });
        const states = [{ ...idle }, { ...idle, speed: 60, localFwd: 60 }, { ...idle, grounded: false, vy: 40, boost: 1 }, { ...idle, grounded: false, vy: -80 }, { ...idle, knock: { phase: 'fall', t: 0.2 } },
          { ...idle, knock: { phase: 'lie', t: 0.3 } }, { ...idle, knock: { phase: 'rise', t: 0.3 } }, { ...idle, dying: 0.6 }, { ...idle, attack: { kind: 'slash1', t: 0.4 } }, { ...idle, relaxed: true }];
        for (const s of states) { settle(m, 25, s); }
        let ok = true;
        m.root.traverse((o) => { if (!Number.isFinite(o.position.x + o.position.y + o.position.z + o.rotation.x + o.rotation.y + o.rotation.z + o.scale.x + o.scale.y + o.scale.z)) ok = false; });
        if (!ok) out.errors.push(`${id}: non-finite transform after the poses`);
      } catch (err) { out.errors.push(`${id} full: ${err.message}`); }
    }
    return out;
  });
  dump('rig models', rigm);
  const L = rigm.layouts;
  check('rig: the layouts have 2, 4, 6, 0 and 0 legs, treads on two tracks and four hover pods', rigm.errors.length === 0 && L.biped.legs === 2 && L.quad.legs === 4 && L.hexa.legs === 6 && L.tread.legs === 0 && L.tread.treads === 2 && L.hover.legs === 0 && L.hover.pods === 4, JSON.stringify(rigm.errors.length ? rigm.errors : L));
  check('rig: every layout stands on the ground and reports its own size (a spider spreads wide, treads sit low)', Object.values(L).every((l) => l.minY > -0.6 && l.minY < 0.6) && L.hexa.w > L.biped.w * 1.6 && L.tread.height < L.biped.height * 0.7 && L.hover.height < L.biped.height && L.hexa.radius > L.biped.radius && L.biped.height === 19.4 && L.biped.hipY === 11.1, JSON.stringify(L));
  const W = rigm.walk;
  check('rig: a quad and a spider walk on planted feet (lifted, never sunk, not sliding)', ['quad', 'hexa'].every((k) => W[k].finite && W[k].minY > 0.1 && W[k].maxY > W[k].minY + 0.25 && W[k].planted > 100 && W[k].slip < W[k].body * 0.15) && W.biped.slip < W.biped.body * 0.15, JSON.stringify(W));
  check('rig: treads roll with the ground and counter-rotate to turn on the spot; hover bobs and glows', rigm.tread.driven.every((d) => Math.abs(d) > 0.2) && Math.abs(rigm.tread.wheel) > 1 && rigm.tread.spin[0] * rigm.tread.spin[1] < 0 && rigm.hover.bob > 0.2 && rigm.hover.jets && rigm.hover.ring, JSON.stringify([rigm.tread, rigm.hover]));
  const PR = rigm.prop;
  check('rig: proportions work: the stock model is unchanged, longer legs lift the pelvis, longer arms reach further, a bigger head is bigger', PR.stock.hipY === 11.1 && PR.stock.height === 19.4 && PR.stock.radius === 5.5 && PR.stock.limbs === 0
    && PR.legs.hipY > 14.5 && PR.legs.top > 22 && PR.legs.minY > -0.6 && PR.arms.reach > PR.stock.reach * 1.25 && Math.abs(PR.arms.upper - 3.8 * 1.4) < 1e-9 && PR.head > 1.3, JSON.stringify(PR));
  const A = rigm.arms;
  check('rig: extra arms hang from the right sockets with their tools (lower arms low, back arms high; each gun has its own muzzle)', A.kinds.join(',') === 'armLowerL:gun,armLowerR:cannon,armUpperL:blade,armUpperR:launcher' && A.muzzles.join() === 'true,true,false,true'
    && A.gunAt[0] < -1 && A.apart > 2 && A.upperY > A.lowerY + 3 && A.blade, JSON.stringify(A));
  check('rig: an arm gun that fires points along the aim, and an arm saber lights with the main saber and goes out with it', A.aimed[2] < -0.8 && Math.abs(A.aimed[1]) < 0.35 && A.bladeOut > 0.9 && A.bladeIn < 0.1, JSON.stringify([A.aimed, A.bladeOut, A.bladeIn]));
  const PA = rigm.parts;
  check('rig: side heads scan on their own, the tail has five segments and swings, two pods and a thruster flame fit on the back', PA.heads === 2 && PA.scan && PA.tail === 5 && PA.tailMoved && PA.pods.join() === 'thruster,missile' && PA.flames >= 1, JSON.stringify(PA));
  const an = rigm.anchors;
  check('rig: the sockets are where their names say (left and right, back arms above lower arms, tail behind, side heads at head height)', an.armLowerL[0] < 0 && an.armLowerR[0] > 0 && an.armUpperL[0] < 0 && an.armUpperR[0] > 0 && an.armUpperL[1] > an.armLowerL[1] + 2 && an.headL[0] < 0 && an.headR[0] > 0
    && Math.abs(an.headL[1] - an.head[1]) < 3 && an.podL[0] < 0 && an.podR[0] > 0 && an.tail[2] > an.waist[2] + 1, JSON.stringify(an));
  check('rig: every layout with every extra part builds and survives running, flying, falling, a knockdown, a breakdown, a saber stroke', rigm.errors.length === 0, rigm.errors.slice(0, 4).join(' | '));

  // gameplay: arm guns fire with the gun button, a saber build uses H, power limits them, heads share out missiles, a nano arm mends, a shield guards
  const rigPlay = await page.evaluate(async () => {
    const g = window.__game, T = window.__t;
    const P = await import('/src/parts.js');
    const { createEnemy } = await import('/src/ai.js');
    const out = {};
    const clear = () => { for (const e of g.enemies) e.mech.destroy(); g.enemies.length = 0; g.projectiles.clear(); };
    const dummy = (x, z) => {
      const e = createEnemy(g, 'bulwark', 1);
      e.mech.place(x, z, 0, 0);
      e.update = () => {};
      e.mech.hp = e.mech.maxHp = 100000;
      g.enemies.push(e);
      return e;
    };
    const fit = (patch) => { g.setBuild({ ...P.DEFAULT_BUILD, ...patch }); clear(); g.player.mech.place(0, 0, 0, 0); g.rig.yaw = 0; g.cheat.invincible = true; g.player.lockEnabled = false; g.player.lock = null; g.step(5); };
    const tally = () => {
      const seen = {};
      const orig = g.projectiles.spawn.bind(g.projectiles);
      g.projectiles.spawn = (o) => { if (o.team === 'player') { const k = Math.round(o.damage); seen[k] = (seen[k] || 0) + 1; } return orig(o); };
      return { seen, stop: () => { g.projectiles.spawn = orig; } };
    };
    const burst = (keys, frames) => {
      const t = tally();
      T.keys(keys);
      for (let i = 0; i < frames; i++) { g.step(1); g.player.ammo = g.player.magSize; }
      T.keys([], keys);
      t.stop();
      return t.seen;
    };

    // 1. arm guns fire with the gun button, alongside the rifle
    fit({ armLowerL: 'gun', armLowerR: 'cannon' });
    out.limbGuns = g.player.limbGuns.map((l) => `${l.def.kind}@${l.idx}`).join(',');
    dummy(0, -120);
    out.fire = burst(['Mouse0'], 90);
    // 2. nothing fires without the button
    out.idleShots = burst([], 60);
    // 3. a saber build: the button swings the blade, H fires the arm guns
    fit({ weapon: 'greatsword', armLowerL: 'gun' });
    out.meleeOnly = g.player.meleeOnly;
    dummy(0, -120);
    out.withH = burst(['KeyH'], 60);
    out.withoutH = burst([], 60);
    // 4. power: four arm guns overdraw the reactor and each one slows down
    fit({ armLowerL: 'gun' });
    dummy(0, -120);
    const one = burst(['Mouse0'], 240)[17] ?? 0;
    const pf1 = g.player.stats.powerFactor;
    fit({ armLowerL: 'gun', armLowerR: 'gun', armUpperL: 'gun', armUpperR: 'gun' });
    dummy(0, -120);
    const four = burst(['Mouse0'], 240)[17] ?? 0;
    out.power = { pf1, pf4: g.player.stats.powerFactor, one, perGun: four / 4 };
    // 5. heads share the missiles out among the locked targets; launcher arms make the salvo bigger
    fit({ headL: 'ace', headR: 'ace', armUpperL: 'launcher' });
    const a = dummy(-30, -110), b = dummy(0, -120), c = dummy(30, -110);
    g.player.lockEnabled = true;
    g.player.lock = a.mech;
    let sub = 0;
    const hud = g.hud, orig = hud._subReticle.bind(hud);
    hud._subReticle = (...args) => { sub++; return orig(...args); };
    g.step(3);
    sub = 0;
    g.step(1); // the HUD draws its markers during the step
    hud._subReticle = orig;
    out.subReticles = sub;
    out.locks = { extra: g.player.extraLocks.length, salvo: g.player.stats.salvo, lockMax: g.player.stats.lock };
    g.player.missiles = g.player.stats.missileCharges;
    g.player.missileQueue.length = 0;
    g.player._fireMissiles();
    out.shared = { queued: g.player.missileQueue.length, targets: new Set(g.player.missileQueue.map((q) => q.target)).size };
    void b; void c;
    fit({});
    dummy(0, -120);
    g.player.lockEnabled = true;
    g.step(3);
    out.stockLocks = { extra: g.player.extraLocks.length, salvo: g.player.stats.salvo };
    // 6. a nano arm mends armor once left alone; a shield arm soaks fire
    fit({ armLowerL: 'repair' });
    const m = g.player.mech;
    m.hp = m.maxHp - 800;
    m.lastHitAt = -99;
    g.player.lastHitAt = -99;
    const hp0 = m.hp;
    g.step(60 * 4);
    out.repair = { regen: g.player.stats.regen, gained: m.hp - hp0 };
    fit({});
    const guardStock = g.player.mech.def.guard;
    fit({ armLowerL: 'shield', armLowerR: 'shield' });
    out.guard = { stock: guardStock, shielded: g.player.mech.def.guard, stagger: g.player.mech.def.staggerAt };
    // 7. proportions reach the sortie: a bigger machine is a bigger target
    fit({ prop: { size: 1.3, legs: 1, arms: 1, torso: 1, head: 1 } });
    out.big = { scale: g.player.mech.spec.scale, height: g.player.mech.height, radius: g.player.mech.radius, hp: g.player.mech.maxHp };
    // 8. every layout moves around the city for a few seconds without leaving the world, sinking into a building or going non-finite
    out.layouts = {};
    for (const layout of ['quad', 'hexa', 'tread', 'hover']) {
      fit({ layout });
      const mm = g.player.mech;
      let bad = 0, inside = 0, minY = 99;
      for (let i = 0; i < 360; i++) {
        T.keys(i % 120 < 80 ? ['KeyW'] : ['KeyD'], i % 120 < 80 ? ['KeyD'] : ['KeyW']);
        if (i % 90 === 40) g.input.keyDown('Space'); else if (i % 90 === 70) g.input.keyUp('Space');
        g.step(1);
        if (!T.allFinite()) bad++;
        if (T.insideBuilding()) inside++;
        minY = Math.min(minY, mm.pos.y);
      }
      T.keys([], ['KeyW', 'KeyD', 'Space']);
      out.layouts[layout] = { bad, inside, minY: Number(minY.toFixed(2)), radius: mm.radius, speed: g.player.stats.speed };
    }
    fit({});
    clear();
    return out;
  });
  dump('rig play', rigPlay);
  check('rig: the arm guns are found on the model by their socket', rigPlay.limbGuns === 'gun@0,cannon@1', rigPlay.limbGuns);
  check('rig: holding the gun button fires the rifle and both arm guns, each on its own timing', (rigPlay.fire[210] ?? 0) >= 1 && (rigPlay.fire[17] ?? 0) >= 6 && (rigPlay.fire[240] ?? 0) >= 1 && (rigPlay.fire[240] ?? 0) <= 2, JSON.stringify(rigPlay.fire));
  check('rig: nothing fires without the button', Object.keys(rigPlay.idleShots).length === 0, JSON.stringify(rigPlay.idleShots));
  check('rig: a saber build fires its arm guns with H (and not on their own)', rigPlay.meleeOnly && (rigPlay.withH[17] ?? 0) >= 4 && Object.keys(rigPlay.withoutH).length === 0, JSON.stringify([rigPlay.withH, rigPlay.withoutH]));
  check('rig: four arm guns overdraw the reactor and each fires slower than a lone one', rigPlay.power.pf1 === 1 && rigPlay.power.pf4 < 0.95 && rigPlay.power.perGun < rigPlay.power.one * 0.97 && rigPlay.power.one >= 17, JSON.stringify(rigPlay.power));
  check('rig: two side heads hold three locks and a launcher arm makes the salvo six; every locked target gets missiles', rigPlay.locks.extra === 2 && rigPlay.locks.lockMax === 3 && rigPlay.locks.salvo === 6 && rigPlay.shared.queued === 6 && rigPlay.shared.targets === 3, JSON.stringify([rigPlay.locks, rigPlay.shared]));
  check('rig: the HUD draws a bracket on each secondary lock, and a stock machine has none', rigPlay.subReticles === 2 && rigPlay.stockLocks.extra === 0 && rigPlay.stockLocks.salvo === 4, JSON.stringify([rigPlay.subReticles, rigPlay.stockLocks]));
  check('rig: a nano arm mends armor when left alone; shield arms add guard and stagger resistance', rigPlay.repair.regen === 6 && rigPlay.repair.gained > 12 && rigPlay.guard.shielded > rigPlay.guard.stock + 0.1 && rigPlay.guard.stagger > 0, JSON.stringify([rigPlay.repair, rigPlay.guard]));
  check('rig: overall size scales the machine in the sortie (height, hit radius, armor)', rigPlay.big.scale === 1.3 && Math.abs(rigPlay.big.height - 19.4 * 1.3) < 0.01 && Math.abs(rigPlay.big.radius - 5.5 * 1.3) < 0.01 && rigPlay.big.hp > 3500, JSON.stringify(rigPlay.big));
  check('rig: quad, spider, treads and hover all run, jump and boost through the city without a bad number or sinking into a building', Object.values(rigPlay.layouts).every((l) => l.bad === 0 && l.inside === 0 && l.minY > -1), JSON.stringify(rigPlay.layouts));

  // ------------------------------------------------------------ 5f. animation
  const anim = await page.evaluate(async () => {
    const g = window.__game;
    const THREE = await import('three');
    const { createEnemy } = await import('/src/ai.js');
    const P = await import('/src/parts.js');
    const keep = { state: g.state, manual: g.manual };
    g.manual = true;
    g.state = 'ended'; // nothing else moves the mech while these run
    g.setBuild({ ...P.DEFAULT_BUILD, paint: { ...P.DEFAULT_BUILD.paint }, tuning: { ...P.DEFAULT_BUILD.tuning } });
    const m = g.player.mech;
    const box = new THREE.Box3();
    const out = {};
    const reset = (x, z, y, yaw) => { m.dead = false; m.stagger = 0; m.dashT = 0; m.dashCd = 0; m.en = m.maxEn; m.overheat = false; m.setSaber(false); m.vel.set(0, 0, 0); m.place(x, z, y, yaw); };
    const step = (mech, it) => { mech.update(1 / 60, it); g.time += 1 / 60; mech.root.updateWorldMatrix(true, true); };
    const feet = (mech) => mech.model.feet.map((f) => { box.setFromObject(f); return { y: box.min.y, x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2 }; });

    // planted-foot slip (as a share of the body's own travel), ground penetration and floating, over a gait
    const gait = (mech, it, steps = 240, warm = 60) => {
      let slip = 0, travel = 0, sink = 0, float = 0, prev = null;
      for (let i = 0; i < steps; i++) {
        const before = mech.pos.clone();
        step(mech, it(i));
        if (i < warm || !mech.grounded) { prev = null; continue; }
        travel += Math.hypot(mech.pos.x - before.x, mech.pos.z - before.z);
        const f = feet(mech);
        const k = f[0].y < f[1].y ? 0 : 1;
        sink = Math.min(sink, f[k].y);
        float = Math.max(float, f[k].y);
        if (prev && prev.k === k) slip += Math.hypot(f[k].x - prev.x, f[k].z - prev.z);
        prev = { k, x: f[k].x, z: f[k].z };
      }
      return { slip: slip / Math.max(travel, 1e-6), sink, float };
    };
    reset(0, 0, 0, Math.PI / 2);
    out.walk = gait(m, () => ({ moveX: -1, faceYaw: Math.PI / 2 }));
    reset(0, 0, 0, Math.PI / 2);
    out.walkSlow = gait(m, () => ({ moveX: -0.4, faceYaw: Math.PI / 2 }));
    reset(0, 0, 0, 0);
    out.strafe = gait(m, () => ({ moveX: 1, faceYaw: 0 }));
    out.strafeHips = m.model.hips.rotation.y;
    reset(0, 0, 0, Math.PI / 2);
    out.back = gait(m, () => ({ moveX: 1, faceYaw: Math.PI / 2 }));
    out.backHips = m.model.hips.rotation.y;
    reset(0, 0, 0, 0);
    out.diagonal = gait(m, () => ({ moveX: -0.7, moveZ: -0.7, faceYaw: 0 }));
    out.enemies = {};
    for (const type of ['drone', 'bulwark', 'baron']) {
      const e = createEnemy(g, type, 1);
      e.mech.place(300, 300, 0, Math.PI / 2);
      out.enemies[type] = gait(e.mech, () => ({ moveX: -1, faceYaw: Math.PI / 2 }));
      e.mech.destroy();
    }

    // a dash glides: both feet stay on the ground instead of sprinting
    reset(0, 0, 0, Math.PI / 2);
    for (let i = 0; i < 20; i++) step(m, {});
    let dashLift = 0;
    for (let i = 0; i < 16; i++) {
      step(m, i === 0 ? { dash: new THREE.Vector3(-1, 0, 0), faceYaw: Math.PI / 2 } : { faceYaw: Math.PI / 2 });
      if (i > 3) { const f = feet(m); dashLift = Math.max(dashLift, f[0].y, f[1].y); }
    }
    out.dashLift = dashLift;

    // a hard landing crouches, then stands back up
    reset(0, 0, 0, Math.PI / 2);
    for (let i = 0; i < 60; i++) step(m, {});
    const standing = m.model.hips.position.y;
    reset(0, 0, 60, Math.PI / 2);
    m.vel.y = -90;
    let minHip = Infinity, landedAt = -1;
    for (let i = 0; i < 120; i++) {
      step(m, {});
      if (m.grounded && landedAt < 0) landedAt = i;
      if (landedAt >= 0 && i - landedAt < 20) minHip = Math.min(minHip, m.model.hips.position.y);
    }
    out.landing = { standing, minHip, settled: m.model.hips.position.y };

    // idle breathes (not frozen); the garage and title stand at ease with the rifle lowered
    reset(0, 0, 0, 0);
    const ty = [];
    for (let i = 0; i < 120; i++) { step(m, {}); ty.push(m.model.torso.position.y); }
    out.breath = Math.max(...ty) - Math.min(...ty);
    out.readyArm = m.model.armR.arm.rotation.x;
    for (let i = 0; i < 40; i++) step(m, { relaxed: true });
    out.relaxedArm = m.model.armR.arm.rotation.x;

    // a shot snaps the gun arm up into the firing pose; it holds for a beat, then settles back to the ready
    for (let i = 0; i < 20; i++) step(m, {});
    const rest = m.model.armR.arm.rotation.x;
    m.model.recoil(1);
    step(m, {});
    const kicked = m.model.armR.arm.rotation.x;
    for (let i = 0; i < 90; i++) step(m, {});
    out.recoil = { rest, kicked, settled: m.model.armR.arm.rotation.x };

    // the saber: each slash sweeps the way it should, the chest turns with the arm, and the blade stays out of the ground
    reset(0, 0, 0, 0);
    m.setSaber(true);
    for (let i = 0; i < 20; i++) step(m, {});
    const tip = () => { const sab = m.model.saber; sab.updateWorldMatrix(true, true); return sab.localToWorld(new THREE.Vector3(0, -11.6, 0)); };
    out.slashes = {};
    let lowest = Infinity;
    for (const [kind, n] of [['slash1', 30], ['slash2', 30], ['slash3', 43]]) {
      const samples = [];
      for (let k = 0; k <= n; k++) {
        const it = { attack: { kind, t: k / n }, hover: true };
        step(m, it);
        for (let w = 0; w < 3; w++) m.update(1 / 240, it);
        m.root.updateWorldMatrix(true, true);
        const p = tip();
        lowest = Math.min(lowest, p.y);
        samples.push({ t: k / n, x: p.x, y: p.y, z: p.z, twist: m.model.torso.rotation.y });
      }
      const at = (t) => samples.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      out.slashes[kind] = { windup: at(0.28), strike: at(0.48) };
    }
    out.lowestTip = lowest;
    m.setSaber(false);

    // the garage preview plays the combo at its real speed: four strikes (three arcs and a thrust streak) per 3.22-second loop
    const arcsBefore = g.fx.timed.length;
    g.state = 'garage';
    g.garagePose = 'saber';
    g.time = Math.ceil(g.time / 3.22) * 3.22 + 0.01;
    for (let i = 0; i < Math.round(60 * 2.4); i++) { g._garagePose(1 / 60); g.time += 1 / 60; g.fx.update(0); }
    out.garageArcs = g.fx.timed.length - arcsBefore;
    g.garagePose = 'idle';
    m.setSaber(false);
    g.fx.clear();

    g.state = keep.state;
    g.manual = keep.manual;
    reset(0, 0, 0, 0);
    return out;
  });
  dump('animation', anim);
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  check('walking: a planted foot stays put (slip under 6% of the distance walked)', anim.walk.slip < 0.06 && anim.walkSlow.slip < 0.06, `${pct(anim.walk.slip)}, slow ${pct(anim.walkSlow.slip)}`);
  check('strafing, backing up and diagonals keep their feet planted too', anim.strafe.slip < 0.08 && anim.back.slip < 0.06 && anim.diagonal.slip < 0.06, `${pct(anim.strafe.slip)} / ${pct(anim.back.slip)} / ${pct(anim.diagonal.slip)}`);
  check('enemies of every size walk without sliding', Object.values(anim.enemies).every((e) => e.slip < 0.06), Object.entries(anim.enemies).map(([k, e]) => `${k} ${pct(e.slip)}`).join(', '));
  const allGaits = [anim.walk, anim.walkSlow, anim.strafe, anim.back, anim.diagonal, ...Object.values(anim.enemies)];
  check('feet neither sink into the ground nor float above it while walking', allGaits.every((r) => r.sink > -0.12 && r.float < 0.12), allGaits.map((r) => `${r.sink.toFixed(2)}..${r.float.toFixed(2)}`).join(' '));
  check('a strafe turns the hips toward travel; backing up steps backward instead of moonwalking', anim.strafeHips < -0.9 && Math.abs(anim.backHips) < 0.15, `strafe hips ${anim.strafeHips.toFixed(2)}, back ${anim.backHips.toFixed(2)}`);
  check('a dash glides with both feet down instead of sprinting', anim.dashLift < 0.3, `highest foot ${anim.dashLift.toFixed(2)}`);
  check('a hard landing crouches (the pelvis drops over a unit) and then stands back up', anim.landing.minHip < anim.landing.standing - 1.0 && anim.landing.settled > anim.landing.standing - 0.4, JSON.stringify(anim.landing));
  check('an idle mech breathes; at ease (garage, title) it lowers the rifle', anim.breath > 0.03 && anim.relaxedArm < 0.6 && anim.readyArm > 0.9, `breath ${anim.breath.toFixed(3)}, arm ${anim.readyArm.toFixed(2)} -> ${anim.relaxedArm.toFixed(2)}`);
  check('a shot kicks the gun arm up and it settles again after the held pose', anim.recoil.kicked > anim.recoil.rest + 0.15 && Math.abs(anim.recoil.settled - anim.recoil.rest) < 0.02, JSON.stringify(anim.recoil));
  const S = anim.slashes;
  check('slash 1 swings right to left and slash 2 left to right, the chest turning with the blade', S.slash1.windup.x > 5 && S.slash1.strike.x < -5 && S.slash1.strike.twist > S.slash1.windup.twist + 0.5
    && S.slash2.windup.x < -5 && S.slash2.strike.x > 5 && S.slash2.strike.twist < S.slash2.windup.twist - 0.5, JSON.stringify([S.slash1, S.slash2].map((x) => [x.windup.x.toFixed(1), x.strike.x.toFixed(1)])));
  check('slash 3 chops from overhead down to the front', S.slash3.windup.y > 15 && S.slash3.strike.y < S.slash3.windup.y - 8 && S.slash3.strike.z < -10, JSON.stringify([S.slash3.windup.y.toFixed(1), S.slash3.strike.y.toFixed(1), S.slash3.strike.z.toFixed(1)]));
  check('the saber never cuts into the ground', anim.lowestTip > 0.5, `lowest tip ${anim.lowestTip.toFixed(2)}`);
  check('the garage saber preview plays the combo at full speed, with its arcs', anim.garageArcs === 4, `${anim.garageArcs} arcs in one loop`);

  // ------------------------------------------------------------ 5h. the Gundam-style moves
  const moves = await page.evaluate(async () => {
    const g = window.__game, T = window.__t;
    const THREE = await import('three');
    const P = await import('/src/parts.js');
    const { createEnemy } = await import('/src/ai.js');
    const keep = { state: g.state, manual: g.manual };
    g.manual = true;
    g.state = 'ended'; // nothing else moves the mech while the poses are measured
    const V = THREE.Vector3;
    const out = {};
    const build = (patch = {}) => { g.setBuild({ ...P.DEFAULT_BUILD, paint: { ...P.DEFAULT_BUILD.paint }, tuning: { ...P.DEFAULT_BUILD.tuning }, ...patch }); return g.player.mech; };
    const reset = (m, x = 0, z = 0, y = 0, yaw = 0) => { m.dead = false; m.knock = null; m.stagger = 0; m.dashT = 0; m.dashCd = 0; m.skidT = 0; m.jumpT = 0; m.en = m.maxEn; m.overheat = false; m.invuln = 0; m.vel.set(0, 0, 0); m.place(x, z, y, yaw); };
    const step = (m, it = {}) => { m.update(1 / 60, it); g.time += 1 / 60; m.root.updateWorldMatrix(true, true); };
    const world = (o, x = 0, y = 0, z = 0) => { o.updateWorldMatrix(true, false); return o.localToWorld(new V(x, y, z)); };
    const dirOf = (o) => { const q = new THREE.Quaternion(); o.updateWorldMatrix(true, false); o.getWorldQuaternion(q); return new V(0, -1, 0).applyQuaternion(q); };

    // ---- firing: the arm snaps straight down the line of fire (level, elbow straight) and holds there for a beat
    let m = build();
    const rig = () => g.player.mech.model.rig;
    reset(m);
    for (let i = 0; i < 30; i++) step(m, { faceYaw: 0 });
    m.model.recoil(0.42);
    for (let i = 0; i < 14; i++) step(m, { faceYaw: 0 });
    const gun = dirOf(rig().rifle);
    out.shot = { fwd: -gun.z, y: gun.y, elbow: m.model.armR.elbow.rotation.x, twist: m.model.torso.rotation.y };
    for (let i = 0; i < 12; i++) step(m, { faceYaw: 0 });
    out.shotHeld = -dirOf(rig().rifle).z;

    // ---- a heavy gun takes both hands: the left hand sits on the bazooka's foregrip
    m = build({ weapon: 'bazooka' });
    reset(m);
    for (let i = 0; i < 40; i++) step(m, { faceYaw: 0 });
    const r = rig();
    out.grip = world(r.armL.hand).distanceTo(world(r.rifle, 0, r.foregrip, 0.2));
    m.model.recoil(1);
    for (let i = 0; i < 20; i++) step(m, { faceYaw: 0 });
    out.gripFiring = world(r.armL.hand).distanceTo(world(r.rifle, 0, r.foregrip, 0.2));
    out.bazookaLevel = dirOf(r.rifle).y;

    // ---- the saber: drawn from the backpack (the gun goes to the rear skirt), racked again afterwards
    m = build();
    reset(m);
    for (let i = 0; i < 20; i++) step(m, {});
    const R = rig();
    const hilt = () => world(R.torso, R.drawPoint.x, R.drawPoint.y, R.drawPoint.z);
    m.setSaber(true);
    let closest = Infinity;
    for (let i = 0; i < 24; i++) { step(m, {}); closest = Math.min(closest, world(R.armR.hand).distanceTo(hilt())); }
    out.draw = { closest, saber: R.saber.visible, gunInHand: R.rifle.visible, holstered: !!R.holster?.visible, hiltRacked: R.hilts.R.visible, blade: R.blade.scale.y };
    m.setSaber(false);
    let back = Infinity;
    for (let i = 0; i < 40; i++) { step(m, {}); back = Math.min(back, world(R.armR.hand).distanceTo(hilt())); }
    out.sheath = { back, saber: R.saber.visible, gunInHand: R.rifle.visible, holstered: !!R.holster?.visible, hiltRacked: R.hilts.R.visible };

    // ---- a jump crouches, then pushes off
    m = build();
    reset(m);
    for (let i = 0; i < 40; i++) step(m, {});
    const standHip = m.model.hips.position.y;
    let lowHip = Infinity, firstUp = -1;
    for (let i = 0; i < 20; i++) {
      step(m, { ascend: true });
      if (m.pos.y < 0.01) lowHip = Math.min(lowHip, m.model.hips.position.y);
      else if (firstUp < 0) firstUp = i;
    }
    out.jump = { standHip, lowHip, firstUp };

    // ---- a step leans hard into its direction and ends in a skid
    reset(m);
    for (let i = 0; i < 30; i++) step(m, { faceYaw: 0 });
    let roll = 0, skid = 0;
    for (let i = 0; i < 30; i++) {
      step(m, i === 0 ? { dash: new V(1, 0, 0), faceYaw: 0 } : { faceYaw: 0 });
      roll = Math.min(roll, m.model.hips.rotation.z + m.model.torso.rotation.z);
      skid = Math.max(skid, m.skidT);
    }
    out.step = { roll, skid };

    // ---- boosting forward through the air: the body tips forward into a flight pose
    reset(m, 0, 0, 40, Math.PI / 2);
    m.vel.set(-150, 0, 0);
    for (let i = 0; i < 40; i++) step(m, { ascend: true, moveX: -1, faceYaw: Math.PI / 2, speedMul: 2.5 });
    out.flight = m.model.hips.rotation.x;

    // ---- landings: an ordinary one crouches, a really hard one drops to one knee
    const landing = (vy) => {
      reset(m, 0, 0, 1, 0); // dropped from just above the ground, so the landing speed is the one given
      m.vel.y = vy;
      let low = Infinity, landedAt = -1;
      for (let i = 0; i < 120; i++) { step(m, {}); if (m.grounded && landedAt < 0) landedAt = i; if (landedAt >= 0 && i - landedAt < 40) low = Math.min(low, m.model.hips.position.y); }
      return low;
    };
    out.landNormal = landing(-60);
    out.landHard = landing(-125);

    // ---- secondary motion: the skirt swings with the thighs, a whip antenna sways, wings spread under thrust
    m = build({ crest: 'antenna' });
    reset(m, 0, 0, 0, Math.PI / 2);
    const sk = rig().skirt;
    let front = 0, rear = 0;
    for (let i = 0; i < 150; i++) {
      step(m, { moveX: -1, faceYaw: Math.PI / 2, speedMul: 1.5 });
      front = Math.max(front, sk.front.L.rotation.x, sk.front.R.rotation.x);
      rear = Math.min(rear, sk.rear.rotation.x);
    }
    let sway = 0;
    for (let i = 0; i < 40; i++) { step(m, { faceYaw: Math.PI / 2 }); sway = Math.max(sway, Math.abs(rig().whips[0].g.rotation.x)); }
    for (let i = 0; i < 240; i++) step(m, { faceYaw: Math.PI / 2 });
    out.secondary = { front, rear, sway, settled: Math.abs(rig().whips[0].g.rotation.x) };
    m = build({ backpack: 'wing' });
    reset(m);
    for (let i = 0; i < 40; i++) step(m, {});
    const folded = Math.abs(rig().wings[0].g.rotation.z);
    for (let i = 0; i < 40; i++) step(m, { ascend: true });
    out.wings = { folded, spread: Math.abs(rig().wings[0].g.rotation.z) };

    // ---- shoulder mounts follow the aim and kick back when they fire
    m = build({ mountL: 'cannon' });
    reset(m);
    for (let i = 0; i < 40; i++) step(m, { pitch: 0.4, faceYaw: 0 });
    const mount = rig().mounts.L;
    out.mount = { pitch: mount.g.rotation.x };
    m.model.recoil(0.8, 'L');
    step(m, { pitch: 0.4, faceYaw: 0 });
    out.mount.kick = mount.g.position.z - mount.z;

    // ---- a hit from the front snaps the chest back
    g.cheat.invincible = false;
    m = build();
    reset(m);
    for (let i = 0; i < 40; i++) step(m, { faceYaw: 0 });
    const chest0 = m.model.torso.rotation.x;
    m.takeDamage(160, { knock: new V(0, 0, 30), kind: 'beam' });
    let chest = chest0;
    for (let i = 0; i < 12; i++) { step(m, { faceYaw: 0 }); chest = Math.max(chest, m.model.torso.rotation.x); }
    out.flinch = chest - chest0;
    g.cheat.invincible = true;

    // ---- a knockdown: thrown down, a moment on the ground (the pilot cannot be hit there), then up again
    g.cheat.invincible = false;
    reset(m);
    for (let i = 0; i < 20; i++) step(m, {});
    m.takeDamage(300, { knock: new V(0, 40, 90), kind: 'saber', stagger: true, down: true });
    const phases = [];
    let lieHip = Infinity, hurtOnGround = 0;
    for (let i = 0; i < 60 * 4; i++) {
      step(m, { moveX: 1 });
      const ph = m.knock?.phase ?? 'up';
      if (phases[phases.length - 1] !== ph) phases.push(ph);
      if (ph === 'lie') { lieHip = Math.min(lieHip, m.model.hips.position.y); hurtOnGround += m.takeDamage(50, { kind: 'beam' }); }
    }
    out.knock = { phases, lieHip, hurtOnGround, standsAgain: !m.knock && m.model.hips.position.y > 9 };
    g.cheat.invincible = true;

    // ---- a destroyed machine breaks down (sinking to its knees) before it explodes
    g.state = 'playing';
    g.missions.state = 'idle';
    for (const e of g.enemies) e.mech.destroy();
    g.enemies.length = 0;
    const e = createEnemy(g, 'drone', 1);
    e.mech.place(0, -60, 0, 0);
    e.think = () => ({ faceYaw: 0 });
    g.enemies.push(e);
    g.step(10);
    const standing = e.mech.model.hips.position.y;
    g.slowmoT = 0; g.rig.kick = 0;
    e.mech.takeDamage(99999, { kind: 'beam' });
    out.wreck = { removed: !g.enemies.includes(e), wrecks: g.wrecks.length, slowmo: g.slowmoT, kick: g.rig.kick };
    let sunk = standing;
    for (let i = 0; i < 50; i++) { g.step(1); sunk = Math.min(sunk, e.mech.model.hips.position.y); }
    out.wreck.inScene = !!e.mech.root.parent;
    out.wreck.sunk = standing - sunk;
    g.step(40);
    out.wreck.gone = !e.mech.root.parent && g.wrecks.length === 0;

    // ---- the boost lunge: a melee press at a target out of reach boosts in (afterimages, speed lines), then swings
    const p = g.player;
    m = build();
    reset(m);
    g.rig.reset(0);
    const t = createEnemy(g, 'bulwark', 1);
    t.mech.place(0, -90, 0, 0);
    t.think = () => ({ faceYaw: 0 });
    t.def_dodge = 0;
    t.mech.hp = t.mech.maxHp = 100000;
    g.enemies.push(t);
    g.step(3);
    p.lock = t.mech;
    T.tap('Mouse2');
    const seq = [];
    let lungeSpeed = 0, ghosts = 0, lines = 0, gapAtSwing = null;
    for (let i = 0; i < 40; i++) {
      g.step(1);
      const st = p.melee?.stage ?? null;
      if (seq[seq.length - 1] !== st) seq.push(st);
      if (st === -1) {
        lungeSpeed = Math.max(lungeSpeed, Math.hypot(m.vel.x, m.vel.z));
        ghosts = Math.max(ghosts, g.fx._ghostsLive.size);
        lines = Math.max(lines, Number(document.getElementById('speedlines').style.opacity));
      }
      if (st === 0 && gapAtSwing === null) gapAtSwing = Math.hypot(t.mech.pos.x - m.pos.x, t.mech.pos.z - m.pos.z);
    }
    // keep pressing: the combo runs to its finisher, which knocks the target down with a camera punch
    let finisherKnock = false, finisherKick = 0;
    for (let k = 0; k < 20; k++) {
      T.tap('Mouse2');
      for (let i = 0; i < 8; i++) {
        g.step(1);
        if (p.melee) seq.includes(p.melee.stage) || seq.push(p.melee.stage);
        if (t.mech.knock) finisherKnock = true;
        finisherKick = Math.max(finisherKick, g.rig.kick);
      }
    }
    out.lunge = { seq, lungeSpeed, ghosts, lines, gapAtSwing, finisherKnock, finisherKick };
    for (const en of g.enemies) en.mech.destroy();
    g.enemies.length = 0;
    g.fx.clear();

    g.state = keep.state;
    g.manual = keep.manual;
    build();
    reset(g.player.mech);
    return out;
  });
  dump('moves', moves);
  check('a shot snaps the gun arm straight at the target and holds it there', moves.shot.fwd > 0.97 && Math.abs(moves.shot.y) < 0.12 && moves.shot.elbow < 0.25 && moves.shot.twist > 0.15 && moves.shotHeld > 0.95, JSON.stringify(moves.shot));
  check('a heavy gun is held in both hands, level, even while it fires', moves.grip < 1.6 && moves.gripFiring < 1.8 && Math.abs(moves.bazookaLevel) < 0.15, `grip ${moves.grip.toFixed(2)} / ${moves.gripFiring.toFixed(2)}, level ${moves.bazookaLevel.toFixed(2)}`);
  check('drawing the saber reaches back for the hilt; the gun rides the rear skirt while it is out', moves.draw.closest < 2.6 && moves.draw.saber && !moves.draw.gunInHand && moves.draw.holstered && !moves.draw.hiltRacked && moves.draw.blade > 0.9, JSON.stringify(moves.draw));
  check('putting the saber away racks the hilt and takes the gun back', moves.sheath.back < 2.6 && !moves.sheath.saber && moves.sheath.gunInHand && !moves.sheath.holstered && moves.sheath.hiltRacked, JSON.stringify(moves.sheath));
  check('a jump crouches before it pushes off', moves.jump.lowHip < moves.jump.standHip - 0.6 && moves.jump.firstUp >= 4 && moves.jump.firstUp <= 8, JSON.stringify(moves.jump));
  check('a step leans hard into its direction and ends in a skid', moves.step.roll < -0.15 && moves.step.skid > 0.2, JSON.stringify(moves.step));
  check('boosting forward through the air tips the body into a flight pose', moves.flight < -0.45, `hips pitch ${moves.flight.toFixed(2)}`);
  check('a really hard landing drops to one knee, lower than an ordinary landing', moves.landHard < moves.landNormal - 1.2, `${moves.landHard.toFixed(2)} vs ${moves.landNormal.toFixed(2)}`);
  check('the skirt plates swing with the thighs; a whip antenna sways and settles', moves.secondary.front > 0.12 && moves.secondary.rear < -0.05 && moves.secondary.sway > 0.03 && moves.secondary.settled < 0.01, JSON.stringify(moves.secondary));
  check('wing binders fold at rest and spread under thrust', moves.wings.spread > moves.wings.folded + 0.25, JSON.stringify(moves.wings));
  check('a shoulder cannon follows the aim and kicks back when it fires', moves.mount.pitch > 0.25 && moves.mount.kick > 0.4, JSON.stringify(moves.mount));
  check('a hit from the front snaps the chest back', moves.flinch > 0.1, `+${moves.flinch.toFixed(2)} rad`);
  check('a knockdown throws the mech down, protects it on the ground, and it gets back up', moves.knock.phases.join() === 'fall,lie,rise,up' && moves.knock.lieHip < 5 && moves.knock.hurtOnGround === 0 && moves.knock.standsAgain, JSON.stringify(moves.knock));
  check('a destroyed machine sparks and sinks to its knees before it explodes', moves.wreck.removed && moves.wreck.wrecks === 1 && moves.wreck.inScene && moves.wreck.sunk > 2.5 && moves.wreck.gone, JSON.stringify(moves.wreck));
  check('a kill gets a beat of slow motion and a camera punch', moves.wreck.slowmo > 0.1 && moves.wreck.kick > 0.3, JSON.stringify(moves.wreck));
  check('a melee press at a distant target boosts in first (afterimages, speed lines), then swings', moves.lunge.seq[0] === -1 && moves.lunge.seq.includes(0) && moves.lunge.lungeSpeed > 200 && moves.lunge.ghosts >= 2 && moves.lunge.lines > 0.4 && moves.lunge.gapAtSwing < 30, JSON.stringify(moves.lunge));
  check('the combo runs forehand, backhand, thrust and a finisher that knocks the target down', [0, 1, 2, 3].every((st) => moves.lunge.seq.includes(st)) && moves.lunge.finisherKnock && moves.lunge.finisherKick > 0.5, JSON.stringify(moves.lunge.seq));

  // ------------------------------------------------------------ 5i. the catapult launch that opens a sortie
  const launch = await page.evaluate(() => {
    const g = window.__game, T = window.__t, m = () => g.player.mech;
    const c = g.world.catapult;
    g.launchIntro = true;
    g.startMission();
    g.manual = true;
    const out = { start: { z: m().pos.z, deck: c.start, shown: c.group.visible, launching: !!g.launch } };
    T.keys(['KeyW']); // the pilot has no control on the shuttle
    g.step(45);
    out.standby = { z: m().pos.z, crouch: m().model.hips.position.y };
    T.keys([], ['KeyW']);
    g.step(36); // well into the run
    out.run = { speed: -m().vel.z, z: m().pos.z };
    g.step(20);
    out.release = { released: !!g.launch?.released, vy: m().vel.y, airborne: !m().grounded, lines: Number(document.getElementById('speedlines').style.opacity) };
    let landedAt = null;
    for (let i = 0; i < 180; i++) { g.step(1); if (m().grounded && landedAt === null) landedAt = { z: m().pos.z, t: g.stats.time, enemies: g.enemies.length }; }
    out.landed = landedAt;
    out.after = { launch: !!g.launch, shown: c.group.visible, cine: !!g.rig.cine, enemies: g.enemies.length };
    g.launchIntro = false;
    return out;
  });
  dump('launch', launch);
  check('a sortie opens on the catapult: the mech crouched on the shuttle, the pilot not yet in control', launch.start.launching && launch.start.shown && Math.abs(launch.start.z - launch.start.deck) < 1 && Math.abs(launch.standby.z - launch.start.deck) < 1 && launch.standby.crouch < 10, JSON.stringify([launch.start, launch.standby]));
  check('the shuttle throws the mech down the deck and into the air', launch.run.speed > 150 && launch.release.released && launch.release.airborne && launch.release.vy > 20 && launch.release.lines > 0.4, JSON.stringify([launch.run, launch.release]));
  check('it lands in the plaza before the first wave arrives, and the catapult and the scripted camera clear away', !!launch.landed && launch.landed.z < 120 && launch.landed.z > -80 && launch.landed.enemies === 0 && !launch.after.launch && !launch.after.shown && !launch.after.cine && launch.after.enemies > 0, JSON.stringify([launch.landed, launch.after]));

  // ------------------------------------------------------------ 5j. the destructible city
  const ruin = await page.evaluate(async () => {
    const g = window.__game, w = g.world, D = g.destruction;
    const THREE = await import('three');
    const P = await import('/src/parts.js');
    const { createEnemy } = await import('/src/ai.js');
    const V = THREE.Vector3;
    const out = {};
    g.setBuild({ ...P.DEFAULT_BUILD, paint: { ...P.DEFAULT_BUILD.paint }, tuning: { ...P.DEFAULT_BUILD.tuning } });
    g.launchIntro = false;
    g.cheat.invincible = true;
    g.startMission();
    g.manual = true;
    g.missions.state = 'idle';
    g.hud.reset();
    const m = () => g.player.mech;
    const dummy = (x, z, type = 'bulwark') => {
      const e = createEnemy(g, type, 1);
      e.mech.place(x, z, 0, 0);
      e.think = () => ({ faceYaw: 0 });
      e.def_dodge = 0;
      e.mech.hp = e.mech.maxHp = 1e6;
      g.enemies.push(e);
      return e;
    };
    const clear = () => { for (const e of g.enemies) e.mech.destroy(); g.enemies.length = 0; g.projectiles.clear(); };
    // a building with an open street on its +z side: where the shots come from
    const open = (b) => !w.pointBlocked(b.cx, 6, b.maxZ + 36) && !w.pointBlocked(b.cx, 28, b.maxZ + 36) && w.raycast(b.cx, 28, b.maxZ + 36, 0, 0, -1, 60) > 30;
    const pick = (minFloors, maxFloors = 99, skip = []) => w.boxes.filter((b) => b.n0 >= minFloors && b.n0 <= maxFloors && b.w > 16 && open(b) && !skip.includes(b) && Math.hypot(b.cx, b.cz) > 60)
      .sort((a, b) => Math.hypot(a.cx, a.cz) - Math.hypot(b.cx, b.cz))[0];
    const shoot = (b, type, damage, y, extra = {}, team = 'player') => {
      const pos = new V(b.cx, y, b.maxZ + 36), dir = new V(0, 0, -1);
      g.projectiles.spawn({ type, team, source: team === 'player' ? m() : g.enemies[0]?.mech ?? m(), pos, dir, damage, speed: type === 'cannon' ? 300 : 780, color: 0xffa040, knock: 0, ...extra });
      g.step(40);
    };
    const shell = { splash: { radius: 26, damage: 260 } };
    const sum = (b) => Array.from(b.floorDmg).reduce((a, c) => a + c, 0);
    const calls = () => { g.render(); return g.renderer.info.render.calls; };

    // ---- the city is made of floors
    out.city = { all: w.allBuildings.length, standing: w.boxes.length, floorsOk: w.allBuildings.every((b) => b.n0 === Math.ceil(b.h0 / 4.5) && b.floorDmg.length === b.n0 && b.top === b.h0), perFloor: 4.5 };

    // ---- a magazine of rifle shots chips a tower but does not bring it down; it leaves scorch marks
    const tower = pick(10);
    const topBefore = tower.top, marks0 = D.decalCount;
    for (let i = 0; i < 8; i++) shoot(tower, 'beam', 210, 18 + (i % 3) * 3);
    out.rifle = { top: tower.top - topBefore, dmg: Math.round(sum(tower)), marks: D.decalCount - marks0, collapses: D.collapses };

    // ---- machine-gun bullets barely scratch it
    const mgTarget = pick(6, 9, [tower]);
    for (let i = 0; i < 30; i++) shoot(mgTarget, 'bullet', 42, 12);
    out.mg = { dmg: Math.round(sum(mgTarget)), top: mgTarget.top - mgTarget.h0, hp: 260 + 90 * (mgTarget.n0 - 1) };

    // ---- a shell at mid height takes the top off: whole floors, the collision follows, chunks and smoke
    const target = pick(9, 14, [tower, mgTarget]);
    const old = target.top;
    const rayBefore = w.raycast(target.cx, old - 3, target.maxZ + 30, 0, 0, -1, 80);
    const debris0 = g.fx.debris.length;
    shoot(target, 'cannon', 520, old * 0.55, shell);
    out.shell = { drop: old - target.top, floorsDropped: (old - target.top) / 4.5, aligned: Math.abs(target.top / 4.5 - Math.round(target.top / 4.5)) < 1e-6, n: target.n, rayBefore: Math.round(rayBefore), rayAfter: w.raycast(target.cx, old - 3, target.maxZ + 30, 0, 0, -1, 80),
      blockedAtOldRoof: w.pointBlocked(target.cx, old - 3, target.cz), slabs: D.slabs.length, emitters: D.emitters.length, chunks: g.fx.debris.length - debris0, stat: g.stats.collapses, crown: !!target.crown, meshOk: Math.abs(target.mesh.geometry.parameters.height - target.top) < 1e-6 };
    g.step(200);
    out.shell.slabsAfter = D.slabs.length;

    // ---- a mech on the roof falls with it, and is hurt
    g.cheat.invincible = false;
    const roof = pick(8, 14, [tower, mgTarget, target]);
    const roofTop = roof.top;
    m().place(roof.cx, roof.cz, roofTop, 0);
    m().invuln = 0;
    g.step(20);
    const stood = { y: m().pos.y, grounded: m().grounded };
    const hp0 = m().hp;
    D._collapse(roof, 3);
    g.step(90);
    out.rider = { stood, fell: roofTop - m().pos.y, hurt: hp0 - m().hp };
    g.cheat.invincible = true;
    m().place(0, 0, 0, 0);

    // ---- debris near the foot hurts and shoves what is there; what is far is untouched
    const b3 = pick(8, 14, [tower, mgTarget, target, roof]);
    const near = dummy(b3.cx, b3.maxZ + 8), far = dummy(b3.cx, b3.maxZ + 90);
    near.mech.hp = near.mech.maxHp = 5000; far.mech.hp = far.mech.maxHp = 5000;
    g.step(2);
    D._collapse(b3, 3);
    const k = near.mech.vel;
    out.debris = { nearHurt: near.mech.maxHp - near.mech.hp, farHurt: far.mech.maxHp - far.mech.hp, pushedAway: k.z > 15, stagger: near.mech.stagger > 0 };
    // ... but not twice in a row
    const hpNow = near.mech.hp;
    D._collapse(b3, 2);
    out.debris.again = hpNow - near.mech.hp;
    clear();

    // ---- flatten a building: rubble you can walk over, no wall, spawn logic unharmed
    const b4 = pick(6, 12, [tower, mgTarget, target, roof, b3]);
    D._collapse(b4, 0);
    out.rubble = { has: !!b4.rubble, solid: w.boxes.includes(b4), blocked: w.pointBlocked(b4.cx, 5, b4.cz), top: b4.top, leveled: D.leveled, hidden: !b4.mesh.visible, stat: g.stats.leveled };
    m().place(b4.cx, b4.cz, 0, 0);
    g.step(30);
    out.rubble.walkedIn = Math.hypot(m().pos.x - b4.cx, m().pos.z - b4.cz);
    m().place(0, 0, 0, 0);
    let spawnOk = true;
    for (let i = 0; i < 40; i++) { const sp = w.findSpawn(190, 330, []); if (!Number.isFinite(sp.x) || w.pointBlocked(sp.x, 5, sp.z)) spawnOk = false; }
    out.rubble.spawnOk = spawnOk;
    // shots now fly through where it stood
    out.rubble.rayThrough = w.raycast(b4.cx, 10, b4.maxZ + 30, 0, 0, -1, 60);

    // ---- the enemy breaks things too
    const b5 = pick(7, 14, [tower, mgTarget, target, roof, b3, b4]);
    const foe = dummy(b5.cx + 150, b5.maxZ + 60);
    shoot(b5, 'cannon', 220, 10, { splash: { radius: 24, damage: 120 } }, 'enemy');
    out.enemyShell = Math.round(sum(b5));
    // ... and enemy sabers
    const b6 = pick(6, 14, [tower, mgTarget, target, roof, b3, b4, b5]);
    foe.mech.place(b6.cx, b6.maxZ + 14, 0, 0);
    const dmg0 = sum(b6);
    D.slash(foe.mech, 26, 340 * 1.3);
    out.enemySaber = Math.round(sum(b6) - dmg0);
    clear();

    // ---- the pilot's own saber
    const b7 = pick(6, 14, [tower, mgTarget, target, roof, b3, b4, b5, b6]);
    m().place(b7.cx, b7.maxZ + 16, 0, 0);
    g.rig.reset(0);
    g.step(5);
    const dmg7 = sum(b7);
    for (let i = 0; i < 12; i++) { window.__t.tap('Mouse2'); g.step(10); }
    out.saber = { dmg: Math.round(sum(b7) - dmg7), top: b7.top - b7.h0, collapsed: b7.top < b7.h0, stat: g.stats.collapses };
    m().place(0, 0, 0, 0);

    // ---- a wreck blowing up beside a wall hurts it
    const b8 = pick(7, 14, [tower, mgTarget, target, roof, b3, b4, b5, b6, b7]);
    const dying = dummy(b8.cx, b8.maxZ + 10, 'drone');
    dying.mech.hp = dying.mech.maxHp = 100;
    g.step(2);
    const dmg8 = sum(b8) + (b8.top < b8.h0 ? 1e6 : 0);
    dying.mech.takeDamage(1e6, { kind: 'beam' });
    g.step(120);
    out.wreckBlast = Math.round(sum(b8) + (b8.top < b8.h0 ? 1e6 : 0) - dmg8);
    clear();

    // ---- a shell that hits a mech beside a wall splashes the wall
    const b9 = pick(7, 14, [tower, mgTarget, target, roof, b3, b4, b5, b6, b7, b8]);
    dummy(b9.cx, b9.maxZ + 6);
    g.step(2);
    const dmg9 = sum(b9), top9 = b9.top;
    g.projectiles.spawn({ type: 'cannon', team: 'player', source: m(), pos: new V(b9.cx, 9, b9.maxZ + 40), dir: new V(0, 0, -1), damage: 520, speed: 300, color: 0xffa040, knock: 0, splash: { radius: 26, damage: 260 } });
    g.step(40);
    out.splashWall = Math.round(sum(b9) - dmg9);
    out.splashWallDown = b9.top < top9; // (a collapse clears the floor damage it used up)
    clear();

    // ---- a shell that lands in the street beside a wall only blasts it (no full wall hit); one that hits the wall itself does much more
    const b10 = pick(9, 14, [tower, mgTarget, target, roof, b3, b4, b5, b6, b7, b8, b9]);
    D.reset();
    g.projectiles.spawn({ type: 'cannon', team: 'player', source: m(), pos: new V(b10.cx, 14, b10.maxZ + 44), dir: new V(0, -0.32, -1).normalize(), damage: 520, speed: 300, color: 0xffa040, knock: 0, splash: { radius: 26, damage: 260 } });
    g.step(60);
    const groundDmg = sum(b10) + (b10.top < b10.h0 ? 1e6 : 0);
    D.reset();
    shoot(b10, 'cannon', 520, 20, shell);
    out.ground = { streetHit: Math.round(groundDmg), wallHit: Math.round(sum(b10) + (b10.top < b10.h0 ? 1e6 : 0)) };

    // ---- caps: scorch marks, chunks, slabs and smoke columns stay bounded however much is shot
    const spam = pick(14, 30) ?? w.boxes.reduce((a, c) => (c.n0 > a.n0 ? c : a));
    for (let i = 0; i < 600; i++) D.damageAt(spam.cx + rand(0, 1), 1 + (i % 40), spam.maxZ + 1, 40, 2.5, true);
    out.caps = { marks: D.decalCount, debris: g.fx.debris.length, slabs: D.slabs.length, emitters: D.emitters.length };

    // ---- the GPU bill: a lot of destruction adds a handful of draw calls, not hundreds
    D.reset();
    g.camera.position.set(0, 120, 220); g.camera.lookAt(0, 20, 0); g.camera.updateMatrixWorld(true);
    out.calls = { before: calls() };
    const many = w.boxes.slice().sort((a, b) => Math.hypot(a.cx, a.cz) - Math.hypot(b.cx, b.cz)).slice(0, 24);
    many.forEach((b, i) => D._collapse(b, i % 3 === 0 ? 0 : 2 + (i % 4)));
    g.step(300);
    out.calls.after = calls();
    out.calls.mixed = many.filter((b) => b.rubble).length;
    out.calls.crowns = many.filter((b) => b.crown).length;

    // ---- the CPU bill
    D.reset();
    const t0 = performance.now();
    for (let i = 0; i < 3000; i++) D.damageAt(0, 10, 0, 5, 3, true);
    out.cpuPerHitMs = (performance.now() - t0) / 3000;

    // ---- nothing is left behind: a second collapse replaces the first one's crown, and a reset removes every ruin
    D.reset();
    const groupN = w.cityGroup.children.length;
    const lb = pick(10, 20);
    D._collapse(lb, 7);
    const afterFirst = w.cityGroup.children.length;
    D._collapse(lb, 4);
    const afterSecond = w.cityGroup.children.length;
    D._collapse(w.boxes[10], 0);
    D._collapse(w.boxes[11], 3);
    D.reset();
    out.leak = { first: afterFirst - groupN, second: afterSecond - groupN, afterReset: w.cityGroup.children.length - groupN };

    // ---- the results screen counts what was brought down
    D.reset();
    g.stats = g._freshStats();
    g.victory = true;
    const rowsClean = g._result().rows.map((r) => r[0]);
    D._collapse(w.boxes[3], 0);
    D._collapse(w.boxes[5], 4);
    const rows = g._result().rows.find((r) => r[0] === 'Structures brought down');
    out.results = { clean: rowsClean.includes('Structures brought down'), row: rows ? rows[1] : null };

    // ---- a new sortie puts the whole city back
    g.startMission();
    g.manual = true;
    g.missions.state = 'idle';
    out.reset = { top: w.allBuildings.every((b) => b.top === b.h0 && b.n === b.n0 && b.mesh.visible && !b.rubble && !b.crown && sum(b) === 0), standing: w.boxes.length === w.allBuildings.length, marks: D.decalCount, slabs: D.slabs.length, emitters: D.emitters.length,
      solidAgain: w.pointBlocked(b4.cx, 5, b4.cz), geoOk: w.allBuildings.every((b) => Math.abs(b.mesh.geometry.parameters.height - b.h0) < 1e-6), collapses: D.collapses };
    out.finite = [m().pos.x, m().pos.y, m().pos.z, m().hp].every(Number.isFinite);
    g.cheat.invincible = true;
    return out;
    function rand(a, b) { return a + Math.random() * (b - a); }
  });
  dump('ruin', ruin);
  check('every building is a stack of 4.5-unit floors, all standing at the start', ruin.city.floorsOk && ruin.city.all === ruin.city.standing && ruin.city.all > 50, JSON.stringify(ruin.city));
  check('a magazine of rifle shots chips a tower and scorches it, but cannot bring it down', ruin.rifle.dmg > 300 && ruin.rifle.marks >= 3 && ruin.rifle.top === 0 && ruin.rifle.collapses === 0, JSON.stringify(ruin.rifle));
  check('thirty machine-gun bullets barely scratch a building: less than half what its weakest floor can take', ruin.mg.dmg > 0 && ruin.mg.dmg < 400 && ruin.mg.top === 0, JSON.stringify(ruin.mg));
  check('a shell takes whole floors off the top: height, collision and the mesh all follow, with chunks, a falling roof and smoke', ruin.shell.floorsDropped >= 2 && ruin.shell.aligned && ruin.shell.meshOk && ruin.shell.slabs > 0 && ruin.shell.emitters > 0 && ruin.shell.chunks >= 5 && ruin.shell.crown && ruin.shell.stat >= 1, JSON.stringify(ruin.shell));
  check('where the roof was is open air: a ray that hit the wall now passes, and the point is no longer blocked', ruin.shell.rayBefore < 40 && !(ruin.shell.rayAfter < 80) && !ruin.shell.blockedAtOldRoof, `${ruin.shell.rayBefore} -> ${ruin.shell.rayAfter}`);
  check('the falling roof section finishes and is cleared away', ruin.shell.slabsAfter === 0, `${ruin.shell.slabsAfter} left`);
  check('a mech standing on the roof falls with it, and is hurt', ruin.rider.stood.grounded && ruin.rider.fell > 8 && ruin.rider.hurt > 100, JSON.stringify(ruin.rider));
  check('debris hurts and shoves a mech at the foot of the building, and leaves one far away alone, and cannot hit twice in a row', ruin.debris.nearHurt > 60 && ruin.debris.pushedAway && ruin.debris.stagger && ruin.debris.farHurt === 0 && ruin.debris.again === 0, JSON.stringify(ruin.debris));
  check('a flattened building leaves rubble: no wall, not solid, hidden walls, walkable, and spawns still find open ground', ruin.rubble.has && !ruin.rubble.solid && !ruin.rubble.blocked && ruin.rubble.top === 0 && ruin.rubble.hidden && ruin.rubble.walkedIn < 1 && ruin.rubble.spawnOk && ruin.rubble.leveled >= 1 && ruin.rubble.stat >= 1, JSON.stringify(ruin.rubble));
  check('shots fly through where a flattened building stood', !(ruin.rubble.rayThrough < 60), `${ruin.rubble.rayThrough}`);
  check('enemy fire breaks buildings too: shells and sabers', ruin.enemyShell > 300 && ruin.enemySaber > 300, `shell ${ruin.enemyShell}, saber ${ruin.enemySaber}`);
  check('the pilot\'s saber cuts into a wall (a combo can bring a small building down)', ruin.saber.dmg > 300 || ruin.saber.collapsed, JSON.stringify(ruin.saber));
  check('a machine blowing up beside a wall hurts it', ruin.wreckBlast > 100, `${ruin.wreckBlast}`);
  check('a shell that hits a mech beside a wall splashes the wall', ruin.splashWall > 200 || ruin.splashWallDown, `${ruin.splashWall}, down ${ruin.splashWallDown}`);
  check('a shell that lands in the street beside a wall only blasts it; hitting the wall itself does far more', ruin.ground.streetHit < ruin.ground.wallHit * 0.6, JSON.stringify(ruin.ground));
  check('scorch marks, chunks, falling roofs and smoke columns stay within their caps', ruin.caps.marks <= 240 && ruin.caps.debris <= 130 && ruin.caps.slabs <= 6 && ruin.caps.emitters <= 12, JSON.stringify(ruin.caps));
  check('wrecking two dozen buildings adds a handful of draw calls, not hundreds', ruin.calls.after - ruin.calls.before < 60 && ruin.calls.mixed >= 6 && ruin.calls.crowns >= 6, JSON.stringify(ruin.calls));
  check('registering a hit is cheap', ruin.cpuPerHitMs < 0.15, `${ruin.cpuPerHitMs.toFixed(3)} ms`);
  check('no mesh is left behind: a second collapse replaces the first crown, and a reset clears every ruin', ruin.leak.first === 1 && ruin.leak.second === 1 && ruin.leak.afterReset === 0, JSON.stringify(ruin.leak));
  check('the results screen counts the structures brought down, once there are any', !ruin.results.clean && /^2 \(1 flattened\)$/.test(ruin.results.row ?? ''), JSON.stringify(ruin.results));
  check('a new sortie puts the whole city back: every building whole, solid and lit, no rubble, marks or smoke', ruin.reset.top && ruin.reset.standing && ruin.reset.marks === 0 && ruin.reset.slabs === 0 && ruin.reset.emitters === 0 && ruin.reset.solidAgain && ruin.reset.geoOk && ruin.reset.collapses === 0 && ruin.finite, JSON.stringify(ruin.reset));

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
