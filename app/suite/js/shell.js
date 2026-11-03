// App frame: left nav (bottom bar on phones), top bar with live status chips, Next-step pill, STOP, banners,
// and the one-time "please calibrate" sheet. Pages render into shell.outlet.
import { api } from './api.js';
import { h, icon, chip, button, toast, safe, rich, clear, append } from './ui.js';
import { mountPalette, shortcutLabel } from './palette.js';

export const NAV = [
  { id: '', label: 'Home', icon: 'home', mobile: true },
  { group: 'Get started' },
  { id: 'setup', label: 'Setup check', icon: 'checks', step: 1, mobile: true },
  { id: 'motors', label: 'Motor IDs', icon: 'plug', step: 2 },
  { id: 'assemble', label: 'Assemble', icon: 'cube', step: 3 },
  { id: 'calibrate', label: 'Calibrate', icon: 'sliders', step: 4, mobile: true },
  { id: 'cameras', label: 'Cameras', icon: 'camera', step: 5 },
  { group: 'Use' },
  { id: 'control', label: 'Control', icon: 'gamepad', mobile: true },
  { id: 'modules', label: 'Modules', icon: 'modules' },
  { group: 'Learn' },
  { id: 'learn', label: 'Learn', icon: 'book', mobile: true },
  { id: 'glossary', label: 'Glossary', icon: 'quote' },
  { group: 'Help' },
  { id: 'help', label: 'Help', icon: 'life' },
  { group: 'Debug' },
  { id: 'test', label: 'Test motors', icon: 'pulse' },
  { id: 'inspector', label: 'Inspector', icon: 'terminal' },
  { id: 'settings', label: 'Settings', icon: 'gear', mobile: true },
];
const ITEMS = NAV.filter((n) => n.id !== undefined && !n.group);
const groupOf = (id) => { let g = ''; for (const n of NAV) { if (n.group) g = n.group; else if (n.id === id) return g; } return ''; };

/** done | todo | null (null = unknown yet). Driven by the live checklist. */
export function stepStatus(ctx, id) {
  const items = ctx.checklist?.items;
  if (!items) return null;
  const ok = (k) => { const s = items.find((i) => i.id === k)?.status; return s === 'ok' || s === 'skip'; };
  switch (id) {
    case 'setup': return items.every((i) => i.status === 'ok' || i.status === 'skip') ? 'done' : 'todo';
    case 'assemble': return ok('assembly_done') ? 'done' : 'todo';
    case 'motors': return ok('follower_motors') && ok('leader_motors') ? 'done' : 'todo';
    case 'calibrate': return ok('follower_calibrated') && ok('leader_calibrated') ? 'done' : 'todo';
    case 'cameras': return ok('camera_working') && ok('camera_mapped') ? 'done' : 'todo';
    default: return null;
  }
}

const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--accent)"/><path d="M9 23l7-9 7 3" stroke="#1b0e00" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="23" r="2.6" fill="#1b0e00"/><circle cx="16" cy="14" r="2.6" fill="#1b0e00"/><circle cx="23" cy="17" r="2.2" fill="#1b0e00"/></svg>';

export function mountShell(root, ctx) {
  const links = new Map(), steps = new Map();
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, h('a', { class: 'brand', href: '#/', html: LOGO + '<span><b>SO-101 Suite</b><small>set up · calibrate · learn</small></span>' }));
  for (const n of NAV) {
    if (n.group) { nav.append(h('div', { class: 'nav-group' }, n.group)); continue; }
    const a = h('a', { class: 'item', href: '#/' + n.id, 'data-mobile': n.mobile ? '1' : null }, icon(n.icon), h('span', {}, n.label));
    if (n.step) { const s = h('span', { class: 'step', 'aria-hidden': 'true' }, String(n.step)); steps.set(n.id, s); a.append(s); }
    links.set(n.id, a); nav.append(a);
  }
  nav.append(h('div', { class: 'nav-foot' }, api.demo ? 'Demo mode · simulated' : 'Running on your computer', h('br'), 'AGPL-3.0 · open source'));

  const where = h('div', { class: 'where' });
  const chips = h('div', { class: 'chips', 'aria-label': 'Connection status' });
  const nextSlot = h('div'), stopSlot = h('div');
  const pal = mountPalette(ctx, NAV);
  const searchBtn = h('button', { class: 'chip link', type: 'button', 'aria-label': 'Search and jump to anything', onclick: () => pal.open() }, icon('search'), h('span', { class: 'kbd-hint' }, 'Search ', h('kbd', {}, shortcutLabel)));
  const topbar = h('header', { class: 'topbar' }, where, searchBtn, chips, nextSlot, stopSlot);
  const stopAll = safe(async () => { await api.post('/api/pp/stop'); await api.post('/api/teleop/stop'); toast('<b>Stopped.</b> The arm holds where it is. Use <b>Release arm</b> in Control if you need it limp.', 'ok'); });
  document.addEventListener('keydown', (e) => {   // Space = STOP while an arm may be moving (unless you are typing or on a button/link)
    if (e.code !== 'Space' || !ctx.moving || ctx.settings?.safety?.stop_shortcut === false) return;
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(document.activeElement?.tagName || '')) return;
    e.preventDefault(); stopAll();
  });
  const banners = h('div');
  const main = h('main', { id: 'main', tabindex: '-1' });
  root.replaceChildren(h('div', { class: 'shell' }, nav, h('div', { class: 'main-col' }, banners, topbar, main)));

  /* live pieces: each redraws only when what it shows changed */
  ctx.onChange((c) => [c.offline, c.offlineReason, api.demo], ([off, why, demo]) => {
    clear(banners);
    append(banners, [
      demo ? h('div', { class: 'banner demo' }, 'Demo: simulated hardware. Nothing here is real. ', h('a', { href: 'https://github.com/Wendor-ai/so101-suite#quickstart', target: '_blank', rel: 'noopener' }, 'Install it for real')) : null,
      off ? h('div', { class: 'banner bad', role: 'alert' }, `Lost connection to the app: ${why || 'retrying'}…`) : null]);
  });
  ctx.onChange((c) => {
    const f = c.arm('follower'), l = c.arm('leader'), cams = c.state?.cameras || [];
    return [f && [f.online, f.joints?.length, f.calibrated], l && [l.online, l.joints?.length, l.calibrated], cams.map((x) => x.ok)];
  }, () => {
    const f = ctx.arm('follower'), l = ctx.arm('leader'), cams = ctx.state?.cameras || [];
    const armChip = (name, a, page) => chip(!a ? `${name}: not found` : !a.online ? `${name}: offline` : `${name}${a.calibrated ? '' : ': not calibrated'}`, !a ? '' : !a.online ? 'bad' : a.calibrated ? 'ok live' : 'warn', { href: '#/' + page, title: !a ? 'No arm with this role is connected yet' : `${a.joints?.length || 0} motors answering` });
    chips.replaceChildren(armChip('Follower', f, f?.calibrated ? 'control' : 'setup'), armChip('Leader', l, 'setup'),
      chip(cams.length ? `${cams.filter((c) => c.ok).length}/${cams.length} camera${cams.length > 1 ? 's' : ''}` : 'No camera', cams.length ? (cams.every((c) => c.ok) ? 'ok' : 'warn') : '', { href: '#/cameras' }));
  });
  ctx.onChange((c) => [c.checklist?.summary?.next, c.checklist?.summary?.ok, c.checklist?.summary?.total], () => {
    const sm = ctx.checklist?.summary, it = ctx.checklist?.items?.find((i) => i.id === sm?.next);
    nextSlot.replaceChildren(!sm ? '' : it ? h('a', { class: 'chip link', href: '#/' + (it.fix?.page || 'setup'), title: it.detail }, icon('arrow', { cls: '' }), `Next: ${it.action || it.title}`) : chip('All set', 'ok', { href: '#/control' }));
  });
  ctx.onChange((c) => c.moving, (moving) => {
    stopSlot.replaceChildren(moving ? h('button', { class: 'stop', type: 'button', 'aria-label': 'Stop all arm motion (Space)', title: 'Stop (Space)', onclick: stopAll }, icon('stop'), 'STOP') : '');
  });
  ctx.onChange((c) => ITEMS.filter((n) => n.step).map((n) => stepStatus(c, n.id)), () => {
    for (const [id, el] of steps) {
      const st = stepStatus(ctx, id), n = ITEMS.find((x) => x.id === id).step;
      el.className = 'step' + (st === 'done' ? ' done' : st === 'todo' ? ' todo' : '');
      el.replaceChildren(st === 'done' ? icon('check') : String(n));
    }
  });
  let asked = false;
  ctx.subscribe(maybeAskCalibration);

  /* the one-time sheet asking for the first calibration (never twice, never on top of the Calibrate or Welcome pages) */
  function maybeAskCalibration(c) {
    if (asked || !c.info?.first_calibration_needed) return;
    if (/^#\/welcome/.test(location.hash)) return;
    asked = true;
    c.setSetting('ui.calibrationPrompted', true).catch(() => {});
    if (/^#\/calibrate/.test(location.hash)) return;
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); main.focus(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === 'Tab') { const f = [...back.querySelectorAll('a,button')]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); } };
    const go = button('Calibrate now', { kind: 'primary', size: 'lg', icon: 'arrow', onClick: () => { close(); ctx.go('calibrate?first=1'); } });
    const later = button('Not now', { kind: 'ghost', onClick: close });
    const back = h('div', { class: 'dlg-back', onclick: (e) => { if (e.target === back) close(); } },
      h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-t' },
        h('div', { class: 'eyebrow' }, 'First time here'),
        h('h2', { id: 'dlg-t' }, 'Let’s calibrate your arm'),
        h('p', { class: 'muted' }, 'Before an arm can move safely it has to learn its own range. It takes about 2 minutes, and you only do it once.'),
        h('ul', {}, h('li', {}, rich('The app lowers the arm onto the table, then it goes <b>limp</b> (soft). Keep your hands clear until the page says it is limp.')), h('li', {}, 'You move each joint by hand, slowly, from one end to the other.'), h('li', {}, rich('After this, every joint reads <b>0 at the middle of its range</b>.'))),
        h('div', { class: 'btns' }, go, later),
        h('a', { href: '#/learn/why-calibrate', onclick: close }, 'What is calibration?')));
    document.body.append(back); document.addEventListener('keydown', onKey); go.focus();
  }

  return {
    outlet: main,
    setActive(id) { const on = id === 'm' ? 'modules' : id; for (const [k, a] of links) { if (k === on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); } },
    setWhere(id, title) { const g = groupOf(id); where.replaceChildren(g ? `${g} · ` : '', h('b', {}, title || '')); },
    focusMain() { main.focus({ preventScroll: true }); scrollTo({ top: 0 }); },
  };
}
