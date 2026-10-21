// The frame of the mech: pelvis with its skirt and core module, legs, torso and arms. Each builder fills
// in part of the `rig` (the shared record of nodes) and adds meshes through the kit.

import { HIP_Y, LEG, NECK_Y, PIVOT, SHIN, SHOULDER_X, SHOULDER_Y, THIGH, TORSO_Y } from './skeleton.js';

const PI = Math.PI;

// ------------------------------------------------------------------ pelvis, skirt and core

export function buildPelvis(rig) {
  const { k, hips, spec } = rig;
  const { add, M, box, cyl, sph, glow, cyanGlow, greenGlow, energyGlow } = k;

  add(hips, box(3.4, 1.5, 2.6), M.dark, 0, 0, 0, { edge: true });
  add(hips, cyl(1.9, 1.9, 0.3, 14), M.metal, 0, 0.7, 0);

  // ---- skirt: the front plates, the side skirts and the rear plate
  const skirt = spec.skirt ?? 'std';
  const front = (w, h, y, rx = 0.12) => {
    add(hips, box(w, h, 0.5), M.accent, 0, y, -1.55, { rx, edge: true });
    for (const s of [-1, 1]) add(hips, box(w * 0.42, h * 0.9, 0.45), M.main, s * (w * 0.7), y + 0.1, -1.45, { rx, rz: s * -0.1, edge: true });
  };
  if (skirt === 'std') {
    front(1.8, 2.3, -1.35);
    for (const s of [-1, 1]) add(hips, box(0.7, 2.2, 2.4), M.accent, s * 2.2, -1.1, 0, { rz: s * 0.1, edge: true });
    add(hips, box(2.6, 1.9, 0.5), M.sub, 0, -1.0, 1.55, { rx: -0.1, edge: true });
  } else if (skirt === 'long') {
    front(1.9, 3.4, -1.9, 0.08);
    for (const s of [-1, 1]) add(hips, box(0.6, 2.4, 2.2), M.accent, s * 2.2, -1.2, 0, { rz: s * 0.08, edge: true });
    add(hips, box(2.8, 3.2, 0.5), M.sub, 0, -1.6, 1.55, { rx: -0.06, edge: true });
    add(hips, box(0.5, 2.6, 0.4), M.trim, 0, -1.5, 1.85);
  } else if (skirt === 'heavy') {
    front(2.4, 2.8, -1.6);
    for (const s of [-1, 1]) {
      add(hips, box(1.1, 2.8, 2.9), M.accent, s * 2.4, -1.4, 0, { rz: s * 0.1, edge: true });
      add(hips, box(1.2, 0.5, 3.0), M.trim, s * 2.4, 0.05, 0);
    }
    add(hips, box(3.4, 2.4, 0.6), M.sub, 0, -1.3, 1.6, { rx: -0.1, edge: true });
  } else if (skirt === 'flare') {
    front(1.8, 2.0, -1.25, 0.2);
    for (const s of [-1, 1]) {
      add(hips, box(0.5, 2.6, 2.8), M.accent, s * 2.6, -1.1, 0, { rz: s * 0.55, edge: true });
      add(hips, box(0.4, 1.4, 1.2), M.trim, s * 3.4, -2.2, 0.8, { rz: s * 0.55 });
    }
    add(hips, box(2.6, 1.6, 0.5), M.sub, 0, -0.9, 1.55, { rx: -0.2, edge: true });
  } else if (skirt === 'thruster') {
    front(1.8, 2.0, -1.25);
    for (const s of [-1, 1]) {
      add(hips, box(0.7, 2.0, 2.2), M.accent, s * 2.2, -1.0, 0, { rz: s * 0.1, edge: true });
      add(hips, cyl(0.7, 0.55, 1.2, 10), M.metal, s * 1.3, -0.4, 2.1, { rx: PI / 2 + 0.2 });
      add(hips, cyl(0.45, 0.45, 0.2, 10), cyanGlow, s * 1.3, -0.15, 2.7, { rx: PI / 2 + 0.2, shadow: false });
    }
    add(hips, box(2.0, 1.6, 0.5), M.sub, 0, -1.0, 1.55, { rx: -0.1, edge: true });
  } else if (skirt === 'none') {
    add(hips, box(1.6, 0.8, 0.5), M.accent, 0, -0.8, -1.45, { rx: 0.1, edge: true });
  }

  // ---- core module: small, but visible at the waist and rear skirt
  const core = spec.core ?? 'std';
  if (core === 'std') {
    add(hips, box(0.9, 0.4, 0.3), M.trim, 0, 0.1, -1.35);
  } else if (core === 'capacitor') {
    for (const s of [-1, 1]) {
      add(hips, cyl(0.7, 0.7, 2.6, 10), M.accent, s * 2.0, -0.1, 2.0, { edge: true });
      add(hips, cyl(0.76, 0.76, 0.4, 10), M.trim, s * 2.0, 0.75, 2.0);
    }
  } else if (core === 'overclock') {
    add(hips, cyl(2.5, 2.5, 0.3, 20), glow, 0, 0.9, 0, { shadow: false });
    for (const s of [-1, 1]) add(hips, box(0.7, 0.5, 0.7), M.trim, s * 2.5, 0.9, 0, { edge: true });
  } else if (core === 'regen') {
    add(hips, box(1.9, 0.55, 0.3), greenGlow, 0, -0.9, 1.98, { shadow: false });
    add(hips, box(0.55, 1.9, 0.3), greenGlow, 0, -0.9, 1.98, { shadow: false });
  } else if (core === 'phase') {
    for (const s of [-1, 1]) {
      add(hips, box(0.3, 1.8, 1.3), M.accent, s * 1.7, -0.6, 2.1, { rz: s * 0.25, edge: true });
      add(hips, box(0.12, 1.5, 0.5), glow, s * 1.92, -0.6, 2.55, { rz: s * 0.25, shadow: false });
    }
  } else if (core === 'siphon') {
    for (const y of [-0.1, 0.7]) add(hips, cyl(2.55, 2.55, 0.2, 20), energyGlow, 0, y, 0, { shadow: false });
    for (const s of [-1, 1]) add(hips, box(0.5, 1.5, 0.5), M.trim, s * 2.55, 0.3, 0, { edge: true });
  } else if (core === 'barrier') {
    add(hips, cyl(1.0, 1.2, 0.5, 12), M.metal, 0, -0.5, 2.05, { rx: PI / 2 });
    add(hips, sph(0.95, 14, 10), cyanGlow, 0, -0.5, 2.5, { shadow: false });
    for (const s of [-1, 1]) add(hips, box(0.22, 1.5, 0.22), M.metal, s * 1.15, -0.5, 2.1);
  }
}

// ------------------------------------------------------------------ legs

export function buildLegs(rig) {
  const { k, hips, spec, makeFlame } = rig;
  const { add, group, M, box, cyl, sph, cone } = k;
  const style = spec.legs && LEG[spec.legs] ? spec.legs : 'std';
  const L = LEG[style];
  rig.L = L;
  rig.legStyle = style;
  rig.legs = [];

  for (const s of [-1, 1]) {
    const leg = group(hips, s * L.x, -PIVOT, 0);
    add(leg, sph(1.0), M.dark);
    add(leg, box(...L.thigh), M.main, 0, -2.3, 0, { edge: true });
    add(leg, box(L.thigh[0] - 0.3, 1.3, 0.5), M.sub, 0, -3.5, -(L.thigh[2] / 2 + 0.15), { edge: true });
    add(leg, box(0.3, 2.4, L.thigh[2] - 0.5), M.dark, s * (L.thigh[0] / 2 + 0.05), -2.0, 0);
    const shin = group(leg, 0, -THIGH, 0);
    add(shin, cyl(1.0, 1.0, L.thigh[0] - 0.1), M.dark, 0, 0, 0, { rz: PI / 2 });
    add(shin, box(...L.shin), M.main, 0, -2.7, 0.2, { edge: true });
    add(shin, box(L.shin[0] - 0.5, 3.0, 1.2), M.sub, 0, -2.5, L.shin[2] / 2 + 0.5, { edge: true });
    add(shin, box(L.shin[0] - 0.6, 3.4, 0.4), M.accent, 0, -2.8, -(L.shin[2] / 2) - 0.05, { edge: true });
    for (const o of [-1, 1]) add(shin, box(0.7, 0.4, 0.3), M.trim, o * 0.5, -0.6, -(L.shin[2] / 2) - 0.1, { rz: -o * 0.55 }); // V-shaped knee mark
    add(shin, box(1.5, 0.8, 1.7), M.dark, 0, -4.9, 0);
    const foot = group(shin, 0, -SHIN, 0);
    add(foot, box(...L.foot), M.sub, 0, -0.1, -0.8, { edge: true });
    add(foot, box(L.foot[0] - 0.4, 0.7, 1.2), M.main, 0, 0, -3.1, { edge: true });
    add(foot, box(L.foot[0] - 0.8, 0.8, 0.9), M.main, 0, 0, 1.5);

    if (style === 'sprint') {
      add(foot, box(0.4, 1.4, 1.8), M.trim, 0, 0.2, 2.4, { rx: 0.45 });
      add(shin, box(0.3, 3.4, 0.5), M.trim, 0, -2.7, -(L.shin[2] / 2 + 0.1));
    } else if (style === 'tank') {
      add(leg, box(L.thigh[0] + 0.2, 1.8, 1.1), M.accent, 0, -4.0, -(L.thigh[2] / 2 + 0.2), { edge: true });
      add(shin, box(L.shin[0] + 0.4, 0.8, L.shin[2] + 0.4), M.dark, 0, -4.3, 0.2);
      add(foot, box(L.foot[0], 0.5, 1.6), M.accent, 0, 0.45, -2.8, { edge: true });
    } else if (style === 'jump') {
      add(shin, cyl(1.1, 1.3, 3.8, 10), M.metal, 0, -2.4, 3.1);
      add(shin, cyl(1.15, 1.15, 0.4, 10), M.accent, 0, -0.9, 3.1);
    } else if (style === 'strider') {
      add(shin, box(0.3, 3.6, 0.5), M.trim, 0, -2.6, -(L.shin[2] / 2 + 0.1));
      add(foot, box(0.5, 0.5, 2.6), M.trim, 0, -0.1, -3.7, { edge: true });
      add(leg, box(L.thigh[0] + 0.1, 0.6, L.thigh[2] + 0.1), M.accent, 0, -0.9, 0, { edge: true });
    } else if (style === 'siege') {
      add(leg, box(L.thigh[0] + 0.3, 2.0, 1.2), M.accent, 0, -4.0, -(L.thigh[2] / 2 + 0.25), { edge: true });
      add(shin, cone(0.55, 2.4, 6), M.trim, s * (L.shin[0] / 2 + 0.7), -3.9, 0.4, { rz: -s * 1.2 });
      add(foot, box(L.foot[0] + 0.4, 0.5, 1.4), M.trim, 0, 0.5, -3.3, { edge: true });
    }

    // calf thruster (points down and back); jump legs carry a much bigger one. Created first so it is flame 0 / 1.
    if (style === 'jump') makeFlame(shin, 0, -4.2, 3.1, PI - 0.2, 0.95, 4.8);
    else makeFlame(shin, 0, -3.7, 2.5, PI - 0.35, 0.55, 3.6);
    rig.legs.push({ leg, shin, foot, side: s });
  }
}

// ------------------------------------------------------------------ torso

export function buildTorso(rig) {
  const { k, hips, spec, bulk } = rig;
  const { add, group, M, box, cyl, wedge, glow, cone } = k;
  const style = spec.torso ?? 'std';
  const slim = style === 'light' || style === 'wedge' || style === 'grunt';
  const depth = slim ? 3.0 : 3.4;
  const zf = -(depth / 2 + 0.1);
  const torso = group(hips, 0, TORSO_Y, 0);
  rig.torso = torso;
  rig.zf = zf;
  rig.depth = depth;

  add(torso, cyl(1.5, 1.7, 0.9), M.dark, 0, 0.2, 0);
  add(torso, box(3.0 * bulk, 1.5, depth - 0.4), M.dark, 0, 1.0, 0, { edge: true });
  // lower chest (the darker block with the cockpit hatch) and the upper chest above it
  add(torso, box(4.2 * bulk, 2.0, depth), M.sub, 0, 2.3, 0, { edge: true });
  add(torso, box(4.7 * bulk, 1.1, depth + 0.1), M.main, 0, 3.8, 0, { edge: true });
  add(torso, box(1.5, 1.3, 0.3), M.accent, 0, 1.9, zf, { edge: true });
  // intake vents: a pair of yellow blocks with dark slats
  for (const s of [-1, 1]) {
    add(torso, box(1.3, 0.9, 0.3), M.trim, s * 1.45 * bulk, 2.7, zf, { edge: true });
    for (let i = 0; i < 3; i++) add(torso, box(1.0, 0.1, 0.12), M.dark, s * 1.45 * bulk, 2.45 + i * 0.25, zf - 0.17);
  }
  add(torso, box(3.2 * bulk, 0.6, depth + 0.2), M.main, 0, 4.5, 0, { edge: true });  // collar
  add(torso, cyl(0.7, 0.8, 0.8), M.dark, 0, 4.9, 0);

  if (style === 'light') {
    for (let i = 0; i < 3; i++) add(torso, box(3.2 * bulk, 0.2, 0.3), M.dark, 0, 1.7 + i * 0.5, zf + 0.15);
  } else if (style === 'heavy') {
    add(torso, box(4.6 * bulk, 2.4, 0.7), M.main, 0, 2.3, zf - 0.3, { edge: true });
    add(torso, box(4.6 * bulk, 0.4, 0.8), M.accent, 0, 1.4, zf - 0.3, { edge: true });
    for (let i = 0; i < 4; i++) add(torso, box(0.7, 0.9, 0.12), M.dark, (i - 1.5) * 1.0 * bulk, 2.9, zf - 0.68);
    add(torso, box(5.8 * bulk, 0.5, depth + 0.4), M.accent, 0, 4.85, 0, { edge: true });
    for (const s of [-1, 1]) add(torso, box(0.9, 2.8, 2.6), M.dark, s * 3.0 * bulk, 2.1, 0);
  } else if (style === 'reactor') {
    add(torso, box(2.3, 2.3, 0.4), M.dark, 0, 2.3, zf - 0.05, { edge: true });
    add(torso, box(1.4, 1.4, 0.5), glow, 0, 2.3, zf - 0.2, { shadow: false });
    for (const s of [-1, 1]) add(torso, box(0.4, 2.2, 1.7), M.trim, s * 2.65 * bulk, 2.1, -0.4, { edge: true });
  } else if (style === 'bay') {
    for (const s of [-1, 1]) {
      add(torso, box(1.9, 1.9, 0.5), M.dark, s * 1.55 * bulk, 2.2, zf - 0.15, { edge: true });
      for (const ox of [-0.4, 0.4]) for (const oy of [-0.4, 0.4]) add(torso, cyl(0.26, 0.26, 0.4, 8), M.trim, s * 1.55 * bulk + ox, 2.2 + oy, zf - 0.5, { rx: PI / 2 });
    }
    add(torso, box(0.5, 2.2, 0.4), M.accent, 0, 2.2, zf - 0.1, { edge: true });
  } else if (style === 'command') {
    add(torso, box(2.4, 1.1, 0.5), glow, 0, 3.3, zf - 0.1, { shadow: false });
    add(torso, box(2.8, 0.3, 0.6), M.trim, 0, 3.95, zf - 0.1);
    for (const s of [-1, 1]) add(torso, box(0.3, 2.4, 1.8), M.accent, s * 2.8 * bulk, 2.4, -0.2, { edge: true });
    add(torso, cyl(0.07, 0.07, 3.2, 6), M.metal, 2.0 * bulk, 6.3, 1.0);
    add(torso, cyl(0.75, 0.2, 0.3, 12), M.metal, 2.0 * bulk, 7.9, 1.0, { rz: 0.5, edge: true });
  } else if (style === 'wedge') {
    // an angular prow: a sloped plate down the centre of the chest and chamfered shoulders
    add(torso, wedge(2.4, 2.8, 0.9, 0.35), M.accent, 0, 2.7, zf - 0.35, { edge: true });
    for (const s of [-1, 1]) add(torso, box(0.4, 2.8, 1.6), M.trim, s * 2.3 * bulk, 2.9, -0.3, { rz: s * 0.2, edge: true });
  } else if (style === 'ranger') {
    for (const s of [-1, 1]) {
      add(torso, cyl(0.55, 0.55, 3.4, 10), M.metal, s * 1.2, 2.9, depth / 2 + 0.55);     // fuel tanks down the spine
      add(torso, cyl(0.6, 0.6, 0.3, 10), M.accent, s * 1.2, 4.4, depth / 2 + 0.55);
      add(torso, cone(0.5, 0.9, 8), M.trim, s * 2.45 * bulk, 4.9, -0.2);                 // shoulder spurs
    }
    add(torso, box(1.8, 0.6, 0.4), M.trim, 0, 3.5, zf - 0.1);
  } else if (style === 'grunt') {
    // the rank-and-file chassis: a rounded, tucked chest with a single broad intake
    add(torso, box(2.4, 0.6, 0.4), M.dark, 0, 2.8, zf - 0.05, { edge: true });
    add(torso, cyl(0.5, 0.5, 0.3, 10), glow, 0, 1.9, zf - 0.1, { rx: PI / 2, shadow: false });
  }
}

// ------------------------------------------------------------------ arms

const ARM = {
  std:       { upper: [1.5, 3.2, 1.6], fore: [1.8, 3.6, 2.1] },
  assault:   { upper: [1.8, 3.2, 1.9], fore: [2.4, 3.8, 2.6] },
  precision: { upper: [1.2, 3.2, 1.3], fore: [1.4, 3.6, 1.7] },
  blade:     { upper: [1.5, 3.2, 1.6], fore: [1.8, 3.6, 2.1] },
  guard:     { upper: [1.8, 3.2, 1.9], fore: [2.5, 3.6, 2.7] },
  recoil:    { upper: [1.6, 3.2, 1.7], fore: [2.0, 3.8, 2.3] },
};

export function buildArms(rig) {
  const { k, torso, spec, bulk } = rig;
  const { add, group, M, box, cyl, sph, glow } = k;
  const style = spec.arms && ARM[spec.arms] ? spec.arms : 'std';
  const A = ARM[style];
  rig.A = A;
  const arms = {};
  for (const s of [-1, 1]) {
    const arm = group(torso, s * (SHOULDER_X * bulk), SHOULDER_Y, 0);
    arm.rotation.order = 'YXZ';
    add(arm, sph(1.0), M.dark);
    add(arm, box(...A.upper), M.main, 0, -2.1, 0, { edge: true });
    add(arm, box(A.upper[0] + 0.1, 0.4, A.upper[2] + 0.1), M.trim, 0, -0.7, 0);
    const elbow = group(arm, 0, -3.8, 0);
    add(elbow, cyl(0.8, 0.8, 1.8), M.dark, 0, 0, 0, { rz: PI / 2 });
    add(elbow, box(...A.fore), M.main, 0, -2.0, 0, { edge: true });
    add(elbow, box(A.fore[0] + 0.1, 0.6, A.fore[2] + 0.1), M.trim, 0, -3.3, 0);
    add(elbow, box(A.fore[0] - 0.5, 1.4, 0.3), M.dark, 0, -1.6, -(A.fore[2] / 2) - 0.05); // forearm vent

    if (style === 'assault') {
      add(elbow, box(A.fore[0] + 0.3, 0.9, A.fore[2] + 0.3), M.accent, 0, -0.5, 0, { edge: true });
      add(arm, box(A.upper[0] + 0.3, 1.0, A.upper[2] + 0.3), M.accent, 0, -1.3, 0, { edge: true });
    } else if (style === 'precision') {
      add(elbow, box(0.35, 1.6, 0.35), M.trim, 0, -1.0, -(A.fore[2] / 2 + 0.1));
      add(elbow, sph(0.28), glow, 0, -0.2, -(A.fore[2] / 2 + 0.1), { shadow: false });
    } else if (style === 'blade') {
      add(elbow, box(0.25, 3.6, 1.3), M.trim, s * 1.15, -2.0, -0.4, { rz: s * 0.12, edge: true });
      add(elbow, box(0.2, 4.6, 0.9), M.metal, s * 1.05, -2.2, 0.95, { rx: 0.1 });
    } else if (style === 'guard') {
      add(elbow, box(0.5, 3.2, A.fore[2] + 0.5), M.accent, s * (A.fore[0] / 2 + 0.2), -2.0, 0, { edge: true });
      add(elbow, box(A.fore[0] + 0.2, 0.6, A.fore[2] + 0.2), M.trim, 0, -0.4, 0);
    } else if (style === 'recoil') {
      for (const ox of [-0.8, 0.8]) add(elbow, cyl(0.16, 0.16, 3.6, 6), M.metal, ox, -2.1, -(A.fore[2] / 2 + 0.2));
      add(elbow, box(A.fore[0] + 0.3, 0.7, 0.9), M.dark, 0, -0.5, -(A.fore[2] / 2 + 0.1), { edge: true });
      add(elbow, box(A.fore[0] + 0.1, 0.5, A.fore[2] + 0.1), M.accent, 0, -3.3, 0);
    }
    const hand = group(elbow, 0, -4.0, 0);
    add(hand, box(1.2, 1.4, 1.4), M.dark, 0, -0.5, 0);
    arms[s] = { arm, elbow, hand };
  }
  rig.armL = arms[-1];
  rig.armR = arms[1];
}

export { HIP_Y, NECK_Y };
