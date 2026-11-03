// Components for physical instructions (the owner's standard, see docs/design/physical-instructions.md):
// one action per step, say what it looks like and where it is, a visible "you'll know it worked", an "if not",
// safety before the action, and a picture for anything spatial.
import { h, rich, icon, badge, callout, append } from './ui.js';

/**
 * stepCard({n, total, title, where, do:[...], how, know, ifNot, then, safety, diagram, caption, footer})
 *  - do: array of single actions (strings with limited HTML, or nodes), rendered as a numbered list
 *  - know: what the person will see/hear/feel when it worked   - ifNot: ONE concrete fallback
 *  - safety: what can move/pinch/fall and where hands must not be (rendered first, red)
 *  - diagram: an SVG/canvas node; caption states the viewpoint ("Top view, you sit at the bottom")
 */
export function stepCard(s) {
  const rows = [];
  const row = (label, content, cls = '') => content && rows.push(h('div', { class: 'srow ' + cls }, h('dt', {}, label), h('dd', {}, content)));
  const text = (v) => (typeof v === 'string' ? rich(v) : v);
  row('Where', text(s.where));
  if (s.do?.length) row('Do', h('ol', { class: 'sdo' }, s.do.map((d) => h('li', {}, text(d)))));
  row('How', text(s.how));
  row('You’ll know it worked when', s.know && h('span', {}, icon('check'), h('span', {}, text(s.know))), 'know');
  row('If not', s.ifNot && h('span', {}, icon('alert'), h('span', {}, text(s.ifNot))), 'ifnot');
  row('Then', text(s.then));
  return h('article', { class: 'card stepcard', id: s.id ? 'step-' + s.id : null },
    h('header', { class: 'stepcard__head' }, s.total ? badge(`Step ${s.n} of ${s.total}`, 'accent') : null, h('h3', {}, s.title), s.minutes ? h('span', { class: 'muted' }, `about ${s.minutes} min`) : null),
    s.safety ? callout('safety', s.safety, 'Before you do this') : null,
    h('div', { class: 'stepcard__body' },
      h('dl', { class: 'stepcard__text' }, rows),
      s.diagram ? h('figure', { class: 'stepcard__fig' }, s.diagram, s.caption ? h('figcaption', {}, rich(s.caption)) : null) : null),
    s.footer ? h('footer', { class: 'stepcard__foot' }, s.footer) : null);
}

/** preflight({title, minutes, needs:[..], hands, moves, clear, stop}) -> the "before we start" card. */
export function preflight(p) {
  const rows = [];
  const row = (label, v) => v && rows.push(h('div', { class: 'srow' }, h('dt', {}, label), h('dd', {}, typeof v === 'string' ? rich(v) : v)));
  row('You need', p.needs?.length ? h('ul', {}, p.needs.map((n) => h('li', {}, typeof n === 'string' ? rich(n) : n))) : null);
  row('Hands', p.hands);
  row('What moves', p.moves || 'Nothing moves on its own.');
  row('Clear', p.clear);
  row('Stop at any time', p.stop || 'Press the red STOP button at the top of the screen.');
  return h('section', { class: 'card preflight' },
    h('header', { class: 'stepcard__head' }, h('h3', {}, p.title || 'Before we start'), p.minutes ? h('span', { class: 'muted' }, `takes about ${p.minutes} min`) : null),
    h('dl', { class: 'stepcard__text' }, rows));
}

/** progressCue('spot', 2, 3) -> "spot 2 of 3" (always show where the person is in a loop). */
export const progressCue = (what, n, total) => h('span', { class: 'badge accent' }, `${what} ${n} of ${total}`);

/** A small "wrong vs right" pair, for the common mistake next to the right way. */
export function rightWrong(right, wrong) {
  return h('div', { class: 'rightwrong' },
    h('figure', { class: 'rw good' }, right.node, h('figcaption', {}, icon('check'), h('span', {}, rich(right.caption)))),
    h('figure', { class: 'rw bad' }, wrong.node, h('figcaption', {}, icon('x'), h('span', {}, rich(wrong.caption)))));
}
export { append };
