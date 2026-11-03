// Cameras: see every camera, add or remove one, and teach the arm where the table is by clicking on the picture.
// Config changes apply when the app restarts (os.execv), so the page says so, restarts it on request and waits for it to answer.
// The table mapping reuses the existing engine (/api/pp/*): arm limp -> touch a spot -> click it in the picture -> fit.
// Standing safety rule (docs/LEARNINGS.md 17): nobody is asked to touch the arm while it is stiff. Step 1 is limp.js's card (POST /api/pp/rest:
// it lowers the arm onto the table, then lets go); the jaw and touch steps are only ever shown when pp.limp is true.
import { h, icon, rich, button, badge, chip, callout, copyBox, askYes, toast, term, safe, loadCss, pageHead, cameraView, empty, skeleton } from '../ui.js';
import { stepCard, preflight, progressCue, rightWrong } from '../steps.js';
import { jawTips, spreadSpots, clickHere } from '../diagrams/cameras.js';
import { limpCard } from '../limp.js';

loadCss(new URL('../../css/pages/cameras.css', import.meta.url).href);

const MIN_SPOTS = 3;           // pp.fit needs at least 3 points
const SPOTS = 4;               // the 4th is a real test: with exactly 3 points the fit is always 0 mm
const GOOD_MM = 5, ROUGH_MM = 10;
const STAGES = ['Make the arm limp', 'Close the jaws', 'Teach spots', 'Check the fit'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (str) => h('p', { style: { margin: 0 } }, rich(str));   // see calibrate.js: stepCard "know"/"if not" rows need a non-span wrapper
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function gate(btn, why) {
  const off = !!why;
  btn.disabled = off;
  if (off) { btn.setAttribute('aria-disabled', 'true'); btn.title = why; btn.dataset.why = why; }
  else { btn.removeAttribute('aria-disabled'); btn.removeAttribute('title'); delete btn.dataset.why; }
}
function whyLine(el, buttons) {
  const groups = new Map();
  for (const b of buttons) if (b.dataset.why) groups.set(b.dataset.why, [...(groups.get(b.dataset.why) || []), b.dataset.name || b.textContent]);
  const sig = [...groups].map(([r, n]) => n.join(', ') + r).join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.replaceChildren(...[...groups].map(([r, n]) => h('span', { style: { display: 'block' } }, h('b', {}, n.join(', ')), ` greyed out: ${r}`)));
}
const named = (btn, name) => { btn.dataset.name = name; return btn; };
const flag = {
  get() { try { return sessionStorage.getItem('so101.cams.restart') === '1'; } catch { return false; } },
  set(v) { try { v ? sessionStorage.setItem('so101.cams.restart', '1') : sessionStorage.removeItem('so101.cams.restart'); } catch { /* private window: the page still works */ } },
};

/** What the arm engine says in its own words, said plainly. */
function sayStatus(s) {
  s = String(s || '');
  if (/arm is not limp/i.test(s)) return 'The arm is not limp. Press Lower the arm and make it limp, then try again.';
  if (/hasn't moved since the last point/i.test(s)) return 'The gripper tip has not moved since the last spot. Lift it and touch a new spot at least 2 cm away, then click again.';
  if (/^error: /i.test(s)) return cap(s.slice(7));
  const m = s.match(/^taught point (\d+)(?: · fit error ([\d.]+) mm)?/);
  if (m) return `Spot ${m[1]} saved${m[2] ? `. Fit error ${m[2]} mm.` : '. Three spots are needed to map the table.'}`;
  const a = s.match(/^mapped spot (\d+)(?: · fit error ([\d.]+) mm)?/);
  if (a) return `Spot ${a[1]} saved by Auto${a[2] ? `. Fit error ${a[2]} mm.` : '.'}`;
  return cap(s);
}

/** Why a camera is not showing a picture, and what to try. The server's own sentence comes first. */
function whyBox(c, err, os) {
  const usb = c.kind !== 'network';
  const perm = {
    macos: h('li', {}, rich('<b>macOS camera permission:</b> open <b>System Settings &gt; Privacy &amp; Security &gt; Camera</b>, switch on your terminal app (or the app you started this from), then restart the app.')),
    windows: h('li', {}, rich('<b>Windows camera permission:</b> open <b>Settings &gt; Privacy &amp; security &gt; Camera</b> and allow desktop apps to use the camera.')),
    linux: h('li', {}, rich('<b>Linux permission:</b> run <code>sudo usermod -aG video $USER</code>, then log out and back in.')),
  };
  const steps = usb
    ? [h('li', {}, rich('<b>In use by another app:</b> close video calls, Photo Booth, other browser tabs or any program that shows this camera.')),
      ...(perm[os] ? [perm[os]] : [perm.macos, perm.windows, perm.linux]),
      h('li', {}, rich('<b>Unplugged:</b> unplug the camera and plug it into another USB port, directly into the computer (not through a hub).'))]
    : [h('li', {}, rich('<b>Open the address in a browser tab.</b> You should see live video. If you do not, the camera itself is the problem.')),
      h('li', {}, rich('<b>Is the other computer on?</b> A Raspberry Pi needs power and a few seconds to start.')),
      h('li', {}, rich('<b>Same network:</b> this computer and the camera must be on the same Wi-Fi or cable network. The Pi’s address can change: check it again.'))];
  const first = err || (usb ? 'The app gets no picture from this camera.' : 'The app cannot reach this network camera.');
  return h('div', { class: 'cam-why' },
    callout('warn', h('p', {}, first), 'No picture from this camera'),
    h('details', { open: '' }, h('summary', {}, 'What to try'), h('ol', {}, steps)));
}

export default {
  id: 'cameras', title: 'Cameras',
  render(root, ctx) {
    const api = ctx.api;
    const dead = { v: false };
    let cams = [], detected = [], readOnly = false, loaded = false, loadErr = '', os = '';
    let restartFlag = flag.get(), restartState = 'idle', restartNote = '', restartT0 = 0;
    let views = [], liveFns = [], lastListSig = '', lastFoundSig = '', lastApplySig = '', dirtyList = false;
    const say = (el, msg, kind = '') => { el.textContent = msg; el.className = el.className.replace(/\b(ok|warn|bad)\b/g, '').trim() + (kind ? ` ${kind}` : ''); };

    /* ---------- reading the list ---------- */
    const baseOf = () => (api.demo ? 'http://localhost:8000' : location.origin);
    const fallbackFromState = () => (ctx.state?.cameras || []).map((c, i) => ({ id: i, source: c.src, kind: /^https?:/.test(String(c.src)) ? 'network' : 'usb', name: `Camera ${i + 1}`, width: 0, height: 0, ok: !!c.ok, fps: c.fps, err: c.err || '', calibrated: !!ctx.state?.pp?.cams?.[i]?.cal }));
    async function load() {
      try {
        const r = await api.get('/api/suite/cameras');
        cams = Array.isArray(r?.cameras) ? r.cameras : []; detected = Array.isArray(r?.detected) ? r.detected : [];
        readOnly = false; loadErr = '';
      } catch (e) {
        loadErr = String(e.message || e);
        if (!cams.length) { cams = fallbackFromState(); detected = []; }
        readOnly = true;
      }
      loaded = true;
      drawAll();
    }
    /** Changes are waiting for a restart: the app said so after the last edit, or the saved list has a different number of cameras than are running. */
    const pending = () => restartFlag || (!readOnly && loaded && !!ctx.state?.cameras && cams.length !== ctx.state.cameras.length);

    /* ---------- the frame ---------- */
    const applySlot = h('div', { 'aria-live': 'polite' }), listSlot = h('div'), foundSlot = h('div');
    const mapBox = h('div');
    const msgEl = h('p', { class: 'msg', role: 'status' });
    const netUrl = h('input', { class: 'input', id: 'cam-url', type: 'url', placeholder: 'http://192.168.1.20:8000/raw.mjpg', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'cam-url-hint' });
    const netName = h('input', { class: 'input', id: 'cam-name', type: 'text', placeholder: 'Raspberry Pi camera', maxlength: '60', autocomplete: 'off' });
    const netAdd = named(button('Add network camera', { kind: 'primary', icon: 'plug' }), 'Add network camera');
    const netWhy = h('p', { class: 'why' });
    const origin = baseOf();
    const agent = h('section', { class: 'card cam-agent' },
      h('h3', {}, icon('terminal'), 'Use it from an AI agent or a script'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Everything on this page is also a plain web address, so Claude, Codex or a shell script can look at the table and teach it the same way you do.'),
      h('p', { class: 'step-lbl' }, '1. Take a picture of camera 1 (a JPEG file):'),
      copyBox(`curl -o table.jpg ${origin}/api/suite/snapshot/0.jpg`),
      h('p', { class: 'step-lbl' }, '2. Make the arm limp. It lowers itself onto the table first and then lets go, so keep your hands off it until /api/state says pp.limp is true:'),
      copyBox(`curl -X POST ${origin}/api/pp/rest`),
      h('p', { class: 'step-lbl' }, '3. Touch a spot with the closed jaw tips, hold still, then send where that spot is in the picture (u and v are pixels in the 640 x 480 picture):'),
      copyBox(`curl -X POST ${origin}/api/pp/teach -H 'Content-Type: application/json' -d '{"u": 320, "v": 240}'`),
      h('p', { class: 'step-lbl' }, '4. Read the result: taught is the number of spots, fit_mm is the error:'),
      copyBox(`curl -s ${origin}/api/state | python3 -c "import sys,json; p=json.load(sys.stdin)['pp']; print(p['taught'], p['fit_mm'], p['status'])"`),
      api.demo ? h('p', { class: 'muted', style: { margin: 0, fontSize: '.86rem' } }, 'In the demo there is no real server behind these addresses. On your own computer the address is whatever this page shows in the address bar.') : null);

    root.append(h('div', { class: 'cams' },
      pageHead('Get started · step 5 of 5', 'Cameras', 'See what each camera sees, add or remove one, then show the arm where the table is. Cameras are optional until you want pick and place.'),
      applySlot,
      h('section', { 'aria-labelledby': 'cams-h' }, h('h2', { id: 'cams-h' }, 'Your cameras'), listSlot),
      h('section', { 'aria-labelledby': 'add-h' }, h('h2', { id: 'add-h' }, 'Add a camera'),
        h('div', { class: 'cam-add-grid' },
          h('div', { class: 'stack-sm' }, h('h3', {}, 'Found on this computer'), foundSlot),
          h('form', { class: 'card cam-form', onsubmit: (e) => { e.preventDefault(); netAdd.click(); } },
            h('h3', {}, 'Network camera'),
            h('p', { class: 'hint', id: 'cam-url-hint' }, rich('Use this for a camera on another computer, such as a Raspberry Pi. Type the address it shares its picture on, like <code>http://&lt;pi&gt;:8000/raw.mjpg</code>, where <code>&lt;pi&gt;</code> is the Pi’s IP address or name. Open it in a browser tab first: you should see live video.')),
            h('div', { class: 'field' }, h('label', { for: 'cam-url' }, 'Address (MJPEG stream)'), netUrl),
            h('div', { class: 'field' }, h('label', { for: 'cam-name' }, 'Name (optional)'), netName),
            h('div', { class: 'row' }, netAdd), netWhy, msgEl))),
      h('section', { 'aria-labelledby': 'map-h' }, h('h2', { id: 'map-h' }, 'Map the table'), mapBox),
      agent));

    /* ---------- add (network) ---------- */
    const urlOk = () => /^https?:\/\/[^\s/]+/i.test(netUrl.value.trim());
    const syncNet = () => {
      gate(netAdd, readOnly ? 'The camera list could not be read, so nothing can be added right now' : !netUrl.value.trim() ? 'Type the camera address first' : !urlOk() ? 'The address must start with http:// or https://' : '');
      whyLine(netWhy, [netAdd]);
    };
    netUrl.addEventListener('input', () => { syncNet(); say(msgEl, ''); });
    netAdd.onclick = safe(async () => {
      const src = netUrl.value.trim(), name = netName.value.trim();
      netAdd.disabled = true; say(msgEl, 'Got it. Checking the address…');
      try {
        const r = await api.post('/api/suite/cameras', { action: 'add', source: src, name: name || undefined });
        if (r?.restart_needed !== false) { restartFlag = true; flag.set(true); }
        netUrl.value = ''; netName.value = '';
        say(msgEl, 'Added. It starts when you press Apply changes below.', 'ok');
        toast('<b>Camera added.</b> Press <b>Apply changes</b> to start it.', 'ok');
        await load();
      } catch (e) { say(msgEl, String(e.message || e), 'bad'); }
      finally { syncNet(); }
    });

    /* ---------- restart ---------- */
    function drawApply(force) {
      const pend = pending();
      const sig = `${pend}|${restartState}|${restartNote}`;
      if (!force && sig === lastApplySig) return;
      lastApplySig = sig;
      if (restartState === 'working') {
        const secs = h('span', {}, '0');
        applySlot.replaceChildren(h('div', { class: 'cam-apply working', role: 'status' }, h('div', { class: 'spin' }), h('p', {}, h('b', {}, 'Restarting… '), 'The app is starting again. This usually takes about 5 seconds. Waiting for it to answer (', secs, ' s).')));
        restartT0 = restartT0 || Date.now();
        applySlot.dataset.secs = '1'; applySlot._secs = secs;
      } else if (restartState === 'failed') {
        const again = button('Try again', { kind: 'primary', onClick: safe(() => waitBack()) });
        applySlot.replaceChildren(h('div', { class: 'cam-apply bad', role: 'alert' }, icon('alert'), h('p', {}, h('b', {}, 'The app has not come back. '), restartNote || 'If you started it from a terminal, look there for the reason, then run it again with so101 start.'), again, button('Open Help', { href: '#/help', kind: 'ghost' })));
      } else if (pend) {
        const apply = button('Apply changes (restarts the app)', { kind: 'primary', icon: 'arrow', onClick: () => askYes('The app restarts and this page reloads in about 5 seconds. The arm keeps its current state: a limp arm stays limp, a holding arm keeps holding. Restart now?', 'Yes, restart', safe(restart)) });
        applySlot.replaceChildren(h('div', { class: 'cam-apply' }, icon('alert'), h('p', {}, h('b', {}, 'Your camera changes are saved but not running yet. '), 'Cameras start, stop and rename when the app restarts.'), apply));
      } else { applySlot.replaceChildren(); applySlot._secs = null; }
    }
    async function restart() {
      restartState = 'working'; restartT0 = Date.now(); drawApply(true);
      let res;
      try { res = await api.post('/api/suite/restart'); }
      catch (e) { restartState = 'idle'; drawApply(true); throw e; }          // e.g. the arm is still moving: the server says so in a sentence
      if (api.demo && res?.restarting) { await sleep(600); restartFlag = false; flag.set(false); restartState = 'idle'; say(msgEl, ''); toast(rich(res.message || 'Nothing to restart in the demo.'), 'ok'); await ctx.refresh(); await load(); drawApply(true); return; }
      await waitBack();
    }
    async function waitBack() {
      restartState = 'working'; restartT0 = Date.now(); drawApply(true);
      let down = false;                                           // did we see it go away? (a very fast restart may never show as down)
      await sleep(1500);
      while (!dead.v && Date.now() - restartT0 < 90000) {
        try { await api.get('/api/suite/info'); if (down || Date.now() - restartT0 > 7000) break; } catch { down = true; }
        await sleep(1000);
        if (applySlot._secs) applySlot._secs.textContent = String(Math.round((Date.now() - restartT0) / 1000));
      }
      if (dead.v) return;
      let back = false;
      try { await api.get('/api/suite/info'); back = true; } catch { back = false; }
      if (!back) { restartState = 'failed'; restartNote = ''; drawApply(true); return; }
      restartFlag = false; flag.set(false); restartState = 'idle'; restartNote = ''; say(msgEl, '');
      await ctx.refresh(); await load(); drawAll(true);
      toast('<b>The app is back.</b> Your cameras are running.', 'ok');
    }

    /* ---------- camera cards ---------- */
    const editing = () => listSlot.contains(document.activeElement) && /INPUT/.test(document.activeElement.tagName);
    function destroyViews() { views.forEach((v) => v.destroy?.()); views = []; liveFns = []; }
    function camCard(c, i) {
      const view = cameraView(i, { label: `Camera ${i + 1}` });
      views.push(view);
      const nameEl = h('b', { class: 'cam-name' }, c.name || `Camera ${i + 1}`);
      const statusEl = h('span'), calEl = h('span');
      const meta = h('p', { class: 'cam-meta' });
      const whyHolder = h('div');
      const head = h('div', { class: 'cam-head' }, nameEl, h('div', { class: 'badges' }, badge(c.kind === 'network' ? 'Network' : 'USB'), statusEl, calEl));
      const renameBtn = button('Rename', { size: 'sm', icon: 'sliders' });
      const removeBtn = button('Remove', { size: 'sm', kind: 'ghost', icon: 'x' });
      const actions = h('div', { class: 'cam-actions' }, renameBtn, removeBtn);
      const form = h('form', { class: 'cam-rename', hidden: true });
      const nameIn = h('input', { class: 'input', type: 'text', maxlength: '60', 'aria-label': `Name for camera ${i + 1}`, value: c.name || '' });
      const save = button('Save name', { kind: 'primary', size: 'sm' }), nope = button('Cancel', { kind: 'ghost', size: 'sm' });
      form.append(nameIn, save, nope);
      renameBtn.onclick = () => { form.hidden = false; actions.hidden = true; nameIn.focus(); nameIn.select(); };
      const closeEdit = () => { form.hidden = true; actions.hidden = false; };
      nope.onclick = closeEdit;
      form.onsubmit = safe(async (e) => {
        e.preventDefault();
        const nm = nameIn.value.trim();
        if (!nm) { toast('Give the camera a name first.', 'warn'); return; }
        save.disabled = true;
        try { const r = await api.post('/api/suite/cameras', { action: 'rename', id: c.id ?? i, name: nm }); if (r?.restart_needed) { restartFlag = true; flag.set(true); } await load(); }
        finally { save.disabled = false; closeEdit(); }
      });
      removeBtn.onclick = () => askYes(`Remove <b>${esc(c.name || `Camera ${i + 1}`)}</b>? The app stops using it after the next restart. You can add it again any time.`, 'Yes, remove', safe(async () => {
        const r = await api.post('/api/suite/cameras', { action: 'remove', id: c.id ?? i });
        if (r?.restart_needed !== false) { restartFlag = true; flag.set(true); }
        toast('<b>Removed.</b> Press <b>Apply changes</b> to finish.', 'ok'); await load();
      }), { danger: true });
      if (readOnly) { gate(renameBtn, 'The camera list could not be read'); gate(removeBtn, 'The camera list could not be read'); }
      const snap = h('details', { class: 'cam-snap' }, h('summary', {}, 'Snapshot address (for scripts and AI agents)'), copyBox(`${baseOf()}/api/suite/snapshot/${i}.jpg`));
      let whyKey = '';
      liveFns.push(() => {
        const L = ctx.state?.cameras?.[i];
        const ok = L ? !!L.ok : !!c.ok, fps = L ? L.fps : c.fps, err = (L && L.err) || c.err || '';
        const st = ok ? `Working${fps ? ` · ${Math.round(fps)} fps` : ''}` : 'No picture';
        if (statusEl.dataset.k !== st) { statusEl.dataset.k = st; statusEl.replaceChildren(h('span', { class: `badge ${ok ? 'ok' : 'bad'}` }, ok ? icon('check') : icon('alert'), st)); }
        const cal = c.calibrated ?? ctx.state?.pp?.cams?.[i]?.cal;
        const ck = cal ? 'm' : 'n';
        if (calEl.dataset.k !== ck) { calEl.dataset.k = ck; calEl.replaceChildren(cal ? h('span', { class: 'badge ok' }, icon('check'), 'Mapped to the table') : h('span', { class: 'badge warn' }, 'Not mapped yet')); }
        const mt = [c.width && c.height ? `${c.width}×${c.height}` : '', c.kind === 'network' ? String(c.source) : (typeof c.source === 'number' || /^\d+$/.test(String(c.source)) ? `USB camera ${c.source}` : String(c.source))].filter(Boolean).join(' · ');
        if (meta.textContent !== mt) meta.textContent = mt;
        view.setStatus(ok, ok ? '' : (err || 'No picture yet'));
        const k = ok ? '' : `${c.kind}|${err}`;
        if (k !== whyKey) { whyKey = k; whyHolder.replaceChildren(...(ok ? [] : [whyBox(c, err, os)])); }
      });
      return h('article', { class: 'card cam-card', 'aria-label': c.name || `Camera ${i + 1}` }, head, view, meta, whyHolder, actions, form, snap);
    }
    function drawList(force) {
      const sig = JSON.stringify([cams.map((c) => [c.id, c.source, c.kind, c.name, c.width, c.height, c.calibrated]), loadErr, readOnly, loaded]);
      if (!force && sig === lastListSig) return;
      if (editing()) { dirtyList = true; return; }
      dirtyList = false; lastListSig = sig;
      destroyViews();
      if (!loaded) { listSlot.replaceChildren(h('div', { class: 'card' }, skeleton('40%', 18), h('div', { style: { height: '12px' } }), skeleton('100%', 180))); return; }
      const parts = [];
      if (loadErr) parts.push(callout('warn', h('p', {}, rich(`The app could not read its camera list: ${esc(loadErr)}. Showing what it knows from its live status. Adding and removing cameras is switched off until this works.`)), 'Camera list unavailable'));
      if (!cams.length) parts.push(empty('No camera yet', 'Plug in a USB camera (it shows up below in a few seconds), or add a network camera such as a Raspberry Pi. You can use the arm without a camera, but pick and place needs one.', button('Look again', { icon: 'camera', onClick: safe(async () => { await load(); toast('Looked again.', 'ok', 1500); }) })));
      else parts.push(h('div', { class: 'cam-grid' }, cams.map(camCard)));
      listSlot.replaceChildren(...parts);
      liveFns.forEach((f) => f());
    }

    /* ---------- found cameras ---------- */
    function drawFound(force) {
      const sig = JSON.stringify([detected.map((d) => [d.source, d.name, d.width, d.height, d.err]), readOnly, loaded]);
      if (!force && sig === lastFoundSig) return;
      lastFoundSig = sig;
      if (!loaded) { foundSlot.replaceChildren(skeleton('100%', 56)); return; }
      if (!detected.length) {
        foundSlot.replaceChildren(h('div', { class: 'card flat stack-sm' }, h('p', { class: 'muted', style: { margin: 0 } }, readOnly ? 'The camera list could not be read, so nothing can be listed.' : 'No other camera found. Plug a USB camera into the computer: this list updates by itself every few seconds.'),
          h('div', { class: 'row' }, button('Look again', { size: 'sm', icon: 'camera', onClick: safe(async () => { await load(); toast('Looked again.', 'ok', 1500); }) }))));
        return;
      }
      foundSlot.replaceChildren(h('div', { class: 'list cam-found' }, detected.map((d) => {
        const add = button('Add', { kind: 'primary', size: 'sm', icon: 'plug' });
        if (readOnly) gate(add, 'The camera list could not be read');
        add.onclick = safe(async () => {
          add.disabled = true;
          try {
            const r = await api.post('/api/suite/cameras', { action: 'add', source: d.source, name: d.name });
            if (r?.restart_needed !== false) { restartFlag = true; flag.set(true); }
            toast(`<b>${esc(d.name || 'Camera')} added.</b> Press <b>Apply changes</b> to start it.`, 'ok');
            await load();
          } finally { add.disabled = false; }
        });
        return h('div', { class: 'li' }, icon('camera'),
          h('div', { class: 'body' }, h('div', { class: 'title' }, d.name || String(d.source)),
            h('div', { class: 'detail' }, [d.kind === 'network' ? 'Network' : 'USB', d.width && d.height ? `${d.width}×${d.height}` : '', d.in_use ? 'already in use by this app' : ''].filter(Boolean).join(' · ')),
            d.err ? h('div', { class: 'detail', style: { color: 'var(--warn)' } }, `The app could not open it just now: ${d.err} You can still add it and fix that after.`) : null),
          add);
      })));
    }

    function drawAll(force) { drawApply(force); drawList(force); drawFound(force); syncNet(); }

    /* ================= Map the table ================= */
    let mapOpen = false, jawsClosed = false, adding = false, addFrom = 0, marks = [], pendingClick = null, mapUi = null, clickTimer = 0, wasAuto = false;
    const PP = () => ctx.state?.pp || null;

    function startReason() {
      const pp = PP(), f = ctx.arm('follower'), live0 = ctx.state?.cameras?.[0], c0 = cams[0];
      if (!pp) return { why: 'The pick & place engine is not running (the app started in camera-only mode)' };
      if (!live0 && !c0) return { why: 'Add a camera first', fix: ['Add a camera', '#add-h'] };
      if (!(live0 ? live0.ok : c0?.ok)) return { why: 'Camera 1 shows no picture yet: fix it above first' };
      if (!f || !f.online) return { why: 'The follower arm is not connected', fix: ['Find my arm', '#/motors'] };
      if (!f.calibrated) return { why: 'The follower arm is not calibrated yet', fix: ['Calibrate it', '#/calibrate'] };
      if (f.calib?.step && f.calib.step !== 'idle') return { why: 'The follower arm is being calibrated: finish that first', fix: ['Open Calibrate', '#/calibrate'] };
      if (pp.running) return { why: 'A pick & place job is running: press STOP first' };
      if (ctx.state?.teleop?.on) return { why: 'Leader to follower is running: stop it first', fix: ['Open Control', '#/control'] };
      return { why: '' };
    }

    function drawMapClosed() {
      const pp = PP(), n = pp?.taught || 0, mapped = n >= MIN_SPOTS;
      const startBtn = named(button(mapped ? 'Re-map the table' : 'Start mapping the table', { kind: 'primary', size: 'lg', icon: 'arrow', onClick: () => openMap() }), mapped ? 'Re-map the table' : 'Start mapping the table');
      const whyEl = h('p', { class: 'why' }), fix = h('a', { class: 'fixlink', href: '#', hidden: true });
      const sumBadges = h('div', { class: 'badges' });
      mapBox.replaceChildren(h('div', { class: 'stack' },
        h('div', { class: 'card flat stack-sm' }, h('div', { class: 'map-head' }, h('h3', {}, 'Camera 1 and the table'), sumBadges),
          h('p', { class: 'muted', style: { margin: 0 } }, rich('The arm has to know where each spot in the picture is on the table. This is the '), term('camera-mapping', 'camera mapping'), rich('. You teach it by touching a few spots with the gripper and clicking them in the picture. If the camera moves later, do it again. It uses camera 1, the one pick and place looks through.'))),
        preflight({
          title: 'Before you start', minutes: 3,
          needs: ['Camera 1 showing a picture of the table above', 'The follower arm connected and calibrated', 'A coin or the red keychain, to mark each spot', 'About 3 spots on the table in view of the camera, far apart'],
          hands: 'Both, but only once the arm is limp: one hand moves the gripper, the other uses the mouse. Keep your hands off the arm until this page says it is limp.',
          moves: 'Nothing moves by itself, except when you press <b>Lower the arm and make it limp</b>: the arm lowers itself onto the table and then lets go. Keep your hands clear until it says it is limp.',
          clear: 'The table area under the camera, so the arm can reach each spot and the camera sees it.',
          stop: 'Press the red <b>STOP</b> button at the top of the screen: the arm holds where it is. <b>Done</b>, or leaving this page, does not move the arm.',
        }),
        h('div', { class: 'map-start' }, startBtn, whyEl, fix)));
      mapUi = { closed: true, startBtn, whyEl, fix, sumBadges };
    }
    function liveClosed() {
      const u = mapUi, pp = PP(), n = pp?.taught || 0, r = startReason();
      gate(u.startBtn, r.why); whyLine(u.whyEl, [u.startBtn]);
      u.fix.hidden = !r.fix; if (r.fix) { u.fix.textContent = r.fix[0] + ' →'; u.fix.setAttribute('href', r.fix[1]); u.fix.onclick = r.fix[1] === '#add-h' ? (e) => { e.preventDefault(); document.getElementById('add-h')?.scrollIntoView({ behavior: 'smooth' }); } : null; }
      const key = `${n}|${pp?.fit_mm}`;
      if (u.sumBadges.dataset.k !== key) {
        u.sumBadges.dataset.k = key;
        u.sumBadges.replaceChildren(n >= MIN_SPOTS ? badge(`Mapped · ${n} spots${pp.fit_mm != null && n > MIN_SPOTS ? ` · fit ${pp.fit_mm.toFixed(1)} mm` : ''}`, n > MIN_SPOTS && pp.fit_mm != null && pp.fit_mm >= ROUGH_MM ? 'bad' : n > MIN_SPOTS && pp.fit_mm >= GOOD_MM ? 'warn' : 'ok') : badge(n ? `${n} of ${MIN_SPOTS} spots taught` : 'Not mapped yet', 'warn'));
      }
    }

    function openMap() {
      mapOpen = true; jawsClosed = false; adding = false; marks = []; pendingClick = null;
      buildMapOpen();
      tick();
    }
    async function closeMap() {
      const wasOn = PP()?.auto?.on;
      mapOpen = false; clearTimeout(clickTimer);
      mapUi?.view?.destroy?.(); mapUi = null;
      if (wasOn) { try { await api.post('/api/pp/auto', { on: false }); } catch { /* the page is closing it anyway */ } }
      drawMapClosed(); tick();
    }

    function buildMapOpen() {
      mapUi?.view?.destroy?.();
      const view = cameraView(0, { label: 'Camera 1: click here', onClick: (u, v) => safe(() => teachAt(u, v))() });
      const clickMsg = h('p', { class: 'map-msg', role: 'status', 'aria-live': 'polite' });
      const statusEl = h('p', { class: 'map-status' });
      const countEl = h('b'), dotsEl = h('div', { class: 'map-dots', 'aria-hidden': 'true' }, Array.from({ length: SPOTS }, (_, k) => h('i', { class: k < MIN_SPOTS ? 'req' : '' })));
      const fitEl = h('div', { class: 'map-fit info' });
      const undo = named(button('Undo last spot', { size: 'sm', icon: 'back' }), 'Undo last spot');
      const clearBtn = named(button('Clear all', { size: 'sm', kind: 'ghost', icon: 'x' }), 'Clear all');
      const done = named(button('Done', { kind: 'primary', icon: 'check' }), 'Done');
      const btnWhy = h('p', { class: 'why' });
      const holdBar = h('i'), chips = h('div', { class: 'map-chips' }), autoMsg = h('p', { class: 'map-msg' });
      const autoPanel = h('div', { class: 'card flat map-auto', hidden: true }, h('b', {}, 'Hands-free (Auto)'), autoMsg, h('div', { class: 'map-hold', role: 'progressbar', 'aria-label': 'Hold still: saving the spot', 'aria-valuemin': '0', 'aria-valuemax': '100' }, holdBar), chips);
      const modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'How to teach the spots' });
      const bClick = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Click the picture'), bAuto = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Hands-free (Auto)');
      modeSeg.append(bClick, bAuto);
      const modeNote = h('p', {});
      const stepSlot = h('div');
      const stages = h('ol', { class: 'stepper map-stages', 'aria-label': 'Mapping steps' }, STAGES.map((s, i) => h('li', {}, h('b', {}, h('span', { class: 'n' }, `${i + 1}.`), h('span', { class: 't' }, ` ${s}`)))));

      bClick.onclick = safe(async () => { if (PP()?.auto?.on) { await api.post('/api/pp/auto', { on: false }); await ctx.refresh(); } });
      bAuto.onclick = safe(async () => { if (!PP()?.auto?.on) { await api.post('/api/pp/auto', { on: true }); await ctx.refresh(); } });
      undo.onclick = safe(async () => { undo.disabled = true; try { await api.post('/api/pp/undo'); await ctx.refresh(); say(clickMsg, 'Last spot removed.', 'ok'); } finally { tick(); } });
      clearBtn.onclick = () => askYes(`Remove all ${PP()?.taught || 0} taught spots? You would have to teach them again.`, 'Yes, clear them', safe(async () => { await api.post('/api/pp/clear'); marks = []; adding = false; await ctx.refresh(); say(clickMsg, 'All spots cleared.', 'ok'); }), { danger: true });
      done.onclick = safe(closeMap);

      mapBox.replaceChildren(h('div', { class: 'stack' }, stages,
        h('div', { class: 'map-grid' },
          h('div', { class: 'map-left' }, view,
            h('div', { class: 'card map-panel' },
              clickMsg,
              h('div', { class: 'map-count' }, countEl, dotsEl), fitEl, statusEl,
              autoPanel,
              h('div', { class: 'map-btns' }, undo, clearBtn, done), btnWhy)),
          h('div', { class: 'map-right' },
            h('div', { class: 'card tight map-mode' }, h('b', {}, 'How do you want to teach the spots?'), modeSeg, modeNote),
            stepSlot))));
      mapUi = { closed: false, view, clickMsg, statusEl, countEl, dotsEl, fitEl, undo, clearBtn, done, btnWhy, holdBar, chips, autoMsg, autoPanel, bClick, bAuto, modeNote, stepSlot, stages, stepKey: '', marksKey: '', lastCount: -1 };
    }

    /* ----- the click ----- */
    async function teachAt(u, v) {
      const pp = PP(), M = mapUi;
      if (!M || M.closed) return;
      if (!pp) { say(M.clickMsg, 'The arm engine is not running, so spots cannot be taught.', 'warn'); return; }
      if (pendingClick) return;
      if (!pp.limp) { say(M.clickMsg, 'Nothing saved: the arm is stiff. Do not touch it: press Lower the arm and make it limp, then click again.', 'warn'); autoClear(); return; }
      if (pp.running || ctx.state?.teleop?.on) { say(M.clickMsg, 'Nothing saved: the arm is busy. Stop the job first.', 'warn'); autoClear(); return; }
      const before = pp.taught || 0, n = before + 1;
      pendingClick = { u, v, n };
      say(M.clickMsg, `Got it: spot ${n}. Checking it…`);
      M.marksKey = ''; paintMarks();
      try {
        await api.post('/api/pp/teach', { u, v });
        await ctx.refresh();
      } finally { pendingClick = null; }
      const after = PP();
      if (after && (after.taught || 0) > before) {
        marks = marks.filter((m) => m.n <= before).concat([{ u, v, n: after.taught }]);
        say(M.clickMsg, `Spot ${after.taught} saved. ${after.taught < MIN_SPOTS ? `Move to a new spot (${MIN_SPOTS - after.taught} more needed).` : after.taught === MIN_SPOTS ? 'The table is mapped. Teach a 4th spot to test it.' : ''}`, 'ok');
        if (adding) adding = false;
      } else {
        say(M.clickMsg, `Nothing saved. ${sayStatus(after?.status) || 'The arm engine did not take that spot.'}`, 'warn');
      }
      M.marksKey = ''; paintMarks(); autoClear(); tick();
    }
    function autoClear() { clearTimeout(clickTimer); clickTimer = setTimeout(() => { if (mapUi?.clickMsg) say(mapUi.clickMsg, ''); }, 12000); }
    function paintMarks() {
      const M = mapUi; if (!M || M.closed) return;
      const list = [...marks.map((m) => ({ u: m.u, v: m.v, label: m.n, kind: 'ok' })), ...(pendingClick ? [{ u: pendingClick.u, v: pendingClick.v, label: pendingClick.n, kind: 'warn' }] : [])];
      const key = JSON.stringify(list);
      if (M.marksKey === key) return;
      M.marksKey = key; M.view.setMarks(list);
    }

    /* ----- the cards for each stage ----- */
    function stepFor(pp) {
      const n = pp?.taught || 0;
      if (!pp) return 1;
      if (n >= MIN_SPOTS && !adding) return 4;
      if (!pp.limp) return 1;
      if (!jawsClosed) return 2;
      return 3;
    }
    function buildStep(step, pp, auto) {
      const n = pp?.taught || 0, k = n + 1, total = Math.max(SPOTS, k);
      if (step === 1) {
        // the arm is stiff (or its state is unknown): nobody touches it yet. The card lowers it onto the table, THEN lets go, and says so.
        const limpC = limpCard(ctx, { title: 'Make the arm limp first', then: () => tick() });
        return { node: limpC, live: () => limpC.update() };
      }
      if (step === 2) {
        const ok = button('The jaws are closed', { kind: 'primary', size: 'lg', icon: 'check', onClick: () => { jawsClosed = true; tick(); } });
        return { node: stepCard({
          n: 2, total: 4, id: 'jaws', title: 'Close the jaws so the two tips meet',
          safety: '<b>The arm is limp now.</b> It moves freely and falls back down when you let go. Keep your fingers out of the gap between the jaws.',
          where: rich('<b>Jaw</b>: one of the two pinching pieces at the end of the arm. The <b>fixed jaw</b> never moves by itself. The <b>moving jaw</b> swings. Their pointed ends are the <b>tips</b>.'),
          do: ['Hold the back block (the square part above the jaws) with one hand.', 'With your other hand, push the moving jaw closed until its tip touches the fixed jaw’s tip.', `Press <b>The jaws are closed</b>.`],
          know: txt('The two tips touch and look like one point. That point is the part that touches the table.'),
          ifNot: txt('If the jaw swings open again when you let go, close it again just before each spot.'),
          diagram: jawTips(), caption: 'Side view, gripper pointing straight down. The orange dot is the point that touches the table.',
          footer: [ok],
        }), live: () => {} };
      }
      if (step === 3) {
        const goal = n < MIN_SPOTS ? `${MIN_SPOTS - n} more to map the table` : n === MIN_SPOTS ? 'one more to test the map' : 'one more to improve the fit';
        const dg = h('div', { class: 'map-diagrams' }, clickHere(), rightWrong({ node: spreadSpots('good'), caption: '<b>Right.</b> Spread out: near, middle, far.' }, { node: spreadSpots('bad'), caption: '<b>Wrong.</b> Bunched together.' }));
        const cue = progressCue('spot', k, total);
        if (auto) {
          return { node: stepCard({
            n: 3, total: 4, id: 'spot', title: `Spot ${k} of ${total}, hands-free (${goal})`, minutes: null,
            safety: '<b>The arm is limp now.</b> Keep your fingers out of the gaps between the parts.',
            where: 'On the table where camera 1 can see. Spread the spots out: near the arm, in the middle, far away.',
            do: ['Lay the red keychain flat on the table at a new spot.', 'Hold the gripper pointing down and touch the closed jaw tips to the middle of the keychain.', 'Hold still until the bar under the picture is full (about 1.5 seconds).'],
            how: 'No clicking: the app saves the spot by itself when the arm is held still on the keychain.',
            know: txt('The bar fills, then the page says “Spot saved” and the bar empties.'),
            ifNot: txt('The message under the picture says what is missing: tilt, keychain not seen, or too close to an earlier spot.'),
            then: n + 1 < MIN_SPOTS ? 'Move the keychain to the next spot and repeat.' : 'After spot 3 the table is mapped. A 4th spot tests it.',
            diagram: dg, caption: 'Top view of the table, the arm at the bottom of the picture.', footer: [cue],
          }), live: () => {} };
        }
        return { node: stepCard({
          n: 3, total: 4, id: 'spot', title: `Spot ${k} of ${total}: touch the table, then click it (${goal})`,
          safety: '<b>The arm is limp now.</b> Keep your fingers out of the gaps between the parts.',
          where: 'On the table where camera 1 can see. Spread the spots out: near the arm, in the middle, far away (the right and wrong pictures).',
          do: ['Lay a coin or the red keychain flat on the table at a new spot.', 'Hold the gripper pointing down and touch the closed jaw tips to the middle of the coin.', 'Hold still for 2 seconds.', 'Click the middle of the coin in the camera picture labelled <b>Camera 1: click here</b>.'],
          how: 'The gripper hides its own tip from the camera, but not the coin, so click the coin. Keep spots at least a hand’s width apart.',
          know: txt('A numbered green ring appears on the picture and the page says “Spot saved”.'),
          ifNot: txt('Nothing was saved if a message says the arm is stiff or has not moved: read it under the picture and fix that first.'),
          then: n + 1 < MIN_SPOTS ? 'Move to a new spot and repeat.' : 'After spot 3 the table is mapped. A 4th spot tests it.',
          diagram: dg, caption: 'Top view of the table, the arm at the bottom of the picture. The first picture is what camera 1 shows.', footer: [cue],
        }), live: () => {} };
      }
      /* step 4: the fit */
      const again = button('Add another spot', { icon: 'plug', onClick: () => { adding = true; addFrom = PP()?.taught || 0; tick(); } });
      const finish = button('Done', { kind: 'primary', size: 'lg', icon: 'check', onClick: safe(closeMap) });
      const fit = fitInfo(pp);
      return { node: stepCard({
        n: 4, total: 4, id: 'fit', title: 'Check the fit',
        where: rich('The fit number under the picture. It is how far, on average, the map is off for the spots you taught, in millimetres.'),
        do: [fit.kind === 'info' ? 'Press <b>Add another spot</b> and teach a 4th spot to test the map.' : fit.kind === 'ok' ? 'Press <b>Done</b>.' : 'Fix the fit: press <b>Undo last spot</b> and teach that spot again, or <b>Clear all</b> and start over.'],
        how: `Good is under about ${GOOD_MM} mm. A bad fit means the arm would reach for the wrong place on the table.`,
        know: txt(fit.kind === 'ok' ? `The fit says Good (${pp.fit_mm.toFixed(1)} mm).` : 'The fit line under the picture says Good.'),
        ifNot: txt('Spots bunched together, a click away from where the tips touched, a tilted gripper or a camera that moved all make the fit worse. Spread the spots out and be exact with each click.'),
        footer: [finish, again],
      }), live: () => {} };
    }
    function fitInfo(pp) {
      const n = pp?.taught || 0, f = pp?.fit_mm;
      if (n < MIN_SPOTS) return { kind: 'info', text: `Need at least ${MIN_SPOTS} spots. ${n ? `${n} taught so far.` : 'None taught yet.'}` };
      if (n === MIN_SPOTS) return { kind: 'info', text: 'Mapped with 3 spots. Three spots always fit perfectly, so the fit number says nothing yet. Teach a 4th spot: it is a real test.' };
      if (f == null) return { kind: 'info', text: `${n} spots taught. The app has not worked out a fit yet.` };
      if (f < GOOD_MM) return { kind: 'ok', text: `Good fit: the picture and the table agree to about ${f.toFixed(1)} mm. You can trust it.` };
      if (f < ROUGH_MM) return { kind: 'warn', text: `Rough fit: about ${f.toFixed(1)} mm off. It may miss small things. Undo the last spot and teach it again more carefully, or add one or two more spots.` };
      return { kind: 'bad', text: `Poor fit: about ${f.toFixed(1)} mm off, so the arm would miss. Usual causes: a click away from where the tips touched, a tilted gripper, bunched spots, or a camera that moved. Press Clear all and start again with the spots spread out.` };
    }
    const AUTO_WHY = (A, n) => ({
      limp: 'The arm is stiff: do not touch it. Press Lower the arm and make it limp.',
      tilt: `Tilt the gripper more downward: it is at ${A.tilt}° and must be under 50°.`,
      kc: 'I cannot see the keychain. Lay it flat on the table where camera 1 can see it.',
      height: `The tip is ${Math.abs(A.dz || 0)} mm ${A.dz > 0 ? 'above' : 'below'} the earlier spots. Touch the table with the tips.`,
      dup: 'Already saved here. Move the keychain and the arm at least 4 cm to a new spot.',
      hold: 'Hold still…',
      error: `Problem: ${A.err || 'unknown'}`,
      saved: `Spot ${A.n || n} saved.`,
      move: `Spot ${n + 1}: keychain flat, gripper closed and pointing down, tips on its middle. Hold still.`,
    }[A.why] || `Spot ${n + 1}: keychain flat, gripper closed and pointing down, tips on its middle. Hold still.`);

    /* ----- live updates for the open mapper ----- */
    function liveOpen() {
      const M = mapUi, pp = PP();
      if (!pp) { say(M.clickMsg, 'The arm engine is not running, so the table cannot be mapped right now.', 'warn'); return; }
      const n = pp.taught || 0, A = pp.auto || {}, auto = !!A.on;
      if (adding && n > addFrom) adding = false;                  // the extra spot arrived (by click or by Auto): back to the fit
      if (auto !== wasAuto) { wasAuto = auto; M.stepKey = ''; }
      marks = marks.filter((m) => m.n <= n);
      const step = stepFor(pp), r = startReason();
      const key = JSON.stringify([step, step === 3 ? Math.min(n, SPOTS) : 0, auto, step === 4 ? [n, pp.fit_mm != null ? Math.round(pp.fit_mm * 10) : null] : 0]);
      if (key !== M.stepKey) { M.stepKey = key; const s = buildStep(step, pp, auto); M.stepSlot.replaceChildren(s.node); M.stepLive = s.live; }
      M.stepLive?.(pp, r);
      [...M.stages.children].forEach((li, i) => { li.className = i + 1 === step ? 'cur' : i + 1 < step ? 'done' : ''; li.setAttribute('aria-current', i + 1 === step ? 'step' : 'false'); });
      // counts, dots, fit
      const ct = n < MIN_SPOTS ? `${n} of ${MIN_SPOTS} spots` : `${n} spots`;
      if (M.countEl.textContent !== ct) M.countEl.textContent = ct;
      [...M.dotsEl.children].forEach((d, i) => d.classList.toggle('on', i < n));
      const f = fitInfo(pp), fk = `${f.kind}|${f.text}`;
      if (M.fitEl.dataset.k !== fk) { M.fitEl.dataset.k = fk; M.fitEl.className = `map-fit ${f.kind}`; M.fitEl.replaceChildren(icon(f.kind === 'ok' ? 'check' : f.kind === 'info' ? 'info' : 'alert'), h('p', {}, f.text)); }
      const st = pp.status ? `Arm engine: ${sayStatus(pp.status).replace(n === MIN_SPOTS ? / Fit error [\d.]+ mm\./ : /$^/, '')}` : '';
      if (M.statusEl.textContent !== st) M.statusEl.textContent = st;
      // mode switch, auto panel
      M.bClick.setAttribute('aria-pressed', String(!auto)); M.bAuto.setAttribute('aria-pressed', String(auto));
      const mn = auto ? 'The app saves a spot by itself when you hold the gripper still on the red keychain. No clicking. It still takes a click if you want one.' : 'You click each spot in the picture. This works with any coin or marker, with no extra detection needed.';
      if (M.modeNote.textContent !== mn) M.modeNote.textContent = mn;
      M.autoPanel.hidden = !auto;
      if (auto) {
        const msg = AUTO_WHY(A, n);
        if (M.autoMsg.textContent !== msg) { M.autoMsg.textContent = msg; M.autoMsg.className = `map-msg ${A.why === 'saved' ? 'ok' : ['tilt', 'kc', 'height', 'dup', 'error', 'limp'].includes(A.why) ? 'warn' : ''}`; }
        M.holdBar.style.width = `${Math.round((A.holding || 0) * 100)}%`;
        const ck = JSON.stringify([pp.limp, A.kc, A.tilt]);
        if (M.chips.dataset.k !== ck) {
          M.chips.dataset.k = ck;
          const c = (ok, label) => chip(label, ok ? 'ok' : 'warn');
          M.chips.replaceChildren(c(pp.limp, 'Arm limp'), c(A.kc === 'seen' || A.kc === 'hidden', `Keychain ${A.kc === 'hidden' ? 'under gripper' : A.kc === 'seen' ? 'seen' : 'not seen'}`), c((A.tilt || 0) <= 50, `Tilt ${A.tilt == null ? '–' : `${A.tilt}°`}`));
        }
      }
      // buttons
      gate(M.undo, n < 1 ? 'No spots taught yet' : pp.running ? 'A job is running' : '');
      gate(M.clearBtn, n < 1 ? 'No spots taught yet' : pp.running ? 'A job is running' : '');
      gate(M.done, n < MIN_SPOTS ? `Teach at least ${MIN_SPOTS} spots first` : '');
      whyLine(M.btnWhy, [M.undo, M.clearBtn, M.done]);
      // the camera picture
      const L = ctx.state?.cameras?.[0], ok = L ? !!L.ok : !!cams[0]?.ok;
      M.view.setStatus(ok, ok ? '' : (L?.err || cams[0]?.err || 'Camera 1 shows no picture'));
      paintMarks();
    }

    /* ---------- tick: everything that must follow the live state, in place ---------- */
    function tick() {
      liveFns.forEach((f) => f());
      drawApply();
      if (!mapUi) drawMapClosed();
      if (mapUi?.closed) liveClosed(); else if (mapUi) liveOpen();
      if (dirtyList && !editing()) drawList(true);
    }
    const offs = [ctx.subscribe(() => tick())];
    const poll = setInterval(() => { if (!document.hidden && !restartState.startsWith('w')) load(); }, 4000);
    (async () => {
      try { const p = await api.get('/api/suite/platform'); os = p?.os || ''; } catch { os = ''; }
      await load();
    })();
    drawAll(true);

    return () => {
      dead.v = true; clearInterval(poll); clearTimeout(clickTimer);
      offs.forEach((f) => f());
      destroyViews(); mapUi?.view?.destroy?.();
      if (PP()?.auto?.on) api.post('/api/pp/auto', { on: false }).catch(() => {});   // Auto keeps recording spots on the server until it is told to stop
    };
  },
};
