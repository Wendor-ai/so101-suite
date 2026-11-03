// Modules (#/modules): what is installed, whether each one loaded, and how to add one (with an AI helper or by hand).
import { h, icon, ICONS, button, badge, callout, copyBox, empty, skeleton, loadCss, pageHead, rich, safe } from '../ui.js';
import { api } from '../api.js';

loadCss(new URL('../../css/pages/modules.css', import.meta.url).href);

const PROMPT_HEAD = 'Read AGENTS.md and .claude/skills/add-module/SKILL.md, then add a module that';
const PLACEHOLDER = '[say what it should do, e.g. show the motor temperatures on a chart]';
const EXAMPLE = `{
  "id": "my_module",
  "name": "My module",
  "description": "One sentence about what it does.",
  "version": "0.1.0",
  "author": "Your name",
  "license": "MIT",
  "pages": [
    { "id": "main", "title": "My page", "icon": "sparkles", "script": "ui.js" }
  ],
  "backend": "backend.py"
}`;

/** The list may come as an array or as {modules:[...]}. */
export const moduleList = (r) => (Array.isArray(r) ? r : Array.isArray(r?.modules) ? r.modules : []);
export const hrefFor = (id, page) => `#/m/${encodeURIComponent(id)}/${encodeURIComponent(page)}`;

function statusOf(m) {
  if (m.error) return { kind: 'bad', text: 'Error' };
  if (m.enabled === false) return { kind: 'warn', text: 'Off' };
  return { kind: 'ok', text: 'OK' };
}

function moduleCard(m, allOff) {
  const st = statusOf(m), pages = Array.isArray(m.pages) ? m.pages : [];
  const meta = [m.version ? `v${m.version}` : null, m.author ? `by ${m.author}` : null, m.license || null].filter(Boolean).join(' · ');
  const body = [];
  if (m.error) {
    body.push(callout('warn', `<b>It did not load:</b> ${esc(m.error)}<br>The rest of the app is fine. Fix the module’s files and restart the app, or move its folder out of <code>modules/</code>.`));
  } else if (m.enabled === false) {
    body.push(h('p', { class: 'muted mod-state' }, allOff ? 'All modules are turned off in Settings, under Advanced.' : 'This module is turned off, so its pages cannot be opened.'));
    if (allOff) body.push(h('div', {}, button('Open Advanced settings', { href: '#/settings/advanced', size: 'sm' })));
  } else if (!pages.length) {
    body.push(h('p', { class: 'muted mod-state' }, rich(`It has no page of its own. It only adds routes under <code>/api/m/${esc(m.id)}/</code> that other things can call.`)));
  } else {
    body.push(h('div', { class: 'row mod-open' }, pages.map((p, i) => button(`Open ${p.title || p.id}`, { href: hrefFor(m.id, p.id), kind: i === 0 ? 'primary' : 'secondary', size: 'sm', icon: 'arrow' }))));
  }
  const ic = ICONS[pages[0]?.icon] ? pages[0].icon : 'modules';
  return h('article', { class: 'card mod-card', 'data-module': m.id },
    h('header', { class: 'mod-head' }, h('div', { class: 'mod-ico' }, icon(ic)),
      h('div', { class: 'grow' }, h('h3', {}, m.name || m.id), h('div', { class: 'muted mod-meta' }, meta || `id: ${m.id}`)),
      badge(st.text, st.kind)),
    m.description ? h('p', { class: 'mod-desc' }, m.description) : null,
    ...body);
}

export default {
  id: 'modules', title: 'Modules',
  render(root, ctx) {
    let dead = false;
    const listBox = h('div', { class: 'grid grid-2' }, skeleton('100%', 150), skeleton('100%', 150));

    async function load() {
      listBox.className = 'grid grid-2';
      listBox.replaceChildren(skeleton('100%', 150), skeleton('100%', 150));
      let mods;
      try { mods = moduleList(await api.get('/api/suite/modules')); }
      catch (e) {
        if (dead) return;
        listBox.className = '';
        listBox.replaceChildren(h('div', { class: 'card stack' }, callout('warn', `${esc(e.message || e)} The list of modules could not be loaded.`, 'Could not load the modules'), h('div', {}, button('Try again', { onClick: safe(load) }))));
        return;
      }
      if (dead) return;
      const allOff = ctx.settings?.adv?.modulesEnabled === false;
      if (!mods.length) {
        listBox.className = '';
        listBox.replaceChildren(empty('No modules installed yet', 'A module is a folder in <code>modules/</code> that adds a page and an API to the app. The <b>hello</b> example normally ships with the app: if it is missing, update your copy. Add your own with the panels below.'));
        return;
      }
      listBox.replaceChildren(...mods.map((m) => moduleCard(m, allOff)));
    }
    load();

    /* ----- add one with an AI helper ----- */
    const what = h('input', { class: 'input', id: 'mod-what', type: 'text', placeholder: 'e.g. show the motor temperatures on a chart', autocomplete: 'off', maxlength: '300' });
    const promptSlot = h('div');
    const drawPrompt = () => {
      const text = what.value.trim().replace(/[.\s]+$/, '');
      promptSlot.replaceChildren(copyBox(`${PROMPT_HEAD} ${text || PLACEHOLDER}.`, { label: 'Copy prompt' }));
    };
    what.addEventListener('input', drawPrompt);
    drawPrompt();

    const manual = [
      ['Make a folder', rich('Inside the project’s <code>modules</code> folder, make a new folder named like your module, for example <code>modules/my_module/</code>. Use lowercase letters, digits and underscores, starting with a letter.')],
      ['Add module.json', rich('In that folder, make a file called <code>module.json</code> that describes the module. Copy the small example below and change the words.')],
      ['Add a backend (optional)', rich('For code that runs on your computer, add <code>backend.py</code> with a function <code>handle(method, path, body, ctx)</code> that returns <code>(status, payload)</code>. It answers requests to <code>/api/m/my_module/…</code>.')],
      ['Add a page (optional), then restart', rich('For a page in this app, add <code>ui.js</code> that exports <code>{ render(root, ctx) }</code>. Then restart the app (Settings, Advanced, <b>Restart the app</b>). Your module shows up above.')],
    ];

    root.append(h('div', { class: 'stack-lg' },
      pageHead('Use', 'Modules', 'Modules add pages and features to the app. Each one is a folder in <code>modules/</code>; the app finds it when it starts.'),
      api.demo ? callout('tip', 'This is the demo, so the modules below are examples. To add your own you need the real app on your computer: the steps are the same.', 'Demo mode') : null,
      listBox,
      h('section', { class: 'stack' },
        h('h2', {}, 'Add a module'),
        h('div', { class: 'grid grid-2 mod-add' },
          h('div', { class: 'card stack' },
            h('div', { class: 'row' }, icon('sparkles'), h('h3', {}, 'Add one with AI')),
            h('p', { class: 'muted' }, 'Say what you want, copy the prompt, and paste it into Claude Code, Codex, Cursor or another coding assistant opened in this project’s folder.'),
            h('div', { class: 'field' }, h('label', { for: 'mod-what' }, 'What should the module do?'), what),
            promptSlot,
            h('p', { class: 'muted mod-small beginner-only' }, 'The assistant reads the project’s rules and the add-module skill, builds the folder for you, and tells you to restart the app. Read what it made before you restart.')),
          h('div', { class: 'card stack' },
            h('div', { class: 'row' }, icon('terminal'), h('h3', {}, 'Or add one by hand')),
            h('ol', { class: 'mod-steps' }, manual.map(([t, d]) => h('li', {}, h('b', {}, t), h('div', { class: 'muted' }, d)))),
            h('div', { class: 'stack-sm' }, h('div', { class: 'mod-code-label' }, h('code', {}, 'modules/my_module/module.json')), h('pre', { class: 'mod-code' }, h('code', {}, EXAMPLE))),
            h('p', { class: 'muted mod-small' }, rich('The smallest working example is the <code>hello</code> module: copy its folder and change it.')))))));

    return () => { dead = true; };
  },
};

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
