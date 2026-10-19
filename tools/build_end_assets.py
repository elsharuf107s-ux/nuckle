#!/usr/bin/env python3
"""The End's sprites and strips, from Minecraft 1.21.4's own models and textures (tools/build_minecraft.py calls
these; nothing here is drawn by hand except the iron-bar cage, which is laid out from the iron_bars texture).

Outputs (assets/mc/):
  mobs/enderman.png, mobs/enderman_eyes.png   the enderman sheet and its glowing eyes alone (same layout)
  mobs/silverfish.png
  end/dragon.png, end/dragon_eyes.png         the Ender Dragon in the world: 16 headings across, one row per pose frame
  end/dragon_shadow.png                       its ground shadow from straight above, per heading (flying, standing)
  end/crystal.png                             the end crystal spinning (24 frames), end/crystal_base.png the bedrock slab
  end/crystal_glow.png, end/crystal_beam.png, end/crystal_cage.png (back and front layers, intact and damaged)
  end/end_portal.png                          the End portal's starfield: 128x128 tileable frames stacked down
  end/end_void.png, end/end_stars_far.png, end/end_stars_near.png   the void's sky and two star layers (tileable)
  end/dragon_fireball.png, end/dragon_breath.png (the lingering cloud, 3x3 tiles, 8 frames), p_portal.png,
  p_dragon_breath.png, gui/boss_pink_background.png, gui/boss_pink_progress.png

The layouts go into items.json under 'end' (and the mobs under 'mobSheets', so the runtime loads them like the others).
"""
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import mcmodel as M
import models

HERE = Path(__file__).resolve().parent.parent
TX = HERE / 'vendor' / 'minecraft' / 'jar' / 'assets' / 'minecraft' / 'textures'
OUT = HERE / 'assets' / 'mc'
END = OUT / 'end'
R = math.radians
SHADE = {'top': 1.15, 'front': 1.0, 'back': 1.0, 'right': 0.85, 'left': 0.85, 'bottom': 0.6}   # build_minecraft.STEVE_SHADE
DIRS = {'down': 0.0, 'up': math.pi, 'left': -math.pi / 2, 'right': math.pi / 2}


def save(arr, path):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr, 'RGBA').save(path, optimize=True)


def grade(img, gain=1.1, sat=1.2, lift=8):
    out = img.copy().astype(float); rgb = out[:, :, :3]; g = rgb.mean(axis=2, keepdims=True)
    rgb = g + (rgb - g) * sat; rgb = rgb * gain + lift; out[:, :, :3] = np.clip(rgb, 0, 255)
    out[img[:, :, 3] == 0] = 0
    return out.astype(np.uint8)


def rgba(path):
    return np.array(Image.open(path).convert('RGBA'))


# ---------------------------------------------------------------- enderman and silverfish (mob sheets)
def enderman_profile_eyes(ee):
    """The eyes texture with an eye on each side of the head too, at the front edge (as steve_profile_skin does for
    Steve): in Minecraft the eyes are only on the face, but a sprite seen side on would otherwise lose its glow."""
    t = ee.copy()
    face = ee[8:16, 8:16]
    for r in range(8):
        cs = np.nonzero(face[r, :, 3] > 0)[0]
        if not len(cs):
            continue
        col = face[r, cs[0]]
        t[8 + r, 7] = col; t[8 + r, 6] = col        # right side of the head (u 0..7, front edge at u 7)
        t[8 + r, 16] = col; t[8 + r, 17] = col      # left side (u 16..23, front edge at u 16)
    return t


def build_end_mobs():
    E = TX / 'entity'
    et, ee = M.load_tex(E / 'enderman/enderman.png'), M.load_tex(E / 'enderman/enderman_eyes.png')
    ee = enderman_profile_eyes(ee)
    meta = {}
    # enderman: walk (idle, step, step), angry (walking with the jaw dropped), stare (the shaking scream, 2 frames),
    # attack (arms up, 2 frames). 36x48 frames, feet at (18, 45).
    size, org = (36, 48), (18, 45)
    step = lambda ph: {} if ph is None else {'leg': 26 * math.cos(ph), 'arm': 16 * math.cos(ph)}
    poses = [('walk', [step(None), step(0.0), step(math.pi)]),
             ('angry', [{**step(None), 'open': 3}, {**step(0.0), 'open': 3}, {**step(math.pi), 'open': 3}]),
             ('stare', [{'open': 4, 'head_yaw': 7, 'head_roll': 4, 'rarm': -12, 'larm': -12}, {'open': 4, 'head_yaw': -7, 'head_roll': -4, 'rarm': -12, 'larm': -12}]),
             ('attack', [{'open': 3, 'rarm': -60, 'larm': -60}, {'open': 3, 'rarm': -105, 'larm': -105}])]
    frames, eyes, layout = [], [], {}
    for name, plist in poses:
        layout[name] = {}
        for dirn, yaw in DIRS.items():
            layout[name][dirn] = []
            for p in plist:
                boxes, eye_idx = models.enderman(et, ee, p)
                img, part, depth, _ = M.render_fast(boxes, yaw=yaw, size=size, origin=org, k=0.45, shade=SHADE)
                body = M.outline_fast(grade(img, gain=1.15, lift=10), color=(10, 6, 14))
                ey = np.zeros_like(img)
                m = np.isin(part, eye_idx)
                ey[m] = img[m]
                layout[name][dirn].append(len(frames)); frames.append(body); eyes.append(ey)
    save(np.hstack(frames), OUT / 'mobs' / 'enderman.png')
    save(np.hstack(eyes), OUT / 'mobs' / 'enderman_eyes.png')
    meta['enderman'] = {'w': size[0], 'h': size[1], 'origin': list(org), 'poses': layout, 'eyes': 'enderman_eyes'}
    # silverfish: walk (resting, then two wiggles), scurry (four wiggle phases for a running loop). 24x16, feet at (12, 13).
    st = M.load_tex(E / 'silverfish.png')
    size, org = (24, 16), (12, 13)
    frames, layout = [], {}
    for name, ages in (('walk', (None, 1.75, 5.25)), ('scurry', (0.0, 1.75, 3.5, 5.25))):
        layout[name] = {}
        for dirn, yaw in DIRS.items():
            layout[name][dirn] = []
            for a in ages:
                img, _, _, _ = M.render_fast(models.silverfish(st, a), yaw=yaw, size=size, origin=org, k=0.45, shade=SHADE)
                layout[name][dirn].append(len(frames)); frames.append(M.outline_fast(grade(img)))
    save(np.hstack(frames), OUT / 'mobs' / 'silverfish.png')
    meta['silverfish'] = {'w': size[0], 'h': size[1], 'origin': list(org), 'poses': layout}
    return meta


# ---------------------------------------------------------------- the Ender Dragon in the world
DRAGON_S = 0.56        # screen pixels per model texel: about 6 tiles long and 8 across with the wings out
DRAGON_C = 0.55        # how much height shows: a camera steeper than the mobs' (the ground stays 1:1 with the tiles)
SS = 2                 # supersampling
HEADINGS = 16


def heading_yaw(i):
    """Heading i: 0 east, then clockwise on screen in 22.5 degree steps (4 south, 8 west, 12 north)."""
    a = i * 2 * math.pi / HEADINGS
    return math.atan2(math.cos(a), math.sin(a))


def dragon_rows():
    rows = [('fly', i / 8, f'fly{i}') for i in range(8)]
    rows += [('perch', 0.0, 'perch0'), ('perch', 0.5, 'perch1')]
    rows += [('breath', 0.0, 'breath0'), ('breath', 0.5, 'breath1')]
    rows += [('pant', i / 4, f'pant{i}') for i in range(4)]
    rows += [('death', 0.0, 'death0')]
    return rows


def _dragon_frame(tex, eyes, mode, phase, yaw, W, H, ox, oy):
    """One frame: rendered at SS x, with the vertical squashed by DRAGON_C, box-filtered down. Returns the frame and
    the glowing eyes alone."""
    boxes = models.ender_dragon(tex, eyes, phase, mode, s=DRAGON_S * SS)
    Hr = int(round(H * SS / DRAGON_C))
    img, part, depth, _ = M.render_fast(boxes, yaw=yaw, size=(W * SS, Hr), origin=(ox * SS, oy * SS / DRAGON_C), k=1 / DRAGON_C, shade=SHADE)
    eye_ids = [i for i, b in enumerate(boxes) if b.part == 'eyes']
    small = np.array(Image.fromarray(img).resize((W, H), Image.BOX))
    a = small[..., 3]
    small[..., 3] = np.where(a >= 110, 255, 0)
    small[small[..., 3] == 0] = 0
    em = np.isin(part, eye_ids).astype(np.uint8) * 255
    eye_rgb = np.where(np.isin(part, eye_ids)[..., None], img[..., :3], 0).astype(np.uint8)
    e_a = np.array(Image.fromarray(em).resize((W, H), Image.BOX))
    e_c = np.array(Image.fromarray(eye_rgb).resize((W, H), Image.BOX)).astype(float)
    ey = np.zeros((H, W, 4), np.uint8)
    on = e_a > 40
    ey[on, :3] = np.clip(e_c[on] * 255.0 / np.maximum(e_a[on, None], 1) * 1.1, 0, 255).astype(np.uint8)
    ey[on, 3] = 255
    return small, ey, boxes


def _shadow(boxes, yaw, W, H, ox, oy):
    """The dragon's footprint from straight above (every box's corners projected on the ground, hulls filled),
    softened: what the runtime draws on the ground under it."""
    im = Image.new('L', (W * SS, H * SS), 0)
    dr = ImageDraw.Draw(im)
    Ry = M.rot_y(yaw)
    for b in boxes:
        if b.part == 'eyes':
            continue
        e = b.extent()
        c = b.pivot + b.mat @ (b.pos - b.inflate - b.pivot)
        pts = []
        for i in (0, 1):
            for j in (0, 1):
                for l in (0, 1):
                    p = Ry @ (c + b.mat @ np.array([i * e[0], j * e[1], l * e[2]]))
                    pts.append((p[0] + ox * SS, p[2] + oy * SS))
        hull = _hull(pts)
        if len(hull) >= 3:
            dr.polygon(hull, fill=255)
    im = im.resize((W, H), Image.BOX).filter(ImageFilter.GaussianBlur(1.6))
    a = (np.array(im).astype(float) * 0.42).astype(np.uint8)
    out = np.zeros((H, W, 4), np.uint8)
    out[..., :3] = (12, 4, 20)
    out[..., 3] = a
    return out


def _hull(pts):
    pts = sorted(set((round(x, 3), round(y, 3)) for x, y in pts))
    if len(pts) < 3:
        return pts
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def build_dragon():
    E = TX / 'entity' / 'enderdragon'
    tex, eyes = M.load_tex(E / 'dragon.png'), M.load_tex(E / 'dragon_eyes.png')
    rows = dragon_rows()
    # render everything into a generous canvas, then crop every frame to the union of what was drawn
    CW, CH, cx, cy = 260, 240, 130, 150
    frames, eyef = [], []
    for mode, ph, name in rows:
        fr, ef = [], []
        for h in range(HEADINGS):
            img, ey, _ = _dragon_frame(tex, eyes, mode, ph, heading_yaw(h), CW, CH, cx, cy)
            fr.append(M.outline_fast(grade(img, gain=1.2, sat=1.1, lift=12), color=(14, 8, 22)))
            ef.append(ey)
        frames.append(fr); eyef.append(ef)
    alpha = np.zeros((CH, CW), bool)
    for fr in frames:
        for f in fr:
            alpha |= f[..., 3] > 0
    ys, xs = np.nonzero(alpha)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    # keep the ground point centred horizontally so the runtime can mirror nothing and still line up
    half = max(cx - x0, x1 - cx)
    x0, x1 = cx - half, cx + half
    W, H = x1 - x0, y1 - y0
    sheet = np.zeros((H * len(rows), W * HEADINGS, 4), np.uint8)
    esheet = np.zeros_like(sheet)
    for r, (fr, ef) in enumerate(zip(frames, eyef)):
        for h in range(HEADINGS):
            sheet[r * H:(r + 1) * H, h * W:(h + 1) * W] = fr[h][y0:y1, x0:x1]
            esheet[r * H:(r + 1) * H, h * W:(h + 1) * W] = ef[h][y0:y1, x0:x1]
    save(sheet, END / 'dragon.png')
    save(esheet, END / 'dragon_eyes.png')
    # shadows: row 0 flying (mid beat), row 1 standing
    SW = SH = 150
    sh = np.zeros((SH * 2, SW * HEADINGS, 4), np.uint8)
    for r, (mode, ph) in enumerate((('fly', 0.375), ('perch', 0.0))):
        for h in range(HEADINGS):
            boxes = models.ender_dragon(tex, eyes, ph, mode, s=DRAGON_S * SS)
            sh[r * SH:(r + 1) * SH, h * SW:(h + 1) * SW] = _shadow(boxes, heading_yaw(h), SW, SH, SW // 2, SH // 2)
    save(sh, END / 'dragon_shadow.png')
    # how high the body's middle stands above the ground point when standing (screen pixels)
    lift = models.DRAGON_GROUND * DRAGON_S * DRAGON_C
    return {'w': int(W), 'h': int(H), 'origin': [int(cx - x0), int(cy - y0)], 'headings': HEADINGS,
            'heading0': 'east, clockwise on screen (4 south, 8 west, 12 north)',
            'rows': {name: i for i, (_, _, name) in enumerate(rows)},
            'poses': {'fly': [f'fly{i}' for i in range(8)], 'perch': ['perch0', 'perch1'], 'breath': ['breath0', 'breath1'],
                      'pant': [f'pant{i}' for i in range(4)], 'death': ['death0']},
            'bodyLift': round(lift, 1),
            'shadow': {'w': SW, 'h': SH, 'origin': [SW // 2, SH // 2], 'rows': {'fly': 0, 'perch': 1}},
            'note': 'origin is the ground point under the body when it stands; a flying frame is drawn altitude px higher, its shadow at the ground point'}


# ---------------------------------------------------------------- the end crystal
def build_crystal():
    t = M.load_tex(TX / 'entity/end_crystal/end_crystal.png')
    N = 24
    size = 34
    frames = []
    for i in range(N):
        boxes = models.end_crystal(t, spin=i * 2 * math.pi / N, s=2.0)
        img, _, _, _ = M.render_fast(boxes, yaw=0.0, size=(size, size), origin=(size // 2, size // 2), k=1.0, shade={**SHADE, 'top': 1.1})
        frames.append(M.outline_fast(grade(img, gain=1.12, sat=1.15, lift=10), color=(40, 10, 50)))
    save(np.hstack(frames), END / 'crystal.png')
    base, _, _, _ = M.render_fast(models.end_crystal(t, base=True, s=2.0), size=(30, 36), origin=(15, 26), k=1.0, shade=SHADE)
    save(M.outline_fast(grade(base)), END / 'crystal_base.png')
    # glow: a soft pink-white halo, drawn additively
    G = 48
    yy, xx = np.mgrid[0:G, 0:G]
    d = np.hypot(xx - G / 2 + 0.5, yy - G / 2 + 0.5) / (G / 2)
    a = np.clip(1 - d, 0, 1) ** 2
    glow = np.zeros((G, G, 4), np.uint8)
    glow[..., 0], glow[..., 1], glow[..., 2] = 255, 190, 250
    glow[..., 3] = (a * 150).astype(np.uint8)
    save(glow, END / 'crystal_glow.png')
    # the healing beam: end_crystal_beam.png's length runs along x here (64 long, tileable), 5 px thick
    bt = rgba(TX / 'entity/end_crystal/end_crystal_beam.png')       # 16 x 256
    strip = np.transpose(bt[:64], (1, 0, 2))                          # 16 tall, 64 long
    strip = np.array(Image.fromarray(strip).resize((64, 5), Image.BOX))
    prof = np.array([0.45, 0.85, 1.0, 0.85, 0.45])[:, None]
    core = np.zeros((5, 64, 4), np.uint8)
    core[..., :3] = np.clip(strip[..., :3].astype(float) * 0.4 + np.array([170, 120, 200]) * 0.6 + 40, 0, 255).astype(np.uint8)
    core[..., 3] = np.clip((strip[..., 3].astype(float) * 1.2 + 60) * prof, 0, 255).astype(np.uint8)
    save(core, END / 'crystal_beam.png')
    cage = build_cage()
    return {'crystal': {'w': size, 'h': size, 'frames': N, 'centre': [size // 2, size // 2], 'spinFps': 4,
                        'note': 'draw the centre about 22 px above the pillar-top point, bobbing (Minecraft: sin(age * 0.2) / 2 + 0.5)'},
            'base': {'w': 30, 'h': 36, 'origin': [15, 26]},
            'glow': {'w': G, 'h': G}, 'beam': {'w': 64, 'h': 5},
            'cage': cage}


def build_cage():
    """The iron-bar cage around a small pillar's crystal, seen as the terrain is (top 1:1, fronts full height):
    3x3 tiles on the pillar top, 2 tiles high. Four frames: back (north wall, drawn before the crystal) and front
    (south wall, side posts and the roof, drawn after), intact then damaged (one hit taken)."""
    bars = rgba(TX / 'block/iron_bars.png')
    Wc, Hc, D = 48, 32, 48
    pane = np.tile(bars, (2, 3, 1))                  # 32 x 48
    cols = np.nonzero(bars[..., 3].max(axis=0) > 0)[0]
    bar_xs = sorted(set(int(c) for c in cols))
    FW, FH = Wc + 4, D + Hc + 4
    ox, oy = FW // 2, 2 + D // 2 + Hc     # the pillar-top centre point (ground of the cage) in the frame

    def put(dst, src, x, y, k=1.0):
        h, w = src.shape[:2]
        m = src[..., 3] > 0
        sub = dst[y:y + h, x:x + w]
        c = src.copy(); c[..., :3] = np.clip(c[..., :3].astype(float) * k, 0, 255).astype(np.uint8)
        sub[m] = c[m]

    rng = np.random.RandomState(23)

    def layers(damaged):
        back = np.zeros((FH, FW, 4), np.uint8)
        front = np.zeros((FH, FW, 4), np.uint8)
        pb = pane.copy(); pf = pane.copy()
        roof = np.zeros((D, Wc, 4), np.uint8)
        bar_c = bars[..., :3][bars[..., 3] > 0].reshape(-1, 3).mean(axis=0)
        # the roof seen from above: the thin tops of the bar panes, one line per block edge and one down the middle
        # of each block in one direction (two bars to a block), so the crystal shows through
        for z in range(D):
            for x in range(Wc):
                if z in (0, D - 1) or x in (0, Wc - 1) or z % 16 == 0 or x % 16 == 0 or x % 16 == 8:
                    roof[z, x, :3] = bar_c * (1.2 if (x + z) % 4 else 1.0); roof[z, x, 3] = 255
        if damaged:
            # knocked out bars: holes in the front wall and the roof, a few bars bent out of line
            for _ in range(5):
                x = rng.randint(2, Wc - 6); y = rng.randint(4, Hc - 4)
                pf[y - rng.randint(3, 8):y + rng.randint(3, 8), x:x + rng.randint(3, 7)] = 0
            for _ in range(4):
                x = rng.randint(4, Wc - 10); z = rng.randint(4, D - 10)
                roof[z:z + rng.randint(4, 10), x:x + rng.randint(4, 12)] = 0
            for _ in range(3):
                x = rng.randint(4, Wc - 4)
                col = pf[:, x].copy(); pf[:, x] = 0
                sh = rng.choice([-2, 2])
                for y in range(Hc):
                    off = int(round(sh * math.sin(math.pi * y / Hc)))
                    if 0 <= x + off < Wc and col[y, 3]:
                        pf[y, x + off] = col[y]
        # north wall: its foot at z = -24, so on screen from oy - 24 - 32 to oy - 24
        put(back, pb, ox - Wc // 2, oy - D // 2 - Hc, 0.42)
        put(front, roof, ox - Wc // 2, oy - D // 2 - Hc, 1.0)
        put(front, pf, ox - Wc // 2, oy + D // 2 - Hc, 1.0)
        # the side walls are seen edge on: posts down both sides
        post = np.zeros((D + Hc, 2, 4), np.uint8)
        post[..., :3] = bar_c * 0.9; post[..., 3] = 255
        if damaged:
            post[rng.randint(10, 30):rng.randint(34, 50), :] = 0
        put(front, post, ox - Wc // 2, oy - D // 2 - Hc, 1.0)
        put(front, post, ox + Wc // 2 - 2, oy - D // 2 - Hc, 0.85)
        back[..., 3] = np.where(back[..., 3] > 0, 190, 0)     # the far wall, seen through the roof: dim, a little see-through
        return back, M.outline_fast(front, color=(30, 30, 36))

    b0, f0 = layers(False)
    b1, f1 = layers(True)
    save(np.hstack([b0, f0, b1, f1]), END / 'crystal_cage.png')
    return {'w': FW, 'h': FH, 'origin': [ox, oy], 'frames': ['back', 'front', 'back_damaged', 'front_damaged']}


# ---------------------------------------------------------------- the End portal's starfield and the void
# rendertype_end_portal.fsh: the sky texture times COLORS[0], plus 15 layers of end_portal.png, each scaled, turned and
# drifting at its own speed, times its colour
PORTAL_COLORS = [(0.022087, 0.098399, 0.110818), (0.011892, 0.095924, 0.089485), (0.027636, 0.101689, 0.100326),
                 (0.046564, 0.109883, 0.114838), (0.064901, 0.117696, 0.097189), (0.063761, 0.086895, 0.123646),
                 (0.084817, 0.111994, 0.166380), (0.097489, 0.154120, 0.091064), (0.106152, 0.131144, 0.195191),
                 (0.097721, 0.110188, 0.187229), (0.133516, 0.138278, 0.148582), (0.070006, 0.243332, 0.235792),
                 (0.196766, 0.142899, 0.214696), (0.047281, 0.315338, 0.321970), (0.204675, 0.390010, 0.302066),
                 (0.080955, 0.314821, 0.661491)]
P = 128           # the strip's frames tile every 128 px, so a portal of any shape stays seamless (sample at world px mod 128)
PORTAL_FRAMES = 48
PORTAL_TICKS = 3  # 0.15 s a frame: the loop is 7.2 s


def _pool(img, a):
    """Max-pool an H x W x C array by a (the star texture shrunk without losing its single-pixel stars)."""
    H, W = img.shape[:2]
    return img.reshape(H // a, a, W // a, a, -1).max(axis=(1, 3))


def _orient(img, o):
    img = np.rot90(img, o % 4)
    return img[:, ::-1] if o >= 4 else img


def build_portal_and_void():
    stars = rgba(TX / 'entity/end_portal.png')[..., :3].astype(float) / 255
    sky = rgba(TX / 'environment/end_sky.png')[..., :3].astype(float) / 255
    layers = []
    rng = np.random.RandomState(1)
    dirs = [(0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1), (-1, 0), (-1, 1)]
    for i in range(1, 16):
        a = 2 if i % 3 == 0 else 4                 # texels per pixel: two scales of stars
        t = stars[(i * 7) % a::a, (i * 3) % a::a]  # every a-th texel: the stars stay as sparse as Minecraft's
        t = np.tile(t, (P // t.shape[0], P // t.shape[1], 1))
        t = _orient(t, (i * 5) % 8)
        per = 256 // a                              # its period on screen
        dx, dy = dirs[(i * 3) % 8]
        m = 1 if i < 10 else 2
        layers.append((t, per, dx * m, dy * m, np.array(PORTAL_COLORS[i])))
    base = sky * np.array(PORTAL_COLORS[0]) * 1.6
    out = []
    for f in range(PORTAL_FRAMES):
        col = base.copy()
        for t, per, dx, dy, c in layers:
            sx = int(round(dx * per * f / PORTAL_FRAMES)); sy = int(round(dy * per * f / PORTAL_FRAMES))
            col += np.roll(t, (sy, sx), axis=(0, 1)) * c * 1.7
        fr = np.zeros((P, P, 4), np.uint8)
        fr[..., :3] = np.clip(col * 255, 0, 255).astype(np.uint8)
        fr[..., 3] = 255
        out.append(fr)
    save(np.vstack(out), END / 'end_portal.png')
    # the void: Minecraft draws end_sky.png tinted (40, 40, 40); a touch brighter so it never reads as flat black
    v = np.zeros((128, 128, 4), np.uint8)
    v[..., :3] = np.clip(sky * 255 * 0.2, 0, 255).astype(np.uint8)
    v[..., 3] = 255
    save(v, END / 'end_void.png')
    for name, a, k, col in (('end_stars_far', 4, 0.55, (190, 170, 230)), ('end_stars_near', 2, 0.9, (235, 225, 255))):
        s = _pool(stars, a).mean(axis=2)
        s = np.tile(s, (128 // s.shape[0], 128 // s.shape[1]))
        if name == 'end_stars_near':
            s = np.where(s > 0.75, s, 0)            # only the brightest: a sparse near layer
            s = _orient(s[..., None], 5)[..., 0]
        img = np.zeros((128, 128, 4), np.uint8)
        img[..., :3] = col
        img[..., 3] = np.clip(s * 255 * k, 0, 255).astype(np.uint8)
        save(img, END / f'{name}.png')
    return {'end_portal': dict(file='end/end_portal.png', size=P, frames=PORTAL_FRAMES, frametime=PORTAL_TICKS, seq=list(range(PORTAL_FRAMES)),
                               tile=True, note='frames are 128x128 and tile: draw cell (x, y) from (x*16 mod 128, y*16 mod 128) of the frame')}


def portal_cell(frame=0, x=0, y=0):
    """A 16x16 piece of the portal strip (for the block look and the icon)."""
    im = rgba(END / 'end_portal.png')
    return im[frame * P + y:frame * P + y + 16, x:x + 16].copy()


# ---------------------------------------------------------------- the dragon's fireball, breath, particles, boss bar
def build_fx():
    P_ = TX / 'particle'
    gen = [rgba(P_ / f'generic_{i}.png') for i in range(8)]

    def tint(img, rgb):
        o = img.copy(); o[..., :3] = (o[..., :3].astype(float) * np.array(rgb) / 255).astype(np.uint8); return o
    # PortalParticle: grey f in 0.4..1, green times 0.3, red times 0.9 (a magenta purple)
    save(np.hstack([tint(g, (230, 77, 255)) for g in gen]), OUT / 'p_portal.png')
    # DragonBreathParticle: (0.72, 0, 0.82)
    save(np.hstack([tint(g, (183, 0, 210)) for g in gen]), OUT / 'p_dragon_breath.png')
    shutil.copyfile(TX / 'entity/enderdragon/dragon_fireball.png', END / 'dragon_fireball.png')
    # the lingering cloud: 3x3 tiles (48 px), 8 looping frames of breath particles over a faint purple haze
    S, N, F = 48, 46, 8
    rng = np.random.RandomState(7)
    puffs = []
    for _ in range(N):
        r = math.sqrt(rng.rand()) * 0.95; th = rng.rand() * 2 * math.pi
        puffs.append((S / 2 + math.cos(th) * r * 21, S / 2 + math.sin(th) * r * 19, rng.randint(F), 0.7 + rng.rand() * 0.3, rng.rand() < 0.25))
    frames = []
    yy, xx = np.mgrid[0:S, 0:S]
    haze_a = np.clip(1 - np.hypot((xx - S / 2 + 0.5) / 23, (yy - S / 2 + 0.5) / 21), 0, 1) ** 0.6
    for f in range(F):
        acc = np.zeros((S, S, 4), float)
        acc[..., 0], acc[..., 1], acc[..., 2] = 120, 0, 150
        acc[..., 3] = haze_a * 70
        for x, y, ph, br, hi in puffs:
            life = (f + ph) % F                     # 0 young (big) .. F-1 old (small, risen)
            g = gen[7 - life]
            col = (235, 150, 255) if hi else (183 * br, 0, 210 * br)
            px, py = int(round(x - 4)), int(round(y - 4 - life * 0.6))
            for dy in range(8):
                for dx in range(8):
                    Y, X = py + dy, px + dx
                    if 0 <= Y < S and 0 <= X < S and g[dy, dx, 3] > 0:
                        a = 0.85
                        acc[Y, X, :3] = acc[Y, X, :3] * (1 - a) + np.array(col) * (g[dy, dx, 0] / 255) * a
                        acc[Y, X, 3] = max(acc[Y, X, 3], 210)
        frames.append(np.clip(acc, 0, 255).astype(np.uint8))
    save(np.hstack(frames), END / 'dragon_breath.png')
    # Minecraft's boss bar: the pink bar (182 x 5)
    g = OUT / 'gui'
    for k in ('background', 'progress'):
        shutil.copyfile(TX / f'gui/sprites/boss_bar/pink_{k}.png', g / f'boss_pink_{k}.png')
    return {'breath': {'w': S, 'h': S, 'frames': F, 'fps': 8}, 'fireball': {'w': 16, 'h': 16}}


# ---------------------------------------------------------------- block looks and icons the End needs
def egg_boxes(t):
    """The dragon egg's block model: eight stacked layers, textured from dragon_egg.png by position."""
    els = [((3, 0, 3), (13, 1, 13)), ((2, 1, 2), (14, 3, 14)), ((1, 3, 1), (15, 8, 15)), ((2, 8, 2), (14, 11, 14)),
           ((3, 11, 3), (13, 13, 13)), ((4, 13, 4), (12, 14, 12)), ((5, 14, 5), (11, 15, 11)), ((6, 15, 6), (10, 16, 10))]
    out = []
    for (x0, y0, z0), (x1, y1, z1) in els:
        w, h, d = x1 - x0, y1 - y0, z1 - z0
        side = (x0, 16 - y1, w, h)
        f = {'front': side, 'back': side, 'left': (z0, 16 - y1, d, h), 'right': (z0, 16 - y1, d, h), 'top': (x0, z0, w, d), 'bottom': (x0, z0, w, d)}
        out.append(M.Box(t, (0, 0), (w, h, d), (x0 - 8, y0, z0 - 8), faces=f))
    return out, els


def egg_world(cell_w=16, cell_h=24):
    t = M.load_tex(TX / 'block/dragon_egg.png')
    boxes, _ = egg_boxes(t)
    img, _, _, _ = M.render_fast(boxes, yaw=0.0, size=(cell_w, cell_h), origin=(8, 21), k=0.45, shade=SHADE)
    return M.outline_fast(grade(img, gain=1.6, sat=1.3, lift=22), color=(10, 4, 16))


def egg_icon(iso):
    t = np.array(Image.open(TX / 'block/dragon_egg.png').convert('RGBA'))
    _, els = egg_boxes(t)
    out = np.zeros((16, 16, 4), np.uint8)
    for (x0, y0, z0), (x1, y1, z1) in els:
        top = t[z0:z1, x0:x1]
        side = t[16 - y1:16 - y0, x0:x1]
        top, side = grade(top, gain=1.5, sat=1.3, lift=18), grade(side, gain=1.5, sat=1.3, lift=18)
        ic = iso(top, side, side, box=((x0 / 16 - 0.5, x1 / 16 - 0.5), (y0 / 16 - 0.5, y1 / 16 - 0.5), (z0 / 16 - 0.5, z1 / 16 - 0.5)))
        m = ic[..., 3] > 0
        out[m] = ic[m]
    return out


# ---------------------------------------------------------------- the End's music (Minecraft's own tracks)
END_MUSIC = {'the_end': 'music/game/end/the_end', 'end_boss': 'music/game/end/boss'}     # music.end, music.dragon


def build_end_music(fetch, force=False):
    """Fetch music/game/end/the_end.ogg and boss.ogg from the asset index and encode them as the project encodes its
    music (Opus in Ogg, 48 kHz stereo; 96 kbps here, the tracks are long), peak-normalised like build_music.py (0.85),
    into assets/music with music.json entries. They loop whole. `stream` marks them as long enough (15 and 6 minutes)
    that the runtime should play them through a media element rather than decode them into memory."""
    import json
    import re
    import subprocess
    src = HERE / 'vendor' / 'minecraft' / 'sounds'
    mus = HERE / 'assets' / 'music'
    meta_p = mus / 'music.json'
    meta = json.load(open(meta_p))
    for name, n in END_MUSIC.items():
        dst = mus / f'{name}.ogg'
        if dst.exists() and name in meta and not force:
            continue
        p = src / f'{n}.ogg'
        if not p.exists() and not fetch(n):
            print('  missing music', n); continue
        r = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(p), '-af', 'astats', '-f', 'null', '-'], capture_output=True, text=True)
        peak = float(re.findall(r'Peak level dB: ([-0-9.]+)', r.stderr)[-1])
        rms = float(re.findall(r'RMS level dB: ([-0-9.]+)', r.stderr)[-1])
        gain_db = 20 * math.log10(0.85) - peak
        # boss.ogg is a quiet drone (RMS -47 dB): once its peaks are normalised it would play louder than the_end, so
        # music.json's gain brings both to about the same loudness (-22 dB RMS)
        play_gain = min(1.0, 10 ** ((-22.0 - (rms + gain_db)) / 20))
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(p), '-af', f'volume={gain_db:.2f}dB,aresample=48000',
                        '-ac', '2', '-c:a', 'libopus', '-b:a', '96k', '-fflags', '+bitexact', '-flags:a', '+bitexact', str(dst)],
                       check=True)
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(dst)], capture_output=True, text=True)
        dur = float(r.stdout.strip())
        meta[name] = {'gain': round(play_gain, 3), 'duration': dur, 'loopStart': 0.0, 'loopEnd': round(dur - 0.05, 4), 'stream': True, 'source': n + '.ogg'}
        print(f'  {name:10s} {dur:7.1f}s  peak {peak:+.1f} dB, rms {rms:+.1f} dB -> {gain_db:+.1f} dB, play gain {play_gain:.2f}')
    json.dump(meta, open(meta_p, 'w'), indent=1)


if __name__ == '__main__':
    # setup.sh runs this before tools/build_world.py, whose End (tools/build_end.py) draws its void cells from these
    # files; tools/build_minecraft.py writes the same files again later
    build_portal_and_void()
    print('  end_portal.png, end_void.png, end_stars_far.png, end_stars_near.png')
