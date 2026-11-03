// Scans dist/ and exits non-zero on problems:
//   - broken internal links, scripts, stylesheets, images (and #fragments that do not exist on the target page)
//   - <img> without an alt attribute, <iframe> without a title, target="_blank" without rel="noopener"
//   - pages without <html lang>, <title>, meta description or canonical; duplicate ids on a page
// The copied demo app under dist/app is a link target but is not itself scanned (it is another package's code).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(siteRoot, 'dist');
if (!fs.existsSync(dist)) { console.error('check: dist/ not found. Run `pnpm build` first.'); process.exit(2); }

const errors = [], warnings = [];
const err = (page, msg) => errors.push(`${page}: ${msg}`);

const htmlFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!(d === dist && e.name === 'app')) walk(p); }
    else if (e.name.endsWith('.html')) htmlFiles.push(p);
  }
})(dist);

// redirect sources from public/_redirects count as valid targets
const redirects = new Set();
try {
  for (const line of fs.readFileSync(path.join(siteRoot, 'public', '_redirects'), 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    redirects.add(t.split(/\s+/)[0]);
  }
} catch { /* none */ }

const exists = (p) => fs.existsSync(p);
function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath);
  const abs = path.join(dist, clean);
  if (!abs.startsWith(dist)) return null;
  if (clean.endsWith('/')) return exists(path.join(abs, 'index.html')) ? path.join(abs, 'index.html') : null;
  if (exists(abs) && fs.statSync(abs).isFile()) return abs;
  if (exists(abs + '.html')) return abs + '.html';
  if (exists(path.join(abs, 'index.html'))) return path.join(abs, 'index.html');
  return null;
}

const idCache = new Map();
function idsOf(file) {
  if (!idCache.has(file)) {
    const html = fs.readFileSync(file, 'utf8');
    const set = new Set();
    for (const m of html.matchAll(/\s(?:id|name)\s*=\s*"([^"]+)"/g)) set.add(m[1]);
    idCache.set(file, set);
  }
  return idCache.get(file);
}

let linkCount = 0;
for (const file of htmlFiles) {
  const rel = '/' + path.relative(dist, file).split(path.sep).join('/');
  const pageUrl = rel.replace(/index\.html$/, '').replace(/\.html$/, '');
  const html = fs.readFileSync(file, 'utf8');

  // document basics
  if (!/<html[^>]*\slang="[^"]+"/.test(html)) err(rel, 'missing <html lang>');
  if (!/<title>[^<]+<\/title>/.test(html)) err(rel, 'missing <title>');
  if (!/<meta name="description" content="[^"]+"/.test(html)) err(rel, 'missing meta description');
  if (!/<link rel="canonical" href="[^"]+"/.test(html)) err(rel, 'missing canonical link');

  // images, frames, new-tab links
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) if (!/\salt\s*=/.test(m[0])) err(rel, `<img> without alt: ${m[0].slice(0, 120)}`);
  for (const m of html.matchAll(/<iframe\b[^>]*>/gi)) if (!/\stitle\s*=\s*"[^"]+"/.test(m[0])) err(rel, `<iframe> without a title: ${m[0].slice(0, 120)}`);
  for (const m of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/gi)) if (!/\srel="[^"]*noopener/.test(m[0])) err(rel, `target="_blank" without rel="noopener": ${m[0].slice(0, 120)}`);

  // duplicate ids
  const seen = new Set();
  for (const m of html.matchAll(/\sid\s*=\s*"([^"]+)"/g)) { if (seen.has(m[1])) err(rel, `duplicate id "${m[1]}"`); seen.add(m[1]); }

  // links and resources
  const re = /<(a|link|script|img|source|iframe)\b[^>]*?\s(href|src)\s*=\s*"([^"]*)"/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[1].toLowerCase(), url = m[3].trim();
    if (!url || /^(mailto:|tel:|javascript:|data:|blob:|https?:|\/\/)/i.test(url)) continue;
    if (tag === 'link' && /rel="(canonical|sitemap)"/.test(m[0])) continue;
    if (url.startsWith('#/')) continue;                         // app route, not a page fragment
    linkCount++;
    const u = new URL(url, 'http://x' + pageUrl);
    const target = u.pathname;
    if (target.startsWith('/app/') || target === '/app') {       // demo app: must exist in dist
      const f = resolveFile(target === '/app' ? '/app/' : target);
      if (!f) err(rel, `broken link to ${url} (demo app file missing: run pnpm sync)`);
      continue;
    }
    const f = resolveFile(target);
    if (!f && !redirects.has(target.replace(/\/$/, '')) && !redirects.has(target)) { err(rel, `broken ${tag === 'a' ? 'link' : tag + ' ' + m[2]}: ${url}`); continue; }
    if (f && u.hash.length > 1 && f.endsWith('.html')) {
      const id = decodeURIComponent(u.hash.slice(1));
      if (!id.startsWith('/') && !idsOf(f).has(id)) err(rel, `link to ${url}: no element with id "${id}" on the target page`);
    }
  }
}

// expected deploy-time extras
for (const f of ['robots.txt', 'sitemap-index.xml', '_headers']) if (!exists(path.join(dist, f))) err('dist', `missing ${f}`);
if (!exists(path.join(dist, 'og.png'))) warnings.push('og.png is not there yet: screenshot /og at 1200x630 into public/og.png before launch (social cards use it).');
if (!exists(path.join(dist, 'app', 'index.html'))) warnings.push('app/index.html is missing: /demo has nothing to load. Run `pnpm sync` (needs ../app/suite).');
if (!exists(path.join(dist, 'screenshots'))) warnings.push('No screenshots yet: pages show placeholders until docs/screenshots/*.png exist.');

for (const w of warnings) console.warn(`warn  ${w}`);
if (errors.length) {
  console.error(`\n${errors.length} problem${errors.length > 1 ? 's' : ''} found:`);
  for (const e of errors) console.error(`  x ${e}`);
  process.exit(1);
}
console.log(`ok    ${htmlFiles.length} pages, ${linkCount} internal links and resources checked: no broken links, no missing alt text.`);
