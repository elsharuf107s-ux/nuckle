# Steel Vanguard

A 3D third-person mobile-suit combat game that runs in the browser, on desktop and on phones. **Build your own mech piece by piece** in the
garage (eleven hardpoints you click on the mech, 97 parts, tuning points and paint, balanced by a load limit and a power budget), then take it through a dusk-lit colony city:
boost over rooftops, lock on, burn enemies down with your weapon, homing missiles and a boost lunge into a four-hit
beam-saber combo, and survive five waves ending in a fight with the **Crimson Baron**. Every sortie opens with a catapult
launch, and the machines move like the mobile suits in the versus games: snap shots, saber draws, hard-leaning steps
with afterimages, knockdowns and sparking wrecks. The city is destructible: shells, missiles, sabers and exploding machines
bring floors down, collapses crush whoever is underneath, and flattened blocks become rubble you can walk over. Between waves you drop into a **pit-stop garage**
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
| Right mouse | Beam saber. Boosts in at a target that is out of reach, then swings; press again mid-swing to chain forehand, backhand, thrust and an overhead finisher that knocks the target down |
| `E` | Missile salvo (4 homing missiles; charges recharge) |
| `F` / `G` | Your shoulder mounts, if you fitted them: the first mount fires on `F`, the second on `G` (shoulder cannon: a heavy splash shell; micro-missile pod: six small homing missiles; rail lance: a piercing slug) |
| `V` | Your sub-weapon, if you fitted one (vulcans, flares, repair kit, EN injector, shock pulse or aegis field) |
| `Q` | Toggle lock-on |
| `Tab` | Switch lock-on target |
| `R` | Reload |
| `X` | **Burst**, when the gauge is full: unlimited boost, +50% damage, faster fire, partial repair |
| `M` | Mute |

Dash to dodge, use the saber to close gaps and break enemy guard, and keep an eye on the **EN** bar: boosting
to zero overheats the thrusters until they recover. The burst gauge fills as you deal damage and score kills.

### How the machines move

The animation is modelled on the mobile-suit versus games: fast, readable, with a strong pose held at every key moment.

- **Shooting.** The gun arm snaps straight down the line of fire, the chest turns side-on, and the pose holds for half
  a second before it eases back to the ready. Heavy guns (bazooka, sniper, shotgun, lance) are held in both hands.
  Shoulder cannons track your aim and slide back when they fire, and heavy shots brace the legs.
- **The saber.** Drawing it clips the gun to the rear skirt, reaches over the shoulder for the hilt on the backpack and
  ignites the blade; putting it away racks the hilt and takes the gun back. A press at a target out of reach boosts in
  first, chest down and blade trailing, then the combo runs forehand, backhand, a thrust, and an overhead finisher.
- **Knockdowns.** A combo's finisher throws the target onto its back, whether the combo is yours, a Striker's or the
  Baron's. It lies there a moment, then thrusts itself back up. While you are down you cannot be hit. The Baron never
  goes down.
- **Movement.** Jumps crouch before they push off. Steps lean hard into their direction, leave afterimages and speed
  lines, and end in a skid. Boosting forward through the air tips the body into a flight pose. A really hard landing
  drops to one knee.
- **Taking hits.** Every hit snaps the chest and head back from where it came from and lets them settle on springs.
- **Destroyed machines** spark, convulse and sink to their knees for a moment before they explode. Every kill gets a beat
  of slow motion and a camera punch, a longer one for the last enemy of a wave.
- **Secondary motion.** Skirt plates are pushed out by the thighs and swing on their hinges, shoulder pads ride the arms,
  wing binders spread under thrust, whip antennas sway, and crests rattle on impact.
- **The catapult.** A sortie opens on a launch deck north of the plaza: the lights count down while the mech crouches on
  the shuttle, the shuttle throws it down the deck, and the chase camera takes over once it is airborne.

### A destructible city

Every building is a stack of floors (one row of windows each) with a structural strength that grows toward the ground,
because the floors below carry the ones above. Everything damages the floors around where it lands, yours and the enemy's:

| Source | Against a building |
| --- | --- |
| Beam shots | chip a floor (a magazine of rifle shots will not bring a tower down) |
| Machine-gun bullets | barely scratch it |
| Bazooka, cannon and missiles | break floors; the blast spreads over the floors and buildings around the impact, even when the shell hit a mech |
| Saber strokes | cut into the wall in front of you (the combo's finisher cuts hardest); enemy sabers do too |
| A machine blowing up | damages the walls beside it |

When a floor gives way, **it and everything above it comes down**:

- The roof section pancakes onto what is left in a cloud of dust, windows tumble down as glowing chunks, the roof
  machinery and beacon masts fall off, and the stump smoulders under a column of smoke with a jagged crown of broken slabs
  and bent rebar. The height, the collision and the cover all follow: shots and mechs go through where the walls were.
- **A mech standing on the roof falls with it** and is hurt. Debris also hurts and shoves anything near the foot of the
  building (yours and theirs, and never twice within a second). Fighting in the shadow of a tower you are about to topple is a bad idea.
- Bring down the lowest floors and the building is **flattened** to a mound of rubble with a scorched patch under it.
  The rubble has no collision: walk or fly over it. A flattened block opens new lines of fire.
- Walls that have been hit show scorch marks, and smoulder once their structure is in a bad way.
- Damage carries over from wave to wave (the pit stop does not repair the city); a new sortie puts every building back.
  The results screen counts the structures brought down.

A competent run brings down some thirty roof sections and flattens a few blocks, so the city is chewed up rather than
erased; a bazooka build flattens more.

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
| **CANNON** / **MOUNT** / **SUB** / **BURST** | Appear only when you fitted shoulder mounts (one button per mount, labelled for its weapon) or a sub-weapon, or the burst gauge is full |
| **II** (top, by the radar) | Pause |

- **Aim assist** (on by default, switch it off in the pause menu): lock-on already starts by itself on the nearest
  enemy and tracks it, and with no lock, shots bend toward the enemy closest to your crosshair (a dashed amber ring
  shows which one). It only applies to the touch interface; desktop aiming is untouched.
- **Control size** in the pause menu scales the buttons. The layout respects notches and rounded corners.
- Phones start with shadows off and 75% resolution; raise them in the pause menu if your device copes.
- The garage works with fingers too: tap a hardpoint marker, drag the background to turn the mech, pinch to zoom, and on narrow screens a **STATS / PARTS**
  button swaps between the parts list and the stat bars. The title screen has a **FULLSCREEN** button where the browser
  allows it (not iPhone Safari; use Share, then Add to Home Screen for the same effect).
- The touch controls are chosen by a coarse pointer, by the first finger that touches the page (touch laptops), or
  forced with `?touch=1` in the address (handy for trying them with a mouse; `?touch=0` forces them off). A mouse click
  between sorties switches a touch laptop back to desktop controls.

## The garage

Rotate your mech on the turntable and **click a hardpoint on it**: a marker floats over the head, each shoulder, the
chest, the arms, the legs, the backpack, the waist, each hand and the hip. The camera swings to that spot and its
parts open in an inventory grid, with a detail strip below showing the full description and every stat of the part
you point at. Each part changes how your mech **looks** and how it **plays**, and the right-hand panel shows the
totals as bars: hover a part to preview its effect on every stat (a white marker and a +/- delta) before you equip it.
Drag the background to rotate, scroll or pinch to zoom, and use the preview poses (idle, boost, saber). The tab strip
at the top of the panel opens the same hardpoints (plus tuning and paint) from the keyboard or when a marker is
hard to reach.

- **Hardpoints with several slots** show sub-tabs: the head holds the **helmet** and a **crest** (any crest on any helmet;
  `helmet default` keeps the one that suits it), the chest the **frame** and the **pilot**, the waist the **core** and
  the **skirt**, and each shoulder an **armor** pad and a **weapon mount**.
- **Left and right shoulders are separate.** Shoulder armor values are per side, so a matched pair gives the full
  bonus and a mismatched pair half of each. The **SYMMETRY** switch (on by default) fits a pick on both sides; turn it off
  to build a lopsided suit, for example a cannon on the left shoulder and a micro-missile pod on the right.
- **Two weapon mounts.** The first mount you fit fires on `F`, the second on `G`, each with its own cooldown and HUD bar.
- **The hangar** is the bar of six slots at the top: each holds a whole build, **COPY** duplicates the current one into
  the next empty slot, **CLEAR** empties a slot, and the one on the pad is what a sortie fields. (In the pit stop between
  waves the hangar is locked, so the pit stop stays a re-fit and not a free swap.) Everything is saved in the browser.
- **Paint** has schemes, four custom colours, energy and thruster colours, and **markings** (stripes, chevrons or
  hazard bands).

Every part changes the model: the suit is built in the real-robot style (a long-legged, narrow-waisted frame with
broad shoulder pads, a face mask with a forehead camera, vents, a V-shaped knee mark, saber hilts racked on the
backpack and a long beam shield) and every one of the 97 parts has its own silhouette. The enemies are built from the
same kit: a domed green grunt, a winged blade-fighter, an orange tank and the red command Baron.

| Slot | Options |
| --- | --- |
| **Helmet** | V-Fin Sensor (balanced) · Mono-Eye Scout (light, tighter missile homing) · Commander Horn (faster burst gauge, stronger saber) · Sentinel Visor (tougher, harder to stagger) · Recon Array (much longer radar range) · Ace Visor (quicker trigger, faster burst gauge) · ECM Crown (enemy missiles lose 40% of their turning) · **Knight Helm** (tough and steady, heavy) · **Hawk Sight** (long radar, tight missile tracking) · **Twin-Eye Helm** (quicker trigger and reloads) |
| **Crest** | Helmet default · V-Fin · Command Horn · Blade Crest · Twin Antenna · Spike Crown · No crest (cosmetic) |
| **Frame** | Standard · Light Frame (fast, fragile, little power) · Heavy Plate (very tough, heavy) · Reactor Core (big power output, boost fuel, EN recovery) · Missile Bay Chest (an extra missile charge, harder missiles) · Command Chest (radar, burst gain, extra armor back between waves) · **Wedge Frame** (angular, nimble, a little armor) · **Ranger Frame** (boost fuel, steadier climb) |
| **Arms** | Standard · Assault Bracers (armor, saber; slower reloads) · Precision Arms (faster fire and reload) · Blade Arms (big saber damage) · Guard Arms (armor, stagger resistance, a little gunfire absorption) · Heavy Recoil Arms (gun damage +12%, slower cycling) |
| **Legs** | Standard · Sprint (fast, cheap dashes, low load limit) · Tank (armor, stagger resistance, highest load limit; slow) · Jump (climb and air EN recovery) · Strider (fast walking, longer dash) · Siege (very hard to stagger, steadier gun; slow) |
| **Shoulder armor** (per side) | Standard · Bulwark Shell (armor, some gunfire absorption) · Ram Spike (saber bonus) · Vernier Shoulder (turning and cheaper, faster dashes) · Missile Rack (harder missiles, tighter homing) · Aegis Emitter (absorbs 5% of gunfire) · **Fin Pauldron** (steadier turning, quicker dash) · **Dome Guard** (armor and stagger resistance without the weight) |
| **Weapon mount** (per side) | None · Shoulder Cannon (a heavy splash shell, 7 s) · Micro-Missile Pod (six small homing missiles, 9 s) · **Rail Lance** (a fast slug that pierces everything in its line, 8 s) |
| **Backpack** | Standard (with racked saber hilts) · Heavy Booster (boost fuel, climb) · Missile Pod (third missile charge, harder hits) · Wing Vernier (fast cheap dashes; fragile) · Generator Pack (+28 power output) · Armor Backplate (armor and stagger resistance; weaker climb) |
| **Core** | Standard · Capacitor Bank (boost fuel and EN recovery) · Overclock Unit (BURST lasts 18 s) · Nano-Repair Core (mends 7 armor/s after 3 s without a hit) · Phase Governor (0.45 s dash invulnerability) · Burst Siphon (burst gauge fills 50% faster) · Barrier Generator (a 240-point barrier that soaks damage first and recharges 5 s after the last hit) |
| **Skirt** | Standard · **No skirt** (lighter, quicker EN recovery) · **Long Tails** (a little armor) · **Fortress Skirt** (lots of armor and stagger resistance; heavy) · **Flare Skirt** (steadier turning, quicker dash) · **Skirt Thrusters** (stronger climb, quicker air recovery) |
| **Pilot** | Rookie · Gunner (reload, fire rate) · Duelist (saber, dash invulnerability) · Engineer (half your armor back between waves) · Evader (cheap dashes, turning) · Veteran (stagger resistance, burst gain) · Marksman (gun damage +12%, bigger radar) · Tactician (harder, tighter missiles) · Guardian (stagger resistance, 5% absorption, extra wave repair) |
| **Weapon** (right hand) | Beam Rifle · Rapid Beam Gun (30 rounds, low damage) · Blast Bazooka (3 explosive shells) · Beam Sniper (very fast heavy beams) · Twin Sabers (no gun, big melee bonus, deflects some gunfire) · Beam Shotgun (seven pellets: brutal up close, thin at range) · Seeker Rifle (beams that curve onto your lock, or whatever is near the crosshair) · Arc Lance (a heavy beam that pierces every enemy in its line) · Greatsword (no gun, the biggest melee bonus and reach, deflects 28% of gunfire; heavy) |
| **Off-hand** (left hand) | Beam Shield (absorbs 22% of gunfire, missiles and shells) · None (lighter and quicker) · Parry Buckler (12% absorption, light, a little melee) · Tower Shield (30% absorption and stagger resistance; heavy and slow) |
| **Sub-weapon** (hip) | None · Head Vulcans (hold `V`: a stream of rounds that also **shoots down missiles**; overheats) · Decoy Flares (`V`: detonates every missile homing on you; 12 s recharge) · Repair Kit (`V`: 15% armor over 4 s, one use per wave) · EN Injector (`V`: refills boost fuel and clears an overheat; 16 s) · Shock Pulse (`V`: damages and staggers everything near you; 14 s) · Aegis Field (`V`: 2.5 s of total invulnerability; 22 s) |

Absorption from every source (shields, saber deflection, shoulder pads, emitters, guard arms, some pilots) adds up, capped at 35%. Missile
charges cap at four, and the burst gauge never fills more than twice as fast. Saves from before the hangar and the split
shoulders load automatically (the old single shoulder fits both sides, and an old off-hand shoulder cannon moves to the
left mount).

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
You can name your mech, press **Randomize** for ideas, or **Reset** to the stock mech. Your hangar is saved in the
browser (`localStorage`) and the build on the pad is used for every sortie. Open the garage from the title screen or from
the results screen, or meet it again in the pit stop between waves.

## Project layout

```
index.html, style.css     page shell, HUD markup and menus
src/main.js               entry point: screens, pause, pointer lock, saved options
src/game.js               renderer, fixed-timestep loop, damage/kill/score rules, win and lose
src/world.js              procedural city of floor-stacked buildings, sky shader, lighting, the launch catapult, collision queries
src/destruction.js        the destructible city: per-floor damage, collapses, rubble, scorch marks, debris damage to mechs
src/mechModel.js          assembles a mech from a spec and hands it to the motion layer; locates the garage's hardpoint anchors
src/model/                the geometry: kit.js (shared geometry and materials), skeleton.js (proportions), body.js (pelvis and hinged skirt,
                          legs, torso, arms), head.js (helmets, crests, whip antennas), gear.js (backpacks, shoulders and mounts, weapons and
                          the rear-skirt holster, off-hands, sub-weapons, markings)
src/model/motion.js       the animation: planted-foot gait with two-bone leg IK, jump crouch, steps, flight, skids and kneeling landings;
                          firing poses, two-handed grips and the saber draw (two-bone arm IK); swings, lunges, knockdowns, the breakdown
                          of a wreck; hit reactions and the secondary motion on springs
src/mech.js               mech physics: walk, jump, boost, dash, skids, knockdowns, collision, damage
src/player.js             input to intent, lock-on, rifle, missiles, saber lunge and combo, burst
src/ai.js                 Drone / Striker / Bulwark / Baron behaviours
src/weapons.js            projectiles with swept collision and homing
src/fx.js                 particles, explosions, dust clouds, smoke plumes, debris chunks, saber arcs and thrust streaks, afterimages
src/camera.js             chase camera with lock-on framing, trauma shake, kill punches and scripted shots (the launch)
src/input.js              keyboard, mouse and touch state in one key set (plus the analog stick axis)
src/touch.js              on-screen touch controls: floating stick, look drag, tap-to-target, action buttons
src/hud.js                DOM bars plus canvas reticle, radar and damage numbers
src/missions.js           wave director; hands over to the pit stop between waves
src/audio.js              synthesised sound effects and music
src/data.js               enemy mech stats, palettes and wave definitions
src/parts.js              garage parts catalogue, hardpoints, load/power budgets, tuning, stat derivation, build validation (no browser code)
src/hangar.js             the six-slot hangar: pure state (select, copy, clear, migrate old saves) plus save/load (no browser code)
src/garage.js             the garage screen (also the pit stop): hardpoint markers on the 3D mech, inventory grid, symmetry, hangar bar, stat bars with limit markers, tuning, paint
vendor/three/             three.js r170 (MIT), vendored so the game runs offline
scripts/test.mjs          end-to-end test suite (desktop)
scripts/test-touch.mjs    phone test: real multi-touch in an emulated phone, layouts at several sizes
serve.py                  tiny static server
```

The simulation runs on a fixed 60 Hz step independent of the display refresh rate. `window.__game` exposes the
running game for debugging (`__game.cheat.invincible = true` is handy for sightseeing).

## Tests

`scripts/test.mjs` first checks the parts maths in plain Node (every part's effect, weight scaling, input
sanitising, the old-save migration), then loads the game in headless Chromium and plays it: the garage UI by real clicks
(a marker over each of the 11 hardpoints and the camera swinging to the one you click, sub-tabs, equip, hover preview,
the symmetry switch and lopsided shoulders, both weapon mounts firing on F and G, markings, the six-slot hangar with
copy and clear, paint, rename, random/reset, saved builds across a reload), that every one of the 97 parts builds a
model standing on the ground and that no option reuses another's silhouette, movement, boosting, landing on roofs, building
collision (including a randomised stress run), every weapon, the shield, shoulder cannon, missile pod and weight
effects in actual combat (vulcans shooting down missiles, flares, the repair kit, regen core, overload and
power shortfalls, tuning), each new part's mechanic in combat (shotgun pellets, the seeker curving onto a target,
the lance piercing, the greatsword's reach, the barrier's soak and recharge, ECM jamming, micro-missiles, the EN
injector, shock pulse and aegis field), the pit stop (the card, no free repairs, launching back to the same spot, the
setting to turn it off, no pit after the boss), 25 random builds through a short fight each, each enemy type and the
boss, a full scripted playthrough to victory through four pit stops, a defeat and retry, the pause/options UI, and the
animation (planted feet do not slide or sink when walking, strafing, backing up or for enemies of any size; strafes
turn the hips; dashes glide; landings crouch; the saber slashes sweep the right way and never cut the ground; the
garage previews the combo at full speed), and every versus-style move: the firing pose snapping level onto the target and
holding, the two-handed grip, the saber draw and sheath (hand at the hilt, gun on the rear skirt), the jump crouch, the
step lean and skid, the flight pose, the kneeling landing, the skirt, antenna and wing motion, the shoulder mount aim and
kick, the hit flinch, a knockdown with no damage taken on the ground, a wreck sinking before it explodes, the kill slow
motion, the boost lunge with afterimages and speed lines into the four-hit combo and its knockdown finisher, and the
catapult launch from the deck to the plaza, and the destructible city (floors, scorch marks, a magazine of rifle shots
that chips but does not topple, machine-gun bullets that barely scratch, a shell taking whole floors off with the
collision, mesh and chunks following, a mech riding a collapsing roof down and being hurt, debris hurting what is at the
foot and not what is far, rubble that is walkable with spawns unharmed, enemy fire, sabers and exploding wrecks all
breaking walls, the caps on marks, chunks and smoke, no leaked meshes, and the whole city restored for a new sortie).
It fails on any console error.

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
