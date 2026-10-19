// Stage 5c in the game: animals by biome, the population bitset, parking with item age and the ticking index
// (design 2.11, 2.12, 3.17, 8.3; stage 5c).
//
//   node tools/headless.mjs tools/gen_tests/animals.mjs --params '?new&play&world=wild&wseed=1' --port 5646 --out <dir>
//
// Checks: herds come with the chunks once (bitset), are persistent, stand on grass (snow in snowy biomes) of a biome
// whose list has their kind, are deterministic; a 400-chunk tour (one chunk a hop, every hop the 5 x 5 around made and
// one second of play) keeps G.ents under 60; the herds come back on return; a dropped item parked past 5 minutes of
// play is gone on return, one parked for less comes back with its age; the save writes active and parked entities and
// the bitset, and the reload restores them without spawning the herds again; the ticking index holds exactly the
// ticking blocks and ticks only those within 96 cells; no G.errors. Screenshot (looked at by hand): a herd.
export default async function (t) {
  const { page, R, run, shot, check, log } = t;
  const url = page.url().replace(/\?.*$/, '');
  const prep = async () => {
    await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
    await page.evaluate(() => { const h = window.__rs; h.pause(); h.seed(2026); if (h.rules) h.rules.encounters = false; h.setTime(6000); });
  };
  await prep();
  const HERDS = { PLAINS: ['cow', 'sheep', 'pig', 'chicken'], FOREST: ['pig', 'chicken', 'sheep'], BIRCH_FOREST: ['pig', 'chicken', 'sheep'], DARK_FOREST: ['pig', 'chicken', 'sheep'],
    TAIGA: ['sheep', 'pig'], SNOWY_TAIGA: ['sheep'], SNOWY_PLAINS: ['sheep'], SAVANNA: ['cow', 'sheep'], JUNGLE: ['chicken', 'pig'] };

  // ---- 1. the herds of the spawn area
  const s1 = await run((HERDS) => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P;
    const animals = G.ents.filter((e) => e.type === 'mob' && ['cow', 'sheep', 'pig', 'chicken'].includes(e.kind));
    const bad = [];
    for (const a of animals) {
      const m = W.biomeAt(a.tx, a.ty), key = m ? m.id.replace(/^GEN_/, '') : null, soil = W.soilAt(a.tx, a.ty);
      // (the herd's kind is the biome's at its centre; a member may stand over a biome edge, 3 cells at most)
      let okBiome = false;
      for (let dy = -3; dy <= 3 && !okBiome; dy++) for (let dx = -3; dx <= 3 && !okBiome; dx++) { const mm = W.biomeAt(a.tx + dx, a.ty + dy), k = mm ? mm.id.replace(/^GEN_/, '') : null; if (k && HERDS[k] && HERDS[k].includes(a.kind)) okBiome = true; }
      if (!a.persistent || !okBiome || !(soil === 'grass' || soil === 'snow') || W.tallGrass(a.tx, a.ty) || W.solid(a.tx, a.ty)) bad.push([a.kind, a.tx, a.ty, key, soil, a.persistent]);
    }
    // determinism: the herd function twice over 300 chunks, without the occupancy test
    let same = true, herds = 0;
    for (let ck = 0; ck < W.cstate.length; ck += 7) { if (ck % 63 < 13) continue; const a = JSON.stringify(W.stream.herdsOf(ck)), b = JSON.stringify(W.stream.herdsOf(ck)); if (a !== b) same = false; if (W.cstate[ck] === 2 && a !== '[]') herds++; }
    return { popOn: h.gen.popOn(), pop: h.gen.pop(), ready: h.gen.ready().filter((k) => k % 63 >= 13).length, animals: animals.length, bad, same, ents: G.ents.length, P: [P.tx, P.ty], errs: (G.errors || []).length };
  }, HERDS);
  log('spawn area', JSON.stringify(s1));
  check(s1.popOn, 'population is on in a new Wild World');
  check(s1.pop === s1.ready, `every ready overworld chunk is marked populated (${s1.pop} of ${s1.ready})`);
  check(s1.bad.length === 0, `every animal is persistent, on open grass (or snow), with its biome's kind (${s1.animals} animals; bad ${JSON.stringify(s1.bad.slice(0, 4))})`);
  check(s1.same, 'the herd of a chunk is a pure function of the seed and the chunk');

  // a herd on screen for the eye
  const herd = await run(async () => {
    const h = window.__rs, G = h.G, P = h.P;
    const a = G.ents.filter((e) => e.type === 'mob' && e.persistent).sort((p, q) => Math.hypot(p.tx - P.tx, p.ty - P.ty) - Math.hypot(q.tx - P.tx, q.ty - P.ty))[0];
    if (!a) return null;
    await h.ensure(a.tx, a.ty + 3, 1); h.teleport(a.tx, a.ty + 3, 'up'); h.step(2);
    return [a.kind, a.tx, a.ty];
  });
  log('herd shot at', JSON.stringify(herd));
  if (herd) await shot('5c-herd');

  // ---- 2. the tour: 400 chunks, one chunk a hop in a serpentine, one second of play each
  const tour = await run(async () => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, L = W.layout;
    const sp = h.gen.plan().spawn, OCX = 13;
    const scx = (sp.px >> 5) - OCX, scy = sp.py >> 5;
    const bx = Math.max(1, Math.min(48 - 20, scx - 10)), by = Math.max(1, Math.min(48 - 20, scy - 10));
    const home = { x: P.tx, y: P.ty, near: G.ents.filter((e) => e.type === 'mob' && e.persistent && Math.max(Math.abs(e.tx - P.tx), Math.abs(e.ty - P.ty)) < 40) };
    let maxEnts = 0, maxMobs = 0, maxItems = 0, sum = 0, hops = 0, slow = 0, parkMax = 0;
    const seen = new Set();
    const s0 = { ...W.stream.stats };
    for (let j = 0; j < 20; j++) {
      for (let k = 0; k < 20; k++) {
        const i = j % 2 ? 19 - k : k, cx = bx + i, cy = by + j;
        const x = Math.max(L.border.x0 + 2, Math.min(L.border.x1 - 2, (cx + OCX) * 32 + 16)), y = Math.max(L.border.y0 + 2, Math.min(L.border.y1 - 2, cy * 32 + 16));
        await h.ensure(x, y, 2);
        h.teleport(x, y, j % 2 ? 'left' : 'right');
        h.step(20, 1 / 20);   // one second of play (the parking pass runs in it)
        const tp = performance.now(); h.gen.park(); parkMax = Math.max(parkMax, performance.now() - tp);
        seen.add(cy * 63 + cx + OCX);
        const n = G.ents.length, mobs = G.ents.filter((e) => e.type === 'mob').length;
        maxEnts = Math.max(maxEnts, n); maxMobs = Math.max(maxMobs, mobs); maxItems = Math.max(maxItems, G.ents.filter((e) => e.type === 'item').length);
        sum += n; hops++;
        if (hops % 40 === 0) await new Promise((r) => setTimeout(r, 1));
      }
    }
    const st = W.stream.stats;
    const out = { hops, chunks: seen.size, maxEnts, maxMobs, maxItems, mean: +(sum / hops).toFixed(1), parked: h.gen.parked(), parkedChunks: W.parked.size, pop: h.gen.pop(),
      herds: (st.herds || 0) - (s0.herds || 0), animals: (st.animals || 0) - (s0.animals || 0), parkMax: +parkMax.toFixed(3), ents: G.ents.length, errs: (G.errors || []).length };
    // home again: the spawn area's herds are the same objects, back from parking
    await h.ensure(home.x, home.y, 2); h.teleport(home.x, home.y); h.step(20, 1 / 20); h.gen.park();
    out.homeBack = home.near.filter((e) => G.ents.includes(e)).length; out.homeWas = home.near.length;
    out.parkedAfter = h.gen.parked();
    const t0 = performance.now(); for (let k = 0; k < 20; k++) h.gen.park(); out.parkMs = +((performance.now() - t0) / 20).toFixed(3);
    return out;
  });
  log('tour', JSON.stringify(tour));
  check(tour.chunks === 400, `the tour visited 400 chunks (${tour.chunks})`);
  check(tour.maxEnts < 60, `G.ents stays under 60 while touring (max ${tour.maxEnts}, mobs ${tour.maxMobs}, mean ${tour.mean})`);
  check(tour.animals > 100 && tour.parked > 100, `herds were made on the way and parked behind (${tour.herds} herds, ${tour.animals} animals, ${tour.parked} parked in ${tour.parkedChunks} chunks)`);
  check(tour.pop >= 400, `the bitset grew with the tour (${tour.pop} chunks)`);
  check(tour.homeWas > 0 && tour.homeBack === tour.homeWas, `the spawn area's animals are back from parking (${tour.homeBack} of ${tour.homeWas})`);
  check(tour.parkMs < 1, `a parking pass is cheap (${tour.parkMs} ms with ${tour.parkedAfter} parked; worst in the tour ${tour.parkMax} ms)`);
  check(tour.errs === 0, 'no G.errors on the tour');

  // ---- 3. items keep their age while parked
  const items = await run(async () => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, E = h.E;
    const x = P.tx, y = P.ty + 2;
    const old = E.dropItem('cobblestone', 3, x * 16, y * 16, {}, { delay: 99 }), young = E.dropItem('oak_log', 2, (x + 1) * 16, y * 16, {}, { delay: 99 });
    old.age = 0; young.age = 0;
    const far = [x + 32 * 6, y];
    await h.ensure(far[0], far[1], 1); h.teleport(far[0], far[1]); h.gen.park();
    const parkedOld = !G.ents.includes(old) && [...W.parked.values()].some((l) => l.includes(old)), parkedYoung = [...W.parked.values()].some((l) => l.includes(young));
    // 4 minutes of play pass (the play clock): the young item was parked at 0, the old one at -2 minutes
    old.parkT -= 120;
    G.playTime += 240;
    h.teleport(x, y - 2); h.gen.park();
    const r = { parkedOld, parkedYoung, oldBack: G.ents.includes(old), youngBack: G.ents.includes(young), youngAge: young.age, expired: W.stream.stats.expired || 0 };
    // a saved item carries its spawn time: written only while younger than 5 minutes
    return r;
  });
  log('items', JSON.stringify(items));
  check(items.parkedOld && items.parkedYoung, 'two dropped items are parked when Steve goes 6 chunks away');
  check(!items.oldBack && items.expired >= 1, 'the item parked past 5 minutes of play is gone on return');
  check(items.youngBack && items.youngAge > 239.9 && items.youngAge < 300, `the item parked 4 minutes comes back with its age (${items.youngAge.toFixed(1)} s)`);

  // ---- 4. the ticking index
  const tick = await run(async () => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P;
    const free = (x0, y0) => { for (let r = 0; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = x0 + dx, y = y0 + dy; if (W.isFloor(x, y) && !W.block(x, y) && !W.solid(x, y)) return [x, y]; } return null; };
    const a = free(P.tx + 3, P.ty), fx = P.tx + 200, b0 = await h.ensure(fx, P.ty, 0), b = free(fx, P.ty);
    W.setBlock(a[0], a[1], { id: 'birch_sapling', t: 0 });
    W.setBlock(b[0], b[1], { id: 'birch_sapling', t: 0 });
    W.setBlock(a[0] + 1, a[1], { id: 'cobblestone' });
    const idx = W.ticking, inBlocks = [...W.blocks].filter(([, bl]) => bl.crop || /_sapling$/.test(bl.id) || ['fire', 'furnace', 'campfire', 'nether_wart'].includes(bl.id)).map(([i]) => i);
    const exact = idx.size === inBlocks.length && inBlocks.every((i) => idx.has(i));
    const near = h.gen.tickingNear();
    h.step(40, 1 / 20);
    const ta = W.blocks.get(a[1] * W.W + a[0]).t, tb = W.blocks.get(b[1] * W.W + b[0]).t;
    W.setBlock(b[0], b[1], null);
    const gone = !W.ticking.has(b[1] * W.W + b[0]);
    W.setBlock(a[0], a[1], null); W.setBlock(a[0] + 1, a[1], null);
    return { exact, size: idx.size, near, ta, tb, gone, errs: (G.errors || []).length };
  });
  log('ticking', JSON.stringify(tick));
  check(tick.exact, `the ticking index holds exactly the ticking blocks (${tick.size})`);
  check(tick.ta > 0 && !tick.tb, `a sapling beside Steve ticks (t ${tick.ta}), one 200 cells away does not (t ${tick.tb})`);
  check(tick.gone, 'a removed sapling leaves the index');

  // ---- 5. save and reload: active and parked entities, the bitset, no second population
  const sv = await run(async () => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, E = h.E;
    // an item and a boat here, then the save
    E.dropItem('oak_planks', 5, (P.tx + 4) * 16, P.ty * 16, {}, { delay: 0 });   // (out of his reach while the reloaded page runs a few frames)
    const ok = await h.save();
    const mobs = G.ents.filter((e) => e.type === 'mob' && e.persistent && !e.dying).length;
    const parkedMobs = [...W.parked.values()].flat().filter((e) => e.type === 'mob').length;
    return { ok, pop: h.gen.pop(), parked: h.gen.parked(), parkedMobs, active: mobs, items: G.ents.filter((e) => e.type === 'item').length, P: [P.tx, P.ty], wid: h.wid(), time: G.playTime };
  });
  log('saved', JSON.stringify(sv));
  check(sv.ok, 'the world saves');
  const saved = await run(async (wid) => { const d = await window.__rs.worlds().loadWorld(wid); return { m: d.ents.m.length, i: d.ents.i.length, b: d.ents.b.length, pop: d.world.pop.length, born: d.ents.i.map((r) => r[5]) }; }, sv.wid);
  log('save ents', JSON.stringify(saved));
  check(saved.m === sv.active + sv.parkedMobs && sv.parkedMobs > 0, `the save has the active and the parked mobs (${saved.m} written = ${sv.active} active + ${sv.parkedMobs} parked)`);
  await page.goto(url + '?play'); await prep();
  const ld = await run(() => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P;
    return { gen: !!h.gen, wid: h.wid(), pop: h.gen.pop(), parked: h.gen.parked(), parkedMobs: [...W.parked.values()].flat().filter((e) => e.type === 'mob').length, active: G.ents.filter((e) => e.type === 'mob' && e.persistent).length, items: G.ents.filter((e) => e.type === 'item').length,
      animals: W.stream.stats.animals || 0, P: [P.tx, P.ty], errs: (G.errors || []).length, time: G.playTime };
  });
  log('reloaded', JSON.stringify(ld));
  check(ld.wid === sv.wid && ld.P[0] === sv.P[0] && ld.P[1] === sv.P[1], 'the reload boots the saved world where Steve was');
  check(ld.pop === sv.pop, `the populated bitset is restored (${ld.pop})`);
  check(ld.animals === 0, `no herd spawned again after the reload (${ld.animals})`);
  check(ld.active + ld.parkedMobs === saved.m && ld.parkedMobs > 0, `every saved mob is back, the far ones parked at once (${ld.active} active + ${ld.parkedMobs} parked = ${saved.m})`);
  check(ld.items === sv.items, `the dropped items near Steve are back (${ld.items})`);
  check(ld.errs === 0, 'no G.errors after the reload');
}
