// The owner's standing safety rule, as code: NEVER ask a person to touch, hold, place or move anything near the arm while it is STIFF
// (torque on, holding, moving). Make it limp first, LOWERED, then ask. Seen on 2026-10-30: the owner was asked to hold a keychain between
// the fingers of an arm that was powered and holding, and said "the robot is too stiff, never ask me to do anything when the robot is stiff".
// (docs/LEARNINGS.md section 17, docs/design/physical-instructions.md rule 13.)
//
//   limpState(ctx)           'limp' | 'stiff' | 'unknown'   from the REAL state: /api/state -> pp.limp (the follower; the leader is limp by design)
//   ensureLimp(ctx, {onStatus})   POST /api/pp/rest (lowers the follower onto the table, THEN lets go), waits until pp.limp is true -> {ok, message}
//   limpCard(ctx, {title, then})  a calm card: the state, 'Lower the arm and make it limp', and a 'Next' that only works when limp
//
// Never use a bare POST /api/pp/release, or start a calibration, to prepare a person's step: both switch the torque off at once and drop a raised arm.
import { h, icon, rich, button, askYes, toast, safe, loadCss } from './ui.js';

loadCss(new URL('../css/limp.css', import.meta.url).href);

export const LIMP_WAIT_MS = 40000;          // give up waiting for the arm to go limp after this long
export const HELP_HREF = '#/help';
export const HANDS_OFF = 'Hands off the arm now.';
export const STATE_TEXT = {
  limp: 'The arm is limp.',
  stiff: 'The arm is stiff right now: it is holding itself.',
  unknown: 'Checking whether the arm is limp…',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The real state, never a guess. 'limp' when the follower's torque is off or there is no follower at all. */
export function limpState(ctx) {
  const s = ctx?.state;
  if (!s || ctx.offline) return 'unknown';
  const pp = s.pp;
  if (pp && typeof pp.limp === 'boolean') return pp.limp ? 'limp' : 'stiff';
  return ctx.arm('follower') ? 'unknown' : 'limp';
}

/** Why the app cannot lower the arm right now ('' when it can). Same reasons the server would refuse for. */
export function whyCannotLower(ctx) {
  const pp = ctx.state?.pp, f = ctx.arm('follower');
  if (!ctx.state || ctx.offline) return 'The app lost its connection';
  if (!pp) return 'The arm engine is not running in this app';
  if (!f) return 'No follower arm found yet';
  if (f.remote) return 'The follower arm is on another computer: use the app there';
  if (!f.online) return 'The follower arm is not connected';
  if (!f.calibrated) return 'The follower arm is not calibrated yet';
  if (pp.running) return 'A job is running: press STOP first';
  if (ctx.state.teleop?.on) return 'Leader to follower is running: press STOP first';
  return '';
}

/** What to say when the arm is stiff and the app cannot lower it: plain, no advice to hold it or to cut its power. */
export const stiffAdvice = (why) => `The arm is stiff and the app cannot lower it right now (${why.charAt(0).toLowerCase()}${why.slice(1)}). Do not touch it: keep your hands and your things away from it, and open Help.`;

const WHAT_NOW = 'The arm is still STIFF. Do not touch it: keep your hands and your things away from it. Open Help.';
/** The server's refusal sentence ("error: follower arm not online/calibrated (the arm is still STIFF: it was not released)") as a plain sentence. */
function sentence(status) {
  let s = String(status || '').trim().replace(/^error:\s*/i, '').replace(/\s*\(the arm is still STIFF[^)]*\)\.?/i, '').replace(/[.\s]+$/, '');
  if (!s) s = 'The app did not lower the arm';
  return `${cap(s)}.`;
}

/**
 * Make the follower limp, LOWERED: POST /api/pp/rest, then wait (the state refreshes every 500 ms) until pp.limp is true.
 * Resolves {ok:true, message:'The arm is limp now.'} at once when it already is. On a refusal or a timeout it resolves
 * {ok:false, stiff:true, message: the server's sentence + what to do now} and never throws.
 * Options: onStatus(text) for plain progress; cancelled() to stop waiting (the page was left); timeoutMs; pollMs.
 */
export async function ensureLimp(ctx, { onStatus = () => {}, cancelled = () => false, timeoutMs = LIMP_WAIT_MS, pollMs = 250 } = {}) {
  if (limpState(ctx) === 'unknown') await ctx.refresh();
  const st = limpState(ctx);
  if (st === 'limp') return { ok: true, stiff: false, message: 'The arm is limp now.' };
  if (st === 'unknown') return { ok: false, stiff: true, message: `The app cannot tell whether the arm is limp (${ctx.offline ? 'it lost its connection' : 'it gets no answer from the arm'}). Do not touch the arm until this page says it is limp. Open Help.` };
  const why = whyCannotLower(ctx);
  if (why) return { ok: false, stiff: true, message: stiffAdvice(why) };
  onStatus('Lowering the arm onto the table…');
  try { await ctx.api.post('/api/pp/rest'); await ctx.refresh(); }
  catch (e) { return { ok: false, stiff: true, message: `${cap(String(e.message || e).replace(/[.\s]+$/, ''))}. ${WHAT_NOW}` }; }
  const t0 = Date.now();
  let idleSince = 0, limpSince = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(pollMs);
    if (cancelled()) return { ok: false, stiff: limpState(ctx) !== 'limp', cancelled: true, message: '' };
    const pp = ctx.state?.pp;
    if (pp?.limp === true) {                                          // limp: wait the moment it takes the job to wind up, so the next call is not refused as "busy"
      limpSince = limpSince || Date.now();
      if (!pp.running || Date.now() - limpSince > 3000) return { ok: true, stiff: false, message: 'The arm is limp now.' };
      continue;
    }
    if (pp && !pp.running) { idleSince = idleSince || Date.now(); } else idleSince = 0;
    if (idleSince && Date.now() - idleSince > 1200) return { ok: false, stiff: true, message: `${sentence(pp.status)} ${WHAT_NOW}` };   // the job ended and the arm is still stiff: it refused or was stopped
    onStatus('Lowering the arm onto the table…');
  }
  return { ok: false, stiff: true, message: `The arm did not go limp within ${Math.round(timeoutMs / 1000)} seconds. ${WHAT_NOW}` };
}

/** limpCard(ctx, {title, then, nextLabel}) -> a card element. Call card.update() on every state tick (it only touches text in place). */
export function limpCard(ctx, { title = 'Make the arm limp first', then, nextLabel = 'Next' } = {}) {
  const stateText = h('span'), stateIcon = h('span', { class: 'limp-ico', 'aria-hidden': 'true' });
  const stateEl = h('p', { class: 'limp-state', role: 'status', 'aria-live': 'polite' }, stateIcon, stateText);
  const noteEl = h('p', { class: 'limp-note' });
  const progText = h('span'), progEl = h('p', { class: 'limp-prog', role: 'status', 'aria-live': 'polite', hidden: true }, h('span', { class: 'spin', 'aria-hidden': 'true' }), progText);
  const failBox = h('div', { class: 'limp-fail', role: 'alert', hidden: true });
  const lowerBtn = button('Lower the arm and make it limp', { kind: 'primary', icon: 'arrow' });
  const lowerLbl = lowerBtn.lastChild;
  const nextBtn = button(nextLabel, { kind: 'primary', icon: 'arrow' });
  const whyEl = h('p', { class: 'why' });
  const node = h('section', { class: 'card limp-card', 'data-state': 'unknown', 'aria-label': title },
    h('div', { class: 'eyebrow' }, 'Before anyone touches the arm'),
    h('h3', {}, title),
    stateEl, noteEl, progEl, failBox,
    h('div', { class: 'btns' }, lowerBtn, nextBtn), whyEl);

  let working = false, last = '';
  const gate = (btn, why) => {
    btn.disabled = !!why;
    if (why) { btn.setAttribute('aria-disabled', 'true'); btn.title = why; btn.dataset.why = why; } else { btn.removeAttribute('aria-disabled'); btn.removeAttribute('title'); delete btn.dataset.why; }
  };
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

  node.update = () => {
    const st = limpState(ctx), cannot = st === 'limp' ? '' : whyCannotLower(ctx);
    if (node.dataset.state !== st) {
      node.dataset.state = st;
      stateIcon.replaceChildren(icon(st === 'limp' ? 'check' : st === 'stiff' ? 'alert' : 'info'));
    }
    setText(stateText, STATE_TEXT[st]);
    const note = st === 'limp' ? 'It is resting and does not push back: it can be moved by hand.'
      : st === 'stiff' ? (cannot && !/job|Leader to follower|STOP/.test(cannot) ? stiffAdvice(cannot) : 'Do not touch it. The button below lowers it onto the table first and only then lets go, so nothing drops and nobody has to hold it.')
      : 'Do not touch the arm until this says it is limp.';
    if (noteEl.dataset.k !== note) { noteEl.dataset.k = note; noteEl.replaceChildren(rich(note.replace('open Help', `<a href="${HELP_HREF}">open Help</a>`))); }
    const wLower = working ? 'The arm is lowering itself: keep your hands clear' : st === 'limp' ? 'The arm is already limp' : st === 'unknown' ? 'The app cannot tell yet whether the arm is limp' : cannot;
    const wNext = working ? 'The arm is lowering itself: keep your hands clear' : st === 'limp' ? '' : st === 'stiff' ? 'The arm is stiff: make it limp first' : 'Waiting to hear whether the arm is limp';
    const sig = `${st}|${wLower}|${wNext}`;
    if (sig !== last) {
      last = sig;
      gate(lowerBtn, wLower); gate(nextBtn, wNext);
      const lines = [];
      if (wLower) lines.push(h('span', { style: { display: 'block' } }, h('b', {}, 'Lower the arm and make it limp'), ` greyed out: ${wLower}`));
      if (wNext) lines.push(h('span', { style: { display: 'block' } }, h('b', {}, nextLabel), ` greyed out: ${wNext}`));
      whyEl.replaceChildren(...lines); whyEl.hidden = !lines.length;
    }
    if (st === 'limp') failBox.hidden = true;
  };

  async function run() {
    if (working) return;
    working = true; failBox.hidden = true; progEl.hidden = false; setText(progText, 'Hands off the arm. Lowering it onto the table…');
    lowerLbl.textContent = 'Lowering the arm…'; last = ''; node.update();
    let r;
    try { r = await ensureLimp(ctx, { onStatus: (m) => setText(progText, `Hands off the arm. ${m}`), cancelled: () => !node.isConnected }); }
    finally { working = false; lowerLbl.textContent = 'Lower the arm and make it limp'; progEl.hidden = true; last = ''; }
    if (!node.isConnected) return;
    if (!r.ok) {
      failBox.hidden = false;
      failBox.replaceChildren(h('p', {}, h('b', {}, 'The arm did not go limp. '), r.message), h('div', { class: 'row' }, button('Open Help', { href: HELP_HREF, size: 'sm' })));
    } else toast('<b>The arm is limp now.</b> You can move it by hand.', 'ok', 3000);
    node.update();
  }
  lowerBtn.onclick = (e) => {
    if (lowerBtn.disabled) { e.preventDefault(); return; }
    askYes(`<b>${HANDS_OFF}</b> The arm moves by itself: it lowers onto the table, then goes limp. Keep your hands clear until this card says <b>The arm is limp.</b>`, 'Yes, lower it', safe(run));
  };
  nextBtn.onclick = (e) => {
    if (nextBtn.disabled) { e.preventDefault(); return; }
    if (limpState(ctx) !== 'limp') { toast('<b>The arm is not limp.</b> Lower it first.', 'warn'); node.update(); return; }   // check the real state again at the click
    then?.();
  };
  node.update();
  return node;
}
