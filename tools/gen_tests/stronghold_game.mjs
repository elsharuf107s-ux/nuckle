// Stage 6c in the game: the Wild World stronghold and the travel fixes (design 13, 6c; 2.9, 3.12, 3.13).
//
//   node tools/headless.mjs tools/gen_tests/stronghold_game.mjs --params '?new&play&world=wild&wseed=1' --port 5430 --out <dir>
//        [--eye-seeds 50]   (0 skips the eye test; --eyes-only runs it alone)
//
//   1. the rewired meta: the entrance is the plan's; warp 697 starts there and 698..700 arrive there, all indexed;
//      A.world is unchanged; Route 23's old cell (13, 76) and the cell below it are neither warps to or from the
//      stronghold nor in noPlaceCells;
//   2. the ruin on the finished chunks: the closed entrance (solid) with the open stairs as ground, the 8 brick blocks
//      (solid, frozen decorations), the cell south walkable; mined open, Steve walks in, arrives in the stronghold, and
//      walks back up its stairs to the cell below the entrance;
//   3. eyes: far away the eye flies 8 cells in the exact direction; within 64 cells one of 8 directions; within 3 it
//      dives; a real throw flies, hovers and comes down with no errors;
//   4. the Nether round trip after a reload: through a portal, SAVE in the Nether, reload, back through: at the portal;
//      then the fallbacks: the portal cell walled up (outside the ring), a 25 x 25 block of stone round it (the
//      nearest walkable cell within 16), a 33 x 33 block (the world spawn);
//   5. the eye test (11.4): a scripted searcher on N seeds (throw, walk 64 cells along the eye's line, repeat; once an
//      eye turns back or square to the last line, each later walk is half the last: a bisection) must average under
//      12 eyes thrown until one dives at the entrance (broken eyes counted too, 20% of throws by a fixed hash).
export default async function (t) {
  const { page, R, run, tick, idle, shot, check, log } = t;
  const url = page.url().replace(/\?.*$/, '');
  const argv = process.argv;
  const eyeSeeds = Number(argv.includes('--eye-seeds') ? argv[argv.indexOf('--eye-seeds') + 1] : 50);
  const prep = async () => {
    await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
    await page.evaluate(() => { const h = window.__rs; h.pause(); h.seed(2026); if (h.rules) h.rules.encounters = false; });
  };
  const errs = () => R('(G.errors || []).length');
  // a page load, retried twice: other work rewrites asset files while the suite runs, and a file caught mid-write
  // fails the boot (nothing to do with this stage)
  const load = async (q) => {
    for (let k = 0; ; k++) {
      try { await page.goto(url + q); await prep(); return; } catch (e) { if (k >= 2) throw e; log('reload after', String(e).slice(0, 120)); }
    }
  };

  // --eyes-only: part 5 alone (parts 1 to 4 need one world, part 5 reloads the page once per seed)
  if (argv.includes('--eyes-only')) { await eyeTest(); return; }

  // ---- 1. the rewired meta
  const m = await run(() => {
    const h = window.__rs, W = h.world, A = h.A, S = W.stronghold, sh = h.gen.plan().stronghold, ws = A.world.stronghold;
    const [a, b] = ws.warps, smap = A.world.maps[ws.map].id, r23 = 76 * W.W + 13, r23s = 77 * W.W + 13;
    const ws2 = W.warps.slice(a, b + 1).map((w) => ({ x: w.x, y: w.y, ax: w.ax, ay: w.ay, off: !!w.off, map: w.map, dest: w.dest, idx: W.warpIdx.get(w.y * W.W + w.x) === w }));
    const toSh = W.warps.filter((w) => !w.off && ((w.x === 13 && w.y === 76) || (w.ax === 13 && w.ay === 76)) && (w.dest === smap || w.map === smap));
    const at = W.warpAt(13, 76);
    return { ent: S.entrance, sh, ws2, orig: A.world.warps.slice(a, b + 1).map((w) => [w.x, w.y, w.ax, w.ay]), origEnt: ws.entrance,
      toSh: toSh.length, warpAt: at ? { map: at.map, dest: at.dest } : null, noPlace: W.noPlaceCells.has(r23) || W.noPlaceCells.has(r23s),
      entWarp: (W.warpAt(S.entrance.x, S.entrance.y) || {}).i, belowNoPlace: W.noPlaceCells.has((S.entrance.y + 1) * W.W + S.entrance.x) };
  });
  log('meta', JSON.stringify(m));
  check(m.sh && m.ent && m.ent.x === m.sh.px && m.ent.y === m.sh.py, `the stronghold's entrance is the plan's (${m.ent && m.ent.x}, ${m.ent && m.ent.y}), rung ${m.sh && m.sh.rung}`);
  check(m.ws2[0].x === m.ent.x && m.ws2[0].y === m.ent.y && !m.ws2[0].off && m.ws2[0].idx && m.entWarp === 697, 'warp 697 starts at the planned entrance and is indexed');
  check(m.ws2.slice(1).every((w) => w.ax === m.ent.x && w.ay === m.ent.y && !w.off && w.idx), 'the three stair warps arrive at the planned entrance and are indexed');
  check(m.orig[0][0] === 13 && m.orig[0][1] === 76 && m.orig.slice(1).every((w) => w[2] === 13 && w[3] === 76) && m.origEnt.x === 13 && m.origEnt.y === 76, 'A.world\'s stronghold warps and entrance are unchanged (Route 23)');
  check(m.toSh === 0 && !(m.warpAt && (m.warpAt.dest === 'MAP_STRONGHOLD' || m.warpAt.map === 'MAP_STRONGHOLD')) && !m.noPlace, `Route 23's cell is free and warpless (warp there: ${JSON.stringify(m.warpAt)}, noPlace ${m.noPlace})`);
  check(m.belowNoPlace, 'nothing can be placed on the cell below the entrance (the stairs\' arrival walks onto it)');

  // ---- 2. the ruin, in and out
  const E = m.ent;
  const ru = await run(async (E) => {
    const h = window.__rs, W = h.world, PL = h.PL, S = W.stronghold;
    await h.ensure(E.x, E.y, 1);
    const ring = [[-3, -3], [-1, -3], [1, -3], [3, -3], [-3, 0], [3, 0], [-3, 3], [3, 3]].map(([dx, dy]) => { const b = W.block(E.x + dx, E.y + dy); return [b && b.id, W.solid(E.x + dx, E.y + dy)]; });
    const gi = E.y * W.W + E.x;
    return { tile: W.tile(E.x, E.y), closed: S.entranceTiles.closed, open: S.entranceTiles.open, ground: W.groundFor(E.x, E.y),
      solid: W.solid(E.x, E.y), ring, below: PL.canEnter({ riding: null }, E.x, E.y + 1), open0: h.END.entranceOpen() };
  }, E);
  log('ruin', JSON.stringify(ru));
  check(ru.tile === ru.closed && ru.solid && !ru.open0 && ru.ground === ru.open, 'the entrance cell shows the closed entrance (solid) with the open stairs as its ground');
  check(ru.ring.every(([id, s]) => (id === 'mossy_stone_bricks' || id === 'cracked_stone_bricks') && s), 'the 8 ring cells are mossy or cracked stone brick blocks, solid');
  check(ru.below === 'walk', 'the cell south of the entrance is walkable');
  await run((E) => { const h = window.__rs; h.teleport(E.x, E.y + 2, 'up'); h.G.time = 6000; }, E);
  await idle(4);
  await shot('ruin_closed');
  // mine the entrance with the real break code (it leaves the ground: the open stairs)
  const mined = await run((E) => {
    const h = window.__rs, W = h.world;
    h.teleport(E.x, E.y + 1, 'up');
    const before = W.tile(E.x, E.y);
    h.G.inv.slots[0] = { id: 'diamond_pickaxe', n: 1 }; h.G.inv.sel = 0;
    const tg = h.PL.target(h.P);
    const kind = tg && tg.kind;
    if (tg && tg.kind !== 'protected') h.PL.finishBreak(h.P, tg);
    return { before, kind, after: W.tile(E.x, E.y), open: h.END.entranceOpen(), how: 'target + finishBreak' };
  }, E);
  log('mined', JSON.stringify(mined));
  check(mined.open, `mined (${mined.how}), the entrance shows the open stairs`);
  // walk up into it: the step warp takes him into the stronghold
  let inside = false;
  for (let i = 0; i < 120 && !inside; i++) { await tick({ hold: 'up' }); inside = await R('W.inStronghold(P.tx, P.ty)'); }
  for (let i = 0; i < 40; i++) await tick();
  const inS = await R('({ P: [P.tx, P.ty], st: h.state(), inS: W.inStronghold(P.tx, P.ty) })');
  log('in', JSON.stringify(inS));
  check(inS.inS, 'walking onto the open entrance takes him into the stronghold');
  await shot('stronghold_in');
  // back up the stairs: to the cell below the planned entrance
  let out = false;
  for (let i = 0; i < 200 && !out; i++) { await tick({ hold: 'up' }); out = await R('!W.inStronghold(P.tx, P.ty) && W.isOutdoor(P.tx, P.ty)'); }
  for (let i = 0; i < 60; i++) await tick();
  const outS = await R('({ P: [P.tx, P.ty], key: W.regionKey(P.tx, P.ty), st: h.state() })');
  log('out', JSON.stringify(outS));
  check(outS.P[0] === E.x && outS.P[1] === E.y + 1 && outS.key === 'WILD', 'up the stronghold\'s stairs he comes out below the planned entrance, in the Wild World');
  await shot('ruin_open');

  // ---- 3. eyes
  const eyes = await run(async (E) => {
    const h = window.__rs, W = h.world, P = h.P, G = h.G, PL = h.PL;
    G.inv.slots[0] = { id: 'eye_of_ender', n: 64 }; G.inv.sel = 0;
    const walkNear = async (x, y) => {
      await h.ensure(x, y, 1);
      for (let r = 0; r <= 16; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const X = x + dx, Y = y + dy;
        if (PL.canEnter({ riding: null }, X, Y) === 'walk' && !W.isWater(X, Y) && !W.warpAt(X, Y)) { h.teleport(X, Y); return [X, Y]; }
      }
      return null;
    };
    const one = (fate) => { const e = h.END.throwEye(P, { fate }); const r = { mode: e.mode, exact: !!e.exact, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, short: !!e.short }; h.END.resetTransient(); return r; };
    const far = await walkNear(E.x - 200, E.y + 120);
    const f = one('drop');
    const fa = Math.atan2(f.y1 - f.y0, f.x1 - f.x0), ta = Math.atan2(E.y * 16 + 8 - f.y0, E.x * 16 + 8 - f.x0), fl = Math.hypot(f.x1 - f.x0, f.y1 - f.y0) / 16;
    const near = await walkNear(E.x - 30, E.y + 11);
    const n = one('drop');
    const na = Math.atan2(n.y1 - n.y0, n.x1 - n.x0) / (Math.PI / 4);
    const nt = Math.atan2(E.y * 16 + 8 - n.y0, E.x * 16 + 8 - n.x0) / (Math.PI / 4);
    await walkNear(E.x + 1, E.y + 2);
    const d = one('drop');
    return { far, f, angErr: Math.abs(fa - ta), fly: fl, near, n, na, nt, d };
  }, E);
  log('eyes', JSON.stringify(eyes));
  check(eyes.f.mode === 'seek' && eyes.f.exact && eyes.angErr < 1e-6 && Math.abs(eyes.fly - 8) < 1e-6, `far away (about 200 cells) the eye flies 8 cells in the exact direction (error ${eyes.angErr.toExponential(1)} rad)`);
  check(eyes.n.mode === 'seek' && !eyes.n.exact && Math.abs(eyes.na - Math.round(eyes.na)) < 1e-9 && Math.round(eyes.na) === Math.round(eyes.nt), 'within 64 cells it flies in the nearest of 8 directions');
  check(eyes.d.mode === 'dive', 'within 3 cells it dives at the entrance');
  // one real throw in flight to the end, from far away
  await run((far) => { const h = window.__rs; if (far) h.teleport(far[0], far[1]); h.G.inv.slots[0] = { id: 'eye_of_ender', n: 5 }; h.G.inv.sel = 0; h.END.throwEye(h.P, { fate: 'drop' }); }, eyes.far);
  for (let i = 0; i < 40; i++) await tick();
  await shot('eye_in_flight');
  for (let i = 0; i < 60; i++) await tick();
  const fl = await R('({ last: G.lastEye, n: (G.inv.slots[0] || {}).n, errs: (G.errors || []).length })');
  log('real throw', JSON.stringify(fl));
  check(fl.last && fl.last.fate === 'drop' && fl.errs === 0, 'a real throw flies, hovers and comes down as an item, no errors');

  // ---- 4. the Nether round trip after a reload, and the fallbacks
  const sp = await R('[G.worldSpawn.x, G.worldSpawn.y]');
  const portal = await run(async (sp) => {
    const h = window.__rs, W = h.world, PL = h.PL;
    const ok = (x, y) => PL.canEnter({ riding: null }, x, y) === 'walk' && !W.isWater(x, y) && !W.block(x, y) && !W.warpAt(x, y) && W.isFloor(x, y);
    for (let r = 0; r < 30; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = sp[0] + 40 + dx * 4, y = sp[1] - 60 + dy * 4;
      await h.ensure(x, y, 1);
      let good = true;
      for (let yy = y - 1; yy <= y + 3 && good; yy++) for (let xx = x - 1; xx <= x + 2 && good; xx++) good = ok(xx, yy);
      if (good) return [x, y];
    }
    return null;
  }, sp);
  check(!!portal, 'dry ground for a portal');
  await run(([x, y]) => { const h = window.__rs; h.buildPortal(x, y, 2, 3); h.lightPortal(x, y); h.teleport(x, y + 1); h.G.portalCool = false; }, portal);
  for (let i = 0; i < 160 && !(await R('W.inNether(P.tx, P.ty)')); i++) await tick();
  const n1 = await R('({ n: W.inNether(P.tx, P.ty), lp: G.lastPortal })');
  check(n1.n && n1.lp && n1.lp.x === portal[0], 'through the portal into the Nether');
  const sv = await run(async () => { const h = window.__rs; return await h.save(); });
  check(sv, 'saved in the Nether');
  await load('?play');
  const back = async () => {
    await run(() => window.__rs.travel(false));
    for (let i = 0; i < 200 && (await R("h.state() === 'genwait'")); i++) await tick();
    return R('({ P: [P.tx, P.ty], st: h.state(), nether: W.inNether(P.tx, P.ty), portal: W.isPortal(P.tx, P.ty), lp: G.lastPortal, sp: [G.worldSpawn.x, G.worldSpawn.y] })');
  };
  const r1 = await back();
  log('return 1', JSON.stringify(r1));
  check(!r1.nether && r1.P[0] === n1.lp.x && r1.P[1] === n1.lp.y && r1.portal, 'after the reload the way back lands on the portal');
  // fallback a: the portal walled up while he is away (the ring and its inside stone): outside the ring
  const wall = async (r) => run(([lp, r]) => {
    const h = window.__rs, W = h.world;
    h.travel(true);
    h.G.lastPortal = { x: lp.x, y: lp.y };   // (he went from where the last return put him: the way back is the portal's cell)
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) W.setBlock(lp.x + dx, lp.y + dy, { id: 'stone' });
    return W.inNether(h.P.tx, h.P.ty);
  }, [n1.lp, r]);
  const fb = [];
  for (const [r, name] of [[2, 'walled'], [12, '25 x 25'], [16, '33 x 33']]) {
    for (let i = 0; i < 6; i++) await tick();
    const inN = await wall(r);
    await run(async () => { await window.__rs.save(); });
    await load('?play');
    const rr = await back();
    const d = Math.max(Math.abs(rr.P[0] - n1.lp.x), Math.abs(rr.P[1] - n1.lp.y));
    fb.push({ name, inN, P: rr.P, d, spawn: rr.P[0] === rr.sp[0] && rr.P[1] === rr.sp[1] });
    log('fallback', name, JSON.stringify(fb[fb.length - 1]));
    if (r === 2) await shot('return_walled');
  }
  check(fb[0].inN && !fb[0].spawn && fb[0].d >= 3 && fb[0].d <= 12, `portal walled up: he comes back beside it (${fb[0].d} cells), not at the spawn`);
  check(fb[1].inN && !fb[1].spawn && fb[1].d >= 13 && fb[1].d <= 16, `a 25 x 25 block of stone round it: the nearest walkable cell within 16 (${fb[1].d} cells)`);
  check(fb[2].inN && fb[2].spawn, 'nothing walkable within 16: the world spawn');
  check((await errs()) === 0, 'no G.errors');

  await eyeTest();

  // ---- 5. the eye test (11.4)
  async function eyeTest() {
  if (eyeSeeds > 0) {
    const res = [];
    for (let s = 1; s <= eyeSeeds; s++) {
      await load(`?new&play&world=wild&wseed=${s}`);
      const r = await run(async (seed) => {
        const h = window.__rs, W = h.world, P = h.P, G = h.G, PL = h.PL, E = W.stronghold.entrance;
        G.inv.slots[0] = { id: 'eye_of_ender', n: 64 }; G.inv.sel = 0;
        const walkNear = async (x, y) => {
          await h.ensure(x, y, 1);
          for (let r = 0; r <= 16; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const X = x + dx, Y = y + dy;
            if (W.isOutdoor(X, Y) && PL.canEnter({ riding: null }, X, Y) === 'walk' && !W.isWater(X, Y) && !W.warpAt(X, Y)) { h.teleport(X, Y); return true; }
          }
          return false;
        };
        const d0 = Math.max(Math.abs(P.tx - E.x), Math.abs(P.ty - E.y));
        let thrown = 0, broke = 0, L = 64, prev = null, done = false, why = '', turned = false;
        while (thrown < 40 && !done) {
          const fate = ((Math.imul(seed, 2654435761) ^ Math.imul(thrown + 1, 40503)) >>> 0) % 5 === 0 ? 'shatter' : 'drop';
          const e = h.END.throwEye(P, { fate });
          thrown++;
          const x0 = e.x0, y0 = e.y0, mode = e.mode;
          let dx = e.x1 - x0, dy = e.y1 - y0;
          h.END.resetTransient();
          if (mode === 'dive') { done = true; break; }
          if (mode !== 'seek') { why = 'mode ' + mode; break; }
          if (fate === 'shatter') broke++;
          let len = Math.hypot(dx, dy);
          if (len < 1) { const a = e.dir * Math.PI / 4; dx = Math.cos(a); dy = Math.sin(a); len = 1; }
          dx /= len; dy /= len;
          // bisection once the eye has turned back (or square to the last line): every later walk is half the last
          if (prev && (turned || dx * prev[0] + dy * prev[1] <= 0.01)) { turned = true; L = Math.max(2, Math.floor(L / 2)); }
          prev = [dx, dy];
          let moved = false;
          for (let k = L; k >= 2 && !moved; k = Math.floor(k / 2)) moved = await walkNear(Math.round(P.tx + dx * k), Math.round(P.ty + dy * k));
          if (!moved) { why = 'stuck'; break; }
        }
        return { seed, d0, thrown, broke, done, why, rung: h.gen.plan().stronghold.rung };
      }, s);
      res.push(r);
      if (!r.done) log('eye search failed', JSON.stringify(r));
    }
    const avg = res.reduce((a, r) => a + r.thrown, 0) / res.length, lost = res.reduce((a, r) => a + r.broke, 0) / res.length;
    const mx = Math.max(...res.map((r) => r.thrown));
    log('eye test', JSON.stringify(res.map((r) => [r.seed, r.d0, r.thrown, r.broke])));
    check(res.every((r) => r.done), `the searcher found the entrance on all ${res.length} seeds`);
    check(avg < 12, `eye test: ${avg.toFixed(2)} eyes thrown on average over ${res.length} seeds (max ${mx}), ${lost.toFixed(2)} broken (target under 12)`);
    check((await errs()) === 0, 'no G.errors after the eye test');
  }
  }
}
