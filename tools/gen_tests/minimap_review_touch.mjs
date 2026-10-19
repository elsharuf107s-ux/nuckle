// Review repro (visual and phone review of the minimap, 2026-10-10): on a phone, a tap on the minimap while another
// finger holds the d-pad (Steve walking) should open the full map, as a lone tap does. Fails while input.js only
// turns canvas `mousedown` into `mouseL`: a second finger is a non-primary pointer, which gets pointerdown and
// touchstart but no compatibility mousedown, so the tap never reaches MiniMap.tapped().
//   node tools/headless.mjs tools/gen_tests/minimap_review_touch.mjs --params '?new&play&world=wild&wseed=3' --port <port> --out <scratch>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default async function (t) {
  const { page, check, log } = t;
  const base = page.url().replace(/\?.*$/, '');
  const browser = page.context().browser();
  for (const [w, h] of [[844, 390], [667, 375]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const pg = await ctx.newPage();
    await pg.goto(base + '?new&play&world=wild&wseed=3');
    await pg.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
    await pg.evaluate(() => { const h = window.__rs; h.rules.encounters = false; h.rules.mobs = false; });
    for (let i = 0; i < 100; i++) { if (await pg.evaluate(() => window.__rs.minimap && window.__rs.minimap().loaded)) break; await sleep(100); }
    await sleep(800);
    const cdp = await ctx.newCDPSession(pg);
    const geo = await pg.evaluate(() => {
      const c = document.getElementById('game').getBoundingClientRect();
      const b = document.querySelector('#pad button[data-k="left"]').getBoundingClientRect();
      return { mx: c.left + (44 / 480) * c.width, my: c.top + (44 / 320) * c.height, dx: b.left + b.width / 2, dy: b.top + b.height / 2 };
    });
    const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    const D = { x: geo.dx, y: geo.dy, id: 1 }, M = { x: geo.mx, y: geo.my, id: 2 };
    // a lone tap (the game running for real)
    await T('touchStart', [M]); await sleep(60); await T('touchEnd', []); await sleep(700);
    const lone = await pg.evaluate(() => window.__rs.minimap().screen);
    if (lone === 'map') { await pg.evaluate(() => window.__rs.input.press('b')); await sleep(200); await pg.evaluate(() => window.__rs.input.release('b')); await sleep(300); }
    // one finger holds the d-pad's left, a second taps the minimap and lifts, the first keeps holding
    const x0 = await pg.evaluate(() => window.__rs.P.tx);
    await T('touchStart', [D]); await sleep(500);
    await T('touchStart', [D, M]); await sleep(60);
    await T('touchMove', [D]); await sleep(900);
    const st = await pg.evaluate(() => ({ screen: window.__rs.minimap().screen, x: window.__rs.P.tx }));
    await T('touchEnd', []); await sleep(300);
    check(lone === 'map', `${w} x ${h}: a lone tap on the minimap opens the full map`);
    check(st.screen === 'map', `${w} x ${h}: a tap on the minimap while another finger holds the d-pad opens the full map (screen ${st.screen}; Steve walked ${x0} -> ${st.x})`);
    log(w, h, JSON.stringify({ lone, st }));
    await ctx.close();
  }
}
