// Boot: decide live backend vs built-in demo, load settings, mount the shell, start the router.
import { api } from './api.js';
import { createCtx, applySettings } from './state.js';
import { mountShell } from './shell.js';
import { startRouter, parse } from './router.js';
import { h } from './ui.js';

const root = document.getElementById('app');

function storage() {
  try { const k = '__so101_probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return localStorage; }
  catch { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
}

async function hasLiveBackend() {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 2500);
  try { const r = await fetch('/api/suite/info', { signal: ctl.signal }); return r.ok && (r.headers.get('content-type') || '').includes('json'); }
  catch { return false; } finally { clearTimeout(t); }
}

function fatal(title, text) {
  root.replaceChildren(h('div', { style: { maxWidth: '520px', margin: '20vh auto', padding: '0 20px', fontFamily: 'system-ui', color: 'var(--text,#e8eef6)' } }, h('h1', {}, title), h('p', {}, text)));
}

async function boot() {
  const qs = new URLSearchParams(location.search);
  const forceDemo = qs.has('demo') || window.SO101_DEMO;
  if (forceDemo || !(await hasLiveBackend())) {
    try {
      const { createMockBackend } = await import('./mock/backend.js');
      api.use(createMockBackend({ seed: Number(qs.get('seed') || 1), scenario: qs.get('scenario') || 'fresh', os: qs.get('os') || undefined, storage: storage() }));
    } catch (e) {
      console.error(e);
      return fatal('The demo files are missing', 'This build has no backend to talk to and no built-in demo. Run `so101 start` on your computer, or use a full download of the project.');
    }
  }
  const ctx = createCtx();
  await ctx.init();
  applySettings(ctx.settings);
  if (qs.get('theme')) document.documentElement.dataset.theme = qs.get('theme');            // ?theme=dark|light|auto (not saved; used by the website and screenshots)
  if (qs.get('accent')) document.documentElement.style.setProperty('--accent', `#${qs.get('accent').replace('#', '')}`);
  window.so101 = ctx; // handy for debugging and for AI agents driving the page
  if (parse().page === '' && ctx.info?.onboarded === false && !location.hash) location.hash = '#/welcome'; // before the shell, so the one-time calibration sheet waits for the Welcome page to be left
  const shell = mountShell(root, ctx);
  startRouter(ctx, shell);
  ctx.start();
}
boot().catch((e) => { console.error(e); fatal('Something went wrong starting the app', String(e.message || e)); });
