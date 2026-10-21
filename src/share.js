// Build codes: a whole machine as a short piece of text you can copy, send to a friend and paste back in.
//
//   SV1.<what differs from the stock build, as base64url JSON>.<4 hex digits of checksum>
//
// Decoding never trusts the text: the checksum catches a typo or a cut-off paste, and sanitizeBuild() turns whatever
// came out into a valid build (unknown parts, odd colours and out-of-range numbers are dropped).
// This module has no browser dependency (btoa/atob exist in Node too), so it is unit-tested in plain Node.

import { DEFAULT_BUILD, sanitizeBuild } from './parts.js';

const VERSION = 'SV1';

const toB64 = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (text) => atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));

/** A 16-bit checksum of the text, as four hex digits. */
function checksum(text) {
  let h = 0x1d0f;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i) * 31) & 0xffff;
  return h.toString(16).padStart(4, '0');
}

/** The code for a build. */
export function encodeBuild(build) {
  const b = sanitizeBuild(build);
  const diff = {};
  for (const [k, v] of Object.entries(b)) if (JSON.stringify(v) !== JSON.stringify(DEFAULT_BUILD[k])) diff[k] = v;
  const json = JSON.stringify(diff);
  return `${VERSION}.${toB64(json)}.${checksum(json)}`;
}

/** `{ ok: true, build }` for a good code, else `{ ok: false, error }` saying what is wrong with it. */
export function decodeBuild(code) {
  const text = String(code ?? '').replace(/\s+/g, '');
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0].length === 0) return { ok: false, error: 'That is not a build code.' };
  if (parts[0] !== VERSION) return { ok: false, error: `This code is from another version of the game (${parts[0].slice(0, 8)}).` };
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[0-9a-f]{4}$/.test(parts[2])) return { ok: false, error: 'The code is damaged: check that all of it was copied.' };
  let json;
  try { json = fromB64(parts[1]); } catch { return { ok: false, error: 'The code is damaged: check that all of it was copied.' }; }
  if (checksum(json) !== parts[2]) return { ok: false, error: 'The code is damaged: check that all of it was copied.' };
  let diff;
  try { diff = JSON.parse(json); } catch { return { ok: false, error: 'The code is damaged: check that all of it was copied.' }; }
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return { ok: false, error: 'That is not a build code.' };
  return { ok: true, build: sanitizeBuild({ ...DEFAULT_BUILD, ...diff }) };
}
