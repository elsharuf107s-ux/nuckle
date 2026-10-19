#!/usr/bin/env python3
"""The Kanto signpost's sheet (minimap design, Track SIGN, 2.5): assets/world/kanto_sign.png.

A Kanto World's spawn sign is FireRed's own wooden route sign (General metatile 3, atlas entry 3 of
assets/world/atlas.png, read and never changed) with the two rows of "writing" on its face replaced by an arrow in one
of 8 directions, so a new player reads at a glance which way Kanto is. The sheet is 128 x 16 RGBA: 8 frames of 16 x 16
in direction order (0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW; north up), drawn as overlay entries over the cell's
own ground (world.js blitEntry):

  * the grass around the sign (#73cda4) becomes transparent, so the sign stands on any grass tint, sand or snow;
  * its grey ground shadow (#7b7b83) becomes the translucent shadow the synthesized sprites use
    (build_terrain.py ground_shadow: rgb 57, 41, 16 at alpha 96);
  * the 10 x 6 face (columns 3 to 12, rows 5 to 10) is cleared to the face colour (#dec5a4) and the arrow is drawn in
    the board's own outline colour (#5a3941), the darkest pixel of the sign.

  python3 tools/build_kanto_sign.py [--review out_dir]

--review also writes kanto_sign_review.png there: each frame at 1x and 4x on the temperate, cool, dry, lush and swamp
grass and on sand, beside FireRed's own sign, for a look by eye before the sheet is accepted.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORLD = os.path.join(ROOT, 'assets', 'world')
SIGN_ENTRY = 3                      # General metatile 3: the wooden route sign
GRASS = (0x73, 0xcd, 0xa4)
SHADOW_GREY = (0x7b, 0x7b, 0x83)
SHADOW = (57, 41, 16, 96)
FACE = (0xde, 0xc5, 0xa4)
INK = (0x5a, 0x39, 0x41)
FACE_X, FACE_Y, FACE_W, FACE_H = 3, 5, 10, 6

# the glyphs on the 10 x 6 face ('#' ink); the other five are mirrors of these
N = ['....##....',
     '...####...',
     '..######..',
     '....##....',
     '....##....',
     '....##....']
E = ['......#...',
     '......##..',
     '.########.',
     '.########.',
     '......##..',
     '......#...']
NE6 = ['..####',
       '...###',
       '..##.#',
       '.##..#',
       '##....',
       '#.....']
NE = ['..' + r + '..' for r in NE6]          # at face columns 2 to 7


def flip_v(g): return list(reversed(g))
def flip_h(g): return [r[::-1] for r in g]


GLYPHS = [N, NE, E, flip_v(NE), flip_v(N), flip_h(flip_v(NE)), flip_h(E), flip_h(NE)]


def atlas_tile(img, cols, t):
    x, y = (t % cols) * 16, (t // cols) * 16
    return np.array(img.crop((x, y, x + 16, y + 16)).convert('RGBA'))


def frame(base, glyph):
    f = base.copy()
    for y in range(16):
        for x in range(16):
            p = tuple(int(v) for v in f[y, x, :3])
            if p == GRASS:
                f[y, x] = (0, 0, 0, 0)
            elif p == SHADOW_GREY:
                f[y, x] = SHADOW
    for y in range(FACE_H):
        for x in range(FACE_W):
            f[FACE_Y + y, FACE_X + x] = (*(INK if glyph[y][x] == '#' else FACE), 255)
    return f


def build():
    meta = json.load(open(os.path.join(WORLD, 'world.json')))
    cols = meta['cols']
    atlas = Image.open(os.path.join(WORLD, 'atlas.png'))
    base = atlas_tile(atlas, cols, SIGN_ENTRY)
    # the sign must still be FireRed's: its palette is the one this tool expects
    seen = {tuple(int(v) for v in base[y, x, :3]) for y in range(16) for x in range(16)}
    for c in (GRASS, SHADOW_GREY, FACE, INK):
        if c not in seen:
            raise SystemExit('atlas entry 3 is not the sign this tool expects (colour %s missing)' % (c,))
    sheet = np.zeros((16, 128, 4), np.uint8)
    for d, g in enumerate(GLYPHS):
        assert len(g) == FACE_H and all(len(r) == FACE_W for r in g), d
        sheet[:, d * 16:(d + 1) * 16] = frame(base, g)
    out = os.path.join(WORLD, 'kanto_sign.png')
    Image.fromarray(sheet, 'RGBA').save(out, optimize=True)
    print('wrote', out, os.path.getsize(out), 'bytes')
    return sheet, atlas, cols


def review(sheet, atlas, cols, out_dir):
    """Each frame at 1x and 4x on five grass tints and sand, beside FireRed's own sign (entry 3)."""
    terrain = json.load(open(os.path.join(WORLD, 'terrain.json')))
    gen = Image.open(os.path.join(WORLD, 'atlas_gen.png')).convert('RGBA')
    gb, gcols = terrain['genBase'], terrain['cols']
    grounds = [('temperate', np.array(atlas_tile(atlas, cols, 1)))]
    for v in terrain['variants']:
        if v.get('name') in ('cool', 'dry', 'lush', 'swamp'):
            t = terrain['ventry'][str(v['id'])]['1'] - gb
            grounds.append((v['name'], atlas_tile(gen, gcols, t)))
    grounds.append(('sand', atlas_tile(atlas, cols, 277)))
    own = atlas_tile(atlas, cols, SIGN_ENTRY)
    S = 4
    cell = 16 * S + 8
    W = cell * 9 + 8
    H = len(grounds) * (cell + 40) + 8
    img = Image.new('RGBA', (W, H), (40, 40, 48, 255))
    for r, (name, gr) in enumerate(grounds):
        y0 = 8 + r * (cell + 40)
        tiles = [own] + [sheet[:, d * 16:(d + 1) * 16] for d in range(8)]
        for c, t in enumerate(tiles):
            tile = Image.fromarray(gr.copy(), 'RGBA')
            if c > 0:
                tile.alpha_composite(Image.fromarray(t, 'RGBA'))
            else:
                tile = Image.fromarray(t, 'RGBA')
            x0 = 8 + c * cell
            img.alpha_composite(tile.resize((16 * S, 16 * S), Image.NEAREST), (x0, y0))
            img.alpha_composite(tile.resize((32, 32), Image.NEAREST), (x0, y0 + 16 * S + 4))     # as the game shows it (2x)
            img.alpha_composite(tile, (x0 + 40, y0 + 16 * S + 4))                                 # 1x
    os.makedirs(out_dir, exist_ok=True)
    p = os.path.join(out_dir, 'kanto_sign_review.png')
    img.save(p)
    print('wrote', p)


if __name__ == '__main__':
    sheet, atlas, cols = build()
    if '--review' in sys.argv:
        review(sheet, atlas, cols, sys.argv[sys.argv.index('--review') + 1])
