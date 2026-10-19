// The generator's Worker (design 10.1; stage 4a). A module Worker started by src/gen/client.js: it loads terrain.json
// itself, receives the world descriptor, computes the plan (3.11) and answers chunk requests with transferable typed
// arrays. Pure generation runs here so the game's frames never wait on it.
//
// Messages in:   { op: 'init', desc: { type, seed }, kanto?, sign? }   (kanto: a Kanto World's inputs, stage 6a: kantoZone,
//                                                               kantoGrid, kantoGround, kantoMat; see client.js)
//                                                               (sign false: no spawn sign, the films' pages)
//                { op: 'chunk', id, cx, cy }            overworld-local data chunk (0..49)
// Messages out:  { op: 'plan', json, hash, ms, warnings, coarse } | { op: 'error', msg }   (coarse: { n, st, code },
//                the minimap's coarse colours)
//                { op: 'sign', sign, warn, ms }   a Kanto World only, right after the plan (sign.js kantoSigns)
//                { op: 'chunk', id, cx, cy, tile, ground, deco, biome, ms, err? }
// Never throws to the game (3.0 rule 6): a chunk that fails comes back as a fallback chunk (plain grass, zone 0
// inside the border) with the error's text, which the client puts in G.errors.
import { makeGen, paintChunk, makePlan } from './index.js';
import { kantoSigns, coarseCode } from './sign.js';   // (the Kanto signpost and the minimap's coarse colours)

let g = null;

function fallbackChunk() {
  const n = 32 * 32, tile = new Uint16Array(n).fill(1), ground = new Uint16Array(n).fill(1);
  return { tile, ground, deco: new Uint8Array(n), biome: new Uint8Array(n).fill(1) };
}

async function init(desc, kanto) {
  const url = new URL('../../assets/world/terrain.json', import.meta.url);
  const r = await fetch(url);
  if (!r.ok) throw new Error('terrain.json ' + r.status);
  const terrain = await r.json();
  const t0 = performance.now();
  g = makeGen({ type: desc.type, seed: desc.seed }, { terrain, cache: true, ...(kanto || {}) });
  const plan = makePlan(g);
  const ms = performance.now() - t0, warnings = plan.warnings.slice();
  // beside the plan, never inside its hashed JSON (minimap design 2.4): the coarse grid as one byte per point for the
  // minimap (a throw is a warning, never a failed plan)
  let coarse = null;
  try { coarse = coarseCode(plan.cm); } catch (e) { coarse = null; warnings.push('the coarse grid: ' + String((e && e.message) || e)); }
  return { out: { json: plan.json, hash: plan.hash, warnings, ms, coarse }, plan };
}

// A Kanto World's spawn sign (sign.js), posted after the plan so the page builds its World meanwhile (it waits for it
// before the first chunk is applied); after makePlan has attached the stamps, so its paint equals the chunks'. A throw
// is a warning and no sign.
function signOf(plan) {
  const t0 = performance.now();
  let sign = null, warn = [];
  try { sign = kantoSigns(g, plan); if (sign) warn = sign.warn.slice(); }
  catch (e) { sign = null; warn = ['the Kanto sign: ' + String((e && e.message) || e)]; }
  return { op: 'sign', sign, warn, ms: performance.now() - t0 };
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  if (m.op === 'init') {
    let p;
    try { p = await init(m.desc, m.kanto); self.postMessage({ op: 'plan', ...p.out }, p.out.coarse ? [p.out.coarse.code.buffer] : []); }
    catch (e) { self.postMessage({ op: 'error', msg: String((e && e.stack) || e) }); return; }
    if (g.type === 'kanto' && m.sign !== false) self.postMessage(signOf(p.plan));
    return;
  }
  if (m.op === 'chunk') {
    const t0 = performance.now();
    let res, err = null;
    try {
      const p = paintChunk(g, m.cx, m.cy);
      res = { tile: p.tile, ground: p.ground, deco: p.deco, biome: p.biome };
    } catch (e) { err = 'gen chunk ' + m.cx + ',' + m.cy + ': ' + String((e && e.stack) || e); res = fallbackChunk(); }
    const out = { op: 'chunk', id: m.id, cx: m.cx, cy: m.cy, ...res, ms: performance.now() - t0, err };
    self.postMessage(out, [res.tile.buffer, res.ground.buffer, res.deco.buffer, res.biome.buffer]);
  }
};
