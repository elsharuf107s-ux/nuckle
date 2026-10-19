#!/usr/bin/env python3
"""Sheet of a tileset pair's metatiles with ids, for picking terrain pieces."""
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, str(Path(__file__).parent))
from fr import Tileset, MetatileRenderer, tileset_folders
folders = tileset_folders()
pk, sk, start, count = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
out = sys.argv[5]
R = MetatileRenderer(Tileset(folders[pk], False), Tileset(folders[sk], True))
cols = 16; S = 3
rows = -(-count // cols)
im = Image.new('RGB', (cols * (16 * S + 4), rows * (16 * S + 14)), (40, 40, 40))
d = ImageDraw.Draw(im)
for i in range(count):
    mid = start + i
    b, a = R.render(mid)
    t = b.copy(); m = a[:, :, 3:4] > 0; t[...] = np.where(m, a, t)
    bg = np.zeros((16, 16, 4), np.uint8); bg[..., :3] = 255; bg[..., 3] = 255
    bg[...] = np.where(t[:, :, 3:4] > 0, t, bg)
    tile = Image.fromarray(bg, 'RGBA').convert('RGB').resize((16 * S, 16 * S), Image.NEAREST)
    x, y = (i % cols) * (16 * S + 4), (i // cols) * (16 * S + 14)
    im.paste(tile, (x + 2, y + 12))
    beh = R.attr(mid) & 0x1FF
    d.text((x + 2, y), f'{mid}' + (f' b{beh:x}' if beh else ''), fill=(255, 255, 0))
im.save(out)
print(out)
