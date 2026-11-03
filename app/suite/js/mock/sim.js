// Simulated SO-101 hardware for the demo: two arms of six STS3215 motors (raw ticks 0-4095, mid 2047), a "hand" that moves
// limp arms, the calibration state machine, leader -> follower teleop, and the pick & place subset the UI reads.
// No DOM, no timers, no Math.random: everything advances in fixed ticks (one teleop iteration each) from the time the caller passes in.
// The state() shapes mirror Arm.state(), Teleop.state() and PickPlace.state() in app/server.py and app/pickplace.py.
import { mulberry32, project, unproject, TABLE_Z } from './scene.js';
import { DEFAULTS } from './defaults.js';

export const JOINTS = { 1: 'shoulder_pan', 2: 'shoulder_lift', 3: 'elbow_flex', 4: 'wrist_flex', 5: 'wrist_roll', 6: 'gripper' };
export const JOINT_IDS = Object.fromEntries(Object.entries(JOINTS).map(([i, n]) => [n, Number(i)]));
export const ARM = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll'];
export const MID = DEFAULTS.calibration.mid_ticks;            // 2047
export const MIN_SPAN = DEFAULTS.calibration.min_span_ticks;  // 150
export const TICKS = DEFAULTS.calibration.ticks_per_turn;     // 4095
export const DT = 1 / DEFAULTS.safety.teleop_hz;              // one tick = one teleop iteration
const FAULT_BITS = { 1: 'voltage', 2: 'sensor', 4: 'temperature', 8: 'current', 16: 'angle', 32: 'overload' };
export { FAULT_BITS };

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const round1 = (v) => Math.round(v * 10) / 10;

/* ------------------------------------------------------------------ kinematics (from the official URDF, metres/radians) */
const mul4 = (A, B) => {
  const C = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += A[r * 4 + k] * B[k * 4 + c]; C[r * 4 + c] = s; }
  return C;
};
function tfrom(xyz, rpy) {
  const [r, p, y] = rpy, cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  // R = Rz(y) Ry(p) Rx(r)
  return [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, xyz[0],
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, xyz[1],
    -sp, cp * sr, cp * cr, xyz[2],
    0, 0, 0, 1];
}
const rotz = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const CHAIN = [
  ['shoulder_pan', tfrom([0.0388353, -8.97657e-09, 0.0624], [Math.PI, 4.18253e-17, -Math.PI])],
  ['shoulder_lift', tfrom([-0.0303992, -0.0182778, -0.0542], [-1.5708, -1.5708, 0])],
  ['elbow_flex', tfrom([-0.11257, -0.028, 1.73763e-16], [-3.63608e-16, 8.74301e-16, 1.5708])],
  ['wrist_flex', tfrom([-0.1349, 0.0052, 3.62355e-17], [4.02456e-15, 8.67362e-16, -1.5708])],
  ['wrist_roll', tfrom([5.55112e-17, -0.0611, 0.0181], [1.5708, 0.0486795, 3.14159])],
  [null, tfrom([-0.0079, -0.000218121, -0.0981274], [0, 3.14159, 0])],   // gripper_frame_joint (fixed): the tip
];
const LIM_LO = [-1.91986, -1.74533, -1.69, -1.65806], LIM_HI = [1.91986, 1.74533, 1.69, 1.65806];

/** q: {joint: rad}. Returns {tip, appr (unit vector wrist -> tip), pts: 6 world points base..tip for drawing}. */
export function fk(q) {
  let T = tfrom([0, 0, 0], [0, 0, 0]); let rollO = null, rollA = null; const pts = [];
  for (const [n, o] of CHAIN) {
    T = mul4(T, o);
    pts.push([T[3], T[7], T[11]]);
    if (n === 'wrist_roll') { rollO = [T[3], T[7], T[11]]; rollA = [T[2], T[6], T[10]]; }
    if (n) T = mul4(T, rotz(q[n] || 0));
  }
  const tip = pts[pts.length - 1];
  const d = [tip[0] - rollO[0], tip[1] - rollO[1], tip[2] - rollO[2]];
  if (d[0] * rollA[0] + d[1] * rollA[1] + d[2] * rollA[2] < 0) rollA = rollA.map((v) => -v);
  const l = Math.hypot(...rollA);
  return { tip, appr: rollA.map((v) => v / l), pts };
}

function solve(A, b) {                                         // small dense solve (Gaussian elimination, partial pivoting)
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / (M[r][r] || 1e-12); }
  return x;
}

/** Inverse kinematics, tool pointing straight down (port of kin.py). Returns {joint: rad} or null when out of reach. */
export function ik(target, roll = 0, tilt = 0) {
  const pan0 = Math.atan2(target[1], target[0]);
  const az = Math.atan2(target[1], target[0] - 0.0388);
  const want = [Math.sin(tilt) * Math.cos(az), Math.sin(tilt) * Math.sin(az), -Math.cos(tilt)];
  const res = (v) => {
    const q = { shoulder_pan: v[0], shoulder_lift: v[1], elbow_flex: v[2], wrist_flex: v[3], wrist_roll: roll };
    const { tip, appr } = fk(q);
    return [tip[0] - target[0], tip[1] - target[1], tip[2] - target[2], 1 - (appr[0] * want[0] + appr[1] * want[1] + appr[2] * want[2])];
  };
  const cl = (v) => v.map((x, i) => clamp(x, LIM_LO[i], LIM_HI[i]));
  let best = [1e9, null];
  outer: for (const lift of [0.3, -0.4, 1.0]) for (const elbow of [0.6, 1.2, -0.3]) for (const wrist of [0.6, -0.6, 1.2]) {
    let v = cl([pan0, lift, elbow, wrist]);
    for (let it = 0; it < 60; it++) {
      const r = res(v);
      if (Math.hypot(...r) < 1e-5) break;
      const J = [0, 1, 2, 3].map((i) => { const w = v.slice(); w[i] += 1e-5; const r2 = res(w); return r2.map((x, k) => (x - r[k]) / 1e-5); });   // J[i][k] = d r_k / d v_i
      const A = [0, 1, 2, 3].map((a) => [0, 1, 2, 3].map((b) => J[a].reduce((s, x, k) => s + x * J[b][k], 0) + (a === b ? 1e-5 : 0)));
      const g = [0, 1, 2, 3].map((a) => J[a].reduce((s, x, k) => s + x * r[k], 0));
      const dv = solve(A, g);
      v = cl(v.map((x, i) => x - dv[i]));
    }
    const e = Math.hypot(...res(v));
    if (e < best[0]) best = [e, v.slice()];
    if (e < 1e-4) break outer;
  }
  if (!best[1]) return null;
  const r = res(best[1]);
  if (Math.hypot(r[0], r[1], r[2]) > 3e-3 || r[3] > 1.4e-3) return null;
  return { shoulder_pan: best[1][0], shoulder_lift: best[1][1], elbow_flex: best[1][2], wrist_flex: best[1][3], wrist_roll: roll };
}

/* ------------------------------------------------------------------ the simulated arm */
const SWEEP_AMP = { 1: 1000, 2: 1050, 3: 1050, 4: 1060, 5: 1700, 6: 650 };      // what the demo hand covers while you calibrate
const SWEEP_WINDOW = 4.0;                                                   // seconds per joint
export const DEFAULT_RANGE = [MID - 1250, MID + 1250];                      // uncalibrated arms: where the demo hand may go
const WIGGLE_AMP = { 1: 120, 2: 120, 3: 120, 4: 150, 5: 450, 6: 300 };
const CAL_ROOT = '~/.cache/huggingface/lerobot/calibration';

export class SimArm {
  constructor(sim, o) {
    this.sim = sim;
    this.path = o.path; this.role = o.role;
    this.ids = (o.ids || [1, 2, 3, 4, 5, 6]).slice();
    this.online = this.ids.length > 0;
    this.torque_on = !!o.torque;
    this.pos = {}; this.goal = {}; this.load = {}; this.temp = {}; this.tempF = {}; this.vel = {};
    this.volt = 12.0;
    this.fault = {};
    this.cal = o.cal ? clone(o.cal) : null;
    this.defaultCal = o.hasDefault && o.cal ? clone(o.cal) : null;
    this.calib = { step: 'idle' };
    this.notice = ['', 0];
    this.job = null;                       // wiggle / nudge
    this.holding = false;                  // gripper clamped on the keychain
    this.limits = {};
    this.mode = ''; this.modeT0 = 0; this.anchor = {};
    for (const i of Object.keys(JOINTS).map(Number)) {
      const start = o.pos && o.pos[i] != null ? o.pos[i] : MID + Math.round((sim.rng() - 0.5) * 500);
      this.pos[i] = start; this.goal[i] = start; this.vel[i] = 0;
      this.load[i] = 0; this.tempF[i] = 33 + sim.rng() * 3; this.temp[i] = Math.round(this.tempF[i]);
    }
    this.setLimitsFromCal();
  }

  get name() { return JOINTS; }
  setLimitsFromCal() {
    this.limits = {};
    for (const i of Object.keys(JOINTS).map(Number)) {
      const c = this.cal && this.cal[JOINTS[i]];
      this.limits[i] = c ? [c[0], c[1]] : [0, TICKS];
    }
  }
  range(i) { const c = this.cal && this.cal[JOINTS[i]]; return c ? c : DEFAULT_RANGE; }
  calId() { return this.role === 'leader' ? DEFAULTS.calibration.leader_id : DEFAULTS.calibration.follower_id; }
  calPath(suffix = '') {
    const home = this.sim.home;
    const sub = this.role === 'leader' ? 'teleoperators/so_leader' : 'robots/so_follower';
    const sep = home.includes('\\') ? '\\' : '/';
    const root = home.includes('\\') ? `${home}\\.cache\\huggingface\\lerobot\\calibration` : CAL_ROOT.replace('~', home);
    return [root, ...sub.split('/'), `${this.calId()}${suffix}.json`].join(sep);
  }
  say(text) { this.notice = [text, this.sim.t]; }

  /* ----- calibration state machine (Arm.calib_*) ----- */
  calibStart() {
    if (!this.online || this.job) return;
    this.torque_on = false;
    this.limits = Object.fromEntries(Object.keys(JOINTS).map((i) => [i, [0, TICKS]]));
    this.calib = { step: 'center', role: this.role, id: this.calId() };
  }
  calibCenter() {
    if (this.calib.step !== 'center') return;
    const ranges = {};
    for (const i of this.ids) { this.pos[i] = MID; this.goal[i] = MID; ranges[JOINTS[i]] = [MID, MID]; }
    this.calib = { ...this.calib, step: 'sweep', error: null, ranges };
    this.sweepT0 = this.sim.t;
  }
  calibFinish() {
    if (this.calib.step !== 'sweep') return;
    const ranges = clone(this.calib.ranges);
    ranges.wrist_roll = [0, TICKS];
    const stuck = Object.entries(ranges).filter(([, [lo, hi]]) => hi - lo < MIN_SPAN).map(([n]) => n);
    if (stuck.length) { this.calib.error = 'Move these joints through their full range: ' + stuck.join(', '); return; }
    this.cal = {};
    for (const i of this.ids) this.cal[JOINTS[i]] = ranges[JOINTS[i]].slice();
    this.setLimitsFromCal();
    if (!this.defaultCal) this.defaultCal = clone(this.cal);          // the first calibration becomes the restore point (ensure_default)
    this.calib = { ...this.calib, step: 'done', ranges, saved: this.calPath(), error: null };
  }
  calibCancel() { this.calib = { step: 'idle' }; }
  setDefault() {
    if (!this.cal) return this.say('No calibration to save as default yet');
    this.defaultCal = clone(this.cal); this.say('Current calibration saved as default');
  }
  restoreDefault() {
    if (!this.online || this.calib.step === 'center' || this.calib.step === 'sweep' || !this.defaultCal) return this.say(!this.defaultCal ? 'No default calibration saved yet' : 'Arm busy');
    this.cal = clone(this.defaultCal); this.setLimitsFromCal(); this.calib = { step: 'idle' };
    this.say('Default calibration restored to the motors');
  }

  /* ----- torque / goals ----- */
  armMotion(on) {
    this.torque_on = on;
    if (on) for (const i of this.ids) this.goal[i] = this.pos[i];
  }
  holdHere() { for (const i of this.ids) this.goal[i] = this.pos[i]; }
  goto(goals) { for (const [i, t] of Object.entries(goals)) this.goal[i] = clamp(Math.round(t), 0, TICKS); }
  nudge(name) {
    const i = JOINT_IDS[name];
    if (!this.ids.includes(i) || this.job || !this.online || this.calib.step === 'center' || this.calib.step === 'sweep') return;
    const cur = this.pos[i], [lo, hi] = this.limits[i];
    this.job = { type: 'nudge', t0: this.sim.t, i, cur, lo, hi, phases: [130, -130, 0], dur: 1.1 };
    this.goal[i] = cur;
  }
  wiggle() {
    if (this.job || !this.online || this.calib.step === 'center' || this.calib.step === 'sweep') return;
    const start = {}; for (const i of this.ids) start[i] = this.pos[i];
    this.job = { type: 'wiggle', t0: this.sim.t, start, phases: [1, -1, 0, 1, -1, 0, 1, -1, 0], dur: 0.9 };
  }
  get wiggling() { return !!this.job; }

  /* ----- what the arm reports (Arm.state) ----- */
  state() {
    const cal = this.cal;
    return {
      port: this.path, role: this.role, online: this.online,
      calibrated: cal !== null, has_default: this.defaultCal !== null,
      cal: cal ? Object.fromEntries(Object.entries(cal).map(([n, r]) => [n, [r[0], r[1]]])) : null,
      notice: this.sim.t - this.notice[1] < 6 ? this.notice[0] : '', volt: this.volt, wiggling: this.wiggling,
      calib: clone(this.calib),
      faults: Object.fromEntries(Object.entries(this.fault).filter(([, f]) => f).map(([i, f]) => [JOINTS[i], Object.entries(FAULT_BITS).filter(([k]) => f & Number(k)).map(([, v]) => v)])),
      joints: this.ids.map((i) => ({ id: i, name: JOINTS[i], pos: Math.round(this.pos[i]), load: Math.round(this.load[i]), temp: this.temp[i] })),
    };
  }
}

/* ------------------------------------------------------------------ helpers shared by the sim and the pick & place subset */
/** joint angles (rad) for raw ticks, zero = the middle of the calibrated range (pickplace.q_of). */
export function qOf(arm, raw, viz = {}) {
  const q = {}; const flip = viz.flip || {}, off = viz.offset || {};
  for (const n of ARM) {
    const i = JOINT_IDS[n], r = arm.cal && arm.cal[n];
    const mid = r ? (r[0] + r[1]) / 2 : MID + 0.5;
    const d = ((raw[i] ?? mid) - mid) * 360 / TICKS;
    q[n] = rad((flip[n] ? -d : d) + (off[n] || 0));
  }
  return q;
}
/** raw ticks for joint angles (pickplace.ticks) */
export function ticksOf(arm, q, viz = {}) {
  const out = {}; const flip = viz.flip || {}, off = viz.offset || {};
  for (const n of ARM) {
    const i = JOINT_IDS[n], r = arm.cal && arm.cal[n] ? arm.cal[n] : DEFAULT_RANGE;
    let d = deg(q[n]) - (off[n] || 0); if (flip[n]) d = -d;
    out[i] = Math.round(clamp((r[0] + r[1]) / 2 + (d * TICKS) / 360, r[0] + 3, r[1] - 3));
  }
  return out;
}
export const gripTick = (arm, pct) => { const [lo, hi] = arm.range(6); return Math.round(lo + (pct / 100) * (hi - lo)); };

/* ------------------------------------------------------------------ the table: where things are (metres, robot frame) */
const KC_Z0 = TABLE_Z + 0.004;
export const LAYOUT = {
  spots: [[0.19, -0.07], [0.25, -0.03], [0.14, -0.08], [0.20, 0.03], [0.26, -0.10]],   // where the demo hand touches the table
  keychain: [0.20, -0.07],
  tray: { x: 0.20, y: -0.165, hx: 0.05, hy: 0.035 },
  bowl: { x: 0.15, y: 0.12, r: 0.06, h: 0.06 },
  hoverZ: 0.045, touchZ: TABLE_Z, tableZ: TABLE_Z,
};
const READY_CAL = {
  follower: { shoulder_pan: [1012, 3082], shoulder_lift: [995, 3101], elbow_flex: [1003, 3095], wrist_flex: [985, 3112], wrist_roll: [0, 4095], gripper: [1893, 3290] },
  leader: { shoulder_pan: [1024, 3070], shoulder_lift: [1010, 3084], elbow_flex: [1018, 3077], wrist_flex: [1001, 3093], wrist_roll: [0, 4095], gripper: [1790, 3180] },
};

/* ------------------------------------------------------------------ pick & place (the part of PickPlace the UI reads) */
const ORDER = ['tray', 'bowl'];
const KC_Z = TABLE_Z + 0.004;                     // the keychain's top surface
const KC_HALF = [0.026, 0.014];                       // the keychain: 5.2 x 2.8 cm
const ERR = (m) => { throw new Error(m); };

class PP {
  constructor(sim) {
    this.sim = sim; this.ncam = 0; this.models = [];
    this.cfg = {
      points: [], zones: { tray: { p: null, drop: 0.07, r: 60.0 }, bowl: { p: null, drop: 0.11, r: 110.0 } },
      roll_offset: 0.0, grasp_dz: 0.004, travel: 0.06, off_x: 0.0, off_y: 0.0, auto_bowl: true, bowl_h: 0.076, bowl_clear: 0.005,
      cam_mode: 'auto', pitch_trim_deg: 0.0,
    };
    this.A = null; this.err_mm = null; this.z_table = null; this.zt_cfg = null;
    this.history = []; this._status = 'idle'; this.running = false; this.mode = null; this.cycles = 0; this.abort = false; this.job = null;
    this.auto = { on: false, msg: '', holding: 0.0, kc: 'none' };
    this.alignSpots = []; this.alignBackup = null; this.fusion = null;
    this.kcHist = []; this.tipHist = []; this.refArea = 0; this.kcMem = null; this.stillSince = null; this.lastPlaced = -1;
    this.jit = [[0, 0], [0, 0]];
  }
  get status() { return this._status; }
  set status(v) {
    this._status = v;
    if (!this.history.length || this.history[this.history.length - 1][1] !== v) {
      this.history.push([this.sim.t, v]); if (this.history.length > 80) this.history.shift();
      this.sim.ev(String(v).startsWith('error') ? 'error' : 'info', 'pickplace', v);
    }
  }
  setNcam(n) {
    this.ncam = n;
    while (this.models.length < n) this.models.push(null);
    this.models.length = n;
  }
  arm() { return this.sim.follower(); }
  armChecked() { const a = this.arm(); if (!a || !a.online || a.cal === null) ERR('follower arm not online/calibrated'); return a; }
  q(a, raw = a.pos) { return qOf(a, raw, this.sim.viz); }
  tipNow(a) { return fk(this.q(a)).tip; }
  busy() {
    if (this.running) return true;
    if (this.sim.tele.on) { this.status = 'the leader arm is driving the follower: press Stop leader → follower first'; return true; }
    return false;
  }

  /* ----- table mapping: taught points -> an affine fit pixel -> table (the overhead camera is nearly a similarity) ----- */
  fit() {
    const P = this.cfg.points;
    if (P.length < 3) { this.A = null; this.err_mm = null; this.z_table = this.zt_cfg; return; }
    const rows = P.map((p) => [p.u, p.v, 1]);
    const ata = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
    const solveCol = (k) => solve(ata.map((r) => r.slice()), [0, 1, 2].map((i) => rows.reduce((s, r, n) => s + r[i] * (k ? P[n].y : P[n].x), 0)));
    const ax = solveCol(0), ay = solveCol(1);
    this.A = { ax, ay };
    const err = P.map((p) => Math.hypot(ax[0] * p.u + ax[1] * p.v + ax[2] - p.x, ay[0] * p.u + ay[1] * p.v + ay[2] - p.y));
    this.err_mm = Math.round((err.reduce((a, b) => a + b, 0) / err.length) * 1e6) / 1e3;
    this.z_table = this.zt_cfg ?? P.reduce((s, p) => s + p.z, 0) / P.length;
  }
  px2xy(u, v, cid = 0, h = 0.0) {
    const m = this.models[cid];
    if (m) { const p = unproject(cid, u, v, (this.z_table ?? TABLE_Z) + h); return [p[0], p[1]]; }
    if (cid === 0 && this.A) return [this.A.ax[0] * u + this.A.ax[1] * v + this.A.ax[2], this.A.ay[0] * u + this.A.ay[1] * v + this.A.ay[2]];
    return ERR(`camera ${cid + 1} is not calibrated`);
  }
  mmPerPx(cid, u, v, h) { const a = this.px2xy(u, v, cid, h), b = this.px2xy(u + 10, v, cid, h); return Math.hypot(a[0] - b[0], a[1] - b[1]) / 10; }
  calibrated(i) { return !!(this.models[i] || (i === 0 && this.A)); }
  usable() {
    const mode = String(this.cfg.cam_mode); const ids = mode === 'auto' ? [...Array(this.ncam).keys()] : [Number(mode)];
    return ids.filter((i) => i < this.ncam && this.calibrated(i));
  }

  /* ----- what the cameras see ----- */
  kcVisible() {
    const k = this.sim.world.keychain;
    if (k.state === 'bowl') return false;
    const a = this.arm();
    if (a && a.online && k.state !== 'held') {                      // the gripper hides what is right under it
      const tip = this.tipNow(a);
      if (Math.hypot(tip[0] - k.x, tip[1] - k.y) < 0.022 && tip[2] < 0.03) return false;
    }
    return true;
  }
  foundFor(cid) {
    if (cid >= this.ncam || !this.kcVisible()) return [];
    const k = this.sim.world.keychain, z = k.z ?? KC_Z, c = Math.cos(k.ang), s = Math.sin(k.ang);
    const P = (dx, dy) => { const q = project(cid, [k.x + dx * c - dy * s, k.y + dx * s + dy * c, z]); return [q.u, q.v]; };
    const ctr = P(0, 0), ex = P(KC_HALF[0], 0), ey = P(0, KC_HALF[1]);
    const w = 2 * Math.hypot(ex[0] - ctr[0], ex[1] - ctr[1]), h = 2 * Math.hypot(ey[0] - ctr[0], ey[1] - ctr[1]);
    let ang = deg(Math.atan2(ex[1] - ctr[1], ex[0] - ctr[0])); ang = ((ang % 180) + 180) % 180;
    const j = this.jit[cid] || [0, 0];
    return [{ u: ctr[0] + j[0], v: ctr[1] + j[1], angle: ang, w: Math.max(w, h), h: Math.min(w, h), area: w * h * 0.96, score: 0.94, partial: 0 }];
  }
  locate() {
    if (this.z_table === null) return null;
    const ests = [];
    for (const cid of this.usable()) {
      const f = this.foundFor(cid)[0]; if (!f) continue;
      try { const [x, y] = this.px2xy(f.u, f.v, cid, KC_Z - TABLE_Z); ests.push({ cid, x, y, f }); } catch { /* skip */ }
    }
    if (!ests.length) return null;
    const x = ests.reduce((s, e) => s + e.x, 0) / ests.length, y = ests.reduce((s, e) => s + e.y, 0) / ests.length;
    let spread = 0; for (const p of ests) for (const q of ests) spread = Math.max(spread, Math.hypot(p.x - q.x, p.y - q.y));
    const tri = ests.filter((e) => this.models[e.cid]);
    const k = this.sim.world.keychain;
    return { x, y, spread, cams: ests.map((e) => e.cid), z: tri.length >= 2 ? (k.z ?? KC_Z) - (this.z_table ?? TABLE_Z) : null, gap: tri.length >= 2 ? 0.002 : null, f: ests[0].f };
  }
  zoneCenter(name) {                                              // [x, y, radius] in metres, or null
    const w = this.sim.world;
    if (name === 'bowl' && this.cfg.auto_bowl) {
      if (this.z_table === null || !this.usable().length) return null;
      const cid = this.usable()[0], b = project(cid, [w.bowl.x, w.bowl.y, TABLE_Z + 0.045]);
      try { const [x, y] = this.px2xy(b.u, b.v, cid, 0.045); return [x, y, Math.max(w.bowl.r * 0.9, 0.07)]; } catch { return null; }
    }
    const z = this.cfg.zones[name];
    if (!z || !z.p || this.z_table === null || !(this.models[0] || this.A)) return null;
    const h = name === 'bowl' ? 0.045 : 0.03;
    try { const [x, y] = this.px2xy(z.p[0], z.p[1], 0, h); return [x, y, z.r * this.mmPerPx(0, z.p[0], z.p[1], h)]; } catch { return null; }
  }
  zoneOfWorld(x, y) { for (const n of Object.keys(this.cfg.zones)) { const c = this.zoneCenter(n); if (c && Math.hypot(x - c[0], y - c[1]) < c[2]) return n; } return null; }
  ready(mode) {
    if (!this.models.some(Boolean) && !this.A) return 'Calibrate the camera first: press “Tune…” then “Auto-calibrate” (or press “Re-map the table”)';
    if (this.z_table === null) return 'Find the table height first: press “Tune…” then “Find by touching”';
    for (const n of (mode === 'bowl' ? ['bowl'] : ORDER)) {
      if (this.zoneCenter(n) === null) return n === 'bowl' ? "I can't see the pink bowl: put it where a camera can see it" : `Set the ${n} position first (Set ${n}, then click it in the camera picture)`;
    }
    try { this.armChecked(); } catch (e) { return e.message; }
    return null;
  }

  /* ----- teaching (hand-held, one click per spot) ----- */
  teach(u, v) {
    const a = this.armChecked(), tip = this.tipNow(a);
    if (a.torque_on) ERR("the arm is not limp: press 'Make arm limp' first, then move it by hand");
    for (const p of this.cfg.points) if (Math.hypot(p.x - tip[0], p.y - tip[1], p.z - tip[2]) < 0.015) ERR("the gripper tip hasn't moved since the last point: move it to a NEW spot on the table first");
    this.cfg.points.push({ u: Number(u), v: Number(v), x: tip[0], y: tip[1], z: tip[2] });
    this.fit();
    this.status = `taught point ${this.cfg.points.length}` + (this.err_mm !== null ? ` · fit error ${this.err_mm.toFixed(1)} mm` : ' (need 3+)');
  }
  clearPoints() { this.cfg.points = []; this.fit(); }
  undoPoint() { if (this.cfg.points.length) { this.cfg.points.pop(); this.fit(); } }
  setPoint(name, u, v) {
    const z = this.cfg.zones[name]; if (!z) return;
    z.p = [Number(u), Number(v)]; if (name === 'bowl') this.cfg.auto_bowl = false;
  }
  setParam(k, v) {
    const c = this.cfg;
    if (k === 'cam_mode') c.cam_mode = String(v);
    else if (k === 'auto_bowl') c.auto_bowl = !!Number(v);
    else if (k === 'pitch_trim_deg') { c[k] = clamp(Number(v), -25, 25); this.status = `gripper trim set to ${c[k] >= 0 ? '+' : ''}${c[k].toFixed(1)}° (the model's lean when the finger tips are truly flat)`; }
    else if (['roll_offset', 'grasp_dz', 'travel', 'off_x', 'off_y', 'bowl_h', 'bowl_clear'].includes(k)) c[k] = k === 'bowl_clear' ? Math.max(0, Number(v)) : Number(v);
    else { const [z, f] = String(k).split('.'); if (c.zones[z] && f in c.zones[z]) c.zones[z][f] = Number(v); }
  }

  /* ----- automatic mapping: records (keychain pixel, tip position) while the arm is held still on the keychain ----- */
  autoStart() {
    if (this.auto.on) return;
    this.auto = { on: true, msg: 'Put the keychain flat on the table, then touch the gripper tip to its middle and hold still.', holding: 0.0, kc: 'none' };
    this.stillSince = null; this.kcHist = []; this.tipHist = []; this.kcMem = null; this.refArea = 0; this.lastPlaced = -1;
  }
  autoStop() { this.auto.on = false; this.stillSince = null; }
  autoTick() {                                                    // every 0.1 s, a port of PickPlace._auto_loop
    const A = this.auto; if (!A.on) return;
    const now = this.sim.t;
    try {
      const a = this.armChecked();
      if (a.torque_on) { Object.assign(A, { why: 'limp', holding: 0.0 }); return; }
      const fkr = fk(this.q(a)), tip = fkr.tip;
      this.tipHist.push([now, tip]); if (this.tipHist.length > 60) this.tipHist.shift();
      const tilt = deg(Math.acos(clamp(-fkr.appr[2], -1, 1))); A.tilt = Math.round(tilt);
      const f = this.foundFor(0)[0];
      if (f) {
        this.kcHist.push([now, f.u, f.v, f.area, !!f.partial]); if (this.kcHist.length > 12) this.kcHist.shift();
        if (!f.partial) this.refArea = Math.max(this.refArea * 0.998, f.area);
        const pts = this.kcHist.filter((q) => now - q[0] < 0.8);
        if (pts.length >= 5 && Math.max(...pts.map((q) => Math.hypot(q[1] - f.u, q[2] - f.v))) < 4) {
          const full = !f.partial && f.area >= 0.8 * this.refArea;
          if (full || this.kcMem === null || Math.hypot(f.u - this.kcMem[0], f.v - this.kcMem[1]) > 30) this.kcMem = [f.u, f.v, now];
        }
      }
      A.kc = f && !f.partial ? 'seen' : this.kcMem !== null && now - this.kcMem[2] < 90 ? 'hidden' : 'none';
      const recent = this.tipHist.filter(([tt]) => now - tt < 1.2).map(([, t]) => t);
      const still = recent.length >= 8 && Math.max(...recent.map((r) => Math.hypot(r[0] - tip[0], r[1] - tip[1], r[2] - tip[2]))) < 0.005;
      const P = this.cfg.points;
      if (tilt > 50) { this.stillSince = null; Object.assign(A, { why: 'tilt', holding: 0.0 }); return; }
      if (!still) { this.stillSince = null; Object.assign(A, { why: 'move', holding: 0.0 }); return; }
      if (this.kcMem === null || now - this.kcMem[2] > 90) { Object.assign(A, { why: 'kc', holding: 0.0 }); return; }
      if (P.length) {
        const zs = P.map((q) => q.z).sort((x, y) => x - y), med = zs.length % 2 ? zs[(zs.length - 1) / 2] : (zs[zs.length / 2 - 1] + zs[zs.length / 2]) / 2;
        const dz = (tip[2] - med) * 1000; A.dz = Math.round(dz);
        if (Math.abs(dz) > 25) { Object.assign(A, { why: 'height', holding: 0.0 }); return; }
      }
      if (P.some((q) => Math.hypot(q.x - tip[0], q.y - tip[1]) < 0.04 || Math.hypot(q.u - this.kcMem[0], q.v - this.kcMem[1]) < 25)) { Object.assign(A, { why: 'dup', holding: 0.0 }); return; }
      if (this.stillSince === null) this.stillSince = now;
      Object.assign(A, { why: 'hold', holding: Math.min(1.0, (now - this.stillSince) / 1.4) });
      if (A.holding < 1.0) return;
      P.push({ u: this.kcMem[0], v: this.kcMem[1], x: tip[0], y: tip[1], z: tip[2] });
      this.fit(); this.stillSince = null;
      Object.assign(A, { why: 'saved', holding: 0.0, saved_at: now, n: P.length });
      this.status = `mapped spot ${P.length}` + (this.err_mm !== null ? ` · fit error ${this.err_mm.toFixed(1)} mm` : '');
    } catch (e) { Object.assign(A, { why: 'error', err: e.message, holding: 0.0 }); }
  }

  /* ----- jobs: a list of timed steps; the follower is driven through joint-space goals like the real arm ----- */
  fail(e) { this.status = `error: ${e.message}` + (this.mode === 'rest' ? ' (the arm is still STIFF: it was not released)' : ''); this.endJob(); const a = this.arm(); if (a) a.holdHere(); }
  endJob() {
    this.running = false; this.job = null;
    const k = this.sim.world.keychain; if (k.state === 'held') { k.state = 'table'; k.z = KC_Z0; }
    const a = this.arm(); if (a) a.holding = false;
  }
  startJob(mode, steps, onDone) {
    this.abort = false; this.running = true; this.mode = mode; this.cycles = 0;
    this.job = { steps, i: -1, onDone, attempts: 0, fails: 0 };
    const a = this.arm(); if (a) a.armMotion(true);
  }
  move(status, dur, to, o = {}) { return { status, dur, to, ...o }; }
  reach(a, x, y, zList, roll) {                                   // first height in the list the arm can reach with the tool pointing down
    for (const z of zList) { const q = ik([x + this.cfg.off_x, y + this.cfg.off_y, z], roll, rad(this.cfg.pitch_trim_deg)); if (q) return q; }
    return ERR("that spot is out of the arm's reach");
  }
  enterStep(s) {
    const a = this.armChecked(); s.t0 = this.sim.t; s.from = { ...a.goal };
    if (s.status) this.status = s.status;
    if (s.to) {
      const roll = this.q(a).wrist_roll + rad(this.cfg.roll_offset);
      const [x, y, z] = typeof s.to === 'function' ? s.to() : s.to;
      s.goalTo = ticksOf(a, this.reach(a, x, y, Array.isArray(z) ? z : [z], roll), this.sim.viz);
    }
    if (s.grip !== undefined) { const [lo, hi] = a.range(6); s.gripTo = s.grip === 'clamp' ? lo + 480 : gripTick(a, s.grip); }
    if (s.enter) s.enter(a);
  }
  jobTick() {
    const job = this.job; if (!job) return;
    if (this.abort) { this.status = this.mode === 'rest' ? 'stopped (the arm is still stiff and holding position)' : 'stopped (arm holding position)'; const a = this.arm(); if (a) a.holdHere(); return this.endJob(); }
    const a = this.arm(); if (!a || !a.online) { this.status = 'error: follower arm not online/calibrated'; return this.endJob(); }
    try {
      for (let guard = 0; guard < 8; guard++) {
        if (job.i >= 0) {
          const s = job.steps[job.i], f = (this.sim.t - s.t0) / s.dur;
          if (s.goalTo) for (const i of [1, 2, 3, 4, 5]) a.goal[i] = s.from[i] + (s.goalTo[i] - s.from[i]) * ease(f);
          if (s.gripTo !== undefined) a.goal[6] = s.from[6] + (s.gripTo - s.from[6]) * ease(f);
          if (f < 1) return;
          if (s.exit) { const r = s.exit(a); if (this.job !== job) return; if (r) this.jobFail(r); }
        }
        job.i++;
        if (job.i >= job.steps.length) { const done = job.onDone; this.endJob(); if (done) done(); return; }
        this.enterStep(job.steps[job.i]);
      }
    } catch (e) { this.fail(e); }
  }
  jobFail(msg) {                                                  // a missed grasp: open, go straight up, try again (at most 4 attempts)
    const job = this.job; job.fails++; job.problem = msg;
    this.status = `✗ ${msg}: going back up and trying again`;
    const k = this.sim.world.keychain; if (k.state === 'held') { k.state = 'table'; k.z = KC_Z0; }
    const a = this.arm(); a.holding = false;
    const tip = this.tipNow(a);
    job.steps.splice(job.i + 1, job.steps.length, this.move(null, 0.8, null, { grip: 100 }), this.move(null, 1.4, [tip[0], tip[1], [this.z_table + 0.05, this.z_table + 0.03]]), ...this.attemptSteps(job.mode));
  }

  /* picking and placing: aim where the CAMERAS believe the keychain is */
  attemptSteps(mode) {
    return [{ dur: 0.01, status: null, exit: () => this.attemptStart(mode) }];
  }
  attemptStart(mode) {
    const job = this.job, a = this.arm();
    job.attempts++;
    if (job.attempts > (mode === 'loop' ? 1e6 : 4)) { this.status = `gave up after 4 tries (${job.fails} failed grasps). Last problem: ${job.problem}`; this.endJob(); return null; }
    const kc = this.locate();
    if (!kc) {
      this.status = job.placed ? '✔ released over the bowl and the keychain is no longer visible: it is probably inside the bowl (the cameras cannot see into it): please look'
        : 'no red keychain visible to a calibrated camera: stopping';
      this.endJob(); return null;
    }
    const here = this.zoneOfWorld(kc.x, kc.y); this.fusion = { cams: kc.cams.map((c) => c + 1), spread_mm: Math.round(kc.spread * 1000) };
    let dest;
    if (mode === 'bowl') { if (here === 'bowl') { this.status = '✅ done: the keychain is in the bowl'; this.endJob(); return null; } dest = 'bowl'; }
    else dest = here && ORDER.includes(here) ? ORDER[(ORDER.indexOf(here) + 1) % ORDER.length] : ORDER[0];
    const zt = this.z_table, c = this.cfg, w = this.sim.world, tz = [zt + c.travel, zt + 0.045, zt + 0.03];
    const zc = this.zoneCenter(dest), drop = c.zones[dest].drop, kcPos = [kc.x, kc.y];
    const steps = [
      this.move('moving above the keychain', 2.6, [kcPos[0], kcPos[1], tz], { grip: 100 }),
      this.move('lowering', 1.5, [kcPos[0], kcPos[1], zt + c.grasp_dz]),
      this.move('gripping', 0.9, null, { grip: 'clamp', exit: (arm) => {
        const k = this.sim.world.keychain, tip = this.tipNow(arm);
        if (Math.hypot(tip[0] - k.x, tip[1] - k.y) > 0.014) return 'the keychain is not between the fingers';
        k.state = 'held'; arm.holding = true; return null;
      } }),
      this.move('lifting', 1.3, [kcPos[0], kcPos[1], tz]),
      this.move(`carrying it to the ${dest}`, 2.8, [zc[0], zc[1], tz]),
      this.move('lowering', 1.3, [zc[0], zc[1], [zt + drop, zt + 0.07, zt + 0.05, zt + 0.03]]),
      this.move('releasing', 0.9, null, { grip: 100, exit: (arm) => {
        const k = this.sim.world.keychain; arm.holding = false;
        k.state = dest; k.x = zc[0] + (dest === 'bowl' ? 0 : 0.0); k.y = zc[1]; k.z = dest === 'bowl' ? TABLE_Z + 0.01 : KC_Z0;
        if (dest === 'tray') { k.x = w.tray.x; k.y = w.tray.y; }
        if (dest === 'bowl') { k.x = w.bowl.x; k.y = w.bowl.y; }
        job.placed = true; return null;
      } }),
      this.move('retreating up', 1.3, [zc[0], zc[1], tz]),
      { dur: 0.01, status: null, exit: () => {
        const k = this.locate(), ok = !!k && this.zoneOfWorld(k.x, k.y) === dest;
        this.status = `keychain ${ok ? 'is in' : 'NOT confirmed in'} the ${dest}` + (ok || !k ? '' : ` (seen at ${Math.round(k.x * 1000)}, ${Math.round(k.y * 1000)} mm)`);
        if (ok) { this.cycles++; job.attempts = 0; job.fails = 0; job.placed = false; }
        if (mode === 'bowl' && dest === 'bowl') { this.status = '✔ released over the bowl and the keychain is no longer visible: it is probably inside the bowl (the cameras cannot see into it): please look'; this.endJob(); return null; }
        if (mode === 'loop' && this.cycles >= (job.cycles || 1e9)) { this.endJob(); return null; }
        job.steps.push(...this.attemptSteps(mode));
        return null;
      } },
    ];
    job.steps.splice(job.i + 1, 0, ...steps);
    return null;
  }
  run(mode, cycles) {
    if (this.busy()) return;
    const err = this.ready(mode); if (err) { this.status = err; return; }
    const a = this.arm(), zt = this.z_table;
    const liftClear = this.move('lifting the gripper clear so the cameras can see the table', 1.2, () => { const t = this.tipNow(a); return [t[0], t[1], [zt + this.cfg.travel, zt + 0.045, zt + 0.03]]; });
    if (mode === 'hover') {
      const kc = this.locate(); if (!kc) { this.status = 'no red keychain visible to a calibrated camera: stopping'; return; }
      this.fusion = { cams: kc.cams.map((c) => c + 1), spread_mm: Math.round(kc.spread * 1000) };
      this.startJob(mode, [liftClear, this.move('moving above the keychain', 2.8, [kc.x, kc.y, [zt + this.cfg.travel, zt + 0.045]], { grip: 0 }), this.move('hovering', 1.2, null)], () => {
        this.status = `hover test done: keychain located by camera ${kc.cams.map((c) => c + 1).join(' + ')}, cameras agree within ${(kc.spread * 1000).toFixed(0)} mm`;
      });
    } else {
      this.status = 'checking the gripper: closing it on nothing';
      this.startJob(mode, [liftClear, this.move('checking the gripper: closing it on nothing', 1.6, null, { grip: 0 }), this.move(null, 0.7, null, { grip: 100 }), ...this.attemptSteps(mode)]);
      this.job.cycles = Number(cycles) || 0;
    }
    void a;
  }
  gotoRobot(x, y, zrel) {
    if (this.busy()) return;
    this.startJob('goto', [this.move(`moving to (${Math.round(x * 1000)}, ${Math.round(y * 1000)}) mm`, 2.4, [x, y, [(this.z_table ?? LAYOUT.tableZ) + zrel, (this.z_table ?? LAYOUT.tableZ) + 0.04]])],
      () => { this.status = `at (${Math.round(x * 1000)}, ${Math.round(y * 1000)}), ${Math.round(zrel * 1000)} mm above table`; });
  }
  probeTable(x, y) {
    if (this.busy()) return;
    const zt = this.z_table ?? LAYOUT.tableZ;
    this.startJob('probe', [this.move('probe: moving above the table', 2.2, [x, y, [zt + 0.05, zt + 0.04]]), this.move('probe: lowering until the motors push back', 2.4, [x, y, LAYOUT.touchZ])], () => {
      const hit = this.tipNow(this.arm())[2]; this.cfg.z_table = hit; this.zt_cfg = hit; this.z_table = hit;
      this.status = `✓ table touched: height ${Math.round(hit * 1000)} mm`;
    });
  }
  autoCalibrate() {
    if (this.busy()) return;
    const a = this.armChecked(), zt = this.z_table ?? LAYOUT.tableZ;
    const poses = []; for (const h of [0.11, 0.07, 0.04]) for (const [x, y] of [[150, -60], [150, -120], [200, -60], [200, -120], [200, -170], [250, -60], [250, -120]]) poses.push([x / 1000, y / 1000, h]);
    const k = this.sim.world.keychain, home = [...LAYOUT.keychain];
    const steps = [this.move('auto-calibrating: lifting the arm straight up first (clear of the bowl)', 1.6, () => { const t = this.tipNow(a); return [t[0], t[1], [zt + 0.07, zt + 0.045]]; }, { exit: () => { k.state = 'held'; return null; } })];
    poses.forEach(([x, y, h], n) => steps.push(this.move(`auto-calibrating: pose ${n + 1}/${poses.length} (seen so far: ` + [...Array(this.ncam).keys()].map((i) => `camera ${i + 1}: ${n + 1}`).join(', ') + ')', 0.7, [x, y, [zt + h, zt + 0.07, zt + 0.045, zt + 0.03]])));
    this.startJob('calib', steps, () => {
      const notes = [];
      for (let i = 0; i < this.ncam; i++) { const rms = Math.round((1.4 + 0.7 * i + this.sim.rng() * 0.6) * 10) / 10; this.models[i] = { rms, n: poses.length }; notes.push(`camera ${i + 1}: ${rms.toFixed(1)} px from ${poses.length} poses`); }
      k.state = 'table'; k.x = home[0]; k.y = home[1]; k.z = KC_Z0;
      this.status = '✓ calibrated: ' + notes.join('; ');
    });
  }
  setGrip(pct) {
    try { const a = this.armChecked(); a.armMotion(true); a.goto({ 6: gripTick(a, pct) }); this.status = `gripper set to ${Math.round(pct)}%`; }
    catch (e) { this.status = `error: ${e.message}`; }
  }
  stop() { this.abort = true; const a = this.arm(); if (a) a.holdHere(); if (!this.job) this.running = false; }
  reset() {
    this.abort = true; const a = this.arm(); if (a) { a.holdHere(); a.fault = {}; }
    this.job = null; this.running = false; this.abort = false; this.alignSpots = [];
    const k = this.sim.world.keychain; if (k.state !== 'table') { k.state = 'table'; k.x = LAYOUT.keychain[0]; k.y = LAYOUT.keychain[1]; k.z = KC_Z0; if (a) a.holding = false; }
    this.status = 'reset: nothing is running, the arm holds where it is. Start again when ready';
  }
  /** Bare release: the torque goes off AT ONCE (exactly like PickPlace.release). On a raised arm that is a DROP: never use it to prepare a person's step, use rest(). */
  release() { this.abort = true; const a = this.arm(); if (a) a.armMotion(false); this.job = null; this.running = false; this.status = 'released (torque off)'; }
  /** POST /api/pp/rest, like PickPlace.rest(): lower the follower onto a clear spot at the table (about 2 s), THEN let it go limp, so a person never holds a stiff arm
   *  and nothing drops. Refused (and the arm stays STIFF) when the follower is not online and calibrated; the sentence goes in pp.status, the HTTP answer is always {}. */
  rest() {
    if (this.busy()) return;
    let a;
    try { a = this.armChecked(); } catch (e) { this.status = `error: ${e.message} (the arm is still STIFF: it was not released)`; return; }
    const limpNow = () => { a.armMotion(false); this.status = '✓ the arm is limp, resting on the table (it was lowered first). Nothing is holding it now'; };
    if (!a.torque_on) { this.abort = false; a.armMotion(false); this.status = '✓ the arm is limp (it already was). Nothing is holding it now'; return; }
    const zt = this.z_table ?? LAYOUT.tableZ;
    this.status = 'lowering the arm onto the table before letting it go limp';
    this.startJob('rest', [this.move('lowering the arm onto the table before letting it go limp', 1.4, [0.18, 0.0, [zt + 0.05, zt + 0.04, zt + 0.06]]), this.move(null, 0.6, null)], limpNow);
  }

  /* ----- alignment (record spots at known radii, fit, apply, undo): the bookkeeping only ----- */
  align(b) {
    const d = b.do;
    if (d === 'record') {
      this.armChecked(); const r = Number(b.r ?? 22) / 100;
      if (this.alignSpots.some((s) => Math.abs(s.r - r) < 0.004)) { this.status = `alignment spot at ${Math.round(r * 100)} cm is already recorded`; return; }
      this.alignSpots.push({ r }); this.status = `recorded alignment spot ${this.alignSpots.length} at ${Math.round(r * 100)} cm`;
    } else if (d === 'fit' || d === 'apply') {
      if (d === 'fit' && this.alignSpots.length < 3) { this.status = 'error: record at least 3 alignment spots first (12, 17 and 22 cm)'; return; }
      this.alignBackup = { offsets: { ...this.sim.viz.offset }, trim: this.cfg.pitch_trim_deg, z: this.z_table };
      this.alignSpots = []; this.status = d === 'fit' ? '✓ alignment fitted and applied: joint zeros, camera models and table height updated' : `alignment applied: ${b.why || 'by hand'}`;
    } else if (d === 'clear') { this.alignSpots = []; this.status = 'alignment spots cleared'; }
    else if (d === 'undo') {
      if (!this.alignBackup) ERR('nothing to undo');
      this.sim.viz.offset = { ...this.alignBackup.offsets }; this.cfg.pitch_trim_deg = this.alignBackup.trim; this.alignBackup = null;
      this.status = 'alignment undone: the previous joint zeros, cameras and table height are back';
    }
  }
  vertical(set) {
    if (set) { const a = this.armChecked(); const [, lat] = this.tiltDeg(a); this.cfg.pitch_trim_deg = clamp(this.tiltDeg(a)[0] + this.cfg.pitch_trim_deg, -25, 25); void lat; this.status = `vertical set: the gripper lean is now ${this.cfg.pitch_trim_deg.toFixed(1)}° from the model's straight down`; }
    else { this.cfg.pitch_trim_deg = 0.0; this.status = "vertical reset to the model's own straight down"; }
  }
  tiltDeg(a) {
    const { tip, appr } = fk(this.q(a)), az = Math.atan2(tip[1], tip[0] - 0.0388);
    const along = appr[0] * Math.cos(az) + appr[1] * Math.sin(az), side = -appr[0] * Math.sin(az) + appr[1] * Math.cos(az);
    return [deg(Math.atan2(along, -appr[2])), deg(Math.asin(clamp(side, -1, 1)))];
  }

  /* ----- per tick ----- */
  tick(k) {
    this.jobTick();
    if (k % 4 === 0) {
      for (let c = 0; c < 2; c++) this.jit[c] = [(this.sim.rng() - 0.5) * 1.4, (this.sim.rng() - 0.5) * 1.4];
      this.autoTick();
    }
  }

  state() {
    const c = this.cfg, a = this.arm(), now = this.sim.t;
    const usable = this.usable(), loc = usable.length ? this.locate() : null;
    const cams = [...Array(this.ncam).keys()].map((i) => ({ cal: this.calibrated(i), rms: (this.models[i] || {}).rms ?? null, sees: this.foundFor(i).length > 0 }));
    const bz = this.z_table !== null ? this.zoneCenter('bowl') : null;
    const why = this.ready(), whyBowl = this.ready('bowl');
    const fwd = this.found0();
    return {
      ncam: this.ncam, cams, cam_mode: String(c.cam_mode),
      fusion: loc ? { cams: loc.cams.map((i) => i + 1), spread_mm: Math.round(loc.spread * 1000) } : null,
      kc_mm: loc ? [Math.round(loc.x * 1000), Math.round(loc.y * 1000)] : null,
      kc_z_mm: !loc || loc.z === null ? null : Math.round(loc.z * 1000),
      kc_gap_mm: !loc || loc.gap === null ? null : Math.round(loc.gap * 1000),
      bowl_mm: bz ? [Math.round(bz[0] * 1000), Math.round(bz[1] * 1000), Math.round(bz[2] * 1000)] : null,
      cam_cal: this.models.some(Boolean), cam_rms: (this.models[0] || {}).rms ?? null,
      z_table_mm: this.z_table === null ? null : Math.round(this.z_table * 1000), limp: !(a && a.torque_on),
      auto: { ...this.auto }, taught: c.points.length, fit_mm: this.err_mm, z_table: this.z_table, ready: why === null, why, why_bowl: whyBowl,
      zones: Object.fromEntries(Object.entries(this.zonesForState()).map(([n, z]) => [n, { p: z.p, drop: z.drop, r: z.r }])),
      here: loc ? this.zoneOfWorld(loc.x, loc.y) : null,
      align: { n: this.alignSpots.length, r_mm: this.alignSpots.map((s) => Math.round(s.r * 1000)).sort((x, y) => x - y), gap_mm: this.z_table === null ? null : Math.round(1000 * (-0.0024 - this.z_table)), undo: !!this.alignBackup },
      tilt: this.tiltState(a), status: this.status, log: this.history.slice(-14).map((h) => h[1]),
      grip_gap: a ? Math.round(this.gripGap(a)) : null, running: this.running, mode: this.mode, cycles: this.cycles,
      found: fwd, bowl_rim_mm: this.rim ? this.rim : null,
      params: { roll_offset: c.roll_offset, grasp_dz: c.grasp_dz, travel: c.travel, off_x: c.off_x, off_y: c.off_y, bowl_clear: c.bowl_clear, auto_bowl: !!c.auto_bowl },
      ready_bowl: whyBowl === null,
    };
  }
  found0() { return this.foundFor(0).slice(0, 1).map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Math.round(Number(v) * 10) / 10]))); }
  gripGap(a) { const [lo] = a.range(6); return a.pos[6] - lo; }
  tiltState(a) {
    if (!a || !a.online || a.cal === null) return null;
    const [s, lat] = this.tiltDeg(a), trim = this.cfg.pitch_trim_deg;
    return { now: Math.round((s - trim) * 10) / 10, lat: Math.round(lat * 10) / 10, trim, raw: Math.round(s * 10) / 10 };
  }
  zonesForState() {                                               // the bowl's pixel position follows the real bowl while auto-find is on (as annotate() does)
    const z = clone(this.cfg.zones), w = this.sim.world;
    if (this.cfg.auto_bowl && this.ncam > 0) { const b = project(0, [w.bowl.x, w.bowl.y, TABLE_Z + 0.045]); z.bowl.p = [b.u, b.v]; z.bowl.r = w.bowl.r * 0.9 * b.k; }
    return z;
  }
}

/* ------------------------------------------------------------------ Inspector trace: a ring buffer of what the app and the motors "say" */
export const REGISTERS = { 5: 'ID', 6: 'Baud_Rate', 9: 'Min_Position_Limit', 11: 'Max_Position_Limit', 31: 'Homing_Offset', 33: 'Operating_Mode', 40: 'Torque_Enable', 41: 'Acceleration', 42: 'Goal_Position', 46: 'Goal_Speed', 48: 'Torque_Limit', 55: 'Lock', 56: 'Present_Position', 60: 'Present_Load', 62: 'Present_Voltage', 63: 'Present_Temperature', 65: 'Status' };
const hex = (bytes) => bytes.map((b) => (b & 255).toString(16).padStart(2, '0')).join(' ');
const sum8 = (bytes) => (~bytes.reduce((a, b) => a + b, 0)) & 255;
const pkt = (id, instr, params) => { const body = [id, params.length + 2, instr, ...params]; return [0xff, 0xff, ...body, sum8(body)]; };
const le = (v, n) => (n === 2 ? [v & 255, (v >> 8) & 255] : [v & 255]);
/** Feetech STS packets as hex: ff ff id len instr params checksum. Returns {tx, rx|null}. */
export function packets(op, id, addr, value, ok = true) {
  const n = op.endsWith('2') ? 2 : 1;
  let tx, rx = null;
  if (op === 'ping') { tx = pkt(id, 0x01, []); rx = pkt(id, 0x00, []); }
  else if (op.startsWith('read')) { tx = pkt(id, 0x02, [addr, n]); rx = pkt(id, 0x00, le(value & 0xffff, n)); }
  else { tx = pkt(id, 0x03, [addr, ...le(value & 0xffff, n)]); rx = pkt(id, 0x00, []); }
  return { tx: hex(tx), rx: ok ? hex(rx) : null };
}

export class Trace {
  constructor({ max = 5000, rng } = {}) {
    this.enabled = false; this.raw = false; this.max = max; this.seq = 0; this.dropped = 0;
    this.buf = []; this.start = 0;                                   // ring buffer: buf[start..] is what is kept (dropped rows are trimmed in batches)
    this.rng = rng || mulberry32(7); this.lastT = 0;
  }
  get items() { return this.start ? this.buf.slice(this.start) : this.buf; }
  ms(a = 0.4, b = 2.5) { return Math.round((a + (b - a) * this.rng()) * 100) / 100; }
  push(t, kind, ok, ms, extra) {
    t = Math.max(t, this.lastT); this.lastT = t;                     // time never goes backwards in the buffer
    this.buf.push({ seq: ++this.seq, t: Math.round(t * 1000) / 1000, kind, ok, ms, ...extra });
    this.trim();
  }
  trim() {
    const over = this.buf.length - this.start - this.max;
    if (over > 0) { this.start += over; this.dropped += over; }
    if (this.start > 2048 && this.start > this.buf.length / 2) { this.buf = this.buf.slice(this.start); this.start = 0; }
  }
  bus(t, port, op, id, addr, value, ok = true, err = '') {
    if (!this.enabled) return;
    const ms = ok ? this.ms() : this.ms(30, 60);
    this.push(t, 'bus', ok, ms, { port, op, id, addr: op === 'ping' ? null : addr, reg: op === 'ping' ? 'Ping' : REGISTERS[addr] || `reg${addr}`, value: ok ? value : null, err: ok ? '' : err || 'no status packet (timeout)' });
    if (this.raw) {
      const p = packets(op, id, addr, value ?? 0, ok);
      this.push(t, 'raw', true, Math.round(ms * 0.2 * 100) / 100, { port, dir: 'tx', hex: p.tx });
      if (p.rx) this.push(t + 0.0004, 'raw', true, Math.round(ms * 0.6 * 100) / 100, { port, dir: 'rx', hex: p.rx });
    }
  }
  log(t, level, source, msg) { if (this.enabled) this.push(t, 'log', level !== 'error', 0, { level, source, msg }); }
  http(t, method, path, status, size) { if (this.enabled) this.push(t, 'http', status < 400, this.ms(0.3, 4.5), { method, path, status, size }); }
  configure(o = {}) {
    if (typeof o.max === 'number' && o.max >= 100) { this.max = Math.min(100000, Math.floor(o.max)); this.trim(); }
    if (typeof o.raw === 'boolean') this.raw = o.raw;
    if (typeof o.enabled === 'boolean') this.enabled = o.enabled;
    if (o.clear) { this.buf = []; this.start = 0; this.dropped = 0; }
  }
  status() { return { enabled: this.enabled, raw: this.raw, max: this.max, seq: this.seq, dropped: this.dropped }; }
  query({ since, kinds, limit } = {}) {
    const want = kinds ? new Set(String(kinds).split(',').map((s) => s.trim()).filter(Boolean)) : null;
    const cap = Math.max(1, Math.min(this.max, Number(limit) || 500));
    const after = since === undefined || since === null || since === '' ? null : Number(since);
    let out = this.items.filter((it) => (after === null || it.seq > after) && (!want || want.has(it.kind)));
    out = after === null ? out.slice(-cap) : out.slice(0, cap);          // paging forward from `since`, or "the latest N"
    return { enabled: this.enabled, raw: this.raw, seq: this.seq, dropped: this.dropped, items: out };
  }
  export(format = 'json') {
    const items = this.items, stamp = (t) => new Date(t * 1000).toISOString().slice(11, 23);
    if (format === 'ndjson') return items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');
    if (format === 'text') {
      return items.map((i) => {
        const base = `${stamp(i.t)}  ${i.kind.padEnd(4)}  ${i.ok ? 'ok ' : 'ERR'}  ${String(i.ms).padStart(6)} ms  `;
        if (i.kind === 'bus') return base + `${i.op} motor ${i.id}${i.op === 'ping' ? '' : ` ${i.reg}(${i.addr}) -> ${i.value}`}${i.err ? ` [${i.err}]` : ''}  (${i.port})`;
        if (i.kind === 'raw') return base + `${i.dir} ${i.hex}`;
        if (i.kind === 'http') return base + `${i.method} ${i.path} -> ${i.status} (${i.size} B)`;
        return base + `[${i.level}] ${i.source}: ${i.msg}`;
      }).join('\n') + (items.length ? '\n' : '');
    }
    return JSON.stringify({ enabled: this.enabled, raw: this.raw, seq: this.seq, dropped: this.dropped, items }, null, 2);
  }
}

/* ------------------------------------------------------------------ the whole simulated bench */
const PORT_CAL_KEYS = Object.keys(JOINTS).map(Number);
const GRAVITY = { 1: 4, 2: 110, 3: -70, 4: -35, 5: 6, 6: 10 };
const clipv = (v, lim) => clamp(v, -lim, lim);

export class Sim {
  constructor(o = {}) {
    this.seed = o.seed ?? 1;
    this.rng = mulberry32(this.seed);
    this.home = o.home || '/Users/demo';
    this.trace = o.trace || null;
    this.t = 0; this.t0 = null; this.k = 0;
    this.arms = []; this.viz = { flip: {}, offset: {} };
    this.world = { keychain: { x: LAYOUT.keychain[0], y: LAYOUT.keychain[1], z: KC_Z0, ang: 0.35, state: 'table' }, bowl: { ...LAYOUT.bowl }, tray: { ...LAYOUT.tray } };
    this.tele = { on: false, msg: '', hz: 0, blocked: '', synced: false, fresh: false };
    this.tourSpot = null; this.broken = {};
    this.pp = new PP(this);
    this.scenario = o.scenario || 'fresh';
    this.ncam = o.ncam ?? (this.scenario === 'nothing' ? 0 : this.scenario === 'ready' ? 2 : 1);
    this.pp.setNcam(this.ncam);
    this.broken = { follower: [...(o.brokenMotors?.follower || [])], leader: [...(o.brokenMotors?.leader || [])] };
    this.build(o);
  }

  build(o) {
    const paths = o.ports || { follower: 'demo://follower', leader: 'demo://leader' };
    const ids = (role) => [1, 2, 3, 4, 5, 6].filter((i) => !this.broken[role].includes(i));
    if (this.scenario === 'nothing') return;
    const ready = this.scenario === 'ready';
    const stiff = this.scenario === 'stiff';       // both arms calibrated, the FOLLOWER's torque ON (holding itself), nothing mapped: the owner's real situation on 2026-10-30
    const mk = (role, cal) => new SimArm(this, { path: paths[role], role, ids: ids(role), cal: ready || stiff ? cal : null, hasDefault: ready || stiff, torque: false });
    const f = mk('follower', READY_CAL.follower), l = mk('leader', READY_CAL.leader);
    this.arms.push(f, l);
    // start poses: the follower hovers over the table, the leader rests in a neutral pose
    const homeQ = ik([LAYOUT.keychain[0] - 0.02, LAYOUT.keychain[1] + 0.03, LAYOUT.hoverZ + 0.015]);
    if (homeQ) { const tk = ticksOf(f, homeQ); for (const i of [1, 2, 3, 4, 5]) { f.pos[i] = tk[i]; f.goal[i] = tk[i]; } }
    const leadQ = ik([0.18, -0.02, 0.07]) || homeQ;
    if (leadQ) { const tk = ticksOf(l, leadQ); for (const i of [1, 2, 3, 4, 5]) { l.pos[i] = tk[i]; l.goal[i] = tk[i]; } }
    f.pos[6] = f.goal[6] = gripTick(f, 25); l.pos[6] = l.goal[6] = gripTick(l, 30);
    if (stiff) {                                   // raised over the table, powered and holding: pp.limp is false until it is lowered (POST /api/pp/rest)
      f.torque_on = true;
      const up = ik([0.20, -0.02, 0.09]);
      if (up) { const tk = ticksOf(f, up); for (const i of [1, 2, 3, 4, 5]) { f.pos[i] = tk[i]; f.goal[i] = tk[i]; } }
    }
    if (ready) {
      f.torque_on = true;
      const pp = this.pp, zt = LAYOUT.touchZ;
      for (const [x, y] of LAYOUT.spots.slice(0, 4)) {
        const q = ik([x, y, zt]); if (!q) continue;
        const tip = fk(q).tip, px = project(0, [x, y, KC_Z0]);
        pp.cfg.points.push({ u: px.u + (this.rng() - 0.5) * 3, v: px.v + (this.rng() - 0.5) * 3, x: tip[0], y: tip[1], z: tip[2] });
      }
      pp.zt_cfg = zt; pp.cfg.z_table = zt;
      pp.fit();
      for (let i = 0; i < this.ncam; i++) pp.models[i] = { rms: Math.round((1.9 + 0.8 * i) * 10) / 10, n: 21 };
      const tp = project(0, [this.world.tray.x, this.world.tray.y, TABLE_Z + 0.011]);
      pp.cfg.zones.tray.p = [tp.u, tp.v];
      pp.status = '✓ calibrated: ' + [...Array(this.ncam).keys()].map((i) => `camera ${i + 1}: ${pp.models[i].rms.toFixed(1)} px from 21 poses`).join('; ');
      pp.history = [[0, pp.status]]; pp._status = 'idle';
    }
  }

  setNcam(n) { this.ncam = n; this.pp.setNcam(n); }
  follower() { return this.arms.find((a) => a.role === 'follower' && a.online) || null; }
  leader() { return this.arms.find((a) => a.role === 'leader' && a.online) || null; }
  ev(level, source, msg) { if (this.trace && this.trace.enabled) this.trace.log(this.t, level, source, msg); }
  rec(arm, op, id, addr, value, ok = true, err = '', dt = 0) { const tr = this.trace; if (tr && tr.enabled) tr.bus(this.t + dt, arm.path, op, id, addr, value, ok, err); }

  /* ----- time ----- */
  advance(tSec) {
    if (this.t0 === null) { this.t0 = tSec; this.t = tSec; return; }
    let want = Math.floor((tSec - this.t0) / DT + 1e-6);
    if (want - this.k > 4800) this.k = want - 4800;               // a long pause (a background tab): skip ahead, do not replay
    while (this.k < want) { this.k++; this.t = this.t0 + this.k * DT; this.tick(); }
  }

  /* ----- one tick = one teleop iteration ----- */
  tick() {
    this.teleTick();
    for (const a of this.arms) this.armTick(a);
    const f = this.follower(), pp = this.pp;
    if (pp.auto.on && f && f.mode === 'tour' && this.tourSpot !== null && this.tourSpot !== pp.lastPlaced) {   // "someone" lays the keychain at the spot the hand is about to touch
      const k = this.world.keychain, s = LAYOUT.spots[this.tourSpot];
      k.x = s[0]; k.y = s[1]; k.z = KC_Z0; k.ang = 0.3 + 0.45 * this.tourSpot; k.state = 'table'; pp.lastPlaced = this.tourSpot;
    }
    if (this.world.keychain.state === 'held' && f) { const tip = pp.tipNow(f); Object.assign(this.world.keychain, { x: tip[0], y: tip[1], z: Math.max(KC_Z0, tip[2] + 0.012) }); }
    pp.tick(this.k);
    if (this.k % 400 === 0 && this.trace && this.trace.enabled) for (let i = 0; i < this.ncam; i++) this.ev('info', 'camera', `Camera ${i + 1}: ${(29.4 + this.trace.rng() * 0.9).toFixed(1)} fps`);
  }

  modeOf(a) {
    if (a.calib.step === 'center') return 'center';
    if (a.calib.step === 'sweep') return 'sweep';
    if (a.torque_on) return 'servo';
    if (a.role === 'follower') return 'tour';
    if (a.role === 'leader' && this.tele.on) return 'leaderhand';
    return 'breath';
  }

  armTick(a) {
    if (!a.online) return;
    const mode = this.modeOf(a);
    if (mode !== a.mode) { a.mode = mode; a.modeT0 = this.t; a.anchor = { ...a.pos }; }
    if (a.mode !== 'tour') { if (a === this.follower()) this.tourSpot = null; }
    const tgt = {}, tau = {}, vmax = {};
    const hand = mode !== 'servo' ? this.handTargets(a, mode) : null;
    for (const i of a.ids) {
      if (hand) { tgt[i] = hand[i] ?? a.pos[i]; tau[i] = 0.12; vmax[i] = mode === 'sweep' ? 1800 : 650; }
      else { tgt[i] = a.goal[i]; tau[i] = 0.07; vmax[i] = i === 6 ? 1500 : 900; }
    }
    if (a.job) this.jobTargets(a, tgt, tau, vmax);
    let moving = 0;
    for (const i of a.ids) {
      const want = tgt[i];
      let d = (want - a.pos[i]) * (1 - Math.exp(-DT / tau[i]));
      d = clamp(d, -vmax[i] * DT, vmax[i] * DT);
      const [lo, hi] = a.limits[i];
      const np = clamp(a.pos[i] + d, lo, hi);
      a.vel[i] = (np - a.pos[i]) / DT; a.pos[i] = np; moving += Math.abs(a.vel[i]);
      const jb = a.job; if (jb && jb.type === 'motor' && jb.i === i && Math.abs(np - jb.cur) > Math.abs(jb.peakPos - jb.cur)) jb.peakPos = np;
    }
    // load, temperature and supply voltage change plausibly
    for (const i of a.ids) {
      const powered = a.torque_on || !!a.job || mode === 'servo';
      let target = powered ? GRAVITY[i] * (1 + 0.2 * Math.sin(this.t * 0.3 + i)) : 0;
      if (i === 6 && a.holding) target = 380;
      target += a.vel[i] * 0.08 * (powered ? 1 : 0.3);
      a.load[i] = clipv(a.load[i] + (target - a.load[i]) * 0.35 + (this.rng() - 0.5) * (powered ? 8 : 2), 1000);
      const tt = 31 + 0.3 * i + 12 * Math.min(1, Math.abs(a.load[i]) / 600);
      a.tempF[i] += (tt - a.tempF[i]) * DT / 90 + (this.rng() - 0.5) * 0.004;
      a.temp[i] = Math.round(a.tempF[i]);
      if (a.job && a.job.peak !== undefined && (a.job.i === undefined || a.job.i === i)) a.job.peak = Math.max(a.job.peak, Math.abs(a.load[i]));
    }
    a.volt = clamp(Math.round((12.0 - 0.0015 * moving / Math.max(1, a.ids.length) + (this.rng() - 0.5) * 0.12) * 10) / 10, 11.2, 12.2);
    if (this.k % 4 === 0) {                                       // the 10 Hz poll
      if (a.calib.step === 'sweep') for (const i of a.ids) { const r = a.calib.ranges[JOINTS[i]], p = Math.round(a.pos[i]); a.calib.ranges[JOINTS[i]] = [Math.min(r[0], p), Math.max(r[1], p)]; }
      for (const [id, until] of Object.entries(a.faultUntil || {})) if (this.t > until) { delete a.fault[id]; delete a.faultUntil[id]; }
      if (this.trace && this.trace.enabled) this.pollTrace(a);
    }
  }
  pollTrace(a) {
    let j = 0;
    for (const i of a.ids) {
      this.rec(a, 'read2', i, 56, Math.round(a.pos[i]), true, '', 0.0015 * j++);
      this.rec(a, 'read1', i, 65, a.fault[i] || 0, true, '', 0.0015 * j++);
      this.rec(a, 'read2', i, 60, (a.load[i] < 0 ? 1024 : 0) | Math.abs(Math.round(a.load[i])), true, '', 0.0015 * j++);
      this.rec(a, 'read1', i, 63, a.temp[i], true, '', 0.0015 * j++);
    }
    if (a.ids.length) this.rec(a, 'read1', a.ids[0], 62, Math.round(a.volt * 10), true, '', 0.0015 * j);
  }

  /* ----- the demo "hand" ----- */
  handTargets(a, mode) {
    const out = {}, tl = this.t - a.modeT0;
    if (mode === 'center') { for (const i of a.ids) out[i] = MID + (((i * 37) % 60) - 30); return out; }
    if (mode === 'sweep') {
      const n = a.ids.length, cycle = n * SWEEP_WINDOW + 1.5, tt = (this.t - a.sweepT0) % cycle;
      a.ids.forEach((i, idx) => { const u = (tt - idx * SWEEP_WINDOW) / SWEEP_WINDOW; out[i] = u >= 0 && u <= 1 ? MID + SWEEP_AMP[i] * Math.sin(2 * Math.PI * u) : MID; });
      return out;
    }
    if (mode === 'tour') return this.tourTarget(a, tl, 'limp') || a.anchor;
    if (mode === 'leaderhand') return this.tourTarget(a, tl, 'teleop') || a.anchor;
    for (const i of a.ids) out[i] = a.anchor[i] + (i <= 4 ? 22 * Math.sin((2 * Math.PI * tl) / (7 + i) + i) : 0);   // a limp arm resting on a table: barely moves
    return out;
  }
  /** Waypoints for the hand: hover over each spot, touch down, dwell, lift, move on. Built with IK from the follower's calibration. */
  tourFor(a, purpose) {
    const f = this.follower(); if (!f) return null;
    const l = a.role === 'leader' ? a : null;
    const key = JSON.stringify([f.cal, l && l.cal, purpose, this.viz.offset, this.viz.flip, this.pp.cfg.pitch_trim_deg]);
    if (a._tour && a._tour.key === key) return a._tour;
    const conv = (ticks) => {
      if (!l) return ticks;
      const out = {};
      for (const i of PORT_CAL_KEYS) { const [flo, fhi] = f.range(i), [llo, lhi] = l.range(i), t = (ticks[i] - flo) / Math.max(1, fhi - flo); out[i] = llo + t * (lhi - llo); }
      return out;
    };
    const wp = [];
    for (const [x, y] of LAYOUT.spots) {
      const mk = (z, pct) => { const q = ik([x, y, z], 0, rad(this.pp.cfg.pitch_trim_deg)); if (!q) return null; const t = ticksOf(f, q, this.viz); t[6] = gripTick(f, pct); return conv(t); };
      const H = mk(LAYOUT.hoverZ, purpose === 'teleop' ? 60 : 0), D = mk(LAYOUT.touchZ, 0);
      if (H && D) wp.push({ H, D });
    }
    const segs = [];
    wp.forEach((w, k) => {
      const nx = wp[(k + 1) % wp.length];
      segs.push({ dur: 0.9, from: w.H, to: w.D, spot: k }, { dur: 3.8, from: w.D, to: w.D, spot: k }, { dur: 0.7, from: w.D, to: w.H, spot: k }, { dur: 1.6, from: w.H, to: nx.H, spot: (k + 1) % wp.length });
    });
    a._tour = { key, wp, segs, cycle: segs.reduce((s, g) => s + g.dur, 0) };
    return a._tour;
  }
  tourTarget(a, tl, purpose) {
    const T = this.tourFor(a, purpose); if (!T || !T.wp.length) return null;
    const lerp = (A, B, e) => { const o = {}; for (const i of a.ids) o[i] = A[i] + (B[i] - A[i]) * e; return o; };
    const isFollower = a.role === 'follower';
    if (tl < 2.0) { if (isFollower) this.tourSpot = 0; return lerp(a.anchor, T.wp[0].H, ease(tl / 2.0)); }
    let tt = (tl - 2.0) % T.cycle;
    for (const g of T.segs) {
      if (tt < g.dur) { if (isFollower) this.tourSpot = g.spot; return lerp(g.from, g.to, ease(tt / g.dur)); }
      tt -= g.dur;
    }
    return T.wp[0].H;
  }

  /* wiggle / nudge / motor test: per-joint overrides while a job runs */
  jobTargets(a, tgt, tau, vmax) {
    const j = a.job, el = this.t - j.t0, p = Math.floor(el / j.dur);
    if (p >= j.phases.length) return this.jobDone(a);
    const ids = j.type === 'wiggle' ? a.ids : [j.i];
    if (j.type !== 'wiggle') for (const i of a.ids) if (i !== j.i) { tgt[i] = a.pos[i]; tau[i] = 0.05; vmax[i] = 900; }   // everything else is held still while one motor is tested
    for (const i of ids) {
      if (j.type === 'wiggle') tgt[i] = clamp(j.start[i] + j.phases[p] * WIGGLE_AMP[i], 0, TICKS);
      else if (j.type === 'nudge') tgt[i] = clamp(j.cur + j.phases[p], j.lo + 5, j.hi - 5);
      else tgt[i] = clamp(j.cur + j.phases[p] * j.delta, j.lo + 3, j.hi - 3);
      tau[i] = 0.18; vmax[i] = j.type === 'motor' ? 330 : 500;
      if (el === 0 || Math.floor((el - DT) / j.dur) !== p) this.rec(a, 'write2', i, 42, Math.round(tgt[i]));
    }
  }
  jobDone(a) {
    const j = a.job; a.job = null;
    if (j.type === 'motor') {
      a.goal[j.i] = j.cur;                                        // back where it started; a limp arm simply goes limp again
      this.rec(a, 'write1', j.i, 40, a.torque_on ? 1 : 0);
      j.result = { moved: Math.abs(j.peakPos - j.cur) * 360 / TICKS, peak: j.peak / 10 };
      if (j.resolve) j.resolve(j.result);
    } else { a.torque_on = false; for (const i of a.ids) this.rec(a, 'write1', i, 40, 0); }
  }

  /* ----- teleop ----- */
  pair() { return [this.follower(), this.leader()]; }
  teleWhy() {
    const [f, l] = this.pair();
    if (!l && !f) return 'No arms are connected';
    if (!l) return "Plug the leader arm into this computer's USB first (only the follower is connected)";
    if (!f) return 'The follower arm is not connected';
    if (f.cal === null || l.cal === null) return 'Both arms need a calibration first (Arms tab)';
    if ([f, l].some((a) => a.calib.step !== 'idle' || a.wiggling)) return 'An arm is busy (calibration or test)';
    if (this.pp.running) return 'Pick & place is running: press Stop first';
    return null;
  }
  teleStart() {
    if (this.tele.on) return;
    const err = this.teleWhy(); if (err) { this.tele.msg = err; return; }
    Object.assign(this.tele, { msg: 'starting…', blocked: '', synced: false, on: true, fresh: true, hz: 0 });
    this.ev('info', 'teleop', 'Leader to follower started');
  }
  teleStop(why = 'stopped') {
    if (this.tele.on) { this.tele.msg = why; this.ev('info', 'teleop', `Leader to follower ${why}`); }
    this.tele.on = false;
    const f = this.follower(); if (f) f.holdHere();
  }
  teleState() {
    const [f, l] = this.pair(), t = this.tele;
    return { on: t.on, msg: t.msg, hz: Math.round(t.hz), blocked: t.blocked, synced: t.synced, why: t.on ? null : this.teleWhy(), both: !!(f && l) };
  }
  teleTick() {
    const t = this.tele; if (!t.on) return;
    const [f, l] = this.pair();
    if (!f || !l) { t.on = false; t.msg = 'stopped: an arm was disconnected'; if (f) f.holdHere(); this.ev('warn', 'teleop', t.msg); return; }
    if (t.fresh) { l.torque_on = false; f.armMotion(true); t.fresh = false; t.msg = "the follower is moving to the leader's pose: keep the area around it clear"; }
    const ids = PORT_CAL_KEYS.filter((i) => f.ids.includes(i) && l.ids.includes(i));
    const slew = t.synced ? DEFAULTS.safety.teleop_slew_ticks : DEFAULTS.safety.teleop_slew_sync_ticks;
    const target = {};
    for (const i of ids) {
      const n = JOINTS[i], lc = l.cal[n], fc = f.cal[n];
      const x = clamp((l.pos[i] - lc[0]) / Math.max(1, lc[1] - lc[0]), 0, 1);
      target[i] = Math.trunc(fc[0] + x * (fc[1] - fc[0]));
      const nw = f.goal[i] + clamp(target[i] - f.goal[i], -slew, slew);
      f.goal[i] = clamp(nw, fc[0] + 3, fc[1] - 3);
      if (this.trace && this.trace.enabled) { this.rec(l, 'read2', i, 56, Math.round(l.pos[i])); this.rec(f, 'write2', i, 42, Math.round(f.goal[i])); }
    }
    if (!t.synced && ids.every((i) => i === 6 || Math.abs(f.pos[i] - target[i]) < 45)) { t.synced = true; t.msg = 'following the leader'; }
    t.hz = 40;
  }

  /* ----- what the UI reads ----- */
  state() { return { viz: clone(this.viz), pp: this.pp.state(), teleop: this.teleState(), arms: this.arms.map((a) => a.state()) }; }
  /** everything a camera picture needs (see scene.js sceneModel) */
  worldForScene(i) {
    const f = this.follower(), pp = this.pp, k = this.world.keychain;
    let arm = null;
    if (f) { const F = fk(pp.q(f)), [lo, hi] = f.range(6); arm = { pts: F.pts, dir: F.appr, open: clamp((f.pos[6] - lo) / Math.max(1, hi - lo), 0, 1) }; }
    const found = pp.foundFor(i).map((d) => ({ u: d.u, v: d.v, w: d.w, h: d.h, angle: d.angle, partial: !!d.partial }));
    const overlay = { found, taught: i === 0 ? pp.cfg.points.map((p) => ({ u: p.u, v: p.v })) : [], zones: i === 0 ? pp.zonesForState() : {} };
    return { keychain: { x: k.x, y: k.y, z: k.z, ang: k.ang, visible: k.state !== 'bowl' }, bowl: this.world.bowl, tray: this.world.tray, arm, overlay };
  }

  /* ----- API-level actions ----- */
  arm(idx) { return this.arms[Number(idx)] || null; }
  setRole(a, role) {
    if (role !== 'follower' && role !== 'leader') return;
    const other = this.arms.find((x) => x !== a && x.role === role);
    if (other && this.arms.length === 2) other.role = role === 'follower' ? 'leader' : 'follower';    // a swap: never two of a kind
    a.role = role;
  }
  connect(path, ids) {
    ids = [...new Set(ids.map(Number).filter((i) => i >= 1 && i <= 6))].sort((x, y) => x - y);
    let a = this.arms.find((x) => x.path === path) || (path === 'demo://follower' || path === 'demo://leader' ? this.arms.find((x) => x.role === path.slice(7)) : null);
    if (!a) {
      if (!ids.length) return null;
      const role = this.arms.some((x) => x.role === 'follower') ? 'leader' : 'follower';
      a = new SimArm(this, { path, role, ids }); this.arms.push(a);
      this.ev('info', 'arm', `${role} arm connected on ${path} (${ids.length} motors answer)`);
      return a;
    }
    const was = a.online; a.ids = ids; a.online = ids.length > 0;
    for (const r of ['follower', 'leader']) if (a.role === r) this.broken[r] = this.broken[r].filter((i) => !ids.includes(i));
    if (a.online !== was) this.ev(a.online ? 'info' : 'warn', 'arm', a.online ? `${a.role} arm connected on ${a.path} (${ids.length} motors answer)` : `${a.role} arm lost: no motor answers on ${a.path}`);
    return a;
  }
  setFault(a, id, kind = 'overload', seconds = 2.5) {
    const bit = Number(Object.entries(FAULT_BITS).find(([, v]) => v === kind)?.[0] || 32);
    a.fault[id] = (a.fault[id] || 0) | bit; (a.faultUntil = a.faultUntil || {})[id] = this.t + seconds;
    const msg = `${JOINTS[id]} ${kind}: protection tripped: torque re-armed, the arm holds where it is`;
    a.say(msg); this.ev('warn', 'arm', msg);
  }
  calib(idx, action) {
    const a = this.arm(idx); if (!a) return;
    const before = a.calib.step;
    ({ start: () => a.calibStart(), center: () => a.calibCenter(), finish: () => a.calibFinish(), cancel: () => a.calibCancel(), restore: () => a.restoreDefault(), set_default: () => a.setDefault() })[action]?.();
    const who = a.role[0].toUpperCase() + a.role.slice(1);
    if (action === 'start' && a.calib.step === 'center') { this.ev('info', 'calibration', `${who}: calibration started (limp, centre step)`); for (const i of a.ids) { this.rec(a, 'write1', i, 40, 0); this.rec(a, 'write1', i, 33, 0); this.rec(a, 'write2', i, 31, 0); this.rec(a, 'write2', i, 9, 0); this.rec(a, 'write2', i, 11, 4095); } }
    else if (action === 'center' && before === 'center' && a.calib.step === 'sweep') { this.ev('info', 'calibration', `${who}: centred, now sweeping every joint`); for (const i of a.ids) this.rec(a, 'write2', i, 31, 0); }
    else if (action === 'finish' && a.calib.step === 'done') { this.ev('info', 'calibration', `${who}: calibration saved to ${a.calib.saved}`); for (const i of a.ids) { this.rec(a, 'write2', i, 9, a.cal[JOINTS[i]][0]); this.rec(a, 'write2', i, 11, a.cal[JOINTS[i]][1]); } }
    else if (action === 'finish' && a.calib.error) this.ev('warn', 'calibration', `${who}: ${a.calib.error}`);
    else if (action === 'cancel' && before !== 'idle') this.ev('info', 'calibration', `${who}: calibration cancelled`);
  }
  nudge(idx, name) { const a = this.arm(idx); if (a && !this.tele.on) a.nudge(name); }
  wiggle(idx) { const a = this.arm(idx); if (a) a.wiggle(); }

  /** Suite "Test motors": ping (read-only) and a ~10 degree wiggle of ONE motor. Throws Error(sentence) when refused. */
  armFor({ role, port }) {
    return this.arms.find((a) => (port && a.path === port) || (!port && role && a.role === role)) || null;
  }
  motorMissing(a, id) { return !a.ids.includes(id); }
  ping(a, id) {
    const joint = JOINTS[id], ms = Math.round((0.5 + this.rng() * 1.5) * 10) / 10;
    if (!a.online || this.motorMissing(a, id)) {
      this.rec(a, 'ping', id, 0, null, false, 'no status packet (timeout)');
      return { ok: false, id, joint, position: null, load_pct: null, temp_c: null, volt: null, ms: Math.round((40 + this.rng() * 20) * 10) / 10, message: `Motor ${id} did not answer. Check its 3-pin cable and that the power supply is on.` };
    }
    this.rec(a, 'ping', id, 0, 0); this.rec(a, 'read2', id, 56, Math.round(a.pos[id])); this.rec(a, 'read2', id, 60, Math.abs(Math.round(a.load[id]))); this.rec(a, 'read1', id, 63, a.temp[id]); this.rec(a, 'read1', id, 62, Math.round(a.volt * 10));
    return { ok: true, id, joint, position: Math.round(a.pos[id]), load_pct: Math.round(Math.abs(a.load[id])) / 10, temp_c: a.temp[id], volt: a.volt, ms };
  }
  /** Starts the wiggle and returns {job, duration}; the arm moves as time advances. */
  motorWiggleStart(a, id) {
    if (!a.online) throw new Error(`The ${a.role} arm is not connected.`);
    if (this.tele.on) throw new Error('Leader to follower is running: stop it before testing a motor.');
    if (this.pp.running) throw new Error('Pick & place is running: press Stop first.');
    if (a.calib.step === 'center' || a.calib.step === 'sweep') throw new Error('Calibration is running: finish or cancel it before testing a motor.');
    if (a.job) throw new Error('This arm is already moving a motor: wait a moment and try again.');
    if (this.motorMissing(a, id)) return null;
    const [lo, hi] = a.limits[id], cur = a.pos[id];
    const delta = Math.round(10 * TICKS / 360 + (this.rng() - 0.5) * 8), dir = cur + delta <= hi - 3 ? 1 : -1;
    a.job = { type: 'motor', t0: this.t, i: id, cur, lo, hi, phases: [dir, 0], delta, dur: 1.0, peak: 0, peakPos: cur };
    this.rec(a, 'write1', id, 40, 1);
    return a.job;
  }
}
