// Co-op players' looks: Minecraft's default skins (built by tools/build_minecraft.py --skins into assets/mc/skins/,
// listed in items.json "skins"), Minecraft-style name tags and the battle indicator. Loaded only when a room
// opens; single-player never imports this file.
//
// A "look" is what PL.drawSteve needs to draw another player: { key, name, model, img (overworld sheet, same
// layout as steve.png), heldUv, armorImgs { '<mat>_<piece>': img }, hands (hand anchors per frame), back, backHands, portrait }, plus that player's gear: held (a stack or null) and armor (four stacks
// or nulls, helmet first, as G.inv.armor).
import { A } from '../assets.js';
import { TILE } from '../game.js';
import { mcText, mcWidth } from '../mcfont.js';
import * as PL from '../player.js';

const MC = 'assets/mc/';
const FOOT = 13;            // as player.js: feet sit this far down a tile
const FALLBACK = ['steve', 'alex', 'zuri', 'sunny', 'noor', 'makena', 'kai', 'efe', 'ari'];

export const skinOrder = () => (A.items.skins && A.items.skins.order) || FALLBACK;
export const isSkin = (name) => skinOrder().includes(name);
// display name: "Steve" for the tag default, "ALEX" in FireRed menus
export const skinLabel = (name) => (name ? name[0].toUpperCase() + name.slice(1) : '');

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load ' + url));
    img.src = url;
  });
}

// Steve's own look always comes from the sheets the game already loaded (a guest swaps A.mc to its skin, so
// Steve's are kept here first).
let steveLook = null;
function steve() {
  if (steveLook) return steveLook;
  const armorImgs = {};
  for (const mat of ['iron', 'diamond', 'netherite']) for (const piece of ['boots', 'leggings', 'chestplate', 'helmet']) armorImgs[`${mat}_${piece}`] = A.mc[`armor_${mat}_${piece}`];
  steveLook = { key: 'steve', name: 'steve', model: 'wide', img: A.mc.steve, heldUv: A.mc.heldUv, armorImgs, hands: A.items.steve.hands,
    back: A.mc.back, backHands: A.items.back.hands, portrait: A.mc.portrait };
  return steveLook;
}

// a file named by items.json: under skins/ it is loaded once (shared files are shared), otherwise it is one
// of Steve's sheets already in memory
const files = new Map();
function file(f) {
  if (!f.startsWith('skins/')) {
    if (f === 'held_uv.png') return Promise.resolve(steve().heldUv);
    const m = /^armor_(\w+?)_(\w+)\.png$/.exec(f);
    if (m) return Promise.resolve(steve().armorImgs[`${m[1]}_${m[2]}`]);
    return Promise.reject(new Error('unknown skin file ' + f));
  }
  if (!files.has(f)) files.set(f, loadImage(MC + f));
  return files.get(f);
}

const looks = new Map();
// Promise of a skin's look; an unknown name gives Steve's.
export function loadSkin(name) {
  if (name === 'steve' || !A.items.skins || !A.items.skins.list[name]) return Promise.resolve(steve());
  if (looks.has(name)) return looks.get(name);
  const e = A.items.skins.list[name];
  const p = (async () => {
    const armorKeys = Object.keys(e.armor);
    const [img, heldUv, back, portrait, ...armor] = await Promise.all([file(e.sheet), file(e.held), file(e.back), file(e.portrait), ...armorKeys.map((k) => file(e.armor[k]))]);
    const armorImgs = {};
    armorKeys.forEach((k, i) => { armorImgs[k] = armor[i]; });
    // every look carries its hand anchors: a guest's own A.items.steve.hands are its skin's, not Steve's
    return { key: name, name, model: e.model, img, heldUv, armorImgs, hands: e.hands || steve().hands, back, backHands: e.backHands, portrait };
  })();
  p.catch(() => looks.delete(name));    // a failed load can be tried again
  looks.set(name, p);
  return p;
}
// the look already loaded, or null (drawing never waits)
const ready = new Map();
export function lookNow(name) {
  if (name === 'steve' || !A.items.skins || !A.items.skins.list[name]) return steve();
  if (ready.has(name)) return ready.get(name);
  loadSkin(name).then((l) => ready.set(name, l), () => {});
  return null;
}
// a look with a player's gear, for PL.drawSteve
export const withGear = (look, held, armor) => (look ? { ...look, held: held || null, armor: armor || [] } : null);

// ---------------------------------------------------------------- a guest's own Steve
// The guest's own character is drawn by the single-player code from A.mc, so its skin replaces Steve's
// sheets there (the overworld sheet, held-item map, armor overlays, battle back pic and hands, inventory
// portrait, party icon). restoreOwnSkin puts Steve's back when the guest leaves.
let saved = null;
export async function applyOwnSkin(name) {
  const base = steve();
  const look = await loadSkin(name);
  if (!saved) saved = { steve: A.mc.steve, heldUv: A.mc.heldUv, back: A.mc.back, portrait: A.mc.portrait, armor: { ...base.armorImgs }, itemsSteve: A.items.steve, itemsBack: A.items.back, mon: A.mon.STEVE };
  A.mc.steve = look.img; A.mc.heldUv = look.heldUv; A.mc.back = look.back; A.mc.portrait = look.portrait;
  for (const [k, img] of Object.entries(look.armorImgs)) A.mc['armor_' + k] = img;
  A.items.steve = look.hands === saved.itemsSteve.hands ? saved.itemsSteve : { ...saved.itemsSteve, hands: look.hands };
  A.items.back = { ...saved.itemsBack, hands: look.backHands };
  if (saved.mon) A.mon.STEVE = { ...saved.mon, ...monArt(look.img, look.back) };
  PL.resetSteveArt();
  return look;
}
export function restoreOwnSkin() {
  if (!saved) return;
  A.mc.steve = saved.steve; A.mc.heldUv = saved.heldUv; A.mc.back = saved.back; A.mc.portrait = saved.portrait;
  for (const [k, img] of Object.entries(saved.armor)) A.mc['armor_' + k] = img;
  A.items.steve = saved.itemsSteve; A.items.back = saved.itemsBack;
  if (saved.mon) A.mon.STEVE = saved.mon;
  saved = null;
  PL.resetSteveArt();
}
// the party icon and battle sprite, cut the way main.js addSteveSpecies cuts Steve's
function monArt(sheet, backSheet) {
  const st = A.items.steve, icon = document.createElement('canvas');
  icon.width = 32; icon.height = 64;
  const g = icon.getContext('2d');
  const fr = st.poses.walk.down;
  [0, 1].forEach((k) => g.drawImage(sheet, fr[k] * st.w, 0, st.w, st.h, 4, 64 - 32 * (2 - k) - 1 + (k ? -1 : 0), st.w, st.h));
  const back = document.createElement('canvas'); back.width = 64; back.height = 64;
  back.getContext('2d').drawImage(backSheet, 0, 0, 64, 64, 0, 0, 64, 64);
  return { icon, back, front: back };
}

// ---------------------------------------------------------------- name tags and the battle indicator
// Minecraft's name tag: the name in white (no shadow) on a quarter-black box one pixel wider than the text,
// over the player's head. Drawn at canvas resolution (two pixels per GBA pixel) after the world and its
// lighting, so it stays readable at night and in caves. cx, bottom: canvas pixels.
export function drawNameTag(ctx, name, cx, bottom, alpha = 1) {
  const text = String(name || '');
  if (!text) return;
  const w = mcWidth(text), x = Math.round(cx - w / 2), y = Math.round(bottom - 9);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x - 1, y, w + 2, 9);
  mcText(ctx, text, x, y + 1, '#ffffff', false);
  ctx.restore();
}
// Where a player's tag goes, in canvas pixels: centred over the head, three GBA pixels above it
// (clear of a helmet). Follows
// drawSteve's placement (the walk's hop, the boat seat, the bed). P: a player or an avatar with P's fields.
export function tagAnchor(P, cam) {
  const st = A.items.steve, top = (A.items.skins && A.items.skins.headTop) || 9;
  if (P.sleeping) return { x: (P.sleeping.hx * TILE + 8 - cam.x) * 2, y: (P.sleeping.hy * TILE - 6 - cam.y) * 2 };
  const lift = (P.z || 0) + (P.moving && P.dist === 2 ? Math.sin(P.prog * Math.PI) * 8 : 0);
  let y = P.fy * TILE + FOOT - st.origin[1] - cam.y - lift + top - 3;
  if (P.riding) y += P.riding.dir === 'left' || P.riding.dir === 'right' ? -3 : 3;
  return { x: (P.fx * TILE + 8 - cam.x) * 2, y: y * 2 };
}
// FireRed's Poké Ball bobbing over a player who is in a battle; returns the height it took (canvas pixels)
export function drawBattleIndicator(ctx, cx, bottom, clock) {
  const img = A.img.ballPoke;
  if (!img) return 0;
  const bob = Math.round(Math.sin(clock * 4) * 2);
  ctx.drawImage(img, 0, 0, 16, 16, Math.round(cx - 8), Math.round(bottom - 16 + bob), 16, 16);
  return 18;
}
// The tag (and the indicator when battling) for another player. opts: { battling, clock, alpha }.
export function drawTagFor(ctx, P, cam, name, opts = {}) {
  if (!P || P.dead || P.visible === false) return;
  const a = opts.anchor || tagAnchor(P, cam);
  drawNameTag(ctx, name, a.x, a.y, opts.alpha == null ? 1 : opts.alpha);
  if (opts.battling) drawBattleIndicator(ctx, a.x, a.y - 11, opts.clock || 0);
}
