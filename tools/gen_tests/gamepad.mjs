// Controllers (src/pad.js, downloads.md "Game changes as built"): a fake navigator.getGamepads in headless Chrome drives
// the game through the Gamepad API's standard mapping, frame by frame through window.__rs.tick.
//
//   node tools/headless.mjs tools/gen_tests/gamepad.mjs --params '?new&play&world=wild&wseed=gamepad' --port 5842 --out <dir>
//
//   1. no controller: poll() never calls getGamepads and costs nothing; the touch pad and OPTION are as before;
//   2. the touch pad hides at the first button and comes back on a touch;
//   3. the stick (deadzone 0.5, let go under 0.45, so a worn stick resting at 0.40 stops Steve) and the d-pad walk
//      exactly as the arrow keys do;
//   4. START opens the menu, the d-pad moves its cursor, B closes it; OPTION gets an A BUTTON row that swaps A and B
//      (persisted), and the button that made the swap does not then press the other one;
//   5. Y opens the inventory and closes it, the d-pad moves its cursor; LB / RB the hotbar; X jumps; RT sprints (held);
//      LT drops; SELECT opens and closes the full map;
//   6. a battle: A through its messages, the d-pad across FIGHT / BAG / POKeMON / RUN, A into the moves, B back;
//   7. the creative inventory: Y opens it, RB / LB change tabs, the d-pad moves, Y closes;
//   8. text boxes: A submits the world menus' box and B cancels it, the held A never reaches the game behind it; co-op
//      JOIN: the d-pad moves between its fields and changes LOOK, B (and the keyboard's Escape) on LOOK closes it
//      without reaching the menu behind or leaving Escape held;
//   9. SELECT + START held 2 s swaps A and B with a note, and opens neither the menu nor the map, also when one lands a
//      frame or two before the other; START held alone opens the menu once;
//  10. hot-plug: unplugging lets go of everything; a Nintendo pad (by its id) gets A on the right; a device without the
//      standard mapping whose axis rests at one end (pedals) never walks Steve, and a generic pad's stick at rest does;
//  11. the hardcore death screen: the d-pad and A;
//  12. Classic: the title screen takes A, START's rows are unchanged, the SELECT + START swap works there too;
//   no G.errors, no page errors.
const A0 = 0, B1 = 1, X2 = 2, Y3 = 3, LB = 4, RB = 5, LT = 6, RT = 7, SEL = 8, START = 9, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;
const XBOX = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const NINTENDO = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)';

// the fake: navigator.getGamepads returns window.__pads (counting its calls); connect / disconnect send the events
function installFake() {
  const pads = [null, null, null, null];
  window.__pads = pads; window.__gpCalls = 0;
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, writable: true, value: () => { window.__gpCalls++; return pads; } });
  const mk = (i, id, o = {}) => ({ id, index: i, connected: true, mapping: o.mapping != null ? o.mapping : 'standard', timestamp: 0,
    axes: (o.axes || [0, 0, 0, 0]).slice(), buttons: Array.from({ length: o.nb || 17 }, () => ({ pressed: false, touched: false, value: 0 })) });
  window.__pad = {
    connect(i, id, o) { pads[i] = mk(i, id, o); const e = new Event('gamepadconnected'); e.gamepad = pads[i]; window.dispatchEvent(e); },
    plugSilently(i, id) { pads[i] = mk(i, id); },   // (there, but the browser has not announced it)
    disconnect(i) { const g = pads[i]; pads[i] = null; const e = new Event('gamepaddisconnected'); e.gamepad = g; window.dispatchEvent(e); },
    set(i, b, v) { const x = pads[i].buttons[b]; x.value = v; x.pressed = v > 0.1; x.touched = v > 0; },
    axes(i, x, y) { pads[i].axes[0] = x; pads[i].axes[1] = y; },
    clear(i) { if (!pads[i]) return; for (const x of pads[i].buttons) { x.pressed = false; x.touched = false; x.value = 0; } pads[i].axes.fill(0); },
  };
}

export default async function (t) {
  const { page, R, run, tick, idle, hold, check, log, shot } = t;
  const setB = (b, v, i = 0) => run(([b2, v2, i2]) => window.__pad.set(i2, b2, v2), [b, v, i]);
  const tapB = async (b, { i = 0, frames = 1, after = 2 } = {}) => { await setB(b, 1, i); for (let k = 0; k < frames; k++) await tick(); await setB(b, 0, i); await idle(after); };
  const axes = (x, y, i = 0) => run(([x2, y2, i2]) => window.__pad.axes(i2, x2, y2), [x, y, i]);
  const info = () => R('h.input.pad.info()');
  const st = () => R('h.state()');
  const errs = () => R('(G.errors || []).slice(0, 3)');
  const boot = async (params) => {
    const base = page.url().replace(/\/[^/]*$/, '/');
    await page.goto(base + params);
    await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
    await run(installFake);
    await run(() => { const h = window.__rs; h.pause(); h.seed(2026); if (h.rules) h.rules.encounters = false; });
  };

  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
  await run(installFake);
  await run(() => { const h = window.__rs; h.pause(); h.seed(2026); if (h.rules) h.rules.encounters = false; h.G.rules.wild = false; h.setTime(6000); });
  await run(() => { const h = window.__rs, sp = h.G.worldSpawn || { x: h.P.tx, y: h.P.ty }; h.teleport(sp.x, sp.y, 'down'); });
  await idle(4);
  // a phone's touch pad: (pointer: coarse) stands in through a page rule that shows #pad as the phone page does
  await run(() => { const s = document.createElement('style'); s.textContent = '#pad { display: flex; }'; document.head.appendChild(s); });

  // ================================================================ 1. no controller
  const cost = await run(() => {
    const h = window.__rs, n = 200000, t0 = performance.now();
    for (let i = 0; i < n; i++) h.input.poll();
    return ((performance.now() - t0) / n) * 1e6;   // ns per call
  });
  await idle(30);
  let i0 = await info();
  check(i0 && !i0.on && !i0.seen && i0.held.length === 0 && (await R('window.__gpCalls')) === 0, 'no controller: poll() never reads the Gamepad API (0 getGamepads calls in 30 frames)');
  check(cost < 200, `no controller: poll() costs ${cost.toFixed(1)} ns a frame`);
  check(i0.touchPadShown === true, 'no controller: the touch pad shows as before');
  await run((id) => window.__pad.plugSilently(0, id), XBOX);
  await tapB(START);
  check((await st()) === 'play' && (await R('window.__gpCalls')) === 0, 'a pad the browser has not announced is not read');

  // ================================================================ 2. connect; the touch pad hides at the first button, a touch brings it back
  await run((id) => window.__pad.connect(0, id), XBOX);
  await idle(2);
  i0 = await info();
  check(i0.on && !i0.seen && i0.touchPadShown === true, 'connected: nothing changes until a button is used');
  await tapB(LB); await tapB(RB);
  i0 = await info();
  check(i0.seen && i0.hidden && i0.touchPadShown === false, 'the first button hides the touch pad');
  check(/Controller ready: A is the bottom button/.test(i0.note || '') && (await R("!!document.getElementById('rs-pad-note')")), `a note says where A is: "${(i0.note || '').replace(/\n/g, ' / ')}"`);
  await run(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, isPrimary: true })));
  i0 = await info();
  check(!i0.hidden && i0.touchPadShown === true, 'a touch brings the touch pad back');
  await tapB(RB); await tapB(LB);
  check((await info()).touchPadShown === false, 'and the next button hides it again');

  // ================================================================ 3. walking: the stick and the d-pad as the arrow keys
  const sp = await R('[P.tx, P.ty]');
  const walk = async (how, dir, n) => {
    await run(([x, y]) => window.__rs.teleport(x, y, 'down'), sp); await idle(3);
    if (how === 'stick') { await axes(dir === 'right' ? 0.9 : dir === 'left' ? -0.9 : 0, dir === 'down' ? 0.9 : dir === 'up' ? -0.9 : 0); for (let k = 0; k < n; k++) await tick(); await axes(0, 0); }
    else if (how === 'dpad') { const b = { up: UP, down: DOWN, left: LEFT, right: RIGHT }[dir]; await setB(b, 1); for (let k = 0; k < n; k++) await tick(); await setB(b, 0); }
    else await hold(dir, n);
    await idle(12);
    return R('[P.tx, P.ty, P.dir]');
  };
  for (const [dir, how] of [['right', 'stick'], ['down', 'dpad'], ['left', 'stick'], ['up', 'dpad']]) {
    const viaPad = await walk(how, dir, 20), viaKeys = await walk('keys', dir, 20);
    log(`${dir}: ${how} ${viaPad.join(',')}  keys ${viaKeys.join(',')}  from ${sp.join(',')}`);
    check(viaPad.join() === viaKeys.join() && viaPad[2] === dir, `${how} ${dir}: Steve ends where the arrow key takes him (${viaPad.join(',')})`);
  }
  await run(([x, y]) => window.__rs.teleport(x, y, 'down'), sp); await idle(3);
  const stickHeld = async (x, y) => { await axes(x, y); await tick(); return R("['up', 'down', 'left', 'right'].filter((d) => h.input.held(d)).join()"); };
  const dz = [await stickHeld(0.3, 0.2), await stickHeld(0.6, 0.1), await stickHeld(0.46, 0.1), await stickHeld(0.4, 0.05), await stickHeld(0.3, 0), await stickHeld(0.55, 0.6), await stickHeld(0, 0)];
  log('stick held:', JSON.stringify(dz));
  check(dz[0] === '' && dz[1] === 'right' && dz[2] === 'right' && dz[3] === '' && dz[4] === '' && dz[5] === 'down' && dz[6] === '', 'the stick: nothing inside 0.5, held until under 0.45, one direction (the stronger axis)');
  // a worn stick: pushed right, then let go to rest at 0.40 (inside the old 0.35 to 0.5 band): Steve stops
  await run(([x, y]) => window.__rs.teleport(x, y, 'down'), sp); await idle(3);
  await axes(0.95, 0); for (let k = 0; k < 8; k++) await tick();
  const drift0 = await R('P.tx');
  await axes(0.4, 0.05); await idle(60);
  const drift = { dx: (await R('P.tx')) - drift0, held: await R("h.input.held('right')") };
  await axes(0, 0); await idle(12);
  log('stick resting at 0.40 after a push:', JSON.stringify(drift));
  check(!drift.held && drift.dx <= 2, `a stick resting at 0.40 after a push lets go: Steve stops (${drift.dx} more cells, at most the step under way)`);
  await run(([x, y]) => window.__rs.teleport(x, y, 'down'), sp); await idle(3);

  // ================================================================ 4. START, the menu, OPTION's A BUTTON row
  await tapB(START);
  check((await st()) === 'menu', 'START opens the menu');
  await tapB(DOWN);
  check((await R('h.menuCursor()')) === 1, 'the d-pad moves its cursor');
  await tapB(B1);
  check((await st()) === 'play', 'B closes it');
  await tapB(START);
  const rows = await R('h.menuRows()');
  for (let k = 0; k < rows.indexOf('OPTION'); k++) await tapB(DOWN);
  await tapB(A0);
  const opt = await R('h.optionUI() && h.optionUI().rows');
  check((await st()) === 'option' && opt && opt.join() === 'MUSIC,DIFFICULTY,MINIMAP,A BUTTON', `OPTION after a controller was used: ${opt && opt.join(', ')}`);
  for (let k = 0; k < opt.indexOf('A BUTTON'); k++) await tapB(DOWN);
  log('shot', await shot('pad_option_bottom'));
  await setB(A0, 1); await tick(); await tick(); await tick();
  let sw = await run(() => ({ a: window.__rs.input.pad.aButton(), ls: localStorage.getItem('redstone-pad-a'), st: window.__rs.state(), v: window.__rs.optionUI() && window.__rs.optionUI().value('A BUTTON') }));
  check(sw.a === 'right' && sw.ls === 'right' && sw.v === 'RIGHT', 'A on A BUTTON: A is now the right button (kept in localStorage)');
  check(sw.st === 'option', 'the bottom button, still held, did not press B (OPTION stays open)');
  await setB(A0, 0); await idle(2);
  log('shot', await shot('pad_option_right'));
  await setB(B1, 1); await tick(); await tick();
  sw = await run(() => ({ a: window.__rs.input.pad.aButton(), st: window.__rs.state() }));
  check(sw.a === 'bottom' && sw.st === 'option', 'the right button is A now: it changes the row back (BOTTOM), and OPTION stays open');
  await setB(B1, 0); await idle(2);
  await tapB(B1);
  check((await st()) === 'menu', 'the right button is B again: it closes OPTION');
  await tapB(B1);
  check((await st()) === 'play', 'and B closes the menu');

  // ================================================================ 5. inventory, hotbar, jump, sprint, drop, the map
  await tapB(Y3);
  check((await R('h.state() === "screen" && h.screen().kind')) === 'inventory', 'Y opens the inventory');
  const sel0 = await R('h.screen().sel');
  await tapB(UP);
  const sel1 = await R('h.screen().sel');
  check(sel1 !== sel0, `the d-pad moves its cursor (${sel0} to ${sel1})`);
  await tapB(Y3);
  check((await st()) === 'play', 'Y closes it');
  const hb0 = await R('G.inv.sel');
  await tapB(RB); const hb1 = await R('G.inv.sel');
  await tapB(LB); await tapB(LB); const hb2 = await R('G.inv.sel');
  check(hb1 === (hb0 + 1) % 9 && hb2 === (hb0 + 8) % 9, `RB and LB move the hotbar (${hb0}, ${hb1}, ${hb2})`);
  await setB(X2, 1); await tick();
  const jt = await R('P.jumpT');
  await setB(X2, 0); await idle(30);
  check(jt > 0, 'X jumps');
  await setB(RT, 0.9); await tick();
  const spr = await R("h.input.held('sprint')");
  await setB(RT, 0.3); await tick();
  const spr2 = await R("h.input.held('sprint')");
  await setB(RT, 0); await tick();
  check(spr && !spr2, 'RT sprints while pulled past half way');
  await run(() => { const h = window.__rs; h.G.inv.slots[h.G.inv.sel] = { id: 'cobblestone', n: 5 }; });
  await tapB(LT);
  const left = await R('G.inv.slots[G.inv.sel] ? G.inv.slots[G.inv.sel].n : 0');
  check(left === 4, `LT drops one (${left} left of 5)`);
  for (let k = 0; k < 100 && !(await R('h.minimap && h.minimap().loaded')); k++) { await new Promise((r) => setTimeout(r, 50)); await tick(); }
  await tapB(SEL, { after: 4 });
  check((await R('h.minimap().screen')) === 'map', 'SELECT opens the full map');
  await setB(RIGHT, 1); for (let k = 0; k < 10; k++) await tick(); await setB(RIGHT, 0);
  await tapB(SEL, { after: 3 });
  check((await st()) === 'play', 'SELECT closes it');

  // ================================================================ 6. a battle
  await run(() => window.__rs.encounter('PIDGEY', 3));
  let ui = null;
  for (let k = 0; k < 600; k++) {
    const b = await run(() => {
      const h = window.__rs, b2 = h.battle();
      if (h.state() !== 'battle' || !b2) return { st: h.state() };
      const e = b2.cur, msg = e && e.type === 'msg';
      const total = msg ? e.pages[e.page].reduce((n, l) => n + l.length, 0) : 0;
      return { st: 'battle', ui: b2.ui, msg, ready: msg && e.shown >= total };
    });
    if (b.st === 'battle' && b.ui === 'action' && !b.msg) { ui = b.ui; break; }
    if (b.msg && b.ready && k % 3 === 0) await tapB(A0, { after: 0 }); else await tick();
  }
  check(ui === 'action', 'A reads through the battle\'s opening messages to FIGHT / BAG / POKeMON / RUN');
  const bm = async () => R('h.battle().menu');
  await tapB(RIGHT); const m1 = await bm();
  await tapB(DOWN); const m3 = await bm();
  await tapB(LEFT); const m2 = await bm();
  await tapB(UP); const m0 = await bm();
  check([m1, m3, m2, m0].join() === '1,3,2,0', `the d-pad moves across the battle menu (${[m1, m3, m2, m0].join(', ')})`);
  await tapB(A0);
  const mv = await R('h.battle().ui');
  log('shot', await shot('pad_battle_moves'));
  await tapB(B1);
  const back = await R('h.battle().ui');
  await tapB(B1);
  const run3 = await bm();
  check(mv === 'moves' && back === 'action' && run3 === 3, `A opens FIGHT's moves, B goes back, B again puts the cursor on RUN (${mv}, ${back}, ${run3})`);
  await run(() => { const h = window.__rs; h.G.battle = null; h.setState('play'); });
  await idle(3);

  // ================================================================ 7. the creative inventory
  await run(() => window.__rs.setMode('creative', 'normal'));
  await idle(2);
  await tapB(Y3);
  const cr0 = await R('h.screen() && h.screen().tabDef ? { tab: h.screen().tab, sel: JSON.stringify(h.screen().sel) } : null');
  check(!!cr0, 'Y opens the creative inventory');
  await tapB(RB); const crT1 = await R('h.screen().tab');
  await tapB(LB); const crT2 = await R('h.screen().tab');
  check(cr0 && crT1 !== cr0.tab && crT2 === cr0.tab, `RB and LB change its tabs (${cr0 && cr0.tab}, ${crT1}, ${crT2})`);
  await tapB(DOWN); await tapB(RIGHT);
  const crS = await R('JSON.stringify(h.screen().sel)');
  check(cr0 && crS !== cr0.sel, `the d-pad moves its selection (${cr0 && cr0.sel} to ${crS})`);
  log('shot', await shot('pad_creative'));
  await tapB(Y3);
  check((await st()) === 'play', 'Y closes it');
  await run(() => window.__rs.setMode('survival', 'normal'));
  await idle(2);

  // ================================================================ 7b. a villager's trade screen
  const tr0 = await run(() => {
    const G = window.__rs.G, prof = G.tradeData && Object.keys(G.tradeData.trades)[0];
    if (!prof || !G.showTrade({ vid: 9100, prof, lvl: 1, xp: 0, uses: {}, demand: {} }, {})) return null;
    const s = window.__rs.screen(), o = s.offers[0];
    G.inv.add(o.costA, 64); if (o.costB) G.inv.add(o.costB, 64);
    return { prof, n: s.offers.length, cur: s.offerCur, focus: s.focus };
  });
  check(!!tr0, `a trade screen is open (${tr0 && tr0.prof}, ${tr0 && tr0.n} offers)`);
  if (tr0) {
    if (tr0.n > 1) { await tapB(DOWN); await tapB(UP); }
    const trA = await R('({ cur: h.screen().offerCur, focus: h.screen().focus })');
    await tapB(A0);
    const paid = await R('h.screen().pay.reduce((n, q) => n + (q ? q.n : 0), 0)');
    await tapB(RIGHT);
    const trF = await R('h.screen().focus');
    await tapB(Y3);
    check(trA.cur === 0 && paid > 0 && trF === 'slot' && (await st()) === 'play', `trade: the d-pad picks an offer, A fills its payment (${paid}), right moves to the slots, Y closes it`);
  }

  // ================================================================ 8. text boxes: the world menus' box, co-op JOIN
  await tapB(START);
  check((await st()) === 'menu', '(START: the menu, behind the text box)');
  const openBox = () => run(async () => {
    const te = await import('/src/ui/textentry.js');
    window.__te = { done: null, cancel: false };
    te.openTextEntry({ label: 'Seed', value: 'abc', onDone: (v) => { window.__te.done = v; }, onCancel: () => { window.__te.cancel = true; } });
    return document.activeElement && document.activeElement.id;
  });
  check((await openBox()) === 'rs-text-entry-in', 'a text box is open and focused');
  await setB(A0, 1); await tick(); await tick(); await tick();
  let te = await run(() => ({ ...window.__te, open: !!document.getElementById('rs-text-entry'), st: window.__rs.state(), cur: window.__rs.menuCursor() }));
  await setB(A0, 0); await idle(2);
  check(te.done === 'abc' && !te.open, 'A submits the text box (OK)');
  check(te.st === 'menu' && te.cur === 0, 'the A held after it closed never reached the menu behind');
  await openBox();
  await tapB(B1);
  te = await run(() => ({ ...window.__te, open: !!document.getElementById('rs-text-entry'), st: window.__rs.state() }));
  check(te.cancel && te.done === null && !te.open && te.st === 'menu', 'B cancels the text box, and the menu stays open');
  const join = await run(async () => { const m = await import('/src/net/ui.js'); m.openJoin({}); return document.activeElement && document.activeElement.id; });
  const focus = async () => R('document.activeElement && document.activeElement.id');
  await tapB(DOWN); const f1 = await focus();
  await tapB(DOWN); const f2 = await focus();
  const skin0 = await R("document.getElementById('coop-skin').value");
  await tapB(RIGHT); const skin1 = await R("document.getElementById('coop-skin').value");
  await tapB(UP); const f3 = await focus();
  check(join === 'coop-code' && f1 === 'coop-name' && f2 === 'coop-skin' && f3 === 'coop-name', `JOIN: the d-pad moves between its fields (${[join, f1, f2, f3].join(', ')})`);
  check(skin1 !== skin0, `JOIN: right changes LOOK (${skin0 || 'any'} to ${skin1})`);
  // B on LOOK (a select, whose keys input.js does not leave to it): JOIN closes, the menu behind does not see B, and no
  // Escape stays held
  await tapB(DOWN); const fL = await focus();
  await tapB(B1, { after: 3 });
  const jb = await run(() => ({ join: !!document.getElementById('coop-join'), st: window.__rs.state(), down: [...window.__rs.input.down].sort() }));
  check(fL === 'coop-skin' && !jb.join && jb.st === 'menu' && !jb.down.includes('esc') && !jb.down.includes('b'), `B on LOOK closes JOIN, the menu behind stays open, nothing is left held (${fL}, ${JSON.stringify(jb)})`);
  // the keyboard's Escape on LOOK: the same
  await run(async () => { const m = await import('/src/net/ui.js'); m.openJoin({}); document.getElementById('coop-skin').focus(); });
  await page.keyboard.press('Escape'); await tick(); await idle(2);
  const jk = await run(() => ({ join: !!document.getElementById('coop-join'), st: window.__rs.state(), down: [...window.__rs.input.down].sort() }));
  check(!jk.join && jk.st === 'menu' && jk.down.length === 0, `the keyboard's Escape on LOOK closes JOIN, the menu behind stays open (${JSON.stringify(jk)})`);
  await tapB(B1);
  check((await st()) === 'play', 'B closes the menu');
  // and afterwards one Escape (the Android app's Back) closes a Minecraft screen, as before
  await tapB(Y3, { after: 3 });
  const inv0 = await R('h.state() === "screen" && h.screen().kind');
  await page.keyboard.press('Escape'); await tick(); await idle(2);
  check(inv0 === 'inventory' && (await st()) === 'play', `then one Escape closes the inventory (${inv0}, ${await st()})`);

  // ================================================================ 9. SELECT + START held: swap A and B
  const a0 = (await info()).aButton;
  await setB(SEL, 1); await setB(START, 1); await tick(); await tick();
  const mid = await run(() => ({ st: window.__rs.state(), map: window.__rs.minimap().screen }));
  await new Promise((r) => setTimeout(r, 2100));
  await tick();
  const sw2 = await info();
  await setB(SEL, 0); await setB(START, 0); await idle(4);
  check(mid.st === 'play' && !mid.map, 'SELECT + START together open neither the menu nor the map');
  check(sw2.aButton !== a0 && /A and B swapped: A is now the right button/.test(sw2.note || ''), `held 2 s: A and B swap, with a note ("${sw2.note}")`);
  check((await st()) === 'play', 'letting go of them presses nothing');
  log('shot', await shot('pad_swap_note'));
  await setB(SEL, 1); await setB(START, 1); await tick();
  await new Promise((r) => setTimeout(r, 2100));
  await tick(); await setB(SEL, 0); await setB(START, 0); await idle(3);
  check((await info()).aButton === a0, 'held again: swapped back');
  // a frame or two apart, as people press two buttons: still a swap, and neither the map nor the menu opens
  for (const [first, second, gap, name] of [[SEL, START, 1, 'SELECT, then START a frame later'], [START, SEL, 2, 'START, then SELECT two frames later']]) {
    const b0 = (await info()).aButton;
    await setB(first, 1); for (let k = 0; k < gap; k++) await tick();
    await setB(second, 1); await tick();
    await new Promise((r) => setTimeout(r, 2100));
    await tick(); await setB(first, 0); await setB(second, 0); await idle(4);
    const end = await run(() => ({ st: window.__rs.state(), map: window.__rs.minimap().screen, a: window.__rs.input.pad.info().aButton }));
    check(end.st === 'play' && !end.map && end.a !== b0, `${name}: A and B swap, nothing opens (${JSON.stringify(end)})`);
    if (end.st !== 'play' || end.map) { await tapB(B1); await idle(2); }
  }
  // alone, START held (not tapped) opens the menu once, a moment late
  await setB(START, 1); for (let k = 0; k < 40; k++) await tick();
  const sHeld = await st();
  await setB(START, 0); await idle(3);
  check(sHeld === 'menu', `START held alone opens the menu (${sHeld})`);
  await tapB(B1);
  check((await st()) === 'play', '(B closes it)');

  // ================================================================ 10. hot-plug
  await axes(0.9, 0); await tick();
  const heldR = await R("h.input.held('right')");
  await run(() => window.__pad.disconnect(0));
  await tick(); await tick();
  const gone = await run(() => ({ held: window.__rs.input.held('right'), on: window.__rs.input.pad.info().on }));
  check(heldR && !gone.held && !gone.on, 'unplugged while walking: Steve stops, the pad is off');
  await idle(10);
  const calls0 = await R('window.__gpCalls'); await idle(10);
  check((await R('window.__gpCalls')) === calls0, 'and with none left, nothing is read');
  await run(() => { localStorage.removeItem('redstone-pad-a'); window.__rs.input.pad.pref = null; });
  await run((id) => window.__pad.connect(1, id), NINTENDO);
  await tapB(START, { i: 1 });
  check((await st()) === 'menu' && (await info()).aButton === 'right', 'a Nintendo controller plugged in: A is the right button (by its id)');
  await tapB(B1, { i: 1 });
  check((await st()) === 'dex', 'its right button (A) picks POKeDEX');
  await tapB(A0, { i: 1 });
  check((await st()) === 'play', 'its bottom button (B) goes back');
  // devices without the standard mapping: pedals whose axis rests at one end never walk Steve; a generic pad's stick
  // counts once it has rested near the centre for half a second
  await run(([x, y]) => window.__rs.teleport(x, y, 'down'), sp); await idle(3);
  await run(() => window.__pad.connect(3, 'Pedals (Vendor: 046d Product: c262)', { mapping: '', nb: 4, axes: [0, -1, 0] }));
  await idle(40);
  const ped = await run(() => ({ at: [window.__rs.P.tx, window.__rs.P.ty], down: [...window.__rs.input.down].sort(), st: window.__rs.state() }));
  check(ped.at.join() === sp.slice(0, 2).join() && ped.down.length === 0 && ped.st === 'play', `pedals resting at -1 (no standard mapping) never walk Steve (${JSON.stringify(ped)})`);
  await run(() => window.__pad.connect(2, 'USB Gamepad (Vendor: 0079 Product: 0011)', { mapping: '', nb: 10, axes: [0, 0] }));
  await idle(40);
  await axes(0.9, 0, 2); for (let k = 0; k < 20; k++) await tick(); await axes(0, 0, 2); await idle(12);
  const gen = await R('[P.tx, P.ty]');
  check(gen[0] > sp[0] && gen[1] === sp[1], `a generic pad's stick walks Steve once it has rested (${sp[0]} to ${gen[0]})`);
  await run(() => { window.__pad.disconnect(3); window.__pad.disconnect(2); }); await idle(3);

  // ================================================================ 11. the hardcore death screen
  await run(() => { const h = window.__rs; h.setMode('hardcore', 'hard'); h.P.invuln = 0; h.G.hurtPlayer(100, 'Steve was slain by Zombie'); });
  for (let k = 0; k < 90 && !(await R('!!(h.hcScreen() && h.hcScreen().active)')); k++) await tick();
  check((await st()) === 'dead' && (await R('h.hcScreen() && h.hcScreen().kind')) === 'hardcoreDeath', 'Game over! screen');
  await tapB(DOWN, { i: 1 }); const hs1 = await R('h.hcScreen().sel');
  await tapB(UP, { i: 1 }); const hs0 = await R('h.hcScreen().sel');
  await tapB(B1, { i: 1 }); await idle(4);   // (A on this Nintendo pad)
  const spec = await R('({ m: h.modes().mode, st: h.state() })');
  check(hs1 === 1 && hs0 === 0 && spec.m === 'spectator' && spec.st === 'play', `the d-pad and A on it: Spectate World (${hs1}, ${hs0}, ${spec.m})`);
  check((await errs()).length === 0, `no G.errors in the generated world ${JSON.stringify(await errs())}`);

  // ================================================================ 12. Classic: the title, START's rows, the swap
  await boot('?new');
  check((await st()) === 'title', 'Classic title');
  await run((id) => window.__pad.connect(0, id), XBOX);
  await idle(25);
  await tapB(A0, { after: 3 });
  for (let k = 0; k < 40 && (await st()) === 'title' && !(await R('!!h.titleMenus()')); k++) { await new Promise((r) => setTimeout(r, 30)); await tick(); }
  const tm = await R("h.state() !== 'title' || !!h.titleMenus()");
  check(tm, 'A on the title screen goes on (the title menus open)');
  await boot('?new&play');
  await run((id) => window.__pad.connect(0, id), XBOX);
  await tapB(START);
  const crow = await R('h.menuRows().join()');
  check((await st()) === 'menu' && crow === 'POKéDEX,POKéMON,BAG,STEVE,SAVE,CO-OP,EXIT', `Classic's START is unchanged: ${crow}`);
  await tapB(B1);
  const ca = (await info()).aButton;
  await setB(SEL, 1); await setB(START, 1); await tick();
  await new Promise((r) => setTimeout(r, 2100));
  await tick(); await setB(SEL, 0); await setB(START, 0); await idle(3);
  const ci = await info();
  check(ci.aButton !== ca && (await st()) === 'play' && /swapped/.test(ci.note || ''), `Classic: SELECT + START held 2 s swaps A and B (${ca} to ${ci.aButton}) with the note`);
  log('shot', await shot('pad_classic_note'));
  check((await errs()).length === 0, `no G.errors in Classic ${JSON.stringify(await errs())}`);
}
