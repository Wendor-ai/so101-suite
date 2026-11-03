import { getCollection, render } from 'astro:content';
import { REPO_BLOB } from './site';

export interface DocMeta { id: string; title: string; description: string; order: number; edit: string; entry: any }

const PREFERRED = ['architecture', 'api', 'modules', 'troubleshooting'];

const stripMd = (s: string) => s
  .replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, ' ').replace(/[*_>#]/g, '').replace(/\s+/g, ' ').trim();

function firstParagraph(body: string): string {
  const blocks = body.replace(/^---[\s\S]*?---\n/, '').split(/\n{2,}/);
  for (const b of blocks) {
    const t = b.trim();
    if (!t || /^(#|```|\||[-*+] |\d+\. |>|<)/.test(t)) continue;
    const s = stripMd(t);
    if (s.length > 30) return s.length > 200 ? s.slice(0, 197).replace(/\s+\S*$/, '') + '…' : s;
  }
  return '';
}

let cache: Promise<DocMeta[]> | null = null;
export function getDocs(): Promise<DocMeta[]> { return (cache ??= load()); }

async function load(): Promise<DocMeta[]> {
  let entries: any[] = [];
  try { entries = await getCollection('docs'); } catch (e) { console.warn(`[site] WARNING: could not read ../docs (${(e as Error).message}); /docs shows its empty state.`); }
  const out: DocMeta[] = [];
  for (const entry of entries) {
    const { headings } = await render(entry);
    const h1 = headings.find((h: any) => h.depth === 1)?.text;
    const idx = PREFERRED.indexOf(entry.id);
    out.push({
      id: entry.id,
      title: entry.data.title ?? h1 ?? entry.id.replace(/[-_/]/g, ' ').replace(/^./, (c: string) => c.toUpperCase()),
      description: entry.data.description ?? firstParagraph(entry.body ?? ''),
      order: entry.data.order ?? (idx >= 0 ? idx : 100),
      edit: `${REPO_BLOB}/${String(entry.filePath ?? `docs/${entry.id}.md`).replace(/^(\.\.\/)+/, '')}`,
      entry,
    });
  }
  return out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}
