// Game modes and difficulty as rules (the world update's design, section 6). A pure module: no DOM, no imports, no
// game state of its own, so Node tests import it directly and the call sites that stage 8a wires (player.js, items.js,
// entities.js, battle.js, hud.js, main.js) ask it questions instead of growing mode forks.
//
//   G.mode  'survival' | 'creative' | 'hardcore' | 'spectator' (spectator only after a hardcore death, 6.4)
//   G.diff  'peaceful' | 'easy' | 'normal' | 'hard'
//
// Classic worlds are survival on normal and never offer anything else (classicMode()). Every helper accepts junk
// (undefined, an unknown string) and answers as Survival on Normal would, so a call site can never throw here.

export const MODES = ['survival', 'creative', 'hardcore', 'spectator'];
export const PLAYABLE_MODES = ['survival', 'hardcore', 'creative'];   // Create New World's cycle order (7.4)
export const DIFFS = ['peaceful', 'easy', 'normal', 'hard'];
export const WORLD_TYPES = ['kanto', 'wild'];                         // Create New World's cycle order; 'classic' is never offered
export const MAX_WORLDS = 5;                                          // the world list cap (7.3), every listed world counted
export const AUTOSAVE_SECONDS = 45;                                   // hardcore autosave period (6.4)
export const GHOST_ALPHA = 0.35;                                      // a spectator's Steve (6.4)

const mode = (m) => (MODES.includes(m) ? m : 'survival');
// String() and Number() throw on a Symbol or an object without a prototype; these never do
const txt = (x) => { try { return x == null ? '' : String(x); } catch (e) { return ''; } };
const num = (x) => { try { return Number(x) || 0; } catch (e) { return 0; } };
const diff = (d) => (DIFFS.includes(d) ? d : 'normal');

// ------------------------------------------------------------------------------------------- state
// The mode state a world starts with: Hardcore is locked to Hard (6.2); Creative keeps the difficulty it was given
// (mobs still spawn and still hurt each other), Survival defaults to Normal.
export function normalize(o) {
  const { mode: m, diff: d } = o && typeof o === 'object' ? o : {};   // null and junk too (a default covers only undefined)
  const md = mode(m);
  return { mode: md, diff: md === 'hardcore' || md === 'spectator' ? 'hard' : diff(d) };
}
export function classicMode() { return { mode: 'survival', diff: 'normal' }; }
export const isCreative = (m) => m === 'creative';
export const isSpectator = (m) => m === 'spectator';
export const isHardcore = (m) => m === 'hardcore' || m === 'spectator';   // a dead hardcore world is still a hardcore world
export const nextMode = (m) => PLAYABLE_MODES[(PLAYABLE_MODES.indexOf(m) + 1) % PLAYABLE_MODES.length];
export const prevMode = (m) => PLAYABLE_MODES[(PLAYABLE_MODES.indexOf(m) + PLAYABLE_MODES.length - 1) % PLAYABLE_MODES.length];
export const nextDiff = (d) => DIFFS[(DIFFS.indexOf(diff(d)) + 1) % DIFFS.length];
export const prevDiff = (d) => DIFFS[(DIFFS.indexOf(diff(d)) + DIFFS.length - 1) % DIFFS.length];
export const nextType = (t) => WORLD_TYPES[(WORLD_TYPES.indexOf(t) + 1) % WORLD_TYPES.length];

// ------------------------------------------------------------------------------------------- the rule table (6.1)
// One frozen object per (mode, difficulty): the call sites read flags rather than compare mode strings.
const cache = new Map();
export function rules(m, d) {
  const md = mode(m), df = md === 'hardcore' || md === 'spectator' ? 'hard' : diff(d);
  const key = md + '|' + df;
  let r = cache.get(key);
  if (r) return r;
  const creative = md === 'creative', spec = md === 'spectator', peaceful = df === 'peaceful';
  r = Object.freeze({
    mode: md, diff: df,
    damage: !creative && !spec,                 // PL.hurtPlayer, NET.vuln (creative: only the End's void, see takesDamage)
    hunger: !creative && !spec && !peaceful,    // PL.exhaust, survivalTick
    starveFloor: starveFloor(df),               // HP a starving player stops at (0 = starving kills)
    peacefulRegen: peaceful && !creative && !spec ? 0.5 : 0,   // HP per second (1 every 2 s, 6.2)
    naturalHostiles: !peaceful,                 // trySpawn* (structure spawners keep working, 6.2)
    hostilesSee: !creative && !spec,            // updateMob canSee
    mobDamage: !creative && !spec && !peaceful, // peaceful: spawner mobs move and drop but deal nothing
    instantBreak: creative,                     // breakInfo: instant where survival could break it
    blockDrops: !creative,                      // finishBreak0: the block's own drop (see breakFor; containers still spill)
    canBreak: !spec, canPlace: !spec, interact: !spec, pickUp: !spec,
    itemsUsedUp: !creative,                     // inv.useHeld, inv.remove (placing, eating, eyes, potions)
    toolsWear: !creative,                       // inv.wearHeld
    ballsUsedUp: !creative,                     // battle.js BAG
    encounters: !spec,                          // wild POKeMON (creative: the OPTION toggle on top, see encountersOn)
    battles: !spec,
    battleLoss: creative ? 'heal' : spec ? 'none' : 'death',   // 6.1 battles row
    hud: creative ? 'hotbar' : spec ? 'none' : md === 'hardcore' ? 'hardcore' : 'full',
    noclip: spec,                               // PL.canEnter: through solid cells inside the current place only
    autosave: md === 'hardcore' || md === 'spectator',          // a spectating hardcore host keeps saving guests (9.5)
    oneLife: md === 'hardcore',
    creativeInventory: creative,                // E opens src/ui/creative.js
    ghostAlpha: spec ? GHOST_ALPHA : 1,
    difficultyLocked: md === 'hardcore' || md === 'spectator',
  });
  cache.set(key, r);
  return r;
}

// ------------------------------------------------------------------------------------------- numbers (6.1, 6.2)
// Starving: easy stops at 10 HP, normal at 1, hard (and hardcore) kills.
export function starveFloor(d) { const df = diff(d); return df === 'easy' ? 10 : df === 'hard' ? 0 : df === 'peaceful' ? 20 : 1; }
// A mob's hit on the player, by difficulty (Java's numbers): easy min(d / 2 + 1, d), normal d, hard d * 1.5; peaceful 0.
export function mobDamage(dmg, d) {
  const x = num(dmg), df = diff(d);
  if (x <= 0) return 0;
  if (df === 'peaceful') return 0;
  if (df === 'easy') return Math.min(x / 2 + 1, x);
  if (df === 'hard') return x * 1.5;
  return x;
}
// Does this mode take this damage at all? Creative takes only the End's void (and /kill-like causes); spectators none.
export function takesDamage(m, cause) {
  const md = mode(m);
  if (md === 'spectator') return false;
  if (md === 'creative') return cause === 'void';
  return true;
}
// Wild POKeMON: spectators never; creative follows the OPTION toggle (G.rules.wild); the rest always.
export function encountersOn(m, creativeWildOption = true) {
  const md = mode(m);
  if (md === 'spectator') return false;
  if (md === 'creative') return !!creativeWildOption;
  return true;
}
// Break time: creative breaks instantly anything survival could break with some tool (spec.hard >= 0) that is not a
// protected cell; spectators break nothing; otherwise the survival answer (from items.js breakInfo) is passed through.
//
// WIRING NOTE (stage 8a): harvest: false alone is NOT enough to make Creative drop nothing. player.js finishBreak0 drops
// crops, Kanto doors (drop(spec.drop)), dig tiles and spawner XP without reading info.harvest, so the call site must also
// skip the block's own drop when info.creative (or !rules(G.mode).blockDrops) is set, while still spilling chest, furnace
// and campfire contents as Minecraft does. Creative also skips the RNG draws survival makes for ore and tree drops:
// harmless in single player, but stage 9.5 should check whether any co-op path expects both sides to draw alike.
export function breakFor(m, spec, protectedCell, survivalInfo) {
  const md = mode(m);
  if (md === 'spectator') return null;
  if (md === 'creative') {
    if (!spec || !(spec.hard >= 0) || protectedCell) return null;
    return { ticks: 1, harvest: false, creative: true };   // creative never drops the block (Minecraft's rule)
  }
  return survivalInfo === undefined ? null : survivalInfo;
}

// ------------------------------------------------------------------------------------------- protected things (6.1, 6.3)
// Blocks no mode can break and no creative tab offers: end portal frames, bedrock, spawners, infested stone, nether and
// end portal tiles, lava and fire tiles, the dragon egg, and every block whose hardness is below zero.
export const PROTECTED_IDS = new Set(['end_portal_frame', 'end_portal', 'nether_portal', 'bedrock', 'spawner', 'dragon_egg',
  'lava', 'soul_fire', 'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks',
  'infested_chiseled_stone_bricks']);
// The Wither's items are in items.json but its gameplay is paused: no creative tab offers them either.
export const PAUSED_IDS = new Set(['wither_skeleton_skull', 'nether_star', 'beacon', 'wither_rose']);
export function isProtectedItem(id, it) {
  if (PROTECTED_IDS.has(id)) return true;
  if (!it) return true;
  if (it.hidden) return true;
  if (it.block && typeof it.block.hard === 'number' && it.block.hard < 0) return true;
  if (typeof id !== 'string' || /^infested_/.test(id)) return true;
  return false;
}
export const inCreativeTabs = (id, it) => !isProtectedItem(id, it) && !PAUSED_IDS.has(id);

// ------------------------------------------------------------------------------------------- hardcore (6.4)
// The world list entry after a hardcore death. The caller writes it to localStorage (small, synchronous) BEFORE it
// starts the full save, so a reload or a failed save cannot undo the death. Never mutates the entry it is given.
export function hardcoreDeath(entry, cause, at = Date.now()) {
  const e = entry && typeof entry === 'object' ? entry : {};
  return { ...e, hc: { dead: true, at: num(at), cause: txt(cause) } };
}
export const isDead = (entry) => !!(entry && entry.hc && entry.hc.dead);
// The mode a world boots in: a dead hardcore world is spectator whatever its save says; Classic is survival.
export function bootMode(entry, save) {
  if (isDead(entry) || (save && save.hc && save.hc.dead)) return 'spectator';
  if (!entry || entry.type === 'classic' || entry.id === 'classic') return 'survival';
  const m = mode(entry.mode);
  return m === 'spectator' ? 'spectator' : m;
}
// Autosave clock: true when a hardcore world is due (every 45 s of play); events (warp, portal, teleport, battle start)
// call the save directly.
export function autosaveDue(m, playTime, lastSave) {
  if (!rules(m).autosave) return false;
  return num(playTime) - num(lastSave) >= AUTOSAVE_SECONDS;
}

// ------------------------------------------------------------------------------------------- menus (6.5)
// START rows. Classic's menu is today's and never changes. Generated worlds add OPTION (after CO-OP, so CO-OP keeps
// row 5) and TITLE. A spectator sees POKeDEX, POKeMON, STEVE, OPTION and TITLE only.
export const CLASSIC_START = ['POKéDEX', 'POKéMON', 'BAG', 'STEVE', 'SAVE', 'CO-OP', 'EXIT'];
export function startRows(gen, m) {
  if (!gen) return CLASSIC_START.slice();
  if (mode(m) === 'spectator') return ['POKéDEX', 'POKéMON', 'STEVE', 'OPTION', 'TITLE'];
  return ['POKéDEX', 'POKéMON', 'BAG', 'STEVE', 'SAVE', 'CO-OP', 'OPTION', 'TITLE', 'EXIT'];
}
// OPTION rows: MUSIC always, WILD POKeMON in Creative, DIFFICULTY in Survival (not Hardcore, which is locked).
export function optionRows(m) {
  const md = mode(m), rows = ['MUSIC'];
  if (md === 'creative') rows.push('WILD POKéMON');
  if (md === 'survival') rows.push('DIFFICULTY');
  return rows;
}

// ------------------------------------------------------------------------------------------- labels (section 15)
const MODE_NAME = { survival: 'Survival', creative: 'Creative', hardcore: 'Hardcore', spectator: 'Spectator' };
const DIFF_NAME = { peaceful: 'Peaceful', easy: 'Easy', normal: 'Normal', hard: 'Hard' };
const TYPE_NAME = { kanto: 'Kanto World', wild: 'Wild World', classic: 'Classic Kanto' };
export const modeName = (m) => MODE_NAME[mode(m)];
export const diffName = (d) => DIFF_NAME[diff(d)];
export const typeName = (t) => (typeof t === 'string' && Object.hasOwn(TYPE_NAME, t) ? TYPE_NAME[t] : TYPE_NAME.kanto);
export const MODE_DESC = {
  survival: 'Search for resources, craft, gain levels, health and hunger',
  hardcore: 'Same as Survival Mode, locked at hardest difficulty, and one life only',
  creative: 'Unlimited resources and destroy blocks instantly',
};
export const HARDCORE_BATTLE_LINE = 'Losing a POKéMON battle counts as dying.';
export const TYPE_DESC = { kanto: 'Kanto on the coast of a big wild world', wild: 'A big wild world with no Kanto' };
// The world list's grey line (7.3): "Kanto World, Survival Mode"; hardcore worlds show "Hardcore Mode!" in red instead
// of the mode (the caller colours it: { text, red }).
export function worldLine(entry) {
  const e = entry || {};
  const hard = isHardcore(e.mode) || isDead(e);
  if (e.type === 'classic' || e.id === 'classic') return { type: '', mode: 'Survival Mode', red: false };
  return { type: typeName(e.type), mode: hard ? 'Hardcore Mode!' : modeName(e.mode) + ' Mode', red: hard };
}

// ------------------------------------------------------------------------------------------- seeds (7.4)
// Java's String.hashCode over UTF-16 code units, as a signed 32-bit int.
export function javaHash(s) {
  let h = 0;
  const str = txt(s);
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}
// Seed text to a 32-bit seed. Leading and trailing spaces are trimmed first; blank means random (`rand32` gives the
// random int, crypto.getRandomValues by default); digits with an optional sign are a number reduced to 32 bits; anything
// else is hashed with Java's String.hashCode (Minecraft's rule). Returns { seed, seedText, random }.
export function seedFromText(text, rand32 = cryptoRand32) {
  const t = txt(text).trim();
  if (!t) {
    let r = 0;
    try { r = typeof rand32 === 'function' ? rand32() : cryptoRand32(); } catch (e) { r = cryptoRand32(); }
    return { seed: num(r) | 0, seedText: '', random: true };
  }
  if (/^[+-]?\d+$/.test(t)) {
    let v = 0n;
    try { v = BigInt(t); } catch (e) { return { seed: javaHash(t), seedText: t, random: false }; }
    return { seed: Number(BigInt.asIntN(32, v)), seedText: t, random: false };
  }
  return { seed: javaHash(t), seedText: t, random: false };
}
export function cryptoRand32() {
  try {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0] | 0;
  } catch (e) {
    return (Math.random() * 4294967296) | 0;
  }
}
// The text fields' limits (Minecraft's: world names and seeds are 32 characters).
export const NAME_MAX = 32, SEED_MAX = 32, SEARCH_MAX = 50;
// A world name as stored: trimmed, at most 32 characters, "New World" when blank.
export function cleanName(s) { const t = txt(s).replace(/[\u0000-\u001f]/g, '').trim().slice(0, NAME_MAX); return t || 'New World'; }

// The boot request Create New World hands to the boot (7.4): { op: 'new', name, type, mode, diff, seedText }.
export function newWorldRequest(o) {
  const { name, type, mode: m, diff: d, seedText } = o && typeof o === 'object' ? o : {};
  const st = normalize({ mode: m, diff: d });
  return { op: 'new', name: cleanName(name), type: WORLD_TYPES.includes(type) ? type : 'kanto', mode: st.mode === 'spectator' ? 'survival' : st.mode,
    diff: st.diff, seedText: txt(seedText).slice(0, SEED_MAX) };
}
