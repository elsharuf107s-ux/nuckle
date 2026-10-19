# Play and modify Pokémon Redstone

This repository contains the editable source from [Mozetech/pokemon-redstone](https://github.com/Mozetech/pokemon-redstone). See UPSTREAM.md for the imported revision and README.md for the original documentation.

## GitHub Codespaces

Create a Codespace from this repository (or rebuild an existing Codespace's container). The dev container installs Python 3.12, Node 22, FFmpeg with Opus, and Chromium. It runs `bash scripts/setup-dev.sh` to install test dependencies and build the assets. The first asset build may take about 20 minutes.

After setup, the development server starts on port **5300**. Open the **Ports** tab and choose **Open in Browser** for that port. Keep its visibility private. If you stopped the server, run:

```bash
bash scripts/start-dev.sh
```

For a foreground server instead, run `python3 scripts/dev-server.py`. It binds to `0.0.0.0` so Codespaces can forward the port. Logs for the background server are in `out/dev/server.log`; its PID is in `out/dev/server.pid`. To stop it, use `kill "$(cat out/dev/server.pid)"`.

## Setup in another cloud environment

Use the existing checkout; do not create an additional worktree. Install Python 3.10–3.13 with venv, Node.js, Git, curl, FFmpeg/ffprobe with libopus, and Chromium, then run:

```bash
bash scripts/setup-dev.sh
bash scripts/start-dev.sh
node scripts/smoke.mjs
```

Setup downloads pinned sources from GitHub and verifies upstream inputs and generated assets. The asset build also requires HTTPS access to `piston-meta.mojang.com`, `piston-data.mojang.com`, and `resources.download.minecraft.net`; Python and Node dependencies use PyPI and the npm registry. If access is denied, allow those domains in the environment settings and rerun setup. Do not disable TLS or checksum checks.

The smoke test uses the upstream test suite to exercise the title menu, movement, mining, battles, and a generated world. Screenshots and results go to ignored `out/smoke/`. Set `CHROMIUM_PATH` if Chromium is installed at a nonstandard location.

## Controls

Arrows/WASD move; Z mines, attacks, and talks; X uses and places items; Space jumps; Shift sprints; E opens inventory; Enter opens the menu; J opens the map. Click the game first to give it keyboard focus.

## Make changes

- `src/main.js`: input, saves, and the main game state.
- `src/player.js`, `src/items.js`, `src/entities.js`: player, items, and mobs.
- `src/battle.js`: Pokémon battles.
- `src/world.js`, `src/gen/`: world behavior and generation.
- `src/ui/`: menus and inventory.
- `tools/build_*.py`: asset generation. After editing these tools, run `./setup.sh --rebuild`; intentional asset changes may differ from upstream's reference checksums and need separate review.

JavaScript modules run directly in the browser. Save a source file and reload the game to see changes; no bundler is required. Browser saves belong to the site's browser storage, so do not clear site data if you want to retain them. Co-op requires a separate relay service, which upstream does not include.

Generated `assets/`, fetched `vendor/`, `.venv/`, `node_modules/`, and test output stay ignored. Commit the source, scripts, and dev-container configuration to your repository, not the downloaded game assets.
