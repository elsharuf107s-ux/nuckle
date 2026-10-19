#!/usr/bin/env python3
"""The Nether: a generated region appended below Kanto's rooms (a stage of tools/build_world.py).

It is one map entry, MAP_NETHER, about 128x96 cells, drawn with its own atlas entries made from
Minecraft 1.21.4's textures in the way this game draws FireRed's caves: 16-px top-down tiles where a wall
shows its top, and a wall cell with open ground to the south shows a front face (darker, with a lit lip)
so cliffs read as raised. Floors are flat and a little darker than the wall tops; lava lies lower than
the ground, so a lava cell shows the bank of whatever is north of it.

The region is generated from a fixed seed:
  - the Nether wastes: open netherrack caverns with lava pools, magma, fire, quartz and gold ore,
    glowstone on the walls beside open ground and ancient debris deep inside the walls;
  - a soul sand valley: soul sand and soul soil floors, soul soil mounds, bone block fossils, soul fire;
  - a lava sea with a nether brick fortress standing in it: a bridge from the wastes, a keep with two
    loot chests, a nether wart garden on soul sand and a fenced blaze platform;
  - the arrival: a lit obsidian portal near the west edge with a short safe path into the wastes.
The region's edge ring and the portal frame are protected; everything else can be mined.

Wall tiles are keyed by an 8-bit "open" mask so the runtime can re-edge a mined wall (wall_key()):
  N=1 E=2 S=4 W=8, and the corners NE=16 SE=32 SW=64 NW=128 (a corner bit only when both of its sides are
  wall). A cell is open when it is not a wall (floor, lava, portal, fence). A wall cell is a front face when
  S is open. Floors are keyed by whether a wall stands north of them (a contact shadow, 0 or 1), lava by the
  bank north of it (LIP_OF of that cell's material) and its non-lava sides N=1 E=2 S=4 W=8, fences by the
  sides joined to a fence or a brick wall. Every shape of every material is in the atlas (Tiles.complete()).

world.json 'nether' (world cells): x, y, w, h, map (index in maps), pair, first and count (its atlas entries);
arrival {x, y, dir} (inside the return portal, as Minecraft puts you) and stepOut (the cell south of the frame);
portal {ring, cells}; blocks [[x, y, record]] to place on a new world (fire, soul fire, nether wart, the two
fortress chests with their loot); chests; lights [[x, y, level]] (glowstone, the portal, lava shores, magma);
biome (one string per row: W wastes, V soul sand valley, L lava sea, F fortress, B blaze platform) and spawns
(mobs per biome letter); tiles {entry: [kind, mat, key, variant]}; wall {mat: {key: [entry per variant]}},
floor {look: {shadow: [entry per variant]}}, lava {lip: {key: entry}}, fence {key: entry}, portalTile; lipOf;
floorLook (the floor a mined wall of that material leaves; anything else leaves 'floor', plain netherrack).
"""
import json
import math
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import mcdata as D  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
TX = HERE / 'vendor' / 'minecraft' / 'jar' / 'assets' / 'minecraft' / 'textures' / 'block'

NW, NH = 128, 96          # the region, in cells
GUTTER = 8                # void rows between the rooms and the Nether, and below it
SEED = 1979               # the generation is deterministic
MAP_ID = 'MAP_NETHER'
OUTLINE = np.array((44, 12, 14), np.uint8)

# what each wall material looks like: top texture, side texture, and extra looks used for variety
WALL_LOOK = {
    'netherrack': ('netherrack', 'netherrack'),
    'nether_quartz_ore': ('nether_quartz_ore', 'nether_quartz_ore'),
    'nether_gold_ore': ('nether_gold_ore', 'nether_gold_ore'),
    'ancient_debris': ('ancient_debris_top', 'ancient_debris_side'),
    'glowstone': ('glowstone', 'glowstone'),
    'nether_bricks': ('nether_bricks', 'nether_bricks'),
    'obsidian': ('obsidian', 'obsidian'),
    'soul_soil': ('soul_soil', 'soul_soil'),
    'bone_block': ('bone_block_top', 'bone_block_side'),
}
WALL_VARIANTS = {'netherrack': 4, 'nether_bricks': 2, 'soul_soil': 2}
# (texture, variants) of each floor; 'floor' is plain netherrack ground, 'brick_floor' the fortress's
FLOOR_LOOK = {'floor': ('netherrack', 8), 'soul_sand': ('soul_sand', 4), 'soul_soil': ('soul_soil', 4),
              'brick_floor': ('nether_bricks', 2), 'magma_block': ('magma', 2)}
FLOOR_MAT = {'floor': 'floor', 'soul_sand': 'soul_sand', 'soul_soil': 'soul_soil', 'brick_floor': 'floor', 'magma_block': 'magma_block'}
# the bank a lava cell shows under each material north of it
LIP_OF = {'netherrack': 'netherrack', 'nether_quartz_ore': 'netherrack', 'nether_gold_ore': 'netherrack', 'ancient_debris': 'netherrack',
          'glowstone': 'netherrack', 'floor': 'netherrack', 'magma_block': 'netherrack', 'nether_bricks': 'nether_bricks',
          'brick_floor': 'nether_bricks', 'fence': 'nether_bricks', 'soul_sand': 'soul_sand', 'soul_soil': 'soul_soil',
          'obsidian': 'obsidian', 'bone_block': 'soul_soil', 'portal': 'obsidian'}
LIP_TEX = {'netherrack': 'netherrack', 'nether_bricks': 'nether_bricks', 'soul_sand': 'soul_sand', 'soul_soil': 'soul_soil',
           'obsidian': 'obsidian'}


# ---------------------------------------------------------------- textures and tile pieces
_tex = {}


def tex(name):
    if name not in _tex:
        a = np.array(Image.open(TX / f'{name}.png').convert('RGBA'))
        _tex[name] = a[:16, :16].copy()
    return _tex[name]


def rgb(a):
    return a[:, :, :3].astype(np.float64)


def pack(f, alpha=None):
    out = np.zeros(f.shape[:2] + (4,), np.uint8)
    out[:, :, :3] = np.clip(np.round(f), 0, 255)
    out[:, :, 3] = 255 if alpha is None else alpha
    return out


def grade(f, gain=1.0, sat=1.0, lift=0.0, contrast=1.0):
    g = f.mean(axis=2, keepdims=True)
    f = g + (f - g) * sat
    m = f.mean()
    f = m + (f - m) * contrast
    return f * gain + lift


def turn(t, v, rotate=True):
    """Texture variety without seams: rotations and flips of a tiling texture."""
    if rotate:
        t = np.rot90(t, v % 4)
        return t[:, ::-1] if v >= 4 else t
    return t[:, ::-1] if v % 2 else t


# brightness of each layer: tops are lit, floors lower and calmer, faces in shade
TOP = dict(gain=1.28, sat=1.05, lift=10)
FLOOR = dict(gain=0.98, sat=0.9, lift=4, contrast=0.7)
FACE_TOP, FACE_BOTTOM = 0.86, 0.5
RIM = 4                   # rows of a face cell that still show the wall's top


def top_of(mat, v):
    t = tex(WALL_LOOK[mat][0])
    if mat == 'nether_bricks':
        return rgb(tex('cracked_nether_bricks') if v == 1 else t)       # bricks keep their courses level
    if mat == 'soul_soil':
        return soften(rgb(turn(t, v, rotate=False)), 0.45)
    if mat == 'bone_block':
        return rgb(turn(t, v, rotate=False))
    return rgb(turn(t, v))


def side_of(mat, v):
    if mat == 'nether_bricks':
        return rgb(tex('cracked_nether_bricks') if v == 1 else tex('nether_bricks'))
    return rgb(turn(tex(WALL_LOOK[mat][1]), v, rotate=False))


def soften(f, k=0.5):
    """Blend a tiling texture with its own wrapped 3x3 blur: calmer, and still seamless."""
    b = sum(np.roll(np.roll(f, dy, 0), dx, 1) for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9.0
    return f * (1 - k) + b * k


# per material: (top gain, top lift) so dark textures (bricks, obsidian) still read as raised
TOP_GAIN = {'nether_bricks': (1.9, 14), 'obsidian': (1.5, 8), 'soul_soil': (1.3, 12), 'bone_block': (1.0, 4)}


def wall_tile(mat, key, v):
    """A wall cell by its open mask (see the module docstring)."""
    n, e, s, w = key & 1, key & 2, key & 4, key & 8
    ne, se, sw, nw = key & 16, key & 32, key & 64, key & 128
    gain, lift = TOP_GAIN.get(mat, (TOP['gain'], TOP['lift']))
    top = grade(top_of(mat, v), gain=gain, sat=TOP['sat'], lift=lift)
    f = top.copy()
    face_rows = 16 - RIM
    if s:
        side = grade(side_of(mat, v), gain=gain * 0.95, sat=1.0, lift=lift * 0.5)
        # the face: the side texture drawn out downwards into strata, darkening towards the ground
        if mat == 'nether_bricks':
            idx = np.clip(((np.arange(face_rows) + 0.5) * 16 / face_rows).astype(int), 0, 15)
            face = side[idx]
        else:
            # rock strata: the texture smeared downwards, with its columns lit unevenly
            idx = (np.arange(face_rows) * 5 // face_rows + v * 4) % 16
            face = side[idx] * 0.55 + side[(idx + 8) % 16] * 0.45
            col = side.mean(axis=(0, 2))
            stripes = 1 + 0.32 * (col - col.mean()) / (col.std() + 1e-6)
            face = face * np.clip(stripes, 0.7, 1.35)[None, :, None]
        k = np.linspace(FACE_TOP, FACE_BOTTOM, face_rows)[:, None, None]
        f[RIM:] = face * k
        f[RIM - 1] = np.clip(top[RIM - 1] + 40, 0, 255)             # the lit lip of the cliff
        f[RIM] = f[RIM] * 0.62
        f[15] = OUTLINE * 1.1                                        # where the face meets the ground
    if n:
        f[0] = OUTLINE
        f[1] = np.clip(f[1] + 28, 0, 255)                            # the back edge catches the light
    if w:
        f[:, 0] = OUTLINE
        f[1:, 1] *= 0.82
    if e:
        f[:, 15] = OUTLINE
        f[1:, 14] *= 0.76
    # rounded outer corners
    if n and w:
        f[1, 1] = OUTLINE
    if n and e:
        f[1, 14] = OUTLINE
    if s and w:
        f[14, 1] = OUTLINE
    if s and e:
        f[14, 14] = OUTLINE
    # inner corners: a notch of outline where only the diagonal cell is open
    if nw:
        f[0, 0] = OUTLINE; f[0, 1] *= 0.7; f[1, 0] *= 0.7
    if ne:
        f[0, 15] = OUTLINE; f[0, 14] *= 0.7; f[1, 15] *= 0.7
    if sw:
        f[15, 0] = OUTLINE; f[15, 1] *= 0.7; f[14, 0] *= 0.7
    if se:
        f[15, 15] = OUTLINE; f[15, 14] *= 0.7; f[14, 15] *= 0.7
    return pack(f)


def floor_tile(look, shadow, v):
    name, _ = FLOOR_LOOK[look]
    if look == 'brick_floor':
        t = rgb(tex('cracked_nether_bricks') if v == 1 else tex('nether_bricks'))
        f = grade(t, gain=1.34, sat=0.95, lift=10, contrast=0.75)
    elif look == 'magma_block':
        f = grade(rgb(turn(tex('magma'), v)), gain=0.95, sat=1.0, lift=0, contrast=0.9)
    elif look == 'soul_sand':
        f = grade(soften(rgb(turn(tex(name), v, rotate=False)), 0.5), gain=1.12, sat=1.0, lift=6, contrast=0.6)
    elif look == 'soul_soil':
        f = grade(soften(rgb(turn(tex(name), v, rotate=False)), 0.4), gain=0.86, sat=1.1, lift=0, contrast=0.7)
    else:
        f = grade(soften(rgb(turn(tex(name), v)), 0.45), **FLOOR)
    if shadow:
        for r, k in enumerate((0.5, 0.66, 0.8, 0.92)):
            f[r] *= k
    return pack(f)


def lava_frame():
    return tex('lava_still').copy()


def lava_tiles(lip, key):
    """Lava (the first frame of lava_still; the runtime animates it) below, and in the layer above the
    bank of the material north of it plus a dark line where it meets ground on the other sides."""
    below = lava_frame()
    above = np.zeros((16, 16, 4), np.uint8)
    n, e, s, w = key & 1, key & 2, key & 4, key & 8
    if n:
        side = grade(rgb(tex(LIP_TEX[lip])), gain=1.15, lift=4)
        bank = np.zeros((4, 16, 3))
        for r, k in enumerate((0.78, 0.62, 0.48, 0.34)):
            bank[r] = side[r] * k
        above[0:4, :, :3] = np.clip(bank, 0, 255).astype(np.uint8)
        above[0:4, :, 3] = 255
        above[4, :, :3] = (90, 22, 6)
        above[4, :, 3] = 150
    def line(sl):
        above[sl + (slice(0, 3),)] = OUTLINE
        above[sl + (slice(3, 4),)] = 200
    if w:
        line((slice(4 if n else 0, 16), slice(0, 1)))
    if e:
        line((slice(4 if n else 0, 16), slice(15, 16)))
    if s:
        line((slice(15, 16), slice(0, 16)))
    return below, above


def portal_tile():
    return tex('nether_portal').copy()


def fence_tile(conn):
    """A nether brick fence on the bridge deck, from above: a post with rails to the connected sides
    (conn bits: N=1 E=2 S=4 W=8)."""
    deck = rgb(tex('nether_bricks'))
    f = grade(deck, gain=1.32, sat=0.95, lift=12, contrast=0.8)
    p = grade(rgb(tex('nether_bricks')), gain=1.0, lift=0)
    hi = np.clip(grade(rgb(tex('nether_bricks')), gain=1.55, lift=18), 0, 255)
    def put(y0, y1, x0, x1, src, shadow=True):
        f[y0:y1, x0:x1] = src[y0:y1, x0:x1]
        if shadow and y1 < 16:
            f[y1, x0:x1] *= 0.55
    if conn & 8:
        put(6, 9, 0, 6, p); f[5, 0:6] = hi[5, 0:6]
    if conn & 2:
        put(6, 9, 10, 16, p); f[5, 10:16] = hi[5, 10:16]
    if conn & 1:
        put(0, 6, 7, 9, p, shadow=False); f[0:6, 6] = hi[0:6, 6]
    if conn & 4:
        put(9, 16, 7, 9, p, shadow=False); f[9:16, 6] = hi[9:16, 6]
    # the post, with its lit top
    f[4:11, 5:11] = p[4:11, 5:11]
    f[4, 5:11] = hi[4, 5:11]
    f[4:11, 5] = OUTLINE
    f[4:11, 10] = OUTLINE
    f[11, 5:11] = OUTLINE * 1.4
    return pack(f)


BLANK = np.zeros((16, 16, 4), np.uint8)


class Tiles:
    """Nether atlas entries, appended to build_world's entry list on first use (or all at once by
    complete()), with what each one is so the runtime can re-edge mined walls."""

    def __init__(self, entries, pair):
        self.entries, self.pair = entries, pair
        self.cache = {}
        self.info = {}            # atlas index -> [kind, mat, key, variant]

    def _add(self, key, make, mat, col, enc, info, beh=0):
        if key in self.cache:
            return self.cache[key]
        below, above = make()
        self.entries.append(dict(mid=-1, pair=self.pair, below=below, above=above, beh=beh, enc=enc, col=col, mat=mat))
        i = len(self.entries) - 1
        self.cache[key] = i
        self.info[i] = info
        return i

    def wall(self, mat, key, v=0):
        v %= WALL_VARIANTS.get(mat, 1)
        return self._add(('wall', mat, key, v), lambda: (wall_tile(mat, key, v), BLANK), mat, 1, 0, ['wall', mat, key, v])

    def floor(self, look, shadow, v=0):
        v %= FLOOR_LOOK[look][1]
        return self._add(('floor', look, shadow, v), lambda: (floor_tile(look, shadow, v), BLANK), FLOOR_MAT[look], 0, 1, ['floor', look, int(shadow), v])

    def lava(self, lip, key):
        return self._add(('lava', lip, key), lambda: lava_tiles(lip, key), 'lava', 1, 0, ['lava', lip, key, 0])

    def portal(self):
        return self._add(('portal',), lambda: (portal_tile(), BLANK), 'nether_portal', 0, 0, ['portal', 'nether_portal', 0, 0])

    def fence(self, conn):
        return self._add(('fence', conn), lambda: (fence_tile(conn), BLANK), 'nether_brick_fence', 1, 0,
                         ['fence', 'nether_brick_fence', conn, 0])

    def complete(self):
        """Every piece the runtime may need when walls are mined: all 47 wall shapes of every wall material
        and variant, every floor with and without its shadow, every lava bank."""
        for mat in WALL_LOOK:
            for key in ALL_KEYS:
                for v in range(WALL_VARIANTS.get(mat, 1)):
                    self.wall(mat, key, v)
        for look, (_, nv) in FLOOR_LOOK.items():
            for sh in (0, 1):
                for v in range(nv):
                    self.floor(look, sh, v)
        for lip in LIP_TEX:
            for key in range(16):
                self.lava(lip, key)
        for conn in range(16):
            self.fence(conn)
        self.portal()


def canon(key):
    """Drop corner bits whose sides are not both wall."""
    n, e, s, w = key & 1, key & 2, key & 4, key & 8
    out = key & 15
    if not n and not e and key & 16:
        out |= 16
    if not s and not e and key & 32:
        out |= 32
    if not s and not w and key & 64:
        out |= 64
    if not n and not w and key & 128:
        out |= 128
    return out


ALL_KEYS = sorted({canon(k) for k in range(256)})


# ---------------------------------------------------------------- noise
def value_noise(rng, h, w, cell):
    gh, gw = h // cell + 3, w // cell + 3
    g = rng.rand(gh, gw)
    ys = np.arange(h) / cell
    xs = np.arange(w) / cell
    y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
    ty = ys - y0; tx = xs - x0
    ty = ty * ty * (3 - 2 * ty); tx = tx * tx * (3 - 2 * tx)
    a = g[y0][:, x0]; b = g[y0][:, x0 + 1]; c = g[y0 + 1][:, x0]; d = g[y0 + 1][:, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty)[:, None] + (c * (1 - tx) + d * tx) * ty[:, None]


def fbm(rng, h, w, cells, weights):
    f = sum(wt * value_noise(rng, h, w, c) for c, wt in zip(cells, weights))
    return f / sum(weights)


DEBRIS_MIN = 24   # ancient debris in the region: 16 for the four armor pieces, the rest for tools


def h01(x, y, salt):
    v = (x * 374761393 + y * 668265263 + salt * 1442695041) & 0xFFFFFFFF
    v = ((v ^ (v >> 13)) * 1274126177) & 0xFFFFFFFF
    v ^= v >> 16
    return v / 4294967296.0


# ---------------------------------------------------------------- the map
WALL, FLOOR_K, LAVA, PORTAL, FENCE = 0, 1, 2, 3, 4


def neighbours(x, y):
    return ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))


def components(open_):
    h, w = open_.shape
    lab = np.full((h, w), -1, np.int32)
    sizes = []
    for y0, x0 in zip(*np.nonzero(open_)):
        if lab[y0, x0] >= 0:
            continue
        k = len(sizes); n = 0
        dq = deque([(x0, y0)]); lab[y0, x0] = k
        while dq:
            x, y = dq.popleft(); n += 1
            for xx, yy in neighbours(x, y):
                if 0 <= xx < w and 0 <= yy < h and open_[yy, xx] and lab[yy, xx] < 0:
                    lab[yy, xx] = k; dq.append((xx, yy))
        sizes.append(n)
    return lab, sizes


def dist_to(mask):
    """4-neighbour distance from every cell to the nearest True cell."""
    h, w = mask.shape
    d = np.full((h, w), 10 ** 6, np.int32)
    dq = deque()
    for y, x in zip(*np.nonzero(mask)):
        d[y, x] = 0; dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        for xx, yy in neighbours(x, y):
            if 0 <= xx < w and 0 <= yy < h and d[yy, xx] > d[y, x] + 1:
                d[yy, xx] = d[y, x] + 1; dq.append((xx, yy))
    return d


def carve_worm(kind, rng, a, b, width=1, wobble=0.6, region=None):
    """A meandering tunnel from a to b: steps towards b with random sideways drift."""
    x, y = float(a[0]), float(a[1])
    h, w = kind.shape
    ang_off = 0.0
    for _ in range(4000):
        dx, dy = b[0] - x, b[1] - y
        dist = math.hypot(dx, dy)
        if dist < 1.0:
            break
        ang_off = ang_off * 0.85 + (rng.rand() - 0.5) * wobble
        ang = math.atan2(dy, dx) + ang_off
        x += math.cos(ang); y += math.sin(ang)
        for oy in range(-width, width + 1):
            for ox in range(-width, width + 1):
                if ox * ox + oy * oy > width * width + 1:
                    continue
                xi, yi = int(round(x)) + ox, int(round(y)) + oy
                if 1 <= xi < w - 1 and 1 <= yi < h - 1 and kind[yi, xi] == WALL and (region is None or region[yi, xi]):
                    kind[yi, xi] = FLOOR_K


def smooth(m, passes, need=5):
    for _ in range(passes):
        n = sum(np.roll(np.roll(m, dy, 0), dx, 1).astype(int) for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        m = n >= need
    return m


def up2(m):
    """A coarse mask at full size: FireRed's caves step in whole metatiles, so the caverns are shaped
    on a 2x2 grid and their outlines step two cells at a time."""
    return np.kron(m.astype(np.uint8), np.ones((2, 2), np.uint8)).astype(bool)


def generate():
    """The Nether as arrays: kind (WALL/FLOOR/LAVA/PORTAL/FENCE), look (material per cell), biome letters,
    plus the portal, chests and pre-placed blocks."""
    rng = np.random.RandomState(SEED)
    H, W = NH, NW
    ch, cw = H // 2, W // 2
    ys, xs = np.mgrid[0:H, 0:W]
    cys, cxs = np.mgrid[0:ch, 0:cw]
    kind = np.full((H, W), WALL, np.int8)
    look = np.full((H, W), 'netherrack', dtype=object)
    biome = np.full((H, W), 'W', dtype='<U1')

    # ---- biome partition: the soul sand valley to the north-east, the lava sea and fortress to the
    # south-east, the wastes everywhere else
    bn = value_noise(rng, ch, cw, 5)
    cvalley = (cxs > 32 + bn * 5) & (cys < 18 + bn * 4)
    valley = up2(cvalley)
    sea_c = (92.0, 70.0)
    sea_r = np.hypot((xs - sea_c[0]) / 34.0, (ys - sea_c[1]) / 25.0) + (value_noise(rng, H, W, 7) - 0.5) * 0.24
    sea = (sea_r < 1.0) & ~valley
    biome[valley] = 'V'
    biome[sea] = 'L'
    csea = sea[::2, ::2]

    # ---- the wastes: noise caverns on the coarse grid, smoothed
    cav = fbm(rng, ch, cw, (8, 4, 2), (0.55, 0.3, 0.15))
    open_w = smooth(cav > 0.46, 2)
    # ---- the valley: a wide basin
    vn = fbm(rng, ch, cw, (7, 3), (0.7, 0.3))
    open_v = smooth(vn > 0.34, 2)
    cop = np.where(cvalley, open_v, open_w)
    # ---- anchors joined by tunnels (coarse cells) so everything is one walkable network
    arrival = (8, 47)
    anchors = [(4, 23), (11, 15), (12, 33), (20, 9), (22, 24), (18, 41), (29, 7), (39, 10), (50, 7), (56, 14), (28, 33)]
    links = [(0, 1), (0, 2), (1, 3), (1, 4), (2, 4), (2, 5), (3, 6), (6, 7), (7, 8), (8, 9), (4, 10), (5, 10)]
    ck = np.where(cop, FLOOR_K, WALL).astype(np.int8)
    for i, j in links:
        carve_worm(ck, rng, anchors[i], anchors[j], width=0, wobble=0.55, region=~csea)
    kind[up2(ck == FLOOR_K)] = FLOOR_K
    vfl = valley & (kind == FLOOR_K)
    soil = fbm(rng, H, W, (10, 5), (0.7, 0.3))
    look[vfl] = np.where(soil[vfl] > 0.52, 'soul_soil', 'soul_sand')

    # ---- the lava sea, ringed by a netherrack shore
    kind[sea] = LAVA
    shore = (sea_r >= 1.0) & (sea_r < 1.1) & ~valley
    kind[shore & (kind == WALL)] = FLOOR_K

    # the arrival chamber: kept clear and plain
    ax, ay = arrival
    kind[ay - 4:ay + 5, ax - 4:ax + 7] = FLOOR_K
    look[ay - 4:ay + 5, ax - 4:ax + 7] = 'netherrack'

    # ---- the fortress, its bridges and its platforms (drawn over the sea)
    fort = build_fortress(kind, look, biome)

    # ---- the edge: two cells of wall all round
    edge = (xs < 2) | (ys < 2) | (xs >= W - 2) | (ys >= H - 2)
    kind[edge] = WALL; look[edge] = 'netherrack'

    # ---- tidy: no one-cell walls between open cells, no tiny pockets, one connected network
    tidy(kind, look, biome, fort['keep'])
    return dict(kind=kind, look=look, biome=biome, arrival=arrival, fort=fort, rng=rng)


def tidy(kind, look, biome, keep):
    H, W = kind.shape
    for _ in range(4):
        changed = 0
        for y in range(2, H - 2):
            for x in range(2, W - 2):
                if keep[y, x] or kind[y, x] != WALL:
                    continue
                o = lambda xx, yy: kind[yy, xx] in (FLOOR_K,)
                if (o(x, y - 1) and o(x, y + 1)) or (o(x - 1, y) and o(x + 1, y)):
                    kind[y, x] = FLOOR_K; changed += 1
                    if biome[y, x] == 'V':
                        look[y, x] = 'soul_sand'
        if not changed:
            break
    # small floor pockets become wall; the big network stays
    walk = np.isin(kind, (FLOOR_K, PORTAL))
    lab, sizes = components(walk)
    if sizes:
        main = int(np.argmax(sizes))
        for k, n in enumerate(sizes):
            if k != main:
                m = (lab == k) & ~keep
                kind[m] = WALL
                look[m] = 'netherrack'


# ---------------------------------------------------------------- the fortress
# Drawn over the lava sea. '#' nether brick wall, '.' brick floor, 'f' fence, 'b' blaze platform floor,
# 's' soul sand (nether wart), 'C' chest on brick floor, 'L' a glowstone block on brick floor (the keep's
# lamps: its inner walls shut out the lava's light), '~' lava, ' ' leave as it is.
FORT_X, FORT_Y = 80, 46
FORT = [
    "          ffffffffffffff                ",
    "          fbbbbbbbbbbbbf                ",
    "          fbb#bbbbbb#bbf                ",
    "          fbbbbbbbbbbbbf                ",
    "          fbbbbbbbbbbbbf                ",
    "          fbb#bbbbbb#bbf                ",
    "          fbbbbbbbbbbbbf                ",
    "          fffff...ffffff                ",
    "              f...f                     ",
    "              f...f                     ",
    "              f...f                     ",
    "              f...f                     ",
    "      ########.....#########            ",
    "      ########.....#########            ",
    "      ##.................C##            ",
    "      ##..................##            ",
    "      ##..####.....####..L##            ",
    "      ##..####.....####...##            ",
    "      ##..##L........##...##            ",
    "      ##..##.........##...##            ",
    "      .......................ffff       ",
    "      ...........................f      ",
    "      .......................ffff       ",
    "      ##..##.........##...##            ",
    "      ##..##........L##...##            ",
    "      ##..####.....####...##            ",
    "      ##..####.....####...##            ",
    "      ##..L...............##            ",
    "      ##C.................##            ",
    "      ##########...#########            ",
    "      ##########...#########            ",
    "               f...f                    ",
    "               f...f                    ",
    "               f...f                    ",
    "         ######.....######              ",
    "         ######.....######              ",
    "         ##s.s.s...s.s.s##              ",
    "         ##s.s.s...s.s.s##              ",
    "         ##s.s.s...s.s.s##              ",
    "         ##...............##            ",
    "         ###################            ",
    "         ###################            ",
]


def build_fortress(kind, look, biome):
    H, W = kind.shape
    keep = np.zeros((H, W), bool)
    chests, warts, blaze, lamps = [], [], [], []
    for r, row in enumerate(FORT):
        for c, ch in enumerate(row):
            x, y = FORT_X + c, FORT_Y + r
            if ch == ' ' or not (0 <= x < W and 0 <= y < H):
                continue
            keep[y, x] = True
            biome[y, x] = 'F'
            if ch == '#':
                kind[y, x] = WALL; look[y, x] = 'nether_bricks'
            elif ch == 'f':
                kind[y, x] = FENCE; look[y, x] = 'fence'
            elif ch == '~':
                kind[y, x] = LAVA
            else:
                kind[y, x] = FLOOR_K; look[y, x] = 'brick_floor'
                if ch == 's':
                    look[y, x] = 'soul_sand'; warts.append((x, y))
                elif ch == 'C':
                    chests.append((x, y))
                elif ch == 'L':
                    lamps.append((x, y))
                elif ch == 'b':
                    biome[y, x] = 'B'; blaze.append((x, y))
    # the west bridge: from the keep's west door across the sea to the shore
    door_y = FORT_Y + 21
    x = FORT_X + 6 - 1
    bridge = []
    while x > 2:
        landed = all(kind[door_y + dy, x] in (FLOOR_K,) and biome[door_y + dy, x] == 'W' for dy in (-1, 0, 1))
        if landed and x < FORT_X - 6:
            break
        for dy in (-1, 0, 1):
            kind[door_y + dy, x] = FLOOR_K; look[door_y + dy, x] = 'brick_floor'; keep[door_y + dy, x] = True; biome[door_y + dy, x] = 'F'
        for dy in (-2, 2):
            if kind[door_y + dy, x] == LAVA:
                kind[door_y + dy, x] = FENCE; look[door_y + dy, x] = 'fence'; keep[door_y + dy, x] = True; biome[door_y + dy, x] = 'F'
        bridge.append(x)
        x -= 1
    # the east bridge stub out of the keep's east door ends at a fenced lookout
    return dict(keep=keep, chests=chests, warts=warts, blaze=blaze, bridge=bridge, lamps=lamps)


# ---------------------------------------------------------------- decoration
def grow(cells_ok, seed, size, rng, taken):
    """A blob of up to `size` cells grown from seed through cells_ok."""
    H, W = cells_ok.shape
    out = [seed]; taken[seed[1], seed[0]] = True
    while len(out) < size:
        cand = [(xx, yy) for x, y in out for xx, yy in neighbours(x, y)
                if 0 <= xx < W and 0 <= yy < H and cells_ok[yy, xx] and not taken[yy, xx]]
        if not cand:
            break
        c = cand[rng.randint(len(cand))]
        taken[c[1], c[0]] = True
        out.append(c)
    return out


def n_parts(kind):
    return len(components(kind == FLOOR_K)[1])


def walk_ok(kind, before):
    """Whether a change kept the walkable network in one piece (no more separate parts than before)."""
    return n_parts(kind) <= before


def decorate(g):
    kind, look, biome, rng = g['kind'], g['look'], g['biome'], g['rng']
    H, W = kind.shape
    ys, xs = np.mgrid[0:H, 0:W]
    ax, ay = g['arrival']
    keep = g['fort']['keep']
    near_arrival = np.hypot(xs - ax, ys - ay) < 14
    blocks = []                      # (x, y, record) placed on a new world

    # ---- the portal Steve arrives through: a ring of obsidian around a 2x3 lit interior
    px, py = ax - 1, ay - 2          # ring top-left
    ring, inner = [], []
    for y in range(py, py + 5):
        for x in range(px, px + 4):
            if px < x < px + 3 and py < y < py + 4:
                inner.append((x, y)); kind[y, x] = PORTAL; look[y, x] = 'portal'
            else:
                ring.append((x, y)); kind[y, x] = WALL; look[y, x] = 'obsidian'
    keep[py:py + 5, px:px + 4] = True
    # Steve arrives standing in the portal (as in Minecraft) and steps out south onto the path
    arrive = dict(x=px + 1, y=py + 3, dir='down')
    step_out = (px + 1, py + 5)

    # ---- lava pools in the wastes, never cutting the network in two
    d_wall = dist_to(kind != FLOOR_K)
    pools, tries, centres = 0, 0, []
    order = list(zip(*np.nonzero((kind == FLOOR_K) & (biome == 'W') & (d_wall >= 3) & ~near_arrival & ~keep)))
    rng.shuffle(order)
    for (y, x) in order:
        if pools >= 6 or tries > 60:
            break
        if any(abs(py - y) + abs(px - x) < 16 for px, py in centres):
            continue
        tries += 1
        r = 1.6 + rng.rand() * 1.8
        n = value_noise(rng, H, W, 3)
        blob = (np.hypot((xs - x) / r, (ys - y) / (r * 0.8)) + (n - 0.5) * 0.7 < 1.0) & (kind == FLOOR_K) & (biome == 'W')
        if blob.sum() < 5:
            continue
        old = kind[blob].copy()
        before = n_parts(kind)
        kind[blob] = LAVA
        if walk_ok(kind, before):
            pools += 1; centres.append((x, y))
        else:
            kind[blob] = old
    g['pools'] = pools

    # ---- netherrack pillars standing in the wide caverns
    d_wall = dist_to(kind != FLOOR_K)
    cand = [(int(x), int(y)) for y, x in zip(*np.nonzero((d_wall >= 5) & (biome == 'W') & ~near_arrival & ~keep)) if x % 2 == 0 and y % 2 == 0]
    rng.shuffle(cand)
    pillars = []
    for x, y in cand:
        if len(pillars) >= 12:
            break
        if any(abs(x - px) + abs(y - py) < 11 for px, py in pillars):
            continue
        h = 2 if rng.rand() < 0.5 else 4
        w = 2 if h == 4 or rng.rand() < 0.6 else 4
        sl = (slice(y, y + h), slice(x, x + w))
        if not (kind[sl] == FLOOR_K).all():
            continue
        before = n_parts(kind)
        kind[sl] = WALL; look[sl] = 'netherrack'
        if walk_ok(kind, before):
            pillars.append((x, y))
        else:
            kind[sl] = FLOOR_K
    g['pillars'] = len(pillars)

    # ---- magma beside the lava, and patches of soul sand in the wastes
    d_lava = dist_to(kind == LAVA)
    ph = value_noise(rng, H, W, 2)
    wf = (kind == FLOOR_K) & (biome == 'W') & ~keep & ~near_arrival
    look[wf & (d_lava == 1) & (ph > 0.55)] = 'magma_block'
    sp = fbm(rng, H, W, (7, 3), (0.7, 0.3))
    patch = wf & (sp > 0.76) & (d_lava > 2)
    lab, sizes = components(patch)
    for k, n in enumerate(sizes):
        if n >= 10:                     # only real patches, no specks
            look[lab == k] = 'soul_sand'

    # ---- the valley: soul soil mounds and bone block fossils
    vf = (kind == FLOOR_K) & (biome == 'V')
    mound = up2(fbm(rng, H // 2, W // 2, (4, 2), (0.65, 0.35)) > 0.62)
    d_vwall = dist_to(~vf)
    m = vf & mound & (d_vwall >= 3)
    before = n_parts(kind)
    kind[m] = WALL; look[m] = 'soul_soil'
    if not walk_ok(kind, before):
        kind[m] = FLOOR_K; look[m] = 'soul_soil'
    fossils, bones = place_fossils(kind, look, biome, rng)

    # ---- one tidy pass more so the new walls follow the same rules (the fossils keep their ribs)
    tidy(kind, look, biome, keep | bones)

    # ---- glowstone on wall cells beside open ground (it hangs from the ceilings in Minecraft)
    open_ = kind != WALL
    nr = (kind == WALL) & (look == 'netherrack') & ~keep
    edge_wall = nr & (dist_to(open_) == 1)
    near_open = nr & (dist_to(open_) <= 2)
    taken = np.zeros((H, W), bool)
    seeds = list(zip(*np.nonzero(edge_wall & (xs > 3) & (ys > 3) & (xs < W - 4) & (ys < H - 4))))
    rng.shuffle(seeds)
    glow = 0
    for (y, x) in seeds[:30]:
        if taken[y, x]:
            continue
        for cx, cy in grow(near_open, (x, y), 2 + rng.randint(3), rng, taken):
            look[cy, cx] = 'glowstone'; glow += 1

    # ---- ores: quartz and gold veins in netherrack, ancient debris deep inside the walls
    inner_wall = (kind == WALL) & (look == 'netherrack') & ~keep & (xs >= 2) & (ys >= 2) & (xs < W - 2) & (ys < H - 2)
    depth = dist_to(kind != WALL)
    ores = {'nether_quartz_ore': 0, 'nether_gold_ore': 0, 'ancient_debris': 0}
    for (y, x) in zip(*np.nonzero(inner_wall)):
        if look[y, x] != 'netherrack':
            continue
        r = h01(int(x), int(y), 41)
        if r < 0.0042:
            ore, size = 'nether_quartz_ore', 3 + int(h01(int(x), int(y), 42) * 5)
        elif r < 0.0062:
            ore, size = 'nether_gold_ore', 2 + int(h01(int(x), int(y), 43) * 4)
        elif r < 0.0092 and depth[y, x] >= 3:
            ore, size = 'ancient_debris', 1 + int(h01(int(x), int(y), 44) * 2)
        else:
            continue
        ok = inner_wall & (look == 'netherrack')
        if ore == 'ancient_debris':
            ok &= depth >= 3
        for cx, cy in grow(ok, (int(x), int(y)), size, rng, np.zeros((H, W), bool)):
            look[cy, cx] = ore; ores[ore] += 1
    # the veins above leave only a handful of debris in a region this small: more single blocks deep in the
    # walls, at least 7 cells from any other, until there is enough for full netherite armor and a tool or two
    # (an ingot is 4 scrap, a piece of armor one ingot). Hashed, so the rng (and all that follows) is unchanged,
    # and only after the first vein in row order, so the atlas entries keep their numbers (saves store them).
    # Each one can be dug to from the arrival without crossing lava (some corners are cut off by the lava sea).
    have = [(int(x), int(y)) for y, x in zip(*np.nonzero(look == 'ancient_debris'))]
    first = min(((y, x) for x, y in have), default=(-1, -1))
    diggable = (kind != LAVA) & (xs >= 2) & (ys >= 2) & (xs < W - 2) & (ys < H - 2)
    for x, y in ring:
        diggable[y, x] = False
    reach = np.zeros((H, W), bool); reach[step_out[1], step_out[0]] = True
    dq = deque([step_out])
    while dq:
        x, y = dq.popleft()
        for xx, yy in neighbours(x, y):
            if 0 <= xx < W and 0 <= yy < H and diggable[yy, xx] and not reach[yy, xx]:
                reach[yy, xx] = True; dq.append((xx, yy))
    cand = sorted((h01(int(x), int(y), 46), int(x), int(y)) for y, x in zip(*np.nonzero(inner_wall & (look == 'netherrack') & (depth >= 3) & reach)) if (int(y), int(x)) > first)
    for _, x, y in cand:
        if ores['ancient_debris'] >= DEBRIS_MIN:
            break
        if any(abs(x - hx) + abs(y - hy) < 7 for hx, hy in have):
            continue
        look[y, x] = 'ancient_debris'; ores['ancient_debris'] += 1; have.append((x, y))

    # ---- fire on the netherrack, soul fire in the valley, nether wart in the fortress garden
    fl = (kind == FLOOR_K) & ~keep
    plain = fl & (look == 'netherrack') & (biome == 'W') & ~near_arrival & (dist_to(kind == LAVA) > 1)
    cand = list(zip(*np.nonzero(plain)))
    rng.shuffle(cand)
    fires = 0
    for (y, x) in cand[:14]:
        for cx, cy in grow(plain, (int(x), int(y)), 1 + rng.randint(3), rng, np.zeros((H, W), bool)):
            blocks.append((cx, cy, {'id': 'fire', 'walk': True})); fires += 1
    soul = list(zip(*np.nonzero(fl & (look == 'soul_soil') & (biome == 'V'))))
    rng.shuffle(soul)
    for (y, x) in soul[:max(6, len(soul) // 40)]:
        blocks.append((int(x), int(y), {'id': 'soul_fire', 'walk': True}))
    for x, y in g['fort']['warts']:
        blocks.append((x, y, {'id': 'nether_wart', 'stage': 1 + int(h01(x, y, 51) * 2), 'walk': True}))
    for k, (x, y) in enumerate(g['fort']['chests']):
        blocks.append((x, y, {'id': 'chest', 'slots': chest_loot(k)}))
    g.update(blocks=blocks, ring=ring, inner=inner, arrive=arrive, step_out=step_out, glow=glow, ores=ores, fires=fires, fossils=fossils)
    return g


# Fortress chest loot (Minecraft's nether_bridge table, without the saddle): gold, iron, diamonds,
# obsidian, flint and steel, a golden sword and a golden apple
LOOT = [
    [('gold_ingot', 5), ('iron_ingot', 4), ('diamond', 2), ('flint_and_steel', 1), ('obsidian', 4), ('golden_apple', 1)],
    [('gold_ingot', 3), ('diamond', 1), ('obsidian', 6), ('golden_sword', 1), ('iron_ingot', 6), ('nether_wart', 3)],
]


def chest_loot(k):
    slots = [None] * 27
    for i, (id, n) in enumerate(LOOT[k % len(LOOT)]):
        slot = (i * 5 + 3 * k + 2) % 27
        while slots[slot] is not None:
            slot = (slot + 1) % 27
        slots[slot] = {'id': id, 'n': n}
    return slots


# A fossil from above: a bone block spine with ribs.
FOSSILS = [
    ["b.b.b.b",
     "bbbbbbb",
     "b.b.b.b"],
    [".b.",
     "bbb",
     ".b.",
     "bbb",
     ".b.",
     "bbb"],
    ["bb.bb",
     "..b..",
     "bbbbb",
     "..b..",
     "bb.bb"],
]


def place_fossils(kind, look, biome, rng):
    H, W = kind.shape
    vf = (kind == FLOOR_K) & (biome == 'V')
    clear = dist_to(~vf)
    placed = []
    bones = np.zeros((H, W), bool)
    cand = list(zip(*np.nonzero(clear >= 4)))
    rng.shuffle(cand)
    for (y, x) in cand:
        if len(placed) >= 5:
            break
        if any(abs(x - px) + abs(y - py) < 12 for px, py in placed):
            continue
        pat = FOSSILS[len(placed) % len(FOSSILS)]
        h, w = len(pat), len(pat[0])
        x0, y0 = int(x) - w // 2, int(y) - h // 2
        cells = [(x0 + c, y0 + r) for r in range(h) for c in range(w) if pat[r][c] == 'b']
        if not all(vf[cy, cx] for cx, cy in cells):
            continue
        old = [(cx, cy, kind[cy, cx], look[cy, cx]) for cx, cy in cells]
        before = n_parts(kind)
        for cx, cy in cells:
            kind[cy, cx] = WALL; look[cy, cx] = 'bone_block'
        if walk_ok(kind, before):
            placed.append((int(x), int(y)))
            for cx, cy in cells:
                bones[cy, cx] = True
        else:
            for cx, cy, k0, l0 in old:
                kind[cy, cx] = k0; look[cy, cx] = l0
    return placed, bones


# ---------------------------------------------------------------- tiles for the cells
def wall_key(kind, x, y):
    H, W = kind.shape
    def op(xx, yy):
        return bool(0 <= xx < W and 0 <= yy < H and kind[yy, xx] != WALL)
    k = (op(x, y - 1) and 1) | (op(x + 1, y) and 2) | (op(x, y + 1) and 4) | (op(x - 1, y) and 8)
    k |= (op(x + 1, y - 1) and 16) | (op(x + 1, y + 1) and 32) | (op(x - 1, y + 1) and 64) | (op(x - 1, y - 1) and 128)
    return canon(k)


def variant(x, y, n):
    return int(h01(x, y, 7) * n)


def assign(g, T):
    """Atlas index, ground (what a mined cell becomes) and protection of every cell of the region."""
    kind, look = g['kind'], g['look']
    H, W = kind.shape
    grid = np.zeros((H, W), np.int32)
    ground = np.zeros((H, W), np.int32)
    for y in range(H):
        for x in range(W):
            k, l = kind[y, x], look[y, x]
            nk = kind[y - 1, x] if y > 0 else WALL
            if k == WALL:
                grid[y, x] = T.wall(l, wall_key(kind, x, y), variant(x, y, 4))
                gl = {'soul_soil': 'soul_soil', 'bone_block': 'soul_soil', 'nether_bricks': 'brick_floor'}.get(l, 'floor')
                ground[y, x] = T.floor(gl, 0, variant(x, y, 8))
            elif k == FLOOR_K:
                grid[y, x] = T.floor('floor' if l == 'netherrack' else l, int(nk == WALL), variant(x, y, 8))
                ground[y, x] = T.floor('brick_floor' if l == 'brick_floor' else 'floor', int(nk == WALL), variant(x, y, 8))
            elif k == LAVA:
                op = lambda xx, yy: bool(not (0 <= xx < W and 0 <= yy < H) or kind[yy, xx] != LAVA)
                key = (op(x, y - 1) and 1) | (op(x + 1, y) and 2) | (op(x, y + 1) and 4) | (op(x - 1, y) and 8)
                lip = LIP_OF.get(look[y - 1, x] if y > 0 else 'netherrack', 'netherrack') if key & 1 else 'netherrack'
                grid[y, x] = ground[y, x] = T.lava(lip, key)
            elif k == PORTAL:
                grid[y, x] = ground[y, x] = T.portal()
            elif k == FENCE:
                def c(xx, yy):
                    return bool(0 <= xx < W and 0 <= yy < H and (kind[yy, xx] == FENCE or (kind[yy, xx] == WALL and look[yy, xx] == 'nether_bricks')))
                conn = (c(x, y - 1) and 1) | (c(x + 1, y) and 2) | (c(x, y + 1) and 4) | (c(x - 1, y) and 8)
                grid[y, x] = T.fence(conn)
                ground[y, x] = T.floor('brick_floor', 0, variant(x, y, 2))
    prot = np.zeros((H, W), np.uint8)
    ys, xs = np.mgrid[0:H, 0:W]
    prot[(xs < 2) | (ys < 2) | (xs >= W - 2) | (ys >= H - 2)] = 3      # the edge: nothing digs out of the Nether
    for x, y in g['ring']:
        prot[y, x] = 1                                                    # the return portal's frame
    for x, y in g['inner']:
        prot[y, x] = 3
    return grid, ground, prot


def preview(entries, grid, scale=1):
    H, W = grid.shape
    out = np.zeros((H * 16, W * 16, 4), np.uint8)
    for y in range(H):
        for x in range(W):
            e = entries[grid[y, x]]
            t = e['below'].copy()
            m = e['above'][:, :, 3:4].astype(np.float64) / 255.0
            t[:, :, :3] = (t[:, :, :3] * (1 - m) + e['above'][:, :, :3] * m).astype(np.uint8)
            out[y * 16:y * 16 + 16, x * 16:x * 16 + 16] = t
    im = Image.fromarray(out, 'RGBA')
    return im.resize((im.width * scale, im.height * scale), Image.NEAREST) if scale != 1 else im


def draw_blocks(im, blocks, x0=0, y0=0):
    """The pre-placed blocks over a preview, from the block looks in assets/mc/blocks.png (left out until
    tools/build_minecraft.py has written them: on a fresh tree build_world.py runs first)."""
    if not (HERE / 'assets/mc/items.json').exists() or not (HERE / 'assets/mc/blocks.png').exists():
        return im
    items = json.load(open(HERE / 'assets/mc/items.json'))
    sheet = Image.open(HERE / 'assets/mc/blocks.png').convert('RGBA')
    for x, y, rec in blocks:
        key = rec['id'] if rec['id'] != 'nether_wart' else f"nether_wart:{rec.get('stage', 2)}"
        l = items['blocks'].get(key)
        if l is None:
            continue
        cell = sheet.crop(((l % 32) * 16, (l // 32) * 24, (l % 32) * 16 + 16, (l // 32) * 24 + 24))
        im.alpha_composite(cell, ((x - x0) * 16, (y - y0) * 16 - 8))
    return im


def build(entries, pair):
    """Generate the region and its atlas entries. Returns the region's arrays and what world.json needs."""
    g = decorate(generate())
    T = Tiles(entries, pair)
    first = len(entries)
    grid, ground, prot = assign(g, T)
    T.complete()
    return g, T, grid, ground, prot, first


# ---------------------------------------------------------------- what world.json carries
def mat_spec(id, **over):
    """A world material from the block's own rules in tools/mcdata.py (drop, hardness, tool, sound...)."""
    b = D.ITEMS[id]['block']
    spec = dict(drop=b.get('drop', id), hard=b['hard'])
    for k in ('tool', 'need', 'sound', 'dropN', 'dropMax', 'xp', 'light', 'slow', 'hurt'):
        if b.get(k) is not None:
            spec[k] = b[k]
    spec.update(over)
    return spec


# Materials of the Nether's world tiles, added to world.json's materials after Kanto's. Floors of plain
# netherrack and of the fortress are the ordinary 'floor'; soul sand, soul soil and magma floors can be dug
# up (a shovel, or a pickaxe for magma) and leave netherrack ground behind.
MATERIALS = {
    **{id: mat_spec(id) for id in ('netherrack', 'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris', 'glowstone',
                                   'nether_bricks', 'obsidian', 'soul_sand', 'soul_soil', 'bone_block', 'magma_block')},
    'nether_brick_fence': dict(drop='nether_bricks', hard=2.0, tool='pickaxe', need=1, sound='nether_bricks'),
    'lava': dict(hard=-1, light=15, liquid=True),
    'nether_portal': dict(hard=-1, light=11, walk=True),
}
# Nether mobs by zone (biome letters): the runtime spawns from these, with caps like the overworld's
SPAWNS = {'W': ['zombified_piglin', 'zombified_piglin', 'magma_cube', 'ghast'], 'V': ['skeleton', 'ghast'], 'L': ['ghast'],
          'F': ['wither_skeleton', 'wither_skeleton', 'zombified_piglin'], 'B': ['blaze']}


def attach(entries, pair, ox, oy, map_index):
    """Generate the Nether, append its atlas entries, and return its arrays (NH x NW) and world.json's
    'nether' section, in world cells (the region's top-left corner at ox, oy)."""
    g, T, grid, ground, prot, first = build(entries, pair)
    H, W = grid.shape
    WW = None
    cell = lambda x, y: [x + ox, y + oy]
    lights = []
    kind, look = g['kind'], g['look']
    for y in range(H):
        for x in range(W):
            k, l = kind[y, x], look[y, x]
            L = 0
            if k == WALL and l == 'glowstone':
                L = 15
            elif k == PORTAL:
                L = 11
            elif k == LAVA and any(0 <= xx < W and 0 <= yy < H and kind[yy, xx] != LAVA for xx, yy in neighbours(x, y)):
                L = 15              # the shore glows; the middle of a lake adds nothing the shore doesn't
            elif k == FLOOR_K and l == 'magma_block':
                L = 3
            if L:
                lights.append(cell(x, y) + [L])
    wall, floor, lava, fence = {}, {}, {}, {}
    for i, (kd, mat, key, v) in T.info.items():
        if kd == 'wall':
            wall.setdefault(mat, {}).setdefault(str(key), {})[v] = i
        elif kd == 'floor':
            floor.setdefault(mat, {}).setdefault(str(key), {})[v] = i
        elif kd == 'lava':
            lava.setdefault(mat, {})[str(key)] = i
        elif kd == 'fence':
            fence[str(key)] = i
    as_list = lambda d: {m: {k: [vv[j] for j in sorted(vv)] for k, vv in ks.items()} for m, ks in d.items()}
    meta = {
        'x': ox, 'y': oy, 'w': W, 'h': H, 'map': map_index, 'pair': pair, 'first': first, 'count': len(entries) - first,
        'arrival': dict(x=g['arrive']['x'] + ox, y=g['arrive']['y'] + oy, dir=g['arrive']['dir']),
        'stepOut': cell(*g['step_out']),
        'portal': {'ring': [cell(x, y) for x, y in g['ring']], 'cells': [cell(x, y) for x, y in g['inner']]},
        'blocks': [cell(x, y) + [rec] for x, y, rec in g['blocks']],
        'chests': [cell(x, y) for x, y in g['fort']['chests']],
        # the keep's glowstone lamps: placed blocks like 'blocks', listed apart so a save seeded before they
        # existed gets just these
        'lamps': [cell(x, y) + [{'id': 'glowstone'}] for x, y in g['fort']['lamps']],
        'lights': lights,
        'biome': [''.join(r) for r in g['biome']],
        'biomes': {'W': 'nether_wastes', 'V': 'soul_sand_valley', 'L': 'lava_sea', 'F': 'nether_fortress', 'B': 'blaze_platform'},
        'spawns': SPAWNS,
        # tiles, for re-edging a mined cell and its neighbours (keys as in tools/build_nether.py's docstring)
        'tiles': {str(i): v for i, v in sorted(T.info.items())},
        'wall': as_list(wall), 'floor': as_list(floor), 'lava': lava, 'fence': fence, 'portalTile': T.portal(),
        'lipOf': LIP_OF, 'floorLook': {'soul_soil': 'soul_soil', 'bone_block': 'soul_soil', 'nether_bricks': 'brick_floor'},
        'stats': {'pools': g['pools'], 'glowstone': g['glow'], 'ores': g['ores'], 'fires': g['fires'], 'fossils': len(g['fossils']),
                  'pillars': g['pillars']},
    }
    meta = json.loads(json.dumps(meta, default=lambda o: o.item()))     # numpy scalars to plain numbers
    return g, grid, ground, prot, meta


# ---------------------------------------------------------------- lava pools in the deep caves
POOL_MAPS = ['MAP_VICTORY_ROAD_3F', 'MAP_CERULEAN_CAVE_B1F', 'MAP_MT_MOON_B2F', 'MAP_ROCK_TUNNEL_B1F']


def cave_pools(maps, entries, grid, col, beh, warps, npcs, water, trig):
    """A 3x3 (or 2x3) lava pool in each of the four deep caves, as pre-placed blocks: on plain floor away
    from warps, people and the paths between the warps, and without cutting off any floor Steve could
    reach before. Returns world.json's lava list [{x, y, map}]."""
    out = []
    for mid in POOL_MAPS:
        m = next(mm for mm in maps if mm['id'] == mid)
        x0, y0, w, h = m['x'], m['y'], m['w'], m['h']
        sub = lambda a: a[y0:y0 + h, x0:x0 + w]
        g = sub(grid)
        walk = (sub(col) == 0) & ~np.isin(sub(beh), sorted(water | set(trig)))
        e_floor = np.array([[entries[t]['mat'] == 'floor' and not entries[t]['above'][:, :, 3].any() and entries[t]['beh'] in (0, 0x08)
                             for t in row] for row in g])
        ws = [(wp['x'] - x0, wp['y'] - y0) for wp in warps if wp['map'] == mid]
        people = [(n['x'] - x0, n['y'] - y0) for n in npcs if n['map'] == mid]
        # every warp's arrival cell and the warps themselves
        avoid = np.zeros((h, w), bool)
        for wx, wy in ws:
            avoid[max(0, wy - 3):wy + 4, max(0, wx - 3):wx + 4] = True
        for px, py in people:
            avoid[max(0, py - 2):py + 3, max(0, px - 2):px + 3] = True
        # the paths: shortest walks between every pair of warps
        def bfs(src, ok):
            d = np.full((h, w), -1, np.int32); prev = {}
            dq = deque([src]); d[src[1], src[0]] = 0
            while dq:
                x, y = dq.popleft()
                for xx, yy in neighbours(x, y):
                    if 0 <= xx < w and 0 <= yy < h and d[yy, xx] < 0 and (ok[yy, xx] or (xx, yy) in ws):
                        d[yy, xx] = d[y, x] + 1; prev[(xx, yy)] = (x, y); dq.append((xx, yy))
            return d, prev
        path = np.zeros((h, w), bool)
        for a in ws:
            d, prev = bfs(a, walk)
            for b in ws:
                c = b
                while c in prev:
                    path[c[1], c[0]] = True; c = prev[c]
        d_path = dist_to(path)
        near_path = d_path <= 2
        def reach(ok):
            r = np.zeros((h, w), bool)
            for a in ws:
                if not r[a[1], a[0]]:
                    r |= bfs(a, ok)[0] >= 0
            return r
        r0 = reach(walk)
        best = None
        for ph, pw in ((3, 3), (2, 3), (3, 2)):
            for y in range(1, h - ph):
                for x in range(1, w - pw):
                    sl = (slice(y, y + ph), slice(x, x + pw))
                    ring = (slice(y - 1, y + ph + 1), slice(x - 1, x + pw + 1))
                    if not (e_floor[sl].all() and walk[sl].all()) or avoid[sl].any() or near_path[sl].any():
                        continue
                    if not walk[ring].sum() >= 2 * (ph + pw):
                        continue        # open ground round it, so Steve can stand beside it
                    if not r0[sl].all():
                        continue        # on floor Steve can get to
                    ok = walk.copy(); ok[sl] = False
                    r1 = reach(ok)
                    r1[sl] = True
                    if (r1 != r0).any():
                        continue        # it would cut something off
                    # prefer the pool furthest from the paths and warps (a find, not an obstacle)
                    score = (ph * pw, float(d_path[sl].min()), -abs(x - w / 2) - abs(y - h / 2))
                    if best is None or score > best[0]:
                        best = (score, x, y, ph, pw)
            if best:
                break
        if not best:
            print(f'  lava pool: no room in {mid}')
            continue
        _, x, y, ph, pw = best
        cells = [dict(x=x0 + x + dx, y=y0 + y + dy, map=mid) for dy in range(ph) for dx in range(pw)]
        out += cells
        print(f'  lava pool {pw}x{ph} in {mid} at {x0 + x},{y0 + y}')
    return out


if __name__ == '__main__':
    out = Path(sys.argv[1] if len(sys.argv) > 1 else HERE / 'out' / 'nether_preview.png')
    entries = []
    g, T, grid, ground, prot, first = build(entries, 0)
    print(f"entries {len(entries)}; pools {g['pools']}, glowstone {g['glow']}, ores {g['ores']}, fires {g['fires']}, "
          f"fossils {len(g['fossils'])}, chests {len(g['fort']['chests'])}, warts {len(g['fort']['warts'])}")
    im = preview(entries, grid)
    draw_blocks(im, g['blocks'] + [(x, y, {'id': 'glowstone'}) for x, y in g['fort']['lamps']])
    im.save(out)
