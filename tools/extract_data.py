#!/usr/bin/env python3
"""Parse species, moves, learnsets, type chart and sprite coords out of pret/pokefirered."""
import re
from pathlib import Path

FR = Path(__file__).resolve().parent.parent / 'vendor' / 'pokefirered'


def _blocks(txt, prefix):
    """Yield (NAME, body) for '[PREFIX_NAME] = { ... },' designated initialisers."""
    for m in re.finditer(r'\[' + prefix + r'_(\w+)\]\s*=\s*\{', txt):
        i = m.end(); depth = 1
        while depth:
            c = txt[i]
            depth += (c == '{') - (c == '}')
            i += 1
        yield m.group(1), txt[m.end():i - 1]


def _field(body, name, default=None):
    m = re.search(r'\.' + name + r'\s*=\s*([^,\n]+)', body)
    return m.group(1).strip() if m else default


def species_info():
    txt = (FR / 'src/data/pokemon/species_info.h').read_text()
    out = {}
    for name, body in _blocks(txt, 'SPECIES'):
        if '.baseHP' not in body:
            continue
        t = re.search(r'\.types\s*=\s*\{\s*TYPE_(\w+)\s*,\s*TYPE_(\w+)', body)
        out[name] = {
            'base': [int(_field(body, k)) for k in ('baseHP', 'baseAttack', 'baseDefense', 'baseSpAttack', 'baseSpDefense', 'baseSpeed')],
            'types': [t.group(1), t.group(2)],
            'catchRate': int(_field(body, 'catchRate')),
            'expYield': int(_field(body, 'expYield')),
            'growth': _field(body, 'growthRate').replace('GROWTH_', ''),
        }
    return out


def species_names():
    txt = (FR / 'src/data/text/species_names.h').read_text()
    return {m.group(1): m.group(2) for m in re.finditer(r'\[SPECIES_(\w+)\]\s*=\s*_\("([^"]*)"\)', txt)}


def move_names():
    txt = (FR / 'src/data/text/move_names.h').read_text()
    return {m.group(1): m.group(2) for m in re.finditer(r'\[MOVE_(\w+)\]\s*=\s*_\("([^"]*)"\)', txt)}


def moves():
    txt = (FR / 'src/data/battle_moves.h').read_text()
    names = move_names()
    out = {}
    for name, body in _blocks(txt, 'MOVE'):
        if name == 'NONE':
            continue
        out[name] = {
            'name': names.get(name, name),
            'effect': _field(body, 'effect').replace('EFFECT_', ''),
            'power': int(_field(body, 'power')),
            'type': _field(body, 'type').replace('TYPE_', ''),
            'acc': int(_field(body, 'accuracy')),
            'pp': int(_field(body, 'pp')),
            'chance': int(_field(body, 'secondaryEffectChance')),
            'priority': int(_field(body, 'priority')),
            'target': _field(body, 'target').replace('MOVE_TARGET_', ''),
            'contact': 'FLAG_MAKES_CONTACT' in (_field(body, 'flags') or ''),
        }
    return out


def learnsets():
    txt = (FR / 'src/data/pokemon/level_up_learnsets.h').read_text()
    ptrs = (FR / 'src/data/pokemon/level_up_learnset_pointers.h').read_text()
    arrays = {}
    for m in re.finditer(r'static const u16 (s\w+LevelUpLearnset)\[\] = \{(.*?)\};', txt, re.S):
        arrays[m.group(1)] = [(int(a), b) for a, b in re.findall(r'LEVEL_UP_MOVE\(\s*(\d+),\s*MOVE_(\w+)\)', m.group(2))]
    out = {}
    for m in re.finditer(r'\[SPECIES_(\w+)\]\s*=\s*(s\w+LevelUpLearnset)', ptrs):
        out[m.group(1)] = arrays.get(m.group(2), [])
    return out


def fly_learners():
    txt = (FR / 'src/data/pokemon/tmhm_learnsets.h').read_text()
    out = set()
    for m in re.finditer(r'\[SPECIES_(\w+)\]\s*=\s*TMHM_LEARNSET\((.*?)\),\s*\n', txt, re.S):
        if 'HM02_FLY' in m.group(2):
            out.add(m.group(1))
    return out


def type_chart():
    txt = (FR / 'src/battle_main.c').read_text()
    body = re.search(r'gTypeEffectiveness\[\d+\] =\s*\{(.*?)\};', txt, re.S).group(1)
    mul = {'TYPE_MUL_SUPER_EFFECTIVE': 20, 'TYPE_MUL_NOT_EFFECTIVE': 5, 'TYPE_MUL_NO_EFFECT': 0}
    rows = re.findall(r'TYPE_(\w+),\s*TYPE_(\w+),\s*(TYPE_MUL_\w+)', body)
    # Entries after TYPE_FORESIGHT only apply when Foresight is active; stop there.
    chart, foresight = [], False
    for a, d, m in rows:
        if a == 'FORESIGHT':
            foresight = True
            continue
        chart.append([a, d, mul[m], foresight])
    return chart


def pic_coords(fname, table):
    txt = (FR / 'src/data/pokemon_graphics' / fname).read_text()
    out = {}
    for name, body in _blocks(txt, 'SPECIES'):
        s = re.search(r'MON_COORDS_SIZE\((\d+),\s*(\d+)\)', body)
        y = re.search(r'\.y_offset\s*=\s*(\d+)', body)
        if s and y:
            out[name] = {'w': int(s.group(1)), 'h': int(s.group(2)), 'y': int(y.group(1))}
    return out


def elevation():
    txt = (FR / 'src/data/pokemon_graphics/enemy_mon_elevation.h').read_text()
    return {m.group(1): int(m.group(2)) for m in re.finditer(r'\[SPECIES_(\w+)\]\s*=\s*(\d+)', txt)}


def icon_palettes():
    txt = (FR / 'src/pokemon_icon.c').read_text()
    body = re.search(r'gMonIconPaletteIndices\[\] = \{(.*?)\};', txt, re.S).group(1)
    return [int(v) for v in re.findall(r'(\d+),', re.sub(r'//.*', '', body))]


def species_ids():
    txt = (FR / 'include/constants/species.h').read_text()
    return {m.group(1): int(m.group(2)) for m in re.finditer(r'#define SPECIES_(\w+)\s+(\d+)\b', txt)}


if __name__ == '__main__':
    import collections, json
    s = species_info(); mv = moves(); ls = learnsets(); fl = fly_learners()
    print(len(s), 'species', len(mv), 'moves', len(ls), 'learnsets', len(fl), 'fly learners')
    print(sorted(fl))
    print(collections.Counter(m['effect'] for m in mv.values()).most_common(80))
    print(len(type_chart()), 'type rows', len(icon_palettes()), 'icon pals')
