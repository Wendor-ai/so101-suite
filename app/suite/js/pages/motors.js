// Motor IDs: (1) find the USB servo boards, (2) say which board is the follower and which the leader,
// (3) give brand-new motors their IDs, ONE motor at a time. Step 3 is skipped when a scan shows IDs 1 to 6 already answer.
// Everything physical goes through stepCard/preflight with a diagram (docs/design/physical-instructions.md).
import { h, icon, button, actions, badge, callout, empty, skeleton, toast as toastBase, askYes, rich, term, loadCss } from '../ui.js';
import { stepCard, preflight, progressCue } from '../steps.js';
import * as dg from '../diagrams/motors.js';

loadCss(new URL('../../css/pages/motors.css', import.meta.url).href);

// ui.js's toast() lays its message out as a flex row, which splits "<b>Title.</b> text" into separate columns.
// Wrapping the message in one <div> keeps it as ordinary text. (safe() does the same job as ui.js's, with that wrapper.)
const toast = (msg, level, ms) => toastBase(typeof msg === 'string' ? h('div', {}, rich(msg)) : msg, level, ms);
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(`<b>That did not work.</b> ${String(e.message || e)}`, 'err'); } };

const ORDER = [6, 5, 4, 3, 2, 1];                                  // the official order: gripper first, shoulder pan last
const JT = {
  6: { name: 'Gripper', does: 'opens and closes the jaw' },
  5: { name: 'Wrist roll', does: 'twists the hand' },
  4: { name: 'Wrist flex', does: 'tips the hand up and down' },
  3: { name: 'Elbow flex', does: 'bends the forearm' },
  2: { name: 'Shoulder lift', does: 'tips the upper arm forward and back' },
  1: { name: 'Shoulder pan', does: 'turns the whole arm left and right' },
};
const CODE = { follower: { 1: 'C001', 2: 'C001', 3: 'C001', 4: 'C001', 5: 'C001', 6: 'C001' }, leader: { 1: 'C044', 2: 'C001', 3: 'C044', 4: 'C046', 5: 'C046', 6: 'C046' } };
const STEPS = [['boards', 'Find your boards', 'Plug in, see them here'], ['which', 'Which arm is which', 'Follower or leader'], ['ids', 'Set the motor IDs', 'New motors only']];
const SEC_OF = { boards: 'boards', which: 'which', identify: 'which', ids: 'ids', 'set-ids': 'ids' };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const list = (a) => (a.length ? a.join(', ') : 'none');
const touched = (el) => !!el && [...el.querySelectorAll(':hover')].some((e) => e.matches('button, a, .btn, select'));

export default {
  id: 'motors', title: 'Motor IDs',
  render(root, ctx, route) {
    const api = ctx.api;
    let alive = true;
    const timers = {};
    const st = {
      sec: SEC_OF[route.args[0]] || 'boards', ports: null, portsSig: '', portsErr: '', fresh: new Set(), plat: null,
      arm: route.query.get('role') === 'leader' ? 'leader' : 'follower', port: null,
      idn: { state: 'idle', message: '', port: null, role: null },
      flow: { started: false, k: 0, done: { follower: new Set(), leader: new Set() }, finished: { follower: false, leader: false }, scan: null, busy: '', err: '' },
      pre: null, preBusy: false, live: {},
    };
    const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    const announce = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 40); };
    const demo = () => !!(ctx.info?.demo || api.demo);
    const roleOf = (p) => p.role || ['follower', 'leader'].find((r) => { const a = ctx.arm(r); return a && a.port === p.path; }) || null;
    const roleBadge = (r) => (r === 'follower' ? badge('Follower', 'info') : r === 'leader' ? badge('Leader', 'accent') : badge('No role yet', ''));
    const portByPath = (path) => st.ports?.find((p) => p.path === path) || null;
    const afterIds = () => (ctx.checklist?.items?.find((i) => i.id === 'assembly_done')?.status === 'ok' ? ['Calibrate', '#/calibrate'] : ['Assemble', '#/assemble']);

    /* ================= page frame ================= */
    const secBox = h('div', { class: 'stack-lg' });
    const stepper = h('ol', { class: 'stepper msteps', 'aria-label': 'The three parts of this page' });
    const stepBtns = STEPS.map(([id, title, sub], i) => {
      const b = h('button', { type: 'button', class: 'mstep', onclick: () => go(id) }, h('span', { class: 'n', 'aria-hidden': 'true' }, String(i + 1)), h('span', {}, h('b', {}, title), h('small', {}, sub)));
      stepper.append(h('li', { 'data-sec': id }, b));
      return b;
    });
    function updateStepper() {
      const ports = st.ports || [];
      const done = { boards: ports.length > 0, which: ports.length > 0 && ports.every((p) => roleOf(p)), ids: st.flow.done.follower.size === 6 || st.flow.done.leader.size === 6 || ctx.checklist?.items?.find((i) => i.id === 'follower_motors')?.status === 'ok' };
      [...stepper.children].forEach((li, i) => {
        const id = STEPS[i][0];
        li.className = (st.sec === id ? 'cur ' : '') + (done[id] ? 'done' : '');
        stepBtns[i].setAttribute('aria-current', st.sec === id ? 'step' : 'false');
        stepBtns[i].querySelector('.n').replaceChildren(done[id] ? icon('check') : String(i + 1));
      });
    }
    function go(sec, scroll = true) {
      st.sec = sec; st.live = {};
      clearTimeout(timers.idn);
      ({ boards: drawBoards, which: drawWhich, ids: drawIds })[sec]();
      updateStepper();
      if (scroll) stepper.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    const nav = (back, next) => h('div', { class: 'row-between mnav' }, back ? button(back[0], { kind: 'ghost', icon: 'back', onClick: () => go(back[1]) }) : h('span'), next);

    /* ================= ports ================= */
    async function loadPorts(force) {
      let list_;
      try { list_ = (await api.get('/api/suite/ports'))?.ports || []; st.portsErr = ''; }
      catch (e) { st.portsErr = e.message || String(e); list_ = st.ports || []; }
      if (!alive) return;
      const sig = JSON.stringify([st.portsErr, list_.map((p) => [p.path, p.role, p.owned_by_app, p.likely_servo_board, p.description])]);
      if (sig === st.portsSig && !force) return;
      if (!force && touched(secBox)) return;
      const prev = st.ports;
      st.ports = list_; st.portsSig = sig;
      st.fresh = new Set(prev ? list_.filter((p) => !prev.some((q) => q.path === p.path)).map((p) => p.path) : []);
      if (!st.port || !portByPath(st.port)) st.port = (list_.find((p) => roleOf(p) === st.arm) || list_[0])?.path || null;
      st.live.onPorts?.();
      updateStepper();
    }
    async function loadPlatform() { try { st.plat = await api.get('/api/suite/platform'); st.live.onPlat?.(); } catch { st.plat = null; } }

    /* ================= (1) find your boards ================= */
    function drawBoards() {
      const box = h('div', { class: 'stack-sm' }), navBox = h('div');
      let navOk = null;
      const render = () => {
        const ports = st.ports;
        if (ports === null) { box.replaceChildren(skeleton('100%', 64)); return; }
        if (st.portsErr) {
          box.replaceChildren(callout('warn', `${st.portsErr} The list updates by itself, or press <b>Look again</b>.`, 'Could not list the boards'));
        } else if (!ports.length) {
          const ex = st.plat?.serial_examples?.length ? ` On this computer a board is named like ${st.plat.serial_examples.map((x) => `<code>${x}</code>`).join(' or ')}.` : '';
          box.replaceChildren(empty('No board found yet', `Plug the USB cable of a board into this computer and plug in its power supply. This list updates by itself every few seconds.${ex}`));
        } else {
          box.replaceChildren(...ports.map((p) => h('div', { class: 'brd' + (st.fresh.has(p.path) ? ' fresh' : '') }, icon('usb'),
            h('div', { class: 'grow' }, h('div', { class: 'row brd-top' }, h('code', {}, p.path), roleBadge(roleOf(p)), st.fresh.has(p.path) ? badge('Just appeared', 'ok') : null),
              h('div', { class: 'muted brd-sub' }, [p.description || p.manufacturer || 'USB serial device', p.vid != null ? `USB ${p.vid.toString(16).padStart(4, '0')}:${(p.pid ?? 0).toString(16).padStart(4, '0')}` : null].filter(Boolean).join(' · '))),
            h('div', { class: 'row brd-badges' }, p.likely_servo_board ? badge('Looks like a servo board', 'ok') : badge('Not sure it is a servo board', ''), p.owned_by_app ? badge('Used by this app', 'info') : null))));
        }
        const ok = !!ports?.length;
        if (ok !== navOk) { navOk = ok; navBox.replaceChildren(nav(null, button('Next: Which arm is which', { kind: 'primary', icon: 'arrow', why: ok ? '' : 'No board found yet. Plug one in and it appears above', onClick: () => go('which') }))); }
      };
      st.live.onPorts = render; st.live.onPlat = render;
      render();
      secBox.replaceChildren(
        h('section', { class: 'stack' }, h('div', {}, h('h2', {}, '1. Find your boards'), h('p', { class: 'muted' }, rich('A board links the computer to the motors, and each arm has one. Plug in the one you want to use. It shows up in the list below, as its own '), term('port', 'port'), '.')),
          dg.connectBoardCard(),
          h('div', { class: 'stack-sm' }, h('div', { class: 'row-between' }, h('h3', {}, 'Boards found'), button('Look again', { size: 'sm', icon: 'checks', onClick: safe(async () => { await loadPorts(true); toast(st.ports?.length ? `<b>${st.ports.length} board${st.ports.length > 1 ? 's' : ''} found.</b>` : 'No board yet. Check the USB cable and the power supply.', st.ports?.length ? 'ok' : 'warn', 2800); }) })), box),
          navBox));
    }

    /* ================= (2) which arm is which ================= */
    function drawWhich() {
      const rolesBox = h('div', { class: 'stack-sm' }), idBox = h('div'), swapBox = h('div'), navBox = h('div');
      let rowsSig = null, swapOn = null, navOk = null;
      const renderRoles = () => {
        const ports = st.ports || [], sig = ports.map((p) => p.path).join('|');
        if (sig !== rowsSig && !touched(rolesBox)) {
          rowsSig = sig;
          if (!ports.length) rolesBox.replaceChildren(empty('No board found yet', 'Go back to step 1 and plug a board in. Then it shows up here.', button('Back to step 1', { size: 'sm', icon: 'back', onClick: () => go('boards') })));
          else rolesBox.replaceChildren(...ports.map((p) => h('div', { class: 'role-row' }, h('div', { class: 'grow' }, h('code', {}, p.path), h('div', { class: 'muted brd-sub' }, p.description || '')),
            h('div', { class: 'seg', role: 'group', 'aria-label': `Which arm is the board on ${p.path}` }, ['follower', 'leader'].map((r) =>
              h('button', { type: 'button', 'data-port': p.path, 'data-role': r, 'aria-pressed': 'false', onclick: () => changeRole(p, r) }, cap(r)))))));
        }
        for (const b of rolesBox.querySelectorAll('button[data-port]')) b.setAttribute('aria-pressed', String(roleOf(portByPath(b.dataset.port) || {}) === b.dataset.role));
        const f_ = ports.find((p) => roleOf(p) === 'follower'), l_ = ports.find((p) => roleOf(p) === 'leader'), both = !!(f_ && l_);
        if (both !== swapOn) { swapOn = both; swapBox.replaceChildren(both ? button('Swap leader and follower', { size: 'sm', icon: 'checks', onClick: () => swapRoles(ports.find((p) => roleOf(p) === 'follower') || f_, ports.find((p) => roleOf(p) === 'leader') || l_) }) : ''); }
        const ok = !!ports.length;
        if (ok !== navOk) { navOk = ok; navBox.replaceChildren(nav(['Back', 'boards'], button('Next: Set the motor IDs', { kind: 'primary', icon: 'arrow', why: ok ? '' : 'No board found yet', onClick: () => go('ids') }))); }
      };
      let idleOk = null;
      st.live.onPorts = () => {
        renderRoles();
        const ok = !!st.ports?.length;                                    // the idle buttons say "no board yet" until a board shows up
        if (st.idn.state === 'idle' && ok !== idleOk && !touched(idBox)) { idleOk = ok; drawIdentify(idBox); }
      };
      drawIdentify(idBox);
      renderRoles();
      secBox.replaceChildren(h('section', { class: 'stack' },
        h('div', {}, h('h2', {}, '2. Which arm is which'),
          h('p', { class: 'muted' }, rich('Two boards look the same to the computer, so the app asks you once: you pull one USB cable out and push it back in, and the app sees which port blinked. It takes about 20 seconds. Skip this if you have only one board: it is your follower.'))),
        h('figure', { class: 'card flat lf-fig' }, dg.leaderFollower(), h('figcaption', {}, rich('Side view, both arms from the same side. The <b>follower</b> has a gripper with two jaws and does the work. The <b>leader</b> has a handle with a trigger: you hold it and move it by hand, and the follower copies you.'))),
        h('section', { class: 'stack-sm' }, h('h3', {}, 'Your boards'), rolesBox, swapBox,
          h('p', { class: 'why' }, 'Already know which is which? Press the button in the row to set it by hand. Nothing moves when you do.')),
        h('section', { class: 'stack-sm' }, h('h3', {}, 'Find a board by unplugging it'), idBox),
        navBox));
      resumeIdentify(idBox);
    }
    async function changeRole(p, role) {
      if (roleOf(p) === role) return;
      const go_ = safe(async () => { await api.post('/api/suite/role', { port: p.path, role }); await loadPorts(true); ctx.refresh(); toast(`<b>Done.</b> <code>${p.path}</code> is now the ${role} arm.`, 'ok'); announce(`${p.path} is now the ${role} arm`); });
      if (roleOf(p)) askYes(`Change <b>${p.path}</b> from the ${roleOf(p)} arm to the <b>${role}</b> arm? Nothing moves now. If you get it backwards, the wrong arm moves when you start Control.`, `Yes, make it the ${role}`, go_);
      else go_();
    }
    function swapRoles(f, l) {
      askYes('Swap the two boards? The follower board becomes the leader and the leader board becomes the follower. Nothing moves now.', 'Yes, swap them', safe(async () => {
        await api.post('/api/suite/role', { port: f.path, role: 'leader' });
        await loadPorts(true);
        const again = portByPath(l.path);
        if (again && roleOf(again) !== 'follower') await api.post('/api/suite/role', { port: l.path, role: 'follower' });
        await loadPorts(true); ctx.refresh();
        toast('<b>Swapped.</b> Check it in Control before you start the arm.', 'ok');
      }));
    }

    /* ----- the unplug / replug flow ----- */
    const roleFromMsg = (m) => (/leader/i.test(m || '') ? 'leader' : /follower/i.test(m || '') ? 'follower' : null);
    function checkRow(state, text) { return h('div', { class: 'chk ' + state }, state === 'ok' ? icon('check') : h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', {}, rich(text))); }
    function drawIdentify(box) {
      const { state, message, port } = st.idn, role = st.idn.role || roleFromMsg(message) || st.arm;
      if (state === 'unplug') {
        box.replaceChildren(stepCard({
          n: 1, total: 2, title: `Unplug the ${role} arm’s USB cable`,
          where: `The USB cable that runs from the ${role} arm’s board to your computer: the green cable in the picture. At the board it goes into the USB socket.`,
          do: [`Pull the USB plug out of the ${role} arm’s board.`],
          how: 'Hold the plug by its sides and pull straight out. Do not pull on the cable. Leave the power plug and the motor cables where they are.',
          know: dg.inline('The check below turns green: <b>I see it: port removed</b>.'),
          ifNot: dg.inline(`Nothing changes after 10 seconds? Make sure it is the cable of the ${role} arm. Or press <b>Cancel</b> and start again.`),
          diagram: dg.unplugUsb(), caption: 'Top view, you sit at the bottom. Pull out only the green cable. The red crosses mean: leave those in.',
          footer: h('div', { class: 'idfoot' }, checkRow('wait', 'Waiting for the port to disappear…'), actions([button('Cancel', { kind: 'ghost', onClick: cancelIdentify })])),
        }));
      } else if (state === 'replug') {
        box.replaceChildren(stepCard({
          n: 2, total: 2, title: 'Plug the same cable back in',
          where: `The USB plug you just pulled out, and the USB socket on the ${role} arm’s board where it came from.`,
          do: ['Push the USB plug back into the same USB socket until it stops.'],
          how: 'Push it straight in. It only fits one way round.',
          know: dg.inline('The check turns green: <b>I see it: port found</b>, and this card says Done.'),
          ifNot: dg.inline('Wait 5 seconds. Still nothing? Try another USB port on your computer.'),
          diagram: dg.replugUsb(), caption: 'Top view, you sit at the bottom. The green cable goes back into the same socket.',
          footer: h('div', { class: 'idfoot' }, checkRow('ok', `<b>I see it: port removed</b>${port ? ` (<code>${port}</code> is gone)` : ''}.`), checkRow('wait', 'Waiting for the port to come back…'), actions([button('Cancel', { kind: 'ghost', onClick: cancelIdentify })])),
        }));
      } else if (state === 'done') {
        box.replaceChildren(h('div', { class: 'stack-sm' },
          callout('ok', `The board${port ? ` on <code>${port}</code>` : ''} is now the <b>${role} arm</b>. You can let go.`, 'Done'),
          h('div', { class: 'row' }, button('Find the other arm', { onClick: () => { st.idn = { state: 'idle', message: '', port: null, role: null }; api.post('/api/suite/identify', { action: 'cancel' }).catch(() => {}); st.arm = role === 'follower' ? 'leader' : 'follower'; drawIdentify(box); } }),
            button('Next: Set the motor IDs', { kind: 'primary', icon: 'arrow', onClick: () => go('ids') }))));
      } else if (state === 'error') {
        box.replaceChildren(h('div', { class: 'stack-sm' }, callout('warn', message || 'The app could not find the board.', 'That did not work'),
          h('div', { class: 'row' }, button('Try again', { kind: 'primary', onClick: () => startIdentify(role) }), button('Back to step 1', { kind: 'ghost', icon: 'back', onClick: () => go('boards') }))));
      } else {
        const none = !st.ports?.length;
        const btns = ['follower', 'leader'].map((r) => button(`Find my ${r} arm`, { kind: r === 'follower' ? 'primary' : 'secondary', icon: 'usb', why: none ? 'No board found yet: plug one in (step 1)' : '', onClick: () => startIdentify(r) }));
        box.replaceChildren(h('div', { class: 'stack-sm' },
          h('p', { class: 'muted' }, rich('You will pull <b>one USB cable</b> out of a board and push it back in. Nothing moves, and no motor is written to. Both boards stay powered.')),
          actions(btns), message ? h('p', { class: 'why' }, message) : null));
      }
      st.idBox = box;
    }
    async function startIdentify(role) {
      const r = await api.post('/api/suite/identify', { action: 'start', role }).catch((e) => ({ state: 'error', message: e.message }));
      st.idn = { state: r.state || 'unplug', message: r.message || '', port: r.port || null, role };
      drawIdentify(st.idBox); announce(`Step 1: unplug the ${role} arm's USB cable.`);
      pollIdentify();
    }
    async function cancelIdentify() {
      clearTimeout(timers.idn);
      try { await api.post('/api/suite/identify', { action: 'cancel' }); } catch (e) { toast(`<b>Could not cancel.</b> ${e.message}`, 'warn'); }
      st.idn = { state: 'idle', message: '', port: null, role: null }; drawIdentify(st.idBox); loadPorts(true);
    }
    function pollIdentify() {
      clearTimeout(timers.idn);
      const tick = async () => {
        if (!alive || st.sec !== 'which') return;
        let r;
        try { r = await api.get('/api/suite/identify'); } catch (e) { r = { state: 'error', message: e.message }; }
        if (!alive) return;
        const next = { state: r.state, message: r.message || '', port: r.port || st.idn.port || null, role: st.idn.role || roleFromMsg(r.message) };
        if (JSON.stringify(next) !== JSON.stringify(st.idn)) {
          const was = st.idn.state; st.idn = next; drawIdentify(st.idBox);
          if (next.state !== was) announce(next.state === 'replug' ? 'I see it: port removed. Now plug the cable back in.' : next.state === 'done' ? `Done. This board is the ${next.role} arm.` : next.state === 'error' ? 'That did not work.' : '');
        }
        if (r.state === 'unplug' || r.state === 'replug') { loadPorts(); timers.idn = setTimeout(tick, 700); }
        else { await loadPorts(true); ctx.refresh(); }
      };
      timers.idn = setTimeout(tick, 700);
    }
    async function resumeIdentify(box) {
      st.idBox = box;
      try {
        const r = await api.get('/api/suite/identify');
        if (r.state === 'unplug' || r.state === 'replug') { st.idn = { state: r.state, message: r.message || '', port: r.port || null, role: roleFromMsg(r.message) }; if (alive && st.sec === 'which') { drawIdentify(box); pollIdentify(); } }
      } catch { /* idle is fine */ }
    }

    /* ================= (3) set the motor IDs ================= */
    const f = st.flow;
    const sortIds = (a) => [...new Set((a || []).map(Number))].sort((x, y) => x - y);
    async function doScan() {
      if (!st.port) throw new Error('No board is selected. Plug one in first (step 1).');
      const r = await api.post('/api/suite/motors', { action: 'scan', port: st.port });
      return sortIds(r.ids);
    }
    const recoveryNode = (scanLabel = 'Scan') => h('div', {}, h('ol', { class: 'recov' },
      h('li', {}, rich('Is the power supply pushed into the board <b>and</b> plugged into the wall?')),
      h('li', {}, rich('Is the 3-pin cable pushed in until each plug sits flush with its socket, at the motor <b>and</b> at the board?')),
      h('li', {}, rich('Waveshare board: do both jumper caps sit on <b>B</b>?'))),
      h('p', { class: 'why' }, 'Then press ', h('b', {}, scanLabel), ' again. More help: ', h('a', { href: '#/help' }, 'Help'), '.'));

    function drawIds() {
      const demoBox = h('div'), selBox = h('div'), preBox = h('div'), flowBox = h('div', { class: 'stack' }), navBox = h('div');
      st.flowBox = flowBox; st.preBox = preBox;
      /* port + arm choice: built once, updated in place */
      const sel = h('select', { class: 'input', id: 'm-port', 'aria-label': 'Which board' });
      const segBtns = ['follower', 'leader'].map((r) => h('button', { type: 'button', 'data-arm': r, 'aria-pressed': 'false', onclick: () => { st.arm = r; f.scan = null; syncSeg(); renderFlow(); } }, `${cap(r)} arm`));
      const syncSeg = () => segBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.arm === st.arm)));
      const fillOptions = () => {
        const ports = st.ports || [];
        sel.replaceChildren(...(ports.length ? ports.map((p) => h('option', { value: p.path }, `${roleOf(p) ? cap(roleOf(p)) + ': ' : ''}${p.path}`)) : [h('option', { value: '' }, 'No board found')]));
        sel.value = st.port || ''; sel.disabled = !ports.length;
      };
      sel.onchange = () => { st.port = sel.value; const r = roleOf(portByPath(st.port) || {}); if (r) st.arm = r; f.scan = null; st.pre = null; syncSeg(); renderPre(); renderFlow(); };
      selBox.append(h('div', { class: 'row msel' }, h('div', { class: 'field' }, h('label', { for: 'm-port' }, 'Which board'), sel), h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'These motors are for the'), h('div', { class: 'seg', role: 'group', 'aria-label': 'Which arm are these motors for' }, segBtns))));
      navBox.append(nav(['Back', 'which'], h('span')));
      let selSig = null;
      st.live.onPorts = () => {
        if (!touched(selBox)) fillOptions();
        const sig = st.port || '';                                        // the buttons below say "no board yet" until a board is chosen
        if (sig !== selSig && !touched(preBox) && !touched(flowBox)) { selSig = sig; renderPre(); renderFlow(); }
      };
      fillOptions(); syncSeg(); selSig = st.port || '';
      renderDemo(demoBox); renderPre(); renderFlow();
      secBox.replaceChildren(h('section', { class: 'stack' },
        h('div', {}, h('h2', {}, '3. Set the motor IDs'),
          h('p', { class: 'muted' }, rich('Every motor needs its own number, its '), term('motor-id', 'motor ID'), rich(', so the board can talk to one motor at a time. '), h('b', {}, 'You only do this for brand-new motors.'), rich(' New motors all answer as ID 1, so you plug them in alone, one after the other, and give each one its number.'))),
        demoBox, h('div', { class: 'card stack' }, selBox, preBox), flowBox, navBox));
    }

    function renderDemo(box) {
      if (!demo()) { box.replaceChildren(); return; }
      const pretend = (what, ids) => button(what, { size: 'sm', onClick: safe(async () => {
        if (!st.port) throw new Error('Plug a board in first (step 1).');
        await api.post('/api/demo/connect', { port: st.port, ids });
        f.scan = null; st.pre = null; f.err = ''; renderPre(); renderFlow(); ctx.refresh();
        toast(ids.length === 0 ? '<b>Pretending nothing is plugged in.</b>' : ids.length === 1 ? '<b>Pretending one new motor is plugged in.</b> It answers as ID 1, like a real new motor. Now press Scan.' : '<b>Pretending all six motors are plugged in.</b> Now press Scan.', 'ok', 4200);
      }) });
      box.replaceChildren(h('div', { class: 'card flat demohelper' }, h('div', { class: 'row' }, badge('Demo helper', 'info'), h('b', {}, 'There is no real hardware here, so pretend')),
        h('p', { class: 'muted' }, 'These buttons only exist in the demo. With a real arm you plug cables in instead.'),
        h('div', { class: 'row' }, pretend('One new motor is plugged in', [1]), pretend('All six motors are plugged in', [1, 2, 3, 4, 5, 6]), pretend('Nothing is plugged in', []))));
    }

    /* ----- pre-check: "do my motors already have IDs?" ----- */
    function scanText(ids) {
      const missing = [1, 2, 3, 4, 5, 6].filter((i) => !ids.includes(i));
      if (ids.length === 6 && !missing.length) return { kind: 'ok', title: 'Your motors already have IDs: skip this', text: 'All six motors answer, as IDs 1 to 6. There is nothing to set. You can go on.' };
      if (!ids.length) return { kind: 'warn', title: 'No motor answers', text: 'Nothing answered on this board. Check these, in this order:', more: recoveryNode('Scan my motors') };
      if (ids.length === 1 && ids[0] === 1) return { kind: 'info', title: 'One motor answers: ID 1', text: 'That is what a brand-new motor says. If you have only this motor plugged in, it is new: give it its ID below. If several motors are chained, they would all answer as ID 1 and the board could not tell them apart.' };
      return { kind: 'warn', title: `${ids.length} motor${ids.length > 1 ? 's' : ''} answer: ${list(ids)}`, text: `Missing: ${list(missing)}. If this arm is built, the cable going to the first missing motor is the usual cause. If these are loose new motors, set their IDs one at a time below.` };
    }
    function renderPre() {
      const [nextName, nextHref] = afterIds();
      const scanBtn = button(st.preBusy ? 'Scanning…' : 'Scan my motors', { icon: 'pulse', why: !st.port ? 'No board found yet: plug one in (step 1)' : st.preBusy ? 'Scanning…' : '', onClick: safe(async () => {
        st.preBusy = true; st.pre = null; renderPre();
        try { st.pre = { ids: await doScan() }; } catch (e) { st.pre = { err: e.message }; }
        st.preBusy = false; renderPre();
        announce(st.pre.err ? `Scan failed. ${st.pre.err}` : scanText(st.pre.ids).title);
      }) });
      let result = null;
      if (st.preBusy) result = h('div', { class: 'chk wait' }, h('span', { class: 'spin' }), 'Asking the board who is there…');
      else if (st.pre?.err) result = callout('warn', st.pre.err, 'The scan did not work');
      else if (st.pre) { const t = scanText(st.pre.ids); result = callout(t.kind === 'ok' ? 'ok' : t.kind === 'info' ? 'tip' : 'warn', h('div', {}, h('p', {}, t.text), t.more || null), t.title); }
      const skip = st.pre?.ids && scanText(st.pre.ids).kind === 'ok';
      st.preBox.replaceChildren(h('div', { class: 'stack-sm' },
        h('h3', {}, 'First: do your motors already have IDs?'),
        h('p', { class: 'muted' }, rich(`If your arm is already built, or you did this before, press <b>Scan my motors</b>. If six motors answer, you can skip this step. Brand-new motors? You can start straight away.`)),
        h('div', { class: 'row' }, scanBtn, skip || f.started ? null : button('My motors are new: start', { kind: 'primary', icon: 'arrow', why: !st.port ? 'No board found yet: plug one in (step 1)' : '', onClick: () => { f.started = true; renderPre(); renderFlow(); st.flowBox.scrollIntoView({ block: 'start', behavior: 'smooth' }); } })),
        result,
        skip ? h('div', { class: 'row' }, button(`Next: ${nextName}`, { kind: 'primary', icon: 'arrow', href: nextHref }), button('Set the IDs anyway', { kind: 'ghost', onClick: () => { f.started = true; renderPre(); renderFlow(); } })) : null));
    }

    /* ----- the one-motor-at-a-time flow ----- */
    function oneMotorFig(n) {
      const jt = JT[n];
      return h('div', { class: 'stack-sm' }, dg.oneMotor({ id: n, joint: jt.name }),
        h('figure', { class: 'rw bad mm-wrong' }, dg.twoMotorsWrong(), h('figcaption', {}, icon('x'), dg.inline('<b>Not like this.</b> Two motors on the board at once answer together, and the board cannot tell them apart.'))));
    }
    function whereText(n) {
      const jt = JT[n], code = CODE[st.arm][n];
      const which = st.arm === 'leader' ? `Pick up the motor whose label says <b>${code}</b>. The leader arm uses different gear ratios on different joints, so the code on the box matters.` : 'Pick up any one of your six follower motors. They are all alike (code <b>C001</b>).';
      return `${which} This one becomes the <b>${jt.name.toLowerCase()}</b> motor: the one that ${jt.does}. A motor is a black plastic box about 4.5 cm long with a small rectangular socket in its side (see the picture).`;
    }
    function motorCard() {
      const n = ORDER[f.k], jt = JT[n], done = f.done[st.arm], sc = f.scan, isDone = done.has(n);
      const one = sc?.ids?.length === 1 ? sc.ids[0] : null;
      const setWhy = f.busy ? 'Working on it…' : !st.port ? 'No board found yet: plug one in (step 1)' : isDone ? `Motor ${n} is done. Go on to the next motor` : !sc ? 'Press Scan first' : sc.err ? 'The scan did not work: fix what it says, then Scan again' : sc.ids.length === 0 ? 'No motor answers: use the checks, then Scan again' : sc.ids.length > 1 ? `${sc.ids.length} motors answer: plug in only the ${jt.name.toLowerCase()} motor, then Scan again` : one === n ? `This motor already answers as ID ${n}: nothing to write` : '';
      const scanBtn = button(f.busy === 'scan' ? 'Scanning…' : 'Scan', { icon: 'pulse', why: f.busy === 'scan' ? 'Scanning…' : f.busy ? 'Working on it…' : !st.port ? 'No board found yet: plug one in (step 1)' : '', onClick: safe(async () => {
        f.busy = 'scan'; f.err = ''; renderFlow();
        try { const ids = await doScan(); f.scan = { ids }; if (ids.length === 1 && ids[0] === n) done.add(n); }
        catch (e) { f.scan = { err: e.message, ids: [] }; }
        f.busy = ''; renderFlow(); updateStepper();
        announce(f.scan.err ? `Scan failed. ${f.scan.err}` : f.scan.ids.length === 1 ? `One motor answers: ID ${f.scan.ids[0]}.` : `${f.scan.ids.length} motors answer.`);
      }) });
      const setBtn = button(`Set ID ${n}`, { kind: 'primary', icon: 'check', why: setWhy, onClick: () => askYes(
        `<b>Write ID ${n} into this motor?</b> This saves the number ${n} in the motor’s own memory (its EEPROM), and sets its speed to the standard one so every motor matches. Only the one motor that is plugged in changes, and you can change it again later.`,
        `Yes, write ID ${n}`, safe(writeId)) });
      const nextBtn = f.k < 5 ? button(`Next motor: ${JT[ORDER[f.k + 1]].name.toLowerCase()} (ID ${ORDER[f.k + 1]})`, { kind: isDone ? 'primary' : 'secondary', icon: 'arrow', why: isDone ? '' : `Set ID ${n} first`, onClick: () => { f.k++; f.scan = null; f.err = ''; renderFlow(); st.flowBox.scrollIntoView({ block: 'start', behavior: 'smooth' }); } })
        : button('Finish', { kind: isDone ? 'primary' : 'secondary', icon: 'check', why: isDone ? '' : `Set ID ${n} first`, onClick: () => { f.finished[st.arm] = true; renderFlow(); } });
      return stepCard({
        title: h('span', { class: 'mm-title' }, progressCue('motor', f.k + 1, 6), `Set the ${jt.name.toLowerCase()} motor to ID ${n}`),
        safety: 'Unplug the power supply from the wall BEFORE you plug in or pull out a motor cable. Cables pushed in with power on can damage the board or a motor.',
        where: whereText(n),
        do: ['Unplug the power supply from the wall.', 'If another motor is plugged into the board, pull its 3-pin cable out of the board.', `Push one plug of a 3-pin cable into a socket of the ${jt.name.toLowerCase()} motor until it sits flush with the socket opening.`, 'Push the other plug of that cable into a motor socket on the board until it sits flush.', 'Plug the power supply into the wall socket.', 'Press <b>Scan</b>, below.', `When the box below says one motor answers, press <b>Set ID ${n}</b>.`],
        how: 'A 3-pin cable is a thin cable with a small plug on each end. Hold a plug by its sides, never by the wires.',
        know: dg.inline(`After <b>Scan</b>, the box below says “One motor answers”. After <b>Set ID ${n}</b>, it says “Motor now answers as ID ${n}”.`),
        ifNot: dg.inline('Nothing answers, or two motors answer? Follow the checks that appear in the box below.'),
        diagram: oneMotorFig(n), caption: `Top view, the board lies flat in front of you. Numbers 3, 4 and 5 are the steps with the same numbers. Plug in exactly <b>one</b> motor.`,
        footer: h('div', { class: 'idfoot' }, resultNode(n), actions([scanBtn, setBtn, nextBtn])),
      });
    }
    function resultNode(n) {
      const jt = JT[n], sc = f.scan, done = f.done[st.arm];
      if (f.busy === 'scan') return h('div', { class: 'chk wait' }, h('span', { class: 'spin' }), 'Asking the board who is there…');
      if (f.busy === 'write') return h('div', { class: 'chk wait' }, h('span', { class: 'spin' }), `Writing ID ${n}. Do not unplug anything…`);
      if (f.err) return callout('warn', f.err, 'The app did not write it');
      if (sc?.wrote) return callout('ok', `<b>Motor now answers as ID ${n}.</b> ${sc.verified ? 'I checked: a scan shows ' + `ID ${n}` + '.' : `The board said it wrote it, but a scan shows ${list(sc.ids)}. Press Scan again.`} Put a label with a <b>${n}</b> on this motor, then go on.`, 'Done');
      if (done.has(n) && sc?.ids?.length === 1 && sc.ids[0] === n) return callout('ok', `This motor already answers as ID ${n}. There is nothing to write. Put a label with a <b>${n}</b> on it, then go on.`, 'Already done');
      if (!sc && done.has(n)) return callout('ok', `You already gave a motor the ID ${n} in this session. Go on to the next motor, or press <b>Scan</b> to check again.`, `Motor ${n} is done`);
      if (!sc) return h('p', { class: 'muted' }, rich('Not scanned yet. Press <b>Scan</b> once the motor and the power are plugged in.'));
      if (sc.err) return callout('warn', sc.err, 'The scan did not work');
      if (!sc.ids.length) return callout('warn', h('div', {}, h('p', {}, `The ${jt.name.toLowerCase()} motor may not be connected, or the board has no power. Check these, in this order:`), recoveryNode()), 'No motor answers');
      if (sc.ids.length > 1) return callout('warn', h('div', {}, h('p', {}, `${sc.ids.length} motors answer (IDs ${list(sc.ids)}). Set one ID at a time, so only one motor may be plugged in.`), h('ol', { class: 'recov' }, h('li', {}, 'Unplug the power supply from the wall.'), h('li', {}, `Pull every motor’s 3-pin cable out of the board except the one going to the ${jt.name.toLowerCase()} motor.`), h('li', {}, 'Plug the power supply in again, then press Scan.'))), `${sc.ids.length} motors answer`);
      const id = sc.ids[0], used = [...done].filter((x) => x !== n);
      if (used.includes(id)) return callout('warn', `This motor answers as <b>ID ${id}</b>, a number you already gave out. It looks like the motor from an earlier step. Unplug it and plug in a <b>new</b> motor (it answers as ID 1), then press Scan.`, 'Not a new motor');
      return callout('tip', `One motor answers: <b>ID ${id}</b>.${id === 1 ? ' That is what a brand-new motor says.' : ''} Press <b>Set ID ${n}</b> to give it the number ${n}.`, 'One motor answers');
    }
    async function writeId() {
      const n = ORDER[f.k], done = f.done[st.arm];
      f.busy = 'write'; f.err = ''; renderFlow();
      try {
        await api.post('/api/suite/motors', { action: 'set_id', port: st.port, id: n });
        done.add(n);
        let ids = [];
        try { ids = await doScan(); } catch { /* verification is best effort */ }
        f.scan = { ids, wrote: true, verified: ids.length === 1 && ids[0] === n };
        announce(`Motor now answers as ID ${n}.`);
        ctx.refresh(); loadPorts(true);
      } catch (e) { f.err = e.message || String(e); f.scan = null; }
      f.busy = ''; renderFlow(); updateStepper();
    }
    function progressList() {
      const done = f.done[st.arm];
      return h('ol', { class: 'idprog', 'aria-label': 'Motors to set, in order' }, ORDER.map((n, i) => h('li', { class: (i === f.k ? 'cur ' : '') + (done.has(n) ? 'done' : '') },
        h('button', { type: 'button', 'aria-current': i === f.k ? 'step' : 'false', onclick: () => { f.k = i; f.scan = null; f.err = ''; renderFlow(); } }, h('b', {}, String(n)), h('small', {}, JT[n].name), done.has(n) ? icon('check') : null))));
    }
    function renderFlow() {
      const box = st.flowBox; if (!box) return;
      if (!f.started) { box.replaceChildren(); return; }
      const done = f.done[st.arm];
      if (done.size === 6 && f.finished[st.arm]) {
        const other = st.arm === 'follower' ? 'leader' : 'follower';
        box.replaceChildren(callout('ok', h('div', { class: 'stack-sm' },
          h('p', {}, `All six motors of the ${st.arm} arm have their IDs. You can unplug the board now. Keep the labels on the motors: you will want them while you build.`),
          h('p', { class: 'muted' }, rich('Later, once the arm is built, <a href="#/test">Test motors</a> checks all six together.')),
          h('div', { class: 'row' }, button('Next: Assemble', { kind: 'primary', size: 'lg', icon: 'arrow', href: '#/assemble' }), button(`Do the ${other} arm too`, { onClick: () => { st.arm = other; f.k = 0; f.scan = null; drawIds(); } }), button('Go back over the steps', { kind: 'ghost', onClick: () => { f.finished[st.arm] = false; f.k = 0; f.scan = null; renderFlow(); } }))), `Done: the ${st.arm} arm’s motors have their IDs`));
        return;
      }
      box.replaceChildren(
        h('div', { class: 'stack-sm' }, h('h3', {}, `The ${st.arm} arm: six motors, one at a time`), progressList()),
        f.k === 0 && !done.size ? h('details', { class: 'jumpers', open: true }, h('summary', {}, 'Waveshare board? Check its two jumpers once, before the first motor'), jumperCard()) : null,
        motorCard());
    }
    function jumperCard() {
      return stepCard({
        title: 'Put both jumper caps on B',
        where: 'Two small plastic caps (jumpers) sit on rows of pins on the Waveshare board, next to the USB socket. Each row is marked <b>A</b> on one side and <b>B</b> on the other.',
        do: ['Look at the two caps.', 'If a cap sits on the A pins, pull it off with your fingernails and press it onto the two B pins until it sits flat.'],
        know: dg.inline('Both caps cover the <b>B</b> pins, like the green picture.'),
        ifNot: dg.inline('Your board has no caps or no A and B marks? Then it is not a Waveshare board: skip this check.'),
        diagram: h('div', { class: 'stack-sm' }, dg.jumpers('right'), h('figure', { class: 'rw bad mm-wrong' }, dg.jumpers('wrong'), h('figcaption', {}, icon('x'), dg.inline('<b>Not like this.</b> A cap on A.')))),
        caption: 'Close-up, schematic. Boards differ a little: look for the letters A and B.',
      });
    }

    /* ================= page ================= */
    const [nextName, nextHref] = afterIds();
    root.append(h('div', { class: 'stack-lg motors' },
      h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Get started · step 2'), h('h1', {}, 'Motor IDs'),
        h('p', { class: 'lead' }, rich('Find your boards, tell the app which arm is which, and give each brand-new motor its number. Already built? A scan tells you in five seconds, and you can skip the rest.'))),
      h('details', { class: 'pre', open: !matchMedia('(max-width: 760px)').matches }, h('summary', {}, 'Before we start: what you need'),
        preflight({
          title: 'Before we start', minutes: 15,
          needs: ['The USB servo board (the control board) for the arm', 'A USB cable, to connect the board to this computer', 'The power supply that came with the board', 'One 3-pin cable (a thin cable with a small plug on each end)', 'The motors, still loose in their bags: 6 per arm', 'Waveshare board: both jumper caps on the pins marked <b>B</b>'],
          hands: 'Both. One holds the motor, the other pushes the cable plugs in.',
          moves: 'Nothing moves in this part. The app only asks each motor “are you there?”, and writes an ID into one motor at a time, only when you press a <b>Set ID</b> button and confirm.',
          clear: 'A flat table with room for the board, the cables and one motor.',
          stop: 'There is nothing to stop, because nothing moves. If anything smells hot or smokes, pull the power supply out of the wall at once.',
        }),
        callout('tip', 'Put a small label on each motor with its ID as you go: <b>6</b> gripper, <b>5</b> wrist roll, <b>4</b> wrist flex, <b>3</b> elbow flex, <b>2</b> shoulder lift, <b>1</b> shoulder pan. You will want them while you build the arm. This is a tip, not an official step.', 'Tip')),
      stepper, secBox, live));

    const portPoll = setInterval(() => { if (alive && !document.hidden && !timers.idn) loadPorts(); }, 3000);
    const off = ctx.onChange((c) => [c.arm('follower')?.port, c.arm('leader')?.port, c.checklist?.summary?.ok], () => { updateStepper(); st.live.onPorts?.(); });
    (async () => {
      go(st.sec, false);
      await Promise.all([loadPorts(true), loadPlatform()]);
      if (route.args[0] === undefined && st.ports?.length && !route.query.get('role')) updateStepper();
    })();
    return () => { alive = false; clearInterval(portPoll); clearTimeout(timers.idn); off(); };
  },
};
