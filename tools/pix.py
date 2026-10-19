"""Tiny pixel-art helpers: palettes as letter maps, ASCII overlays, RGBA arrays."""
import numpy as np
from PIL import Image

def hexc(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

class Pal(dict):
    """letter -> (r,g,b); '.' is transparent."""
    def __init__(self, **kw):
        super().__init__()
        for k, v in kw.items():
            self[k] = hexc(v) if isinstance(v, str) else tuple(v)

def from_ascii(rows, pal, w=None):
    rows = [r for r in rows]
    h = len(rows); w = w or max(len(r) for r in rows)
    out = np.zeros((h, w, 4), np.uint8)
    for y, r in enumerate(rows):
        for x, ch in enumerate(r):
            if ch in ('.', ' '):
                continue
            out[y, x, :3] = pal[ch]; out[y, x, 3] = 255
    return out

def paint(img, rows, pal, x0=0, y0=0, erase='_'):
    """Overlay ASCII onto an RGBA array. '.' leaves the pixel, `erase` clears it."""
    for y, r in enumerate(rows):
        for x, ch in enumerate(r):
            if ch == '.' or ch == ' ':
                continue
            yy, xx = y0 + y, x0 + x
            if not (0 <= yy < img.shape[0] and 0 <= xx < img.shape[1]):
                continue
            if ch == erase:
                img[yy, xx] = 0
            else:
                img[yy, xx, :3] = pal[ch]; img[yy, xx, 3] = 255
    return img

def save(arr, path, scale=1):
    im = Image.fromarray(arr, 'RGBA')
    if scale != 1:
        im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
    im.save(path, optimize=True)
    return im
