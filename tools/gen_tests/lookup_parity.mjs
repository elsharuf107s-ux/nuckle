// Parity of the reference rock lookup with the game's cliff re-edger (world update stage 2a).
// Runs the real World.prototype.reedgeCliffs (src/world.js) over random rock masks on a stand-in world and prints,
// for every rock cell it re-picks, [k2, k1, ground class, pick or null]. tools/gen_tests/terrain_check.py compares
// these with build_terrain.lookup(classic=True), which must agree on every cell, hits and FireRed-unseen patterns
// alike. Usage: node tools/gen_tests/lookup_parity.mjs  (prints JSON on stdout)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { A } from '../../src/assets.js';
import { World } from '../../src/world.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
A.autotile = JSON.parse(readFileSync(join(HERE, 'assets/world/autotile.json'), 'utf8'));
const mountain = new Set(A.autotile.mountain);
// the cell's own mid: a mountain member that is never a table candidate, so every pick is written by setTile
const cands = new Set();
for (const k of ['r1', 'r2', 'g1', 'g2']) for (const v of Object.values(A.autotile[k])) for (const c of v) cands.add(c);
const ROCK = A.autotile.mountain.find(m => !cands.has(m));
if (ROCK === undefined) throw new Error('every mountain mid is a candidate');

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const out = [];
const P = World.prototype;
for (let run = 0; run < 24; run++) {
  const W = 40, H = 40, dens = 0.25 + 0.5 * (run % 6) / 5, outside = run % 2 ? 'sand' : 'floor';
  const rock = new Uint8Array(W * H);
  // blobby masks: random seeds grown by a majority pass, plus raw noise every third run (unseen patterns)
  for (let i = 0; i < W * H; i++) rock[i] = rnd() < dens ? 1 : 0;
  if (run % 3) {
    const r2 = rock.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx));
        n += rock[yy * W + xx];
      }
      r2[y * W + x] = n >= 5 ? 1 : 0;
    }
    rock.set(r2);
  }
  const fake = {
    W, H, mountain, varOf: new Uint8Array(1),
    inside(x, y) { return x >= 0 && y >= 0 && x < W && y < H; },
    mat(x, y) { return !this.inside(x, y) ? 'void' : rock[y * W + x] ? 'rock' : outside; },
    mid(x, y) { return this.inside(x, y) && rock[y * W + x] ? ROCK : -1; },
    tile() { return 0; },
    entryFor(v, src) { return src; },
    picked: null,
    setTile(x, y, e) { this.picked = e; },
    isMountainCell: P.isMountainCell, groundClass: P.groundClass, keyOf: P.keyOf,
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!rock[y * W + x]) continue;
    // reedgeCliffs re-picks the 3x3 around its argument: a mid() view with only (x, y) a mountain mid makes it
    // re-pick that one cell (keyOf and groundClass still see the whole mask through mat())
    const only = { ...fake, mid(xx, yy) { return xx === x && yy === y ? ROCK : -1; }, picked: null };
    P.reedgeCliffs.call(only, x, y);
    const k2 = P.keyOf.call(fake, x, y, 2), k1 = P.keyOf.call(fake, x, y, 1), g = P.groundClass.call(fake, x, y);
    out.push([k2, k1, g, only.picked]);
  }
}
process.stdout.write(JSON.stringify({ rock: ROCK, cells: out }));
