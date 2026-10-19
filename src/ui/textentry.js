// The page-level text box for the world menus' text fields (design 7.5): World Name, Seed and the creative Search.
// Like co-op's JOIN box it is a real <input> over the canvas, so a phone's keyboard works and input.js leaves the keys
// alone (it ignores keys typed into an INPUT). The field has autocapitalize, autocorrect, autocomplete and spellcheck
// off, so an iPhone cannot turn "hello" into "Hello" and so into a different world.
//
//   openTextEntry({ label, value, maxLength, rect, onInput, onDone, onCancel }) -> { close(commit) }
//
// rect is the canvas field's box in canvas pixels; the overlay sits over it, or just above it with above: true (and is
// at least 260 CSS px wide). Enter or OK commits (onDone(value)), Escape or Cancel cancels (onCancel()), a tap outside
// commits; on the touch pad B cancels and the other buttons commit, and that tap never reaches the game. onInput(value)
// fires as the player types (the creative search filters live). Only one box is open at a time; opening another commits
// the first. On an iPhone the keyboard rises only when this is called inside a touch handler: the screens open it from
// touchend through mcgui.js claimTouch (a tap on the field), and from the game tick only for A on a focused field.

const ID = 'rs-text-entry';
const CSS = `
#${ID} { position: fixed; z-index: 30; box-sizing: border-box; padding: 6px; background: rgba(0,0,0,.82); border: 1px solid #a0a0a0;
  font: 16px ui-monospace, Menlo, monospace; color: #e0e0e0; }
#${ID} label { display: block; font-size: 12px; color: #a0a0a0; margin: 0 0 4px 2px; }
#${ID} .row { display: flex; gap: 6px; }
#${ID} input { flex: 1; min-width: 0; box-sizing: border-box; padding: 6px 8px; border: 1px solid #ffffff; background: #000000;
  color: #e0e0e0; font: 16px ui-monospace, Menlo, monospace; border-radius: 0; outline: none; -webkit-appearance: none; }
#${ID} button { padding: 0 10px; border: 1px solid #000; background: #6f6f6f; color: #ffffff; font: 600 13px ui-monospace, Menlo, monospace;
  border-radius: 0; box-shadow: inset 1px 1px 0 #a8a8a8, inset -1px -1px 0 #4a4a4a; cursor: pointer; -webkit-tap-highlight-color: transparent; }
#${ID} button.cancel { background: #4f4f4f; }
`;
let current = null;

function style() {
  if (document.getElementById(ID + '-style')) return;
  const s = document.createElement('style'); s.id = ID + '-style'; s.textContent = CSS;
  document.head.appendChild(s);
}
function canvasRect() {
  const c = document.getElementById('game');
  return c ? c.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
}
export const textEntryOpen = () => !!current;
export function closeTextEntry(commit = true) { if (current) current.close(commit); }

export function openTextEntry({ label = '', value = '', maxLength = 32, rect = null, above = false, onInput = null, onDone = null, onCancel = null, canvasW = 480, selectAll = false } = {}) {
  if (current) current.close(true);
  style();
  const r = canvasRect(), scale = r.width / canvasW;
  const div = document.createElement('div');
  div.id = ID;
  const w = Math.round(Math.min(innerWidth - 16, Math.max(260, rect ? rect.w * scale + 120 : 300)));
  let left = rect ? r.left + (rect.x + rect.w / 2) * scale - w / 2 : r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(innerWidth - w - 8, left));
  // over the field, but never lower than the canvas's top third on a phone (the keyboard rises from the bottom)
  let top = rect ? r.top + rect.y * scale - 22 : r.top + r.height * 0.2;
  top = Math.max(8, Math.min(top, Math.max(8, r.top + r.height * 0.34)));
  Object.assign(div.style, { left: Math.round(left) + 'px', top: Math.round(top) + 'px', width: w + 'px' });
  const form = document.createElement('form');
  form.autocomplete = 'off'; form.noValidate = true;
  if (label) { const l = document.createElement('label'); l.htmlFor = ID + '-in'; l.textContent = label; form.appendChild(l); }
  const row = document.createElement('div'); row.className = 'row';
  const inp = document.createElement('input');
  inp.id = ID + '-in'; inp.type = 'text'; inp.maxLength = maxLength; inp.value = String(value || '').slice(0, maxLength);
  for (const [k, v] of Object.entries({ autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done', inputmode: 'text' })) inp.setAttribute(k, v);
  if (label) inp.setAttribute('aria-label', label);
  const ok = document.createElement('button'); ok.type = 'submit'; ok.textContent = 'OK';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'cancel'; cancel.textContent = 'Cancel';
  row.append(inp, ok, cancel); form.appendChild(row); div.appendChild(form);
  document.body.appendChild(div);
  // above: the box sits just above rect (the creative search keeps its results in view while you type)
  if (above && rect) div.style.top = Math.round(Math.max(8, r.top + rect.y * scale - div.offsetHeight - 6)) + 'px';

  let closed = false;
  // A tap outside the box commits it. A tap on the touch pad answers the box and goes no further (capture phase, before
  // the pad's own pointerdown), so the game never sees it: B cancels, every other pad button commits (7.5: "B cancels").
  const outside = (e) => {
    if (div.contains(e.target)) return;
    const pad = document.getElementById('pad'), btn = pad && e.target && e.target.closest ? e.target.closest('#pad [data-k]') : null;
    if (btn || (pad && pad.contains(e.target))) {
      e.stopPropagation(); e.preventDefault();
      handle.close(!(btn && btn.dataset.k === 'b'));
      return;
    }
    handle.close(true);
  };
  const handle = {
    el: div, input: inp,
    close(commit) {
      if (closed) return;
      closed = true;
      document.removeEventListener('pointerdown', outside, true);
      const v = inp.value.slice(0, maxLength);
      if (div.contains(document.activeElement)) document.activeElement.blur();
      div.remove();
      if (current === handle) current = null;
      try { if (commit) { if (onDone) onDone(v); } else if (onCancel) onCancel(); } catch (e) { console.error(e); }
    },
  };
  current = handle;
  setTimeout(() => { if (!closed) document.addEventListener('pointerdown', outside, true); }, 0);
  inp.addEventListener('input', () => { try { if (onInput) onInput(inp.value.slice(0, maxLength)); } catch (e) { console.error(e); } });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); handle.close(false); } });
  cancel.addEventListener('click', () => handle.close(false));
  form.addEventListener('submit', (e) => { e.preventDefault(); handle.close(true); });
  inp.focus();
  // (playfix: selectAll opens with the whole value selected, so the first key replaces it, as on a phone's rename)
  try { if (selectAll) inp.select(); else inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { /* not every input type allows it */ }
  return handle;
}
