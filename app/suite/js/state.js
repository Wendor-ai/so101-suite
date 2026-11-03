// Shared app state: one polling loop feeds every page. Pages subscribe instead of polling on their own.
import { api } from './api.js';

export const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];
export const JOINT_LABEL = { shoulder_pan: 'Shoulder pan', shoulder_lift: 'Shoulder lift', elbow_flex: 'Elbow flex', wrist_flex: 'Wrist flex', wrist_roll: 'Wrist roll', gripper: 'Gripper' };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Joint reading in degrees, 0 = the MIDDLE of the calibrated range (LeRobot's convention). Gripper is 0..100 % open. */
export function poseFromArm(arm) {
  const pose = {};
  for (const j of arm?.joints || []) {
    const r = (arm.calib?.step === 'sweep' && arm.calib.ranges?.[j.name]) || arm.cal?.[j.name];
    const mid = r ? (r[0] + r[1]) / 2 : 2047.5;
    const p = j.pos ?? mid;
    if (j.name === 'gripper') pose.gripper = r ? clamp((p - r[0]) / Math.max(1, r[1] - r[0]), 0, 1) * 100 : (p / 4095) * 100;
    else pose[j.name] = ((p - mid) * 360) / 4095;
  }
  return pose;
}
/** Value in LeRobot's -100..+100 scale (0 = middle of the range). null until a range is known. */
export function normalized(arm, joint) {
  const j = arm?.joints?.find((x) => x.name === joint);
  const r = (arm?.calib?.step === 'sweep' && arm.calib.ranges?.[joint]) || arm?.cal?.[joint];
  if (!j || j.pos == null || !r || r[1] <= r[0]) return null;
  return ((j.pos - r[0]) / (r[1] - r[0])) * 200 - 100;
}

export const ACCENTS = { orange: '#ff8a1f', blue: '#4cc2ff', green: '#3ddc97', violet: '#a78bfa', pink: '#ff6b9a', yellow: '#f5c518' };
export const ACCENT_NAMES = Object.keys(ACCENTS);
export function applySettings(s) {
  const ui = s?.ui || {};
  const root = document.documentElement;
  root.dataset.theme = ['dark', 'light', 'auto'].includes(ui.theme) ? ui.theme : 'auto';
  root.style.setProperty('--accent', ACCENTS[ui.accent] || ACCENTS.orange);
  root.style.setProperty('--fs', { small: '14px', normal: '15px', large: '17px' }[ui.textSize] || '15px');
  root.dataset.motion = ui.reduceMotion ? 'reduce' : '';
  root.dataset.guide = ui.guide === 'expert' ? 'expert' : 'beginner';
}

export function createCtx() {
  const subs = new Set();
  let timers = [];
  const ctx = {
    api,
    state: null, checklist: null, info: null, settings: null,
    offline: false, offlineReason: '',
    subscribe(fn) { subs.add(fn); if (ctx.state) fn(ctx); return () => subs.delete(fn); },
    /** Call cb only when select(ctx) actually changed (compared as JSON). Use this to avoid re-drawing on every tick. */
    onChange(select, cb) {
      let last;
      return ctx.subscribe((c) => { const v = select(c); const s = JSON.stringify(v); if (s !== last) { last = s; cb(v, c); } });
    },
    notify() { subs.forEach((f) => { try { f(ctx); } catch (e) { console.error(e); } }); },
    go(page) { location.hash = '#/' + String(page).replace(/^#?\/?/, ''); },
    arm(role) { return ctx.state?.arms?.find((a) => a.role === role) || null; },
    get guide() { return ctx.settings?.ui?.guide === 'expert' ? 'expert' : 'beginner'; },
    get units() { return ctx.settings?.ui?.units === 'norm' ? 'norm' : 'deg'; },
    /** True while any arm may be moving under power (drives the always-visible STOP button). */
    get moving() { const s = ctx.state; return !!(s && ((s.pp && (s.pp.limp === false || s.pp.running)) || s.teleop?.on)); },
    async setSetting(path, value) {
      const [group, key] = path.split('.');
      ctx.settings = { ...ctx.settings, [group]: { ...(ctx.settings?.[group] || {}), [key]: value } };
      applySettings(ctx.settings);
      ctx.notify();
      await api.post('/api/suite/settings', { [group]: { [key]: value } });
    },
    async refresh() { await Promise.allSettled([pollState(), pollChecklist(), pollInfo()]); },
    async init() {
      const [info, settings] = await Promise.allSettled([api.get('/api/suite/info'), api.get('/api/suite/settings')]);
      ctx.info = info.value || {};
      ctx.settings = settings.value || { ui: {} };
      await ctx.refresh();
    },
    start() {
      stop();
      timers = [loop(pollState, 500), loop(pollChecklist, 2500), loop(pollInfo, 5000)];
    },
  };
  const stop = () => { timers.forEach((t) => t.cancel()); timers = []; };
  async function pollState() {
    try { ctx.state = await api.get('/api/state'); if (ctx.offline) { ctx.offline = false; } ctx.offlineReason = ''; }
    catch (e) { ctx.offline = true; ctx.offlineReason = e.message; }
    ctx.notify();
  }
  async function pollChecklist() { try { ctx.checklist = await api.get('/api/suite/checklist'); } catch { /* keep the last one */ } }
  async function pollInfo() { try { ctx.info = await api.get('/api/suite/info'); } catch { /* keep the last one */ } }
  function loop(fn, ms) {
    let dead = false, t;
    const tick = async () => { if (dead) return; if (!document.hidden) await fn(); t = setTimeout(tick, document.hidden ? ms * 4 : ms); };
    t = setTimeout(tick, ms);
    return { cancel() { dead = true; clearTimeout(t); } };
  }
  return ctx;
}
