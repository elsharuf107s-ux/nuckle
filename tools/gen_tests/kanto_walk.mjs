// Stage 6b: a headless walk from a Kanto World's spawn into Kanto through one of its openings (design 13, 6b; 3.12).
//
//   node tools/headless.mjs tools/gen_tests/kanto_walk.mjs --params '?new&play&world=kanto&wseed=1' --port 5405 --out <dir>
//
//   1. the plan kept openings (world.meta.openings: plane cells, each with the Kanto map its cut reaches) and the
//      spawn is 280 to 460 cells from Kanto's box;
//   2. a path is planned on the world's own cells (W.solid, ledges only downhill, water only where no dry way is near:
//      it is swum, as rivers have no bridge; chunks generated as the search reaches them) from the spawn to the nearest
//      reachable opening's map cell, through its out cell, never entering Kanto's cells before the out cell (so the way
//      in is the cut, not Kanto's sea or another opening);
//   3. Steve walks it with the arrow keys, one game frame at a time (no teleport): he ends on the opening's map cell, a
//      Kanto map's cell (not a generated one), having crossed cells that are trees or rock in Classic (the cut); the
//      frames he spent swimming are reported;
//   4. a screenshot at the cut (looked at), no G.errors.
export default async function (t) {
  const { page, run, idle, shot, check, log } = t;
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
  await run(() => { const h = window.__rs; h.pause(); h.seed(5); if (h.rules) h.rules.encounters = false; h.G.rules.mobs = false; h.setTime(6000); });

  // ---------------------------------------------------------------- 1. the openings and the spawn
  const b = await run(() => {
    const h = window.__rs, W = h.world, L = W.layout, K = L.kanto, ops = W.meta.openings || [], sp = h.G.worldSpawn;
    const dx = sp.x < K.x ? K.x - sp.x : sp.x >= K.x + 408 ? sp.x - (K.x + 407) : 0, dy = sp.y < K.y ? K.y - sp.y : sp.y >= K.y + 400 ? sp.y - (K.y + 399) : 0;
    return { n: ops.length, outer: ops.filter((o) => o.kind === 'outer').length, maps: ops.map((o) => o.map), sp, d: Math.max(dx, dy), seed: W.seed, plan: h.world.gen.plan.openings.length };
  });
  check(b.n >= 1 && b.outer >= 1 && b.n === b.plan && b.d >= 280 && b.d <= 460,
    `seed ${b.seed}: ${b.n} openings kept (${b.outer} outward) into ${[...new Set(b.maps)].join(', ')}; the spawn (${b.sp.x}, ${b.sp.y}) is ${b.d} cells from Kanto's box`);

  // ---------------------------------------------------------------- 2. the path (weighted A* over the world's cells)
  const plan = await run(() => {
    const h = window.__rs, W = h.world, sp = h.G.worldSpawn;
    const ops = (W.meta.openings || []).filter((o) => o.kind === 'outer').slice();
    const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    ops.sort((a, b) => cheb(a.out, [sp.x, sp.y]) - cheb(b.out, [sp.x, sp.y]));
    const made = new Set(), ban = new Set();
    const ensure = (x, y) => { const k = (y >> 5) * 4096 + (x >> 5); if (!made.has(k)) { made.add(k); W.ensureAround(x, y, 0, true); } };
    const free = (x, y, outside) => { ensure(x, y); return W.inside(x, y) && W.inBorder(x, y) && !ban.has(y * 4096 + x) && !W.solid(x, y) && !(outside && W.isKantoCell(x, y)); };
    const D4 = [[0, -1, 'up'], [1, 0, 'right'], [0, 1, 'down'], [-1, 0, 'left']];
    const leg = (ax, ay, bx, by, outside = false) => {   // (outside: Kanto's own cells are not entered)
      const key = (x, y) => y * 4096 + x, open = [[0, ax, ay]], g = new Map([[key(ax, ay), 0]]), from = new Map();
      const push = (f, x, y) => { open.push([f, x, y]); let i = open.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (open[p][0] <= open[i][0]) break; [open[p], open[i]] = [open[i], open[p]]; i = p; } };
      const pop = () => { const top = open[0], last = open.pop(); if (open.length) { open[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < open.length && open[l][0] < open[m][0]) m = l; if (r < open.length && open[r][0] < open[m][0]) m = r; if (m === i) break; [open[m], open[i]] = [open[i], open[m]]; i = m; } } return top; };
      let n = 0;
      while (open.length && n < 400000) {
        const [, x, y] = pop(); n++;
        if (x === bx && y === by) {
          const path = [[x, y]];
          let k = key(x, y);
          while (from.has(k)) { k = from.get(k); path.push([k % 4096, (k / 4096) | 0]); }
          return { path: path.reverse(), n };
        }
        const gx = g.get(key(x, y));
        for (const [ddx, ddy, dir] of D4) {
          let nx = x + ddx, ny = y + ddy;
          ensure(nx, ny);
          const j = W.jumpDir(nx, ny);
          if (j) { if (j !== dir) continue; nx += ddx; ny += ddy; }
          if (!free(nx, ny, outside)) continue;
          const k2 = key(nx, ny), ng = gx + (W.isWater(nx, ny) ? 16 : 1);   // (water is swum, but only where no dry way is near)
          if (g.has(k2) && g.get(k2) <= ng) continue;
          g.set(k2, ng); from.set(k2, key(x, y));
          push(ng + 1.5 * (Math.abs(nx - bx) + Math.abs(ny - by)), nx, ny);
        }
      }
      return { path: null, n };
    };
    // from (sx, sy) to the opening's map cell, through its out cell unless `past` (already through it)
    const route = (sx, sy, o, past) => {
      if (past) return leg(sx, sy, o.in[0], o.in[1]);
      const a = leg(sx, sy, o.out[0], o.out[1], true);   // (to the mouth without entering Kanto: the way in is the cut)
      if (!a.path) return { path: null, n: a.n, leg: 1 };
      const c = leg(o.out[0], o.out[1], o.in[0], o.in[1]);
      if (!c.path) return { path: null, n: a.n + c.n, leg: 2 };
      return { path: a.path.concat(c.path.slice(1)), n: a.n + c.n };
    };
    window.__walkLib = { route, ban, made };
    const t0 = performance.now(), tried = [];
    for (const o of ops) {
      const r = route(sp.x, sp.y, o, false);
      tried.push({ id: o.id, n: r.n, leg: r.leg || 0 });
      if (r.path) { window.__walk = { path: r.path, op: o, total: r.path.length, replans: [] }; return { ok: true, op: o, len: r.path.length, tried, ms: performance.now() - t0, chunks: made.size }; }
      if (tried.length >= 4) break;
    }
    return { ok: false, tried, ms: performance.now() - t0 };
  });
  check(plan.ok, `a path from the spawn to opening ${plan.ok ? plan.op.id + ' (' + plan.op.map + ')' : '-'}: ${plan.len || 0} cells, ${plan.tried.map((x) => x.id + ':' + x.n + (x.leg ? ' failed leg ' + x.leg : '')).join(', ')} (${Math.round(plan.ms)} ms)`);
  if (!plan.ok) return;

  // ---------------------------------------------------------------- 3. the walk, frame by frame (a creature in the way:
  // its cell is avoided and the rest of the path planned again from where Steve stands)
  let res = null;
  for (let round = 0; round < 80; round++) {
    res = await run(() => {
      const h = window.__rs, P = h.P, W = h.world, wk = window.__walk;
      if (!wk.idx) { wk.idx = new Map(wk.path.map(([x, y], i) => [y * 4096 + x, i])); wk.stuck = 0; wk.last = -1; wk.wet = 0; wk.frames = wk.frames || 0; wk.passed = wk.passed || false; }
      for (let f = 0; f < 1500; f++) {
        const i = wk.idx.get(P.ty * 4096 + P.tx);
        if (i === undefined) return { off: true, x: P.tx, y: P.ty, frames: wk.frames };
        if (Math.abs(P.tx - wk.op.out[0]) <= 2 && Math.abs(P.ty - wk.op.out[1]) <= 2 && !W.isKantoCell(P.tx, P.ty)) wk.passed = true;
        if (Math.abs(P.tx - wk.op.out[0]) <= 6 && Math.abs(P.ty - wk.op.out[1]) <= 6) { wk.near = wk.near || []; const kk = P.tx + ',' + P.ty + (W.isKantoCell(P.tx, P.ty) ? 'K' : ''); if (wk.near[wk.near.length - 1] !== kk) wk.near.push(kk); }   // (at the cut's mouth: its 4 cells around the out cell)
        if (i === wk.path.length - 1 && !P.moving) return { done: true, x: P.tx, y: P.ty, frames: wk.frames, wet: wk.wet };
        if (W.isWater(P.tx, P.ty)) wk.wet++;
        if (i === wk.path.length - 1) { h.tick({ capture: false }); wk.frames++; continue; }
        if (i === wk.last && !P.moving) {
          if (++wk.stuck > 60) {
            const [nx, ny] = wk.path[i + 1];
            const why = { solid: W.solid(nx, ny), water: W.isWater(nx, ny), mob: !!(h.G.ents || []).find((e) => e.tx === nx && e.ty === ny), wild: !!(h.G.wildAt && h.G.wildAt(nx, ny)), at: [nx, ny] };
            if (wk.replans.length >= 12) return { stuck: true, x: P.tx, y: P.ty, i, frames: wk.frames, why };
            window.__walkLib.ban.add(ny * 4096 + nx);
            const r = window.__walkLib.route(P.tx, P.ty, wk.op, wk.passed);
            wk.replans.push(why);
            if (!r.path) return { stuck: true, x: P.tx, y: P.ty, i, frames: wk.frames, why, noRoute: true };
            window.__walkLib.ban.delete(ny * 4096 + nx);
            wk.path = r.path; wk.idx = new Map(wk.path.map(([x, y], k) => [y * 4096 + x, k])); wk.stuck = 0; wk.last = -1;
            continue;
          }
        } else wk.stuck = 0;
        wk.last = i;
        const [nx, ny] = wk.path[i + 1], dx = Math.sign(nx - P.tx), dy = Math.sign(ny - P.ty);
        const dir = dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up';
        h.tick({ hold: dir, capture: false });
        wk.frames++;
        if (h.state() !== 'play') { for (let k = 0; k < 30 && h.state() !== 'play'; k++) h.tick({ press: 'a', capture: false }); }
      }
      return { going: true, i: wk.idx.get(P.ty * 4096 + P.tx), n: wk.path.length, frames: wk.frames };
    });
    if (!res.going) break;
    if (round % 5 === 0) log(`walking: ${res.i} / ${res.n} cells, ${res.frames} frames`);
  }
  const fin = await run(() => {
    const h = window.__rs, P = h.P, W = h.world, A = h.A, K = W.layout.kanto, wk = window.__walk;
    const m = W.mapAt(P.tx, P.ty);
    // the cut: path cells that are Kanto's own and trees or rock in Classic
    let cut = 0;
    for (const [x, y] of wk.path) {   // (the last plan's cells: the cut is always in it, Steve's out cell comes first)
      if (!W.isKantoCell(x, y)) continue;
      const mat = A.world.entries[A.grid[(y - K.y) * 408 + (x - K.x)]][4];
      if (mat === 'tree' || mat === 'rock' || /_ore$/.test(mat)) cut++;
    }
    return { x: P.tx, y: P.ty, map: m && m.id, gen: !!(m && m.gen), kanto: W.isKantoCell(P.tx, P.ty), cut, want: wk.op.in, opMap: wk.op.map, passed: wk.passed, near: (wk.near || []).slice(0, 40), out: wk.op.out, replans: wk.replans, errors: (h.G.errors || []).slice(0, 4) };
  });
  check(res && res.done && fin.passed && fin.x === fin.want[0] && fin.y === fin.want[1] && fin.kanto && !fin.gen && /^MAP_/.test(fin.map || '') && fin.cut >= 2,
    `Steve walked about ${plan.len} cells in ${res && res.frames} frames from the spawn into Kanto through the opening's out cell: he stands at (${fin.x}, ${fin.y}) in ${fin.map} (the opening's map ${fin.opMap}), crossing ${fin.cut} cells that are trees or rock in Classic, ${res && res.wet} frames in water, ${fin.replans.length} re-plans around creatures ${JSON.stringify(fin.replans.slice(0, 3))} ${res && res.stuck ? 'STUCK at ' + res.x + ',' + res.y + ' ' + JSON.stringify(res.why) : ''}${res && res.off ? 'OFF the path at ' + res.x + ',' + res.y : ''}${fin.passed ? '' : ' NOT through the mouth: out ' + fin.out + ', near it ' + fin.near.join(' ')}`);

  // ---------------------------------------------------------------- 4. the cut, seen
  await run(() => { const h = window.__rs, o = window.__walk.op; h.teleport(o.out[0] - o.n[0] * 5, o.out[1] - o.n[1] * 5, o.n[1] > 0 ? 'down' : 'up'); });
  await idle(6);
  await shot('cut');
  const errs = await run(() => (window.__rs.G.errors || []).slice(0, 5));
  check(!errs.length, `no G.errors ${errs.join(' | ')}`);
  log('done');
}
