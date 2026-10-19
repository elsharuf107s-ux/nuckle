#!/usr/bin/env python3
"""The WITHER as a POKéMON (wither-update.md section 3): its FireRed graphics, cry and battle background, made from
Minecraft's own Wither (WitherBossModel posed freely, entity/wither textures) the way tools/build_ender_dragon.py made
the ENDER DRAGON's, and its species data. tools/build_pokemon.py calls build_all() and puts SPECIES in pokemon.json.

Outputs:
  assets/mon/wither_front.png, _back.png (64x64), _front_shiny.png, _back_shiny.png, _icon.png (32x64, two frames)
  assets/sprites/ow_wither.png, ow_wither_shiny.png    the follower: 6 frames of 32x32 like the expansion's sheets
  assets/cries/wither.wav                              8-bit mono 10512 Hz like FireRed's cries (silent unless the
                                                       Wither sounds are fetched: see CRY_SRC)
  assets/battle/bg_wither.png                          a soul sand valley in its teal haze, in FireRed's terrain style

The shiny WITHER is Minecraft's own other Wither: the blue of wither_invulnerable.png (its spawn charge), as a
FireRed palette swap.
"""
import math
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mcmodel as M  # noqa: E402
from models import Pose, mc_cube, mc_rot  # noqa: E402
from build_ender_dragon import cam, view_render, gba, save_rgba, downsample  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
TX = HERE / 'vendor' / 'minecraft' / 'jar' / 'assets' / 'minecraft' / 'textures'
SND = HERE / 'vendor' / 'minecraft' / 'sounds'
FR = HERE / 'vendor' / 'pokefirered'
OUT = HERE / 'assets'
NAME = 'wither'


def texture():
    """wither.png with the teeth told apart from the eyes: both are the same pale grey in Minecraft's texture, so the
    teeth (each face's lower pale row) are nudged a little darker for classify() to tell them apart."""
    t = M.load_tex(TX / 'entity' / 'wither' / 'wither.png').copy()
    for (u, v, n) in ((0, 0, 8), (32, 0, 6)):           # the centre head's and the side heads' boxes
        face = t[v + n:v + 2 * n, u + n:u + 2 * n]       # the front face
        lum = face[..., :3].astype(int).mean(-1)
        rows = [y for y in range(n) if (lum[y] >= 120).any()]
        if len(rows) >= 2:
            y = rows[-1]
            face[y][lum[y] >= 120, :3] = 140
    return t


# ---------------------------------------------------------------- the Wither posed for its portraits
def pose(tex, p, s=1.0):
    """WitherBossModel (the same parts and texture boxes as models.wither), posed freely. p keys:
      age: setupAnim's sway tick; rib / tail: extra ribcage and tail xRot on top of the sway;
      centre / right / left: each head's (yRot, xRot, zRot); hscale: head size (1 = Minecraft's);
      shoulder_z: the shoulder bar's roll; tilt: the whole body's pitch forward."""
    f = math.cos(p.get('age', 0.0) * 0.1)
    rib = (0.065 + 0.05 * f) * math.pi + p.get('rib', 0.0)
    tl = (0.265 + 0.1 * f) * math.pi + p.get('tail', 0.0)
    R0 = mc_rot(p.get('tilt', 0.0), 0, p.get('roll', 0.0))
    root = Pose(R0, R0 @ np.array([0.0, -24.0, 0.0]))
    hs = p.get('hscale', 1.0)
    out = []

    def cube(P, uv, org, size, part):
        out.append(mc_cube(P, tex, uv, org, size, s=s, part=part))
    sh = root.child((0, 5.4, 0), (0, 0, p.get('shoulder_z', 0.0)))
    cube(sh, (0, 16), (-10, -1.5, -0.5), (20, 3, 3), 'shoulders')
    Rb = root.child((-2, 6.9, -0.5), (rib, 0, 0))
    cube(Rb, (0, 22), (0, 0, 0), (3, 10, 3), 'spine')
    for i, y in enumerate((1.5, 4.0, 6.5)):
        cube(Rb, (24, 22), (-4, y, 0.5), (11, 2, 2), f'rib{i}')
    Tl = root.child((-2, 6.9 + math.cos(rib) * 10, -0.5 + math.sin(rib) * 10), (tl, 0, 0))
    cube(Tl, (12, 22), (0, 0, 0), (3, 6, 3), 'tail')
    c, r, l = p.get('centre', (0, 0, 0)), p.get('right', (0, 0, 0)), p.get('left', (0, 0, 0))
    ro, lo = p.get('right_at', (-8, 4, 0)), p.get('left_at', (10, 4, 0))
    cube(root.child((0, 0, 0), (c[1], c[0], c[2] if len(c) > 2 else 0), hs), (0, 0), (-4, -4, -4), (8, 8, 8), 'head')
    cube(sh.child((ro[0], ro[1] - 5.4, ro[2]), (r[1], r[0], r[2] if len(r) > 2 else 0), hs), (32, 0), (-4, -4, -4), (6, 6, 6), 'rhead')
    cube(sh.child((lo[0], lo[1] - 5.4, lo[2]), (l[1], l[0], l[2] if len(l) > 2 else 0), hs), (32, 0), (-4, -4, -4), (6, 6, 6), 'lhead')
    return out


# ---------------------------------------------------------------- FireRed palette work
# One 16-colour palette (index 0 transparent), ramps dark to light. Minecraft's Wither is charcoal with pale
# eyes and teeth; Gen 3 draws such things (GENGAR, HAUNTER) a shade lighter than life with a near-black outline,
# so the body ramp tops out at a cool mid grey.
PAL_NORMAL = {
    'outline': [(16, 14, 20)],
    'body': [(28, 26, 34), (44, 42, 54), (66, 64, 78), (96, 94, 110), (136, 134, 150)],
    'bone': [(84, 82, 94), (116, 114, 126), (154, 152, 162)],
    'eye': [(150, 156, 164), (214, 222, 228), (252, 252, 252)],
    'socket': [(8, 6, 10)],
    'aura': [(56, 34, 72), (92, 58, 116)],
}
# The shiny is the invulnerable Wither's blue (entity/wither/wither_invulnerable.png)
PAL_SHINY = {
    'outline': [(10, 16, 34)],
    'body': [(24, 40, 70), (36, 58, 96), (52, 80, 124), (72, 106, 152), (100, 136, 180)],
    'bone': [(76, 108, 150), (108, 142, 184), (150, 184, 220)],
    'eye': [(150, 190, 232), (210, 236, 252), (252, 252, 252)],
    'socket': [(6, 10, 24)],
    'aura': [(30, 60, 120), (60, 104, 176)],
}
ORDER = ['outline', 'body', 'bone', 'eye', 'socket', 'aura']


def palette_list(P):
    out = [(0, 0, 0)]                    # colour 0: transparent
    for k in ORDER:
        out += [gba(c) for c in P[k]]
    while len(out) < 16:
        out.append((0, 0, 0))
    return out


def slot(mat, level):
    i = 1
    for k in ORDER:
        if k == mat:
            return i + level
        i += len(PAL_NORMAL[k])
    raise KeyError(mat)


LIGHT = np.array([-0.7, 0.6, 0.35]); LIGHT /= np.linalg.norm(LIGHT)     # from the upper left, a little in front


def classify(boxes, r):
    """Per hi-res pixel: material (0 none, 1 body, 2 bone, 3 eye: the pale eyes and teeth) and a light value."""
    part = r['part']
    on = part >= 0
    names = np.array([b.part for b in boxes] + [''])
    pn = names[np.where(on, part, len(boxes))]
    lum = r['rgba'][..., :3].astype(float).mean(-1)
    ishead = np.isin(pn, ['head', 'rhead', 'lhead'])
    mat = np.zeros(part.shape, np.int8)
    mat[on] = 1
    mat[on & ishead & (lum >= 130)] = 4                  # the teeth (see texture())
    mat[on & ishead & (lum >= 150)] = 3                  # the eyes
    isrib = np.char.startswith(pn.astype(str), 'rib')
    mat[on & isrib] = 2                                  # the ribs read as bone over the dark spine
    lam = np.clip((r['n'] * LIGHT).sum(-1), -1, 1)
    tex = np.clip((lum - 45) / 30, -1, 1) * np.where(ishead, 0.16, 0.05)
    val = np.clip(0.12 + 0.9 * np.clip(lam, 0, 1) + tex, 0, 1)
    return mat, val, pn


def to_indices(mat, val, part, depth, inner=1.2, rim=True, sockets=True, ribs=()):
    """Material and value to palette indices, then FireRed's outlines: a dark line round the silhouette and darker
    contours where a nearer part overlaps a farther one. The eye pixels get a near-black socket above them so each
    skull reads as a face at sprite size."""
    H, W = mat.shape
    idx = np.zeros((H, W), np.uint8)
    nb = len(PAL_NORMAL['body'])
    lv = np.clip(np.round(val * (nb - 1) * 1.05), 0, nb - 1).astype(int)
    for y in range(H):
        for x in range(W):
            k = mat[y, x]
            if k == 1:
                idx[y, x] = slot('body', lv[y, x])
            elif k == 2:
                idx[y, x] = slot('bone', int(np.clip(round(val[y, x] * 2.2), 0, 2)))
            elif k == 3:
                idx[y, x] = slot('eye', 2 if val[y, x] > 0.25 else 1)
            elif k == 4:
                idx[y, x] = slot('eye', 1 if val[y, x] > 0.35 else 0)
    solid = mat > 0
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
    cont = np.zeros_like(solid)
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        ys, ye = max(0, -dy), H - max(0, dy)
        xs, xe = max(0, -dx), W - max(0, dx)
        here = (slice(ys, ye), slice(xs, xe)); there = (slice(ys + dy, ye + dy), slice(xs + dx, xe + dx))
        m = solid[here] & solid[there] & (part[here] != part[there]) & (depth[here] < depth[there] - inner) & (mat[here] != 3)
        cont[here] |= m
    idx[cont] = slot('outline', 0)
    # the gaps between the ribs: a rib's lowest row over anything else is drawn in the darkest body shade
    if len(ribs):
        rb = np.isin(part, list(ribs))
        below = np.zeros_like(solid); below[:-1, :] = solid[1:, :] & (part[1:, :] != part[:-1, :])
        idx[rb & below & (mat == 2)] = slot('body', 0)
    if sockets:
        eye = mat == 3
        above = np.zeros_like(eye); above[:-1, :] = eye[1:, :]
        above &= solid & ~eye & (mat != 3)
        idx[above] = slot('socket', 0)
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


def add_aura(idx, puffs):
    """Wither smoke behind the body: round puffs (cx, cy, r in sprite pixels) in the two aura shades, lit from the
    upper left like the body, with their own dark outline. They only fill empty pixels, so the body (and its outline)
    stays in front."""
    H, W = idx.shape
    yy, xx = np.mgrid[0:H, 0:W] + 0.5
    A = np.zeros((H, W), bool)
    lit = np.zeros((H, W), bool)
    for cx, cy, r in puffs:
        d = (xx - cx) ** 2 + (yy - cy) ** 2
        inside = d <= r * r
        A |= inside
        lit |= inside & ((xx - cx + r * 0.35) ** 2 + (yy - cy + r * 0.35) ** 2 <= (r * 0.7) ** 2)
    A &= idx == 0
    out = idx.copy()
    out[A] = slot('aura', 0)
    out[A & lit] = slot('aura', 1)
    ring = np.zeros_like(A)
    ring[:, :-1] |= A[:, 1:]; ring[:, 1:] |= A[:, :-1]; ring[:-1, :] |= A[1:, :]; ring[1:, :] |= A[:-1, :]
    ring &= out == 0
    out[ring] = slot('outline', 0)
    return out


def sprite(p, R, size, origin, scale, ss=8, **kw):
    """Render pose p through camera R into a FireRed sprite (palette indices). `origin` is where the model's ground
    point lands, in sprite pixels; `scale` is sprite pixels per model texel."""
    tex = texture()
    boxes = pose(tex, p, s=scale * ss)
    r = view_render(boxes, R, (size[0] * ss, size[1] * ss), (origin[0] * ss, origin[1] * ss))
    mat, val, _ = classify(boxes, r)
    m, v, pt, d = downsample(mat, val, r['part'], r['depth'], ss, eye_min=p.get('eye_min', 0.10), cover=p.get('cover', 0.42))
    ribs = [i for i, b in enumerate(boxes) if b.part.startswith('rib')]
    idx = to_indices(m, v, pt, d / ss, ribs=ribs, **kw)
    if p.get('aura'):
        idx = add_aura(idx, p['aura'])
    return idx


# The party icon uses FireRed's shared icon palette 2 (GENGAR's and MEWTWO's): each sprite slot maps onto one of its
# colours.
ICON_PAL = 2
ICON_MAP = {
    ('outline', 0): (65, 65, 65), ('socket', 0): (65, 65, 65),
    ('body', 0): (65, 65, 65), ('body', 1): (98, 98, 90), ('body', 2): (98, 98, 90), ('body', 3): (123, 123, 123), ('body', 4): (123, 123, 123),
    ('bone', 0): (123, 123, 123), ('bone', 1): (189, 189, 180), ('bone', 2): (189, 189, 180),
    ('eye', 0): (189, 189, 180), ('eye', 1): (255, 255, 255), ('eye', 2): (255, 255, 255),
    ('aura', 0): (148, 123, 205), ('aura', 1): (197, 164, 205),
}


def icon_colorize(idx, icon_pal):
    out = np.zeros(idx.shape + (4,), np.uint8)
    for (k, lv), c in ICON_MAP.items():
        c = min(icon_pal, key=lambda q: sum((a - b) ** 2 for a, b in zip(q, c)))
        m = idx == slot(k, lv)
        out[m, :3] = c
        out[m, 3] = 255
    return out


def halve(idx, prio=('eye', 'socket', 'outline', 'bone', 'aura', 'body')):
    """Pixel-art 2x reduction: each 2x2 block keeps its most telling colour, transparent when three of four are."""
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
            best = o[np.argmin(rank[o])]
            if rank[best] >= 50:
                best = int(np.sort(o)[len(o) // 2])
            out[y, x] = best
    return out


# ---------------------------------------------------------------- the poses (found by rendering and looking)
# Front: seen from a little below and to the left, as FireRed's legendaries loom over the player's POKeMON. The
# centre head glares down at the foe, the near side head lunges toward it, the far one turns away to the right (the
# side heads hunt targets of their own); the ribcage hangs straight and the tail curls under, the body leaning in.
FRONT = {
    'yaw': -0.3, 'pitch': -0.12, 'roll': -0.1, 'scale': 1.95, 'ox': 35, 'oy': 64,
    'age': 0.0, 'rib': -0.3, 'tail': 0.2, 'tilt': 0.0, 'hscale': 1.3, 'shoulder_z': -0.15,
    'centre': (0.35, 0.35), 'right': (0.6, 0.45, 0.2), 'left': (-0.6, 0.1, -0.1),
}
# Back: from behind and to the left, looking down a little, all three heads turned to the foe on the upper right so
# each shows a sliver of its face; the shoulders roll so the far head drops and the centre face shows above it.
# FireRed's backs crop low, so the tail runs off the bottom.
BACK = dict(FRONT, yaw=2.85, pitch=0.3, roll=0.0, scale=2.2, ox=33, oy=76, tilt=0.0, rib=0.2, tail=0.6,
            shoulder_z=-0.25, centre=(1.9, -0.1), right=(2.1, -0.1), left=(1.9, -0.25))
# The party icon, drawn straight at 32x32 from a little below: chibi heads over the ribcage and tail; the second
# frame bobs up a pixel with the ribcage swung (FireRed's icons alternate two frames)
ICON = dict(FRONT, yaw=-0.3, pitch=-0.1, roll=0.0, shoulder_z=0.0, tilt=0.0, scale=0.75, hscale=1.75, ox=17, oy=28,
            rib=-0.2, tail=0.3, centre=(0.3, 0.2), right=(0.4, 0.2), left=(0.1, 0.1), right_at=(-9, 4, 0), left_at=(11, 4, 0),
            eye_min=0.45)             # at this size an eye takes a pixel only when it covers most of it, so the two stay apart
ICON_BOB = [dict(), dict(rib=0.1, tail=0.7, oy=27)]
# The follower: from the game's camera, heads big, at 32x32; down, up and left (the game mirrors left for right). The
# left frames are a 3/4 view turned to the right and flipped: from straight side on the three heads stack into one.
FOLLOW = dict(FRONT, yaw=0.0, pitch=0.15, roll=0.0, shoulder_z=0.0, tilt=0.0, scale=0.75, hscale=1.5, ox=16, oy=30,
              rib=-0.1, tail=0.5, centre=(0.0, 0.05), right=(0.3, 0.05), left=(-0.3, 0.05), right_at=(-9, 4, 0),
              left_at=(11, 4, 0), eye_min=0.45)
FOLLOW_BOB = [dict(), dict(rib=0.15, tail=0.9, oy=29)]
FOLLOW_DIRS = [dict(), dict(yaw=math.pi, pitch=0.25),
               dict(yaw=-0.8, centre=(-0.3, 0.05), right=(-0.2, 0.05), left=(-0.4, 0.05), flip=True)]


def render(p, size):
    return sprite(p, cam(p['yaw'], p['pitch'], p.get('roll', 0.0)), size, (p['ox'], p['oy']), p['scale'])


def front_back():
    return {'front': render(FRONT, (64, 64)), 'back': render(BACK, (64, 64))}


def icon_frames():
    return np.concatenate([render(dict(ICON, **b), (32, 32)) for b in ICON_BOB], 0)      # 32 x 64: frame 0 above frame 1


def follower_frames():
    """Six 32x32 frames like the expansion's overworld sheets: down 0/1, up 0/1, left 0/1 (right is left mirrored)."""
    fr = []
    for d in FOLLOW_DIRS:
        for b in FOLLOW_BOB:
            idx = render(dict(FOLLOW, **d, **b), (32, 32))
            fr.append(idx[:, ::-1] if d.get('flip') else idx)
    return np.concatenate(fr, 1)


def pic_coords(idx):
    ys, xs = np.nonzero(idx)
    w = int(min(64, ((xs.max() - xs.min()) // 8 + 1) * 8)); h = int(min(64, ((ys.max() - ys.min()) // 8 + 1) * 8))
    return {'w': w, 'h': h, 'y': int(63 - ys.max())}


def build_graphics(icon_pal):
    fb = front_back()
    for kind, idx in fb.items():
        save_rgba(colorize(idx, PAL_NORMAL), OUT / 'mon' / f'{NAME}_{kind}.png')
        save_rgba(colorize(idx, PAL_SHINY), OUT / 'mon' / f'{NAME}_{kind}_shiny.png')
    save_rgba(icon_colorize(icon_frames(), icon_pal), OUT / 'mon' / f'{NAME}_icon.png')
    ow = follower_frames()
    save_rgba(colorize(ow, PAL_NORMAL), OUT / 'sprites' / f'ow_{NAME}.png')
    save_rgba(colorize(ow, PAL_SHINY), OUT / 'sprites' / f'ow_{NAME}_shiny.png')
    return {kind: pic_coords(idx) for kind, idx in fb.items()}


# ---------------------------------------------------------------- its cry
# Minecraft's Wither ambient sound, when it is present (setup's sound list leaves it out; tools/build_minecraft.py
# --fetch-pending puts it at vendor/minecraft/sounds/mob/wither/idle1.ogg). Without it the cry is a silent placeholder
# of the same length.
CRY_SRC = SND / 'mob' / 'wither' / 'idle1.ogg'
CRY_LEN = 1.5


def build_cry():
    sr = 10512
    if CRY_SRC.exists():
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(CRY_SRC), '-ac', '1', '-ar', str(sr), '-af', 'lowpass=f=4800',
                              '-f', 'f32le', '-'], capture_output=True, check=True).stdout
        a = np.frombuffer(raw, np.float32).astype(float)
        lead = int(np.argmax(np.abs(a) > 0.02))          # skip any silence before the growl
        a = a[lead:lead + int(CRY_LEN * sr)]
        n = len(a)
        t = np.arange(n) / sr
        env = np.minimum(1.0, t / 0.03) * np.where(t > n / sr - 0.35, np.clip((n / sr - t) / 0.35, 0, 1) ** 1.5, 1.0)
        a = a * env
        ref = np.frombuffer(open(FR / 'sound/direct_sound_samples/cries/mewtwo.wav', 'rb').read()[44:], np.uint8).astype(float) - 128
        a = a * ((np.sqrt((ref ** 2).mean()) / 128) / max(1e-6, np.sqrt((a ** 2).mean())))
        a = np.tanh(a * 1.2) / np.tanh(1.2)
        pcm = np.clip(np.round(a * 127 + 128), 0, 255).astype(np.uint8)
        kind = 'from ' + CRY_SRC.name
    else:
        pcm = np.full(int(CRY_LEN * sr), 128, np.uint8)
        kind = 'silent placeholder (mob/wither/idle1.ogg not downloaded)'
    (OUT / 'cries').mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / 'cries' / f'{NAME}.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(1); w.setframerate(sr); w.writeframes(pcm.tobytes())
    return len(pcm) / sr, kind


# ---------------------------------------------------------------- its battle background: a soul sand valley
# FireRed's cave terrain recoloured colour for colour (as The End's and the Nether's are): the backdrop bands become
# the valley's teal haze (Minecraft's soul sand valley fog), brightest low down where soul fire burns along the
# horizon, so the WITHER's black bones stand out against it; the floor and the platforms become soul sand.
WITHER_BG = {
    # the sky bands (rows 0 to 36): haze, darkest at the top
    (213, 197, 115): (20, 44, 50), (205, 180, 106): (26, 56, 62), (189, 164, 106): (32, 70, 76),
    (180, 156, 98): (40, 86, 90), (172, 148, 90): (50, 102, 104), (164, 139, 82): (62, 120, 120),
    # the valley floor (rows 37 to 111) and the stripes that run across it: soul sand
    (189, 156, 106): (104, 82, 64), (197, 172, 106): (114, 90, 70),
    # the foe's platform: soul sand a shade lighter, a dark rim, its rocks soul soil
    (156, 131, 98): (66, 50, 40), (180, 148, 106): (84, 66, 52), (180, 164, 106): (140, 116, 92),
    (197, 180, 106): (158, 134, 108), (205, 197, 90): (128, 104, 82), (230, 222, 106): (150, 124, 98),
    # the player's platform
    (148, 123, 82): (62, 46, 36), (164, 131, 90): (78, 60, 46), (172, 156, 90): (100, 80, 62), (189, 180, 90): (120, 96, 76),
}


def build_bg():
    cave = np.array(Image.open(OUT / 'battle' / 'bg_cave.png').convert('RGBA'))
    out = cave.copy()
    for src, dst in WITHER_BG.items():
        m = (cave[:, :, :3] == src).all(-1)
        out[m, :3] = gba(dst)
    # the cave's sky also uses one of the floor's colours for a stripe (row 12): there it is the haze between its
    # neighbours, so the stripes keep their rhythm
    m = (cave[:37, :, :3] == (197, 172, 106)).all(-1)
    out[:37][m, :3] = gba((29, 63, 69))
    rng = np.random.default_rng(1200)
    sky = np.zeros(out.shape[:2], bool)
    for c in list(WITHER_BG.values())[:6]:
        sky |= (out[:, :, :3] == gba(c)).all(-1)
    # soul particles drifting up through the haze: single pale cyan pixels
    ys, xs = np.nonzero(sky[:34])
    for k in rng.choice(len(ys), 34, replace=False):
        out[ys[k], xs[k], :3] = gba((150, 214, 214)) if rng.random() < 0.5 else gba((96, 160, 162))
    # soul fire along the horizon: small blue flames, a bright core over a darker base
    for x in rng.choice(np.arange(4, 236), 12, replace=False):
        h = 2 + int(rng.integers(0, 3))
        for dy in range(h):
            if sky[36 - dy, x]:
                out[36 - dy, x, :3] = gba((180, 246, 250)) if dy >= h - 2 and dy > 0 else gba((70, 190, 210))
        if sky[36 - h + 1, x - 1] and h > 2:
            out[36 - 1, x - 1, :3] = gba((70, 190, 210))
    # soul sand's faces: dark two-pixel pits across the floor and the platforms
    sand = np.zeros(out.shape[:2], bool)
    for c in ((104, 82, 64), (114, 90, 70), (128, 104, 82), (120, 96, 76), (150, 124, 98), (100, 80, 62)):
        sand |= (out[:, :, :3] == gba(c)).all(-1)
    ys, xs = np.nonzero(sand[:112])
    for k in rng.choice(len(ys), 160, replace=False):
        y, x = ys[k], xs[k]
        if x + 1 < 240 and sand[y, x + 1]:
            out[y, x:x + 2, :3] = gba((70, 52, 40))
    save_rgba(out, OUT / 'battle' / 'bg_wither.png')


# ---------------------------------------------------------------- the species (spec section 3)
SPECIES = {
    'name': 'WITHER',
    'base': [100, 125, 110, 140, 110, 95],           # HP, Atk, Def, SpA, SpD, Spe: 680, legendary tier
    'types': ['GHOST', 'DARK'],
    'catchRate': 3,                                  # MEWTWO's
    'expYield': 306,
    'growth': 'SLOW',
    # Gen 3 style: two moves at 1, then one every seven levels. The four it knows at 70 (movesAt keeps the last four
    # learned) are SHADOW BALL, CRUNCH, NIGHT SHADE and HYPER BEAM. Every move's effect is one src/battle.js already
    # runs (no CURSE: its effect isn't implemented; no PURSUIT, whose switch-out doubling isn't). SMOG is its black
    # smoke, SLUDGE BOMB's poison stands in for the Wither effect, IRON DEFENSE is the armour it grows at half health.
    'learnset': [[1, 'SCARY_FACE'], [1, 'BITE'], [8, 'CONFUSE_RAY'], [15, 'SMOG'], [22, 'FAINT_ATTACK'],
                 [29, 'SLUDGE_BOMB'], [36, 'PROTECT'], [43, 'IRON_DEFENSE'], [50, 'SHADOW_BALL'], [57, 'CRUNCH'],
                 [64, 'NIGHT_SHADE'], [70, 'HYPER_BEAM']],
    'canFly': False,
    'elevation': 6,                                  # it hovers (ARTICUNO's height): the battle shadow shows
    'id': 0,
    'ability': None,                                 # the engine has no abilities (PRESSURE would be its own)
    'dex': {
        'category': 'DECAY',                         # shown as "DECAY POKéMON"
        'no': 'NETHER',                              # beyond Kanto's 151 (the ENDER DRAGON shows END): made of the Nether's soul sand and skulls
        'height': 35, 'weight': 2800,                # decimetres and hectograms, as the decomp stores them: 3.5 m, 280.0 kg
        'heightText': "11'06\"", 'weightText': '617.3 lbs.',
        'text': 'Three skulls set upon soul sand gave it life. '
                'Every living thing its black skulls strike withers away. Gravely hurt, it hardens its bones into armor.',
    },
}


def build_all(icon_pal):
    print('  wither: sprites'); coords = build_graphics(icon_pal)
    secs, kind = build_cry()
    print('  wither: cry %.2fs, %s' % (secs, kind))
    print('  wither: battle background'); build_bg()
    return coords
