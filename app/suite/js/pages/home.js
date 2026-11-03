// Home: the one next step, what's connected, and the live 3D arm.
import { h, icon, button, ring, badge, skeleton, callout } from '../ui.js';
import { mountTwin } from '../twin.js';
import { poseFromArm } from '../state.js';

function nextCard(ctx) {
  const sm = ctx.checklist?.summary, items = ctx.checklist?.items;
  if (!sm || !items) return h('div', { class: 'card hero' }, h('div', { class: 'stack' }, skeleton('30%', 14), skeleton('85%', 28), skeleton('65%', 16)));
  const it = items.find((i) => i.id === sm.next);
  if (!it) {
    return h('div', { class: 'card hero next-card' },
      h('div', { class: 'row' }, ring(sm.ok, sm.total, { size: 88 }), h('div', {}, h('div', { class: 'eyebrow' }, 'All set'), h('h2', {}, 'Everything checks out.'), h('p', { class: 'detail' }, 'Your arm is ready. Open Control to move it, or look at Modules for more things to try.'))),
      h('div', { class: 'row' }, button('Open Control', { kind: 'primary', size: 'lg', icon: 'arrow', href: '#/control' }), button('Browse modules', { kind: 'ghost', href: '#/modules' })));
  }
  return h('div', { class: 'card hero next-card' },
    h('div', { class: 'row' }, ring(sm.ok, sm.total, { size: 88 }), h('div', {}, h('div', { class: 'eyebrow' }, 'Next step'), h('h2', {}, it.action || it.title), h('p', { class: 'detail' }, it.detail))),
    h('div', { class: 'row' }, button(it.fix?.label || 'Open', { kind: 'primary', size: 'lg', icon: 'arrow', href: '#/' + (it.fix?.page || 'setup') }), button('See all checks', { kind: 'ghost', href: '#/setup' })));
}

function armCard(ctx, role, optional) {
  const a = ctx.arm(role), name = role === 'follower' ? 'Follower arm' : 'Leader arm';
  const motors = a?.joints?.length || 0;
  let action;
  if (!a || !a.online) action = button(optional ? 'Set up later' : 'Find my arm', { size: 'sm', href: '#/motors', kind: optional ? 'ghost' : 'secondary' });
  else if (!a.calibrated) action = button('Calibrate', { size: 'sm', kind: 'primary', href: '#/calibrate' });
  else action = button('Open Control', { size: 'sm', href: '#/control' });
  return h('div', { class: 'card tight dev-card' },
    h('div', { class: 'name' }, icon('arm'), name, optional ? badge('optional', '') : null),
    h('div', { class: 'row' }, !a ? badge('Not found', '') : a.online ? badge('Connected', 'ok') : badge('Offline', 'bad'), a?.online ? badge(`${motors}/6 motors`, motors === 6 ? 'ok' : 'warn') : null, a?.online ? badge(a.calibrated ? 'Calibrated' : 'Not calibrated', a.calibrated ? 'ok' : 'warn') : null),
    h('p', { class: 'muted', style: { margin: 0, fontSize: '.9rem' } }, !a ? (optional ? 'The leader is what you move by hand to drive the follower. You can add it any time.' : 'Plug in the arm’s USB cable and power. We’ll find it.') : a.online ? (a.port || '') : 'Check its USB cable and power.'),
    action);
}
function camCard(ctx) {
  const cams = ctx.state?.cameras || [];
  const ok = cams.filter((c) => c.ok).length;
  return h('div', { class: 'card tight dev-card' },
    h('div', { class: 'name' }, icon('camera'), 'Cameras', badge('optional', '')),
    h('div', { class: 'row' }, cams.length ? badge(`${ok}/${cams.length} working`, ok === cams.length ? 'ok' : 'warn') : badge('None yet', '')),
    h('p', { class: 'muted', style: { margin: 0, fontSize: '.9rem' } }, cams.length ? 'Cameras let the arm see the table for pick and place.' : 'Add a USB or network camera to let the arm see the table.'),
    button(cams.length ? 'Manage cameras' : 'Add a camera', { size: 'sm', href: '#/cameras', kind: cams.length ? 'secondary' : 'primary' }));
}

export default {
  id: '', title: 'Home',
  render(root, ctx) {
    const nextBox = h('div'), devBox = h('div', { class: 'grid grid-3' });
    const twinEl = h('div', { style: { height: '100%', minHeight: '340px' } });
    const caption = h('p', { class: 'muted', style: { margin: '8px 4px 0', fontSize: '.86rem' } });
    const ctl = mountTwin(twinEl, { view: 'hero', interactive: true });
    root.append(h('div', { class: 'stack-lg' },
      h('div', { class: 'hero-grid' },
        h('div', { class: 'stack' }, h('div', { class: 'eyebrow' }, 'SO-101 Suite'), h('h1', {}, 'Let’s get your arm moving.'),
          h('p', { class: 'lead' }, 'One calm step at a time. This page always shows what to do next, and Learn explains what everything is.'), nextBox),
        h('div', { style: { display: 'flex', flexDirection: 'column' } }, h('div', { style: { flex: 1, minHeight: '340px' } }, twinEl), caption)),
      h('section', { class: 'stack' }, h('h2', {}, 'What’s connected'), devBox),
      h('section', { class: 'grid grid-2' },
        h('div', { class: 'card flat quick' }, h('h3', { style: { marginBottom: '6px' } }, 'New here?'),
          h('a', { href: '#/learn/meet-your-arm' }, icon('arm'), 'Meet your arm', h('span', {}, '3D tour')),
          h('a', { href: '#/learn/how-it-works' }, icon('book'), 'How it works', h('span', {}, '3 min')),
          h('a', { href: '#/learn/why-calibrate' }, icon('sliders'), 'Why calibrate?', h('span', {}, '2 min'))),
        h('div', { class: 'card flat quick' }, h('h3', { style: { marginBottom: '6px' } }, 'Need a hand?'),
          h('a', { href: '#/help' }, icon('life'), 'Troubleshooting', h('span', {}, 'symptom → fix')),
          h('a', { href: '#/glossary' }, icon('quote'), 'Glossary', h('span', {}, 'every word')),
          h('a', { href: '#/settings' }, icon('gear'), 'Settings', h('span', {}, 'look, units, safety'))))));

    const offs = [
      ctx.onChange((c) => [c.checklist?.summary, c.checklist?.items?.find((i) => i.id === c.checklist.summary?.next)], () => nextBox.replaceChildren(nextCard(ctx))),
      ctx.onChange((c) => [c.arm('follower') && [c.arm('follower').online, c.arm('follower').joints?.length, c.arm('follower').calibrated, c.arm('follower').port], c.arm('leader') && [c.arm('leader').online, c.arm('leader').joints?.length, c.arm('leader').calibrated, c.arm('leader').port], (c.state?.cameras || []).map((x) => x.ok)], () => devBox.replaceChildren(armCard(ctx, 'follower', false), armCard(ctx, 'leader', true), camCard(ctx))),
      ctx.subscribe((c) => {
        const arm = [c.arm('follower'), c.arm('leader')].find((a) => a?.online && a.joints?.length);
        if (arm) { ctl.setPose?.(poseFromArm(arm)); caption.textContent = `Live: your ${arm.role} arm. Drag to look around.`; }
        else {
          const t = performance.now() / 1000;
          ctl.setPose?.({ shoulder_pan: 22 * Math.sin(t / 2.4), shoulder_lift: 8 * Math.sin(t / 3.1), elbow_flex: 10 * Math.sin(t / 2.7 + 1), wrist_flex: 14 * Math.sin(t / 2.2), wrist_roll: 0, gripper: 35 + 30 * Math.sin(t / 1.9) });
          caption.textContent = 'No arm connected yet, so this one is just waving. Drag to look around.';
        }
      }),
    ];
    return () => { offs.forEach((f) => f()); ctl.destroy?.(); };
  },
};
