// Inspector: like a browser's Network tab, for the arm. Off until you switch Record on.
// Shows what the app says to the motors (bus), what this page asks the app (network) and the app's own notes (logs),
// in words, with a detail drawer that explains each row. The pure parts (summaries, grouping, search, report) are
// exported by name so they can be unit-checked without a browser.
import { api } from '../api.js';
import { h, icon, button, callout, empty, pageHead, rich, toast, term, loadCss } from '../ui.js';
import {
  regOf, regInfo, describeValue, faultsOf, faultText, explainError, explainEntry, motorLabel, jointOf, OPS, isRead, isWrite, busBytes,
  POLL_ADDRS, hexBytes, spaced, parsePackets, describePacket, packetSummary, STATUS_TEXT, httpWords, MIDDLE_TICKS,
} from '../content/registers.js';

export const MAX_ROWS = 2000;         // table lines kept in the page (oldest dropped)
export const STORE_CAP = 8000;        // entries kept in memory for search, filters and the report
const FETCH_LIMIT = 500;
const SLOW_MS = { bus: 20, http: 300 };
const OWN_PATH = /^\/api\/suite\/trace/;

/* =====================================================================================================================
   Pure helpers
   ===================================================================================================================== */

export const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function fmtMs(ms) {
  if (ms == null || Number.isNaN(+ms)) return '';
  ms = +ms;
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`;
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}
export const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
export const fmtRel = (t, t0) => { const d = t - (t0 ?? t); return `${d < 0 ? '-' : '+'}${Math.abs(d).toFixed(3)} s`; };
/** Wall-clock time for hover text. Only when `t` is epoch seconds; the demo may use its own clock. */
export function fmtClock(t) {
  if (!(t > 1e9)) return '';
  const d = new Date(t * 1000), p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
/** every 100 ms / every 2.5 s, rounded to a number a person would say */
export function fmtEvery(ms) {
  if (!(ms > 0) || !Number.isFinite(ms)) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1).replace(/\.0$/, '')} s`;
  const step = ms >= 200 ? 50 : ms >= 100 ? 10 : ms >= 20 ? 5 : 1;
  return `${Math.max(1, Math.round(ms / step) * step)} ms`;
}
/** [1,2,3,4,6] -> "1-4, 6" */
export function motorsText(ids) {
  const a = [...ids].filter((x) => x != null).sort((x, y) => x - y), out = [];
  for (let i = 0; i < a.length;) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    out.push(j > i ? `${a[i]}-${a[j]}` : String(a[i]));
    i = j + 1;
  }
  return out.join(', ');
}

export const typeOf = (it) => ({ bus: 'bus', http: 'net', log: 'log', raw: 'raw', gap: 'gap' }[it.kind] || 'log');
export const TYPE_LABEL = { bus: 'Bus', net: 'Network', log: 'Log', raw: 'Raw', gap: 'Gap' };
export const isOwn = (it) => it.kind === 'http' && OWN_PATH.test(String(it.path || ''));
export const isError = (it) => it.kind !== 'gap' && (it.ok === false || (it.kind === 'log' && it.level === 'error') || (it.kind === 'http' && it.status >= 400));
const hasFault = (it) => it.kind === 'bus' && isRead(it.op) && it.addr === 65 && (Number(it.value) & 63) !== 0;

function humanize(name) { return String(name || '').replace(/_/g, ' ').toLowerCase(); }

/** One line in words. {type, text} */
export function summarize(it) {
  const type = typeOf(it);
  if (it.kind === 'gap') return { type, text: `${fmtInt(it.missed)} entries were missed here. The app keeps only the newest ${fmtInt(it.max || 5000)}, so busy moments can scroll past before this page asks again.` };
  if (it.kind === 'http') return { type, text: `${it.method} ${it.path} → ${it.status ?? '?'}` };
  if (it.kind === 'log') return { type, text: String(it.msg ?? '') };
  if (it.kind === 'raw') {
    const dir = it.dir === 'tx' ? 'TX' : 'RX';
    return { type, text: `${dir} ${it.dir === 'tx' ? '→' : '←'} ${packetSummary(hexBytes(it.hex), it.dir)}` };
  }
  const m = `motor ${it.id}`, op = it.op, r = regOf(it), ok = it.ok !== false;
  if (op === 'ping') return { type, text: `Ping ${m} → ${ok ? 'answered' : 'no answer'}` };
  const noun = r ? r.noun : it.addr != null ? `register ${it.addr}` : humanize(it.reg) || 'a register';
  const val = ok && it.value != null ? describeValue(r?.addr ?? it.addr, it.value).text : '';
  if (isWrite(op)) return { type, text: `Set ${noun} of ${m} → ${ok ? val : 'failed'}` };
  return { type, text: `Read ${noun} of ${m} → ${ok ? val : 'failed'}` };
}
/** {kind:'ok'|'err'|'warn', label, text} */
export function statusOf(it) {
  if (it.kind === 'gap') return { kind: 'warn', label: 'WARN', text: 'missed' };
  if (it.kind === 'http') return it.status >= 400 || it.ok === false ? { kind: 'err', label: 'ERR', text: `HTTP ${it.status ?? ''} ${STATUS_TEXT[it.status] || ''}`.trim() } : { kind: 'ok', label: 'OK', text: '' };
  if (it.kind === 'log') return it.level === 'error' || it.ok === false ? { kind: 'err', label: 'ERR', text: 'error' } : it.level === 'warn' ? { kind: 'warn', label: 'WARN', text: 'warning' } : { kind: 'ok', label: 'OK', text: '' };
  if (it.ok === false) return { kind: 'err', label: 'ERR', text: String(it.err || 'failed') };
  if (hasFault(it)) return { kind: 'warn', label: 'WARN', text: `fault: ${faultText(Number(it.value) & 63)}` };
  return { kind: 'ok', label: 'OK', text: '' };
}
export function sizeOf(it) {
  if (it.size != null) return it.size;
  if (it.kind === 'raw') return hexBytes(it.hex).length;
  if (it.kind === 'bus') return busBytes(it.op);
  return null;
}
export const isSlow = (it) => it.ms != null && SLOW_MS[it.kind] != null && it.ms >= SLOW_MS[it.kind];
/** 0..1 width of the duration bar */
export function barFrac(it) { const scale = (SLOW_MS[it.kind] || 100) * 2.5; return Math.max(0.04, Math.min(1, (+it.ms || 0) / scale)); }

const hay = new WeakMap();
function haystack(it) {
  let s = hay.get(it);
  if (s) return s;
  const r = it.kind === 'bus' ? regOf(it) : null;
  s = [summarize(it).text, statusOf(it).text, it.kind, it.op, it.id != null ? `motor ${it.id} id ${it.id}` : '', r ? `${r.name} ${r.noun} ${r.name.replace(/_/g, ' ')} ${r.addr}` : '', it.addr, it.reg, it.method, it.path, it.status, it.level, it.source, it.msg, it.err, it.port, it.dir]
    .filter((x) => x != null && x !== '').join(' | ').toLowerCase();
  hay.set(it, s);
  return s;
}
/** All words must appear in the summary, motor id, register name, path, error, ... (a quoted phrase such as "motor 3" is matched whole). */
export function matches(it, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const s = haystack(it);
  if (s.includes(q)) return true;
  // "motor 3" and "id 3" are one word each, so "motor 4" does not match the 4 in 2048
  const words = (q.match(/(?:motor|id)\s*\d+|\S+/g) || []).map((w) => w.replace(/^(motor|id)\s*(\d+)$/, '$1 $2'));
  return words.every((w) => s.includes(w));
}

/* ----- grouping: fold the routine, repeating traffic into one line ----- */
const HTTP_POLL = [
  [/^\/api\/state$/, 'Arm status poll'], [/^\/api\/suite\/checklist$/, 'Setup checklist poll'], [/^\/api\/suite\/info$/, 'App info poll'],
  [/^\/api\/suite\/(ports|cameras|identify|progress)$/, 'Device poll'], [/^\/api\/(pp|teleop)\/(state|status)$/, 'Job status poll'],
];
const httpPollName = (path) => (HTTP_POLL.find(([re]) => re.test(path)) || [])[1] || null;

function famOf(it, rawMemo) {
  if (it.kind === 'bus') {
    const port = it.port || '';
    if (it.ok === false) return { key: `fail:${it.err || ''}`, fam: 'fail', cat: 'repeat' };
    if (isRead(it.op) && POLL_ADDRS.has(it.addr)) {
      if (hasFault(it)) return { key: `fault:${port}:${it.id}:${Number(it.value) & 63}`, fam: 'fault', cat: 'repeat' };
      return { key: `poll:${port}`, fam: 'poll', cat: 'poll' };
    }
    if (it.op === 'write2' && it.addr === 42) return { key: `goal:${port}`, fam: 'goal', cat: 'poll' };
    return null;
  }
  if (it.kind === 'http') return it.method === 'GET' && it.status < 400 && httpPollName(String(it.path || '')) ? { key: `http:${it.path}`, fam: 'http', cat: 'poll' } : null;
  if (it.kind === 'raw') {
    const port = it.port || '';
    if (it.dir === 'tx') {
      const p = parsePackets(hexBytes(it.hex)).packets[0];
      const sub = p && p.code === 2 && POLL_ADDRS.has(p.params[0]) ? 'poll' : p && p.code === 3 && p.params[0] === 42 ? 'goal' : null;
      rawMemo.set(port, sub);
      return sub ? { key: `raw:${sub}:${port}`, fam: 'raw', sub, cat: 'poll' } : null;
    }
    const sub = rawMemo.get(port);
    return sub ? { key: `raw:${sub}:${port}`, fam: 'raw', sub, cat: 'poll' } : null;
  }
  return null;
}
function newGroup(f, it) {
  return { kind: 'group', fam: f.fam, sub: f.sub, cat: f.cat, key: f.key, first: it, last: it, count: 0, members: [], ids: new Set(), addrs: new Set(), ports: new Set(), perKey: new Map(), msSum: 0, bytes: 0, dom: null };
}
function addMember(g, it) {
  g.count++; g.last = it; g.msSum += +it.ms || 0; g.bytes += sizeOf(it) || 0;
  if (it.id != null) g.ids.add(it.id);
  if (it.addr != null) g.addrs.add(it.addr);
  if (it.port) g.ports.add(it.port);
  if (it.kind === 'bus') { const k = `${it.port}|${it.id}|${it.addr}`; g.perKey.set(k, (g.perKey.get(k) || 0) + 1); }
  g.members.push(it);
  if (g.members.length > 600) g.members.splice(0, 100);
}
export const groupRounds = (g) => (g.perKey.size && (g.fam === 'poll' || g.fam === 'goal') ? Math.max(...g.perKey.values()) : g.count);
export const groupInterval = (g) => { const n = groupRounds(g); return n >= 2 && g.last.t > g.first.t ? ((g.last.t - g.first.t) / (n - 1)) * 1000 : 0; };
export const groupType = (g) => (g.fam === 'http' ? 'net' : g.fam === 'raw' ? 'raw' : 'bus');
export function groupStatus(g) {
  if (g.fam === 'fail') return { kind: 'err', label: 'ERR', text: String(g.first.err || 'failed') };
  if (g.fam === 'fault') return { kind: 'warn', label: 'WARN', text: `fault: ${faultText(Number(g.first.value) & 63)}` };
  return { kind: 'ok', label: 'OK', text: '' };
}
/** "Status poll for motors 1-6 × 240 (every 100 ms)" */
export function groupLabel(g, o = {}) {
  const n = g.count, rounds = groupRounds(g), every = fmtEvery(groupInterval(g)), ev = every ? ` (every ${every})` : '';
  const ms = `motor${g.ids.size > 1 ? 's' : ''} ${motorsText(g.ids)}`;
  const where = o.multiPort && o.portName && g.first.port ? ` · ${o.portName(g.first.port)}` : '';
  switch (g.fam) {
    case 'poll': { const a = g.addrs; return `${a.size === 1 && a.has(56) ? 'Position poll' : a.has(56) ? 'Status poll' : 'Health poll'} for ${ms} × ${fmtInt(rounds)}${ev}${where}`; }
    case 'goal': return `Goal positions sent to ${ms} × ${fmtInt(rounds)}${ev}${where}`;
    case 'http': return `${httpPollName(String(g.first.path)) || `GET ${g.first.path}`} × ${fmtInt(n)}${ev}`;
    case 'raw': return `Raw bytes of ${g.sub === 'goal' ? 'goal-position messages' : 'the routine motor check'} × ${fmtInt(n)}`;
    case 'fail': return `Messages to the motors failed (${g.first.err || 'no reason given'}) × ${fmtInt(n)}`;
    case 'fault': return `${motorLabel(g.first.id)} reports a fault: ${faultText(Number(g.first.value) & 63)} × ${fmtInt(n)}`;
    default: return `Repeated × ${fmtInt(n)}`;
  }
}
export function groupDetail(g) {
  const regs = [...g.addrs].sort((a, b) => a - b).map((a) => `${regInfo(a)?.noun || 'register'} (${a})`).join(', ');
  switch (g.fam) {
    case 'poll': return `Routine check: the app reads ${regs} so the screen and the 3D arm stay live. Normal.`;
    case 'goal': return 'The app tells the joints where to go, many times a second (teleoperation or Control).';
    case 'http': return `GET ${g.first.path}: this page asks the app for the latest state. Normal.`;
    case 'raw': return 'The same routine traffic, as bytes.';
    case 'fail': return `Motors ${motorsText(g.ids) || '?'}${regs ? `: ${regs}` : ''}. Open one to see what to try.`;
    case 'fault': return 'The motor keeps reporting this protection flag.';
    default: return '';
  }
}

/** Folds repeating traffic. push() says whether the row is new or an existing group grew; an ordinary event closes every open group. */
export class Grouper {
  constructor({ group = true } = {}) { this.group = group; this.open = new Map(); this.rawMemo = new Map(); }
  push(it) {
    const fam = this.group && it.kind !== 'gap' ? famOf(it, this.rawMemo) : null;
    if (!fam) { this.open.clear(); return { row: { kind: 'item', item: it }, isNew: true }; }
    let g = this.open.get(fam.key), isNew = false;
    if (!g) { g = newGroup(fam, it); this.open.set(fam.key, g); isNew = true; }
    addMember(g, it);
    return { row: g, isNew };
  }
  forget(g) { for (const [k, v] of this.open) if (v === g) this.open.delete(k); }
}
/** Pure: items in, display rows out. A group of one is still a group object; the view draws it like an ordinary row. */
export function groupPolling(items, { group = true } = {}) {
  const gr = new Grouper({ group }), rows = [];
  for (const it of items) { const { row, isNew } = gr.push(it); if (isNew) rows.push(row); }
  return rows;
}
export const isPollItem = (it) => { const f = famOf(it, new Map()); return !!f && f.cat === 'poll'; };

/* ----- the issue report ----- */
const rowItem = (r) => (r.kind === 'group' ? r.first : r.item);
export function buildReport({ info, platform, items, total, arms, recording, raw, dropped, t0, guide }) {
  const L = [];
  const real = items.filter((i) => i.kind !== 'gap');
  const p = platform || {};
  L.push('## SO-101 Suite issue report', '');
  L.push(`- App: SO-101 Suite ${info?.version || '?'}${info?.license ? ` (${info.license})` : ''}${info?.demo ? ', demo mode (simulated hardware)' : ''}`);
  L.push(`- Computer: ${[{ macos: 'macOS', linux: 'Linux', windows: 'Windows' }[p.os] || p.os, p.os_version, p.arch].filter(Boolean).join(' ') || 'unknown'}${p.is_pi ? ` (Raspberry Pi${p.pi_model ? ' ' + p.pi_model : ''})` : ''}${p.python ? ` · Python ${p.python}` : ''}${typeof p.uv === 'string' ? ` · uv ${p.uv}` : p.uv === true ? ' · uv installed' : p.uv === false ? ' · uv missing' : ''}${p.in_dialout === false ? ' · NOT in the dialout group' : ''}${p.camera_backend ? ` · cameras: ${p.camera_backend}` : ''}`);
  if (arms?.length) L.push(`- Arms: ${arms.map((a) => `${a.role} ${a.online ? `online, ${a.joints?.length ?? '?'} motors${a.calibrated ? ', calibrated' : ', not calibrated'}` : 'offline'}`).join(' · ')}`);
  L.push(`- Inspector: recording ${recording ? 'on' : 'off'}, raw bytes ${raw ? 'on' : 'off'}, ${fmtInt(total ?? real.length)} entries captured${dropped ? `, ${fmtInt(dropped)} older ones discarded by the app` : ''}`);
  if (guide) L.push(`- Guide mode: ${guide}`);
  L.push('');
  if (!real.length) { L.push('No entries were recorded (Record was off, or nothing happened yet).'); return L.join('\n') + '\n'; }
  const portName = (port) => { const a = (arms || []).find((x) => x.port === port); return a ? `${a.role} arm` : String(port).split('/').pop(); };
  const rows = groupPolling(real.filter((i) => i.kind !== 'raw'));
  const line = (r) => {
    const it = rowItem(r), g = r.kind === 'group';
    const s = g ? { type: groupType(r), text: groupLabel(r, { multiPort: true, portName }) } : summarize(it), st = g ? groupStatus(r) : statusOf(it);
    return `${fmtRel(it.t, t0).padStart(11)}  ${TYPE_LABEL[s.type].padEnd(7)} ${st.label.padEnd(4)} ${s.text}${!g && st.kind !== 'ok' && st.text && !s.text.includes(st.text) ? `  [${st.text}]` : ''}${!g && it.ms ? `  (${fmtMs(it.ms)})` : ''}`;
  };
  const events = rows.filter((r) => r.kind !== 'group' || (r.cat === 'repeat' && r.count > 0) || (r.cat === 'poll' && r.count === 1 && false));
  const bad = events.filter((r) => (r.kind === 'group' ? groupStatus(r).kind !== 'ok' : statusOf(r.item).kind === 'err'));
  if (bad.length) L.push(`### Errors (${bad.length}${bad.length > 20 ? ', newest 20 shown' : ''})`, '```text', ...bad.slice(-20).map(line), '```', '');
  const last = events.slice(-50);
  L.push(`### Last ${last.length} events (the routine checks that repeat 10 times a second are folded into the last line)`, '```text', ...last.map(line), '```', '');
  const routine = new Map();
  for (const r of rows) if (r.kind === 'group' && r.cat === 'poll') { const k = r.key; const m = routine.get(k); if (!m) routine.set(k, { g: r, n: r.count }); else m.n += r.count; }
  if (routine.size) L.push('Routine traffic folded away: ' + [...routine.values()].map(({ g, n }) => `${groupLabel(g, { multiPort: true, portName }).replace(/ × [\d,]+( \(every [^)]*\))?/, '')} × ${fmtInt(n)}`).slice(0, 6).join('; ') + '.');
  return L.join('\n') + '\n';
}

/* =====================================================================================================================
   Small DOM helpers
   ===================================================================================================================== */

const OWN_ICONS = {
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18"/>',
  lines: '<path d="M5 5h14M5 10h14M5 15h9M5 20h6"/>',
  bits: '<rect x="4" y="5" width="6" height="14" rx="3"/><path d="M16 6v12M13 9l3-3"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3.2"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  gap: '<path d="M4 12h4M16 12h4"/><path d="M10 8l-2 4 2 4M14 8l2 4-2 4"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
};
function own(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ico');
  s.innerHTML = OWN_ICONS[name] || '';
  return s;
}
const TYPE_ICON = (t) => (t === 'bus' ? icon('usb') : t === 'net' ? own('globe') : t === 'raw' ? own('bits') : t === 'gap' ? own('gap') : own('lines'));
const typeChip = (t, bad) => h('span', { class: `tchip t-${t}${bad ? ' bad' : ''}` }, TYPE_ICON(t), h('span', {}, TYPE_LABEL[t]));
const statusBadge = (st) => h('span', { class: `st ${st.kind}` }, icon(st.kind === 'ok' ? 'check' : 'alert'), h('b', {}, st.label));
const kv = (rows) => { const dl = h('dl', { class: 'kv' }); for (const [k, v] of rows) if (v != null && v !== false) dl.append(h('dt', {}, k), h('dd', {}, v)); return dl; };
const code = (s) => h('code', {}, String(s));
const para = (html) => h('p', {}, rich(html));

/** A switch with a label and an optional line saying why it is greyed out. */
function toggle({ label, hint, big = false, checked = false, onChange }) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked, class: 'sw-in' });
  const why = h('small', { class: 'why', hidden: true });
  const el = h('label', { class: 'tg' + (big ? ' big' : '') }, h('span', { class: 'switch' }, input, h('i')),
    h('span', { class: 'tg-text' }, h('b', {}, label), hint ? h('small', { class: 'muted' }, hint) : null, why));
  input.addEventListener('change', () => onChange(input.checked, input));
  return {
    el, input,
    set(v) { input.checked = !!v; },
    lock(reason) { input.disabled = !!reason; el.classList.toggle('off', !!reason); why.hidden = !reason; why.textContent = reason ? `Greyed out: ${reason}` : ''; },
  };
}
/** Grey a button out with a reason, or bring it back (same markup as ui.button). */
function gate(btn, reason) {
  btn.disabled = !!reason; btn.setAttribute('aria-disabled', reason ? 'true' : 'false');
  if (reason) { btn.dataset.why = reason; btn.title = reason; } else { delete btn.dataset.why; btn.removeAttribute('title'); }
}

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

const FILTERS = [
  ['all', 'All', 'Everything that was recorded.'],
  ['bus', 'Bus', 'Bus: the messages the app sends to the motors, and the answers they give.'],
  ['net', 'Network', 'Network: the app’s own web API, the requests this page makes to the program on your computer.'],
  ['log', 'Logs', 'Logs: short notes the app writes about what it is doing.'],
  ['err', 'Errors only', 'Errors only: things that failed. If this list is empty, nothing failed.'],
];
const TABS = [['request', 'Request'], ['response', 'Response'], ['timing', 'Timing'], ['explain', 'Explain'], ['raw', 'Raw']];

/* =====================================================================================================================
   The page
   ===================================================================================================================== */

export default {
  id: 'inspector', title: 'Inspector',
  render(root, ctx) {
    loadCss(new URL('../../css/pages/inspector.css', import.meta.url).href);

    const st = {
      enabled: false, raw: false, loaded: false, unsupported: false, error: '',
      lastSeq: 0, serverDropped: 0, max: 5000, epoch: 0,
      store: [], total: 0, t0: null, counts: { bus: 0, net: 0, log: 0, raw: 0, err: 0 },
      filter: 'all', query: '', group: true, paused: false, viewSeq: 0, domDropped: 0,
      forgot: 0, rawMemo: new Map(), sel: null, selTr: null, tab: ctx.guide === 'expert' ? 'request' : 'explain', stick: true, ports: new Set(),
    };
    const routine = new WeakSet();     // entries that are routine polls (never mutate the backend's objects)
    let grouper = new Grouper({ group: true });
    let rows = [];                 // DOM rows: {kind, tr, kids[], logical?, item?}
    let activeTr = null;
    let dead = false, timer = 0, inflight = false, emptyKind = '';
    const cleanups = [];
    const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); cleanups.push(() => t.removeEventListener(ev, fn, o)); };

    /* ---------- skeleton ---------- */
    const live = h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
    const announce = (m) => { live.textContent = ''; setTimeout(() => { live.textContent = m; }, 30); };

    const intro = h('div', { class: 'card flat insp-intro' },
      h('p', {}, 'The Inspector is like the Network tab of a web browser, but for your arm: it lists what the app says to the motors, what this page asks the app, and the notes the app writes about itself. When something does not work, you can see what was said and what came back.'),
      h('div', { class: 'beginner-only insp-how' },
        h('b', {}, 'How to use it'),
        h('ol', {}, h('li', {}, 'Switch Record on.'), h('li', {}, 'Do the thing that goes wrong (move the arm, press a button).'), h('li', {}, 'Look for lines marked ERR, or press Copy as issue report.'))),
      h('a', { class: 'insp-learn', href: '#/learn/how-it-works' }, icon('book'), 'Learn how the app talks to motors'));

    // Record card
    const recSwitch = toggle({
      label: 'Record', big: true,
      onChange: (v, input) => setRecording(v, input),
    });
    const recState = h('span', { class: 'rec-state' });
    const rawSwitch = toggle({ label: 'Capture raw bytes', hint: 'Shows the exact bytes on the cable.', onChange: (v, input) => setRaw(v, input) });
    const rawWarn = h('p', { class: 'insp-warn' }, icon('alert'), h('span', {}, h('b', {}, 'Noisy. '), 'Every message turns into two more lines (what was sent and what came back), so a connected arm adds hundreds of lines a second. Leave it off unless you are debugging the protocol itself.'));
    const adv = h('details', { class: 'insp-adv' }, h('summary', {}, 'Advanced: raw bytes'), h('div', { class: 'stack-sm' }, rawSwitch.el, rawWarn));
    const recCard = h('div', { class: 'card insp-rec' },
      h('div', { class: 'rec-top' }, recSwitch.el, recState),
      h('p', { class: 'rec-promise' }, 'Records what the app and the motors say to each other. It stays on this computer, in memory (the last 5,000 entries). Nothing is sent anywhere.'),
      adv);

    // Toolbar
    const chipBtns = new Map(), chipCounts = new Map();
    const chipRow = h('div', { class: 'insp-chips', role: 'group', 'aria-label': 'Show only' });
    for (const [id, label] of FILTERS) {
      const cnt = h('span', { class: 'cnt' });
      const b = h('button', { type: 'button', class: 'fchip', 'aria-pressed': id === 'all' ? 'true' : 'false', onclick: () => setFilter(id) }, h('span', {}, label), cnt);
      chipBtns.set(id, b); chipCounts.set(id, cnt); chipRow.append(b);
    }
    const filterHelp = h('p', { class: 'muted insp-help' });
    const search = h('input', { class: 'input insp-search', type: 'search', placeholder: 'Search: motor 3, position, /api/state, timeout…', 'aria-label': 'Search the list' });
    let searchT;
    on(search, 'input', () => { clearTimeout(searchT); searchT = setTimeout(() => { st.query = search.value; rebuild(); }, 160); });
    const searchBox = h('div', { class: 'insp-searchbox' }, own('search'), search);

    const pauseBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => setPaused(!st.paused) });
    const clearBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => doClear() }, own('trash'), 'Clear');
    const groupSwitch = toggle({ label: 'Group polling', hint: 'Fold the routine checks into one line.', checked: true, onChange: (v) => { st.group = v; rebuild(); announce(v ? 'Routine checks are grouped.' : 'Every message is shown.'); } });
    const exportBtn = h('button', { type: 'button', class: 'btn sm', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, own('download'), 'Export');
    const exportMenu = h('div', { class: 'insp-menu', hidden: true, role: 'group', 'aria-label': 'Export format' },
      ...[['json', 'JSON', 'one file, for programs'], ['ndjson', 'NDJSON', 'one line per entry'], ['text', 'Plain text', 'to read or paste']].map(([f, l, d]) =>
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { closeMenu(); doExport(f); } }, h('b', {}, l), h('small', { class: 'muted' }, d))));
    const reportBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => doReport() }, icon('copy'), 'Copy as issue report');
    const whyLine = h('p', { class: 'why insp-why', hidden: true });
    const reportNote = h('p', { class: 'muted insp-help' }, 'Copy as issue report puts a short text on your clipboard: the app version, your computer type, which arms answer, and the last 50 events (errors first). No names, no pictures, nothing you typed. Nothing is sent; you paste it where you ask for help.');
    const reportBox = h('div', { class: 'insp-reportbox', hidden: true });
    const toolbar = h('div', { class: 'card flat insp-toolbar' },
      h('div', { class: 'tb-row' }, chipRow, searchBox),
      filterHelp,
      h('div', { class: 'tb-row' },
        h('div', { class: 'tb-btns' }, pauseBtn, clearBtn, h('div', { class: 'menu-wrap' }, exportBtn, exportMenu), reportBtn),
        groupSwitch.el),
      whyLine, reportNote, reportBox);
    const closeMenu = () => { exportMenu.hidden = true; exportBtn.setAttribute('aria-expanded', 'false'); };
    on(exportBtn, 'click', (e) => { e.stopPropagation(); if (exportBtn.disabled) return; const open = exportMenu.hidden; exportMenu.hidden = !open; exportBtn.setAttribute('aria-expanded', String(open)); if (open) exportMenu.querySelector('button')?.focus(); });
    on(document, 'click', (e) => { if (!exportMenu.hidden && !exportMenu.contains(e.target)) closeMenu(); });

    // Meta line
    const mRec = h('span', { class: 'm-rec' }), mCount = h('span'), mDrop = h('span'), mSrv = h('span'), mPause = h('span', { class: 'm-pause' });
    const meta = h('div', { class: 'insp-meta' }, mRec, mCount, mPause, mDrop, mSrv);

    // Table
    const thead = h('thead', {}, h('tr', { role: 'row' }, ...[['c-time', 'Time'], ['c-type', 'Type'], ['c-sum', 'Summary'], ['c-status', 'Status'], ['c-dur', 'Duration'], ['c-size', 'Size']].map(([c, t]) => h('th', { class: c, scope: 'col', role: 'columnheader' }, t))));
    const tbody = h('tbody', { role: 'rowgroup' });
    const colgroup = h('colgroup', {}, ...['c-time', 'c-type', 'c-sum', 'c-status', 'c-dur', 'c-size'].map((c) => h('col', { class: c })));
    const table = h('table', { class: 'insp-table', role: 'table', 'aria-label': 'Recorded messages, oldest first' }, colgroup, thead, tbody);
    const scroller = h('div', { class: 'insp-scroll', tabindex: '-1' }, table);
    const jump = h('button', { type: 'button', class: 'btn sm primary insp-jump', hidden: true, onclick: () => { scroller.scrollTop = scroller.scrollHeight; st.stick = true; jump.hidden = true; } }, own('down'), 'Jump to latest');
    const emptyBox = h('div', { class: 'insp-empty' });
    const tableWrap = h('div', { class: 'insp-tablewrap', hidden: true }, scroller, jump);

    // Drawer
    const drawerTitle = h('h3', { class: 'dw-title', tabindex: '-1' });
    const closeBtn = h('button', { type: 'button', class: 'btn ghost sm dw-close', 'aria-label': 'Close details', onclick: () => closeDrawer(true) }, icon('x'));
    const tablist = h('div', { class: 'tabs dw-tabs', role: 'tablist', 'aria-label': 'Details' });
    const panel = h('div', { class: 'dw-panel', role: 'tabpanel', tabindex: '0' });
    const drawer = h('aside', { class: 'insp-drawer', hidden: true, 'aria-label': 'Details of the selected line' },
      h('div', { class: 'dw-top' }, h('div', { class: 'dw-head' }, drawerTitle, closeBtn), tablist), panel);
    const scrim = h('div', { class: 'insp-scrim', hidden: true, onclick: () => closeDrawer(true) });
    const mainGrid = h('div', { class: 'insp-main' }, h('div', { class: 'insp-left' }, tableWrap, emptyBox), drawer);

    const footer = h('div', { class: 'card flat tight insp-foot' }, icon('info'),
      h('div', {}, h('b', {}, 'Where do I find this? '),
        'In the left menu under ', h('b', {}, 'Debug'), ', or from ', h('a', { href: '#/test' }, 'Test motors'), ' (when a motor does not answer) and from ', h('a', { href: '#/help' }, 'Help'),
        '. The Inspector’s own requests to read this list are left out, so it never shows itself.'));

    const unsupported = h('div', { class: 'stack', hidden: true }, empty('This version of the app has no Inspector', 'The Inspector needs a newer version of the SO-101 app. Update it, restart the app, then come back here. Everything else keeps working.', button('Back to Home', { href: '#/', icon: 'back' })));
    const body = h('div', { class: 'stack-lg' }, h('div', { class: 'insp-top' }, intro, recCard), h('div', { class: 'stack' }, toolbar, meta, mainGrid));
    root.append(h('div', { class: 'insp' }, pageHead('Debug', 'Inspector', 'See what the app and the motors say to each other, like the Network tab in a browser.'), live, unsupported, body, footer), scrim);

    /* ---------- recording and state ---------- */
    const portName = (p) => { const a = (ctx.state?.arms || []).find((x) => x.port === p); return a ? `${a.role} arm` : String(p).split('/').pop(); };
    const multiPort = () => st.ports.size > 1;

    const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
    let recSig = '';
    function updateRecordUi() {
      const none = st.store.length === 0;
      const sig = [st.enabled, st.raw, st.paused, none].join('|');
      if (sig === recSig) return;                 // only touch the buttons when something they show has changed
      recSig = sig;
      recSwitch.set(st.enabled);
      recState.replaceChildren(h('span', { class: 'dot ' + (st.enabled ? 'bad live' : '') }), st.enabled ? h('b', {}, 'Recording') : h('b', {}, 'Off'), st.enabled ? ' now' : ' (nothing is being recorded)');
      recState.className = 'rec-state' + (st.enabled ? ' on' : '');
      rawSwitch.set(st.raw);
      rawSwitch.lock(st.enabled || st.raw ? '' : 'turn Record on first.');
      if (st.raw) adv.open = true;
      gate(pauseBtn, st.enabled || st.paused ? '' : 'nothing is recording');
      gate(clearBtn, none ? 'there is nothing to clear yet' : '');
      gate(exportBtn, none ? 'nothing has been recorded yet' : '');
      pauseBtn.replaceChildren(st.paused ? icon('play') : own('pause'), st.paused ? 'Resume' : 'Pause');
      pauseBtn.setAttribute('aria-pressed', String(st.paused));
      const why = [];
      if (pauseBtn.dataset.why) why.push(['Pause', pauseBtn.dataset.why]);
      if (clearBtn.dataset.why) why.push(['Clear', clearBtn.dataset.why]);
      if (exportBtn.dataset.why) why.push(['Export', exportBtn.dataset.why]);
      whyLine.hidden = !why.length;
      whyLine.replaceChildren(...why.map(([n, r]) => h('span', {}, h('b', {}, n), ` greyed out: ${r}. `)));
      mRec.className = 'm-rec' + (st.enabled ? ' on' : '');
      setText(mRec, st.enabled ? 'Recording' : 'Recording is off');
    }
    function updateMeta() {
      setText(mCount, `${fmtInt(st.total)} ${st.total === 1 ? 'entry' : 'entries'} seen · ${fmtInt(rows.length)} ${rows.length === 1 ? 'line' : 'lines'} shown`);
      const pending = st.paused ? pendingCount() : 0;
      setText(mPause, st.paused ? `Paused${pending ? `: ${fmtInt(pending)} new waiting` : ''}. Still recording; the view is frozen.` : '');
      setText(mDrop, st.domDropped ? `The view keeps the newest ${fmtInt(MAX_ROWS)} lines; ${fmtInt(st.domDropped)} older ${st.domDropped === 1 ? 'line is' : 'lines are'} no longer shown.` : '');
      setText(mSrv, st.error ? st.error : [st.serverDropped ? `The app keeps ${fmtInt(st.max)} entries; ${fmtInt(st.serverDropped)} older ${st.serverDropped === 1 ? 'one was' : 'ones were'} discarded.` : '', st.forgot ? `To keep errors and events findable, this page forgot ${fmtInt(st.forgot)} older routine checks.` : ''].filter(Boolean).join(' '));
      const sc = st.error ? 'm-err' : ''; if (mSrv.className !== sc) mSrv.className = sc;
      for (const [id, el] of chipCounts) setText(el, id === 'all' ? fmtInt(st.counts.bus + st.counts.net + st.counts.log + st.counts.raw) : id === 'bus' ? fmtInt(st.counts.bus + st.counts.raw) : fmtInt(st.counts[id] || 0));
    }
    function updateEmpty() {
      const hasRows = rows.length > 0;
      let kind = '';
      if (!hasRows) kind = st.store.length === 0 ? (st.enabled ? 'listening' : 'off') : (st.paused && pendingCount() > 0 && !st.viewSeq ? 'paused' : 'nomatch');
      if (tableWrap.hidden === hasRows) tableWrap.hidden = !hasRows;
      if (emptyBox.hidden !== hasRows) emptyBox.hidden = hasRows;
      const armOn = !!(ctx.arm('follower')?.online || ctx.arm('leader')?.online);
      const key = kind + (kind === 'listening' ? String(armOn) : '');
      if (key === emptyKind) return;
      emptyKind = key;
      emptyBox.replaceChildren();
      if (kind === 'off') {
        emptyBox.append(empty('Recording is off', 'Nothing is being recorded, so there is nothing to show yet. Switch Record on, then use the app (move the arm, open Test motors) and the messages appear here.',
          button('Turn on Record', { kind: 'primary', icon: 'play', onClick: () => setRecording(true) })),
        h('div', { class: 'insp-example', 'aria-label': 'Example of what you will see' }, h('b', {}, 'What you will see'),
          ...[['bus', 'Read position of motor 3 → 2048 (+0.0 degrees)', 'The app asked a motor where it is.'], ['net', 'POST /api/calib/0/center → 200', 'This page told the app to do something.'], ['log', 'Follower connected', 'The app wrote a note.']]
            .map(([t, a, b]) => h('div', { class: 'ex' }, typeChip(t), h('div', {}, h('div', { class: 'mono' }, a), h('small', { class: 'muted' }, b))))));
      } else if (kind === 'listening') {
        emptyBox.append(empty('Listening…', armOn ? 'Nothing has been said yet. Move the arm or open another page and the messages appear here.' : 'No arm is connected, so there is no traffic on the motor cable. Requests the page makes to the app and the app’s own notes still appear here.'));
      } else if (kind === 'paused') {
        emptyBox.append(empty('Paused', 'New entries are being recorded but the view is frozen. Press Resume to see them.', h('button', { type: 'button', class: 'btn primary', onclick: () => setPaused(false) }, icon('play'), 'Resume')));
      } else if (kind === 'nomatch') {
        emptyBox.append(empty('Nothing matches', 'Recorded entries exist, but none match this filter or search.', h('button', { type: 'button', class: 'btn', onclick: () => { search.value = ''; st.query = ''; setFilter('all'); } }, 'Show everything')));
      }
    }
    const refresh = () => { updateRecordUi(); updateMeta(); updateEmpty(); };

    // Switch flips are queued, so a second click while the first is still travelling is never dropped.
    let chain = Promise.resolve();
    const queued = (fn) => { chain = chain.then(fn, fn); return chain; };
    function setRecording(v, input) {
      return queued(async () => {
        st.epoch++;
        try {
          const r = await api.post('/api/suite/trace', { enabled: !!v });
          applyStatus(r, true);
          if (typeof r?.enabled !== 'boolean') st.enabled = !!v;
          announce(v ? 'Recording started.' : 'Recording stopped. The list stays here until you clear it.');
          schedule(0);
        } catch (e) {
          if (input) input.checked = !v;
          toast(`<b>Could not ${v ? 'start' : 'stop'} recording.</b> ${e.message}`, 'err');
        } finally { refresh(); }
      });
    }
    function setRaw(v, input) {
      return queued(async () => {
        st.epoch++;
        try { const r = await api.post('/api/suite/trace', { raw: !!v }); applyStatus(r, true); if (typeof r?.raw !== 'boolean') st.raw = !!v; announce(v ? 'Raw bytes on. Expect a lot of lines.' : 'Raw bytes off.'); }
        catch (e) { if (input) input.checked = !v; toast(`<b>Could not change raw bytes.</b> ${e.message}`, 'err'); }
        finally { refresh(); closeIfRawTabGone(); }
      });
    }
    function applyStatus(r, force) {
      if (!r || typeof r !== 'object') return;
      if (typeof r.enabled === 'boolean') st.enabled = r.enabled;
      if (typeof r.raw === 'boolean') st.raw = r.raw;
      if (typeof r.max === 'number') st.max = r.max;
      if (typeof r.dropped === 'number') st.serverDropped = r.dropped;
      if (typeof r.seq === 'number' && r.seq < st.lastSeq && !force) { resetLocal(); st.lastSeq = 0; }
    }
    async function doClear() {
      try { await api.post('/api/suite/trace', { clear: true }); } catch (e) { toast(`<b>Could not clear.</b> ${e.message}`, 'err'); return; }
      resetLocal(); st.serverDropped = 0; st._lastDropped = 0; refresh(); announce('Cleared.');
    }
    function resetLocal() {
      st.store = []; st.forgot = 0; st.total = 0; st.t0 = null; st.counts = { bus: 0, net: 0, log: 0, raw: 0, err: 0 }; st.viewSeq = 0; st.domDropped = 0; st.sel = null; st.selTr = null; st.ports.clear(); st.rawMemo.clear();
      closeDrawer(false); clearView(); refresh();
    }
    function setPaused(v) {
      st.paused = v;
      if (!v) { const fresh = pendingItems(); feed(fresh); }
      refresh(); announce(v ? 'Paused. Still recording.' : 'Resumed.');
    }
    function setFilter(id) {
      st.filter = id;
      for (const [k, b] of chipBtns) b.setAttribute('aria-pressed', String(k === id));
      filterHelp.textContent = FILTERS.find((f) => f[0] === id)[2];
      rebuild();
    }

    /* ---------- polling the trace ---------- */
    function schedule(ms) { clearTimeout(timer); if (!dead) timer = setTimeout(tick, ms); }
    async function tick() {
      if (dead || inflight) return;
      if (document.hidden) { schedule(1000); return; }
      inflight = true;
      try { await pull(); st.error = ''; }
      catch (e) {
        if (e.status === 404 && !st.loaded) { showUnsupported(); inflight = false; return; }
        st.error = e.status === 0 ? 'Cannot reach the app right now. Trying again…' : `The app answered with a problem: ${e.message}`;
      }
      inflight = false;
      updateMeta();
      schedule(st.enabled ? 250 : 2000);
    }
    async function pull() {
      for (let n = 0; n < 12 && !dead; n++) {
        const first = !st.loaded, epoch = st.epoch;
        const r = await api.get(`/api/suite/trace?${first ? '' : `since=${st.lastSeq}&`}limit=${first ? 2000 : FETCH_LIMIT}`);
        if (dead) return;
        st.loaded = true;
        if (epoch === st.epoch) applyStatus(r);
        const items = Array.isArray(r?.items) ? r.items : [];
        if (items.length) ingest(items, r);
        refresh();
        if (items.length < FETCH_LIMIT || first) break;     // keep draining only while the app has more waiting
      }
    }
    function showUnsupported() { st.unsupported = true; unsupported.hidden = false; body.hidden = true; footer.hidden = true; }

    function ingest(items, resp) {
      const out = [];
      const firstSeq = items[0]?.seq;
      if (st.lastSeq && firstSeq > st.lastSeq + 1 && typeof resp?.dropped === 'number' && resp.dropped > (st._lastDropped ?? resp.dropped)) {
        out.push({ kind: 'gap', seq: firstSeq - 0.5, t: items[0].t, ok: true, ms: 0, missed: firstSeq - st.lastSeq - 1, max: st.max });
      }
      st._lastDropped = resp?.dropped;
      for (const it of items) {
        if (typeof it.seq === 'number') st.lastSeq = Math.max(st.lastSeq, it.seq);
        if (isOwn(it)) continue;                    // the Inspector reading this list is never shown
        out.push(it);
      }
      for (const it of out) {
        if (it.kind === 'gap') continue;
        st.total++; if (st.t0 == null) st.t0 = it.t;
        const t = typeOf(it); st.counts[t] = (st.counts[t] || 0) + 1; if (isError(it)) st.counts.err++;
        if (it.port) st.ports.add(it.port);
      }
      for (const it of out) if (it.kind !== 'gap' && famOf(it, st.rawMemo)?.cat === 'poll') routine.add(it);
      st.store.push(...out);
      trimStore();
      if (!st.paused) feed(pendingItems());
    }
    /** Keep the newest STORE_CAP entries, but forget routine polls first so errors and events stay findable. */
    function trimStore() {
      if (st.store.length <= STORE_CAP + 400) return;
      let excess = st.store.length - STORE_CAP;
      const keep = [];
      for (const it of st.store) { if (excess > 0 && routine.has(it)) { excess--; st.forgot++; continue; } keep.push(it); }
      if (excess > 0) keep.splice(0, excess);
      st.store = keep;
    }
    function pendingItems() {
      const s = st.store; let i = s.length;
      while (i > 0 && s[i - 1].seq > st.viewSeq) i--;
      return i === s.length ? [] : s.slice(i);
    }
    const pendingCount = () => pendingItems().length;

    /* ---------- the table ---------- */
    const passes = (it) => {
      if (it.kind === 'gap') return st.filter === 'all' && !st.query;
      switch (st.filter) {
        case 'bus': if (it.kind !== 'bus' && it.kind !== 'raw') return false; break;
        case 'net': if (it.kind !== 'http') return false; break;
        case 'log': if (it.kind !== 'log') return false; break;
        case 'err': if (!isError(it)) return false; break;
        default:
      }
      return matches(it, st.query);
    };
    const t0 = () => st.t0 ?? 0;

    function cell(cls, ...kids) { return h('td', { class: cls, role: 'cell' }, ...kids); }
    function durCell(it, avgMs) {
      const ms = avgMs ?? it.ms;
      if (it.kind === 'log' || it.kind === 'gap' || !ms) return cell('c-dur', h('span', { class: 'faint' }, '—'));
      const slow = isSlow({ kind: it.kind, ms });
      return cell('c-dur' + (slow ? ' slow' : ''), h('span', { class: 'ms' }, fmtMs(ms)), h('span', { class: 'dbar', 'aria-hidden': 'true' }, h('i', { style: { width: `${(barFrac({ kind: it.kind, ms }) * 100).toFixed(0)}%` } })), slow ? h('span', { class: 'slow-tag' }, 'slow') : null);
    }
    function statusCell(stt) {
      return cell('c-status', statusBadge(stt), stt.text ? h('span', { class: 'st-text', title: stt.text }, stt.text) : null);
    }
    function timeCell(it) {
      const clk = fmtClock(it.t), tip = clk ? `${clk} (clock time)` : `${fmtRel(it.t, t0())} after the first entry`;
      return h('td', { class: 'c-time', role: 'cell', title: tip }, h('time', {}, fmtRel(it.t, t0())));
    }

    function itemTr(it, { sub = false } = {}) {
      const s = summarize(it), stt = statusOf(it), bad = stt.kind === 'err';
      const tr = h('tr', { class: `r t-${s.type}${bad ? ' bad' : stt.kind === 'warn' ? ' warnrow' : ''}${sub ? ' sub' : ''}${st.sel === it.seq ? ' sel' : ''}`, role: 'row', tabindex: '-1', 'data-nav': '1', 'data-seq': String(it.seq) });
      if (it.kind === 'gap') {
        tr.className = 'r gaprow'; tr.append(cell('c-time', ''), cell('c-type', typeChip('gap')), h('td', { class: 'c-sum', role: 'cell', colspan: '4' }, s.text));
        tr.removeAttribute('data-nav'); tr.removeAttribute('tabindex');
        return { tr };
      }
      tr.append(timeCell(it), cell('c-type', typeChip(s.type, bad)), cell('c-sum', h('span', { class: 'sum', title: s.text }, s.text)), statusCell(stt), durCell(it), cell('c-size', sizeOf(it) != null ? fmtBytes(sizeOf(it)) : h('span', { class: 'faint' }, '—')));
      return { tr, item: it };
    }

    function groupTr(g) {
      const dom = { tr: h('tr', { role: 'row', tabindex: '-1', 'data-nav': '1' }), kids: [], logical: g, expanded: false, refs: {} };
      fillGroup(dom, g, true);
      return dom;
    }
    function fillGroup(dom, g, force) {
      const single = g.count === 1;
      if (single) {                               // a lone poll is just a normal row until a second one arrives
        const r = itemTr(g.first);
        dom.tr.className = r.tr.className; dom.tr.replaceChildren(...r.tr.childNodes); dom.tr.dataset.seq = String(g.first.seq); dom.item = g.first; dom.mode = 'single';
        dom.tr.removeAttribute('aria-expanded');
        return;
      }
      if (dom.mode !== 'group' || force) {
        dom.mode = 'group'; dom.item = null; delete dom.tr.dataset.seq;
        const stt = groupStatus(g), ty = groupType(g), refs = dom.refs;
        refs.label = h('span', { class: 'glabel' }); refs.detail = h('small', { class: 'gdetail muted' });
        refs.ms = h('span', { class: 'ms' }); refs.bar = h('i'); refs.size = cell('c-size'); refs.chev = icon('chevron', { cls: 'gchev' });
        dom.tr.className = `r grp t-${ty}${stt.kind === 'err' ? ' bad' : stt.kind === 'warn' ? ' warnrow' : ''}${dom.expanded ? ' open' : ''}`;
        dom.tr.setAttribute('aria-expanded', String(!!dom.expanded));
        dom.tr.replaceChildren(timeCell(g.first), cell('c-type', typeChip(ty, stt.kind === 'err')), cell('c-sum', refs.chev, h('span', { class: 'gtext' }, refs.label, refs.detail)),
          statusCell(stt), cell('c-dur', refs.ms, h('span', { class: 'dbar', 'aria-hidden': 'true' }, refs.bar)), refs.size);
      }
      const refs = dom.refs, label = groupLabel(g, { multiPort: multiPort(), portName });
      if (refs.label.textContent !== label) { refs.label.textContent = label; dom.tr.querySelector('.gtext').title = label; }
      refs.detail.textContent = groupDetail(g);
      const avg = g.msSum / Math.max(1, g.count);
      refs.ms.textContent = fmtMs(avg) + ' avg'; refs.bar.style.width = `${(barFrac({ kind: g.fam === 'http' ? 'http' : 'bus', ms: avg }) * 100).toFixed(0)}%`;
      refs.size.textContent = fmtBytes(g.bytes);
    }
    function toggleGroup(dom, want) {
      const g = dom.logical; if (!g || dom.mode !== 'group') return;
      const open = want ?? !dom.expanded;
      if (open === dom.expanded) return;
      dom.expanded = open;
      dom.tr.classList.toggle('open', open); dom.tr.setAttribute('aria-expanded', String(open));
      dom.kids.forEach((k) => k.remove()); dom.kids = [];
      if (!open) return;
      const note = h('tr', { class: 'r grp-note', role: 'row' }, h('td', { role: 'cell', colspan: '6' }, GROUP_NOTE(g)));
      const kids = [note, ...g.members.slice(-60).map((m) => itemTr(m, { sub: true }).tr)];
      let after = dom.tr; for (const k of kids) { after.after(k); after = k; }
      dom.kids = kids; dom.noteKid = note;
    }
    const GROUP_NOTE = (g) => rich(`<b>These repeat on their own, so they are folded into one line.</b> ${groupDetail(g)} Showing the last ${Math.min(60, g.members.length)} of ${fmtInt(g.count)}. Turn off <b>Group polling</b> to see all of them.`);
    function growKids(dom, it) {
      if (!dom.expanded || dom.mode !== 'group') return;
      const k = itemTr(it, { sub: true }).tr, last = dom.kids[dom.kids.length - 1] || dom.tr;
      last.after(k); dom.kids.push(k);
      while (dom.kids.length > 61) dom.kids.splice(1, 1)[0].remove();
      const msg = dom.noteKid?.querySelector('td'); if (msg) msg.replaceChildren(GROUP_NOTE(dom.logical));
    }

    function feed(items) {
      if (!items.length) return;
      const frag = document.createDocumentFragment(), touched = new Set();
      const keepStick = st.stick;
      for (const it of items) {
        if (typeof it.seq === 'number') st.viewSeq = Math.max(st.viewSeq, it.seq);
        if (!passes(it)) continue;
        const { row, isNew } = grouper.push(it);
        if (row.kind === 'group') {
          if (isNew) { const dom = groupTr(row); row.dom = dom; rows.push(dom); frag.append(dom.tr); }
          else { touched.add(row); growKids(row.dom, it); }
        } else {
          const dom = itemTr(it); dom.kids = []; rows.push(dom); frag.append(dom.tr);
        }
      }
      tbody.append(frag);
      for (const g of touched) fillGroup(g.dom, g, false);
      trimRows();
      afterAppend(keepStick);
    }
    function trimRows() {
      if (rows.length <= MAX_ROWS + 100) return;
      const drop = rows.splice(0, rows.length - MAX_ROWS);
      for (const d of drop) { d.tr.remove(); d.kids?.forEach((k) => k.remove()); st.domDropped++; if (d.logical) grouper.forget(d.logical); }
    }
    function afterAppend(keepStick) {
      if (!activeTr?.isConnected) { const last = [...rows].reverse().find((r) => r.tr.dataset.nav); if (last) setActive(last.tr, false); }
      updateEmpty(); updateMeta();
      if (keepStick) scroller.scrollTop = scroller.scrollHeight;
    }
    function clearView() { tbody.replaceChildren(); rows = []; activeTr = null; grouper = new Grouper({ group: st.group }); st.domDropped = 0; st.selTr = null; }
    function rebuild() {
      const keep = st.sel;
      clearView();
      let list = st.store.filter((it) => it.seq <= st.viewSeq && passes(it));
      let dropped = 0;
      if (!st.group && list.length > MAX_ROWS) { dropped = list.length - MAX_ROWS; list = list.slice(-MAX_ROWS); }
      st.stick = true;
      feedRaw(list);
      st.domDropped += dropped;
      if (keep != null) { const dom = rows.find((r) => r.item?.seq === keep); if (dom) { dom.tr.classList.add('sel'); st.selTr = dom.tr; } }
      refresh();
      scroller.scrollTop = scroller.scrollHeight;
    }
    /** like feed(), but the items are already filtered */
    function feedRaw(list) {
      const frag = document.createDocumentFragment(), touched = new Set();
      for (const it of list) {
        const { row, isNew } = grouper.push(it);
        if (row.kind === 'group') { if (isNew) { const dom = groupTr(row); row.dom = dom; rows.push(dom); frag.append(dom.tr); } else { touched.add(row); } }
        else { const dom = itemTr(it); dom.kids = []; rows.push(dom); frag.append(dom.tr); }
      }
      tbody.append(frag);
      for (const g of touched) fillGroup(g.dom, g, false);
      trimRows();
      const last = [...rows].reverse().find((r) => r.tr.dataset.nav); if (last) setActive(last.tr, false);
    }

    /* keyboard + mouse on the table */
    function setActive(tr, focus = true) {
      if (activeTr && activeTr !== tr) activeTr.tabIndex = -1;
      activeTr = tr; tr.tabIndex = 0;
      if (focus) { tr.focus({ preventScroll: false }); tr.scrollIntoView({ block: 'nearest' }); }
    }
    const domOf = (tr) => rows.find((r) => r.tr === tr) || null;
    function activate(tr) {
      const dom = domOf(tr);
      if (!dom) { // a sub row of a group
        const seq = Number(tr.dataset.seq); const it = st.store.find((x) => x.seq === seq); if (it) openItem(it, tr); return;
      }
      if (dom.mode === 'group') { toggleGroup(dom); return; }
      if (dom.item) openItem(dom.item, tr);
    }
    on(tbody, 'click', (e) => { const tr = e.target.closest('tr[data-nav]'); if (!tr) return; setActive(tr, false); activate(tr); });
    on(tbody, 'keydown', (e) => {
      const tr = e.target.closest('tr[data-nav]'); if (!tr || e.target !== tr) return;
      const step = (from, dir) => { let n = dir > 0 ? from.nextElementSibling : from.previousElementSibling; while (n && !n.dataset.nav) n = dir > 0 ? n.nextElementSibling : n.previousElementSibling; return n; };
      let to = null;
      if (e.key === 'ArrowDown') to = step(tr, 1) || tr;
      else if (e.key === 'ArrowUp') to = step(tr, -1) || tr;
      else if (e.key === 'PageDown') { to = tr; for (let i = 0; i < 10; i++) to = step(to, 1) || to; }
      else if (e.key === 'PageUp') { to = tr; for (let i = 0; i < 10; i++) to = step(to, -1) || to; }
      else if (e.key === 'Home') { to = [...tbody.querySelectorAll('tr[data-nav]')][0]; }
      else if (e.key === 'End') { const all = tbody.querySelectorAll('tr[data-nav]'); to = all[all.length - 1]; }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(tr); return; }
      else if (e.key === 'ArrowRight') { const d = domOf(tr); if (d?.mode === 'group') { e.preventDefault(); toggleGroup(d, true); } return; }
      else if (e.key === 'ArrowLeft') { const d = domOf(tr); if (d?.mode === 'group') { e.preventDefault(); toggleGroup(d, false); } return; }
      else if (e.key === 'Escape' && !drawer.hidden) { closeDrawer(true); return; }
      else return;
      e.preventDefault();
      if (to && to !== tr) {
        setActive(to, true);
        if (!drawer.hidden) { const seq = Number(to.dataset.seq); const it = to.dataset.seq ? st.store.find((x) => x.seq === seq) : null; if (it) showDetails(it, false); }
      }
    });
    on(scroller, 'scroll', () => { const at = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 28; st.stick = at; jump.hidden = at; }, { passive: true });

    /* ---------- the drawer ---------- */
    let openedFrom = null;
    function openItem(it, tr) {
      if (st.selTr && st.selTr !== tr) st.selTr.classList.remove('sel');
      st.sel = it.seq; st.selTr = tr; tr.classList.add('sel'); openedFrom = tr;
      showDetails(it, true);
    }
    function closeDrawer(refocus) {
      if (drawer.hidden && scrim.hidden) return;
      drawer.hidden = true; scrim.hidden = true; mainGrid.classList.remove('has-drawer');
      st.sel = null; if (st.selTr) { st.selTr.classList.remove('sel'); }
      st.selTr = null;
      if (refocus && openedFrom?.isConnected) { setActive(openedFrom, true); }
    }
    function closeIfRawTabGone() { if (!drawer.hidden && st.tab === 'raw' && !rawTabAvailable(curItem)) { st.tab = 'explain'; if (curItem) showDetails(curItem, false); } }
    let curItem = null;
    const rawTabAvailable = (it) => !!it && (st.raw || it.kind === 'raw');

    function idxOfSeq(seq) { const s = st.store; let lo = 0, hi = s.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid].seq === seq) return mid; if (s[mid].seq < seq) lo = mid + 1; else hi = mid - 1; } return -1; }
    /** the raw packets that belong to a bus entry (they are recorded right after it), or the partner of a raw packet */
    function rawPair(it) {
      const i = idxOfSeq(it.seq); if (i < 0) return null;
      const near = (from, to) => { const out = []; for (let k = Math.max(0, from); k <= Math.min(st.store.length - 1, to); k++) if (st.store[k].kind === 'raw' && st.store[k].port === it.port) out.push(st.store[k]); return out; };
      if (it.kind === 'bus') {
        const cand = near(i - 3, i + 4), tx = cand.find((c) => c.dir === 'tx' && (() => { const p = parsePackets(hexBytes(c.hex)).packets[0]; return p && p.id === it.id && (it.op === 'ping' ? p.code === 1 : isRead(it.op) ? p.code === 2 && p.params[0] === it.addr : p.code === 3 && p.params[0] === it.addr); })());
        if (!tx) return null;
        return { tx, rx: cand.find((c) => c.dir === 'rx' && c.seq > tx.seq) || null };
      }
      if (it.kind === 'raw') {
        const cand = near(i - 3, i + 3);
        return it.dir === 'tx' ? { tx: it, rx: cand.find((c) => c.dir === 'rx' && c.seq > it.seq) || null } : { tx: [...cand].reverse().find((c) => c.dir === 'tx' && c.seq < it.seq) || null, rx: it };
      }
      return null;
    }
    function typical(it) {
      const sig = (x) => (x.kind === 'bus' ? `${x.kind}|${x.op}|${x.addr}` : x.kind === 'http' ? `${x.kind}|${x.method}|${x.path}` : null);
      const k = sig(it); if (!k) return null;
      const v = []; for (let i = st.store.length - 1; i >= 0 && v.length < 400; i--) { const x = st.store[i]; if (x.ok !== false && sig(x) === k && x.ms != null) v.push(+x.ms); }
      if (v.length < 5) return null;
      v.sort((a, b) => a - b); return { median: v[v.length >> 1], n: v.length };
    }

    function showDetails(it, focus) {
      curItem = it;
      const s = summarize(it);
      drawer.hidden = false; mainGrid.classList.add('has-drawer');
      scrim.hidden = false;
      drawerTitle.replaceChildren(typeChip(s.type, statusOf(it).kind === 'err'), h('span', { class: 'dw-sum' }, s.text));
      const tabs = TABS.filter(([id]) => id !== 'raw' || rawTabAvailable(it));
      if (!tabs.some(([id]) => id === st.tab)) st.tab = 'explain';
      tablist.replaceChildren(...tabs.map(([id, label]) => h('button', { type: 'button', class: 'tab', role: 'tab', id: `ins-tab-${id}`, 'aria-selected': String(id === st.tab), 'aria-controls': 'ins-panel', tabindex: id === st.tab ? '0' : '-1', onclick: () => { st.tab = id; showDetails(it, false); document.getElementById(`ins-tab-${id}`)?.focus(); } }, label)));
      panel.id = 'ins-panel'; panel.setAttribute('aria-labelledby', `ins-tab-${st.tab}`);
      panel.replaceChildren(buildPanel(st.tab, it));
      if (focus) drawerTitle.focus({ preventScroll: true });
    }
    on(tablist, 'keydown', (e) => {
      const tabs = [...tablist.querySelectorAll('[role=tab]')], i = tabs.indexOf(document.activeElement); if (i < 0) return;
      let n = -1;
      if (e.key === 'ArrowRight') n = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length; else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1; else return;
      e.preventDefault(); tabs[n].click();
    });
    on(drawer, 'keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeDrawer(true); } });

    function buildPanel(tab, it) {
      if (it.kind === 'gap') return h('div', { class: 'stack-sm' }, para(`<b>${fmtInt(it.missed)} entries are missing here.</b> The app only keeps its newest ${fmtInt(it.max || 5000)} entries. While this page was in the background, or while the arm was very busy, more arrived than fit. Nothing is wrong with your arm; to keep more, leave this page open and use Group polling.`));
      switch (tab) {
        case 'request': return panelRequest(it);
        case 'response': return panelResponse(it);
        case 'timing': return panelTiming(it);
        case 'raw': return panelRaw(it);
        default: return panelExplain(it);
      }
    }
    const hexBlock = (bytes) => h('div', { class: 'hexbox' }, h('code', { class: 'hex', tabindex: '0', 'aria-label': 'Bytes in hexadecimal' }, spaced(bytes) || '(no bytes)'), h('button', { type: 'button', class: 'btn sm', 'aria-label': 'Copy these bytes', onclick: () => copyText(spaced(bytes), 'Bytes copied.') }, icon('copy'), 'Copy'));
    const posBar = (v) => (v >= 0 && v <= 4095 ? h('div', { class: 'posbar', role: 'img', 'aria-label': `Position ${v} of 4095. The middle (2048) is 0 degrees.` }, h('div', { class: 'jbar' }, h('span', { class: 'dotv', style: { left: `${(v / 4095) * 100}%` } })), h('small', { class: 'muted' }, '0 · middle (2048) is 0 degrees · 4095')) : null);

    function panelRequest(it) {
      if (it.kind === 'bus') {
        const r = regOf(it), op = OPS[it.op];
        return h('div', { class: 'stack-sm' }, kv([
          ['Where', h('span', {}, term('bus', 'Bus'), ' (the motor cable)')],
          ['Port', it.port ? code(it.port) : null],
          ['Operation', op ? op.label : it.op],
          [h('span', {}, term('motor-id', 'Motor ID')), `${it.id}${jointOf(it.id) ? ` · ${jointOf(it.id)}` : ''}`],
          ['Register', it.op === 'ping' ? null : h('span', {}, `${it.addr ?? '?'} · `, code(r?.name || it.reg || 'unknown'), r ? ` · ${r.size} byte${r.size === 1 ? '' : 's'}` : '')],
          ['Meaning', r ? r.what : null],
          [isWrite(it.op) ? 'Value to write' : null, isWrite(it.op) && it.value != null ? describeValue(r?.addr ?? it.addr, it.value).text : null],
        ]), op ? h('p', { class: 'muted' }, op.long) : null);
      }
      if (it.kind === 'http') return h('div', { class: 'stack-sm' }, kv([['Where', 'Network (the app’s own web API)'], ['Method', code(it.method)], ['Path', code(it.path)]]), h('p', { class: 'muted' }, 'Only the method, the path and the status are recorded. What was inside the request, and any pictures, are never stored.'));
      if (it.kind === 'log') return h('div', { class: 'stack-sm' }, kv([['Where', 'The app’s own notes'], ['Level', it.level || 'info'], ['From', it.source ? code(it.source) : null], ['Message', it.msg]]), h('p', { class: 'muted' }, 'A log line is a note, not a request, so there is no response to look at.'));
      if (it.kind === 'raw') return h('div', { class: 'stack-sm' }, kv([['Where', h('span', {}, term('bus', 'Bus'), ' (raw bytes)')], ['Direction', it.dir === 'tx' ? 'App → motors (TX): sent' : 'Motors → app (RX): received'], ['Port', it.port ? code(it.port) : null], ['Length', `${hexBytes(it.hex).length} bytes`]]), hexBlock(hexBytes(it.hex)));
      return h('div');
    }
    function panelResponse(it) {
      const stt = statusOf(it);
      if (it.kind === 'bus') {
        const r = regOf(it), d = it.value != null ? describeValue(r?.addr ?? it.addr, it.value) : null;
        const ex = it.ok === false ? explainError(it.err) : null;
        return h('div', { class: 'stack-sm' }, kv([
          ['Result', h('span', { class: `st ${stt.kind}` }, icon(stt.kind === 'ok' ? 'check' : 'alert'), h('b', {}, stt.label), stt.text ? ` ${stt.text}` : '')],
          ['Value', isRead(it.op) && d ? `${d.raw} → ${d.text}` : null],
          ['Motor said', it.op === 'ping' ? (it.ok === false ? 'Nothing.' : 'Yes, I am here.') : isWrite(it.op) ? (it.ok === false ? 'Nothing usable.' : 'Got it (acknowledged).') : null],
          ['Fault flags', r?.addr === 65 && it.ok !== false ? faultText(Number(it.value) & 63) : null],
        ]), isRead(it.op) && r && (r.addr === 56 || r.addr === 42) && it.ok !== false ? posBar(Number(it.value)) : null,
        ex ? callout('warn', ex.text, ex.title) : null,
        r?.addr === 65 && Number(it.value) & 63 ? h('div', { class: 'stack-sm' }, ...faultsOf(Number(it.value) & 63).map((f) => callout('warn', f.plain, `${f.label} fault`))) : null);
      }
      if (it.kind === 'http') return h('div', { class: 'stack-sm' }, kv([['Status', h('span', { class: `st ${stt.kind}` }, icon(stt.kind === 'ok' ? 'check' : 'alert'), h('b', {}, `${it.status ?? '?'}`), ` ${STATUS_TEXT[it.status] || ''}`)], ['Size', it.size != null ? `${fmtBytes(it.size)} (${fmtInt(it.size)} bytes)` : null]]), h('p', { class: 'muted' }, 'The text of the answer is not stored. Only the status and size are.'));
      if (it.kind === 'log') return h('div', { class: 'stack-sm' }, para('Logs have no response. This was only a note.'));
      if (it.kind === 'raw') { const pair = rawPair(it), other = it.dir === 'tx' ? pair?.rx : pair?.tx; return h('div', { class: 'stack-sm' }, other ? kv([[it.dir === 'tx' ? 'The motor answered' : 'This answers', hexBlock(hexBytes(other.hex))]]) : para(it.dir === 'tx' ? 'No matching answer was recorded (the motor did not reply, or it is not in the list yet).' : 'The question that led to this answer was not found in the list.')); }
      return h('div');
    }
    function panelTiming(it) {
      const ty = typical(it), clk = fmtClock(it.t);
      return h('div', { class: 'stack-sm' }, kv([
        ['Started', `${fmtRel(it.t, t0())} after the first entry${clk ? ` (clock ${clk})` : ''}`],
        ['Duration', it.kind === 'log' ? 'Notes take no time.' : it.ms != null ? `${fmtMs(it.ms)}${isSlow(it) ? ' (slow)' : ''}` : null],
        ['Typical', ty ? `${fmtMs(ty.median)} (middle value of the last ${ty.n} similar OK entries)` : null],
        ['Size', sizeOf(it) != null ? `${fmtBytes(sizeOf(it))}${it.kind === 'bus' && it.size == null ? ' (message out + reply, from the protocol)' : ''}` : null],
        ['Entry number', `#${it.seq}`],
      ]), it.kind === 'bus' ? para(isSlow(it) ? `<b>That is slow for the bus.</b> A normal read takes a couple of milliseconds. A long wait usually means the motor did not answer and the app waited for it.` : 'A normal read or write on the motor cable takes a couple of milliseconds, so this one is fine.') : it.kind === 'http' ? para(isSlow(it) ? '<b>That took a while.</b> Requests to the app are usually a few milliseconds.' : 'Requests to the app are usually a few milliseconds, so this one is fine.') : null);
    }
    function panelExplain(it) {
      const parts = explainEntry(it).map((x) => para(x));
      const stt = statusOf(it);
      const isBad = stt.kind !== 'ok';
      const kinds = [];
      if (it.kind === 'bus') kinds.push(h('p', { class: 'muted' }, 'Words you may meet: ', term('motor-id', 'motor ID'), ', ', term('bus', 'bus'), ', ', term('encoder-ticks', 'ticks'), ', ', term('torque', 'torque'), ', ', term('load', 'load'), '.'));
      return h('div', { class: 'stack-sm explain' }, ...parts, ...kinds,
        isBad && (it.kind === 'bus' || it.kind === 'raw') ? h('div', { class: 'row' }, button('Open Test motors', { href: '#/test', icon: 'arrow', size: 'sm' }), button('Open Help', { href: '#/help', kind: 'ghost', size: 'sm' })) : null);
    }
    function panelRaw(it) {
      const pair = rawPair(it);
      const blocks = [];
      const part = (label, item) => {
        if (!item) return null;
        const bytes = hexBytes(item.hex), { packets, stray } = parsePackets(bytes);
        const hint = item.dir === 'rx' && pair?.tx ? { addr: parsePackets(hexBytes(pair.tx.hex)).packets[0]?.params?.[0] } : {};
        const rowsD = packets.flatMap((p) => describePacket(p, item.dir, hint));
        return h('section', { class: 'rawpart' }, h('h4', {}, label), hexBlock(bytes),
          rowsD.length ? h('table', { class: 'kvt' }, h('thead', {}, h('tr', {}, h('th', {}, 'Bytes'), h('th', {}, 'Field'), h('th', {}, 'Meaning'))), h('tbody', {}, ...rowsD.map((r) => h('tr', {}, h('td', {}, code(r.bytes || '—')), h('td', {}, r.field), h('td', {}, r.meaning))))) : h('p', { class: 'muted' }, 'These bytes do not look like a Feetech message (they should start with ff ff).'),
          stray.length ? h('p', { class: 'muted' }, `${stray.length} extra byte${stray.length === 1 ? '' : 's'} outside any message: ${spaced(stray)}`) : null);
      };
      if (it.kind === 'raw') blocks.push(part(it.dir === 'tx' ? 'Sent by the app (TX)' : 'Received from the motor (RX)', it), pair && (it.dir === 'tx' ? pair.rx : pair.tx) ? part(it.dir === 'tx' ? 'The motor’s answer (RX)' : 'The question (TX)', it.dir === 'tx' ? pair.rx : pair.tx) : null);
      else if (pair) blocks.push(part('Sent by the app (TX)', pair.tx), part('The motor’s answer (RX)', pair.rx));
      else blocks.push(para('<b>No raw bytes were found for this line.</b> Raw bytes are recorded only while the Advanced switch is on, and only for messages sent after you switched it on.'));
      return h('div', { class: 'stack-sm' }, ...blocks.filter(Boolean), h('p', { class: 'muted' }, 'A Feetech message is: ff ff, the motor ID, the length, an instruction (or error flags in a reply), parameters, and a checksum.'));
    }

    /* ---------- export and report ---------- */
    async function copyText(text, okMsg) {
      try { await navigator.clipboard.writeText(text); toast(okMsg || 'Copied.', 'ok', 2200); return true; }
      catch { return false; }
    }
    async function doExport(format) {
      const meta = { json: ['application/json', 'json'], ndjson: ['application/x-ndjson', 'ndjson'], text: ['text/plain', 'txt'] }[format];
      let text = '';
      try {
        const path = `/api/suite/trace/export?format=${format}`;
        if (api.demo) { const out = await api.get(path); text = typeof out === 'string' ? out : JSON.stringify(out, null, 2); }
        else { const r = await fetch(path); if (!r.ok) throw new Error(`The app answered ${r.status}`); text = await r.text(); }
      } catch (e) { toast(`<b>Could not export.</b> ${e.message}`, 'err'); return; }
      if (!text.trim()) { toast('There is nothing to export yet. Record something first.', 'warn'); return; }
      const name = `so101-trace-${stamp()}.${meta[1]}`;
      download(name, text, meta[0]);
      toast(`<b>Saved ${name}.</b> It is a file on your computer; nothing was sent anywhere.`, 'ok');
    }
    async function doReport() {
      reportBtn.disabled = true;
      try {
        let info = ctx.info, platform = null;
        try { info = await api.get('/api/suite/info'); } catch { /* use what we have */ }
        try { platform = await api.get('/api/suite/platform'); } catch { /* the report says unknown */ }
        const text = buildReport({ info, platform, items: st.store, total: st.total, arms: ctx.state?.arms, recording: st.enabled, raw: st.raw, dropped: st.serverDropped, t0: t0(), guide: ctx.guide });
        if (await copyText(text, 'Issue report copied. Paste it where you ask for help.')) { reportBox.hidden = true; announce('Issue report copied.'); }
        else {
          const ta = h('textarea', { class: 'input', readonly: true, rows: '12', 'aria-label': 'Issue report text', spellcheck: 'false' }); ta.value = text;
          reportBox.replaceChildren(callout('warn', 'The browser would not copy automatically. Select all the text below and copy it yourself.', 'Copy it by hand'), ta, h('button', { type: 'button', class: 'btn sm', onclick: () => { reportBox.hidden = true; } }, 'Close'));
          reportBox.hidden = false; ta.focus(); ta.select();
        }
      } catch (e) { toast(`<b>Could not build the report.</b> ${e.message}`, 'err'); }
      finally { reportBtn.disabled = false; }
    }

    /* ---------- go ---------- */
    setFilter('all');
    refresh();
    on(document, 'visibilitychange', () => { if (!document.hidden) schedule(0); });
    on(document, 'keydown', (e) => { if (e.key === 'Escape' && !exportMenu.hidden) { closeMenu(); exportBtn.focus(); } });
    schedule(0);

    return () => {
      dead = true; clearTimeout(timer); clearTimeout(searchT);
      cleanups.forEach((f) => f());
      scrim.remove();
    };
  },
};
