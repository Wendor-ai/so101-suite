// JS port of so101/checklist.py. The Python file is the single source of truth: this port must pass the same cases
// (tests/checklist_cases.json). Keep the two in step: same ids, same order, same status rules, same sentences.
export const IDS = [1, 2, 3, 4, 5, 6];
export const ORDER = ['python', 'uv', 'serial_permission', 'adapter_found', 'arm_roles', 'follower_connected', 'follower_motors', 'follower_calibrated',
  'leader_connected', 'leader_motors', 'leader_calibrated', 'camera_found', 'camera_working', 'camera_mapped', 'assembly_done'];
const GROUPS = {
  python: 'computer', uv: 'computer', serial_permission: 'computer', adapter_found: 'arms', arm_roles: 'arms',
  follower_connected: 'arms', follower_motors: 'arms', follower_calibrated: 'calibration',
  leader_connected: 'arms', leader_motors: 'arms', leader_calibrated: 'calibration',
  camera_found: 'cameras', camera_working: 'cameras', camera_mapped: 'cameras', assembly_done: 'extras',
};
const TITLES = {
  python: 'Python 3.10 or newer', uv: 'uv installed', serial_permission: 'Permission to use serial ports',
  adapter_found: 'USB adapter found', arm_roles: 'Leader and follower named', follower_connected: 'Follower arm connected',
  follower_motors: 'Follower motors answer (IDs 1-6)', follower_calibrated: 'Follower calibrated',
  leader_connected: 'Leader arm connected (optional)', leader_motors: 'Leader motors answer (IDs 1-6)',
  leader_calibrated: 'Leader calibrated', camera_found: 'Camera found', camera_working: 'Camera shows a picture',
  camera_mapped: 'Camera mapped to the table', assembly_done: 'Arm assembled',
};
const ACTIONS = {
  python: 'Install a newer Python',
  uv: 'Install uv',
  serial_permission: 'Allow serial ports',
  adapter_found: 'Plug in the USB adapter',
  arm_roles: 'Tell the app which arm is which',
  follower_connected: 'Connect the follower arm',
  follower_motors: 'Fix the follower motors',
  follower_calibrated: 'Calibrate the follower arm',
  leader_connected: 'Connect the leader arm',
  leader_motors: 'Fix the leader motors',
  leader_calibrated: 'Calibrate the leader arm',
  camera_found: 'Add a camera',
  camera_working: 'Get a camera picture',
  camera_mapped: 'Map the camera to the table',
  assembly_done: 'Build the arm',
};
const FIX_SETUP = { label: 'How to connect', page: 'setup' };
const fix = (label, page) => ({ label, page });

// Like Python's _get: null/undefined at any level means "use the default".
function get(d, path, dflt) {
  let cur = d;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(p in cur) || cur[p] === null || cur[p] === undefined) return dflt;
    cur = cur[p];
  }
  return cur;
}

function version(v) {
  const nums = String(v || '').match(/\d+/g) || [];
  return [nums.length ? parseInt(nums[0], 10) : 0, nums.length > 1 ? parseInt(nums[1], 10) : 0];
}
const verGE = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] >= b[1]);
const plural = (n, w) => `${w}${n !== 1 ? 's' : ''}`;

/** snapshot -> {items:[CheckItem], summary:{ok,total,next}} (see so101/checklist.py for the snapshot shape). */
export function buildChecklist(snap) {
  snap = snap || {};
  const plat = get(snap, ['platform'], {});
  const ports = get(snap, ['ports'], []);
  const arms = get(snap, ['arms'], {});
  const follower = arms.follower || null;
  const leader = arms.leader || null;
  const cams = get(snap, ['cameras', 'configured'], []);
  const detected = parseInt(get(snap, ['cameras', 'detected'], 0) || 0, 10) || 0;
  const progress = get(snap, ['progress'], {});
  const assemblyTicked = !!(progress['assembly.done'] || progress.assembly_done);        // the old spellings are accepted too
  const camerasSkipped = !!(progress['cameras.skipped'] || progress.cameras_skipped);
  const res = {};
  const put = (id, status, detail, fx = null) => { res[id] = { id, group: GROUPS[id], title: TITLES[id], action: ACTIONS[id], status, detail, fix: fx }; };

  // --- computer ---
  const py = String(plat.python || '');
  if (verGE(version(py), [3, 10])) put('python', 'ok', `Python ${py} is fine.`);
  else put('python', 'fail', `Python ${py || '(unknown)'} is too old: this app needs Python 3.10 or newer. Run the setup script again, it installs a suitable Python for you.`, fix('Run setup again', 'setup'));
  if (plat.uv) put('uv', 'ok', 'uv is installed. It keeps the app and its Python up to date.');
  else put('uv', 'skip', 'uv is not installed. The app runs without it; install it later if you want easy updates.');
  const dialout = plat.in_dialout;
  if (dialout === false) put('serial_permission', 'fail', 'Linux does not let your user open serial ports yet. Run this once in a terminal, then log out and log back in: sudo usermod -aG dialout $USER', fix('Show me how', 'setup'));
  else if (dialout === true) put('serial_permission', 'ok', 'Your user is allowed to use serial ports.');
  else put('serial_permission', 'skip', 'Nothing to set up: this computer lets you use serial ports without extra permission.');

  // --- adapter ---
  const n = ports.length;
  if (n) {
    const likely = ports.filter((p) => p.likely_servo_board).length;
    const extra = likely ? '' : ' None of them looks like the usual servo adapter, but if your arm answers below that is fine.';
    put('adapter_found', 'ok', `${n} USB serial ${plural(n, 'adapter')} found.${extra}`);
  } else {
    put('adapter_found', 'todo', "No USB adapter found yet. Plug the USB cable from the motor controller board into this computer, and plug the board's power supply into the wall.", FIX_SETUP);
  }

  // --- are the roles confirmed? (a wrong guess would save a calibration in the wrong place) ---
  const guessed = [['follower', follower], ['leader', leader]].filter(([, a]) => a && a.online && a.role_confirmed === false);
  if (guessed.length) {
    const [r, a] = guessed[0];
    put('arm_roles', 'todo', `The app guessed that the arm on ${a.port || 'this USB port'} is the ${r} arm. Tell it which arm is which, so each calibration is saved in the right place.`, fix('Tell the app', 'motors'));
  } else if ([follower, leader].some((a) => a && a.online)) put('arm_roles', 'ok', 'You told the app which arm is the leader and which is the follower.');
  else put('arm_roles', 'skip', 'Nothing to name yet: no arm is connected.');

  // --- arms ---
  const armItems = (role, arm, optional) => {
    const cid = `${role}_connected`, mid = `${role}_motors`, cal = `${role}_calibrated`;
    if (arm === null && optional) {
      put(cid, 'skip', 'Optional. A leader arm lets you move the follower by hand. Skip this if you only have one arm.');
      put(mid, 'skip', 'Only needed when a leader arm is connected.');
      put(cal, 'skip', 'Only needed when a leader arm is connected.');
      return;
    }
    const online = !!(arm && arm.online);
    const ids = [...new Set(((arm && arm.motor_ids) || []).map((i) => parseInt(i, 10)))].sort((a, b) => a - b);
    if (online) put(cid, 'ok', `The ${role} arm is connected.`);
    else if (arm !== null) {
      const why = arm.err ? ` (${arm.err})` : '';
      put(cid, 'fail', `The adapter is plugged in but no motor answers${why}. Check that the board's power supply is plugged in and that every 3-pin cable is clicked in all the way.`, fix('Check the motors', 'motors'));
    } else if (n) {
      put(cid, 'todo', `An adapter is plugged in, but the app is not talking to the ${role} arm through it yet. Give it a few seconds; if this stays, check the board's power supply and the cables.`, fix('Check the motors', 'motors'));
    } else {
      put(cid, 'todo', `Plug in the ${role} arm first: USB cable from its controller board to this computer, and the board's power supply.`, FIX_SETUP);
    }
    if (online) {
      const missing = IDS.filter((i) => !ids.includes(i));
      if (!missing.length) put(mid, 'ok', `All six ${role} motors answer (IDs 1 to 6).`);
      else put(mid, 'fail', `${ids.length} of 6 ${role} motors answer. Missing IDs: ${missing.join(', ')}. Check the cable going to those motors, or give a new motor its ID in Motor IDs.`, fix('Set motor IDs', 'motors'));
    } else {
      put(mid, 'todo', `Waiting for the ${role} arm to connect first.`, !n ? FIX_SETUP : fix('Check the motors', 'motors'));
    }
    if (arm && arm.calibrated) put(cal, 'ok', `The ${role} arm is calibrated: 0 is the middle of each joint's range.`);
    else if (online) put(cal, 'todo', `The ${role} arm is not calibrated yet. Calibration teaches the arm where the middle of each joint is, and it takes about two minutes.`, fix('Calibrate', 'calibrate'));
    else put(cal, 'todo', `Connect the ${role} arm first, then calibrate it.`, !n ? FIX_SETUP : fix('Check the motors', 'motors'));
  };
  armItems('follower', follower, false);
  armItems('leader', leader, true);

  // --- cameras ---
  const skipped = camerasSkipped && !cams.length;
  if (skipped) {
    for (const cid of ['camera_found', 'camera_working', 'camera_mapped']) put(cid, 'skip', 'You chose to skip cameras. They are only needed for pick & place.');
  } else {
    const total = cams.length + detected;
    if (cams.length || detected) put('camera_found', 'ok', `${total} ${plural(total, 'camera')} found.`);
    else put('camera_found', 'todo', 'No camera found. Plug in a USB camera, or add a network camera (for example one on a Raspberry Pi). Cameras are only needed for pick & place.', fix('Add a camera', 'cameras'));
    const working = cams.filter((c) => c.ok);
    if (working.length) put('camera_working', 'ok', 'A camera is delivering pictures.');
    else if (cams.length) {
      const err = (cams.find((c) => c.err) || {}).err || 'no picture yet';
      put('camera_working', 'fail', `The camera is added but shows no picture: ${err}.`, fix('Fix the camera', 'cameras'));
    } else if (detected) put('camera_working', 'todo', 'A camera was found but it is not added yet. Add it to see its picture.', fix('Add the camera', 'cameras'));
    else put('camera_working', 'todo', 'Waiting for a camera to be found.', fix('Add a camera', 'cameras'));
    if (cams.some((c) => c.calibrated)) put('camera_mapped', 'ok', 'A camera is mapped to the table, so the arm can reach what the camera sees.');
    else if (working.length) put('camera_mapped', 'todo', 'Teach the camera where the table is by clicking on its picture. Pick & place needs this.', fix('Map the camera', 'cameras'));
    else put('camera_mapped', 'todo', 'Needs a working camera first.', fix('Add a camera', 'cameras'));
  }

  // --- assembly ---
  if (assemblyTicked) put('assembly_done', 'ok', 'You marked the arm as built.');
  else if (follower && follower.online && IDS.every((i) => (follower.motor_ids || []).includes(i))) put('assembly_done', 'ok', 'All six motors answer, so the arm is built.');
  else put('assembly_done', 'todo', 'Build the arm with the assembly guide, then tick it off. Skip this if your arm is already built.', fix('Open the assembly guide', 'assemble'));

  const items = ORDER.map((i) => res[i]);
  const nxt = (items.find((it) => it.status !== 'ok' && it.status !== 'skip') || {}).id ?? null;
  return { items, summary: { ok: items.filter((it) => it.status === 'ok').length, total: items.filter((it) => it.status !== 'skip').length, next: nxt } };
}

export default buildChecklist;
