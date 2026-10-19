#!/usr/bin/env python3
"""The four small assets no other build tool writes.

  assets/ui/favicon.png      the closed Poké Ball: pret graphics/interface/ball/poke.png, first 16x16 frame
  assets/ui/heal_ball.png    the Poké Ball on the healing machine: pret graphics/field_effects/pics/pokeball_glow.png
  assets/ui/title_logo.png   FireRed's title logo: pret graphics/title_screen/firered/game_title_logo.{png,pal,bin},
                             the 8bpp background tilemap (32 tiles wide, colour 0 transparent) cropped to 176x59
  assets/mc/forcefield.png   Minecraft's world-border texture, textures/misc/forcefield.png, copied as it is

Reads only vendor/ (run ./setup.sh first). Writes PNGs with Pillow's defaults, like the files the game was made with.
"""
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fr as B  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FR = B.FR
UI = ROOT / 'assets' / 'ui'
MC = ROOT / 'assets' / 'mc'
TX = ROOT / 'vendor' / 'minecraft' / 'jar' / 'assets' / 'minecraft' / 'textures'


def title_logo():
    d = FR / 'graphics' / 'title_screen' / 'firered'
    idx = B.load_indexed(d / 'game_title_logo.png')
    pal = B.read_pal(d / 'game_title_logo.pal')
    h, w = idx.shape
    tiles = idx.reshape(h // 8, 8, w // 8, 8).transpose(0, 2, 1, 3).reshape(-1, 8, 8)
    ents = np.fromfile(d / 'game_title_logo.bin', dtype='<u2')
    lut = np.array((pal + [(0, 0, 0)] * 256)[:256], np.uint8)
    out = np.zeros((len(ents) // 32 * 8, 256, 4), np.uint8)
    for i, e in enumerate(ents):
        e = int(e)
        t = tiles[e & 0x3FF]
        if (e >> 10) & 1:       # horizontal flip
            t = t[:, ::-1]
        if (e >> 11) & 1:       # vertical flip
            t = t[::-1, :]
        y, x = (i // 32) * 8, (i % 32) * 8
        out[y:y + 8, x:x + 8] = np.dstack([lut[t], (t != 0).astype(np.uint8) * 255])
    return Image.fromarray(out[:59, :176], 'RGBA')


def main():
    UI.mkdir(parents=True, exist_ok=True)
    MC.mkdir(parents=True, exist_ok=True)
    B.colorize_self(FR / 'graphics/interface/ball/poke.png').crop((0, 0, 16, 16)).save(UI / 'favicon.png')
    B.colorize_self(FR / 'graphics/field_effects/pics/pokeball_glow.png').save(UI / 'heal_ball.png')
    title_logo().save(UI / 'title_logo.png')
    shutil.copyfile(TX / 'misc' / 'forcefield.png', MC / 'forcefield.png')
    print('  favicon.png, heal_ball.png, title_logo.png, forcefield.png')
    print('done')


if __name__ == '__main__':
    main()
