#!/usr/bin/env python3
"""The End: a generated region appended below the stronghold (a stage of tools/build_world.py).

One map entry, MAP_THE_END (banner "THE END"), 112x112 cells, mostly void, drawn with its own atlas entries made
from Minecraft 1.21.4's textures in the way tools/build_nether.py draws the Nether:
  - the main island: end stone, irregular and roughly round, about 80 cells across, with a few low end stone
    outcrops. Where the island ends to the south its end stone cliff face drops into the void (FireRed's cliff
    style: the face hangs in the void cells below the edge, two or three cells deep, ragged at the bottom); the
    other edges have a lit lip and an outline;
  - the void: a dark starfield (assets/mc/end/end_void.png and its star layers; the runtime animates it), never
    solid black. Cliff faces are drawn in the void cells' top layer, so whatever falls into the void passes
    behind them;
  - ten obsidian pillars in a ring of radius 20 round the centre, footprints 3x3 to 6x6, standing two to four
    cells tall (the column's top is drawn that far north of its base, its face below it); an end crystal floats
    on each (the runtime's), the two smallest in iron-bar cages;
  - the exit portal at the centre: Minecraft's bedrock fountain from above, a rounded ring of bedrock (one block
    high: Steve can step over it, as he climbs it in Minecraft) round a sunken basin (20 cells that become End portal once the dragon is beaten) and a bedrock pillar in the middle
    topped by four torches (its upper part is drawn in the top layer of the cell north of it);
  - the obsidian spawn platform, 5x5, floating in the void six cells off the island's west edge. Arrival is on it.

Keys: an island or platform floor cell is keyed by its void sides N=1 E=2 S=4 W=8 (rims and outlines). A void cell
under the island's south edge is a face cell keyed [material, d, h, sides, jag]: d its row in a face h rows deep (1 at
the top), sides L=1 R=2 where the cell beside it has no face at that row, jag one of four ragged bottoms. Outcrops
are walls keyed as in tools/build_stronghold.py.

world.json 'end' (world cells): x, y, w, h, map, pair, first, count; arrival {x, y, dir}; platform [x, y, w, h];
island {cx, cy}; pillars [{base [x, y, w, h], cells [x, y, w, h] (all it covers), top [x, y, w, h] (where its top is
drawn), face, crystal [px, py] (world pixels: the centre of its top), caged}]; fountain {centre [x, y], ring, inner
(the 20 portal cells), pillar [x, y], egg [px, py] (world pixels of the pillar's top), torches}; voidTiles [entries],
face {key: entry} ('mat,d,h,sides,jag'), floor {look: {key: [entries]}}, wall {mat: {key: [entries]}}; tiles {entry:
[kind, mat, key, variant]}; lights [[x, y, level]]; voidKey (the material name of void cells).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import build_nether as BN  # noqa: E402
import build_stronghold as BS  # noqa: E402
from build_nether import tex, rgb, pack, grade, turn, soften, canon, h01, dist_to, components  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
END_TX = HERE / 'assets' / 'mc' / 'end'
EW, EH = 112, 112
GUTTER = 8
SEED = 2011
MAP_ID = 'MAP_THE_END'
OUTLINE = np.array((24, 16, 30), np.uint8)
VOID_RGB = np.array((14, 10, 22), np.float64)
BLANK = np.zeros((16, 16, 4), np.uint8)
ISLAND_R = 39.0
PILLAR_R = 20.0

LOOK = {'end_stone': ('end_stone', 'end_stone', False, 1.07, 4), 'bedrock': ('bedrock', 'bedrock', False, 1.25, 10),
        'obsidian': ('obsidian', 'obsidian', False, 1.6, 10)}
FLOOR_VARIANTS = 4
SHADES = (0.965, 1.0, 1.03)


# ---------------------------------------------------------------- tiles
def end_rgb(name):
    return rgb(tex(name))


_void = None


def void_sheet():
    """The void as one 128x128 tile: end_void with both star layers, as the runtime draws its first frame."""
    global _void
    if _void is None:
        base = Image.open(END_TX / 'end_void.png').convert('RGBA')
        for n in ('end_stars_far.png', 'end_stars_near.png'):
            base.alpha_composite(Image.open(END_TX / n).convert('RGBA'))
        _void = np.array(base).astype(np.float64)
    return _void


def void_tile(v):
    """A void cell: an 16x16 piece of the void sheet (v picks which of 64; neighbouring cells take neighbouring
    pieces, so the static field is seamless)."""
    s = void_sheet()
    x, y = (v % 8) * 16, (v // 8) * 16
    return pack(s[y:y + 16, x:x + 16, :3])


def floor_tile(look, key, v, shade=1):
    """An island (end stone) or platform (obsidian) floor cell; key: its void sides (rims)."""
    if look == 'end_stone':
        f = grade(soften(rgb(turn(tex('end_stone'), v)), 0.35), gain=0.98 * SHADES[shade], sat=0.95, lift=0, contrast=0.72)
    elif look == 'obsidian':
        f = grade(soften(rgb(turn(tex('obsidian'), v)), 0.3), gain=2.2, sat=1.2, lift=26, contrast=0.85)
    else:      # the fountain's sunken bedrock basin
        f = grade(rgb(turn(tex('bedrock'), v)), gain=0.62, sat=0.8, lift=0, contrast=0.8)
    n, e, s, w = key & 1, key & 2, key & 4, key & 8
    if key & 16:
        for r, k in enumerate((0.55, 0.7, 0.82, 0.92)):
            f[r] *= k
    lip = np.clip(f * 1.22 + 14, 0, 255) if look != 'obsidian' else np.clip(f * 1.4 + 40, 0, 255)
    if n:
        f[0] = OUTLINE
        f[1] = lip[1]
    if s:
        f[14] = lip[14]
        f[15] = np.clip(f[15] * 1.05 + 6, 0, 255)
    if w:
        f[:, 0] = OUTLINE
        f[1:, 1] = lip[1:, 1]
    if e:
        f[:, 15] = OUTLINE
        f[1:, 14] *= 0.8
    # rounded corners where two void sides meet: the corner pixel is void
    vt = void_tile(v * 9 % 64).astype(np.float64)[:, :, :3]
    for (a, b, y, x) in ((n, w, 0, 0), (n, e, 0, 15), (s, w, 15, 0), (s, e, 15, 15)):
        if a and b:
            f[y, x] = vt[y, x]
            f[min(14, max(1, y)), x] = OUTLINE
            f[y, min(14, max(1, x))] = OUTLINE
    return pack(f)


def basin_tile(key, v):
    """The fountain's sunken bedrock floor; key N=1 when the ring stands north of it (its shadow)."""
    f = grade(rgb(turn(tex('bedrock'), v)), gain=0.6, sat=0.8, lift=0, contrast=0.8)
    if key & 1:
        for r, k in enumerate((0.4, 0.55, 0.7, 0.85)):
            f[r] *= k
    if key & 8:
        f[:, 0:2] *= 0.7
    if key & 2:
        f[:, 14:16] *= 0.8
    return pack(f)


def jag_profile(jag, h):
    """The ragged underside of a face: per pixel column, how many pixels of the bottom cell the rock reaches."""
    r = np.random.RandomState(100 + jag)
    base = 9 + r.rand(16) * 6
    sm = np.convolve(np.concatenate([base[-2:], base, base[:2]]), np.ones(3) / 3, 'valid')[1:-1]
    return np.clip(sm, 3, 15)


def rock_face(mat, v, total, k0=0.98, k1=0.4):
    """A rock face `total` rows high (end stone, obsidian): the block's own texture, two irregular strata ledges per
    block height (a dark crack under a lit edge), darkening downwards. Returns total x 16 x 3."""
    t = rgb(tex(mat))
    off = (v * 5) % 16
    out = np.zeros((total, 16, 3))
    for g in range(total):
        out[g] = np.roll(t[g % 16], off, axis=0)
    xs = np.arange(16)
    for base in range(7, total, 11):
        wave = np.round(1.2 * np.sin(xs * 0.7 + v * 1.9 + base)).astype(int)
        for x in range(16):
            y = base + wave[x]
            if 0 < y < total:
                out[y, x] *= 0.55
                out[y - 1, x] = np.clip(out[y - 1, x] * 1.18 + 8, 0, 255)
    k = np.linspace(k0, k1, total)[:, None, None]
    out = out * k
    if mat == 'obsidian':
        out = out * 1.9 + 14
    return out


def face_tile(mat, d, h, sides, jag):
    """A void cell's top layer under a south edge: row d of a cliff face h rows deep, darkening and purpling as it
    goes down, its last row ragged and fading into the void."""
    total = h * 16
    out = np.zeros((16, 16, 4), np.float64)
    prof = jag_profile(jag, h)
    face = rock_face(mat, jag, total)
    purple = np.array([1.0, 0.84, 1.2])
    for yy in range(16):
        g = (d - 1) * 16 + yy
        tt = g / max(1, total - 1)
        row = face[g]
        out[yy, :, :3] = row * (1 - 0.45 * tt) + row * purple * 0.45 * tt
        out[yy, :, 3] = 255
    if d == 1:
        out[0, :, :3] *= 0.55                      # under the lip
    if d == h:
        for x in range(16):
            reach = int(prof[x])
            out[reach:, x, 3] = 0
            if reach - 1 >= 0:
                out[reach - 1, x, :3] = out[reach - 1, x, :3] * 0.5 + VOID_RGB * 0.5
            if reach - 2 >= 0:
                out[reach - 2, x, :3] *= 0.8
    if sides & 1:
        out[:, 0, :3] = OUTLINE
        out[:, 1, :3] *= 0.8
    if sides & 2:
        out[:, 15, :3] = OUTLINE
        out[:, 14, :3] *= 0.7
    return np.clip(out, 0, 255).astype(np.uint8)


def pillar_tile(role, r, n, edges, v):
    """One cell of an obsidian pillar. role 'top': row r of an n-row top face (calm, lit, with a bevelled rim);
    'face': row r of an n-row front face (darkening downwards, lit down its west side). edges: W=1 E=2 (the
    column's sides in this cell)."""
    if role == 'top':
        f = grade(soften(rgb(turn(tex('obsidian'), v)), 0.45), gain=2.3, sat=1.2, lift=28, contrast=0.8)
        if r == 0:
            f[0] = OUTLINE
            f[1] = np.clip(f[1] * 1.35 + 26, 0, 255)
            f[2] = np.clip(f[2] * 1.12 + 8, 0, 255)
        if r == n - 1:
            f[13] = np.clip(f[13] * 1.15 + 10, 0, 255)
            f[14] = np.clip(f[14] * 1.45 + 34, 0, 255)       # the lit front edge of the top
            f[15] = OUTLINE
        if edges & 1:
            f[:, 1] = np.clip(f[:, 1] * 1.3 + 20, 0, 255)
        if edges & 2:
            f[:, 14] *= 0.75
    else:
        side = rgb(tex('obsidian'))
        f = np.zeros((16, 16, 3))
        total = n * 16
        for yy in range(16):
            g = r * 16 + yy
            tt = g / max(1, total - 1)
            f[yy] = side[g % 16, ::(-1 if v % 2 else 1)] * (1.9 - 1.05 * tt) + 5
        if r == 0:
            f[0] *= 0.35
            f[1] *= 0.6
        if edges & 1:
            f[:, 1] = np.clip(f[:, 1] * 1.5 + 14, 0, 255)      # the lit west edge of the column
            f[:, 2] = np.clip(f[:, 2] * 1.2 + 6, 0, 255)
        if edges & 2:
            f[:, 13] *= 0.7
            f[:, 14] *= 0.5
        if r == n - 1:
            f[15] = OUTLINE
            f[14] *= 0.7
    if edges & 1:
        f[:, 0] = OUTLINE
    if edges & 2:
        f[:, 15] = OUTLINE
    return pack(f)


def fountain_pillar_tiles():
    """The bedrock pillar in the fountain's middle, four blocks high as in Minecraft: its own cell is the foot of the
    column; the cell north of it (top layer) the column's middle with the south torch; the cell two north (top
    layer) the cap with the north torch standing behind it, and the cells either side of that one the west and east
    torches. Returns {'lower', 'mid', 'cap', 'west', 'east'}; the egg sits on the cap (CAP_TOP rows into its cell)."""
    bed = rgb(tex('bedrock'))
    torch = tex('torch').astype(np.float64)
    def column(rows, r0, k0, k1):
        out = np.zeros((rows, 16, 3))
        for i in range(rows):
            out[i] = bed[(r0 + i) % 16] * 1.15 * (k0 + (k1 - k0) * i / max(1, rows - 1)) + 8
        return out
    def sides(img, rows):
        img[rows, 0, :3] = OUTLINE; img[rows, 15, :3] = OUTLINE
        img[rows, 1, :3] *= 0.8; img[rows, 14, :3] *= 0.7
    lower = np.zeros((16, 16, 4)); lower[:, :, 3] = 255
    lower[:, :, :3] = column(16, 0, 0.78, 0.5)
    sides(lower, slice(0, 16)); lower[15, :, :3] = OUTLINE
    mid = np.zeros((16, 16, 4)); mid[:, :, 3] = 255
    mid[:, :, :3] = column(16, 6, 0.98, 0.79)
    sides(mid, slice(0, 16))
    cap = np.zeros((16, 16, 4))
    capt = grade(rgb(turn(tex('bedrock'), 1)), gain=1.4, lift=14)
    cap[CAP_TOP:, :, :3] = capt[CAP_TOP:]
    cap[CAP_TOP:, :, 3] = 255
    cap[CAP_TOP, :, :3] = OUTLINE
    cap[15, :, :3] = np.clip(capt[15] * 1.25 + 18, 0, 255)          # the cap's lit front edge
    sides(cap, slice(CAP_TOP, 16))
    def glow(img, cx, cy, r=4.5, a=110):
        yy, xx = np.mgrid[0:16, 0:16]
        k = np.clip(1 - np.hypot(xx - cx, yy - cy) / r, 0, 1)
        m = (k > 0) & (img[:, :, 3] == 0)
        img[m, :3] = (255, 200, 110)
        img[m, 3] = (k[m] * a)
    def put_torch(img, x0, y0, rows=8):
        src = torch[6:6 + rows, 7:9]
        for i in range(rows):
            for j in range(2):
                if src[i, j, 3] > 0 and 0 <= y0 + i < 16 and 0 <= x0 + j < 16:
                    img[y0 + i, x0 + j, :3] = src[i, j, :3]
                    img[y0 + i, x0 + j, 3] = 255
    put_torch(mid, 7, 2, 7)                       # the south torch, on the column's face below the cap
    mid[9, 6:10, :3] = OUTLINE
    glow(cap, 8, CAP_TOP - 3)
    put_torch(cap, 7, CAP_TOP - 5, 5)             # the north torch, behind the cap
    west = np.zeros((16, 16, 4)); east = np.zeros((16, 16, 4))
    glow(west, 14, CAP_TOP + 1); glow(east, 1, CAP_TOP + 1)
    put_torch(west, 13, CAP_TOP - 1, 7); put_torch(east, 1, CAP_TOP - 1, 7)
    west[CAP_TOP + 6, 14:16, :3] = OUTLINE; west[CAP_TOP + 6, 14:16, 3] = 255
    east[CAP_TOP + 6, 0:2, :3] = OUTLINE; east[CAP_TOP + 6, 0:2, 3] = 255
    u8 = lambda a: np.clip(a, 0, 255).astype(np.uint8)
    return {'lower': u8(lower), 'mid': u8(mid), 'cap': u8(cap), 'west': u8(west), 'east': u8(east)}


CAP_TOP = 9


# ---------------------------------------------------------------- atlas entries
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

    def void(self, v, face=None):
        """A void cell (v: its piece of the void sheet; the face cells use piece 0 below, their face above)."""
        if face is None:
            return self._add(('void', v), lambda: (void_tile(v), BLANK), 'void', 1, ['void', 'void', 0, v])
        mat, d, h, sides, jag = face
        return self._add(('face', face), lambda: (void_tile(0), face_tile(mat, d, h, sides, jag)), 'void', 1,
                         ['face', mat, f'{d},{h},{sides},{jag}', 0])

    def floor(self, look, key, v=0, shade=1):
        v %= FLOOR_VARIANTS
        mat = {'end_stone': 'floor', 'obsidian': 'obsidian_floor'}[look]
        return self._add(('floor', look, key, v, shade), lambda: (floor_tile(look, key, v, shade), BLANK), mat, 0,
                         ['floor', look, key, v * 3 + shade])

    def basin(self, key, v=0):
        v %= 2
        return self._add(('basin', key, v), lambda: (basin_tile(key, v), BLANK), 'bedrock_floor', 0, ['basin', 'bedrock', key, v])

    def wall(self, mat, key, v=0):
        v %= 2
        return self._add(('wall', mat, key, v), lambda: (BS.wall_tile(mat, key, v, look=LOOK, outline=OUTLINE, face_rows=lambda m, vv, total: rock_face(m, vv, total, 0.92, 0.5)), BLANK), mat, 1,
                         ['wall', mat, key, v])

    def pillar(self, role, r, n, edges, v):
        v %= 2
        return self._add(('pillar', role, r, n, edges, v), lambda: (pillar_tile(role, r, n, edges, v), BLANK), 'end_pillar', 1,
                         ['pillar', role, f'{r},{n},{edges}', v])

    def complete(self):
        for v in range(64):
            self.void(v)
        for look in ('end_stone', 'obsidian'):
            for key in range(32):
                for v in range(FLOOR_VARIANTS):
                    for sh in ((0, 1, 2) if look == 'end_stone' else (1,)):
                        self.floor(look, key, v, sh)
        for mat, hs in (('end_stone', (2, 3)), ('obsidian', (1,))):
            for h in hs:
                for d in range(1, h + 1):
                    for sides in range(4):
                        for jag in range(4):
                            self.void(0, (mat, d, h, sides, jag))
        for key in BN.ALL_KEYS:
            for v in range(2):
                self.wall('end_stone', key, v)


# ---------------------------------------------------------------- the map
VOID, FLOOR, WALL, PILLAR, RING, BASIN, CENTRE, PLAT = range(8)


def island_mask(rng):
    """The main island: a disc of radius about 39 with a wobbling, noisy coastline."""
    H, W = EH, EW
    cx, cy = W / 2, H / 2 + 1
    ys, xs = np.mgrid[0:H, 0:W]
    ang = np.arctan2(ys - cy, xs - cx)
    dist = np.hypot(xs - cx, ys - cy)
    ph = rng.rand(6) * 2 * math.pi
    wob = (0.05 * np.sin(2 * ang + ph[0]) + 0.04 * np.sin(3 * ang + ph[1]) + 0.03 * np.sin(5 * ang + ph[2])
           + 0.02 * np.sin(7 * ang + ph[3]))
    n = BN.fbm(rng, H, W, (6, 3), (0.7, 0.3))
    r = ISLAND_R * (1 + wob) + (n - 0.5) * 5.0
    m = BN.smooth(dist < r, 2)
    lab, sizes = components(m)
    return lab == int(np.argmax(sizes)), (int(round(cx)), int(round(cy)))


MOUNDS = 0          # low end stone outcrops (tried: they read as crates; Minecraft's main island is open ground)
PILLAR_SIZES = [4, 6, 3, 5, 4, 6, 5, 3, 4, 5]      # footprints round the ring, from the east, clockwise
FACE_OF = {3: 2, 4: 3, 5: 3, 6: 4}                 # the column's height in cells (its front face)


def generate():
    rng = np.random.RandomState(SEED)
    H, W = EH, EW
    kind = np.full((H, W), VOID, np.int8)
    look = np.full((H, W), 'end_stone', dtype=object)
    isl, (cx, cy) = island_mask(rng)
    kind[isl] = FLOOR

    # ---- the exit portal: a rounded 7x7 of bedrock (ring, basin, pillar) at the centre
    ring, inner = [], []
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            if abs(dx) + abs(dy) > 4:
                continue                        # the 7x7's corners are cut: a rounded rim
            x, y = cx + dx, cy + dy
            if dx == 0 and dy == 0:
                kind[y, x] = CENTRE
            elif abs(dx) <= 2 and abs(dy) <= 2 and abs(dx) + abs(dy) <= 3:
                kind[y, x] = BASIN; inner.append((x, y))
            else:
                kind[y, x] = RING; ring.append((x, y))
    assert len(inner) == 20, len(inner)

    # ---- the pillars
    pillars = []
    for i, w in enumerate(PILLAR_SIZES):
        a = 2 * math.pi * i / len(PILLAR_SIZES) + 0.2
        px, py = cx + PILLAR_R * math.cos(a), cy + PILLAR_R * math.sin(a)
        h = FACE_OF[w]
        bx, by = int(round(px - w / 2)), int(round(py - w / 2 + h / 2))
        top_y = by - h
        cells = (bx, top_y, w, w + h)
        for yy in range(top_y, by + w):
            for xx in range(bx, bx + w):
                assert kind[yy, xx] == FLOOR, ('pillar off the island', i)
                kind[yy, xx] = PILLAR
        pillars.append(dict(i=i, w=w, h=h, base=(bx, by, w, w), cells=cells, top=(bx, top_y, w, w), face=(bx, by + w - h, w, h),
                            crystal=((bx + w / 2) * 16, (top_y + w / 2) * 16)))
    order = sorted(range(len(pillars)), key=lambda k: (pillars[k]['w'], k))
    for k in order[:2]:
        pillars[k]['caged'] = True

    # ---- low end stone outcrops (the main island's hills), clear of the pillars, the fountain and the west landing
    ys, xs = np.mgrid[0:H, 0:W]
    busy = np.zeros((H, W), bool)
    for p in pillars:
        x, y, w, hh = p['cells']
        busy[max(0, y - 3):y + hh + 3, max(0, x - 3):x + w + 3] = True
    busy[cy - 7:cy + 8, cx - 7:cx + 8] = True
    busy[cy - 4:cy + 5, :cx - 20] = True                    # the way in from the platform
    d_void = dist_to(kind == VOID)
    mounds = 0
    cand = [(int(x), int(y)) for y, x in zip(*np.nonzero((kind == FLOOR) & ~busy & (d_void >= 6)))]
    rng.shuffle(cand)
    for x, y in cand:
        if mounds >= MOUNDS:
            break
        if busy[y, x]:
            continue
        rx, ry = 1.7 + rng.rand() * 1.2, 1.1 + rng.rand() * 0.8
        el = (((xs - x) / rx) ** 2 + ((ys - y) / ry) ** 2 + (BN.value_noise(rng, H, W, 3) - 0.5) * 0.3) < 1.0
        if not ((kind[el] == FLOOR).all() and not busy[el].any() and (d_void[el] >= 5).all()) or el.sum() < 6:
            continue
        kind[el] = WALL
        busy[max(0, y - 8):y + 9, max(0, x - 8):x + 9] = True
        mounds += 1

    # ---- the spawn platform: 5x5 obsidian, six void cells off the island's west edge, level with the centre
    west = min(x for x in range(W) if kind[cy, x] != VOID)
    for yy in range(cy - 2, cy + 3):
        west = min(west, min(x for x in range(W) if kind[yy, x] != VOID))
    px0 = west - 6 - 5
    assert px0 >= 2, px0
    kind[cy - 2:cy + 3, px0:px0 + 5] = PLAT
    look[cy - 2:cy + 3, px0:px0 + 5] = 'obsidian'
    arrival = dict(x=px0 + 2, y=cy, dir='right')
    assert not (kind[:2] != VOID).any() and not (kind[-2:] != VOID).any()
    return dict(kind=kind, look=look, centre=(cx, cy), ring=ring, inner=inner, pillars=pillars, platform=(px0, cy - 2, 5, 5),
                arrival=arrival, mounds=mounds, rng=rng)


def solid_ground(k):
    return k in (FLOOR, PLAT, WALL, PILLAR, RING, BASIN, CENTRE)


def assign(g, T):
    kind, look = g['kind'], g['look']
    H, W = kind.shape
    grid = np.zeros((H, W), np.int32)
    ground = np.zeros((H, W), np.int32)
    is_void = kind == VOID
    # face depth per column: two cells, three where the noise says so (the island's underside is uneven)
    deep = BN.value_noise(np.random.RandomState(SEED + 1), 1, W, 6)[0] > 0.55
    shade_n = BN.fbm(np.random.RandomState(SEED + 2), H, W, (8, 4), (0.7, 0.3))
    cx, cy = g['centre']
    FP = fountain_pillar_tiles()
    i_lower = T._add(('fpillar', 'lower'), lambda: (FP['lower'], BLANK), 'fountain_pillar', 1, ['fountain', 'pillar', 0, 0])
    over = {(cx, cy - 1): 'mid', (cx, cy - 2): 'cap', (cx - 1, cy - 2): 'west', (cx + 1, cy - 2): 'east'}

    def face_at(x, y):
        """(material, d, h) of the face hanging in void cell (x, y), or None."""
        d = 0
        yy = y
        while yy >= 0 and is_void[yy, x] and d < 4:
            yy -= 1; d += 1
        if yy < 0 or is_void[yy, x] or d == 0:
            return None
        mat = 'obsidian' if kind[yy, x] == PLAT else 'end_stone'
        h = 1 if mat == 'obsidian' else (3 if deep[x] else 2)
        return (mat, d, h) if d <= h else None

    for y in range(H):
        for x in range(W):
            k = kind[y, x]
            vv = (x % 8) + (y % 8) * 8
            if k == VOID:
                f = face_at(x, y)
                if f:
                    mat, d, h = f
                    def same(xx):
                        if not (0 <= xx < W) or not is_void[y, xx]:
                            return not (0 <= xx < W) or False
                        return face_at(xx, y) is not None
                    sides = (0 if same(x - 1) or (0 <= x - 1 and not is_void[y, x - 1] and False) else 1) | (0 if same(x + 1) else 2)
                    # beside solid ground at the same row there is no visible side either
                    if x > 0 and not is_void[y, x - 1]:
                        sides &= ~1
                    if x + 1 < W and not is_void[y, x + 1]:
                        sides &= ~2
                    grid[y, x] = T.void(0, (mat, d, h, sides, int(h01(x, 0, 9) * 4)))
                else:
                    grid[y, x] = T.void(vv)
                ground[y, x] = T.void(vv)
            elif k in (FLOOR, PLAT, WALL):
                key = 0
                for bit, (dx, dy) in ((1, (0, -1)), (2, (1, 0)), (4, (0, 1)), (8, (-1, 0))):
                    xx, yy = x + dx, y + dy
                    if not (0 <= xx < W and 0 <= yy < H) or is_void[yy, xx]:
                        key |= bit
                if y > 0 and kind[y - 1, x] in (WALL, PILLAR, RING, CENTRE) and k != WALL:
                    key |= 16
                lk = 'obsidian' if k == PLAT else 'end_stone'
                shade = 0 if shade_n[y, x] < 0.36 else 2 if shade_n[y, x] > 0.64 else 1
                fl = T.floor(lk, key, BS.variant(x, y, 4), shade if lk == 'end_stone' else 1)
                ground[y, x] = fl if k != PLAT else T.void(vv)
                if k == WALL:
                    grid[y, x] = T.wall('end_stone', wall_key(kind, x, y), BS.variant(x, y, 2))
                    ground[y, x] = T.floor('end_stone', key, BS.variant(x, y, 4), 1)
                else:
                    grid[y, x] = fl
            elif k == RING:
                grid[y, x] = T._add(('ring', wall_key(kind, x, y)), (lambda kk: lambda: (BS.wall_tile('bedrock', kk, 0, look=LOOK, outline=OUTLINE), BLANK))(wall_key(kind, x, y)),
                                    'bedrock', 0, ['wall', 'bedrock', wall_key(kind, x, y), 0])
                ground[y, x] = grid[y, x]
            elif k == BASIN:
                nk = kind[y - 1, x]
                key = (1 if nk in (RING, CENTRE) else 0) | (2 if kind[y, x + 1] == RING else 0) | (8 if kind[y, x - 1] == RING else 0)
                if (x, y) in over:
                    part = over[(x, y)]
                    grid[y, x] = T._add(('fpillar', part, key), (lambda kk, pp: lambda: (basin_tile(kk, 0), FP[pp]))(key, part), 'bedrock_floor', 0,
                                        ['fountain', part, key, 0])
                else:
                    grid[y, x] = T.basin(key, BS.variant(x, y, 2))
                ground[y, x] = grid[y, x]
            elif k == CENTRE:
                grid[y, x] = ground[y, x] = i_lower
    # the pillars: top cells then face cells, with their side edges
    for p in g['pillars']:
        bx, ty, w, hh = p['cells']
        for yy in range(ty, ty + hh):
            for xx in range(bx, bx + w):
                edges = (1 if xx == bx else 0) | (2 if xx == bx + w - 1 else 0)
                r = yy - ty
                if r < w:
                    grid[yy, xx] = T.pillar('top', r, w, edges, BS.variant(xx, yy, 2))
                else:
                    grid[yy, xx] = T.pillar('face', r - w, p['h'], edges, BS.variant(xx, yy, 2))
                ground[yy, xx] = grid[yy, xx]
    prot = np.zeros((H, W), np.uint8)
    prot[kind == PILLAR] = 1
    prot[(kind == RING) | (kind == CENTRE)] = 1
    prot[kind == BASIN] = 3
    ys, xs = np.mgrid[0:H, 0:W]
    prot[(xs < 2) | (ys < 2) | (xs >= W - 2) | (ys >= H - 2)] = 3
    return grid, ground, prot


def wall_key(kind, x, y):
    """As tools/build_stronghold.py's: anything that is not this kind of wall counts as open."""
    H, W = kind.shape
    me = kind[y, x]
    def op(xx, yy):
        return bool(0 <= xx < W and 0 <= yy < H and kind[yy, xx] != me)
    k = (op(x, y - 1) and 1) | (op(x + 1, y) and 2) | (op(x, y + 1) and 4) | (op(x - 1, y) and 8)
    k |= (op(x + 1, y - 1) and 16) | (op(x + 1, y + 1) and 32) | (op(x - 1, y + 1) and 64) | (op(x - 1, y - 1) and 128)
    return canon(k)          # low outcrops and the fountain's rim: single faces, their tops showing


def build(entries, pair):
    g = generate()
    T = Tiles(entries, pair)
    first = len(entries)
    grid, ground, prot = assign(g, T)
    T.complete()
    return g, T, grid, ground, prot, first


# Materials of The End's tiles (names already in world.json keep their old rules). The void can't be stood on or
# broken; the platform's obsidian floor is mined like obsidian and leaves void; the fountain is bedrock.
MATERIALS = {
    'end_stone': BN.mat_spec('end_stone'),
    'obsidian_floor': BN.mat_spec('obsidian', drop='obsidian', floor=True),
    'void': dict(hard=-1, void=True),
    'bedrock': BN.mat_spec('bedrock'),
    'bedrock_floor': dict(hard=-1),
    'fountain_pillar': BN.mat_spec('bedrock', light=14),
    'end_pillar': BN.mat_spec('obsidian'),
}


def attach(entries, pair, ox, oy, map_index):
    g, T, grid, ground, prot, first = build(entries, pair)
    cell = lambda x, y: [int(x + ox), int(y + oy)]
    rect = lambda r: [int(r[0] + ox), int(r[1] + oy), int(r[2]), int(r[3])]
    cx, cy = g['centre']
    face, floor, wall = {}, {}, {}
    voids = [None] * 64
    for i, (kd, mat, key, v) in T.info.items():
        if kd == 'face':
            face[f'{mat},{key}'] = i
        elif kd == 'void':
            voids[v] = i
        elif kd == 'floor':
            floor.setdefault(mat, {}).setdefault(str(key), {})[v] = i
        elif kd == 'wall' and mat == 'end_stone':
            wall.setdefault(mat, {}).setdefault(str(key), {})[v] = i
    as_list = lambda d: {m: {k: [vv[j] for j in sorted(vv)] for k, vv in ks.items()} for m, ks in d.items()}
    meta = {
        'x': ox, 'y': oy, 'w': EW, 'h': EH, 'map': map_index, 'pair': pair, 'first': first, 'count': len(entries) - first,
        'arrival': dict(x=g['arrival']['x'] + ox, y=g['arrival']['y'] + oy, dir=g['arrival']['dir']),
        'platform': rect(g['platform']),
        'island': {'cx': cx + ox, 'cy': cy + oy, 'r': ISLAND_R},
        'pillars': [{'base': rect(p['base']), 'cells': rect(p['cells']), 'top': rect(p['top']), 'face': rect(p['face']),
                     'crystal': [p['crystal'][0] + ox * 16, p['crystal'][1] + oy * 16], 'caged': bool(p.get('caged'))}
                    for p in g['pillars']],
        'fountain': {'centre': cell(cx, cy), 'ring': [cell(x, y) for x, y in g['ring']], 'inner': [cell(x, y) for x, y in g['inner']],
                     'pillar': cell(cx, cy), 'egg': [(cx + ox) * 16 + 8, (cy - 2 + oy) * 16 + CAP_TOP + 3],
                     'over': [cell(cx, cy - 1), cell(cx, cy - 2), cell(cx - 1, cy - 2), cell(cx + 1, cy - 2)]},
        'lights': [cell(cx, cy) + [14]],
        'voidTiles': voids, 'face': face, 'floor': as_list(floor), 'wall': as_list(wall),
        'tiles': {str(i): v for i, v in sorted(T.info.items())},
        'stats': {'island': int((g['kind'] != VOID).sum()), 'mounds': g['mounds'], 'pillars': len(g['pillars'])},
    }
    meta = json.loads(json.dumps(meta, default=lambda o: o.item()))
    return g, grid, ground, prot, meta


def preview(entries, grid):
    return BN.preview(entries, grid)


if __name__ == '__main__':
    out = Path(sys.argv[1] if len(sys.argv) > 1 else HERE / 'out' / 'end_preview.png')
    entries = []
    g, T, grid, ground, prot, first = build(entries, 0)
    print(f"entries {len(entries) - first}; island {(g['kind'] != VOID).sum()} cells, mounds {g['mounds']}, "
          f"pillars {[(p['w'], p['h'], bool(p.get('caged'))) for p in g['pillars']]}")
    preview(entries, grid).save(out)
    print('wrote', out)
