# Pokémon Redstone

Minecraft's Steve dropped into Pokémon FireRed. The whole outdoor Kanto overworld is stitched from
FireRed's own maps, and every tile in it is a block: trees can be punched down, cliffs mined for ore,
houses built and torn down again. The wild Pokémon in the grass are fought on FireRed's battle
screen, with Steve as the battler and hearts where the HP bar would be.

Unofficial fan project. Not affiliated with or endorsed by Nintendo, Game Freak, Creatures, The Pokémon Company, Mojang or Microsoft.

- **Survival**: health, hunger, saturation and exhaustion, knockback, armor, XP orbs and levels, the
  attack cooldown and jump crits, all with Java Edition's numbers.
- **Buildings and caves you can enter**: 152 FireRed rooms (every Poké Center, Mart, house, lab, gym
  and gatehouse, the Dept Store, Pokémon Tower, Viridian Forest, Mt Moon, Rock Tunnel, Diglett's Cave,
  Victory Road, Seafoam, Cerulean Cave, the Power Plant) joined by FireRed's own warps. Rooms have their
  people with their FireRed lines; the nurse heals and becomes the respawn point.
- **Mining**: break time from tool speed, block hardness and harvestability. Ores depend on depth;
  trees fall whole; mined cliffs and cave walls re-edge themselves with FireRed's tiles. Buildings
  can't be mined or blown up, except their doors.
- **Crafting, smelting and building**: the inventory, crafting table, furnace and chest screens with
  the recipe book; Minecraft's recipes plus Poké Balls, Great Balls and Ultra Balls. Planks,
  cobblestone, glass, doors, fences, beds, chests, signs, torches and TNT.
- **Mobs, farming, fishing, boats**: zombies, skeletons, creepers and spiders at night; cows, sheep,
  pigs and chickens; wheat; a fishing rod that hooks water Pokémon; boats.
- **Wild Pokémon you can see**: each route, cave and the forest spawns its own FireRed species walking
  around. Some run off, some chase you into a battle. Walk into one or press Z at it.
- **Battles**: FIGHT uses the held tool (sword, jump for crits, punch, bow, TNT), weapon durability
  stands in for PP, and BAG throws the balls Steve crafted. Caught Pokémon join the party and the first
  one follows Steve around.
- **The Nether, a stronghold and The End**, the Ender Dragon and the Wither, Poké Marts, villages and
  villager trading, advancements.
- **Generated worlds**: besides Classic Kanto, the title menus make Wild Worlds and Kanto Worlds from a
  seed, in Survival, Hardcore or Creative.

## What this repository contains

Only original code, tools and docs. No graphics, maps, fonts, music or sounds from either game are
included. The code does contain short in-game text and names written in by hand (some FireRed battle
and menu messages, Minecraft item and advancement names) and a few game values. `./setup.sh` downloads the public FireRed decompilation and Minecraft's own assets at
pinned versions and builds every picture, sound and data file the game uses on your machine.
Third-party assets are fetched and built locally and never included here, and `.gitignore` keeps them
out of commits.

## Setup

You need `bash`, `git` 2.25 or newer, `curl`, Python 3.10 to 3.13 with `venv`, `ffmpeg` and `ffprobe`
built with libopus (Homebrew's and most Linux distributions' are), about 1 GB of free memory and network
access to github.com, pypi.org and Mojang's servers.

```bash
git clone https://github.com/Mozetech/pokemon-redstone
cd pokemon-redstone
./setup.sh
python3 serve.py
```

Then open http://localhost:5300 (`python3 serve.py 8000` picks another port). Add `?new` to the URL
to ignore a saved game, `?play` to skip the title.

A first run takes about 20 minutes on an idle machine, longer on a busy one (most of it ray-casting the eight other player skins) and uses
about 240 MB of disk: 120 MB of sources in `vendor/`, 55 MB for `.venv/` and 60 MB of built `assets/`;
the 28 MB `client.jar` is deleted once its textures are unpacked. The build peaks at about 750 MB of
memory. Setup prints its own time and sizes at the end. It does this:

1. Fetches [pret/pokefirered](https://github.com/pret/pokefirered) at `c75f352` into
   `vendor/pokefirered` (a shallow clone of that one commit) and
   [rh-hideout/pokeemerald-expansion](https://github.com/rh-hideout/pokeemerald-expansion) at `160396e`
   into `vendor/pokeemerald-expansion`. The expansion is large, so that fetch is sparse and blobless: only
   the 288 overworld sprite files (96 species) the build reads are downloaded.
2. Runs `tools/fetch_minecraft.py`, which downloads Minecraft 1.21.4 from Mojang's servers: the version
   manifest, the version file, `client.jar` (only its `textures/` folder is unpacked, then the jar is
   deleted), asset index 19, `sounds.json` and the 732 sounds listed in `tools/minecraft-sounds.txt`.
   The version file, jar and index are pinned by SHA-1 and each sound is checked against the index.
3. Checks each of the 3,713 upstream files the build reads against its SHA-1 in
   `tools/upstream-inputs.tsv`.
4. Creates `.venv/` with numpy 2.2.2 and Pillow 11.1.0.
5. Runs the build tools in order (each step prints its time; the full log is in `.build.log`):
   `build_end_assets.py`, `build_world.py`, `build_music.py`, `build_minecraft.py` (twice, the second
   time with `--skins`), `build_pokemon.py` (twice, the second time with `--world`),
   `build_menu_assets.py`, `build_villagers.py`, `build_minimap.py`, `build_kanto_sign.py` and
   `build_extras.py`.
6. Checks all 1,869 built files against `tools/assets.tsv`. With the pinned packages they are
   byte-identical to the reference build. Another Pillow, zlib, ffmpeg or libopus may encode a file
   differently, so a file that differs in bytes is accepted when its content matches: a PNG's decoded
   pixels, a JSON file's parsed data, or a sound's length for the music and the two cries ffmpeg
   encodes.

Running it again skips whatever is already done and verified. Options:

| Option | What it does |
| --- | --- |
| `--rebuild` | build `assets/` again even if it verifies |
| `--prune` | delete `vendor/` and `.venv/` afterwards; `assets/` (60 MB) is all the game needs |
| `POKEFIRERED_SRC=<dir>` | fetch pret/pokefirered from a local clone that has the pinned commit, not GitHub |
| `EXPANSION_SRC=<dir>` | the same for pokeemerald-expansion |
| `PYTHON=<python>` | build the venv with this interpreter |

On Python 3.14 or newer the pinned wheels do not exist, so setup installs the current numpy and
Pillow and the content checks apply.

The Wither's and the beacon's sounds are not in `tools/minecraft-sounds.txt`, so they play silently,
as in the reference build. Add their paths to that list (`mob/wither/...`, `block/beacon/...`) and run
`./setup.sh --rebuild` to hear them; `tools/assets.tsv` then no longer matches for the sound files
involved (`python3 tools/verify.py record` rewrites it).

## Controls

| Key | What it does |
| --- | --- |
| Arrows / WASD | move |
| Z (hold) | mine, attack, talk |
| X | use, place, eat |
| Space | jump |
| Shift | sprint |
| E | inventory |
| Q | drop |
| 1 to 9, mouse wheel, C / V | pick the hotbar slot |
| Enter | FireRed's start menu |
| J | map |
| M | music on or off |

On touch devices an on-screen pad appears.

Co-op needs a room relay server, which is not part of this repository; without one, CO-OP > HOST
shows "Co-op is busy right now. Try again later."

## Tests and videos (optional)

```bash
npm install                                      # Playwright; it drives your installed Google Chrome
node tools/headless.mjs tools/smoke.mjs --params '?new' --out out/smoke
```

`tools/smoke.mjs` boots the title screen, starts a new Classic Kanto game, walks, punches a tree down,
fights a wild battle with the keys, then makes a new Wild World through the title menus and walks in
it, failing on any page error. `tools/gen_tests/` holds the rest of the test suite (each file says how
to run it; a few compare against an earlier build kept in `out/baselines/`). `tools/render_video.mjs`,
`render_trailer.mjs` and `render_showcase.mjs` drive the game frame by frame and write MP4s with
ffmpeg. Screenshots and videos show game graphics, so they stay in `out/`, which is ignored.

## How it works

`tools/build_world.py` reads every FireRed map, layout, tileset and script in the decompilation,
stitches the outdoor maps through their connections, packs the rooms and caves below them, and gives
every cell a reference into a tile atlas whose entries carry a behaviour, a collision and a material
(a tree is oak logs, a cliff is stone, a red roof is bricks). Cliff faces get ore veins painted from
Minecraft's ore textures. The Nether, the stronghold and The End are generated regions in the same
grid (`build_nether.py`, `build_stronghold.py`, `build_end.py`), and `build_terrain.py` makes the tile
bank the generated worlds draw from.

`tools/build_minecraft.py` turns Minecraft's textures into the item icons, block looks, GUI and font,
and ray-casts Steve, the mobs, the Ender Dragon and the Wither from their box models
(`tools/mcmodel.py`, `tools/models.py`) into a slightly top-down view that matches FireRed's camera.
`tools/build_pokemon.py` writes the battle screen, every Pokémon's sprites, icons and cries, the fonts,
the party menu and `pokemon.json` (species, moves, learnsets, types and EXP curves parsed from the
decompilation's C tables by `tools/extract_data.py`). `tools/build_music.py` is an M4A player that
renders FireRed's songs from the decompilation's MIDI files, voicegroups and samples.

The game itself is plain JavaScript modules in `src/` with no build step: `src/main.js` (state machine,
input, saving), `src/world.js` and `src/chunks.js` (the block world), `src/player.js`, `src/items.js`
and `src/entities.js` (Steve, items, mobs), `src/battle.js` (a Gen 3 battle engine on FireRed's battle
screen), `src/gen/` (the seeded world generator, run in a Worker), `src/ui/` (Minecraft's menus and the
title menus) and `src/net/` (co-op).

## Layout

- `setup.sh` fetch, check, build and verify
- `tools/fetch_minecraft.py`, `tools/minecraft-sounds.txt` Minecraft's files from Mojang's servers
- `tools/verify.py`, `tools/upstream-inputs.tsv`, `tools/assets.tsv` hash checks (hashes only)
- `tools/build_*.py` and their helpers (`fr.py`, `mcdata.py`, `mcmodel.py`, `models.py`, `autotile.py`,
  `pix.py`, `extract_data.py`, `villager_trades.py`, `trade_check.py`) the asset pipeline
- `tools/headless.mjs`, `tools/smoke.mjs`, `tools/gen_tests/` headless tests
- `tools/render_*.mjs` videos; `tools/dev.js` browser console helpers
- `src/` the game; `index.html`, `serve.py` the page and a local static server

## Credits

- [pret/pokefirered](https://github.com/pret/pokefirered), the FireRed decompilation: every map,
  metatile and tileset, the scripts and text of the rooms' people, the wild encounter tables, battle
  terrains, text boxes, healthboxes, fonts, the party screen, every Pokémon's sprites and cries, the
  species and move data, and the music, rendered from its MIDI files, voicegroups and samples.
- [rh-hideout/pokeemerald-expansion](https://github.com/rh-hideout/pokeemerald-expansion) and the
  artists credited there: the overworld sprites of the follower Pokémon.
- Minecraft 1.21.4 by Mojang: block and item textures, the GUI, the font and the sounds, downloaded
  from Mojang's asset servers by `tools/fetch_minecraft.py`.

Pokémon and all related names are trademarks of Nintendo, Game Freak, Creatures and The Pokémon
Company. Minecraft is a trademark of Mojang Synergies AB.
