// Remark plugin for rendered docs (docs/*.md). Relative links and images are written for GitHub, so fix them for the site:
//   other doc   (foo.md, ./foo.md#x, ../docs/foo.md)   -> /docs/foo/
//   docs/screenshots/x.png                              -> /screenshots/x.png
//   any other repo file (../app/server.py, AGENTS.md)   -> GitHub blob URL (new tab)
// It runs before Astro collects local images, so a doc that mentions a picture that does not exist can never fail the build.
import path from 'node:path';
import fs from 'node:fs';

const REPO_BLOB = 'https://github.com/Wendor-ai/so101-suite/blob/main';
const REPO_TREE = 'https://github.com/Wendor-ai/so101-suite/tree/main';
const REPO_RAW = 'https://github.com/Wendor-ai/so101-suite/raw/main';
// docs live in <repo>/docs. SITE_DOCS_DIR (testing only) points at another folder named docs.
const docsRoot = process.env.SITE_DOCS_DIR ? path.resolve(process.env.SITE_DOCS_DIR) : path.resolve(process.cwd(), '..', 'docs');
const repoRoot = path.dirname(docsRoot);
const HIDDEN = /^(superpowers|design)\//;

function fix(url, fileDir, isImage) {
  if (!url || /^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) return { url, external: /^https?:/i.test(url) };
  const m = /^([^?#]*)(.*)$/.exec(url); const p = m[1], rest = m[2];
  if (p.startsWith('/')) return { url, external: false };            // site-absolute: leave alone
  const abs = path.resolve(fileDir, p);
  const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return { url, external: false };
  if (rel.startsWith('docs/screenshots/')) return { url: '/' + rel.slice('docs/'.length) + rest, external: false };
  const inDocs = rel.slice('docs/'.length);
  if (rel.startsWith('docs/') && /\.mdx?$/i.test(rel) && !HIDDEN.test(inDocs) && inDocs !== 'LEARNINGS.md') {
    return { url: `/docs/${inDocs.replace(/\.mdx?$/i, '').toLowerCase()}/${rest}`, external: false };
  }
  if (isImage) return { url: `${REPO_RAW}/${rel}`, external: true };
  const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  return { url: `${isDir ? REPO_TREE : REPO_BLOB}/${rel}${rest}`, external: true };
}

function walk(node, fn) { fn(node); if (node.children) for (const c of node.children) walk(c, fn); }

export function rewriteDocLinks() {
  return (tree, file) => {
    const filePath = file?.path || file?.history?.[0] || '';
    const fileDir = filePath ? path.dirname(filePath) : docsRoot;
    walk(tree, (n) => {
      if (n.type === 'link' || n.type === 'definition') {
        const r = fix(n.url, fileDir, false);
        n.url = r.url;
        if (r.external && n.type === 'link') n.data = { ...(n.data || {}), hProperties: { ...(n.data?.hProperties || {}), target: '_blank', rel: 'noopener noreferrer' } };
      } else if (n.type === 'image') {
        const r = fix(n.url, fileDir, true);
        n.url = r.url;
        n.data = { ...(n.data || {}), hProperties: { ...(n.data?.hProperties || {}), loading: 'lazy', decoding: 'async' } };
      }
    });
  };
}
