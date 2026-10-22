// Machines that are not the player's: the practice dummy of the test range and two enemies built from the same rig
// the garage uses (a spider with a battery of arm guns, and a three-headed missile platform). Because they are real
// builds their parts have health of their own: shoot an arm off a crawler and that gun stops firing.

import { DEFAULT_BUILD, deriveMech } from './parts.js';
import { MECHS } from './data.js';

const DUMMY_PALETTE = { main: 0xf0f0ee, sub: 0xff7a1a, accent: 0xff7a1a, trim: 0xffffff, dark: 0x30343c, glow: 0x44ff9a, blade: 0xff7a30, flame: 0xffa050 };

/** The practice dummy: stands where it is, soaks a lot, mends itself when left alone (see Dummy in ai.js). */
export const DUMMY_DEF = {
  ...MECHS.drone,
  name: 'TARGET DUMMY',
  spec: { ...MECHS.drone.spec, weapon: 'none', shoulderL: 'std', shoulderR: 'std', skirt: 'none', palette: DUMMY_PALETTE },
  hp: 5000, staggerAt: 420, score: 0,
};

const stock = (patch) => ({ ...DEFAULT_BUILD, ...patch });

/** The builds. Kept as data so they can be inspected (and so the tests can check they are valid machines). */
export const RIGGED_BUILDS = {
  // a six-legged gun platform: two pairs of arm guns and a tail turret; fast on its feet, fragile in the limbs
  crawler: stock({
    name: 'SP-18 CRAWLER', head: 'recon', crest: 'none', torso: 'heavy', arms: 'assault', legs: 'std', layout: 'hexa',
    shoulderL: 'dome', shoulderR: 'dome', backpack: 'std', skirt: 'none', weapon: 'mg', offhand: 'none',
    armLowerL: 'gun', armLowerR: 'gun', armMidL: 'gun', armMidR: 'gun', tail: 'turret',
    paint: { main: '#3a4a52', sub: '#222a30', accent: '#ff8a1c', trim: '#d9d9d2' },
    zones: { rig: { main: '#ff8a1c', sub: '#222a30', accent: '#ff8a1c', trim: '#d9d9d2' } },
    energy: 'orange', thruster: 'orange',
    prop: { size: 1, legs: 1.1, arms: 1, torso: 1, head: 1 },
  }),
  // a three-headed missile carrier: slow, hard to flank, shoots down incoming missiles with the chest vulcan
  hydra: stock({
    name: 'HD-40 HYDRA', head: 'recon', crest: 'none', torso: 'command', arms: 'guard', legs: 'tank', layout: 'quad',
    shoulderL: 'rack', shoulderR: 'rack', backpack: 'pod', skirt: 'heavy', weapon: 'rifle', offhand: 'none',
    headL: 'recon', headR: 'recon', podL: 'missile', podR: 'missile', chestMod: 'vulcan', tail: 'stabilizer',
    paint: { main: '#4b3a66', sub: '#262033', accent: '#5dffa5', trim: '#d7d0e6' },
    zones: { head: { main: '#5dffa5', sub: '#262033', accent: '#5dffa5', trim: '#d7d0e6' } },
    energy: 'green', thruster: 'green',
    prop: { size: 1.1, legs: 1, arms: 1, torso: 1.1, head: 1 },
  }),
};

/** What each build is worth, and how its own numbers are scaled to be a fair opponent rather than a player machine. */
const TUNE = {
  crawler: { name: 'SP-18 CRAWLER', hp: 1500, staggerAt: 260, speed: 0.78, score: 350, partHp: 1.3 },
  hydra: { name: 'HD-40 HYDRA', hp: 2600, staggerAt: 480, speed: 0.7, score: 500, partHp: 1.5 },
};

const cache = {};

/** `{ def, stats, build }` for a rigged enemy type ('crawler' | 'hydra'), worked out once. */
export function riggedOf(type) {
  if (!cache[type]) {
    const tune = TUNE[type];
    const d = deriveMech(RIGGED_BUILDS[type]);
    cache[type] = {
      build: d.build, stats: d.stats,
      def: {
        ...d.def, name: tune.name, hp: tune.hp, staggerAt: tune.staggerAt, speed: d.def.speed * tune.speed, score: tune.score,
        parts: d.def.parts.map((p) => ({ ...p, hp: Math.round(p.hp * tune.partHp) })),
      },
    };
  }
  return cache[type];
}

/** The enemy types made here (the rest are in data.js). */
export const RIGGED_TYPES = ['crawler', 'hydra'];
