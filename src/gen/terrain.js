// The tile bank as the painters use it (design 4.3, 4.6): terrain.json (stages 2a and 2b) turned into flat lookups
// once per world. Pure: the caller passes the parsed JSON (the worker fetches it, the Node tools read the file).
//
//   prepTerrain(T)  ->  {
//     genBase, waterTile, pondTile,
//     ve(v, mid)          the home look of General piece `mid` in variant v (v 0: the mid itself)
//     ov(v, mid)          its overlay entry, or -1
//     grass[v]            [1, 8, 9, 16, 17] in variant v (a tint, a band or a rock style's grounds)
//     sets.A..P[recolour] { home: Int32Array(47), ov: Int32Array(47) | null, outside }
//     lut                 the 256-entry blob-code lookup (neighbour bits N 1, E 2, S 4, W 8, NE 16, SE 32, SW 64, NW 128)
//     species[name]       { home: Int32Array(40), ov: Int32Array(40), ground, wood } indexed by General mid
//     rock, ledge         learned tables with numeric keys (autotile.js lookup)
//     ores                { faces: Set, entry(style, face, kind) }
//     sprites, synthGrounds, fam (home-ground families)
//   }

export const ORE_KINDS = Object.freeze(['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore']);
export const STYLES = Object.freeze(['brown', 'grey', 'snowy', 'sandstone']);
export const GRASS_MIDS = Object.freeze([1, 8, 9, 16, 17]);

function learnedMaps(L) {
  // keys: r2/r1 by the integer membership key; g2/g1 by key * 2 + (context 's' ? 1 : 0)
  const num = (o) => { const m = new Map(); for (const k of Object.keys(o)) m.set(Number(k), o[k]); return m; };
  const ctx = (o) => {
    const m = new Map();
    for (const k of Object.keys(o)) { const [a, g] = k.split('|'); m.set(Number(a) * 2 + (g === 's' ? 1 : 0), o[k]); }
    return m;
  };
  const compat = new Map();
  for (const k of Object.keys(L.compat)) compat.set(Number(k), L.compat[k]);
  // px: [grass, sand] pixel flags with every FireRed grass, rim and sand colour (the rock table only). compat is
  // autotile.json's narrower count, kept for the lookup so the generator and Classic's re-edger pick the same
  // pieces; the painter and the checks decide what a piece shows from px (stage 3b fix: the beach sand under
  // rock corners and feet, which compat misses)
  const px = new Map();
  for (const k of Object.keys(L.px || L.compat)) px.set(Number(k), (L.px || L.compat)[k]);
  return { r2: num(L.r2), r1: num(L.r1), g2: ctx(L.g2), g1: ctx(L.g1), fill: num(L.fill), compat, px, members: new Set(L.members) };
}

export function prepTerrain(T) {
  if (!T || T.v !== 1) throw new Error('terrain.json v1 expected');
  const genBase = T.genBase;
  const NV = 1 + Math.max(...T.variants.map((v) => v.id));
  const veArr = [], ovArr = [];
  for (let v = 0; v < NV; v++) {
    const a = new Int32Array(640).fill(-1), o = new Int32Array(640).fill(-1);
    if (v === 0) for (let m = 0; m < 640; m++) a[m] = m;
    const ve = T.ventry[String(v)];
    if (ve) for (const k of Object.keys(ve)) a[Number(k)] = ve[k];
    const ovl = T.ovl[String(v)];
    if (ovl) for (const k of Object.keys(ovl)) o[Number(k)] = ovl[k];
    veArr.push(a); ovArr.push(o);
  }
  const ve = (v, mid) => { const e = veArr[v][mid]; return e >= 0 ? e : mid; };
  const ov = (v, mid) => ovArr[v][mid];
  const grass = veArr.map((a) => Int32Array.from(GRASS_MIDS, (m) => (a[m] >= 0 ? a[m] : m)));

  const sets = {};
  for (const [sid, S] of Object.entries(T.quarter.sets)) {
    sets[sid] = {};
    for (const [name, r] of Object.entries(S.recolours)) {
      sets[sid][name] = { home: Int32Array.from(r.home), ov: r.ov ? Int32Array.from(r.ov) : null, outside: r.outside, mat: r.mat, v: r.var };
    }
  }

  const species = {};
  for (const [name, s] of Object.entries(T.species)) {
    const home = new Int32Array(40).fill(-1), o = new Int32Array(40).fill(-1);
    for (const k of Object.keys(s.home)) home[Number(k)] = s.home[k];
    for (const k of Object.keys(s.ov)) o[Number(k)] = s.ov[k];
    species[name] = { home, ov: o, ground: s.ground, wood: s.wood, v: s.var };
  }

  const faces = new Set(T.ores.faces);
  const oreE = T.ores.entries;
  const oreEntry = (style, face, kind) => {
    const a = oreE[style] && oreE[style][String(face)];
    return a ? (a[kind] ?? -1) : -1;
  };

  // home-ground families: an overlay piece uses its home look only on these grounds (stage 2a's homeGround rule,
  // widened to the family of plain grounds the home look was drawn on)
  const fam = (list) => new Set(list);
  const rs = T.rockStyles;
  const famOf = {
    grass: fam(grass[0]),
    grey: fam(grass[rs.grey.var]),
    snow: fam(grass[rs.snowy.var]),
    sand: fam(grass[rs.sandstone.var]),
  };

  return {
    genBase, count: T.count, waterTile: T.waterTile, pondTile: T.pondTile,
    variants: T.variants, tints: T.tints, bands: T.bands, rockStyles: rs,
    ve, ov, grass, sets, lut: Int32Array.from(T.quarter.lut), species,
    rock: learnedMaps(T.learned.rock), ledge: learnedMaps(T.learned.ledge),
    ores: { faces, entry: oreEntry, kinds: ORE_KINDS },
    sprites: T.synth.sprites, synthGrounds: T.synth.grounds,
    vocab: T.vocab, fam: famOf, entries: T.entries,
    villages: T.villages || null,    // (stage 7a: village templates; null in a terrain.json from before 7a)
  };
}
