// The main thread's side of the generator (design 10.1; stage 4a). Starts src/gen/worker.js, gets the plan, sends
// chunk requests and hands the results to the streaming code (src/chunks.js). Without a Worker (an old browser, a
// worker that failed) the same modules run here: the plan once, then chunks one at a time (`sync`), which gives the
// same arrays (the generator is a pure function of the descriptor; tools/gen_tests/stream.mjs compares them).
//
//   const gen = await startGen(desc, terrain)     desc = { type: 'wild' | 'kanto', seed } (seed: an int32); a Kanto
//                                                  World also needs desc.kanto = { kantoZone, kantoGrid, kantoGround,
//                                                  kantoMat } (Classic's arrays for Kanto's block, stage 6a)
//   gen.plan, gen.hash, gen.planMs, gen.worker     the plan's JSON (maps annotated with their biome ids)
//   gen.request(cx, cy)                            overworld-local data chunk; the result lands in gen.results
//   gen.sync(cx, cy)                               a chunk painted here, now (the fallback and 2.13's last resort)
//   gen.inFlight                                   requests not answered yet
//   gen.signP                                      a Kanto World: a promise of its spawn sign (sign.js kantoSigns, the
//                                                  worker's answer after the plan; null on any failure), else null;
//   gen.sign                                       the sign once it has come
//   gen.coarse                                     the plan's coarse grid for the minimap, { n, st, code }, or null
import { makeGen, paintChunk, makePlan, attachPlan } from './index.js';
import { kantoSigns, coarseCode } from './sign.js';   // (the Kanto signpost and the minimap's coarse colours)
import { BIOMES } from './biomes.js';
import { seedFromText } from './hash.js';

// The world seed for typed text (7.4): blank is random (crypto), digits are the number, other text String.hashCode.
export function seedOf(text) {
  const s = seedFromText(text);
  if (s !== null) return s;
  try { const a = new Int32Array(1); crypto.getRandomValues(a); return a[0]; } catch (e) { return (Date.now() ^ Math.floor(performance.now() * 1000)) | 0; }
}

export async function startGen(desc, terrain, opts = {}) {
  const gen = {
    desc, plan: null, hash: null, planMs: 0, worker: false, results: [], inFlight: 0, errors: [], requested: 0,
    request: null, sync: null, mainGen: null, workerMs: [], sign: null, signP: null, signMs: 0, coarse: null,
  };
  // a Kanto World's sign: resolved once, by the worker's message, its failure or the fallback below
  let signDone = null;
  // (not under ?video, the films' pages, unless &signs: their worker's timeline stays as it was; main.js installs none)
  const qs = (globalThis.location && globalThis.location.search) || '';
  const noSign = opts.sign === false || (/[?&]video(&|=|$)/.test(qs) && !/[?&]signs(&|=|$)/.test(qs));
  if (desc.type === 'kanto' && !noSign) {
    gen.signP = new Promise((resolve) => { signDone = (s, ms) => { if (!signDone) return; signDone = null; gen.sign = s || null; gen.signMs = ms || 0; resolve(gen.sign); }; });
  }
  const signed = (s, ms) => { if (signDone) signDone(s, ms); };
  const onSign = (m) => { if (m.warn && m.warn.length) gen.warnings.push(...m.warn); signed(m.sign, m.ms); };
  // the main thread's own generator, built when first needed (from the plan's thresholds, so no coarse pass)
  const main = () => {
    if (!gen.mainGen) {
      const kin = desc.kanto ? { ...desc.kanto, kantoAt: { kx: gen.plan.kanto.x, ky: gen.plan.kanto.y } } : {};
      gen.mainGen = makeGen({ type: desc.type, seed: desc.seed }, { terrain, th: gen.plan.th, cache: true, ...kin });
      attachPlan(gen.mainGen, gen.plan);
    }
    return gen.mainGen;
  };
  gen.sync = (cx, cy) => {
    let p;
    try { p = paintChunk(main(), cx, cy); }
    catch (e) {
      gen.errors.push('gen chunk ' + cx + ',' + cy + ': ' + String((e && e.stack) || e));
      const n = 1024;
      p = { tile: new Uint16Array(n).fill(1), ground: new Uint16Array(n).fill(1), deco: new Uint8Array(n), biome: new Uint8Array(n).fill(1) };
    }
    return { cx, cy, tile: p.tile, ground: p.ground, deco: p.deco, biome: p.biome };
  };

  let w = null;
  if (opts.worker !== false && typeof Worker === 'function') {
    try { w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch (e) { w = null; }
  }
  if (w) {
    const t0 = performance.now();
    const planned = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), opts.planTimeout || 20000);
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.op === 'plan') { clearTimeout(timer); resolve(m); }
        else if (m.op === 'sign') onSign(m);
        else if (m.op === 'error') { clearTimeout(timer); gen.errors.push(m.msg); resolve(null); }
      };
      w.onerror = (e) => { clearTimeout(timer); gen.errors.push('worker: ' + (e && e.message)); resolve(null); };
      w.postMessage({ op: 'init', desc: { type: desc.type, seed: desc.seed }, kanto: desc.kanto || null, sign: !noSign });
    });
    if (planned) {
      gen.plan = planned.json; gen.hash = planned.hash; gen.planMs = planned.ms; gen.planWall = performance.now() - t0; gen.worker = true;
      gen.warnings = planned.warnings || [];
      gen.coarse = planned.coarse || null;
      if (signDone) setTimeout(() => signed(null, 0), opts.planTimeout || 20000);   // (a sign that never comes: none)
    } else { try { w.terminate(); } catch (e) { /* gone */ } w = null; }
  }
  if (!gen.plan) {
    // no worker: the plan here, once (behind the loading screen)
    const t0 = performance.now();
    const g = makeGen({ type: desc.type, seed: desc.seed }, { terrain, cache: true, ...(desc.kanto || {}) });
    const p = makePlan(g);
    gen.plan = p.json; gen.hash = p.hash; gen.planMs = performance.now() - t0; gen.mainGen = g; gen.warnings = p.warnings.slice();
    // (as the worker does: beside the plan, a throw is a warning)
    if (g.type === 'kanto' && !noSign) {
      const t1 = performance.now();
      let sg = null;
      try { sg = kantoSigns(g, p); if (sg && sg.warn.length) gen.warnings.push(...sg.warn); }
      catch (e) { sg = null; gen.warnings.push('the Kanto sign: ' + String((e && e.message) || e)); }
      signed(sg, performance.now() - t1);
    }
    try { gen.coarse = coarseCode(p.cm); } catch (e) { gen.coarse = null; }
  }
  // each biome map knows its biome id (the painter's output), for the cells' `area`
  const byKey = new Map(BIOMES.map((b) => ['GEN_' + b.key, b.id]));
  for (const m of gen.plan.maps) if (m.gen && !m.room && byKey.has(m.id)) m.biomeId = byKey.get(m.id);

  if (w) {
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.op === 'sign') { onSign(m); return; }
      if (m.op !== 'chunk') return;
      gen.inFlight = Math.max(0, gen.inFlight - 1);
      if (m.err) gen.errors.push(m.err);
      gen.workerMs.push(m.ms);
      if (gen.workerMs.length > 400) gen.workerMs.shift();
      gen.results.push({ cx: m.cx, cy: m.cy, tile: m.tile, ground: m.ground, deco: m.deco, biome: m.biome });
    };
    w.onerror = (e) => {
      // the worker died: everything from now on is generated here (the streaming re-requests what was in flight)
      gen.errors.push('worker: ' + (e && e.message));
      gen.worker = false; gen.inFlight = 0; gen.lost = true;
      signed(null, 0);   // (a worker that died before its sign: no sign)
      try { w.terminate(); } catch (err) { /* gone */ }
    };
    gen.request = (cx, cy) => {
      if (!gen.worker) return false;
      gen.inFlight++; gen.requested++;
      w.postMessage({ op: 'chunk', id: gen.requested, cx, cy });
      return true;
    };
  } else gen.request = () => false;
  gen.terminate = () => { signed(null, 0); if (w) try { w.terminate(); } catch (e) { /* gone */ } };
  return gen;
}
