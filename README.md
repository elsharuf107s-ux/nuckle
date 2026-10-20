# Steel Vanguard

A 3D third-person mobile-suit combat game that runs in the browser. Pilot the **VG-01 Vanguard** through a
dusk-lit colony city: boost over rooftops, lock on, burn enemies down with a beam rifle, homing missiles and a
three-hit beam-saber combo, and survive five waves ending in a fight with the **Crimson Baron**.

Everything is generated in code. There are no model, texture or audio files: mechs are built from primitives,
the city and sky are procedural, and every sound effect and the music are synthesised with WebAudio.

## Play

```bash
python3 serve.py          # http://localhost:8000   (or: python3 serve.py 3000)
```

Any static file server works. The only requirement is that it serves `.js` files with a JavaScript MIME type
(ES modules). Open the page, click **SORTIE**, and the game captures your mouse. Press **Esc** to pause.
Desktop browsers with WebGL only: there is no touch or gamepad support.

### Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move (relative to the camera; strafes around your lock-on target) |
| Mouse | Aim / camera (the camera tracks your target while locked on) |
| `Space` (hold) | Boost upward |
| `Shift` | Quick-boost dash, with brief invulnerability. Aimed along your input, or at your target |
| Left mouse | Beam rifle (8-round magazine, auto-reloads) |
| Right mouse | Beam saber. Lunges at the target; press again mid-swing to chain a 3-hit combo |
| `E` | Missile salvo (4 homing missiles, 2 charges that recharge) |
| `Q` | Toggle lock-on |
| `Tab` | Switch lock-on target |
| `R` | Reload |
| `X` | **Burst**, when the gauge is full: unlimited boost, +50% damage, faster fire, partial repair |
| `M` | Mute |

Dash to dodge, use the saber to close gaps and break enemy guard, and keep an eye on the **EN** bar: boosting
to zero overheats the thrusters until they recover. The burst gauge fills as you deal damage and score kills.

### The sortie

| Wave | Hostiles |
| --- | --- |
| 1 First Contact | 3 Drones |
| 2 Pincer | 4 Drones, 1 Striker |
| 3 Heavy Support | 4 Drones, 2 Bulwarks |
| 4 Blade Dance | 3 Strikers, 3 Drones, 2 Bulwarks |
| 5 The Crimson Baron | the boss and 2 Drones |

- **DR-12 Drone**: mono-eye grunt that holds its distance and fires three-round bursts.
- **ST-21 Striker**: fast blade fighter that dashes in for a saber combo, then backs off and shoots.
- **HV-30 Bulwark**: slow artillery. Its cannon glows as it charges, then fires a splash shell.
- **CR-00 Crimson Baron**: boss ace. Rifle volleys, saber rushes, homing missile salvos from 66% armor, and a
  faster, more aggressive final phase below 33%. It dodges your beam shots.

Between waves your ammo and missiles are restocked and 25% of your armor is repaired. Finishing the sortie
gives a rank (S/A/B/C) from combat score, clear time and remaining armor. Kills in quick succession build a score
multiplier.

The pause menu has mouse sensitivity, volume, a shadows toggle and a resolution scale. Lower the last two if
the game runs slowly on integrated graphics. Settings are remembered in `localStorage`.

## Project layout

```
index.html, style.css     page shell, HUD markup and menus
src/main.js               entry point: screens, pause, pointer lock, saved options
src/game.js               renderer, fixed-timestep loop, damage/kill/score rules, win and lose
src/world.js              procedural city, sky shader, lighting, collision queries
src/mechModel.js          procedural mech model and animation rig
src/mech.js               mech physics: walk, boost, dash, collision, damage
src/player.js             input to intent, lock-on, rifle, missiles, saber combo, burst
src/ai.js                 Drone / Striker / Bulwark / Baron behaviours
src/weapons.js            projectiles with swept collision and homing
src/fx.js                 particles, explosions, debris, saber arcs
src/camera.js             chase camera with lock-on framing and trauma shake
src/hud.js                DOM bars plus canvas reticle, radar and damage numbers
src/missions.js           wave director
src/audio.js              synthesised sound effects and music
src/data.js               mech stats, palettes and wave definitions
vendor/three/             three.js r170 (MIT), vendored so the game runs offline
scripts/test.mjs          end-to-end test suite
serve.py                  tiny static server
```

The simulation runs on a fixed 60 Hz step independent of the display refresh rate. `window.__game` exposes the
running game for debugging (`__game.cheat.invincible = true` is handy for sightseeing).

## Tests

`scripts/test.mjs` loads the game in headless Chromium and plays it: movement, boosting, landing on roofs,
building collision (including a randomised stress run), every weapon, each enemy type and the boss, a full
scripted playthrough to victory, a defeat and retry, and the pause/options UI. It fails on any console error.

```bash
npm i -D playwright       # once; a Chromium build must be available to Playwright
npm test                  # SHOTS=0 to skip screenshots, DEBUG=1 for the raw numbers
npm run lint              # needs eslint
```

Screenshots from each run are written to `out/test/` (git-ignored).

## Notes

- The mech designs are original. They borrow the visual language of the real-robot anime genre (a V-fin hero,
  mono-eye grunts, a horned ace) but copy no existing machine. This is an independent fan-style project and is
  not affiliated with or endorsed by any anime studio or toy maker.
- three.js is © its authors, MIT licensed; see `vendor/three/LICENSE`.
