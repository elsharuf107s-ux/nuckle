// Survival progression in a Wild World (design 11.4; stage 11). One fixed seed, start to finish:
//
//   node tools/headless.mjs tools/gen_tests/progression.mjs --params '?new&play&world=wild&wseed=1' --port 5610 --out <dir>
//
//   1. punch a tree with bare hands (held A) for its species' logs; planks, sticks and a crafting table in the 2 x 2
//      grid (the recipe book's fill, then the result); the table placed with B and opened with B; a wooden pickaxe;
//   2. a hill mined with held A (cobblestone); a stone pickaxe and a furnace at the table;
//   3. the nearest cave of the plan entered through its mouth; coal and iron tunnelled to and mined (target +
//      finishBreak) and picked up; the furnace smelts the iron with the coal through its screen; an iron pickaxe;
//   4. B2F by the ladder; a diamond mined with the iron pickaxe; a bucket filled at water poured on cave lava: obsidian;
//   5. a village farmer takes 20 wheat for an emerald (three times) and a cleric sells a potion for 3 emeralds;
//   6. a bed placed near the spawn and slept in (the home bed); a portal built (buildPortal; one obsidian is the real
//      one) and lit; through it to the Nether; SAVE there, reload, the way back lands on the portal;
//   7. eyes of ender thrown from the spawn lead to the planned entrance (each walk ends nearer, eyes used recorded);
//      the entrance mined open and walked into; the frames filled (giveEndKit-assisted); The End; the dragon killed;
//      saved in The End, reloaded, the exit portal: the Hall of Fame, then home at the bed.
// Teleports between steps are allowed (11.4); every step checks world state and G.errors.
export default async function (t) {
  const { page, R, run, tick, idle, shot, check, log } = t;
  const url = page.url().replace(/\?.*$/, '');
  const prep = async () => {
    await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
    await run(() => { const h = window.__rs; h.pause(); h.seed(11); h.rules.encounters = false; h.G.rules.mobs = false; h.G.rules.wild = false; });
  };
  const load = async (q) => { for (let k = 0; ; k++) { try { await page.goto(url + q); await prep(); return; } catch (e) { if (k >= 2) throw e; log('reload after', String(e).slice(0, 120)); } } };
  const errs = async () => R('(G.errors || []).slice(0, 2)');
  const noErr = async (step) => { const e = await errs(); check(!e.length, `${step}: no G.errors ${e.join(' | ')}`); };
  const frames = (n) => run((n) => { const h = window.__rs; for (let i = 0; i < n; i++) h.tick({ capture: false }); return h.G.time; }, n);
  await prep();
  await run(() => { const h = window.__rs; h.clearInv(); h.setTime(1000); h.P.health = 20; h.P.food = 20; });

  // page helpers: ring search, a free standing cell, the crafting grid through the game's screen
  await run(() => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL;
    window.__pg = {
      walkable: (x, y) => W.isOutdoor(x, y) && PL.canEnter({ riding: null }, x, y) === 'walk' && !W.isWater(x, y) && !W.warpAt(x, y) && !W.block(x, y) && !W.jumpDir(x, y),
      async ring(x0, y0, rmax, pred, step = 1) {
        for (let r = 0; r <= rmax; r++) {
          if (r % 12 === 0) await h.ensure(x0, y0, Math.min(3, 1 + Math.floor(r / 16)));
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = x0 + dx * step, y = y0 + dy * step;
            if (W.inside(x, y) && W.ready(x, y) && pred(x, y)) return [x, y];
          }
        }
        return null;
      },
      // craft one `out` (an id or a regex source) in the 2 x 2 (inventory) or the open 3 x 3 screen
      craft(out, n = 1) {
        const I = window.__I, s = h.screen();
        let made = 0;
        for (let k = 0; k < n; k++) {
          const size = s.size || (s.kind === 'craft' ? 3 : 2);
          const rec = I.craftable(G.inv, size).find((r) => (out.startsWith('/') ? new RegExp(out.slice(1, -1)).test(r.out) : r.out === out));
          if (!rec) break;
          s.fillRecipe(rec);
          if (!s.result()) { s.returnGrid(); break; }
          made += s.takeResult(true);
        }
        return made;
      },
      // drops near Steve picked up by standing next to them (real pickup in updateDrops)
      collect(r = 6) {
        const items = G.ents.filter((e) => e.type === 'item' && Math.abs(e.x / 16 - P.tx) <= r && Math.abs(e.y / 16 - P.ty) <= r);
        const back = [P.tx, P.ty, P.dir];
        for (const e of items) {
          if (e.dead) continue;
          const ex = Math.floor(e.x / 16), ey = Math.floor(e.y / 16);
          let at = null;
          for (const [dx, dy] of [[0, 0], [0, 1], [1, 0], [-1, 0], [0, -1]]) if (PL.canEnter({ riding: null }, ex + dx, ey + dy) === 'walk') { at = [ex + dx, ey + dy]; break; }
          if (!at) continue;
          PL.placePlayer(P, at[0], at[1], P.dir);
          for (let i = 0; i < 25 && !e.dead; i++) h.tick({ capture: false });
        }
        PL.placePlayer(P, back[0], back[1], back[2]);
        return items.filter((e) => e.dead).length;
      },
    };
  });
  await run(async () => { window.__I = await import('/src/items.js'); });
  const sp = await R('[G.worldSpawn.x, G.worldSpawn.y]');
  log('spawn', sp);

  // ---------------------------------------------------------------- 1. a tree by hand, planks, table, wooden pickaxe
  const punchTree = async () => {
    const tr = await run(async (sp) => {
      const h = window.__rs, W = h.world;
      const c = await window.__pg.ring(sp[0], sp[1], 40, (x, y) => !!W.findTree(x, y) && window.__pg.walkable(x, y + 1));
      if (!c) return null;
      h.teleport(c[0], c[1] + 1, 'up'); h.G.inv.sel = 8; h.G.inv.slots[8] = null;
      return c;
    }, sp);
    if (!tr) return { none: true };
    let n = 0;
    for (; n < 900 && (await R(`!!W.findTree(${tr[0]}, ${tr[1]})`)); n++) await tick({ hold: 'a' });
    await idle(20);
    const got = await run(() => window.__pg.collect(8));
    return { at: tr, frames: n, gone: !(await R(`!!W.findTree(${tr[0]}, ${tr[1]})`)), got };
  };
  const logs = () => R(`G.inv.slots.filter((s) => s && /_log$/.test(s.id)).reduce((a, s) => a + s.n, 0)`);
  const t1 = await punchTree();
  log('tree', JSON.stringify(t1));
  const logId = await R(`(G.inv.slots.find((s) => s && /_log$/.test(s.id)) || {}).id || null`);
  check(t1.gone && !!logId, `a tree punched down with bare hands in ${t1.frames} frames (${(t1.frames / 30).toFixed(1)} s); its drops picked up: ${await logs()} ${logId}`);
  await shot('p1_tree');
  for (let k = 0; k < 4 && (await logs()) < 3; k++) await punchTree();
  const c1 = await run(() => {
    const h = window.__rs, G = h.G, pg = window.__pg;
    h.openScreen('inventory');
    const planks = pg.craft('/_planks$/', 3), sticks = pg.craft('stick', 1), table = pg.craft('crafting_table', 1);
    h.screen().close(); h.setState('play');
    return { planks, sticks, table, inv: G.inv.slots.filter(Boolean).map((s) => s.id + ' ' + s.n) };
  });
  log('2x2', JSON.stringify(c1));
  check(c1.planks >= 3 && c1.sticks >= 1 && c1.table === 1, `the 2 x 2 grid makes planks (x${c1.planks}), sticks and a crafting table: ${c1.inv.join(', ')}`);
  // the table placed with B, opened with B
  const table = await run(async (sp) => {
    const h = window.__rs, W = h.world, G = h.G;
    const c = await window.__pg.ring(sp[0], sp[1], 20, (x, y) => window.__pg.walkable(x, y) && window.__pg.walkable(x, y + 1) && W.isFloor(x, y));
    h.teleport(c[0], c[1] + 1, 'up');
    const k = G.inv.slots.findIndex((s) => s && s.id === 'crafting_table'); G.inv.sel = k;
    return c;
  }, sp);
  await tick({ press: 'b' }); await idle(4);
  const placed = await R(`(W.block(${table[0]}, ${table[1]}) || {}).id`);
  await run(() => { const G = window.__rs.G; G.inv.sel = G.inv.slots.findIndex((s) => !s); if (G.inv.sel < 0) G.inv.sel = 8; });
  await tick({ press: 'b' }); await idle(3);
  const opened = await R(`h.state() === 'screen' && h.screen() && h.screen().kind`);
  check(placed === 'crafting_table' && opened === 'craft', `the crafting table placed with B (${placed}) and opened with B (${opened})`);
  const c2 = await run(() => { const pg = window.__pg, h = window.__rs; const w = pg.craft('wooden_pickaxe'); h.screen().close(); h.setState('play'); return w; });
  check(c2 === 1 && (await R(`G.inv.count('wooden_pickaxe')`)) === 1, 'a wooden pickaxe at the table');
  await noErr('wood');

  // ---------------------------------------------------------------- 2. a hill mined with held A; stone pickaxe, furnace
  const rock = await run(async (sp) => {
    const h = window.__rs, W = h.world, G = h.G, pg = window.__pg;
    const c = await pg.ring(sp[0], sp[1], 120, (x, y) => W.mat(x, y) === 'rock' && !W.protAt(x, y) && pg.walkable(x, y + 1), 1);
    if (!c) return null;
    h.teleport(c[0], c[1] + 1, 'up');
    G.inv.sel = G.inv.slots.findIndex((s) => s && s.id === 'wooden_pickaxe');
    return c;
  }, sp);
  check(!!rock, `rock near the spawn at ${rock}`);
  let mined = 0, held = 0;
  const cobble0 = await R(`G.inv.count('cobblestone')`);
  for (let k = 0; k < 20 && rock && (await R(`G.inv.count('cobblestone')`)) - cobble0 < 11; k++) {
    // the next rock cell of the hill (nearest the first) with a free cell beside it; Steve steps there and faces it
    const tgt = await run((rk) => {
      const h = window.__rs, W = h.world, P = h.P, PL = h.PL;
      for (let r = 0; r <= 10; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = rk[0] + dx, y = rk[1] + dy;
        if (W.mat(x, y) !== 'rock' || W.protAt(x, y)) continue;
        for (const [sx, sy, dir] of [[0, 1, 'up'], [1, 0, 'left'], [-1, 0, 'right'], [0, -1, 'down']]) {
          if (PL.canEnter({ riding: null }, x + sx, y + sy) !== 'walk' || W.isWater(x + sx, y + sy) || W.warpAt(x + sx, y + sy)) continue;
          PL.placePlayer(P, x + sx, y + sy, dir);
          const tg = PL.target(P);
          if (tg && tg.kind === 'tile' && tg.mat === 'rock' && tg.x === x && tg.y === y) return [x, y];
        }
      }
      return null;
    }, rock);
    if (!tgt) break;
    let n = 0;
    for (; n < 300 && (await R(`W.mat(${tgt[0]}, ${tgt[1]}) === 'rock'`)); n++) await tick({ hold: 'a' });
    held += n; mined++;
    await idle(15);
    await run(() => window.__pg.collect(3));
  }
  const cobble = (await R(`G.inv.count('cobblestone')`)) - cobble0;
  check(cobble >= 11, `a hill mined with held A and a wooden pickaxe: ${mined} cells in ${(held / 30).toFixed(1)} s, ${cobble} cobblestone picked up`);
  await shot('p2_hill');
  const c3 = await run((tb) => {
    const h = window.__rs; h.teleport(tb[0], tb[1] + 1, 'up'); h.openScreen('craft', h.world.block(tb[0], tb[1]));
    const pg = window.__pg, sp = pg.craft('stone_pickaxe'), fu = pg.craft('furnace'), st = pg.craft('stick', 1);
    h.screen().close(); h.setState('play');
    return { sp, fu, st };
  }, table);
  // the furnace placed with B next to the table
  const furnaceAt = await run(async (tb) => {
    const h = window.__rs, W = h.world, G = h.G, pg = window.__pg;
    const c = await pg.ring(tb[0] + 2, tb[1], 10, (x, y) => pg.walkable(x, y) && pg.walkable(x, y + 1) && W.isFloor(x, y));
    h.teleport(c[0], c[1] + 1, 'up');
    G.inv.sel = G.inv.slots.findIndex((s) => s && s.id === 'furnace');
    h.tick({ press: 'b', capture: false }); for (let i = 0; i < 4; i++) h.tick({ capture: false });
    return (W.block(c[0], c[1]) || {}).id === 'furnace' ? c : null;
  }, table);
  check(!!furnaceAt, `the furnace placed with B beside the table at ${furnaceAt}`);
  check(c3.sp === 1 && c3.fu === 1, `a stone pickaxe and a furnace at the table (${JSON.stringify(c3)})`);
  await noErr('stone');

  // ---------------------------------------------------------------- 3. a cave: coal and iron; smelting; iron pickaxe
  const cave = await run(async (sp) => {
    const h = window.__rs, W = h.world, plan = h.gen.plan(), L = W.layout;
    const caves = plan.caves.filter((c) => c.b2).map((c) => ({ c, d: Math.abs(L.ox + c.x - sp[0]) + Math.abs(L.oy + c.y - sp[1]) })).sort((a, b) => a.d - b.d);
    const c = (caves.find((q) => q.c.family === 'mountain') || caves[0]).c;
    const mx = L.ox + c.x, my = L.oy + c.y;
    await W.ensureAround(mx, my, 1);
    h.teleport(mx, my + 1, 'up');
    return { id: c.id, family: c.family, mx, my, d: Math.abs(mx - sp[0]) + Math.abs(my - sp[1]) };
  }, sp);
  log('cave', JSON.stringify(cave));
  for (let i = 0; i < 90; i++) { await tick({ hold: 'up', press: i === 0 ? 'up' : undefined }); if (await R("h.state() === 'play' && W.roomAt(P.tx, P.ty)")) break; }
  await idle(30);
  const in1 = await R(`(W.roomAt(P.tx, P.ty) || {}).id`);
  check(in1 === `GEN_CAVE_${cave.id}_B1F`, `walked into the plan's cave ${cave.id} (${cave.family}, ${cave.d} cells from the spawn): ${in1}`);
  await shot('p3_cave');
  // tunnel to the nearest ore of a kind in the room Steve is in (or any cave room), mine it, pick the drop up
  const mineOre = (kind, pick) => run(async ({ kind, pick }) => {
    const h = window.__rs, W = h.world, P = h.P, G = h.G, PL = h.PL;
    const here = W.roomAt(P.tx, P.ty);
    let best = null;
    const rooms = [...W.roomInfo].filter(([, r]) => !r.house).sort((a, b) => (a[0] === (here && here.id) ? -1 : 0) - (b[0] === (here && here.id) ? -1 : 0));
    for (const [id, r] of rooms) {
      if (here && id !== here.id && best) break;
      for (let y = r.y + 1; y < r.y + r.h - 1 && !best; y++) for (let x = r.x + 1; x < r.x + r.w - 1 && !best; x++) {
        if (W.entries[W.tile(x, y)][4] !== kind) continue;
        for (let d = 1; d <= 6 && !best; d++) for (let dy = -d; dy <= d && !best; dy++) for (let dx = -d; dx <= d; dx++) {
          const X = x + dx, Y = y + dy;
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== d || X <= r.x || Y <= r.y || X >= r.x + r.w - 1 || Y >= r.y + r.h - 1) continue;
          if (!W.col[Y * W.W + X] && !W.block(X, Y) && !W.warpAt(X, Y)) { best = { id, x, y, fx: X, fy: Y }; break; }
        }
      }
      if (best) break;
    }
    if (!best) return { kind, none: true };
    G.inv.sel = G.inv.slots.findIndex((s) => s && s.id === pick);
    if (W.roomAt(P.tx, P.ty) && W.roomAt(P.tx, P.ty).id !== best.id) return { kind, none: true, other: best.id };
    h.teleport(best.fx, best.fy, 'up');
    let x = best.fx, y = best.fy, walls = 0;
    for (let k = 0; k < 20; k++) {
      const dir = x < best.x ? 'right' : x > best.x ? 'left' : y < best.y ? 'down' : 'up';
      const nx = x + (dir === 'right' ? 1 : dir === 'left' ? -1 : 0), ny = y + (dir === 'down' ? 1 : dir === 'up' ? -1 : 0);
      PL.placePlayer(P, x, y, dir);
      if (nx === best.x && ny === best.y) break;
      if (W.col[ny * W.W + nx]) { const tg = PL.target(P); if (!tg || tg.kind !== 'tile') return { kind, err: 'no wall target' }; PL.finishBreak(P, tg); walls++; }
      x = nx; y = ny;
    }
    const tg = PL.target(P);
    if (!tg || tg.kind !== 'tile' || tg.mat !== kind) return { kind, err: 'ore not in front' };
    const drop = (window.__I.item(kind) || {}).drop;
    PL.finishBreak(P, tg);
    for (let i = 0; i < 40; i++) h.tick({ capture: false });
    window.__pg.collect(3);
    return { kind, room: best.id, at: [best.x, best.y], walls, now: W.entries[W.tile(best.x, best.y)][4], drop };
  }, { kind, pick });
  const ores = [];
  const c0 = await R(`G.inv.count('coal')`);
  ores.push(await mineOre('coal_ore', 'stone_pickaxe'));
  for (let k = 0; k < 6 && (await R(`G.inv.count('raw_iron')`)) < 6; k++) { const r = await mineOre('iron_ore', 'stone_pickaxe'); ores.push(r); if (r.none || r.err) break; }
  log('ores', JSON.stringify(ores));
  const inv3 = await R(`({ coal: G.inv.count('coal'), iron: G.inv.count('raw_iron') })`);
  check(inv3.coal > c0 && inv3.iron >= 3, `coal and iron tunnelled to and mined with the stone pickaxe, drops picked up: ${inv3.coal} coal, ${inv3.iron} raw iron (${ores.length} ores)`);
  await shot('p3_mined');
  // back at the furnace (a teleport between steps): opened with B, fed raw iron and coal by shift-click
  const b1pos = await R('[P.tx, P.ty]');
  const fur = await run((fa) => {
    const h = window.__rs, W = h.world, G = h.G;
    h.teleport(fa[0], fa[1] + 1, 'up');
    G.inv.sel = G.inv.slots.findIndex((s) => !s || s.id === 'wooden_pickaxe');
    h.tick({ press: 'b', capture: false });
    const s = h.screen(), b = W.block(fa[0], fa[1]);
    if (!s || s.kind !== 'furnace') return { err: 'not opened ' + h.state() };
    const iron = s.slots.find((q) => q.kind === 'inv' && q.get() && q.get().id === 'raw_iron');
    s.click(iron, 0, true);
    const coal = s.slots.find((q) => q.kind === 'inv' && q.get() && q.get().id === 'coal');
    if (coal) s.click(coal, 0, true);
    return { at: fa, input: b.input, fuel: b.fuel };
  }, furnaceAt);
  check(!fur.err && fur.input && fur.input.id === 'raw_iron' && fur.fuel && fur.fuel.id === 'coal', `the furnace opened with B, fed raw iron and coal by shift-click (${JSON.stringify(fur)})`);
  let ingots = 0;
  for (let k = 0; k < 40 && ingots < Math.min(6, fur.input ? fur.input.n : 0); k++) {
    await frames(60);
    ingots = await run(() => { const s = window.__rs.screen(), o = s && s.target && s.target.output; return o && o.id === 'iron_ingot' ? o.n : 0; });
  }
  await shot('p3_furnace');
  const got3 = await run(() => { const h = window.__rs, s = h.screen(), out = s.slots.find((q) => q.kind === 'fout'); s.click(out, 0, true); s.close(); h.setState('play'); return h.G.inv.count('iron_ingot'); });
  check(got3 >= 3, `the furnace smelted ${ingots} iron ingots with coal in real ticks; ${got3} taken out`);
  // the 3 x 3 grid at the table for the iron pickaxe and a bucket
  const c4 = await run((tb) => {
    const h = window.__rs, G = h.G, pg = window.__pg;
    h.teleport(tb[0], tb[1] + 1, 'up'); h.openScreen('craft', h.world.block(tb[0], tb[1]));
    const pk = pg.craft('iron_pickaxe'), bk = pg.craft('bucket');
    h.screen().close(); h.setState('play');
    return { pk, bk, iron: G.inv.count('iron_ingot') };
  }, table);
  check(c4.pk === 1, `an iron pickaxe crafted (bucket ${c4.bk ? 'too' : 'not: ' + c4.iron + ' ingots left'})`);
  await noErr('cave');

  // ---------------------------------------------------------------- 4. B2F, a diamond, obsidian
  const lad = await run((c) => { const W = window.__rs.world; const w = W.warps.find((q) => q.map === `GEN_CAVE_${c.id}_B1F` && q.trig === 'step'); return w ? { x: w.x, y: w.y } : null; }, cave);
  await run((p) => window.__rs.teleport(p[0], p[1]), b1pos);
  await run((l) => { window.__rs.teleport(l.x, l.y + 1, 'up'); }, lad);
  for (let i = 0; i < 90; i++) { await tick({ hold: 'up', press: i === 0 ? 'up' : undefined }); if (await R(`h.state() === 'play' && W.roomAt(P.tx, P.ty) && W.roomAt(P.tx, P.ty).id.endsWith('B2F')`)) break; }
  await idle(20);
  check(await R(`(W.roomAt(P.tx, P.ty) || {}).id === 'GEN_CAVE_${cave.id}_B2F'`), 'down the ladder to B2F');
  const dia0 = await R(`G.inv.count('diamond')`);
  const dm = await mineOre('diamond_ore', 'iron_pickaxe');
  log('diamond', JSON.stringify(dm));
  check(!dm.none && !dm.err && (await R(`G.inv.count('diamond')`)) > dia0, `a diamond mined on B2F with the iron pickaxe and picked up (${JSON.stringify(dm.at)})`);
  await shot('p4_diamond');
  // a bucket of water: filled at the nearest water outside if none in the cave; poured on the B2F lava
  if (!(await R(`G.inv.count('bucket')`))) await R(`(h.give('bucket', 1), 1)`);
  const lavaCells = await R(`(W.meta.lava || []).filter((l) => l.map === 'GEN_CAVE_${cave.id}_B2F').length`);
  let ob = { skipped: 'no lava on this B2F' };
  if (lavaCells) {
    const b2pos = await R('[P.tx, P.ty]');
    const filled = await run(async (sp) => {
      const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL, pg = window.__pg;
      const c = await pg.ring(sp[0], sp[1], 60, (x, y) => W.isWater(x, y) && W.isOutdoor(x, y) && pg.walkable(x, y + 1));
      if (!c) return false;
      h.teleport(c[0], c[1] + 1, 'up');
      G.inv.sel = G.inv.slots.findIndex((s) => s && s.id === 'bucket');
      h.tick({ press: 'b', capture: false });
      return G.inv.count('water_bucket') === 1;
    }, sp);
    check(filled, 'a bucket filled with water with B');
    await run((p) => window.__rs.teleport(p[0], p[1]), b2pos);
    ob = await run((id) => {
      const h = window.__rs, W = h.world, P = h.P, G = h.G, PL = h.PL;
      const lava = W.meta.lava.filter((l) => l.map === `GEN_CAVE_${id}_B2F`);
      for (const l of lava) for (const [dx, dy, dir] of [[0, 1, 'up'], [0, -1, 'down'], [1, 0, 'left'], [-1, 0, 'right']]) {
        const x = l.x + dx, y = l.y + dy;
        if (W.col[y * W.W + x] || W.block(x, y) || W.isLava(x, y)) continue;
        h.teleport(x, y, dir);
        G.inv.sel = G.inv.slots.findIndex((s) => s && s.id === 'water_bucket');
        h.tick({ press: 'b', capture: false });
        const b = W.block(l.x, l.y);
        return { block: b && b.id, held: G.inv.held && G.inv.held.id, at: [l.x, l.y] };
      }
      return { none: true };
    }, cave.id);
  }
  log('obsidian', JSON.stringify(ob));
  check(ob.skipped || ob.block === 'obsidian', `water poured on B2F lava with B makes obsidian (${JSON.stringify(ob)})`);
  await idle(4);
  await shot('p4_obsidian');
  await noErr('B2F');

  // ---------------------------------------------------------------- 5. trades: a farmer (wheat), a cleric (potion)
  const tr = await run(async (sp) => {
    const h = window.__rs, W = h.world, G = h.G, plan = h.gen.plan(), L = W.layout, out = {};
    h.setTime(6000);
    const vs = plan.villages.map((v) => ({ v, d: Math.abs(L.ox + v.plaza[0] - sp[0]) + Math.abs(L.oy + v.plaza[1] - sp[1]) })).sort((a, b) => a.d - b.d);
    for (const { v, d } of vs) {
      for (let y = v.y0; y < v.y0 + v.h + 31; y += 16) for (let x = v.x0; x < v.x0 + v.w + 31; x += 16) await W.ensureAround(L.ox + Math.min(x, v.x0 + v.w - 1), L.oy + Math.min(y, v.y0 + v.h - 1), 1);
      h.teleport(L.ox + v.plaza[0] + 4, L.oy + v.plaza[1] + 6, 'down');
      for (let i = 0; i < 45; i++) h.tick({ capture: false });
      const rec = G.vil.recOf(v.id);
      const f = rec && rec.list.find((m) => m.prof === 'farmer' && G.ents.includes(m)), c = rec && rec.list.find((m) => m.prof === 'cleric' && G.ents.includes(m));
      const at = [L.ox + v.plaza[0] + 4, L.oy + v.plaza[1] + 6];
      if (!out.farmer && f) out.farmer = { vid: f.vid, v: v.id, d, at };
      if (!out.cleric && c) out.cleric = { vid: c.vid, v: v.id, d, at };
      if (out.farmer && out.cleric) break;
    }
    return out;
  }, sp);
  log('traders', JSON.stringify(tr));
  check(!!(tr.farmer && tr.cleric), `a farmer (village ${tr.farmer && tr.farmer.v}) and a cleric (village ${tr.cleric && tr.cleric.v}) near the spawn`);
  // Steve faces the villager and presses Z (A); the offer is picked and the result taken through the screen
  const tradeWith = (who, wantResult, give) => run(async ({ vid, at, wantResult, give }) => {
    const h = window.__rs, G = h.G, w = h.world;
    h.teleport(at[0], at[1], 'down'); for (let i = 0; i < 45; i++) h.tick({ capture: false });
    const m = G.ents.find((e) => e.vid === vid);
    if (!m) return { err: 'not loaded' };
    m.hold = 30; m.path = null;
    if (give) Object.assign(m, give);
    const ok = (x, y) => w.inside(x, y) && w.ready(x, y) && !w.solid(x, y) && !w.isWater(x, y) && !w.jumpDir(x, y) && !w.warpAt(x, y) && !G.ents.some((e) => e !== m && e.type === 'mob' && e.tx === x && e.ty === y);
    let faced = false;
    for (const [dx, dy, dir] of [[0, 1, 'up'], [0, -1, 'down'], [1, 0, 'left'], [-1, 0, 'right']]) { const x = m.tx + dx, y = m.ty + dy; if (ok(x, y)) { h.teleport(x, y, dir); h.P.dir = dir; faced = true; break; } }
    if (!faced) return { err: 'no cell beside it' };
    G.inv.sel = G.inv.slots.findIndex((s) => !s); if (G.inv.sel < 0 || G.inv.sel > 8) G.inv.sel = 8;
    h.tick({ press: 'a', capture: false });
    const s = h.screen();
    if (!s || s.kind !== 'trade') return { err: 'no trade screen: ' + h.state() };
    const i = s.offers.findIndex((o) => o.result === wantResult);
    if (i < 0) { s.done = true; h.tick({ capture: false }); return { err: 'no offer of ' + wantResult, offers: s.offers.map((o) => o.result) }; }
    s.selectOffer(i);
    const o = s.offers[i];
    const made = s.takeResult(true);
    const frame = h.frame();
    s.done = true; h.tick({ capture: false });
    return { made, o: `${o.nA} ${o.costA} -> ${o.nR} ${o.result}`, lvl: m.lvl || 1, state: h.state(), frame };
  }, { vid: who.vid, at: who.at, wantResult, give });
  await run(() => { window.__rs.give('wheat', 60); });
  const em0 = await R(`G.inv.count('emerald')`);
  const f1 = await tradeWith(tr.farmer, 'emerald');
  const em = await R(`G.inv.count('emerald')`);
  log('farmer', JSON.stringify({ ...f1, frame: undefined }));
  check(!f1.err && f1.made >= 3 && em - em0 >= 3 && (await R(`G.inv.count('wheat')`)) === 0, `Z faces a farmer: ${f1.o} (x${f1.made}), ${em - em0} emeralds for 60 wheat`);
  // the cleric's potion is a level 2 (Apprentice) offer: the cleric is given level 2's xp
  const p0 = await R(`G.inv.count('potion')`);
  const c5 = await tradeWith(tr.cleric, 'potion', { lvl: 2, xp: 10 });
  log('cleric', JSON.stringify({ ...c5, frame: undefined }));
  check(!c5.err && c5.made >= 1 && (await R(`G.inv.count('potion')`)) > p0, `a cleric (Apprentice) sells a potion: ${c5.o}; ${await R(`G.inv.count('emerald')`)} emeralds left`);
  if (c5.frame) { const { writeFileSync } = await import('node:fs'); writeFileSync(t.OUT + '/p5_cleric_trade.png', Buffer.from(c5.frame.split(',')[1], 'base64')); }
  await noErr('trades');

  // ---------------------------------------------------------------- 6. the home bed, the portal, the Nether, a reload
  const bed = await run(async (sp) => {
    const h = window.__rs, W = h.world, G = h.G, pg = window.__pg;
    const c = await pg.ring(sp[0] + 6, sp[1], 30, (x, y) => pg.walkable(x, y) && pg.walkable(x, y + 1) && pg.walkable(x, y - 1) && W.isFloor(x, y) && W.isFloor(x, y - 1));
    h.teleport(c[0], c[1] + 1, 'up');
    G.inv.slots[8] = { id: 'white_bed', n: 1 }; G.inv.sel = 8;
    return c;
  }, sp);
  await tick({ press: 'b' }); await idle(4);
  const bedB = await R(`(W.block(${bed[0]}, ${bed[1]}) || {}).id`);
  await R(`(h.setTime(13000), G.inv.sel = 7, G.inv.slots[7] = null, 1)`);
  await tick({ press: 'b' });
  for (let i = 0; i < 900 && !(await R(`h.state() === 'play' && !P.sleeping && G.time < 12000`)); i++) await tick({ press: i % 20 === 0 ? 'a' : undefined });
  const home = await R('G.spawnBed');
  check(bedB === 'white_bed' && Array.isArray(home), `a bed placed with B and slept in through the night: the home bed is ${JSON.stringify(home)} (time ${await R('G.time')})`);
  await R(`(h.setTime(6000), 1)`);
  const portal = await run(async (sp) => {
    const h = window.__rs, W = h.world, PL = h.PL, pg = window.__pg;
    const ok = (x, y) => PL.canEnter({ riding: null }, x, y) === 'walk' && !W.isWater(x, y) && !W.block(x, y) && !W.warpAt(x, y) && W.isFloor(x, y);
    const c = await pg.ring(sp[0] - 20, sp[1] - 20, 30, (x, y) => { for (let yy = y - 1; yy <= y + 4; yy++) for (let xx = x - 1; xx <= x + 2; xx++) if (!ok(xx, yy)) return false; return true; }, 2);
    return c;
  }, sp);
  check(!!portal, `dry ground for a portal at ${portal}`);
  // the obsidian Steve made is part of the ring (it is in the bag when he mined it; else the helper's)
  await run(([x, y]) => { const h = window.__rs; h.buildPortal(x, y, 2, 3); h.G.inv.slots[8] = { id: 'flint_and_steel', n: 1 }; h.G.inv.sel = 8; h.teleport(x, y + 4, 'up'); h.P.dir = 'up'; }, portal);
  // lit with flint and steel facing the ring's bottom edge (B); the helper lights it if the facing misses
  await tick({ press: 'b' }); await idle(4);
  let lit = await R(`W.isPortal(${portal[0]}, ${portal[1] + 2})`);
  const litBy = lit ? 'flint and steel' : 'lightPortal';
  if (!lit) { await R(`(h.lightPortal(${portal[0]}, ${portal[1]}), 1)`); lit = await R(`W.isPortal(${portal[0]}, ${portal[1] + 2})`); }
  check(lit, `the portal lit (${litBy})`);
  await R(`(h.teleport(${portal[0]}, ${portal[1] + 1}), G.portalCool = false, 1)`);
  for (let i = 0; i < 200 && !(await R('W.inNether(P.tx, P.ty)')); i++) await tick();
  await idle(20);
  const n1 = await R('({ n: W.inNether(P.tx, P.ty), lp: G.lastPortal, P: [P.tx, P.ty] })');
  check(n1.n && n1.lp, `standing in the portal takes him to the Nether (${JSON.stringify(n1.P)})`);
  await shot('p6_nether');
  check(await run(async () => !!(await window.__rs.save())), 'SAVE in the Nether');
  await load('?play');
  check(await R('W.inNether(P.tx, P.ty)'), 'the reload boots into the Nether');
  await run(() => window.__rs.travel(false));
  for (let i = 0; i < 200 && (await R("h.state() === 'genwait'")); i++) await tick();
  await idle(10);
  const r1 = await R('({ P: [P.tx, P.ty], nether: W.inNether(P.tx, P.ty), portal: W.isPortal(P.tx, P.ty) })');
  check(!r1.nether && r1.portal && r1.P[0] === n1.lp.x && r1.P[1] === n1.lp.y, `after the reload the return lands on the portal (${JSON.stringify(r1.P)}), not the spawn`);
  await noErr('Nether');

  // ---------------------------------------------------------------- 7. eyes, the stronghold, The End, home
  await run(async () => window.__I = await import('/src/items.js'));
  await R(`(h.teleport(G.worldSpawn.x, G.worldSpawn.y), G.inv.slots[0] = { id: 'eye_of_ender', n: 30 }, G.inv.sel = 0, 1)`);
  const eyes = await run(async () => {
    const h = window.__rs, W = h.world, P = h.P, PL = h.PL, E = W.stronghold.entrance;
    const walkNear = async (x, y) => {
      await h.ensure(x, y, 1);
      for (let r = 0; r <= 16; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const X = x + dx, Y = y + dy;
        if (W.isOutdoor(X, Y) && PL.canEnter({ riding: null }, X, Y) === 'walk' && !W.isWater(X, Y) && !W.warpAt(X, Y)) { h.teleport(X, Y); return true; }
      }
      return false;
    };
    const dist = () => Math.max(Math.abs(P.tx - E.x), Math.abs(P.ty - E.y));
    const ds = [dist()];
    let thrown = 0, L = 64, prev = null, done = false, turned = false;
    while (thrown < 30 && !done) {
      const e = h.END.throwEye(P, { fate: 'drop' });
      thrown++;
      let dx = e.x1 - e.x0, dy = e.y1 - e.y0;
      const mode = e.mode;
      h.END.resetTransient();
      if (mode === 'dive') { done = true; break; }
      let len = Math.hypot(dx, dy);
      if (len < 1) { const a = e.dir * Math.PI / 4; dx = Math.cos(a); dy = Math.sin(a); len = 1; }
      dx /= len; dy /= len;
      if (prev && (turned || dx * prev[0] + dy * prev[1] <= 0.01)) { turned = true; L = Math.max(2, Math.floor(L / 2)); }
      prev = [dx, dy];
      let moved = false;
      for (let k = L; k >= 2 && !moved; k = Math.floor(k / 2)) moved = await walkNear(Math.round(P.tx + dx * k), Math.round(P.ty + dy * k));
      if (!moved) break;
      ds.push(dist());
    }
    return { thrown, done, ds, ent: [E.x, E.y] };
  });
  log('eyes', JSON.stringify(eyes));
  const closer = eyes.ds.slice(1).filter((d, i) => d < eyes.ds[i]).length;
  check(eyes.done && closer >= eyes.ds.length - 1 - 2, `eyes of ender lead to the planned entrance: ${eyes.thrown} eyes used, distance after each walk ${eyes.ds.join(' > ')} (${closer} of ${eyes.ds.length - 1} walks ended nearer)`);
  const E = { x: eyes.ent[0], y: eyes.ent[1] };
  await run((E) => { const h = window.__rs; h.teleport(E.x, E.y + 1, 'up'); h.G.inv.sel = h.G.inv.slots.findIndex((s) => s && s.id === 'iron_pickaxe'); }, E);
  await idle(3);
  await shot('p7_ruin');
  for (let i = 0; i < 400 && !(await R('h.END.entranceOpen()')); i++) await tick({ hold: 'a' });
  check(await R('h.END.entranceOpen()'), 'the entrance mined open with held A and the iron pickaxe');
  let inS = false;
  for (let i = 0; i < 160 && !inS; i++) { await tick({ hold: 'up' }); inS = await R('W.inStronghold(P.tx, P.ty)'); }
  await idle(30);
  check(inS, 'walked down into the stronghold');
  await R('(h.giveEndKit(), h.fillFrames(12), 1)');
  check(await R('h.END.portalOpen()'), 'the twelve frames filled (giveEndKit-assisted): the End portal is open');
  await R('(h.enterEnd(), 1)');
  await idle(30);
  check(await R('W.inEnd(P.tx, P.ty)'), 'into The End');
  await R('(h.killCrystals(10), h.exhaustDragon(), h.DR.startDeath(), 1)');
  for (let i = 0; i < 900 && !(await R('!G.end.dragon.dying && G.end.kills === 1')); i++) { await tick(); if (i % 30 === 0) await R('(P.health = 20, 1)'); }
  check(await R('G.end.kills === 1 && G.end.exitActive'), 'the dragon killed: the exit portal is active');
  await shot('p7_end');
  check(await run(async () => !!(await window.__rs.save())), 'saved in The End');
  await load('?play');
  check(await R('W.inEnd(P.tx, P.ty) && G.end.kills === 1 && G.end.exitActive'), 'the reload boots into The End with the dragon dead');
  await R('(h.leaveEnd(), 1)');
  const hof = await R('h.state()');
  for (let i = 0; i < 3000 && (await R("h.state() !== 'play'")); i++) await tick({ press: i % 15 === 0 ? 'a' : undefined });
  for (let i = 0; i < 200 && (await R("h.state() === 'genwait'")); i++) await tick();
  await idle(20);
  const fin = await R('({ P: [P.tx, P.ty], bed: G.spawnBed, st: h.state(), end: W.inEnd(P.tx, P.ty) })');
  const dBed = fin.bed ? Math.max(Math.abs(fin.P[0] - fin.bed[0]), Math.abs(fin.P[1] - fin.bed[1])) : 99;
  check(hof === 'hof' && fin.st === 'play' && !fin.end && dBed <= 2, `the exit portal: the Hall of Fame (${hof}), then home at the bed ${JSON.stringify(fin.bed)} (Steve at ${JSON.stringify(fin.P)}, ${dBed} cells)`);
  await shot('p7_home');
  await noErr('the whole run');
}
