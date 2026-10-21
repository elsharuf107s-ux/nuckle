// Shared building blocks for the procedural mech model: a geometry cache (every mech reuses the same
// boxes and cylinders), per-mech materials (so a hit flash only lights up the mech that was hit), and
// the small helpers every part builder uses.
//
// A part builder is a plain function `(k, ...)` where `k` is the kit made by makeKit(): it adds meshes to
// groups of the rig and never needs to know about the animation.

import * as THREE from 'three';

const geoCache = new Map();
const edgeCache = new Map();
const cached = (key, make) => {
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = make()));
  return g;
};
export const boxGeo = (w, h, d) => cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
export const cylGeo = (rt, rb, h, seg = 12) => cached(`c${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
export const sphGeo = (r, ws = 14, hs = 10) => cached(`s${r},${ws},${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
export const coneGeo = (r, h, seg = 10) => cached(`k${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg, 1, true));
/** A wedge: a box whose top edge is pulled in, e.g. a sloped plate. `taper` is the fraction of width kept on top. */
export const wedgeGeo = (w, h, d, taper = 0.4) => cached(`w${w},${h},${d},${taper}`, () => {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0) pos.setX(i, pos.getX(i) * taper);
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
});
/** A box whose front face (-z) is narrower than the back: a prism that points forward. */
export const prowGeo = (w, h, d, tip = 0.3) => cached(`p${w},${h},${d},${tip}`, () => {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) if (pos.getZ(i) < 0) pos.setX(i, pos.getX(i) * tip);
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
});

const edgesOf = (geo) => {
  let e = edgeCache.get(geo);
  if (!e) edgeCache.set(geo, (e = new THREE.EdgesGeometry(geo)));
  return e;
};
const EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x0a0d14, transparent: true, opacity: 0.6 });

/** Build the kit for one mech: its materials and the add/group helpers bound to them. */
export function makeKit(spec) {
  const P = spec.palette;
  const flashMats = [];
  const std = (color, { metal = 0.3, rough = 0.5 } = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });
    flashMats.push(m);
    return m;
  };
  const M = {
    main: std(P.main),
    sub: std(P.sub),
    accent: std(P.accent),
    trim: std(P.trim),
    dark: std(P.dark, { metal: 0.5, rough: 0.6 }),
    metal: std(0x8a92a6, { metal: 0.85, rough: 0.35 }),
    steel: std(0x4a5160, { metal: 0.7, rough: 0.45 }), // gun-metal for barrels and vents
  };
  const glow = new THREE.MeshBasicMaterial({ color: P.glow });
  const cyanGlow = new THREE.MeshBasicMaterial({ color: 0x6adfff, fog: false });
  const greenGlow = new THREE.MeshBasicMaterial({ color: 0x6dff9a, fog: false });
  const energyGlow = new THREE.MeshBasicMaterial({ color: P.blade, fog: false });
  const warmGlow = new THREE.MeshBasicMaterial({ color: 0xffd070, fog: false });

  // cone geometry is open-ended, so it is drawn from both sides: give it its own copy of the material
  const twoSided = new Map();
  const sided = (mat) => {
    if (!twoSided.has(mat)) {
      const c = mat.clone();
      c.side = THREE.DoubleSide;
      if (flashMats.includes(mat)) flashMats.push(c);
      twoSided.set(mat, c);
    }
    return twoSided.get(mat);
  };

  const add = (parent, geo, mat, x = 0, y = 0, z = 0, opts = {}) => {
    const mesh = new THREE.Mesh(geo, geo.type === 'ConeGeometry' ? sided(mat) : mat);
    mesh.position.set(x, y, z);
    if (opts.rx) mesh.rotation.x = opts.rx;
    if (opts.ry) mesh.rotation.y = opts.ry;
    if (opts.rz) mesh.rotation.z = opts.rz;
    if (opts.sx !== undefined) mesh.scale.set(opts.sx, opts.sy ?? opts.sx, opts.sz ?? opts.sx);
    mesh.castShadow = opts.shadow !== false;
    if (opts.edge) mesh.add(new THREE.LineSegments(edgesOf(geo), EDGE_MAT));
    parent.add(mesh);
    return mesh;
  };
  const group = (parent, x = 0, y = 0, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };
  /** An empty marker node, e.g. a muzzle or a garage hardpoint. */
  const node = (parent, x = 0, y = 0, z = 0) => {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };

  return {
    THREE, P, M, flashMats, glow, cyanGlow, greenGlow, energyGlow, warmGlow,
    box: boxGeo, cyl: cylGeo, sph: sphGeo, cone: coneGeo, wedge: wedgeGeo, prow: prowGeo,
    add, group, node,
  };
}
