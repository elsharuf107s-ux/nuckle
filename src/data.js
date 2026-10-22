// Static game data: palettes, mech definitions and the mission's waves.
// All designs here are original; they borrow the visual language of the real-robot genre
// (V-fin hero, mono-eye grunts, horned ace) without copying any existing machine.

export const PALETTE = {
  vanguard: { main: 0xeceff6, sub: 0x2a56b8, accent: 0xd23a32, trim: 0xf5c518, dark: 0x3a3f4d, glow: 0x44ff9a, blade: 0xff5fd2, flame: 0x6fd0ff },
  drone:    { main: 0x56804a, sub: 0x3b5c37, accent: 0x2b2d35, trim: 0xc9a227, dark: 0x22242a, glow: 0xff2a78, blade: 0xff7a30, flame: 0xffa050 },
  striker:  { main: 0x6b44a3, sub: 0x2b2438, accent: 0x9d2fc0, trim: 0xe9e9f2, dark: 0x1d1a29, glow: 0xffee33, blade: 0xb26bff, flame: 0xc388ff },
  bulwark:  { main: 0x707682, sub: 0x4b515d, accent: 0xd9791f, trim: 0xf5c518, dark: 0x262a33, glow: 0xff4f2d, blade: 0xffa040, flame: 0xffa848 },
  baron:    { main: 0xb4232a, sub: 0x1c1c24, accent: 0xd9ab2b, trim: 0xd9ab2b, dark: 0x14141a, glow: 0xff3ad8, blade: 0xff3030, flame: 0xff6a4a },
};

/**
 * Mech definitions.
 *  speed/airSpeed: top horizontal speed on the ground / in the air (units per second; a mech is ~18 tall)
 *  ascend*: vertical boost; dash*: quick-boost burst; turn: yaw smoothing rate
 *  staggerAt: a single hit this large interrupts the mech
 */
export const MECHS = {
  vanguard: {
    name: 'VG-01 VANGUARD',
    spec: { scale: 1, head: 'v', weapon: 'rifle', offhand: 'shield', palette: PALETTE.vanguard },
    hp: 2600, en: 100,
    speed: 40, airSpeed: 56, ascendSpeed: 58, ascendCost: 24, dashSpeed: 230, dashTime: 0.26, dashCost: 22,
    enGround: 42, enAir: 16, dashInvuln: 0.2, turn: 12, staggerAt: 220, score: 0,
  },
  drone: {
    name: 'DR-12 DRONE',
    spec: { scale: 0.95, head: 'mono', torso: 'grunt', legs: 'std', arms: 'std', weapon: 'mg', offhand: 'none', shoulderL: 'dome', shoulderR: 'dome', skirt: 'long', palette: PALETTE.drone },
    hp: 520, en: 100,
    speed: 30, airSpeed: 42, ascendSpeed: 45, ascendCost: 30, dashSpeed: 150, dashTime: 0.22, dashCost: 40,
    enGround: 22, enAir: 8, dashInvuln: 0, turn: 6, staggerAt: 150, score: 100,
  },
  striker: {
    name: 'ST-21 STRIKER',
    spec: { scale: 1.0, head: 'ace', crest: 'blade', torso: 'wedge', legs: 'sprint', arms: 'blade', weapon: 'mg', offhand: 'none', shoulderL: 'spike', shoulderR: 'spike', backpack: 'wing', skirt: 'flare', palette: PALETTE.striker },
    hp: 950, en: 100,
    speed: 46, airSpeed: 62, ascendSpeed: 52, ascendCost: 26, dashSpeed: 260, dashTime: 0.24, dashCost: 30,
    enGround: 30, enAir: 12, dashInvuln: 0, turn: 10, staggerAt: 220, score: 250,
  },
  bulwark: {
    name: 'HV-30 BULWARK',
    spec: { scale: 1.3, head: 'knight', torso: 'heavy', legs: 'tank', arms: 'assault', weapon: 'cannon', offhand: 'none', shoulderL: 'bulwark', shoulderR: 'bulwark', mountL: 'cannon', mountR: 'cannon', backpack: 'heavy', skirt: 'heavy', bulk: 1.25, palette: PALETTE.bulwark },
    hp: 1900, en: 100,
    speed: 20, airSpeed: 26, ascendSpeed: 36, ascendCost: 40, dashSpeed: 100, dashTime: 0.3, dashCost: 50,
    enGround: 15, enAir: 6, dashInvuln: 0, turn: 3.5, staggerAt: 450, score: 300,
  },
  baron: {
    name: 'CR-00 CRIMSON BARON',
    spec: { scale: 1.2, head: 'horn', torso: 'command', legs: 'strider', arms: 'blade', weapon: 'rifle', offhand: 'none', shoulderL: 'spike', shoulderR: 'spike', mountL: 'rail', mountR: 'swarm', backpack: 'booster', skirt: 'flare', bulk: 1.1, palette: PALETTE.baron },
    hp: 7000, en: 100,
    speed: 52, airSpeed: 72, ascendSpeed: 62, ascendCost: 18, dashSpeed: 300, dashTime: 0.24, dashCost: 24,
    enGround: 55, enAir: 25, dashInvuln: 0.15, turn: 11, staggerAt: Infinity, score: 3000, boss: true,
  },
};

/** The sortie: each wave lists [mech type, count]. (The crawler and the hydra are built from the garage's rig: see rigged.js.) */
export const WAVES = [
  { title: 'FIRST CONTACT', spawn: [['drone', 3]] },
  { title: 'PINCER', spawn: [['drone', 4], ['striker', 1]] },
  { title: 'HEAVY SUPPORT', spawn: [['drone', 3], ['bulwark', 2], ['crawler', 1]] },
  { title: 'BLADE DANCE', spawn: [['striker', 3], ['drone', 2], ['bulwark', 2], ['hydra', 1]] },
  { title: 'THE CRIMSON BARON', spawn: [['baron', 1], ['drone', 2]], boss: true },
];
