// Stage 8b: the creative inventory in the game, START's OPTION and TITLE rows, healing outside Kanto (design 6.3,
// 6.5, 6.6; test plan 11.5 "the creative inventory gives a stack").
//
//   node tools/headless.mjs tools/gen_tests/creative_ui.mjs --params '?new&play&world=wild&wseed=1&mode=creative' --port 5680 --out <dir>
//
// 1. Desktop (the harness page, real mouse and keys on the canvas): E opens the creative inventory; a click on an item
//    takes a full stack, a click on a hotbar slot puts it there; a right click takes one, the grid destroys it; Search
//    filters through the page-level box; the survival tab's destroy slot; the keys take a stack; a number key fills a
//    hotbar slot; the wheel scrolls; E closes and the cursor stack comes back.
// 2. START in a generated world: OPTION after CO-OP (row 5 kept), TITLE, EXIT; the list scrolls; OPTION's rows per
//    mode (Creative: MUSIC and WILD POKeMON; Survival: MUSIC and DIFFICULTY; Hardcore and spectator: MUSIC); TITLE's
//    warning and question; a spectator's short START list.
// 3. Healing: a night in a bed restores the party; a death comes back at the bed with the party restored.
// 4. Phone (390 x 844, touch, the pad): INV opens it, taps take and place a stack, the Search box by tap and the phone
//    keyboard, the scroller by tap and drag, MENU > OPTION by the pad.
export default async function (t) {
  const { page, R, run, tick, idle, shot, check, log, OUT } = t;
  const base = page.url().replace(/\?.*$/, '');
  const errs = () => R('(G.errors || []).slice(0, 3)');
  const scr = () => R("(() => { const s = h.screen(); return s && s.kind === 'creative' ? { tab: s.tab, cursor: s.cursor, scroll: s.scroll, query: s.query, sel: s.sel, max: s.maxScroll(), n: s.list().length } : null; })()");
  // canvas pixels (480 x 320) to page pixels
  const toPage = async (pg, x, y) => pg.evaluate(([x, y]) => { const c = document.getElementById('game'), r = c.getBoundingClientRect(); return [r.left + (x / c.width) * r.width, r.top + (y / c.height) * r.height]; }, [x, y]);
  const rect = (expr) => R(`(() => { const s = h.screen(); return ${expr}; })()`);
  const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];
  const click = async (xy, button = 'left') => { const [px, py] = await toPage(page, xy[0], xy[1]); await page.mouse.move(px, py); await page.mouse.click(px, py, { button }); await tick(); };

  // ================================================================ 1. desktop
  await run(() => { const h = window.__rs; h.clearInv(); h.setTime(6000); h.G.ents = h.G.ents.filter((e) => e.type !== 'mob'); });
  await tick({ press: 'inv' });
  let s = await scr();
  check(!!s && (await R('h.state()')) === 'screen', 'Creative: E opens the creative inventory (not the survival screen)');
  await idle(3);
  log('shot', await shot('d1_open'));
  // a tab by click, then an item: a full stack on the cursor, placed on hotbar slot 1
  await click(centre(await rect('s.tabRect(1)')));
  s = await scr();
  check(s.tab === 1, 'a click on the Natural Blocks tab selects it');
  const g0 = await R('h.screen().gridItem(0)');
  await click(centre(await rect('s.gridRect(0)')));
  s = await scr();
  const full = await run((id) => window.__rs.maxStack(id), g0);
  log('took', JSON.stringify(s.cursor), 'max', full);
  check(s.cursor && s.cursor.id === g0 && s.cursor.n === full, `a click on ${g0} puts a full stack on the cursor`);
  await click(centre(await rect('s.hotRect(0)')));
  const slot0 = await R('G.inv.slots[0]');
  s = await scr();
  check(slot0 && slot0.id === g0 && slot0.n === full, `the creative inventory gives a stack: hotbar slot 1 holds ${slot0 && slot0.n} ${slot0 && slot0.id}`);
  check(!s.cursor, 'the cursor is empty after placing');
  // a right click takes one; the grid destroys what the cursor holds
  await click(centre(await rect('s.gridRect(2)')), 'right');
  s = await scr();
  check(s.cursor && s.cursor.n === 1, 'a right click takes one');
  await click(centre(await rect('s.gridRect(5)')));
  s = await scr();
  check(!s.cursor, 'clicking the item grid with a stack destroys it (Minecraft\'s destroy slot)');
  // the wheel scrolls a long tab
  await click(centre(await rect('s.tabRect(0)')));
  const [wx, wy] = await toPage(page, ...centre(await rect('s.gridRect(20)')));
  await page.mouse.move(wx, wy); await page.mouse.wheel(0, 120); await tick();
  s = await scr();
  check(s.max > 0 && s.scroll === 1, `the wheel scrolls Building Blocks (${s.scroll} of ${s.max})`);
  await click(centre(await rect('s.scrollRect()')).map((v, i) => (i === 1 ? v + 50 : v)));
  s = await scr();
  check(s.scroll === s.max, `a click low on the scroller jumps to the end (${s.scroll} of ${s.max})`);
  log('shot', await shot('d2_building_scrolled'));
  // Search: the page-level box, typing filters the grid as you type
  await click(centre(await rect('s.tabRect(8)')));
  await click(centre(await rect('s.searchRect()')));
  const boxOpen = await page.evaluate(() => !!document.querySelector('#rs-text-entry input'));
  check(boxOpen, 'a click on the Search field opens the page-level text box');
  if (boxOpen) {
    await page.keyboard.type('pick');
    await tick();
    const names = await R("h.screen().list().map((id) => id)");
    log('search pick', names.join(' '));
    check(names.length >= 5 && names.every((id) => /pick/.test(id)), `typing "pick" filters to ${names.length} pickaxes`);
    await page.screenshot({ path: `${OUT}/d3_search.png` });
    await page.keyboard.press('Enter');
    await tick();
  }
  s = await scr();
  check(s.query === 'pick' && !(await page.evaluate(() => !!document.querySelector('#rs-text-entry input'))), 'Enter commits the search and closes the box');
  // the survival tab: drag hotbar slot 1's stack to the destroy slot
  await click(centre(await rect('s.tabRect(9)')));
  const invHot0 = await rect("(() => { const sl = s.invSlots().find((q) => q.kind === 'inv' && q.idx === 0); return { x: s.x0 + sl.x - 1, y: s.y0 + sl.y - 1, w: 18, h: 18 }; })()");
  await click(centre(invHot0));
  s = await scr();
  check(s.cursor && s.cursor.id === g0, 'the Survival Inventory tab: hotbar slot 1 picked up');
  log('shot', await shot('d4_survival_tab'));
  const destroy = await rect("(() => { const sl = s.invSlots().find((q) => q.kind === 'destroy'); return { x: s.x0 + sl.x - 1, y: s.y0 + sl.y - 1, w: 18, h: 18 }; })()");
  await click(centre(destroy));
  s = await scr();
  check(!s.cursor && !(await R('G.inv.slots[0]')), 'the destroy slot deletes it');
  // keys: back to an item tab, arrows into the grid, Z takes a stack, 3 fills hotbar slot 3
  await tick({ press: 'next' });   // inventory (the last tab) -> building (wraps)
  s = await scr();
  check(s.tab === 0, `C/V switch tabs (now ${s.tab})`);
  await tick({ press: 'down' }); await tick({ press: 'right' });
  s = await scr();
  const kItem = await R('(() => { const s = h.screen(); return s.sel.area === "grid" ? s.gridItem(s.sel.i) : null; })()');
  await tick({ press: 'slot3' });
  const slot2 = await R('G.inv.slots[2]');
  check(kItem && slot2 && slot2.id === kItem && slot2.n >= 16, `a number key over ${kItem} fills hotbar slot 3 with a stack (${slot2 && slot2.n})`);
  await tick({ press: 'a' });
  s = await scr();
  check(s.cursor && s.cursor.id === kItem && s.cursor.n >= 16, 'Z (A) on the selected item takes a full stack');
  log('shot', await shot('d5_keys_cursor'));
  // E closes; the cursor stack goes back to the inventory
  const before = await R(`G.inv.count ? G.inv.count('${kItem}') : G.inv.slots.filter((q) => q && q.id === '${kItem}').reduce((a, q) => a + q.n, 0)`);
  await tick({ press: 'inv' });
  const after = await R(`G.inv.count ? G.inv.count('${kItem}') : G.inv.slots.filter((q) => q && q.id === '${kItem}').reduce((a, q) => a + q.n, 0)`);
  check((await R('h.state()')) === 'play' && after > before, `E closes it and the cursor stack comes back (${before} to ${after})`);
  // Survival's E is still the survival inventory
  await run(() => window.__rs.setMode('survival', 'normal'));
  await tick({ press: 'inv' });
  check((await R("h.screen() && h.screen().kind")) === 'inventory', 'Survival: E opens the survival inventory');
  await tick({ press: 'inv' });
  await run(() => window.__rs.setMode('creative', 'normal'));

  // ================================================================ 2. START, OPTION and TITLE
  await tick({ press: 'start' });
  check((await R('h.state()')) === 'menu', 'START opens the menu');
  const rows = await R('h.menuRows()');
  log('START rows', rows.join(', '));
  check(rows.join() === 'POKéDEX,POKéMON,BAG,STEVE,SAVE,CO-OP,OPTION,TITLE,MAP,EXIT' && rows[5] === 'CO-OP', 'a generated world\'s START: OPTION after CO-OP (row 5 kept), then TITLE, MAP (the minimap\'s full map) and EXIT');
  for (let i = 0; i < 7; i++) await tick({ press: 'down' });
  log('shot', await shot('s1_start_title_row'));
  for (let i = 0; i < 2; i++) await tick({ press: 'up' });   // CO-OP 5 -> OPTION 6
  for (let i = 0; i < 1; i++) await tick({ press: 'down' });
  check((await R('h.menuCursor()')) === 6, 'the cursor is on OPTION');
  await tick({ press: 'a' });
  check((await R('h.state()')) === 'option', 'A on OPTION opens the option window');
  let opt = await R('h.optionUI() && { rows: h.optionUI().rows, cursor: h.optionUI().cursor }');
  check(opt && opt.rows.join() === 'MUSIC,WILD POKéMON,MINIMAP', `Creative's OPTION rows: ${opt && opt.rows.join(', ')}`);
  const mus0 = await R("localStorage.getItem('poke-redstone-music')");
  await tick({ press: 'right' });
  const mus1 = await R("localStorage.getItem('poke-redstone-music')");
  check(mus0 !== mus1 && mus1, `MUSIC toggles the M key's setting (${mus0} to ${mus1})`);
  await tick({ press: 'left' });
  await tick({ press: 'down' });
  await tick({ press: 'right' });
  let md = await R('h.modes()');
  check(md.wild === false && (await R('h.wd().wild')) === false, 'WILD POKéMON OFF sets the creative option (and the world descriptor)');
  log('shot', await shot('s2_option_creative'));
  await tick({ press: 'a' });
  md = await R('h.modes()');
  check(md.wild === true, 'A toggles it back ON');
  await tick({ press: 'b' });
  check((await R('h.state()')) === 'menu', 'B closes OPTION back to START');
  await tick({ press: 'b' });
  // Survival: DIFFICULTY
  await run(() => window.__rs.setMode('survival', 'normal'));
  await tick({ press: 'start' }); for (let i = 0; i < 6; i++) await tick({ press: 'down' }); await tick({ press: 'a' });
  opt = await R('h.optionUI() && { rows: h.optionUI().rows }');
  check(opt && opt.rows.join() === 'MUSIC,DIFFICULTY,MINIMAP', `Survival's OPTION rows: ${opt && opt.rows.join(', ')}`);
  await tick({ press: 'down' }); await tick({ press: 'right' });
  md = await R('h.modes()');
  check(md.diff === 'hard' && md.rules.diff === 'hard' && (await R('h.wd().diff')) === 'hard', 'DIFFICULTY: right goes Normal to Hard (rules and descriptor)');
  await tick({ press: 'right' });
  md = await R('h.modes()');
  check(md.diff === 'peaceful' && md.rules.naturalHostiles === false, 'and on to Peaceful (no natural hostiles)');
  await tick({ press: 'left' }); await tick({ press: 'left' }); await tick({ press: 'left' });   // peaceful -> hard -> normal -> easy
  md = await R('h.modes()');
  check(md.diff === 'easy', `left steps back (${md.diff})`);
  log('shot', await shot('s3_option_survival'));
  await tick({ press: 'right' });
  await tick({ press: 'start' }); await tick({ press: 'b' });
  check((await R('h.state()')) === 'play' && (await R('G.diff')) === 'normal', 'START closes OPTION; B closes the menu; Normal again');
  // Hardcore: MUSIC only
  await run(() => window.__rs.setMode('hardcore', 'hard'));
  await tick({ press: 'start' }); for (let i = 0; i < 6; i++) await tick({ press: 'down' }); await tick({ press: 'a' });
  opt = await R('h.optionUI() && { rows: h.optionUI().rows }');
  check(opt && opt.rows.join() === 'MUSIC,MINIMAP', `Hardcore's OPTION: ${opt && opt.rows.join(', ')} (difficulty locked)`);
  await tick({ press: 'b' }); await tick({ press: 'b' });
  // TITLE in Survival: the warning, the question; No stays, Yes goes to the title
  await run(() => window.__rs.setMode('survival', 'normal'));
  await tick({ press: 'start' }); for (let i = 0; i < 7; i++) await tick({ press: 'down' }); await tick({ press: 'a' });
  const texts = [];
  for (let i = 0; i < 120 && (await R('h.state()')) === 'msg'; i++) {
    const m = await R("h.msg() && { t: h.msg().pages.map((p) => p.join(' ')).join(' | '), ask: !!h.msg().ask }");
    if (m && !texts.includes(m.t)) texts.push(m.t);
    if (m && m.ask) break;
    await tick({ press: i % 4 === 0 ? 'a' : undefined });
  }
  for (let i = 0; i < 40; i++) await tick();
  log('TITLE texts', JSON.stringify(texts));
  log('shot', await shot('s4_title_ask'));
  check(texts.some((x) => /progress since your last save/.test(x)) && texts.some((x) => x === 'Return to the title screen?'), 'TITLE warns about unsaved progress, then asks "Return to the title screen?"');
  await tick({ press: 'a' });   // (playfix: the cursor starts on NO for this question)
  check((await R('h.state()')) === 'play', 'NO stays in the world');
  await tick({ press: 'start' }); for (let i = 0; i < 7; i++) await tick({ press: 'down' }); await tick({ press: 'a' });
  for (let i = 0; i < 160 && !(await R('h.msg() && h.msg().ask')); i++) await tick({ press: i % 4 === 0 ? 'a' : undefined });
  for (let i = 0; i < 40; i++) await tick();
  await tick({ press: 'up' }); await tick({ press: 'a' });
  check((await R('h.state()')) === 'title', 'YES goes to the title screen');
  log('shot', await shot('s5_title'));
  // (stage 9: START on the title opens the world menus; B closes them and the hook plays on in this world)
  await idle(25); await tick({ press: 'start' });
  for (let i = 0; i < 40 && !(await R('!!h.titleMenus()')); i++) { await new Promise((r) => setTimeout(r, 30)); await tick(); }
  check((await R('h.titleMenus() && h.titleMenus().top.kind')) === 'titleMenu', 'START on the title opens the main menu');
  await tick({ press: 'b' }); await run(() => window.__rs.startGame()); await idle(3);
  check((await R('h.state()')) === 'play', 'and play goes on (test hook)');
  // a hardcore TITLE: no warning, an autosave
  await run(() => window.__rs.setMode('hardcore', 'hard'));
  await tick({ press: 'start' }); for (let i = 0; i < 7; i++) await tick({ press: 'down' }); await tick({ press: 'a' });
  const firstMsg = await R("h.msg() && h.msg().pages.map((p) => p.join(' ')).join(' | ')");
  check(firstMsg === 'Return to the title screen?', `Hardcore's TITLE asks at once (it saves itself): "${firstMsg}"`);
  for (let i = 0; i < 40; i++) await tick();
  await tick({ press: 'up' }); await tick({ press: 'a' });   // (playfix: the cursor starts on NO)
  for (let i = 0; i < 30; i++) await tick();
  const autos = (await R('h.modes()')).autosaves.map((a) => a.reason);
  check((await R('h.state()')) === 'title' && autos.includes('title'), `and saves on the way to the title (${autos.slice(-3).join(', ')})`);
  await idle(25); await run(() => window.__rs.startGame()); await idle(3);
  // a spectator's START
  await run(() => window.__rs.setMode('spectator', 'hard'));
  await tick({ press: 'start' });
  const srows = await R('h.menuRows()');
  check(srows.join() === 'POKéDEX,POKéMON,STEVE,OPTION,TITLE,MAP', `a spectator's START: ${srows.join(', ')}`);
  log('shot', await shot('s6_spectator_start'));
  await tick({ press: 'b' });
  await run(() => window.__rs.setMode('survival', 'normal'));

  // ================================================================ 3. healing outside Kanto
  const party = () => R('G.party.map((m) => [m.species, m.hp, m.maxHp, m.moves[0].pp, m.moves[0].maxPp, m.status])');
  const hurtParty = () => run(() => {
    const h = window.__rs, G = h.G;
    if (!G.party.length) h.addMon('PIKACHU', 10);
    if (G.party.length < 2) h.addMon('PIDGEY', 8);
    G.party[0].hp = 1; G.party[0].status = 'psn'; G.party[0].moves[0].pp = 0; G.party[1].hp = 0;
    return G.party.length;
  });
  await hurtParty();
  // a bed on open ground near the player, used at night
  const bed = await run(async () => {
    const h = window.__rs, W = h.world, P = h.P, PL = h.PL;
    const ok = (x, y) => PL.canEnter({ riding: null }, x, y) === 'walk' && !W.isWater(x, y) && !W.block(x, y) && !W.warpAt(x, y) && W.isFloor(x, y);
    for (let r = 2; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = P.tx + dx, y = P.ty + dy;
      if ([[0, 0], [1, 0], [-1, 0], [2, 0], [0, 1], [1, 1]].every(([a, b]) => ok(x + a, y + b))) {
        W.setBlock(x + 1, y, { id: 'white_bed', orient: 'right', part: 'head', other: [x, y] });
        W.setBlock(x, y, { id: 'white_bed', orient: 'right', part: 'foot', other: [x + 1, y] });
        h.teleport(x - 1, y, 'right');
        return [x, y];
      }
    }
    return null;
  });
  check(!!bed, 'a bed placed on open ground');
  await run(() => { const h = window.__rs; h.setTime(18000); h.G.ents = h.G.ents.filter((e) => e.type !== 'mob'); });
  const p0 = await party();
  await run(([x, y]) => { const h = window.__rs; h.G.useBed(x, y, h.world.block(x, y)); }, bed);
  check((await R('h.state()')) === 'sleep', 'using the bed at night: asleep');
  let mid = null;
  for (let i = 0; i < 200 && (await R('h.state()')) === 'sleep'; i++) { await tick(); if (i === 85) mid = await shot('h1_morning_fade'); }
  const p1 = await party();
  log('party before', JSON.stringify(p0), 'after', JSON.stringify(p1), 'healed', JSON.stringify(await R('G.healedAt')));
  check(p1.every((m) => m[1] === m[2] && m[3] === m[4] && !m[5]) && (await R('G.healedAt && G.healedAt.why')) === 'bed', 'a night slept in a bed restores the party (HP, PP, status, the fainted one too)');
  check((await R('G.time')) < 2000 && (await R('h.state()')) === 'play', 'and it is morning');
  if (mid) log('shot', mid);
  // a death: back at the bed with the party restored
  await hurtParty();
  await run(() => { const h = window.__rs, P = h.P; h.teleport(P.tx + 6, P.ty, 'down'); P.health = 0; P.dead = true; P.deathT = 0; P.deathMsg = 'Steve blacked out'; h.setState('dead'); });
  await run(() => window.__rs.respawn());
  for (let i = 0; i < 120 && (await R('h.state()')) !== 'play'; i++) await tick();
  const p2 = await party();
  const at = await R('[P.tx, P.ty]');
  log('respawn at', at, 'bed', bed, JSON.stringify(p2));
  check(p2.every((m) => m[1] === m[2] && !m[5]) && Math.abs(at[0] - bed[0]) <= 2 && Math.abs(at[1] - bed[1]) <= 2, 'a whiteout respawns at the bed with the party restored');
  check(!(await errs()).length, 'no G.errors on the desktop: ' + JSON.stringify(await errs()));

  // ================================================================ 4. phone: 390 x 844, touch and the pad
  const browser = page.context().browser();
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pg = await pctx.newPage();
  const perr = [];
  pg.on('pageerror', (e) => perr.push(e.message));
  for (let k = 0; ; k++) {
    await pg.goto(base + '?new&play&world=wild&wseed=1&mode=creative');
    try { await pg.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 }); break; } catch (e) { if (k >= 1) throw e; log('phone reload'); }
  }
  await pg.evaluate(() => { const h = window.__rs; h.pause(); h.seed(2026); h.clearInv(); h.setTime(6000); });
  const PR = (expr) => pg.evaluate(new Function('return (() => { const h = window.__rs, G = h.G; return (' + expr + '); })()'));
  const ptick = (o = {}) => pg.evaluate((x) => { window.__rs.tick(x); }, { dt: 1 / 30, capture: false, ...o });
  const pidle = async (n) => { for (let i = 0; i < n; i++) await ptick(); };
  const pad = async (k) => { await pg.tap(`#pad button[data-k="${k}"]`); await ptick(); await pidle(1); };
  const ptap = async (xy) => { const [px, py] = await toPage(pg, xy[0], xy[1]); await pg.touchscreen.tap(px, py); await ptick(); };
  const prect = (expr) => PR(`(() => { const s = h.screen(); return ${expr}; })()`);
  await pad('inv');
  check((await PR("h.screen() && h.screen().kind")) === 'creative', 'phone: the pad\'s INV opens the creative inventory');
  await pg.screenshot({ path: `${OUT}/p1_open.png` });
  await ptap(centre(await prect('s.tabRect(4)')));
  check((await PR('h.screen().tab')) === 4, 'phone: a tap on the Combat tab');
  const pItem = await PR('h.screen().gridItem(0)');
  await ptap(centre(await prect('s.gridRect(0)')));
  const pc = await PR('h.screen().cursor');
  check(pc && pc.id === pItem, `phone: a tap takes ${pItem}`);
  await ptap(centre(await prect('s.hotRect(4)')));
  const ps = await PR('G.inv.slots[4]');
  check(ps && ps.id === pItem && !(await PR('h.screen().cursor')), 'phone: a tap on hotbar slot 5 places it');
  // the scroller: a tap low on the track jumps, a drag follows the finger
  await ptap(centre(await prect('s.tabRect(0)')));
  const sr = await prect('s.scrollRect()'), maxS = await PR('h.screen().maxScroll()');
  await ptap([sr.x + 6, sr.y + sr.h - 3]);
  check((await PR('h.screen().scroll')) === maxS, `phone: a tap low on the scroller goes to the end (${maxS})`);
  {
    const [ax, ay] = await toPage(pg, sr.x + 6, sr.y + sr.h - 4), [, by] = await toPage(pg, sr.x + 6, sr.y + 3);
    const cdp = await pctx.newCDPSession(pg);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ax, y: ay }] }); await ptick();
    for (let k = 1; k <= 5; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: ax, y: ay + ((by - ay) * k) / 5 }] }); await ptick(); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await ptick();
    check((await PR('h.screen().scroll')) === 0, 'phone: a finger drag up the scroller goes back to the top');
  }
  await pg.screenshot({ path: `${OUT}/p2_building.png` });
  // Search: a tap on the field opens the box; the phone keyboard types; OK commits
  await ptap(centre(await prect('s.tabRect(8)')));
  await ptap(centre(await prect('s.searchRect()')));
  const pOpen = await pg.evaluate(() => !!document.querySelector('#rs-text-entry input'));
  check(pOpen, 'phone: a tap on Search opens the page-level box');
  if (pOpen) {
    await pg.keyboard.type('ball');
    await ptick();
    await pg.screenshot({ path: `${OUT}/p3_search_typing.png` });
    await pg.tap('#rs-text-entry button[type=submit]');
    await ptick();
  }
  const pl = await PR('h.screen().list()');
  log('phone search ball', pl.join(' '));
  check(pl.length >= 3 && pl.includes('poke_ball'), `phone: "ball" finds ${pl.length} items, the POKé BALL among them`);
  await pg.screenshot({ path: `${OUT}/p4_search_done.png` });
  await pad('inv');
  check((await PR('h.state()')) === 'play', 'phone: INV closes it');
  // MENU > OPTION by the pad
  await pad('start');
  for (let i = 0; i < 6; i++) await pad('down');
  await pg.screenshot({ path: `${OUT}/p5_start_option.png` });
  await pad('a');
  check((await PR('h.state()')) === 'option', 'phone: MENU, six downs and A open OPTION');
  await pad('down'); await pad('right');
  check((await PR('h.modes().wild')) === false, 'phone: WILD POKéMON OFF with the pad');
  await pg.screenshot({ path: `${OUT}/p6_option.png` });
  await pad('b'); await pad('b');
  check((await PR('h.state()')) === 'play', 'phone: B, B back to play');
  check(!perr.length && !(await PR('(G.errors || []).length')), 'phone: no page errors: ' + JSON.stringify(perr.slice(0, 3)));
  await pctx.close();
}
