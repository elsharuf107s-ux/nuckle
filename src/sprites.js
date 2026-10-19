// Sprite helpers shared by the FireRed screens.
const silCache = new Map();
// A solid-colour silhouette of an image (for flashes and tints), cached per image and colour.
export function silhouette(img, color = '#fff') {
  let m = silCache.get(img);
  if (!m) { m = new Map(); silCache.set(img, m); }
  let s = m.get(color);
  if (!s) {
    s = document.createElement('canvas'); s.width = img.width; s.height = img.height;
    const x = s.getContext('2d'); x.drawImage(img, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, s.width, s.height);
    m.set(color, s);
  }
  return s;
}
