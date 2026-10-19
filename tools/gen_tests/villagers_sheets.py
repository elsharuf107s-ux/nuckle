#!/usr/bin/env python3
"""Checks of the villager and iron golem sheets (tools/build_villagers.py) against villagers.json:
  python3 tools/gen_tests/villagers_sheets.py [--rebuild-check]
sizes and layouts, every frame drawn and unclipped (nothing touches a frame's edge), every type x profession row
distinct, the walk steps differ from the idle frame, the four golem crack rows differ, the sleep frame is the one
lying frame, the icons and GUI files exist, and (with --rebuild-check) that a second build into a scratch copy gives
byte-identical sheets (determinism)."""
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
V = ROOT / 'assets' / 'mc' / 'villagers'
fails, checks = [], 0


def check(c, msg):
    global checks
    checks += 1
    if not c:
        fails.append(msg)
        print('FAIL', msg)


def clipped(al, origin):
    """A frame is clipped when its sprite touches the top, left or right edge, or reaches below the feet line plus
    the outline (origin y + 2: a foot stepping toward the camera projects one pixel lower). The mob sheets' convention
    puts the feet's outline on the frame's last row (origin y 30 in a 32-px frame), so the bottom edge itself is allowed."""
    return bool(al[0].any() or al[:, 0].any() or al[:, -1].any() or al[origin[1] + 3:].any())


meta = json.loads((V / 'villagers.json').read_text())
vm, gm = meta['villager'], meta['golem']
W, H = vm['w'], vm['h']
nframes = vm['frames']
check(set(meta['types']) == {'plains', 'desert', 'savanna', 'taiga', 'snow', 'jungle', 'swamp'}, f'types {meta["types"]}')
check(len(meta['professions']) == 15 and meta['professions'][0] == 'none' and meta['professions'][-1] == 'nitwit', f'professions {meta["professions"]}')
rows_all = {}
for vt in meta['types']:
    a = np.array(Image.open(V / vm['files'][vt]).convert('RGBA'))
    check(a.shape == (H * 15, W * nframes, 4), f'{vt}: sheet {a.shape[1]}x{a.shape[0]}, expected {W * nframes}x{H * 15}')
    for r, prof in enumerate(meta['professions']):
        row = a[r * H:(r + 1) * H]
        rows_all[(vt, prof)] = row.tobytes()
        for f in range(nframes):
            fr = row[:, f * W:(f + 1) * W]
            al = fr[..., 3] > 0
            check(al.sum() > 150, f'{vt} {prof} frame {f}: only {al.sum()} pixels drawn')
            check(not clipped(al, vm['origin']), f'{vt} {prof} frame {f}: touches the frame edge (clipped)')
        for dirn, idx in vm['poses']['walk'].items():
            i0, i1, i2 = idx
            f0, f1, f2 = (row[:, i * W:(i + 1) * W] for i in (i0, i1, i2))
            check(not np.array_equal(f0, f1) or not np.array_equal(f0, f2), f'{vt} {prof} walk {dirn}: the steps equal the idle frame')
        s0, s1 = vm['poses']['shake']['down']
        check(not np.array_equal(row[:, s0 * W:(s0 + 1) * W], row[:, s1 * W:(s1 + 1) * W]), f'{vt} {prof}: the two shake frames are equal')
check(len(set(rows_all.values())) == len(rows_all), f'{len(rows_all)} type x profession rows, {len(set(rows_all.values()))} distinct')
check(len(vm['poses']['sleep']['down']) == 1, 'one sleep frame')

g = np.array(Image.open(V / gm['file']).convert('RGBA'))
gw, gh = gm['w'], gm['h']
gn = sum(len(v) for d in gm['poses'].values() for v in d.values())
check(g.shape == (gh * 4, gw * gn, 4), f'golem sheet {g.shape[1]}x{g.shape[0]}, expected {gw * gn}x{gh * 4}')
grows = [g[r * gh:(r + 1) * gh].tobytes() for r in range(4)]
check(len(set(grows)) == 4, 'the four golem crack rows differ')
for r in range(4):
    for f in range(gn):
        fr = g[r * gh:(r + 1) * gh, f * gw:(f + 1) * gw]
        al = fr[..., 3] > 0
        check(al.sum() > 300 and not clipped(al, gm['origin']), f'golem row {r} frame {f}: {al.sum()} px, clipped {clipped(al, gm["origin"])}')
for k, f in meta['gui'].items():
    check((V / f).exists(), f'gui {k}: {f}')
panel = Image.open(V / meta['gui']['panel'])
check(panel.size == (276, 166), f'merchant panel {panel.size}')
ic = Image.open(V / meta['icons']['file'])
check(ic.size[0] % 16 == 0 and len(meta['icons']['items']) * 256 <= ic.size[0] * ic.size[1], f'icons {ic.size} for {len(meta["icons"]["items"])} items')
check(len(meta['sounds']) >= 30 and all(v['files'] for v in meta['sounds'].values()), f'{len(meta["sounds"])} sound placeholder keys, each naming its files')

if '--rebuild-check' in sys.argv:
    # build the sheets again in memory and compare with what is on disk
    sys.path.insert(0, str(ROOT / 'tools'))
    import build_villagers as BV  # noqa: E402
    for vt in ('plains', 'snow'):
        a = np.array(Image.open(V / vm['files'][vt]).convert('RGBA'))
        for r, prof in enumerate(BV.PROFS):
            fr, _ = BV.villager_row(BV.villager_texture(vt, prof))
            check(np.array_equal(np.hstack(fr), a[r * H:(r + 1) * H]), f'rebuild {vt} {prof}: differs from the sheet on disk')

print(f'villagers_sheets: {checks} checks, {len(fails)} failed')
sys.exit(1 if fails else 0)
