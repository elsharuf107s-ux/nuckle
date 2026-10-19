// Stage 5d in the game: wild POKeMON by biome, their levels (distance, biome, Kanto blending, the cap after a death),
// and the husk and the stray (design 3.15, 3.16; stage 5d).
//
//   node tools/headless.mjs tools/gen_tests/wildlife.mjs --params '?new&play&world=wild&wseed=1' --port 5647 --out <dir>
//
// Checks: the level rule against its formula (distance from the spawn with the 32-cell slope and the 40 cap, every
// biome's bonus, a cave counting from its mouth), Kanto blending with a stand-in opening, the cap before and after a
// real death (step rolls, a visible POKeMON's battle level, a battle actually started); per biome group present in the
// seed: visible spawns around Steve come from the table of the map they stand on with the expected level, the table's
// rolls cover its species; a real step encounter in tall grass; fishing and water tables; the husk and stray
// substitution rates by biome, a husk not burning by day while a zombie and a stray do, a husk hitting like a zombie and
// dropping rotten flesh, a stray's arrow slowing Steve to half speed for 3 s (a skeleton's not), and no husk or stray
// sound. Screenshots (looked at by hand): a desert with a husk and a wild POKeMON, a snowy biome with a stray.
export default async function (t) {
  const { page, R, run, shot, check, log, until } = t;
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
  await run(() => { const h = window.__rs; h.pause(); h.seed(2026); h.rules.encounters = true; h.rules.mobs = false; h.setTime(6000); });

  // ---- 0. where each biome is: one main-thread chunk in every 3 x 3 (the plane's overworld columns)
  const where = await run(() => {
    const h = window.__rs, W = h.world, gen = W.gen, maps = W.maps;
    const best = {};
    // (sync takes the overworld's own chunk coordinates: plane column = cx + 13)
    for (let cy = 1; cy < 50; cy += 3) for (let cx = 1; cx < 50; cx += 3) {
      const c = gen.sync(cx, cy), cnt = {};
      for (let i = 0; i < 1024; i++) cnt[c.biome[i]] = (cnt[c.biome[i]] || 0) + 1;
      for (const [b, n] of Object.entries(cnt)) {
        if (best[b] && best[b].n >= n) continue;
        // a cell of this biome whose 5 x 5 is all this biome, nearest the chunk's middle
        let cell = null, bd = 1e9;
        for (let y = 2; y < 30; y++) for (let x = 2; x < 30; x++) {
          let all = true;
          for (let dy = -2; dy <= 2 && all; dy++) for (let dx = -2; dx <= 2 && all; dx++) all = c.biome[(y + dy) * 32 + x + dx] === +b;
          if (all) { const d = Math.abs(x - 16) + Math.abs(y - 16); if (d < bd) { bd = d; cell = [(cx + 13) * 32 + x, cy * 32 + y]; } }
        }
        if (cell) best[b] = { n, cell };
      }
    }
    const out = {};
    for (const m of maps) if (m.gen && !m.room && m.biomeId != null && best[m.biomeId]) out[m.id] = { ...best[m.biomeId], wild: m.wild, biome: m.biome };
    return { out, spawn: h.G.worldSpawn };
  });
  log('biomes found', Object.keys(where.out).join(' '));

  // ---- 1. the level rule
  const lv = await run(() => {
    const h = window.__rs, W = h.world, G = h.G, L = h.gen.wild, sp = G.worldSpawn;
    const byId = (id) => W.maps.find((m) => m.id === id);
    const formula = (d) => Math.max(0, Math.min(40, Math.floor((d - 64) / 32)));
    const plains = byId('GEN_PLAINS'), bad = [];
    for (const d of [0, 10, 63, 64, 95, 96, 127, 128, 200, 500, 1000, 1343, 1344, 1500, 1900]) {
      const got = L.levelFor(plains, sp.x + d, sp.y, 3), want = 3 + formula(d);
      if (got !== want) bad.push([d, got, want]);
      const got2 = L.levelFor(plains, sp.x - (d >> 1), sp.y + d, 3);    // Chebyshev: the larger axis counts
      if (got2 !== want) bad.push(['cheb', d, got2, want]);
    }
    const bonus = {}, BON = { dark_forest: 2, swamp: 2, jungle: 2, stony_hills: 3, mountains: 3, snowy_mountains: 3 };
    for (const m of W.maps) if (m.gen && !m.room) { bonus[m.id] = L.levelFor(m, sp.x, sp.y, 3) - 3; if (bonus[m.id] !== (BON[m.biome] || 0)) bad.push(['biome', m.id, bonus[m.id]]); }
    // caves: from the mouth, +4 on B1F and +8 on B2F
    const caves = W.meta.genCaves, cav = [];
    for (const m of W.maps.filter((mm) => mm.gen && mm.room && mm.kind === 'cave').slice(0, 12)) {
      const id = +/^GEN_CAVE_(\d+)_B/.exec(m.id)[1], c = caves.find((cv) => cv.id === id);
      const d = Math.max(Math.abs(c.x - sp.x), Math.abs(c.y - sp.y)), want = 3 + formula(d) + (m.depth === 2 ? 8 : 4);
      const got = L.levelFor(m, m.x + 5, m.y + 5, 3);
      cav.push([m.id, d, got]);
      if (got !== want) bad.push(['cave', m.id, got, want]);
    }
    // Kanto's maps and the Nether keep their levels
    for (const id of ['MAP_ROUTE1', 'MAP_VIRIDIAN_FOREST']) { const m = byId(id); if (m && L.levelFor(m, sp.x + 900, sp.y, 7) !== 7) bad.push(['kanto', id]); }
    // Kanto blending (stand-in openings; 6b fills world.meta.openings): at the out cell Route 1's levels (2 to 5), halfway
    // between, at 48 and beyond the generated level; and the distance counts from the nearest opening too
    const far = { x: sp.x + 700, y: sp.y };
    W.meta.openings = [{ out: [far.x, far.y], map: 'MAP_ROUTE1' }];
    const gen0 = 3 + formula(0), at = [], mid = [], past = [];
    for (let i = 0; i < 200; i++) { at.push(L.levelFor(plains, far.x, far.y, 3)); mid.push(L.levelFor(plains, far.x, far.y + 24, 3)); past.push(L.levelFor(plains, far.x + 60, far.y, 3)); }
    W.meta.openings = [{ out: { x: sp.x + 400, y: sp.y + 400 }, map: 'MAP_ROUTE1' }];
    const objOut = L.levelFor(plains, sp.x + 400, sp.y + 400, 3);
    // a high route (Route 23, 32 to 44): its levels at the opening, halfway at 24 cells, the gentle land's at 48
    W.meta.openings = [{ out: [far.x, far.y], map: 'MAP_ROUTE23' }];
    const h0 = [], h24 = [], h36 = [], h48 = [];
    for (let i = 0; i < 300; i++) { h0.push(L.levelFor(plains, far.x, far.y, 3)); h24.push(L.levelFor(plains, far.x + 24, far.y, 3)); h36.push(L.levelFor(plains, far.x, far.y - 36, 3)); h48.push(L.levelFor(plains, far.x + 48, far.y + 10, 3)); }
    const mm = (a) => [Math.min(...a), Math.max(...a)];
    delete W.meta.openings;
    const after = L.levelFor(plains, far.x + 60, far.y, 3);
    return { bad, bonus, cav, blend: { at: [Math.min(...at), Math.max(...at)], mid: [Math.min(...mid), Math.max(...mid)], past: [Math.min(...past), Math.max(...past)], gen0, objOut, after,
      r23: { h0: mm(h0), h24: mm(h24), h36: mm(h36), h48: mm(h48) } } };
  });
  log('levels', JSON.stringify(lv).slice(0, 900));
  check(lv.bad.length === 0, `levelFor = table + clamp(floor((d - 64) / 32), 0, 40) + biome bonus (Chebyshev d, 2 dark forest / swamp / jungle, 3 hills and mountains, caves +4 / +8 from their mouth), Kanto maps unchanged (bad ${JSON.stringify(lv.bad.slice(0, 5))})`);
  check(lv.blend.at[0] >= 2 && lv.blend.at[1] <= 5 && lv.blend.past[0] === lv.blend.gen0 + 0 && lv.blend.past[1] === lv.blend.gen0 && lv.blend.mid[0] >= 2 && lv.blend.mid[1] <= 4 && lv.blend.objOut <= 5 && lv.blend.after > lv.blend.gen0,
    `Kanto blending: at an opening Route 1's levels ${JSON.stringify(lv.blend.at)}, 24 cells out ${JSON.stringify(lv.blend.mid)}, 60 cells out the generated level ${JSON.stringify(lv.blend.past)} (= ${lv.blend.gen0}, d from the opening), without openings ${lv.blend.after}`);

  const r23 = lv.blend.r23;
  check(r23.h0[0] >= 32 && r23.h0[1] <= 44 && r23.h24[0] >= 17 && r23.h24[1] <= 24 && r23.h36[0] >= 10 && r23.h36[1] <= 14 && r23.h48[0] === 3 && r23.h48[1] === 3,
    `blending into Route 23 (32 to 44): at the opening ${JSON.stringify(r23.h0)}, 24 cells out ${JSON.stringify(r23.h24)}, 36 out ${JSON.stringify(r23.h36)}, 48 out ${JSON.stringify(r23.h48)} (no jump at either end)`);

  // ---- 2. the cap, before and after a real death
  const cap = await run(async () => {
    const h = window.__rs, W = h.world, G = h.G, P = h.P, L = h.gen.wild, sp = G.worldSpawn;
    const plains = W.maps.find((m) => m.id === 'GEN_PLAINS'), fx = sp.x + 1500, fy = sp.y;
    G.party.length = 0; h.addMon('PIDGEY', 10); P.level = 15;
    const before = L.capWho(), rb = [];
    for (let i = 0; i < 300; i++) { const e = L.genRoll(plains, 'land', fx, fy); rb.push(e.level); }
    const vis0 = L.wildLevel(44, sp.x + 2, sp.y, 3);
    // a real death: Steve falls, respawns at the spawn with his experience gone
    h.rules.wild = false;
    P.invuln = 0; h.PL.hurtPlayer(P, 100, 'test');
    for (let i = 0; i < 400 && h.state() !== 'dead' && !P.dead; i++) h.step(1);
    const died = P.dead || h.state() === 'dead';
    h.respawn();
    for (let i = 0; i < 300 && (P.dead || h.state() !== 'play'); i++) h.step(1);
    const after = L.capWho(), ra = [];
    for (let i = 0; i < 300; i++) { const e = L.genRoll(plains, 'land', fx, fy); ra.push(e.level); }
    const vis1 = L.wildLevel(44, P.tx + 2, P.ty, 3);
    // an empty party: Steve's own +6
    const keep = G.party.slice(); G.party.length = 0;
    const empty = L.capWho(), re = [];
    for (let i = 0; i < 100; i++) re.push(L.genRoll(plains, 'land', fx, fy).level);
    G.party.push(...keep);
    // a visible POKeMON of level 44 touched near the spawn: the battle starts at the capped level
    await h.ensure(P.tx + 1, P.ty, 1);
    let cell = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2]]) if (!W.solid(P.tx + dx, P.ty + dy) && !W.isWater(P.tx + dx, P.ty + dy)) { cell = [P.tx + dx, P.ty + dy]; break; }
    const e = h.spawnWild('PIDGEY', 44, cell[0], cell[1]); e.base = 3;
    G.wildGrace = 0; L.engage(e);
    const battleLevel = h.seq() && h.seq().wild ? h.seq().wild.level : null;
    for (let i = 0; i < 120 && h.state() !== 'battle'; i++) h.step(1);
    const b = h.battle(), inBattle = b && b.foe ? b.foe.level : (b && b.wild ? b.wild.level : null);
    return { before, rb: [Math.min(...rb), Math.max(...rb)], vis0, died, after, ra: [Math.min(...ra), Math.max(...ra)], vis1, empty, re: [Math.min(...re), Math.max(...re)], battleLevel, state: h.state(), inBattle, Plevel: P.level };
  });
  log('cap', JSON.stringify(cap));
  check(cap.before.steve === 38 && cap.rb[0] >= 42 && cap.rb[1] <= 44 && cap.vis0 === 44,
    `before the death (Steve level 38, party best 10, cap 44): rolls 1,500 cells out are ${JSON.stringify(cap.rb)} (table 2 to 4 + 40), a level-44 POKeMON stays 44`);
  check(cap.died && cap.after.steve === 8 && cap.Plevel === 0, `a real death resets Steve's experience (Steve battles at ${cap.after.steve})`);
  check(cap.ra[0] >= 2 && cap.ra[1] === 14 && cap.vis1 === 14, `after the death the cap is max(8 + 6, 10 + 4) = 14: rolls ${JSON.stringify(cap.ra)}, a level-44 POKeMON battles at ${cap.vis1}`);
  check(cap.re[1] === 14, `an empty party: max(Steve + 6, 4) = 14 (rolls ${JSON.stringify(cap.re)})`);
  check(cap.battleLevel === 14, `touching a visible level-44 POKeMON after the death starts a battle against level ${cap.battleLevel} (state ${cap.state})`);
  // out of the battle
  await run(() => { const h = window.__rs; if (h.battle && h.battle()) { h.G.battle = null; } h.setState('play'); h.G.ents = h.G.ents.filter((e) => e.type !== 'wild'); });

  // ---- 3. encounters per biome: visible spawns where Steve stands, and the table's rolls
  const GROUPS = {};
  for (const [id, v] of Object.entries(where.out)) (GROUPS[v.wild] = GROUPS[v.wild] || []).push(id);
  const perBiome = {};
  for (const [id, v] of Object.entries(where.out)) {
    const r = await run(async ({ id, v }) => {
      const h = window.__rs, W = h.world, G = h.G, P = h.P, A = h.A, L = h.gen.wild, sp = G.worldSpawn;
      const [x, y] = v.cell;
      await h.ensure(x, y, 2);
      // the most open cell of this biome near its middle (a forest's or a mountain's middle can be all trees or rock)
      const self = W.mapAt(x, y), wet = self.terrain === 'water' || self.terrain === 'pond';
      const okCell = (cx, cy) => W.mapAt(cx, cy) === self && !W.solid(cx, cy) && (wet || !W.isWater(cx, cy));
      let bx = x, by = y, bo = -1;
      for (let dy = -16; dy <= 16; dy += 2) for (let dx = -16; dx <= 16; dx += 2) {
        if (!okCell(x + dx, y + dy)) continue;
        let o = 0; for (let ey = -6; ey <= 6; ey++) for (let ex = -8; ex <= 8; ex++) if (okCell(x + dx + ex, y + dy + ey)) o++;
        if (o > bo) { bo = o; bx = x + dx; by = y + dy; }
      }
      h.teleport(bx, by, 'down'); h.rules.wild = true;
      const tables = A.dex.wild, spawned = [], bad = [];
      const formula = (d) => Math.max(0, Math.min(40, Math.floor((d - 64) / 32)));
      const BON = { dark_forest: 2, swamp: 2, jungle: 2, stony_hills: 3, mountains: 3, snowy_mountains: 3 };
      for (let i = 0; i < 160; i++) {
        G.ents = G.ents.filter((e) => e.type !== 'wild');
        h.trySpawnWild();
        for (const e of G.ents) {
          if (e.type !== 'wild') continue;
          const tid = e.map.wild || e.map.id, t = tables[tid], list = t && t[e.swim ? 'water' : 'land'];
          const row = list && list.mons.find((m) => m[0] === e.species);
          const d = Math.max(Math.abs(e.tx - sp.x), Math.abs(e.ty - sp.y)), want = e.base + formula(d) + (BON[e.map.biome] || 0);
          if (!row || e.level !== want || e.base < row[1] || e.base > row[2]) bad.push([tid, e.species, e.base, e.level, want]);
          spawned.push([tid, e.species, e.level, e.swim ? 'w' : 'l']);
        }
      }
      G.ents = G.ents.filter((e) => e.type !== 'wild');
      // the table's own rolls (step encounters use them): every species appears, levels in range
      const map = W.maps.find((m) => m.id === id), t = tables[map.wild], seen = new Set(), lv = [];
      for (const kind of ['land', 'water']) if (t && t[kind]) for (let i = 0; i < 600; i++) { const e = L.genRoll(map, kind, x, y); seen.add(e.species); lv.push(e.level); }
      const all = t ? [...new Set([...(t.land ? t.land.mons : []), ...(t.water ? t.water.mons : [])].map((m) => m[0]))] : [];
      const missing = all.filter((s) => !seen.has(s));
      const own = spawned.filter((s) => s[0] === map.wild).length;
      return { id, wild: map.wild, n: spawned.length, own, bad, missing, lv: lv.length ? [Math.min(...lv), Math.max(...lv)] : null, sample: spawned.slice(0, 6), mons: A.dex.species ? all.every((s) => A.dex.species[s] && A.mon[s] && A.mon[s].ow) : false };
    }, { id, v });
    perBiome[id] = r;
    log('biome', id, JSON.stringify(r).slice(0, 300));
    // (1% species such as LAPRAS can miss in 600 rolls)
    check(r.n > 0 && r.own > 0 && r.bad.length === 0 && r.mons && r.missing.filter((s) => !['LAPRAS', 'RAPIDASH', 'HAUNTER', 'ABRA', 'CLEFAIRY', 'DEWGONG', 'GLOOM', 'PINSIR', 'GYARADOS'].includes(s)).length === 0,
      `${id} (${r.wild}): ${r.n} visible POKeMON (${r.own} from its own table), each from the table where it stands at the expected level; rolls cover the table (missing ${JSON.stringify(r.missing)}), sprites loaded (bad ${JSON.stringify(r.bad.slice(0, 3))})`);
  }
  const tablesSeen = new Set(Object.values(perBiome).filter((r) => r.own > 0).map((r) => r.wild));
  log('tables with spawns', [...tablesSeen].join(' '));
  check(['GEN_PLAINS', 'GEN_FOREST', 'GEN_DESERT', 'GEN_SNOWY', 'GEN_OCEAN'].every((k) => tablesSeen.has(k)), `the main tables all spawn in seed 1 (${tablesSeen.size} tables: ${[...tablesSeen].join(', ')})`);

  // caves: B1F and B2F
  const cave = await run(async () => {
    const h = window.__rs, W = h.world, G = h.G, A = h.A, sp = G.worldSpawn, out = {};
    const formula = (d) => Math.max(0, Math.min(40, Math.floor((d - 64) / 32)));
    for (const depth of [1, 2]) {
      const m = W.maps.find((mm) => mm.gen && mm.room && mm.kind === 'cave' && mm.depth === depth);
      if (!m) continue;
      const id = +/^GEN_CAVE_(\d+)_B/.exec(m.id)[1], c = W.meta.genCaves.find((cv) => cv.id === id);
      let cell = null;
      for (let y = m.y + 2; y < m.y + m.h - 2 && !cell; y++) for (let x = m.x + 2; x < m.x + m.w - 2 && !cell; x++) if (!W.solid(x, y) && !W.warpAt(x, y) && W.entry(x, y)[7] === 1 && !W.isLava(x, y)) cell = [x, y];
      h.teleport(cell[0], cell[1], 'down');
      const got = [], bad = [];
      for (let i = 0; i < 200; i++) {
        G.ents = G.ents.filter((e) => e.type !== 'wild');
        h.trySpawnWild();
        for (const e of G.ents) if (e.type === 'wild') {
          const t = A.dex.wild[m.wild].land, row = t.mons.find((r) => r[0] === e.species);
          const want = e.base + formula(Math.max(Math.abs(c.x - sp.x), Math.abs(c.y - sp.y))) + (depth === 2 ? 8 : 4);
          if (e.map !== m || !row || e.level !== want) bad.push([e.species, e.base, e.level, want]);
          got.push(e.species);
        }
      }
      G.ents = G.ents.filter((e) => e.type !== 'wild');
      out[m.wild] = { n: got.length, kinds: [...new Set(got)], bad };
    }
    const sp0 = G.worldSpawn; await h.ensure(sp0.x, sp0.y, 1); h.teleport(sp0.x, sp0.y, 'down');
    return out;
  });
  log('caves', JSON.stringify(cave));
  for (const k of ['GEN_CAVE1', 'GEN_CAVE2']) check(cave[k] && cave[k].n > 0 && cave[k].bad.length === 0, `${k}: ${cave[k] ? cave[k].n : 0} visible POKeMON on the cave floor (${cave[k] ? cave[k].kinds.join(', ') : ''}), from its table at the mouth's level + ${k === 'GEN_CAVE1' ? 4 : 8}`);

  // fishing and the water tables
  const fish = await run(() => {
    const h = window.__rs, W = h.world, A = h.A, L = h.gen.wild, out = {};
    for (const id of ['GEN_OCEAN', 'GEN_RIVER']) {
      const m = W.maps.find((mm) => mm.id === id) || W.maps.find((mm) => mm.wild === id);
      const seen = new Set();
      for (let i = 0; i < 800; i++) seen.add(L.genRoll(m, 'fishing', h.G.worldSpawn.x, h.G.worldSpawn.y, 'old_rod').species);
      out[id] = [...seen].sort();
    }
    return out;
  });
  log('fishing', JSON.stringify(fish));
  check(fish.GEN_OCEAN.includes('MAGIKARP') && fish.GEN_OCEAN.includes('KRABBY') && fish.GEN_OCEAN.includes('SEAKING') && fish.GEN_RIVER.includes('GOLDEEN'), `the OLD ROD reads the whole fishing list in oceans and rivers (${JSON.stringify(fish)})`);

  // a real step encounter in tall grass (visible POKeMON off, so the full rate)
  const grassBiome = ['GEN_FOREST', 'GEN_BIRCH_FOREST', 'GEN_TAIGA', 'GEN_DARK_FOREST', 'GEN_PLAINS'].find((k) => where.out[k]);
  const step = await run(async (v) => {
    const h = window.__rs, W = h.world, P = h.P, G = h.G;
    const [x0, y0] = v.cell;
    await h.ensure(x0, y0, 2);
    // two tall grass cells side by side near the biome's middle
    let pair = null;
    for (let r = 0; r < 30 && !pair; r++) for (let dy = -r; dy <= r && !pair; dy++) for (let dx = -r; dx <= r && !pair; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (W.tallGrass(x, y) && W.tallGrass(x + 1, y) && !W.solid(x, y) && !W.solid(x + 1, y)) pair = [x, y];
    }
    if (!pair) return { pair: null };
    h.rules.wild = false; G.ents = G.ents.filter((e) => e.type !== 'wild');
    h.teleport(pair[0], pair[1], 'right');
    let steps = 0;
    for (let i = 0; i < 6000 && h.state() === 'play'; i++) { h.hold(i % 40 < 20 ? 'right' : 'left', 1); steps++; }
    const s = h.seq();
    return { pair, frames: steps, state: h.state(), species: s && s.wild ? s.wild.species : null, level: s && s.wild ? s.wild.level : null, map: (W.mapAt(P.tx, P.ty) || {}).wild };
  }, where.out[grassBiome]);
  log('step encounter', JSON.stringify(step));
  const stepTable = await R(`(h.A.dex.wild['${step.map}'] || { land: { mons: [] } }).land.mons.map((m) => m[0])`);
  check(step.pair && (step.state === 'transition' || step.state === 'battle') && stepTable.includes(step.species) && step.level >= 2 && step.level <= 14,
    `walking in ${grassBiome}'s tall grass starts a battle with a ${step.species} of level ${step.level} from ${step.map} (capped at 14 after the death)`);
  await run(() => { const h = window.__rs; h.G.battle = null; h.setState('play'); });

  // ---- 4. husks and strays
  const desert = where.out.GEN_DESERT, snowy = where.out.GEN_SNOWY_PLAINS || where.out.GEN_SNOWY_TAIGA || where.out.GEN_SNOWY_BEACH, plainsW = where.out.GEN_PLAINS;
  const subst = await run(({ desert, snowy, plains }) => {
    const h = window.__rs, L = h.gen.wild, n = 2000;
    const rate = (c, k, want) => { let hits = 0; for (let i = 0; i < n; i++) if (L.biomeKind(c[0], c[1], k) === want) hits++; return hits / n; };
    return { huskDesert: rate(desert.cell, 'zombie', 'husk'), strayDesert: rate(desert.cell, 'skeleton', 'stray'), straySnow: rate(snowy.cell, 'skeleton', 'stray'), huskSnow: rate(snowy.cell, 'zombie', 'husk'),
      plainsZ: rate(plains.cell, 'zombie', 'zombie'), plainsS: rate(plains.cell, 'skeleton', 'skeleton'), creeper: rate(desert.cell, 'creeper', 'creeper'),
      sfx: Object.keys(h.A.sfx || {}).filter((k) => /^(husk|stray)\./.test(k)), mobs: ['husk', 'stray'].every((k) => h.A.items.mobs[k] && h.A.mob[k]) };
  }, { desert, snowy, plains: plainsW });
  log('substitution', JSON.stringify(subst));
  check(subst.huskDesert > 0.76 && subst.huskDesert < 0.84 && subst.strayDesert === 0 && subst.straySnow > 0.76 && subst.straySnow < 0.84 && subst.huskSnow === 0 && subst.plainsZ === 1 && subst.plainsS === 1 && subst.creeper === 1,
    `a desert zombie is a husk ${Math.round(subst.huskDesert * 100)}% of the time, a snowy skeleton a stray ${Math.round(subst.straySnow * 100)}%; nothing else changes (plains, creepers, the other kind)`);
  check(subst.mobs && subst.sfx.length === 0, `husk and stray have definitions and sheets, and no sounds of their own (silent: ${JSON.stringify(subst.sfx)})`);

  // natural spawning at night in the desert and in the snow
  const natural = await run(async ({ desert, snowy }) => {
    const h = window.__rs, G = h.G, E = h.E, out = {};
    h.setTime(18000);
    for (const [k, c] of [['desert', desert.cell], ['snowy', snowy.cell]]) {
      await h.ensure(c[0], c[1], 2); h.teleport(c[0], c[1], 'down');
      const kinds = {};
      for (let i = 0; i < 300; i++) { G.ents = G.ents.filter((e) => e.type !== 'mob' || e.persistent); const m = E.trySpawnHostile(); if (m) kinds[m.kind] = (kinds[m.kind] || 0) + 1; }
      G.ents = G.ents.filter((e) => e.type !== 'mob' || e.persistent);
      out[k] = kinds;
    }
    return out;
  }, { desert, snowy });
  log('natural spawns', JSON.stringify(natural));
  check((natural.desert.husk || 0) > 2 * (natural.desert.zombie || 0) && !natural.desert.stray && (natural.snowy.stray || 0) > 2 * (natural.snowy.skeleton || 0) && !natural.snowy.husk,
    `night spawns: desert ${JSON.stringify(natural.desert)}, snowy ${JSON.stringify(natural.snowy)}`);

  // the desert by day: a husk does not burn, a zombie and a stray do; a husk hits like a zombie and drops rotten flesh
  const day = await run(async ({ desert }) => {
    const h = window.__rs, G = h.G, P = h.P, W = h.world, E = h.E;
    const [x, y] = desert.cell;
    h.teleport(x, y, 'down'); h.setTime(6000);
    const open = (cx, cy) => !W.solid(cx, cy) && !W.isWater(cx, cy) && E.cellFree(cx, cy) && h.G.lightAt(cx, cy) >= 12;
    const near = []; for (let r = 6; r < 14 && near.length < 3; r++) for (let dx = -r; dx <= r && near.length < 3; dx += 3) if (open(x + dx, y - r)) near.push([x + dx, y - r]);
    P.hidden = true;   // (mobs ignore him: this part is about the sun)
    const z = E.spawnMob('zombie', near[0][0], near[0][1]), hk = E.spawnMob('husk', near[1][0], near[1][1]), st = E.spawnMob('stray', near[2][0], near[2][1]);
    h.step(240);   // 4 s of daylight
    const sun = { zombie: [z.hp, z.burn > 0, !!z.dying], husk: [hk.hp, hk.burn || 0, !!hk.dying], stray: [st.hp, st.burn > 0, !!st.dying] };
    G.ents = G.ents.filter((e) => e.type !== 'mob' || e.persistent);
    P.hidden = false;
    // a hit each, at night, standing beside him
    h.setTime(18000);
    const hitBy = (kind) => {
      G.ents = G.ents.filter((e) => e.type !== 'mob' || e.persistent);
      P.health = 20; P.invuln = 0; P.hurtFlash = 0;
      const m = E.spawnMob(kind, P.tx + 1, P.ty); m.cool = 0;
      let lost = 0;
      for (let i = 0; i < 120 && !lost; i++) { h.step(1); lost = 20 - P.health; }
      G.ents = G.ents.filter((e) => e !== m);
      return lost;
    };
    const dz = hitBy('zombie'), dh = hitBy('husk');
    P.health = 20;
    // drops: five husks killed away from Steve
    G.ents = G.ents.filter((e) => e.type !== 'item');
    const drops = {};
    for (let i = 0; i < 5; i++) { const m = E.spawnMob('husk', x + 8 + i, y + 8); E.hurtMob(m, 100, null, { player: true }); }
    h.step(90);
    for (const e of G.ents) if (e.type === 'item') drops[e.stack.id] = (drops[e.stack.id] || 0) + e.stack.n;
    G.ents = G.ents.filter((e) => e.type !== 'item' && (e.type !== 'mob' || e.persistent));
    return { sun, dz, dh, drops };
  }, { desert });
  log('husk', JSON.stringify(day));
  check(day.sun.husk[0] === 20 && day.sun.husk[1] === 0 && !day.sun.husk[2] && day.sun.zombie[1] && day.sun.zombie[0] < 20 && day.sun.stray[1] && day.sun.stray[0] < 20,
    `by day a husk does not burn (hp ${day.sun.husk[0]}), a zombie (hp ${day.sun.zombie[0]}) and a stray (hp ${day.sun.stray[0]}) do`);
  check(day.dh > 0 && day.dh === day.dz, `a husk hits like a zombie (${day.dh} against ${day.dz})`);
  check((day.drops.rotten_flesh || 0) > 0 && Object.keys(day.drops).every((k) => k === 'rotten_flesh' || k === 'iron_ingot'), `husks drop rotten flesh (${JSON.stringify(day.drops)})`);

  // a desert scene for the eye: a husk and a SANDSHREW near Steve
  await run(({ desert }) => {
    const h = window.__rs, P = h.P, W = h.world, E = h.E, G = h.G;
    const [x, y] = desert.cell; h.teleport(x, y, 'down'); h.setTime(6000);
    const free = (cx, cy) => !W.solid(cx, cy) && !W.isWater(cx, cy) && E.cellFree(cx, cy) && !W.block(cx, cy);
    const near = (ox, oy) => { for (let r = 0; r < 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (free(x + ox + dx, y + oy + dy)) return [x + ox + dx, y + oy + dy]; return null; };
    G.ents = G.ents.filter((e) => e.type !== 'wild' && (e.type !== 'mob' || e.persistent));
    const hc = near(3, 0); if (hc) E.spawnMob('husk', hc[0], hc[1]);
    const wc = near(-3, 1); if (wc) { const e = h.spawnWild('SANDSHREW', 5, wc[0], wc[1]); e.base = 3; }
    P.hidden = true; h.step(2);
  }, { desert });
  await shot('5d-desert-husk');

  // the stray's arrow: 3 s of half speed (a skeleton's arrow does nothing of the kind)
  const arrow = await run(async ({ snowy }) => {
    const h = window.__rs, G = h.G, P = h.P, W = h.world, E = h.E;
    G.ents = G.ents.filter((e) => e.type !== 'mob' || e.persistent); G.ents = G.ents.filter((e) => e.type !== 'wild');
    P.hidden = false; h.setTime(18000);
    const [x0, y0] = snowy.cell;
    // a row of 8 open cells for the archer and Steve, and room to walk below him
    let at = null;
    for (let r = 0; r < 40 && !at; r++) for (let dy = -r; dy <= r && !at; dy++) for (let dx = -r; dx <= r && !at; dx++) {
      const x = x0 + dx, y = y0 + dy; let ok = true;
      for (let k = -1; k <= 7 && ok; k++) ok = !W.solid(x + k, y) && !W.isWater(x + k, y) && E.cellFree(x + k, y) && !W.jumpDir(x + k, y);
      for (let k = 1; k <= 3 && ok; k++) ok = !W.solid(x, y + k) && !W.isWater(x, y + k) && !W.jumpDir(x, y + k) && !W.solid(x, y - k) && !W.isWater(x, y - k);
      if (ok) at = [x, y];
    }
    if (!at) return { at };
    await h.ensure(at[0], at[1], 1);
    const shoot = (kind) => {
      G.ents = G.ents.filter((e) => (e.type !== 'mob' || e.persistent) && e.type !== 'arrow');
      h.teleport(at[0], at[1], 'right'); P.health = 20; P.invuln = 0; P.slowT = 0;
      const m = E.spawnMob(kind, at[0] + 5, at[1]); m.cool = 0;
      let hit = false, msgT = null;
      for (let i = 0; i < 600 && !hit; i++) { h.step(1); hit = P.health < 20; }
      const slow = P.slowT;
      G.ents = G.ents.filter((e) => e !== m && e.type !== 'arrow');
      return { hit, slow, health: P.health };
    };
    const sk = shoot('skeleton'), sr = shoot('stray');
    // walk while slowed, then after it wears off (back on the open cell first: the arrow knocks him back)
    const left = P.slowT; h.teleport(at[0], at[1], 'down'); P.slowT = left;
    P.invuln = 0;
    h.hold('down', 1); const slowSpeed = P.speed, slowLeft = P.slowT;
    h.step(220);   // 3.7 s: the slowness is over
    const after = P.slowT;
    h.hold('down', 1); const normal = P.speed;
    h.step(30);
    // a stray beside Steve in the snow for the eye
    h.setTime(6000); P.hidden = true;
    for (const [dx, dy] of [[2, 0], [-2, 0], [2, 1], [-2, 1], [0, 2], [3, 0], [-3, 0]]) if (!W.solid(P.tx + dx, P.ty + dy) && !W.block(P.tx + dx, P.ty + dy) && E.cellFree(P.tx + dx, P.ty + dy)) { E.spawnMob('stray', P.tx + dx, P.ty + dy); break; }
    h.step(2);
    return { at, sk, sr, slowSpeed, slowLeft, after, normal };
  }, { snowy });
  log('stray', JSON.stringify(arrow));
  check(arrow.at && arrow.sk.hit && arrow.sk.slow === 0, `a skeleton's arrow hits (health ${arrow.sk && arrow.sk.health}) and gives no slowness`);
  check(arrow.sr.hit && arrow.sr.slow > 2.5 && arrow.sr.slow <= 3, `a stray's arrow hits and slows Steve for 3 s (${arrow.sr.slow && arrow.sr.slow.toFixed(2)} s left)`);
  check(Math.abs(arrow.slowSpeed - 0.48) < 1e-9 && arrow.after === 0 && Math.abs(arrow.normal - 0.24) < 1e-9, `slowed he walks at half speed (${arrow.slowSpeed} s a cell), then at his own again (${arrow.normal})`);
  await shot('5d-snowy-stray');

  const errs = await R('(G.errors || []).slice(0, 5)');
  check(errs.length === 0, `no G.errors (${JSON.stringify(errs)})`);
}
