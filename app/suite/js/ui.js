// Small UI toolkit shared by every page. No framework: plain DOM helpers with a consistent look (see css/suite.css).
import { api } from './api.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('div', {class:'card', onclick}, child, 'text', [more]) -> HTMLElement. `html:` sets trusted innerHTML. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs.nodeType || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (['value', 'checked', 'disabled', 'hidden', 'selected'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const sig = (x) => JSON.stringify(x);
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/* ---------- icons (24px, stroke) ---------- */
export const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  checks: '<path d="M4 6l2 2 3-3"/><path d="M4 13l2 2 3-3"/><path d="M12 7h8M12 14h8M4 20h.01M12 20h8"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  gamepad: '<rect x="3" y="8" width="18" height="10" rx="5"/><path d="M8 11v4M6 13h4"/><circle cx="15.5" cy="12" r=".8"/><circle cx="17.5" cy="14" r=".8"/>',
  modules: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 13v7M13 16.5h7"/>',
  book: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h10"/>',
  quote: '<path d="M6 17c0-4 1-7 4-9M14 17c0-4 1-7 4-9"/><circle cx="6" cy="17" r="1.2"/><circle cx="14" cy="17" r="1.2"/>',
  life: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  arm: '<path d="M5 20l6-8 7 3"/><circle cx="5" cy="20" r="2"/><circle cx="11" cy="12" r="2"/><circle cx="18" cy="15" r="2"/>',
  usb: '<circle cx="12" cy="19" r="2"/><path d="M12 17V4M9 7l3-3 3 3"/><path d="M12 12l5-3v-1M12 14l-5-3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  rocket: '<path d="M5 19c0-4 2-7 5-9l4-4c3-1 5-1 6-1 0 1 0 3-1 6l-4 4c-2 3-5 5-9 5z"/><circle cx="15" cy="9" r="1.5"/>',
};
export function icon(name, { cls = '' } = {}) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', ('ico ' + cls).trim());
  s.innerHTML = ICONS[name] || ICONS.modules;   // unknown icon names (from a module manifest) fall back to a neutral one
  return s;
}

/* ---------- limited rich text: <b> <i> <em> <strong> <code> <kbd> <br> <a href> only ---------- */
const OK_TAGS = new Set(['B', 'I', 'EM', 'STRONG', 'CODE', 'KBD', 'BR', 'A', 'SPAN']);
export function rich(str) {
  const frag = document.createDocumentFragment();
  const doc = new DOMParser().parseFromString(`<body>${String(str ?? '')}</body>`, 'text/html');
  const walk = (from, to) => {
    for (const n of from.childNodes) {
      if (n.nodeType === 3) to.append(document.createTextNode(n.textContent));
      else if (n.nodeType === 1 && OK_TAGS.has(n.tagName)) {
        const el = document.createElement(n.tagName.toLowerCase());
        if (n.tagName === 'A') {
          const href = n.getAttribute('href') || '';
          if (/^(https?:|#|\/)/.test(href)) { el.setAttribute('href', href); if (/^https?:/.test(href)) { el.target = '_blank'; el.rel = 'noopener'; } }
        }
        walk(n, el);
        to.append(el);
      } else if (n.nodeType === 1) walk(n, to);
    }
  };
  walk(doc.body, frag);
  return frag;
}

/* ---------- feedback: toast, inline confirm bar (never a browser pop-up) ---------- */
export function toast(msg, level = '', ms) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = h('div', { class: 'toast ' + level, role: level === 'err' ? 'alert' : 'status' }, h('div', { class: 'toast-msg' }, typeof msg === 'string' ? rich(msg) : msg));
  box.append(t);
  setTimeout(() => t.remove(), ms || (level === 'err' ? 9000 : 4500));
  while (box.children.length > 4) box.firstChild.remove();
}

export function askYes(msg, yesLabel, fn, { danger = false, cancelLabel = 'Cancel' } = {}) {
  const bar = document.getElementById('askbar');
  if (!bar) return fn();
  const close = () => clear(bar);
  const yes = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { close(); fn(); } }, yesLabel || 'Yes');
  const no = h('button', { class: 'btn ghost', onclick: close }, cancelLabel);
  clear(bar).append(h('div', { class: 'askbar', role: 'alertdialog', 'aria-label': 'Please confirm' },
    h('div', { class: 'askbox' + (danger ? ' danger' : '') }, h('div', {}, typeof msg === 'string' ? rich(msg) : msg), h('div', { class: 'btns' }, yes, no))));
  yes.focus();
}

/* ---------- small components ---------- */
export const badge = (text, kind = '') => h('span', { class: 'badge ' + kind }, text);
export const dot = (kind = '') => h('span', { class: 'dot ' + kind, 'aria-hidden': 'true' });
export const chip = (label, kind, { href, title } = {}) =>
  h(href ? 'a' : 'span', { class: 'chip' + (href ? ' link' : ''), href, title }, dot(kind), label);

/** button('Calibrate', {onClick, kind:'primary'|'secondary'|'ghost'|'danger'|'ok', size:'sm'|'lg', icon:'arrow', why:'reason it is disabled', href}) */
export function button(label, { onClick, kind = 'secondary', size = '', icon: ic, disabled, why, href, title, block, cls = '' } = {}) {
  const off = !!(disabled || why);
  const el = h(href && !off ? 'a' : 'button', {
    class: ['btn', kind === 'secondary' ? '' : kind, size, block ? 'block' : '', cls],
    href: href && !off ? href : null,
    type: href ? null : 'button',
    disabled: !href && off,
    'aria-disabled': off ? 'true' : null,
    title: why || title || null,
    'data-why': why || null,
    onclick: off ? (e) => e.preventDefault() : onClick,
  });
  if (ic) el.append(icon(ic));
  el.append(label);
  return el;
}
/** A row of buttons plus ONE line saying why any are greyed out ("Hover test, Loop greyed out: a job is running"). */
export function actions(buttons, note) {
  const groups = new Map();
  for (const b of buttons) if (b.dataset?.why) groups.set(b.dataset.why, [...(groups.get(b.dataset.why) || []), b.textContent]);
  const why = [...groups].map(([r, names]) => h('div', {}, h('b', {}, names.join(', ')), ` greyed out: ${r}`));
  return h('div', { class: 'actions' }, h('div', { class: 'btns' }, buttons), why.length ? h('p', { class: 'why' }, why) : null, note ? h('p', { class: 'why' }, note) : null);
}

export function ring(done, total, { size = 96, label = 'checks' } = {}) {
  const C = 2 * Math.PI * 42, frac = total ? clamp(done / total, 0, 1) : 0;
  const el = h('div', { class: 'ring', style: { '--size': size + 'px' }, role: 'img', 'aria-label': `${done} of ${total} ${label}` });
  el.innerHTML = `<svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="42" stroke-width="9"/><circle class="fg" cx="50" cy="50" r="42" stroke-width="9" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - frac)).toFixed(1)}"/></svg><div class="num"><div>${done}/${total}<small>${label}</small></div></div>`;
  return el;
}

export function callout(kind, content, title) {
  const ic = { tip: 'info', why: 'info', warn: 'alert', safety: 'shield', ok: 'check' }[kind] || 'info';
  return h('div', { class: 'callout ' + kind, role: kind === 'safety' ? 'note' : null },
    icon(ic), h('div', {}, title ? h('b', { class: 't' }, title) : null, typeof content === 'string' ? h('p', {}, rich(content)) : content));
}

export function copyBox(text, { label = 'Copy' } = {}) {
  const btn = h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Copy to clipboard' }, icon('copy'), label);
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied.', 'ok', 1800); }
    catch { toast('Could not copy automatically. Select the text and copy it.', 'warn'); }
  };
  return h('div', { class: 'copybox' }, h('code', {}, text), btn);
}

export function empty(title, text, action) {
  return h('div', { class: 'empty' }, icon('info'), h('h3', {}, title), text ? h('p', {}, rich(text)) : null, action || null);
}
export const skeleton = (w = '100%', hgt = 16) => h('div', { class: 'skeleton', style: { width: w, height: hgt + 'px' } });

/* ---------- "what's this?" terms (glossary popovers) ---------- */
let pop = null;
export function closePop() { pop?.remove(); pop = null; }
export function term(id, label) {
  const b = h('button', { class: 'term', type: 'button', 'aria-haspopup': 'dialog' }, label ?? id);
  b.onclick = async (e) => {
    e.stopPropagation();
    closePop();
    let g;
    try { g = (await import('./content/glossary.js')).default.find((x) => x.id === id || x.term?.toLowerCase() === String(id).toLowerCase()); } catch { g = null; }
    if (!g) return;
    const r = b.getBoundingClientRect();
    pop = h('div', { class: 'pop', role: 'dialog', 'aria-label': g.term, style: { left: clamp(r.left, 8, innerWidth - 380) + 'px', top: Math.min(r.bottom + 8, innerHeight - 180) + 'px' } },
      h('h4', {}, g.term), h('p', {}, rich(g.long || g.short)),
      h('a', { href: '#/glossary' }, 'Open the glossary'));
    document.body.append(pop);
  };
  return b;
}
document.addEventListener('click', (e) => { if (pop && !pop.contains(e.target)) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });

/* ---------- camera picture: live stream, or a canvas in demo mode. Never a silent black box. ---------- */
export function cameraView(index = 0, { onClick, label } = {}) {
  const wrap = h('div', { class: 'camview' + (onClick ? ' click' : '') });
  const msg = h('small', { class: 'muted' });
  wrap.append(h('div', { class: 'overlay' }, h('div', { class: 'spin' }), h('b', {}, 'No picture'), msg));
  let raf = 0, media;
  if (api.demo) {
    media = h('canvas', { width: 640, height: 480, role: 'img', 'aria-label': `Camera ${index + 1} (simulated)` });
    const c = media.getContext('2d'), t0 = performance.now();
    let last = 0;
    const draw = (now) => { raf = requestAnimationFrame(draw); if (now - last < 66) return; last = now; try { api.mock.cameraFrame(index, c, (now - t0) / 1000, { w: 640, h: 480 }); } catch { /* keep going */ } };
    raf = requestAnimationFrame(draw);
  } else {
    media = h('img', { alt: `Camera ${index + 1} live picture`, src: `/stream/${index}.mjpg?t=${Date.now()}` });
    media.onerror = () => setTimeout(() => { if (media.isConnected) media.src = `/stream/${index}.mjpg?t=${Date.now()}`; }, 1500);
  }
  wrap.prepend(media);
  if (label) wrap.append(h('span', { class: 'label' }, label));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'marks'); svg.setAttribute('viewBox', '0 0 640 480'); svg.setAttribute('aria-hidden', 'true');
  wrap.append(svg);
  if (onClick) wrap.addEventListener('click', (e) => { const r = wrap.getBoundingClientRect(); onClick((e.clientX - r.left) / r.width * 640, (e.clientY - r.top) / r.height * 480, e); });
  wrap.setStatus = (ok, why = '') => { wrap.classList.toggle('bad', !ok); msg.textContent = why; };
  /** marks: [{u, v, label, kind:'ok'|'warn'}] in 640x480 picture coordinates */
  wrap.setMarks = (marks = []) => {
    svg.innerHTML = marks.map((m, i) => `<g><circle cx="${m.u}" cy="${m.v}" r="11" fill="none" stroke="${m.kind === 'warn' ? '#f5a524' : '#2fbf71'}" stroke-width="3"/><circle cx="${m.u}" cy="${m.v}" r="3" fill="#fff"/><text x="${m.u + 15}" y="${m.v - 11}" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke" font-size="16" font-weight="700">${m.label ?? i + 1}</text></g>`).join('');
  };
  wrap.destroy = () => { cancelAnimationFrame(raf); if (media.tagName === 'IMG') media.src = ''; };
  return wrap;
}

/* ---------- diagrams and per-page CSS ---------- */
/** svg(innerMarkup, {viewBox, label}) -> <svg role="img" aria-label>. Draw with CSS variables so it reads in light and dark;
 *  helper classes (components.css): .dg-do (green), .dg-avoid (red), .dg-part, .dg-label, .dg-dim. */
export function svg(inner, { viewBox = '0 0 400 260', label = '' } = {}) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox); s.setAttribute('class', 'dg');
  if (label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', label); } else s.setAttribute('aria-hidden', 'true');
  s.innerHTML = inner;
  return s;
}
const cssLoaded = new Set();
/** loadCss(new URL('../../css/pages/calibrate.css', import.meta.url).href): add a page stylesheet once. */
export function loadCss(url) { if (cssLoaded.has(url)) return; cssLoaded.add(url); document.head.append(h('link', { rel: 'stylesheet', href: url })); }

/* ---------- misc ---------- */
export function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function pageHead(eyebrow, title, lead) {
  return h('header', { class: 'page-head' }, eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null, h('h1', {}, title), lead ? h('p', { class: 'lead' }, rich(lead)) : null);
}
/** Wrap a click handler so a failing API call shows a friendly toast instead of nothing. */
export function safe(fn) {
  return async (...a) => { try { return await fn(...a); } catch (e) { toast(`<b>That did not work.</b> ${String(e.message || e)}`, 'err'); } };
}
