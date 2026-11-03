// Hash router: #/<page>/<arg>?query. Pages are loaded lazily from ./pages/<file>.js and must export default
// { id, title, group?, render(root, ctx, route) -> cleanup|void|Promise }.
import { h, icon, empty, button } from './ui.js';

const FILES = { '': 'home', welcome: 'welcome', setup: 'setup', assemble: 'assemble', motors: 'motors', calibrate: 'calibrate', cameras: 'cameras', control: 'control', modules: 'modules', learn: 'learn', glossary: 'glossary', help: 'help', test: 'test', inspector: 'inspector', settings: 'settings', m: 'module' };

export function parse() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { page: parts[0] || '', args: parts.slice(1), query: new URLSearchParams(qs) };
}

const stub = (file) => ({ id: file, title: 'Coming soon', render(root) { root.append(empty('This page is still being built', `The <code>${file}</code> page is not part of this build yet.`, button('Back to Home', { href: '#/', icon: 'back' }))); } });

export function startRouter(ctx, shell) {
  let cleanup = null, token = 0;
  async function render() {
    const mine = ++token, route = parse();
    try { cleanup?.(); } catch (e) { console.error(e); }
    cleanup = null;
    shell.setActive(route.page);
    const file = FILES[route.page];
    let page;
    if (file === undefined) page = { id: '404', title: 'Not found', render(root) { root.append(empty('We could not find that page', 'The link may be old.', button('Go Home', { href: '#/', icon: 'back' }))); } };
    else { try { page = (await import(`./pages/${file}.js`)).default; } catch (e) { console.warn('page load failed', file, e); page = stub(file); } }
    if (mine !== token) return;
    const wrap = h('div', { class: 'page-enter' });
    shell.outlet.replaceChildren(wrap);
    shell.setWhere(route.page, page.title);
    document.title = `${page.title} · SO-101 Suite`;
    try { cleanup = (await page.render(wrap, ctx, route)) || null; }
    catch (e) {
      console.error(e);
      wrap.replaceChildren(h('div', { class: 'callout warn' }, icon('alert'), h('div', {}, h('b', { class: 't' }, 'This page hit a problem'), h('p', {}, String(e.message || e)), h('p', {}, h('a', { href: '#/help' }, 'Open Help'), ' · ', h('a', { href: '#/' }, 'Go Home')))));
    }
    if (mine === token) shell.focusMain();
  }
  addEventListener('hashchange', render);
  render();
}
