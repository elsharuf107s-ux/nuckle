// Seeded PRNG for everything that affects play (encounters, battles, catches), so a run can be
// replayed exactly by the headless hooks and the video renderer. Cosmetic effects may use Math.random.
let s = (Date.now() ^ 0x9e3779b9) >>> 0;

export function seed(v) { s = (v >>> 0) || 1; }
export function state() { return s; }
// mulberry32
export function rand() {
  s = (s + 0x6D2B79F5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function randInt(n) { return Math.floor(rand() * n); }            // 0..n-1
export function range(lo, hi) { return lo + randInt(hi - lo + 1); }      // lo..hi inclusive
export function chance(p) { return rand() < p; }
export function pick(arr) { return arr[randInt(arr.length)]; }
