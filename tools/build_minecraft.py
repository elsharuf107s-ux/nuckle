#!/usr/bin/env python3
"""The Minecraft half of Redstone, built from Minecraft 1.21.4's own assets (vendor/minecraft).

Outputs (assets/mc/ and assets/sfx/):
  items.json      every item/block with its rules (tools/mcdata.py), icon and world-look indexes, recipes,
                  smelting, mobs, sprite sheet layouts
  icons.png       16x16 inventory icons (item textures, isometric block icons, the Poké Balls); icons_world.png
                  the same plus the world update's (generated worlds load it)
  blocks.png      how placed blocks look in the world, 16x24 cells (rows 8..23 are the tile, 0..7 overhang)
  steve.png       Steve's overworld poses, 24x32 frames, plus armor overlay sheets
  mobs/*.png      zombie, skeleton, creeper, spider, sheep, cow, pig, chicken sheets; the Nether's zombified
                  piglin, ghast, blaze, magma cubes (large, medium, small) and wither skeleton
  nether strips   lava_flow, nether_portal, magma, fire_strip, soul_fire (animated, items.json anim)
  back.png        Steve's battle back pic (64x64 frames), portrait.png for the inventory screen
  gui/, font.png, destroy.png, particles, experience_orb.png
  ../sfx/*.ogg + sfx.json
  The End (tools/build_end_assets.py): enderman and silverfish sheets, end/ (the dragon, crystal, cage, beam, portal
  starfield, void, breath cloud), p_portal, p_dragon_breath, the pink boss bar, ../music/the_end.ogg and end_boss.ogg

  --items   fast path: rebuild only icons, block looks, GUI, sounds and items.json (seconds instead of
            minutes), reusing Steve, the back pic and the mob sheets already built
  --mobs    the same plus every mob sheet (Overworld and Nether), still reusing Steve and the back pic
  --end     (with --items or --mobs) also re-render the dragon and crystal sheets (otherwise reused once built)
  --wither  (with --items or --mobs) also re-render the Wither's sheets (otherwise reused once built)
  The Wither update (tools/build_wither_assets.py): wither/ (the Wither, its armour layer and shadow, the skulls, the
  beacon beam, the Nether star's shimmer), the purple boss bar, withered hearts, effect icons, the beacon screen
  --music   re-encode the End's music (a full build encodes it when missing)
  --armor   (with --items or --mobs) also renders the netherite armor overlays against the saved steve.png;
            done automatically when an armor material's sheets are missing
  --skins   only the co-op skins: Alex, Zuri, Sunny, Noor, Makena, Kai, Efe and Ari through Steve's own
            pipeline into skins/ (sheets, held-item maps and armor overlays where they differ from
            Steve's, back pics, portraits) and a 'skins' entry appended to items.json; checks first
            that the pipeline still reproduces Steve's saved sheets exactly. Run it again after a full
            build changes Steve.
"""
import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import mcmodel as M  # noqa: E402
import models  # noqa: E402
import mcdata as D  # noqa: E402
import build_end_assets as EA  # noqa: E402
import build_wither_assets as WA  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
MCV = HERE / 'vendor' / 'minecraft'
TX = MCV / 'jar' / 'assets' / 'minecraft' / 'textures'
FR = HERE / 'vendor' / 'pokefirered'
OUT = HERE / 'assets' / 'mc'
SFX = HERE / 'assets' / 'sfx'
R = math.radians

GRASS_TINT = (145, 189, 89)     # plains biome grass colour
LEAF_TINT = (119, 171, 47)


def save(arr, path):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr, 'RGBA').save(path, optimize=True)


def tex(name):
    if '/' in name:      # 'item/<name>' or 'block/<name>': that folder only (sugar cane's item picture, not its grey block)
        a = np.array(Image.open(TX / f'{name}.png').convert('RGBA'))
        return a[:16, :16] if a.shape[0] > 16 else a
    for sub in ('block', 'item'):
        p = TX / sub / f'{name}.png'
        if p.exists():
            a = np.array(Image.open(p).convert('RGBA'))
            return a[:16, :16] if a.shape[0] > 16 else a   # animated textures: first frame
    raise FileNotFoundError(name)


def shade(t, s):
    o = t.copy(); o[:, :, :3] = np.clip(o[:, :, :3].astype(float) * s, 0, 255).astype(np.uint8); return o


def rows(t, n, k0=0.0):
    """Sample n rows from a texture (nearest), for foreshortened faces."""
    idx = np.clip(((np.arange(n) + 0.5) * t.shape[0] / n).astype(int), 0, t.shape[0] - 1)
    return t[idx]


def cols(t, n):
    idx = np.clip(((np.arange(n) + 0.5) * t.shape[1] / n).astype(int), 0, t.shape[1] - 1)
    return t[:, idx]


def blit(dst, src, x, y):
    h, w = src.shape[:2]
    for yy in range(h):
        for xx in range(w):
            Y, X = y + yy, x + xx
            if 0 <= Y < dst.shape[0] and 0 <= X < dst.shape[1] and src[yy, xx, 3] > 0:
                dst[Y, X] = src[yy, xx]


def grade(img, gain=1.1, sat=1.2, lift=8):
    out = img.copy().astype(float); rgb = out[:, :, :3]; g = rgb.mean(axis=2, keepdims=True)
    rgb = g + (rgb - g) * sat; rgb = rgb * gain + lift; out[:, :, :3] = np.clip(rgb, 0, 255)
    return out.astype(np.uint8)


# ---------------------------------------------------------------- isometric inventory icons
def iso(top, left, right, scale=10.4, box=((-0.5, 0.5), (-0.5, 0.5), (-0.5, 0.5))):
    """A block as Minecraft's GUI draws it: rotated 30 degrees down and 45 round, top lit, the left face
    in half shade and the right face darker. Nearest texel per pixel, 16x16."""
    out = np.zeros((16, 16, 4), np.uint8)
    Rm = M.rot_x(R(30)) @ M.rot_y(R(-45))
    RT = Rm.T
    (x0, x1), (y0, y1), (z0, z1) = box
    lo, hi = np.array([x0, y0, z0]), np.array([x1, y1, z1])
    cy = (y0 + y1) / 2
    for py in range(16):
        for px in range(16):
            oc = np.array([(px + 0.5 - 8) / scale, -(py + 0.5 - 8.4) / scale + cy * 0.0, 10.0])
            o, d = RT @ oc, RT @ np.array([0.0, 0.0, -1.0])
            tmin, tmax, face = -1e9, 1e9, None
            ok = True
            for a in range(3):
                if abs(d[a]) < 1e-9:
                    if o[a] < lo[a] or o[a] > hi[a]:
                        ok = False
                    continue
                t1, t2 = (lo[a] - o[a]) / d[a], (hi[a] - o[a]) / d[a]
                f = (a, 0 if t1 < t2 else 1)
                if min(t1, t2) > tmin:
                    tmin, face = min(t1, t2), f
                tmax = min(tmax, max(t1, t2))
            if not ok or tmin > tmax or face is None:
                continue
            p = o + d * tmin
            u = lambda v, a: (v - lo[a]) / (hi[a] - lo[a])
            if face == (1, 1):
                t, s, c, r = top, 1.0, u(p[0], 0), u(p[2], 2)
            elif face == (2, 1):
                t, s, c, r = left, 0.8, u(p[0], 0), 1 - u(p[1], 1)
            elif face == (0, 1):
                t, s, c, r = right, 0.62, 1 - u(p[2], 2), 1 - u(p[1], 1)
            else:
                continue
            th, tw = t.shape[:2]
            px_ = t[min(th - 1, int(r * th)), min(tw - 1, int(c * tw))]
            if px_[3] < 128:
                continue
            out[py, px] = shade(px_[None, None], s)[0, 0]
    return out


def chest_faces():
    t = np.array(Image.open(TX / 'entity/chest/normal.png').convert('RGBA'))
    top = t[0:14, 28:42]
    front = np.vstack([t[14:19, 42:56], t[33:43, 42:56]])
    lock = t[1:5, 1:3]
    front = front.copy(); blit(front, lock, 6, 2)
    side = np.vstack([t[14:19, 28:42], t[33:43, 28:42]])
    return top, front, side


def custom_icon(spec):
    kind = spec.split(':')[1]
    if kind == 'chest':
        top, front, side = chest_faces()
        return iso(top, front, side, box=((-7 / 16, 7 / 16), (-0.5, 7 / 16 - 1 / 16), (-7 / 16, 7 / 16)))
    if kind == 'bed':
        t = np.array(Image.open(TX / 'entity/bed/white.png').convert('RGBA'))
        top = np.vstack([t[6:22, 6:22], t[28:44, 6:22]])[::2]
        side = np.hstack([np.rot90(t[6:22, 0:6], 1), np.rot90(t[28:44, 0:6], 1)])
        return iso(top, side[:, :16], side[:, 16:], box=((-0.5, 0.5), (-0.5, 0.06), (-0.5, 0.5)))
    if kind == 'fence':
        p = tex(spec.split(':')[2])
        out = np.zeros((16, 16, 4), np.uint8)
        for bx in (2, 10):
            post = shade(p[0:14, 6:10], 0.85)
            blit(out, post, bx, 1)
            blit(out, p[0:1, 6:10], bx, 0)
        for ry in (4, 9):
            blit(out, shade(p[ry:ry + 2, 0:16], 0.95)[:, 2:14], 2, ry)
        return out
    if kind == 'dragon_egg':
        return EA.egg_icon(iso)
    if kind == 'portal_frame':
        return iso(tex('end_portal_frame_top'), tex('end_portal_frame_side'), tex('end_portal_frame_side'), box=((-0.5, 0.5), (-0.5, 0.3125), (-0.5, 0.5)))
    if kind == 'end_portal':
        return EA.portal_cell(0, 40, 40)
    if kind == 'wither_skull':
        return WA.skull_icon(iso)
    if kind == 'beacon':
        return WA.beacon_icon(iso, tex)
    if kind == 'button':
        s = tex('stone')
        return iso(s, s, s, box=((-0.19, 0.19), (-0.5, -0.38), (-0.12, 0.12)), scale=18)
    raise KeyError(spec)


def pret_icon(path):
    im = Image.open(FR / path)
    pal = im.getpalette()
    idx = np.array(im)[:16, :16]
    out = np.zeros((16, 16, 4), np.uint8)
    for i in range(16):
        out[idx == i, :3] = pal[i * 3:i * 3 + 3]
        out[idx == i, 3] = 0 if i == 0 else 255
    return out


def fr_icon(png, pal):
    """A FireRed bag icon (24x24, indexed) coloured with that item's own palette and boxed down to 16x16."""
    idx = np.array(Image.open(FR / 'graphics' / 'items' / 'icons' / f'{png}.png'))
    lines = open(FR / 'graphics' / 'items' / 'icon_palettes' / f'{pal}.pal').read().split('\n')[3:]
    cols = [tuple(int(v) for v in l.split()[:3]) for l in lines if l.strip()]
    big = np.zeros(idx.shape + (4,), np.uint8)
    for i, c in enumerate(cols):
        big[idx == i, :3] = c
        big[idx == i, 3] = 0 if i == 0 else 255
    im = Image.fromarray(big).resize((16, 16), Image.BOX)
    a = np.array(im)
    a[..., 3] = np.where(a[..., 3] > 110, 255, 0)
    return a


def icon_for(it):
    s = it['icon']
    if s.startswith('fr:'):
        _, png, pal = s.split(':')
        return fr_icon(png, pal)
    if s.startswith('item:'):
        return tex(s[5:])
    if s.startswith('block:'):
        top, front, side = s[6:].split(',')
        tt = tex(top)
        if top == 'grass_block_top':
            tt = tint(tt, GRASS_TINT)
        if top == 'oak_leaves':
            leaf = tint(tt, LEAF_TINT)
            return iso(leaf, leaf, leaf)
        return iso(tt, tex(front), tex(side))
    if s.startswith('pret:'):
        return pret_icon(s[5:])
    if s.startswith('atlas:'):
        return world_tile(int(s[6:]))
    if s.startswith('tint:'):       # 'tint:<texture>:r,g,b' a grey texture Minecraft colours at runtime (the lily pad)
        _, name, rgb = s.split(':')
        return tint(tex(name), tuple(int(v) for v in rgb.split(',')))
    return custom_icon(s)


# ---------------------------------------------------------------- Kanto tiles (assets/world, built first)
WORLD = HERE / 'assets' / 'world'
_world_imgs = {}


def world_img(name):
    if name not in _world_imgs:
        _world_imgs[name] = np.array(Image.open(WORLD / name).convert('RGBA'))
    return _world_imgs[name]


def world_tile(i):
    """Atlas entry i as it looks in the world: the layer below Steve with the layer above laid over it."""
    cols = world_img('atlas.png').shape[1] // 16
    y, x = (i // cols) * 16, (i % cols) * 16
    out = world_img('atlas.png')[y:y + 16, x:x + 16].copy()
    top = world_img('atlas_top.png')[y:y + 16, x:x + 16]
    m = top[:, :, 3] > 0
    out[m] = top[m]
    return out


def tint(t, rgb):
    o = t.copy(); o[:, :, :3] = (o[:, :, :3].astype(float) * np.array(rgb) / 255).astype(np.uint8); return o


# ---------------------------------------------------------------- how blocks look in the world
CELL_W, CELL_H, OVER = 16, 24, 8           # a block cell: 8 rows of overhang above the 16-row tile
K_TOP = 7                                  # rows a full block's top face takes (16 deep x 0.45)


def raised(top, front, width=16, height=16, depth=16, x0=None):
    """A block standing on its tile: its front face fills the tile, the foreshortened top sits above."""
    cell = np.zeros((CELL_H, CELL_W, 4), np.uint8)
    x0 = (16 - width) // 2 if x0 is None else x0
    tr = max(1, round(depth * 0.45))
    t = shade(rows(cols(top, width), tr), 1.06)
    f = shade(rows(cols(front, width), height), 0.9)
    y_front = CELL_H - height
    cell[y_front - tr:y_front, x0:x0 + width] = t
    cell[y_front:CELL_H, x0:x0 + width] = f
    # a hint of edge so blocks read against FireRed's grass
    edge = cell[y_front - tr:y_front - tr + 1, x0:x0 + width]
    edge[:, :, :3] = np.clip(edge[:, :, :3].astype(int) + 22, 0, 255)
    return cell


def flush(top):
    cell = np.zeros((CELL_H, CELL_W, 4), np.uint8)
    cell[OVER:, :] = top
    return cell


def sprite(t, lift=0):
    cell = np.zeros((CELL_H, CELL_W, 4), np.uint8)
    blit(cell, t, 0, OVER - lift)
    return cell


def door(open_):
    top, bot = tex('oak_door_top'), tex('oak_door_bottom')
    face = np.vstack([top, bot])                       # 32 rows: a door is two blocks tall
    if not open_:
        f = rows(face, 21)
        cell = np.zeros((CELL_H, CELL_W, 4), np.uint8)
        cell[CELL_H - 21:, :] = shade(f, 0.92)
        cell[CELL_H - 23:CELL_H - 21, :] = shade(rows(top[0:3], 2), 1.05)
        return cell
    f = rows(cols(face, 3), 21)
    cell = np.zeros((CELL_H, CELL_W, 4), np.uint8)
    cell[CELL_H - 21:, 0:3] = shade(f, 0.75)
    cell[CELL_H - 23:CELL_H - 21, 0:3] = shade(rows(top[0:3], 2)[:, :3], 1.0)
    return cell


def frdoor(b, open_):
    """A FireRed house door standing on its own. Closed: the door tile. Open: the jambs (the pixels the
    door's opening animation never changes) with the leaf as FireRed draws it half-way open (frame 2);
    the doorway itself is left see-through. A sliding door's panels are gone into the wall by FireRed's
    last frame, so an open one is only its frame: the jambs plus that frame's side posts and sill."""
    cell = np.zeros((CELL_H, CELL_W, 4), np.uint8)
    closed = world_tile(b['entry'])
    if not open_:
        cell[OVER:] = closed
        return cell
    frames = world_img('doors.png')[:, b['anim'] * 16:(b['anim'] + 1) * 16]
    f2, f3 = frames[16:32], frames[32:48]
    jamb = (closed[:, :, :3] == f3[:, :, :3]).all(-1)
    tile = np.zeros((16, 16, 4), np.uint8)
    tile[jamb] = closed[jamb]
    if b.get('slide'):
        post = np.zeros((16, 16), bool)
        post[:, [0, 15]] = True
        post[15:] = True
        post &= ~jamb
        tile[post] = f3[post]
    else:
        leaf = ~(f2[:, :, :3] == f3[:, :, :3]).all(-1)
        tile[leaf] = f2[leaf]
    cell[OVER:] = tile
    return cell


def fence(texname, east, west):
    p = tex(texname)
    cell = np.zeros((CELL_H, CELL_W, 4), np.uint8)
    base = CELL_H - 16
    for ry in (3, 9):
        for side, on in ((0, west), (10, east)):
            if on:
                w = 6
                cell[base + ry:base + ry + 3, side:side + w] = shade(p[ry:ry + 3, side:side + w], 0.9)
                cell[base + ry - 1:base + ry, side:side + w] = shade(p[ry:ry + 1, side:side + w], 1.08)
    cell[base:CELL_H, 6:10] = shade(p[0:16, 6:10], 0.88)
    cell[base - 2:base, 6:10] = shade(p[0:2, 6:10], 1.08)
    return cell


def bed(orient, part):
    """Beds are drawn from above (the pillow and blanket are the point of a bed) with a short side lip.
    orient: the direction from foot to head ('up' = head to the north)."""
    t = np.array(Image.open(TX / 'entity/bed/white.png').convert('RGBA'))
    head_top, foot_top = t[6:22, 6:22], t[28:44, 6:22]
    end = t[22:28, 22:38]                       # the foot end, blanket over the edge
    side_head, side_foot = t[6:22, 0:6], t[28:44, 0:6]
    rot = {'up': 0, 'left': 1, 'down': 2, 'right': 3}[orient]
    top = np.rot90(head_top if part == 'head' else foot_top, rot)
    cell = np.zeros((CELL_H, CELL_W, 4), np.uint8)
    cell[OVER - 3:OVER + 13, :] = top
    lip = 3
    if orient in ('up', 'down'):
        show_end = (orient == 'up' and part == 'foot') or (orient == 'down' and part == 'head')
        face = end if show_end else None
        if face is not None:
            cell[OVER + 13:OVER + 13 + lip] = shade(rows(face, lip), 0.85)
        cell[OVER + 13 + (lip if face is not None else 0):, 1:3] = shade(np.full((1, 2, 4), (105, 78, 44, 255), np.uint8), 1)
        cell[OVER + 13 + (lip if face is not None else 0):, 13:15] = shade(np.full((1, 2, 4), (105, 78, 44, 255), np.uint8), 1)
    else:
        s = np.rot90(side_head if part == 'head' else side_foot, -1 if orient == 'right' else 1)
        cell[OVER + 13:OVER + 13 + lip] = shade(rows(s, lip), 0.85)
    return cell


def chest_world():
    top, front, side = chest_faces()
    return raised(top, front, width=14, height=15, depth=14)


def sign_world():
    p = tex('oak_planks')
    cell = np.zeros((CELL_H, CELL_W, 4), np.uint8)
    board = shade(p[2:12, 0:16], 0.95)
    cell[CELL_H - 16:CELL_H - 6, 1:15] = board[:, 1:15]
    cell[CELL_H - 17:CELL_H - 16, 1:15] = shade(p[0:1, 1:15], 1.1)
    log = tex('oak_log')
    cell[CELL_H - 6:CELL_H, 7:9] = shade(log[0:6, 7:9], 0.8)
    return cell


def campfire_world(lit):
    log = np.array(Image.open(TX / 'block/campfire_log.png').convert('RGBA'))
    L = np.array(Image.open(TX / 'block/campfire_log_lit.png').convert('RGBA'))[:16] if lit else log
    t = np.zeros((16, 48, 4), np.uint8)
    t[:, 0:16] = log; t[:, 16:32] = L
    t[:, 32:36] = np.rot90(log[0:4, 0:16], 1)
    t[:, 36:42] = np.rot90(L[8:14, 0:16], 1)
    end, bark, litbark, ztop = (0, 4, 4, 4), (0, 0, 16, 4), (16, 0, 16, 4), (32, 0, 4, 16)
    B = []
    for x0, inner in ((1, 'left'), (11, 'right')):
        f = {'front': end, 'back': end, 'top': ztop, 'bottom': ztop, 'left': bark, 'right': bark}; f[inner] = (16, 1, 16, 4)
        B.append(M.Box(t, (0, 0), (4, 4, 16), (x0 - 8, 0, -8), faces=f))
    for z in (-7, 3):
        B.append(M.Box(t, (0, 0), (16, 4, 4), (-8, 3, z), faces={'front': litbark, 'back': litbark, 'top': bark, 'bottom': litbark, 'left': end, 'right': end}))
    B.append(M.Box(t, (0, 0), (6, 1, 16), (-3, 0, -8), faces={'top': (36, 0, 6, 16), 'bottom': (36, 0, 6, 16),
             'front': (0, 15, 6, 1), 'back': (0, 15, 6, 1), 'left': (0, 15, 1, 1), 'right': (0, 15, 1, 1)}))
    img, _, _, _ = M.render(B, yaw=0.0, size=(CELL_W, CELL_H), origin=(8, 16), k=1.0)
    return M.outline(img)


def portal_frame(eye):
    """The end portal frame (13/16 of a block tall) from above and in front; with an eye of ender sitting in its
    socket (the model's 8x8x3 eye element, textured from end_portal_frame_eye.png)."""
    cell = raised(tex('end_portal_frame_top'), tex('end_portal_frame_side'), height=13)
    if eye:
        e = tex('end_portal_frame_eye')
        y_top = CELL_H - 13 - round(16 * 0.45)              # first row of the frame's top face
        top = shade(rows(cols(e[4:12, 4:12], 8), 5), 1.2)  # the eye's top (its pupil), lightly foreshortened
        front = shade(rows(cols(e[0:3, 4:12], 8), 2), 0.95)
        cell[y_top - 1:y_top + 4, 4:12] = top               # sitting proud of the socket, 3 texels up
        cell[y_top + 4:y_top + 6, 4:12] = front
    return cell


def bars_world(texname):
    """Iron bars standing on the tile: the bars texture as an upright pane (the front face) with the bars' tops as
    a thin lip; the gaps stay see-through."""
    t = tex(texname)
    cell = np.zeros((CELL_H, CELL_W, 4), np.uint8)
    cell[CELL_H - 16:CELL_H] = shade(t, 0.95)
    lip = np.zeros((2, 16, 4), np.uint8)
    on = t[0:1, :, 3] > 0
    lip[:, on[0]] = shade(t[0:1], 1.15)[0, on[0]]
    cell[CELL_H - 18:CELL_H - 16] = lip
    return cell


def build_blocks(items):
    looks = []           # list of 16x24 cells
    index = {}

    def add(key, img):
        index[key] = len(looks); looks.append(img)

    def item_looks(id, b):
        look = b['look']
        if look == 'raised':
            top, front = tex(b['top']), tex(b['front'])
            if b.get('tint') == 'leaf':
                top, front = tint(top, LEAF_TINT), tint(front, LEAF_TINT)
            add(id, raised(top, front))
            add(id + ':flush', flush(top))
            if b.get('lit'):
                add(id + ':lit', raised(top, tex(b['lit'])))
        elif look == 'sprite':
            t = tex(b['tex'])
            add(id, sprite(tint(t, tuple(b['tint'])) if isinstance(b.get('tint'), list) else t))
        elif look == 'chest':
            add(id, chest_world())
        elif look == 'door':
            add(id, door(False)); add(id + ':open', door(True))
        elif look == 'campfire':
            add(id, campfire_world(False)); add(id + ':lit', campfire_world(True))
        elif look == 'frdoor':
            add(id, frdoor(b, False)); add(id + ':open', frdoor(b, True))
        elif look == 'fence':
            for e in (0, 1):
                for w in (0, 1):
                    add(f'{id}:{e}{w}', fence(b['tex'], e, w))
        elif look == 'bed':
            for o in ('up', 'down', 'left', 'right'):
                for part in ('head', 'foot'):
                    add(f'{id}:{o}:{part}', bed(o, part))
        elif look == 'sign':
            add(id, sign_world())
        elif look == 'frame':
            add(id, portal_frame(False)); add(id + ':eye', portal_frame(True))
        elif look == 'bars':
            add(id, bars_world(b['tex']))
        elif look == 'egg':
            add(id, EA.egg_world(CELL_W, CELL_H))
        elif look == 'endportal':
            add(id, flush(EA.portal_cell(0, 0, 0)))
        elif look == 'skull':
            # facing toward the camera (down) is the plain id, then the other three, then mounted on a wall
            add(id, WA.skull_world('down', CELL_W, CELL_H, OVER))
            for f in ('up', 'left', 'right'):
                add(f'{id}:{f}', WA.skull_world(f, CELL_W, CELL_H, OVER))
            add(id + ':wall', WA.skull_wall(CELL_W, CELL_H, OVER))
        elif look == 'beacon':
            top, front = WA.beacon_faces(tex)
            add(id, raised(top, front))
        elif look in ('liquid', 'portal'):
            # lying in the ground; the first frame of the strip, the runtime animates it (items.json anim)
            add(id, flush(tex(b['tex'])))
    # The Nether's items come after everything older (and after the floors and crops below), so the
    # look indexes Kanto already uses stay where they were.
    ids = list(items)
    first = ids.index(D.FIRST_NETHER)
    first_end = ids.index(D.FIRST_END)
    for id in ids[:first]:
        if items[id].get('block'):
            item_looks(id, items[id]['block'])
    # floors and crops
    add('farmland', flush(tex('farmland')))
    add('farmland_moist', flush(tex('farmland_moist')))
    add('dirt_path', flush(tex('dirt_path_top')))
    for s in range(8):
        add(f'wheat:{s}', sprite(tex(f'wheat_stage{s}'), lift=2))
    add('sapling_grown', sprite(tex('oak_sapling')))
    add('fire', sprite(tex('fire_0')))
    add('water_flush', flush(tex('water_still') if False else np.zeros((16, 16, 4), np.uint8)))
    for id in ids[first:first_end]:
        if items[id].get('block'):
            item_looks(id, items[id]['block'])
    for s in range(3):
        add(f'nether_wart:{s}', sprite(tex(f'nether_wart_stage{s}'), lift=2))
    # The End and the stronghold come after everything the Nether added, so older look indexes stay put
    first_wither = ids.index(D.FIRST_WITHER)
    for id in ids[first_end:first_wither]:
        if items[id].get('block'):
            item_looks(id, items[id]['block'])
    # the Wither update after The End's: its items, then soul sand with a skull on top (the summoning T)
    first_world = ids.index(D.FIRST_WORLD)
    for id in ids[first_wither:first_world]:
        if items[id].get('block'):
            item_looks(id, items[id]['block'])
    add('soul_sand:skull', WA.soul_sand_skull(raised, tex, 'down'))
    for f in ('up', 'left', 'right'):
        add(f'soul_sand:skull:{f}', WA.soul_sand_skull(raised, tex, f))
    # the world update's after the Wither's, so every older look index stays put
    for id in ids[first_world:]:
        if items[id].get('block'):
            item_looks(id, items[id]['block'])
    n = len(looks)
    per = 32
    sheet = np.zeros((-(-n // per) * CELL_H, per * CELL_W, 4), np.uint8)
    for i, img in enumerate(looks):
        sheet[(i // per) * CELL_H:(i // per + 1) * CELL_H, (i % per) * CELL_W:(i % per + 1) * CELL_W] = img
    save(sheet, OUT / 'blocks.png')
    return index


# ---------------------------------------------------------------- Steve
STEVE_SHADE = {'top': 1.15, 'front': 1.0, 'back': 1.0, 'right': 0.85, 'left': 0.85, 'bottom': 0.6}
DIRS = {'down': 0.0, 'up': math.pi, 'left': -math.pi / 2, 'right': math.pi / 2}
FW, FH, ORG = 24, 32, (12, 30)


def steve_tex():
    return models.steve_profile_skin(M.load_tex(TX / 'entity/player/wide/steve.png'))


def frame_hand(pts, dirn):
    """Hand anchor in frame pixels, and whether a held item goes behind the body."""
    x, y = pts['hand']
    behind = dirn == 'up' or dirn == 'left'
    return [round(x, 1), round(y, 1), behind]


def steve_poses():
    """(pose name, frames) where each frame is a pose dict; all poses are rendered for all 4 directions."""
    return [
        ('walk', [{}, {'leg': 32, 'arm': 26}, {'leg': -32, 'arm': -26}]),
        ('hold', [{'rarm': -24}, {'leg': 32, 'arm': 20, 'rarm': -24 - 10}, {'leg': -32, 'arm': -20, 'rarm': -24 + 10}]),
        ('swing', [{'rarm': -168}, {'rarm': -110}, {'rarm': -45}]),
        ('eat', [{'rarm': -112, 'rarm_z': 18, 'head_pitch': 6}, {'rarm': -104, 'rarm_z': 18, 'head_pitch': 0, 'bob': -0.5}]),
        ('aim', [{'rarm': -88, 'larm': -88}]),
        ('boat', [{'leg': -80, 'rarm': -60, 'larm': -60, 'bob': -2}, {'leg': -80, 'rarm': -20, 'larm': -20, 'bob': -2}]),
        ('place', [{'rarm': -70}]),
    ]


def render_humanoid(texture, pose, yaw, armor=None, thin=False, size=(FW, FH), origin=ORG, k=0.45, prop=None):
    p = dict(pose); p['thin'] = thin
    boxes, info = models.steve(texture, p, prop or models.STEVE)
    extra = []
    if armor:
        extra = armor_boxes(armor, p, prop or models.STEVE)
    img, part, depth, pts = M.render(boxes + extra, yaw=yaw, size=size, origin=origin, k=k, shade=STEVE_SHADE, extras={'hand': info['hand']})
    return img, part, depth, pts, len(boxes)


ARMOR_TEX = {}


def armor_tex(mat, layer):
    key = (mat, layer)
    if key not in ARMOR_TEX:
        sub = 'humanoid_leggings' if layer == 2 else 'humanoid'
        ARMOR_TEX[key] = M.load_tex(TX / f'entity/equipment/{sub}/{mat}.png')
    return ARMOR_TEX[key]


def armor_boxes(armor, p, prop):
    """Armor pieces as slightly inflated boxes over Steve's (chibi) body. armor = {piece: mat}."""
    out = []
    ls, bs, asx, asy, dz = prop['leg_sy'], prop['body_sy'], prop['arm_sx'], prop['arm_sy'], prop.get('dz', 1)
    adz = prop.get('arm_dz', dz)
    leg_h, body_h, arm_h = 12 * ls, 12 * bs, 12 * asy
    aw = 4 * asx
    hip = leg_h + p.get('bob', 0)
    shoulder = hip + body_h
    ra = R(-p.get('arm', 0)) if p.get('rarm') is None else R(p['rarm'])
    la = R(p.get('arm', 0)) if p.get('larm') is None else R(p['larm'])
    leg = p.get('leg', 0)
    inf = 0.5
    for piece, mat in armor.items():
        if piece == 'helmet':
            t = armor_tex(mat, 1)
            out.append(M.Box(t, (0, 0), (8, 8, 8), (-4, shoulder, -4), pivot=(0, shoulder, 0), rot=(R(p.get('head_pitch', 0)), 0, 0), inflate=inf, part='armor'))
        if piece == 'chestplate':
            t = armor_tex(mat, 1)
            out.append(M.Box(t, (16, 16), (8, 12, 4), (-4, hip, -2 * dz), (1, bs, dz), inflate=inf, part='armor'))
            out.append(M.Box(t, (40, 16), (4, 12, 4), (-4 - aw, shoulder - arm_h, -2 * asx * adz), (asx, asy, asx * adz), pivot=(-4 - aw / 2, shoulder - 0.5, 0), rot=(ra, 0, R(p.get('rarm_z', 0))), inflate=inf, part='armor'))
            out.append(M.Box(t, (40, 16), (4, 12, 4), (4, shoulder - arm_h, -2 * asx * adz), (asx, asy, asx * adz), pivot=(4 + aw / 2, shoulder - 0.5, 0), rot=(la, 0, 0), inflate=inf, part='armor', mirror=True))
        if piece == 'leggings':
            t = armor_tex(mat, 2)
            out.append(M.Box(t, (16, 16), (8, 12, 4), (-4, hip, -2 * dz), (1, bs, dz), inflate=inf * 0.6, part='armor'))
            out.append(M.Box(t, (0, 16), (4, 12, 4), (-4, p.get('bob', 0), -2 * dz), (1, ls, dz), pivot=(-2, hip, 0), rot=(R(leg), 0, 0), inflate=inf * 0.6, part='armor'))
            out.append(M.Box(t, (0, 16), (4, 12, 4), (0, p.get('bob', 0), -2 * dz), (1, ls, dz), pivot=(2, hip, 0), rot=(R(-leg), 0, 0), inflate=inf * 0.6, part='armor', mirror=True))
        if piece == 'boots':
            t = armor_tex(mat, 1)
            out.append(M.Box(t, (0, 16), (4, 12, 4), (-4, p.get('bob', 0), -2 * dz), (1, ls, dz), pivot=(-2, hip, 0), rot=(R(leg), 0, 0), inflate=inf, part='armor'))
            out.append(M.Box(t, (0, 16), (4, 12, 4), (0, p.get('bob', 0), -2 * dz), (1, ls, dz), pivot=(2, hip, 0), rot=(R(-leg), 0, 0), inflate=inf, part='armor', mirror=True))
    return out


ARMOR_MATS = ('iron', 'diamond', 'netherite')
HELD_POSES = ('hold', 'swing', 'eat', 'place', 'aim')
HS = 2   # held-item maps are at canvas resolution: two pixels per GBA pixel, one per item texel
HPAD = 8  # and reach this many GBA pixels past Steve's frame on every side (a tool held out at his side)


# how far the tool angles in toward the body (negative: out to his side), per facing: out at his side
# when he faces the camera, straight out of the fist side-on (the handle inside the hand, the fist in
# front of it); HELD_RISE tilts the handle up from level. Facing left is facing right mirrored, so 'left'
# is never used. The front and back angles keep the tool clear of his arm.
HELD_TURN = {'down': -65, 'up': -50, 'left': 0, 'right': 0}
HELD_RISE = {'down': 25, 'up': 15, 'left': 20, 'right': 20}


def held_map(t, p, yaw, dirn):
    """Where the held item lands in this frame, as Minecraft draws it: a flat 16x16 sprite gripped in the
    right fist (texel (3.5, 12) of the icon, a third of the way up a tool's handle), pointing forward
    and up out of the hand. The handle follows the arm's rotation; the sprite is rolled about the
    handle to face the camera (Minecraft extrudes it instead, which reads at its scale but not at a
    sprite's), and it is hidden wherever the body is nearer. Returns an RGBA map (R, G = item texel u, v;
    B = brightness; A = covered) and the item's tip in GBA pixels."""
    boxes, info = models.steve(t, dict(p), models.STEVE)
    img, part, depth, _ = M.render_hi(boxes, HS, yaw=yaw, size=(FW * HS, FH * HS), origin=(ORG[0] * HS, ORG[1] * HS), k=0.45, shade=STEVE_SHADE)
    piv = np.array(info['shoulder'], float)
    ra = R(p['rarm']) if p.get('rarm') is not None else R(-p.get('arm', 0.0))
    Rm = M.rot_x(ra) @ M.rot_z(R(p.get('rarm_z', 0.0)))
    beta, gamma, sc = R(HELD_TURN[dirn]), R(HELD_RISE[dirn]), 0.5
    fwd = np.array([math.sin(beta), 0.0, math.cos(beta)])
    up = np.array([0.0, 1.0, 0.0])
    e1 = math.cos(gamma) * fwd + math.sin(gamma) * up      # along the handle, toward the head
    e2 = -math.sin(gamma) * fwd + math.cos(gamma) * up     # across it
    grip = np.array([piv[0], piv[1] + 0.5 - info['arm_len'] + 1.2, 0.0])
    Ry = M.rot_y(yaw)
    gw = Ry @ (piv + Rm @ (grip - piv))
    e1 = Ry @ Rm @ e1; e2 = Ry @ Rm @ e2
    k, Z0 = 0.45, 64.0
    D = np.array([0.0, -k, -1.0])
    view = -D / np.linalg.norm(D)
    # roll about the handle toward the camera, keeping "across" on the same side
    n = view - (view @ e1) * e1
    if np.linalg.norm(n) > 1e-6:
        n /= np.linalg.norm(n)
        c = np.cross(n, e1); c /= np.linalg.norm(c)
        e2 = c if c @ e2 >= 0 else -c
    au = sc * (e1 - e2) / math.sqrt(2)                     # one texel right in the icon
    av = sc * (-e1 - e2) / math.sqrt(2)                    # one texel down
    p0 = gw - 3.5 * au - 12.0 * av
    P0, AU, AV = p0 * HS, au * HS, av * HS
    H, W = (FH + 2 * HPAD) * HS, (FW + 2 * HPAD) * HS
    sy, sx = np.mgrid[0:H, 0:W]
    X = sx + 0.5 - (ORG[0] + HPAD) * HS
    V = sy + 0.5 - (ORG[1] + HPAD) * HS
    O = np.stack([X, k * Z0 - V, np.full(X.shape, Z0)], -1)
    Minv = np.linalg.inv(np.stack([AU, AV, -D], 1))
    uvt = (O - P0) @ Minv.T
    u, v, tt = uvt[..., 0], uvt[..., 1], uvt[..., 2]
    pad = HPAD * HS
    body = np.zeros((H, W), bool); body[pad:pad + FH * HS, pad:pad + FW * HS] = img[..., 3] > 0
    bd = np.zeros((H, W)); bd[pad:pad + FH * HS, pad:pad + FW * HS] = depth
    depth = bd
    vis = (u >= 0) & (u < 16) & (v >= 0) & (v < 16) & (~body | (tt < -depth))
    nn = np.cross(AU, AV); nn /= np.linalg.norm(nn)
    lit = 0.8 + 0.2 * abs(float(nn @ view))
    out = np.zeros((H, W, 4), np.uint8)
    out[vis, 0] = np.floor(u[vis]).astype(int) * 16 + 8
    out[vis, 1] = np.floor(v[vis]).astype(int) * 16 + 8
    out[vis, 2] = int(round(lit * 255))
    out[vis, 3] = 255
    tip = p0 + 15.5 * au + 0.5 * av
    return out, [round(float(tip[0] + ORG[0]), 1), round(float(-tip[1] + k * tip[2] + ORG[1]), 1)]


def build_steve():
    frames, held, overlays, hands, layout = player_sheets(steve_tex())
    sheet = lambda fr: np.hstack(fr)
    save(sheet(frames), OUT / 'steve.png')
    save(sheet(held), OUT / 'held_uv.png')
    for (mat, piece), fr in overlays.items():
        save(sheet(fr), OUT / f'armor_{mat}_{piece}.png')
    return {'w': FW, 'h': FH, 'origin': list(ORG), 'poses': layout, 'hands': hands, 'heldPad': HPAD}


def player_sheets(t, slim=False, hide_hat=False):
    """Every overworld frame of a player skin (Steve's poses, the bed and the death topple), with the held-item
    maps, hand anchors and the armor overlay frames. slim: Alex-style arms. hide_hat: leave the skin's hat
    layer off under a helmet, as Minecraft's larger helmet hides it (Steve's sheets were built with it on)."""
    base_pose = {'slim': True} if slim else {}
    poses = [(name, [{**base_pose, **p} for p in plist]) for name, plist in steve_poses()]
    layout = {}
    frames, hands, held = [], [], []
    armor_sets = [(mat, piece) for mat in ARMOR_MATS for piece in ('boots', 'leggings', 'chestplate', 'helmet')]
    overlays = {k: [] for k in armor_sets}
    for name, plist in poses:
        layout[name] = {}
        for dirn, yaw in DIRS.items():
            layout[name][dirn] = []
            # facing left is facing right mirrored, the way sprites are drawn, so a held item is always in
            # the near hand (in 3D his right hand would be behind his body)
            flip = dirn == 'left'
            src, yaw = ('right', DIRS['right']) if flip else (dirn, yaw)
            fl = (lambda a: a[:, ::-1].copy()) if flip else (lambda a: a)
            for p in plist:
                img, part, depth, pts, nb = render_humanoid(t, p, yaw)
                base = M.outline(grade(img))
                layout[name][dirn].append(len(frames))
                frames.append(fl(base))
                hand = frame_hand(pts, src)
                if name in HELD_POSES:
                    mp, tip = held_map(t, p, yaw, src)
                    hand += tip
                else:
                    mp = np.zeros(((FH + 2 * HPAD) * HS, (FW + 2 * HPAD) * HS, 4), np.uint8)
                if flip:
                    hand = [round(FW - hand[0], 1), hand[1], hand[2]] + ([round(FW - hand[3], 1), hand[4]] if len(hand) > 3 else [])
                held.append(fl(mp))
                hands.append(hand)
                for mat, piece in armor_sets:
                    pa = {**p, 'hat': False} if hide_hat and piece == 'helmet' else p
                    full, _, _, _, _ = render_humanoid(t, pa, yaw, armor={piece: mat})
                    full = M.outline(grade(full))
                    diff = np.any(full != base, axis=2)
                    ov = np.zeros_like(full); ov[diff] = full[diff]
                    overlays[(mat, piece)].append(fl(ov))
    # lying in bed (head to the north), seen from straight above
    img = render_lying(t, base_pose)
    layout['sleep'] = {'down': [len(frames)]}; frames.append(img); hands.append([12, 20, False]); held.append(np.zeros(((FH + 2 * HPAD) * HS, (FW + 2 * HPAD) * HS, 4), np.uint8))
    for k in overlays:
        overlays[k].append(np.zeros_like(img))
    # death: topple sideways over four frames (Minecraft's death animation)
    layout['death'] = {'down': []}
    for a in (0, 30, 60, 90):
        boxes, _ = models.steve(t, dict(base_pose))
        img, part, depth, _ = M.render(boxes, yaw=0, size=(FW, FH), origin=ORG, k=0.45, shade=STEVE_SHADE)
        img = M.outline(grade(img))
        im = Image.fromarray(img).rotate(-a, resample=Image.NEAREST, center=(ORG[0] + 3, ORG[1]))
        layout['death']['down'].append(len(frames)); frames.append(np.array(im)); hands.append([0, 0, False]); held.append(np.zeros(((FH + 2 * HPAD) * HS, (FW + 2 * HPAD) * HS, 4), np.uint8))
        for k in overlays:
            overlays[k].append(np.zeros_like(img))
    return frames, held, overlays, hands, layout


def render_lying(t, base_pose=None):
    """Steve on his back with his head to the north, as seen from above: the front of the model faces
    the sky, so render the standing model's front view and lay it into the tile."""
    boxes, _ = models.steve(t, {**(base_pose or {}), 'arm': 0})
    img, part, depth, _ = M.render(boxes, yaw=0, size=(FW, FH), origin=ORG, k=0.0, shade=STEVE_SHADE)
    img = M.outline(grade(img))
    return img


def build_back():
    """FireRed's back pics are 64x64, the trainer seen from behind and a little above, cropped at the
    waist. Like Red's, Steve is turned toward the foe at the upper right: his back, his right side and
    his face in profile. Minecraft proportions, three pixels per texel."""
    t0 = M.load_tex(TX / 'entity/player/wide/steve.png')
    t = models.steve_profile_skin(t0)
    full = dict(leg_sy=1.0, body_sy=1.0, arm_sx=1.0, arm_sy=1.0, dz=1.0, arm_dz=1.0)
    back, hands, portrait = back_pics(t0, t)
    save(back, OUT / 'back.png')
    save(portrait, OUT / 'portrait.png')
    poses = BACK_POSES
    # title screen: standing easy with a diamond sword held out from his side, four pixels per texel
    S = 4
    pose = {'leg': 4, 'leg_z': 6, 'rarm': -10, 'rarm_z': -25, 'larm': 10}
    boxes, info = models.steve(t0, pose, full)
    img, part, depth, pts = M.render_hi(boxes, S, yaw=R(-20), size=(46 * S, 44 * S), origin=(28 * S, 40 * S), k=0.2, shade=STEVE_SHADE, extras={'hand': info['hand']})
    img = M.outline(grade(img, gain=1.04, sat=1.1, lift=4), part=part, depth=depth, inner=1.5 * S)
    im = Image.fromarray(img)
    sword = Image.open(TX / 'item/diamond_sword.png').convert('RGBA').transpose(Image.FLIP_LEFT_RIGHT).resize((16 * S, 16 * S), Image.NEAREST)
    hx, hy = pts['hand']
    # the flipped icon's grip is near (13, 14): put it in his hand, blade up and away from his body
    im.alpha_composite(sword, (int(round(hx - 13 * S)), int(round(hy - 14 * S))))
    save(M.outline(M.outline(np.array(im))), OUT / 'title_steve.png')
    return {'frames': [n for n, _ in poses], 'hands': hands}


# the wind-up lifts the arm up and out to his right (clear of his face); the strike and the throw reach toward the foe
BACK_POSES = [('idle', {'rarm': -20}), ('raise', {'rarm': -150, 'rarm_z': -45}), ('strike', {'rarm': -85}), ('throw', {'rarm': -110, 'rarm_z': -10})]


def back_pics(t0, t, slim=False):
    """A player skin's battle back pic strip (64x64 frames, BACK_POSES), the hand in each frame, and the
    inventory portrait. t0 is the skin, t the skin with its profile face (models.profile_skin)."""
    full = dict(leg_sy=1.0, body_sy=1.0, arm_sx=1.0, arm_sy=1.0, dz=1.0, arm_dz=1.0)
    sl = {'slim': True} if slim else {}
    poses = BACK_POSES
    out, hands = [], []
    yaw, k, S = math.pi - R(50), 0.32, 3
    # rendered at three pixels per texel directly (not upscaled), so the turned head and the raised
    # arm stay clean blocks; limbs crossing the body get a dark edge
    for name, p in poses:
        boxes, info = models.steve(t, {**sl, **p}, full)
        img, part, depth, pts = M.render_hi(boxes, S, yaw=yaw, size=(34 * S, 48 * S), origin=(17 * S, 46 * S), k=k, shade=STEVE_SHADE, extras={'hand': info['hand']})
        img = grade(img, gain=1.06, sat=1.15, lift=6)
        if name == 'idle':
            rows, cols = np.nonzero(img[:, :, 3])
            top = int(rows.min())
            head = cols[rows < top + 6 * S]
            cx = (int(head.min()) + int(head.max()) + 1) / 2
        big = M.outline(img, part=part, depth=depth, inner=1.5 * S)
        frame = np.zeros((64, 64, 4), np.uint8)
        # head near the top, left of centre so the reaching arm stays in frame; the waist runs off the bottom
        ox, oy = int(round(28 - cx)), 3 - top
        blit(frame, big, ox, oy)
        out.append(frame)
        hx, hy = pts['hand']
        hands.append([round(float(hx) + ox, 1), round(float(hy) + oy, 1)])
    # inventory portrait: front, a little turned, two pixels per texel; the legs a touch apart so both read
    boxes, _ = models.steve(t0, {**sl, 'leg_z': 3}, full)
    img, part, depth, _ = M.render_hi(boxes, 2, yaw=R(-18), size=(22 * 2, 38 * 2), origin=(11 * 2, 36 * 2), k=0.14, shade=STEVE_SHADE)
    return np.hstack(out), hands, grade(img, gain=1.04, sat=1.1, lift=4)


# ---------------------------------------------------------------- the other players' skins (co-op)
# Minecraft's other default skins in the order co-op hands them to guests (the host is Steve). Alex has
# Minecraft's slim arms; the rest use the wide model, like Steve.
SKINS = [('alex', 'slim'), ('zuri', 'wide'), ('sunny', 'wide'), ('noor', 'wide'), ('makena', 'wide'), ('kai', 'wide'), ('efe', 'wide'), ('ari', 'wide')]
SKIN_DIR = OUT / 'skins'


def _png(path):
    return np.array(Image.open(path).convert('RGBA'))


def build_skins():
    """--skins: every co-op skin through Steve's own pipeline (player_sheets, back_pics) into assets/mc/skins/,
    and items.json gains a 'skins' entry at its end; nothing that exists is rewritten. First Steve is rendered
    again in memory and compared with his saved sheets, so the shared code is proven to be what made them.
    A skin's held-item map or armor overlay that comes out identical to Steve's (or to an earlier skin's)
    is not written again; its entry names the file that already has it."""
    data = json.load(open(OUT / 'items.json'))
    st, bk = data['steve'], data['back']
    # 1. the refactored pipeline still makes Steve exactly
    frames, held, overlays, hands, layout = player_sheets(steve_tex())
    assert np.array_equal(np.hstack(frames), _png(OUT / 'steve.png')), 'steve.png differs from what the pipeline renders'
    assert np.array_equal(np.hstack(held), _png(OUT / 'held_uv.png')), 'held_uv.png differs'
    for (mat, piece), fr in overlays.items():
        assert np.array_equal(np.hstack(fr), _png(OUT / f'armor_{mat}_{piece}.png')), f'armor_{mat}_{piece}.png differs'
    assert json.loads(json.dumps(hands)) == st['hands'] and json.loads(json.dumps(layout)) == st['poses'], 'steve hands or layout differ'
    t0 = M.load_tex(TX / 'entity/player/wide/steve.png')
    back, bh, portrait = back_pics(t0, models.steve_profile_skin(t0))
    assert np.array_equal(back, _png(OUT / 'back.png')) and np.array_equal(portrait, _png(OUT / 'portrait.png')), 'back.png or portrait.png differ'
    assert json.loads(json.dumps(bh)) == bk['hands'], 'back hands differ'
    print('  steve: the shared pipeline reproduces steve.png, held_uv.png, 12 armor sheets, back.png and portrait.png exactly')
    # files by content, so identical maps are shared instead of written twice
    known = {np.hstack(held).tobytes(): 'held_uv.png'}
    for (mat, piece), fr in overlays.items():
        known[np.hstack(fr).tobytes()] = f'armor_{mat}_{piece}.png'

    def share(arr, name):
        key = arr.tobytes()
        if key not in known:
            save(arr, SKIN_DIR / name)
            known[key] = f'skins/{name}'
        return known[key]
    # where the name tag sits: the top of the head in the standing frame, in frame pixels
    walk0 = frames[layout['walk']['down'][0]]
    head_top = int(np.nonzero(walk0[:, :, 3])[0].min())
    out = {'order': ['steve'] + [n for n, _ in SKINS], 'headTop': head_top, 'list': {}}
    SKIN_DIR.mkdir(parents=True, exist_ok=True)
    for name, model in SKINS:
        slim = model == 'slim'
        t0 = M.load_tex(TX / f'entity/player/{model}/{name}.png')
        t = models.profile_skin(t0)
        frames, held, overlays, hands, lay = player_sheets(t, slim=slim, hide_hat=True)
        assert lay == layout, name + ': frame layout differs from Steve\'s'
        save(np.hstack(frames), SKIN_DIR / f'{name}.png')
        back, bh, portrait = back_pics(t0, t, slim=slim)
        save(back, SKIN_DIR / f'{name}_back.png')
        save(portrait, SKIN_DIR / f'{name}_portrait.png')
        e = {'model': model, 'sheet': f'skins/{name}.png', 'held': share(np.hstack(held), f'held_uv_{name}.png'),
             'armor': {f'{mat}_{piece}': share(np.hstack(fr), f'armor_{mat}_{piece}_{name}.png') for (mat, piece), fr in overlays.items()},
             'back': f'skins/{name}_back.png', 'backHands': bh, 'portrait': f'skins/{name}_portrait.png'}
        if json.loads(json.dumps(hands)) != st['hands']:
            e['hands'] = hands
        out['list'][name] = e
        own = sum(1 for v in [e['held'], *e['armor'].values()] if v.startswith('skins/'))
        print(f'  {name} ({model}): {len(frames)} frames, {own} of 13 held/armor maps its own' + (', own hand anchors' if 'hands' in e else ''))
    data['skins'] = out          # a new key goes at the end; every existing entry keeps its place
    json.dump(data, open(OUT / 'items.json', 'w'), separators=(',', ':'))


# ---------------------------------------------------------------- mobs
def build_mobs(only=None):
    E = TX / 'entity'
    T = lambda p: M.load_tex(E / p)
    hum = lambda texture, thin=False, arms=None: (lambda ph, extra=None: models.steve(texture, {**{'leg': 0 if ph is None else 30 * math.cos(ph), 'overlay': False, 'thin': thin,
                                                                                                      **({'arm': 0 if ph is None else 20 * math.cos(ph)} if arms is None else {'rarm': arms, 'larm': arms})}, **(extra or {})})[0])
    zombie_tex, skel_tex = T('zombie/zombie.png'), T('skeleton/skeleton.png')
    spec = {
        'zombie': dict(fn=hum(zombie_tex, arms=-80), size=(24, 32), org=(12, 30)),
        'skeleton': dict(fn=hum(skel_tex, thin=True), size=(24, 32), org=(12, 30), extra={'aim': {'rarm': -88, 'larm': -88}}),
        'creeper': dict(fn=lambda ph, extra=None: models.creeper(T('creeper/creeper.png'), ph, fuse=(extra or {}).get('fuse', 0)), size=(24, 32), org=(12, 30),
                        extra={'fuse1': {'fuse': 0.5}, 'fuse2': {'fuse': 1.0}}),
        'spider': dict(fn=lambda ph, extra=None: models.spider(T('spider/spider.png'), T('spider_eyes.png'), ph), size=(40, 24), org=(20, 21)),
        'sheep': dict(fn=lambda ph, extra=None: models.sheep(T('sheep/sheep.png'), T('sheep/sheep_fur.png'), None if ph is None else ph * 1, sheared=(extra or {}).get('sheared', False)),
                      size=(32, 28), org=(16, 25), extra={'sheared': {'sheared': True}}),
        'cow': dict(fn=lambda ph, extra=None: models.cow(T('cow/cow.png'), ph), size=(32, 30), org=(16, 27)),
        'pig': dict(fn=lambda ph, extra=None: models.pig(T('pig/pig.png'), ph), size=(32, 24), org=(16, 21)),
        'chicken': dict(fn=lambda ph, extra=None: models.chicken(T('chicken.png'), ph), size=(20, 20), org=(10, 18)),
    }
    # the world update (3.16): the husk is a zombie with its own skin; the stray a skeleton whose clothing layer
    # (stray_overlay.png, the same UV layout) is composited onto its skin at build time
    stray_tex = np.array(Image.alpha_composite(Image.open(E / 'skeleton/stray.png').convert('RGBA'),
                                               Image.open(E / 'skeleton/stray_overlay.png').convert('RGBA')), dtype=np.uint8)
    spec['husk'] = dict(fn=hum(T('zombie/husk.png'), arms=-80), size=(24, 32), org=(12, 30))
    spec['stray'] = dict(fn=hum(stray_tex, thin=True), size=(24, 32), org=(12, 30), extra={'aim': {'rarm': -88, 'larm': -88}})
    if only is None:
        spec = {k: v for k, v in spec.items() if k not in ('husk', 'stray')} | {k: spec[k] for k in ('husk', 'stray')}
    else:
        spec = {k: v for k, v in spec.items() if k in only}
    meta = {}
    for name, sp in spec.items():
        frames, layout = [], {}
        variants = [('walk', None)] + [(k, v) for k, v in sp.get('extra', {}).items()]
        for vname, extra in variants:
            layout[vname] = {}
            for dirn, yaw in DIRS.items():
                layout[vname][dirn] = []
                phases = (None, 0.0, math.pi) if vname in ('walk', 'sheared') else (None,)
                for ph in phases:
                    boxes = sp['fn'](ph, extra)
                    img, part, depth, _ = M.render(boxes, yaw=yaw, size=sp['size'], origin=sp['org'], k=0.45, shade=STEVE_SHADE)
                    img = M.outline(grade(img))
                    layout[vname][dirn].append(len(frames)); frames.append(img)
        save(np.hstack(frames), OUT / 'mobs' / f'{name}.png')
        meta[name] = {'w': sp['size'][0], 'h': sp['size'][1], 'origin': list(sp['org']), 'poses': layout}
    return meta


# ---------------------------------------------------------------- the Nether's mobs
def held_icon(img, hand, dirn, name, size=10, behind=None):
    """A mob's weapon: the item icon shrunk to `size` px with its grip (texel (3, 12)) in the projected hand.
    The blade leads on the mob's facing side; facing up or left (right hand on the far side) it goes behind
    the body. Drawn into `img` before the outline, so it gets one too."""
    ic = Image.fromarray(tex(name)).resize((size, size), Image.BOX)
    a = np.array(ic); a[..., 3] = np.where(a[..., 3] > 100, 255, 0)
    if dirn in ('down', 'left'):
        a = a[:, ::-1].copy(); gx = size - 1 - 3 * size / 16
    else:
        gx = 3 * size / 16
    gy = 12 * size / 16
    behind = dirn in ('up', 'left') if behind is None else behind
    x0, y0 = int(round(hand[0] - gx)), int(round(hand[1] - gy))
    body = img[..., 3] > 0
    for yy in range(size):
        for xx in range(size):
            Y, X = y0 + yy, x0 + xx
            if a[yy, xx, 3] and 0 <= Y < img.shape[0] and 0 <= X < img.shape[1] and not (behind and body[Y, X]):
                img[Y, X] = a[yy, xx]
    return img


def build_nether_mobs():
    """Zombified piglin, ghast, blaze, magma cube (three sizes) and wither skeleton, ray cast like the
    Overworld mobs. Pose names per sheet:
      zombified_piglin  walk (gold sword, arms at its sides), angry (arms raised, as Minecraft's aggressive pose)
      ghast             walk (mouth closed, tentacles swaying, 3 frames), shoot (mouth open, 3 frames); floats
      blaze             walk (4 frames of the rods spinning), shoot (the same, lit up as it charges)
      magma_cube_*      walk (resting), squash (landed, flattened), jump (stretched, slices apart)
      wither_skeleton   walk (stone sword), attack (sword raised)
    Ground-walkers keep the walk layout of the Overworld sheets (idle, step, step)."""
    E = TX / 'entity'
    T = lambda p: M.load_tex(E / p)
    zp, gh, ghs, bl, mg, ws = (T('piglin/zombified_piglin.png'), T('ghast/ghast.png'), T('ghast/ghast_shooting.png'), T('blaze.png'),
                               T('slime/magmacube.png'), T('skeleton/wither_skeleton.png'))
    walk3 = lambda ph: {'leg': 0 if ph is None else 30 * math.cos(ph), 'arm': 0 if ph is None else 20 * math.cos(ph)}
    PH = (None, 0.0, math.pi)

    def humanoid(fn, extra, weapon):
        def f(ph, yaw, dirn, size, org):
            boxes, info = fn({**walk3(ph), **extra(ph)})
            img, part, depth, pts = M.render(boxes, yaw=yaw, size=size, origin=org, k=0.45, shade=STEVE_SHADE, extras={'hand': info['hand']})
            if weapon:
                img = held_icon(img, pts['hand'], dirn, weapon)
            return img
        return f

    def boxed(fn):
        def f(arg, yaw, dirn, size, org):
            img, _, _, _ = M.render(fn(arg), yaw=yaw, size=size, origin=org, k=0.45, shade=STEVE_SHADE)
            return img
        return f

    def blaze_fn(age, yaw, dirn, size, org):
        # the head is drawn over the rods: its eyes are the blaze's only face, and a rod of the upper ring
        # passing in front of them at this size would leave a faceless yellow block
        full = boxed(lambda a: models.blaze(bl, a))(age, yaw, dirn, size, org)
        head = boxed(lambda a: models.blaze(bl, a)[:1])(age, yaw, dirn, size, org)
        on = head[..., 3] > 0
        full[on] = head[on]
        return full

    piglin = lambda pose: models.zombified_piglin(zp, {**pose, 'overlay': True})
    wither = lambda pose: models.steve(ws, {**pose, 'thin': True, 'overlay': False}, models.WITHER)
    lit = lambda img: grade(img, gain=1.25, sat=1.1, lift=30)
    spec = {
        'zombified_piglin': dict(size=(28, 34), org=(14, 31), poses=[
            ('walk', PH, humanoid(piglin, lambda ph: {}, 'golden_sword')),
            ('angry', PH, humanoid(piglin, lambda ph: {'rarm': -80, 'larm': -80}, 'golden_sword'))]),
        'ghast': dict(size=(48, 72), org=(24, 70), fly=True, poses=[
            ('walk', (0.0, 7.0, 14.0), boxed(lambda age: models.ghast(gh, age, s=2.0, tent=0.7))),
            ('shoot', (0.0, 7.0, 14.0), boxed(lambda age: models.ghast(ghs, age, s=2.0, tent=0.7)))]),
        'blaze': dict(size=(32, 40), org=(16, 37), fly=True, poses=[
            ('walk', (0.0, 5.0, 10.0, 15.0), blaze_fn),
            ('shoot', (0.0, 5.0, 10.0, 15.0), blaze_fn, lit)]),
        'wither_skeleton': dict(size=(28, 42), org=(14, 39), poses=[
            ('walk', PH, humanoid(wither, lambda ph: {}, 'stone_sword')),
            ('attack', (None,), humanoid(wither, lambda ph: {'rarm': -120}, 'stone_sword'))]),
    }
    for name, sz, fs, org in (('large', 3.0, (40, 48), (20, 44)), ('medium', 2.0, (28, 32), (14, 29)), ('small', 1.0, (16, 20), (8, 17))):
        cube = lambda q, sz=sz: models.magma_cube(mg, sz, q)
        spec[f'magma_cube_{name}'] = dict(size=fs, org=org, poses=[('walk', (0.0,), boxed(cube)), ('squash', (-0.5,), boxed(cube)), ('jump', (0.35,), boxed(cube))])
    meta = {}
    for name, sp in spec.items():
        frames, layout = [], {}
        for pose in sp['poses']:
            vname, args, fn = pose[:3]
            post = pose[3] if len(pose) > 3 else None
            layout[vname] = {}
            for dirn, yaw in DIRS.items():
                layout[vname][dirn] = []
                for a in args:
                    img = fn(a, yaw, dirn, sp['size'], sp['org'])
                    img = grade(img)
                    if post:
                        img = post(img)
                    layout[vname][dirn].append(len(frames)); frames.append(M.outline(img))
        save(np.hstack(frames), OUT / 'mobs' / f'{name}.png')
        meta[name] = {'w': sp['size'][0], 'h': sp['size'][1], 'origin': list(sp['org']), 'poses': layout, **({'fly': True} if sp.get('fly') else {})}
    return meta


def build_armor_overlays(mats):
    """Armor overlay sheets for these materials without re-rendering steve.png: the bare frames are read
    back from the saved sheet and each armored render is diffed against them (as build_steve does)."""
    t = steve_tex()
    sheet = np.array(Image.open(OUT / 'steve.png').convert('RGBA'))
    sets = [(mat, piece) for mat in mats for piece in ('boots', 'leggings', 'chestplate', 'helmet')]
    overlays = {k: [] for k in sets}
    n, checked = 0, 0
    for name, plist in steve_poses():
        for dirn, yaw in DIRS.items():
            flip = dirn == 'left'
            yaw = DIRS['right'] if flip else yaw
            fl = (lambda a: a[:, ::-1].copy()) if flip else (lambda a: a)
            for p in plist:
                base = sheet[:, n * FW:(n + 1) * FW]
                if checked < 3:      # the saved sheet must be what this code renders
                    img, _, _, _, _ = render_humanoid(t, p, yaw)
                    assert (fl(M.outline(grade(img))) == base).all(), 'steve.png is out of date: run a full build'
                    checked += 1
                for mat, piece in sets:
                    full, _, _, _, _ = render_humanoid(t, p, yaw, armor={piece: mat})
                    full = fl(M.outline(grade(full)))
                    diff = np.any(full != base, axis=2)
                    ov = np.zeros_like(full); ov[diff] = full[diff]
                    overlays[(mat, piece)].append(ov)
                n += 1
    rest = sheet.shape[1] // FW - n            # the sleep and death frames carry no armor
    for (mat, piece), fr in overlays.items():
        fr += [np.zeros((FH, FW, 4), np.uint8)] * rest
        save(np.hstack(fr), OUT / f'armor_{mat}_{piece}.png')


# ---------------------------------------------------------------- the oak boat
def build_boat():
    """Minecraft's oak boat from its entity texture: a plank floor inside four sides, rendered for each
    direction it can face. 48x48 frames; the hull centre sits at (24, 27)."""
    t = M.load_tex(TX / 'entity/boat/oak.png')
    side_r, side_l = (2, 37, 28, 6), (2, 45, 28, 6)
    bow, stern = (2, 29, 16, 6), (2, 21, 18, 6)
    floor = (3, 3, 28, 16)
    wood = (2, 35, 28, 2)
    def boxes():
        b = []
        # floor (inside of the hull), seen from above
        b.append(M.Box(t, (0, 0), (28, 2, 14), (-14, 0, -7), faces={'top': floor, 'front': side_r, 'back': side_r, 'left': bow, 'right': stern, 'bottom': floor}))
        # long sides
        for z0, fc in ((-9, side_r), (7, side_l)):
            b.append(M.Box(t, (0, 0), (28, 6, 2), (-14, 0, z0), faces={'front': fc, 'back': fc, 'top': wood, 'bottom': wood, 'left': (2, 35, 2, 6), 'right': (2, 35, 2, 6)}))
        # bow and stern
        b.append(M.Box(t, (0, 0), (2, 6, 16), (14, 0, -8), faces={'left': bow, 'right': bow, 'top': (2, 27, 16, 2), 'front': (2, 29, 2, 6), 'back': (2, 29, 2, 6), 'bottom': (2, 27, 16, 2)}))
        b.append(M.Box(t, (0, 0), (2, 6, 16), (-16, 0, -8), faces={'left': stern, 'right': stern, 'top': (2, 19, 16, 2), 'front': (2, 21, 2, 6), 'back': (2, 21, 2, 6), 'bottom': (2, 19, 16, 2)}))
        return b
    # Full Minecraft scale (chibi Steve fits inside) and a near top-down camera, so the hull lies on the
    # water the way the map's tiles do. Two rows: the whole boat, drawn under Steve, and its near rim
    # alone, drawn over him so he sits in it rather than on it.
    s, k, FW, FH, org = 1.1, 0.9, 48, 48, (24, 27)
    full, front = [], []
    for dirn, yaw in (('down', math.pi / 2), ('up', -math.pi / 2), ('left', math.pi), ('right', 0.0)):
        bx = boxes()
        for b in bx:
            b.pos = b.pos * s; b.scale = np.array(b.scale) * s; b.pivot = b.pivot * s
        img, part, depth, _ = M.render(bx, yaw=yaw, size=(FW, FH), origin=org, k=k, shade=STEVE_SHADE)
        img = grade(img)
        # the floor sits in the hull's shadow (Minecraft's ambient occlusion)
        img[part == 0, :3] = (img[part == 0, :3] * 0.7).astype(np.uint8)
        full.append(M.outline(img))
        # the wall nearest the camera: largest z once yawed
        Ry = M.rot_y(yaw)
        near = max(bx[1:], key=lambda b: (Ry @ (b.pos + np.array(b.scale) / 2))[2])
        rim, _, _, _ = M.render([near], yaw=yaw, size=(FW, FH), origin=org, k=k, shade=STEVE_SHADE)
        rim = grade(rim)
        # keep the outline the full boat has around those pixels
        o = full[-1].copy(); grow = rim[..., 3] > 0
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            grow = grow | np.roll(rim[..., 3] > 0, (dy, dx), (0, 1))
        o[~grow] = 0
        front.append(o)
    save(np.vstack([np.hstack(full), np.hstack(front)]), OUT / 'boat.png')


# ---------------------------------------------------------------- GUI, font, particles
def build_gui():
    g = OUT / 'gui'
    g.mkdir(parents=True, exist_ok=True)
    copies = {
        'hotbar': 'gui/sprites/hud/hotbar.png', 'hotbar_selection': 'gui/sprites/hud/hotbar_selection.png',
        'heart_container': 'gui/sprites/hud/heart/container.png', 'heart_container_blinking': 'gui/sprites/hud/heart/container_blinking.png',
        'heart_full': 'gui/sprites/hud/heart/full.png', 'heart_half': 'gui/sprites/hud/heart/half.png',
        'heart_full_blinking': 'gui/sprites/hud/heart/full_blinking.png', 'heart_half_blinking': 'gui/sprites/hud/heart/half_blinking.png',
        'heart_absorbing_full': 'gui/sprites/hud/heart/absorbing_full.png', 'heart_absorbing_half': 'gui/sprites/hud/heart/absorbing_half.png',
        'heart_poisoned_full': 'gui/sprites/hud/heart/poisoned_full.png', 'heart_poisoned_half': 'gui/sprites/hud/heart/poisoned_half.png',
        'food_empty': 'gui/sprites/hud/food_empty.png', 'food_full': 'gui/sprites/hud/food_full.png', 'food_half': 'gui/sprites/hud/food_half.png',
        'food_empty_hunger': 'gui/sprites/hud/food_empty_hunger.png', 'food_full_hunger': 'gui/sprites/hud/food_full_hunger.png', 'food_half_hunger': 'gui/sprites/hud/food_half_hunger.png',
        'armor_empty': 'gui/sprites/hud/armor_empty.png', 'armor_full': 'gui/sprites/hud/armor_full.png', 'armor_half': 'gui/sprites/hud/armor_half.png',
        'air': 'gui/sprites/hud/air.png', 'air_bursting': 'gui/sprites/hud/air_bursting.png',
        'xp_bg': 'gui/sprites/hud/experience_bar_background.png', 'xp_fill': 'gui/sprites/hud/experience_bar_progress.png',
        'inventory': 'gui/container/inventory.png', 'crafting_table': 'gui/container/crafting_table.png', 'furnace': 'gui/container/furnace.png',
        'chest': 'gui/container/generic_54.png', 'burn_progress': 'gui/sprites/container/furnace/burn_progress.png',
        'lit_progress': 'gui/sprites/container/furnace/lit_progress.png', 'slot_highlight_back': 'gui/sprites/container/slot_highlight_back.png',
        'slot_highlight_front': 'gui/sprites/container/slot_highlight_front.png', 'tooltip_bg': 'gui/sprites/tooltip/background.png',
        'tooltip_frame': 'gui/sprites/tooltip/frame.png', 'button': 'gui/sprites/widget/button.png', 'button_highlighted': 'gui/sprites/widget/button_highlighted.png',
        'recipe_button': 'gui/sprites/recipe_book/button.png', 'recipe_button_highlighted': 'gui/sprites/recipe_book/button_highlighted.png',
        'recipe_book': 'gui/recipe_book.png', 'crosshair': 'gui/sprites/hud/crosshair.png',
        'toast': 'gui/sprites/toast/advancement.png',
    }
    for k, v in copies.items():
        src = TX / v
        if src.exists():
            shutil.copyfile(src, g / f'{k}.png')
        else:
            print('  missing gui', v)
    # font: ascii.png (16x16 grid of 8x8 glyphs), widths measured the way Minecraft measures them
    a = np.array(Image.open(TX / 'font/ascii.png').convert('RGBA'))
    widths = []
    for c in range(256):
        gx, gy = (c % 16) * 8, (c // 16) * 8
        cell = a[gy:gy + 8, gx:gx + 8, 3] > 0
        cs = np.nonzero(cell.any(axis=0))[0]
        widths.append(int(cs.max()) + 2 if len(cs) else (4 if c == 32 else 0))
    shutil.copyfile(TX / 'font/ascii.png', OUT / 'font.png')
    # é lives on the accented sheet (9x12 cells, ascent 10): row 15, column 13
    acc = Image.open(TX / 'font/accented.png').convert('RGBA').crop((13 * 9, 15 * 12, 14 * 9, 16 * 12))
    acc.save(OUT / 'font_eacute.png')
    ecols = np.nonzero(np.array(acc)[:, :, 3].any(axis=0))[0]
    json.dump({'widths': widths, 'eacute': {'w': int(ecols.max()) + 2, 'dy': -3}}, open(OUT / 'font.json', 'w'))
    # destroy stages, particles, xp orbs
    save(np.hstack([np.array(Image.open(TX / f'block/destroy_stage_{i}.png').convert('RGBA')) for i in range(10)]), OUT / 'destroy.png')
    P = TX / 'particle'
    strip = lambda names: np.hstack([np.array(Image.open(P / f'{n}.png').convert('RGBA')) for n in names])
    save(strip([f'generic_{i}' for i in range(8)]), OUT / 'p_generic.png')
    save(strip([f'explosion_{i}' for i in range(16)]), OUT / 'p_explosion.png')
    save(strip([f'big_smoke_{i}' for i in range(12)]), OUT / 'p_smoke.png')
    save(strip([f'splash_{i}' for i in range(4)]), OUT / 'p_splash.png')
    save(strip([f'sweep_{i}' for i in range(8)]), OUT / 'p_sweep.png')
    for n in ('flame', 'bubble', 'critical_hit', 'heart', 'angry', 'note', 'glint', 'damage'):
        if (P / f'{n}.png').exists():
            shutil.copyfile(P / f'{n}.png', OUT / f'p_{n}.png')
    shutil.copyfile(TX / 'entity/experience_orb.png', OUT / 'experience_orb.png')
    shutil.copyfile(TX / 'entity/fishing_hook.png', OUT / 'fishing_hook.png')
    shutil.copyfile(TX / 'item/arrow.png', OUT / 'arrow.png')
    save(tex('fire_0'), OUT / 'fire.png')
    shutil.copyfile(TX / 'block' / 'campfire_fire.png', OUT / 'campfire_fire.png')   # 16x128: 8 flame frames
    # water & lava stills (animated strips) for buckets and fills
    for n in ('water_still', 'lava_still'):
        shutil.copyfile(TX / f'block/{n}.png', OUT / f'{n}.png')
    # the Nether: animated block strips (16-px frames stacked vertically, see ANIMS), particles, the fireball
    for key, a in ANIMS.items():
        if a['src'] not in ('water_still', 'lava_still'):
            shutil.copyfile(TX / f"block/{a['src']}.png", OUT / a['file'])
    for n in ('lava', 'soul_fire_flame', 'drip_hang', 'drip_fall', 'drip_land'):
        shutil.copyfile(P / f'{n}.png', OUT / f'p_{n}.png')
    save(strip([f'soul_{i}' for i in range(11)]), OUT / 'p_soul.png')
    shutil.copyfile(TX / 'item/fire_charge.png', OUT / 'fireball.png')


# Animated textures the runtime draws itself: the strip file, frame size, and Minecraft's frame order and
# ticks per frame (20 ticks a second) from the texture's .mcmeta.
ANIM_SRC = {'lava': ('lava_still', 'lava_still.png'), 'lava_flow': ('lava_flow', 'lava_flow.png'), 'portal': ('nether_portal', 'nether_portal.png'),
            'magma': ('magma', 'magma.png'), 'fire': ('fire_0', 'fire_strip.png'), 'soul_fire': ('soul_fire_0', 'soul_fire.png')}


def anims():
    out = {}
    for key, (src, file) in ANIM_SRC.items():
        w, h = Image.open(TX / f'block/{src}.png').size
        meta = json.load(open(TX / f'block/{src}.png.mcmeta')).get('animation', {})
        n = h // w
        seq = [f if isinstance(f, int) else f['index'] for f in meta.get('frames', range(n))]
        out[key] = dict(src=src, file=file, size=w, frames=n, frametime=meta.get('frametime', 1), seq=seq)
    return out


ANIMS = anims()


# ---------------------------------------------------------------- sounds
SOUNDS = {
    'dig.stone': 'dig/stone{1..4}', 'dig.wood': 'dig/wood{1..4}', 'dig.grass': 'dig/grass{1..4}', 'dig.gravel': 'dig/gravel{1..4}',
    'dig.sand': 'dig/sand{1..4}', 'dig.cloth': 'dig/cloth{1..4}', 'dig.glass': 'random/glass{1..3}',
    'step.stone': 'step/stone{1..6}', 'step.wood': 'step/wood{1..6}', 'step.grass': 'step/grass{1..6}', 'step.gravel': 'step/gravel{1..4}',
    'step.sand': 'step/sand{1..5}', 'step.cloth': 'step/cloth{1..4}',
    'pop': 'random/pop', 'break': 'random/break', 'burp': 'random/burp', 'eat': 'random/eat{1..3}', 'explode': 'random/explode{1..4}',
    'fuse': 'random/fuse', 'orb': 'random/orb', 'levelup': 'random/levelup', 'bow': 'random/bow', 'bowhit': 'random/bowhit{1..4}',
    'door_open': 'random/door_open', 'door_close': 'random/door_close', 'chest_open': 'block/chest/open', 'chest_close': 'block/chest/close{1..3}',
    'campfire': 'block/campfire/crackle{1..6}',
    'click': 'random/click', 'splash': 'random/splash', 'fizz': 'random/fizz', 'drink': 'random/drink', 'wood_click': 'random/wood_click',
    'hurt': 'damage/hit{1..3}', 'fall': 'damage/fallsmall', 'classic_hurt': 'random/classic_hurt',
    'attack.strong': 'entity/player/attack/strong{1..6}', 'attack.weak': 'entity/player/attack/weak{1..4}', 'attack.crit': 'entity/player/attack/crit{1..3}',
    'attack.sweep': 'entity/player/attack/sweep{1..7}', 'attack.knockback': 'entity/player/attack/knockback{1..4}',
    'zombie.say': 'mob/zombie/say{1..3}', 'zombie.hurt': 'mob/zombie/hurt{1..2}', 'zombie.death': 'mob/zombie/death', 'zombie.step': 'mob/zombie/step{1..5}',
    'skeleton.say': 'mob/skeleton/say{1..3}', 'skeleton.hurt': 'mob/skeleton/hurt{1..4}', 'skeleton.death': 'mob/skeleton/death', 'skeleton.step': 'mob/skeleton/step{1..4}',
    'creeper.hurt': 'mob/creeper/say{1..4}', 'creeper.death': 'mob/creeper/death',
    'spider.say': 'mob/spider/say{1..4}', 'spider.death': 'mob/spider/death', 'spider.step': 'mob/spider/step{1..4}',
    'sheep.say': 'mob/sheep/say{1..3}', 'sheep.step': 'mob/sheep/step{1..5}', 'shear': 'mob/sheep/shear',
    'cow.say': 'mob/cow/say{1..4}', 'cow.hurt': 'mob/cow/hurt{1..3}', 'cow.step': 'mob/cow/step{1..4}',
    'pig.say': 'mob/pig/say{1..3}', 'pig.death': 'mob/pig/death', 'pig.step': 'mob/pig/step{1..5}',
    'chicken.say': 'mob/chicken/say{1..3}', 'chicken.hurt': 'mob/chicken/hurt{1..2}', 'chicken.plop': 'mob/chicken/plop', 'chicken.step': 'mob/chicken/step{1..2}',
    'fire': 'fire/fire', 'ignite': 'fire/ignite', 'swim': 'liquid/swim{1..4}', 'water_splash': 'liquid/splash', 'water': 'liquid/water',
    'bucket_fill': 'item/bucket/fill{1..3}', 'bucket_empty': 'item/bucket/empty{1..3}', 'till': 'item/hoe/till{1..4}',
    'bonemeal': 'item/bonemeal/bonemeal{1..5}', 'furnace': 'block/furnace/fire_crackle{1..5}',
    # the Nether (Minecraft's sound events in the comments where the name differs)
    'dig.netherrack': 'block/netherrack/break{1..6}', 'step.netherrack': 'block/netherrack/step{1..6}',
    'dig.nether_bricks': 'block/nether_bricks/break{1..6}', 'step.nether_bricks': 'block/nether_bricks/step{1..6}',
    'dig.nether_ore': 'block/nether_ore/break{1..4}', 'step.nether_ore': 'block/nether_ore/step{1..5}',
    'dig.soul_sand': 'block/soul_sand/break{1..9}', 'step.soul_sand': 'block/soul_sand/step{1..5}',
    'dig.soul_soil': 'block/soul_soil/break{1..6}', 'step.soul_soil': 'block/soul_soil/step{1..5}',
    'dig.bone_block': 'block/bone_block/break{1..5}', 'step.bone_block': 'block/bone_block/step{1..5}',
    'dig.ancient_debris': 'block/ancient_debris/break{1..5}', 'step.ancient_debris': 'block/basalt/step{1..6}',
    'dig.netherite': 'block/netherite/break{1..4}', 'step.netherite': 'block/netherite/step{1..6}',
    'portal': 'portal/portal', 'portal_trigger': 'portal/trigger', 'portal_travel': 'portal/travel',     # block.portal.ambient / trigger / travel
    'lava': 'liquid/lava', 'lava_pop': 'liquid/lavapop', 'bucket_fill_lava': 'item/bucket/fill_lava{1..3}', 'bucket_empty_lava': 'item/bucket/empty_lava{1..3}',
    'ghast.moan': 'mob/ghast/moan{1..7}', 'ghast.hurt': 'mob/ghast/scream{1..5}', 'ghast.scream': 'mob/ghast/affectionate_scream',
    'ghast.warn': 'mob/ghast/charge', 'ghast.death': 'mob/ghast/death', 'fireball': 'mob/ghast/fireball4',   # entity.ghast.shoot = entity.blaze.shoot
    'blaze.say': 'mob/blaze/breathe{1..4}', 'blaze.hurt': 'mob/blaze/hit{1..4}', 'blaze.death': 'mob/blaze/death', 'blaze.burn': 'fire/fire',
    'magma_cube.jump': 'mob/magmacube/jump{1..4}', 'magma_cube.squish': 'mob/magmacube/big{1..4}', 'magma_cube.squish_small': 'mob/magmacube/small{1..5}',
    'magma_cube.hurt': 'mob/slime/big{1..4}', 'magma_cube.hurt_small': 'mob/slime/small{1..5}',      # entity.magma_cube.hurt / death
    'zombified_piglin.say': 'mob/zombified_piglin/zpig{1..4}', 'zombified_piglin.angry': 'mob/zombified_piglin/zpigangry{1..4}',
    'zombified_piglin.hurt': 'mob/zombified_piglin/zpighurt{1..2}', 'zombified_piglin.death': 'mob/zombified_piglin/zpigdeath',
    'wither_skeleton.say': 'mob/wither_skeleton/idle{1..3}', 'wither_skeleton.hurt': 'mob/wither_skeleton/hurt{1..4}',
    'wither_skeleton.death': 'mob/wither_skeleton/death{1..2}', 'wither_skeleton.step': 'mob/wither_skeleton/step{1..4}',
    'equip_netherite': 'item/armor/equip_netherite{1..4}',
    # ambience: the area loops (streamed in Minecraft) and the occasional moods and additions on top
    'nether_wastes.loop': 'ambient/nether/nether_wastes/ambience', 'nether_wastes.mood': 'ambient/nether/nether_wastes/mood{1..5}',
    'nether_wastes.additions': 'ambient/nether/nether_wastes/addition{1..8}',
    'soul_sand_valley.loop': 'ambient/nether/soulsand_valley/ambience', 'soul_sand_valley.mood': 'ambient/nether/soulsand_valley/mood{1..4}',
    'soul_sand_valley.additions': 'ambient/nether/soulsand_valley/whisper{1..8}',
    # The End and the stronghold (Minecraft's sound events in the comments)
    'enderman.say': 'mob/endermen/idle{1..5}', 'enderman.scream': 'mob/endermen/scream{1..4}', 'enderman.stare': 'mob/endermen/stare',
    'enderman.hurt': 'mob/endermen/hit{1..4}', 'enderman.death': 'mob/endermen/death', 'enderman.portal': ['mob/endermen/portal', 'mob/endermen/portal2'],   # entity.enderman.teleport
    'silverfish.say': 'mob/silverfish/say{1..4}', 'silverfish.hurt': 'mob/silverfish/hit{1..3}', 'silverfish.death': 'mob/silverfish/kill',
    'silverfish.step': 'mob/silverfish/step{1..4}',
    'eye_launch': 'entity/endereye/endereye_launch{1..2}', 'eye_death': 'entity/endereye/dead{1..2}',              # entity.ender_eye.launch / death
    'eye_place': 'block/end_portal/eyeplace{1..3}', 'end_portal_spawn': 'block/end_portal/endportal',            # block.end_portal_frame.fill / end_portal.spawn
    'pearl_throw': 'random/bow',                                                                                 # entity.ender_pearl.throw
    'dragon.growl': 'mob/enderdragon/growl{1..4}', 'dragon.wings': 'mob/enderdragon/wings{1..6}', 'dragon.hurt': 'mob/enderdragon/hit{1..4}',
    'dragon.death': 'mob/enderdragon/end', 'dragon.shoot': 'mob/ghast/fireball4', 'dragon_fireball.explode': 'random/explode{1..4}',
    'crystal.explode': 'random/explode{1..4}', 'bars_break': 'dig/stone{1..4}',                                  # entity.generic.explode, block.metal.break
    'dig.cobweb': 'block/cobweb/break{1..6}', 'step.cobweb': 'block/cobweb/step{1..6}',
    'dig.spawner': 'block/spawner/break{1..4}', 'step.spawner': 'block/spawner/step{1..5}',
    'cave': 'ambient/cave/cave{1..23}',                                                                          # ambient.cave (the stronghold)
    # the Wither update (Minecraft's sound events in the comments). mob/wither/* and block/beacon/* are not in setup's
    # sound list (tools/minecraft-sounds.txt): they are PENDING (see below), silent placeholders unless fetched
    'wither.ambient': 'mob/wither/idle{1..4}', 'wither.hurt': 'mob/wither/hurt{1..4}', 'wither.death': 'mob/wither/death',     # entity.wither.*
    'wither.shoot': 'mob/wither/shoot', 'wither.spawn': 'mob/wither/spawn', 'wither.break_block': 'mob/zombie/woodbreak',
    'wither_skull.explode': 'random/explode{1..4}',                                                              # entity.generic.explode
    'beacon.activate': 'block/beacon/activate', 'beacon.ambient': 'block/beacon/ambient', 'beacon.deactivate': 'block/beacon/deactivate',
    'beacon.power_select': 'block/beacon/power{1..3}',
    'paddle': 'entity/boat/paddle_water{1..8}', 'toast_in': 'ui/toast/in', 'toast_out': 'ui/toast/out', 'challenge': 'ui/toast/challenge_complete', 'cast': 'entity/bobber/castfast', 'retrieve': 'entity/bobber/retrieve{1..3}',
    # the world update, stage 7b: villagers, iron golems and the bell (Minecraft's sound events as the keys). Only the
    # job-site work sounds in setup's sound list are listed (cartography table, loom, stonecutter); the other work sounds
    # and the husk's and stray's are not fetched, so they are not listed and stay silent.
    'villager.ambient': 'mob/villager/idle{1..3}', 'villager.yes': 'mob/villager/yes{1..3}', 'villager.no': 'mob/villager/no{1..3}',
    'villager.trade': 'mob/villager/haggle{1..3}', 'villager.celebrate': 'mob/villager/yes{1..3}', 'villager.hurt': 'mob/villager/hit{1..4}',
    'villager.death': 'mob/villager/death',
    'villager.work_cartographer': 'ui/cartography_table/drawmap{1..3}', 'villager.work_shepherd': 'ui/loom/take_result{1..2}',
    'villager.work_mason': 'ui/stonecutter/cut{1..2}',
    'iron_golem.attack': 'mob/irongolem/throw', 'iron_golem.hurt': 'mob/irongolem/hit{1..4}', 'iron_golem.death': 'mob/irongolem/death',
    'iron_golem.step': 'mob/irongolem/walk{1..4}', 'iron_golem.repair': 'mob/irongolem/repair', 'iron_golem.damage': 'mob/irongolem/damage{1..2}',
    'bell.use': ['block/bell/bell_use01', 'block/bell/bell_use02'], 'bell.resonate': 'block/bell/resonate',
}


_INDEX = None

# The End's images, as A.mc keys for the runtime (src/assets.js loads every entry): key -> file under assets/mc
END_IMAGES = {
    'endPortal': 'end/end_portal.png', 'endVoid': 'end/end_void.png', 'endStarsFar': 'end/end_stars_far.png', 'endStarsNear': 'end/end_stars_near.png',
    'dragon': 'end/dragon.png', 'dragonEyes': 'end/dragon_eyes.png', 'dragonShadow': 'end/dragon_shadow.png',
    'dragonFireball': 'end/dragon_fireball.png', 'dragonBreath': 'end/dragon_breath.png',
    'crystal': 'end/crystal.png', 'crystalBase': 'end/crystal_base.png', 'crystalGlow': 'end/crystal_glow.png',
    'crystalBeam': 'end/crystal_beam.png', 'crystalCage': 'end/crystal_cage.png',
    'pPortal': 'p_portal.png', 'pDragonBreath': 'p_dragon_breath.png',
    'gui_boss_pink_background': 'gui/boss_pink_background.png', 'gui_boss_pink_progress': 'gui/boss_pink_progress.png',
}


# Sounds setup's list (tools/minecraft-sounds.txt) leaves out: never fetched unless --fetch-pending is given; until they are in
# vendor/minecraft/sounds their groups are written to sfx.json empty, which the runtime plays as silence.
PENDING_SOUNDS = ('mob/wither/', 'block/beacon/')


def pending_report():
    """The pending files still missing: (asset index path, size in bytes)."""
    idx = json.load(open(MCV / 'index19.json'))['objects']
    out = []
    for k, o in sorted(idx.items()):
        n = k[len('minecraft/sounds/'):-4] if k.startswith('minecraft/sounds/') else None
        if n and n.startswith(PENDING_SOUNDS) and not (MCV / 'sounds' / f'{n}.ogg').exists():
            out.append((k, o['size']))
    return out


def fetch_sound(n):
    """Download a sound Minecraft's asset index lists but vendor/minecraft/sounds lacks (Mojang's asset
    server, by hash), the way the vendored ones were fetched. RS_NO_FETCH=1 turns every download off."""
    global _INDEX
    import hashlib
    import os
    import subprocess
    if os.environ.get('RS_NO_FETCH'):
        return False
    if n.startswith(PENDING_SOUNDS) and '--fetch-pending' not in sys.argv:
        return False
    if _INDEX is None:
        _INDEX = json.load(open(MCV / 'index19.json'))['objects']
    o = _INDEX.get(f'minecraft/sounds/{n}.ogg')
    if not o:
        return False
    h = o['hash']
    dst = MCV / 'sounds' / f'{n}.ogg'
    dst.parent.mkdir(parents=True, exist_ok=True)
    # curl, as vendor/minecraft/curl.cfg fetched the rest (it uses the system's certificates)
    data = subprocess.run(['curl', '-sfL', '--max-time', '60', f'https://resources.download.minecraft.net/{h[:2]}/{h}'], capture_output=True).stdout
    if hashlib.sha1(data).hexdigest() != h:
        print('  download failed', n)
        return False
    dst.write_bytes(data)
    return True


def build_sounds():
    SFX.mkdir(parents=True, exist_ok=True)
    out = {}
    src = MCV / 'sounds'
    for key, pat in SOUNDS.items():
        files = []
        names = []
        for pt in (pat if isinstance(pat, list) else [pat]):
            if '{' in pt:
                base, rng = pt.split('{')
                a, b = rng.rstrip('}').split('..')
                names += [f'{base}{i}' for i in range(int(a), int(b) + 1)]
            else:
                names.append(pt)
        for n in names:
            p = src / f'{n}.ogg'
            if not p.exists() and fetch_sound(n):
                print('  downloaded', n)
            if not p.exists():
                print('  missing sound', n)
                continue
            flat = n.replace('/', '_')
            shutil.copyfile(p, SFX / f'{flat}.ogg')
            files.append(flat)
        out[key] = files
    json.dump(out, open(SFX / 'sfx.json', 'w'), indent=0)
    print(f'  {sum(len(v) for v in out.values())} sound files in {len(out)} groups')
    pend = pending_report()
    if pend:
        print(f'  {len(pend)} pending sounds (silent placeholders, not downloaded), {sum(z for _, z in pend)} bytes:')
        for k, z in pend:
            print(f'    {k} {z}')


# ---------------------------------------------------------------- items + main
def build_world_mobs():
    """--world-mobs (the world update, stage 5d): only the husk's and the stray's sheets, added to items.json's `mobs`
    and `mobSheets` in place; every other byte of items.json (and every other file) is left as it is."""
    path = OUT / 'items.json'
    data = json.load(open(path))
    meta = build_mobs(only=('husk', 'stray'))
    for k in ('husk', 'stray'):
        data['mobs'][k] = json.loads(json.dumps(D.MOBS[k]))
        data['mobSheets'][k] = meta[k]
    json.dump(data, open(path, 'w'), separators=(',', ':'))
    print('  mobs', list(meta))


def main():
    if '--skins' in sys.argv:
        build_skins()
        print('done')
        return
    if '--world-mobs' in sys.argv:
        build_world_mobs()
        print('done')
        return
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'end').mkdir(parents=True, exist_ok=True)
    items = D.ITEMS
    # the End portal's strip first: its first frame is the portal block's look and icon
    end_anim = EA.build_portal_and_void()
    # icons
    # The world update's icons start on a new row after the Wither's, and only icons_world.png (every icon) holds them;
    # generated worlds load it (src/assets.js loadGenAssets). icons.png keeps exactly the older rows: a taller sheet
    # changes how the GPU samples scaled icons (dropped items) at their cell edges, so Classic would not draw identically.
    icons = []
    per = 32
    old_rows = None
    for id, it in items.items():
        if id == D.FIRST_WORLD:
            old_rows = -(-len(icons) // per)
            icons += [None] * (old_rows * per - len(icons))
        icons.append(icon_for(it))
        it['iconIndex'] = len(icons) - 1
    sheet = np.zeros((-(-len(icons) // per) * 16, per * 16, 4), np.uint8)
    for i, ic in enumerate(icons):
        if ic is not None:
            sheet[(i // per) * 16:(i // per + 1) * 16, (i % per) * 16:(i % per + 1) * 16] = ic
    save(sheet[:old_rows * 16], OUT / 'icons.png')
    save(sheet, OUT / 'icons_world.png')
    print(f'  {len(icons)} icons')
    blocks = build_blocks(items)
    print(f'  {len(blocks)} world block looks')
    if '--items' in sys.argv or '--mobs' in sys.argv:
        # fast paths: keep the rendered Steve, back pic and boat (and their layouts in items.json); --items
        # keeps the mob sheets too, --mobs re-renders every mob sheet (the Overworld's and the Nether's)
        old = json.load(open(OUT / 'items.json'))
        steve, back, mobs = old['steve'], old['back'], old['mobSheets']
        print('  reusing steve, back' + (', mobSheets' if '--items' in sys.argv else '') + ' from items.json')
        if '--mobs' in sys.argv:
            mobs = {**build_mobs(), **build_nether_mobs(), **EA.build_end_mobs()}
            print('  mobs', list(mobs))
        elif 'enderman' not in mobs or not (OUT / 'mobs' / 'enderman_eyes.png').exists():
            mobs = {**mobs, **EA.build_end_mobs()}
            print('  End mobs', ['enderman', 'silverfish'])
        missing = [m for m in ARMOR_MATS if not (OUT / f'armor_{m}_helmet.png').exists()]
        if '--armor' in sys.argv or missing:
            # armor overlays for a material Steve's sheet has none for yet (netherite), without re-rendering him
            mats = missing or ['netherite']
            build_armor_overlays(mats)
            print('  armor overlays', mats)
    else:
        steve = build_steve()
        print('  steve', {k: len(v['down']) for k, v in steve['poses'].items()})
        back = build_back()
        mobs = {**build_mobs(), **build_nether_mobs(), **EA.build_end_mobs()}
        build_boat()
        print('  mobs', list(mobs))
    build_gui()
    build_sounds()
    # The End's big sprites: the dragon and the crystal are re-rendered with --end (or a full build, or when missing)
    try:
        old_end = json.load(open(OUT / 'items.json')).get('end')
    except Exception:
        old_end = None
    full = not ('--items' in sys.argv or '--mobs' in sys.argv)
    if full or '--end' in sys.argv or not old_end or not (OUT / 'end' / 'dragon.png').exists():
        end = {'dragon': EA.build_dragon(), **EA.build_crystal(), **EA.build_fx()}
        print('  End sprites: dragon', end['dragon']['w'], 'x', end['dragon']['h'], 'frames;', len(end['dragon']['rows']), 'rows')
    else:
        end = old_end
        EA.build_fx()
        print('  reusing the dragon and crystal layouts from items.json')
    end['images'] = END_IMAGES
    # the Wither update: its sheets are re-rendered with --wither (or a full build, or when missing)
    try:
        old_w = json.load(open(OUT / 'items.json')).get('wither')
    except Exception:
        old_w = None
    gui_w = WA.build_gui()
    star = icons[list(items).index('nether_star')]
    if full or '--wither' in sys.argv or not old_w or not (OUT / 'wither' / 'wither.png').exists():
        wither = WA.build_all(star)
        print('  Wither sprites:', wither['body']['w'], 'x', wither['body']['h'], 'frames;', len(wither['body']['rows']), 'rows')
    else:
        wither = {k: old_w[k] for k in ('body', 'skull', 'beam', 'glint')}
        print('  reusing the Wither layouts from items.json')
    wither['images'] = {**{k: 'wither/' + v.split('/', 1)[1] for k, v in WA.IMAGES.items()}, **gui_w}
    wither['beaconScreen'] = WA.BEACON_SCREEN
    wither['effects'] = list(WA.EFFECTS)
    wither['beaconBase'] = D.BEACON_BASE
    if full or '--music' in sys.argv:
        EA.build_end_music(fetch_sound, force='--music' in sys.argv)
    data = {'items': items, 'recipes': D.RECIPES, 'tags': D.TAGS, 'smelt': D.SMELT, 'campfire': D.CAMPFIRE, 'mobs': D.MOBS, 'blocks': blocks,
            'steve': steve, 'back': back, 'mobSheets': mobs, 'cell': [CELL_W, CELL_H, OVER], 'anim': {**ANIMS, **end_anim}, 'end': end, 'wither': wither}
    try:
        old_skins = json.load(open(OUT / 'items.json')).get('skins')
    except Exception:
        old_skins = None
    if old_skins:
        data['skins'] = old_skins      # built by --skins (run it again after a full build changes Steve)
    json.dump(data, open(OUT / 'items.json', 'w'), separators=(',', ':'))
    print('done')


if __name__ == '__main__':
    main()
