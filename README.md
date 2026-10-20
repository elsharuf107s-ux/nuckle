# Steel Vanguard

A 3D third-person mobile-suit combat game that runs in the browser, on desktop and on phones. **Build your own mech piece by piece** in the
garage (eleven slots and 75 parts, tuning points and paint, balanced by a load limit and a power budget), then take it through a dusk-lit colony city:
boost over rooftops, lock on, burn enemies down with your weapon, homing missiles and a three-hit beam-saber combo,
and survive five waves ending in a fight with the **Crimson Baron**. Between waves you drop into a **pit-stop garage**
to re-fit your mech for what comes next.

Everything is generated in code. There are no model, texture or audio files: mechs are built from primitives,
the city and sky are procedural, and every sound effect and the music are synthesised with WebAudio.

## Play

```bash
python3 serve.py          # http://localhost:8000   (or: python3 serve.py 3000)
```

Any static file server works. The only requirement is that it serves `.js` files with a JavaScript MIME type
(ES modules). Open the page and click **SORTIE** to launch with your current build (the stock VG-01 Vanguard the first time), or
**GARAGE** to build your own first. The game captures your mouse when a sortie starts. Press **Esc** to pause.
Any browser with WebGL works: desktop with keyboard and mouse, or a phone or tablet with the touch controls
described below. There is no gamepad support.

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
| `F` | Your off-hand ability, if you fitted one (shoulder cannon: a heavy splash shell; micro-missile arm: six small homing missiles) |
| `V` | Your sub-weapon, if you fitted one (vulcans, flares, repair kit, EN injector, shock pulse or aegis field) |
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

Clearing a wave restocks your ammo and missiles and repairs 25% of your armor, then, after a short banner, you
drop into the **pit stop**.

#### The pit stop

After waves 1 to 4 the game cuts to the garage, standing on the turntable, with a card at the top of the parts panel
that shows the wave you just cleared, **what the next wave contains** (so you can fit for it: more armor for the
Bulwarks, a shotgun for the drones, a jammer against the Baron's missiles) and your armor and score. It is the full
garage: swap any part, spend tuning points, repaint, or press **Randomize** for a gamble.

- Time stands still; the clock and your rank do not count pit-stop time.
- **No free repairs.** The new machine keeps the share of armor the old one had (50% before a swap is 50% after, of
  the new, perhaps larger, armor), and the garage cannot undo damage. Your pilot's wave repair has already happened.
- Whatever you fit comes with a full magazine and a full set of missiles and cooldowns.
- Your changes are saved, so the next sortie starts with the build you finished with.
- There is no way back to the title; the only exit is **LAUNCH WAVE N**, which puts you back exactly where you were
  standing and starts the next wave. After the Baron there is no pit stop: you win.
- Prefer a straight run? Switch **Pit stops** off in the pause menu and waves follow each other as before.

Finishing the sortie gives a rank (S/A/B/C) from combat score, clear time and remaining armor. Kills in quick
succession build a score multiplier.

The pause menu has look sensitivity, volume, a shadows toggle, pit stops, and a resolution scale. Lower the shadows
and resolution if the game runs slowly on integrated graphics. Settings are remembered in `localStorage`.

### Playing on a phone or tablet

Open the page on a touch device (landscape; upright shows a rotate prompt and pauses the sortie) and the touch
interface switches on by itself. Nothing is captured, so there is no pointer lock. Every control feeds the same input
layer as the keyboard, so the game plays identically.

| Touch | Action |
| --- | --- |
| Left thumb, anywhere on the left | Floating **move stick**, analog (a half push walks slower) |
| Drag on the right | Look around (when not locked on) |
| Tap an enemy | Lock onto it |
| **FIRE** (hold) | Your gun. With Twin Sabers it is the saber button |
| **SABER** | Beam saber, tap again to chain the combo |
| **MISSILE** | Missile salvo, shows charges and a recharge fill |
| **DASH** | Quick-boost dash |
| **BOOST** | Tap to latch boost on, tap again to stop; or hold it to boost only while held |
| **LOCK** / **SWITCH** / **RELOAD** | Lock-on on/off, next target, reload |
| **CANNON** / **SUB** / **BURST** | Appear only when you fitted a shoulder cannon or sub-weapon, or the burst gauge is full |
| **II** (top, by the radar) | Pause |

- **Aim assist** (on by default, switch it off in the pause menu): lock-on already starts by itself on the nearest
  enemy and tracks it, and with no lock, shots bend toward the enemy closest to your crosshair (a dashed amber ring
  shows which one). It only applies to the touch interface; desktop aiming is untouched.
- **Control size** in the pause menu scales the buttons. The layout respects notches and rounded corners.
- Phones start with shadows off and 75% resolution; raise them in the pause menu if your device copes.
- The garage works with fingers too: drag to turn the mech, pinch to zoom, and on narrow screens a **STATS / PARTS**
  button swaps between the parts list and the stat bars. The title screen has a **FULLSCREEN** button where the browser
  allows it (not iPhone Safari; use Share, then Add to Home Screen for the same effect).
- The touch controls are chosen by a coarse pointer, by the first finger that touches the page (touch laptops), or
  forced with `?touch=1` in the address (handy for trying them with a mouse; `?touch=0` forces them off). A mouse click
  between sorties switches a touch laptop back to desktop controls.

## The garage

Eleven slots, tuning points and paint. Each part changes how your mech **looks** and how it **plays**, and the
right-hand panel shows the totals as bars. Hover a part to preview its effect on every stat (a white marker and a
+/- delta) before you equip it. Drag to rotate the turntable, scroll to zoom, and use the preview poses (idle, boost,
saber).

| Slot | Options |
| --- | --- |
| **Head** | V-Fin Sensor (balanced) · Mono-Eye Scout (light, tighter missile homing) · Commander Horn (faster burst gauge, stronger saber) · Sentinel Visor (tougher, harder to stagger) · Recon Array (much longer radar range) · **Ace Visor** (quicker trigger, faster burst gauge) · **ECM Crown** (enemy missiles lose 40% of their turning) |
| **Torso** | Standard · Light Frame (fast, fragile, little power) · Heavy Plate (very tough, heavy) · Reactor Core (big power output, boost fuel, EN recovery) · **Missile Bay Chest** (an extra missile charge, harder missiles) · **Command Chest** (radar, burst gain, extra armor back between waves) |
| **Arms** | Standard · Assault Bracers (armor, saber; slower reloads) · Precision Arms (faster fire and reload) · Blade Arms (big saber damage) · **Guard Arms** (armor, stagger resistance, a little gunfire absorption) · **Heavy Recoil Arms** (gun damage +12%, slower cycling) |
| **Legs** | Standard · Sprint (fast, cheap dashes, low load limit) · Tank (armor, stagger resistance, highest load limit; slow) · Jump (climb and air EN recovery) · **Strider** (fast walking, longer dash) · **Siege** (very hard to stagger, steadier gun; slow) |
| **Shoulder** | Standard · Bulwark Shells (armor, some gunfire absorption) · Ram Spikes (saber bonus) · Vernier Shoulders (turning and cheaper, faster dashes) · **Missile Racks** (an extra missile charge, tighter homing) · **Aegis Emitters** (absorb 10% of gunfire) |
| **Backpack** | Standard · Heavy Booster (boost fuel, climb) · Missile Pod (third missile charge, harder hits) · Wing Vernier (fast cheap dashes; fragile) · **Generator Pack** (+28 power output) · **Armor Backplate** (armor and stagger resistance; weaker climb) |
| **Core** | Standard · Capacitor Bank (boost fuel and EN recovery) · Overclock Unit (BURST lasts 18 s) · Nano-Repair Core (mends 7 armor/s after 3 s without a hit) · Phase Governor (0.45 s dash invulnerability) · **Burst Siphon** (burst gauge fills 50% faster) · **Barrier Generator** (a 240-point barrier that soaks damage first and recharges 5 s after the last hit) |
| **Pilot** | Rookie · Gunner (reload, fire rate) · Duelist (saber, dash invulnerability) · Engineer (half your armor back between waves) · Evader (cheap dashes, turning) · Veteran (stagger resistance, burst gain) · **Marksman** (gun damage +12%, bigger radar) · **Tactician** (harder, tighter missiles) · **Guardian** (stagger resistance, 5% absorption, extra wave repair) |
| **Weapon** | Beam Rifle · Rapid Beam Gun (30 rounds, low damage) · Blast Bazooka (3 explosive shells) · Beam Sniper (very fast heavy beams) · Twin Sabers (no gun, big melee bonus, deflects some gunfire) · **Beam Shotgun** (seven pellets: brutal up close, thin at range) · **Seeker Rifle** (beams that curve onto your lock, or whatever is near the crosshair) · **Arc Lance** (a heavy beam that pierces every enemy in its line) · **Greatsword** (no gun, the biggest melee bonus and reach, deflects 28% of gunfire; heavy) |
| **Off-hand** | Beam Shield (absorbs 22% of gunfire, missiles and shells) · Shoulder Cannon (`F`) · None (lighter) · **Parry Buckler** (12% absorption, light, a little melee) · **Tower Shield** (30% absorption and stagger resistance; heavy and slow) · **Micro-Missile Arm** (`F`: six small homing missiles, 9 s recharge) |
| **Sub-weapon** | None · Head Vulcans (hold `V`: a stream of rounds that also **shoots down missiles**; overheats) · Decoy Flares (`V`: detonates every missile homing on you; 12 s recharge) · Repair Kit (`V`: 15% armor over 4 s, one use per wave) · **EN Injector** (`V`: refills boost fuel and clears an overheat; 16 s) · **Shock Pulse** (`V`: damages and staggers everything near you; 14 s) · **Aegis Field** (`V`: 2.5 s of total invulnerability; 22 s) |
| **Paint** | Six schemes or your own four colours, plus energy colour (beams, saber, eyes) and thruster colour |

Absorption from every source (shields, saber deflection, shoulder shells, emitters, guard arms, some pilots) adds up, capped at 35%. Missile
charges cap at four, and the burst gauge never fills more than twice as fast. Parts you have not tried are the fun part: a barrier core with a
tower shield and siege legs is a wall, but it is also heavy enough to be overloaded, and a shotgun brawler on a light frame
is quick and lethal but one mistake from scrap.

### Two budgets and a tuning pool

- **Load.** Every part has a weight, and your **legs have a load limit** (shown as a marker on the LOAD bar).
  Weight scales your speed on its own (a stock build is the reference at 100%). Past the limit you also pay
  1.4% speed and dash speed per unit over, down to a floor of 55%. Tank legs carry the most, sprint legs the least.
- **Power.** Your **torso supplies power** and most parts **draw** it (shown on the POWER bar). If the draw
  exceeds the supply, EN recovery, weapon cycling and every cooldown (missiles, off-hand ability, sub-weapon) slow
  down, and the penalty is steeper than the shortfall itself (never below 40%). The reactor
  torso supplies the most; stacking a booster, jump legs, a sniper and a cannon on a light frame will starve it.
- **Tuning.** Twelve free points across four dials, at most six on one: **Plating** (+4% armor per point),
  **Servos** (+2% speed and dash, +3% turning), **Thrusters** (+4% boost fuel, +1.5 climb) and **Weapons**
  (+3% damage, including missiles and sabers).

The garage warns in red when you are overloaded or power-starved, and the HUD repeats the warning during a sortie.
You can name your mech, press **Randomize** for ideas, or **Reset** to the stock Vanguard. Your build is saved in the
browser (`localStorage`) and used for every sortie; saves from before a slot existed load with sensible defaults. Open
the garage from the title screen or from the results screen, or meet it again in the pit stop between waves.

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
src/input.js              keyboard, mouse and touch state in one key set (plus the analog stick axis)
src/touch.js              on-screen touch controls: floating stick, look drag, tap-to-target, action buttons
src/hud.js                DOM bars plus canvas reticle, radar and damage numbers
src/missions.js           wave director; hands over to the pit stop between waves
src/audio.js              synthesised sound effects and music
src/data.js               enemy mech stats, palettes and wave definitions
src/parts.js              garage parts catalogue, load/power budgets, tuning, stat derivation, build validation (no browser code)
src/garage.js             the garage screen (also the pit stop): tabs, option cards, stat bars with limit markers, tuning, paint, saved builds
vendor/three/             three.js r170 (MIT), vendored so the game runs offline
scripts/test.mjs          end-to-end test suite (desktop)
scripts/test-touch.mjs    phone test: real multi-touch in an emulated phone, layouts at several sizes
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
power shortfalls, tuning), each new part's mechanic in combat (shotgun pellets, the seeker curving onto a target,
the lance piercing, the greatsword's reach, the barrier's soak and recharge, ECM jamming, micro-missiles, the EN
injector, shock pulse and aegis field), the pit stop (the card, no free repairs, launching back to the same spot, the
setting to turn it off, no pit after the boss), 25 random builds through a short fight each, each enemy type and the
boss, a full scripted playthrough to victory through four pit stops, a defeat and retry, and the pause/options UI. It
fails on any console error.

`scripts/test-touch.mjs` does the same for phones: an emulated touch device with real multi-touch (both thumbs at once),
the title, garage, HUD, pause and end screens at 844x390 and 667x375, every on-screen control, the analog stick, tap to
lock on, the soft aim (including a shot that only lands with the assist), the pause and rotate behaviour, and that the
desktop page is unchanged.

```bash
npm i -D playwright       # once; a Chromium build must be available to Playwright
npm test                  # both suites; SHOTS=0 to skip screenshots, DEBUG=1 for the raw numbers
npm run test:desktop      # just the desktop suite
npm run test:touch        # just the phone suite
npm run lint              # needs eslint
```

Screenshots from each run are written to `out/test/` (git-ignored).

## Notes

- The mech designs and every garage part are original. They borrow the visual language of the real-robot anime genre (a V-fin hero,
  mono-eye grunts, a horned ace) but copy no existing machine. This is an independent fan-style project and is
  not affiliated with or endorsed by any anime studio or toy maker.
- three.js is © its authors, MIT licensed; see `vendor/three/LICENSE`.
