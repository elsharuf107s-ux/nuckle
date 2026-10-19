#!/usr/bin/env python3
"""FireRed's own music, rendered from the decomp's song data.

pret/pokefirered keeps every song as the MIDI file Game Freak's tools started from, together with the
voicegroups (instrument banks), the DirectSound instrument samples with their loop points, and the
programmable-wave and square settings of the GBA's sound chip. This replays a song the way the
Sappy/M4A engine does: MIDI times converted to 24 clocks per beat as mid2agb converts them, ticks
advanced on the GBA's 59.73 Hz frame with the engine's tempo accumulator, DirectSound voices mixed at
13379 Hz from 8-bit samples with M4A's ADSR envelopes and its two-frame reverb, five DirectSound
channels with voice stealing, and the four PSG channels (two squares, wave, noise) with Game Boy style
envelopes, one note per hardware channel. Vibrato (MOD/LFOS/LFODL), pitch bend and TUNE follow the
controllers mid2agb turns into M4A commands.

Writes assets/music/<name>.ogg plus music.json with loop points (seconds).
"""
import json
import math
import re
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
SND = HERE / 'vendor' / 'pokefirered' / 'sound'
OUT = HERE / 'assets' / 'music'
RATE = 13379                    # FireRed's mixer rate
FRAME_HZ = 16777216 / 280896    # 59.7275 Hz
SPF = RATE / FRAME_HZ           # ~224 samples per frame
PSG_OS = 4                      # PSG oversampling
MAX_DS = 5                      # DirectSound channels FireRed allocates
MASTER = 12 / 15                # m4aSoundMode master volume

SONGS = {
    'pallet': 'mus_pallet', 'route1': 'mus_route1', 'route3': 'mus_route3', 'pewter': 'mus_pewter',
    'battle': 'mus_vs_wild', 'victory': 'mus_victory_wild', 'caught': 'mus_caught', 'heal': 'mus_heal',
    'title': 'mus_title', 'poke_center': 'mus_poke_center', 'obtain': 'mus_obtain_item', 'levelup': 'mus_level_up',
    'route11': 'mus_route11', 'surf': 'mus_surf', 'viridian_forest': 'mus_viridian_forest', 'oak': 'mus_oak',
}
# Every map's own theme (world.json maps[].music, MUS_X -> 'x'): towns, interiors and caves.
MAP_SONGS = ['route24', 'vermillion', 'lavender', 'celadon', 'fuchsia', 'cinnabar', 'victory_road', 'gym', 'oak_lab',
             'mt_moon', 'poke_tower', 'rocket_hideout', 'poke_mansion', 'game_corner']
SONGS.update({k: 'mus_' + k for k in MAP_SONGS})
# The End: the legendary battle theme (StartLegendaryBattle plays MUS_VS_LEGEND for the birds, Ho-Oh and Lugia) for the
# ENDER DRAGON, and the Hall of Fame for the first trip home
SONGS.update({'vs_legend': 'mus_vs_legend', 'hall_of_fame': 'mus_hall_of_fame'})
LOOPING = {'pallet', 'route1', 'route3', 'pewter', 'battle', 'victory', 'title', 'poke_center', 'route11', 'surf', 'viridian_forest', 'oak',
           *MAP_SONGS, 'vs_legend', 'hall_of_fame'}


# ---------------------------------------------------------------- instrument data
def parse_voicegroups():
    txt = (SND / 'voice_groups.inc').read_text()
    groups, cur = {}, None
    for line in txt.splitlines():
        line = line.split('@')[0].strip()
        m = re.match(r'^(\w+)::$', line)
        if m:
            cur = m.group(1); groups[cur] = []; continue
        if cur is None or not line.startswith('voice_'):
            continue
        name, _, args = line.partition(' ')
        groups[cur].append((name, [a.strip() for a in args.split(',')] if args else []))
    return groups


def parse_keysplits():
    txt = (SND / 'keysplit_tables.inc').read_text()
    tables, cur, base, k = {}, None, 0, 0
    for line in txt.splitlines():
        m = re.match(r'\s*\.set\s+(\w+),\s*\.\s*-\s*(\d+)', line)
        if m:
            cur = m.group(1); base = int(m.group(2)); k = base; tables[cur] = {}; continue
        m = re.match(r'\s*\.byte\s+(\d+)', line)
        if m and cur:
            tables[cur][k] = int(m.group(1)); k += 1
    return tables


def ds_paths():
    txt = (SND / 'direct_sound_data.inc').read_text()
    out = {}
    for m in re.finditer(r'(DirectSoundWaveData_\w+)::[^\n]*\n\s*\.incbin\s+"sound/direct_sound_samples/([^"]+)\.bin"', txt):
        out[m.group(1)] = SND / 'direct_sound_samples' / (m.group(2) + '.wav')
    return out


class Sample:
    def __init__(self, path):
        f = Path(path).read_bytes()
        i = 12
        self.loop = None
        self.freq = None
        data = None
        while i < len(f):
            cid, sz = f[i:i + 4], struct.unpack('<I', f[i + 4:i + 8])[0]
            d = f[i + 8:i + 8 + sz]
            if cid == b'fmt ':
                self.rate = struct.unpack('<I', d[4:8])[0]
            elif cid == b'smpl':
                n = struct.unpack('<I', d[28:32])[0]
                if n > 0:
                    st, en = struct.unpack('<II', d[44:52])
                    self.loop = (st, en)
            elif cid == b'agbp':
                self.freq = struct.unpack('<I', d)[0] / 1024
            elif cid == b'agbl':
                self.end = struct.unpack('<I', d)[0]
            elif cid == b'data':
                data = d
            i += 8 + sz + (sz & 1)
        self.data = (np.frombuffer(data, np.uint8).astype(np.int16) - 128).astype(np.float32)
        if self.freq is None:
            self.freq = float(self.rate)
        if self.loop:
            self.loop = (self.loop[0], min(len(self.data) - 1, self.loop[1]))


_samples = {}
def sample(label):
    if label not in _samples:
        _samples[label] = Sample(DS[label])
    return _samples[label]


def prog_wave(label):
    n = int(label.split('_')[-1])
    b = (SND / 'programmable_wave_samples' / f'{n:02d}.pcm').read_bytes()
    vals = []
    for byte in b[:16]:
        vals += [byte >> 4, byte & 15]
    w = np.array(vals, np.float32)
    return (w - 7.5) / 7.5


GROUPS = parse_voicegroups()
SPLITS = parse_keysplits()
DS = ds_paths()


def resolve(group, program, key):
    """The voice that actually plays (program, key) in a voicegroup, following keysplits and drum kits.
    Returns (voice name, args, key to play, fixed_key)."""
    voices = GROUPS[group]
    if program >= len(voices):
        return None
    name, args = voices[program]
    if name == 'voice_keysplit':
        sub, table = args[0], args[1]
        idx = SPLITS[table].get(key, 0)
        name, args = GROUPS[sub][idx]
        return name, args, key, False
    if name == 'voice_keysplit_all':
        sub = args[0]
        if key >= len(GROUPS[sub]):
            return None
        name, args = GROUPS[sub][key]
        # a drum kit plays each sample at the pitch its own voice entry names
        return name, args, int(args[0]), True
    return name, args, key, False


# ---------------------------------------------------------------- MIDI
def read_midi(path):
    b = Path(path).read_bytes()
    assert b[:4] == b'MThd'
    fmt, ntrk, div = struct.unpack('>HHH', b[8:14])
    i = 14
    tracks = []
    for _ in range(ntrk):
        assert b[i:i + 4] == b'MTrk', b[i:i + 4]
        ln = struct.unpack('>I', b[i + 4:i + 8])[0]
        tracks.append(b[i + 8:i + 8 + ln])
        i += 8 + ln
    events = []   # (tick, order, kind, chan, a, b)
    order = 0
    for tr in tracks:
        p, t, run = 0, 0, None
        def vlq():
            nonlocal p
            v = 0
            while True:
                c = tr[p]; p += 1
                v = (v << 7) | (c & 0x7F)
                if not c & 0x80:
                    return v
        while p < len(tr):
            t += vlq()
            st = tr[p]
            if st == 0xFF:
                typ = tr[p + 1]; p += 2
                ln = vlq(); data = tr[p:p + ln]; p += ln
                if typ == 0x51:
                    events.append((t, order, 'tempo', 0, int.from_bytes(data, 'big'), 0))
                elif 1 <= typ <= 7:
                    txt = data.decode('latin1')
                    if txt in ('[', ']'):
                        events.append((t, order, 'loop' + txt, 0, 0, 0))
                order += 1
                continue
            if st in (0xF0, 0xF7):
                p += 1; ln = vlq(); p += ln; continue
            if st & 0x80:
                run = st; p += 1
            else:
                st = run
            hi, ch = st & 0xF0, st & 0x0F
            if hi in (0xC0, 0xD0):
                a = tr[p]; p += 1; bb = 0
            else:
                a, bb = tr[p], tr[p + 1]; p += 2
            if hi == 0x90 and bb > 0:
                events.append((t, order, 'on', ch, a, bb))
            elif hi == 0x80 or (hi == 0x90 and bb == 0):
                events.append((t, order, 'off', ch, a, 0))
            elif hi == 0xB0:
                events.append((t, order, 'cc', ch, a, bb))
            elif hi == 0xC0:
                events.append((t, order, 'prog', ch, a, 0))
            elif hi == 0xE0:
                events.append((t, order, 'bend', ch, (bb << 7 | a) - 8192, 0))
            order += 1
    events.sort(key=lambda e: (e[0], e[1]))
    return div, events


def song_events(name):
    """mid2agb's view of a MIDI file: times in 24 clocks per beat, notes with gate lengths."""
    div, evs = read_midi(SND / 'songs' / 'midi' / f'{name}.mid')
    clk = lambda t: (24 * t) // div
    out = []
    open_notes = {}
    for t, o, kind, ch, a, b in evs:
        if kind == 'on':
            open_notes.setdefault((ch, a), []).append((t, o, b))
        elif kind == 'off':
            lst = open_notes.get((ch, a))
            if lst:
                t0, o0, vel = lst.pop(0)
                out.append((clk(t0), o0, 'note', ch, a, vel, max(1, (24 * (t - t0)) // div)))
        else:
            out.append((clk(t), o, kind, ch, a, b, 0))
    out.sort(key=lambda e: (e[0], e[1]))
    return out


# ---------------------------------------------------------------- the engine
class Track:
    def __init__(self):
        self.prog = 0; self.vol = 100; self.pan = 0; self.bend = 0; self.bendr = 2; self.mod = 0; self.lfos = 22
        self.lfodl = 0; self.modt = 0; self.tune = 0; self.lfo_phase = 0; self.lfo_delay = 0


class Voice:
    pass


def adsr_args(args, i0):
    return [int(a) for a in args[i0:i0 + 4]]


def render(song, max_seconds=None, loops=1):
    cfg = {}
    for line in (SND / 'songs' / 'midi' / 'midi.cfg').read_text().splitlines():
        m = re.match(r'(\w+)\.mid:\s*(.*)', line)
        if m:
            cfg[m.group(1)] = m.group(2)
    opts = cfg[song]
    group = 'voicegroup%03d' % int(re.search(r'-G(\d+)', opts).group(1))
    mvl = int(re.search(r'-V(\d+)', opts).group(1)) if '-V' in opts else 127
    reverb = int(re.search(r'-R(\d+)', opts).group(1)) if '-R' in opts else 0
    evs = song_events(song)
    loop_start = next((e[0] for e in evs if e[2] == 'loop['), None)
    loop_end = next((e[0] for e in evs if e[2] == 'loop]'), None)
    last = max(e[0] + e[6] for e in evs)
    end_clock = loop_end if loop_end is not None else last
    tempo_bpm = 120
    # tick-by-tick schedule
    by_clock = {}
    for e in evs:
        by_clock.setdefault(e[0], []).append(e)
    tracks = {}
    ds = []                 # active DirectSound voices
    psg = {1: None, 2: None, 3: None, 4: None}
    out_ds = []             # per-frame stereo float arrays at RATE
    out_psg = []            # per-frame stereo at RATE * PSG_OS
    clock = 0
    tempo_acc = 0
    loops_done = 0
    loop_time = None
    frames = 0
    max_frames = int((max_seconds or 600) * FRAME_HZ)
    rev_hist = np.zeros((2, 0), np.float32)
    noise_lfsr = [0x7FFF]
    finished = False
    tail = 0
    while frames < max_frames:
        # ---- sequencer: advance clocks with the engine's tempo accumulator
        tempo_acc += tempo_bpm
        while tempo_acc >= 150 and not finished:
            tempo_acc -= 150
            for e in by_clock.get(clock, []):
                t, o, kind, ch, a, b, dur = e
                tr = tracks.setdefault(ch, Track())
                if kind == 'tempo':
                    tempo_bpm = round(60_000_000 / a)
                elif kind == 'prog':
                    tr.prog = a
                elif kind == 'bend':
                    tr.bend = a
                elif kind == 'cc':
                    if a == 7: tr.vol = b * mvl // 127
                    elif a == 10: tr.pan = b - 64
                    elif a == 1: tr.mod = b
                    elif a == 0x14: tr.bendr = b
                    elif a == 0x15: tr.lfos = b
                    elif a == 0x16: tr.modt = b
                    elif a == 0x18: tr.tune = b - 64
                    elif a == 0x1A: tr.lfodl = b
                elif kind == 'note':
                    start_note(tr, ch, a, b, dur, group, ds, psg, frames)
            # note lengths count down per clock
            for v in ds + [p for p in psg.values() if p]:
                if v.gate > 0:
                    v.gate -= 1
                    if v.gate == 0:
                        v.released = True
            clock += 1
            if clock >= end_clock:
                if loop_start is not None and loops_done < loops:
                    if loop_time is None:
                        loop_time = frames
                    loops_done += 1
                    clock = loop_start
                else:
                    finished = True
        # ---- per-frame envelopes, LFOs
        for tr in tracks.values():
            tr.lfo_phase = (tr.lfo_phase + tr.lfos) & 0xFF
        frame_ds = np.zeros((2, int(round(SPF * (frames + 1))) - int(round(SPF * frames))), np.float32)
        n = frame_ds.shape[1]
        for v in list(ds):
            if not step_env_ds(v):
                ds.remove(v); continue
            mix_ds(v, tracks.get(v.ch), frame_ds)
        frame_psg = np.zeros((2, n * PSG_OS), np.float32)
        for k, v in psg.items():
            if v is None:
                continue
            if not step_env_cgb(v):
                psg[k] = None; continue
            mix_psg(v, tracks.get(v.ch), frame_psg, noise_lfsr)
        # M4A reverb: the new frame starts from the two frames before it, scaled by the reverb amount
        if reverb:
            if rev_hist.shape[1] >= 2 * n:
                a = rev_hist[:, -n:]; b2 = rev_hist[:, -2 * n:-n]
                frame_ds += (a + b2) * (reverb / 512)
            rev_hist = np.concatenate([rev_hist, frame_ds], axis=1)[:, -4 * n:]
        out_ds.append(np.clip(frame_ds, -128, 127))
        out_psg.append(frame_psg)
        frames += 1
        if finished:
            tail += 1
            if not ds and not any(psg.values()) or tail > FRAME_HZ * 3:
                break
    ds_mix = np.concatenate(out_ds, axis=1) / 128.0
    psg_mix = np.concatenate(out_psg, axis=1)
    loop_info = None
    if loop_start is not None and loop_time is not None:
        # loop region in seconds: from where the second pass starts to where the first pass ended
        t_loop_end = loop_time / FRAME_HZ
        t_loop_len = loop_clock_seconds(evs, loop_start, end_clock)
        loop_info = (t_loop_end - t_loop_len, t_loop_end)
    return ds_mix, psg_mix, loop_info


def loop_clock_seconds(evs, c0, c1):
    """Real time between two clocks, with the frame-quantised tempo accumulator."""
    tempo = 120
    tempos = sorted((e[0], round(60_000_000 / e[4])) for e in evs if e[2] == 'tempo')
    def tempo_at(c):
        t = 120
        for cc, bpm in tempos:
            if cc <= c: t = bpm
        return t
    secs = 0.0
    for c in range(c0, c1):
        secs += 150 / tempo_at(c) / FRAME_HZ
    return secs


def start_note(tr, ch, key, vel, dur, group, ds, psg, frame):
    r = resolve(group, tr.prog, key)
    if r is None:
        return
    name, args, play_key, fixed = r
    v = Voice()
    v.ch, v.vel, v.gate, v.released, v.key, v.fixed = ch, vel, dur, False, play_key, fixed
    v.frame0 = frame
    v.voice_pan = None
    if len(args) > 1:
        try:
            p = int(args[1])
            if p:
                v.voice_pan = p - 64 if p < 128 else (p & 0x7F) - 64
        except ValueError:
            pass
    if name.startswith('voice_directsound'):
        v.kind = 'ds'
        v.sample = sample(args[2])
        v.no_resample = name == 'voice_directsound_no_resample'
        v.atk, v.dec, v.sus, v.rel = adsr_args(args, 3)
        v.env = 0; v.stage = 'atk'; v.pos = 0.0
        v.base = int(args[0])
        if len(ds) >= MAX_DS:
            # steal: a releasing voice first, else the oldest
            rel = [x for x in ds if x.released]
            victim = rel[0] if rel else min(ds, key=lambda x: x.frame0)
            ds.remove(victim)
        ds.append(v)
        return
    kind = {'voice_square_1': 1, 'voice_square_1_alt': 1, 'voice_square_2': 2, 'voice_square_2_alt': 2,
            'voice_programmable_wave': 3, 'voice_programmable_wave_alt': 3, 'voice_noise': 4, 'voice_noise_alt': 4}.get(name)
    if kind is None:
        return
    v.kind = kind
    if kind == 1:
        v.duty = int(args[3]); v.atk, v.dec, v.sus, v.rel = adsr_args(args, 4)
    elif kind == 2:
        v.duty = int(args[2]); v.atk, v.dec, v.sus, v.rel = adsr_args(args, 3)
    elif kind == 3:
        v.wave = prog_wave(args[2]); v.atk, v.dec, v.sus, v.rel = adsr_args(args, 3)
    else:
        v.period = int(args[2]); v.atk, v.dec, v.sus, v.rel = adsr_args(args, 3)
    v.env = 0 if v.atk else 15
    v.stage = 'atk' if v.atk else 'dec'
    v.cnt = 0
    v.phase = 0.0
    psg[kind] = v


def step_env_ds(v):
    if v.released and v.stage != 'rel':
        v.stage = 'rel'
    if v.stage == 'atk':
        v.env = min(255, v.env + v.atk)
        if v.env >= 255: v.stage = 'dec'
    elif v.stage == 'dec':
        v.env = (v.env * v.dec) >> 8
        if v.env <= v.sus: v.env = v.sus; v.stage = 'sus'
    elif v.stage == 'rel':
        v.env = (v.env * v.rel) >> 8
        if v.env <= 0: return False
    return True


def step_env_cgb(v):
    if v.released and v.stage != 'rel':
        v.stage = 'rel'; v.cnt = 0
        if v.rel == 0:
            return False
    v.cnt += 1
    if v.stage == 'atk':
        if v.cnt >= v.atk:
            v.cnt = 0; v.env += 1
            if v.env >= 15: v.env = 15; v.stage = 'dec'
    elif v.stage == 'dec':
        if v.dec == 0:
            v.env = v.sus if v.sus else v.env; v.stage = 'sus'
        elif v.cnt >= v.dec:
            v.cnt = 0
            if v.env > v.sus: v.env -= 1
            if v.env <= v.sus: v.stage = 'sus'
    elif v.stage == 'rel':
        if v.cnt >= v.rel:
            v.cnt = 0; v.env -= 1
            if v.env <= 0: return False
    return True


def pitch_offset(v, tr):
    """Semitones from bend, tune and vibrato."""
    if tr is None:
        return 0.0
    st = tr.bend / 8192 * tr.bendr + tr.tune / 64
    if tr.mod and tr.modt == 0:
        tri = tr.lfo_phase if tr.lfo_phase < 128 else 255 - tr.lfo_phase
        tri = (tri - 64) / 64.0
        st += tri * tr.mod / 64.0 * 2
    return st


def chan_gain(v, tr):
    vol = tr.vol if tr else 100
    pan = v.voice_pan if v.voice_pan is not None else (tr.pan if tr else 0)
    x = vol * 2
    r = (x * (pan + 128)) >> 8
    l = (x * (127 - pan)) >> 8
    return (l * v.vel) >> 7, (r * v.vel) >> 7


def mix_ds(v, tr, buf):
    n = buf.shape[1]
    s = v.sample
    if v.no_resample:
        step = 1.0
    else:
        key = v.key + pitch_offset(v, tr)
        step = s.freq * 2 ** ((key - 60) / 12) / RATE
    idx = v.pos + step * np.arange(n)
    data = s.data
    if s.loop:
        st, en = s.loop
        over = idx >= en
        if over.any():
            L = en - st
            idx = np.where(over, st + np.mod(idx - st, L), idx)
        nxt_pos = v.pos + step * n
        if nxt_pos >= en:
            nxt_pos = st + (nxt_pos - st) % (en - st)
        v.pos = nxt_pos
    else:
        valid = idx < len(data) - 1
        if not valid.all():
            idx = idx[valid]
            if not len(idx):
                v.released = True; v.env = 0; v.stage = 'rel'
                return
        v.pos += step * n
    i0 = idx.astype(np.int64)
    frac = idx - i0
    i1 = np.minimum(i0 + 1, len(data) - 1)
    smp = data[i0] * (1 - frac) + data[i1] * frac
    gl, gr = chan_gain(v, tr)
    e = v.env / 256
    m = len(smp)
    buf[0, :m] += smp * gl / 256 * e * MASTER
    buf[1, :m] += smp * gr / 256 * e * MASTER


DUTY = {0: 0.125, 1: 0.25, 2: 0.5, 3: 0.75}


def mix_psg(v, tr, buf, lfsr):
    n = buf.shape[1]
    rate = RATE * PSG_OS
    key = v.key + pitch_offset(v, tr)
    f = 440 * 2 ** ((key - 69) / 12)
    gl, gr = chan_gain(v, tr)
    level = v.env / 15
    if v.kind in (1, 2):
        ph = v.phase + f / rate * np.arange(1, n + 1)
        d = DUTY.get(v.duty, 0.5)
        w = np.where((ph % 1.0) < d, 1.0, -1.0)
        v.phase = ph[-1] % 1.0
        # remove the DC of the pulse so narrow duties sit centred like the AC-coupled output
        w = w - (2 * d - 1)
    elif v.kind == 3:
        ph = v.phase + f / rate * np.arange(1, n + 1)
        w = v.wave[((ph % 1.0) * 32).astype(int) % 32]
        v.phase = ph[-1] % 1.0
    else:
        clk = 4096 * 2 ** ((key - 60) / 12) * 2
        ph = v.phase + clk / rate * np.arange(1, n + 1)
        steps = ph.astype(np.int64)
        w = np.empty(n, np.float32)
        last = int(v.phase)
        cur = lfsr[0]
        out = 1.0 if cur & 1 else -1.0
        for i in range(n):
            while last < steps[i]:
                bit = (cur ^ (cur >> 1)) & 1
                cur = (cur >> 1) | (bit << 14)
                if v.period:
                    cur = (cur & ~0x40) | (bit << 6)
                last += 1
                out = 1.0 if cur & 1 else -1.0
            w[i] = out
        lfsr[0] = cur
        v.phase = ph[-1] % 1e6
    PSG_SCALE = 0.45
    buf[0] += w * level * (gl / 254) * PSG_SCALE
    buf[1] += w * level * (gr / 254) * PSG_SCALE


def build(name, song):
    ds_mix, psg_mix, loop = render(song, loops=1 if name in LOOPING else 0)
    # DirectSound is sample-and-hold at 13379 Hz on the GBA; bring both paths to 53516 Hz and sum
    up = np.repeat(ds_mix, PSG_OS, axis=1)
    n = min(up.shape[1], psg_mix.shape[1])
    mix = up[:, :n] + psg_mix[:, :n]
    sr = RATE * PSG_OS
    if loop:  # nothing after the loop end is ever heard
        mix = mix[:, :int((loop[1] + 0.25) * sr)]
        n = mix.shape[1]
    peak = np.abs(mix).max()
    gain = 0.85 / max(peak, 1e-6)
    mix = (mix * gain).astype(np.float32)
    OUT.mkdir(parents=True, exist_ok=True)
    raw = OUT / f'{name}.f32'
    mix.T.tofile(raw)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', '2', '-i', str(raw),
                    '-af', 'lowpass=f=11000,aresample=48000', '-c:a', 'libopus', '-b:a', '112k',
                    # bitexact: a fixed Ogg stream serial and no version tags, so a rebuild with the same ffmpeg and
                    # libopus writes the same bytes (otherwise every encode differs)
                    '-fflags', '+bitexact', '-flags:a', '+bitexact', str(OUT / f'{name}.ogg')], check=True)
    raw.unlink()
    info = {'gain': 1.0, 'duration': n / sr}
    if loop:
        info['loopStart'], info['loopEnd'] = max(0.0, round(loop[0], 4)), round(loop[1], 4)
    print(f'  {name:14s} {song:22s} {n / sr:6.1f}s  loop={loop}  peak={peak:.2f}')
    return info


if __name__ == '__main__':
    which = sys.argv[1:] or list(SONGS)
    meta_path = OUT / 'music.json'
    meta = json.load(open(meta_path)) if meta_path.exists() else {}
    for k in which:
        meta[k] = build(k, SONGS[k])
    json.dump(meta, open(meta_path, 'w'), indent=1)
