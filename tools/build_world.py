#!/usr/bin/env python3
"""FireRed's Kanto as a world Steve can take apart.

Every outdoor map is stitched through its connections (as in Sky Anywhere), but instead of baking the
map into images, each cell keeps a reference into a tile atlas: all 640 General metatiles plus every
secondary metatile the maps use, rendered below/above the sprite layer. The runtime draws the world
from that atlas, so any cell can change when Steve breaks or places something.

Each atlas entry carries its metatile behaviour, default collision and a material (what Minecraft block
it is: a tree is oak logs, a cliff is stone, a red roof is bricks, a window is glass...). Some cliff
faces get ore veins painted in from Minecraft's own ore textures. For every cell the builder also
records the ground to leave behind when it is broken, and it exports the learned cliff autotiler so
mined cliffs can re-edge themselves.

Below the outdoor block (rows 0..399, which never move: saves store cell indices) the interiors, caves
and Viridian Forest reachable through FireRed's warps are shelf-packed from row 416 with void gutters.
world.json lists them in maps[] (kind, depth, music...), with every warp (trigger and arrival per
FireRed's field_control_avatar.c rules), the people in the rooms and their mart lists, and the animated
door styles.

Below the rooms, past another void gutter, comes the Nether (tools/build_nether.py): a generated 128x96 region
that is one more map (MAP_NETHER), drawn with its own atlas entries after all of Kanto's. world.json's 'nether'
section carries what the runtime needs for it, and 'lava' the pre-placed lava pools of four deep caves.

Below the Nether come the stronghold (tools/build_stronghold.py, 96x72, MAP_STRONGHOLD) and, past one more gutter,
The End (tools/build_end.py, 112x112, MAP_THE_END), each with its own atlas entries after the ones before it, and
their world.json sections 'stronghold' and 'end'. Route 23 gets the stronghold's entrance: one cell (build_stronghold
ENTRANCE) becomes a cracked stone bricks block whose ground is a stairway down, with warps appended after Kanto's.
Nothing above the new regions moves, and no older atlas entry changes.

Last, tools/build_terrain.py builds the generated worlds' tile bank (terrain.json, atlas_gen.png, atlas_gen_top.png)
from the General entries, numbered after The End's; Classic's outputs above are written first and never change.

Outputs (assets/world/): world.json, grid.bin (u16 atlas index per cell), col.bin, beh.bin (u8),
ground.bin (u16), area.bin (u16 map index + 1 per cell, 0 outside maps), atlas.png (below layer),
atlas_top.png (above layer), doors.png (3 opening frames per door style, 16x48 columns), autotile.json;
assets/sprites/npc/<gfx>.png (people sheets in pic-table frame order)
"""
import colorsys
import hashlib
import json
import math
import os
import re
import sys
import zlib
from collections import Counter, defaultdict, deque
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from fr import (FR, Tileset, MetatileRenderer, tileset_folders, load_indexed, door_graphics, object_gfx,  # noqa: E402
                npc_sheet, parse_scripts, parse_texts, text_pages)
import autotile as AT  # noqa: E402
import build_nether as BN  # noqa: E402
import build_stronghold as BS  # noqa: E402
import build_end as BE  # noqa: E402
import build_terrain as BT  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / 'assets' / 'world'
MC = HERE / 'vendor' / 'minecraft' / 'jar' / 'assets' / 'minecraft' / 'textures'
ATLAS_COLS = 64
WATER = {0x10, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x19, 0x1A, 0x1B}
LEDGES = {0x38, 0x39, 0x3A, 0x3B}

# General tileset pieces (metatile ids), picked from the tileset sheet.
TREE_TIP, TREE_OVERLAP, TREE_CROWN, TREE_BASE = {14, 15}, {20, 21, 22, 23}, {28, 29, 30, 31}, {36, 37, 38, 39}
TREE_STD = TREE_TIP | TREE_OVERLAP | TREE_CROWN | TREE_BASE
TREE_OTHER = {18, 19, 26, 27, 34, 35, 250, 251, 266, 267, 180, 181, 182, 214, 215, 597, 605}
BOULDERS = {159, 175, 183}
FLOWERS = {4}
BUSHES = {5, 325, 326, 327, 333, 334, 335, 343, 317, 318, 319}
SIGNS = {2, 3}
FENCES = {222, 223} | set(range(230, 250)) | {252, 253, 309, 310, 551}     # 224..229 are sand paths
GRASS_FLOOR = {1, 8, 9, 16, 17}


H_OUT = 400           # the stitched outdoor block keeps rows 0..399 (saved cell indices depend on it)
ROOM_Y0 = 416         # rooms are shelf-packed below it, inside x 8..400, with void gutters
GUTTER = 8
ROOM_X0, ROOM_X1 = 8, 400
# Interiors left out of this tier (dungeons, link rooms, elevators); their doors stay closed.
EXCLUDE_PREFIX = ('MAP_SILPH_CO', 'MAP_ROCKET_HIDEOUT', 'MAP_POKEMON_MANSION', 'MAP_SSANNE', 'MAP_SAFARI_ZONE',
                  'MAP_POKEMON_LEAGUE', 'MAP_UNION_ROOM', 'MAP_TRADE_CENTER')


def excluded(mid):
    return mid.startswith(EXCLUDE_PREFIX) or 'ELEVATOR' in mid


def room_set(maps, outdoor):
    """Every interior, cave and the forest reachable through warp_events from the outdoor maps, without
    passing through an excluded map. Returns {room: outdoor map it hangs off}."""
    parent, q = {}, deque()
    for o in sorted(outdoor):     # a fixed order: which outdoor map a room hangs off no longer depends on set order
        for w in maps[o].get('warp_events') or []:
            t = w['dest_map']
            if t in maps and t not in outdoor and not excluded(t) and t not in parent:
                parent[t] = o; q.append(t)
    while q:
        r = q.popleft()
        for w in maps[r].get('warp_events') or []:
            t = w['dest_map']
            if t in maps and t not in outdoor and not excluded(t) and t not in parent:
                parent[t] = parent[r]; q.append(t)
    return parent


def pack_rooms(rooms, size):
    """Deterministic shelf packing: tallest first, left to right, GUTTER void cells between rooms."""
    pos, x, y, shelf = {}, ROOM_X0, ROOM_Y0, 0
    for r in sorted(rooms, key=lambda r: (-size(r)[1], -size(r)[0], r)):
        w, h = size(r)
        if x + w > ROOM_X1:
            x, y, shelf = ROOM_X0, y + shelf + GUTTER, 0
        pos[r] = (x, y)
        x += w + GUTTER
        shelf = max(shelf, h)
    return pos, y + shelf + GUTTER


def room_kind(m):
    if m['map_type'] == 'MAP_TYPE_UNDERGROUND':
        return 'cave'
    if m['map_type'] == 'MAP_TYPE_ROUTE':
        return 'field'          # Viridian Forest: sky, day and night, grass encounters
    return 'indoor'


def cave_depth(mid):
    """How far underground a cave floor is (mining.md 6): 1F 1, B1F 2, B2F 3, B3F and below 4.
    Victory Road and Cerulean Cave 2F are inside a mountain, depth 1."""
    if 'VICTORY_ROAD' in mid or mid == 'MAP_CERULEAN_CAVE_2F':
        return 1
    m = re.search(r'_B(\d)F$', mid)
    return min(4, int(m.group(1)) + 1) if m else 1


def pair_name(pk, sk):
    # outdoor pairs keep their old names (the secondary tileset); rooms on another primary say both
    return sk if pk == 'gTileset_General' else f'{pk}/{sk}'


def to_grid():
    folders = tileset_folders()
    maps = {}
    for f in (FR / 'data/maps').glob('*/map.json'):
        m = json.load(open(f))
        m['_dir'] = f.parent.name
        maps[m['id']] = m
    layouts = {l['id']: l for l in json.load(open(FR / 'data/layouts/layouts.json'))['layouts'] if 'id' in l}
    sections = {s['id']: s for s in json.load(open(FR / 'src/data/region_map/region_map_sections.json'))['map_sections']}
    layout_of = lambda mid: layouts[maps[mid]['layout']]
    alias = {'MAP_SAFFRON_CITY_CONNECTION': 'MAP_SAFFRON_CITY'}
    pos = {'MAP_PALLET_TOWN': (0, 0)}
    q = deque(['MAP_PALLET_TOWN'])
    while q:
        mid = q.popleft()
        L = layout_of(mid)
        x, y = pos[mid]
        for c in maps[mid].get('connections') or []:
            d, o, t = c['direction'], c['offset'], alias.get(c['map'], c['map'])
            if t not in maps or d not in ('up', 'down', 'left', 'right'):
                continue
            TL = layout_of(t)
            p = {'up': (x + o, y - TL['height']), 'down': (x + o, y + L['height']),
                 'left': (x - TL['width'], y + o), 'right': (x + L['width'], y + o)}[d]
            if t not in pos:
                pos[t] = p
                q.append(t)
    minx = min(p[0] for p in pos.values()); miny = min(p[1] for p in pos.values())
    maxx = max(pos[m][0] + layout_of(m)['width'] for m in pos)
    maxy = max(pos[m][1] + layout_of(m)['height'] for m in pos)
    W, HO = maxx - minx, maxy - miny
    assert (W, HO) == (408, H_OUT), (W, HO)
    # rooms: interiors and caves, packed below the outdoor block
    parent = room_set(maps, set(pos))
    rpos, H = pack_rooms(parent, lambda r: (layout_of(r)['width'], layout_of(r)['height']))
    order = [(mid, mx - minx, my - miny) for mid, (mx, my) in pos.items()] + \
        sorted(((r, x, y) for r, (x, y) in rpos.items()), key=lambda t: (t[2], t[1]))

    pairs, renderers, tilesets, pair_keys = [], {}, {}, []
    pair_of = np.full((H, W), -1, np.int32)
    mids = np.zeros((H, W), np.int32)
    colbit = np.ones((H, W), np.uint8)
    covered = np.zeros((H, W), bool)
    area = np.zeros((H, W), np.uint16)
    map_list, towns, placed = [], [], []
    for mid, ox, oy in order:
        m, L = maps[mid], layout_of(mid)
        room = mid in rpos
        pk, sk = L['primary_tileset'], L['secondary_tileset']
        assert sk != 'gTileset_SilphCo', mid    # its metatiles live in another folder (fr.tileset_folders)
        for key, sec in ((pk, False), (sk, True)):
            if key not in tilesets:
                tilesets[key] = Tileset(folders[key.replace('_Frlg', '')], sec)
        name = pair_name(pk, sk)
        if name not in renderers:
            renderers[name] = MetatileRenderer(tilesets[pk], tilesets[sk])
            pairs.append(name); pair_keys.append((pk, sk))
        pi = pairs.index(name)
        data = np.fromfile(FR / L['blockdata_filepath'], dtype='<u2').reshape(L['height'], L['width'])
        sl = (slice(oy, oy + L['height']), slice(ox, ox + L['width']))
        mids[sl] = data & 0x3FF
        colbit[sl] = ((data >> 10) & 3) != 0
        pair_of[sl] = pi
        covered[sl] = True
        area[sl] = len(map_list) + 1
        placed.append((mid, ox, oy, L, pi))
        sec = sections.get(m['region_map_section'], {})
        entry = {'id': mid, 'mapsec': m['region_map_section'], 'name': sec.get('name', mid), 'type': m['map_type'],
                 'x': ox, 'y': oy, 'w': L['width'], 'h': L['height'],
                 'kind': room_kind(m) if room else 'outdoor', 'depth': 0, 'music': m['music'],
                 'show': bool(m.get('show_map_name')), 'flash': bool(m.get('requires_flash')),
                 'parent': parent.get(mid)}
        if room:
            entry['room'] = True
            if entry['kind'] == 'cave':
                entry['depth'] = cave_depth(mid)
        map_list.append(entry)
        if not room and m['map_type'] == 'MAP_TYPE_TOWN':
            warp = next((w for w in m.get('warp_events', []) if 'POKEMON_CENTER' in w['dest_map']), None) or \
                next((w for w in m.get('warp_events', []) if 'PLAYERS_HOUSE' in w['dest_map']), None)
            towns.append({k: v for k, v in entry.items() if k in ('id', 'mapsec', 'name', 'type', 'x', 'y', 'w', 'h')} |
                         {'land': {'x': ox + warp['x'], 'y': oy + warp['y'] + 1}})
    # the void between outdoor maps: each map's repeating border block, as the game draws past its edges.
    # Rooms get none: their gutters stay void (FireRed's interiors border on black).
    n_out = len(pos)
    best = np.full((H, W), 255, np.int32)
    owner = np.full((H, W), -1, np.int32)
    R_BORDER = 12
    for mi, (mid, ox, oy, L, pi) in enumerate(placed[:n_out]):
        w, h = L['width'], L['height']
        for yy in range(max(0, oy - R_BORDER), min(H_OUT, oy + h + R_BORDER)):
            for xx in range(max(0, ox - R_BORDER), min(W, ox + w + R_BORDER)):
                if covered[yy, xx]:
                    continue
                d = max(0, ox - xx, xx - (ox + w - 1)) + max(0, oy - yy, yy - (oy + h - 1))
                if d < best[yy, xx]:
                    best[yy, xx] = d; owner[yy, xx] = mi
    borders = [np.fromfile(FR / L['border_filepath'], dtype='<u2') for (_, _, _, L, _) in placed[:n_out]]
    border = np.zeros((H, W), bool)
    for yy, xx in zip(*np.nonzero(owner >= 0)):
        mi = owner[yy, xx]
        _, ox, oy, L, pi = placed[mi]
        bw, bh = L.get('border_width', 2), L.get('border_height', 2)
        e = int(borders[mi][((yy - oy) % bh) * bw + ((xx - ox) % bw)])
        mids[yy, xx] = e & 0x3FF
        pair_of[yy, xx] = pi
        colbit[yy, xx] = 1
        border[yy, xx] = True
    rooms_layout = [[mid, ox, oy, L['width'], L['height']] for mid, ox, oy, L, _ in placed[n_out:]]
    layout_id = hashlib.sha1(json.dumps(rooms_layout).encode()).hexdigest()[:12]
    print(f'{n_out} outdoor maps, {len(rpos)} rooms packed below y={ROOM_Y0}: world {W}x{H}, layout {layout_id}')
    return dict(W=W, H=H, pairs=pairs, pair_keys=pair_keys, renderers=renderers, pair_of=pair_of, mids=mids,
                colbit=colbit, covered=covered, border=border, area=area, maps=map_list, towns=towns,
                placed=placed, n_out=n_out, fr_maps=maps, alias=alias, layout_id=layout_id)


# ---------------------------------------------------------------- materials
def hsv_stats(rgba):
    px = rgba.reshape(-1, 4)
    px = px[px[:, 3] > 0][:, :3] / 255.0
    if not len(px):
        return None
    return np.array([colorsys.rgb_to_hsv(*p) for p in px])


GRASS_RGB = AT.GRASS_RGB | {(98, 189, 148), (82, 164, 123), (148, 222, 172)}


ROCK_COLORS = None


def rock_colors(R):
    global ROCK_COLORS
    cols = set()
    for mid in range(104, 188):
        if not AT.is_mountain(mid):
            continue
        b, a = R.render(mid)
        for img in (b, a):
            for p in img.reshape(-1, 4):
                if p[3] and tuple(int(v) for v in p[:3]) not in GRASS_RGB:
                    cols.add(tuple(int(v) for v in p[:3]))
    sand = {(213, 197, 131), (197, 172, 106), (238, 230, 164), (230, 213, 148)}
    def rocky(c):
        r, g, b = c
        h, s_, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        return r >= g and r - b > 12 and (h * 360 < 40 or h * 360 > 330) and s_ > 0.08
    ROCK_COLORS = np.array(sorted(c for c in cols if c not in sand and rocky(c)), np.uint8)
    print(f'  {len(ROCK_COLORS)} rock colours')


def building_material(img):
    """Which Minecraft block a piece of FireRed scenery looks most like: glass windows, rock, foliage,
    white picket fences, then building colours mapped onto Minecraft's concrete, bricks, sandstone,
    planks and stone bricks."""
    px = img.reshape(-1, 4)
    px = px[px[:, 3] > 0][:, :3]
    allpx = len(px)
    if allpx < 30:
        return 'stone_bricks'
    # rock: most of the tile in the colours of FireRed's own cliffs
    d = np.abs(px[:, None, :].astype(int) - ROCK_COLORS[None, :, :].astype(int)).sum(axis=2).min(axis=1)
    if (d < 18).mean() > 0.6:
        return 'rock'
    hall = np.array([colorsys.rgb_to_hsv(*(p / 255.0)) for p in px])
    greenish = (hall[:, 0] * 360 > 80) & (hall[:, 0] * 360 < 175) & (hall[:, 1] > 0.2)
    greyish_all = hall[:, 1] < 0.25
    whites = (hall[:, 1] < 0.2) & (hall[:, 2] > 0.8)
    # white picket fences: white posts and rails (with their grey shading) on grass, nothing else
    if greenish.mean() > 0.25 and whites.mean() > 0.08 and (greenish | greyish_all).mean() > 0.92:
        return 'fence_birch'
    grass = np.array([tuple(int(v) for v in p) in GRASS_RGB for p in px])
    gshare = grass.mean()
    px = px[~grass]
    if len(px) < 30:
        return 'stone_bricks'
    hsv = np.array([colorsys.rgb_to_hsv(*(p / 255.0)) for p in px])
    h, s_, v = hsv[:, 0] * 360, hsv[:, 1], hsv[:, 2]
    n = len(hsv)
    frac = lambda m: m.sum() / n
    light_blue = (h > 185) & (h < 225) & (s_ > 0.2) & (v > 0.75)
    white = (s_ < 0.12) & (v > 0.85)
    if frac(light_blue) > 0.25 and frac(white) > 0.05:
        return 'glass'
    green = (h > 75) & (h < 170) & (s_ > 0.25)
    if frac(green) > 0.5:
        # foliage is noisy light-and-dark green; roofs and walls are flat
        vg = v[green]
        dark = (vg < 0.45).mean()
        return 'leaves' if (vg.std() > 0.12 and dark > 0.1) else ('lime_concrete' if vg.mean() > 0.7 else 'green_concrete')
    red = ((h < 18) | (h > 340)) & (s_ > 0.35) & (v > 0.35)
    if frac(red) > 0.3:
        return 'bricks'
    orange = (h >= 18) & (h < 38) & (s_ > 0.5) & (v > 0.55)
    if frac(orange) > 0.3:
        return 'orange_concrete'
    purple = (h >= 250) & (h < 300) & (s_ > 0.18)
    if frac(purple) > 0.3:
        return 'purple_concrete'
    pink = (h >= 300) & (h <= 340) & (s_ > 0.15)
    if frac(pink) > 0.3:
        return 'pink_concrete'
    blue = (h > 190) & (h < 250) & (s_ > 0.3)
    if frac(blue) > 0.35:
        return 'light_blue_concrete' if v[blue].mean() > 0.78 else 'blue_concrete'
    yellow = (h >= 40) & (h < 70) & (s_ > 0.45) & (v > 0.6)
    if frac(yellow) > 0.35:
        return 'yellow_concrete'
    tan = (h >= 30) & (h < 65) & (s_ > 0.15) & (v > 0.6)
    if frac(tan) > 0.35:
        return 'sandstone'
    brown = (h >= 10) & (h < 45) & (s_ > 0.25) & (v <= 0.62)
    if frac(brown) > 0.35:
        return 'oak_planks'
    if frac((s_ < 0.15) & (v > 0.82)) > 0.4:
        return 'white_concrete'
    if frac((s_ < 0.15) & (v > 0.62)) > 0.45:
        return 'light_gray_concrete'
    return 'stone_bricks'


def classify(mid, beh, col, below, above, is_primary):
    """Material name for a metatile. Floors are 'floor' / 'sand' / 'water' (not breakable by hand)."""
    comp = below.copy()
    comp[...] = np.where(above[:, :, 3:4] > 0, above, comp)
    if beh in WATER:
        return 'water_rock' if col else 'water'
    if beh == 0x02:
        return 'tallgrass'
    if beh in LEDGES:
        return 'ledge'
    if beh == 0x84:
        return 'sign'
    if beh in (0x69, 0x60, 0x6E, 0x6F, 0x6C, 0x6D):
        return 'door'
    if is_primary:
        if mid in TREE_STD or mid in TREE_OTHER:
            return 'tree'
        if mid in BOULDERS:
            return 'boulder'
        if AT.is_mountain(mid) or mid in (634, 635, 636):
            return 'rock'
        if mid in FLOWERS:
            return 'flower'
        if mid in BUSHES:
            return 'bush'
        if mid in SIGNS:
            return 'sign'
        if mid in FENCES:
            # fences: brown posts are oak, the white/grey rails birch
            hsv = hsv_stats(comp)
            brownish = ((hsv[:, 0] * 360 < 40) & (hsv[:, 1] > 0.3)).mean() if hsv is not None else 0
            return 'fence_oak' if brownish > 0.12 else 'fence_birch'
    if not col:
        if beh == 0x21:
            return 'sand'
        # walkable: flowers in city beds are red/yellow blossoms on grass
        hsv = hsv_stats(comp)
        if hsv is not None:
            red = (((hsv[:, 0] * 360 < 20) | (hsv[:, 0] * 360 > 340)) & (hsv[:, 1] > 0.45)).mean()
            if red > 0.08 and not is_primary:
                return 'flower'
        return 'floor'
    return building_material(comp)


# Minecraft-side properties of each material: the block it drops, hardness, the right tool,
# whether that tool is needed for a drop, and the dig/step sound group.
MATERIALS = {
    'floor': dict(hard=-1),
    'sand': dict(hard=-1),
    'water': dict(hard=-1),
    'tree': dict(drop='oak_log', hard=2.0, tool='axe', sound='wood'),
    'bush': dict(drop='oak_sapling', hard=0.2, tool='hoe', sound='grass'),
    'boulder': dict(drop='cobblestone', hard=1.5, tool='pickaxe', need=True, sound='stone'),
    'rock': dict(drop='cobblestone', hard=1.5, tool='pickaxe', need=True, sound='stone'),
    'water_rock': dict(drop='cobblestone', hard=1.5, tool='pickaxe', need=True, sound='stone'),
    'ledge': dict(drop='dirt', hard=0.6, tool='shovel', sound='grass'),
    'tallgrass': dict(drop='wheat_seeds', hard=0.0, sound='grass'),
    'flower': dict(drop='poppy', hard=0.0, sound='grass'),
    'sign': dict(drop='oak_sign', hard=1.0, tool='axe', sound='wood'),
    'door': dict(drop='oak_door', hard=3.0, tool='axe', sound='wood'),
    'doorway': dict(hard=-1),     # an open door: the tile left when a building's door is taken
    'fence_oak': dict(drop='oak_fence', hard=2.0, tool='axe', sound='wood'),
    'fence_birch': dict(drop='birch_fence', hard=2.0, tool='axe', sound='wood'),
    'glass': dict(drop=None, hard=0.3, sound='glass'),
    'bricks': dict(drop='bricks', hard=2.0, tool='pickaxe', need=True, sound='stone'),
    'blue_concrete': dict(drop='blue_concrete', hard=1.8, tool='pickaxe', need=True, sound='stone'),
    'green_concrete': dict(drop='green_concrete', hard=1.8, tool='pickaxe', need=True, sound='stone'),
    'white_concrete': dict(drop='white_concrete', hard=1.8, tool='pickaxe', need=True, sound='stone'),
    'sandstone': dict(drop='sandstone', hard=0.8, tool='pickaxe', need=True, sound='stone'),
    'oak_planks': dict(drop='oak_planks', hard=2.0, tool='axe', sound='wood'),
    'leaves': dict(drop='oak_sapling', hard=0.2, tool='hoe', sound='grass'),
    'lime_concrete': dict(drop='lime_concrete', hard=1.8, tool='pickaxe', need=True, sound='stone'),
    'orange_concrete': dict(drop='orange_concrete', hard=1.8, tool='pickaxe', need=True, sound='stone'),
    'purple_concrete': dict(drop='purple_concrete', hard=1.8, tool='pickaxe', need=True, sound='stone'),
    'pink_concrete': dict(drop='pink_concrete', hard=1.8, tool='pickaxe', need=True, sound='stone'),
    'light_blue_concrete': dict(drop='light_blue_concrete', hard=1.8, tool='pickaxe', need=True, sound='stone'),
    'yellow_concrete': dict(drop='yellow_concrete', hard=1.8, tool='pickaxe', need=True, sound='stone'),
    'light_gray_concrete': dict(drop='light_gray_concrete', hard=1.8, tool='pickaxe', need=True, sound='stone'),
    'stone_bricks': dict(drop='stone_bricks', hard=1.5, tool='pickaxe', need=True, sound='stone'),
}
# Ores: (ore, drop, hardness, pickaxe tier needed)
ORES = [
    ('coal_ore', 'coal', 3.0, 1),
    ('iron_ore', 'raw_iron', 3.0, 2),
    ('copper_ore', 'raw_copper', 3.0, 2),
    ('gold_ore', 'raw_gold', 3.0, 3),
    ('redstone_ore', 'redstone', 3.0, 3),
    ('lapis_ore', 'lapis_lazuli', 3.0, 2),
    ('diamond_ore', 'diamond', 3.0, 3),
    ('emerald_ore', 'emerald', 3.0, 3),
]
# Chance per minable rock cell by depth (surface, 1F, B1F, B2F, B3F and below), after Minecraft 1.18's ore
# heights: no gold, redstone, lapis or diamond on the surface; diamonds only deep down.
ORE_CHANCE = {
    'coal_ore': (0.040, 0.030, 0.012, 0.002, 0),
    'copper_ore': (0.012, 0.020, 0.015, 0.003, 0),
    'iron_ore': (0.020, 0.025, 0.025, 0.015, 0.010),
    'lapis_ore': (0, 0.003, 0.006, 0.006, 0.004),
    'gold_ore': (0, 0.002, 0.005, 0.007, 0.008),
    'redstone_ore': (0, 0, 0.006, 0.015, 0.020),
    'diamond_ore': (0, 0, 0.001, 0.0035, 0.006),
    'emerald_ore': (0, 0, 0, 0, 0),
}
VEIN = {'coal_ore': (3, 8), 'copper_ore': (3, 8), 'iron_ore': (2, 5), 'lapis_ore': (2, 4), 'gold_ore': (2, 4),
        'redstone_ore': (2, 5), 'diamond_ore': (1, 3), 'emerald_ore': (1, 1)}
# mountain routes: more iron, and the only surface emeralds (Minecraft's mountain biomes)
MOUNTAIN_MAPS = {'MAP_ROUTE23', 'MAP_INDIGO_PLATEAU_EXTERIOR', 'MAP_ROUTE10', 'MAP_ROUTE3', 'MAP_ROUTE4'}


FILM_ROCK = (105, 108, 113)


def ore_chance(ore, depth, mapid):
    if ore == 'emerald_ore':
        if depth == 0:
            return 0.004 if mapid in MOUNTAIN_MAPS else 0
        return 0.001 if depth == 1 and 'VICTORY_ROAD' in mapid else 0
    if ore == 'iron_ore' and depth == 0 and mapid in MOUNTAIN_MAPS:
        return 0.03
    return ORE_CHANCE[ore][min(depth, 4)]


def hash01(x, y, salt=0):
    h = (x * 374761393 + y * 668265263 + salt * 1442695041) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h ^= h >> 16
    return h / 4294967296.0


@lru_cache(None)
def ore_specks(name):
    """The ore's own pixels: where the Minecraft ore texture differs from plain stone."""
    stone = np.array(Image.open(MC / 'block/stone.png').convert('RGBA')).astype(int)
    ore = np.array(Image.open(MC / f'block/{name}.png').convert('RGBA')).astype(int)
    diff = np.abs(ore[:, :, :3] - stone[:, :, :3]).sum(axis=2) > 30
    return diff, ore.astype(np.uint8)


def rock_mask(img):
    """Pixels of a cliff tile that are rock (not grass, sand, sky or outline)."""
    rgb = img[:, :, :3].astype(int)
    a = img[:, :, 3] > 0
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    rockish = a & (r >= g) & (r > 90) & (np.abs(r - b) < 90) & ~((g > r) & (g > b))
    return rockish


def palette_mask(colors):
    """A rock mask for a cave tileset: pixels in the colours of its own walls (Seafoam's icy blue and
    Cerulean Cave's green fail the warm-cliff test above)."""
    keys = np.array(sorted(colors), np.int64)
    def mask(img):
        rgb = img[:, :, :3].astype(np.int64)
        k = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
        return (img[:, :, 3] > 0) & np.isin(k, keys)
    return mask


def cave_rock_colors(entries, rock_idx, floor_idx):
    """Colours of a cave's walls: common in its rock tiles, at most half as common in its ground, not outline-dark."""
    def counts(idxs):
        c = Counter()
        for i in idxs:
            t = composite(entries[i])
            for p in t[t[:, :, 3] > 0][:, :3]:
                c[tuple(int(v) for v in p)] += 1
        return c
    rock, floor = counts(rock_idx), counts(floor_idx)
    total, ftotal = sum(rock.values()) or 1, sum(floor.values()) or 1
    return {(r << 16) | (g << 8) | b for (r, g, b), n in rock.items()
            if n / total > 0.01 and floor[(r, g, b)] / ftotal < 0.5 * n / total and 0.299 * r + 0.587 * g + 0.114 * b > 48}


def composite(e):
    t = e['below'].copy()
    t[...] = np.where(e['above'][:, :, 3:4] > 0, e['above'], t)
    return t


def paint_ore(below, above, ore, mask_fn=rock_mask):
    """Paint the ore's specks onto a cliff tile where the tile is rock, with a dark rim so they read
    against FireRed's brighter rock."""
    specks, tex = ore_specks(ore)
    img = below.copy()
    img[...] = np.where(above[:, :, 3:4] > 0, above, img)
    rm = mask_fn(img)
    m = rm & specks
    if m.sum() < 10:
        return None
    b2, a2 = below.copy(), above.copy()
    target_top = above[:, :, 3] > 0
    for y, x in zip(*np.nonzero(m)):
        c = tex[y, x, :3]
        hh, ss, vv = colorsys.rgb_to_hsv(*(c / 255.0))
        if ss > 0.12:  # push the ore's colour so it reads against FireRed's warm rock
            c = np.array(colorsys.hsv_to_rgb(hh, min(1, ss * 1.45), min(1, vv * 1.08))) * 255
        dst = a2 if target_top[y, x] else b2
        dst[y, x, :3] = c
        dst[y, x, 3] = 255
    # rim: darken rock pixels touching a speck from below/right (a cheap drop shadow)
    for y, x in zip(*np.nonzero(m)):
        for dx, dy in ((1, 0), (0, 1)):
            xx, yy = x + dx, y + dy
            if xx < 16 and yy < 16 and not m[yy, xx] and rm[yy, xx]:
                dst = a2 if target_top[yy, xx] else b2
                dst[yy, xx, :3] = (dst[yy, xx, :3].astype(int) * 0.62).astype(np.uint8)
    return b2, a2


def main():
    G = to_grid()
    W, H = G['W'], G['H']
    print(f'world {W}x{H}, {len(G["pairs"])} tileset pairs')
    pairs, renderers, pair_keys = G['pairs'], G['renderers'], G['pair_keys']
    mids, pair_of, covered, colbit = G['mids'], G['pair_of'], G['covered'], G['colbit']
    maps, area = G['maps'], G['area']
    zone = np.where(covered, 0, np.where(G['border'], 1, 2)).astype(np.uint8)
    # ---- atlas. Entry order keeps old saves valid: 640 General metatiles, the outdoor secondary metatiles
    # in scan order, outdoor ores, then room metatiles, cave ores and open doorways.
    anyR = renderers[pairs[0]]
    rock_colors(anyR)
    entries = []            # dicts: mid, pair, below, above, beh, enc, col, mat
    def add(mid, pi, R):
        b, a = R.render(mid)
        at = R.attr(mid)
        entries.append(dict(mid=mid, pair=pi, below=b, above=a, beh=min(255, at & 0x1FF), enc=(at >> 24) & 7))
        return len(entries) - 1
    for mid in range(640):
        add(mid, -1, anyR)
    sec_index = {}
    grid = np.zeros((H, W), np.int32)
    def scan(y0, y1):
        for y in range(y0, y1):
            for x in range(W):
                mid, pi = int(mids[y, x]), int(pair_of[y, x])
                if pi < 0:
                    continue
                if mid < 640 and pair_keys[pi][0] == 'gTileset_General':
                    grid[y, x] = mid        # shared General entry
                    continue
                key = (pi, mid)
                if key not in sec_index:
                    sec_index[key] = add(mid, pi, renderers[pairs[pi]])
                grid[y, x] = sec_index[key]
    learned = AT_learned_collision()
    def vote_and_classify(first, cells):
        # default collision per entry: what its own cells use most
        votes = [Counter() for _ in range(len(entries) - first)]
        for y, x in zip(*np.nonzero(cells)):
            if grid[y, x] >= first:
                votes[grid[y, x] - first][int(colbit[y, x])] += 1
        for i in range(first, len(entries)):
            e, v = entries[i], votes[i - first]
            if v:
                e['col'] = v.most_common(1)[0][0]
            else:
                e['col'] = int(learned.get(e['mid'], 1)) if e['mid'] < 640 and e['pair'] < 0 else 1
            e['mat'] = classify(e['mid'], e['beh'], e['col'], e['below'], e['above'], e['pair'] < 0)
    outdoor_rows = np.zeros((H, W), bool); outdoor_rows[:H_OUT] = True
    scan(0, H_OUT)
    vote_and_classify(0, covered & outdoor_rows)
    print(f'outdoor atlas {len(entries)} entries ({len(sec_index)} secondary)')
    print('materials', Counter(e['mat'] for e in entries).most_common())

    # ---- ores in outdoor cliff faces: map cells only (the border fill past the map edges stays plain rock)
    ore_entries, ore_stats = {}, Counter()
    masks = {}
    place_ores(entries, grid, (zone == 0) & outdoor_rows, maps, area, lambda pi: (rock_mask, 150), ore_entries, ore_stats)

    # ---- rooms: their own metatiles (Building-primary ones keyed per tileset pair, as their palettes differ)
    first_room = len(entries)
    scan(ROOM_Y0, H)
    room_rows = ~outdoor_rows
    vote_and_classify(first_room, covered & room_rows)
    # caves and the forest are judged by what the map is, not by colour: every blocked cave cell is rock
    kinds = defaultdict(set)
    for mid, ox, oy, L, pi in G['placed']:
        kinds[pi].add(maps[[m['id'] for m in maps].index(mid)]['kind'])
    pair_kind = {pi: next(iter(k)) if len(k) == 1 else 'mixed' for pi, k in kinds.items()}
    for e in entries[first_room:]:
        e['mat'] = room_material(e, pair_kind.get(e['pair']))
    families = learn_families(G, entries, sec_index, add, pair_kind)
    print(f'room atlas entries {len(entries) - first_room}; materials',
          Counter(e['mat'] for e in entries[first_room:]).most_common(14))

    # ---- warps
    beh = np.array([[entries[grid[y, x]]['beh'] for x in range(W)] for y in range(H)], np.uint8)
    col = np.array([[entries[grid[y, x]]['col'] if covered[y, x] else 1 for x in range(W)] for y in range(H)], np.uint8)
    # the map's own collision bits win over the tile default inside maps
    col = np.where(covered, colbit, col).astype(np.uint8)
    warps = build_warps(G, beh, col)
    ring = room_ring(G, H, W)
    warp_cells = np.zeros((H, W), bool)
    for w in warps:
        warp_cells[w['y'], w['x']] = True

    # ---- ores in cave walls, by depth; the protected edge ring and the warps stay plain
    cave_cells = np.zeros((H, W), bool)
    for i, m in enumerate(maps):
        if m['kind'] == 'cave':
            cave_cells |= area == i + 1
    used = Counter(grid[cave_cells].tolist())
    for pi, k in pair_kind.items():
        if k == 'cave':
            rock_idx = [i for i in range(first_room, len(entries)) if entries[i]['pair'] == pi and entries[i]['mat'] == 'rock']
            # the cave's ground: its commonest floor tiles, covering 70% of its floor cells
            floors = sorted((i for i in used if entries[i]['pair'] == pi and entries[i]['mat'] == 'floor'), key=lambda i: -used[i])
            total, floor_idx = sum(used[i] for i in floors), []
            for i in floors:
                if sum(used[j] for j in floor_idx) >= 0.7 * total:
                    break
                floor_idx.append(i)
            masks[pi] = (palette_mask(cave_rock_colors(entries, rock_idx, floor_idx)), 110)
    place_ores(entries, grid, cave_cells & ~ring & ~warp_cells, maps, area, lambda pi: masks.get(pi, (rock_mask, 150)),
               ore_entries, ore_stats)
    report_ores(ore_stats, maps)

    # ---- the door styles the warps open (their doorway entries come last in the atlas)
    doors, door_frames = build_doors(G, entries, grid, warps, anyR)
    # ---- every ore in the Route 22 cliff pieces the demo film tunnels into (tools/render_video.mjs paints
    # them in for its shot); the world itself never places these
    for base in FILM_ROCK:
        for name, *_ in ORES:
            ore_entry(entries, ore_entries, base, name, lambda pi: (rock_mask, 150))

    # ---- protection: buildings, doors, openings, monuments, rooms
    prot = build_prot(G, entries, grid, col, zone, warps, ring)

    # ---- what to leave behind when a cell is broken: the plain ground that dominates around it
    ground = build_ground(G, entries, grid, zone, sec_index)
    npcs, sheets, marts = build_npcs(G)

    # ---- lava pools in four deep caves, placed on a new world as blocks (tools/build_nether.py)
    lava = BN.cave_pools(maps, entries, grid, col, beh, warps, npcs, WATER, TRIG)

    # ---- the Nether: its own atlas entries after all of Kanto's, its region below the rooms with a void
    # gutter (nothing above it moves, so saved cell indices stay valid)
    ny0, nx0 = H + BN.GUTTER, ROOM_X0
    nmap = len(maps)
    _, ngrid, nground, nprot, nether = BN.attach(entries, len(pairs), nx0, ny0, nmap)
    extra = BN.GUTTER + BN.NH + BN.GUTTER
    def below(a, fill):
        return np.vstack([a, np.full((extra, W), fill, a.dtype)])
    grid, ground, col, beh = below(grid, 0), below(ground, 0), below(col, 1), below(beh, 0)
    zone, area, prot = below(zone, 2), below(area, 0), below(prot, 0)
    sl = (slice(ny0, ny0 + BN.NH), slice(nx0, nx0 + BN.NW))
    grid[sl], ground[sl], prot[sl] = ngrid, nground, nprot
    col[sl] = np.array([e['col'] for e in entries], np.uint8)[ngrid]
    beh[sl] = np.array([e['beh'] for e in entries], np.uint8)[ngrid]
    zone[sl] = 0
    area[sl] = nmap + 1
    maps.append({'id': BN.MAP_ID, 'mapsec': 'MAPSEC_NETHER', 'name': 'THE NETHER', 'type': 'MAP_TYPE_UNDERGROUND',
                 'x': nx0, 'y': ny0, 'w': BN.NW, 'h': BN.NH, 'kind': 'nether', 'depth': 5, 'music': 'nether',
                 'show': True, 'flash': False, 'parent': None, 'room': True})
    H = grid.shape[0]
    print(f"nether at {nx0},{ny0}: {nether['count']} atlas entries, {len(nether['blocks'])} blocks, {len(nether['lights'])} lights,",
          nether['stats'])

    # ---- the stronghold below the Nether (the Nether's trailing gutter is the void between them) and The End below
    # the stronghold, each with its own atlas entries after everything before it. Route 23's entrance tiles are the
    # stronghold's (its closed block over that cell's grass, and the stairway mining it leaves).
    ex, ey = BS.ENTRANCE
    sy0, sx0, smap = H, ROOM_X0, len(maps)
    _, sgrid, sground, sprot, strong = BS.attach(entries, len(pairs) + 1, sx0, sy0, smap, int(ground[ey, ex]))
    ey0, ex0, emap = sy0 + BS.SH + BS.GUTTER, ROOM_X0, smap + 1
    _, egrid, eground, eprot, end = BE.attach(entries, len(pairs) + 2, ex0, ey0, emap)
    extra = BS.SH + BS.GUTTER + BE.EH + BE.GUTTER
    grid, ground, col, beh = below(grid, 0), below(ground, 0), below(col, 1), below(beh, 0)
    zone, area, prot = below(zone, 2), below(area, 0), below(prot, 0)
    ecol = np.array([e['col'] for e in entries], np.uint8)
    ebeh = np.array([e['beh'] for e in entries], np.uint8)
    for (x0, y0, w0, h0), rg, rgr, rp, mi in (((sx0, sy0, BS.SW, BS.SH), sgrid, sground, sprot, smap),
                                              ((ex0, ey0, BE.EW, BE.EH), egrid, eground, eprot, emap)):
        sl = (slice(y0, y0 + h0), slice(x0, x0 + w0))
        grid[sl], ground[sl], prot[sl] = rg, rgr, rp
        col[sl], beh[sl] = ecol[rg], ebeh[rg]
        zone[sl] = 0
        area[sl] = mi + 1
    maps.append({'id': BS.MAP_ID, 'mapsec': 'MAPSEC_STRONGHOLD', 'name': 'STRONGHOLD', 'type': 'MAP_TYPE_UNDERGROUND',
                 'x': sx0, 'y': sy0, 'w': BS.SW, 'h': BS.SH, 'kind': 'stronghold', 'depth': 4, 'music': 'stronghold',
                 'show': True, 'flash': False, 'parent': 'MAP_ROUTE23', 'room': True})
    maps.append({'id': BE.MAP_ID, 'mapsec': 'MAPSEC_THE_END', 'name': 'THE END', 'type': 'MAP_TYPE_UNDERGROUND',
                 'x': ex0, 'y': ey0, 'w': BE.EW, 'h': BE.EH, 'kind': 'end', 'depth': 0, 'music': 'the_end',
                 'show': True, 'flash': False, 'parent': None, 'room': True})
    # Route 23: the cracked stone bricks block among the boulders; mining it leaves the stairway (its ground)
    closed, opened = strong['entranceTiles']['closed'], strong['entranceTiles']['open']
    grid[ey, ex], ground[ey, ex] = closed, opened
    col[ey, ex], beh[ey, ex] = entries[closed]['col'], entries[closed]['beh']
    assert prot[ey, ex] == 0 and zone[ey, ex] == 0 and col[ey + 1, ex] == 0, 'the entrance must be minable, with open ground south'
    # the warps: the stairway down to the stair room's top step, and its three top steps back up (FireRed step
    # triggers; both arrivals walk a step south). Appended after Kanto's, so the old warps keep their numbers.
    w_route = len(warps)
    top = strong['stairs']
    mid = top[len(top) // 2]
    warps.append(dict(x=ex, y=ey, map='MAP_ROUTE23', trig='step', to=w_route + 1 + len(top) // 2, dest=BS.MAP_ID,
                      ax=mid[0], ay=mid[1], adir='down', amove='walk', door=None))
    for x, y in top:
        warps.append(dict(x=x, y=y, map=BS.MAP_ID, trig='step', to=w_route, dest='MAP_ROUTE23', ax=ex, ay=ey, adir='down',
                          amove='walk', door=None))
    strong['warps'] = [w_route, w_route + len(top)]
    H = grid.shape[0]
    print(f"stronghold at {sx0},{sy0}: {strong['count']} atlas entries, {len(strong['blocks'])} blocks, {strong['stats']}")
    print(f"the end at {ex0},{ey0}: {end['count']} atlas entries, {end['stats']}; entrance {ex},{ey} (tiles {closed}/{opened})")

    # ---- atlas images
    n = len(entries)
    rows = -(-n // ATLAS_COLS)
    below = np.zeros((rows * 16, ATLAS_COLS * 16, 4), np.uint8)
    above = np.zeros_like(below)
    for i, e in enumerate(entries):
        x, y = (i % ATLAS_COLS) * 16, (i // ATLAS_COLS) * 16
        below[y:y + 16, x:x + 16] = e['below']
        above[y:y + 16, x:x + 16] = e['above']
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(below, 'RGBA').save(OUT / 'atlas.png', optimize=True)
    Image.fromarray(above, 'RGBA').save(OUT / 'atlas_top.png', optimize=True)
    Image.fromarray(door_frames, 'RGBA').save(OUT / 'doors.png', optimize=True)
    grid.astype('<u2').tofile(OUT / 'grid.bin')
    ground.astype('<u2').tofile(OUT / 'ground.bin')
    col.tofile(OUT / 'col.bin')
    beh.tofile(OUT / 'beh.bin')
    # 0 = inside a map, 1 = border fill (decor past a map's edge), 2 = void (nothing drawn, bedrock)
    zone.tofile(OUT / 'zone.bin')
    area.astype('<u2').tofile(OUT / 'area.bin')
    prot.tofile(OUT / 'prot.bin')
    music = map_music(maps)
    meta = {
        'w': W, 'h': H, 'cols': ATLAS_COLS, 'count': n,
        'outdoor': {'w': W, 'h': H_OUT}, 'roomsY0': ROOM_Y0, 'layoutId': G['layout_id'],
        'entries': [[e['mid'], e['pair'], e['beh'], e['col'], e['mat'], e.get('base', -1), int(e['above'][:, :, 3].any()),
                     e['enc']] for e in entries],
        'materials': {**MATERIALS, **BN.MATERIALS, **{k: v for k, v in {**BS.MATERIALS, **BE.MATERIALS}.items()
                                                      if k not in MATERIALS and k not in BN.MATERIALS}},
        'ores': {name: {'drop': drop, 'hard': hard, 'tier': tier} for name, drop, hard, tier in ORES},
        'prot': PROT,
        'maps': maps, 'towns': G['towns'], 'pairs': G['pairs'] + ['nether', 'stronghold', 'end'],
        'trees': {'tip': sorted(TREE_TIP), 'overlap': sorted(TREE_OVERLAP), 'crown': sorted(TREE_CROWN), 'base': sorted(TREE_BASE)},
        'warps': warps, 'doors': doors, 'npcs': npcs, 'npcSheets': sheets, 'marts': marts, 'music': music,
        'lava': lava, 'nether': nether, 'stronghold': strong, 'end': end,
    }
    json.dump(meta, open(OUT / 'world.json', 'w'), separators=(',', ':'))
    export_autotile(families)
    # the generated worlds' tile bank (tools/build_terrain.py): terrain.json, atlas_gen.png and atlas_gen_top.png,
    # numbered after every entry above; nothing written above changes
    BT.attach(entries, grid, OUT)
    print(f'wrote atlas ({n} tiles), grid {W}x{H}, {len(warps)} warps, {len(doors)} door styles, {len(npcs)} npcs')
    if os.environ.get('RS_NO_PREVIEW'):
        return     # setup.sh: the previews below are only for eyeballing, in out/
    # preview of the outdoor block for eyeballing (rooms: see the montage tools)
    prev = np.zeros((H_OUT * 16, W * 16, 4), np.uint8)
    for y in range(H_OUT):
        for x in range(W):
            if zone[y, x] == 2:
                continue
            e = entries[grid[y, x]]
            t = e['below'].copy(); t[...] = np.where(e['above'][:, :, 3:4] > 0, e['above'], t)
            prev[y * 16:y * 16 + 16, x * 16:x * 16 + 16] = t
    (HERE / 'out').mkdir(exist_ok=True)
    Image.fromarray(prev, 'RGBA').save(HERE / 'out' / 'world_preview.png')
    # and the Nether, straight from the grid and the atlas, with its pre-placed blocks
    im = BN.preview(entries, grid[ny0:ny0 + BN.NH, nx0:nx0 + BN.NW])
    BN.draw_blocks(im, [tuple(b) for b in nether['blocks']], nx0, ny0)
    im.save(HERE / 'out' / 'nether_preview.png')
    # the stronghold (with its pre-placed blocks) and The End
    im = BS.preview(entries, grid[sy0:sy0 + BS.SH, sx0:sx0 + BS.SW], [tuple(b) for b in strong['blocks']], sx0, sy0)
    im.save(HERE / 'out' / 'stronghold_preview.png')
    BE.preview(entries, grid[ey0:ey0 + BE.EH, ex0:ex0 + BE.EW]).save(HERE / 'out' / 'end_preview.png')


# ---------------------------------------------------------------- rooms: materials and wall families
FOLIAGE = {'leaves', 'lime_concrete', 'green_concrete'}


def room_material(e, kind):
    """Caves: walls are rock (minable, ore-bearing), floors floor. The forest's big trees are trees (logs).
    Indoors, rugs and mats are floor rather than flowers."""
    m = e['mat']
    if kind == 'cave':
        if m in ('water', 'water_rock', 'ledge', 'sign'):
            return m
        if e['beh'] in TRIG or m == 'door':
            return m if e['col'] else 'floor'
        return 'rock' if e['col'] else 'floor'
    if kind == 'field' and e['col'] and e['mid'] >= 640 and m in FOLIAGE:
        return 'tree'
    if kind == 'indoor' and m == 'flower':
        return 'floor'
    return m


def learn_families(G, entries, sec_index, add, pair_kind):
    """An autotile family per cave tileset (its wall pieces) and for the forest (its tree pieces), learned
    from every FireRed map drawn with that tileset. Candidates are atlas indices; any piece FireRed uses
    that Kanto's maps don't gets its own entry here, with the room entries."""
    fams = {}
    for pi, kind in sorted(pair_kind.items()):
        if kind not in ('cave', 'field'):
            continue
        pk, sk = G['pair_keys'][pi]
        R = G['renderers'][G['pairs'][pi]]
        want = 'rock' if kind == 'cave' else 'tree'
        votes = defaultdict(Counter)
        for _, data in AT.pair_maps(pk, sk):
            for v, c in zip(*np.unique(data, return_counts=True)):
                votes[int(v) & 0x3FF][int((int(v) >> 10) & 3 != 0)] += int(c)
        def mat_of(mid):
            if (pi, mid) in sec_index:
                return entries[sec_index[(pi, mid)]]['mat']
            b, a = R.render(mid)
            at = R.attr(mid)
            colv = votes[mid].most_common(1)[0][0]
            e = dict(mid=mid, beh=min(255, at & 0x1FF), col=colv, below=b, above=a)
            e['mat'] = classify(mid, e['beh'], colv, b, a, False)
            return room_material(e, kind)
        members = {mid for mid in votes if mid >= 640 and mat_of(mid) == want}
        # ladders, holes, the black void and other one-offs stay where they are: they shape the mask but
        # are never picked as an edge piece
        def dark(mid):
            b, a = R.render(mid)
            t = composite(dict(below=b, above=a))[:, :, :3].astype(int)
            return ((t @ np.array([299, 587, 114])) / 1000 < 40).mean() > 0.15
        keep = {mid for mid in members if sum(votes[mid].values()) < 12 or dark(mid)}
        tables = AT.learn_family(pk, sk, members)
        def idx(mid):
            if (pi, mid) not in sec_index:
                sec_index[(pi, mid)] = add(mid, pi, R)
                e = entries[-1]
                e['col'] = votes[mid].most_common(1)[0][0] if votes[mid] else 1
                e['mat'] = room_material(dict(e, mat=classify(mid, e['beh'], e['col'], e['below'], e['above'], False)), kind)
            return sec_index[(pi, mid)]
        out = {'pair': pi, 'kind': kind, 'tileset': sk}
        for r, key in ((2, 'r2'), (1, 'r1'), ('fill', 'fill')):
            out[key] = {}
            for k, v in sorted(tables[r].items()):
                if r != 'fill' and sum(v.values()) < 3:
                    continue        # a pattern seen once or twice is a one-off, not an edge rule
                c = [idx(m) for m, _ in v.most_common() if m not in keep][:3]
                if c:
                    out[key][str(k)] = c
        out['members'] = sorted(idx(m) for m in members if (pi, m) in sec_index)
        out['keep'] = sorted(sec_index[(pi, m)] for m in keep if (pi, m) in sec_index)
        name = f"{'cave' if kind == 'cave' else 'forest'}:{sk[len('gTileset_'):]}"
        fams[name] = out
        print(f'  family {name}: {len(members)} pieces ({len(keep)} kept as they are), {len(out["r2"])} 5x5 / '
              f'{len(out["r1"])} 3x3 patterns, {len(out["fill"])} unseen 3x3 filled')
    return fams


def room_ring(G, H, W):
    """The outermost cells of every room: never minable, so a room can't be dug out of."""
    ring = np.zeros((H, W), bool)
    for mid, ox, oy, L, _ in G['placed'][G['n_out']:]:
        w, h = L['width'], L['height']
        ring[oy, ox:ox + w] = ring[oy + h - 1, ox:ox + w] = True
        ring[oy:oy + h, ox] = ring[oy:oy + h, ox + w - 1] = True
    return ring


# ---------------------------------------------------------------- ores
def hash01_np(xs, ys, salt):
    h = (xs.astype(np.uint64) * 374761393 + ys.astype(np.uint64) * 668265263 + salt * 1442695041) & 0xFFFFFFFF
    h = ((h ^ (h >> np.uint64(13))) * np.uint64(1274126177)) & 0xFFFFFFFF
    h ^= h >> np.uint64(16)
    return h.astype(np.float64) / 4294967296.0


def place_ores(entries, grid, cand, maps, area, mask_for, ore_entries, stats):
    """Ore veins in minable rock. Each rock cell may seed a vein (a hash of the cell salted by its map, against
    chance / mean vein size for the map's depth); the vein then grows into neighbouring rock of the same map."""
    H, W = grid.shape
    good = {}
    def eligible(t):
        if t not in good:
            e = entries[t]
            fn, need = mask_for(e['pair'])
            good[t] = e['mat'] == 'rock' and int(fn(composite(e)).sum()) >= need
        return good[t]
    ok = np.zeros((H, W), bool)
    for y, x in zip(*np.nonzero(cand)):
        ok[y, x] = eligible(int(grid[y, x]))
    taken = np.zeros((H, W), bool)
    for y, x in zip(*np.nonzero(ok)):
        if taken[y, x]:
            continue
        a = int(area[y, x])
        m = maps[a - 1]
        salt = zlib.crc32(m['id'].encode()) & 0xFFFF
        r, acc, pick = hash01(int(x), int(y), salt), 0.0, None
        for name, *_ in ORES:
            lo, hi = VEIN[name]
            acc += ore_chance(name, m['depth'], m['id']) / ((lo + hi) / 2)
            if r < acc:
                pick = name
                break
        if not pick:
            continue
        lo, hi = VEIN[pick]
        size = lo + int(hash01(int(x), int(y), salt + 1) * (hi - lo + 1))
        vein = [(int(x), int(y))]
        taken[y, x] = True
        while len(vein) < size:
            best = None
            for vx, vy in vein:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    xx, yy = vx + dx, vy + dy
                    if 0 <= xx < W and 0 <= yy < H and ok[yy, xx] and not taken[yy, xx] and area[yy, xx] == a:
                        h = hash01(xx, yy, salt + 2)
                        if best is None or h < best[0]:
                            best = (h, xx, yy)
            if best is None:
                break
            taken[best[2], best[1]] = True
            vein.append((best[1], best[2]))
        for vx, vy in vein:
            t = ore_entry(entries, ore_entries, int(grid[vy, vx]), pick, mask_for)
            if t is not None:
                grid[vy, vx] = t
                stats[(a - 1, pick)] += 1


def ore_entry(entries, ore_entries, base, pick, mask_for):
    """The atlas entry of ore `pick` painted into rock tile `base` (made on first use), or None."""
    key = (base, pick)
    if key not in ore_entries:
        e = entries[base]
        res = paint_ore(e['below'], e['above'], pick, mask_for(e['pair'])[0])
        ore_entries[key] = None if res is None else len(entries)
        if res is not None:
            entries.append(dict(mid=e['mid'], pair=e['pair'], below=res[0], above=res[1], beh=e['beh'], enc=e['enc'],
                                col=e['col'], mat=pick, base=base))
    return ore_entries[key]


def report_ores(stats, maps):
    by_depth = defaultdict(Counter)
    for (mi, ore), n in stats.items():
        by_depth['surface' if maps[mi]['kind'] in ('outdoor', 'field') else f"depth {maps[mi]['depth']}"][ore] += n
    for d in sorted(by_depth):
        print(f'  ores {d}:', dict(by_depth[d].most_common()))
    for mi in sorted({mi for mi, _ in stats}):
        if maps[mi]['kind'] == 'cave':
            print(f"    {maps[mi]['id']} (depth {maps[mi]['depth']}):",
                  {o[:-4]: n for (m2, o), n in sorted(stats.items()) if m2 == mi})


# ---------------------------------------------------------------- protection
PROT = {'structure': 1, 'door': 2, 'opening': 3, 'monument': 4}
NATURAL = {'tree', 'leaves', 'rock', 'water', 'water_rock', 'boulder', 'ledge', 'tallgrass', 'flower', 'bush',
           'fence_oak', 'fence_birch', 'sign', 'floor', 'sand'} | {o[0] for o in ORES}


def build_prot(G, entries, grid, col, zone, warps, ring):
    """prot.bin (u8 per cell): 0 normal, 1 structure, 2 door (minable into a doorway), 3 opening or warp,
    4 monument (mining.md 4.1). Outdoors (and in the forest) a structure is a blocked, man-made cell plus up
    to 3 rows of roof edge drawn above it; the part a door's flood fill reaches is a building (1), the rest
    (pillars, fountains, walls, pens, bridge railings) a monument (4). Indoors everything but the walkable
    floor is 1; in caves and the forest the room's edge ring is 3; every warp is 3 (a door with a style 2)."""
    H, W = grid.shape
    maps, area, fr_maps = G['maps'], G['area'], G['fr_maps']
    code = {'outdoor': 1, 'field': 2, 'indoor': 3, 'cave': 4}
    K = np.array([0] + [code[m['kind']] for m in maps], np.uint8)[area]
    mat = np.array([e['mat'] for e in entries])[grid]
    top = np.array([bool(e['above'][:, :, 3].any()) for e in entries])[grid]
    natural = np.isin(mat, sorted(NATURAL))
    air = (K == 1) | (K == 2)
    S = (col == 1) & (zone == 0) & air & ~natural
    P = S.copy()
    for _ in range(3):
        up = np.zeros_like(P); up[:-1] = P[1:]
        P |= up & (col == 0) & top & (mat != 'tree') & (mat != 'water') & (zone == 0) & air
    # which structures a door leads into: flood from every door to a building
    wcell = np.zeros((H, W), bool)
    for w in warps:
        wcell[w['y'], w['x']] = True
    fillable = P | (wcell & air)
    reached = np.zeros((H, W), bool)
    dq = deque()
    for w in warps:
        x, y = w['x'], w['y']
        if not air[y, x] or fr_maps.get(w['dest'], {}).get('map_type') == 'MAP_TYPE_UNDERGROUND':
            continue
        # the door cell itself, or the building cells around a walk-in doorway
        seeds = [(x, y)] if fillable[y, x] else [(x + dx, y + dy) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
        for xx, yy in seeds:
            if fillable[yy, xx] and not reached[yy, xx]:
                reached[yy, xx] = True
                dq.append((xx, yy))
    while dq:
        x, y = dq.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            xx, yy = x + dx, y + dy
            if 0 <= xx < W and 0 <= yy < H and fillable[yy, xx] and not reached[yy, xx]:
                reached[yy, xx] = True
                dq.append((xx, yy))
    prot = np.zeros((H, W), np.uint8)
    prot[P & reached] = 1
    prot[P & ~reached] = 4
    indoor = K == 3
    prot[indoor] = 1
    prot[indoor & (col == 0)] = 0
    prot[ring & ((K == 4) | (K == 2))] = 3
    for w in warps:
        prot[w['y'], w['x']] = 2 if (w['door'] is not None and air[w['y'], w['x']]) else 3
    names = {v: k for k, v in PROT.items()}
    for k, label in ((1, 'outdoor'), (2, 'forest'), (3, 'indoor'), (4, 'cave')):
        c = Counter(prot[K == k].tolist())
        print(f'  protected {label}:', {names[v]: n for v, n in sorted(c.items()) if v})
    print(f'  roof edges (eaves) {int((P & ~S).sum())}, buildings reached from a door {int((P & reached).sum())}, '
          f'monument cells {int((P & ~reached).sum())}')
    return prot


# ---------------------------------------------------------------- ground left behind
# Plain ground tiles (mining.md 7): FireRed's four grass variants, path, sand, beach and pavement, plus a
# few town pavements. Rooms use their own floors (tiles that fill whole areas of the room).
PLAIN = {'gTileset_General': {'grass': (1, 8, 9, 16, 17), 'path': (217,), 'sand': (220,), 'beach': (277,), 'pave': (366,),
                             'mint': (198,), 'stone': (449,), 'planks': (454,)},
         'gTileset_PalletTown': {'pallet': (662,)},
         'gTileset_SaffronCity': {'saffron': (745,), 'saffron_olive': (748,)},
         'gTileset_IndigoPlateau': {'indigo': (650,)}}
WINDOWS = (3, 5, 8, 12)      # 7x7 growing to 25x25


def box_sum(a, r):
    """Sum of a over the (2r+1)^2 window around every cell, clipped at the edges."""
    h, w = a.shape
    c = np.zeros((h + 1, w + 1), np.int64)
    c[1:, 1:] = a.cumsum(0).cumsum(1)
    y0 = np.clip(np.arange(h) - r, 0, h); y1 = np.clip(np.arange(h) + r + 1, 0, h)
    x0 = np.clip(np.arange(w) - r, 0, w); x1 = np.clip(np.arange(w) + r + 1, 0, w)
    return c[y1][:, x1] - c[y0][:, x1] - c[y1][:, x0] + c[y0][:, x0]


def plain_refill(sub, valid, fam_of, x0, y0):
    """For every cell of a region: the family (grass, path, sand, a pavement, a room's floor) most common
    among the plain cells in a window growing from 7x7 to 25x25, then a tile of that family, drawn by a
    hash of the cell and weighted by how often each variant appears there. Returns -1 where nothing found."""
    h, w = sub.shape
    tiles = [int(t) for t in np.unique(sub[valid]) if int(t) in fam_of]
    out = np.full((h, w), -1, np.int64)
    if not tiles:
        return out
    fams = sorted({fam_of[t] for t in tiles})
    ind = {t: ((sub == t) & valid).astype(np.int64) for t in tiles}
    ys, xs = np.mgrid[0:h, 0:w]
    u = hash01_np(xs + x0, ys + y0, 99)
    for r in WINDOWS:
        cnt = {t: box_sum(ind[t], r) for t in tiles}
        fc = np.stack([sum(cnt[t] for t in tiles if fam_of[t] == f) for f in fams])
        todo = (out < 0) & (fc.sum(0) > 0)
        if not todo.any():
            continue
        best = fc.argmax(0)
        for fi, f in enumerate(fams):
            sel = todo & (best == fi)
            if not sel.any():
                continue
            ft = [t for t in tiles if fam_of[t] == f]
            C = np.cumsum(np.stack([cnt[t] for t in ft]).astype(np.float64), 0)
            k = np.minimum((C <= (u * C[-1])[None]).sum(0), len(ft) - 1)
            out[sel] = np.array(ft)[k][sel]
    if (out < 0).any():
        n = Counter({t: int(ind[t].sum()) for t in tiles})
        out[out < 0] = n.most_common(1)[0][0]
    return out


def nearest(src, sub):
    """For every cell, the tile of the nearest src cell (4-neighbour breadth-first)."""
    h, w = src.shape
    out = np.full((h, w), -1, np.int32)
    dq = deque()
    for y, x in zip(*np.nonzero(src)):
        out[y, x] = sub[y, x]; dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            xx, yy = x + dx, y + dy
            if 0 <= xx < w and 0 <= yy < h and out[yy, xx] < 0:
                out[yy, xx] = out[y, x]; dq.append((xx, yy))
    return out


def build_ground(G, entries, grid, zone, sec_index):
    """ground.bin: the tile a broken cell becomes. Plain ground of the area's dominant family (no edge or
    shore pieces, so no stripes); sea rocks become open water. The outdoor block and each room are filled
    separately, so a room only ever uses its own floors."""
    H, W = grid.shape
    pairs = G['pairs']
    fam_of = {}
    for pname, fams in PLAIN.items():
        pi = -1 if pname == 'gTileset_General' else (pairs.index(pname) if pname in pairs else None)
        for f, ids in fams.items():
            for mid in ids:
                i = mid if pi == -1 else sec_index.get((pi, mid))
                if i is not None:
                    fam_of[i] = f
    # room floors: walkable plain tiles that fill whole areas (a cell and its four neighbours the same)
    n_out_pairs = len({pi for *_, pi in G['placed'][:G['n_out']]})
    rooms = G['placed'][G['n_out']:]
    inner = Counter()
    for mid, ox, oy, L, _ in rooms:
        s = grid[oy:oy + L['height'], ox:ox + L['width']]
        same = (s[1:-1, 1:-1] == s[:-2, 1:-1]) & (s[1:-1, 1:-1] == s[2:, 1:-1]) & (s[1:-1, 1:-1] == s[1:-1, :-2]) & (s[1:-1, 1:-1] == s[1:-1, 2:])
        inner.update(s[1:-1, 1:-1][same].tolist())
    for t, n in inner.items():
        e = entries[t]
        if (n >= 3 and e['pair'] >= n_out_pairs and e['col'] == 0 and e['mat'] in ('floor', 'sand')
                and not e['above'][:, :, 3].any() and e['beh'] not in TRIG and e['beh'] not in WATER):
            fam_of[t] = f'floor{t}'
    isw = np.array([e['mat'] == 'water' and e['beh'] in WATER and not e['above'][:, :, 3].any() for e in entries])
    isrock = np.array([e['mat'] == 'water_rock' for e in entries])
    walk = np.array([e['col'] == 0 and e['beh'] not in WATER and e['beh'] not in TRIG and not e['above'][:, :, 3].any()
                     for e in entries])
    ground = np.zeros((H, W), np.int64)
    regions = [(0, H_OUT, 0, W, zone[:H_OUT] != 2)] + \
        [(oy, oy + L['height'], ox, ox + L['width'], None) for mid, ox, oy, L, _ in rooms]
    for y0, y1, x0, x1, valid in regions:
        sub = grid[y0:y1, x0:x1]
        valid = np.ones(sub.shape, bool) if valid is None else valid
        out = plain_refill(sub, valid, fam_of, x0, y0)
        if (out < 0).all():          # no plain floor at all: the room's commonest walkable tile
            c = Counter(int(t) for t in sub[walk[sub] & valid].ravel())
            out[...] = c.most_common(1)[0][0] if c else int(sub[0, 0])
        if isrock[sub].any():
            near_water = nearest(isw[sub] & valid, sub) if (isw[sub] & valid).any() else out
            out = np.where(isrock[sub] & (near_water >= 0), near_water, out)
        ground[y0:y1, x0:x1] = out
    g = ground[:H_OUT][zone[:H_OUT] == 0]
    plain = np.isin(g, sorted(fam_of)) | isw[g]
    print(f'  ground: {plain.mean() * 100:.1f}% of outdoor map cells refill with a plain tile; '
          f'families {Counter(fam_of[int(t)] for t in g if int(t) in fam_of).most_common()}')
    return ground


# ---------------------------------------------------------------- warps
# FireRed's warp triggers (field_control_avatar.c): doors are bumped facing north, cave doors, ladders,
# holes, pads and escalators fire after a completed step, arrows and stairs fire while standing on them
# and pressing their direction. Anything else never fires on its own.
TRIG = {0x69: 'bump', 0x60: 'step', 0x61: 'step', 0x66: 'step', 0x67: 'step', 0x6A: 'step', 0x6B: 'step',
        0x62: 'arrowE', 0x63: 'arrowW', 0x64: 'arrowN', 0x65: 'arrowS',
        0x6C: 'stairsE', 0x6E: 'stairsE', 0x6D: 'stairsW', 0x6F: 'stairsW'}


def arrival(d):
    """Where and how the player appears on destination warp d (overworld.c GetAdjustedInitialDirection,
    field_fadetransition.c SetUpWarpExitTask): (facing or None to keep it, 'walk' | 'none')."""
    b, t = d['beh'], d['trig']
    if b == 0x69 or b == 0x60 or d['col']:
        return 'down', 'walk'           # out of a door or cave mouth, one step south
    if b in (0x6A, 0x6B):
        return 'right', 'walk'          # off the escalator
    if b == 0x61:
        return None, 'none'             # ladders keep the facing
    return {'arrowS': 'up', 'arrowN': 'down', 'arrowE': 'left', 'arrowW': 'right',
            'stairsE': 'left', 'stairsW': 'right'}.get(t, 'down'), 'none'


def build_warps(G, beh, col):
    maps, alias = G['fr_maps'], G['alias']
    rect = {mid: (ox, oy, L['width'], L['height']) for mid, ox, oy, L, _ in G['placed']}
    rooms = {mid for mid, *_ in G['placed'][G['n_out']:]}
    recs, index = [], {}
    for mid, ox, oy, L, _ in G['placed']:
        for i, w in enumerate(maps[mid].get('warp_events') or []):
            x, y = ox + w['x'], oy + w['y']
            index[(mid, i)] = len(recs)
            b = int(beh[y, x])
            recs.append(dict(x=x, y=y, map=mid, beh=b, col=int(col[y, x]), trig=TRIG.get(b, 'inert'),
                             dest=alias.get(w['dest_map'], w['dest_map']), did=w['dest_warp_id']))
    # friendlier than FireRed: the side cells of 3-wide exit mats (inert warps on walkable cells with a
    # wall below) work like the middle S-arrow
    for r in recs:
        if r['trig'] == 'inert' and r['map'] in rooms and not r['col']:
            ox, oy, w, h = rect[r['map']]
            if r['y'] + 1 >= oy + h or col[r['y'] + 1, r['x']]:
                r['trig'] = 'arrowS'
    out = []
    for r in recs:
        to = index.get((r['dest'], int(r['did']))) if str(r['did']).isdigit() and r['dest'] in rect else None
        o = dict(x=r['x'], y=r['y'], map=r['map'], trig=r['trig'], to=to, dest=r['dest'],
                 ax=None, ay=None, adir=None, amove=None, door=None)
        if to is not None:
            d = recs[to]
            o['ax'], o['ay'] = d['x'], d['y']
            o['adir'], o['amove'] = arrival(d)
        out.append(o)
    for o, r in zip(out, recs):
        o['_beh'] = r['beh']
    print('warps', len(out), Counter(o['trig'] for o in out).most_common(), 'closed', sum(o['to'] is None for o in out))
    return out


# ---------------------------------------------------------------- doors
DOOR_STYLES = {'general': ('house', 'House Door'), 'sliding_single': ('mart', 'Sliding Door'),
               'sliding_double': ('gym', 'Double Sliding Door'), 'pallet': ('pallet', 'Pallet Town Door'),
               'oaks_lab': ('oaks_lab', "Oak's Lab Door"), 'viridian': ('viridian', 'Viridian Door'),
               'pewter': ('pewter', 'Pewter Door'), 'saffron': ('saffron', 'Saffron Door'),
               'silph_co': ('silph', 'Silph Co. Door'), 'cerulean': ('cerulean', 'Cerulean Door'),
               'lavender': ('lavender', 'Lavender Door'), 'vermilion': ('vermilion', 'Vermilion Door'),
               'dept_store': ('dept_store', 'Dept. Store Door'), 'fuchsia': ('fuchsia', 'Fuchsia Door'),
               'safari_zone': ('safari', 'Safari Zone Door'), 'cinnabar_lab': ('cinnabar_lab', 'Cinnabar Lab Door'),
               'pokemon_fan_club': ('fan_club', 'Fan Club Door')}


def build_doors(G, entries, grid, warps, anyR):
    """One style per animated 1x1 door tile at a warp: its three opening frames (field_door.c), coloured
    with that tile's palette slot and laid over the closed tile, plus an open-doorway atlas entry (frame 3).
    The doorway stays solid with behaviour 0x69, so the warp still works once the door is gone."""
    DG = door_graphics()
    styles, cols, used = {}, [], set()
    for w in warps:
        b = w.pop('_beh')
        if b != 0x69:
            continue
        ci = int(grid[w['y'], w['x']])
        e = entries[ci]
        g = DG.get(e['mid'])
        if not g or g['size'] != '1x1':
            continue
        if ci not in styles:
            sid, name = DOOR_STYLES.get(Path(g['png']).stem, (Path(g['png']).stem, Path(g['png']).stem.title() + ' Door'))
            if sid in used:
                sid += f'_{len(styles)}'
            used.add(sid)
            R = anyR if e['pair'] < 0 else G['renderers'][G['pairs'][e['pair']]]
            idx = load_indexed(g['png'])
            lut = R.lut[g['pals'][0]]
            frames = []
            for k in range(3):
                t = idx[k * 16:(k + 1) * 16, :16]
                f = e['below'].copy()
                m = t != 0
                f[m, :3] = lut[t][m]; f[m, 3] = 255
                frames.append(f)
            entries.append(dict(mid=e['mid'], pair=e['pair'], below=frames[2], above=e['above'].copy(), beh=0x69, enc=0,
                                col=1, mat='doorway', base=ci))
            styles[ci] = dict(style=sid, name=name, mid=e['mid'], pair=e['pair'], closed=ci, open=len(entries) - 1,
                              anim=len(cols), sound=g['sound'], cells=0)
            cols.append(np.concatenate(frames, axis=0))
        styles[ci]['cells'] += 1
        w['door'] = styles[ci]['anim']
    frames = np.concatenate(cols, axis=1) if cols else np.zeros((48, 16, 4), np.uint8)
    doors = sorted(styles.values(), key=lambda s: s['anim'])
    print('door styles', [(d['style'], d['cells']) for d in doors])
    return doors, frames


# ---------------------------------------------------------------- people in the rooms
SKIP_GFX = {'OBJ_EVENT_GFX_ITEM_BALL', 'OBJ_EVENT_GFX_PUSHABLE_BOULDER', 'OBJ_EVENT_GFX_ROCK_SMASH_ROCK',
            'OBJ_EVENT_GFX_CUT_TREE'}
SIMPLE_OPS = {'lock', 'lockall', 'faceplayer', 'release', 'releaseall', 'waitmessage', 'closemessage', 'waitbuttonpress',
              'goto_if_questlog', 'textcolor', 'playse', 'waitse', 'playmoncry', 'waitmoncry', 'famechecker'}
GENERIC_TEXT = ['Hi there!']
TRAINER_TEXT = ["I'm training here.\nLet's battle another time!"]


def script_reach(label, scripts):
    """Every script label reachable from label through goto/call."""
    seen, stack = [], [label]
    while stack:
        l = stack.pop()
        if l in seen or l not in scripts:
            continue
        seen.append(l)
        for ln in scripts[l]:
            op, _, args = ln.partition(' ')
            if op in ('goto', 'call') or op.startswith(('goto_if', 'call_if')):
                stack.append(args.split(',')[-1].strip())
    return seen


def script_pages(label, scripts, texts, depth=0):
    """The pages a script shows at the start of a new game (no flags set), or None if it does anything
    the runtime can't fake (menus, vars, movement, buffers)."""
    pages = []
    for ln in scripts.get(label, []):
        op, _, args = ln.partition(' ')
        a = [x.strip() for x in args.split(',')]
        if op in SIMPLE_OPS or op == 'goto_if_set':         # no flags are set yet
            continue
        if op in ('end', 'return'):
            return pages
        if op in ('msgbox', 'message'):
            p = text_pages(texts.get(a[0], ''))
            if p is None:
                return None
            pages += p
        elif op in ('goto', 'goto_if_unset', 'call') and depth < 6:
            sub = script_pages(a[-1], scripts, texts, depth + 1)
            if sub is None:
                return None
            pages += sub
            if op != 'call':
                return pages
        else:
            return None
    return pages


def npc_text(label, scripts, texts):
    if any(ln.startswith('trainerbattle') for ln in scripts.get(label, [])):
        return TRAINER_TEXT
    return script_pages(label, scripts, texts) or GENERIC_TEXT


def build_npcs(G):
    """object_events of every room as world.json npcs, their sheets in assets/sprites/npc/, mart lists."""
    gfx, scripts, texts = object_gfx(), parse_scripts(), parse_texts()
    hidden = {ln.split()[1] for ln in scripts['EventScript_ResetAllMapFlags'] if ln.startswith('setflag')}
    pages = lambda *labels: [p for l in labels for p in (text_pages(texts[l]) or [])]
    sheet_dir = HERE / 'assets' / 'sprites' / 'npc'
    sheet_dir.mkdir(parents=True, exist_ok=True)
    for f in sheet_dir.glob('*.png'):
        f.unlink()
    npcs, sheets, marts, skipped = [], {}, {}, Counter()
    for mid, ox, oy, L, _ in G['placed'][G['n_out']:]:
        for o in G['fr_maps'][mid].get('object_events') or []:
            gid = o.get('graphics_id')
            if o.get('type', 'object') != 'object' or gid in SKIP_GFX or gid not in gfx:
                skipped[gid] += 1
                continue
            name = gid[len('OBJ_EVENT_GFX_'):].lower()
            if name not in sheets:
                g = gfx[gid]
                img = npc_sheet(g)
                Image.fromarray(img, 'RGBA').save(sheet_dir / f'{name}.png')
                sheets[name] = {'w': g['w'], 'h': g['h'], 'n': len(g['frames'])}
            mt = o['movement_type']
            face = next((d.lower() for d in re.findall(r'UP|DOWN|LEFT|RIGHT', mt[len('MOVEMENT_TYPE_'):])), 'down')
            label = o['script']
            mart = next((ln.split()[1] for l in script_reach(label, scripts) for ln in scripts[l] if ln.startswith('pokemart ')), None)
            if gid == 'OBJ_EVENT_GFX_NURSE':
                role, text = 'nurse', pages('Text_WelcomeWantToHealPkmn')
            elif mart:
                role, text = 'clerk', pages('Text_MayIHelpYou')
                marts[mart] = [ln.split()[1][len('ITEM_'):] for ln in scripts[mart]
                               if ln.startswith('.2byte ITEM_') and ln.split()[1] != 'ITEM_NONE']
            elif gid == 'OBJ_EVENT_GFX_MOM':
                role, text = 'mom', pages('PalletTown_PlayersHouse_1F_Text_YouShouldTakeQuickRest',
                                          'PalletTown_PlayersHouse_1F_Text_LookingGreatTakeCare')
            else:
                role, text = 'npc', npc_text(label, scripts, texts)
                if text is GENERIC_TEXT and '/pokemon/' in str(gfx[gid]['png']):
                    text = [name.upper().replace('_', ' ') + '!']    # a Pokémon standing in the world
            npcs.append({'x': ox + o['x'], 'y': oy + o['y'], 'map': mid, 'gfx': name, 'face': face,
                         'move': 'wander' if any(k in mt for k in ('WANDER', 'WALK_', 'BACK_AND_FORTH')) else 'static',
                         'range': [int(o.get('movement_range_x', 0)), int(o.get('movement_range_y', 0))],
                         'hidden': o.get('flag') in hidden, 'role': role, 'mart': mart, 'text': text, 'script': label})
    print(f'npcs {len(npcs)} ({Counter(n["role"] for n in npcs)}), {len(sheets)} sheets, {len(marts)} marts; skipped',
          sum(skipped.values()), skipped.most_common(6))
    return npcs, sheets, marts


def map_music(maps):
    """FireRed MUS_* of every map -> the song file tools/build_music.py renders for it."""
    from build_music import SONGS
    out = {}
    for mus in dict.fromkeys(m['music'] for m in maps):
        if not mus.startswith('MUS_'):
            continue        # the Nether has no FireRed song (its ambience is Minecraft's)
        song = mus[len('MUS_'):].lower()
        if song in SONGS:
            out[mus] = song
        else:
            print('  no song rendered for', mus, '(add it to build_music.SONGS)')
    return out


def AT_learned_collision():
    cnt = {}
    for _, grid in AT.training_maps():
        pass
    maps = [json.load(open(f)) for f in FR.glob('data/maps/*/map.json')]
    layouts = {l['id']: l for l in json.load(open(FR / 'data/layouts/layouts.json'))['layouts'] if 'id' in l}
    for m in maps:
        l = layouts.get(m['layout'])
        if not l or l['primary_tileset'] != 'gTileset_General':
            continue
        d = np.fromfile(FR / l['blockdata_filepath'], dtype='<u2')
        for e in d:
            e = int(e); mid = e & 0x3FF
            if mid >= 640:
                continue
            cnt.setdefault(mid, Counter())[(e >> 10) & 3 != 0] += 1
    return {k: v.most_common(1)[0][0] for k, v in cnt.items()}


def export_autotile(families):
    """The learned cliff autotiler as lookup tables: 5x5 and 3x3 in/out masks (with the local ground
    class) -> the metatile FireRed uses there, most common first. families: the cave-wall and forest-tree
    families, keyed 'cave:<tileset>' / 'forest:<tileset>', in atlas indices: {pair, kind, tileset, members,
    keep, r2, r1, fill}. A cell is in the family when its entry (or an ore's base entry) is a member; cells
    outside the room count as in. r2/r1 are the 5x5/3x3 patterns FireRed draws; fill covers the other 3x3
    ones with the nearest learned pattern. Members in keep (ladders, holes, the black void) are never
    re-picked."""
    tables, tables_g = AT.learn('mountain')
    out = {}
    for r in (2, 1):
        out[f'r{r}'] = {str(k): [int(c) for c, _ in v.most_common(3)] for k, v in tables[r].items()}
        out[f'g{r}'] = {f'{k}|{g}': [int(c) for c, _ in v.most_common(3)] for (k, g), v in tables_g[r].items()}
    compat = {}
    for mid in AT.MOUNTAIN_IDS:
        gp, sp = AT.ground_pixels(mid)
        compat[mid] = [int(gp > 0), int(sp > 0)]
    out['compat'] = compat
    out['mountain'] = sorted(m for m in AT.MOUNTAIN_IDS if AT.is_mountain(m))
    out['families'] = families
    json.dump(out, open(OUT / 'autotile.json', 'w'), separators=(',', ':'))
    print('autotile tables', {k: len(v) for k, v in out.items() if isinstance(v, dict)})


if __name__ == '__main__':
    main()
