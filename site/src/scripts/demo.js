// Loads the real app (copied to /app by scripts/sync-app.mjs) into the frame in demo mode.
// /demo#/calibrate opens the app on that page; /demo?scenario=ready&seed=7 is passed through.
const frame = document.querySelector('[data-demo-frame]');
const loader = document.querySelector('[data-demo-load]');
const msg = document.querySelector('[data-demo-msg]');
// the dev server has no directory index for /app/, a real host does
const base = import.meta.env.DEV ? '/app/index.html' : '/app/';
if (frame) {
  const q = new URLSearchParams(location.search);
  const out = new URLSearchParams({ demo: '1' });
  for (const k of ['scenario', 'seed', 'os']) if (q.has(k)) out.set(k, q.get(k));
  frame.addEventListener('load', () => {
    frame.dataset.ready = '1';
    loader?.remove();
    // keep this page's address in step with the app's page, so the URL can be shared
    try {
      const w = frame.contentWindow;
      w.addEventListener('hashchange', () => {
        const h = w.location.hash;
        history.replaceState(null, '', location.pathname + location.search + (h && h !== '#/' ? h : ''));
      });
    } catch { /* cross-origin or blocked: fine */ }
  });
  frame.src = base + '?' + out.toString() + location.hash;
  const open = document.querySelector('[data-demo-open]');
  if (open) open.href = base + '?' + out.toString();
  setTimeout(() => { if (!frame.dataset.ready && msg) msg.textContent = 'Still loading. If nothing appears, open the demo in its own tab with the link below.'; }, 8000);
}
