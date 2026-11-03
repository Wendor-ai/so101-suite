// Diagrams for the Test motors page: where a joint is on the arm, and the three things to check when a motor does not answer.
// Schematic pictures drawn with CSS variables so they read in light and dark.
import { svg } from '../ui.js';

const rad = (d) => (d * Math.PI) / 180;
const T = (x, y, s, cls = 'dg-small', anchor = 'middle') => `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${s}</text>`;
const HI = 'stroke:var(--dg-hi);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;fill:none';

/** A curved double-headed arrow around (cx, cy) from angle a0 to a1 (degrees, 0 = right, positive = clockwise on screen). */
function arc(cx, cy, r, a0, a1, rx = r, ry = r) {
  const p = (a) => [cx + rx * Math.cos(rad(a)), cy + ry * Math.sin(rad(a))];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  const head = (x, y, a, sign) => { // arrowhead at the tip, pointing along the arc
    const r = rad(a), s = 6, dx = sign * -Math.sin(r), dy = sign * Math.cos(r), nx = Math.cos(r), ny = Math.sin(r);
    const b1 = [x - dx * s + nx * s * 0.6, y - dy * s + ny * s * 0.6], b2 = [x - dx * s - nx * s * 0.6, y - dy * s - ny * s * 0.6];
    return `<path d="M${b1[0].toFixed(1)} ${b1[1].toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}L${b2[0].toFixed(1)} ${b2[1].toFixed(1)}" style="${HI};stroke-width:2.6"/>`;
  };
  return `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)}A${rx} ${ry} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" style="${HI}"/>` + head(x0, y0, a0, -1) + head(x1, y1, a1, 1);
}

const S = [52, 84], E = [88, 32], W = [150, 38], TIP = [172, 86];
const link = (a, b) => `<path d="M${a[0]} ${a[1]}L${b[0]} ${b[1]}" style="stroke:var(--dg-part);stroke-width:11;stroke-linecap:round"/><path d="M${a[0]} ${a[1]}L${b[0]} ${b[1]}" style="stroke:var(--surface2);stroke-width:6;stroke-linecap:round"/>`;
const pivot = (p, on) => `<circle cx="${p[0]}" cy="${p[1]}" r="${on ? 8 : 5}" style="fill:${on ? 'var(--dg-hi)' : 'var(--dg-part)'};stroke:var(--surface);stroke-width:2"/>`;
const WHERE = {
  shoulder_pan: 'the base, at the foot of the arm',
  shoulder_lift: 'the shoulder, where the upper arm meets the base',
  elbow_flex: 'the elbow, in the middle of the arm',
  wrist_flex: 'the wrist, where the forearm meets the hand',
  wrist_roll: 'the hand, just before the jaws',
  gripper: 'the jaws at the very end',
};

/** Where one joint is, as a small side-view picture of the arm. Orange = the part this motor moves. */
export function jointPic(name) {
  const hi = (n) => name === n;
  let o = `<rect class="dg-part" x="20" y="108" width="62" height="14" rx="4" style="fill:var(--surface2)"/>` +
    `<rect class="dg-part" x="40" y="84" width="24" height="26" rx="4" style="fill:var(--surface2)"/>` +
    link(S, E) + link(E, W) + link(W, TIP) +
    pivot(S, hi('shoulder_lift')) + pivot(E, hi('elbow_flex')) + pivot(W, hi('wrist_flex'));
  // gripper jaws at the tip
  const jaw = hi('gripper') ? HI : 'stroke:var(--dg-part);stroke-width:4;stroke-linecap:round;fill:none';
  o += `<path d="M${TIP[0]} ${TIP[1]}l-7 20M${TIP[0]} ${TIP[1]}l9 19" style="${jaw}"/>`;
  if (hi('shoulder_pan')) o += `<path d="M52 108V56" style="stroke:var(--dg-hi);stroke-width:1.6;stroke-dasharray:4 3;fill:none"/>` + arc(52, 62, 22, 200, 340, 22, 8) + `<circle cx="52" cy="108" r="6" style="fill:var(--dg-hi)"/>`;
  if (hi('shoulder_lift')) o += arc(S[0], S[1], 22, -175, -95);
  if (hi('elbow_flex')) o += arc(E[0], E[1], 22, -170, -90);
  if (hi('wrist_flex')) o += arc(W[0], W[1], 22, -80, 0);
  if (hi('wrist_roll')) o += `<ellipse cx="161" cy="62" rx="15" ry="5.5" transform="rotate(-24.6 161 62)" style="${HI}"/><path d="M174 56l4 7-8 1" style="${HI};stroke-width:2.6"/>`;
  if (hi('gripper')) o += arc(TIP[0], TIP[1] + 16, 16, 205, 335, 16, 9);
  return svg(o, { viewBox: '0 0 200 132', label: `Side view of the arm. The ${name.replace('_', ' ')} joint is highlighted: ${WHERE[name] || 'on the arm'}.` });
}

/** The three things to check when a motor does not answer: cable, power, ID. Motor n is joined to motor n-1 (the board for motor 1). */
export function ifNotStrip(n = 1) {
  const box = (x, y, dark = true) => `<rect x="${x}" y="${y}" width="30" height="22" rx="4" style="fill:${dark ? '#14171d' : 'var(--surface2)'};stroke:var(--dg-part);stroke-width:1.4"/>`;
  const tile = (x, body, label) => `<g transform="translate(${x} 0)"><rect class="dg-part" x="0" y="0" width="100" height="92" rx="9" style="fill:var(--surface2);stroke:var(--line2)"/>${body}${T(50, 84, label, 'dg-label')}</g>`;
  const cableTile = `<rect class="dg-part" x="6" y="26" width="32" height="22" rx="4" style="${n === 1 ? 'fill:var(--surface);' : 'fill:#14171d;'}"/>` +
    box(62, 26) + `<path d="M38 37H62" class="dg-do" style="stroke-width:4"/><path d="M31 62h38M31 62l7-5M31 62l7 5M69 62l-7-5M69 62l-7 5" class="dg-do" style="stroke-width:2"/>` +
    (n === 1 ? T(22, 41, 'Board', 'dg-small').replace('class="dg-small"', 'class="dg-small" style="font-size:9px"') : '');
  const powerTile = `<rect class="dg-part" x="14" y="20" width="56" height="36" rx="5" style="fill:var(--surface)"/><circle cx="70" cy="34" r="6" class="dg-part"/>` +
    `<path d="M76 34h14" class="dg-do" style="stroke-width:4"/><path d="M36 66h26M62 66l-6-5M62 66l-6 5" class="dg-do" style="stroke-width:2"/>`;
  const idTile = box(8, 24) + `<rect x="14" y="29" width="22" height="12" rx="2" style="fill:var(--dg-hi)"/><text x="25" y="38.5" text-anchor="middle" style="fill:var(--accent-ink,#1b0e00);font:800 9px var(--font)">ID ${n}</text>` +
    `<text x="72" y="44" text-anchor="middle" style="font:800 20px var(--font)">${n}</text>`;
  return svg(tile(0, cableTile, '1  Cable') + tile(110, powerTile, '2  Power') + tile(220, idTile, '3  ID'), { viewBox: '0 0 320 92', label: `Three things to check for motor ${n}. One: the 3-pin cable is pushed in at both ends. Two: the power plug is pushed all the way in. Three: the motor really has ID ${n}.` });
}
