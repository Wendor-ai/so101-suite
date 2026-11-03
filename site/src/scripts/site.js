// Tiny progressive enhancements: theme toggle, OS tabs, copy buttons, glossary filter. No dependencies.
const root = document.documentElement;
const safe = (fn) => { try { return fn(); } catch { return undefined; } };

/* ---- theme ---- */
function effectiveTheme() {
  const t = root.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function labelToggle() {
  for (const b of document.querySelectorAll('[data-theme-toggle]')) {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    b.setAttribute('aria-label', `Switch to ${next} theme`);
    b.setAttribute('title', `Switch to ${next} theme`);
  }
}
labelToggle();
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', labelToggle);
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-theme-toggle]');
  if (!b) return;
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  safe(() => localStorage.setItem('so101-site-theme', next));
  labelToggle();
});

/* ---- OS tabs (pre-select by the visitor's system; keyboard: arrows, Home, End) ---- */
function guessOs() {
  const ua = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '').toLowerCase();
  if (/win/.test(ua)) return 'win';
  if (/mac|iphone|ipad/.test(ua)) return 'mac';
  if (/linux|x11|cros|android/.test(ua)) return 'linux';
  return null;
}
for (const box of document.querySelectorAll('[data-tabs]')) {
  const tabs = [...box.querySelectorAll('[role="tab"]')];
  const panels = [...box.querySelectorAll('[role="tabpanel"]')];
  const select = (key, focus) => {
    for (const t of tabs) { const on = t.dataset.key === key; t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); }
    for (const p of panels) p.hidden = p.dataset.key !== key;
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t.dataset.key));
    t.addEventListener('keydown', (e) => {
      const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      let n = null;
      if (k) n = (i + k + tabs.length) % tabs.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = tabs.length - 1;
      if (n !== null) { e.preventDefault(); select(tabs[n].dataset.key, true); }
    });
  });
  const os = guessOs();
  if (os && tabs.some((t) => t.dataset.key === os)) select(os);
}

/* ---- copy buttons ---- */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove(); return ok;
}
document.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('[data-copy]');
  if (!btn) return;
  const src = btn.closest('.cmd, .win, [data-copy-scope]')?.querySelector('[data-copy-source]');
  if (!src) return;
  const clone = src.cloneNode(true);
  clone.querySelectorAll('.p, [aria-hidden="true"]').forEach((n) => n.remove());
  const ok = await copyText(clone.textContent.replace(/\n+$/, ''));
  const status = btn.closest('[data-tabs], section, div')?.querySelector('[data-copy-status]') || document.querySelector('[data-copy-status]');
  if (ok) {
    btn.dataset.copied = '1';
    if (status) status.textContent = 'Copied to the clipboard.';
    setTimeout(() => { delete btn.dataset.copied; if (status) status.textContent = ''; }, 2200);
  } else if (status) status.textContent = 'Could not copy. Select the text and copy it by hand.';
});

/* ---- glossary filter ---- */
const filter = document.querySelector('[data-gl-filter]');
if (filter) {
  const items = [...document.querySelectorAll('[data-gl-item]')];
  const letters = [...document.querySelectorAll('[data-gl-letter]')];
  const out = document.querySelector('[data-gl-count]');
  const apply = () => {
    const q = filter.value.trim().toLowerCase();
    let n = 0;
    for (const it of items) { const hit = !q || it.dataset.text.includes(q); it.hidden = !hit; if (hit) n++; }
    for (const l of letters) l.hidden = !!q;
    if (out) out.textContent = q ? `${n} ${n === 1 ? 'term matches' : 'terms match'}` : '';
  };
  filter.addEventListener('input', apply);
}
