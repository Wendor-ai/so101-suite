// Copies the real app into the site so /demo can run it with no backend:
//   ../app/suite            -> public/app            (index.html, css/, js/ ...)
//   ../app/vendor           -> public/app/vendor     (three.js and friends)
//   ../app/assets           -> public/app/assets     (URDF + STL + licence only)
//   ../docs/screenshots/*   -> public/screenshots
// Idempotent and fast: unchanged files are skipped, files that no longer exist upstream are removed.
// Uses copy-on-write clones where the filesystem supports them (APFS), so the 15 MB STL set costs no extra disk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(siteRoot, '..');
const pub = path.join(siteRoot, 'public');

const SKIP_DIR = new Set(['node_modules', '.git', '__pycache__', 'tests', 'test']);
const SKIP_FILE = /(^\.DS_Store$|\.test\.[cm]?js$|\.spec\.[cm]?js$|\.map$|\.py$|\.pyc$|^README(\.md)?$)/i;
const ASSET_OK = /(\.(urdf|stl|glb|gltf|svg|png|jpe?g|webp|json)$|^(LICENSE|NOTICE|COPYING)[^/]*$)/i;
const SHOT_OK = /\.(png|jpe?g|webp)$/i;

function walk(dir, accept, base = dir, out = new Map()) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(abs, accept, base, out); }
    else if (e.isFile() && accept(e.name, abs)) out.set(path.relative(base, abs).split(path.sep).join('/'), abs);
  }
  return out;
}

/** Build the wanted map (relative dest path -> absolute source path). */
function plan() {
  const want = new Map();
  const add = (map, prefix) => { for (const [rel, abs] of map) want.set(prefix + rel, abs); };
  const suiteDir = path.join(repo, 'app', 'suite');
  if (!fs.existsSync(path.join(suiteDir, 'index.html'))) {
    console.warn('[sync-app] WARNING: ../app/suite/index.html not found. /demo will show its fallback message.');
  }
  add(walk(suiteDir, (n) => !SKIP_FILE.test(n)), 'app/');
  add(walk(path.join(repo, 'app', 'vendor'), (n) => !SKIP_FILE.test(n)), 'app/vendor/');
  add(walk(path.join(repo, 'app', 'assets'), (n) => ASSET_OK.test(n) && !/^\.DS_Store$/.test(n)), 'app/assets/');
  add(walk(path.join(repo, 'modules'), (n) => /\.(js|css|json|svg|png)$/i.test(n) && !SKIP_FILE.test(n)), 'app/modules/');   // module UIs: the app imports them from ../modules/<id>/ui.js
  add(walk(path.join(repo, 'docs', 'screenshots'), (n) => SHOT_OK.test(n)), 'screenshots/');
  return want;
}

function same(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    return sa.size === sb.size && Math.abs(sa.mtimeMs - sb.mtimeMs) < 2;
  } catch { return false; }
}

function prune(dir, wantedRel, base, removed) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      prune(abs, wantedRel, base, removed);
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } else {
      const rel = path.relative(pub, abs).split(path.sep).join('/');
      if (!wantedRel.has(rel)) { fs.rmSync(abs); removed.n++; }
    }
  }
}

const t0 = performance.now();
const want = plan();
let copied = 0, kept = 0;
for (const [rel, src] of want) {
  const dest = path.join(pub, rel);
  if (same(src, dest)) { kept++; continue; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
  const st = fs.statSync(src);
  fs.utimesSync(dest, st.atime, st.mtime);
  copied++;
}
const removed = { n: 0 };
for (const dir of ['app', 'screenshots']) prune(path.join(pub, dir), new Set(want.keys()), pub, removed);

const hasApp = fs.existsSync(path.join(pub, 'app', 'index.html'));
console.log(`[sync-app] ${copied} copied, ${kept} unchanged, ${removed.n} removed in ${Math.round(performance.now() - t0)} ms. app: ${hasApp ? 'ok' : 'MISSING'}`);
