// Integer hashing for the world generator (design 3.1). Everything here is Math.imul and bit operations on
// 32-bit integers, so every engine gives the same numbers.
//
//   hash32(a, b, c, d)  a 32-bit unsigned hash of up to four integers (murmur3's mixing steps)
//   rand01(a, b, c, d)  the same hash as a number in [0, 1)
//   fnv1a(str)          32-bit FNV-1a of a string's UTF-8 bytes
//   sub(seed, name)     a named sub-seed, so adding a layer never shifts the others
//   seedFromText(text)  the world seed for what the player typed (Minecraft's rule: an integer is itself,
//                       other text is Java's String.hashCode); null for blank text (the caller picks a random one)
//   DIR8                eight integer direction vectors (E, SE, S, SW, W, NW, N, NE)

function mix(h, k) {
  k = Math.imul(k | 0, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function fmix(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hash32(a, b = 0, c = 0, d = 0) {
  let h = 0x2545f491;
  h = mix(h, a); h = mix(h, b); h = mix(h, c); h = mix(h, d);
  return fmix(h ^ 16);
}

export function rand01(a, b = 0, c = 0, d = 0) {
  return hash32(a, b, c, d) / 4294967296;
}

const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

export function fnv1a(str) {
  const s = String(str);
  const bytes = enc ? enc.encode(s) : Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function sub(seed, name, k = 0) {
  return hash32(seed | 0, fnv1a(name), k | 0);
}

// Java's String.hashCode over UTF-16 code units, as Minecraft turns a text seed into a number
function javaHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export function seedFromText(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^[-+]?\d{1,15}$/.test(s)) return Number(s) | 0;
  return javaHash(s);
}

// A world seed for any seed value a descriptor may carry: an integer (kept as int32) or text.
export function worldSeed(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v) | 0;
  const s = seedFromText(v);
  return s === null ? 0 : s;
}

export const DIR8 = Object.freeze([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]);
