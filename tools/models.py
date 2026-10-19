#!/usr/bin/env python3
"""Box models for Steve and the mobs, posed for FireRed-scale sprites.

Each builder takes the entity texture and a pose dict and returns a list of mcmodel.Box. Proportions
are squashed ("chibi") the way Gen 3 overworld sprites are: heads keep one texel per pixel, bodies and
legs are shortened so the whole figure stands about 1.5 tiles tall.
"""
import math
from mcmodel import Box, mc_box, rot_x

R = math.radians


# ---------------------------------------------------------------- Steve (player model, wide arms)
STEVE = dict(leg_sy=0.36, body_sy=0.52, arm_sx=0.75, arm_sy=0.52, dz=1.5, arm_dz=1.0)


def steve(tex, pose=None, prop=STEVE):
    p = {'leg': 0.0, 'leg_z': 0.0, 'arm': 0.0, 'rarm': None, 'larm': None, 'rarm_z': 0.0, 'head_pitch': 0.0, 'head_yaw': 0.0, 'bob': 0.0, 'sneak': 0.0, 'thin': False, 'overlay': True,
         'slim': False, 'hat': True}
    p.update(pose or {})
    ls, bs, asx, asy, dz = prop['leg_sy'], prop['body_sy'], prop['arm_sx'], prop['arm_sy'], prop.get('dz', 1)
    adz = prop.get('arm_dz', dz)
    leg_h, body_h, arm_h = 12 * ls, 12 * bs, 12 * asy
    aw = 4 * asx
    hip = leg_h + p['bob']
    shoulder = hip + body_h
    boxes = []
    thin = p['thin']
    lw = 2 if thin else 4                      # limb width in texels (skeletons are thin)
    # Alex-style ("slim") player models: arms three texels wide, still four deep (Minecraft's PlayerModel)
    alw = 3 if p['slim'] and not thin else lw  # arm width in texels
    law = alw * asx if not thin else 2         # arm width on screen
    aw = law
    lx0 = -2 - lw / 2                          # right leg x (centred under each hip)
    RLEG, LLEG = (0, 16), ((0, 16) if thin else (16, 48))
    RARM, LARM = (40, 16), ((40, 16) if thin else (32, 48))
    lm = thin                                  # 64x32 textures mirror the right limbs for the left
    # legs swing about the hip (x axis)
    boxes.append(Box(tex, RLEG, (lw, 12, lw), (lx0, p['bob'], -lw / 2 * dz), (1, ls, dz), pivot=(-2, hip, 0), rot=(R(p['leg']), 0, R(-p['leg_z'])), part='rleg'))
    boxes.append(Box(tex, LLEG, (lw, 12, lw), (2 - lw / 2, p['bob'], -lw / 2 * dz), (1, ls, dz), pivot=(2, hip, 0), rot=(R(-p['leg']), 0, R(p['leg_z'])), part='lleg', mirror=lm))
    if p['overlay'] and not thin:
        # pants overlay (the modern Steve skin has a little on the legs)
        boxes.append(Box(tex, (0, 32), (4, 12, 4), (-4, p['bob'], -2 * dz), (1, ls, dz), pivot=(-2, hip, 0), rot=(R(p['leg']), 0, R(-p['leg_z'])), part='rleg', inflate=0.25))
        boxes.append(Box(tex, (0, 48), (4, 12, 4), (0, p['bob'], -2 * dz), (1, ls, dz), pivot=(2, hip, 0), rot=(R(-p['leg']), 0, R(p['leg_z'])), part='lleg', inflate=0.25))
    # body
    boxes.append(Box(tex, (16, 16), (8, 12, 4), (-4, hip, -2 * dz), (1, bs, dz), part='body'))
    if p['overlay'] and not thin:
        boxes.append(Box(tex, (16, 32), (8, 12, 4), (-4, hip, -2 * dz), (1, bs, dz), part='body', inflate=0.25))
    # arms: the right arm can be raised (mining / attacking) instead of swinging
    ra = R(-p['arm']) if p['rarm'] is None else R(p['rarm'])
    la = R(p['arm']) if p['larm'] is None else R(p['larm'])
    asz = asx if not thin else 1
    boxes.append(Box(tex, RARM, (alw, 12, lw), (-4 - aw, shoulder - arm_h, -lw / 2 * asz * adz), (aw / alw, asy, asz * adz), pivot=(-4 - aw / 2, shoulder - 0.5, 0), rot=(ra, 0, R(p['rarm_z'])), part='rarm'))
    if p['overlay'] and not thin:
        boxes.append(Box(tex, (40, 32), (alw, 12, 4), (-4 - aw, shoulder - arm_h, -2 * asx * adz), (asx, asy, asx * adz), pivot=(-4 - aw / 2, shoulder - 0.5, 0), rot=(ra, 0, R(p['rarm_z'])), part='rarm', inflate=0.25))
    boxes.append(Box(tex, LARM, (alw, 12, lw), (4, shoulder - arm_h, -lw / 2 * asz * adz), (aw / alw, asy, asz * adz), pivot=(4 + aw / 2, shoulder - 0.5, 0), rot=(la, 0, 0), part='larm', mirror=lm))
    if p['overlay'] and not thin:
        boxes.append(Box(tex, (48, 48), (alw, 12, 4), (4, shoulder - arm_h, -2 * asx * adz), (asx, asy, asx * adz), pivot=(4 + aw / 2, shoulder - 0.5, 0), rot=(la, 0, 0), part='larm', inflate=0.25))
    # head
    boxes.append(Box(tex, (0, 0), (8, 8, 8), (-4, shoulder, -4), pivot=(0, shoulder, 0), rot=(R(p['head_pitch']), R(p['head_yaw']), 0), part='head'))
    # the hat layer; left off under a helmet (Minecraft's helmet is inflated past it and hides it)
    if p['overlay'] and p['hat']:
        boxes.append(Box(tex, (32, 0), (8, 8, 8), (-4, shoulder, -4), pivot=(0, shoulder, 0), rot=(R(p['head_pitch']), R(p['head_yaw']), 0), part='head', inflate=0.5))
    # where the right hand ends up after the arm's rotation (for held items)
    import numpy as _np
    from mcmodel import rot_z as _rz
    piv = _np.array([-4 - aw / 2, shoulder - 0.5, 0.0])
    tip = _np.array([-4 - aw / 2, shoulder - arm_h, 0.0])
    Rm = __import__('mcmodel').rot_y(0) @ rot_x(ra) @ _rz(R(p['rarm_z']))
    hand = tuple(piv + Rm @ (tip - piv))
    return boxes, {'hand': hand, 'shoulder': (-4 - aw / 2, shoulder - 0.5, 0), 'arm_len': arm_h, 'top': shoulder + 8}


def steve_profile_skin(tex):
    """Steve's skin with a face on the sides of his head. In Minecraft the sides are hair with a
    little cheek; at sprite size a profile needs the forehead, an eye and the beard line to read."""
    t = tex.copy()
    hexc = lambda h: [int(h[i:i + 2], 16) for i in (0, 2, 4)] + [255]
    skin, shade, white, iris, beard, dark = (hexc('b3795e'), hexc('9b6349'), hexc('ffffff'), hexc('523d89'), hexc('774235'), hexc('421d0a'))
    # right face (u 0..7, v 8..15): the front edge is column 7
    for (c, r, col) in ((7, 2, shade), (7, 3, skin), (6, 3, shade), (7, 4, iris), (6, 4, white), (5, 4, shade), (7, 5, shade), (6, 5, skin),
                        (7, 6, beard), (6, 6, dark), (7, 7, dark), (6, 7, beard)):
        t[8 + r, 0 + c] = col
    # left face (u 16..23): the front edge is column 0
    for (c, r, col) in ((0, 2, shade), (0, 3, skin), (1, 3, shade), (0, 4, iris), (1, 4, white), (2, 4, shade), (0, 5, shade), (1, 5, skin),
                        (0, 6, beard), (1, 6, dark), (0, 7, dark), (1, 7, beard)):
        t[8 + r, 16 + c] = col
    return t



def profile_skin(tex):
    """steve_profile_skin for any player skin: at sprite size a side view needs an eye at the front edge
    of the head's side, or a head that is all hair on the sides reads as the back of the head. The eye,
    its white and the cheek and jaw under it are taken from the skin's own face (the base face with its
    hat layer over it), so each skin keeps its own colours; the hat layer is cleared over the patch."""
    t = tex.copy()
    face = t[8:16, 8:16].astype(int)
    hat = t[8:16, 40:48].astype(int)
    vis = face.copy()
    on = hat[..., 3] > 127
    vis[on] = hat[on]
    lum = vis[..., :3].sum(-1)
    # the eye row: the topmost row holding the face's two brightest texels well apart (the eye whites)
    best = None
    for r in range(2, 7):
        row = lum[r]
        order = sorted(range(8), key=lambda c: -row[c])
        a, b = sorted(order[:2])
        if b - a >= 3 and row[a] > 1.4 * max(1, sorted(row)[3]) and row[b] > 1.4 * max(1, sorted(row)[3]):
            best = (r, a, b)
            break
    if best is None:
        r, a, b = 4, 1, 6
    else:
        r, a, b = best
    # each eye's iris is the texel beside its white toward the nose, unless that is skin-light too
    iris_r = vis[r, a + 1] if lum[r, a + 1] < 0.8 * lum[r, a] else vis[r, a]
    iris_l = vis[r, b - 1] if lum[r, b - 1] < 0.8 * lum[r, b] else vis[r, b]
    white_r, white_l = vis[r, a], vis[r, b]
    for side, col, step, iris, white, fc in ((0, 7, -1, iris_r, white_r, 0), (16, 0, 1, iris_l, white_l, 7)):
        fin = 1 if fc == 0 else -1
        for rr in range(max(0, r - 1), 8):
            if rr == r:
                put = [(col, iris), (col + step, white), (col + 2 * step, vis[r, fc])]
            else:
                put = [(col, vis[rr, fc + fin]), (col + step, vis[rr, fc])]
            for c, colr in put:
                t[8 + rr, side + c] = colr
                t[8 + rr, 32 + side + c, 3] = 0
    return t

# ---------------------------------------------------------------- mobs, in Minecraft's own model coordinates
def swing(phase, amp=1.0):
    """Minecraft's walk: limbs swing as cos(limbSwing * 0.6662) * 1.4 * amount."""
    return math.cos(phase) * 0.42 * amp


def creeper(tex, phase=None, s=0.82, fuse=0.0):
    a = 0.0 if phase is None else swing(phase)
    inf = fuse * 0.9
    b = [mc_box(tex, (0, 0), (-4, -8, -4), (8, 8, 8), pivot=(0, 6, 0), inflate=inf, s=s, part='head'),
         mc_box(tex, (16, 16), (-4, 0, -2), (8, 12, 4), pivot=(0, 6, 0), inflate=inf, s=s, part='body')]
    for i, (px, pz, sgn) in enumerate(((-2, 4, 1), (2, 4, -1), (-2, -4, -1), (2, -4, 1))):
        b.append(mc_box(tex, (0, 16), (-2, 0, -2), (4, 6, 4), pivot=(px, 18, pz), rot=(a * sgn, 0, 0), inflate=inf, s=s, part=f'leg{i}'))
    return b


def spider(tex, eyes, phase=None, s=0.8):
    a = 0.0 if phase is None else math.cos(phase) * 0.4
    b = [mc_box(tex, (32, 4), (-4, -4, -8), (8, 8, 8), pivot=(0, 15, -3), s=s, part='head'),
         mc_box(eyes, (32, 4), (-4, -4, -8), (8, 8, 8), pivot=(0, 15, -3), s=s, part='head', glow=True, inflate=0.01),
         mc_box(tex, (0, 0), (-3, -3, -3), (6, 6, 6), pivot=(0, 15, 0), s=s, part='neck'),
         mc_box(tex, (0, 12), (-5, -4, -6), (10, 8, 12), pivot=(0, 15, 9), s=s, part='body')]
    # legs: Minecraft splays them with fixed z/y rotations, then the walk adds to the y rotation
    q = math.pi / 4
    rows = [(2, q * 0.74, q * 2 / 4 * 1.0), (1, q * 0.58, q / 4), (0, q * 0.58, -q / 4), (-1, q * 0.74, -q * 2 / 4)]
    for k, (pz, zr, yr) in enumerate(rows):
        sw = a * (1 if k % 2 == 0 else -1)
        b.append(mc_box(tex, (18, 0), (-15, -1, -1), (16, 2, 2), pivot=(-4, 15, pz), rot=(0, yr + sw, -zr), s=s, part=f'rleg{k}'))
        b.append(mc_box(tex, (18, 0), (-1, -1, -1), (16, 2, 2), pivot=(4, 15, pz), rot=(0, -yr - sw, zr), s=s, part=f'lleg{k}'))
    return b


def quadruped_legs(tex, uv, size, pivots, a, s, inflate=0.0):
    out = []
    for i, (px, py, pz) in enumerate(pivots):
        sgn = 1 if i in (0, 3) else -1
        out.append(mc_box(tex, uv, (-size[0] / 2, 0, -size[2] / 2), size, pivot=(px, py, pz), rot=(a * sgn, 0, 0), s=s, inflate=inflate, part=f'leg{i}'))
    return out


def sheep(tex, fur, phase=None, s=0.8, sheared=False):
    a = 0.0 if phase is None else swing(phase)
    b = [mc_box(tex, (0, 0), (-3, -4, -6), (6, 6, 8), pivot=(0, 6, -8), s=s, part='head'),
         mc_box(tex, (28, 8), (-4, -10, -7), (8, 16, 6), pivot=(0, 5, 2), rot=(math.pi / 2, 0, 0), s=s, part='body')]
    b += quadruped_legs(tex, (0, 16), (4, 12, 4), [(-3, 12, 7), (3, 12, 7), (-3, 12, -5), (3, 12, -5)], a, s)
    if not sheared:
        b += [mc_box(fur, (0, 0), (-3, -4, -4), (6, 6, 6), pivot=(0, 6, -8), inflate=0.6, s=s, part='head'),
              mc_box(fur, (28, 8), (-4, -10, -7), (8, 16, 6), pivot=(0, 5, 2), rot=(math.pi / 2, 0, 0), inflate=1.75, s=s, part='body')]
        for i, (px, py, pz) in enumerate([(-3, 12, 7), (3, 12, 7), (-3, 12, -5), (3, 12, -5)]):
            sgn = 1 if i in (0, 3) else -1
            b.append(mc_box(fur, (0, 16), (-2, 0, -2), (4, 6, 4), pivot=(px, py, pz), rot=(a * sgn, 0, 0), inflate=0.5, s=s, part=f'leg{i}'))
    return b


def cow(tex, phase=None, s=0.72):
    a = 0.0 if phase is None else swing(phase)
    b = [mc_box(tex, (0, 0), (-4, -4, -6), (8, 8, 6), pivot=(0, 4, -8), s=s, part='head'),
         mc_box(tex, (22, 0), (-5, -5, -4), (1, 3, 1), pivot=(0, 4, -8), s=s, part='head'),
         mc_box(tex, (22, 0), (4, -5, -4), (1, 3, 1), pivot=(0, 4, -8), s=s, part='head'),
         mc_box(tex, (18, 4), (-6, -10, -7), (12, 18, 10), pivot=(0, 5, 2), rot=(math.pi / 2, 0, 0), s=s, part='body'),
         mc_box(tex, (52, 0), (-2, 2, -8), (4, 6, 1), pivot=(0, 5, 2), rot=(math.pi / 2, 0, 0), s=s, part='body')]
    b += quadruped_legs(tex, (0, 16), (4, 12, 4), [(-4, 12, 7), (4, 12, 7), (-4, 12, -6), (4, 12, -6)], a, s)
    return b


def pig(tex, phase=None, s=0.8):
    a = 0.0 if phase is None else swing(phase)
    b = [mc_box(tex, (0, 0), (-4, -4, -8), (8, 8, 8), pivot=(0, 12, -6), s=s, part='head'),
         mc_box(tex, (16, 16), (-2, 0, -9), (4, 3, 1), pivot=(0, 12, -6), s=s, part='head'),
         mc_box(tex, (28, 8), (-5, -10, -7), (10, 16, 8), pivot=(0, 11, 2), rot=(math.pi / 2, 0, 0), s=s, part='body')]
    b += quadruped_legs(tex, (0, 16), (4, 6, 4), [(-3, 18, 7), (3, 18, 7), (-3, 18, -5), (3, 18, -5)], a, s)
    return b


def chicken(tex, phase=None, s=1.0, flap=0.0):
    a = 0.0 if phase is None else swing(phase)
    b = [mc_box(tex, (0, 0), (-2, -6, -2), (4, 6, 3), pivot=(0, 15, -4), s=s, part='head'),
         mc_box(tex, (14, 0), (-2, -4, -4), (4, 2, 2), pivot=(0, 15, -4), s=s, part='head'),
         mc_box(tex, (14, 4), (-1, -2, -3), (2, 2, 2), pivot=(0, 15, -4), s=s, part='head'),
         mc_box(tex, (0, 9), (-3, -4, -3), (6, 8, 6), pivot=(0, 16, 0), rot=(math.pi / 2, 0, 0), s=s, part='body'),
         mc_box(tex, (26, 0), (-1, 0, -3), (3, 5, 3), pivot=(-2, 19, 1), rot=(a, 0, 0), s=s, part='rleg'),
         mc_box(tex, (26, 0), (-1, 0, -3), (3, 5, 3), pivot=(1, 19, 1), rot=(-a, 0, 0), s=s, part='lleg'),
         mc_box(tex, (24, 13), (0, 0, -3), (1, 4, 6), pivot=(-4, 13, 0), rot=(0, 0, flap), s=s, part='rwing'),
         mc_box(tex, (24, 13), (-1, 0, -3), (1, 4, 6), pivot=(4, 13, 0), rot=(0, 0, -flap), s=s, part='lwing')]
    return b


# ---------------------------------------------------------------- the Nether's mobs
def _lift(boxes, dy):
    """Move boxes up by dy (after mc_box has placed them), pivots included."""
    for b in boxes:
        b.pos = b.pos + [0, dy, 0]; b.pivot = b.pivot + [0, dy, 0]
    return boxes


def _stretch(boxes, sx, sy, sz):
    """Scale whole (unrotated) models about the origin, non-uniformly: the magma cube's squash and stretch."""
    k = [sx, sy, sz]
    for b in boxes:
        b.pos = b.pos * k; b.pivot = b.pivot * k; b.scale = b.scale * k
    return boxes


def zombified_piglin(tex, pose=None, prop=STEVE):
    """Minecraft's PiglinModel on the chibi player body: the player model's body, sleeves and pants, and the
    piglin head (10 wide, snout, two tusks and floppy ears) in place of the 8-cube head and hat."""
    p = dict(pose or {})
    boxes, info = steve(tex, p, prop)
    boxes = [b for b in boxes if b.part != 'head']
    y = info['top'] - 8                                   # the neck
    hp = p.get('head_pitch', 0.0)
    head = [mc_box(tex, (0, 0), (-5, -8, -4), (10, 8, 8), rot=(-R(hp), 0, 0), part='head'),
            mc_box(tex, (31, 1), (-2, -4, -5), (4, 4, 1), rot=(-R(hp), 0, 0), part='head'),
            mc_box(tex, (2, 4), (2, -2, -5), (1, 2, 1), rot=(-R(hp), 0, 0), part='head'),
            mc_box(tex, (2, 0), (-3, -2, -5), (1, 2, 1), rot=(-R(hp), 0, 0), part='head'),
            mc_box(tex, (51, 6), (0, 0, -2), (1, 5, 4), pivot=(4.5, -6, 0), rot=(0, 0, -math.pi / 6), part='head'),
            mc_box(tex, (39, 6), (-1, 0, -2), (1, 5, 4), pivot=(-4.5, -6, 0), rot=(0, 0, math.pi / 6), part='head')]
    return boxes + _lift(head, y - 24), info


# Java's Random, for the ghast's tentacle lengths (GhastModel seeds it with 1660)
class _JRandom:
    def __init__(self, seed):
        self.s = (seed ^ 0x5DEECE66D) & ((1 << 48) - 1)

    def next(self, bits):
        self.s = (self.s * 0x5DEECE66D + 0xB) & ((1 << 48) - 1)
        r = self.s >> (48 - bits)
        return r - (1 << 32) if r >= 1 << 31 else r

    def next_int(self, n):
        if n & -n == n:
            return (n * self.next(31)) >> 31
        while True:
            bits = self.next(31); val = bits % n
            if bits - val + (n - 1) < (1 << 31):
                return val


def ghast(tex, age=0.0, s=2.0, tent=0.75):
    """GhastModel: a 16-cube body and nine tentacles of seeded length that sway (xRot = 0.2 sin(0.3 age + i) + 0.4).
    `tent` shortens the tentacles so the sprite stays about 48 px; the tentacle tips sit at y = 0."""
    rnd = _JRandom(1660)
    b = [mc_box(tex, (0, 0), (-8, -8, -8), (16, 16, 16), pivot=(0, 17.6, 0), s=s, part='body')]
    low = 0.0
    for i in range(9):
        fx = ((i % 3) - (i // 3 % 2) * 0.5 + 0.25 - 1.0) * 5.0
        fz = (i // 3 - 1.0) * 5.0
        n = rnd.next_int(7) + 8
        L = n * tent
        xr = 0.2 * math.sin(age * 0.3 + i) + 0.4
        bx = mc_box(tex, (0, 0), (-1, 0, -1), (2, n, 2), pivot=(fx, 24.6, fz), rot=(xr, 0, 0), s=s, part=f't{i}')
        bx.scale = bx.scale * [1, L / n, 1]
        bx.pos = bx.pivot + (bx.pos - bx.pivot) * [1, L / n, 1]
        b.append(bx)
        low = max(low, (24.6 + L * math.cos(xr)) - 24)
    return _lift(b, low * s)


def blaze(tex, age=0.0, s=1.0):
    """BlazeModel: the head and three rings of four rods that orbit and bob with age (ticks), as setupAnim moves them."""
    b = [mc_box(tex, (0, 0), (-4, -4, -4), (8, 8, 8), s=s, part='head')]
    rods = []
    f = age * math.pi * -0.1
    for i in range(4):
        rods.append((math.cos(f) * 9, -2 + math.cos((i * 2 + age) * 0.25), math.sin(f) * 9)); f += 1
    f = 0.7853982 + age * math.pi * 0.03
    for j in range(4, 8):
        rods.append((math.cos(f) * 7, 2 + math.cos((j * 2 + age) * 0.25), math.sin(f) * 7)); f += 1
    f = 0.47123894 + age * math.pi * -0.05
    for k in range(8, 12):
        rods.append((math.cos(f) * 5, 11 + math.cos((k * 1.5 + age) * 0.5), math.sin(f) * 5)); f += 1
    for i, (x, y, z) in enumerate(rods):
        b.append(mc_box(tex, (0, 16), (0, 0, 0), (2, 8, 2), pivot=(x, y, z), s=s, part=f'rod{i}'))
    return b


def magma_cube(tex, size=1.0, squish=0.0):
    """LavaSlimeModel: eight 8x8x1 slices and an inner core. squish > 0 (a jump) pulls the slices apart and
    stretches the cube tall; squish < 0 (a landing) flattens it wide, with MagmaCubeRenderer's own scale rule
    (Minecraft's size 1, 2 or 4 is `size` here, in pixels per texel)."""
    b = []
    for i in range(8):
        u, v = (0, 9 * i) if i < 4 else (32, 9 * i - 36)
        bx = mc_box(tex, (u, v), (-4, 16 + i, -4), (8, 1, 8), s=1.0, part=f's{i}')
        dy = (4 - i) * max(0.0, squish) * 1.7
        bx.pos = bx.pos + [0, dy, 0]; bx.pivot = bx.pivot + [0, dy, 0]
        b.append(bx)
    b.append(mc_box(tex, (24, 40), (-2, 18, -2), (4, 4, 4), s=1.0, part='core'))
    n = {1.0: 1, 2.0: 2}.get(size, 4)                 # Minecraft size for the squish rule
    f = squish / (n * 0.5 + 1.0)
    f1 = 1.0 / (f + 1.0)
    return _stretch(b, f1 * size, size / f1, f1 * size)


WITHER = dict(leg_sy=0.46, body_sy=0.64, arm_sx=0.75, arm_sy=0.64, dz=1.5, arm_dz=1.0)   # taller than a skeleton (Minecraft scales it 1.2)


# ---------------------------------------------------------------- The End: enderman, silverfish, end crystal, Ender Dragon
ENDERMAN = dict(leg_sy=0.72, body_sy=0.75, arm_sy=0.72, dz=1.25)


def enderman(tex, eyes, pose=None, prop=ENDERMAN):
    """EndermanModel on a chibi frame (head one texel per pixel, the 30-texel limbs shortened) so it stands
    about 2.5 tiles. pose: leg/arm swing, rarm/larm (raised arms), open (the head lifts off its jaw, the
    creepy face), head_yaw/head_roll (the stare's shaking). Returns (boxes, eye_box_indexes)."""
    p = {'leg': 0.0, 'arm': 0.0, 'rarm': None, 'larm': None, 'open': 0.0, 'head_yaw': 0.0, 'head_roll': 0.0, 'bob': 0.0}
    p.update(pose or {})
    ls, bs, asy, dz = prop['leg_sy'], prop['body_sy'], prop['arm_sy'], prop['dz']
    L = 30 * ls + p['bob']
    top = L + 12 * bs
    arm_h = 30 * asy
    b = []
    b.append(Box(tex, (56, 0), (2, 30, 2), (-3, p['bob'], -dz), (1, ls, dz), pivot=(-2, L, 0), rot=(R(p['leg']), 0, 0), part='rleg'))
    b.append(Box(tex, (56, 0), (2, 30, 2), (1, p['bob'], -dz), (1, ls, dz), pivot=(2, L, 0), rot=(R(-p['leg']), 0, 0), part='lleg', mirror=True))
    b.append(Box(tex, (32, 16), (8, 12, 4), (-4, L, -2 * dz), (1, bs, dz), part='body'))
    ra = R(-p['arm']) if p['rarm'] is None else R(p['rarm'])
    la = R(p['arm']) if p['larm'] is None else R(p['larm'])
    b.append(Box(tex, (56, 0), (2, 30, 2), (-6, top - arm_h, -dz), (1, asy, dz), pivot=(-5, top - 0.5, 0), rot=(ra, 0, 0), part='rarm'))
    b.append(Box(tex, (56, 0), (2, 30, 2), (4, top - arm_h, -dz), (1, asy, dz), pivot=(5, top - 0.5, 0), rot=(la, 0, 0), part='larm', mirror=True))
    hr = (0, R(p['head_yaw']), R(p['head_roll']))
    # the jaw: Minecraft's "hat" box, shrunk half a texel inside the head; it shows when the head lifts
    b.append(Box(tex, (0, 16), (8, 8, 8), (-4, top, -4), pivot=(0, top, 0), rot=hr, part='jaw', inflate=-0.5))
    hy = top + p['open']
    b.append(Box(tex, (0, 0), (8, 8, 8), (-4, hy, -4), pivot=(0, hy, 0), rot=hr, part='head'))
    b.append(Box(eyes, (0, 0), (8, 8, 8), (-4, hy, -4), pivot=(0, hy, 0), rot=hr, part='head', glow=True, inflate=0.02))
    return b, [len(b) - 1]


SILVERFISH_SIZES = ((3, 2, 2), (4, 3, 2), (6, 4, 3), (3, 3, 3), (2, 2, 3), (2, 1, 2), (1, 1, 2))
SILVERFISH_UV = ((0, 0), (0, 4), (0, 9), (0, 16), (0, 22), (11, 0), (13, 4))


def silverfish(tex, age=None, s=1.0):
    """SilverfishModel: seven body segments and three layers of scales, wiggling as setupAnim does
    (yRot = cos(0.9 age + 0.15 pi i) * pi * 0.05 * (1 + |i - 2|), x = sin(...) * pi * 0.2 * |i - 2|)."""
    zs, f = [], -3.5
    for i in range(7):
        zs.append(f)
        if i < 6:
            f += (SILVERFISH_SIZES[i][2] + SILVERFISH_SIZES[i + 1][2]) * 0.5
    yr, xs = [], []
    for i in range(7):
        a = 0.0 if age is None else age * 0.9 + i * 0.15 * math.pi
        yr.append(0.0 if age is None else math.cos(a) * math.pi * 0.05 * (1 + abs(i - 2)))
        xs.append(0.0 if age is None else math.sin(a) * math.pi * 0.2 * abs(i - 2))
    b = []
    for i, (w, h, d) in enumerate(SILVERFISH_SIZES):
        b.append(mc_box(tex, SILVERFISH_UV[i], (-w / 2, 0, -d / 2), (w, h, d), pivot=(xs[i], 24 - h, zs[i]), rot=(0, yr[i], 0), s=s, part=f'seg{i}'))
    for (uv, org, size, py, seg) in (((20, 0), (-5, 0, -1.5), (10, 8, 3), 16, 2), ((20, 11), (-3, 0, -1.5), (6, 4, 3), 20, 4), ((20, 18), (-3, 0, -1), (6, 5, 2), 19, 1)):
        b.append(mc_box(tex, uv, org, size, pivot=(xs[seg], py, zs[seg]), rot=(0, yr[seg], 0), s=s, part=f'layer{seg}'))
    return b


# ---- a model hierarchy in Minecraft's own frame (y down, front -z, ZYX part rotations) for the big models
def mc_rot(x, y, z):
    from mcmodel import rot_z, rot_y
    return rot_z(z) @ rot_y(y) @ rot_x(x)


class Pose:
    """A part's global transform in Minecraft model space: point = R @ local + t."""
    def __init__(self, R=None, t=(0, 0, 0)):
        import numpy as np
        self.R = np.eye(3) if R is None else R
        self.t = np.array(t, float)

    def child(self, offset=(0, 0, 0), rot=(0, 0, 0), scale=1.0):
        import numpy as np
        return Pose(self.R @ mc_rot(*rot) * scale, self.R @ np.array(offset, float) + self.t)


def mc_cube(pose, tex, uv, origin, size, s=1.0, ts=1, inflate=0.0, mirror=False, glow=False, part=''):
    """One cube of a posed part as a renderer Box. `ts` is the texture's resolution multiple (a 128x64
    texture for a 64x32 model); `s` scales the whole model (screen pixels per model texel)."""
    import numpy as np
    F = np.diag([1.0, -1.0, -1.0])
    x0, y0, z0 = origin
    w, h, d = size
    R = pose.R
    k = np.cbrt(abs(np.linalg.det(R))) or 1.0          # a uniform part scale folded into the matrix
    Rn = R / k
    c = F @ (R @ np.array([x0, y0 + h, z0 + d], float) + pose.t)
    M = F @ Rn @ F
    sc = s * k
    return Box(tex, (uv[0] * ts, uv[1] * ts), (w * ts, h * ts, d * ts), c * s, scale=(sc / ts,) * 3, pivot=c * s, mat=M,
               inflate=inflate * sc, mirror=mirror, glow=glow, part=part)


def end_crystal(tex, spin=0.0, s=2.0, base=False):
    """EndCrystalModel (texture at twice the model's 64x32): the outer glass, the inner glass and the core,
    each tilted 60 degrees about the (1, 0, 1) diagonal and spun about y, nested at 0.875 scale. The cube's
    centre is the origin; `base` returns the bedrock slab instead (its top at the origin)."""
    import numpy as np
    if base:
        return [mc_cube(Pose(), tex, (0, 16), (-6, 0, -6), (12, 4, 12), s=s, ts=2, part='base')]
    q = math.sqrt(0.5)
    ax = np.array([q, 0, q])

    def aa(angle):
        c, sn = math.cos(angle), math.sin(angle)
        K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
        return np.eye(3) + sn * K + (1 - c) * K @ K
    from mcmodel import rot_y
    r60 = aa(math.pi / 3)
    outer = rot_y(spin) @ r60
    inner = outer @ (0.875 * (r60 @ rot_y(spin)))
    core = inner @ (0.875 * (r60 @ rot_y(spin)))
    out = []
    for i, (Rm, uv) in enumerate(((core, (32, 0)), (inner, (0, 0)), (outer, (0, 0)))):
        out.append(mc_cube(Pose(Rm), tex, uv, (-4, -4, -4), (8, 8, 8), s=s, ts=2, glow=False, part=('core', 'inner', 'outer')[i]))
    return out


# The Ender Dragon (EnderDragonModel, 256x256 texture). Part positions follow the model's own numbers; the
# neck and tail chains are laid out the way the renderer walks them (10 texels per segment), shortened to
# `neck_n` and `tail_n` segments so the sprite keeps the spec's proportions (about 6 tiles long, 8 across).
DRAGON_GROUND = 67.0          # model y (down) of the ground under a standing dragon
DRAGON_CENTRE_Z = 24.0        # the body's middle


def _dragon_head(P, tex, eyes, jaw, s, out):
    for org, size, uv, mir in (((-6, -1, -24), (12, 5, 16), (176, 44), False), ((-8, -8, -10), (16, 16, 16), (112, 30), False),
                               ((-5, -12, -4), (2, 4, 6), (0, 0), True), ((-5, -3, -22), (2, 2, 4), (112, 0), True),
                               ((3, -12, -4), (2, 4, 6), (0, 0), False), ((3, -3, -22), (2, 2, 4), (112, 0), False)):
        out.append(mc_cube(P, tex, uv, org, size, s=s, mirror=mir, part='head'))
    for org, size, uv in (((-6, -1, -24), (12, 5, 16), (176, 44)), ((-8, -8, -10), (16, 16, 16), (112, 30))):
        out.append(mc_cube(P, eyes, uv, org, size, s=s, inflate=0.03, glow=True, part='eyes'))
    J = P.child((0, 4, -8), (jaw, 0, 0))
    out.append(mc_cube(J, tex, (176, 65), (-6, 0, -16), (12, 4, 16), s=s, part='jaw'))
    out.append(mc_cube(J, eyes, (176, 65), (-6, 0, -16), (12, 4, 16), s=s, inflate=0.03, glow=True, part='eyes'))


def _dragon_leg(P, tex, side, kind, rots, s, out):
    """side -1 = right (x < 0), +1 = left (mirrored); kind 'front' or 'rear'; rots = (upper, tip, foot) xRot."""
    m = side > 0
    fx = lambda x0, w: (-(x0 + w) if m else x0)        # mirror a box across x
    if kind == 'front':
        L = P.child((12 * side, 20, 2), (rots[0], 0, 0))
        out.append(mc_cube(L, tex, (112, 104), (fx(-4, 8), -4, -4), (8, 24, 8), s=s, mirror=m, part='leg'))
        T = L.child((0, 20, -1), (rots[1], 0, 0))
        out.append(mc_cube(T, tex, (226, 138), (fx(-3, 6), -1, -3), (6, 24, 6), s=s, mirror=m, part='leg'))
        Fo = T.child((0, 23, 0), (rots[2], 0, 0))
        out.append(mc_cube(Fo, tex, (144, 104), (fx(-4, 8), 0, -12), (8, 4, 16), s=s, mirror=m, part='foot'))
    else:
        L = P.child((16 * side, 16, 42), (rots[0], 0, 0))
        out.append(mc_cube(L, tex, (0, 0), (fx(-8, 16), -4, -8), (16, 32, 16), s=s, mirror=m, part='leg'))
        T = L.child((0, 32, -4), (rots[1], 0, 0))
        out.append(mc_cube(T, tex, (196, 0), (fx(-6, 12), -2, 0), (12, 32, 12), s=s, mirror=m, part='leg'))
        Fo = T.child((0, 31, 4), (rots[2], 0, 0))
        out.append(mc_cube(Fo, tex, (112, 0), (fx(-9, 18), 0, -20), (18, 6, 24), s=s, mirror=m, part='foot'))


def _leg_bottom(kind, rots):
    """Lowest model y a leg reaches with these rotations (to stand the dragon on the ground)."""
    import numpy as np
    out = []
    _dragon_leg(Pose(), None, -1, kind, rots, 1.0, out)
    ys = []
    for b in out:
        e = b.extent()
        for i in (0, 1):
            for j in (0, 1):
                for l in (0, 1):
                    p = b.pivot + b.mat @ (np.array([i * e[0], j * e[1], l * e[2]]) - 0)
                    ys.append(-p[1])        # renderer y up -> model y down
    return max(ys)


def ender_dragon(tex, eyes, phase=0.0, mode='fly', s=1.0, neck_n=4, tail_n=7):
    """The dragon posed. phase 0..1 is the wing beat (Minecraft's flapTime). mode:
      fly     flying: wings beating, legs trailing, neck and tail level with a slow wave
      perch   standing on the fountain, wings folded along the body, head up
      breath  standing, neck and head down toward the ground, jaws wide (the perched breath attack)
      pant    standing, exhausted: head low, jaws a little open, the body rising and falling with phase
      death   wings spread stiff, head thrown back, jaws open (rising over the fountain)
    The model is moved so the body's middle is at x = z = 0 and the ground under a standing dragon at y = 0."""
    a = phase * 2 * math.pi
    f1 = math.sin(a - 1) + 1
    f1 = (f1 * f1 + f1 * 2) * 0.05
    stand = mode in ('perch', 'breath', 'pant')
    bob = 0.0
    if mode == 'fly':
        bob = (f1 - 0.2) * 10
    elif mode == 'pant':
        bob = math.sin(a) * 1.5
    root = Pose(None, (0, -DRAGON_GROUND + bob, -DRAGON_CENTRE_Z))
    out = []
    # neck
    x, y, z = 0.0, 20.0, -12.0
    for i in range(neck_n):
        if mode == 'fly':
            xr, yr = math.cos(i * 0.45 + a) * 0.08 + 0.02, 0.0
        elif mode == 'perch':
            xr, yr = -0.32 + i * 0.06, 0.0
        elif mode == 'breath':
            xr, yr = -0.15 + i * 0.22, 0.0
        elif mode == 'pant':
            xr, yr = -0.05 + i * 0.14, 0.0
        else:
            xr, yr = -0.45, 0.0
        N = root.child((x, y, z), (xr, yr, 0))
        out.append(mc_cube(N, tex, (192, 104), (-5, -5, -5), (10, 10, 10), s=s, part='neck'))
        out.append(mc_cube(N, tex, (48, 0), (-1, -9, -3), (2, 4, 6), s=s, part='neck'))
        y += math.sin(xr) * 10
        z -= math.cos(yr) * math.cos(xr) * 10
        x -= math.sin(yr) * math.cos(xr) * 10
    hx = {'fly': 0.05, 'perch': 0.25, 'breath': 0.75, 'pant': 0.45, 'death': -0.5}[mode]
    jaw = {'fly': (math.sin(a) + 1) * 0.2, 'perch': 0.08, 'breath': 0.65, 'pant': 0.18 + 0.12 * math.sin(a), 'death': 0.55}[mode]
    _dragon_head(root.child((x, y, z), (hx, 0, 0)), tex, eyes, jaw, s, out)
    # body
    B = root.child((0, 4, 8))
    out.append(mc_cube(B, tex, (0, 0), (-12, 0, -16), (24, 24, 64), s=s, part='body'))
    for zz in (-10, 10, 30):
        out.append(mc_cube(B, tex, (220, 53), (-1, -6, zz), (2, 6, 12), s=s, part='body'))
    # wings (the left one is the right one mirrored, as the renderer draws it)
    if mode == 'fly':
        wr = (0.125 - math.cos(a) * 0.2, 0.25, (math.sin(a) + 0.125) * 0.8)
        tr = (0.0, 0.0, -(math.sin(a + 2) + 0.5) * 0.75)
    elif mode == 'death':
        wr, tr = (0.1, 0.3, 0.25), (0.0, 0.0, -0.15)
    else:   # folded along the back
        # the bone swept back along the flank, the tip rolled over and folded forward along it, so both
        # membranes lie over the back
        wr, tr = (0.1, 1.4, 0.15), (math.pi, -2.8, 0.0)
        if mode == 'pant':
            wr = (0.1, 1.4, 0.15 + 0.08 * math.sin(a))
    for side in (-1, 1):
        m = side > 0
        fx = lambda x0, w: (-(x0 + w) if m else x0)
        Wg = root.child((12 * side, 5, 2), (wr[0], wr[1] * -side, wr[2] * -side))
        out.append(mc_cube(Wg, tex, (112, 88), (fx(-56, 56), -4, -4), (56, 8, 8), s=s, mirror=m, part='wing'))
        out.append(mc_cube(Wg, tex, (-56, 88), (fx(-56, 56), 0, 2), (56, 0, 56), s=s, mirror=m, part='skin'))
        Tp = Wg.child((56 * side, 0, 0), (tr[0], tr[1] * -side, tr[2] * -side))
        out.append(mc_cube(Tp, tex, (112, 136), (fx(-56, 56), -2, -2), (56, 4, 4), s=s, mirror=m, part='wing'))
        out.append(mc_cube(Tp, tex, (-56, 144), (fx(-56, 56), 0, 2), (56, 0, 56), s=s, mirror=m, part='skin'))
    # legs
    if stand:
        front, rear = STAND_LEGS
    elif mode == 'death':
        front, rear = (0.6, -0.3, 0.4), (0.5, 0.3, 0.4)
    else:
        front = (1.3 + f1 * 0.1, -0.5 - f1 * 0.1, 0.75 + f1 * 0.1)
        rear = (1.0 + f1 * 0.1, 0.5 + f1 * 0.1, 0.75 + f1 * 0.1)
    for side in (-1, 1):
        _dragon_leg(root, tex, side, 'front', front, s, out)
        _dragon_leg(root, tex, side, 'rear', rear, s, out)
    # tail
    x, y, z = 0.0, 10.0, 60.0
    for j in range(tail_n):
        if mode == 'fly':
            xr, yr = 0.06 + math.cos(j * 0.45 + a) * 0.05, math.sin(a - j * 0.55) * 0.07
        elif mode == 'death':
            xr, yr = 0.12, 0.0
        else:   # resting on the ground behind, curling a little
            xr, yr = (0.38 if j < 2 else 0.0), 0.16 * j / tail_n
        T = root.child((x, y, z), (xr, yr, 0))
        out.append(mc_cube(T, tex, (192, 104), (-5, -5, -5), (10, 10, 10), s=s, part='tail'))
        out.append(mc_cube(T, tex, (48, 0), (-1, -9, -3), (2, 4, 6), s=s, part='tail'))
        y += math.sin(xr) * 10
        z += math.cos(yr) * math.cos(xr) * 10
        x += math.sin(yr) * math.cos(xr) * 10
    return out


def _stand_legs():
    """Leg angles for standing: the front legs nearly straight, the long hind legs folded (thigh forward,
    shin back, foot flat) until both reach the same ground."""
    front = (0.12, -0.12, 0.0)
    target = _leg_bottom('front', front)
    best = None
    for i in range(0, 160):
        t = -i * 0.01
        rots = (t, -2 * t, t)
        err = abs(_leg_bottom('rear', rots) - target)
        if best is None or err < best[0]:
            best = (err, rots)
    return front, best[1], target


STAND_LEGS = None
try:
    _f, _r, DRAGON_GROUND = _stand_legs()
    STAND_LEGS = (_f, _r)
except Exception:          # imported without numpy setup problems: fall back to fixed angles
    STAND_LEGS = ((0.12, -0.12, 0.0), (-0.75, 1.5, -0.75))


# The Wither (WitherBossModel, 64x64 texture): the shoulders, the ribcage (spine and three ribs), the tail, the centre
# head and the two smaller side heads, all children of the root, with setupAnim's ribcage and tail sway. The model is
# moved so the ground under it (model y 24, as the renderer stands every entity) is at y = 0.
WITHER_RIB = 0.20420352       # the ribcage's rest xRot in the layer definition


def wither(tex, age=0.0, s=2.0, inflate=0.0, centre=(0.0, 0.0), right=(0.0, 0.0), left=(0.0, 0.0), droop=0.0,
           tilt=0.0, roll=0.0):
    """The Wither posed. age (ticks) drives setupAnim: ribcage xRot (0.065 + 0.05 cos(age 0.1)) pi and the tail
    (0.265 + 0.1 cos) pi hung from the ribcage's end. centre / right / left are the heads' (yRot, xRot) in radians
    (Minecraft's frame: positive xRot looks down). droop 0..1 lets the ribcage and tail hang further (the drained
    pose); tilt pitches the whole body forward about the shoulders; roll tips it over sideways about the ground
    point (the death fall, LivingEntityRenderer's 90 degrees). inflate is the armour layer's CubeDeformation(0.5)."""
    f = math.cos(age * 0.1)
    rib = (0.065 + 0.05 * f) * math.pi + droop * 0.32
    tl = (0.265 + 0.1 * f) * math.pi + droop * 0.45
    R0 = mc_rot(tilt, 0, roll)
    import numpy as np
    root = Pose(R0, R0 @ np.array([0.0, -24.0, 0.0]))
    out = []
    cube = lambda P, uv, org, size, part: out.append(mc_cube(P, tex, uv, org, size, s=s, inflate=inflate, part=part))
    cube(root, (0, 16), (-10, 3.9, -0.5), (20, 3, 3), 'body')
    Rb = root.child((-2, 6.9, -0.5), (rib, 0, 0))
    cube(Rb, (0, 22), (0, 0, 0), (3, 10, 3), 'body')
    for y in (1.5, 4.0, 6.5):
        cube(Rb, (24, 22), (-4, y, 0.5), (11, 2, 2), 'body')
    Tl = root.child((-2, 6.9 + math.cos(rib) * 10, -0.5 + math.sin(rib) * 10), (tl, 0, 0))
    cube(Tl, (12, 22), (0, 0, 0), (3, 6, 3), 'body')
    cube(root.child((0, 0, 0), (centre[1], centre[0], 0)), (0, 0), (-4, -4, -4), (8, 8, 8), 'head')
    cube(root.child((-8, 4, 0), (right[1], right[0], -droop * 0.3)), (32, 0), (-4, -4, -4), (6, 6, 6), 'rhead')
    cube(root.child((10, 4, 0), (left[1], left[0], droop * 0.3)), (32, 0), (-4, -4, -4), (6, 6, 6), 'lhead')
    if roll:
        # tipped over about its feet, the shoulder on that side would sink into the ground: lift it to lie on it
        low = min((bx.pivot + bx.mat @ (bx.pos - bx.inflate - bx.pivot) + bx.mat @ np.array([i, j, l], float) * bx.extent())[1]
                  for bx in out for i in (0, 1) for j in (0, 1) for l in (0, 1))
        if low < 0:
            _lift(out, -low)
    return out


def wither_skull(tex, s=1.0):
    """The wither skull projectile (WitherSkullRenderer's SkullModel head: 8x8x8 at uv 0,35 of wither.png, or of
    wither_invulnerable.png for the blue 'dangerous' skull), centred on the origin."""
    return [mc_cube(Pose(), tex, (0, 35), (-4, -4, -4), (8, 8, 8), s=s, part='skull')]
