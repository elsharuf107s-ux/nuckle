#!/usr/bin/env python3
"""Learned autotiling from the real FireRed maps.

For a terrain family (a set of metatile ids, e.g. every mountain/cliff piece), look at every outdoor
map that uses the General tileset, and record which metatile sits at the centre of each
neighbourhood pattern of "in the family / not in the family". Painting a boolean mask then picks,
for every masked cell, the metatile FireRed itself uses most often for that exact pattern
(5x5 first, backing off to 3x3), so edges, corners and cliff faces come out the way Game Freak drew them.

Caves and Viridian Forest get their own families, one per secondary tileset (learn_family): the wall
(or tree) pieces of that tileset, learned from every FireRed map drawn with it, so a mined cave wall or a
felled forest tree can re-edge its neighbours with the pieces Game Freak drew for that cave.
"""
import json
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path
import numpy as np
from fr import FR

MOUNTAIN_IDS = set(range(104, 188)) | set(range(497, 503)) | {527, 533, 534, 535, 540, 541, 542, 543}
LEDGE_BEHAVIORS = {0x38, 0x39, 0x3A, 0x3B}
GRASS_IDS = {1, 8, 9, 16, 17}
SAND_PATH_IDS = set(range(208, 211)) | set(range(216, 219)) | set(range(224, 227)) | {254, 255, 262, 263}
SAND_CORE = 217


def _attrs():
    a = np.fromfile(FR / 'data/tilesets/primary/general/metatile_attributes.bin', dtype='<u4')
    return a


@lru_cache(None)
def training_maps():
    maps = [json.load(open(f)) for f in FR.glob('data/maps/*/map.json')]
    layouts = {l['id']: l for l in json.load(open(FR / 'data/layouts/layouts.json'))['layouts'] if 'id' in l}
    out = []
    for m in maps:
        l = layouts.get(m['layout'])
        if not l or l['primary_tileset'] != 'gTileset_General':
            continue
        if m['map_type'] in ('MAP_TYPE_UNDERGROUND', 'MAP_TYPE_INDOOR'):
            continue
        d = np.fromfile(FR / l['blockdata_filepath'], dtype='<u2').reshape(l['height'], l['width'])
        out.append((m['id'], d & 0x3FF))
    return out


ATTR = _attrs()
def behavior(mid):
    return int(ATTR[mid]) & 0x1FF if mid < len(ATTR) else 0


def is_mountain(mid):
    return mid in MOUNTAIN_IDS and behavior(mid) not in LEDGE_BEHAVIORS and behavior(mid) != 0x2A


def ground_class(mid):
    if mid in GRASS_IDS or mid in (13, 4, 2, 3, 5):
        return 'g'
    if mid in SAND_PATH_IDS or mid in (188,) or 211 <= mid <= 229:
        return 's'
    return None


def keyof(mask, x, y, r):
    H, W = mask.shape
    bits = 0
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            yy = min(H - 1, max(0, y + dy)); xx = min(W - 1, max(0, x + dx))
            bits = (bits << 1) | int(mask[yy, xx])
    return bits


def local_ground(grid_or_cls, x, y, r=2, is_cls=False):
    H, W = grid_or_cls.shape
    c = Counter()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            yy, xx = y + dy, x + dx
            if 0 <= yy < H and 0 <= xx < W:
                g = grid_or_cls[yy, xx] if is_cls else ground_class(int(grid_or_cls[yy, xx]))
                if g: c[g] += 1
    return c.most_common(1)[0][0] if c else '?'


@lru_cache(None)
def learn(family='mountain'):
    member = {'mountain': is_mountain, 'sand': lambda m: m in SAND_PATH_IDS}[family]
    tables = {r: defaultdict(Counter) for r in (1, 2)}
    tables_g = {r: defaultdict(Counter) for r in (1, 2)}
    for mid, grid in training_maps():
        mask = np.vectorize(member)(grid)
        H, W = grid.shape
        for y in range(H):
            for x in range(W):
                if not mask[y, x]:
                    continue
                t = int(grid[y, x])
                g = local_ground(grid, x, y)
                for r in (1, 2):
                    k = keyof(mask, x, y, r)
                    tables[r][k][t] += 1
                    tables_g[r][(k, g)][t] += 1
    return tables, tables_g


_R = None
GRASS_RGB = {(115, 205, 164), (65, 180, 139), (139, 222, 189), (164, 230, 197)}
SAND_RGB = {(213, 197, 131), (197, 172, 106)}
@lru_cache(None)
def ground_pixels(mid):
    """(grass pixel count, sand pixel count) in a metatile's rendered image."""
    global _R
    if _R is None:
        from fr import Tileset, MetatileRenderer, tileset_folders
        f = tileset_folders()
        _R = MetatileRenderer(Tileset(f['gTileset_General'], False), Tileset(f['gTileset_CeruleanCity'], True))
    b, a = _R.render(mid)
    px = [tuple(int(v) for v in p) for p in b[:, :, :3].reshape(-1, 3)]
    return sum(p in GRASS_RGB for p in px), sum(p in SAND_RGB for p in px)


def compatible(mid, g):
    gp, sp = ground_pixels(mid)
    return not ((g == 's' and gp > 0) or (g == 'g' and sp > 0))


def paint(mask, ground_cls, family='mountain', variety=None):
    """mask: bool HxW; ground_cls: HxW array of 'g'/'s'. Returns HxW metatile ids (-1 where unmasked)."""
    tables, tables_g = learn(family)
    H, W = mask.shape
    out = np.full((H, W), -1, dtype=np.int32)
    misses = 0
    for y in range(H):
        for x in range(W):
            if not mask[y, x]:
                continue
            g = local_ground(ground_cls, x, y, is_cls=True)
            pick = None
            first = None
            for r in (2, 1):
                k = keyof(mask, x, y, r)
                for tab, key in ((tables_g[r], (k, g)), (tables[r], k)):
                    for cand, _ in (tab[key].most_common() if key in tab else []):
                        if first is None:
                            first = cand
                        if compatible(cand, g):
                            pick = cand
                            break
                    if pick is not None:
                        break
                if pick is not None:
                    break
            if pick is None:
                pick = first
            if pick is None:
                misses += 1
                pick = 113 if family == 'mountain' else SAND_CORE
            out[y, x] = pick
    return out, misses


# ---------------------------------------------------------------- per-tileset families (caves, forest)
@lru_cache(None)
def pair_maps(pk, sk):
    """(map id, raw block data: metatile id | collision << 10 | elevation << 12) of every FireRed map drawn
    with this tileset pair."""
    maps = [json.load(open(f)) for f in sorted(FR.glob('data/maps/*/map.json'))]
    layouts = {l['id']: l for l in json.load(open(FR / 'data/layouts/layouts.json'))['layouts'] if 'id' in l}
    out = []
    for m in maps:
        l = layouts.get(m['layout'])
        if l and (l['primary_tileset'], l['secondary_tileset']) == (pk, sk):
            d = np.fromfile(FR / l['blockdata_filepath'], dtype='<u2').reshape(l['height'], l['width'])
            out.append((m['id'], d))
    return out


def mask_keys(mask, r):
    """Neighbourhood key (same bit order as keyof) for every cell; cells past the edge count as members,
    the way a cave wall runs on past the map."""
    H, W = mask.shape
    p = np.pad(mask.astype(np.int64), r, constant_values=1)
    k = np.zeros((H, W), np.int64)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            k = k * 2 + p[r + dy:r + dy + H, r + dx:r + dx + W]
    return k


# weights of the 3x3 neighbours when no learned pattern matches: sides count more than corners
_W3 = [1, 3, 1, 3, 0, 3, 1, 3, 1]


def _dist3(a, b):
    return sum(w for i, w in enumerate(_W3) if ((a >> (8 - i)) & 1) != ((b >> (8 - i)) & 1))


def learn_family(pk, sk, members):
    """Autotile tables for one tileset family: {r: {key: Counter(mid)}} from every map of the pair, plus
    tables['fill']: the 3x3 neighbourhoods FireRed never draws, each borrowing the closest learned one, so
    a mined wall can always be re-edged somehow (or, better, crumbled back to a shape FireRed has)."""
    members = set(members)
    tables = {r: defaultdict(Counter) for r in (1, 2)}
    for _, data in pair_maps(pk, sk):
        grid = data & 0x3FF
        mask = np.isin(grid, list(members))
        for r in (1, 2):
            keys = mask_keys(mask, r)
            for y, x in zip(*np.nonzero(mask)):
                tables[r][int(keys[y, x])][int(grid[y, x])] += 1
    seen = list(tables[1])
    tables['fill'] = {}
    if seen:
        for n in range(256):
            k = ((n >> 4) << 5) | (1 << 4) | (n & 15)       # centre bit set, the 8 neighbours from n
            if k not in tables[1]:
                best = min(seen, key=lambda s: (_dist3(s, k), -sum(tables[1][s].values())))
                tables['fill'][k] = Counter(tables[1][best])
    return tables
