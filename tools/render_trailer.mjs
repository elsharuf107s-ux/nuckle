#!/usr/bin/env node
// THE UPDATE TRAILER: the Nether and The End, cut for X, with captions in the game's Minecraft font. Rendered the
// way tools/render_showcase.mjs renders: headless Chrome drives the game one frame at a time through
// window.__rs.tick(), Math.random is seeded before the page loads (and reseeded at the start of every scene, so a
// scene plays the same whether it is rendered alone or in the whole film), every game sound is recorded against
// game time and rendered offline in the page, and ffmpeg assembles the MP4. Everything on screen is the game
// running; the test hooks only set a scene up (where Steve stands, what he carries), in frames that are not filmed.
//
//   node tools/render_trailer.mjs [out.mp4]          the whole trailer (out/pokemon-redstone-update-trailer.mp4)
//   SEG=lava,obsidian node tools/render_trailer.mjs   only some scenes (each one sets up its own state)
//   PREVIEW=1 ...                                    also writes a contact sheet of every 10th frame
//   SHEET=path STEP=15 ...                           the contact sheet's path and frame step
//   NOVIDEO=1 ...                                    frames, sheet and audio only, no MP4
//
// The music is laid in afterwards from the game's own tracks (assets/music), one bed per scene with short
// crossfades at the cuts, because the game itself starts each track from the top with no fade. Where a scene
// follows the game's own music (the battles, the catch fanfare), the bed is taken from the game's recorded music
// events, so it lands exactly where the game played it. The game's sound effects come from the recording.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'pokemon-redstone-update-trailer.mp4'));
// (WORK_DIR=... renders a test cut somewhere else, leaving the trailer's own work dir alone)
const WORK = process.env.WORK_DIR ? path.resolve(process.env.WORK_DIR) : path.join(ROOT, 'out', 'work-trailer');
const FRAMES = path.join(WORK, 'frames');
const PORT = 5306;
const FPS = 30;
const ONLY = process.env.SEG ? process.env.SEG.split(',') : null;

const pwDir = process.env.PLAYWRIGHT_DIR || path.resolve(ROOT, 'node_modules', 'playwright');
const { chromium } = createRequire(import.meta.url)(pwDir);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(path.dirname(OUT), { recursive: true });

const server = spawn('python3', [path.join(ROOT, 'serve.py'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => server.kill());   // a scene that throws still frees the port
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
await page.addInitScript(() => {
  let s = 20261005 >>> 0;
  Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.__reseed = (v) => { s = v >>> 0; };
  // the game's own frame loop never runs: every frame is a tick from here, so nothing on screen depends on how long
  // the page took to load (the title's timer, the clock the lava and the crystals animate on)
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => (window.__rafHold ? 0 : raf(cb));
  window.__rafHold = true;
});
await page.goto(`http://127.0.0.1:${PORT}/?new&video`);
await page.waitForFunction(() => window.__rs && window.__rs.ready, null, { timeout: 90000, polling: 200 });   // (polled: the page's rAF is held)
// the game's own tick, kept before startAudio() wraps it with the clock that times every recorded sound; the audio
// module itself (the same instance the game uses) so set-up sounds can be taken back out of the recording
await page.evaluate(async () => {
  const h = window.__rs; window.__rawTick = h.tick; h.pause(); h.G.clock = 0; h.seed(2026); h.startAudio();
  window.__AU = await import('/src/audio.js');
  window.__RNG = await import('/src/rng.js');
  h.rules.encounters = false; h.rules.warps = true; h.rules.wild = false; h.rules.mobs = false; h.G.money = 3000;
  localStorage.removeItem('poke-redstone-music');
});

// ---------------------------------------------------------------- frame capture
let n = 0;
let skip = 1;            // time-lapse: capture one frame in `skip`
let skipCount = 0;
let offCamera = false;   // set-up moves: played, not filmed, and their sounds taken back out
async function tick(opts = {}) {
  const capture = !offCamera && (skipCount++ % skip) === 0;
  const url = await page.evaluate((o) => { window.__vt = o.vt; return o.capture ? window.__rs.tick(o) : window.__rawTick(o); }, { dt: 1 / FPS, capture, vt: n, ...opts });
  if (url) writeFileSync(path.join(FRAMES, String(n++).padStart(5, '0') + '.png'), Buffer.from(url.split(',')[1], 'base64'));
}
async function unfilmed(fn) {
  offCamera = true;
  const k = await page.evaluate(() => window.__AU.recordedEvents().length);
  try { await fn(); } finally {
    offCamera = false;
    // whatever the set-up made a sound with (a teleport, a placed block) is not heard at the cut
    // (the music the game started or stopped meanwhile is kept: it lands at the cut, where the audio clock stood)
    await page.evaluate((k) => { const ev = window.__AU.recordedEvents(); const keep = ev.slice(k).filter((e) => ['music', 'musicStop', 'fanfare', 'ambience', 'ambienceStop'].includes(e.type)); ev.splice(k, ev.length - k, ...keep); }, k);
  }
}
const idle = async (frames) => { for (let i = 0; i < frames; i++) await tick(); };
const press = async (key, after = 6) => { await tick({ press: key }); await idle(after - 1); };
const holdFor = async (key, frames) => { for (let i = 0; i < frames; i++) await tick({ hold: key, press: i === 0 ? key : undefined }); };
const R = (expr) => page.evaluate(new Function('return (() => { const h = window.__rs, G = h.G, P = h.P, W = h.world; return ' + expr + '; })()'));
const run = (fn, arg) => page.evaluate(fn, arg);
async function timelapse(k, fn) { const s = skip; skip = k; skipCount = 0; await fn(); skip = s; skipCount = 0; }
// idle until the scene (started at frame f0) has run `frames` frames
async function holdTo(f0, frames) { while (n < f0 + frames) await tick(); }

// Wait on the game, pressing A through messages once each has been on screen for `read` frames.
// hold: a message that moves on by itself is cut once it has been read for that many frames (the rest of its
// on-screen wait is played off camera: the text box is still, so the cut does not show)
async function until(pred, { max = 3000, read = 30, pressMsgs = true, onTick = null, hold = null } = {}) {
  let shownFor = 0, heldFor = 0;
  for (let i = 0; i < max; i++) {
    const st = await page.evaluate((p) => {
      const h = window.__rs, b = h.battle();
      let msgDone = false, needPress = false, text = null;
      if (h.state() === 'battle' && b && b.cur && b.cur.type === 'msg') {
        msgDone = b.cur.shown >= b.cur.pages[b.cur.page].join('').length; needPress = b.cur.press || b.cur.page < b.cur.pages.length - 1; text = b.cur.text;
      } else if (h.msg()) {
        const m = h.msg(); msgDone = m.shown >= m.pages[m.page].join('').length; needPress = !m.ask;
      }
      return { done: new Function('h', 'b', 'G', 'P', 'W', 'return ' + p)(h, b, h.G, h.P, h.world), msgDone, needPress, text };
    }, pred);
    if (st.done) return i;
    if (hold != null && st.text && st.msgDone && !st.needPress) {
      if (++heldFor >= hold) {
        heldFor = 0;
        await unfilmed(async () => { for (let g = 0; g < 120 && (await R(`h.battle() && h.battle().cur && h.battle().cur.type === 'msg' && h.battle().cur.text === ${JSON.stringify(st.text)}`)); g++) await tick(); });
        continue;
      }
    } else heldFor = 0;
    if (pressMsgs && st.msgDone && st.needPress) { if (++shownFor >= read) { shownFor = 0; await tick({ press: 'a' }); if (onTick) await onTick(); continue; } }
    else shownFor = 0;
    await tick();
    if (onTick) await onTick();
  }
  throw new Error('timed out waiting for: ' + pred);
}
const battleIdle = (ui) => `h.state() === 'battle' && b && !b.cur && !b.q.length && b.ui === '${ui}'`;

// ---------------------------------------------------------------- moving Steve
async function walkTo(tx, ty, { run: sprint = false, max = 2000 } = {}) {
  if (await page.evaluate(([x, y]) => window.__rs.world.solid(x, y), [tx, ty])) return true;
  let detour = false;
  for (let g = 0; g < max; g++) {
    const [x, y, moving, st, dir, routed] = await page.evaluate(([tx, ty, detour]) => {
      const h = window.__rs, P = h.P, W = h.world;
      let dir = P.tx < tx ? 'right' : P.tx > tx ? 'left' : P.ty > ty ? 'up' : 'down';
      const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const mob = new Set(h.G.ents.filter((e) => e.type === 'mob' && !e.dying).map((e) => e.tx + ',' + e.ty));
      const blocked = (x, y) => W.solid(x, y) || mob.has(x + ',' + y) || (W.isEndVoid && W.isEndVoid(x, y));
      const open = (x, y) => !blocked(x, y) && !W.isWater(x, y) && !W.jumpDir(x, y) && !W.pcDoor(x, y);
      let routed = false;
      if ((P.tx !== tx || P.ty !== ty) && (detour || blocked(P.tx + D[dir][0], P.ty + D[dir][1]))) {
        const key = (x, y) => x + ',' + y, from = new Map([[key(tx, ty), null]]), q = [[tx, ty]];
        while (q.length && !from.has(key(P.tx, P.ty)) && from.size < 4000) {
          const [cx, cy] = q.shift();
          for (const [d, [dx, dy]] of Object.entries(D)) {
            const nx = cx + dx, ny = cy + dy, k = key(nx, ny);
            if (from.has(k) || (!open(nx, ny) && !(nx === P.tx && ny === P.ty))) continue;
            from.set(k, { up: 'down', down: 'up', left: 'right', right: 'left' }[d]); q.push([nx, ny]);
          }
        }
        if (from.get(key(P.tx, P.ty))) { dir = from.get(key(P.tx, P.ty)); routed = true; }
      }
      return [P.tx, P.ty, P.moving, h.state(), dir, routed];
    }, [tx, ty, detour]);
    if (routed) detour = true;
    if (st !== 'play') return false;
    if (x === tx && y === ty) { if (!moving) return true; await tick(); continue; }
    await tick({ hold: sprint ? [dir, 'sprint'] : dir });
  }
  throw new Error(`walkTo ${tx},${ty} stuck at ${await R('[P.tx, P.ty]')}`);
}
async function walkPath(points, opts) { for (const [x, y] of points) await walkTo(x, y, opts); }
async function face(dir) {
  const cur = await R('P.dir');
  if (cur !== dir) { await tick({ press: dir }); await idle(4); }
}
async function slot(k) { await press('slot' + (k + 1), 6); }
async function selectItem(id) {
  const i = await R(`G.inv.slots.findIndex((s) => s && s.id === '${id}')`);
  if (i < 0) throw new Error('no ' + id);
  if (i === (await R('G.inv.sel'))) return;
  if (i >= 9) { await run((a) => { const inv = window.__rs.G.inv; const t = inv.slots[a.i]; inv.slots[a.i] = inv.slots[8]; inv.slots[8] = t; }, { i }); return slot(8); }
  return slot(i);
}
// Hold Z on whatever is in front until it breaks.
async function mine(maxFrames = 400) {
  for (let i = 0; i < maxFrames; i++) {
    await tick({ hold: 'a', press: i === 0 ? 'a' : undefined });
    const mining = await R('!!P.mining');
    if (i > 2 && !mining) { await idle(2); return true; }
  }
  return false;
}
async function use(after = 8) { await press('b', after); }
async function place(dir, id, after = 6) { await face(dir); if (id) await selectItem(id); await use(after); }

// ---------------------------------------------------------------- container screens, with the slot cursor
async function screenSlot(kind, idx) {
  return run((a) => { const s = window.__rs.screen(); return s.slots.findIndex((q) => q.kind === a.kind && (a.idx == null || q.idx === a.idx)); }, { kind, idx });
}
async function cursorTo(kind, idx, gap = 3) {
  const target = await screenSlot(kind, idx);
  if (target < 0) throw new Error('no slot ' + kind + idx);
  for (let g = 0; g < 40; g++) {
    const st = await run((t) => { const s = window.__rs.screen(); return { sel: s.sel, dir: s.routeTo(t) }; }, target);
    if (st.sel === target) return;
    if (!st.dir) break;
    await press(st.dir, gap);
  }
  throw new Error('cursor stuck');
}
const invSlotOf = (id) => R(`G.inv.slots.findIndex((s) => s && s.id === '${id}')`);
async function leftClick(after = 5) { await press('a', after); }
async function shiftClick(after = 7) { await tick({ press: 'a', hold: 'sprint' }); await idle(after - 1); }
async function pickUp(id) { await cursorTo('inv', await invSlotOf(id)); await leftClick(); }
async function takeResult() { await cursorTo('result'); await shiftClick(); }

// ---------------------------------------------------------------- captions, the end card
// A caption is drawn by the game's own overlay hook (G.overlay) in its Minecraft font, scale 3 on the 480 x 320
// canvas (a 72 px cap height in the 1440 x 960 film, for phones), with a dark rim and drop shadow. It fades in and
// out over 7 frames. pos: 'low' sits over the lower middle of the view, its last line ending clear of the hotbar's
// item name, the hearts and the hotbar; 'top' at the very top (battles, where the text box fills the bottom); a
// number is the text's top edge; {y, cx} a top edge and a centre. A caption too wide for one line takes a \n.
const CAPS = [];
const CAP_SCALE = 3, CAP_LH = 30;
// With no `sec` it stays up until the scene ends, when it fades out over the scene's last frames (endCaptions).
async function caption(text, sec, pos = 'low', delay = 4) {
  if (/\u2014/.test(text)) throw new Error('no em dashes in captions');
  const c = { text, f0: n + delay, f1: sec ? n + delay + Math.round(sec * FPS) : 1e9, pos };
  CAPS.push(c);
  await run((c) => { window.__caps.push(c); }, c);
}
// the open captions start fading out now, over `frames` frames (the film runs on)
async function closeCaptions(frames = 8) {
  for (const c of CAPS) if (c.f1 > n + frames) c.f1 = n + frames;
  await run(([f1]) => { for (const c of window.__caps) if (c.f1 > f1) c.f1 = f1; }, [n + frames]);
}
async function endCaptions(frames = 8) {
  const open = CAPS.filter((c) => c.f1 > n + frames);
  if (!open.length) return;
  await closeCaptions(frames);
  await idle(frames);
}
await run(([S, LH]) => {
  window.__caps = [];
  window.__card = null;
  window.__rs.setOverlay((ctx, U) => {
    const vt = window.__vt || 0;
    for (const c of window.__caps) {
      if (vt < c.f0 || vt >= c.f1) continue;
      const a = Math.min(1, (vt - c.f0 + 1) / 7, (c.f1 - vt) / 7);
      const lines = c.text.split('\n');
      const y0 = typeof c.pos === 'object' ? c.pos.y : c.pos === 'low' ? 238 - 8 * S - (lines.length - 1) * LH : c.pos === 'top' ? 5 : c.pos;
      const cx = typeof c.pos === 'object' && c.pos.cx != null ? c.pos.cx : U.HW / 2;
      ctx.save(); ctx.globalAlpha = Math.max(0, a);
      lines.forEach((line, i) => {
        const w = U.mcWidth(line, S), x = Math.round(cx - w / 2), y = y0 + i * LH;
        // a soft dark shadow: a one-pixel rim all round, then the drop shadow, then the text
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) U.mcText(ctx, line, x + dx, y + dy, '#140c10', false, S);
        U.mcText(ctx, line, x + S, y + S, '#140c10', false, S);
        U.mcText(ctx, line, x + S + 1, y + S + 1, 'rgba(20,12,16,0.5)', false, S);
        U.mcText(ctx, line, x, y, '#ffffff', false, S);
      });
      ctx.restore();
    }
    const card = window.__card;
    if (card) {
      const t = (vt - card.f0) / 30, a = Math.max(0, Math.min(1, t / 0.6));
      ctx.save();
      const g = ctx.createLinearGradient(0, 0, 0, U.HH); g.addColorStop(0, '#000000'); g.addColorStop(0.6, '#140404'); g.addColorStop(1, '#3a0808');
      ctx.globalAlpha = a; ctx.fillStyle = g; ctx.fillRect(0, 0, U.HW, U.HH);
      ctx.globalAlpha = a;
      ctx.drawImage(U.A.img.titleLogo, 64, 18, 352, 118);
      const r = 'REDSTONE', v = 'VERSION';
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]]) U.mcText(ctx, r, 152 + dx, 140 + dy, '#3a0000', false, 3);
      U.mcText(ctx, r, 152, 140, '#ff3020', false, 3);
      U.mcText(ctx, v, 204, 170, '#f0f0f0', true, 2);
      const lines = [['Build it yourself from the code:', '#ffffff', 206], ['github.com/Mozetech/pokemon-redstone', '#ffff55', 232]];
      const b = Math.max(0, Math.min(1, (t - 0.5) / 0.5));
      ctx.globalAlpha = a * b;
      for (const [s, col, y] of lines) U.mcText(ctx, s, Math.round(U.HW / 2 - U.mcWidth(s, 2) / 2), y, col, true, 2);
      const f = 'Unofficial fan project. Not affiliated with Nintendo, Game Freak or Mojang.';
      U.mcText(ctx, f, Math.round(U.HW / 2 - U.mcWidth(f) / 2), 292, '#b09090', true, 1);
      ctx.restore();
    }
  });
}, [CAP_SCALE, CAP_LH]);

// ---------------------------------------------------------------- music beds (laid in by ffmpeg afterwards)
// bed(name, {off, gain}) from now on: a game track from `off` seconds in; bed(null) is silence; bed('@game')
// follows the game's own music events (battles, fanfares) until the next bed. amb(name) is the Nether's ambience
// loop under the music.
const BEDS = [], AMBS = [];
// (a bed asking for the track already playing lets it run on: no restart at the cut)
const bed = (name, o = {}) => (BEDS.length && BEDS[BEDS.length - 1].name === name && name && name !== '@game') ? null : BEDS.push({ t: n / FPS, name, off: o.off || 0, gain: o.gain ?? 1, fadeIn: o.fadeIn ?? 0.3 });
const amb = (name, gain = 1) => AMBS.push({ t: n / FPS, name, gain });
// the smash cut in the cold open: a slot of frames filled afterwards with frames (and their sounds) from the
// legendary battle; FREEZE: from here on the '@game' bed stops following the game's music (the catch fanfare plays on
// over the egg); CARD_T: the end card is up and the town's sounds behind it are left out
let SLOT = null, SLOT_SRC = null, FREEZE = null, CARD_T = null;
// stretches where the game's sounds are taken down (t0, t1 in seconds, gain): the blows on the perched dragon stack
// up into the loudest stretch of the film
const SFX_TRIM = [];

// ---------------------------------------------------------------- scenes
const ADV_ALL = ['minecraft', 'stone_age', 'upgrade', 'hardware', 'iron_pick', 'diamonds', 'monster_hunter', 'sweet_dreams', 'seedy', 'fishy', 'suit_up',
  'cover_me', 'take_aim', 'craft_ball', 'catch', 'nether', 'hot_stuff', 'return_to_sender', 'into_fire', 'hidden_depths', 'cover_debris', 'eye_spy', 'end_q',
  'free_end', 'next_gen', 'end_again', 'dragon_tamer'];
const DIAMOND = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'];
const NETHERITE = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'];
// Every scene starts the same way, whatever ran before it: the same random numbers, the world's transient things
// cleared (hostile mobs, fireballs, arrows, dropped items, orbs), Steve's health, gear, time of day and the
// advancements he has (all but the ones this scene earns on screen), then Steve where the scene starts.
async function scene(o) {
  await run((o) => {
    const h = window.__rs, G = h.G, P = h.P;
    window.__reseed(o.seed); h.seed(o.seed);
    if (h.state() !== 'play') h.setState('play');
    G.ents = G.ents.filter((e) => !['fireball', 'arrow', 'item', 'xp', 'wild', 'tnt'].includes(e.type) && !(e.type === 'mob' && !(e.persistent && ['cow', 'pig', 'sheep', 'chicken'].includes(e.kind))));
    h.END.resetTransient();
    G.advancements = new Set(o.adv.filter((k) => !(o.toasts || []).includes(k)));
    h.toasts.length = 0;
    h.rules.mobs = !!o.mobs; h.rules.wild = false; h.rules.encounters = false;
    if (o.time != null) h.setTime(o.time);
    G.inv.slots.fill(null);
    (o.inv || []).forEach((s, i) => { if (s) G.inv.slots[i] = { id: s[0], n: s[1] || 1 }; });
    G.inv.armor = (o.armor || [null, null, null, null]).map((id) => (id ? { id, n: 1 } : null));
    G.inv.sel = o.sel || 0;
    Object.assign(P, { health: 20, food: 20, sat: 5, fireT: 0, dead: false, invuln: 0, using: null, mining: null, riding: null, sprinting: false, level: o.level ?? 30, absorb: 0, xpProgress: 0.35 });
    G.shake = 0; G.camFocus = null; G.nausea = 0; G.portalT = 0; G.endFade = 0; G.videoFade = 0;
    G.heldName = null; G.actionBar = null;
    h.teleport(o.at[0], o.at[1], o.at[2] || 'down');
  }, { adv: ADV_ALL, ...o });
}
const segments = [];
const seg = (name, fn) => segments.push({ name, fn });

// ================================================================ COLD OPEN: the dragon swoops the island
seg('cold', async () => {
  await unfilmed(async () => {
    await run(() => { window.__rs.startGame(); });
    await scene({ seed: 101, at: [57, 1004, 'up'], inv: [['netherite_sword'], ['bow'], ['arrow', 64]], armor: NETHERITE });
    await run(() => { window.__rs.enterEnd(); window.__rs.teleport(57, 1004, 'up'); });
    // wait (unfilmed) for the dragon to come round at Steve, and half a second more, so the first frame has it in
    await until(`h.DR.live() && h.DR.live().phase === 'approach' && Math.hypot(h.DR.live().x - P.fx, h.DR.live().y - P.fy) < 13`, { max: 1800, pressMsgs: false });
    await idle(15);
  });
  bed('end_boss', { off: 95.5, fadeIn: 0.05 });
  await until(`h.DR.state().fireballs === 0 && h.DR.live() && h.DR.live().phase === 'away' && h.DR.live().t > 0.5`, { max: 200, pressMsgs: false });
  await idle(20);
  // the smash cut: these frames are replaced afterwards by the legendary battle's "Wild ENDER DRAGON appeared!"
  SLOT = { f0: n, len: 27 };
  await idle(27);
});

// ================================================================ the title (cut before PRESS START comes up)
seg('title', async () => {
  await unfilmed(async () => { await scene({ seed: 102, at: [66, 268, 'down'] }); await run(() => window.__rs.setState('title')); });
  // (title.ogg opens with 0.4 s of silence at 1.1 s: started past it)
  bed('title', { off: 1.53, fadeIn: 0.03 });
  // (the game's PRESS START blinks from 1.4 s: the cut comes at 2.5 s, in the gap after its first blink)
  const f0 = n;
  await idle(12);
  await caption('The Nether and\nThe End are here', 2.0, { y: 188, cx: 142 }, 0);
  await holdTo(f0, 75);
});

// ================================================================ THE NETHER
// Victory Road 3F: the pool deep in the cave
const POOL = [[22, 593], [23, 593], [24, 593], [22, 594], [23, 594], [24, 594], [22, 595], [23, 595], [24, 595]];
seg('lava', async () => {
  await unfilmed(async () => {
    // the water bucket already in hand (its name popup long gone)
    await scene({ seed: 201, at: [21, 596, 'right'], inv: [['diamond_pickaxe'], ['water_bucket'], ['diamond_sword'], ['flint_and_steel'], ['bucket']], sel: 1, armor: DIAMOND });
    await run((pool) => { const W = window.__rs.world; for (const [x, y] of pool) if (!W.block(x, y)) W.setBlock(x, y, { id: 'lava' }); }, POOL);
    await idle(12);
  });
  // (victory_road from 4 s in is a soft passage: up 4 dB under the two cave scenes)
  bed('victory_road', { off: 4, gain: 1.6 });
  const f0 = n;
  await caption('Find lava deep underground', 1.95, 'low', 2);
  await walkTo(23, 596);
  await face('up');
  await holdTo(f0, 64);
});
seg('obsidian', async () => {
  await caption('Water plus lava\nmakes obsidian', 0, 'low', 2);
  await use(20);
  await selectItem('diamond_pickaxe');
  await timelapse(6, () => mine(900));
  await idle(24);
});

// Fight the mobs of the given kinds the way a player does: face one beside him and swing on a full charge, else
// step toward the nearest along a breadth-first route. Returns when none are left (or after maxFrames).
async function fight(kinds, maxFrames = 600, { charge = 0.9, stopWhen = null, killSeed = null, lethal = 8 } = {}) {
  for (let i = 0; i < maxFrames; i++) {
    const act = await run(([kinds, charge]) => {
      const h = window.__rs, G = h.G, P = h.P, W = h.world;
      const foes = G.ents.filter((e) => e.type === 'mob' && kinds.includes(e.kind) && !e.dying && !e.dead);
      if (!foes.length) return { done: true };
      const man = (m) => Math.abs(m.tx - P.tx) + Math.abs(m.ty - P.ty);
      const dirOf = (m) => (Math.abs(m.tx - P.tx) >= Math.abs(m.ty - P.ty) ? (m.tx > P.tx ? 'right' : 'left') : (m.ty > P.ty ? 'down' : 'up'));
      const m = foes.slice().sort((a, b) => man(a) - man(b))[0];
      if (man(m) <= 1) {
        const d = man(m) === 0 ? P.dir : dirOf(m);
        if (P.dir !== d) return { press: [d] };
        const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[d];
        const inFront = h.E.mobAt(P.tx + D[0], P.ty + D[1]);
        return { press: inFront && P.attackCd >= charge * 0.7 ? ['a'] : [], hp: m.hp };
      }
      const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const key = (x, y) => x + ',' + y;
      const mobs = new Set(foes.map((e) => key(e.tx, e.ty)));
      const open = (x, y) => (x === P.tx && y === P.ty) || (!W.solid(x, y) && !W.isWater(x, y) && !W.isLava(x, y) && !W.jumpDir(x, y) && !W.warpAt(x, y) && !mobs.has(key(x, y)) && !(W.isEndVoid && W.isEndVoid(x, y)));
      const dist = new Map(), q = [];
      for (const [dx, dy] of Object.values(D)) { const x = m.tx + dx, y = m.ty + dy; if (open(x, y)) { dist.set(key(x, y), 0); q.push([x, y]); } }
      while (q.length && !dist.has(key(P.tx, P.ty)) && dist.size < 4000) {
        const [cx, cy] = q.shift(), cd = dist.get(key(cx, cy));
        for (const [dx, dy] of Object.values(D)) {
          const nx = cx + dx, ny = cy + dy;
          if (dist.has(key(nx, ny)) || !open(nx, ny) || Math.abs(nx - P.tx) > 20 || Math.abs(ny - P.ty) > 20) continue;
          dist.set(key(nx, ny), cd + 1); q.push([nx, ny]);
        }
      }
      const here = dist.get(key(P.tx, P.ty));
      if (here == null) return { press: [] };
      const order = Math.abs(m.tx - P.tx) >= Math.abs(m.ty - P.ty) ? ['left', 'right', 'up', 'down'] : ['up', 'down', 'left', 'right'];
      const d = order.find((k) => { const nn = dist.get(key(P.tx + D[k][0], P.ty + D[k][1])); return nn != null && nn < here; });
      return d ? { hold: d, press: [] } : { press: [] };
    }, [kinds, charge]);
    if (act.done) return true;
    if (stopWhen && (await R(stopWhen))) return true;
    // the blow that will kill it: the drop is rolled from here, the same in every run
    if (killSeed != null && act.press && act.press.includes('a') && act.hp <= lethal) { if (process.env.DEBUG) console.log('  kill reseed', act.hp); await run((v) => { window.__reseed(v); window.__rs.seed(v); }, killSeed); }
    await tick({ hold: act.hold || undefined, press: act.press && act.press.length ? act.press : undefined });
  }
  return false;
}
// Pallet Town's animals walked over to the east side of town, clear of the portal site
const herdAnimals = () => {
  const h = window.__rs, W = h.world, spots = [];
  for (let y = 275; y <= 279; y++) for (let x = 76; x <= 81; x++) if (W.isFloor(x, y) && !W.noPlace(x, y) && !W.block(x, y)) spots.push([x, y]);
  for (const m of h.G.ents) {
    if (m.type !== 'mob' || m.tx < 56 || m.tx > 84 || m.ty < 258 || m.ty > 282) continue;
    const s = spots.shift();
    if (!s) { m.dead = true; continue; }
    m.tx = m.fx = m.fromX = s[0]; m.ty = m.fy = m.fromY = s[1]; m.moving = false;
    spots.shift();
  }
};
// the portal in Pallet Town: a 3 x 2 interior at (67..69, 273..274) south of the houses, its ring of ten
const RING = { top: [[67, 272], [68, 272], [69, 272]], left: [[66, 273], [66, 274]], right: [[70, 273], [70, 274]], bottom: [[67, 275], [68, 275], [69, 275]] };
const ringCells = () => [...RING.top, ...RING.left, ...RING.right, ...RING.bottom];
// the portal Steve built stays in Pallet Town for the rest of the film
const ensurePortal = () => run((cells) => { const h = window.__rs, W = h.world; for (const [x, y] of cells) W.setBlock(x, y, { id: 'obsidian' }); if (!W.isPortal(68, 273)) h.lightPortal(68, 275, 'up'); }, ringCells());
// SEEDS='{"enderman":812}' overrides a scene's seed (for searching one where the dice land right)
const SEED = (name, d) => { try { const o = JSON.parse(process.env.SEEDS || '{}'); return o[name] ?? d; } catch (e) { return d; } };
seg('portal', async () => {
  await unfilmed(async () => {
    await scene({ seed: 301, at: [71, 276, 'up'], time: 3000, inv: [['obsidian', 5], ['flint_and_steel'], ['diamond_pickaxe'], ['diamond_sword']], armor: DIAMOND, toasts: ['nether'] });
    // the ring's top row and west side are already down (the top row sits under a wall: it went in from inside)
    await run((r) => { const W = window.__rs.world; for (const [x, y] of [...r.top, ...r.left]) W.setBlock(x, y, { id: 'obsidian' }); for (const [x, y] of [...r.right, ...r.bottom]) W.setBlock(x, y, null); for (let y = 273; y <= 274; y++) for (let x = 67; x <= 69; x++) W.setBlock(x, y, null); }, RING);
    await run(herdAnimals);
    await walkTo(71, 273); await face('left');
    await idle(10);
  });
  bed('pallet', { off: 0 });
  const f0 = n;
  await caption('Light a portal anywhere', 0, 'low', 2);
  await timelapse(2, async () => {
    await place('left', 'obsidian', 6);             // (70,273)
    await walkTo(71, 274); await place('left', null, 6);   // (70,274)
    await walkTo(71, 276); await walkTo(69, 276); await place('up', null, 6);   // (69,275)
    await walkTo(68, 276); await place('up', null, 6);     // (68,275)
    await walkTo(67, 276); await place('up', null, 6);     // (67,275)
    await walkTo(68, 276); await face('up');
  });
  // the caption is gone before the flint and steel's name comes up over the hotbar (no two lines of text stacked)
  await holdTo(f0, 2 + 56);
  await endCaptions(8);
  await selectItem('flint_and_steel');
  await idle(4);
  await use(40);
  const lit = await R('[0,1].every((dy) => [0,1,2].every((dx) => W.isPortal(67 + dx, 273 + dy)))');
  if (!lit) throw new Error('the portal did not light');
});
seg('enter', async () => {
  if (ONLY && !ONLY.includes('portal')) await unfilmed(async () => {
    await scene({ seed: 301, at: [68, 276, 'up'], time: 3000, inv: [['obsidian', 0], ['flint_and_steel'], ['diamond_pickaxe'], ['diamond_sword']], sel: 1, armor: DIAMOND });
    await run((r) => { const W = window.__rs.world; for (const [x, y] of [...r.top, ...r.left, ...r.right, ...r.bottom]) W.setBlock(x, y, { id: 'obsidian' }); window.__rs.lightPortal(68, 275, 'up'); }, RING);
    await run(herdAnimals);
  });
  await run(() => { window.__reseed(302); });
  await caption('Enter the Nether', 0, 'low', 30);
  await holdFor('up', 14);
  await idle(12);
  // the wobble builds over four seconds: the middle of it sped up
  await timelapse(2, () => idle(66));
  await until('W.inNether(P.tx, P.ty)', { max: 200, pressMsgs: false });
  bed(null);
  amb('nether_wastes', 1);
  await idle(66);
});
seg('ghast', async () => {
  await unfilmed(async () => {
    await scene({ seed: 401, at: [24, 845, 'right'], inv: [['diamond_sword'], ['diamond_pickaxe'], ['flint_and_steel']], armor: DIAMOND, toasts: ['return_to_sender'] });
    await idle(4);
    await run(() => { const h = window.__rs; const g = h.spawn('ghast', 30, 849); g.persistent = true; });
    // wait off camera for it to settle where Steve can see it and open its mouth
    await until(`G.ents.some((e) => e.kind === 'ghast' && e.charge > 0.25)`, { max: 900, pressMsgs: false });
  });
  bed('victory_road', { off: 20 });
  amb('nether_wastes', 1);
  await caption('Bat back ghast fireballs');
  // Steve faces the ghast and bats the fireball back when it reaches his hand
  for (let i = 0; i < 150; i++) {
    const st = await run(() => {
      const h = window.__rs, G = h.G, P = h.P, TILE = 16;
      const g = G.ents.find((e) => e.kind === 'ghast' && !e.dying && !e.dead);
      const f = G.ents.find((e) => e.type === 'fireball' && !e.dead && !e.fromPlayer);
      const back = G.ents.find((e) => e.type === 'fireball' && !e.dead && e.fromPlayer);
      if (!g) return { gone: true };
      const dx = g.fx - P.fx, dy = g.fy - P.fy;
      const want = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      let near = false;
      if (f) { const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[P.dir]; near = Math.hypot(f.x - (P.fx * TILE + 8 + D[0] * 10), f.y - (P.fy * TILE + 8 + D[1] * 10)) < 18; }
      return { want, dir: P.dir, near, flying: !!f, back: !!back };
    });
    if (st.gone) break;
    if (st.dir !== st.want && !st.flying) { await tick({ press: st.want }); continue; }
    await tick(st.near ? { press: 'a' } : {});
  }
  await idle(40);
});
seg('fortress', async () => {
  await unfilmed(async () => {
    await scene({ seed: 501, at: [104, 817, 'up'], inv: [['diamond_sword'], ['diamond_pickaxe']], armor: DIAMOND, toasts: ['into_fire'] });
    await run(() => {
      const h = window.__rs;
      for (const [k, x, y] of [['blaze', 102, 807], ['blaze', 107, 808], ['wither_skeleton', 104, 811]]) { const m = h.spawn(k, x, y); m.persistent = true; }
    });
    await idle(6);
  });
  amb('nether_wastes', 0.8);
  await caption('Raid the fortress');
  await fight(['wither_skeleton'], 260);
  await walkTo(104, 812);
  await idle(30);
});
// A wild HOUNDOOM on the Nether's own battle background. Steve (level 62 at 27 XP levels) is a touch slower than it,
// so its EMBER comes first; then his JUMP ATTACK. The battle's dice are seeded at the move (see below).
seg('battleN', async () => {
  await unfilmed(async () => {
    await scene({ seed: 601, at: [30, 842, 'up'], inv: [['diamond_sword'], ['diamond_pickaxe']], armor: DIAMOND, level: 27 });
    await idle(4);
    // FireRed's wild-encounter flashes (three full-screen white flashes in half a second) are left out: the shot
    // opens on the swirl that follows them
    await run(() => { window.__rs.encounter('HOUNDOOM', 40); });
    await until(`h.state() === 'transition' && h.seq() && h.seq().t >= 0.62`, { max: 60, pressMsgs: false });
  });
  bed('battle', { off: 0.7, fadeIn: 0.04 });
  await until(`h.state() !== 'transition' || h.seq().t >= 1.3`, { max: 60, pressMsgs: false });
  // (HOUNDOOM sliding in over an empty text box is cut: straight to its cry and its line)
  await unfilmed(() => until(`b && b.cur && b.cur.type === 'intro' && b.cur.t >= 1.08`, { max: 300, pressMsgs: false }));
  await caption('Fire-type POKéMON', 0, 'top', 0);
  await until(battleIdle('action'), { read: 20, max: 900 });
  // the menus off camera: FIGHT, then JUMP ATTACK
  let k = SEED('houndoom', 0);
  await unfilmed(async () => {
    await press('a', 10);
    await press('right', 6);
    // the battle's first draw is HOUNDOOM's move: a seed that makes it EMBER (the k-th such seed)
    const s = await run((k) => {
      const h = window.__rs, b = h.battle(), R = window.__RNG;
      const usable = b.E.mon.moves.filter((m) => m.pp > 0), want = usable.findIndex((m) => m.id === 'EMBER');
      if (want < 0) return null;
      for (let s = 1; s < 1e6; s++) { R.seed(s); if (R.randInt(usable.length) === want && k-- <= 0) { R.seed(s); return s; } }
      return null;
    }, k);
    console.log('  houndoom seed', s);
    console.log('  speeds', await R('[h.battle().speedOf(h.battle().P), h.battle().speedOf(h.battle().E), h.battle().P.mon.level, h.battle().E.mon.level, P.level]'));
    await tick({ press: 'a' });
  });
  const said = [];
  await until(`(b && b.cur && b.cur.type === 'msg' && /fainted/.test(b.cur.text)) || h.state() !== 'battle'`, { max: 600, read: 14, hold: 10,
    onTick: async () => { const t = await R(`h.battle() && h.battle().cur && h.battle().cur.type === 'msg' ? h.battle().cur.text : null`); if (t && said[said.length - 1] !== t) said.push(t); } });
  console.log('  houndoom said', JSON.stringify(said));
  await until(`b && b.cur && b.cur.type === 'msg' && b.cur.shown >= b.cur.pages[b.cur.page].join('').length`, { max: 60, pressMsgs: false });
  await idle(18);
});
// the netherite sword: the recipe (laid in off camera) with the result's name up, taken, then in use on the bridge
seg('netherite', async () => {
  await unfilmed(async () => {
    await scene({ seed: 701, at: [104, 822, 'down'], inv: [['diamond_sword'], ['diamond_pickaxe'], ['netherite_ingot', 2], ['gold_ingot', 4]], armor: DIAMOND });
    await idle(4);
    await press('inv', 8);
    await pickUp('diamond_sword');
    await cursorTo('grid', 0); await leftClick();
    await pickUp('netherite_ingot');
    await cursorTo('grid', 1); await press('b', 4);
    await cursorTo('inv', 2); await leftClick();
    await cursorTo('result');
    await idle(4);
  });
  bed('victory_road', { off: 40 });
  amb('nether_wastes', 0.8);
  await caption('Craft netherite', 0, 'top', 0);
  await idle(28);
  await shiftClick(10);
  await unfilmed(async () => {
    await press('inv', 8);
    await run(() => { const h = window.__rs; h.teleport(104, 816, 'up'); const m = h.spawn('wither_skeleton', 104, 812); m.persistent = true; });
    await selectItem('netherite_sword');
    await idle(70);                                  // (the hotbar's item name gone)
  });
  await fight(['wither_skeleton'], 150, { charge: 0.9 });
  await idle(14);
});

// ================================================================ THE END
const END_INV = [['netherite_sword'], ['bow'], ['diamond_pickaxe'], ['eye_of_ender', 2], ['cobblestone', 32], ['ultra_ball', 10], ['arrow', 64], ['torch', 16]];
// The End's own state for a scene: the dragon (fresh, as ensure() makes it), its health, how many crystals are left
async function endState(o) {
  await run((o) => {
    const h = window.__rs, G = h.G;
    h.END.restore(null);
    h.END.regenPlatform();
    if (o.crystalsDead) { let k = 0; for (const c of G.end.crystals) if (k < o.crystalsDead) { c.alive = false; k++; } }
    if (o.crystalsDead >= 10) h.killCrystals(10);
    if (o.hp) G.end.dragon.hp = o.hp;
    h.DR.reset();
  }, o);
}
seg('enderman', async () => {
  await unfilmed(async () => {
    await scene({ seed: SEED('enderman', 801), at: [62, 274, 'right'], time: 17000, inv: [['netherite_sword'], ['diamond_pickaxe']], armor: NETHERITE });
    await run(herdAnimals);
    await ensurePortal();
    await run(() => { const h = window.__rs, W = h.world; for (const [x, y] of [[61, 272], [70, 276]]) if (!W.block(x, y) && !W.solid(x, y)) W.setBlock(x, y, { id: 'torch' }); });
    await run(() => { const h = window.__rs; const m = h.spawn('enderman', 67, 274); m.persistent = true; m.dir = 'left'; });
    await idle(6);
  });
  bed('lavender', { off: 7.5 });
  amb(null);                                        // the Nether's drone stops at the cut back to the Overworld
  await caption('Endermen drop ender pearls');
  // Steve looks at it: it stares back, screams, and is on him
  await idle(40);
  await fight(['enderman'], 400, { charge: 1, killSeed: SEED('pearl', 5), lethal: 9 });
  await until(`G.ents.some((e) => e.type === 'item' && e.stack.id === 'ender_pearl') || G.inv.count('ender_pearl') > 0`, { max: 40, pressMsgs: false }).catch(() => {});
  const pearl = await R(`(() => { const it = G.ents.find((e) => e.type === 'item' && e.stack.id === 'ender_pearl'); return it ? [Math.floor(it.x / 16), Math.floor(it.y / 16)] : null; })()`);
  if (!pearl && !(await R("G.inv.count('ender_pearl')"))) console.warn('  no pearl dropped (reseed the scene)');
  if (pearl) await walkTo(pearl[0], pearl[1]).catch(() => {});
  await idle(24);
});
seg('eye', async () => {
  await unfilmed(async () => {
    await scene({ seed: 901, at: [13, 84, 'up'], time: 5000, inv: [['eye_of_ender', 3], ['diamond_pickaxe'], ['netherite_sword']], armor: NETHERITE });
    await run(() => { window.__rs.G.end.eyeMsg = true; });
    await idle(8);
  });
  bed('lavender', { off: 22 });
  await caption('Follow the Eye of Ender');
  await idle(6);
  await use(10);
  await until('!h.END.projectiles.length', { max: 200, pressMsgs: false });
  await idle(6);
  // cut: Steve has gone after it and picked it up where it came down; once more close by, it dives into the ground
  await unfilmed(async () => {
    const it = await R(`(() => { const it = G.ents.find((e) => e.type === 'item' && e.stack.id === 'eye_of_ender'); return it ? [Math.floor(it.x / 16), Math.floor(it.y / 16)] : null; })()`);
    await walkTo(13, it ? Math.max(79, it[1]) : 81);
    await walkTo(13, 79);
    await face('up');
    await selectItem('eye_of_ender');
    await idle(4);
  });
  await idle(4);
  await use(10);
  await until('!h.END.projectiles.length', { max: 200, pressMsgs: false });
  await idle(12);
});
seg('stronghold', async () => {
  await unfilmed(async () => {
    await scene({ seed: 1001, at: [13, 78, 'up'], time: 5000, inv: [['diamond_pickaxe'], ['netherite_sword'], ['eye_of_ender', 2]], armor: NETHERITE, toasts: ['eye_spy'] });
    await run(() => { window.__rs.END.fixEntrance(); });
    await idle(4);
  });
  bed('lavender', { off: 34 });
  await caption('Find the stronghold');
  await walkTo(13, 77); await face('up');
  await mine(200);
  await idle(10);
  await holdFor('up', 10);
  await until('W.inStronghold(P.tx, P.ty)', { max: 200, pressMsgs: false });
  bed('mt_moon', { off: 0 });
  // inside: the view comes up and the Eye Spy toast slides in, then the cut (Steve does not stand about)
  await until('h.toasts.length > 0', { max: 90, pressMsgs: false }).catch(() => {});
  await idle(16);
});
seg('frames', async () => {
  await unfilmed(async () => {
    await scene({ seed: 1101, at: [76, 913, 'up'], inv: [['eye_of_ender', 2], ['netherite_sword'], ['diamond_pickaxe'], ['cobblestone', 32]], armor: NETHERITE });
    await run(() => {
      const h = window.__rs, W = h.world, S = W.stronghold;
      // the frames as the stronghold starts them (two eyes), the centre back to lava, then ten eyes in
      for (const [x, y, , pre] of S.frames) { const b = W.block(x, y); if (b) { b.eye = !!pre; W.setBlock(x, y, b); } }
      for (const [x, y] of S.portal.centre) W.setBlock(x, y, { id: 'lava' });
      h.fillFrames(10);
    });
    await idle(6);
  });
  bed('mt_moon', { off: 30 });
  await caption('Open the End portal');
  await idle(10);
  await use(16);                                  // (76,912)
  await walkTo(77, 913); await face('up');
  await use(10);                                  // (77,912): the twelfth
  if (!(await R('h.END.portalOpen()'))) throw new Error('the End portal did not open');
  await idle(20);
  // the caption fades as Steve steps in; the scene ends on the black frame of the jump (the arrival is the next scene's)
  await closeCaptions(10);
  for (let i = 0; i < 60 && !(await R('W.inEnd(P.tx, P.ty)')); i++) await tick({ hold: 'up', press: i === 0 ? 'up' : undefined });
});
seg('void', async () => {
  await unfilmed(async () => {
    await scene({ seed: 1201, at: [17, 999, 'right'], inv: END_INV, sel: 4, armor: NETHERITE, toasts: ['end_q'] });
    await endState({});
    await run(() => { window.__rs.enterEnd(); });
    await idle(2);
  });
  // (the_end.ogg is near silent for its first minute: taken from 71 s, where its theme is up)
  bed('the_end', { off: 71, gain: 1.3, fadeIn: 0.2 });
  await caption('Cross the void');
  await idle(8);
  await walkTo(19, 999); await face('right'); await idle(4);
  await timelapse(3, async () => {
    for (let k = 0; k < 10 && (await R('W.isEndVoid(P.tx + 1, P.ty)')); k++) { await place('right', 'cobblestone', 4); const x = await R('P.tx + 1'); await walkTo(x, 999); }
  });
  await walkTo(28, 999, { run: true });
  await idle(10);
});
// crystals: arrows into two pillars from the side, so the crystal on top is in view: pillar 0 (82..85, 999..1005)
// from the west, then pillar 9 (80..84, 987..994) from the west too
async function shootBow(frames = 32) { for (let k = 0; k < frames; k++) await tick({ hold: 'b', press: k === 0 ? 'b' : undefined }); }
seg('crystals', async () => {
  await unfilmed(async () => {
    await scene({ seed: 1301, at: [77, 1001, 'right'], inv: END_INV, sel: 1, armor: NETHERITE });
    await endState({});
    await run(() => { window.__rs.enterEnd(); window.__rs.teleport(77, 1001, 'right'); });
    await idle(90);
  });
  bed('end_boss', { off: 85 });
  await caption('Break the crystals');
  await idle(4);
  await shootBow();
  await idle(30);
  await unfilmed(async () => { await run(() => { window.__rs.teleport(77, 990, 'right'); }); await idle(4); });
  await idle(4);
  await shootBow();
  await idle(34);
});

// the fight: a strafe that Steve steps out of, then the dragon perched on the fountain and his blows
async function dodgeAttack(maxFrames = 200) {
  let stepped = false;
  for (let i = 0; i < maxFrames; i++) {
    const st = await R('(() => { const D = h.DR.live(); return D ? [D.phase, D.t, D.x] : null; })()');
    if (!st) return;
    if (st[0] === 'away' && st[1] > 0.6) return;
    if (st[0] === 'windup' && st[1] > 0.7 && !stepped) { stepped = true; const d = st[2] > (await R('P.fx')) ? 'left' : 'right'; await holdFor(d, 9); continue; }
    await tick();
  }
}
// Where Steve stands at the perched dragon (it sits on the fountain's pillar at 64,999): beside it to the east, a row
// above its feet. The view leans up to the dragon there and clamps Steve to its lower part; from this cell he and his
// follower stay well above the hearts and the hotbar.
const PERCH_SPOT = [67, 998];
seg('fight', async () => {
  await unfilmed(async () => {
    // (the two advancements the dragon gives are not had yet: their toasts come up when the egg appears)
    await scene({ seed: SEED('fight', 1401), at: [64, 1006, 'up'], inv: END_INV, sel: 0, armor: NETHERITE, toasts: ['free_end', 'dragon_tamer'] });
    await endState({ crystalsDead: 10, hp: 120 });
    await run(() => { window.__rs.enterEnd(); window.__rs.teleport(64, 1006, 'up'); });
    for (let i = 0; i < 3000 && !(await R(`h.DR.live() && h.DR.live().phase === 'windup'`)); i++) {
      await tick();
      if (i % 150 === 0) { await run(() => { window.__rs.P.health = 20; }); }
    }
    await run(() => { window.__rs.P.health = 20; });
  });
  await caption('Fight the Ender Dragon', 0, 30);
  await dodgeAttack();
  await idle(6);
  // cut: it comes down to perch on the fountain, with enough health left for a run of blows (the bar falls with each)
  await unfilmed(async () => {
    await run((at) => { const h = window.__rs; window.__reseed(1402); h.G.end.dragon.hp = 96; h.P.health = 20; h.teleport(at[0] + 1, at[1], 'left'); const D = h.DR.live(); Object.assign(D, { x: 64, y: 991, alt: 40, phase: 'land', t: 0, vx: 0, vy: 3 }); }, PERCH_SPOT);
    await until(`h.DR.live().phase === 'descend'`, { max: 300, pressMsgs: false });
  });
  await until(`h.DR.live().phase === 'perch'`, { max: 120, pressMsgs: false });
  await idle(6);
  const t0 = n / FPS;
  await walkTo(...PERCH_SPOT); await face('left');
  for (let i = 0; i < 300 && !(await R('G.end.dragon.exhausted')); i++) {
    const cd = await R('P.attackCd');
    await tick(cd >= 0.66 ? { press: 'a' } : {});
  }
  console.log('  fight: exhausted', await R('G.end.dragon.exhausted'), 'hp', await R('G.end.dragon.hp'));
  await idle(16);
  SFX_TRIM.push({ t0, t1: n / FPS, g: 0.5 });
});
seg('exhaust', async () => {
  await unfilmed(async () => {
    if (!(await R('G.end.dragon.exhausted && h.DR.live()'))) {
      await scene({ seed: 1501, at: [64, 1003, 'up'], inv: END_INV, sel: 0, armor: NETHERITE, toasts: ['free_end', 'dragon_tamer'] });
      await endState({ crystalsDead: 10, hp: 46 });
      await run(() => { window.__rs.enterEnd(); window.__rs.teleport(64, 1003, 'up'); window.__rs.exhaustDragon(); });
      await idle(100);                            // the map's name slides away first
    }
    // ARCANINE joins (its follower walks in behind Steve); Steve comes round to the dragon's east side
    await run((at) => {
      const h = window.__rs;
      window.__reseed(1502); h.seed(1502);
      h.G.party.length = 0;
      const m = h.addMon('ARCANINE', 62); m.hp = m.maxHp;
      h.P.health = 20; h.teleport(at[0] + 3, at[1], 'left');
    }, PERCH_SPOT);
    await until(`h.DR.live() && h.DR.live().phase === 'exhausted'`, { max: 300, pressMsgs: false });
    await idle(10);
  });
  bed('@game');
  await caption('Wear it down', 0, 30, 8);
  await walkTo(...PERCH_SPOT); await face('left');
  await idle(10);
  await press('a', 4);
  await until(`h.state() === 'transition'`, { max: 300, read: 34 });
  await endCaptions(8);
  // the mosaic and the fade to black
  await until(`h.state() !== 'transition' || h.seq().t >= 0.84`, { max: 120, pressMsgs: false });
});
// the catch: ARCANINE leads; an ULTRA BALL, thrown when the battle's dice give three shakes and a click
seg('catch', async () => {
  if (!(await R(`h.state() === 'transition' || h.state() === 'battle'`))) throw new Error('the catch scene follows the exhaust scene (SEG=exhaust,catch)');
  // (cut) the battle as the dragon's cry rings out, its slide-in over an empty text box left out
  // (the cut lands just before the intro ends, so the dragon's cry that follows it is heard)
  await unfilmed(() => until(`b && b.cur && b.cur.type === 'intro' && b.cur.t >= 1.08`, { max: 200, pressMsgs: false }));
  await until(`b && b.cur && b.cur.type === 'msg' && /appeared/.test(b.cur.text) && b.cur.shown >= b.cur.pages[b.cur.page].join('').length`, { max: 400, pressMsgs: false });
  // the cold open's smash cut is taken from the line typing out, up to here (before the caption comes up)
  SLOT_SRC = { f0: n - 26 };
  // STEVE steps aside and ARCANINE goes out; the cut comes as its HP box lands (the menu would come up next). The
  // caption has faded by then: the throw and the shakes play with nothing to give the result away.
  await caption('Then catch it', 2.1, { y: 5, cx: 186 }, 0);
  await idle(16);
  await tick({ press: 'a' });
  await until(`b && b.dp && b.dp.species === 'ARCANINE' && b.dp.visible && b.dp.hb <= 0`, { max: 200, pressMsgs: false, hold: 4 });
  // cut: the menu and the BAG off camera, to the throw
  await unfilmed(async () => {
    await until(battleIdle('action'), { read: 12, max: 600 });
    await idle(4);
    await press('right', 6);
    await press('a', 10);
    const idx = await R(`h.battle().bagItems().findIndex((e) => e.key === 'ultra_ball')`);
    for (let k = 0; k < idx; k++) await press('down', 6);
    await idle(4);
    // the seed whose first draw (the dragon's move pick) is followed by four shake rolls under the ball's threshold
    const seed = await run(async () => {
      const h = window.__rs, b = h.battle(), E = b.E.mon, R = window.__RNG;
      const { item } = await import('/src/items.js'), { species } = await import('/src/data.js');
      const def = item('ultra_ball'), sp = species(E.species);
      let odds = Math.floor((sp.catchRate * def.ball.mult) / 10);
      odds = Math.floor((odds * (E.maxHp * 3 - E.hp * 2)) / (E.maxHp * 3));
      if (E.status === 'SLP' || E.status === 'FRZ') odds *= 2; else if (E.status) odds = Math.floor((odds * 15) / 10);
      const bb = Math.floor(1048560 / Math.floor(Math.sqrt(Math.floor(Math.sqrt(Math.floor(16711680 / Math.max(1, odds)))))));
      for (let s = 1; s < 5e6; s++) {
        R.seed(s); R.rand();
        let k = 0; for (; k < 4 && R.randInt(65536) < bb; k++);
        if (k === 4) { R.seed(s); return { s, odds, bb }; }
      }
      return null;
    });
    console.log('  catch seed', JSON.stringify(seed));
    await tick({ press: 'a' });
  });
  // each of the ball's three shakes has its wobble sound: the game plays it on the shake's first 7 ms, which a 30 fps
  // step never lands on (at 60 fps it always does), so it is recorded here at the frame the shake starts
  let shook = 0;
  const wobble = async () => {
    const k = await R(`(h.battle() && h.battle().cur && h.battle().cur.type === 'ballthrow' && h.battle().cur.shook) || 0`);
    if (k > shook) { shook = k; await run((t) => { window.__AU.recordedEvents().push({ t, type: 'sfx', name: 'wobble' }); }, (n - 1) / FPS); }
  };
  await until(`b && b.cur && b.cur.type === 'msg' && /Gotcha/.test(b.cur.text) && b.cur.shown >= b.cur.pages[b.cur.page].join('').length`, { max: 900, read: 14, onTick: wobble, pressMsgs: false });
  console.log('  shakes', shook);
  // the payoff, held while the caught fanfare plays
  await caption('A legendary catch', 0, 'top', 0);
  await idle(104);
  FREEZE = n / FPS;
});
// the battle over (off camera: the lines after the catch and the battle's fade), then the cut to the island on its
// first frame of play: the exit portal is open, Free the End and Dragon Tamer slide in, and the view leans up to the
// egg on the pillar. Then Steve claims it the Minecraft way: a torch set down beside him, a blow at the egg across the
// basin, and it hops onto the torch and pops off as an item he picks up (The Next Generation). The new ENDER DRAGON
// leads the party from here (its follower beside Steve, first in the Hall of Fame).
// (where Steve hits the egg from: the rim east of the basin, in the pillar's row, the pillar three cells west)
const EGG_SPOT = [67, 999];
seg('egg', async () => {
  await unfilmed(async () => {
    if (await R(`h.state() === 'battle' || h.state() === 'battleOut'`)) {
      await until(`h.state() === 'battleOut' && h.seq() && h.seq().t >= 0.385`, { max: 900, read: 12 });
      await run(() => { const G = window.__rs.G; const i = G.party.findIndex((m) => m.species === 'ENDER_DRAGON'); if (i > 0) G.party.unshift(G.party.splice(i, 1)[0]); });
      // the battle hands back to the island (still off camera: the view there is the one the fight left, which the
      // egg's lean replaces on the first frame of play)
      await until(`h.state() === 'play'`, { max: 60, pressMsgs: false });
    } else {
      // (alone: the island just after the catch, the egg and its toasts as they come)
      await scene({ seed: 1601, at: PERCH_SPOT, inv: END_INV, sel: 0, armor: NETHERITE, toasts: ['free_end', 'dragon_tamer'] });
      await endState({ crystalsDead: 10 });
      await run((at) => { const h = window.__rs; h.enterEnd(); h.teleport(at[0], at[1], 'left'); h.G.party.length = 0; h.addMon('ENDER_DRAGON', 70); h.addMon('ARCANINE', 62); h.G.end.dragon.alive = false; h.G.end.dragon.hp = 0; h.DR.reset(); }, PERCH_SPOT);
      await idle(100);
      await run(() => { window.__rs.DR.battleOver('caught'); });
    }
    // claiming the egg is earned on screen
    await run(() => { const G = window.__rs.G; G.advancements.delete('next_gen'); G.eggRoll = null; window.__reseed(1602); });
  });
  const f0 = n;
  // (top left, beside the egg while the view leans to it: Steve and his dragon are right of the basin, the toasts at
  // the top right. It has faded by the time the view eases back to Steve, which brings the pillar up under this spot.)
  await caption('Claim the\ndragon egg', 2.1, { y: 10, cx: 120 }, 6);
  await idle(26);
  // a torch set down on the floor east of him
  await walkTo(...EGG_SPOT);
  await selectItem('torch');
  await face('right');
  await use(10);
  await face('left');
  // the view eases back to Steve (the lean ends by itself: the blow before then would cut it short)
  await until(`!G.camFocus`, { max: 150, pressMsgs: false });
  await idle(4);
  // the egg's hop is a die (a random cell within seven): seeded where it is rolled, so it lands on the torch
  await run(([tx, ty]) => {
    const h = window.__rs, G = h.G, P = h.P, w = h.world, E = h.E;
    G.eggRoll = (len) => {
      G.eggRoll = null;
      const [x, y] = w.end.fountain.pillar, area = w.areaOf(x, y), cands = [];
      for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
        const X = x + dx, Y = y + dy;
        if ((!dx && !dy) || Math.hypot(dx, dy) > 7.5 || !w.inside(X, Y) || w.areaOf(X, Y) !== area) continue;
        if (X === P.tx && Y === P.ty) continue;
        const b = w.block(X, Y);
        if (b && b.id !== 'torch') continue;
        if (!w.isFloor(X, Y) || w.noPlace(X, Y) || w.isLava(X, Y) || E.mobAt(X, Y) || (G.npcAt && G.npcAt(X, Y))) continue;
        cands.push([X, Y]);
      }
      const want = cands.findIndex(([X, Y]) => X === tx && Y === ty);
      if (cands.length !== len || want < 0) { console.error('egg roll: torch not among the hops', len, cands.length, want); return Math.floor(Math.random() * len); }
      for (let s = 1; s < 1e6; s++) { window.__reseed(s); if (Math.floor(Math.random() * len) === want) { window.__reseed(s); break; } }
      return Math.floor(Math.random() * len);
    };
  }, [EGG_SPOT[0] + 1, EGG_SPOT[1]]);
  await press('a', 4);
  console.log('  egg: hopped to', JSON.stringify(await R('G.lastEgg')), 'egg on pillar', await R('G.end.egg'));
  await until(`G.advancements.has('next_gen')`, { max: 150, pressMsgs: false });
  console.log('  egg: claimed at', ((n - f0) / FPS).toFixed(2), 's into the scene');
  await idle(40);
  await run(() => { window.__rs.G.eggRoll = null; });
});
seg('hof', async () => {
  await unfilmed(async () => {
    if (!(await R(`G.end.kills >= 1 && G.end.exitActive && W.inEnd(P.tx, P.ty)`))) {
      await scene({ seed: 1701, at: [64, 1003, 'up'], inv: END_INV, sel: 0, armor: NETHERITE });
      await endState({ crystalsDead: 10 });
      await run(() => { const h = window.__rs; h.enterEnd(); h.teleport(64, 1003, 'up'); h.G.party.length = 0; h.addMon('ENDER_DRAGON', 70); h.addMon('ARCANINE', 62); Object.assign(h.G.end.dragon, { alive: false, hp: 0 }); h.G.end.kills = 1; h.DR.reset(); h.DR.activateExit(true, false); });
    }
    await run(() => { const G = window.__rs.G; const i = G.party.findIndex((m) => m.species === 'ENDER_DRAGON'); if (i > 0) G.party.unshift(G.party.splice(i, 1)[0]); G.end.hofSeen = false; window.__reseed(1702); });
    await walkTo(64, 1002);
    await holdFor('up', 10);
    await until(`h.state() === 'hof'`, { max: 120, pressMsgs: false });
  });
  bed('hall_of_fame', { off: 0, fadeIn: 0.1 });
  await caption('Hall of Fame', 0, 'top', 8);
  // the ENDER DRAGON's card for a moment, then (cut) the whole team under the confetti
  await until(`h.hof().phase === 'mon' && h.hof().i === 0 && h.hof().pt >= 1.25`, { max: 200, pressMsgs: false });
  await unfilmed(() => until(`h.hof().phase === 'welcome' && h.hof().pt >= 0.5`, { max: 400, pressMsgs: false }));
  await until(`h.hof().phase === 'welcome' && h.hof().pt >= 3.4`, { max: 200, pressMsgs: false });
});
seg('home', async () => {
  await unfilmed(async () => {
    if (await R(`h.state() === 'hof'`)) {
      for (let i = 0; i < 900 && (await R(`h.state() === 'hof'`)); i++) await tick(i % 20 === 0 ? { press: 'a' } : {});
    } else {
      await scene({ seed: 1801, at: [66, 268, 'down'], inv: END_INV, sel: 0, armor: NETHERITE });
      await run(() => { const h = window.__rs; h.G.party.length = 0; h.addMon('ENDER_DRAGON', 70); h.addMon('ARCANINE', 62); });
    }
    await run(() => { const h = window.__rs; window.__reseed(1802); h.setTime(3000); h.toasts.length = 0; h.G.endFade = 0; h.teleport(66, 268, 'down'); });
    await run(herdAnimals);
    await ensurePortal();
    await idle(30);
  });
  bed('pallet', { off: 0 });
  await caption('Your dragon\nfollows you home');
  await walkPath([[66, 272], [71, 272]]);
  await idle(24);
});
// the end card, then the picture and the sound fade out together over the last 1.5 s
const OUTRO = 45;
seg('card', async () => {
  bed('title', { off: 1.53 });
  CARD_T = n / FPS;
  await run((f0) => { window.__card = { f0 }; }, n);
  await idle(136);
  for (let i = 1; i <= OUTRO; i++) { await run((a) => window.__rs.setFade(a), i / OUTRO); await tick(); }
});

// ---------------------------------------------------------------- run
const ORDER = ['cold', 'title', 'lava', 'obsidian', 'portal', 'enter', 'ghast', 'fortress', 'battleN', 'netherite', 'enderman', 'eye', 'stronghold', 'frames', 'void', 'crystals', 'fight', 'exhaust', 'catch', 'egg', 'hof', 'home', 'card'];
segments.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
const SCENES = [];
for (const s of segments) {
  if (ONLY && !ONLY.includes(s.name)) continue;
  const n0 = n;
  console.log(`scene ${s.name}…`);
  await s.fn();
  await endCaptions();
  SCENES.push({ name: s.name, f0: n0, f1: n });
  console.log(`  ${s.name}: ${n - n0} frames (${(n0 / FPS).toFixed(2)}s to ${(n / FPS).toFixed(2)}s)`);
}
const errs = await R('G.errors || []');
if (process.env.NOPOST) { await browser.close(); server.kill(); process.exit(0); }
if (errs.length) console.error('game errors:', errs);

const duration = n / FPS;
console.log(`captured ${n} frames (${duration.toFixed(1)}s), rendering audio…`);
// the game's music events, then the recording without them (the music beds are laid in by ffmpeg)
const gameMusic = await run(() => window.__AU.recordedEvents().filter((e) => ['music', 'musicStop', 'fanfare'].includes(e.type)).map((e) => ({ ...e })));
await run(() => { const ev = window.__AU.recordedEvents(); for (let i = ev.length - 1; i >= 0; i--) if (['music', 'musicStop', 'fanfare', 'ambience', 'ambienceStop'].includes(ev[i].type)) ev.splice(i, 1); });
// The smash cut: the slot's frames are the legendary battle's, and so are its sounds
const slotOk = SLOT && SLOT_SRC && SLOT_SRC.f0 + SLOT.len <= n;
if (slotOk) {
  for (let i = 0; i < SLOT.len; i++) copyFileSync(path.join(FRAMES, String(SLOT_SRC.f0 + i).padStart(5, '0') + '.png'), path.join(FRAMES, String(SLOT.f0 + i).padStart(5, '0') + '.png'));
  CAPS.forEach((c) => { if (c.f0 < SLOT.f0 + SLOT.len && c.f1 > SLOT.f0) console.warn('  a caption overlaps the smash-cut slot'); });
}
const cleaned = await run(({ slot, src, cardT, trim }) => {
  const ev = window.__AU.recordedEvents(), out = [];
  for (const e of ev) for (const w of trim) if (e.type === 'buf' && e.t >= w.t0 && e.t < w.t1) e.gain *= w.g;
  // a sound the game started on frame after frame (a cry or a battle sound whose step ran on: "e.t - dt <= 0" on
  // two frames, or ARCANINE's send-out cry on nine) is heard once, as at 60 fps
  const last = {};
  let dropped = 0;
  for (const e of ev) {
    if (e.type === 'sfx' || (e.type === 'buf' && /\/cries\//.test(e.url))) {
      const k = e.type + ':' + (e.name || e.url), prev = last[k];
      last[k] = e.t;
      if (prev != null && e.t - prev <= 0.07) { dropped++; continue; }
    }
    // the end card is up: the town behind it is not heard
    if (cardT != null && e.t >= cardT + 0.2) { dropped++; continue; }
    out.push(e);
  }
  let final = out;
  if (slot) {
    const a0 = slot.f0 / 30, a1 = (slot.f0 + slot.len) / 30, b0 = src.f0 / 30, b1 = (src.f0 + slot.len) / 30;
    final = out.filter((e) => e.t < a0 || e.t >= a1);
    for (const e of out) if (e.t >= b0 && e.t < b1) final.push({ ...e, t: e.t - b0 + a0 });
    final.sort((x, y) => x.t - y.t);
  }
  ev.splice(0, ev.length, ...final);
  return { dropped, n: final.length };
}, { slot: slotOk ? SLOT : null, src: SLOT_SRC, cardT: CARD_T, trim: SFX_TRIM });
console.log('  sound events', JSON.stringify(cleaned));
const wav = await page.evaluate((d) => window.__rs.renderAudio(d), duration + 0.5);
writeFileSync(path.join(WORK, 'sfx.wav'), Buffer.from(wav, 'base64'));
const ambFiles = await run(() => { const h = window.__rs, A = h.A; const o = {}; for (const k of ['nether_wastes', 'soul_sand_valley']) { const f = (window.__rs.A.sfx || {})[k + '.loop']; o[k] = f ? f[0] : null; } return o; }).catch(() => ({}));
await browser.close();
server.kill();
writeFileSync(path.join(WORK, 'scenes.json'), JSON.stringify({ SCENES, CAPS: CAPS.map((c) => ({ ...c, t0: +(c.f0 / FPS).toFixed(2), t1: +(c.f1 / FPS).toFixed(2), hold: +((c.f1 - c.f0) / FPS).toFixed(2) })), BEDS, AMBS, gameMusic, ambFiles, duration }, null, 1));

// ---------------------------------------------------------------- the music
const musicInfo = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'music', 'music.json'), 'utf8'));
// the smash cut's music: the legendary battle's track, from where the game had it at the source frames
if (slotOk) {
  const leg = gameMusic.filter((e) => e.type === 'music' && e.name === 'vs_legend' && e.t <= SLOT_SRC.f0 / FPS).pop();
  if (leg) BEDS.push({ t: SLOT.f0 / FPS, name: 'vs_legend', off: SLOT_SRC.f0 / FPS - leg.t, gain: 1, fadeIn: 0.02 });
}
function expandBeds() {
  // '@game' beds become the game's own music events inside their window (up to FREEZE, after which the track
  // already playing runs on)
  const out = [];
  const sorted = BEDS.slice().sort((a, b) => a.t - b.t);
  sorted.forEach((b, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1].t : duration;
    if (b.name !== '@game') { out.push(b); return; }
    // the bed already playing runs on until the game's first music event in the window
    for (const e of gameMusic) {
      if (e.t <= b.t || e.t >= end || (FREEZE != null && e.t >= FREEZE)) continue;
      if (e.type === 'musicStop') out.push({ t: e.t, name: null, off: 0, gain: 1, fadeIn: 0.05, fadeOut: e.fade || 0.4 });
      else out.push({ t: e.t + 0.05, name: e.name, off: 0, gain: b.gain, fadeIn: 0.02, once: e.type === 'fanfare' || e.loop === false });
      if (e.type === 'fanfare' && e.resume && e.t + e.dur + 0.12 < end) out.push({ t: e.t + e.dur + 0.12, name: e.resume, off: 0, gain: b.gain, fadeIn: 0.05 });
    }
  });
  return out.sort((a, b) => a.t - b.t);
}
const XF = 0.35;
function buildLayer(list, file, gainAll, fileOf) {
  const args = ['-y', '-loglevel', 'error'], filters = [];
  list.forEach((c, i) => {
    if (!c.name) return;
    const src = fileOf(c.name);
    if (!src || !existsSync(src)) { console.warn('no track', c.name); return; }
    const next = list[i + 1];
    const end = next ? next.t : duration;
    const fo = next && next.fadeOut != null ? next.fadeOut : XF;
    const dur = Math.max(0.05, end - c.t + fo);
    const k = filters.length;
    // one input per cue: [-stream_loop -1] -ss off -i file
    if (!c.once) args.push('-stream_loop', '-1');
    args.push('-ss', c.off.toFixed(3), '-i', src);
    const ms = Math.round(c.t * 1000);
    filters.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${(gainAll * c.gain).toFixed(3)},`
      + `afade=t=in:d=${(c.fadeIn ?? XF).toFixed(3)},afade=t=out:st=${Math.max(0, dur - fo).toFixed(3)}:d=${fo.toFixed(3)},adelay=${ms}|${ms}[m${k}]`);
  });
  const total = (duration + 0.5).toFixed(3);
  if (!filters.length) { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', total, file]); return; }
  const mix = filters.map((_, i) => `[m${i}]`).join('') + `amix=inputs=${filters.length}:normalize=0:duration=longest,apad=whole_dur=${total},atrim=0:${total}[out]`;
  args.push('-filter_complex', filters.join(';') + ';' + mix, '-map', '[out]', '-ac', '2', '-ar', '48000', file);
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
}
const beds = expandBeds();
writeFileSync(path.join(WORK, 'beds.json'), JSON.stringify(beds, null, 1));
buildLayer(beds, path.join(WORK, 'music.wav'), 0.62, (name) => path.join(ROOT, 'assets', 'music', name + '.ogg'));
buildLayer(AMBS.map((a) => ({ ...a, off: 0, fadeIn: 0.4 })), path.join(WORK, 'amb.wav'), 2.2, (name) => (ambFiles[name] ? path.join(ROOT, 'assets', 'sfx', ambFiles[name] + '.ogg') : null));
// sfx + music + ambience, then loudness to about -15 LUFS with the true peak under -1 dBTP (two passes)
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(WORK, 'sfx.wav'), '-i', path.join(WORK, 'music.wav'), '-i', path.join(WORK, 'amb.wav'),
  '-filter_complex', '[0:a]aresample=48000[s];[s][1:a][2:a]amix=inputs=3:normalize=0:duration=longest[o]', '-map', '[o]', '-ar', '48000', '-c:a', 'pcm_s24le', path.join(WORK, 'mix.wav')], { stdio: 'inherit' });
let ln = null;
try {
  const r = spawnSyncJSON(['-hide_banner', '-i', path.join(WORK, 'mix.wav'), '-af', 'loudnorm=I=-15:TP=-2:LRA=11:print_format=json', '-f', 'null', '-']);
  ln = r;
} catch (e) { console.warn('loudnorm measure failed', e.message); }
function spawnSyncJSON(args) {
  const out = execFileSync('sh', ['-c', `ffmpeg ${args.map((a) => `'${a}'`).join(' ')} 2>&1`], { encoding: 'utf8' });
  const m = out.slice(out.lastIndexOf('{'));
  return JSON.parse(m.slice(0, m.indexOf('}') + 1));
}
const lnf = ln ? `loudnorm=I=-15:TP=-2:LRA=11:measured_I=${ln.input_i}:measured_TP=${ln.input_tp}:measured_LRA=${ln.input_lra}:measured_thresh=${ln.input_thresh}:offset=${ln.target_offset}:linear=true` : 'loudnorm=I=-15:TP=-2:LRA=11';
// the sound fades out with the picture over the last 1.5 s
const outroAf = `,afade=t=out:st=${Math.max(0, duration - OUTRO / FPS).toFixed(3)}:d=${(OUTRO / FPS).toFixed(3)}`;
// (then a peak limiter at -3 dBFS on the few loudest transients: the AAC encode adds about a decibel to the true
// peak, which would otherwise land right at -1 dBTP)
const limAf = ',alimiter=limit=0.708:attack=1:release=60:level=false';
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(WORK, 'mix.wav'), '-af', lnf + limAf + outroAf + ',aresample=48000', '-ar', '48000', '-c:a', 'pcm_s16le', path.join(WORK, 'audio.wav')], { stdio: 'inherit' });

// ---------------------------------------------------------------- contact sheet, video
function sheet(step, file) {
  const files = readdirSync(FRAMES).filter((f) => f.endsWith('.png')).sort().filter((_, i) => i % step === 0);
  writeFileSync(path.join(WORK, 'sheet.txt'), files.map((f) => path.join(FRAMES, f)).join('\n'));
  execFileSync('python3', ['-c', `
import sys
from PIL import Image, ImageDraw
fs=open(sys.argv[1]).read().split('\\n'); cols=8; w,h=240,160
rows=-(-len(fs)//cols)
out=Image.new('RGB',(cols*w,rows*h))
d=ImageDraw.Draw(out)
for i,f in enumerate(fs):
    im=Image.open(f).convert('RGB').resize((w,h))
    out.paste(im,((i%cols)*w,(i//cols)*h))
    n=int(f.split('/')[-1][:5]); d.text(((i%cols)*w+3,(i//cols)*h+2), '%d %.1fs' % (n, n/30), fill=(255,255,0))
out.save(sys.argv[2])
`, path.join(WORK, 'sheet.txt'), file]);
  console.log('sheet', file);
}
if (process.env.PREVIEW || process.env.SHEET) sheet(Number(process.env.STEP || 10), process.env.SHEET || path.join(WORK, 'contact.png'));
if (!process.env.NOVIDEO) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(FRAMES, '%05d.png'), '-i', path.join(WORK, 'audio.wav'),
    '-vf', 'scale=1440:960:flags=neighbor', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'slow', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
  console.log(`wrote ${OUT}`);
}
