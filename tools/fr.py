#!/usr/bin/env python3
"""Build runtime assets from the pret/pokefirered and rh-hideout/pokeemerald-expansion decomps.

Outputs (into assets/):
  world/world.json          stitched Kanto layout: bounds, chunk grid, maps, towns
  world/collision.bin       u8 per metatile (1 = blocked)
  world/behavior.bin        u8 per metatile (metatile behavior id)
  world/chunks/{cx}_{cy}.png / {cx}_{cy}_top.png   pre-rendered 512px map chunks
  sprites/red*.png, ball, sparkle                     colorized sprite sheets
  ui/regionmap.png, cursor.png, player_icon.png, window.png, font.png, font.json, region.json
"""
import json, os, re, struct, sys
from collections import Counter
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent.parent
FR = HERE / 'vendor' / 'pokefirered'
EX = HERE / 'vendor' / 'pokeemerald-expansion'
OUT = HERE / 'assets'
CHUNK = 512
NUM_TILES_IN_PRIMARY = 640
NUM_METATILES_IN_PRIMARY = 640
NUM_PALS_IN_PRIMARY = 7
NUM_PALS_TOTAL = 13


def read_pal(path):
    lines = Path(path).read_text().splitlines()
    assert lines[0].startswith('JASC'), path
    n = int(lines[2])
    return [tuple(int(v) for v in lines[3 + i].split()) for i in range(n)]


def load_indexed(path):
    im = Image.open(path)
    assert im.mode == 'P', (path, im.mode)
    return np.array(im, dtype=np.uint8)


def colorize(path, pal, transparent0=True):
    idx = load_indexed(path)
    h, w = idx.shape
    out = np.zeros((h, w, 4), dtype=np.uint8)
    for i, (r, g, b) in enumerate(pal):
        m = idx == i
        out[m] = (r, g, b, 0 if (i == 0 and transparent0) else 255)
    return Image.fromarray(out, 'RGBA')


# ---------------------------------------------------------------- tilesets
def tileset_folders():
    """Map gTileset_X symbol -> folder path, by parsing headers.h + graphics.h."""
    gfx = {}
    for src in ('src/data/tilesets/graphics.h', 'src/graphics.c'):
        for m in re.finditer(r'gTilesetTiles_(\w+)\[\] = INCBIN_U32\("([^"]+)/tiles', (FR / src).read_text()):
            gfx[m.group(1)] = FR / m.group(2)
    heads = {}
    txt = (FR / 'src/data/tilesets/headers.h').read_text()
    for m in re.finditer(r'gTileset_(\w+) =\s*\{(.*?)\};', txt, re.S):
        tiles = re.search(r'\.tiles = gTilesetTiles_(\w+)', m.group(2)).group(1)
        heads['gTileset_' + m.group(1)] = gfx[tiles]
    return heads


class Tileset:
    def __init__(self, folder, secondary):
        self.folder = Path(folder)
        self.secondary = secondary
        idx = load_indexed(self.folder / 'tiles.png')
        h, w = idx.shape
        tiles = idx.reshape(h // 8, 8, w // 8, 8).transpose(0, 2, 1, 3).reshape(-1, 8, 8)
        self.tiles = tiles
        self.metatiles = np.fromfile(self.folder / 'metatiles.bin', dtype='<u2').reshape(-1, 8)
        self.attrs = np.fromfile(self.folder / 'metatile_attributes.bin', dtype='<u4')
        rng = range(0, NUM_PALS_IN_PRIMARY) if not secondary else range(NUM_PALS_IN_PRIMARY, NUM_PALS_TOTAL)
        self.pals = {i: read_pal(self.folder / 'palettes' / f'{i:02d}.pal') for i in rng}


class MetatileRenderer:
    def __init__(self, primary, secondary):
        self.p, self.s = primary, secondary
        self.pals = {**primary.pals, **secondary.pals}
        self.cache = {}
        # palette lookup tables as (16,3) arrays
        self.lut = {i: np.array(p, dtype=np.uint8) for i, p in self.pals.items()}

    def tile(self, idx):
        if idx < NUM_TILES_IN_PRIMARY:
            return self.p.tiles[idx] if idx < len(self.p.tiles) else None
        j = idx - NUM_TILES_IN_PRIMARY
        return self.s.tiles[j] if j < len(self.s.tiles) else None

    def attr(self, mid):
        if mid < NUM_METATILES_IN_PRIMARY:
            return int(self.p.attrs[mid]) if mid < len(self.p.attrs) else 0
        j = mid - NUM_METATILES_IN_PRIMARY
        return int(self.s.attrs[j]) if j < len(self.s.attrs) else 0

    def render(self, mid):
        """Return (below RGBA 16x16, above RGBA 16x16) numpy arrays."""
        if mid in self.cache:
            return self.cache[mid]
        if mid < NUM_METATILES_IN_PRIMARY:
            entries = self.p.metatiles[mid] if mid < len(self.p.metatiles) else None
        else:
            j = mid - NUM_METATILES_IN_PRIMARY
            entries = self.s.metatiles[j] if j < len(self.s.metatiles) else None
        below = np.zeros((16, 16, 4), dtype=np.uint8)
        above = np.zeros((16, 16, 4), dtype=np.uint8)
        if entries is None:
            self.cache[mid] = (below, above)
            return self.cache[mid]
        layer_type = (self.attr(mid) >> 29) & 3  # 0 normal, 1 covered, 2 split
        for k, e in enumerate(entries):
            e = int(e)
            tidx, hflip, vflip, pal = e & 0x3FF, (e >> 10) & 1, (e >> 11) & 1, (e >> 12) & 0xF
            t = self.tile(tidx)
            if t is None or pal not in self.lut:
                continue
            if hflip: t = t[:, ::-1]
            if vflip: t = t[::-1, :]
            rgb = self.lut[pal][t]
            alpha = (t != 0).astype(np.uint8) * 255
            px = np.dstack([rgb, alpha])
            x0, y0 = (k % 2) * 8, ((k % 4) // 2) * 8
            is_top = k >= 4
            target = above if (is_top and layer_type != 1) else below
            blit(target, px, x0, y0)
        self.cache[mid] = (below, above)
        return self.cache[mid]


def blit(dst, src, x, y):
    h, w = src.shape[:2]
    region = dst[y:y + h, x:x + w]
    a = src[:, :, 3:4] > 0
    region[...] = np.where(a, src, region)


# ---------------------------------------------------------------- event scripts, texts, sprites, doors
def _src(p):
    return (FR / p).read_text()


def script_sources():
    """Every event script file: data/event_scripts.s, data/scripts/*.inc, data/maps/*/scripts.inc."""
    return [FR / 'data/event_scripts.s'] + sorted((FR / 'data/scripts').glob('*.inc')) + \
        sorted((FR / 'data/maps').glob('*/scripts.inc'))


def parse_scripts():
    """label -> list of command lines (comments stripped), for every script label."""
    out, cur = {}, None
    for f in script_sources():
        for line in f.read_text().splitlines():
            line = line.split('@')[0].rstrip()
            m = re.match(r'^(\w+)::?\s*$', line)
            if m:
                cur = m.group(1); out[cur] = []; continue
            if cur and line.strip() and not line.strip().startswith('.align'):
                out[cur].append(line.strip())
    return out


def parse_texts():
    """label -> raw string (with \\n, \\l, \\p control codes) for every .string text in the decomp."""
    out = {}
    files = sorted((FR / 'data/text').glob('*.inc')) + sorted((FR / 'data/maps').glob('*/text.inc')) + \
        sorted((FR / 'data/scripts').glob('*.inc')) + [FR / 'data/event_scripts.s']
    for f in files:
        cur = None
        for line in f.read_text().splitlines():
            m = re.match(r'^(\w+)::\s*$', line)
            if m:
                cur = m.group(1); out[cur] = ''; continue
            m = re.match(r'^\s*\.string\s+"(.*)"\s*$', line)
            if m and cur is not None:
                out[cur] += m.group(1)
            elif line.strip() and cur is not None and not line.strip().startswith('.'):
                cur = None
    return out


def text_pages(raw, player='STEVE', rival='BLUE'):
    """A FireRed string as message pages ('\\n' between lines), or None if it needs runtime buffers."""
    s = raw.split('$')[0]
    if re.search(r'\{STR_VAR|\{B_|\{PLAYER_NAME_', s):
        return None
    s = s.replace('{PLAYER}', player).replace('{RIVAL}', rival)
    s = re.sub(r'\{[A-Z_0-9 ]+\}', '', s).replace('\\"', '"')
    pages = []
    for p in s.split('\\p'):
        p = p.replace('\\l', '\\n')
        lines = [ln.strip() for ln in p.split('\\n')]
        pages.append('\n'.join(ln for ln in lines if ln))
    return [p for p in pages if p] or None


def object_gfx():
    """OBJ_EVENT_GFX_X -> {png, pal, w, h, frames: pic-table frame list}; None for scriptless/var gfx."""
    ptrs = dict(re.findall(r'\[(OBJ_EVENT_GFX_\w+)\]\s*=\s*&(gObjectEventGraphicsInfo_\w+)',
                           _src('src/data/object_events/object_event_graphics_info_pointers.h')))
    info = {}
    for m in re.finditer(r'const struct ObjectEventGraphicsInfo (gObjectEventGraphicsInfo_\w+) = \{(.*?)\};',
                         _src('src/data/object_events/object_event_graphics_info.h'), re.S):
        g = lambda k, b=m.group(2): (re.search(r'\.' + k + r' = ([^,]+),', b) or [None, None])[1]
        info[m.group(1)] = dict(pal=g('paletteTag'), w=int(g('width')), h=int(g('height')), images=g('images'))
    pics = {m.group(1): re.findall(r'overworld_frame\((gObjectEventPic_\w+), \d+, \d+, (\d+)\)', m.group(2))
            for m in re.finditer(r'static const struct SpriteFrameImage (sPicTable_\w+)\[\] = \{(.*?)\};',
                                 _src('src/data/object_events/object_event_pic_tables.h'), re.S)}
    gfx = _src('src/data/object_events/object_event_graphics.h')
    files = dict(re.findall(r'const u(?:16|32) (gObjectEventPic_\w+)\[\] = INCBIN_U(?:16|32)\("([^"]+)\.4bpp"\)', gfx))
    palfiles = dict(re.findall(r'const u16 (gObjectEventPal_\w+)\[\] = INCBIN_U16\("([^"]+)\.gbapal"\)', gfx))
    pals = {t: p for p, t in re.findall(r'\{(gObjectEventPal_\w+),\s*(OBJ_EVENT_PAL_TAG_\w+)\}', _src('src/event_object_movement.c'))}
    out = {}
    for gid, gi in ptrs.items():
        I = info.get(gi)
        pt = pics.get(I['images']) if I else None
        if not pt or pt[0][0] not in files:
            continue
        pal = palfiles.get(pals.get(I['pal']))
        if not pal:
            continue
        out[gid] = dict(png=FR / (files[pt[0][0]] + '.png'), pal=FR / (pal + '.pal'), w=I['w'], h=I['h'],
                        frames=[int(f) for _, f in pt])
    return out


def npc_sheet(g):
    """A colourised sheet laid out in pic-table order (0 S, 1 N, 2 W, 3-4 walk S, 5-6 walk N, 7-8 walk W, 9 extra)."""
    src = np.array(colorize(g['png'], read_pal(g['pal'])))
    w, h = g['w'], g['h']
    per_row = max(1, src.shape[1] // w)
    out = np.zeros((h, w * len(g['frames']), 4), np.uint8)
    for k, f in enumerate(g['frames']):
        sx, sy = (f % per_row) * w, (f // per_row) * h
        out[:, k * w:(k + 1) * w] = src[sy:sy + h, sx:sx + w]
    return out


def door_graphics():
    """sDoorGraphics: metatile id -> {name, sound, size, png, pals} (field_door.c)."""
    src = _src('src/field_door.c')
    labels = {k: int(v, 16) for k, v in re.findall(r'#define (METATILE_\w+)\s+(0x[0-9A-Fa-f]+)',
                                                    _src('include/constants/metatile_labels.h'))}
    tiles = dict(re.findall(r'(sDoorAnimTiles_\w+)\[\] = INCBIN_U8\("([^"]+)\.4bpp"\)', src))
    pals = {k: [int(x) for x in v.split(',')] for k, v in re.findall(r'(sDoorAnimPalettes_\w+)\[\] = \{([\d, ]+)\}', src)}
    out = {}
    for mt, snd, size, t, p in re.findall(r'\{(METATILE_\w+),\s*DOOR_SOUND_(\w+),\s*DOOR_SIZE_(\w+),\s*(sDoorAnimTiles_\w+),\s*(sDoorAnimPalettes_\w+)\}', src):
        if mt in labels and labels[mt] not in out:
            out[labels[mt]] = dict(name=Path(tiles[t]).name, sound='sliding' if snd == 'SLIDING' else 'door', size=size,
                                   png=FR / (tiles[t] + '.png'), pals=pals[p])
    return out


# ---------------------------------------------------------------- maps
def build_world():
    maps = {}
    for f in (FR / 'data/maps').glob('*/map.json'):
        m = json.load(open(f))
        maps[m['id']] = m
    layouts = {l['id']: l for l in json.load(open(FR / 'data/layouts/layouts.json'))['layouts'] if 'id' in l}
    sections = {s['id']: s for s in json.load(open(FR / 'src/data/region_map/region_map_sections.json'))['map_sections']}
    folders = tileset_folders()

    def layout_of(mid):
        return layouts[maps[mid]['layout']]

    # Routes 5-8 connect to a stand-in copy of Saffron; use the real city instead.
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
            if t in pos:
                if pos[t] != p:
                    print('  connection mismatch', mid, '->', t, pos[t], p)
                continue
            pos[t] = p
            q.append(t)

    minx = min(p[0] for p in pos.values()); miny = min(p[1] for p in pos.values())
    maxx = max(pos[m][0] + layout_of(m)['width'] for m in pos)
    maxy = max(pos[m][1] + layout_of(m)['height'] for m in pos)
    W, H = maxx - minx, maxy - miny
    print(f'{len(pos)} maps, world {W}x{H} metatiles')

    below = np.zeros((H * 16, W * 16, 4), dtype=np.uint8)
    above = np.zeros((H * 16, W * 16, 4), dtype=np.uint8)
    collision = np.ones((H, W), dtype=np.uint8)
    rawcol = np.zeros((H, W), dtype=np.uint8)  # the map's own impassable bits (rocks in water keep water behaviour)
    behavior = np.zeros((H, W), dtype=np.uint8)
    tilesets = {}
    renderers = {}
    WATER = {0x10, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x19, 0x1A, 0x1B}

    map_list, towns = [], []
    covered = np.zeros((H, W), dtype=bool)
    placed = []
    for mid, (mx, my) in pos.items():
        m, L = maps[mid], layout_of(mid)
        ox, oy = mx - minx, my - miny
        pk, sk = L['primary_tileset'], L['secondary_tileset']
        for key, sec in ((pk, False), (sk, True)):
            if key not in tilesets:
                tilesets[key] = Tileset(folders[key.replace('_Frlg', '')], sec)
        rk = (pk, sk)
        if rk not in renderers:
            renderers[rk] = MetatileRenderer(tilesets[pk], tilesets[sk])
        R = renderers[rk]
        data = np.fromfile(FR / L['blockdata_filepath'], dtype='<u2').reshape(L['height'], L['width'])
        for yy in range(L['height']):
            for xx in range(L['width']):
                e = int(data[yy, xx])
                metatile = e & 0x3FF
                col = (e >> 10) & 3
                b, a = R.render(metatile)
                X, Y = (ox + xx) * 16, (oy + yy) * 16
                below[Y:Y + 16, X:X + 16] = b
                above[Y:Y + 16, X:X + 16] = a
                beh = R.attr(metatile) & 0x1FF
                behavior[oy + yy, ox + xx] = min(beh, 255)
                collision[oy + yy, ox + xx] = 1 if (col != 0 or beh in WATER) else 0
                rawcol[oy + yy, ox + xx] = 1 if col != 0 else 0
                covered[oy + yy, ox + xx] = True
        placed.append((mid, ox, oy, L, R))
        sec = sections.get(m['region_map_section'], {})
        entry = {'id': mid, 'mapsec': m['region_map_section'], 'name': sec.get('name', mid), 'type': m['map_type'],
                 'x': ox, 'y': oy, 'w': L['width'], 'h': L['height']}
        map_list.append(entry)
        if m['map_type'] == 'MAP_TYPE_TOWN':
            warp = next((w for w in m.get('warp_events', []) if 'POKEMON_CENTER' in w['dest_map']), None) or \
                   next((w for w in m.get('warp_events', []) if 'PLAYERS_HOUSE' in w['dest_map']), None)
            towns.append({**entry, 'land': {'x': ox + warp['x'], 'y': oy + warp['y'] + 1}})
        print(f'  {mid:32s} at ({ox},{oy}) {L["width"]}x{L["height"]}')

    # Clear the surf rocks: water-behaviour tiles that the map marks impassable are the rocks in the sea.
    # Each one is replaced with the most common *interior* open-water tile nearby (one whose own
    # neighbours are all open water), so no shoreline edging or rock pixels leak into the channel.
    CLEAR_ROCKS = os.environ.get('NO_ROCK_CLEAR') != '1'
    N8 = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
    water_open = np.zeros((H, W), dtype=bool)
    for y in range(H):
        for x in range(W):
            water_open[y, x] = covered[y, x] and int(behavior[y, x]) in WATER and rawcol[y, x] == 0
    interior = np.zeros((H, W), dtype=bool)
    for y in range(1, H - 1):
        for x in range(1, W - 1):
            if water_open[y, x] and all(water_open[y + dy, x + dx] for dx, dy in N8) and not above[y * 16:y * 16 + 16, x * 16:x * 16 + 16, 3].any():
                interior[y, x] = True
    keys = {}
    blocks = {}
    for y, x in zip(*np.nonzero(interior)):
        b = below[y * 16:y * 16 + 16, x * 16:x * 16 + 16].tobytes()
        keys[(x, y)] = b
        blocks.setdefault(b, below[y * 16:y * 16 + 16, x * 16:x * 16 + 16].copy())
    global_mode = Counter(keys.values()).most_common(1)[0][0] if keys else None
    rocks = [(x, y) for y in range(H) for x in range(W)
             if covered[y, x] and int(behavior[y, x]) in WATER and rawcol[y, x] == 1] if CLEAR_ROCKS else []
    removed = 0
    for x, y in rocks:
        pick = None
        for R in (8, 20):
            near = Counter(keys[(nx, ny)]
                           for ny in range(max(0, y - R), min(H, y + R + 1))
                           for nx in range(max(0, x - R), min(W, x + R + 1))
                           if (nx, ny) in keys)
            if near:
                pick = near.most_common(1)[0][0]
                break
        pick = pick or global_mode
        if pick is None:
            continue
        below[y * 16:y * 16 + 16, x * 16:x * 16 + 16] = blocks[pick]
        above[y * 16:y * 16 + 16, x * 16:x * 16 + 16] = 0
        rawcol[y, x] = 0
        removed += 1
    print(f'  cleared {removed} surf rocks')

    # Fill the void between maps with each map's repeating border block, as the game does at its edges.
    best = np.full((H, W), 255, dtype=np.int32)
    owner = np.full((H, W), -1, dtype=np.int32)
    R_BORDER = 12
    for mi, (mid, ox, oy, L, R) in enumerate(placed):
        w, h = L['width'], L['height']
        for yy in range(max(0, oy - R_BORDER), min(H, oy + h + R_BORDER)):
            for xx in range(max(0, ox - R_BORDER), min(W, ox + w + R_BORDER)):
                if covered[yy, xx]:
                    continue
                d = max(0, ox - xx, xx - (ox + w - 1)) + max(0, oy - yy, yy - (oy + h - 1))
                if d < best[yy, xx]:
                    best[yy, xx] = d; owner[yy, xx] = mi
    borders = [np.fromfile(FR / L['border_filepath'], dtype='<u2') for (_, _, _, L, _) in placed]
    filled = 0
    for yy in range(H):
        for xx in range(W):
            mi = owner[yy, xx]
            if mi < 0:
                continue
            _, ox, oy, L, R = placed[mi]
            bw, bh = L.get('border_width', 2), L.get('border_height', 2)
            e = int(borders[mi][((yy - oy) % bh) * bw + ((xx - ox) % bw)])
            b, a = R.render(e & 0x3FF)
            below[yy * 16:yy * 16 + 16, xx * 16:xx * 16 + 16] = b
            above[yy * 16:yy * 16 + 16, xx * 16:xx * 16 + 16] = a
            filled += 1
    print(f'  filled {filled} border tiles')

    build_sky_chunks(below, above, covered, owner, placed, borders, W, H)

    # chunks
    cdir = OUT / 'world' / 'chunks'
    cdir.mkdir(parents=True, exist_ok=True)
    cw, ch = -(-W * 16 // CHUNK), -(-H * 16 // CHUNK)
    have = []
    for cy in range(ch):
        for cx in range(cw):
            for arr, suffix in ((below, ''), (above, '_top')):
                part = arr[cy * CHUNK:(cy + 1) * CHUNK, cx * CHUNK:(cx + 1) * CHUNK]
                if not part[:, :, 3].any():
                    continue
                full = np.zeros((CHUNK, CHUNK, 4), dtype=np.uint8)
                full[:part.shape[0], :part.shape[1]] = part
                Image.fromarray(full, 'RGBA').save(cdir / f'{cx}_{cy}{suffix}.png', optimize=True)
                have.append(f'{cx}_{cy}{suffix}')
    collision.tofile(OUT / 'world' / 'collision.bin')
    behavior.tofile(OUT / 'world' / 'behavior.bin')
    json.dump({'w': W, 'h': H, 'chunk': CHUNK, 'cw': cw, 'ch': ch, 'chunks': have, 'maps': map_list, 'towns': towns},
              open(OUT / 'world' / 'world.json', 'w'))
    print(f'  wrote {len(have)} chunk images')


def build_sky_chunks(below, above, covered, owner, placed, borders, W, H):
    """Half-resolution view of Kanto from the air: both layers composited, and every tile the
    stitched maps leave empty filled with the nearest map's border block (the same block the game
    repeats past a map's edge), so the ground below the clouds never has holes in it."""
    ys, xs = np.mgrid[0:H, 0:W]
    best = np.full((H, W), 1 << 30, dtype=np.int64)
    near = np.full((H, W), -1, dtype=np.int32)
    for mi, (mid, ox, oy, L, R) in enumerate(placed):
        w, h = L['width'], L['height']
        d = np.maximum(0, np.maximum(ox - xs, xs - (ox + w - 1))) + np.maximum(0, np.maximum(oy - ys, ys - (oy + h - 1)))
        m = d < best
        best[m] = d[m]; near[m] = mi
    sky = below.copy()
    a = above[:, :, 3:4] > 0
    sky[...] = np.where(a, above, sky)
    todo = ~covered & (owner < 0)
    for yy, xx in zip(*np.nonzero(todo)):
        mi = near[yy, xx]
        _, ox, oy, L, R = placed[mi]
        bw, bh = L.get('border_width', 2), L.get('border_height', 2)
        e = int(borders[mi][((yy - oy) % bh) * bw + ((xx - ox) % bw)])
        b, t = R.render(e & 0x3FF)
        tile = b.copy()
        tile[...] = np.where(t[:, :, 3:4] > 0, t, tile)
        sky[yy * 16:yy * 16 + 16, xx * 16:xx * 16 + 16] = tile
    print(f'  sky: filled {int(todo.sum())} empty tiles from the nearest border')
    sdir = OUT / 'sky' / 'chunks'
    sdir.mkdir(parents=True, exist_ok=True)
    cw, ch = -(-W * 16 // CHUNK), -(-H * 16 // CHUNK)
    n = 0
    for cy in range(ch):
        for cx in range(cw):
            part = sky[cy * CHUNK:(cy + 1) * CHUNK, cx * CHUNK:(cx + 1) * CHUNK]
            full = np.zeros((CHUNK, CHUNK, 4), dtype=np.uint8)
            full[:part.shape[0], :part.shape[1]] = part
            im = Image.fromarray(full, 'RGBA').reduce(2)
            im.save(sdir / f'{cx}_{cy}.png', optimize=True)
            n += 1
    print(f'  sky: wrote {n} half-resolution chunks')


# ---------------------------------------------------------------- sprites
def colorize_self(path):
    """Indexed PNG whose own palette is the real one (pret generates the .gbapal from it)."""
    im = Image.open(path)
    pal = im.getpalette()
    return colorize(path, [tuple(pal[i * 3:i * 3 + 3]) for i in range(16)])


def build_sprites():
    d = OUT / 'sprites'; d.mkdir(parents=True, exist_ok=True)
    ppal = read_pal(FR / 'graphics/object_events/palettes/player.pal')
    colorize(FR / 'graphics/object_events/pics/people/red_normal.png', ppal).save(d / 'red.png')
    colorize(FR / 'graphics/object_events/pics/people/red_item.png', ppal).save(d / 'red_item.png')
    colorize(FR / 'graphics/object_events/pics/people/red_surf.png', ppal).save(d / 'red_surf.png')
    colorize_self(FR / 'graphics/interface/ball/poke.png').save(d / 'ball.png')
    colorize_self(FR / 'graphics/interface/ball_open.png').save(d / 'ball_open.png')
    colorize(FR / 'graphics/field_effects/pics/small_sparkle.png', read_pal(FR / 'graphics/field_effects/palettes/small_sparkle.pal')).save(d / 'sparkle.png')
    # Pokémon overworld sheets (mounts and the walking buddy) are built by tools/build_sky.py.


# ---------------------------------------------------------------- ui
def render_tilemap(bin_path, tiles_png, pal_groups, pal_fallback, size=(30, 20)):
    """GBA text-mode tilemap (u16 per cell) -> RGBA image."""
    idx = load_indexed(tiles_png)
    h, w = idx.shape
    tiles = idx.reshape(h // 8, 8, w // 8, 8).transpose(0, 2, 1, 3).reshape(-1, 8, 8)
    ents = np.fromfile(bin_path, dtype='<u2')
    cols, rows = size
    flat = None
    if tiles.max() > 15:
        allc = [c for i in sorted(pal_groups) for c in pal_groups[i]]
        flat = np.array(allc, dtype=np.uint8)
    out = np.zeros((rows * 8, cols * 8, 4), dtype=np.uint8)
    for i, e in enumerate(ents[:cols * rows]):
        e = int(e)
        t, hf, vf, pal = e & 0x3FF, (e >> 10) & 1, (e >> 11) & 1, (e >> 12) & 0xF
        if t >= len(tiles):
            continue
        tile = tiles[t]
        if hf: tile = tile[:, ::-1]
        if vf: tile = tile[::-1, :]
        if flat is not None:  # sheet already carries absolute palette indices (pal*16 + colour)
            rgb = flat[np.minimum(tile, len(flat) - 1)]
            alpha = ((tile % 16) != 0).astype(np.uint8) * 255
        else:
            lut = pal_groups.get(pal, pal_fallback)
            rgb = np.array(lut, dtype=np.uint8)[tile]
            alpha = (tile != 0).astype(np.uint8) * 255
        x, y = (i % cols) * 8, (i // cols) * 8
        blit(out, np.dstack([rgb, alpha]), x, y)
    return out


def build_ui():
    d = OUT / 'ui'; d.mkdir(parents=True, exist_ok=True)
    rm = FR / 'graphics/region_map'
    region_pal = read_pal(rm / 'region_map.pal')
    groups = {i: region_pal[i * 16:(i + 1) * 16] for i in range(len(region_pal) // 16)}
    edge_pal = [tuple(int(c * 0.95) for c in col) for col in groups[2]]  # TintMapEdgesPalette: group 2 at 95%
    bg = render_tilemap(rm / 'background.bin', rm / 'background.png', groups, groups[0])
    kanto = render_tilemap(rm / 'kanto.bin', rm / 'region_map.png', groups, groups[0])
    edge = render_tilemap(rm / 'map_edge.bin', rm / 'map_edge.png', {**groups, 2: edge_pal}, edge_pal)
    screen = np.zeros_like(bg)
    screen[:, :, :3] = np.array(groups[0][0], dtype=np.uint8); screen[:, :, 3] = 255
    for layer in (bg, edge, kanto):  # the map BG sits above the frame layer; the frame's grey interior is the backdrop
        blit(screen, layer, 0, 0)
    Image.fromarray(screen, 'RGBA').save(d / 'regionmap.png')
    colorize(rm / 'cursor.png', read_pal(rm / 'cursor.pal')).save(d / 'cursor.png')
    colorize(rm / 'player_icon_red.png', read_pal(rm / 'player_icon_red.pal')).save(d / 'player_icon.png')
    colorize(rm / 'fly_icon.png', read_pal(rm / 'misc_icon.pal')).save(d / 'fly_icon.png')
    colorize(FR / 'graphics/text_window/std.png', read_pal(FR / 'graphics/text_window/stdpal_0.pal')).save(d / 'window.png')

    # region map section grid (15 rows x 22 cols) + names
    txt = (FR / 'src/data/region_map/region_map_layout_kanto.h').read_text()
    layer = txt.split('[LAYER_MAP]')[1].split('[LAYER_DUNGEON]')[0]
    rows = [re.findall(r'MAPSEC_\w+', r) for r in re.findall(r'\{([^{}]+)\}', layer)]
    rows = [r for r in rows if len(r) == 22]
    sections = {s['id']: s for s in json.load(open(FR / 'src/data/region_map/region_map_sections.json'))['map_sections']}
    names = {k: v.get('name', '') for k, v in sections.items() if v.get('name')}
    secs = {k: {'x': v.get('x', 0), 'y': v.get('y', 0), 'w': v.get('width', 1), 'h': v.get('height', 1)} for k, v in sections.items() if v.get('name')}
    json.dump({'grid': rows, 'names': names, 'sections': secs, 'cellX': 32, 'cellY': 32}, open(d / 'region.json', 'w'))

    # font: latin_normal glyph atlas (16x16 cells, 16 per row) + widths + charmap
    idx = load_indexed(FR / 'graphics/fonts/latin_normal.png')
    atlas = np.zeros(idx.shape + (4,), dtype=np.uint8)
    atlas[idx == 1] = (0, 0, 0, 255)      # foreground
    atlas[idx == 2] = (255, 0, 0, 255)    # shadow
    Image.fromarray(atlas, 'RGBA').save(d / 'font.png')
    src = (FR / 'src/text.c').read_text()
    arr = re.search(r'sFontNormalLatinGlyphWidths\[\] =\s*\{(.*?)\};', src, re.S).group(1)
    widths = [int(v) for v in re.findall(r'\d+', arr)]
    charmap = {}
    for line in (FR / 'charmap.txt').read_text().splitlines():
        m = re.match(r"^'(.|\\.)'\s*=\s*([0-9A-Fa-f]{2})\s*$", line)
        if m:
            ch = m.group(1)
            ch = {'\\\'': "'", '\\\\': '\\'}.get(ch, ch)
            charmap.setdefault(ch, int(m.group(2), 16))
    json.dump({'widths': widths, 'map': charmap}, open(d / 'font.json', 'w'))


if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    print('sprites'); build_sprites()
    print('ui'); build_ui()
    print('world'); build_world()
    print('done')
