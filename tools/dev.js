// Headless test helpers, loaded into the page with: await import('/tools/dev.js?' + Date.now())
export const H = window.__rs;
H.pause();
export const shot = async (name) => { const d = H.frame(); await fetch('http://127.0.0.1:5399/', { method: 'POST', body: name + '\n' + d }); return name; };
export const run = (n, dt = 1 / 30) => { for (let i = 0; i < n; i++) H.tick({ dt, capture: false }); };
export const hold = (k, n, dt = 1 / 30) => { for (let i = 0; i < n; i++) H.tick({ hold: k, press: i === 0 ? k : undefined, dt, capture: false }); };
export const press = (k, after = 4) => { H.tick({ press: k, capture: false }); run(after); };
export const clearMsgs = (max = 60) => {
  for (let i = 0; i < max; i++) {
    const b = H.battle();
    const busy = H.msg() || (b && b.cur && b.cur.type === 'msg');
    if (!busy && !(b && (b.cur || b.q.length))) return true;
    if (busy) H.tick({ press: 'a', capture: false });
    run(6);
  }
  return false;
};
// Walk to a tile, one axis at a time.
export const walkTo = (tx, ty, max = 2000) => {
  for (let i = 0; i < max; i++) {
    const P = H.P;
    if (!P.moving && P.tx === tx && P.ty === ty) return true;
    if (H.state() !== 'play') return false;
    let d = null;
    if (P.tx < tx) d = 'right'; else if (P.tx > tx) d = 'left'; else if (P.ty > ty) d = 'up'; else if (P.ty < ty) d = 'down';
    H.tick({ hold: d, dt: 1 / 30, capture: false });
  }
  return false;
};
export const face = (d) => { H.P.dir = d; run(1); };
export const mine = (n = 200) => { for (let i = 0; i < n; i++) { H.tick({ hold: 'a', dt: 1 / 30, capture: false }); if (!H.P.mining && i > 2) return i; } return n; };
window.dev = { H, shot, run, hold, press, clearMsgs, walkTo, face, mine };
