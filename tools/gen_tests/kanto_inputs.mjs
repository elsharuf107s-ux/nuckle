// Kanto's inputs for a Kanto World's generator (stage 6a), read from assets/world: Classic's zone, grid and ground
// for Kanto's outdoor block (408 x 400) and the class of every world.json entry (src/gen/kanto.js kantoMatTable).
//   import { kantoInputs } from './kanto_inputs.mjs';  makeGen({ type: 'kanto', seed }, { terrain, ...kantoInputs() })
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kantoMatTable } from '../../src/gen/kanto.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (f) => readFileSync(path.join(ROOT, 'assets', 'world', f));
let K = null;
export function kantoInputs() {
  if (K) return K;
  const z = rd('zone.bin'), gb = rd('grid.bin'), gr = rd('ground.bin');
  const W = JSON.parse(rd('world.json').toString('utf8'));
  K = {
    kantoZone: new Uint8Array(z.buffer, z.byteOffset, 408 * 400).slice(),
    kantoGrid: new Uint16Array(gb.buffer.slice(gb.byteOffset, gb.byteOffset + 408 * 400 * 2)),
    kantoGround: new Uint16Array(gr.buffer.slice(gr.byteOffset, gr.byteOffset + 408 * 400 * 2)),
    kantoMat: kantoMatTable(W.entries),
  };
  return K;
}
// the same from fetched arrays (a headless page): zone (Uint8), grid and ground (Uint16) of the whole Classic grid,
// world.json's entries
export function kantoInputsFrom(zone, grid, ground, entries) {
  return { kantoZone: zone.slice(0, 408 * 400), kantoGrid: grid.slice(0, 408 * 400), kantoGround: ground ? ground.slice(0, 408 * 400) : null, kantoMat: kantoMatTable(entries) };
}
