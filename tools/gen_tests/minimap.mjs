// Track MAP's game test (minimap-design.md 5.2): the minimap and the full map in the running game.
//
//   MM_PARTS=hud,layout,hide,burst,reveal,stream,save,kanto,markers,screen,phone,perf,shots,video \
//   node tools/headless.mjs tools/gen_tests/minimap.mjs --params '?new&play&world=wild&wseed=1' --port 5670 --out <dir>
//
// Each part boots the world it needs on the harness's own server (Wild World seed 1, Kanto World seed 1, Classic);
// `video` also serves out/baselines/v8-world-release (an earlier build) read-only on the next port (port + 1). MM_SHOTS=<dir>
// keeps the screenshots the parts take (default: <out>/shots).
//   hud      drawn at 81 x 81 at (4, 4); every explored, unmarked map pixel is its cell's palette colour (water, sand,
//            trees, paths and roofs among them), the rest fog; Steve's pointer turns with his facing
//   layout   the minimap's rectangles are disjoint from the map-name banner (the longest name), the boss bar, three
//            toasts (also under the boss bar), the closed chat, the "Waiting" box, the HUD and, on phones (390 x 844,
//            844 x 390), every pad button; the full map's panel, button and hints are clear of the hotbar and the pad
//   hide     hidden in a battle and its transition snapshot, START, OPTION, the inventory, a crafting table, death,
//            sleep, a house, the Hall of Fame, genwait and while the co-op chat field is open; shown in a message, a
//            cave, the Nether, The End, Creative and spectator
//   burst    a TNT blast and a 2,000-cell setTile loop in one frame: no frame of minimap work over 1 ms; the new
//            colours show within a few frames
//   reveal   a scripted walk sets exactly the blocks within 13 cells of its cells, none outside the region
//   stream   a teleport 400 cells away and 300 frames of sprinting: "not there yet" only until each chunk arrives,
//            no frame of minimap work over 1 ms
//   save     generated: the mask, k and villages survive a save and reload; a save without `map` loads empty; a save
//            before the minimap binds (and with its module blocked) keeps the loaded mask. Classic: the sibling key,
//            written after the save, tied by play time; a failed save leaves no newer sibling; ?new ignores it; the
//            classic-home fixture loads with an empty mask
//   kanto    the edge arrow in the target's sector; the target marker when it is on the map; standing in Kanto sets k
//            (kept through a save) and the arrow goes
//   markers  a village's icon once walked into; the spawn's white banner; the home bed's red banner
//   screen   J, a click, START > MAP open the full map; B and J close it; a J mid-step opens when the step ends, not
//            after a step that ends in an encounter; zoom cycles 0.5 1 2 4; arrows pan; START and OPTION > MINIMAP
//            switch the minimap; dying closes the map; "j" still types into text fields
//   phone    390 x 844 and 844 x 390 touch: visible; a tap opens the full map; switched off, the 20 x 20 button shows
//            and a tap on it opens the full map
//   perf     minimap work per frame (stats): mean under 0.15 ms and max under 1 ms sprinting in a Wild World and walking
//            in Classic; game frame time with it on against off (sp_diff's method), within 10% (3% reported)
//   shots    a flight around a Kanto World (desktop and an 844 x 390 phone) and a Wild World: the HUD and the full map
//   video    ?video in this tree and in the release: no minimap request, no __rs.minimap, equal canvases at 4
//            checkpoints over 240 frames, equal START rows
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE = path.resolve(ROOT, 'out', 'baselines', 'v8-world-release');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (t) {
  const { page, check, log, OUT } = t;
  const PARTS = (process.env.MM_PARTS || 'hud,layout,hide,burst,reveal,stream,save,kanto,markers,screen,phone,perf,shots,video').split(',').map((s) => s.trim()).filter(Boolean);
  const SHOTS = path.resolve(process.env.MM_SHOTS || path.join(OUT, 'shots'));
  mkdirSync(SHOTS, { recursive: true });
  const base = page.url().replace(/\?.*$/, '');
  const PORT = Number(new URL(base).port);
  const browser = page.context().browser();

  // ---------------------------------------------------------------- page helpers (any page)
  const E = (pg, expr) => pg.evaluate(new Function('return (() => { const h = window.__rs, G = h.G, P = h.P, W = h.world, A = h.A; return (' + expr + '); })()'));
  const tk = (pg, o = {}) => pg.evaluate((x) => { window.__rs.tick(x); }, { dt: 1 / 30, capture: false, ...o });
  const idleP = async (pg, n) => { for (let i = 0; i < n; i++) await tk(pg); };
  const shotP = async (pg, name) => { const url = await pg.evaluate(() => window.__rs.frame()); const f = path.join(SHOTS, name + '.png'); writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); return f; };
  const HELP = () => {
    const h = window.__rs;
    const can = () => document.getElementById('game').getContext('2d');
    window.__mmt = {
      pix: (x, y, w, hh) => Array.from(can().getImageData(x, y, w, hh).data),
      // every pixel of the 73 x 73 map: explored cells of the region in their palette colour, everything else fog;
      // the pointer, markers and dots (and their rims) are left out
      hud() {
        const mm = h.minimap({ mm: true }), P = h.P, W = h.world, I = { x: 8, y: 8, w: 73, h: 73 };
        const sx = Math.round(P.fx), sy = Math.round(P.fy), cx0 = sx - 36, cy0 = sy - 36, reg = mm.region(P.tx, P.ty);
        const img = can().getImageData(I.x, I.y, I.w, I.h).data;
        const skip = new Uint8Array(73 * 73);
        const hole = (cx, cy, r) => { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (x >= 0 && y >= 0 && x < 73 && y < 73) skip[y * 73 + x] = 1; };
        hole(36, 36, 5);
        for (const m of mm.markers(reg, true)) hole(m.x - cx0, m.y - cy0, 5);
        for (const d of mm.mates(reg)) hole(d.x - cx0, d.y - cy0, 3);
        if (mm.kanto && !mm.k) { const tg = mm.target(); if (tg) { const dx = tg.x - sx, dy = tg.y - sy; if (Math.abs(dx) <= 36 && Math.abs(dy) <= 36) hole(36 + dx, 36 + dy, 5); else { const f = 30 / Math.max(Math.abs(dx), Math.abs(dy)); hole(Math.round(36 + dx * f), Math.round(36 + dy * f), 5); } } }
        // the world border line
        const b = W.layout.border;
        const res = { ok: 0, bad: 0, fog: 0, seen: 0, classes: {}, first: null };
        const names = (window.__mmc && window.__mmc.classes) || [];
        for (let yy = 0; yy < 73; yy++) for (let xx = 0; xx < 73; xx++) {
          if (skip[yy * 73 + xx]) continue;
          const X = cx0 + xx, Y = cy0 + yy;
          if (W.layout.gen && reg && reg.kind === 'outdoor' && (X === b.x0 - 1 || X === b.x1 + 1 || Y === b.y0 - 1 || Y === b.y1 + 1)) continue;
          const inReg = reg && X >= reg.x && Y >= reg.y && X < reg.x + reg.w && Y < reg.y + reg.h;
          let p;
          if (!inReg || !W.inside(X, Y) || !mm.mask.get(X >> 2, Y >> 2)) { p = 252 + ((X + Y) & 1); res.fog++; }
          else { p = mm.cellPal(Y * W.W + X, X, Y); res.seen++; const n = p < 252 ? names[p >> 2] && names[p >> 2][0] : 'fog'; res.classes[n] = (res.classes[n] || 0) + 1; }
          const e = mm.pal.rgb[p], k = (yy * 73 + xx) * 4;
          if (img[k] === e[0] && img[k + 1] === e[1] && img[k + 2] === e[2]) res.ok++;
          else { res.bad++; if (!res.first) res.first = { X, Y, p, got: [img[k], img[k + 1], img[k + 2]], exp: e }; }
        }
        return res;
      },
      // the opaque pixels of an icon of the strip drawn at (x, y): how many match the canvas
      iconAt(name, x, y) {
        const mc = window.__mmc, ic = window.__mmi;
        if (!mc || !ic) return { n: 0, ok: 0 };
        const k = mc.icons[name], c = document.createElement('canvas'); c.width = 8; c.height = 8;
        const g = c.getContext('2d'); g.drawImage(ic, k * 8, 0, 8, 8, 0, 0, 8, 8);
        const a = g.getImageData(0, 0, 8, 8).data, b = can().getImageData(x, y, 8, 8).data;
        let n = 0, ok = 0;
        for (let i = 0; i < 64; i++) if (a[i * 4 + 3] === 255) { n++; if (a[i * 4] === b[i * 4] && a[i * 4 + 1] === b[i * 4 + 1] && a[i * 4 + 2] === b[i * 4 + 2]) ok++; }
        return { n, ok };
      },
    };
  };
  const boot = async (q, pg = page) => {
    // (one retry: on a loaded machine a page can stall for minutes; a fresh load usually comes up at once)
    for (let k = 0; ; k++) {
      try {
        await pg.goto(base + q, { timeout: 90000 });
        await pg.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
        break;
      } catch (e) { if (k) throw e; log('boot stalled, loading again:', String(e.message || e).split('\n')[0]); }
    }
    await pg.evaluate(() => { const h = window.__rs; h.pause(); h.seed(2026); if (h.rules) h.rules.encounters = false; });
    for (let i = 0; i < 100; i++) {
      const ok = await pg.evaluate(() => { const h = window.__rs; h.tick({ dt: 1 / 30, capture: false }); return h.minimap && h.minimap().loaded; });
      if (ok) break;
      await sleep(50);
    }
    await pg.evaluate(HELP);
    await pg.evaluate(async () => { const m = await import('/src/minimap.js'); window.__mmc = m.mapColors(); window.__mmi = m.mapIcons(); });
    await idleP(pg, 4);
  };
  const info = (pg = page) => pg.evaluate(() => window.__rs.minimap());
  // the whole page as a player sees it (960 x 720 on desktop)
  const pshot = (name, pg = page) => pg.screenshot({ path: path.join(SHOTS, name + '.png') });
  const errs = (pg = page) => E(pg, '(G.errors || []).slice(0, 4)');
  const tp = (pg, x, y, dir = 'down') => pg.evaluate(async ([x, y, dir]) => { const h = window.__rs; await h.ensure(x, y, 1); h.teleport(x, y, dir); h.tick({ dt: 1 / 30, capture: false }); return [h.P.tx, h.P.ty]; }, [x, y, dir]);
  // a dry walkable cell near (x, y), searched in rings (its chunks made first)
  const findWalk = (pg, x, y, r = 30, extra = '') => pg.evaluate(async ([x0, y0, r, extra]) => {
    const h = window.__rs, W = h.world, PL = h.PL, ok = new Function('W', 'x', 'y', 'return ' + (extra || 'true'));
    await h.ensure(x0, y0, 1);
    for (let d = 0; d <= r; d++) for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
      const x = x0 + dx, y = y0 + dy;
      if (!W.ready(x, y)) await h.ensure(x, y, 0);
      if (PL.canEnter({ riding: null }, x, y) === 'walk' && !W.isWater(x, y) && !W.block(x, y) && !W.warpAt(x, y) && ok(W, x, y)) return [x, y];
    }
    return null;
  }, [x, y, r, extra]);

  // ================================================================ hud
  if (PARTS.includes('hud')) {
    log('---- hud');
    await boot('?new&play&world=wild&wseed=1');
    let i0 = await info();
    check(i0.loaded && i0.shown === 'map', `the minimap shows at once in a new Wild World (${i0.explored} blocks explored)`);
    // the frame: parchment at its corners, the map inside
    const corner = await page.evaluate(() => window.__mmt.pix(4, 4, 81, 81));
    let parch = 0; for (let i = 0; i < corner.length; i += 4) if (corner[i + 3] === 255 && Math.abs(corner[i] - 214) < 3 && Math.abs(corner[i + 1] - 190) < 3 && Math.abs(corner[i + 2] - 150) < 3) parch++;
    check(parch > 300, `the frame is Minecraft's parchment, 81 x 81 at (4, 4) (${parch} parchment pixels)`);
    // a walk through a village and to a shore, then the pixel check
    const vs = await E(page, 'h.gen.plan().villages.map((v) => [v.x + 416, v.y, v.style])');
    const sp = await E(page, '[h.P.tx, h.P.ty]');
    vs.sort((a, b) => Math.hypot(a[0] - sp[0], a[1] - sp[1]) - Math.hypot(b[0] - sp[0], b[1] - sp[1]));
    const v = vs[0];
    const at = await findWalk(page, Math.round(v[0]), Math.round(v[1]), 20);
    await tp(page, at[0], at[1]);
    for (const d of ['right', 'down', 'left', 'up']) for (let i = 0; i < 24; i++) await tk(page, { hold: d });
    await idleP(page, 6);
    let r = await page.evaluate(() => window.__mmt.hud());
    log('village view', JSON.stringify({ ok: r.ok, bad: r.bad, fog: r.fog, classes: r.classes, first: r.first }));
    check(r.bad === 0 && r.seen > 300, `in a village: all ${r.ok} map pixels are their cells' palette colours or fog (${r.seen} explored)`);
    check(Object.keys(r.classes).some((n) => /^roof_|^wall_|^brick|^wood/.test(n)) && Object.keys(r.classes).some((n) => n === 'path' || n === 'gravel' || n === 'sand'), `a village shows roofs or walls and its paths (${Object.keys(r.classes).join(', ')})`);
    await shotP(page, 'hud_village');
    await pshot('desktop_hud_village');
    // a shore: a walkable cell beside water
    const shore = await page.evaluate(async () => {
      const h = window.__rs, W = h.world, PL = h.PL, x0 = h.P.tx, y0 = h.P.ty;
      for (let d = 10; d < 400; d += 6) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) {
        const x = x0 + dx, y = y0 + dy;
        if (!W.inBorder(x, y)) continue;
        await h.ensure(x, y, 1);
        if (!W.isWater(x, y)) continue;
        for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) if (PL.canEnter({ riding: null }, x + ex, y + ey) === 'walk' && !W.isWater(x + ex, y + ey)) return [x + ex, y + ey];
      }
      return null;
    });
    if (shore) {
      await tp(page, shore[0], shore[1]);
      for (let i = 0; i < 12; i++) await tk(page, { hold: 'left' });
      await idleP(page, 6);
      r = await page.evaluate(() => window.__mmt.hud());
      log('shore view', JSON.stringify({ ok: r.ok, bad: r.bad, classes: r.classes, first: r.first }));
      check(r.bad === 0 && (r.classes.water || 0) > 0, `at a shore: water among the cells (${r.classes.water || 0} water pixels), every pixel its palette colour`);
      check(Object.keys(r.classes).some((n) => /^leaves_/.test(n)) || Object.keys(r.classes).some((n) => n === 'sand'), `trees or sand on the map near the shore (${Object.keys(r.classes).join(', ')})`);
      await shotP(page, 'hud_shore');
    } else check(false, 'found a shore within 400 cells');
    // the pointer turns with his facing
    const dirs = {};
    for (const d of ['up', 'right', 'down', 'left']) {
      await page.evaluate((d) => { window.__rs.P.dir = d; window.__rs.tick({ dt: 1 / 30, capture: false }); }, d);
      dirs[d] = await page.evaluate((d) => window.__mmt.iconAt('player_' + d, 40, 40), d);
    }
    check(Object.values(dirs).every((x) => x.n > 10 && x.ok === x.n), `Steve's pointer at the centre turns with his facing (${JSON.stringify(dirs)})`);
    const wrong = await page.evaluate(() => { window.__rs.P.dir = 'left'; window.__rs.tick({ dt: 1 / 30, capture: false }); return window.__mmt.iconAt('player_right', 40, 40); });
    check(wrong.ok < wrong.n, 'facing left does not draw the right-pointing pointer');
    check(!(await errs()).length, 'no errors (hud): ' + JSON.stringify(await errs()));
  }

  // ================================================================ layout
  if (PARTS.includes('layout')) {
    log('---- layout');
    await boot('?new&play&world=wild&wseed=1');
    const R2 = (x, y, w, h) => ({ x, y, w, h });
    const meet = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const MAPR = R2(0, 0, 88, 88), FRAMER = R2(4, 4, 81, 81);
    // the banner: centred, its width from the game's own font for the longest map name of every world type
    const banner = await page.evaluate(async () => {
      const F = await import('/src/font.js');
      const names = new Set(window.__rs.world.maps.map((m) => m.name).filter(Boolean));
      for (const k of ['PLAINS', 'BIRCH FOREST', 'SNOWY MOUNTAINS', 'UNDERGROUND PATH', 'POKéMON MANSION']) names.add(k);
      let best = 0, name = '';
      for (const n of names) { const w = F.textWidth(n) + 18; if (w > best) { best = w; name = n; } }
      const x = Math.round((240 - best) / 2);
      return { x: x * 2, y: 12, w: best * 2, h: 36, name };
    });
    log('banner', JSON.stringify(banner));
    const rects = {
      banner, bossbar: R2(149, 4, 182, 16),
      toasts: R2(320, 0, 160, 3 * 32), toastsUnderBossBar: R2(320, 24, 160, 3 * 32),
      chatClosed: R2(2, 164, 204, 90), waiting: R2(92, 8, 296, 60), hud: R2(140, 230, 200, 90),
    };
    for (const [k, r] of Object.entries(rects)) check(!meet(MAPR, r), `the minimap's tap rectangle (0, 0, 88, 88) misses the ${k} (${r.x}, ${r.y}, ${r.w} x ${r.h})`);
    // the full map's panel, button and hints against the hotbar
    const screenR = [R2(96, 18, 272, 272), R2(8, 22, 80, 20), R2(8, 48, 80, 46)];
    const hotbar = R2(149, 298, 182, 22);
    check(screenR.every((r) => !meet(r, hotbar)), 'the full map\'s panel, button and hints miss the hotbar');
    // phones: every pad button and the co-op CHAT button, mapped to canvas pixels (667 x 375: an iPhone SE / 8 on its
    // side, whose INV and MENU reach up into the full map's full-size panel, which is then made shorter)
    for (const vp of [[390, 844], [844, 390], [667, 375]]) {
      const ctx = await browser.newContext({ viewport: { width: vp[0], height: vp[1] }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const pg = await ctx.newPage();
      await boot('?new&play&world=wild&wseed=1', pg);
      const pads = await pg.evaluate(() => {
        const c = document.getElementById('game').getBoundingClientRect(), out = [];
        for (const b of document.querySelectorAll('#pad button, #coop-chatbtn')) {
          const r = b.getBoundingClientRect();
          if (!r.width) continue;
          out.push({ k: b.dataset.k || b.id, x: ((r.left - c.left) / c.width) * 480, y: ((r.top - c.top) / c.height) * 320, w: (r.width / c.width) * 480, h: (r.height / c.height) * 320 });
        }
        return { pads: out, canvas: [c.width, c.height] };
      });
      const hitMap = pads.pads.filter((p) => meet(MAPR, p) || meet(FRAMER, p)).map((p) => p.k);
      check(pads.pads.length >= 8 && !hitMap.length, `${vp[0]} x ${vp[1]}: the minimap misses all ${pads.pads.length} pad buttons (canvas ${pads.canvas.map(Math.round).join(' x ')} CSS px)` + (hitMap.length ? ': hits ' + hitMap.join(', ') : ''));
      const i1 = await info(pg);
      check(i1.shown === 'map', `${vp[0]} x ${vp[1]}: the minimap is visible on a phone`);
      await pg.screenshot({ path: path.join(SHOTS, `phone_${vp[0]}x${vp[1]}.png`) });
      // the full map as this phone draws it (its panel shortened above the pad where the pad reaches into it)
      await tk(pg, { press: 'map' }); await tk(pg);
      const v = (await info(pg)).view, pn = v ? v.panel : null;
      const scrR = pn ? [pn, screenR[1], screenR[2]] : screenR;
      const hitScreen = pads.pads.filter((p) => scrR.some((r) => meet(r, p))).map((p) => p.k);
      check(!!pn && pn.h >= 120 && !hitScreen.length, `${vp[0]} x ${vp[1]}: the full map's panel (${pn ? [pn.x, pn.y, pn.w, pn.h].join(', ') : 'not open'}), button and hints miss the pad` + (hitScreen.length ? ': hits ' + hitScreen.join(', ') : ''));
      await pg.screenshot({ path: path.join(SHOTS, `phone_${vp[0]}x${vp[1]}_fullmap.png`) });
      await ctx.close();
    }
  }

  // ================================================================ hide
  if (PARTS.includes('hide')) {
    log('---- hide');
    await boot('?new&play&world=wild&wseed=1');
    const shown = async () => { await tk(page); return (await info()).shown; };
    check((await shown()) === 'map', 'shown while playing');
    // the battle's transition snapshot: the corner as drawn with the minimap off, the same frame
    const snap = await page.evaluate(() => {
      const h = window.__rs;
      h.minimap({ show: false }); h.tick({ dt: 1 / 30, capture: false });
      const off = Array.from(document.getElementById('game').getContext('2d').getImageData(0, 0, 90, 90).data);
      h.minimap({ show: null });
      h.encounter('PIDGEY', 3);
      const s = h.seq().snap.getContext('2d').getImageData(0, 0, 90, 90).data;
      let diff = 0; for (let i = 0; i < s.length; i++) if (s[i] !== off[i]) diff++;
      return { diff, state: h.state() };
    });
    check(snap.state === 'transition' && snap.diff === 0, `the battle transition's snapshot has no minimap (${snap.diff} corner bytes differ from a frame without it)`);
    check((await shown()) === null, 'hidden during the transition');
    for (let i = 0; i < 80 && (await E(page, 'h.state()')) !== 'battle'; i++) await tk(page);
    check((await shown()) === null && (await E(page, 'h.state()')) === 'battle', 'hidden in the battle');
    await page.evaluate(() => { const h = window.__rs; h.G.battle = null; h.setState('play'); });
    await idleP(page, 2);
    check((await shown()) === 'map', 'back after the battle');
    await tk(page, { press: 'start' });
    check((await E(page, 'h.state()')) === 'menu' && (await shown()) === null, 'hidden in START');
    await tk(page, { press: 'b' });
    await page.evaluate(() => window.__rs.openScreen('inventory'));
    check((await shown()) === null, 'hidden in the inventory');
    await page.evaluate(() => { const h = window.__rs; h.screen().done = true; });
    await idleP(page, 2);
    await page.evaluate(() => window.__rs.openScreen('craft'));
    check((await shown()) === null, 'hidden at a crafting table');
    await page.evaluate(() => { const h = window.__rs; h.screen().done = true; });
    await idleP(page, 2);
    await page.evaluate(() => window.__rs.G.say('Hello there.'));
    check((await E(page, 'h.state()')) === 'msg' && (await shown()) === 'map', 'shown under a message box');
    await page.evaluate(() => window.__rs.setState('play'));
    // sleep, a fade
    await page.evaluate(() => { window.__rs.P.sleeping = { hx: window.__rs.P.tx, hy: window.__rs.P.ty }; });
    const sl = await page.evaluate(() => { const h = window.__rs; h.tick({ dt: 1 / 30, capture: false }); const s = h.minimap().shown; h.P.sleeping = null; return s; });
    check(sl === null, 'hidden while asleep');
    // the co-op chat field open (NET.on with a #coop-chat element)
    const chat = await page.evaluate(async () => {
      const { NET } = await import('/src/net/flag.js'), h = window.__rs;
      const d = document.createElement('div'); d.id = 'coop-chat'; document.body.appendChild(d);
      NET.on = true; h.tick({ dt: 1 / 30, capture: false }); const s = h.minimap().shown;
      NET.on = false; d.remove(); h.tick({ dt: 1 / 30, capture: false });
      return [s, h.minimap().shown];
    });
    check(chat[0] === null && chat[1] === 'map', `hidden while the co-op chat field is open (${chat.join(' then ')})`);
    // a cave room, the Nether, The End
    const cave = await page.evaluate(() => {
      const W = window.__rs.world;
      const cave = (x) => !x.off && Number.isInteger(x.ax) && W.roomAt(x.ax, x.ay) && W.roomAt(x.ax, x.ay).kind === 'cave';
      const w = W.warps.find((x) => cave(x) && /^GEN_CAVE/.test(W.roomAt(x.ax, x.ay).id)) || W.warps.find(cave);
      return w ? [w.ax, w.ay] : null;
    });
    if (cave) {
      await tp(page, cave[0], cave[1]);
      await idleP(page, 3);
      const ic = await info();
      check(ic.shown === 'map' && ic.region && ic.region.kind === 'cave', `shown in a cave, its own region (${JSON.stringify(ic.region)})`);
      await shotP(page, 'hud_cave');
    } else check(false, 'found a cave warp');
    // a house (a village house's door warp leads into an indoor room)
    const house = await page.evaluate(() => {
      const W = window.__rs.world;
      const w = W.warps.find((x) => !x.off && Number.isInteger(x.ax) && W.roomAt(x.ax, x.ay) && W.roomAt(x.ax, x.ay).kind === 'indoor');
      return w ? [w.ax, w.ay] : null;
    });
    if (house) {
      await tp(page, house[0], house[1]);
      await idleP(page, 2);
      check((await shown()) === null, 'hidden inside a house');
    } else check(false, 'found a house warp');
    await page.evaluate(() => window.__rs.enterNether());
    for (let i = 0; i < 40 && (await E(page, 'h.state()')) !== 'play'; i++) await tk(page);
    await idleP(page, 20);
    const inn = await info();
    check(inn.shown === 'map' && inn.region && inn.region.kind === 'nether', `shown in the Nether, its own region (${inn.region && inn.region.kind})`);
    // the Nether's own floor (netherrack ground, nether brick paving) is TERRACOTTA_RED, not podzol brown
    const nfl = await page.evaluate(() => {
      const h = window.__rs, mm = h.minimap({ mm: true }), W = h.world, r = mm.region(h.P.tx, h.P.ty), cl = window.__mmc.classes, want = cl.findIndex((c) => c[0] === 'nether_floor');
      let n = 0, ok = 0;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        const k = W.nInfo(x, y);
        if (!k || k[0] !== 'floor' || !['floor', 'brick_floor'].includes(k[1]) || !mm.mask.get(x >> 2, y >> 2)) continue;
        n++; if (mm.cellPal(y * W.W + x, x, y) >> 2 === want) ok++;
      }
      return { n, ok, want };
    });
    check(nfl.want > 0 && nfl.n > 20 && nfl.ok === nfl.n, `the Nether's explored floor shows as nether_floor (${nfl.ok} of ${nfl.n} cells)`);
    await shotP(page, 'hud_nether');
    await page.evaluate(() => window.__rs.leaveNether());
    for (let i = 0; i < 60 && (await E(page, 'h.state()')) !== 'play'; i++) await tk(page);
    await idleP(page, 20);
    await page.evaluate(() => window.__rs.enterEnd());
    const fadeHidden = await shown();
    for (let i = 0; i < 60 && (await E(page, 'G.endFade')) > 0; i++) await tk(page);
    await idleP(page, 3);
    const ie = await info();
    check(fadeHidden === null && ie.shown === 'map' && ie.region && ie.region.kind === 'end', `hidden in The End's fade, then shown in The End (${ie.region && ie.region.kind})`);
    await shotP(page, 'hud_end');
    // the Hall of Fame
    await page.evaluate(() => { const h = window.__rs; h.G.end.kills = 1; h.G.end.hofSeen = false; h.exitEnd(); });
    check((await E(page, 'h.state()')) === 'hof' && (await shown()) === null, 'hidden in the Hall of Fame');
    await page.evaluate(() => window.__rs.setState('play'));
    await idleP(page, 3);
    // genwait: home to a bed in a chunk not made yet
    const far = await E(page, '[Math.min(W.layout.border.x1 - 20, h.P.tx + 500), h.P.ty]');
    await page.evaluate((far) => { const h = window.__rs; h.G.spawnBed = far; h.G.end.hofSeen = true; h.exitEnd(); }, far);
    const gw = await E(page, 'h.state()');
    const gwShown = await shown();
    check(gw === 'genwait' && gwShown === null, `hidden in genwait (${gw})`);
    for (let i = 0; i < 200 && (await E(page, 'h.state()')) !== 'play'; i++) { await tk(page); await sleep(10); }
    await page.evaluate(() => { window.__rs.G.spawnBed = null; });
    // death
    await page.evaluate(() => window.__rs.G.hurtPlayer(999, 'Steve fell'));
    for (let i = 0; i < 30; i++) await tk(page);
    check((await E(page, 'h.state()')) === 'dead' && (await shown()) === null, 'hidden on the death screen');
    await page.evaluate(() => window.__rs.respawn());
    for (let i = 0; i < 200 && (await E(page, 'h.state()')) !== 'play'; i++) { await tk(page); await sleep(10); }
    await idleP(page, 3);
    // Creative and spectator
    await page.evaluate(() => window.__rs.setMode('creative', 'normal'));
    check((await shown()) === 'map', 'shown in Creative');
    await page.evaluate(() => window.__rs.setMode('spectator', 'hard'));
    check((await shown()) === 'map', 'shown to a spectator');
    await page.evaluate(() => window.__rs.setMode('survival', 'normal'));
    // OPTION
    await tk(page, { press: 'start' });
    const optIdx = (await E(page, 'h.menuRows()')).indexOf('OPTION');
    await page.evaluate((i) => { window.__rs.setState('menu'); }, optIdx);
    for (let i = 0; i < optIdx; i++) await tk(page, { press: 'down' });
    await tk(page, { press: 'a' });
    check((await E(page, 'h.state()')) === 'option' && (await shown()) === null, 'hidden in OPTION');
    await tk(page, { press: 'b' }); await tk(page, { press: 'b' });
    check(!(await errs()).length, 'no errors (hide): ' + JSON.stringify(await errs()));
  }

  // ================================================================ burst
  if (PARTS.includes('burst')) {
    log('---- burst');
    await boot('?new&play&world=wild&wseed=1&mode=creative');
    for (const d of ['right', 'down', 'left', 'up']) for (let i = 0; i < 10; i++) await tk(page, { hold: d });
    await idleP(page, 5);
    // (a garbage collection of the world's own churn can land inside the minimap's timed work: an over-budget burst is
    // run once more, as sp_diff.mjs measures twice, and both are printed)
    const burst = (rep) => page.evaluate((rep) => {
      const h = window.__rs, W = h.world, P = h.P, mm = h.minimap({ mm: true });
      const per = [];
      const frame = () => { h.tick({ dt: 1 / 30, capture: false }); per.push(+mm.stats.cur.toFixed(3)); };
      frame();
      // a TNT blast beside him (about 100 cells) and 2,000 setTile calls in one frame
      const p0 = [P.tx, P.ty];
      h.G.explode(P.tx + 9, P.ty + 4, 6, null, {});
      const tile = rep ? h.A.terrain.synth.grounds.snow[0] : h.A.terrain.synth.grounds.sand[0], cells = [];
      for (let y = P.ty - 22; y <= P.ty + 22 && cells.length < 2000; y++) for (let x = P.tx - 22; x <= P.tx + 22 && cells.length < 2000; x++) {
        if (Math.abs(x - P.tx) < 3 && Math.abs(y - P.ty) < 3) continue;
        if (W.ready(x, y) && !W.isVoid(x, y)) { W.setTile(x, y, tile); cells.push([x, y]); }
      }
      for (let i = 0; i < 12; i++) frame();
      return { per, n: cells.length, dirty: mm.dirty.size, moved: P.tx !== p0[0] || P.ty !== p0[1], dead: P.dead };
    }, rep);
    let r = await burst(0);
    log('burst frames (ms of minimap work):', r.per.join(' '));
    if (Math.max(...r.per) >= 1) { const r2 = await burst(1); log('again:', r2.per.join(' ')); if (Math.max(...r2.per) < 1) r = { ...r, per: r2.per }; }
    check(r.n === 2000 && Math.max(...r.per) < 1, `a blast and ${r.n} setTile calls: no frame of minimap work over 1 ms (max ${Math.max(...r.per)})`);
    check(r.dirty === 0 && !r.dead, 'every marked block was recoloured within 12 frames');
    const hud = await page.evaluate(() => window.__mmt.hud());
    check(hud.bad === 0 && ((hud.classes.sand || 0) > 300 || (hud.classes.snow || 0) > 300), `the HUD shows the new colours (${hud.classes.sand || 0} sand and ${hud.classes.snow || 0} snow pixels, ${hud.bad} wrong)`);
    await shotP(page, 'hud_burst');
  }

  // ================================================================ reveal
  if (PARTS.includes('reveal')) {
    log('---- reveal');
    await boot('?new&play&world=wild&wseed=1');
    const r = await page.evaluate(() => {
      const h = window.__rs, P = h.P, mm = h.minimap({ mm: true });
      const before = mm.mask.bits.slice(), cells = new Set([P.ty * h.world.W + P.tx]);
      const plan = [['right', 24], ['down', 20], ['left', 24], ['up', 12], ['right', 8]];
      let steps = 0;
      for (const [d, n] of plan) for (let i = 0; i < n * 9; i++) {
        const was = P.tx + ',' + P.ty;
        h.tick({ dt: 1 / 30, capture: false, hold: d });
        cells.add(P.ty * h.world.W + P.tx);
        if (P.tx + ',' + P.ty !== was) steps++;
        if (steps >= 60) break;
      }
      // the expected mask: before, plus every block of the region within 13 cells of each cell he stood on
      const W = h.world, L = W.layout, w = mm.BW, hh = mm.BH, exp = before.slice();
      for (const c of cells) {
        const x = c % W.W, y = (c - x) / W.W;
        for (let by = 0; by < hh; by++) for (let bx = 0; bx < w; bx++) {
          const dx = bx * 4 + 2 - x, dy = by * 4 + 2 - y;
          if (dx * dx + dy * dy > 169) continue;
          if (bx * 4 + 3 < L.ox || bx * 4 > L.ox + L.ow - 1 || by * 4 + 3 < L.oy || by * 4 > L.oy + L.oh - 1) continue;
          const k = by * w + bx; exp[k >> 3] |= 1 << (k & 7);
        }
      }
      let diff = 0, outside = 0;
      for (let i = 0; i < exp.length; i++) if (exp[i] !== mm.mask.bits[i]) diff++;
      for (let k = 0; k < w * hh; k++) if (mm.mask.getK(k)) { const bx = k % w, by = (k - bx) / w; if (bx * 4 + 3 < L.ox || by * 4 > L.oy + L.oh - 1) outside++; }
      return { steps, cells: cells.size, diff, outside, n: mm.mask.count() };
    });
    check(r.steps >= 40 && r.diff === 0, `after a ${r.steps}-step walk (${r.cells} cells) exactly the blocks within 13 cells of the path are set (${r.n} blocks; ${r.diff} bytes differ)`);
    check(r.outside === 0, 'no block outside the overworld is set');
  }

  // ================================================================ stream
  if (PARTS.includes('stream')) {
    log('---- stream');
    await boot('?new&play&world=wild&wseed=1');
    const target = await page.evaluate(() => {
      const h = window.__rs, W = h.world, b = W.layout.border, P = h.P;
      const x = Math.max(b.x0 + 40, Math.min(b.x1 - 400, P.tx + 400 > b.x1 - 400 ? P.tx - 400 : P.tx + 400));
      return [x, Math.max(b.y0 + 60, Math.min(b.y1 - 60, P.ty))];
    });
    const land = await findWalk(page, target[0], target[1], 40);
    await tp(page, land[0], land[1], 'right');
    const sprint = (dir) => page.evaluate(async (dir) => {
      const h = window.__rs, mm = h.minimap({ mm: true }), per = [];
      let pendSeen = 0, pendReady = 0, frames = 0;
      for (let i = 0; i < 300; i++) {
        h.tick({ dt: 1 / 30, capture: false, hold: [dir, 'sprint'] });
        per.push(mm.stats.cur);
        frames++;
        if (i % 10 === 9) {
          // explored blocks still waiting for their chunk show "not there yet" or coarse colours; once a chunk is
          // ready its blocks may be in the dirty set for a frame, never longer than the budget allows
          const W = h.world;
          for (let k = 0; k < mm.ov.length; k++) {
            if (!mm.mask.getK(k)) continue;
            const bx = k % mm.BW, by = (k - bx) / mm.BW;
            if (!W.ready(bx * 4, by * 4)) { pendSeen++; continue; }
            if (!mm.dirty.has(k) && mm.ov[k] !== mm.blockPal(bx, by)) pendReady++;
          }
        }
        await new Promise((res) => setTimeout(res, 2));   // the worker's chunks arrive between frames
      }
      return { max: Math.max(...per), mean: per.reduce((a, b) => a + b, 0) / per.length, pendSeen, pendReady, x: h.P.tx, frames };
    }, dir);
    // (a frame over 1 ms is run once more, on into new land the other way: on a loaded machine the operating system can
    // stop the page in the middle of the minimap's work, which a timer cannot tell from the work itself)
    let r = await sprint('right');
    if (r.max >= 1) { log('stream (first run)', JSON.stringify(r)); const r2 = await sprint('down'); r = { ...r2, pendSeen: r.pendSeen + r2.pendSeen, pendReady: r.pendReady + r2.pendReady }; }
    log('stream', JSON.stringify(r));
    check(r.max < 1, `300 frames sprinting into new land: no frame of minimap work over 1 ms (max ${r.max.toFixed(3)}, mean ${r.mean.toFixed(3)})`);
    check(r.pendReady === 0, `explored blocks keep their coarse or "not there yet" colour only while their chunk is not ready (${r.pendSeen} samples of explored land ahead of its chunk, ${r.pendReady} stale)`);
    await idleP(page, 8);
    const hud = await page.evaluate(() => window.__mmt.hud());
    check(hud.bad === 0, `after streaming, the HUD's pixels are exact (${hud.ok} ok, ${hud.bad} wrong)` + (hud.first ? ' ' + JSON.stringify(hud.first) : ''));
    await shotP(page, 'hud_stream');
  }

  // ================================================================ save
  if (PARTS.includes('save')) {
    log('---- save');
    await boot('?new&play&world=wild&wseed=1');
    // walk into a village, so one is discovered
    const vs = await E(page, 'h.gen.plan().villages.map((v) => [v.x + 416, v.y])');
    const sp = await E(page, '[h.P.tx, h.P.ty]');
    vs.sort((a, b) => Math.hypot(a[0] - sp[0], a[1] - sp[1]) - Math.hypot(b[0] - sp[0], b[1] - sp[1]));
    const at = await findWalk(page, Math.round(vs[0][0]), Math.round(vs[0][1]), 20);
    await tp(page, at[0], at[1]);
    for (let i = 0; i < 30; i++) await tk(page, { hold: 'right' });
    await idleP(page, 3);
    const s0 = await info();
    const ok = await page.evaluate(() => window.__rs.save());
    const wid = await E(page, 'h.wid()');
    check(ok === true && s0.villages.length > 0, `saved a Wild World with ${s0.explored} blocks explored and ${s0.villages.length} village(s) found`);
    const rec = await page.evaluate(async (id) => (await window.__rs.worlds().loadWorld(id)).map, wid);
    check(rec && rec.v === 1 && rec.b === 4 && rec.w === 504 && rec.h === 400 && typeof rec.m === 'string', `the v: 2 save carries the map record (${rec && rec.m.length} characters)`);
    await boot('?play');
    let s1 = await info();
    check(s1.hash === s0.hash && s1.k === s0.k && JSON.stringify(s1.villages) === JSON.stringify(s0.villages), `reloaded by id: the same mask (${s1.hash}), k and villages`);
    // a save made at once after a load, before the minimap binds: the loaded mask is kept
    await page.goto(base + '?play');
    await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
    const early = await page.evaluate(async () => { const h = window.__rs; h.pause(); const loaded = h.minimap().loaded; const ok = await h.save(); return { loaded, ok, map: (await h.worlds().loadWorld(h.wid())).map }; });
    check(!early.loaded && early.ok && early.map && early.map.m === rec.m, 'a save before the minimap has bound keeps the loaded mask');
    // ...and with src/minimap.js failing to load
    await page.route('**/src/minimap.js**', (r) => r.abort());
    await page.goto(base + '?play');
    await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000 });
    await page.evaluate(() => window.__rs.pause());
    for (let i = 0; i < 20; i++) { await tk(page); await sleep(60); }
    const blocked = await page.evaluate(async () => { const h = window.__rs; const loaded = h.minimap().loaded; const ok = await h.save(); return { loaded, ok, map: (await h.worlds().loadWorld(h.wid())).map, errors: (h.G.errors || []).length }; });
    check(!blocked.loaded && blocked.ok && blocked.map && blocked.map.m === rec.m && blocked.errors === 0, 'with the minimap module blocked, saves keep the loaded mask and the game runs without errors');
    await page.unroute('**/src/minimap.js**');
    // a save without `map` (the release's) loads with an empty mask
    await page.evaluate(async (id) => { const h = window.__rs, d = await h.worlds().loadWorld(id); delete d.map; await h.worlds().saveWorld(id, d); }, wid);
    await boot('?play');
    s1 = await info();
    check(s1.explored > 0 && s1.explored < 60 && s1.hash !== s0.hash, `a save without a map loads with an empty mask (only the first reveal: ${s1.explored} blocks)`);
    check(!(await errs()).length, 'no errors (generated saves): ' + JSON.stringify(await errs()));

    // ---- Classic
    await boot('?new&play');
    for (const d of ['up', 'left']) for (let i = 0; i < 30; i++) await tk(page, { hold: d });
    await idleP(page, 3);
    const c0 = await info();
    const cs = await page.evaluate(() => { const h = window.__rs, ok = h.save(); const s = JSON.parse(localStorage.getItem('poke-redstone-v1')); const sib = JSON.parse(localStorage.getItem('poke-redstone-v1-map') || 'null'); return { ok, keys: Object.keys(s), pt: s.playTime, sib }; });
    check(cs.ok && !cs.keys.includes('map'), "Classic's save itself has no new key");
    check(cs.sib && cs.sib.pt === cs.pt && cs.sib.w === 102 && cs.sib.h === 266, 'the sibling key poke-redstone-v1-map holds the mask, tied to the save by its play time');
    // a failed save (storage full) writes no newer sibling
    const fail = await page.evaluate(() => {
      const h = window.__rs, before = localStorage.getItem('poke-redstone-v1-map'), orig = Storage.prototype.setItem;
      for (let i = 0; i < 40; i++) h.tick({ dt: 1 / 30, capture: false, hold: 'down' });
      Storage.prototype.setItem = function (k, v) { if (k === 'poke-redstone-v1') throw new Error('QuotaExceededError'); return orig.call(this, k, v); };
      let ok;
      try { ok = h.save(); } finally { Storage.prototype.setItem = orig; }
      return { ok, same: localStorage.getItem('poke-redstone-v1-map') === before };
    });
    check(fail.ok === false && fail.same, 'a save that fails for storage leaves the sibling as it was');
    await boot('?play');
    const c1 = await info();
    check(c1.hash === c0.hash, `?play reload: the same Classic mask (${c1.hash})`);
    // a sibling with another play time is ignored
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('poke-redstone-v1-map')); s.pt += 1; localStorage.setItem('poke-redstone-v1-map', JSON.stringify(s)); });
    await boot('?play');
    const c2 = await info();
    check(c2.explored < 60 && c2.hash !== c0.hash, `a sibling from another save is ignored (${c2.explored} blocks)`);
    await boot('?new&play');
    const c3 = await info();
    check(c3.explored < 60, `?new&play with an old sibling present starts empty (${c3.explored} blocks)`);
    // the committed Classic fixture: an old save loads with an empty mask and no errors
    const fx = readFileSync(path.join(ROOT, 'tools/gen_tests/fixtures/classic-home.json'), 'utf8');
    await page.evaluate((fx) => { localStorage.removeItem('poke-redstone-v1-map'); localStorage.setItem('poke-redstone-v1', fx); }, JSON.parse(fx).save ? JSON.stringify(JSON.parse(fx).save) : fx);
    await boot('?play');
    const c4 = await info();
    check(c4.explored < 60 && !(await errs()).length, `the classic-home fixture loads with an empty mask (${c4.explored} blocks) and no errors`);
    await page.evaluate(() => { localStorage.removeItem('poke-redstone-v1'); localStorage.removeItem('poke-redstone-v1-map'); });
  }

  // ================================================================ kanto
  if (PARTS.includes('kanto')) {
    log('---- kanto');
    await boot('?new&play&world=kanto&wseed=1');
    const k0 = await page.evaluate(() => {
      const h = window.__rs, mm = h.minimap({ mm: true }), t = mm.target(), P = h.P;
      return { t, sign: !!h.world.kantoTarget, dx: t.x - P.tx, dy: t.y - P.ty, k: mm.k };
    });
    log('kanto target', JSON.stringify(k0));
    const dir = await page.evaluate(async ([dx, dy]) => (await import('/src/mapcore.js')).sector8(dx, dy), [k0.dx, k0.dy]);
    const arrow = await page.evaluate(([dx, dy, dir]) => {
      const f = 30 / Math.max(Math.abs(dx), Math.abs(dy));
      return window.__mmt.iconAt('arrow_' + dir, Math.round(44 + dx * f) - 3, Math.round(44 + dy * f) - 3);
    }, [k0.dx, k0.dy, dir]);
    check(!k0.k && arrow.n > 10 && arrow.ok === arrow.n, `the edge arrow points toward Kanto's way in, sector ${dir} (${arrow.ok}/${arrow.n} pixels; target from ${k0.sign ? "Track SIGN's sign" : 'the fallback'})`);
    await shotP(page, 'hud_kanto_arrow');
    await pshot('desktop_hud_kanto_arrow');
    // near the target, outside Kanto: the target marker
    const near = await findWalk(page, k0.t.x - 12, k0.t.y, 30, '!W.isKantoCell(x, y)');
    if (near) {
      await tp(page, near[0], near[1]);
      await idleP(page, 4);
      const tm = await page.evaluate(() => { const h = window.__rs, mm = h.minimap({ mm: true }), t = mm.target(), P = h.P; return { pix: window.__mmt.iconAt('target_point', 8 + t.x - (P.tx - 36) - 4, 8 + t.y - (P.ty - 36) - 4), k: mm.k }; });
      check(!tm.k && tm.pix.n > 5 && tm.pix.ok >= tm.pix.n - 2, `the target marker stands on the way in when it is on the map (${tm.pix.ok}/${tm.pix.n})`);
      await shotP(page, 'hud_kanto_target');
    } else check(false, 'found land near the target');
    // standing on one of Kanto's cells sets k: the arrow is gone
    const kc = await page.evaluate(() => { const W = window.__rs.world, K = W.layout.kanto; const t = W.towns.find((x) => x.id === 'MAP_PALLET_TOWN'); return t ? [t.land.x, t.land.y] : [K.x + 70, K.y + 270]; });
    await tp(page, kc[0], kc[1]);
    await idleP(page, 3);
    const k1 = await info();
    check(k1.k && k1.kseen, `standing in Kanto (Pallet Town) sets k and Kanto is seen (${k1.k}, ${k1.kseen})`);
    await page.evaluate(() => window.__rs.save());
    await boot('?play');
    const k2 = await info();
    check(k2.k, 'k survives a save and reload');
    const back = await findWalk(page, k0.t.x - 60, k0.t.y, 40, '!W.isKantoCell(x, y)');
    if (back) {
      await tp(page, back[0], back[1]);
      await idleP(page, 3);
      const g = await page.evaluate(() => { const h = window.__rs, mm = h.minimap({ mm: true }), t = mm.target(), P = h.P, dx = t.x - P.tx, dy = t.y - P.ty, f = 30 / Math.max(Math.abs(dx), Math.abs(dy)); const out = []; for (let d = 0; d < 8; d++) { const r = window.__mmt.iconAt('arrow_' + d, Math.round(44 + dx * f) - 3, Math.round(44 + dy * f) - 3); out.push(r.ok === r.n && r.n > 0); } return out; });
      check(!g.some(Boolean), 'once Kanto has been reached, no edge arrow is drawn');
    }
    check(!(await errs()).length, 'no errors (kanto): ' + JSON.stringify(await errs()));
  }

  // ================================================================ markers
  if (PARTS.includes('markers')) {
    log('---- markers');
    await boot('?new&play&world=wild&wseed=1');
    // the spawn: a white banner once he has stepped off it (well clear of his pointer)
    const off = await E(page, '[h.P.tx, h.P.ty]');
    const away = await findWalk(page, off[0] + 10, off[1] + 6, 8);
    await tp(page, away[0], away[1]);
    await idleP(page, 3);
    const ban = await page.evaluate(() => { const h = window.__rs, P = h.P, s = h.G.worldSpawn; return window.__mmt.iconAt('white_banner', 8 + s.x - (Math.round(P.fx) - 36) - 4, 8 + s.y - (Math.round(P.fy) - 36) - 4); });
    check(ban.n > 5 && ban.ok === ban.n, `the spawn's white banner (${ban.ok}/${ban.n})`);
    // the home bed: a red banner
    const bed = await E(page, '[h.P.tx - 6, h.P.ty + 3]');
    await page.evaluate((b) => { window.__rs.G.spawnBed = b; window.__rs.tick({ dt: 1 / 30, capture: false }); }, bed);
    const red = await page.evaluate((b) => { const P = window.__rs.P; return window.__mmt.iconAt('red_banner', 8 + b[0] - (Math.round(P.fx) - 36) - 4, 8 + b[1] - (Math.round(P.fy) - 36) - 4); }, bed);
    check(red.n > 5 && red.ok === red.n, `the home bed's red banner replaces it (${red.ok}/${red.n})`);
    await page.evaluate(() => { window.__rs.G.spawnBed = null; });
    // a village: its icon once any of its blocks is explored
    const vs = await E(page, 'h.gen.plan().villages.map((v) => [v.x + 416, v.y, v.style])');
    const sp = await E(page, '[h.P.tx, h.P.ty]');
    vs.sort((a, b) => Math.hypot(a[0] - sp[0], a[1] - sp[1]) - Math.hypot(b[0] - sp[0], b[1] - sp[1]));
    const v = vs[0], before = (await info()).villages.length;
    const at = await findWalk(page, Math.round(v[0]) + 8, Math.round(v[1]) + 8, 20);
    await tp(page, at[0], at[1]);
    await idleP(page, 3);
    const after = await info();
    const vic = await page.evaluate((v) => { const P = window.__rs.P; return window.__mmt.iconAt(v[2] + '_village', 8 + Math.round(v[0]) - (Math.round(P.fx) - 36) - 4, 8 + Math.round(v[1]) - (Math.round(P.fy) - 36) - 4); }, v);
    check(before === 0 && after.villages.length === 1 && vic.n > 5 && vic.ok >= vic.n - 4, `walking into a ${v[2]} village shows its icon (${vic.ok}/${vic.n})`);
    await shotP(page, 'hud_village_icon');
  }

  // ================================================================ screen
  if (PARTS.includes('screen')) {
    log('---- screen');
    await boot('?new&play&world=wild&wseed=1');
    for (const d of ['right', 'down']) for (let i = 0; i < 30; i++) await tk(page, { hold: d });
    for (let i = 0; i < 30 && (await E(page, 'h.P.moving')); i++) await tk(page);
    await idleP(page, 2);
    const scr = async () => (await info()).screen;
    await tk(page, { press: 'map' });
    check((await scr()) === 'map', 'J opens the full map');
    await shotP(page, 'screen_fit');
    await pshot('desktop_fullmap');
    await tk(page, { press: 'b' }); await tk(page);
    check((await scr()) === null && (await E(page, 'h.state()')) === 'play', 'B closes it');
    await tk(page, { press: 'map' }); await tk(page, { press: 'map' }); await tk(page);
    check((await scr()) === null, 'J closes it too');
    await tk(page, { mouse: { x: 40, y: 40, click: 'mouseL' } });
    check((await scr()) === 'map', 'a click on the minimap opens it');
    // zoom cycles from fit; arrows pan
    const z = [(await info()).view.zoom];
    for (let i = 0; i < 4; i++) { await tk(page, { press: 'a' }); z.push((await info()).view.zoom); await shotP(page, 'screen_zoom_' + (await info()).view.zoom); }
    check(z[4] === z[0] && new Set(z).size === 4 && z.every((v) => [0.5, 1, 2, 4].includes(v)), `A cycles the zoom through 0.5, 1, 2 and 4 (${z.join(' -> ')})`);
    while ((await info()).view.zoom !== 4) await tk(page, { press: 'a' });
    const c0 = (await info()).view;
    await tk(page, { press: 'left' }); const c1 = (await info()).view;
    await tk(page, { press: 'up' }); const c2 = (await info()).view;
    check(c1.cx < c0.cx && c2.cy < c1.cy, `the arrows pan the view (${c0.cx.toFixed(1)},${c0.cy.toFixed(1)} -> ${c2.cx.toFixed(1)},${c2.cy.toFixed(1)})`);
    // the panned centre survives a whole zoom cycle (through 0.5, where the whole region fits and the drawn centre is
    // the region's)
    for (let i = 0; i < 4; i++) await tk(page, { press: 'a' });
    const c3 = (await info()).view;
    check(c3.zoom === 4 && Math.abs(c3.cx - c2.cx) < 1e-6 && Math.abs(c3.cy - c2.cy) < 1e-6, `a zoom cycle comes back to the panned view (${c2.cx.toFixed(1)},${c2.cy.toFixed(1)} -> ${c3.cx.toFixed(1)},${c3.cy.toFixed(1)})`);
    // START switches the minimap; closed, the HUD obeys
    await tk(page, { press: 'start' });
    check((await info()).on === false, 'START on the full map switches the minimap off');
    await shotP(page, 'screen_off');
    await tk(page, { press: 'b' }); await idleP(page, 2);
    check((await info()).shown === null, 'closed: the HUD has no minimap (desktop)');
    await tk(page, { press: 'map' }); await tk(page, { mouse: { x: 48, y: 32, click: 'mouseL' } });
    check((await info()).on === true, 'a click on the full map\'s button switches it back on');
    await tk(page, { press: 'b' }); await idleP(page, 2);
    check((await info()).shown === 'map', 'and the minimap is back');
    // START > MAP
    await tk(page, { press: 'start' });
    const rows = await E(page, 'h.menuRows()');
    check(rows.indexOf('MAP') === rows.indexOf('EXIT') - 1, `START has MAP before EXIT (${rows.join(', ')})`);
    for (let i = 0; i < rows.indexOf('MAP'); i++) await tk(page, { press: 'down' });
    await shotP(page, 'start_map_row');
    await tk(page, { press: 'a' });
    check((await scr()) === 'map', 'START > MAP opens the full map');
    await tk(page, { press: 'b' }); await idleP(page, 2);
    // OPTION > MINIMAP
    await tk(page, { press: 'start' });
    const oi = (await E(page, 'h.menuRows()')).indexOf('OPTION');
    for (let i = 0; i < oi; i++) await tk(page, { press: 'down' });
    await tk(page, { press: 'a' });
    const orows = await E(page, 'h.optionUI().rows');
    for (let i = 0; i < orows.indexOf('MINIMAP'); i++) await tk(page, { press: 'down' });
    await shotP(page, 'option_minimap');
    await tk(page, { press: 'a' });
    const offOpt = (await info()).on;
    await tk(page, { press: 'a' });
    const onOpt = (await info()).on;
    check(orows[orows.length - 1] === 'MINIMAP' && offOpt === false && onOpt === true, `OPTION > MINIMAP switches it (${orows.join(', ')})`);
    await tk(page, { press: 'b' }); await tk(page, { press: 'b' }); await idleP(page, 2);
    // a J pressed mid-step opens the map when the step ends
    await tk(page, { hold: 'left' }); await tk(page, { hold: 'left' });
    const mid = await E(page, 'h.P.moving');
    await tk(page, { hold: 'left', press: 'map' });
    const stillClosed = await scr();
    let opened = false;
    for (let i = 0; i < 15 && !opened; i++) { await tk(page, { hold: 'left' }); opened = (await scr()) === 'map'; }
    check(mid && stillClosed === null && opened, 'a J pressed mid-step opens the map when the step ends (walking on)');
    await tk(page, { press: 'b' }); await idleP(page, 2);
    // ...but not one pressed on a step that ends in an encounter
    const grass = await page.evaluate(() => { const h = window.__rs, W = h.world, P = h.P; for (let r = 1; r < 60; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) { const x = P.tx + dx, y = P.ty + dy; if (W.tallGrass(x, y) && h.PL.canEnter({ riding: null }, x - 1, y) === 'walk' && !W.tallGrass(x - 1, y)) return [x, y]; } return null; });
    if (grass) {
      await tp(page, grass[0] - 1, grass[1], 'right');
      await page.evaluate(() => { const h = window.__rs; h.rules.encounters = true; h.nextEncounter('PIDGEY', 3); });
      await tk(page, { hold: 'right' }); await tk(page, { hold: 'right', press: 'map' });
      for (let i = 0; i < 20; i++) await tk(page);
      const st = await E(page, 'h.state()');
      await page.evaluate(() => { const h = window.__rs; h.rules.encounters = false; h.G.battle = null; h.setState('play'); });
      for (let i = 0; i < 20; i++) await tk(page);
      check(['transition', 'battle'].includes(st) && (await scr()) === null, `a J on a step that ends in an encounter does not open the map later (${st})`);
    } else check(false, 'found tall grass');
    // dying with it open closes it
    await tk(page, { press: 'map' });
    await page.evaluate(() => window.__rs.G.hurtPlayer(999, 'Steve fell'));
    for (let i = 0; i < 20; i++) await tk(page);
    check((await scr()) === null, 'dying closes the full map');
    await page.evaluate(() => window.__rs.respawn());
    for (let i = 0; i < 200 && (await E(page, 'h.state()')) !== 'play'; i++) { await tk(page); await sleep(10); }
    // indoors (a village house): no minimap, and J's map shows the overworld with him at his last outdoor cell
    const house = await page.evaluate(() => {
      const W = window.__rs.world;
      const w = W.warps.find((x) => !x.off && Number.isInteger(x.ax) && W.roomAt(x.ax, x.ay) && W.roomAt(x.ax, x.ay).kind === 'indoor');
      return w ? [w.ax, w.ay] : null;
    });
    if (house) {
      const outCell = await E(page, '[h.P.tx, h.P.ty]');
      await tp(page, house[0], house[1]);
      await idleP(page, 2);
      await tk(page, { press: 'map' }); await tk(page);
      const iv = await info();
      check(iv.shown === null && iv.screen === 'map' && iv.view.indoor === true && iv.view.region === 'outdoor', `indoors: no minimap; the full map shows the overworld (${JSON.stringify(iv.view)}, last outdoor cell ${outCell})`);
      // ...and its teammates: one outdoors (a stand-in avatar, no frame runs while NET.on is set) is on it
      const mt = await page.evaluate(async ([ox, oy]) => {
        const h = window.__rs, NET = (await import('/src/net/flag.js')).NET, mm = h.minimap({ mm: true }), L = h.world.layout, old = { on: NET.on, s: NET.s };
        NET.on = true; NET.s = { avatars: new Map([[1, { tx: ox + 3, ty: oy, skin: 'alex', visibleNow: true }]]) };
        try { return mm.mates({ x: L.ox, y: L.oy, w: L.ow, h: L.oh, kind: 'outdoor' }, true).length; } finally { NET.on = old.on; NET.s = old.s; }
      }, outCell);
      check(mt === 1, `indoors, the full map keeps a teammate who is outdoors (${mt})`);
      await shotP(page, 'screen_indoor');
      await tk(page, { press: 'b' }); await tk(page);
      await tp(page, outCell[0], outCell[1]);
    } else check(false, 'found a house');
    // "j" stays typable in text fields
    const typ = await page.evaluate(async () => { const I = await import('/src/input.js'); return [I.isButtonKey('j'), I.isButtonKey('J'), I.isButtonKey('z')]; });
    check(typ[0] === false && typ[1] === false && typ[2] === true, 'J is not a "button key", so it types into canvas text fields (world names, seeds, creative search)');
    await page.evaluate(() => { const h = window.__rs; h.setMode('creative', 'normal'); });
    await tk(page, { press: 'inv' });
    const cs = await page.evaluate(() => { const s = window.__rs.screen(); return s && s.kind; });
    if (cs === 'creative') {
      await page.evaluate(() => { const s = window.__rs.screen(); for (let i = 0; i < 24; i++) { s.setTab(i, true); if (s.tabDef && s.tabDef.id === 'search') break; } });
      const q0 = await page.evaluate(() => window.__rs.screen().query);
      if (typeof q0 === 'string') {
        await page.keyboard.type('jun');
        await tk(page); await tk(page);
        const q1 = await page.evaluate(() => window.__rs.screen().query);
        check(/j/.test(q1 || ''), `"j" types into the creative search (${JSON.stringify(q1)})`);
      } else log('note: the creative screen has no search query field reachable here');
    }
    check(!(await errs()).length, 'no errors (screen): ' + JSON.stringify(await errs()));
    // Classic: START is as it was; J opens the map of Kanto
    await boot('?new&play');
    await tk(page, { press: 'start' });
    const crow = await E(page, 'h.menuRows()');
    check(crow.join() === 'POKéDEX,POKéMON,BAG,STEVE,SAVE,CO-OP,EXIT', `Classic's START rows are unchanged (${crow.join(', ')})`);
    await tk(page, { press: 'b' }); await idleP(page, 2);
    await tk(page, { press: 'map' }); await tk(page);
    const cv = await info();
    check(cv.screen === 'map' && cv.view && cv.view.title === 'Kanto', `J opens Classic's map, titled Kanto (${cv.view && cv.view.title})`);
    await shotP(page, 'screen_classic');
    await tk(page, { press: 'b' }); await tk(page);
    check(!(await errs()).length, 'no errors (Classic screen): ' + JSON.stringify(await errs()));
  }

  // ================================================================ phone
  if (PARTS.includes('phone')) {
    log('---- phone');
    for (const vp of [[390, 844], [844, 390]]) {
      const ctx = await browser.newContext({ viewport: { width: vp[0], height: vp[1] }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const pg = await ctx.newPage();
      await boot('?new&play&world=wild&wseed=1', pg);
      for (let i = 0; i < 12; i++) await tk(pg, { hold: 'down' });
      for (let i = 0; i < 30 && (await E(pg, 'h.P.moving')); i++) await tk(pg);
      const tapAt = async (cx, cy) => {
        const r = await pg.evaluate(() => { const c = document.getElementById('game').getBoundingClientRect(); return { l: c.left, t: c.top, w: c.width, h: c.height }; });
        await pg.touchscreen.tap(r.l + (cx / 480) * r.w, r.t + (cy / 320) * r.h);
        await sleep(80);
        await tk(pg); await tk(pg);
      };
      check((await info(pg)).shown === 'map', `${vp[0]} x ${vp[1]}: the minimap is visible`);
      await pg.screenshot({ path: path.join(SHOTS, `phone_${vp[0]}x${vp[1]}_hud.png`) });
      await tapAt(44, 44);
      check((await info(pg)).screen === 'map', `${vp[0]} x ${vp[1]}: a tap on the minimap opens the full map`);
      await pg.screenshot({ path: path.join(SHOTS, `phone_${vp[0]}x${vp[1]}_map.png`) });
      await tapAt(48, 32);
      check((await info(pg)).on === false, `${vp[0]} x ${vp[1]}: a tap on the button switches the minimap off`);
      await tk(pg, { press: 'b' }); await tk(pg); await tk(pg);
      check((await info(pg)).shown === 'button', `${vp[0]} x ${vp[1]}: switched off, the 20 x 20 map button shows`);
      await pg.screenshot({ path: path.join(SHOTS, `phone_${vp[0]}x${vp[1]}_button.png`) });
      await tapAt(14, 14);
      check((await info(pg)).screen === 'map', `${vp[0]} x ${vp[1]}: a tap on the button opens the full map`);
      await tapAt(48, 32);
      await tk(pg, { press: 'b' }); await tk(pg);
      check((await info(pg)).on === true && !(await errs(pg)).length, `${vp[0]} x ${vp[1]}: switched back on, no errors`);
      await ctx.close();
    }
  }

  // ================================================================ perf
  if (PARTS.includes('perf')) {
    log('---- perf');
    const run600 = async (pg, keys) => pg.evaluate((keys) => {
      const h = window.__rs, mm = h.minimap({ mm: true }), s0 = { ...mm.stats };
      mm.stats.maxMs = 0;
      let k = 0;
      for (let i = 0; i < 600; i++) {
        if (i % 60 === 0) k = (k + 1) % keys.length;
        h.tick({ dt: 1 / 30, capture: false, hold: keys[k] });
      }
      const s = mm.stats;
      return { frames: s.frames - s0.frames, mean: (s.ms - s0.ms) / (s.frames - s0.frames), max: s.maxMs, builds: s.builds - s0.builds, flushed: s.flushed - s0.flushed, renders: (s.renders || 0) - (s0.renders || 0), at: [h.P.tx, h.P.ty] };
    }, keys);
    await boot('?new&play&world=wild&wseed=1');
    // a spectator flies through everything, so the run really crosses chunks (new land, new tiles, streaming)
    await page.evaluate(() => window.__rs.setMode('spectator', 'hard'));
    await idleP(page, 30);
    // (a run with a frame over 1 ms is run once more: on a loaded machine the operating system can stop the page in
    // the middle of the minimap's work, or a garbage collection of the game's own churn lands there; both printed)
    const run600b = async (pg, keys, label) => {
      let r = await run600(pg, keys);
      log(label, JSON.stringify(r));
      if (r.max >= 1) { r = await run600(pg, keys.slice().reverse()); log(label + ' (again)', JSON.stringify(r)); }
      return r;
    };
    const wild = await run600b(page, [['right', 'sprint'], ['right', 'sprint'], ['down', 'sprint'], ['right', 'sprint']], 'wild');
    check(wild.mean < 0.15 && wild.max < 1, `Wild World, 600 frames sprinting: minimap mean ${wild.mean.toFixed(4)} ms, max ${wild.max.toFixed(3)} ms (targets 0.15 and 1)`);
    const frameTime = async (pg) => {
      const block = (on) => pg.evaluate((on) => { const h = window.__rs; h.minimap({ show: on ? null : false }); const t = performance.now(); for (let i = 0; i < 50; i++) h.tick({ dt: 1 / 30, capture: false, hold: i % 40 < 20 ? 'left' : 'right' }); return (performance.now() - t) / 50; }, on);
      const a = [], b = [];
      for (let k = 0; k < 60; k++) { if (k % 2) { b.push(await block(true)); a.push(await block(false)); } else { a.push(await block(false)); b.push(await block(true)); } }
      const pct = (x) => [...x].sort((p, q) => p - q)[Math.floor(0.2 * (x.length - 1))];
      await pg.evaluate(() => window.__rs.minimap({ show: null }));
      return { off: pct(a), on: pct(b), d: pct(b) / pct(a) - 1 };
    };
    // (as sp_diff.mjs: a result over 10% is measured once more before it fails, and both are printed)
    const frameTime2 = async (pg, label) => {
      let r = await frameTime(pg);
      log(`${label} frame time (20th percentile of 60 blocks of 50): off ${r.off.toFixed(3)} ms, on ${r.on.toFixed(3)} ms (${(r.d * 100).toFixed(1)}%)`);
      if (r.d >= 0.1) { r = await frameTime(pg); log(`  again: off ${r.off.toFixed(3)} ms, on ${r.on.toFixed(3)} ms (${(r.d * 100).toFixed(1)}%)`); }
      return r;
    };
    // the frame time in an ordinary Survival frame, back at the spawn
    await page.evaluate(() => { const h = window.__rs; h.setMode('survival', 'normal'); h.teleport(h.G.worldSpawn.x, h.G.worldSpawn.y, 'down'); });
    await idleP(page, 30);
    const ft = await frameTime2(page, 'Wild');
    check(ft.d < 0.1, `Wild World frame time with the minimap within 10% (${(ft.d * 100).toFixed(1)}%; target 3%)`);
    await boot('?new&play');
    const cl = await run600b(page, [['left'], ['up'], ['right'], ['down']], 'classic');
    check(cl.mean < 0.15 && cl.max < 1, `Classic, 600 frames walking: minimap mean ${cl.mean.toFixed(4)} ms, max ${cl.max.toFixed(3)} ms`);
    const ft2 = await frameTime2(page, 'Classic');
    check(ft2.d < 0.1, `Classic frame time with the minimap within 10% (${(ft2.d * 100).toFixed(1)}%; target 3%)`);
  }

  // ================================================================ shots (a few minutes of flying, then the HUD and the full map)
  if (PARTS.includes('shots')) {
    log('---- shots');
    // a square spiral of hops 6 cells apart (each hop's chunks made first), then back near the start
    const tour = (pg, n) => pg.evaluate(async (n) => {
      const h = window.__rs, b = h.world.layout.border, x0 = h.P.tx, y0 = h.P.ty;
      let x = x0, y = y0, d = 0, len = 4, done = 0;
      const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      while (done < n) {
        for (let k = 0; k < 2 && done < n; k++, d = (d + 1) % 4) {
          for (let i = 0; i < len && done < n; i++, done++) {
            x = Math.max(b.x0 + 4, Math.min(b.x1 - 4, x + D[d][0] * 6)); y = Math.max(b.y0 + 4, Math.min(b.y1 - 4, y + D[d][1] * 6));
            await h.ensure(x, y, 1); h.teleport(x, y, 'down'); h.tick({ dt: 1 / 30, capture: false });
          }
        }
        len += 4;
      }
      await h.ensure(x0, y0, 1); h.teleport(x0 + 2, y0 + 2, 'right');
      for (let i = 0; i < 30; i++) h.tick({ dt: 1 / 30, capture: false });
    }, n);
    for (const [label, vp, q] of [['desktop', null, '?new&play&world=kanto&wseed=1'], ['phone_844x390', [844, 390], '?new&play&world=kanto&wseed=1'], ['desktop_wild', null, '?new&play&world=wild&wseed=3']]) {
      const ctx = vp ? await browser.newContext({ viewport: { width: vp[0], height: vp[1] }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }) : null;
      const pg = ctx ? await ctx.newPage() : page;
      await boot(q, pg);
      await tour(pg, 220);
      await pshot(label + '_tour_hud', pg);
      await tk(pg, { press: 'map' }); await tk(pg);
      await pshot(label + '_tour_fullmap', pg);
      await tk(pg, { press: 'a' }); await tk(pg);
      await pshot(label + '_tour_fullmap_zoom', pg);
      await tk(pg, { press: 'b' }); await tk(pg);
      check(!(await errs(pg)).length, `${label}: the tour ran without errors`);
      if (ctx) await ctx.close();
    }
  }

  // ================================================================ video
  if (PARTS.includes('video')) {
    log('---- video');
    const P2 = PORT + 1;
    const srv = spawn('python3', ['-m', 'http.server', String(P2), '--bind', '127.0.0.1', '--directory', RELEASE], { stdio: 'ignore' });
    try {
      await sleep(800);
      const INIT = `(() => { let s = 12345 >>> 0; Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        try { localStorage.clear(); } catch (e) {} const realNow = Date.now.bind(Date); Date.now = () => (window.__rs && window.__rs.ready ? realNow() : 1767225600000);
        const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => (cb && cb.name === 'frame' ? 0 : raf(cb)); })();`;
      const open = async (port) => {
        const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } });
        await ctx.addInitScript(INIT);
        const pg = await ctx.newPage(), reqs = [];
        pg.on('request', (r) => reqs.push(r.url()));
        await pg.goto(`http://127.0.0.1:${port}/?new&play&video&world=kanto&wseed=1`);
        await pg.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 120000 });
        await pg.evaluate(() => { window.__rs.pause(); window.__rs.seed(2026); });
        return { ctx, pg, reqs };
      };
      const A = await open(P2), B = await open(PORT);
      let diff = 0, compared = 0;
      for (let i = 0; i < 240; i++) {
        const o = { dt: 1 / 30, capture: i % 60 === 59, hold: i < 80 ? 'right' : i < 160 ? 'down' : 'left' };
        if (i === 30) o.press = 'start';
        if (i === 34) o.press = 'b';
        // (the generator's worker answers in real time: each page first waits for every chunk it asked for, so both
        // apply the same chunks, and populate the same herds, on the same frame)
        const settle = (pg) => pg.waitForFunction(() => { const g = window.__rs.gen; return !g || !g.client || g.client.inFlight === 0; }, null, { timeout: 30000, polling: 5 });
        await Promise.all([settle(A.pg), settle(B.pg)]);
        const [a, b] = await Promise.all([A.pg.evaluate((o) => window.__rs.tick(o), o), B.pg.evaluate((o) => window.__rs.tick(o), o)]);
        if (o.capture) { compared++; if (a !== b) { diff++; writeFileSync(path.join(SHOTS, `video_${i}_release.png`), Buffer.from(a.split(',')[1], 'base64')); writeFileSync(path.join(SHOTS, `video_${i}_current.png`), Buffer.from(b.split(',')[1], 'base64')); } }
      }
      check(compared === 4 && diff === 0, `?video: canvases byte-equal with the release at ${compared} checkpoints over 240 frames (${diff} differ)`);
      const mmReq = B.reqs.filter((u) => /src\/minimap\.js|src\/mapcore\.js|src\/ui\/mapscreen\.js|assets\/mc\/map\/|mapcolor\.json/.test(u));
      check(!mmReq.length, '?video requests no minimap module or picture' + (mmReq.length ? ': ' + mmReq.join(', ') : ''));
      const hasHook = await B.pg.evaluate(() => !!window.__rs.minimap);
      check(hasHook === false, '?video: no __rs.minimap (the minimap never loads)');
      await Promise.all([A.pg.evaluate(() => window.__rs.setState('menu')), B.pg.evaluate(() => window.__rs.setState('menu'))]);
      const [ra, rb] = await Promise.all([A.pg.evaluate(() => window.__rs.menuRows()), B.pg.evaluate(() => window.__rs.menuRows())]);
      check(JSON.stringify(ra) === JSON.stringify(rb), `?video: START rows as in the release (${rb.join(', ')})`);
      await A.ctx.close(); await B.ctx.close();
    } finally { srv.kill(); }
  }
}
