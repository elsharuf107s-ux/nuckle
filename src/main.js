// Pokémon Redstone: Minecraft's Steve in FireRed's Kanto, with everything Steve can do.
// The world is FireRed's real maps (tools/build_world.py); Steve, his blocks, items, mobs, HUD and
// screens are Minecraft's own assets (tools/build_minecraft.py); wild Pokémon, battles and menus are
// FireRed's (tools/build_pokemon.py).
import { A, loadAssets, loadGenAssets } from './assets.js';
import { G, TILE, DIRS, OPP, DIR_LIST, dirTo, MC_TICK } from './game.js';
import { World, blockLook, drawLook, lightOf, isDoor, PROT, tickingBlock } from './world.js';
import { makeLayout, wildMeta, kantoMeta } from './layout.js';
import { Inventory, item, toolOf, foodOf, breakInfo, nameOf, campfireOf } from './items.js';
import { initFont, drawText, textWidth } from './font.js';
import { mcText, mcWidth } from './mcfont.js';
import { VW, VH, FG, SH, drawWindow, cursorArrow, wrap, drawMessage, drawBanner, drawDex, drawTrainerCard, listHeight } from './ui.js';
import { drawHUD, drawStack, drawToast, HW, HH } from './hud.js';
import { Screen, tickFurnace } from './screens.js';
import * as E from './entities.js';
import * as PL from './player.js';
import { Input } from './input.js';
import { sfx, mc, music, ambience, cry, preloadMc, preloadCries, startRecording, renderRecording, setMusicMuted, isMusicMuted } from './audio.js';
import { roll, rateFor, EncounterClock } from './encounters.js';
import { Battle, steveMon, syncSteve, steveLevel } from './battle.js';
import { PartyScreen } from './partyui.js';
import { makeMon, species, healMon, reviveMon } from './data.js';
import * as RNG from './rng.js';
import { npcs, syncNPCs, npcAt, npcFacing, facePlayer, updateNPCs, npcSprites } from './npcs.js';
import { Mart } from './mart.js';
import { PCScreen } from './pc.js';
import { trySpawn, updateWild, wildSprites, wildAt, spawnWildAt, levelFor, capLevel, wildId } from './wild.js';
import * as NE from './nether.js';
import * as END from './end.js';
import * as DR from './dragon.js';
import { HallOfFame } from './hof.js';
import { drawSummary, drawDexEntry } from './summary.js';
import { NET, netHooks } from './net/flag.js';   // co-op: false in single-player; the rest of src/net/ loads on demand

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
const GBA = () => ctx.setTransform(2, 0, 0, 2, 0, 0);
const HI = () => ctx.setTransform(1, 0, 0, 1, 0, 0);

function fit() {
  const hint = document.getElementById('hint'), legal = document.getElementById('legal');
  const below = (el, gap) => (el && el.offsetParent ? el.offsetHeight + gap : 0);
  const availH = window.innerHeight - 16 - below(hint, 20) - below(legal, 8);
  const scale = Math.max(0.5, Math.min(window.innerWidth / HW, availH / HH));   // below 1 on portrait phones, so nothing is cropped
  const s = scale >= 2 ? Math.floor(scale) : scale;
  canvas.style.width = Math.round(HW * s) + 'px'; canvas.style.height = Math.round(HH * s) + 'px';
}
window.addEventListener('resize', fit);
fit();
ctx.fillStyle = '#000'; ctx.fillRect(0, 0, HW, HH);
const params = new URLSearchParams(location.search);
// (playfix: a Wild World boot says "Loading..." rather than "Loading Kanto..."; the request is only peeked at here)
const bootsWild = (() => {
  try {
    if (params.has('new')) return params.get('world') === 'wild';
    const q = JSON.parse(sessionStorage.getItem('rs.world') || 'null');
    const d = JSON.parse(localStorage.getItem('poke-redstone-worlds') || 'null');
    const typeOf = (id) => { const w = d && Array.isArray(d.worlds) ? d.worlds.find((x) => x && x.id === id) : null; return w ? w.type : null; };
    if (q && (q.op === 'new' || q.op === 'load')) return (q.type || (q.op === 'load' ? typeOf(q.id) : null)) === 'wild';
    if (d && d.last && d.last !== 'classic') return typeOf(d.last) === 'wild';
  } catch (e) { /* no storage */ }
  return false;
})();
ctx.fillStyle = '#888'; ctx.font = '12px monospace'; ctx.fillText(bootsWild ? 'Loading…' : 'Loading Kanto…', 16, 24);
// (playfix: a file that would not load, even after its retries, no longer leaves a frozen full bar)
// (playfix2: once failed, the other loads' progress and the loading screen no longer paint over the message; a
// generated world's failed boot shows it too, see bootFail)
let loadFailed = false;
function failScreen(notBuilt) {
  loadFailed = true;
  try { ctx.setTransform(1, 0, 0, 1, 0, 0); } catch (e) { /* as it is */ }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, HW, HH);
  ctx.fillStyle = '#ddd'; ctx.font = '12px monospace';
  if (notBuilt) {
    // a fresh clone: assets/ is made on the player's machine by ./setup.sh (see the README)
    ctx.fillText('The game files are not built yet.', 16, 24); ctx.fillText('Run ./setup.sh, then reload this page.', 16, 44);
    return;
  }
  ctx.fillText('Could not load the game.', 16, 24); ctx.fillText('Tap or press a key to retry.', 16, 44);
  const again = () => location.reload();
  canvas.addEventListener('pointerdown', again); window.addEventListener('keydown', again);
}
try {
  await loadAssets((k) => { if (loadFailed) return; ctx.fillStyle = '#000'; ctx.fillRect(0, 30, HW, 20); ctx.fillStyle = '#5a5'; ctx.fillRect(16, 34, (HW - 32) * k, 6); });
} catch (e) {
  const notBuilt = await fetch('assets/world/world.json', { method: 'HEAD' }).then((r) => r.status === 404).catch(() => false);
  failScreen(notBuilt);
  throw e;
}
initFont();
addSteveSpecies();
// The world is built from a descriptor (the world update's design, 7.1): its layout (src/layout.js) fixes the grid and
// the world.json data it reads. `?new`, `?play`, a saved game and a co-op guest's placeholder boot Classic Kanto,
// exactly as before. `?new&world=wild` (with `wseed`, blank for a random seed) boots a new Wild World (stage 4a; the
// title menus of stage 9 will make worlds too); `?new&world=kanto` boots a new Kanto World (stage 6a).
// Stage 4b: without `?new` (and not a co-op boot), a request from the title menus (sessionStorage 'rs.world', stage 9)
// or else the world list's last played generated world is loaded (7.1); with no world list, Classic as ever.
const LIST_KEY = 'poke-redstone-worlds';
let bootReqRaw = null;   // (playfix2: the title menus' request this boot took, put back if the boot fails)
// (playfix2: a dynamic import retried once, for a connection dropped under load; Chrome remembers a failed module
// fetch, so the retry asks a fresh URL, and later boot imports of that module use the URL that worked)
const importOK = {};
const importR = (path) => (importOK[path] ? import(importOK[path]) : import(path).then((m) => { importOK[path] = path; return m; }).catch(() =>
  new Promise((r) => setTimeout(r, 500)).then(() => { const u = path + '?retry=' + Date.now(); return import(u).then((m) => { importOK[path] = u; return m; }); })));
function genBootRequest() {
  try {
    const raw = sessionStorage.getItem('rs.world');
    if (raw) { sessionStorage.removeItem('rs.world'); bootReqRaw = raw; const q = JSON.parse(raw); if (q && (q.op === 'new' || q.op === 'load')) return { ...q, fromReq: true }; }
  } catch (e) { /* none */ }
  try {
    const d = JSON.parse(localStorage.getItem(LIST_KEY) || 'null');
    const e = d && d.v === 1 && Array.isArray(d.worlds) && d.last && d.last !== 'classic' ? d.worlds.find((w) => w && w.id === d.last) : null;
    if (e) return { op: 'load', id: e.id, type: e.type };
  } catch (e) { /* none */ }
  return null;
}
// Stage 9 / 6a: Kanto Worlds boot (stage 6a places Kanto in a generated world), so Create New World offers both types,
// Kanto World first. With this false, Create New World offers Wild World only and a Kanto World request boots Classic.
const KANTO_WORLDS = true;   // stage 6a: Kanto Worlds are built (makeGenWorld('kanto', seed))
const genKinds = () => (KANTO_WORLDS ? ['kanto', 'wild'] : ['wild']);
// a listed world's type (Select World's request carries only the id)
function listedType(id) {
  try { const d = JSON.parse(localStorage.getItem(LIST_KEY) || 'null'); const e = d && Array.isArray(d.worlds) ? d.worlds.find((w) => w && w.id === id) : null; return e ? e.type : null; } catch (e) { return null; }
}
function bootDesc() {
  if (NET.boot) return { kind: 'classic' };
  if (params.has('new')) {
    const wt = params.get('world');
    if (wt === 'wild' || (wt === 'kanto' && KANTO_WORLDS)) return { kind: wt, op: 'new', seedText: params.get('wseed') ?? '', mode: params.get('mode') || 'survival', diff: params.get('diff') || 'normal' };
    return { kind: 'classic' };
  }
  const q = genBootRequest();
  // Select World's Classic Kanto (stage 9): Classic as ever, and it becomes the last played world
  // (a world picked or made in the title's menus is played at once: fromReq)
  if (q && q.op === 'load' && q.id === 'classic') return { kind: 'classic', classicReq: true, fromReq: !!q.fromReq };
  // (a Kanto World request boots Classic only while KANTO_WORLDS is false)
  const kindOf = (t) => (genKinds().includes(t || 'wild') ? t || 'wild' : null);
  if (q && q.op === 'load' && kindOf(q.type || listedType(q.id))) return { kind: kindOf(q.type || listedType(q.id)), op: 'load', id: q.id, fromReq: !!q.fromReq };
  // Create New World's request (7.4): the boot makes the id, the list entry and a first save (fromMenu)
  if (q && q.op === 'new' && kindOf(q.type)) return { kind: kindOf(q.type), op: 'new', seedText: q.seedText ?? q.seed ?? '', name: q.name, mode: q.mode, diff: q.diff, fromMenu: true, fromReq: !!q.fromReq };
  return { kind: 'classic' };
}
function bootWorld(desc) { return new World(makeLayout(desc)); }
// Minecraft's loading lines over a dark screen (7.6): "Generating world", then "Preparing spawn area" with how much of it
// is ready.
// Stage 9: generated boots and co-op guests draw the world menus' LoadingScreen (dirt, percentage, the 3 x 3 chunk map,
// "Joining..." for a guest); `k` is the plan's progress, then the share of the spawn area ready. Other lines (the 8.4
// refusal) and anything before the menu module loads keep the plain screen.
let loadUI = null;
function loadingScreen(text, k) {
  if (loadFailed) return;
  if (loadUI && (text === 'Generating world' || text === 'Preparing spawn area')) {
    try {
      loadUI.joining = !!(NET.boot || NET.guest);
      if (text === 'Generating world') loadUI.set({ phase: 'plan', progress: k == null ? loadUI.progress : k });
      else loadUI.set({ phase: 'spawn', ready: (k || 0) * 9, total: 9 });
      HI(); loadUI.draw(ctx); return;
    } catch (e) { /* the plain screen below */ }
  }
  HI(); ctx.fillStyle = '#1b1610'; ctx.fillRect(0, 0, HW, HH);
  const line = k == null ? text : `${text}: ${Math.round(k * 100)}%`;
  // a line wider than the screen (the refusal of 8.4) is wrapped at its spaces
  const rows = [];
  for (const w of line.split(' ')) { const r = rows.length ? rows[rows.length - 1] + ' ' + w : w; if (rows.length && mcWidth(r, 2) > HW - 24) rows.push(w); else if (rows.length) rows[rows.length - 1] = r; else rows.push(w); }
  rows.forEach((r, i) => mcText(ctx, r, Math.round(HW / 2 - mcWidth(r, 2) / 2), Math.round(HH / 2 - 8 - (rows.length - 1) * 11 + i * 22), '#ffffff', true, 2));
}
// A generated world (7.1): the worker's plan ("Generating world"), the World on its plane, then the 3 x 3 data chunks
// around the spawn and the draw canvases of its view ("Preparing spawn area").
// A loaded world (stage 4b) reads its `v: 2` save first (worlds.js: IndexedDB or the localStorage fallback) for its
// descriptor `wd`; the save is applied after the World and the player exist (loadGen). A world made by a newer
// generator is refused (8.4): the line shows and Classic boots instead. Null then.
async function ensureLoadUI() {
  if (!loadUI) { try { const WMm = await import('./ui/worldmenu.js'); await WMm.loadMenuAssets(); loadUI = new WMm.LoadingScreen(); } catch (e) { noteError(e); } }
}
async function bootGenWorld(desc) {
  const t0 = performance.now();
  await ensureLoadUI();
  loadingScreen('Generating world', 0);
  const [{ seedOf }, WL, { GEN_VERSION }] = await Promise.all([importR('./gen/client.js'), importR('./worlds.js'), importR('./gen/version.js')]);
  G.worlds = WL; G.GEN_VERSION = GEN_VERSION;
  let wd, id, save = null;
  if (desc.op === 'load') {
    id = desc.id;
    save = await WL.loadWorld(id);
    const ent = WL.entryOf(id) || {};
    if (save && (save.v !== 2 || !save.wd)) save = null;
    const gv = save ? save.gen : ent.gen;
    if (Number.isFinite(gv) && gv > GEN_VERSION) {
      loadingScreen('This world was made with a newer version of the game.', null);
      await new Promise((r) => setTimeout(r, 3000));
      return null;
    }
    // (an entry whose save is gone starts again from its seed)
    wd = save ? save.wd : { type: ent.type || 'wild', seed: ent.seed | 0, seedText: ent.seedText ?? String(ent.seed | 0), name: ent.name || 'New World', mode: ent.mode || 'survival', diff: ent.diff || 'normal', created: ent.created || Date.now() };
  } else {
    id = WL.newId();
    const seed = seedOf(desc.seedText);
    wd = { type: desc.kind, seed, seedText: String(desc.seedText ?? ''), name: desc.name || 'New World', mode: desc.mode || 'survival', diff: desc.diff || 'normal', created: Date.now() };
  }
  const w = await makeGenWorld(desc.kind, wd.seed | 0);
  const gen = w.gen, stream = w.stream;
  w.wid = id; w.wd = wd; w.bootSave = save; w.genVersion = save && Number.isFinite(save.gen) ? save.gen : GEN_VERSION;
  // a loaded world: the boot is a play of it (8.1)
  if (desc.op === 'load') WL.touchEntry(id, { played: Date.now() });
  w.planWallMs = performance.now() - t0;
  // the spawn area: around the plan's spawn, or a loaded player's cell (2.13)
  const sp = save && save.P && Number.isInteger(save.P.tx) && Number.isInteger(save.P.ty) && w.inside(save.P.tx, save.P.ty) ? { px: save.P.tx, py: save.P.ty } : gen.plan.spawn;
  stream.onProgress = (k) => loadingScreen('Preparing spawn area', k);
  loadingScreen('Preparing spawn area', 0);
  await stream.ensure(sp.px, sp.py, 1);
  stream.onProgress = null;
  for (let cy = (sp.py - 8) >> 4; cy <= (sp.py + 8) >> 4; cy++) for (let cx = (sp.px - 10) >> 4; cx <= (sp.px + 10) >> 4; cx++) if (w.ready(cx * 16, cy * 16)) w.chunk(cx, cy);
  w.bootMs = performance.now() - t0;
  return w;
}
// The generated World itself from a type and a seed: the tile bank, the generator's client (the worker's plan), the
// World on its plane and its chunk streaming. Shared by the boot and a co-op guest's world (useWorld, 9.1).
async function makeGenWorld(kind, seed) {
  // stage 9: the loading screen (7.6) from the world menus' module, with the plan's progress in steps
  await ensureLoadUI();
  loadingScreen('Generating world', 0.05);
  const [{ startGen }, { Streamer }, CAVE] = await Promise.all([importR('./gen/client.js'), importR('./chunks.js'), importR('./gen/cave.js')]);
  loadingScreen('Generating world', 0.2);
  await loadGenAssets();
  loadingScreen('Generating world', 0.45);
  // a Kanto World (6a): the generator meets Kanto's block, so it gets Classic's arrays for it and every entry's class
  let kanto = null;
  if (kind === 'kanto') {
    const { kantoMatTable } = await importR('./gen/kanto.js');
    const n = A.world.outdoor.w * A.world.outdoor.h;
    kanto = { kantoZone: A.zone.slice(0, n), kantoGrid: A.grid.slice(0, n), kantoGround: A.ground.slice(0, n), kantoMat: kantoMatTable(A.world.entries) };
  }
  const gen = await startGen({ type: kind, seed, kanto }, A.terrain);
  loadingScreen('Generating world', 0.9);
  const w = new World(kind === 'kanto'
    ? makeLayout({ kind, kx: gen.plan.kanto.x, ky: gen.plan.kanto.y, meta: kantoMeta(gen.plan) })
    : makeLayout({ kind, meta: wildMeta(gen.plan) }));
  w.initRooms(CAVE.digCave, CAVE.CAVE_FAMILY);     // the caves' rooms (5b), before any save or snapshot is applied
  // the villages' interiors and furniture (7a), likewise; a farm's wheat follows the absolute time (2.12)
  try { w.initHouses(); } catch (e) { noteError('villages: ' + String((e && e.stack) || e)); }
  w.farmNow = () => G.day * 24000 + G.time;
  // villagers and iron golems (7b): their sheets and mob defs, a record per village (src/villagers.js, G.vil)
  try { const V = await import('./villagers.js'); G.vil = await V.install(w); } catch (e) { G.vil = null; noteError('villagers: ' + String((e && e.stack) || e)); }
  // trades (7c): the tables, the merchant screen's GUI and the generated worlds' Mart buy-back caps (design 5.6, 5.7, 20)
  try { const TU = await import('./tradeui.js'); await TU.loadTradeAssets(); G.tradeUI = TU; G.tradeData = TU.TA.data; G.martGen = TU.TA.data.martGen || null; } catch (e) { noteError('trades: ' + String((e && e.stack) || e)); }
  if (w.genErrors) for (const e of w.genErrors) noteError(e);
  if (gen.signP && !(params.has('video') && !params.has('signs'))) { try { const t1 = performance.now(), sg = await gen.signP; w.signWaitMs = performance.now() - t1; if (sg) (await importR('./kantosign.js')).install(w, sg); } catch (e) { noteError(e); } }   // a Kanto World's spawn sign (minimap design 2; the worker's answer after the plan, made meanwhile), before any chunk is applied; not in the films (signWaitMs: how long the boot waited for it once the World was built)
  const stream = new Streamer(w, gen);
  w.ensureHook = (x, y, r, sync) => stream.ensure(x, y, r, sync);
  w.gen = gen; w.stream = stream; w.seed = seed;
  w.popHook = (ck) => { if (w.popOn && !NET.guest) { try { stream.populate(ck, spawnHerd, E.cellFree); if (G.vil) G.vil.populate(); } catch (e) { noteError(e); } } };
  return w;
}
// Population and parking (2.11, stage 5c; generated layouts only). A herd animal is a persistent mob like Kanto's.
function spawnHerd(kind, x, y) { if (A.items.mobs[kind]) E.spawnMob(kind, x, y, { persistent: true }); }
const canPark = (e) => (e.type === 'mob' && e.persistent && !e.dying && !(G.vil && G.vil.owns(e))) || e.type === 'item' || (e.type === 'boat' && e.rider == null && P.riding !== e);
// one parking pass: far entities into world.parked, near parked chunks back (never throws to the loop)
function parkNow() {
  if (!world.parked || NET.guest) return;
  try { G.ents = world.stream.park(G.ents, NET.h ? NET.players() : [P], G.playTime, canPark); } catch (e) { noteError(e); }
}
// population on (after a save or a new world is in): the chunks already made get their herds now, later ones as they come
function popStart() {
  if (!world.layout.gen || NET.guest) return;
  world.popOn = true;
  try { world.stream.populateAll(spawnHerd, E.cellFree); if (G.vil) G.vil.populate(); } catch (e) { noteError(e); }
}
const BOOT = bootDesc();
// (playfix2: a generated world that fails to load (a file or module that would not come, even retried) shows the
// retry screen, with the title menus' request put back so the retry makes or opens that same world)
async function bootGenOrFail(desc) {
  try { return await bootGenWorld(desc); } catch (e) {
    try { if (bootReqRaw) sessionStorage.setItem('rs.world', bootReqRaw); } catch (e2) { /* the last played world boots */ }
    failScreen();
    throw e;
  }
}
let world = BOOT.kind === 'classic' ? bootWorld(BOOT) : (await bootGenOrFail(BOOT)) || bootWorld({ kind: 'classic' });
// Game modes (the world update's section 6, stage 8a): generated worlds only. Classic never loads these modules and
// keeps G.mr null, so every mode check (here, player.js, entities.js, hud.js, items.js) answers as before.
let [MODES, HC, MCG] = world.layout.gen ? await Promise.all([import('./modes.js'), import('./ui/hardcore.js'), import('./ui/mcgui.js')]) : [null, null, null];
// stage 8b (generated worlds only, like the three above): the creative inventory and START > OPTION's window
let [CR, OPT] = world.layout.gen ? await Promise.all([import('./ui/creative.js'), import('./ui/option.js')]) : [null, null];
// (stage 10: a co-op guest boots Classic's placeholder, so it loads these five when the host's generated world comes)
async function loadModeModules() {
  if (MODES) return;
  const m = await Promise.all([importR('./modes.js'), importR('./ui/hardcore.js'), importR('./ui/mcgui.js'), importR('./ui/creative.js'), importR('./ui/option.js')]);
  if (!MODES) [MODES, HC, MCG, CR, OPT] = m;
}
const input = new Input(canvas);
G.world = world; G.input = input; G.inv = new Inventory();
window.addEventListener('keydown', () => sfx.unlock(), { once: true });
window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });

// Steve shows up in FireRed's menus and battles as a party member of his own.
function addSteveSpecies() {
  A.dex.species.STEVE = { name: 'STEVE', base: [80, 80, 80, 50, 50, 60], types: ['MYSTERY', 'MYSTERY'], catchRate: 0, expYield: 0, growth: 'MEDIUM_FAST',
    learnset: [], front: { y: 0 }, back: { y: 0 }, elevation: 0, file: 'steve', id: 0 };
  // party icon: Steve's walking frames cut into FireRed's 32x32 two-frame icon layout
  const st = A.items.steve, icon = document.createElement('canvas');
  icon.width = 32; icon.height = 64;
  const g = icon.getContext('2d');
  const fr = st.poses.walk.down;
  [0, 1].forEach((k) => g.drawImage(A.mc.steve, fr[k] * st.w, 0, st.w, st.h, 4, 64 - 32 * (2 - k) - 1 + (k ? -1 : 0), st.w, st.h));
  const back = document.createElement('canvas'); back.width = 64; back.height = 64;
  back.getContext('2d').drawImage(A.mc.back, 0, 0, 64, 64, 0, 0, 64, 64);
  A.mon.STEVE = { icon, back, front: back };
}

// ---------------------------------------------------------------- world spawn and state
// (a generated world's spawn is the plan's, 3.14)
const pallet = world.layout.gen ? null : world.towns.find((t) => t.id === 'MAP_PALLET_TOWN');
G.worldSpawn = world.layout.gen ? { x: world.gen.plan.spawn.px, y: world.gen.plan.spawn.py } : { x: pallet.land.x, y: pallet.land.y };
const P = PL.makePlayer(G.worldSpawn.x, G.worldSpawn.y);
G.P = P;
// The End and the stronghold (src/end.js, src/dragon.js): their saved state, and the hooks the other modules call
END.initState();
G.useHook = (p, f, held, b) => END.safe('useHook', () => END.useHook(p, f, held, b)) || false;
G.useEndItem = (p, held, f) => END.safe('useEndItem', () => END.useEndItem(p, held, f)) || false;
G.onInfested = (x, y) => END.safe('infested', () => END.onInfested(x, y));
G.onSilverfishHurt = (m) => END.safe('silverfishHurt', () => END.onSilverfishHurt(m));
G.arrowHook = (a, tx, ty) => END.safe('arrowHook', () => DR.arrowHook(a, tx, ty)) || false;
G.fallIntoVoid = (x, y) => END.fallIntoVoid(x, y);
G.toEnd = () => enterEnd();
G.fromEnd = () => exitEnd();
G.onTeleported = () => { updateCamera(); if (followerMon() && !P.swimming) { placeFollowerNear(P.tx, P.ty); follower.visible = true; } if (G.mr) autosave('teleport'); };
G.endFade = 0;
// an open-water tile for water buckets: the commonest interior sea tile of outdoor Kanto
G.waterTile = world.layout.gen ? A.terrain.waterTile : (() => { const c = new Map(), n = world.outdoor.w * world.outdoor.h; for (let i = 0; i < n; i += 7) { const t = world.grid[i]; if (world.entries[t][4] === 'water' && !world.entries[t][6]) c.set(t, (c.get(t) || 0) + 1); } return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]; })();

// ---------------------------------------------------------------- game modes (6.1 to 6.4; generated worlds only)
// G.mode / G.diff and G.mr, the rule flags of src/modes.js for them. Classic: G.mr null.
G.mr = null;
let hcScreen = null, specOverlay = null;
function setMode(m, d) {
  if (!MODES) return;
  const st = MODES.normalize({ mode: m, diff: d });
  G.mode = st.mode; G.diff = st.diff; G.mr = MODES.rules(st.mode, st.diff);
  G.inv.infinite = !G.mr.itemsUsedUp;                       // Creative: nothing used up, no tool wear
  G.mobDmg = (dmg) => MODES.mobDamage(dmg, G.diff);          // entities.js: a mob's hit by difficulty
  P.hidden = !G.mr.hostilesSee;                              // entities.js canSee: hostiles ignore him
  // hud.js draws hardcore hearts (G.mr.hud 'hardcore') once their textures are in; the usual hearts until then
  if (!G.hcHearts) MCG.loadMenuAssets().then(() => { G.hcHearts = HC.drawHardcoreHearts; }, () => {});
  if (world.wd) { world.wd.mode = st.mode === 'spectator' ? 'hardcore' : st.mode; world.wd.diff = st.diff; }
  // co-op (9.1, stage 10): the host's difficulty is everyone's; a change goes to the guests in a fresh `wd`
  if (NET.on && NET.s && NET.s.role === 'host' && NET.s.resendWd) { try { NET.s.resendWd(); } catch (e) { noteError(e); } }
}
// Creative's WILD POKeMON option (6.5; the OPTION row is stage 8b's): wild POKeMON appear and step encounters run
const wildOn = () => !G.mr || MODES.encountersOn(G.mode, G.wildOpt);
// The boot: the mode a world starts in. A world whose list entry or save says its hardcore player died is a
// spectator's, whatever the save's mode says (6.4).
function initModes(bootHc) {
  if (!MODES || !world.layout.gen) return;
  const wd = world.wd || {}, e = G.worlds && world.wid ? G.worlds.entryOf(world.wid) : null;
  G.wildOpt = wd.wild !== false;
  G.lastAuto = G.playTime;
  const m = MODES.bootMode({ ...(e || {}), id: world.wid, type: wd.type || 'wild', mode: wd.mode }, bootHc ? { hc: bootHc } : null);
  setMode(m, wd.diff);
  if (m === 'spectator') {
    G.hc = (e && e.hc) || bootHc || { dead: true, at: Date.now(), cause: '' };
    P.health = 20;
    specOverlay = new HC.SpectatorOverlay({ cause: G.hc.cause });
  }
}
// A co-op guest's mode (9.1, 9.5; stage 10): the host's descriptor's mode and difficulty, or a spectator's when this
// device's player id or this name is on the host's dead list for the session (a hardcore guest who died). Later
// descriptors (a difficulty change) only change the difficulty.
function coopModes(wd, hcDead) {
  if (!MODES || !NET.guest || !world.layout.gen || !wd) return;
  G.wildOpt = wd.wild !== false;
  if (G.mode === 'spectator') { setMode('spectator', 'hard'); return; }
  const me = String(G.myName || '').toUpperCase(), pid = NET.s && NET.s.pid ? NET.s.pid() : '';
  const dead = wd.mode === 'hardcore' && hcDead && typeof hcDead === 'object'
    && ((Array.isArray(hcDead.p) && pid && hcDead.p.includes(pid)) || (Array.isArray(hcDead.n) && hcDead.n.includes(me)));
  if (!dead) { setMode(wd.mode, wd.diff); return; }
  G.hc = { dead: true, at: Date.now(), cause: '' };
  setMode('spectator', 'hard');
  P.dead = false; P.health = 20;
  specOverlay = new HC.SpectatorOverlay({ cause: '' });
}
// Hardcore autosave (6.4): every 45 s of play, on every warp, portal and teleport, and at the start of every battle.
// One write at a time; a request during a write runs once it lands.
G.autosaves = [];
function autosave(reason) {
  if (!G.mr || !G.mr.autosave || NET.guest || !world.layout.gen) return;
  G.lastAuto = G.playTime;
  if (G.autoBusy) { G.autoNext = reason; return; }
  G.autoBusy = true;
  G.autosaves.push({ reason, t: G.playTime, at: Date.now() });
  if (G.autosaves.length > 30) G.autosaves.shift();
  let p;
  try { p = Promise.resolve(saveGame()); } catch (err) { noteError(err); p = Promise.resolve(false); }
  p.then((ok) => { G.autosaves[G.autosaves.length - 1].ok = ok; }, () => {}).finally(() => {
    G.autoBusy = false;
    if (G.autoNext) { const r = G.autoNext; G.autoNext = null; autosave(r); }
  });
}
// The hardcore death (6.4), the moment it happens: the world list's dead marker first (small, synchronous), then
// the full save with the same marker. A failed save or a reload cannot undo it.
function hardcoreDied() {
  const cause = P.deathMsg || `${P.name} died`, at = Date.now();
  G.hc = { dead: true, at, cause };
  G.hcLog = ['dead'];
  const WL = G.worlds;
  if (WL && world.wid && !NET.guest) {
    const wd = world.wd || {};
    const base = WL.entryOf(world.wid) || { name: wd.name, type: wd.type, seed: wd.seed, seedText: wd.seedText, mode: wd.mode, diff: wd.diff,
      gen: world.genVersion, created: wd.created, played: at, playTime: Math.max(0, G.playTime || 0) };   // (playfix: never negative)
    WL.touchEntry(world.wid, MODES.hardcoreDeath(base, cause, at));
    G.hcLog.push(WL.entryOf(world.wid)?.hc?.dead ? 'marker' : 'marker-failed');
  }
  G.hcLog.push('save');
  autosave('death');
  // a co-op guest (9.5, stage 10): the host puts this device's player id and name on the session's dead list
  if (NET.guest && NET.s && NET.s.hcDied) { try { NET.s.hcDied(cause); } catch (e) { noteError(e); } }
}
// "Spectate World" or "Title Screen" on the hardcore death screen: his things stay where he fell, and from now on
// he is a spectator there (Title Screen too: loading a dead hardcore world always starts in spectator).
function hardcoreChoice(op) {
  hcScreen = null; deathUI = null;
  if (!P.netDropped) deathDrops();
  const at = P.deathDrop || { x: P.tx, y: P.ty }, dir = P.dir;
  Object.assign(P, PL.makePlayer(at.x, at.y));
  if (G.myName) P.name = G.myName;
  P.dir = dir; P.deathMsg = null; delete P.voidFall; delete P.deathDrop; delete P.netDropped;
  G.portalT = 0;
  setMode('spectator', 'hard');
  specOverlay = new HC.SpectatorOverlay({ cause: G.hc ? G.hc.cause : '' });
  arriveArea(true);
  autosave('spectate');
  if (op === 'title' && NET.guest && NET.s) { state = 'play'; NET.s.leave(); return; }   // (a guest: home, out of the room)
  if (op === 'title') { titleLeft = true; state = 'title'; titleT = 0; music.play('title'); } else state = 'play';
}
// A spectator moves (through walls, inside the current place), takes warps and portals, opens START; nothing else.
function spectate(dt) {
  if (input.just('start') && !P.moving) { state = 'menu'; menuCursor = 0; sfx.select(); return; }
  const stepDone = PL.updateActor(P, dt);
  if (stepDone) { G.travelled = false; onStep(); if (G.travelled) { G.travelled = false; return; } }
  if (P.moving) return;
  const dir = input.dir();
  if (!dir) { P.turnHold = 0; return; }
  if (dir !== P.dir && input.just(dir)) { P.dir = dir; P.turnHold = 0.09; return; }
  if (P.turnHold > 0) { P.turnHold -= dt; return; }
  if (tryWarpFrom(dir)) return;
  if (!PL.tryStep(P, dir, input) && input.just(dir) && state === 'play') sfx.bump();
}
// Peaceful (6.2): natural hostiles vanish (spawner blazes and silverfish stay, and endermen)
const PEACE_GONE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'ghast', 'magma_cube', 'wither_skeleton', 'husk', 'stray']);
let peaceSweep = 0;
function modeTick(dt) {
  const mr = G.mr;
  if (!mr) return;
  if (mr.oneLife && P.dead && !G.hc) hardcoreDied();
  if (!mr.naturalHostiles && (peaceSweep += dt) >= 0.5) { peaceSweep = 0; for (const e of G.ents) if (e.type === 'mob' && PEACE_GONE.has(e.kind) && !e.dying) e.dead = true; }
  if (state === 'play' && MODES.autosaveDue(G.mode, G.playTime, G.lastAuto || 0)) autosave('timer');
  if (specOverlay) specOverlay.update(dt);
}

let state = params.has('play') || (BOOT.fromReq && !NET.boot && (BOOT.kind === 'classic' || world.layout.gen)) ? 'play' : 'title';
let time = 0;
let msg = null, yesno = null;
let menuCursor = 0, dexCursor = 0;
let screen = null, partyUI = null;
let seq = null;
let mart = null;
let pcUI = null;               // the POKéMON CENTER's PC (pc.js)
let banner = { text: '', t: 99 };
let lastArea = null;
let fade = 0;
const clock = new EncounterClock();
let forcedEncounter = null;
let tickAcc = 0;
let parkAcc = 0;   // generated layouts: seconds since the last parking pass (2.11)
let deathUI = null;
let titleT = 0;
// co-op on the title: JOIN CO-OP under PRESS START (left out of the video renders, which open with &video)
const coopTitle = !params.has('video');
let titleSel = 0;
let summaryMon = null, dexKey = null;

function showBanner(text) { if (text && text !== banner.text) { banner.text = text; banner.t = 0; } }
function say(text, then) {
  const lines = wrap(text, VW - 28);
  const pages = []; for (let i = 0; i < lines.length; i += 2) pages.push(lines.slice(i, i + 2));
  msg = { pages, page: 0, shown: 0, then, from: state === 'msg' ? (msg ? msg.from : 'play') : state };
  state = 'msg';
}
function ask(text, onYes, onNo, noFirst) { say(text, null); msg.ask = { onYes, onNo, noFirst: !!noFirst }; }   // (playfix: noFirst puts the cursor on NO for a destructive question)
G.say = say; G.ask = ask;
G.toast = (text, color) => { G.actionBar = { text, t: 3, color }; };
G.giveXp = (n) => PL.giveXp(P, n);
G.hurtPlayer = (dmg, cause, from, ranged, opts) => PL.hurtPlayer(P, dmg, cause, from, ranged, opts);
G.busy = () => !(state === 'play' || state === 'screen');
G.npcAt = npcAt;
G.wildAt = wildAt;
G.dropStack = (s, thrown) => E.dropItem(s.id, s.n, P.tx * TILE, P.ty * TILE, s.dmg ? { dmg: s.dmg } : {}, { thrown, delay: thrown ? 2 : 0.5 });
G.addCaught = (mon) => { setTimeout(() => {}, 0); G.pendingCatchToast = true; G.dex.caught.add(mon.species); G.dex.seen.add(mon.species); if (G.party.length < 5) { G.party.push(mon); return 'party'; } G.pc.push(mon); return 'pc'; };
G.openScreen = (kind, target) => {
  // Creative (6.3): E and BAG open the creative inventory instead (the survival inventory is its last tab)
  if (kind === 'inventory' && CR && G.mr && G.mr.creativeInventory) { screen = new CR.CreativeScreen(G); state = 'screen'; mc('click', { vol: 0.1 }); return; }
  screen = new Screen(G, kind, target); state = 'screen'; if (kind === 'inventory') mc('click', { vol: 0.1 });
};
// Trades (the world update, 7c; design 5.6, 5.7, 9.4): Z or X on a villager with a profession opens Minecraft's merchant
// screen on it (villagers.js talk). A co-op guest asks the host first ('tro'); the host's answer opens it (showTrade).
G.showTrade = (v, opts) => { if (!G.tradeUI || state !== 'play') return false; screen = new G.tradeUI.TradeScreen(G, v, opts || {}); state = 'screen'; return true; };
G.openTrade = (m) => {
  if (!G.tradeUI || !G.tradeData || !m || state !== 'play') return false;
  if (NET.guest) return !!(NET.s && NET.s.world && NET.s.world.openTrade && NET.s.world.openTrade(m));
  return G.showTrade(m, { onTrade: (v, key, r) => { if (r && r.leveled && G.vil) G.vil.celebrate(v); } });
};

// ---------------------------------------------------------------- advancements (Minecraft's toasts)
const ADV = {
  minecraft: { title: 'Minecraft', icon: 'crafting_table' },
  stone_age: { title: 'Stone Age', icon: 'cobblestone' },
  upgrade: { title: 'Getting an Upgrade', icon: 'stone_pickaxe' },
  hardware: { title: 'Acquire Hardware', icon: 'iron_ingot' },
  iron_pick: { title: "Isn't It Iron Pick", icon: 'iron_pickaxe' },
  diamonds: { title: 'Diamonds!', icon: 'diamond' },
  monster_hunter: { title: 'Monster Hunter', icon: 'iron_sword' },
  sweet_dreams: { title: 'Sweet Dreams', icon: 'white_bed' },
  seedy: { title: 'A Seedy Place', icon: 'wheat_seeds' },
  fishy: { title: 'Fishy Business', icon: 'fishing_rod' },
  suit_up: { title: 'Suit Up', icon: 'iron_chestplate' },
  cover_me: { title: 'Cover Me with Diamonds', icon: 'diamond_chestplate' },
  take_aim: { title: 'Take Aim', icon: 'bow' },
  craft_ball: { title: "Gotta Craft 'Em All", icon: 'poke_ball' },
  catch: { title: "Gotta Catch 'Em All", icon: 'poke_ball', kind: 'challenge' },
  // the Nether
  nether: { title: 'We Need to Go Deeper', icon: 'obsidian' },
  hot_stuff: { title: 'Hot Stuff', icon: 'lava_bucket' },
  return_to_sender: { title: 'Return to Sender', icon: 'fire_charge', kind: 'challenge' },
  into_fire: { title: 'Into Fire', icon: 'blaze_rod' },
  hidden_depths: { title: 'Hidden in the Depths', icon: 'ancient_debris' },
  cover_debris: { title: 'Cover Me in Debris', icon: 'netherite_chestplate', kind: 'goal' },
  // The End
  eye_spy: { title: 'Eye Spy', icon: 'eye_of_ender' },
  end_q: { title: 'The End?', icon: 'end_stone' },
  free_end: { title: 'Free the End', icon: 'dragon_egg', kind: 'goal' },
  next_gen: { title: 'The Next Generation', icon: 'dragon_egg', kind: 'goal' },
  end_again: { title: 'The End... Again...', icon: 'end_crystal', kind: 'goal' },
  dragon_tamer: { title: 'Dragon Tamer', icon: 'dragon_egg', kind: 'challenge' },
};
G.advancements = new Set();
const toasts = [];
G.advance = (key) => {
  if (G.advancements.has(key) || !ADV[key]) return;
  G.advancements.add(key);
  toasts.push({ ...ADV[key], kind: ADV[key].kind || 'task', t: 0, played: false });
};
G.onCraft = (id) => {
  if (id === 'crafting_table') G.advance('minecraft');
  if (id === 'stone_pickaxe') G.advance('upgrade');
  if (id === 'iron_pickaxe') G.advance('iron_pick');
  if (id === 'poke_ball' || id === 'great_ball' || id === 'ultra_ball') G.advance('craft_ball');
};
G.onSmelt = (id) => { if (id === 'iron_ingot') G.advance('hardware'); };
G.onPickup = (id) => { if (id === 'dragon_egg') G.advance('next_gen'); if (id === 'diamond') G.advance('diamonds'); if (id === 'blaze_rod') G.advance('into_fire'); if (id === 'ancient_debris') G.advance('hidden_depths'); };
G.onBreak = (tg, harvest) => { const t = toolOf(G.inv.held); if (harvest && t && t.kind === 'pickaxe' && (tg.mat === 'rock' || tg.mat === 'boulder')) G.advance('stone_age'); };
G.onKill = (kind) => { if (E.HOSTILE.has(kind)) G.advance('monster_hunter'); };
G.onPlant = () => G.advance('seedy');
G.onArrowHit = () => G.advance('take_aim');
function updateToasts(dt) {
  // like Minecraft, several toasts stack down the right edge, each on its own timer
  for (let i = 0; i < Math.min(3, toasts.length); i++) {
    const t = toasts[i];
    if (!t.played) { t.played = true; mc(t.kind === 'challenge' ? 'challenge' : 'toast_in', { vol: t.kind === 'challenge' ? 0.6 : 0.8 }); }
    t.t += dt;
  }
  while (toasts.length && toasts[0].t >= 5.6) toasts.shift();
  // armour milestones are checked here rather than at every equip path
  if (G.inv.armor.some((a) => a && a.id.startsWith('iron_'))) G.advance('suit_up');
  if (G.inv.armor.some((a) => a && a.id.startsWith('diamond_'))) G.advance('cover_me');
  if (G.inv.armor.every((a) => a && a.id.startsWith('netherite_'))) G.advance('cover_debris');
}

// ---------------------------------------------------------------- the POKéMON that walks behind Steve
const follower = { tx: 0, ty: 0, fx: 0, fy: 0, fromX: 0, fromY: 0, moving: false, prog: 0, speed: 0.24, dist: 1, dir: 'down', visible: false, hop: 0 };
G.follower = follower;
const followerMon = () => G.party.find((m) => m.hp > 0) || null;
function placeFollowerNear(x, y) {
  for (const d of ['down', 'left', 'right', 'up']) {
    const nx = x + DIRS[d].x, ny = y + DIRS[d].y;
    if (PL.canEnter({ riding: null }, nx, ny) === 'walk' && !world.pcDoor(nx, ny)) { PL.placePlayer(follower, nx, ny, OPP[d]); return true; }
  }
  PL.placePlayer(follower, x, y); return false;
}
function followerStep(prevX, prevY) {
  if (!followerMon() || P.swimming || P.riding) { follower.visible = false; return; }
  if (!follower.visible) { placeFollowerNear(prevX, prevY); follower.visible = true; PL.placePlayer(follower, prevX, prevY, P.dir); return; }
  const dx = prevX - follower.tx, dy = prevY - follower.ty;
  if (follower.tx === P.tx && follower.ty === P.ty) { PL.placePlayer(follower, prevX, prevY, P.dir); return; }
  if (dx === 0 && dy === 0) return;
  if (Math.abs(dx) + Math.abs(dy) > 2 || (dx && dy)) { PL.placePlayer(follower, prevX, prevY, P.dir); return; }
  follower.dir = dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up';
  follower.fromX = follower.tx; follower.fromY = follower.ty; follower.tx = prevX; follower.ty = prevY;
  follower.moving = true; follower.prog = 0; follower.dist = Math.abs(dx) + Math.abs(dy); follower.speed = P.speed;
}
const owCache = new Map();
function owFrame(sp, dir, i, shiny = false) {
  const key = sp + dir + i + (shiny ? 's' : '');
  if (owCache.has(key)) return owCache.get(key);
  const img = A.mon[sp] && ((shiny && A.mon[sp].owShiny) || A.mon[sp].ow);
  if (!img) return null;
  // six-frame sheets mirror left for right; eight-frame sheets (CUBONE, KRABBY...) have their own
  const eight = img.width >= img.height * 8;
  const idx = { down: [0, 1], up: [2, 3], left: [4, 5], right: eight ? [6, 7] : [4, 5] }[dir][i];
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  if (dir === 'right' && !eight) { g.translate(32, 0); g.scale(-1, 1); }
  g.drawImage(img, idx * 32, 0, 32, 32, 0, 0, 32, 32);
  owCache.set(key, c);
  return c;
}
function drawFollower(c) {
  const m = followerMon();
  if (!m || !follower.visible || P.sleeping || P.dead) return;
  const f = owFrame(m.species, follower.dir, follower.moving ? Math.floor(follower.prog * 2) % 2 : Math.floor(G.clock * 2) % 2);
  if (!f) return;
  // the ENDER DRAGON hovers behind him, bobbing on its wingbeat, its shadow on the ground; the WITHER floats, slower
  const hover = m.species === 'ENDER_DRAGON' ? 6 + Math.sin(G.clock * 4.2) * 1.5 : m.species === 'WITHER' ? 5 + Math.sin(G.clock * 2.4) * 1.5 : 0;
  const lift = (follower.moving && follower.dist === 2 && !PL.frameHop(follower) ? Math.sin(follower.prog * Math.PI) * 8 : 0) + hover;
  ctx.fillStyle = hover ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.18)';
  ctx.beginPath(); ctx.ellipse(Math.round(follower.fx * TILE + 8 - c.x), Math.round(follower.fy * TILE + 13 - c.y), hover ? 7 : 6, 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.drawImage(f, Math.round(follower.fx * TILE - 8 - c.x), Math.round(follower.fy * TILE - 16 - c.y - lift - follower.hop));
  PL.drawGrassOver(ctx, follower.tx, follower.ty, follower.moving, c);
}

// ---------------------------------------------------------------- day and night
// Minecraft's clock: 24000 ticks a day, here at twice the speed (a day is ten minutes).
G.timeScale = 2;
G.isDay = () => G.time < 12542 || G.time >= 23460;
function skyLevel(t = G.time) {
  if (t < 12000) return 15;
  if (t < 13800) return 15 - (t - 12000) / 1800 * 11;
  if (t < 22200) return 4;
  return 4 + (t - 22200) / 1800 * 11;
}
// Indoors there's no sky; caves are dim (Rock Tunnel, which FireRed lights with FLASH, nearly dark).
function skyAt(x, y) {
  const r = world.roomAt(x, y);
  if (!r || r.kind === 'field') return skyLevel();
  if (r.kind === 'indoor') return 15;
  if (r.kind === 'nether') return 7;           // no sky, no day or night: a constant dim glow
  if (r.kind === 'end') return 11;             // The End: fixed, slightly dim, no day or night
  return r.flash ? 1 : 5;                      // caves, and the stronghold (lit by its wall torches)
}
G.skyAt = skyAt;
G.hasSky = (x, y) => { const r = world.roomAt(x, y); return !r || r.kind === 'field'; };
G.lightAt = (x, y) => Math.max(Math.round(skyAt(x, y)), world.blockLight(x, y));
const lightCanvas = document.createElement('canvas');
const lightCtx = lightCanvas.getContext('2d');
const glowCanvas = document.createElement('canvas');          // the Nether's additive glow around its light sources
const glowCtx = glowCanvas.getContext('2d');
const lightSrc = { i: -1 };
function drawLighting(cam) {
  const room = world.roomAt(P.tx, P.ty), cave = room && (room.kind === 'cave' || room.kind === 'stronghold'), nether = room && room.kind === 'nether', endR = room && room.kind === 'end';
  const sky = skyAt(P.tx, P.ty);
  const dusk = room ? 0 : G.time > 10500 && G.time < 13800 ? Math.sin(Math.PI * (G.time - 10500) / 3300) : G.time > 22000 ? Math.sin(Math.PI * (G.time - 22000) / 2000) * 0.8 : 0;
  if (sky >= 15 && dusk <= 0.01) return;
  const tw = Math.ceil(VW / TILE) + 3, th = Math.ceil(VH / TILE) + 3;
  if (lightCanvas.width !== tw) { lightCanvas.width = tw; lightCanvas.height = th; }
  const x0 = Math.floor(cam.x / TILE) - 1, y0 = Math.floor(cam.y / TILE) - 1;
  const img = lightCtx.createImageData(tw, th);
  const n = 1 - sky / 15;
  const flick = 0.96 + 0.04 * Math.sin(G.clock * 9.1) * Math.sin(G.clock * 5.3);
  // night is blue; a cave is a plain dark grey
  let sr = cave ? 255 * (1 - 0.82 * n) : 255 * (1 - 0.8 * n) * (1 - 0.0 * dusk), sg = cave ? 255 * (1 - 0.8 * n) : 255 * (1 - 0.72 * n) * (1 - 0.16 * dusk), sb = cave ? 255 * (1 - 0.76 * n) : 255 * (1 - 0.42 * n) * (1 - 0.3 * dusk);
  // The End: a fixed, slightly dim purple
  // (light 11: end stone keeps its pale yellow, a little dimmer, with a violet cast)
  if (endR) { sr = 255 * (1 - 0.46 * n); sg = 255 * (1 - 0.44 * n); sb = 255 * (1 - 0.3 * n); }
  if (!nether) {
    for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
      const bl = world.lights.size ? world.blockLight(x0 + i, y0 + j) : 0;
      const f = Math.pow(bl / 15, 1.4) * flick;
      const k = (j * tw + i) * 4;
      img.data[k] = Math.max(sr, 255 * f); img.data[k + 1] = Math.max(sg, 214 * f); img.data[k + 2] = Math.max(sb, 160 * f); img.data[k + 3] = 255;
    }
  } else {
    // The Nether: a warm red-brown dimness (level 7). Light above that level counts from the ambient up, so a
    // glowstone, lava, fire or soul fire lights its surroundings as it would anywhere else, and the dark netherrack
    // also gets an additive glow (warm, or blue near soul fire) because multiplying alone can't brighten it much.
    sr = 255 * (1 - 0.56 * n); sg = 255 * (1 - 0.78 * n); sb = 255 * (1 - 0.84 * n);
    if (glowCanvas.width !== tw || glowCanvas.height !== th) { glowCanvas.width = tw; glowCanvas.height = th; }
    const gimg = glowCtx.createImageData(tw, th);
    for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
      lightSrc.i = -1;
      // every lava cell is a light of 15 itself, so the middle of a lake is as bright as its shores
      const bl = world.isLava(x0 + i, y0 + j) ? 15 : world.lights.size ? world.blockLight(x0 + i, y0 + j, lightSrc) : 0;
      const t = bl > 7 ? Math.pow((bl - 7) / 8, 0.9) * flick : 0;
      const k = (j * tw + i) * 4;
      img.data[k] = sr + (255 - sr) * t; img.data[k + 1] = sg + (222 - sg) * t; img.data[k + 2] = sb + (176 - sb) * t; img.data[k + 3] = 255;
      if (t > 0) {
        const src = lightSrc.i >= 0 ? world.blocks.get(lightSrc.i) : null, soul = src && src.id === 'soul_fire';
        const a = Math.pow(t, 1.5);
        if (soul) { gimg.data[k] = 30; gimg.data[k + 1] = 120; gimg.data[k + 2] = 190; }
        else { gimg.data[k] = 190; gimg.data[k + 1] = 78; gimg.data[k + 2] = 18; }
        gimg.data[k + 3] = Math.round(255 * 0.32 * a);
      }
    }
    glowCtx.putImageData(gimg, 0, 0);
  }
  lightCtx.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(lightCanvas, 0, 0, tw, th, x0 * TILE - cam.x + 8, y0 * TILE - cam.y + 8, tw * TILE, th * TILE);
  if (nether) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(glowCanvas, 0, 0, tw, th, x0 * TILE - cam.x + 8, y0 * TILE - cam.y + 8, tw * TILE, th * TILE);
  }
  ctx.restore();
  ctx.imageSmoothingEnabled = false;
  if (nether) {
    // a subtle haze: warm air thickening toward the bottom of the view, slowly breathing
    const k = 0.07 + 0.025 * Math.sin(G.clock * 0.7);
    const g = ctx.createLinearGradient(0, 0, 0, VH);
    g.addColorStop(0, `rgba(120,30,12,${k * 0.5})`); g.addColorStop(1, `rgba(150,46,16,${k * 1.4})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
  }
}

// ---------------------------------------------------------------- world simulation
const isSapling = (id) => typeof id === 'string' && id.endsWith('_sapling');   // oak and the world update's five woods
const cropCells = () => { if (world.ticking) return tickingCells(); const out = []; for (const [i, b] of world.blocks) if (b.crop || isSapling(b.id) || b.id === 'fire' || b.id === 'furnace' || b.id === 'campfire' || b.id === 'nether_wart') out.push([i, b]); return out; };
// Generated layouts (2.12, stage 5c): the ticking index instead of every block, only the cells within 96 (Chebyshev)
// of a player, as Minecraft ticks only near players (a stale entry, its block gone or changed, is dropped here)
function tickingCells() {
  const out = [], W = world.W, ps = NET.h ? NET.players() : [P];
  for (const i of world.ticking) {
    const b = world.blocks.get(i);
    if (!b || !tickingBlock(b)) { world.ticking.delete(i); continue; }
    const x = i % W, y = (i / W) | 0;
    for (const p of ps) if (Math.abs(x - p.tx) <= 96 && Math.abs(y - p.ty) <= 96) { out.push([i, b]); break; }
  }
  return out;
}
function mcTick() {
  G.tick++;
  if (state === 'play' || state === 'screen') PL.survivalTick(P);
  if (G.tick % 2 === 0 && !NET.guest) {   // (a co-op guest's blocks are the host's: it grows and burns nothing itself)
    // the Nether's fires and warts only live while Steve is there (and spend no randomness otherwise)
    const netherHere = NET.h ? NET.h.anyIn('nether') : world.inNether(P.tx, P.ty);   // (co-op host: anyone there)
    for (const [i, b] of cropCells()) {
      const x = i % world.W, y = (i / world.W) | 0;
      if (b.id === 'furnace') {
        const was = b.burn > 0, k0 = NET.h ? furnaceKey(b) : null;
        tickFurnace(b); tickFurnace(b);
        if (was !== b.burn > 0) world.setBlock(x, y, b);
        else if (NET.h && furnaceKey(b) !== k0) world.touch(x, y);   // co-op: its slots changed
        if (b.burn > 0 && Math.random() < 0.02 && Math.hypot(x - P.tx, y - P.ty) < 8) mc('furnace', { vol: 0.25 });
      } else if (b.crop) {
        if (b.crop.stage < 7 && Math.random() < 0.012) { b.crop.stage++; world.setBlock(x, y, b); }
      } else if (isSapling(b.id)) {
        b.t = (b.t || 0) + 0.1;
        if (b.t > 90 && Math.random() < 0.01) growSapling(x, y);
      } else if (b.id === 'campfire') {
        // four spots cook in 30 s each and pop the cooked food out; unlit, the heat drains away
        for (let k = 0; k < 4; k++) {
          const s = b.items && b.items[k];
          if (!s) continue;
          if (b.lit) { s.t += 2; if (s.t >= 600) { E.dropItem(campfireOf(s.id), 1, x * TILE, y * TILE); b.items[k] = null; world.touch(x, y); } }
          else s.t = Math.max(0, s.t - 4);
        }
        if (b.lit && Math.abs(x - P.tx) <= 16 && Math.abs(y - P.ty) <= 12) {
          if (Math.random() < 0.25) E.particle({ x: x * TILE + 8 + (Math.random() - 0.5) * 8, y: y * TILE + 4, z: 8, vz: 10 + Math.random() * 4, vx: (Math.random() - 0.5) * 3, life: 3 + Math.random() * 2, img: A.mc.pSmoke, frames: 12, fw: 16, size: 0, scale: 1.1 });
          if (Math.random() < 1 / 30) mc('campfire', { vol: (0.5 + Math.random()) * 0.5, pitch: 0.6 + Math.random() * 0.7 });
        }
      } else if (b.id === 'fire') {
        b.t = (b.t || 0) + 0.1;
        // on netherrack fire burns forever, and now and then catches the netherrack beside it
        // (fires a blast left behind burn out like any other, so a ghast fight doesn't leave the wastes ablaze)
        if (world.eternalFire(x, y) && !b.blast) {
          if (!b.gen && G.rules.nether !== false && netherHere && Math.random() < 0.002 && (b.kids || 0) < 2) {
            const [dx, dy] = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)];
            const nx = x + dx, ny = y + dy;
            if (world.eternalFire(nx, ny) && !world.block(nx, ny) && !world.noPlace(nx, ny) && !(nx === P.tx && ny === P.ty) && !E.mobAt(nx, ny)) { world.setBlock(nx, ny, { id: 'fire', walk: true, t: 0, gen: 1 }); b.kids = (b.kids || 0) + 1; }
          }
        } else if (b.t > (b.blast ? 8 : 5) + (i % 4)) world.setBlock(x, y, null);
      } else if (b.id === 'nether_wart') {
        if (netherHere && (b.stage || 0) < 2 && world.mat(x, y) === 'soul_sand' && Math.random() < 0.004) { b.stage = (b.stage || 0) + 1; world.setBlock(x, y, b); }
      }
    }
  }
}
const furnaceKey = (b) => JSON.stringify([b.input, b.fuel, b.output]);
function growSapling(x, y) {
  if (!world.canGrowTree(x, y)) return false;
  world.growTree(x, y);
  E.breakParticles(x * TILE, y * TILE, ['#3c8c3c', '#5ab45a', '#7cf06a'], 10, 10);
  return true;
}
G.growSapling = growSapling;

function updateWorld(dt, self = true) {
  G.time = (G.time + dt * 20 * G.timeScale) % 24000;
  if (G.time < dt * 20 * G.timeScale && !NET.guest) G.day++;   // a co-op guest's day comes from the host
  // (playfix: a generated world's first dusk gets a warning line, since its spawn has no lit town around it)
  if (world.layout.gen && G.day === 0 && G.rules.mobs && G.time >= 10500 && G.time - dt * 20 * G.timeScale < 10500) G.actionBar = { text: 'Night is coming. Monsters come out in the dark.', t: 6, color: '#ffff55' };
  tickAcc += dt;
  while (tickAcc >= MC_TICK) { tickAcc -= MC_TICK; mcTick(); }
  E.updateEntities(dt);
  if (world.parked && !NET.guest && (parkAcc += dt) >= 1) { parkAcc = 0; parkNow(); }   // generated layouts: parking (2.11)
  if (G.vil && world.layout.gen && !NET.guest) { try { G.vil.tick(dt); } catch (e) { noteError(e); } }   // villages (7b): in or parked, refills
  E.updateParticles(dt);
  // night brings monsters
  // monsters: outdoors at night, in caves whenever it's dark, never inside buildings
  const here = world.roomAt(P.tx, P.ty);
  const inNether = !!here && here.kind === 'nether';
  const dark = here ? here.kind === 'cave' || (here.kind === 'field' && skyLevel() < 8) : skyLevel() < 8;
  if (!NET.guest && G.rules.mobs && dark && Math.random() < dt * 0.9 * (G.vil ? G.vil.spawnMul(P) : 1)) E.trySpawnHostile();   // (doubled in a village, 5.9)
  // the Nether spawns its own, by zone, light or not
  if (!NET.guest && G.rules.mobs && inNether && G.rules.nether !== false && Math.random() < dt * 0.9) E.trySpawnNether();
  NE.ambient(dt);
  END.update(dt, state);
  if (G.endFade > 0) G.endFade = Math.max(0, G.endFade - dt / 0.6);
  updatePortal(dt);
  updateNPCs(dt, G.busy());
  if (G.rules.wild && !NET.guest) { if (wildOn() && Math.random() < dt / 0.8) trySpawn(); updateWild(dt, engageWild); }
  // co-op host: the same spawning around every friend, and the night's sleepers
  if (NET.host && NET.h) END.safe('coopWorld', () => { for (const p of NET.players()) if (p !== P) spawnAround(p, dt); NET.h.sleepers(dt); });
  // (co-op host in a battle or a menu: the world above went on for the guests; Steve himself waits, as he would)
  if (!self) return;
  // standing in fire
  const fb = world.block(P.tx, P.ty);
  if (fb && fb.id === 'fire' && !P.moving) PL.hurtPlayer(P, 1, `${P.name} burned to death`);
  if (fb && fb.id === 'soul_fire' && !P.moving) PL.hurtPlayer(P, 2, `${P.name} burned to death`);
  if (fb && fb.id === 'campfire' && fb.lit) PL.hurtPlayer(P, 1, `${P.name} went up in flames`);
  // a magma block's floor burns the feet
  if (!P.moving && !P.dead && world.mat(P.tx, P.ty) === 'magma_block' && !fb) PL.hurtPlayer(P, 1, `${P.name} discovered the floor was lava`);
  // on fire (a blaze's fireball): a heart's worth every second until it goes out
  if (P.fireT > 0 && !P.dead) {
    const was = P.fireT; P.fireT = Math.max(0, P.fireT - dt);
    if (Math.floor(was) !== Math.floor(P.fireT)) PL.hurtPlayer(P, 1, `${P.name} burned to death`);
    if (P.swimming) P.fireT = 0;
  }
  for (const k of ['hurtFlash', 'invuln', 'regenFlash', 'placeT', 'slowT']) if (P[k] > 0) P[k] = Math.max(0, P[k] - dt);   // (slowT: a stray's arrow, 5d)
  PL.updateActor(follower, dt);
  if (follower.hop > 0) follower.hop = Math.max(0, follower.hop - dt * 30);
  updateToasts(dt);
  P.attackCd += dt;
  if (G.wildGrace > 0) G.wildGrace -= dt;
  if (G.heldName) G.heldName.t -= dt;
  if (G.actionBar) G.actionBar.t -= dt;
}

// co-op host: the spawning rolls single-player makes around Steve, made around a friend
function spawnAround(p, dt) {
  const here = world.roomAt(p.tx, p.ty), inNether = !!here && here.kind === 'nether';
  const dark = here ? here.kind === 'cave' || (here.kind === 'field' && skyLevel() < 8) : skyLevel() < 8;
  if (G.rules.mobs && dark && Math.random() < dt * 0.9 * (G.vil ? G.vil.spawnMul(p) : 1)) E.trySpawnHostile(p);
  if (G.rules.mobs && inNether && G.rules.nether !== false && Math.random() < dt * 0.9) E.trySpawnNether(p);
  if (G.rules.mobs && world.inEnd(p.tx, p.ty) && Math.random() < dt * 0.9) END.safe('spawnEnd', () => E.trySpawnEnd(p));
  if (G.rules.wild && wildOn() && Math.random() < dt / 0.8) trySpawn(p);
}

// ---------------------------------------------------------------- explosions (creepers and TNT)
G.explode = (tx, ty, power, src, opts = {}) => {
  if (NET.g) { NET.g.explode(tx, ty, power, src, opts); return; }   // co-op guest (a bed in the Nether): the host's blast
  const loud = !NET.on || NET.near(tx, ty);   // co-op: a blast beside a far-off friend is neither heard nor felt here
  if (NET.host && NET.h) NET.h.fx(['x', tx, ty, power, opts.fire ? 1 : 0]);
  if (loud) mc('explode', { vol: 1, pitch: 0.75 + Math.random() * 0.3 });
  const cx = tx * TILE + 8, cy = ty * TILE + 8;
  for (let i = 0; i < 16; i++) E.spriteParticle(A.mc.pExplosion, 16, cx + (Math.random() - 0.5) * power * 22, cy + (Math.random() - 0.5) * power * 16, { life: 0.5 + Math.random() * 0.3, z: 4 + Math.random() * 10, fw: 32, scale: 1.6 });
  for (let i = 0; i < 26; i++) E.particle({ x: cx, y: cy, z: 6, vx: (Math.random() - 0.5) * 220, vy: (Math.random() - 0.5) * 160, vz: 30 + Math.random() * 60, g: -120, life: 0.8, img: A.mc.pSmoke, frames: 12, fw: 16, size: 0, scale: 1.4 });
  if (loud) G.shake = 0.5;
  const r = power - 0.6;
  // blocks: the closer, the likelier to go; cliffs only right at the centre; a third drop as items.
  // Buildings, monuments and openings shrug it off; a building's door is blown open.
  for (let y = Math.floor(ty - r); y <= Math.ceil(ty + r); y++) for (let x = Math.floor(tx - r); x <= Math.ceil(tx + r); x++) {
    const d = Math.hypot(x - tx, y - ty);
    if (d > r || world.isVoid(x, y)) continue;
    const door = world.doorClosed(x, y);
    if (door) {
      world.openDoor(x, y);
      if (Math.random() < 1 / power) E.dropItem('door_' + door.style, 1, x * TILE, y * TILE);
      continue;
    }
    if (Math.random() > 1 - (d / r) * (d / r) * 0.6) continue;
    const b = world.block(x, y);
    if (b && b.id === 'tnt') { E.primeTNT(x, y, 0.5 + Math.random()); continue; }
    // obsidian, ancient debris and lava shrug off any blast
    // a Nether portal is snuffed out (Minecraft), before the rule that keeps unbreakable blocks
    if (b && b.id === 'nether_portal') { NE.breakPortalNear(x + 1, y); NE.breakPortalNear(x - 1, y); world.setBlock(x, y, null); NE.breakPortalNear(x, y); continue; }
    const bspec = b && item(b.id) && item(b.id).block;
    if (b && (b.id === 'lava' || (bspec && (bspec.hard >= 30 || bspec.hard < 0)))) continue;      // nor unbreakable blocks (portal frames, the egg)
    if (b) {
      if (Math.random() < 1 / power && !b.flush) { const it = item(b.id); if (it && it.block && it.block.drop !== null) E.dropItem(b.id, 1, x * TILE, y * TILE); }
      // a blasted container spills what it held, as breaking it by hand does
      if (b.id === 'chest') for (const st of b.slots || []) if (st) E.dropItem(st.id, st.n, x * TILE, y * TILE, st.dmg ? { dmg: st.dmg } : undefined);
      if (b.id === 'campfire') for (const st of b.items || []) if (st) E.dropItem(st.id, 1, x * TILE, y * TILE);
      if (b.id === 'furnace') for (const st of [b.input, b.fuel, b.output]) if (st) E.dropItem(st.id, st.n, x * TILE, y * TILE);
      if (b.flush && b.under != null) world.setTile(x, y, b.under);
      if (b.other) world.setBlock(b.other[0], b.other[1], null);
      world.setBlock(x, y, b.onBridge || null);
      if (b.bridge) world.reedgeEnd(x, y);
    }
    const guarded = world.noBreak(x, y) || world.protAt(x, y) === PROT.DOOR;
    if (guarded) continue;
    const mat = world.mat(x, y), spec = A.world.materials[mat] || A.world.ores[mat];
    const rock = mat === 'rock' || (mat.endsWith('_ore') && !mat.startsWith('nether_')) || mat === 'water_rock';
    if (spec && spec.hard >= 0 && spec.hard < 30 && (!rock || d < 1.3) && mat !== 'water') {
      if (Math.random() < 1 / power && spec.drop) E.dropItem(spec.drop, 1, x * TILE, y * TILE);
      world.breakTile(x, y);
    }
    // blasted ground turns to bare dirt (not netherrack, end stone or the stronghold's stone, and not under a fireball)
    if (!opts.noCrater && !world.inNether(x, y) && !world.inEnd(x, y) && !world.inStronghold(x, y) && world.isFloor(x, y) && !world.block(x, y) && !world.noPlace(x, y) && d < r * 0.85) world.setBlock(x, y, { id: 'dirt', flush: true, flushLook: 'dirt:flush', walk: true, crater: true, under: null });
  }
  // an explosion with fire (a ghast's fireball, a bed in the Nether) lights a third of the open floor it reached
  if (opts.fire) {
    const fr = Math.max(1.5, r);
    for (let y = Math.floor(ty - fr); y <= Math.ceil(ty + fr); y++) for (let x = Math.floor(tx - fr); x <= Math.ceil(tx + fr); x++) {
      if (Math.hypot(x - tx, y - ty) > fr || !world.isFloor(x, y) || world.block(x, y) || world.noPlace(x, y) || (x === P.tx && y === P.ty)) continue;
      if ((x === tx && y === ty) || Math.random() < 1 / 3) world.setBlock(x, y, { id: 'fire', walk: true, t: 0, blast: true });
    }
  }
  // damage: Minecraft's exposure falloff, gentler here so a close creeper leaves you a sliver
  const hit = (ex, ey) => { const d = Math.hypot(ex - tx, ey - ty), imp = 1 - d / (power * 2); return imp > 0 ? ((imp * imp + imp) / 2 * 7 * power * 2 + 1) * 0.42 : 0; };
  if (NET.on) {
    // co-op: every player it reaches who can be hurt (a friend gets it from here, in its own name)
    const cause = src && src.cause ? src.cause : src && src.kind === 'creeper' ? ['creeper'] : src && src.kind === 'bed' ? ['bed'] : ['tnt'];
    for (const p of NET.players()) {
      if (!NET.vuln(p)) continue;
      const dmg = hit(p.fx, p.fy);
      if (dmg <= 0) continue;
      if (p === P) { P.invuln = 0; PL.hurtPlayer(P, dmg, src && src.deathMsg && !src.slot ? src.deathMsg : src && src.kind === 'creeper' ? `${P.name} was blown up by Creeper` : src && src.cause ? causeLine(src.cause, P.name) : `${P.name} was blown up by TNT`, { tx, ty }); if (opts.fire && dmg > 2) P.fireT = Math.max(P.fireT || 0, 2); }
      else NET.hurt(p, dmg, cause, { tx, ty }, false, {}, { inv0: 1, fire: opts.fire && dmg > 2 ? 2 : 0 });
    }
  } else if (!P.dead) { const dmg = hit(P.fx, P.fy); if (dmg > 0) { P.invuln = 0; PL.hurtPlayer(P, dmg, src && src.deathMsg ? src.deathMsg : src && src.kind === 'creeper' ? `${P.name} was blown up by Creeper` : `${P.name} was blown up by TNT`, { tx, ty }); if (opts.fire && dmg > 2) P.fireT = Math.max(P.fireT || 0, 2); } }
  for (const m of G.ents) if (m.type === 'mob' && m !== src && !m.dying) { const dmg = hit(m.fx, m.fy); if (dmg > 0) { m.invuln = 0; E.hurtMob(m, dmg, { x: tx, y: ty }); } }
  for (const e of G.ents) if ((e.type === 'item' || e.type === 'xp') && Math.hypot(e.x / TILE - tx, e.y / TILE - ty) < r) { e.vz = 80; e.vx = (e.x - cx) * 3; e.vy = (e.y - cy) * 3; e.blast = true; }
};
// a death line for a co-op cause code (the host's own Steve, hurt by something a friend set off)
function causeLine(c, name) {
  const t = { fireball: `${name} was fireballed by ${c[1] || 'Ghast'}`, bed: `${name} was killed by [Intentional Game Design]`, crystal: `${name} was blown up by End Crystal` }[c[0]];
  return t || `${name} was blown up`;
}
// co-op guest: what a blast the host set off looks and sounds like here (the blocks and the damage come from the host)
G.explodeFx = (tx, ty, power) => {
  const near = NET.near(tx, ty);
  if (near) mc('explode', { vol: 1, pitch: 0.75 + Math.random() * 0.3 });
  const cx = tx * TILE + 8, cy = ty * TILE + 8;
  for (let i = 0; i < 16; i++) E.spriteParticle(A.mc.pExplosion, 16, cx + (Math.random() - 0.5) * power * 22, cy + (Math.random() - 0.5) * power * 16, { life: 0.5 + Math.random() * 0.3, z: 4 + Math.random() * 10, fw: 32, scale: 1.6 });
  for (let i = 0; i < 26; i++) E.particle({ x: cx, y: cy, z: 6, vx: (Math.random() - 0.5) * 220, vy: (Math.random() - 0.5) * 160, vz: 30 + Math.random() * 60, g: -120, life: 0.8, img: A.mc.pSmoke, frames: 12, fw: 16, size: 0, scale: 1.4 });
  if (near) G.shake = 0.5;
};


// ---------------------------------------------------------------- portals: standing in one, and going through
// Minecraft's 80 ticks: four seconds inside a lit portal, the nausea building, and Steve is on the other side.
// G.lastPortal remembers the overworld cell he left from; the Nether's portals lead back there (or to the
// world spawn). Arriving, he stands in the other portal and has to step out of it before it can take him again.
G.lastPortal = null; G.portalT = 0; G.nausea = 0; G.portalCool = false;
function updatePortal(dt) {
  const inPortal = state === 'play' && !P.dead && world.isPortal(P.tx, P.ty);
  if (!inPortal && state === 'play' && !P.moving) G.portalCool = false;
  if (inPortal && !G.portalCool && G.rules.nether !== false && world.nether) {
    if (G.portalT === 0) mc('portal_trigger', { vol: 0.55 });
    G.portalT += dt;
    if (G.portalT >= 4) travel();
  } else if (G.portalT > 0) G.portalT = Math.max(0, G.portalT - dt * 2);
  if (G.nausea > 0) G.nausea = Math.max(0, G.nausea - dt / 1.6);
}
function travel(toNether = !world.inNether(P.tx, P.ty)) {
  // generated layouts: the way back (the portal he left by, or the spawn) exists before it is checked (2.9, 2.13)
  if (!toNether && world.layout.gen) { afterReady([G.lastPortal, G.worldSpawn], () => travel0(false)); return; }
  travel0(toNether);
}
function travel0(toNether) {
  const N = world.nether;
  if (!N) return;
  let dest;
  if (toNether) { G.lastPortal = { x: P.tx, y: P.ty }; dest = { x: N.arrival.x, y: N.arrival.y, dir: N.arrival.dir || 'down' }; }
  else {
    const lp = G.lastPortal;
    dest = lp && !world.solid(lp.x, lp.y) && !world.inNether(lp.x, lp.y) ? { x: lp.x, y: lp.y, dir: 'down' } : { x: G.worldSpawn.x, y: G.worldSpawn.y, dir: 'down' };
    // the portal he left by has gone out (blasted or mined while he was away): come back beside its ring rather
    // than shut inside it, where nothing lets him step over an unlit frame
    if (dest.x === lp?.x && dest.y === lp?.y && !world.isPortal(lp.x, lp.y) && (NE.portalInterior(lp.x, lp.y) || PL.canEnter({ riding: null }, lp.x, lp.y) !== 'walk')) dest = outsidePortal(lp.x, lp.y) || { x: G.worldSpawn.x, y: G.worldSpawn.y, dir: 'down' };
    // generated layouts (2.9, stage 6c): the portal cell, then outside its ring, then the nearest walkable cell within
    // 16 of it, and the world spawn only when there is none (a far portal gone or walled up never sends him home)
    if (world.layout.gen && lp && !world.inNether(lp.x, lp.y) && dest.x === G.worldSpawn.x && dest.y === G.worldSpawn.y && !(lp.x === dest.x && lp.y === dest.y)) {
      const c = outsidePortal(lp.x, lp.y) || nearestWalk(lp.x, lp.y, 16);
      if (c) dest = { x: c.x, y: c.y, dir: 'down' };
    }
  }
  mc('portal_travel', { vol: 0.45 });
  P.mining = null; P.using = null; P.sprinting = false; P.riding = null; P.swimming = false;
  PL.placePlayer(P, dest.x, dest.y, dest.dir);
  G.portalT = 0; G.nausea = 1; G.portalCool = true;
  updateCamera();
  arriveArea(true);
  if (toNether) G.advance('nether');
  if (G.mr) autosave('portal');
}
G.travel = travel;
// the nearest cell of the same map Steve can walk on (within 12 cells; r: another reach, 6c's Nether return)
function nearestWalk(x, y, r = 12) {
  let best = null, bd = 1e9;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const X = x + dx, Y = y + dy, d = Math.abs(dx) + Math.abs(dy);
    if (d >= bd || !d || !world.inside(X, Y) || !world.samePlace(X, Y, x, y)) continue;
    if (PL.canEnter({ riding: null }, X, Y) !== 'walk' || world.warpAt(X, Y) || world.isLava(X, Y)) continue;
    best = { x: X, y: Y }; bd = d;
  }
  return best;
}
// The nearest open cell outside the obsidian ring around (x, y): the ring's interior and frame are skipped, and
// the cell must be one Steve can walk on in the same map. Null if there is none within 12 cells.
function outsidePortal(x, y) {
  const r = NE.portalInterior(x, y);
  const inRing = (X, Y) => (r ? X >= r.x - 1 && X <= r.x + r.w && Y >= r.y - 1 && Y <= r.y + r.h : X === x && Y === y);
  let best = null, bd = 1e9;
  for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
    const X = x + dx, Y = y + dy, d = Math.abs(dx) + Math.abs(dy) + (dy < 0 ? 0.5 : 0);
    if (d >= bd || inRing(X, Y) || !world.inside(X, Y) || !world.samePlace(X, Y, x, y)) continue;
    if (PL.canEnter({ riding: null }, X, Y) !== 'walk' || world.warpAt(X, Y) || world.isLava(X, Y)) continue;
    best = { x: X, y: Y, dir: 'down' }; bd = d;
  }
  return best;
}

// ---------------------------------------------------------------- warps: doors, mats, ladders and stairs
// FireRed's rules: walk up into a door; step onto a ladder, cave mouth or gate doorway; stand on a mat
// (or stairs) and press its way out. A fade, then Steve arrives facing the right way and, out of a door,
// walks down a step while it closes behind him.
const ARROW = { arrowS: 'down', arrowN: 'up', arrowE: 'right', arrowW: 'left', stairsE: 'right', stairsW: 'left' };
let fadeColor = '0,0,0';
let doorAnim = null;            // { x, y, a, f } a door opening or closing frame drawn over its tile
let lastMapId = null, lastMapsec = null;
const warpOn = (x, y) => (G.rules.warps ? world.warpAt(x, y) : null);
function tryWarpFrom(dir) {
  if (P.riding || state !== 'play') return false;
  const here = warpOn(P.tx, P.ty);
  if (here && ARROW[here.trig] === dir) { startWarp(here); return true; }
  const d = DIRS[dir], ahead = warpOn(P.tx + d.x, P.ty + d.y);
  if (ahead && ahead.trig === 'bump' && dir === 'up' && !world.block(ahead.x, ahead.y)) { startWarp(ahead, true); return true; }
  return false;
}
function closedSay(w) {
  const d = w.dest || '';
  say(/UNION_ROOM|TRADE_CENTER/.test(d) ? 'The link club is closed right now.' : /ELEVATOR/.test(d) ? "The elevator isn't working right now." : "It's locked.");
}
function startWarp(w, door = false) {
  if (w.to == null) { closedSay(w); return; }
  P.mining = null; P.using = null; P.sprinting = false;
  const from = world.mapAt(P.tx, P.ty), to = world.mapAt(w.ax, w.ay);
  // FireRed fades through white coming out of a cave into daylight
  fadeColor = from && from.kind === 'cave' && to && !to.room ? '255,255,255' : '0,0,0';
  seq = { kind: 'warp', t: 0, w, phase: door ? 'open' : 'out' };
  state = 'warp';
  if (door) {
    const ds = world.doorClosed(w.x, w.y);
    doorAnim = ds ? { x: w.x, y: w.y, a: ds.anim, f: 0 } : null;
    mc(ds && ds.sound === 'sliding' ? 'door_open' : 'door_open', { vol: 0.35, pitch: ds && ds.sound === 'sliding' ? 1.4 : 1 });
    if (!ds) seq.phase = 'walkin';
    if (!ds) PL.placePlayer(P, P.tx, P.ty, 'up');
    if (!ds) { P.fromX = P.tx; P.fromY = P.ty; P.tx = w.x; P.ty = w.y; P.moving = true; P.prog = 0; P.speed = PL.WALK_T; P.dist = 1; }
  } else mc('step.stone', { vol: 0.3, pitch: 0.7 });
}
// After any move to a new place: the right people, music and banner, the follower beside Steve.
function arriveArea(force) {
  if (world.layout.gen) { arriveAreaGen(force); return; }
  const map = world.mapAt(P.tx, P.ty);
  syncNPCs(map);
  if (map && (force || map.id !== lastMapId)) {
    // a deep cave's lava pool has seeped back in since he was last here
    if (map.id !== lastMapId && !NET.guest && !(NET.h && NET.h.othersIn(map))) NE.refillPools(map);
    if (map.show !== false && map.mapsec !== lastMapsec) showBanner(map.name);
    lastMapsec = map.mapsec;
    playMusicHere(force);
  }
  lastMapId = map ? map.id : null;
  lastArea = map ? map.name : null;
  follower.visible = !!followerMon() && !P.swimming && !P.riding;
  if (follower.visible) placeFollowerNear(P.tx, P.ty);
  // monsters left behind in another place go away
  if (!NET.guest) G.ents = G.ents.filter((e) => (!(e.type === 'mob' && !e.persistent && world.areaOf(e.tx, e.ty) !== map) && !(e.type === 'wild' && e.map !== map)
    && !(e.type === 'fireball' && world.areaOf(Math.floor(e.x / TILE), Math.floor(e.y / TILE)) !== map)) || (NET.h && NET.h.keep(e)));
  clock.reset();
}
G.arriveArea = arriveArea;
// Generated layouts (2.10): a new place is a change of regionKey (a room, or the outdoors as one 'WILD' place), not of
// the biome map under Steve, so walking from plains into a forest culls nothing. Outdoors the banner and the music
// follow the biome tracker below.
let lastKey = null;
function arriveAreaGen(force) {
  const map = world.mapAt(P.tx, P.ty), key = world.regionKey(P.tx, P.ty);
  syncNPCs(map);
  if (map && map.room) {
    if (force || map.id !== lastMapId) {
      if (map.id !== lastMapId && !NET.guest) NE.refillPools(map);
      if (map.show !== false && map.mapsec !== lastMapsec) showBanner(map.name);
      lastMapsec = map.mapsec;
      playMusicHere(force);
    }
  } else if (world.isOutdoor(P.tx, P.ty)) {
    // (a warp, a teleport or a return from a room: the place is where he lands, at once; steps use the tracker)
    const p = placeAt(P.tx, P.ty);
    if (p && (force || key !== lastKey || !place || p.key !== place.key)) setPlace(p, force);
    lastMapsec = null;
  }
  lastKey = key;
  lastMapId = map ? map.id : null;
  lastArea = map ? map.name : null;
  follower.visible = !!followerMon() && !P.swimming && !P.riding;
  if (follower.visible) placeFollowerNear(P.tx, P.ty);
  // monsters, wild POKeMON and fireballs left behind in another place go away
  const at = (x, y) => world.regionKey(x, y);
  // (co-op host: what a guest is still beside stays)
  if (!NET.guest) G.ents = G.ents.filter((e) => !((e.type === 'mob' && !e.persistent && at(e.tx, e.ty) !== key) || (e.type === 'wild' && at(e.tx, e.ty) !== key)
    || (e.type === 'fireball' && at(Math.floor(e.x / TILE), Math.floor(e.y / TILE)) !== key)) || (NET.h && NET.h.keep(e)));
  clock.reset();
}
// The biome banner and music (2.10): the place is the biome of the 8-cell coarse cell Steve is in (VILLAGE inside a
// village's bounds), and it changes only after 8 steps in the new place, so jagged biome edges never flicker.
let place = null, placeCand = null, placeSteps = 0;
let mapById = null;
function placeAt(x, y) {
  if (!world.layout.gen || !world.isOutdoor(x, y)) return null;
  if (!mapById) mapById = new Map(world.maps.map((m) => [m.id, m]));
  // a Kanto World (6a): on Kanto's own cells (its border fill too) the place is Kanto's map, by its MAPSEC as in Classic
  if (world.kmask && world.isKantoCell(x, y)) {
    const km = world.nearestMap(x, y);
    if (km && !km.gen) return { key: km.mapsec || km.id, name: km.show !== false ? km.name : null, music: km.music };
  }
  const lx = x - world.layout.ox, ly = y - world.layout.oy;
  for (const v of world.gen.plan.villages) {
    if (lx >= v.x0 && ly >= v.y0 && lx < v.x0 + v.w && ly < v.y0 + v.h) { const m = mapById.get('GEN_' + v.biome); return { key: 'VILLAGE', name: 'VILLAGE', music: m ? m.music : null }; }
  }
  const m = world.biomeAt((x & ~7) + 4, (y & ~7) + 4) || world.biomeAt(x, y);
  return m ? { key: m.id, name: m.name, music: m.music } : null;
}
function setPlace(p, force) {
  place = p; placeCand = null; placeSteps = 0;
  showBanner(p.name);
  ambience.stop(1.5);
  const own = p.music && A.world.music && A.world.music[p.music];
  if (own && (force || music.current !== own)) music.play(own);
}
function updatePlace() {
  const p = placeAt(P.tx, P.ty);
  if (!p) return;
  if (!place) { setPlace(p, false); return; }
  if (p.key === place.key) { placeCand = null; placeSteps = 0; return; }
  if (!placeCand || placeCand.key !== p.key) { placeCand = p; placeSteps = 0; }
  if (++placeSteps >= 8) setPlace(placeCand, false);
}
function stepPlace() {
  if (world.regionKey(P.tx, P.ty) !== lastKey) arriveArea(false);
  else if (world.isOutdoor(P.tx, P.ty)) updatePlace();
}
// The world border (2.8): Minecraft's forcefield texture, tinted cyan, scrolling along the border line, more opaque
// the nearer Steve is (seen from 16 cells away).
let borderTex = null;
function drawBorder(c) {
  const b = world.layout.border, dist = Math.min(P.fx - b.x0, b.x1 - P.fx, P.fy - b.y0, b.y1 - P.fy);
  if (dist > 16) return;
  if (!borderTex) {
    const k = document.createElement('canvas'); k.width = 16; k.height = 16;
    const g = k.getContext('2d');
    if (A.mc.forcefield) {
      g.drawImage(A.mc.forcefield, 0, 0);
      g.globalCompositeOperation = 'multiply'; g.fillStyle = 'rgb(32,160,255)'; g.fillRect(0, 0, 16, 16);
      g.globalCompositeOperation = 'destination-in'; g.drawImage(A.mc.forcefield, 0, 0);
    } else { g.fillStyle = 'rgba(32,160,255,0.6)'; g.fillRect(0, 0, 16, 16); }
    borderTex = ctx.createPattern(k, 'repeat');
  }
  const s = Math.floor(G.clock * 12) % 16;
  ctx.save();
  ctx.globalAlpha = 0.3 + 0.6 * (1 - Math.max(0, dist) / 16);
  ctx.translate(-c.x + s, -c.y + s);
  ctx.fillStyle = borderTex;
  const x0 = b.x0 * TILE, y0 = b.y0 * TILE, x1 = (b.x1 + 1) * TILE, y1 = (b.y1 + 1) * TILE;
  ctx.fillRect(x0 - 16 - s, y0 - 16 - s, 16, y1 - y0 + 32);
  ctx.fillRect(x1 - s, y0 - 16 - s, 16, y1 - y0 + 32);
  ctx.fillRect(x0 - s, y0 - 16 - s, x1 - x0, 16);
  ctx.fillRect(x0 - s, y1 - s, x1 - x0, 16);
  ctx.restore();
}
function updateWarp(dt) {
  const q = seq, w = q.w;
  q.t += dt;
  if (q.phase === 'open') {
    if (doorAnim) doorAnim.f = Math.min(2, Math.floor(q.t / 0.08));
    if (q.t >= 0.26) { q.phase = 'walkin'; q.t = 0; P.dir = 'up'; P.fromX = P.tx; P.fromY = P.ty; P.tx = w.x; P.ty = w.y; P.moving = true; P.prog = 0; P.speed = PL.WALK_T; P.dist = 1; }
    return;
  }
  if (q.phase === 'walkin') {
    if (!PL.updateActor(P, dt) && P.moving) return;
    q.phase = 'out'; q.t = 0; mc('door_close', { vol: 0.3 });
    return;
  }
  if (q.phase === 'out') {
    fade = Math.min(1, q.t / 0.27);
    // generated layouts (5b): out of a cave onto land whose chunks are not made yet (after a reload in the cave),
    // the view stays black until they are (the streaming paints them here after 1.5 s at the latest)
    if (world.layout.gen && !q.ens) { q.ens = true; world.ensureAround(w.ax, w.ay, 1); }
    if (q.t < 0.3 || (world.layout.gen && !world.ready(w.ax, w.ay))) return;
    if (doorAnim && doorAnim.x === w.x && doorAnim.y === w.y) doorAnim = null;
    // up the stronghold's stairs: the entrance opens from below too
    if (world.stronghold && world.stronghold.entrance && w.ax === world.stronghold.entrance.x && w.ay === world.stronghold.entrance.y) END.revealEntrance();
    PL.placePlayer(P, w.ax, w.ay, w.adir || P.dir);
    P.swimming = false;
    updateCamera();
    arriveArea(false);
    if (G.mr) autosave('warp');
    // coming out of a door: it opens first, then Steve steps down out of it
    const outDoor = world.warpAt(w.ax, w.ay), ds = outDoor && outDoor.trig === 'bump' ? world.doorClosed(w.ax, w.ay) : null;
    doorAnim = ds ? { x: w.ax, y: w.ay, a: ds.anim, f: 2 } : null;
    if (ds) { follower.visible = false; mc('door_open', { vol: 0.3 }); }
    q.phase = 'in'; q.t = 0;
    return;
  }
  if (q.phase === 'in') {
    fade = Math.max(0, 1 - q.t / 0.27);
    if (q.t < 0.28) return;
    fade = 0;
    if (w.amove === 'walk' && PL.canEnter(P, P.tx + DIRS[w.adir].x, P.ty + DIRS[w.adir].y)) {
      PL.tryStep(P, w.adir, { held: () => false });
      q.phase = 'walkout'; q.t = 0;
      return;
    }
    doorAnim = null; seq = null; state = 'play';
    return;
  }
  if (q.phase === 'walkout') {
    const done = PL.updateActor(P, dt) || !P.moving;
    if (doorAnim) doorAnim.f = Math.max(0, 2 - Math.floor(q.t / 0.1));
    if (!done) return;
    if (doorAnim) mc('door_close', { vol: 0.25 });
    doorAnim = null; seq = null; state = 'play';
    if (followerMon() && !P.swimming) { follower.visible = true; placeFollowerNear(P.tx, P.ty); }
  }
}

// ---------------------------------------------------------------- talking: the nurse, the clerk, Mom, everyone
function sayPages(pages, then) {
  const list = [].concat(pages || []).filter(Boolean);
  const next = (i) => (i < list.length ? say(list[i], () => next(i + 1)) : then && then());
  next(0);
}
function talkTo(n) {
  const face = n.dir;
  facePlayer(n, P);
  const back = () => { if (n.move !== 'wander') n.dir = face; };
  if (n.role === 'nurse') { nurseTalk(n, back); return; }
  if (n.role === 'clerk') { if (G.openMart) G.openMart(n.mart, n); else sayPages(['Hi, there!\nMay I help you?', 'Please come again!'], back); return; }
  if (n.role === 'mom') { momTalk(back); return; }
  sayPages(n.text && n.text.length ? n.text : ['Hi there!'], back);
}
// the clerk behind the counter opens the Mart
G.openMart = (listId, clerk) => { mart = new Mart(listId); mart.back = clerk ? () => { if (clerk.move !== 'wander') clerk.dir = clerk.face || 'down'; } : null; state = 'shop'; };
function nurseTalk(n, back) {
  say('Welcome to our POKéMON CENTER!', () => ask('Would you like me to heal your\nPOKéMON back to perfect health?', () => {
    say("Okay, I'll take your POKéMON for a\nfew seconds.", () => {
      n.dir = 'left';
      seq = { kind: 'heal', t: 0, nurse: n, balls: Math.max(1, G.party.length), shown: 0, jingle: false, back };
      state = 'heal';
    });
  }, () => say('We hope to see you again!', back)));
}
function healEveryone() { for (const m of G.party) healMon(m); P.health = 20; P.poisoned = false; }
function updateHeal(dt) {
  const q = seq, n = q.nurse;
  q.t += dt;
  const each = 25 / 60;
  const shown = Math.min(q.balls, Math.floor(q.t / each) + 1);
  if (shown > q.shown) { q.shown = shown; mc('click', { vol: 0.25, pitch: 1.6 }); }
  const ballsDone = q.balls * each + 32 / 60;
  if (q.t >= ballsDone && !q.jingle) { q.jingle = true; sfx.heal(); }
  if (q.t < ballsDone + 2.3) return;
  n.dir = 'down';
  healEveryone();
  G.lastCenter = { x: P.tx, y: P.ty, dir: P.dir };
  seq = null; state = 'play';
  say("Thank you for waiting.\nWe've restored your POKéMON to", () => say('full health.', () => {
    n.pose = 'bow';
    setTimeout(() => { n.pose = null; }, 700);
    say('We hope to see you again!', q.back);
  }));
}
function momTalk(back) {
  say(`MOM: ${G.myName || 'STEVE'}!\nYou should take a quick rest.`, () => {
    seq = { kind: 'momheal', t: 0, back }; state = 'heal';
  });
}
function updateMomHeal(dt) {
  const q = seq; q.t += dt;
  fade = q.t < 0.3 ? q.t / 0.3 : q.t < 2.6 ? 1 : Math.max(0, 1 - (q.t - 2.6) / 0.3);
  if (q.t >= 0.3 && !q.jingle) { q.jingle = true; sfx.heal(); healEveryone(); }
  if (q.t < 2.9) return;
  fade = 0; seq = null; state = 'play';
  say("MOM: Oh, good! You and your\nPOKéMON are looking great.", () => say('Take care now!', q.back));
}

// ---------------------------------------------------------------- beds, healing, fishing
G.useBed = (x, y, b) => {
  // a bed in the Nether explodes (power 5, with fire), as Minecraft's does
  if (world.inNether(x, y) || world.inEnd(x, y)) {
    world.setBlock(x, y, null);
    if (b.other) world.setBlock(b.other[0], b.other[1], null);
    G.explode(x, y, 5, { kind: 'bed', deathMsg: `${P.name} was killed by [Intentional Game Design]` }, { fire: true });
    return;
  }
  const head = b.part === 'head' ? [x, y] : b.other;
  if (NET.on && NET.s && NET.s.bedTaken(head[0], head[1])) { G.toast('This bed is occupied'); return; }
  G.spawnBed = head;
  const night = G.time >= 12542 && G.time < 23460;
  if (!night) { G.toast('Respawn point set'); setTimeout(() => G.toast('You can sleep only at night'), 0); return; }
  const near = G.ents.some((e) => e.type === 'mob' && E.HOSTILE.has(e.kind) && !e.dying && Math.abs(e.tx - P.tx) <= 8 && Math.abs(e.ty - P.ty) <= 5);
  if (near) { G.toast('You may not rest now; there are monsters nearby'); return; }
  G.toast('Respawn point set');
  G.advance('sweet_dreams');
  PL.sleep(P, { hx: head[0], hy: head[1], orient: b.orient });
  seq = { kind: 'sleep', t: 0 };
  state = 'sleep';
};
G.healAt = (town) => {   // the old door-bump heal, kept for scripts that call it
  if (!town) return;
  const home = town.id === 'MAP_PALLET_TOWN';
  say(home ? `MOM: …${G.myName || 'STEVE'}? Is that you? You look… blocky. Take a quick rest, dear.` : 'Welcome to our POKéMON CENTER! We restore your tired POKéMON to full health.', () => {
    for (const m of G.party) healMon(m);
    P.health = 20; P.food = Math.max(P.food, 20); P.sat = Math.max(P.sat, 5);
    G.lastTown = town.id;
    sfx.heal();
    say(home ? `MOM: There. Now you and your friends are looking great! Take care, ${G.myName || 'STEVE'}!` : "We've restored your POKéMON to full health. We hope to see you again!");
  });
};
G.castRod = () => {
  const old = G.ents.find((e) => e.type === 'bobber');
  if (old) { reelIn(old); return; }
  const d = DIRS[P.dir];
  let land = null;
  for (let k = 1; k <= 4; k++) { const x = P.tx + d.x * k, y = P.ty + d.y * k; if (world.solid(x, y) && !world.isWater(x, y)) break; land = { x, y }; if (world.isWater(x, y) && k >= 2) break; }
  if (!land) return;
  const hx = P.tx * TILE + 8, hy = P.ty * TILE;
  G.ents.push({ type: 'bobber', state: 'fly', t: 0, x0: hx, y0: hy, x1: land.x * TILE + 8, y1: land.y * TILE + 10, x: hx, y: hy, z: 0, tx: land.x, ty: land.y });
  mc('cast', { vol: 0.5 });
  P.swingT = 0.001;
};
function reelIn(b) {
  b.dead = true;
  mc('retrieve', { vol: 0.5 });
  P.swingT = 0.001;
  const held = G.inv.held;
  if (held && held.id === 'fishing_rod' && G.inv.wearHeld(1)) mc('break');
  if (b.state !== 'bite') return;
  const map = world.biomeAt(b.tx, b.ty) || world.nearestMap(b.tx, b.ty);   // (generated water: its biome map, 5d)
  // what bites: sometimes a fish, sometimes a POKéMON (FireRed's own OLD ROD table for this water)
  const enc = b.forceEnc || (map && genRoll(map, 'fishing', b.tx, b.ty, 'old_rod'));
  if (enc && (b.forcePokemon || (!b.forceFish && RNG.rand() < 0.45))) {
    say('Oh! A bite!', () => say('Landed a POKéMON!', () => startEncounter(enc, 'water')));
    return;
  }
  const r = RNG.rand();
  const id = b.forceFish || (r < 0.6 ? 'cod' : r < 0.85 ? 'salmon' : r < 0.93 ? 'bone' : 'string');
  if (id === 'cod' || id === 'salmon') G.advance('fishy');
  const e = E.dropItem(id, 1, b.tx * TILE, b.ty * TILE, {}, { delay: 0 });
  e.vx = (P.tx - b.tx) * 50; e.vy = (P.ty - b.ty) * 50; e.vz = 90;
  E.dropOrbs(1 + RNG.randInt(6), b.tx * TILE, b.ty * TILE);
}
G.onBite = () => {};

// ---------------------------------------------------------------- death
G.onDeath = (cause) => { P.deathMsg = cause; };
// everything Steve carried stays where he fell (knocked into The End's void: on the last cell he stood on).
// Single-player drops it on respawning, as ever; a co-op guest drops it the moment it dies (updatePlay), so a guest
// that leaves, reloads or crashes on its death screen has already left its things where it fell, as in Minecraft.
function deathDrops() {
  const at = P.deathDrop || { x: P.tx, y: P.ty };
  for (let i = 0; i < 36; i++) { const s = G.inv.slots[i]; if (s) { E.dropItem(s.id, s.n, at.x * TILE, at.y * TILE, s.dmg ? { dmg: s.dmg } : {}, { delay: 1 }); G.inv.slots[i] = null; } }
  for (let i = 0; i < 4; i++) { const s = G.inv.armor[i]; if (s) { E.dropItem(s.id, 1, at.x * TILE, at.y * TILE, s.dmg ? { dmg: s.dmg } : {}, { delay: 1 }); G.inv.armor[i] = null; } }
  // dropped on the void's edge they must not drift over it: they lie still
  if (P.deathDrop) for (const e of G.ents) if (e.type === 'item' && Math.floor(e.x / TILE) === at.x && Math.floor(e.y / TILE) === at.y) { e.vx = 0; e.vy = 0; }
  E.dropOrbs(Math.min(100, P.level * 7), at.x * TILE, at.y * TILE);
  P.level = 0; P.xpProgress = 0; P.xpTotal = 0;
  if (NET.g) NET.g.flush();   // co-op guest: the drops go to the host now, checked where it fell, before it moves
}
function respawn() {
  // generated layouts: the bed, the last center and the spawn exist before the bed is checked (2.13), so a bed in a
  // chunk that is not there yet is not taken for a missing one
  if (world.layout.gen) { const b = G.spawnBed; afterReady([b ? { x: b[0], y: b[1] } : null, G.lastCenter, G.worldSpawn], respawn0); return; }
  respawn0();
}
function respawn0() {
  if (!P.netDropped) deathDrops();
  let sp = G.worldSpawn;
  if (G.spawnBed) {
    const [bx, by] = G.spawnBed;
    const b = world.block(bx, by);
    if (b && b.id === 'white_bed') { for (const d of DIR_LIST) { const x = bx + DIRS[d].x, y = by + DIRS[d].y; if (PL.canEnter(P, x, y) === 'walk') { sp = { x, y }; break; } } }
    else { G.spawnBed = null; G.toast('You have no home bed or charged respawn anchor, or it was obstructed'); }
  }
  // no bed: back to the last POKéMON CENTER Steve healed at, facing the nurse (FireRed's whiteout)
  if (sp === G.worldSpawn && G.lastCenter) sp = G.lastCenter;
  Object.assign(P, PL.makePlayer(sp.x, sp.y));
  if (G.myName) P.name = G.myName;   // a co-op guest keeps its own name
  P.deathMsg = null; delete P.voidFall; delete P.deathDrop; delete P.netDropped;
  G.portalT = 0; G.portalCool = false;
  P.dir = sp.dir || 'down';
  arriveArea(true);
  // generated worlds (6.6): a whiteout (or any death) comes back at the bed or the world spawn with the party restored
  if (world.layout.gen) { for (const m of G.party) healMon(m); G.healedAt = { why: 'respawn', day: G.day }; }
  if (NET.g) NET.g.respawned(P.tx, P.ty);
  else G.ents = G.ents.filter((e) => !(e.type === 'mob' && E.HOSTILE.has(e.kind) && Math.abs(e.tx - P.tx) < 12 && Math.abs(e.ty - P.ty) < 10));
  state = 'play';
  deathUI = null;
}

// ---------------------------------------------------------------- battles
function battleTerrain(kind, x, y) {
  if (kind === 'water') return 'water';
  const room = world.roomAt(x, y);
  if (room && room.kind === 'nether') return 'nether';
  if (room && (room.kind === 'cave' || room.kind === 'stronghold')) return 'cave';
  if (room && room.kind === 'indoor') return 'building';
  // generated outdoors: the biome map's battle terrain (2.10)
  const bm = world.biomeAt(x, y);
  if (bm && bm.terrain) return bm.terrain;
  const map = world.nearestMap(x, y);
  const id = map ? map.id : '';
  if (['MAP_ROUTE3', 'MAP_ROUTE4', 'MAP_ROUTE9', 'MAP_ROUTE10', 'MAP_ROUTE23'].includes(id)) return 'mountain';
  if (world.mat(x, y) === 'sand') return 'sand';
  return 'grass';
}
// a visible wild POKéMON that touched Steve (or that he faced and pressed Z at)
function engageWild(e, ambush) {
  if (state !== 'play' || G.wildGrace > 0 || P.dead || P.sleeping) return;
  if (G.mr && !G.mr.battles) return;   // a spectator never battles (6.4)
  if (NET.g && e.nid != null) { NET.g.engage(e); return; }   // co-op: the host's POKeMON (it says which battle starts)
  startEncounter({ species: e.species, level: wildLevel(e.level, e.tx, e.ty, e.base), shiny: e.shiny }, e.swim ? 'water' : 'land', e);
}
// The Nether's table runs from level 30 to 45, but Steve fights at 8 + 2 per experience level and drops back to
// level 8 each time he dies. There a wild POKéMON meets him at most a few levels above his own (2 for the
// commonest, up to 5 for HOUNDOOM and the rarest), so a fresh Steve can still win, and one of level 30 and up
// meets the table as it is.
function netherLevel(level, x, y) {
  if (!world.inNether(x, y) && !world.inNether(P.tx, P.ty)) return level;
  return Math.max(2, Math.min(level, steveLevel(P) + 2 + Math.max(0, Math.floor((level - 30) / 5))));
}
G.engageWild = engageWild;
// Generated land (3.15, stage 5d): the battling player's cap values (this tab's Steve and party; a co-op guest's own
// bridge runs this on its own tab), a table roll with the level for its place, and a visible POKeMON's level when it
// battles (the cap, its table level the floor). Kanto's maps and Classic keep netherLevel's rule alone.
const capWho = () => ({ steve: steveLevel(P), best: G.party.reduce((a, m) => Math.max(a, (m && m.level) | 0), 0) });
function genRoll(map, kind, x, y, rod) {
  const enc = roll(wildId(map), kind, rod);
  if (enc && map.gen) enc.level = levelFor(map, x, y, enc.level, capWho());
  return enc;
}
function wildLevel(level, x, y, base) {
  const m = world.layout.gen ? world.mapAt(x, y) : null;
  return m && m.gen ? capLevel(level, base, capWho()) : netherLevel(level, x, y);
}
// opts (The End's legendary battle): legend (FireRed's legendary transition, B_TRANSITION_BLUR), music, terrain, boss
// (passed on to the Battle), mon (a ready-made wild POKeMON instead of a new one from enc)
function startEncounter(enc, kind = 'land', src = null, opts = {}) {
  if (G.mr) { if (!G.mr.battles) return; autosave('battle'); }   // hardcore: saved at the start of every battle (6.4)
  G.battleSrc = src;
  if (NET.on && src && src.type === 'wild') src.gone = true;   // co-op: out of the world for everyone while this battle runs
  const wild = opts.mon || makeMon(enc.species, enc.level, { shiny: enc.shiny != null ? enc.shiny : RNG.rand() < 1 / 8192 });
  if (MM) MM.skipNext = true;   // (the transition's snapshot leaves the minimap out)
  GBA(); draw();
  const snap = document.createElement('canvas'); snap.width = HW; snap.height = HH;
  snap.getContext('2d').drawImage(canvas, 0, 0);
  seq = { kind: 'transition', t: 0, wild, snap, terrain: opts.terrain || battleTerrain(kind, P.tx, P.ty), opts };
  state = 'transition';
  P.mining = null; P.using = null;
  ambience.stop(0.5);
  music.play(opts.music || 'battle');
}
G.startEncounter = startEncounter;
function updateTransition(dt) {
  seq.t += dt;
  if (seq.t >= (seq.opts && seq.opts.legend ? LEGEND_T : 1.35)) {
    G.battle = new Battle(G, seq.wild, seq.terrain, seq.opts || {});
    seq = null; state = 'battle';
  }
}
// B_TRANSITION_BLUR (src/battle_transition.c), the one StartLegendaryBattle uses: every third frame the mosaic grows
// by a pixel, up to 15; on the tenth step the palettes fade to black.
const LEGEND_T = 52 / 60;
function drawLegendTransition() {
  const f = seq.t * 60, step = Math.min(15, Math.floor(f / 3) + 1);
  const m = (step + 1) * (HW / VW);                           // block size in canvas pixels (GBA pixels x 2)
  const w = Math.max(1, Math.ceil(HW / m)), h = Math.max(1, Math.ceil(HH / m));
  if (!seq.mos) { seq.mos = document.createElement('canvas'); }
  seq.mos.width = w; seq.mos.height = h;
  const g = seq.mos.getContext('2d'); g.imageSmoothingEnabled = true;
  g.drawImage(seq.snap, 0, 0, w * m, h * m, 0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(seq.mos, 0, 0, w, h, 0, 0, w * m, h * m);
  const fade = Math.max(0, Math.min(1, (f - 30) / 16));
  if (fade > 0) { ctx.fillStyle = `rgba(0,0,0,${fade})`; ctx.fillRect(0, 0, HW, HH); }
}
function updateBattle(dt) {
  const b = G.battle;
  b.update(dt, input);
  if (!b.finished) return;
  seq = { kind: 'battleOut', t: 0, outcome: b.finished, legend: !!(b.opts && b.opts.legend) };
  state = 'battleOut';
  if (b.finished !== 'caught') music.stop(0.5);
}
function updateBattleOut(dt) {
  const q = seq; q.t += dt;
  if (q.t >= 0.4 && G.battle) {
    const b = G.battle; G.battle = null;
    q.foe = b.E && b.E.mon ? b.E.mon.name : null;
    syncSteve(G, b);
    if (b.xpGained) E.dropOrbs(b.xpGained, P.tx * TILE, P.ty * TILE);
    // the creature that started it: gone if beaten or caught, wary for a while if Steve ran
    const src = G.battleSrc; G.battleSrc = null;
    if (src && NET.g && src.remote) NET.g.wildOver(src.nid, q.outcome);   // co-op: the host's POKeMON
    else if (src) {
      if (q.outcome === 'ran') {
        src.calm = 15; src.state = 'idle'; if (NET.on) src.gone = false;
        // (playfix, generated worlds: RUN calms its pack and every POKeMON close by for a while, and the next few
        // steps roll no encounter, so one valley no longer chains battle after battle)
        if (world.layout.gen) {
          for (const o of G.ents) if (o.type === 'wild' && o !== src && Math.abs(o.tx - P.tx) + Math.abs(o.ty - P.ty) <= 8) { o.calm = Math.max(o.calm || 0, 6); if (o.state === 'chase') o.state = 'idle'; }
          if (src.pack) src.pack.hunt = 0;
          G.encSkip = 4;
        }
      }
      else { src.dead = true; if (q.outcome === 'win') E.poof(src.tx * TILE + 8, src.ty * TILE + 8); }
    }
    G.wildGrace = q.outcome === 'ran' && world.layout.gen ? 2.5 : 1.5;
    // the ENDER DRAGON's battle: caught, fainted (its death in The End) or Steve's side lost (it recovers)
    if (q.legend && NET.g) NET.g.legendOver(q.outcome);   // co-op: the host's dragon
    else if (q.legend) { END.safe('legendEnd', () => DR.battleOver(q.outcome)); if (NET.h) NET.h.legendFree(0); }
    if (G.pendingCatchToast) { G.pendingCatchToast = false; G.advance('catch'); placeFollowerNear(P.tx, P.ty); follower.visible = !P.swimming && !P.riding; follower.hop = 8; }
    playMusicHere(true);
    clock.reset();
  }
  if (q.t >= 0.8) {
    seq = null; state = 'play';
    // the death screen names the POKéMON that slew him, in Minecraft's own words ("Steve was slain by Houndoom")
    // Creative (6.1): a lost battle heals the party and ends there, with no death
    if ((q.outcome === 'dead' || q.outcome === 'whiteout') && G.mr && G.mr.battleLoss === 'heal') { healEveryone(); G.toast('Your POKéMON were healed.'); }
    else if (q.outcome === 'dead') { P.health = 0; P.dead = true; P.deathT = 0; P.deathMsg = q.foe ? `${P.name} was slain by ${q.foe.replace('♀', ' F').replace('♂', ' M').toLowerCase().replace(/(^|[\s.-])(\S)/g, (m, a, c) => a + c.toUpperCase())}` : `${P.name} died`; }
    else if (q.outcome === 'whiteout') { P.dead = true; P.deathT = 0; P.deathMsg = `${P.name} blacked out`; }
  }
}

// ---------------------------------------------------------------- the ENDER DRAGON: the legendary encounter
// Facing the exhausted dragon, A: its cry line, the cry and a shake, then FireRed's legendary battle with its HP at
// the fraction the fight left it.
function beginLegend(granted = false) {
  // co-op: one player battles it at a time (a guest asks the host first)
  if (NET.on && !granted) {
    if (NET.g) { NET.g.askLegend(); return; }
    if (NET.h && !NET.h.legendLock(0)) { say('Someone is battling the ENDER DRAGON.'); return; }
  }
  const s = G.end.dragon;
  music.stop(0.6); G.musicHold = 999;
  cry('ENDER_DRAGON'); G.shake = 0.9;
  say('ENDER DRAGON: Grrraaagh!', () => {
    const mon = makeMon('ENDER_DRAGON', 70, { shiny: RNG.rand() < 1 / 8192 });
    mon.hp = Math.max(1, Math.min(mon.maxHp, Math.round(mon.maxHp * s.hp / DR.MAX_HP)));
    G.musicHold = 0;
    startEncounter({ species: 'ENDER_DRAGON', level: 70 }, 'land', null, { legend: true, music: 'vs_legend', terrain: 'end', boss: true, mon });
  });
}
G.beginLegend = beginLegend;
// ---------------------------------------------------------------- The End: there and home again
// The stronghold's portal: at once to the obsidian platform (rebuilt each time, as Minecraft does).
function enterEnd() {
  const a = END.arrival();
  if (!a) return;
  P.mining = null; P.using = null; P.sprinting = false; P.riding = null; P.swimming = false;
  END.regenPlatform();
  PL.placePlayer(P, a.x, a.y, a.dir || 'right');
  G.endFade = 1; G.endCool = false; G.travelled = true;
  updateCamera();
  arriveArea(true);
  if (G.mr) autosave('portal');
}
// The exit portal: home to the bed (or the world spawn); the first time after the first dragon, the Hall of Fame.
let hof = null;
function exitEnd() {
  P.mining = null; P.using = null; P.sprinting = false;
  if (!G.end.hofSeen && G.end.kills >= 1) {
    G.end.hofSeen = true;
    hof = new HallOfFame(G.party.slice(), P);
    state = 'hof';
    return;
  }
  goHome();
}
function homeSpot() {
  if (G.spawnBed) {
    const [bx, by] = G.spawnBed, b = world.block(bx, by);
    if (b && b.id === 'white_bed') for (const d of DIR_LIST) { const x = bx + DIRS[d].x, y = by + DIRS[d].y; if (PL.canEnter(P, x, y) === 'walk') return { x, y }; }
  }
  return G.worldSpawn;
}
function goHome() {
  if (world.layout.gen) { const b = G.spawnBed; afterReady([b ? { x: b[0], y: b[1] } : null, G.worldSpawn], goHome0); return; }
  goHome0();
}
function goHome0() {
  const sp = homeSpot();
  PL.placePlayer(P, sp.x, sp.y, 'down');
  P.swimming = false; P.riding = null;
  G.endFade = 1; G.travelled = true;
  state = 'play';
  updateCamera();
  arriveArea(true);
  if (G.mr) autosave('teleport');
}

// ---------------------------------------------------------------- overworld control
const queued = { a: -1 };
let mineSound = 0;
function updatePlay(dt) {
  const W = world;
  // (co-op: a message or a battle that came between the death and its screen leaves deathUI set; it opens again)
  if (P.dead) {
    if (NET.g && !P.netDropped) { P.netDropped = true; deathDrops(); }   // co-op guest: its things fall now (see deathDrops)
    P.deathT += dt; if (P.deathT > 0.5 && (!deathUI || NET.on)) { deathUI = { t: 0, sel: 0 }; state = 'dead'; } return;
  }
  // knocked into The End's void: nothing more to do but fall
  if (P.voidFall) { PL.updateActor(P, dt); P.mining = null; return; }
  if (MAP_ON && mapPlay()) return;   // the full map: J or a tap on the minimap, between steps (spectators too)
  if (G.mr && !G.mr.interact) { P.mining = null; spectate(dt); return; }
  // hotbar
  for (let k = 1; k <= 9; k++) if (input.just('slot' + k)) selectSlot(k - 1);
  const wheel = input.takeWheel();
  if (wheel) selectSlot((G.inv.sel + (wheel > 0 ? 1 : -1) + 9) % 9);
  if (input.just('next')) selectSlot((G.inv.sel + 1) % 9);
  if (input.just('prev')) selectSlot((G.inv.sel + 8) % 9);
  if (input.just('inv') && !P.moving) { P.mining = null; P.using = null; G.openScreen('inventory'); return; }
  if (input.just('start') && !P.moving) { P.mining = null; P.using = null; state = 'menu'; menuCursor = 0; sfx.select(); return; }
  if (input.just('drop') && G.inv.held) {
    const s = G.inv.held, n = input.ctrl ? s.n : 1;
    G.dropStack({ ...s, n }, true); s.n -= n; if (s.n <= 0) G.inv.slots[G.inv.sel] = null;
  }
  // jumping (and critical hits on the way down)
  if (input.just('jump') && P.jumpT <= 0 && !P.swimming && !P.riding && !P.using) { P.jumpT = 0.001; PL.exhaust(P, P.sprinting ? 0.2 : 0.05); }
  if (P.jumpT > 0) { P.jumpT += dt; P.z = Math.sin(Math.min(1, P.jumpT / 0.42) * Math.PI) * 7; if (P.jumpT >= 0.42) { P.jumpT = 0; P.z = 0; } }
  const stepDone = PL.updateActor(P, dt);
  if (stepDone) { G.travelled = false; onStep(); if (G.travelled) { G.travelled = false; return; } }
  if (P.swingT > 0) { P.swingT += dt; if (P.swingT >= 0.3) P.swingT = 0; }
  // using: eating / drawing a bow, while X is held
  if (P.using === 'eat') {
    if (!input.held('b') || !PL.canEat(P)) P.using = null;
    else {
      P.useT += dt;
      if (Math.floor(P.useT * 4) !== Math.floor((P.useT - dt) * 4)) {
        mc('eat', { vol: 0.5, pitch: 0.8 + Math.random() * 0.4 });
        const it = item(G.inv.held.id);
        for (let i = 0; i < 4; i++) E.particle({ x: P.fx * TILE + 8 + DIRS[P.dir].x * 5, y: P.fy * TILE + 2 + DIRS[P.dir].y * 2, z: 8, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 10, vz: 20, g: -150, life: 0.5, color: iconColor(it.iconIndex), size: 2, bounce: true });
      }
      if (P.useT >= 1.6) { PL.finishEating(P); P.using = null; }
    }
    return;
  }
  if (P.using === 'bow') { if (input.held('b')) P.bowT += dt; else PL.releaseBow(P); return; }
  if (P.moving) {
    if (input.just('a')) { if (E.deflectFireball(P)) P.swingT = 0.001; else queued.a = time; }
    return;
  }
  if (G.signHook && G.signHook(P, input, queued.a >= 0 && time - queued.a < 0.3)) { queued.a = -1; P.mining = null; return; }   // the Kanto sign: A or X reads it, no A at it mines it (src/kantosign.js)
  // mining / attacking with Z
  const aHeld = input.held('a');
  // (a tap shorter than a frame, as a phone's pad can send, still counts as a press)
  if (aHeld || input.just('a') || (queued.a >= 0 && time - queued.a < 0.3)) {
    queued.a = -1;
    // a fireball coming at him: Z bats it back
    if (input.just('a') && E.deflectFireball(P)) { P.swingT = 0.001; P.mining = null; return; }
    // The End: the exhausted dragon's legendary encounter; a blow at the dragon in reach; the dragon egg
    if (world.inEnd(P.tx, P.ty)) {
      if (input.just('a') && END.safe('encounterReady', () => DR.encounterReady(P))) { P.mining = null; END.safe('legend', beginLegend); return; }
      if (END.safe('meleeReady', () => DR.meleeReady(P))) { P.mining = null; if (input.just('a') || P.attackCd >= 0.62) END.safe('dragonHit', () => DR.attack(P)); return; }
    }
    if (input.just('a') && END.safe('hitHook', () => END.hitHook(P, PL.facing(P)))) { P.mining = null; return; }
    const tg = PL.target(P);
    const fw = PL.facing(P);
    const who = input.just('a') ? npcFacing(P) : null;
    if (who) { P.mining = null; talkTo(who); return; }
    // the PC beside the nurse's counter (FireRed's MB_PC metatile): the POKéMON Storage System
    if (input.just('a') && world.behaviorAt(fw.x, fw.y) === 0x83) { P.mining = null; say(`${G.myName || 'STEVE'} booted up the PC.`, () => { pcUI = new PCScreen(); state = 'pc'; }); return; }
    const wildHere = input.just('a') ? wildAt(fw.x, fw.y) : null;
    if (wildHere) { P.mining = null; P.swingT = 0.001; wildHere.disguise = null; engageWild(wildHere, false); return; }
    if (input.just('a') && follower.visible && follower.tx === fw.x && follower.ty === fw.y && followerMon()) {
      const m = followerMon();
      cry(m.species); follower.hop = 8;
      E.spriteParticle(A.mc.pHeart, 1, follower.fx * TILE + 8, follower.fy * TILE - 10, { life: 0.9, vz: 12, fw: 8, scale: 2 });
      return;
    }
    // a villager (7b): Z talks, never hurts (5.10)
    if (tg && tg.kind === 'mob' && tg.mob.kind === 'villager' && G.vil) { P.mining = null; if (input.just('a')) G.vil.talk(tg.mob, P); return; }
    if (tg && tg.kind === 'mob') {
      P.mining = null;
      if (input.just('a') || P.attackCd >= 0.62) PL.attack(P, tg.mob);
    } else if (tg && tg.kind === 'protected') {
      P.mining = null;
      mineSound -= dt;
      if (input.just('a') || mineSound <= 0) { mineSound = 0.25; PL.bumpProtected(P, input.just('a')); }
      return;
    } else if (tg && tg.spec) {
      const key = tg.x + ',' + tg.y + ',' + tg.kind;
      if (!P.mining || P.mining.key !== key) P.mining = { key, x: tg.x, y: tg.y, kind: tg.kind, block: tg.block, progress: 0 };
      // Creative (6.1): instant where survival could break it; protected blocks (spawners, infested stone, doors)
      // only bump
      const info = G.mr && G.mr.instantBreak ? MODES.breakFor(G.mode, tg.spec, !!tg.door || !!tg.spec.infested || (tg.kind === 'block' && MODES.PROTECTED_IDS.has(tg.block.id)), null) : breakInfo(tg.spec, G.inv.held);
      if (!info) { P.mining = null; mineSound -= dt; if (input.just('a') || mineSound <= 0) { mineSound = 0.25; PL.bumpProtected(P, input.just('a')); } return; }
      P.mining.progress += (dt * 20) / info.ticks;
      if (info.creative) P.mining.progress = 1;
      if (P.swingT <= 0) P.swingT = 0.001;
      mineSound -= dt;
      if (mineSound <= 0 && info.ticks > 1) { mineSound = 0.22; mc('dig.' + (tg.spec.sound || 'stone'), { vol: 0.22, pitch: 0.5 }); E.breakParticles(tg.x * TILE, tg.y * TILE, ['rgba(0,0,0,0)'], 0); }
      if (P.mining.progress >= 1) { PL.finishBreak(P, tg); P.mining = null; mineSound = 0; }
      return;
    } else if (input.just('a')) { P.swingT = 0.001; P.mining = null; }
  } else P.mining = null;
  // X: use
  if (input.just('b')) { if (G.vil && G.vil.useInFront(P)) return; if (PL.useInFront(P)) return; }   // (7b: a villager, a village bell)
  // walking
  const dir = input.dir();
  if (!dir) { P.turnHold = 0; return; }
  if (dir !== P.dir && input.just(dir)) { P.dir = dir; P.turnHold = 0.09; P.mining = null; return; }
  if (P.turnHold > 0) { P.turnHold -= dt; return; }
  P.mining = null;
  if (tryWarpFrom(dir)) return;
  const px = P.tx, py = P.ty;
  if (PL.tryStep(P, dir, input)) followerStep(px, py);
  else if (input.just(dir) && state === 'play') sfx.bump();
}
function selectSlot(i) {
  if (i === G.inv.sel) return;
  G.inv.sel = i;
  P.mining = null; P.using = null;
  const s = G.inv.held;
  G.heldName = s ? { text: nameOf(s.id), t: 2 } : null;
}
const iconColorCache = new Map();
function iconColor(i) {
  if (iconColorCache.has(i)) return iconColorCache.get(i);
  const c = document.createElement('canvas'); c.width = 16; c.height = 16;
  const g = c.getContext('2d'); g.drawImage(A.mc.icons, (i % 32) * 16, Math.floor(i / 32) * 16, 16, 16, 0, 0, 16, 16);
  const d = g.getImageData(4, 4, 8, 8).data; let r = 0, gg = 0, b = 0, n = 0;
  for (let k = 0; k < d.length; k += 4) if (d[k + 3]) { r += d[k]; gg += d[k + 1]; b += d[k + 2]; n++; }
  const col = n ? `rgb(${(r / n) | 0},${(gg / n) | 0},${(b / n) | 0})` : '#a0522d';
  iconColorCache.set(i, col);
  return col;
}
function onStep() {
  G.steps++;
  const W = world;
  P.swimming = !P.riding && W.isWater(P.tx, P.ty);
  if (P.dist === 2 && !PL.frameHop(P)) E.particle({ x: P.tx * TILE + 8, y: P.ty * TILE + 13, life: 0.3, color: '#c8a878', size: 2, vx: 0, vy: 0 });
  PL.stepSound(P);
  const sw = warpOn(P.tx, P.ty);
  if (sw && sw.trig === 'step' && !P.riding) { startWarp(sw); return; }
  // an End portal takes him the moment he steps onto it
  if (world.isEndPortal(P.tx, P.ty) && END.safe('portalStep', () => END.portalStep(state))) return;
  const here = W.mapAt(P.tx, P.ty);
  if (W.layout.gen) stepPlace();
  else if (here && here.id !== lastMapId) arriveArea(false);
  if (W.tallGrass(P.tx, P.ty)) G.parts.push({ x: P.tx * TILE + 8, y: P.ty * TILE + 8, z: 0, vx: 0, vy: 0, vz: 0, g: 0, life: 0.3, age: 0, grass: true });
  // wild POKéMON: FireRed's tables, in tall grass and (now that Steve can swim) in the water
  const map = W.mapAt(P.tx, P.ty);
  if (!map || !G.rules.encounters || !wildOn()) return;
  let kind = null;
  if (W.tallGrass(P.tx, P.ty)) kind = 'land';
  else if (P.swimming || P.riding) kind = 'water';
  else if (map.room && W.entry(P.tx, P.ty)[7] === 1 && !W.block(P.tx, P.ty)) kind = 'land';   // cave floors, the forest, the Tower
  if (!kind) return;
  if (forcedEncounter) { const f = forcedEncounter; forcedEncounter = null; startEncounter(f, kind); return; }
  if (G.encSkip > 0) { G.encSkip--; return; }   // (playfix: a few quiet steps after a RUN in a generated world)
  // with POKéMON out in the open, caves rely on the ones you can see and tall grass rustles half as often
  // (the Nether's floors keep a few step encounters of their own, at half the rate, like tall grass)
  if (G.rules.wild && kind === 'land' && map.room && !W.tallGrass(P.tx, P.ty) && map.kind !== 'nether') return;
  const rate = rateFor(wildId(map), kind) * (G.rules.wild && kind === 'land' ? 0.5 : 1);
  if (clock.step(rate, map.id + kind)) { const enc = genRoll(map, kind, P.tx, P.ty); if (enc) { enc.level = netherLevel(enc.level, P.tx, P.ty); startEncounter(enc, kind); } }
}
function playMusicHere(force) {
  // generated outdoors: the biome tracker's place (2.10)
  if (world.layout.gen && place && world.isOutdoor(P.tx, P.ty)) {
    ambience.stop(1.5);
    const own = place.music && A.world.music[place.music];
    if (own && (force || music.current !== own)) music.play(own);
    return;
  }
  const map = world.mapAt(P.tx, P.ty);
  const id = map ? map.id : '';
  // the Nether has no FireRed music: Minecraft's ambience for the biome Steve is in
  if (map && map.kind === 'nether') {
    music.stop(1);
    if (G.rules.nether !== false) ambience.play(NE.biomeAt(P.tx, P.ty) === 'V' ? 'soul_sand_valley' : 'nether_wastes');
    return;
  }
  ambience.stop(1.5);
  // no FireRed song in the stronghold (its cave ambience comes later); The End has Minecraft's own track
  if (map && map.kind === 'stronghold') { music.stop(1); return; }
  if (map && map.kind === 'end') { if (force || music.current !== 'the_end') music.play('the_end'); return; }
  const own = map && map.music && A.world.music && A.world.music[map.music];
  if (own) { if (force || music.current !== own) music.play(own); return; }
  const name = id === 'MAP_PALLET_TOWN' ? 'pallet' : id === 'MAP_VIRIDIAN_CITY' || id === 'MAP_PEWTER_CITY' ? 'pewter'
    : id === 'MAP_ROUTE1' || id === 'MAP_ROUTE2' || id === 'MAP_ROUTE22' ? 'route1' : id.includes('CITY') || id.includes('TOWN') ? 'pewter' : 'route3';
  if (force || music.current !== name) music.play(name);
}

// ---------------------------------------------------------------- FireRed menu and message box
const MENU = ['POKéDEX', 'POKéMON', 'BAG', 'STEVE', 'SAVE', 'CO-OP', 'EXIT'];
// the START rows: Classic's MENU; generated worlds add OPTION and TITLE (6.5), a spectator has the short list (6.4)
const menuRows = () => (MODES && world.layout.gen ? ((r) => (!MAP_ON ? r : r.includes('EXIT') ? [...r.slice(0, r.indexOf('EXIT')), 'MAP', ...r.slice(r.indexOf('EXIT'))] : [...r, 'MAP']))(MODES.startRows(true, G.mode)) : MENU);   // (generated worlds: MAP before EXIT, or last)
function updateMenu() {
  const MENU = menuRows();
  if (menuCursor >= MENU.length) menuCursor = 0;
  if (input.just('up')) { menuCursor = (menuCursor + MENU.length - 1) % MENU.length; sfx.move(); }
  if (input.just('down')) { menuCursor = (menuCursor + 1) % MENU.length; sfx.move(); }
  if (input.just('b') || input.just('start')) { state = 'play'; sfx.cancel(); return; }
  if (!input.just('a')) return;
  sfx.select();
  const it = MENU[menuCursor];
  if (it === 'OPTION') { openOption(); return; }
  if (it === 'TITLE') { askTitle(); return; }
  if (it === 'MAP') { openMap(); return; }
  if (it === 'EXIT') state = 'play';
  else if (it === 'BAG') G.openScreen('inventory');
  else if (it === 'POKéDEX') { state = 'dex'; dexCursor = 0; }
  else if (it === 'STEVE') state = 'card';
  else if (it === 'POKéMON') openParty();
  else if (it === 'SAVE' && NET.guest) { state = 'play'; say("You can't save in a friend's world."); }
  else if (it === 'SAVE') { state = 'play'; ask('Would you like to save the game?', () => { const ok = saveGame(); const done = (k) => { if (k) sfx.save(); say(k ? `${G.myName || 'STEVE'} saved the game.` : 'The save failed.'); }; if (ok && ok.then) ok.then(done); else done(ok); if (NET.on && NET.s) NET.s.askRecords(); }, () => {}); }
  else if (it === 'CO-OP') { state = 'coop'; NET.open('menu'); }
}
// START > OPTION (6.5, generated worlds): MUSIC, WILD POKeMON (Creative), DIFFICULTY (Survival; a guest's is the host's)
let optionUI = null;
function openOption() {
  const rows = (NET.guest ? ['MUSIC'] : MODES.optionRows(G.mode)).concat(MAP_ON ? ['MINIMAP'] : [], input.pad && input.pad.seen ? ['A BUTTON'] : []);   // (the minimap's switch, every mode; a controller's A, once one was used)
  optionUI = new OPT.OptionWindow(rows, {
    sfx, music: () => !isMusicMuted(), setMusic: (on) => setMusicMuted(!on), padA: () => input.pad.aButton(), setPadA: (v) => input.pad.setLayout(v),
    wild: () => G.wildOpt !== false, setWild: (on) => { G.wildOpt = !!on; if (world.wd) world.wd.wild = !!on; },
    diff: () => G.diff, setDiff: (d) => setMode(G.mode, d), minimap: () => (MM ? MM.pref() : true), setMinimap: (on) => { if (MM) MM.setPref(on); },
  });
  state = 'option';
}
function updateOption(dt) {
  if (!optionUI) { state = 'menu'; return; }
  optionUI.update(dt, input);
  if (optionUI.done) { optionUI = null; state = 'menu'; }
}
// START > TITLE (6.5): "Return to the title screen?" with FireRed's unsaved-progress warning (a hardcore world saves
// itself, so it gets no warning and saves once more); in co-op it leaves the room as CO-OP's own LEAVE or CLOSE does
function askTitle() {
  const hc = G.mr && G.mr.autosave;
  const go = () => {
    if (hc) autosave('title');
    // (playfix: flag.js's NET has no leave(); the host closes the room, a guest leaves it and goes home)
    if (NET.on && NET.s) { if (NET.s.role === 'host') NET.s.close(); else NET.s.leave(); }
    if (NET.guest) return;   // (a guest goes home, to its own title, through the session)
    P.mining = null; P.using = null;
    titleLeft = true;   // stage 9: CONTINUE now reloads the world from its save
    state = 'title'; titleT = 0; music.play('title');
  };
  state = 'play';
  const warn = NET.on && NET.host ? ['Your friends will leave the game.'] : [];
  if (hc) { if (warn.length) sayPages(warn, () => ask('Return to the title screen?', go, () => {}, true)); else ask('Return to the title screen?', go, () => {}, true); }
  else sayPages([...warn, 'Any progress since your last save\nwill be lost.'], () => ask('Return to the title screen?', go, () => {}, true));
}
const dexOrder = () => Object.keys(A.dex.species).filter((k) => k !== 'STEVE');
function openParty() {
  state = 'party';
  const list = [steveMon(G), ...G.party];
  partyUI = new PartyScreen({
    party: list, mode: 'field', prompt: 'Choose a POKéMON.',
    onDone: () => { partyUI = null; state = 'play'; },
    actionsFor: (mon, i, scr) => [
      { label: 'SUMMARY', run: () => { if (mon.isSteve) scr.say(`${G.myName || 'STEVE'}  Lv${P.level}\nHP ${Math.ceil(P.health)}/20  FOOD ${P.food}/20`); else { summaryMon = mon; state = 'summary'; } } },
      ...(i > 0 ? [{ label: 'SWITCH', run: () => scr.beginSwitch(i) }] : []),
      { label: 'CANCEL', run: () => {} },
    ],
  });
  partyUI.onSwitch = (a, b) => { if (a === 0 || b === 0) { const l = partyUI.party; const s = l.indexOf(l.find((m) => m.isSteve)); if (s !== 0) { [l[0], l[s]] = [l[s], l[0]]; } } G.party = partyUI.party.filter((m) => !m.isSteve); };
}
function updateMsg(dt) {
  const m = msg;
  const page = m.pages[m.page];
  const total = page.reduce((n, l) => n + l.length, 0);
  if (m.shown < total) {
    m.shown = Math.min(total, m.shown + dt * 60);
    if (input.just('a') || input.just('b')) m.shown = total;
    return;
  }
  if (m.ask && m.page === m.pages.length - 1) {
    if (!yesno) yesno = { cursor: m.ask.noFirst ? 1 : 0 };
    if (input.just('up') || input.just('down')) { yesno.cursor ^= 1; sfx.move(); }
    if (input.just('a') || input.just('b')) {
      const yes = input.just('a') && yesno.cursor === 0;
      sfx[yes ? 'select' : 'cancel']();
      const cb = yes ? m.ask.onYes : m.ask.onNo;
      yesno = null; msg = null; state = m.from === 'msg' ? 'play' : m.from;
      if (cb) cb();
    }
    return;
  }
  if (input.just('a') || input.just('b')) {
    sfx.select();
    if (m.page < m.pages.length - 1) { m.page++; m.shown = 0; return; }
    msg = null; state = m.from === 'msg' ? 'play' : m.from;
    if (m.then) m.then();
  }
}

// ---------------------------------------------------------------- sleeping, death screen, title
function updateSleep(dt) {
  if (NET.on) { coopSleep(dt); return; }
  seq.t += dt;
  fade = Math.min(1, seq.t / 2.2);
  if (seq.t >= 2.6 && !seq.woke) {
    seq.woke = true;
    G.time = 0; G.day++;
    PL.wake(P);
    wakeHeal();
    G.ents = G.ents.filter((e) => !(e.type === 'mob' && E.HOSTILE.has(e.kind) && e.kind !== 'creeper' && e.kind !== 'spider'));
  }
  if (seq.t >= 2.6) fade = Math.max(0, 1 - (seq.t - 2.6) / 0.8);
  if (seq.t >= 3.4) { seq = null; state = 'play'; fade = 0; }
}
// co-op: lying in bed until everyone in the Overworld is (the host wakes everyone with the morning); B gets up
function coopSleep(dt) {
  seq.t += dt;
  if (!seq.woke) {
    fade = Math.min(0.6, seq.t / 2.2);
    const c = NET.s && NET.s.sleepCount;
    if (c) G.actionBar = { text: `Sleeping... ${c[0]}/${c[1]} players`, t: 0.4 };
    if (input.just('b') || !P.sleeping) { if (P.sleeping) PL.wake(P); seq = null; state = 'play'; fade = 0; }
    return;
  }
  fade = Math.max(0, 1 - (seq.t - 2.6) / 0.8);
  if (seq.t >= 3.4) { seq = null; state = 'play'; fade = 0; }
}
// the host says the night is over: the wake of single-player's updateSleep (the time and the monsters are the host's)
function coopWake() {
  if (state !== 'sleep' || !seq || seq.woke) return false;
  seq.woke = true; seq.t = 2.6; fade = 1;
  PL.wake(P);
  wakeHeal();
  return true;
}
// Healing outside Kanto (6.6, generated worlds only): a night slept through restores the party with Mom's heal jingle
// as the morning fades in; Classic keeps today's rules
function wakeHeal() {
  if (!world.layout.gen) return;
  healEveryone(); sfx.heal();
  G.healedAt = { why: 'bed', day: G.day };
}
function updateDead(dt) {
  // a hardcore death (6.4): "Game over!", then Spectate World or Title Screen
  if (G.hc && G.mr && G.mr.oneLife) {   // (stage 10: a co-op guest's too; its Title Screen leaves the room)
    if (!hcScreen) hcScreen = new HC.HardcoreDeathScreen({ cause: P.deathMsg || G.hc.cause, score: G.score });
    hcScreen.update(dt, input);
    if (hcScreen.done) hardcoreChoice(hcScreen.result && hcScreen.result.op);
    return;
  }
  if (!deathUI) deathUI = { t: 0, sel: 0 };   // (the state set without its screen, as a test hook can: never throw)
  deathUI.t += dt;
  if (deathUI.t < 1) return;
  if (input.just('up') || input.just('down')) { deathUI.sel ^= 1; mc('click', { vol: 0.15 }); }
  const m = input.mouse;
  const bx = HW / 2 - 100;
  if (input.just('mouseL')) {
    if (m.x >= bx && m.x < bx + 200 && m.y >= HH / 4 + 72 && m.y < HH / 4 + 92) { mc('click', { vol: 0.2 }); respawn(); return; }
  }
  if (input.just('a') || input.just('start')) { mc('click', { vol: 0.2 }); respawn(); }
}
function drawDead() {
  HI();
  if (hcScreen) { hcScreen.draw(ctx); return; }
  const g = ctx.createLinearGradient(0, 0, 0, HH);
  g.addColorStop(0, 'rgba(80,0,0,0.38)'); g.addColorStop(1, 'rgba(128,48,48,0.63)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, HW, HH);
  const t1 = 'You died!';
  mcText(ctx, t1, Math.round(HW / 2 - mcWidth(t1, 2) / 2), Math.round(HH / 4 - 12), '#ffffff', true, 2);
  const cause = P.deathMsg || `${P.name} died`;
  mcText(ctx, cause, Math.round(HW / 2 - mcWidth(cause) / 2), Math.round(HH / 4 + 18), '#ffffff');
  const sc = `Score: §e${G.score}`;
  const scoreTxt = 'Score: ', num = String(G.score);
  const sw = mcWidth(scoreTxt + num);
  mcText(ctx, scoreTxt, Math.round(HW / 2 - sw / 2), Math.round(HH / 4 + 34), '#ffffff');
  mcText(ctx, num, Math.round(HW / 2 - sw / 2 + mcWidth(scoreTxt) + 1), Math.round(HH / 4 + 34), '#ffff55');
  void sc;
  const active = deathUI.t >= 1;
  ['Respawn', 'Title Screen'].forEach((label, i) => {
    const bx = Math.round(HW / 2 - 100), by = Math.round(HH / 4 + 72 + i * 24);
    const hover = active && deathUI.sel === i;
    drawButton(bx, by, 200, 20, label, hover, active && i === 0);
  });
}
function drawButton(x, y, w, h, label, hover, enabled = true) {
  const img = hover ? A.mc.gui_button_highlighted : A.mc.gui_button;
  ctx.drawImage(img, 0, 0, w / 2, h, x, y, w / 2, h);
  ctx.drawImage(img, img.width - w / 2, 0, w / 2, h, x + w / 2, y, w / 2, h);
  if (!enabled) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x, y, w, h); }
  mcText(ctx, label, Math.round(x + w / 2 - mcWidth(label) / 2), y + 6, enabled ? (hover ? '#ffffa0' : '#e0e0e0') : '#a0a0a0');
}

// ---------------------------------------------------------------- waiting for generated chunks (2.13, 10.1)
// Generated layouts: `fn` runs once the 3 x 3 chunks around each point are ready. While the worker makes them the
// view fades to black (state 'genwait', the world held still) and fades back in on arrival; 1.5 s without an
// answer and the streaming paints them here. Classic, or everything ready already: `fn` runs at once.
let genWait = null;
function afterReady(pts, fn) {
  if (!world.layout.gen) { fn(); return; }
  const ps = [];
  for (const p of pts) if (p && Number.isInteger(p.x) && Number.isInteger(p.y)) { const r = world.ensureAround(p.x, p.y, 1); if (r !== true) ps.push(r); }
  if (!ps.length) { fn(); return; }
  const g = { t: 0, fn: null, back: state === 'genwait' ? 'play' : state, t0: performance.now() };
  genWait = g; state = 'genwait';
  Promise.all(ps).then(() => { g.fn = fn; }, () => { g.fn = fn; });
}
function updateGenWait(dt) {
  const g = genWait;
  if (!g) { state = 'play'; return; }
  g.t += dt;
  if (!g.fn) return;
  genWait = null; state = g.back;
  G.lastWait = { ms: performance.now() - g.t0, frames: Math.round(g.t * 30) };
  try { g.fn(); } catch (e) { noteError(e); }
  G.endFade = Math.max(G.endFade || 0, Math.min(1, g.t / 0.15));
}

// ---------------------------------------------------------------- update
function update(dt) {
  input.poll(dt);   // controllers (src/pad.js): nothing until one connects
  if (NET.on) NET.pre(dt);   // co-op: apply what arrived before anything moves
  time += dt; G.clock += dt; G.playTime += dt;
  if (input.just('mute')) { setMusicMuted(!isMusicMuted()); G.toast(isMusicMuted() ? 'Music: OFF' : 'Music: ON'); }
  banner.t += dt;
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt);
  const live = state === 'play' || state === 'screen' || state === 'dead' || state === 'sleep';
  if (live) updateWorld(dt);
  else if (NET.host && state !== 'title') updateWorld(dt, false);   // co-op: the world goes on for the guests
  switch (state) {
    case 'title': titleT += dt; if (MENUS_ON && (titleMenus || titleBusy)) { updateTitleMenus(dt); break; } if (coopTitle && titleT > 0.6 && titleCoop()) break; if (titleT > 0.6 && (input.just('a') || input.just('start'))) { if (MENUS_ON) { sfx.select(); openTitleMenus(); } else startFromTitle(); } break;
    case 'coop': if (NET.ui) NET.ui.update(dt, input); break;
    case 'play': updatePlay(dt); break;
    case 'screen': if (screen.kind === 'trade' && screen.v && screen.v.type === 'mob') screen.v.hold = Math.max(screen.v.hold || 0, 0.5);   // (7c: it stands still while trading)
      if (NET.on && NET.s && screen.target) NET.s.screen(screen, dt, input); else screen.update(dt, input); if (screen.done) { screen.close(); if (screen.kind === 'chest') mc('chest_close', { vol: 0.5 }); screen = null; state = 'play'; } break;
    case 'menu': updateMenu(); break;
    case 'option': updateOption(dt); break;
    case 'msg': updateMsg(dt); break;
    case 'party': partyUI.update(dt, input); break;
    case 'dex': {
      const n = G.dex.seen.size;
      if (input.just('up') && dexCursor > 0) { dexCursor--; sfx.move(); }
      if (input.just('down') && dexCursor < n - 1) { dexCursor++; sfx.move(); }
      // A on an entry: its page, with the front sprite
      if (input.just('a') && n) { const list = dexOrder().filter((k) => G.dex.seen.has(k)); dexKey = list[Math.min(dexCursor, list.length - 1)]; state = 'dexEntry'; sfx.select(); break; }
      if (input.just('b')) { state = 'play'; sfx.cancel(); }
      break;
    }
    case 'dexEntry': if (input.just('a') || input.just('b')) { state = 'dex'; sfx.cancel(); } break;
    case 'summary': if (input.just('a') || input.just('b')) { state = summaryMon && partyUI ? 'party' : 'play'; summaryMon = null; sfx.cancel(); } break;
    case 'card': if (input.just('a') || input.just('b')) { state = 'play'; sfx.cancel(); } break;
    case 'transition': updateTransition(dt); break;
    case 'battle': updateBattle(dt); break;
    case 'battleOut': updateBattleOut(dt); break;
    case 'sleep': updateSleep(dt); break;
    case 'warp': updateWarp(dt); break;
    case 'shop': mart.update(input); if (mart.done) { const b = mart.back; mart = null; state = 'play'; say('Please come again!', b); } break;
    case 'pc': if (pcUI) { pcUI.update(input); if (pcUI.done) { pcUI = null; state = 'play'; } } else state = 'play'; break;
    case 'heal': if (seq && seq.kind === 'momheal') updateMomHeal(dt); else if (seq) updateHeal(dt); else state = 'play'; break;
    case 'dead': updateDead(dt); break;
    case 'hof': if (hof) { hof.update(dt, input); if (hof.done) { hof = null; goHome(); } } else state = 'play'; break;
    case 'genwait': updateGenWait(dt); break;
  }
  if (G.mr) modeTick(dt);
  updateCamera();
  if (world.stream) streamTick();
  if (MAP_ON) minimapTick(dt);
  if (NET.on) NET.post(dt);   // co-op: this frame's network tick (one batched message at most)
}
// Generated layouts: the chunk streaming (src/chunks.js) once a frame, after the camera moved. It never throws to the
// loop; the generator's own errors (a fallback chunk) land in G.errors too.
function streamTick() {
  // (a co-op host streams around every player, so it simulates and validates on land its guests stand on, 9.2)
  try { world.stream.update(NET.h ? NET.players() : [P], cam, VW, VH); } catch (e) { noteError(e); }
  const errs = world.gen.errors;
  while (errs.length) noteError(errs.shift());
}
function noteError(e) {
  const m = String((e && e.stack) || e);
  G.errors = G.errors || [];
  if (!G.errors.includes(m)) { if (G.errors.length < 30) G.errors.push(m); console.error(e); }
}
// ---------------------------------------------------------------- the minimap and the full map (minimap-design.md 3)
// src/minimap.js and src/ui/mapscreen.js load at the first frame (never under ?video: the films render as before, and
// START gets no MAP row there); until they are in, MM is null and every hook here does nothing. Nothing throws to the
// loop. The minimap binds to G.world itself (again when a co-op guest's world replaces it) and reveals, flushes and
// builds its tiles in minimapTick (inside a 0.3 ms budget); drawMinimap only blits.
const MAP_ON = !params.has('video');
let MM = null, MSM = null, mapLoading = null, mapWant = -1, mapFrom = -1, mapOverride = null;
function minimapTick(dt) {
  if (!MM) {
    if (!mapLoading) {
      mapLoading = Promise.all([importR('./minimap.js'), importR('./ui/mapscreen.js')])
        .then(async ([m, s]) => { if (await m.loadMinimap()) { MSM = s; MM = new m.MiniMap(); MM.override = mapOverride; } })
        .catch((e) => { console.warn('minimap: not loaded', e); });
    }
    return;
  }
  if (state !== 'play') mapWant = -1;   // (a want left from before a battle, a warp or a message is dropped)
  try { MM.update(dt, state); } catch (e) { noteError(e); }
}
// shown only while playing (or reading a message, whose box is at the bottom), never dead, asleep, in a fade, in The
// End's set pieces, under a video overlay or while the co-op chat field is open (its rows can rise into the corner)
function minimapVisible() {
  if (state !== 'play' && state !== 'msg') return false;
  if (P.dead || P.sleeping || fade > 0 || G.endFade > 0 || (G.camFocus && G.camFocus.k > 0) || G.overlay) return false;
  return !(NET.on && document.getElementById('coop-chat'));
}
function drawMinimap() {
  if (!MM) return;
  try { HI(); MM.drawHud(ctx, minimapVisible()); } catch (e) { noteError(e); }
}
function openMap() {
  if (!MM || !MSM) return;
  try { screen = new MSM.MapScreen(MM, { sfx }); state = 'screen'; mapWant = -1; } catch (e) { noteError(e); }
}
// updatePlay (spectators too): J or a tap on the minimap opens the full map between steps. A press during a step is
// kept for 0.5 s and acted on when that step ends (Steve stops, or the next step has just begun), so it never opens
// minutes later after a battle or a warp.
function mapPlay() {
  if (input.just('map') || (MM && MM.tapped(input))) { mapWant = time; mapFrom = P.moving ? P.fromX * 65536 + P.fromY : -1; }
  if (mapWant < 0) return false;
  if (time - mapWant >= 0.5) { mapWant = -1; return false; }
  if (P.moving && P.fromX * 65536 + P.fromY === mapFrom) return false;
  mapWant = -1;
  if (!MM || !MSM) return false;
  P.mining = null; P.using = null;
  openMap();
  return state === 'screen';
}
// Classic's mask lives in a sibling key tied to the save by its play time (3.12), written only after the save
// itself landed; before the minimap has bound, the loaded sibling is re-stamped so it stays the save's. Never throws.
function mapSaveClassic(pt) {
  try {
    if (NET.guest) return;
    if (MM && MM.world === world && MM.bound) { MM.saveClassic(pt); return; }
    const ld = G.mapLoad, key = SAVE_KEY + '-map';
    if (!ld || ld.world !== world || ld.v !== 1) return;
    const rec = JSON.parse(localStorage.getItem(key) || 'null');
    if (rec && rec.pt === ld.pt) { localStorage.setItem(key, JSON.stringify({ ...rec, pt })); ld.pt = pt; }
  } catch (e) { try { localStorage.removeItem(SAVE_KEY + '-map'); } catch (e2) { /* none */ } }
}
// window.__rs.minimap(o): { on, shown, screen, k, explored, region, stats, ... }; { show } sets the in-memory override
// (true: shown, false: hidden, null: the player's preference); { mm: true } the MiniMap itself
function minimapHook(o) {
  if (o && o.mm) return MM;
  if (o && 'show' in o) { mapOverride = o.show === true || o.show === false ? o.show : null; if (MM) MM.override = mapOverride; }
  const sc = state === 'screen' && screen && screen.kind === 'map' ? screen : null;
  return { ...(MM ? MM.info() : { loaded: false }), loaded: !!MM, screen: sc ? 'map' : null, view: sc && sc.info ? sc.info() : null };
}
const cam = { x: 0, y: 0 };
G.cam = cam;   // ghasts open their mouths only where Steve can see them
function updateCamera() {
  const tx = (P.sleeping ? P.sleeping.hx : P.fx) * TILE + 8, ty = (P.sleeping ? P.sleeping.hy : P.fy) * TILE + 8;
  // outdoors the view stays inside outdoor Kanto, never scrolling down into the rooms packed below it
  if (!world.isOutdoor(P.tx, P.ty)) {
    let fx = tx, fy = ty;
    // The End's set pieces (the dragon's death, the respawn ritual) take the view over to them, as Minecraft's
    // player simply looks up at them, and hand it back to Steve when they end
    const f = G.camFocus;
    if (f && f.k > 0 && world.inEnd(P.tx, P.ty)) {
      fx = tx + (f.x - tx) * f.k; fy = ty + (f.y - ty) * f.k;
      if (f.clamp) { const my = f.loose ? VH / 2 - 32 : VH / 2 - 36; fx = tx + Math.max(-(VW / 2 - 24), Math.min(VW / 2 - 24, fx - tx)); fy = ty + Math.max(-my, Math.min(my, fy - ty)); }
    }
    cam.x = Math.round(fx - VW / 2); cam.y = Math.round(fy - VH / 2); return;
  }
  // generated layouts: the overworld rectangle (the border is visible, with up to 8 cells of sea past it, 2.8)
  if (world.layout.gen) {
    const L = world.layout;
    cam.x = Math.max(L.ox * TILE, Math.min((L.ox + L.ow) * TILE - VW, tx - VW / 2));
    cam.y = Math.max(L.oy * TILE, Math.min((L.oy + L.oh) * TILE - VH, ty - VH / 2));
    return;
  }
  const w = world.outdoor.w, h = world.outdoor.h;
  cam.x = Math.max(0, Math.min(w * TILE - VW, tx - VW / 2));
  cam.y = Math.max(0, Math.min(h * TILE - VH, ty - VH / 2));
}

// ---------------------------------------------------------------- draw
function viewCam() {
  const s = G.shake > 0 ? G.shake * 6 : 0;
  return { x: Math.round(cam.x + (Math.random() - 0.5) * s), y: Math.round(cam.y + (Math.random() - 0.5) * s) };
}
function placedSprites(c, list) {
  const W = world;
  const x0 = Math.floor(c.x / TILE) - 1, x1 = Math.floor((c.x + VW) / TILE) + 1, y0 = Math.floor(c.y / TILE) - 1, y1 = Math.floor((c.y + VH) / TILE) + 2;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const b = W.block(x, y);
    if (!b || (b.flush && !b.crop) || W.baked(b)) continue;   // (generated decorations drawn with the ground: world.drawDeco)
    let key = b.id;
    if (b.crop) key = `wheat:${b.crop.stage}`;
    else if (b.id === 'furnace' && b.burn > 0) key = 'furnace:lit';
    else if (b.id === 'campfire' && b.lit) key = 'campfire:lit';
    else if (isDoor(b) && b.open) key = b.id + ':open';
    else if (b.id === 'white_bed') key = `white_bed:${b.orient}:${b.part}`;
    else if (b.id === 'oak_fence' || b.id === 'birch_fence') {
      const conn = (xx) => { const n = W.block(xx, y); return n && (n.id.endsWith('_fence') || (!n.walk && !n.flush && item(n.id) && item(n.id).block.look === 'raised')) ? 1 : 0; };
      key = `${b.id}:${conn(x + 1)}${conn(x - 1)}`;
    }
    if (b.id === 'lava' || b.id === 'nether_portal' || b.id === 'end_portal') continue;      // drawn with the ground (nether.js, end.js drawGround)
    if (b.id === 'end_portal_frame' && b.eye) key = 'end_portal_frame:eye';
    if (b.id === 'fire' || b.id === 'soul_fire') {
      // Minecraft's animated flame strips, each fire a little out of step with its neighbours
      const soul = b.id === 'soul_fire', img = soul ? A.mc.soulFire : A.mc.fireStrip, f = NE.animFrame(soul ? 'soul_fire' : 'fire', G.clock + ((x * 7 + y * 13) % 32) / 20);
      list.push({ y: y + 0.1, fn: () => ctx.drawImage(img, 0, f * 16, 16, 16, x * TILE - c.x, y * TILE - c.y - 4, 16, 20) });
      continue;
    }
    if (b.id === 'nether_wart') key = `nether_wart:${Math.min(2, b.stage || 0)}`;
    const look = blockLook(key);
    if (look == null) continue;
    const yy = b.crop ? y + 0.05 : y;
    // the obsidian under a lit portal keeps its raised top inside its own cell, so it doesn't cover the portal's
    // bottom row (a portal reads as its full size, like the Nether's own)
    const lowTop = b.id === 'obsidian' && W.isPortal(x, y - 1);
    list.push({ y: yy - (b.walk ? 0.4 : 0), fn: () => {
      if (lowTop) { ctx.save(); ctx.beginPath(); ctx.rect(x * TILE - c.x, y * TILE - c.y, 16, 24); ctx.clip(); drawLook(ctx, look, x * TILE - c.x, y * TILE - 8 - c.y); ctx.restore(); }
      else drawLook(ctx, look, x * TILE - c.x, y * TILE - 8 - c.y);
      if (b.id === 'torch' && Math.random() < 0.06) E.particle({ x: x * TILE + 8, y: y * TILE + 1, z: 6, vz: 8, life: 0.6, img: A.mc.pSmoke, frames: 12, fw: 16, size: 0, scale: 0.75 });
      if (b.id === 'torch') { const f = Math.floor(G.clock * 6) % 2; ctx.fillStyle = f ? '#ffe070' : '#ffb030'; ctx.fillRect(x * TILE - c.x + 7, y * TILE - c.y + 1 - f, 2, 2); }
      if (b.id === 'campfire') {
        // food on its four spots, then the flames (Minecraft's 8-frame strip)
        const spots = [[1, -2], [7, -2], [1, 3], [7, 3]];
        (b.items || []).forEach((s, k) => { if (!s) return; const ii = item(s.id).iconIndex; ctx.drawImage(A.mc.icons, (ii % 32) * 16, Math.floor(ii / 32) * 16, 16, 16, x * TILE - c.x + spots[k][0], y * TILE - c.y + spots[k][1], 8, 8); });
        if (b.lit && A.mc.campfireFire) { const f = Math.floor(G.clock * 10) % 8; ctx.drawImage(A.mc.campfireFire, 0, f * 16, 16, 16, x * TILE - c.x, y * TILE - c.y - 9, 16, 16); }
      }
    } });
  }
}
function drawWorld() {
  GBA();
  const c = viewCam();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, VW, VH);
  world.drawLayer(ctx, c, VW, VH, 'below');
  NE.drawGround(ctx, c, VW, VH);
  END.safe('drawGround', () => END.drawGround(ctx, c, VW, VH));
  if (doorAnim) ctx.drawImage(A.img.doors, doorAnim.a * 16, doorAnim.f * 16, 16, 16, doorAnim.x * TILE - c.x, doorAnim.y * TILE - c.y, 16, 16);
  const list = [];
  placedSprites(c, list);
  E.worldSprites(c, list);
  npcSprites(c, list);
  wildSprites(c, list, owFrame);
  if (NET.on && NET.s) NET.s.sprites(c, list);   // co-op: the other players
  list.push({ y: (P.sleeping ? P.sleeping.hy + 0.2 : P.fy) + 0.02, fn: () => {
    // falling out of The End: he shrinks away into the void
    if (P.voidFall) {
      const k = Math.min(1, P.voidFall.t / 1.0), cx = P.fx * TILE + 8 - c.x, cy = P.fy * TILE + 13 - c.y;
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - k); ctx.translate(cx, cy + k * 12); ctx.scale(1 - 0.7 * k, 1 - 0.7 * k); ctx.translate(-cx, -cy);
      PL.drawSteve(ctx, P, c); ctx.restore();
      return;
    }
    if (G.mr && G.mr.ghostAlpha < 1) HC.ghost(ctx, () => PL.drawSteve(ctx, P, c));   // a spectator: at 35% (6.4)
    else PL.drawSteve(ctx, P, c);
    // burning: the fire strip over him
    if (P.fireT > 0 && !P.dead) { const f = NE.animFrame('fire'); ctx.globalAlpha = 0.85; ctx.drawImage(A.mc.fireStrip, 0, f * 16, 16, 16, Math.round(P.fx * TILE - c.x), Math.round(P.fy * TILE - c.y - 18 - P.z), 16, 24); ctx.globalAlpha = 1; }
  } });
  list.push({ y: follower.fy + 0.015, fn: () => drawFollower(c) });
  list.sort((a, b) => a.y - b.y).forEach((s) => s.fn(ctx));
  // tall grass rustle over Steve's feet
  for (const p of G.parts) if (p.grass) { const f = Math.min(4, Math.floor((p.age / p.life) * 5)); ctx.drawImage(A.img.fxTallGrass, 0, f * 16, 16, 16, Math.round(p.x - 8 - c.x), Math.round(p.y - 8 - c.y + 4), 16, 16); }
  world.drawLayer(ctx, c, VW, VH, 'above');
  if (world.layout.gen) drawBorder(c);
  E.drawTallOverTop(ctx, c);
  E.drawFlyers(ctx, c);
  END.safe('drawAir', () => END.drawAir(ctx, c));
  if (!P.voidFall && END.safe('steveFront', () => world.inEnd(P.tx, P.ty) && DR.steveInFront())) PL.drawSteve(ctx, P, c);
  if (seq && seq.kind === 'heal' && seq.nurse) drawHealBalls(c);
  PL.drawCrack(ctx, P, c);
  HI();
  E.drawHiresEntities(ctx, c);
  END.safe('drawFlying', () => END.drawFlying(ctx, c));
  E.drawParticles(ctx, c);
  GBA();
  drawLighting(c);
  E.drawGlowing(ctx, c);
  END.safe('drawGlow', () => END.drawGlow(ctx, c));
  // a room shows only itself: black past its walls
  const room = world.roomAt(P.tx, P.ty);
  if (room) {
    const x0 = room.x * TILE - c.x, y0 = room.y * TILE - c.y, x1 = x0 + room.w * TILE, y1 = y0 + room.h * TILE;
    ctx.fillStyle = '#000';
    if (y0 > 0) ctx.fillRect(0, 0, VW, y0);
    if (y1 < VH) ctx.fillRect(0, y1, VW, VH - y1);
    if (x0 > 0) ctx.fillRect(0, 0, x0, VH);
    if (x1 < VW) ctx.fillRect(x1, 0, VW - x1, VH);
  }
  if (NET.on && NET.s) { HI(); NET.s.tags(ctx, c); GBA(); }   // co-op: name tags, after the lighting
}
// FireRed's healing machine: a ball per POKéMON beside the nurse, flashing while the jingle plays
function drawHealBalls(c) {
  const q = seq, n = q.nurse, img = A.img.healBall;
  if (!img) return;
  const off = [[0, 0], [6, 0], [0, 4], [6, 4], [0, 8], [6, 8]];
  const flash = q.jingle && Math.floor(q.t * 7.5) % 2 === 0;
  for (let i = 0; i < Math.min(q.shown, 6); i++) {
    const x = n.tx * TILE - 19 + off[i][0] - c.x, y = n.ty * TILE - 4 + off[i][1] - c.y;
    ctx.drawImage(img, Math.round(x), Math.round(y));
    if (flash) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.6; ctx.drawImage(img, Math.round(x), Math.round(y)); ctx.restore(); }
  }
}
function drawMenu() {
  GBA();
  const MENU = menuRows();
  // (a co-op player's name can be wider than STEVE: the window grows to the left to fit it)
  // generated worlds' nine rows do not fit above the hint window: 7 show at a time and the list scrolls, as FireRed's
  // long lists do, with its little arrows (Classic's 7 rows never scroll)
  const vis = Math.min(MENU.length, 7), top = Math.max(0, Math.min(MENU.length - vis, menuCursor - vis + 2));
  const w = G.myName ? Math.max(80, 18 + textWidth(G.myName) + 10) : 80, x = VW - w, h = listHeight(vis);
  drawWindow(ctx, x, 0, w, h);
  MENU.slice(top, top + vis).forEach((it, k) => { const i = top + k; drawText(ctx, it === 'STEVE' && G.myName ? G.myName : it, x + 18, 6 + k * 16, FG, SH); if (i === menuCursor) cursorArrow(ctx, x + 9, 9 + k * 16); });
  if (MENU.length > vis) {
    const bob = Math.floor(time * 4) % 2, ax = x + w / 2 - 3;
    ctx.fillStyle = '#e04848';
    if (top > 0) for (let i = 0; i < 4; i++) ctx.fillRect(ax + 3 - i, 3 - bob + i, 1 + i * 2, 1);
    if (top + vis < MENU.length) for (let i = 0; i < 4; i++) ctx.fillRect(ax + 3 - i, h - 3 + bob - i, 1 + i * 2, 1);
  }
  const hints = { 'POKéDEX': 'A device that records POKéMON secrets.', 'POKéMON': 'Check and organize POKéMON in your party.', BAG: 'Open your inventory.',
    STEVE: 'Check your money and other game data.', SAVE: 'Save your game.', 'CO-OP': 'Play with friends.', EXIT: 'Close this menu window.',
    OPTION: 'Adjusts various game settings.', TITLE: 'Return to the title screen.', MAP: 'Check the map of places you have been.' };
  drawWindow(ctx, 0, VH - 32, VW, 32);
  drawText(ctx, hints[MENU[menuCursor]] || '', 10, VH - 24, FG, SH);
}
// Title: FireRed's own POKéMON logo over rising redstone dust (where FireRed has flames), with
// REDSTONE VERSION in Minecraft's font and Steve where the box-art Charizard stands.
const dust = [];
function drawTitle(bare = false) {
  HI();
  const t = titleT;
  const g = ctx.createLinearGradient(0, 0, 0, HH);
  g.addColorStop(0, '#000000'); g.addColorStop(0.6, '#140404'); g.addColorStop(1, '#3a0808');
  ctx.fillStyle = g; ctx.fillRect(0, 0, HW, HH);
  while (dust.length < 90) dust.push({ x: Math.random() * HW, y: HH + Math.random() * HH, v: 12 + Math.random() * 30, s: 1 + Math.floor(Math.random() * 3), ph: Math.random() * 6 });
  for (const p of dust) {
    p.y -= p.v / 60; if (p.y < -4) { p.y = HH + 4; p.x = Math.random() * HW; }
    const k = Math.max(0, Math.min(1, p.y / HH));
    ctx.fillStyle = k > 0.5 ? '#ff2a1a' : k > 0.25 ? '#c81810' : '#7a0a06';
    ctx.globalAlpha = 0.35 + 0.65 * k;
    ctx.fillRect(Math.round(p.x + Math.sin(t * 1.5 + p.ph) * 3), Math.round(p.y), p.s * 2, p.s * 2);
  }
  ctx.globalAlpha = 1;
  // Steve on the right, lit from below by the dust
  const ts = A.mc.titleSteve;
  ctx.drawImage(ts, HW - ts.width - 22, HH - ts.height - 18);
  const glow = ctx.createLinearGradient(0, HH - 140, 0, HH);
  glow.addColorStop(0, 'rgba(255,40,20,0)'); glow.addColorStop(1, 'rgba(255,40,20,0.22)');
  ctx.fillStyle = glow; ctx.fillRect(0, HH - 140, HW, 140);
  // the logo drops in, then the version line
  const drop = Math.min(1, t / 0.7), ease = 1 - Math.pow(1 - drop, 3);
  ctx.drawImage(A.img.titleLogo, 24, Math.round(18 - (1 - ease) * 140), 352, 118);
  if (t > 0.8) {
    const a = Math.min(1, (t - 0.8) / 0.4);
    ctx.globalAlpha = a;
    const r = 'REDSTONE', v = 'VERSION';
    const rx = 112, ry = 140;
    for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]]) mcText(ctx, r, rx + dx, ry + dy, '#3a0000', false, 3);
    mcText(ctx, r, rx, ry, '#ff3020', false, 3);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) mcText(ctx, v, rx + 52 + dx, ry + 30 + dy, '#200000', false, 2);
    mcText(ctx, v, rx + 52, ry + 30, '#f0f0f0', false, 2);
    ctx.globalAlpha = 1;
  }
  if (!bare && t > 1.4 && Math.floor(t * 1.6) % 2 === 0) { const s2 = 'PRESS START'; mcText(ctx, s2, Math.round(HW / 2 - mcWidth(s2, 2) / 2) - 60, 252, '#ffffff', true, 2); }
  // co-op: JOIN CO-OP under PRESS START (not in the video renders), and the line a guest comes home with
  if (!bare && coopTitle && t > 1.4) {
    const s3 = 'JOIN CO-OP', b = titleJoinBox();
    mcText(ctx, s3, b.x, b.y, titleSel === 1 ? '#ffff55' : '#a0a0a0', true);
    if (titleSel === 1) { mcText(ctx, '>', b.x - 10, b.y, '#ffff55', true); mcText(ctx, '<', b.x + b.w + 4, b.y, '#ffff55', true); }
  }
  if (!bare && NET.titleMsg && t > 0.8) {
    const w = mcWidth(NET.titleMsg) + 16, x = Math.round(HW / 2 - w / 2) - 60;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, 206, w, 15);
    mcText(ctx, NET.titleMsg, x + 8, 210, '#ffffff', true);
  }
  // the fan-project notice, kept left of Steve (he starts at x 274)
  ['Unofficial fan project. Free: no ads, no donations.', 'Not affiliated with Nintendo, Game Freak,', 'The Pokémon Company, Mojang or Microsoft.']
    .forEach((l, i) => mcText(ctx, l, 6, HH - 34 + i * 11, '#a07474', false));
}
function titleJoinBox() { const w = mcWidth('JOIN CO-OP'); return { x: Math.round(HW / 2 - w / 2) - 60, y: 274, w }; }
// the title's cursor: up and down pick PRESS START or JOIN CO-OP (a tap on JOIN CO-OP picks it too); true when
// the input was the title's own
function titleCoop() {
  if (input.just('up') || input.just('down')) { titleSel ^= 1; sfx.move(); return true; }
  const m = input.mouse, b = titleJoinBox();
  const tap = input.just('mouseL') && m.x >= b.x - 12 && m.x < b.x + b.w + 12 && m.y >= b.y - 4 && m.y < b.y + 12;
  if (tap || (titleSel === 1 && (input.just('a') || input.just('start')))) { titleSel = 1; sfx.select(); NET.titleMsg = null; NET.open('join', { code: params.get('join') || '' }); return true; }
  return false;
}
// ---------------------------------------------------------------- the title's world menus (stage 9; design 7.2 to 7.5)
// PRESS START opens FireRed's main menu (CONTINUE, NEW GAME, WORLDS) over the title art; NEW GAME is Create New World,
// WORLDS is Select World. A film (?video) keeps today's title: PRESS START plays. The menus' modules load on the first
// press (in Classic too: none of them is the generator's). NEW GAME and a world picked in Select World write their
// request to sessionStorage 'rs.world' and reload (7.1); CONTINUE plays the booted world with no reload, unless the
// player left it through TITLE or the hardcore Title Screen (titleLeft), when it reloads it from its save.
const MENUS_ON = !params.has('video');
let titleMenus = null, titleBusy = false, titleLeft = false;
let WMM = null, WLM = null, MDM = null;
function startFromTitle() { state = 'play'; sfx.select(); playMusicHere(true); showBanner(world.areaAt(P.tx, P.ty)); }
function classicSaved() { try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; } }
// the worlds Select World lists: the index's generated worlds, and Classic Kanto when its save exists (8.1)
function menuWorlds() {
  const d = WLM ? WLM.readList() : null;
  const out = d ? d.worlds.filter((w) => w && w.id && w.id !== 'classic').map((w) => ({ ...w })) : [];
  if (classicSaved()) out.push({ id: 'classic', type: 'classic', name: 'Classic Kanto', mode: 'survival', played: (d && d.classicPlayed) || 0 });
  return out;
}
// the booted world's id while it is listed (a fresh Classic or a never-saved test world is not)
function bootedId() {
  if (!world.layout.gen) return classicSaved() ? 'classic' : null;
  return world.wid && WLM && WLM.entryOf(world.wid) ? world.wid : null;
}
// CONTINUE's box: the booted world (none once an unlisted world was left through TITLE)
function contStats() {
  const id = bootedId();
  if (titleLeft && !id) return null;
  const gen = world.layout.gen, wd = world.wd || {};
  return { id: id ?? undefined, name: gen ? wd.name || 'New World' : 'Classic Kanto', type: gen ? wd.type || 'wild' : 'classic', mode: gen ? G.mode : 'survival', playTime: G.playTime };
}
// Select World's Delete: the save and the entry; the last played world moves to the newest one left
async function deleteListed(id) {
  if (id === 'classic') {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* none */ }
    try { localStorage.removeItem(SAVE_KEY + '-map'); } catch (e) { /* none */ }   // (Classic's minimap mask, its sibling key)
    const d = WLM.readList();
    if (d) { if (d.last === 'classic') d.last = null; delete d.classicPlayed; WLM.writeList(d); }
  } else await WLM.deleteWorld(id);
  const d = WLM.readList();
  if (d && !d.last) {
    const n = menuWorlds().sort((a, b) => (Number(b.played) || 0) - (Number(a.played) || 0))[0];
    if (n) { d.last = n.id; WLM.writeList(d); }
  }
}
async function openTitleMenus() {
  if (titleBusy || titleMenus) return;
  titleBusy = true;
  try {
    [WMM, WLM, MDM] = await Promise.all([import('./ui/worldmenu.js'), import('./worlds.js'), import('./modes.js')]);
    titleMenus = new WMM.WorldMenus({ cont: contStats, bootedId: bootedId(), worlds: menuWorlds, onDelete: deleteListed, maxWorlds: MDM.MAX_WORLDS,
      backdrop: () => drawTitle(true), types: genKinds() });
  } catch (e) { noteError(e); titleMenus = null; startFromTitle(); }
  titleBusy = false;
}
// reload into a world (null: the boot picks the last played one); the boot's own query (new, play, world...) is dropped
function leaveTo(req) {
  titleBusy = true;   // the title takes no input until the page goes
  try { if (req) sessionStorage.setItem('rs.world', JSON.stringify(req)); else sessionStorage.removeItem('rs.world'); } catch (e) { /* the last played world boots */ }
  G.leftTo = req || { op: 'reboot' };
  const q = new URLSearchParams(location.search);
  for (const k of ['new', 'play', 'world', 'wseed', 'mode', 'diff', 'join']) q.delete(k);
  const qs = q.toString().replace(/=(?=&|$)/g, '');
  location.replace(location.pathname + (qs ? '?' + qs : ''));
}
function updateTitleMenus(dt) {
  if (!titleMenus) return;
  titleMenus.update(dt, input);
  if (!titleMenus.done) return;
  const r = titleMenus.result || { op: 'back' }, booted = bootedId();
  titleMenus = null;
  if (r.op === 'continue') { if (titleLeft) leaveTo(booted ? { op: 'load', id: booted } : null); else startFromTitle(); }
  else if (r.op === 'load' && r.id === booted && !titleLeft) startFromTitle();
  else if (r.op === 'new' || r.op === 'load') leaveTo(WMM.bootRequest(r));
  else if (r.op === 'reboot') leaveTo(null);
  else titleT = Math.max(titleT, 1.4);   // back: PRESS START again
}
// the trainer card's SEED (7.4): the text the player typed, else the number, cut to fit beside its label
function cardSeed() {
  const wd = world.wd || {}, t = String(wd.seedText ?? '').trim(), v = t || String(wd.seed | 0), max = 150;
  if (textWidth(v) <= max) return v;
  let k = v.length; while (k > 0 && textWidth(v.slice(0, k) + '...') > max) k--;
  return v.slice(0, k) + '...';
}
function drawTransition() {
  HI();
  if (seq.opts && seq.opts.legend) { drawLegendTransition(); return; }
  const t = seq.t, snap = seq.snap;
  if (t < 0.62) {
    ctx.drawImage(snap, 0, 0);
    const ph = Math.floor(t / 0.1);
    if (ph % 2 === 0 && ph < 6) { ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(0, 0, HW, HH); }
    return;
  }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, HW, HH);
  const k = Math.min(1, (t - 0.62) / 0.55), e = k * k;
  for (let y = 0; y < HH; y += 8) {
    const dir = (y / 8) % 2 === 0 ? -1 : 1;
    const off = Math.round(dir * e * HW * (1 + ((y / 8) % 3) * 0.15));
    ctx.drawImage(snap, 0, y, HW, 8, off, y, HW, 8);
  }
}
function drawMsg() {
  GBA();
  if (!msg) return;
  const page = msg.pages[msg.page];
  const total = page.reduce((n, l) => n + l.length, 0);
  const done = msg.shown >= total;
  drawMessage(ctx, page, Math.floor(msg.shown), done && !(msg.ask && msg.page === msg.pages.length - 1), time);
  if (msg.ask && done && msg.page === msg.pages.length - 1) {
    drawWindow(ctx, VW - 64, VH - 48 - 44, 64, 44);
    drawText(ctx, 'YES', VW - 64 + 18, VH - 48 - 44 + 6, FG, SH);
    drawText(ctx, 'NO', VW - 64 + 18, VH - 48 - 44 + 22, FG, SH);
    cursorArrow(ctx, VW - 64 + 9, VH - 48 - 44 + 9 + (yesno ? yesno.cursor : 0) * 16);
  }
}
function draw() {
  drawGame();
  // video hooks: a caption/end-card painter and a fade to black
  if (G.overlay) { HI(); G.overlay(ctx, { mcText, mcWidth, A, HW, HH }); }
  if (G.videoFade > 0) { HI(); ctx.fillStyle = `rgba(0,0,0,${Math.min(1, G.videoFade)})`; ctx.fillRect(0, 0, HW, HH); }
}
function drawGame() {
  ctx.imageSmoothingEnabled = false;
  HI(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, HW, HH);
  if (state === 'title') { if (titleMenus) titleMenus.draw(ctx); else drawTitle(); return; }
  if (state === 'transition') { drawTransition(); return; }
  if (state === 'coop' && NET.ui && NET.ui.full()) { NET.ui.draw(ctx); return; }
  if (state === 'hof' && hof) { GBA(); hof.draw(ctx); HI(); hof.drawHi(ctx); return; }
  if (state === 'battle' || (state === 'battleOut' && G.battle)) {
    GBA(); G.battle.draw(ctx); HI(); G.battle.drawHi && G.battle.drawHi(ctx);
    if (state === 'battleOut') { ctx.fillStyle = `rgba(0,0,0,${Math.min(1, seq.t / 0.4)})`; ctx.fillRect(0, 0, HW, HH); }
    return;
  }
  if (state === 'party' && partyUI) { GBA(); partyUI.draw(ctx); return; }
  if (state === 'dex') { GBA(); drawDex(ctx, G.dex, dexOrder(), dexCursor); return; }
  if (state === 'dexEntry' && dexKey) { GBA(); drawDexEntry(ctx, dexKey, G.dex.caught.has(dexKey)); return; }
  if (state === 'summary' && summaryMon) { GBA(); drawSummary(ctx, summaryMon); return; }
  if (state === 'card') {
    GBA();
    const s = Math.floor(G.playTime);
    drawTrainerCard(ctx, { id: '24842', rows: [['NAME', G.myName || 'STEVE'], ['LEVEL', String(P.level)], ['POKéDEX', String(G.dex.caught.size)],
      ['MONEY', '¥' + G.money], ['DAY', String(G.day + 1)], ['MOBS DEFEATED', String(G.score)], ['TIME', `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`],
      ...(world.layout.gen && world.wd ? [['SEED', cardSeed()]] : [])], step: world.layout.gen && world.wd ? 13 : 15 });
    return;
  }
  drawWorld();
  // standing in a portal: the picture waves and the portal swirls over it, then fades after the trip
  const nausea = Math.max(G.portalT / 4, G.nausea);
  if (nausea > 0) NE.drawNausea(ctx, canvas, nausea);
  if (state === 'shop' && mart) { GBA(); mart.draw(ctx); return; }
  if (state === 'pc' && pcUI) { GBA(); pcUI.draw(ctx); return; }
  // map name popup, FireRed style
  GBA();
  if (banner.text && (state === 'play' || state === 'screen')) {
    const t = banner.t, slide = t < 0.25 ? -24 * (1 - t / 0.25) : t > 2.4 ? -24 * Math.min(1, (t - 2.4) / 0.25) : 0;
    if (t < 2.65) drawBanner(ctx, banner.text, 1, slide);
  }
  // the boss bar waits for the map's name to slide away (both sit at the top of the screen)
  G.bossBarAlpha = !banner.text ? 1 : Math.min(1, Math.max(0, (banner.t - 2.9) / 0.4));
  if (fade > 0) { HI(); ctx.fillStyle = `rgba(${fadeColor},${fade})`; ctx.fillRect(0, 0, HW, HH); }
  if (G.endFade > 0) { HI(); ctx.fillStyle = `rgba(0,0,0,${Math.min(1, G.endFade)})`; ctx.fillRect(0, 0, HW, HH); }
  if (state === 'genwait' && genWait) { HI(); ctx.fillStyle = `rgba(0,0,0,${Math.min(1, genWait.t / 0.15)})`; ctx.fillRect(0, 0, HW, HH); }
  HI();
  if (state !== 'dead') END.safe('bossbar', () => END.drawHUD(ctx));
  if (state !== 'msg' && state !== 'menu' && !(state === 'dead') && state !== 'coop' && state !== 'option') drawHUD(ctx, G, time);
  if (specOverlay && G.mr && G.mr.mode === 'spectator' && state === 'play') specOverlay.draw(ctx);
  if (MAP_ON) drawMinimap();
  if (state === 'menu') drawMenu();
  if (state === 'option' && optionUI) { GBA(); optionUI.draw(ctx); }
  if (state === 'msg') drawMsg();
  if (state === 'screen' && screen) { HI(); screen.draw(ctx); }
  if (state === 'dead') drawDead();
  // toasts sit below the boss bar while it is up
  const toastY = state !== 'dead' && END.safe('bossShown', () => world.inEnd(P.tx, P.ty) && DR.bossBarShown()) ? 24 : 0;
  HI(); toasts.slice(0, 3).forEach((t, i) => drawToast(ctx, t, toastY + i * 32));
  // co-op: chat, the waiting box, the CO-OP menus
  if (NET.s) NET.s.drawHud(ctx, state, toastY + Math.min(3, toasts.length) * 32);
  if (state === 'coop' && NET.ui) NET.ui.draw(ctx);
}

// ---------------------------------------------------------------- saving
const SAVE_KEY = 'poke-redstone-v1';
const serMon = (m) => ({ species: m.species, level: m.level, exp: m.exp, ivs: m.ivs, hp: m.hp, status: m.status, shiny: m.shiny, ball: m.ball, moves: m.moves.map((x) => ({ id: x.id, pp: x.pp })) });
const savedEnts = () => G.ents.filter((e) => (e.type === 'mob' && e.persistent && !e.dying) || e.type === 'boat' || e.type === 'item').map((e) =>
  e.type === 'mob' ? { type: 'mob', kind: e.kind, tx: e.tx, ty: e.ty, hp: e.hp, sheared: e.sheared } : e.type === 'boat' ? { type: 'boat', tx: e.tx, ty: e.ty, dir: e.dir } : { type: 'item', stack: e.stack, x: e.x, y: e.y });
// A generated world's entities, active and parked (8.3's compact arrays): mobs [kind, tx, ty, hp, flags (1 sheared)],
// items [id, n, x, y, the stack's other fields | 0, born (play seconds)], boats [tx, ty, dir]. An item past its despawn
// age is not written.
function savedEnts2() {
  const m = [], it = [], b = [], now = G.playTime;
  const one = (e) => {
    if (e.dead) return;
    if (e.type === 'mob' && e.persistent && !e.dying) { if (!(G.vil && G.vil.owns(e))) m.push([e.kind, e.tx, e.ty, e.hp, e.sheared ? 1 : 0]); }   // (7b: villagers are in `vil`)
    else if (e.type === 'boat') b.push([e.tx, e.ty, e.dir]);
    else if (e.type === 'item' && e.stack) {
      const age = (e.age || 0) + (e.parkT != null ? Math.max(0, now - e.parkT) : 0);
      if (age > 300) return;
      const { id, n, ...rest } = e.stack;
      it.push([id, n, Math.round(e.x), Math.round(e.y), Object.keys(rest).length ? rest : 0, Math.round((now - age) * 10) / 10]);
    }
  };
  for (const e of G.ents) one(e);
  if (world.parked) for (const l of world.parked.values()) for (const e of l) one(e);
  return { m, i: it, b };
}
// ...and back (parkNow after the load puts the far ones straight into world.parked)
function loadEnts2(d) {
  for (const r of Array.isArray(d.m) ? d.m : []) {
    try { if (!Array.isArray(r) || !A.items.mobs[r[0]] || !Number.isInteger(r[1]) || !Number.isInteger(r[2])) continue; const mb = E.spawnMob(r[0], r[1], r[2], { persistent: true }); if (Number.isFinite(r[3])) mb.hp = r[3]; mb.sheared = !!(r[4] & 1); } catch (e) { /* one bad entry */ }
  }
  for (const r of Array.isArray(d.b) ? d.b : []) if (Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1])) G.ents.push({ type: 'boat', tx: r[0], ty: r[1], fx: r[0], fy: r[1], dir: ['up', 'down', 'left', 'right'].includes(r[2]) ? r[2] : 'down' });
  for (const r of Array.isArray(d.i) ? d.i : []) {
    try {
      if (!Array.isArray(r) || !item(r[0]) || !(r[1] > 0) || !Number.isFinite(r[2]) || !Number.isFinite(r[3])) continue;
      const age = Number.isFinite(r[5]) ? G.playTime - r[5] : 0;
      if (age > 300) continue;   // despawned while the world was away
      const it = E.dropItem(r[0], r[1], r[2] - 8, r[3] - 8, r[4] && typeof r[4] === 'object' ? r[4] : {}, { delay: 0 });
      if (it) Object.assign(it, { vx: 0, vy: 0, vz: 0, z: 0, age: Math.max(0, age) });
    } catch (e) { /* one bad entry */ }
  }
}
function saveGame() {
  if (world.layout.gen) return saveGame2();   // a generated world: a promise (worlds.js, IndexedDB, v: 2)
  const ser = serMon;
  const keepEnts = savedEnts();
  const data = { v: 1, world: world.serialize(), inv: G.inv.serialize(), P: { tx: P.tx, ty: P.ty, dir: P.dir, health: P.health, food: P.food, sat: P.sat, level: P.level, xpProgress: P.xpProgress, xpTotal: P.xpTotal },
    time: G.time, day: G.day, spawnBed: G.spawnBed, lastCenter: G.lastCenter || null, money: G.money, layoutId: A.world.layoutId, score: G.score, party: G.party.map(ser), pc: G.pc.map(ser), seen: [...G.dex.seen], caught: [...G.dex.caught], ents: keepEnts, playTime: G.playTime,
    lastPortal: G.lastPortal || null, seeded: G.seeded || 0, adv: [...G.advancements], end: END.serialize() };
  // co-op: the friends who played in this world (only when there are any, so a single-player save is as before)
  if (G.coop && G.coop.players && Object.keys(G.coop.players).length) data.coop = G.coop;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); touchClassicList(); if (MAP_ON) mapSaveClassic(data.playTime); return true; } catch (e) {
    // too big for this browser's storage: once more without the friends seen longest ago
    if (data.coop) {
      try {
        const keys = Object.keys(G.coop.players).sort((a, b) => (G.coop.players[b].seen_at || 0) - (G.coop.players[a].seen_at || 0));
        const kept = {}; for (const k of keys.slice(0, Math.ceil(keys.length / 2))) kept[k] = G.coop.players[k];
        G.coop.players = kept; data.coop = G.coop;
        localStorage.setItem(SAVE_KEY, JSON.stringify(data)); touchClassicList(); return true;
      } catch (e2) { return false; }
    }
    return false;
  }
}
// The Classic world saved: it is the last played world, when a world list exists at all (8.1; only after a generated
// world was saved in this browser, so a Classic-only player's storage is exactly as before)
function touchClassicList() {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    // (stage 9: classicPlayed dates Classic Kanto in Select World, which sorts by last played)
    if (d && d.v === 1) { d.last = 'classic'; d.classicPlayed = Date.now(); localStorage.setItem(LIST_KEY, JSON.stringify(d)); }
  } catch (e) { /* the save itself stands */ }
}
// A generated world's save (8.3): the `v: 2` object, written by worlds.js (IndexedDB by structured clone, or the
// localStorage fallback). Resolves true once the write has landed, false if it failed. G.lastSave keeps its timing:
// the main-thread time to build the object and to hand it to IndexedDB (the structured clone happens in put).
function saveGame2() {
  const t0 = performance.now();
  let data, snap;
  try {
    snap = world.serialize2Begin();
    data = { v: 2, id: world.wid, gen: world.genVersion, wd: world.wd, world: null, inv: G.inv.serialize(),
      P: { tx: P.tx, ty: P.ty, dir: P.dir, health: P.health, food: P.food, sat: P.sat, level: P.level, xpProgress: P.xpProgress, xpTotal: P.xpTotal },
      time: G.time, day: G.day, spawnBed: G.spawnBed || null, lastCenter: G.lastCenter || null, money: G.money, layoutId: A.world.layoutId, score: G.score,
      party: G.party.map(serMon), pc: G.pc.map(serMon), seen: [...G.dex.seen], caught: [...G.dex.caught], ents: savedEnts2(), playTime: G.playTime,
      lastPortal: G.lastPortal || null, seeded: G.seeded || 0, adv: [...G.advancements], end: END.serialize() };
    if (G.vil) data.vil = G.vil.serialize();   // the villages' villagers, golems, empty beds and farm rows (7b)
    { const mp = MM ? MM.serialize(world) : null; if (mp) data.map = mp; else if (G.mapLoad && G.mapLoad.world === world && G.mapLoad.map) data.map = G.mapLoad.map; }   // the minimap's mask (never drops a loaded one)
    if (G.coop && G.coop.players && Object.keys(G.coop.players).length) data.coop = G.coop;
  } catch (e) { noteError(e); return Promise.resolve(false); }
  if (G.hc) data.hc = G.hc;                                   // a dead hardcore world (6.4)
  if (G.saveFail) return Promise.resolve(false);             // test hook: a save that fails (storage full)
  const msA = performance.now() - t0, WL = G.worlds, id = world.wid, wd = world.wd;
  // the encoding in the next task, so neither half is one long frame (the edits are as copied above; a block's own
  // state, a furnace's for one, is read in the second half)
  return new Promise((r) => setTimeout(r, 0)).then(() => {
    const t1 = performance.now();
    try { data.world = world.serialize2End(snap); } catch (e) { noteError(e); return { ok: false, ms: 0, err: String(e) }; }
    const msB = performance.now() - t1;
    return WL.saveWorld(id, data).then((r) => ({ ...r, msB }));
  }).then((r) => {
    G.lastSave = { ok: r.ok, store: r.store, buildMs: msA, encodeMs: r.msB || 0, putMs: r.ms, ms: msA + (r.msB || 0) + r.ms, frameMs: Math.max(msA, (r.msB || 0) + r.ms),
      edits: world.edits.size, blocks: world.blocks.size + world.bover.size, err: r.err || null, bytes: r.bytes || null };
    if (!r.ok) return false;
    const fields = { name: wd.name, type: wd.type, seed: wd.seed, seedText: wd.seedText, mode: wd.mode, diff: wd.diff, gen: world.genVersion, created: wd.created, played: Date.now(), playTime: Math.max(0, G.playTime || 0) };   // (playfix: never negative)
    if (r.bytes) fields.bytes = r.bytes;
    WL.touchEntry(id, fields);
    // the size shown in the world list: measured as JSON when the browser is idle, not inside the save's frames
    if (!r.bytes) {
      const later = typeof requestIdleCallback === 'function' ? (f) => requestIdleCallback(f, { timeout: 2000 }) : (f) => setTimeout(f, 50);
      later(() => { try { const t2 = performance.now(), n = JSON.stringify({ ...data, world: { ...data.world, b: null } }).length + data.world.b.length - 4; G.lastSave.bytes = n; G.lastSave.sizeMs = performance.now() - t2; WL.touchEntry(id, { bytes: n }); } catch (e) { /* only the size */ } });
    }
    return true;
  }, (e) => { noteError(e); return false; });
}
function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (d.v !== 1) return false;
    return applySave(d);
  } catch (e) { console.warn('load failed', e); return false; }
}
// A save's state into the game: Classic's `v: 1` (loadGame) or a generated world's `v: 2` (8.3, the overrides only).
function applySave(d) {
  try {
    if (d.coop && typeof d.coop === 'object' && d.coop.players && typeof d.coop.players === 'object') G.coop = d.coop;
    if (d.v === 2) world.restore2(d.world); else world.restore(d.world);
    G.inv.restore(d.inv);
    Object.assign(P, PL.makePlayer(d.P.tx, d.P.ty), { dir: d.P.dir, health: d.P.health, food: d.P.food, sat: d.P.sat, level: d.P.level, xpProgress: d.P.xpProgress, xpTotal: d.P.xpTotal });
    G.time = d.time; G.day = d.day; G.spawnBed = d.spawnBed; G.score = d.score || 0; G.playTime = d.playTime || 0;
    G.lastCenter = d.lastCenter || null;
    G.mapLoad = { world, v: d.v, map: d.map || null, pt: d.playTime || 0 };   // the minimap's explored land (src/minimap.js reads it when it binds)
    G.money = Number.isFinite(d.money) ? d.money : 3000;
    // the Nether: where Steve came through, what he has achieved, and the blocks a save from before it lacks
    G.lastPortal = d.lastPortal || null;
    if (Array.isArray(d.adv)) G.advancements = new Set(d.adv);
    // a save from a different room layout: rooms may have moved, so Steve goes back outdoors
    if (d.layoutId && d.layoutId !== A.world.layoutId && !world.isOutdoor(P.tx, P.ty)) { PL.placePlayer(P, G.worldSpawn.x, G.worldSpawn.y, 'down'); G.lastCenter = null; }
    // saved standing in a portal: he does not go through it the moment the game starts
    if (world.isPortal(P.tx, P.ty)) G.portalCool = true;
    G.party = (d.party || []).map(reviveMon).filter(Boolean); G.pc = (d.pc || []).map(reviveMon).filter(Boolean);
    G.dex = { seen: new Set(d.seen), caught: new Set(d.caught) };
    G.ents = [];
    if (d.v === 2 && G.vil) { try { G.vil.restore(d.vil); } catch (e) { noteError(e); } }   // (7b)
    if (d.v === 2 && d.ents && !Array.isArray(d.ents)) loadEnts2(d.ents);   // a generated world's compact entities (5c)
    else for (const e of d.ents || []) {
      // a creature or item this game does not know is left out (as the inventory does), and one bad entry
      // never stops the rest of the save from loading
      try {
        if (!e || typeof e !== 'object') continue;
        if (e.type === 'mob') {
          if (!A.items.mobs[e.kind]) continue;
          const m = E.spawnMob(e.kind, e.tx, e.ty, { persistent: true }); m.hp = e.hp; m.sheared = e.sheared;
        } else if (e.type === 'boat') G.ents.push({ type: 'boat', tx: e.tx, ty: e.ty, fx: e.tx, fy: e.ty, dir: e.dir });
        else {
          if (!e.stack || !item(e.stack.id)) continue;
          // a saved stack lies exactly where it was: no fresh drop's hop and drift (which could carry it off its
          // cell and into a lava pool beside it)
          const it = E.dropItem(e.stack.id, e.stack.n, e.x - 8, e.y - 8, {}, { delay: 0 });
          if (it) Object.assign(it, { vx: 0, vy: 0, vz: 0, z: 0 });
        }
      } catch (err) { console.warn('skipped a saved entity', e, err); }
    }
    // The blocks a save from before the Nether lacks go in only now, once its mobs and dropped items are back,
    // so seedPlaced() can leave the cells they occupy alone (no item burns, no cow stands in a new pool).
    if (!(d.seeded >= 2)) NE.seedPlaced(); else if (d.seeded < 3) NE.seedPlaced(null, true); else G.seeded = d.seeded;
    // the stronghold's blocks (a save from before it lacks them), The End's state, Route 23's entrance cell
    if (!(d.seeded >= 4)) END.seedStronghold();
    END.restore(d.end);
    END.fixEntrance();
    if (world.isEndPortal(P.tx, P.ty)) G.endCool = true;
    // an old save may stand him where a cave pool now is: never left in lava or shut in by it (lava is solid,
    // and he could not step out). He is put on the nearest open cell and the pool is completed.
    const boxed = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => world.isLava(x + dx, y + dy) || world.solid(x + dx, y + dy)) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => world.isLava(x + dx, y + dy));
    if (world.isLava(P.tx, P.ty) || boxed(P.tx, P.ty)) {
      const c = nearestWalk(P.tx, P.ty), m = world.mapAt(P.tx, P.ty);
      if (c) { PL.placePlayer(P, c.x, c.y, P.dir); if (m) NE.seedPlaced(m.id); }
    }
    if (world.isPortal(P.tx, P.ty)) G.portalCool = true;
    return true;
  } catch (e) { console.warn('load failed', e); return false; }
}
// A loaded generated world's entities stand on chunks that may not exist yet: they are made first (behind the loading
// screen), so nothing walks or falls on cells that are not there. (Stage 5c's parking replaces this.)
async function ensureEntChunks() {
  const seen = new Set(), ps = [];
  for (const e of G.ents) {
    const x = Number.isFinite(e.tx) ? e.tx : Math.floor(e.x / TILE), y = Number.isFinite(e.ty) ? e.ty : Math.floor(e.y / TILE);
    if (!Number.isInteger(x) || !Number.isInteger(y) || world.ready(x, y)) continue;
    const k = world.chunkKey(x, y);
    if (seen.has(k)) continue;
    seen.add(k);
    const r = world.ensureAround(x, y, 0);
    if (r !== true) ps.push(r);
  }
  if (ps.length) { loadingScreen('Preparing spawn area', null); await Promise.all(ps); }
}
function newWorld() {
  RNG.seed(params.has('seed') ? Number(params.get('seed')) : 20260930);
  let s = 1234567;
  const rng = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  // (a generated world's animals come with its chunks, stage 5c; a Kanto World keeps Kanto's routes' own, 3.12)
  if (!world.layout.gen || world.layout.kind === 'kanto') E.seedAnimals(rng);
  NE.seedPlaced();
  END.seedStronghold();
}

// ---------------------------------------------------------------- co-op (src/net/)
// What the co-op modules need from in here. None of it runs in single-player: these are called only while a room
// is open (or while a guest boots into a friend's world).
const PER_PLAYER_END = ['eyeMsg', 'eyeShort', 'eggHint', 'hofSeen'];
// host: the world a joining friend loads (the save's world part; the guest's own character comes from G.coop)
// (a generated world, 9.1: the save's overrides only and the descriptor; the probe is added by the session)
function coopSnapshot() {
  if (world.layout.gen) return { world: world.serialize2(), wd: coopWd(), seeded: G.seeded || 0, layoutId: A.world.layoutId, time: G.time, day: G.day, timeScale: G.timeScale, end: END.serialize(), worldSpawn: G.worldSpawn,
    vfarms: G.vil && G.vil.farmsOut ? G.vil.farmsOut() : null };   // (stage 10: the farm rows the villages' farmers replanted)
  return { world: world.serialize(), seeded: G.seeded || 0, layoutId: A.world.layoutId, time: G.time, day: G.day, timeScale: G.timeScale, end: END.serialize(), worldSpawn: G.worldSpawn };
}
// host: a generated world's descriptor (9.1), or null in Classic (no `wd` message then)
function coopWd() {
  if (!world.layout.gen) return null;
  const wd = world.wd || {};
  return { type: wd.type || 'wild', seed: world.seed | 0, seedText: String(wd.seedText ?? world.seed), gen: world.genVersion, mode: wd.mode || 'survival', diff: wd.diff || 'normal',
    name: String(wd.name || 'New World').slice(0, 32), terrainHash: String((NET.room && NET.room.build) || '').split('.').pop(), wild: G.wildOpt !== false };
}
// The probe (9.1): a hash of the plan (its canonical JSON's hash), the spawn's chunk and the chunk of the village
// nearest the spawn, as this page generated them. The host's goes in the snapshot; a guest computes its own after
// building the world from the descriptor and leaves on a mismatch. The first cave's B1F room joined it at stage 5b;
// a Kanto seam chunk joins at 6a. `sessionStorage['rs.probeTest']` salts it: the tests' forced mismatch.
let probeP = null, probeOf = null;
function coopProbe() {
  if (!world.layout.gen) return Promise.resolve(null);
  if (probeP && probeOf === world) return probeP;
  probeOf = world;
  const w = world;
  probeP = (async () => {
    const plan = w.gen.plan, L = w.layout, sp = { x: plan.spawn.px, y: plan.spawn.py };
    let best = null, bd = Infinity;
    for (const v of plan.villages || []) {
      const vx = L.ox + v.x0 + (v.w >> 1), vy = L.oy + v.y0 + (v.h >> 1), d = Math.abs(vx - sp.x) + Math.abs(vy - sp.y);
      if (d < bd) { bd = d; best = { x: vx, y: vy }; }
    }
    const pts = best ? [sp, best] : [sp];
    // (a Kanto World, 6a: and a Kanto seam chunk, the first not ready from the start along Kanto's box's top row)
    if (L.kind === 'kanto' && L.kanto) {
      for (let x = L.kanto.x; x < L.kanto.x + w.outdoor.w; x += 32) if (w.cstate[w.chunkKey(x, L.kanto.y)] !== 2) { pts.push({ x, y: L.kanto.y }); break; }
    }
    await Promise.all(pts.map((p) => w.ensureAround(p.x, p.y, 0)));
    let salt = '';
    try { salt = sessionStorage.getItem('rs.probeTest') || ''; } catch (e) { /* no storage */ }
    // (and the first cave's B1F room as this page dug it, 5b)
    const cave0 = plan.caves && plan.caves.length ? w.roomHash(`GEN_CAVE_${plan.caves[0].id}_B1F`) : null;
    const text = [String(w.gen.hash), ...pts.map((p) => w.chunkHash(w.chunkKey(p.x, p.y))), cave0].join('|') + salt;
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  })();
  return probeP;
}
// guest: the host's generated world, built from its descriptor (9.1) while the snapshot downloads. The Classic
// placeholder this page booted is never played; this World replaces it, with the spawn, the water tile and the
// banner tracker that follow the world. The world list is never read or written (7.1, 8.1). Once per page.
let useP = null;
function useWorld(wd) {
  if (useP) return useP;
  useP = (async () => {
    if (!wd || typeof wd !== 'object' || !(wd.type === 'wild' || (wd.type === 'kanto' && KANTO_WORLDS)) || !Number.isInteger(wd.seed)) throw new Error('bad world descriptor');
    const { GEN_VERSION } = await import('./gen/version.js');
    if (Number.isFinite(wd.gen) && wd.gen > GEN_VERSION) throw new Error('a newer generator');
    const [w] = await Promise.all([makeGenWorld(wd.type, wd.seed | 0), loadModeModules()]);   // (stage 10: the mode modules too)
    w.wid = null;
    w.wd = { type: wd.type, seed: wd.seed | 0, seedText: String(wd.seedText ?? wd.seed).slice(0, 32), name: String(wd.name || 'New World').slice(0, 32), mode: String(wd.mode || 'survival'), diff: String(wd.diff || 'normal'), created: 0, wild: wd.wild !== false };
    w.genVersion = Number.isFinite(wd.gen) ? wd.gen : GEN_VERSION;
    G.GEN_VERSION = GEN_VERSION;
    world = w; G.world = w;
    G.worldSpawn = { x: w.gen.plan.spawn.px, y: w.gen.plan.spawn.py };
    G.waterTile = A.terrain.waterTile;
    mapById = null; place = null; placeCand = null; placeSteps = 0; lastKey = null; lastMapId = null; lastMapsec = null;
    Object.assign(P, PL.makePlayer(G.worldSpawn.x, G.worldSpawn.y));
    G.ents = [];
    // (the spawn area starts streaming now; a returning character's own cells are made in coopApply)
    w.ensureAround(G.worldSpawn.x, G.worldSpawn.y, 1);
    return w;
  })();
  return useP;
}
// guest: this character, kept in the host's save under its name
function coopRecord() {
  return { P: { tx: P.tx, ty: P.ty, dir: P.dir, health: P.health, food: P.food, sat: P.sat, level: P.level, xpProgress: P.xpProgress, xpTotal: P.xpTotal,
    ...(P.dead ? { dead: 1, deathMsg: typeof P.deathMsg === 'string' ? P.deathMsg.slice(0, 120) : null } : {}) },
    inv: G.inv.serialize(), party: G.party.map(serMon), pc: G.pc.map(serMon), seen: [...G.dex.seen], caught: [...G.dex.caught], money: G.money,
    spawnBed: G.spawnBed || null, lastCenter: G.lastCenter || null, lastPortal: G.lastPortal || null, adv: [...G.advancements], score: G.score, playTime: G.playTime,
    end: Object.fromEntries(PER_PLAYER_END.map((k) => [k, !!(G.end && G.end[k])])) };
}
// guest: the host's world arrives (the co-op boot made no world of its own); the character is the one the host
// remembers by this name, or a fresh one at the world spawn with nothing, like joining a Minecraft server
function coopApply(d, rec, progress) {
  if (d.wd) return coopApplyGen(d, rec, progress);
  world.restore(d.world);
  coopPlace(d, rec);
}
// A generated world (9.1): the world built from the descriptor (useWorld), the save path's world part (overrides
// only), then the chunks around where this character will stand ("Preparing spawn area"), then the character.
async function coopApplyGen(d, rec, progress) {
  if (!world.layout.gen) throw new Error('the generated world is not built');
  world.restore2(d.world);
  const sp = d.worldSpawn && Number.isInteger(d.worldSpawn.x) ? d.worldSpawn : G.worldSpawn;
  const at = rec && rec.P && Number.isInteger(rec.P.tx) && Number.isInteger(rec.P.ty) && world.inside(rec.P.tx, rec.P.ty) ? { x: rec.P.tx, y: rec.P.ty } : sp;
  const pts = at === sp ? [at] : [at, sp];
  const ps = pts.map((p) => world.ensureAround(p.x, p.y, 1)).filter((r) => r !== true);
  if (ps.length) {
    if (progress) world.stream.onProgress = progress;
    try { await Promise.all(ps); } finally { world.stream.onProgress = null; }
  }
  coopPlace(d, rec);
  // stage 10: the farm rows the host's farmers replanted, and the host's mode (a spectator's after a hardcore death)
  if (d.vfarms && G.vil && G.vil.farmsIn) { try { G.vil.farmsIn(d.vfarms); } catch (e) { noteError(e); } }
  coopModes(d.wd, d.hcDead);
  lastKey = world.regionKey(P.tx, P.ty); place = placeAt(P.tx, P.ty);
  for (let cy = (P.ty - 8) >> 4; cy <= (P.ty + 8) >> 4; cy++) for (let cx = (P.tx - 10) >> 4; cx <= (P.tx + 10) >> 4; cx++) if (world.ready(cx * 16, cy * 16)) world.chunk(cx, cy);
}
// the snapshot's shared state and this character, once the world is in (Classic and generated alike)
function coopPlace(d, rec) {
  G.seeded = d.seeded || 0;
  END.restore(d.end);
  G.time = Number.isFinite(d.time) ? d.time : G.time; G.day = Number.isInteger(d.day) ? d.day : G.day;
  if (d.timeScale > 0) G.timeScale = d.timeScale;
  if (d.worldSpawn && Number.isInteger(d.worldSpawn.x)) G.worldSpawn = { x: d.worldSpawn.x, y: d.worldSpawn.y };
  G.ents = [];
  const sp = G.worldSpawn;
  if (rec && rec.P && Number.isInteger(rec.P.tx) && world.inside(rec.P.tx, rec.P.ty)) {
    try { G.inv.restore(rec.inv); } catch (e) { G.inv = new Inventory(); }
    const q = rec.P, num = (v, d0) => (Number.isFinite(v) ? v : d0);
    Object.assign(P, PL.makePlayer(q.tx, q.ty), { dir: DIR_LIST.includes(q.dir) ? q.dir : 'down', health: num(q.health, 20), food: num(q.food, 20), sat: num(q.sat, 5), level: num(q.level, 0), xpProgress: num(q.xpProgress, 0), xpTotal: num(q.xpTotal, 0) });
    // a character that died and left before respawning comes back on its death screen (its things already lie
    // where it fell; anything the record still carries falls there when it arrives, in updatePlay)
    if (q.dead) { P.health = 0; P.dead = true; P.deathT = 0; P.deathMsg = typeof q.deathMsg === 'string' ? q.deathMsg : null; }
    else if (P.health <= 0) P.health = 20;
    G.party = (rec.party || []).map(reviveMon).filter(Boolean); G.pc = (rec.pc || []).map(reviveMon).filter(Boolean);
    G.dex = { seen: new Set(rec.seen || []), caught: new Set(rec.caught || []) };
    G.money = Number.isFinite(rec.money) ? rec.money : 3000;
    G.spawnBed = Array.isArray(rec.spawnBed) ? rec.spawnBed : null; G.lastCenter = rec.lastCenter || null; G.lastPortal = rec.lastPortal || null;
    G.advancements = new Set(Array.isArray(rec.adv) ? rec.adv : []); G.score = rec.score || 0; G.playTime = rec.playTime || 0;
    if (rec.end) for (const k of PER_PLAYER_END) G.end[k] = !!rec.end[k];
  } else Object.assign(P, PL.makePlayer(sp.x, sp.y));
  P.name = G.myName || P.name;
  // never left in lava or a wall (the host may have built where this character last stood)
  if (world.isLava(P.tx, P.ty) || PL.canEnter({ riding: null }, P.tx, P.ty) === null) { const c = nearestWalk(P.tx, P.ty); PL.placePlayer(P, c ? c.x : sp.x, c ? c.y : sp.y, P.dir); }
  P.swimming = world.isWater(P.tx, P.ty);
  if (world.isPortal(P.tx, P.ty)) G.portalCool = true;
  if (world.isEndPortal(P.tx, P.ty)) G.endCool = true;
  lastArea = world.areaAt(P.tx, P.ty);
  { const m = world.mapAt(P.tx, P.ty); syncNPCs(m); lastMapId = m ? m.id : null; lastMapsec = m ? m.mapsec : null; }
  follower.visible = !!followerMon() && !P.swimming;
  if (follower.visible) placeFollowerNear(P.tx, P.ty);
  state = 'play';
  updateCamera();
  showBanner(lastArea);
  playMusicHere(true);
}
// what this player is doing, for the others (0 free, 1 a menu or message, 2 a battle, 3 a warp, 4 the legend battle)
function coopBusy() {
  if (state === 'play' || state === 'dead' || state === 'sleep' || state === 'screen') return 0;
  if (state === 'transition' || state === 'battle' || state === 'battleOut') { const o = (G.battle && G.battle.opts) || (seq && seq.opts) || {}; return o.legend ? 4 : 2; }
  if (state === 'warp') return 3;
  return 1;
}
function coopBridge() {
  return { state: () => state, setState: (s) => { state = s; }, say, ask, toast: (t) => G.toast(t), busyCode: coopBusy,
    holdInput: () => { input.down.clear(); input.pressed.clear(); }, coopSnapshot, coopRecord, coopApply,
    coopWd, coopProbe, useWorld,                                  // generated worlds (the world update, 9.1)
    coopModes: (wd) => coopModes(wd, null), autosave: (why) => autosave(why),   // stage 10: a later descriptor; a hardcore host's saves
    // stage 4: the shared world
    update: (dt) => update(dt),                                   // the host's frame while its tab is hidden (no drawing)
    live: () => state === 'play' || state === 'screen' || state === 'dead' || state === 'sleep',
    screen: () => screen, closeScreen: () => { if (screen) { screen.close(); screen = null; if (state === 'screen') state = 'play'; } },
    encounter: (enc, kind, src) => { if (state !== 'play' || P.dead || P.sleeping || G.wildGrace > 0 || (G.mr && !G.mr.battles)) return false;   // (stage 10: never a spectator's)
      enc.level = wildLevel(enc.level, P.tx, P.ty); startEncounter(enc, kind, src); return true; },
    beginLegend: () => beginLegend(true), coopWake, sleeping: () => state === 'sleep' && !!seq && !seq.woke && !!P.sleeping,
    skyDark: () => skyLevel() < 8, explodeFx: (x, y, p) => G.explodeFx(x, y, p), arriveArea: () => arriveArea(false),
  };
}

// ---------------------------------------------------------------- boot
NET.bridge = coopBridge();
// co-op: JOIN reloaded the page into a friend's world (no single-player load, no new world: the host's arrives)
if (NET.boot) { state = 'coop'; NET.open('boot', NET.boot); }
else if (world.layout.gen) { const bootHc = world.bootSave && world.bootSave.hc; if (world.bootSave && applySave(world.bootSave)) { parkNow(); await ensureEntChunks(); } else newWorld(); world.bootSave = null; popStart(); initModes(bootHc); }
else if (params.has('new') || !loadGame()) newWorld();
// stage 9: a world made by Create New World is saved at once, so it is listed and CONTINUE works even if the player
// never saves (7.4); Select World's Classic Kanto becomes the last played world
if (!NET.boot && world.layout.gen && BOOT.fromMenu) { try { Promise.resolve(saveGame()).catch(noteError); } catch (e) { noteError(e); } }
if (!NET.boot && BOOT.classicReq) touchClassicList();
lastArea = world.areaAt(P.tx, P.ty);
{ const m = world.mapAt(P.tx, P.ty); syncNPCs(m); lastMapId = m ? m.id : null; lastMapsec = m ? m.mapsec : null; }
if (world.layout.gen) { lastKey = world.regionKey(P.tx, P.ty); place = placeAt(P.tx, P.ty); }
if (state === 'play') { showBanner(lastArea); }
if (NET.titleMsg && state === 'play') say(NET.titleMsg);
if (params.has('join') && !NET.boot && state === 'title') NET.open('join', { code: params.get('join') || '' });
preloadMc(['dig.stone', 'dig.wood', 'dig.grass', 'step.grass', 'step.stone', 'pop', 'hurt', 'attack.weak', 'attack.strong', 'eat', 'burp', 'orb']);
const firstMusic = () => { if (state !== 'title') playMusicHere(true); else music.play('title'); };
window.addEventListener('keydown', firstMusic, { once: true });
window.addEventListener('pointerdown', firstMusic, { once: true });

let last = performance.now();
let paused = false;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // schedule the next frame first, and catch what one frame throws: an error must never stop the game loop (it is
  // logged once per message, and kept in G.errors where the tests look)
  requestAnimationFrame(frame);
  if (!paused) {
    const t0 = G.perf ? performance.now() : 0;
    try { update(dt); draw(); if (G.perf) perfFrame(t0, now); } catch (e) {
      const m = String((e && e.stack) || e);
      G.errors = G.errors || [];
      if (!G.errors.includes(m)) { if (G.errors.length < 30) G.errors.push(m); console.error(e); }
    } finally { input.endFrame(); }
  }
}
requestAnimationFrame(frame);
// The perf test's frame log (tools/gen_tests/perf.mjs; null unless the hook turns it on): per real frame, its
// interval, the main-thread work of update and draw, and how much of that was generation (applying chunks, the
// prefetch and drawing new chunks' canvases).
let perfLast = null;
function perfFrame(t0, at) {
  const gs = world.genStats, gen = (world.stream ? world.stream.ms : 0) + (gs ? gs.buildMs : 0);
  const work = performance.now() - t0;
  G.perf.push([at - (perfLast ? perfLast.at : at), work, perfLast ? gen - perfLast.gen : 0]);
  perfLast = { at, gen };
  if (G.perf.length > 20000) G.perf.shift();
}

// ---------------------------------------------------------------- headless hooks (tests and the video)
const isDir = (k) => DIR_LIST.includes(k);
function stepFrames(n, dt, keys = {}) {
  for (let i = 0; i < n; i++) {
    if (keys.press) for (const k of [].concat(keys.press)) { if (i === 0) input.press(k); }
    if (keys.hold) for (const k of [].concat(keys.hold)) { input.down.add(k); if (isDir(k)) input.lastDir = k; }
    update(dt); draw(); input.endFrame();
    if (keys.press && i === 0) for (const k of [].concat(keys.press)) if (!(keys.hold && [].concat(keys.hold).includes(k))) input.release(k);
  }
  if (keys.hold) for (const k of [].concat(keys.hold)) input.down.delete(k);
  input.endFrame();
}
window.__rs = {
  G, P, get world() { return world; }, A, E, PL, input,   // (a getter: a co-op guest's world can be replaced, 9.1)
  state: () => state, setState: (s) => { state = s; }, msg: () => msg, battle: () => G.battle, screen: () => screen, seq: () => seq,
  pause: (v = true) => { paused = v; },
  seed: (n) => RNG.seed(n),
  step: (n = 1, dt = 1 / 60) => stepFrames(n, dt),
  press: (k, frames = 1) => stepFrames(frames, 1 / 60, { press: k }),
  hold: (k, n = 1) => stepFrames(n, 1 / 60, { hold: k, press: k }),
  tick: ({ hold, press, dt = 1 / 30, capture = true, mouse } = {}) => {
    if (mouse) { input.mouse.x = mouse.x; input.mouse.y = mouse.y; input.mouse.inside = true; if (mouse.click) input.press(mouse.click); }
    if (press) for (const k of [].concat(press)) input.press(k);
    if (hold) for (const k of [].concat(hold)) { input.down.add(k); if (isDir(k)) input.lastDir = k; }
    update(dt); draw(); input.endFrame();
    if (press) for (const k of [].concat(press)) if (!(hold && [].concat(hold).includes(k))) input.release(k);
    if (hold) for (const k of [].concat(hold)) input.down.delete(k);
    if (mouse && mouse.click) input.release(mouse.click);
    input.endFrame();
    return capture ? canvas.toDataURL('image/png') : null;
  },
  frame: () => canvas.toDataURL('image/png'),
  pending: () => 0,
  teleport: (x, y, dir = 'down') => { world.ensureAround(x, y, 1); PL.placePlayer(P, x, y, dir); P.riding = null; P.swimming = world.isWater(x, y); if (state === 'play') arriveArea(false); else { const m = world.mapAt(x, y); syncNPCs(m); lastMapId = m ? m.id : null; lastArea = m ? m.name : null; } follower.visible = !!followerMon() && !P.swimming; if (follower.visible) placeFollowerNear(x, y); updateCamera(); },
  warp: (i) => startWarp(world.warps[i]),
  npcs: () => npcs,
  mart: () => mart,
  pc: () => pcUI,
  money: (n) => (n == null ? G.money : (G.money = n)),
  give: (id, n = 1, slot) => { if (slot != null) G.inv.slots[slot] = { id, n }; else G.inv.add(id, n); },
  clearInv: () => { G.inv.slots.fill(null); G.inv.armor.fill(null); },
  setTime: (t) => { G.time = t; },
  spawn: (kind, x, y) => E.spawnMob(kind, x, y),
  nextEncounter: (sp, level, shiny = false) => { forcedEncounter = { species: sp, level, shiny }; },
  encounter: (sp, level, kind = 'land', opts = {}) => startEncounter({ species: sp, level }, kind, null, opts),
  rules: G.rules,
  openScreen: (k, t) => G.openScreen(k, t),
  save: () => (NET.guest ? false : saveGame()), clearSave: () => { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} },
  playMusic: (n) => music.play(n),
  startGame: () => { if (state === 'play') return; state = 'play'; showBanner(world.areaAt(P.tx, P.ty)); playMusicHere(true); },
  camera: () => ({ ...cam }),
  follower,
  toasts,
  music,
  mc,
  setFade: (a) => { G.videoFade = a; },
  setMusicMuted,
  addMon: (sp, lv) => { const m = makeMon(sp, lv); G.party.push(m); G.dex.seen.add(sp); G.dex.caught.add(sp); placeFollowerNear(P.tx, P.ty); follower.visible = true; return m; },
  setOverlay: (fn) => { G.overlay = fn; },
  // the Nether: an obsidian ring around a w x h interior whose top-left cell is (x, y) (corners left out,
  // as Minecraft allows), lighting it, and going through without the four-second wait
  buildPortal: (x, y, w = 2, h = 3, corners = false) => {
    const ring = [];
    for (let yy = y - 1; yy <= y + h; yy++) for (let xx = x - 1; xx <= x + w; xx++) {
      const edgeX = xx === x - 1 || xx === x + w, edgeY = yy === y - 1 || yy === y + h;
      if (!edgeX && !edgeY) { world.setBlock(xx, yy, null); continue; }
      if (edgeX && edgeY && !corners) continue;
      world.setBlock(xx, yy, { id: 'obsidian' }); ring.push([xx, yy]);
    }
    return ring;
  },
  lightPortal: (x, y, dir) => NE.lightPortal(x, y, dir),
  enterNether: () => travel(true),
  leaveNether: () => travel(false),
  portal: () => ({ t: G.portalT, nausea: G.nausea, cool: G.portalCool, last: G.lastPortal }),
  NE, ambience, spawnWild: spawnWildAt, trySpawnWild: trySpawn,
  resetWorld: () => { location.reload(); },
  // The End and the stronghold (spec section 11)
  END, DR, hof: () => hof,
  enterStronghold: () => { const a = world.stronghold.arrival; window.__rs.teleport(a.x, a.y, a.dir || 'down'); },
  enterEnd: () => enterEnd(),
  leaveEnd: () => exitEnd(),
  fillFrames: (n = 12) => END.fillFrames(n),
  revealEntrance: () => END.revealEntrance(),
  get dragon() { return DR.state(); },
  setDragonHP: (hp) => { G.end.dragon.hp = hp; if (hp > DR.EXHAUST_HP) G.end.dragon.exhausted = false; return DR.state(); },
  exhaustDragon: () => { G.end.dragon.alive = true; G.end.dragon.hp = Math.min(G.end.dragon.hp, DR.EXHAUST_HP); G.end.dragon.exhausted = true; DR.reset(); if (world.inEnd(P.tx, P.ty)) DR.ensure(); return DR.state(); },
  killCrystals: (n = 10) => { let k = 0; for (const c of G.end.crystals) if (c.alive && k < n) { c.alive = false; k++; } return k; },
  giveEndKit: () => {
    G.inv.slots.fill(null);
    const kit = [['diamond_sword', 1], ['bow', 1], ['diamond_pickaxe', 1], ['cobblestone', 64], ['ender_pearl', 16], ['eye_of_ender', 12], ['ultra_ball', 30], ['torch', 32], ['cooked_beef', 32],
      ['arrow', 64], ['arrow', 64], ['poke_ball', 10], ['end_crystal', 4], ['water_bucket', 1], ['obsidian', 16], ['great_ball', 10]];
    kit.forEach(([id, n], i) => { if (item(id)) G.inv.slots[i] = { id, n }; });
    G.inv.armor = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'].map((id) => (item(id) ? { id, n: 1 } : null));
    P.health = 20; P.food = 20; P.sat = 5;
  },
  endState: () => G.end,
  // generated worlds (stage 4a): the plan, the streaming and the client; ensure(x, y) awaits the chunks around a cell
  // (a getter: a co-op guest's generated world replaces its Classic placeholder after the boot, 9.1)
  // ready(): the plane data chunks made here; chunkHashes(): each made overworld chunk's generated output
  get gen() {
    return world.layout.gen ? { plan: () => world.gen.plan, hash: () => world.gen.hash, seed: () => world.seed, stream: world.stream, client: world.gen,
      bootMs: () => world.bootMs, planMs: () => world.gen.planMs, planWallMs: () => world.planWallMs, place: () => place, step: () => stepPlace(),
      ready: () => { const out = []; for (let k = 0; k < world.cstate.length; k++) if (world.cstate[k] === 2) out.push(k); return out; },
      chunkHashes: () => { const out = {}; for (let k = 0; k < world.cstate.length; k++) { const hh = world.chunkHash(k); if (hh) out[k] = hh; } return out; },
      probe: () => coopProbe(),
      pop: () => { let n = 0; for (const v of world.pop) for (let b = v; b; b &= b - 1) n++; return n; }, popOn: () => !!world.popOn,
      parked: () => world.stream.parkedCount(), parkedMap: () => world.parked, park: () => parkNow(), ticking: () => world.ticking.size, tickingNear: () => tickingCells().length,
      // wild POKeMON and monsters (stage 5d): the level rule, a table roll at a cell, a visible one's battle level
      wild: { levelFor, capLevel, capWho: () => capWho(), genRoll: (map, kind, x, y, rod) => genRoll(map, kind, x, y, rod),
        wildLevel: (l, x, y, base) => wildLevel(l, x, y, base), biomeKind: (x, y, k) => E.biomeKind(world, x, y, k), engage: (e) => engageWild(e, false) } } : null;
  },
  ensure: (x, y, r = 1) => world.ensureAround(x, y, r),
  // generated worlds' saves (stage 4b): worlds.js, this world's id and descriptor, the last save's timing and the
  // last teleport wait
  worlds: () => G.worlds || null, wid: () => world.wid || null, wd: () => world.wd || null, lastSave: () => G.lastSave || null, lastWait: () => G.lastWait || null,
  respawn: () => respawn(), travel: (toNether) => travel(toNether), exitEnd: () => exitEnd(),
  layout: () => world.layout,
  kantoSign: () => world.kantoSign || null,
  // game modes (stage 8a; generated worlds): the state, a mode or difficulty change (OPTION's job from stage 8b), the
  // creative WILD POKeMON option, a forced save failure, the hardcore death screen and the autosave log
  modes: () => ({ mode: G.mode || null, diff: G.diff || null, rules: G.mr, wild: G.wildOpt, hc: G.hc || null, log: G.hcLog || null, autosaves: G.autosaves || [] }),
  setMode: (m, d) => { setMode(m, d ?? G.diff); return G.mr; },
  setWildOption: (on) => { G.wildOpt = !!on; if (world.wd) world.wd.wild = !!on; return G.wildOpt; },
  failSaves: (on = true) => { G.saveFail = !!on; },
  hcScreen: () => hcScreen,
  // stage 8b: START's rows and cursor, the OPTION window, an item's stack size
  menuRows: () => menuRows(), menuCursor: () => menuCursor, optionUI: () => optionUI, maxStack: (id) => (item(id) ? item(id).stack : 64),
  // stage 9: the title's world menus, whether the booted world was left through TITLE, the boot's descriptor, the
  // reload request the menus made, the trainer card's SEED
  titleMenus: () => titleMenus, titleLeft: () => titleLeft, boot: () => BOOT, leftTo: () => G.leftTo || null, cardSeed: () => (world.layout.gen ? cardSeed() : null),
  perf: (on = true) => { G.perf = on ? [] : null; perfLast = null; return true; },
  perfLog: () => G.perf,
  minimap: MAP_ON ? (o) => minimapHook(o) : undefined,   // the minimap (Track MAP; none under ?video): its state, { show: true | false | null } overrides it in memory
  net: netHooks,   // co-op test hooks (src/net/flag.js); nothing network-related loads until one is called
};
let audioClock = 0;
const baseTick = window.__rs.tick;
window.__rs.startAudio = () => { audioClock = 0; startRecording(() => audioClock); window.__rs.tick = (o = {}) => { const r = baseTick(o); audioClock += o.dt || 1 / 30; return r; }; };
window.__rs.renderAudio = (duration) => renderRecording(duration);
window.__rs.ready = true;
void OPP; void dirTo; void toolOf; void foodOf; void textWidth; void drawStack; void cry; void preloadCries; void species; void lightOf;
