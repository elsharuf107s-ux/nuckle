#!/usr/bin/env python3
"""Hash checks for setup.sh.

  python3 tools/verify.py paths <source>        print the sparse-checkout paths of one upstream (tools/upstream-inputs.tsv)
  python3 tools/verify.py inputs [<source>]     check the upstream files the build reads against tools/upstream-inputs.tsv
  python3 tools/verify.py assets [--quiet]      check every built file in assets/ against tools/assets.tsv
  python3 tools/verify.py record                rewrite tools/assets.tsv from the files in assets/ (after changing a tool)

Sources: pokefirered and pokeemerald-expansion (git checkouts in vendor/) and minecraft (vendor/minecraft).
Exit status 0 means everything matched.

An asset matches when its bytes have the recorded SHA-1. When they do not, a looser check that ignores how the
file was encoded still accepts it: a PNG's decoded pixels, a JSON file's parsed content (numbers to 2 decimals),
or, for the few sounds ffmpeg encodes (the music and two cries), the sound's length. Those can differ in bytes with
another Pillow, zlib, ffmpeg or libopus.
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INPUTS = ROOT / 'tools' / 'upstream-inputs.tsv'
ASSETS = ROOT / 'tools' / 'assets.tsv'
SOURCES = {'pokefirered': ROOT / 'vendor' / 'pokefirered', 'pokeemerald-expansion': ROOT / 'vendor' / 'pokeemerald-expansion',
           'minecraft': ROOT / 'vendor' / 'minecraft'}
# files ffmpeg encodes: compared by length when the bytes differ
ENCODED_AUDIO = ('assets/music/', 'assets/cries/ender_dragon.wav', 'assets/cries/wither.wav')
ASSETS_HEADER = """# Every file setup.sh builds into assets/: path, SHA-1, size in bytes, and a looser check used when the bytes differ:
# png:<mode>:<w>x<h>:<SHA-1 of the RGBA pixels>, json:<SHA-1 of the parsed content>, audio:<length in seconds>, or -.
# Reference build: macOS, Python 3.13, numpy 2.2.2, Pillow 11.1.0, ffmpeg 8.1 with libopus.
"""


def rows(path):
    for line in path.read_text().splitlines():
        if line and not line.startswith('#'):
            yield line.split('\t')


def sha1(path):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


# ---------------------------------------------------------------- upstream inputs
def cmd_paths(source):
    for src, path, _, _ in rows(INPUTS):
        if src == source:
            print('/' + path)
    return 0


def cmd_inputs(only=None):
    bad = n = 0
    for src, path, want, size in rows(INPUTS):
        if only and src != only:
            continue
        n += 1
        f = SOURCES[src] / path
        if not f.is_file():
            print(f'missing   vendor/{SOURCES[src].name}/{path}')
            bad += 1
        elif f.stat().st_size != int(size) or sha1(f) != want:
            print(f'mismatch  vendor/{SOURCES[src].name}/{path}')
            bad += 1
    print(f'upstream inputs{" in " + only if only else ""}: {n - bad}/{n} match their SHA-1')
    return 1 if bad else 0


# ---------------------------------------------------------------- loose keys
def png_key(f):
    from PIL import Image
    with Image.open(f) as im:
        return 'png:%s:%dx%d:%s' % (im.mode, im.size[0], im.size[1], hashlib.sha1(im.convert('RGBA').tobytes()).hexdigest())


def _rounded(v):
    if isinstance(v, float):
        return round(v, 2)
    if isinstance(v, dict):
        return {k: _rounded(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_rounded(x) for x in v]
    return v


def json_key(f):
    data = _rounded(json.loads(Path(f).read_text()))
    return 'json:' + hashlib.sha1(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def audio_seconds(f):
    b = Path(f).read_bytes()
    if b[:4] == b'RIFF' and b[8:12] == b'WAVE':
        i, fmt, data = 12, None, None
        while i + 8 <= len(b):
            cid, n = b[i:i + 4], struct.unpack('<I', b[i + 4:i + 8])[0]
            if cid == b'fmt ':
                fmt = struct.unpack('<HHIIHH', b[i + 8:i + 24])
            elif cid == b'data':
                data = n
            i += 8 + n + (n & 1)
        if fmt and data is not None:
            return data / fmt[3]          # bytes / (bytes per second)
    if b[:4] == b'OggS':
        i, granule, pre = 0, 0, 0
        while i + 27 <= len(b) and b[i:i + 4] == b'OggS':      # walk the pages: the last granule position is the length
            nseg = b[i + 26]
            body = i + 27 + nseg
            if i == 0 and b[body:body + 8] == b'OpusHead':
                pre = struct.unpack('<H', b[body + 10:body + 12])[0]
            g = struct.unpack('<q', b[i + 6:i + 14])[0]
            if g >= 0:
                granule = g
            i = body + sum(b[i + 27:body])
        return (granule - pre) / 48000
    return None


def loose_key(path, f):
    if path.endswith('.png'):
        return png_key(f)
    if path.endswith('.json'):
        return json_key(f)
    if path.startswith(ENCODED_AUDIO):
        s = audio_seconds(f)
        return '-' if s is None else 'audio:%.3f' % s
    return '-'


def loose_match(want, f):
    if want == '-':
        return False
    if want.startswith('audio:'):
        s = audio_seconds(f)
        return s is not None and abs(s - float(want[6:])) <= 0.05
    try:
        return (png_key(f) if want.startswith('png:') else json_key(f)) == want
    except Exception:
        return False


# ---------------------------------------------------------------- built assets
def built_files():
    base = ROOT / 'assets'
    if not base.is_dir():
        return []
    return sorted(str(p.relative_to(ROOT)).replace('\\', '/') for p in base.rglob('*') if p.is_file() and p.name != '.DS_Store')


def cmd_assets(quiet=False):
    exact = loose = 0
    bad, notes = [], []
    listed = set()
    for path, want, size, key in rows(ASSETS):
        listed.add(path)
        f = ROOT / path
        if not f.is_file():
            bad.append(f'missing   {path}')
        elif f.stat().st_size == int(size) and sha1(f) == want:
            exact += 1
        elif loose_match(key, f):
            loose += 1
            notes.append(f'{key.split(":")[0]:9s} {path} (same content, encoded differently)')
        else:
            bad.append(f'mismatch  {path}')
    extra = [p for p in built_files() if p not in listed]
    if not quiet:
        for line in notes:
            print(line)
    if not quiet or bad or extra:
        for line in bad:
            print(line)
        for p in extra:
            print(f'extra     {p}')
        print(f'assets: {exact}/{len(listed)} byte-identical, {loose} same content, {len(bad)} missing or wrong, {len(extra)} unexpected')
    return 1 if bad or extra else 0


def cmd_record():
    out = [ASSETS_HEADER.rstrip('\n')]
    for path in built_files():
        f = ROOT / path
        out.append('\t'.join([path, sha1(f), str(f.stat().st_size), loose_key(path, f)]))
    ASSETS.write_text('\n'.join(out) + '\n')
    print(f'wrote {ASSETS.relative_to(ROOT)}: {len(out) - 1} files')
    return 0


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['paths'] and len(args) == 2 and args[1] in SOURCES:
        sys.exit(cmd_paths(args[1]))
    if args[:1] == ['inputs'] and (len(args) == 1 or (len(args) == 2 and args[1] in SOURCES)):
        sys.exit(cmd_inputs(*args[1:]))
    if args[:1] == ['assets']:
        sys.exit(cmd_assets('--quiet' in args))
    if args == ['record']:
        sys.exit(cmd_record())
    print(__doc__.strip())
    sys.exit(2)
