#!/usr/bin/env python3
"""Checks of the generated worlds' tile bank (world update stage 2a), from the files alone.

  1. Classic is untouched: every file build_world.py writes for Classic (atlas.png, atlas_top.png, world.json,
     grid.bin, ...) is byte-identical to the baseline snapshot's, and world.json's entries 0..8974 equal it row
     for row.
  2. terrain.json is well formed: v 1, entries numbered from world.json's count, 11 fields a row, every reference
     (ventry, ovl, home, homeGround, quarter codes) inside the table, the image pair covers every entry, the top
     flag matches the top image.
  3. The overlay test (4.3), recomputed from the PNGs: every overlay drawn over its home ground differs from its home
     entry in at most 3% of its pixels, counted strictly (build_terrain.ov_counts: object pixels, shadows, rims and
     the ground's texture all count; only loose tufts, which the cell's ground replaces, are exempt); every overlay
     drawn over its plain ground colour reproduces its home exactly at each of its non-transparent pixels. Negative
     controls: an overlay with its object removed fails; with its shadow and rim (delta) pixels removed, or painted
     magenta, the count sees every one of them.
  4. Quarter-tile sets: 47 codes, a 256-entry lookup, every set and recolour with 47 home entries (and 47 overlays
     when its outside is the ground); the identity codes recomposed here from General's pieces equal the stored
     pixels; every code of a set recolour (home and overlay) has one behaviour, collision, material and encounter
     flag, a code equal to a General piece being that entry or a copy of its pixels with the set's metadata.
     Rock-style grounds have the material they show (snow, desert sand).
  5. Learned tables: the rock tables equal autotile.json's; no 3x3 pattern misses after the fill in either
     table or context; every ledge member is a ledge; build_terrain.lookup(classic=True) picks what the game's
     world.reedgeCliffs picks on every rock cell of 24 random masks (tools/gen_tests/lookup_parity.mjs).
  6. Vocabulary ids have the behaviour and material their list says; tints, bands and rock styles cover their pieces.
  7. Determinism: build_terrain.py run twice into scratch folders gives byte-identical files, equal to the
     committed ones.
  8. Stage 2b: every species has every lattice piece (the 14 pieces world.treeTileFor returns), a home look with
     General's tree metadata and an overlay; the three crown shapes (Kanto's cone, the round tree, the acacia) have
     different silhouettes, and the round tree's species differ from it (birch's trunk, jungle's and swamp oak's
     vines); every (rock style, interior face, ore) has an entry whose base is that style's plain face, and the faces
     are every piece the learned painter can put on an interior rock cell; every interior wall piece of the three
     cave families has every ore, based on that piece; the synthesized grounds have their materials and every
     decoration sprite a home entry and an overlay.
Usage: python3 tools/gen_tests/terrain_check.py [--base out/baselines/v7-pre-world] [--scratch DIR]
(the determinism builds go to --scratch, by default out/gen-tests/terrain_check, which is removed afterwards)
"""
import sys
sys.dont_write_bytecode = True
import argparse
import filecmp
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(HERE / 'tools'))
import build_terrain as BT  # noqa: E402

WORLD = HERE / 'assets' / 'world'
CLASSIC_FILES = ['area.bin', 'atlas.png', 'atlas_top.png', 'autotile.json', 'beh.bin', 'col.bin', 'doors.png', 'grid.bin',
                 'ground.bin', 'prot.bin', 'world.json', 'zone.bin']
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('ok   ' if ok else 'FAIL ') + name + (f'  ({detail})' if detail else ''))


def tiles(path, cols):
    a = np.array(Image.open(path).convert('RGBA'))
    def get(k):
        x, y = (k % cols) * 16, (k // cols) * 16
        return a[y:y + 16, x:x + 16]
    return a, get


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default=str(HERE / 'out' / 'baselines' / 'v7-pre-world'))
    ap.add_argument('--scratch', default=None)
    args = ap.parse_args()
    base = Path(args.base) / 'assets' / 'world'

    # 1. Classic untouched
    for f in CLASSIC_FILES:
        check(f'classic {f} byte-identical to the baseline', filecmp.cmp(WORLD / f, base / f, shallow=False))
    W = json.load(open(WORLD / 'world.json'))
    W0 = json.load(open(base / 'world.json'))
    check('world.json entries 0..8974 equal the baseline row for row', W['entries'] == W0['entries'] and len(W['entries']) == 8975,
          f"{len(W['entries'])} entries")

    # 2. terrain.json
    T = json.load(open(WORLD / 'terrain.json'))
    G0 = T['genBase']
    n = T['count']
    check('terrain v1, genBase is world.json\'s entry count', T['v'] == 1 and G0 == len(W['entries']) == 8975 and T['genVersion'] >= 1)
    check('every row has 11 fields', all(len(r) == 11 for r in T['entries']) and len(T['entries']) == n, f'{n} entries')
    gb, gget = tiles(WORLD / 'atlas_gen.png', T['cols'])
    gt, gtget = tiles(WORLD / 'atlas_gen_top.png', T['cols'])
    check('atlas_gen.png and atlas_gen_top.png cover every entry', gb.shape == gt.shape and
          (gb.shape[0] // 16) * T['cols'] >= n and gb.shape[1] == T['cols'] * 16, f'{gb.shape[1]}x{gb.shape[0]}')
    ab, aget = tiles(WORLD / 'atlas.png', W['cols'])
    at, atget = tiles(WORLD / 'atlas_top.png', W['cols'])
    def below(i):
        return gget(i - G0) if i >= G0 else aget(i)
    def above(i):
        return gtget(i - G0) if i >= G0 else atget(i)
    flags = [r[6] for r in T['entries']]
    check('the top flag matches atlas_gen_top.png', all(bool(flags[k]) == bool(gtget(k)[:, :, 3].any()) for k in range(n)))
    valid = lambda i: (0 <= i < G0) or (G0 <= i < G0 + n)
    refs = [i for d in T['ventry'].values() for i in d.values()] + [i for d in T['ovl'].values() for i in d.values()] + \
        [int(k) for k in T['home']] + list(T['home'].values()) + list(T['homeGround'].values())
    for s in T['quarter']['sets'].values():
        for rr in s['recolours'].values():
            refs += rr['home'] + (rr['ov'] or [])
    check('every reference is inside the tables', all(valid(i) for i in refs), f'{len(refs)} references')
    ov_rows = [G0 + k for k, r in enumerate(T['entries']) if r[10] == 1]
    check('every overlay row has a home and a home ground', set(ov_rows) == {int(k) for k in T['home']} == {int(k) for k in T['homeGround']},
          f'{len(ov_rows)} overlays')
    check('ventry and ovl rows carry their variant and source', all(T['entries'][i - G0][9] == int(v) for v, d in T['ventry'].items()
                                                                     for i in d.values() if i >= G0) and
          all(T['entries'][i - G0][9] == int(v) and T['entries'][i - G0][10] == 1 for v, d in T['ovl'].items() for i in d.values()))

    # 3. the overlay test (strict count, build_terrain.ov_counts)
    OT = T['overlayTest']
    sets = {k: {tuple(c) for c in v} for k, v in OT['groundSets'].items()}
    lim = 0.03 * 256
    worst, worst_raw, worst_loose, n_through, bad, top_bad, plain_bad = 0, 0, 0, 0, [], [], []
    from collections import Counter
    ctx = {}
    for i in ov_rows:
        home, g = T['home'][str(i)], T['homeGround'][str(i)]
        gset = sets[OT['family'][str(i)]]
        under = below(g)
        basec = Counter(tuple(int(v) for v in p[:3]) for p in under.reshape(-1, 4)).most_common(1)[0][0]
        ctx[i] = (below(home), under, gset, basec)
        c = BT.ov_counts(below(i), under, below(home), gset, basec)
        worst, worst_raw, worst_loose = max(worst, c['strict']), max(worst_raw, c['raw']), max(worst_loose, c['loose'])
        n_through += c['through'] > 0
        if c['strict'] > lim:
            bad.append((i, c['strict']))
        if c['plain']:
            plain_bad.append((i, c['plain']))
        if not np.array_equal(above(i), above(home)):
            top_bad.append(i)
    raw_over = sum(1 for r in OT['items'] if r[2] > lim)
    check('every overlay over its home ground within 3% of its home entry, counted strictly', not bad,
          f'{len(ov_rows)} overlays, worst {worst} px of 256 ({worst / 2.56:.1f}%); {n_through} show some ground texture '
          f'through a shadow or rim; with loose tufts too: worst {worst_raw} px, {raw_over} over 3%, loose tufts at most '
          f'{worst_loose} px; over the limit: {bad[:6]}')
    check('every overlay over its plain ground colour reproduces its home at every non-transparent pixel', not plain_bad,
          f'{plain_bad[:6]}')
    check('every overlay has its home entry\'s top layer', not top_bad, f'{top_bad[:6]}')
    check('the stored overlay report equals the recount', [r[1] for r in OT['items']] ==
          [BT.ov_counts(below(i), ctx[i][1], ctx[i][0], ctx[i][2], ctx[i][3])['strict'] for i in ov_rows] and
          OT['worstPixels'] == worst and OT['worstRawPixels'] == worst_raw)
    # negative controls
    caught = 0
    for src in ('28', '104'):
        i = T['ovl']['0'][src]
        broken = below(i).copy()
        broken[broken[:, :, 3] == 255] = 0
        H, U, gset, basec = ctx[i]
        if BT.ov_counts(broken, U, H, gset, basec)['strict'] > lim:
            caught += 1
    check('negative control: an overlay with its object removed fails the test', caught == 2)
    n_delta, unseen_drop, unseen_mag, drop_fail, delta_px = 0, [], [], 0, 0
    for i in ov_rows:
        O = below(i)
        dm = (O[:, :, 3] > 0) & (O[:, :, 3] < 255)
        if not dm.any():
            continue
        n_delta += 1
        delta_px += int(dm.sum())
        H, U, gset, basec = ctx[i]
        base_n = BT.ov_counts(O, U, H, gset, basec)['strict']
        # dropped: each delta pixel then shows the ground tile; it must be counted wherever that differs from home
        dropped = O.copy()
        dropped[dm] = 0
        visible = int((dm & (np.abs(H[:, :, :3].astype(int) - U[:, :, :3].astype(int)).max(2) > BT.PIX_TOL)).sum())
        nd = BT.ov_counts(dropped, U, H, gset, basec)['strict']
        if nd < visible:
            unseen_drop.append((i, visible, nd))
        drop_fail += nd > lim
        mag = O.copy()
        mag[dm] = (255, 0, 255, 255)
        nm = BT.ov_counts(mag, U, H, gset, basec)['strict']
        if nm < int(dm.sum()):
            unseen_mag.append((i, int(dm.sum()), nm))
    check('negative control: removing the shadow and rim (delta) pixels is counted at every one that shows', not unseen_drop,
          f'{n_delta} overlays with {delta_px} delta pixels; {drop_fail} of them then fail the 3% test; misses {unseen_drop[:4]}')
    check('negative control: painting the delta pixels magenta is counted at every one', not unseen_mag, f'{unseen_mag[:4]}')

    # 4. quarter sets
    E = W['entries']
    Q = T['quarter']
    check('47 blob codes and a 256-entry lookup', len(Q['codes']) == 47 and len(Q['lut']) == 256 and
          sorted(set(Q['lut'])) == list(range(47)))
    ok47 = all(len(rr['home']) == 47 and (rr['ov'] is None or len(rr['ov']) == 47)
               for s in Q['sets'].values() for rr in s['recolours'].values())
    ground_sets = [(sid, r) for sid, s in Q['sets'].items() for r, rr in s['recolours'].items() if s['outside'] == 'ground' and not rr['ov']]
    check('every set and recolour has 47 home entries, and 47 overlays when its outside is the ground', ok47 and not ground_sets)
    # recompose identity codes from General's pieces (quarters by state), independently of build_terrain's compose
    EP = {'tl': {1: 't', 2: 'l', 3: 'tl'}, 'tr': {1: 't', 2: 'r', 3: 'tr'}, 'bl': {1: 'b', 2: 'l', 3: 'bl'}, 'br': {1: 'b', 2: 'r', 3: 'br'}}
    QXY = {'tl': (0, 0), 'tr': (0, 8), 'bl': (8, 0), 'br': (8, 8)}
    mism, pure, copies, copy_bad = 0, 0, 0, []
    for sid, s in Q['sets'].items():
        if s['innerSynth']:
            continue
        P = s['pieces']
        homes = s['recolours'][next(iter(s['recolours']))]['home']
        for ci, st in enumerate(Q['codes']):
            img = np.zeros((16, 16, 4), np.uint8)
            for q, state in zip(('tl', 'tr', 'bl', 'br'), st):
                mid = P['c'] if state == 0 else s['inner'][q] if state == 4 else P[EP[q][state]]
                y0, x0 = QXY[q]
                img[y0:y0 + 8, x0:x0 + 8] = aget(mid)[y0:y0 + 8, x0:x0 + 8]
            if not np.array_equal(img, below(homes[ci])):
                mism += 1
            m = s['ident'][ci]
            if homes[ci] < 640:
                pure += 1
                if m != homes[ci]:
                    copy_bad.append((sid, ci, 'General entry is not the identity piece'))
            elif m >= 0:
                copies += 1
                r = T['entries'][homes[ci] - G0]
                if r[0] != m or r[8] != m or not np.array_equal(below(homes[ci]), aget(m)) or not np.array_equal(above(homes[ci]), atget(m)):
                    copy_bad.append((sid, ci, homes[ci], m))
    check('identity codes of A, B and C equal their recomposition from General pieces', mism == 0 and not copy_bad,
          f'{pure} of them are General entries, {copies} are copies with the set\'s metadata {copy_bad[:4]}')
    def meta(e):
        r = E[e] if e < G0 else T['entries'][e - G0]
        return (r[2], r[3], r[4], r[7])
    nonuni = []
    for sid, s in Q['sets'].items():
        for rn, rr in s['recolours'].items():
            ms = {meta(e) for e in rr['home'] + (rr['ov'] or [])}
            if len(ms) != 1 or next(iter(ms))[2] != rr['mat']:
                nonuni.append((sid, rn, sorted(ms, key=str)))
    check('every code of a set recolour has one behaviour, collision, material and encounter flag', not nonuni,
          '; '.join(f"{sid} {rn} {hex(meta(rr['home'][0])[0])} {rr['mat']}" for sid, s in Q['sets'].items()
                    for rn, rr in s['recolours'].items() if sid in 'AB') + f' {nonuni[:3]}')
    # the lookup agrees with the code rule on all 256 neighbourhoods
    check('the 256-entry lookup gives the code of each neighbourhood', all(Q['codes'][Q['lut'][nb]] == list(BT.quarter_states(nb))
                                                                            for nb in range(256)))

    # 5. learned tables
    A0 = json.load(open(WORLD / 'autotile.json'))
    L = T['learned']
    check('learned rock tables equal autotile.json (world.reedgeCliffs)', all(L['rock'][k] == A0[k] for k in ('r1', 'r2', 'g1', 'g2')) and
          L['rock']['compat'] == A0['compat'])
    miss = 0
    for fam in ('rock', 'ledge'):
        for nb in range(256):
            k1 = ((nb >> 4) << 5) | (1 << 4) | (nb & 15)
            for g in ('g', 's'):
                m, lv = BT.lookup(L[fam], -1, k1, g)
                if m is None:
                    miss += 1
    check('no 3x3 pattern misses after the fill (rock and ledge, both contexts)', miss == 0, f'{2 * 2 * 256} lookups')
    check('every ledge member is a ledge', all(E[m][2] in (0x38, 0x39, 0x3A, 0x3B) and E[m][4] == 'ledge' for m in L['ledge']['members']),
          f"{len(L['ledge']['members'])} members, {len(L['ledge']['r2'])} 5x5 and {len(L['ledge']['r1'])} 3x3 patterns")

    par = json.loads(subprocess.run(['node', str(HERE / 'tools' / 'gen_tests' / 'lookup_parity.mjs')], check=True,
                                    capture_output=True, text=True).stdout)
    pdiff, nnull, nfill = [], 0, 0
    for k2, k1, g, pick in par['cells']:
        m, _ = BT.lookup(L['rock'], k2, k1, g, classic=True)
        if m != pick:
            pdiff.append((k2, k1, g, pick, m))
        if pick is None:
            nnull += 1
            nfill += BT.lookup(L['rock'], k2, k1, g)[0] is not None
    check('lookup(classic=True) picks what world.reedgeCliffs picks', not pdiff and len(par['cells']) > 10000,
          f"{len(par['cells'])} rock cells of 24 masks; {nnull} with no pick in the game (left as they are), all of which "
          f"the full lookup's fill would paint ({nfill}): that change is for generated layouts only; {pdiff[:3]}")

    # 6. vocabulary and variant coverage
    V = T['vocab']
    expect = {'grass': ({0}, {'floor'}), 'tallGrass': ({2}, {'tallgrass'}), 'flower': (None, {'flower'}), 'bush': (None, {'bush'}),
              'treeCrown': (None, {'tree'}), 'treeBase': (None, {'tree'}), 'rock': (None, {'rock'}), 'boulder': (None, {'boulder'}),
              'ledge': ({0x38, 0x39, 0x3A, 0x3B}, {'ledge'}), 'sand': ({0x21}, {'sand'}), 'sea': ({0x15}, {'water'}),
              'pond': ({0x16}, {'water'}), 'sandPath': ({0}, {'floor'}), 'caveMouth': ({0x60}, {'door'})}
    vbad = [(k, m) for k, (b, mt) in expect.items() for m in V[k] if (b and E[m][2] not in b) or (mt and E[m][4] not in mt)]
    check('vocabulary ids have their behaviour and material', not vbad, ', '.join(f'{k} {len(V[k])}' for k in expect))
    var = {r['name']: r['id'] for r in T['variants']}
    tsrc = V['grass'] + V['tallGrass'] + V['tallGrassBase'] + V['flower'] + V['bush']
    tnames = [t for t in ('cool', 'dry', 'lush', 'swamp')] + [f'{t}_band{k}' for t in ('cool', 'dry', 'lush', 'swamp') for k in (1, 2)]
    check('every tint and band covers every tinted piece', all(str(m) in T['ventry'][str(var[t])] for t in tnames for m in tsrc),
          f'{len(tnames)} variants x {len(tsrc)} pieces')
    rp = sorted(set(V['rock'] + V['ledge'] + V['boulder'] + V['caveMouth'] + V['mountainPath']))
    check('every rock style covers every rock, ledge, boulder, mouth and mountain-path piece',
          all(str(m) in T['ventry'][str(var[f'rock_{s}'])] for s in ('grey', 'snowy', 'sandstone') for m in rp), f'{len(rp)} pieces')
    gm = []
    for style, beh, mat, srcs in (('snowy', 0x21, 'snow', V['grassPlain'] + V['sandPlain']), ('sandstone', 0x21, 'sand', V['grassPlain']),
                                  ('sandstone', 0, 'floor', V['sandPlain']), ('grey', 0, 'floor', V['grassPlain'] + V['sandPlain'])):
        for m in srcs:
            r = T['entries'][T['ventry'][str(var[f'rock_{style}'])][str(m)] - G0]
            if (r[2], r[4]) != (beh, mat):
                gm.append((style, m, hex(r[2]), r[4]))
    bs = T['entries'][T['quarter']['sets']['B']['recolours']['snow']['home'][0] - G0]
    check('rock-style grounds have the material they show (snow; desert sand; gravel, pale stone and cool grass as floor)', not gm and
          (bs[2], bs[4]) == (0x21, 'snow'), f'{gm[:4]}')
    check('the hub pairs are the four temperate pairs', T['hubPairs'] == [['temperate', t] for t in ('cool', 'dry', 'lush', 'swamp')])

    # 8. stage 2b
    sp = T['species']
    lat = [str(m) for m in T['lattice']]
    miss, metab = [], []
    for name, rec in sp.items():
        for m in lat:
            h, o = rec['home'].get(m), rec['ov'].get(m)
            if h is None or o is None:
                miss.append((name, m))
                continue
            if meta(h) != (E[int(m)][2], E[int(m)][3], E[int(m)][4], E[int(m)][7]) or meta(o) != meta(h):
                metab.append((name, m))
            if T['home'].get(str(o)) != h or (h >= G0 and T['entries'][h - G0][9] != rec['var']):
                metab.append((name, m, 'link'))
    check('every species has every lattice piece, home and overlay, with General\'s tree metadata',
          sorted(lat) == sorted(str(m) for m in (14, 15, 20, 21, 22, 23, 28, 29, 30, 31, 36, 37, 38, 39)) and len(sp) == 9
          and not miss and not metab, f'{len(sp)} species x {len(lat)} pieces; {miss[:3]} {metab[:3]}')
    def sil(name, mids=('14', '15', '30', '31', '38', '39')):
        return np.concatenate([(below(sp[name]['ov'][m])[:, :, 3] > 0) | (above(sp[name]['ov'][m])[:, :, 3] > 0) for m in mids], 1)
    def npix(a, b):
        return int((a != b).sum())
    shape_d = {(a, b): npix(sil(a), sil(b)) for a, b in (('oak', 'round_oak'), ('oak', 'acacia'), ('round_oak', 'acacia'))}
    def unexplained(a, b):
        """Pixels of species a's 14 home pieces that no recolour of species b's explains: for each colour of b, the
        commonest colour of a at those pixels is the recolour; every other pixel is a change of shape (a trunk, vines,
        snow)."""
        pa = np.concatenate([np.concatenate([below(sp[a]['home'][m]), above(sp[a]['home'][m])], 0) for m in lat], 1)
        pb = np.concatenate([np.concatenate([below(sp[b]['home'][m]), above(sp[b]['home'][m])], 0) for m in lat], 1)
        ka = pa.reshape(-1, 4).astype(np.int64) @ np.array([1 << 24, 1 << 16, 1 << 8, 1])
        kb = pb.reshape(-1, 4).astype(np.int64) @ np.array([1 << 24, 1 << 16, 1 << 8, 1])
        n = 0
        for c in np.unique(kb):
            sel = ka[kb == c]
            n += int(len(sel) - np.unique(sel, return_counts=True)[1].max())
        return n
    told = {k: unexplained(k, ref) for k, ref in (('birch', 'round_oak'), ('jungle', 'round_oak'), ('swamp_oak', 'round_oak'),
                                                  ('dark_oak', 'round_oak'), ('snowy_spruce', 'spruce'))}
    check('species are told apart by shape: three crown silhouettes; jungle\'s trunk and vines and swamp oak\'s vines are more than a recolour, birch\'s white trunk has its black marks',
          all(v > 40 for v in shape_d.values()) and told['jungle'] > 100 and told['swamp_oak'] > 100 and told['birch'] >= 4,
          f'silhouette pixels differing {shape_d}; pixels no recolour of the round oak (or spruce) explains {told}')
    O = T['ores']
    kinds = list(W['ores'])
    faces = BT.ore_faces(L['rock'])
    obad, n_ore, n_reused = [], 0, 0
    for style, rs in T['rockStyles'].items():
        for f in faces:
            plain = f if rs['var'] == 0 else T['ventry'][str(rs['var'])][str(f)]
            row = O['entries'].get(style, {}).get(str(f), {})
            for k in kinds:
                e = row.get(k)
                n_ore += 1
                r = None if e is None else (E[e] if e < G0 else T['entries'][e - G0])
                if r is None or r[4] != k or r[5] != plain:
                    obad.append((style, f, k, e))
                n_reused += e is not None and e < G0
    check('every (rock style, interior face, ore) has an entry whose base is the style\'s plain face',
          O['kinds'] == kinds and O['faces'] == faces and not obad,
          f'{len(T["rockStyles"])} styles x {len(faces)} faces x {len(kinds)} ores = {n_ore} ({n_reused} are Kanto\'s own '
          f'entries); {obad[:3]}')
    inner = [dy * 5 + dx for dy in (1, 2, 3) for dx in (1, 2, 3)]
    cbad, n_c, n_fam = [], 0, 0
    for fam in ('cave:Cave', 'cave:RockTunnel', 'cave:SeafoamIslands'):
        F = A0['families'][fam]
        wall = sorted({int(v[0]) for k, v in F['r2'].items() if all((int(k) >> (24 - i)) & 1 for i in inner)} | {int(F['r1']['511'][0])})
        got = O['caves'].get(fam, {})
        if sorted(int(f) for f in got) != wall:
            cbad.append((fam, 'faces'))
        n_fam += len(wall)
        for f in wall:
            for k in kinds:
                e = got.get(str(f), {}).get(k)
                n_c += 1
                r = None if e is None else (E[e] if e < G0 else T['entries'][e - G0])
                if r is None or r[4] != k or r[5] != f:
                    cbad.append((fam, f, k, e))
    check('every interior wall piece of the three cave families has every ore, based on that piece', not cbad,
          f'{n_fam} wall pieces x {len(kinds)} ores = {n_c}; made here: {O["counts"]["caveMade"]}; {cbad[:3]}')
    SY = T['synth']
    gbad = [(g, e) for g, ents in SY['grounds'].items() for e in ents
            if meta(e)[2] != {'snow': 'snow', 'ice': 'ice', 'mud': 'mud', 'podzol': 'podzol', 'clay': 'clay', 'sand': 'sand',
                              'grass': 'floor'}[g]]
    sbad = [n for n, r in SY['sprites'].items() if T['home'].get(str(r['ov'])) != r['home'] or meta(r['ov']) != meta(r['home'])]
    check('synthesized grounds have their materials; every decoration sprite has a home entry and an overlay',
          not gbad and not sbad and set(SY['sprites']) == {'cactus', 'cactus_top', 'dead_bush', 'sugar_cane', 'lily_pad',
                                                            'pumpkin', 'melon'},
          f"{', '.join(f'{g} {len(v)}' for g, v in SY['grounds'].items())}; {gbad[:3]} {sbad[:3]}")

    # 7. determinism
    own = not args.scratch
    scratch = Path(args.scratch) if args.scratch else HERE / 'out' / 'gen-tests' / 'terrain_check'
    outs = []
    for k in (1, 2):
        d = scratch / f'terrain_run{k}'
        d.mkdir(parents=True, exist_ok=True)
        subprocess.run([sys.executable, '-B', str(HERE / 'tools' / 'build_terrain.py'), str(d)], check=True, capture_output=True)
        outs.append(d)
    same = all(filecmp.cmp(outs[0] / f, outs[1] / f, shallow=False) and filecmp.cmp(outs[0] / f, WORLD / f, shallow=False)
               for f in ('terrain.json', 'atlas_gen.png', 'atlas_gen_top.png'))
    check('two builds are byte-identical, and equal the committed files', same)
    if own:
        shutil.rmtree(scratch, ignore_errors=True)
        try:
            scratch.parent.rmdir()
        except OSError:
            pass

    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)} ok, {len(failed)} failed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
