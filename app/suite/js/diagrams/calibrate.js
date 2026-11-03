// Diagrams for the Calibrate page. All are side views drawn from the arm's real geometry (millimetres, x forward, z up,
// taken from the URDF through forward kinematics), so the "middle pose" picture matches the 3D model on screen.
// Every colour is a CSS variable (see .dg helper classes in components.css), so they read in light and dark.
import { svg } from '../ui.js';

/** Joint axes in the middle pose: pan pivot, shoulder lift, elbow, wrist flex, wrist roll, jaw tips. [x, z] in mm. */
export const MIDDLE = [[39, 62], [69, 117], [97, 229], [232, 234], [293, 234], [391, 226]];
/** The common wrong pose: elbow bent all the way, forearm hanging down in front of the upper arm. */
export const FOLDED = [[39, 62], [69, 117], [97, 229], [100, 98], [102, 38], [104, 4]];

const f1 = (n) => Math.round(n * 10) / 10;
const TINT = 'color-mix(in srgb,var(--accent) 40%,var(--dg-fill))';
const INK = 'color-mix(in srgb,var(--accent) 100%,#000 55%)';

/** Capsule between two picture points: an outline line with a fill line on top. */
const capsule = (a, b, w, hi) =>
  `<line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" style="stroke:var(--dg-part);stroke-width:${f1(w + 2.6)};stroke-linecap:round"/>` +
  `<line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" style="stroke:${hi ? TINT : 'var(--dg-fill)'};stroke-width:${f1(w)};stroke-linecap:round"/>`;
const pin = (p, r) => `<circle cx="${f1(p[0])}" cy="${f1(p[1])}" r="${r}" style="fill:var(--dg-fill);stroke:var(--dg-part);stroke-width:1.4"/>`;
const num = (p, n, r = 9.5) =>
  `<circle cx="${f1(p[0])}" cy="${f1(p[1])}" r="${r}" class="dg-hi"/><text x="${f1(p[0])}" y="${f1(p[1] + r * 0.42)}" text-anchor="middle" style="font:800 ${f1(r * 1.15)}px var(--font);fill:#1b0e00">${n}</text>`;
const text = (x, y, s, { anchor = 'start', cls = 'dg-label', fill, size } = {}) => `<text x="${f1(x)}" y="${f1(y)}" text-anchor="${anchor}" class="${cls}"${fill || size ? ` style="${fill ? `fill:${fill};` : ''}${size ? `font-size:${size}px;` : ''}"` : ''}>${s}</text>`;
const leader = (a, b) => `<line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" style="stroke:var(--dg-dim);stroke-width:1.1"/>`;

function head(x, y, dx, dy, size, cls = 'dg-do-fill') {
  const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
  const bx = x - dx * size, by = y - dy * size, px = -dy * size * 0.55, py = dx * size * 0.55;
  return `<polygon class="${cls}" points="${f1(x)},${f1(y)} ${f1(bx + px)},${f1(by + py)} ${f1(bx - px)},${f1(by - py)}"/>`;
}
/** A curved double arrow around (cx, cy) from angle a0 to a1 (degrees, picture coordinates: 0 = right, 90 = down). */
function arc(cx, cy, r, a0, a1, { cls = 'dg-do', size = 5 } = {}) {
  const pt = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a1), up = a1 > a0;
  const tan = (a, s) => [-Math.sin((a * Math.PI) / 180) * s, Math.cos((a * Math.PI) / 180) * s];
  const t1 = tan(a1, up ? 1 : -1), t0 = tan(a0, up ? -1 : 1);
  return `<path class="${cls}" d="M${f1(x0)} ${f1(y0)} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${up ? 1 : 0} ${f1(x1)} ${f1(y1)}" style="stroke-width:2.2"/>` +
    head(x1, y1, t1[0], t1[1], size, cls === 'dg-avoid' ? 'dg-avoid-fill' : 'dg-do-fill') + head(x0, y0, t0[0], t0[1], size, cls === 'dg-avoid' ? 'dg-avoid-fill' : 'dg-do-fill');
}

/** The whole arm from [x,z] axis points. opts: s (px per mm), ox, oy (picture position of x=0 / table), hiFrom (0-5: tint every part from this joint on), numbers, jaw (0-1 how far open), table. */
function arm(pts, { s = 0.76, ox = 84, oy = 250, hiFrom = -1, numbers = false, jaw = 0.5, table = true, tableX = [18, 402], w = 1 } = {}) {
  const P = pts.map(([x, z]) => [ox + x * s, oy - z * s]);
  const hi = (i) => hiFrom >= 0 && i >= hiFrom;
  let out = '';
  if (table) out += `<line x1="${tableX[0]}" y1="${oy}" x2="${tableX[1]}" y2="${oy}" style="stroke:var(--dg-dim);stroke-width:2"/>`;
  // base block and the pan housing on top of it
  const bx = ox - 8 * s, bw = 100 * s;
  out += `<rect x="${f1(bx)}" y="${f1(oy - 42 * s)}" width="${f1(bw)}" height="${f1(42 * s)}" rx="${f1(5 * s)}" class="dg-part"/>`;
  out += `<rect x="${f1(ox + 20 * s)}" y="${f1(oy - 66 * s)}" width="${f1(42 * s)}" height="${f1(26 * s)}" rx="${f1(4 * s)}" style="fill:${hi(0) ? TINT : 'var(--dg-fill)'};stroke:var(--dg-part);stroke-width:1.6"/>`;
  out += capsule([ox + 39 * s, oy - 60 * s], P[1], 26 * s * w, hi(0));    // the shoulder piece between the pan pivot and the shoulder lift
  out += capsule(P[1], P[2], 15 * s * w, hi(1));                       // upper arm
  out += capsule(P[2], P[3], 14 * s * w, hi(2));                       // forearm
  out += capsule(P[3], P[4], 22 * s * w, hi(3));                       // wrist block
  // gripper: body, a fixed jaw and a moving jaw that opens upward
  const dx = P[4][0] === P[5][0] && P[4][1] === P[5][1] ? 1 : P[5][0] - P[4][0], dz = P[5][1] - P[4][1], L = Math.hypot(dx, dz) || 1;
  const d = [dx / L, dz / L], n = [d[1], -d[0]];                       // n points "up" in the picture for a gripper pointing right
  const E = [P[4][0] + d[0] * L * 0.45, P[4][1] + d[1] * L * 0.45];
  out += capsule(P[4], E, 26 * s * w, hi(4));
  const tipFixed = [P[5][0] + n[0] * -3 * s, P[5][1] + n[1] * -3 * s];
  const open = 6 + 30 * jaw;
  const tipMove = [P[5][0] + n[0] * open * s, P[5][1] + n[1] * open * s];
  out += `<line x1="${f1(E[0] - n[0] * 8 * s)}" y1="${f1(E[1] - n[1] * 8 * s)}" x2="${f1(tipFixed[0])}" y2="${f1(tipFixed[1])}" style="stroke:var(--dg-part);stroke-width:${f1(5 * s * w + 2)};stroke-linecap:round"/>`;
  out += `<line x1="${f1(E[0] - n[0] * 8 * s)}" y1="${f1(E[1] - n[1] * 8 * s)}" x2="${f1(tipFixed[0])}" y2="${f1(tipFixed[1])}" style="stroke:${hi(4) ? TINT : 'var(--dg-fill)'};stroke-width:${f1(5 * s * w)};stroke-linecap:round"/>`;
  out += `<line x1="${f1(E[0] + n[0] * 8 * s)}" y1="${f1(E[1] + n[1] * 8 * s)}" x2="${f1(tipMove[0])}" y2="${f1(tipMove[1])}" style="stroke:var(--dg-part);stroke-width:${f1(5 * s * w + 2)};stroke-linecap:round"/>`;
  out += `<line x1="${f1(E[0] + n[0] * 8 * s)}" y1="${f1(E[1] + n[1] * 8 * s)}" x2="${f1(tipMove[0])}" y2="${f1(tipMove[1])}" style="stroke:${hi(5) ? TINT : 'var(--dg-fill)'};stroke-width:${f1(5 * s * w)};stroke-linecap:round"/>`;
  if (numbers) {
    out += num([ox + 39 * s, oy - 53 * s], 1) + num(P[1], 2) + num(P[2], 3) + num(P[3], 4) + num([(P[4][0] + E[0]) / 2, P[4][1]], 5) + num([E[0] + d[0] * 2, E[1] + n[1] * 0 - 1], 6, 7.5);
  } else if (w > 0.6) {
    out += pin(P[1], 3) + pin(P[2], 3) + pin(P[3], 3);
  }
  return { markup: out, P, E, d, n };
}

/** The middle pose, labelled: the picture the person compares their arm with. */
export function middlePose({ role = 'follower' } = {}) {
  const a = arm(MIDDLE, { numbers: true, jaw: 0.5 });
  const { P } = a;
  let g = a.markup;
  const T = { size: 14 };
  // guides: "up" along the upper arm and "level" along the forearm are the two things a hand can judge
  g += `<line x1="${f1(P[2][0])}" y1="${f1(P[2][1] - 26)}" x2="${f1(P[4][0] + 62)}" y2="${f1(P[2][1] - 26)}" style="stroke:var(--dg-do);stroke-width:1.4;stroke-dasharray:5 4"/>`;
  g += `<path class="dg-do" d="M${f1(P[1][0] - 26)} 150 L${f1(P[1][0] - 26)} 112" style="stroke-width:2.6"/>` + head(P[1][0] - 26, 106, 0, -1, 8);
  g += text(P[1][0] - 34, 104, 'Up', { anchor: 'end', ...T });
  g += text(P[1][0] - 34, 124, 'Upper arm', { anchor: 'end', ...T });
  g += text((P[2][0] + P[4][0]) / 2 + 20, P[2][1] - 34, 'Straight out, level', { anchor: 'middle', ...T });
  g += text((P[2][0] + P[3][0]) / 2, P[2][1] + 34, 'Forearm', { anchor: 'middle', ...T });
  g += text(P[3][0] + 22, P[3][1] + 34, 'Wrist', { anchor: 'middle', ...T });
  g += text(P[5][0] + 8, P[5][1] + 64, role === 'leader' ? 'Handle, half squeezed' : 'Gripper, half open', { anchor: 'end', ...T });
  g += leader([P[5][0] - 30, P[5][1] + 50], [P[5][0] - 26, P[5][1] + 14]);
  g += text(66, 238, 'Base', { anchor: 'end', ...T });
  g += text(400, 268, 'Table', { anchor: 'end', cls: 'dg-small' });
  return svg(g, { viewBox: '10 0 400 276', label: 'Side view of the arm in its middle pose: the upper arm points up, the forearm points straight out level, the wrist continues the forearm in one line, and the gripper is half open. The six joints are numbered 1 to 6.' });
}

/** Small right and wrong pictures for the pair under the step card. */
export function poseMini(kind) {
  const right = kind === 'right';
  const a = arm(right ? MIDDLE : FOLDED, { s: 0.42, ox: 38, oy: 128, jaw: 0.5, table: true, tableX: [6, 236], w: 1.15 });
  let g = a.markup;
  if (right) {
    g += `<path class="dg-do" d="M${f1(a.P[0][0] + 78)} 86 l6 7 l12 -15" style="stroke-width:3"/>`;
    g += text(120, 14, 'Upper arm up, forearm level', { anchor: 'middle', cls: 'dg-small' });
  } else {
    g += `<path class="dg-avoid" d="M150 56 l22 22 M172 56 l-22 22" style="stroke-width:3.2"/>`;
    g += text(120, 14, 'Forearm hangs down', { anchor: 'middle', cls: 'dg-small' });
  }
  return svg(g, { viewBox: '0 0 240 144', label: right ? 'Right: upper arm points up and the forearm points out, level.' : 'Wrong: the elbow is bent all the way and the forearm hangs down against the upper arm.' });
}

/** What one joint row asks for: the moving part tinted, a curved two-way arrow where it turns. */
export function jointMotion(name, { role = 'follower' } = {}) {
  const S = 0.2, ox = 16, oy = 74;
  const hiFrom = { shoulder_pan: 0, shoulder_lift: 1, elbow_flex: 2, wrist_flex: 3, wrist_roll: 4, gripper: 5 }[name];
  const label = {
    shoulder_pan: 'Top view: the whole arm turns left and right on the base.',
    shoulder_lift: 'Side view: the upper arm leans back and forward from the shoulder.',
    elbow_flex: 'Side view: the forearm swings up and down at the elbow.',
    wrist_flex: 'Side view: the gripper tips up and down at the wrist.',
    wrist_roll: 'Side view: the gripper spins around its own length.',
    gripper: role === 'leader' ? 'The trigger squeezes and lets go.' : 'The moving jaw opens and closes.',
  }[name];
  if (name === 'shoulder_pan') {
    // top view: base disc, the arm as a bar, the sweep around the base
    const c = [38, 42];
    let g = `<circle cx="${c[0]}" cy="${c[1]}" r="14" class="dg-part"/>`;
    g += `<line x1="${c[0]}" y1="${c[1]}" x2="108" y2="${c[1]}" style="stroke:var(--dg-part);stroke-width:9;stroke-linecap:round"/><line x1="${c[0]}" y1="${c[1]}" x2="108" y2="${c[1]}" style="stroke:${TINT};stroke-width:6.4;stroke-linecap:round"/>`;
    g += `<circle cx="${c[0]}" cy="${c[1]}" r="4" class="dg-hi"/>` + arc(c[0], c[1], 30, -55, 55, { size: 5 });
    g += text(60, 80, 'Top view', { cls: 'dg-small' });
    return svg(g, { viewBox: '0 0 120 84', label });
  }
  const a = arm(MIDDLE, { s: S, ox, oy, hiFrom, jaw: name === 'gripper' ? 0.7 : 0.4, w: 1.5, tableX: [4, 116] });
  let g = a.markup;
  const P = a.P;
  if (name === 'shoulder_lift') g += arc(P[1][0], P[1][1], 17, -148, -32);
  if (name === 'elbow_flex') g += arc(P[2][0], P[2][1], 16, -52, 52);
  if (name === 'wrist_flex') g += arc(P[3][0], P[3][1], 13, -56, 56);
  if (name === 'wrist_roll') {
    const x = P[4][0] + 4, y = P[4][1];
    g += `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="5" ry="14" class="dg-do" style="stroke-width:2.2"/>` + head(x + 3.5, y - 12.8, -1, -0.1, 5);
  }
  if (name === 'gripper') g += arc(a.E[0], a.E[1], 15, -62, -4);
  return svg(g, { viewBox: '0 0 120 84', label });
}

/** How to read a joint bar: the line is 0, the band is what you have covered, the dot is where the joint is now. */
export function barLegend() {
  let g = `<rect x="14" y="30" width="332" height="14" rx="7" style="fill:var(--surface2);stroke:var(--line2);stroke-width:1.4"/>`;
  g += `<rect x="70" y="33" width="158" height="8" rx="4" style="fill:color-mix(in srgb,var(--accent) 30%,transparent)"/>`;
  g += `<line x1="180" y1="23" x2="180" y2="51" style="stroke:var(--faint);stroke-width:2.4"/>`;
  g += `<circle cx="216" cy="37" r="9" style="fill:var(--accent);stroke:var(--bg);stroke-width:3"/>`;
  g += text(180, 16, '0 = the middle', { anchor: 'middle' });
  g += leader([96, 44], [64, 62]) + text(12, 78, 'What you covered so far');
  g += leader([220, 46], [270, 62]) + text(348, 78, 'Where the joint is now', { anchor: 'end' });
  return svg(g, { viewBox: '0 0 360 90', label: 'A joint bar. The line in the middle is zero. The orange band is the part of the turn you have covered. The dot is where the joint is right now.' });
}
