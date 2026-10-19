// Stage 9: the title's world menus in the game (design 7.1 to 7.6; build order stage 9).
//
//   node tools/headless.mjs tools/gen_tests/title_menus.mjs --params '?new&video' --port 5690 --out <dir>
//
// 1. ?video: PRESS START plays at once, the menu modules are never requested (the films' flow).
// 2. Desktop (1280 x 800, real mouse and keys): a fresh browser's title opens FireRed's main menu (CONTINUE with Classic
//    Kanto, NEW GAME); NEW GAME > Create New World with the name and seed typed into the page box; Create reloads into
//    the new Wild World (loading screens captured), playing at once, listed and saved; the trainer card's SEED; TITLE
//    leaves the world and CONTINUE reloads it from its save. Hardcore and Creative worlds by the menus. A Classic save,
//    WORLDS > Select World (Classic Kanto listed), a generated world played from it, Classic Kanto played from it, a
//    world deleted, Classic Kanto deleted with its two confirmations (the booted world: a reboot), the 5-world cap, a
//    Kanto World request (a Kanto World since stage 6a; Classic before).
// 3. Phone (390 x 844, touch, the pad): the same seed typed on the phone keyboard gives the same world as on desktop.
export default async function (t) {
  let { page } = t;
  const { R, run, tick, idle, check, log, OUT } = t;
  const base = page.url().replace(/\?.*$/, '');
  const shots = [];
  let retries = 0;
  // a page's errors, without the asset loads the local server dropped under load (the load is retried)
  const realErrors = (list) => list.filter((m) => !/^failed to load assets\//.test(m));
  const canvasShot = async (pg, name) => { const url = await pg.evaluate(() => document.getElementById('game').toDataURL('image/png')); const f = `${OUT}/${name}.png`; (await import('node:fs')).writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); shots.push(f); return f; };
  const toPage = async (pg, x, y) => pg.evaluate(([x, y]) => { const c = document.getElementById('game'), r = c.getBoundingClientRect(); return [r.left + (x / c.width) * r.width, r.top + (y / c.height) * r.height]; }, [x, y]);
  const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];

  // ================================================================ 1. ?video: today's title
  const reqs = [];
  page.on('request', (r) => reqs.push(r.url()));
  await idle(30);
  check((await R('h.state()')) === 'title', '?video boots on the title');
  await tick({ press: 'start' }); await idle(3);
  const vst = await R('[h.state(), !!h.titleMenus()]');
  check(vst[0] === 'play' && !vst[1], `?video: PRESS START plays at once, no world menus (${vst.join(', ')})`);
  check(!reqs.some((u) => /worldmenu|worlds\.js|modes\.js|mcgui/.test(u)), `?video: no menu module requested (${reqs.filter((u) => /\/src\//.test(u)).length} module requests after the press)`);

  // ---------------------------------------------------------------- helpers for one page
  const tools = (pg, label) => {
    const PR = (expr) => pg.evaluate(new Function('return (() => { const h = window.__rs, G = h.G, P = h.P, W = h.world; return (' + expr + '); })()'));
    const ptick = (o = {}) => pg.evaluate((x) => { window.__rs.tick(x); }, { dt: 1 / 30, capture: false, ...o });
    const pidle = async (n) => { for (let i = 0; i < n; i++) await ptick(); };
    const top = () => PR('(() => { const m = h.titleMenus(); const s = m && m.top; return s ? { kind: s.kind, items: s.items ? s.items.map((i) => i.id) : null, sel: s.sel, focus: s.focus, child: s.child ? s.child.kind : null } : null; })()');
    // a page load (goto or the menus' reload): wait for the game, capturing the canvas while it loads
    const settle = async (loading = null) => {
      const frames = [];
      for (let i = 0, t0 = Date.now(), tries = 0; i < 4000; i++) {
        // (the local server sometimes drops a request under load and the page never gets ready: reload it, which keeps
        // an unread sessionStorage request)
        if (Date.now() - t0 > 40000 && tries < 2) { tries++; t0 = Date.now(); log(label, 'reload after a stuck load'); retries++; try { await pg.reload(); } catch (e) { /* again */ } }
        let st = null;
        try { st = await pg.evaluate(() => ({ mark: !!window.__mark, ready: !!(window.__rs && window.__rs.ready), img: window.__rs && window.__rs.ready ? null : (document.getElementById('game') || {}).toDataURL?.('image/png') })); } catch (e) { st = null; }
        if (st && !st.mark && st.ready) break;
        if (st && !st.mark && st.img && loading && frames.length < 40) frames.push(st.img);
        await new Promise((r) => setTimeout(r, 60));
      }
      await pg.evaluate(() => { const h = window.__rs; h.pause(); h.seed(2026); });
      if (loading && frames.length) {
        const fs = await import('node:fs');
        const uniq = [...new Set(frames)];
        const pick = [...new Set([0.5, 0.65, 0.8, 1].map((q) => uniq[Math.min(uniq.length - 1, Math.floor(uniq.length * q))]))].filter(Boolean);
        pick.forEach((u, i) => { const f = `${OUT}/${loading}_${i}.png`; fs.writeFileSync(f, Buffer.from(u.split(',')[1], 'base64')); shots.push(f); });
        log(label, 'loading frames', frames.length, 'distinct', uniq.length);
      }
      return frames.length;
    };
    const go = async (q, loading) => { await pg.goto(base + q); return settle(loading); };
    // something that makes the menus reload the page: mark the document first
    const reloadAfter = async (fn, loading) => { await pg.evaluate(() => { window.__mark = 1; }); await fn(); return settle(loading); };
    const click = async (xy) => { const [px, py] = await toPage(pg, xy[0], xy[1]); await pg.mouse.move(px, py); await pg.mouse.click(px, py); await ptick(); };
    const tap = async (xy) => { const [px, py] = await toPage(pg, xy[0], xy[1]); await pg.touchscreen.tap(px, py); await ptick(); };
    const widget = (name) => PR(`(() => { const s = h.titleMenus().top; const w = s.w[${JSON.stringify(name)}]; return { x: w.x, y: w.y, w: w.w, h: w.h, active: w.active !== false, hidden: !!w.hidden }; })()`);
    const titleItem = (id) => PR(`(() => { const it = h.titleMenus().top.items.find((i) => i.id === ${JSON.stringify(id)}); return it ? { x: it.x * 2, y: it.y * 2, w: it.w * 2, h: it.h * 2 } : null; })()`);
    // PRESS START on the title: the main menu once its modules are in
    const openMenus = async (how = 'key') => {
      await pidle(50);
      if (how === 'key') await ptick({ press: 'start' }); else await how();
      for (let i = 0; i < 60 && !(await PR('!!h.titleMenus()')); i++) { await new Promise((r) => setTimeout(r, 30)); await ptick(); }
      await pidle(2);
      return top();
    };
    // the field's page box: type and commit
    const typeInto = async (text, commit = 'enter') => {
      const open = await pg.evaluate(() => !!document.querySelector('#rs-text-entry input'));
      if (!open) return false;
      await pg.evaluate(() => { const i = document.querySelector('#rs-text-entry input'); i.focus(); i.select(); });
      await pg.keyboard.type(text);
      await ptick();
      if (commit === 'enter') await pg.keyboard.press('Enter'); else await pg.tap('#rs-text-entry button[type=submit]');
      await ptick();
      return true;
    };
    return { PR, ptick, pidle, top, settle, go, reloadAfter, click, tap, widget, titleItem, openMenus, typeInto };
  };

  // ================================================================ 2. desktop
  const browser = page.context().browser();
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const harness = page;
  page = await dctx.newPage();
  const derr = [];
  page.on('pageerror', (e) => derr.push(e.message));
  const D = tools(page, 'desktop');
  const errsD = () => D.PR('(G.errors || []).slice(0, 3)');
  await D.go('');
  check((await D.PR('h.state()')) === 'title' && (await D.PR('h.world.layout.gen')) === false, 'a fresh browser boots Classic on the title');
  let tp = await D.openMenus();
  log('main menu', JSON.stringify(tp));
  check(tp && tp.kind === 'titleMenu' && tp.items.join() === 'continue,new', `PRESS START opens the main menu: ${tp && tp.items.join(', ')}`);
  check((await D.PR('h.titleMenus().top.cont.name')) === 'Classic Kanto', 'CONTINUE shows the booted world, Classic Kanto (a fresh browser can still play Classic)');
  await canvasShot(page, 'd1_main_menu');
  // B goes back to PRESS START, START again, then NEW GAME by a click
  await D.ptick({ press: 'b' }); await D.pidle(2);
  check((await D.PR('h.titleMenus()')) === null && (await D.PR('h.state()')) === 'title', 'B on the main menu goes back to PRESS START');
  await D.openMenus();
  await D.click(centre(await D.titleItem('new')));
  await D.pidle(2);
  tp = await D.top();
  check(tp && tp.kind === 'createWorld', 'a click on NEW GAME opens Create New World');
  const types = await D.PR('h.titleMenus().top.types');
  check(JSON.stringify(types) === '["kanto","wild"]' && (await D.PR('h.titleMenus().top.type')) === 'kanto', `World Type offers ${types.join(', ')}, Kanto World first (Kanto Worlds boot since stage 6a)`);
  // World Name: a click on the field opens the page box; typed with the keyboard
  await D.click(centre(await D.widget('name')));
  check(await D.typeInto('Birch Camp'), 'a click on World Name opens the page-level text box');
  check((await D.PR('h.titleMenus().top.name')) === 'Birch Camp', 'World Name typed: Birch Camp');
  await canvasShot(page, 'd2_create_game');
  // the World tab, the seed
  await D.click(centre(await D.widget('tabWorld')));
  // (stage 6a: the default is a Kanto World; this world is a Wild World, as the checks below and the phone's expect)
  await D.click(centre(await D.widget('type')));
  check((await D.PR('h.titleMenus().top.type')) === 'wild', 'a click on World Type cycles to Wild World');
  await D.click(centre(await D.widget('seed')));
  const attrs = await page.evaluate(() => { const i = document.querySelector('#rs-text-entry input'); return i ? ['autocapitalize', 'autocorrect', 'autocomplete', 'spellcheck'].map((k) => i.getAttribute(k)).join() : null; });
  check(attrs === 'off,off,off,false', `the text box has autocapitalize, autocorrect, autocomplete off and spellcheck false (${attrs})`);
  await page.screenshot({ path: `${OUT}/d3_seed_box.png` }); shots.push(`${OUT}/d3_seed_box.png`);
  check(await D.typeInto('hello'), 'the seed typed into the box');
  await canvasShot(page, 'd4_create_world_tab');
  // Create: a reload into the new world, played at once
  let nLoad = await D.reloadAfter(async () => D.click(centre(await D.widget('create'))), 'd5_loading');
  check(nLoad > 0, `the loading screens were seen while the world was made (${nLoad} frames)`);
  let st = await D.PR('({ state: h.state(), gen: h.world.layout.gen, wd: h.wd(), wid: h.wid(), seed: h.gen.seed(), hash: h.gen.hash(), mode: h.modes().mode, boot: h.boot() })');
  log('created', JSON.stringify({ ...st, wd: st.wd }));
  check(st.state === 'play' && st.gen && st.wd.type === 'wild' && st.wd.name === 'Birch Camp' && st.wd.seedText === 'hello' && st.seed === 99162322 && st.mode === 'survival',
    `Create New World reloads into a Wild World playing at once: "${st.wd.name}", seed "${st.wd.seedText}" = ${st.seed}, ${st.mode}`);
  const deskHash = st.hash, firstId = st.wid;
  check((await D.PR('new URLSearchParams(location.search).has("new")')) === false && (await page.evaluate(() => sessionStorage.getItem('rs.world'))) === null, 'the request was used once and the boot query is clean');
  for (let i = 0; i < 60 && !(await D.PR('!!(h.worlds() && h.worlds().entryOf(h.wid()))')); i++) { await new Promise((r) => setTimeout(r, 50)); await D.ptick(); }
  const ent = await D.PR('h.worlds().entryOf(h.wid())');
  const stored = await page.evaluate(async () => { const s = await window.__rs.worlds().loadWorld(window.__rs.wid()); return s ? { v: s.v, name: s.wd.name, seed: s.wd.seed } : null; });
  check(ent && ent.name === 'Birch Camp' && ent.type === 'wild' && ent.seed === 99162322 && (await D.PR('h.worlds().readList().last')) === firstId && stored && stored.v === 2 && stored.seed === 99162322,
    'the new world is listed, last played, and saved at once (IndexedDB) without a SAVE');
  await D.pidle(20);
  await canvasShot(page, 'd6_new_world');
  // the trainer card: SEED
  await page.evaluate(() => window.__rs.setState('card')); await D.ptick();
  check((await D.PR('h.cardSeed()')) === 'hello', 'the trainer card shows SEED hello');
  await canvasShot(page, 'd7_card_seed');
  await page.evaluate(() => window.__rs.setState('play')); await D.ptick();
  // a change, then TITLE: the world is left; CONTINUE reloads it from its save (the unsaved change is gone)
  await page.evaluate(() => { window.__rs.G.money = 4321; });
  await D.ptick({ press: 'start' }); await D.pidle(2);
  for (let i = 0; i < 7; i++) await D.ptick({ press: 'down' });
  const rowNow = await D.PR('h.menuRows()[h.menuCursor()]');
  await D.ptick({ press: 'a' });
  for (let i = 0; i < 200 && !(await D.PR('h.msg() && h.msg().ask')); i++) await D.ptick({ press: i % 4 === 0 ? 'a' : undefined });
  await D.pidle(40); await D.ptick({ press: 'up' }); await D.ptick({ press: 'a' }); await D.pidle(2);   // (playfix: the cursor starts on NO)
  check(rowNow === 'TITLE' && (await D.PR('h.state()')) === 'title' && (await D.PR('h.titleLeft()')), 'START > TITLE > YES leaves the world for the title');
  tp = await D.openMenus();
  check(tp.items.join() === 'continue,new' && (await D.PR('h.titleMenus().top.cont.name')) === 'Birch Camp', `the main menu's CONTINUE is the world just left (${tp.items.join(', ')})`);
  await canvasShot(page, 'd8_main_menu_continue');
  await D.reloadAfter(async () => { await D.ptick({ press: 'a' }); });
  st = await D.PR('({ state: h.state(), wid: h.wid(), money: h.G.money })');
  check(st.state === 'play' && st.wid === firstId && st.money !== 4321, `CONTINUE after TITLE reloads the same world from its save (money ${st.money}, the unsaved 4321 gone)`);

  // a Hardcore world and a Creative world, made through the menus with keys only (the pad's path)
  const makeWorld = async (modePresses, name, seed) => {
    await page.evaluate(() => window.__rs.setState('title')); await D.ptick();
    tp = await D.openMenus();
    const iNew = tp.items.indexOf('new');
    for (let i = 0; i < iNew; i++) await D.ptick({ press: 'down' });
    await D.ptick({ press: 'a' }); await D.pidle(2);
    // focus starts on Game Mode: A cycles it
    for (let i = 0; i < modePresses; i++) await D.ptick({ press: 'a' });
    await D.ptick({ press: 'up' });                       // World Name
    await D.ptick({ press: 'a' });
    await D.typeInto(name);
    await D.ptick({ press: 'up' }); await D.ptick({ press: 'right' });   // the World tab
    await D.ptick({ press: 'down' }); await D.ptick({ press: 'down' });  // World Type, Seed
    await D.ptick({ press: 'a' });
    const ok = await D.typeInto(seed);
    const req = await D.PR('(() => { const s = h.titleMenus().top; return { mode: s.mode, diff: s.diff, name: s.name, seed: s.seedText, tab: s.tab }; })()');
    await canvasShot(page, `d9_create_${name.replace(/\W/g, '')}`);
    await D.reloadAfter(async () => { await D.ptick({ press: 'down' }); await D.ptick({ press: 'a' }); });
    return { ok, req, st: await D.PR('({ state: h.state(), wd: h.wd(), mode: h.modes().mode, diff: h.modes().diff, seed: h.gen.seed(), wid: h.wid() })') };
  };
  const hc = await makeWorld(1, 'Hard Place', '-7');
  log('hardcore', JSON.stringify(hc));
  check(hc.ok && hc.st.state === 'play' && hc.st.mode === 'hardcore' && hc.st.diff === 'hard' && hc.st.wd.name === 'Hard Place' && hc.st.seed === -7, `a Hardcore world by keys: ${hc.st.mode}, ${hc.st.diff}, seed ${hc.st.seed}`);
  await D.pidle(10);
  await canvasShot(page, 'd10_hardcore_world');
  const cr = await makeWorld(2, 'Free Build', 'Hello');
  log('creative', JSON.stringify(cr));
  check(cr.ok && cr.st.mode === 'creative' && cr.st.wd.name === 'Free Build' && cr.st.seed !== 99162322, `a Creative world: ${cr.st.mode}, seed "Hello" = ${cr.st.seed} (not "hello"'s)`);

  // a Classic save, then the list: Select World
  await D.go('?new&play');
  await page.evaluate(() => window.__rs.save());
  check((await page.evaluate(() => JSON.parse(localStorage.getItem('poke-redstone-worlds')).last)) === 'classic', 'a Classic save makes Classic the last played world');
  await D.go('');
  check((await D.PR('h.world.layout.gen')) === false && (await D.PR('h.state()')) === 'title', 'the boot picks the last played world: Classic, on the title');
  tp = await D.openMenus();
  check(tp.items.join() === 'continue,new,worlds', `with 4 worlds the main menu has WORLDS: ${tp.items.join(', ')}`);
  await D.ptick({ press: 'down' }); await D.ptick({ press: 'down' }); await D.ptick({ press: 'a' }); await D.pidle(2);
  tp = await D.top();
  const listed = await D.PR('h.titleMenus().top.list.map((e) => e.name)');
  check(tp.kind === 'selectWorld' && listed.length === 4 && listed.includes('Classic Kanto') && listed[0] === 'Classic Kanto', `WORLDS opens Select World: ${listed.join(', ')}`);
  await canvasShot(page, 'd11_select_world');
  // a generated world played from the list: a click on its row, then Play Selected World
  const row = async (name) => { const i = await D.PR(`h.titleMenus().top.list.findIndex((e) => e.name === ${JSON.stringify(name)})`); const l = await D.widget('list'); return [l.x + 60, 26 + 4 + i * 36 + 16]; };
  await D.click(await row('Birch Camp'));
  await D.reloadAfter(async () => D.click(centre(await D.widget('play'))));
  st = await D.PR('({ state: h.state(), wid: h.wid(), last: h.worlds().readList().last })');
  check(st.state === 'play' && st.wid === firstId && st.last === firstId, 'Play Selected World loads that world, playing at once, and makes it last played');
  // Classic Kanto from the list (from a generated world's title)
  await page.evaluate(() => window.__rs.setState('title')); await D.ptick();
  await D.openMenus(); await D.ptick({ press: 'down' }); await D.ptick({ press: 'down' }); await D.ptick({ press: 'a' }); await D.pidle(2);
  await D.click(await row('Classic Kanto'));
  await D.reloadAfter(async () => { const r = await row('Classic Kanto'); await D.click(r); });   // a second click on the selected world plays it
  st = await D.PR('({ state: h.state(), gen: h.world.layout.gen, last: JSON.parse(localStorage.getItem("poke-redstone-worlds")).last })');
  check(st.state === 'play' && st.gen === false && st.last === 'classic', 'a second click on Classic Kanto plays Classic (last played: classic)');
  // delete a generated world (not the booted one)
  await page.evaluate(() => window.__rs.setState('title')); await D.ptick();
  await D.openMenus(); await D.ptick({ press: 'down' }); await D.ptick({ press: 'down' }); await D.ptick({ press: 'a' }); await D.pidle(2);
  await D.click(await row('Free Build'));
  await D.click(centre(await D.widget('del')));
  const ask1 = await D.PR('(() => { const c = h.titleMenus().top.child; return c ? { title: c.title, lines: c.lines.map((l) => l.text), yes: c.w.yes.label } : null; })()');
  await canvasShot(page, 'd12_delete_ask');
  check(ask1 && ask1.title === 'Are you sure you want to delete this world?' && ask1.lines[0] === "'Free Build' will be lost forever! (A long time!)" && ask1.yes === 'Delete', `Delete asks: ${ask1 && ask1.lines.join(' / ')}`);
  await D.click(centre(await D.PR('(({ x, y, w, h }) => ({ x, y, w, h }))(h.titleMenus().top.child.w.yes)')));
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 20)); await D.ptick(); }
  const afterDel = await D.PR('h.titleMenus().top.list.map((e) => e.name)');
  const gone = await page.evaluate(async (id) => { const W = await import('/src/worlds.js'); return { save: await W.loadWorld(id), entry: W.entryOf(id) }; }, cr.st.wid);
  check(!afterDel.includes('Free Build') && afterDel.length === 3 && !gone.save && !gone.entry, `the world is gone from the list and from IndexedDB (${afterDel.join(', ')})`);
  // delete Classic Kanto, the booted world: two confirmations, the second "Delete Classic Kanto", then a reboot
  await D.click(await row('Classic Kanto'));
  await D.click(centre(await D.widget('del')));
  const c1 = await D.PR('h.titleMenus().top.child.lines.map((l) => l.text)');
  check(c1.includes("Classic Kanto can't be made again."), `Classic's warning: ${c1.join(' / ')}`);
  await D.click(centre(await D.PR('(({ x, y, w, h }) => ({ x, y, w, h }))(h.titleMenus().top.child.w.yes)')));
  const c2 = await D.PR('h.titleMenus().top.child && h.titleMenus().top.child.w.yes.label');
  await canvasShot(page, 'd13_delete_classic_second');
  check(c2 === 'Delete Classic Kanto', `a second confirmation whose button reads "${c2}"`);
  for (let i = 0; i < 18; i++) await D.ptick();   // (playfix: the second confirmation ignores input for half a second)
  await D.click(centre(await D.PR('(({ x, y, w, h }) => ({ x, y, w, h }))(h.titleMenus().top.child.w.yes)')));
  for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 20)); await D.ptick(); }
  check((await page.evaluate(() => localStorage.getItem('poke-redstone-v1'))) === null, 'the Classic save is deleted');
  await D.reloadAfter(async () => { await D.ptick({ press: 'b' }); await D.ptick({ press: 'b' }); });
  st = await D.PR('({ state: h.state(), gen: h.world.layout.gen, wid: h.wid(), left: h.leftTo() })');
  check(st.state === 'title' && st.gen && st.wid === firstId, `leaving after deleting the booted world reboots into the newest world left, on the title (${st.wid})`);
  // the cap: 5 listed worlds disable Create New World
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('poke-redstone-worlds')); for (let i = d.worlds.length; i < 5; i++) d.worlds.push({ id: 'wfake' + i, name: 'Fake ' + i, type: 'wild', seed: i, seedText: String(i), mode: 'survival', diff: 'normal', gen: 1, created: 1, played: 1 }); localStorage.setItem('poke-redstone-worlds', JSON.stringify(d)); });
  tp = await D.openMenus();
  await D.ptick({ press: 'down' }); await D.ptick({ press: 'a' }); await D.pidle(2);
  const cap = await D.widget('create');
  check((await D.top()).kind === 'createWorld' && cap.active === false, 'with 5 worlds Create New World is disabled');
  await D.ptick({ press: 'b' }); await D.pidle(2);
  await D.ptick({ press: 'b' }); await D.pidle(2);
  // a Kanto World request boots a Kanto World (stage 6a; before it, Classic on the title)
  await page.evaluate(() => sessionStorage.setItem('rs.world', JSON.stringify({ op: 'new', name: 'K', type: 'kanto', mode: 'survival', diff: 'normal', seedText: '1' })));
  await D.go('');
  check((await D.PR('h.world.layout.kind')) === 'kanto' && (await D.PR('h.state()')) === 'play', 'a Kanto World request boots a Kanto World (stage 6a)');
  check(!(await errsD()).length && !realErrors(derr).length, 'no G.errors or page errors on the desktop: ' + JSON.stringify([...(await errsD()), ...realErrors(derr)]));
  await dctx.close();
  page = harness;

  // ================================================================ 3. phone: 390 x 844, touch, the pad, the phone keyboard
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pg = await pctx.newPage();
  const perr = [];
  pg.on('pageerror', (e) => perr.push(e.message));
  await pg.goto(base);
  const Ph = tools(pg, 'phone');
  await Ph.settle();
  const pad = async (k) => { await pg.tap(`#pad button[data-k="${k}"]`); await Ph.ptick(); };
  tp = await Ph.openMenus(async () => pad('a'));
  check(tp && tp.kind === 'titleMenu', 'phone: the pad\'s A on PRESS START opens the main menu');
  await canvasShot(pg, 'p1_main_menu');
  await Ph.tap(centre(await Ph.titleItem('new'))); await Ph.pidle(2);
  check((await Ph.top()).kind === 'createWorld', 'phone: a tap on NEW GAME opens Create New World');
  await canvasShot(pg, 'p2_create');
  await Ph.tap(centre(await Ph.widget('tabWorld')));
  await Ph.tap(centre(await Ph.widget('type')));   // (stage 6a: Kanto World first; the desktop's world is a Wild World)
  await Ph.tap(centre(await Ph.widget('seed')));
  const popen = await pg.evaluate(() => !!document.querySelector('#rs-text-entry input') && document.activeElement && document.activeElement.id === 'rs-text-entry-in');
  check(popen, 'phone: a tap on the seed field opens the box with its input focused (the keyboard)');
  if (popen) { await pg.keyboard.type('hello'); await Ph.ptick(); await pg.screenshot({ path: `${OUT}/p3_seed_typing.png` }); shots.push(`${OUT}/p3_seed_typing.png`); await pg.tap('#rs-text-entry button[type=submit]'); await Ph.ptick(); }
  check((await Ph.PR('h.titleMenus().top.seedText')) === 'hello', 'phone: the seed field holds "hello"');
  await canvasShot(pg, 'p4_world_tab');
  await Ph.reloadAfter(async () => Ph.tap(centre(await Ph.widget('create'))), 'p5_loading');
  st = await Ph.PR('({ state: h.state(), seed: h.gen.seed(), hash: h.gen.hash(), wd: h.wd() })');
  log('phone world', JSON.stringify({ seed: st.seed, hash: st.hash }), 'desktop hash', deskHash);
  check(st.state === 'play' && st.seed === 99162322 && st.hash === deskHash && st.wd.seedText === 'hello', `phone: "hello" typed on the phone gives the desktop's world (seed ${st.seed}, plan hash ${st.hash})`);
  await Ph.pidle(10);
  await pg.screenshot({ path: `${OUT}/p6_phone_world.png` }); shots.push(`${OUT}/p6_phone_world.png`);
  check(!realErrors(perr).length && !(await Ph.PR('(G.errors || []).length')), 'phone: no page errors: ' + JSON.stringify(perr.slice(0, 3)));
  await pctx.close();
  log('shots', shots.length, OUT, 'stuck loads retried', retries);
  void run; void tick;
}
