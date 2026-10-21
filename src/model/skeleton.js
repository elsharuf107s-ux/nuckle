// The proportions every mech shares. The legs are long and slim, the waist narrow, the shoulders broad:
// the silhouette of a real-robot suit. The animation solves its legs against these numbers, so the model
// and the rig must agree on them; keep them here.

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
