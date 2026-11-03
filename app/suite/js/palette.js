// Command palette (Ctrl/Cmd+K): jump to any page, Learn article or glossary term, or run a safe action.
import { h, icon, clear, rich, toast } from './ui.js';
import { api } from './api.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const shortcutLabel = isMac ? '⌘K' : 'Ctrl K';

async function contentList(file, map) {
  try { return (await import(`./content/${file}.js`)).default.map(map); } catch { return []; }
}

export function mountPalette(ctx, nav) {
  let back = null, items = [], shown = [], sel = 0, input, list;

  async function build() {
    const pages = nav.filter((n) => !n.group).map((n) => ({ label: n.label, hint: 'Go to', icon: n.icon, kw: n.id, run: () => ctx.go(n.id) }));
    const themes = ['auto', 'dark', 'light'].map((t) => ({ label: `Theme: ${t[0].toUpperCase() + t.slice(1)}`, hint: 'Setting', icon: 'gear', kw: 'appearance dark light', run: () => ctx.setSetting('ui.theme', t) }));
    const actions = [
      { label: 'Copy diagnostics', hint: 'Help', icon: 'copy', kw: 'bug report problem support', run: async () => { try { await navigator.clipboard.writeText(await api.get('/api/suite/diagnostics')); toast('Diagnostics copied.', 'ok', 2000); } catch (e) { toast(`Could not copy: ${e.message}`, 'warn'); } } },
      { label: 'Show the welcome screens again', hint: 'Setting', icon: 'rocket', kw: 'onboarding start', run: () => ctx.go('welcome') },
    ];
    const [learn, gloss] = await Promise.all([
      contentList('learn', (a) => ({ label: a.title, hint: 'Learn', icon: 'book', kw: `${a.summary || ''} ${a.id}`, run: () => ctx.go(`learn/${a.id}`) })),
      contentList('glossary', (g) => ({ label: g.term, hint: 'Glossary', icon: 'quote', kw: `${g.short || ''} ${g.id}`, run: () => ctx.go(`glossary/${g.id}`) })),
    ]);
    items = [...pages, ...actions, ...themes, ...learn, ...gloss].map((i) => ({ ...i, hay: `${i.label} ${i.hint} ${i.kw || ''}`.toLowerCase() }));
  }

  function filter(q) {
    const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
    shown = (toks.length ? items.filter((i) => toks.every((t) => i.hay.includes(t))) : items.filter((i) => i.hint === 'Go to')).slice(0, 9);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    draw();
  }
  function draw() {
    clear(list);
    if (!shown.length) { list.append(h('li', { class: 'pal-empty' }, 'Nothing matches. Try a different word, or open Help.')); return; }
    shown.forEach((it, i) => list.append(h('li', { id: `pal-${i}`, role: 'option', 'aria-selected': i === sel ? 'true' : 'false', class: 'pal-item' + (i === sel ? ' sel' : ''), onmousemove: () => { if (sel !== i) { sel = i; draw(); } }, onclick: () => run(i) },
      icon(it.icon || 'arrow'), h('span', { class: 'grow' }, it.label), h('span', { class: 'muted' }, it.hint))));
    input.setAttribute('aria-activedescendant', `pal-${sel}`);
  }
  function run(i) { const it = shown[i]; close(); if (it) Promise.resolve(it.run()).catch((e) => toast(String(e.message || e), 'err')); }
  function close() { back?.remove(); back = null; document.removeEventListener('keydown', onKey, true); }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, shown.length); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + Math.max(1, shown.length)) % Math.max(1, shown.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  }
  async function open() {
    if (back) return close();
    if (!items.length) await build();
    input = h('input', { class: 'input', type: 'search', placeholder: 'Jump to a page, an article, a word…', 'aria-label': 'Search', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', autocomplete: 'off', oninput: () => { sel = 0; filter(input.value); } });
    list = h('ul', { class: 'pal-list', id: 'pal-list', role: 'listbox' });
    back = h('div', { class: 'dlg-back pal-back', onclick: (e) => { if (e.target === back) close(); } },
      h('div', { class: 'pal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' }, input, list, h('div', { class: 'pal-foot muted' }, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' to move · ', h('kbd', {}, 'Enter'), ' to open · ', h('kbd', {}, 'Esc'), ' to close')));
    document.body.append(back);
    document.addEventListener('keydown', onKey, true);
    filter(''); input.focus();
  }
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
  });
  return { open, close };
}
