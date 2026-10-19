// Review repro (visual and phone review of the minimap, 2026-10-10): the full map's zoom cycle (A / Z) should keep
// Steve in view. Fails while MapScreen.clamp() snaps the view's centre to the region's centre at zoom 0.5 (where the
// whole region fits): every later zoom (1, 2, 4) stays on the region's centre, so a Steve who is not near the middle
// of the world drops out of view and the panel shows only fog.
//   node tools/headless.mjs tools/gen_tests/minimap_review_zoom.mjs --params '?new&play&world=kanto&wseed=1' --port <port> --out <scratch>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default async function (t) {
  const { R, idle, press, hold, log, check } = t;
  for (let i = 0; i < 100; i++) { await idle(1); if (await R('h.minimap().loaded')) break; await sleep(50); }
  await hold('right', 60); await idle(10);
  await press('map', 3);
  const rows = [];
  for (let k = 0; k < 5; k++) {
    rows.push(await R('(() => { const v = h.minimap().view, P = h.P, bx = P.tx / 4, by = P.ty / 4, vw = 264 / v.zoom; return { zoom: v.zoom, cx: +v.cx.toFixed(1), cy: +v.cy.toFixed(1), steve: [+bx.toFixed(1), +by.toFixed(1)], inView: bx >= v.left && bx < v.left + vw && by >= v.top && by < v.top + vw }; })()'));
    await press('a', 3);
  }
  for (const r of rows) log(JSON.stringify(r));
  check(rows.every((r) => r.inView), 'Steve stays in view through a whole zoom cycle (fit, 0.5, 1, 2, 4)');
}
