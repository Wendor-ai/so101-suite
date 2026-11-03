import type { APIRoute } from 'astro';
import { getLearn } from '../data/content';
import { getDocs } from '../data/docs';
import { DESCRIPTION, REPO, REPO_BLOB } from '../data/site';

export const GET: APIRoute = async ({ site }) => {
  const base = (site ?? new URL('https://so101-suite.pages.dev')).origin;
  const learn = await getLearn();
  const docs = await getDocs();
  const lines = [
    '# SO-101 Suite',
    '',
    `> ${DESCRIPTION}`,
    '',
    'SO-101 Suite is an independent community project (AGPL-3.0-or-later). It is not affiliated with Hugging Face / LeRobot, The Robot Studio / SO-ARM100 or Feetech.',
    '',
    '## Try and install',
    `- [Live demo](${base}/demo/): the real app in the browser with simulated hardware`,
    `- [Get started](${base}/get-started/): one-command install for macOS, Linux, Raspberry Pi and Windows`,
    `- [Features](${base}/features/)`,
    '',
    '## For AI agents',
    `- [For AI agents](${base}/ai/): AGENTS.md, skills, HTTP API, demo mode`,
    `- [AGENTS.md](${REPO_BLOB}/AGENTS.md)`,
    `- [Source code](${REPO})`,
    '',
    '## Learn',
    `- [Glossary](${base}/glossary/)`,
    ...learn.map((a) => `- [${a.title}](${base}/learn/${a.id}/)`),
  ];
  if (docs.length) lines.push('', '## Docs', ...docs.map((d) => `- [${d.title}](${base}/docs/${d.id}/)`));
  lines.push('', '## More', `- [Modules](${base}/modules/)`, `- [About](${base}/about/)`, '');
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
