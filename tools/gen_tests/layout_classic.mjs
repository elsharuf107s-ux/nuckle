// The world update, stage 1: the layout abstraction must be an identity in Classic. Every new accessor of the World
// (src/world.js) is compared, cell by cell, with the expression the code used before the update; the draw-canvas
// LRU and the lazy top-layer canvas must draw exactly what the old two-canvas chunks drew; and the game runs.
//
//   node tools/headless.mjs tools/gen_tests/layout_classic.mjs --params '?new&play' --port 5640 --out <dir>
export default async function ({ run, idle, hold, check, log, R }) {
  // 1. the layout descriptor and world.meta
  const L = await run(() => {
    const h = window.__rs, W = h.world, A = h.A, M = W.meta;
    return {
      layout: W.layout, metaIsA: M === A.world, maps: W.maps === A.world.maps, towns: W.towns === A.world.towns, warps: W.warps === A.world.warps,
      nether: W.nether === A.world.nether, stronghold: W.stronghold === A.world.stronghold, end: W.end === A.world.end,
      outdoor: W.outdoor === A.world.outdoor, frozen: Object.isFrozen(W.layout), WH: [W.W, W.H, A.world.w, A.world.h],
      warpI: W.warps.every((w, i) => w.i === i && W.warpIdx.get(w.y * W.W + w.x) !== undefined),
      ensure: W.ensureAround(100, 100), ensure2: W.ensureAround(0, 0, 3), genBase: W.genBase, entries: W.entries.length,
    };
  });
  log('layout', JSON.stringify(L.layout));
  const ly = L.layout;
  check(ly.kind === 'classic' && ly.gen === false && ly.W === 408 && ly.H === 1062 && ly.ox === 0 && ly.oy === 0 && ly.ow === 408 && ly.oh === 400,
    `Classic layout: ${ly.kind} gen=${ly.gen} ${ly.W}x${ly.H}, overworld (${ly.ox}, ${ly.oy}) ${ly.ow}x${ly.oh}`);
  check(ly.border.x0 === 0 && ly.border.y0 === 0 && ly.border.x1 === 407 && ly.border.y1 === 399 && ly.kanto.x === 0 && ly.kanto.y === 0 && ly.band === null && L.frozen,
    'Classic border is the outdoor block, Kanto at (0, 0), no band, frozen');
  check(L.metaIsA && L.maps && L.towns && L.warps && L.nether && L.stronghold && L.end && L.outdoor, 'world.meta === A.world and every list is the same object');
  check(L.WH[0] === L.WH[2] && L.WH[1] === L.WH[3], `W x H ${L.WH[0]} x ${L.WH[1]} from the layout equals world.json's`);
  check(L.warpI, 'every warp has its list index and is in warpIdx');
  check(L.ensure === true && L.ensure2 === true, 'ensureAround returns true at once in Classic');
  check(L.genBase === L.entries && L.genBase === 8975, `genBase ${L.genBase} = entries ${L.entries}: no Classic entry reaches the second atlas`);
  // the generated descriptors (data only at this stage: their meta comes with the plan, so building one refuses)
  const G2 = await run(async () => {
    const LM = await import('/src/layout.js');
    const k = LM.makeLayout({ kind: 'kanto' }), w = LM.makeLayout({ kind: 'wild' });
    let refused = '';
    try { LM.metaFor(w); } catch (e) { refused = e.message; }
    let unknown = '';
    try { LM.makeLayout({ kind: 'flat' }); } catch (e) { unknown = e.message; }
    return { k, w, refused, unknown, classicMeta: LM.metaFor(LM.makeLayout()) === window.__rs.A.world };
  });
  log('kanto', JSON.stringify(G2.k)); log('wild', JSON.stringify(G2.w));
  const b = G2.w.border;
  check(G2.w.gen && G2.w.W === 2016 && G2.w.H === 1600 && G2.w.ox === 416 && G2.w.ow === 1600 && G2.w.kanto === null
    && b.x0 === 424 && b.y0 === 8 && b.x1 === 2007 && b.y1 === 1591, 'Wild World plane 2016 x 1600, overworld from x 416, border 424..2007 x 8..1591 (2.8)');
  check(G2.k.kanto && G2.k.kanto.x === 416 + 64 && G2.k.kanto.y === 1024 && G2.k.band.y0 === 400 && G2.k.band.y1 === 1061 && G2.k.band.x1 === 407,
    'Kanto World: Kanto at (416 + kx, ky), the room band x 0..407, y 400..1061 (2.2)');
  check(/not built yet/.test(G2.refused) && /unknown world type/.test(G2.unknown) && G2.classicMeta, `generated meta refused until the plan exists ("${G2.refused}")`);

  // 2. every cell: the accessors against the expressions they replace
  const C = await run(() => {
    const h = window.__rs, W = h.world, A = h.A, o = A.world.outdoor;
    const bad = { base: 0, mid: 0, ground: 0, region: 0, outdoor: 0, void: 0, blocked: 0, water: 0, entryFor: 0, varOf: 0, ovOf: 0, midTable: 0 };
    const WATER = new Set([0x10, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x19, 0x1A, 0x1B]);
    const oldOutdoor = (x, y) => x >= 0 && y >= 0 && x < o.w && y < o.h;
    let n = 0;
    for (let y = -2; y < W.H + 2; y++) for (let x = -2; x < W.W + 2; x++) {
      const ins = x >= 0 && y >= 0 && x < W.W && y < W.H, i = y * W.W + x;
      if (W.isOutdoor(x, y) !== oldOutdoor(x, y)) bad.outdoor++;
      const oldVoid = !ins || W.zone[i] === 2, oldBlocked = !ins || W.zone[i] === 2 || W.col[i] === 1;
      if (W.isVoid(x, y) !== oldVoid) bad.void++;
      if (W.baseBlocked(x, y) !== oldBlocked) bad.blocked++;
      let oldWater = false;
      if (ins) { const b = W.blocks.get(i); oldWater = !(b && b.flush) && WATER.has(W.beh[i]) && W.col[i] === 0; }
      if (W.isWater(x, y) !== oldWater) bad.water++;
      const t = ins ? W.grid[i] : 0;
      if (W.mid(x, y) !== (t < 640 ? t : -1)) bad.mid++;
      if (!ins) continue;
      n++;
      if (W.baseTile(i) !== A.grid[i]) bad.base++;
      if (W.groundFor(x, y) !== A.ground[i]) bad.ground++;
      const m = W.mapAt(x, y);
      if (W.regionKey(x, y) !== (m ? m.id : null)) bad.region++;
      if (W.entryFor(W.varOf[t], t) !== t) bad.entryFor++;
    }
    for (let t = 0; t < W.entries.length; t++) {
      if (W.varOf[t]) bad.varOf++;
      if (W.ovOf[t]) bad.ovOf++;
      if (W.midOf[t] !== (t < 640 ? t : -1)) bad.midTable++;
    }
    const zones = [0, 0, 0, 0];
    for (let i = 0; i < W.zone.length; i++) zones[W.zone[i]]++;
    return { bad, n, zones };
  });
  log('cells', C.n, 'zones', C.zones.join(','), 'mismatches', JSON.stringify(C.bad));
  check(C.n === 408 * 1062, `${C.n} cells compared`);
  check(C.zones[3] === 0, 'Classic has no zone 3 cells');
  for (const [k, v] of Object.entries(C.bad)) check(v === 0, `${k}: ${v} cells differ from the old expression`);

  // 3. samePlace against today's test (same map and both outdoors or both not), on cell pairs from everywhere, from
  //    the seam between Kanto's block and the room band, and from cells outside every map
  const S = await run(() => {
    const h = window.__rs, W = h.world;
    let s = 987654321;
    const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s % n; };
    const old = (ax, ay, bx, by) => W.areaOf(ax, ay) === W.areaOf(bx, by) && W.isOutdoor(ax, ay) === W.isOutdoor(bx, by);
    let n = 0, bad = 0, same = 0, nullPairs = 0;
    const test = (ax, ay, bx, by) => { n++; const a = W.samePlace(ax, ay, bx, by); if (a !== old(ax, ay, bx, by)) bad++; if (a) same++; if (!W.areaOf(ax, ay) && !W.areaOf(bx, by)) nullPairs++; };
    for (let k = 0; k < 200000; k++) test(rnd(W.W), rnd(W.H), rnd(W.W), rnd(W.H));
    for (let k = 0; k < 100000; k++) { const x = rnd(W.W), y = 380 + rnd(40); test(x, y, x - 12 + rnd(25), y - 12 + rnd(25)); }
    for (let k = 0; k < 100000; k++) { const x = rnd(W.W), y = rnd(W.H); test(x, y, x - 12 + rnd(25), y - 12 + rnd(25)); }
    return { n, bad, same, nullPairs };
  });
  log('samePlace pairs', S.n, 'same', S.same, 'both outside every map', S.nullPairs);
  check(S.bad === 0 && S.nullPairs > 1000, `samePlace equals the old test on ${S.n} pairs (${S.bad} differ)`);

  // 4. draw canvases: each chunk as the old code drew it (two canvases, every cell from atlas.png and atlas_top.png,
  //    flush blocks), against the new chunk (LRU, lazy top layer); then evicted and drawn again
  const D = await run(async () => {
    const h = window.__rs, W = h.world, A = h.A;
    const WM = await import('/src/world.js');
    const T = 16, CH = 16;
    const mk = () => { const k = document.createElement('canvas'); k.width = CH * T; k.height = CH * T; return k; };
    const oldChunk = (cx, cy) => {
      const below = mk(), above = mk(), b = below.getContext('2d'), a = above.getContext('2d');
      for (let yy = 0; yy < CH; yy++) for (let xx = 0; xx < CH; xx++) {
        const x = cx * CH + xx, y = cy * CH + yy;
        if (!W.inside(x, y)) continue;
        const px = xx * T, py = yy * T, i = y * W.W + x;
        if (W.zone[i] === 2) continue;
        const t = W.grid[i], sx = (t % A.world.cols) * T, sy = Math.floor(t / A.world.cols) * T;
        b.drawImage(A.img.atlas, sx, sy, T, T, px, py, T, T);
        if (W.entries[t][6]) a.drawImage(A.img.atlasTop, sx, sy, T, T, px, py, T, T);
        const bl = W.blocks.get(i);
        if (bl && bl.flush) { const look = WM.blockLook(bl.flushLook || (bl.id + ':flush')); if (look != null) WM.drawLook(b, look, px, py - 8); }
      }
      return { below, above };
    };
    const px = (cv) => cv ? cv.getContext('2d').getImageData(0, 0, CH * T, CH * T).data : null;
    const same = (p, q) => { if (p.length !== q.length) return false; for (let k = 0; k < p.length; k++) if (p[k] !== q[k]) return false; return true; };
    const blank = (p) => { for (let k = 3; k < p.length; k += 4) if (p[k]) return false; return true; };
    const all = [];
    for (let cy = 0; cy < W.ch; cy++) for (let cx = 0; cx < W.cw; cx++) all.push([cx, cy]);
    // every chunk with anything drawn, plus some empty ones
    const list = all.filter(([cx, cy]) => { for (let y = cy * CH; y < cy * CH + CH && y < W.H; y++) for (let x = cx * CH; x < cx * CH + CH && x < W.W; x++) if (W.zone[y * W.W + x] !== 2) return true; return false; });
    let bad = 0, badAgain = 0, lazy = 0, maxSize = 0, n = 0;
    const firstBelow = new Map();
    W.chunks.clear();
    for (const [cx, cy] of list) {
      const o = oldChunk(cx, cy), c = W.chunk(cx, cy);
      maxSize = Math.max(maxSize, W.chunks.size);
      const ob = px(o.below), oa = px(o.above), nb = px(c.below), na = px(c.above);
      const okA = na ? same(oa, na) : blank(oa);
      if (!na) lazy++;
      if (!same(ob, nb) || !okA) bad++;
      if (n % 7 === 0) firstBelow.set(cy * W.cw + cx, { ob, oa });
      n++;
    }
    // the first chunks were evicted long ago: drawn again, they match
    for (const [key, { ob, oa }] of firstBelow) {
      const cx = key % W.cw, cy = Math.floor(key / W.cw), c = W.chunk(cx, cy), na = px(c.above);
      if (!same(ob, px(c.below)) || !(na ? same(oa, na) : blank(oa))) badAgain++;
    }
    const cap = W.chunkCap;
    W.chunks.clear();
    return { n, bad, badAgain, lazy, maxSize, cap, again: firstBelow.size, total: all.length };
  });
  log('draw chunks', D.n, 'of', D.total, 'compared; without a top canvas', D.lazy, '; cache peak', D.maxSize, 'cap', D.cap, '; redrawn after eviction', D.again);
  check(D.bad === 0, `every drawn chunk equals the old two-canvas drawing (${D.bad} differ)`);
  check(D.badAgain === 0, `chunks evicted and drawn again are identical (${D.badAgain} differ)`);
  check(D.maxSize <= D.cap && D.cap === 96, `the canvas cache stays at most ${D.cap} (peak ${D.maxSize})`);
  check(D.lazy > 0, `${D.lazy} chunks need no top-layer canvas`);

  // 5. the game runs on: walking around Pallet Town with no error, the camera's chunks cached
  await idle(10);
  const p0 = await R('[P.tx, P.ty]');
  await hold('up', 60);
  const p1 = await R('[P.tx, P.ty]');
  await hold('right', 40); await hold('down', 60); await hold('left', 40);
  log('walked from', p0.join(','), 'to', p1.join(','), 'and around');
  check(p0[0] !== p1[0] || p0[1] !== p1[1], 'Steve walks');
  const E = await R('({ errs: (G.errors || []).length, size: W.chunks.size, state: h.state(), x: P.tx, y: P.ty })');
  log('after walking', JSON.stringify(E));
  check(E.errs === 0, `no G.errors (${E.errs})`);
  check(E.size > 0 && E.size <= 96, `the camera's chunks are cached (${E.size})`);
}
