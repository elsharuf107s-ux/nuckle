#!/usr/bin/env python3
"""Fetch the Minecraft 1.21.4 files the build reads from Mojang's servers, checking every file's SHA-1.

  python3 tools/fetch_minecraft.py              fetch whatever is missing or does not match
  python3 tools/fetch_minecraft.py --refresh    extract the textures again even if they look complete
  python3 tools/fetch_minecraft.py --keep-jar   keep vendor/minecraft/client.jar after extracting its textures

Writes vendor/minecraft/:
  1.21.4.json                        the version file, found through Mojang's version manifest (SHA-1 pinned below)
  index19.json                       the asset index that version names (SHA-1 pinned)
  jar/assets/minecraft/textures/**   every texture in client.jar (the jar's SHA-1 and size are pinned); nothing else
                                     in the jar is extracted, and the jar is deleted afterwards
  sounds.json                        the sound events, from the asset index
  sounds/**.ogg                      the sounds tools/minecraft-sounds.txt lists, each checked against the asset index;
                                     any other .ogg under sounds/ is removed, so the build sees exactly that list

Downloads go through curl, which uses the system's certificates. Nothing is ever downloaded from anywhere but
piston-meta.mojang.com, piston-data.mojang.com and resources.download.minecraft.net.
"""
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MCV = ROOT / 'vendor' / 'minecraft'
SOUND_LIST = ROOT / 'tools' / 'minecraft-sounds.txt'

VERSION = '1.21.4'
MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
VERSION_SHA1 = 'b547a27fc4d490dc10d62e40a42ace065162b644'
CLIENT_SHA1 = 'a7e5a6024bfd3cd614625aa05629adf760020304'
CLIENT_SIZE = 28335587
INDEX_ID = '19'
INDEX_SHA1 = 'dc6757fadfa8abf306e90465661ec4a7dcd3386a'
SOUNDS_JSON_SHA1 = '046b51113a9c1b83b385549a54b53bef94636015'
RESOURCES = 'https://resources.download.minecraft.net'
ALLOWED = ('https://piston-meta.mojang.com/', 'https://piston-data.mojang.com/', RESOURCES + '/')
TEXTURES = 'assets/minecraft/textures/'
TEXTURE_COUNT = 3297
TEX_DIR = MCV / 'jar' / TEXTURES
TEX_MARK = MCV / 'jar' / '.textures-complete'   # holds the jar's SHA-1 once every texture is extracted


def die(msg):
    sys.exit(f'fetch_minecraft: {msg}')


def sha1_file(p):
    h = hashlib.sha1()
    with open(p, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def download(url, dst, sha1, size=None):
    """Download url to dst unless dst already has this SHA-1. Returns True when it downloaded."""
    if not url.startswith(ALLOWED):
        die(f'refusing to download from {url}')
    if dst.is_file() and (size is None or dst.stat().st_size == size) and sha1_file(dst) == sha1:
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + '.part')
    r = subprocess.run(['curl', '-fsSL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20',
                        '--max-time', '900', '-o', str(tmp), url])
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        die(f'download failed (curl exit {r.returncode}): {url}')
    got = sha1_file(tmp)
    if got != sha1 or (size is not None and tmp.stat().st_size != size):
        tmp.unlink()
        die(f'{url}: SHA-1 {got}, expected {sha1}')
    tmp.replace(dst)
    return True


def version_file():
    dst = MCV / f'{VERSION}.json'
    if dst.is_file() and sha1_file(dst) == VERSION_SHA1:
        return json.loads(dst.read_text())
    MCV.mkdir(parents=True, exist_ok=True)
    tmp = MCV / '.manifest.json.part'
    r = subprocess.run(['curl', '-fsSL', '--retry', '3', '--connect-timeout', '20', '--max-time', '120', '-o', str(tmp), MANIFEST_URL])
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        die(f'could not fetch the version manifest {MANIFEST_URL}')
    manifest = json.loads(tmp.read_text())
    tmp.unlink()
    entry = next((v for v in manifest['versions'] if v['id'] == VERSION), None)
    if entry is None:
        die(f'the version manifest does not list {VERSION}')
    url = entry['url']
    if entry['sha1'] != VERSION_SHA1:
        # Mojang republishes a version file now and then; the pinned one stays at its content-addressed URL
        print(f'  the manifest now lists {VERSION} as {entry["sha1"][:8]}; using the pinned {VERSION_SHA1[:8]}')
        url = f'https://piston-meta.mojang.com/v1/packages/{VERSION_SHA1}/{VERSION}.json'
    download(url, dst, VERSION_SHA1)
    print(f'  {dst.relative_to(ROOT)}')
    return json.loads(dst.read_text())


def textures(version, refresh=False, keep_jar=False):
    client = version['downloads']['client']
    if client['sha1'] != CLIENT_SHA1 or client['size'] != CLIENT_SIZE:
        die(f'{VERSION}.json names client.jar {client["sha1"]} ({client["size"]} bytes), expected {CLIENT_SHA1}')
    if not refresh and TEX_MARK.is_file() and TEX_MARK.read_text().strip() == CLIENT_SHA1:
        n = sum(1 for p in TEX_DIR.rglob('*') if p.is_file())
        if n == TEXTURE_COUNT:
            print(f'  textures: {n} files already extracted from client.jar {CLIENT_SHA1[:8]}')
            return
    jar = MCV / 'client.jar'
    print(f'  client.jar ({CLIENT_SIZE / 1e6:.1f} MB)' + (' downloaded' if download(client['url'], jar, CLIENT_SHA1, CLIENT_SIZE) else ' already here'))
    TEX_MARK.unlink(missing_ok=True)
    if TEX_DIR.exists():
        shutil.rmtree(TEX_DIR)
    n = 0
    with zipfile.ZipFile(jar) as z:
        for info in z.infolist():
            if not info.filename.startswith(TEXTURES) or info.is_dir():
                continue
            rel = Path(info.filename)
            if '..' in rel.parts or rel.is_absolute():
                die(f'unexpected path in client.jar: {info.filename}')
            out = MCV / 'jar' / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(out, 'wb') as dst:     # zipfile checks each entry's CRC-32
                shutil.copyfileobj(src, dst)
            n += 1
    if n != TEXTURE_COUNT:
        die(f'client.jar held {n} textures, expected {TEXTURE_COUNT}')
    TEX_MARK.write_text(CLIENT_SHA1 + '\n')
    if not keep_jar:
        jar.unlink()
    print(f'  textures: extracted {n} files' + ('' if keep_jar else ' (client.jar deleted)'))


def sound_names():
    names = []
    for line in SOUND_LIST.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            names.append(line)
    return names


def sounds(version):
    ai = version['assetIndex']
    if ai['id'] != INDEX_ID or ai['sha1'] != INDEX_SHA1:
        die(f'{VERSION}.json names asset index {ai["id"]} {ai["sha1"]}, expected {INDEX_ID} {INDEX_SHA1}')
    index_path = MCV / f'index{INDEX_ID}.json'
    if download(ai['url'], index_path, INDEX_SHA1, ai.get('size')):
        print(f'  {index_path.relative_to(ROOT)}')
    objects = json.loads(index_path.read_text())['objects']

    def obj(key):
        o = objects.get(key)
        if o is None:
            die(f'asset index {INDEX_ID} has no {key}')
        return o

    sj = obj('minecraft/sounds.json')
    if sj['hash'] != SOUNDS_JSON_SHA1:
        die(f'asset index {INDEX_ID} lists sounds.json as {sj["hash"]}, expected {SOUNDS_JSON_SHA1}')
    download(f'{RESOURCES}/{sj["hash"][:2]}/{sj["hash"]}', MCV / 'sounds.json', sj['hash'], sj['size'])

    names = sound_names()
    jobs = []
    for n in names:
        o = obj(f'minecraft/sounds/{n}')
        jobs.append((f'{RESOURCES}/{o["hash"][:2]}/{o["hash"]}', MCV / 'sounds' / n, o['hash'], o['size']))
    with ThreadPoolExecutor(8) as pool:
        got = list(pool.map(lambda j: download(*j), jobs))
    keep = {str(MCV / 'sounds' / n) for n in names}
    extra = [p for p in (MCV / 'sounds').rglob('*') if p.is_file() and str(p) not in keep]
    for p in extra:
        p.unlink()
    for d in sorted((p for p in (MCV / 'sounds').rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        if not any(d.iterdir()):
            d.rmdir()
    total = sum(j[3] for j in jobs)
    print(f'  sounds: {len(names)} files ({total / 1e6:.1f} MB), {sum(got)} downloaded, {len(names) - sum(got)} already here'
          + (f', {len(extra)} unlisted removed' if extra else ''))


def main():
    args = set(sys.argv[1:])
    unknown = args - {'--refresh', '--keep-jar'}
    if unknown:
        die(f'unknown option {" ".join(sorted(unknown))}')
    if shutil.which('curl') is None:
        die('curl is required')
    version = version_file()
    textures(version, refresh='--refresh' in args, keep_jar='--keep-jar' in args)
    sounds(version)


if __name__ == '__main__':
    main()
