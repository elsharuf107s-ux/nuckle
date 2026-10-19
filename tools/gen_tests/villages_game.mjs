// Stage 7a: villages in the game (design 13, 7a; 5.1, 5.2, 2.12).
//
//   node tools/headless.mjs tools/gen_tests/villages_game.mjs --params '?new&play&world=wild&wseed=1' --port 5450 --out <dir>
//
//   1. every house of the plan has its interior written (its room on its map), the plan's warps (caves, then house doors
//      and mats) appended and indexed;
//   2. the village nearest the spawn, its chunks made: house walls protected as structures, the door an opening and a
//      warp, the well's cobblestone ring round water, outdoor job sites and the bell as blocks, lamps lit, a farm cell's
//      wheat following the time (a later time gives a later stage);
//   3. every door of that village walks to the plaza over the game's own collision (blocks included);
//   4. Steve walks up into a door and arrives on the interior's mat (VILLAGE), finds its beds, its chest with loot and an
//      indoor job site where the house has one, and walks out again onto the door's front cell;
//   5. saves: furniture as generated is not saved; a chest a player filled, and a bed taken, are; no G.errors.
export default async function (t) {
  const { page, R, run, idle, tick, shot, check } = t;
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
  await run(() => { const h = window.__rs; h.pause(); h.seed(5); if (h.rules) h.rules.encounters = false; h.G.rules.mobs = false; h.setTime(6000); });

  // ---------------------------------------------------------------- 1. interiors and warps
  const s1 = await run(() => {
    const h = window.__rs, W = h.world, plan = h.gen.plan(), out = { fails: [] };
    const houses = plan.villages.reduce((s, v) => s + v.houses.length, 0);
    let rooms = 0;
    for (const r of W.roomInfo.values()) if (r.house) {
      rooms++;
      const m = W.mapAt(r.x + 1, r.y + 2);
      if (!m || !m.room || m.kind !== 'indoor' || m.name !== 'VILLAGE') { out.fails.push('room not on its VILLAGE map'); break; }
    }
    if (rooms !== houses) out.fails.push(`interiors ${rooms} of ${houses}`);
    if (W.warps.length !== 701 + plan.warps.length) out.fails.push(`warps ${W.warps.length}, want ${701 + plan.warps.length}`);
    for (let k = 0; k < plan.warps.length; k++) {
      const w = W.warps[701 + k];
      if (!w || W.warpAt(w.x, w.y) !== w) { out.fails.push(`warp ${701 + k} not indexed`); break; }
    }
    return { ...out, villages: plan.villages.length, houses, rooms, ms: W.houseMs };
  });
  check(!s1.fails.length, `${s1.villages} villages, ${s1.houses} houses: ${s1.rooms} interiors written in ${s1.ms && s1.ms.toFixed(1)} ms, every plan warp appended and indexed ${s1.fails.join('; ')}`);

  // ---------------------------------------------------------------- 2. the nearest village outdoors
  const v = await run(async () => {
    const h = window.__rs, W = h.world, plan = h.gen.plan(), sp = plan.spawn;
    let best = null, bd = 1e9;
    for (const v of plan.villages) { const d = Math.abs(v.x - sp.x) + Math.abs(v.y - sp.y); if (d < bd && v.farms.length) { bd = d; best = v; } }
    for (let y = best.y0; y < best.y0 + best.h; y += 16) for (let x = best.x0; x < best.x0 + best.w; x += 16) await W.ensureAround(416 + x, y, 1);
    await W.ensureAround(416 + best.x0 + best.w - 1, best.y0 + best.h - 1, 1);
    return best;
  });
  const out2 = await run((v) => {
    const h = window.__rs, W = h.world, fails = [], X = (x) => 416 + x;
    for (const hs of v.houses) {
      if (W.protAt(X(hs.x), hs.y + 1) !== 1) fails.push(`house ${hs.id} wall not a structure`);
      if (W.protAt(X(hs.door[0]), hs.door[1]) !== 3 || !W.warpAt(X(hs.door[0]), hs.door[1])) fails.push(`house ${hs.id} door not an opening warp`);
      if (W.entries[W.tile(X(hs.door[0]), hs.door[1])][2] !== 105) fails.push(`house ${hs.id} door behaviour`);
      if (hs.job) { const b = W.block(X(hs.job[0]), hs.job[1]); if (!b || !b.gen) fails.push(`house ${hs.id} job site block ${b && b.id}`); }
    }
    const ring = W.block(X(v.well[0]), v.well[1]), water = W.isWater(X(v.well[0] + 1), v.well[1] + 1);
    if (!ring || !/cobblestone|sandstone/.test(ring.id) || !water) fails.push('well');
    if (v.bell && (W.block(X(v.bell[0]), v.bell[1]) || {}).id !== 'bell') fails.push('bell');
    const lit = v.lamps.filter(([x, y]) => (W.block(X(x), y) || {}).id === 'torch' && W.tileLights.get(y * W.W + X(x)) === 14).length;
    if (lit !== v.lamps.length) fails.push(`lamps lit ${lit} of ${v.lamps.length}`);
    const f = v.farms[0], fx = X(f.x + 2), fy = f.y;
    const s0 = W.block(fx, fy).crop.stage;
    h.G.day += 1;
    const s1 = W.block(fx, fy).crop.stage;
    h.G.day -= 1;
    const farmOk = W.block(fx, fy).id === 'farmland' && W.isWater(fx, f.y + f.water) && !W.solid(fx, fy);
    return { fails, s0, s1, farmOk, id: v.id, style: v.style, houses: v.houses.length, lamps: v.lamps.length };
  }, v);
  check(!out2.fails.length && out2.farmOk && (out2.s1 > out2.s0 || out2.s0 === 7), `village ${out2.id} (${out2.style}, ${out2.houses} houses): walls structures, doors opening warps, job sites, well, bell, ${out2.lamps} lamps lit; farm wheat stage ${out2.s0} then ${out2.s1} a day later ${out2.fails.join('; ')}`);
  await run((v) => { window.__rs.teleport(416 + v.x, v.y + 3, 'down'); }, v);
  await idle(20);
  await shot('7a-plaza');

  // ---------------------------------------------------------------- 3. every door walks to the plaza (the game's collision)
  const walk = await run((v) => {
    const W = window.__rs.world, X = (x) => 416 + x, seen = new Set(), q = [];
    const start = [X(v.plaza[0] + 4), v.plaza[1] + 6];
    q.push(start); seen.add(start[1] * W.W + start[0]);
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = ny * W.W + nx;
        if (seen.has(k) || nx < X(v.x0 - 8) || nx > X(v.x0 + v.w + 8) || ny < v.y0 - 8 || ny > v.y0 + v.h + 8 || W.solid(nx, ny) || W.isWater(nx, ny)) continue;
        seen.add(k); q.push([nx, ny]);
      }
    }
    const bad = v.houses.filter((hs) => !seen.has((hs.door[1] + 1) * W.W + X(hs.door[0]))).map((hs) => hs.id);
    return { bad, n: v.houses.length };
  }, v);
  check(!walk.bad.length, `all ${walk.n} doors walk to the plaza over the game's collision (unreached: ${walk.bad.join(',')})`);

  // ---------------------------------------------------------------- 4. in through a door and out again
  const hs = v.houses.find((q) => q.jobIn) || v.houses[0];
  await run((d) => { window.__rs.teleport(416 + d[0], d[1] + 1, 'up'); }, hs.door);
  await idle(4);
  await shot('7a-door');
  for (let i = 0; i < 90; i++) { await tick({ hold: 'up', press: i === 0 ? 'up' : undefined }); if (await R("h.state() === 'play' && W.roomAt(P.tx, P.ty)")) break; }
  await idle(30);
  const inside = await run((a) => {
    const h = window.__rs, W = h.world, P = h.P, m = W.roomAt(P.tx, P.ty), r = W.roomInfo.get(`GEN_HOUSE_${a.v}_${a.hid}`);
    const blocks = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const b = W.blocks.get(y * W.W + x); if (b) blocks.push(b.id); }
    const chest = [...Array(r.w * r.h).keys()].map((k) => W.blocks.get((r.y + ((k / r.w) | 0)) * W.W + r.x + (k % r.w))).find((b) => b && b.id === 'chest');
    return { id: m && m.id, name: m && m.name, kind: m && m.kind, x: P.tx - r.x, y: P.ty - r.y, blocks, loot: chest ? chest.slots.filter(Boolean).map((s) => s.id + ' x' + s.n) : null, state: h.state() };
  }, { v: v.id, hid: hs.id });
  const beds = inside.blocks.filter((b) => b === 'white_bed').length;
  check(inside.id === `GEN_HOUSE_${v.id}_${hs.id}` && inside.kind === 'indoor' && inside.name === 'VILLAGE' && beds === 2 * hs.beds && inside.loot && inside.loot.length
    && (!hs.jobIn || inside.blocks.length === 2 * hs.beds + 2),
    `walked in: ${JSON.stringify(inside)} (beds ${hs.beds}, indoor job ${hs.jobIn})`);
  await shot('7a-interior');
  for (let i = 0; i < 90; i++) { await tick({ hold: 'down', press: i === 0 ? 'down' : undefined }); if (await R("h.state() === 'play' && !W.roomAt(P.tx, P.ty)")) break; }
  await idle(20);
  const back = await R('({ x: P.tx - 416, y: P.ty })');
  check(back.x === hs.door[0] && back.y === hs.door[1] + 1, `walked out onto the door's front ${JSON.stringify(back)} (door ${hs.door})`);
  await shot('7a-out');

  // ---------------------------------------------------------------- 5. saves
  const sv = await run((a) => {
    const W = window.__rs.world, r = W.roomInfo.get(`GEN_HOUSE_${a.v}_${a.hid}`);
    const cells = (d) => { const b = JSON.parse(d.b); let i = 0; return b.map(([di, blk]) => { i += di; return [i, blk]; }); };
    const inRoom = (i) => { const x = i % W.W, y = (i / W.W) | 0; return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h; };
    const d0 = W.serialize2(), n0 = cells(d0).filter(([i]) => inRoom(i)).length;
    let chestI = -1, bedI = -1;
    for (const [i, b] of W.blocks) if (inRoom(i)) { if (b.id === 'chest') chestI = i; if (b.id === 'white_bed' && b.part === 'head') bedI = i; }
    W.blocks.get(chestI).slots[26] = { id: 'diamond', n: 1 };
    const bed = W.blocks.get(bedI);
    W.setBlock(bed.other[0], bed.other[1], null); W.setBlock(bedI % W.W, (bedI / W.W) | 0, null);
    const c1 = cells(W.serialize2()).filter(([i]) => inRoom(i));
    const ov = W.overrideCells().filter(([i]) => inRoom(i)).length;
    return { n0, saved: c1.map(([i, b]) => (b === 0 ? 'removed' : b.id)).sort(), ov, errors: window.__rs.G.errors || [] };
  }, { v: v.id, hid: hs.id });
  check(sv.n0 === 0 && sv.saved.join(',') === 'chest,removed,removed' && sv.ov === 3 && !sv.errors.length,
    `saves: ${sv.n0} generated furniture cells saved as made; after filling the chest and taking a bed: ${sv.saved.join(',')}; co-op overrides ${sv.ov}; errors ${JSON.stringify(sv.errors).slice(0, 300)}`);
}
