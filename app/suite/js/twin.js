// Reusable 3D SO-101 built from the official URDF + STL meshes (Apache-2.0, see app/assets/so101/LICENSE).
// mountTwin(el, {pose, highlight, view, interactive, onPick}) -> controller {setPose, setHighlight, setView, ready, destroy}
// The same code runs in the live app and on the website (vendor/ and assets/ are resolved relative to the suite root).
import { h, icon } from './ui.js';

const BASE = new URL('../vendor/', import.meta.url).href;
const ASSET = new URL('../assets/so101/', import.meta.url).href;
let threeP = null;
const loadScript = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('Could not load ' + src)); document.head.append(s); });
function ensureThree() {
  if (window.THREE?.OrbitControls && window.THREE?.STLLoader) return Promise.resolve(window.THREE);
  threeP ||= loadScript(BASE + 'three.min.js').then(() => Promise.all([loadScript(BASE + 'OrbitControls.js'), loadScript(BASE + 'STLLoader.js')])).then(() => window.THREE);
  return threeP;
}
let urdfP = null;
const urdf = () => (urdfP ||= fetch(ASSET + 'so101_new_calib.urdf').then((r) => { if (!r.ok) throw new Error('3D model not found'); return r.text(); }).then((t) => new DOMParser().parseFromString(t, 'text/xml')));
const stlCache = new Map();
const loadSTL = (THREE, f) => { f = f.split('/').pop(); if (!stlCache.has(f)) stlCache.set(f, new Promise((ok, no) => new THREE.STLLoader().load(ASSET + f, ok, undefined, no))); return stlCache.get(f); };

const nums = (s) => (s || '0 0 0').trim().split(/\s+/).map(Number);
const kid = (el, tag) => [...el.children].filter((c) => c.tagName === tag);
const rad = (d) => (d * Math.PI) / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function setOrigin(o, el) { if (!el) return; const p = nums(el.getAttribute('xyz')), r = nums(el.getAttribute('rpy')); o.position.set(...p); o.rotation.set(r[0], r[1], r[2], 'ZYX'); }

async function buildArm(THREE, doc, onMesh) {
  const shell = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.4, metalness: 0.08 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.5, metalness: 0.35 });
  const root = new THREE.Group(), zup = new THREE.Group();
  zup.rotation.x = -Math.PI / 2; zup.scale.setScalar(100); root.add(zup);
  const links = {}, byLink = {}, joints = {}, children = new Set();
  const top = [...doc.documentElement.children];
  top.filter((e) => e.tagName === 'link').forEach((l) => {
    const name = l.getAttribute('name'), g = new THREE.Group();
    links[name] = g; byLink[name] = [];
    kid(l, 'visual').forEach((v) => {
      const mesh = kid(v, 'geometry')[0]?.querySelector('mesh'); if (!mesh) return;
      const mat = kid(v, 'material')[0]?.getAttribute('name'), holder = new THREE.Group();
      setOrigin(holder, kid(v, 'origin')[0]); g.add(holder);
      loadSTL(THREE, mesh.getAttribute('filename')).then((geo) => {
        const m = new THREE.Mesh(geo, (mat === '3d_printed' ? shell : dark).clone());
        m.userData.link = name; byLink[name].push(m); holder.add(m); onMesh?.(m);
      });
    });
  });
  top.filter((e) => e.tagName === 'joint').forEach((j) => {
    const parent = links[kid(j, 'parent')[0].getAttribute('link')], cn = kid(j, 'child')[0].getAttribute('link'), child = links[cn];
    children.add(cn);
    const og = new THREE.Group(); setOrigin(og, kid(j, 'origin')[0]); parent.add(og);
    const rotor = new THREE.Group(); og.add(rotor); rotor.add(child);
    if (j.getAttribute('type') === 'revolute') {
      const lim = kid(j, 'limit')[0];
      joints[j.getAttribute('name')] = { rotor, axis: new THREE.Vector3(...nums(kid(j, 'axis')[0].getAttribute('xyz'))).normalize(), lo: +lim.getAttribute('lower'), hi: +lim.getAttribute('upper') };
    }
  });
  zup.add(links[Object.keys(links).find((n) => !children.has(n))]);
  return { root, joints, links, byLink, linkNames: Object.keys(links) };
}

const VIEWS = { profile: [[17, 31, 128], [17, 23, 0]], hero: [[52, 44, 84], [0, 15, 0]], front: [[0, 30, 110], [0, 18, 0]], side: [[110, 28, 0], [0, 18, 0]], top: [[0.1, 140, 0.1], [0, 0, 0]], close: [[34, 30, 48], [0, 20, 0]] };
const NO_GL = (el, why) => { el.append(h('div', { class: 'empty', style: { height: '100%', border: 0 } }, icon('arm'), h('h3', {}, '3D view unavailable'), h('p', {}, why))); return { ready: Promise.resolve(), setPose() {}, setHighlight() {}, setView() {}, destroy() {} }; };

export function mountTwin(el, { pose = {}, highlight = null, view = 'hero', interactive = true, zoom = false, onPick = null, autoRotate = false } = {}) {
  el.classList.add('twin');
  const loading = h('div', { class: 'hint' }, 'Loading 3D model…');
  el.append(loading);
  let destroyed = false, raf = 0, ro, io;
  const ctl = { setPose() {}, setHighlight() {}, setView() {}, destroy() { destroyed = true; }, ready: null };
  ctl.ready = (async () => {
    let THREE;
    try { THREE = await ensureThree(); } catch (e) { loading.remove(); Object.assign(ctl, NO_GL(el, String(e.message))); return; }
    if (destroyed) return;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch { loading.remove(); Object.assign(ctl, NO_GL(el, 'Your browser could not start WebGL, which draws the 3D arm. Everything else still works.')); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.8;
    el.prepend(renderer.domElement); renderer.domElement.style.touchAction = 'pan-y';
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38, 1, 5, 700);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, enablePan: false, enableZoom: zoom, enableRotate: interactive, maxPolarAngle: Math.PI * 0.495, minDistance: 40, maxDistance: 180, autoRotate, autoRotateSpeed: 0.8 });
    scene.add(new THREE.HemisphereLight(0xe2eeff, 0x3a2a18, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7); sun.position.set(40, 90, 50); scene.add(sun);
    const line = getComputedStyle(document.documentElement).getPropertyValue('--line2').trim() || '#2c394b';
    const grid = new THREE.GridHelper(200, 20, new THREE.Color(line), new THREE.Color(line)); grid.material.transparent = true; grid.material.opacity = 0.55; scene.add(grid);
    let hl = new Set(highlight || []);
    const accent = () => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff8a1f');
    const paint = (m) => {
      const on = hl.has(m.userData.link); m.userData.base ||= m.material.color.clone();
      m.material.color.copy(m.userData.base); if (on) m.material.color.lerp(accent(), 0.7);          // tint toward the accent: visible on the white parts too
      m.material.emissive.copy(on ? accent() : new THREE.Color(0)); m.material.emissiveIntensity = on ? 0.35 : 0;
    };
    const arm = await buildArm(THREE, await urdf(), paint);
    if (destroyed) { renderer.dispose(); return; }
    scene.add(arm.root); loading.remove();
    let target = { ...pose }; const cur = {};
    const apply = () => {
      for (const [n, j] of Object.entries(arm.joints)) {
        const t = n === 'gripper' ? j.lo + clamp((target.gripper ?? 0) / 100, 0, 1) * (j.hi - j.lo) : rad(target[n] || 0);
        cur[n] = (cur[n] ?? t) + (t - (cur[n] ?? t)) * 0.25;
        j.rotor.quaternion.setFromAxisAngle(j.axis, cur[n]);
      }
    };
    let tween = null;
    const setView = (name) => { const v = VIEWS[name] || VIEWS.hero; tween = { t0: performance.now(), p0: camera.position.clone(), q0: controls.target.clone(), p1: new THREE.Vector3(...v[0]), q1: new THREE.Vector3(...v[1]) }; };
    const v0 = VIEWS[view] || VIEWS.hero; camera.position.set(...v0[0]); controls.target.set(...v0[1]);
    const resize = () => { const w = el.clientWidth || 300, hh = el.clientHeight || 280; renderer.setSize(w, hh, false); camera.aspect = w / hh; camera.updateProjectionMatrix(); };
    ro = new ResizeObserver(resize); ro.observe(el); resize();
    let visible = true; io = new IntersectionObserver((e) => { visible = e[0].isIntersecting; }); io.observe(el);
    const loop = () => {
      raf = requestAnimationFrame(loop); if (!visible || document.hidden) return;
      apply(); controls.update();
      if (tween) { const k = Math.min(1, (performance.now() - tween.t0) / 800), e = k * k * (3 - 2 * k); camera.position.lerpVectors(tween.p0, tween.p1, e); controls.target.lerpVectors(tween.q0, tween.q1, e); if (k >= 1) tween = null; }
      renderer.render(scene, camera);
    };
    loop();
    if (onPick) {
      const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(); let down = null;
      renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
      renderer.domElement.addEventListener('pointerup', (e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
        const r = renderer.domElement.getBoundingClientRect();
        ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, camera);
        const hit = ray.intersectObjects(Object.values(arm.byLink).flat(), false)[0];
        onPick(hit ? hit.object.userData.link : null);
      });
    }
    Object.assign(ctl, {
      setPose(p) { target = { ...target, ...p }; },
      setHighlight(names) { hl = new Set(names || []); Object.values(arm.byLink).flat().forEach(paint); },
      setView,
      links: arm.linkNames,
      destroy() { destroyed = true; cancelAnimationFrame(raf); ro?.disconnect(); io?.disconnect(); renderer.dispose(); renderer.domElement.remove(); },
    });
  })().catch((e) => { loading.remove(); Object.assign(ctl, NO_GL(el, String(e.message || e))); });
  return ctl;
}
