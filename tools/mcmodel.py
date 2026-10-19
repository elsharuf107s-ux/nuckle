#!/usr/bin/env python3
"""Minecraft box models rendered as FireRed-scale pixel sprites.

Entity models (Steve, zombies, creepers...) are cuboids with Minecraft's standard box UV layout. They
are ray cast in an oblique projection: faces toward the camera keep one texel per pixel (so a face
stays readable at sprite size) and top faces are foreshortened by K, the way FireRed draws the tops of
things. Every pixel samples the nearest texel of whichever face it hits first, so limbs can swing and
occlude each other properly. A silhouette outline is added afterwards.

Coordinates: y up, feet at y = 0, the model faces +z (toward the camera) before yaw.
"""
import math
import numpy as np
from PIL import Image

K = 0.45                       # how much of a top face shows (depth * K pixels)
SHADE = {'top': 1.0, 'front': 0.92, 'back': 0.92, 'right': 0.74, 'left': 0.74, 'bottom': 0.55}


def load_tex(path):
    return np.array(Image.open(path).convert('RGBA'), dtype=np.uint8)


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


class Box:
    """A textured cuboid. `size` is in texels (w, h, d) and `uv` is Minecraft's box UV origin.
    `pos` is the world position of the box's (x0, y0, z0) corner before rotation; `scale` stretches
    the geometry (not the UVs); `pivot` + `rot` (radians about x, y, z) rotate it about a point."""

    def __init__(self, tex, uv, size, pos, scale=(1, 1, 1), pivot=None, rot=(0, 0, 0), part='', inflate=0.0, mirror=False, mat=None, glow=False, faces=None):
        self.tex, self.uv, self.size = tex, uv, size
        self.pos, self.scale = np.array(pos, float), np.array(scale, float)
        self.pivot = np.array(pivot if pivot is not None else pos, float)
        self.rot, self.part, self.inflate, self.mirror = rot, part, inflate, mirror
        self.mat = mat          # explicit 3x3 rotation (overrides rot)
        self.glow = glow        # unshaded (spider eyes)
        self.face_override = faces or {}

    def extent(self):
        w, h, d = self.size
        return np.array([w, h, d], float) * self.scale + 2 * self.inflate

    def matrix(self):
        if self.mat is not None:
            return self.mat
        rx, ry, rz = self.rot
        return rot_y(ry) @ rot_x(rx) @ rot_z(rz)

    def faces(self):
        """UV rectangles (u, v, w, h) for each face, Minecraft's layout."""
        u, v = self.uv
        w, h, d = self.size
        f = {
            'top': (u + d, v, w, d), 'bottom': (u + d + w, v, w, d),
            'right': (u, v + d, d, h), 'front': (u + d, v + d, w, h),
            'left': (u + d + w, v + d, d, h), 'back': (u + d + w + d, v + d, w, h),
        }
        f.update(self.face_override)
        return f


def _sample(box, face, lp):
    """Texel for local hit point lp (in scaled box units, origin at the box corner)."""
    ext = box.extent()
    w, h, d = box.size
    # back to texel units
    lx = (lp[0] - box.inflate) / box.scale[0]
    ly = (lp[1] - box.inflate) / box.scale[1]
    lz = (lp[2] - box.inflate) / box.scale[2]
    if box.mirror:
        lx = w - lx
        face = {'right': 'left', 'left': 'right'}.get(face, face)
    fu, fv, fw, fh = box.faces()[face]
    if face == 'front':
        c, r = lx, h - ly
    elif face == 'back':
        c, r = w - lx, h - ly
    elif face == 'right':
        c, r = lz, h - ly
    elif face == 'left':
        c, r = d - lz, h - ly
    elif face == 'top':
        c, r = lx, lz
    else:
        c, r = lx, d - lz
    c = min(fw - 1, max(0, int(math.floor(c))))
    r = min(fh - 1, max(0, int(math.floor(r))))
    tex = box.tex
    return tex[fv + r, fu + c]


def render(boxes, yaw=0.0, size=(32, 40), origin=(16, 36), k=K, shade=SHADE, extras=None):
    """Ray cast the model. `origin` is the screen pixel under the model's (0, 0, 0).
    Returns (rgba, part_ids, depth). `extras` lets callers mark points to project (returns their screen xy)."""
    W, H = size
    out = np.zeros((H, W, 4), np.uint8)
    part = np.full((H, W), -1, np.int32)
    depth = np.full((H, W), -1e9)
    Ry = rot_y(yaw)
    D = np.array([0.0, -k, -1.0])
    prepared = []
    for bi, b in enumerate(boxes):
        M = Ry @ b.matrix()
        Minv = M.T
        # world position of the box corner: pivot + R*(pos - pivot), all yawed about the origin
        corner = Ry @ (b.pivot + b.matrix() @ (b.pos - b.inflate - b.pivot))
        prepared.append((bi, b, Minv, corner, b.extent()))
    for sy in range(H):
        for sx in range(W):
            # screen (x, v) -> ray through x = X, -y + k z = V
            X = sx + 0.5 - origin[0]
            V = sy + 0.5 - origin[1]
            Z0 = 64.0
            O = np.array([X, k * Z0 - V, Z0])
            best_t, best = 1e18, None
            for bi, b, Minv, corner, ext in prepared:
                o = Minv @ (O - corner)
                dd = Minv @ D
                tmin, tmax, enter = -1e18, 1e18, None
                ok = True
                for ax in range(3):
                    if abs(dd[ax]) < 1e-12:
                        if o[ax] < 0 or o[ax] > ext[ax]:
                            ok = False
                            break
                        continue
                    t1 = (0 - o[ax]) / dd[ax]
                    t2 = (ext[ax] - o[ax]) / dd[ax]
                    near_face = (ax, 0) if t1 < t2 else (ax, 1)
                    lo, hi = min(t1, t2), max(t1, t2)
                    if lo > tmin:
                        tmin, enter = lo, near_face
                    tmax = min(tmax, hi)
                    if tmin > tmax:
                        ok = False
                        break
                if not ok or enter is None or tmax < 0:
                    continue
                # try the entry face; if that texel is transparent, try the exit face (cutout layers)
                for t, face_ax in ((tmin, enter), (tmax, None)):
                    if t >= best_t:
                        break
                    lp = o + dd * t
                    if face_ax is None:
                        # which face is the exit on?
                        cands = []
                        for ax in range(3):
                            if abs(dd[ax]) < 1e-12:
                                continue
                            for side, val in ((0, 0.0), (1, ext[ax])):
                                if abs(lp[ax] - val) < 1e-6:
                                    cands.append((ax, side))
                        if not cands:
                            break
                        face_ax = cands[0]
                    ax, side = face_ax
                    name = {(0, 0): 'right', (0, 1): 'left', (1, 0): 'bottom', (1, 1): 'top', (2, 0): 'back', (2, 1): 'front'}[face_ax]
                    lp = np.clip(lp, 0, ext)
                    px = _sample(b, name, lp)
                    if px[3] < 128:
                        continue
                    best_t = t
                    s = 1.0 if b.glow else shade.get(name, 1.0)
                    best = (np.clip(px[:3].astype(float) * s, 0, 255).astype(np.uint8), bi, t)
                    break
            if best is not None:
                out[sy, sx, :3] = best[0]
                out[sy, sx, 3] = 255
                part[sy, sx] = best[1]
                depth[sy, sx] = -best[2]
    pts = {}
    if extras:
        for name, p in extras.items():
            w = Ry @ np.array(p, float)
            pts[name] = (w[0] + origin[0], -w[1] + k * w[2] + origin[1])
    return out, part, depth, pts


def outline(img, color=(24, 20, 28), part=None, depth=None, inner=None, darken=None):
    """Dark 1px silhouette outline (4-neighbourhood). With `inner`, also darken pixels where a part sits
    in front of another (a step in depth larger than `inner`), which separates limbs from the body."""
    a = img[:, :, 3] > 0
    H, W = a.shape
    res = img.copy()
    for y in range(H):
        for x in range(W):
            if a[y, x]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + dx, y + dy
                if 0 <= xx < W and 0 <= yy < H and a[yy, xx]:
                    if darken is not None:
                        c = img[yy, xx, :3].astype(float) * darken
                        res[y, x, :3] = c.astype(np.uint8)
                    else:
                        res[y, x, :3] = color
                    res[y, x, 3] = 255
                    break
    if inner is not None and part is not None and depth is not None:
        for y in range(H):
            for x in range(W):
                if not a[y, x]:
                    continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    xx, yy = x + dx, y + dy
                    if 0 <= xx < W and 0 <= yy < H and a[yy, xx] and part[yy, xx] != part[y, x] and depth[y, x] < depth[yy, xx] - inner:
                        res[y, x, :3] = (res[y, x, :3].astype(float) * 0.45).astype(np.uint8)
                        break
    return res


def render_hi(boxes, s, yaw=0.0, size=(32, 40), origin=(16, 36), k=K, shade=SHADE, extras=None):
    """Ray cast at `s` screen pixels per texel instead of upscaling a one-pixel-per-texel render, so
    rotated limbs and turned heads come out as clean rotated blocks rather than resampled stair-steps.
    `size` and `origin` are in output pixels; `extras` points are in texel units."""
    for b in boxes:
        b.pos = b.pos * s; b.scale = np.array(b.scale, float) * s; b.pivot = b.pivot * s; b.inflate = b.inflate * s
    ex = {n: tuple(np.array(v, float) * s) for n, v in (extras or {}).items()} or None
    return render(boxes, yaw=yaw, size=size, origin=origin, k=k, shade=shade, extras=ex)


def crop_to(img, w, h, anchor_bottom=True):
    """Place img (already the right size or larger) into a w x h frame, bottom-centred."""
    H, W = img.shape[:2]
    out = np.zeros((h, w, 4), np.uint8)
    x0 = (w - W) // 2
    y0 = h - H if anchor_bottom else 0
    sx0, sy0 = max(0, -x0), max(0, -y0)
    dx0, dy0 = max(0, x0), max(0, y0)
    ww, hh = min(W - sx0, w - dx0), min(H - sy0, h - dy0)
    out[dy0:dy0 + hh, dx0:dx0 + ww] = img[sy0:sy0 + hh, sx0:sx0 + ww]
    return out


def upscale(img, s):
    return np.repeat(np.repeat(img, s, 0), s, 1)


def mc_box(tex, uv, origin, size, pivot=(0, 0, 0), rot=(0, 0, 0), inflate=0.0, mirror=False, part='', s=1.0, glow=False, extra=None):
    """A box written the way Minecraft's model code writes it (y down, feet at y = 24, front = -z,
    rotations applied Z then Y then X about the pivot), converted to this renderer's frame.
    `s` scales the whole part about the model origin (for FireRed-sized mobs); `extra` is an optional
    3x3 matrix applied after the part's own rotation (e.g. a walk swing)."""
    x0, y0, z0 = origin
    w, h, d = size
    px, py, pz = pivot
    a, b, c = rot
    R = rot_z(-c) @ rot_y(-b) @ rot_x(a)
    if extra is not None:
        R = extra @ R
    P = np.array([px, 24 - py, -pz], float) * s
    rel = np.array([x0, -(y0 + h), -(z0 + d)], float) * s
    return Box(tex, uv, size, P + rel, scale=(s, s, s), pivot=P, part=part, inflate=inflate * s, mirror=mirror, mat=R, glow=glow)


# ---------------------------------------------------------------- the same ray caster, vectorised (The End's big sprites)
_FACE_NAMES = {(0, 0): 'right', (0, 1): 'left', (1, 0): 'bottom', (1, 1): 'top', (2, 0): 'back', (2, 1): 'front'}


def _sample_np(box, name, lp):
    """_sample for many hit points at once (lp: N x 3, all on face `name`). Returns N x 4 texels."""
    w, h, d = box.size
    lx = (lp[:, 0] - box.inflate) / box.scale[0]
    ly = (lp[:, 1] - box.inflate) / box.scale[1]
    lz = (lp[:, 2] - box.inflate) / box.scale[2]
    if box.mirror:
        lx = w - lx
        name = {'right': 'left', 'left': 'right'}.get(name, name)
    fu, fv, fw, fh = box.faces()[name]
    if fw <= 0 or fh <= 0:
        return np.zeros((len(lp), 4), np.uint8)
    if name == 'front':
        c, r = lx, h - ly
    elif name == 'back':
        c, r = w - lx, h - ly
    elif name == 'right':
        c, r = lz, h - ly
    elif name == 'left':
        c, r = d - lz, h - ly
    elif name == 'top':
        c, r = lx, lz
    else:
        c, r = lx, d - lz
    c = np.clip(np.floor(c).astype(int), 0, fw - 1)
    r = np.clip(np.floor(r).astype(int), 0, fh - 1)
    tex = box.tex
    return tex[np.clip(fv + r, 0, tex.shape[0] - 1), np.clip(fu + c, 0, tex.shape[1] - 1)]


def render_fast(boxes, yaw=0.0, size=(32, 40), origin=(16, 36), k=K, shade=SHADE, extras=None):
    """render() with numpy over the pixels (same projection, same texel rules, same outputs). Each box only
    casts the rays inside its own projected bounding rectangle."""
    W, H = size
    out = np.zeros((H, W, 4), np.uint8)
    part = np.full((H, W), -1, np.int32)
    best = np.full(H * W, 1e18)
    rgb = np.zeros((H * W, 3), np.uint8)
    hit = np.full(H * W, -1, np.int32)
    Ry = rot_y(yaw)
    D = np.array([0.0, -k, -1.0])
    Z0 = 64.0
    sy, sx = np.mgrid[0:H, 0:W]
    Xs = (sx + 0.5 - origin[0]).ravel()
    Vs = (sy + 0.5 - origin[1]).ravel()
    for bi, b in enumerate(boxes):
        Mw = Ry @ b.matrix()
        Minv = Mw.T
        corner = Ry @ (b.pivot + b.matrix() @ (b.pos - b.inflate - b.pivot))
        ext = b.extent()
        # screen rectangle of the box's eight corners
        cs = np.array([[i * ext[0], j * ext[1], l * ext[2]] for i in (0, 1) for j in (0, 1) for l in (0, 1)]) @ Mw.T + corner
        px = cs[:, 0] + origin[0]
        py = -cs[:, 1] + k * cs[:, 2] + origin[1]
        x0, x1 = max(0, int(np.floor(px.min())) - 1), min(W, int(np.ceil(px.max())) + 1)
        y0, y1 = max(0, int(np.floor(py.min())) - 1), min(H, int(np.ceil(py.max())) + 1)
        if x0 >= x1 or y0 >= y1:
            continue
        idx = (np.arange(y0, y1)[:, None] * W + np.arange(x0, x1)[None, :]).ravel()
        X, V = Xs[idx], Vs[idx]
        O = np.stack([X, k * Z0 - V, np.full(X.shape, Z0)], 1)
        o = (O - corner) @ Minv.T
        dd = Minv @ D
        n = len(idx)
        tmin = np.full(n, -1e18); tmax = np.full(n, 1e18)
        ent = np.full(n, -1); exi = np.full(n, -1)
        ok = np.ones(n, bool)
        for ax in range(3):
            if abs(dd[ax]) < 1e-12:
                ok &= (o[:, ax] >= 0) & (o[:, ax] <= ext[ax])
                continue
            t1 = (0 - o[:, ax]) / dd[ax]
            t2 = (ext[ax] - o[:, ax]) / dd[ax]
            lo, hi = np.minimum(t1, t2), np.maximum(t1, t2)
            m = lo > tmin
            tmin = np.where(m, lo, tmin); ent = np.where(m, ax, ent)
            m = hi < tmax
            tmax = np.where(m, hi, tmax); exi = np.where(m, ax, exi)
        ok &= (tmin <= tmax) & (ent >= 0) & (tmax >= 0)
        done = np.zeros(n, bool)
        for which in (0, 1):
            t = tmin if which == 0 else tmax
            axs = ent if which == 0 else exi
            cand = ok & ~done & (t < best[idx])
            if not cand.any():
                continue
            for ax in range(3):
                if abs(dd[ax]) < 1e-12:
                    continue
                entry_side = 0 if dd[ax] > 0 else 1
                side = entry_side if which == 0 else 1 - entry_side
                name = _FACE_NAMES[(ax, side)]
                m = cand & (axs == ax)
                if not m.any():
                    continue
                lp = o[m] + dd[None, :] * t[m][:, None]
                lp = np.clip(lp, 0, ext)
                px_ = _sample_np(b, name, lp)
                opaque = px_[:, 3] >= 128
                sel = np.nonzero(m)[0][opaque]
                if not len(sel):
                    continue
                s = 1.0 if b.glow else shade.get(name, 1.0)
                gi = idx[sel]
                best[gi] = t[sel]
                rgb[gi] = np.clip(px_[opaque, :3].astype(float) * s, 0, 255).astype(np.uint8)
                hit[gi] = bi
                done[sel] = True
    on = hit >= 0
    out.reshape(-1, 4)[on, :3] = rgb[on]
    out.reshape(-1, 4)[on, 3] = 255
    part.ravel()[:] = hit
    depth = np.where(on, -best, -1e9).reshape(H, W)
    pts = {}
    if extras:
        for name, p in extras.items():
            w = Ry @ np.array(p, float)
            pts[name] = (w[0] + origin[0], -w[1] + k * w[2] + origin[1])
    return out, part, depth, pts


def outline_fast(img, color=(24, 20, 28), part=None, depth=None, inner=None):
    """outline() with numpy: the same 1px silhouette (and optional inner part edges)."""
    a = img[:, :, 3] > 0
    res = img.copy()
    nb = np.zeros_like(a)
    nb[:, :-1] |= a[:, 1:]; nb[:, 1:] |= a[:, :-1]; nb[:-1, :] |= a[1:, :]; nb[1:, :] |= a[:-1, :]
    ring = nb & ~a
    res[ring, :3] = color
    res[ring, 3] = 255
    if inner is not None and part is not None and depth is not None:
        H, W = a.shape
        dark = np.zeros_like(a)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            ys, ye = max(0, -dy), H - max(0, dy)
            xs, xe = max(0, -dx), W - max(0, dx)
            here = (slice(ys, ye), slice(xs, xe))
            there = (slice(ys + dy, ye + dy), slice(xs + dx, xe + dx))
            m = a[here] & a[there] & (part[here] != part[there]) & (depth[here] < depth[there] - inner)
            dark[here] |= m
        res[dark, :3] = (res[dark, :3].astype(float) * 0.45).astype(np.uint8)
    return res
