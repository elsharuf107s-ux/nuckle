#!/usr/bin/env python3
"""The minimap's colours and pictures (minimap-design.md 3.2 to 3.4, 3.13; Track MAP).

Writes, from files already in the project (nothing is downloaded):

  assets/world/mapcolor.json   Minecraft's map colours as classes (each expanded at run time to Minecraft's four
                               shades), one class byte per atlas entry for Classic (world.json) and for the generated
                               bank (terrain.json), a material-only fallback, the placed blocks' classes, the coarse
                               plan code to class table (src/gen/biomes.js, read as text: the runtime never imports
                               src/gen/), the water depth per biome map, the fog colours and the co-op skins' shirt
                               colours.
  assets/mc/map/background.png Minecraft's map_background.png (the parchment), copied.
  assets/mc/map/icons.png      an 8 x 8 strip: Steve's pointer up, right, down, left; the white and red banners; the
                               target point; the five village icons; the off-map dot; the eight Kanto edge arrows
                               (drawn here in the style of red_marker.png); the phone button's glyph.

Classes are numbered from 1 (0 is "unexplored" in the overview bytes); a palette index is class * 4 + shade. Bit 7
of an entry's byte marks tall grass, which the runtime always draws in the low shade.

  python3 tools/build_minimap.py [--review DIR]

--review writes Classic Kanto's outdoors and its rooms coloured with the table (one pixel per cell, 2x), the icon
strip at 8x and the classes' swatches, for looking at by eye.
"""
import base64
import colorsys
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
WORLD = ROOT / 'assets' / 'world'
MC = ROOT / 'assets' / 'mc'
VEND = ROOT / 'vendor' / 'minecraft' / 'jar' / 'assets' / 'minecraft' / 'textures' / 'map'

# ---------------------------------------------------------------- the classes (Minecraft's MapColor bases)
# name, rgb, height (water 0; ground 1; rock, buildings and wood 2; leaves 3), Minecraft source
CLASSES = [
    ('none', (0, 0, 0), 1),
    ('grass_temperate', (127, 178, 56), 1),     # GRASS
    ('grass_cool', (98, 150, 80), 1),           # Bedrock-style biome tints
    ('grass_dry', (189, 178, 84), 1),
    ('grass_lush', (89, 190, 52), 1),
    ('grass_swamp', (106, 112, 57), 1),
    ('leaves_oak', (0, 124, 0), 3),             # PLANT
    ('leaves_birch', (96, 160, 64), 3),
    ('leaves_dark_oak', (0, 90, 20), 3),
    ('leaves_spruce', (49, 94, 58), 3),
    ('leaves_snowy_spruce', (200, 214, 220), 3),
    ('leaves_jungle', (16, 150, 30), 3),
    ('leaves_acacia', (120, 128, 40), 3),
    ('leaves_swamp', (70, 100, 40), 3),
    ('water', (64, 64, 255), 0),                # WATER
    ('ice', (160, 160, 255), 1),                # ICE
    ('snow', (255, 255, 255), 1),               # SNOW
    ('sand', (247, 233, 163), 1),               # SAND
    ('path', (151, 109, 77), 1),                # DIRT
    ('gravel', (153, 153, 153), 1),             # LIGHT_GRAY: gravel and town paving
    ('mud', (87, 92, 92), 1),                   # TERRACOTTA_CYAN
    ('podzol', (129, 86, 49), 1),               # PODZOL
    ('clay', (164, 168, 184), 1),               # CLAY
    ('stone', (112, 112, 112), 2),              # STONE
    ('brown_rock', (135, 107, 98), 2),          # TERRACOTTA_LIGHT_GRAY: FireRed's brown cliffs
    ('wood', (143, 119, 72), 2),                # WOOD
    ('roof_red', (153, 51, 51), 2),             # COLOR_RED
    ('roof_blue', (51, 76, 178), 2),            # COLOR_BLUE
    ('roof_light_blue', (102, 153, 216), 2),    # COLOR_LIGHT_BLUE
    ('roof_green', (102, 127, 51), 2),          # COLOR_GREEN
    ('roof_orange', (216, 127, 51), 2),         # COLOR_ORANGE
    ('roof_yellow', (229, 229, 51), 2),         # COLOR_YELLOW
    ('roof_purple', (127, 63, 178), 2),         # COLOR_PURPLE
    ('roof_pink', (242, 127, 165), 2),          # COLOR_PINK
    ('wall_white', (255, 252, 245), 2),         # QUARTZ
    ('wall_grey', (76, 76, 76), 2),             # COLOR_GRAY
    ('wall_light_grey', (153, 153, 153), 2),    # COLOR_LIGHT_GRAY
    ('brick', (159, 82, 36), 2),                # TERRACOTTA_ORANGE
    ('lime', (127, 204, 25), 2),                # COLOR_LIGHT_GREEN (melons)
    ('plant', (0, 124, 0), 2),                  # PLANT (cactus, sugar cane, lily pads)
    ('nether', (112, 2, 0), 1),                 # NETHER
    ('soul', (102, 76, 51), 1),                 # COLOR_BROWN
    ('lava', (255, 0, 0), 1),                   # FIRE
    ('obsidian', (25, 25, 25), 2),              # COLOR_BLACK
    ('end_stone', (219, 222, 158), 1),          # SAND-like
    ('glowstone', (250, 238, 77), 2),           # GOLD
    ('void', (0, 0, 0), 0),
    ('nether_floor', (142, 60, 46), 1),         # TERRACOTTA_RED: the Nether's own floor tiles (appended: ids above stay)
]
CID = {name: k for k, (name, _, _) in enumerate(CLASSES)}
assert len(CLASSES) <= 62
SHADES = [180, 220, 255, 135]          # Minecraft's LOW, NORMAL, HIGH, LOWEST (palette index = class * 4 + shade)
FOG = ['#2a2318', '#30281b']           # unexplored: a 1-pixel checker (dark sepia, ink on parchment)
PENDING = '#4a3f2c'                    # explored, its chunk not generated this session and no coarse colour
TALL = 0x80

TINTS = ['temperate', 'cool', 'dry', 'lush', 'swamp']
LEAVES_OF_TINT = {'temperate': 'leaves_oak', 'cool': 'leaves_spruce', 'dry': 'leaves_acacia', 'lush': 'leaves_jungle', 'swamp': 'leaves_swamp'}
LEAVES_OF_SPECIES = {'oak': 'leaves_oak', 'round_oak': 'leaves_oak', 'birch': 'leaves_birch', 'dark_oak': 'leaves_dark_oak', 'spruce': 'leaves_spruce',
                     'snowy_spruce': 'leaves_snowy_spruce', 'acacia': 'leaves_acacia', 'jungle': 'leaves_jungle', 'swamp_oak': 'leaves_swamp'}
ROOFS = ['roof_red', 'roof_blue', 'roof_light_blue', 'roof_green', 'roof_orange', 'roof_yellow', 'roof_purple', 'roof_pink', 'wall_white', 'wall_grey']
SATURATED = ['roof_red', 'roof_blue', 'roof_light_blue', 'roof_green', 'roof_orange', 'roof_yellow', 'roof_purple', 'roof_pink', 'brick']

# materials that map straight to a class
DIRECT = {
    'water': 'water', 'water_rock': 'water', 'ice': 'ice', 'snow': 'snow', 'sand': 'sand', 'mud': 'mud', 'podzol': 'podzol', 'clay': 'clay',
    'stone': 'stone', 'stone_bricks': 'stone', 'cracked_stone_bricks': 'stone', 'mossy_stone_bricks': 'stone', 'chiseled_stone_bricks': 'stone',
    'infested_stone_bricks': 'stone', 'infested_mossy_stone_bricks': 'stone', 'infested_cracked_stone_bricks': 'stone',
    'infested_chiseled_stone_bricks': 'stone', 'stronghold_stairs': 'stone', 'fountain_pillar': 'stone', 'wall_torch': 'stone', 'boulder': 'stone',
    'bedrock': 'stone', 'bedrock_floor': 'stone', 'coal_ore': 'stone', 'iron_ore': 'stone', 'gold_ore': 'stone', 'lapis_ore': 'stone',
    'redstone_ore': 'stone', 'diamond_ore': 'stone', 'emerald_ore': 'stone', 'copper_ore': 'stone',
    'netherrack': 'nether', 'nether_bricks': 'nether', 'nether_brick_fence': 'nether', 'magma_block': 'nether', 'nether_quartz_ore': 'nether',
    'nether_gold_ore': 'nether', 'ancient_debris': 'nether', 'soul_soil': 'soul', 'soul_sand': 'soul', 'lava': 'lava',
    'obsidian': 'obsidian', 'obsidian_floor': 'obsidian', 'end_pillar': 'obsidian', 'end_stone': 'end_stone', 'glowstone': 'glowstone',
    'void': 'void', 'nether_portal': 'roof_purple', 'bone_block': 'sand',
    'fence_birch': 'wood', 'fence_oak': 'wood', 'sign': 'wood', 'door': 'wood', 'doorway': 'wood', 'bookshelf': 'wood', 'oak_planks': 'wood',
    'cactus': 'plant', 'sugar_cane': 'plant', 'lily_pad': 'plant', 'dead_bush': 'wood', 'pumpkin': 'roof_orange', 'melon': 'lime',
    'sandstone': 'sand',
}
# the material-only fallback (a mapcolor.json that does not match the loaded tables)
FALLBACK = dict(DIRECT, floor='grass_temperate', tree='leaves_oak', leaves='leaves_oak', bush='leaves_oak', tallgrass='grass_temperate',
                flower='grass_temperate', ledge='grass_temperate', rock='brown_rock', bricks='brick', glass='wall_white')
for m in ['white_concrete', 'light_gray_concrete', 'yellow_concrete', 'purple_concrete', 'light_blue_concrete', 'lime_concrete', 'orange_concrete',
          'blue_concrete', 'green_concrete', 'pink_concrete']:
    FALLBACK[m] = {'white': 'wall_white', 'light_gray': 'wall_light_grey', 'yellow': 'roof_yellow', 'purple': 'roof_purple', 'light_blue': 'roof_light_blue',
                   'lime': 'roof_green', 'orange': 'roof_orange', 'blue': 'roof_blue', 'green': 'roof_green', 'pink': 'roof_pink'}[m[:-9]]

# the coarse plan's biome keys (src/gen/biomes.js) to classes; 255 sea, 254 rock, 253 fresh water
COARSE_OF_BIOME = {
    'NONE': 'none', 'PLAINS': 'grass_temperate', 'FOREST': 'leaves_oak', 'BIRCH_FOREST': 'leaves_birch', 'DARK_FOREST': 'leaves_dark_oak',
    'TAIGA': 'leaves_spruce', 'SNOWY_TAIGA': 'leaves_snowy_spruce', 'SNOWY_PLAINS': 'snow', 'DESERT': 'sand', 'SAVANNA': 'grass_dry',
    'SWAMP': 'grass_swamp', 'JUNGLE': 'leaves_jungle', 'BEACH': 'sand', 'SNOWY_BEACH': 'snow', 'STONY_SHORE': 'stone', 'OCEAN': 'water',
    'FROZEN_OCEAN': 'ice', 'DEEP_OCEAN': 'water', 'RIVER': 'water', 'LAKE': 'water', 'STONY_HILLS': 'stone', 'MOUNTAINS': 'stone',
    'SNOWY_MOUNTAINS': 'snow', 'KANTO': 'grass_temperate',
}
# water depth by biome map: the shade index (0 LOW, 1 NORMAL, 3 LOWEST); Kanto's own water (non-generated maps) is LOW
DEPTH_OF_BIOME = {'DEEP_OCEAN': 3, 'OCEAN': 0, 'FROZEN_OCEAN': 0, 'RIVER': 1, 'LAKE': 1}


def hsv(rgb):
    h, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in rgb])
    return h * 360, s, v


def nearest(rgb, names):
    best, bd = None, 1e18
    for n in names:
        c = CLASSES[CID[n]][1]
        d = sum((a - b) ** 2 for a, b in zip(rgb, c))
        if d < bd:
            bd, best = d, n
    return best


def building_class(rgb, extra=()):
    """A roof, wall or window by its average colour: greys by lightness, colours by hue (an RGB distance would turn
    FireRed's light grey walls pink)."""
    h, s, v = hsv(rgb)
    if s < 0.16:
        return 'wall_white' if v > 0.82 else 'wall_light_grey' if v > 0.5 else 'wall_grey'
    best, bd = None, 1e9
    for n in SATURATED + list(extra):
        ch, cs, cv = hsv(CLASSES[CID[n]][1])
        dh = abs(h - ch)
        dh = min(dh, 360 - dh) / 180
        d = dh * 2 + abs(v - cv) * 0.6 + abs(s - cs) * 0.3
        if d < bd:
            bd, best = d, n
    return best


def ground_class(rgb, tint):
    """A floor, ledge or quarter-blend piece by its average colour: grass (by its tint), path, sand, paving, stone..."""
    h, s, v = hsv(rgb)
    if s < 0.13:
        if v > 0.93:
            return 'snow'
        return 'gravel' if v > 0.45 else 'stone'
    if 68 <= h <= 185 and s >= 0.16:
        return 'grass_' + (tint or 'temperate')
    if 185 < h <= 260:
        return 'ice'
    if 35 <= h < 68:
        return 'path' if v > 0.45 else 'mud'
    # reds and browns: dirt, wood floors
    return 'path' if v > 0.35 else 'podzol'


def rock_class(rgb):
    h, s, v = hsv(rgb)
    if s < 0.12:
        return 'snow' if v > 0.88 else 'stone'
    if 38 <= h < 70 and v > 0.6:
        return 'sand'
    if 185 < h <= 260:
        return 'snow' if v > 0.75 else 'stone'
    return 'brown_rock'


def entry_rgb(below, above, k, overlay):
    """The average colour of an entry as seen from above (its top layer over it); an overlay's object pixels only."""
    cols = below.shape[1] // 16
    x, y = (k % cols) * 16, (k // cols) * 16
    b = below[y:y + 16, x:x + 16].astype(float)
    t = above[y:y + 16, x:x + 16].astype(float)
    a = t[..., 3:4] / 255
    rgb = b[..., :3] * (1 - a) + t[..., :3] * a
    alpha = np.maximum(b[..., 3], t[..., 3])
    if overlay:
        m = alpha > 160
        if m.sum() >= 8:
            return tuple(rgb[m].mean(0))
    m = alpha > 0
    if m.sum() == 0:
        return (0, 0, 0)
    return tuple(rgb[m].mean(0))


def classify(entry, rgb, var=None, species_of_var=None):
    mat = entry[4]
    kind = var['kind'] if var else None
    tint = var.get('tint') if var and kind in ('tint', 'band', 'rock') else None
    if tint not in TINTS:
        tint = None
    if mat in DIRECT:
        return CID[DIRECT[mat]]
    if mat in ('tree', 'leaves', 'bush'):
        if species_of_var and var and var['id'] in species_of_var:
            return CID[LEAVES_OF_SPECIES.get(species_of_var[var['id']], 'leaves_oak')]
        return CID[LEAVES_OF_TINT[tint or 'temperate']]
    if mat in ('tallgrass', 'flower'):
        return CID['grass_' + (tint or 'temperate')] | (TALL if mat == 'tallgrass' else 0)
    if mat in ('floor', 'ledge'):
        if var and kind == 'ground':
            return CID[{'ground_mud': 'mud', 'ground_podzol': 'podzol', 'ground_clay': 'clay'}.get(var['name'], 'path')]
        c = ground_class(rgb, tint)
        if var and kind == 'quarter' and var['name'] in ('P_swamp',) and c.startswith('grass'):
            c = 'grass_swamp'
        return CID[c]
    if mat == 'rock':
        return CID[rock_class(rgb)]
    if mat.endswith('_concrete') or mat in ('glass',):
        return CID[building_class(rgb)]
    if mat == 'bricks':
        return CID[building_class(rgb, ('wood', 'sand'))]
    return CID[FALLBACK.get(mat, 'stone')] if mat in FALLBACK else CID['stone']


def block_classes(items):
    """Placed blocks' classes by id (glass, torches, saplings, flowers and other see-through ones: none, the ground shows)."""
    out = {}
    for k, v in items['items'].items():
        if not v.get('block'):
            continue
        c = None
        if any(s in k for s in ('glass', 'torch', 'sapling', 'poppy', 'dandelion', 'wither_rose', 'cobweb', 'iron_bars', 'skull', 'soul_fire')):
            c = None
        elif k in ('cactus', 'sugar_cane', 'lily_pad', 'oak_leaves'):
            c = 'plant' if k != 'oak_leaves' else 'leaves_oak'
        elif k == 'dead_bush':
            c = 'wood'
        elif k in ('pumpkin', 'jack_o_lantern'):
            c = 'roof_orange'
        elif k == 'melon' or k == 'emerald_block':
            c = 'lime'
        elif k == 'hay_block' or k == 'gold_block' or k == 'glowstone' or k == 'bell':
            c = 'roof_yellow' if k == 'hay_block' else 'glowstone'
        elif k.endswith('_concrete'):
            c = FALLBACK[k]
        elif k in ('white_wool', 'white_bed', 'iron_block', 'bone_block', 'beacon'):
            c = 'wall_white'
        elif k in ('diamond_block',):
            c = 'roof_light_blue'
        elif k in ('lapis_block',):
            c = 'roof_blue'
        elif k in ('redstone_block', 'tnt'):
            c = 'roof_red'
        elif k in ('copper_block', 'bricks'):
            c = 'brick'
        elif k in ('coal_block', 'obsidian', 'netherite_block', 'end_portal', 'dragon_egg', 'ancient_debris'):
            c = 'obsidian'
        elif k in ('sand', 'sandstone'):
            c = 'sand'
        elif k == 'dirt':
            c = 'path'
        elif k == 'clay':
            c = 'clay'
        elif k == 'snow_block':
            c = 'snow'
        elif k == 'ice':
            c = 'ice'
        elif k in ('netherrack', 'nether_bricks', 'nether_quartz_ore', 'nether_gold_ore', 'magma_block'):
            c = 'nether'
        elif k in ('soul_sand', 'soul_soil'):
            c = 'soul'
        elif k == 'lava':
            c = 'lava'
        elif k == 'nether_portal':
            c = 'roof_purple'
        elif k.startswith('end_stone') or k == 'end_portal_frame':
            c = 'end_stone'
        elif any(s in k for s in ('log', 'planks', 'door', 'chest', 'table', 'fence', 'barrel', 'bookshelf', 'sign', 'campfire', 'composter',
                                  'lectern', 'loom')):
            c = 'wood'
        elif any(s in k for s in ('stone', 'cobble', 'furnace', 'smoker', 'grindstone', 'cauldron', 'brewing', 'spawner', 'bedrock')):
            c = 'stone'
        else:
            c = 'stone'
        if c:
            out[k] = CID[c]
    # blocks only ever placed flush (sunk into the ground, drawn flat): a dug path, farmland
    out['dirt_path'] = CID['path']
    out['farmland'] = CID['path']
    return out


def coarse_table():
    """Coarse code (a biome id, 253 fresh water, 254 rock, 255 sea) to class, from src/gen/biomes.js read as text."""
    src = (ROOT / 'src' / 'gen' / 'biomes.js').read_text()
    rows = re.findall(r"\[(\d+), '([A-Z_]+)'", src)
    t = [0] * 256
    keys = {}
    for i, key in rows:
        i = int(i)
        keys[i] = key
        t[i] = CID[COARSE_OF_BIOME.get(key, 'grass_temperate')]
    t[253] = CID['water']; t[254] = CID['stone']; t[255] = CID['water']
    return t, keys


def skins():
    """Each co-op skin's shirt colour (the commonest opaque colour of frame 0's chest), Steve's from his own sheet."""
    out = {}
    items = json.loads((MC / 'items.json').read_text())
    order = (items.get('skins') or {}).get('order') or ['steve']
    for name in order:
        f = MC / 'steve.png' if name == 'steve' else MC / 'skins' / f'{name}.png'
        if not f.exists():
            continue
        im = np.array(Image.open(f).convert('RGBA'))
        # the shirt: the commonest colour of frame 0's torso and sleeves (rows 21 to 24), leaving out the outline and
        # every colour of the face (rows 16 to 19: skin, eyes)
        face = {tuple(p[:3]) for row in im[16:20, 5:19] for p in row if p[3] > 200}
        px = [tuple(p[:3]) for row in im[21:25, 5:19] for p in row if p[3] > 200 and tuple(p[:3]) not in face and tuple(p[:3]) != (0x18, 0x14, 0x1c)]
        if not px:
            continue
        best = max(sorted(set(px)), key=px.count)
        out[name] = '#%02x%02x%02x' % best
    return out


def b64(arr):
    return base64.b64encode(bytes(arr)).decode()


# ---------------------------------------------------------------- icons
ICONS = ['player_up', 'player_right', 'player_down', 'player_left', 'white_banner', 'red_banner', 'target_point', 'plains_village',
         'desert_village', 'savanna_village', 'taiga_village', 'snowy_village', 'off_map',
         'arrow_0', 'arrow_1', 'arrow_2', 'arrow_3', 'arrow_4', 'arrow_5', 'arrow_6', 'arrow_7', 'button']
RED, INK = (216, 58, 58, 255), (0, 0, 0, 255)


ARROW_N = ['...K...', '..KRK..', '.KRRRK.', 'KRRRRRK', 'KKKRKKK', '..KRK..', '..KKK..']
ARROW_NE = ['.KKKKKK', '.KRRRRK', '.KKRRRK', 'KKRRKRK', 'KRRKKRK', 'KRKK.KK', 'KKK....']


def arrow_glyph(diag):
    """A 7 x 7 Kanto edge arrow in an 8 x 8 cell, red with a black rim (red_marker.png's style): north or north-east."""
    im = Image.new('RGBA', (8, 8), (0, 0, 0, 0))
    for y, row in enumerate(ARROW_NE if diag else ARROW_N):
        for x, ch in enumerate(row):
            if ch != '.':
                im.putpixel((x, y), RED if ch == 'R' else INK)
    return im


def rot(im, quarter_turns_cw):
    """Rotate a 7 x 7 glyph (in its 8 x 8 cell) by quarter turns clockwise about its centre."""
    g = im.crop((0, 0, 7, 7))
    for _ in range(quarter_turns_cw):
        g = g.transpose(Image.Transpose.ROTATE_270)
    out = Image.new('RGBA', (8, 8), (0, 0, 0, 0))
    out.paste(g, (0, 0))
    return out


def build_icons():
    dec = VEND / 'decorations'
    load = lambda n: Image.open(dec / f'{n}.png').convert('RGBA')
    player = load('player')
    strip = Image.new('RGBA', (8 * len(ICONS), 8), (0, 0, 0, 0))
    cells = {
        'player_up': player, 'player_right': player.transpose(Image.Transpose.ROTATE_270), 'player_down': player.transpose(Image.Transpose.ROTATE_180),
        'player_left': player.transpose(Image.Transpose.ROTATE_90), 'white_banner': load('white_banner'), 'red_banner': load('red_banner'),
        'target_point': load('target_point'), 'off_map': load('player_off_map'), 'button': player,
    }
    for v in ('plains', 'desert', 'savanna', 'taiga', 'snowy'):
        cells[v + '_village'] = load(v + '_village')
    n, ne = arrow_glyph(False), arrow_glyph(True)
    for d in range(8):
        cells[f'arrow_{d}'] = rot(n if d % 2 == 0 else ne, d // 2)
    for k, name in enumerate(ICONS):
        strip.paste(cells[name], (k * 8, 0))
    return strip


# ---------------------------------------------------------------- review
def review(out, data, pal_rgb, wj, entries_cls):
    out.mkdir(parents=True, exist_ok=True)
    W, H = wj['w'], wj['h']
    grid = np.fromfile(WORLD / 'grid.bin', dtype='<u2').reshape(H, W)
    zone = np.fromfile(WORLD / 'zone.bin', dtype='u1').reshape(H, W)
    cls = np.array(entries_cls, dtype=np.uint8)
    c = cls[grid] & 0x7F
    tall = (cls[grid] & TALL) != 0
    hgt = np.array([h for (_, _, h) in CLASSES], dtype=np.int8)[c]
    north = np.vstack([hgt[:1], hgt[:-1]])
    shade = np.where(hgt > north, 2, np.where(hgt < north, 0, 1))
    shade[tall] = 0
    shade[c == CID['water']] = 0
    img = pal_rgb[c * 4 + shade]
    img[zone >= 2] = (42, 35, 24)
    Image.fromarray(img.astype(np.uint8)).resize((W * 2, H * 2), Image.NEAREST).save(out / 'classic_all.png')
    o = wj['outdoor']
    Image.fromarray(img[:o['h'], :o['w']].astype(np.uint8)).resize((o['w'] * 3, o['h'] * 3), Image.NEAREST).save(out / 'classic_outdoor.png')
    icons = Image.open(MC / 'map' / 'icons.png')
    icons.resize((icons.width * 8, icons.height * 8), Image.NEAREST).save(out / 'icons_8x.png')
    sw = Image.new('RGB', (len(CLASSES) * 40, 4 * 40 + 14), (40, 40, 40))
    d = ImageDraw.Draw(sw)
    for k in range(len(CLASSES)):
        for s in range(4):
            d.rectangle([k * 40, s * 40, k * 40 + 39, s * 40 + 39], fill=tuple(int(v) for v in pal_rgb[k * 4 + s]))
        d.text((k * 40 + 2, 4 * 40 + 1), str(k), fill=(255, 255, 255))
    sw.save(out / 'classes.png')
    print('review written to', out)


def main():
    args = sys.argv[1:]
    rev = Path(args[args.index('--review') + 1]) if '--review' in args else None
    wj = json.loads((WORLD / 'world.json').read_text())
    tj = json.loads((WORLD / 'terrain.json').read_text())
    items = json.loads((MC / 'items.json').read_text())
    a_b = np.array(Image.open(WORLD / 'atlas.png').convert('RGBA'))
    a_t = np.array(Image.open(WORLD / 'atlas_top.png').convert('RGBA'))
    g_b = np.array(Image.open(WORLD / 'atlas_gen.png').convert('RGBA'))
    g_t = np.array(Image.open(WORLD / 'atlas_gen_top.png').convert('RGBA'))
    variants = {v['id']: v for v in tj.get('variants', [])}
    species_of_var = {s['var']: name for name, s in tj.get('species', {}).items() if s.get('var')}

    classic = [classify(e, entry_rgb(a_b, a_t, k, False)) for k, e in enumerate(wj['entries'])]
    # the Nether's floor tiles (material 'floor': netherrack ground and nether brick paving, a dull red in the game)
    # came out podzol brown by colour; Minecraft's maps show the Nether red, so they take TERRACOTTA_RED, a lighter red
    # than its NETHER walls (the walls stay apart from the floor); soul sand and soul soil keep their brown
    for k, v in (wj.get('nether') or {}).get('tiles', {}).items():
        if v[0] == 'floor' and wj['entries'][int(k)][4] == 'floor':
            classic[int(k)] = CID['nether_floor']
    gen = []
    for k, e in enumerate(tj['entries']):
        var = variants.get(e[9]) if len(e) > 9 and e[9] else None
        ov = len(e) > 10 and bool(e[10])
        gen.append(classify(e, entry_rgb(g_b, g_t, k, ov), var, species_of_var))
    coarse, bkeys = coarse_table()
    depth = {'GEN_' + key: DEPTH_OF_BIOME[key] for key in bkeys.values() if key in DEPTH_OF_BIOME}
    data = {
        'v': 1,
        'shades': SHADES,
        'classes': [[n, list(rgb), h] for (n, rgb, h) in CLASSES],
        'tall': TALL,
        'classic': {'n': len(classic), 'b64': b64(classic)},
        'gen': {'n': len(gen), 'base': tj['genBase'], 'atlasHash': tj.get('atlasHash'), 'b64': b64(gen)},
        'mat': {m: CID[c] for m, c in sorted(FALLBACK.items())},
        'blocks': block_classes(items),
        'coarse': b64(coarse),
        'depth': depth,
        'kantoDepth': 0,
        'fog': FOG, 'pending': PENDING, 'border': '#5fd3ff',
        'skins': skins(),
        'icons': {name: k for k, name in enumerate(ICONS)},
    }
    (WORLD / 'mapcolor.json').write_text(json.dumps(data, separators=(',', ':')))
    (MC / 'map').mkdir(parents=True, exist_ok=True)
    shutil.copyfile(VEND / 'map_background.png', MC / 'map' / 'background.png')
    build_icons().save(MC / 'map' / 'icons.png')
    hist = {}
    for c in classic + gen:
        n = CLASSES[c & 0x7F][0]
        hist[n] = hist.get(n, 0) + 1
    print('mapcolor.json:', len(classic), 'classic and', len(gen), 'generated entries;', len(CLASSES) - 1, 'classes')
    print('classes used:', ', '.join(f'{k} {v}' for k, v in sorted(hist.items(), key=lambda kv: -kv[1])))
    if rev:
        pal = np.zeros((256, 3))
        for k, (_, rgb, _) in enumerate(CLASSES):
            for s, f in enumerate(SHADES):
                pal[k * 4 + s] = [int(c * f / 255) for c in rgb]
        review(rev, data, pal, wj, classic)


if __name__ == '__main__':
    main()
