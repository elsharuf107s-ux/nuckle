#!/usr/bin/env python3
"""Render painted generator dumps (design 4.8, stage 3b) with the real atlases.

  python3 tools/gen_render.py DUMP_DIR --crop x,y,w,h [--out file.png] [--scale 1]
      a 1:1 crop (16 px per cell) of the painted cells, x and y in overworld-local cells (inside the dump's rect):
      every cell's ground under an overlay entry, the entry, decorations (their sprite overlays; dandelions and
      poppies, which have no art yet, as small yellow and red marks), then the top layers
  python3 tools/gen_render.py DUMP_DIR --overview [--out file.png] [--px 800]
      the whole dump at 1 pixel per cell, each entry drawn as its mean colour (then resized to --px)
  python3 tools/gen_render.py --sheet out.png a.png b.png ... [--cols 2] [--labels "a|b|..."]
      a contact sheet of rendered crops with captions

A dump is written by `node tools/gen_dump.mjs --paint ...` (tile.bin and ground.bin u16, deco.bin u8, meta.json).
"""
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
WD = ROOT / 'assets' / 'world'
TILE = 16


class Bank:
    def __init__(self):
        W = json.load(open(WD / 'world.json'))
        T = json.load(open(WD / 'terrain.json'))
        self.T = T
        self.cols = W['cols']
        self.base = T['genBase']
        self.gcols = T['cols']
        self.wentries = W['entries']
        self.gentries = T['entries']
        self.img = {k: Image.open(WD / f).convert('RGBA') for k, f in
                    (('a', 'atlas.png'), ('at', 'atlas_top.png'), ('g', 'atlas_gen.png'), ('gt', 'atlas_gen_top.png'))}
        self.cache = {}
        self.deco = ['', 'dandelion', 'poppy', 'sugar_cane', 'cactus', 'dead_bush', 'pumpkin', 'melon', 'lily_pad']
        # (6c's ruin bricks, 7a's village blocks: chunk.js DECO's order) drawn with their placed-block looks
        self.deco += ['mossy_stone_bricks', 'cracked_stone_bricks', 'cobblestone', 'sandstone', 'farmland', 'oak_fence', 'torch',
                      'bell', 'composter', 'lectern', 'brewing_stand', 'blast_furnace', 'grindstone', 'smithing_table', 'smoker',
                      'fletching_table', 'cartography_table', 'cauldron', 'stonecutter', 'loom', 'barrel']
        MC = ROOT / 'assets' / 'mc'
        self.items = json.load(open(MC / 'items.json'))
        self.blocks = Image.open(MC / 'blocks.png').convert('RGBA')

    def look(self, name):
        bl, (cw, chh, up) = self.items['blocks'], self.items['cell']
        key = next((k for k in (name, name + ':00', name + ':flush') if k in bl), None)
        if key is None:
            return None
        i, per = bl[key], self.blocks.width // cw
        return self.blocks.crop(((i % per) * cw, (i // per) * chh, (i % per) * cw + cw, (i // per) * chh + chh)), up
        self.kgrid = np.frombuffer(open(WD / 'grid.bin', 'rb').read(), dtype=np.uint16).reshape(-1, 408)

    def row(self, t):
        return self.gentries[t - self.base] if t >= self.base else self.wentries[t]

    def ov(self, t):
        return t >= self.base and self.gentries[t - self.base][10] == 1

    def above(self, t):
        return bool(self.row(t)[6])

    def tile(self, t, top=False):
        k = (t, top)
        if k not in self.cache:
            if t >= self.base:
                i = t - self.base
                im = self.img['gt' if top else 'g']
                c = self.gcols
            else:
                i = t
                im = self.img['at' if top else 'a']
                c = self.cols
            self.cache[k] = im.crop(((i % c) * TILE, (i // c) * TILE, (i % c) * TILE + TILE, (i // c) * TILE + TILE))
        return self.cache[k]

    def mean(self, t):
        k = ('m', t)
        if k not in self.cache:
            a = np.asarray(self.tile(t)).reshape(-1, 4).astype(float)
            a = a[a[:, 3] > 0]
            self.cache[k] = tuple(int(v) for v in (a[:, :3].mean(0) if len(a) else (0, 0, 0)))
        return self.cache[k]


def load(d):
    d = Path(d)
    meta = json.load(open(d / 'meta.json'))
    x0, y0, w, h = meta['rect']
    rd = lambda f, t: np.frombuffer(open(d / f, 'rb').read(), dtype=t).reshape(h, w)
    return meta, rd('tile.bin', np.uint16), rd('ground.bin', np.uint16), rd('deco.bin', np.uint8)


def crop(B, meta, tile, ground, deco, cx, cy, cw, ch):
    x0, y0 = meta['rect'][:2]
    im = Image.new('RGBA', (cw * TILE, ch * TILE), (0, 0, 0, 255))
    tops = []
    kan = meta.get('kanto')
    for y in range(ch):
        for x in range(cw):
            gx, gy = cx + x - x0, cy + y - y0
            t = int(tile[gy, gx])
            px, py = x * TILE, y * TILE
            if t == 0 and kan:
                kx, ky = cx + x - kan['x'], cy + y - kan['y']
                if 0 <= kx < 408 and 0 <= ky < 400:
                    t = int(B.kgrid[ky, kx])
            if B.ov(t):
                im.alpha_composite(B.tile(int(ground[gy, gx])), (px, py))
            im.alpha_composite(B.tile(t), (px, py))
            if B.above(t):
                tops.append((t, px, py))
            d = int(deco[gy, gx])
            if d:
                name = B.deco[d]
                sp = B.T['synth']['sprites'].get(name)
                if sp:
                    im.alpha_composite(B.tile(sp['ov']), (px, py))
                    if name == 'cactus' and y > 0:
                        tops.append((B.T['synth']['sprites']['cactus_top']['ov'], px, py - TILE, 'base'))
                elif d >= 9 and B.look(name):
                    lk, up = B.look(name)
                    tops.append((lk, px, py - up, 'look'))
                elif d >= 9:
                    dr = ImageDraw.Draw(im)
                    dr.rectangle((px + 2, py + 2, px + 13, py + 13), fill=(160, 60, 200, 255))
                    dr.text((px + 4, py + 2), name[:2], fill=(255, 255, 255, 255))
                else:
                    dr = ImageDraw.Draw(im)
                    col = (250, 220, 40, 255) if name == 'dandelion' else (220, 40, 40, 255)
                    dr.rectangle((px + 6, py + 6, px + 9, py + 9), fill=col)
    for item in tops:
        if len(item) == 4 and item[3] == 'look':
            im.alpha_composite(item[0], (item[1], max(0, item[2])))
            continue
        if len(item) == 4:
            im.alpha_composite(B.tile(item[0]), (item[1], item[2]))
            continue
        t, px, py = item
        im.alpha_composite(B.tile(t, True), (px, py))
    return im


def overview(B, tile, px):
    h, w = tile.shape
    ids = np.unique(tile)
    lut = np.zeros((int(ids.max()) + 1, 3), np.uint8)
    for t in ids:
        lut[t] = B.mean(int(t))
    im = Image.fromarray(lut[tile], 'RGB')
    if px and px != w:
        im = im.resize((px, int(px * h / w)), Image.NEAREST)
    return im


def sheet(out, files, cols=2, labels=None):
    ims = [Image.open(f).convert('RGB') for f in files]
    cw = max(i.width for i in ims)
    chh = max(i.height for i in ims) + 14
    rows = (len(ims) + cols - 1) // cols
    S = Image.new('RGB', (cw * cols + 4 * (cols - 1), chh * rows), (255, 255, 255))
    dr = ImageDraw.Draw(S)
    for k, im in enumerate(ims):
        x, y = (k % cols) * (cw + 4), (k // cols) * chh
        S.paste(im, (x, y + 14))
        dr.text((x + 2, y + 1), (labels[k] if labels else Path(files[k]).stem), fill=(0, 0, 0))
    S.save(out)


def main(a):
    opt = lambda n, d=None: a[a.index(n) + 1] if n in a else d
    if a[0] == '--sheet':
        out = a[1]
        files = [f for f in a[2:] if f.endswith('.png') and not f.startswith('--')]
        labels = opt('--labels')
        sheet(out, files, int(opt('--cols', 2)), labels.split('|') if labels else None)
        return
    B = Bank()
    meta, tile, ground, deco = load(a[0])
    out = opt('--out', str(Path(a[0]) / ('overview.png' if '--overview' in a else 'crop.png')))
    if '--overview' in a:
        overview(B, tile, int(opt('--px', 800))).save(out)
    else:
        cx, cy, cw, ch = (int(v) for v in opt('--crop').split(','))
        im = crop(B, meta, tile, ground, deco, cx, cy, cw, ch)
        sc = float(opt('--scale', 1))
        if sc != 1:
            im = im.resize((int(im.width * sc), int(im.height * sc)), Image.NEAREST)
        im.convert('RGB').save(out)
    print(out)


if __name__ == '__main__':
    main(sys.argv[1:])
