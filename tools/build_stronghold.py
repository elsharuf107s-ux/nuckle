#!/usr/bin/env python3
"""The stronghold: a generated region appended below the Nether (a stage of tools/build_world.py).

One map entry, MAP_STRONGHOLD (banner "STRONGHOLD"), 96x72 cells, drawn with its own atlas entries made from
Minecraft 1.21.4's textures the way tools/build_nether.py draws the Nether: 16-px top-down tiles, a wall that has
open ground to the south shows a front face. Stone-brick walls are tall: a wall two cells deep shows a face two
cells high (the upper cell keeps a lit rim of the wall's top), so rooms read like FireRed's interiors.

The layout is fixed (the rooms below), the details come from a fixed seed: the stronghold is carved out of solid
stone (with coal, iron, gold, redstone and lapis veins), and every corridor and room is lined with stone bricks,
mixed normal, mossy and cracked, some of them infested with silverfish (they look exactly like the real ones).
  - the entrance stair room: a stone-brick stairway up to Route 23 (the warp), arrival on its top step;
  - a five-way crossing with pillars, a dead-end passage north of it;
  - a library: bookshelf walls and rows, an oak-plank gallery round the edge, cobwebs, two chests;
  - a prison corridor with four cells behind iron bars;
  - a fountain room (a stone-brick fountain in a water basin) and a second crossing;
  - two storerooms with a chest each, and dead ends;
  - the portal room: stairs up from its door, a silverfish spawner on the landing, and the twelve end portal
    frames (two already holding an eye) in a ring around a 3x3 lava pool, eye sockets facing in.
Wall torches on the faces light it; it is otherwise as dark as a cave.

Route 23's entrance is part of this stage too: one cracked stone bricks tile set among the boulders below
Victory Road (ENTRANCE), whose ground (what mining it leaves) is a stone-brick stairway down. Its warp leads to
the stair room's top step, and the three top steps lead back.

Keys (as tools/build_nether.py's, so the runtime can re-edge a mined wall): a wall's open mask N=1 E=2 S=4 W=8,
corners NE=16 SE=32 SW=64 NW=128 (canon()), plus UPPER=256 when the cell to the south is a wall whose own south is
open: this cell is the upper half of a two-high face. A wall with S open and N wall is the lower half (its whole
cell is face). Floors are keyed by a wall to the north (a contact shadow, 0 or 1).

world.json 'stronghold' (world cells): x, y, w, h, map, pair, first, count; entrance {x, y} (Route 23's cell) and
entranceTiles {closed, open}; stairs (the warp cells) and arrival {x, y, dir}; blocks [[x, y, record]] to place on a
new world (chests with loot, cobwebs, iron bars, the spawner, the lava pool, the twelve portal frames); chests;
frames [[x, y, facing, eye]] (facing: the side the socket faces, toward the centre); portal {centre (9 cells),
lava (the pool cells)}; spawner [x, y]; lights [[x, y, level]] (the wall torches); rooms {name: [x, y, w, h]};
tiles {entry: [kind, mat, key, variant]}; wall {mat: {key: [entry per variant]}}; floor {look: {shadow: [entries]}};
water {key: entry}; floorLook (the floor a mined wall of that material leaves).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import build_nether as BN  # noqa: E402
from build_nether import tex, rgb, pack, grade, turn, soften, canon, h01, dist_to, components, neighbours  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
SW, SH = 96, 72
GUTTER = 8
SEED = 1986
MAP_ID = 'MAP_STRONGHOLD'
OUTLINE = np.array((18, 18, 22), np.uint8)
UPPER = 256

# Route 23: the cracked stone bricks block among the boulders below Victory Road's cliff, off the main path
# (world cells; the cell south of it is open grass, where Steve steps out)
ENTRANCE = (13, 76)

# ---------------------------------------------------------------- looks
# wall material -> (top texture, side texture, bricks keep level courses, top gain, top lift)
WALL_LOOK = {
    'stone': ('stone', 'stone', False, 0.56, 0),
    'coal_ore': ('coal_ore', 'coal_ore', False, 0.62, 0),
    'iron_ore': ('iron_ore', 'iron_ore', False, 0.62, 0),
    'gold_ore': ('gold_ore', 'gold_ore', False, 0.62, 0),
    'redstone_ore': ('redstone_ore', 'redstone_ore', False, 0.62, 0),
    'lapis_ore': ('lapis_ore', 'lapis_ore', False, 0.62, 0),
    'stone_bricks': ('stone_bricks', 'stone_bricks', True, 1.22, 8),
    'mossy_stone_bricks': ('mossy_stone_bricks', 'mossy_stone_bricks', True, 1.22, 8),
    'cracked_stone_bricks': ('cracked_stone_bricks', 'cracked_stone_bricks', True, 1.22, 8),
    'chiseled_stone_bricks': ('chiseled_stone_bricks', 'chiseled_stone_bricks', True, 1.22, 8),
    'bookshelf': ('oak_planks', 'bookshelf', True, 1.12, 6),
    'wall_torch': ('stone_bricks', 'stone_bricks', True, 1.22, 8),
}
for _m in ('stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks'):
    WALL_LOOK['infested_' + _m] = WALL_LOOK[_m]
WALL_VARIANTS = {'stone': 4}
ORES = ('coal_ore', 'iron_ore', 'gold_ore', 'redstone_ore', 'lapis_ore')
# floor look -> (texture, variants, rotate)
FLOOR_LOOK = {'stone_bricks': ('stone_bricks', 2, False), 'mossy_stone_bricks': ('mossy_stone_bricks', 2, False),
              'cracked_stone_bricks': ('cracked_stone_bricks', 2, False), 'oak_planks': ('oak_planks', 2, False),
              'cobblestone': ('cobblestone', 4, True), 'stone': ('stone', 4, True)}
# the floor a mined wall leaves
FLOOR_OF = {'stone': 'stone', 'bookshelf': 'oak_planks', **{o: 'stone' for o in ORES}}

FACE_TOP, FACE_BOTTOM = 0.84, 0.46
RIM = 4
BLANK = np.zeros((16, 16, 4), np.uint8)


def top_of(mat, v, look=WALL_LOOK):
    t = tex(look[mat][0])
    if look[mat][2]:
        return rgb(t[:, ::-1] if v % 2 and mat == 'bookshelf' else t)
    return soften(rgb(turn(t, v)), 0.4)


def side_of(mat, v, look=WALL_LOOK):
    return rgb(tex(look[mat][1]))


def face_block(mat, v, total, look=WALL_LOOK):
    """The whole face of a wall `total` rows high (darkening downwards), as an array total x 16 x 3."""
    _, _, brick, gain, lift = look[mat]
    side = grade(side_of(mat, v, look), gain=gain * 0.95, sat=1.0, lift=lift * 0.5)
    r = np.arange(total)
    if brick:
        face = side[r % 16]
    else:
        # rock strata: the texture smeared downwards, its columns lit unevenly
        idx = (r * 5 // max(12, total) + v * 4) % 16
        face = side[idx] * 0.55 + side[(idx + 8) % 16] * 0.45
        col = side.mean(axis=(0, 2))
        stripes = 1 + 0.32 * (col - col.mean()) / (col.std() + 1e-6)
        face = face * np.clip(stripes, 0.7, 1.35)[None, :, None]
    k = np.linspace(FACE_TOP, FACE_BOTTOM, total)[:, None, None]
    return face * k


def torch_on(f, x0=6, y0=3):
    """A wall torch on a face: the stick angled out of the wall, the flame, a warm glow on the bricks."""
    t = tex('torch').astype(np.float64)
    yy, xx = np.mgrid[0:16, 0:16]
    d = np.hypot(xx - (x0 + 2), yy - (y0 + 1))
    glow = np.clip(1 - d / 7.5, 0, 1)[:, :, None]
    f[:] = f * (1 + 0.55 * glow) + np.array([60, 36, 8]) * glow
    # the torch texture's stick and flame (columns 7..8, rows 6..15), shortened to 9 rows
    src = t[6:16, 7:9]
    for i in range(10):
        for j in range(2):
            if src[i, j, 3] > 0:
                yy_, xx_ = y0 + i, x0 + 1 + j + (1 if i > 5 else 0)
                if 0 <= yy_ < 16 and 0 <= xx_ < 16:
                    f[yy_, xx_] = src[i, j, :3]
    f[y0 + 10:y0 + 11, x0 + 2:x0 + 4] = OUTLINE        # the bracket
    return f


def wall_tile(mat, key, v, look=WALL_LOOK, outline=OUTLINE, face_rows=None):
    """A wall cell by its key (module docstring). face_rows: (face of a single wall, of a two-high wall) builders,
    defaulting to face_block."""
    n, e, s, w = key & 1, key & 2, key & 4, key & 8
    ne, se, sw, nw = key & 16, key & 32, key & 64, key & 128
    up = key & UPPER
    lower = s and not n
    _, _, brick, gain, lift = look[mat]
    top = grade(top_of(mat, v, look), gain=gain, sat=1.0, lift=lift)
    f = top.copy()
    fb = face_rows or (lambda m, vv, total: face_block(m, vv, total, look))
    if up:
        face = fb(mat, v, 28)
        f[RIM:] = face[:16 - RIM]
        f[RIM - 1] = np.clip(top[RIM - 1] + 40, 0, 255)
        f[RIM] = f[RIM] * 0.62
    elif lower:
        face = fb(mat, v, 28)
        f[:] = face[16 - RIM:]
        f[15] = outline * 1.1
    elif s:
        face = fb(mat, v, 12)
        f[RIM:] = face
        f[RIM - 1] = np.clip(top[RIM - 1] + 40, 0, 255)
        f[RIM] = f[RIM] * 0.62
        f[15] = outline * 1.1
    if mat == 'wall_torch' and s:
        torch_on(f, 6, 1 if lower else RIM + 1)
    if n:
        f[0] = outline
        f[1] = np.clip(f[1] + 28, 0, 255)
    if w:
        f[:, 0] = outline
        f[1:, 1] *= 0.82
    if e:
        f[:, 15] = outline
        f[1:, 14] *= 0.76
    if n and w:
        f[1, 1] = outline
    if n and e:
        f[1, 14] = outline
    if s and w:
        f[14, 1] = outline
    if s and e:
        f[14, 14] = outline
    if nw:
        f[0, 0] = outline; f[0, 1] *= 0.7; f[1, 0] *= 0.7
    if ne:
        f[0, 15] = outline; f[0, 14] *= 0.7; f[1, 15] *= 0.7
    if sw:
        f[15, 0] = outline; f[15, 1] *= 0.7; f[14, 0] *= 0.7
    if se:
        f[15, 15] = outline; f[15, 14] *= 0.7; f[14, 15] *= 0.7
    return pack(f)


def floor_tile(look, shadow, v):
    name, _, rot = FLOOR_LOOK[look]
    t = tex(name)
    if rot:
        t = turn(t, v)
    elif look == 'oak_planks':
        t = t[:, ::-1] if v % 2 else t
    else:
        t = np.rot90(t, 1 + 2 * (v % 2))          # brick floors run north-south: they never read as a wall's face
    t = rgb(t)
    if look == 'oak_planks':
        f = grade(t, gain=0.9, sat=0.9, lift=2, contrast=0.8)
    elif look == 'stone':
        f = grade(soften(t, 0.4), gain=0.74, sat=0.9, lift=0, contrast=0.7)
    elif look == 'cobblestone':
        f = grade(soften(t, 0.3), gain=0.8, sat=0.9, lift=0, contrast=0.7)
    else:
        f = grade(t, gain=0.8, sat=0.95, lift=0, contrast=0.62)
    if shadow:
        for r, k in enumerate((0.45, 0.62, 0.78, 0.9)):
            f[r] *= k
    return pack(f)


def water_tile(key):
    """Still water in the fountain's basin (the first frame of water_still in Minecraft's default water colour),
    darker under a wall to the north (key N=1)."""
    w = tex('water_still').astype(np.float64)[:, :, :3] / 255.0
    f = w * np.array([63, 118, 228]) * 1.25 + 8
    if key & 1:
        for r, k in enumerate((0.45, 0.6, 0.75, 0.88)):
            f[r] *= k
    return pack(f)


def stairs_tile(part, mode, rows_total=2, row=0):
    """Stone-brick steps seen from above. mode 'up' climbs to the north (lighter at the top), 'down' descends to
    the north into the dark (Route 23's stairway). part: 'L', 'M', 'R' or 'S' (a single stair cell with walls on
    both sides). row: which cell of a flight rows_total cells long, from the north."""
    side = rgb(tex('stone_bricks'))
    f = np.zeros((16, 16, 3))
    total = rows_total * 16
    for yy in range(16):
        g = row * 16 + yy                      # pixel row from the north end of the flight
        step = g // 4
        within = g % 4
        tt = g / max(1, total - 1)
        if mode == 'up':
            k = 1.15 - 0.45 * tt
        else:
            k = 0.3 + 0.8 * tt
        src = side[(step * 5) % 16]
        if within == 3:
            f[yy] = src * k * 0.55            # the riser below the tread
        elif within == 0:
            f[yy] = np.clip(src * k * 1.18 + 10, 0, 255)   # the tread's lit nose
        else:
            f[yy] = src * k
    if part in ('L', 'S'):
        f[:, 0] = OUTLINE; f[:, 1] *= 0.7
    if part in ('R', 'S'):
        f[:, 15] = OUTLINE; f[:, 14] *= 0.7
    return pack(f)


def stairway_tile(ground):
    """Route 23 after the cracked block is mined: a stone-brick stairway going down north, in a rim of bricks on
    the route's own grass (ground: that cell's below layer)."""
    out = ground.copy().astype(np.float64)
    steps = stairs_tile('M', 'down', 1, 0).astype(np.float64)[:, :, :3]
    brick = grade(rgb(tex('stone_bricks')), gain=1.18, lift=8)
    out[:, :, :3] = steps
    out[0:3, :, :3] = brick[0:3]
    out[:, 0:3, :3] = brick[:, 0:3]
    out[:, 13:16, :3] = brick[:, 13:16]
    out[3, 3:13, :3] *= 0.4
    out[0, :, :3] = OUTLINE
    out[:, 0, :3] = OUTLINE
    out[:, 15, :3] = OUTLINE
    out[3:, 3, :3] = OUTLINE * 1.5
    out[3:, 12, :3] = OUTLINE * 1.5
    out[:, :, 3] = 255
    return np.clip(out, 0, 255).astype(np.uint8)


def cracked_block_tile(ground):
    """The cracked stone bricks block standing among Route 23's boulders, the size of a boulder: its top above,
    the front face below, a soft shadow on the grass."""
    out = ground.copy().astype(np.float64)
    a = np.zeros((16, 16), bool)
    t = grade(rgb(tex('cracked_stone_bricks')), gain=1.25, lift=10)
    s = grade(rgb(tex('cracked_stone_bricks')), gain=0.95, lift=2)
    # shadow on the grass under the block
    out[13:16, 2:16, :3] *= 0.72
    out[14:16, 3:15, :3] *= 0.85
    top_rows = np.clip((np.arange(6) * 16 // 6), 0, 15)
    for i in range(6):
        out[1 + i, 1:15, :3] = t[top_rows[i], 1:15]
    for i in range(8):
        k = 0.92 - 0.3 * i / 7
        out[7 + i, 1:15, :3] = s[(i * 2) % 16, 1:15] * k
    out[1, 1:15, :3] = np.clip(out[1, 1:15, :3] + 30, 0, 255)
    out[7, 1:15, :3] *= 0.7
    # outline
    out[0, 1:15, :3] = OUTLINE
    out[15, 1:15, :3] = OUTLINE
    out[1:15, 0, :3] = OUTLINE
    out[1:15, 15, :3] = OUTLINE
    out[:, :, 3] = 255
    del a
    return np.clip(out, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- the atlas entries
class Tiles:
    def __init__(self, entries, pair):
        self.entries, self.pair = entries, pair
        self.cache, self.info = {}, {}

    def _add(self, key, make, mat, col, info, beh=0):
        if key in self.cache:
            return self.cache[key]
        below, above = make()
        self.entries.append(dict(mid=-1, pair=self.pair, below=below, above=above, beh=beh, enc=0, col=col, mat=mat))
        i = len(self.entries) - 1
        self.cache[key] = i
        self.info[i] = info
        return i

    def wall(self, mat, key, v=0):
        v %= WALL_VARIANTS.get(mat, 1)
        return self._add(('wall', mat, key, v), lambda: (wall_tile(mat, key, v), BLANK), mat, 1, ['wall', mat, key, v])

    def floor(self, look, shadow, v=0):
        v %= FLOOR_LOOK[look][1]
        return self._add(('floor', look, shadow, v), lambda: (floor_tile(look, shadow, v), BLANK), 'floor', 0, ['floor', look, int(shadow), v])

    def water(self, key):
        return self._add(('water', key), lambda: (water_tile(key), BLANK), 'water', 0, ['water', 'water', key, 0], beh=0x10)

    def stairs(self, part, mode, rows, row, warp=False):
        mat = 'stronghold_stairs'
        return self._add(('stairs', part, mode, rows, row, warp), lambda: (stairs_tile(part, mode, rows, row), BLANK), mat, 0,
                         ['stairs', mode, row, part])

    def complete(self):
        for mat in WALL_LOOK:
            nv = WALL_VARIANTS.get(mat, 1)
            for key in WALL_KEYS:
                for v in range(nv):
                    self.wall(mat, key, v)
        for look, (_, nv, _) in FLOOR_LOOK.items():
            for sh in (0, 1):
                for v in range(nv):
                    self.floor(look, sh, v)
        for k in (0, 1):
            self.water(k)


# every key a wall can have: the 47 canonical open masks, and UPPER on those with S closed
WALL_KEYS = sorted(set(BN.ALL_KEYS) | {k | UPPER for k in BN.ALL_KEYS if not k & 4})

# ---------------------------------------------------------------- the layout
WALL, FLOOR, STAIRS, WATER = 0, 1, 2, 3

# room interiors (x, y, w, h) in region cells
ROOMS = {
    'entrance': (6, 7, 7, 6),
    'crossing': (23, 5, 11, 11),
    'library': (42, 3, 21, 15),
    'prison': (8, 25, 32, 3),            # the prison hall itself (its cells are carved below)
    'fountain': (41, 21, 13, 13),
    'crossing2': (64, 21, 11, 11),
    'store1': (4, 38, 7, 5),
    'store2': (82, 24, 7, 5),
    'portal': (62, 44, 13, 15),
}
# corridors: polylines of centre points, carved 3 wide
CORRIDORS = [
    [(13, 10), (22, 10)],                         # entrance -> crossing
    [(34, 10), (41, 10)],                         # crossing -> library
    [(28, 16), (28, 24)],                         # crossing -> prison hall
    [(28, 4), (28, 0 + 3)],                       # crossing: a short dead end north
    [(7, 28), (7, 37)],                           # prison hall -> storeroom 1
    [(52, 18), (52, 20)],                         # library -> fountain room
    [(54, 26), (63, 26)],                         # fountain room -> crossing 2
    [(75, 26), (81, 26)],                         # crossing 2 -> storeroom 2
    [(47, 34), (47, 40), (36, 40), (36, 48)],     # fountain room south: a winding dead end
    [(75, 30), (80, 30), (80, 62), (68, 62), (68, 59)],   # crossing 2 -> round to the portal room's stairs door
    [(17, 28), (17, 31)],                         # (prison cells are carved by prison_cells)
]
DEAD_ENDS = [(28, 3), (36, 48)]


def carve_rect(kind, x, y, w, h):
    kind[y:y + h, x:x + w] = FLOOR


def carve_line(kind, a, b, half=1):
    """A corridor segment `half` cells either side of the line, running `half` past both ends so the corners of a
    polyline are square."""
    (x0, y0), (x1, y1) = a, b
    if x0 == x1:
        ys = range(min(y0, y1) - half, max(y0, y1) + half + 1)
        for y in ys:
            kind[y, x0 - half:x0 + half + 1] = FLOOR
    else:
        xs = range(min(x0, x1) - half, max(x0, x1) + half + 1)
        for x in xs:
            kind[y0 - half:y0 + half + 1, x] = FLOOR


def generate():
    rng = np.random.RandomState(SEED)
    H, W = SH, SW
    kind = np.full((H, W), WALL, np.int8)
    look = np.full((H, W), 'stone', dtype=object)
    flook = np.full((H, W), 'stone_bricks', dtype=object)      # floor look
    keep = np.zeros((H, W), bool)                                # hand-made: no random variation
    blocks = []
    ys, xs = np.mgrid[0:H, 0:W]

    for name, (x, y, w, h) in ROOMS.items():
        carve_rect(kind, x, y, w, h)
    for path in CORRIDORS[:-1]:
        for a, b in zip(path, path[1:]):
            carve_line(kind, a, b)

    # ---- the entrance stair room: a notch in the north wall with two rows of steps, the top row the warp
    ex, ey, ew, eh = ROOMS['entrance']
    sx = ex + 2
    kind[ey - 2:ey, sx:sx + 3] = STAIRS
    stairs = [(sx + i, ey - 2) for i in range(3)]
    arrival = dict(x=sx + 1, y=ey - 2, dir='down')

    # ---- the prison hall: four cells, two each side, behind iron bars
    px, py, pw, ph = ROOMS['prison']
    cells = []
    for cx in (12, 20):
        for side in (-1, 1):
            if side < 0:
                carve_rect(kind, cx, py - 4, 3, 4)
                bar_y = py - 1
                cells.append((cx, py - 4))
            else:
                carve_rect(kind, cx, py + ph, 3, 4)
                bar_y = py + ph
                cells.append((cx, py + ph + 1))
            for i in range(3):
                blocks.append((cx + i, bar_y, {'id': 'iron_bars'}))

    # ---- walls: everything not open is solid; the lining (cells next to open ground) is stone bricks, two
    # deep along north walls so their faces stand two cells high
    open_ = kind != WALL
    near = np.zeros((H, W), bool)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            near |= np.roll(np.roll(open_, dy, 0), dx, 1)
    lining = near & ~open_
    # a lining cell whose south is open: the cell north of it is lining too
    s_open = np.zeros((H, W), bool); s_open[:-1] = open_[1:]
    face_cells = lining & s_open
    up2 = np.zeros((H, W), bool); up2[:-1] = face_cells[1:]
    lining |= up2 & ~open_
    # brick mix: mossy and cracked in patches, normal bricks elsewhere
    moss = BN.fbm(rng, H, W, (6, 3), (0.7, 0.3))
    crack = BN.fbm(rng, H, W, (5, 2), (0.6, 0.4))
    for y, x in zip(*np.nonzero(lining)):
        r = h01(int(x), int(y), 61)
        if moss[y, x] > 0.6 and r < 0.75:
            look[y, x] = 'mossy_stone_bricks'
        elif crack[y, x] > 0.62 and r < 0.7:
            look[y, x] = 'cracked_stone_bricks'
        else:
            look[y, x] = 'stone_bricks'
    # floors: the same mix, quieter
    fmoss = BN.fbm(rng, H, W, (7, 3), (0.7, 0.3))
    fcrack = BN.fbm(rng, H, W, (6, 3), (0.7, 0.3))
    for y, x in zip(*np.nonzero(open_)):
        r = h01(int(x), int(y), 62)
        flook[y, x] = ('mossy_stone_bricks' if fmoss[y, x] > 0.6 and r < 0.8 else
                       'cracked_stone_bricks' if fcrack[y, x] > 0.64 and r < 0.6 else 'stone_bricks')
    # the prison's cells have cobblestone floors
    for cx, cy in cells:
        for yy in range(cy - 1, cy + 4):
            for xx in range(cx, cx + 3):
                if kind[yy, xx] == FLOOR and not (ROOMS['prison'][1] <= yy < ROOMS['prison'][1] + 3):
                    flook[yy, xx] = 'cobblestone'

    # ---- the five-way crossing: four stone-brick pillars round a cobblestone centre, chiseled corners
    cx, cy, cw, chh = ROOMS['crossing']
    for px_, py_ in ((cx + 2, cy + 2), (cx + cw - 4, cy + 2), (cx + 2, cy + chh - 4), (cx + cw - 4, cy + chh - 4)):
        kind[py_:py_ + 2, px_:px_ + 2] = WALL
        look[py_:py_ + 2, px_:px_ + 2] = 'stone_bricks'
        look[py_ + 1, px_] = 'chiseled_stone_bricks'
        keep[py_:py_ + 2, px_:px_ + 2] = True
    flook[cy + 4:cy + chh - 4, cx + 4:cx + cw - 4] = 'cobblestone'

    # ---- the library: bookshelf walls, two rows of tall shelves, an oak gallery round the edge
    lx, ly, lw, lh = ROOMS['library']
    flook[ly:ly + lh, lx:lx + lw] = 'oak_planks'
    flook[ly + 2:ly + lh - 2, lx + 2:lx + lw - 2] = 'stone_bricks'
    for yy in range(ly - 2, ly):
        for xx in range(lx - 1, lx + lw + 1):
            if kind[yy, xx] == WALL:
                look[yy, xx] = 'bookshelf'; keep[yy, xx] = True
    for row in (ly + 4, ly + 9):
        for x0, x1 in ((lx + 3, lx + 9), (lx + 12, lx + 18)):
            kind[row:row + 2, x0:x1] = WALL
            look[row:row + 2, x0:x1] = 'bookshelf'
            keep[row:row + 2, x0:x1] = True
    lib_chests = [(lx + 2, ly + lh - 3), (lx + lw - 3, ly + 2)]
    lib_torches = [(lx + 1, ly + 1), (lx + lw - 2, ly + 1), (lx + 1, ly + lh - 3), (lx + lw - 2, ly + lh - 2), (lx + 10, ly + 1)]
    webs = [(lx + 2, ly + 2), (lx + 2, ly + 3), (lx + 3, ly + 2), (lx + lw - 3, ly + lh - 3), (lx + lw - 4, ly + lh - 3),
            (lx + 10, ly + 7), (lx + lw - 3, ly + 7), (lx + 1, ly + lh - 1)]

    # ---- the fountain room: a 5x5 basin with low brick walls, water round a stone-brick fountain
    fx, fy, fw, fh = ROOMS['fountain']
    bx, by = fx + fw // 2 - 2, fy + fh // 2 - 2
    for yy in range(by, by + 5):
        for xx in range(bx, bx + 5):
            edge = yy in (by, by + 4) or xx in (bx, bx + 4)
            if edge:
                kind[yy, xx] = WALL; look[yy, xx] = 'stone_bricks'
            else:
                kind[yy, xx] = WATER
            keep[yy, xx] = True
    kind[by + 2, bx + 2] = WALL; look[by + 2, bx + 2] = 'chiseled_stone_bricks'
    for xx, yy in ((bx, by), (bx + 4, by), (bx, by + 4), (bx + 4, by + 4)):
        look[yy, xx] = 'chiseled_stone_bricks'
    flook[fy:fy + fh, fx:fx + fw] = np.where(fmoss[fy:fy + fh, fx:fx + fw] > 0.55, 'mossy_stone_bricks', 'stone_bricks')

    # ---- crossing 2: a plain room with a cobblestone cross in the floor
    c2x, c2y, c2w, c2h = ROOMS['crossing2']
    flook[c2y + c2h // 2 - 1:c2y + c2h // 2 + 2, c2x:c2x + c2w] = 'cobblestone'
    flook[c2y:c2y + c2h, c2x + c2w // 2 - 1:c2x + c2w // 2 + 2] = 'cobblestone'

    # ---- storerooms: a chest against the far wall
    s1x, s1y, s1w, s1h = ROOMS['store1']
    s2x, s2y, s2w, s2h = ROOMS['store2']
    store_chests = [(s1x + s1w // 2, s1y + s1h - 1), (s2x + s2w - 1, s2y + s2h // 2)]

    # ---- the portal room: the frame ring on a raised platform over a lava pool, stairs up from the south door,
    # the spawner on the landing
    prx, pry, prw, prh = ROOMS['portal']
    ccx, ccy = prx + prw // 2, pry + 4                        # the ring's centre
    frames, pool, centre = [], [], []
    for yy in range(ccy - 2, ccy + 3):
        for xx in range(ccx - 2, ccx + 3):
            dx, dy = xx - ccx, yy - ccy
            if abs(dx) <= 1 and abs(dy) <= 1:
                pool.append((xx, yy)); centre.append((xx, yy))
            elif abs(dx) == 2 and abs(dy) == 2:
                pool.append((xx, yy))
            else:
                facing = 'S' if dy == -2 else 'N' if dy == 2 else 'E' if dx == -2 else 'W'
                frames.append([xx, yy, facing])
    # two frames hold an eye from the start (fixed): the middle of the north side and the east side's lowest
    filled = {(ccx, ccy - 2), (ccx + 2, ccy + 1)}
    for f in frames:
        f.append((f[0], f[1]) in filled)
    flook[pry:pry + 10, prx:prx + prw] = 'stone_bricks'
    # the platform's edge: a low wall across the room, broken by the stairs
    edge_y = ccy + 5
    stair_x = ccx - 1
    for xx in range(prx, prx + prw):
        if not stair_x <= xx < stair_x + 3:
            kind[edge_y, xx] = WALL; look[edge_y, xx] = 'stone_bricks'; keep[edge_y, xx] = True
    for i, yy in enumerate(range(edge_y, edge_y + 3)):
        for j in range(3):
            kind[yy, stair_x + j] = STAIRS
    spawner = (ccx, edge_y - 1)
    flook[edge_y + 3:pry + prh, prx:prx + prw] = 'stone_bricks'

    # ---- dead ends get a cracked, mossy end wall (they look abandoned)
    for x, y in DEAD_ENDS:
        for dy in (-2, -1, 0, 1, 2):
            for dx in (-2, -1, 0, 1, 2):
                if kind[y + dy, x + dx] == WALL and lining[y + dy, x + dx]:
                    look[y + dy, x + dx] = 'cracked_stone_bricks' if h01(x + dx, y + dy, 63) < 0.5 else 'mossy_stone_bricks'

    # ---- infested bricks: about one lining cell in fourteen along the corridors (never in the hand-made parts)
    corridor = open_.copy()
    for name, (x, y, w, h) in ROOMS.items():
        if name != 'prison':
            corridor[y:y + h, x:x + w] = False
    near_c = np.zeros((H, W), bool)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            near_c |= np.roll(np.roll(corridor, dy, 0), dx, 1)
    infested = []
    for y, x in zip(*np.nonzero(lining & near_c & ~keep)):
        if 3 <= x < W - 3 and 3 <= y < H - 3 and h01(int(x), int(y), 64) < 0.075 and look[y, x] in ('stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks'):
            look[y, x] = 'infested_' + look[y, x]
            infested.append((int(x), int(y)))

    # ---- wall torches on faces: along the corridors and in the rooms, spaced out
    torches = []
    kind_f = kind.copy()
    face_ok = (kind == WALL) & np.isin(look, ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks'])
    s_open = np.zeros((H, W), bool); s_open[:-1] = kind[1:] != WALL
    n_wall = np.zeros((H, W), bool); n_wall[1:] = kind[:-1] == WALL
    cand = [(int(x), int(y)) for y, x in zip(*np.nonzero(face_ok & s_open))]
    cand.sort(key=lambda c: (h01(c[0], c[1], 65)))
    # the portal room's platform edge gets a torch either side of its stairs, and its back wall two
    prx, pry, prw, prh = ROOMS['portal']
    must = [(stair_x - 2, edge_y), (stair_x + 4, edge_y), (prx + 3, pry - 1), (prx + prw - 4, pry - 1)]
    for x, y in must + cand:
        if not face_ok[y, x] or not s_open[y, x]:
            continue
        if any(abs(x - tx) + abs(y - ty) < (3 if (x, y) in must else 9) for tx, ty in torches):
            continue
        if (x, y) in [(xx, yy) for xx, yy, _ in blocks]:
            continue
        torches.append((x, y))
        look[y, x] = 'wall_torch'
    del kind_f

    # ---- ores in the natural stone, away from the bricks
    depth = dist_to(kind != WALL)
    for y, x in zip(*np.nonzero((kind == WALL) & (look == 'stone') & (depth >= 3))):
        if not (2 <= x < W - 2 and 2 <= y < H - 2):
            continue
        r = h01(int(x), int(y), 66)
        ore = ('coal_ore' if r < 0.012 else 'iron_ore' if r < 0.02 else 'redstone_ore' if r < 0.024 else
               'lapis_ore' if r < 0.0262 else 'gold_ore' if r < 0.0285 else None)
        if ore:
            size = 1 + int(h01(int(x), int(y), 67) * (5 if ore == 'coal_ore' else 3))
            ok = (kind == WALL) & (look == 'stone') & (depth >= 3)
            for gx, gy in BN.grow(ok, (int(x), int(y)), size, rng, np.zeros((H, W), bool)):
                look[gy, gx] = ore

    # ---- the region's edge: two cells of stone all round
    edge = (xs < 2) | (ys < 2) | (xs >= W - 2) | (ys >= H - 2)
    assert not (open_ & edge).any()

    # ---- placed blocks: loot chests, cobwebs, the spawner, the lava pool, the frames
    for k, (x, y) in enumerate(lib_chests):
        blocks.append((x, y, {'id': 'chest', 'slots': chest_loot(LOOT[k])}))
    for k, (x, y) in enumerate(store_chests):
        blocks.append((x, y, {'id': 'chest', 'slots': chest_loot(LOOT[2 + k])}))
    for x, y in webs:
        assert kind[y, x] == FLOOR, (x, y)
        blocks.append((x, y, {'id': 'cobweb', 'walk': True}))
    for x, y in lib_torches:
        blocks.append((x, y, {'id': 'torch', 'walk': True}))
    blocks.append((spawner[0], spawner[1], {'id': 'spawner'}))
    for x, y in pool:
        blocks.append((x, y, {'id': 'lava'}))
    for x, y, facing, eye in frames:
        # walk: Steve can stand on a frame (as in Minecraft), which is how he reaches the portal in the middle
        blocks.append((x, y, {'id': 'end_portal_frame', 'facing': facing, 'eye': bool(eye), 'walk': True}))
    return dict(kind=kind, look=look, flook=flook, blocks=blocks, stairs=stairs, arrival=arrival, frames=frames,
                pool=pool, centre=centre, spawner=spawner, torches=torches, infested=infested,
                chests=lib_chests + store_chests, stair_x=stair_x, edge_y=edge_y, rng=rng)


# Chest loot in the spirit of Minecraft's stronghold tables (library: books and paper; corridors: ingots, food,
# redstone, a few diamonds). Five ender pearls in all.
LOOT = [
    [('book', 3), ('paper', 6), ('ender_pearl', 1), ('apple', 1)],
    [('paper', 4), ('book', 2), ('ender_pearl', 1), ('redstone', 3)],
    [('iron_ingot', 4), ('gold_ingot', 2), ('bread', 3), ('apple', 2), ('ender_pearl', 2), ('redstone', 5)],
    [('diamond', 2), ('iron_ingot', 3), ('bread', 2), ('ender_pearl', 1), ('gold_ingot', 3), ('apple', 1)],
]


def chest_loot(items):
    slots = [None] * 27
    for i, (id, n) in enumerate(items):
        slot = (i * 7 + 4) % 27
        while slots[slot] is not None:
            slot = (slot + 1) % 27
        slots[slot] = {'id': id, 'n': n}
    return slots


# ---------------------------------------------------------------- tiles for the cells
def wall_key(kind, x, y):
    H, W = kind.shape
    def op(xx, yy):
        return bool(0 <= xx < W and 0 <= yy < H and kind[yy, xx] != WALL)
    k = (op(x, y - 1) and 1) | (op(x + 1, y) and 2) | (op(x, y + 1) and 4) | (op(x - 1, y) and 8)
    k |= (op(x + 1, y - 1) and 16) | (op(x + 1, y + 1) and 32) | (op(x - 1, y + 1) and 64) | (op(x - 1, y - 1) and 128)
    k = canon(k)
    if not k & 4 and y + 2 < H and kind[y + 1, x] == WALL and kind[y + 2, x] != WALL:
        k |= UPPER
    return k


def variant(x, y, n):
    return int(h01(x, y, 7) * n)


def assign(g, T):
    kind, look, flook = g['kind'], g['look'], g['flook']
    H, W = kind.shape
    grid = np.zeros((H, W), np.int32)
    ground = np.zeros((H, W), np.int32)
    stairs = set(g['stairs'])
    for y in range(H):
        for x in range(W):
            k = kind[y, x]
            nk = kind[y - 1, x] if y > 0 else WALL
            if k == WALL:
                m = look[y, x]
                grid[y, x] = T.wall(m, wall_key(kind, x, y), variant(x, y, 4))
                fl = FLOOR_OF.get(m, 'stone_bricks')
                ground[y, x] = T.floor(fl, 0, variant(x, y, 8))
            elif k == FLOOR:
                grid[y, x] = ground[y, x] = T.floor(flook[y, x], int(nk == WALL), variant(x, y, 8))
            elif k == WATER:
                grid[y, x] = ground[y, x] = T.water(int(nk == WALL))
            elif k == STAIRS:
                # a flight: which cell from the north, how long, and its side walls
                y0 = y
                while y0 > 0 and kind[y0 - 1, x] == STAIRS:
                    y0 -= 1
                y1 = y
                while y1 + 1 < H and kind[y1 + 1, x] == STAIRS:
                    y1 += 1
                lw = kind[y, x - 1] != STAIRS
                rw = kind[y, x + 1] != STAIRS
                part = 'S' if lw and rw else 'L' if lw else 'R' if rw else 'M'
                grid[y, x] = ground[y, x] = T.stairs(part, 'up', y1 - y0 + 1, y - y0, warp=(x, y) in stairs)
    prot = np.zeros((H, W), np.uint8)
    ys, xs = np.mgrid[0:H, 0:W]
    prot[(xs < 2) | (ys < 2) | (xs >= W - 2) | (ys >= H - 2)] = 3
    for x, y in g['stairs']:
        prot[y, x] = 3
    for x, y, *_ in g['frames']:
        prot[y, x] = 1
    for x, y in g['pool']:
        prot[y, x] = 3
    prot[g['spawner'][1], g['spawner'][0]] = 0
    return grid, ground, prot


def build(entries, pair):
    g = generate()
    T = Tiles(entries, pair)
    first = len(entries)
    grid, ground, prot = assign(g, T)
    T.complete()
    return g, T, grid, ground, prot, first


# Materials of the stronghold's tiles, added to world.json's after Kanto's and the Nether's (names that already
# exist there keep their old rules). The stairs are walkable and unbreakable.
MATERIALS = {
    **{id: BN.mat_spec(id) for id in ('stone', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks', 'bookshelf')},
    **{f'infested_{m}': BN.mat_spec(f'infested_{m}', infested='silverfish', drop=None)
       for m in ('stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks')},
    'wall_torch': BN.mat_spec('stone_bricks', light=14, torch=True),
    'stronghold_stairs': dict(hard=-1, walk=True),
}


def entrance_tiles(entries, T, ground_entry):
    """Route 23's cracked block and the stairway it leaves, drawn over that cell's own grass."""
    base = entries[ground_entry]['below']
    closed = T._add(('entrance', 'closed'), lambda: (cracked_block_tile(base), BLANK), 'cracked_stone_bricks', 1,
                    ['entrance', 'cracked_stone_bricks', 0, 0])
    opened = T._add(('entrance', 'open'), lambda: (stairway_tile(base), BLANK), 'stronghold_stairs', 0,
                    ['entrance', 'stronghold_stairs', 1, 0], beh=0)
    return closed, opened


def attach(entries, pair, ox, oy, map_index, route_ground):
    """Generate the stronghold, append its atlas entries (and Route 23's entrance pair), and return its arrays
    and world.json's 'stronghold' section in world cells."""
    g, T, grid, ground, prot, first = build(entries, pair)
    closed, opened = entrance_tiles(entries, T, route_ground)
    cell = lambda x, y: [int(x + ox), int(y + oy)]
    lights = [cell(x, y) + [14] for x, y in g['torches']]
    wall, floor, water = {}, {}, {}
    for i, (kd, mat, key, v) in T.info.items():
        if kd == 'wall':
            wall.setdefault(mat, {}).setdefault(str(key), {})[v] = i
        elif kd == 'floor':
            floor.setdefault(mat, {}).setdefault(str(key), {})[v] = i
        elif kd == 'water':
            water[str(key)] = i
    as_list = lambda d: {m: {k: [vv[j] for j in sorted(vv)] for k, vv in ks.items()} for m, ks in d.items()}
    from collections import Counter
    meta = {
        'x': ox, 'y': oy, 'w': SW, 'h': SH, 'map': map_index, 'pair': pair, 'first': first, 'count': len(entries) - first,
        'entrance': {'x': ENTRANCE[0], 'y': ENTRANCE[1]}, 'entranceTiles': {'closed': closed, 'open': opened},
        'stairs': [cell(x, y) for x, y in g['stairs']],
        'arrival': dict(x=g['arrival']['x'] + ox, y=g['arrival']['y'] + oy, dir='down'),
        'blocks': [cell(x, y) + [rec] for x, y, rec in g['blocks']],
        'chests': [cell(x, y) for x, y in g['chests']],
        'frames': [cell(x, y) + [f, bool(e)] for x, y, f, e in g['frames']],
        'portal': {'centre': [cell(x, y) for x, y in g['centre']], 'lava': [cell(x, y) for x, y in g['pool']]},
        'spawner': cell(*g['spawner']),
        'infested': [cell(x, y) for x, y in g['infested']],
        'lights': lights,
        'rooms': {k: [v[0] + ox, v[1] + oy, v[2], v[3]] for k, v in ROOMS.items()},
        'tiles': {str(i): v for i, v in sorted(T.info.items())},
        'wall': as_list(wall), 'floor': as_list(floor), 'water': water,
        'floorLook': FLOOR_OF, 'upperBit': UPPER,
        'stats': {'torches': len(g['torches']), 'infested': len(g['infested']),
                  'ores': dict(Counter(str(v) for v in g['look'][np.isin(g['look'], ORES)].tolist())),
                  'pearls': sum(n for L in LOOT for id, n in L if id == 'ender_pearl')},
    }
    meta = json.loads(json.dumps(meta, default=lambda o: o.item()))
    return g, grid, ground, prot, meta


def preview(entries, grid, blocks, x0=0, y0=0):
    im = BN.preview(entries, grid)
    BN.draw_blocks(im, [tuple(b) for b in blocks], x0, y0)
    return im


if __name__ == '__main__':
    out = Path(sys.argv[1] if len(sys.argv) > 1 else HERE / 'out' / 'stronghold_preview.png')
    entries = [dict(mid=0, pair=-1, below=np.full((16, 16, 4), (106, 189, 98, 255), np.uint8), above=BLANK, beh=0, enc=0, col=0, mat='floor')]
    g, T, grid, ground, prot, first = build(entries, 0)
    print(f"entries {len(entries) - first}; torches {len(g['torches'])}, infested {len(g['infested'])}, blocks {len(g['blocks'])}")
    preview(entries, grid, g['blocks']).save(out)
    print('wrote', out)
