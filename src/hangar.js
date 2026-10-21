// The hangar: six saved builds, one of which is "on the pad" (the one a sortie fields).
//
// The state is plain data, { active: 0..5, slots: [build | null, ...] }, so all of it can be tested in Node.
// Storage is passed in (localStorage in the game) because it can be missing or full (private windows).
// A save from before the hangar existed is a single build under the old key; it becomes slot 1.

import { DEFAULT_BUILD, sanitizeBuild } from './parts.js';

export const HANGAR_SIZE = 6;
const KEY = 'steel-vanguard.hangar';
const LEGACY_KEY = 'steel-vanguard.build';

/** A fresh stock build for an empty slot, named after the slot. */
export function stockBuild(index) {
  const name = index === 0 ? DEFAULT_BUILD.name : `MECH-${String(index + 1).padStart(2, '0')}`;
  return sanitizeBuild({ ...DEFAULT_BUILD, paint: { ...DEFAULT_BUILD.paint }, tuning: { ...DEFAULT_BUILD.tuning }, name });
}

/** Anything (parsed JSON, junk) into a valid hangar: six entries, builds sanitised, at least one filled, `active` filled. */
export function cleanHangar(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(src.slots) ? src.slots : [];
  const slots = Array.from({ length: HANGAR_SIZE }, (_, i) => (list[i] && typeof list[i] === 'object' ? sanitizeBuild(list[i]) : null));
  if (!slots.some(Boolean)) slots[0] = stockBuild(0);
  let active = Number.isInteger(src.active) ? src.active : 0;
  if (active < 0 || active >= HANGAR_SIZE || !slots[active]) active = slots.findIndex(Boolean);
  return { active, slots };
}

export function loadHangar(storage) {
  try {
    const raw = storage?.getItem(KEY);
    if (raw) return cleanHangar(JSON.parse(raw));
    const legacy = storage?.getItem(LEGACY_KEY);
    if (legacy) return cleanHangar({ active: 0, slots: [JSON.parse(legacy)] });
  } catch {
    // unreadable: start from the stock mech
  }
  return cleanHangar(null);
}

export function saveHangar(hangar, storage) {
  try {
    storage?.setItem(KEY, JSON.stringify(hangar));
    storage?.setItem(LEGACY_KEY, JSON.stringify(hangar.slots[hangar.active])); // the single-build key still works for older pages
  } catch {
    // ignore: the hangar just will not persist
  }
}

export const activeBuild = (hangar) => hangar.slots[hangar.active];
export const filledCount = (hangar) => hangar.slots.filter(Boolean).length;

/** Put a new stock build in slot `index` if it is empty, and make that slot the active one. Returns the new hangar. */
export function selectSlot(hangar, index) {
  if (index < 0 || index >= HANGAR_SIZE) return hangar;
  const slots = hangar.slots.slice();
  if (!slots[index]) slots[index] = stockBuild(index);
  return { active: index, slots };
}

/** Copy the active build into the first empty slot (and switch to it). Returns the new hangar, or the same one if the hangar is full. */
export function copyActive(hangar) {
  const free = hangar.slots.findIndex((b) => !b);
  if (free < 0) return hangar;
  const slots = hangar.slots.slice();
  const copy = sanitizeBuild({ ...hangar.slots[hangar.active] });
  slots[free] = { ...copy, name: copy.name.length > 11 ? `${copy.name.slice(0, 11).trim()}-2` : `${copy.name}-2` };
  return { active: free, slots };
}

/** Put a build (from a build code) in the first empty slot and switch to it; with a full hangar it replaces the active one. */
export function placeBuild(hangar, build) {
  const slots = hangar.slots.slice();
  const free = slots.findIndex((b) => !b);
  const index = free >= 0 ? free : hangar.active;
  slots[index] = sanitizeBuild(build);
  return { hangar: { active: index, slots }, index, replaced: free < 0 };
}

/** Empty a slot. The last build can never be removed; clearing the active one moves to another. */
export function clearSlot(hangar, index) {
  if (!hangar.slots[index] || filledCount(hangar) <= 1) return hangar;
  const slots = hangar.slots.slice();
  slots[index] = null;
  const active = hangar.active === index ? slots.findIndex(Boolean) : hangar.active;
  return { active, slots };
}

/** Replace the active build. */
export function updateActive(hangar, build) {
  const slots = hangar.slots.slice();
  slots[hangar.active] = sanitizeBuild(build);
  return { active: hangar.active, slots };
}
