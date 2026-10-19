#!/usr/bin/env python3
"""Villagers and iron golems for the world update (design sections 5.3 to 5.8), built from Minecraft 1.21.4's own
models and textures (vendor/minecraft/jar) through the same ray caster and grading as the other mob sheets
(tools/mcmodel.py, build_minecraft.grade). Nothing here is wired into the game yet; nothing reads or writes
items.json, mcdata.py or the existing mob sheets.

Outputs (assets/mc/villagers/):
  villager_<type>.png  one sheet per villager type (plains, desert, savanna, taiga, snow, jungle, swamp). Row r is
                       profession PROFS[r] (row 0 the unemployed villager, the last row the nitwit); frames 24x32,
                       origin (12, 30): walk (4 directions x idle, step, step), shake (4 directions x head left, head
                       right: the "no" shake), sleep (lying on its back, head to the north, seen from above).
  iron_golem.png       rows: intact, cracked low (under 75% health), medium (under 50%), high (under 25%); frames 40x48,
                       origin (20, 43): walk (4 x 3), attack (4 x 2: arms up, arms swung down).
  icons.png            16x16 icons of trade items that items.json does not have yet (index map in villagers.json).
  gui/*.png            the merchant screen: villager.png (the 276x166 panel), the container/villager sprites and the
                       disabled button.
  trades.json          the trade tables, levels and pricing rules (tools/villager_trades.py)
  villagers.json       professions, types, sheet layouts, icon indexes, sound placeholders and the pending downloads.

  --sheets DIR         also write contact sheets (every sheet scaled up, labelled) into DIR
  --only-data          rewrite trades.json, villagers.json, icons and gui only (skip the slow sheet renders)

Run with RS_NO_FETCH=1 like every build here; this tool never downloads anything (the villager, golem, husk,
stray and bell sounds that setup does not fetch are listed in villagers.json 'pendingSounds').
"""
import json
import math
import sys
from pathlib import Path

sys.dont_write_bytecode = True
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))
import mcmodel as M  # noqa: E402
from mcmodel import Box, rot_x, rot_y, rot_z  # noqa: E402
import build_minecraft as BM  # noqa: E402   (helpers only: grade, iso, tex, tint, DIRS, STEVE_SHADE)
import villager_trades as VT  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
MCV = HERE / 'vendor' / 'minecraft'
TX = MCV / 'jar' / 'assets' / 'minecraft' / 'textures'
ENT = TX / 'entity'
OUT = HERE / 'assets' / 'mc' / 'villagers'

TYPES = ['plains', 'desert', 'savanna', 'taiga', 'snow', 'jungle', 'swamp']
# row order of every villager sheet: 'none' is the unemployed villager (Minecraft's profession "none")
PROFS = ['none', 'farmer', 'librarian', 'cleric', 'armorer', 'weaponsmith', 'toolsmith', 'butcher', 'fletcher',
         'cartographer', 'leatherworker', 'mason', 'shepherd', 'fisherman', 'nitwit']
PROF_NAMES = {'none': 'Villager', 'farmer': 'Farmer', 'librarian': 'Librarian', 'cleric': 'Cleric', 'armorer': 'Armorer',
              'weaponsmith': 'Weaponsmith', 'toolsmith': 'Toolsmith', 'butcher': 'Butcher', 'fletcher': 'Fletcher',
              'cartographer': 'Cartographer', 'leatherworker': 'Leatherworker', 'mason': 'Mason', 'shepherd': 'Shepherd',
              'fisherman': 'Fisherman', 'nitwit': 'Nitwit'}
# design 5.4: the job-site block of each profession and whether the villager works inside its house
JOB_SITES = {'farmer': ('composter', 'outside'), 'librarian': ('lectern', 'inside'), 'cleric': ('brewing_stand', 'inside'),
             'armorer': ('blast_furnace', 'outside'), 'weaponsmith': ('grindstone', 'outside'), 'toolsmith': ('smithing_table', 'outside'),
             'butcher': ('smoker', 'outside'), 'fletcher': ('fletching_table', 'outside'), 'cartographer': ('cartography_table', 'inside'),
             'leatherworker': ('cauldron', 'outside'), 'mason': ('stonecutter', 'outside'), 'shepherd': ('loom', 'inside'),
             'fisherman': ('barrel', 'outside')}

DIRS = BM.DIRS
SHADE = BM.STEVE_SHADE
VW, VH, VORG = 24, 32, (12, 30)
GW, GH, GORG = 40, 48, (20, 43)
R = math.radians


# ---------------------------------------------------------------- textures
def load(p):
    return np.array(Image.open(p).convert('RGBA'), dtype=np.uint8)


def hat_of(p):
    """A layer texture's hat setting from its .mcmeta (Minecraft's VillagerMetadataSection): none, partial or full."""
    meta = Path(str(p) + '.mcmeta')
    if not meta.exists():
        return 'none'
    return json.loads(meta.read_text()).get('villager', {}).get('hat', 'none')


# UV rectangles (x0, y0, x1, y1) of the villager model's head part: the head with its nose, the hat and the hat rim.
# Minecraft's VillagerModel.hatVisible(false) hides the head, the hat and the rim together for the type layer.
HEAD_UV = [(0, 0, 32, 18), (32, 0, 64, 18), (30, 47, 62, 64)]


def over(dst, src):
    """Draw one cutout layer over another, as Minecraft draws its villager layers (alpha test at 0.1)."""
    out = dst.copy()
    on = src[..., 3] >= 26
    out[on] = src[on]
    out[on, 3] = 255
    return out


def profile(t):
    """An eye on each side of the head, at the face's front edge (as models.steve_profile_skin does for Steve): at
    sprite size a side view needs the brow and an eye, or the head reads as the back of a head. The brow (row 13)
    and the eye's iris and white (row 14) are the face's own texels."""
    t = t.copy()
    brow, white, iris = t[13, 9].copy(), t[14, 9].copy(), t[14, 10].copy()
    for front, inner in ((7, 6), (16, 17)):        # right side's front column, left side's front column
        t[13, front] = brow; t[13, inner] = brow
        t[14, front] = iris; t[14, inner] = white
    return t


def villager_texture(vtype, prof):
    """villager.png, then the type layer, then the profession layer (VillagerProfessionLayer). The type layer's
    head, hat and rim are left off when the profession's hat would clash: hatVisible(profHat == NONE ||
    (profHat == PARTIAL && typeHat != FULL)). The level badge (profession_level/*) is left off: at sprite size it
    is two pixels on the belt, and leaving it off keeps one sheet row per profession for every level."""
    base = profile(load(ENT / 'villager' / 'villager.png'))
    tp = ENT / 'villager' / 'type' / f'{vtype}.png'
    t = load(tp)
    th = hat_of(tp)
    ph = 'none'
    pp = None
    if prof != 'none':
        pp = ENT / 'villager' / 'profession' / f'{prof}.png'
        ph = hat_of(pp)
    if not (ph == 'none' or (ph == 'partial' and th != 'full')):
        t = t.copy()
        for x0, y0, x1, y1 in HEAD_UV:
            t[y0:y1, x0:x1, 3] = 0
    out = over(base, t)
    if pp is not None:
        out = over(out, load(pp))
    out[out[..., 3] < 26] = 0
    return out


def golem_texture(crack):
    t = load(ENT / 'iron_golem' / 'iron_golem.png')
    if crack:
        t = over(t, load(ENT / 'iron_golem' / f'iron_golem_crackiness_{crack}.png'))
    return t


# ---------------------------------------------------------------- models
def mbox(tex, uv, origin, size, pivot, rot=None, scale=(1, 1, 1), inflate=0.0, mirror=False, part='', pre=None):
    """A cube written the way Minecraft's model code writes it (y down, front -z, origin relative to the part's
    pivot), placed at `pivot` given in this renderer's frame (y up, feet at 0, front +z), with its own
    non-uniform `scale` (texels to pixels, in the part's frame) for the chibi proportions. `rot` is
    Minecraft's (x, y, z) part rotation; `pre` an extra matrix applied after it (a parent part's rotation
    about the same pivot)."""
    x0, y0, z0 = origin
    w, h, d = size
    sx, sy, sz = scale
    a, b, c = rot or (0, 0, 0)
    Rm = rot_z(-c) @ rot_y(-b) @ rot_x(a)
    if pre is not None:
        Rm = pre @ Rm
    P = np.array(pivot, float)
    rel = np.array([x0 * sx, -(y0 + h) * sy, -(z0 + d) * sz], float)
    return Box(tex, uv, size, P + rel, scale=(sx, sy, sz), pivot=P, part=part, inflate=inflate, mirror=mirror, mat=Rm)


# The chibi villager: the head keeps one texel per pixel (it carries the face, the nose and every hat), the body is
# squashed as Steve's is (models.STEVE body_sy 0.52, leg_sy 0.36) and the robe spans from the neck to just above the
# feet, as Minecraft's 20-texel robe ends 4 texels above them.
V_BODY, V_LEG = 0.52, 0.36


def villager(tex, pose=None):
    p = {'leg': 0.0, 'head_z': 0.0, 'head_x': 0.0, 'bob': 0.0}
    p.update(pose or {})
    bob = p['bob']
    hip = 12 * V_LEG + bob
    neck = hip + 12 * V_BODY
    robe_bottom = hip - 8 * V_LEG
    robe_sy = (neck - robe_bottom) / 20.0
    boxes = []
    # legs (Minecraft: rightLeg.xRot = cos(limbSwing * 0.6662) * 1.4 * amount * 0.5)
    la = R(p['leg'])
    boxes.append(mbox(tex, (0, 22), (-2, 0, -2), (4, 12, 4), (-2, hip, 0), rot=(la, 0, 0), scale=(1, V_LEG, 1), part='rleg'))
    boxes.append(mbox(tex, (0, 22), (-2, 0, -2), (4, 12, 4), (2, hip, 0), rot=(-la, 0, 0), scale=(1, V_LEG, 1), part='lleg', mirror=True))
    # body and robe (the robe is Minecraft's "jacket", inflated 0.5)
    boxes.append(mbox(tex, (16, 20), (-4, 0, -3), (8, 12, 6), (0, neck, 0), scale=(1, V_BODY, 1), part='body'))
    boxes.append(mbox(tex, (0, 38), (-4, 0, -3), (8, 20, 6), (0, neck, 0), scale=(1, robe_sy, 1), inflate=0.5, part='body'))
    # the crossed arms (pivot 3 texels below the neck and 1 forward, tipped forward 0.75 rad)
    arms = (0, neck - 3 * V_BODY, 1.0)
    asc = (1, 0.62, 0.62)
    boxes.append(mbox(tex, (44, 22), (-8, -2, -2), (4, 8, 4), arms, rot=(-0.75, 0, 0), scale=asc, part='arms'))
    boxes.append(mbox(tex, (44, 22), (4, -2, -2), (4, 8, 4), arms, rot=(-0.75, 0, 0), scale=asc, part='arms', mirror=True))
    boxes.append(mbox(tex, (40, 38), (-4, 2, -2), (8, 4, 4), arms, rot=(-0.75, 0, 0), scale=asc, part='arms'))
    # the head: head, nose (its pivot folded into the head's), hat (inflated 0.51) and the hat rim (a 16x16 plate
    # turned flat, -90 degrees about x); the shake turns all four together about the neck
    hz, hx = p['head_z'], p['head_x']
    H = rot_z(-hz) @ rot_x(hx)
    head = (0, neck, 0)
    boxes.append(mbox(tex, (0, 0), (-4, -10, -4), (8, 10, 8), head, pre=H, part='head'))
    boxes.append(mbox(tex, (24, 0), (-1, -3, -6), (2, 4, 2), head, pre=H, part='head'))
    boxes.append(mbox(tex, (32, 0), (-4, -10, -4), (8, 10, 8), head, pre=H, inflate=0.51, part='head'))
    boxes.append(mbox(tex, (30, 47), (-8, -8, -6), (16, 16, 1), head, rot=(-math.pi / 2, 0, 0), pre=H, part='head'))
    return boxes


# The iron golem (Minecraft's IronGolemModel): the head keeps one texel per pixel, everything below the neck is
# scaled by G_BODY so the golem stands about two tiles tall (Minecraft's is 2.7 blocks), arms hanging past the knees.
G_BODY = 0.6
G_BODY_X = 0.72      # a little wider than tall, or the full-size head makes the golem look thin
G_BODY_Z = 0.8       # and deeper than tall, or its side views are thin planks


def golem(tex, pose=None):
    p = {'leg': 0.0, 'rarm': 0.0, 'larm': 0.0}
    p.update(pose or {})
    s, sx, sz = G_BODY, G_BODY_X, G_BODY_Z
    # Minecraft's frame: the neck pivot is y -7, the leg pivots y 11 (feet at 24). Renderer y = (24 - y) * s below the neck.
    Y = lambda y: (24 - y) * s
    neck = Y(-7)
    sc = (sx, s, sz)
    boxes = []
    la = R(p['leg'])
    boxes.append(mbox(tex, (37, 0), (-3.5, -3, -3), (6, 16, 5), (-4 * sx, Y(11), 0), rot=(la, 0, 0), scale=sc, part='rleg'))
    boxes.append(mbox(tex, (60, 0), (-3.5, -3, -3), (6, 16, 5), (5 * sx, Y(11), 0), rot=(-la, 0, 0), scale=sc, part='lleg', mirror=True))
    boxes.append(mbox(tex, (0, 40), (-9, -2, -6), (18, 12, 11), (0, neck, 0), scale=sc, part='body'))
    boxes.append(mbox(tex, (0, 70), (-4.5, 10, -3), (9, 5, 6), (0, neck, 0), scale=sc, inflate=0.5 * s, part='body'))
    boxes.append(mbox(tex, (60, 21), (-13, -2.5, -3), (4, 30, 6), (0, neck, 0), rot=(R(p['rarm']), 0, 0), scale=sc, part='rarm'))
    boxes.append(mbox(tex, (60, 58), (9, -2.5, -3), (4, 30, 6), (0, neck, 0), rot=(R(p['larm']), 0, 0), scale=sc, part='larm'))
    # the head sits forward of the neck pivot (pivot z -2) and keeps full size
    hp = (0, neck, 2 * sz)
    boxes.append(mbox(tex, (0, 0), (-4, -12, -5.5), (8, 10, 8), hp, part='head'))
    boxes.append(mbox(tex, (24, 0), (-1, -5, -7.5), (2, 4, 2), hp, part='head'))
    return boxes


# ---------------------------------------------------------------- sheets
def frame(boxes, yaw, size, org, inner=None):
    """One sprite frame. With `inner`, a part drawn in front of another by more than `inner` px of depth gets a dark
    edge on the part behind (mcmodel.outline's inner edges), which keeps the golem's arms apart from its body."""
    img, part, depth, _ = M.render_fast(boxes, yaw=yaw, size=size, origin=org, k=0.45, shade=SHADE)
    if inner is None:
        return M.outline_fast(BM.grade(img))
    names = sorted({b.part for b in boxes})
    groups = np.array([names.index(b.part) for b in boxes] + [-1])
    return M.outline_fast(BM.grade(img), part=groups[part], depth=depth, inner=inner)


def lying(boxes, size, org):
    """On its back, head to the north, seen from straight above: the front view with no top faces (as Steve's
    sleep frame is made)."""
    img, _, _, _ = M.render_fast(boxes, yaw=0.0, size=size, origin=org, k=0.0, shade=SHADE)
    return M.outline_fast(BM.grade(img))


WALK = (None, 0.0, math.pi)


def villager_row(tex):
    frames, layout = [], {'walk': {}, 'shake': {}, 'sleep': {}}
    for dirn, yaw in DIRS.items():
        layout['walk'][dirn] = []
        for ph in WALK:
            leg = 0.0 if ph is None else math.degrees(math.cos(ph) * 1.4 * 0.5)
            # the step frames sit 1 px lower (the angled legs lift the feet about that much), so a walk bobs even
            # from the side, where the robe hides most of the 0.36-scale legs
            bob = 0.0 if ph is None else -1.0
            layout['walk'][dirn].append(len(frames)); frames.append(frame(villager(tex, {'leg': leg, 'bob': bob}), yaw, (VW, VH), VORG))
    for dirn, yaw in DIRS.items():
        layout['shake'][dirn] = []
        for hz in (0.22, -0.22):
            layout['shake'][dirn].append(len(frames)); frames.append(frame(villager(tex, {'head_z': hz, 'head_x': 0.12}), yaw, (VW, VH), VORG))
    layout['sleep']['down'] = [len(frames)]; frames.append(lying(villager(tex), (VW, VH), VORG))
    return frames, layout


def build_villager_sheets():
    sheets = {}
    layout = None
    for vt in TYPES:
        rows = []
        for prof in PROFS:
            fr, layout = villager_row(villager_texture(vt, prof))
            rows.append(np.hstack(fr))
        img = np.vstack(rows)
        BM.save(img, OUT / f'villager_{vt}.png')
        sheets[vt] = f'villager_{vt}.png'
        print(f'  villager_{vt}.png {img.shape[1]}x{img.shape[0]}')
    return {'w': VW, 'h': VH, 'origin': list(VORG), 'files': sheets, 'rows': PROFS, 'poses': layout,
            'frames': sum(len(v) for d in layout.values() for v in d.values())}


CRACKS = [None, 'low', 'medium', 'high']


def tri(x, period):
    """Minecraft's Mth.triangleWave."""
    return (abs(x % period - period * 0.5) - period * 0.25) / (period * 0.25)


def build_golem_sheet():
    rows, layout = [], None
    for crack in CRACKS:
        tex = golem_texture(crack)
        frames, layout = [], {'walk': {}, 'attack': {}}
        for dirn, yaw in DIRS.items():
            layout['walk'][dirn] = []
            for q in (None, 0.0, 0.5):
                # IronGolemModel: legs -1.5 * tri(limbSwing, 13) * amount; arms (-0.2 + 1.5 * tri) * amount, opposite.
                # The steps are the wave's two extremes (tri is +1 at 0 and -1 at half the period; at a quarter it is 0,
                # which made the first build's steps the idle pose)
                w = 0.0 if q is None else tri(q * 13, 13)
                leg = math.degrees(-1.5 * w * 0.45)
                arm = math.degrees((-0.2 + 1.5 * w) * 0.45) if q is not None else 0.0
                layout['walk'][dirn].append(len(frames))
                frames.append(frame(golem(tex, {'leg': leg, 'rarm': arm, 'larm': -arm}), yaw, (GW, GH), GORG, inner=1.5))
            layout['attack'][dirn] = []
            for arm in (-115.0, -25.0):   # attackTicks: -2 + 1.5 * tri: arms thrown up, then swung down
                layout['attack'][dirn].append(len(frames))
                frames.append(frame(golem(tex, {'rarm': arm, 'larm': arm}), yaw, (GW, GH), GORG, inner=1.5))
        rows.append(np.hstack(frames))
    img = np.vstack(rows)
    BM.save(img, OUT / 'iron_golem.png')
    print(f'  iron_golem.png {img.shape[1]}x{img.shape[0]}')
    return {'w': GW, 'h': GH, 'origin': list(GORG), 'file': 'iron_golem.png', 'rows': ['intact', 'low', 'medium', 'high'],
            'crackBelow': [1.0, 0.75, 0.5, 0.25], 'poses': layout}


# ---------------------------------------------------------------- icons for trade items items.json lacks
LEATHER = (160, 101, 64)     # Minecraft's undyed leather colour (#A06540)


def leather_icon(piece):
    base = BM.tex(f'leather_{piece}')
    ov = BM.tex(f'leather_{piece}_overlay')
    out = BM.tint(base, LEATHER)
    on = ov[..., 3] > 0
    out[on] = ov[on]
    return out


def icon_specs():
    """id -> (name, 16x16 RGBA). Only ids that items.json lacks get an icon here; the trade screen draws
    items.json's own icon whenever the item exists, so these retire as stage 5a adds the items."""
    melon = BM.iso(BM.tex('melon_top'), BM.tex('melon_side'), BM.tex('melon_side'))
    clay = BM.iso(BM.tex('clay'), BM.tex('clay'), BM.tex('clay'))
    return {
        'melon': ('Melon', melon), 'melon_slice': ('Melon Slice', BM.tex('melon_slice')), 'sugar': ('Sugar', BM.tex('sugar')),
        'lantern': ('Lantern', BM.tex('lantern') if (TX / 'item' / 'lantern.png').exists() else BM.tex('lantern')),
        'clay_ball': ('Clay Ball', BM.tex('clay_ball')), 'brick': ('Brick', BM.tex('brick')), 'clay': ('Clay', clay),
        'leather_helmet': ('Leather Cap', leather_icon('helmet')), 'leather_chestplate': ('Leather Tunic', leather_icon('chestplate')),
        'leather_leggings': ('Leather Pants', leather_icon('leggings')), 'leather_boots': ('Leather Boots', leather_icon('boots')),
    }


def build_icons(have):
    specs = {k: v for k, v in icon_specs().items() if k not in have}
    n = max(1, len(specs))
    img = np.zeros((16 * ((n + 7) // 8), 16 * min(8, n), 4), np.uint8)
    index = {}
    for i, (k, (name, ic)) in enumerate(specs.items()):
        ic = ic[:16, :16]
        img[(i // 8) * 16:(i // 8) * 16 + 16, (i % 8) * 16:(i % 8) * 16 + 16] = ic
        index[k] = {'i': i, 'name': name}
    BM.save(img, OUT / 'icons.png')
    return {'file': 'icons.png', 'cols': 8, 'items': index}


# ---------------------------------------------------------------- the merchant screen's textures
def build_gui():
    g = OUT / 'gui'
    g.mkdir(parents=True, exist_ok=True)
    panel = Image.open(TX / 'gui' / 'container' / 'villager.png').convert('RGBA').crop((0, 0, 276, 166))
    panel.save(g / 'villager.png', optimize=True)
    files = {'panel': 'gui/villager.png'}
    for n in ('trade_arrow', 'trade_arrow_out_of_stock', 'out_of_stock', 'scroller', 'scroller_disabled', 'experience_bar_background',
              'experience_bar_current', 'experience_bar_result', 'discount_strikethrough'):
        Image.open(TX / 'gui' / 'sprites' / 'container' / 'villager' / f'{n}.png').convert('RGBA').save(g / f'{n}.png', optimize=True)
        files[n] = f'gui/{n}.png'
    for n in ('button', 'button_highlighted', 'button_disabled'):
        Image.open(TX / 'gui' / 'sprites' / 'widget' / f'{n}.png').convert('RGBA').save(g / f'{n}.png', optimize=True)
        files[n] = f'gui/{n}.png'
    # (stage 7c) Minecraft's happy_villager particle (the green sparkles of a level-up, 5.6)
    Image.open(TX / 'particle' / 'glint.png').convert('RGBA').save(g / 'glint.png', optimize=True)
    files['glint'] = 'gui/glint.png'
    return files


# ---------------------------------------------------------------- sounds (silent placeholders for the files setup does not fetch)
SOUNDS = {
    # game key: Minecraft sound event (vendor/minecraft/sounds.json names the files)
    'villager.ambient': 'entity.villager.ambient', 'villager.yes': 'entity.villager.yes', 'villager.no': 'entity.villager.no',
    'villager.trade': 'entity.villager.trade', 'villager.celebrate': 'entity.villager.celebrate', 'villager.hurt': 'entity.villager.hurt',
    'villager.death': 'entity.villager.death',
    **{f'villager.work_{p}': f'entity.villager.work_{p}' for p in JOB_SITES},
    'iron_golem.attack': 'entity.iron_golem.attack', 'iron_golem.hurt': 'entity.iron_golem.hurt', 'iron_golem.death': 'entity.iron_golem.death',
    'iron_golem.step': 'entity.iron_golem.step', 'iron_golem.repair': 'entity.iron_golem.repair', 'iron_golem.damage': 'entity.iron_golem.damage',
    'husk.ambient': 'entity.husk.ambient', 'husk.hurt': 'entity.husk.hurt', 'husk.death': 'entity.husk.death', 'husk.step': 'entity.husk.step',
    'stray.ambient': 'entity.stray.ambient', 'stray.hurt': 'entity.stray.hurt', 'stray.death': 'entity.stray.death', 'stray.step': 'entity.stray.step',
    'bell.use': 'block.bell.use', 'bell.resonate': 'block.bell.resonate',
}


def sound_plan():
    """Every placeholder key with the files it needs, and which of those are not vendored yet (with their sizes
    from the asset index). Nothing is fetched: the game plays these keys silently until the files exist."""
    events = json.loads((MCV / 'sounds.json').read_text())
    objs = json.loads((MCV / 'index19.json').read_text())['objects']
    keys, pending, have = {}, {}, set()
    for key, ev in SOUNDS.items():
        names = []
        for s in events[ev]['sounds']:
            n = s if isinstance(s, str) else s['name']
            if n not in names:
                names.append(n)
        keys[key] = {'event': ev, 'files': names}
        for n in names:
            if (MCV / 'sounds' / f'{n}.ogg').exists():
                have.add(n)
            else:
                o = objs.get(f'minecraft/sounds/{n}.ogg')
                pending[n] = o['size'] if o else None
    return keys, pending, sorted(have)


# ---------------------------------------------------------------- contact sheets
def contact(path_in, cell, rows, cols_labels, out_path, scale=3, header=''):
    img = Image.open(path_in).convert('RGBA')
    W, H = img.size
    lab = 96
    canvas = Image.new('RGBA', (lab + W * scale, 16 + H * scale + 4), (210, 214, 200, 255))
    big = img.resize((W * scale, H * scale), Image.NEAREST)
    canvas.alpha_composite(big, (lab, 16))
    d = ImageDraw.Draw(canvas)
    d.text((4, 2), header, fill=(20, 20, 20, 255))
    for r, name in enumerate(rows):
        d.text((4, 16 + r * cell[1] * scale + cell[1] * scale // 2 - 5), name, fill=(20, 20, 20, 255))
    for c, name in cols_labels:
        d.text((lab + c * cell[0] * scale + 2, 4), name, fill=(60, 60, 60, 255))
    for r in range(1, len(rows)):
        d.line([(lab, 16 + r * cell[1] * scale), (lab + W * scale, 16 + r * cell[1] * scale)], fill=(170, 174, 160, 255))
    canvas.save(out_path)
    return out_path


def write_contacts(dirp, vmeta, gmeta):
    dirp = Path(dirp); dirp.mkdir(parents=True, exist_ok=True)
    out = []
    labels = []
    for pose, dd in vmeta['poses'].items():
        for dirn, idx in dd.items():
            labels.append((idx[0], f'{pose[:5]} {dirn[0]}'))
    for vt in TYPES:
        out.append(contact(OUT / vmeta['files'][vt], (VW, VH), PROFS, labels, dirp / f'contact_villager_{vt}.png', 3, f'villager_{vt}.png'))
    gl = []
    for pose, dd in gmeta['poses'].items():
        for dirn, idx in dd.items():
            gl.append((idx[0], f'{pose[:4]} {dirn[0]}'))
    out.append(contact(OUT / 'iron_golem.png', (GW, GH), gmeta['rows'], gl, dirp / 'contact_iron_golem.png', 3, 'iron_golem.png'))
    # one walk-down idle frame of every type x profession side by side, larger, for reading faces and hats
    grid = Image.new('RGBA', (len(PROFS) * VW * 4 + 96, len(TYPES) * VH * 4 + 20), (210, 214, 200, 255))
    d = ImageDraw.Draw(grid)
    for c, prof in enumerate(PROFS):
        d.text((96 + c * VW * 4 + 2, 4), prof[:11], fill=(20, 20, 20, 255))
    for r, vt in enumerate(TYPES):
        sh = Image.open(OUT / vmeta['files'][vt]).convert('RGBA')
        d.text((4, 20 + r * VH * 4 + VH * 2), vt, fill=(20, 20, 20, 255))
        for c in range(len(PROFS)):
            f = sh.crop((0, c * VH, VW, (c + 1) * VH)).resize((VW * 4, VH * 4), Image.NEAREST)
            grid.alpha_composite(f, (96 + c * VW * 4, 20 + r * VH * 4))
    p = dirp / 'contact_villagers_all.png'
    grid.save(p); out.append(p)
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    only_data = '--only-data' in sys.argv
    old = {}
    if (OUT / 'villagers.json').exists():
        old = json.loads((OUT / 'villagers.json').read_text())
    if only_data and old.get('villager') and old.get('golem'):
        vmeta, gmeta = old['villager'], old['golem']
    else:
        print('rendering villager sheets (7 types x 15 professions)')
        vmeta = build_villager_sheets()
        print('rendering the iron golem')
        gmeta = build_golem_sheet()
    items = json.loads((HERE / 'assets' / 'mc' / 'items.json').read_text())['items']
    icons = build_icons(set(items))
    gui = build_gui()
    keys, pending, have = sound_plan()
    trades = VT.export()
    (OUT / 'trades.json').write_text(json.dumps(trades, separators=(',', ':')))
    # (stage 7c) the arbitrage check runs with the build (design 5.6): a table that could print money is not shipped
    import subprocess
    tc = subprocess.run([sys.executable, str(HERE / 'tools' / 'trade_check.py')], capture_output=True, text=True)
    print('  ' + (tc.stdout.splitlines() or ['trade_check: no output'])[0])
    if tc.returncode != 0:
        print(tc.stdout)
        sys.exit('trade_check.py failed: fix tools/villager_trades.py (GEN_SELL: trade_check.py --suggest)')
    meta = {
        'version': 1,
        'types': TYPES, 'professions': PROFS, 'names': PROF_NAMES,
        'jobSites': {p: {'block': b, 'works': w} for p, (b, w) in JOB_SITES.items()},
        'villager': vmeta, 'golem': gmeta, 'icons': icons, 'gui': gui,
        'sounds': keys,
        'pendingSounds': {'files': pending, 'bytes': sum(v or 0 for v in pending.values()),
                          'note': 'not fetched by setup.sh (tools/minecraft-sounds.txt lists what it fetches); these keys play silently'},
        'vendoredSounds': have,
    }
    (OUT / 'villagers.json').write_text(json.dumps(meta, indent=1))
    print(f'  icons for {len(icons["items"])} items missing from items.json: {", ".join(icons["items"])}')
    print(f'  sounds: {len(keys)} placeholder keys, {len(pending)} files pending ({meta["pendingSounds"]["bytes"]} bytes), {len(have)} already vendored')
    if '--sheets' in sys.argv:
        d = sys.argv[sys.argv.index('--sheets') + 1]
        for p in write_contacts(d, vmeta, gmeta):
            print('  contact sheet', p)
    print('done')


if __name__ == '__main__':
    main()
