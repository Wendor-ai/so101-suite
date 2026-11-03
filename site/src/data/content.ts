// Build-time loaders for the app's pure-data content (learn, glossary, anatomy) and the modules folder.
// Everything is guarded: a missing or broken file logs one clear warning and the section degrades to an empty state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The repo root: walk up from where the build runs (site/), because after bundling this file no longer sits where its source does.
function findRepoRoot(): string {
  let d = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(d, 'pyproject.toml')) && fs.existsSync(path.join(d, 'app', 'suite'))) return d;
    d = path.dirname(d);
  }
  return path.resolve(here, '..', '..', '..');
}
const REPO_ROOT = findRepoRoot();

const contentModules = import.meta.glob('../../../app/suite/js/content/*.js') as Record<string, () => Promise<{ default?: unknown }>>;
const warned = new Set<string>();
const warn = (msg: string) => { if (!warned.has(msg)) { warned.add(msg); console.warn(`[site] WARNING: ${msg}`); } };

async function loadContent(name: string): Promise<any> {
  const key = Object.keys(contentModules).find((k) => k.endsWith(`/${name}.js`));
  if (!key) { warn(`app/suite/js/content/${name}.js not found: the "${name}" section is skipped.`); return null; }
  try {
    const mod = await contentModules[key]();
    return mod.default ?? null;
  } catch (e) {
    warn(`app/suite/js/content/${name}.js failed to load (${(e as Error).message}): the "${name}" section is skipped.`);
    return null;
  }
}

/** Accepts [..], {items:[..]}, {articles:[..]} or {id: {...}} and returns a clean array. */
function toArray(data: any, ...keys: string[]): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of keys) if (Array.isArray(data[k])) return data[k];
    return Object.entries(data).filter(([, v]) => v && typeof v === 'object').map(([id, v]: [string, any]) => ({ id, ...v }));
  }
  return [];
}

export type Block = string | { list: string[] } | { callout: { kind?: string; text: string } } | { steps: string[] } | Record<string, unknown>;
export interface Article { id: string; title: string; level: 'start' | 'next' | 'deep' | string; minutes?: number; summary?: string; body: Block[]; links: { label: string; href: string }[] }
export interface Term { id: string; term: string; short: string; long?: string; see: string[] }
export interface Part { id: string; title: string; what?: string; why?: string; joint?: string | null; motorId?: number | string | null }

let learnCache: Promise<Article[]> | null = null;
export function getLearn(): Promise<Article[]> {
  return (learnCache ??= (async () => {
    const raw = toArray(await loadContent('learn'), 'articles', 'items');
    return raw
      .filter((a) => a && a.id && (a.title || a.name))
      .map((a) => ({
        id: String(a.id), title: String(a.title ?? a.name), level: a.level ?? 'start', minutes: a.minutes, summary: a.summary ?? a.blurb ?? '',
        body: Array.isArray(a.body) ? a.body : [], links: Array.isArray(a.links) ? a.links.filter((l: any) => l?.href && l?.label) : [],
      }));
  })());
}

let glossCache: Promise<Term[]> | null = null;
export function getGlossary(): Promise<Term[]> {
  return (glossCache ??= (async () => {
    const raw = toArray(await loadContent('glossary'), 'terms', 'items');
    return raw
      .filter((t) => t && t.id && (t.term || t.title))
      .map((t) => ({ id: String(t.id), term: String(t.term ?? t.title), short: t.short ?? '', long: t.long ?? '', see: Array.isArray(t.see) ? t.see.map(String) : [] }))
      .sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }));
  })());
}

let anatomyCache: Promise<Part[]> | null = null;
export function getAnatomy(): Promise<Part[]> {
  return (anatomyCache ??= (async () => {
    const raw = toArray(await loadContent('anatomy'), 'parts', 'items');
    return raw.filter((p) => p && p.id && p.title).map((p) => ({ id: String(p.id), title: String(p.title), what: p.what, why: p.why, joint: p.joint ?? null, motorId: p.motorId ?? null }));
  })());
}

// ---------- the modules folder: one module.json per module ----------
export interface ModuleInfo { id: string; name: string; description: string; version?: string; author?: string; license?: string; requires: string[]; pages: { id: string; title: string }[]; hasBackend: boolean }
export function getModules(): ModuleInfo[] {
  const dir = path.join(REPO_ROOT, 'modules');
  if (!fs.existsSync(dir)) { warn('modules/ folder not found: the module gallery shows only the built-in feature.'); return []; }
  const out: ModuleInfo[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = path.join(dir, e.name, 'module.json');
    if (!fs.existsSync(f)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      out.push({
        id: String(m.id ?? e.name), name: String(m.name ?? m.id ?? e.name), description: String(m.description ?? ''),
        version: m.version, author: m.author, license: m.license,
        requires: Array.isArray(m.requires) ? m.requires.map(String) : [],
        pages: Array.isArray(m.pages) ? m.pages.map((p: any) => ({ id: String(p.id ?? ''), title: String(p.title ?? p.id ?? '') })) : [],
        hasBackend: !!m.backend,
      });
    } catch (err) { warn(`modules/${e.name}/module.json is not valid JSON (${(err as Error).message}): skipped.`); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- inline HTML from content strings (b, i, em, strong, code, kbd, br, a) ---------- */
const ALLOWED = new Set(['b', 'i', 'em', 'strong', 'code', 'kbd', 'br', 'a', 'span']);

/** Map an in-app hash route to the matching page of this site. */
export function siteHref(href: string, learnIds?: Set<string>): { href: string; external: boolean; app: boolean } {
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return { href: h, external: true, app: false };
  if (h.startsWith('#/')) {
    const route = h.slice(2).replace(/\/+$/, '');
    const [first, ...rest] = route.split('/');
    if (first === 'learn') {
      if (!rest.length) return { href: '/learn/', external: false, app: false };
      return { href: !learnIds || learnIds.has(rest[0]) ? `/learn/${rest[0]}/` : '/learn/', external: false, app: false };
    }
    if (first === 'glossary') return { href: rest.length ? `/glossary/#${rest[0]}` : '/glossary/', external: false, app: false };
    if (first === 'modules') return { href: '/modules/', external: false, app: false };
    return { href: `/demo/#/${route}`, external: false, app: true };
  }
  return { href: h, external: false, app: false };
}

export function inline(html: unknown, learnIds?: Set<string>): string {
  const s = String(html ?? '');
  return s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (_m, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return '';
    if (t === 'br') return '<br>';
    if (close) return `</${t}>`;
    if (t === 'a') {
      const m = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(attrs);
      const raw = (m?.[1] ?? m?.[2] ?? '').trim();
      if (!/^(https?:|#|\/)/.test(raw)) return '<a>';
      const { href, external, app } = siteHref(raw, learnIds);
      return `<a href="${href.replace(/"/g, '&quot;')}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}${app ? ' title="Opens in the live demo"' : ''}>`;
    }
    return `<${t}>`;
  });
}

/** Plain text of a content string (for meta descriptions). */
export const plain = (html: unknown) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
