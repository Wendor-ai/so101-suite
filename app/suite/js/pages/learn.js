// Learn: the hub (#/learn), articles (#/learn/<id>) and the showpiece "Meet your arm" with the real 3D arm.
import { h, icon, button, badge, callout, rich, empty, loadCss, term, svg } from '../ui.js';
import { mountTwin } from '../twin.js';
import { JOINT_LABEL } from '../state.js';

loadCss(new URL('../../css/pages/learn.css', import.meta.url).href);

const LEVELS = {
  start: { label: 'Start here', blurb: 'Short reads that explain what you have and how to get it moving.' },
  next: { label: 'Next up', blurb: 'Once the arm moves: cameras, the table and pick and place.' },
  deep: { label: 'Go deeper', blurb: 'The maths and the bigger picture, in plain words.' },
};
const CALLOUT_TITLE = { tip: 'Tip', why: 'Why it matters', warn: 'Watch out', safety: 'Safety', ok: 'Good to know' };
// glossary words that are also everyday words: never auto-link these inside articles
const NO_AUTO = new Set(['act', 'port', 'module', 'policy', 'episode', 'load', 'temperature', 'voltage', 'camera', 'uv', 'demo-mode', 'degree-of-freedom', 'normalized', 'range-of-motion', 'middle-of-range', 'dataset', 'lerobot', 'mjpeg', 'v4l2', 'dialout', 'leave-one-out', 'bus', 'digital-twin', 'degree']);

/* ---- tiny "read" memory (a nicety: falls back to nothing when storage is blocked) ---- */
const READ_KEY = 'so101.learn.read';
const readSet = () => { try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]')); } catch { return new Set(); } };
const markRead = (id) => { try { const s = readSet(); s.add(id); localStorage.setItem(READ_KEY, JSON.stringify([...s])); } catch { /* storage blocked: fine */ } };

const load = async (name) => { try { return (await import(`../content/${name}.js`)).default; } catch (e) { console.warn(`content/${name}.js missing`, e); return null; } };
const isExternal = (href) => /^https?:/.test(href || '');
const linkEl = (l, cls = '') => h('a', { class: ['lrn-link', cls], href: l.href, target: isExternal(l.href) ? '_blank' : null, rel: isExternal(l.href) ? 'noopener' : null }, l.label, isExternal(l.href) ? icon('external') : icon('arrow'));
const reduced = () => document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---- glossary words inside paragraphs become term() buttons (first mention only) ---- */
function termLinker(glossary) {
  const list = (glossary || []).filter((g) => g.term && !NO_AUTO.has(g.id) && g.term.length >= 3);
  if (!list.length) return (frag) => frag;
  const byName = new Map(list.map((g) => [g.term.toLowerCase(), g]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let re; try { re = new RegExp(`(?<![\\w-])(${names.join('|')})(s)?(?![\\w-])`, 'gi'); } catch { return (frag) => frag; } // old browsers without look-behind: no auto links, text still reads fine
  const seen = new Set();
  return (frag) => {
    const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && n.parentElement.closest?.('a,code,kbd,button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const text = n.textContent; let last = 0, out = null; re.lastIndex = 0;
      for (let m; (m = re.exec(text));) {
        const g = byName.get(m[1].toLowerCase());
        if (!g || seen.has(g.id) || seen.size >= 14) continue;
        seen.add(g.id); out ||= document.createDocumentFragment();
        out.append(text.slice(last, m.index), term(g.id, m[0])); last = m.index + m[0].length;
      }
      if (out) { out.append(text.slice(last)); n.replaceWith(out); }
    }
    return frag;
  };
}

/* ---- body renderer: string | {list} | {callout} | {steps} ---- */
function renderBody(body, link) {
  const rt = (s) => link(rich(s));
  return (body || []).map((b) => {
    if (typeof b === 'string') return h('p', {}, rt(b));
    if (b.list) return h('ul', { class: 'lrn-ul' }, b.list.map((x) => h('li', {}, rt(x))));
    if (b.steps) return h('ol', { class: 'lrn-steps' }, b.steps.map((x) => h('li', {}, h('div', {}, rt(x)))));
    if (b.callout) return callout(b.callout.kind, h('p', {}, rt(b.callout.text)), CALLOUT_TITLE[b.callout.kind]);
    return null;
  });
}

/* ================= hub ================= */
function articleCard(a, read) {
  return h('a', { class: 'card lrn-card', href: `#/learn/${a.id}` },
    h('div', { class: 'lrn-card-top' }, badge(`${a.minutes} min`, ''), read.has(a.id) ? badge('Read', 'ok') : null),
    h('h3', {}, a.title), h('p', { class: 'muted' }, a.summary), h('span', { class: 'lrn-go' }, 'Read', icon('arrow')));
}

function jawsDiagram() {
  const MOTOR = 'fill:color-mix(in srgb,var(--text) 24%,var(--surface))';
  return svg(`
    <rect x="12" y="50" width="86" height="60" rx="7" class="dg-part" style="fill:var(--surface2)"/>
    <text x="55" y="84" text-anchor="middle" class="dg-small" style="font-size:11.5px">hand</text>
    <rect x="98" y="94" width="108" height="16" rx="4" class="dg-part" style="fill:color-mix(in srgb,var(--text) 14%,var(--surface));stroke-width:2"/>
    <line x1="106" y1="72" x2="203" y2="86" class="dg-part" style="stroke:var(--accent);stroke-width:12;stroke-linecap:round;opacity:.28;stroke-dasharray:1 0"/>
    <line x1="106" y1="72" x2="186" y2="22" class="dg-part" style="stroke:var(--accent);stroke-width:12;stroke-linecap:round"/>
    <circle cx="106" cy="72" r="12" class="dg-part" style="${MOTOR}"/><text x="106" y="76.5" text-anchor="middle" style="font-weight:800;font-size:12px">6</text>
    <path d="M176 40 C 196 52 202 66 200 76" fill="none" class="dg-do" style="stroke-width:2"/><path d="M200 78 l-3 -9 l8 3z" class="dg-do-fill" style="stroke:none"/>
    <text x="206" y="26" class="dg-small" style="font-size:11.5px;font-weight:700;fill:var(--accent-text)">moving jaw</text>
    <text x="152" y="130" text-anchor="middle" class="dg-small" style="font-size:11.5px;font-weight:700">fixed jaw</text>
    <text x="152" y="143" text-anchor="middle" class="dg-small" style="font-size:10.5px">(part of the hand)</text>
  `, { viewBox: '0 0 280 150', label: 'Side view of the gripper: a fixed jaw that is part of the hand, and a moving jaw that swings on motor 6' });
}

async function renderHub(root, ctx, articles) {
  const read = readSet();
  const meet = articles.find((a) => a.id === 'meet-your-arm');
  const twinEl = h('div', { class: 'lrn-hero-twin', 'aria-hidden': 'true' });
  const ctl = meet ? mountTwin(twinEl, { view: 'hero', interactive: false, autoRotate: true, pose: { shoulder_pan: 10, shoulder_lift: 6, elbow_flex: 8, wrist_flex: 10, gripper: 40 } }) : null;
  root.append(h('div', { class: 'stack-lg lrn-hub' },
    h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Learn'), h('h1', {}, 'Understand your arm'), h('p', { class: 'lead' }, 'Short reads in plain words. Start with the tour, then pick what you need. Every unfamiliar word opens a small explanation.')),
    meet ? h('a', { class: 'card hero lrn-meet', href: '#/learn/meet-your-arm' },
      h('div', { class: 'lrn-meet-text' }, h('div', { class: 'eyebrow' }, '3D tour · ' + meet.minutes + ' min'), h('h2', {}, 'Meet your arm'), h('p', { class: 'lead' }, meet.summary),
        h('span', { class: 'btn primary lg' }, icon('arm'), 'Open the 3D tour')), twinEl) : null,
    ['start', 'next', 'deep'].map((lv) => {
      const list = articles.filter((a) => (a.level || 'start') === lv && a.id !== 'meet-your-arm');
      if (!list.length) return null;
      return h('section', { class: 'stack', 'aria-labelledby': 'lv-' + lv }, h('div', {}, h('h2', { id: 'lv-' + lv }, LEVELS[lv]?.label || lv), h('p', { class: 'muted', style: { margin: 0 } }, LEVELS[lv]?.blurb || '')),
        h('div', { class: 'grid grid-3 lrn-grid' }, list.map((a) => articleCard(a, read))));
    }),
    h('div', { class: 'card flat lrn-foot' }, h('div', {}, h('h3', {}, 'Looking for one word?'), h('p', { class: 'muted' }, 'The glossary explains every term the app uses, A to Z.')), button('Open the glossary', { href: '#/glossary', icon: 'quote' }))));
  return () => ctl?.destroy?.();
}

/* ================= article ================= */
function nav(articles, a) {
  const i = articles.findIndex((x) => x.id === a.id);
  const prev = articles[i - 1] || null, next = articles[i + 1] || null;
  const linked = (a.links || []).map((l) => /^#\/learn\/([^/?]+)/.exec(l.href || '')?.[1]).filter(Boolean).map((id) => articles.find((x) => x.id === id)).filter(Boolean);
  const more = [...new Set([...linked, ...articles.filter((x) => x.level === a.level && x.id !== a.id), next].filter((x) => x && x.id !== a.id))].slice(0, 3);
  return { prev, next, more };
}
function pager(prev, next) {
  const cell = (a, dir) => (a ? h('a', { class: 'card flat lrn-pn ' + dir, href: `#/learn/${a.id}` }, h('span', { class: 'muted' }, dir === 'prev' ? 'Previous' : 'Next'), h('b', {}, a.title)) : h('span'));
  return h('nav', { class: 'lrn-pager', 'aria-label': 'Previous and next article' }, cell(prev, 'prev'), cell(next, 'next'));
}

async function renderArticle(root, ctx, articles, a, glossary) {
  markRead(a.id);
  document.title = `${a.title} · Learn · SO-101 Suite`;
  const link = termLinker(glossary);
  const { prev, next, more } = nav(articles, a);
  const kids = [
    h('a', { class: 'lrn-back', href: '#/learn' }, icon('back'), 'All articles'),
    h('header', { class: 'page-head lrn-head' }, h('div', { class: 'eyebrow' }, `${LEVELS[a.level]?.label || 'Learn'} · ${a.minutes} min read`), h('h1', {}, a.title), a.summary ? h('p', { class: 'lead' }, rich(a.summary)) : null),
    h('article', { class: 'prose lrn-prose' }, renderBody(a.body, link)),
    a.links?.length ? h('section', { class: 'card flat lrn-links' }, h('h3', {}, 'Keep going'), h('div', { class: 'lrn-linklist' }, a.links.map((l) => linkEl(l)))) : null,
    more.length ? h('section', { class: 'stack' }, h('h2', {}, 'Read next'), h('div', { class: 'grid grid-3 lrn-grid' }, more.map((m) => articleCard(m, readSet())))) : null,
    pager(prev, next),
  ];
  root.append(h('div', { class: 'stack-lg lrn-article' }, kids));
  return () => {};
}

/* ================= Meet your arm: real 3D arm + parts list ================= */
// A pose that shows the whole arm from the default camera (all zeros stretches the forearm out of frame).
const REST = { shoulder_pan: -45, shoulder_lift: -30, elbow_flex: 30, wrist_flex: 0, wrist_roll: 0, gripper: 35 };
// "Show me" swings one joint this far (degrees) either side of REST; the gripper goes from nearly shut to wide open. Gentle, well inside the real range.
const AMP = { shoulder_pan: 40, shoulder_lift: 22, elbow_flex: 30, wrist_flex: 40, wrist_roll: 70 };
// what you pick in the 3D picture -> which part card opens first (several parts share a link; the card lists the others)
const LINK_TO_PART = { base_link: 'base', shoulder_link: 'shoulder-pan', upper_arm_link: 'shoulder-lift', lower_arm_link: 'elbow-flex', wrist_link: 'wrist-flex', gripper_link: 'gripper-body', moving_jaw_so101_v1_link: 'moving-jaw' };

async function renderMeet(root, ctx, route, articles, a, anatomy, glossary) {
  markRead(a.id);
  document.title = `${a.title} · Learn · SO-101 Suite`;
  const link = termLinker(glossary);
  const gname = (id) => glossary?.find((g) => g.id === id)?.term || id;
  const parts = anatomy || [];
  // the jaws card above already says what the "fingers" callout says, and the "open this page" tip points at this very page
  const bodyHere = (a.body || []).filter((b) => !(b && b.callout && (/two jaws, not five fingers/i.test(b.callout.text) || /Open the <b>Meet your arm<\/b> page/i.test(b.callout.text))));
  let sel = null, anim = null, raf = 0, alive = true;

  const twinEl = h('div', { class: 'lrn-twin', role: 'img', 'aria-label': 'Interactive 3D model of the SO-101 arm. The parts list next to it does the same job with the keyboard.' });
  const ctl = mountTwin(twinEl, { view: 'hero', interactive: true, pose: REST, onPick: (l) => { if (!alive) return; if (!l) return select(null); const id = LINK_TO_PART[l]; const p = parts.find((x) => x.id === id) || parts.find((x) => x.urdfLinks?.includes(l)); select(p ? p.id : null, { from3d: l }); } });
  let twinOk = true;
  ctl.ready.then(() => { twinOk = !!ctl.links; if (!alive) return; ctl.setPose?.(REST); if (!twinOk) { twinNote.hidden = false; tools.style.display = 'none'; renderDetail(); } });
  const twinNote = h('p', { class: 'lrn-note', hidden: true }, icon('info'), '3D is not available in this browser, so the list below is your tour. Nothing is lost: every part is described there.');

  /* views */
  const viewBtns = new Map();
  const setViewBtn = (v) => viewBtns.forEach((b, k) => b.setAttribute('aria-pressed', String(k === v)));
  const views = h('div', { class: 'seg lrn-views', role: 'group', 'aria-label': 'Camera angle' }, [['hero', 'Angled'], ['close', 'Close'], ['front', 'Front'], ['side', 'Side'], ['top', 'Top']].map(([v, l]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(v === 'hero'), onclick: () => { ctl.setView?.(v); setViewBtn(v); } }, l);
    viewBtns.set(v, b); return b;
  }));

  const tools = h('div', { class: 'row-between lrn-tools' }, views, h('span', { class: 'muted lrn-tip' }, 'Drag to turn it. Click a part.'));

  /* list */
  const listEl = h('ul', { class: 'lrn-parts' });
  const rowFor = new Map();
  const shortTitle = (p) => p.title.replace(/\s*\(.*\)\s*$/, '');
  const mk = (p) => {
    const b = h('button', { type: 'button', class: 'lrn-part', 'aria-pressed': 'false', 'data-part': p.id, title: p.title, onclick: () => select(sel === p.id ? null : p.id) },
      p.motorId ? h('span', { class: 'lrn-mid', 'aria-label': `Motor ${p.motorId}` }, String(p.motorId)) : h('span', { class: 'lrn-dot', 'aria-hidden': 'true' }), h('span', { class: 'lrn-part-t' }, shortTitle(p)));
    rowFor.set(p.id, b);
    return h('li', {}, b);
  };
  const joints = parts.filter((p) => p.motorId), others = parts.filter((p) => !p.motorId);
  listEl.append(h('li', { class: 'lrn-group' }, 'The six joints, bottom to top (the number is the motor ID)'), ...joints.map(mk), h('li', { class: 'lrn-group' }, 'Other parts'), ...others.map(mk));

  /* detail panel */
  const detail = h('div', { class: 'card lrn-detail', 'aria-live': 'polite' });
  const showBtnHolder = h('div');

  function stopAnim() { anim = null; cancelAnimationFrame(raf); ctl.setPose?.(REST); }
  function startAnim(p) {
    stopAnim();
    const names = p.joint ? [p.joint] : [];
    if (!names.length) return;
    const [lo, hi] = p.joint === 'gripper' ? [4, 95] : [REST[p.joint] - (AMP[p.joint] || 30), REST[p.joint] + (AMP[p.joint] || 30)];
    const t0 = performance.now(), period = reduced() ? 3200 : 2600, cycles = 4;
    anim = { id: p.id };
    if (viewBtns.get('close')?.getAttribute('aria-pressed') === 'true') { ctl.setView?.('hero'); setViewBtn('hero'); } // the whole arm stays in frame while it moves
    const tick = (now) => {
      if (!alive || !anim || anim.id !== p.id) return;
      const t = (now - t0) / period;
      if (t >= cycles) { stopAnim(); renderDetail(); return; }
      const k = reduced() ? (Math.floor(t * 2) % 2 ? 1 : 0) : 0.5 - 0.5 * Math.cos(t * 2 * Math.PI);
      ctl.setPose?.({ ...REST, [p.joint]: lo + (hi - lo) * k });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    renderDetail();
  }

  function renderDetail() {
    const p = parts.find((x) => x.id === sel);
    if (!p) {
      detail.replaceChildren(h('div', { class: 'lrn-empty' }, icon('arm'), h('h3', {}, 'Pick a part'), h('p', { class: 'muted' }, 'Click a part of the arm in the 3D picture, or choose one from the list. It lights up, and you see what it is, why it matters and how to find it on your real arm.')));
      return;
    }
    const sharing = parts.filter((x) => x.id !== p.id && x.id !== 'motor-horn' && p.id !== 'motor-horn' && x.urdfLinks?.some((l) => p.urdfLinks?.includes(l)));
    const terms = (p.terms || []).map((id) => term(id, gname(id)));
    const playing = anim?.id === p.id;
    const show = p.joint
      ? h('div', { class: 'lrn-show' }, button(playing ? 'Stop' : 'Show me', { kind: playing ? 'secondary' : 'primary', icon: playing ? 'stop' : 'play', why: twinOk ? '' : '3D view is not available in this browser.', onClick: () => (playing ? (stopAnim(), renderDetail()) : startAnim(p)) }),
        h('p', { class: 'muted' }, twinOk ? `Moves the ${JOINT_LABEL[p.joint]?.toLowerCase() || p.joint} joint in the picture only. Your real arm does not move.` : 'Show me is greyed out: the 3D picture is not available in this browser, so there is nothing to move.'))
      : null;
    detail.replaceChildren(...[
      h('div', { class: 'lrn-dh' }, h('h3', {}, p.title), h('div', { class: 'row' }, p.joint ? badge(JOINT_LABEL[p.joint] || p.joint, 'accent') : null, p.motorId ? badge(`Motor ${p.motorId}`, '') : null)),
      p.id === 'tool-point' ? h('p', { class: 'lrn-note' }, icon('info'), 'This one is invisible, so nothing lights up in the picture.') : null,
      h('p', { class: 'lrn-what' }, link(rich(p.what))),
      show,
      h('div', { class: 'lrn-sec' }, h('h4', {}, 'Why it matters'), h('p', {}, link(rich(p.why)))),
      h('div', { class: 'lrn-sec beginner-only' }, h('h4', {}, 'Try it'), h('p', {}, link(rich(p.tryIt)))),
      sharing.length ? h('div', { class: 'lrn-sec' }, h('h4', {}, 'This piece is also'), h('div', { class: 'lrn-chips' }, sharing.map((x) => h('button', { type: 'button', class: 'chip link lrn-chipbtn', onclick: () => select(x.id) }, x.title)))) : null,
      terms.length ? h('div', { class: 'lrn-sec' }, h('h4', {}, 'Words used here'), h('div', { class: 'lrn-chips' }, terms)) : null].filter(Boolean));
  }

  function select(id, opts = {}) {
    if (anim && anim.id !== id) stopAnim();
    sel = id;
    const p = parts.find((x) => x.id === id);
    ctl.setHighlight?.(p ? (p.id === 'moving-jaw' ? ['moving_jaw_so101_v1_link'] : p.urdfLinks) : []);
    for (const [k, b] of rowFor) b.setAttribute('aria-pressed', String(k === id));
    renderDetail();
    if (p && !opts.fromList) { const b = rowFor.get(id); b?.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); }
    if (p && innerWidth < 900 && !opts.noScroll) requestAnimationFrame(() => detail.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }));
  }

  /* "where are the fingers?" card: unmissable */
  const jawBtn = button('Show me the jaws', { kind: 'primary', icon: 'play', onClick: () => { select('moving-jaw'); ctl.setHighlight?.(['gripper_link', 'moving_jaw_so101_v1_link']); const p = parts.find((x) => x.id === 'moving-jaw'); if (p) startAnim(p); twinEl.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } });
  const jaws = h('section', { class: 'card hero lrn-jaws', 'aria-labelledby': 'jaws-t' },
    h('div', { class: 'lrn-jaws-fig' }, jawsDiagram()),
    h('div', { class: 'stack-sm' }, h('div', { class: 'eyebrow' }, 'The question everyone asks'), h('h2', { id: 'jaws-t' }, 'Where are the fingers?'),
      h('p', {}, rich('There are none. The SO-101 has <b>two jaws, not five fingers</b>. One jaw is part of the printed hand and never moves by itself: the <b>fixed jaw</b>. The other one swings open and shut, moved by motor 6: the <b>moving jaw</b>. Together they pinch, like a clothes peg or tongs.')),
      h('div', { class: 'row' }, jawBtn, button('Moving jaw details', { kind: 'ghost', onClick: () => select('moving-jaw') }))));

  root.append(h('div', { class: 'stack-lg lrn-meet-page' },
    h('a', { class: 'lrn-back', href: '#/learn' }, icon('back'), 'All articles'),
    h('header', { class: 'page-head lrn-head' }, h('div', { class: 'eyebrow' }, `3D tour · ${a.minutes} min`), h('h1', {}, a.title), h('p', { class: 'lead' }, rich(a.summary))),
    jaws,
    h('div', { class: 'lrn-split' },
      h('div', { class: 'lrn-left' }, twinEl, twinNote, tools),
      h('div', { class: 'lrn-right' }, h('h2', { class: 'lrn-parts-h' }, 'The parts'), listEl, detail)),
    h('article', { class: 'prose lrn-prose' }, h('h2', {}, 'The short version'), renderBody(bodyHere, link)),
    a.links?.length ? h('section', { class: 'card flat lrn-links' }, h('h3', {}, 'Keep going'), h('div', { class: 'lrn-linklist' }, a.links.map((l) => linkEl(l)))) : null,
    pager(nav(articles, a).prev, nav(articles, a).next)));

  renderDetail();
  const startPart = route?.query?.get('part');
  if (startPart && parts.some((p) => p.id === startPart)) select(startPart, { noScroll: true });
  return () => { alive = false; cancelAnimationFrame(raf); anim = null; ctl.destroy?.(); };
}

export default {
  id: 'learn', title: 'Learn',
  async render(root, ctx, route) {
    const articles = await load('learn');
    if (!articles?.length) {
      root.append(h('div', { class: 'stack-lg' }, h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Learn'), h('h1', {}, 'Understand your arm')),
        empty('The articles are not part of this build', 'The official guide covers the same ground in the meantime.', button('Open the official SO-101 guide', { href: 'https://huggingface.co/docs/lerobot/so101', kind: 'primary', icon: 'external' }))));
      return () => {};
    }
    const id = route.args[0];
    if (!id) return renderHub(root, ctx, articles);
    const a = articles.find((x) => x.id === id);
    if (!a) {
      root.append(empty('We could not find that article', 'The link may be old. Here are all the articles.', button('All articles', { href: '#/learn', kind: 'primary', icon: 'back' })));
      return () => {};
    }
    const glossary = await load('glossary');
    if (id === 'meet-your-arm') {
      const anatomy = await load('anatomy');
      if (anatomy?.length) return renderMeet(root, ctx, route, articles, a, anatomy, glossary);
      // no anatomy data: fall through to a normal article, with a visible note
      const off = await renderArticle(root, ctx, articles, a, glossary);
      root.querySelector('.lrn-article')?.prepend(callout('warn', 'The parts list for the 3D tour is missing from this build, so you get the written version.', 'No 3D tour'));
      return off;
    }
    return renderArticle(root, ctx, articles, a, glossary);
  },
};
