// Tests for the in-browser mock backend. Run: node --test tests/js/mock.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMockBackend, isMockError } from '../../app/suite/js/mock/backend.js';
import { buildChecklist } from '../../app/suite/js/mock/checklist.js';
import { DEFAULTS } from '../../app/suite/js/mock/defaults.js';
import { packets, fk, ik } from '../../app/suite/js/mock/sim.js';

const ROOT = new URL('../../', import.meta.url);
const T0 = 1_760_000_000_000;

/** A backend with a clock the test controls. sleep() moves the clock, so awaited waits (a wiggle) finish instantly. */
function env(opts = {}) {
  const e = { clock: T0 };
  const sleep = async (ms) => { e.clock += ms; if (e.onSleep) await e.onSleep(); };
  const b = createMockBackend({ seed: 1, now: () => e.clock, sleep, ...opts });
  e.b = b;
  e.get = (p) => b.get(p);
  e.post = (p, body = {}) => b.post(p, body);
  e.state = () => b.get('/api/state');
  /** advance simulated time and let the backend see it */
  e.wait = async (s) => { e.clock += s * 1000; return e.state(); };
  e.arm = async (i) => (await e.state()).arms[i];
  return e;
}
async function calibrate(e, idx) {
  await e.post(`/api/calib/${idx}/start`);
  await e.wait(3);
  await e.post(`/api/calib/${idx}/center`);
  for (let k = 0; k < 40; k++) {
    const r = (await e.arm(idx)).calib.ranges;
    if (Object.values(r).every(([lo, hi]) => hi - lo >= 150)) break;
    await e.wait(1);
  }
  await e.post(`/api/calib/${idx}/finish`);
  return e.arm(idx);
}
const keys = (o) => Object.keys(o).sort();

/* ------------------------------------------------------------------ calibration */
test('calibration_flow_reaches_done', async () => {
  const e = env();
  let a = await e.arm(0);
  assert.equal(a.calibrated, false);
  assert.deepEqual(a.calib, { step: 'idle' });
  await e.post('/api/calib/0/start');
  a = await e.arm(0);
  assert.deepEqual(a.calib, { step: 'center', role: 'follower', id: 'my_follower' });
  await e.wait(3);
  await e.post('/api/calib/0/center');
  a = await e.arm(0);
  assert.equal(a.calib.step, 'sweep');
  assert.equal(a.calib.error, null);
  assert.ok(a.joints.every((j) => j.pos === 2047), 'after centring every joint reads the middle');
  let spans = {};
  for (let k = 0; k < 40; k++) {                              // the simulated hand sweeps one joint after another
    await e.wait(1);
    a = await e.arm(0);
    spans = Object.fromEntries(Object.entries(a.calib.ranges).map(([n, [lo, hi]]) => [n, hi - lo]));
    if (Object.values(spans).every((s) => s >= 150)) break;
  }
  assert.ok(Object.values(spans).every((s) => s >= 150), `every span >= 150 ticks: ${JSON.stringify(spans)}`);
  await e.post('/api/calib/0/finish');
  a = await e.arm(0);
  assert.equal(a.calib.step, 'done');
  assert.equal(a.calibrated, true);
  assert.equal(a.calib.error, null);
  assert.match(a.calib.saved, /so_follower[/\\]my_follower\.json$/);
  assert.deepEqual(a.cal.wrist_roll, [0, 4095], 'wrist roll is always the full turn');
  for (const [n, [lo, hi]] of Object.entries(a.cal)) assert.ok(hi - lo >= 150 && lo >= 0 && hi <= 4095, n);
});

test('calibration_rejects_unmoved_joint', async () => {
  const e = env();
  await e.post('/api/calib/0/start');
  await e.post('/api/calib/0/center');
  await e.post('/api/calib/0/finish');                        // no time has passed: nothing moved
  const a = await e.arm(0);
  assert.equal(a.calib.step, 'sweep', 'stays in the sweep step');
  assert.equal(a.calibrated, false);
  assert.match(a.calib.error, /^Move these joints through their full range: shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, gripper$/);
  assert.ok(!a.calib.error.includes('wrist_roll'), 'wrist roll is never checked (it spins freely)');
  await e.post('/api/calib/0/cancel');
  assert.deepEqual((await e.arm(0)).calib, { step: 'idle' });
});

test('zero_at_middle', async () => {
  const e = env();
  const a = await calibrate(e, 0);
  assert.equal(a.calibrated, true);
  for (const j of a.joints) {
    const [lo, hi] = a.cal[j.name], mid = (lo + hi) / 2;
    assert.equal(((mid - mid) * 360) / 4095, 0);
    // a joint reading `mid` is 0 degrees; one tick above is +360/4095 degrees
    assert.ok(Math.abs(((mid + 1 - mid) * 360) / 4095 - 360 / 4095) < 1e-9);
    assert.ok(mid > 0 && mid < 4095);
  }
  // the readings that the UI turns into degrees stay inside the recorded range once calibrated
  await e.wait(8);
  const b = await e.arm(0);
  for (const j of b.joints) { const [lo, hi] = b.cal[j.name]; assert.ok(j.pos >= lo && j.pos <= hi, `${j.name} ${j.pos} in [${lo}, ${hi}]`); }
});

test('first_calibration_becomes_the_default_restore_point', async () => {
  const e = env();
  assert.equal((await e.arm(0)).has_default, false);
  const a = await calibrate(e, 0);
  assert.equal(a.has_default, true, 'done => has_default');
  const first = JSON.stringify(a.cal);
  await calibrate(e, 0);                                      // a second calibration must not replace the default
  assert.equal((await e.arm(0)).has_default, true);
  await e.post('/api/calib/0/restore');
  const r = await e.arm(0);
  assert.equal(JSON.stringify(r.cal), first, 'restore brings the first calibration back');
  assert.equal(r.notice, 'Default calibration restored to the motors');
});

/* ------------------------------------------------------------------ teleop */
test('teleop_refused_until_both_calibrated', async () => {
  const e = env();
  let s = await e.state();
  assert.equal(s.teleop.on, false);
  assert.equal(s.teleop.why, 'Both arms need a calibration first (Arms tab)');
  await e.post('/api/teleop/start');
  s = await e.state();
  assert.equal(s.teleop.on, false);
  assert.equal(s.teleop.msg, 'Both arms need a calibration first (Arms tab)');
  await calibrate(e, 0);
  await e.post('/api/calib/0/cancel');                        // the "Done" button of the dashboard: leaves the finished step
  await e.post('/api/teleop/start');
  s = await e.state();
  assert.equal(s.teleop.on, false, 'one calibrated arm is not enough');
  await calibrate(e, 1);
  s = await e.state();
  assert.equal(s.teleop.why, 'An arm is busy (calibration or test)', 'a finished calibration is still "busy" until Done is pressed');
  await e.post('/api/calib/1/cancel');
  s = await e.state();
  assert.equal(s.teleop.why, null);
  await e.post('/api/teleop/start');
  s = await e.state();
  assert.equal(s.teleop.on, true);
  await e.wait(12);
  s = await e.state();
  assert.equal(s.teleop.synced, true);
  assert.equal(s.teleop.msg, 'following the leader');
  assert.equal(s.teleop.hz, 40);
  // the follower copies the leader through the range mapping: same fraction of its own range
  const [f, l] = [s.arms[0], s.arms[1]];
  for (const n of ['shoulder_pan', 'shoulder_lift', 'elbow_flex']) {
    const lf = (l.joints.find((j) => j.name === n).pos - l.cal[n][0]) / (l.cal[n][1] - l.cal[n][0]);
    const ff = (f.joints.find((j) => j.name === n).pos - f.cal[n][0]) / (f.cal[n][1] - f.cal[n][0]);
    assert.ok(Math.abs(lf - ff) < 0.08, `${n}: follower ${ff.toFixed(3)} vs leader ${lf.toFixed(3)}`);
  }
  await e.post('/api/teleop/stop');
  s = await e.state();
  assert.equal(s.teleop.on, false);
  assert.equal(s.pp.limp, false, 'the follower keeps holding where it is');
});

test('teleop_why_sentences_match_the_real_server', async () => {
  let e = env({ scenario: 'nothing' });
  assert.equal((await e.state()).teleop.why, 'No arms are connected');
  e = env({ scenario: 'ready' });
  await e.post('/api/demo/connect', { port: e.b.sim.arms[1].path, ids: [] });     // unplug the leader
  assert.equal((await e.state()).teleop.why, "Plug the leader arm into this computer's USB first (only the follower is connected)");
  await e.post('/api/demo/connect', { port: e.b.sim.arms[0].path, ids: [] });
  await e.post('/api/demo/connect', { port: e.b.sim.arms[1].path, ids: [1, 2, 3, 4, 5, 6] });
  assert.equal((await e.state()).teleop.why, 'The follower arm is not connected');
  await e.post('/api/demo/connect', { port: e.b.sim.arms[0].path, ids: [1, 2, 3, 4, 5, 6] });
  assert.equal((await e.state()).teleop.why, null);
  await e.post('/api/calib/0/start');
  assert.equal((await e.state()).teleop.why, 'An arm is busy (calibration or test)');
});

/* ------------------------------------------------------------------ pick and place: teaching */
test('teach_points_accumulate_and_fit', async () => {
  const e = env();
  let pp = (await e.state()).pp;
  assert.equal(pp.taught, 0);
  assert.equal(pp.fit_mm, null);
  assert.equal(pp.why, 'Calibrate the camera first: press “Tune…” then “Auto-calibrate” (or press “Re-map the table”)');
  await e.post('/api/pp/teach', { u: 320, v: 240 });
  pp = (await e.state()).pp;
  assert.equal(pp.taught, 0);
  assert.equal(pp.status, 'error: follower arm not online/calibrated', 'teaching needs a calibrated follower');
  await calibrate(e, 0);
  await e.post('/api/pp/auto', { on: false });
  let taught = 0, lastStatus = '';
  for (let k = 0; k < 60 && taught < 4; k++) {
    await e.wait(1.5);
    const tip = e.b.sceneModel(0, 0).meta.tip;                 // where the tip is in camera 1's picture
    await e.post('/api/pp/teach', { u: tip.u, v: tip.v });
    pp = (await e.state()).pp;
    if (pp.taught > taught) { taught = pp.taught; lastStatus = pp.status; if (taught < 3) assert.equal(pp.fit_mm, null); }
    else assert.match(pp.status, /hasn't moved since the last point/, 'a tip that did not move is rejected');
  }
  assert.equal(taught, 4, 'four moved spots accumulate');
  assert.match(lastStatus, /^taught point 4 · fit error \d+\.\d mm$/);
  pp = (await e.state()).pp;
  assert.equal(typeof pp.fit_mm, 'number');
  assert.ok(pp.fit_mm >= 0 && pp.fit_mm < 5, `fit ${pp.fit_mm}`);
  assert.equal(pp.cams[0].cal, true);
  assert.equal(typeof pp.z_table_mm, 'number');
  await e.post('/api/pp/undo');
  assert.equal((await e.state()).pp.taught, 3);
  await e.post('/api/pp/clear');
  pp = (await e.state()).pp;
  assert.equal(pp.taught, 0);
  assert.equal(pp.fit_mm, null);
});

test('teach_refused_while_the_arm_has_torque', async () => {
  const e = env({ scenario: 'ready' });
  await e.post('/api/pp/clear');
  assert.equal((await e.state()).pp.limp, false);
  await e.post('/api/pp/teach', { u: 300, v: 200 });
  assert.equal((await e.state()).pp.status, "error: the arm is not limp: press 'Make arm limp' first, then move it by hand");
  await e.post('/api/pp/release');
  assert.equal((await e.state()).pp.status, 'released (torque off)');
  assert.equal((await e.state()).pp.limp, true);
});

test('auto_mapping_saves_spots_when_the_hand_holds_still', async () => {
  const e = env();
  await calibrate(e, 0);
  await e.post('/api/pp/auto', { on: true });
  let saw = new Set(), pp;
  for (let k = 0; k < 90; k++) { await e.wait(1); pp = (await e.state()).pp; saw.add(pp.auto.why); if (pp.taught >= 3) break; }
  assert.ok(pp.taught >= 3, `auto mapping saved ${pp.taught} spots (saw ${[...saw].join(', ')})`);
  assert.ok(saw.has('hold') && saw.has('move'), 'the wizard hints are reported');
  assert.equal(typeof pp.fit_mm, 'number');
  assert.ok(pp.auto.saved_at > T0 / 1000 - 1, 'saved_at is in epoch seconds, like the real server');
  await e.post('/api/pp/auto', { on: false });
  assert.equal((await e.state()).pp.auto.on, false);
});

test('ready_scenario_can_pick_and_place', async () => {
  const e = env({ scenario: 'ready' });
  let pp = (await e.state()).pp;
  assert.equal(pp.ready, true);
  assert.equal(pp.why, null);
  assert.equal(pp.ncam, 2);
  assert.equal(pp.cams.length, 2);
  assert.equal(pp.fusion.cams.length, 2);
  await e.post('/api/pp/run', { mode: 'bowl' });
  assert.equal((await e.state()).pp.running, true);
  for (let k = 0; k < 60 && (await e.state()).pp.running; k++) await e.wait(1);
  pp = (await e.state()).pp;
  assert.equal(pp.running, false);
  assert.match(pp.status, /keychain is no longer visible: it is probably inside the bowl/);
  assert.equal(e.b.sim.world.keychain.state, 'bowl');
});

/* ------------------------------------------------------------------ checklist */
test('checklist_matches_shared_cases', () => {
  const cases = JSON.parse(fs.readFileSync(new URL('tests/checklist_cases.json', ROOT), 'utf8'));
  assert.ok(cases.length >= 15, 'the shared case file has cases');
  for (const c of cases) {
    const r = buildChecklist(c.snapshot);
    assert.equal(r.summary.next, c.expect.next, `${c.name}: next`);
    const ids = r.items.map((i) => i.id);
    for (const [id, status] of Object.entries(c.expect.statuses)) assert.equal(r.items[ids.indexOf(id)].status, status, `${c.name}: ${id}`);
    for (const it of r.items) if (!['ok', 'skip'].includes(it.status)) { assert.ok(it.detail.length > 10, `${c.name}: ${it.id} has a detail`); assert.ok(it.fix && it.fix.page, `${c.name}: ${it.id} has a fix`); }
  }
});

test('checklist_output_is_identical_to_the_python_one_when_python_is_available', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const cases = JSON.parse(fs.readFileSync(new URL('tests/checklist_cases.json', ROOT), 'utf8'));
  const code = 'import sys, json; sys.path.insert(0, "."); from so101.checklist import build; cases = json.load(open("tests/checklist_cases.json")); print(json.dumps({c["name"]: build(c["snapshot"]) for c in cases}))';
  const r = spawnSync('python3', ['-I', '-c', code], { cwd: ROOT.pathname, encoding: 'utf8' });
  if (r.error || r.status !== 0) return t.skip('python3 is not available here');
  const py = JSON.parse(r.stdout);
  for (const c of cases) assert.deepEqual(JSON.parse(JSON.stringify(buildChecklist(c.snapshot))), py[c.name], c.name);
});

test('checklist_follows_the_simulated_bench', async () => {
  let e = env({ scenario: 'nothing' });
  let c = await e.get('/api/suite/checklist');
  assert.equal(c.summary.next, 'adapter_found');
  e = env({ scenario: 'fresh' });
  c = await e.get('/api/suite/checklist');
  assert.equal(c.summary.next, 'follower_calibrated');
  await calibrate(e, 0);
  assert.equal((await e.get('/api/suite/checklist')).items.find((i) => i.id === 'follower_calibrated').status, 'ok');
  e = env({ scenario: 'ready' });
  assert.equal((await e.get('/api/suite/checklist')).summary.next, null);
  e = env({ scenario: 'ready', os: 'linux', inDialout: false });
  c = await e.get('/api/suite/checklist');
  assert.equal(c.summary.next, 'serial_permission');
  assert.match(c.items.find((i) => i.id === 'serial_permission').detail, /sudo usermod -aG dialout \$USER/);
});

test('assembly_done_follows_the_progress_key', async () => {
  const e = env({ scenario: 'nothing' });
  const item = async () => (await e.get('/api/suite/checklist')).items.find((i) => i.id === 'assembly_done');
  assert.equal((await item()).status, 'todo');
  await e.post('/api/suite/progress', { key: 'assembly.step.shoulder', value: true });
  assert.equal((await item()).status, 'todo', 'a single step is not the whole assembly');
  assert.equal((await e.get('/api/suite/progress'))['assembly.step.shoulder'], true);
  const p = await e.post('/api/suite/progress', { 'assembly.done': true });
  assert.equal(p['assembly.done'], true);
  assert.equal((await item()).status, 'ok');
  assert.equal((await e.get('/api/suite/checklist')).summary.next, 'adapter_found');
  await e.post('/api/suite/progress', { key: 'assembly.done', value: false });
  assert.equal((await item()).status, 'todo');
});

/* ------------------------------------------------------------------ settings, defaults, info */
test('settings_roundtrip', async () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const e = env({ storage });
  let s = await e.get('/api/suite/settings');
  assert.deepEqual(keys(s), ['adv', 'safety', 'ui']);
  assert.equal(s.ui.theme, 'auto');
  assert.equal(s.ui.units, 'deg');
  assert.equal(s.safety.confirm_before_move, true);
  s = await e.post('/api/suite/settings', { ui: { theme: 'dark', accent: 'blue', guide: 'expert', units: 'norm', textSize: 'large', reduceMotion: true }, safety: { speed_preset: 'normal' }, adv: { rawLinks: true } });
  assert.equal(s.ui.theme, 'dark');
  await e.post('/api/suite/settings', { 'ui.accent': 'green' });                   // dotted keys work too
  const again = createMockBackend({ seed: 1, storage });                           // a "page reload": same storage, new backend
  s = await again.get('/api/suite/settings');
  assert.equal(s.ui.theme, 'dark');
  assert.equal(s.ui.accent, 'green');
  assert.equal(s.ui.guide, 'expert');
  assert.equal(s.ui.units, 'norm');
  assert.equal(s.ui.textSize, 'large');
  assert.equal(s.ui.reduceMotion, true);
  assert.equal(s.safety.speed_preset, 'normal');
  assert.equal(s.safety.confirm_before_move, true, 'untouched keys keep their defaults');
  assert.equal(s.adv.rawLinks, true);
  const bad = await again.post('/api/suite/settings', { ui: { theme: 'neon' } });
  assert.ok(isMockError(bad));
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /ui\.theme must be one of: auto, dark, light/);
  assert.equal((await again.get('/api/suite/settings')).ui.theme, 'dark', 'a rejected value changes nothing');
  await again.post('/api/suite/settings', { ui: { notAKey: 1 }, nope: { a: 1 } });  // unknown keys are ignored
  assert.equal((await again.get('/api/suite/settings')).ui.notAKey, undefined);
  again.reset();
  assert.equal((await again.get('/api/suite/settings')).ui.theme, 'auto', 'reset() starts over');
});

test('calibration_prompt_and_onboarded_persist_through_settings', async () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const e = env({ storage });
  let info = await e.get('/api/suite/info');
  assert.equal(info.first_calibration_needed, true);
  assert.deepEqual(info.uncalibrated, ['follower', 'leader']);
  assert.equal(info.onboarded, false);
  await e.post('/api/suite/settings', { ui: { calibrationPrompted: true } });
  info = await e.get('/api/suite/info');
  assert.equal(info.first_calibration_needed, false, 'prompted once: do not ask again');
  assert.deepEqual(info.uncalibrated, ['follower', 'leader'], 'but the list of uncalibrated arms is still true');
  await e.post('/api/suite/settings', { ui: { onboarded: true } });
  const reload = createMockBackend({ seed: 1, storage });
  const s = await reload.get('/api/suite/settings');
  assert.equal(s.ui.calibrationPrompted, true);
  assert.equal(s.ui.onboarded, true);
  assert.equal((await reload.get('/api/suite/info')).onboarded, true);
  assert.equal((await reload.post('/api/suite/onboarded', { value: false })).onboarded, false);
  assert.equal((await reload.get('/api/suite/settings')).ui.onboarded, false);
});

test('info_first_calibration_needed_per_scenario', async () => {
  assert.equal((await env({ scenario: 'fresh' }).get('/api/suite/info')).first_calibration_needed, true);
  const ready = await env({ scenario: 'ready' }).get('/api/suite/info');
  assert.equal(ready.first_calibration_needed, false);
  assert.deepEqual(ready.uncalibrated, []);
  const nothing = await env({ scenario: 'nothing' }).get('/api/suite/info');
  assert.equal(nothing.first_calibration_needed, false, 'no connected arm, nothing to calibrate');
  const e = env({ scenario: 'fresh' });
  await calibrate(e, 0);
  const i = await e.get('/api/suite/info');
  assert.deepEqual(i.uncalibrated, ['leader']);
  assert.equal(i.first_calibration_needed, true);
  await calibrate(e, 1);
  assert.equal((await e.get('/api/suite/info')).first_calibration_needed, false);
});

test('info_has_the_documented_fields', async () => {
  const i = await env().get('/api/suite/info');
  assert.equal(i.demo, true);
  assert.equal(i.license, 'AGPL-3.0-or-later');
  assert.match(i.version, /^\d+\.\d+\.\d+/);
  assert.equal(i.data_dir, '~/.so101');
  assert.deepEqual(keys(i.links), ['docs', 'issues', 'repo']);
  assert.deepEqual(i.trace, { enabled: false, raw: false });
  assert.equal(typeof i.modules, 'number');
  assert.equal(i.repo, i.links.repo);
});

test('defaults_endpoint_has_defaults_and_effective', async () => {
  const e = env();
  let d = await e.get('/api/suite/defaults');
  assert.deepEqual(keys(d), ['defaults', 'effective']);
  assert.deepEqual(d.defaults, DEFAULTS);
  assert.deepEqual(d.effective, DEFAULTS);
  assert.deepEqual(d.defaults.serial, { baud: 1000000, scan_baud_rates: [1000000, 500000, 250000, 128000, 115200, 76800, 57600, 38400], motor_ids: { shoulder_pan: 1, shoulder_lift: 2, elbow_flex: 3, wrist_flex: 4, wrist_roll: 5, gripper: 6 } });
  await e.post('/api/suite/settings', { ui: { theme: 'light', onboarded: true }, safety: { speed_preset: 'normal' } });
  d = await e.get('/api/suite/defaults');
  assert.equal(d.defaults.ui.theme, 'auto', 'defaults never change');
  assert.equal(d.effective.ui.theme, 'light');
  assert.equal(d.effective.ui.onboarded, true);
  assert.equal(d.effective.ui.accent, 'orange', 'the rest of the section stays at its default');
  assert.equal(d.effective.safety.speed_preset, 'normal');
  assert.equal(d.effective.safety.load_limit_pct, 70);
  d.defaults.ui.theme = 'x';
  assert.equal((await e.get('/api/suite/defaults')).defaults.ui.theme, 'auto', 'callers get copies');
});

test('defaults_match_repo_file', (t) => {
  const url = new URL('defaults/so101.defaults.json', ROOT);
  if (!fs.existsSync(url)) return t.skip('defaults/so101.defaults.json does not exist yet');
  const strip = (o) => (Array.isArray(o) ? o.map(strip) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== '_doc').map(([k, v]) => [k, strip(v)])) : o);
  const file = strip(JSON.parse(fs.readFileSync(url, 'utf8')));
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULTS)), file);
});

/* ------------------------------------------------------------------ shape of /api/state */
test('state_shape_matches_server', async () => {
  const ARM_KEYS = ['port', 'role', 'online', 'calibrated', 'has_default', 'cal', 'notice', 'volt', 'wiggling', 'calib', 'faults', 'joints'];
  const JOINT_KEYS = ['id', 'name', 'pos', 'load', 'temp'];
  const TELEOP_KEYS = ['on', 'msg', 'hz', 'blocked', 'synced', 'why', 'both'];
  const PP_KEYS = ['ncam', 'cams', 'cam_mode', 'fusion', 'kc_mm', 'kc_z_mm', 'kc_gap_mm', 'bowl_mm', 'cam_cal', 'cam_rms', 'z_table_mm', 'limp', 'auto', 'taught', 'fit_mm', 'z_table', 'ready', 'why', 'why_bowl', 'zones', 'here', 'align', 'tilt', 'status', 'log', 'grip_gap', 'running', 'mode', 'cycles', 'found', 'bowl_rim_mm', 'params', 'ready_bowl'];
  const TOP_KEYS = ['camera', 'camera_age', 'camera_err', 'camera_fps', 'camera_src', 'cameras', 'viz', 'pp', 'teleop', 'arms'];
  const CAM_KEYS = ['ok', 'age', 'fps', 'err', 'src'];
  const PPCAM_KEYS = ['cal', 'rms', 'sees'];

  // the lists above were read from the real server: make sure the source still mentions every one of them
  const server = fs.readFileSync(new URL('app/server.py', ROOT), 'utf8');
  const pick = fs.readFileSync(new URL('app/pickplace.py', ROOT), 'utf8');
  const fn = (src, cls, name) => { const a = src.indexOf(`class ${cls}`); const b = src.indexOf(`def ${name}(`, a); return src.slice(b, b + 3500); };
  const armSrc = fn(server, 'Arm', 'state'), teleSrc = fn(server, 'Teleop', 'state'), ppSrc = pick.slice(pick.lastIndexOf('def state(self)'));
  for (const k of [...ARM_KEYS, ...JOINT_KEYS]) assert.ok(armSrc.includes(`"${k}"`), `Arm.state() still has ${k}`);
  for (const k of TELEOP_KEYS) assert.ok(teleSrc.includes(`"${k}"`), `Teleop.state() still has ${k}`);
  for (const k of PP_KEYS) assert.ok(new RegExp(`\\b${k}=`).test(ppSrc), `PickPlace.state() still has ${k}`);
  for (const k of TOP_KEYS.filter((x) => x !== 'cameras')) assert.ok(server.includes(`"${k}"`), `/api/state still has ${k}`);

  for (const scenario of ['fresh', 'ready', 'nothing', 'stiff']) {
    const e = env({ scenario });
    await e.wait(1);
    const s = await e.state();
    assert.deepEqual(keys(s), keys(Object.fromEntries(TOP_KEYS.map((k) => [k, 1]))), `${scenario}: top level`);
    assert.deepEqual(keys(s.teleop), [...TELEOP_KEYS].sort(), `${scenario}: teleop`);
    assert.deepEqual(keys(s.pp), [...PP_KEYS].sort(), `${scenario}: pp`);
    for (const a of s.arms) { assert.deepEqual(keys(a), [...ARM_KEYS].sort(), `${scenario}: arm`); for (const j of a.joints) assert.deepEqual(keys(j), [...JOINT_KEYS].sort(), `${scenario}: joint`); }
    for (const c of s.cameras) assert.deepEqual(keys(c), [...CAM_KEYS].sort());
    for (const c of s.pp.cams) assert.deepEqual(keys(c), [...PPCAM_KEYS].sort());
    assert.deepEqual(keys(s.pp.params), ['auto_bowl', 'bowl_clear', 'grasp_dz', 'off_x', 'off_y', 'roll_offset', 'travel']);
    assert.deepEqual(keys(s.pp.align), ['gap_mm', 'n', 'r_mm', 'undo']);
    assert.deepEqual(keys(s.pp.zones), ['bowl', 'tray']);
    assert.deepEqual(keys(s.pp.zones.tray), ['drop', 'p', 'r']);
    assert.deepEqual(keys(s.viz), ['flip', 'offset']);
    assert.equal(s.pp.ncam, s.cameras.length);
    assert.equal(s.pp.cams.length, s.pp.ncam);
    assert.equal(JSON.stringify(s), JSON.stringify(JSON.parse(JSON.stringify(s))), 'plain JSON');
  }
  const e = env({ scenario: 'ready' });
  const s = await e.state();
  assert.equal(s.arms.length, 2);
  assert.deepEqual(s.arms.map((a) => a.role), ['follower', 'leader']);
  assert.equal(s.arms[0].joints.length, 6);
  assert.deepEqual(s.arms[0].joints.map((j) => j.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(s.arms[0].joints.map((j) => j.name), ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper']);
  for (const j of s.arms[0].joints) { assert.ok(Number.isInteger(j.pos) && j.pos >= 0 && j.pos <= 4095); assert.ok(Number.isInteger(j.temp) && j.temp > 20 && j.temp < 60); assert.ok(j.load >= -1000 && j.load <= 1000); }
  assert.ok(s.arms[0].volt > 11 && s.arms[0].volt < 13);
  assert.equal(s.arms[0].calibrated, true);
  assert.equal(s.arms[0].has_default, true);
  const n = env({ scenario: 'nothing' });
  const ns = await n.state();
  assert.deepEqual(ns.arms, []);
  assert.equal(ns.camera, false);
  assert.deepEqual(ns.cameras, []);
});

test('live_values_change_plausibly', async () => {
  const e = env({ scenario: 'ready' });
  const a0 = await e.arm(1), seen = new Set();
  for (let k = 0; k < 20; k++) { await e.wait(0.5); const a = await e.arm(1); a.joints.forEach((j) => seen.add(`${j.id}:${j.pos}`)); assert.ok(a.volt >= 11.2 && a.volt <= 12.2); }
  assert.ok(seen.size > 8, 'a limp leader barely moves but is not frozen');
  assert.equal(a0.joints.length, 6);
});

test('a_ten_minute_run_stays_finite_and_plain_json', async () => {
  const finite = (o, where) => {
    if (typeof o === 'number') assert.ok(Number.isFinite(o), `${where} is a finite number`);
    else if (Array.isArray(o)) o.forEach((v, i) => finite(v, `${where}[${i}]`));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) finite(v, `${where}.${k}`);
    else assert.ok(o === null || ['string', 'boolean'].includes(typeof o), `${where} is plain JSON`);
  };
  for (const scenario of ['fresh', 'ready', 'stiff']) {
    const e = env({ scenario });
    await e.post('/api/suite/trace', { enabled: true, raw: true, max: 2000 });
    if (scenario === 'fresh') { await calibrate(e, 0); await calibrate(e, 1); await e.post('/api/calib/0/cancel'); await e.post('/api/calib/1/cancel'); }
    await e.post('/api/teleop/start');
    for (let k = 0; k < 20; k++) {
      await e.wait(30);
      finite(await e.state(), `${scenario} state`);
      if (k === 8) { await e.post('/api/teleop/stop'); await e.post('/api/pp/auto', { on: true }); }
      if (k === 12) { await e.post('/api/pp/auto', { on: false }); await e.post('/api/pp/run', { mode: 'loop', cycles: 0 }); }
      if (k === 16) await e.post('/api/pp/stop');
      if (k === 17) await e.post('/api/pp/rest');
    }
    finite(await e.get('/api/suite/trace?limit=2000'), 'trace');
    const s = await e.state();
    assert.ok(s.arms.every((a) => a.joints.every((j) => j.pos >= 0 && j.pos <= 4095)));
  }
});

/* ------------------------------------------------------------------ determinism */
test('same_seed_same_timeline_same_state_and_different_seed_differs', async () => {
  const run = async (seed) => {
    const e = env({ seed, scenario: 'fresh' });
    await calibrate(e, 0);
    await e.wait(5);
    return JSON.stringify(await e.state());
  };
  assert.equal(await run(1), await run(1));
  assert.notEqual(await run(1), await run(2));
  const a = env(), b = env();
  const sa = a.b.sceneModel(0, 1.5), sb = b.b.sceneModel(0, 1.5);
  assert.deepEqual(sa, sb, 'a camera picture is a pure function of seed, state and t');
});

test('time_comes_only_from_the_injected_clock', async () => {
  const e = env({ scenario: 'ready' });
  const s1 = JSON.stringify(await e.state()), s2 = JSON.stringify(await e.state());
  assert.equal(s1, s2, 'no time passed, nothing changed');
  await e.wait(2);
  assert.notEqual(JSON.stringify(await e.state()), s1);
});

/* ------------------------------------------------------------------ the Suite API surface */
test('platform_ports_cameras_modules_and_unknown_paths', async () => {
  let e = env();
  const p = await e.get('/api/suite/platform');
  assert.equal(p.os, 'macos'); assert.equal(p.arch, 'arm64');
  assert.deepEqual(keys(p), ['arch', 'camera_backend', 'in_dialout', 'is_pi', 'notes', 'os', 'os_version', 'pi_model', 'python', 'serial_examples', 'uv']);
  assert.equal((await env({ os: 'linux' }).get('/api/suite/platform')).os, 'linux');
  assert.equal((await env({ os: 'windows' }).get('/api/suite/platform')).os, 'windows');
  assert.equal((await e.get('/api/suite/platform?os=linux')).camera_backend, 'V4L2');
  assert.ok((await env({ os: 'pi' }).get('/api/suite/platform')).is_pi);
  assert.match((await env({ os: 'windows' }).get('/api/suite/ports')).ports[0].path, /^COM\d+$/);
  assert.match((await env({ os: 'linux' }).get('/api/suite/ports')).ports[0].path, /^\/dev\/ttyACM\d$/);

  const ports = (await e.get('/api/suite/ports')).ports;
  assert.equal(ports.length, 2);
  for (const q of ports) { assert.deepEqual(keys(q), ['description', 'key', 'likely_servo_board', 'location', 'manufacturer', 'owned_by_app', 'path', 'pid', 'role', 'serial', 'vid']); assert.equal(q.likely_servo_board, true); assert.equal(q.owned_by_app, true); assert.equal(q.key, q.serial); }

  const cams = await e.get('/api/suite/cameras');
  assert.equal(cams.cameras.length, 1);
  assert.equal(cams.detected.length, 1);
  assert.deepEqual(keys(cams.cameras[0]), ['calibrated', 'err', 'fps', 'height', 'id', 'in_use', 'kind', 'name', 'ok', 'source', 'width']);
  let r = await e.post('/api/suite/cameras', { action: 'add', source: 1 });
  assert.equal(r.restart_needed, true);
  assert.equal((await e.get('/api/suite/cameras')).cameras.length, 2);
  assert.equal((await e.get('/api/suite/cameras')).detected.length, 0);
  assert.equal((await e.state()).pp.ncam, 2);
  assert.equal((await e.post('/api/suite/cameras', { action: 'rename', id: 1, name: 'Side view' })).ok, true);
  assert.equal((await e.get('/api/suite/cameras')).cameras[1].name, 'Side view');
  r = await e.post('/api/suite/cameras', { action: 'add', source: 'not a url' });
  assert.equal(r.status, 400);
  r = await e.post('/api/suite/cameras', { action: 'add', source: 'http://pi.local:8000/raw.mjpg' });
  assert.equal(r.restart_needed, true);
  await e.post('/api/suite/cameras', { action: 'remove', id: 2 });
  assert.equal((await e.state()).pp.ncam, 2);

  const mods = (await e.get('/api/suite/modules')).modules;
  assert.deepEqual(mods.map((m) => m.id), ['hello', 'broken_example']);
  const hello = mods[0];
  assert.equal(hello.name, 'Hello module'); assert.equal(hello.version, '0.1.0'); assert.equal(hello.enabled, true); assert.equal(hello.error, null);
  assert.deepEqual(hello.pages, [{ id: 'hello', title: 'Hello', icon: 'sparkles', script: 'ui.js' }]);
  assert.equal(mods[1].error, 'Could not load backend.py: SyntaxError on line 3');
  assert.equal(mods[1].enabled, false);
  assert.deepEqual(await e.get('/api/m/hello/ping'), { ok: true, message: 'hello from the demo module' });
  assert.deepEqual(await e.post('/api/m/hello/ping', {}), { ok: true, message: 'hello from the demo module' });
  assert.equal((await e.get('/api/m/broken_example/ping')).status, 500);
  assert.equal((await e.get('/api/m/nope/ping')).status, 404);

  const nf = await e.get('/api/suite/nothing-here');
  assert.ok(isMockError(nf)); assert.equal(nf.status, 404); assert.equal(typeof nf.json.error, 'string');
  assert.equal((await e.get('/api/nope')).status, 404);

  const diag = await e.get('/api/suite/diagnostics');
  assert.equal(typeof diag, 'string');
  assert.match(diag, /Checklist: \d+ of \d+ ok/);
  assert.ok(!/usbmodem\d/.test(diag), 'adapter serial numbers are masked');
  assert.equal((await e.get('/api/health')).ok, true);

  e = env();
  const rs = await e.post('/api/suite/restart');
  assert.equal(rs.ok, true);
});

test('identify_flow_binds_the_role_and_roles_swap', async () => {
  const e = env();
  assert.deepEqual((await e.get('/api/suite/ports')).ports.map((p) => p.role), [null, null]);
  assert.equal((await e.get('/api/suite/identify')).state, 'idle');
  let r = await e.post('/api/suite/identify', { action: 'start', role: 'leader' });
  assert.equal(r.state, 'unplug');
  assert.match(r.message, /Unplug the USB cable of the leader arm/);
  await e.wait(3);
  r = await e.get('/api/suite/identify');
  assert.equal(r.state, 'replug');
  assert.ok(r.port);
  assert.equal((await e.get('/api/suite/ports')).ports.length, 1, 'the unplugged adapter is gone from the list');
  assert.equal((await e.state()).arms.find((a) => a.role === 'leader').online, false);
  await e.wait(3);
  r = await e.get('/api/suite/identify');
  assert.equal(r.state, 'done');
  assert.equal((await e.get('/api/suite/ports')).ports.find((p) => p.role === 'leader').path, r.port);
  assert.equal((await e.state()).arms.find((a) => a.role === 'leader').online, true);
  // binding the other adapter to "leader" swaps, so there are never two of a kind
  const [pf, pl] = (await e.get('/api/suite/ports')).ports;
  await e.post('/api/suite/role', { port: pf.path, role: 'leader' });
  const roles = (await e.get('/api/suite/ports')).ports.map((p) => p.role).sort();
  assert.deepEqual(roles, ['follower', 'leader']);
  assert.equal((await e.post('/api/suite/role', { port: 'nope', role: 'leader' })).status, 404);
  assert.equal((await e.post('/api/suite/identify', { action: 'start', role: 'banana' })).status, 400);
  await e.post('/api/suite/identify', { action: 'start', role: 'follower' });
  await e.post('/api/suite/identify', { action: 'cancel' });
  assert.equal((await e.get('/api/suite/identify')).state, 'idle');
  assert.equal((await env({ scenario: 'nothing' }).post('/api/suite/identify', { action: 'start', role: 'follower' })).state, 'error');
});

test('motor_ids_scan_and_set_id_refusals', async () => {
  const e = env({ scenario: 'ready' });
  const port = (await e.get('/api/suite/ports')).ports[0].path;
  let r = await e.post('/api/suite/motors', { action: 'scan', port });
  assert.deepEqual(r.ids, [1, 2, 3, 4, 5, 6]);
  assert.equal(r.baud, 1000000);
  r = await e.post('/api/suite/motors', { action: 'set_id', port, id: 6 });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /^6 motors answer \(IDs 1, 2, 3, 4, 5, 6\)\. Unplug all but the one/);
  await e.post('/api/demo/connect', { port, ids: [] });
  assert.match((await e.post('/api/suite/motors', { action: 'set_id', port, id: 1 })).json.error, /No motor answers/);
  await e.post('/api/demo/connect', { port, ids: [1] });
  assert.equal((await e.post('/api/suite/motors', { action: 'set_id', port, id: 7 })).status, 400);
  r = await e.post('/api/suite/motors', { action: 'set_id', port, id: 6 });
  assert.equal(r.ok, true); assert.equal(r.id, 6); assert.equal(r.joint, 'gripper');
  assert.deepEqual((await e.post('/api/suite/motors', { action: 'scan', port })).ids, [6]);
  const f = (await e.state()).arms[0];
  assert.deepEqual(f.joints.map((j) => j.id), [6]);
  await e.post('/api/calib/0/start');
  await e.post('/api/demo/connect', { port, ids: [1] });
  assert.match((await e.post('/api/suite/motors', { action: 'set_id', port, id: 2 })).json.error, /Finish or stop/);
  assert.equal((await e.post('/api/suite/motors', { action: 'frobnicate', port })).status, 400);
});

/* ------------------------------------------------------------------ ping and wiggle */
test('ping_is_read_only_and_reports_the_motor', async () => {
  const e = env({ scenario: 'ready' });
  await e.wait(1);
  const before = JSON.stringify((await e.state()).arms[0].joints.map((j) => j.pos));
  const r = await e.post('/api/suite/motors', { action: 'ping', role: 'follower', id: 3 });
  assert.deepEqual(keys(r), ['id', 'joint', 'load_pct', 'ms', 'ok', 'position', 'temp_c', 'volt']);
  assert.equal(r.ok, true); assert.equal(r.id, 3); assert.equal(r.joint, 'elbow_flex');
  assert.ok(Number.isInteger(r.position) && r.position > 0 && r.position < 4096);
  assert.ok(r.load_pct >= 0 && r.load_pct <= 100); assert.ok(r.temp_c > 20 && r.temp_c < 80); assert.ok(r.volt > 11 && r.volt < 13); assert.ok(r.ms > 0 && r.ms < 10);
  const byPort = await e.post('/api/suite/motors', { action: 'ping', port: e.b.sim.arms[1].path, id: 1 });
  assert.equal(byPort.ok, true);
  assert.equal(JSON.stringify((await e.state()).arms[0].joints.map((j) => j.pos)), before, 'a ping never moves anything');
  assert.equal((await e.post('/api/suite/motors', { action: 'ping', role: 'follower', id: 0 })).status, 400);
  assert.equal((await e.post('/api/suite/motors', { action: 'ping', role: 'follower' })).status, 400);
  assert.equal((await env({ scenario: 'nothing' }).post('/api/suite/motors', { action: 'ping', role: 'follower', id: 1 })).status, 404);
});

test('wiggle_moves_one_joint_about_ten_degrees_and_ends_in_the_state_it_started', async () => {
  for (const scenario of ['ready', 'fresh']) {                // ready: follower holding torque; fresh: follower limp
    const e = env({ scenario });
    await e.wait(2);
    const start = (await e.state()).arms[0];
    const limp0 = (await e.state()).pp.limp;
    const g0 = start.joints.find((j) => j.id === 6).pos, p1 = start.joints.find((j) => j.id === 1).pos;
    let peak = 0, sawMid = false, others = 0;
    e.onSleep = async () => {                                  // the arm really moves while the call waits
      const a = (await e.state()).arms[0];
      peak = Math.max(peak, Math.abs(a.joints.find((j) => j.id === 6).pos - g0));
      others = Math.max(others, Math.abs(a.joints.find((j) => j.id === 1).pos - p1));
      sawMid ||= a.wiggling === false;
    };
    const t0 = e.clock;
    const r = await e.post('/api/suite/motors', { action: 'wiggle', role: 'follower', id: 6 });
    e.onSleep = null;
    assert.deepEqual(keys(r), ['id', 'joint', 'message', 'moved_deg', 'ok', 'peak_load_pct'], scenario);
    assert.equal(r.ok, true); assert.equal(r.id, 6); assert.equal(r.joint, 'gripper');
    assert.ok(r.moved_deg >= 8 && r.moved_deg <= 13, `moved ${r.moved_deg}`);
    assert.match(r.message, /^Motor 6 moved \d+ degrees\. It works\.$/);
    assert.ok(r.peak_load_pct >= 0 && r.peak_load_pct <= 100);
    assert.ok(e.clock - t0 >= 1500 && e.clock - t0 <= 4000, `took ~2 s of simulated time (${e.clock - t0} ms)`);
    assert.ok(peak >= 80, `the 3D model sees the joint move (${peak} ticks)`);
    assert.ok(others < 8, `the other joints are held still (${others})`);
    await e.wait(1);
    const end = await e.state();
    if (!limp0) assert.ok(Math.abs(end.arms[0].joints.find((j) => j.id === 6).pos - g0) < 12, 'a holding arm comes back to where it started');
    assert.equal(end.pp.limp, limp0, `${scenario}: torque state unchanged`);
    assert.equal(end.arms[0].wiggling, false);
    void sawMid;
  }
});

test('wiggle_is_refused_with_a_sentence_when_unsafe', async () => {
  let e = env({ scenario: 'fresh' });
  await e.post('/api/calib/0/start');
  let r = await e.post('/api/suite/motors', { action: 'wiggle', role: 'follower', id: 2 });
  assert.equal(r.status, 409); assert.match(r.json.error, /Calibration is running/);
  e = env({ scenario: 'ready' });
  await e.post('/api/teleop/start'); await e.wait(1);
  r = await e.post('/api/suite/motors', { action: 'wiggle', role: 'follower', id: 2 });
  assert.equal(r.status, 409); assert.match(r.json.error, /Leader to follower is running/);
  await e.post('/api/teleop/stop');
  await e.post('/api/pp/run', { mode: 'hover' });
  r = await e.post('/api/suite/motors', { action: 'wiggle', role: 'follower', id: 2 });
  assert.equal(r.status, 409); assert.match(r.json.error, /Pick & place is running/);
  await e.post('/api/pp/stop');
  await e.post('/api/demo/connect', { port: e.b.sim.arms[0].path, ids: [] });
  r = await e.post('/api/suite/motors', { action: 'wiggle', role: 'follower', id: 2 });
  assert.equal(r.status, 409); assert.match(r.json.error, /follower arm is not connected/);
  r = await e.post('/api/suite/motors', { action: 'ping', role: 'follower', id: 2 });
  assert.equal(r.status, 409);
});

test('a_broken_motor_gives_the_red_row', async () => {
  const e = env({ scenario: 'ready', brokenMotors: { follower: [4] } });
  const MSG = 'Motor 4 did not answer. Check its 3-pin cable and that the power supply is on.';
  const ping = await e.post('/api/suite/motors', { action: 'ping', role: 'follower', id: 4 });
  assert.equal(ping.ok, false); assert.equal(ping.id, 4); assert.equal(ping.joint, 'wrist_flex'); assert.equal(ping.position, null); assert.equal(ping.message, MSG);
  const wig = await e.post('/api/suite/motors', { action: 'wiggle', role: 'follower', id: 4 });
  assert.equal(wig.ok, false); assert.equal(wig.message, MSG);
  assert.equal((await e.post('/api/suite/motors', { action: 'ping', role: 'follower', id: 3 })).ok, true, 'the other motors answer');
  const f = (await e.state()).arms[0];
  assert.deepEqual(f.joints.map((j) => j.id), [1, 2, 3, 5, 6]);
  const c = (await e.get('/api/suite/checklist')).items.find((i) => i.id === 'follower_motors');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /Missing IDs: 4/);
  assert.equal((await e.post('/api/suite/motors', { action: 'ping', role: 'leader', id: 4 })).ok, true, 'only the follower is broken');
  await e.post('/api/demo/connect', { port: e.b.sim.arms[0].path, ids: [1, 2, 3, 4, 5, 6] });      // "re-seat the cable"
  assert.equal((await e.post('/api/suite/motors', { action: 'ping', role: 'follower', id: 4 })).ok, true);
});

/* ------------------------------------------------------------------ nudge / wiggle (legacy) / viz / roles */
test('legacy_calls_nudge_wiggle_viz_role', async () => {
  const e = env({ scenario: 'ready' });
  await e.post('/api/pp/release');
  await e.wait(1);
  const p0 = (await e.arm(0)).joints.find((j) => j.name === 'wrist_flex').pos;
  await e.post('/api/nudge/0/wrist_flex');
  assert.equal((await e.arm(0)).wiggling, true);
  let peak = 0;
  for (let k = 0; k < 20; k++) { await e.wait(0.25); peak = Math.max(peak, Math.abs((await e.arm(0)).joints.find((j) => j.name === 'wrist_flex').pos - p0)); }
  assert.ok(peak > 60, `nudge moved the joint (${peak})`);
  assert.equal((await e.arm(0)).wiggling, false);
  await e.post('/api/wiggle/1');
  assert.equal((await e.arm(1)).wiggling, true);
  await e.wait(10);
  assert.equal((await e.arm(1)).wiggling, false);
  await e.post('/api/viz', { joint: 'wrist_flex', flip: true, offset: 5 });
  assert.deepEqual((await e.state()).viz, { flip: { wrist_flex: true }, offset: { wrist_flex: 5 } });
  await e.post('/api/role/0', { role: 'leader' });
  assert.deepEqual((await e.state()).arms.map((a) => a.role), ['leader', 'follower'], 'setting a role swaps the pair');
  assert.deepEqual(await e.post('/api/calib/9/start'), {}, 'an unknown arm index is ignored like the real server');
});

/* ------------------------------------------------------------------ trace (the Inspector) */
test('trace_is_off_by_default_and_records_when_enabled', async () => {
  const e = env({ scenario: 'ready' });
  await e.wait(2);
  let t = await e.get('/api/suite/trace');
  assert.deepEqual([t.enabled, t.raw, t.seq, t.dropped, t.items.length], [false, false, 0, 0, 0]);
  assert.deepEqual((await e.get('/api/suite/info')).trace, { enabled: false, raw: false });
  const st = await e.post('/api/suite/trace', { enabled: true });
  assert.equal(st.enabled, true);
  assert.deepEqual((await e.get('/api/suite/info')).trace, { enabled: true, raw: false });
  await e.wait(1.2);
  await e.post('/api/suite/motors', { action: 'ping', role: 'follower', id: 2 });
  t = await e.get('/api/suite/trace?limit=5000');
  assert.equal(t.enabled, true);
  assert.ok(t.items.length > 100);
  for (const it of t.items) {
    assert.ok(Number.isInteger(it.seq) && typeof it.t === 'number' && typeof it.ok === 'boolean' && typeof it.ms === 'number', JSON.stringify(it));
    assert.ok(['bus', 'http', 'log', 'raw'].includes(it.kind));
    assert.ok(it.t > T0 / 1000 - 1 && it.t < T0 / 1000 + 100, 'epoch seconds');
  }
  assert.deepEqual(t.items.map((i) => i.seq), [...t.items.map((i) => i.seq)].sort((a, b) => a - b), 'newest last');
  assert.ok(t.items.every((it, n) => n === 0 || it.t >= t.items[n - 1].t), 'time never goes backwards');
  const bus = t.items.filter((i) => i.kind === 'bus'), http = t.items.filter((i) => i.kind === 'http'), log = t.items.filter((i) => i.kind === 'log');
  assert.ok(bus.length > 50 && http.length >= 1 && log.length >= 1);
  for (const b of bus) { assert.deepEqual(keys(b), ['addr', 'err', 'id', 'kind', 'ms', 'ok', 'op', 'port', 'reg', 'seq', 't', 'value']); assert.ok(b.ms >= 0.4 && b.ms <= 2.5, `bus ms ${b.ms}`); assert.ok(['ping', 'read1', 'read2', 'write1', 'write2'].includes(b.op)); }
  const poll = bus.filter((b) => b.reg === 'Present_Position' && b.op === 'read2');
  assert.deepEqual([...new Set(poll.filter((b) => b.port === bus[0].port).map((b) => b.id))].sort(), [1, 2, 3, 4, 5, 6]);
  for (const reg of ['Present_Position', 'Present_Load', 'Present_Temperature', 'Status']) assert.ok(bus.some((b) => b.reg === reg), `${reg} is polled`);
  assert.ok(bus.some((b) => b.op === 'ping' && b.id === 2), 'the ping was recorded');
  for (const h of http) { assert.deepEqual(keys(h), ['kind', 'method', 'ms', 'ok', 'path', 'seq', 'size', 'status', 't']); }
  assert.ok(http.some((h) => h.path === '/api/state' && h.status === 200 && h.size > 100));
  assert.ok(http.some((h) => h.path === '/api/suite/motors' && h.method === 'POST'));
  assert.ok(!http.some((h) => h.path.startsWith('/api/suite/trace')), 'the Inspector does not record itself');
  for (const l of log) { assert.deepEqual(keys(l), ['kind', 'level', 'ms', 'msg', 'ok', 'seq', 'source', 't']); assert.ok(['info', 'warn', 'error'].includes(l.level)); }
  assert.ok(!t.items.some((i) => i.kind === 'raw'), 'raw bytes are off by default');
  await e.post('/api/suite/trace', { enabled: false });
  const n = (await e.get('/api/suite/trace')).seq;
  await e.wait(2);
  assert.equal((await e.get('/api/suite/trace')).seq, n, 'nothing is recorded while off');
});

test('trace_events_for_calibration_and_teleop', async () => {
  const e = env({ scenario: 'fresh' });
  await e.post('/api/suite/trace', { enabled: true, max: 100000 });       // the 10 Hz polling would otherwise push the events out of a 5,000-row buffer
  await calibrate(e, 0);
  const t = await e.get('/api/suite/trace?kinds=log&limit=100');
  const msgs = t.items.map((i) => i.msg);
  assert.ok(msgs.some((m) => /Follower: calibration started/.test(m)));
  assert.ok(msgs.some((m) => /Follower: calibration saved to .*my_follower\.json/.test(m)));
  assert.ok(msgs.some((m) => /Camera 1: \d+\.\d fps/.test(m)), 'camera fps is logged every 10 s');
  assert.ok(t.items.every((i) => i.kind === 'log'));
  const wr = (await e.get('/api/suite/trace?kinds=bus&limit=100000')).items.filter((i) => i.op === 'write2' && i.reg === 'Homing_Offset');
  assert.ok(wr.length >= 6, 'centring writes the homing offsets');
});

test('trace_raw_rows_are_valid_feetech_packets', async () => {
  const e = env({ scenario: 'ready' });
  await e.post('/api/suite/trace', { enabled: true, raw: true });
  assert.deepEqual((await e.get('/api/suite/info')).trace, { enabled: true, raw: true });
  await e.wait(0.5);
  const t = await e.get('/api/suite/trace?kinds=raw,bus&limit=5000');
  const raw = t.items.filter((i) => i.kind === 'raw');
  assert.ok(raw.length > 50);
  for (const r of raw) {
    assert.deepEqual(keys(r), ['dir', 'hex', 'kind', 'ms', 'ok', 'port', 'seq', 't']);
    assert.ok(['tx', 'rx'].includes(r.dir));
    const b = r.hex.split(' ').map((h) => parseInt(h, 16));
    assert.deepEqual(b.slice(0, 2), [0xff, 0xff]);
    assert.equal(b[3], b.length - 4, 'the length byte counts instruction + params + checksum');
    assert.equal(b[b.length - 1], (~b.slice(2, -1).reduce((x, y) => x + y, 0)) & 255, 'checksum');
  }
  const tx = raw.find((r) => r.dir === 'tx'), rx = raw.find((r) => r.dir === 'rx');
  assert.equal(parseInt(tx.hex.split(' ')[4], 16), 0x02, 'a read instruction');
  assert.equal(parseInt(rx.hex.split(' ')[4], 16), 0x00, 'a status packet with no error');
  assert.deepEqual(packets('read2', 3, 56, 2047), { tx: 'ff ff 03 04 02 38 02 bc', rx: 'ff ff 03 04 00 ff 07 f2' });
  assert.equal(packets('ping', 1, 0, 0).tx, 'ff ff 01 02 01 fb');
  await e.post('/api/suite/trace', { raw: false });
  const n = (await e.get('/api/suite/trace')).seq;
  await e.wait(1);
  assert.ok(!(await e.get(`/api/suite/trace?since=${n}&limit=5000`)).items.some((i) => i.kind === 'raw'));
});

test('trace_since_paging_kinds_limit_and_ring_buffer', async () => {
  const e = env({ scenario: 'ready' });
  await e.post('/api/suite/trace', { enabled: true });
  await e.wait(1);
  const first = await e.get('/api/suite/trace?limit=10');
  assert.equal(first.items.length, 10, 'no `since`: the latest N');
  assert.equal(first.items.at(-1).seq, first.seq);
  await e.wait(1);
  const next = await e.get(`/api/suite/trace?since=${first.seq}&limit=10000`);
  assert.ok(next.items.length > 20);
  assert.ok(next.items.every((i) => i.seq > first.seq));
  assert.equal(next.items[0].seq, first.seq + 1, 'paging has no gaps');
  const paged = await e.get(`/api/suite/trace?since=${first.seq}&limit=7`);
  assert.deepEqual(paged.items.map((i) => i.seq), Array.from({ length: 7 }, (_, k) => first.seq + 1 + k), 'with `since` the oldest newer items come first');
  assert.deepEqual((await e.get(`/api/suite/trace?since=${next.seq}`)).items.filter((i) => i.seq <= next.seq), []);
  const only = await e.get('/api/suite/trace?kinds=http,log&limit=1000');
  assert.ok(only.items.length >= 1 && only.items.every((i) => ['http', 'log'].includes(i.kind)));
  // ring buffer
  await e.post('/api/suite/trace', { max: 100 });
  await e.wait(3);
  let r = await e.get('/api/suite/trace?limit=100000');
  assert.ok(r.items.length <= 100, `ring buffer holds at most max (${r.items.length})`);
  assert.ok(r.dropped > 0);
  assert.ok(r.seq > 100 + r.dropped - 1);
  assert.equal(r.seq - r.dropped, r.items.length, 'seq = kept + dropped');
  assert.equal((await e.post('/api/suite/trace', { max: 5000 })).max, 5000);
  await e.post('/api/suite/trace', { clear: true });
  r = await e.get('/api/suite/trace');
  assert.deepEqual([r.items.length, r.dropped], [0, 0]);
  assert.ok(r.seq > 100, 'seq keeps counting after a clear');
});

test('trace_export_formats', async () => {
  const e = env({ scenario: 'ready' });
  await e.post('/api/suite/trace', { enabled: true });
  await e.wait(1);
  const json = JSON.parse(await e.get('/api/suite/trace/export?format=json'));
  assert.deepEqual(keys(json), ['dropped', 'enabled', 'items', 'raw', 'seq']);
  assert.ok(json.items.length > 20);
  const nd = (await e.get('/api/suite/trace/export?format=ndjson')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(nd.length, json.items.length);
  assert.ok(nd.every((i) => i.seq && i.kind));
  const text = await e.get('/api/suite/trace/export?format=text');
  assert.match(text, /\d\d:\d\d:\d\d\.\d{3}  bus {3}ok +[\d.]+ ms  read2 motor \d Present_Position\(56\) -> \d+/);
  assert.match(text, /http {2}ok .* GET \/api\/state -> 200/);
  assert.equal(typeof (await e.get('/api/suite/trace/export')), 'string', 'default format is json text');
});

test('trace_settings_adv_keys_apply_and_persist', async () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const e = env({ storage, scenario: 'ready' });
  let s = await e.get('/api/suite/settings');
  assert.deepEqual([s.adv.trace, s.adv.traceRaw, s.adv.traceMax], [false, false, 5000]);
  await e.post('/api/suite/settings', { adv: { trace: true, traceRaw: true, traceMax: 300 } });
  assert.deepEqual((await e.get('/api/suite/info')).trace, { enabled: true, raw: true });
  await e.wait(1);
  assert.ok((await e.get('/api/suite/trace?limit=1000')).items.length <= 300);
  const reload = env({ storage, scenario: 'ready' });                              // "start recording on launch"
  assert.deepEqual((await reload.get('/api/suite/info')).trace, { enabled: true, raw: true });
  assert.equal((await reload.post('/api/suite/settings', { adv: { traceMax: 50 } })).status, 400);
  assert.equal((await reload.post('/api/suite/settings', { adv: { trace: 'yes' } })).status, 400);
});

/* ------------------------------------------------------------------ cameras: pictures */
test('scene_model_needs_no_canvas_and_follows_the_arm', async () => {
  const e = env({ scenario: 'ready' });
  const m0 = e.b.sceneModel(0, 0), m1 = e.b.sceneModel(1, 0);
  for (const m of [m0, m1]) {
    assert.equal(m.w, 640); assert.equal(m.h, 480);
    assert.ok(m.shapes.length > 40);
    assert.ok(m.shapes.some((s) => s.k === 'label' && /^DEMO CAMERA [12]$/.test(s.text)));
    const tip = m.meta.tip;
    assert.ok(tip.u > 0 && tip.u < 640 && tip.v > 0 && tip.v < 480, `the gripper is in the picture (${tip.u}, ${tip.v})`);
    assert.ok(m.meta.keychain && m.meta.bowl && m.meta.tray);
  }
  assert.ok(m0.shapes.some((s) => s.k === 'label' && s.text === 'DEMO CAMERA 1'));
  assert.ok(m1.shapes.some((s) => s.k === 'label' && s.text === 'DEMO CAMERA 2'));
  assert.ok(m0.shapes.some((s) => s.k === 'text' && s.text === 'keychain'), 'the app marks the keychain it found');
  assert.ok(m0.shapes.filter((s) => s.k === 'text' && /^[1-4]$/.test(s.text)).length === 4, 'taught points are numbered');
  const before = m0.meta.tip;
  await e.post('/api/pp/run', { mode: 'hover' });
  await e.wait(4);
  const after = e.b.sceneModel(0, 0).meta;
  assert.ok(Math.hypot(after.tip.u - before.u, after.tip.v - before.v) > 15, 'the silhouette follows the simulated follower');
  assert.ok(Math.hypot(after.tip.u - after.keychain.u, after.tip.v - after.keychain.v) < 80, 'the tip moves toward the keychain');
  const raw = e.b.sceneModel(0, 0, { raw: true });
  assert.ok(!raw.shapes.some((s) => s.k === 'text' && s.text === 'keychain'), 'raw pictures have no overlay');
});

test('camera_frame_draws_on_a_stub_context', () => {
  const e = env({ scenario: 'ready' });
  const calls = [];
  const get = (_, p) => {
    if (p === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (p === 'measureText') return () => ({ width: 80 });
    return (...a) => { calls.push([p, a]); };
  };
  const ctx = new Proxy({}, { get, set: () => true });
  const meta = e.b.cameraFrame(0, ctx, 1.25, { w: 640, h: 480 });
  assert.ok(calls.length > 100, 'it painted');
  assert.ok(meta.tip);
  assert.equal(e.b.cameraFrame(5, ctx, 0, { w: 640, h: 480 }), null, 'a camera that is not added shows a message, not a crash');
  const sc = env({ scenario: 'nothing' });
  assert.equal(sc.b.cameraFrame(0, ctx, 0), null);
});

test('kinematics_sanity', () => {
  const q = ik([0.2, -0.07, -0.008]);
  assert.ok(q, 'a table spot is reachable');
  const { tip, appr } = fk(q);
  assert.ok(Math.hypot(tip[0] - 0.2, tip[1] + 0.07, tip[2] + 0.008) < 0.003);
  assert.ok(appr[2] < -0.99, 'tool points straight down');
  assert.equal(ik([2, 2, 2]), null, 'out of reach');
});

/* ------------------------------------------------------------------ the owner's standing safety rule: never ask a person to act near a STIFF arm
   (docs/LEARNINGS.md 17). POST /api/pp/rest lowers the follower onto the table and only THEN lets go; a bare release / a calibration start drops it at once. */
test('scenario_stiff_starts_with_the_follower_holding_itself_and_calibrated', async () => {
  const e = env({ scenario: 'stiff' });
  const s = await e.state();
  assert.equal(s.pp.limp, false, 'the follower is stiff (torque on)');
  assert.equal(s.pp.running, false);
  assert.equal(s.pp.taught, 0, 'nothing is mapped yet: the whole Cameras flow can be demoed');
  assert.deepEqual(s.arms.map((a) => [a.role, a.online, a.calibrated]), [['follower', true, true], ['leader', true, true]]);
  assert.equal((await e.get('/api/suite/info')).first_calibration_needed, false);
  assert.equal((await env({ scenario: 'ready' }).state()).pp.limp, false, 'ready is stiff too, but it already has the table mapped');
  assert.equal((await env({ scenario: 'fresh' }).state()).pp.limp, true, 'a brand-new arm is limp (STS3215 torque is off at power-up)');
  assert.equal(env({ scenario: 'stiff' }).b.options.scenario, 'stiff');
});

test('rest_lowers_the_arm_first_and_only_then_lets_go', async () => {
  const e = env({ scenario: 'stiff' });
  await e.wait(1);
  const before = (await e.arm(0)).joints.map((j) => j.pos);
  assert.deepEqual(await e.post('/api/pp/rest'), {}, 'the HTTP answer is always {}');
  let s = await e.state();
  assert.equal(s.pp.running, true, 'a job is lowering the arm');
  assert.equal(s.pp.mode, 'rest');
  assert.equal(s.pp.limp, false, 'still stiff the moment it starts: nothing is dropped');
  assert.match(s.pp.status, /lowering the arm onto the table/);
  s = await e.wait(1);
  assert.equal(s.pp.limp, false, 'still holding itself half way down (about 2 s in total)');
  assert.equal(s.pp.running, true);
  const mid = s.arms[0].joints.map((j) => j.pos);
  assert.notDeepEqual(mid, before, 'the arm really moved while it was stiff');
  s = await e.wait(2);
  assert.equal(s.pp.limp, true, 'limp afterwards');
  assert.equal(s.pp.running, false);
  assert.match(s.pp.status, /the arm is limp, resting on the table/);
  const tip = (arm) => fk(Object.fromEntries(['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll'].map((n) => {
    const j = arm.joints.find((x) => x.name === n), r = arm.cal[n], mid2 = (r[0] + r[1]) / 2;
    return [n, ((j.pos - mid2) * 360 / 4095) * Math.PI / 180];
  }))).tip;
  assert.ok(tip(s.arms[0])[2] < 0.1, 'resting low over the table');
});

test('rest_when_already_limp_just_says_so_and_a_bare_release_switches_the_torque_off_at_once', async () => {
  const e = env({ scenario: 'stiff' });
  await e.post('/api/pp/release');                                  // what a bare release does: the torque goes off AT ONCE (a raised arm would drop)
  let s = await e.state();
  assert.equal(s.pp.limp, true);
  assert.equal(s.pp.status, 'released (torque off)');
  await e.post('/api/pp/rest');
  s = await e.state();
  assert.equal(s.pp.limp, true);
  assert.equal(s.pp.running, false, 'nothing to lower');
  assert.match(s.pp.status, /the arm is limp \(it already was\)/);
});

test('starting_a_calibration_switches_the_torque_off_at_once_so_the_page_waits_for_limp', async () => {
  const e = env({ scenario: 'stiff' });
  assert.equal((await e.state()).pp.limp, false);
  await e.post('/api/calib/0/start');
  const s = await e.state();
  assert.equal(s.arms[0].calib.step, 'center');
  assert.equal(s.pp.limp, true, 'immediately: this is why a raised stiff arm would drop and the pages call rest first');
});

test('rest_is_refused_when_the_follower_is_not_calibrated_and_the_arm_stays_stiff', async () => {
  const e = env({ scenario: 'fresh' });                             // fresh: the follower is not calibrated
  e.b.sim.arms[0].torque_on = true;                                 // a LeRobot script left it holding
  assert.equal((await e.state()).pp.limp, false);
  assert.deepEqual(await e.post('/api/pp/rest'), {});
  await e.wait(3);
  const s = await e.state();
  assert.equal(s.pp.limp, false, 'refused: the arm is still stiff');
  assert.equal(s.pp.running, false);
  assert.equal(s.pp.status, 'error: follower arm not online/calibrated (the arm is still STIFF: it was not released)');
  const off = env({ scenario: 'ready' });                           // an offline follower is refused the same way
  off.b.sim.arms[0].online = false;
  await off.post('/api/pp/rest');
  assert.match((await off.state()).pp.status, /follower arm not online\/calibrated \(the arm is still STIFF/);
});

test('rest_stops_the_leader_link_first_and_STOP_keeps_the_arm_stiff', async () => {
  const e = env({ scenario: 'ready' });
  await e.post('/api/teleop/start');
  await e.wait(1);
  assert.equal((await e.state()).teleop.on, true);
  await e.post('/api/pp/rest');                                     // like the real server: the leader link is stopped first, then the arm is lowered
  let s = await e.wait(0.5);
  assert.equal(s.teleop.on, false);
  assert.equal(s.pp.mode, 'rest');
  assert.equal(s.pp.limp, false);
  await e.post('/api/pp/stop');                                     // STOP while lowering: the arm holds where it is, still stiff
  s = await e.wait(1);
  assert.equal(s.pp.limp, false);
  assert.equal(s.pp.running, false);
  assert.match(s.pp.status, /stopped \(the arm is still stiff and holding position\)/);
});

test('rest_ignores_a_second_press_while_it_is_lowering', async () => {
  const e = env({ scenario: 'stiff' });
  await e.post('/api/pp/rest');
  await e.wait(0.5);
  await e.post('/api/pp/rest');
  const s = await e.wait(3);
  assert.equal(s.pp.limp, true);
  assert.equal(s.pp.running, false);
});
