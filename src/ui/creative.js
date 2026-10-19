// The creative inventory (the world update's design, 6.3): Minecraft's creative screen from its own textures
// (gui/container/creative_inventory/tab_items, tab_item_search and tab_inventory, the tab and scroller sprites; built
// into assets/mc/menu/ by tools/build_menu_assets.py) with Minecraft's coordinates: a 9 x 5 item grid and the hotbar,
// tabs above and below, the survival inventory as the last tab, and its destroy slot.
//
// Tabs: Building Blocks, Natural Blocks, Functional Blocks, Tools and Utilities, Combat, Food and Drinks, Ingredients,
// POKeMON Items (the Poke Ball), Search, Survival Inventory. An item's tab comes from its `tab` field in items.json when
// tools/mcdata.py writes one, else from the lists below, else from what it is (block, tool, food). Protected things
// (modes.js isProtectedItem: end portal frames, bedrock, spawners, infested stone, portal and fire tiles, the dragon
// egg, every hard < 0 block) and the paused Wither's items are in no tab.
//
// Mouse: left click on an item puts a full stack on the cursor, right click one; clicking the grid with a stack on the
// cursor deletes it (Minecraft's destroy), or adds one when it is the same item; hotbar and inventory slots work as in
// the survival screens; number keys over an item fill that hotbar slot. Keys and pad: arrows move between tabs, grid
// and hotbar, Z (A) takes a stack, X (B) takes one, C and V switch tabs, E (INV) or Esc closes. Search opens the
// page-level text box and filters by name as you type.
//
// A Screen-shaped class (update(dt, input), draw(ctx), done, close()) for main.js's 'screen' state; not wired yet.
import { A } from '../assets.js';
import { mcText, mcWidth } from '../mcfont.js';
import { item, maxStack, ARMOR } from '../items.js';
import { drawStack, drawTooltip, tooltipLines, drawIcon } from '../hud.js';
import { inCreativeTabs, SEARCH_MAX } from '../modes.js';
import { W, H, M, drawTip, inside, PointerMode, sound, loadMenuAssets, claimTouch, releaseTouch } from './mcgui.js';
import { openTextEntry, closeTextEntry, textEntryOpen } from './textentry.js';
import { isButtonKey } from '../input.js';

export const TABS = [
  { id: 'building', name: 'Building Blocks', icon: 'bricks', top: true, col: 0 },
  { id: 'natural', name: 'Natural Blocks', icon: 'oak_sapling', top: true, col: 1 },
  { id: 'functional', name: 'Functional Blocks', icon: 'crafting_table', top: true, col: 2 },
  { id: 'tools', name: 'Tools and Utilities', icon: 'diamond_pickaxe', top: false, col: 0 },
  { id: 'combat', name: 'Combat', icon: 'golden_sword', top: false, col: 1 },
  { id: 'food', name: 'Food and Drinks', icon: 'golden_apple', top: false, col: 2 },
  { id: 'ingredients', name: 'Ingredients', icon: 'iron_ingot', top: false, col: 3 },
  { id: 'pokemon', name: 'POKéMON Items', icon: 'poke_ball', top: true, col: 3 },
  { id: 'search', name: 'Search', icon: 'book', top: true, col: 6 },
  { id: 'inventory', name: 'Survival Inventory', icon: 'chest', top: false, col: 6 },
];
const TAB_IDS = TABS.map((t) => t.id);

// Minecraft's own tab contents for the items this game has, in Minecraft's order within each tab.
const TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
const tiered = (kinds) => TIERS.flatMap((t) => kinds.map((k) => `${t}_${k}`));
const LISTS = {
  building: ['oak_log', 'oak_planks', 'oak_fence', 'birch_fence', 'oak_door', 'stone', 'cobblestone', 'stone_bricks', 'mossy_stone_bricks',
    'cracked_stone_bricks', 'chiseled_stone_bricks', 'bricks', 'sandstone', 'nether_bricks', 'end_stone_bricks', 'coal_block', 'iron_block',
    'iron_bars', 'gold_block', 'redstone_block', 'emerald_block', 'lapis_block', 'diamond_block', 'netherite_block', 'copper_block',
    'white_wool', 'white_concrete', 'light_gray_concrete', 'orange_concrete', 'yellow_concrete', 'lime_concrete', 'green_concrete',
    'light_blue_concrete', 'blue_concrete', 'purple_concrete', 'pink_concrete', 'glass'],
  natural: ['dirt', 'sand', 'end_stone', 'obsidian', 'netherrack', 'soul_sand', 'soul_soil', 'bone_block', 'magma_block', 'glowstone',
    'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris', 'oak_leaves', 'oak_sapling', 'dandelion', 'poppy', 'cobweb', 'pumpkin',
    'hay_block', 'wheat_seeds', 'nether_wart'],
  functional: ['torch', 'campfire', 'jack_o_lantern', 'crafting_table', 'furnace', 'chest', 'bookshelf', 'white_bed', 'oak_sign', 'tnt'],
  tools: [...tiered(['shovel', 'pickaxe', 'axe', 'hoe']), 'flint_and_steel', 'fire_charge', 'shears', 'fishing_rod', 'bucket', 'water_bucket',
    'lava_bucket', 'milk_bucket', 'oak_boat', 'ender_pearl', 'eye_of_ender'],
  combat: [...tiered(['sword']), ...tiered(['axe']), ...['iron', 'diamond', 'netherite'].flatMap((m) => ['helmet', 'chestplate', 'leggings', 'boots'].map((p) => `${m}_${p}`)),
    'bow', 'arrow', 'end_crystal'],
  food: ['apple', 'golden_apple', 'bread', 'beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'mutton', 'cooked_mutton', 'chicken',
    'cooked_chicken', 'cod', 'cooked_cod', 'salmon', 'cooked_salmon', 'rotten_flesh', 'milk_bucket'],
  ingredients: ['coal', 'charcoal', 'raw_iron', 'raw_copper', 'raw_gold', 'emerald', 'lapis_lazuli', 'diamond', 'ancient_debris', 'quartz',
    'netherite_scrap', 'iron_ingot', 'copper_ingot', 'gold_nugget', 'gold_ingot', 'netherite_ingot', 'stick', 'flint', 'wheat', 'bone',
    'bone_meal', 'string', 'feather', 'egg', 'leather', 'paper', 'book', 'gunpowder', 'redstone', 'glowstone_dust', 'blaze_rod',
    'blaze_powder', 'ghast_tear', 'magma_cream', 'nether_brick', 'stone_button'],
};
// the tab ids an item belongs to (an item may be in two tabs, as Minecraft's axes are)
export function tabsOf(id, it = item(id)) {
  if (!it || !inCreativeTabs(id, it)) return [];
  if (it.tab && TAB_IDS.includes(it.tab)) return [it.tab];
  const out = [];
  if (it.ball || it.med || (it.frName && !it.block && !it.tool && !it.food)) out.push('pokemon');
  for (const [tab, list] of Object.entries(LISTS)) if (list.includes(id) && !out.includes(tab)) out.push(tab);
  if (out.length) return out;
  if (it.armor || (it.tool && (it.tool.kind === 'sword' || it.tool.kind === 'bow'))) return ['combat'];
  if (it.tool) return ['tools'];
  if (it.food) return ['food'];
  if (it.block) return ['building'];
  return ['ingredients'];
}
let tabCache = null, tabCacheFor = null;
// { tabId: [ids...] } for every item tab, Minecraft's order first then items.json's
export function tabContents() {
  const items = A.items && A.items.items;
  if (!items) return {};
  if (tabCache && tabCacheFor === items) return tabCache;
  const out = {};
  for (const t of TABS) if (t.id !== 'search' && t.id !== 'inventory') out[t.id] = [];
  const all = Object.keys(items);
  for (const t of Object.keys(out)) {
    const list = LISTS[t] || [];
    const want = (id) => tabsOf(id).includes(t);
    for (const id of list) if (items[id] && want(id) && !out[t].includes(id)) out[t].push(id);
    for (const id of all) if (want(id) && !out[t].includes(id)) out[t].push(id);
  }
  tabCache = out; tabCacheFor = items;
  return out;
}
export function searchItems(q) {
  const tabs = tabContents(), seen = new Set(), out = [];
  const query = String(q || '').trim().toLowerCase();
  for (const t of TABS) for (const id of tabs[t.id] || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const it = item(id);
    if (!query || (it && it.name.toLowerCase().includes(query)) || id.replace(/_/g, ' ').includes(query)) out.push(id);
  }
  return out;
}

let lastTab = 0;
const same = (a, b) => a && b && a.id === b.id && !a.dmg && !b.dmg;
const PW = 195, PH = 136;

export class CreativeScreen {
  constructor(G, { tab } = {}) {
    this.G = G; this.kind = 'creative';
    this.tab = Number.isInteger(tab) && TABS[tab] ? tab : lastTab;
    this.cursor = null; this.scroll = 0; this.query = ''; this.t = 0; this.done = false;
    this.pm = new PointerMode(G && G.input); this.drag = false;
    this.sel = { area: 'grid', i: 0 };
    loadMenuAssets();
    if (!G || !G.inv) this.done = true;
    this.setTab(this.tab, true);
  }
  get x0() { return Math.round((W - PW) / 2); }
  get y0() { return Math.round((H - PH) / 2); }
  get tabDef() { return TABS[this.tab]; }
  setTab(i, quiet) {
    if (!TABS[i]) return;
    this.tab = i; lastTab = i; this.scroll = 0;
    if (!quiet) sound('click');
    const id = TABS[i].id;
    if (this.sel.area !== 'tab') this.sel = id === 'inventory' ? { area: 'inv', i: 31 } : id === 'search' ? { area: 'search', i: 0 } : { area: 'grid', i: 0 };
    if (id !== 'search') closeTextEntry(true);
  }
  list() {
    const id = this.tabDef.id;
    if (id === 'inventory') return [];
    if (id === 'search') return searchItems(this.query);
    return tabContents()[id] || [];
  }
  rows() { return Math.ceil(this.list().length / 9); }
  maxScroll() { return Math.max(0, this.rows() - 5); }

  // ------------------------------------------------------------------ geometry
  tabRect(i) {
    const t = TABS[i], x = this.x0 + (t.col === 6 ? PW - 27 + 1 : 27 * t.col), y = t.top ? this.y0 - 28 : this.y0 + PH - 4;
    return { x, y, w: 26, h: 32 };
  }
  gridRect(i) { return { x: this.x0 + 9 + (i % 9) * 18 - 1, y: this.y0 + 18 + Math.floor(i / 9) * 18 - 1, w: 18, h: 18 }; }
  hotRect(i) { return { x: this.x0 + 9 + i * 18 - 1, y: this.y0 + 112 - 1, w: 18, h: 18 }; }
  searchRect() { return { x: this.x0 + 80, y: this.y0 + 4, w: 89, h: 12 }; }
  scrollRect() { return { x: this.x0 + 175, y: this.y0 + 18, w: 12, h: 112 }; }
  // the survival tab's slots: armor (4), main (27), hotbar (9), destroy (1)
  invSlots() {
    const inv = this.G.inv, S = [];
    const armorPos = [[54, 6], [54, 33], [108, 6], [108, 33]];
    ARMOR.forEach((piece, i) => S.push({ kind: 'armor', piece, x: armorPos[i][0], y: armorPos[i][1], get: () => inv.armor[i], set: (s) => { inv.armor[i] = s; },
      accept: (s) => !s || (item(s.id) && item(s.id).armor && item(s.id).armor.slot === piece) }));
    for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) { const idx = 9 + r * 9 + c; S.push({ kind: 'inv', idx, x: 9 + c * 18, y: 54 + r * 18, get: () => inv.slots[idx], set: (s) => { inv.slots[idx] = s; } }); }
    for (let c = 0; c < 9; c++) S.push({ kind: 'inv', idx: c, x: 9 + c * 18, y: 112, get: () => inv.slots[c], set: (s) => { inv.slots[c] = s; } });
    S.push({ kind: 'destroy', x: 173, y: 112, get: () => null, set: () => {} });
    return S;
  }
  // every focus stop for the arrow keys: { area, i, x, y, w, h }
  stops() {
    const S = [];
    TABS.forEach((t, i) => S.push({ area: 'tab', i, ...this.tabRect(i) }));
    const id = this.tabDef.id;
    if (id === 'inventory') this.invSlots().forEach((s, i) => S.push({ area: 'inv', i, x: this.x0 + s.x - 1, y: this.y0 + s.y - 1, w: 18, h: 18 }));
    else {
      if (id === 'search') S.push({ area: 'search', i: 0, ...this.searchRect() });
      const n = Math.min(45, Math.max(0, this.list().length - this.scroll * 9));
      for (let i = 0; i < 45; i++) if (i < n || i === 0) S.push({ area: 'grid', i, ...this.gridRect(i) });
      for (let i = 0; i < 9; i++) S.push({ area: 'hot', i, ...this.hotRect(i) });
    }
    return S;
  }
  stopAt(m) { return this.stops().find((s) => inside(m, s)) || null; }
  gridItem(i) { const l = this.list(), k = this.scroll * 9 + i; return k >= 0 && k < l.length ? l[k] : null; }

  // ------------------------------------------------------------------ actions
  takeFromGrid(i, button, shift) {
    const id = this.gridItem(i);
    if (this.cursor) {
      if (id && same(this.cursor, { id }) && button === 0) { this.cursor.n = Math.min(maxStack(id), this.cursor.n + 1); return; }
      this.cursor = null;   // the grid is Minecraft's destroy slot for whatever the cursor holds
      sound('click');
      return;
    }
    if (!id) return;
    if (shift) { this.G.inv.add(id, maxStack(id)); return; }
    this.cursor = { id, n: button === 0 ? maxStack(id) : 1 };
  }
  clickSlot(slot, button) {
    if (slot.kind === 'destroy') { if (this.cursor) { this.cursor = null; sound('click'); } return; }
    const cur = slot.get(), accept = slot.accept || (() => true);
    if (button === 0) {
      if (!this.cursor) { if (cur) { this.cursor = cur; slot.set(null); } return; }
      if (!accept(this.cursor)) return;
      if (!cur) { slot.set(this.cursor); this.cursor = null; return; }
      if (same(cur, this.cursor)) { const k = Math.min(maxStack(cur.id) - cur.n, this.cursor.n); cur.n += k; this.cursor.n -= k; if (this.cursor.n <= 0) this.cursor = null; return; }
      slot.set(this.cursor); this.cursor = cur;
    } else {
      if (!this.cursor) { if (cur) { const half = Math.ceil(cur.n / 2); this.cursor = { ...cur, n: half }; cur.n -= half; if (cur.n <= 0) slot.set(null); } return; }
      if (!accept(this.cursor)) return;
      if (!cur) { slot.set({ ...this.cursor, n: 1 }); this.cursor.n--; if (this.cursor.n <= 0) this.cursor = null; return; }
      if (same(cur, this.cursor) && cur.n < maxStack(cur.id)) { cur.n++; this.cursor.n--; if (this.cursor.n <= 0) this.cursor = null; return; }
      slot.set(this.cursor); this.cursor = cur;
    }
  }
  hotSlot(i) { const inv = this.G.inv; return { kind: 'inv', idx: i, get: () => inv.slots[i], set: (s) => { inv.slots[i] = s; } }; }
  press(stop, button, shift) {
    if (!stop) return;
    if (stop.area === 'tab') { if (stop.i !== this.tab) this.setTab(stop.i); return; }
    if (stop.area === 'search') { this.editSearch(); return; }
    if (stop.area === 'grid') { this.takeFromGrid(stop.i, button, shift); return; }
    if (stop.area === 'hot') { this.clickSlot(this.hotSlot(stop.i), button); return; }
    if (stop.area === 'inv') { const s = this.invSlots()[stop.i]; if (s) this.clickSlot(s, button); }
  }
  editSearch() {
    const r = { x: this.x0, y: this.y0 - 28, w: PW, h: 28 };   // above the tabs, so the results stay in view
    openTextEntry({ label: 'Search', value: this.query, maxLength: SEARCH_MAX, rect: r, above: true, canvasW: W,
      onInput: (v) => { this.query = v; this.scroll = 0; }, onDone: (v) => { this.query = v; this.scroll = 0; }, onCancel: () => {} });
  }
  // number key k over a stop: a grid item fills hotbar slot k with a full stack; a slot swaps with hotbar slot k
  numberKey(stop, k) {
    const inv = this.G.inv;
    if (!stop) return;
    if (stop.area === 'grid') { const id = this.gridItem(stop.i); if (id) inv.slots[k] = { id, n: maxStack(id) }; return; }
    const s = stop.area === 'hot' ? this.hotSlot(stop.i) : stop.area === 'inv' ? this.invSlots()[stop.i] : null;
    if (!s || s.kind === 'destroy') return;
    const a = s.get(), b = inv.slots[k];
    if (s.accept && !s.accept(b)) return;
    s.set(b); inv.slots[k] = a;
  }
  move(d) {
    const S = this.stops(), cur = S.find((s) => s.area === this.sel.area && s.i === this.sel.i) || S.find((s) => s.area !== 'tab') || S[0];
    // the grid scrolls before the cursor leaves it
    if (cur.area === 'grid') {
      const row = Math.floor(cur.i / 9);
      if (d === 'down' && row === 4 && this.scroll < this.maxScroll()) { this.scroll++; return; }
      if (d === 'up' && row === 0 && this.scroll > 0) { this.scroll--; return; }
    }
    const c = (s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 }), a = c(cur);
    const dx = d === 'left' ? -1 : d === 'right' ? 1 : 0, dy = d === 'up' ? -1 : d === 'down' ? 1 : 0;
    let best = null, bd = Infinity;
    for (const s of S) {
      if (s === cur) continue;
      const b = c(s), vx = b.x - a.x, vy = b.y - a.y, along = vx * dx + vy * dy;
      if (along <= 0) continue;
      const score = along + Math.abs(dx ? vy : vx) * 2.5;
      if (score < bd) { bd = score; best = s; }
    }
    if (best) this.sel = { area: best.area, i: best.i };
  }

  // ------------------------------------------------------------------ input
  // (the game's update loop must never throw: a fault here is logged once and closes the screen)
  update(dt, input) { try { this.step(dt, input); } catch (e) { if (!this.fault) console.error(e); this.fault = true; this.done = true; } }
  scrollTo(y) {
    const sr = this.scrollRect(), f = (y - sr.y - 7.5) / (sr.h - 15);
    this.scroll = Math.max(0, Math.min(this.maxScroll(), Math.round(f * this.maxScroll())));
  }
  // touches (mcgui claimTouch): a finger on the scroller drags it; a tap on the search field opens its box inside the
  // touchend handler, so an iPhone raises its keyboard
  onTouch(type, m) {
    if (this.done || textEntryOpen() || !this.G || this.tabDef.id === 'inventory') { this.touchDrag = false; return false; }
    const sr = this.scrollRect();
    if (type === 'touchstart') {
      this.touchSearch = this.tabDef.id === 'search' && inside(m, this.searchRect());
      if (inside(m, sr) && this.maxScroll() > 0) { this.touchDrag = true; this.scrollTo(m.y); return true; }
      return false;
    }
    if (this.touchDrag) {
      if (type === 'touchmove') this.scrollTo(m.y);
      else this.touchDrag = false;
      return true;
    }
    if (type === 'touchend' && this.touchSearch && this.tabDef.id === 'search' && inside(m, this.searchRect())) {
      this.touchSearch = false; this.sel = { area: 'search', i: 0 }; this.searchPtr = true; this.editSearch();
      return true;
    }
    return false;
  }
  step(dt, input) {
    this.t += dt;
    if (this.done) return;
    claimTouch(this);
    if (textEntryOpen()) return;
    // (playfix: on the Search tab, typing goes straight into the search field, as in Minecraft: letters always, digits
    // only with the field selected, since a digit over an item is its hotbar key; Esc still closes)
    // (playfix2: with the field selected every key types (Z, the A button, opens it as it is unless a click or tap
    // focused it); over the grid, tabs or slots only keys that are no game button (not Z, X, E, Q, C, V, WASD) nor a
    // digit (a hotbar key) do, so a keyboard player can still take a result and close the screen)
    if (this.sel.area !== 'search') this.searchPtr = false;
    const onField = this.sel.area === 'search';
    const typed = (input.typed || []).filter((k) => (onField ? this.searchPtr || (k !== 'z' && k !== 'Z') : !isButtonKey(k) && !/[0-9]/.test(k))).join('');
    if (this.tabDef.id === 'search' && typed && !input.just('esc')) {
      this.sel = { area: 'search', i: 0 };
      this.query = String(this.query + typed).slice(0, SEARCH_MAX); this.scroll = 0;
      this.editSearch();
      return;
    }
    if (input.just('inv') || input.just('esc')) { this.done = true; return; }
    const useMouse = this.pm.update(input), m = input.mouse, shift = input.held('sprint');
    if (input.just('prev')) { this.setTab((this.tab + TABS.length - 1) % TABS.length); return; }
    if (input.just('next')) { this.setTab((this.tab + 1) % TABS.length); return; }
    const wheel = input.takeWheel ? input.takeWheel() : 0;
    if (wheel && this.tabDef.id !== 'inventory') this.scroll = Math.max(0, Math.min(this.maxScroll(), this.scroll + Math.sign(wheel)));
    // the scroller: a click or a tap on its track jumps there at once (a tap presses and releases in one frame, so it
    // must not wait for a drag), and holding the mouse drags it; a finger drag comes through onTouch
    const sr = this.scrollRect();
    if (input.just('mouseL') && inside(m, sr) && this.maxScroll() > 0) { this.drag = true; this.scrollTo(m.y); return; }
    if (this.drag && !input.held('mouseL')) this.drag = false;
    if (this.drag) { this.scrollTo(m.y); return; }
    if (useMouse) {
      const s = this.stopAt(m);
      if (s) this.sel = { area: s.area, i: s.i };
      const btn = input.just('mouseL') ? 0 : input.just('mouseR') ? 1 : -1;
      if (btn >= 0) {
        if (s) { if (s.area === 'search') this.searchPtr = true; this.press(s, btn, shift); }
        else if (this.cursor && !inside(m, { x: this.x0, y: this.y0 - 28, w: PW, h: PH + 56 })) {
          // outside the screen: Minecraft throws the stack into the world
          const st = btn === 1 ? { ...this.cursor, n: 1 } : this.cursor;
          if (this.G.dropStack) { try { this.G.dropStack(st, true); } catch (e) { /* never throw */ } }
          if (btn === 1) { this.cursor.n--; if (this.cursor.n <= 0) this.cursor = null; } else this.cursor = null;
        }
      }
    } else for (const d of ['up', 'down', 'left', 'right']) if (input.just(d)) { this.move(d); this.keyMoved = true; }
    // A and B act on the selected stop (the hovered one with a mouse), so the pad works whatever moved last
    if (input.just('a') || input.just('start') || input.just('b')) {
      const stop = this.stops().find((s) => s.area === this.sel.area && s.i === this.sel.i);
      this.press(stop, input.just('b') ? 1 : 0, shift);
    }
    for (let k = 1; k <= 9; k++) if (input.just('slot' + k)) this.numberKey(this.stops().find((s) => s.area === this.sel.area && s.i === this.sel.i), k - 1);
  }
  close() {
    releaseTouch(this);
    closeTextEntry(true);
    if (this.cursor && this.G && this.G.inv) this.G.inv.add(this.cursor.id, this.cursor.n, this.cursor.dmg ? { dmg: this.cursor.dmg } : {});
    this.cursor = null;
  }

  // ------------------------------------------------------------------ drawing
  drawTab(ctx, i) {
    const t = TABS[i], r = this.tabRect(i), sel = i === this.tab, strip = M('creative_tabs');
    const row = (t.top ? 0 : 2) + (sel ? 1 : 0);
    if (strip) ctx.drawImage(strip, t.col * 26, row * 32, 26, 32, r.x, r.y, 26, 32);
    else { ctx.fillStyle = sel ? '#c6c6c6' : '#8b8b8b'; ctx.fillRect(r.x, r.y, 26, 32); }
    drawIcon(ctx, t.icon, r.x + 5, r.y + (t.top ? 9 : 7));
  }
  draw(ctx) { try { this.paint(ctx); } catch (e) { ctx.restore(); if (!this.fault) console.error(e); this.fault = true; } }
  paint(ctx) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    const x0 = this.x0, y0 = this.y0, id = this.tabDef.id;
    ctx.fillStyle = 'rgba(16,16,16,0.72)'; ctx.fillRect(0, 0, W, H);
    TABS.forEach((t, i) => { if (i !== this.tab) this.drawTab(ctx, i); });
    const bg = M(id === 'inventory' ? 'creative_inventory' : id === 'search' ? 'creative_search' : 'creative_items');
    if (bg) ctx.drawImage(bg, 0, 0, PW, PH, x0, y0, PW, PH); else { ctx.fillStyle = '#c6c6c6'; ctx.fillRect(x0, y0, PW, PH); }
    this.drawTab(ctx, this.tab);
    const useMouse = this.pm.useMouse, mouse = this.G.input ? this.G.input.mouse : null;
    const S = this.stops(), selStop = S.find((s) => s.area === this.sel.area && s.i === this.sel.i);
    const hi = (r) => { ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(r.x + 1, r.y + 1, 16, 16); if (!useMouse) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.strokeRect(r.x - 0.5, r.y - 0.5, 19, 19); } };
    if (id === 'inventory') {
      // Steve in the black box, as the survival inventory draws him
      // (at half size: Minecraft draws the player smaller in the creative tab than in the survival screen)
      const pt = A.mc.portrait;
      if (pt) { const pw = Math.round(pt.width / 2), ph = Math.round(pt.height / 2); ctx.save(); ctx.beginPath(); ctx.rect(x0 + 73, y0 + 6, 32, 43); ctx.clip(); ctx.drawImage(pt, x0 + 73 + Math.round((32 - pw) / 2), y0 + 6 + 43 - ph - 1, pw, ph); ctx.restore(); }
      this.invSlots().forEach((s, i) => {
        const st = s.get(), x = x0 + s.x, y = y0 + s.y;
        if (s.kind === 'armor' && !st) { ctx.globalAlpha = 0.35; drawIcon(ctx, ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'][i], x, y); ctx.globalAlpha = 1; }
        if (st) drawStack(ctx, st, x, y);
        if (this.sel.area === 'inv' && this.sel.i === i) hi({ x: x - 1, y: y - 1 });
      });
    } else {
      if (id !== 'search') mcText(ctx, this.tabDef.name, x0 + 8, y0 + 6, '#404040', false);
      else {
        const r = this.searchRect(), q = this.query;
        let shown = q; while (shown && mcWidth(shown) > r.w - 8) shown = shown.slice(1);
        const end = mcText(ctx, shown, r.x + 2, r.y + 2, '#ffffff', true);
        if (this.sel.area === 'search' && Math.floor(this.t * 3) % 2 === 0) mcText(ctx, '_', r.x + 2 + (shown ? end + 1 : 0), r.y + 2, '#ffffff', true);
        if (this.sel.area === 'search' && !useMouse) { ctx.strokeStyle = '#ffffff'; ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1); }
      }
      for (let i = 0; i < 45; i++) {
        const itId = this.gridItem(i), r = this.gridRect(i);
        if (itId) drawStack(ctx, { id: itId, n: 1 }, r.x + 1, r.y + 1);
        if (this.sel.area === 'grid' && this.sel.i === i) hi(r);
      }
      for (let i = 0; i < 9; i++) {
        const r = this.hotRect(i), st = this.G.inv.slots[i];
        if (st) drawStack(ctx, st, r.x + 1, r.y + 1);
        if (this.sel.area === 'hot' && this.sel.i === i) hi(r);
      }
      const sr = this.scrollRect(), can = this.maxScroll() > 0;
      const sc = M(can ? 'creative_scroller' : 'creative_scroller_disabled'), sy = sr.y + Math.round((sr.h - 15) * (can ? this.scroll / this.maxScroll() : 0));
      if (sc) ctx.drawImage(sc, sr.x, sy); else { ctx.fillStyle = can ? '#c6c6c6' : '#8b8b8b'; ctx.fillRect(sr.x, sy, 12, 15); }
    }
    if (this.sel.area === 'tab' && !useMouse) { const r = this.tabRect(this.sel.i); ctx.strokeStyle = '#ffffff'; ctx.strokeRect(r.x + 0.5, r.y + 0.5, 25, 31); }
    // the cursor stack, then the tooltip of what is under the pointer (or the key cursor)
    const px = useMouse && mouse ? mouse.x : selStop ? selStop.x + 17 : x0, py = useMouse && mouse ? mouse.y : selStop ? selStop.y + 1 : y0;
    if (this.cursor) drawStack(ctx, this.cursor, useMouse && mouse ? mouse.x - 8 : (selStop ? selStop.x + 7 : x0), useMouse && mouse ? mouse.y - 8 : (selStop ? selStop.y - 5 : y0));
    // (with the keys, the tooltip waits for the first move, so it does not cover the tab's title on opening)
    else if (selStop && (useMouse || this.keyMoved)) {
      let st = null;
      if (selStop.area === 'grid') { const g = this.gridItem(selStop.i); st = g ? { id: g, n: 1 } : null; }
      else if (selStop.area === 'hot') st = this.G.inv.slots[selStop.i];
      else if (selStop.area === 'inv') { const s = this.invSlots()[selStop.i]; st = s && s.get(); }
      if (st) drawTooltip(ctx, tooltipLines(st), px, py);
      else if (selStop.area === 'tab') drawTip(ctx, [TABS[selStop.i].name], px, py);
    }
    ctx.restore();
  }
}
