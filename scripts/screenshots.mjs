#!/usr/bin/env node
// Takes the README and website screenshots from the app's built-in demo (simulated hardware, fixed seed)
// with the Chrome you already have. No dependencies: it talks to Chrome over the DevTools protocol using
// Node's built-in WebSocket (Node 22+). It serves the app itself, so no Python and no npm install are needed.
//
//   node scripts/screenshots.mjs                      # every screenshot into docs/screenshots/
//   node scripts/screenshots.mjs --only home,setup    # just these
//   node scripts/screenshots.mjs --base http://127.0.0.1:8110/suite/   # use a running app instead of the built-in demo server
//   node scripts/screenshots.mjs --out /tmp/shots --theme light
//   CHROME_PATH=/path/to/chrome node scripts/screenshots.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : a), []));
const OUT = path.resolve(args.out || path.join(root, 'docs', 'screenshots'));
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const THEME = args.theme || 'dark';

/* ---------- a tiny static server for app/suite (same URL layout as the real app) ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.stl': 'model/stl', '.urdf': 'application/xml' };
function serve() {
  const map = [['/suite/vendor/', 'app/vendor'], ['/suite/assets/', 'app/assets'], ['/suite/modules/', 'modules'], ['/suite/', 'app/suite']];
  return new Promise((ok) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/suite') p = '/suite/';
      if (p === '/suite/') p = '/suite/index.html';
      for (const [prefix, dir] of map) {
        if (!p.startsWith(prefix)) continue;
        const file = path.resolve(root, dir, p.slice(prefix.length));
        if (!file.startsWith(path.resolve(root, dir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) break;
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
        return fs.createReadStream(file).pipe(res);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    }).listen(0, '127.0.0.1', () => ok({ server: s, base: `http://127.0.0.1:${s.address().port}/suite/` }));
  });
}

/* ---------- Chrome over the DevTools protocol ---------- */
function findChrome() {
  const c = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  const found = c.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('Could not find Chrome. Set CHROME_PATH to a Chrome or Chromium executable.');
  return found;
}
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'so101-shots-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(findChrome(), [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let up = false; for (let i = 0; i < 400 && !up; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); up = true; } catch { await sleep(150); } }
  if (!up) { try { proc.kill(); } catch { /* gone */ } fs.rmSync(profile, { recursive: true, force: true }); throw new Error("Chrome did not start listening within 60 seconds (is the computer very busy?)"); }
  const close = () => { try { proc.kill(); } catch { /* already gone */ } setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 600); };
  return { port, close };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(port) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  const P = {
    errors,
    async open(url, { w = 1440, h = 900, mobile = false } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });   // no entrance animation in the picture
      await send('Page.navigate', { url });
      await sleep(900);
    },
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
    sleep,
    async waitFor(expr, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await P.eval(expr)) return true; } catch { /* page still loading */ } await sleep(150); } return false; },
    async shot(file) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); },
    /** click the first visible button/link/tab whose text contains `text` (case-insensitive) */
    async clickText(text, scope = 'main') {
      const pt = await P.eval(`(() => { const t = ${JSON.stringify(text)}.toLowerCase(); const root = document.querySelector(${JSON.stringify(scope)}) || document;
        const el = [...root.querySelectorAll('button,a,[role=tab],.chip,.tab,summary')].find((e) => e.offsetParent && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && e.textContent.trim().toLowerCase().includes(t));
        if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!pt) return false;
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await sleep(350); return true;
    },
    async clickAt(x, y) { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await sleep(300); },
    close() { ws.close(); },
  };
  return P;
}

/* ---------- the shots ---------- */
const calm = (p) => p.eval(`document.querySelector('.dlg-back:not(.pal-back)')?.remove(); document.querySelector('#toasts')?.replaceChildren(); true`);
const wait3d = (p) => p.waitFor(`!!document.querySelector('.twin canvas')`, 12000).then(() => p.sleep(2200));
const SHOTS = [
  { name: 'home', hash: '', prep: async (p) => { await wait3d(p); } },
  { name: 'welcome', hash: 'welcome' },
  { name: 'setup', hash: 'setup' },
  { name: 'motors', hash: 'motors' },
  { name: 'assemble', hash: 'assemble' },
  { name: 'calibrate', hash: 'calibrate', prep: async (p) => {
    // the same two calls the buttons make: start (arm goes limp), then "it's centred"; the simulated hand then sweeps the joints
    await p.eval(`(async () => { await so101.api.post('/api/calib/0/start'); await new Promise((r) => setTimeout(r, 900)); await so101.api.post('/api/calib/0/center'); })()`);
    await p.sleep(7000); await wait3d(p); await p.sleep(1500); } },
  { name: 'cameras', hash: 'cameras' },
  { name: 'test', hash: 'test', prep: async (p) => { await p.clickText('Ping'); await p.sleep(500); } },
  { name: 'inspector', hash: 'inspector', prep: async (p) => { await p.eval(`document.querySelector('input[type=checkbox]')?.click(); true`); await p.sleep(3500); } },
  { name: 'learn', hash: 'learn' },
  { name: 'anatomy', hash: 'learn/meet-your-arm', prep: async (p) => { await wait3d(p); } },
  { name: 'help', hash: 'help' },
  { name: 'modules', hash: 'modules' },
  { name: 'settings', hash: 'settings' },
  { name: 'control', hash: 'control', scenario: 'ready', prep: async (p) => { await wait3d(p); } },
  { name: 'palette', hash: '', prep: async (p) => { await wait3d(p); await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`); await p.sleep(600); } },
  { name: 'mobile-home', hash: '', w: 390, h: 844, mobile: true, prep: async (p) => { await wait3d(p); } },
];

// One page, one picture (for example the website's social preview):
//   node scripts/screenshots.mjs --url http://127.0.0.1:8141/og/ --size 1200x630 --to site/public/og.png
if (args.url) {
  const [w, h] = (args.size || '1440x900').split('x').map(Number);
  const c = await launch();
  try { const p = await page(c.port); await p.open(args.url, { w, h }); await p.sleep(1800); await p.shot(path.resolve(args.to || 'shot.png')); console.log(`ok  ${args.to || 'shot.png'}`); }
  finally { c.close(); }
  process.exit(0);
}

const { server, base: ownBase } = args.base ? { server: null, base: args.base } : await serve();
const chrome = await launch();
let failed = 0;
try {
  for (const s of SHOTS) {
    if (ONLY && !ONLY.has(s.name)) continue;
    const p = await page(chrome.port);
    const url = `${ownBase}?demo=1&seed=1&theme=${THEME}&scenario=${s.scenario || 'fresh'}#/${s.hash}`;
    await p.open(url, { w: s.w, h: s.h, mobile: s.mobile });
    const ready = await p.waitFor(`!!document.querySelector('main > *') && document.title.length > 0`, 12000);
    await p.sleep(1200); await calm(p);
    try { await s.prep?.(p); } catch (e) { console.warn(`  ! ${s.name}: ${e.message.split('\n')[0]}`); }
    await calm(p); await p.sleep(400);
    await p.shot(path.join(OUT, `${s.name}.png`));
    const bad = p.errors.filter((e) => !/favicon|WebGL|GPU stall|swiftshader/i.test(e));
    if (!ready || bad.length) { failed++; console.warn(`  ! ${s.name}: ${!ready ? 'page never rendered' : 'console errors: ' + bad.slice(0, 2).join(' | ').slice(0, 300)}`); }
    console.log(`${bad.length || !ready ? 'x' : 'ok'}  ${s.name}.png`);
    p.close();
  }
} finally { chrome.close(); server?.close(); }
console.log(failed ? `\n${failed} screenshot(s) had problems (see above).` : `\nAll screenshots written to ${path.relative(process.cwd(), OUT) || '.'}`);
process.exit(failed ? 1 : 0);
