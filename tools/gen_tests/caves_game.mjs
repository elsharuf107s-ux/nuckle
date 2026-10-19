// Stage 5b: caves as rooms in the game (design 13, 5b; 3.10, 3.11 steps 5, 8 to 10).
//
//   node tools/headless.mjs tools/gen_tests/caves_game.mjs --params '?new&play&world=wild&wseed=1' --port 5645 --out <dir>
//
//   1. every cave of the plan is dug: its rooms on their map, its warps in the world's list and indexed, the mouth a
//      FireRed entrance (General mid 169, behaviour 0x60) in its hill with walkable ground under it, protected;
//   2. a cave is entered for real: Steve walks up onto a mouth, the step warp takes him to B1F's exit (CAVE banner, cave
//      music, sky light 5);
//   3. mining: a tunnel dug through the wall to a coal, an iron and a diamond ore with the real target and finishBreak,
//      each ore dropping its item; every wall around a mined cell re-edged with its family's own piece for its new
//      pattern (reedgeFamily's lookup), checked cell by cell;
//   4. B2F by the ladder: dark (sky light 1, flash), the lava pools filled on arrival (refillPools), a water bucket on
//      lava makes obsidian, and the pool refills after the next visit;
//   5. out again: the B1F exit (press down) puts him at the mouth outside with a white fade; no G.errors.
export default async function (t) {
  const { page, R, run, idle, tick, shot, check, log } = t;
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
  await run(() => { const h = window.__rs; h.pause(); h.seed(5); if (h.rules) h.rules.encounters = false; h.G.rules.mobs = false; h.setTime(6000); });

  // ---------------------------------------------------------------- 1. dug rooms, warps, mouths
  const s1 = await run(() => {
    const h = window.__rs, W = h.world, plan = h.gen.plan(), out = { fails: [] };
    out.caves = plan.caves.length; out.rooms = W.roomInfo ? [...W.roomInfo.values()].filter((r) => !r.house).length : 0; out.roomMs = W.roomMs;   // (7a: house interiors are rooms too)
    const want = plan.caves.reduce((s, c) => s + (c.b2 ? 2 : 1), 0);
    if (out.rooms !== want) out.fails.push(`rooms dug ${out.rooms} of ${want}`);
    const cw = plan.warps.filter((w) => /^GEN_CAVE_/.test(w.map) || /^GEN_CAVE_/.test(w.dest));
    out.cw = cw.length;
    for (let k = 0; k < cw.length; k++) {
      const w = W.warps[701 + k];
      if (!w || w.x !== cw[k].x || w.y !== cw[k].y || w.to !== cw[k].to || W.warpAt(w.x, w.y) !== w) { out.fails.push('warp ' + (701 + k) + ' missing or not indexed'); break; }
    }
    // (7a: the house doors and mats follow the caves' warps)
    if (W.warps.length !== 701 + plan.warps.length) out.fails.push(`world warps ${W.warps.length}, want ${701 + plan.warps.length}`);
    for (const r of W.roomInfo.values()) {
      if (r.house) continue;
      const m = W.mapAt(r.x + 1, r.y + 1);
      if (!m || !m.room || m.kind !== 'cave') { out.fails.push('room cell not on its cave map'); break; }
    }
    return out;
  });
  check(!s1.fails.length, `every cave dug: ${s1.rooms} rooms for ${s1.caves} caves in ${s1.roomMs && s1.roomMs.toFixed(1)} ms, ${s1.cw} cave warps appended and indexed ${s1.fails.join('; ')}`);

  // the cave to visit: a mountain cave with a B2F (lava); its mouth's chunk made
  const cave = await run(async () => {
    const h = window.__rs, W = h.world, plan = h.gen.plan();
    const c = plan.caves.find((q) => q.family === 'mountain' && q.b2) || plan.caves.find((q) => q.b2) || plan.caves[0];
    const mx = 416 + c.x, my = c.y;
    await W.ensureAround(mx, my, 1);
    const e = W.entries[W.tile(mx, my)], L = W.entries[W.tile(mx - 1, my)], Rr = W.entries[W.tile(mx + 1, my)], D = W.entries[W.tile(mx, my + 1)];
    return { id: c.id, family: c.family, b2: c.b2, mx, my, mid: W.midOf[W.tile(mx, my)], beh: e[2], col: e[3], lc: L[3], rc: Rr[3], dc: D[3], prot: W.protAt(mx, my), warp: !!W.warpAt(mx, my) };
  });
  check(cave.mid === 169 && cave.beh === 0x60 && cave.col === 0 && cave.lc === 1 && cave.rc === 1 && cave.dc === 0 && cave.prot === 3 && cave.warp,
    `cave ${cave.id} (${cave.family}): the mouth at ${cave.mx},${cave.my} is FireRed's entrance (mid ${cave.mid}, beh ${cave.beh}) in rock, ground below, protected (${cave.prot}), a warp`);
  // every mouth of the plan, painted where the chunks are made (a sample: the first 12)
  const mouths = await run(async () => {
    const h = window.__rs, W = h.world, plan = h.gen.plan(), bad = [];
    for (const c of plan.caves.slice(0, 12)) {
      const mx = 416 + c.x, my = c.y;
      await W.ensureAround(mx, my, 1);
      const e = W.entries[W.tile(mx, my)];
      if (W.midOf[W.tile(mx, my)] !== 169 || e[2] !== 0x60 || W.col[(my + 1) * W.W + mx] !== 0) bad.push(c.id);
    }
    return bad;
  });
  check(!mouths.length, `the first 12 caves' mouths are entrances with open ground below (${mouths.join(',')})`);
  await run((c) => { window.__rs.teleport(c.mx, c.my + 2, 'up'); }, cave);
  await idle(4);
  await shot('5b-mouth');

  // ---------------------------------------------------------------- 2. in through the mouth
  await run((c) => { window.__rs.teleport(c.mx, c.my + 1, 'up'); }, cave);
  for (let i = 0; i < 90; i++) { await tick({ hold: 'up', press: i === 0 ? 'up' : undefined }); if (await R("h.state() === 'play' && W.roomAt(P.tx, P.ty)")) break; }
  await idle(30);
  const in1 = await R(`(() => { const m = W.roomAt(P.tx, P.ty); return { id: m && m.id, name: m && m.name, kind: m && m.kind, sky: G.skyAt(P.tx, P.ty), x: P.tx, y: P.ty, state: h.state() }; })()`);
  check(in1.id === `GEN_CAVE_${cave.id}_B1F` && in1.kind === 'cave' && in1.sky === 5 && in1.state === 'play', `walked in: ${JSON.stringify(in1)}`);
  await shot('5b-b1f-in');

  // ---------------------------------------------------------------- 3. mining coal, iron and a diamond
  const mineTo = async (kind) => {
    return run(async (kind) => {
      const h = window.__rs, W = h.world, P = h.P, G = h.G, PL = h.PL;
      // the ore cell of this kind nearest to an open cell, in any cave room
      let best = null;
      for (const [id, r] of W.roomInfo) {
        for (let y = r.y + 1; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
          if (W.entries[W.tile(x, y)][4] !== kind) continue;
          for (let d = 1; d <= 6 && !best; d++) for (let dy = -d; dy <= d && !best; dy++) for (let dx = -d; dx <= d; dx++) {
            const X = x + dx, Y = y + dy;
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== d || X <= r.x || Y <= r.y || X >= r.x + r.w - 1 || Y >= r.y + r.h - 1) continue;
            if (!W.col[Y * W.W + X] && !W.block(X, Y) && !W.warpAt(X, Y)) { best = { id, x, y, fx: X, fy: Y }; break; }
          }
          if (best) break;
        }
        if (best) break;
      }
      if (!best) return { kind, none: true };
      h.give('iron_pickaxe', 1, 0); G.inv.sel = 0;
      h.teleport(best.fx, best.fy, 'up');
      const fam = (x, y) => W.familyAt(x, y);
      const reedgeOk = (x0, y0) => {
        // every wall within 1 of the mined cell holds a piece its family draws for its new 5 x 5 (or 3 x 3) pattern
        const f = fam(x0 + 1, y0) || fam(x0 - 1, y0) || fam(x0, y0 + 1) || fam(x0, y0 - 1) || fam(x0 + 1, y0 + 1) || fam(x0 - 1, y0 - 1) || fam(x0 - 1, y0 + 1) || fam(x0 + 1, y0 - 1);
        if (!f) return { checked: 0, bad: 0 };
        const m = f.map, inRoom = (X, Y) => X >= m.x && X < m.x + m.w && Y >= m.y && Y < m.y + m.h;
        const isIn = (X, Y) => !inRoom(X, Y) || f.mem.has(W.baseEntry(W.tile(X, Y)));
        const key = (X, Y, r) => { let k = 0; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) k = k * 2 + (isIn(X + dx, Y + dy) ? 1 : 0); return String(k); };
        let checked = 0, bad = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const X = x0 + dx, Y = y0 + dy, t = W.tile(X, Y);
          if (!inRoom(X, Y) || !W.col[Y * W.W + X] || !f.mem.has(t) || f.keep.has(t) || W.protAt(X, Y)) continue;
          const c = (f.r2[key(X, Y, 2)] || f.r1[key(X, Y, 1)] || f.fill[key(X, Y, 1)] || []).filter((e) => W.entries[e][3]);
          checked++;
          if (c.length && !c.includes(t)) bad++;
        }
        return { checked, bad };
      };
      // dig toward the ore, x first, then y; each wall mined with the real target and finishBreak
      const steps = [];
      let x = best.fx, y = best.fy, mined = 0, rechecks = { checked: 0, bad: 0, changed: 0 };
      for (let k = 0; k < 20; k++) {
        const dir = x < best.x ? 'right' : x > best.x ? 'left' : y < best.y ? 'down' : 'up';
        const nx = x + (dir === 'right' ? 1 : dir === 'left' ? -1 : 0), ny = y + (dir === 'down' ? 1 : dir === 'up' ? -1 : 0);
        PL.placePlayer(P, x, y, dir);
        if (nx === best.x && ny === best.y) break;
        if (W.col[ny * W.W + nx]) {
          const before = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) before.push(W.tile(nx + dx, ny + dy));
          const tg = PL.target(P);
          if (!tg || tg.kind !== 'tile') return { kind, err: 'no wall target at ' + nx + ',' + ny + ' ' + JSON.stringify(tg && tg.kind) };
          PL.finishBreak(P, tg); mined++;
          let n = 0; for (let dy = -1, q = 0; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++, q++) if (W.tile(nx + dx, ny + dy) !== before[q]) n++;
          const rc = reedgeOk(nx, ny); rechecks.checked += rc.checked; rechecks.bad += rc.bad; rechecks.changed += n - 1;
        }
        x = nx; y = ny;
        steps.push([x, y]);
      }
      const tg = PL.target(P);
      const nEnts = G.ents.length;
      const was = W.entries[W.tile(best.x, best.y)][4];
      if (!tg || tg.kind !== 'tile' || tg.mat !== kind) return { kind, err: 'ore not in front: ' + JSON.stringify(tg && { k: tg.kind, m: tg.mat }) };
      PL.finishBreak(P, tg);
      const drops = G.ents.slice(nEnts).filter((e) => e.type === 'item').map((e) => e.stack && e.stack.id);
      const after = W.entries[W.tile(best.x, best.y)];
      const rc = reedgeOk(best.x, best.y);
      return { kind, room: best.id, at: [best.x, best.y], mined, was, nowMat: after[4], nowCol: after[3], drops, rechecks, last: rc };
    }, kind);
  };
  const res = {};
  for (const kind of ['coal_ore', 'iron_ore', 'diamond_ore']) {
    const r = await mineTo(kind);
    res[kind] = r;
    log(JSON.stringify(r));
    check(!r.none && !r.err && r.was === kind && r.nowCol === 0 && r.drops.length > 0, `${kind}: tunnelled ${r.mined} walls to it in ${r.room} and mined it (drops ${JSON.stringify(r.drops)}, cell now ${r.nowMat})`);
    check(r.rechecks && r.rechecks.bad === 0 && r.last && r.last.bad === 0 && r.rechecks.checked > 0, `${kind}: the walls around every mined cell re-edged with their family's pieces (${r.rechecks && r.rechecks.checked + r.last.checked} checked, ${r.rechecks && r.rechecks.changed} re-skinned)`);
    await idle(3);
    await shot('5b-mined-' + kind);
  }
  // the drops are what Minecraft gives
  const dropIds = Object.values(res).map((r) => (r.drops || []).join(','));
  check(/coal/.test(dropIds[0]) && /iron/.test(dropIds[1]) && /diamond/.test(dropIds[2]), `drops: ${dropIds.join(' | ')}`);

  // ---------------------------------------------------------------- 4. B2F: dark, lava, water on lava
  const lad = await run((c) => {
    const h = window.__rs, W = h.world;
    const w = W.warps.find((q) => q.map === `GEN_CAVE_${c.id}_B1F` && q.trig === 'step');
    return w ? { x: w.x, y: w.y, ax: w.ax, ay: w.ay } : null;
  }, cave);
  check(!!lad, 'B1F has its ladder down');
  await run((l) => { window.__rs.teleport(l.x, l.y + 1, 'up'); }, lad);
  for (let i = 0; i < 90; i++) { await tick({ hold: 'up', press: i === 0 ? 'up' : undefined }); if (await R(`h.state() === 'play' && W.roomAt(P.tx, P.ty) && W.roomAt(P.tx, P.ty).id.endsWith('B2F')`)) break; }
  await idle(20);
  const b2 = await R(`(() => { const m = W.roomAt(P.tx, P.ty), lava = (W.meta.lava || []).filter((l) => l.map === (m && m.id)); return { id: m && m.id, flash: m && m.flash, sky: G.skyAt(P.tx, P.ty), light: G.lightAt(P.tx, P.ty), pools: lava.length, filled: lava.filter((l) => { const b = W.block(l.x, l.y); return b && b.id === 'lava'; }).length, at: [P.tx, P.ty] }; })()`);
  check(b2.id === `GEN_CAVE_${cave.id}_B2F` && b2.flash && b2.sky === 1, `down the ladder to B2F, dark: ${JSON.stringify(b2)}`);
  check(cave.family !== 'mountain' || (b2.pools >= 9 && b2.filled === b2.pools), `B2F's lava pools filled on arrival (${b2.filled} of ${b2.pools} cells)`);
  await shot('5b-b2f-dark');
  if (b2.pools) {
    const ob = await run(() => {
      const h = window.__rs, W = h.world, P = h.P, G = h.G, PL = h.PL, m = W.roomAt(P.tx, P.ty);
      const lava = W.meta.lava.filter((l) => l.map === m.id);
      // an open floor cell beside a pool cell, facing it
      for (const l of lava) for (const [dx, dy, dir] of [[0, 1, 'up'], [0, -1, 'down'], [1, 0, 'left'], [-1, 0, 'right']]) {
        const x = l.x + dx, y = l.y + dy;
        if (W.col[y * W.W + x] || W.block(x, y)) continue;
        h.teleport(x, y, dir);
        h.give('water_bucket', 1, 1); G.inv.sel = 1;
        const ok = PL.useItem(P, G.inv.held, { x: l.x, y: l.y });
        const b = W.block(l.x, l.y);
        return { ok, block: b && b.id, held: G.inv.held && G.inv.held.id, at: [l.x, l.y], from: [x, y] };
      }
      return { none: true };
    });
    check(ob.ok && ob.block === 'obsidian' && ob.held === 'bucket', `water bucket on cave lava: ${JSON.stringify(ob)}`);
    await idle(3);
    await shot('5b-obsidian');
    // mine the obsidian (a diamond pickaxe), leave and come back: the pool cell is lava again
    const re = await run(async (ob) => {
      const h = window.__rs, W = h.world, P = h.P, G = h.G, PL = h.PL;
      h.give('diamond_pickaxe', 1, 0); G.inv.sel = 0;
      h.teleport(ob.from[0], ob.from[1], P.dir);
      const tg = PL.target(P);
      PL.finishBreak(P, tg);
      const gone = !W.block(ob.at[0], ob.at[1]);
      // (he picks the obsidian up: a dropped item on a pool cell keeps the lava out, as in Classic)
      const n0 = G.ents.length;
      G.ents = G.ents.filter((e) => !(e.type === 'item' && e.stack && e.stack.id === 'obsidian'));
      return { gone, picked: n0 - G.ents.length };
    }, ob);
    check(re.gone, 'the obsidian mined out of the pool');
    // up the B2F ladder and back down again
    const up = await run(() => { const h = window.__rs, W = h.world, m = W.roomAt(h.P.tx, h.P.ty); const w = W.warps.find((q) => q.map === m.id && q.trig === 'step'); return { x: w.x, y: w.y }; });
    await run((l) => { window.__rs.teleport(l.x, l.y - 1, 'down'); }, up);
    for (let i = 0; i < 90; i++) { await tick({ hold: 'down', press: i === 0 ? 'down' : undefined }); if (await R(`h.state() === 'play' && W.roomAt(P.tx, P.ty) && W.roomAt(P.tx, P.ty).id.endsWith('B1F')`)) break; }
    await idle(10);
    await run((l) => { window.__rs.teleport(l.x, l.y + 1, 'up'); }, lad);
    for (let i = 0; i < 90; i++) { await tick({ hold: 'up', press: i === 0 ? 'up' : undefined }); if (await R(`h.state() === 'play' && W.roomAt(P.tx, P.ty) && W.roomAt(P.tx, P.ty).id.endsWith('B2F')`)) break; }
    await idle(10);
    const back = await R(`(() => { const b = W.block(${ob.at[0]}, ${ob.at[1]}); return b && b.id; })()`);
    check(back === 'lava', `back on B2F the pool cell is lava again (${back})`);
  }

  // ---------------------------------------------------------------- 5. out through the B1F exit
  const ex = await run((c) => { const W = window.__rs.world; const w = W.warps.find((q) => q.map === `GEN_CAVE_${c.id}_B1F` && q.trig === 'arrowS'); return { x: w.x, y: w.y, ax: w.ax, ay: w.ay }; }, cave);
  await run((e) => { window.__rs.teleport(e.x, e.y, 'down'); }, ex);
  let white = false;
  for (let i = 0; i < 120; i++) {
    await tick({ hold: 'down', press: i === 0 ? 'down' : undefined });
    if (!white && await R(`h.state() === 'warp'`)) white = true;
    if (await R(`h.state() === 'play' && W.isOutdoor(P.tx, P.ty) && !P.moving`)) break;
  }
  await idle(10);
  const out = await R(`({ x: P.tx, y: P.ty, outdoor: W.isOutdoor(P.tx, P.ty), errs: (G.errors || []).length, err0: (G.errors || [])[0] || null })`);
  check(out.outdoor && out.x === cave.mx && out.y === cave.my + 1, `out through the exit at the mouth: ${JSON.stringify(out)} (mouth ${cave.mx},${cave.my})`);
  check(!out.errs, `no G.errors (${out.err0})`);
  await shot('5b-out');
}
