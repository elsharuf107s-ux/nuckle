// Stage 7c: trades in the game (design 13, 7c; 5.6, 5.7, 5.10, section 20; 11.6's trade part).
//
//   node tools/headless.mjs tools/gen_tests/trades_game.mjs --params '?new&play&world=wild&wseed=1' --port 5450 --out <dir>
//
//   0. tools/trade_check.py passes (rules, pump, loop, launder; its negative controls fail); no offer anywhere sells an
//      eye of ender or a blaze item, and pearls only from the Master cleric (13 professions x 2,048 villagers, Node);
//   1. Z facing a villager with a profession opens the merchant screen and never hurts it; it stands still while the
//      screen is open; E closes it;
//   2. a trade by real clicks (the offer button, then the result slot) moves the items and books the use;
//   3. a trade with each profession's first offer (13 professions, through the game's own screen);
//   4. a villager levels up after enough trades (celebrate, green sparkles, the next level's offers appear);
//   5. sold out, the offer is greyed; its restock comes once a day at the job site in the work period (not twice);
//      the sold-out day raises that offer's price (demand), and a quiet day brings it back down;
//   6. a generated world's Mart pays the capped prices (golden apple 96, emerald 32) and the rest as before;
//   7. save and reload keep a villager's level, xp, uses and demand; no G.errors.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { offersFor } from '../../src/trades.js';

const ROOT = new URL('../../', import.meta.url);
const TRADES = JSON.parse(readFileSync(new URL('assets/mc/villagers/trades.json', ROOT), 'utf8'));

export default async function (t) {
  const { page, run, check, log, shot } = t;
  const frames = (n, dt = 1 / 30) => run(({ n, dt }) => { const h = window.__rs; for (let i = 0; i < n; i++) h.tick({ dt, capture: false }); return h.G.time; }, { n, dt });
  const prep = () => run(() => { const h = window.__rs; h.pause(); h.seed(5); h.rules.encounters = false; h.G.rules.mobs = false; h.G.rules.wild = false; h.P.health = 20; });

  // ---------------------------------------------------------------- 0. trade_check and the Nether rule (Node)
  {
    const r = spawnSync('python3', ['tools/trade_check.py', '--selftest'], { cwd: new URL('.', ROOT).pathname, encoding: 'utf8' });
    const head = (r.stdout || '').split('\n')[0];
    const controls = ((r.stdout || '').match(/failed as it should/g) || []).length;
    check(r.status === 0 && /OK/.test(head), `trade_check.py --selftest passes: ${head}; ${controls} negative controls fail as they should`);
    const bad = [];
    for (const prof of Object.keys(TRADES.trades)) for (let vid = 0; vid < 2048; vid++) {
      for (const o of offersFor({ vid, prof, lvl: 5 }, TRADES)) {
        if (['eye_of_ender', 'blaze_rod', 'blaze_powder'].includes(o.result)) bad.push(`${prof} ${vid} sells ${o.result}`);
        if (o.result === 'ender_pearl' && !(prof === 'cleric' && o.lvl === 5)) bad.push(`${prof} ${vid} L${o.lvl} sells a pearl`);
      }
    }
    check(!bad.length, `no offer of 13 professions x 2,048 villagers sells an eye of ender or a blaze item, and pearls only from the Master cleric ${bad.slice(0, 3)}`);
  }

  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
  await prep();
  await run(() => window.__rs.setTime(6000));
  check(await run(() => !!(window.__rs.G.tradeUI && window.__rs.G.tradeData && window.__rs.G.martGen)), 'a generated world loads the trade tables, the merchant GUI and its Mart prices');

  // the village nearest the spawn with a working villager
  const v = await run(async () => {
    const h = window.__rs, W = h.world, plan = h.gen.plan(), sp = plan.spawn, L = W.layout;
    let best = null, bd = 1e9;
    for (const v of plan.villages) { const d = Math.abs(v.x - sp.x) + Math.abs(v.y - sp.y); if (v.houses.length >= 6 && d < bd) { bd = d; best = v; } }
    if (!best) return null;
    for (let y = best.y0; y < best.y0 + best.h + 31; y += 16) for (let x = best.x0; x < best.x0 + best.w + 31; x += 16) await W.ensureAround(L.ox + Math.min(x, best.x0 + best.w - 1), L.oy + Math.min(y, best.y0 + best.h - 1), 1);
    const px = L.ox + best.plaza[0] + 4, py = L.oy + best.plaza[1] + 6;
    h.teleport(px, py, 'down');
    return { id: best.id, style: best.style, px, py };
  });
  check(!!v, 'a village exists near the spawn');
  if (!v) return;
  await frames(45);
  // a working villager standing on an open cell with a free cell south of it (Steve stands there, facing up)
  const pickVillager = (prof) => run(({ v, prof }) => {
    const h = window.__rs, G = h.G, rec = G.vil.recOf(v.id), W = h.world;
    const ok = (m) => m.prof !== 'none' && m.prof !== 'nitwit' && (!prof || m.prof === prof) && G.ents.includes(m) && !m.sleep;
    const m = rec.list.find((m) => ok(m) && W.isOutdoor(m.tx, m.ty)) || rec.list.find(ok);
    return m ? { vid: m.vid, prof: m.prof, tx: m.tx, ty: m.ty } : null;
  }, { v, prof });
  const vil = await pickVillager(null);
  check(!!vil, `a villager with a profession (${vil && vil.prof})`);
  if (!vil) return;

  // ---------------------------------------------------------------- 1. Z opens the trade screen, never hurts
  const face = (vid) => run(({ vid }) => {
    const h = window.__rs, G = h.G, w = h.world, m = G.ents.find((e) => e.vid === vid);
    m.hold = 10; m.path = null;
    const ok = (x, y) => w.inside(x, y) && w.ready(x, y) && !w.solid(x, y) && !w.isWater(x, y) && !w.jumpDir(x, y) && !w.warpAt(x, y) && !G.ents.some((e) => e !== m && e.type === 'mob' && e.tx === x && e.ty === y);
    for (const [dx, dy, dir] of [[0, 1, 'up'], [0, -1, 'down'], [1, 0, 'left'], [-1, 0, 'right']]) {
      const x = m.tx + dx, y = m.ty + dy;
      if (ok(x, y)) { h.teleport(x, y, dir); h.P.dir = dir; return { x, y, dir }; }
    }
    return null;
  }, { vid });
  await face(vil.vid);
  const hp0 = await run(({ vid }) => window.__rs.G.ents.find((e) => e.vid === vid).hp, { vid: vil.vid });
  await run(() => window.__rs.tick({ press: 'a', capture: false }));
  const o1 = await run(({ vid }) => {
    const h = window.__rs, s = h.screen(), m = h.G.ents.find((e) => e.vid === vid);
    return { state: h.state(), kind: s && s.kind, same: !!s && s.v === m, hp: m.hp, title: s && s.title(), offers: s ? s.offers.length : 0, at: [m.tx, m.ty] };
  }, { vid: vil.vid });
  check(o1.state === 'screen' && o1.kind === 'trade' && o1.same, `Z facing the ${vil.prof} opens its trade screen ("${o1.title}", ${o1.offers} offers)`);
  check(o1.hp === hp0, `and never hurts it (hp ${hp0} -> ${o1.hp})`);
  await frames(90);
  const o1b = await run(({ vid }) => { const m = window.__rs.G.ents.find((e) => e.vid === vid); return [m.tx, m.ty]; }, { vid: vil.vid });
  check(o1b[0] === o1.at[0] && o1b[1] === o1.at[1], `it stands still while the screen is open (3 s: ${o1.at} -> ${o1b})`);
  await shot('t1_screen');

  // ---------------------------------------------------------------- 2. a trade by real clicks
  const r2 = await run(async ({ vid }) => {
    const h = window.__rs, G = h.G, s = h.screen(), m = G.ents.find((e) => e.vid === vid);
    const o = s.offers[0];
    G.inv.add(o.costA, 64); if (o.costB) G.inv.add(o.costB, 64);
    const cnt = (id) => G.inv.count(id);
    const a0 = cnt(o.costA), r0 = cnt(o.result);
    const x0 = s.x0, y0 = s.y0;
    h.tick({ capture: false, mouse: { x: x0 + 40, y: y0 + 28, click: 'mouseL' } });      // the first offer's button
    const paySel = s.pay[0] ? s.pay[0].n : 0;
    h.tick({ capture: false, mouse: { x: x0 + 228, y: y0 + 45, click: 'mouseL' } });     // the result slot
    const onCursor = s.cursor ? { ...s.cursor } : null;
    h.tick({ capture: false, mouse: { x: x0 + 228, y: y0 + 45 } });
    const frame = h.frame();
    h.tick({ capture: false, press: 'inv' });                                             // E closes (payment and cursor back)
    return { o: { a: o.costA, nA: o.nA, r: o.result, nR: o.nR, key: o.key }, paySel, onCursor, uses: (m.uses || {})[o.key] || 0, state: h.state(), dA: a0 - cnt(o.costA), dR: cnt(o.result) - r0 + (o.result === o.costA ? 0 : 0), frame: frame.length };
  }, { vid: vil.vid });
  log('click trade', JSON.stringify(r2));
  check(r2.paySel >= r2.o.nA && r2.onCursor && r2.onCursor.id === r2.o.r && r2.onCursor.n === r2.o.nR, `clicking the first offer fills the payment (${r2.paySel} ${r2.o.a}); clicking the result takes ${r2.o.nR} ${r2.o.r}`);
  check(r2.uses === 1 && r2.state === 'play' && r2.dA === r2.o.nA && r2.dR === r2.o.nR, `one trade booked (uses ${r2.uses}); E closes and the inventory is ${r2.o.nA} ${r2.o.a} down, ${r2.o.nR} ${r2.o.r} up`);

  // ---------------------------------------------------------------- 3. every profession's first offer
  const r3 = await run(() => {
    const h = window.__rs, G = h.G, out = [];
    for (const prof of Object.keys(G.tradeData.trades)) {
      const v = { vid: 9000 + out.length, prof, lvl: 1, xp: 0, uses: {}, demand: {} };
      if (!G.showTrade(v, {})) { out.push([prof, 'no screen']); continue; }
      const s = h.screen(), o = s.offers[0];
      if (!o) { out.push([prof, 'no offer']); s.done = true; h.tick({ capture: false }); continue; }
      G.inv.slots.fill(null);
      G.inv.add(o.costA, 64); if (o.costB) G.inv.add(o.costB, 64);
      const a0 = G.inv.count(o.costA);
      s.selectOffer(0);
      const made = s.takeResult(true);
      s.done = true; h.tick({ capture: false });
      out.push([prof, made === 1 || made > 1 ? 'ok' : 'none', `${o.nA} ${o.costA}${o.costB ? ' + ' + o.nB + ' ' + o.costB : ''} -> ${o.nR} ${o.result}`, v.uses[o.key], a0 - G.inv.count(o.costA), G.inv.count(o.result), h.state()]);
    }
    G.inv.slots.fill(null);
    return out;
  });
  const bad3 = r3.filter((x) => x[1] !== 'ok' || !(x[3] >= 1) || x[6] !== 'play');
  log('first offers', r3.map((x) => `${x[0]}: ${x[2]} x${x[3]}`).join('; '));
  check(r3.length === 13 && !bad3.length, `a trade with each of 13 professions' first offer through the game's screen ${JSON.stringify(bad3.slice(0, 2))}`);

  // ---------------------------------------------------------------- 4. level up after enough trades
  const r4 = await run(({ vid }) => {
    const h = window.__rs, G = h.G, m = G.ents.find((e) => e.vid === vid);
    m.hold = 30;
    const c0 = G.vil.stats().celebrations, lvl0 = m.lvl || 1;
    G.openTrade(m);
    const s = h.screen(), n0 = s.offers.length;
    let trades = 0;
    for (let guard = 0; guard < 200 && (m.lvl || 1) === lvl0; guard++) {
      const i = s.offers.findIndex((o) => !(m.uses[o.key] >= o.maxUses));
      if (i < 0) { for (const o of s.offers) m.uses[o.key] = 0; continue; }
      const o = s.offers[i];
      G.inv.add(o.costA, 64); if (o.costB) G.inv.add(o.costB, 64);
      s.selectOffer(i);
      trades += s.takeResult(false);
      if (s.cursor) { G.inv.add(s.cursor.id, s.cursor.n); s.cursor = null; }
    }
    const n1 = s.offers.length, parts = G.parts.length;
    const res = { lvl0, lvl: m.lvl, xp: m.xp, trades, n0, n1, celebrations: G.vil.stats().celebrations - c0, parts, title: s.title() };
    h.tick({ capture: false });
    return res;
  }, { vid: vil.vid });
  await shot('t4_levelup');
  await run(() => { const h = window.__rs; h.screen().done = true; h.tick({ capture: false }); h.G.inv.slots.fill(null); });
  check(r4.lvl === r4.lvl0 + 1 && r4.celebrations >= 1 && r4.parts > 0, `the ${vil.prof} levels up after ${r4.trades} trades (xp ${r4.xp}, "${r4.title}"): celebrate and green sparkles (${r4.parts} particles)`);
  check(r4.n1 > r4.n0, `the next level's offers appear (${r4.n0} -> ${r4.n1})`);

  // ---------------------------------------------------------------- 5. sold out, restock once a day, demand
  const r5 = await run(({ vid }) => {
    const h = window.__rs, G = h.G, m = G.ents.find((e) => e.vid === vid);
    m.hold = 30;
    G.openTrade(m);
    const s = h.screen(), i = 0, o = s.offers[i];
    m.uses = {}; m.demand = {};
    let trades = 0;
    for (let guard = 0; guard < 80 && !(m.uses[o.key] >= o.maxUses); guard++) {
      G.inv.slots.fill(null);
      G.inv.add(o.costA, 64 * 4); if (o.costB) G.inv.add(o.costB, 64 * 4);
      s.selectOffer(i);
      trades += s.takeResult(true);
    }
    const out = s.matched() < 0 && s.result() == null;
    s.pick = i;
    h.tick({ capture: false });
    return { key: o.key, maxUses: o.maxUses, nA: o.nA, mul: o.priceMul, uses: m.uses[o.key], trades, out, day: G.day };
  }, { vid: vil.vid });
  await shot('t5_sold_out');
  await run(() => { const h = window.__rs; h.screen().done = true; h.tick({ capture: false }); h.G.inv.slots.fill(null); });
  check(r5.uses === r5.maxUses && r5.out, `sold out after ${r5.trades} trades (uses ${r5.uses} of ${r5.maxUses}): no result, the offer greyed with the cross`);
  // the next morning: to its job site in the work period, where it restocks
  const restockAt = (vid) => run(({ vid }) => {
    const h = window.__rs, G = h.G;
    G.day += 1; G.time = 1500;
    for (let k = 0; k < 4000; k++) {
      h.tick({ capture: false });
      const m = G.ents.find((e) => e.vid === vid);
      if (m && m.restockT === G.day) return { ok: true, k, time: G.time, m };
    }
    return { ok: false, time: G.time };
  }, { vid }).then((x) => x);
  const s5 = await run(({ vid }) => { const m = window.__rs.G.ents.find((e) => e.vid === vid); return { r: window.__rs.G.vil.stats().restocks, t: m.restockT }; }, { vid: vil.vid });
  const k5 = await restockAt(vil.vid);
  const a5 = await run(({ vid, key, nA, mul }) => {
    const h = window.__rs, G = h.G, m = G.ents.find((e) => e.vid === vid);
    const o = h.G.tradeUI && null;
    return { uses: m.uses[key] || 0, demand: m.demand[key] || 0, restockT: m.restockT, day: G.day, time: G.time, price: nA + Math.max(0, Math.floor(nA * (m.demand[key] || 0) * mul)), atJob: m.job ? Math.abs(m.tx - m.job[0]) + Math.abs(m.ty - m.job[1]) : -1 };
  }, { vid: vil.vid, key: r5.key, nA: r5.nA, mul: r5.mul });
  check(k5.ok && k5.time >= 2000 && a5.uses === 0 && a5.restockT === a5.day, `the next day it restocks at its job site in the work period (at ${Math.round(k5.time)}; uses back to ${a5.uses})`);
  check(a5.demand === r5.maxUses && a5.price > r5.nA, `the sold-out day raised the price: demand ${a5.demand}, ${r5.nA} -> ${a5.price}`);
  // shown and paid at that price on the screen
  const p5 = await run(({ vid }) => {
    const h = window.__rs, G = h.G, m = G.ents.find((e) => e.vid === vid);
    m.hold = 30; G.openTrade(m);
    const s = h.screen(), o = s.offers[0];
    G.inv.slots.fill(null); G.inv.add(o.costA, 64 * 2);
    const a0 = G.inv.count(o.costA);
    s.selectOffer(0); s.takeResult(false);
    if (s.cursor) { G.inv.add(s.cursor.id, s.cursor.n); s.cursor = null; }
    const paid = a0 - G.inv.count(o.costA) - (s.pay[0] ? s.pay[0].n : 0);
    s.done = true; h.tick({ capture: false }); G.inv.slots.fill(null);
    return { paid, uses: m.uses[o.key], restockT: m.restockT };
  }, { vid: vil.vid });
  check(p5.paid === a5.price, `and the trade pays the raised price (${p5.paid})`);
  // the same day: no second restock
  const same = await run(({ vid }) => { const h = window.__rs, G = h.G; for (let k = 0; k < 900; k++) h.tick({ capture: false }); const m = G.ents.find((e) => e.vid === vid); return { uses: m.uses, restockT: m.restockT, time: G.time, day: G.day }; }, { vid: vil.vid });
  check(same.uses[r5.key] === p5.uses && same.restockT === a5.day && same.day === a5.day, `no second restock the same day (uses ${same.uses[r5.key]} at ${Math.round(same.time)})`);
  // a quiet day: demand falls back (16 + 1 - 15 -> 2, then to 0)
  await restockAt(vil.vid);
  const q5 = await run(({ vid, key }) => { const m = window.__rs.G.ents.find((e) => e.vid === vid); return { demand: m.demand[key] || 0, uses: m.uses[key] || 0 }; }, { vid: vil.vid, key: r5.key });
  await restockAt(vil.vid);
  const q6 = await run(({ vid, key }) => { const m = window.__rs.G.ents.find((e) => e.vid === vid); return { demand: m.demand[key] || 0 }; }, { vid: vil.vid, key: r5.key });
  check(q5.demand < a5.demand && q6.demand === 0, `quiet days bring the demand down: ${a5.demand} -> ${q5.demand} -> ${q6.demand}`);
  log('restocks', s5.r, '->', await run(() => window.__rs.G.vil.stats().restocks));

  // ---------------------------------------------------------------- 6. Mart prices in a generated world
  const r6 = await run(async () => {
    const M = await import('/src/mart.js');
    const p = (id) => M.salePrice({ id });
    return { golden_apple: p('golden_apple'), emerald: p('emerald'), emerald_block: p('emerald_block'), diamond_helmet: p('diamond_helmet'), cobblestone: p('cobblestone'), potion: p('potion'), diamond: p('diamond') };
  });
  check(r6.golden_apple === 96 && r6.emerald === 32 && r6.emerald_block === 288 && r6.diamond_helmet === 416 && r6.potion === 96, `a generated world's Mart pays the capped prices: ${JSON.stringify(r6)}`);
  check(r6.cobblestone === 2 && r6.diamond === 1000, 'and the rest as before (cobblestone 2, diamond 1000)');

  // ---------------------------------------------------------------- 7. save and reload
  const before = await run(async ({ vid }) => {
    const h = window.__rs, m = h.G.ents.find((e) => e.vid === vid);
    const ok = await h.save();
    return { ok, st: JSON.stringify([m.lvl, m.xp, m.uses, m.demand, m.restockT]) };
  }, { vid: vil.vid });
  const url = page.url().replace(/\?.*$/, '');
  await page.goto(url + '?play');
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
  await prep();
  await frames(45);
  const after = await run(({ vid, id }) => {
    const h = window.__rs, rec = h.G.vil.recOf(id), m = rec && rec.list.find((x) => x.vid === vid);
    return m ? JSON.stringify([m.lvl, m.xp, m.uses, m.demand, m.restockT]) : null;
  }, { vid: vil.vid, id: v.id });
  check(before.ok && after === before.st, `after a save and reload the villager's level, xp, uses, demand and restock day are the same (${after})`);
  const errs = await run(() => window.__rs.G.errors || []);
  check(!errs.length, 'no G.errors: ' + errs.slice(0, 2).join(' | '));
}
