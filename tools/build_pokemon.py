#!/usr/bin/env python3
"""The Pokémon half of Redstone, built from the pret decomps (adapted from Sky Anywhere).

Outputs:
  assets/battle/   FireRed battle terrains, textbox layouts, healthboxes, status icons, balls, shadow
  assets/mon/      front/back battle sprites (normal + shiny) and party icons per species
  assets/sprites/  overworld (follower-style) sprites for every species
  assets/cries/    each species' cry as a small wav
  assets/ui/       fonts, window frame, party menu pieces
  assets/data/     pokemon.json: species, moves, type chart, experience tables, wild encounter tables
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fr as B  # noqa: E402
import extract_data as X  # noqa: E402
import build_ender_dragon as ED  # noqa: E402
import build_wither_mon as WM  # noqa: E402

FR, EX, OUT = B.FR, B.EX, B.OUT

# Every species the game can show: everything FireRed puts in the grass, the water, the rocks and on
# the end of a fishing rod on the maps Steve can walk (outdoors, caves, the forest and the Pokemon
# Tower, all from world.json), plus the Kanto starters for flavour.
WORLD = json.load(open(Path(__file__).resolve().parent.parent / 'assets' / 'world' / 'world.json'))
OUTDOOR = {m['id'] for m in WORLD['maps']}


def wild_tables():
    d = json.load(open(FR / 'src/data/wild_encounters.json'))['wild_encounter_groups'][0]
    fields = {f['type']: f for f in d['fields']}
    out = {}
    for e in d['encounters']:
        if e['map'] not in OUTDOOR or not e['base_label'].endswith('_FireRed'):
            continue
        t = {}
        for kind in ('land_mons', 'water_mons', 'fishing_mons', 'rock_smash_mons'):   # rock_smash -> 'rock'
            if kind in e:
                v = e[kind]
                t[kind.split('_')[0]] = {'rate': v['encounter_rate'], 'slots': fields[kind]['encounter_rates'],
                                          'mons': [[m['species'].replace('SPECIES_', ''), m['min_level'], m['max_level']] for m in v['mons']]}
                if kind == 'fishing_mons':
                    t['fishing']['groups'] = fields[kind]['groups']
        out[e['map']] = t
    return out


WILD = wild_tables()
PARTY = ['BULBASAUR', 'CHARMANDER', 'SQUIRTLE', 'PIKACHU']
ROSTER = list(dict.fromkeys(PARTY + sorted({m[0] for t in WILD.values() for k in t.values() for m in k['mons']})))

# The Nether (tools/build_nether.py) has no FireRed table, so it gets its own: fire types at levels 30 to 45,
# Arcanine and Ninetales rare at 1% each. Visible wild POKeMON and the step encounters on its floors both
# draw from it. 'lava' lists the species that keep near lava, 'packs' the ones that hunt in packs.
NETHER_WILD = {'land': {
    'rate': 10,
    'slots': [12, 11, 11, 9, 8, 8, 8, 7, 6, 5, 5, 4, 4, 1, 1],
    'mons': [['NUMEL', 30, 36], ['SLUGMA', 30, 36], ['HOUNDOUR', 30, 36], ['PONYTA', 30, 36], ['VULPIX', 30, 35],
             ['GROWLITHE', 30, 35], ['TORKOAL', 32, 38], ['MAGMAR', 34, 40], ['CHARMELEON', 32, 38], ['CAMERUPT', 38, 45],
             ['MAGCARGO', 38, 45], ['HOUNDOOM', 40, 45], ['RAPIDASH', 40, 45], ['ARCANINE', 42, 45], ['NINETALES', 42, 45]],
    'lava': ['SLUGMA', 'MAGCARGO'], 'packs': ['HOUNDOUR', 'HOUNDOOM'],
}}
WILD['MAP_NETHER'] = NETHER_WILD
# after every species Kanto already had, so the older entries keep their order
NETHER_FIRST = next(m[0] for m in NETHER_WILD['land']['mons'] if m[0] not in ROSTER)
ROSTER = list(dict.fromkeys(ROSTER + [m[0] for m in NETHER_WILD['land']['mons']]))

# Move effects the battle engine implements. Anything else is left out of generated movesets.
SUPPORTED_EFFECTS = {
    'HIT', 'GUST', 'QUICK_ATTACK', 'ALWAYS_HIT', 'HIGH_CRITICAL', 'FLINCH_HIT', 'FLINCH_MINIMIZE_HIT',
    'PARALYZE_HIT', 'BURN_HIT', 'FREEZE_HIT', 'POISON_HIT', 'POISON_FANG', 'CONFUSE_HIT', 'TWINEEDLE',
    'MULTI_HIT', 'DOUBLE_HIT', 'RECOIL', 'DOUBLE_EDGE', 'ABSORB', 'LEVEL_DAMAGE', 'SONICBOOM',
    'DRAGON_RAGE', 'PURSUIT', 'FURY_CUTTER', 'KNOCK_OFF', 'RAGE', 'THIEF', 'SPEED_DOWN_HIT',
    'DEFENSE_DOWN_HIT', 'ATTACK_DOWN_HIT', 'SPECIAL_DEFENSE_DOWN_HIT', 'SPECIAL_ATTACK_DOWN_HIT',
    'ACCURACY_DOWN_HIT', 'DEFENSE_UP_HIT', 'ATTACK_UP_HIT', 'ALL_STATS_UP_HIT', 'TRI_ATTACK',
    'EXPLOSION', 'RECHARGE', 'TRAP', 'SEMI_INVULNERABLE', 'THUNDER', 'SLEEP', 'PARALYZE', 'POISON',
    'TOXIC', 'CONFUSE', 'ATTACK_UP', 'ATTACK_UP_2', 'DEFENSE_UP', 'DEFENSE_UP_2', 'SPEED_UP',
    'SPEED_UP_2', 'SPECIAL_ATTACK_UP', 'SPECIAL_ATTACK_UP_2', 'SPECIAL_DEFENSE_UP',
    'SPECIAL_DEFENSE_UP_2', 'EVASION_UP', 'ATTACK_DOWN', 'ATTACK_DOWN_2', 'DEFENSE_DOWN',
    'DEFENSE_DOWN_2', 'SPEED_DOWN', 'SPEED_DOWN_2', 'SPECIAL_DEFENSE_DOWN_2', 'ACCURACY_DOWN',
    'EVASION_DOWN', 'DRAGON_DANCE', 'FOCUS_ENERGY', 'HAZE', 'PROTECT', 'REFLECT', 'MIST', 'SPLASH',
}


def pal(path):
    return B.read_pal(path)


def save(img, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)


def tilemap(bin_path, tiles_png, pal_list, cols=32, base=0, rows=None):
    """GBA text BG tilemap -> RGBA. pal_list holds consecutive 16-colour banks starting at `base`."""
    idx = B.load_indexed(tiles_png)
    h, w = idx.shape
    tiles = idx.reshape(h // 8, 8, w // 8, 8).transpose(0, 2, 1, 3).reshape(-1, 8, 8)
    ents = np.fromfile(bin_path, dtype='<u2')
    rows = rows or len(ents) // cols
    out = np.zeros((rows * 8, cols * 8, 4), dtype=np.uint8)
    for i, e in enumerate(ents[:cols * rows]):
        e = int(e)
        t, hf, vf, p = e & 0x3FF, (e >> 10) & 1, (e >> 11) & 1, (e >> 12) & 0xF
        if t >= len(tiles):
            continue
        tile = tiles[t]
        if hf: tile = tile[:, ::-1]
        if vf: tile = tile[::-1, :]
        o = max(0, p - base) * 16
        lut = np.array((pal_list[o:o + 16] + [(0, 0, 0)] * 16)[:16], dtype=np.uint8)
        alpha = (tile != 0).astype(np.uint8) * 255
        x, y = (i % cols) * 8, (i // cols) * 8
        out[y:y + 8, x:x + 8] = np.dstack([lut[tile], alpha])
    return out


def oam_sprite(idx_img, first_tile, w_tiles, h_tiles, sheet_cols):
    """Assemble one 1D-mapped OAM sprite from a tile sheet (tiles numbered row-major)."""
    out = np.zeros((h_tiles * 8, w_tiles * 8), dtype=np.uint8)
    for ty in range(h_tiles):
        for tx in range(w_tiles):
            t = first_tile + ty * w_tiles + tx
            sx, sy = (t % sheet_cols) * 8, (t // sheet_cols) * 8
            out[ty * 8:ty * 8 + 8, tx * 8:tx * 8 + 8] = idx_img[sy:sy + 8, sx:sx + 8]
    return out


def rgba_from_indexed(idx, colors, transparent0=True):
    lut = np.array((list(colors) + [(0, 0, 0)] * 16)[:max(16, len(colors))], dtype=np.uint8)
    rgb = lut[idx]
    a = np.where((idx == 0) & transparent0, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, a]), 'RGBA')


# ---------------------------------------------------------------- battle scene
def build_battle():
    d = OUT / 'battle'
    # FireRed's battle terrains (src/battle_bg.c): grass for tall grass, long grass, sand, water, pond,
    # mountain, cave, building (the plain terrain for town floors).
    for t in ('grass', 'longgrass', 'sand', 'water', 'pond', 'mountain', 'cave', 'building'):
        src = FR / 'graphics/battle_terrain' / t
        p = B.read_pal(src / 'terrain.pal')
        base = tilemap(src / 'terrain.bin', src / 'terrain.png', p, base=2)
        bg = np.zeros((160, 240, 4), np.uint8); bg[:, :, :3] = p[0]; bg[:, :, 3] = 255
        B.blit(bg, base[:160, :240], 0, 0)
        save(Image.fromarray(bg, 'RGBA'), d / f'bg_{t}.png')
    build_nether_bg(d)
    # FireRed's battle textbox: three layouts stacked in one tilemap (message, action menu, move menu).
    tb = FR / 'graphics/battle_interface'
    tpal = pal(tb / 'textbox1.pal') + pal(tb / 'textbox2.pal')
    tm = tilemap(tb / 'textbox.bin', tb / 'textbox.png', tpal, base=0)
    for name, row in (('textbox_msg', 14), ('textbox_action', 34), ('textbox_moves', 54)):
        save(Image.fromarray(tm[row * 8:row * 8 + 48, :240], 'RGBA'), d / f'{name}.png')

    # Healthboxes are two 64x32 OAM sprites each; sheets are 16 tiles wide.
    hp = pal(tb / 'healthbox.pal')
    # Singles: the player's box is two 64x64 sprites (second one 64 tiles on), the opponent's two
    # 64x32 sprites (second one 32 tiles on); the second sprite sits 64px to the right.
    for name, h_tiles in (('healthbox_singles_player', 8), ('healthbox_singles_opponent', 4)):
        idx = B.load_indexed(tb / f'{name}.png')
        cols = idx.shape[1] // 8
        n = 8 * h_tiles
        both = np.hstack([oam_sprite(idx, 0, 8, h_tiles, cols), oam_sprite(idx, n, 8, h_tiles, cols)])
        save(rgba_from_indexed(both, hp), d / f'{name}.png')
    bar = B.read_pal(tb / 'healthbar.pal')
    json.dump({'box': [list(c) for c in hp], 'bar': [list(c) for c in bar]}, open(d / 'colors.json', 'w'))
    # HP/EXP bar tiles from gBattleInterface_Gfx, each an 8x8 tile in a 40-tile-wide strip. A tile takes
    # the palette of the sprite the game copies it into: the HP label, bar fills and left border go into
    # the healthbar sprite (healthbar.pal), and so does the caught-ball icon (the opponent bar's third
    # subsprite); the EXP bar and status icons go into the healthbox sprite (healthbox.pal).
    el = B.load_indexed(tb / 'healthbox_elements.png') % 16
    box_tiles = set(range(12, 21))
    strip = np.hstack([np.array(rgba_from_indexed(el[(t // 40) * 8:(t // 40) * 8 + 8, (t % 40) * 8:(t % 40) * 8 + 8], hp if t in box_tiles else bar)) for t in range(120)])
    save(Image.fromarray(strip, 'RGBA'), d / 'bar_tiles.png')
    # Healthbox status icons: bank-1 tiles (healthbox palette) whose colour 12 (player) / 13 (opponent)
    # the game fills with sStatusIconColors (src/battle_interface.c). Row 0 player, row 1 opponent;
    # columns PSN, PAR, SLP, FRZ, BRN.
    rgb555 = lambda r, g, b: (r * 255 // 31, g * 255 // 31, b * 255 // 31)
    status_cols = [rgb555(24, 12, 24), rgb555(23, 23, 3), rgb555(20, 20, 17), rgb555(17, 22, 28), rgb555(28, 14, 10)]
    raw = B.load_indexed(tb / 'healthbox_elements.png')
    icons = np.zeros((16, 120, 4), dtype=np.uint8)
    for row, (first, slot) in enumerate(((21, 12), (71, 13))):
        for k, col in enumerate(status_cols):
            p = [tuple(c) for c in hp]
            p[slot] = col
            for t in range(3):
                tile_id = first + k * 3 + t
                tile = raw[(tile_id // 40) * 8:(tile_id // 40) * 8 + 8, (tile_id % 40) * 8:(tile_id % 40) * 8 + 8] % 16
                img = np.array(rgba_from_indexed(tile, p))
                icons[row * 8:row * 8 + 8, k * 24 + t * 8:k * 24 + t * 8 + 8] = img
    save(Image.fromarray(icons, 'RGBA'), d / 'status_healthbox.png')
    # The rest of the healthbox strip: HP label, bar ends, etc. (kept whole for reference cropping)
    save(B.colorize(tb / 'enemy_mon_shadow.png', hp), d / 'enemy_shadow.png')
    # Status icons (8px tall strip): PSN, PAR, SLP, FRZ, BRN, plus FNT/PKRS.
    si = FR / 'graphics/interface/status_icons.png'
    save(B.colorize_self(si), d / 'status_icons.png')
    for ball in ('poke', 'great', 'ultra'):
        save(B.colorize_self(FR / f'graphics/interface/ball/{ball}.png'), d / f'ball_{ball}.png')
    # Level-up banner is unused; the red back pic gives the trainer for the whiteout / intro if needed.


# The Nether's battle background: FireRed's cave terrain recoloured, colour for colour, into netherrack
# reds with a lava glow along the top (the far wall) and netherrack platforms.
NETHER_BG = {
    # backdrop, top to bottom
    (213, 197, 115): (255, 158, 44), (205, 180, 106): (236, 108, 34), (189, 164, 106): (204, 74, 30),
    (180, 156, 98): (150, 44, 36), (197, 172, 106): (166, 54, 42), (172, 148, 90): (128, 36, 34),
    (164, 139, 82): (112, 30, 32), (189, 156, 106): (118, 36, 36), (156, 131, 98): (92, 24, 28),
    (180, 148, 106): (106, 30, 32), (180, 164, 106): (134, 42, 40), (197, 180, 106): (148, 50, 44),
    # the platforms
    (205, 197, 90): (176, 70, 58), (230, 222, 106): (220, 112, 82), (189, 180, 90): (158, 60, 50),
    (172, 156, 90): (138, 48, 42), (164, 131, 90): (86, 22, 26), (148, 123, 82): (66, 16, 20),
}


def build_nether_bg(d):
    cave = np.array(Image.open(d / 'bg_cave.png').convert('RGBA'))
    out = cave.copy()
    for src, dst in NETHER_BG.items():
        m = (cave[:, :, :3] == src).all(-1)
        out[m, :3] = dst
    save(Image.fromarray(out, 'RGBA'), d / 'bg_nether.png')


# ---------------------------------------------------------------- pokemon graphics + data
def build_mons(roster=None):
    md = OUT / 'mon'
    icon_pals = [pal(FR / f'graphics/pokemon/icon_palettes/icon_palette_{i}.pal') for i in range(3)]
    icon_idx = X.icon_palettes()
    ids = X.species_ids()
    for sp in roster or ROSTER:
        n = sp.lower()
        src = FR / 'graphics/pokemon' / n
        normal, shiny = pal(src / 'normal.pal'), pal(src / 'shiny.pal')
        for kind in ('front', 'back'):
            save(B.colorize(src / f'{kind}.png', normal), md / f'{n}_{kind}.png')
            save(B.colorize(src / f'{kind}.png', shiny), md / f'{n}_{kind}_shiny.png')
        save(B.colorize(src / 'icon.png', icon_pals[icon_idx[ids[sp]]]), md / f'{n}_icon.png')
        cry = FR / 'sound/direct_sound_samples/cries' / f'{n}.wav'
        (OUT / 'cries').mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cry, OUT / 'cries' / f'{n}.wav')


def build_overworld(fly, roster=None):
    sd = OUT / 'sprites'
    for sp in roster or ROSTER:
        n = sp.lower()
        src = EX / 'graphics/pokemon' / n
        for variant in ('normal', 'shiny'):
            img = B.colorize(src / 'overworld.png', pal(src / f'overworld_{variant}.pal'))
            save(img, sd / (f'ow_{n}.png' if variant == 'normal' else f'ow_{n}_shiny.png'))


def build_ui():
    ud = OUT / 'ui'
    # Small font (healthbox names, party menu levels and HP).
    idx = B.load_indexed(FR / 'graphics/fonts/latin_small.png')
    atlas = np.zeros(idx.shape + (4,), dtype=np.uint8)
    atlas[idx == 1] = (0, 0, 0, 255)
    atlas[idx == 2] = (255, 0, 0, 255)
    save(Image.fromarray(atlas, 'RGBA'), ud / 'font_small.png')
    src = (FR / 'src/text.c').read_text()
    import re
    arr = re.search(r'sFontSmallLatinGlyphWidths\[\] =\s*\{(.*?)\};', src, re.S).group(1)
    json.dump({'widths': [int(v) for v in re.findall(r'\d+', arr)]}, open(ud / 'font_small.json', 'w'))

    # Party menu: background, and the slot boxes pre-rendered in each palette state.
    pm = FR / 'graphics/party_menu'
    im = Image.open(pm / 'bg.png')
    raw = im.getpalette()
    P = [tuple(raw[i * 3:i * 3 + 3]) for i in range(len(raw) // 3)]
    bgidx = np.array(im, dtype=np.uint8)
    tiles = bgidx.reshape(bgidx.shape[0] // 8, 8, bgidx.shape[1] // 8, 8).transpose(0, 2, 1, 3).reshape(-1, 8, 8)
    ents = np.fromfile(pm / 'bg.bin', dtype='<u2')
    bg = np.zeros((256, 256, 4), dtype=np.uint8)
    for i, e in enumerate(ents):
        e = int(e)
        t, hf, vf, p = e & 0x3FF, (e >> 10) & 1, (e >> 11) & 1, (e >> 12) & 0xF
        tile = tiles[t % len(tiles)]
        if hf: tile = tile[:, ::-1]
        if vf: tile = tile[::-1, :]
        lut = np.array([P[min(len(P) - 1, p * 16 + c)] for c in range(16)], dtype=np.uint8)
        bg[(i // 32) * 8:(i // 32) * 8 + 8, (i % 32) * 8:(i % 32) * 8 + 8] = np.dstack([lut[tile % 16], np.full((8, 8), 255, np.uint8)])
    save(Image.fromarray(bg[:160, :240], 'RGBA'), ud / 'party_bg.png')

    # Palette ids from src/data/party_menu.h: colours 4,5,6 and 1,7,8 of the box's bank are swapped per state.
    states = {
        'normal': ((52, 53, 54), (49, 55, 56)),
        'selected': ((116, 117, 118), (97, 103, 104)),
        'fainted': ((84, 85, 86), (81, 87, 88)),
        'fainted_selected': ((148, 149, 150), (97, 103, 104)),
        'switching': ((100, 101, 102), (161, 167, 168)),
        'switch_target': ((100, 101, 102), (97, 103, 104)),
    }

    def slot(bin_name, w, h, bank, st):
        cells = np.frombuffer((pm / bin_name).read_bytes(), dtype=np.uint8)
        colors = [P[bank * 16 + c] for c in range(16)]
        ids1, ids2 = states[st]
        for off, pid in zip((4, 5, 6), ids1): colors[off] = P[pid]
        for off, pid in zip((1, 7, 8), ids2): colors[off] = P[pid]
        out = np.zeros((h * 8, w * 8, 4), dtype=np.uint8)
        lut = np.array(colors, dtype=np.uint8)
        for i, t in enumerate(cells[:w * h]):
            tile = tiles[int(t)]
            x, y = (i % w) * 8, (i // w) * 8
            out[y:y + 8, x:x + 8] = np.dstack([lut[tile % 16], np.where(tile % 16 == 0, 0, 255).astype(np.uint8)])
        return Image.fromarray(out, 'RGBA')

    for st in states:
        save(slot('slot_main.bin', 10, 7, 3, st), ud / f'party_main_{st}.png')
        save(slot('slot_wide.bin', 18, 3, 4, st), ud / f'party_wide_{st}.png')
    save(slot('slot_wide_empty.bin', 18, 3, 4, 'normal'), ud / 'party_wide_empty.png')
    # The cancel button is a regular u16 tilemap (7x2) using bank 1; selection swaps the same
    # box colours the slots use.
    def cancel(st):
        ents = np.fromfile(pm / 'cancel_button.bin', dtype='<u2')
        out = np.zeros((16, 56, 4), dtype=np.uint8)
        for i, e in enumerate(ents[:14]):
            e = int(e)
            t, hf, vf, p = e & 0x3FF, (e >> 10) & 1, (e >> 11) & 1, (e >> 12) & 0xF
            colors = [P[p * 16 + c] for c in range(16)]
            if st == 'selected':
                ids1, ids2 = states['selected']
                for off, pid in zip((4, 5, 6), ids1): colors[off] = P[pid]
                for off, pid in zip((1, 7, 8), ids2): colors[off] = P[pid]
            tile = tiles[t % len(tiles)]
            if hf: tile = tile[:, ::-1]
            if vf: tile = tile[::-1, :]
            lut = np.array(colors, dtype=np.uint8)
            x, y = (i % 7) * 8, (i // 7) * 8
            out[y:y + 8, x:x + 8] = np.dstack([lut[tile % 16], np.where(tile % 16 == 0, 0, 255).astype(np.uint8)])
        return Image.fromarray(out, 'RGBA')
    for st in ('normal', 'selected'):
        save(cancel(st), ud / f'party_cancel_{st}.png')
    save(B.colorize_self(pm / 'pokeball.png'), ud / 'party_ball.png')
    save(B.colorize_self(pm / 'pokeball_small.png'), ud / 'party_ball_small.png')
    # HP bar colours for the party boxes (green, yellow, red: fill + shade).
    json.dump({'green': [P[57], P[58]], 'yellow': [P[73], P[74]], 'red': [P[89], P[90]]}, open(ud / 'party_colors.json', 'w'))

    # FireRed's normal font and window frame (the small font is above)
    idx = B.load_indexed(FR / 'graphics/fonts/latin_normal.png')
    atlas = np.zeros(idx.shape + (4,), dtype=np.uint8)
    atlas[idx == 1] = (0, 0, 0, 255); atlas[idx == 2] = (255, 0, 0, 255)
    save(Image.fromarray(atlas, 'RGBA'), ud / 'font.png')
    arr = re.search(r'sFontNormalLatinGlyphWidths\[\] =\s*\{(.*?)\};', src, re.S).group(1)
    charmap = {}
    for line in (FR / 'charmap.txt').read_text().splitlines():
        m = re.match(r"^'(.|\\.)'\s*=\s*([0-9A-Fa-f]{2})\s*$", line)
        if m:
            ch = {"\\'": "'", '\\\\': '\\'}.get(m.group(1), m.group(1))
            charmap.setdefault(ch, int(m.group(2), 16))
    json.dump({'widths': [int(v) for v in re.findall(r'\d+', arr)], 'map': charmap}, open(ud / 'font.json', 'w'))
    save(B.colorize(FR / 'graphics/text_window/std.png', pal(FR / 'graphics/text_window/stdpal_0.pal')), ud / 'window.png')
    # overworld field effects: tall grass rustle, the exclamation mark, surf/water ripples
    fe = FR / 'graphics/field_effects'
    save(B.colorize(fe / 'pics/tall_grass.png', pal(fe / 'palettes/general_1.pal')), ud / 'fx_tall_grass.png')
    save(B.colorize(fe / 'pics/ripple.png', pal(fe / 'palettes/general_0.pal')), ud / 'fx_ripple.png')
    save(B.colorize(fe / 'pics/sand_footprints.png', pal(fe / 'palettes/general_0.pal')), ud / 'fx_footprints.png')
    # the favicon (the closed Poké Ball), the healing machine's ball and the title logo: tools/build_extras.py




def build_clouds(ud):
    """Standalone sky clouds in the weather cloud's daylight palette. FireRed's own cloud sprite is
    cut off at its edges (the game tiles it), so these are grown from overlapping puffs instead and
    shaded in the same five colours with a 2x2 ordered dither, lit from the top-left."""
    rng = np.random.default_rng(7)
    ramp = [(255, 255, 255), (246, 250, 255), (224, 236, 250), (206, 226, 248), (172, 196, 226)]
    bayer = np.array([[0, 2], [3, 1]]) / 4.0
    sizes = [(56, 30), (72, 36), (88, 42), (104, 48), (120, 54), (64, 32)]
    for n, (w, h) in enumerate(sizes):
        yy, xx = np.mgrid[0:h, 0:w]
        field = np.zeros((h, w))
        puffs = []
        k = 3 + w // 24
        base = h - 3
        rmax = (base - 1) / 1.95
        for i in range(k):
            cx = w * (0.14 + 0.72 * (i + 0.2 + rng.random() * 0.6) / k)
            middle = 0 < i < k - 1
            r = rmax * ((0.78 + 0.22 * rng.random()) if middle else (0.5 + 0.2 * rng.random()))
            r = min(r, cx - 1, w - cx - 1)
            cy = base - r * 0.95
            puffs.append((cx, cy, r))
        inside = np.zeros((h, w), dtype=bool)
        light = np.full((h, w), -1.0)
        for cx, cy, r in puffs:
            d = np.hypot(xx - cx, yy - cy)
            m = d <= r
            # light from the top-left: how far up-left the point sits on its puff
            nx, ny = (xx - cx) / r, (yy - cy) / r
            l = -(nx * 0.55 + ny * 0.85)
            light = np.where(m & (l > light), l, light)
            inside |= m
        inside &= yy <= base
        # flat, slightly shaded underside
        bottom = (yy >= base - 3) & inside
        shade = 1.0 - (light + 1) / 2  # 0 = brightest
        shade = np.where(bottom, np.maximum(shade, 0.8), shade)
        shade = np.maximum(shade, (yy / base) ** 2 * 0.9)
        level = np.clip(shade * 4.4 + bayer[yy % 2, xx % 2] * 0.9 - 0.55, 0, 4).astype(int)
        # a one-pixel lighter rim on the top edge
        top_edge = inside & ~np.roll(inside, 1, axis=0)
        level = np.where(top_edge, 0, level)
        out = np.zeros((h, w, 4), dtype=np.uint8)
        for i, c in enumerate(ramp):
            m = inside & (level == i)
            out[m] = (*c, 255)
        save(Image.fromarray(out, 'RGBA'), ud / f'sky_cloud_{n}.png')


def build_data(fly, coords, wcoords=None):
    sp_info = X.species_info(); names = X.species_names(); mv = X.moves(); ls = X.learnsets()
    front = X.pic_coords('front_pic_coordinates.h', 'gMonFrontPicCoords')
    back = X.pic_coords('back_pic_coordinates.h', 'gMonBackPicCoords')
    elev = X.elevation()
    ids = X.species_ids()
    species = {}
    used_moves = set(['FLY'])
    kanto_moves = None
    for sp in ROSTER:
        if sp == NETHER_FIRST and kanto_moves is None:
            kanto_moves = set(used_moves)
        info = sp_info[sp]
        learn = [[lv, m] for lv, m in ls[sp] if mv[m]['effect'] in SUPPORTED_EFFECTS]
        used_moves.update(m for _, m in learn)
        species[sp] = {
            'name': names[sp], **info, 'learnset': learn, 'canFly': sp in fly,
            'front': front[sp], 'back': back[sp], 'elevation': elev.get(sp, 0), 'file': sp.lower(), 'id': ids.get(sp, 0),
        }
    # Kanto's moves first in their old order, then the ones only the Nether's species bring
    kanto_moves = kanto_moves or used_moves
    moves = {k: v for k, v in mv.items() if k in kanto_moves} | {k: v for k, v in mv.items() if k in used_moves and k not in kanto_moves}
    # The End: the ENDER DRAGON (not a FireRed species: tools/build_ender_dragon.py has its numbers), last, with any
    # moves it brings from the decomp's battle move table appended after everything else
    ed = ED.SPECIES
    species['ENDER_DRAGON'] = {k: v for k, v in ed.items() if k not in ('ability',)} | {
        'front': coords['front'], 'back': coords['back'], 'file': ED.NAME}
    moves |= {k: v for k, v in mv.items() if k not in moves and any(m == k for _, m in ed['learnset'])}
    # The Wither update: the WITHER (tools/build_wither_mon.py), after the ENDER DRAGON, its new moves after the dragon's
    if wcoords:
        wd = WM.SPECIES
        species['WITHER'] = {k: v for k, v in wd.items() if k not in ('ability',)} | {
            'front': wcoords['front'], 'back': wcoords['back'], 'file': WM.NAME}
        moves |= {k: v for k, v in mv.items() if k not in moves and any(m == k for _, m in wd['learnset'])}
    # Experience tables, from the EXP_* macros in src/data/pokemon/experience_tables.h (C integer maths).
    def cdiv(a, b):
        return int(a / b)
    formulas = {
        'MEDIUM_FAST': lambda n: n ** 3,
        'ERRATIC': lambda n: cdiv((100 - n) * n ** 3, 50) if n <= 50 else cdiv((150 - n) * n ** 3, 100) if n <= 68
        else cdiv(cdiv(1911 - 10 * n, 3) * n ** 3, 500) if n <= 98 else cdiv((160 - n) * n ** 3, 100),
        'FLUCTUATING': lambda n: cdiv((cdiv(n + 1, 3) + 24) * n ** 3, 50) if n <= 15 else cdiv((n + 14) * n ** 3, 50) if n <= 36
        else cdiv((cdiv(n, 2) + 32) * n ** 3, 50),
        'MEDIUM_SLOW': lambda n: cdiv(6 * n ** 3, 5) - 15 * n * n + 100 * n - 140,
        'FAST': lambda n: cdiv(4 * n ** 3, 5),
        'SLOW': lambda n: cdiv(5 * n ** 3, 4),
    }
    exp = {k: [0, 1] + [f(n) for n in range(2, 101)] for k, f in formulas.items()}
    data = {'species': species, 'moves': moves, 'types': X.type_chart(), 'exp': exp, 'wild': WILD}
    (OUT / 'data').mkdir(parents=True, exist_ok=True)
    json.dump(data, open(OUT / 'data' / 'pokemon.json', 'w'), separators=(',', ':'))
    print(f'  {len(species)} species, {len(moves)} moves, growth rates {sorted(exp)}')


def build_ender_dragon():
    """The ENDER DRAGON's sprites, icon, follower, cry, The End's battle background and the Hall of Fame pieces.
    Returns its front and back pic coordinates for pokemon.json."""
    return ED.build_all(pal(FR / f'graphics/pokemon/icon_palettes/icon_palette_{ED.ICON_PAL}.pal'))


def build_wither():
    """The WITHER's sprites, icon, follower, cry and battle background. Returns its front and back pic coordinates."""
    return WM.build_all(pal(FR / f'graphics/pokemon/icon_palettes/icon_palette_{WM.ICON_PAL}.pal'))


def ender_coords():
    """The ENDER DRAGON's pic coordinates, rendered but not saved (for --wither, which leaves its files alone)."""
    return {kind: WM.pic_coords(idx) for kind, idx in ED.front_back().items()}


# ---------------------------------------------------------------- the world update (stage 5d, design 3.15)
# Generated worlds' wild POKeMON: one table per biome group (the biome maps' `wild` ids, src/gen/plan.js WILD_OF) and the
# two cave floors, in FireRed's own format (rate, slots, mons [species, min, max]; fishing with rod groups), so wild.js's
# pickFrom and encounters.js's roll and rateFor read them unchanged. The slots are the design's rough weights. Table
# levels are 2 to 5; wild.levelFor raises them with distance and biome in the game. Eleven Kanto species are new; they
# and these tables go to assets/data/pokemon_world.json, which only generated worlds load (src/assets.js
# loadGenAssets), so pokemon.json and everything a Classic page loads stay exactly as they were.
WORLD_SPECIES = ['SANDSHREW', 'SANDSLASH', 'TAUROS', 'RHYHORN', 'BELLSPROUT', 'EXEGGCUTE', 'SCYTHER', 'PINSIR', 'JYNX',
                 'SLOWPOKE', 'LAPRAS']
# evolved and rare species sit at the top of the 2 to 5 band, the rest at 2 to 4
GEN_HIGH = {'METAPOD', 'KAKUNA', 'GLOOM', 'HAUNTER', 'ARBOK', 'SANDSLASH', 'RAPIDASH', 'GRAVELER', 'DEWGONG', 'GOLBAT',
            'MACHOKE', 'SEAKING', 'GYARADOS', 'LAPRAS', 'SCYTHER', 'PINSIR', 'JYNX', 'TAUROS', 'ONIX', 'ABRA', 'MAGNEMITE'}
GEN_LAND = {
    'PLAINS': [('PIDGEY', 30), ('RATTATA', 30), ('NIDORAN_F', 10), ('NIDORAN_M', 10), ('DODUO', 8), ('PONYTA', 5), ('MEOWTH', 5), ('ABRA', 2)],
    'FOREST': [('CATERPIE', 20), ('WEEDLE', 20), ('PIDGEY', 15), ('METAPOD', 10), ('KAKUNA', 10), ('ODDISH', 10), ('BELLSPROUT', 5),
               ('VENONAT', 5), ('PIKACHU', 5)],
    'BIRCH_FOREST': [('PIDGEY', 25), ('ODDISH', 20), ('CATERPIE', 15), ('WEEDLE', 15), ('PARAS', 10), ('JIGGLYPUFF', 8), ('PIKACHU', 5),
                     ('CLEFAIRY', 2)],
    'DARK_FOREST': [('GASTLY', 20), ('VENONAT', 20), ('PARAS', 15), ('ODDISH', 15), ('ZUBAT', 10), ('MEOWTH', 8), ('GLOOM', 5), ('HAUNTER', 2)],
    'TAIGA': [('PIDGEY', 20), ('RATTATA', 20), ('SPEAROW', 15), ('GROWLITHE', 15), ('VULPIX', 10), ('MANKEY', 10), ('PONYTA', 5), ('MACHOP', 5)],
    'SNOWY': [('SEEL', 20), ('PIDGEY', 20), ('JIGGLYPUFF', 15), ('RATTATA', 15), ('CLEFAIRY', 10), ('JYNX', 5), ('DEWGONG', 2)],
    'DESERT': [('SANDSHREW', 30), ('EKANS', 20), ('DIGLETT', 15), ('CUBONE', 10), ('RHYHORN', 5), ('ARBOK', 3), ('SANDSLASH', 3)],
    'SAVANNA': [('DODUO', 20), ('SPEAROW', 20), ('PONYTA', 15), ('RATTATA', 15), ('TAUROS', 10), ('GROWLITHE', 10), ('RHYHORN', 5), ('RAPIDASH', 1)],
    'SWAMP': [('GRIMER', 20), ('POLIWAG', 20), ('KOFFING', 15), ('PSYDUCK', 15), ('TANGELA', 10), ('VENONAT', 10), ('EKANS', 5), ('GLOOM', 2)],
    'JUNGLE': [('PARAS', 15), ('TANGELA', 15), ('ODDISH', 15), ('BELLSPROUT', 15), ('PIKACHU', 10), ('MANKEY', 10), ('EXEGGCUTE', 10),
               ('SCYTHER', 5), ('PINSIR', 2)],
    'BEACH': [('KRABBY', 30), ('SPEAROW', 20), ('PSYDUCK', 20), ('MEOWTH', 10), ('SLOWPOKE', 10)],
    'MOUNTAINS': [('GEODUDE', 30), ('MACHOP', 20), ('MANKEY', 15), ('SPEAROW', 15), ('ONIX', 10), ('GRAVELER', 5), ('RHYHORN', 5)],
    'CAVE1': [('ZUBAT', 35), ('GEODUDE', 30), ('PARAS', 10), ('ONIX', 10), ('DIGLETT', 10), ('CLEFAIRY', 5)],
    'CAVE2': [('ZUBAT', 30), ('GRAVELER', 20), ('GOLBAT', 15), ('ONIX', 15), ('MACHOKE', 10), ('MAGNEMITE', 10)],
}
GEN_WATER = {
    'SNOWY': [('SEEL', 70), ('SHELLDER', 30)],
    'SWAMP': [('POLIWAG', 60), ('PSYDUCK', 40)],
    'BEACH': [('TENTACOOL', 70), ('SHELLDER', 30)],
    'OCEAN': [('TENTACOOL', 50), ('MAGIKARP', 15), ('HORSEA', 15), ('GOLDEEN', 5), ('SEEL', 14), ('LAPRAS', 1)],
    # (playfix: rivers and lakes are fresh water: no TENTACOOL, HORSEA or SEEL there)
    'RIVER': [('MAGIKARP', 35), ('GOLDEEN', 30), ('POLIWAG', 15), ('PSYDUCK', 14), ('SLOWPOKE', 5), ('SEAKING', 1)],
}
# Steve fishes with FireRed's OLD ROD group (main.js reelIn), so every rod reads the whole list here
GEN_FISH = {
    'OCEAN': [('MAGIKARP', 40), ('GOLDEEN', 15), ('HORSEA', 20), ('KRABBY', 15), ('SEAKING', 9), ('GYARADOS', 1)],
    'RIVER': [('MAGIKARP', 40), ('GOLDEEN', 30), ('HORSEA', 10), ('KRABBY', 10), ('SEAKING', 9), ('GYARADOS', 1)],
}
GEN_RATE = {'land': 21, 'land_rock': 15, 'cave': 7, 'water': 1, 'fishing': 20}


def gen_wild():
    lv = lambda sp: [4, 5] if sp in GEN_HIGH else [2, 4]
    table = lambda rows, rate: {'rate': rate, 'slots': [w for _, w in rows], 'mons': [[sp, *lv(sp)] for sp, _ in rows]}
    out = {}
    for key in ('PLAINS', 'FOREST', 'BIRCH_FOREST', 'DARK_FOREST', 'TAIGA', 'SNOWY', 'DESERT', 'SAVANNA', 'SWAMP', 'JUNGLE', 'BEACH',
                'MOUNTAINS', 'CAVE1', 'CAVE2', 'OCEAN', 'RIVER'):
        t = {}
        if key in GEN_LAND:
            rate = GEN_RATE['cave'] if key.startswith('CAVE') else GEN_RATE['land_rock'] if key in ('MOUNTAINS', 'DESERT', 'BEACH', 'SNOWY') else GEN_RATE['land']
            t['land'] = table(GEN_LAND[key], rate)
        if key in GEN_WATER:
            t['water'] = table(GEN_WATER[key], GEN_RATE['water'])
        if key in GEN_FISH:
            rows = GEN_FISH[key]
            t['fishing'] = {**table(rows, GEN_RATE['fishing']), 'groups': {r: list(range(len(rows))) for r in ('old_rod', 'good_rod', 'super_rod')}}
        out['GEN_' + key] = t
    return out


def build_world_data(fly):
    """assets/data/pokemon_world.json: the new species (with the moves they bring that pokemon.json lacks) and the
    generated worlds' wild tables. pokemon.json is read, never written."""
    base = json.load(open(OUT / 'data' / 'pokemon.json'))
    sp_info = X.species_info(); names = X.species_names(); mv = X.moves(); ls = X.learnsets()
    front = X.pic_coords('front_pic_coordinates.h', 'gMonFrontPicCoords')
    back = X.pic_coords('back_pic_coordinates.h', 'gMonBackPicCoords')
    elev = X.elevation(); ids = X.species_ids()
    species, used = {}, set()
    for sp in WORLD_SPECIES:
        assert sp not in base['species'], sp
        learn = [[lvl, m] for lvl, m in ls[sp] if mv[m]['effect'] in SUPPORTED_EFFECTS]
        used.update(m for _, m in learn)
        species[sp] = {'name': names[sp], **sp_info[sp], 'learnset': learn, 'canFly': sp in fly, 'front': front[sp], 'back': back[sp],
                       'elevation': elev.get(sp, 0), 'file': sp.lower(), 'id': ids.get(sp, 0)}
    moves = {k: v for k, v in mv.items() if k in used and k not in base['moves']}
    wild = gen_wild()
    known = set(base['species']) | set(species)
    for k, t in wild.items():
        for kind, v in t.items():
            assert len(v['slots']) == len(v['mons']), (k, kind)
            for m in v['mons']:
                assert m[0] in known, (k, m[0])
    data = {'species': species, 'moves': moves, 'wild': wild}
    json.dump(data, open(OUT / 'data' / 'pokemon_world.json', 'w'), separators=(',', ':'))
    print(f'  {len(species)} new species, {len(moves)} new moves, {len(wild)} wild tables')


if __name__ == '__main__':
    fly = X.fly_learners()
    # --world (the world update, stage 5d): only the new species' sprites, icons and cries and pokemon_world.json
    if '--world' in sys.argv:
        print('world mons'); build_mons(WORLD_SPECIES)
        print('world overworld'); build_overworld(fly, WORLD_SPECIES)
        print('world data'); build_world_data(fly)
        print('done')
        sys.exit(0)
    # --ender: only the ENDER DRAGON's (and the WITHER's) files and pokemon.json (everything FireRed's is left as it is)
    # --wither: only the WITHER's files and pokemon.json
    if '--wither' in sys.argv:
        coords = ender_coords()
    else:
        if '--ender' not in sys.argv:
            print('battle'); build_battle()
            print('mons'); build_mons()
            print('overworld'); build_overworld(fly)
            print('ui'); build_ui()
        print('ender dragon'); coords = build_ender_dragon()
    print('wither'); wcoords = build_wither()
    print('data'); build_data(fly, coords, wcoords)
    print('done')
