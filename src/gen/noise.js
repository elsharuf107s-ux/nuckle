// Noise for the world generator (design 3.1). Classic 2D simplex noise built from + - * / and Math.sqrt only
// (both correctly rounded by IEEE 754), with a 512-entry permutation shuffled from a sub-seed by Fisher-Yates
// driven by hash32, and gradients from a fixed table of 12 integer vectors. No sin, cos, exp, pow or log, so
// V8, JavaScriptCore and SpiderMonkey give bit-identical worlds.
//
//   makeFbm(seed, name, wavelength, octaves, gain)   a fractal layer (one permutation per octave)
//   fbm(layer, x, y)                                  in [-1, 1], x and y in cells
//   makeRidged(...), ridged(layer, x, y)              (1 - |simplex|)^2 summed, in [0, 1]
//   simplex2(perm, x, y)                              in about [-1, 1]
//   smooth(t), lerp(a, b, t), clamp(v, lo, hi)
import { hash32, fnv1a } from './hash.js';

const SQRT3 = Math.sqrt(3);
const F2 = 0.5 * (SQRT3 - 1);
const G2 = (3 - SQRT3) / 6;
const GX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];

export function makePerm(seed) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = hash32(seed, i, 0x51ed) % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512), mod = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; mod[i] = perm[i] % 12; }
  return { perm, mod };
}

export function simplex2(P, xin, yin) {
  const perm = P.perm, mod = P.mod;
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s), j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t), y0 = yin - (j - t);
  let i1 = 0, j1 = 1;
  if (x0 > y0) { i1 = 1; j1 = 0; }
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) { const g = mod[ii + perm[jj]]; t0 *= t0; n += t0 * t0 * (GX[g] * x0 + GY[g] * y0); }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) { const g = mod[ii + i1 + perm[jj + j1]]; t1 *= t1; n += t1 * t1 * (GX[g] * x1 + GY[g] * y1); }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) { const g = mod[ii + 1 + perm[jj + 1]]; t2 *= t2; n += t2 * t2 * (GX[g] * x2 + GY[g] * y2); }
  return 70 * n;
}

function layer(seed, name, wavelength, octaves, gain) {
  const P = [];
  const h = fnv1a(name);
  let norm = 0, amp = 1;
  for (let o = 0; o < octaves; o++) { P.push(makePerm(hash32(seed | 0, h, o))); norm += amp; amp *= gain; }
  return { P, f: 1 / wavelength, oct: octaves, gain, inv: 1 / norm };
}

export function makeFbm(seed, name, wavelength, octaves = 1, gain = 0.5) {
  return layer(seed, name, wavelength, octaves, gain);
}

// fbm and ridged carry their own copy of simplex2's body (stage 3c: about a third faster than a call per octave, which
// V8 does not inline; the same operations in the same order, so the same numbers: the golden hashes check it)
export function fbm(L, x, y) {
  let sum = 0, amp = 1, f = L.f;
  const PP = L.P;
  for (let o = 0; o < L.oct; o++) {
    const P = PP[o], xin = x * f, yin = y * f;
    const perm = P.perm, mod = P.mod;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1 = 0, j1 = 1;
    if (x0 > y0) { i1 = 1; j1 = 0; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = mod[ii + perm[jj]]; t0 *= t0; n += t0 * t0 * (GX[g] * x0 + GY[g] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = mod[ii + i1 + perm[jj + j1]]; t1 *= t1; n += t1 * t1 * (GX[g] * x1 + GY[g] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = mod[ii + 1 + perm[jj + 1]]; t2 *= t2; n += t2 * t2 * (GX[g] * x2 + GY[g] * y2); }
    sum += amp * (70 * n);
    amp *= L.gain; f *= 2;
  }
  return sum * L.inv;
}

export function makeRidged(seed, name, wavelength, octaves = 1, gain = 0.5) {
  return layer(seed, name, wavelength, octaves, gain);
}

export function ridged(L, x, y) {
  let sum = 0, amp = 1, f = L.f;
  const PP = L.P;
  for (let o = 0; o < L.oct; o++) {
    const P = PP[o], xin = x * f, yin = y * f;
    const perm = P.perm, mod = P.mod;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1 = 0, j1 = 1;
    if (x0 > y0) { i1 = 1; j1 = 0; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = mod[ii + perm[jj]]; t0 *= t0; n += t0 * t0 * (GX[g] * x0 + GY[g] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = mod[ii + i1 + perm[jj + j1]]; t1 *= t1; n += t1 * t1 * (GX[g] * x1 + GY[g] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = mod[ii + 1 + perm[jj + 1]]; t2 *= t2; n += t2 * t2 * (GX[g] * x2 + GY[g] * y2); }
    let v = 70 * n;
    v = 1 - (v < 0 ? -v : v);
    sum += amp * v * v;
    amp *= L.gain; f *= 2;
  }
  return sum * L.inv;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const smooth = (t) => t * t * (3 - 2 * t);
export const lerp = (a, b, t) => a + (b - a) * t;
