// Calibrate: teach an arm where its joints start, stop and sit in the middle. The heart of the app.
// Driven by arms[idx].calib.step: idle -> center -> sweep -> done. Written to docs/design/physical-instructions.md:
// one action per step, a picture for every spatial idea, a visible "you'll know it worked", an "if not",
// and every button acknowledged the moment it is pressed.
// Standing safety rule (docs/LEARNINGS.md 17): the follower must be LIMP (pp.limp, lowered onto the table by POST /api/pp/rest) before anyone
// is asked to touch it. Starting a calibration switches the torque off at once and would drop a raised arm, so Start waits for limp (limp.js).
import { h, icon, rich, button, badge, callout, copyBox, askYes, toast, term, safe, loadCss, pageHead, clear } from '../ui.js';
import { stepCard, preflight, rightWrong } from '../steps.js';
import { mountTwin } from '../twin.js';
import { JOINTS, JOINT_LABEL, poseFromArm, normalized } from '../state.js';
import { middlePose, poseMini, jointMotion, barLegend } from '../diagrams/calibrate.js';
import { limpCard, limpState, ensureLimp, HELP_HREF } from '../limp.js';

loadCss(new URL('../../css/pages/calibrate.css', import.meta.url).href);

const MIN_SPAN = 150;      // ticks: the server refuses to save a joint that moved less (app/server.py MIN_SPAN)
const SOFT_SPAN = 900;     // ticks (about 79 degrees): below this a joint is "enough to save" but not its full reach
const TICKS = 4095;        // one full turn
const STAGES = ['Get ready', 'Middle pose', 'Move every joint', 'Saved'];
const STEP_INDEX = { idle: 0, center: 1, sweep: 2, done: 3 };
const LINK = { shoulder_pan: 'shoulder_link', shoulder_lift: 'upper_arm_link', elbow_flex: 'lower_arm_link', wrist_flex: 'wrist_link', wrist_roll: 'gripper_link', gripper: 'moving_jaw_so101_v1_link' };
const MIDDLE_POSE = { shoulder_pan: 0, shoulder_lift: 0, elbow_flex: 0, wrist_flex: 0, wrist_roll: 0, gripper: 50 };
const lc = (s) => String(s).toLowerCase();
const nice = (j) => lc(JOINT_LABEL[j] || j);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const txt = (str) => h('p', { style: { margin: 0 } }, rich(str));   // one block node: stepCard's "know"/"if not" rows are flex rows (and flex every <span> inside), so inline <b> and links need a wrapper that is not a span
const defaultBefore = new Map();                // role -> did the arm already have a default before this run? (the first calibration becomes the default)
const cancelledMid = new Map();                 // role -> the person stopped part-way (the motors were reset)
const fmtDeg = (v) => { const r = Math.round(v * 10) / 10; return `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(1)}°`; };
const fmtNorm = (v) => { const r = Math.round(v); return `${r < 0 ? '−' : '+'}${Math.abs(r)}`; };

/** What each row of the sweep asks for. One action per row, with an end state. */
const rowCopy = (role) => ({
  shoulder_pan: { id: 1, say: 'Turn the whole arm on its base: all the way to one side, then all the way to the other side.' },
  shoulder_lift: { id: 2, say: 'Lean the upper arm all the way back, then all the way forward.' },
  elbow_flex: { id: 3, say: 'Fold the forearm all the way in toward the upper arm, then straighten it all the way out.' },
  wrist_flex: { id: 4, say: 'Tip the gripper all the way up, then all the way down.' },
  wrist_roll: { id: 5, say: 'Spin the gripper around its own length, one full turn.', note: 'This joint spins freely, so the app records a full turn for it by itself. Turning it is optional: do it to see it move.' },
  gripper: { id: 6, say: role === 'leader' ? 'Squeeze the trigger all the way, then let it go all the way back.' : 'Open the gripper all the way, then close it all the way.' },
});

/** Joint names in the server's sentence become the names on this page ("elbow_flex" -> "elbow flex"). */
const humanise = (s) => String(s || '').replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (m) => (JOINT_LABEL[m] ? lc(JOINT_LABEL[m]) : m));

/** Disable or enable a button in place (a re-drawn button eats clicks), and keep the reason visible. */
function gate(btn, why) {
  const off = !!why;
  btn.disabled = off;
  if (off) { btn.setAttribute('aria-disabled', 'true'); btn.title = why; btn.dataset.why = why; }
  else { btn.removeAttribute('aria-disabled'); btn.removeAttribute('title'); delete btn.dataset.why; }
}
/** One line under a group of buttons saying why any are greyed out, same wording as ui.actions(). */
function whyLine(el, buttons) {
  const groups = new Map();
  for (const b of buttons) if (b.dataset.why) groups.set(b.dataset.why, [...(groups.get(b.dataset.why) || []), b.dataset.name || b.textContent]);
  const sig = [...groups].map(([r, n]) => n.join(', ') + r).join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.replaceChildren(...[...groups].map(([r, n]) => h('span', { style: { display: 'block' } }, h('b', {}, n.join(', ')), ` greyed out: ${r}`)));
}
const named = (btn, name) => { btn.dataset.name = name; return btn; };

export default {
  id: 'calibrate', title: 'Calibrate',
  render(root, ctx, route) {
    const first = route.query.get('first') === '1';
    const dead = { v: false };
    const pending = new Set();                      // actions in flight (so a double click does nothing)

    /* ---------- the frame: arm tabs, the four stages, the body, a live region ---------- */
    const armsRow = h('div', { class: 'cal-arms' });
    const stagesEl = h('ol', { class: 'stepper cal-steps', 'aria-label': 'Calibration stages' }, STAGES.map((s, i) => h('li', {}, h('b', {}, h('span', { class: 'n' }, `${i + 1}.`), h('span', { class: 't' }, ` ${s}`)))));
    const bodyEl = h('div', { class: 'cal-body', role: 'tabpanel', 'aria-live': 'off' });
    const sayEl = h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
    root.append(h('div', { class: 'cal' },
      pageHead('Get started · step 4 of 5', 'Calibrate your arm', 'Teach an arm where each joint starts, stops and sits in the middle. About 2 minutes per arm.'),
      armsRow, stagesEl, bodyEl, sayEl));

    /* ---------- the 3D arm: made once, moved between layouts, never rebuilt ---------- */
    const twinEl = h('div');
    const twinCap = h('p', { class: 'cap' });
    const aside = h('aside', { class: 'cal-aside', 'aria-label': 'The arm in 3D' }, h('figure', { class: 'card cal-twin', style: { margin: 0 } }, twinEl, twinCap));
    const twin = mountTwin(twinEl, { pose: MIDDLE_POSE, view: 'profile', interactive: true });   // the twin's "front" camera looks at the arm from its right-hand side: base left, gripper right, like the diagram
    let twinMode = '', twinHl = '', live = null;

    /* ---------- which arm ---------- */
    const arms = () => ctx.state?.arms || [];
    const initial = () => {
      const list = arms(), want = route.query.get('arm');
      let i = want ? list.findIndex((a) => a.role === want) : -1;
      if (i < 0) i = list.findIndex((a) => a.calib?.step && a.calib.step !== 'idle');
      if (i < 0) i = list.findIndex((a) => a.online && !a.calibrated && !a.remote);
      if (i < 0) i = list.findIndex((a) => a.role === 'follower');
      return Math.max(0, i);
    };
    let sel = initial();
    const arm = () => arms()[sel] || null;
    const stepOf = (i = sel) => arms()[i]?.calib?.step || 'idle';
    const say = (msg) => { sayEl.textContent = ''; setTimeout(() => { sayEl.textContent = msg; }, 30); };

    /* ---------- Restore default writes to the motors with the torque off: for the follower the arm is lowered and made limp FIRST ---------- */
    function restoreFlow(idx, { quiet = false } = {}) {
      const role = arms()[idx]?.role === 'leader' ? 'leader' : 'follower', follower = role === 'follower';
      const lowering = follower && limpState(ctx) !== 'limp';
      const msg = !follower ? 'The leader arm is limp. The default calibration is written to its motors now. Restore?'
        : lowering ? '<b>Hands off the arm now.</b> The arm lowers itself onto the table and goes limp, then the default calibration is written to its motors. Keep your hands clear until the page says it is limp. Restore?'
        : 'The arm is limp and stays limp while the default calibration is written to its motors. Restore?';
      askYes(msg, 'Yes, restore', safe(async () => {
        if (follower) {
          const r = await ensureLimp(ctx, { cancelled: () => dead.v });
          if (!r.ok) { if (!r.cancelled) toast(`<b>Not restored.</b> ${r.message}`, 'warn', 9000); return; }
        }
        await ctx.api.post(`/api/calib/${idx}/restore`); await ctx.refresh();
        const n = ctx.state?.arms?.[idx]?.notice; if (n && !quiet) toast(rich(n), 'ok');
      }));
    }

    /* ---------- pressing a button: acknowledge now, ask the server, check it really happened ---------- */
    async function act(action, expect, btn, busyText, ackEl, ackText) {
      const idx = sel, key = `${idx}:${action}`;
      if (pending.has(key)) return;
      pending.add(key);
      const original = btn ? [...btn.childNodes] : null;
      if (btn) { btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin', style: { width: '16px', height: '16px' } }), busyText); }
      if (ackEl) ackEl.replaceChildren(h('span', { class: 'spin' }), ackText);
      if (ackText) say(ackText);
      const restore = () => { if (btn?.isConnected) { btn.replaceChildren(...original); btn.disabled = false; } if (ackEl?.isConnected) ackEl.replaceChildren(); };
      try {
        await ctx.api.post(`/api/calib/${idx}/${action}`);
        let ok = false;
        for (let n = 0; n < 8 && !dead.v; n++) { await ctx.refresh(); if (stepOf(idx) === expect) { ok = true; break; } await sleep(250); }
        if (!ok && !dead.v) {
          restore();
          const a = arms()[idx];
          toast(`<b>The arm did not ${action === 'start' ? 'start calibrating' : action === 'center' ? 'record the middle' : action === 'finish' ? 'save' : 'do that'}.</b> ${a && !a.online ? 'It is not answering: check its USB cable and power.' : a?.wiggling ? 'It is busy with a test move: wait for it to finish.' : a?.calib?.error ? humanise(a.calib.error) : 'It may be busy. Try again in a moment.'}`, 'warn');
        }
        return ok;
      } catch (e) { restore(); throw e; }
      finally { pending.delete(key); }
    }

    /* ---------- top: arm tabs and stage bar ---------- */
    function drawArms() {
      const list = arms();
      const tag = (a) => (a.remote ? badge('view only') : !a.online ? badge('Offline', 'bad') : a.calib?.step && a.calib.step !== 'idle' ? badge('Calibrating', 'accent') : a.calibrated ? badge('Calibrated', 'ok') : badge('Not calibrated', 'warn'));
      const nameOf = (a) => (a.role === 'leader' ? 'Leader arm' : a.role === 'follower' ? 'Follower arm' : 'Arm');
      if (list.length >= 2) {
        armsRow.replaceChildren(h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Which arm' }, list.map((a, i) =>
          h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(i === sel), onclick: () => { if (i !== sel) { sel = i; drawArms(); ctx.notify(); } } }, nameOf(a), tag(a)))));
      } else if (list.length === 1) {
        armsRow.replaceChildren(h('div', { class: 'row' }, h('b', {}, nameOf(list[0])), tag(list[0]), list[0].port ? h('span', { class: 'muted mono', style: { fontSize: '.82rem' } }, list[0].port) : null));
      } else armsRow.replaceChildren();
    }
    function drawStages(a) {
      const show = !!a && a.online && !a.remote;
      stagesEl.hidden = !show;
      const cur = STEP_INDEX[a?.calib?.step || 'idle'] ?? 0;
      [...stagesEl.children].forEach((li, i) => { li.className = i === cur ? 'cur' : i < cur ? 'done' : ''; li.setAttribute('aria-current', i === cur ? 'step' : 'false'); });
    }

    /* ---------- the layouts ---------- */
    const grid = (cls, main, withTwin = true) => h('div', { class: `cal-grid ${cls || ''}` }, h('div', { class: 'cal-main' }, main), withTwin ? aside : null);

    function plugCard(a, role) {
      const nm = role === 'leader' ? 'leader' : 'follower';
      return h('section', { class: 'card cal-plug stack' },
        h('h2', {}, a ? `The ${nm} arm is not answering` : 'No arm found yet'),
        h('p', { class: 'muted' }, a ? 'Its motors do not reply, so there is nothing to calibrate yet.' : 'The app has not found an arm on any USB port yet.'),
        h('ol', {},
          h('li', {}, rich('Plug the <b>USB cable</b> into the computer. The other end goes into the small circuit board in the arm’s base.')),
          h('li', {}, rich('Plug in the arm’s <b>power supply</b> and wait about 5 seconds.')),
          h('li', {}, 'This page updates by itself when the arm answers. You do not need to reload.')),
        h('div', { class: 'row' }, button('Find my arm', { kind: 'primary', icon: 'plug', href: '#/motors' }), button('Run the setup check', { href: '#/setup', kind: 'ghost' })),
        h('p', { class: 'why' }, rich('Not sure which port? <b>Find my arm</b> unplugs and re-plugs it with you to tell the two arms apart.')));
    }

    /* ----- IDLE ----- */
    function buildIdle(a) {
      const role = a.role === 'leader' ? 'leader' : 'follower', idx = sel, follower = role === 'follower';
      const cards = [];
      if (first || (!a.calibrated && !a.has_default)) {
        cards.push(callout('tip', 'This calibration becomes your <b>restore point</b>: the first one you save is kept as your default. If a later calibration goes wrong, press <b>Restore default</b> to go back to it.', 'First time calibrating this arm?'));
      }
      const nMotors = a.joints?.length || 0;
      if (a.online && nMotors < 6) cards.push(callout('warn', `Only <b>${nMotors} of 6</b> motors answer, so the arm cannot be calibrated yet. Check the cables between the motors, or set the missing motor IDs: <a href="#/test">Test motors</a> · <a href="#/motors">Motor IDs</a>.`, 'Some motors are missing'));
      if (cancelledMid.get(role) && a.calibrated) {
        cards.push(callout('warn', `Pressing <b>Start</b> reset the numbers stored in the motors. They no longer match your saved calibration file. ${a.has_default ? 'Calibrate again, or press <b>Restore default</b> below.' : 'Calibrate again to fix it.'}`, 'You stopped part-way'));
      }
      cards.push(h('section', { class: 'card cal-explain' },
        h('div', { class: 'eyebrow' }, 'Step 1 of 4 · get ready'),
        h('h2', {}, `Calibrate the ${role} arm`),
        h('div', { class: 'beginner-only', style: { marginTop: '12px' } },
          h('p', {}, term('calibration', 'Calibration'), ' teaches the arm where each of its ', term('joint', 'joints'), ' starts, stops and sits in the middle.'),
          h('p', {}, 'You put the arm in its middle pose, then move every joint by hand from one end to the other while the app records the ', term('range-of-motion', 'range'), '.'),
          h('p', {}, 'After that, every joint reads ', term('middle-of-range', '0 at the middle of its range'), ', in degrees or on LeRobot’s ', term('normalized', '−100 to +100 scale'), '.')),
        h('div', { class: 'cal-facts' },
          h('div', { class: 'cal-fact' }, h('b', {}, 'Time'), h('span', {}, 'About 2 minutes')),
          h('div', { class: 'cal-fact' }, h('b', {}, 'Why'), h('span', {}, 'Both arms must read the same numbers in the same pose')),
          h('div', { class: 'cal-fact' }, h('b', {}, 'Zero rule'), h('span', {}, '0 = the middle of the range you record')))));
      cards.push(preflight({
        title: 'Before you start', minutes: 2,
        needs: [`The ${role} arm, plugged into the computer by USB and into its power supply`, 'The base clamped to the table, so it cannot slide'],
        hands: follower ? 'Both, but only once the arm is limp: one hand moves the arm, the other clicks the buttons on this page. Keep your hands off the arm until this page says it is limp.' : 'Both: one hand moves the arm, the other clicks the buttons on this page.',
        moves: follower ? 'Nothing moves by itself, except when you press <b>Lower the arm and make it limp</b>: the arm lowers itself onto the table and then lets go. Keep your hands clear until it says it is limp. <b>Start</b> keeps the arm limp: you move each joint by hand.'
          : 'Nothing moves by itself. The leader arm is limp by design: you move each joint by hand.',
        clear: 'About one arm-length of free table around the arm, and no cable across its joints.',
        stop: follower ? 'Press the red <b>STOP</b> button at the top of the screen: the arm holds where it is. Once calibration has started, <b>Cancel</b> on this page stops it too.' : 'Press <b>Cancel</b> on this page at any time. Nothing here moves the arm for you.',
      }));
      // the follower must be LIMP, lowered, before anyone is asked to touch it (the real state, pp.limp). The leader is limp by design.
      let limpC = null, nearNote = null;
      if (follower) limpC = limpCard(ctx, { title: 'Make the arm limp first', then: () => { startBtn.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); startBtn.focus?.({ preventScroll: true }); } });
      else { nearNote = callout('warn', 'The <b>follower arm is stiff</b> right now. <b>Do not touch it.</b> You do not need to touch it to calibrate the leader.', 'Keep clear of the other arm'); nearNote.hidden = true; }
      if (limpC) cards.push(limpC); if (nearNote) cards.push(nearNote);
      const startBtn = named(button(`Start calibrating the ${role} arm`, { kind: 'primary', size: 'lg', icon: 'arrow', onClick: () => {
        const notLimp = () => follower && limpState(ctx) !== 'limp';
        if (notLimp()) { toast('<b>The arm is not limp.</b> Make it limp first (the card above), then press Start.', 'warn'); return; }
        askYes(follower ? 'The arm is limp and resting on the table. Calibration keeps it limp: you will move each joint by hand. Ready?'
          : 'The leader arm is limp. Calibration keeps it limp: you will move each joint by hand. Ready?', 'Yes, start', safe(async () => {
          if (notLimp()) { toast('<b>The arm is not limp any more.</b> Make it limp first, then press Start.', 'warn'); return; }   // the real state again, at the click
          cancelledMid.delete(role);
          say('Starting calibration. The arm stays limp.');
          await act('start', 'center', startBtn, 'Starting…', ack, 'Got it. Calibration is starting. The arm stays limp.');
        }));
      } }), 'Start');
      const ack = h('div', { class: 'cal-ack', 'aria-live': 'polite' });
      const startWhy = h('p', { class: 'why' });
      cards.push(h('section', { class: 'card cal-start' }, startBtn, startWhy, ack, h('p', { class: 'cal-hold' }, 'You will be asked to confirm first. Nothing happens until you say yes.')));

      let restoreBtn, defaultBtn, notice, restoreWhy;
      if (a.calibrated || a.has_default) {
        const doPost = async (path) => { await ctx.api.post(`/api/calib/${idx}/${path}`); await ctx.refresh(); const n = ctx.state?.arms?.[idx]?.notice; if (n) toast(rich(n), 'ok'); };
        restoreBtn = named(button('Restore default', { onClick: () => restoreFlow(idx) }), 'Restore default');
        defaultBtn = named(button('Set as default', { onClick: () => askYes('Make the <b>current</b> calibration your new default (restore point)? The old default is replaced.', 'Yes, replace it', safe(() => doPost('set_default'))) }), 'Set as default');
        notice = h('p', { class: 'cal-notice', 'aria-live': 'polite' });
        restoreWhy = h('p', { class: 'why' });
        cards.push(h('section', { class: 'card cal-restore' },
          h('h3', {}, icon('shield'), 'Your restore point'),
          h('p', { class: 'muted', style: { margin: 0 } }, a.has_default ? 'A default calibration is saved. If a calibration goes wrong, press Restore default to put it back on the motors.' : 'No default is saved yet. Press Set as default to keep the current calibration as your restore point.'),
          h('div', { class: 'row' }, restoreBtn, defaultBtn), restoreWhy, notice));
      }
      bodyEl.replaceChildren(grid('cal-idle', cards));
      live = (cur) => {
        const n = cur.joints?.length || 0;
        let why = !cur.online ? 'The arm is not connected' : cur.role_confirmed === false ? `The app only guessed that this is the ${cur.role} arm. Open Motor IDs and tell it which arm this really is, so the calibration is saved in the right place` : n < 6 ? `Only ${n} of 6 motors answer` : cur.wiggling ? 'The arm is doing a test move: wait for it to end' : ctx.offline ? 'The app lost its connection' : (cur.role === 'follower' && ctx.state?.pp?.running && ctx.state.pp.mode === 'rest') ? 'The arm is lowering itself: keep your hands clear until it is limp' : (cur.role === 'follower' && ctx.state?.pp?.running) || ctx.state?.teleop?.on ? 'The arm is being used: stop pick & place or leader to follower first' : '';
        const ls = limpState(ctx);
        if (!why && follower) why = ls === 'limp' ? '' : ls === 'stiff' ? 'The arm is stiff: make it limp first (the card above)' : 'The app cannot tell yet whether the arm is limp';
        limpC?.update();
        if (nearNote) nearNote.hidden = ls !== 'stiff';
        if (!pending.has(`${idx}:start`)) gate(startBtn, why);
        whyLine(startWhy, [startBtn]);
        if (restoreBtn) {
          gate(restoreBtn, !cur.has_default ? 'No default is saved yet' : !cur.online ? 'The arm is not connected' : ctx.offline ? 'The app lost its connection' : '');
          gate(defaultBtn, !cur.calibrated ? 'Calibrate first' : ctx.offline ? 'The app lost its connection' : '');
          whyLine(restoreWhy, [restoreBtn, defaultBtn]);
          if (notice.textContent !== (cur.notice || '')) notice.textContent = cur.notice || '';
        }
      };
    }

    /* ----- CENTRE ----- */
    function buildCentre(a) {
      const role = a.role === 'leader' ? 'leader' : 'follower', idx = sel;
      const centred = named(button("It's centred", { kind: 'primary', size: 'lg', icon: 'check' }), "It's centred");
      const cancel = button('Cancel', { kind: 'ghost' });
      const ack = h('div', { class: 'cal-ack', 'aria-live': 'polite' });
      const why = h('p', { class: 'why' });
      const paused = callout('warn', 'The arm stopped answering, so calibration is <b>paused</b>. Check the USB cable and the power plug. This page carries on by itself when the arm is back, or press <b>Cancel</b>.', 'Paused');
      paused.hidden = true; paused.setAttribute('role', 'alert');
      centred.onclick = safe(() => act('center', 'sweep', centred, 'Recording the middle…', ack, 'Got it: recording the middle now. The next step opens in a moment.'));
      cancel.onclick = safe(() => cancelRun(cancel));
      const gripWord = role === 'leader' ? 'Squeeze the trigger about halfway' : 'Open the gripper about halfway';
      const card = stepCard({
        n: 2, total: 4, id: 'centre', title: 'Put every joint in the middle of its range',
        safety: `<b>The arm is limp now.</b> It moves freely and falls back down when you let go. Keep your fingers out of the gaps between the parts.`,
        where: `Your ${role} arm, seen from the side.<br><b>Upper arm</b>: the long printed piece that goes up from the shoulder motor.<br><b>Forearm</b>: the long piece after the elbow.<br><b>Wrist</b>: the short block after the forearm.<br><b>${role === 'leader' ? 'Handle' : 'Gripper'}</b>: ${role === 'leader' ? 'the hand grip with the trigger, at the end' : 'the two-jaw hand at the end'}.`,
        do: [
          'Take the forearm in one hand.',
          'Lift the arm until the upper arm points up, like the picture.',
          'Bend the elbow until the forearm points straight out, level with the table.',
          'Tip the wrist until the gripper carries on in the same line as the forearm.',
          'Turn the wrist roll until the two jaws sit one above the other, with the moving jaw on top, like the 3D arm.',
          `With your free hand, ${lc(gripWord)}.`,
          "Keep the arm in that pose and click <b>It's centred</b> with your free hand.",
        ],
        how: 'It only has to look like the picture: a hand’s width off is fine, because the app measures the real angles.',
        know: txt('The next step opens at once and every joint bar sits on its 0 line.'),
        ifNot: txt(`If the arm does not look like the picture, move it again: nothing is saved yet. If a joint feels stiff, do not force it: let go, press <b>Cancel</b> and <a href="${HELP_HREF}">open Help</a>.`),
        then: 'Next you move each joint from one end to the other.',
        diagram: middlePose({ role }),
        caption: 'Side view: the base is on the left of the picture and the gripper points to the right. Compare the limp arm with the picture. Circled numbers are the six joints: 1 shoulder pan, 2 shoulder lift, 3 elbow flex, 4 wrist flex, 5 wrist roll, 6 gripper.',
        footer: [centred, cancel],
      });
      const pair = h('div', { class: 'card tight stack-sm' }, h('h3', {}, 'Common mistake'),
        rightWrong({ node: poseMini('right'), caption: '<b>Right.</b> Upper arm up, forearm out.' }, { node: poseMini('wrong'), caption: '<b>Wrong.</b> A limp arm slumps like this. That is the end of the elbow’s range, not the middle.' }));
      bodyEl.replaceChildren(h('div', { class: 'cal-centre stack' }, card, ack, why, paused, h('div', { class: 'cal-centre-extra' }, pair, aside)));
      live = (cur) => {
        const off = !cur.online;
        paused.hidden = !off;
        if (!pending.has(`${idx}:center`)) gate(centred, off ? 'The arm stopped answering: check its USB cable and power' : ctx.offline ? 'The app lost its connection' : '');
        whyLine(why, [centred]);
      };
    }

    async function cancelRun(btn) {
      const idx = sel, role = arms()[idx]?.role, was = stepOf(idx);
      const mid = role && (was === 'center' || was === 'sweep');
      if (mid) cancelledMid.set(role, true);                     // set before the page redraws as "idle", so the warning is there at once
      let ok = false;
      try { ok = await act('cancel', 'idle', btn, 'Cancelling…', null, 'Cancelled.'); } finally { if (!ok && mid) cancelledMid.delete(role); }
      if (!ok) return;
      toast('<b>Calibration cancelled.</b> The arm is still limp: rest it on the table.', 'ok');
    }

    /* ----- SWEEP ----- */
    function buildSweep(a) {
      const role = a.role === 'leader' ? 'leader' : 'follower', idx = sel, COPY = rowCopy(role);
      const rows = new Map();
      const rowEls = JOINTS.map((j) => {
        const c = COPY[j];
        const vMain = h('b', { class: 'jrow__main-val' }, '—'), vAlt = h('span', { class: 'jrow__alt' }), vSpan = h('span', { class: 'jrow__span' });
        const range = h('i', { class: 'range', style: { left: '50%', width: '0%' } }), dotv = h('i', { class: 'dotv', style: { left: '50%' } });
        const state = h('span', { class: 'jrow__state' });
        const note = h('p', { class: 'jrow__note' });
        const bar = h('div', { class: 'jbar', role: 'img', 'aria-label': `${JOINT_LABEL[j]} position bar` }, range, dotv);
        const row = h('div', { class: 'jrow', 'data-state': 'todo', 'data-joint': j },
          h('figure', { class: 'jrow__fig' }, jointMotion(j, { role })),
          h('div', { class: 'jrow__main' },
            h('div', { class: 'jrow__title' }, h('span', { class: 'jrow__n', 'aria-hidden': 'true' }, String(c.id)), h('b', {}, JOINT_LABEL[j]), state),
            h('p', { class: 'jrow__do' }, c.say), note, bar,
            h('div', { class: 'jrow__vals' }, vMain, vAlt, vSpan)));
        rows.set(j, { row, vMain, vAlt, vSpan, range, dotv, state, note, last: '', lastPos: null, lastMove: 0, c });
        return row;
      });
      const count = h('span', { class: 'cal-count' }, '0 of 5 ready to save');
      const rowsCard = h('section', { class: 'card cal-rows', 'aria-label': 'Joints' },
        h('div', { class: 'cal-rows__head' }, h('h3', {}, 'The six joints'), count),
        h('div', { class: 'cal-legend beginner-only' }, barLegend(), h('p', {}, rich(`Each bar is one full turn of the joint. Beside it, the number is <b>0 at the middle of what you have covered</b>, in ${ctx.units === 'norm' ? 'LeRobot’s −100 to +100 scale' : 'degrees'}. Change this in <a href="#/settings">Settings</a>.`))),
        rowEls);
      const intro = stepCard({
        n: 3, total: 4, id: 'sweep', title: 'Move every joint through its full range',
        safety: '<b>The arm is limp.</b> Move each joint slowly and stop when it stops: never force it past its end. Keep your fingers out of the gaps between the parts.',
        where: 'The six rows below, from the top. Each row has a small picture of the movement and a bar that shows your progress.',
        do: ['Take the first row that has no tick.', 'Move that joint slowly all the way to one end, until it stops.', 'Move it slowly all the way to the other end, until it stops.', 'Go to the next row.'],
        how: 'About 3 seconds each way: as slowly as lowering a cup onto a saucer.',
        know: txt('The coloured band on the bar grows, the dot follows the joint, and the row gets a tick.'),
        ifNot: txt('If a dot never moves, that motor is not answering: press <b>Cancel</b> and check its cable on <a href="#/test">Test motors</a>.'),
        then: 'When every row has a tick, <b>Save calibration</b> lights up.',
      });
      intro.classList.add('cal-intro');
      const save = named(button('Save calibration', { kind: 'primary', size: 'lg', icon: 'check' }), 'Save calibration');
      const cancel = button('Cancel', { kind: 'ghost' });
      const ack = h('div', { class: 'cal-ack', 'aria-live': 'polite' });
      const why = h('p', { class: 'why' });
      const soft = h('p', { class: 'cal-soft' });
      const err = callout('warn', h('p', {}, ''), 'The arm did not save yet');
      err.hidden = true; err.setAttribute('role', 'alert'); err.classList.add('cal-error');
      const errText = err.querySelector('p');
      const paused = callout('warn', 'The arm stopped answering, so calibration is <b>paused</b>. Check the USB cable and the power plug. This page carries on by itself when the arm is back, or press <b>Cancel</b>.', 'Paused');
      paused.hidden = true; paused.setAttribute('role', 'alert');
      save.onclick = safe(() => act('finish', 'done', save, 'Saving…', ack, 'Got it. Saving to the motors now. Keep the arm where it is until the next screen says you can let go.'));
      cancel.onclick = () => askYes('Cancel calibration? The motors keep the half-finished numbers until you calibrate again' + (a.has_default ? ' or press Restore default.' : '.'), 'Yes, cancel', safe(() => cancelRun(cancel)), { cancelLabel: 'No, keep going' });
      const saveCard = h('section', { class: 'card cal-save' }, h('div', { class: 'btns' }, save, cancel), why, soft, ack);
      saveCard.classList.add('cal-savecard');
      const main = h('div', { class: 'cal-main' }, intro, paused, rowsCard, err, saveCard);
      bodyEl.replaceChildren(h('div', { class: 'cal-grid cal-sweep' }, main, aside));

      let activeJoint = '';
      live = (cur) => {
        const rng = cur.calib?.ranges || {}, units = ctx.units, now = performance.now();
        let moved = 0, need = [], small = [], bestT = 0, best = '';
        for (const j of JOINTS) {
          const R = rows.get(j), jr = cur.joints?.find((x) => x.name === j), pos = jr?.pos;
          const r = rng[j], lo = r ? r[0] : pos, hi = r ? r[1] : pos;
          const span = lo != null && hi != null ? Math.max(0, hi - lo) : 0;
          const free = j === 'wrist_roll';
          let st = free ? (span >= SOFT_SPAN ? 'done' : 'auto') : span >= SOFT_SPAN ? 'done' : span >= MIN_SPAN ? 'some' : 'todo';
          if (pos == null) st = 'off';
          if (!free) { if (span >= MIN_SPAN) moved++; else need.push(j); if (span >= MIN_SPAN && span < SOFT_SPAN) small.push(j); }
          if (pos != null) {
            const mid = (lo + hi) / 2, pct = (v) => clamp(50 + ((v - mid) / TICKS) * 100, 0, 100);
            const deg = ((pos - mid) * 360) / TICKS, nv = normalized(cur, j) ?? 0;
            R.dotv.style.left = `${pct(pos).toFixed(2)}%`;
            R.range.style.left = `${pct(lo).toFixed(2)}%`; R.range.style.width = `${Math.max(0, pct(hi) - pct(lo)).toFixed(2)}%`;
            const main = units === 'norm' ? fmtNorm(nv) : fmtDeg(deg), alt = units === 'norm' ? `(${fmtDeg(deg)})` : `(${fmtNorm(nv)} on the −100…+100 scale)`;
            if (R.vMain.textContent !== main) R.vMain.textContent = main;
            if (R.vAlt.textContent !== alt) R.vAlt.textContent = alt;
            const sp = `covered ${Math.round((span * 360) / TICKS)}° of 360°`;
            if (R.vSpan.textContent !== sp) R.vSpan.textContent = sp;
            if (R.lastPos != null && Math.abs(pos - R.lastPos) >= 4) R.lastMove = now;
            R.lastPos = pos;
            if (R.lastMove && now - R.lastMove < 1600 && R.lastMove > bestT) { bestT = R.lastMove; best = j; }
          }
          if (R.last !== st) {
            R.last = st; R.row.dataset.state = st === 'auto' || st === 'off' ? 'todo' : st;
            R.state.replaceChildren(st === 'done' ? h('span', { class: 'badge ok' }, icon('check'), 'Done')
              : st === 'some' ? h('span', { class: 'badge warn' }, icon('check'), 'Enough to save')
              : st === 'auto' ? h('span', { class: 'badge' }, icon('check'), 'Counted automatically')
              : st === 'off' ? h('span', { class: 'badge bad' }, icon('alert'), 'Not answering')
              : h('span', { class: 'badge' }, 'Not yet'));
            R.note.textContent = st === 'some' ? 'Move it closer to both ends: the arm can only move inside the range you record.' : st === 'off' ? 'This motor does not answer. Check its cable on the Test motors page.' : R.c.note && st !== 'done' ? R.c.note : '';
          }
        }
        const cnt = `${moved} of 5 ready to save`;
        if (count.textContent !== cnt) count.textContent = cnt;
        if (best !== activeJoint) { rows.get(activeJoint)?.row.classList.remove('active'); rows.get(best)?.row.classList.add('active'); activeJoint = best; setHighlight(best); }
        const offline = !cur.online;
        paused.hidden = !offline;
        const saveWhy = offline ? 'The arm stopped answering: check its USB cable and power' : ctx.offline ? 'The app lost its connection' : need.length ? `Still to move: ${need.map(nice).join(', ')}` : '';
        if (!pending.has(`${idx}:finish`)) gate(save, saveWhy);
        whyLine(why, [save]);
        const sm = small.length ? `You can save now, but only a small part of the range is recorded for ${small.map(nice).join(', ')}. The arm can only move inside the range you record, so a small range means a small reach.` : '';
        if (soft.textContent !== sm) soft.textContent = sm;
        const e = cur.calib?.error ? humanise(cur.calib.error) : '';
        const stale = /^Move these joints/.test(cur.calib?.error || '') && !need.length;
        const shown = e && !stale ? `The arm said: “${e.replace(/[.\s]+$/, '')}”. Keep moving them, then press Save calibration again.` : '';
        err.hidden = !shown;
        if (errText.textContent !== shown) errText.textContent = shown;
      };
    }

    /* ----- DONE ----- */
    function buildDone(a) {
      const role = a.role === 'leader' ? 'leader' : 'follower', idx = sel;
      const other = arms().findIndex((x, i) => i !== idx && x.online && !x.calibrated && !x.remote);
      const finish = async (go) => { await ctx.api.post(`/api/calib/${idx}/cancel`); cancelledMid.delete(role); await ctx.refresh(); go?.(); };
      const nextBtn = other >= 0
        ? button(`Calibrate the ${arms()[other].role} arm`, { kind: 'primary', size: 'lg', icon: 'arrow', onClick: safe(() => finish(() => { sel = other; drawArms(); ctx.notify(); })) })
        : button('Next: Cameras', { kind: 'primary', size: 'lg', icon: 'arrow', onClick: safe(() => finish(() => ctx.go('cameras'))) });
      const ctrl = button('Open Control', { onClick: safe(() => finish(() => ctx.go('control'))) });
      const again = button('Calibrate this arm again', { kind: 'ghost', onClick: safe(() => finish()) });
      const defBtn = named(button('Set as default', { onClick: () => askYes('Make this calibration your new default (restore point)? The old default is replaced.', 'Yes, replace it', safe(async () => { await ctx.api.post(`/api/calib/${idx}/set_default`); await ctx.refresh(); toast('<b>Saved.</b> This calibration is now your restore point.', 'ok'); })) }), 'Set as default');
      const restoreBtn = named(button('Restore default', { onClick: () => restoreFlow(idx, { quiet: true }) }), 'Restore default');
      const note = h('p', { class: 'cal-notice', 'aria-live': 'polite' });
      const defText = h('p', { class: 'muted', style: { margin: 0 } });
      const why = h('p', { class: 'why' });
      const saved = a.calib?.saved;
      const done = h('section', { class: 'card cal-done' },
        h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '16px', flexWrap: 'nowrap' } }, h('div', { class: 'big-tick' }, icon('check')), h('div', { class: 'stack-sm' },
          h('div', { class: 'eyebrow' }, 'Step 4 of 4 · saved'), h('h2', {}, `Done: your ${role} arm is calibrated.`),
          h('p', { style: { margin: 0, fontWeight: 650 } }, 'You can let go now.'),
          h('p', { class: 'muted', style: { margin: 0 } }, 'The arm is still limp (soft), so rest it on the table. Control tells you to take your hands off the arm before its motors switch on again.'))),
        h('p', {}, rich('Every joint now reads <b>0 at the middle of the range you just recorded</b>.')),
        saved ? h('div', { class: 'cal-path' }, h('b', {}, 'Saved to'), copyBox(saved), h('p', { class: 'muted', style: { margin: 0, fontSize: '.88rem' } }, a.calib?.id ? `Calibration name: ${a.calib.id}. LeRobot reads this same file.` : 'LeRobot reads this same file.')) : null);
      const restore = h('section', { class: 'card cal-restore' }, h('h3', {}, icon('shield'), 'Your restore point'), defText, h('div', { class: 'row' }, restoreBtn, defBtn), why, note);
      const next = h('section', { class: 'card stack-sm' }, h('h3', {}, 'What next?'), h('div', { class: 'cal-next' }, nextBtn, ctrl, again));
      bodyEl.replaceChildren(grid('cal-done-grid', [done, restore, next]));
      live = (cur) => {
        const before = defaultBefore.get(cur.role);
        const t = cur.has_default && before === false ? 'This was your first calibration, so it is also kept as your default (restore point). If a later calibration goes wrong, press Restore default to come back to it.'
          : cur.has_default ? 'A default (restore point) is saved. This new calibration is saved too, but it does not replace the default unless you press Set as default.'
          : 'No default is saved yet. Press Set as default to keep this calibration as your restore point.';
        if (defText.textContent !== t) defText.textContent = t;
        gate(restoreBtn, !cur.has_default ? 'No default is saved yet' : !cur.online ? 'The arm is not connected' : '');
        gate(defBtn, ctx.offline ? 'The app lost its connection' : '');
        whyLine(why, [restoreBtn, defBtn]);
        if (note.textContent !== (cur.notice || '')) note.textContent = cur.notice || '';
      };
    }

    /* ----- everything else ----- */
    function buildBody() {
      live = null;
      const a = arm(), list = arms();
      drawStages(a);
      if (!a) { bodyEl.replaceChildren(grid('', plugCard(null, 'follower'), false)); setTwin('none'); return; }
      const step = a.calib?.step || 'idle';
      if (a.remote) {
        bodyEl.replaceChildren(grid('', callout('tip', 'This arm is connected to another computer, so you can look at it here but not calibrate it. Open the app on that computer to calibrate it.', 'View only')));
      } else if (!a.online && step === 'idle') {
        bodyEl.replaceChildren(grid('', plugCard(a, a.role)));
      } else if (step === 'center') buildCentre(a);
      else if (step === 'sweep') buildSweep(a);
      else if (step === 'done') buildDone(a);
      else buildIdle(a);
      void list;
      setTwin(); tickLive();
    }

    /* ---------- the 3D arm follows the state, in place ---------- */
    function setHighlight(joint) {
      const key = joint || '';
      if (key === twinHl) return;
      twinHl = key;
      twin.setHighlight?.(key ? [LINK[key]] : []);
    }
    function setTwin(force) {
      const a = arm();
      const mode = force === 'none' || !a || !a.online ? 'none' : (a.calib?.step === 'center' || (!a.calibrated && (a.calib?.step || 'idle') === 'idle')) ? 'target' : 'live';
      if (`${mode}:${a?.role}` !== twinMode) {
        twinMode = `${mode}:${a?.role}`;
        twinCap.replaceChildren(...(mode === 'target' ? [h('b', {}, 'The middle pose. '), 'This is where every joint should be. Drag to look around.']
          : mode === 'live' ? [h('b', {}, 'Live. '), `Your ${a.role} arm. Drag to look around.`] : ['No arm is answering, so the 3D arm shows the middle pose.']));
        twin.setView?.(mode === 'live' ? 'hero' : 'front');
        if (mode !== 'live') setHighlight('');
      }
      if (mode === 'live') twin.setPose?.(poseFromArm(a)); else twin.setPose?.(MIDDLE_POSE);
    }
    const tickLive = () => { const a = arm(); if (a && live) live(a); };

    /* ---------- wire it up ---------- */
    const offs = [
      ctx.onChange((c) => (c.state?.arms || []).map((a) => [a.role, a.online, a.calibrated, a.calib?.step, a.remote]), () => { if (sel >= arms().length) sel = Math.max(0, arms().length - 1); drawArms(); }),
      ctx.onChange((c) => (c.state?.arms || []).map((a) => [a.role, a.calib?.step || 'idle', a.has_default]), () => { for (const a of arms()) { const st = a.calib?.step || 'idle'; if (st === 'idle' || st === 'center') defaultBefore.set(a.role, !!a.has_default); } }),
      ctx.onChange((c) => { const a = c.state?.arms?.[sel]; return [sel, a?.role, a?.online, a?.calib?.step || 'idle', a?.calibrated, a?.has_default, (a?.joints?.length || 0) >= 6, a?.remote, a?.calib?.saved, c.state?.arms?.length]; }, () => buildBody()),
      ctx.subscribe(() => { setTwin(); tickLive(); }),
    ];
    return () => {
      dead.v = true;
      offs.forEach((f) => f());
      twin.destroy?.();
      // a finished run leaves the arm in "done", which blocks leader to follower: put it back to idle when the person leaves
      arms().forEach((a, i) => { if (a?.calib?.step === 'done') ctx.api.post(`/api/calib/${i}/cancel`).catch(() => {}); });
    };
  },
};
