// Glossary: every term the app uses, A to Z, searchable. #/glossary/<id> opens and highlights one term.
import { h, icon, button, empty, rich, loadCss, debounce } from '../ui.js';

loadCss(new URL('../../css/pages/glossary.css', import.meta.url).href);

const letterOf = (s) => { const c = String(s || '').trim().charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };
const reduced = () => document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

export default {
  id: 'glossary', title: 'Glossary',
  async render(root, ctx, route) {
    let terms = null;
    try { terms = (await import('../content/glossary.js')).default; } catch (e) { console.warn('glossary content missing', e); }
    if (!terms?.length) {
      root.append(h('div', { class: 'stack-lg' }, h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Learn'), h('h1', {}, 'Glossary')),
        empty('The glossary is not part of this build', 'The official guide explains the words in the meantime.', button('Open the official SO-101 guide', { href: 'https://huggingface.co/docs/lerobot/so101', kind: 'primary', icon: 'external' }))));
      return () => {};
    }
    const list = [...terms].sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }));
    const byId = new Map(list.map((g) => [g.id, g]));
    let alive = true, current = null, hitTimer = 0;

    /* ---- entries ---- */
    const items = new Map(); // id -> {el, hay, head}
    const seeChip = (id) => { const g = byId.get(id); return g ? h('a', { class: 'chip link gl-see', href: `#/glossary/${id}`, onclick: (e) => { e.preventDefault(); focusTerm(id, { push: true }); } }, g.term) : null; };
    const entry = (g) => {
      const body = h('div', { class: 'gl-body' },
        h('p', { class: 'gl-long' }, rich(g.long || g.short)),
        g.see?.length ? h('div', { class: 'gl-seeall' }, h('span', { class: 'muted' }, 'See also'), h('div', { class: 'gl-chips' }, g.see.map(seeChip).filter(Boolean))) : null);
      const el = h('details', { class: 'gl-item', id: 'g-' + g.id },
        h('summary', {}, h('span', { class: 'gl-text' }, h('span', { class: 'gl-term' }, g.term), h('span', { class: 'gl-short' }, rich(g.short))), icon('chevron')),
        body);
      items.set(g.id, { el, g, head: (g.term + ' ' + g.id + ' ' + g.short).toLowerCase(), hay: (g.term + ' ' + g.id + ' ' + g.short + ' ' + g.long).toLowerCase() });
      return el;
    };
    const groups = new Map();
    for (const g of list) { const l = letterOf(g.term); if (!groups.has(l)) groups.set(l, []); groups.get(l).push(g); }
    const letters = [...groups.keys()].sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
    const sections = new Map();
    const sectionEls = letters.map((l) => { const s = h('section', { class: 'gl-sec', id: 'gl-' + (l === '#' ? 'num' : l), 'aria-labelledby': 'gl-h-' + l }, h('h2', { id: 'gl-h-' + l }, l), h('div', { class: 'gl-list' }, groups.get(l).map(entry))); sections.set(l, s); return s; });

    /* ---- controls ---- */
    const input = h('input', { class: 'input gl-input', type: 'search', id: 'gl-q', placeholder: 'Search, for example “jaw”, “motor ID”, “limp”', autocomplete: 'off', spellcheck: 'false' });
    const count = h('p', { class: 'gl-count muted', role: 'status', 'aria-live': 'polite' }, `${list.length} terms`);
    const az = h('nav', { class: 'gl-az', 'aria-label': 'Jump to a letter' }, letters.map((l) => h('a', { href: '#', 'data-l': l, onclick: (e) => { e.preventDefault(); if (e.currentTarget.getAttribute('aria-disabled') === 'true') return; sections.get(l)?.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }); } }, l)));
    const emptyBox = h('div', { class: 'gl-empty', hidden: true });

    function applyFilter() {
      const q = input.value.trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const { el, hay, head } of items.values()) {
        const ok = !words.length || words.every((w) => hay.includes(w));
        el.hidden = !ok;
        if (ok) shown++;
        if (words.length) el.open = ok && !words.every((w) => head.includes(w)); // matched only deep in the text: show why
        else if (el.id.slice(2) !== current) el.open = false;
      }
      for (const [l, s] of sections) { const any = groups.get(l).some((g) => !items.get(g.id).el.hidden); s.hidden = !any; az.querySelector(`[data-l="${l}"]`)?.setAttribute('aria-disabled', String(!any)); }
      count.textContent = words.length ? `${shown} of ${list.length} terms match “${input.value.trim()}”` : `${list.length} terms`;
      emptyBox.hidden = shown > 0;
      if (!shown) emptyBox.replaceChildren(empty(`No term matches “${input.value.trim()}”`, 'Try a shorter word or another spelling. A word from the app that is missing here is a gap in the glossary: Help shows where to tell us.', h('div', { class: 'row', style: { justifyContent: 'center' } }, button('Clear search', { kind: 'primary', onClick: () => { input.value = ''; applyFilter(); input.focus(); } }), button('Open Help', { href: '#/help', icon: 'life' }))));
    }
    input.addEventListener('input', debounce(applyFilter, 90));
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { input.value = ''; applyFilter(); } });

    /* ---- open, scroll to and highlight one term ---- */
    function focusTerm(id, { push = false } = {}) {
      const it = items.get(id);
      if (!it) return;
      if (input.value) { input.value = ''; applyFilter(); }
      if (push) { try { history.pushState(null, '', `#/glossary/${id}`); } catch { /* keep going */ } }
      if (current && items.get(current)) items.get(current).el.classList.remove('hit');
      current = id;
      it.el.open = true; it.el.classList.add('hit');
      it.el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
      it.el.querySelector('summary')?.focus({ preventScroll: true });
      clearTimeout(hitTimer);
    }

    root.append(h('div', { class: 'stack gl' },
      h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Learn'), h('h1', {}, 'Glossary'), h('p', { class: 'lead' }, 'Every word the app uses, in plain language. Tap a word to read more, or search.')),
      h('div', { class: 'gl-bar' }, h('div', { class: 'gl-find' }, h('label', { class: 'sr-only', for: 'gl-q' }, 'Search the glossary'), h('span', { class: 'gl-ico', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>' }), input), count, az),
      emptyBox, sectionEls));

    const want = route.args[0];
    if (want && items.has(want)) setTimeout(() => { if (alive) focusTerm(want); }, 120); // after the router has scrolled to the top
    else if (want) { emptyBox.hidden = false; emptyBox.replaceChildren(empty('We could not find that term', `There is no glossary entry called “${want}”. The full list is below.`, null)); }
    return () => { alive = false; clearTimeout(hitTimer); };
  },
};
