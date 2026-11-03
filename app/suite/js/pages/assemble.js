// Assemble: build the follower and the leader, one card per joint. Progress is saved through /api/suite/progress.
// Keys: assembly.step.clean (shared), assembly.step.<arm>.<step id>, assembly.skip.<arm>, assembly.preflight, assembly.done (+ assembly_done for the checklist).
import { h, icon, button, actions, badge, callout, rich, askYes, toast, safe, pageHead, empty, loadCss, term } from '../ui.js';
import { stepCard, preflight } from '../steps.js';
import { diagram } from '../diagrams/assemble.js';
import { JOINT_LABEL } from '../state.js';

loadCss(new URL('../../css/pages/assemble.css', import.meta.url).href);

const OFFICIAL = 'https://huggingface.co/docs/lerobot/so101';
const ARMS = [{ id: 'follower', label: 'Follower', what: 'the arm that does the work' }, { id: 'leader', label: 'Leader', what: 'the arm you hold and move' }];
const SHORT = { clean: 'Clean parts', 'joint-1': 'Joint 1', 'joint-2': 'Joint 2', 'joint-3': 'Joint 3', 'joint-4': 'Joint 4', 'joint-5': 'Joint 5', 'gripper-follower': 'Gripper', 'gripper-leader': 'Handle', chain: 'Cables' };
const SUB = { clean: 'prepare', chain: 'chain + board' };
const SHARED = new Set(['clean']); // one tick for both arms

/** {a:{b:true}} -> {'a.b':true}: the store may hand progress back nested or flat */
function flat(o, p = '', out = {}) {
  for (const [k, v] of Object.entries(o || {})) { const key = p ? `${p}.${k}` : k; if (v && typeof v === 'object') flat(v, key, out); else out[key] = !!v; }
  return out;
}
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const listOrText = (v) => { const a = asList(v); return a.length > 1 ? h('ul', { class: 'asm-ul' }, a.map((x) => h('li', {}, rich(x)))) : a[0] || null; };

export default {
  id: 'assemble', title: 'Assemble',
  async render(root, ctx, route) {
    let alive = true;
    const stage = h('div', { class: 'asm stack-lg' });
    root.append(pageHead('Get started', 'Assemble your SO-101', 'Build the follower and the leader one joint at a time. One card at a time, each with a picture and a way to check it.'), stage);
    stage.append(h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { height: '28px', width: '40%' } }), h('div', { class: 'skeleton', style: { height: '220px' } })));

    /* ---- data: content (may be missing) and saved progress ---- */
    let C = null, prog = {}, progErr = '';
    try { C = (await import('../content/assemble.js')).default; } catch (e) { console.warn('assemble content missing', e); }
    if (!alive) return () => {};
    if (!C?.steps?.length) {
      stage.replaceChildren(empty('The assembly guide is not part of this build', 'Follow the official guide for now. It has a video for every joint.', button('Open the official SO-101 guide', { href: OFFICIAL, kind: 'primary', icon: 'external' })));
      return () => { alive = false; };
    }
    const loadProgress = async () => { try { prog = flat(await ctx.api.get('/api/suite/progress')); progErr = ''; } catch (e) { progErr = String(e.message || e); } };
    await loadProgress();
    if (!alive) return () => {};

    /* ---- derived ---- */
    const stepsFor = (arm) => C.steps.filter((s) => (arm === 'follower' ? s.id !== 'gripper-leader' : s.id !== 'gripper-follower'));
    const key = (arm, s) => (SHARED.has(s.id) ? `assembly.step.${s.id}` : `assembly.step.${arm}.${s.id}`);
    const isDone = (arm, s) => !!prog[key(arm, s)];
    const skipped = (arm) => !!prog[`assembly.skip.${arm}`];
    const armDone = (arm) => skipped(arm) || stepsFor(arm).every((s) => isDone(arm, s));
    const armCount = (arm) => (skipped(arm) ? stepsFor(arm).length : stepsFor(arm).filter((s) => isDone(arm, s)).length);
    const complete = () => ARMS.every((a) => armDone(a.id));

    /* ---- saving: optimistic, reverted with a sentence when the app says no ---- */
    let busy = false;
    async function save(patch) {
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, prog[k]]));
      Object.assign(prog, patch);
      try {
        const r = await ctx.api.post('/api/suite/progress', patch);
        if (r && typeof r === 'object') for (const [k, v] of Object.entries(flat(r))) if (k in patch) prog[k] = v;
        ctx.refresh?.();
      } catch (e) {
        for (const [k, v] of Object.entries(before)) { if (v === undefined) delete prog[k]; else prog[k] = v; }
        toast(`<b>Could not save your progress.</b> ${String(e.message || e)} Your tick was undone, so nothing is lost.`, 'err');
        throw e;
      }
    }
    /** keep assembly.done (and the key the checklist reads) in line with the ticks */
    async function syncDone() {
      const c = complete();
      if (!!prog['assembly.done'] !== c) await save({ 'assembly.done': c, assembly_done: c });
    }

    /* ---- state of the screen ---- */
    let arm = ARMS.some((a) => a.id === route?.query?.get('arm')) ? route.query.get('arm') : 'follower';
    let idx = 0;
    let view = prog['assembly.done'] ? 'done' : (prog['assembly.preflight'] || Object.keys(prog).some((k) => k.startsWith('assembly.step.')) ? 'steps' : 'pre');
    const firstTodo = (a) => { const i = stepsFor(a).findIndex((s) => !isDone(a, s)); return i < 0 ? 0 : i; };
    idx = firstTodo(arm);
    const want = route?.query?.get('step');
    if (want) { const i = stepsFor(arm).findIndex((s) => s.id === want); if (i >= 0) { idx = i; view = 'steps'; } }

    const focusStage = (sel) => requestAnimationFrame(() => { const el = stage.querySelector(sel); if (el) { el.focus({ preventScroll: true }); const r = el.getBoundingClientRect(); if (r.top < 60 || r.top > innerHeight * 0.6) el.scrollIntoView({ block: 'start', behavior: document.documentElement.dataset.motion === 'reduce' ? 'auto' : 'smooth' }); } });
    const show = (v, sel) => { view = v; draw(); if (sel) focusStage(sel); };

    /* ================= view 1: before you start ================= */
    function drawPre() {
      const parts = h('ul', { class: 'asm-parts' }, C.parts.map((p, i) => {
        const id = `part-${i}`;
        return h('li', {}, h('input', { type: 'checkbox', id, 'aria-label': `I have ${p.name}` }), h('label', { for: id }, h('span', { class: 'asm-part-t' }, p.name, p.qty != null ? badge(`× ${p.qty}`, '') : null), h('span', { class: 'asm-part-n muted' }, rich(p.note || ''))));
      }));
      const count = h('span', { class: 'muted' }, `0 of ${C.parts.length} ticked`);
      parts.addEventListener('change', () => { count.textContent = `${parts.querySelectorAll('input:checked').length} of ${C.parts.length} ticked`; });

      const skipBtn = button('Skip: my arms are already built', { kind: 'ghost', onClick: () => askYes('Mark <b>both arms as built</b> and skip the assembly guide? You can come back any time.', 'Yes, skip', safe(async () => { await save({ 'assembly.done': true, assembly_done: true, 'assembly.skip.follower': true, 'assembly.skip.leader': true, 'assembly.preflight': true }); show('done', '.asm-done-title'); })) });
      const start = button('Start with the follower arm', { kind: 'primary', size: 'lg', icon: 'arrow', onClick: safe(async () => { await save({ 'assembly.preflight': true }); arm = 'follower'; idx = firstTodo(arm); show('steps', '.asm-card-head'); }) });

      stage.replaceChildren(
        h('div', { class: 'asm-ids' }, callout('why', h('div', {}, h('p', {}, rich('<b>Did you set each motor’s ID yet?</b> Do that first. The official guide gives every loose motor its number (1 to 6) <i>before</i> it goes into the arm, because a motor can only be numbered while it is plugged in alone.')), h('div', { class: 'row' }, button('Open Motor IDs', { href: '#/motors', kind: 'primary', icon: 'plug' }), h('a', { href: '#/learn/motor-ids-explained' }, 'Why does it matter?'))), 'Motor IDs come first')),
        preflight({
          title: 'Before you build', minutes: 120,
          needs: C.tools,
          hands: 'Both hands: one flat on the part, the other on the screwdriver. Never hold a part in your palm with the screwdriver pointing at your hand.',
          moves: 'Nothing moves. The power supply and the USB cable stay unplugged until the last card is done.',
          clear: 'A clear, flat table with good light. Put out two cups, one for the M2x6 screws and one for the M3x6 screws: they look alike.',
          stop: 'You can stop after any card. Your ticks are saved, so nothing is lost.',
        }),
        h('section', { class: 'card asm-block' }, h('div', { class: 'row-between' }, h('h3', {}, 'Check your parts'), count), h('p', { class: 'muted' }, rich(C.intro || '')), parts),
        h('section', { class: 'card asm-block' }, h('h3', {}, 'Six things to do first'), h('ol', { class: 'asm-first' }, C.beforeYouStart.map((t) => h('li', {}, rich(t))))),
        h('div', { class: 'asm-go' }, actions([start, skipBtn], 'The follower is built first. The leader is the same steps with a different last card.')));
    }

    /* ================= view 2: one card at a time ================= */
    function drawSteps() {
      const steps = stepsFor(arm), s = steps[Math.min(idx, steps.length - 1)];
      const done = isDone(arm, s), n = steps.indexOf(s) + 1;

      /* arm tabs with their own progress */
      const tabs = h('div', { class: 'tabs asm-tabs', role: 'tablist', 'aria-label': 'Which arm' }, ARMS.map((a) =>
        h('button', { class: 'tab', role: 'tab', id: 'tab-' + a.id, 'aria-selected': String(a.id === arm), tabindex: a.id === arm ? 0 : -1, onclick: () => { arm = a.id; idx = firstTodo(arm); draw(); }, onkeydown: (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); arm = arm === 'follower' ? 'leader' : 'follower'; idx = firstTodo(arm); draw(); stage.querySelector('#tab-' + arm)?.focus(); } } },
          a.label, ' ', h('span', { class: 'asm-tabn' }, skipped(a.id) ? 'skipped' : `${armCount(a.id)}/${stepsFor(a.id).length}`), armDone(a.id) ? icon('check') : null)));
      const kind = h('p', { class: 'asm-kind muted' }, arm === 'follower'
        ? rich('The <b>follower</b> is the arm that does the work. All six of its motors are the same kind (1/345 gear, code C001).')
        : rich('The <b>leader</b> is the arm you hold and move. Its six motors are <b>not</b> all the same: motors 1 and 3 are 1/191 (code C044), motor 2 is 1/345 (C001), motors 4, 5 and 6 are 1/147 (C046). Read the code on each box.'));

      /* numbered stepper (top progress with ticks) */
      const stepper = h('ol', { class: 'asm-stepper', 'aria-label': `Steps for the ${arm} arm` }, steps.map((x, i) => {
        const d = isDone(arm, x) || skipped(arm);
        return h('li', {}, h('button', { type: 'button', class: ['asm-dot', d ? 'done' : '', x === s ? 'cur' : ''], 'aria-current': x === s ? 'step' : null, 'aria-label': `Step ${i + 1}: ${x.title}${d ? ', done' : ''}`, title: x.title, onclick: () => { idx = i; draw(); focusStage('.asm-card-head'); } },
          h('span', { class: 'asm-num' }, d ? icon('check') : String(i + 1)), h('span', { class: 'asm-lab' }, SHORT[x.id] || x.title, h('small', {}, SUB[x.id] || (x.joint ? JOINT_LABEL[x.joint] : '')))));
      }));
      const pct = Math.round((armCount(arm) / steps.length) * 100);
      const bar = h('div', { class: 'asm-prog' }, h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': `${arm} arm progress` }, h('i', { style: { width: pct + '%' } })), h('span', { class: 'muted' }, `${armCount(arm)} of ${steps.length} done`));

      /* ---- the card ---- */
      const main = diagram(s.diagram || (s.id === 'clean' ? 'clean' : null), { single: /\bONE horn\b/.test((s.needs || []).join(' ')) });
      const video = s.video ? h('a', { class: 'btn', href: s.video, target: '_blank', rel: 'noopener' }, icon('external'), 'Watch the official video') : null;
      const guideLink = h('a', { href: s.video || OFFICIAL, target: '_blank', rel: 'noopener' }, s.video ? 'official video' : 'official guide');
      const figs = h('div', { class: 'asm-figs' });
      if (main) {
        figs.append(h('div', { class: 'asm-fig' }, main.node, h('p', { class: 'asm-cap' }, rich(main.caption))));
        if (s.verify) figs.append(h('p', { class: 'asm-verify' }, icon('info'), h('span', {}, 'Schematic only. Check this step against the ', guideLink, ' before you tighten anything.')));
      } else if (s.verify) figs.append(h('p', { class: 'asm-verify' }, icon('info'), h('span', {}, 'No picture for this step. Check it against the ', guideLink, ' before you tighten anything.')));
      for (const id of asList(s.alsoDiagram)) {
        const d = diagram(id, { single: /\bONE horn\b/.test((s.needs || []).join(' ')) });
        if (d) figs.append(h('div', { class: 'asm-fig also' }, h('h4', {}, d.title), d.node, h('p', { class: 'asm-cap' }, rich(d.caption))));
      }

      const where = s.joint
        ? h('span', {}, term('joint', 'Joint'), ` ${s.motorId || ''} of 6: ${JOINT_LABEL[s.joint]?.toLowerCase() || s.joint}. It is the orange circle in the picture. Your sticker on the motor says ${s.motorId || 'its number'}.`)
        : s.id === 'clean' ? 'At your table, with all the printed parts of both arms in front of you.' : 'At your table, with the finished arm and its USB servo board in front of you.';

      const card = stepCard({
        id: s.id, n, total: steps.length, title: s.title, minutes: s.minutes,
        safety: s.safety, where, do: s.do, know: listOrText(s.know), ifNot: listOrText(s.ifNot),
        then: h('span', {}, 'Press ', h('b', {}, 'Mark step done'), '. The next card opens.'),
        diagram: figs.childNodes.length ? figs : null,
      });
      // keep the picture in view while the long action list scrolls, but only when it fits on screen
      requestAnimationFrame(() => { const f = card.querySelector('.stepcard__body > figure'); if (f && f.offsetHeight < innerHeight - 110) f.classList.add('stick'); });
      card.querySelector('h3')?.classList.add('asm-card-head');
      card.querySelector('h3')?.setAttribute('tabindex', '-1');
      card.classList.add('asm-card');

      /* extras inside the card: needs, mistakes to avoid, count check */
      const needs = asList(s.needs).length ? h('details', { class: 'asm-needs', open: innerWidth >= 700 }, h('summary', {}, `You need for this step (${s.needs.length})`), h('ul', {}, s.needs.map((x) => h('li', {}, rich(x))))) : null;
      if (needs) card.querySelector('.stepcard__head').after(needs);
      const extras = h('div', { class: 'asm-extras' });
      if (asList(s.warn).length) extras.append(callout('warn', h('ul', { class: 'asm-ul' }, s.warn.map((w) => h('li', {}, rich(w)))), 'Mistakes to avoid'));
      if (asList(s.check).length) extras.append(h('div', { class: 'asm-check' }, h('h4', {}, 'Count check before you go on'), h('ul', {}, s.check.map((c, i) => h('li', {}, h('input', { type: 'checkbox', id: `chk-${s.id}-${i}`, 'aria-label': c }), h('label', { for: `chk-${s.id}-${i}` }, rich(c)))))));
      if (extras.childNodes.length) card.querySelector('.stepcard__body').after(extras);

      /* footer: Back, Mark step done, official video */
      const back = button('Back', { icon: 'back', kind: 'ghost', why: n === 1 ? 'This is the first card.' : '', onClick: () => { idx = Math.max(0, idx - 1); draw(); focusStage('.asm-card-head'); } });
      const advance = () => { const nxt = steps.findIndex((x, i) => i > idx && !isDone(arm, x)); idx = nxt >= 0 ? nxt : Math.min(idx + 1, steps.length - 1); };
      const mark = done
        ? button('Next step', { kind: 'primary', icon: 'arrow', why: n === steps.length ? 'This is the last card of this arm.' : '', onClick: () => { idx = Math.min(idx + 1, steps.length - 1); draw(); focusStage('.asm-card-head'); } })
        : button('Mark step done', { kind: 'primary', icon: 'check', onClick: safe(async () => {
          if (busy) return; busy = true;
          try {
            await save({ [key(arm, s)]: true });
            await syncDone();
            if (prog['assembly.done']) { show('done', '.asm-done-title'); return; }
            if (armDone(arm)) { const other = arm === 'follower' ? 'leader' : 'follower'; toast(`<b>${arm === 'follower' ? 'Follower' : 'Leader'} built.</b> ${armDone(other) ? '' : `Now the ${other} arm.`}`, 'ok'); if (!armDone(other)) { arm = other; idx = firstTodo(arm); draw(); focusStage('.asm-card-head'); return; } }
            advance(); draw(); focusStage('.asm-card-head');
          } finally { busy = false; }
        }) });
      const undo = done ? button('Not done yet', { kind: 'ghost', onClick: safe(async () => { if (busy) return; busy = true; try { await save({ [key(arm, s)]: false }); await syncDone(); } finally { busy = false; } draw(); }) }) : null;
      card.append(h('footer', { class: 'stepcard__foot asm-foot' }, actions([back, mark, undo, video].filter(Boolean), done ? 'You marked this card done. You can still read it again.' : null)));

      /* skip an arm that is already built */
      const skip = skipped(arm)
        ? h('p', { class: 'muted asm-skip' }, `You marked the ${arm} arm as already built. `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); safe(async () => { await save({ [`assembly.skip.${arm}`]: false }); await syncDone(); idx = firstTodo(arm); draw(); })(); } }, 'Build it with the guide instead'), '.')
        : h('p', { class: 'muted asm-skip' }, `Already built the ${arm} arm? `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); askYes(`Mark the <b>${arm} arm</b> as already built and skip its cards?`, 'Yes, skip it', safe(async () => { await save({ [`assembly.skip.${arm}`]: true }); await syncDone(); if (prog['assembly.done']) show('done', '.asm-done-title'); else draw(); })); } }, 'Skip this arm'), '.');

      stage.replaceChildren(
        h('div', { class: 'asm-top' }, tabs, kind, bar, stepper),
        skipped(arm) ? h('div', { class: 'card flat asm-skipped' }, icon('check'), h('div', {}, h('b', {}, `The ${arm} arm is marked as built.`), h('p', { class: 'muted' }, 'Its cards are skipped. Switch to the other arm, or build this one anyway.'))) : card,
        skip,
        h('p', { class: 'asm-links muted' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); show('pre', '.asm-ids'); } }, 'Show the parts and tools list again'), ' · ', h('a', { href: '#/glossary' }, 'Glossary'), ' · ', h('a', { href: '#/help' }, 'Something is wrong? Help')));
    }

    /* ================= view 3: finished ================= */
    function drawDone() {
      const was = C.afterAssembly || [];
      stage.replaceChildren(...[
        h('div', { class: 'card hero asm-done' },
          h('div', { class: 'eyebrow' }, 'Built'), h('h2', { class: 'asm-done-title', tabindex: '-1' }, 'Your arms are built.'),
          h('p', { class: 'lead' }, 'Nothing is powered yet. Next the arms learn their own range, so every joint reads 0 at the middle.'),
          h('div', { class: 'row' }, button('Next: Calibrate', { href: '#/calibrate', kind: 'primary', size: 'lg', icon: 'arrow' }), button('Review the steps', { kind: 'ghost', onClick: () => { arm = 'follower'; idx = 0; show('steps', '.asm-card-head'); } }))),
        was.length ? h('section', { class: 'card asm-block' }, h('h3', {}, 'Before you switch it on'), h('ol', { class: 'asm-first' }, was.map((t) => h('li', {}, rich(t))))) : null,
        callout('tip', 'Built it but something is off? Open <b>Test motors</b> to see which motor answers, or <b>Help</b> for the usual fixes.', 'If a motor does not answer'),
        h('p', { class: 'asm-links muted' }, h('a', { href: '#/test' }, 'Test motors'), ' · ', h('a', { href: '#/help' }, 'Help'), ' · ', h('a', { href: '#/learn/meet-your-arm' }, 'Meet your arm'))].filter(Boolean));
    }

    function draw() {
      if (!alive) return;
      if (progErr && view !== 'pre') { /* a visible banner; the guide still works without saved ticks */ }
      if (view === 'pre') drawPre(); else if (view === 'done') drawDone(); else drawSteps();
      if (progErr) stage.prepend(callout('warn', h('div', {}, h('p', {}, `Your saved progress could not be read: ${progErr}. You can still use the guide, but ticks may not be saved.`), button('Try again', { size: 'sm', onClick: safe(async () => { await loadProgress(); if (!progErr) { idx = firstTodo(arm); if (prog['assembly.done']) view = 'done'; } draw(); }) })), 'Progress not loaded'));
    }
    draw();
    return () => { alive = false; };
  },
};
