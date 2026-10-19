#!/usr/bin/env node
// The trade screen (src/tradeui.js) in headless Chrome, through its standalone page villagers_trade.html, at desktop
// (960x720) and phone (390x844, touch) sizes. Real mouse clicks, wheel, keys and touch taps; screenshots of each step.
//   node tools/gen_tests/villagers_trade.mjs [--port 5500] [--out dir]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('--port', 5500));
const OUT = path.resolve(opt('--out', path.join(ROOT, 'out', 'villagers_trade')));
mkdirSync(OUT, { recursive: true });
const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
const { chromium } = createRequire(import.meta.url)(pwDir);

const fails = [];
let checks = 0;
const check = (c, msg) => { checks++; if (!c) { fails.push(msg); console.error('FAIL', msg); } else console.log('ok  ', msg); };
const server = spawn('python3', [path.join(ROOT, 'serve.py'), String(PORT)], { stdio: 'ignore' });
let browser;
try {
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const prof of [{ name: 'desktop', viewport: { width: 960, height: 720 } }, { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]) {
    const ctx = await browser.newContext({ viewport: prof.viewport, isMobile: !!prof.isMobile, hasTouch: !!prof.hasTouch, deviceScaleFactor: prof.deviceScaleFactor || 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const tag = prof.name;
    const shot = async (n) => { const p = path.join(OUT, `${tag}_${n}.png`); await page.screenshot({ path: p }); return p; };
    const R = (fn, a) => page.evaluate(fn, a);
    const frames = (n = 2) => R((k) => { for (let i = 0; i < k; i++) window.__trade.frame(); }, n);
    // a real click or tap at a point of the 480x320 layer
    const at = async (x, y, { right = false } = {}) => {
      const p = await R(([a, b]) => window.__trade.toPage(a, b), [x, y]);
      if (prof.hasTouch && !right) await page.touchscreen.tap(p.x, p.y);
      else { await page.mouse.move(p.x, p.y); await frames(1); await page.mouse.down({ button: right ? 'right' : 'left' }); await frames(1); await page.mouse.up({ button: right ? 'right' : 'left' }); }
      await frames(2);
    };
    const key = async (k) => { await page.keyboard.press(k); await frames(2); };
    const S = () => R(() => { const s = window.__trade.screen, G = window.__trade.G; return s && { pick: s.pick, pay: s.pay, cursor: s.cursor, offers: s.offers.length, title: s.title(), v: { lvl: s.v.lvl, xp: s.v.xp, uses: s.v.uses, demand: s.v.demand }, res: s.result(), focus: s.focus, offerCur: s.offerCur, scroll: s.scroll, inv: { wheat: G.inv.count('wheat'), emerald: G.inv.count('emerald'), bread: G.inv.count('bread'), cod: G.inv.count('cod'), cooked_cod: G.inv.count('cooked_cod') }, xp: G.xp }; });
    const X0 = 102, Y0 = 77;   // the panel's corner on the 480x320 layer
    const offerXY = (row) => [X0 + 5 + 44, Y0 + 18 + row * 20 + 10];
    const RES = [X0 + 220 + 8, Y0 + 37 + 8];

    await page.goto(`http://127.0.0.1:${PORT}/tools/gen_tests/villagers_trade.html?prof=farmer&lvl=1&vid=7&manual`);
    await page.waitForFunction(() => window.__trade && window.__trade.ready, null, { timeout: 30000 });
    await frames(2);
    let s = await S();
    check(s.title === 'Farmer - Novice' && s.offers === 2, `${tag}: farmer opens with "Farmer - Novice" and 2 offers (${s.title}, ${s.offers})`);
    console.log('     shot', await shot('01_open'));

    // select the wheat offer: 40 wheat move into the first payment slot, an emerald shows in the result
    const wheatRow = await R(() => window.__trade.screen.offers.findIndex((o) => o.costA === 'wheat'));
    const wheatKey = await R((i) => window.__trade.screen.offers[i].key, wheatRow);
    await at(...offerXY(wheatRow));
    s = await S();
    check(s.pick === wheatRow && s.pay[0] && s.pay[0].id === 'wheat' && s.pay[0].n === 40 && s.inv.wheat === 0 && s.res && s.res.id === 'emerald',
      `${tag}: selecting the wheat offer fills the payment (${JSON.stringify(s.pay)}) and shows ${JSON.stringify(s.res)}`);
    console.log('     shot', await shot('02_selected'));
    // take the result once
    const em0 = s.inv.emerald;
    await at(...RES);
    s = await S();
    const usesW = s.v.uses[wheatKey];
    check(usesW === 1 && s.pay[0].n === 20 && s.v.xp === 2 && s.xp >= 3 && (prof.hasTouch ? true : s.cursor && s.cursor.id === 'emerald'),
      `${tag}: taking the result trades once (uses ${usesW}, payment ${s.pay[0] && s.pay[0].n}, villager xp ${s.v.xp}, player xp ${s.xp}, cursor ${JSON.stringify(s.cursor)})`);
    if (!prof.hasTouch) {
      // put the emerald down in an empty inventory slot, then shift-click the result for the rest
      await at(X0 + 108 + 8 * 18 + 8, Y0 + 84 + 2 * 18 + 8);
      await page.keyboard.down('Shift'); await frames(1);
      await at(...RES);
      await page.keyboard.up('Shift'); await frames(1);
      s = await S();
      check(s.v.uses[wheatKey] === 2 && !s.pay[0] && s.inv.emerald === em0 + 2, `${tag}: shift-click trades the remaining payment (uses ${s.v.uses[wheatKey]}, emeralds ${em0} -> ${s.inv.emerald})`);
      const traded = await R(() => window.__trade.G.traded);
      check(traded.length === 2 && traded.every((t) => t.key === wheatKey), `${tag}: onTrade reports the offer's stable key (${JSON.stringify(traded)})`);
      // hover an offer's result for its tooltip
      const p = await R(([a, b]) => window.__trade.toPage(a, b), [X0 + 73 + 8, Y0 + 19 + (1 - wheatRow) * 20 + 8]);
      await page.mouse.move(p.x, p.y); await frames(2);
      console.log('     shot', await shot('03_traded_tooltip'));
    } else {
      // phone: the pad. Arrows move the cursor to the offer list, A selects, then to the result, A takes it.
      await R(() => { const t = window.__trade; t.screen.useMouse = false; t.screen.focus = 'offer'; t.screen.offerCur = 0; });
      await page.locator('#pad button[data-k="down"]').tap(); await frames(2);
      await page.locator('#pad button[data-k="up"]').tap(); await frames(2);
      s = await S();
      check(s.focus === 'offer' && s.offerCur === 0, `${tag}: the pad's arrows move the offer cursor (${s.focus} ${s.offerCur})`);
      console.log('     shot', await shot('03_pad_cursor'));
    }

    // a level-up: 8 xp, one more wheat trade reaches Apprentice: 4 offers, title changes
    await R(() => { const t = window.__trade; const v = { vid: 7, prof: 'farmer', vtype: 'plains', lvl: 1, xp: 8 }; t.open(v, [['wheat', 64], ['emerald', 10]]); t.frame(); });
    await at(...offerXY(wheatRow));
    await at(...RES);
    s = await S();
    check(s.v.lvl === 2 && s.offers === 4 && s.title === 'Farmer - Apprentice', `${tag}: a trade past 10 xp levels the farmer up (lvl ${s.v.lvl}, ${s.offers} offers, "${s.title}")`);
    console.log('     shot', await shot('04_level_up'));

    // demand: a raised price is drawn struck through; out of stock: the red arrow and the cross, no result
    await R(() => { const t = window.__trade; t.open({ vid: 7, prof: 'farmer', vtype: 'plains', lvl: 3, xp: 80, uses: { '1:buy_wheat': 16 }, demand: { '1:sell_bread': 10 } }, [['wheat', 64], ['emerald', 20], ['pumpkin', 20]]); t.frame(); });
    await at(...offerXY(0));
    s = await S();
    check(s.pick === 0 && !s.res, `${tag}: an offer used up shows no result (${JSON.stringify(s.res)})`);
    const breadCost = await R(() => { const t = window.__trade, sc = t.screen, i = sc.offers.findIndex((o) => o.result === 'bread'); return i; });
    check(breadCost === 1, `${tag}: the bread offer is second (${breadCost})`);
    const breadShown = await R(() => { const sc = window.__trade.screen, o = sc.offers[1]; return { key: o.key, n: o.nA, demand: sc.v.demand[o.key] }; });
    check(breadShown.key === '1:sell_bread' && breadShown.demand === 10, `${tag}: demand is keyed by the offer (${JSON.stringify(breadShown)})`);
    console.log('     shot', await shot('05_demand_out_of_stock'));

    // the fisherman's two-cost offer: emerald + 6 cod -> 6 cooked cod, both payment slots filled
    await R(() => { const t = window.__trade; t.open({ vid: 2, prof: 'fisherman', vtype: 'taiga', lvl: 2, xp: 20 }, [['emerald', 5], ['cod', 20], ['string', 30]]); t.frame(); });
    const codRow = await R(() => window.__trade.screen.offers.findIndex((o) => o.costB === 'cod'));
    await at(...offerXY(codRow));
    s = await S();
    check(s.pay[0] && s.pay[0].id === 'emerald' && s.pay[1] && s.pay[1].id === 'cod' && s.res && s.res.id === 'cooked_cod', `${tag}: two-cost offer fills both payment slots (${JSON.stringify(s.pay)}) -> ${JSON.stringify(s.res)}`);
    await at(...RES);
    s = await S();
    console.log('     shot', await shot('06_two_costs'));

    // a Master with 9 offers: the scroller is live, the wheel (desktop) or the pad (phone) scrolls the list
    await R(() => { const t = window.__trade; t.open({ vid: 9, prof: 'farmer', vtype: 'plains', lvl: 5, xp: 260 }, [['emerald', 30], ['melon', 8]]); t.frame(); });
    s = await S();
    check(s.offers === 9 && s.title === 'Farmer - Master', `${tag}: a Master farmer has 9 offers (${s.offers})`);
    // the game's default (strict): offers naming an item items.json lacks (melon, sugar until stage 5a) are hidden
    const strict = await R(() => { const t = window.__trade; const sc = t.open({ vid: 9, prof: 'farmer', vtype: 'plains', lvl: 5, xp: 260 }, [['emerald', 30]], { strict: true }); t.frame();
      const ids = sc.offers.flatMap((o) => [o.costA, o.costB, o.result]).filter(Boolean);
      const r = { n: sc.offers.length, unknown: ids.filter((id) => !t.A.items.items[id]), all: t.offersFor(sc.v, t.TA.data).length };
      t.open({ vid: 9, prof: 'farmer', vtype: 'plains', lvl: 5, xp: 260 }, [['emerald', 30], ['melon', 8]]); t.frame(); return r; });
    check(strict.unknown.length === 0 && strict.n <= strict.all,   // (since 5a every farmer offer's item exists: all shown)
      `${tag}: in-game offers name only items.json items (${strict.n} of ${strict.all} shown, unknown ${JSON.stringify(strict.unknown)})`);
    if (!prof.hasTouch) {
      const p = await R(([a, b]) => window.__trade.toPage(a, b), [X0 + 40, Y0 + 60]);
      await page.mouse.move(p.x, p.y); for (let k = 0; k < 3; k++) { await page.mouse.wheel(0, 100); await frames(1); }   // one notch per event, as Minecraft
    } else {
      await R(() => { const t = window.__trade; t.screen.useMouse = false; t.screen.focus = 'offer'; t.screen.offerCur = 0; });
      for (let k = 0; k < 8; k++) { await page.locator('#pad button[data-k="down"]').tap(); await frames(1); }
    }
    s = await S();
    check(s.scroll === 2, `${tag}: the list scrolls to its end (scroll ${s.scroll})`);
    console.log('     shot', await shot('07_master_scrolled'));
    // keyboard on desktop: A (Z) on the focused offer selects it
    if (!prof.hasTouch) {
      await R(() => { const t = window.__trade; t.screen.useMouse = false; t.screen.focus = 'offer'; t.screen.offerCur = 8; t.screen.showOffer(8); });
      await key('z');
      s = await S();
      check(s.pick === 8 && s.pay[0] && s.pay[0].id === 'emerald', `${tag}: Z on the focused offer selects it (pick ${s.pick})`);
      await key('ArrowRight');
      s = await S();
      check(s.focus === 'slot', `${tag}: right from the list goes to the slots (${s.focus})`);
      console.log('     shot', await shot('08_keyboard'));
    }
    // a nitwit: "Nitwit", no offers, "Hrmm"
    await R(() => { const t = window.__trade; t.open({ vid: 4, prof: 'nitwit', vtype: 'swamp' }, [['emerald', 3]]); t.frame(); });
    s = await S();
    check(s.offers === 0 && s.title === 'Nitwit', `${tag}: a nitwit has no trades ("${s.title}")`);
    console.log('     shot', await shot('09_nitwit'));
    // close returns the payment: select, then E (desktop) or the pad's INV (phone)
    await R(() => { const t = window.__trade; t.open({ vid: 7, prof: 'farmer', vtype: 'plains', lvl: 1 }, [['wheat', 40]]); t.frame(); });
    await at(...offerXY(wheatRow));
    if (prof.hasTouch) await page.locator('#pad button[data-k="inv"]').tap(); else await page.keyboard.press('e');
    await frames(3);
    const closed = await R(() => ({ open: !!window.__trade.screen, wheat: window.__trade.G.inv.count('wheat') }));
    check(!closed.open && closed.wheat === 40, `${tag}: closing returns the payment to the inventory (${JSON.stringify(closed)})`);
    check(errors.length === 0, `${tag}: no page errors (${errors.join(' | ')})`);
    const harnessErr = await R(() => window.__trade.errors);
    check(harnessErr.length === 0, `${tag}: the update loop never threw (${harnessErr.join(' | ')})`);
    await ctx.close();
  }
} catch (e) {
  fails.push(String(e && e.stack || e));
  console.error(e);
} finally {
  if (browser) await browser.close();
  server.kill();
}
console.log(`villagers_trade: ${checks} checks, ${fails.length} failed; screenshots in ${OUT}`);
process.exit(fails.length ? 1 : 0);
