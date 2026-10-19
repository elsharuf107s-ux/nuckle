#!/usr/bin/env python3
"""Contact sheets of the generated worlds' tile bank (terrain.json, atlas_gen.png), for review by eye (4.8).

  tints.png      every ground tint and transition band on every tinted piece, and each hub pair's gradient
                 (temperate, band 1, band 2, the tint) as it will lie across a biome edge
  codes.png      the 47 blob codes of every quarter-tile set and recolour, on their home ground
  quarter_<S>.png  each set's recolours drawn as a blob (outer and inner corners, 2-cell steps, a hole) on every
                 ground: temperate grass (home entries), cool, dry, lush and swamp grass, a band, snow, sand, mud
  trees.png      Kanto's tree (oak) as a small forest of overlays on every ground, next to its home look
  rock.png       a rock mass and ledges painted with the learned tables, in every rock style, on every ground
                 (home entries on the style's own ground, overlays elsewhere), with the miss count
Usage: python3 tools/terrain_sheets.py [out dir] [terrain dir] (defaults out/gen/sheets and assets/world).
Images are 1:1 or 2:1 pixel art.
"""
import sys
sys.dont_write_bytecode = True
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
import build_terrain as BT  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
WORLD = HERE / 'assets' / 'world'
GRASS4 = ((8, 9), (16, 17))
BG = (40, 40, 40)
INK = (255, 236, 120)


class Atlas:
    def __init__(self, world=WORLD, gen=None):
        gen = gen or world
        self.T = json.load(open(gen / 'terrain.json'))
        W = json.load(open(world / 'world.json'))
        self.cols = W['cols']
        self.base = self.T['genBase']
        self.img = [np.array(Image.open(world / n).convert('RGBA')) for n in ('atlas.png', 'atlas_top.png')]
        self.gen = [np.array(Image.open(gen / n).convert('RGBA')) for n in ('atlas_gen.png', 'atlas_gen_top.png')]
        self.row = lambda i: self.T['entries'][i - self.base]

    def tile(self, i, top=False):
        if i >= self.base:
            k, a, cols = i - self.base, self.gen[1 if top else 0], self.T['cols']
        else:
            k, a, cols = i, self.img[1 if top else 0], self.cols
        x, y = (k % cols) * 16, (k // cols) * 16
        return a[y:y + 16, x:x + 16]

    def is_ov(self, i):
        return i >= self.base and self.row(i)[10] == 1


def paste(canvas, t, x, y):
    """Straight-alpha source-over of a 16x16 RGBA tile onto an RGBA numpy canvas."""
    reg = canvas[y:y + 16, x:x + 16]
    reg[...] = BT.over(t, reg)


def draw_cells(A, ground, piece, scale=1):
    """A field of cells: ground[y][x] (an entry) under piece[y][x] (an entry or None), the way world.drawGenCell does:
    an overlay over its cell's ground, anything else alone; then every top layer."""
    H, W = len(ground), len(ground[0])
    c = np.zeros((H * 16, W * 16, 4), np.uint8)
    c[..., 3] = 255
    for y in range(H):
        for x in range(W):
            e = piece[y][x]
            if e is None or A.is_ov(e):
                paste(c, A.tile(ground[y][x]), x * 16, y * 16)
            if e is not None:
                paste(c, A.tile(e), x * 16, y * 16)
    for y in range(H):
        for x in range(W):
            e = piece[y][x] if piece[y][x] is not None else ground[y][x]
            paste(c, A.tile(e, True), x * 16, y * 16)
    im = Image.fromarray(c, 'RGBA').convert('RGB')
    return im.resize((im.width * scale, im.height * scale), Image.NEAREST) if scale != 1 else im


def grounds(A):
    """Every ground a piece may be drawn on: (label, function (x, y) -> plain ground entry)."""
    T = A.T
    v = {r['name']: r['id'] for r in T['variants']}
    ve = lambda var, m: T['ventry'][str(var)][str(m)]
    q = T['quarter']['sets']
    centre = 0                                       # code 0 is (0, 0, 0, 0): all inside
    out = [('temperate', lambda x, y: GRASS4[y % 2][x % 2])]
    for t in ('cool', 'dry', 'lush', 'swamp'):
        out.append((t, lambda x, y, t=t: ve(v[t], GRASS4[y % 2][x % 2])))
    out.append(('dry band 1', lambda x, y: ve(v['dry_band1'], GRASS4[y % 2][x % 2])))
    out.append(('snow', lambda x, y: q['B']['recolours']['snow']['home'][centre]))
    out.append(('sand', lambda x, y: q['B']['recolours']['sand']['home'][centre]))
    out.append(('mud', lambda x, y: q['B']['recolours']['mud']['home'][centre]))
    return out


def label(im, text, pad=14):
    out = Image.new('RGB', (im.width, im.height + pad), BG)
    out.paste(im, (0, pad))
    ImageDraw.Draw(out).text((2, 1), text, fill=INK)
    return out


def grid_sheet(cells, cols, gap=6):
    w = max(c.width for c in cells)
    h = max(c.height for c in cells)
    rows = -(-len(cells) // cols)
    out = Image.new('RGB', (cols * (w + gap) + gap, rows * (h + gap) + gap), BG)
    for i, c in enumerate(cells):
        out.paste(c, (gap + (i % cols) * (w + gap), gap + (i // cols) * (h + gap)))
    return out


def stack(ims, gap=8):
    w = max(i.width for i in ims)
    out = Image.new('RGB', (w, sum(i.height + gap for i in ims)), BG)
    y = 0
    for i in ims:
        out.paste(i, (0, y))
        y += i.height + gap
    return out


# ---------------------------------------------------------------- tints
def sheet_tints(A):
    T = A.T
    v = {r['name']: r['id'] for r in T['variants']}
    src = T['vocab']['grass'] + T['vocab']['tallGrass'] + T['vocab']['tallGrassBase'] + T['vocab']['flower'] + T['vocab']['bush']
    rows = [('temperate', None)] + [(n, v[n]) for n in ('cool', 'dry', 'lush', 'swamp')] + \
        [(f'{t}_band{k}', v[f'{t}_band{k}']) for t in ('cool', 'dry', 'lush', 'swamp') for k in (1, 2)]
    tiles = []
    for name, var in rows:
        line = [[m if var is None else T['ventry'][str(var)][str(m)] for m in src]]
        tiles.append(label(draw_cells(A, line, [[None] * len(src)], 2), name))
    strips = []
    for t in ('cool', 'dry', 'lush', 'swamp'):
        W, H = 24, 6
        zone = lambda x: None if x < 9 else v[f'{t}_band1'] if x < 12 else v[f'{t}_band2'] if x < 15 else v[t]
        def ent(m, x):
            z = zone(x)
            return m if z is None else T['ventry'][str(z)][str(m)]
        ground = [[ent(GRASS4[y % 2][x % 2], x) for x in range(W)] for y in range(H)]
        piece = [[None] * W for _ in range(H)]
        for y in range(1, 5):                        # a tall-grass patch and flowers across the bands
            for x in range(6, 18):
                piece[y][x] = ent(13, x)
        for x in (3, 4, 19, 20):
            piece[2][x] = ent(4, x)
        piece[4][2] = ent(5, 2)
        piece[4][21] = ent(5, 21)
        strips.append(label(draw_cells(A, ground, piece, 2), f'temperate | {t} band 1 | band 2 | {t}'))
    return stack([grid_sheet(tiles, 1), stack(strips)])


# ---------------------------------------------------------------- quarter sets
BLOB = [
    '..............',
    '..####........',
    '..######......',
    '.########.....',
    '.##########...',
    '.####..####...',
    '.####..######.',
    '...########...',
    '...######.....',
    '.....##.......',
]


def blob_codes_for(mask, lut):
    H, W = len(mask), len(mask[0])
    inside = lambda x, y: 0 <= x < W and 0 <= y < H and mask[y][x] == '#'
    codes = {}
    for y in range(H):
        for x in range(W):
            if not inside(x, y):
                continue
            n = 0
            for k, (dx, dy) in (('N', (0, -1)), ('E', (1, 0)), ('S', (0, 1)), ('W', (-1, 0)), ('NE', (1, -1)),
                                ('SE', (1, 1)), ('SW', (-1, 1)), ('NW', (-1, -1))):
                if inside(x + dx, y + dy):
                    n |= BT.BITS[k]
            codes[(x, y)] = lut[n]
    return codes


def sheet_codes(A):
    T = A.T
    q = T['quarter']
    parts = []
    for sid, rec in q['sets'].items():
        for rname, rr in rec['recolours'].items():
            for kind in ('home', 'ov'):
                ents = rr.get(kind)
                if not ents:
                    continue
                if kind == 'home' or rec['outside'] == 'sea':
                    g = None
                else:
                    g = 1
                line = [[g if g else e for e in ents[:24]], [g if g else e for e in ents[24:]] + [ents[0]]]
                piece = [[e if g else None for e in ents[:24]], [e if g else None for e in ents[24:]] + [None]]
                parts.append(label(draw_cells(A, line, piece, 2), f'{sid} {rname} {kind} ({len(ents)} codes)'))
    return stack(parts)


def sheet_quarter(A, sid):
    T = A.T
    q = T['quarter']
    rec = q['sets'][sid]
    codes = blob_codes_for(BLOB, q['lut'])
    H, W = len(BLOB), len(BLOB[0])
    out = []
    sea = 299
    for rname, rr in rec['recolours'].items():
        cells = []
        if rec['outside'] == 'sea':
            outer = 425 if rname == 'ice_pond' else sea
            ground = [[outer] * W for _ in range(H)]
            piece = [[rr['home'][codes[(x, y)]] if (x, y) in codes else None for x in range(W)] for y in range(H)]
            cells.append(label(draw_cells(A, ground, piece), f'{sid} {rname} on {"pond" if outer == 425 else "sea"}'))
        else:
            own = {'grass': 'temperate', 'snow': 'snow', 'sand': 'sand'}[rr.get('outside', 'grass')]
            for gname, gf in grounds(A):
                ground = [[gf(x, y) for x in range(W)] for y in range(H)]
                use = rr['home'] if gname == own else rr['ov']
                piece = [[use[codes[(x, y)]] if (x, y) in codes else None for x in range(W)] for y in range(H)]
                cells.append(label(draw_cells(A, ground, piece), f'{sid} {rname} on {gname}' +
                                   (' (home)' if gname == own else '')))
        out.append(grid_sheet(cells, 4))
    return stack(out)


# ---------------------------------------------------------------- trees and rock
def forest(W, H):
    """Kanto's tree lattice: 2-wide trees in columns every 2 cells and rows every 2 cells, so a tree's tip shares the
    cell of the base of the tree above it (the overlap pieces); a clearing in the middle shows the edge pieces."""
    piece = [[None] * W for _ in range(H)]
    crown, base, tip, overlap = (28, 29), (36, 37), (14, 15), (20, 21)
    for cy in range(1, H - 1, 2):
        for lx in range(0, W - 1, 2):
            if 4 <= lx <= 6 and 3 <= cy <= 5:
                continue                              # the clearing
            piece[cy][lx], piece[cy][lx + 1] = crown
            piece[cy + 1][lx], piece[cy + 1][lx + 1] = base
            if piece[cy - 1][lx] in base:
                piece[cy - 1][lx], piece[cy - 1][lx + 1] = overlap
            else:
                piece[cy - 1][lx], piece[cy - 1][lx + 1] = tip
    return piece


def sheet_trees(A):
    T = A.T
    ovl = T['ovl']['0']
    W, H = 12, 9
    base_piece = forest(W, H)
    cells = []
    for gname, gf in grounds(A):
        ground = [[gf(x, y) for x in range(W)] for y in range(H)]
        if gname == 'temperate':
            piece = base_piece
            cells.append(label(draw_cells(A, ground, piece), 'oak home (General) on temperate'))
        piece = [[None if m is None else ovl[str(m)] for m in row] for row in base_piece]
        cells.append(label(draw_cells(A, ground, piece), f'oak overlay on {gname}'))
    return grid_sheet(cells, 4)


ROCK = [                       # a mass by the step rule (3.4, 3.6): 2-cell steps, straight runs of at least 4
    '..................',
    '..########........',
    '..########........',
    '..############....',
    '..############....',
    '..##############..',
    '..##############..',
    '......##########..',
    '......##########..',
    '..................',
    '..................',
]
LEDGE_ROW = 10


def sheet_rock(A):
    T = A.T
    L = T['learned']
    v = {r['name']: r['id'] for r in T['variants']}
    mask = np.array([[c == '#' for c in row] for row in ROCK])
    H, W = mask.shape
    lmask = np.zeros((H, W), bool)
    lmask[LEDGE_ROW, 2:16] = True
    gs = grounds(A)
    cells = []
    total_miss = 0
    for style, sv in (('brown', 0), ('grey', v['rock_grey']), ('snowy', v['rock_snowy']), ('sandstone', v['rock_sandstone'])):
        home_ground = {'brown': 'temperate', 'grey': 'cool', 'snowy': 'snow', 'sandstone': 'sand'}[style]
        for gname, gf in gs:
            ctx = 'g' if gname not in ('sand', 'mud') else 's'
            mids, lv = BT.paint_learned(L['rock'], mask, ctx)
            lmids, llv = BT.paint_learned(L['ledge'], lmask, ctx)
            total_miss += int((lv == 3).sum() + (llv == 3).sum())
            ground = [[gf(x, y) for x in range(W)] for y in range(H)]
            fam = T['overlayTest']['family']
            def ent(m):
                # world.pieceFor's rule: the home look when the cell's ground is the piece's own ground, else the overlay
                if m < 0:
                    return None
                home = m if sv == 0 else T['ventry'][str(sv)].get(str(m), m)
                ov = T['ovl'][str(sv)].get(str(m))
                if ov is None:
                    return home
                own = fam[str(ov)].endswith('|grass')
                return home if (gname == home_ground and own) else ov
            piece = [[ent(int(mids[y, x])) if mask[y, x] else ent(int(lmids[y, x])) if lmask[y, x] else None
                      for x in range(W)] for y in range(H)]
            tag = 'home' if gname == home_ground else 'overlay'
            cells.append(label(draw_cells(A, ground, piece), f'{style} {tag} on {gname}  3x3 {int((lv == 1).sum())} fill {int((lv == 2).sum())}'))
    return grid_sheet(cells, 4), total_miss


# ---------------------------------------------------------------- stage 2b: species, synthesized tiles, ores
GROVE = [(0, 2), (2, 2), (4, 2), (0, 4), (2, 4), (4, 4), (8, 2), (10, 2), (8, 6), (8, 8), (12, 5)]   # (lx, cy) slots


def grove(W=15, H=11, slots=GROVE):
    """Tree pieces by world.treeTileFor's rule over a set of slots: a 3x2 block, a pair, a column of two, a lone tree."""
    S = set(slots)
    piece = [[None] * W for _ in range(H)]
    for lx, cy in slots:
        for y in range(cy - 1, cy + 2):
            for x in (lx, lx + 1):
                if 0 <= y < H and x < W:
                    piece[y][x] = BT.tree_tile_for(S, x if x % 2 == 0 else x - 1, y, x % 2 == 0)
    return piece


def sheet_species(A):
    T = A.T
    sp = T['species']
    base_piece = grove()
    H, W = len(base_piece), len(base_piece[0])
    gs = dict(grounds(A))
    cells, missing = [], []
    for name, rec in sp.items():
        own = 'snow' if rec['ground'] == 'snow' else 'temperate'
        for gname in [own] + [g for g in ('cool', 'dry', 'swamp', 'snow', 'sand', 'mud') if g != own]:
            ground = [[gs[gname](x, y) for x in range(W)] for y in range(H)]
            use = rec['home'] if gname == own else rec['ov']
            for m in BT.TREE_MIDS:
                if str(m) not in use:
                    missing.append((name, m))
            piece = [[None if m is None else use[str(m)] for m in row] for row in base_piece]
            cells.append(label(draw_cells(A, ground, piece), f'{name} {"home" if gname == own else "overlay"} on {gname}'))
    return grid_sheet(cells, 7), missing


def sheet_lattice(A):
    """Every species' 14 lattice pieces one by one at 3x, home looks."""
    T = A.T
    rows = []
    for name, rec in T['species'].items():
        g = 1 if rec['ground'] == 'grass' else T['synth']['grounds']['snow'][0]
        line = [[e for e in (rec['home'][str(m)] for m in BT.TREE_MIDS)]]
        rows.append(label(draw_cells(A, [[g] * len(BT.TREE_MIDS)], line, 3), f'{name}: ' + ' '.join(str(m) for m in BT.TREE_MIDS)))
    return stack(rows)


def sheet_synth(A):
    T = A.T
    S = T['synth']
    parts = []
    for gname, ents in S['grounds'].items():
        W = 8
        ground = [[ents[(x // 2 + y) % len(ents)] for x in range(W)] for y in range(3)]
        parts.append(label(draw_cells(A, ground, [[None] * W for _ in range(3)], 3), f'ground {gname} ({len(ents)} plain pieces)'))
    sp = S['sprites']
    gs = grounds(A)
    cells = []
    for gname, gf in [('own', None)] + gs:
        W, H = 9, 3
        ground = [[gf(x, y) if gf else 1 for x in range(W)] for y in range(H)]
        piece = [[None] * W for _ in range(H)]
        order = ['cactus', 'dead_bush', 'sugar_cane', 'pumpkin', 'melon']
        for k, n in enumerate(order):
            x = 1 + k * 2 - (k > 0)
            if gf is None:
                ground[1][x] = sp[n]['ground']
                piece[1][x] = sp[n]['home']
            else:
                piece[1][x] = sp[n]['ov']
        if gf is None:
            ground[0][1] = sp['cactus_top']['ground']
            piece[0][1] = sp['cactus_top']['home']
        else:
            piece[0][1] = sp['cactus_top']['ov']
        piece[2][8] = sp['lily_pad']['ov']
        ground[2][7] = ground[2][8] = 425
        piece[2][7] = sp['lily_pad']['home'] if gf is None else None
        cells.append(label(draw_cells(A, ground, piece, 3), f'cactus, dead bush, cane, pumpkin, melon; lily pads: {gname}'))
    return stack([stack(parts), grid_sheet(cells, 3)])


def sheet_ores(A):
    T = A.T
    O = T['ores']
    rows = []
    bad = []
    for style, faces in O['entries'].items():
        for f, row in faces.items():
            line = [T['ventry'][str(T['rockStyles'][style]['var'])][f] if style != 'brown' else int(f)] + \
                [row[o] for o in O['kinds']]
            for o in O['kinds']:
                e = row[o]
                r = A.row(e) if e >= A.base else None
                base = r[5] if r else None
                if r is not None and (base != line[0] or r[4] != o):
                    bad.append((style, f, o))
            rows.append(label(draw_cells(A, [line], [[None] * len(line)], 2), f'{style} face {f}'))
    out = []
    for k in range(0, len(rows), 21):
        out.append(stack(rows[k:k + 21], 2))
    w = sum(o.width + 6 for o in out)
    im = Image.new('RGB', (w, max(o.height for o in out)), BG)
    x = 0
    for o in out:
        im.paste(o, (x, 0))
        x += o.width + 6
    return im, bad


def sheet_caves(A):
    T = A.T
    rows = []
    for fam, faces in T['ores']['caves'].items():
        for f, row in faces.items():
            line = [int(f)] + [row[o] for o in T['ores']['kinds']]
            rows.append(label(draw_cells(A, [line], [[None] * len(line)], 2), f'{fam} {f}'))
    out = []
    for k in range(0, len(rows), 20):
        out.append(stack(rows[k:k + 20], 2))
    im = Image.new('RGB', (sum(o.width + 6 for o in out), max(o.height for o in out)), BG)
    x = 0
    for o in out:
        im.paste(o, (x, 0))
        x += o.width + 6
    return im


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'out' / 'gen' / 'sheets'
    out.mkdir(parents=True, exist_ok=True)
    A = Atlas(WORLD, Path(sys.argv[2]) if len(sys.argv) > 2 else None)
    sheet_tints(A).save(out / 'tints.png')
    sheet_codes(A).save(out / 'codes.png')
    for sid in A.T['quarter']['sets']:
        sheet_quarter(A, sid).save(out / f'quarter_{sid}.png')
    sheet_trees(A).save(out / 'trees.png')
    im, miss = sheet_rock(A)
    im.save(out / 'rock.png')
    if 'species' in A.T:
        im, missing = sheet_species(A)
        im.save(out / 'species.png')
        sheet_lattice(A).save(out / 'lattice.png')
        sheet_synth(A).save(out / 'synth.png')
        im, bad = sheet_ores(A)
        im.save(out / 'ores.png')
        sheet_caves(A).save(out / 'cave_ores.png')
        print(f'species pieces missing: {missing}; ore entries with a wrong base or material: {bad}')
    print(f'sheets in {out}; learned-table misses on the rock sheet: {miss}')


if __name__ == '__main__':
    main()
