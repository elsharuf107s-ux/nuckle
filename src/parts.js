// The garage's parts catalogue and everything derived from a build.
//
// A build picks one part for each slot (head, torso, arms, legs, backpack, weapon, off-hand) plus
// paint. Each part contributes additive (`add`) and multiplicative (`mul`) stat changes, and a
// model style that mechModel.js knows how to draw. deriveMech() folds a build into the same
// "def" shape the fixed enemy mechs use, so the Mech class needs no special casing.
//
// This module has no browser or three.js dependency, so it can be unit-tested in plain Node.

export const SLOTS = ['head', 'torso', 'arms', 'legs', 'backpack', 'weapon', 'offhand'];

// ------------------------------------------------------------------ frame and weight

/** A bare frame. Parts add to this. */
const BASE = {
  hp: 700, weight: 0,
  en: 100, enGround: 42, enAir: 16,
  speed: 40, airSpeed: 56, ascendSpeed: 58, ascendCost: 24,
  dashSpeed: 230, dashTime: 0.26, dashCost: 22,
  turn: 12, staggerAt: 220,
  missileCharges: 2, missileTurn: 0,
};

/** Total weight of the default build. Heavier builds slow down, lighter ones speed up. */
const REF_WEIGHT = 91;
const WEIGHT_SLOPE = 0.0035; // speed change per weight unit away from the reference

// ------------------------------------------------------------------ parts

/*
 * add keys:  any BASE key (hp, weight, en, ascendSpeed, dashCost, staggerAt, missileCharges, ...)
 * mul keys:  mobility (walk + air speed), dash (dash speed), melee, fireRate, reload, missileDamage, burstGain
 * `model` is the style handed to the model builder.
 */
export const PARTS = {
  head: [
    { id: 'vfin', name: 'V-FIN SENSOR', model: 'v', desc: 'Balanced command unit with standard sensors.',
      add: { hp: 150, weight: 5 } },
    { id: 'scout', name: 'MONO-EYE SCOUT', model: 'mono', desc: 'Light optics with a wide sweep. Missiles track much tighter.',
      add: { hp: 90, weight: 3, missileTurn: 1.6 } },
    { id: 'horn', name: 'COMMANDER HORN', model: 'horn', desc: 'Ace-grade unit. The burst gauge charges faster and sabers hit a little harder.',
      add: { hp: 130, weight: 6 }, mul: { burstGain: 1.3, melee: 1.06 } },
    { id: 'visor', name: 'SENTINEL VISOR', model: 'visor', desc: 'Armoured visor helm. Tougher, and harder to stagger.',
      add: { hp: 260, weight: 8, staggerAt: 60 } },
  ],
  torso: [
    { id: 'std', name: 'STANDARD CHEST', model: 'std', bulk: 1.0, desc: 'Well-rounded chassis.',
      add: { hp: 1100, weight: 26 } },
    { id: 'light', name: 'LIGHT FRAME', model: 'light', bulk: 0.88, desc: 'Stripped-down frame. Quick to recover EN, but thin armour.',
      add: { hp: 760, weight: 17, enGround: 6 } },
    { id: 'heavy', name: 'HEAVY PLATE', model: 'heavy', bulk: 1.24, desc: 'Thick slab armour. Very tough and hard to stagger, but heavy.',
      add: { hp: 1650, weight: 40, staggerAt: 120 } },
    { id: 'reactor', name: 'REACTOR CORE', model: 'reactor', bulk: 1.05, desc: 'Oversized reactor: more boost fuel, faster EN recovery, quicker burst.',
      add: { hp: 1000, weight: 28, en: 25, enGround: 10, enAir: 4 }, mul: { burstGain: 1.2 } },
  ],
  arms: [
    { id: 'std', name: 'STANDARD ARMS', model: 'std', desc: 'Balanced servos.',
      add: { hp: 220, weight: 12 } },
    { id: 'assault', name: 'ASSAULT BRACERS', model: 'assault', desc: 'Armoured bracers. Extra armour and a stronger saber, but slower reloads.',
      add: { hp: 420, weight: 18 }, mul: { melee: 1.1, reload: 0.9 } },
    { id: 'precision', name: 'PRECISION ARMS', model: 'precision', desc: 'Fine servos: faster weapon cycling and quicker reloads.',
      add: { hp: 150, weight: 9 }, mul: { fireRate: 1.1, reload: 1.15 } },
    { id: 'blade', name: 'BLADE ARMS', model: 'blade', desc: 'Forearm blade fins. Heavy saber damage; the gun cycles a touch slower.',
      add: { hp: 240, weight: 13 }, mul: { melee: 1.3, fireRate: 0.95 } },
  ],
  legs: [
    { id: 'std', name: 'STANDARD LEGS', model: 'std', desc: 'Balanced locomotion.',
      add: { hp: 420, weight: 22 } },
    { id: 'sprint', name: 'SPRINT LEGS', model: 'sprint', desc: 'Light digitigrade legs. Fast on the ground, and dashes cost less EN.',
      add: { hp: 260, weight: 15, dashCost: -4 }, mul: { mobility: 1.1 } },
    { id: 'tank', name: 'TANK LEGS', model: 'tank', desc: 'Armoured pillars: lots of armour and stagger resistance, but slow.',
      add: { hp: 780, weight: 36, staggerAt: 100 }, mul: { mobility: 0.92 } },
    { id: 'jump', name: 'JUMP LEGS', model: 'jump', desc: 'Calf boosters: stronger ascent and faster EN recovery in the air.',
      add: { hp: 340, weight: 20, ascendSpeed: 10, enAir: 14 } },
  ],
  backpack: [
    { id: 'std', name: 'STANDARD PACK', model: 'std', desc: 'Basic thrusters and a saber rack.',
      add: { weight: 10 } },
    { id: 'booster', name: 'HEAVY BOOSTER', model: 'booster', desc: 'Big thruster pack: far more boost fuel and a faster climb.',
      add: { weight: 18, en: 45, ascendSpeed: 6, enGround: 6 } },
    { id: 'pod', name: 'MISSILE POD PACK', model: 'pod', desc: 'Twin racks: a third missile charge and harder-hitting missiles.',
      add: { weight: 16, missileCharges: 1, en: -10 }, mul: { missileDamage: 1.25 } },
    { id: 'wing', name: 'WING VERNIER', model: 'wing', desc: 'Vector wings: faster, cheaper dashes and sharper turning. Fragile.',
      add: { weight: 9, hp: -80, dashSpeed: 40, dashCost: -6, turn: 2 } },
  ],
  weapon: [
    { id: 'rifle', name: 'BEAM RIFLE', model: 'rifle', desc: 'Reliable all-rounder: accurate, 8-round magazine.',
      add: { weight: 6 },
      weapon: { name: 'BEAM RIFLE', kind: 'beam', damage: 210, cooldown: 0.34, mag: 8, reload: 1.9, speed: 780, spread: 0, knock: 6, shake: 0.07 } },
    { id: 'mg', name: 'RAPID BEAM GUN', model: 'mg', desc: 'Stream of light beams. Huge magazine, low damage per hit, a little spread.',
      add: { weight: 8 },
      weapon: { name: 'RAPID BEAM GUN', kind: 'bullet', damage: 42, cooldown: 0.085, mag: 30, reload: 2.2, speed: 640, spread: 0.022, knock: 1.5, shake: 0.03 } },
    { id: 'bazooka', name: 'BLAST BAZOOKA', model: 'cannon', desc: 'Slow explosive shells with a wide blast. Three rounds.',
      add: { weight: 12 },
      weapon: { name: 'BLAST BAZOOKA', kind: 'cannon', damage: 520, cooldown: 1.05, mag: 3, reload: 2.2, speed: 300, spread: 0, knock: 40, shake: 0.35,
        splash: { radius: 26, damage: 260 } } },
    { id: 'sniper', name: 'BEAM SNIPER', model: 'sniper', desc: 'Long-barrel rifle: very fast, heavy shots. Four rounds.',
      add: { weight: 10 },
      weapon: { name: 'BEAM SNIPER', kind: 'beam', damage: 430, cooldown: 0.85, mag: 4, reload: 2.0, speed: 1300, spread: 0, knock: 14, radius: 1.5, shake: 0.15 } },
    { id: 'sabers', name: 'TWIN SABERS', model: 'saber', desc: 'No gun: both mouse buttons swing the saber combo. Big melee bonus, deflects 20% of gunfire, cheaper dashes.',
      add: { weight: 6, enGround: 8, dashCost: -4 }, mul: { melee: 1.4 }, guard: 0.2,
      weapon: { name: 'TWIN SABERS', kind: 'melee', damage: 0, cooldown: 0, mag: 0, reload: 0, speed: 0, spread: 0, knock: 0, shake: 0 } },
  ],
  offhand: [
    { id: 'shield', name: 'BEAM SHIELD', model: 'shield', desc: 'Absorbs 22% of incoming gunfire, missiles and shells (not saber hits).',
      add: { weight: 10 }, guard: 0.22 },
    { id: 'cannon', name: 'SHOULDER CANNON', model: 'cannon', desc: 'Press F: a heavy splash shell. Recharges in 7 seconds.',
      add: { weight: 12 },
      ability: { name: 'SHOULDER CANNON', kind: 'cannon', damage: 380, cooldown: 7, speed: 320, knock: 50, splash: { radius: 24, damage: 190 } } },
    { id: 'none', name: 'NO OFF-HAND', model: 'none', desc: 'Lighter and quicker on its feet.',
      add: { weight: 0, enGround: 8 }, mul: { mobility: 1.03 } },
  ],
};

// ------------------------------------------------------------------ paint

export const PAINTS = [
  { id: 'vanguard', name: 'VANGUARD', main: '#eceff6', sub: '#2a56b8', accent: '#d23a32', trim: '#f5c518' },
  { id: 'crimson', name: 'CRIMSON', main: '#c0282f', sub: '#1d1d26', accent: '#d9ab2b', trim: '#d9ab2b' },
  { id: 'stealth', name: 'STEALTH', main: '#3a3f4a', sub: '#1a1c22', accent: '#55e0ff', trim: '#55e0ff' },
  { id: 'desert', name: 'DESERT', main: '#c9b28a', sub: '#7a5f3a', accent: '#566b3a', trim: '#f0e0b0' },
  { id: 'arctic', name: 'ARCTIC', main: '#f2f6fb', sub: '#8fb4d6', accent: '#e8eef5', trim: '#ff7a3d' },
  { id: 'violet', name: 'VIOLET', main: '#e8e0f5', sub: '#5b3a9a', accent: '#2b2438', trim: '#ffd23d' },
];

/** Energy colour: beam shots, saber blade and eye glow. */
export const ENERGY = {
  pink: { name: 'ROSE', beam: 0xff6ad5, blade: 0xff5fd2, glow: 0x44ff9a, css: '#ff6ad5' },
  cyan: { name: 'ICE', beam: 0x6adfff, blade: 0x6adfff, glow: 0xffe14a, css: '#6adfff' },
  green: { name: 'VERDANT', beam: 0x78ff8a, blade: 0x70ff90, glow: 0xff4f6a, css: '#78ff8a' },
  orange: { name: 'EMBER', beam: 0xffa040, blade: 0xffa040, glow: 0x58c8ff, css: '#ffa040' },
  red: { name: 'CRIMSON', beam: 0xff3a4a, blade: 0xff3030, glow: 0xffee33, css: '#ff3a4a' },
  gold: { name: 'GOLD', beam: 0xffe070, blade: 0xfff0a0, glow: 0xff5fd2, css: '#ffe070' },
};

export const THRUSTERS = {
  blue: { name: 'ION BLUE', flame: 0x6fd0ff, css: '#6fd0ff' },
  orange: { name: 'AFTERBURN', flame: 0xffa050, css: '#ffa050' },
  green: { name: 'TOXIC', flame: 0x7dff7a, css: '#7dff7a' },
  magenta: { name: 'PLASMA', flame: 0xe36bff, css: '#e36bff' },
  white: { name: 'PURE', flame: 0xf4f8ff, css: '#f4f8ff' },
};

const DARK = 0x3a3f4d; // frame metal; the same for every build

// ------------------------------------------------------------------ builds

export const DEFAULT_BUILD = Object.freeze({
  name: 'AEGIS-01',
  head: 'vfin', torso: 'std', arms: 'std', legs: 'std', backpack: 'std', weapon: 'rifle', offhand: 'shield',
  paint: { main: '#eceff6', sub: '#2a56b8', accent: '#d23a32', trim: '#f5c518' },
  energy: 'pink', thruster: 'blue',
});

export const partOf = (slot, id) => PARTS[slot].find((p) => p.id === id) ?? PARTS[slot][0];

const HEX = /^#[0-9a-fA-F]{6}$/;
const hexToInt = (h) => parseInt(h.slice(1), 16);

export function cleanName(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9 \-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14).trim(); // trim again: the cut can land on a space
  return s || DEFAULT_BUILD.name;
}

/** Turn anything (e.g. parsed localStorage JSON) into a valid build, filling gaps from the default. */
export function sanitizeBuild(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULT_BUILD, paint: { ...DEFAULT_BUILD.paint } };
  out.name = cleanName(src.name);
  for (const slot of SLOTS) {
    if (typeof src[slot] === 'string' && PARTS[slot].some((p) => p.id === src[slot])) out[slot] = src[slot];
  }
  for (const k of ['main', 'sub', 'accent', 'trim']) {
    if (typeof src.paint?.[k] === 'string' && HEX.test(src.paint[k])) out.paint[k] = src.paint[k].toLowerCase();
  }
  if (src.energy in ENERGY) out.energy = src.energy;
  if (src.thruster in THRUSTERS) out.thruster = src.thruster;
  return out;
}

export function randomBuild(rand = Math.random) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const b = sanitizeBuild({});
  for (const slot of SLOTS) b[slot] = pick(PARTS[slot]).id;
  const paint = pick(PAINTS);
  b.paint = { main: paint.main, sub: paint.sub, accent: paint.accent, trim: paint.trim };
  b.energy = pick(Object.keys(ENERGY));
  b.thruster = pick(Object.keys(THRUSTERS));
  return b;
}

// ------------------------------------------------------------------ derivation

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Sustained damage per second over a full magazine-and-reload cycle (melee-only builds use the saber combo). */
function sustainedDps(w, melee) {
  if (w.kind === 'melee') return Math.round(340 * melee); // a combo's raw 600 dps, discounted for the need to stay in reach
  const cycle = w.mag * w.cooldown + w.reload;
  const splashBonus = w.splash ? w.splash.damage * 0.3 : 0;
  return Math.round(((w.damage + splashBonus) * w.mag) / cycle);
}

/** Fold a build into numbers. Pure and cheap, so the garage calls it for every hover preview. */
export function deriveStats(build) {
  const b = sanitizeBuild(build);
  const parts = SLOTS.map((slot) => partOf(slot, b[slot]));
  const s = { ...BASE };
  const mul = { mobility: 1, dash: 1, melee: 1, fireRate: 1, reload: 1, missileDamage: 1, burstGain: 1 };
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.add ?? {})) s[k] = (s[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.mul ?? {})) mul[k] *= v;
  }

  const wf = clamp(1 + (REF_WEIGHT - s.weight) * WEIGHT_SLOPE, 0.82, 1.15);
  const weaponPart = partOf('weapon', b.weapon);
  const w = { ...weaponPart.weapon };
  w.cooldown = w.cooldown / mul.fireRate;
  w.reload = w.reload / mul.reload;

  const offPart = partOf('offhand', b.offhand);
  const stats = {
    hp: Math.round(s.hp),
    weight: s.weight,
    weightFactor: wf,
    en: Math.round(s.en),
    enGround: s.enGround,
    enAir: s.enAir,
    speed: s.speed * mul.mobility * wf,
    airSpeed: s.airSpeed * mul.mobility * wf,
    ascendSpeed: s.ascendSpeed,
    ascendCost: s.ascendCost,
    dashSpeed: (s.dashSpeed * mul.dash) * wf,
    dashTime: s.dashTime,
    dashCost: Math.max(10, s.dashCost),
    turn: s.turn * wf,
    staggerAt: s.staggerAt,
    guard: Math.min(0.45, (offPart.guard ?? 0) + (weaponPart.guard ?? 0)), // shield and saber deflection stack, capped
    melee: mul.melee,
    burstGain: mul.burstGain,
    missileCharges: s.missileCharges,
    missileDamage: mul.missileDamage,
    missileTurn: s.missileTurn,
    weapon: w,
    ability: offPart.ability ? { ...offPart.ability } : null,
  };
  stats.dps = sustainedDps(w, mul.melee);
  return stats;
}

/** Palette the model builder expects, from the chosen paint and colours. */
export function paletteOf(build) {
  const b = sanitizeBuild(build);
  const e = ENERGY[b.energy];
  return {
    main: hexToInt(b.paint.main), sub: hexToInt(b.paint.sub), accent: hexToInt(b.paint.accent), trim: hexToInt(b.paint.trim),
    dark: DARK, glow: e.glow, blade: e.blade, flame: THRUSTERS[b.thruster].flame,
  };
}

/** Everything the game needs to field a build: the model spec, a Mech "def", and the derived stats. */
export function deriveMech(build) {
  const b = sanitizeBuild(build);
  const stats = deriveStats(b);
  const m = (slot) => partOf(slot, b[slot]).model;
  const spec = {
    scale: 1,
    head: m('head'), torso: m('torso'), arms: m('arms'), legs: m('legs'), backpack: m('backpack'),
    weapon: m('weapon'), offhand: m('offhand'),
    bulk: partOf('torso', b.torso).bulk,
    palette: paletteOf(b),
  };
  const def = {
    name: b.name,
    spec,
    hp: stats.hp, en: stats.en,
    speed: stats.speed, airSpeed: stats.airSpeed, ascendSpeed: stats.ascendSpeed, ascendCost: stats.ascendCost,
    dashSpeed: stats.dashSpeed, dashTime: stats.dashTime, dashCost: stats.dashCost,
    enGround: stats.enGround, enAir: stats.enAir, dashInvuln: 0.2, turn: stats.turn,
    staggerAt: stats.staggerAt, guard: stats.guard, score: 0,
  };
  return { build: b, stats, spec, def, energy: ENERGY[b.energy] };
}

// ------------------------------------------------------------------ stat ranges (for the garage's bars)

let ranges = null;

/** Min and max of each displayed stat across every possible build, computed once. */
export function statRanges() {
  if (ranges) return ranges;
  const keys = ['hp', 'speed', 'en', 'dps', 'melee', 'missiles', 'weight'];
  const r = Object.fromEntries(keys.map((k) => [k, { min: Infinity, max: -Infinity }]));
  const slotIds = SLOTS.map((slot) => PARTS[slot].map((p) => p.id));
  const idx = SLOTS.map(() => 0);
  for (;;) {
    const b = {};
    SLOTS.forEach((slot, i) => { b[slot] = slotIds[i][idx[i]]; });
    const s = deriveStats(b);
    const vals = { hp: s.hp, speed: s.speed, en: s.en, dps: s.dps, melee: s.melee, missiles: s.missileCharges * s.missileDamage, weight: s.weight };
    for (const k of keys) {
      r[k].min = Math.min(r[k].min, vals[k]);
      r[k].max = Math.max(r[k].max, vals[k]);
    }
    let i = 0;
    while (i < SLOTS.length && ++idx[i] === slotIds[i].length) idx[i++] = 0;
    if (i === SLOTS.length) break;
  }
  ranges = r;
  return r;
}
