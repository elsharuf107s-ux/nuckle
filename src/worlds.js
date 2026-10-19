// The world list and the saves of generated worlds (the world update's design, 8.1 to 8.4; stage 4b).
//
//   poke-redstone-v1      localStorage   the Classic save, untouched here (main.js's saveGame / loadGame as ever)
//   poke-redstone-worlds  localStorage   the index: { v: 1, last, worlds: [{ id, name, type, seed, seedText, mode,
//                                        diff, gen, created, played, playTime, hc, bytes }] }
//   IndexedDB 'poke-redstone', store 'worlds', key <id>: a generated world's `v: 2` save, stored by structured clone
//   poke-redstone-w:<id>  localStorage   the same object as JSON when IndexedDB cannot be used (some private modes)
//
// A Classic boot loads this module only when the title's world menus open (stage 9: PRESS START, not in films).
// Every call answers (never throws): reads give null, writes { ok: false, err }.
export const LIST_KEY = 'poke-redstone-worlds';
export const CLASSIC_KEY = 'poke-redstone-v1';
const LS_PREFIX = 'poke-redstone-w:';
const DB_NAME = 'poke-redstone', STORE = 'worlds';

let dbp = null, forced = false;
// tests: force the localStorage fallback (true), or go back to IndexedDB (false)
export function useFallback(on) { forced = !!on; dbp = null; }
function db() {
  if (forced || typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbp) {
    dbp = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => { try { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); } catch (e) { /* the open fails below */ } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return dbp;
}

// ---- the index
export function readList() {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || d.v !== 1 || !Array.isArray(d.worlds)) return null;
    return d;
  } catch (e) { return null; }
}
export function writeList(d) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(d)); return true; } catch (e) { return false; }
}
export function entryOf(id) { const d = readList(); return (d && d.worlds.find((w) => w && w.id === id)) || null; }
// add or update a world's entry (fields merged) and make it the last played; the index is made on first use
export function touchEntry(id, fields) {
  const d = readList() || { v: 1, last: null, worlds: [] };
  let e = d.worlds.find((w) => w && w.id === id);
  if (!e) { e = { id }; d.worlds.push(e); }
  Object.assign(e, fields);
  d.last = id;
  return writeList(d) ? e : null;
}
// the Classic world played or saved: it becomes the last played, if there is an index at all (8.1)
export function touchClassic() {
  const d = readList();
  if (!d || d.last === 'classic') return;
  d.last = 'classic';
  writeList(d);
}
export function newId() {
  let r = '';
  try { const a = new Uint32Array(2); crypto.getRandomValues(a); r = a[0].toString(36) + a[1].toString(36); } catch (e) { r = Math.floor(Math.random() * 2 ** 32).toString(36); }
  return 'w' + Date.now().toString(36) + r.slice(0, 6);
}

// ---- the boot (7.1): a request from the title menus (stage 9), else the last played generated world
export function bootRequest() {
  try {
    const raw = sessionStorage.getItem('rs.world');
    if (raw) { sessionStorage.removeItem('rs.world'); const q = JSON.parse(raw); if (q && (q.op === 'new' || q.op === 'load')) return q; }
  } catch (e) { /* none */ }
  const d = readList();
  if (d && d.last && d.last !== 'classic' && d.worlds.some((w) => w && w.id === d.last)) return { op: 'load', id: d.last };
  return null;
}

// ---- saves
// Write a `v: 2` save. Resolves { ok, ms (main-thread time of the write call), store: 'idb' | 'ls', err }.
export async function saveWorld(id, data) {
  const conn = await db();
  if (conn) {
    try {
      const r = await new Promise((resolve) => {
        let ms = 0;
        try {
          const tx = conn.transaction(STORE, 'readwrite');
          tx.oncomplete = () => resolve({ ok: true, ms, store: 'idb' });
          tx.onerror = () => resolve({ ok: false, ms, store: 'idb', err: String(tx.error) });
          tx.onabort = () => resolve({ ok: false, ms, store: 'idb', err: String(tx.error) });
          const t0 = performance.now();
          try { tx.objectStore(STORE).put(data, id); }
          catch (e) {
            // something in the save that structured clone refuses (a function on a block): as JSON would keep it
            if (e && e.name === 'DataCloneError') tx.objectStore(STORE).put(JSON.parse(JSON.stringify(data)), id);
            else throw e;
          }
          ms = performance.now() - t0;
        } catch (e) { resolve({ ok: false, ms, store: 'idb', err: String(e) }); }
      });
      if (r.ok) { try { localStorage.removeItem(LS_PREFIX + id); } catch (e) { /* none */ } }
      return r;
    } catch (e) { return { ok: false, ms: 0, store: 'idb', err: String(e) }; }
  }
  const t0 = performance.now();
  try {
    const s = JSON.stringify(data);
    localStorage.setItem(LS_PREFIX + id, s);
    return { ok: true, ms: performance.now() - t0, store: 'ls', bytes: s.length };
  } catch (e) { return { ok: false, ms: performance.now() - t0, store: 'ls', err: String(e) }; }
}
// Read a save: IndexedDB first, then the localStorage fallback. Resolves the object or null.
export async function loadWorld(id) {
  const conn = await db();
  if (conn) {
    const v = await new Promise((resolve) => {
      try {
        const req = conn.transaction(STORE, 'readonly').objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    if (v) return v;
  }
  try { const raw = localStorage.getItem(LS_PREFIX + id); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
// Remove a world: its save in both stores and its entry (Select World's Delete, stage 9).
export async function deleteWorld(id) {
  const conn = await db();
  if (conn) await new Promise((resolve) => { try { const tx = conn.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(id); tx.oncomplete = tx.onerror = tx.onabort = () => resolve(); } catch (e) { resolve(); } });
  try { localStorage.removeItem(LS_PREFIX + id); } catch (e) { /* none */ }
  const d = readList();
  if (d) { d.worlds = d.worlds.filter((w) => w && w.id !== id); if (d.last === id) d.last = null; writeList(d); }
  return true;
}
