// Smoke test after ./setup.sh: the title screen, a new Classic Kanto game, a short walk, a tree punched down, a wild
// battle fought to its end, then a new Wild World made through the title menus and walked in. Keys and clicks go
// through the game's own input; screenshots go to the --out folder (they show game graphics: keep them out of git).
//
//   npm install            (once: Playwright; it drives your installed Google Chrome)
//   node tools/headless.mjs tools/smoke.mjs --params '?new' --port 5400 --out out/smoke
//
// Exits 1 if a check fails or the page reports an error.
export default async function (t) {
  const { page, R, run, tick, idle, press, shot, check, log } = t;
  const errors = () => R('(G.errors || []).slice(0, 3)');
  const state = () => R('h.state()');
  const base = page.url().replace(/\?.*$/, '');

  // ---------------------------------------------------------------- 1. the title screen
  await idle(40);
  check((await state()) === 'title', 'boots on the title screen');
  await shot('1_title');

  // ---------------------------------------------------------------- 2. a new Classic Kanto game
  // START opens FireRed's main menu; CONTINUE plays the booted world, which ?new makes a fresh Classic Kanto
  await press('start', 2);
  await page.waitForFunction(() => !!window.__rs.titleMenus(), null, { timeout: 30000 });
  await idle(10);
  const menu = await R('(() => { const s = h.titleMenus().top; return { kind: s.kind, items: s.items.map((i) => i.id), sel: s.sel }; })()');
  check(menu.kind === 'titleMenu' && menu.items[0] === 'continue', `FireRed's main menu: ${menu.items.join(', ')}`);
  await shot('2_main_menu');
  await press('a', 4);
  for (let i = 0; i < 90 && (await state()) !== 'play'; i++) await tick();
  const classic = await R('({ state: h.state(), gen: !!W.layout.gen, at: [P.tx, P.ty], area: W.areaAt(P.tx, P.ty) })');
  check(classic.state === 'play' && !classic.gen, `CONTINUE plays a new Classic Kanto game (${JSON.stringify(classic)})`);
  await run(() => { const h = window.__rs; h.rules.encounters = false; h.G.rules.mobs = false; h.G.rules.wild = false; h.setTime(6000); });
  await idle(30);
  await shot('3_classic');

  // ---------------------------------------------------------------- 3. a short walk
  const walk = async () => {
    const [x0, y0] = await R('[P.tx, P.ty]');
    for (const dir of ['down', 'right', 'left', 'up']) {
      for (let i = 0; i < 40; i++) await tick({ hold: dir });
      await idle(10);
      const [x, y] = await R('[P.tx, P.ty]');
      if (Math.abs(x - x0) + Math.abs(y - y0) >= 3) return [x0, y0, x, y];
    }
    const [x, y] = await R('[P.tx, P.ty]');
    return [x0, y0, x, y];
  };
  const w1 = await walk();
  check(Math.abs(w1[2] - w1[0]) + Math.abs(w1[3] - w1[1]) >= 3, `walked from (${w1[0]}, ${w1[1]}) to (${w1[2]}, ${w1[3]})`);
  await shot('4_walk');

  // ---------------------------------------------------------------- 4. a tree punched down by hand
  const tree = await run(() => {
    const h = window.__rs, W = h.world, P = h.P;
    for (let r = 1; r < 24; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = P.tx + dx, y = P.ty + dy;
        if (W.findTree(x, y) && h.PL.canEnter({ riding: null }, x, y + 1) === 'walk') {
          h.teleport(x, y + 1, 'up');
          h.G.inv.sel = 8; h.G.inv.slots[8] = null;     // bare hands
          return [x, y];
        }
      }
    }
    return null;
  });
  check(!!tree, `a tree near the start: ${JSON.stringify(tree)}`);
  if (tree) {
    const logs = () => R('G.inv.slots.filter((s) => s && /_log$/.test(s.id)).reduce((a, s) => a + s.n, 0)');
    const before = await logs();
    await idle(4);
    let n = 0;
    for (; n < 1200 && (await R(`!!W.findTree(${tree[0]}, ${tree[1]})`)); n++) await tick({ hold: 'a' });
    await shot('5_tree_down');
    // the logs drop where the trunk stood: step onto them to pick them up
    for (let i = 0; i < 20; i++) await tick({ hold: 'up' });
    await idle(60);
    const after = await logs();
    const gone = !(await R(`!!W.findTree(${tree[0]}, ${tree[1]})`));
    check(gone && after > before, `the tree came down after ${n} frames of holding Z and gave ${after - before} logs`);
  }

  // ---------------------------------------------------------------- 5. a wild battle, fought with the keys
  await run(() => window.__rs.encounter('PIDGEY', 3));
  for (let i = 0; i < 200 && (await state()) !== 'battle'; i++) await tick();
  check((await state()) === 'battle', 'a wild PIDGEY appears');
  let moves = 0, frames = 0;
  for (; frames < 6000 && (await state()) === 'battle'; frames++) {
    const b = await R('(() => { const b = h.battle(); if (!b) return null; const c = b.cur; return { ui: b.ui, cur: c ? c.type : null, q: b.q.length, done: c && c.type === "msg" ? c.shown >= c.pages[c.page].join("").length : false }; })()');
    if (!b) { await tick(); continue; }
    if (!b.cur && !b.q && b.ui === 'action') { if (moves === 0) await shot('6_battle'); await press('a', 2); moves++; continue; }   // FIGHT
    if (!b.cur && !b.q && b.ui === 'moves') { await press('a', 2); continue; }                                                     // the first move
    if (!b.cur && !b.q && b.ui === 'yesno') { await press('b', 2); continue; }
    if (b.cur === 'msg' && b.done) { await press('a', 2); continue; }
    await tick();
  }
  for (let i = 0; i < 300 && (await state()) !== 'play'; i++) await tick({ press: i % 10 === 0 ? 'a' : undefined });
  const fought = await R('({ state: h.state(), party: G.party.length, level: P.level })');
  check(fought.state === 'play' && moves > 0, `the battle ended back in Kanto after ${moves} turns (${JSON.stringify(fought)})`);
  await idle(20);
  await shot('7_after_battle');
  const e1 = await errors();
  check(!e1.length, 'no game errors in Classic: ' + e1.join(' | '));

  // ---------------------------------------------------------------- 6. a new Wild World through the title menus
  await page.goto(base + '?new');
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
  await run(() => { window.__rs.pause(); window.__rs.seed(2026); });
  await idle(40);
  await press('start', 2);
  await page.waitForFunction(() => !!window.__rs.titleMenus(), null, { timeout: 30000 });
  await idle(10);
  const items = await R('h.titleMenus().top.items.map((i) => i.id)');
  for (let i = 0; i < items.indexOf('new'); i++) await press('down', 2);
  await press('a', 6);
  const create = await R('h.titleMenus() && h.titleMenus().top.kind');
  check(create === 'createWorld', `NEW GAME opens Create New World (${create})`);
  const click = async (key, after = 4) => {
    const at = await page.evaluate((k) => {
      const s = window.__rs.titleMenus().top, w = s.w[k], c = document.getElementById('game'), r = c.getBoundingClientRect();
      return [r.left + ((w.x + w.w / 2) / c.width) * r.width, r.top + ((w.y + w.h / 2) / c.height) * r.height];
    }, key);
    await page.mouse.click(at[0], at[1]);
    await idle(after);
  };
  await click('tabWorld');
  for (let i = 0; i < 3 && (await R('h.titleMenus().top.type')) !== 'wild'; i++) await click('type');
  const made = await R('({ type: h.titleMenus().top.type, name: h.titleMenus().top.name })');
  check(made.type === 'wild', `World Type: Wild World (${JSON.stringify(made)})`);
  await shot('8_create_world');
  await click('create', 0);
  for (let i = 0; i < 30; i++) { try { await tick(); } catch (e) { break; } }   // Create reloads the page into the new world
  await page.waitForFunction(() => window.__rs && window.__rs.ready && window.__rs.world && window.__rs.world.layout.gen, null, { timeout: 180000 });
  await run(() => { const h = window.__rs; h.pause(); h.seed(2026); h.rules.encounters = false; h.G.rules.mobs = false; h.G.rules.wild = false; h.setTime(6000); });
  await idle(60);
  const wild = await R('({ state: h.state(), type: (W.wd || {}).type, name: (W.wd || {}).name, at: [P.tx, P.ty] })');
  check(wild.state === 'play' && wild.type === 'wild', `playing the new Wild World (${JSON.stringify(wild)})`);
  await shot('9_wild_world');
  const w2 = await walk();
  check(Math.abs(w2[2] - w2[0]) + Math.abs(w2[3] - w2[1]) >= 3, `walked in the Wild World from (${w2[0]}, ${w2[1]}) to (${w2[2]}, ${w2[3]})`);
  await shot('10_wild_walk');
  const e2 = await errors();
  check(!e2.length, 'no game errors in the Wild World: ' + e2.join(' | '));
  log('screenshots in', t.OUT);
}
