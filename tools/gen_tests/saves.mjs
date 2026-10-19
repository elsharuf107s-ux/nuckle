// Stage 4b: saves in generated worlds (design 13, 4b; 2.7, 2.13, 8.1 to 8.4, 10.1).
//
//   node tools/headless.mjs tools/gen_tests/saves.mjs --params '?new&play&world=wild&wseed=1' --port 5630 --out <dir>
//
// In one browser context (so IndexedDB and localStorage carry across reloads):
//   1. a new Wild World: edits on unready chunks (a tile, a placed block, a cleared cell), edits on ready ones
//      (a tile, a block, a removed generated decoration), a bed in a far chunk set as the spawn bed, a portal in
//      another far chunk walked through into the Nether; SAVE (IndexedDB) and the world list entry;
//   2. reload (`?play`, the world list's last world): every override is back, the far chunks are not ready yet and
//      their overrides wait, then apply with the chunk; the portal return lands at the portal (with the fade's
//      wait); a death far from the bed respawns beside it and keeps the bed;
//   3. save far from the bed, reload: The End's exit portal takes him home to the bed in an unready chunk;
//   4. save time: 1,000 and 20,000 edits with 10,000 placed blocks, desktop and CPU-throttled 4x; the size;
//   5. the localStorage fallback writes and reads the same save;
//   6. a world made by a newer generator is refused (8.4): the line, then Classic boots.
export default async function (t) {
  const { page, R, run, tick, idle, shot, check, log } = t;
  const url = page.url().replace(/\?.*$/, '');
  const prep = async () => {
    await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
    await page.evaluate(() => { const h = window.__rs; h.pause(); h.seed(2026); if (h.rules) h.rules.encounters = false; });
  };
  const reload = async (q = '?play') => { await page.goto(url + q); await prep(); };
  const tp = (x, y) => run(async ([x, y]) => { const h = window.__rs; await h.ensure(x, y, 1); h.teleport(x, y); return [h.P.tx, h.P.ty]; }, [x, y]);
  const errs = () => R('(G.errors || []).length');

  // ---- 1. the new world
  const s0 = await run(() => {
    const h = window.__rs, W = h.world, sp = h.gen.plan().spawn, b = W.layout.border;
    return { wid: h.wid(), sp: [sp.px, sp.py], b, list: localStorage.getItem('poke-redstone-worlds') };
  });
  log('new world', JSON.stringify(s0));
  check(!!s0.wid && s0.list === null, 'a new Wild World has an id and no world list until it is saved');

  // places: unready cells ~ 260 cells east, the bed ~ 200 cells south, the portal ~ 200 cells north (all inside the
  // border; walkable dry cells found once their chunks exist)
  const plan = await run(async (sp) => {
    const h = window.__rs, W = h.world, PL = h.PL, b = W.layout.border;
    const clampX = (x) => Math.max(b.x0 + 8, Math.min(b.x1 - 8, x)), clampY = (y) => Math.max(b.y0 + 8, Math.min(b.y1 - 8, y));
    // an unready far cell for the overrides (never touched by the walk around)
    const fx = clampX(sp[0] + 260), fy = clampY(sp[1] + 40);
    const unready = [[fx, fy], [fx + 3, fy], [fx + 5, fy + 1]].map(([x, y]) => W.ready(x, y));
    // a dry walkable rectangle of w x h around (x, y), searched on a spiral of 4-cell steps
    const ok = (x, y) => PL.canEnter({ riding: null }, x, y) === 'walk' && !W.isWater(x, y) && !W.block(x, y) && !W.warpAt(x, y) && W.isFloor(x, y);
    const find = async (x0, y0, w, hh) => {
      for (let r = 0; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = clampX(x0 + dx * 4), y = clampY(y0 + dy * 4);
        await h.ensure(x, y, 1);
        let good = true;
        for (let yy = y - 1; yy <= y + hh && good; yy++) for (let xx = x - 1; xx <= x + w && good; xx++) good = ok(xx, yy);
        if (good) return [x, y];
      }
      return null;
    };
    return { far: [fx, fy], unready, bed: await find(sp[0] + 30, clampY(sp[1] + 200), 2, 3), portal: await find(sp[0] - 30, clampY(sp[1] - 200), 2, 3) };
  }, s0.sp);
  log('places', JSON.stringify(plan));
  check(plan.unready.every((r) => !r), 'the far override cells are in chunks not generated yet');
  check(!!plan.bed && !!plan.portal, 'dry ground found for the bed and the portal');

  // edits on the unready chunk (only recorded) and near the spawn (applied)
  const ed = await run(async ([far, sp]) => {
    const h = window.__rs, W = h.world;
    await h.ensure(sp[0], sp[1], 1);
    const T = W.tile(sp[0], sp[1]);                       // a ground tile of this world (the spawn's)
    const stone = W.entries.findIndex((e, i) => i > 0 && e[3] === 1 && i !== T);   // some solid entry, for a ready edit
    W.setTile(far[0], far[1], T);
    W.setBlock(far[0] + 3, far[1], { id: 'cobblestone' });
    W.setBlock(far[0] + 5, far[1] + 1, null);
    const farIdx = far[1] * W.W + far[0];
    const pendOk = W.edits.get(farIdx) === T && [...W.pend.values()].some((l) => l.includes(farIdx)) && !W.ready(far[0], far[1]);
    // ready: a tile two cells east of the spawn, a block three cells west, a generated decoration removed
    const rx = sp[0] + 2, ry = sp[1] - 2;
    W.setTile(rx, ry, stone);
    W.setBlock(sp[0] - 3, sp[1] + 1, { id: 'oak_planks' });
    let deco = null;
    for (let y = sp[1] - 40; y < sp[1] + 40 && !deco; y++) for (let x = sp[0] - 40; x < sp[0] + 40 && !deco; x++) if (W.ready(x, y) && W.decoAt(y * W.W + x)) deco = [x, y, W.block(x, y).id];
    if (deco) W.setBlock(deco[0], deco[1], null);
    return { T, stone, pendOk, ready: [rx, ry], deco, decoGone: deco ? W.block(deco[0], deco[1]) === null : false };
  }, [plan.far, s0.sp]);
  log('edits', JSON.stringify(ed));
  check(ed.pendOk, 'a tile set on an unready chunk is only recorded (edits + pend)');
  check(!!ed.deco && ed.decoGone, `a generated decoration was removed near the spawn (${ed.deco && ed.deco[2]})`);

  // the bed far away (head at bed, foot below), set as the spawn bed
  const bed = plan.bed;
  await run(([x, y]) => {
    const h = window.__rs, W = h.world;
    W.setBlock(x, y, { id: 'white_bed', orient: 'up', part: 'head', other: [x, y + 1] });
    W.setBlock(x, y + 1, { id: 'white_bed', orient: 'up', part: 'foot', other: [x, y] });
    h.G.spawnBed = [x, y];
  }, bed);

  // the portal far away, lit, and walked through (4 s inside)
  const pr = await run(([x, y]) => {
    const h = window.__rs;
    h.buildPortal(x, y, 2, 3);
    const r = h.lightPortal(x, y);
    return { lit: !!r && h.world.isPortal(x, y) };
  }, plan.portal);
  check(pr.lit, 'a portal lit in a far chunk');
  await tp(plan.portal[0], plan.portal[1] + 1);
  await run(() => { window.__rs.G.portalCool = false; });
  for (let i = 0; i < 150 && !(await R('W.inNether(P.tx, P.ty)')); i++) await tick();
  const inN = await R('({ n: W.inNether(P.tx, P.ty), lp: G.lastPortal, P: [P.tx, P.ty] })');
  log('through the portal', JSON.stringify(inN));
  check(inN.n && inN.lp && inN.lp.x === plan.portal[0], 'walked through the portal into the Nether; lastPortal is the far portal');

  // SAVE in the Nether
  const sv = await run(async () => { const h = window.__rs; const ok = await h.save(); return { ok, last: h.lastSave(), list: JSON.parse(localStorage.getItem('poke-redstone-worlds')), wid: h.wid() }; });
  log('save 1', JSON.stringify({ ok: sv.ok, last: sv.last, list: sv.list }));
  check(sv.ok && sv.last.store === 'idb', 'the save is written to IndexedDB');
  check(sv.list && sv.list.last === sv.wid && sv.list.worlds.length === 1 && sv.list.worlds[0].seed === (await R('h.gen.seed()')) && sv.list.worlds[0].gen === 1, 'the world list has the world, its seed and gen 1, as the last played');
  const before = await R(`({ saved: null, edits: W.edits.size, blocks: W.blocks.size, bover: W.bover.size, inv: JSON.stringify(G.inv.serialize()), time: G.time, P: [P.tx, P.ty] })`);

  // ---- 2. reload: the world list's last world
  await reload('?play');
  const ld = await run(([far, bed, lp, ed]) => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, i = far[1] * W.W + far[0];
    return {
      gen: !!W.layout.gen, wid: h.wid(), P: [P.tx, P.ty], nether: W.inNether(P.tx, P.ty), errs: (G.errors || []).length,
      edits: W.edits.size, blocks: W.blocks.size, bover: W.bover.size, inv: JSON.stringify(G.inv.serialize()), time: G.time,
      farReady: W.ready(far[0], far[1]), farEdit: W.edits.get(i), farPend: [...W.pend.values()].some((l) => l.includes(i)),
      farBlock: (W.block(far[0] + 3, far[1]) || {}).id || null, cleared: W.bover.get((far[1] + 1) * W.W + far[0] + 5),
      readyWait: !W.ready(ed.ready[0], ed.ready[1]),
      bedReady: W.ready(bed[0], bed[1]), bedBlock: (W.block(bed[0], bed[1]) || {}).id || null, spawnBed: G.spawnBed,
      lpReady: W.ready(lp[0], lp[1]), lastPortal: G.lastPortal,
    };
  }, [plan.far, bed, plan.portal, ed]);
  log('reloaded', JSON.stringify(ld));
  check(ld.gen && ld.wid === sv.wid, 'the reload boots the saved Wild World (the world list\'s last)');
  check(ld.nether && ld.P[0] === inN.P[0] && ld.P[1] === inN.P[1], 'Steve is where he saved, in the Nether');
  check(ld.edits === before.edits && ld.blocks === before.blocks && ld.bover === before.bover, `override counts equal (edits ${ld.edits}/${before.edits}, blocks ${ld.blocks}/${before.blocks}, removed ${ld.bover}/${before.bover})`);
  // (the time is the save's give or take the frames between the boot and the harness's pause: the loop's first
  // frame after a long boot can have a slightly negative dt, as in Classic, so it may also be a little earlier)
  const savedTime = await run(async () => { const h = window.__rs; return (await h.worlds().loadWorld(h.wid())).time; });
  log('time', savedTime, ld.time, before.time);
  check(ld.inv === before.inv && Math.abs(ld.time - savedTime) < 60, 'inventory and time of day restored');
  check(!ld.farReady && ld.farEdit === ed.T && ld.farPend, 'the unready chunk\'s tile override is back and waits for its chunk');
  check(ld.farBlock === 'cobblestone' && ld.cleared === 0, 'the unready chunk\'s placed block and cleared cell are back');
  // (the spawn's chunks were ready when edited; after the reload in the Nether they wait too, until made)
  const rd = await run(async ([ed, sp]) => { const h = window.__rs, W = h.world; await h.ensure(sp[0], sp[1], 1); return { tile: W.tile(ed.ready[0], ed.ready[1]), deco: ed.deco ? W.block(ed.deco[0], ed.deco[1]) : 'none', plank: (W.block(sp[0] - 3, sp[1] + 1) || {}).id || null }; }, [ed, s0.sp]);
  log('spawn edits', JSON.stringify(rd));
  check(ld.readyWait && rd.tile === ed.stone && rd.deco === null && rd.plank === 'oak_planks', 'the edits near the spawn are back once their chunk is made: the tile, the planks, and the removed decoration stays removed');
  check(!ld.bedReady && ld.bedBlock === 'white_bed' && ld.spawnBed && ld.spawnBed[0] === bed[0] && ld.spawnBed[1] === bed[1], 'the far bed (chunk not ready yet) and the spawn bed survive the reload');
  check(!ld.lpReady && ld.lastPortal && ld.lastPortal.x === plan.portal[0], 'lastPortal survives; its chunk is not ready yet');

  // the far chunk arrives: its overrides apply
  const fa = await run(async ([far, T]) => { const h = window.__rs, W = h.world; await h.ensure(far[0], far[1], 0); return { t: W.tile(far[0], far[1]) === T, b: (W.block(far[0] + 3, far[1]) || {}).id, pend: W.pend.size }; }, [plan.far, ed.T]);
  check(fa.t && fa.b === 'cobblestone', 'when the far chunk is made its tile override and block are in place');

  // portal return after the reload: through the Nether's portal, the fade waits for the far chunks
  await run(() => { const h = window.__rs; h.travel(false); });
  const wait1 = await R('h.state()');
  for (let i = 0; i < 200 && (await R("h.state() === 'genwait'")); i++) await tick();
  const back = await R('({ P: [P.tx, P.ty], st: h.state(), wait: h.lastWait(), portal: W.isPortal(P.tx, P.ty), ready: W.ready(P.tx, P.ty), errs: (G.errors || []).length })');
  log('portal return', wait1, JSON.stringify(back));
  check(wait1 === 'genwait', 'the return waits under the fade for the unready portal chunks');
  check(back.P[0] === inN.lp.x && back.P[1] === inN.lp.y && back.portal && back.st === 'play', 'the portal return after a reload lands at the portal');
  for (let i = 0; i < 8; i++) await tick();
  await shot('return_at_portal');

  // death far from the bed: the respawn waits, and he wakes beside it with the bed kept
  check(!(await R(`W.ready(${bed[0]}, ${bed[1]})`)), 'the bed\'s chunk is still not ready');
  await run(() => { const h = window.__rs; h.P.health = 0; h.P.dead = true; h.setState('dead'); h.respawn(); });
  for (let i = 0; i < 200 && (await R("h.state() === 'genwait'")); i++) await tick();
  const rs = await R('({ P: [P.tx, P.ty], st: h.state(), bed: G.spawnBed, wait: h.lastWait() })');
  log('respawn', JSON.stringify(rs));
  check(rs.bed && Math.abs(rs.P[0] - bed[0]) + Math.abs(rs.P[1] - bed[1]) <= 2 && rs.st === 'play', 'respawned beside the far bed, which is still the spawn bed');
  for (let i = 0; i < 8; i++) await tick();
  await shot('respawn_at_bed');

  // ---- 3. save away from the bed, reload, The End's exit portal home
  await tp(s0.sp[0], s0.sp[1]);
  await run(async () => { await window.__rs.save(); });
  await reload('?play');
  const ex0 = await R(`({ ready: W.ready(${bed[0]}, ${bed[1]}), bed: G.spawnBed })`);
  await run(() => window.__rs.exitEnd());
  for (let i = 0; i < 200 && (await R("h.state() === 'genwait'")); i++) await tick();
  const ex = await R('({ P: [P.tx, P.ty], st: h.state() })');
  log('end exit', JSON.stringify(ex0), JSON.stringify(ex));
  check(!ex0.ready && Math.abs(ex.P[0] - bed[0]) + Math.abs(ex.P[1] - bed[1]) <= 2, 'The End\'s exit after a reload goes home to the bed in an unready chunk');

  // ---- 4. save time and size
  const big = async (nEdits, nBlocks, throttle) => {
    const cdp = throttle ? await page.context().newCDPSession(page) : null;
    if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const r = await run(async ([nEdits, nBlocks]) => {
      const h = window.__rs, W = h.world, b = W.layout.border, sp = h.gen.plan().spawn;
      const T = W.tile(sp.px, sp.py);
      // edits spread over the world (most on unready chunks, as an evening's do not all stay loaded)
      const hs = (n, s) => { let v = Math.imul(n + 1, 0x9e3779b1) ^ Math.imul(s, 0x85ebca6b); v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d); return (v ^ (v >>> 13)) >>> 0; };
      let k = W.edits.size;
      for (let n = 0; k < nEdits && n < nEdits * 4; n++) { const x = b.x0 + (hs(n, 1) % (b.x1 - b.x0)), y = b.y0 + (hs(n, 2) % (b.y1 - b.y0)); if (!W.edits.has(y * W.W + x)) { W.setTile(x, y, T); k++; } }
      let m = W.blocks.size;
      for (let n = 0; m < nBlocks && n < nBlocks * 4; n++) { const x = b.x0 + (hs(n, 3) % (b.x1 - b.x0)), y = b.y0 + (hs(n, 4) % (b.y1 - b.y0)), i = y * W.W + x; if (!W.blocks.has(i)) { W.setBlock(x, y, n % 4 ? { id: 'cobblestone' } : { id: 'chest', items: [{ id: 'coal', n: 12 }, null, { id: 'torch', n: 32 }] }); m++; } }
      const out = [];
      for (let rep = 0; rep < 3; rep++) { const ok = await h.save(); out.push({ ok, ...h.lastSave() }); }
      await new Promise((res) => setTimeout(res, 2500));   // the idle size measure
      const ls = h.lastSave();
      return { edits: W.edits.size, blocks: W.blocks.size, runs: out.map((o) => [o.ok, +o.buildMs.toFixed(2), +o.encodeMs.toFixed(2), +o.putMs.toFixed(2), +o.frameMs.toFixed(2), +o.ms.toFixed(2)]), bytes: ls.bytes, sizeMs: ls.sizeMs, entry: JSON.parse(localStorage.getItem('poke-redstone-worlds')).worlds[0].bytes };
    }, [nEdits, nBlocks]);
    if (cdp) { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await cdp.detach(); }
    return r;
  };
  const sm = await big(1000, 300, false);
  log('save 1,000 edits, desktop', JSON.stringify(sm));
  const lgD = await big(20000, 10000, false);
  log('save 20,000 edits + 10,000 blocks, desktop', JSON.stringify(lgD));
  const lgT = await big(20000, 10000, true);
  log('save 20,000 edits + 10,000 blocks, 4x throttled', JSON.stringify(lgT));
  check(lgD.runs.every((r) => r[0]) && lgT.runs.every((r) => r[0]), 'the large saves succeed');
  // runs: [ok, build ms, encode ms, IndexedDB put ms, the longer of the two frames, total]
  const best = Math.min(...lgT.runs.map((r) => r[4])), tot = Math.min(...lgT.runs.map((r) => r[5]));
  check(best < 16, `a ${Math.round(lgT.bytes / 1024)} KB save: ${best.toFixed(1)} ms in its longer frame, ${tot.toFixed(1)} ms in all, throttled 4x (target under 16 a frame)`);
  check(lgT.entry === lgT.bytes, 'the world list shows the save\'s size');

  // ---- 5. the localStorage fallback
  const fb = await run(async () => {
    const h = window.__rs, WL = h.worlds(), id = h.wid();
    WL.useFallback(true);
    h.P.food = 13;
    const ok = await h.save();
    const st = h.lastSave().store, raw = localStorage.getItem('poke-redstone-w:' + id);
    const d = await WL.loadWorld(id);
    WL.useFallback(false);
    return { ok, st, has: !!raw, food: d && d.P.food, v: d && d.v };
  });
  log('fallback', JSON.stringify(fb));
  check(fb.ok && fb.st === 'ls' && fb.has && fb.food === 13 && fb.v === 2, 'the localStorage fallback writes and reads the v: 2 save');
  // back to IndexedDB (which removes the fallback copy)
  const ib = await run(async () => { const h = window.__rs; const ok = await h.save(); return { ok, st: h.lastSave().store, ls: !!localStorage.getItem('poke-redstone-w:' + h.wid()) }; });
  check(ib.ok && ib.st === 'idb' && !ib.ls, 'saving to IndexedDB again removes the fallback copy');
  check((await errs()) === 0, 'no G.errors in the generated world');

  // ---- 6. a newer generator's world is refused
  await run(async () => {
    const h = window.__rs, WL = h.worlds(), id = h.wid(), d = await WL.loadWorld(id);
    d.gen = 99; await WL.saveWorld(id, d); WL.touchEntry(id, { gen: 99 });
  });
  await page.goto(url + '?play');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: t.OUT + '/refused.png' });
  await prep();
  const rf = await R('({ gen: !!W.layout.gen, kind: W.layout.kind })');
  log('refused', JSON.stringify(rf));
  check(!rf.gen, 'a world made by a newer generator is refused and Classic boots instead');
}
