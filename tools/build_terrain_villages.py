#!/usr/bin/env python3
"""Village templates for the generated worlds (stage 7a; design 4.4, 5.1, 5.2): part 3 of tools/build_terrain.py.

build_terrain.build() calls village_bank(B, entries, grid) after its other parts, so every entry made here is appended
after the existing generated entries (no older index moves), and stores the result as terrain.json `villages`:

  styles      per village style (plains, desert, savanna, taiga, snowy): the path recolour of quarter set C (5.1's
              one path mask), the ground the houses stand on, the well's ring block
  exteriors   per style, FireRed's own houses: Four Island's two (General + gTileset_SeviiIslands45, the prototype's
              choice) and Pallet's small house (plains only): { name, w, h, cells: [entry], door: [x, y] }. Each cell is
              a new entry per ground the cell can stand on (`cells: { grass, sand, snow }`; grass in the style's
              tint: dry for savanna, cool for taiga), its
              walls and roof recoloured per style: desert sandstone walls and flat orange roofs, savanna acacia-orange
              wood and terracotta roofs, taiga dark spruce wood and blue-grey roofs, snowy white walls and ice-blue
              roofs. Collision from the map's own collision bits, behaviour from the metatile attributes (the door cell
              keeps FireRed's door behaviour). The top row is roof drawn over sprites (walkable, as FireRed's).
  interiors   FireRed's single-floor house rooms cut from Classic's grid (world.json entries, nothing new drawn):
              { name, w, h, cells: [entry], mat: [x, y], spots: { beds: [[x, y], ...], chest: [x, y], job: [x, y] } }.
              Beds are two cells (the head on top: [x, y] is the head, the foot below), placed by a fixed scan of
              free floor away from the mat's walk-in column; every spot is reachable from the mat (asserted).

The plan (src/gen/village.js) reads only sizes and doors; the painter (src/gen/chunk.js) and the runtime
(src/world.js initHouses) read the cells.
"""
import colorsys
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from fr import FR, Tileset, MetatileRenderer, tileset_folders  # noqa: E402

GEN_BASE = 8975
OUT = Path(__file__).resolve().parent.parent / 'assets' / 'world'

# (name, layout folder, layout w, h, secondary tileset, (x, y, w, h) of the house in the map, door cell in the house)
EXTERIORS = [
    ('four_purple', 'FourIsland', 48, 40, 'gTileset_SeviiIslands45', (24, 23, 5, 4), (1, 3)),
    ('four_orange', 'FourIsland', 48, 40, 'gTileset_SeviiIslands45', (11, 10, 4, 4), (1, 3)),
    ('pallet', 'PalletTown', 24, 20, 'gTileset_PalletTown', (5, 3, 5, 5), (1, 4)),
]
# Classic rooms (world.json maps): FireRed's one-floor houses (layouts HOUSE1, HOUSE2, HOUSE4, HOUSE5, Viridian's)
INTERIORS = [
    ('house5', 265, 698, 11, 9), ('house1', 284, 698, 11, 9), ('house2', 103, 716, 11, 9),
    ('house4', 160, 716, 11, 9), ('viridian', 350, 716, 11, 9),
]
STYLES = {
    'plains': {'path': 'path', 'ground': 'grass', 'well': 'cobblestone', 'houses': ['four_purple', 'four_orange', 'pallet']},
    'desert': {'path': 'pale_sand', 'ground': 'sand', 'well': 'sandstone', 'houses': ['four_purple', 'four_orange']},
    'savanna': {'path': 'dirt', 'ground': 'dry', 'well': 'cobblestone', 'houses': ['four_purple', 'four_orange']},
    'taiga': {'path': 'gravel', 'ground': 'cool', 'well': 'cobblestone', 'houses': ['four_purple', 'four_orange']},
    'snowy': {'path': 'gravel_snow', 'ground': 'snow', 'well': 'cobblestone', 'houses': ['four_purple', 'four_orange']},
}
# per style: roof (hue degrees, saturation, value multiplier) and walls (the same), None for FireRed's own colours
LOOKS = {
    'plains': (None, None),
    'desert': ((26, 0.62, 1.0), (42, 0.34, 0.98)),
    'savanna': ((14, 0.56, 0.86), (24, 0.56, 0.93)),
    'taiga': ((212, 0.22, 0.80), (28, 0.46, 0.64)),
    'snowy': ((200, 0.34, 1.04), (210, 0.05, 1.08)),
}
# FireRed's light Pallet greens (the lighter ground beside Pallet's houses) are ground too
# every house cell is drawn on each of the three grounds a village can stand on (the painter picks the cell's own):
# grass (the style's tint: dry for savanna, cool for taiga, temperate otherwise), sand and snow
GROUND_KINDS = ('grass', 'sand', 'snow')
PALLET_GREENS = {(189, 238, 213), (156, 230, 197), (139, 213, 189), (148, 222, 189)}


def _hsv(c):
    return colorsys.rgb_to_hsv(*[v / 255 for v in c])


def _rgb(h, s, v):
    return tuple(int(round(max(0, min(1, q)) * 255)) for q in colorsys.hsv_to_rgb(h % 1.0, s, v))


def _snap(c):
    return tuple(min(255, (v >> 3) << 3 | (v >> 5)) for v in c)


def _green(c):
    h, s, v = _hsv(c)
    return 0.36 <= h <= 0.50 and s >= 0.18


def _roof(name, c):
    h, s, v = _hsv(c)
    d = h * 360
    if name == 'four_purple':
        return 255 <= d <= 315 and s >= 0.1
    if name == 'four_orange':
        return 18 <= d <= 38 and s >= 0.5
    return (d <= 20 or d >= 345) and s >= 0.4      # Pallet's red roof


def _wall(c):
    h, s, v = _hsv(c)
    return s < 0.2 and v >= 0.7 and not (s < 0.08 and v > 0.97)


def recolour_fn(style, name, BT, ground_kind='grass'):
    roof, wall = LOOKS[style]
    gk = STYLES[style]['ground'] if ground_kind == 'grass' else ground_kind
    if gk in ('sand', 'snow') and ground_kind == 'grass':
        gk = 'grass'                                  # a desert or snowy village's house on grass: temperate grass
    if gk == 'grass':
        ground = None
    elif gk in ('sand', 'snow'):
        ground = BT.ground_fn(gk)
    else:
        ground = BT.ground_fn('grass', BT.TINTS[gk])

    def f(c):
        if c in PALLET_GREENS:
            c = BT.GRASS_BASE if c == (189, 238, 213) else BT.GRASS_RGB[2]
        if _green(c):
            return ground(c) if ground else c
        if roof and _roof(name, c):
            h, s, v = _hsv(c)
            return _snap(_rgb(roof[0] / 360, min(1, roof[1] * (0.6 + s)), min(1, v * roof[2])))
        if wall and _wall(c):
            h, s, v = _hsv(c)
            return _snap(_rgb(wall[0] / 360, wall[1] * (0.7 + s * 2), min(1, v * wall[2])))
        return c
    return f


def village_bank(B, entries, grid, BT):
    """Appends the exterior entries to the bank and returns terrain.json's `villages`."""
    F = tileset_folders()
    W = json.load(open(OUT / 'world.json'))
    WW = W['w']
    renders = {}
    ext = {s: [] for s in STYLES}
    for name, lay, lw, lh, sec, (x0, y0, w, h), door in EXTERIORS:
        R = renders.get(sec) or MetatileRenderer(Tileset(F['gTileset_General'], False), Tileset(F[sec], True))
        renders[sec] = R
        blk = np.fromfile(FR / 'data' / 'layouts' / lay / 'map.bin', dtype='<u2').reshape(lh, lw)
        for style, rec in STYLES.items():
            if name not in rec['houses']:
                continue
            cells = {}
            for gkind in GROUND_KINDS:
              fn = recolour_fn(style, name, BT, gkind)
              cells[gkind] = []
              for y in range(h):
                for x in range(w):
                    raw = int(blk[y0 + y, x0 + x])
                    mid, colb = raw & 0x3ff, (raw >> 10) & 3
                    b, a = R.render(mid)
                    beh = R.attr(mid) & 0x1ff
                    col = 1 if colb else 0
                    if (x, y) == door:
                        assert col == 1, (name, 'door cell must be solid')
                    mat = 'floor' if not col else ('glass' if beh == 0 and y == h - 2 else 'bricks')
                    i = B.add(BT.recolour(b, fn), BT.recolour(a, fn), -1, beh, col, mat, 0, -1, 0, 0)
                    cells[gkind].append(i)
            ext[style].append({'name': name, 'w': w, 'h': h, 'cells': cells, 'door': list(door)})
    # interiors: Classic's own room cells
    E = W['entries']
    ints = []
    for name, x0, y0, w, h in INTERIORS:
        cells = [int(grid[y0 + y, x0 + x]) for y in range(h) for x in range(w)]
        mats = [(x, y) for y in range(h) for x in range(w) if E[cells[y * w + x]][2] == 0x65]
        assert len(mats) == 1, (name, mats)
        mx, my = mats[0]
        free = lambda x, y: 0 <= x < w and 0 <= y < h and E[cells[y * w + x]][3] == 0 and E[cells[y * w + x]][2] == 0 \
            and E[cells[y * w + x]][4] == 'floor'
        # keep the walk-in column and the row above the mat clear; furniture never in the top two rows (walls)
        def usable(x, y):
            return free(x, y) and y >= 2 and abs(x - mx) > 1 and y < my
        taken = set()
        beds = []
        for x in list(range(1, w - 1)):
            for y in range(2, my - 1):
                if len(beds) >= 2:
                    break
                if usable(x, y) and usable(x, y + 1) and (x, y) not in taken and (x, y + 1) not in taken \
                        and all((xx, yy) not in taken for xx in (x - 1, x + 1) for yy in (y, y + 1)):
                    beds.append([x, y])
                    taken |= {(x, y), (x, y + 1)}
            if len(beds) >= 2:
                break
        assert len(beds) == 2, (name, 'two beds')

        def spot(order):
            for x, y in order:
                if usable(x, y) and (x, y) not in taken and all((x + dx, y + dy) not in taken for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    taken.add((x, y))
                    return [x, y]
            raise AssertionError((name, 'no spot'))
        chest = spot([(x, y) for x in range(w - 2, 0, -1) for y in range(2, my)])
        job = spot([(x, y) for y in range(my - 1, 1, -1) for x in range(w - 2, 0, -1)])
        # every furniture cell's neighbour is reachable from the mat over free cells that hold no furniture
        seen, q = {(mx, my)}, deque([(mx, my)])
        while q:
            x, y = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (x + dx, y + dy)
                if n not in seen and n not in taken and 0 <= n[0] < w and 0 <= n[1] < h and E[cells[n[1] * w + n[0]]][3] == 0:
                    seen.add(n)
                    q.append(n)
        for sx, sy in [tuple(b) for b in beds] + [tuple(chest), tuple(job)]:
            assert any((sx + dx, sy + dy) in seen for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (0, 2))), (name, 'spot unreachable', sx, sy)
        ints.append({'name': name, 'w': w, 'h': h, 'cells': cells, 'mat': [mx, my],
                     'spots': {'beds': beds, 'chest': chest, 'job': job}})
    return {'styles': {k: {kk: vv for kk, vv in v.items() if kk != 'houses'} for k, v in STYLES.items()},
            'exteriors': ext, 'interiors': ints}
