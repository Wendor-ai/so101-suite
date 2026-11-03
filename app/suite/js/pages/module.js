// Module host (#/m/<id>/<page>): finds the module, loads the page script it declares and renders it like any page.
// A missing, switched-off, broken or non-loading module shows a friendly card. It must never take the app down.
import { h, icon, button, callout, skeleton, loadCss, safe } from '../ui.js';
import { api } from '../api.js';
import { moduleList, hrefFor } from './modules.js';

loadCss(new URL('../../css/pages/modules.css', import.meta.url).href);

const ID_OK = /^[a-z][a-z0-9_]{1,31}$/;
const SCRIPT_OK = (s) => typeof s === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(s) && !s.split('/').some((p) => p === '..' || p === '');
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The shell has no nav item for #/m/..., so light up "Modules" ourselves (the next navigation resets it). */
function lightModulesNav() {
  try { document.querySelector('nav.nav a.item[href="#/modules"]')?.setAttribute('aria-current', 'page'); } catch { /* cosmetic only */ }
}
function setWhere(text) {
  try { const b = document.querySelector('.topbar .where b'); if (b && text) b.textContent = text; } catch { /* cosmetic only */ }
}

export default {
  id: 'module', title: 'Module',
  render(root, ctx, route) {
    const id = route?.args?.[0] || '';
    const wanted = route?.args?.[1] || '';
    let dead = false, pageCleanup = null, tries = 0;

    const bar = h('div', { class: 'mod-bar' });
    const host = h('div', { class: 'mod-host' });
    root.append(h('div', {}, bar, host));
    lightModulesNav();

    const crumb = (name) => h('div', { class: 'crumb' }, h('a', { href: '#/modules' }, icon('back'), 'Modules'), '/', h('b', {}, name));
    const problem = (title, text, { retry = false } = {}) => {
      host.replaceChildren(h('div', { class: 'card mod-problem' },
        callout('warn', text, title),
        h('div', { class: 'row' }, button('Open Modules', { href: '#/modules', kind: 'primary', icon: 'modules' }), retry ? button('Try again', { onClick: safe(start) }) : null, button('Help', { href: '#/help', kind: 'ghost' }))));
    };

    async function start() {
      bar.replaceChildren(crumb(id || 'Module'));
      host.replaceChildren(skeleton('40%', 22), h('div', { style: { height: '12px' } }), skeleton('100%', 160));
      if (!id) { problem('No module chosen', 'Open the Modules page and pick a module from there.'); return; }
      if (!ID_OK.test(id)) { problem('That is not a module link', `<b>${esc(id)}</b> is not a valid module name. Module names use lowercase letters, digits and underscores. Open the Modules page and pick one from there.`); return; }

      let mod;
      try { mod = moduleList(await api.get('/api/suite/modules')).find((m) => m.id === id); }
      catch (e) { if (!dead) problem('Could not look up the module', `${esc(e.message || e)} The app could not tell us which modules are installed.`, { retry: true }); return; }
      if (dead) return;

      if (!mod) { problem('This module is not installed', `There is no module called <b>${esc(id)}</b>. It may have been removed, renamed, or the app was not restarted after adding it.`); return; }
      const name = mod.name || mod.id;
      bar.replaceChildren(crumb(name));
      setWhere(name);
      if (mod.error) { problem(`${esc(name)} did not load`, `It said: <b>${esc(mod.error)}</b>. The rest of the app is fine. Fix the module’s files and restart the app, or move its folder out of <code>modules/</code>.`); return; }
      if (mod.enabled === false) { problem(`${esc(name)} is switched off`, 'Modules are turned off, or this one is. You can turn them back on in Settings, under Advanced, then open it again.'); return; }
      const pages = Array.isArray(mod.pages) ? mod.pages : [];
      if (!pages.length) { problem(`${esc(name)} has no pages`, `This module only adds routes under <code>/api/m/${esc(mod.id)}/</code>. It has nothing to show here.`); return; }
      const pg = wanted ? pages.find((p) => p.id === wanted) : pages[0];
      if (!pg) { problem(`${esc(name)} has no page called “${esc(wanted)}”`, `Its pages are: ${pages.map((p) => `<b>${esc(p.title || p.id)}</b>`).join(', ')}.`); return; }
      if (pages.length > 1) bar.append(h('nav', { class: 'tabs', 'aria-label': `${name} pages` }, pages.map((p) => h('a', { class: 'tab', href: hrefFor(mod.id, p.id), 'aria-current': p.id === pg.id ? 'page' : null }, p.title || p.id))));
      if (!SCRIPT_OK(pg.script)) { problem(`${esc(name)} points at a file we will not load`, `The page script <code>${esc(pg.script)}</code> is not a plain file inside the module’s folder.`); return; }

      const url = new URL(`../../modules/${mod.id}/${pg.script}`, import.meta.url).href + (tries++ ? `?retry=${Date.now()}` : '');
      let loaded;
      try { loaded = await import(url); }
      catch (e) {
        if (!dead) problem(`${esc(name)} could not load its page`, `The page script <code>${esc(pg.script)}</code> would not load. Check that the file is in <code>modules/${esc(mod.id)}/</code>, has no typing mistakes, and restart the app.<br>The browser said: ${esc(e.message || e)}`, { retry: true });
        return;
      }
      if (dead) return;
      const def = loaded?.default;
      const fn = typeof def === 'function' ? def : typeof def?.render === 'function' ? def.render.bind(def) : null;
      if (!fn) { problem(`${esc(name)} has no page to show`, `<code>${esc(pg.script)}</code> must export a default page: <code>export default { render(root, ctx) { … } }</code>.`); return; }

      const title = pg.title || (typeof def === 'object' && def?.title) || name;
      document.title = `${title} · ${name} · SO-101 Suite`;
      host.replaceChildren();
      let cleanup;
      try { cleanup = await fn(host, ctx, route); }
      catch (e) {
        console.error(e);
        if (!dead) problem(`${esc(name)} hit a problem`, `Its page stopped with: <b>${esc(e.message || e)}</b>. The rest of the app is fine.`, { retry: true });
        return;
      }
      if (typeof cleanup === 'function') { if (dead) { try { cleanup(); } catch (e) { console.error(e); } } else pageCleanup = cleanup; }
    }

    start().catch((e) => { console.error(e); if (!dead) problem('Something went wrong', esc(e.message || e)); });
    return () => {
      dead = true;
      try { pageCleanup?.(); } catch (e) { console.error(e); }
      pageCleanup = null;
    };
  },
};
