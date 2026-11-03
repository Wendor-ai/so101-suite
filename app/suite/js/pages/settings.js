// Settings (#/settings, deep link #/settings/<group>): nine groups, one panel each.
// Every control writes through ctx.setSetting (server store in the live app, browser storage in the demo) and
// reads its value back from ctx.settings, so what you see is what is saved. The 3D-view options are the old
// dashboard's own look-and-feel, kept in localStorage 'so101-ui' with the same keys.
import { h, icon, button, badge, callout, copyBox, askYes, toast, safe, rich, loadCss, pageHead, skeleton } from '../ui.js';
import { api } from '../api.js';
import { ACCENT_NAMES, applySettings, poseFromArm, normalized, JOINT_LABEL } from '../state.js';

loadCss(new URL('../../css/pages/settings.css', import.meta.url).href);

const REPO = 'https://github.com/Wendor-ai/so101-suite';
// Same colours as ACCENTS in state.js (not exported there): only used to paint the swatches.
const SWATCH = { orange: '#ff8a1f', blue: '#4cc2ff', green: '#3ddc97', violet: '#a78bfa', pink: '#ff6b9a', yellow: '#f5c518' };
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const signed = (n, unit = '', digits = 0) => (n == null || Number.isNaN(n) ? '—' : `${Math.abs(n) < 0.5 * 10 ** -digits ? '' : n < 0 ? '−' : '+'}${Math.abs(n).toFixed(digits)}${unit}`);

/** What each saved setting accepts. Also the whitelist for Import. */
const oneOf = (list) => (v) => list.includes(v);
const isBool = (v) => typeof v === 'boolean';
const SCHEMA = {
  ui: { theme: oneOf(['auto', 'dark', 'light']), accent: oneOf(ACCENT_NAMES), guide: oneOf(['beginner', 'expert']), units: oneOf(['deg', 'norm']), textSize: oneOf(['small', 'normal', 'large']), reduceMotion: isBool },
  safety: { confirm_before_move: isBool, speed_preset: oneOf(['gentle', 'normal']), stop_shortcut: isBool },
  adv: { trace: isBool, traceRaw: isBool, modulesEnabled: isBool },
};
const DEF = { 'ui.theme': 'auto', 'ui.accent': 'orange', 'ui.guide': 'beginner', 'ui.units': 'deg', 'ui.textSize': 'normal', 'ui.reduceMotion': false, 'safety.confirm_before_move': true, 'safety.speed_preset': 'gentle', 'safety.stop_shortcut': true, 'adv.trace': false, 'adv.traceRaw': false, 'adv.modulesEnabled': true };
const read = (ctx, path) => { const [g, k] = path.split('.'); const v = ctx.settings?.[g]?.[k]; return v === undefined || v === null ? DEF[path] : v; };

/* ---------- the old dashboard's look options (localStorage 'so101-ui', same keys) ---------- */
const V3_KEY = 'so101-ui';
const V3_DEFAULTS = { theme: 'studio', arm: 'white', floor: 'grid', view: 'hero', layout: 'side', bright: 1, labels: true, ghost: true, trail: true, reach: true, pulse: false, dust: false };
const V3_CHOICES = {
  theme: ['Theme', [['studio', 'Studio'], ['daylight', 'Daylight'], ['blueprint', 'Blueprint'], ['carbon', 'Carbon'], ['sunset', 'Sunset']]],
  arm: ['Arm colour', [['white', 'White'], ['original', 'Original yellow'], ['carbon', 'Carbon'], ['orange', 'Orange'], ['blue', 'Blue']]],
  floor: ['Floor', [['grid', 'Grid'], ['fine', 'Fine grid'], ['plain', 'Plain'], ['mirror', 'Glossy mirror']]],
  view: ['Camera angle', [['orbit', 'Orbit'], ['hero', 'Hero'], ['top', 'Top-down'], ['side', 'Side'], ['front', 'Front'], ['close', 'Close-up']]],
  layout: ['Arm layout', [['side', 'Leader left, follower right'], ['depth', 'Stacked (original)']]],
};
const V3_TOGGLES = [['labels', 'Joint-angle labels'], ['ghost', 'Mid-pose ghost'], ['trail', 'Gripper trail'], ['reach', 'Reach ring'], ['pulse', 'Sonar pulses'], ['dust', 'Floating dust']];
function v3Read() {
  try { return { ...V3_DEFAULTS, ...JSON.parse(localStorage.getItem(V3_KEY) || '{}') }; } catch { return { ...V3_DEFAULTS }; }
}
function v3Write(obj) {
  try { localStorage.setItem(V3_KEY, JSON.stringify(obj)); return true; } catch { return false; }
}
/** Keep only values the dashboard understands (used when importing a file). */
function v3Clean(raw) {
  const out = {};
  let skipped = 0;
  if (!raw || typeof raw !== 'object') return { out, skipped };
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  for (const [k, [, opts]] of Object.entries(V3_CHOICES)) if (has(k)) { if (opts.some(([v]) => v === raw[k])) out[k] = raw[k]; else skipped++; }
  for (const [k] of V3_TOGGLES) if (has(k)) { if (typeof raw[k] === 'boolean') out[k] = raw[k]; else skipped++; }
  if (has('bright')) { if (typeof raw.bright === 'number' && raw.bright >= 0.6 && raw.bright <= 1.6) out.bright = raw.bright; else skipped++; }
  return { out, skipped };
}

const GROUPS = [
  { id: 'appearance', label: 'Appearance', icon: 'sparkles', lead: 'How the app looks. Changes apply at once and are remembered.' },
  { id: 'explanations', label: 'Explanations', icon: 'book', lead: 'How much the app explains as you go.' },
  { id: 'units', label: 'Units', icon: 'sliders', lead: 'How joint positions are written. In both, 0 is the middle of the range you calibrated.' },
  { id: '3d-view', label: '3D view', icon: 'cube', lead: 'How the 3D arm looks in the Control dashboard.' },
  { id: 'devices', label: 'Devices', icon: 'usb', lead: 'Your arms, the USB ports they use, and your cameras.' },
  { id: 'safety', label: 'Safety', icon: 'shield', lead: 'How careful the app is before and while an arm moves.' },
  { id: 'data', label: 'Data', icon: 'copy', lead: 'Where your settings live, and how to back them up or start over.' },
  { id: 'advanced', label: 'Advanced', icon: 'terminal', lead: 'For when something is wrong, or you want to look under the hood.' },
  { id: 'about', label: 'About', icon: 'info', lead: 'Version, licence and who made what.' },
];

export default {
  id: 'settings', title: 'Settings',
  render(root, ctx, route) {
    let P = null; // the open panel: { offs: [], syncs: [], flash }
    let dead = false;
    const allOffs = [];
    const requested = route?.args?.[0];
    let current = GROUPS.some((g) => g.id === requested) ? requested : 'appearance';

    /* ----- saving ----- */
    async function resync() {
      try { ctx.settings = await api.get('/api/suite/settings'); applySettings(ctx.settings); ctx.notify(); } catch { /* keep what we have */ }
    }
    const save = safe(async (path, value) => {
      try { await ctx.setSetting(path, value); P?.flash(); } catch (e) { await resync(); throw e; }
    });

    /* ----- small control builders (each registers a sync so it always shows the saved value) ----- */
    let rowId = 0;
    function seg(label, options, get, pick) {
      const el = h('div', { class: 'seg', role: 'group', 'aria-label': label });
      const bs = options.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => pick(v) }, t));
      el.append(...bs);
      const sync = () => { const cur = get(); options.forEach(([v], i) => bs[i].setAttribute('aria-pressed', String(v === cur))); };
      sync(); P.syncs.push(sync);
      return el;
    }
    const segSetting = (label, options, path) => seg(label, options, () => read(ctx, path), (v) => save(path, v));
    /** guard(next) may return true to take over (e.g. to ask first); it must then call commit itself. */
    function sw(label, get, commit, guard, tag = 'label') {
      const input = h('input', { type: 'checkbox', 'aria-label': label });
      input.addEventListener('click', (e) => {
        if (guard && guard(input.checked)) { e.preventDefault(); return; }
        commit(input.checked);
      });
      const sync = () => { input.checked = !!get(); };
      sync(); P.syncs.push(sync);
      return Object.assign(h(tag, { class: 'switch' }, input, h('i')), { input, sync });
    }
    const swSetting = (label, path, guard) => sw(label, () => read(ctx, path), (v) => save(path, v), guard);
    const row = (title, desc, control, extra) => {
      const id = `set-row-${++rowId}`;
      return h('div', { class: 'set-row' },
        h('div', { class: 'info' }, h('div', { class: 't', id }, title), desc ? h('p', { class: 'd' }, typeof desc === 'string' ? rich(desc) : desc) : null, extra || null),
        h('div', { class: 'ctl' }, control));
    };
    const rows = (...kids) => h('div', { class: 'set-rows' }, kids.filter(Boolean));
    const note = (text) => h('p', { class: 'set-note muted' }, rich(text));

    function panel(g, ...body) {
      const saved = h('span', { class: 'saved', role: 'status', 'aria-live': 'polite' });
      let t = 0;
      P.flash = () => { saved.textContent = '✓ Saved'; clearTimeout(t); t = setTimeout(() => { saved.textContent = ''; }, 2200); };
      return h('section', { class: 'card set-panel', id: 'set-' + g.id, 'aria-labelledby': 'set-h-' + g.id },
        h('header', { class: 'set-head' }, h('div', {}, h('h2', { id: 'set-h-' + g.id }, g.label), h('p', { class: 'muted' }, g.lead)), saved), body);
    }

    /* ================= panels ================= */
    const PANELS = {
      appearance(g) {
        const names = h('span', { class: 'swatch-name' });
        const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Accent colour' },
          ACCENT_NAMES.map((n) => h('button', { type: 'button', class: 'swatch', style: `--c:${SWATCH[n] || '#888'}`, 'aria-pressed': 'false', 'aria-label': cap(n), title: cap(n), 'data-name': n, onclick: () => save('ui.accent', n) }, icon('check'))));
        const syncSw = () => { const cur = read(ctx, 'ui.accent'); swatches.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.name === cur))); names.textContent = cap(cur); };
        syncSw(); P.syncs.push(syncSw);
        const reset = button('Reset appearance', { size: 'sm', kind: 'ghost', onClick: async () => {
          for (const [k, v] of [['ui.theme', 'auto'], ['ui.accent', 'orange'], ['ui.textSize', 'normal'], ['ui.reduceMotion', false]]) await save(k, v);
        } });
        return panel(g, rows(
          row('Theme', 'Auto follows your computer’s light or dark setting.', segSetting('Theme', [['auto', 'Auto'], ['dark', 'Dark'], ['light', 'Light']], 'ui.theme')),
          row('Accent colour', 'Used for the main button and highlights. Orange is the SO-101 colour.', h('div', { class: 'swatch-wrap' }, swatches, names)),
          row('Text size', 'Makes everything bigger or smaller.', segSetting('Text size', [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']], 'ui.textSize')),
          row('Reduce motion', 'Turns off sliding and fading. Turn it on if animation makes you dizzy.', swSetting('Reduce motion', 'ui.reduceMotion'))),
        h('div', {}, reset));
      },

      explanations(g) {
        const beg = h('div', { class: 'ex-card' }, h('div', { class: 'ex-tag' }, 'Beginner'), h('p', {}, rich('<b>Motor ID:</b> the number (1 to 6) a motor answers to. Think of it as a name on a shared cable, so the app can talk to one motor at a time.')));
        const exp = h('div', { class: 'ex-card' }, h('div', { class: 'ex-tag' }, 'Expert'), h('p', {}, rich('<b>Motor ID:</b> STS3215 register 5, one per joint (1 to 6) on a half-duplex bus at 1 Mbit/s.')));
        const syncEx = () => { const b = read(ctx, 'ui.guide') !== 'expert'; beg.classList.toggle('on', b); exp.classList.toggle('on', !b); };
        syncEx(); P.syncs.push(syncEx);
        return panel(g, rows(
          row('Explanation style', 'Beginner shows plain-language explanations and “why” boxes inside every page. Expert keeps the pages short and uses the technical words.', segSetting('Explanation style', [['beginner', 'Beginner'], ['expert', 'Expert']], 'ui.guide'))),
        h('div', { class: 'stack-sm' }, h('div', { class: 'set-sub' }, 'The same line, in each style'), h('div', { class: 'ex-grid' }, beg, exp)),
        note('Words with a dotted underline open a small card that explains them, in either style.'));
      },

      units(g) {
        const degV = h('b', { class: 'big' }, '0°'), normV = h('b', { class: 'big' }, '0');
        const cDeg = h('div', { class: 'u-card' }, degV, h('span', {}, 'Degrees')), cNorm = h('div', { class: 'u-card' }, normV, h('span', {}, 'LeRobot −100 to +100'));
        const cap2 = h('p', { class: 'muted set-note' });
        const syncOn = () => { const d = ctx.units === 'deg'; cDeg.classList.toggle('on', d); cNorm.classList.toggle('on', !d); };
        const live = () => {
          const arm = [ctx.arm('follower'), ctx.arm('leader')].find((a) => a?.online && a.calibrated && a.joints?.some((j) => j.name === 'shoulder_pan' && j.pos != null));
          if (!arm) {
            degV.textContent = '0°'; normV.textContent = '0';
            const t = 'Example: a joint at the exact middle of its range reads 0 in both. At one end of its range LeRobot’s scale reads −100, at the other end +100. Calibrate an arm and your own live numbers show up here.';
            if (cap2.textContent !== t) cap2.textContent = t;
            return;
          }
          degV.textContent = signed(poseFromArm(arm).shoulder_pan, '°', 1);
          normV.textContent = signed(normalized(arm, 'shoulder_pan'), '', 0);
          const t = `Live: the ${JOINT_LABEL.shoulder_pan.toLowerCase()} of your ${arm.role} arm right now. Move it by hand to watch both change.`;
          if (cap2.textContent !== t) cap2.textContent = t;
        };
        syncOn(); P.syncs.push(syncOn); live();
        P.offs.push(ctx.subscribe(live));
        return panel(g, rows(
          row('Show joint values as', 'Degrees count turns of the motor (360 is one full turn). LeRobot’s scale runs from −100 to +100 across the recorded range.', segSetting('Joint units', [['deg', 'Degrees'], ['norm', '−100 to +100']], 'ui.units'))),
        h('div', { class: 'units-demo' }, cDeg, cNorm), cap2);
      },

      '3d-view'(g) {
        let S = v3Read();
        const store = (k, v) => { S[k] = v; if (!v3Write(S)) toast('<b>Could not save.</b> This browser blocks saving, so the 3D view settings will not be remembered.', 'warn'); P.flash(); };
        const fields = Object.entries(V3_CHOICES).map(([k, [label, opts]]) => {
          const sel = h('select', { class: 'input', id: 'v3-' + k, onchange: () => store(k, sel.value) }, opts.map(([v, t]) => h('option', { value: v }, t)));
          const sync = () => { sel.value = S[k]; };
          sync(); P.syncs.push(() => { S = v3Read(); sync(); });
          return h('div', { class: 'field' }, h('label', { for: 'v3-' + k }, label), sel);
        });
        const bright = h('input', { type: 'range', id: 'v3-bright', min: '0.6', max: '1.6', step: '0.05', 'aria-label': 'Brightness', value: String(S.bright), onchange: () => store('bright', +bright.value) });
        const brightOut = h('output', { for: 'v3-bright' }, S.bright.toFixed(2));
        bright.addEventListener('input', () => { brightOut.textContent = (+bright.value).toFixed(2); });
        const toggles = V3_TOGGLES.map(([k, label]) => {
          const s = sw(label, () => S[k], (v) => store(k, v), null, 'span');
          return h('label', { class: 'v3-toggle' }, s, h('span', {}, label));
        });
        const resetBtn = button('Reset 3D view to defaults', { size: 'sm', kind: 'ghost', onClick: () => {
          S = { ...V3_DEFAULTS }; v3Write(S); P.syncs.forEach((f) => f()); bright.value = '1'; brightOut.textContent = '1.00'; P.flash();
        } });
        return panel(g,
          callout('tip', api.demo
            ? 'These options apply to the <b>Control dashboard</b> in the real app. In this demo they are saved in your browser, but the demo’s Control page is simpler and does not use them.'
            : 'These options apply to the <b>Control dashboard</b> (the full 3D screen). They are saved in this browser and shared with the dashboard.'),
          h('div', { class: 'v3-grid' }, fields, h('div', { class: 'field' }, h('label', { for: 'v3-bright' }, 'Brightness'), h('div', { class: 'v3-bright' }, bright, brightOut))),
          h('div', { class: 'stack-sm' }, h('div', { class: 'set-sub' }, 'Show'), h('div', { class: 'v3-toggles' }, toggles)),
          h('div', {}, resetBtn));
      },

      devices(g) {
        const armsBox = h('div', { class: 'stack-sm' }, skeleton('100%', 76)), camsBox = h('div', { class: 'stack-sm' });
        const swap = safe(async (a, b) => {
          await api.post('/api/suite/role', { port: a.port, role: b.role });
          await api.post('/api/suite/role', { port: b.port, role: a.role });
          await ctx.refresh();
          toast('<b>Done.</b> The Leader and Follower have switched places. Calibrate both arms again so each one uses its own range.', 'ok', 8000);
        });
        const setRole = safe(async (a, role) => {
          await api.post('/api/suite/role', { port: a.port, role });
          await ctx.refresh();
          toast(`<b>Done.</b> This arm is now the ${cap(role)} arm.`, 'ok');
        });
        const armCard = (a) => {
          const n = a.joints?.length || 0;
          return h('div', { class: 'dev-row card tight flat' },
            icon('arm'),
            h('div', { class: 'grow' }, h('div', { class: 'dev-name' }, `${cap(a.role || 'unknown')} arm`), h('div', { class: 'mono muted dev-port' }, a.port || 'unknown port')),
            h('div', { class: 'row' }, a.online ? badge('Connected', 'ok') : badge('Offline', 'bad'), a.online ? badge(`${n}/6 motors`, n === 6 ? 'ok' : 'warn') : null, a.online ? badge(a.calibrated ? 'Calibrated' : 'Not calibrated', a.calibrated ? 'ok' : 'warn') : null));
        };
        const drawArms = () => {
          const arms = ctx.state?.arms || [];
          if (!ctx.state) { armsBox.replaceChildren(h('p', { class: 'muted' }, 'Waiting for the app to answer…')); return; }
          if (!arms.length) {
            armsBox.replaceChildren(h('div', { class: 'empty' }, icon('usb'), h('h3', {}, 'No arm found'), h('p', {}, 'Plug in the arm’s USB cable and its power, then open the setup check. We will find it.'), button('Open Setup check', { href: '#/setup', kind: 'primary' })));
            return;
          }
          const running = ctx.state.teleop?.on || ctx.state.pp?.running;
          const busy = running ? 'Leader to follower or a pick and place job is running. Stop it in Control first.'
            : arms.some((a) => a.calib?.step && a.calib.step !== 'idle') ? 'An arm is being calibrated. Finish or cancel that first.'
            : arms.some((a) => a.wiggling) ? 'A motor test is running. Wait until it ends.' : '';
          const bits = arms.map(armCard);
          const act = [];
          if (arms.length >= 2 && arms[0].role !== arms[1].role) {
            const [a, b] = arms;
            act.push(button('Swap Leader and Follower', { icon: 'arrow', why: busy, onClick: () => askYes(
              `<b>Swap Leader and Follower?</b> The arm on <code>${esc(a.port)}</code> becomes the ${cap(b.role)} and the arm on <code>${esc(b.port)}</code> becomes the ${cap(a.role)}. Calibration is saved per role, so each arm will use the other one’s saved range until you calibrate again. Nothing moves.`,
              'Yes, swap', () => swap(a, b)) }));
          } else if (arms.length === 1) {
            const a = arms[0], other = a.role === 'leader' ? 'follower' : 'leader';
            act.push(button(`Use this arm as the ${cap(other)}`, { icon: 'arrow', why: busy, onClick: () => askYes(
              `<b>Make this arm the ${cap(other)}?</b> Calibration is saved per role, so it will use the ${cap(other)}’s saved range until you calibrate it again. Nothing moves.`,
              `Yes, make it the ${cap(other)}`, () => setRole(a, other)) }));
          }
          armsBox.replaceChildren(...bits, act.length ? actionsRow(act) : '');
        };
        const drawCams = () => {
          const cams = ctx.state?.cameras || [];
          const items = cams.map((c, i) => h('div', { class: 'dev-row card tight flat' }, icon('camera'),
            h('div', { class: 'grow' }, h('div', { class: 'dev-name' }, c.name || `Camera ${i + 1}`), h('div', { class: 'mono muted dev-port' }, maskSrc(c.src))),
            h('div', { class: 'row' }, c.ok ? badge(c.fps ? `Working · ${Math.round(c.fps)} fps` : 'Working', 'ok') : badge('Not working', 'bad'), !c.ok && c.err ? h('span', { class: 'muted small' }, c.err) : null)));
          camsBox.replaceChildren(...(items.length ? items : [h('p', { class: 'muted' }, 'No camera added yet.')]));
        };
        P.offs.push(ctx.onChange((c) => [(c.state?.arms || []).map((a) => [a.port, a.role, a.online, a.joints?.length, a.calibrated, a.calib?.step, a.wiggling]), c.state?.teleop?.on, c.state?.pp?.running, !!c.state], drawArms));
        P.offs.push(ctx.onChange((c) => (c.state?.cameras || []).map((x) => [x.ok, x.src, x.name, Math.round(x.fps || 0), x.err]), drawCams));
        drawArms(); drawCams();
        return panel(g,
          h('div', { class: 'stack-sm' }, h('div', { class: 'set-sub' }, 'Arms'), armsBox,
            note('Which arm is which is remembered by its USB adapter, not by the port name, so plugging it into another socket keeps its role.')),
          h('div', { class: 'stack-sm' }, h('div', { class: 'set-sub' }, 'Cameras'), camsBox,
            h('div', {}, button('Add cameras or change their order', { href: '#/cameras', icon: 'camera' }))));
      },

      safety(g) {
        const limitsBox = h('div', { class: 'stack-sm' }, skeleton('100%', 20), skeleton('80%', 20), skeleton('90%', 20));
        loadLimits(limitsBox, () => dead);
        const guard = (next) => {
          if (next) return false;
          askYes('<b>Turn off move confirmations?</b> The app will move an arm as soon as you press its button, without asking first. STOP still works at all times.', 'Yes, turn off', () => save('safety.confirm_before_move', false), { danger: true });
          return true;
        };
        return panel(g, rows(
          row('Ask before the arm moves', 'When on, the app shows a bar at the bottom asking you to confirm (“Yes, start”) before it moves an arm for you. Leave it on until you know the arm well.', swSetting('Ask before the arm moves', 'safety.confirm_before_move', guard)),
          row('Space bar stops the arm', 'While an arm may be moving, pressing the Space bar is the same as pressing STOP. It does nothing while you type in a box or have a button selected.', swSetting('Space bar stops the arm', 'safety.stop_shortcut')),
          row('Speed when the app moves the arm', 'Gentle is slower and easier to react to. Normal is quicker. This is about moves the app makes for you; the follower copying your hand is not affected.', segSetting('Speed', [['gentle', 'Gentle'], ['normal', 'Normal']], 'safety.speed_preset'))),
        h('div', { class: 'stack-sm' }, h('div', { class: 'set-sub' }, 'Built-in limits (read only)'),
          h('p', { class: 'muted set-note' }, 'These protect the motors and the arm. They are built in and cannot be changed here.'), limitsBox));
      },

      data(g) {
        const folder = ctx.info?.data_dir;
        const fileIn = h('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
        fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; fileIn.value = ''; if (f) importFile(f); });
        return panel(g,
          h('div', { class: 'stack-sm' }, h('div', { class: 'set-sub' }, 'Data folder'),
            folder ? copyBox(folder, { label: 'Copy path' }) : h('p', { class: 'muted' }, api.demo ? 'In this demo your settings are saved in this browser, not in a folder on a computer.' : 'This version of the app does not report its data folder. By default it is a folder called .so101 in your home folder.'),
            note(api.demo ? 'In this demo your settings are kept in this browser instead. The real app keeps them in the folder above. Nothing is sent anywhere.' : 'Settings, calibration choices and camera mapping live here. Nothing is sent anywhere.')),
          rows(
            row('Export settings', 'Saves your settings as a small .json file you can keep or move to another computer.', button('Export settings', { icon: 'arrow', onClick: safe(exportSettings) })),
            row('Import settings', 'Loads a file made by Export. You will see how many settings change before anything is applied.', h('div', {}, button('Import from a file…', { onClick: () => fileIn.click() }), fileIn)),
            row('Show the welcome screens again', 'Starts the first-run experience over: the Welcome page and the offer to calibrate. Your arm and calibration are not touched.', button('Show welcome again', { kind: 'ghost', onClick: () => askYes('<b>Show the welcome screens again?</b> You will see the Welcome page next. Your settings, arms and calibration stay as they are.', 'Yes, show them', safe(async () => { await ctx.setSetting('ui.onboarded', false); await ctx.setSetting('ui.calibrationPrompted', false); await ctx.refresh(); ctx.go('welcome'); })) }))));
      },

      advanced(g) {
        const status = h('p', { class: 'set-note', role: 'status', 'aria-live': 'polite' });
        const links = [['/api/state', 'Live state of the arms and cameras'], ['/api/suite/checklist', 'The setup checklist'], ['/api/suite/diagnostics', 'Diagnostics as text']];
        const doRestart = safe(async () => {
          const r = await api.post('/api/suite/restart');
          if (api.demo) { toast(`<b>Restart sent.</b> ${esc(r?.message || 'This is the demo, so nothing really restarts.')}`, 'ok'); return; }
          status.textContent = 'Restarting… this page reconnects by itself in a few seconds.';
          await new Promise((r) => setTimeout(r, 3000));
          for (let i = 0; i < 40 && !dead; i++) {
            try { await api.get('/api/suite/info'); location.reload(); return; } catch { /* still down */ }
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (!dead) status.textContent = 'The app has not come back yet. Look at the terminal where you started it, then reload this page.';
        });
        return panel(g, rows(
          row('Restart the app', 'Stops and starts the SO-101 app on your computer. Use it after adding a module or a camera. It refuses while an arm is running a job.', button('Restart the app…', { kind: 'secondary', onClick: () => askYes('<b>Restart the app?</b> It goes quiet for a few seconds and this page reconnects by itself.', 'Yes, restart', doRestart) }), status),
          row('Look at the raw API', api.demo ? 'The raw API is what the real app serves to this page. The demo has no server, so these only work in the real app.' : 'This is the plain data the app serves to this page. Handy for scripts and AI helpers.',
            h('div', { class: 'api-links' }, links.map(([href, label]) => api.demo
              ? h('span', { class: 'api-link' }, h('code', {}, href), h('span', { class: 'muted small' }, label))
              : h('a', { class: 'api-link', href, target: '_blank', rel: 'noopener' }, h('code', {}, href), h('span', { class: 'muted small' }, label), icon('external'))))),
          row('Allow modules', 'Modules are extra pages and features other people (or an AI) added in the modules folder. Turn this off to stop all of them if one of them breaks the app.', swSetting('Allow modules', 'adv.modulesEnabled'), h('p', { class: 'set-note' }, h('a', { href: '#/modules' }, 'See installed modules'))),
          row('Start recording on launch', 'The Inspector can record what the app and the motors say to each other. When on, it starts recording every time the app starts. It keeps messages in memory on this computer and sends nothing anywhere.', swSetting('Start recording on launch', 'adv.trace')),
          row('Capture raw bytes', 'Also keeps the raw bytes sent to and from the motors (hex). It uses more memory and only helps when you are debugging the motor cable itself.', swSetting('Capture raw bytes', 'adv.traceRaw'))),
        h('div', {}, button('Open the Inspector', { href: '#/inspector', icon: 'terminal', kind: 'ghost' })));
      },

      about(g) {
        const diag = h('textarea', { class: 'input diag', readonly: true, rows: '8', 'aria-label': 'Diagnostics text', hidden: true });
        const copyDiag = safe(async () => {
          let text = await api.get('/api/suite/diagnostics');
          if (text && typeof text === 'object') text = JSON.stringify(text, null, 2);
          text = String(text ?? '');
          if (!text.trim()) throw new Error('The app returned an empty report.');
          try { await navigator.clipboard.writeText(text); toast('<b>Copied.</b> Paste it into your message or issue. Read it first: it lists your computer, ports and cameras.', 'ok', 6000); diag.hidden = true; }
          catch { diag.value = text; diag.hidden = false; diag.focus(); diag.select(); toast('Could not copy automatically. The text is shown below: select it and copy it.', 'warn', 8000); }
        });
        return panel(g,
          rows(
            row('Version', null, h('b', {}, ctx.info?.version ? `SO-101 Suite ${ctx.info.version}` : 'SO-101 Suite')),
            row('Licence', 'Free and open source. You can use, change and share it, and changed versions must stay open too.', h('b', {}, 'AGPL-3.0-or-later'))),
          h('div', { class: 'stack-sm' }, h('div', { class: 'set-sub' }, 'Code and help'),
            h('p', { class: 'muted set-note' }, 'Read the code, ask a question or report a problem.'),
            h('div', { class: 'row' }, extBtn('Open the project on GitHub', REPO), extBtn('Report a problem', REPO + '/issues', 'ghost'))),
          h('div', { class: 'stack-sm' }, h('div', { class: 'set-sub' }, 'Copy diagnostics'),
            h('p', { class: 'muted set-note' }, 'Copies a plain-text report (your computer, app version, ports, motors, cameras and the setup checklist) to paste into a message or a bug report. No photos or files. Read it before you share it.'),
            h('div', {}, button('Copy diagnostics', { icon: 'copy', onClick: copyDiag })), diag),
          h('div', { class: 'stack-sm' }, h('div', { class: 'set-sub' }, 'Built with'),
            h('ul', { class: 'notices' },
              h('li', {}, h('b', {}, 'three.js'), ' draws the 3D arm. MIT licence.'),
              h('li', {}, h('b', {}, 'SO-ARM100 / SO-101 model'), ' (the robot’s 3D parts and URDF description). Apache-2.0 licence.'),
              h('li', {}, h('b', {}, 'LeRobot'), ' by Hugging Face is an optional dependency, only installed if you ask for it. Apache-2.0 licence.'),
              h('li', {}, h('b', {}, 'feetech-servo-sdk'), ' talks to the Feetech motors. Used under its own licence.')),
            note('Full notices are in the project’s NOTICE file. © Wendor AI and SO-101 Suite contributors.')),
          callout('tip', 'SO-101 Suite is an <b>independent community project</b>. It is not affiliated with, endorsed by or sponsored by Hugging Face, The Robot Studio or Feetech. Their names belong to them.'));
      },
    };

    /* ================= shell of the page ================= */
    const box = h('div', { class: 'set-box' });
    const links = new Map();
    const nav = h('nav', { class: 'set-nav', 'aria-label': 'Settings groups' }, GROUPS.map((g) => {
      const a = h('a', { href: '#/settings/' + g.id, onclick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); show(g.id, true); } }, icon(g.icon), g.label);
      links.set(g.id, a);
      return a;
    }));

    function show(id, pushUrl) {
      current = id;
      P?.offs.forEach((f) => f());
      P = { offs: [], syncs: [], flash() {} };
      for (const [k, a] of links) { if (k === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
      try { links.get(id)?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch { /* old browser: the strip just stays put */ }
      const g = GROUPS.find((x) => x.id === id);
      let node;
      try { node = PANELS[id](g); }
      catch (e) { console.error(e); node = h('section', { class: 'card set-panel' }, callout('warn', `This group hit a problem: ${String(e.message || e)}`, `Could not open ${g.label}`)); }
      box.replaceChildren(node);
      if (pushUrl) { try { history.replaceState(null, '', '#/settings/' + id); } catch { /* the hash simply stays */ } }
      document.title = `${g.label} · Settings · SO-101 Suite`;
    }

    root.append(h('div', { class: 'stack' }, pageHead('Preferences', 'Settings', 'Look, units, safety and your data. Every change saves as you make it.'), h('div', { class: 'settings' }, nav, box)));
    show(current, false);
    setTimeout(() => { if (!dead) try { links.get(current)?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch { /* cosmetic */ } }, 300); // after the page stylesheet has loaded
    // Any change to the saved settings (from here or elsewhere) refreshes every control of the open group.
    allOffs.push(ctx.onChange((c) => c.settings, () => P?.syncs.forEach((f) => f())));
    return () => { dead = true; P?.offs.forEach((f) => f()); allOffs.forEach((f) => f()); };

    /* ================= actions ================= */
    async function exportSettings() {
      let s;
      try { s = await api.get('/api/suite/settings'); } catch { s = ctx.settings; }
      const out = {};
      for (const [grp, keys] of Object.entries(SCHEMA)) for (const k of Object.keys(keys)) if (s?.[grp]?.[k] !== undefined) (out[grp] ||= {})[k] = s[grp][k];
      const file = { app: 'so101-suite', format: 1, version: ctx.info?.version || null, exported: new Date().toISOString(), settings: out, view3d: v3Read() };
      const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' }));
      const a = h('a', { href: url, download: 'so101-settings.json', style: { display: 'none' } });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('<b>Saved</b> as <code>so101-settings.json</code> in your downloads folder.', 'ok');
    }

    async function importFile(file) {
      let parsed;
      try { parsed = JSON.parse(await file.text()); }
      catch { toast(`<b>That file is not a settings file.</b> “${esc(file.name)}” could not be read as JSON. Use a file made by Export.`, 'err'); return; }
      const src = parsed && typeof parsed === 'object' ? (parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed) : {};
      const payload = {}; let count = 0, skipped = 0;
      for (const [grp, keys] of Object.entries(SCHEMA)) {
        for (const [k, ok] of Object.entries(keys)) {
          if (src[grp] && typeof src[grp] === 'object' && Object.prototype.hasOwnProperty.call(src[grp], k)) { if (ok(src[grp][k])) { (payload[grp] ||= {})[k] = src[grp][k]; count++; } else skipped++; }
        }
      }
      const { out: view3d, skipped: skipped3 } = v3Clean(parsed?.view3d);
      skipped += skipped3;
      const n3 = Object.keys(view3d).length;
      if (!count && !n3) { toast(`<b>Nothing to import.</b> “${esc(file.name)}” has no settings this version understands.`, 'warn'); return; }
      const warnOff = payload.safety?.confirm_before_move === false ? ' <b>This turns off move confirmations.</b>' : '';
      askYes(`<b>Import ${count + n3} setting${count + n3 === 1 ? '' : 's'}?</b> From “${esc(file.name)}”. They replace your current values for the same settings.${skipped ? ` ${skipped} value${skipped === 1 ? ' was' : 's were'} skipped because they look wrong.` : ''}${warnOff}`, 'Yes, import', safe(async () => {
        if (count) { await api.post('/api/suite/settings', payload); await resync(); }
        if (n3) { if (!v3Write({ ...v3Read(), ...view3d })) toast('The 3D view settings could not be saved in this browser.', 'warn'); }
        if (!dead) show(current, false);
        toast(`<b>Imported.</b> ${count + n3} setting${count + n3 === 1 ? '' : 's'} applied.`, 'ok');
      }));
    }
  },
};

/* ---------- helpers ---------- */
const extBtn = (label, href, kind = '') => h('a', { class: 'btn ' + kind, href, target: '_blank', rel: 'noopener' }, icon('external'), label);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const maskSrc = (src) => (/^\d+$/.test(String(src)) ? `USB camera, index ${src}` : String(src ?? '').replace(/\/\/[^/@]*@/, '//***@') || 'unknown source');
const actionsRow = (btns) => h('div', { class: 'actions' }, h('div', { class: 'btns' }, btns), (() => {
  const why = btns.filter((b) => b.dataset?.why);
  return why.length ? h('p', { class: 'why' }, [...new Set(why.map((b) => b.dataset.why))].join(' ')) : null;
})());

const LIMITS = {
  load_limit_pct: ['Motor load limit', (v) => `${v} % of the motor’s strength`],
  wrist_roll_load_limit_pct: ['Wrist roll load limit', (v) => `${v} % of the motor’s strength`],
  temp_limit_c: ['Motor temperature limit', (v) => `${v} °C`],
  teleop_hz: ['Leader to follower update rate', (v) => `${v} times a second`],
  teleop_slew_ticks: ['Biggest step per update', (v) => `${v} motor steps, so a fast hand never makes the follower jump`],
  teleop_slew_sync_ticks: ['Biggest step while catching up', (v) => `${v} motor steps, gentler until the follower has caught up`],
};
async function loadLimits(box, isDead) {
  let d;
  try { d = await api.get('/api/suite/defaults'); } catch { d = null; }
  if (isDead()) return;
  const safety = d && typeof d === 'object' ? (d.effective?.safety || d.defaults?.safety || d.safety) : null;
  const entries = safety ? Object.entries(safety).filter(([k, v]) => !k.startsWith('_') && k !== 'confirm_before_move' && k !== 'speed_preset' && (typeof v === 'number' || typeof v === 'string')) : [];
  if (!entries.length) { box.replaceChildren(h('p', { class: 'muted' }, 'This version of the app does not list its built-in limits here. They are in the file defaults/so101.defaults.json.')); return; }
  box.replaceChildren(h('dl', { class: 'limits' }, entries.map(([k, v]) => { const [label, fmt] = LIMITS[k] || [k.replace(/_/g, ' '), String]; return h('div', {}, h('dt', {}, label), h('dd', {}, fmt(v))); })));
}
