// Synthetic camera pictures for the demo: a top-down and an oblique view of the same simulated table.
// Pure geometry + a tiny 2D-canvas painter. sceneModel() needs no canvas, so tests and Node can use it.
// World frame = the robot's base frame in metres: x forward (away from the base), y left, z up. The table surface is at z = TABLE_Z
// (the height the gripper tip reads when it touches the table, as in pickplace.py).
export const TABLE_Z = -0.008;
export const IMG = { w: 640, h: 480 };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function makeCamera({ at, look, up, f }) {
  const fw = norm(sub(look, at));
  const right = norm(cross(fw, up));
  const upv = cross(right, fw);
  const cx = IMG.w / 2, cy = IMG.h / 2;
  return {
    f, at, fw, right, up: upv,
    /** world point -> {u, v, depth, k} (k = pixels per metre at that depth) */
    project(p) {
      const d = sub(p, at);
      const z = dot(d, fw);
      const k = f / Math.max(0.01, z);
      return { u: cx + k * dot(d, right), v: cy - k * dot(d, upv), depth: z, k };
    },
    /** pixel -> world point on the horizontal plane at height zPlane */
    unproject(u, v, zPlane = TABLE_Z) {
      const dx = (u - cx) / f, dy = -(v - cy) / f;
      const dir = [fw[0] + dx * right[0] + dy * upv[0], fw[1] + dx * right[1] + dy * upv[1], fw[2] + dx * right[2] + dy * upv[2]];
      const s = (zPlane - at[2]) / dir[2];
      return [at[0] + s * dir[0], at[1] + s * dir[1], zPlane];
    },
  };
}

// Camera 1: overhead, base at the bottom edge. Camera 2: from the far side, low and oblique, so it sees height.
export const CAMERAS = [
  makeCamera({ at: [0.17, -0.03, 0.95], look: [0.17, -0.03, TABLE_Z], up: [1, 0, 0], f: 1180 }),
  makeCamera({ at: [0.56, 0.2, 0.34], look: [0.15, -0.05, TABLE_Z + 0.03], up: [0, 0, 1], f: 640 }),
];
export const cameraFor = (i) => CAMERAS[Math.abs(i | 0) % CAMERAS.length];
export const project = (i, p) => cameraFor(i).project(p);
export const unproject = (i, u, v, z = TABLE_Z) => cameraFor(i).unproject(u, v, z);

// The table: a blue cutting mat on a wooden desk.
export const MAT = { x0: -0.06, x1: 0.4, y0: -0.27, y1: 0.24 };

const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function ring(cx, cy, r, z, n = 28) {
  const out = [];
  for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]); }
  return out;
}
const rectPts = (cx, cy, hx, hy, ang, z) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([a, b]) => [cx + a * c - b * s, cy + a * s + b * c, z]);
};

/**
 * What the camera sees, as a list of flat shapes in 640x480 picture coordinates.
 * world = {
 *   keychain: {x, y, z, ang, visible}, bowl: {x, y, r, h}, tray: {x, y, hx, hy},
 *   arm: null | {pts: [[x,y,z]...base..tip], dir: [x,y,z] (gripper approach), open: 0..1},
 *   overlay: null | {found:[{u,v,w,h,angle,partial}], taught:[{u,v}], zones:{tray:{p,r}, bowl:{p,r}}}
 * }
 */
export function sceneModel(i, t, world = {}, opts = {}) {
  const cam = cameraFor(i);
  const P = (p) => { const q = cam.project(p); return [q.u, q.v]; };
  const poly = (pts3, fill, stroke, lw = 1) => ({ k: 'poly', pts: pts3.map(P), fill, stroke, lw });
  const shapes = [];
  const meta = { cam: i, t, tip: null, keychain: null, bowl: null, tray: null, base: null };

  // wood desk + grain (fixed per camera: the "noise" of the picture is added at paint time)
  const grain = mulberry32(9000 + i * 17);
  shapes.push({ k: 'rect', x: 0, y: 0, w: IMG.w, h: IMG.h, fill: '#8a6a47' });
  for (let g = 0; g < 46; g++) {
    const y = grain() * IMG.h, x0 = grain() * IMG.w, len = 120 + grain() * 320;
    shapes.push({ k: 'line', pts: [[x0 - len, y], [x0 + len, y + (grain() - 0.5) * 10]], stroke: grain() > 0.5 ? 'rgba(60,38,20,0.18)' : 'rgba(255,225,170,0.10)', lw: 1 + grain() * 2 });
  }
  // cutting mat with a 5 cm grid
  const Z0 = TABLE_Z;
  const mat = [[MAT.x0, MAT.y0], [MAT.x1, MAT.y0], [MAT.x1, MAT.y1], [MAT.x0, MAT.y1]].map(([x, y]) => [x, y, Z0]);
  shapes.push(poly(mat, '#40607f', 'rgba(15,25,38,0.9)', 3));
  for (let x = Math.ceil(MAT.x0 / 0.05) * 0.05; x < MAT.x1; x += 0.05) shapes.push({ k: 'line', pts: [P([x, MAT.y0, Z0]), P([x, MAT.y1, Z0])], stroke: 'rgba(210,230,255,0.13)', lw: 1 });
  for (let y = Math.ceil(MAT.y0 / 0.05) * 0.05; y < MAT.y1; y += 0.05) shapes.push({ k: 'line', pts: [P([MAT.x0, y, Z0]), P([MAT.x1, y, Z0])], stroke: 'rgba(210,230,255,0.13)', lw: 1 });

  // the robot base (a clamped block) so the table has an origin
  const baseC = P([0.0, 0, Z0 + 0.03]);
  meta.base = { u: baseC[0], v: baseC[1] };
  const bb = rectPts(0.0, 0, 0.055, 0.05, 0, Z0);
  shapes.push(poly(bb, 'rgba(0,0,0,0.25)', null));
  shapes.push(poly(rectPts(0.0, 0, 0.05, 0.045, 0, Z0 + 0.045), '#2f3640', '#1b2028', 2));

  // blue tray
  const tr = world.tray;
  if (tr) {
    const base = rectPts(tr.x, tr.y, tr.hx, tr.hy, 0, Z0), top = rectPts(tr.x, tr.y, tr.hx, tr.hy, 0, Z0 + 0.022);
    shapes.push(poly(base, 'rgba(0,0,0,0.28)', null));
    for (let k = 0; k < 4; k++) shapes.push(poly([base[k], base[(k + 1) % 4], top[(k + 1) % 4], top[k]], k % 2 ? '#2f7fc4' : '#3a8fd6', '#1c4f80', 1));
    shapes.push(poly(rectPts(tr.x, tr.y, tr.hx - 0.008, tr.hy - 0.008, 0, Z0 + 0.004), '#7cc0f2', '#2a6fae', 1));
    shapes.push(poly(top, null, '#a8d8ff', 2));
    const c = P([tr.x, tr.y, Z0 + 0.01]);
    meta.tray = { u: c[0], v: c[1], r: Math.hypot(tr.hx, tr.hy) * cam.project([tr.x, tr.y, Z0 + 0.01]).k * 0.8 };
  }
  // pink bowl
  const bw = world.bowl;
  if (bw) {
    const lo = ring(bw.x, bw.y, bw.r * 0.78, Z0), hi = ring(bw.x, bw.y, bw.r, Z0 + bw.h);
    shapes.push(poly(ring(bw.x + 0.006, bw.y - 0.006, bw.r * 0.95, Z0), 'rgba(0,0,0,0.28)', null));
    for (let k = 0; k < lo.length; k++) {
      const n = (k + 1) % lo.length;
      shapes.push(poly([lo[k], lo[n], hi[n], hi[k]], k % 5 < 2 ? '#e58fa8' : '#eda1b6', null));
    }
    shapes.push(poly(hi, '#f6b8c9', '#fbd6e0', 2));
    shapes.push(poly(ring(bw.x, bw.y, bw.r * 0.8, Z0 + bw.h * 0.45), '#f9ccd8', null));
    const c = P([bw.x, bw.y, Z0 + bw.h]);
    meta.bowl = { u: c[0], v: c[1], r: bw.r * cam.project([bw.x, bw.y, Z0 + bw.h]).k };
  }
  // red keychain (a rounded card with a little ring)
  const kc = world.keychain;
  if (kc && kc.visible !== false) {
    const z = kc.z ?? Z0 + 0.004;
    shapes.push(poly(rectPts(kc.x + 0.003, kc.y - 0.003, 0.027, 0.0145, kc.ang, Z0), 'rgba(0,0,0,0.3)', null));
    shapes.push(poly(rectPts(kc.x, kc.y, 0.026, 0.014, kc.ang, z), '#df2530', '#8d1118', 1.5));
    shapes.push(poly(rectPts(kc.x, kc.y, 0.02, 0.009, kc.ang, z + 0.0005), '#ee4a52', null));
    const ca = Math.cos(kc.ang), sa = Math.sin(kc.ang);
    const rc = P([kc.x + 0.034 * ca, kc.y + 0.034 * sa, z]);
    shapes.push({ k: 'circle', u: rc[0], v: rc[1], r: 5, fill: null, stroke: '#cfd6de', lw: 2 });
    const c = P([kc.x, kc.y, z]);
    meta.keychain = { u: c[0], v: c[1] };
  }

  // the follower arm: shadow on the table, links, gripper
  const arm = world.arm;
  if (arm && arm.pts && arm.pts.length > 2) {
    const pts = arm.pts;
    const sh = pts.map((p) => P([p[0] + 0.01, p[1] - 0.01, Z0]));
    shapes.push({ k: 'line', pts: sh, stroke: 'rgba(0,0,0,0.22)', lw: 16, cap: 'round' });
    const lw = (p, m) => Math.max(3, cam.project(p).k * m);
    // links from the base outwards (painter's order: the farther from the camera first)
    const segs = [];
    for (let s = 0; s < pts.length - 1; s++) segs.push([pts[s], pts[s + 1], s]);
    segs.sort((a, b) => cam.project(b[1]).depth - cam.project(a[1]).depth);
    for (const [a, b, s] of segs) {
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const w = lw(mid, s >= 3 ? 0.024 : 0.03);
      shapes.push({ k: 'line', pts: [P(a), P(b)], stroke: '#5b6573', lw: w + 3, cap: 'round' });
      shapes.push({ k: 'line', pts: [P(a), P(b)], stroke: s >= 3 ? '#f4f6f9' : '#eceff3', lw: w, cap: 'round' });
    }
    for (let s = 1; s < pts.length - 1; s++) {
      const q = cam.project(pts[s]);
      shapes.push({ k: 'circle', u: q.u, v: q.v, r: Math.max(3, q.k * 0.014), fill: '#27303b', stroke: '#9aa7b6', lw: 1.5 });
    }
    // gripper: a body and two jaws, built from the approach direction so it looks right from any side
    const tip = pts[pts.length - 1], dir = norm(arm.dir || [0, 0, -1]);
    let lat = cross(dir, [0, 0, 1]);
    if (Math.hypot(lat[0], lat[1], lat[2]) < 0.2) lat = cross(dir, [1, 0, 0]);
    lat = norm(lat);
    const up2 = norm(cross(lat, dir));
    const at = (back, side, vert) => [tip[0] - dir[0] * back + lat[0] * side + up2[0] * vert, tip[1] - dir[1] * back + lat[1] * side + up2[1] * vert, tip[2] - dir[2] * back + lat[2] * side + up2[2] * vert];
    const gap = 0.004 + 0.034 * Math.max(0, Math.min(1, arm.open ?? 0));
    const jaw = (side) => poly([at(0.05, side * (gap / 2 + 0.008), -0.008), at(0.05, side * (gap / 2 + 0.008), 0.008), at(0.0, side * (gap / 2), 0.004), at(0.0, side * (gap / 2), -0.004)], '#c9d1da', '#5b6573', 1);
    const body = [[0.12, -0.026, -0.016], [0.12, 0.026, -0.016], [0.05, 0.026, -0.016], [0.05, -0.026, -0.016], [0.12, -0.026, 0.016], [0.12, 0.026, 0.016], [0.05, 0.026, 0.016], [0.05, -0.026, 0.016]].map(([b, s, v]) => at(b, s, v));
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]].map((f) => ({ f, d: f.reduce((a, k) => a + cam.project(body[k]).depth, 0) / 4 })).sort((a, b) => b.d - a.d);
    for (const { f } of faces) shapes.push(poly(f.map((k) => body[k]), '#e6eaef', '#5b6573', 1.5));
    shapes.push(jaw(-1), jaw(1));
    const tq = cam.project(tip);
    meta.tip = { u: tq.u, v: tq.v };
    // where the tip touches the table (a small cross), handy for clicking
    if (opts.overlay !== false) {
      shapes.push({ k: 'circle', u: tq.u, v: tq.v, r: 9, fill: null, stroke: '#ff8a1f', lw: 2 });
      shapes.push({ k: 'line', pts: [[tq.u - 14, tq.v], [tq.u + 14, tq.v]], stroke: '#ff8a1f', lw: 1.5 });
      shapes.push({ k: 'line', pts: [[tq.u, tq.v - 14], [tq.u, tq.v + 14]], stroke: '#ff8a1f', lw: 1.5 });
    }
  }

  // what the app draws on its own picture: zones, the keychain box, taught points
  const ov = opts.overlay !== false ? world.overlay : null;
  if (ov) {
    for (const [name, col] of [['tray', '#3ca0ff'], ['bowl', '#ff6ec8']]) {
      const z = ov.zones && ov.zones[name];
      if (!z || !z.p) continue;
      shapes.push({ k: 'circle', u: z.p[0], v: z.p[1], r: z.r, fill: null, stroke: col, lw: 2 });
      shapes.push({ k: 'text', u: z.p[0] - 18, v: z.p[1] - z.r - 6, text: name, size: 14, fill: col, weight: 700 });
    }
    (ov.found || []).slice(0, 1).forEach((d) => {
      const a = (d.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), hw = d.w / 2, hh = d.h / 2;
      const box = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [d.u + x * c - y * s, d.v + x * s + y * c]);
      shapes.push({ k: 'poly', pts: box, fill: null, stroke: '#50dc78', lw: 2 });
      shapes.push({ k: 'text', u: d.u - 30, v: d.v - 22, text: d.partial ? 'keychain (partly hidden)' : 'keychain', size: 13, fill: '#50dc78', weight: 600 });
    });
    (ov.taught || []).forEach((p, n) => {
      shapes.push({ k: 'circle', u: p.u, v: p.v, r: 6, fill: null, stroke: '#dc50ff', lw: 2 });
      shapes.push({ k: 'text', u: p.u + 8, v: p.v + 4, text: String(n + 1), size: 13, fill: '#dc50ff', weight: 600 });
    });
  }
  shapes.push({ k: 'label', u: 12, v: 12, text: `DEMO CAMERA ${i + 1}` });
  return { w: IMG.w, h: IMG.h, shapes, meta };
}

/** Paint a model onto a 2D canvas context (browser). Deterministic: grain noise is seeded by (seed, camera, frame). */
export function drawScene(ctx, model, size = {}, seed = 1) {
  const W = size.w || IMG.w, H = size.h || IMG.h;
  ctx.save();
  ctx.scale(W / model.w, H / model.h);
  ctx.lineJoin = 'round';
  for (const s of model.shapes) {
    switch (s.k) {
      case 'rect': ctx.fillStyle = s.fill; ctx.fillRect(s.x, s.y, s.w, s.h); break;
      case 'line':
        ctx.beginPath(); s.pts.forEach(([u, v], n) => (n ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
        ctx.strokeStyle = s.stroke; ctx.lineWidth = s.lw; ctx.lineCap = s.cap || 'butt'; ctx.stroke(); break;
      case 'poly':
        ctx.beginPath(); s.pts.forEach(([u, v], n) => (n ? ctx.lineTo(u, v) : ctx.moveTo(u, v))); ctx.closePath();
        if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
        if (s.stroke) { ctx.strokeStyle = s.stroke; ctx.lineWidth = s.lw; ctx.stroke(); }
        break;
      case 'circle':
        ctx.beginPath(); ctx.arc(s.u, s.v, s.r, 0, Math.PI * 2);
        if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
        if (s.stroke) { ctx.strokeStyle = s.stroke; ctx.lineWidth = s.lw; ctx.stroke(); }
        break;
      case 'text':
        ctx.font = `${s.weight || 400} ${s.size || 13}px system-ui, sans-serif`; ctx.fillStyle = s.fill || '#fff'; ctx.fillText(s.text, s.u, s.v); break;
      case 'label': {
        ctx.font = '600 13px system-ui, sans-serif';
        const w = ctx.measureText(s.text).width + 18;
        ctx.fillStyle = 'rgba(8,12,18,0.66)'; ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(s.u, s.v, w, 24, 12); else ctx.rect(s.u, s.v, w, 24);
        ctx.fill();
        ctx.fillStyle = '#ffb067'; ctx.fillText(s.text, s.u + 9, s.v + 17);
        break;
      }
      default: break;
    }
  }
  // sensor grain + vignette (seeded by the frame so a given (seed, t) always looks the same)
  const rnd = mulberry32(seed * 7919 + model.meta.cam * 104729 + Math.floor((model.meta.t || 0) * 12));
  for (let n = 0; n < 420; n++) { const v = rnd() > 0.5 ? 255 : 0; ctx.fillStyle = `rgba(${v},${v},${v},${0.03 + rnd() * 0.06})`; ctx.fillRect(rnd() * model.w, rnd() * model.h, 1.5, 1.5); }
  const g = ctx.createRadialGradient(model.w / 2, model.h / 2, model.h * 0.35, model.w / 2, model.h / 2, model.w * 0.65);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, model.w, model.h);
  ctx.restore();
}

export const _rgba = rgba; // exported for tests that want to check colours without a canvas
