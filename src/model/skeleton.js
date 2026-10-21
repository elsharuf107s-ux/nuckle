// The proportions every mech shares. The legs are long and slim, the waist narrow, the shoulders broad:
// the silhouette of a real-robot suit. The animation solves its legs against these numbers, so the model
// and the rig must agree on them; keep them here. The constants are the stock mech's; makeSkeleton() turns
// them into one mech's own numbers (longer legs, shorter arms, a different leg layout).

export const PIVOT = 0.5;  // the hip joint sits this far below the pelvis centre
export const THIGH = 4.6;  // thigh length
export const SHIN = 5.4;   // shin length (knee to ankle)
export const SOLE = 0.6;   // ankle to the sole of the boot
export const HIP_Y = PIVOT + THIGH + SHIN + SOLE; // pelvis height: puts the soles on the ground
export const MECH_HEIGHT = 19.4;

export const TORSO_Y = 0.8; // the torso group sits this far above the pelvis
export const NECK_Y = 5.0;  // the head group sits this far above the torso origin

/** Where the arms hang from: the shoulder joint, in torso space (x is scaled by the torso's bulk). */
export const SHOULDER_X = 3.35;
export const SHOULDER_Y = 3.7;

/** Leg styles: half-spacing of the hips, and the thigh / shin / foot box sizes (w, h, d). Heights stay fixed so every foot meets the ground. */
export const LEG = {
  std:     { x: 1.75, thigh: [2.0, 4.0, 2.3], shin: [2.1, 4.6, 2.6], foot: [2.4, 1.0, 4.4] },
  sprint:  { x: 1.65, thigh: [1.65, 4.0, 1.95], shin: [1.75, 4.6, 2.1], foot: [2.0, 1.0, 4.6] },
  tank:    { x: 2.2,  thigh: [2.7, 4.0, 2.9], shin: [2.9, 4.6, 3.3], foot: [3.2, 1.0, 4.8] },
  jump:    { x: 1.8,  thigh: [1.95, 4.0, 2.2], shin: [2.15, 4.6, 2.6], foot: [2.4, 1.0, 4.4] },
  strider: { x: 1.65, thigh: [1.75, 4.0, 2.0], shin: [1.85, 4.6, 2.2], foot: [2.1, 1.0, 5.0] },
  siege:   { x: 2.3,  thigh: [2.5, 4.0, 2.7], shin: [2.7, 4.6, 3.1], foot: [3.6, 1.0, 5.2] },
};

export const UPPER = 3.8;  // arm segments: shoulder to elbow, elbow to the grip (see buildArms)
export const FORE = 4.0;

/**
 * Leg layouts. A `legs` layout stands on rows of paired legs: each row has the hip's offset from the centre
 * line (`hipX`) and along the body (`z`, negative is ahead), and where that leg's foot rests (`footX`, `footZ`);
 * a leg whose foot is out to the side is yawed to point at it (a spider's). `ext` is how far the legs stand
 * extended (1 would be a straight leg). Treads and hover drive have no legs: just the height of the hull.
 */
export const LAYOUTS = {
  biped: { kind: 'legs' },
  quad: {
    kind: 'legs', legK: 0.92, ext: 0.9, radius: 6.6,
    rows: [{ z: -4.7, hipX: 2.9, footX: 3.7, footZ: -6.3 }, { z: 4.7, hipX: 2.9, footX: 3.7, footZ: 6.3 }],
  },
  hexa: {
    kind: 'legs', legK: 1.0, ext: 0.86, radius: 8.2,
    rows: [{ z: -5.2, hipX: 2.8, footX: 8.2, footZ: -9.4 }, { z: 0, hipX: 3.1, footX: 9.6, footZ: 0 }, { z: 5.2, hipX: 2.8, footX: 8.2, footZ: 9.4 }],
  },
  tread: { kind: 'tread', hipY: 3.5, trackX: 5.1, radius: 7 },
  hover: { kind: 'hover', hipY: 7.4, podX: 4.6, podZ: 4.2, radius: 6.4 },
};

/** The numbers of one mech's skeleton, from its spec (`layout` and the `prop` proportions). A stock spec gives the constants above. */
export function makeSkeleton(spec) {
  const prop = spec.prop ?? {};
  const legK = prop.legs ?? 1, armK = prop.arms ?? 1;
  const lay = LAYOUTS[spec.layout] ?? LAYOUTS.biped;
  const style = LEG[spec.legs] ?? LEG.std;
  const thigh = THIGH * legK * (lay.legK ?? 1), shin = SHIN * legK * (lay.legK ?? 1);
  const sk = { kind: lay.kind, layout: LAYOUTS[spec.layout] ? spec.layout : 'biped', legK, armK, thigh, shin, upper: UPPER * armK, fore: FORE * armK, reach: thigh + shin - 0.05, hips: [] };
  if (lay.kind === 'legs') {
    const rows = lay.rows ?? [{ z: 0, hipX: style.x, footX: style.x, footZ: 0 }];
    rows.forEach((r, row) => {
      for (const side of [-1, 1]) {
        const dx = r.footX - r.hipX, dz = r.footZ - r.z;
        // the leg's heading: the way it points to reach its foot (yaw about the hips' y axis; 0 is straight ahead)
        sk.hips.push({ side, row, x: side * r.hipX, z: r.z, footX: side * r.footX, footZ: r.footZ, yaw: Math.atan2(-side * dx, -dz) * (Math.hypot(dx, dz) > 0.5 ? 1 : 0), run: Math.hypot(dx, dz) });
      }
    });
    // standing: the legs extended `ext` of their length, so the hips sit at the height that leaves
    const run = Math.max(...sk.hips.map((h) => h.run));
    const ext = (lay.ext ?? 1) * (thigh + shin);
    sk.hipY = PIVOT + SOLE + (lay.rows ? Math.sqrt(Math.max(ext * ext - run * run, 4)) : thigh + shin);
  } else {
    sk.hipY = lay.hipY * (lay.kind === 'hover' ? 0.9 + 0.1 * legK : 1);
  }
  sk.pivot = PIVOT;
  sk.sole = SOLE;
  sk.style = style;
  sk.lay = lay;
  sk.height = MECH_HEIGHT - HIP_Y + sk.hipY; // the crown of the head above the ground
  sk.radius = lay.radius ?? 5.5;                // how far it spreads: the body's footprint, in the model's own units
  return sk;
}
