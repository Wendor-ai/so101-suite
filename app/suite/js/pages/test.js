// Test motors: "Is my arm healthy?" One card per motor with live readings, Ping (read-only) and Wiggle (a small move, only when asked),
// "Check all motors" with a plain report, and a mini view of what the app and the motors said to each other.
import { h, icon, button, badge, callout, empty, skeleton, toast as toastBase, askYes, rich, term, loadCss } from '../ui.js';
import { mountTwin } from '../twin.js';
import { poseFromArm, normalized, JOINTS, JOINT_LABEL } from '../state.js';
import { jointPic, ifNotStrip } from '../diagrams/test.js';
import { inline } from '../diagrams/motors.js';

loadCss(new URL('../../css/pages/test.css', import.meta.url).href);

// ui.js's toast() lays its message out as a flex row, which splits "<b>Title.</b> text" into separate columns.
// Wrapping the message in one <div> keeps it as ordinary text. (safe() does the same job as ui.js's, with that wrapper.)
const toast = (msg, level, ms) => toastBase(typeof msg === 'string' ? h('div', {}, rich(msg)) : msg, level, ms);
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(`<b>That did not work.</b> ${String(e.message || e)}`, 'err'); } };

const IDS = [1, 2, 3, 4, 5, 6];
const NAME = (id) => JOINTS[id - 1];
const LINK = { shoulder_pan: 'shoulder_link', shoulder_lift: 'upper_arm_link', elbow_flex: 'lower_arm_link', wrist_flex: 'wrist_link', wrist_roll: 'gripper_link', gripper: 'moving_jaw_so101_v1_link' };
const JOINT_OF_LINK = Object.fromEntries(Object.entries(LINK).map(([j, l]) => [l, j]));
const WHERE = { shoulder_pan: 'in the base, at the foot of the arm', shoulder_lift: 'at the shoulder, where the upper arm meets the base', elbow_flex: 'at the elbow, in the middle of the arm', wrist_flex: 'at the wrist, where the forearm meets the hand', wrist_roll: 'in the hand, just before the jaws', gripper: 'at the jaws, the very end of the arm' };
const SEE = {
  shoulder_pan: 'The <b>whole arm turns</b> a little to the left, then back to the right.',
  shoulder_lift: 'The <b>upper arm tips</b> a little forward, then back.',
  elbow_flex: 'The <b>forearm bends</b> a little at the elbow, then straightens.',
  wrist_flex: 'The <b>hand tips</b> a little up, then down.',
  wrist_roll: 'The <b>hand twists</b> a little one way, then back.',
  gripper: 'The <b>jaw opens and closes</b> a little.',
};
const ROUTINE = new Set([56, 60, 62, 63, 65]);
const REG = { 5: 'ID', 6: 'speed setting', 9: 'lowest allowed position', 11: 'highest allowed position', 31: 'middle offset', 33: 'mode', 40: 'torque', 41: 'acceleration', 42: 'target position', 46: 'speed', 48: 'torque limit', 55: 'lock', 56: 'position', 60: 'load', 62: 'voltage', 63: 'temperature', 65: 'status' };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const num = (v, d = 0) => { if (v == null || Number.isNaN(+v)) return '—'; const f = (+v).toFixed(d); return /^-0(\.0+)?$/.test(f) ? f.slice(1) : f; };
const lower = (s) => s.replace('_', ' ');

/** raw motor ticks -> degrees from the middle (gripper: % open). The middle is the calibrated middle when we know it. */
function degOf(arm, name, raw) {
  const r = arm?.cal?.[name], mid = r ? (r[0] + r[1]) / 2 : 2047.5;
  if (name === 'gripper') return r ? clamp((raw - r[0]) / Math.max(1, r[1] - r[0]), 0, 1) * 100 : (raw / 4095) * 100;
  return ((raw - mid) * 360) / 4095;
}

export default {
  id: 'test', title: 'Test motors',
  render(root, ctx, route) {
    const api = ctx.api;
    let alive = true, busy = null, cancel = false, hover = null, lastId = null;
    const timers = {};
    const st = { role: route.query.get('role') === 'leader' ? 'leader' : 'follower', report: null, traceView: 'all', trace: { enabled: null, seq: 0, groups: [], left: {}, err: '' } };
    const arm = () => ctx.arm(st.role);
    const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    const announce = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 40); };

    /* ---------- reasons things are greyed out ---------- */
    function whyNoMove() {
      const a = arm();
      if (!a) return `No ${st.role} arm found yet`;
      // a job or the leader link is moving the arm. (ctx.moving is also true for a stiff arm that just holds still: that is fine here, a stiff arm holds itself while one motor wiggles.)
      if (ctx.state?.pp?.running || ctx.state?.teleop?.on) return 'Something else is moving the arm (leader to follower or pick and place): press STOP first';
      if (a.calib && (a.calib.step === 'center' || a.calib.step === 'sweep')) return 'Calibration is running: finish or cancel it first';
      if (a.wiggling) return 'The arm is already moving a motor: wait a moment';
      return '';
    }
    const joint = (id) => arm()?.joints?.find((j) => j.id === id) || null;
    const answers = (id) => !!(arm()?.online && joint(id));
    function whyWiggle(id) {
      if (busy) return busy.all ? 'The full check is running' : 'Another test is running: wait a moment';
      const w = whyNoMove(); if (w) return w;
      if (!answers(id)) return `Motor ${id} does not answer. Fix that first (see “If not” below), then Ping it`;
      return '';
    }
    const whyPing = (id) => (busy ? (busy.all ? 'The full check is running' : 'Another test is running: wait a moment') : !arm() ? `No ${st.role} arm found yet` : '');

    /* ---------- the 3D twin ---------- */
    const twinEl = h('div', { class: 'test-twin' });
    let ctl = null, wantHl = null;
    const applyHl = () => { try { ctl?.setHighlight?.(wantHl ? [LINK[wantHl]] : []); } catch { /* the twin may not be ready yet */ } };
    function highlight(j) { wantHl = j; applyHl(); twinCap.textContent = j ? `Highlighted: the ${lower(j)} joint (motor ${JOINTS.indexOf(j) + 1}), ${WHERE[j]}.` : 'Click a part of the arm to jump to its motor. Drag to look around.'; }
    const twinCap = h('p', { class: 'muted twin-cap' }, '');

    /* ---------- one card per motor ---------- */
    const cards = new Map();
    function makeCard(id) {
      const name = NAME(id);
      const nameEl = h('h3', {}, JOINT_LABEL[name]);
      const stBadge = h('span', { class: 'badge' }, '…');
      const pos = h('b', {}, '—'), load = h('b', {}, '—'), temp = h('b', {}, '—');
      const res = h('div', { class: 'mres', role: 'status', hidden: true });
      const why = h('p', { class: 'why mwhy' });
      const ping = button('Ping', { icon: 'pulse', onClick: () => doPing(id) });
      const wig = button('Wiggle', { icon: 'play', onClick: () => askWiggle(id) });
      const card = h('article', { class: 'card mcard', id: 'motor-' + id, tabindex: '-1', 'data-id': id },
        h('header', { class: 'mhead' }, h('span', { class: 'mnum', 'aria-hidden': 'true' }, String(id)), h('div', { class: 'grow' }, h('div', { class: 'row mtitle' }, nameEl, h('span', { class: 'muted' }, `motor ${id}`)), h('p', { class: 'muted mwhere' }, `It sits ${WHERE[name]}.`)), stBadge),
        h('div', { class: 'mbody' }, h('figure', { class: 'mpic' }, jointPic(name)),
          h('dl', { class: 'mlive' }, h('div', {}, h('dt', {}, 'Position'), h('dd', {}, pos)), h('div', {}, h('dt', {}, term('load', 'Load')), h('dd', {}, load)), h('div', {}, h('dt', {}, term('temperature', 'Temp')), h('dd', {}, temp)))),
        h('div', { class: 'mact' }, h('div', { class: 'btns' }, ping, wig), why),
        res,
        h('p', { class: 'msee' }, h('span', { class: 'lbl' }, 'What you should see'), inline(SEE[name])),
        h('details', { class: 'mifnot' }, h('summary', {}, 'If it does not move, or does not answer'),
          h('div', { class: 'stack-sm' }, ifNotStrip(id),
            h('ol', { class: 'recov' },
              h('li', {}, rich(`<b>Cable:</b> push both ends of the 3-pin cable ${id === 1 ? 'between the board and motor 1' : `between motor ${id - 1} and motor ${id}`} in until each plug sits flush with its socket.`)),
              h('li', {}, rich('<b>Power:</b> push the power supply’s plug into the board until it stops, and check the wall plug.')),
              h('li', {}, rich(`<b>ID:</b> this motor must answer as ID ${id}. A new motor answers as ID 1 until you give it its number: open <a href="#/motors">Motor IDs</a>.`))))));
      card.addEventListener('mouseenter', () => { hover = name; refreshHl(); });
      card.addEventListener('mouseleave', () => { hover = null; refreshHl(); });
      card.addEventListener('focusin', () => { hover = name; refreshHl(); });
      card.addEventListener('focusout', (e) => { if (!card.contains(e.relatedTarget)) { hover = null; refreshHl(); } });
      const c = { id, name, card, nameEl, stBadge, pos, load, temp, res, why, ping, wig, last: {} };
      cards.set(id, c);
      return card;
    }
    const activeJoint = () => (busy?.id ? NAME(busy.id) : null);
    const refreshHl = () => { const j = activeJoint() || hover; if (j !== wantHl) highlight(j); };

    function setBtn(btn, why) {
      const off = !!why;
      btn.disabled = off; btn.setAttribute('aria-disabled', off ? 'true' : 'false'); btn.title = why || ''; btn.dataset.why = why || '';
    }
    function setText(el, v, c, k) { if (c.last[k] !== v) { c.last[k] = v; el.textContent = v; } }
    function setRes(id, kind, content, announceIt) {
      const c = cards.get(id); if (!c) return;
      c.res.hidden = false; c.res.className = 'mres ' + kind;
      c.res.replaceChildren(icon(kind === 'ok' ? 'check' : kind === 'bad' ? 'x' : kind === 'wait' ? 'info' : 'alert'), h('div', { class: 'grow' }, content));
      if (kind === 'wait') c.res.firstChild.replaceWith(h('span', { class: 'spin', 'aria-hidden': 'true' }));
      if (announceIt) announce(c.res.textContent);
    }

    /* ---------- live update (in place, never a rebuild) ---------- */
    function update() {
      const a = arm(), pose = a ? poseFromArm(a) : null, units = ctx.units;
      if (a && ctl?.setPose) ctl.setPose(pose);
      for (const c of cards.values()) {
        const j = joint(c.id), present = !!(a?.online && j), faults = a?.faults?.[c.name] || [];
        let status = ['Answers', 'ok'];
        if (!a) status = ['No arm', 'bad']; else if (!present) status = ['No answer', 'bad'];
        else if (faults.length) status = [`Fault: ${faults.join(', ')}`, 'bad'];
        else if (j.temp >= 65) status = ['Too hot', 'bad']; else if (j.temp >= 55) status = ['Warm', 'warn'];
        if (c.last.status !== status[0]) { c.last.status = status[0]; c.stBadge.textContent = status[0]; c.stBadge.className = 'badge ' + status[1]; c.card.classList.toggle('bad', status[1] === 'bad'); c.card.classList.toggle('warn', status[1] === 'warn'); }
        let p = '—';
        if (present && pose) {
          const v = units === 'norm' ? normalized(a, c.name) : pose[c.name];
          p = v == null ? '—' : c.name === 'gripper' && units !== 'norm' ? `${num(v)}% open` : units === 'norm' ? `${v > 0 ? '+' : ''}${num(v)}` : `${v > 0.5 ? '+' : ''}${num(v)}°`;
        }
        setText(c.pos, p, c, 'pos');
        setText(c.load, present && j.load != null ? `${num(Math.abs(j.load) / 10)}%` : '—', c, 'load');
        setText(c.temp, present && j.temp != null ? `${num(j.temp)} °C` : '—', c, 'temp');
        const wp = whyPing(c.id), ww = whyWiggle(c.id);
        if (c.last.wp !== wp) { c.last.wp = wp; setBtn(c.ping, wp); }
        if (c.last.ww !== ww) { c.last.ww = ww; setBtn(c.wig, ww); }
        const line = [wp && `Ping greyed out: ${wp}`, ww && `Wiggle greyed out: ${ww}`].filter(Boolean);
        const lt = ww === wp ? (ww ? `Ping and Wiggle greyed out: ${ww}` : '') : line.join(' · ');
        if (c.last.why !== lt) { c.last.why = lt; c.why.textContent = lt; c.why.hidden = !lt; }
      }
      const calibrated = !!a?.calibrated;
      if (noteBox.dataset.on !== String(!!a && !calibrated)) { noteBox.dataset.on = String(!!a && !calibrated); noteBox.replaceChildren(...(a && !calibrated ? [callout('tip', `This arm is not calibrated yet, so <b>0</b> is only a rough middle. <a href="#/calibrate">Calibrate</a> to make 0 the true middle of each joint. Ping and Wiggle work either way.`)] : [])); }
      setBtn(checkBtn, checkWhy());
      if (checkNote.textContent !== checkWhyText()) checkNote.textContent = checkWhyText();
      refreshHl();
    }

    /* ---------- Ping ---------- */
    async function doPing(id) {
      if (busy) return;
      busy = { id }; lastId = id; st.traceView = 'one'; setRes(id, 'wait', 'Asking motor ' + id + ' “are you there?”…'); update();
      try { const r = await api.post('/api/suite/motors', { action: 'ping', role: st.role, id }); showPing(id, r); }
      catch (e) { setRes(id, 'warn', `The app refused: ${e.message}`, true); }
      finally { busy = null; update(); pollTrace(); }
    }
    function showPing(id, r) {
      const a = arm(), name = NAME(id);
      if (!r.ok) {
        setRes(id, 'bad', h('div', {}, h('b', {}, `Motor ${id} did not answer. `), r.message?.replace(/^Motor \d did not answer\.\s*/, '') || 'Check its 3-pin cable and that the power supply is on.', h('div', { class: 'mlinks' }, h('a', { href: '#/motors' }, 'Open Motor IDs'), ' · ', h('a', { href: '#/help' }, 'Open Help'))), true);
        return;
      }
      const d = r.position != null ? degOf(a, name, r.position) : null;
      const where = d == null ? '' : name === 'gripper' ? ` It says it is at ${r.position} = ${num(d)}% open.` : ` It says it is at ${r.position} = ${num(d)}°.`;
      const temp = r.temp_c != null && r.temp_c >= 55 ? ` It is warm: ${num(r.temp_c)} °C.` : '';
      setRes(id, r.temp_c >= 65 ? 'warn' : 'ok', rich(`<b>Motor ${id} answered</b> in ${num(r.ms, 1)} ms.${where} Load ${num(r.load_pct)}%, ${num(r.temp_c)} °C${r.volt != null ? `, ${num(r.volt, 1)} V` : ''}. It did not move.${temp}`), true);
    }

    /* ---------- Wiggle ---------- */
    function askWiggle(id) {
      const w = whyWiggle(id); if (w) { toast(`<b>Wiggle is greyed out.</b> ${w}.`, 'warn'); return; }
      const j = lower(NAME(id));
      askYes(`<b>Keep your hands clear:</b> the ${j} joint will move about 10 degrees, slowly, there and back, in about 2 seconds. Keep your hair away from it too. A stiff arm holds itself while it moves, and a limp arm stays limp. Afterwards the joint is back where it was.`, `Yes, hands clear: wiggle motor ${id}`, safe(() => doWiggle(id)));
    }
    async function doWiggle(id) {
      if (busy) return;
      busy = { id }; lastId = id; st.traceView = 'one'; setRes(id, 'wait', `Motor ${id} is moving a little…`); update(); highlight(NAME(id));
      try { const r = await api.post('/api/suite/motors', { action: 'wiggle', role: st.role, id }); showWiggle(id, r); }
      catch (e) { setRes(id, 'warn', `The app refused: ${e.message}`, true); }
      finally { busy = null; update(); pollTrace(); }
    }
    function showWiggle(id, r) {
      if (r.ok) setRes(id, 'ok', rich(`<b>${r.message || `Motor ${id} moved ${num(r.moved_deg)} degrees. It works.`}</b> Peak load ${num(r.peak_load_pct)}%.`), true);
      else setRes(id, 'bad', h('div', {}, h('b', {}, r.message || `Motor ${id} did not move. Check its cable and power.`), h('div', { class: 'mlinks' }, h('a', { href: '#/motors' }, 'Open Motor IDs'), ' · ', h('a', { href: '#/help' }, 'Open Help'))), true);
    }

    /* ---------- Check all motors ---------- */
    const checkWhyText = () => checkWhy();
    function checkWhy() { if (busy) return busy.all ? 'The check is already running' : 'Another test is running: wait a moment'; if (!arm()) return `No ${st.role} arm found yet`; return whyNoMove(); }
    function startCheck() {
      const w = checkWhy(); if (w) { toast(`<b>Check all motors is greyed out.</b> ${w}.`, 'warn'); return; }
      askYes('<b>Keep your hands clear:</b> this asks all six motors “are you there?”, then moves each joint about 10 degrees, one after another, for about 30 seconds. Keep your hands and hair away from the arm until the report appears. A stiff arm holds itself while it moves, and a limp arm stays limp.', 'Yes, hands clear: check all motors', safe(runAll));
    }
    const checkBtn = button('Check all motors', { kind: 'primary', size: 'lg', icon: 'pulse', onClick: startCheck });
    const checkNote = h('p', { class: 'why' });
    const noteBox = h('div'), reportBox = h('div');
    async function runAll() {
      if (busy) return;
      cancel = false; busy = { all: true }; st.report = null; st.traceView = 'all';
      const prog = progressCard();
      reportBox.replaceChildren(prog.el); update();
      const results = IDS.map((id) => ({ id, name: NAME(id), tested: false, answered: false, ping: null, wiggle: null }));
      let abort = '';
      try {
        for (const r of results) {
          if (cancel) break;
          prog.set('Asking', r.id, 0); busy.id = r.id; lastId = r.id; setRes(r.id, 'wait', `Asking motor ${r.id}…`);
          try { r.ping = await api.post('/api/suite/motors', { action: 'ping', role: st.role, id: r.id }); r.answered = !!r.ping.ok; r.tested = true; showPing(r.id, r.ping); }
          catch (e) { abort = e.message; break; }
        }
        if (!abort && !cancel && results.some((r) => r.answered)) {
          for (const r of results) {
            if (cancel) break;
            if (!r.answered) continue;
            prog.set('Wiggling', r.id, 1); busy.id = r.id; highlight(r.name); setRes(r.id, 'wait', `Motor ${r.id} is moving a little…`); update();
            try { r.wiggle = await api.post('/api/suite/motors', { action: 'wiggle', role: st.role, id: r.id }); showWiggle(r.id, r.wiggle); }
            catch (e) { abort = e.message; break; }
          }
        }
      } finally { busy = null; }
      st.report = { results, abort, cancelled: cancel, at: Date.now() };
      drawReport(); update(); pollTrace();
      const bad = results.filter((r) => problemOf(r)).length;
      announce(abort ? 'The check stopped: ' + abort : cancel ? 'Check stopped.' : bad ? `${bad} of 6 motors need attention.` : 'All six motors are healthy.');
    }
    function progressCard() {
      const bar = h('i'), text = h('b', {}), sub = h('span', { class: 'muted' }, '');
      const stop = button('Stop checking', { kind: 'ghost', size: 'sm', onClick: () => { cancel = true; stop.disabled = true; stop.textContent = 'Stopping after this motor…'; } });
      const el = h('div', { class: 'card tcheck' }, h('div', { class: 'row-between' }, h('div', { class: 'row' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), text, sub), stop), h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Check progress', 'aria-valuemin': '0', 'aria-valuemax': '12' }, bar));
      return { el, set(what, n, phase) { const k = phase * 6 + n; text.textContent = `${what} motor ${n} of 6`; sub.textContent = phase ? 'This joint moves about 10 degrees. Keep your hands clear.' : 'Nothing moves yet. Keep your hands clear.'; bar.style.width = `${Math.round(((k - 0.5) / 12) * 100)}%`; el.querySelector('.bar').setAttribute('aria-valuenow', String(k)); announce(`${what} motor ${n} of 6`); } };
    }
    /** null when healthy, else {title, text, fix:[[label, href]], kind} */
    function problemOf(r) {
      if (!r.tested) return null;
      if (!r.answered) return { kind: 'bad', title: 'No answer', text: r.ping?.message || `Motor ${r.id} did not answer. Check its 3-pin cable and that the power supply is on.`, fix: [['Open Motor IDs', '#/motors'], ['Open Help', '#/help']] };
      if (r.wiggle && !r.wiggle.ok) return { kind: 'bad', title: 'Answers but does not move', text: r.wiggle.message || `Motor ${r.id} did not move.`, fix: [['Open Help', '#/help']] };
      if (!r.wiggle) return null;
      if (r.ping?.temp_c >= 55) return { kind: 'warn', title: 'Works, but warm', text: `It moved, but it is at ${num(r.ping.temp_c)} °C. Let it rest for 5 minutes before the next long run.`, fix: [['Read about hot motors', '#/help']] };
      return null;
    }
    function drawReport() {
      const rep = st.report; if (!rep) { reportBox.replaceChildren(); return; }
      const { results, abort, cancelled } = rep;
      const probs = results.filter((r) => problemOf(r)?.kind === 'bad'), warns = results.filter((r) => problemOf(r)?.kind === 'warn');
      const none = results.every((r) => r.tested && !r.answered);
      let title, kind;
      if (abort) { title = 'The check stopped'; kind = 'warn'; }
      else if (cancelled) { title = 'You stopped the check'; kind = 'warn'; }
      else if (!probs.length && !warns.length) { title = 'All six motors are healthy'; kind = 'ok'; }
      else if (none) { title = 'No motor answers'; kind = 'bad'; }
      else { title = `${probs.length || warns.length} of 6 motors need attention`; kind = probs.length ? 'bad' : 'warn'; }
      const rows = results.map((r) => {
        const p = problemOf(r), ok = !p && r.wiggle?.ok, skip = !p && !ok;
        const state = p ? p.kind : ok ? 'ok' : 'skip';
        return h('li', { class: 'trow ' + state },
          h('span', { class: 'tstate', 'aria-hidden': 'true' }, icon(state === 'ok' ? 'check' : state === 'bad' ? 'x' : state === 'warn' ? 'alert' : 'info')),
          h('div', { class: 'grow' }, h('div', { class: 'row' }, h('b', {}, `Motor ${r.id} · ${JOINT_LABEL[r.name]}`), badge(p ? p.title : ok ? 'OK' : r.tested ? 'Not wiggled' : 'Not tested', p ? p.kind : ok ? 'ok' : ''), h('button', { class: 'link', type: 'button', onclick: () => jump(r.id) }, 'Show card')),
            h('div', { class: 'muted trow-d' }, p ? p.text : ok ? `${r.wiggle.message || 'It moved.'} Peak load ${num(r.wiggle.peak_load_pct)}%.` : r.tested ? 'It answered, but the check stopped before it wiggled.' : 'The check stopped before this motor was asked.'),
            p?.kind === 'bad' ? h('div', { class: 'stack-sm trow-x' }, ifNotStrip(r.id), h('div', { class: 'row' }, p.fix.map(([l, href]) => button(l, { size: 'sm', href })))) : p ? h('div', { class: 'row trow-x' }, p.fix.map(([l, href]) => button(l, { size: 'sm', kind: 'ghost', href }))) : null));
      });
      reportBox.replaceChildren(h('section', { class: 'card treport ' + kind, 'aria-label': 'Report' },
        h('div', { class: 'row' }, icon(kind === 'ok' ? 'check' : kind === 'bad' ? 'x' : 'alert'), h('div', { class: 'grow' }, h('h2', {}, title), h('p', { class: 'muted' }, abort ? `The app said: ${abort}` : none ? `Not one motor of the ${st.role} arm answered. Check the USB cable and the power supply first.` : cancelled ? `${results.filter((r) => r.wiggle).length} of 6 motors were wiggled before you stopped.` : `Checked just now, the ${st.role} arm.`)),
          none || abort ? button('Open Setup check', { size: 'sm', href: '#/setup' }) : null),
        h('ul', { class: 'trows' }, rows),
        h('div', { class: 'row' }, button('Check again', { size: 'sm', onClick: startCheck }), button('Clear this report', { size: 'sm', kind: 'ghost', onClick: () => { st.report = null; reportBox.replaceChildren(); } }))));
    }
    function jump(id) { const c = cards.get(id); if (!c) return; c.card.scrollIntoView({ block: 'center', behavior: 'smooth' }); c.card.focus({ preventScroll: true }); c.card.classList.remove('flash'); void c.card.offsetWidth; c.card.classList.add('flash'); }

    /* ---------- "what the app and the motor said" ---------- */
    const traceBox = h('div', { class: 'stack-sm' });
    function sayBus(it, a) {
      const id = it.id, name = id >= 1 && id <= 6 ? NAME(id) : null, bad = it.ok === false || it.err;
      const pos = (v) => (name ? (name === 'gripper' ? `${num(degOf(a, name, v))}% open` : `${num(degOf(a, name, v))}°`) : '');
      if (it.op === 'ping') return bad ? `The app asked motor ${id} “are you there?” It did not answer (it waited ${num(it.ms)} ms).` : `The app asked motor ${id} “are you there?” It answered.`;
      const reg = it.addr, v = it.value;
      if (it.op?.startsWith('read')) {
        if (bad) return `The app tried to read the ${REG[reg] || it.reg || 'register ' + reg} of motor ${id}. No answer.`;
        if (reg === 56) return `The app asked motor ${id} where it is. It answered ${v} = ${pos(v)}.`;
        if (reg === 60) return `The app asked motor ${id} how hard it is pushing. It answered ${num((v & 1023) / 10)}% (load).`;
        if (reg === 63) return `The app asked motor ${id} how warm it is. It answered ${v} °C.`;
        if (reg === 62) return `The app asked motor ${id} for its voltage. It answered ${num(v / 10, 1)} V.`;
        if (reg === 65) return `The app asked motor ${id} if anything is wrong. It answered ${v ? 'fault code ' + v : 'all fine'}.`;
        return `The app read the ${REG[reg] || it.reg || 'register ' + reg} of motor ${id}: ${v}.`;
      }
      if (reg === 40) return `The app told motor ${id} to ${v ? 'hold its position (power on)' : 'go limp (power off)'}.`;
      if (reg === 42) return `The app told motor ${id} to go to ${v} = ${pos(v)}.`;
      if (reg === 5) return `The app told motor ${id} to change its ID to ${v}.`;
      if (reg === 6) return `The app set the speed setting of motor ${id}.`;
      if (reg === 55) return `The app ${v ? 'locked' : 'unlocked'} the memory of motor ${id}.`;
      return `The app wrote ${v} to the ${REG[reg] || it.reg || 'register ' + reg} of motor ${id}.`;
    }
    const touched = (el) => [...el.querySelectorAll(':hover')].some((e) => e.matches('button, a, .btn'));
    function renderTrace(force) {
      const t = st.trace;
      if (!force && touched(traceBox)) return;
      if (t.err) { traceBox.replaceChildren(callout('warn', `${t.err} The rest of this page still works.`, 'Could not read the message log')); return; }
      if (t.enabled === null) { traceBox.replaceChildren(skeleton('100%', 40)); return; }
      if (!t.enabled) {
        traceBox.replaceChildren(h('div', { class: 'row tr-off' }, icon('terminal'), h('span', { class: 'grow' }, rich('Recording is off, so there is nothing to show. <b>Turn on the Inspector</b> to see this.')),
          button('Open the Inspector', { size: 'sm', href: '#/inspector' }),
          button('Turn on recording here', { size: 'sm', onClick: () => askYes('<b>Turn on recording?</b> It remembers what the app and the motors say to each other: motor numbers, register numbers, values, web addresses and status codes. It stays on this computer, in memory (the last 5,000 entries). Nothing is sent anywhere. You can turn it off in the Inspector.', 'Yes, turn on recording', safe(async () => { await api.post('/api/suite/trace', { enabled: true }); st.trace.enabled = true; toast('<b>Recording is on.</b> Press Ping or Wiggle to see messages here.', 'ok'); pollTrace(); })) })));
        return;
      }
      const a = arm();
      const only = st.traceView === 'one' && lastId ? lastId : null;
      const groups = [];
      for (const g of t.groups) {
        if (!g.routine && only && g.id !== only) continue;
        const prev = groups[groups.length - 1];
        if (g.routine && prev?.routine) groups[groups.length - 1] = { ...prev, n: prev.n + g.n };    // merge runs that were split by other motors' lines
        else groups.push(g);
      }
      const shown = groups.slice(-10);
      traceBox.replaceChildren(
        h('div', { class: 'row-between' }, h('span', { class: 'muted' }, only ? `Showing what was said to motor ${only}.` : 'Showing every motor.'),
          lastId ? button(only ? 'Show all motors' : `Show only motor ${lastId}`, { size: 'sm', kind: 'ghost', onClick: () => { st.traceView = only ? 'all' : 'one'; renderTrace(true); } }) : null),
        shown.length ? h('ol', { class: 'tlines', 'aria-label': 'Recent messages between the app and the motors' }, shown.map((g) => h('li', { class: (g.ok === false ? 'bad ' : '') + (g.routine ? 'routine' : '') },
          h('span', { class: 'ts', 'aria-hidden': 'true' }, g.ok === false ? '✗' : g.routine ? '…' : '›'),
          h('span', { class: 'grow' }, g.routine ? `Meanwhile, the app kept reading every motor’s position, load and temperature (${g.n > 999 ? 'over 1,000' : g.n} messages: it does this about 10 times a second).` : sayBus(g.last, a), !g.routine && g.n > 3 ? h('span', { class: 'muted' }, ` (${g.n} times)`) : null),
          g.routine ? null : h('span', { class: 'ms muted' }, `${num(g.last.ms, 1)} ms`))))
          : h('p', { class: 'muted' }, 'No messages yet. Press Ping or Wiggle on a card and they appear here.'));
    }
    /** The app reads every motor's position, load and temperature about 10 times a second. That is routine noise for a beginner:
     *  fold it into one line, but keep the reads that answer a Ping (they are the conversation they asked for). */
    function ingest(items) {
      const t = st.trace;
      for (const it of items) {
        if (it.kind !== 'bus') continue;
        let routine = !!(it.op?.startsWith('read') && ROUTINE.has(it.addr));
        if (it.op === 'ping') t.left[it.id] = 4; else if (routine && t.left[it.id] > 0) { t.left[it.id]--; routine = false; }
        const g = t.groups[t.groups.length - 1];
        if (routine && g?.routine) { g.n++; g.last = it; }
        else if (!routine && g && !g.routine && g.op === it.op && g.id === it.id && g.addr === it.addr && g.ok === it.ok) { g.n++; g.last = it; }
        else t.groups.push({ routine, op: it.op, id: it.id, addr: it.addr, ok: it.ok, n: 1, last: it });
      }
      if (t.groups.length > 120) t.groups.splice(0, t.groups.length - 120);
    }
    async function pollTrace() {
      clearTimeout(timers.trace);
      let more = false;
      try {
        const t = st.trace, first = !t.enabled || !t.seq;
        const r = await api.get(`/api/suite/trace?kinds=bus&limit=500${first ? '' : `&since=${t.seq}`}`);
        if (!alive) return;
        const before = `${t.enabled}|${t.seq}`;
        t.err = '';
        if (!r.enabled) { t.enabled = false; t.groups = []; t.left = {}; t.seq = 0; }
        else {
          t.enabled = true;
          const items = r.items || [];
          if (first) { t.groups = []; t.left = {}; }
          ingest(items);
          t.seq = items.length ? items[items.length - 1].seq : first ? (r.seq ?? 0) : t.seq;
          more = !first && items.length >= 500;
        }
        if (before !== `${t.enabled}|${t.seq}` || !t.initial) { t.initial = true; renderTrace(); }
      } catch (e) { if (!alive) return; st.trace.err = `${e.message}`; st.trace.enabled = st.trace.enabled ?? false; renderTrace(); }
      if (alive) timers.trace = setTimeout(pollTrace, more ? 50 : document.hidden ? 4000 : 1500);
    }

    /* ---------- the arm picker, empty state, page ---------- */
    const pickBox = h('div'), bodyBox = h('div', { class: 'stack-lg' });
    let both = null, hasArm = null;
    function drawPicker() {
      const f = ctx.arm('follower'), l = ctx.arm('leader'), nb = !!(f && l);
      if (nb === both) return; both = nb;
      if (!nb) { pickBox.replaceChildren(); if (!arm() && (f || l)) { st.role = f ? 'follower' : 'leader'; } return; }
      const mk = (r) => h('button', { type: 'button', 'aria-pressed': st.role === r ? 'true' : 'false', 'data-role': r, onclick: () => { if (busy) { toast('Wait for the running test to finish first.', 'warn'); return; } st.role = r; st.report = null; reportBox.replaceChildren(); cards.forEach((c) => { c.res.hidden = true; c.last = {}; }); pickBox.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.role === r))); update(); } }, `${cap(r)} arm`);
      pickBox.replaceChildren(h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Which arm?'), h('div', { class: 'seg', role: 'group', 'aria-label': 'Which arm to test' }, mk('follower'), mk('leader'))));
    }
    function drawBody() {
      const any = !!(ctx.arm('follower') || ctx.arm('leader'));
      if (any === hasArm) return; hasArm = any;
      if (!any) { bodyBox.replaceChildren(empty('No arm found yet', 'The app does not see an arm, so there is nothing to test. Plug in the USB cable of the arm’s board and its power supply: the app finds it by itself. <br>Not set up yet? The Setup check shows what is missing.', h('div', { class: 'row' }, button('Open Setup check', { kind: 'primary', href: '#/setup', icon: 'arrow' }), button('Open Motor IDs', { href: '#/motors' })))); return; }
      const cardsEl = IDS.map(makeCard);
      bodyBox.replaceChildren(h('div', { class: 'test-grid' },
        h('aside', { class: 'test-side' }, twinEl, twinCap),
        h('div', { class: 'stack' }, h('div', { class: 'card tcard stack-sm' }, h('div', { class: 'row-between' }, h('div', {}, h('h2', {}, 'Check all six'), h('p', { class: 'muted' }, 'Asks every motor if it is there, then wiggles each joint a little. About 30 seconds.')), checkBtn), checkNote, noteBox), reportBox, ...cardsEl)),
        h('section', { class: 'stack-sm tsec' }, h('h2', {}, 'What the app and the motor said'), h('p', { class: 'muted' }, 'Every Ping and Wiggle is a short conversation. Here it is in plain words, so you can see what the app asked and what the motor answered.'), traceBox));
      if (!ctl) { ctl = mountTwin(twinEl, { view: 'hero', interactive: true, onPick: (link) => { const j = JOINT_OF_LINK[link]; if (j) jump(JOINTS.indexOf(j) + 1); } }); ctl.ready?.then(() => { applyHl(); update(); }); highlight(null); }
      renderTrace(); update();
    }

    root.append(h('div', { class: 'stack-lg testpage' },
      h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Debug'), h('h1', {}, 'Is my arm healthy?'),
        h('p', { class: 'lead' }, rich('Every motor can be asked two things. <b>Ping</b> asks “are you there?” and never moves anything. <b>Wiggle</b> makes one joint move a little, so you can see it work. Nothing happens until you press a button.'))),
      pickBox, bodyBox, live));

    const off = ctx.subscribe(() => { drawPicker(); drawBody(); update(); });
    pollTrace();
    return () => { alive = false; off(); clearTimeout(timers.trace); ctl?.destroy?.(); };
  },
};
