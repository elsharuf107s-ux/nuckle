// Stage 4a in the game: a Wild World booted, streamed and walked (design 13, 4a; 2.4 to 2.10).
//
//   node tools/headless.mjs tools/gen_tests/stream.mjs --params '?new&play&world=wild&wseed=1' --port 5610 --out <dir>
//
// Checks: the boot (the plan's spawn, its 3 x 3 chunks ready, the worker); the decoration codes of world.js and the
// generator agree; chunks made by the worker equal chunks painted on the main thread and in Node (hash over tile,
// ground and decorations); a 600-cell sprint-speed glide and a zigzag never stand on, or show, an unready chunk; the
// biome banner follows the 8-step tracker; regionKey culling; overrides on unready chunks wait for their chunk;
// decorations read as frozen blocks and their removal is recorded; the border (zone 3, the camera clamp); no
// G.errors. Screenshots (looked at by hand): the spawn, villages by style, a desert with cacti, the border.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGen, makePlan, paintChunk } from '../../src/gen/index.js';
import { DECO } from '../../src/gen/chunk.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fnv = (arrs) => { let h = 0x811c9dc5; for (const a of arrs) for (let i = 0; i < a.length; i++) { h ^= a[i] & 255; h = Math.imul(h, 16777619); h ^= a[i] >> 8; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };

export default async function (t) {
  const { page, R, run, idle, shot, check, log } = t;
  const boot = JSON.parse(await R(`JSON.stringify({ kind: W.layout.kind, P: [P.tx, P.ty], sp: h.gen.plan().spawn, seed: h.gen.seed(), hash: h.gen.hash(),
    boot: h.gen.bootMs(), plan: h.gen.planMs(), worker: h.gen.client.worker, errs: G.errors || [],
    ready: [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => W.ready(P.tx + dx * 32, P.ty + dy * 32))) })`));
  log('boot', JSON.stringify(boot));
  check(boot.kind === 'wild', 'a Wild World booted');
  check(boot.P[0] === boot.sp.px && boot.P[1] === boot.sp.py, 'Steve starts at the plan spawn');
  check(boot.ready, 'the 3 x 3 chunks around the spawn are ready at boot');
  check(boot.worker, 'the generator runs in a Worker');

  // a real walk with the keys (collisions, steps, the tracker through onStep)
  const walk = await run(async () => {
    const h = window.__rs, P = h.P, x0 = P.tx, y0 = P.ty;
    for (let i = 0; i < 150; i++) { h.tick({ hold: ['sprint', i % 60 < 30 ? 'right' : 'down'], dt: 1 / 30, capture: false }); if (i % 3 === 2) await new Promise((r) => setTimeout(r, 1)); }
    const p = h.gen.place();
    return { moved: Math.abs(P.tx - x0) + Math.abs(P.ty - y0), place: p && p.key, music: h.music.current, song: p && h.A.world.music[p.music], errs: (h.G.errors || []).length };
  });
  log('walk', JSON.stringify(walk));
  check(walk.moved > 3 && walk.errs === 0, `Steve walks and sprints on generated land (${walk.moved} cells)`);
  check(!!walk.place && walk.music === walk.song, `the music is the place's song (${walk.place}: ${walk.music})`);

  // the plan in the page equals Node's
  const terrain = JSON.parse(readFileSync(path.join(ROOT, 'assets/world/terrain.json'), 'utf8'));
  const g = makeGen({ type: 'wild', seed: boot.seed }, { terrain, cache: true });
  const plan = makePlan(g);
  check(plan.hash === boot.hash, `the worker's plan hash equals Node's (${boot.hash} / ${plan.hash})`);

  // decoration codes agree
  const decoIds = await run(async () => (await import('/src/world.js')).DECO_IDS);
  check(JSON.stringify(decoIds) === JSON.stringify(DECO), 'world.js decoration codes equal the generator\'s');

  // worker chunks == main-thread chunks == Node chunks
  const cmp = await run(async () => {
    const h = window.__rs, W = h.world, gen = h.gen.client, out = [];
    const fnv = (arrs) => { let x = 0x811c9dc5; for (const a of arrs) for (let i = 0; i < a.length; i++) { x ^= a[i] & 255; x = Math.imul(x, 16777619); x ^= a[i] >> 8; x = Math.imul(x, 16777619); } return (x >>> 0).toString(16); };
    for (let ck = 0; ck < W.cstate.length && out.length < 6; ck++) {
      if (ck % 63 < 13 || W.cstate[ck] !== 2) continue;
      const lx = (ck % 63) - 13, ly = (ck / 63) | 0, s = gen.sync(lx, ly);
      const dec = W.deco[ck] || new Uint8Array(1024);
      out.push({ lx, ly, worker: fnv([W.cbase[ck], W.cground[ck], dec]), main: fnv([s.tile, s.ground, s.deco]) });
    }
    return out;
  });
  let same = cmp.length > 0;
  for (const c of cmp) {
    const p = paintChunk(g, c.lx, c.ly), node = fnv([p.tile, p.ground, p.deco]);
    if (c.worker !== c.main || c.worker !== node) { same = false; log('chunk differs', JSON.stringify(c), node); }
  }
  check(same, `worker, main-thread and Node chunks identical (${cmp.length} chunks)`);

  // a glide at sprint speed in real time (6.7 cells a second, 30 frames a second, the worker answering between
  // frames): 300 cells east (or west, whichever stays inside the border), then a 300-cell zigzag. (perf.mjs does the
  // 600-cell runs in the game's own requestAnimationFrame loop.)
  const glide = async (legs) => run(async (legs) => {
    const h = window.__rs, W = h.world, P = h.P, cam = () => h.camera();
    const stat = { frames: 0, unreadyUnder: 0, unreadyView: 0, places: [], banners: [], maxStream: 0 };
    let fx = P.tx, fy = P.ty, lastCell = P.tx + ',' + P.ty, steps = 0, lastPlace = h.gen.place() && h.gen.place().key;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let due = performance.now();
    for (const [dx, dy, n] of legs) {
      P.dir = dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up';
      const frames = Math.round(n / (6.7 / 30));
      for (let f = 0; f < frames; f++) {
        fx += dx * 6.7 / 30; fy += dy * 6.7 / 30;
        P.tx = P.fromX = Math.round(fx); P.ty = P.fromY = Math.round(fy); P.fx = fx; P.fy = fy; P.moving = false;
        const cell = P.tx + ',' + P.ty;
        if (cell !== lastCell) { lastCell = cell; steps++; h.gen.step(); const pk = h.gen.place() && h.gen.place().key; if (pk !== lastPlace) { stat.places.push([steps, pk]); lastPlace = pk; } }
        const s0 = h.gen.stream.ms;
        h.tick({ dt: 1 / 30, capture: false });
        stat.maxStream = Math.max(stat.maxStream, h.gen.stream.ms - s0);
        stat.frames++;
        if (!W.ready(P.tx, P.ty)) stat.unreadyUnder++;
        const c = cam(), S = 256;
        let bad = 0;
        for (let cy = Math.floor(c.y / S); cy <= Math.floor((c.y + 160) / S); cy++) for (let cx = Math.floor(c.x / S); cx <= Math.floor((c.x + 240) / S); cx++) if (!W.ready(cx * 16, cy * 16)) bad++;
        if (bad) stat.unreadyView++;
        due += 1000 / 30;
        await sleep(Math.max(0, due - performance.now()));
      }
    }
    stat.end = [P.tx, P.ty];
    stat.banner = h.G && null;
    return stat;
  }, legs);
  const b = await R('W.layout.border');
  const east = b.x1 - boot.P[0] > 620 ? 1 : -1;
  const s1 = await glide([[east, 0, 300]]);
  log('straight', JSON.stringify(s1));
  check(s1.unreadyUnder === 0 && s1.unreadyView === 0, `300 cells straight: no unready chunk under Steve or in view (${s1.unreadyUnder}, ${s1.unreadyView})`);
  // the place changes only after 8 steps in the new place
  let gaps = true, prev = 0;
  for (const [st] of s1.places) { if (st - prev < 8) gaps = false; prev = st; }
  check(s1.places.length >= 1 && gaps, `biome places change after at least 8 steps (${s1.places.length} changes: ${s1.places.map((p) => p[1]).join(', ')})`);
  const banner = await run(() => { const h = window.__rs, p = h.gen.place(); return p ? p.name : null; });
  log('place at the end', banner);
  const zig = [];
  const dy = boot.P[1] > 800 ? -1 : 1;
  for (let k = 0; k < 13; k++) zig.push(k % 2 ? [0, dy, 24] : [-east, 0, 24]);
  const s2 = await glide(zig);
  log('zigzag', JSON.stringify({ ...s2, places: s2.places.length }));
  check(s2.unreadyUnder === 0 && s2.unreadyView === 0, `300-cell zigzag: no unready chunk under Steve or in view (${s2.unreadyUnder}, ${s2.unreadyView})`);
  const st = JSON.parse(await R('JSON.stringify({ ...h.gen.stream.stats, cached: W.chunks.size, cap: W.chunkCap, inFlight: h.gen.client.inFlight })'));
  log('stream stats', JSON.stringify(st));
  const ap = JSON.parse(await R('JSON.stringify(W.genStats)'));
  log('apply', JSON.stringify(ap), 'mean', (ap.applyMs / ap.applied).toFixed(3));
  check(ap.applyMs / ap.applied < 2, `a chunk applies in under 2 ms on average (${(ap.applyMs / ap.applied).toFixed(2)} ms, max ${st.maxApplyMs.toFixed(2)} ms)`);
  check(st.cached <= st.cap, 'the draw-canvas LRU stays within its cap');

  // regionKey culling: a zombie stays across biomes, goes when Steve enters the Nether
  const cull = await run(async () => {
    const h = window.__rs, W = h.world, P = h.P;
    const z = h.spawn('zombie', P.tx + 3, P.ty); z.persistent = false;
    const far = [P.tx + 12, P.ty];
    await h.ensure(far[0], far[1], 1);
    h.teleport(far[0], far[1]);
    h.tick({ dt: 1 / 30, capture: false });
    const after1 = h.G.ents.includes(z);
    h.enterNether();
    h.tick({ dt: 1 / 30, capture: false });
    const after2 = h.G.ents.includes(z);
    h.leaveNether();
    h.tick({ dt: 1 / 30, capture: false });
    return { after1, after2, back: [P.tx, P.ty], key: W.regionKey(P.tx, P.ty) };
  });
  log('cull', JSON.stringify(cull));
  check(cull.after1 && !cull.after2, 'a zombie stays while Steve moves outdoors and is culled when he enters the Nether');
  check(cull.key === 'WILD', 'the Nether brings Steve back to the overworld');

  // overrides on an unready chunk wait for it
  const ov = await run(async () => {
    const h = window.__rs, W = h.world, P = h.P;
    // a chunk not generated yet: far to the north-west of Steve, inside the border
    let x = 0, y = 0;
    for (let k = 0; k < 40; k++) { x = 424 + 40 + k * 37 % 1500; y = 40 + (k * 53) % 1500; if (!W.ready(x, y) && W.cstate[(y >> 5) * 63 + (x >> 5)] === 0) break; }
    const t = 104;
    W.setTile(x, y, t);
    const before = W.grid[y * W.W + x];
    await h.ensure(x, y, 0);
    return { x, y, before, after: W.grid[y * W.W + x], edit: W.edits.get(y * W.W + x), t };
  });
  log('override', JSON.stringify(ov));
  check(ov.before === 0 && ov.after === ov.t && ov.edit === ov.t, 'a tile set on an unready chunk is applied with the chunk');

  // villages by style, a desert with decorations, the border: screenshots, and the decorations as blocks
  const shotAt = async (name, x, y) => {
    await run(async ([x, y]) => { const h = window.__rs; await h.ensure(x, y, 1); h.teleport(x, y); h.G.nausea = 0; h.toasts.length = 0; for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 5)); h.tick({ dt: 1 / 30, capture: false }); } }, [x, y]);
    return shot(name);
  };
  await shotAt('4a_spawn', boot.sp.px, boot.sp.py);
  const seen = new Set();
  for (const v of plan.json.villages) {
    if (seen.has(v.biome)) continue;
    seen.add(v.biome);
    await shotAt(`4a_village_${v.biome.toLowerCase()}`, 416 + v.x0 + (v.w >> 1), v.y0 + (v.h >> 1));
  }
  // decorations near a desert village (or anywhere loaded)
  const deco = await run(() => {
    const h = window.__rs, W = h.world, found = {};
    for (let ck = 0; ck < W.deco.length; ck++) {
      const d = W.deco[ck];
      if (!d) continue;
      for (let k = 0; k < 1024; k++) if (d[k] && !found[d[k]]) { const x = (ck % 63) * 32 + (k & 31), y = ((ck / 63) | 0) * 32 + (k >> 5); found[d[k]] = [x, y]; }
    }
    const res = {};
    for (const [code, [x, y]] of Object.entries(found)) {
      const b = W.block(x, y);
      res[code] = { x, y, id: b && b.id, frozen: !!b && Object.isFrozen(b), solid: W.blockSolid(x, y) };
    }
    return res;
  });
  log('decorations', JSON.stringify(deco));
  // (7a: a village farm's farmland is a fresh block each read, its wheat following the time: World.farmBlock)
  check(Object.keys(deco).length >= 3 && Object.values(deco).every((d) => d.id && (d.frozen || d.id === 'farmland')), 'generated decorations read as frozen blocks (farmland: a fresh block with its wheat)');
  const cactus = deco[4];
  if (cactus) {
    await shotAt('4a_cactus', cactus.x, cactus.y + 2);
    const rm = await run(([x, y]) => { const W = window.__rs.world; W.setBlock(x, y, null); return { gone: W.block(x, y) === null, bover: W.bover.get(y * W.W + x) }; }, [cactus.x, cactus.y]);
    check(rm.gone && rm.bover === 0, 'removing a generated cactus records a block override and the cell reads empty');
  }
  // the border: zone 3 past it, the camera clamped to the overworld
  const by = boot.P[1];
  await shotAt('4a_border', b.x1 - 3, by);
  const bd = await run(([x1, y]) => {
    const h = window.__rs, W = h.world, c = h.camera(), L = W.layout;
    return { zIn: W.zone[y * W.W + x1], zOut: W.zone[y * W.W + x1 + 1], blocked: W.baseBlocked(x1 + 1, y), water: W.isWater(x1 + 1, y), camMax: (L.ox + L.ow) * 16 - 240, cam: c.x };
  }, [b.x1, by]);
  log('border', JSON.stringify(bd));
  check(bd.zIn === 0 && bd.zOut === 3 && bd.blocked && !bd.water, 'past the border cells are zone 3: drawn, never entered, no water to swim');
  check(bd.cam === Math.min(bd.camMax, (b.x1 - 3) * 16 + 8 - 120) && bd.cam + 240 > b.x1 * 16 + 16, 'the camera follows Steve to the border and shows the cells past it');
  const clamp = await run(([x]) => { const h = window.__rs, P = h.P, L = h.world.layout; const was = [P.tx, P.ty]; P.tx = P.fx = x; h.tick({ dt: 1 / 30, capture: false }); const c = h.camera().x; P.tx = P.fx = was[0]; h.tick({ dt: 1 / 30, capture: false }); return { c, max: (L.ox + L.ow) * 16 - 240 }; }, [2015]);
  check(clamp.c === clamp.max, `the camera never scrolls past the overworld's edge (${clamp.c} / ${clamp.max})`);
  const errs = await R('G.errors || []');
  check(errs.length === 0, 'no G.errors: ' + errs.join(' | ').slice(0, 400));
}
