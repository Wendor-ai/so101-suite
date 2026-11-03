// In-browser mock of the whole SO-101 backend, for the website demo, screenshots and tests (runs in browsers and Node 22).
//   const mock = createMockBackend({ seed: 1, scenario: 'fresh', os: 'macos', storage, now })
//   await mock.get('/api/state')                    -> plain JSON (diagnostics and trace exports resolve to text)
//   await mock.post('/api/calib/0/start', {})       -> {} like the real server
//   errors resolve to {status, json:{error}} with a human sentence (api.js turns them into ApiError)
//   mock.cameraFrame(i, ctx2d, t, {w, h})           -> paints camera i onto a canvas
// Scenarios: fresh (the default), ready, nothing, stiff (calibrated arms, the follower's torque ON: demos the "make it limp first, lowered" flow).
// Randomness only comes from a seeded PRNG and time only from `now()` (milliseconds), so a run is repeatable.
import { Sim, JOINTS, Trace, MID } from './sim.js';
import { sceneModel as buildScene, drawScene, mulberry32 } from './scene.js';
import { buildChecklist } from './checklist.js';
import { DEFAULTS } from './defaults.js';

const VERSION = '0.1.0';
const LICENSE = 'AGPL-3.0-or-later';
const REPO = 'https://github.com/Wendor-ai/so101-suite';
const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const isMockError = (r) => !!r && typeof r === 'object' && typeof r.status === 'number' && r.status >= 400 && 'json' in r;
const fail = (status, error) => ({ status, json: { error } });

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
function pickStorage(s) {
  if (s) return s;
  try { if (typeof localStorage !== 'undefined') { const k = '__so101_probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return localStorage; } } catch { /* private window */ }
  return memoryStorage();
}
function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (isObj(v) && isObj(base[k])) deepMerge(base[k], v); else base[k] = clone(v);
  }
  return base;
}

/* ------------------------------------------------------------------ platform, ports, modules (fixed demo content) */
const PLATFORMS = {
  macos: { os: 'macos', os_version: '15.1', arch: 'arm64', is_pi: false, pi_model: null, python: '3.12.7', uv: true, in_dialout: null, serial_examples: ['/dev/tty.usbmodem*', '/dev/tty.wchusbserial*'], camera_backend: 'AVFoundation', notes: [] },
  linux: { os: 'linux', os_version: 'Ubuntu 24.04.1 LTS', arch: 'x86_64', is_pi: false, pi_model: null, python: '3.12.7', uv: true, in_dialout: true, serial_examples: ['/dev/ttyACM*', '/dev/ttyUSB*'], camera_backend: 'V4L2', notes: [] },
  windows: { os: 'windows', os_version: '10.0.22631', arch: 'AMD64', is_pi: false, pi_model: null, python: '3.12.7', uv: true, in_dialout: null, serial_examples: ['COM3'], camera_backend: 'DirectShow (DSHOW)', notes: ['Windows support is untested: if something breaks, please open an issue with the output of `so101 doctor`.'] },
};
const PI_MODEL = 'Raspberry Pi 5 Model B Rev 1.0';
function platformFor(os, inDialout) {
  const key = os === 'pi' ? 'linux' : PLATFORMS[os] ? os : 'macos';
  const p = clone(PLATFORMS[key]);
  if (os === 'pi') { Object.assign(p, { os_version: 'Debian GNU/Linux 12 (bookworm)', arch: 'aarch64', is_pi: true, pi_model: PI_MODEL }); p.notes.push(`${PI_MODEL}: USB cameras and the arm adapters work the same as on a PC. Use a good 5 V power supply.`); }
  if (p.os === 'linux') { p.in_dialout = inDialout; if (inDialout === false) p.notes.push("Your user is not in the 'dialout' group, so Linux will refuse to open the arm's serial port."); }
  return p;
}
const PORT_NAMES = { macos: ['/dev/tty.usbmodem101', '/dev/tty.usbmodem201'], linux: ['/dev/ttyACM0', '/dev/ttyACM1'], windows: ['COM3', 'COM4'] };

const MODULES = [
  { id: 'hello', name: 'Hello module', description: 'A tiny example module: one page and one API route. Copy it to start your own.', version: '0.1.0', author: 'SO-101 Suite contributors', license: LICENSE, requires: [], pages: [{ id: 'hello', title: 'Hello', icon: 'sparkles', script: 'ui.js' }], backend: 'backend.py', enabled: true, error: null },
  { id: 'broken_example', name: 'Broken example', description: 'A module that fails to load, so you can see how the app reports a problem without stopping.', version: '0.0.1', author: 'SO-101 Suite contributors', license: LICENSE, requires: [], pages: [], backend: 'backend.py', enabled: false, error: 'Could not load backend.py: SyntaxError on line 3' },
];

/* ------------------------------------------------------------------ settings schema (what POST /api/suite/settings accepts) */
const ACCENTS = ['orange', 'blue', 'green', 'violet', 'pink', 'yellow'];
const SCHEMA = {
  ui: { theme: ['auto', 'dark', 'light'], accent: ACCENTS, guide: ['beginner', 'expert'], units: ['deg', 'norm', 'lerobot'], textSize: ['small', 'normal', 'large'], reduceMotion: 'bool', onboarded: 'bool', calibrationPrompted: 'bool' },
  safety: { confirm_before_move: 'bool', speed_preset: ['gentle', 'normal'], stop_shortcut: 'bool' },
  adv: { rawLinks: 'bool', modulesEnabled: 'bool', logLevel: ['debug', 'info', 'warn', 'error'], disabledModules: 'strings', trace: 'bool', traceRaw: 'bool', traceMax: 'int' },
};
function checkValue(path, rule, v) {
  if (rule === 'bool') return typeof v === 'boolean' ? null : `${path} must be true or false.`;
  if (rule === 'int') return Number.isInteger(v) && v >= 100 && v <= 100000 ? null : `${path} must be a whole number from 100 to 100000.`;
  if (rule === 'strings') return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : `${path} must be a list of module ids.`;
  return rule.includes(v) ? null : `${path} must be one of: ${rule.join(', ')}.`;
}

/* ------------------------------------------------------------------ the backend */
export function createMockBackend(options = {}) {
  const seed = options.seed ?? 1;
  const scenario = ['fresh', 'ready', 'nothing', 'stiff'].includes(options.scenario) ? options.scenario : 'fresh';
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const storage = pickStorage(options.storage);
  const KEY = { settings: 'so101.demo.v1.settings', progress: 'so101.demo.v1.progress' };
  const readJson = (k, d) => { try { const v = JSON.parse(storage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
  const writeJson = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked: the demo still works */ } };
  const osName = ['macos', 'linux', 'windows', 'pi'].includes(options.os) ? options.os : 'macos';
  const repo = options.repo || REPO;
  let S = null;

  const portNames = (os) => PORT_NAMES[os === 'pi' ? 'linux' : os];
  const sec = () => now() / 1000;

  function init() {
    const plat = platformFor(osName, options.inDialout ?? true);
    const names = portNames(osName);
    const trace = new Trace({ rng: mulberry32(seed * 31 + 5) });
    const stored = readJson(KEY.settings, {});
    const adv = { ...DEFAULTS.adv, ...(stored.adv || {}) };
    trace.configure({ max: adv.traceMax, raw: !!adv.traceRaw, enabled: !!adv.trace });
    const sim = new Sim({ seed, scenario, ports: { follower: names[0], leader: names[1] }, home: osName === 'windows' ? 'C:\\Users\\demo' : osName === 'macos' ? '/Users/demo' : '/home/demo', brokenMotors: options.brokenMotors, trace });
    const ready = scenario === 'ready', stiff = scenario === 'stiff';
    const cameras = scenario === 'nothing' ? [] : [{ id: 0, source: 0, kind: 'usb', name: 'USB Camera (demo)' }];
    if (ready) cameras.push({ id: 1, source: 'http://pi.local:8000/raw.mjpg', kind: 'network', name: 'Raspberry Pi camera (demo)' });
    const detected = scenario === 'fresh' || stiff ? [{ source: 1, kind: 'usb', name: 'USB Camera #2 (demo)', width: 640, height: 480, in_use: false }] : [];
    S = {
      plat, trace, sim, cameras, detected, nextSerial: 3,
      meta: {},                                                   // port path -> {serial, key}
      portRoles: {},                                              // port key -> role (bound by Motor IDs / identify)
      identify: { state: 'idle', role: null, t0: 0, port: null, target: null },
    };
    sim.arms.forEach((a, n) => { S.meta[a.path] = { serial: `DEMO-0000${n + 1}`, location: `1-${n + 1}` }; if (ready || stiff) S.portRoles[S.meta[a.path].serial] = a.role; });
    if (sim.arms.length) sim.advance(sec());
    sim.setNcam(cameras.length);
    if (trace.enabled) logStartup();
  }
  function logStartup() {
    S.trace.log(sec(), 'info', 'trace', 'Recording started: the app and the motors are being traced in memory only');
    for (const a of S.sim.arms) S.trace.log(sec(), a.online ? 'info' : 'warn', 'arm', a.online ? `${a.role} arm connected on ${a.path} (${a.ids.length} motors answer)` : `${a.role} arm on ${a.path}: no motor answers`);
  }
  function sync() { S.sim.advance(sec()); identifyTick(); }

  /* ----- settings and progress (persisted through `storage`) ----- */
  const storedSettings = () => readJson(KEY.settings, {});
  function settingsView() {
    const st = storedSettings();
    const out = {
      ui: { ...DEFAULTS.ui, ...(st.ui || {}) },
      safety: { ...DEFAULTS.safety, stop_shortcut: true, ...(st.safety || {}) },
      adv: { ...DEFAULTS.adv, ...(st.adv || {}) },
    };
    if (isObj(st.arms) && Object.keys(st.arms).length) out.arms = clone(st.arms);
    if (isObj(st.cameras) && Object.keys(st.cameras).length) out.cameras = clone(st.cameras);
    return out;
  }
  function postSettings(body) {
    const patch = {};
    for (const [k, v] of Object.entries(body || {})) {                // accept {ui:{theme}} and {"ui.theme": ...}
      if (k.includes('.')) { const [g, n] = k.split('.'); (patch[g] = patch[g] || {})[n] = v; }
      else if (isObj(v)) patch[k] = { ...(patch[k] || {}), ...v };
    }
    const st = storedSettings();
    for (const [g, vals] of Object.entries(patch)) {
      if (g === 'arms' || g === 'cameras') {                          // free-form names, kept small
        for (const [n, v] of Object.entries(vals)) {
          if (!/^[a-z][a-z0-9_]{0,31}$/i.test(n)) continue;
          if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v) || isObj(v)) || JSON.stringify(v).length > 400) return fail(400, `${g}.${n} is too long or not a plain value.`);
          (st[g] = st[g] || {})[n] = v;
        }
        continue;
      }
      const rules = SCHEMA[g];
      if (!rules) continue;                                           // unknown group: ignored like the real server
      for (const [n, v] of Object.entries(vals)) {
        if (!(n in rules)) continue;                                  // unknown key: ignored
        const bad = checkValue(`${g}.${n}`, rules[n], v);
        if (bad) return fail(400, bad);
        (st[g] = st[g] || {})[n] = v;
      }
    }
    writeJson(KEY.settings, st);
    const adv = patch.adv || {};
    const tc = {};
    if ('trace' in adv) tc.enabled = adv.trace;
    if ('traceRaw' in adv) tc.raw = adv.traceRaw;
    if ('traceMax' in adv) tc.max = adv.traceMax;
    if (Object.keys(tc).length) { const was = S.trace.enabled; S.trace.configure(tc); if (!was && S.trace.enabled) logStartup(); }
    return settingsView();
  }
  const progress = () => readJson(KEY.progress, {});
  function postProgress(body) {
    const p = progress();
    if (body && typeof body.key === 'string') p[body.key] = body.value === undefined ? true : !!body.value;
    else for (const [k, v] of Object.entries(body || {})) if (typeof v === 'boolean') p[k] = v;
    writeJson(KEY.progress, p);
    return p;
  }
  const uiSetting = (k) => settingsView().ui[k];

  /* ----- ports, identify, roles ----- */
  const meta = (path) => (S.meta[path] ||= { serial: `DEMO-0000${S.nextSerial++}`, location: `1-${S.nextSerial}` });
  const portKey = (path) => meta(path).serial;
  function portList() {
    return S.sim.arms.filter((a) => a !== S.identify.target || S.identify.state !== 'replug').map((a) => {
      const m = meta(a.path);
      return { path: a.path, description: osNameLabel(), vid: 0x1a86, pid: 0x55d3, serial: m.serial, manufacturer: 'QinHeng Electronics', likely_servo_board: true, role: S.portRoles[m.serial] || null, owned_by_app: true, key: m.serial, location: m.location };
    });
  }
  const osNameLabel = () => (osName === 'windows' ? 'USB-SERIAL CH343 (demo)' : osName === 'macos' ? 'USB Single Serial (demo)' : 'USB Single Serial (demo)');
  const armBy = (o) => S.sim.arms.find((a) => (o.port && (a.path === o.port || portKey(a.path) === o.port)) || (!o.port && o.role && a.role === o.role)) || null;
  function bindRole(arm, role) {
    S.sim.setRole(arm, role);
    S.portRoles[portKey(arm.path)] = role;
    const other = S.sim.arms.find((a) => a !== arm);
    if (other && S.sim.arms.length === 2) S.portRoles[portKey(other.path)] = other.role;
  }
  const IDENTIFY_TEXT = {
    unplug: (r) => `Unplug the USB cable of the ${r} arm's board. Leave the other arm plugged in.`,
    replug: (r) => `The ${r} arm's board is unplugged. Now plug the same cable back in.`,
    done: (r) => `Found it: this port is now the ${r} arm.`,
    error: () => "No USB motor board is connected yet. Plug in the arm's USB cable, then try again.",
  };
  function identifyTick() {
    const id = S.identify;
    if (id.state !== 'unplug' && id.state !== 'replug') return;
    const el = sec() - id.t0, a = id.target;
    if (id.state === 'unplug' && el >= 2.5) { id.state = 'replug'; id.port = a.path; a.online = false; S.sim.ev('info', 'identify', `${a.path} unplugged`); }
    if (id.state === 'replug' && el >= 5.0) {
      a.online = a.ids.length > 0; id.state = 'done'; bindRole(a, id.role); S.sim.ev('info', 'identify', `${a.path} is the ${id.role} arm`);
    }
  }
  const identifyView = () => { const id = S.identify; return { state: id.state, message: id.state === 'idle' ? '' : IDENTIFY_TEXT[id.state](id.role), port: id.port }; };
  function postIdentify(body) {
    const id = S.identify;
    if (body.action === 'cancel') { if (id.target && id.state === 'replug') id.target.online = id.target.ids.length > 0; Object.assign(id, { state: 'idle', role: null, port: null, target: null }); return identifyView(); }
    if (body.action !== 'start') return fail(400, 'Use action "start" or "cancel".');
    if (!['follower', 'leader'].includes(body.role)) return fail(400, 'Say which arm you are looking for: "follower" or "leader".');
    if (!S.sim.arms.length) { Object.assign(id, { state: 'error', role: body.role, port: null, target: null }); return identifyView(); }
    if (id.target && id.state === 'replug') id.target.online = id.target.ids.length > 0;
    const target = S.sim.arms.find((a) => a.role === body.role) || S.sim.arms[0];
    Object.assign(id, { state: 'unplug', role: body.role, t0: sec(), port: null, target });
    return identifyView();
  }

  /* ----- cameras ----- */
  const camFps = (i) => Math.round((29.6 + 0.4 * Math.sin(S.sim.t * 0.7 + i)) * 10) / 10;
  function camerasView() {
    const pp = S.sim.pp;
    return {
      cameras: S.cameras.map((c, i) => ({ source: c.source, kind: c.kind, name: c.name, width: 640, height: 480, in_use: true, id: c.id, ok: true, fps: camFps(i), err: '', calibrated: pp.calibrated(i) })),
      detected: clone(S.detected),
    };
  }
  function postCameras(body) {
    const act = body.action;
    if (act === 'add') {
      const src = body.source;
      const k = S.detected.findIndex((d) => d.source === src);
      let cam;
      if (k >= 0) { const [d] = S.detected.splice(k, 1); cam = { source: d.source, kind: d.kind, name: body.name || d.name }; }
      else if (typeof src === 'string' && /^https?:\/\/[^\s/]+/.test(src)) cam = { source: src, kind: 'network', name: body.name || `Network camera (${src.split('/')[2]})` };
      else return fail(400, 'I cannot find that camera. Pick one from the detected list, or type a network address that starts with http://');
      if (S.cameras.some((c) => c.source === cam.source)) return fail(409, 'That camera is already added.');
      cam.id = S.cameras.length; S.cameras.push(cam);
    } else if (act === 'remove') {
      const i = S.cameras.findIndex((c) => c.id === body.id);
      if (i < 0) return fail(404, 'No camera with that id.');
      const [c] = S.cameras.splice(i, 1);
      if (c.kind === 'usb') S.detected.push({ source: c.source, kind: 'usb', name: c.name, width: 640, height: 480, in_use: false });
      S.cameras.forEach((x, n) => { x.id = n; });
      S.sim.pp.models.splice(i, 1);
    } else if (act === 'rename') {
      const c = S.cameras.find((x) => x.id === body.id);
      if (!c) return fail(404, 'No camera with that id.');
      if (!String(body.name || '').trim()) return fail(400, 'Give the camera a name.');
      c.name = String(body.name).trim().slice(0, 60);
    } else return fail(400, 'Use action "add", "remove" or "rename".');
    S.sim.setNcam(S.cameras.length);
    return { ok: true, saved: true, restart_needed: true };
  }

  /* ----- motors: scan, set_id, ping, wiggle ----- */
  const motorId = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null; };
  async function postMotors(body) {
    const a = armBy(body);
    if (!a) return fail(404, body.port ? 'That port is not connected. Check the cable and refresh the list.' : `No ${body.role || 'arm'} is connected. Plug it in first.`);
    const sim = S.sim;
    if (body.action === 'scan') return { ok: true, port: a.path, ids: a.ids.slice(), baud: DEFAULTS.serial.baud };
    if (body.action === 'set_id') {
      const nid = motorId(body.id);
      if (nid === null) return fail(400, 'Motor IDs go from 1 to 6.');
      if (a.calib.step === 'center' || a.calib.step === 'sweep' || sim.pp.running || sim.tele.on) return fail(409, 'Finish or stop what the arm is doing first (calibration, pick and place or leader to follower), then set the ID.');
      if (a.ids.length === 0) return fail(409, 'No motor answers on this port. Check the 3-pin cable and that the power supply is on, then try again.');
      if (a.ids.length > 1) return fail(409, `${a.ids.length} motors answer (IDs ${a.ids.join(', ')}). Unplug all but the one you want to set up, then try again.`);
      const old = a.ids[0];
      a.ids = [nid]; a.pos[nid] = a.pos[nid] ?? MID;
      sim.ev('info', 'motors', `Motor ID ${old} changed to ${nid} on ${a.path}`);
      sim.rec(a, 'write1', old, 55, 0); sim.rec(a, 'write1', old, 5, nid); sim.rec(a, 'write1', old, 6, 0); sim.rec(a, 'write1', nid, 55, 1);
      return { ok: true, port: a.path, old_id: old, id: nid, joint: JOINTS[nid], baud: DEFAULTS.serial.baud, message: `Motor ID set to ${nid} (${JOINTS[nid].replace('_', ' ')}).` };
    }
    if (body.action === 'ping' || body.action === 'wiggle') {
      const id = motorId(body.id);
      if (id === null) return fail(400, 'Motor IDs go from 1 to 6.');
      if (!a.online) return fail(409, `The ${a.role} arm is not connected: no motor answers on ${a.path}. Check the cable and the power supply.`);
      if (body.action === 'ping') return sim.ping(a, id);
      let job;
      try { job = sim.motorWiggleStart(a, id); } catch (e) { return fail(409, e.message); }
      if (job === null) return { ok: false, id, joint: JOINTS[id], moved_deg: 0, peak_load_pct: 0, message: `Motor ${id} did not answer. Check its 3-pin cable and that the power supply is on.` };
      let spins = 0;
      while (a.job === job && spins++ < 120) { await sleep(40); sync(); }
      if (a.job === job) sim.advance(job.t0 + 2.3);                  // the clock never moved (a frozen test clock): finish the move anyway
      const r = job.result || { moved: 0, peak: 0 };
      const moved = Math.round(r.moved * 10) / 10, peak = Math.round(r.peak * 10) / 10;
      if (moved < 3) return { ok: false, id, joint: JOINTS[id], moved_deg: moved, peak_load_pct: peak, message: `Motor ${id} did not move. Check its cable and power.` };
      return { ok: true, id, joint: JOINTS[id], moved_deg: moved, peak_load_pct: peak, message: `Motor ${id} moved ${Math.round(moved)} degrees. It works.` };
    }
    return fail(400, 'Use action "scan", "set_id", "ping" or "wiggle".');
  }

  /* ----- info, checklist, diagnostics ----- */
  function uncalibratedRoles() { return S.sim.arms.filter((a) => a.online && a.cal === null).map((a) => a.role); }
  function infoView() {
    const unc = uncalibratedRoles();
    return {
      version: VERSION, license: LICENSE, demo: true, repo, modules: MODULES.length, onboarded: !!uiSetting('onboarded'),
      first_calibration_needed: unc.length > 0 && uiSetting('calibrationPrompted') !== true, uncalibrated: unc,
      trace: { enabled: S.trace.enabled, raw: S.trace.raw }, data_dir: '~/.so101',
      links: { repo, docs: `${repo}#readme`, issues: `${repo}/issues` },
    };
  }
  function snapshot() {
    const prog = progress(), sim = S.sim;
    const armSnap = (role) => {
      const a = sim.arms.find((x) => x.role === role);
      return a ? { port: a.path, online: a.online, motor_ids: a.ids.slice(), calibrated: a.cal !== null, err: a.online ? '' : 'no motor answered', role_confirmed: true } : null;
    };
    return {
      platform: { os: S.plat.os, python: S.plat.python, uv: S.plat.uv, in_dialout: S.plat.in_dialout },
      ports: portList().map((p) => ({ path: p.path, likely_servo_board: p.likely_servo_board, role: p.role })),
      arms: { follower: armSnap('follower'), leader: armSnap('leader') },
      cameras: { detected: S.detected.length, configured: S.cameras.map((c, i) => ({ ok: true, calibrated: sim.pp.calibrated(i), err: '' })) },
      progress: { assembly_done: !!(prog['assembly.done'] ?? prog.assembly_done), cameras_skipped: !!(prog['cameras.skipped'] ?? prog.cameras_skipped) },
    };
  }
  const checklist = () => buildChecklist(snapshot());
  function diagnostics() {
    const sim = S.sim, cl = checklist(), p = S.plat;
    const lines = [`SO-101 Suite diagnostics (demo: simulated hardware, nothing here is real)`, `version ${VERSION} · ${LICENSE}`, '',
      `Platform: ${p.os} ${p.os_version} ${p.arch}${p.is_pi ? ` (${p.pi_model})` : ''}, Python ${p.python}, uv ${p.uv ? 'yes' : 'no'}${p.in_dialout === null ? '' : `, dialout ${p.in_dialout ? 'yes' : 'NO'}`}`, `Camera backend: ${p.camera_backend}`, '', 'Ports:'];
    for (const q of portList()) lines.push(`  ${q.path.replace(/(usbmodem|wchusbserial)\w+/, '$1*')}  role ${q.role || 'unassigned'}  ${q.description}`);
    if (!portList().length) lines.push('  none');
    lines.push('', 'Motors:');
    for (const a of sim.arms) lines.push(`  ${a.role}: ${a.online ? `${a.ids.length} of 6 answer (IDs ${a.ids.join(', ')})` : 'no motor answers'}, ${a.cal ? 'calibrated' : 'not calibrated'}`);
    if (!sim.arms.length) lines.push('  none');
    lines.push('', 'Cameras:');
    S.cameras.forEach((c, i) => lines.push(`  camera ${i + 1}: ${c.kind} "${c.name}" ok, ${sim.pp.calibrated(i) ? 'mapped to the table' : 'not mapped'}`));
    if (!S.cameras.length) lines.push('  none');
    lines.push('', `Checklist: ${cl.summary.ok} of ${cl.summary.total} ok, next: ${cl.summary.next || 'nothing, all done'}`);
    for (const it of cl.items) lines.push(`  [${it.status}] ${it.title}${it.status === 'ok' || it.status === 'skip' ? '' : ` - ${it.detail}`}`);
    return lines.join('\n') + '\n';
  }

  /* ----- /api/state, shaped exactly like the real server's ----- */
  function stateView() {
    const sim = S.sim, st = sim.state(), cams = S.cameras;
    const ageOf = (i) => Math.round(((i * 7 + sim.k) % 3) * 0.03 * 10) / 10;
    return {
      camera: cams.length > 0, camera_age: cams.length ? ageOf(0) : 999, camera_err: cams.length ? '' : 'no camera configured',
      camera_fps: cams.length ? camFps(0) : 0, camera_src: cams.length ? String(cams[0].source) : '',
      cameras: cams.map((c, i) => ({ ok: true, age: ageOf(i), fps: camFps(i), err: '', src: String(c.source) })),
      viz: st.viz, pp: st.pp, teleop: st.teleop, arms: st.arms,
    };
  }

  /* ----- routing ----- */
  async function route(method, rawPath, body) {
    const [path, qs] = rawPath.split('?');
    const q = new URLSearchParams(qs || '');
    const sim = S.sim, GET = method === 'GET';
    let m;
    // --- legacy dashboard API ---
    if (GET && path === '/api/state') return stateView();
    if (GET && path === '/api/health') return { ok: true, t: sec(), arms: sim.arms.length, job: !!sim.pp.running, teleop: sim.tele.on };
    if (!GET && (m = path.match(/^\/api\/calib\/(\d+)\/(\w+)$/))) { sim.calib(Number(m[1]), m[2]); return {}; }
    if (!GET && (m = path.match(/^\/api\/wiggle\/(\d+)$/))) { sim.wiggle(Number(m[1])); return {}; }
    if (!GET && (m = path.match(/^\/api\/nudge\/(\d+)\/(\w+)$/))) { sim.nudge(Number(m[1]), m[2]); return {}; }
    if (!GET && (m = path.match(/^\/api\/role\/(\d+)$/))) { const a = sim.arm(m[1]); if (a && ['follower', 'leader'].includes(body.role)) bindRole(a, body.role); return {}; }
    if (!GET && path === '/api/viz') {
      const j = body.joint;
      if (Object.values(JOINTS).includes(j)) { if ('flip' in body) sim.viz.flip[j] = !!body.flip; if ('offset' in body) sim.viz.offset[j] = Number(body.offset) || 0; }
      return {};
    }
    if (!GET && (m = path.match(/^\/api\/teleop\/(\w+)$/))) { if (m[1] === 'start') sim.teleStart(); else sim.teleStop('stopped by you'); return {}; }
    if (!GET && (m = path.match(/^\/api\/pp\/(\w+)$/))) { ppAction(m[1], body); return {}; }
    // --- demo-only helpers ---
    if (!GET && path === '/api/demo/connect') {
      if (typeof body.port !== 'string' || !Array.isArray(body.ids)) return fail(400, 'Send {port, ids:[...]} to plug motors in or out.');
      const a = sim.connect(body.port, body.ids);
      if (a && a.online) sim.advance(sec());
      return { ok: true, ports: portList() };
    }
    if (!GET && path === '/api/demo/fault') {
      const a = armBy(body), id = motorId(body.id);
      if (!a || id === null) return fail(400, 'Send {role or port, id:1-6, kind:"overload"}.');
      sim.setFault(a, id, body.kind || 'overload', Number(body.seconds) || 2.5); return { ok: true };
    }
    // --- suite API ---
    if (path === '/api/suite/info' && GET) return infoView();
    if (path === '/api/suite/platform' && GET) return q.get('os') ? platformFor(q.get('os'), options.inDialout ?? true) : clone(S.plat);
    if (path === '/api/suite/ports' && GET) return { ports: portList() };
    if (path === '/api/suite/cameras') return GET ? camerasView() : postCameras(body);
    if (GET && /^\/api\/suite\/snapshot\/\d+\.jpg$/.test(path)) return fail(404, 'The demo draws its cameras live inside the page, so there is no JPEG file to fetch.');
    if (path === '/api/suite/checklist' && GET) return checklist();
    if (path === '/api/suite/progress') return GET ? progress() : postProgress(body);
    if (path === '/api/suite/identify') return GET ? identifyView() : postIdentify(body);
    if (path === '/api/suite/role' && !GET) {
      const a = armBy({ port: body.port });
      if (!a) return fail(404, 'That port is not connected. Check the cable and refresh the list.');
      if (!['follower', 'leader'].includes(body.role)) return fail(400, 'The role must be "follower" or "leader".');
      bindRole(a, body.role); return { ok: true, port: a.path, role: body.role, ports: portList() };
    }
    if (path === '/api/suite/motors' && !GET) return postMotors(body);
    if (path === '/api/suite/modules' && GET) return { modules: MODULES.map((x) => ({ ...clone(x), enabled: x.enabled && settingsView().adv.modulesEnabled !== false && !settingsView().adv.disabledModules.includes(x.id) })) };
    if ((m = path.match(/^\/api\/m\/([a-z][a-z0-9_]*)(\/.*)?$/))) {
      const mod = MODULES.find((x) => x.id === m[1]);
      if (!mod) return fail(404, `There is no module called "${m[1]}".`);
      if (mod.error) return fail(500, `The module "${mod.id}" did not load: ${mod.error}`);
      if (mod.id === 'hello' && m[2] === '/ping') return { ok: true, message: 'hello from the demo module' };
      if (mod.id === 'hello' && m[2] === '/greet') { const who = String((body && body.name) || 'world').slice(0, 40); return { message: `Hello, ${who}!`, arms_connected: [sim.follower, sim.leader].filter((a) => a && a.online).length, demo: true }; }
      return fail(404, `The ${mod.id} module has no route ${m[2] || '/'}.`);
    }
    if (path === '/api/suite/restart' && !GET) {
      if (sim.tele.on || sim.pp.running) return fail(409, 'The arm is still moving. Press Stop (and stop leader to follower), then restart.');
      return { ok: true, restarting: true, message: 'Demo mode: there is nothing to restart, the page just carries on.' };
    }
    if (path === '/api/suite/onboarded' && !GET) { const r = postSettings({ ui: { onboarded: !!body.value } }); return isMockError(r) ? r : { ok: true, onboarded: !!body.value }; }
    if (path === '/api/suite/settings') return GET ? settingsView() : postSettings(body);
    if (path === '/api/suite/defaults' && GET) {
      const eff = clone(DEFAULTS), st = storedSettings();
      deepMerge(eff, Object.fromEntries(Object.entries(st).filter(([k, v]) => k in eff && isObj(v))));
      return { defaults: clone(DEFAULTS), effective: eff };
    }
    if (path === '/api/suite/diagnostics' && GET) return diagnostics();
    if (path === '/api/suite/trace') {
      if (GET) return S.trace.query({ since: q.get('since'), kinds: q.get('kinds'), limit: q.get('limit') });
      const was = S.trace.enabled;
      S.trace.configure({ enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined, raw: typeof body.raw === 'boolean' ? body.raw : undefined, clear: !!body.clear, max: typeof body.max === 'number' ? body.max : undefined });
      if (!was && S.trace.enabled) logStartup();
      if (was && !S.trace.enabled) S.trace.push(sec(), 'log', true, 0, { level: 'info', source: 'trace', msg: 'Recording stopped' });
      return { ...S.trace.status(), items: [] };
    }
    if (path === '/api/suite/trace/export' && GET) return S.trace.export(['json', 'ndjson', 'text'].includes(q.get('format')) ? q.get('format') : 'json');
    return fail(404, `Nothing is served at ${path}.`);
  }

  function ppAction(act, b) {
    const sim = S.sim, pp = sim.pp;
    try {
      if (act === 'teach') pp.teach(b.u, b.v);
      else if (act === 'zone') pp.setPoint(b.name, b.u, b.v);
      else if (act === 'auto') { if (b.on === false) pp.autoStop(); else pp.autoStart(); }
      else if (act === 'clear') pp.clearPoints();
      else if (act === 'undo') pp.undoPoint();
      else if (act === 'param') pp.setParam(b.k, b.v);
      else if (act === 'run') pp.run(b.mode || 'hover', b.cycles ?? 1);
      else if (act === 'goto') pp.gotoRobot(Number(b.x) / 1000, Number(b.y) / 1000, Number(b.z ?? 30) / 1000);
      else if (act === 'probe') pp.probeTable(Number(b.x ?? 200) / 1000, Number(b.y ?? -90) / 1000);
      else if (act === 'autocal') pp.autoCalibrate();
      else if (act === 'grip') pp.setGrip(Number(b.pct ?? 100));
      else if (act === 'vertical') pp.vertical(b.do === 'set');
      else if (act === 'align') pp.align(b);
      else if (act === 'stop') { sim.teleStop('stopped'); pp.stop(); }
      else if (act === 'reset') { sim.teleStop('reset'); pp.reset(); }
      else if (act === 'release') { sim.teleStop('arm released'); pp.release(); }
      else if (act === 'rest') { sim.teleStop('arm released'); pp.rest(); }
    } catch (e) { pp.status = `error: ${e.message}`; }
  }

  async function handle(method, path, body) {
    sync();
    let out;
    try { out = await route(method, path, body || {}); }
    catch (e) { out = fail(500, `The demo hit a problem: ${e.message}`); }
    const tr = S.trace;
    if (tr.enabled && !path.startsWith('/api/suite/trace')) {
      const err = isMockError(out);
      const size = typeof out === 'string' ? out.length : JSON.stringify(err ? out.json : out ?? {}).length;
      tr.http(S.sim.t || sec(), method, path.split('?')[0], err ? out.status : 200, size);
    }
    return out;
  }

  /* ----- cameras: pictures ----- */
  function sceneModel(i, t = 0, o = {}) {
    sync();
    const world = S.sim.worldForScene(i);
    return buildScene(i, t, world, { overlay: o.raw ? false : undefined });
  }
  function cameraFrame(i, ctx, t = 0, size = { w: 640, h: 480 }) {
    sync();
    const W = size.w || 640, H = size.h || 480;
    if (i >= S.cameras.length) {
      ctx.save(); ctx.fillStyle = '#10151c'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#9fb0c4'; ctx.font = '600 16px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`No camera ${i + 1} added yet`, W / 2, H / 2); ctx.restore();
      return null;
    }
    const model = buildScene(i, t, S.sim.worldForScene(i), { overlay: size.raw ? false : undefined });
    drawScene(ctx, model, { w: W, h: H }, seed);
    return model.meta;
  }

  init();
  return {
    get: (path) => handle('GET', path, {}),
    post: (path, body) => handle('POST', path, body),
    cameraFrame,
    sceneModel,
    /** start over as if it were the first visit (settings and progress too, unless keepSettings) */
    reset(o = {}) { if (!o.keepSettings) { try { storage.removeItem(KEY.settings); storage.removeItem(KEY.progress); } catch { /* ignore */ } } init(); },
    /** the live simulation, for tests and screenshot scripts (not part of the HTTP surface) */
    get sim() { return S.sim; },
    options: { seed, scenario, os: osName },
  };
}

export default createMockBackend;
