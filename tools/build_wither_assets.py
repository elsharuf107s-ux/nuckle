#!/usr/bin/env python3
"""The Wither update's sprites, strips, icons and block looks, from Minecraft 1.21.4's own models and textures
(tools/build_minecraft.py calls these, as it calls build_end_assets.py for The End).

Outputs (assets/mc/):
  wither/wither.png            the Wither in the world: 16 headings across, one row per pose frame (layout in
                               items.json wither.body); rendered from WitherBossModel (models.wither) at Minecraft's
                               2x scale, so it stands 1:1 with Steve
  wither/wither_armor.png      the armour layer alone (wither_armor.png on the model inflated by 0.5, its texture
                               scrolled a step per row, times Minecraft's 0.5 colour): same layout, drawn additively
  wither/wither_shadow.png     its ground footprint from straight above, per heading
  wither/wither_skull.png      the skull projectiles: row 0 black (wither.png), row 1 blue (wither_invulnerable.png),
                               16 headings
  wither/beacon_beam.png       the beacon beam as a vertical strip (tileable, scroll it upward)
  wither/nether_star_glint.png the Nether star's shimmer: the icon with the enchantment glint swept over it, 16 frames
  gui/boss_purple_*.png, gui/heart_withered_*.png, gui/effect_*.png, gui/effect_background*.png, gui/beacon*.png
Block looks and icons: the wither skeleton skull (ground, 4 facings, on a wall), soul sand with a skull on top
(4 facings), the beacon (glass shell, obsidian base, beacon core).
"""
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

import mcmodel as M
import models
import build_end_assets as EA

HERE = Path(__file__).resolve().parent.parent
TX = HERE / 'vendor' / 'minecraft' / 'jar' / 'assets' / 'minecraft' / 'textures'
OUT = HERE / 'assets' / 'mc'
WD = OUT / 'wither'
SHADE = {'top': 1.15, 'front': 1.0, 'back': 1.0, 'right': 0.85, 'left': 0.85, 'bottom': 0.6}   # build_minecraft.STEVE_SHADE
HEADINGS = 16
WITHER_S = 2.0          # screen pixels per model texel: WitherBossRenderer scales the model by 2, Steve is drawn 1:1
K = 0.45                # the mobs' camera (top faces foreshortened like FireRed's)
OUTLINE = (14, 8, 22)


def save(arr, path):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr, 'RGBA').save(path, optimize=True)


def rgba(path):
    return np.array(Image.open(path).convert('RGBA'))


def shade(t, s):
    o = t.copy(); o[..., :3] = np.clip(o[..., :3].astype(float) * s, 0, 255).astype(np.uint8); return o


# ---------------------------------------------------------------- the Wither in the world
def wither_rows():
    """(row name, texture key, model kwargs). Ages are ticks: setupAnim's sway has a period of 20 pi ticks."""
    per = 20 * math.pi
    rows = [(f'float{i}', 'body', dict(age=per * i / 6)) for i in range(6)]
    # head turns: all three heads toward the body's right or left (yRot), the side heads spread to their own targets,
    # the firing recoil (the centre head jerks up), and all heads tipped down at a target below
    rows += [('turnR', 'body', dict(centre=(0.55, 0.1), right=(0.6, 0.1), left=(0.5, 0.1))),
             ('turnL', 'body', dict(centre=(-0.55, 0.1), right=(-0.5, 0.1), left=(-0.6, 0.1))),
             ('spread', 'body', dict(centre=(0.0, 0.15), right=(0.75, 0.15), left=(-0.75, 0.15))),
             ('shoot', 'body', dict(centre=(0.0, -0.35), right=(0.0, -0.1), left=(0.0, -0.1))),
             ('aimDown', 'body', dict(centre=(0.0, 0.5), right=(0.0, 0.45), left=(0.0, 0.45)))]
    # the spawn: WitherBossRenderer shrinks it to 1.5x and grows it back to 2x over the 220 invulnerable ticks; blue
    # (wither_invulnerable.png) throughout, flashing back to its own texture every 5 ticks in the last 80
    for i, f in enumerate((1.5, 1.66, 1.83, 2.0)):
        rows.append((f'spawn{i}', 'blue', dict(s_mul=f / 2.0, age=0.0)))
    for i, f in enumerate((1.5, 1.66, 1.83, 2.0)):
        rows.append((f'spawnPlain{i}', 'body', dict(s_mul=f / 2.0, age=0.0)))
    # drained (the legendary twist): sunk, ribcage and tail hanging, heads drooping; 1 and 2 are the rattle
    rows += [('drained0', 'body', dict(droop=1.0, age=0.0, tilt=0.12, centre=(0.0, 0.75), right=(0.25, 0.85), left=(-0.25, 0.85))),
             ('drained1', 'body', dict(droop=1.0, age=0.0, tilt=0.12, centre=(0.12, 0.62), right=(0.4, 0.75), left=(-0.1, 0.9))),
             ('drained2', 'body', dict(droop=1.0, age=0.0, tilt=0.12, centre=(-0.12, 0.62), right=(0.1, 0.9), left=(-0.4, 0.75)))]
    # death: LivingEntityRenderer tips a dying entity over onto its side (deathTime, sqrt eased, to 90 degrees)
    for i, d in enumerate((0.0, 0.45, 0.75, 1.0)):
        rows.append((f'death{i}', 'body', dict(roll=math.radians(90) * d, droop=0.5 * d, centre=(0.0, 0.3 * d))))
    return rows


POSES = {'float': [f'float{i}' for i in range(6)], 'turnR': ['turnR'], 'turnL': ['turnL'], 'spread': ['spread'], 'shoot': ['shoot'],
         'aimDown': ['aimDown'], 'spawn': [f'spawn{i}' for i in range(4)], 'spawnPlain': [f'spawnPlain{i}' for i in range(4)],
         'drained': ['drained0', 'drained1', 'drained2'], 'death': [f'death{i}' for i in range(4)]}


def _boxes(tex, kw, s=WITHER_S, inflate=0.0):
    kw = dict(kw)
    sm = kw.pop('s_mul', 1.0)
    return models.wither(tex, s=s * sm, inflate=inflate, **kw)


def _scroll(tex, du, dv):
    """The energy swirl's texture scroll (EnergySwirlLayer: u by cos(t 0.02) 3 %, v by t %), wrapping."""
    return np.roll(np.roll(tex, dv, axis=0), du, axis=1)


# head centres in the model's own frame (renderer frame, before s): centre, right (screen left when it faces you), left
HEAD_PTS = {'centre': (0, 24, 0), 'right': (-9, 21, 1), 'left': (9, 21, 1)}


def build_wither():
    W_ = TX / 'entity' / 'wither'
    texs = {'body': M.load_tex(W_ / 'wither.png'), 'blue': M.load_tex(W_ / 'wither_invulnerable.png')}
    armor = M.load_tex(W_ / 'wither_armor.png')
    rows = wither_rows()
    CW, CH, cx, cy = 150, 160, 75, 112
    frames, arm, heads = [], [], []
    for ri, (name, tk, kw) in enumerate(rows):
        fr, ar = [], []
        for h in range(HEADINGS):
            yaw = EA.heading_yaw(h)
            boxes = _boxes(texs[tk], kw)
            sm = kw.get('s_mul', 1.0)
            ex = {k: tuple(np.array(v, float) * WITHER_S * sm) for k, v in HEAD_PTS.items()}
            img, part, depth, pts = M.render_fast(boxes, yaw=yaw, size=(CW, CH), origin=(cx, cy), k=K, shade=SHADE, extras=ex)
            if name == 'float0':
                heads.append(pts)
            fr.append(M.outline_fast(EA.grade(img, gain=1.25, sat=1.1, lift=14), color=OUTLINE))
            if tk == 'body' and not name.startswith('spawn'):
                at = _scroll(armor, int(round(3 * math.cos(ri * 0.7))), (ri * 9) % 64)
                ab = _boxes(at, kw, inflate=0.5)
                a_img, _, _, _ = M.render_fast(ab, yaw=yaw, size=(CW, CH), origin=(cx, cy), k=K, shade={k: 1.0 for k in SHADE})
                on = a_img[..., 3] > 0
                a_img[on, :3] = (a_img[on, :3].astype(float) * 0.5).astype(np.uint8)   # Minecraft's (0.5, 0.5, 0.5)
                ar.append(a_img)
            else:
                ar.append(np.zeros((CH, CW, 4), np.uint8))
        frames.append(fr); arm.append(ar)
    alpha = np.zeros((CH, CW), bool)
    for fr in frames + arm:
        for f in fr:
            alpha |= f[..., 3] > 0
    ys, xs = np.nonzero(alpha)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    half = max(cx - x0, x1 - cx)
    x0, x1 = cx - half, cx + half
    y1 = max(y1, cy + 1)
    W, H = int(x1 - x0), int(y1 - y0)
    sheet = np.zeros((H * len(rows), W * HEADINGS, 4), np.uint8)
    asheet = np.zeros_like(sheet)
    for r in range(len(rows)):
        for h in range(HEADINGS):
            sheet[r * H:(r + 1) * H, h * W:(h + 1) * W] = frames[r][h][y0:y1, x0:x1]
            asheet[r * H:(r + 1) * H, h * W:(h + 1) * W] = arm[r][h][y0:y1, x0:x1]
    save(sheet, WD / 'wither.png')
    save(asheet, WD / 'wither_armor.png')
    # the shadow from straight above (build_end_assets._shadow works at its supersampling, EA.SS)
    SW, SHh = 64, 64
    sh = np.zeros((SHh, SW * HEADINGS, 4), np.uint8)
    for h in range(HEADINGS):
        boxes = _boxes(texs['body'], dict(age=0.0), s=WITHER_S * EA.SS)
        sh[:, h * SW:(h + 1) * SW] = EA._shadow(boxes, EA.heading_yaw(h), SW, SHh, SW // 2, SHh // 2)
    save(sh, WD / 'wither_shadow.png')
    ox, oy = int(cx - x0), int(cy - y0)
    return {'w': W, 'h': H, 'origin': [ox, oy], 'headings': HEADINGS,
            'heading0': 'east, clockwise on screen (4 south, 8 west, 12 north)',
            'rows': {name: i for i, (name, _, _) in enumerate(rows)}, 'poses': POSES,
            'floatFps': 2, 'heightPx': round(28 * WITHER_S, 1),
            'heads': [{k: [round(v[0] - x0, 1), round(v[1] - y0, 1)] for k, v in p.items()} for p in heads],
            'armor': 'wither_armor.png: same layout; draw it over the body with globalCompositeOperation lighter (spawn rows are blank)',
            'shadow': {'w': SW, 'h': SHh, 'origin': [SW // 2, SHh // 2]},
            'note': 'origin is the ground point under it (the model hovers with its tail tip about 6 px up); draw a flying '
                    'frame altitude px higher and its shadow at the ground point; heads are the head centres per heading '
                    'in frame pixels (row float0), where the skulls start'}


# ---------------------------------------------------------------- the wither skulls (projectiles)
def build_skulls():
    W_ = TX / 'entity' / 'wither'
    size, org = 18, (9, 11)
    sheet = np.zeros((size * 2, size * HEADINGS, 4), np.uint8)
    for r, f in enumerate(('wither.png', 'wither_invulnerable.png')):
        t = M.load_tex(W_ / f)
        for h in range(HEADINGS):
            img, _, _, _ = M.render_fast(models.wither_skull(t, s=1.25), yaw=EA.heading_yaw(h), size=(size, size), origin=org, k=K, shade=SHADE)
            img = EA.grade(img, gain=1.2 if r == 0 else 1.1, sat=1.1, lift=14 if r == 0 else 6)
            sheet[r * size:(r + 1) * size, h * size:(h + 1) * size] = M.outline_fast(img, color=OUTLINE)
    save(sheet, WD / 'wither_skull.png')
    return {'w': size, 'h': size, 'centre': list(org), 'headings': HEADINGS, 'rows': {'black': 0, 'blue': 1}}


# ---------------------------------------------------------------- the beacon beam and the Nether star's shimmer
def build_beam():
    """BeaconRenderer: the inner beam (radius 0.2 of a block, beacon_beam.png scrolling up, the prism's two faces in
    view shaded apart) inside a faint outer glow (radius 0.25, alpha 0.125). Seen from FireRed's camera the beam rises
    straight up the screen: an 8 px wide strip, 64 tall, tileable; scroll it upward."""
    t = rgba(TX / 'entity' / 'beacon_beam.png')
    Hs = 64
    tile = np.vstack([t] * (Hs // 16))
    inner = np.array(Image.fromarray(tile).resize((6, Hs), Image.BOX)).astype(float)
    out = np.zeros((Hs, 8, 4), float)
    out[:, :, :3] = 255
    out[:, [0, 7], 3] = 0.125 * 255 * 1.6          # the outer glow (a touch stronger: it reads against grass)
    for c in range(6):
        sh = 1.08 if c < 3 else 0.86               # the lit face and the face turned away
        out[:, 1 + c, :3] = np.clip(inner[:, c, :3] * sh + 26, 0, 255)
        out[:, 1 + c, 3] = 235
    save(np.clip(out, 0, 255).astype(np.uint8), WD / 'beacon_beam.png')
    return {'w': 8, 'h': Hs, 'scroll': 'Minecraft scrolls the texture by -(time * 0.2) blocks a tick: about 64 px a second upward'}


def build_glint(star_icon):
    """ItemRenderer's foil: enchanted_glint_item.png, rotated 10 degrees, scrolling, added over the item (the Nether
    star always shines). 16 frames of the 16x16 icon; play at 10 fps."""
    g = rgba(TX / 'misc' / 'enchanted_glint_item.png').astype(float)
    N = 16
    frames = []
    yy, xx = np.mgrid[0:16, 0:16]
    a = math.radians(10)
    for f in range(N):
        u = (xx * math.cos(a) - yy * math.sin(a)) * 2.0 + f * 128 / N
        v = (xx * math.sin(a) + yy * math.cos(a)) * 2.0 + f * 40 / N
        gl = g[(v.astype(int)) % 128, (u.astype(int)) % 128, :3]
        o = star_icon.astype(float).copy()
        on = o[..., 3] > 0
        # the star is nearly white, so adding the glint would only clip: lay the purple bands over it instead
        m = np.clip((gl.max(axis=2, keepdims=True) - 110) / 130.0, 0, 1) * 0.7     # only the bright bands
        o[..., :3] = np.where(on[..., None], np.clip(o[..., :3] * (1 - m) + np.clip(gl * 1.9, 0, 255) * m, 0, 255), o[..., :3])
        frames.append(o.astype(np.uint8))
    save(np.hstack(frames), WD / 'nether_star_glint.png')
    return {'w': 16, 'h': 16, 'frames': N, 'fps': 10}


# ---------------------------------------------------------------- the HUD and GUI pieces
EFFECTS = ('speed', 'haste', 'resistance', 'jump_boost', 'strength', 'regeneration', 'wither')


def build_gui():
    g = OUT / 'gui'
    g.mkdir(parents=True, exist_ok=True)
    S = TX / 'gui' / 'sprites'
    for k in ('background', 'progress'):
        shutil.copyfile(S / f'boss_bar/purple_{k}.png', g / f'boss_purple_{k}.png')
    for k in ('full', 'half', 'full_blinking', 'half_blinking'):
        shutil.copyfile(S / f'hud/heart/withered_{k}.png', g / f'heart_withered_{k}.png')
    for e in EFFECTS:
        shutil.copyfile(TX / 'mob_effect' / f'{e}.png', g / f'effect_{e}.png')
    shutil.copyfile(S / 'hud/effect_background.png', g / 'effect_background.png')
    shutil.copyfile(S / 'hud/effect_background_ambient.png', g / 'effect_background_ambient.png')
    shutil.copyfile(TX / 'gui/container/beacon.png', g / 'beacon.png')
    for k in ('button', 'button_disabled', 'button_highlighted', 'button_selected', 'confirm', 'cancel'):
        shutil.copyfile(S / f'container/beacon/{k}.png', g / f'beacon_{k}.png')
    keys = ['boss_purple_background', 'boss_purple_progress'] + [f'heart_withered_{k}' for k in ('full', 'half', 'full_blinking', 'half_blinking')]
    keys += [f'effect_{e}' for e in EFFECTS] + ['effect_background', 'effect_background_ambient', 'beacon']
    keys += [f'beacon_{k}' for k in ('button', 'button_disabled', 'button_highlighted', 'button_selected', 'confirm', 'cancel')]
    return {f'gui_{k}': f'gui/{k}.png' for k in keys}


BEACON_SCREEN = {
    'w': 230, 'h': 219, 'note': "BeaconScreen's layout (gui_beacon is 256x256, the window is its top-left 230x219)",
    'primaryLabel': [62, 10], 'secondaryLabel': [169, 10],
    'buttons': {'size': 22, 'icon': [2, 2], 'primary': {'x': 76, 'rows': [[22], [47], [72]], 'note': 'level 1: 2 buttons centred around x 76 (24 px apart) at y 22, level 2 at y 47, level 3: 1 at y 72'},
                'secondary': {'x': 167, 'y': 47, 'note': 'level 4: regeneration and the primary at II, 24 px apart'}},
    'confirm': [164, 107], 'cancel': [190, 107], 'paymentItems': {'y': 109, 'x': [20, 41, 63, 86, 108], 'order': ['netherite_ingot', 'emerald', 'diamond', 'gold_ingot', 'iron_ingot']},
    'paymentSlot': [136, 110], 'inventory': [36, 137],
    'powers': {'1': ['speed', 'haste'], '2': ['resistance', 'jump_boost'], '3': ['strength'], '4': ['regeneration']},
}


# ---------------------------------------------------------------- block looks and icons
def skull_faces():
    """The wither skeleton skull (SkullModel head, 8x8x8 at uv 0,0 of entity/skeleton/wither_skeleton.png)."""
    t = rgba(TX / 'entity' / 'skeleton' / 'wither_skeleton.png')
    t = EA.grade(t, gain=1.35, sat=1.0, lift=18)       # lit as the mob sheets are, so the sockets read
    t[t[..., 3] == 0] = 0
    return {'top': t[0:8, 8:16], 'right': t[8:16, 0:8], 'front': t[8:16, 8:16], 'left': t[8:16, 16:24], 'back': t[8:16, 24:32]}


def skull_icon(iso=None):
    """The skull's inventory icon. Minecraft's GUI shows it at 45 degrees (template_skull: [30, 45, 0]), which at 16 px
    leaves each face 5 px wide and loses the eye sockets; this turns it a little less (22 degrees, face to the lower
    left) and draws it the way the mob sprites are drawn, face one texel per pixel, so the face reads."""
    t = rgba(TX / 'entity' / 'skeleton' / 'wither_skeleton.png')
    t = EA.grade(t, gain=1.35, sat=1.0, lift=18)
    img, _, _, _ = M.render_fast([models.mc_cube(models.Pose(), t, (0, 0), (-4, -4, -4), (8, 8, 8), s=1.0)], yaw=math.radians(-22),
                                 size=(16, 16), origin=(8, 8), k=0.45, shade=SHADE)
    return M.outline_fast(img, color=(22, 20, 24))


def _facing(f, facing):
    """The face seen from the south and the top face's turn, for a skull facing down (south), up, left or right."""
    top = f['top']
    if facing == 'down':
        return np.rot90(top, 0), f['front']
    if facing == 'up':
        return np.rot90(top, 2), f['back']
    if facing == 'right':        # facing east: its right side is toward the camera
        return np.rot90(top, 1), f['right']
    return np.rot90(top, -1), f['left']


def _resize(t, w, h):
    return np.array(Image.fromarray(t).resize((w, h), Image.NEAREST))


def _put(cell, img, x, y):
    h, w = img.shape[:2]
    for yy in range(h):
        for xx in range(w):
            Y, X = y + yy, x + xx
            if 0 <= Y < cell.shape[0] and 0 <= X < cell.shape[1] and img[yy, xx, 3] > 0:
                cell[Y, X] = img[yy, xx]


def _skull(facing, w, fh, th):
    """A skull as the terrain draws blocks: the foreshortened top over the face. Returns (img, w, fh + th)."""
    f = skull_faces()
    top, front = _facing(f, facing)
    img = np.zeros((th + fh, w, 4), np.uint8)
    img[:th] = shade(_resize(top, w, th), 1.08)
    img[th:] = shade(_resize(front, w, fh), 0.94)
    # a dark rim so the black skull reads on dark ground
    rim = np.zeros((th + fh + 2, w + 2, 4), np.uint8)
    rim[..., :3] = OUTLINE; rim[..., 3] = 255
    rim[1:-1, 1:-1] = img
    return rim


def skull_world(facing, CW, CH, OVER):
    """On the ground, in the middle of its tile: 8 px wide, its face 8 tall, its top 4 (8 x 0.45)."""
    cell = np.zeros((CH, CW, 4), np.uint8)
    s = _skull(facing, 8, 8, 4)
    _put(cell, s, (CW - s.shape[1]) // 2, OVER + 12 - s.shape[0] + 1)
    return cell


def skull_wall(CW, CH, OVER):
    """Mounted on the south face of the wall above (WallSkullBlock: 4 px up the face): drawn high in the cell so it
    lies over the bottom of that wall's front face, its face toward the camera."""
    cell = np.zeros((CH, CW, 4), np.uint8)
    s = _skull('down', 8, 8, 3)
    _put(cell, s, (CW - s.shape[1]) // 2, OVER - 6)
    return cell


def soul_sand_skull(raised, tex, facing):
    """Soul sand with a wither skeleton skull on top (the summoning T), the way an eye sits in an end portal frame:
    a small skull standing on the block's top face."""
    cell = raised(tex('soul_sand'), tex('soul_sand'))
    s = _skull(facing, 8, 6, 2)
    _put(cell, s, (cell.shape[1] - s.shape[1]) // 2, 0)
    return cell


def beacon_faces(tex):
    """The beacon block model (models/block/beacon.json) flattened onto the terrain's two faces: seen through the glass
    shell, the beacon core (3..13, 3..14 high) on its obsidian base (2..14, 0..3 high)."""
    glass, obs, core = tex('glass'), tex('obsidian'), rgba(TX / 'block' / 'beacon.png')
    top = np.zeros((16, 16, 4), np.uint8)
    top[2:14, 2:14] = shade(obs[2:14, 2:14], 0.8)
    top[3:13, 3:13] = core[3:13, 3:13]
    front = np.zeros((16, 16, 4), np.uint8)
    front[13:16, 2:14] = obs[13:16, 2:14]
    front[2:13, 3:13] = core[2:13, 3:13]
    for f in (top, front):
        on = glass[..., 3] > 0
        f[on] = glass[on]
    return top, front


def beacon_icon(iso, tex):
    glass, obs, core = tex('glass'), tex('obsidian'), rgba(TX / 'block' / 'beacon.png')
    a = iso(obs[2:14, 2:14], obs[13:16, 2:14], obs[13:16, 2:14], box=((-6 / 16, 6 / 16), (-0.5, -5 / 16), (-6 / 16, 6 / 16)))
    b = iso(core[3:13, 3:13], core[2:13, 3:13], core[2:13, 3:13], box=((-5 / 16, 5 / 16), (-5 / 16, 6 / 16), (-5 / 16, 5 / 16)))
    c = iso(glass, glass, glass)
    out = a.copy()
    for layer in (b, c):
        on = layer[..., 3] > 0
        out[on] = layer[on]
    return out


def build_all(star_icon):
    """Everything above except the icons and block looks (build_minecraft calls those from its own loops)."""
    WD.mkdir(parents=True, exist_ok=True)
    body = build_wither()
    meta = {'body': body, 'skull': build_skulls(), 'beam': build_beam(), 'glint': build_glint(star_icon)}
    return meta


IMAGES = {'wither': 'wither/wither.png', 'witherArmor': 'wither/wither_armor.png', 'witherShadow': 'wither/wither_shadow.png',
          'witherSkull': 'wither/wither_skull.png', 'beaconBeam': 'wither/beacon_beam.png', 'netherStarGlint': 'wither/nether_star_glint.png'}
