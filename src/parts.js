// The garage's parts catalogue and everything derived from a build.
//
// A build picks one part for each of sixteen slots, spends tuning points, and paints the result. The
// slots sit on eleven HARDPOINTS, the places on the machine that the garage lets you click: the
// shoulders are separate left and right (each with an armor pad and a weapon mount on top), so the
// two sides can differ. Each part contributes additive (`add`) and multiplicative (`mul`) stat changes,
// and a model style that the model builder knows how to draw. deriveMech() folds a build into the same
// "def" shape the fixed enemy mechs use, so the Mech class needs no special casing.
//
// Two budgets make the choices bite:
//   LOAD   the legs carry a weight limit; going over it slows the mech down.
//   POWER  the torso supplies power; parts draw it; a shortfall slows EN recovery, weapon cycling and
//          every cooldown (missiles, off-hand ability, sub-weapon).
//
// This module has no browser or three.js dependency, so it can be unit-tested in plain Node.

export const SLOTS = [
  'head', 'crest', 'torso', 'pilot', 'arms', 'legs',
  'shoulderL', 'shoulderR', 'mountL', 'mountR',
  'backpack', 'core', 'skirt', 'weapon', 'offhand', 'sub',
];

/** The two shoulders pick from one catalogue, and so do the two weapon mounts. */
const POOL = { shoulderL: 'shoulder', shoulderR: 'shoulder', mountL: 'mount', mountR: 'mount' };
export const poolOf = (slot) => POOL[slot] ?? slot;
/** The other side of a left/right slot (shoulders and mounts), for the symmetry switch. */
export const MIRROR = { shoulderL: 'shoulderR', shoulderR: 'shoulderL', mountL: 'mountR', mountR: 'mountL' };

/** What the garage calls each slot. */
export const SLOT_LABELS = {
  head: 'HELMET', crest: 'CREST', torso: 'FRAME', pilot: 'PILOT', arms: 'ARMS', legs: 'LEGS',
  shoulderL: 'ARMOR', shoulderR: 'ARMOR', mountL: 'WEAPON MOUNT', mountR: 'WEAPON MOUNT',
  backpack: 'BACKPACK', core: 'CORE', skirt: 'SKIRT', weapon: 'WEAPON', offhand: 'OFF-HAND', sub: 'SUB-WEAPON',
};

/**
 * The places on the machine you click in the garage. A hardpoint can hold several slots (a shoulder has an
 * armor pad and a weapon mount; the head has a helmet and a crest) and shows them as tabs.
 */
export const HARDPOINTS = [
  { id: 'head', name: 'HEAD', slots: ['head', 'crest'] },
  { id: 'chest', name: 'CHEST', slots: ['torso', 'pilot'] },
  { id: 'arms', name: 'ARMS', slots: ['arms'] },
  { id: 'legs', name: 'LEGS', slots: ['legs'] },
  { id: 'shoulderL', name: 'L SHOULDER', slots: ['shoulderL', 'mountL'] },
  { id: 'shoulderR', name: 'R SHOULDER', slots: ['shoulderR', 'mountR'] },
  { id: 'back', name: 'BACKPACK', slots: ['backpack'] },
  { id: 'waist', name: 'WAIST', slots: ['core', 'skirt'] },
  { id: 'handR', name: 'R HAND', slots: ['weapon'] },
  { id: 'handL', name: 'L HAND', slots: ['offhand'] },
  { id: 'hips', name: 'HIPS', slots: ['sub'] },
];
export const hardpointOf = (slot) => HARDPOINTS.find((h) => h.slots.includes(slot));

/** Cosmetic markings painted on the machine. */
export const MARKS = [
  { id: 'none', name: 'NONE' },
  { id: 'stripe', name: 'STRIPES' },
  { id: 'chevron', name: 'CHEVRONS' },
  { id: 'hazard', name: 'HAZARD' },
];

// ------------------------------------------------------------------ frame and budgets

/** A bare frame. Parts add to this. */
const BASE = {
  hp: 700, weight: 0,
  en: 100, enGround: 42, enAir: 16,
  speed: 40, airSpeed: 56, ascendSpeed: 58, ascendCost: 24,
  dashSpeed: 230, dashTime: 0.26, dashCost: 22,
  turn: 12, staggerAt: 220,
  missileCharges: 2, missileTurn: 0,
  regen: 0,           // armor repaired per second once out of combat for a few seconds
  burstTime: 12,      // seconds a BURST lasts
  dashInvuln: 0.2,    // seconds of invulnerability at the start of a dash
  radar: 420,         // radar range
  resupplyHeal: 0.25, // fraction of armor repaired between waves
  jam: 0,             // fraction of the turning rate enemy missiles lose against this mech
  barrier: 0,         // energy barrier that soaks damage before armor, then recharges
  supply: 0, draw: 0, load: 0, // power budget (torso supplies, parts draw) and weight limit (legs)
};

/** Total weight of the default build. Heavier builds slow down, lighter ones speed up. */
const REF_WEIGHT = 103;
const WEIGHT_SLOPE = 0.0035; // speed change per weight unit away from the reference
const OVERLOAD_SLOPE = 0.014; // extra slowdown per weight unit beyond the legs' load limit
const OVERLOAD_FLOOR = 0.55;
const POWER_FLOOR = 0.4;     // a deficit never cuts the whole kit below 40% speed
const POWER_CURVE = 1.4;     // a shortfall bites harder than it looks: factor = (supply / draw) ^ curve
const GUARD_CAP = 0.35;      // shield, saber deflection and shoulder shells together never absorb more than this
const MELEE_SOFT_CAP = 1.6;  // melee bonuses stack multiplicatively; beyond this each extra point counts half
const GUN_SOFT_CAP = 1.3;    // likewise for gun damage bonuses
const BURST_GAIN_CAP = 2.0;  // the burst gauge never fills more than twice as fast
const MAX_MISSILE_CHARGES = 4;
const PELLET_COVERAGE = 0.8; // share of a shotgun's pellets that land on a typical target (for the firepower bar)

/** Tuning: spend points on four dials. Each point is a small flat bonus. */
export const TUNING_MAX = 6;   // per dial
export const TUNING_POOL = 12; // in total
export const TUNING = [
  { id: 'plating', name: 'PLATING', effect: '+4% armor per point' },
  { id: 'servos', name: 'SERVOS', effect: '+2% speed and dash, +3% turning per point' },
  { id: 'thrusters', name: 'THRUSTERS', effect: '+4% boost fuel, +1.5 climb per point' },
  { id: 'weapons', name: 'WEAPONS', effect: '+3% damage per point' },
];

// ------------------------------------------------------------------ parts

/*
 * add keys:  any BASE key (hp, weight, en, ascendSpeed, dashCost, staggerAt, missileCharges, supply, draw, load, ...)
 * mul keys:  mobility (walk + air speed), dash (dash speed), melee, fireRate, reload, gunDamage, missileDamage, burstGain
 * guard:      share of gunfire, missiles and shells absorbed; every part's guard adds up (capped)
 * `model` is the style handed to the model builder. `draw` is the power a part consumes.
 */
export const PARTS = {
  head: [
    { id: 'vfin', name: 'V-FIN SENSOR', model: 'v', desc: 'Balanced command unit with standard sensors.',
      add: { hp: 150, weight: 5, draw: 6 } },
    { id: 'scout', name: 'MONO-EYE SCOUT', model: 'mono', desc: 'Light optics with a wide sweep. Missiles track much tighter.',
      add: { hp: 90, weight: 3, missileTurn: 1.6, draw: 5 } },
    { id: 'horn', name: 'COMMANDER HORN', model: 'horn', desc: 'Ace-grade unit. The burst gauge charges faster and sabers hit a little harder.',
      add: { hp: 130, weight: 6, draw: 8 }, mul: { burstGain: 1.3, melee: 1.06 } },
    { id: 'visor', name: 'SENTINEL VISOR', model: 'visor', desc: 'Armoured visor helm. Tougher, and harder to stagger.',
      add: { hp: 260, weight: 8, staggerAt: 60, draw: 7 } },
    { id: 'recon', name: 'RECON ARRAY', model: 'recon', desc: 'Sensor dish: the radar sees much farther and missiles track a little tighter. Power hungry.',
      add: { hp: 90, weight: 6, missileTurn: 0.8, radar: 250, draw: 12 } },
    { id: 'ace', name: 'ACE VISOR', model: 'ace', desc: 'Sleek helm of a top pilot: a quicker trigger finger, a faster burst gauge and a little more saber damage. Power hungry.',
      add: { hp: 110, weight: 5, draw: 10 }, mul: { fireRate: 1.06, burstGain: 1.15, melee: 1.04 } },
    { id: 'jammer', name: 'ECM CROWN', model: 'jammer', desc: 'Electronic warfare crown: enemy missiles lose 40% of their turning, so most of them miss.',
      add: { hp: 80, weight: 5, draw: 14, jam: 0.4 } },
    { id: 'knight', name: 'KNIGHT HELM', model: 'knight', desc: 'A closed, armoured helm with a narrow visor slit: tougher and steadier, but heavy.',
      add: { hp: 200, weight: 7, staggerAt: 30, draw: 6 }, guard: 0.02 },
    { id: 'hawk', name: 'HAWK SIGHT', model: 'hawk', desc: 'A beaked targeting helm: a long-range radar and much tighter missile tracking. Power hungry.',
      add: { hp: 80, weight: 4, radar: 120, missileTurn: 0.4, draw: 9 } },
    { id: 'twin', name: 'TWIN-EYE HELM', model: 'twin', desc: 'Twin cameras on a light helm: a quicker trigger and faster reloads.',
      add: { hp: 100, weight: 5, draw: 8 }, mul: { fireRate: 1.04, reload: 1.06 } },
  ],
  crest: [
    { id: 'auto', name: 'HELMET DEFAULT', model: 'auto', desc: 'Keeps the crest that comes with your helmet.', add: {} },
    { id: 'vfin', name: 'V-FIN', model: 'vfin', desc: 'The classic V-shaped fin. Purely cosmetic.', add: {} },
    { id: 'horn', name: 'COMMAND HORN', model: 'horn', desc: 'A single tall horn. Purely cosmetic.', add: {} },
    { id: 'blade', name: 'BLADE CREST', model: 'blade', desc: 'A swept blade fin along the helmet. Purely cosmetic.', add: {} },
    { id: 'antenna', name: 'TWIN ANTENNA', model: 'antenna', desc: 'Two slim whip antennae. Purely cosmetic.', add: {} },
    { id: 'crown', name: 'SPIKE CROWN', model: 'crown', desc: 'A ring of short spikes. Purely cosmetic.', add: {} },
    { id: 'none', name: 'NO CREST', model: 'none', desc: 'A clean, bare helmet. Purely cosmetic.', add: {} },
  ],
  torso: [
    { id: 'std', name: 'STANDARD CHEST', model: 'std', bulk: 1.0, desc: 'Well-rounded chassis. Power output 100.',
      add: { hp: 1100, weight: 26, supply: 100 } },
    { id: 'light', name: 'LIGHT FRAME', model: 'light', bulk: 0.88, desc: 'Stripped-down frame. Quick to recover EN, but thin armour and little power.',
      add: { hp: 820, weight: 17, enGround: 6, supply: 88 } },
    { id: 'heavy', name: 'HEAVY PLATE', model: 'heavy', bulk: 1.24, desc: 'Thick slab armour. Very tough and hard to stagger, but heavy.',
      add: { hp: 1400, weight: 40, staggerAt: 120, supply: 108 } },
    { id: 'reactor', name: 'REACTOR CORE', model: 'reactor', bulk: 1.05, desc: 'Oversized reactor: big power output, more boost fuel, faster EN recovery, quicker burst.',
      add: { hp: 1000, weight: 28, en: 25, enGround: 10, enAir: 4, supply: 132 }, mul: { burstGain: 1.2 } },
    { id: 'bay', name: 'MISSILE BAY CHEST', model: 'bay', bulk: 1.08, desc: 'Armoured chest with missile bays: an extra missile charge and harder-hitting missiles, for a little less armour.',
      add: { hp: 1000, weight: 29, missileCharges: 1, supply: 104 }, mul: { missileDamage: 1.1 } },
    { id: 'wedge', name: 'WEDGE FRAME', model: 'wedge', bulk: 0.96, desc: 'An angular, aerodynamic frame between the light and standard chassis: nimble, with a little more armour than the light frame.',
      add: { hp: 920, weight: 20, enGround: 4, supply: 96 }, mul: { mobility: 1.02 } },
    { id: 'ranger', name: 'RANGER FRAME', model: 'ranger', bulk: 1.0, desc: 'A long-range chassis with fuel tanks along the spine: more boost fuel and a steadier climb.',
      add: { hp: 980, weight: 22, en: 12, ascendSpeed: 3, supply: 104 } },
    { id: 'command', name: 'COMMAND CHEST', model: 'command', bulk: 1.02, desc: 'Command-grade chassis with a sensor mast: bigger radar, a faster burst gauge and extra armor repaired between waves.',
      add: { hp: 1050, weight: 27, radar: 100, resupplyHeal: 0.1, supply: 112 }, mul: { burstGain: 1.2 } },
  ],
  arms: [
    { id: 'std', name: 'STANDARD ARMS', model: 'std', desc: 'Balanced servos: a reliable all-round pair of arms.',
      add: { hp: 220, weight: 12, draw: 6 } },
    { id: 'assault', name: 'ASSAULT BRACERS', model: 'assault', desc: 'Armoured bracers. Extra armour and a stronger saber, but slower reloads.',
      add: { hp: 380, weight: 18, draw: 8 }, mul: { melee: 1.1, reload: 0.9 } },
    { id: 'precision', name: 'PRECISION ARMS', model: 'precision', desc: 'Fine servos: faster weapon cycling and quicker reloads.',
      add: { hp: 150, weight: 9, draw: 10 }, mul: { fireRate: 1.1, reload: 1.15 } },
    { id: 'blade', name: 'BLADE ARMS', model: 'blade', desc: 'Forearm blade fins. Heavy saber damage; the gun cycles a touch slower.',
      add: { hp: 240, weight: 13, draw: 9 }, mul: { melee: 1.3, fireRate: 0.95 } },
    { id: 'guard', name: 'GUARD ARMS', model: 'guard', desc: 'Broad vambraces: extra armour, steadier under fire and a little gunfire absorption.',
      add: { hp: 300, weight: 17, staggerAt: 30, draw: 7 }, guard: 0.04 },
    { id: 'recoil', name: 'HEAVY RECOIL ARMS', model: 'recoil', desc: 'Piston-braced forearms: your gun hits 12% harder but cycles a little slower.',
      add: { hp: 260, weight: 16, draw: 9 }, mul: { gunDamage: 1.12, fireRate: 0.94 } },
  ],
  legs: [
    { id: 'std', name: 'STANDARD LEGS', model: 'std', desc: 'Balanced locomotion. Load limit 115.',
      add: { hp: 420, weight: 22, draw: 8, load: 115 } },
    { id: 'sprint', name: 'SPRINT LEGS', model: 'sprint', desc: 'Light digitigrade legs. Fast on the ground, dashes cost less EN, but a low load limit.',
      add: { hp: 300, weight: 15, dashCost: -4, draw: 10, load: 100 }, mul: { mobility: 1.1 } },
    { id: 'tank', name: 'TANK LEGS', model: 'tank', desc: 'Armoured pillars: lots of armour, stagger resistance and the highest load limit, but slow.',
      add: { hp: 650, weight: 36, staggerAt: 100, draw: 6, load: 160 }, mul: { mobility: 0.92 } },
    { id: 'jump', name: 'JUMP LEGS', model: 'jump', desc: 'Calf boosters: stronger ascent and faster EN recovery in the air. Power hungry.',
      add: { hp: 340, weight: 20, ascendSpeed: 10, enAir: 14, draw: 14, load: 108 } },
    { id: 'strider', name: 'STRIDER LEGS', model: 'strider', desc: 'Long-striding legs: quicker on foot and a longer dash, with a middling load limit.',
      add: { hp: 360, weight: 19, ascendSpeed: 4, dashSpeed: 20, draw: 9, load: 112 }, mul: { mobility: 1.06 } },
    { id: 'siege', name: 'SIEGE LEGS', model: 'siege', desc: 'Braced stabiliser stance: very hard to stagger and steadier on the gun, but slow.',
      add: { hp: 520, weight: 32, staggerAt: 160, draw: 7, load: 140 }, mul: { mobility: 0.95, reload: 1.1, fireRate: 1.04 } },
  ],
  // Shoulder armor: the values are PER SIDE, so a matched pair gives the whole bonus and a mismatched pair half of each.
  shoulder: [
    { id: 'std', name: 'STANDARD PAULDRON', model: 'std', desc: 'A light shoulder plate.',
      add: { weight: 4, draw: 2 } },
    { id: 'bulwark', name: 'BULWARK SHELL', model: 'bulwark', desc: 'A layered armour shell: extra armour, a little gunfire absorption and stagger resistance.',
      add: { hp: 110, weight: 8, staggerAt: 20, draw: 4 }, guard: 0.02 },
    { id: 'spike', name: 'RAM SPIKE', model: 'spike', desc: 'A spiked pad for close work: a modest saber bonus and some extra armour.',
      add: { hp: 60, weight: 4.5, draw: 2 }, mul: { melee: 1.06 } },
    { id: 'vernier', name: 'VERNIER SHOULDER', model: 'vernier', desc: 'A thruster shoulder: sharper turning and faster, cheaper dashes. Power hungry.',
      add: { weight: 3.5, turn: 1.5, dashSpeed: 12.5, dashCost: -1, draw: 6 } },
    { id: 'rack', name: 'MISSILE RACK', model: 'rack', desc: 'A rack on the shoulder: harder-hitting missiles that track tighter. Power hungry.',
      add: { weight: 7, missileTurn: 0.5, draw: 8 }, mul: { missileDamage: 1.12 } },
    { id: 'aegis', name: 'AEGIS EMITTER', model: 'aegis', desc: 'A field emitter: absorbs 5% of incoming gunfire, missiles and shells. Power hungry.',
      add: { hp: 30, weight: 5, draw: 8 }, guard: 0.05 },
    { id: 'wing', name: 'FIN PAULDRON', model: 'wing', desc: 'A swept stabiliser fin: steadier turning and a quicker dash, little armour.',
      add: { hp: 20, weight: 3, turn: 1.0, dashSpeed: 8, draw: 3 } },
    { id: 'dome', name: 'DOME GUARD', model: 'dome', desc: 'A rounded blast shield: armour and stagger resistance without the weight of a bulwark shell.',
      add: { hp: 80, weight: 6, staggerAt: 12, draw: 3 } },
  ],
  // Weapon mounts: one on each shoulder, each its own ability. The first one you fit fires on F, the second on G.
  mount: [
    { id: 'none', name: 'NO MOUNT', model: 'none', desc: 'Nothing on this shoulder: no extra weight or power draw.',
      add: {} },
    { id: 'cannon', name: 'SHOULDER CANNON', model: 'cannon', desc: 'A heavy splash shell. Recharges in 7 seconds.',
      add: { weight: 12, draw: 16 },
      ability: { name: 'SHOULDER CANNON', kind: 'cannon', damage: 380, cooldown: 7, speed: 320, knock: 50, splash: { radius: 24, damage: 190 } } },
    { id: 'swarm', name: 'MICRO-MISSILE POD', model: 'swarm', desc: 'Six small homing missiles. Recharges in 9 seconds.',
      add: { weight: 13, draw: 18 },
      ability: { name: 'MICRO-MISSILES', kind: 'swarm', count: 6, damage: 70, cooldown: 9, splash: { radius: 12, damage: 30 } } },
    { id: 'rail', name: 'RAIL LANCE', model: 'rail', desc: 'A fast piercing slug that goes through everything in its line. Recharges in 8 seconds.',
      add: { weight: 11, draw: 20 },
      ability: { name: 'RAIL LANCE', kind: 'rail', damage: 300, cooldown: 8, speed: 1100, knock: 24 } },
  ],
  backpack: [
    { id: 'std', name: 'STANDARD PACK', model: 'std', desc: 'Basic thrusters and a saber rack.',
      add: { weight: 10, draw: 10 } },
    { id: 'booster', name: 'HEAVY BOOSTER', model: 'booster', desc: 'Big thruster pack: far more boost fuel and a faster climb.',
      add: { weight: 18, en: 45, ascendSpeed: 6, enGround: 6, draw: 26 } },
    { id: 'pod', name: 'MISSILE POD PACK', model: 'pod', desc: 'Twin racks: a third missile charge and harder-hitting missiles.',
      add: { weight: 16, missileCharges: 1, en: -10, draw: 20 }, mul: { missileDamage: 1.25 } },
    { id: 'wing', name: 'WING VERNIER', model: 'wing', desc: 'Vector wings: faster, cheaper dashes and sharper turning. Fragile.',
      add: { weight: 9, hp: -80, dashSpeed: 40, dashCost: -6, turn: 2, draw: 18 } },
    { id: 'gen', name: 'GENERATOR PACK', model: 'gen', desc: 'Auxiliary reactor: +28 power output, so hungry parts keep running at full speed.',
      add: { weight: 20, en: 10, supply: 28, draw: 4 } },
    { id: 'plate', name: 'ARMOR BACKPLATE', model: 'plate', desc: 'Slab plate over the thrusters: lots of armour and stagger resistance, but a weaker climb.',
      add: { hp: 260, weight: 22, staggerAt: 50, ascendSpeed: -6, draw: 4 } },
  ],
  core: [
    { id: 'std', name: 'STANDARD CORE', model: 'std', desc: 'A plain reactor governor.',
      add: { weight: 4, draw: 4 } },
    { id: 'capacitor', name: 'CAPACITOR BANK', model: 'capacitor', desc: 'Extra boost fuel and quicker EN recovery.',
      add: { weight: 8, en: 35, enGround: 8, draw: 10 } },
    { id: 'overclock', name: 'OVERCLOCK UNIT', model: 'overclock', desc: 'BURST lasts 18 seconds instead of 12, and the gauge fills a little faster.',
      add: { weight: 6, burstTime: 6, draw: 16 }, mul: { burstGain: 1.15 } },
    { id: 'regen', name: 'NANO-REPAIR CORE', model: 'regen', desc: 'Repairs 7 armor per second once you have gone 3 seconds without being hit.',
      add: { weight: 10, regen: 7, draw: 15 } },
    { id: 'phase', name: 'PHASE GOVERNOR', model: 'phase', desc: 'Dashes grant 0.45 s of invulnerability instead of 0.2 s.',
      add: { weight: 7, dashInvuln: 0.25, draw: 16 } },
    { id: 'siphon', name: 'BURST SIPHON', model: 'siphon', desc: 'Feeds the burst gauge: it fills 50% faster.',
      add: { weight: 6, draw: 14 }, mul: { burstGain: 1.5 } },
    { id: 'barrier', name: 'BARRIER GENERATOR', model: 'barrier', desc: 'Projects an energy barrier that soaks 240 damage before armor, then recharges after 5 seconds without a hit.',
      add: { weight: 9, draw: 20, barrier: 240 } },
  ],
  pilot: [
    { id: 'rookie', name: 'ROOKIE', model: 'none', desc: 'No special training: no bonuses, no habits.',
      add: {} },
    { id: 'gunner', name: 'GUNNER', model: 'none', desc: 'Drilled on the range: faster reloads and a slightly quicker trigger finger.',
      add: {}, mul: { reload: 1.25, fireRate: 1.05 } },
    { id: 'duelist', name: 'DUELIST', model: 'none', desc: 'Lives for close combat: stronger sabers and longer dash invulnerability.',
      add: { dashInvuln: 0.1 }, mul: { melee: 1.15 } },
    { id: 'engineer', name: 'ENGINEER', model: 'none', desc: 'Keeps the machine tuned: half your armor is repaired between waves, and power runs cooler.',
      add: { resupplyHeal: 0.25, enGround: 6, supply: 8 } },
    { id: 'evader', name: 'EVADER', model: 'none', desc: 'Born to dodge: cheaper dashes, sharper turning, a little faster on foot.',
      add: { dashCost: -3, turn: 3 }, mul: { mobility: 1.04 } },
    { id: 'veteran', name: 'VETERAN', model: 'none', desc: 'Iron nerves: much harder to stagger, and the burst gauge fills faster.',
      add: { staggerAt: 80 }, mul: { burstGain: 1.1 } },
    { id: 'marksman', name: 'MARKSMAN', model: 'none', desc: 'Deadeye: your gun hits 12% harder and the radar reaches a little farther.',
      add: { radar: 60 }, mul: { gunDamage: 1.12 } },
    { id: 'tactician', name: 'TACTICIAN', model: 'none', desc: 'Missile specialist: harder-hitting, tighter-homing missiles.',
      add: { missileTurn: 1.2 }, mul: { missileDamage: 1.2 } },
    { id: 'guardian', name: 'GUARDIAN', model: 'none', desc: 'Bodyguard: steadier on the feet, absorbs 5% of gunfire and gets extra armor back between waves.',
      add: { staggerAt: 40, resupplyHeal: 0.1 }, guard: 0.05 },
  ],
  skirt: [
    { id: 'std', name: 'STANDARD SKIRT', model: 'std', desc: 'The usual waist armour.', add: {} },
    { id: 'none', name: 'NO SKIRT', model: 'none', desc: 'Bare hips: lighter and quicker to recover boost fuel.',
      add: { weight: -3, enGround: 4 } },
    { id: 'long', name: 'LONG TAILS', model: 'long', desc: 'Long front and rear skirt plates: a little extra armour.',
      add: { hp: 60, weight: 4, draw: 1 } },
    { id: 'heavy', name: 'FORTRESS SKIRT', model: 'heavy', desc: 'Broad, layered skirt armour: lots of armour and stagger resistance, but heavy.',
      add: { hp: 160, weight: 10, staggerAt: 30, draw: 2 } },
    { id: 'flare', name: 'FLARE SKIRT', model: 'flare', desc: 'Wide stabiliser skirt: steadier turning and a quicker dash.',
      add: { weight: 3, dashSpeed: 12, turn: 1, draw: 4 } },
    { id: 'thruster', name: 'SKIRT THRUSTERS', model: 'thruster', desc: 'Thrusters in the skirt: a stronger climb and quicker air recovery. Power hungry.',
      add: { weight: 6, ascendSpeed: 4, enAir: 6, draw: 10 } },
  ],
  weapon: [
    { id: 'rifle', name: 'BEAM RIFLE', model: 'rifle', desc: 'Reliable all-rounder: accurate, 8-round magazine.',
      add: { weight: 6, draw: 14 },
      weapon: { name: 'BEAM RIFLE', kind: 'beam', damage: 210, cooldown: 0.34, mag: 8, reload: 1.9, speed: 780, spread: 0, knock: 6, shake: 0.07 } },
    { id: 'mg', name: 'RAPID BEAM GUN', model: 'mg', desc: 'Stream of light beams. Big magazine, low damage per hit, a little spread.',
      add: { weight: 8, draw: 16 },
      weapon: { name: 'RAPID BEAM GUN', kind: 'bullet', damage: 42, cooldown: 0.085, mag: 30, reload: 2.2, speed: 640, spread: 0.022, knock: 1.5, shake: 0.03 } },
    { id: 'bazooka', name: 'BLAST BAZOOKA', model: 'cannon', desc: 'Slow explosive shells with a wide blast. Three rounds.',
      add: { weight: 12, draw: 24 },
      weapon: { name: 'BLAST BAZOOKA', kind: 'cannon', damage: 520, cooldown: 1.05, mag: 3, reload: 2.2, speed: 300, spread: 0, knock: 40, shake: 0.35,
        splash: { radius: 26, damage: 260 } } },
    { id: 'sniper', name: 'BEAM SNIPER', model: 'sniper', desc: 'Long-barrel rifle: very fast, heavy shots. Four rounds.',
      add: { weight: 10, draw: 20 },
      weapon: { name: 'BEAM SNIPER', kind: 'beam', damage: 430, cooldown: 0.85, mag: 4, reload: 2.0, speed: 1300, spread: 0, knock: 14, radius: 1.5, shake: 0.15 } },
    { id: 'sabers', name: 'TWIN SABERS', model: 'saber', desc: 'No gun: both mouse buttons swing the saber combo. Big melee bonus, deflects 20% of gunfire, cheaper dashes.',
      add: { weight: 6, enGround: 8, dashCost: -4, draw: 10 }, mul: { melee: 1.4 }, guard: 0.2,
      weapon: { name: 'TWIN SABERS', kind: 'melee', damage: 0, cooldown: 0, mag: 0, reload: 0, speed: 0, spread: 0, knock: 0, shake: 0 } },
    { id: 'scatter', name: 'BEAM SHOTGUN', model: 'scatter', desc: 'Seven pellets per shot: brutal up close, thin at range. Six rounds.',
      add: { weight: 11, draw: 18 },
      weapon: { name: 'BEAM SHOTGUN', kind: 'beam', damage: 55, pellets: 7, cooldown: 0.75, mag: 6, reload: 2.0, speed: 700, spread: 0.07, life: 0.5, radius: 1.6, knock: 8, shake: 0.2 } },
    { id: 'seeker', name: 'SEEKER RIFLE', model: 'seeker', desc: 'Slower beams that curve onto your target (lock on, or aim near an enemy). Ten rounds.',
      add: { weight: 9, draw: 17 },
      weapon: { name: 'SEEKER RIFLE', kind: 'beam', damage: 165, cooldown: 0.3, mag: 10, reload: 2.1, speed: 520, spread: 0, homing: 3.2, knock: 5, shake: 0.06 } },
    { id: 'lance', name: 'ARC LANCE', model: 'lance', desc: 'A heavy beam that pierces every enemy in its line. Three rounds.',
      add: { weight: 13, draw: 22 },
      weapon: { name: 'ARC LANCE', kind: 'beam', damage: 460, cooldown: 0.9, mag: 3, reload: 2.2, speed: 1000, spread: 0, pierce: true, radius: 2.2, knock: 12, shake: 0.2 } },
    { id: 'greatsword', name: 'GREATSWORD', model: 'greatsword', desc: 'No gun: both mouse buttons swing a huge blade. The biggest melee bonus and longest reach, deflects 28% of gunfire, but heavy.',
      add: { weight: 12, draw: 8 }, mul: { melee: 1.55 }, guard: 0.28,
      weapon: { name: 'GREATSWORD', kind: 'melee', damage: 0, cooldown: 0, mag: 0, reload: 0, speed: 0, spread: 0, knock: 0, shake: 0, reach: 37 } },
  ],
  offhand: [
    { id: 'shield', name: 'BEAM SHIELD', model: 'shield', desc: 'Absorbs 22% of incoming gunfire, missiles and shells (not saber hits).',
      add: { weight: 10, draw: 4 }, guard: 0.22 },
    { id: 'none', name: 'NO OFF-HAND', model: 'none', desc: 'Lighter and quicker on its feet.',
      add: { weight: 0, enGround: 8 }, mul: { mobility: 1.03 } },
    { id: 'buckler', name: 'PARRY BUCKLER', model: 'buckler', desc: 'Small arm shield: absorbs 12% of gunfire and leaves the saber arm free (+5% melee).',
      add: { weight: 5, draw: 2 }, guard: 0.12, mul: { melee: 1.05 } },
    { id: 'tower', name: 'TOWER SHIELD', model: 'tower', desc: 'Full-length shield: absorbs 30% of gunfire, missiles and shells and resists stagger, but heavy and slow.',
      add: { weight: 20, staggerAt: 60, draw: 5 }, guard: 0.30, mul: { mobility: 0.96 } },
  ],
  sub: [
    { id: 'none', name: 'NO SUB-WEAPON', model: 'none', desc: 'Nothing mounted: no extra weight or power draw.',
      add: {} },
    { id: 'vulcan', name: 'HEAD VULCANS', model: 'vulcan', desc: 'Hold V: a stream of light rounds at your target. They shoot down incoming missiles. Overheats if held too long.',
      add: { weight: 3, draw: 10 },
      sub: { name: 'HEAD VULCANS', kind: 'vulcan', damage: 11, interval: 0.09, speed: 720, heatPerSecond: 0.3, coolPerSecond: 0.45, lockout: 0.5 } },
    { id: 'flare', name: 'DECOY FLARES', model: 'flare', desc: 'Press V: detonates every enemy missile homing on you. 12 second recharge.',
      add: { weight: 4, draw: 6 },
      sub: { name: 'DECOY FLARES', kind: 'flare', cooldown: 12 } },
    { id: 'repair', name: 'REPAIR KIT', model: 'repair', desc: 'Press V: repairs 15% of your armor over 4 seconds. One use per wave.',
      add: { weight: 6, draw: 10 },
      sub: { name: 'REPAIR KIT', kind: 'repair', charges: 1, heal: 0.15, duration: 4 } },
    { id: 'injector', name: 'EN INJECTOR', model: 'injector', desc: 'Press V: instantly refills boost fuel and clears an overheat. 16 second recharge.',
      add: { weight: 4, draw: 6 },
      sub: { name: 'EN INJECTOR', kind: 'injector', cooldown: 16 } },
    { id: 'pulse', name: 'SHOCK PULSE', model: 'pulse', desc: 'Press V: a shockwave that damages and staggers everything near you. 14 second recharge.',
      add: { weight: 6, draw: 12 },
      sub: { name: 'SHOCK PULSE', kind: 'pulse', cooldown: 14, radius: 60, damage: 240 } },
    { id: 'field', name: 'AEGIS FIELD', model: 'field', desc: 'Press V: 2.5 seconds of total invulnerability. 22 second recharge. Power hungry.',
      add: { weight: 7, draw: 18 },
      sub: { name: 'AEGIS FIELD', kind: 'field', cooldown: 22, duration: 2.5 } },
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
  head: 'vfin', crest: 'auto', torso: 'std', pilot: 'rookie', arms: 'std', legs: 'std',
  shoulderL: 'std', shoulderR: 'std', mountL: 'none', mountR: 'none',
  backpack: 'std', core: 'std', skirt: 'std', weapon: 'rifle', offhand: 'shield', sub: 'none',
  sym: true, // the garage keeps the left and right shoulders matched while this is on
  tuning: { plating: 0, servos: 0, thrusters: 0, weapons: 0 },
  paint: { main: '#eceff6', sub: '#2a56b8', accent: '#d23a32', trim: '#f5c518' },
  marks: 'none',
  energy: 'pink', thruster: 'blue',
});

export const partsFor = (slot) => PARTS[poolOf(slot)];
export const partOf = (slot, id) => partsFor(slot).find((p) => p.id === id) ?? partsFor(slot)[0];

/** `build` with `id` fitted in `slot` (and on the mirrored side too, unless `mirror` is false). Does not mutate. */
export function withPart(build, slot, id, mirror = true) {
  const out = { ...build, [slot]: id };
  if (mirror && MIRROR[slot]) out[MIRROR[slot]] = id;
  return out;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const hexToInt = (h) => parseInt(h.slice(1), 16);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function cleanName(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9 \-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14).trim(); // trim again: the cut can land on a space
  return s || DEFAULT_BUILD.name;
}

/** Whole points per dial, each 0..TUNING_MAX, at most TUNING_POOL in total (extras are taken off the largest dial). */
export function cleanTuning(src) {
  const t = {};
  for (const { id } of TUNING) {
    const v = Number(src?.[id]);
    t[id] = Number.isFinite(v) ? clamp(Math.round(v), 0, TUNING_MAX) : 0;
  }
  const total = () => TUNING.reduce((n, { id }) => n + t[id], 0);
  while (total() > TUNING_POOL) {
    let big = TUNING[0].id;
    for (const { id } of TUNING) if (t[id] >= t[big]) big = id; // ties: the later dial gives way first
    t[big]--;
  }
  return t;
}

export const tuningSpent = (t) => TUNING.reduce((n, { id }) => n + (t?.[id] ?? 0), 0);

/** Turn anything (e.g. parsed localStorage JSON) into a valid build, filling gaps from the default. */
export function sanitizeBuild(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULT_BUILD, paint: { ...DEFAULT_BUILD.paint }, tuning: { ...DEFAULT_BUILD.tuning } };
  out.name = cleanName(src.name);
  const valid = (slot, id) => typeof id === 'string' && partsFor(slot).some((p) => p.id === id);
  for (const slot of SLOTS) if (valid(slot, src[slot])) out[slot] = src[slot];
  // saves from before the shoulders were split, and the shoulder cannon / micro-missile arm moved from the off-hand to the mounts
  if (valid('shoulderL', src.shoulder)) {
    if (!valid('shoulderL', src.shoulderL)) out.shoulderL = src.shoulder;
    if (!valid('shoulderR', src.shoulderR)) out.shoulderR = src.shoulder;
  }
  if ((src.offhand === 'cannon' || src.offhand === 'swarm') && !valid('offhand', src.offhand)) {
    out.offhand = 'none';
    if (!valid('mountL', src.mountL)) out.mountL = src.offhand;
  }
  if (typeof src.sym === 'boolean') out.sym = src.sym;
  if (MARKS.some((m) => m.id === src.marks)) out.marks = src.marks;
  out.tuning = cleanTuning(src.tuning);
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
  for (const slot of SLOTS) b[slot] = pick(partsFor(slot)).id;
  if (rand() < 0.7) { b.shoulderR = b.shoulderL; b.mountR = b.mountL; } // usually matched, sometimes not
  b.sym = b.shoulderL === b.shoulderR && b.mountL === b.mountR;
  b.marks = pick(MARKS).id;
  const paint = pick(PAINTS);
  b.paint = { main: paint.main, sub: paint.sub, accent: paint.accent, trim: paint.trim };
  b.energy = pick(Object.keys(ENERGY));
  b.thruster = pick(Object.keys(THRUSTERS));
  const t = { plating: 0, servos: 0, thrusters: 0, weapons: 0 };
  for (let i = 0; i < TUNING_POOL; i++) {
    const id = pick(TUNING).id;
    if (t[id] < TUNING_MAX) t[id]++;
  }
  b.tuning = t;
  return b;
}

// ------------------------------------------------------------------ derivation

/** Sustained damage per second over a full magazine-and-reload cycle (melee-only builds use the saber combo). */
function sustainedDps(w, melee, damage) {
  if (w.kind === 'melee') return Math.round(340 * melee * damage); // a combo's raw 600 dps, discounted for the need to stay in reach
  const cycle = w.mag * w.cooldown + w.reload;
  const splashBonus = w.splash ? w.splash.damage * 0.3 : 0;
  const pellets = w.pellets ? w.pellets * PELLET_COVERAGE : 1;
  return Math.round(((w.damage * pellets + splashBonus) * damage * w.mag) / cycle);
}

/** Above `cap`, each extra point of a stacking multiplier counts half. */
const softCap = (v, cap) => (v <= cap ? v : cap + (v - cap) * 0.5);

/** Fold a build into numbers. Pure and cheap, so the garage calls it for every hover preview. */
export function deriveStats(build) {
  const b = sanitizeBuild(build);
  const parts = SLOTS.map((slot) => partOf(slot, b[slot]));
  const s = { ...BASE };
  const mul = { mobility: 1, dash: 1, melee: 1, fireRate: 1, reload: 1, gunDamage: 1, missileDamage: 1, burstGain: 1 };
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.add ?? {})) s[k] = (s[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.mul ?? {})) mul[k] *= v;
  }

  // tuning points: small flat bonuses
  const t = b.tuning;
  s.hp *= 1 + 0.04 * t.plating;
  mul.mobility *= 1 + 0.02 * t.servos;
  mul.dash *= 1 + 0.02 * t.servos;
  s.turn *= 1 + 0.03 * t.servos;
  s.en *= 1 + 0.04 * t.thrusters;
  s.ascendSpeed += 1.5 * t.thrusters;
  const damage = 1 + 0.03 * t.weapons;

  // budgets
  const wf = clamp(1 + (REF_WEIGHT - s.weight) * WEIGHT_SLOPE, 0.82, 1.15);
  const over = Math.max(0, s.weight - s.load);
  const loadFactor = clamp(1 - OVERLOAD_SLOPE * over, OVERLOAD_FLOOR, 1);
  const powerFactor = s.draw <= s.supply ? 1 : clamp(Math.pow(s.supply / s.draw, POWER_CURVE), POWER_FLOOR, 1);
  const move = wf * loadFactor;

  const weaponPart = partOf('weapon', b.weapon);
  const w = { ...weaponPart.weapon };
  w.cooldown = w.cooldown / mul.fireRate / powerFactor;
  w.reload = w.reload / mul.reload / powerFactor;
  if (w.kind !== 'melee') w.damage *= softCap(mul.gunDamage, GUN_SOFT_CAP);

  const subPart = partOf('sub', b.sub);
  // weapon mounts: the first one fitted fires on F, the second on G
  const abilities = ['mountL', 'mountR']
    .map((slot, i) => ({ part: partOf(slot, b[slot]), side: i === 0 ? 'L' : 'R' }))
    .filter(({ part }) => part.ability)
    .map(({ part, side }) => ({ ...part.ability, side }));
  const stats = {
    hp: Math.round(s.hp),
    weight: s.weight,
    load: s.load,
    overload: over,
    loadFactor,
    weightFactor: wf,
    supply: s.supply,
    draw: s.draw,
    powerFactor,
    en: Math.round(s.en),
    enGround: s.enGround * powerFactor,
    enAir: s.enAir * powerFactor,
    speed: s.speed * mul.mobility * move,
    airSpeed: s.airSpeed * mul.mobility * move,
    ascendSpeed: s.ascendSpeed,
    ascendCost: s.ascendCost,
    dashSpeed: s.dashSpeed * mul.dash * move,
    dashTime: s.dashTime,
    dashCost: Math.max(10, s.dashCost),
    dashInvuln: s.dashInvuln,
    turn: s.turn * move,
    staggerAt: s.staggerAt,
    // every part that absorbs fire (shields, saber deflection, shells, emitters, some arms and pilots) stacks, capped
    guard: Math.min(GUARD_CAP, parts.reduce((n, part) => n + (part.guard ?? 0), 0)),
    melee: softCap(mul.melee, MELEE_SOFT_CAP),
    damage,
    burstGain: Math.min(BURST_GAIN_CAP, mul.burstGain),
    burstTime: s.burstTime,
    regen: s.regen,
    jam: Math.min(0.8, s.jam),
    barrier: s.barrier,
    reach: w.reach ?? 30,
    radar: s.radar,
    resupplyHeal: Math.min(0.9, s.resupplyHeal),
    missileCharges: clamp(s.missileCharges, 1, MAX_MISSILE_CHARGES),
    missileDamage: mul.missileDamage,
    missileTurn: s.missileTurn,
    weapon: w,
    abilities,
    ability: abilities[0] ?? null, // the F ability (kept for the single-ability code paths and the tests)
    sub: subPart.sub ? { ...subPart.sub } : null,
    tuning: { ...t },
  };
  stats.dps = sustainedDps(w, stats.melee, damage);
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
    head: m('head'), crest: m('crest'), torso: m('torso'), arms: m('arms'), legs: m('legs'),
    shoulderL: m('shoulderL'), shoulderR: m('shoulderR'), mountL: m('mountL'), mountR: m('mountR'),
    backpack: m('backpack'), core: m('core'), skirt: m('skirt'), weapon: m('weapon'), offhand: m('offhand'), sub: m('sub'),
    marks: b.marks,
    bulk: partOf('torso', b.torso).bulk,
    palette: paletteOf(b),
  };
  const def = {
    name: b.name,
    spec,
    hp: stats.hp, en: stats.en,
    speed: stats.speed, airSpeed: stats.airSpeed, ascendSpeed: stats.ascendSpeed, ascendCost: stats.ascendCost,
    dashSpeed: stats.dashSpeed, dashTime: stats.dashTime, dashCost: stats.dashCost,
    enGround: stats.enGround, enAir: stats.enAir, dashInvuln: stats.dashInvuln, turn: stats.turn,
    staggerAt: stats.staggerAt, guard: stats.guard, jam: stats.jam, barrier: stats.barrier, score: 0,
  };
  return { build: b, stats, spec, def, energy: ENERGY[b.energy] };
}

// ------------------------------------------------------------------ stat ranges (for the garage's bars)

let ranges = null;

const RANGE_KEYS = {
  hp: (s) => s.hp,
  speed: (s) => s.speed,
  en: (s) => s.en,
  dps: (s) => s.dps,
  melee: (s) => s.melee * s.damage,
  missiles: (s) => s.missileCharges * s.missileDamage * s.damage,
  weight: (s) => s.weight,
  load: (s) => s.load,
  draw: (s) => s.draw,
  supply: (s) => s.supply,
};

/**
 * Min and max of each displayed stat, computed once. There are millions of builds, so rather than
 * enumerate them this climbs from the default one slot at a time toward each extreme (a few passes
 * are enough because slots are almost independent), then widens by the best tuning bonus.
 */
export function statRanges() {
  if (ranges) return ranges;
  const r = {};
  for (const [key, get] of Object.entries(RANGE_KEYS)) {
    r[key] = {};
    for (const [dir, label] of [[1, 'max'], [-1, 'min']]) {
      const b = sanitizeBuild({});
      let best = get(deriveStats(b)) * dir;
      for (let pass = 0; pass < 3; pass++) {
        for (const slot of SLOTS) {
          for (const p of partsFor(slot)) {
            const v = get(deriveStats({ ...b, [slot]: p.id })) * dir;
            if (v > best + 1e-9) { best = v; b[slot] = p.id; }
          }
        }
      }
      r[key][label] = best * dir;
    }
  }
  // the best case for tuning is 6 points in the relevant dial
  r.hp.max *= 1 + 0.04 * TUNING_MAX;
  r.speed.max *= 1 + 0.02 * TUNING_MAX;
  r.en.max *= 1 + 0.04 * TUNING_MAX;
  r.dps.max *= 1 + 0.03 * TUNING_MAX;
  r.melee.max *= 1 + 0.03 * TUNING_MAX;
  r.missiles.max *= 1 + 0.03 * TUNING_MAX;
  ranges = r;
  return r;
}
