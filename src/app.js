// App mode: a desktop or Android wrapper sets
//   window.REDSTONE_APP = { platform: 'desktop' | 'android' }
// in its page before src/main.js loads. Its page's own origin is the app's http://localhost or http://127.0.0.1, so
// in app mode co-op connects to SITE's room server (src/net/room.js) and a shared room link points at SITE. SITE is
// empty in this repository: an app build sets it to the https:// address of the deployment that runs the room relay.
// Nothing else differs. Without the flag (the website) APP is null.
export const SITE = '';
export const APP = (() => {
  try {
    const a = typeof window !== 'undefined' ? window.REDSTONE_APP : null;
    return a && typeof a === 'object' ? { platform: String(a.platform || '') } : null;
  } catch (e) { return null; }
})();
