// Playfix (the playtest findings, 2026-10-09): the fixes that need the game, checked in one page.
//
//   node tools/headless.mjs tools/gen_tests/playfix_game.mjs --params '?new&play&world=wild&wseed=playtest%20alpha' --port 5625 --out <dir>
//
//   1. hostile spawns in the open overworld: at most 3 within 24 cells on the first night, 5 on the second, 7 after,
//      each 13 to 19 cells away (Classic keeps its 7 and 9 to 17);
//   2. hostile spawns in a cave room: none for 8 s after arriving, then a cap by the room's size (4 for 48 x 36), each
//      at least 12 cells from Steve and 8 from the cell where he arrived;
//   3. every B2F of the world has diamond ore (at least 2 cells);
//   4. copper ore drops 2 to 5 raw copper; a cave room's outer wall answers Z with the protected bump;
//   5. RUN calms the POKeMON close by and the next steps roll no encounter;
//   6. START > TITLE asks with the cursor on NO; A on it stays in the world;
//   7. Creative's Search tab takes keys typed straight away;
//   8. the title menus' screens (driven with a stand-in input): the second Classic delete ignores a double click's
//      second click, a duplicate name gets " (2)", a key typed on a focused field opens its box with that key,
//      CONTINUE moves to the newest world when the booted one is deleted, and CONTINUE's box rows;
//   no G.errors.
export default async function (t) {
  const { page, R, run, idle, tick, shot, check, log } = t;
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
  await run(() => { const h = window.__rs; h.pause(); h.seed(7); if (h.rules) h.rules.encounters = false; h.G.rules.wild = false; h.setTime(6000); });
  const errs = () => R('(G.errors || []).slice(0, 3)');

  // ---------------------------------------------------------------- 1. the open overworld at night
  const night = await run(() => {
    const h = window.__rs, G = h.G, P = h.P, W = h.world, E = h.E, out = {};
    const sp = G.worldSpawn || { x: P.tx, y: P.ty };
    h.teleport(sp.x, sp.y, 'down');
    const near = () => G.ents.filter((e) => e.type === 'mob' && Math.abs(e.tx - P.tx) < 24 && Math.abs(e.ty - P.ty) < 24);
    const clear = () => { G.ents = G.ents.filter((e) => e.type !== 'mob'); };
    const run1 = (day, time) => {
      clear(); G.day = day; G.time = time;
      let minD = 1e9;
      for (let i = 0; i < 400; i++) { const m = E.trySpawnHostile(); if (m) minD = Math.min(minD, Math.hypot(m.tx - P.tx, (m.ty - P.ty) / 0.75)); }
      return { n: E.hostileCount(24), all: near().length, minD: Math.round(minD * 10) / 10 };   // (endermen keep their own 2)
    };
    out.outdoor = W.isOutdoor(P.tx, P.ty) && !W.roomAt(P.tx, P.ty);
    out.first = run1(0, 14000);
    out.firstLate = run1(0, 20000);
    out.second = run1(1, 14000);
    out.later = run1(3, 14000);
    clear(); G.day = 0; G.time = 6000;
    return out;
  });
  log('night', JSON.stringify(night));
  check(night.outdoor && night.first.n > 0 && night.first.n <= 3 && night.firstLate.n > 0 && night.firstLate.n <= 3, `first night: at most 3 hostiles near Steve (${night.first.n}, then ${night.firstLate.n} late in the night)`);
  check(night.second.n > 3 && night.second.n <= 5, `second night: at most 5 (${night.second.n})`);
  check(night.later.n > 5 && night.later.n <= 7, `later nights: 7 as before (${night.later.n})`);
  check([night.first, night.second, night.later].every((q) => q.minD >= 12.4), `overworld spawns 13 cells away or more (nearest ${night.first.minD}, ${night.second.minD}, ${night.later.minD})`);

  // ---------------------------------------------------------------- 2. a cave room
  const cave = await run(() => {
    const h = window.__rs, G = h.G, P = h.P, W = h.world, E = h.E, out = {};
    const m = W.maps.find((q) => q.kind === 'cave' && q.gen && q.w * q.h >= 1600) || W.maps.find((q) => q.kind === 'cave' && q.gen);
    const ex = W.warps.find((w) => w.map === m.id) || null;
    // arrive on a floor cell near the room's way in
    let ax = null, ay = null;
    for (let d = 0; d < 30 && ax == null; d++) for (let y = m.y + m.h - 3 - d; y <= m.y + m.h - 3 + d && ax == null; y++) for (let x = m.x + (m.w >> 1) - d; x <= m.x + (m.w >> 1) + d; x++) {
      if (y >= m.y && y < m.y + m.h && x >= m.x && x < m.x + m.w && !W.solid(x, y) && W.isFloor(x, y) && !W.warpAt(x, y)) { ax = x; ay = y; break; }
    }
    h.teleport(ax, ay, 'up');
    G.ents = G.ents.filter((e) => e.type !== 'mob');
    out.room = { id: m.id, w: m.w, h: m.h, ax, ay, exit: !!ex };
    let early = 0;
    for (let i = 0; i < 200; i++) if (E.trySpawnHostile()) early++;
    out.early = early;
    G.clock += 9;   // past the 8 s grace
    let minD = 1e9, minA = 1e9;
    for (let i = 0; i < 600; i++) { const q = E.trySpawnHostile(); if (q) { minD = Math.min(minD, Math.hypot(q.tx - P.tx, (q.ty - P.ty) / 0.75)); minA = Math.min(minA, Math.abs(q.tx - ax) + Math.abs(q.ty - ay)); } }
    out.n = G.ents.filter((e) => e.type === 'mob' && W.roomAt(e.tx, e.ty) === m).length;
    out.cap = Math.max(2, Math.min(4, Math.round((m.w * m.h) / 450)));
    out.minD = Math.round(minD * 10) / 10; out.minA = minA;
    G.ents = G.ents.filter((e) => e.type !== 'mob');
    return out;
  });
  log('cave', JSON.stringify(cave));
  check(cave.early === 0, 'cave room: nothing spawns in the first 8 s after arriving');
  check(cave.n > 0 && cave.n <= cave.cap && cave.cap <= 4, `cave room: ${cave.n} hostiles at most, the room's cap ${cave.cap} (${cave.room.w} x ${cave.room.h})`);
  check(cave.minD >= 11.4 && cave.minA >= 8, `cave room: spawns 12 cells or more from Steve (${cave.minD}) and 8 or more from his arrival cell (${cave.minA})`);

  // ---------------------------------------------------------------- 3. diamonds on every B2F; 4. copper, the outer wall
  const ores = await run(() => {
    const h = window.__rs, W = h.world, out = { b2: [] };
    for (const m of W.maps.filter((q) => q.kind === 'cave' && q.gen && /_B2F$/.test(q.id))) {
      let d = 0;
      for (let y = m.y; y < m.y + m.h; y++) for (let x = m.x; x < m.x + m.w; x++) if (W.mat(x, y) === 'diamond_ore') d++;
      out.b2.push([m.id, d]);
    }
    return out;
  });
  log('B2F diamonds', JSON.stringify(ores.b2));
  check(ores.b2.length > 0 && ores.b2.every(([, d]) => d >= 2), `every B2F has diamond ore (${ores.b2.filter(([, d]) => d >= 2).length} of ${ores.b2.length})`);
  const mine = await run(() => {
    const h = window.__rs, G = h.G, P = h.P, W = h.world, PL = h.PL, out = {};
    h.give('stone_pickaxe', 1, 0); G.inv.sel = 0;
    // a copper ore with a wall cell beside it to stand on once mined
    let tgt = null;
    for (const m of W.maps.filter((q) => q.kind === 'cave' && q.gen)) {
      for (let y = m.y + 2; y < m.y + m.h - 2 && !tgt; y++) for (let x = m.x + 2; x < m.x + m.w - 2 && !tgt; x++) if (W.mat(x, y) === 'copper_ore') tgt = [x, y];
      if (tgt) break;
    }
    out.copper = tgt;
    if (tgt) {
      const counts = [];
      // mine it and two more copper cells if there are; count raw copper dropped per ore
      const cells = [tgt];
      for (const [x, y] of cells) {
        const n0 = G.ents.length;
        PL.placePlayer(P, x, y + 1, 'up');
        const tg = PL.target(P);
        if (!tg || tg.mat !== 'copper_ore') { counts.push('no target ' + JSON.stringify(tg && tg.mat)); continue; }
        PL.finishBreak(P, tg);
        counts.push(G.ents.slice(n0).filter((e) => e.type === 'item' && e.stack && e.stack.id === 'raw_copper').reduce((s, e) => s + e.stack.n, 0));
      }
      out.counts = counts;
    }
    // the outer wall: cave 11 B2F of this seed (344, 38, 40 x 30): tunnel up to the room's top row
    const m = W.maps.find((q) => q.id === 'GEN_CAVE_11_B2F');
    out.room = m ? [m.x, m.y, m.w, m.h] : null;
    if (m) {
      const x = 348;
      for (let y = m.y + 3; y >= m.y; y--) { PL.placePlayer(P, x, y + 1, 'up'); const tg = PL.target(P); if (tg && tg.kind === 'tile') PL.finishBreak(P, tg); }
      PL.placePlayer(P, x, m.y, 'up');
      const tg = PL.target(P);
      out.edge = { at: [x, m.y], cell: W.mat(x, m.y), kind: tg && tg.kind, void: W.isVoid(x, m.y - 1) };
    }
    return out;
  });
  log('mine', JSON.stringify(mine));
  check(mine.copper && mine.counts.every((n) => typeof n === 'number' && n >= 2 && n <= 5), `copper ore drops 2 to 5 raw copper (${JSON.stringify(mine.counts)})`);
  check(mine.edge && mine.edge.void && mine.edge.kind === 'protected', `a cave room's outer wall is a protected bump, not nothing (${JSON.stringify(mine.edge)})`);
  // holding Z on it shows the reason
  await run(() => { window.__rs.G.actionBar = null; });
  for (let i = 0; i < 12; i++) await tick({ hold: 'a', press: i === 0 ? 'a' : undefined });
  const bar = await R('G.actionBar && G.actionBar.text');
  check(/too sturdy/.test(bar || ''), `holding Z on the outer wall says why (${bar})`);

  // ---------------------------------------------------------------- 5. RUN calms the ones close by
  const ran = await run(() => {
    const h = window.__rs, G = h.G, P = h.P, W = h.world, out = {};
    const sp = G.worldSpawn || { x: P.tx, y: P.ty };
    h.teleport(sp.x, sp.y, 'down');
    G.ents = G.ents.filter((e) => e.type !== 'wild' && e.type !== 'mob');
    const free = [];
    for (let d = 2; d < 8 && free.length < 3; d++) for (let dx = -d; dx <= d && free.length < 3; dx++) { const x = P.tx + dx, y = P.ty + d; if (!W.solid(x, y) && !W.isWater(x, y) && W.isFloor(x, y)) free.push([x, y]); }
    const es = free.map(([x, y]) => h.spawnWild('GROWLITHE', 5, x, y, { arch: 'aggressive' }));
    out.n = es.filter(Boolean).length;
    h.encounter('GROWLITHE', 5);
    G.battleSrc = es[0];
    for (let i = 0; i < 80 && h.state() !== 'battle'; i++) h.tick({ capture: false });
    h.battle().finished = 'ran';
    for (let i = 0; i < 120 && h.state() !== 'play'; i++) h.tick({ capture: false });
    out.state = h.state();
    out.calm = es.map((e) => e && Math.round(e.calm * 10) / 10);
    out.encSkip = G.encSkip; out.grace = Math.round(G.wildGrace * 10) / 10;
    return out;
  });
  log('ran', JSON.stringify(ran));
  check(ran.state === 'play' && ran.n >= 2 && ran.calm.slice(1).every((c) => c > 3) && ran.calm[0] > 10 && ran.encSkip === 4, `RUN calms the POKeMON close by (calm ${JSON.stringify(ran.calm)}) and skips the next 4 steps' encounters (${ran.encSkip})`);
  await run(() => { const h = window.__rs; h.G.ents = h.G.ents.filter((e) => e.type !== 'wild'); h.G.encSkip = 0; h.G.wildGrace = 0; });

  // ---------------------------------------------------------------- 6. TITLE's question starts on NO
  await run(() => { window.__rs.setState('play'); });
  await tick({ press: 'start' }); await idle(2);
  const at = await R("h.menuRows().indexOf('TITLE')");
  for (let i = 0; i < at; i++) await tick({ press: 'down' });
  await tick({ press: 'a' });
  for (let i = 0; i < 160 && !(await R('h.msg() && h.msg().ask && h.msg().page === h.msg().pages.length - 1')); i++) await tick({ press: i % 4 === 0 ? 'a' : undefined });
  await idle(40);
  await shot('pf_title_no');
  await tick({ press: 'a' }); await idle(2);
  check((await R('h.state()')) === 'play', 'START > TITLE: A at once answers NO and stays in the world');

  // ---------------------------------------------------------------- 7. Creative's Search takes typed keys
  await run(() => { const h = window.__rs; h.setMode('creative', 'normal'); h.setState('play'); });
  await tick({ press: 'inv' }); await idle(2);
  await run(() => { const s = window.__rs.screen(); if (s && s.setTab) s.setTab(8); });
  await idle(2);
  const tab = await R("h.screen() && h.screen().tabDef && h.screen().tabDef.id");
  await page.keyboard.press('d'); await tick(); await page.keyboard.press('i'); await idle(2);
  const typed = await page.evaluate(() => { const i = document.querySelector('#rs-text-entry input'); return { open: !!i, value: i && i.value, q: window.__rs.screen() && window.__rs.screen().query }; });
  log('search typed', tab, JSON.stringify(typed));
  check(tab === 'search' && typed.open && /^di?$/.test(typed.value || '') && /^d/.test(typed.q || ''), `Search: a key typed straight away opens the field with it (${JSON.stringify(typed)})`);
  await page.keyboard.press('Enter'); await idle(2);
  await tick({ press: 'esc' }); await idle(2);
  await run(() => { const h = window.__rs; h.setMode('survival', 'normal'); h.setState('play'); });

  // ---------------------------------------------------------------- 8. the title menus' screens
  const menus = await page.evaluate(async () => {
    const WM = await import('/src/ui/worldmenu.js');
    const TE = await import('/src/ui/textentry.js');
    const out = {};
    const mk = () => ({ pressed: new Set(), typed: [], mouse: { x: -1, y: -1, inside: true, wheel: 0 }, just(k) { return this.pressed.has(k); }, held() { return false; }, takeWheel() { return 0; } });
    const step = (s, dt, inp) => { s.update(dt, inp); inp.pressed.clear(); inp.typed.length = 0; };
    const click = (s, w, dt = 1 / 30) => { const inp = mk(); inp.mouse.x = w.x + 5; inp.mouse.y = w.y + 5; step(s, 0, inp); inp.pressed.add('mouseL'); step(s, dt, inp); };
    // the double click on Classic's delete
    let deleted = 0;
    const first = WM.deleteConfirm({ id: 'classic', type: 'classic', name: 'Classic Kanto' }, () => { deleted++; }, () => {});
    click(first, first.w.yes);
    const second = first.next();
    click(second, second.w.yes, 0.15);   // the second click of a double click, 150 ms later
    out.afterDouble = { done: second.done, deleted, label: second.w.yes.label };
    for (let i = 0; i < 20; i++) step(second, 1 / 30, mk());
    click(second, second.w.yes);
    out.afterWait = { done: second.done, deleted };
    // a duplicate name
    const cw = new WM.CreateWorld({ names: ['New World', 'New World (2)'] });
    click(cw, cw.w.create);
    out.dup = cw.result && cw.result.name;
    // a key typed with the seed field focused
    const cw2 = new WM.CreateWorld({});
    cw2.tab = 1;
    // (playfix2: the field focused by a click, its box committed, as the finding's player did; a field reached with the
    // arrow keys leaves X and the other game-button keys to the menu, checked in the 'arrow-focused' case below)
    click(cw2, cw2.w.seed); TE.closeTextEntry(true);
    const inp = mk(); inp.typed.push('x'); inp.pressed.add('b');   // 'x' is also B
    step(cw2, 1 / 30, inp);
    out.typed = { open: TE.textEntryOpen(), seed: cw2.seedText, done: cw2.done };
    TE.closeTextEntry(true);
    // (playfix2: arrow-focused: W then S from Game Mode moves through the name field and types nothing)
    const cw3 = new WM.CreateWorld({});
    const k3 = (ch, b) => { const q = mk(); q.typed.push(ch); q.pressed.add(b); step(cw3, 1 / 30, q); };
    k3('w', 'up'); const onName = cw3.visible()[cw3.focus] === cw3.w.name;
    k3('s', 'down');
    out.arrow = { onName, back: cw3.visible()[cw3.focus] === cw3.w.mode, open: TE.textEntryOpen(), name: cw3.name };
    TE.closeTextEntry(false);
    // CONTINUE after the booted world is deleted
    let entries = [{ id: 'classic', type: 'classic', name: 'Classic Kanto', mode: 'survival', played: 30 }, { id: 'w1', type: 'wild', name: 'Old', mode: 'survival', played: 10, playTime: 60 }, { id: 'w2', type: 'kanto', name: 'Newest', mode: 'creative', played: 20, playTime: 120 }];
    const wm = new WM.WorldMenus({ cont: { id: 'classic', name: 'Classic Kanto', type: 'classic', mode: 'survival', playTime: 5 }, bootedId: 'classic', worlds: () => entries,
      onDelete: (id) => { entries = entries.filter((e) => e.id !== id); } });
    out.contBefore = wm.cont() && wm.cont().id;
    out.boxClassic = wm.makeTitle().items[0].h;
    const sel = wm.makeSelect();
    await sel.onDelete('classic');
    const c = wm.cont();
    out.contAfter = c && { id: c.id, name: c.name, type: c.type };
    const tm = wm.makeTitle();
    out.boxGen = tm.items[0].h; out.items = tm.items.map((i) => i.id);
    wm.end({ op: 'continue' });
    out.result = wm.result;
    return out;
  });
  log('menus', JSON.stringify(menus));
  check(!menus.afterDouble.done && menus.afterDouble.deleted === 0 && menus.afterDouble.label === 'Delete Classic Kanto', 'Classic delete: a double click\'s second click does not press "Delete Classic Kanto"');
  check(menus.afterWait.done && menus.afterWait.deleted === 1, 'Classic delete: a deliberate click after a moment still deletes');
  check(menus.dup === 'New World (3)', `a duplicate name gets the next free suffix (${menus.dup})`);
  check(menus.arrow.onName && menus.arrow.back && !menus.arrow.open && menus.arrow.name === 'New World', `arrow-focused: W and S on the name field move, typing nothing (${JSON.stringify(menus.arrow)})`);
  check(menus.typed.open && menus.typed.seed === 'x' && !menus.typed.done, `a key typed on the focused seed field opens its box with that key and does not back out (${JSON.stringify(menus.typed)})`);
  check(menus.contBefore === 'classic' && menus.contAfter && menus.contAfter.id === 'w2' && menus.items[0] === 'continue', `CONTINUE moves to the newest world left once the booted one is deleted (${JSON.stringify(menus.contAfter)})`);
  check(menus.result && menus.result.op === 'load' && menus.result.id === 'w2', `that CONTINUE loads it (${JSON.stringify(menus.result)})`);
  check(menus.boxClassic === 76 && menus.boxGen === 76, `CONTINUE's box keeps its height for Classic's 2 rows and a generated world's 4 (${menus.boxClassic}, ${menus.boxGen})`);
  const e = await errs();
  check(e.length === 0, 'no G.errors: ' + JSON.stringify(e));
}
