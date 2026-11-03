// Control (#/control).
//  Real app: the full dashboard (3D twin, leader -> follower, pick and place) embedded as an iframe.
//  Demo / simulated server: a small native Control built from the same /api/state, so visitors can play.
import { h, icon, button, badge, callout, empty, skeleton, loadCss, pageHead, rich, safe, askYes, cameraView } from '../ui.js';
import { api } from '../api.js';
import { mountTwin } from '../twin.js';
import { JOINTS, JOINT_LABEL, poseFromArm, normalized } from '../state.js';
import { limpState, STATE_TEXT, HANDS_OFF } from '../limp.js';

loadCss(new URL('../../css/pages/control.css', import.meta.url).href);

const signed = (n, unit = '', digits = 0) => (n == null || Number.isNaN(n) ? '—' : `${Math.abs(n) < 0.5 * 10 ** -digits ? '' : n < 0 ? '−' : '+'}${Math.abs(n).toFixed(digits)}${unit}`);
const wide = (root, on) => { try { const m = root.closest('main'); if (m) m.classList.toggle('main-wide', on); } catch { /* cosmetic */ } };

export default {
  id: 'control', title: 'Control',
  render(root, ctx) {
    const native = api.demo || ctx.info?.demo === true;
    return native ? nativeControl(root, ctx) : liveControl(root, ctx);
  },
};

/* ======================= real app: the full dashboard ======================= */
function liveControl(root, ctx) {
  // Opening Control means the person has found their way around: from now on `/` lands here.
  if (ctx.settings?.ui?.onboarded !== true) ctx.setSetting('ui.onboarded', true).catch((e) => console.warn('Could not remember that onboarding is done:', e));

  const frame = h('iframe', { class: 'ctl-frame', src: '/dashboard', title: 'Arm control dashboard', allow: 'fullscreen' });
  const warn = h('div', { class: 'ctl-warn', hidden: true });
  let timer = 0, dead = false;

  const showProblem = (title, text) => {
    warn.hidden = false;
    warn.replaceChildren(callout('warn', text, title), h('div', { class: 'row' },
      button('Try again', { size: 'sm', onClick: () => { warn.hidden = true; frame.src = '/dashboard'; arm(); } }),
      h('a', { class: 'btn sm', href: '/dashboard', target: '_blank', rel: 'noopener' }, icon('external'), 'Open in its own tab')));
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { if (!dead) showProblem('The dashboard is slow to open', 'It has not finished loading yet. Give it a few more seconds, or open it in its own tab.'); }, 15000); };
  frame.addEventListener('load', () => {
    clearTimeout(timer);
    try {
      const d = frame.contentDocument, txt = (d?.body?.innerText || '').trim();
      if (d && txt.length < 300 && /not found|error response|can.?t be reached|refused/i.test(`${d.title} ${txt}`)) showProblem('The dashboard did not open', 'The app answered, but it has no dashboard page to show. Restart the app, or open it in its own tab to see the message.');
      else warn.hidden = true;
    } catch { warn.hidden = true; /* cannot look inside: assume it is fine */ }
  });
  arm();

  root.append(h('div', { class: 'ctl-live' },
    h('div', { class: 'ctl-bar' },
      h('div', { class: 'grow' }, h('b', {}, 'Control dashboard'), h('span', { class: 'muted ctl-note' }, ' The full control screen: 3D arm, leader to follower, pick and place. It has its own STOP.')),
      h('a', { class: 'btn sm', href: '/dashboard', target: '_blank', rel: 'noopener' }, icon('external'), 'Open in its own tab')),
    warn,
    frame));
  wide(root, true);
  return () => {
    dead = true; clearTimeout(timer); wide(root, false);
    try { frame.src = 'about:blank'; frame.remove(); } catch { /* already gone */ } // closes the camera streams the dashboard opened
  };
}

/* ======================= demo: a small native Control ======================= */
function nativeControl(root, ctx) {
  let ui = null; // the controls currently on screen: { node, destroy }
  const offs = [];
  const holder = h('div');
  root.append(h('div', { class: 'stack ctl-native' },
    pageHead('Use', 'Control', 'Move the arm and watch it in 3D.'),
    api.demo ? callout('tip', 'This is the demo: the arms and the camera are simulated, so you can press everything. The real app opens the full dashboard here.', 'Try it') : null,
    holder));

  const draw = () => {
    ui?.destroy(); ui = null;
    const f = ctx.arm('follower');
    if (!ctx.state) { holder.replaceChildren(skeleton('100%', 320)); return; }
    if (!f || !f.online) {
      holder.replaceChildren(empty(f ? 'The follower arm is offline' : 'No follower arm found', f ? 'Check its USB cable and its power, then open the setup check.' : 'Plug in the arm’s USB cable and its power. The setup check finds it for you.', button('Open Setup check', { href: '#/setup', kind: 'primary' })));
      return;
    }
    if (!f.calibrated) {
      holder.replaceChildren(h('div', { class: 'card hero ctl-first' }, icon('sliders'),
        h('div', { class: 'stack-sm' }, h('h2', {}, 'Calibrate first'),
          h('p', { class: 'muted' }, 'The follower arm has to learn its range before it can be moved from here. It takes about 2 minutes, and you only do it once.'),
          h('div', {}, button('Calibrate the follower', { href: '#/calibrate', kind: 'primary', size: 'lg', icon: 'arrow' })))));
      return;
    }
    ui = controls(ctx);
    holder.replaceChildren(ui.node);
  };
  offs.push(ctx.onChange((c) => { const f = c.arm('follower'); return [!!c.state, !!f, f?.online, f?.calibrated]; }, draw));
  if (!ctx.state) draw();
  return () => { offs.forEach((f) => f()); ui?.destroy(); ui = null; };
}

function controls(ctx) {
  const offs = [];
  const confirmMoves = () => ctx.settings?.safety?.confirm_before_move !== false;

  /* ----- 3D arm ----- */
  const twinEl = h('div', { class: 'ctl-twin' });
  const caption = h('p', { class: 'muted ctl-cap ctl-capline' }, 'Live: your follower arm. Drag to look around.');
  const twin = mountTwin(twinEl, { view: 'hero', interactive: true, zoom: true });

  /* ----- joint readouts: built once, only text and a dot position change per tick ----- */
  const rows = JOINTS.map((j) => {
    const dot = h('i', { class: 'dotv', style: { left: '50%' } });
    const val = h('b', { class: 'jval mono' }, '—');
    return { j, dot, val, node: h('div', { class: 'jrow' }, h('span', { class: 'jname' }, JOINT_LABEL[j]), h('div', { class: 'jbar', role: 'img', 'aria-label': `${JOINT_LABEL[j]} position` }, dot), val) };
  });
  const unitNote = h('p', { class: 'muted ctl-cap' });
  const readJoints = () => {
    const a = ctx.arm('follower');
    if (!a) return;
    const pose = poseFromArm(a), norm = ctx.units === 'norm';
    for (const r of rows) {
      const n = normalized(a, r.j);
      r.dot.style.left = `${n == null ? 50 : Math.max(0, Math.min(100, (n + 100) / 2))}%`;
      r.val.textContent = norm ? signed(n, '', 0) : r.j === 'gripper' ? `${Math.round(pose.gripper ?? 0)} % open` : signed(pose[r.j], '°', 1);
    }
    twin.setPose?.(pose);
    const t = norm ? '0 is the middle of each joint’s range. The scale runs from −100 to +100.' : '0 is the middle of each joint’s range. The gripper shows how open it is.';
    if (unitNote.textContent !== t) unitNote.textContent = t;
  };
  offs.push(ctx.subscribe(readJoints));

  /* ----- leader -> follower ----- */
  const tBtn = h('button', { class: 'btn primary lg', type: 'button' });
  const tMsg = h('p', { class: 'ctl-msg', role: 'status', 'aria-live': 'polite' });
  const tWhy = h('p', { class: 'why' });
  const handsLine = h('p', { class: 'ctl-hands' }, 'Take your hands off both arms first.');   // the follower switches its motors on when this starts
  let tOn = null;
  const startTele = safe(() => api.post('/api/teleop/start'));
  const stopTele = safe(() => api.post('/api/teleop/stop'));
  tBtn.addEventListener('click', () => {
    if (tBtn.disabled) return;
    if (ctx.state?.teleop?.on) { stopTele(); return; }
    if (confirmMoves()) askYes('<b>Take your hands off both arms first.</b> The follower switches its motors on and moves to the leader’s pose as soon as you press Yes. Then pick up the leader’s handle: the follower copies it.', 'Yes, hands are off', startTele);
    else startTele();
  });
  const drawTele = () => {
    const t = ctx.state?.teleop || {};
    const on = !!t.on, why = on ? '' : (t.why || '');
    handsLine.hidden = on;
    if (on !== tOn) {
      tOn = on;
      tBtn.className = 'btn lg ' + (on ? 'danger' : 'primary');
      tBtn.replaceChildren(icon(on ? 'stop' : 'play'), on ? 'Stop leader → follower' : 'Start leader → follower');
    }
    tBtn.disabled = !!why; tBtn.setAttribute('aria-disabled', why ? 'true' : 'false'); tBtn.title = why;
    tMsg.textContent = on ? (t.blocked ? t.blocked : `${t.msg || ''}${t.synced && t.hz ? ` · ${t.hz} Hz` : ''}`) : (why || t.msg || 'Move the leader by hand: the follower copies it.');
    tMsg.className = 'ctl-msg' + (on && t.blocked ? ' warn' : '');
    tWhy.textContent = why ? `Start leader → follower is greyed out: ${why}` : '';
    tWhy.hidden = !why;
  };
  offs.push(ctx.onChange((c) => c.state?.teleop, drawTele));
  drawTele();

  /* ----- release / reset ----- */
  const relBtn = h('button', { class: 'btn', type: 'button' }, 'Release arm');
  const relWhy = h('p', { class: 'why' });
  // Release arm means REST (POST /api/pp/rest): the follower lowers itself onto the table and only then goes limp, so nothing drops and nobody holds it.
  // (A bare /api/pp/release switches the torque off at once and drops a raised arm: never use it to prepare a person's step.)
  relBtn.addEventListener('click', () => { if (relBtn.disabled) return; askYes('The arm lowers itself onto the table, then goes limp. Keep your hands clear until it says limp.', 'Yes, release', safe(async () => { await api.post('/api/pp/rest'); await ctx.refresh(); })); });
  const resetBtn = h('button', { class: 'btn ghost', type: 'button', title: 'Cancels anything running and clears every stuck state. The arm holds where it is.', onclick: safe(async () => { await api.post('/api/pp/reset'); }) }, 'Reset');
  const armState = h('p', { class: 'ctl-armstate', role: 'status', 'aria-live': 'polite' });
  const drawRel = () => {
    const pp = ctx.state?.pp, ls = limpState(ctx);
    const why = ls === 'limp' ? 'the arm is already limp (torque is off)' : pp?.running ? 'a job is running: press STOP first' : ctx.state?.teleop?.on ? 'leader to follower is running: stop it first' : '';
    relBtn.disabled = !!why; relBtn.setAttribute('aria-disabled', why ? 'true' : 'false'); relBtn.title = why;
    relWhy.textContent = why ? `Release arm is greyed out: ${why}` : ''; relWhy.hidden = !why;
    const t = ls === 'stiff' ? `${STATE_TEXT.stiff} Do not touch it.` : STATE_TEXT[ls];
    if (armState.textContent !== t) armState.textContent = t;
    armState.dataset.state = ls;
  };
  offs.push(ctx.onChange((c) => [c.state?.pp?.limp, c.state?.pp?.running, c.state?.teleop?.on, c.offline], drawRel));
  drawRel();

  /* ----- camera ----- */
  const camBox = h('div', { class: 'stack-sm' });
  let cam = null;
  offs.push(ctx.onChange((c) => (c.state?.cameras || []).length > 0, (has) => {
    cam?.destroy(); cam = null;
    if (!has) { camBox.replaceChildren(empty('No camera yet', 'Add a camera to let the arm see the table.', button('Add a camera', { href: '#/cameras' }))); return; }
    cam = cameraView(0, { label: 'Camera 1' });
    camBox.replaceChildren(cam);
  }));
  offs.push(ctx.onChange((c) => { const x = c.state?.cameras?.[0]; return x && [x.ok, x.err]; }, (v) => { if (cam && v) cam.setStatus(!!v[0], v[1] || 'The camera is not sending pictures'); }));

  /* ----- pick and place status (read only) ----- */
  const ppBadge = h('span'), ppStatus = h('p', { class: 'ctl-msg' }), ppFacts = h('p', { class: 'muted ctl-cap' });
  offs.push(ctx.onChange((c) => { const p = c.state?.pp; return p && [p.ready, p.running, p.status, p.why, p.taught, p.mode]; }, () => {
    const p = ctx.state?.pp;
    if (!p) { ppBadge.replaceChildren(badge('Not available', '')); ppStatus.textContent = 'Pick and place is not running in this build.'; ppFacts.textContent = ''; return; }
    ppBadge.replaceChildren(p.running ? badge('Running', 'accent') : p.ready ? badge('Ready', 'ok') : badge('Not ready', 'warn'));
    ppStatus.textContent = (p.status || 'idle') + (!p.ready && !p.running && p.why ? ` · ${p.why}` : '');
    ppFacts.textContent = `Table map: ${p.taught >= 3 ? 'done' : `${p.taught ?? 0} of 3 points taught`}${p.running && p.mode ? ` · running: ${p.mode}` : ''}`;
  }));

  const node = h('div', { class: 'ctl-demo' },
    h('div', { class: 'ctl-col' },
      h('div', { class: 'card flat ctl-twin-card' }, twinEl), caption,
      h('section', { class: 'card stack-sm ctl-cam' }, h('h3', {}, 'Camera'), camBox)),
    h('div', { class: 'ctl-col' },
      h('section', { class: 'card stack-sm ctl-tele' }, h('h3', {}, 'Leader → follower'),
        h('p', { class: 'muted ctl-cap beginner-only' }, 'The leader is the arm you move by hand. The follower copies it. Both arms need to be calibrated.'),
        handsLine, tBtn, tMsg, tWhy),
      h('section', { class: 'card stack-sm ctl-joints' }, h('h3', {}, 'Joints'), h('div', { class: 'jlist' }, rows.map((r) => r.node)), unitNote,
        h('p', { class: 'ctl-cap' }, h('a', { href: '#/settings/units' }, 'Change units'))),
      h('section', { class: 'card stack-sm ctl-arm' }, h('h3', {}, 'Arm'),
        armState,
        callout('safety', `<b>${HANDS_OFF}</b> Release arm lowers the arm onto the table first and only then lets go, so nothing drops and you do not need to hold anything. Keep your hands clear until it says the arm is limp.`),
        h('div', { class: 'row' }, relBtn, resetBtn), relWhy),
      h('section', { class: 'card stack-sm ctl-pp' }, h('div', { class: 'row-between' }, h('h3', {}, 'Pick and place'), ppBadge), ppStatus, ppFacts,
        h('p', { class: 'muted ctl-cap' }, rich('Mapping the table and picking things up with the camera runs in the real app. Here you can watch its status.')),
        !api.demo ? h('a', { class: 'btn sm', href: '/dashboard', target: '_blank', rel: 'noopener' }, icon('external'), 'Open the full dashboard') : null)));

  return { node, destroy() { offs.forEach((f) => f()); cam?.destroy(); twin.destroy?.(); } };
}
