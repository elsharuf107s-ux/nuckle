# Steel Vanguard

A 3D third-person mobile-suit combat game that runs in the browser. **Build your own mech piece by piece** in the
garage (eleven slots, tuning points and paint, balanced by a load limit and a power budget), then take it through a dusk-lit colony city:
boost over rooftops, lock on, burn enemies down with your weapon, homing missiles and a three-hit beam-saber combo,
and survive five waves ending in a fight with the **Crimson Baron**.

Everything is generated in code. There are no model, texture or audio files: mechs are built from primitives,
the city and sky are procedural, and every sound effect and the music are synthesised with WebAudio.

## Play

```bash
python3 serve.py          # http://localhost:8000   (or: python3 serve.py 3000)
```

Any static file server works. The only requirement is that it serves `.js` files with a JavaScript MIME type
(ES modules). Open the page and click **SORTIE** to launch with your current build (the stock VG-01 Vanguard the first time), or
**GARAGE** to build your own first. The game captures your mouse when a sortie starts. Press **Esc** to pause.
Desktop browsers with WebGL only: there is no touch or gamepad support.

### Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move (relative to the camera; strafes around your lock-on target) |
| Mouse | Aim / camera (the camera tracks your target while locked on) |
| `Space` (hold) | Boost upward |
| `Shift` | Quick-boost dash, with brief invulnerability. Aimed along your input, or at your target |
| Left mouse | Your gun (auto-reloads). With **Twin Sabers** equipped it swings the saber instead |
| Right mouse | Beam saber. Lunges at the target; press again mid-swing to chain a 3-hit combo |
| `E` | Missile salvo (4 homing missiles; charges recharge) |
| `F` | Shoulder cannon, if you fitted one (a heavy splash shell, 7 s recharge) |
| `V` | Your sub-weapon, if you fitted one (vulcans, flares or repair kit) |
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

## The garage

Eleven slots, tuning points and paint. Each part changes how your mech **looks** and how it **plays**, and the
right-hand panel shows the totals as bars. Hover a part to preview its effect on every stat (a white marker and a
+/- delta) before you equip it. Drag to rotate the turntable, scroll to zoom, and use the preview poses (idle, boost,
saber).

| Slot | Options |
| --- | --- |
| **Head** | V-Fin Sensor (balanced) · Mono-Eye Scout (light, tighter missile homing) · Commander Horn (faster burst gauge, stronger saber) · Sentinel Visor (tougher, harder to stagger) · Recon Array (much longer radar range) |
| **Torso** | Standard · Light Frame (fast, fragile, little power) · Heavy Plate (very tough, heavy) · Reactor Core (big power output, boost fuel, EN recovery) |
| **Arms** | Standard · Assault Bracers (armor, saber; slower reloads) · Precision Arms (faster fire and reload) · Blade Arms (big saber damage) |
| **Legs** | Standard · Sprint (fast, cheap dashes, low load limit) · Tank (armor, stagger resistance, highest load limit; slow) · Jump (climb and air EN recovery) |
| **Shoulder** | Standard · Bulwark Shells (armor, some gunfire absorption) · Ram Spikes (saber bonus) · Vernier Shoulders (turning and cheaper, faster dashes) |
| **Backpack** | Standard · Heavy Booster (boost fuel, climb) · Missile Pod (third missile charge, harder hits) · Wing Vernier (fast cheap dashes; fragile) |
| **Core** | Standard · Capacitor Bank (boost fuel and EN recovery) · Overclock Unit (BURST lasts 18 s) · Nano-Repair Core (mends 7 armor/s after 3 s without a hit) · Phase Governor (0.45 s dash invulnerability) |
| **Pilot** | Rookie · Gunner (reload, fire rate) · Duelist (saber, dash invulnerability) · Engineer (half your armor back between waves) · Evader (cheap dashes, turning) · Veteran (stagger resistance, burst gain) |
| **Weapon** | Beam Rifle · Rapid Beam Gun (30 rounds, low damage) · Blast Bazooka (3 explosive shells) · Beam Sniper (very fast heavy beams) · Twin Sabers (no gun, big melee bonus, deflects some gunfire) |
| **Off-hand** | Beam Shield (absorbs 22% of gunfire, missiles and shells) · Shoulder Cannon (`F`) · None (lighter) |
| **Sub-weapon** | None · Head Vulcans (hold `V`: a stream of rounds that also **shoots down missiles**; overheats) · Decoy Flares (`V`: detonates every missile homing on you; 12 s recharge) · Repair Kit (`V`: 15% armor over 4 s, one use per wave) |
| **Paint** | Six schemes or your own four colours, plus energy colour (beams, saber, eyes) and thruster colour |

### Two budgets and a tuning pool

- **Load.** Every part has a weight, and your **legs have a load limit** (shown as a marker on the LOAD bar).
  Weight scales your speed on its own (a stock build is the reference at 100%). Past the limit you also pay
  1.4% speed and dash speed per unit over, down to a floor of 55%. Tank legs carry the most, sprint legs the least.
- **Power.** Your **torso supplies power** and most parts **draw** it (shown on the POWER bar). If the draw
  exceeds the supply, EN recovery, weapon cycling and every cooldown (missiles, shoulder cannon, sub-weapon) slow
  down, and the penalty is steeper than the shortfall itself (never below 40%). The reactor
  torso supplies the most; stacking a booster, jump legs, a sniper and a cannon on a light frame will starve it.
- **Tuning.** Twelve free points across four dials, at most six on one: **Plating** (+4% armor per point),
  **Servos** (+2% speed and dash, +3% turning), **Thrusters** (+4% boost fuel, +1.5 climb) and **Weapons**
  (+3% damage, including missiles and sabers).

The garage warns in red when you are overloaded or power-starved, and the HUD repeats the warning during a sortie.
You can name your mech, press **Randomize** for ideas, or **Reset** to the stock Vanguard. Your build is saved in the
browser (`localStorage`) and used for every sortie; saves from before a slot existed load with sensible defaults. Open
the garage from the title screen or from the results screen.

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
src/data.js               enemy mech stats, palettes and wave definitions
src/parts.js              garage parts catalogue, load/power budgets, tuning, stat derivation, build validation (no browser code)
src/garage.js             the garage screen: tabs, option cards, stat bars with limit markers, tuning, paint, saved builds
vendor/three/             three.js r170 (MIT), vendored so the game runs offline
scripts/test.mjs          end-to-end test suite
serve.py                  tiny static server
```

The simulation runs on a fixed 60 Hz step independent of the display refresh rate. `window.__game` exposes the
running game for debugging (`__game.cheat.invincible = true` is handy for sightseeing).

## Tests

`scripts/test.mjs` first checks the parts maths in plain Node (every part's effect, weight scaling, input
sanitising), then loads the game in headless Chromium and plays it: the garage UI by real clicks (equip, hover
preview, paint, rename, random/reset, saved builds across a reload), movement, boosting, landing on roofs, building
collision (including a randomised stress run), every weapon, the shield, shoulder cannon, missile pod and weight
effects in actual combat (vulcans shooting down missiles, flares, the repair kit, regen core, overload and
power shortfalls, tuning), 25 random builds through a short fight each, each enemy type and the boss, a full
scripted playthrough to victory, a defeat and retry, and the pause/options UI. It fails on any console error.

```bash
npm i -D playwright       # once; a Chromium build must be available to Playwright
npm test                  # SHOTS=0 to skip screenshots, DEBUG=1 for the raw numbers
npm run lint              # needs eslint
```

Screenshots from each run are written to `out/test/` (git-ignored).

## Notes

- The mech designs and every garage part are original. They borrow the visual language of the real-robot anime genre (a V-fin hero,
  mono-eye grunts, a horned ace) but copy no existing machine. This is an independent fan-style project and is
  not affiliated with or endorsed by any anime studio or toy maker.
- three.js is © its authors, MIT licensed; see `vendor/three/LICENSE`.
