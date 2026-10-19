#!/usr/bin/env python3
"""The ENDER DRAGON as a POKéMON (spec section 8): its FireRed graphics, cry and battle background, all made
from Minecraft's own dragon (EnderDragonModel and entity/enderdragon textures, the growl sounds) and the
pret/pokefirered decomp, and the Hall of Fame pieces (spec section 9). tools/build_pokemon.py calls build_all().

Outputs:
  assets/mon/ender_dragon_front.png, _back.png (64x64), _front_shiny.png, _back_shiny.png, _icon.png (32x64, two frames)
  assets/sprites/ow_ender_dragon.png, ow_ender_dragon_shiny.png   the follower: 6 frames of 32x32 like the expansion's sheets
  assets/cries/ender_dragon.wav                                   8-bit mono 10512 Hz, like FireRed's cries
  assets/battle/bg_end.png                                        The End's battle background in FireRed's terrain style
  assets/ui/hof_bg.png, hof_frame.png                             FireRed's Hall of Fame backdrop and confetti

The sprites are ray cast from the model with a free camera (a 3/4 view for the front, from behind for the back), lit
from the upper left the way Gen 3 sprites are shaded, sampled down to their size, mapped onto one 16-colour palette
(colour 0 transparent, as on the GBA) and outlined the way FireRed outlines its sprites.
"""
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mcmodel as M  # noqa: E402
import models  # noqa: E402
from models import Pose, mc_cube, _dragon_head, _dragon_leg  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
TX = HERE / 'vendor' / 'minecraft' / 'jar' / 'assets' / 'minecraft' / 'textures'
SND = HERE / 'vendor' / 'minecraft' / 'sounds'
FR = HERE / 'vendor' / 'pokefirered'
OUT = HERE / 'assets'
NAME = 'ender_dragon'


# ---------------------------------------------------------------- a free camera over mcmodel's boxes
def cam(yaw=0.0, pitch=0.0, roll=0.0):
    """World (renderer frame: y up, +z toward the viewer) to view rotation: turn the model by yaw, then tip the
    camera down by pitch (positive pitch looks down on the model), then roll."""
    return M.rot_z(roll) @ M.rot_x(pitch) @ M.rot_y(yaw)


_NORMALS = {'right': (-1, 0, 0), 'left': (1, 0, 0), 'bottom': (0, -1, 0), 'top': (0, 1, 0), 'back': (0, 0, -1), 'front': (0, 0, 1)}


def view_render(boxes, R, size, origin):
    """Orthographic ray cast of the boxes seen through rotation R (view looks down -z, screen y down).
    Returns per pixel: texel rgba (unshaded), view-space normal, box index, depth and the box's part name."""
    W, H = size
    best = np.full(H * W, 1e18)
    rgba = np.zeros((H * W, 4), np.uint8)
    nrm = np.zeros((H * W, 3))
    hit = np.full(H * W, -1, np.int32)
    D = np.array([0.0, 0.0, -1.0])
    Z0 = 4096.0
    sy, sx = np.mgrid[0:H, 0:W]
    Xs = (sx + 0.5 - origin[0]).ravel()
    Ys = -(sy + 0.5 - origin[1]).ravel()
    for bi, b in enumerate(boxes):
        Mw = R @ b.matrix()
        Minv = Mw.T
        corner = R @ (b.pivot + b.matrix() @ (b.pos - b.inflate - b.pivot))
        ext = b.extent()
        cs = np.array([[i * ext[0], j * ext[1], l * ext[2]] for i in (0, 1) for j in (0, 1) for l in (0, 1)]) @ Mw.T + corner
        px = cs[:, 0] + origin[0]
        py = -cs[:, 1] + origin[1]
        x0, x1 = max(0, int(np.floor(px.min())) - 1), min(W, int(np.ceil(px.max())) + 1)
        y0, y1 = max(0, int(np.floor(py.min())) - 1), min(H, int(np.ceil(py.max())) + 1)
        if x0 >= x1 or y0 >= y1:
            continue
        idx = (np.arange(y0, y1)[:, None] * W + np.arange(x0, x1)[None, :]).ravel()
        O = np.stack([Xs[idx], Ys[idx], np.full(len(idx), Z0)], 1)
        o = (O - corner) @ Minv.T
        dd = Minv @ D
        n = len(idx)
        tmin = np.full(n, -1e18); tmax = np.full(n, 1e18)
        ent = np.full(n, -1); exi = np.full(n, -1)
        ok = np.ones(n, bool)
        for ax in range(3):
            if abs(dd[ax]) < 1e-12:
                ok &= (o[:, ax] >= 0) & (o[:, ax] <= ext[ax])
                continue
            t1 = (0 - o[:, ax]) / dd[ax]
            t2 = (ext[ax] - o[:, ax]) / dd[ax]
            lo, hi = np.minimum(t1, t2), np.maximum(t1, t2)
            m = lo > tmin
            tmin = np.where(m, lo, tmin); ent = np.where(m, ax, ent)
            m = hi < tmax
            tmax = np.where(m, hi, tmax); exi = np.where(m, ax, exi)
        ok &= (tmin <= tmax) & (ent >= 0) & (tmax >= 0)
        done = np.zeros(n, bool)
        for which in (0, 1):
            t = tmin if which == 0 else tmax
            axs = ent if which == 0 else exi
            cand = ok & ~done & (t < best[idx])
            if not cand.any():
                continue
            for ax in range(3):
                if abs(dd[ax]) < 1e-12:
                    continue
                entry_side = 0 if dd[ax] > 0 else 1
                side = entry_side if which == 0 else 1 - entry_side
                name = M._FACE_NAMES[(ax, side)]
                m = cand & (axs == ax)
                if not m.any():
                    continue
                lp = np.clip(o[m] + dd[None, :] * t[m][:, None], 0, ext)
                tx = M._sample_np(b, name, lp)
                opaque = tx[:, 3] >= 128
                sel = np.nonzero(m)[0][opaque]
                if not len(sel):
                    continue
                gi = idx[sel]
                best[gi] = t[sel]
                rgba[gi] = tx[opaque]
                nv = Mw @ np.array(_NORMALS[name], float)
                if which == 1 or nv[2] < 0:      # a back face seen through a cutout (or a plane from below): face the viewer
                    nv = -nv
                nrm[gi] = nv
                hit[gi] = bi
                done[sel] = True
    return {'rgba': rgba.reshape(H, W, 4), 'n': nrm.reshape(H, W, 3), 'part': hit.reshape(H, W),
            'depth': np.where(hit >= 0, -best, -1e9).reshape(H, W)}


# ---------------------------------------------------------------- the dragon posed for its portraits
def pose(tex, eyes, p, s=1.0):
    """EnderDragonModel posed freely (the same parts and texture boxes as models.ender_dragon). p keys:
      neck: [(xRot, yRot)] per neck segment; head: (xRot, yRot); hscale: head size; jaw
      wing: (x, y, z) shoulder rotation; tip: (x, y, z) wing-tip rotation (mirrored for the left wing)
      front, rear: leg rotations (upper, shin, foot); tail: [(xRot, yRot)] per tail segment."""
    root = Pose(None, (0, -models.DRAGON_GROUND, -models.DRAGON_CENTRE_Z))
    out = []
    x, y, z = 0.0, 20.0, -12.0
    for xr, yr in p['neck']:
        N = root.child((x, y, z), (xr, yr, 0))
        out.append(mc_cube(N, tex, (192, 104), (-5, -5, -5), (10, 10, 10), s=s, part='neck'))
        out.append(mc_cube(N, tex, (48, 0), (-1, -9, -3), (2, 4, 6), s=s, part='spike'))
        y += math.sin(xr) * 10
        z -= math.cos(yr) * math.cos(xr) * 10
        x -= math.sin(yr) * math.cos(xr) * 10
    hx, hy = p['head']
    _dragon_head(root.child((x, y, z), (hx, hy, 0), p.get('hscale', 1.0)), tex, eyes, p['jaw'], s, out)
    B = root.child((0, 4, 8))
    out.append(mc_cube(B, tex, (0, 0), (-12, 0, -16), (24, 24, 64), s=s, part='body'))
    for zz in (-10, 10, 30):
        out.append(mc_cube(B, tex, (220, 53), (-1, -6, zz), (2, 6, 12), s=s, part='spike'))
    for side in (-1, 1):
        wr = p.get('wing_r' if side < 0 else 'wing_l', p['wing'])
        tr = p.get('tip_r' if side < 0 else 'tip_l', p['tip'])
        m = side > 0
        fx = lambda x0, w: (-(x0 + w) if m else x0)
        wsc = p.get('wscale', 1.0)
        Wg = root.child((12 * side, 5, 2), (wr[0], wr[1] * -side, wr[2] * -side), wsc)
        out.append(mc_cube(Wg, tex, (112, 88), (fx(-56, 56), -4, -4), (56, 8, 8), s=s, mirror=m, part='bone'))
        out.append(mc_cube(Wg, tex, (-56, 88), (fx(-56, 56), 0, 2), (56, 0, 56), s=s, mirror=m, part='skin'))
        Tp = Wg.child((56 * side, 0, 0), (tr[0], tr[1] * -side, tr[2] * -side))
        out.append(mc_cube(Tp, tex, (112, 136), (fx(-56, 56), -2, -2), (56, 4, 4), s=s, mirror=m, part='bone'))
        out.append(mc_cube(Tp, tex, (-56, 144), (fx(-56, 56), 0, 2), (56, 0, 56), s=s, mirror=m, part='skin'))
    for side in (-1, 1):
        if p.get('legs', True):
            _dragon_leg(root, tex, side, 'front', p['front'], s, out)
            _dragon_leg(root, tex, side, 'rear', p['rear'], s, out)
    x, y, z = 0.0, 10.0, 60.0
    for xr, yr in p['tail']:
        T = root.child((x, y, z), (xr, yr, 0))
        out.append(mc_cube(T, tex, (192, 104), (-5, -5, -5), (10, 10, 10), s=s, part='tail'))
        out.append(mc_cube(T, tex, (48, 0), (-1, -9, -3), (2, 4, 6), s=s, part='spike'))
        y += math.sin(xr) * 10
        z += math.cos(yr) * math.cos(xr) * 10
        x += math.sin(yr) * math.cos(xr) * 10
    return out


def textures():
    E = TX / 'entity' / 'enderdragon'
    return M.load_tex(E / 'dragon.png'), M.load_tex(E / 'dragon_eyes.png')


# ---------------------------------------------------------------- FireRed palette work
def gba(c):
    """A colour as the GBA stores it (5 bits a channel), read back the way the decomp's .pal files are."""
    return tuple(int(round(v * 31 / 255)) * 255 // 31 for v in c)


# One 16-colour palette (index 0 transparent). Ramps run dark to light.
PAL_NORMAL = {
    'outline': [(16, 10, 24)],
    'body': [(30, 24, 38), (44, 36, 56), (62, 52, 78), (86, 74, 104), (116, 104, 136)],
    'bone': [(98, 92, 112), (146, 140, 160), (204, 198, 214)],
    'eye': [(132, 16, 172), (210, 64, 248), (248, 196, 248)],
    'glow': [(84, 30, 110)],
    'white': [(248, 248, 248)],
}
# FireRed shinies are palette swaps: a deep sea-green dragon with gold eyes
PAL_SHINY = {
    'outline': [(8, 18, 20)],
    'body': [(18, 40, 44), (26, 58, 62), (36, 82, 84), (54, 110, 106), (84, 142, 132)],
    'bone': [(98, 112, 100), (150, 164, 140), (214, 222, 196)],
    'eye': [(176, 96, 8), (240, 176, 32), (252, 240, 168)],
    'glow': [(104, 70, 20)],
    'white': [(248, 248, 248)],
}
ORDER = ['outline', 'body', 'bone', 'eye', 'glow', 'white']


def palette_list(P):
    out = [(0, 0, 0)]                    # colour 0: transparent (shown as black in the .pal)
    for k in ORDER:
        out += [gba(c) for c in P[k]]
    while len(out) < 16:
        out.append((0, 0, 0))
    return out


def slot(mat, level):
    """Palette index of (material, level)."""
    i = 1
    for k in ORDER:
        if k == mat:
            return i + level
        i += len(PAL_NORMAL[k])
    raise KeyError(mat)


LIGHT = np.array([-0.7, 0.6, 0.35]); LIGHT /= np.linalg.norm(LIGHT)     # from the upper left, a little in front


def classify(boxes, r):
    """Per hi-res pixel: material id (0 none, 1 body, 2 bone, 3 eye) and a lighting value 0..1."""
    part = r['part']
    on = part >= 0
    names = np.array([b.part for b in boxes] + [''])
    pn = names[np.where(on, part, len(boxes))]
    lum = r['rgba'][..., :3].astype(float).mean(-1)
    mat = np.zeros(part.shape, np.int8)
    mat[on] = 1
    mat[on & (lum > 60)] = 2
    mat[on & (pn == 'eyes')] = 3
    mat[on & (pn == 'skin') & (lum <= 60)] = 4
    lam = np.clip((r['n'] * LIGHT).sum(-1), -1, 1)
    # Gen 3 shading: a broad lit side, a shadow side, texture detail kept faint
    tex = np.clip((lum - 20) / 14, -1, 1) * 0.08
    val = np.clip(0.08 + 0.95 * np.clip(lam, 0, 1) + tex, 0, 1)
    return mat, val, pn


def downsample(mat, val, part, depth, ss, eye_min=0.12, cover=0.42):
    """Hi-res maps to sprite pixels: coverage decides the silhouette, the majority material wins a pixel (eyes win
    with little coverage so they never vanish), and the value is that material's mean."""
    H, W = mat.shape[0] // ss, mat.shape[1] // ss
    m = mat.reshape(H, ss, W, ss).transpose(0, 2, 1, 3).reshape(H, W, ss * ss)
    v = val.reshape(H, ss, W, ss).transpose(0, 2, 1, 3).reshape(H, W, ss * ss)
    p = part.reshape(H, ss, W, ss).transpose(0, 2, 1, 3).reshape(H, W, ss * ss)
    d = depth.reshape(H, ss, W, ss).transpose(0, 2, 1, 3).reshape(H, W, ss * ss)
    n = ss * ss
    counts = np.stack([(m == k).sum(-1) for k in range(5)], -1)
    cov = (counts[..., 1:].sum(-1)) / n
    out_m = np.zeros((H, W), np.int8)
    solid = cov >= cover
    best = np.array([1, 2, 4])[np.argmax(counts[..., [1, 2, 4]], -1)]
    out_m[solid] = best[solid]
    eye = counts[..., 3] / n >= eye_min
    out_m[eye & (cov >= cover * 0.6)] = 3
    out_v = np.zeros((H, W))
    out_p = np.full((H, W), -1)
    out_d = np.full((H, W), -1e9)
    for k in (1, 2, 3, 4):
        sel = out_m == k
        if not sel.any():
            continue
        mk = m[sel] == k
        vv = np.where(mk, v[sel], 0).sum(-1) / np.maximum(mk.sum(-1), 1)
        if k == 3:
            vv = np.where(mk, v[sel], 0).max(-1)
        out_v[sel] = vv
        # the front-most part in the pixel (for inner contour lines)
        dd = np.where(mk, d[sel], -1e9)
        j = np.argmax(dd, -1)
        out_p[sel] = p[sel][np.arange(len(j)), j]
        out_d[sel] = dd[np.arange(len(j)), j]
    return out_m, out_v, out_p, out_d


def to_indices(mat, val, part, depth, inner=2.0, eye_levels=(0, 1, 2), body_gamma=1.0, skin_top=2, rim=True, glow=True):
    """Material and value to palette indices, then FireRed's outlines: a dark line round the silhouette (outside it)
    and darker contours where a nearer part overlaps a farther one."""
    H, W = mat.shape
    idx = np.zeros((H, W), np.uint8)
    nb = len(PAL_NORMAL['body'])
    lv = np.clip(np.round((val ** body_gamma) * (nb - 1) * 1.05), 0, nb - 1).astype(int)
    for y in range(H):
        for x in range(W):
            k = mat[y, x]
            if k == 1:
                idx[y, x] = slot('body', lv[y, x])
            elif k == 2:
                idx[y, x] = slot('bone', int(np.clip(round(val[y, x] * 2.2), 0, 2)))
            elif k == 3:
                idx[y, x] = slot('eye', eye_levels[int(np.clip(round(val[y, x] * 2), 0, 2))])
            elif k == 4:      # the wing membranes: the dark end of the body ramp
                idx[y, x] = slot('body', int(np.clip(round(val[y, x] * skin_top), 0, skin_top)))
    solid = mat > 0
    # Gen 3 hand shading: the edge facing the light (up and left) one step lighter, the far edge one step darker
    if rim:
        up = np.zeros_like(solid); up[1:, :] = ~solid[:-1, :]; up[0, :] = True
        lf = np.zeros_like(solid); lf[:, 1:] = ~solid[:, :-1]; lf[:, 0] = True
        dn = np.zeros_like(solid); dn[:-1, :] = ~solid[1:, :]; dn[-1, :] = True
        rt = np.zeros_like(solid); rt[:, :-1] = ~solid[:, 1:]; rt[:, -1] = True
        b0, b1 = slot('body', 0), slot('body', nb - 1)
        isb = (idx >= b0) & (idx <= b1)
        lift = solid & isb & (up | lf) & ~(dn | rt)
        drop = solid & isb & (dn | rt) & ~(up | lf)
        idx[lift] = np.minimum(idx[lift] + 1, b1)
        idx[drop] = np.maximum(idx[drop].astype(int) - 1, b0)
    # inner contours: a pixel whose neighbour (right or below or left or above) belongs to another part that is
    # clearly nearer gets the darkest body shade
    cont = np.zeros_like(solid)
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        ys, ye = max(0, -dy), H - max(0, dy)
        xs, xe = max(0, -dx), W - max(0, dx)
        here = (slice(ys, ye), slice(xs, xe)); there = (slice(ys + dy, ye + dy), slice(xs + dx, xe + dx))
        m = solid[here] & solid[there] & (part[here] != part[there]) & (depth[here] < depth[there] - inner) & (mat[here] != 3)
        cont[here] |= m
    idx[cont] = slot('outline', 0)
    # the eyes glow: their brightest pixel in the middle of each run, a dim purple halo on the body around them
    if glow:
        eye = mat == 3
        for y in range(H):
            xs = np.nonzero(eye[y])[0]
            if len(xs) >= 2:
                for run in np.split(xs, np.nonzero(np.diff(xs) > 1)[0] + 1):
                    idx[y, run] = slot('eye', 1)
                    idx[y, run[len(run) // 2]] = slot('eye', 2)
            elif len(xs) == 1:
                idx[y, xs[0]] = slot('eye', 2)
        halo = np.zeros_like(eye)
        halo[:-1, :] |= eye[1:, :]; halo[1:, :] |= eye[:-1, :]
        halo &= solid & ~eye & (mat == 1)
        idx[halo] = slot('glow', 0)
    # the silhouette outline, outside the shape
    ring = np.zeros_like(solid)
    ring[:, :-1] |= solid[:, 1:]; ring[:, 1:] |= solid[:, :-1]; ring[:-1, :] |= solid[1:, :]; ring[1:, :] |= solid[:-1, :]
    ring &= ~solid
    idx[ring] = slot('outline', 0)
    return idx


def colorize(idx, P):
    pal = np.array(palette_list(P), np.uint8)
    out = np.zeros(idx.shape + (4,), np.uint8)
    out[..., :3] = pal[idx]
    out[..., 3] = np.where(idx > 0, 255, 0)
    return out


def sprite(p, R, size, origin, scale, ss=8, **kw):
    """Render pose p through camera R into a size x size FireRed sprite (palette indices). `origin` is where the
    model's origin lands, in sprite pixels; `scale` is sprite pixels per model texel."""
    tex, eyes = textures()
    boxes = pose(tex, eyes, p, s=scale * ss)
    r = view_render(boxes, R, (size[0] * ss, size[1] * ss), (origin[0] * ss, origin[1] * ss))
    mat, val, _ = classify(boxes, r)
    m, v, pt, d = downsample(mat, val, r['part'], r['depth'], ss)
    return to_indices(m, v, pt, d / ss, **kw), boxes, r


# The party icon uses FireRed's shared icon palette 2 (the one Mewtwo, Gengar and Dragonite use): each slot of the
# sprite palette maps onto one of its colours.
ICON_PAL = 2
ICON_MAP = {
    ('outline', 0): (65, 65, 65),
    ('body', 0): (98, 98, 90), ('body', 1): (98, 98, 90), ('body', 2): (123, 123, 123), ('body', 3): (123, 123, 123), ('body', 4): (189, 189, 180),
    # the wing bones in the palette's lilac, so the wings read against the grey body at icon size
    ('bone', 0): (148, 123, 205), ('bone', 1): (197, 164, 205), ('bone', 2): (197, 164, 205),
    ('eye', 0): (189, 41, 156), ('eye', 1): (189, 41, 156), ('eye', 2): (197, 164, 205),
    ('glow', 0): (148, 123, 205), ('white', 0): (255, 255, 255),
}


def icon_colorize(idx, icon_pal):
    out = np.zeros(idx.shape + (4,), np.uint8)
    for (k, lv), c in ICON_MAP.items():
        c = min(icon_pal, key=lambda q: sum((a - b) ** 2 for a, b in zip(q, c)))   # exactly one of the palette's colours
        m = idx == slot(k, lv)
        out[m, :3] = c
        out[m, 3] = 255
    return out


def halve(idx, prio=('eye', 'glow', 'outline', 'bone', 'white', 'body')):
    """Pixel-art 2x reduction of a palette-index sprite: each 2x2 block keeps its most telling colour (an eye pixel
    over an outline over a bone over the body), transparent only when at least three of its four are."""
    H, W = idx.shape
    blk = idx.reshape(H // 2, 2, W // 2, 2).transpose(0, 2, 1, 3).reshape(H // 2, W // 2, 4)
    rank = np.full(16, 99)
    r = 0
    for k in prio:
        for lv in range(len(PAL_NORMAL[k])):
            rank[slot(k, lv)] = r * 10 + (len(PAL_NORMAL[k]) - lv if k != 'body' else lv)
        r += 1
    out = np.zeros((H // 2, W // 2), np.uint8)
    for y in range(H // 2):
        for x in range(W // 2):
            b = blk[y, x]
            o = b[b > 0]
            if len(o) < 2:
                continue
            # the body keeps the block's middle shade; anything with a higher rank wins outright
            best = o[np.argmin(rank[o])]
            if rank[best] >= 50:     # body: the median shade
                best = int(np.sort(o)[len(o) // 2])
            out[y, x] = best
    return out


# ---------------------------------------------------------------- the poses (found by rendering and looking)
# Front: a 3/4 view from the player's side, flying at the camera with the head low on the left, jaws open, both
# wings spread up into a V and the tail curling out on the right (FireRed fronts face left).
FRONT = {
    'yaw': -0.5, 'pitch': 0.2, 'roll': -0.12, 'scale': 0.36, 'ox': 31, 'oy': 58,
    'neck': [(-0.5, 0.2), (-0.3, 0.2), (-0.1, 0.2)], 'head': (0.4, 0.3), 'hscale': 2.0, 'jaw': 0.7,
    'wing': (1.0, 0.2, 0.5), 'tip': (0, 0, 0.3), 'wscale': 0.85,
    'front': (1.1, -0.6, 0.7), 'rear': (0.9, 0.5, 0.7),
    'tail': [(0.9, 0.3), (0.8, 0.7), (0.6, 1.1), (0.3, 1.5), (0.0, 1.9)],
}
# Back: from behind and to the left, over the shoulder: the near wing raised high on the left, the neck rising to the
# right and the head turned toward the foe with one eye showing, the far wing lowered so it never crosses the head,
# the legs tucked out of sight (FireRed's backs crop low).
BACK = dict(FRONT, yaw=2.75, pitch=0.2, roll=0.0, scale=0.44, ox=28, oy=70, legs=False,
            neck=[(-1.3, 0.2), (-1.2, 0.3), (-0.9, 0.4)], head=(0.25, 1.6),
            wing=(-0.6, 0.3, 0.9), tip=(0, 0, 0.2), wing_r=(-0.6, 0.3, 0.2), tip_r=(0, 0, -0.6))
# The party icon: the front pose drawn at 64 and halved, wings up then half down (FireRed icons alternate two frames)
ICON = dict(FRONT, scale=0.3, hscale=3.2, wscale=0.7, ox=34, oy=56, neck=[(-0.5, 0.2), (-0.3, 0.2)],
            tail=[(0.9, 0.3), (0.7, 0.8), (0.4, 1.3)])          # chibi: a big head, short neck and tail
ICON_WINGS = [((1.0, 0.2, 0.5), (0, 0, 0.3)), ((1.0, 0.2, 0.25), (0, 0, 0.0))]
# The follower: a little dragon hovering over its shadow, from the game's camera; head big, tail short
FOLLOW = dict(FRONT, roll=0.0, pitch=0.45, scale=0.27, ox=32, oy=38, hscale=2.8, wscale=0.8,
              neck=[(-0.4, 0.0), (-0.2, 0.0)], head=(0.3, 0.0), tail=[(0.2, 0.0), (0.1, 0.0), (0.0, 0.0)],
              front=(1.3, -0.5, 0.75), rear=(1.0, 0.5, 0.75))
FOLLOW_WINGS = [((1.0, 0.15, 0.55), (0, 0, 0.35)), ((1.0, 0.15, 0.0), (0, 0, -0.1))]
FOLLOW_SIDE_WINGS = [((0.3, 0.5, 0.55), (0, 0, 0.35)), ((0.4, 0.4, 0.0), (0, 0, -0.2))]
KW = {'inner': 1.2}


def front_back():
    out = {}
    for name, p in (('front', FRONT), ('back', BACK)):
        idx, _, _ = sprite(p, cam(p['yaw'], p['pitch'], p['roll']), (64, 64), (p['ox'], p['oy']), p['scale'], **KW)
        out[name] = idx
    return out


def icon_frames():
    fr = []
    for wing, tip in ICON_WINGS:
        p = dict(ICON, wing=wing, tip=tip)
        idx, _, _ = sprite(p, cam(p['yaw'], p['pitch'], p['roll']), (64, 64), (p['ox'], p['oy']), p['scale'], **KW)
        fr.append(halve(idx))
    return np.concatenate(fr, 0)            # 32 x 64: frame 0 above frame 1


def follower_frames():
    """Six 32x32 frames like the expansion's overworld sheets: down 0/1, up 0/1, left 0/1 (right is left mirrored)."""
    fr = []
    for yaw, oy, wings in ((0.0, FOLLOW['oy'], FOLLOW_WINGS), (math.pi, FOLLOW['oy'], FOLLOW_WINGS), (-math.pi / 2, FOLLOW['oy'] + 6, FOLLOW_SIDE_WINGS)):
        for wing, tip in wings:
            p = dict(FOLLOW, wing=wing, tip=tip)
            idx, _, _ = sprite(p, cam(yaw, p['pitch'], 0.0), (64, 64), (p['ox'] + (2 if yaw < 0 else 0), oy), p['scale'], **KW)
            fr.append(halve(idx))
    return np.concatenate(fr, 1)            # 32 x 192


def save_rgba(arr, path):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr, 'RGBA').save(path, optimize=True)


def build_graphics(icon_pal):
    fb = front_back()
    for kind, idx in fb.items():
        save_rgba(colorize(idx, PAL_NORMAL), OUT / 'mon' / f'{NAME}_{kind}.png')
        save_rgba(colorize(idx, PAL_SHINY), OUT / 'mon' / f'{NAME}_{kind}_shiny.png')
    save_rgba(icon_colorize(icon_frames(), icon_pal), OUT / 'mon' / f'{NAME}_icon.png')
    ow = follower_frames()
    save_rgba(colorize(ow, PAL_NORMAL), OUT / 'sprites' / f'ow_{NAME}.png')
    save_rgba(colorize(ow, PAL_SHINY), OUT / 'sprites' / f'ow_{NAME}_shiny.png')
    # FireRed's pic coordinates: the size of the drawn area and how far its bottom sits above the frame's
    coords = {}
    for kind, idx in fb.items():
        ys, xs = np.nonzero(idx)
        w = int(min(64, ((xs.max() - xs.min()) // 8 + 1) * 8)); h = int(min(64, ((ys.max() - ys.min()) // 8 + 1) * 8))
        coords[kind] = {'w': w, 'h': h, 'y': int(63 - ys.max())}
    return coords


# ---------------------------------------------------------------- its cry
def build_cry():
    """Minecraft's growl1, cut to a FireRed-length cry (about 1.4 s, like MEWTWO's), shaped with a quick swell and a
    fade, and stored as FireRed stores its cries: 8-bit mono at 10512 Hz, about as loud as the others."""
    src = SND / 'mob' / 'enderdragon' / 'growl1.ogg'
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(src), '-ac', '1', '-ar', '10512', '-af', 'lowpass=f=4800',
                          '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    a = np.frombuffer(raw, np.float32).astype(float)
    sr = 10512
    a = a[int(0.10 * sr):int(1.55 * sr)]
    n = len(a)
    t = np.arange(n) / sr
    env = np.minimum(1.0, t / 0.04) * np.where(t > n / sr - 0.4, np.clip((n / sr - t) / 0.4, 0, 1) ** 1.5, 1.0)
    a = a * env
    # match MEWTWO's loudness (RMS) so it sits with the real cries
    ref = np.frombuffer(open(FR / 'sound/direct_sound_samples/cries/mewtwo.wav', 'rb').read()[44:], np.uint8).astype(float) - 128
    target = np.sqrt((ref ** 2).mean()) / 128
    a = a * (target / max(1e-6, np.sqrt((a ** 2).mean())))
    a = np.tanh(a * 1.2) / np.tanh(1.2)            # the GBA's 8-bit crunch without hard clipping
    pcm = np.clip(np.round(a * 127 + 128), 0, 255).astype(np.uint8)
    import wave
    (OUT / 'cries').mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / 'cries' / f'{NAME}.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(1); w.setframerate(sr); w.writeframes(pcm.tobytes())
    return n / sr


# ---------------------------------------------------------------- The End's battle background
# FireRed's cave terrain recoloured colour for colour (as the Nether's is): the backdrop bands become The End's
# purple night, darkest at the top with stars in it, and the platforms become end stone.
END_BG = {
    # backdrop, top to bottom
    (213, 197, 115): (28, 18, 44), (205, 180, 106): (40, 26, 60), (189, 164, 106): (52, 36, 76),
    (180, 156, 98): (70, 52, 100), (197, 172, 106): (120, 100, 156), (172, 148, 90): (62, 44, 90),
    (164, 139, 82): (56, 40, 82), (189, 156, 106): (104, 84, 140), (156, 131, 98): (128, 120, 82),
    (180, 148, 106): (150, 142, 98), (180, 164, 106): (196, 190, 136), (197, 180, 106): (206, 206, 144),
    # the platforms: end stone
    (205, 197, 90): (218, 222, 154), (230, 222, 106): (240, 246, 182), (189, 180, 90): (204, 204, 140),
    (172, 156, 90): (184, 182, 124), (164, 131, 90): (110, 100, 70), (148, 123, 82): (92, 84, 60),
}


def build_end_bg():
    cave = np.array(Image.open(OUT / 'battle' / 'bg_cave.png').convert('RGBA'))
    out = cave.copy()
    for src, dst in END_BG.items():
        m = (cave[:, :, :3] == src).all(-1)
        out[m, :3] = gba(dst)
    # stars in the dark bands (deterministic): single pixels, a few brighter crosses
    rng = np.random.default_rng(1100)
    sky = np.zeros(out.shape[:2], bool)
    for c in ((28, 18, 44), (40, 26, 60), (52, 36, 76), (70, 52, 100), (62, 44, 90), (56, 40, 82)):
        sky |= (out[:, :, :3] == gba(c)).all(-1)
    ys, xs = np.nonzero(sky[:44])
    for k in rng.choice(len(ys), 70, replace=False):
        y, x = ys[k], xs[k]
        out[y, x, :3] = gba((214, 196, 240)) if rng.random() < 0.7 else gba((150, 120, 200))
    for k in rng.choice(len(ys), 6, replace=False):
        y, x = ys[k], xs[k]
        for dy, dx in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
            if 0 <= y + dy < 160 and 0 <= x + dx < 240 and sky[y + dy, x + dx]:
                out[y + dy, x + dx, :3] = gba((248, 240, 255)) if (dy, dx) == (0, 0) else gba((176, 150, 220))
    save_rgba(out, OUT / 'battle' / 'bg_end.png')


# ---------------------------------------------------------------- FireRed's Hall of Fame (src/hall_of_fame.c)
def build_hof():
    """DrawHofBackground: BG3 is tile 2 everywhere (the blue diamond pattern), BG1 puts tile 1 (black) on tile rows 0-1
    and 14-19. The confetti sheet comes too, and the layout numbers the screen needs go into hof.json."""
    import json
    im = Image.open(FR / 'graphics/hall_of_fame/hall_of_fame.png')
    idx = np.array(im)
    raw = im.getpalette()
    pal = [tuple(raw[i * 3:i * 3 + 3]) for i in range(16)]
    tile = lambda t: idx[(t // 8) * 8:(t // 8) * 8 + 8, (t % 8) * 8:(t % 8) * 8 + 8]
    bg = np.zeros((160, 240), np.uint8)
    for ty in range(20):
        for tx in range(30):
            t = 1 if ty < 2 or ty >= 14 else 2
            bg[ty * 8:ty * 8 + 8, tx * 8:tx * 8 + 8] = tile(t)
    rgba = np.zeros((160, 240, 4), np.uint8)
    rgba[..., :3] = np.array(pal, np.uint8)[bg]
    rgba[..., 3] = 255
    save_rgba(rgba, OUT / 'ui' / 'hof_bg.png')
    import fr as Bfr
    Bfr.colorize_self(FR / 'graphics/misc/confetti.png').save(OUT / 'ui' / 'hof_confetti.png', optimize=True)
    src = (FR / 'src/hall_of_fame.c').read_text()
    import re

    def table(name):
        body = re.search(name + r'\[\d+\]\[4\] =\s*\{(.*?)\};', src, re.S).group(1)
        return [[int(v) for v in re.findall(r'-?\d+', row)] for row in re.findall(r'\{([^{}]*)\}', body)]
    json.dump({'full': table('sHallOfFame_MonFullTeamPositions'), 'half': table('sHallOfFame_MonHalfTeamPositions'),
               'note': 'per party slot: [startX, startY, endX, endY] of the front sprite centre (src/hall_of_fame.c); '
                       'more than 3 POKeMON use full, else half. Text: "Welcome to the HALL OF FAME!" in the window at the bottom.',
               'music': 'hall_of_fame'},
              open(OUT / 'ui' / 'hof.json', 'w'), indent=1)


# ---------------------------------------------------------------- the species (spec section 8)
SPECIES = {
    'name': 'ENDER DRAGON',
    'base': [100, 150, 100, 130, 100, 100],          # HP, Atk, Def, SpA, SpD, Spe: 680, legendary tier
    'types': ['DRAGON', 'DARK'],
    'catchRate': 3,                                  # MEWTWO's
    'expYield': 306,
    'growth': 'SLOW',
    # Gen 3 style: two moves at 1, then one every seven levels. The four it knows at 70 (movesAt keeps the last four
    # learned) are DRAGONBREATH, CRUNCH, DRAGON CLAW and HYPER BEAM. ROAR and OUTRAGE are the only moves here whose
    # effects (ROAR, RAMPAGE) no other species in the game uses; src/battle.js handles both.
    'learnset': [[1, 'SCARY_FACE'], [1, 'DRAGON_RAGE'], [8, 'BITE'], [15, 'ROAR'], [22, 'FLY'], [29, 'SLASH'],
                 [36, 'AGILITY'], [43, 'DRAGON_DANCE'], [50, 'DRAGON_BREATH'], [57, 'CRUNCH'], [64, 'DRAGON_CLAW'],
                 [70, 'HYPER_BEAM'], [78, 'OUTRAGE']],
    'canFly': False,
    'elevation': 7,                                  # it flies, like the birds (5 to 8): the battle shadow shows
    'id': 0,
    'ability': None,                                 # the engine has no abilities (PRESSURE would be its own)
    'dex': {
        'category': 'END',                           # shown as "END POKéMON"
        'height': 80, 'weight': 5100,                # decimetres and hectograms, as the decomp stores them: 8.0 m, 510.0 kg
        'heightText': "26'03\"", 'weightText': '1124.4 lbs.',
        'text': 'This POKéMON reigns over the island of THE END, far beyond any map. '
                'Crystals glowing atop obsidian pillars mend its wounds while it circles above.',
    },
}


def build_all(icon_pal):
    print('  ender dragon: sprites'); coords = build_graphics(icon_pal)
    print('  ender dragon: cry %.2fs' % build_cry())
    print('  ender dragon: battle background'); build_end_bg()
    print('  hall of fame'); build_hof()
    return coords
