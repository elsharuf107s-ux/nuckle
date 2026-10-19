#!/usr/bin/env node
// Pure checks of src/modes.js (the rule table of design 6.1, difficulty 6.2, hardcore 6.4, START and OPTION rows 6.5,
// the seed rule 7.4). Run alone (node tools/gen_tests/menus_modes.mjs) or from tools/gen_tests/menus.mjs.
import { fileURLToPath } from 'node:url';
import * as MD from '../../src/modes.js';

export function runModeChecks() {
  const out = [];
  const ok = (c, m) => out.push([!!c, m]);
  const R = MD.rules;
  // the table
  ok(R('survival', 'normal').damage && R('survival', 'normal').hunger && R('survival').hud === 'full' && R('survival').battleLoss === 'death', 'survival takes damage, gets hungry, full HUD, a lost battle is a death');
  ok(!R('creative').damage && !R('creative').hunger && R('creative').instantBreak && !R('creative').itemsUsedUp && !R('creative').toolsWear
    && !R('creative').ballsUsedUp && !R('creative').hostilesSee && R('creative').hud === 'hotbar' && R('creative').battleLoss === 'heal' && R('creative').creativeInventory, 'creative: no damage, no hunger, instant break, nothing used up, mobs ignore, hotbar only, lost battles heal');
  ok(R('hardcore', 'easy').diff === 'hard' && R('hardcore').hud === 'hardcore' && R('hardcore').oneLife && R('hardcore').autosave && R('hardcore').difficultyLocked, 'hardcore: locked to Hard, hardcore hearts, one life, autosaves');
  const sp = R('spectator');
  ok(!sp.damage && !sp.hunger && !sp.canBreak && !sp.canPlace && !sp.interact && !sp.pickUp && !sp.encounters && !sp.battles && sp.noclip && sp.hud === 'none' && sp.ghostAlpha === 0.35 && !sp.hostilesSee && sp.autosave,
    'spectator: no damage, no hunger, cannot mine, place, use, pick up, battle; walks through walls; no HUD; 35% alpha; keeps autosaving');
  ok(!R('survival', 'peaceful').hunger && !R('survival', 'peaceful').naturalHostiles && !R('survival', 'peaceful').mobDamage && R('survival', 'peaceful').peacefulRegen === 0.5, 'peaceful: no hunger, no natural hostiles, harmless spawner mobs, 1 HP every 2 s');
  ok(Object.isFrozen(R('survival')) && R('creative', 'easy') === R('creative', 'easy'), 'rule objects are frozen and cached');
  ok(R('bogus', 'nope').mode === 'survival' && R('bogus', 'nope').diff === 'normal' && R().mode === 'survival', 'junk answers as Survival on Normal');
  // numbers
  ok(MD.mobDamage(6, 'easy') === 4 && MD.mobDamage(1, 'easy') === 1 && MD.mobDamage(6, 'normal') === 6 && MD.mobDamage(6, 'hard') === 9 && MD.mobDamage(6, 'peaceful') === 0 && MD.mobDamage('x', 'hard') === 0,
    'mob damage: easy min(d/2+1, d), normal d, hard d*1.5, peaceful 0');
  ok(MD.starveFloor('easy') === 10 && MD.starveFloor('normal') === 1 && MD.starveFloor('hard') === 0 && MD.starveFloor() === 1, 'starving stops at 10 (easy), 1 (normal), kills on hard');
  ok(MD.takesDamage('creative', 'void') && !MD.takesDamage('creative', 'zombie') && !MD.takesDamage('spectator', 'void') && MD.takesDamage('hardcore', 'fall'), 'creative takes only the void; spectators nothing');
  ok(MD.encountersOn('creative', false) === false && MD.encountersOn('creative', true) && !MD.encountersOn('spectator') && MD.encountersOn('survival', false), 'wild POKeMON: the OPTION toggle applies to creative only; spectators never');
  // breaking
  const stone = { hard: 1.5, tool: 'pickaxe' }, bedrock = { hard: -1 };
  ok(MD.breakFor('creative', stone, false).ticks === 1 && MD.breakFor('creative', bedrock, false) === null && MD.breakFor('creative', stone, true) === null && MD.breakFor('spectator', stone, false) === null
    && MD.breakFor('survival', stone, false, { ticks: 30, harvest: true }).ticks === 30, 'breaking: creative instant except hard < 0 and protected cells; spectators never; survival passes through');
  // protected items
  const items = { bedrock: { block: { hard: -1 }, hidden: true }, end_portal_frame: { block: { hard: -1 } }, spawner: { block: { hard: 5 }, hidden: true },
    dragon_egg: { block: { hard: -1 } }, infested_stone_bricks: { block: { hard: 0.75 } }, stone: { block: { hard: 1.5 } }, beacon: { block: { hard: 3 } }, diamond: {} };
  ok(['bedrock', 'end_portal_frame', 'spawner', 'dragon_egg', 'infested_stone_bricks'].every((id) => !MD.inCreativeTabs(id, items[id])) && MD.inCreativeTabs('stone', items.stone)
    && MD.inCreativeTabs('diamond', items.diamond) && !MD.inCreativeTabs('beacon', items.beacon) && !MD.inCreativeTabs('unknown', undefined), 'protected and paused items are left out of the tabs');
  // hardcore
  const entry = { id: 'w1', name: 'A', mode: 'hardcore' };
  const dead = MD.hardcoreDeath(entry, 'Steve fell', 123);
  ok(dead.hc.dead && dead.hc.cause === 'Steve fell' && dead.hc.at === 123 && !entry.hc && dead.name === 'A', 'hardcoreDeath marks a copy, never the entry it is given');
  ok(MD.bootMode(dead, { hc: null }) === 'spectator' && MD.bootMode(entry, { hc: { dead: true } }) === 'spectator' && MD.bootMode(entry, {}) === 'hardcore' && MD.bootMode({ id: 'classic', mode: 'creative' }) === 'survival',
    'a dead hardcore world boots in spectator whatever its save says; Classic is survival');
  ok(MD.autosaveDue('hardcore', 100, 50) && !MD.autosaveDue('hardcore', 60, 50) && !MD.autosaveDue('survival', 1000, 0) && MD.autosaveDue('spectator', 46, 0), 'autosave every 45 s, hardcore and spectating hardcore only');
  // menus
  ok(JSON.stringify(MD.startRows(false, 'creative')) === JSON.stringify(['POKéDEX', 'POKéMON', 'BAG', 'STEVE', 'SAVE', 'CO-OP', 'EXIT']), "Classic's START menu is today's");
  const gen = MD.startRows(true, 'survival');
  ok(gen.indexOf('CO-OP') === 5 && gen.indexOf('OPTION') === 6 && gen.indexOf('TITLE') === 7 && gen[gen.length - 1] === 'EXIT', 'generated START: OPTION after CO-OP (row 5 kept), then TITLE, then EXIT');
  ok(JSON.stringify(MD.startRows(true, 'spectator')) === JSON.stringify(['POKéDEX', 'POKéMON', 'STEVE', 'OPTION', 'TITLE']), 'spectator START: POKeDEX, POKeMON, STEVE, OPTION, TITLE only');
  ok(MD.optionRows('creative').join() === 'MUSIC,WILD POKéMON' && MD.optionRows('survival').join() === 'MUSIC,DIFFICULTY' && MD.optionRows('hardcore').join() === 'MUSIC', 'OPTION rows by mode');
  // cycles and labels
  ok(MD.nextMode('survival') === 'hardcore' && MD.nextMode('hardcore') === 'creative' && MD.nextMode('creative') === 'survival' && MD.prevMode('survival') === 'creative', 'Game Mode cycles Survival, Hardcore, Creative');
  ok(MD.nextDiff('hard') === 'peaceful' && MD.nextDiff('normal') === 'hard' && MD.prevDiff('peaceful') === 'hard', 'Difficulty cycles Peaceful, Easy, Normal, Hard');
  ok(MD.nextType('kanto') === 'wild' && MD.nextType('wild') === 'kanto' && MD.typeName('kanto') === 'Kanto World' && MD.typeName('wild') === 'Wild World', 'World Type cycles Kanto World and Wild World');
  const l1 = MD.worldLine({ type: 'kanto', mode: 'survival' }), l2 = MD.worldLine({ type: 'wild', mode: 'creative' }), l3 = MD.worldLine({ type: 'wild', mode: 'spectator' });
  ok(l1.type + ', ' + l1.mode === 'Kanto World, Survival Mode' && l2.type + ', ' + l2.mode === 'Wild World, Creative Mode' && l3.mode === 'Hardcore Mode!' && l3.red, 'world list lines');
  // seeds
  const r0 = () => 42;
  ok(MD.javaHash('hello') === 99162322 && MD.javaHash('') === 0 && MD.javaHash('Hello') === 69609650 && MD.javaHash('polygenelubricants') === -2147483648, "Java's String.hashCode");
  ok(MD.seedFromText('hello').seed === 99162322 && MD.seedFromText('  hello  ').seed === 99162322 && MD.seedFromText('  hello  ').seedText === 'hello', 'text seeds hash, trimmed first');
  ok(MD.seedFromText('123456').seed === 123456 && MD.seedFromText('-7').seed === -7 && MD.seedFromText('+5').seed === 5, 'digit seeds are numbers');
  ok(MD.seedFromText('4294967297').seed === 1 && MD.seedFromText('2147483648').seed === -2147483648 && MD.seedFromText('99999999999999999999999').seed === Number(BigInt.asIntN(32, 99999999999999999999999n)), 'big numbers reduce to 32 bits');
  ok(MD.seedFromText('', r0).seed === 42 && MD.seedFromText('   ', r0).random && Number.isInteger(MD.seedFromText('').seed), 'blank is random');
  ok(MD.seedFromText('1 2').seed === MD.javaHash('1 2') && MD.seedFromText('12a').seed === MD.javaHash('12a'), 'mixed text hashes');
  // the request
  const q = MD.newWorldRequest({ name: '  ', type: 'nope', mode: 'hardcore', diff: 'easy', seedText: 'x'.repeat(40) });
  ok(q.op === 'new' && q.name === 'New World' && q.type === 'kanto' && q.mode === 'hardcore' && q.diff === 'hard' && q.seedText.length === 32, 'the boot request is cleaned (blank name, bad type, hardcore difficulty, seed length)');
  ok(MD.cleanName('a\u0007b') === 'ab' && MD.cleanName('x'.repeat(40)).length === 32, 'names drop control characters and stop at 32');
  // never throws: every exported function with every pair of junk arguments (null included, which a default cannot catch)
  const junk = [undefined, null, 0, -1, NaN, '', 'nope', {}, [], true, Symbol('s'), () => 1, { mode: null, diff: null }, Object.create(null)];
  const label = ['undefined', 'null', '0', '-1', 'NaN', "''", "'nope'", '{}', '[]', 'true', 'Symbol', 'fn', '{mode:null}', 'bare object'];
  let calls = 0; const threw = [];
  for (const [name, f] of Object.entries(MD)) {
    if (typeof f !== 'function') continue;
    junk.forEach((a, i) => junk.forEach((b, j) => {
      calls++;
      try { f(a, b, a, b); } catch (e) { if (threw.length < 8) threw.push(`${name}(${label[i]}, ${label[j]}): ${e.message}`); }
    }));
  }
  ok(threw.length === 0, `no helper throws on junk: ${calls} calls with ${junk.length} x ${junk.length} argument pairs (${threw.join(' | ') || 'none threw'})`);
  ok(MD.normalize(null).mode === 'survival' && MD.newWorldRequest(null).name === 'New World' && MD.newWorldRequest(undefined).op === 'new', 'normalize(null) and newWorldRequest(null or undefined) answer as Survival on Normal');
  ok(MD.breakFor('creative', { hard: 1 }, false).creative === true && MD.rules('creative').blockDrops === false && MD.rules('survival').blockDrops === true, 'creative breaking is flagged for finishBreak (blockDrops false)');
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const res = runModeChecks();
  for (const [c, m] of res) console.log(c ? 'ok  ' : 'FAIL', m);
  const bad = res.filter(([c]) => !c).length;
  console.log(bad ? `${bad} failure(s)` : 'all checks passed');
  process.exit(bad ? 1 : 0);
}
