#!/usr/bin/env python3
"""The generated worlds' tile bank: terrain.json and atlas_gen.png (a stage of tools/build_world.py, part 1).

Generated layouts (Kanto World, Wild World) draw their land with FireRed's own pieces, recoloured and
recombined. None of it touches Classic: the generated entries are numbered from the end of world.json's
entries (8975 on), live in a second image pair (atlas_gen.png below the sprites, atlas_gen_top.png above
them) and in terrain.json's own `entries` table, and are loaded only in generated layouts. atlas.png,
atlas_top.png and world.json are written by build_world.py before this stage runs and are never changed.

What part 1 (stage 2a of the world update) builds, all from General (`gTileset_General`) metatiles:

  vocab      the General mid lists the generator uses (grass, tall grass, trees, rock, ledges, paths, sand,
             sea, pond water, boulders...), each checked against its behaviour and material.
  quarter    quarter-tile composition (the prototype's wang.py): FireRed draws every blob edge as a 3x3 block
             of metatiles plus four inner corners, so any blob shape is drawn by taking each 8x8 quarter of a
             cell from the piece whose quarter matches that corner's situation. The 47 blob codes of four
             sets: A sand against sea, B beach sand against grass, C path against grass, P pond water
             against a grass bank (P has no inner corners in FireRed; they are built from its own edge
             pixels). Every set has recolours (snow, ice, mud, gravel...). Every code of a set has the set's
             metadata (a beach's edge cell is sand however much sea it shows).
  variants   palette transforms by colour ramp (the prototype's bank.py): ground tints (cool, dry, lush,
             swamp; temperate is General itself), two transition bands per hub pair (3.3, 3.7), rock styles
             (grey, snowy, sandstone; brown is General itself).
  overlays   a tree, rock-edge, ledge or path piece with its ground removed, so it can be drawn over any
             ground (4.3). The ground's plain colour becomes transparent; ground pixels that belong to the
             object (shadows under a tree, the light rim beside a path) become semi-transparent "delta"
             pixels whose colour and alpha reproduce the original exactly over the ground's plain colour;
             loose tufts become transparent (the cell's ground brings its own). The home entry (the original
             pixels, or the recoloured piece on its style's ground) is kept for cells whose ground is the
             piece's own. Every overlay composited over its home ground may differ from its home entry in at
             most 3% of its pixels, counted strictly (ov_counts: only loose tufts are exempt), and must
             reproduce it exactly over the plain ground colour (asserted here, re-checked by
             tools/gen_tests/terrain_check.py).
  learned    the rock and ledge autotile tables learned from FireRed's outdoor maps (the method of
             tools/autotile.py, which world.reedgeCliffs uses; the prototype's learn.py generalised it to
             ledges): 5x5 and 3x3 membership patterns with the ground context 'g' / 's', plus `fill`, the
             nearest learned 3x3 pattern for every one FireRed never draws, so a lookup never misses. The
             rock tables must equal autotile.json's (asserted), so the generator and the runtime re-edger
             pick the same pieces.

What part 2 (stage 2b) adds:

  species    every tree species' 14 lattice pieces (the pieces world.treeTileFor returns), a home look and an
             overlay each: oak (General's own), spruce and snowy spruce (Kanto's cone recoloured, snow on the crown,
             snowy spruce at home on snow), round oak, birch (white trunk with black marks), dark oak, jungle (thick
             trunk, hanging vines) and swamp oak (vines) from Viridian Forest's round tree made 2 wide, and acacia
             (a new flat crown on a bent, forked trunk). Round and acacia pieces are cut from a small rendered forest
             per lattice case, so the tiles join as the trees overlap.
  synth      ground materials (mud, podzol and clay on FireRed's grass tuft pattern; snow, ice, sand, grass listed
             from part 1) and decoration sprites (cactus and its top, dead bush, sugar cane, lily pad, pumpkin and
             melon from above), each sprite a home entry on its home ground and an overlay.
  ores       an ore entry for every (rock style, interior face, ore): the faces are every piece the learned rock
             painter can put on a cell whose 3x3 is all rock; painted with build_world.paint_ore on the style's face
             with the brown face's rock mask; `base` is the style's plain face. Kanto's own (face, ore) entries are
             reused for brown. Cave completions: every interior wall piece of Mt Moon's, Rock Tunnel's and Seafoam's
             families in every ore, with build_world's palette masks (existing entries reused, asserted equal).

Usage: python3 tools/build_terrain.py           (standalone: reads world.json, atlas.png and atlas_top.png)
       build_world.py calls attach(entries, grid) after The End, with the entries it has just written.
Outputs (assets/world/): terrain.json, atlas_gen.png, atlas_gen_top.png.
Entry rows: [mid, pair, beh, col, mat, base, above, enc, vsrc, var, ov] (world.json's 8 fields, then the
source entry, the variant id and the overlay flag). See section 21 of the world-update design for the format.
"""
import colorsys
import hashlib
import json
import math
import os
import sys
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

sys.dont_write_bytecode = True                  # no __pycache__ in tools/ (the deploy copy takes the folder)
sys.path.insert(0, str(Path(__file__).parent))
import autotile as AT  # noqa: E402
from fr import FR  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / 'assets' / 'world'
COLS = 64
TERRAIN_V = 1
GEN_VERSION = 1
GEN_BASE = 8975               # world.json's entry count; asserted against the entries passed in
OV_TOLERANCE = 0.03           # an overlay over its home ground may differ from its home entry in at most 3% of pixels
PIX_TOL = 3                   # a pixel "differs" when a channel is off by more than this (the alpha encoding rounds)

# ---------------------------------------------------------------- colours (FireRed's ramps, from the prototype's bank.py)
GRASS_RGB = ((115, 205, 164), (65, 180, 139), (139, 222, 189), (164, 230, 197))     # base first
GRASS_BASE = GRASS_RGB[0]
GRASS_RIMS = ((172, 222, 164), (189, 230, 164))           # the light grass beside a path (C) or a beach (B)
PATH_SAND = ((213, 197, 131), (197, 172, 106), (230, 222, 164), (172, 148, 74))     # path and mountain-foot sand
BEACH_SAND = ((238, 230, 139), (222, 197, 139), (213, 189, 106), (230, 213, 139), (213, 197, 106))
SAND_RGB = set(PATH_SAND) | set(BEACH_SAND)
WATER_RGB = {(49, 98, 180), (65, 123, 189), (74, 123, 222), (74, 148, 222), (82, 123, 205), (98, 139, 213),
             (123, 156, 238), (139, 164, 255), (106, 164, 230), (82, 156, 230), (98, 164, 222)}
ROCK_RGB = {(90, 57, 65), (123, 74, 74), (148, 106, 106), (189, 148, 139), (222, 197, 164), (238, 213, 197)}
POND_RGB = (98, 164, 222)


def hsv(c):
    return colorsys.rgb_to_hsv(*[v / 255 for v in c])


def rgb(h, s, v):
    return tuple(int(round(max(0, min(1, q)) * 255)) for q in colorsys.hsv_to_rgb(h % 1.0, s, v))


def snap(c):
    """GBA colours are 5 bits per channel: snap to its grid so recolours look native."""
    return tuple(min(255, (v >> 3) << 3 | (v >> 5)) for v in c)


def ramp(r, v):
    for i in range(len(r) - 1):
        if v < r[i + 1][0]:
            return r[i][1]
    return r[-1][1]


SNOW_RAMP = [(0.0, (96, 120, 160)), (0.62, (150, 172, 205)), (0.72, (198, 213, 238)), (0.80, (230, 238, 246)),
             (0.88, (248, 248, 255))]
SAND_RAMP = [(0.0, (172, 148, 74)), (0.75, (197, 172, 106)), (0.82, (213, 197, 131)), (0.88, (230, 222, 164)),
             (0.93, (238, 230, 139))]
SAND_SNOW = [(0.0, (140, 160, 200)), (0.72, (180, 196, 226)), (0.80, (205, 218, 240)), (0.85, (222, 230, 246)),
             (0.88, (238, 242, 250)), (0.92, (250, 250, 255))]
SAND_SNOW_COLOURS = [c for _, c in SAND_SNOW]
ICE_RAMP = [(0.0, (115, 156, 205)), (0.72, (156, 197, 238)), (0.80, (180, 213, 246)), (0.86, (205, 230, 255)),
            (0.91, (222, 238, 255))]
# FireRed's ground grass becomes exactly the snow (or sand) the beach pieces make
GRASS_TO_SNOW = {(115, 205, 164): (250, 250, 255), (65, 180, 139): (205, 218, 240), (139, 222, 189): (222, 230, 246),
                 (164, 230, 197): (238, 242, 250)}
GRASS_TO_SAND = {(65, 180, 139): (213, 189, 106), (115, 205, 164): (238, 230, 139), (139, 222, 189): (222, 197, 139),
                 (164, 230, 197): (246, 238, 164)}


def is_green(c):
    h, s, v = hsv(c)
    return 0.16 <= h <= 0.55 and s >= 0.18


def is_sand(c):
    if c in SAND_RGB:
        return True
    h, s, v = hsv(c)
    return 0.10 <= h <= 0.17 and s >= 0.25 and v >= 0.6


def is_water(c):
    if c in WATER_RGB:
        return True
    h, s, v = hsv(c)
    return 0.57 <= h <= 0.67 and s >= 0.35


def is_rock(c):
    if c in ROCK_RGB:
        return True
    h, s, v = hsv(c)
    return (h <= 0.06 or h >= 0.95) and 0.12 <= s <= 0.55


def pull(c, p):
    """A green moved toward a biome colour: (target hue in degrees, pull 0..1, saturation and value multipliers)."""
    h, s, v = hsv(c)
    ht, a, sm, vm = p
    h = h + a * (ht / 360 - h)
    return rgb(h, min(1, s * sm), min(1, v * vm))


# ---------------------------------------------------------------- variants (palette transforms)
TEMPERATE = (153, 0.0, 1.0, 1.0)
# the prototype's TINT values (world-prototype/gen.py) for the four non-temperate grass tints (3.3)
TINTS = {'cool': (168, 0.55, 0.62, 0.84), 'dry': (64, 0.78, 0.86, 0.98), 'lush': (114, 0.72, 1.3, 0.97),
         'swamp': (82, 0.68, 0.62, 0.70)}
TINT_NAMES = ['temperate', 'cool', 'dry', 'lush', 'swamp']


def band(t, k):
    """A transition band at fraction k of the way from temperate to tint t (3.7)."""
    h, p, s, v = TINTS[t]
    return (h, round(p * k, 4), round(1 + (s - 1) * k, 4), round(1 + (v - 1) * k, 4))


def tint_fn(p):
    def f(c):
        return pull(c, p) if is_green(c) else c
    return f


def ground_fn(kind, tint=None):
    """What FireRed's grass pixels become on another ground: a tint, snow or sand."""
    def f(c):
        if not is_green(c):
            return c
        h, s, v = hsv(c)
        if kind == 'snow':
            if c in GRASS_TO_SNOW:
                return GRASS_TO_SNOW[c]
            return ramp(SAND_SNOW, v) if v >= 0.70 else snap(rgb(0.47, s * 0.55, v * 0.78))
        if kind == 'sand':
            if c in GRASS_TO_SAND:
                return GRASS_TO_SAND[c]
            return ramp(SAND_RAMP, v) if v >= 0.7 else snap(rgb(0.12, s * 0.8, v * 0.9))
        return pull(c, tint)
    return f


def sand_fn(kind):
    """What sand pixels become: snow, ice, mud, gravel, dirt (savanna red-brown) or pale (desert stone path)."""
    def f(c):
        if not is_sand(c):
            return c
        h, s, v = hsv(c)
        if kind == 'snow':
            return ramp(SAND_SNOW, v)
        if kind == 'ice':
            return ramp(ICE_RAMP, v)
        if kind == 'mud':
            return snap(rgb(0.09, s * 0.5, v * 0.62))
        if kind == 'gravel':
            return snap(rgb(0.08, s * 0.22, v * 0.86))
        if kind == 'dirt':
            return snap(rgb(0.05, min(1, s * 1.3), v * 0.9))
        if kind == 'pale':
            return snap(rgb(h + 0.008, s * 0.82, min(1, v * 1.04)))
        return c
    return f


def rock_fn(style):
    def f(c):
        if not (is_rock(c) or c in ((222, 197, 164), (238, 213, 197))):
            return c
        h, s, v = hsv(c)
        if style == 'grey':
            return snap(rgb(0.6, s * 0.18, v * 0.98))
        if style == 'sandstone':
            return snap(rgb(0.11, min(1, s * 1.15 + 0.1), min(1, v * 1.08)))
        if style == 'snowy':
            return ramp(SNOW_RAMP, v) if v >= 0.70 else snap(rgb(0.62, s * 0.25, v))
        return c
    return f


def rim_fn(kind):
    """The pond set's dark bank rim (and a pond's water) for its sand, snow and swamp recolours."""
    def f(c):
        h, s, v = hsv(c)
        if is_rock(c):
            if kind == 'sand':
                return ramp(SAND_RAMP, v + 0.25)
            if kind == 'snow':
                return ramp(SNOW_RAMP, v + 0.3)
            return c
        if kind == 'swamp' and is_water(c):
            return snap(rgb(0.46, s * 0.62, v * 0.72))
        return c
    return f


def sea_to_pond(c):
    """Sea colours become pond water (ice against a lake's water): the plain sea as the pond's flat blue,
    the light foam lines a step lighter."""
    if not is_water(c):
        return c
    h, s, v = hsv(c)
    if v >= 0.95 or c == (139, 164, 255):
        return snap(rgb(0.57, 0.25, 0.97))
    return POND_RGB


def by_class(rock=None, green=None, sand=None):
    """One recolour that classifies each original colour once (rock, then green, then sand), so a colour already
    moved into another class is never moved twice."""
    def f(c):
        if rock is not None and (is_rock(c) or c in ((222, 197, 164), (238, 213, 197))):
            return rock(c)
        if green is not None and is_green(c):
            return green(c)
        if sand is not None and is_sand(c):
            return sand(c)
        return c
    return f


def recolour(img, fn):
    """Apply a colour function to every opaque pixel of an RGBA tile (16x16x4), keeping alpha."""
    out = img.copy()
    a = out[:, :, 3] > 0
    if not a.any():
        return out
    rgb_ = out[:, :, :3].reshape(-1, 3)
    cache = {}
    flat = a.reshape(-1)
    for k in np.nonzero(flat)[0]:
        c = tuple(int(v) for v in rgb_[k])
        if c not in cache:
            cache[c] = fn(c)
        rgb_[k] = cache[c]
    return out


# ---------------------------------------------------------------- overlays
def delta(T, B):
    """(colour, alpha8) of a pixel that, drawn over colour B, gives T: the lowest alpha that can."""
    a = 0.0
    for t, b in zip(T, B):
        if t > b:
            a = max(a, (t - b) / (255 - b) if b < 255 else 1.0)
        elif t < b:
            a = max(a, (b - t) / b if b > 0 else 1.0)
    a8 = max(1, min(255, int(math.ceil(a * 255 - 1e-9))))
    af = a8 / 255
    c = tuple(int(max(0, min(255, round((t - (1 - af) * b) / af)))) for t, b in zip(T, B))
    return c, a8


def over(top, bottom):
    """Source-over composite of two RGBA tiles (straight alpha), rounded like a canvas."""
    a = top[:, :, 3:4].astype(np.float64) / 255
    b = bottom[:, :, 3:4].astype(np.float64) / 255
    oa = a + b * (1 - a)
    rgb_ = top[:, :, :3] * a + bottom[:, :, :3] * b * (1 - a)
    out = np.zeros_like(top)
    nz = oa[:, :, 0] > 0
    out[:, :, :3][nz] = np.round(rgb_[nz] / oa[nz]).astype(np.uint8)
    out[:, :, 3] = np.round(oa[:, :, 0] * 255).astype(np.uint8)
    return out


def classes(home, ground, under):
    """The pixel classes of a home tile over the plain ground tile `under` (boolean 16x16 masks):
    obj      object pixels (not a ground colour);
    tex      ground-coloured pixels equal to `under` there: the ground's own texture;
    att      ground-coloured pixels that differ from `under` and are joined to the object (8-neighbour chains
             touching it): shadows, the light rim beside a path or a beach;
    loose    any other ground-coloured pixel: a loose tuft, which the cell's ground replaces with its own."""
    H, W = home.shape[:2]
    cols = [[tuple(int(v) for v in home[y, x, :3]) for x in range(W)] for y in range(H)]
    opaque = home[:, :, 3] > 0
    isg = np.array([[opaque[y, x] and cols[y][x] in ground for x in range(W)] for y in range(H)])
    obj = opaque & ~isg
    same = (np.abs(home[:, :, :3].astype(int) - under[:, :, :3].astype(int)).max(2) == 0)
    cand = isg & ~same
    att = np.zeros((H, W), bool)
    stack = [(y, x) for y in range(H) for x in range(W) if obj[y, x]]
    while stack:
        y, x = stack.pop()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                yy, xx = y + dy, x + dx
                if 0 <= yy < H and 0 <= xx < W and cand[yy, xx] and not att[yy, xx]:
                    att[yy, xx] = True
                    stack.append((yy, xx))
    return {'obj': obj, 'tex': isg & same, 'att': att, 'loose': cand & ~att, 'cols': cols}


def split(home, ground, base, under):
    """The overlay of a home tile drawn on the plain ground tile `under` (classes() names the pixels): object
    pixels are kept; texture becomes transparent; attached pixels (shadows, rims) become delta pixels reproducing
    the home tile over the ground's plain colour `base`; loose tufts become transparent.
    Returns (overlay, object pixel count, delta pixel count)."""
    K = classes(home, ground, under)
    obj, att, cols = K['obj'], K['att'], K['cols']
    out = np.zeros_like(home)
    out[obj] = home[obj]
    for y, x in zip(*np.nonzero(att)):
        c, a8 = delta(cols[y][x], base)
        out[y, x] = (*c, a8)
    return out, int(obj.sum()), int(att.sum())


def ov_counts(ov, under, home, ground, base):
    """The overlay test (4.3), counted strictly: draw the overlay over its home ground `under` and compare with the
    home tile. Every differing pixel counts (beyond PIX_TOL in a channel, or a coverage change) except the loose
    tufts of classes(), which the cell's ground replaces by design: object pixels, shadows, rims and the ground's
    own texture all count, so a lost or wrong shadow or rim is seen, and so is ground texture showing through a
    see-through rim. Returns {'strict', 'loose', 'raw', 'through', 'plain'}: `through` is the strict pixels that
    are attached ones (texture of `under` seen through a shadow or rim); `plain` the overlay's non-transparent
    pixels that differ from the home tile when drawn over the plain colour `base` (must be 0: every shadow and
    rim pixel is exact over the plain ground)."""
    K = classes(home, ground, under)
    comp = over(ov, under)
    d = np.abs(comp[:, :, :3].astype(int) - home[:, :, :3].astype(int)).max(2) > PIX_TOL
    d |= (comp[:, :, 3] > 0) != (home[:, :, 3] > 0)
    flat = np.zeros_like(under)
    flat[:, :, :3] = base
    flat[:, :, 3] = 255
    cp = over(ov, flat)
    dp = (np.abs(cp[:, :, :3].astype(int) - home[:, :, :3].astype(int)).max(2) > PIX_TOL) & (ov[:, :, 3] > 0)
    return {'strict': int((d & ~K['loose']).sum()), 'loose': int((d & K['loose']).sum()), 'raw': int(d.sum()),
            'through': int((d & K['att']).sum()), 'plain': int(dp.sum())}


def ground_match(home, ground, under):
    """How many of the home tile's ground-coloured pixels differ from the plain ground tile `under`."""
    n = 0
    for y in range(16):
        for x in range(16):
            c = tuple(int(v) for v in home[y, x, :3])
            if home[y, x, 3] and c in ground and c != tuple(int(v) for v in under[y, x, :3]):
                n += 1
    return n


def differ(a, b):
    """Pixels whose colour differs by more than PIX_TOL in any channel (both tiles opaque where compared)."""
    return int((np.abs(a[:, :, :3].astype(int) - b[:, :, :3].astype(int)).max(2) > PIX_TOL).sum()
               + ((a[:, :, 3] > 0) != (b[:, :, 3] > 0)).sum())


# ---------------------------------------------------------------- quarter-tile composition
QUADS = ('tl', 'tr', 'bl', 'br')
# neighbour bits of a blob code: set when that neighbour is inside the blob
BITS = {'N': 1, 'E': 2, 'S': 4, 'W': 8, 'NE': 16, 'SE': 32, 'SW': 64, 'NW': 128}
QNB = {'tl': ('N', 'W', 'NW'), 'tr': ('N', 'E', 'NE'), 'bl': ('S', 'W', 'SW'), 'br': ('S', 'E', 'SE')}
# quarter state: 0 inside, 1 open above/below, 2 open beside, 3 outer corner, 4 inner corner
EDGE_PIECE = {'tl': {1: 't', 2: 'l', 3: 'tl'}, 'tr': {1: 't', 2: 'r', 3: 'tr'},
              'bl': {1: 'b', 2: 'l', 3: 'bl'}, 'br': {1: 'b', 2: 'r', 3: 'br'}}
QXY = {'tl': (0, 0), 'tr': (0, 8), 'bl': (8, 0), 'br': (8, 8)}     # (y0, x0)


def quarter_states(n):
    out = []
    for q in QUADS:
        v, h, d = (bool(n & BITS[k]) for k in QNB[q])
        out.append(3 if (not v and not h) else 1 if not v else 2 if not h else 4 if not d else 0)
    return tuple(out)


def blob_codes():
    """The 47 blob codes (quarter-state tuples) in a fixed order, and the 256-entry lookup from neighbour bits."""
    seen = sorted({quarter_states(n) for n in range(256)})
    assert len(seen) == 47, len(seen)
    idx = {s: i for i, s in enumerate(seen)}
    return [list(s) for s in seen], [idx[quarter_states(n)] for n in range(256)]


SETS = {
    'A': dict(tl=268, t=269, tr=270, l=276, c=277, r=278, bl=284, b=285, br=286, inner=(293, 294, 301, 302),
              inside='sand', outside='sea'),
    'B': dict(tl=469, t=470, tr=471, l=477, c=277, r=479, bl=485, b=486, br=487, inner=(488, 489, 490, 491),
              inside='sand', outside='ground'),
    'C': dict(tl=208, t=209, tr=210, l=216, c=217, r=218, bl=224, b=225, br=226, inner=(254, 255, 262, 263),
              inside='path', outside='ground'),
    'P': dict(tl=416, t=417, tr=418, l=424, c=425, r=426, bl=432, b=433, br=434, inner=None,
              inside='water', outside='ground'),
}
SNOW_BASE = GRASS_TO_SNOW[GRASS_BASE]
DESERT_BASE = GRASS_TO_SAND[GRASS_BASE]
OUTSIDE_BASE = {'grass': GRASS_BASE, 'snow': SNOW_BASE, 'sand': DESERT_BASE}


def with_rim(fn, ref, outside='grass'):
    """A sand recolour that also moves the light grass rim beside the sand (B, C) to 60% of the way from the outside
    ground to the recoloured sand, as FireRed's rim lies between its sand and its grass; with outside 'snow' or
    'sand' the grass pixels themselves become that ground (a path through snow or desert)."""
    new = fn(ref)
    rim = snap(tuple(int(round(0.6 * a + 0.4 * b)) for a, b in zip(new, OUTSIDE_BASE[outside])))
    g = ground_fn(outside) if outside != 'grass' else None
    def f(c):
        if c in GRASS_RIMS:
            return rim
        if g is not None and c in GRASS_RGB:
            return g(c)
        return fn(c)
    return f


# recolours of each set: name -> (colour function on the composed tile, material of the inside, ground of the outside)
SET_RECOLOURS = {
    'A': [('sand', None, 'sand'), ('snow', sand_fn('snow'), 'snow'), ('ice', sand_fn('ice'), 'ice'),
          ('ice_pond', lambda c: sand_fn('ice')(c) if is_sand(c) else sea_to_pond(c), 'ice')],
    'B': [('sand', None, 'sand'), ('snow', with_rim(sand_fn('snow'), BEACH_SAND[0]), 'snow'),
          ('mud', with_rim(sand_fn('mud'), BEACH_SAND[0]), 'mud')],
    'C': [('path', None, 'floor'), ('gravel', with_rim(sand_fn('gravel'), PATH_SAND[0]), 'floor'),
          ('dirt', with_rim(sand_fn('dirt'), PATH_SAND[0]), 'floor'), ('pale', with_rim(sand_fn('pale'), PATH_SAND[0]), 'floor'),
          ('gravel_snow', with_rim(sand_fn('gravel'), PATH_SAND[0], 'snow'), 'floor', 'snow'),
          ('pale_sand', with_rim(sand_fn('pale'), PATH_SAND[0], 'sand'), 'floor', 'sand')],
    'P': [('grass', None, 'water'), ('sand', rim_fn('sand'), 'water'), ('snow', rim_fn('snow'), 'water'),
          ('swamp', rim_fn('swamp'), 'water')],
}


class Pieces:
    """General metatile pixels (below, above) as the atlas holds them, with their world.json metadata."""

    def __init__(self, entries):
        self.e = entries

    def img(self, mid):
        return self.e[mid]['below']

    def top(self, mid):
        return self.e[mid]['above']

    def flat(self, mid):
        b, a = self.e[mid]['below'], self.e[mid]['above']
        t = b.copy()
        t[...] = np.where(a[:, :, 3:4] > 0, a, t)
        return t


def outside_colours(sid):
    return WATER_RGB if SETS[sid]['outside'] == 'sea' else set(GRASS_RGB) | set(GRASS_RIMS)


def check_set(P, sid):
    """Each edge piece must have its open side where its name says: the outer 4 rows (or columns) of a t, b, l or r
    piece are mostly the outside material, its inner side mostly not."""
    s = SETS[sid]
    outc = outside_colours(sid)
    def frac(mid, ys, xs):
        t = P.img(mid)
        px = [tuple(int(v) for v in t[y, x, :3]) for y in ys for x in xs]
        return sum(p in outc or (sid == 'P' and is_rock(p)) for p in px) / len(px)
    edge, inner = range(0, 3), range(8, 16)
    full = range(16)
    tests = {'t': (edge, full), 'b': (range(13, 16), full), 'l': (full, edge), 'r': (full, range(13, 16))}
    for k, (ys, xs) in tests.items():
        f = frac(s[k], ys, xs)
        assert f >= 0.4, (sid, k, s[k], f)
    # the centre piece has no outside pixels
    assert frac(s['c'], full, full) == 0, (sid, 'centre')


def inner_map(P, sid):
    """Which inner piece has which corner open: the corner (4x4) with the most pixels unlike the centre's."""
    s = SETS[sid]
    out = {}
    c0 = P.img(s['c']).astype(int)
    for mid in s['inner']:
        t = P.img(mid).astype(int)
        best, bq = -1, None
        for q, (y0, x0) in (('tl', (0, 0)), ('tr', (0, 12)), ('bl', (12, 0)), ('br', (12, 12))):
            reg = np.abs(t[y0:y0 + 4, x0:x0 + 4, :3] - c0[y0:y0 + 4, x0:x0 + 4, :3]).sum(2)
            n = int((reg > 60).sum())
            if n > best:
                best, bq = n, q
        assert bq not in out, (sid, mid, bq, out)
        out[bq] = mid
    assert len(out) == 4, (sid, out)
    return out


def synth_inner(P, sid, q):
    """An inner-corner quarter for a set FireRed draws without inner corners (P): the centre's quarter with the
    rims of the two neighbouring edges carried into the corner until they meet. The side edge's rim (running
    vertically) is carried as many rows as the top or bottom edge's rim is deep at the corner, and that rim as
    many columns as the side rim is wide, so the two close the corner and neither runs past the other."""
    s = SETS[sid]
    y0, x0 = QXY[q]
    cen = P.img(s['c'])[y0:y0 + 8, x0:x0 + 8].copy()
    vert = P.img(s['l' if q[1] == 'l' else 'r'])[y0:y0 + 8, x0:x0 + 8]     # the side edge, rim running vertically
    horz = P.img(s['t' if q[0] == 't' else 'b'])[y0:y0 + 8, x0:x0 + 8]     # the top or bottom edge, rim horizontal
    cy, sy = (0, 1) if q[0] == 't' else (7, -1)            # the corner pixel and the inward steps
    cx, sx = (0, 1) if q[1] == 'l' else (7, -1)
    def depth(img, y, x, dy, dx):
        n = 0
        while 0 <= y < 8 and 0 <= x < 8 and not np.array_equal(img[y, x], cen[y, x]):
            n, y, x = n + 1, y + dy, x + dx
        return n
    kh = depth(horz, cy, cx, sy, 0)                         # how deep the horizontal rim is at the corner
    kv = depth(vert, cy, cx, 0, sx)                         # how wide the vertical rim is at the corner
    out = cen.copy()
    for y in (cy + sy * i for i in range(kh)):
        for x in range(8):
            if not np.array_equal(vert[y, x], cen[y, x]):
                out[y, x] = vert[y, x]
    for x in (cx + sx * i for i in range(kv)):
        for y in range(8):
            if not np.array_equal(horz[y, x], cen[y, x]):
                out[y, x] = horz[y, x]
    return out


def compose(P, sid, states, inners):
    """The composed (below, above) tiles of a blob code."""
    s = SETS[sid]
    below = np.zeros((16, 16, 4), np.uint8)
    above = np.zeros((16, 16, 4), np.uint8)
    for q, st in zip(QUADS, states):
        y0, x0 = QXY[q]
        if st == 0:
            mid = s['c']
        elif st == 4:
            if inners is None:
                below[y0:y0 + 8, x0:x0 + 8] = synth_inner(P, sid, q)
                above[y0:y0 + 8, x0:x0 + 8] = P.top(s['c'])[y0:y0 + 8, x0:x0 + 8]
                continue
            mid = inners[q]
        else:
            mid = s[EDGE_PIECE[q][st]]
        below[y0:y0 + 8, x0:x0 + 8] = P.img(mid)[y0:y0 + 8, x0:x0 + 8]
        above[y0:y0 + 8, x0:x0 + 8] = P.top(mid)[y0:y0 + 8, x0:x0 + 8]
    return below, above


# ---------------------------------------------------------------- learned rock and ledge tables
_W3 = [1, 3, 1, 3, 0, 3, 1, 3, 1]


def _dist3(a, b):
    return sum(w for i, w in enumerate(_W3) if ((a >> (8 - i)) & 1) != ((b >> (8 - i)) & 1))


def learn_tables(member):
    """autotile.learn's method for any General family: {r: {key: Counter(mid)}} and the same with the ground
    context, from every outdoor FireRed map on the General primary tileset."""
    tables = {r: defaultdict(Counter) for r in (1, 2)}
    tables_g = {r: defaultdict(Counter) for r in (1, 2)}
    # in map-id order, so ties in most_common do not depend on the order the filesystem lists FireRed's maps.
    # (The rock tables come from autotile.learn, which keeps the listing order: they are tied to the committed
    # autotile.json, which build() asserts they equal.)
    for _, grid in sorted(AT.training_maps(), key=lambda m: m[0]):
        mask = np.vectorize(member)(grid)
        H, W = grid.shape
        for y, x in zip(*np.nonzero(mask)):
            t = int(grid[y, x])
            g = AT.local_ground(grid, x, y)
            for r in (1, 2):
                k = AT.keyof(mask, x, y, r)
                tables[r][k][t] += 1
                tables_g[r][(k, g)][t] += 1
    return tables, tables_g


def export_tables(tables, tables_g, members, compat_ids=None, px=False):
    out = {'members': sorted(int(m) for m in members)}
    for r in (2, 1):
        out[f'r{r}'] = {str(k): [int(c) for c, _ in v.most_common(3)] for k, v in tables[r].items()}
        out[f'g{r}'] = {f'{k}|{g}': [int(c) for c, _ in v.most_common(3)] for (k, g), v in tables_g[r].items()}
    seen = list(tables[1])
    fill = {}
    for n in range(256):
        k = ((n >> 4) << 5) | (1 << 4) | (n & 15)        # the centre bit set, the 8 neighbours from n
        if k in tables[1]:
            continue
        best = min(seen, key=lambda s: (_dist3(s, k), -sum(tables[1][s].values()), s))
        fill[str(k)] = [int(c) for c, _ in tables[1][best].most_common(3)]
    out['fill'] = fill
    out['compat'] = {str(m): [int(AT.ground_pixels(m)[0] > 0), int(AT.ground_pixels(m)[1] > 0)]
                     for m in sorted(compat_ids if compat_ids is not None else out['members'])}
    if px:
        # the generator's ground flags (stage 3b fix): compat counts autotile.py's narrow colour sets (it must equal
        # autotile.json's, which Classic's reedgeCliffs reads), so it misses the beach sand FireRed draws under
        # rock corners and feet (154, 160, 162, 168, 170 ...). px counts every grass, rim and sand colour here;
        # the painter shows such a piece as its overlay (the cell's own ground) when the ground disagrees
        out['px'] = {str(m): [int(v > 0) for v in ground_px(m)]
                     for m in sorted(compat_ids if compat_ids is not None else out['members'])}
    return out


def ground_px(mid):
    """(grass pixel count, sand pixel count) of a General metatile, with build_terrain's full colour sets."""
    AT.ground_pixels(mid)                                       # makes autotile.py's renderer
    b, _ = AT._R.render(mid)
    px = [tuple(int(v) for v in p) for p in b[:, :, :3].reshape(-1, 3)]
    g = set(GRASS_RGB) | set(GRASS_RIMS)
    return sum(p in g for p in px), sum(p in SAND_RGB for p in px)


def learned(P, ledge_ids):
    """The rock (mountain) and ledge tables. The rock ones must equal autotile.json's (world.reedgeCliffs)."""
    rock_t, rock_g = AT.learn('mountain')
    rock = export_tables(rock_t, rock_g, [m for m in AT.MOUNTAIN_IDS if AT.is_mountain(m)], AT.MOUNTAIN_IDS, px=True)
    lset = set(ledge_ids)
    ledge = export_tables(*learn_tables(lambda m: int(m) in lset), ledge_ids, px=True)
    return {'rock': rock, 'ledge': ledge}


def keyof(mask, x, y, r):
    """The (2r+1)^2 membership key of a cell, row-major, cells past the edge clamped (autotile.keyof)."""
    H, W = mask.shape
    bits = 0
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            yy, xx = min(H - 1, max(0, y + dy)), min(W - 1, max(0, x + dx))
            bits = (bits << 1) | int(mask[yy, xx])
    return bits


def lookup(T, k2, k1, g, classic=False):
    """The learned piece for a cell: 5x5 with the ground context, 5x5, 3x3 with the context, 3x3 (the order
    world.reedgeCliffs uses), then the nearest learned 3x3 (`fill`). A candidate whose ground pixels disagree with
    the context ('g' grass, 's' sand) is skipped while another remains; if every candidate is skipped and the fill
    has none, the first skipped one is returned. Returns (mid, level 0..2), or (None, 3).
    classic=True mirrors world.reedgeCliffs exactly as it is today: no fill and no skipped-candidate fallback, so a
    pattern FireRed never draws gives (None, 3) and the cell is left as it is. The generator's painter (stage 3b)
    uses the full lookup; reedgeCliffs may only use the fill and the fallback when world.layout.gen, since Classic
    players can make unseen patterns by mining."""
    first = None
    for level, (r, k) in enumerate(((2, k2), (1, k1))):
        for cands in (T[f'g{r}'].get(f'{k}|{g}'), T[f'r{r}'].get(str(k))):
            for c in cands or ():
                cp = T['compat'].get(str(c))
                if first is None:
                    first = (c, level)
                if cp and ((g == 's' and cp[0]) or (g == 'g' and cp[1])):
                    continue
                return c, level
    if classic:
        return None, 3
    for c in T['fill'].get(str(k1), ()):
        return c, 2
    return first if first is not None else (None, 3)


def paint_learned(T, mask, ctx):
    """Paint a boolean mask with a learned table; ctx: per cell 'g' or 's'. Returns (mids, levels); -1 off-mask."""
    H, W = mask.shape
    out = np.full((H, W), -1, np.int32)
    lv = np.zeros((H, W), np.int8)
    for y, x in zip(*np.nonzero(mask)):
        m, l = lookup(T, keyof(mask, x, y, 2), keyof(mask, x, y, 1), ctx[y][x] if not isinstance(ctx, str) else ctx)
        out[y, x] = -1 if m is None else m
        lv[y, x] = l
    return out, lv


def misses(T):
    """Patterns a lookup cannot answer after the fill: every 3x3 pattern with its centre set, both contexts."""
    n = 0
    for nb in range(256):
        k = ((nb >> 4) << 5) | (1 << 4) | (nb & 15)
        if not (T['r1'].get(str(k)) or T['fill'].get(str(k))):
            n += 1
    return n


# ---------------------------------------------------------------- the builder
class Bank:
    def __init__(self, entries):
        assert len(entries) == GEN_BASE, f'world.json has {len(entries)} entries, terrain expects {GEN_BASE}'
        self.P = Pieces(entries)
        self.E = entries
        self.rows, self.below, self.above = [], [], []
        self.ventry = defaultdict(dict)        # var -> {src mid: entry}  (home looks)
        self.ovl = defaultdict(dict)           # var -> {src mid: entry}  (overlays)
        self.home, self.home_ground = {}, {}
        self.variants = [None]                 # var id -> record (0: General's own colours)
        self.var_ix = {}
        self.ov_report = []                    # (entry, src, var, differing pixels (texture excluded), all, delta pixels)
        self.ground_sets, self.ov_fam = {}, {}

    def var(self, name, **rec):
        if name not in self.var_ix:
            self.var_ix[name] = len(self.variants)
            self.variants.append({'id': len(self.variants), 'name': name, **rec})
        return self.var_ix[name]

    def meta(self, mid):
        e = self.E[mid]
        return e['beh'], e['col'], e['mat'], e['enc']

    def add(self, below, above, mid, beh, col, mat, enc, vsrc, var, ov):
        i = GEN_BASE + len(self.rows)
        above = above if above is not None else np.zeros((16, 16, 4), np.uint8)
        self.rows.append([int(mid), -1, int(beh), int(col), mat, -1, int(above[:, :, 3].any()), int(enc), int(vsrc),
                          int(var), int(ov)])
        self.below.append(below)
        self.above.append(above)
        return i

    def pixels(self, i):
        """(below, above) of any entry, General or generated."""
        if i < GEN_BASE:
            return self.E[i]['below'], self.E[i]['above']
        return self.below[i - GEN_BASE], self.above[i - GEN_BASE]

    def variant_of(self, mid, var, fn):
        """A recoloured General piece (both layers)."""
        b, a = self.P.img(mid), self.P.top(mid)
        beh, col, mat, enc = self.meta(mid)
        i = self.add(recolour(b, fn), recolour(a, fn), mid, beh, col, mat, enc, mid, var, 0)
        self.ventry[var][mid] = i
        return i

    def overlay_of(self, home, src_mid, var, ground, base, grounds, mat=None, beh=None, col=None, enc=None, fam='grass'):
        """The overlay entry of a home entry, tested over the plain ground entry (of `grounds`) its ground matches best:
        ov_counts() gives the strict count (the 3% test) and the raw one."""
        hb, ha = self.pixels(home)
        def plain_colour(g):
            return Counter(tuple(int(v) for v in p[:3]) for p in self.pixels(g)[0].reshape(-1, 4)).most_common(1)[0][0]
        same_base = [g for g in grounds if plain_colour(g) == tuple(base)]
        assert same_base, ('no plain ground of colour', base, grounds)
        # the home ground: the plain ground under which the overlay reproduces its home best (fewest differing
        # pixels of any kind, then fewest counted ones). FireRed builds its pieces from shared 8x8 tiles, so for most
        # pieces this is the very ground tile the piece was drawn on.
        def score(g):
            u = self.pixels(g)[0]
            c = ov_counts(split(hb, ground, base, u)[0], u, hb, ground, base)
            return (c['raw'], c['strict'], ground_match(hb, ground, u), g)
        bg = min(same_base, key=score)
        under = self.pixels(bg)[0]
        ov, nobj, ndelta = split(hb, ground, base, under)
        if nobj == 0 and not ha[:, :, 3].any():
            return None                         # nothing but ground: the plain ground itself serves
        gkey = f'{var}|{fam}'
        if gkey not in self.ground_sets:
            self.ground_sets[gkey] = sorted(ground)
        cnt = ov_counts(ov, under, hb, ground, base)
        if src_mid >= 0:
            m_beh, m_col, m_mat, m_enc = self.meta(src_mid)
        else:
            m_beh, m_col, m_mat, m_enc = self.rows[home - GEN_BASE][2], self.rows[home - GEN_BASE][3], \
                self.rows[home - GEN_BASE][4], self.rows[home - GEN_BASE][7]
        i = self.add(ov, ha, src_mid, m_beh if beh is None else beh, m_col if col is None else col,
                     m_mat if mat is None else mat, m_enc if enc is None else enc, home, var, 1)
        self.home[i] = home
        self.home_ground[i] = bg
        self.ov_report.append((i, src_mid, var, cnt['strict'], cnt['raw'], ndelta, cnt['loose'], cnt['through'],
                               cnt['plain']))
        self.ov_fam[i] = gkey
        if src_mid >= 0:
            self.ovl[var][src_mid] = i
        return i

    def sprite_overlay(self, home, sprite, ground, var, name):
        """A decoration sprite's overlay: the sprite's own pixels (opaque), the home entry's top layer and metadata,
        tested like every overlay over its home ground (the plain ground it was drawn on)."""
        hb, ha = self.pixels(home)
        under = self.pixels(ground)[0]
        gset = {tuple(int(v) for v in p[:3]) for p in under.reshape(-1, 4)}
        base = Counter(tuple(int(v) for v in p[:3]) for p in under.reshape(-1, 4)).most_common(1)[0][0]
        r = self.rows[home - GEN_BASE]
        i = self.add(sprite, ha, -1, r[2], r[3], r[4], r[7], home, var, 1)
        cnt = ov_counts(sprite, under, hb, gset, base)
        gkey = f'{var}|sprite_{name}'
        self.ground_sets[gkey] = sorted(gset)
        self.ov_fam[i] = gkey
        self.home[i] = home
        self.home_ground[i] = ground
        self.ov_report.append((i, -1, var, cnt['strict'], cnt['raw'], 0, cnt['loose'], cnt['through'], cnt['plain']))
        return i


def vocabulary(entries, grid_outdoor):
    """The General mid lists the generator uses, each id checked against its behaviour and material."""
    E = entries
    beh = lambda m: E[m]['beh']
    mat = lambda m: E[m]['mat']
    V = {}
    def take(name, ids, behs=None, mats=None):
        ids = sorted(int(m) for m in ids)
        for m in ids:
            assert behs is None or beh(m) in behs, (name, m, hex(beh(m)))
            assert mats is None or mat(m) in mats, (name, m, mat(m))
        V[name] = ids
    take('grass', (1, 8, 9, 16, 17), {0}, {'floor'})
    take('tallGrass', (13,), {0x02}, {'tallgrass'})
    take('tallGrassBase', (10, 11, 12), {0x02}, {'tallgrass'})
    take('flower', (4,), {0}, {'flower'})
    take('bush', (5,), {0}, {'bush'})
    take('treeTip', (14, 15), None, {'tree'})
    take('treeOverlap', (20, 21, 22, 23), None, {'tree'})
    take('treeCrown', (28, 29, 30, 31), None, {'tree'})
    take('treeBase', (36, 37, 38, 39), None, {'tree'})
    rock = [m for m in AT.MOUNTAIN_IDS if AT.is_mountain(m) and mat(m) == 'rock']
    take('rock', rock, None, {'rock'})
    take('caveMouth', (169,), {0x60}, {'door'})
    take('boulder', (159, 175, 183), None, {'boulder'})
    take('ledge', [m for m in range(640) if beh(m) in (0x38, 0x39, 0x3A, 0x3B)], {0x38, 0x39, 0x3A, 0x3B}, {'ledge'})
    paths = [m for m in list(range(208, 230)) + [254, 255, 262, 263] if mat(m) == 'floor']
    take('sandPath', paths, {0}, {'floor'})
    take('mountainPath', (188, 126, 127), {0}, {'sandstone', 'rock'})
    take('sand', [m for m in range(640) if beh(m) == 0x21 and mat(m) == 'sand'], {0x21}, {'sand'})
    take('shallow', [m for m in range(640) if beh(m) == 0x17 and mat(m) == 'water'], {0x17}, {'water'})
    take('sea', [m for m in range(640) if beh(m) == 0x15 and mat(m) == 'water'], {0x15}, {'water'})
    # FireRed's darker water (0x11, its Sevii currents) is 'water_rock' in world.json; Kanto's outdoor block never uses it
    take('deep', [m for m in range(640) if beh(m) == 0x11], {0x11}, {'water', 'water_rock'})
    take('deepPlain', [m for m in V['deep'] if all(is_water(tuple(int(v) for v in p[:3])) for p in E[m]['below'].reshape(-1, 4))],
         {0x11}, None)
    take('pond', [m for m in range(640) if beh(m) == 0x16 and mat(m) == 'water'], {0x16}, {'water'})
    take('pondRock', [m for m in range(640) if beh(m) == 0x10], {0x10}, None)
    # plain grounds: every General piece drawn only in grass (or only in sand) colours; an overlay's home ground
    # is the one of these its own ground matches best (FireRed builds its pieces from shared 8x8 tiles)
    def plain(colours, mats):
        out = []
        # behaviour 0 (or sand's 0x21) only: no trigger tiles
        for m in range(640):
            t = E[m]['below']
            px = [tuple(int(v) for v in p[:3]) for p in t.reshape(-1, 4) if p[3]]
            if len(px) == 256 and not E[m]['above'][:, :, 3].any() and mat(m) in mats and beh(m) in (0, 0x21) \
                    and all(p in colours for p in px):
                out.append(m)
        return out
    take('grassPlain', plain(set(GRASS_RGB), {'floor'}), None, {'floor'})
    take('sandPlain', plain(SAND_RGB, {'floor', 'sand', 'sandstone'}), {0, 0x21}, {'floor', 'sand', 'sandstone'})
    # the design's named pieces must be among them
    for name, ids in (('sand', (277, 269)), ('sea', (299,)), ('pond', (416, 417, 418, 424, 425, 426, 432, 433, 434)),
                      ('sandPath', (208, 209, 210, 216, 217, 218, 224, 225, 226, 254, 255, 262, 263))):
        missing = set(ids) - set(V[name])
        assert not missing, (name, missing)
    return V


def water_tile(entries, grid):
    """G.waterTile's rule (main.js): the commonest 'water' entry with no top layer, sampling every 7th outdoor cell."""
    flat = grid.reshape(-1)
    n = 408 * 400
    c = Counter()
    for i in range(0, n, 7):
        t = int(flat[i])
        if entries[t]['mat'] == 'water' and not entries[t]['above'][:, :, 3].any():
            c[t] += 1
    # Map iteration order then sort by count (JS sort is stable): ties keep first-seen order
    return max(c.items(), key=lambda kv: kv[1])[0] if c else 299


# ================================================================ part 2 (stage 2b): species, synthesized tiles, ores
MCTEX = HERE / 'vendor' / 'minecraft' / 'jar' / 'assets' / 'minecraft' / 'textures' / 'block'
TREE_MIDS = (14, 15, 20, 21, 22, 23, 28, 29, 30, 31, 36, 37, 38, 39)   # every piece world.treeTileFor can return
TREE_ABOVE = (14, 15, 20, 21)          # General draws these pieces' tree pixels in the top layer too (walk-behind)
# forest configurations (tree slots (lx, cy) on a 6x6 cell field) and the cell each lattice piece is cut from;
# treeTileFor's rule on that configuration must give that piece (asserted)
LATTICE = (
    ([(2, 2)], {14: (2, 1), 15: (3, 1), 30: (2, 2), 31: (3, 2), 38: (2, 3), 39: (3, 3)}),
    ([(0, 2), (2, 2), (4, 2)], {28: (2, 2), 29: (3, 2), 36: (2, 3), 37: (3, 3)}),
    ([(2, 2), (2, 4)], {22: (2, 3), 23: (3, 3)}),
    ([(0, 2), (2, 2), (4, 2), (0, 4), (2, 4), (4, 4)], {20: (2, 3), 21: (3, 3)}),
)
LEAF_RGB = {(57, 148, 49), (131, 213, 98), (189, 255, 139), (57, 82, 0), (57, 115, 24), (57, 90, 16)}
TRUNK_RGB = {(115, 98, 98), (65, 57, 49), (98, 65, 74), (131, 106, 82)}
SNOW_HALO = (150, 172, 205)            # a tree's dark shadow ring (24, 164, 106) on snow
# species (3.8): shape, leaf pull (target hue, pull, saturation, value), wood, home ground
SPECIES = [
    ('oak', 'kanto', None, 'oak', 'grass'),
    ('round_oak', 'round', None, 'oak', 'grass'),
    ('birch', 'round', (104, 0.4, 0.8, 1.06), 'birch', 'grass'),
    ('dark_oak', 'round', (128, 0.4, 1.0, 0.62), 'dark_oak', 'grass'),
    ('spruce', 'kanto', (170, 0.6, 0.72, 0.80), 'spruce', 'grass'),
    ('snowy_spruce', 'kanto', (170, 0.6, 0.72, 0.80), 'spruce', 'snow'),
    ('acacia', 'acacia', (62, 0.5, 0.9, 0.86), 'acacia', 'grass'),
    ('jungle', 'round', (112, 0.7, 1.15, 0.88), 'jungle', 'grass'),
    ('swamp_oak', 'round', (84, 0.7, 0.62, 0.64), 'oak', 'grass'),
]


def tree_tile_for(slots, lx, y, left):
    """world.treeTileFor on a set of slots (the runtime's rule, for the lattice assertion)."""
    s = lambda a, b: (a, b) in slots
    if s(lx, y):
        return (28 if s(lx - 2, y) else 30) if left else (29 if s(lx + 2, y) else 31)
    above, below = s(lx, y - 1), s(lx, y + 1)
    if above and below:
        return (20 if s(lx - 2, y - 1) and s(lx - 2, y + 1) else 22) if left else \
            (21 if s(lx + 2, y - 1) and s(lx + 2, y + 1) else 23)
    if above:
        return (36 if s(lx - 2, y - 1) else 38) if left else (37 if s(lx + 2, y - 1) else 39)
    if below:
        return 14 if left else 15
    return None


def mc_tex(name):
    return np.array(Image.open(MCTEX / f'{name}.png').convert('RGBA'))[:16, :16]


def gba(t):
    o = t.copy()
    o[:, :, :3] = (o[:, :, :3] >> 3 << 3) | (o[:, :, :3] >> 5)
    return o


def keep_attached(img):
    """A sprite from a picture drawn on FireRed's grass: its object pixels and the grass-coloured pixels joined to them
    through other non-base grass colours (shadow halos); the plain grass colour and loose tufts become transparent."""
    H, W = img.shape[:2]
    cols = [[tuple(int(v) for v in img[y, x, :3]) for x in range(W)] for y in range(H)]
    obj = np.array([[img[y, x, 3] > 0 and cols[y][x] not in GRASS_RGB for x in range(W)] for y in range(H)])
    cand = np.array([[img[y, x, 3] > 0 and cols[y][x] in GRASS_RGB and cols[y][x] != GRASS_BASE for x in range(W)]
                     for y in range(H)])
    keep = obj.copy()
    stack = [(y, x) for y in range(H) for x in range(W) if obj[y, x]]
    while stack:
        y, x = stack.pop()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                yy, xx = y + dy, x + dx
                if 0 <= yy < H and 0 <= xx < W and cand[yy, xx] and not keep[yy, xx]:
                    keep[yy, xx] = True
                    stack.append((yy, xx))
    out = img.copy()
    out[~keep] = 0
    return out


def paint_line(c, pts, col):
    for x, y in pts:
        if 0 <= y < c.shape[0] and 0 <= x < c.shape[1]:
            c[y, x] = (*col, 255)


def round_sprite(P, vf):
    """Viridian Forest's 3-wide round tree as a 2-wide one for Kanto's lattice: its 48x48 picture without the middle
    16 columns (the tree is mirror-symmetric, so the two halves meet), the trunk band taken from the centre. The
    vertical phase is already Kanto's: VF's top row is the tip row, its middle row the crown, its shadow row the base."""
    C = np.zeros((48, 48, 4), np.uint8)
    for y, row in enumerate(((648, 665, 650), (672, 673, 674), (675, 676, 677))):
        for x, m in enumerate(row):
            C[y * 16:y * 16 + 16, x * 16:x * 16 + 16] = P.flat(vf[m])
    D = np.concatenate([C[:, :16], C[:, 32:]], 1)
    D[30:38, 12:20] = C[30:38, 20:28]
    return keep_attached(D)


def leaf_fn(p, extra=None):
    def f(c):
        if extra and c in extra:
            return extra[c]
        if c in LEAF_RGB:
            return snap(pull(c, p)) if p else c
        return c
    return f


def vines(S, xs, colours, seed, lo=3, span=5):
    """Hanging vine strands below the crown's lower edge at columns xs, lo to lo + span - 1 pixels long (FireRed
    shading: a dark stem with lighter leaf pixels)."""
    dark, light = colours
    for k, x in enumerate(xs):
        col = S[:32, x]
        rows = [y for y in range(32) if col[y, 3] and tuple(int(v) for v in col[y, :3]) not in GRASS_RGB
                and tuple(int(v) for v in col[y, :3]) != (24, 164, 106)]
        if not rows:
            continue
        y0 = max(rows) - 1
        n = lo + (seed * 7 + k * 5) % span
        for i in range(n):
            S[y0 + i, x] = (*dark, 255)
            if i % 2 == 1 and x + 1 < 32:
                S[y0 + i, x + 1] = (*light, 255)
        S[y0 + n, x] = (*light, 255)


def trunk_fix(S, kind):
    """Trunk looks: birch white with black marks, jungle thick and dark, dark oak darker."""
    T = S.copy()
    for y in range(30, 40):
        for x in range(32):
            c = tuple(int(v) for v in S[y, x, :3])
            if not S[y, x, 3] or c not in TRUNK_RGB:
                continue
            if kind == 'birch':
                T[y, x, :3] = {(98, 65, 74): (238, 238, 230), (131, 106, 82): (255, 255, 246)}.get(c, (49, 49, 49))
            elif kind == 'dark_oak':
                T[y, x, :3] = {(98, 65, 74): (65, 41, 32), (131, 106, 82): (90, 65, 41)}.get(c, (32, 24, 16))
            elif kind == 'jungle':
                T[y, x, :3] = {(98, 65, 74): (98, 74, 41), (131, 106, 82): (123, 98, 57)}.get(c, (49, 41, 24))
    if kind == 'birch':                                  # Minecraft's black marks across the white bark
        for x, y in ((14, 33), (15, 33), (17, 35), (18, 35), (16, 37)):
            if tuple(int(v) for v in T[y, x, :3]) in ((238, 238, 230), (255, 255, 246)):
                T[y, x, :3] = (49, 49, 49)
    if kind == 'jungle':                                 # a thicker trunk: one more bark column each side
        for y in range(31, 38):
            row = [x for x in range(32) if tuple(int(v) for v in T[y, x, :3]) in ((98, 74, 41), (123, 98, 57))]
            if row:
                a, b = min(row), max(row)
                T[y, a - 2] = (49, 41, 24, 255)
                T[y, a - 1] = (123, 98, 57, 255)
                T[y, b + 1] = (98, 74, 41, 255)
                T[y, b + 2] = (49, 41, 24, 255)
    return T


def acacia_sprite(R, p):
    """Savanna's acacia: a new flat-topped crown on a bent, forked trunk, drawn with the round tree's leaf clumps and
    FireRed's three-step shading (light top, mid body, dark underside, dark outline)."""
    S = np.zeros((48, 32, 4), np.uint8)
    for y in range(34, 48):                               # a flat shadow under the wide crown, in the round tree's colours
        for x in range(32):
            d = ((x - 15.5) / 14.5) ** 2 + ((y - 41.5) / 4.6) ** 2
            if d < 1.3:
                S[y, x] = (*((57, 115, 24) if d < 0.5 else (57, 148, 49) if d < 0.85 else (24, 164, 106) if d < 1.05
                             else (65, 180, 139)), 255)
    bark = ((65, 57, 49), (106, 98, 90), (148, 139, 123))
    # trunk: up from the foot, bending right, with a branch forking left
    path = [(15, y) for y in range(43, 34, -1)] + [(16, 34), (16, 33), (17, 32), (17, 31), (18, 30), (18, 29), (18, 28),
                                                  (19, 27), (19, 26), (19, 25), (19, 24)]
    branch = [(16, 33), (15, 32), (14, 31), (13, 30), (12, 29), (11, 28), (10, 27), (10, 26), (9, 25), (9, 24)]
    for x, y in path:                                     # 3 wide: dark edge, light middle, mid right side
        S[y, x - 1], S[y, x], S[y, x + 1] = (*bark[0], 255), (*bark[2], 255), (*bark[1], 255)
    for x, y in branch:                                   # 2 wide: light, dark underside
        S[y, x], S[y, x + 1] = (*bark[2], 255), (*bark[0], 255)
    for x, y in path:                                     # the trunk's own right edge stays dark over the branch
        S[y, x + 2] = (*bark[0], 255) if not S[y, x + 2, 3] or tuple(int(v) for v in S[y, x + 2, :3]) in bark[1:] else S[y, x + 2]
    # the crown: a flat umbrella, rows 9..22, three lobes on top, its underside notched where the branches meet it
    half = {9: [(4, 9), (13, 19), (23, 27)], 10: [(2, 11), (11, 21), (21, 29)], 11: [(1, 30)], 12: [(0, 31)],
            13: [(0, 31)], 14: [(0, 31)], 15: [(0, 31)], 16: [(0, 31)], 17: [(0, 31)], 18: [(1, 30)], 19: [(1, 30)],
            20: [(2, 29)], 21: [(4, 12), (19, 27)], 22: [(6, 10), (21, 25)]}
    m = np.zeros((48, 32), bool)
    for y, spans in half.items():
        for a, b in spans:
            m[y, a:b + 1] = True
    tex = R[6:22].copy()                                  # the round tree's clumps as the crown's texture
    for y in range(48):
        for x in range(32):
            if m[y, x]:
                c = tuple(int(v) for v in tex[(y - 9) % 16, x, :3])
                if c not in LEAF_RGB:
                    c = (131, 213, 98)
                S[y, x] = (*snap(pull(c, p)), 255)
    for y in range(48):                                   # shading: the underside dark, the outline darker
        for x in range(32):
            if not m[y, x]:
                continue
            below = y + 1 >= 48 or not m[y + 1, x]
            edge = any(not (0 <= y + dy < 48 and 0 <= x + dx < 32 and m[y + dy, x + dx])
                       for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
            if edge:
                S[y, x, :3] = snap(pull((57, 82, 0), p))
            elif below or (y + 2 < 48 and not m[y + 2, x]):
                S[y, x, :3] = snap(pull((57, 115, 24), p))
            elif y <= 11 and tuple(int(v) for v in S[y, x, :3]) == snap(pull((131, 213, 98), p)):
                S[y, x, :3] = snap(pull((189, 255, 139), p))
    return S


def render_forest(P, sprite, slots, ground_mid=1):
    """A 6x6 cell field of plain ground with the trees of `slots` drawn upper ones first (a lower tree's tip covers
    the trunk and shadow of the tree above it). Returns the picture and the mask of tree pixels."""
    c = np.zeros((96, 96, 4), np.uint8)
    for y in range(6):
        for x in range(6):
            c[y * 16:y * 16 + 16, x * 16:x * 16 + 16] = P.img(ground_mid)
    objm = np.zeros((96, 96), bool)
    for lx, cy in sorted(slots, key=lambda s: (s[1], s[0])):
        x0, y0 = lx * 16, (cy - 1) * 16
        reg = sprite[max(0, -y0):, :]
        y0 = max(0, y0)
        h = min(reg.shape[0], 96 - y0)
        reg = reg[:h]
        a = reg[:, :, 3] > 0
        c[y0:y0 + h, x0:x0 + 32][a] = reg[a]
        objm[y0:y0 + h, x0:x0 + 32] |= a
    return c, objm


def sprite_pieces(P, sprite, ground_mid=1):
    """The 14 lattice pieces of a tree sprite: {mid: (below, above)}; pieces General draws with a top layer get the
    tree's pixels in theirs too."""
    out = {}
    for slots, cut in LATTICE:
        c, objm = render_forest(P, sprite, set(slots), ground_mid)
        for mid, (x, y) in cut.items():
            assert tree_tile_for(set(slots), x if mid % 2 == 0 else x - 1, y, mid % 2 == 0) == mid, (mid, slots)
            b = c[y * 16:y * 16 + 16, x * 16:x * 16 + 16].copy()
            a = np.zeros_like(b)
            if mid in TREE_ABOVE:
                om = objm[y * 16:y * 16 + 16, x * 16:x * 16 + 16]
                isg = np.array([[tuple(int(v) for v in b[yy, xx, :3]) in GRASS_RGB for xx in range(16)] for yy in range(16)])
                a[om & ~isg] = b[om & ~isg]
            out[mid] = (b, a)
    assert sorted(out) == sorted(TREE_MIDS)
    return out


def species_bank(B, P, V, styles, quarter, vf):
    """Every species' 14 lattice pieces (3.8): a home look on its home ground and an overlay for any other ground."""
    grass_g = set(GRASS_RGB) | set(GRASS_RIMS)
    snow_v = styles['snowy']['var']
    snow_plain = [quarter['sets']['B']['recolours']['snow']['home'][0]] + [B.ventry[snow_v][g] for g in V['grassPlain']]
    snow_g = set(GRASS_TO_SNOW.values()) | set(SAND_SNOW_COLOURS) | {SNOW_HALO}
    R = round_sprite(P, vf)
    rec = {}
    for name, shape, p, wood, ground in SPECIES:
        if name == 'oak':
            rec[name] = {'var': 0, 'shape': shape, 'wood': wood, 'ground': ground,
                         'home': {str(m): m for m in TREE_MIDS}, 'ov': {str(m): B.ovl[0][m] for m in TREE_MIDS}}
            continue
        v = B.var(f'tree_{name}', kind='species', species=name, ground=ground, grass=False)
        if shape == 'kanto':
            extra = {(189, 255, 139): (255, 255, 255)} if name == 'snowy_spruce' else None
            lf = leaf_fn(p, extra)
            trunk = {(115, 98, 98): (90, 65, 57)}
            if ground == 'snow':
                gmap = dict(GRASS_TO_SNOW)
                gmap[(24, 164, 106)] = SNOW_HALO
                fn = lambda c, lf=lf, gmap=gmap: gmap.get(c) or trunk.get(c) or lf(c)
            else:
                fn = lambda c, lf=lf: trunk.get(c) or lf(c)
            homes = {m: B.variant_of(m, v, fn) for m in TREE_MIDS}
        else:
            if shape == 'acacia':
                S = acacia_sprite(R, p)
            else:
                S = recolour(R, leaf_fn(p))
                S = trunk_fix(S, name)
                if name == 'jungle':
                    vines(S, (2, 6, 10, 21, 25, 29), ((24, 74, 24), (115, 189, 65)), 1, 5, 5)
                elif name == 'swamp_oak':
                    vines(S, (1, 4, 8, 12, 19, 23, 27, 30), ((65, 82, 32), (115, 131, 65)), 2)
            homes = {}
            for m, (b, a) in sprite_pieces(P, S).items():
                beh, col, mat, enc = B.meta(m)
                homes[m] = B.add(b, a, m, beh, col, mat, enc, m, v, 0)
                B.ventry[v][m] = homes[m]
        ovs = {}
        for m in TREE_MIDS:
            if ground == 'snow':
                objc = {snap(pull(c, p)) for c in LEAF_RGB} | {(255, 255, 255), (90, 65, 57), (65, 57, 49)}
                assert not objc & snow_g, objc & snow_g
                ovs[m] = B.overlay_of(homes[m], m, v, snow_g, SNOW_BASE, snow_plain, fam='snow')
            else:
                ovs[m] = B.overlay_of(homes[m], m, v, grass_g, GRASS_BASE, V['grassPlain'])
            assert ovs[m] is not None, (name, m)
        rec[name] = {'var': v, 'shape': shape, 'wood': wood, 'ground': ground,
                     'home': {str(m): homes[m] for m in TREE_MIDS}, 'ov': {str(m): ovs[m] for m in TREE_MIDS}}
    return rec


# ---- synthesized ground materials and decoration sprites (4.3)
def tex_ramp(name, qs=(0.12, 0.45, 0.7, 0.9), tint=None, gain=1.0):
    """Four colours of a Minecraft texture by luminance quantile (snapped to the GBA's grid): the ramp FireRed's
    grass colours (dark tuft, base, light, lightest) are mapped onto, so the ground keeps FireRed's tuft pattern."""
    t = mc_tex(name)
    px = t[t[:, :, 3] > 0][:, :3].astype(float)
    if tint is not None:
        px = px.mean(1, keepdims=True) / 255 * np.array(tint)
    lum = px @ np.array([0.299, 0.587, 0.114])
    order = np.argsort(lum, kind='stable')
    return [snap(tuple(min(255, int(round(v * gain))) for v in px[order[min(len(order) - 1, int(q * len(order)))]]))
            for q in qs]


GRASS_ORDER = ((65, 180, 139), (115, 205, 164), (139, 222, 189), (164, 230, 197))   # by luminance


def ground_material(B, P, V, name, ramp_, beh, col, mat, enc, var):
    gm = dict(zip(GRASS_ORDER, ramp_))
    out = []
    for m in V['grass']:
        out.append(B.add(recolour(P.img(m), lambda c: gm.get(c, c)), None, m, beh, col, mat, enc, m, var, 0))
        B.ventry[var][m] = out[-1]
    return out


def outline(cell, rgb=(41, 41, 41)):
    """A dark 1px outline round a sprite, FireRed's way of making an object read on any ground."""
    a = cell[:, :, 3] > 0
    p = np.pad(a, 1)
    ring = (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]) & ~a
    o = cell.copy()
    o[ring] = (*rgb, 255)
    return o


def fruit(base_rgb, rib_rgb, stem_rgb, ribs=True, stripes=False):
    """A pumpkin or melon seen from above (3.8): a round fruit, lit from the top left in three steps, with ribs (or
    stripes) running out from the stem in the middle and a dark outline."""
    c = np.zeros((16, 16, 4), np.uint8)
    cx, cy, r = 7.5, 8.0, 6.6
    for y in range(16):
        for x in range(16):
            dx, dy = (x - cx) / r, (y - cy) / (r * 0.92)
            d = dx * dx + dy * dy
            if d > 1:
                continue
            light = -0.55 * dx - 0.65 * dy + 0.35 * (1 - d)
            col = base_rgb[0] if light > 0.32 else base_rgb[1] if light > -0.25 else base_rgb[2]
            ang = math.atan2(dy, dx)
            if ribs and d > 0.08 and abs(((ang / (2 * math.pi)) * 8) % 1 - 0.5) > 0.38:
                col = rib_rgb
            if stripes and d > 0.05 and abs(((ang / (2 * math.pi)) * 10 + d * 1.5) % 1 - 0.5) > 0.36:
                col = rib_rgb
            c[y, x] = (*col, 255)
    for x, y in ((7, 7), (8, 7), (7, 8), (8, 8)):
        c[y, x] = (*stem_rgb[0 if y == 7 else 1], 255)
    c[6, 8] = (*stem_rgb[0], 255)
    return outline(c)


def plant_sprite(name, tint=None, contrast=0.85):
    """A Minecraft cross-model plant (sugar cane, dead bush, lily pad) on its cell, its colours snapped and darkened a
    step so it reads on FireRed's bright grounds, with a drop shadow on its right and lower edges."""
    t = mc_tex(name).copy()
    if tint is not None:
        g = t[:, :, :3].astype(float).mean(2, keepdims=True) / 255
        t[:, :, :3] = np.clip(g * np.array(tint) * 1.5, 0, 255).astype(np.uint8)
    t[:, :, 3] = np.where(t[:, :, 3] > 127, 255, 0)
    t[:, :, :3] = np.clip(t[:, :, :3].astype(float) * contrast, 0, 255).astype(np.uint8)
    t = gba(t)
    a = t[:, :, 3] > 0
    out = t.copy()
    for y in range(16):
        for x in range(16):
            if not a[y, x] and ((x > 0 and a[y, x - 1]) or (y > 0 and a[y - 1, x])):
                out[y, x] = (41, 41, 41, 255)
    return out


def raised(top, front, width=14, height=16, depth=14):
    """A block standing on its cell seen as FireRed sees things (its front face on the cell, its top face above):
    a 16x24 picture, the lower 16 rows on the cell, the upper 8 over the cell above."""
    cols = lambda t, n: t[:, (np.arange(n) * t.shape[1] / n).astype(int)]
    rows = lambda t, n: t[(np.arange(n) * t.shape[0] / n).astype(int)]
    shade = lambda t, k: np.concatenate([np.clip(t[:, :, :3].astype(float) * k, 0, 255).astype(np.uint8), t[:, :, 3:]], 2)
    cell = np.zeros((24, 16, 4), np.uint8)
    x0 = (16 - width) // 2
    tr = max(1, round(depth * 0.45))
    t = shade(rows(cols(top, width), tr), 1.06)
    f = shade(rows(cols(front, width), height), 0.9)
    yf = 24 - height
    cell[yf - tr:yf, x0:x0 + width] = t
    cell[yf:24, x0:x0 + width] = f
    cell[yf - tr, x0:x0 + width, :3] = np.clip(cell[yf - tr, x0:x0 + width, :3].astype(int) + 22, 0, 255)
    cell[:, :, 3] = np.where(cell[:, :, 3] > 127, 255, 0)
    return gba(cell)


# (art polish, world update: the cactus and dead bush redrawn by hand; same entries, new pixels)
def ground_shadow(cell, cx, cy, rx, ry, rgb=(57, 41, 16), alpha=96):
    """A soft shadow on the ground under a sprite: an ellipse of semi-transparent pixels where the sprite is clear,
    so it darkens whatever ground the overlay is drawn on."""
    o = cell.copy()
    for y in range(o.shape[0]):
        for x in range(o.shape[1]):
            if o[y, x, 3] == 0 and ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1:
                o[y, x] = (*rgb, alpha)
    return o


def cactus_sprite():
    """Minecraft's cactus as FireRed draws a standing object (3.8): a 16x24 picture, the lower 16 rows on the cell and
    the upper 8 over the cell above. A pale top face with the cactus top's ring and dark centre, a front face of three
    lit ribs with dark grooves, pale spines with dark roots on the ribs and dark ones sticking out of the sides, a dark
    outline and a soft shadow on the ground at its foot."""
    O, D, M, L, H = (24, 57, 32), (41, 98, 49), (65, 139, 57), (106, 172, 74), (156, 205, 106)
    SP = (238, 238, 205)
    T1, T2, T3, T4 = (90, 156, 65), (123, 189, 82), (164, 213, 115), (49, 115, 41)
    c = np.zeros((24, 16, 4), np.uint8)
    rib = (L, H, L, D, M, L, M, D, M, L, D, D)               # x 2..13: ridges at 3, 7 and 11, lit from the left
    for y in range(5, 22):
        for i, col in enumerate(rib):
            c[y, 2 + i] = (*col, 255)
    for x in range(2, 14):                                   # the lip under the top face
        c[5, x] = (*(D if x > 2 else M), 255)
    for y in range(1, 5):                                    # the top face: ring, rim light, dark centre
        for x in range(2, 14):
            dx, dy = (x + 0.5 - 8) / 6, (y + 0.5 - 3.0) / 2.1
            d = dx * dx + dy * dy
            if d > 1.15:
                continue
            col = T4 if d < 0.05 else T1 if d < 0.32 else T3 if d < 0.62 else T2
            if d >= 0.62 and dx < -0.2 and dy < 0.2:
                col = T3
            c[y, x] = (*col, 255)
    for x, y in ((3, 8), (7, 11), (11, 8), (3, 14), (11, 14), (7, 17), (3, 19), (11, 19)):
        c[y, x] = (*SP, 255)
        c[y + 1, x] = (*O, 255)
    for x, y in ((5, 2), (10, 2), (11, 4), (4, 4)):
        c[y, x] = (*SP, 255)
    c[21, 2] = c[21, 13] = (0, 0, 0, 0)                     # a rounded foot
    c = outline(c, O)
    for x, y in ((0, 9), (0, 16), (15, 7), (15, 12), (15, 18)):
        c[y, x] = (*O, 255)
    c = ground_shadow(c, 9.5, 22.8, 7.0, 1.7)
    return gba(c)


DEAD_BUSH = ('................',
             '.l..........l...',
             '..b....l...b..l.',
             '..b....b..b..b..',
             'l..b...b..b.b...',
             '.b..b..b.b.b....',
             '..bb.b.b.bb...l.',
             '....b.bb.b...b..',
             '.....bbbb...b...',
             '.......bb..b....',
             '.......bbbb.....',
             '........bb......',
             '........bd......',
             '.......dbd......',
             '.......d.d......',
             '................')


def dead_bush_sprite():
    """Minecraft's dead bush seen as FireRed would draw it: thin bare twigs fanning up from a short stem (the texture
    itself, darkened and outlined, read as a solid brown blob), pale tips, each twig with a dark edge on its right, a
    soft drop shadow down and to the right, and a shadow on the ground at its foot."""
    C = {'l': (189, 148, 82), 'b': (131, 90, 41), 'd': (74, 49, 24)}
    c = np.zeros((16, 16, 4), np.uint8)
    for y, row in enumerate(DEAD_BUSH):
        for x, ch in enumerate(row):
            if ch in C:
                c[y, x] = (*C[ch], 255)
    a = c[:, :, 3] > 0
    for y in range(16):
        for x in range(16):
            if a[y, x] and x + 1 < 16 and not a[y, x + 1] and y > 1 and DEAD_BUSH[y][x] == 'b':
                c[y, x + 1] = (*C['d'], 255)
    a = c[:, :, 3] > 0
    for y in range(15):
        for x in range(15):
            if a[y, x] and not c[y + 1, x + 1, 3]:
                c[y + 1, x + 1] = (57, 41, 16, 80)
    c = ground_shadow(c, 9.0, 14.6, 4.0, 1.3)
    return gba(c)


def synth_bank(B, P, V, quarter, styles):
    """Ground materials (clay, mud, podzol; snow and ice from the quarter sets and the snowy style) and the
    decoration sprites (cactus, dead bush, sugar cane, lily pad, pumpkin and melon from above). A sprite gets a home
    entry (drawn on its home ground) and an overlay (the sprite alone, for any other ground)."""
    grounds = {}
    sand_meta = B.meta(277)
    # mud keeps the colours of B's mud (Minecraft's mud texture is near black on FireRed's bright grounds)
    mud_c = sorted({tuple(int(v) for v in px[:3]) for px in
                    B.pixels(quarter['sets']['B']['recolours']['mud']['home'][0])[0].reshape(-1, 4)},
                   key=lambda c: (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], c))
    mud_px = B.pixels(quarter['sets']['B']['recolours']['mud']['home'][0])[0].reshape(-1, 4)
    mud_base = Counter(tuple(int(v) for v in px[:3]) for px in mud_px).most_common(1)[0][0]
    lighter = [c for c in mud_c if sum(c) > sum(mud_base)] or [mud_base]
    mud_ramp = [mud_c[0], mud_base, lighter[0], lighter[-1]]       # dark tuft, the centre's own colour, lighter tufts
    vg = B.var('ground_mud', kind='ground', ground='mud', grass=False)
    mud = ground_material(B, P, V, 'mud', mud_ramp, 0x21, sand_meta[1], 'mud', sand_meta[3], vg)
    vg = B.var('ground_podzol', kind='ground', ground='podzol', grass=False)
    # podzol: Minecraft's orange-brown forest floor, raised to FireRed's brightness (its texture's own quantiles come
    # out olive at that brightness)
    podzol_ramp = [snap(c) for c in ((115, 82, 49), (156, 115, 65), (180, 139, 82), (197, 156, 98))]
    podzol = ground_material(B, P, V, 'podzol', podzol_ramp, 0, 0, 'podzol', 0, vg)
    vg = B.var('ground_clay', kind='ground', ground='clay', grass=False)
    clay = ground_material(B, P, V, 'clay', tex_ramp('clay', (0.05, 0.4, 0.75, 0.97)), 0, 0, 'clay', 0, vg)
    sv = styles['snowy']['var']
    grounds['snow'] = [quarter['sets']['B']['recolours']['snow']['home'][0]] + [B.ventry[sv][g] for g in V['grass']]
    grounds['ice'] = [quarter['sets']['A']['recolours']['ice']['home'][0]]
    grounds['mud'] = [quarter['sets']['B']['recolours']['mud']['home'][0]] + mud
    grounds['podzol'] = podzol
    grounds['clay'] = clay
    grounds['sand'] = [quarter['sets']['B']['recolours']['sand']['home'][0]]
    grounds['grass'] = list(V['grass'])

    # decoration sprites: (name, below 16x16, above 16x16 or None, home ground entry, mat, col)
    cac = cactus_sprite()
    cac_base, cac_top = cac[8:24], np.zeros((16, 16, 4), np.uint8)
    cac_top[8:16] = cac[0:8]
    pumpkin = fruit([(246, 164, 57), (222, 123, 32), (172, 82, 24)], (156, 74, 16), [(90, 115, 41), (57, 82, 24)])
    melon = fruit([(148, 205, 65), (106, 172, 41), (65, 123, 32)], (49, 98, 24), [(115, 98, 49), (82, 65, 32)],
                  ribs=False, stripes=True)
    desert = grounds['sand'][0]
    pond = 425
    # (name, below, above, home ground, material, collision): the cactus is solid and hurts (5a), its top piece is
    # drawn in the top layer of the cell above; pumpkins and melons are solid blocks; the rest are walkable
    sprites = [
        ('cactus', cac_base, None, desert, 'cactus', 1),
        ('cactus_top', np.zeros((16, 16, 4), np.uint8), cac_top, desert, 'cactus', 0),
        ('dead_bush', dead_bush_sprite(), None, desert, 'dead_bush', 0),
        ('sugar_cane', plant_sprite('sugar_cane', contrast=0.9), None, 1, 'sugar_cane', 0),
        ('lily_pad', plant_sprite('lily_pad', tint=(32, 128, 48), contrast=1.0), None, pond, 'lily_pad', 0),
        ('pumpkin', pumpkin, None, 1, 'pumpkin', 1),
        ('melon', melon, None, 1, 'melon', 1),
    ]
    rec = {}
    vs = B.var('synth', kind='synth', grass=False)
    for name, sb, sa, g, mat, col in sprites:
        gb = B.pixels(g)[0]
        # a sprite's soft ground shadow (semi-transparent pixels) lies over the plain ground colour in its home entry,
        # so the overlay drawn over the plain colour reproduces the home exactly (the overlay test's `plain`)
        soft = (sb[:, :, 3] > 0) & (sb[:, :, 3] < 255)
        if soft.any():
            gb = gb.copy()
            gb[soft] = (*Counter(tuple(int(v) for v in p[:3]) for p in gb.reshape(-1, 4)).most_common(1)[0][0], 255)
        hb = over(sb, gb)
        gbeh, _, _, genc = (B.meta(g) if g < GEN_BASE else tuple(B.rows[g - GEN_BASE][k] for k in (2, 3, 4, 7)))
        # a walkable sprite keeps its ground's behaviour (water under a lily pad, sand under a dead bush)
        beh = gbeh if col == 0 else 0
        home = B.add(hb, sa, -1, beh, col, mat, genc if col == 0 else 0, g, vs, 0)
        ov = B.sprite_overlay(home, sb, g, vs, name)
        rec[name] = {'home': home, 'ov': ov, 'ground': int(g), 'mat': mat, 'col': col}
    return {'grounds': grounds, 'sprites': rec}


# ---- ores (3.9) and cave ore completions (3.10)
def ore_faces(L):
    """Every piece the learned rock painter can put on an interior rock cell (its 3x3 all rock), either context."""
    inner = [dy * 5 + dx for dy in (1, 2, 3) for dx in (1, 2, 3)]
    outer = [i for i in range(25) if i not in inner]
    base = sum(1 << (24 - i) for i in inner)
    faces = set()
    for n in range(1 << 16):
        k = base
        for j, i in enumerate(outer):
            if (n >> j) & 1:
                k |= 1 << (24 - i)
        for g in 'gs':
            m, _ = lookup(L, k, 511, g)
            faces.add(int(m))
    return sorted(faces)


def ore_bank(B, P, entries, grid, L, styles):
    import build_world as BW                          # the existing paint_ore, masks and ore list (lazy: no cycle)
    E = entries
    ores = [o for o, *_ in BW.ORES]
    have = {}
    for i, e in enumerate(E):
        if e['mat'].endswith('_ore') and e.get('base', -1) >= 0:
            have.setdefault((e['base'], e['mat']), i)

    def add_ore(src_entry, face_mid, var, ore, mask, beh, col, enc, pair=-1):
        b, a = B.pixels(src_entry)
        res = BW.paint_ore(b, a, ore, lambda img, m=mask: m)
        assert res is not None, ('ore does not fit', src_entry, ore)
        i = B.add(res[0], res[1], face_mid, beh, col, ore, enc, src_entry, var, 0)
        B.rows[i - GEN_BASE][5] = int(src_entry)          # base: the plain face (baseEntry, mining drops)
        B.rows[i - GEN_BASE][1] = int(pair)
        return i

    faces = ore_faces(L)
    table = {}
    reused = made = 0
    for style, rec in styles.items():
        v = rec['var']
        table[style] = {}
        for f in faces:
            mask = BW.rock_mask(BW.composite(E[f]))
            src = f if v == 0 else B.ventry[v][f]
            beh, col, _, enc = B.meta(f)
            row = {}
            for o in ores:
                if v == 0 and (f, o) in have:
                    i = have[(f, o)]
                    ref = BW.paint_ore(E[f]['below'], E[f]['above'], o)
                    assert np.array_equal(ref[0], E[i]['below']) and np.array_equal(ref[1], E[i]['above']), (f, o)
                    row[o] = i
                    reused += 1
                else:
                    row[o] = add_ore(src, f, v, o, mask, beh, col, enc)
                    made += 1
            table[style][str(f)] = row
    # cave walls: every family's interior wall pieces in every ore, with build_world's palette masks
    AT0 = json.load(open(OUT / 'autotile.json'))
    used = Counter(grid.reshape(-1).tolist())
    inner = [dy * 5 + dx for dy in (1, 2, 3) for dx in (1, 2, 3)]
    full = lambda k: all((k >> (24 - i)) & 1 for i in inner)
    caves = {}
    c_reused = c_made = 0
    for fam in ('cave:Cave', 'cave:RockTunnel', 'cave:SeafoamIslands'):
        F = AT0['families'][fam]
        pi = F['pair']
        rock_idx = [i for i in range(GEN_BASE) if E[i]['pair'] == pi and E[i]['mat'] == 'rock']
        floors = sorted((i for i in used if i < GEN_BASE and E[i]['pair'] == pi and E[i]['mat'] == 'floor'),
                        key=lambda i: (-used[i], i))
        total, floor_idx = sum(used[i] for i in floors), []
        for i in floors:
            if sum(used[j] for j in floor_idx) >= 0.7 * total:
                break
            floor_idx.append(i)
        fmask = BW.palette_mask(BW.cave_rock_colors(E, rock_idx, floor_idx))
        wall = sorted({int(v[0]) for k, v in F['r2'].items() if full(int(k))} | {int(F['r1']['511'][0])})
        caves[fam] = {}
        for f in wall:
            comp = BW.composite(E[f])
            assert E[f]['mat'] == 'rock' and int(fmask(comp).sum()) >= 110, (fam, f)
            mask = fmask(comp)
            row = {}
            for o in ores:
                if (f, o) in have:
                    i = have[(f, o)]
                    ref = BW.paint_ore(E[f]['below'], E[f]['above'], o, fmask)
                    assert np.array_equal(ref[0], E[i]['below']) and np.array_equal(ref[1], E[i]['above']), (fam, f, o)
                    row[o] = i
                    c_reused += 1
                else:
                    beh, col, _, enc = B.meta(f)
                    row[o] = add_ore(f, -1, 0, o, mask, beh, col, enc, pi)     # mid -1: not a General piece
                    c_made += 1
            caves[fam][str(f)] = row
    return {'kinds': ores, 'faces': faces, 'entries': table, 'caves': caves,
            'counts': {'surfaceReused': reused, 'surfaceMade': made, 'caveReused': c_reused, 'caveMade': c_made}}


def pair_index(name):
    return json.load(open(OUT / 'world.json'))['pairs'].index(name)


def build(entries, grid):
    B = Bank(entries)
    P = B.P
    V = vocabulary(entries, grid)
    grass_g = set(GRASS_RGB) | set(GRASS_RIMS)
    sand_g = SAND_RGB

    # ---- ground tints and transition bands (11 pieces each)
    tint_src = V['grass'] + V['tallGrass'] + V['tallGrassBase'] + V['flower'] + V['bush']
    tints = {'temperate': {'var': 0, 'pull': list(TEMPERATE)}}
    for t in ('cool', 'dry', 'lush', 'swamp'):
        v = B.var(t, kind='tint', grass=True, ground='grass', tint=t, pull=list(TINTS[t]))
        tints[t] = {'var': v, 'pull': list(TINTS[t])}
        for m in tint_src:
            B.variant_of(m, v, tint_fn(TINTS[t]))
    bands = {}
    for t in ('cool', 'dry', 'lush', 'swamp'):
        bands[t] = []
        for k in (1, 2):
            p = band(t, k / 3)
            v = B.var(f'{t}_band{k}', kind='band', grass=True, ground='grass', tint=t, step=k, pull=list(p))
            bands[t].append(v)
            for m in tint_src:
                B.variant_of(m, v, tint_fn(p))

    # ---- trees (Kanto's General tree, oak): overlays over any ground; the home entries are General's own
    tree_ids = V['treeTip'] + V['treeOverlap'] + V['treeCrown'] + V['treeBase']
    for m in tree_ids:
        B.overlay_of(m, m, 0, grass_g, GRASS_BASE, V['grassPlain'])

    # ---- rock styles: brown is General (overlays only); grey, snowy and sandstone get home looks on their own
    # ground and overlays
    rock_pieces = sorted(set(V['rock'] + V['ledge'] + V['boulder'] + V['caveMouth'] + V['mountainPath']))
    styles = {'brown': {'var': 0, 'ground': 'grass', 'tint': 'temperate', 'path': 'sand'}}
    STYLE = {'grey': ('cool', ground_fn('grass', TINTS['cool']), sand_fn('gravel'), 'gravel'),
             'snowy': ('snow', ground_fn('snow'), sand_fn('snow'), 'snow'),
             'sandstone': ('sand', ground_fn('sand'), sand_fn('pale'), 'pale')}

    def home_ground_of(mid):
        """The family of a rock piece's outside ground: grass, sand (mountain-foot sand) or none."""
        t = P.img(mid)
        px = [tuple(int(v) for v in p[:3]) for p in t.reshape(-1, 4) if p[3]]
        g = sum(p in grass_g for p in px)
        s = sum(p in sand_g for p in px)
        if g == 0 and s == 0:
            return None, None
        if g >= s:
            return 'grass', GRASS_BASE
        base = Counter(p for p in px if p in sand_g).most_common(1)[0][0]
        return 'sand', base
    sand_grounds = V['sandPlain']
    for m in rock_pieces:
        fam, base = home_ground_of(m)
        if fam is None or m == 188:
            continue
        B.overlay_of(m, m, 0, grass_g if fam == 'grass' else sand_g, base,
                     V['grassPlain'] if fam == 'grass' else sand_grounds, fam=fam)
    for name, (gname, gfn, sfn, pname) in STYLE.items():
        v = B.var(f'rock_{name}', kind='rock', rock=name, grass=gname not in ('snow', 'sand'),
                  ground=gname if gname in ('snow', 'sand') else 'grass', tint=gname if gname == 'cool' else None)
        styles[name] = {'var': v, 'ground': 'grass' if gname == 'cool' else gname, 'tint': 'cool' if gname == 'cool' else None,
                        'path': pname}
        fn = by_class(rock_fn(name), gfn, sfn)
        for m in rock_pieces:
            B.variant_of(m, v, fn)
        # the style's plain grounds (its recoloured grass and path sand) for the overlay test
        g_style = [B.ventry[v].get(g) or B.variant_of(g, v, fn) for g in V['grassPlain']]
        s_style = [B.ventry[v].get(g) or B.variant_of(g, v, fn) for g in sand_grounds]
        # a ground keeps the material it shows, whichever variant drew it: snow is snow (as A's and B's snow), desert
        # sand is sand (as B's sand), gravel and pale stone are path floor (as C's gravel and pale); cool grass keeps
        # its grass's. (The mountain path 188 is among the sand plains: in a style it is that style's path.)
        sand_meta = B.meta(277)[:2] + (B.meta(277)[3],)
        path_meta = B.meta(217)[:2] + (B.meta(217)[3],)
        over_ = {'snowy': [(i, sand_meta, 'snow') for i in g_style + s_style],
                 'sandstone': [(i, sand_meta, 'sand') for i in g_style] + [(i, path_meta, 'floor') for i in s_style],
                 'grey': [(i, path_meta, 'floor') for i in s_style]}[name]
        for i, (beh_s, col_s, enc_s), gmat in over_:
            r = B.rows[i - GEN_BASE]
            r[2], r[3], r[4], r[7] = beh_s, col_s, gmat, enc_s
        for m in rock_pieces:
            fam, base = home_ground_of(m)
            if fam is None or m == 188:
                continue
            ground = {fn(c) for c in (grass_g if fam == 'grass' else sand_g)}
            B.overlay_of(B.ventry[v][m], m, v, ground, fn(base), g_style if fam == 'grass' else s_style, fam=fam)

    # ---- quarter-tile sets
    codes, lut = blob_codes()
    quarter = {'bits': BITS, 'states': ['inside', 'open above or below', 'open beside', 'outer corner', 'inner corner'],
               'codes': codes, 'lut': lut, 'sets': {}}
    for sid, s in SETS.items():
        check_set(P, sid)
        inners = inner_map(P, sid) if s['inner'] else None
        pieces = {k: s[k] for k in ('tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br')}
        rec = {'pieces': pieces, 'inner': inners, 'innerSynth': inners is None, 'inside': s['inside'],
               'outside': s['outside'], 'recolours': {}}
        set_mids = [s[k] for k in pieces] + (list(s['inner']) if s['inner'] else [])
        cbeh, ccol, cmat, cenc = B.meta(s['c'])
        if sid in ('A', 'B'):
            cbeh = 0x21
        composed = [compose(P, sid, st, inners) for st in codes]
        # the General piece a code equals, if any (FireRed's own pieces among the 47 codes)
        ident = []
        for cb, ca in composed:
            same = [m for m in set_mids if np.array_equal(P.img(m), cb) and np.array_equal(P.top(m), ca)]
            ident.append(int(same[0]) if same else -1)
        set_meta = (cbeh, ccol, cenc)
        rec['ident'] = ident
        for rname, fn, mat, *rest in SET_RECOLOURS[sid]:
            outk = rest[0] if rest else 'grass'
            v = 0 if fn is None else B.var(f'{sid}_{rname}', kind='quarter', set=sid, recolour=rname, outside=outk,
                                           grass=False, ground=mat if mat in ('snow', 'ice', 'mud', 'sand') else
                                           ('water' if sid == 'P' else 'path'))
            homes, ovs = [], []
            for ci, (cb, ca) in enumerate(composed):
                if fn is None:
                    # every code of a set has the set's metadata (its inside is one material: a beach's edge cell is
                    # sand however much sea it shows). A code equal to one of FireRed's own pieces is that General
                    # entry when its metadata already agrees, and otherwise a copy of its pixels with the set's
                    # (FireRed marks some of A's edge pieces as shallow water and two of B's as floor).
                    m = ident[ci]
                    if m >= 0:
                        beh_, col_, mat_, enc_ = B.meta(m)
                        if (beh_, col_, enc_) == set_meta and mat_ == mat:
                            homes.append(m)
                            continue
                    hb, ha = cb, ca
                    mid_, vsrc = m, m
                else:
                    hb, ha = recolour(cb, fn), recolour(ca, fn)
                    vsrc = rec['recolours'][SET_RECOLOURS[sid][0][0]]['home'][ci]
                    mid_ = ident[ci]
                homes.append(B.add(hb, ha, mid_, cbeh, ccol, mat, cenc, vsrc, v, 0))
                if fn is not None and mid_ >= 0:
                    B.ventry[v][mid_] = homes[-1]
            if s['outside'] == 'ground':
                f0 = fn or (lambda c: c)
                if outk == 'grass':
                    gfam, plain_ = set(GRASS_RGB) | {f0(c) for c in GRASS_RIMS}, V['grassPlain']
                elif outk == 'snow':
                    snow_c = quarter['sets']['B']['recolours']['snow']['home'][0]
                    gfam = {f0(c) for c in GRASS_RGB} | {f0(c) for c in GRASS_RIMS} | set(SAND_SNOW_COLOURS)
                    # snow grounds: the snowy beach's centre, and FireRed's grass grounds in snow (the snowy rock
                    # style's grounds, made by the same grass-to-snow map as this set's outside)
                    plain_ = [snow_c] + [B.ventry[styles['snowy']['var']][g] for g in V['grassPlain']]
                else:
                    gfam = {f0(c) for c in GRASS_RGB} | {f0(c) for c in GRASS_RIMS} | set(BEACH_SAND)
                    plain_ = [m for m in V['sandPlain'] if m == 277] + [m for m in V['sandPlain'] if m != 277] + \
                        [B.ventry[styles['sandstone']['var']][g] for g in V['grassPlain']]
                # the inside's colours must not be ground colours, or the overlay would drop them
                inside_c = {f0(c) for c in (SAND_RGB if sid in ('B', 'C') else WATER_RGB | ROCK_RGB)}
                assert not inside_c & gfam, (sid, rname, inside_c & gfam)
                for ci, h in enumerate(homes):
                    o = B.overlay_of(h, ident[ci] if fn is None else -1, v, gfam, OUTSIDE_BASE[outk], plain_,
                                     beh=cbeh, col=ccol, mat=mat, enc=cenc, fam=outk)
                    ovs.append(o if o is not None else h)
            metas = {tuple(B.meta(e)) if e < GEN_BASE else tuple(B.rows[e - GEN_BASE][k] for k in (2, 3, 4, 7))
                     for e in homes + ovs}
            assert metas == {(cbeh, ccol, mat, cenc)}, (sid, rname, metas)
            rec['recolours'][rname] = {'var': v, 'mat': mat, 'outside': outk, 'home': homes, 'ov': ovs or None}
        quarter['sets'][sid] = rec

    # ---- learned tables
    L = learned(P, V['ledge'])
    T0 = json.load(open(OUT / 'autotile.json'))
    for k in ('r1', 'r2', 'g1', 'g2'):
        assert L['rock'][k] == T0[k], f'learned rock table {k} differs from autotile.json'
    assert {k: v for k, v in L['rock']['compat'].items()} == {k: v for k, v in T0['compat'].items()}, 'compat differs'
    assert misses(L['rock']) == 0 and misses(L['ledge']) == 0

    # ---- part 2 (stage 2b): species looks, synthesized tiles, ores on every rock style, cave ore completions
    vfp = pair_index('gTileset_ViridianForest')
    vf = {}
    for i in range(GEN_BASE):
        e = entries[i]
        if e['pair'] == vfp and e['mat'] == 'tree' and e['mid'] not in vf:
            vf[e['mid']] = i
    species = species_bank(B, P, V, styles, quarter, vf)
    synth = synth_bank(B, P, V, quarter, styles)
    ores = ore_bank(B, P, entries, grid, L['rock'], styles)
    # ---- part 3 (stage 7a): village exteriors per style and interiors (tools/build_terrain_villages.py), appended last
    import build_terrain_villages as VB  # noqa: E402
    villages = VB.village_bank(B, entries, grid, sys.modules[__name__])

    # ---- the overlay test (4.3)
    worst = max(r[3] for r in B.ov_report)
    worst_raw = max(r[4] for r in B.ov_report)
    bad = [r for r in B.ov_report if r[3] > OV_TOLERANCE * 256]
    if os.environ.get('TERRAIN_REPORT'):
        for r in sorted(B.ov_report, key=lambda r: -r[3])[:60]:
            print('overlay', r)
    assert not bad, f'overlays over their home ground differ in more than 3%: {bad[:10]}'
    assert all(r[8] == 0 for r in B.ov_report), 'an overlay drawn over its plain ground colour differs from its home'

    new_materials = {'snow': {'hard': -1}, 'ice': {'hard': -1}, 'mud': {'hard': -1}, 'podzol': {'hard': -1},
                     'clay': {'hard': -1}}
    meta = {
        'v': TERRAIN_V, 'genVersion': GEN_VERSION, 'genBase': GEN_BASE, 'cols': COLS, 'count': len(B.rows),
        'fields': ['mid', 'pair', 'beh', 'col', 'mat', 'base', 'above', 'enc', 'vsrc', 'var', 'ov'],
        'entries': B.rows,
        'vocab': V,
        'quarter': quarter,
        'learned': L,
        'variants': B.variants[1:],
        'ventry': {str(v): {str(k): i for k, i in sorted(d.items())} for v, d in sorted(B.ventry.items())},
        'ovl': {str(v): {str(k): i for k, i in sorted(d.items())} for v, d in sorted(B.ovl.items())},
        'home': {str(k): v for k, v in sorted(B.home.items())},
        'homeGround': {str(k): v for k, v in sorted(B.home_ground.items())},
        'tints': tints, 'bands': bands, 'hubPairs': [['temperate', t] for t in ('cool', 'dry', 'lush', 'swamp')],
        'rockStyles': styles,
        'waterTile': water_tile(entries, grid), 'pondTile': 425,
        'materials': new_materials,
        'lattice': list(TREE_MIDS),
        'species': species,
        'synth': synth,
        'ores': ores,
        'villages': villages,
        'overlayTest': {'tolerance': OV_TOLERANCE, 'pixelTolerance': PIX_TOL, 'count': len(B.ov_report),
                        'worstPixels': int(worst), 'worstRawPixels': int(worst_raw),
                        'groundSets': {k: [list(c) for c in v] for k, v in sorted(B.ground_sets.items())},
                        'family': {str(k): v for k, v in sorted(B.ov_fam.items())},
                        'itemFields': ['entry', 'strict', 'raw', 'delta', 'loose', 'through'],
                        'items': [[int(r[0]), int(r[3]), int(r[4]), int(r[5]), int(r[6]), int(r[7])] for r in B.ov_report]},
    }
    return B, meta


def write(B, meta, out=OUT):
    n = len(B.rows)
    rows = -(-n // COLS)
    below = np.zeros((rows * 16, COLS * 16, 4), np.uint8)
    above = np.zeros_like(below)
    for k in range(n):
        x, y = (k % COLS) * 16, (k // COLS) * 16
        below[y:y + 16, x:x + 16] = B.below[k]
        above[y:y + 16, x:x + 16] = B.above[k]
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(below, 'RGBA').save(out / 'atlas_gen.png', optimize=True)
    Image.fromarray(above, 'RGBA').save(out / 'atlas_gen_top.png', optimize=True)
    meta = dict(meta)
    meta['atlasHash'] = hashlib.sha1(below.tobytes() + above.tobytes()).hexdigest()[:12]
    text = json.dumps(meta, separators=(',', ':'), sort_keys=False)
    (out / 'terrain.json').write_text(text)
    return meta


def attach(entries, grid, out=OUT):
    """Called by build_world.py after The End, with its in-memory entries and the full grid (read only)."""
    B, meta = build(entries, grid)
    meta = write(B, meta, out)
    nv = len(meta['variants'])
    print(f"terrain: {meta['count']} generated entries from {GEN_BASE}, {nv} variants, {meta['overlayTest']['count']} overlays "
          f"(worst {meta['overlayTest']['worstPixels']} px of 256 over the home ground, {meta['overlayTest']['worstRawPixels']} "
          f"counting ground texture), "
          f"learned rock {len(meta['learned']['rock']['r2'])}/{len(meta['learned']['rock']['r1'])} "
          f"ledge {len(meta['learned']['ledge']['r2'])}/{len(meta['learned']['ledge']['r1'])} patterns")
    return meta


def load_entries(world=OUT):
    """Standalone: the General entries' pixels and metadata as build_world.py had them (atlas.png is lossless)."""
    W = json.load(open(world / 'world.json'))
    below = np.array(Image.open(world / 'atlas.png').convert('RGBA'))
    above = np.array(Image.open(world / 'atlas_top.png').convert('RGBA'))
    cols = W['cols']
    entries = []
    for i, r in enumerate(W['entries']):
        x, y = (i % cols) * 16, (i // cols) * 16
        entries.append({'mid': r[0], 'pair': r[1], 'beh': r[2], 'col': r[3], 'mat': r[4], 'enc': r[7],
                        'base': r[5], 'below': below[y:y + 16, x:x + 16].copy(), 'above': above[y:y + 16, x:x + 16].copy()})
    grid = np.fromfile(world / 'grid.bin', dtype='<u2').reshape(W['h'], W['w'])
    return entries, grid


if __name__ == '__main__':
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    ents, grid = load_entries()
    attach(ents, grid, out)
