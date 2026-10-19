// Loads everything the builders wrote: the Kanto tile world (tools/build_world.py), the Pokémon side
// (tools/build_pokemon.py) and the Minecraft side (tools/build_minecraft.py).
export const A = { img: {}, mon: {}, mc: {}, mob: {}, npc: {} };

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load ' + url));
    img.src = url;
  });
}
// (playfix: a dropped connection is retried twice with a short backoff; a missing file, a 404, fails at once)
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchR(url) {
  for (let i = 0; ; i++) {
    try { return await fetch(url); } catch (e) { if (i >= 2) throw e; await pause(300 * (i + 1)); }
  }
}
// an image every page needs: retried twice (an image's error cannot tell a dropped connection from a missing file,
// so the optional sprites, which may be missing, keep loadImage's single try)
async function loadImageR(url) {
  for (let i = 0; ; i++) {
    try { return await loadImage(url); } catch (e) { if (i >= 2) throw e; await pause(300 * (i + 1)); }
  }
}
async function loadJSON(url) { const r = await fetchR(url); if (!r.ok) throw new Error(url); return r.json(); }
async function loadBytes(url) { const r = await fetchR(url); if (!r.ok) throw new Error(url); return new Uint8Array(await r.arrayBuffer()); }
async function loadU16(url) { const b = await loadBytes(url); return new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2); }

export async function loadAssets(onProgress) {
  const W = 'assets/world/', MC = 'assets/mc/';
  const [world, grid, ground, col, beh, zone, area, prot, autotile, font, fontSmall, dex, battleColors, partyColors, items, mcFont, sfx] = await Promise.all([
    loadJSON(W + 'world.json'), loadU16(W + 'grid.bin'), loadU16(W + 'ground.bin'), loadBytes(W + 'col.bin'), loadBytes(W + 'beh.bin'),
    loadBytes(W + 'zone.bin'), loadU16(W + 'area.bin'), loadBytes(W + 'prot.bin'), loadJSON(W + 'autotile.json'),
    loadJSON('assets/ui/font.json'), loadJSON('assets/ui/font_small.json'), loadJSON('assets/data/pokemon.json'),
    loadJSON('assets/battle/colors.json'), loadJSON('assets/ui/party_colors.json'), loadJSON(MC + 'items.json'),
    loadJSON(MC + 'font.json'), loadJSON('assets/sfx/sfx.json'),
  ]);
  Object.assign(A, { world, grid, ground, col, beh, zone, area, prot, autotile, font, fontSmall, dex, battleColors, partyColors, items, mcFont, sfx });
  const images = {
    atlas: W + 'atlas.png', atlasTop: W + 'atlas_top.png',
    window: 'assets/ui/window.png', font: 'assets/ui/font.png', fontSmall: 'assets/ui/font_small.png',
    fxTallGrass: 'assets/ui/fx_tall_grass.png', fxRipple: 'assets/ui/fx_ripple.png', titleLogo: 'assets/ui/title_logo.png',
    tbMsg: 'assets/battle/textbox_msg.png', tbAction: 'assets/battle/textbox_action.png', tbMoves: 'assets/battle/textbox_moves.png',
    hbPlayer: 'assets/battle/healthbox_singles_player.png', hbOpp: 'assets/battle/healthbox_singles_opponent.png',
    barTiles: 'assets/battle/bar_tiles.png', enemyShadow: 'assets/battle/enemy_shadow.png', statusIcons: 'assets/battle/status_icons.png', statusHb: 'assets/battle/status_healthbox.png',
    ballPoke: 'assets/battle/ball_poke.png', ballGreat: 'assets/battle/ball_great.png', ballUltra: 'assets/battle/ball_ultra.png',
    partyBg: 'assets/ui/party_bg.png', partyBall: 'assets/ui/party_ball.png', partyWideEmpty: 'assets/ui/party_wide_empty.png',
    partyCancelNormal: 'assets/ui/party_cancel_normal.png', partyCancelSelected: 'assets/ui/party_cancel_selected.png',
    doors: W + 'doors.png', healBall: 'assets/ui/heal_ball.png',
    // FireRed's Hall of Fame (tools/build_ender_dragon.py; layout in assets/ui/hof.json)
    hofBg: 'assets/ui/hof_bg.png', hofConfetti: 'assets/ui/hof_confetti.png',
  };
  for (const t of ['grass', 'longgrass', 'sand', 'water', 'pond', 'mountain', 'cave', 'building', 'nether', 'end', 'wither']) images['bg_' + t] = `assets/battle/bg_${t}.png`;
  for (const st of ['normal', 'selected', 'fainted', 'fainted_selected', 'switching', 'switch_target']) {
    images['partyMain_' + st] = `assets/ui/party_main_${st}.png`;
    images['partyWide_' + st] = `assets/ui/party_wide_${st}.png`;
  }
  const mcImages = {
    icons: 'icons.png', blocks: 'blocks.png', fontE: 'font_eacute.png', steve: 'steve.png', back: 'back.png', portrait: 'portrait.png', titleSteve: 'title_steve.png', heldUv: 'held_uv.png', font: 'font.png', destroy: 'destroy.png',
    orb: 'experience_orb.png', campfireFire: 'campfire_fire.png', boat: 'boat.png', hook: 'fishing_hook.png', arrow: 'arrow.png', fire: 'fire.png', water: 'water_still.png', lava: 'lava_still.png',
    pGeneric: 'p_generic.png', pExplosion: 'p_explosion.png', pSmoke: 'p_smoke.png', pSplash: 'p_splash.png', pSweep: 'p_sweep.png',
    pFlame: 'p_flame.png', pBubble: 'p_bubble.png', pCrit: 'p_critical_hit.png', pHeart: 'p_heart.png', pAngry: 'p_angry.png', pNote: 'p_note.png',
    // the Nether: animated strips (items.json anim), its particles and the fireball
    portalAnim: 'nether_portal.png', fireStrip: 'fire_strip.png', soulFire: 'soul_fire.png', fireball: 'fireball.png',
    pLava: 'p_lava.png', pSoulFlame: 'p_soul_fire_flame.png', pSoul: 'p_soul.png',
  };
  for (const mat of ['iron', 'diamond', 'netherite']) for (const piece of ['boots', 'leggings', 'chestplate', 'helmet']) mcImages[`armor_${mat}_${piece}`] = `armor_${mat}_${piece}.png`;
  const gui = ['hotbar', 'hotbar_selection', 'heart_container', 'heart_container_blinking', 'heart_full', 'heart_half', 'heart_full_blinking', 'heart_half_blinking',
    'heart_absorbing_full', 'heart_absorbing_half', 'heart_poisoned_full', 'heart_poisoned_half', 'food_empty', 'food_full', 'food_half', 'food_empty_hunger', 'food_full_hunger', 'food_half_hunger',
    'armor_empty', 'armor_full', 'armor_half', 'air', 'air_bursting', 'xp_bg', 'xp_fill', 'inventory', 'crafting_table', 'furnace', 'chest',
    'burn_progress', 'lit_progress', 'slot_highlight_back', 'slot_highlight_front', 'tooltip_bg', 'tooltip_frame', 'button', 'button_highlighted',
    'recipe_button', 'recipe_button_highlighted', 'toast'];
  for (const g of gui) mcImages['gui_' + g] = `gui/${g}.png`;
  const jobs = Object.entries(images).map(async ([k, url]) => { A.img[k] = await loadImageR(url); });
  for (const [k, f] of Object.entries(mcImages)) jobs.push(loadImageR(MC + f).then((img) => { A.mc[k] = img; }));
  for (const m of Object.keys(items.mobSheets)) jobs.push(loadImageR(`${MC}mobs/${m}.png`).then((img) => { A.mob[m] = img; }));
  // a mob's glowing layer (the enderman's eyes), same layout as its sheet, drawn over the darkness: A.mob['<name>_eyes']
  for (const sh of Object.values(items.mobSheets)) if (sh.eyes) jobs.push(loadImageR(`${MC}mobs/${sh.eyes}.png`).then((img) => { A.mob[sh.eyes] = img; }));
  // The End's sprites and strips (items.json end.images: A.mc key -> file)
  for (const [k, f] of Object.entries((items.end && items.end.images) || {})) jobs.push(loadImageR(MC + f).then((img) => { A.mc[k] = img; }));
  // The Wither update's sprites, strips and GUI pieces (items.json wither.images: A.mc key -> file)
  for (const [k, f] of Object.entries((items.wither && items.wither.images) || {})) jobs.push(loadImageR(MC + f).then((img) => { A.mc[k] = img; }));
  // FireRed's people for the rooms (tools/build_world.py writes one strip of 16-px frames per sheet)
  for (const g of Object.keys(world.npcSheets || {})) jobs.push(loadImage(`assets/sprites/npc/${g}.png`).then((img) => { A.npc[g] = img; }).catch(() => {}));
  for (const [key, sp] of Object.entries(dex.species)) {
    const f = sp.file;
    A.mon[key] = {};
    const set = { front: `assets/mon/${f}_front.png`, back: `assets/mon/${f}_back.png`, frontShiny: `assets/mon/${f}_front_shiny.png`,
      backShiny: `assets/mon/${f}_back_shiny.png`, icon: `assets/mon/${f}_icon.png`, ow: `assets/sprites/ow_${f}.png`, owShiny: `assets/sprites/ow_${f}_shiny.png` };
    for (const [k, url] of Object.entries(set)) jobs.push(loadImage(url).then((img) => { A.mon[key][k] = img; }).catch(() => {}));
  }
  // FireRed's Hall of Fame layout (tools/build_ender_dragon.py)
  jobs.push(loadJSON('assets/ui/hof.json').then((j) => { A.hof = j; }).catch(() => { A.hof = null; }));
  let done = 0;
  for (const j of jobs) j.then(() => { done++; if (onProgress) onProgress(done / jobs.length); });
  await Promise.all(jobs);
  return A;
}

// Generated worlds only (the world update, stage 4a): the tile bank (terrain.json, tools/build_terrain.py), its
// second atlas pair and Minecraft's world border texture. A Classic page never asks for any of them.
export async function loadGenAssets() {
  const W = 'assets/world/';
  const [terrain, atlasGen, atlasGenTop, forcefield, iconsWorld, worldDex, kantoSign] = await Promise.all([
    loadJSON(W + 'terrain.json'), loadImageR(W + 'atlas_gen.png'), loadImageR(W + 'atlas_gen_top.png'),
    loadImage('assets/mc/forcefield.png').catch(() => null),
    loadImage('assets/mc/icons_world.png').catch(() => null),
    loadJSON('assets/data/pokemon_world.json').catch(() => null),
    loadImage(W + 'kanto_sign.png').catch(() => null),   // (a Kanto World's spawn sign, tools/build_kanto_sign.py; world.js draws FireRed's own sign without it)
  ]);
  // every item's icon, the world update's too (stage 5a: icons.png keeps only the older rows, so Classic draws as before)
  if (iconsWorld) A.mc.icons = iconsWorld;
  addWorldDex(worldDex);
  A.terrain = terrain; A.genCols = terrain.cols;
  A.img.atlasGen = atlasGen; A.img.atlasGenTop = atlasGenTop;
  if (forcefield) A.mc.forcefield = forcefield;
  if (kantoSign) A.img.kantoSign = kantoSign;
  return A;
}

// Generated worlds only (stage 5d, design 3.15): the new species, the moves they bring and the biome and cave wild tables
// (tools/build_pokemon.py --world), merged into A.dex. pokemon.json itself is unchanged, so a Classic page loads exactly
// what it did. Merging twice (a co-op guest's second world) changes nothing. The sprites load in the background (nothing
// waits for them: a co-op guest's join and the boot are not slowed; a sprite not there yet is simply not drawn).
function addWorldDex(extra) {
  if (!extra || !A.dex) return;
  for (const [k, v] of Object.entries(extra.moves || {})) if (!A.dex.moves[k]) A.dex.moves[k] = v;
  for (const [k, v] of Object.entries(extra.wild || {})) A.dex.wild[k] = v;
  for (const [key, sp] of Object.entries(extra.species || {})) {
    if (A.dex.species[key]) continue;
    A.dex.species[key] = sp;
    const f = sp.file;
    A.mon[key] = {};
    const set = { front: `assets/mon/${f}_front.png`, back: `assets/mon/${f}_back.png`, frontShiny: `assets/mon/${f}_front_shiny.png`,
      backShiny: `assets/mon/${f}_back_shiny.png`, icon: `assets/mon/${f}_icon.png`, ow: `assets/sprites/ow_${f}.png`, owShiny: `assets/sprites/ow_${f}_shiny.png` };
    for (const [k, url] of Object.entries(set)) loadImage(url).then((img) => { A.mon[key][k] = img; }).catch(() => {});
  }
}
