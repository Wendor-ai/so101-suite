// Help: symptom -> tests -> fixes, "Copy diagnostics", an "Ask an AI" prompt, and where the community is.
import { h, icon, button, callout, rich, empty, loadCss, debounce, copyBox, toast, safe } from '../ui.js';

loadCss(new URL('../../css/pages/help.css', import.meta.url).href);

const REPO = 'https://github.com/Wendor-ai/so101-suite';
const LINKS = [
  { label: 'GitHub issues', text: 'Report a bug or search for the same problem.', href: REPO + '/issues', ic: 'terminal' },
  { label: 'LeRobot Discord', text: 'Ask the community. Many people have built this arm.', href: 'https://discord.com/invite/s3KuuzsPFb', ic: 'quote' },
  { label: 'Official SO-101 guide', text: 'The build and setup guide from LeRobot.', href: 'https://huggingface.co/docs/lerobot/so101', ic: 'book' },
];

/* shell commands inside the troubleshooting text become <code>: easier to spot and to copy */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CMD = /(ls \/dev\/[^\s,)]+|dmesg \| tail|lsof \/dev\/\S+?(?=\)|,|\s|$)|sudo [\w\-$ ]+?(?= and press| then|, then| first|,|\. |\.$|$)|uv cache clean|uv venv --python \S+)/g;
const codify = (s) => rich(esc(s).replace(CMD, '<code>$1</code>'));

const asText = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 2));

export default {
  id: 'help', title: 'Help',
  async render(root, ctx, route) {
    let alive = true;
    let items = null;
    try { items = (await import('../content/troubleshooting.js')).default; } catch (e) { console.warn('troubleshooting content missing', e); }
    if (!alive) return () => {};

    /* ---------- diagnostics: fetched on demand, cached, never silent ---------- */
    const diag = { text: '', err: '', loading: null };
    const getDiag = async () => {
      if (diag.text) return diag.text;
      diag.loading ||= (async () => {
        try { diag.text = asText(await ctx.api.get('/api/suite/diagnostics')).trim(); diag.err = ''; if (!diag.text) throw new Error('The app sent an empty report.'); }
        catch (e) { diag.err = String(e.message || e); diag.text = ''; throw e; }
        finally { diag.loading = null; }
      })();
      return diag.loading;
    };

    /* ---------- hardware card ---------- */
    const hardware = h('section', { class: 'card hlp-hw', 'aria-labelledby': 'hw-t' },
      h('div', { class: 'stack-sm' }, h('div', { class: 'eyebrow' }, 'My hardware is acting up'), h('h2', { id: 'hw-t' }, 'See what the motors say'),
        h('p', { class: 'muted' }, 'Two tools make the invisible visible. Neither one needs you to guess.')),
      h('div', { class: 'grid grid-2' },
        h('a', { class: 'hlp-tool', href: '#/test' }, icon('pulse'), h('div', {}, h('b', {}, 'Test motors'), h('span', { class: 'muted' }, 'Ping each motor, or wiggle it a little, to find the one that does not answer.')), icon('arrow')),
        h('a', { class: 'hlp-tool', href: '#/inspector' }, icon('terminal'), h('div', {}, h('b', {}, 'Inspector'), h('span', { class: 'muted' }, 'Watch the messages between the app and the motors, like a browser’s Network tab.')), icon('arrow'))));

    /* ---------- symptoms ---------- */
    const qInput = h('input', { class: 'input hlp-q', id: 'hlp-q', type: 'search', placeholder: 'For example “camera black”, “no port”, “jitter”', autocomplete: 'off', spellcheck: 'false' });
    const count = h('p', { class: 'muted hlp-count', role: 'status', 'aria-live': 'polite' }, '');
    const listEl = h('div', { class: 'hlp-list' });
    const noHit = h('div', { class: 'hlp-nohit', hidden: true });
    const rows = new Map();

    let askBox; // defined below; symptoms use it
    const askAbout = (text) => { askBox.setProblem(text); askBox.el.scrollIntoView({ block: 'start', behavior: document.documentElement.dataset.motion === 'reduce' ? 'auto' : 'smooth' }); setTimeout(() => askBox.ta.focus({ preventScroll: true }), 250); };

    if (items?.length) {
      for (const s of items) {
        const body = h('div', { class: 'hlp-body' },
          h('p', { class: 'muted hlp-intro' }, 'Do these in order. Stop at the first one that fixes it.'),
          h('ol', { class: 'hlp-causes' }, s.causes.map((c, i) => h('li', {},
            h('span', { class: 'hlp-n', 'aria-hidden': 'true' }, String(i + 1)),
            h('div', { class: 'hlp-cause' }, h('p', {}, h('b', {}, 'Check'), ' ', codify(c.test)), c.fix ? h('p', { class: 'hlp-fix' }, h('b', {}, 'Then'), ' ', codify(c.fix)) : null)))),
          h('div', { class: 'hlp-after' }, h('span', { class: 'muted' }, 'Still stuck after all of these?'), button('Ask an AI about this', { size: 'sm', icon: 'sparkles', onClick: () => askAbout(`The problem: “${s.symptom}”. I did the tests on the Help page and it is still not fixed.`) })));
        const el = h('details', { class: 'hlp-sym', id: 's-' + s.id }, h('summary', {}, h('span', { class: 'hlp-q-t' }, s.symptom), h('span', { class: 'hlp-tests' }, `${s.causes.length} test${s.causes.length === 1 ? '' : 's'}`), icon('chevron')), body);
        rows.set(s.id, { el, hay: [s.symptom, ...(s.tags || []), ...s.causes.flatMap((c) => [c.test, c.fix])].join(' ').toLowerCase(), head: [s.symptom, ...(s.tags || [])].join(' ').toLowerCase(), s });
        listEl.append(el);
      }
    }
    function applyFilter() {
      const q = qInput.value.trim(), words = q.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const r of rows.values()) { const ok = !words.length || words.every((w) => r.hay.includes(w)); r.el.hidden = !ok; if (ok) shown++; }
      // best matches first when searching: symptom text/tags before test text
      if (words.length) [...rows.values()].filter((r) => !r.el.hidden).sort((a, b) => Number(words.every((w) => b.head.includes(w))) - Number(words.every((w) => a.head.includes(w)))).forEach((r) => listEl.append(r.el));
      count.textContent = words.length ? `${shown} of ${rows.size} symptoms match “${q}”` : `${rows.size} symptoms`;
      noHit.hidden = shown > 0 || !rows.size;
      if (!noHit.hidden) noHit.replaceChildren(empty(`No symptom matches “${q}”`, 'Try fewer or simpler words. Or hand it to an AI: it can read your diagnostics and the project’s AGENTS.md.',
        h('div', { class: 'row', style: { justifyContent: 'center' } }, button('Ask an AI about this', { kind: 'primary', icon: 'sparkles', onClick: () => askAbout(q) }), button('Clear search', { kind: 'ghost', onClick: () => { qInput.value = ''; applyFilter(); qInput.focus(); } }), h('a', { class: 'btn ghost', href: REPO + '/issues', target: '_blank', rel: 'noopener' }, 'Open an issue', icon('external')))));
    }
    qInput.addEventListener('input', debounce(applyFilter, 110));
    qInput.addEventListener('keydown', (e) => { if (e.key === 'Escape' && qInput.value) { qInput.value = ''; applyFilter(); } });

    const symptoms = h('section', { class: 'stack hlp-symptoms', 'aria-labelledby': 'sym-t' },
      h('div', {}, h('h2', { id: 'sym-t' }, 'What is going wrong?'), h('p', { class: 'muted', style: { margin: 0 } }, 'Pick the closest symptom. Each one lists simple tests, then what to do about the result.')),
      items?.length
        ? [h('div', { class: 'hlp-find' }, h('label', { class: 'sr-only', for: 'hlp-q' }, 'Search symptoms'), h('span', { class: 'hlp-ico', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>' }), qInput), count, listEl, noHit]
        : empty('The troubleshooting list is not part of this build', 'Use the buttons below: copy your diagnostics and ask an AI, or ask the community.'));

    /* ---------- diagnostics card ---------- */
    const diagStatus = h('p', { class: 'why hlp-status', role: 'status', 'aria-live': 'polite' });
    const pre = h('pre', { class: 'hlp-pre', tabindex: '0', 'aria-label': 'Diagnostics text' });
    const preview = h('details', { class: 'hlp-preview' }, h('summary', {}, 'Show what will be copied'), pre);
    const showDiag = async () => {
      try { pre.textContent = await getDiag(); diagStatus.textContent = ''; }
      catch (e) { pre.textContent = ''; diagStatus.textContent = `Could not read the diagnostics: ${diag.err}. Is the app still running? You can still describe the problem in words.`; throw e; }
    };
    preview.addEventListener('toggle', () => { if (preview.open && !pre.textContent) showDiag().catch(() => {}); });
    const copyDiag = button('Copy diagnostics', { kind: 'primary', icon: 'copy', onClick: safe(async () => {
      diagStatus.textContent = 'Reading…';
      await showDiag();
      try { await navigator.clipboard.writeText(diag.text); toast('<b>Copied.</b> Paste it into a GitHub issue or an AI chat.', 'ok'); diagStatus.textContent = 'Copied to your clipboard.'; }
      catch { preview.open = true; pre.focus(); diagStatus.textContent = 'Your browser did not allow copying. The text is open below: select it and copy it.'; toast('Could not copy automatically. The text is open below: select it and copy.', 'warn'); }
    }) });
    const diagCard = h('section', { class: 'card hlp-card', 'aria-labelledby': 'dg-t' },
      h('div', { class: 'stack-sm' }, h('h3', { id: 'dg-t' }, 'Copy diagnostics'),
        h('p', {}, rich('A short text report of your setup: your operating system and app version, the USB ports it sees, which motors answer on each arm, the cameras, and the setup checklist. <b>No personal data</b>: no name, no files, no passwords, no camera pictures.')),
        h('p', { class: 'muted' }, 'Nothing is sent anywhere. It only goes to your clipboard, and you decide where to paste it.')),
      h('div', {}, copyDiag), diagStatus, preview);

    /* ---------- Ask an AI ---------- */
    const ta = h('textarea', { class: 'input hlp-ta', id: 'hlp-ta', rows: 3, placeholder: 'In your own words: what did you do, what did you expect, what happened instead?' });
    const inc = h('input', { type: 'checkbox', id: 'hlp-inc', checked: true });
    const prevHolder = h('div', { class: 'hlp-prompt' });
    const incNote = h('p', { class: 'why hlp-status', role: 'status', 'aria-live': 'polite' });
    const promptText = () => {
      const lines = [`I am using an SO-101 robot arm with the open-source SO-101 Suite app (${REPO}).`, 'Read AGENTS.md in the repo first.', '', 'My problem: ' + (ta.value.trim() || '(describe what you see here)')];
      if (inc.checked && diag.text) lines.push('', 'Diagnostics from the app:', '```', diag.text, '```');
      lines.push('', 'Please tell me what to check first. Give one step at a time, and say what I should see after each step.');
      return lines.join('\n');
    };
    const redraw = () => prevHolder.replaceChildren(copyBox(promptText(), { label: 'Copy prompt' }));
    const refreshDiag = async () => {
      if (!inc.checked) { incNote.textContent = 'Diagnostics left out of the prompt.'; redraw(); return; }
      incNote.textContent = diag.text ? '' : 'Reading the diagnostics…';
      try { await getDiag(); incNote.textContent = ''; } catch { incNote.textContent = `Could not read the diagnostics (${diag.err}), so the prompt has only your words.`; }
      if (alive) redraw();
    };
    ta.addEventListener('input', debounce(redraw, 150));
    inc.addEventListener('change', refreshDiag);
    const aiCard = h('section', { class: 'card hlp-card hlp-ai', id: 'hlp-ai', 'aria-labelledby': 'ai-t' },
      h('div', { class: 'stack-sm' }, h('h3', { id: 'ai-t' }, 'Ask an AI'),
        h('p', { class: 'muted' }, 'An AI assistant (Claude, ChatGPT, Codex…) can read the project and your report. Copy this prompt and paste it into the assistant you use.')),
      h('div', { class: 'field' }, h('label', { for: 'hlp-ta' }, 'What is going wrong?'), ta),
      h('div', { class: 'row hlp-inc' }, inc, h('label', { for: 'hlp-inc' }, 'Include my diagnostics')), incNote,
      prevHolder,
      h('p', { class: 'why' }, 'When you paste this into an AI chat, that service receives the text. Read it first and remove anything you do not want to share.'));
    askBox = { el: aiCard, ta, setProblem: (t) => { ta.value = t; redraw(); } };
    redraw();
    refreshDiag();

    /* ---------- community ---------- */
    const links = h('section', { class: 'stack', 'aria-labelledby': 'cm-t' }, h('h2', { id: 'cm-t' }, 'Talk to people'),
      h('div', { class: 'grid grid-3' }, LINKS.map((l) => h('a', { class: 'card flat hlp-link', href: l.href, target: '_blank', rel: 'noopener' }, icon(l.ic), h('div', {}, h('b', {}, l.label), h('span', { class: 'muted' }, l.text)), icon('external')))));

    root.append(h('div', { class: 'stack-lg hlp' },
      h('header', { class: 'page-head', style: { marginBottom: 0 } }, h('div', { class: 'eyebrow' }, 'Help'), h('h1', {}, 'Something not working?'), h('p', { class: 'lead' }, 'Almost every problem has a small test that finds it. Start with what you see.')),
      hardware, symptoms,
      h('section', { class: 'stack', 'aria-labelledby': 'st-t' }, h('div', {}, h('h2', { id: 'st-t' }, 'Still stuck?'), h('p', { class: 'muted', style: { margin: 0 } }, 'Share what the app knows, so nobody has to guess.')), h('div', { class: 'grid grid-2 hlp-two' }, diagCard, aiCard)),
      links));
    applyFilter();

    const want = route.args[0];
    if (want && rows.has(want)) setTimeout(() => { if (!alive) return; const r = rows.get(want); r.el.open = true; r.el.scrollIntoView({ block: 'center', behavior: 'auto' }); r.el.classList.add('hit'); r.el.querySelector('summary')?.focus({ preventScroll: true }); }, 120);
    return () => { alive = false; };
  },
};
