// Stage 7b: villagers and iron golems in the game (design 13, 7b; 5.3, 5.5, 5.8, 5.9, 5.10; 11.6's behaviour part).
//
//   node tools/headless.mjs tools/gen_tests/villagers_game.mjs --params '?new&play&world=wild&wseed=1' --port 5463 --out <dir>
//
//   0. every profession (13, unemployed and nitwit) appears across 4 seeds' plans (Node);
//   1. the village nearest the spawn with 8 or more houses: one villager per bed with its house's profession and its
//      type's look, a golem, its pen animals; all placed by the clock (at work at 6000); their sheets drawn; sounds wired;
//   2. the schedule: at 11500 a villager walks home, at 12500 it is inside its house, and the morning after it is out;
//   3. parking: the village leaves G.ents when Steve goes far, and coming back at night every villager is in its bed;
//   4. a golem kills a zombie; a golem killed drops iron;
//   5. a zombie at night goes for an outdoor villager nearer than Steve; a villager killed drops nothing and is gone;
//   6. its empty bed refills after 2 days (the newcomer claims the dead villager's free job site); the golem after 3;
//   7. Z on a villager never hurts it (a nitwit or the unemployed: "Hrmm"); arrows pass; X on the bell sends villagers home;
//   8. the farmer replants ripe farm rows (the farm record, not cells);
//   9. save and reload: the same villagers (ids, professions, homes) and the empty-bed record come back;
//  10. frame cost with the village in G.ents; no G.errors.
import { makeGen, makePlan } from '../../src/gen/index.js';
import { hash32 } from '../../src/gen/hash.js';
import { PROFS } from '../../src/gen/village.js';
import { readFileSync } from 'node:fs';
const terrain = JSON.parse(readFileSync(new URL('../../assets/world/terrain.json', import.meta.url), 'utf8'));

export default async function (t) {
  const { page, run, check, log, shot } = t;
  const frames = (n, dt = 1 / 30) => run(({ n, dt }) => { const h = window.__rs; for (let i = 0; i < n; i++) h.tick({ dt, capture: false }); return h.G.time; }, { n, dt });
  // run frames until a page predicate (a function body over h, G, V, m) holds, at most max frames
  const until = (pred, max = 3000, arg = null) => run(({ pred, max, arg }) => {
    const h = window.__rs, f = new Function('h', 'G', 'V', 'arg', 'return ' + pred);
    for (let i = 0; i < max; i++) { if (f(h, h.G, h.G.vil, arg)) return { ok: true, i, time: h.G.time }; h.tick({ capture: false }); }
    return { ok: !!f(h, h.G, h.G.vil, arg), i: max, time: h.G.time };
  }, { pred, max, arg });
  const prep = () => run(() => { const h = window.__rs; h.pause(); h.seed(5); h.rules.encounters = false; h.G.rules.mobs = false; h.G.rules.wild = false; h.P.health = 20; });
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
  await prep();
  await run(() => window.__rs.setTime(6000));

  // ---------------------------------------------------------------- 0. professions across 4 seeds (Node)
  {
    const seen = new Set();
    for (const seed of [1, 2, 3, 4]) {
      const plan = makePlan(makeGen({ type: 'wild', seed }, { terrain }));
      for (const v of plan.json.villages) for (const h of v.houses) for (let k = 0; k < (h.beds || 1); k++) {
        if (k === 0 && h.prof >= 0 && (h.job || h.jobIn)) seen.add(PROFS[h.prof]);
        else seen.add(hash32(v.seed, 70, h.id, k) % 5 === 0 ? 'nitwit' : 'none');
      }
    }
    const want = [...PROFS, 'none', 'nitwit'], miss = want.filter((p) => !seen.has(p));
    check(!miss.length, `every profession appears across 4 seeds' villages (${seen.size} of ${want.length})${miss.length ? ' missing ' + miss : ''}`);
  }

  // ---------------------------------------------------------------- 1. population
  const v = await run(async () => {
    const h = window.__rs, W = h.world, plan = h.gen.plan(), sp = plan.spawn, L = W.layout;
    let best = null, bd = 1e9;
    for (const v of plan.villages) { const d = Math.abs(v.x - sp.x) + Math.abs(v.y - sp.y); if (v.houses.length >= 8 && d < bd) { bd = d; best = v; } }
    if (!best) return null;
    for (let y = best.y0; y < best.y0 + best.h + 31; y += 16) for (let x = best.x0; x < best.x0 + best.w + 31; x += 16) await W.ensureAround(L.ox + Math.min(x, best.x0 + best.w - 1), L.oy + Math.min(y, best.y0 + best.h - 1), 1);
    const px = L.ox + best.plaza[0] + 4, py = L.oy + best.plaza[1] + 6;
    h.teleport(px, py, 'down');
    return { id: best.id, style: best.style, houses: best.houses.length, beds: best.houses.reduce((s, x) => s + (x.beds || 1), 0), pens: best.pens.length, px, py, ox: L.ox, oy: L.oy,
      plaza: best.plaza, bell: best.bell, farms: best.farms.length, dist: bd };
  });
  check(!!v, 'a village with 8 or more houses exists near the spawn');
  if (!v) return;
  log('village', JSON.stringify(v));
  await frames(45);
  const s1 = await run((v) => {
    const h = window.__rs, G = h.G, V = G.vil, rec = V.recOf(v.id), fails = [];
    const inEnts = new Set(G.ents);
    const vt = { plains: 'plains', desert: 'desert', savanna: 'savanna', taiga: 'taiga', snowy: 'snow' }[v.style];
    for (const m of rec.list) {
      if (!inEnts.has(m)) fails.push(`villager ${m.vid} not in G.ents`);
      if (m.look !== vt + '_' + m.prof) fails.push(`villager ${m.vid} look ${m.look}`);
      if (!V.ensureLook(m) || !h.A.mob['villager_' + m.look]) fails.push(`villager ${m.vid} sheet not made`);
      const st = m.job ? (Math.abs(m.tx - m.job[0]) + Math.abs(m.ty - m.job[1])) : -1;
      if (m.job && st !== 1 && !(m.prof === 'farmer' && m.harvestDay !== G.day)) fails.push(`villager ${m.vid} (${m.prof}) not at its job site at 6000 (${st})`);
    }
    const profs = {}; for (const m of rec.list) profs[m.prof] = (profs[m.prof] || 0) + 1;
    const pens = G.ents.filter((e) => e.type === 'mob' && ['cow', 'pig', 'sheep', 'chicken'].includes(e.kind) && v.pens && true).length;
    const sfx = ['villager.ambient', 'villager.yes', 'villager.no', 'villager.trade', 'villager.hurt', 'villager.death', 'iron_golem.attack', 'iron_golem.hurt', 'iron_golem.death', 'iron_golem.step', 'bell.use'].filter((k) => !(h.A.sfx[k] && h.A.sfx[k].length));
    return { fails, n: rec.list.length, pop: rec.pop, active: rec.active, golem: !!rec.golem && inEnts.has(rec.golem), golemSheet: !!h.A.mob['iron_golem_0'], profs, stats: V.stats(), pens, sfxMissing: sfx };
  }, v);
  check(s1.pop && s1.active && s1.n === v.beds, `village ${v.id} (${v.style}, ${v.houses} houses) populated: ${s1.n} villagers for ${v.beds} beds, all in G.ents (${JSON.stringify(s1.profs)})`);
  check(s1.golem && s1.golemSheet, 'its iron golem (8 or more houses) is in G.ents and drawn');
  check(!s1.fails.length, `every villager has its type's look and its house's profession, its sheet drawn, and stands at its job site at 6000 ${s1.fails.slice(0, 5).join('; ')}`);
  check(v.pens === 0 || s1.stats.penAnimals > 0, `pen animals: ${s1.stats.penAnimals} in ${v.pens} pen(s)`);
  check(!s1.sfxMissing.length, 'the villager, iron golem and bell sounds are wired (sfx.json groups) ' + s1.sfxMissing.join(','));
  const sfxFiles = await run(async () => { const h = window.__rs, out = []; for (const k of ['villager.ambient', 'iron_golem.hurt', 'bell.use']) { const f = h.A.sfx[k][0]; const r = await fetch(`assets/sfx/${f}.ogg`); out.push(r.ok ? (await r.arrayBuffer()).byteLength : 0); } return out; });
  check(sfxFiles.every((n) => n > 1000), 'the sound files load: ' + sfxFiles.join(', ') + ' bytes');
  await shot('v1_day');

  // ---------------------------------------------------------------- 2. the schedule
  // a villager with an outdoor job (or any) that we follow
  const A0 = await run((v) => {
    const h = window.__rs, V = h.G.vil, rec = V.recOf(v.id), W = h.world;
    const m = rec.list.find((m) => m.job && W.isOutdoor(m.job[0], m.job[1])) || rec.list[0];
    const g = V.geo(m);
    return { vid: m.vid, prof: m.prof, door: g.door, room: g.room };
  }, v);
  const where = (vid) => run(({ vid }) => {
    const h = window.__rs, m = h.G.ents.find((e) => e.vid === vid), V = h.G.vil;
    if (!m) return null;
    const g = V.geo(m), r = g.room, inside = m.tx >= r.x && m.ty >= r.y && m.tx < r.x + r.w && m.ty < r.y + r.h;
    return { tx: m.tx, ty: m.ty, plan: m.plan, sleep: !!m.sleep, inside, out: h.world.isOutdoor(m.tx, m.ty), door: Math.abs(m.tx - g.door[0]) + Math.abs(m.ty - g.door[1]) };
  }, { vid });
  await run(() => window.__rs.setTime(10000));
  await frames(3);
  const w0 = await where(A0.vid);
  const u1 = await until('G.time >= 11000 && G.time < 11600', 3000);
  const w1 = await where(A0.vid);
  await frames(30);
  const u2 = await until('G.time >= 11500', 1200);
  const w2 = await where(A0.vid);
  check(w0 && w0.plan === 'gather' && w1 && u2.ok && w2 && w2.plan === 'home' && (w2.inside || w2.door < w1.door || w2.door <= 1), `at 11500 villager ${A0.vid} (${A0.prof}) walks home: plan ${w2 && w2.plan}, ${w1 && w1.door} cells from its door at 11000, ${w2 && w2.door} at ${Math.round(u2.time)}${w2 && w2.inside ? ' (already inside)' : ''}`);
  const u3 = await until('G.time >= 12500', 2000);
  const w3 = await where(A0.vid);
  check(u3.ok && w3 && w3.inside, `at 12500 it is inside its house (${JSON.stringify(w3)})`);
  const allIn = await run((v) => { const h = window.__rs, V = h.G.vil, rec = V.recOf(v.id); let n = 0, bed = 0; for (const m of rec.list) { const g = V.geo(m), r = g.room; if (m.tx >= r.x && m.ty >= r.y && m.tx < r.x + r.w && m.ty < r.y + r.h) n++; if (m.sleep) bed++; } return { n, bed, all: rec.list.length }; }, v);
  check(allIn.n >= allIn.all - 1, `at 12500 ${allIn.n} of ${allIn.all} villagers are inside (${allIn.bed} already in bed)`);
  await run(() => window.__rs.setTime(23950));
  await frames(30);
  const w4 = await where(A0.vid);
  const u5 = await until('G.time >= 1500 && G.time < 2000', 2400);
  const w5 = await where(A0.vid);
  check(w4 && w4.sleep && w4.inside && u5.ok && w5 && w5.out && !w5.sleep, `the night through it sleeps in its bed (${JSON.stringify(w4)}); in the morning it is out (${JSON.stringify(w5)} at ${Math.round(u5.time)})`);

  // ---------------------------------------------------------------- 3. parking: away and back at night
  const far = await run(async (v) => {
    const h = window.__rs, W = h.world, b = W.layout.border;
    const tx = v.px + 160 < b.x1 - 10 ? v.px + 160 : v.px - 160;
    await W.ensureAround(tx, v.py, 1);
    let c = null;
    for (let d = 0; d < 30 && !c; d++) for (let dx = -d; dx <= d && !c; dx++) { const x = tx + dx, y = v.py + d; if (W.ready(x, y) && !W.solid(x, y) && !W.isWater(x, y) && h.E.cellFree(x, y)) c = [x, y]; }
    if (!c) c = [tx, v.py];
    h.teleport(c[0], c[1], 'down');
    return c;
  }, v);
  await frames(45);
  const p1 = await run((v) => { const h = window.__rs, rec = h.G.vil.recOf(v.id), ins = new Set(h.G.ents); return { mulFar: h.G.vil.spawnMul(h.P), mulIn: h.G.vil.spawnMul({ tx: v.px, ty: v.py }), active: rec.active, inEnts: rec.list.filter((m) => ins.has(m)).length, golem: rec.golem ? ins.has(rec.golem) : null }; }, v);
  check(p1.mulIn === 2 && p1.mulFar === 1, `the night's hostile spawn rate doubles inside a village's bounds (x${p1.mulIn}) and not outside (x${p1.mulFar})`);
  check(!p1.active && p1.inEnts === 0 && !p1.golem, `Steve 160 cells away (${far}): the village is parked (${JSON.stringify(p1)})`);
  await run(() => window.__rs.setTime(15000));
  await frames(10);
  await run((v) => window.__rs.teleport(v.px, v.py, 'down'), v);
  await frames(40);
  const p2 = await run((v) => {
    const h = window.__rs, V = h.G.vil, rec = V.recOf(v.id), ins = new Set(h.G.ents), bad = [];
    for (const m of rec.list) { const g = V.geo(m), b = g.beds[m.home.bed] || g.beds[0]; if (!ins.has(m) || !m.sleep || m.tx !== b[0] || m.ty !== b[1]) bad.push(m.vid); }
    return { active: rec.active, n: rec.list.length, bad, golem: rec.golem ? ins.has(rec.golem) && h.world.isOutdoor(rec.golem.tx, rec.golem.ty) : null };
  }, v);
  check(p2.active && !p2.bad.length && p2.golem, `back at night (15000): every villager unparked is in its bed (${p2.n - p2.bad.length} of ${p2.n}${p2.bad.length ? ', not: ' + p2.bad : ''}), the golem outdoors`);
  // a house at night: screenshot from inside the followed villager's house
  await run((a) => { const h = window.__rs; h.teleport(a.room.x + 3, a.room.y + 4, 'left'); }, A0);
  await frames(20);
  await shot('v3_night_house');
  await run((v) => window.__rs.teleport(v.px, v.py, 'down'), v);
  await frames(20);

  // ---------------------------------------------------------------- 4. the golem and a zombie
  await run(() => { const P = window.__rs.P; P.health = 20; P.food = 20; P.invuln = 1e9; P.hidden = true; });   // (Steve is not what these test: monsters ignore him)
  const g1 = await run((v) => {
    const h = window.__rs, rec = h.G.vil.recOf(v.id), g = rec.golem, W = h.world;
    let c = null;
    for (let d = 3; d < 8 && !c; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) { const x = g.tx + dx, y = g.ty + dy; if (!c && h.E.cellFree(x, y) && W.isOutdoor(x, y)) c = [x, y]; }
    const z = h.E.spawnMob('zombie', c[0], c[1]);
    z.persistent = true; window.__z = z;
    return { g: [g.tx, g.ty], z: c };
  }, v);
  const u6 = await until('window.__z.dead', 900);
  const g2 = await run(() => ({ hits: window.__rs.G.vil.stats().golemHits, zdead: !!window.__z.dead }));
  check(u6.ok && g2.zdead && g2.hits > 0, `the golem kills a zombie spawned ${Math.abs(g1.z[0] - g1.g[0]) + Math.abs(g1.z[1] - g1.g[1])} cells away (${g2.hits} blows, ${u6.i} frames)`);
  // the golem killed: iron drops, the record notes the day
  const g3 = await run(async (v) => {
    const h = window.__rs, rec = h.G.vil.recOf(v.id), g = rec.golem, x = g.tx, y = g.ty;
    h.teleport(v.px, v.py + (Math.abs(v.py - y) < 12 ? 14 : 0), 'down');   // (Steve out of pickup reach)
    g.invuln = 0; h.E.hurtMob(g, 500, { x: x - 1, y });
    for (let i = 0; i < 40; i++) h.tick({ capture: false });
    for (let i = 0; i < 2; i++) h.tick({ capture: false });
    const drops = h.G.ents.filter((e) => e.type === 'item' && Math.abs(e.x / 16 - x) < 3 && Math.abs(e.y / 16 - y) < 3);
    const iron = drops.filter((e) => e.stack.id === 'iron_ingot').reduce((s, e) => s + e.stack.n, 0);
    for (const e of drops) e.dead = true;
    for (let i = 0; i < 31; i++) h.tick({ capture: false });
    return { dead: g.dead, iron, golem: !!rec.golem, gd: rec.golemDead, day: h.G.day };
  }, v);
  check(g3.dead && g3.iron >= 3 && g3.iron <= 5 && !g3.golem && g3.gd === g3.day, `a golem killed drops ${g3.iron} iron ingots (3 to 5) and its village notes the day`);

  // ---------------------------------------------------------------- 5. a zombie and an outdoor villager at night
  const z1 = await run((v) => {
    const h = window.__rs, G = h.G, V = G.vil, rec = V.recOf(v.id), W = h.world;
    h.setTime(14000);
    for (let i = 0; i < 3; i++) h.tick({ capture: false });
    // one villager caught outdoors at night (a plaza cell); Steve 14 cells off; a zombie 5 cells from the villager
    const m = rec.list.find((m) => m.prof !== 'nitwit') || rec.list[0];
    const [px, py] = v.plaza;
    let c = null;
    for (let d = 0; d < 5 && !c; d++) for (let dx = -d; dx <= d && !c; dx++) { const x = v.ox + px + 4 + dx, y = v.oy + py + 4 + d; if (h.E.cellFree(x, y) && W.isOutdoor(x, y)) c = [x, y]; }
    m.sleep = false; m.tx = m.fx = m.fromX = c[0]; m.ty = m.fy = m.fromY = c[1]; m.moving = false; m.path = null; m.vT = G.day * 24000 + G.time;
    let zc = null;
    for (const [dx, dy] of [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 2], [-4, -2], [3, 3]]) { const x = c[0] + dx, y = c[1] + dy; if (!zc && h.E.cellFree(x, y) && W.isOutdoor(x, y)) zc = [x, y]; }
    h.P.hidden = false;
    const z = h.E.spawnMob('zombie', zc[0], zc[1]); z.persistent = true; window.__z = z; window.__m = m;
    let sc = null;
    for (const [dx, dy] of [[14, 0], [-14, 0], [0, 14], [0, -14], [12, 6], [-12, -6]]) { const x = zc[0] + dx, y = zc[1] + dy; if (!sc && W.ready(x, y) && h.E.cellFree(x, y) && W.isOutdoor(x, y)) sc = [x, y]; }
    h.teleport(sc[0], sc[1], 'down');
    return { vid: m.vid, prof: m.prof, v0: c, z0: zc, steve: sc, dz: Math.abs(zc[0] - c[0]) + Math.abs(zc[1] - c[1]) };
  }, v);
  // held where it stands (as if cornered), the zombie walks to it and strikes it, not Steve
  await run(() => { window.__m.hold = 30; window.__m.lastU = window.__rs.G.playTime; });
  const u7 = await until('G.vil.stats().zombieHits > 0', 450);
  const z2 = await run(() => { const z = window.__z, m = window.__m, P = window.__rs.P; return { chasing: z.chasing, d: Math.abs(z.tx - m.tx) + Math.abs(z.ty - m.ty), dSteve: Math.abs(z.tx - P.tx) + Math.abs(z.ty - P.ty), hits: window.__rs.G.vil.stats().zombieHits, hp: m.hp, steveHp: P.health }; });
  check(u7.ok && z2.chasing === z1.vid && z2.d <= 2 && z2.hits > 0 && z2.hp < 20, `at night a zombie goes for an outdoor villager nearer than Steve (villager ${z1.vid} ${z1.dz} cells off, Steve about 14): beside it after ${u7.i} frames (${z2.d} apart after the knockback), ${z2.hits} blow(s), its hp ${z2.hp}; Steve ${z2.dSteve} cells off`);
  // let go: it runs for its door
  await run(() => { window.__m.hold = 0; });
  const u7b = await until('window.__m.flee > 0 && window.__m.plan === "home"', 120);
  check(u7b.ok, `a villager with a zombie beside it outdoors flees home (${u7b.i} frames)`);
  // killed: nothing dropped, gone, its bed noted empty
  const k1 = await run(() => {
    const h = window.__rs, m = window.__m, rec = h.G.vil.recOf(m.home.v), x = m.tx, y = m.ty;
    window.__z.dead = true;
    const old = new Set(h.G.ents);
    m.invuln = 0;
    const hurt = h.E.hurtMob(m, 100, { x: x + 1, y }, { zombie: true });
    for (let i = 0; i < 70; i++) h.tick({ capture: false });
    const drops = h.G.ents.filter((e) => (e.type === 'item' || e.type === 'xp') && !old.has(e)).length;
    return { hurt, dead: !!m.dead, inList: rec.list.includes(m), inEnts: h.G.ents.includes(m), drops, vac: rec.vacant[m.home.h + ':' + m.home.bed], day: h.G.day, prof: m.prof, job: m.job, home: m.home };
  });
  log('killed', JSON.stringify(k1));
  check(k1.hurt && k1.dead && !k1.inList && !k1.inEnts && k1.drops === 0 && k1.vac === k1.day, `a villager a zombie kills drops nothing and is gone; its bed is noted empty on day ${k1.vac}`);

  // ---------------------------------------------------------------- 6. the empty bed refills after 2 days; the golem after 3
  const dayTo = (d) => run(({ d }) => { const h = window.__rs; h.G.day = d; h.setTime(100); for (let i = 0; i < 40; i++) h.tick({ capture: false }); const st = h.G.vil.stats(); return st; }, { d });
  const d0 = k1.day;
  const r1 = await dayTo(d0 + 1);
  const r2 = await dayTo(d0 + 2);
  const nv = await run((k) => { const h = window.__rs, rec = h.G.vil.recOf(k.home.v); const m = rec.list.find((m) => m.home.h === k.home.h && m.home.bed === k.home.bed); const c = k.job && rec.list.find((m) => m.job && m.job[0] === k.job[0] && m.job[1] === k.job[1]); return m ? { vid: m.vid, prof: m.prof, job: m.job, inEnts: h.G.ents.includes(m), claim: c ? { vid: c.vid, prof: c.prof } : null } : null; }, k1);
  check(r1.refills === 0 && r2.refills === 1 && nv && nv.inEnts, `the empty bed refills at the second dawn, not the first (refills ${r1.refills}, then ${r2.refills}): villager ${nv && nv.vid} at that house`);
  check(!k1.job || (nv && nv.claim && nv.claim.prof === k1.prof), `an unemployed villager claims the dead ${k1.prof}'s free job site (${JSON.stringify(nv && nv.claim)}); the newcomer is ${nv && nv.prof}`);
  const r3 = await dayTo(d0 + 3);
  const gb = await run((v) => { const h = window.__rs, rec = h.G.vil.recOf(v.id); return { golem: !!rec.golem && h.G.ents.includes(rec.golem), n: rec.list.length }; }, v);
  check(gb.golem, `the golem comes back after 3 days (${gb.n} villagers live there; golems ${r3.golems})`);

  await run(() => { window.__rs.P.invuln = 0; });
  // ---------------------------------------------------------------- 7. Z, arrows, the bell
  const dead = await run(() => { const P = window.__rs.P; return P.dead ? P.deathMsg || 'dead' : null; });
  check(!dead, 'Steve alive through the fights: ' + dead);
  await run(() => window.__rs.setTime(6000));
  await frames(5);
  const zt = await run(async (v) => {
    const h = window.__rs, G = h.G, rec = G.vil.recOf(v.id), W = h.world, out = [];
    for (const want of [(m) => m.prof === 'nitwit' || m.prof === 'none', (m) => m.prof !== 'nitwit' && m.prof !== 'none']) {
      const m = rec.list.find((m) => want(m) && W.isOutdoor(m.tx, m.ty) && !m.moving);
      if (!m) { out.push(null); continue; }
      // Steve beside it, facing it
      let at = null;
      for (const [dx, dy, dir] of [[0, 1, 'up'], [0, -1, 'down'], [1, 0, 'left'], [-1, 0, 'right']]) if (!at && h.E.cellFree(m.tx + dx, m.ty + dy) && !W.warpAt(m.tx + dx, m.ty + dy)) at = [m.tx + dx, m.ty + dy, dir];
      if (!at) { out.push(null); continue; }
      h.teleport(at[0], at[1], at[2]);
      const hp = m.hp; G.actionBar = null;
      m.hold = 5;   // still for the blow
      h.tick({ capture: false });
      const tgt = (() => { const q = h.PL.target(h.P); return q ? q.kind + ':' + (q.mob ? q.mob.vid : '') : null; })(), st0 = h.state(), pm = h.P.moving, pd = h.P.dir;
      h.tick({ press: 'a', capture: false });
      const bar0 = G.actionBar && G.actionBar.text;
      for (let i = 0; i < 3; i++) h.tick({ press: 'a', capture: false });
      for (let i = 0; i < 20; i++) h.tick({ hold: 'a', capture: false });
      const arrow = h.E.hurtMob(m, 5, { x: at[0], y: at[1] }, { player: true, projectile: true });
      const blow = h.E.hurtMob(m, 5, { x: at[0], y: at[1] }, { player: true, melee: true });
      const boom = h.E.hurtMob(m, 9, { x: at[0], y: at[1] });
      // (7c: Z on a villager with a profession opens its trade screen; it is closed again here)
      const scr = h.state() === 'screen' && h.screen() ? h.screen().kind : null;
      if (scr) { h.screen().done = true; h.tick({ capture: false }); }
      out.push({ tgt, st0, pm, pd, bar0, vid: m.vid, prof: m.prof, hp0: hp, hp: m.hp, dying: !!m.dying, bar: G.actionBar && G.actionBar.text, arrow, blow, boom, scr });
    }
    return out;
  }, v);
  const [zn, zp] = zt;
  check(zn && zn.hp === zn.hp0 && !zn.dying && zn.bar === 'Hrmm', `Z on a villager with no trade (${zn && zn.prof}) never hurts it and says "Hrmm" (${JSON.stringify(zn)})`);
  check(zp && zp.hp === zp.hp0 && !zp.dying && !zp.arrow && !zp.blow && !zp.boom && zp.scr === 'trade' && !zn.scr, `Z on a villager with a profession (7c: opens its trade screen, ${zp && zp.scr}) (${zp && zp.prof}) never hurts it; player blows, arrows and explosions do nothing (${JSON.stringify(zp)})`);
  if (v.bell) {
    const bell = await run((v) => {
      const h = window.__rs, G = h.G, W = h.world, bx = v.ox + v.bell[0], by = v.oy + v.bell[1];
      let at = null;
      for (const [dx, dy, dir] of [[0, 1, 'up'], [0, -1, 'down'], [1, 0, 'left'], [-1, 0, 'right']]) if (!at && h.E.cellFree(bx + dx, by + dy)) at = [bx + dx, by + dy, dir];
      h.teleport(at[0], at[1], at[2]);
      h.tick({ capture: false });
      h.tick({ press: 'b', capture: false });
      const rec = G.vil.recOf(v.id), alarmed = rec.list.filter((m) => m.alarm > 0).length, near = rec.list.filter((m) => Math.hypot(m.tx - bx, m.ty - by) <= 32 && !m.sleep).length;
      for (let i = 0; i < 600; i++) h.tick({ capture: false });
      const inside = rec.list.filter((m) => !W.isOutdoor(m.tx, m.ty)).length;
      const left = rec.list.filter((m) => W.isOutdoor(m.tx, m.ty)).map((m) => { const g = G.vil.geo(m); return [m.vid, m.plan, m.alarm | 0, Math.abs(m.tx - g.door[0]) + Math.abs(m.ty - g.door[1]), +(m.stuck || 0).toFixed(1), !!m.path]; });
      return { left, st: G.vil.stats(), block: (W.block(bx, by) || {}).id, rang: G.vil.stats().rang, alarmed, near, inside, n: rec.list.length };
    }, v);
    log('bell', JSON.stringify(bell.left), JSON.stringify(bell.st));
    check(bell.block === 'bell' && bell.rang === 1 && bell.alarmed === bell.near && bell.near > 0 && bell.inside >= bell.alarmed - 1, `X on the bell rings it: ${bell.alarmed} villagers within 32 cells run home (${bell.inside} of ${bell.n} indoors 20 s later)`);
  } else check(true, 'this village has no bell');

  // ---------------------------------------------------------------- 8. the farmer
  const fm = await run((v) => {
    const h = window.__rs, G = h.G, rec = G.vil.recOf(v.id), W = h.world;
    for (const m of rec.list) m.alarm = 0;
    const m = rec.list.find((m) => m.prof === 'farmer');
    if (!m || !rec.v.farms.length) return null;
    // every row of the village's farms ripe
    const now = G.day * 24000 + 2600;
    for (let fi = 0; fi < rec.v.farms.length; fi++) { const rows = W.farms.get(rec.v.id * 8 + fi); for (let r = 0; r < rows.length; r++) rows[r] = now - 40000; }
    m.harvestDay = -1;
    h.setTime(2600);
    window.__m = m;
    return { vid: m.vid };
  }, v);
  if (fm) {
    const u8 = await until('window.__m.harvestDay === G.day', 2400);
    const f2 = await run((v) => { const h = window.__rs, W = h.world, G = h.G, now = G.day * 24000 + G.time, out = []; for (let fi = 0; fi < v.farms; fi++) { const rows = W.farms.get(v.id * 8 + fi); out.push([...rows].map((t) => Math.round(now - t))); } return out; }, v);
    const fresh = f2.flat().filter((a) => a < 6000).length;
    check(u8.ok && fresh >= 1 && fresh <= 4, `the farmer walks to its farm and replants ${fresh} ripe rows (at most 4) in the farm record (${u8.i} frames; row ages ${JSON.stringify(f2)})`);
  } else check(true, 'this village has no farmer with a farm');

  // ---------------------------------------------------------------- 9. save and reload
  await frames(30);
  const before = await run(async (v) => {
    const h = window.__rs, rec = h.G.vil.recOf(v.id);
    const ok = await h.save();
    return { ok, list: rec.list.map((m) => [m.vid, m.prof, m.home.h, m.home.bed, m.job ? m.job.join(',') : '']).sort((a, b) => a[0] - b[0]), golem: !!rec.golem, vac: JSON.stringify(rec.vacant), bytes: JSON.stringify(h.G.vil.serialize()).length };
  }, v);
  check(before.ok, `saved (the villages' record ${before.bytes} bytes as JSON)`);
  const url = page.url().replace(/\?.*$/, '');
  await page.goto(url + '?play');
  await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
  await prep();
  await frames(45);
  const after = await run((v) => {
    const h = window.__rs, rec = h.G.vil.recOf(v.id), ins = new Set(h.G.ents);
    return { list: rec.list.map((m) => [m.vid, m.prof, m.home.h, m.home.bed, m.job ? m.job.join(',') : '']).sort((a, b) => a[0] - b[0]), golem: !!rec.golem, vac: JSON.stringify(rec.vacant), active: rec.active, inEnts: rec.list.filter((m) => ins.has(m)).length, pop: rec.pop };
  }, v);
  check(after.pop && JSON.stringify(after.list) === JSON.stringify(before.list) && after.golem === before.golem && after.vac === before.vac, `after a reload the same ${after.list.length} villagers (ids, professions, homes, job sites), the golem and the empty-bed record are back, not repopulated`);
  check(after.active && after.inEnts === after.list.length, `and the village is in again around Steve (${after.inEnts} in G.ents)`);

  // ---------------------------------------------------------------- 10. frame cost, errors
  await run(() => window.__rs.setTime(6000));
  await frames(20);
  const perf = await run(() => {
    const h = window.__rs, t0 = performance.now();
    for (let i = 0; i < 300; i++) h.tick({ capture: false });
    const ms = (performance.now() - t0) / 300;
    h.G.vil.state().searches = 0;
    const t1 = performance.now();
    for (let i = 0; i < 300; i++) h.tick({ capture: false });
    return { ms, ms2: (performance.now() - t1) / 300, searches: h.G.vil.stats().searches, ents: h.G.ents.length, errors: h.G.errors || [] };
  });
  log('perf', JSON.stringify(perf));
  check(perf.ms < 25, `a frame (update and draw) with the village in G.ents: ${perf.ms.toFixed(2)} ms mean over 300 (${perf.ents} entities; ${perf.searches} path searches in 10 s)`);
  await shot('v10_work');
  check(!perf.errors.length, 'no G.errors: ' + perf.errors.slice(0, 2).join(' | '));
}
