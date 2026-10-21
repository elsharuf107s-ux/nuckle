// Helmets and crests. A helmet is built around the head group's origin (the neck), facing -Z, and its
// skull top is at about y = 2.1. A crest sits on top of it; the garage lets you fit any crest on any
// helmet, and `auto` keeps the one that suits the helmet.

import { NECK_Y } from './skeleton.js';

const PI = Math.PI;

/**
 * A whip antenna: a thin rod in its own group, hinged at its base so the animation can let it sway.
 * (x, y, z) is the base in head space; the rod rises `len` from there, tilted by `rz`.
 */
function whip(kit, rig, head, x, y, z, len, mat, r = 0.05, rz = 0) {
  const k = kit.raw ?? kit; // inside a crest builder the kit's add() is redirected to the crest group; a whip hangs off the head
  const g = k.group(head, x, y, z);
  g.rotation.z = rz;
  k.add(g, k.cyl(r, r, len, 6), mat, 0, len / 2, 0);
  rig.whips.push({ g, len, rest: rz });
  return g;
}

/** The common helmet: a skull, ear pods, a face mask with eye slits, cheek vents and a chin guard. */
function helmet(k, head, o = {}) {
  const { add, box, cyl, M, glow } = k;
  const w = o.w ?? 2.1, h = o.h ?? 1.9, d = o.d ?? 2.3;
  add(head, box(w, h, d), o.skull ?? M.main, 0, 1.1, 0, { edge: true });
  add(head, box(w - 0.3, h - 0.5, 0.6), M.dark, 0, 1.0, d / 2);                      // rear block
  for (const s of [-1, 1]) add(head, box(0.5, 1.2, 1.3), M.sub, s * (w / 2 + 0.2), 1.0, 0.2, { edge: true }); // ear pods
  add(head, box(w - 0.7, 1.1, 0.35), M.steel, 0, 0.85, -d / 2 - 0.05);               // face mask
  add(head, box(1.0, 0.5, 0.55), M.accent, 0, 0.2, -d / 2 + 0.05, { edge: true });   // chin guard
  for (const s of [-1, 1]) {
    add(head, box(0.5, 0.2, 0.12), glow, s * 0.5, 1.0, -d / 2 - 0.22, { shadow: false });  // eyes
    add(head, box(0.12, 0.5, 0.1), M.dark, s * 0.85, 0.5, -d / 2 - 0.1);              // cheek vents
  }
  add(head, cyl(0.2, 0.2, 0.2, 8), M.trim, 0, 1.9, -d / 2 + 0.05, { rx: PI / 2 });     // forehead camera
  return { w, h, d };
}

export const HEADS = {
  // the hero helmet: clean lines, a face mask and a forehead camera
  v: {
    crest: 'vfin',
    build(k, head) {
      helmet(k, head);
      for (const s of [-1, 1]) k.add(head, k.box(0.35, 0.3, 0.2), k.M.trim, s * 0.85, 0.4, -1.1);   // jaw vents
    },
  },

  // the grunt's domed head with a single sweeping mono-eye
  mono: {
    crest: 'none',
    build(k, head, rig) {
      const { add, box, cyl, sph, M, glow } = k;
      const dome = add(head, sph(1.25, 16, 12), M.main, 0, 1.0, 0);
      dome.scale.set(1, 0.9, 1.05);
      add(head, box(1.9, 0.8, 1.9), M.dark, 0, 0.2, 0);
      add(head, box(1.7, 0.3, 0.25), M.dark, 0, 1.0, -1.15);
      rig.eyeNode = add(head, sph(0.3), glow, 0, 1.0, -1.25, { shadow: false });
      for (const s of [-1, 1]) add(head, cyl(0.2, 0.2, 1.5), M.dark, s * 1.0, 0.7, 0.6, { rx: -0.5 });  // cheek hoses
      whip(k, rig, head, -0.7, 1.2, 0.2, 2.2, M.dark);                                                // whip antenna
    },
  },

  // the commander's helmet: a heavier chin and a gold-trimmed brow
  horn: {
    crest: 'horn',
    build(k, head) {
      const { add, box, M } = k;
      helmet(k, head);
      add(head, box(2.3, 0.3, 0.6), M.trim, 0, 1.95, -0.95, { edge: true });
      add(head, box(1.4, 0.6, 0.7), M.accent, 0, 0.1, -1.0, { edge: true });
    },
  },

  // a boxy bucket helm with one wide visor slit
  visor: {
    crest: 'blade',
    build(k, head) {
      const { add, box, M, glow } = k;
      add(head, box(2.3, 1.9, 2.3), M.main, 0, 0.95, 0, { edge: true });
      add(head, box(2.1, 0.85, 0.4), M.dark, 0, 0.95, -1.15);
      add(head, box(1.8, 0.3, 0.14), glow, 0, 1.0, -1.38, { shadow: false });
      add(head, box(1.2, 0.5, 0.6), M.accent, 0, 0.2, -1.15, { edge: true });
      for (const s of [-1, 1]) add(head, box(0.45, 1.3, 1.8), M.sub, s * 1.3, 0.9, 0.05, { rz: s * 0.08, edge: true });
    },
  },

  // the scout helmet: the hero's, with a sensor dish and a tall antenna
  recon: {
    crest: 'antenna',
    build(k, head) {
      const { add, cyl, M } = k;
      helmet(k, head);
      add(head, cyl(1.15, 0.25, 0.35, 16), M.metal, 1.55, 1.55, 0.1, { rz: -0.95, edge: true });
      add(head, cyl(0.08, 0.08, 1.4, 6), M.metal, 1.15, 0.95, 0.1);
    },
  },

  // the ace's helmet: narrow, with swept side blades
  ace: {
    crest: 'blade',
    build(k, head) {
      const { add, box, M } = k;
      helmet(k, head, { w: 2.0, h: 1.7 });
      for (const s of [-1, 1]) add(head, box(0.14, 0.9, 2.4), M.trim, s * 1.12, 1.35, 0.5, { rx: 0.35, edge: true });
    },
  },

  // the electronic-warfare helmet: a jamming dish and a crown of antennae
  jammer: {
    crest: 'crown',
    build(k, head) {
      const { add, cyl, M } = k;
      helmet(k, head);
      add(head, cyl(0.55, 0.12, 0.3, 12), M.metal, 1.4, 1.0, 0.1, { rz: -1.2, edge: true });
    },
  },

  // a rounded, closed helm with a narrow vertical visor and cheek guards
  knight: {
    crest: 'none',
    build(k, head) {
      const { add, box, cyl, sph, M, glow } = k;
      add(head, cyl(1.15, 1.2, 1.9, 14), M.main, 0, 1.0, 0, { edge: false });
      const top = add(head, sph(1.15, 14, 8), M.main, 0, 1.95, 0);
      top.scale.set(1, 0.55, 1);
      add(head, box(0.5, 1.2, 0.3), M.dark, 0, 1.0, -1.2);
      add(head, box(0.12, 0.9, 0.12), glow, 0, 1.05, -1.38, { shadow: false });
      for (const s of [-1, 1]) {
        add(head, box(0.3, 1.5, 1.2), M.sub, s * 1.15, 0.9, -0.3, { rz: s * 0.1, edge: true });  // cheek guards
        add(head, box(0.5, 0.9, 0.5), M.accent, s * 0.55, 0.2, -1.0, { edge: true });
      }
      add(head, box(1.6, 0.4, 0.5), M.trim, 0, 0.1, -0.9);
    },
  },

  // a beaked targeting helm with narrow eye slits
  hawk: {
    crest: 'none',
    build(k, head, rig) {
      const { add, box, prow, M, glow } = k;
      add(head, box(1.9, 1.7, 2.1), M.main, 0, 1.0, 0.1, { edge: true });
      add(head, prow(1.1, 0.8, 1.9, 0.12), M.main, 0, 0.55, -1.75, { edge: true });                // the beak
      add(head, box(0.3, 0.3, 0.5), M.trim, 0, 0.45, -2.65);
      for (const s of [-1, 1]) {
        add(head, box(0.45, 0.14, 0.12), glow, s * 0.5, 1.25, -1.1, { rz: -s * 0.2, shadow: false });
        add(head, box(0.14, 1.0, 1.6), M.trim, s * 1.0, 1.5, 0.3, { rx: 0.25, rz: s * 0.1, edge: true });  // swept fins
      }
      whip(k, rig, head, 0.48, 1.7, 0.4, 1.6, M.metal, 0.07, -0.15);
    },
  },

  // a light helm with two round camera lenses
  twin: {
    crest: 'antenna',
    build(k, head) {
      const { add, box, cyl, M, glow } = k;
      add(head, box(2.2, 1.6, 2.1), M.main, 0, 1.0, 0, { edge: true });
      add(head, box(2.0, 0.8, 0.4), M.dark, 0, 0.95, -1.1);
      for (const s of [-1, 1]) {
        add(head, cyl(0.38, 0.38, 0.3, 12), M.steel, s * 0.6, 0.95, -1.25, { rx: PI / 2, edge: true });
        add(head, cyl(0.24, 0.24, 0.15, 12), glow, s * 0.6, 0.95, -1.42, { rx: PI / 2, shadow: false });
        add(head, box(0.5, 1.0, 1.2), M.sub, s * 1.35, 0.9, 0.2, { edge: true });
      }
      add(head, box(1.0, 0.5, 0.5), M.accent, 0, 0.2, -1.05, { edge: true });
    },
  },
};

// ------------------------------------------------------------------ crests

const CREST_BASE = 2.0; // the crest group's origin: the top of the skull

export const CREST = {
  vfin(k, head) {
    const { add, box, M } = k;
    add(head, box(0.5, 0.6, 1.6), M.main, 0, 2.2, 0.1, { edge: true });
    for (const s of [-1, 1]) add(head, box(0.18, 1.8, 0.14), M.trim, s * 0.5, 2.35, -1.0, { rz: -s * 0.45 });
  },
  horn(k, head) {
    const { add, box, cone, M } = k;
    add(head, box(0.5, 0.6, 1.6), M.main, 0, 2.2, 0.1, { edge: true });
    add(head, cone(0.35, 2.8, 8), M.trim, 0, 3.2, -0.7, { rx: -0.35 });
    for (const s of [-1, 1]) add(head, box(0.15, 2.2, 0.12), M.trim, s * 0.5, 2.3, -1.0, { rz: -s * 0.8 });
  },
  blade(k, head) {
    const { add, box, M } = k;
    add(head, box(0.2, 1.4, 2.0), M.trim, 0, 2.7, 0.1, { rx: -0.3, edge: true });
    add(head, box(0.45, 0.4, 1.4), M.main, 0, 2.15, 0.1);
  },
  antenna(k, head, rig) {
    for (const s of [-1, 1]) {
      const w = whip(k, rig, head, s * 0.57, 2.0, 0.2, 2.2, k.M.metal, 0.05, -s * 0.12);
      k.raw.add(w, k.sph(0.12), k.glow, 0, 2.2, 0, { shadow: false });
    }
  },
  crown(k, head) {
    const { add, cone, M } = k;
    [-0.9, -0.45, 0, 0.45, 0.9].forEach((x, i) => {
      const h = i % 2 ? 1.2 : 2.0;
      add(head, cone(0.17, h, 6), M.trim, x, 2.0 + h / 2, 0.1, { rz: -x * 0.3 });
    });
  },
  none() {},
};

/** Build the helmet and its crest. Returns nothing; sets rig.head, rig.eyeNode. */
export function buildHead(rig) {
  const { k, torso, spec } = rig;
  const head = k.group(torso, 0, NECK_Y, 0);
  head.scale.setScalar(1.16); // a slightly large head keeps the narrow frame from looking small-headed
  rig.head = head;
  rig.eyeNode = null;
  const def = HEADS[spec.head] ?? HEADS.v;
  def.build(k, head, rig);
  const crest = spec.crest && spec.crest !== 'auto' ? spec.crest : def.crest;
  // the crest sits in its own group at the top of the skull, so an impact can rattle it
  const crestNode = k.group(head, 0, CREST_BASE, 0);
  rig.crest = crestNode;
  const ck = { ...k, raw: k, add: (parent, geo, mat, x, y, z, o) => k.add(crestNode, geo, mat, x, y - CREST_BASE, z, o) };
  (CREST[crest] ?? CREST.none)(ck, head, rig);
}
