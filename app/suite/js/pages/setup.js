// Setup check: every check the app makes, grouped, with one fix button on the first thing that is not OK.
// Truth over reassurance: rows come straight from /api/suite/checklist. Rows are only redrawn when the checklist really changed,
// and never while the pointer or the keyboard focus is on one of their buttons (a redrawn button eats clicks).
import { h, icon, button, badge, ring, callout, copyBox, empty, skeleton, toast as toastBase, rich, loadCss, term } from '../ui.js';
import { connectBoardCard, inline } from '../diagrams/motors.js';

loadCss(new URL('../../css/pages/setup.css', import.meta.url).href);

// ui.js's toast() lays its message out as a flex row, which splits "<b>Title.</b> text" into separate columns.
// Wrapping the message in one <div> keeps it as ordinary text. (safe() does the same job as ui.js's, with that wrapper.)
const toast = (msg, level, ms) => toastBase(typeof msg === 'string' ? h('div', {}, rich(msg)) : msg, level, ms);
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(`<b>That did not work.</b> ${String(e.message || e)}`, 'err'); } };

const GROUPS = [
  ['computer', 'Your computer', 'What the app itself needs to run.'],
  ['arms', 'Arms and motors', 'The USB board, its power and the six motors of each arm.'],
  ['calibration', 'Calibration', 'Teaches each arm where the middle of every joint is.'],
  ['cameras', 'Cameras', 'Only needed for pick and place.'],
  ['extras', 'Extras', 'Nice to have.'],
];
const STATUS = { ok: ['Done', 'ok'], todo: ['To do', 'todo'], warn: ['Needs a look', 'warn'], fail: ['Problem', 'fail'], skip: ['Skipped', ''] };
const S = inline;
const hex4 = (n) => (n == null ? '' : Number(n).toString(16).padStart(4, '0'));
const askedMotor = (it) => (it.status === 'fail' || it.status === 'warn') && /_(motors|connected)$/.test(it.id);
const isDone = (it) => it.status === 'ok' || it.status === 'skip';
/** True while the pointer rests on a button or link inside `el` (a redraw now would swallow the click). */
const touched = (el) => [...el.querySelectorAll(':hover')].some((e) => e.matches('button, a, .btn'));

function stateIcon(status) {
  const s = h('span', { class: 'state', 'aria-hidden': 'true' });
  if (status === 'ok') s.append(icon('check'));
  else if (status === 'fail') s.append(icon('x'));
  else if (status === 'warn') s.append(icon('alert'));
  else if (status === 'skip') s.append(h('span', { class: 'dash' }));
  return s;
}

/** The inline "how do I fix this" for rows whose fix points back at this page. */
function howTo(it, plat) {
  const os = plat?.os;
  if (it.id === 'python') {
    const cmds = os === 'windows' ? ['.\\setup.ps1'] : os ? ['./setup.sh'] : ['./setup.sh   (macOS, Linux, Raspberry Pi)', '.\\setup.ps1   (Windows)'];
    return h('div', { class: 'stack-sm' }, h('p', {}, rich('Run the setup script again from the project folder. It installs a suitable Python for you, so you do not have to.')), cmds.map((c) => copyBox(c)),
      h('p', { class: 'why' }, 'Then press ', h('b', {}, 'Re-check now'), '.'));
  }
  if (it.id === 'serial_permission') {
    return h('div', { class: 'stack-sm' }, h('p', {}, rich('Linux only lets members of the <code>dialout</code> group open serial ports. Run this once in a terminal:')), copyBox('sudo usermod -aG dialout $USER'),
      h('p', {}, rich('Then <b>log out and log back in</b> (or restart the computer). Come back here and press <b>Re-check now</b>.')));
  }
  return connectBoardCard({ know: S('Press <b>Re-check now</b>. This row turns green and the <b>Ports found</b> table below lists a new line.') });
}

export default {
  id: 'setup', title: 'Setup check',
  render(root, ctx) {
    let alive = true, lastSig = '', platform = null, ports = null, portsSig = '', diagText = '';
    const open = new Set();                        // rows whose "how to" is expanded (survives redraws)
    const sumBox = h('div'), listBox = h('div', { class: 'stack-lg' }), platBox = h('div'), portsBox = h('div'), diagBox = h('div');

    /* ---------- top actions (static: never redrawn) ---------- */
    const recheck = button('Re-check now', { icon: 'checks' });
    const label = [...recheck.childNodes];
    recheck.onclick = safe(async () => {
      if (recheck.disabled) return;
      recheck.disabled = true; recheck.replaceChildren(h('span', { class: 'spin' }), 'Checking…');
      try {
        await Promise.all([ctx.refresh(), loadPlatform(), loadPorts(true), new Promise((r) => setTimeout(r, 700))]);
        update(true);
        const sm = ctx.checklist?.summary;
        toast(sm ? `<b>Checked.</b> ${sm.ok} of ${sm.total} checks passed.` : '<b>Checked.</b>', 'ok', 2600);
      } finally { recheck.disabled = false; recheck.replaceChildren(...label); }
    });
    const copyDiag = button('Copy diagnostics', { icon: 'copy', onClick: safe(async () => {
      const r = await ctx.api.get('/api/suite/diagnostics');
      diagText = typeof r === 'string' ? r : r?.text ?? JSON.stringify(r, null, 2);
      try { await navigator.clipboard.writeText(diagText); toast('<b>Copied.</b> Paste it into your message or bug report.', 'ok'); diagBox.replaceChildren(); }
      catch { showDiag(); toast('Could not copy automatically. The text is selected below: copy it yourself.', 'warn'); }
    }) });
    function showDiag() {
      const ta = h('textarea', { class: 'input diag', readonly: true, rows: 10, 'aria-label': 'Diagnostics text' });
      ta.value = diagText;
      diagBox.replaceChildren(h('div', { class: 'stack-sm' }, h('p', { class: 'why' }, 'Select all and copy this text, then paste it where you ask for help.'), ta));
      ta.focus(); ta.select();
    }

    /* ---------- summary ---------- */
    function drawSummary(cl) {
      const items = cl.items, sm = cl.summary || {};
      const total = sm.total ?? items.filter((i) => i.status !== 'skip').length, ok = sm.ok ?? items.filter((i) => i.status === 'ok').length;
      const todo = items.filter((i) => !isDone(i)), skipped = items.filter((i) => i.status === 'skip').length;
      const next = items.find((i) => i.id === sm.next) || todo[0];
      const card = h('div', { class: 'card hero setup-sum' + (!next ? ' done' : '') });
      card.append(h('div', { class: 'setup-sum__main' }, ring(ok, total, { size: 96 }), h('div', { class: 'stack-sm' },
        h('div', { class: 'eyebrow' }, next ? 'Next step' : 'All set'),
        next ? h('h2', {}, next.action || next.title) : h('h2', {}, 'Everything checks out.'),
        h('p', { class: 'muted' }, h('b', {}, `${ok} of ${total} checks passed`), todo.length ? ` · ${todo.length} to go` : '', skipped ? ` · ${skipped} optional skipped` : ''),
        next ? h('p', { class: 'detail' }, next.detail) : h('p', { class: 'detail' }, 'Your computer, your arm and its motors all answer. You can open Control and move the arm.'))));
      if (next) {
        const f = next.fix, local = !f || f.page === 'setup';
        card.append(h('div', { class: 'row' },
          local ? button(f?.label || 'Show me how', { kind: 'primary', size: 'lg', icon: 'arrow', onClick: () => openRow(next.id) }) : button(f.label, { kind: 'primary', size: 'lg', icon: 'arrow', href: '#/' + f.page }),
          askedMotor(next) ? button('Test the motors', { href: '#/test', icon: 'pulse' }) : null));
      } else {
        card.append(h('div', { class: 'row' }, button('Open Control', { kind: 'primary', size: 'lg', icon: 'arrow', href: '#/control' }), button('Test the motors', { href: '#/test', icon: 'pulse' }), button('Browse modules', { kind: 'ghost', href: '#/modules' })));
      }
      sumBox.replaceChildren(card);
    }

    /* ---------- rows ---------- */
    function drawRow(it, isNext) {
      const [word, kind] = STATUS[it.status] || [it.status, ''];
      const f = it.fix, local = f?.page === 'setup', panelId = `howto-${it.id}`;
      const panel = local ? h('div', { class: 'howto', id: panelId, hidden: !open.has(it.id) }, howTo(it, platform)) : null;
      const fixBtn = !f ? null : local
        ? button(f.label, { kind: isNext ? 'primary' : 'secondary', size: 'sm', onClick: () => openRow(it.id, true) })
        : button(f.label, { kind: isNext ? 'primary' : 'secondary', size: 'sm', href: '#/' + f.page, icon: 'arrow' });
      if (fixBtn) { fixBtn.dataset.key = 'fix-' + it.id; if (local) { fixBtn.setAttribute('aria-controls', panelId); fixBtn.setAttribute('aria-expanded', open.has(it.id) ? 'true' : 'false'); } }
      return h('div', { class: `li ${it.status}${isNext ? ' next' : ''}`, id: 'row-' + it.id },
        stateIcon(it.status),
        h('div', { class: 'body' },
          h('div', { class: 'row title-row' }, isNext ? badge('Next', 'accent') : null, h('span', { class: 'title' }, it.title), badge(word, kind)),
          h('div', { class: 'detail' }, it.detail)),
        h('div', { class: 'li-actions' }, fixBtn, askedMotor(it) ? button('Test the motors', { size: 'sm', kind: 'ghost', href: '#/test' }) : null),
        panel);
    }
    function drawList(cl) {
      const items = cl.items, nextId = cl.summary?.next ?? items.find((i) => !isDone(i))?.id;
      const known = new Set(GROUPS.map((g) => g[0]));
      const groups = [...GROUPS, ...[...new Set(items.map((i) => i.group))].filter((g) => !known.has(g)).map((g) => [g, g, ''])];
      listBox.replaceChildren(...groups.map(([id, title, sub]) => {
        const rows = items.filter((i) => i.group === id);
        if (!rows.length) return null;
        const okN = rows.filter((i) => i.status === 'ok').length;
        return h('section', { class: 'stack-sm setup-group' },
          h('div', { class: 'row-between' }, h('div', {}, h('h2', {}, title), sub ? h('p', { class: 'muted setup-sub' }, sub) : null), h('span', { class: 'muted nowrap' }, `${okN} of ${rows.filter((i) => i.status !== 'skip').length} done`)),
          h('div', { class: 'list' }, rows.map((it) => drawRow(it, it.id === nextId))));
      }));
    }
    function openRow(id, toggle) {
      const panel = listBox.querySelector('#howto-' + CSS.escape(id)), btn = listBox.querySelector(`[data-key="fix-${CSS.escape(id)}"]`);
      if (!panel) { listBox.querySelector('#row-' + CSS.escape(id))?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      const show = toggle ? panel.hidden : true;
      panel.hidden = !show; show ? open.add(id) : open.delete(id);
      btn?.setAttribute('aria-expanded', String(show));
      if (show) panel.closest('.li')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function update(force) {
      const cl = ctx.checklist;
      if (!cl?.items) return;
      const sig = JSON.stringify(cl) + (platform ? '1' : '0');
      if (sig === lastSig && !force) return;
      if (touched(listBox) || touched(sumBox)) return;               // try again on the next tick
      const key = document.activeElement?.dataset?.key;
      lastSig = sig;
      drawSummary(cl); drawList(cl);
      if (key) root.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    }

    /* ---------- your computer ---------- */
    async function loadPlatform() {
      try { platform = await ctx.api.get('/api/suite/platform'); drawPlatform(); }
      catch (e) { platform = null; platBox.replaceChildren(h('div', { class: 'card flat' }, h('b', {}, 'Your computer'), h('p', { class: 'muted' }, `Could not read this computer’s details: ${e.message}. The checks above still work.`))); }
    }
    function kv(k, v) { return v == null || v === '' ? null : h('div', { class: 'kv' }, h('dt', {}, k), h('dd', {}, v)); }
    function drawPlatform() {
      const p = platform || {};
      const osName = { macos: 'macOS', linux: 'Linux', windows: 'Windows' }[p.os] || p.os || 'Unknown';
      const sum = [`${osName}${p.os_version ? ' ' + p.os_version : ''}`, p.arch, p.python ? `Python ${p.python}` : null].filter(Boolean).join(' · ');
      const perm = p.in_dialout === true ? 'Yes, your user may open serial ports.' : p.in_dialout === false ? 'No. See the “Permission to use serial ports” row above.' : 'Not needed on this computer.';
      platBox.replaceChildren(h('details', { class: 'card flat plat' },
        h('summary', {}, h('span', { class: 'row' }, icon('terminal'), h('b', {}, 'Your computer'), h('span', { class: 'muted' }, sum))),
        h('dl', { class: 'kvs' },
          kv('Operating system', `${osName}${p.os_version ? ' ' + p.os_version : ''}`), kv('Processor', p.arch),
          kv('Raspberry Pi', p.is_pi ? `Yes${p.pi_model ? ': ' + p.pi_model : ''}` : 'No'),
          kv('Python', p.python), kv('uv', p.uv ? 'Installed' : 'Not installed (optional)'), kv('Serial permission', perm),
          p.serial_examples?.length ? kv('Serial ports look like', h('span', { class: 'row' }, p.serial_examples.map((x) => h('code', {}, x)))) : null,
          kv('Camera backend', p.camera_backend)),
        p.notes?.length ? h('ul', { class: 'notes' }, p.notes.map((n) => h('li', {}, rich(n)))) : null));
    }

    /* ---------- ports found ---------- */
    async function loadPorts(force) {
      let list;
      try { list = (await ctx.api.get('/api/suite/ports'))?.ports || []; }
      catch (e) { if (force || ports === null) { ports = null; portsBox.replaceChildren(portsShell(h('p', { class: 'muted' }, `Could not list the ports: ${e.message}`), true)); portsSig = ''; } return; }
      const sig = JSON.stringify(list);
      if (sig === portsSig) return;
      if (touched(portsBox)) return;
      ports = list; portsSig = sig; drawPorts();
    }
    const roleOf = (p) => p.role || ['follower', 'leader'].find((r) => { const a = ctx.arm(r); return a && a.port === p.path; }) || null;
    const roleBadge = (r) => (r === 'follower' ? badge('Follower', 'info') : r === 'leader' ? badge('Leader', 'accent') : badge('Not assigned', ''));
    function portsShell(body, retry) {
      return h('section', { class: 'stack-sm' }, h('div', { class: 'row-between' }, h('div', {}, h('h2', {}, 'Ports found'), h('p', { class: 'muted setup-sub' }, rich('Each USB servo board shows up as one ') , term('port', 'port'), '.')), retry ? button('Look again', { size: 'sm', onClick: safe(() => loadPorts(true)) }) : null), body);
    }
    function drawPorts() {
      if (!ports?.length) {
        portsBox.replaceChildren(portsShell(empty('No USB serial port found', 'Plug the USB cable of a servo board into this computer and plug in the board’s power supply. Then press <b>Re-check now</b>. This list also updates by itself every few seconds.', button('How to connect', { size: 'sm', href: '#/motors', icon: 'arrow' }))));
        return;
      }
      const row = (p) => h('tr', {},
        h('td', { 'data-label': 'Port' }, h('code', {}, p.path)),
        h('td', { 'data-label': 'What it is' }, p.description || p.manufacturer || '—'),
        h('td', { 'data-label': 'USB id' }, p.vid != null ? h('code', {}, `${hex4(p.vid)}:${hex4(p.pid)}`) : '—'),
        h('td', { 'data-label': 'Role' }, roleBadge(roleOf(p))),
        h('td', { 'data-label': 'In use' }, p.owned_by_app ? badge('Used by this app', 'ok') : badge('Free', '')),
        h('td', { 'data-label': 'Servo board' }, p.likely_servo_board ? badge('Looks like one', 'ok') : h('span', { class: 'muted' }, 'Not sure')));
      portsBox.replaceChildren(portsShell(h('div', { class: 'tablewrap' }, h('table', { class: 'ptable' },
        h('thead', {}, h('tr', {}, ['Port', 'What it is', 'USB id', 'Role', 'In use', 'Servo board'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, ports.map(row)))),
        false), ports.some((p) => !roleOf(p)) ? h('p', { class: 'why' }, 'A board with no role yet? ', h('a', { href: '#/motors' }, 'Say which arm it belongs to'), '.') : null);
    }

    /* ---------- page ---------- */
    root.append(h('div', { class: 'stack-lg setup' },
      h('header', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Get started · step 1'), h('h1', {}, 'Setup check'),
        h('p', { class: 'lead' }, 'Everything the app needs, checked on your computer right now. Fix the highlighted row first, then check again.')),
      sumBox,
      h('div', { class: 'stack-sm' }, h('div', { class: 'row' }, recheck, copyDiag), h('p', { class: 'why' }, 'Checking never moves an arm and never writes to a motor. Diagnostics hold no personal data: just your system, ports, motors, cameras and this list.'), diagBox),
      listBox, platBox, portsBox));
    sumBox.append(h('div', { class: 'card hero' }, h('div', { class: 'stack' }, skeleton('30%', 14), skeleton('70%', 26), skeleton('55%', 16))));
    listBox.append(skeleton('100%', 120));

    const off = ctx.subscribe(() => update());
    loadPlatform().then(() => update(true)); loadPorts(true);
    const t = setInterval(() => { if (alive && !document.hidden) loadPorts(); }, 4000);
    return () => { alive = false; off(); clearInterval(t); };
  },
};
