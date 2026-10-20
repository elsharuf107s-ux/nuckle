// Entry point: builds the game and wires up the title / pause / end screens and pointer lock.

import { Game } from './game.js';
import { Garage, describeBuild } from './garage.js';

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

let game;
try {
  game = new Game($('gl'));
} catch (err) {
  console.error(err);
  document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif;color:#fff">Steel Vanguard needs WebGL, which this browser could not start.</p>';
  throw err;
}
window.__game = game; // handy for debugging and used by scripts/test.mjs

// ---- garage: the saved build is fielded at startup so SORTIE always uses what you last built
const garage = new Garage(game, {
  onBack: () => closeGarage(),
  onSortie: () => {
    garage.close();
    startUI();
  },
  onChange: (build) => updateTitleBuild(build),
});
game.setBuild(garage.build);
window.__garage = garage;

function updateTitleBuild(build = garage.build) {
  $('title-build').textContent = `CURRENT BUILD  ·  ${describeBuild(build)}`;
}
updateTitleBuild();

function openGarage() {
  show('screen-title', false);
  show('screen-end', false);
  show('screen-pause', false);
  garage.open();
}

function closeGarage() {
  garage.close();
  show('screen-title', true);
  updateTitleBuild();
}

let wasLocked = false;
function lockPointer() {
  try {
    const p = game.canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  } catch {
    // pointer lock unavailable: the game still plays, the camera just follows an unlocked cursor
  }
}

function pauseUI() {
  if (game.state !== 'playing') return;
  game.pause();
  show('screen-pause', true);
}

function resumeUI() {
  show('screen-pause', false);
  game.resume();
  lockPointer();
}

function startUI() {
  show('screen-title', false);
  show('screen-end', false);
  show('screen-pause', false);
  game.startMission();
  lockPointer();
}

$('btn-start').addEventListener('click', startUI);
$('btn-garage').addEventListener('click', openGarage);
$('btn-garage-end').addEventListener('click', () => {
  show('screen-end', false);
  game.toTitle();
  openGarage();
});
$('btn-again').addEventListener('click', startUI);
$('btn-resume').addEventListener('click', resumeUI);
$('btn-quit').addEventListener('click', () => {
  show('screen-pause', false);
  game.resume();
  game.toTitle();
  show('screen-title', true);
});

// Options persist between visits (storage can be unavailable, e.g. in private windows).
const store = {
  get(key) { try { return localStorage.getItem(`steel-vanguard.${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`steel-vanguard.${key}`, String(value)); } catch { /* ignore */ } },
};

function bindOption(id, key, apply, read = (el) => el.value) {
  const el = $(id);
  const saved = store.get(key);
  if (saved !== null) {
    if (el.type === 'checkbox') el.checked = saved === 'true';
    else el.value = saved;
  }
  const run = () => { apply(read(el)); store.set(key, el.type === 'checkbox' ? el.checked : el.value); };
  el.addEventListener('input', run);
  el.addEventListener('change', run);
  apply(read(el));
}

bindOption('opt-sens', 'sens', (v) => { game.rig.sensitivity = 0.0022 * Number(v); });
bindOption('opt-volume', 'volume', (v) => game.audio.setVolume(Number(v)));
bindOption('opt-shadows', 'shadows', (on) => game.applySettings({ shadows: on }), (el) => el.checked);
bindOption('opt-scale', 'scale', (v) => game.applySettings({ scale: Number(v) }));

// Losing the pointer lock (Esc) pauses the game.
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === game.canvas) wasLocked = true;
  else if (wasLocked) {
    wasLocked = false;
    pauseUI();
  }
});
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;
  if (game.state === 'garage') closeGarage();
  else pauseUI(); // when the pointer was not locked
});

// ---- garage turntable: drag to rotate, scroll to zoom
const canvas = game.canvas;
canvas.addEventListener('pointerdown', (e) => {
  if (game.state !== 'garage') return;
  game.garageCam.dragging = true;
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (game.state === 'garage' && game.garageCam.dragging) game.garageLook(e.movementX, e.movementY);
});
const endDrag = () => { game.garageCam.dragging = false; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  if (game.state !== 'garage') return;
  e.preventDefault();
  game.garageZoom(e.deltaY);
}, { passive: false });
window.addEventListener('blur', pauseUI);
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseUI(); });

game.onEnd = (result) => {
  if (document.pointerLockElement) document.exitPointerLock();
  game.hud.show(false);
  $('end-eyebrow').textContent = result.victory ? 'SORTIE REPORT' : 'SORTIE FAILED';
  $('end-title').textContent = result.victory ? 'MISSION COMPLETE' : 'MECH DESTROYED';
  const rank = $('end-rank');
  rank.classList.toggle('hidden', !result.rank);
  rank.textContent = result.rank ?? '';
  const table = $('end-stats');
  table.textContent = '';
  for (const [label, value] of result.rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = label;
    tr.insertCell().textContent = value;
  }
  $('btn-again').textContent = result.victory ? 'SORTIE AGAIN' : 'RETRY';
  show('screen-end', true);
};

game.start();
