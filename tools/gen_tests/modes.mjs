// Stage 8a: the mode rules in generated worlds (design 6.1 to 6.4, test plan 11.5).
//
//   node tools/headless.mjs tools/gen_tests/modes.mjs --params '?new&play&world=wild&wseed=1&mode=creative' --port 5650 --out <dir>
//
// One browser context (IndexedDB and localStorage carry across reloads):
//   1. Creative: no damage from a zombie (it ignores him), no hunger over 5 minutes of play, instant break with no
//      drop, a placed stack does not shrink, a POKe Ball throw keeps the count, the WILD POKeMON option stops step
//      encounters and visible spawns, a lost battle heals with no death, end portal frames, the exit portal, the egg,
//      bedrock and a spawner refuse to break, no protected item in the creative tabs, the hotbar-only HUD;
//   2. difficulty: a zombie's hit on Easy, Normal and Hard; Peaceful: no natural hostiles (an existing zombie
//      vanishes), the blaze platform's spawner still makes blazes that deal nothing and drop rods;
//   3. Hardcore: hearts, autosave at a battle start, a portal, a teleport and the 45 s clock, death: the world list's
//      marker before the save lands and before the screen, "Game over!" with both buttons, Spectate World (through a
//      wall, no mining, no battle), reloading lands in spectator; a forced save failure still loads in spectator; a
//      blackout is a game over, and Title Screen.
export default async function (t) {
  const { page, R, run, tick, idle, shot, check, log } = t;
  const url = page.url().replace(/\?.*$/, '');
  const prep = async () => {
    await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
    await page.evaluate(() => { const h = window.__rs; h.pause(); h.seed(2026); });
  };
  // (the local server sometimes drops a request under load and the page never gets ready: the load is tried again)
  const reload = async (q) => {
    for (let k = 0; ; k++) {
      await page.goto(url + q);
      try { await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: k < 2 ? 40000 : 90000 }); break; } catch (e) { if (k >= 2) throw e; log('reload again', q); }
    }
    await prep();
  };
  const errs = () => R('(G.errors || []).slice(0, 3)');
  // an open floor cell near (x0, y0) with its four neighbours open too (dry, no block, no warp)
  const open = (x0, y0) => run(async ([x0, y0]) => {
    const h = window.__rs, W = h.world, PL = h.PL;
    const ok = (x, y) => PL.canEnter({ riding: null }, x, y) === 'walk' && !W.isWater(x, y) && !W.block(x, y) && !W.warpAt(x, y) && W.isFloor(x, y) && !W.tallGrass(x, y);
    for (let r = 0; r < 60; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = x0 + dx * 2, y = y0 + dy * 2;
      await h.ensure(x, y, 1);
      if ([[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [1, 1]].every(([a, b]) => ok(x + a, y + b))) return [x, y];
    }
    return null;
  }, [x0, y0]);
  const tp = (c, dir = 'right') => run(async ([x, y, dir]) => { const h = window.__rs; await h.ensure(x, y, 1); h.teleport(x, y, dir); h.P.dir = dir; return [h.P.tx, h.P.ty]; }, [c[0], c[1], dir]);
  const settle = async () => { for (let i = 0; i < 400 && (await R("h.state() !== 'play'")); i++) await tick({ press: i % 10 === 0 ? 'a' : undefined }); };

  // ================================================================ 1. Creative
  const m0 = await R('h.modes()');
  log('creative boot', JSON.stringify({ mode: m0.mode, diff: m0.diff, hud: m0.rules && m0.rules.hud }));
  check(m0.mode === 'creative' && m0.rules.hud === 'hotbar' && m0.rules.instantBreak, 'a ?mode=creative Wild World boots in Creative (rules from src/modes.js)');
  const sp = await R('[h.gen.plan().spawn.px, h.gen.plan().spawn.py]');
  const c1 = await open(sp[0], sp[1]);
  check(!!c1, 'open ground near the spawn');
  await tp(c1);
  await run(() => { const h = window.__rs; h.setTime(18000); h.G.ents = h.G.ents.filter((e) => e.type !== 'mob'); });

  // a zombie beside him at night: it ignores him, and a direct hit does nothing
  const z1 = await run(async () => {
    const h = window.__rs, G = h.G, P = h.P, log = [], orig = G.hurtPlayer;
    G.hurtPlayer = (d, ...a) => { log.push(d); return orig(d, ...a); };
    const z = h.spawn('zombie', P.tx + 1, P.ty);
    for (let i = 0; i < 120; i++) h.tick({ capture: false });
    const direct = G.hurtPlayer(5, 'test');
    G.hurtPlayer = orig;
    z.dead = true;
    return { hp: P.health, log, direct, hidden: P.hidden, dead: P.dead };
  });
  log('creative zombie', JSON.stringify(z1));
  check(z1.hp === 20 && !z1.dead && z1.direct === false && z1.hidden, 'Creative: a zombie beside him at night deals no damage (hostiles ignore him; a hit does nothing)');

  // 5 minutes of play time with heavy exhaustion: the food bar never moves
  const hg = await run(() => {
    const h = window.__rs, G = h.G, P = h.P, t0 = G.playTime;
    P.food = 20; P.sat = 0; P.exh = 3.9; h.setTime(6000);
    let minFood = 20;
    for (let i = 0; i < 6000; i++) { if (i % 20 === 0) { h.PL.exhaust(P, 0.5); } h.step(1, 0.05); minFood = Math.min(minFood, P.food); }
    return { played: G.playTime - t0, food: P.food, minFood, exh: P.exh, st: h.state() };
  });
  log('creative hunger', JSON.stringify(hg));
  check(hg.played >= 300 && hg.minFood === 20, `Creative: no hunger over ${Math.round(hg.played)} s of play (food stays 20)`);
  await settle();
  await tp(c1);

  // instant break with no drop; a placed stack does not shrink
  const br = await run(() => {
    const h = window.__rs, G = h.G, P = h.P, W = h.world;
    const fx = P.tx + 1, fy = P.ty;
    P.dir = 'right';
    h.clearInv();
    W.setBlock(fx, fy, { id: 'cobblestone' });
    const items0 = G.ents.filter((e) => e.type === 'item').length;
    let frames = 0;
    for (; frames < 10 && W.block(fx, fy); frames++) h.tick({ hold: 'a', capture: false });
    const gone = !W.block(fx, fy);
    for (let i = 0; i < 10; i++) h.tick({ capture: false });
    const items1 = G.ents.filter((e) => e.type === 'item').length;
    // place cobblestone from a stack of 5
    G.inv.slots[0] = { id: 'cobblestone', n: 5 }; G.inv.sel = 0;
    h.tick({ press: 'b', capture: false });
    for (let i = 0; i < 6; i++) h.tick({ capture: false });
    const placed = (W.block(fx, fy) || {}).id || null;
    return { gone, frames, items0, items1, placed, n: G.inv.slots[0] && G.inv.slots[0].n };
  });
  log('creative break/place', JSON.stringify(br));
  check(br.gone && br.frames <= 2 && br.items1 === br.items0, `Creative: a cobblestone block breaks in ${br.frames} frame(s) and drops nothing`);
  check(br.placed === 'cobblestone' && br.n === 5, 'Creative: placing a block from a stack of 5 leaves 5');

  // protected blocks refuse to break (the egg may hop, as Minecraft's does, but stays in the world)
  const pr = await run(() => {
    const h = window.__rs, G = h.G, P = h.P, W = h.world, fx = P.tx + 1, fy = P.ty, out = {};
    P.dir = 'right';
    G.inv.slots[0] = { id: 'diamond_pickaxe', n: 1 }; G.inv.sel = 0;
    for (const id of ['end_portal_frame', 'end_portal', 'bedrock', 'dragon_egg', 'spawner', 'infested_stone_bricks']) {
      W.setBlock(fx, fy, { id });
      for (let i = 0; i < 30; i++) h.tick({ hold: 'a', capture: false });
      let still = (W.block(fx, fy) || {}).id === id;
      if (!still && id === 'dragon_egg') for (let y = fy - 8; y <= fy + 8 && !still; y++) for (let x = fx - 8; x <= fx + 8 && !still; x++) still = (W.block(x, y) || {}).id === 'dragon_egg';
      out[id] = still;
      for (let y = fy - 8; y <= fy + 8; y++) for (let x = fx - 8; x <= fx + 8; x++) { const b = W.block(x, y); if (b && b.id === id) W.setBlock(x, y, null); }
      for (let i = 0; i < 10; i++) h.tick({ capture: false });
    }
    return out;
  });
  log('creative protected', JSON.stringify(pr));
  check(Object.values(pr).every(Boolean), 'Creative: end portal frames, the exit portal, bedrock, the dragon egg, a spawner and infested stone refuse to break');

  // the creative tabs never offer a protected (or the paused Wither's) item
  const tabs = await run(async () => {
    const C = await import('/src/ui/creative.js'), M = await import('/src/modes.js'), h = window.__rs, items = h.A.items.items;
    const all = new Set(); for (const l of Object.values(C.tabContents())) for (const id of l) all.add(id);
    const bad = [...all].filter((id) => !M.inCreativeTabs(id, items[id]) || ['end_portal_frame', 'bedrock', 'spawner', 'dragon_egg', 'end_portal', 'nether_portal'].includes(id) || /^infested_/.test(id));
    return { n: all.size, bad };
  });
  log('creative tabs', JSON.stringify(tabs));
  check(tabs.n > 100 && tabs.bad.length === 0, `no protected item in the ${tabs.n} items of the creative tabs`);
  await shot('creative_hud');

  // a POKe Ball throw keeps the count; a lost battle heals the party and ends with no death
  const bl = await run(() => {
    const h = window.__rs, G = h.G, P = h.P;
    h.clearInv(); G.inv.slots[2] = { id: 'poke_ball', n: 3 };
    const mon = h.addMon('PIDGEY', 5);
    h.encounter('RATTATA', 3);
    for (let i = 0; i < 80 && h.state() !== 'battle'; i++) h.tick({ capture: false });
    const inBattle = h.state() === 'battle';
    h.battle().throwBall('poke_ball');
    const balls = G.inv.count('poke_ball');
    mon.hp = 0; P.health = 3;
    h.battle().finished = 'whiteout';
    for (let i = 0; i < 60 && h.state() !== 'play'; i++) h.tick({ capture: false });
    for (let i = 0; i < 5; i++) h.tick({ capture: false });
    return { inBattle, balls, st: h.state(), dead: P.dead, hp: P.health, monHp: mon.hp, max: mon.maxHp };
  });
  log('creative battle', JSON.stringify(bl));
  check(bl.inBattle && bl.balls === 3, 'Creative: a POKe Ball thrown in battle leaves the count at 3');
  check(bl.st === 'play' && !bl.dead && bl.hp === 20 && bl.monHp === bl.max, 'Creative: a lost battle (blackout) heals the party and Steve, and ends with no death');

  // the WILD POKeMON option: a forced step encounter in tall grass runs with it on, not with it off
  const grass = await run(async (c) => {
    const h = window.__rs, W = h.world;
    for (let r = 1; r < 80; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = c[0] + dx, y = c[1] + dy;
      await h.ensure(x, y, 1);
      if (W.tallGrass(x, y) && h.PL.canEnter({ riding: null }, x - 1, y) === 'walk' && !W.tallGrass(x - 1, y) && !W.isWater(x - 1, y)) return [x, y];
    }
    return null;
  }, c1);
  check(!!grass, 'tall grass found near the spawn');
  const enc = async (on) => {
    await tp([grass[0] - 1, grass[1]]);
    return run((on) => {
      const h = window.__rs; h.rules.encounters = true; h.setWildOption(on);
      h.nextEncounter('PIDGEY', 3);
      for (let i = 0; i < 20; i++) h.tick({ hold: 'right', capture: false });
      const st = h.state();
      for (let i = 0; i < 80 && h.state() !== 'battle' && st !== 'play'; i++) h.tick({ capture: false });
      if (h.battle()) h.battle().finished = 'ran';
      for (let i = 0; i < 60 && h.state() !== 'play'; i++) h.tick({ capture: false });
      return { st, P: [h.P.tx, h.P.ty] };
    }, on);
  };
  const wOff = await enc(false), wOn = await enc(true);
  log('wild option', JSON.stringify({ wOff, wOn }));
  check(wOff.st === 'play' && wOn.st === 'transition', 'Creative: WILD POKeMON OFF stops step encounters (a forced one in tall grass starts only with it ON)');
  // visible spawns: count trySpawn's work over 20 s with the option off (the gate sits before the spawner's roll)
  const vis = await run(() => {
    const h = window.__rs, G = h.G; h.setWildOption(false);
    G.ents = G.ents.filter((e) => e.type !== 'wild');
    for (let i = 0; i < 600; i++) h.tick({ capture: false });
    const off = G.ents.filter((e) => e.type === 'wild').length;
    h.setWildOption(true); h.rules.encounters = false;
    return { off };
  });
  log('wild visible', JSON.stringify(vis));
  check(vis.off === 0, 'Creative: with WILD POKeMON OFF no visible wild POKeMON appear in 20 s');
  await settle();

  // ================================================================ 2. Difficulty and Peaceful (same world, set by the hook)
  const dmg = await run(async (c) => {
    const h = window.__rs, G = h.G, P = h.P, out = {};
    for (const d of ['easy', 'normal', 'hard']) {
      h.setMode('survival', d);
      h.teleport(c[0], c[1], 'right'); h.setTime(18000);
      G.ents = G.ents.filter((e) => e.type !== 'mob');
      h.clearInv(); P.health = 20; P.invuln = 0;
      const log = [], orig = G.hurtPlayer; G.hurtPlayer = (x, ...a) => { log.push(x); return orig(x, ...a); };
      const z = h.spawn('zombie', P.tx + 1, P.ty);
      for (let i = 0; i < 120 && !log.length; i++) h.tick({ capture: false });
      G.hurtPlayer = orig; z.dead = true;
      out[d] = { hit: log[0], hp: P.health };
      for (let i = 0; i < 5; i++) h.tick({ capture: false });
    }
    return out;
  }, c1);
  log('difficulty', JSON.stringify(dmg));
  check(dmg.easy.hit === 2.5 && dmg.normal.hit === 3 && dmg.hard.hit === 4.5 && dmg.hard.hp === 15.5, 'a zombie (3) hits for 2.5 on Easy, 3 on Normal, 4.5 on Hard (health 15.5)');

  const pc = await run(async (c) => {
    const h = window.__rs, G = h.G, P = h.P;
    h.setMode('survival', 'peaceful');
    h.teleport(c[0], c[1], 'right'); h.setTime(18000);
    G.ents = G.ents.filter((e) => e.type !== 'mob');
    const z = h.spawn('zombie', P.tx + 3, P.ty);
    for (let i = 0; i < 20; i++) h.tick({ capture: false });
    const zGone = z.dead || !G.ents.includes(z);
    const kinds = {};
    for (let i = 0; i < 400; i++) { const m = h.E.trySpawnHostile(); if (m) { kinds[m.kind] = (kinds[m.kind] || 0) + 1; m.dead = true; } }
    P.health = 10; P.food = 10;
    for (let i = 0; i < 60; i++) h.step(1, 0.05);
    return { zGone, kinds, hp: P.health, food: P.food };
  }, c1);
  log('peaceful overworld', JSON.stringify(pc));
  check(pc.zGone && Object.keys(pc.kinds).every((k) => k === 'enderman'), `Peaceful: an existing zombie vanishes; 400 hostile spawn tries give only endermen (${JSON.stringify(pc.kinds)})`);
  check(pc.hp >= 11 && pc.food >= 11, `Peaceful: health and food come back (3 s: health ${pc.hp}, food ${pc.food})`);

  // the blaze platform's spawner in the Nether: blazes still come, deal nothing, and drop rods
  const nb = await run(async () => {
    const h = window.__rs, G = h.G, P = h.P, W = h.world, N = W.nether;
    if (!N) return { none: true };
    const cells = [];
    for (let y = 0; y < N.h; y++) for (let x = 0; x < N.w; x++) if (N.biome[y][x] === 'B') cells.push([N.x + x, N.y + y]);
    // a walkable platform cell
    const at = cells.find(([x, y]) => h.PL.canEnter({ riding: null }, x, y) === 'walk' && !W.isLava(x, y));
    if (!at) return { cells: cells.length };
    h.teleport(at[0], at[1], 'down');
    G.ents = G.ents.filter((e) => e.type !== 'mob' && e.type !== 'item');
    const log = [], orig = G.hurtPlayer; G.hurtPlayer = (x, ...a) => { log.push(x); return orig(x, ...a); };
    let blazes = 0, rods = 0;
    P.health = 20;
    const hp0 = P.health;
    for (let round = 0; round < 12 && !rods; round++) {
      let b = null;
      for (let i = 0; i < 2000 && !b; i++) { const m = h.E.trySpawnNether(); if (m && m.kind === 'blaze') b = m; else if (m) m.dead = true; }
      if (!b) break;
      blazes++;
      for (let i = 0; i < 150; i++) h.tick({ capture: false });   // it shoots and touches; nothing lands
      h.E.hurtMob(b, 999, { x: P.tx, y: P.ty }, { player: true });
      for (let i = 0; i < 60; i++) h.tick({ capture: false });
      rods = G.ents.filter((e) => e.type === 'item' && e.stack && e.stack.id === 'blaze_rod').length + G.inv.count('blaze_rod');
    }
    G.hurtPlayer = orig;
    return { blazes, rods, hits: log.length, maxHit: Math.max(0, ...log), hp0, hp: P.health, dead: P.dead };
  });
  log('peaceful blaze', JSON.stringify(nb));
  check(nb.blazes >= 1 && nb.rods >= 1 && nb.maxHit === 0 && !nb.dead && nb.hp >= nb.hp0, `Peaceful: the blaze spawner still makes blazes (${nb.blazes}), their ${nb.hits} hits deal 0, and they drop rods`);
  check((await errs()).length === 0, 'no G.errors in Creative, the difficulty checks and Peaceful: ' + JSON.stringify(await errs()));

  // ================================================================ 3. Hardcore
  await reload('?new&play&world=wild&wseed=1&mode=hardcore&diff=easy');
  const h0 = await R('h.modes()');
  check(h0.mode === 'hardcore' && h0.diff === 'hard' && h0.rules.hud === 'hardcore', 'a Hardcore world is locked to Hard (asked for Easy) and its HUD is the hardcore one');
  const c2 = await open(...(await R('[h.gen.plan().spawn.px, h.gen.plan().spawn.py]')));
  await tp(c2);
  await run(async () => { const M = await import('/src/ui/mcgui.js'); await M.loadMenuAssets(); });   // (the hearts' textures load after the boot)
  await run(() => { const h = window.__rs; h.setTime(6000); h.P.health = 13; h.G.ents = h.G.ents.filter((e) => e.type !== 'mob'); for (let i = 0; i < 40; i++) h.tick({ capture: false }); });
  await shot('hardcore_hearts');
  check(await R('!!G.hcHearts'), 'the hardcore hearts are drawn (once their textures are in)');

  const as = await run(async () => {
    const h = window.__rs, G = h.G, out = {};
    const reasons = () => h.modes().autosaves.map((a) => a.reason);
    const wait = async () => { for (let i = 0; i < 50 && G.autoBusy; i++) await new Promise((r) => setTimeout(r, 20)); };
    // the battle's start
    const n0 = reasons().length;
    h.encounter('RATTATA', 3);
    out.battle = reasons().slice(n0);
    for (let i = 0; i < 80 && h.state() !== 'battle'; i++) h.tick({ capture: false });
    if (h.battle()) h.battle().finished = 'ran';
    for (let i = 0; i < 60 && h.state() !== 'play'; i++) h.tick({ capture: false });
    await wait();
    // a portal (into the Nether and back) and a teleport (The End's exit home)
    const n1 = reasons().length;
    h.enterNether(); await wait();
    h.leaveNether(); for (let i = 0; i < 120 && h.state() === 'genwait'; i++) h.tick({ capture: false }); await wait();
    h.exitEnd(); for (let i = 0; i < 120 && h.state() === 'genwait'; i++) h.tick({ capture: false }); await wait();
    out.travel = reasons().slice(n1);
    // the 45 s clock
    const n2 = reasons().length;
    for (let i = 0; i < 47 * 20; i++) h.step(1, 0.05);
    await wait();
    out.timer = reasons().slice(n2);
    out.saved = !!(await h.worlds().loadWorld(h.wid()));
    out.warps = h.world.warps ? h.world.warps.length : 0;
    return out;
  });
  log('autosaves', JSON.stringify(as));
  check(as.battle.includes('battle'), 'Hardcore: autosave at the start of a battle');
  check(as.travel.filter((r) => r === 'portal').length >= 2 && as.travel.includes('teleport'), 'Hardcore: autosave on a portal (both ways) and a teleport');
  check(as.timer.includes('timer') && as.saved, 'Hardcore: autosave every 45 s of play; the save is in IndexedDB');
  if (as.warps) {
    const wr = await run(async () => {
      const h = window.__rs, n = h.modes().autosaves.length;
      const i = h.world.warps.findIndex((w) => w.to != null);
      if (i < 0) return null;
      h.warp(i); for (let k = 0; k < 120 && h.state() === 'warp'; k++) h.tick({ capture: false });
      return h.modes().autosaves.slice(n).map((a) => a.reason);
    });
    log('warp autosave', JSON.stringify(wr));
    if (wr) check(wr.includes('warp'), 'Hardcore: autosave on a warp');
  } else log('(a Wild World has no warps before stages 5b and 7a: the warp autosave is wired in updateWarp, not exercised here)');
  await settle();

  // death: the marker is in the world list in the same frame, before the save lands and before the screen
  await tp(c2);
  const dd = await run(() => {
    const h = window.__rs, G = h.G, P = h.P;
    P.invuln = 0; G.hurtPlayer(100, 'Steve was slain by Zombie');
    h.tick({ capture: false });
    const list = JSON.parse(localStorage.getItem('poke-redstone-worlds')), e = list && list.worlds.find((w) => w.id === h.wid());
    const last = h.modes().autosaves.slice(-1)[0];
    return { hc: e && e.hc, log: h.modes().log, landed: last && last.ok, reason: last && last.reason, st: h.state(), screen: !!h.hcScreen() };
  });
  log('death', JSON.stringify(dd));
  check(dd.hc && dd.hc.dead && dd.hc.cause === 'Steve was slain by Zombie', 'Hardcore death: the world list entry has hc.dead with the cause');
  check(dd.log && dd.log.join() === 'dead,marker,save' && dd.reason === 'death' && dd.landed === undefined, 'the marker was written before the save started, and the save has not landed yet');
  check(dd.st === 'play' && !dd.screen, 'no death screen yet (so no button could have been pressed)');
  for (let i = 0; i < 60; i++) await tick();
  const ds = await run(async () => {
    const h = window.__rs, s = h.hcScreen();
    const sv = await h.worlds().loadWorld(h.wid());
    return { st: h.state(), kind: s && s.kind, labels: s && s.buttons.map((b) => b.label), active: s && s.active, saveHc: sv && sv.hc };
  });
  log('death screen', JSON.stringify(ds));
  check(ds.st === 'dead' && ds.kind === 'hardcoreDeath' && ds.labels.join() === 'Spectate World,Title Screen' && ds.active, '"Game over!" screen with Spectate World and Title Screen');
  check(ds.saveHc && ds.saveHc.dead, 'the full save carries the same hc marker');
  await shot('hardcore_game_over');

  // Spectate World
  await tick({ press: 'a' }); await idle(4);
  const sp1 = await R('({ m: h.modes().mode, st: h.state(), dead: P.dead, hidden: P.hidden, hud: h.modes().rules.hud })');
  log('spectate', JSON.stringify(sp1));
  check(sp1.m === 'spectator' && sp1.st === 'play' && !sp1.dead && sp1.hud === 'none', 'Spectate World: a spectator, no HUD');
  await shot('spectator');
  // through a wall: a solid cell with open ground beyond
  const wall = await run(async (c) => {
    const h = window.__rs, W = h.world;
    for (let r = 1; r < 60; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = c[0] + dx, y = c[1] + dy;
      await h.ensure(x, y, 1);
      if (W.solid(x, y) && !W.solid(x - 1, y) && !W.solid(x + 1, y) && !W.isWater(x - 1, y) && !W.isWater(x + 1, y) && !W.isVoid(x, y) && W.inBorder(x, y)) return [x, y];
    }
    return null;
  }, c2);
  check(!!wall, 'a solid cell with ground both sides found');
  await tp([wall[0] - 1, wall[1]]);
  for (let i = 0; i < 40; i++) await tick({ hold: 'right' });
  const thr = await R('[P.tx, P.ty]');
  log('through the wall', JSON.stringify({ wall, P: thr }));
  check(thr[1] === wall[1] && thr[0] > wall[0], 'a spectator walks through a solid cell');
  const nm = await run(() => {
    const h = window.__rs, G = h.G, P = h.P, W = h.world;
    h.teleport(P.tx, P.ty, 'right'); P.dir = 'right';
    W.setBlock(P.tx + 1, P.ty, { id: 'cobblestone' });
    for (let i = 0; i < 60; i++) h.tick({ hold: 'a', capture: false });
    const mined = !W.block(P.tx + 1, P.ty);
    W.setBlock(P.tx + 1, P.ty, null);
    h.encounter('RATTATA', 3);
    const st = h.state();
    for (let i = 0; i < 5; i++) h.tick({ capture: false });
    return { mined, st, battle: !!h.battle() };
  });
  log('spectator mine/battle', JSON.stringify(nm));
  check(!nm.mined && nm.st === 'play' && !nm.battle, 'a spectator cannot mine or battle');
  // reloading lands in spectator
  await reload('?play');
  const rl = await R('({ m: h.modes().mode, gen: !!W.layout.gen, hc: h.modes().hc })');
  log('reload', JSON.stringify(rl));
  check(rl.gen && rl.m === 'spectator' && rl.hc && rl.hc.dead, 'reloading a dead hardcore world lands in spectator');

  // a forced save failure: the marker alone still makes the reload a spectator's
  await reload('?new&play&world=wild&wseed=2&mode=hardcore');
  const ff = await run(async () => {
    const h = window.__rs, G = h.G, P = h.P;
    h.failSaves(true);
    P.invuln = 0; G.hurtPlayer(100, 'Steve was slain by Skeleton');
    h.tick({ capture: false });
    for (let i = 0; i < 50 && G.autoBusy; i++) await new Promise((r) => setTimeout(r, 20));
    const last = h.modes().autosaves.slice(-1)[0];
    return { wid: h.wid(), ok: last && last.ok, saved: !!(await h.worlds().loadWorld(h.wid())) };
  });
  log('failed save', JSON.stringify(ff));
  check(ff.ok === false && !ff.saved, 'the forced save failure: nothing is written');
  await reload('?play');
  const fr = await R('({ m: h.modes().mode, wid: h.wid() })');
  log('failed save reload', JSON.stringify(fr));
  check(fr.wid === ff.wid && fr.m === 'spectator', 'after a failed save the reload still loads that world in spectator');

  // a blackout is a game over; Title Screen
  await reload('?new&play&world=wild&wseed=3&mode=hardcore');
  const bo = await run(() => {
    const h = window.__rs, G = h.G, P = h.P;
    const mon = h.addMon('PIDGEY', 5);
    h.encounter('RATTATA', 3);
    for (let i = 0; i < 80 && h.state() !== 'battle'; i++) h.tick({ capture: false });
    mon.hp = 0; h.battle().finished = 'whiteout';
    for (let i = 0; i < 80 && h.state() !== 'dead'; i++) h.tick({ capture: false });
    for (let i = 0; i < 35; i++) h.tick({ capture: false });
    return { st: h.state(), hc: h.modes().hc, screen: h.hcScreen() && h.hcScreen().kind };
  });
  log('blackout', JSON.stringify(bo));
  check(bo.st === 'dead' && bo.hc && bo.hc.dead && /blacked out/.test(bo.hc.cause) && bo.screen === 'hardcoreDeath', 'Hardcore: a blackout in a battle is the game over');
  await tick({ press: 'down' }); await tick({ press: 'a' }); await idle(3);
  const ts = await R('({ st: h.state(), m: h.modes().mode })');
  log('title screen', JSON.stringify(ts));
  check(ts.st === 'title' && ts.m === 'spectator', 'Title Screen: back to the title, the world now a spectator\'s');
  check((await errs()).length === 0, 'no G.errors in the hardcore part: ' + JSON.stringify(await errs()));
}
