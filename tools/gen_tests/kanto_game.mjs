// Stage 6a: a Kanto World in the game (design 13, 6a; 2.3, 2.9, 3.12).
//
//   node tools/headless.mjs tools/gen_tests/kanto_game.mjs --params '?new&play&world=kanto&wseed=1' --port 5648 --out <dir>
//
//   1. the boot: a Kanto World on the plane, Kanto's block at (416 + kx, ky) from the plan, whose placement check passed;
//   2. the relocation (a deep copy): exactly 145 warp sources and 300 arrivals moved, the 37 dead warps still have null
//      ax, ay, to and adir (no warp gains an arrival), 37 outdoor maps and 11 towns moved, the stronghold's entrance on
//      Route 23's moved cell, A.world untouched;
//   3. Kanto's NPCs, Marts and wild tables unchanged: the same people (all in the room band), the same Mart lists, every
//      outdoor map at its moved rectangle with its own wild table and music, the area of its cells;
//   4. Kanto's cells equal Classic's except the listed border cells: with every data chunk over Kanto's box made, each
//      of Kanto's 105,978 cells has Classic's tile, zone, map and protection, except zone 1 cells within 3 cells of a
//      generated cell (the seam), and those are only tree and rock fill re-tiled, and (6b) the cells of the kept openings
//      (only Classic's trees and rock); no zone 2 cell is left in the box or
//      the overworld around it (no void); generated sea within 24 cells of Kanto's sea is Kanto's own open-sea entry;
//   5. warps work: Steve walks into his house in Pallet Town (a moved source) and out again (a moved arrival);
//   6. nearestMap: a border-fill cell resolves to a Kanto map, a generated cell to its biome map; no G.errors.
export default async function (t) {
  const { page, run, idle, shot, check, log } = t;
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
  await run(() => { const h = window.__rs; h.pause(); h.seed(5); if (h.rules) h.rules.encounters = false; h.G.rules.mobs = false; h.setTime(6000); });

  // ---------------------------------------------------------------- 1. the boot
  const b = await run(() => {
    const h = window.__rs, W = h.world, L = W.layout, plan = h.gen.plan();
    return { kind: L.kind, kx: L.kanto && L.kanto.x, ky: L.kanto && L.kanto.y, pk: plan.kanto, w: L.W, hh: L.H, errors: (h.G.errors || []).slice(0, 3) };
  });
  check(b.kind === 'kanto' && b.kx === 416 + b.pk.x && b.ky === b.pk.y && b.pk.sea >= 800 && !b.errors.length,
    `a Kanto World boots: Kanto's block at (${b.kx}, ${b.ky}) = (416 + ${b.pk.x}, ${b.pk.y}), the plan check ${b.pk.sea / 10}% of the outward sea faces the ocean ${b.errors.join(' ')}`);

  // ---------------------------------------------------------------- 2. the relocation
  const r = await run(() => {
    const h = window.__rs, W = h.world, M = W.meta, A0 = h.A.world, L = W.layout, dx = L.kanto.x, dy = L.kanto.y, f = [];
    const isOut = (y) => Number.isInteger(y) && y < 400;
    let src = 0, arr = 0, dead = 0, gained = 0, deadOk = 0;
    for (let i = 0; i < A0.warps.length; i++) {
      const a = A0.warps[i], m = M.warps[i];
      if (m === a) { f.push('warp ' + i + ' shared with A.world'); break; }
      if (isOut(a.y)) { src++; if (m.x !== a.x + dx || m.y !== a.y + dy) f.push('src ' + i); } else if (m.x !== a.x || m.y !== a.y) f.push('src moved ' + i);
      if (isOut(a.ay)) { arr++; if (m.ax !== a.ax + dx || m.ay !== a.ay + dy) f.push('arr ' + i); } else if (m.ax !== a.ax || m.ay !== a.ay) f.push('arr moved ' + i);
      if (a.ax === null && a.ay === null) {
        dead++;
        if (m.ax === null && m.ay === null && m.to === null && m.adir === null) deadOk++;
      }
      if ((a.ax === null) !== (m.ax === null)) gained++;
      if (m.to !== a.to || m.dest !== a.dest || m.map !== a.map) f.push('warp fields ' + i);
    }
    let maps = 0;
    for (let i = 0; i < A0.maps.length; i++) {
      const a = A0.maps[i], m = M.maps[i];
      if (a.kind === 'outdoor' && !a.room) { maps++; if (m.x !== a.x + dx || m.y !== a.y + dy || m.off) f.push('map ' + a.id); } else if (m.x !== a.x || m.y !== a.y) f.push('room map moved ' + a.id);
    }
    let towns = 0;
    for (let i = 0; i < A0.towns.length; i++) { const a = A0.towns[i], m = M.towns[i]; towns++; if (m.x !== a.x + dx || m.land.x !== a.land.x + dx || m.land.y !== a.land.y + dy) f.push('town ' + a.id); }
    const se = M.stronghold.entrance, ae = A0.stronghold.entrance;
    if (se.x !== ae.x + dx || se.y !== ae.y + dy) f.push('stronghold entrance');
    if (A0.warps[0].x !== 66 || A0.warps[0].ax !== 311 || ae.x !== 13 || ae.y !== 76) f.push('A.world changed');
    // indexed where they now are
    const w0 = M.warps[0];
    if (W.warpAt(w0.x, w0.y) !== w0 || W.warpAt(A0.warps[0].x, A0.warps[0].y)) f.push('warp index');
    return { src, arr, dead, deadOk, gained, maps, towns, rel: M.relocated, f: f.slice(0, 6), n: M.warps.length };
  });
  check(r.src === 145 && r.arr === 300 && r.dead === 37 && r.deadOk === 37 && r.gained === 0 && r.maps === 37 && r.towns === 11 && !r.f.length,
    `relocation: ${r.src} sources and ${r.arr} arrivals moved (layout counted ${r.rel.src} / ${r.rel.arr}), ${r.deadOk} of ${r.dead} dead warps keep null ax/ay/to/adir, ${r.gained} gained an arrival, ${r.maps} outdoor maps and ${r.towns} towns moved, the stronghold entrance moved, A.world untouched, warps indexed at their new cells ${r.f.join('; ')}`);

  // ---------------------------------------------------------------- 3. NPCs, Marts, wild tables
  const n = await run(() => {
    const h = window.__rs, W = h.world, M = W.meta, A0 = h.A.world, f = [];
    if (M.npcs !== A0.npcs || A0.npcs.some((p) => p.y < 400)) f.push('npcs');
    if (M.marts !== A0.marts) f.push('marts');
    let maps = 0;
    const wild = (h.A.dex && h.A.dex.wild) || {};
    for (let i = 0; i < A0.maps.length; i++) {
      const a = A0.maps[i];
      if (a.kind !== 'outdoor' || a.room) continue;
      const m = M.maps[i];
      // the map's cells: the middle of its rectangle, and every cell of Classic's area with this map
      const cx = m.x + (m.w >> 1), cy = m.y + (m.h >> 1), at = W.mapAt(cx, cy);
      if (at !== m || at.id !== a.id || (at.wild || at.id) !== (a.wild || a.id) || at.music !== a.music || at.name !== a.name) f.push('map ' + a.id);
      if (wild[a.wild || a.id] !== wild[at.wild || at.id]) f.push('wild ' + a.id);
      maps++;
    }
    const tables = A0.maps.filter((a) => a.kind === 'outdoor' && !a.room && wild[a.wild || a.id]).length;
    return { f: f.slice(0, 6), maps, tables, npcs: A0.npcs.length, marts: Object.keys(A0.marts).length };
  });
  check(!n.f.length && n.maps === 37, `Kanto unchanged: ${n.npcs} people (all in rooms), ${n.marts} Mart lists (the same objects), ${n.maps} outdoor maps at their moved rectangles with their names, music and wild tables (${n.tables} with land or water tables) ${n.f.join('; ')}`);

  // ---------------------------------------------------------------- 4. Kanto's cells, the seam, no void, Kanto's sea tile band
  const c = await run(async () => {
    const h = window.__rs, W = h.world, A = h.A, L = W.layout, K = L.kanto, ow = 408, oh = 400, f = [];
    const t0 = performance.now();
    for (let y = K.y - 32; y < K.y + oh + 32; y += 32) for (let x = K.x - 32; x < K.x + ow + 32; x += 32) if (W.inside(x, y) && W.isOutdoor(x, y)) W.ensureAround(x, y, 0, true);
    const ms = performance.now() - t0;
    const zv = (x, y) => (x < 0 || y < 0 || x >= ow || y >= oh ? 2 : A.zone[y * 408 + x]);
    const seam = (x, y) => { if (zv(x, y) !== 1) return false; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (zv(x + dx, y + dy) >= 2) return true; return false; };
    let cells = 0, diff = 0, diffSeam = 0, other = 0, notFill = 0, seamCells = 0, voids = 0, byMat = {}, diffOpen = 0, openBad = 0;
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const s = y * 408 + x, i = (K.y + y) * W.W + K.x + x;
      if (A.zone[s] >= 2) { if (W.zone[i] === 2) voids++; continue; }
      cells++;
      const sm = seam(x, y);
      if (sm) seamCells++;
      if (W.zone[i] !== A.zone[s] || W.area[i] !== A.area[s] || W.prot[i] !== A.prot[s]) other++;
      if (W.grid[i] !== A.grid[s]) {
        diff++;
        // (6b) a kept opening's re-tiled cells: Kanto's trees and rock only
        if (!sm && W.inOpening(K.x + x, K.y + y)) {
          diffOpen++;
          const om = A.world.entries[A.grid[s]][4];
          if (!(om === 'tree' || om === 'rock' || om === 'boulder' || /_ore$/.test(om))) openBad++;
          continue;
        }
        if (sm) diffSeam++;
        const t = A.grid[s];
        if (!(t === 113 || t === 20 || t === 21 || t === 28 || t === 29)) notFill++;
        const mat = A.world.entries[t][4]; byMat[mat] = (byMat[mat] || 0) + 1;
      }
    }
    // the overworld ring around the box: no zone 2 left
    for (let y = K.y - 32; y < K.y + oh + 32; y++) for (let x = K.x - 32; x < K.x + ow + 32; x++) if (W.inside(x, y) && W.isOutdoor(x, y) && W.zone[y * W.W + x] === 2) voids++;
    // generated sea within 24 cells of Kanto's sea: Kanto's open-sea entry (G.waterTile)
    let sea = 0, seaBad = 0;
    const kSea = (x, y) => x >= 0 && y >= 0 && x < ow && y < oh && A.zone[y * 408 + x] < 2 && A.world.entries[A.grid[y * 408 + x]][4] === 'water';
    for (let y = -24; y < oh + 24; y += 2) for (let x = -24; x < ow + 24; x += 2) {
      if (x >= 0 && y >= 0 && x < ow && y < oh && A.zone[y * 408 + x] < 2) continue;
      const X = K.x + x, Y = K.y + y;
      if (!W.inside(X, Y) || !W.isOutdoor(X, Y)) continue;
      const e = W.entries[W.grid[Y * W.W + X]];
      if (e[4] !== 'water' || e[2] === 0x16) continue;           // sea cells only (pond water is fresh)
      let near = false;
      for (let dy = -24; dy <= 24 && !near; dy += 4) for (let dx = -24; dx <= 24; dx += 4) if (kSea(x + dx, y + dy)) { near = true; break; }
      if (!near) continue;
      sea++;
      if (W.grid[Y * W.W + X] !== h.G.waterTile && !(W.entries[W.grid[Y * W.W + X]][6])) seaBad++;
    }
    return { cells, diff, diffSeam, other, notFill, seamCells, voids, ms, byMat, sea, seaBad, wt: h.G.waterTile, diffOpen, openBad, nOpen: (W.meta.openings || []).length, errors: (h.G.errors || []).slice(0, 3) };
  });
  check(c.cells === 105978 && c.diff === c.diffSeam + c.diffOpen && c.notFill === 0 && c.other === 0 && c.openBad === 0,
    `Kanto's ${c.cells} cells equal Classic's except ${c.diffSeam} re-tiled seam cells (all of them zone 1 fill within 3 cells of the seam, ${c.seamCells} such cells; by material ${JSON.stringify(c.byMat)}) and (6b) ${c.diffOpen} cells of its ${c.nOpen} kept openings (${c.openBad} not tree or rock in Classic); zone, map and protection equal everywhere (${c.other} differ); chunks over the box made in ${Math.round(c.ms)} ms`);
  check(c.voids === 0, `no void: ${c.voids} zone 2 cells left in Kanto's box and the ring of chunks around it`);
  check(c.sea > 100 && c.seaBad === 0, `Kanto's sea tile band: ${c.sea} generated sea cells within 24 of Kanto's sea (sampled every 2nd cell) are Kanto's open-sea entry ${c.wt} (${c.seaBad} not)`);

  // ---------------------------------------------------------------- 5. a moved warp, walked
  const home = await run(() => {
    const h = window.__rs, W = h.world, w0 = W.meta.warps[0];
    h.teleport(w0.x, w0.y + 1, 'up');
    return { x: w0.x, y: w0.y, ax: w0.ax, ay: w0.ay, dest: w0.dest };
  });
  await idle(4);
  await shot('kanto_pallet');
  for (let i = 0; i < 90; i++) { await t.tick({ hold: 'up', press: i === 0 ? 'up' : undefined }); if (await t.R("h.state() === 'play' && W.roomAt(P.tx, P.ty)")) break; }
  await idle(20);
  const inHouse = await run(() => { const h = window.__rs; return { x: h.P.tx, y: h.P.ty, map: h.world.mapAt(h.P.tx, h.P.ty) && h.world.mapAt(h.P.tx, h.P.ty).id }; });
  check(inHouse.x === home.ax && inHouse.y === home.ay && inHouse.map === home.dest, `Steve walks into his house from Pallet Town (${home.x}, ${home.y}) and arrives at (${inHouse.x}, ${inHouse.y}) in ${inHouse.map}`);
  // out through the mat: the arrival outside is a moved one
  const back = await run(() => {
    const h = window.__rs, W = h.world, A0 = h.A.world;
    const k = A0.warps.findIndex((w) => w.map === 'MAP_PALLET_TOWN_PLAYERS_HOUSE_1F' && Number.isInteger(w.ay) && w.ay < 400);
    const w = W.meta.warps[k];
    h.teleport(w.x, w.y - 1, 'down');
    return { k, x: w.x, y: w.y, ax: w.ax, ay: w.ay, ax0: A0.warps[k].ax, ay0: A0.warps[k].ay, amove: w.amove };
  });
  await idle(4);
  for (let i = 0; i < 90; i++) { await t.tick({ hold: 'down', press: i === 0 ? 'down' : undefined }); if (await t.R("h.state() === 'play' && !W.roomAt(P.tx, P.ty)")) break; }
  await idle(30);
  const outP = await run(() => { const h = window.__rs; return { x: h.P.tx, y: h.P.ty, map: h.world.mapAt(h.P.tx, h.P.ty) && h.world.mapAt(h.P.tx, h.P.ty).id }; });
  const expY = back.amove === 'walk' ? back.ay + 1 : back.ay;
  check(outP.x === back.ax && outP.y === expY && outP.map === 'MAP_PALLET_TOWN', `and out again through warp ${back.k}: arrives at (${outP.x}, ${outP.y}) in ${outP.map}, the moved arrival (${back.ax}, ${back.ay}) of Classic's (${back.ax0}, ${back.ay0})`);
  await shot('kanto_pallet_out');

  // ---------------------------------------------------------------- 6. nearestMap and the seam's look
  const nm = await run(() => {
    const h = window.__rs, W = h.world, K = W.layout.kanto, A = h.A;
    let fill = null, gen = null;
    for (let y = 0; y < 400 && !fill; y += 3) for (let x = 0; x < 408; x += 3) if (A.zone[y * 408 + x] === 1) { fill = [K.x + x, K.y + y]; break; }
    for (let y = 0; y < 400 && !gen; y += 3) for (let x = 0; x < 408; x += 3) if (A.zone[y * 408 + x] === 2 && W.zone[(K.y + y) * W.W + K.x + x] === 0) { gen = [K.x + x, K.y + y]; break; }
    const a = W.nearestMap(fill[0], fill[1]), b = W.nearestMap(gen[0], gen[1]);
    return { fill, gen, a: a && a.id, aGen: !!(a && a.gen), b: b && b.id, bGen: !!(b && b.gen), rk: W.regionKey(gen[0], gen[1]) };
  });
  check(nm.a && !nm.aGen && /^MAP_/.test(nm.a) && nm.bGen && nm.rk === 'WILD', `nearestMap: Kanto's border fill at ${nm.fill} resolves to ${nm.a}, a generated cell in a hole at ${nm.gen} to ${nm.b} (place ${nm.rk})`);
  // a look at seams: a tree wall, the bay, the south sea
  for (const [name, dx, dy] of [['seam_tree', 40, 140], ['seam_bay', 200, 230], ['seam_south', 150, 392]]) {
    await run(({ dx, dy }) => { const h = window.__rs, K = h.world.layout.kanto; h.teleport(K.x + dx, K.y + dy, 'down'); }, { dx, dy });
    await idle(6);
    await shot(name);
  }
  const errs = await run(() => (window.__rs.G.errors || []).slice(0, 5));
  check(!errs.length, `no G.errors ${errs.join(' | ')}`);
  log('done');
}
