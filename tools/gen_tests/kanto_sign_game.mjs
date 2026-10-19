// The Kanto signpost in the game (minimap design, Track SIGN, 5.1). One browser context (IndexedDB and localStorage
// carry across the page loads):
//   1. for each seed (1, 2, hello, 24, -7, 9): h.kantoSign() equals src/gen/sign.js run here in Node; the grid holds
//      signBase + dir at each sign's cell (collision 1, behaviour 0x84), the chunk's pristine copy (cbase) too, and
//      every other cell of that chunk equals the painter's own (h.gen.client.sync); the gate sign likewise once its
//      chunk is made;
//   2. Steve faces the spawn sign as the world opens (offset 0, +1); A opens FireRed's message with the exact two lines,
//      and so does X (the gate sign's text too);
//   3. it is not minable by hand, in Survival and in Creative: closing the message with A and holding A for 3 s, A held
//      while turning to face it, an A pressed during the last step toward it (the queued press) all leave it, with no
//      P.mining and no "too sturdy" toast; X with a block, a water bucket or food in hand reads it and places, pours or
//      eats nothing;
//   4. a TNT blast beside it breaks it (an edit); save, reload the world by its id: still broken; a new world from the
//      same seed has it again;
//   5. a Kanto World saved by the release (v8-world-release, served read-only on the next port) loads here with no
//      error and shows the sign;
//   6. no sign in a Wild World (no sign entries, no G.signHook) nor under ?video;
//   7. with kanto_sign.png missing, the world boots and the cell shows FireRed's own sign.
// Screenshots (each arrow at the spawn, the message box, the gate sign) go to --out; with SIGN_SHOTS=<dir> the page is
// also shot at 960 x 720 and in a phone-sized landscape context (844 x 390, touch) into that folder.
//
//   node tools/headless.mjs tools/gen_tests/kanto_sign_game.mjs --params '?new&play&world=kanto&wseed=1' --port 5666 --out <dir>
//   (SIGN_RELEASE_PORT, default the next port: the release's server; SIGN_PARTS=1,2,3,4,5,6,7,8 to pick parts)
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE = path.resolve(ROOT, 'out', 'baselines', 'v8-world-release');
const WORDS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const SEEDS = ['1', '2', 'hello', '24', '-7', '9'];

export default async function (t) {
  const { page, R, run, tick, idle, press, shot, check, log, OUT } = t;
  const PARTS = new Set((process.env.SIGN_PARTS || '1,2,3,4,5,6,7,8').split(','));
  const base = page.url().replace(/\?.*$/, '');
  const port = Number(new URL(base).port);
  const prep = async (pg = page) => {
    await pg.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
    await pg.evaluate(() => { const h = window.__rs; h.pause(); h.seed(2026); if (h.rules) h.rules.encounters = false; });
  };
  const go = async (q) => { await page.goto(base + q); await prep(); };
  // Node: the generator's own answer for a seed
  const GI = await import('../../src/gen/index.js'), SG = await import('../../src/gen/sign.js');
  const { kantoInputs } = await import('./kanto_inputs.mjs');
  const terrain = GI.prepTerrain(JSON.parse(readFileSync(path.join(ROOT, 'assets', 'world', 'terrain.json'))));
  const nodeSigns = (seed) => { const g = GI.makeGen({ type: 'kanto', seed }, { terrain, ...kantoInputs() }); return SG.kantoSigns(g, GI.makePlan(g)); };
  const textOf = (s) => `KANTO is this way!\nAbout ${s.steps} steps ${WORDS[s.dir]}.`;
  const msgText = () => R('h.msg() ? h.msg().pages.map((p) => p.join("\\n")).join("\\n") : null');
  const closeMsg = async () => { for (let i = 0; i < 8 && (await R('h.state()')) === 'msg'; i++) await press('a', 3); };
  const errs = () => R('(G.errors || []).slice(0, 5)');
  const tp = (x, y, dir) => run(async ([x, y, dir]) => { const h = window.__rs; await h.ensure(x, y, 1); h.teleport(x, y, dir); return [h.P.tx, h.P.ty, h.P.dir]; }, [x, y, dir]);
  const signAt = (s) => R(`W.tile(${s.x}, ${s.y}) - W.signBase`);
  const signLook = (s) => R(`({ t: W.tile(${s.x}, ${s.y}) - W.signBase, mining: P.mining, bar: G.actionBar ? G.actionBar.text : null, state: h.state() })`);

  // ---- 1 and 2: every seed
  if (PARTS.has('1') || PARTS.has('2')) {
    for (const ws of SEEDS) {
      await go(`?new&play&world=kanto&wseed=${encodeURIComponent(ws)}`);
      const seed = await R('h.gen.seed()');
      const node = nodeSigns(seed), ks = await R('h.kantoSign()');
      const sp = await R('h.gen.plan().spawn');
      log(`seed ${ws} (${seed}): spawn ${sp.px},${sp.py}; signs ${JSON.stringify(ks && ks.signs)}; target ${JSON.stringify(ks && ks.target)}`);
      check(ks && JSON.stringify({ target: ks.target, signs: ks.signs }) === JSON.stringify({ target: node.target, signs: node.signs }), `seed ${ws}: h.kantoSign() equals the Node result`);
      if (!ks) continue;
      for (const s of ks.signs) {
        const info = await run(async (q) => {
          const h = window.__rs, W = h.world;
          await h.ensure(q.x, q.y, 0);
          const i = q.y * W.W + q.x, ck = (q.y >> 5) * 63 + (q.x >> 5), k = (q.y & 31) * 32 + (q.x & 31);
          const r = h.gen.client.sync((q.x >> 5) - 13, q.y >> 5);
          let diff = 0;
          const cb = W.cbase[ck];
          for (let j = 0; j < 1024; j++) if (j !== k && (!cb || cb[j] !== r.tile[j])) diff++;
          return { ready: W.cstate[ck] === 2, t: W.grid[i] - W.signBase, base: cb ? cb[k] - W.signBase : null, col: W.col[i], beh: W.beh[i], diff, painted: r.tile[k], kanto: W.isKantoCell(q.x, q.y) };
        }, s);
        check(info.ready && info.t === s.dir && info.base === s.dir && info.col === 1 && info.beh === 0x84 && !info.kanto,
          `seed ${ws}: the ${s.kind} sign's cell holds signBase + ${s.dir} in the grid and cbase, collision 1, behaviour 0x84 (${JSON.stringify(info)})`);
        check(info.diff === 0, `seed ${ws}: every other cell of the ${s.kind} sign's chunk equals the painter's own (${info.diff} differ)`);
      }
      const sg = ks.signs.find((q) => q.kind === 'spawn');
      if (!sg || !PARTS.has('2')) continue;
      const P0 = await R('[P.tx, P.ty, P.dir]');
      if (sg.x === sp.px && sg.y === sp.py + 1) check(P0[0] === sp.px && P0[1] === sp.py && P0[2] === 'down', `seed ${ws}: Steve faces the sign as the world opens`);
      else await tp(sg.x, sg.y - 1, 'down');
      await press('a', 4);
      const m1 = await msgText();
      check(m1 === textOf(sg), `seed ${ws}: A reads it: ${JSON.stringify(m1)}`);
      if (ws === '1') { await idle(40); await shot('sign_message'); }
      await closeMsg();
      await press('b', 4);
      const m2 = await msgText();
      check(m2 === textOf(sg), `seed ${ws}: X reads it`);
      await closeMsg();
      check((await signAt(sg)) === sg.dir && (await R('h.state()')) === 'play', `seed ${ws}: the sign stands after reading; back in play`);
      check((await errs()).length === 0, `seed ${ws}: no G.errors ${JSON.stringify(await errs())}`);
    }
  }

  // ---- 3, 4 and 8 on seed 1
  await go('?new&play&world=kanto&wseed=1');
  const ks1 = await R('h.kantoSign()');
  const s1 = ks1.signs.find((q) => q.kind === 'spawn'), gate1 = ks1.signs.find((q) => q.kind === 'gate');
  if (PARTS.has('3')) {
    for (const mode of ['survival', 'creative']) {
      await run((m) => { const h = window.__rs; h.setMode(m, 'normal'); h.G.actionBar = null; }, mode);
      // a. the press that closes the message, then A held for 3 s
      await tp(s1.x, s1.y - 1, 'down');
      await press('a', 2); await press('a', 2);
      if ((await R('h.state()')) === 'msg') await tick({ hold: 'a', press: 'a' });
      for (let i = 0; i < 90; i++) await tick({ hold: 'a' });
      let L = await signLook(s1);
      check(L.t === s1.dir && !L.mining && !(L.bar || '').includes('sturdy') && L.state === 'play', `${mode}: closing the message with A and holding A for 3 s leaves the sign (${JSON.stringify(L)})`);
      // b. A held while turning to face it
      await tp(s1.x, s1.y - 1, 'left');
      for (let i = 0; i < 10; i++) await tick({ hold: 'a' });
      await tick({ hold: ['a', 'down'], press: 'down' });
      for (let i = 0; i < 60; i++) await tick({ hold: 'a' });
      L = await signLook(s1);
      const dir = await R('P.dir');
      check(L.t === s1.dir && !L.mining && !(L.bar || '').includes('sturdy'), `${mode}: A held while turning to face it leaves the sign (facing ${dir}; ${JSON.stringify(L)})`);
      await closeMsg();
      // c. A pressed during the last step toward it (the queued press)
      await tp(s1.x, s1.y - 2, 'down');
      await tick({ hold: 'down', press: 'down' });
      for (let i = 0; i < 6 && !(await R('P.moving')); i++) await tick({ hold: 'down' });   // (a turn's short hold may come first)
      const moving = await R('P.moving');
      await tick({ press: 'a' });
      for (let i = 0; i < 12; i++) await tick();
      L = await signLook(s1);
      const m = await msgText();
      check(moving && L.t === s1.dir && !L.mining && m === textOf(s1), `${mode}: an A pressed during the last step reads it and leaves it (moving ${moving}; ${JSON.stringify(L)}; ${JSON.stringify(m)})`);
      await closeMsg();
      // d. X with a block, a water bucket, food in hand
      for (const [id, n] of [['cobblestone', 5], ['water_bucket', 1], ['cooked_beef', 3]]) {
        await run(([id, n]) => { const h = window.__rs; h.G.inv.slots[h.G.inv.sel] = { id, n }; h.P.food = 10; h.P.using = null; }, [id, n]);
        await tp(s1.x, s1.y - 1, 'down');
        await press('b', 3);
        const mx = await msgText();
        for (let i = 0; i < 20; i++) await tick({ hold: 'b' });
        await closeMsg();
        for (let i = 0; i < 10; i++) await tick({ hold: 'b' });
        const after = await R(`({ held: G.inv.held, food: P.food, using: P.using, block: W.block(${s1.x}, ${s1.y}), t: W.tile(${s1.x}, ${s1.y}) - W.signBase, water: W.isWater(${s1.x}, ${s1.y}) })`);
        check(mx === textOf(s1) && after.held && after.held.id === id && after.held.n === n && !after.block && after.t === s1.dir && !after.water && !after.using && (mode === 'creative' || after.food === 10),
          `${mode}: X with ${id} in hand reads it and uses nothing (${JSON.stringify(after)})`);
      }
    }
    // the control: without the hook, that same queued press in Creative breaks the sign at once (so the test above
    // would catch a hook that let it through)
    await run(() => { const h = window.__rs; h.setMode('creative', 'normal'); h.G.inv.slots.fill(null); window.__signHook = h.G.signHook; h.G.signHook = null; });
    await tp(s1.x, s1.y - 2, 'down');
    await tick({ hold: 'down', press: 'down' });
    for (let i = 0; i < 6 && !(await R('P.moving')); i++) await tick({ hold: 'down' });
    await tick({ press: 'a' });
    for (let i = 0; i < 12; i++) await tick();
    const ctl = await signAt(s1);
    await run((s) => { const h = window.__rs, W = h.world; h.G.signHook = window.__signHook; W.setTile(s.x, s.y, W.signBase + s.dir); W.edits.delete(s.y * W.W + s.x); W.blocks.delete(s.y * W.W + s.x); }, s1);
    check(ctl !== s1.dir, `control: without the hook a queued A press in Creative breaks the sign (tile ${ctl})`);
    await run(() => { const h = window.__rs; h.setMode('survival', 'normal'); h.G.inv.slots.fill(null); });
  }
  if (PARTS.has('8')) {
    // each arrow at the spawn (set on the cell for the picture only), then the gate sign and its message
    await tp(s1.x, s1.y - 1, 'down');
    await closeMsg();
    for (let d = 0; d < 8; d++) {
      await run(([s, d]) => { const W = window.__rs.world; W.setTile(s.x, s.y, W.signBase + d); }, [s1, d]);
      await idle(2);
      await shot(`sign_arrow_${d}_${['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'][d]}`);
    }
    await run((s) => { const W = window.__rs.world; W.setTile(s.x, s.y, W.signBase + s.dir); W.edits.delete(s.y * W.W + s.x); }, s1);
    if (gate1) {
      const spot = await run(async (q) => {
        const h = window.__rs, W = h.world;
        await h.ensure(q.x, q.y, 1);
        for (const [dx, dy, dir] of [[0, 1, 'up'], [0, -1, 'down'], [-1, 0, 'right'], [1, 0, 'left']]) {
          const x = q.x + dx, y = q.y + dy;
          if (!W.baseBlocked(x, y) && !W.block(x, y)) return [x, y, dir];
        }
        return null;
      }, gate1);
      check(!!spot, 'a cell beside the gate sign to read it from');
      if (spot) {
        await tp(spot[0], spot[1], spot[2]);
        await idle(4);
        await shot('sign_gate');
        if (process.env.SIGN_SHOTS) { mkdirSync(process.env.SIGN_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.SIGN_SHOTS, 'desktop_960x720_gate.png') }); }
        await press('a', 4);
        const gm = await msgText(), want = await R(`(() => { const o = W.meta.openings.find((q) => q.id === ${gate1.id}); const m = o && W.maps.find((q) => q.id === o.map); return m ? 'KANTO starts here.\\nThis way to ' + m.name + '.' : 'KANTO starts here.\\nWelcome to KANTO!'; })()`);
        check(gm === want, `the gate sign reads ${JSON.stringify(gm)}`);
        await idle(40);
        await shot('sign_gate_message');
        if (process.env.SIGN_SHOTS) await page.screenshot({ path: path.join(process.env.SIGN_SHOTS, 'desktop_960x720_gate_message.png') });
        await closeMsg();
      }
    }
    const SH = process.env.SIGN_SHOTS;
    if (SH) {
      mkdirSync(SH, { recursive: true });
      await tp(s1.x, s1.y - 1, 'down');
      await idle(4);
      await page.screenshot({ path: path.join(SH, 'desktop_960x720_spawn.png') });
      await press('a', 4); await idle(40);
      await page.screenshot({ path: path.join(SH, 'desktop_960x720_message.png') });
      await closeMsg();
      // a phone in landscape: a touch context of its own (the pad shows), the same world
      const ctx2 = await page.context().browser().newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const ph = await ctx2.newPage();
      await ph.goto(base + '?new&play&world=kanto&wseed=1');
      await prep(ph);
      await ph.evaluate(() => { const h = window.__rs; for (let i = 0; i < 4; i++) h.tick({}); });
      await ph.screenshot({ path: path.join(SH, 'phone_844x390_spawn.png') });
      await ph.evaluate(() => { const h = window.__rs; h.tick({ press: 'a' }); for (let i = 0; i < 40; i++) h.tick({}); });
      await ph.screenshot({ path: path.join(SH, 'phone_844x390_message.png') });
      // (review) the widest gate line, "This way to PEWTER CITY." (wseed=seed), read on the phone: clear of INV
      await ph.goto(base + '?new&play&world=kanto&wseed=seed');
      await prep(ph);
      const pg = await ph.evaluate(async () => {
        const h = window.__rs, ks = h.kantoSign(), g = ks && ks.signs.find((s) => s.kind === 'gate');
        if (!g) return null;
        await h.ensure(g.x, g.y + 1, 1); h.teleport(g.x, g.y + 1, 'up');
        for (let i = 0; i < 4; i++) h.tick({});
        h.tick({ press: 'a' }); for (let i = 0; i < 40; i++) h.tick({});
        const m = h.msg(), inv = [...document.querySelectorAll('button, div')].find((e) => /^\s*INV\s*$/.test(e.textContent || '') && e.getBoundingClientRect().width > 0);
        return { g, text: m ? m.pages.map((p) => p.join('\n')).join('\n') : null, inv: inv ? Math.round(inv.getBoundingClientRect().left) : null };
      });
      log(`phone gate message: ${JSON.stringify(pg)}`);
      await ph.screenshot({ path: path.join(SH, 'phone_844x390_gate_message.png') });
      await ph.close(); await ctx2.close();
      log('shots in', SH);
    }
  }
  if (PARTS.has('4')) {
    // a blast beside it (Steve well away), then save and reload by the world's id
    await tp(s1.x, s1.y - 12, 'down');
    let broken = false;
    for (let k = 0; k < 4 && !broken; k++) {
      await run((s) => window.__rs.G.explode(s.x + 1, s.y, 4, { kind: 'tnt' }), s1);
      broken = (await signAt(s1)) !== s1.dir;
    }
    const ed = await R(`({ edit: W.edits.has(${s1.y} * W.W + ${s1.x}), t: W.tile(${s1.x}, ${s1.y}), col: W.col[${s1.y} * W.W + ${s1.x}] })`);
    check(broken && ed.edit && ed.col === 0, `a TNT blast beside it breaks it, as an edit (${JSON.stringify(ed)})`);
    const sv = await run(async () => { const h = window.__rs; const ok = await h.save(); return { ok, wid: h.wid() }; });
    check(sv.ok, 'saved');
    await go('?play');
    const back = await run(async (s) => { const h = window.__rs, W = h.world; await h.ensure(s.x, s.y, 0); return { wid: h.wid(), t: W.tile(s.x, s.y), signBase: W.signBase, sign: !!h.kantoSign() }; }, s1);
    check(back.wid === sv.wid && back.sign && back.t === ed.t, `reloaded by its id, the sign stays broken (${JSON.stringify(back)})`);
    check((await errs()).length === 0, 'no G.errors after the reload');
    await go('?new&play&world=kanto&wseed=1');
    check((await signAt(s1)) === s1.dir, 'a new world from the same seed has the sign again');
  }
  if (PARTS.has('5')) {
    // a Kanto World saved by the release, loaded here
    const rport = Number(process.env.SIGN_RELEASE_PORT || port + 1);
    const srv = spawn('python3', ['-m', 'http.server', String(rport), '--bind', '127.0.0.1', '--directory', RELEASE], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 800));
      const ctxOld = await page.context().browser().newContext({ viewport: { width: 960, height: 720 } });
      const old = await ctxOld.newPage();
      await old.goto(`http://127.0.0.1:${rport}/?new&play&world=kanto&wseed=2`);
      await prep(old);
      const rel = await old.evaluate(async () => {
        const h = window.__rs;
        for (let i = 0; i < 30; i++) h.tick({ hold: i < 20 ? 'up' : undefined });
        const ok = await h.save(), id = h.wid(), d = await h.worlds().loadWorld(id), e = h.worlds().entryOf(id);
        return { ok, id, json: JSON.stringify(d), entry: e, hasSign: 'kantoSign' in h };
      });
      await old.close(); await ctxOld.close();
      check(rel.ok && !rel.hasSign && rel.json.length > 100, `the release saved a Kanto World (${rel.id}, ${rel.json.length} bytes, no sign hook there)`);
      await run(async (r) => { const h = window.__rs, WL = h.worlds(); await WL.saveWorld(r.id, JSON.parse(r.json)); WL.touchEntry(r.id, r.entry); }, rel);
      await go('?play');
      const ld = await run(async () => {
        const h = window.__rs, W = h.world, ks = h.kantoSign(), s = ks && ks.signs.find((q) => q.kind === 'spawn');
        if (s) await h.ensure(s.x, s.y, 0);
        return { wid: h.wid(), type: h.wd() && h.wd().type, ks: !!ks, t: s ? W.tile(s.x, s.y) - W.signBase : null, dir: s ? s.dir : null, errors: (h.G.errors || []).slice(0, 5) };
      });
      check(ld.wid === rel.id && ld.type === 'kanto' && ld.ks && ld.t === ld.dir && !ld.errors.length, `the release's Kanto World loads here with no error and shows the sign (${JSON.stringify(ld)})`);
    } finally { srv.kill(); }
  }
  if (PARTS.has('6')) {
    await go('?new&play&world=wild&wseed=1');
    const w = await R('({ base: W.signBase, extra: W.entries.length - W.genBase - A.terrain.entries.length, hook: typeof G.signHook, ks: h.kantoSign() })');
    check(w.base === 0 && w.extra === 0 && w.hook === 'undefined' && w.ks === null, `a Wild World has no sign entries and no sign hook (${JSON.stringify(w)})`);
    await go('?new&play&video&world=kanto&wseed=1');
    const v = await R(`({ ks: h.kantoSign(), hook: typeof G.signHook, t: W.tile(${s1.x}, ${s1.y}) - W.signBase })`);
    check(v.ks === null && v.hook === 'undefined' && !(v.t >= 0 && v.t < 8), `no sign under ?video (${JSON.stringify(v)})`);
  }
  if (PARTS.has('7')) {
    // kanto_sign.png missing: the boot goes on and the cell draws FireRed's own sign (atlas entry 3)
    await page.route('**/assets/world/kanto_sign.png', (route) => route.fulfill({ status: 404, body: '' }));
    await go('?new&play&world=kanto&wseed=1');
    await idle(4);
    const f = await R(`({ img: !!A.img.kantoSign, t: W.tile(${s1.x}, ${s1.y}) - W.signBase, errors: (G.errors || []).length })`);
    await shot('sign_fallback');
    // the sign's pixels on the canvas: FireRed's board colour (#dec5a4) appears in its cell (the camera is centred on
    // Steve, the sign one cell below him)
    const px = await run(() => { const c = document.getElementById('game'), g = c.getContext('2d'); const d = g.getImageData(c.width / 2 - 16, c.height / 2 + 16, 32, 48).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] === 0xde && d[i + 1] === 0xc5 && d[i + 2] === 0xa4) n++; return n; });
    check(!f.img && f.t === s1.dir && f.errors === 0 && px > 20, `without kanto_sign.png the world boots and the cell shows FireRed's own sign (${JSON.stringify(f)}, ${px} board pixels)`);
    await page.unroute('**/assets/world/kanto_sign.png');
  }
  void OUT;
}
