// Stage 5a: items and blocks of the world update (design 13, 5a; 3.5, 3.8, 4.3, 4.5).
//
//   node tools/headless.mjs tools/gen_tests/items.mjs --params '?new&play&world=wild&wseed=1' --port 5640 --out <dir>
//
//   1. crafting: every new recipe, recipe tags (#planks, #logs) with mixed woods, species-only recipes refuse other
//      woods, the recipe book counts tags and fills the grid from what the inventory has, smelting and fuel; and every
//      recipe of the baseline's items.json (passed in as BASE_ITEMS) still crafts exactly what it did;
//   2. planting: each of the six saplings planted with the real placeBlock and grown (growSapling) on every allowed
//      ground (temperate, cool, dry, lush and swamp grass, snow, podzol, mud), each tree its species' pieces (home on
//      its own ground, overlays elsewhere; a spruce on snow is the snowy spruce), then chopped: that wood's logs;
//      refused on sand, clay, ice and a path with "It won't grow here."; one screenshot per ground;
//   3. a natural generated tree near the spawn drops its species' logs;
//   4. decorations as blocks: sugar cane, cactus, dead bush, pumpkin, melon and lily pad break with their drops and a
//      saved removal, and go back down by their rules (cactus on sand, cane beside water, lily pad on water) drawn
//      top-down; walking into a cactus hurts 1, at most every half second;
//   5. grounds: a shovel on snow, clay, mud and podzol; ice broken with a pickaxe turns to water and the ice around
//      re-edges (screenshots).
import { readFileSync } from 'node:fs';

export default async function (t) {
  const { page, R, run, idle, shot, check, log } = t;
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
  await run(() => { const h = window.__rs; h.pause(); h.seed(5); if (h.rules) h.rules.encounters = false; h.G.rules.mobs = false; h.setTime(6000); });

  // the world update's icons come from icons_world.png in a generated world (icons.png keeps Classic's rows)
  const ic = await run(() => { const h = window.__rs; return { h: h.A.mc.icons.height, last: h.A.items.items.ice.iconIndex }; });
  check(ic.h >= (Math.floor(ic.last / 32) + 1) * 16, `a generated world draws icons from the full sheet (${ic.h} px tall, the ice icon at ${ic.last})`);

  // ---------------------------------------------------------------- 1. crafting
  const base = JSON.parse(readFileSync(process.env.BASE_ITEMS, 'utf8'));
  const cr = await run(async (baseRecipes) => {
    const I = await import('/src/items.js');
    const out = { fails: [] };
    const g = (ids, w = 3) => { const a = new Array(w * w).fill(null); ids.forEach((id, k) => { if (id) a[k] = { id, n: 1 }; }); return a; };
    const expect = (name, grid, w, id, n) => { const r = I.craft(grid, w, w); if (!(r && r.id === id && (n == null || r.n === n))) out.fails.push(`${name}: got ${r ? r.id + ' x' + r.n : 'nothing'}, want ${id}`); };
    const none = (name, grid, w) => { const r = I.craft(grid, w, w); if (r) out.fails.push(`${name}: crafted ${r.id}`); };
    const woods = ['oak', 'birch', 'spruce', 'dark_oak', 'acacia', 'jungle'];
    for (const w of woods) expect(w + ' planks', g([w + '_log'], 2), 2, w + '_planks', 4);
    expect('crafting table, mixed planks', g(['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks'], 2), 2, 'crafting_table', 1);
    expect('sticks, birch over acacia', g(['birch_planks', null, 'acacia_planks', null], 2), 2, 'stick', 4);
    expect('chest, mixed planks', g(['oak_planks', 'birch_planks', 'spruce_planks', 'dark_oak_planks', null, 'acacia_planks', 'jungle_planks', 'oak_planks', 'birch_planks']), 3, 'chest', 1);
    expect('wooden pickaxe, dark oak', g(['dark_oak_planks', 'dark_oak_planks', 'dark_oak_planks', null, 'stick', null, null, 'stick', null]), 3, 'wooden_pickaxe', 1);
    expect('wooden axe, mirrored, jungle', g(['jungle_planks', 'jungle_planks', null, 'stick', 'jungle_planks', null, 'stick', null, null]), 3, 'wooden_axe', 1);
    expect('campfire, mixed logs', g([null, 'stick', null, 'stick', 'coal', 'stick', 'spruce_log', 'acacia_log', 'birch_log']), 3, 'campfire', 1);
    expect('white bed, jungle planks', g(['white_wool', 'white_wool', 'white_wool', 'jungle_planks', 'jungle_planks', 'jungle_planks']), 3, 'white_bed', 1);
    expect('bookshelf, mixed', g(['oak_planks', 'birch_planks', 'spruce_planks', 'oak_planks', 'birch_planks', 'spruce_planks', 'acacia_planks', 'jungle_planks', 'dark_oak_planks']), 3, 'bookshelf', 1);
    expect('birch fence', g(['birch_planks', 'stick', 'birch_planks', 'birch_planks', 'stick', 'birch_planks']), 3, 'birch_fence', 3);
    expect('sugar', g(['sugar_cane'], 2), 2, 'sugar', 1);
    expect('paper', g(['sugar_cane', 'sugar_cane', 'sugar_cane']), 3, 'paper', 3);
    expect('melon', g(new Array(9).fill('melon_slice')), 3, 'melon', 1);
    expect('clay', g(['clay_ball', 'clay_ball', 'clay_ball', 'clay_ball'], 2), 2, 'clay', 1);
    expect('bricks', g(['brick', 'brick', 'brick', 'brick'], 2), 2, 'bricks', 1);
    expect('snow block', g(['snowball', 'snowball', 'snowball', 'snowball'], 2), 2, 'snow_block', 1);
    none('oak door refuses birch planks', g(['birch_planks', 'birch_planks', null, 'birch_planks', 'birch_planks', null, 'birch_planks', 'birch_planks', null]), 3);
    none('oak boat refuses spruce planks', g(['spruce_planks', null, 'spruce_planks', 'spruce_planks', 'spruce_planks', 'spruce_planks']), 3);
    none('a log is not planks', g(['birch_log', 'birch_log', 'birch_log', 'birch_log'], 2), 2);
    // smelting and fuel
    for (const w of woods) { const s = I.smeltOf(w + '_log'); if (!s || s[0] !== 'charcoal') out.fails.push(w + ' log does not smelt to charcoal'); if (I.fuelOf(w + '_planks') !== 300 || I.fuelOf(w + '_log') !== 300) out.fails.push(w + ' fuel'); if (I.fuelOf(w + '_sapling') !== 100) out.fails.push(w + ' sapling fuel'); }
    if ((I.smeltOf('clay_ball') || [])[0] !== 'brick') out.fails.push('clay ball does not fire to brick');
    // the baseline's every recipe, made with its own ids, crafts what the baseline's matcher made (first match wins)
    const oldShaped = (rec, rows) => {
      const R = rec.rows; if (R.length !== rows.length) return false;
      for (const mirror of [false, true]) {
        let ok = true;
        for (let y = 0; y < R.length && ok; y++) {
          const line = R[y]; if (line.length !== rows[y].length) { ok = false; break; }
          for (let x = 0; x < line.length; x++) { const ch = mirror ? line[line.length - 1 - x] : line[x]; const want = ch === ' ' ? null : rec.key[ch]; if (want !== rows[y][x]) { ok = false; break; } }
        }
        if (ok) return true;
      }
      return false;
    };
    const oldCraft = (grid, rows) => {
      for (const r of baseRecipes) {
        if (r.rows) { if (oldShaped(r, rows)) return r; }
        else { const have = grid.filter(Boolean).map((s) => s.id).sort(), want = [...r.ins].sort(); if (have.length === want.length && have.every((v, i) => v === want[i])) return r; }
      }
      return null;
    };
    let same = 0;
    for (const r of baseRecipes) {
      const grid = new Array(9).fill(null);
      if (r.rows) r.rows.forEach((line, y) => [...line].forEach((ch, x) => { if (ch !== ' ') grid[y * 3 + x] = { id: r.key[ch], n: 1 }; }));
      else r.ins.forEach((id, k) => { grid[k] = { id, n: 1 }; });
      let y0 = 9, y1 = -1, x0 = 9, x1 = -1;
      for (let k = 0; k < 9; k++) if (grid[k]) { y0 = Math.min(y0, (k / 3) | 0); y1 = Math.max(y1, (k / 3) | 0); x0 = Math.min(x0, k % 3); x1 = Math.max(x1, k % 3); }
      const rows = []; for (let y = y0; y <= y1; y++) { const l = []; for (let x = x0; x <= x1; x++) l.push(grid[y * 3 + x] ? grid[y * 3 + x].id : null); rows.push(l); }
      const want = oldCraft(grid, rows), got = I.craft(grid, 3, 3);
      if (want && got && got.id === want.out && got.n === want.n) same++;
      else out.fails.push(`baseline recipe ${r.out}: was ${want && want.out}, now ${got && got.id}`);
    }
    out.baseline = [same, baseRecipes.length];
    // the recipe book: tags counted across woods, and the grid filled from what the inventory has
    const h = window.__rs, G = h.G;
    h.clearInv(); h.give('oak_planks', 1); h.give('birch_planks', 2); h.give('jungle_planks', 1);
    const list = I.craftable(G.inv, 3).map((r) => r.out);
    out.book = list;
    if (!list.includes('crafting_table') || !list.includes('stick')) out.fails.push('recipe book misses the crafting table or sticks from mixed planks');
    if (list.includes('chest')) out.fails.push('recipe book offers a chest from 4 planks');
    h.openScreen('craft');
    const sc = h.screen(), rec = A_rec(I, G, 'crafting_table');
    sc.fillRecipe(rec);
    const filled = sc.grid.filter(Boolean).map((s) => s.id).sort();
    out.filled = filled;
    const made = I.craft(sc.grid, 3, 3);
    if (!(made && made.id === 'crafting_table') || filled.length !== 4 || G.inv.count('birch_planks') !== 0) out.fails.push('recipe book fill with mixed planks: ' + JSON.stringify(filled));
    sc.close(); h.setState('play');
    return out;
    function A_rec(I2, G2, id) { return I2.craftable(G2.inv, 3).find((r) => r.out === id); }
  }, base.recipes);
  log('crafting', JSON.stringify({ baseline: cr.baseline, book: cr.book, filled: cr.filled }));
  for (const f of cr.fails) check(false, f);
  check(cr.fails.length === 0, `crafting: every new recipe, tags, the recipe book and smelting (${cr.baseline[0]} of ${cr.baseline[1]} baseline recipes unchanged)`);

  // ---------------------------------------------------------------- 2. planting and growing on every ground
  const setup = await run(async () => {
    const h = window.__rs, W = h.world, T = h.A.terrain, sp = h.gen.plan().spawn;
    const ve = (v, m) => W.entryFor(v, m);
    const grounds = {
      temperate: 1, cool: ve(1, 1), dry: ve(2, 1), lush: ve(3, 1), swamp: ve(4, 1),
      snow: T.synth.grounds.snow[0], snowy_grass: ve(T.rockStyles.snowy.var, 1), podzol: T.synth.grounds.podzol[0], mud: T.synth.grounds.mud[0],
      sand: 277, clay: T.synth.grounds.clay[0], ice: T.synth.grounds.ice[0], path: T.quarter.sets.C.recolours.dirt.home[0],
    };
    return { sp: [sp.px, sp.py], grounds };
  });
  log('grounds', JSON.stringify(setup.grounds));
  // a 20 x 8 patch of one ground, cleared of trees and blocks (the chunk's own ground array too, so breaking and
  // overlays read it), well away from the spawn so patches never touch
  const paint = (x0, y0, g, w = 20, hh = 8) => run(async ([x0, y0, g, w, hh]) => {
    const h = window.__rs, W = h.world;
    await h.ensure(x0 + w / 2, y0 + hh / 2, 2);
    for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + w; x++) {
      const ck = (y >> 5) * 63 + (x >> 5), k = (y & 31) * 32 + (x & 31);
      if (W.cground[ck]) W.cground[ck][k] = g;
      if (W.cbase[ck]) W.cbase[ck][k] = g;
      W.blocks.delete(y * W.W + x); W.bover.set(y * W.W + x, 0);
      W.setTile(x, y, g);
      W.zone[y * W.W + x] = 0;
    }
    W.chunks.clear();
    return W.cstate.length;
  }, [x0, y0, g, w, hh]);
  const CW = await R('window.__rs.world.layout.desc ? 0 : 0');
  void CW;
  const PLANE_CW = await run(async () => (await import('/src/layout.js')).PLANE.CW);
  check(PLANE_CW === 63, 'the plane is 63 data chunks wide (the test paints chunk arrays by it)');

  const woods = ['oak', 'birch', 'spruce', 'dark_oak', 'acacia', 'jungle'];
  const allowed = ['temperate', 'cool', 'dry', 'lush', 'swamp', 'snow', 'snowy_grass', 'podzol', 'mud'];
  const refused = ['sand', 'clay', 'ice', 'path'];
  let row = 0;
  const shots = [];
  for (const gname of allowed.concat(refused)) {
    const x0 = setup.sp[0] - 60, y0 = setup.sp[1] - 140 + row * 12; row++;
    await paint(x0, y0, setup.grounds[gname], 18, 10);
    const res = await run(([x0, y0, woods, refuse]) => {
      const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL;
      const out = { trees: [], refusedOk: true, msg: null };
      woods.forEach((w, k) => {
        // two rows of three, 4 columns apart, so one view shows all six
        const lx = x0 + 3 + 4 * (k % 3), cy = y0 + 2 + 4 * ((k / 3) | 0);
        h.clearInv(); h.give(w + '_sapling', 1, 0); G.inv.sel = 0;
        PL.placePlayer(P, lx, cy + 2, 'up'); G.actionBar = null;
        const put = PL.placeBlock(P, G.inv.held, { x: lx, y: cy });
        const b = W.block(lx, cy);
        if (refuse) { if (put || b || G.inv.count(w + '_sapling') !== 1) out.refusedOk = false; out.msg = G.actionBar && G.actionBar.text; return; }
        const placed = !!put && b && b.id === w + '_sapling' && G.inv.count(w + '_sapling') === 0;
        const grew = placed && h.G.growSapling(lx, cy);
        const v = W.varOf[W.tile(lx, cy)], name = W.specOfVar[v] || (v === 0 ? 'oak' : '?');
        // every cell of the tree: home pieces where the cell's ground is the species' home ground, overlays elsewhere
        let pieces = 0, wrong = 0;
        for (let yy = cy - 1; yy <= cy + 1; yy++) for (let xx = lx; xx <= lx + 1; xx++) {
          const t = W.tile(xx, yy), m = W.mid(xx, yy);
          if (m < 0) { wrong++; continue; }
          pieces++;
          if (W.pieceFor(m, v, W.groundFor(xx, yy)) !== t) wrong++;
        }
        out.trees.push({ w, placed, grew, species: name, pieces, wrong, ov: W.ovOf[W.tile(lx, cy)], slot: W.slotAt(lx, cy) });
      });
      PL.placePlayer(P, x0 + 8, y0 + 4, 'up');
      return out;
    }, [x0, y0, woods, refused.includes(gname)]);
    if (refused.includes(gname)) {
      check(res.refusedOk && res.msg === "It won't grow here.", `no sapling grows on ${gname}: refused, kept, "${res.msg}"`);
    } else {
      const bad = res.trees.filter((tr) => !tr.placed || !tr.grew || !tr.slot || tr.wrong || tr.pieces !== 6);
      const want = (w) => (w === 'spruce' && (gname === 'snow' || gname === 'snowy_grass') ? 'snowy_spruce' : w);
      const specOk = res.trees.every((tr) => tr.species === want(tr.w));
      log(gname, JSON.stringify(res.trees.map((tr) => [tr.w, tr.species, tr.ov])));
      check(!bad.length && specOk, `every sapling planted and grown on ${gname} with its species' pieces (${bad.map((b) => b.w).join(',') || 'all six'})`);
    }
    // a frame looking at the patch
    await run(() => { const h = window.__rs; h.G.actionBar = null; });
    await idle(2);
    shots.push(await shot('plant_' + gname));
  }

  // chop each species' tree grown on cool grass: its own logs come down
  const chop = await run(([x0, y0, woods]) => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL, out = {};
    woods.forEach((w, k) => {
      const lx = x0 + 3 + 4 * (k % 3), cy = y0 + 2 + 4 * ((k / 3) | 0);
      const n0 = G.ents.length;
      h.clearInv(); h.give('diamond_axe', 1, 0); G.inv.sel = 0;
      PL.placePlayer(P, lx, cy + 2, 'up');
      const tg = PL.target(P);
      if (!tg || tg.mat !== 'tree') { out[w] = 'no tree target'; return; }
      PL.finishBreak(P, tg);
      const drops = G.ents.slice(n0).filter((e) => e.type === 'item').map((e) => e.stack.id);
      out[w] = [...new Set(drops)].sort().join(',') + (W.slotAt(lx, cy) ? ' (still standing)' : '');
    });
    return out;
  }, [setup.sp[0] - 60, setup.sp[1] - 140 + 1 * 12, woods]);
  log('chopped on cool grass', JSON.stringify(chop));
  check(woods.every((w) => (chop[w] || '').split(',').includes(w + '_log') && !(chop[w] || '').includes('standing') && (chop[w] || '').split(',').every((id) => id === w + '_log' || id === w + '_sapling' || id === 'apple' || id === 'stick')),
    'chopping each grown species drops that wood (logs, its sapling) and the tree comes down');

  // ---------------------------------------------------------------- 3. a natural tree near the spawn
  const nat = await run(async (sp) => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL;
    await h.ensure(sp[0], sp[1] + 40, 2);
    for (let r = 1; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = sp[0] + dx, y = sp[1] + 40 + dy;
      if (!W.slotAt(x, y) || W.block(x, y + 2) || PL.canEnter({ riding: null }, x, y + 2) !== 'walk') continue;
      const v = W.varOf[W.tile(x, y)], name = W.specOfVar[v] || 'oak', wood = W.specs[v] ? W.specs[v].wood : 'oak';
      const n0 = G.ents.length;
      h.clearInv(); h.give('diamond_axe', 1, 0); G.inv.sel = 0;
      PL.placePlayer(P, x, y + 2, 'up');
      const tg = PL.target(P);
      if (!tg || tg.mat !== 'tree') continue;
      PL.finishBreak(P, tg);
      return { at: [x, y], name, wood, drops: [...new Set(G.ents.slice(n0).filter((e) => e.type === 'item').map((e) => e.stack.id))] };
    }
    return null;
  }, setup.sp);
  log('natural tree', JSON.stringify(nat));
  check(!!nat && nat.drops.includes(nat.wood + '_log'), `a generated ${nat && nat.name} tree near the spawn drops ${nat && nat.wood}_log`);

  // ---------------------------------------------------------------- 4. decorations as blocks
  const dx0 = setup.sp[0] + 40, dy0 = setup.sp[1] - 120;
  await paint(dx0, dy0, setup.grounds.sand, 24, 8);
  const deco = await run(async ([x0, y0]) => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL, T = h.A.terrain;
    const codes = ['', 'dandelion', 'poppy', 'sugar_cane', 'cactus', 'dead_bush', 'pumpkin', 'melon', 'lily_pad'];
    const out = { fails: [], drops: {} };
    // a strip of pond water on the patch's south row for the lily pad and the cane
    for (let x = x0; x < x0 + 24; x++) { W.setTile(x, y0 + 7, T.pondTile); }
    const put = (x, y, code) => { const ck = (y >> 5) * 63 + (x >> 5); if (!W.deco[ck]) W.deco[ck] = new Uint16Array(1024); W.deco[ck][(y & 31) * 32 + (x & 31)] = code; W.bover.delete(y * W.W + x); W.redraw(x, y); W.redraw(x, y - 1); };
    // generated decorations, one of each, on the patch (the lily pad on the water strip)
    const spots = { sugar_cane: [x0 + 2, y0 + 6], cactus: [x0 + 5, y0 + 4], dead_bush: [x0 + 8, y0 + 4], pumpkin: [x0 + 11, y0 + 4], melon: [x0 + 14, y0 + 4], lily_pad: [x0 + 17, y0 + 7] };
    for (const [id, [x, y]] of Object.entries(spots)) put(x, y, codes.indexOf(id));
    W.chunks.clear();
    out.solid = Object.fromEntries(Object.entries(spots).map(([id, [x, y]]) => [id, W.solid(x, y)]));
    PL.placePlayer(P, x0 + 10, y0 + 4, 'down');
    return { out, spots };
  }, [dx0, dy0]);
  await idle(2);
  shots.push(await shot('deco_generated'));
  log('decoration solidity', JSON.stringify(deco.out.solid));
  check(deco.out.solid.cactus && deco.out.solid.pumpkin && deco.out.solid.melon && !deco.out.solid.sugar_cane && !deco.out.solid.dead_bush, 'generated cactus, pumpkin and melon are solid; cane and dead bush are not');

  // walking into the cactus hurts 1, at most every half second
  const prick = await run(async ([x, y]) => {
    const h = window.__rs, P = h.P;
    P.health = 20; P.food = 17; P.invuln = 0; h.PL.placePlayer(P, x - 1, y, 'right'); h.setState('play');
    const hp0 = P.health;
    h.hold('right', 1);
    const hp1 = P.health;
    h.hold('right', 20);      // 20 frames of 1/60 s: still inside the half second
    const hp2 = P.health;
    h.hold('right', 24);      // past it
    return { hp0, hp1, hp2, hp3: P.health, at: [P.tx, P.ty] };
  }, deco.spots.cactus);
  log('cactus', JSON.stringify(prick));
  check(prick.hp1 === prick.hp0 - 1 && prick.hp2 === prick.hp1 && prick.hp3 === prick.hp1 - 1 && prick.at[0] === deco.spots.cactus[0] - 1, 'walking into a cactus hurts 1 and again only after half a second; it stays solid');

  const brk = await run(async (spots) => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL, out = {};
    for (const [id, [x, y]] of Object.entries(spots)) {
      const tool = id === 'pumpkin' || id === 'melon' ? 'diamond_axe' : 'diamond_shovel';
      h.clearInv(); h.give(tool, 1, 0); G.inv.sel = 0;
      // stand west of it (the lily pad: from the land north of it)
      if (id === 'lily_pad') PL.placePlayer(P, x, y - 1, 'down'); else PL.placePlayer(P, x - 1, y, 'right');
      const n0 = G.ents.length, tg = PL.target(P);
      if (!tg || tg.kind !== 'block' || tg.block.id !== id) { out[id] = { err: 'target ' + (tg && (tg.kind + ':' + (tg.block && tg.block.id))) }; continue; }
      let drops = [];
      // a dead bush drops 0 to 2 sticks: break a few so a stick shows
      PL.finishBreak(P, tg);
      drops = G.ents.slice(n0).filter((e) => e.type === 'item').map((e) => [e.stack.id, e.stack.n]);
      out[id] = { drops, removed: W.bover.get(y * W.W + x) === 0 && !W.block(x, y), tile: W.mat(x, y) };
    }
    return out;
  }, deco.spots);
  log('broken', JSON.stringify(brk));
  const dropsOf = (id) => (brk[id] && brk[id].drops) || [];
  const sum = (id, item) => dropsOf(id).filter(([i]) => i === item).reduce((a, [, n]) => a + n, 0);
  check(Object.values(brk).every((b) => b.removed), 'every generated decoration breaks and its removal is recorded (bover 0)');
  check(sum('sugar_cane', 'sugar_cane') === 1 && sum('cactus', 'cactus') === 1 && sum('pumpkin', 'pumpkin') === 1 && sum('lily_pad', 'lily_pad') === 1, 'sugar cane, cactus, pumpkin and lily pad drop themselves');
  check(sum('melon', 'melon_slice') >= 3 && sum('melon', 'melon_slice') <= 7, `a melon drops 3 to 7 slices (${sum('melon', 'melon_slice')})`);
  check(dropsOf('dead_bush').every(([i]) => i === 'stick') && sum('dead_bush', 'stick') <= 2, `a dead bush drops 0 to 2 sticks (${sum('dead_bush', 'stick')})`);

  // put them back by their rules
  const place = await run(async ([x0, y0, spots]) => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL, out = {};
    const tryPut = (id, x, y, from) => { h.clearInv(); h.give(id, 1, 0); G.inv.sel = 0; G.actionBar = null; PL.placePlayer(P, from[0], from[1], from[2]); const ok = PL.placeBlock(P, G.inv.held, { x, y }); return { ok: !!ok, b: W.block(x, y) && W.block(x, y).id, msg: G.actionBar && G.actionBar.text }; };
    out.cactusSand = tryPut('cactus', x0 + 5, y0 + 2, [x0 + 4, y0 + 2, 'right']);
    out.caneByWater = tryPut('sugar_cane', x0 + 3, y0 + 6, [x0 + 3, y0 + 5, 'down']);
    out.caneDry = tryPut('sugar_cane', x0 + 3, y0 + 2, [x0 + 2, y0 + 2, 'right']);
    out.lilyWater = tryPut('lily_pad', x0 + 20, y0 + 7, [x0 + 20, y0 + 6, 'down']);
    out.lilyLand = tryPut('lily_pad', x0 + 21, y0 + 2, [x0 + 20, y0 + 2, 'right']);
    out.deadBushSand = tryPut('dead_bush', x0 + 8, y0 + 2, [x0 + 7, y0 + 2, 'right']);
    out.pumpkin = tryPut('pumpkin', x0 + 11, y0 + 2, [x0 + 10, y0 + 2, 'right']);
    out.melon = tryPut('melon', x0 + 14, y0 + 2, [x0 + 13, y0 + 2, 'right']);
    // a cactus refuses grass (the temperate patch from part 2)
    out.baked = ['cactus', 'sugar_cane', 'lily_pad', 'dead_bush', 'pumpkin', 'melon'].map((id) => {
      const p = { cactus: [x0 + 5, y0 + 2], sugar_cane: [x0 + 3, y0 + 6], lily_pad: [x0 + 20, y0 + 7], dead_bush: [x0 + 8, y0 + 2], pumpkin: [x0 + 11, y0 + 2], melon: [x0 + 14, y0 + 2] }[id];
      return W.baked(W.block(p[0], p[1]));
    });
    PL.placePlayer(P, x0 + 10, y0 + 4, 'down'); G.actionBar = null;
    for (const e of h.G.ents) if (e.type === 'item') e.dead = true;
    W.chunks.clear();
    return out;
  }, [dx0, dy0, deco.spots]);
  log('placed', JSON.stringify(place));
  check(place.cactusSand.ok && place.caneByWater.ok && place.lilyWater.ok && place.deadBushSand.ok && place.pumpkin.ok && place.melon.ok, 'cactus on sand, cane beside water, lily pad on water, dead bush, pumpkin and melon go down');
  check(!place.caneDry.ok && place.caneDry.msg === "It won't grow here." && !place.lilyLand.ok, 'sugar cane away from water and a lily pad on land are refused');
  check(place.baked.every(Boolean), 'placed cane, cactus, lily pad, dead bush, pumpkin and melon are drawn top-down like generated ones');
  await idle(2);
  shots.push(await shot('deco_placed'));
  const cactusGrass = await run(([x, y]) => {
    const h = window.__rs, G = h.G, P = h.P, PL = h.PL;
    h.clearInv(); h.give('cactus', 1, 0); G.inv.sel = 0; G.actionBar = null; PL.placePlayer(P, x - 1, y, 'right');
    return { ok: !!PL.placeBlock(P, G.inv.held, { x, y }), msg: G.actionBar && G.actionBar.text };
  }, [setup.sp[0] - 60 + 1, setup.sp[1] - 140 + 1]);
  check(!cactusGrass.ok && cactusGrass.msg === "It won't grow here.", 'a cactus refuses grass');

  // ---------------------------------------------------------------- 5. grounds: shovel and ice
  const dig = await run(async ([grounds, x0, y0]) => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL, out = {};
    let k = 0;
    for (const g of ['snow', 'clay', 'mud', 'podzol']) {
      const x = x0 + 2 + k * 3, y = y0; k++;
      for (const [dx, dy] of [[0, 0], [-1, 0]]) {
        const ck = ((y + dy) >> 5) * 63 + ((x + dx) >> 5), kk = ((y + dy) & 31) * 32 + ((x + dx) & 31);
        if (W.cground[ck]) W.cground[ck][kk] = grounds[g];
        W.zone[(y + dy) * W.W + x + dx] = 0; W.setTile(x + dx, y + dy, grounds[g]); W.blocks.delete((y + dy) * W.W + x + dx); W.bover.set((y + dy) * W.W + x + dx, 0);
      }
      h.clearInv(); h.give('diamond_shovel', 1, 0); G.inv.sel = 0;
      PL.placePlayer(P, x - 1, y, 'right');
      const n0 = G.ents.length, tg = PL.target(P);
      if (!tg || tg.kind !== 'dig') { out[g] = 'no dig target: ' + (tg && tg.kind); continue; }
      PL.finishBreak(P, tg);
      const b = W.block(x, y);
      out[g] = { drops: G.ents.slice(n0).filter((e) => e.type === 'item').map((e) => [e.stack.id, e.stack.n]), path: !!(b && b.id === 'dirt_path'), mat: W.mat(x, y) };
    }
    return out;
  }, [setup.grounds, setup.sp[0] - 60, setup.sp[1] - 150]);
  log('dig', JSON.stringify(dig));
  check(dig.snow.drops.length === 1 && dig.snow.drops[0][0] === 'snowball' && !dig.snow.path && dig.snow.mat === 'snow', 'a shovel on snow gives a snowball, the snow stays');
  check(dig.clay.drops.length === 1 && dig.clay.drops[0][0] === 'clay_ball' && dig.clay.drops[0][1] === 4 && dig.clay.path, 'a shovel on clay gives 4 clay balls and leaves a dirt path');
  check(['mud', 'podzol'].every((g) => dig[g].drops.length === 1 && dig[g].drops[0][0] === 'dirt' && dig[g].path), 'a shovel on mud or podzol gives dirt and leaves a dirt path');
  // the snowy-ground and podzol isGrass rule: snow is not grass, tinted grass is
  const grassy = await run(([x0, y0]) => { const W = window.__rs.world; return { cool: W.isGrass(x0 + 1, y0 + 13), snow: W.isGrass(x0 + 1, y0 + 61), podzol: W.isGrass(x0 + 1, y0 + 85) }; }, [setup.sp[0] - 60, setup.sp[1] - 140]);
  check(grassy.cool && !grassy.snow && !grassy.podzol, `isGrass: tinted grass yes, snow and podzol no (${JSON.stringify(grassy)})`);

  // ice: a 9 x 7 frozen pond (pond water ring, ice inside with its edge pieces), one cell broken with a pickaxe
  const ix = setup.sp[0] + 40, iy = setup.sp[1] - 100;
  const ice = await run(async ([x0, y0]) => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL, T = h.A.terrain;
    await h.ensure(x0 + 4, y0 + 3, 2);
    const set = T.quarter.sets.A.recolours.ice_pond.home, lut = T.quarter.lut;
    const isIce = (x, y) => x > x0 && x < x0 + 8 && y > y0 && y < y0 + 6;
    for (let y = y0 - 2; y < y0 + 10; y++) for (let x = x0 - 2; x < x0 + 11; x++) { W.blocks.delete(y * W.W + x); W.bover.set(y * W.W + x, 0); W.zone[y * W.W + x] = 0; W.setTile(x, y, 1); }
    for (let y = y0; y < y0 + 7; y++) for (let x = x0; x < x0 + 9; x++) {
      if (!isIce(x, y)) { W.setTile(x, y, T.pondTile); continue; }
      const bits = (isIce(x, y - 1) ? 1 : 0) | (isIce(x + 1, y) ? 2 : 0) | (isIce(x, y + 1) ? 4 : 0) | (isIce(x - 1, y) ? 8 : 0) | (isIce(x + 1, y - 1) ? 16 : 0) | (isIce(x + 1, y + 1) ? 32 : 0) | (isIce(x - 1, y + 1) ? 64 : 0) | (isIce(x - 1, y - 1) ? 128 : 0);
      W.setTile(x, y, set[lut[bits]]);
    }
    // stand on the ice (walkable) facing the cell east of the middle
    PL.placePlayer(P, x0 + 3, y0 + 3, 'right'); G.actionBar = null;
    W.chunks.clear();
    const walk = PL.canEnter({ riding: null }, x0 + 3, y0 + 3) === 'walk' && W.isFloor(x0 + 4, y0 + 3);
    return { walk, before: W.tile(x0 + 4, y0 + 3) };
  }, [ix, iy]);
  await idle(2);
  shots.push(await shot('ice_before'));
  const melt = await run(async ([x0, y0]) => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, PL = h.PL, T = h.A.terrain;
    h.clearInv(); h.give('diamond_pickaxe', 1, 0); G.inv.sel = 0;
    const tg = PL.target(P);
    if (!tg || tg.mat !== 'ice') return { err: 'target ' + (tg && tg.kind + ':' + tg.mat) };
    const n0 = G.ents.length;
    const near = [[3, 3], [5, 3], [4, 2], [4, 4]].map(([dx, dy]) => W.tile(x0 + dx, y0 + dy));
    PL.finishBreak(P, tg);
    const after = [[3, 3], [5, 3], [4, 2], [4, 4]].map(([dx, dy]) => W.tile(x0 + dx, y0 + dy));
    return { water: W.isWater(x0 + 4, y0 + 3) && W.tile(x0 + 4, y0 + 3) === T.pondTile, drops: G.ents.length - n0, near, after, swim: PL.canEnter({ riding: null }, x0 + 4, y0 + 3) };
  }, [ix, iy]);
  log('ice', JSON.stringify({ ice, melt }));
  check(ice.walk, 'ice is walkable floor');
  check(melt.water && melt.drops === 0 && melt.swim === 'swim', 'ice broken with a pickaxe becomes pond water, with no drop');
  check(melt.near.every((t, k) => t !== melt.after[k]), 'the four ice cells around it re-pick their edge pieces');
  await idle(2);
  shots.push(await shot('ice_after'));

  // the new items in the hotbar, drawn from the full icon sheet
  await run(() => { const h = window.__rs; h.clearInv(); ['birch_log', 'spruce_planks', 'acacia_sapling', 'sugar_cane', 'cactus', 'melon_slice', 'clay_ball', 'snowball', 'lily_pad'].forEach((id, k) => h.give(id, 1 + k, k)); h.G.actionBar = null; });
  await idle(2);
  shots.push(await shot('hotbar_new'));
  const errs = await R('(G.errors || []).length');
  check(errs === 0, 'no G.errors');
  log('shots', shots.join(' '));
}
