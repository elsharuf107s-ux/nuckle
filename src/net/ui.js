// Co-op menus and overlays. Loaded only when a player opens the CO-OP menu, hosts or joins.
//   - START > CO-OP: HOST / JOIN / CANCEL (single-player), CODE / CLOSE / CANCEL (hosting), LEAVE / CANCEL (a guest)
//   - the room code box (FireRed window) with COPY and, where the browser can, SHARE
//   - the page-level text overlay: the room code and a name (JOIN), a chat line (T, or CHAT on the phone pad);
//     real page inputs, so phone keyboards work and src/input.js leaves the keys alone while typing
//   - Minecraft's chat at the bottom left, join and leave lines in yellow
//   - "Joining..." while a guest boots, "Waiting for the host..." while the host is away
// Player-visible text has no em dashes: FireRed voice for menus, Minecraft voice for chat.
import { G } from '../game.js';
import { NET } from './flag.js';
import { drawText, textWidth } from '../font.js';
import { mcText, mcWidth } from '../mcfont.js';
import { VW, VH, FG, SH, drawWindow, cursorArrow, wrap, drawMessage } from '../ui.js';
import { HW, HH } from '../hud.js';
import { TEXT, SKINS } from './room.js';
import * as S from './session.js';
import { APP, SITE } from '../app.js';

const B = () => NET.bridge;
const ui = { mode: null, items: [], cursor: 0, text: '', flash: 0, from: 'play', t: 0, err: null };
NET.ui = { update, draw, full, info, drawHud: (ctx, s, st, tb) => drawHud(ctx, s, st, tb) };

const HINT = {
  HOST: 'Open your world to friends.', JOIN: "Join a friend's world.", CODE: 'Show the room code.',
  CLOSE: 'Close the room.', LEAVE: 'Go back to your own world.', CANCEL: 'Close this menu window.',
};
function report(e) { G.errors = G.errors || []; const m = 'net ui: ' + String((e && e.stack) || e); if (!G.errors.includes(m) && G.errors.length < 30) G.errors.push(m); }

// ------------------------------------------------------------ entry
export function open(what, arg) {
  if (what === 'menu') { openMenu(); return; }
  if (what === 'join') { openJoin(arg || {}); return; }
  if (what === 'code') { ui.mode = 'code'; ui.cursor = 0; return; }
}
function openMenu() {
  ui.items = NET.host && NET.on ? ['CODE', 'CLOSE', 'CANCEL'] : NET.guest ? ['LEAVE', 'CANCEL'] : ['HOST', 'JOIN', 'CANCEL'];
  ui.mode = 'menu'; ui.cursor = 0;
}
function back(to = 'play') { ui.mode = null; B().setState(to); }

function pick(it) {
  const br = B();
  if (it === 'CANCEL') { back('menu'); return; }
  if (it === 'HOST') {
    ui.mode = 'wait'; ui.text = 'Opening a room...';
    S.startHost('STEVE').then(() => { ui.mode = 'code'; ui.cursor = 0; }, () => {
      const r = NET.last;
      ui.mode = null; br.setState('play');
      br.say((r && r.error && r.error.text) || TEXT.busy);
    });
    return;
  }
  if (it === 'JOIN') {
    ui.mode = null; br.setState('play');
    br.ask('Your unsaved progress will be lost. Join anyway?', () => { br.setState('coop'); ui.mode = 'overlay'; openJoin({ from: 'play' }); }, () => {});
    return;
  }
  if (it === 'CODE') { ui.mode = 'code'; ui.cursor = 0; return; }
  if (it === 'CLOSE') {
    ui.mode = null; br.setState('play');
    br.ask('Your friends will leave the game. Close the room?', () => { if (NET.s) NET.s.close(); br.say('The room is closed.'); }, () => {});
    return;
  }
  if (it === 'LEAVE') { ui.mode = 'wait'; ui.text = 'Leaving...'; if (NET.s) NET.s.leave(); }
}

// ------------------------------------------------------------ the 'coop' state (main.js update and draw)
function codeItems() { return ['COPY', ...(typeof navigator !== 'undefined' && navigator.share ? ['SHARE'] : []), 'OK']; }
function update(dt, input) {
  ui.t += dt;
  if (ui.flash > 0) ui.flash -= dt;
  try {
    if (ui.mode === 'menu') {
      const n = ui.items.length;
      if (input.just('up')) ui.cursor = (ui.cursor + n - 1) % n;
      if (input.just('down')) ui.cursor = (ui.cursor + 1) % n;
      if (input.just('b') || input.just('start')) { back('menu'); return; }
      if (input.just('a')) pick(ui.items[ui.cursor]);
      return;
    }
    if (ui.mode === 'code') {
      const items = codeItems(), n = items.length;
      if (input.just('up')) ui.cursor = (ui.cursor + n - 1) % n;
      if (input.just('down')) ui.cursor = (ui.cursor + 1) % n;
      if (input.just('b') || input.just('start')) { back('play'); return; }
      if (!input.just('a')) return;
      const it = items[Math.min(ui.cursor, n - 1)], code = NET.room && NET.room.code;
      if (it === 'OK') { back('play'); return; }
      if (it === 'COPY' && code) {
        const ok = () => { ui.flash = 1.5; ui.flashText = 'Copied!'; };
        try { navigator.clipboard.writeText(code).then(ok, () => { ui.flash = 1.5; ui.flashText = code; }); } catch (e) { ui.flash = 1.5; ui.flashText = code; }
      }
      if (it === 'SHARE' && code) {
        try { navigator.share({ text: `Join my world. Code ${code}`, url: (APP && SITE ? SITE + '/' : location.origin + location.pathname) + '?join=' + code }).catch(() => {}); } catch (e) { /* not shared */ }
      }
      return;
    }
    if (ui.mode === 'failed') { if (ui.t > 0.4 && (input.just('a') || input.just('b') || input.just('start'))) S.goHome(null); return; }
    if (ui.mode === 'overlay' && !document.getElementById('coop-join')) back('play');
  } catch (e) { report(e); }
}
function full() { return ui.mode === 'joining' || ui.mode === 'failed'; }

function draw(ctx) {
  try {
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    if (ui.mode === 'menu') {
      const x = VW - 80, w = 80, h = ui.items.length * 16 + 12;
      drawWindow(ctx, x, 0, w, h);
      ui.items.forEach((it, i) => { drawText(ctx, it, x + 18, 6 + i * 16, FG, SH); if (i === ui.cursor) cursorArrow(ctx, x + 9, 9 + i * 16); });
      drawWindow(ctx, 0, VH - 32, VW, 32);
      drawText(ctx, HINT[ui.items[ui.cursor]] || '', 10, VH - 24, FG, SH);
    } else if (ui.mode === 'code') {
      // the code big in the middle of a FireRed window; COPY, SHARE and OK under it on the right
      const code = (NET.room && NET.room.code) || '?????', n = NET.s ? NET.s.avatars.size : 0;
      drawWindow(ctx, 8, 6, VW - 16, 84);
      drawText(ctx, 'Room code:', 20, 14, FG, SH);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      mcText(ctx, code, Math.round(HW / 2 - mcWidth(code, 4) / 2), 60, '#383838', false, 4);
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      drawText(ctx, ui.flash > 0 ? ui.flashText : 'Tell your friends this code.', 20, 52, FG, SH);
      drawText(ctx, n === 1 ? '1 friend is here.' : `${n} friends are here.`, 20, 68, '#707070', SH);
      const items = codeItems(), h = items.length * 16 + 12, x = VW - 72, y = VH - h - 4;
      drawWindow(ctx, x, y, 72, h);
      items.forEach((it, i) => { drawText(ctx, it, x + 18, y + 6 + i * 16, FG, SH); if (i === Math.min(ui.cursor, items.length - 1)) cursorArrow(ctx, x + 9, y + 9 + i * 16); });
    } else if (ui.mode === 'wait') {
      drawMessage(ctx, [ui.text], 999, false, ui.t);
    } else if (ui.mode === 'joining' || ui.mode === 'failed') {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, HW, HH);
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      const lines = wrap(ui.mode === 'failed' ? ui.err : ui.text, VW - 28).slice(0, 2);
      drawMessage(ctx, lines, 999, ui.mode === 'failed', ui.t);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } catch (e) { report(e); }
}

// guest boot screens (session.js)
export function joining(text) { ui.mode = 'joining'; ui.text = text; ui.t = 0; }
export function joinFailed(text) { ui.mode = 'failed'; ui.err = text || TEXT.lost; ui.t = 0; if (B()) B().setState('coop'); }
export function joined() { ui.mode = null; }

// ------------------------------------------------------------ chat and the waiting box (drawn over the world)
const CHAT_W = 204, LINE_H = 9;
// (no chat over FireRed's own windows: a message box, a container, a menu, the death screen)
const NO_CHAT = new Set(['msg', 'screen', 'menu', 'dead', 'coop']);
export function drawHud(ctx, s, state, toastBottom = 0) {
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const box = document.getElementById('coop-chat'), open = !!box;
    const now = G.clock, rows = [];
    for (let i = s.lines.length - 1; i >= 0 && rows.length < 10 && (open || !NO_CHAT.has(state)); i--) {
      const l = s.lines[i], age = now - l.at;
      if (!open && age > 10) break;
      const a = open ? 1 : Math.min(1, Math.max(0, (10 - age) / 1));
      // long lines wrap inside the chat's width (Minecraft's own wrapping)
      const parts = wrapMc(l.text, CHAT_W - 4);
      for (let k = parts.length - 1; k >= 0 && rows.length < 10; k--) rows.push({ text: parts[k], color: l.color, a });
    }
    // closed: above the action bar's line; open: just above the chat field (wherever the page put it)
    let bottom = HH - 66;
    if (open) {
      bottom = HH - 30;
      try { const r = canvasRect(), b = box.getBoundingClientRect(); if (r.height > 0 && b.height > 0) bottom = Math.min(HH - 2, Math.round(((b.top - r.top) * HH) / r.height) - 1); } catch (e) { /* layout not ready */ }
    }
    rows.forEach((r, i) => {
      const y = bottom - (i + 1) * LINE_H;
      ctx.globalAlpha = r.a;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(2, y, CHAT_W, LINE_H);
      mcText(ctx, r.text, 4, y + 1, r.color, true);
    });
    ctx.globalAlpha = 1;
    const room = s.room;
    let wait = null;
    if (s.role === 'guest' && room && room.hostAway && s.joined) wait = 'Waiting for the host...';
    else if (room && room.status === 'reconnecting' && (s.joined || s.role === 'host')) wait = 'Reconnecting...';
    if (wait && state !== 'msg') {
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      // (below the advancement toasts and the boss bar, which stack from the top)
      const w = textWidth(wait) + 28, y = Math.max(4, Math.ceil(toastBottom / 2) + 2);
      drawWindow(ctx, Math.round(VW / 2 - w / 2), y, w, 30);
      drawText(ctx, wait, Math.round(VW / 2 - w / 2) + 14, y + 8, FG, SH);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  } catch (e) { report(e); }
}
function wrapMc(text, maxW) {
  if (mcWidth(text) <= maxW) return [text];
  const out = [];
  let line = '';
  for (const w of text.split(' ')) {
    const cand = line ? line + ' ' + w : w;
    if (line && mcWidth(cand) > maxW) { out.push(line); line = w; } else line = cand;
    while (mcWidth(line) > maxW && line.length > 1) { let k = line.length - 1; while (k > 1 && mcWidth(line.slice(0, k)) > maxW) k--; out.push(line.slice(0, k)); line = line.slice(k); }
  }
  if (line) out.push(line);
  return out;
}

// ------------------------------------------------------------ page-level overlays
const CSS = `
.coop-ov { position: fixed; z-index: 20; font: 16px ui-monospace, Menlo, monospace; color: #e6e6e6; }
.coop-ov form { background: #1d1d1d; border: 1px solid #3a3a3a; border-radius: 8px; padding: 14px 16px; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
.coop-ov .t { font-size: 13px; letter-spacing: .06em; color: #c4c4c4; margin-bottom: 10px; }
.coop-ov label { display: block; font-size: 12px; color: #8c8c8c; margin: 8px 0 4px; }
.coop-ov input, .coop-ov select { box-sizing: border-box; width: 100%; padding: 7px 9px; border: 1px solid #3a3a3a; border-radius: 6px; background: #262626; color: #e6e6e6; font: 16px ui-monospace, Menlo, monospace; }
.coop-ov input:focus, .coop-ov select:focus { outline: none; border-color: #7a7a7a; }
.coop-ov #coop-code { text-transform: uppercase; letter-spacing: .3em; }
.coop-ov .err { min-height: 16px; margin-top: 8px; font-size: 12px; color: #ff8a80; }
.coop-ov .b { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.coop-ov button { padding: 7px 14px; border: 0; border-radius: 6px; background: #3a3a3a; color: #e6e6e6; font: 600 13px ui-monospace, Menlo, monospace; cursor: pointer; }
.coop-ov button[type=submit] { background: #5a3a3a; }
.coop-ov button:disabled { opacity: .6; cursor: default; }
#coop-chat form { padding: 4px; border-radius: 4px; background: rgba(0,0,0,.6); border: 0; box-shadow: none; }
#coop-chat input { border: 0; background: transparent; padding: 4px 6px; }
#coop-chatbtn { position: absolute; right: 18px; bottom: 86px; pointer-events: auto; width: 56px; height: 30px; border: 0; border-radius: 8px; background: #3a3a3a; color: #ddd; font: 700 11px ui-monospace, monospace; -webkit-tap-highlight-color: transparent; touch-action: none; user-select: none; }
`;
function style() {
  if (document.getElementById('coop-style')) return;
  const s = document.createElement('style'); s.id = 'coop-style'; s.textContent = CSS;
  document.head.appendChild(s);
}
function canvasRect() { const c = document.getElementById('game'); return c ? c.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight }; }
function closeOverlay(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.contains(document.activeElement)) document.activeElement.blur();
  el.remove();
}
function escHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// JOIN: the room code, a name (blank: the skin's name) and, if wanted, a skin
export function openJoin({ code = '', from = null } = {}) {
  style();
  closeOverlay('coop-join');
  const r = canvasRect();
  const div = document.createElement('div');
  div.id = 'coop-join'; div.className = 'coop-ov';
  const w = Math.min(320, innerWidth - 24);
  div.style.left = Math.round(Math.max(12, r.left + r.width / 2 - w / 2)) + 'px';
  div.style.top = Math.round(Math.max(12, r.top + Math.min(r.height * 0.12, 60))) + 'px';
  div.style.width = w + 'px';
  let saved = '';
  try { saved = localStorage.getItem('rs.coop.name') || ''; } catch (e) { /* none */ }
  const label = (s) => s[0].toUpperCase() + s.slice(1);
  div.innerHTML = `<form autocomplete="off" novalidate>
    <div class="t">JOIN A FRIEND'S WORLD</div>
    <label for="coop-code">Enter the room code.</label>
    <input id="coop-code" name="code" maxlength="5" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="next" value="${escHtml(code)}">
    <label for="coop-name">What's your name?</label>
    <input id="coop-name" name="name" maxlength="10" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="ALEX" value="${escHtml(saved)}">
    <label for="coop-skin">Look</label>
    <select id="coop-skin" name="skin"><option value="">Any (next free)</option>${SKINS.slice(1).map((s) => `<option value="${s}">${label(s)}</option>`).join('')}</select>
    <div class="err" role="status"></div>
    <div class="b"><button type="button" class="cancel">CANCEL</button><button type="submit">JOIN</button></div>
  </form>`;
  document.body.appendChild(div);
  const form = div.querySelector('form'), codeIn = form.code, nameIn = form.name, skinIn = form.skin, err = div.querySelector('.err');
  const done = () => {
    closeOverlay('coop-join');
    document.removeEventListener('pointerdown', outside, true);
    if (ui.mode === 'overlay') back(from || 'play');
  };
  const outside = (e) => { if (!div.contains(e.target)) done(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  skinIn.addEventListener('change', () => { nameIn.placeholder = skinIn.value ? skinIn.value.toUpperCase() : 'ALEX'; });
  codeIn.addEventListener('input', () => { const v = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); if (v !== codeIn.value) codeIn.value = v; });
  div.querySelector('.cancel').addEventListener('click', done);
  // (Escape stops here: on LOOK, a select, input.js would also take it as the game's B once JOIN has closed)
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } });
  codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameIn.focus(); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const bad = S.requestJoin(codeIn.value, nameIn.value, skinIn.value);
    if (bad) { err.textContent = bad === TEXT.badname ? 'Names are 1 to 10 letters (A to Z) or numbers.' : 'Enter the 5-letter room code.'; return; }
    err.textContent = 'Joining...';
    for (const b of form.querySelectorAll('button')) b.disabled = true;
  });
  (code ? nameIn : codeIn).focus();
}

// chat: T (or CHAT on the phone pad) opens a line at the bottom left; Enter sends, Escape closes
export function openChat() {
  if (!NET.s || !NET.on || document.getElementById('coop-chat')) return;
  if (NET.s.role === 'guest' && !NET.s.joined) return;
  style();
  const r = canvasRect(), scale = r.width / HW;
  const div = document.createElement('div');
  div.id = 'coop-chat'; div.className = 'coop-ov';
  div.style.left = Math.round(r.left + 2 * scale) + 'px';
  div.style.width = Math.round(Math.max(200, Math.min(r.width * 0.7, innerWidth - 16))) + 'px';
  div.style.top = Math.round(Math.min(innerHeight - 52, r.top + r.height - 30 * scale)) + 'px';
  div.innerHTML = '<form autocomplete="off"><input id="coop-chat-in" name="t" maxlength="100" enterkeyhint="send" autocorrect="off" aria-label="Chat"></form>';
  document.body.appendChild(div);
  const form = div.querySelector('form'), inp = form.t;
  const done = () => { closeOverlay('coop-chat'); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!div.contains(e.target) && e.target.id !== 'coop-chatbtn') done(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); done(); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); const t = inp.value; done(); if (t.trim() && NET.s) NET.s.sendChat(t); });
  inp.focus();
}
// T opens the chat while playing (input.js does not map T, and ignores keys typed into the field)
window.addEventListener('keydown', (e) => {
  if ((e.key !== 't' && e.key !== 'T') || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (!NET.on || !NET.s || !B() || B().state() !== 'play') return;
  e.preventDefault();
  openChat();
});
// the phone pad's CHAT button, while a room is open
export function chatButton(on) {
  try {
    const old = document.getElementById('coop-chatbtn');
    if (!on) { if (old) old.remove(); closeOverlay('coop-chat'); return; }
    if (old) return;
    // above the A and B buttons (the pad's row has no room left on a narrow phone)
    const pad = document.getElementById('pad');
    if (!pad) return;
    style();
    const b = document.createElement('button');
    b.id = 'coop-chatbtn'; b.type = 'button'; b.textContent = 'CHAT';
    b.addEventListener('click', (e) => { e.preventDefault(); if (B() && B().state() === 'play') openChat(); });
    pad.appendChild(b);
  } catch (e) { report(e); }
}

// ------------------------------------------------------------ tests
function info() {
  return { mode: ui.mode, items: ui.items.slice(), cursor: ui.cursor, text: ui.text, err: ui.err, join: !!document.getElementById('coop-join'), chat: !!document.getElementById('coop-chat'), chatButton: !!document.getElementById('coop-chatbtn') };
}
export function testDo(what) {
  if (what === 'openChat') { openChat(); return !!document.getElementById('coop-chat'); }
  return null;
}
