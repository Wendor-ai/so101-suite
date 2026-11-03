// Assembly schematics for the Assemble page. Every picture is a SCHEMATIC, not a drawing of the real parts:
// it shows order, counts and the common mistake, and the caption says the viewpoint. Real shapes live in the official
// step videos (linked from every card). Drawn with CSS variables only, so it reads in light and dark.
//
//   diagram(id, {single}) -> {node, caption, title} | null
//   ids: horns, motor-in-base, joint1..joint5, gripper-follower, gripper-leader, cables, chain, clean
import { h, svg } from '../ui.js';
import { rightWrong as rightWrongRaw } from '../steps.js';

/* ---------- tiny drawing kit (strings of SVG) ---------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, s, { a = 'start', c = 'dg-label', st = '' } = {}) => (c === 'dg-small' && !/font-size/.test(st) ? (st += ';font-size:11.5px') : 0, `<text x="${x}" y="${y}" text-anchor="${a}" class="${c}"${st ? ` style="${st}"` : ''}>${esc(s)}</text>`);
const R = (x, y, w, hh, { cls = 'dg-part', st = '', rx = 5 } = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="${rx}" class="${cls}"${st ? ` style="${st}"` : ''}/>`;
const L = (x1, y1, x2, y2, cls = 'dg-part', st = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"${st ? ` style="${st}"` : ''}/>`;
const C = (cx, cy, r, cls = 'dg-part', st = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" class="${cls}"${st ? ` style="${st}"` : ''}/>`;
const MOTOR = 'fill:color-mix(in srgb,var(--text) 24%,var(--surface))';
const NEW = 'fill:color-mix(in srgb,var(--accent) 20%,var(--surface));stroke:var(--accent);stroke-width:2.2';
const HAVE = 'fill:var(--surface2);stroke-dasharray:4 3;stroke:var(--muted)';
const BAD_FILL = 'fill:color-mix(in srgb,var(--bad) 14%,var(--surface));stroke:var(--bad);stroke-width:2';
const GOOD_FILL = 'fill:color-mix(in srgb,var(--ok) 14%,var(--surface));stroke:var(--ok);stroke-width:2';

/** arrowhead pointing along (dx,dy) at (x,y) */
function head(x, y, dx, dy, cls, size = 7) {
  const n = Math.hypot(dx, dy) || 1, ux = dx / n, uy = dy / n, px = -uy, py = ux;
  const a = [x - ux * size + px * size * 0.55, y - uy * size + py * size * 0.55], b = [x - ux * size - px * size * 0.55, y - uy * size - py * size * 0.55];
  return `<path d="M${x} ${y}L${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}z" class="${cls}-fill" style="stroke:none"/>`;
}
const arrow = (x1, y1, x2, y2, cls = 'dg-do') => L(x1, y1, x2, y2, cls) + head(x2, y2, x2 - x1, y2 - y1, cls);
/** green screw glyph: a dot with a slot */
const screw = (x, y, bad = false) => `<g>${C(x, y, 4.4, bad ? 'dg-avoid-fill' : 'dg-do-fill', 'stroke:var(--surface);stroke-width:1')}${L(x - 2.4, y - 2.4, x + 2.4, y + 2.4, 'dg-part', 'stroke:var(--surface);stroke-width:1.4')}</g>`;
/** red cross */
const cross = (x, y, r = 8) => L(x - r, y - r, x + r, y + r, 'dg-avoid') + L(x - r, y + r, x + r, y - r, 'dg-avoid');
/** simple mitten, palm top-left at (x,y), fingers pointing down; scale s */
const hand = (x, y, s = 1, rot = 0) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})"><ellipse cx="-17" cy="12" rx="5" ry="9" transform="rotate(28 -17 12)" class="dg-hand"/><path d="M-15 0h30v22c0 10-7 17-15 17s-15-7-15-17z" class="dg-hand"/><path d="M-5 24v13M5 24v13" fill="none" class="dg-hand" style="stroke-width:1.2;fill:none"/></g>`;

/** rightWrong from steps.js, with each caption's text and <b> tags kept in ONE flex item next to the tick/cross */
function rightWrong(right, wrong) {
  const el = rightWrongRaw(right, wrong);
  el.querySelectorAll('figcaption').forEach((fc) => {
    const span = h('span');
    [...fc.childNodes].filter((n) => n.nodeName.toLowerCase() !== 'svg').forEach((n) => span.append(n));
    fc.append(span);
  });
  return el;
}

const wrap = (inner, vb = '0 0 420 250', label = '') => svg(inner, { viewBox: vb, label });

/* ---------- 1. where this joint sits on the arm (left half of every joint picture) ---------- */
const JOINT_NO = { joint1: 1, joint2: 2, joint3: 3, joint4: 4, joint5: 5, 'gripper-follower': 6, 'gripper-leader': 6 };
function armMap(cur) {
  const link = (x1, y1, x2, y2, w = 17) => L(x1, y1, x2, y2, 'dg-part', `stroke-width:${w + 3.2};stroke-linecap:round`) + L(x1, y1, x2, y2, 'dg-part', `stroke:var(--surface2);stroke-width:${w};stroke-linecap:round`);
  const J = [null, [41, 218], [41, 192], [41, 96], [133, 96], [133, 122], [133, 148]];
  let s = '';
  s += L(4, 238, 118, 238, 'dg-dim');
  s += R(14, 218, 54, 20, { st: 'fill:var(--surface2)' }) + R(27, 197, 28, 21, { st: 'fill:var(--surface2)' });
  s += link(41, 190, 41, 98) + link(41, 96, 133, 96) + link(133, 98, 133, 150, 12);
  // jaws: one fixed, one that swings
  s += L(127, 152, 127, 182, 'dg-part', 'stroke-width:4;stroke-linecap:round') + L(139, 152, 154, 180, 'dg-part', cur === 6 ? 'stroke:var(--accent);stroke-width:4;stroke-linecap:round' : 'stroke-width:4;stroke-linecap:round;stroke-dasharray:1 7');
  s += T(70, 233, 'base', { c: 'dg-small' }) + T(56, 150, 'upper arm', { c: 'dg-small' }) + T(70, 80, 'forearm', { c: 'dg-small' }) + T(148, 124, 'wrist', { c: 'dg-small' });
  if (cur === 6) s += T(119, 174, 'fixed jaw', { a: 'end', c: 'dg-small' }) + T(186, 198, 'moving jaw', { a: 'end', c: 'dg-small', st: 'fill:var(--accent-text);font-weight:700' });
  for (let i = 1; i <= 6; i++) {
    const [x, y] = J[i];
    if (i === cur) s += C(x, y, 15, 'dg-part', 'fill:none;stroke:var(--accent);stroke-width:2.2;opacity:.55') + C(x, y, 10, 'dg-part', 'fill:var(--accent);stroke:var(--text);stroke-width:1.6') + T(x, y + 4, String(i), { a: 'middle', st: 'fill:var(--accent-ink);font-weight:800;font-size:12px' });
    else s += C(x, y, 9, 'dg-part', 'fill:var(--surface);stroke-width:1.4') + T(x, y + 4, String(i), { a: 'middle', c: 'dg-small', st: 'font-weight:700' });
  }
  return s;
}

/* ---------- 2. "what goes onto what", top to bottom, with the screws that hold each part ---------- */
// rows: {t: label, k: 'new'|'motor'|'have', s: 'text shown on the connector ABOVE this box'}
function stack(rows, x0 = 190) {
  const W = 226, H = 30, P = 48, y0 = Math.max(12, Math.round((250 - ((rows.length - 1) * P + H)) / 2));
  let s = '';
  rows.forEach((r, i) => {
    const y = y0 + i * P;
    if (i > 0) {
      s += arrow(x0 + 14, y - 18, x0 + 14, y - 1, 'dg-dim') + (r.s ? screw(x0 + 28, y - 9) + T(x0 + 37, y - 5, r.s, { c: 'dg-small' }) : '');
    }
    s += R(x0, y, W, H, { st: r.k === 'new' ? NEW : r.k === 'motor' ? MOTOR : HAVE });
    s += T(x0 + 10, y + 19.5, r.t, { st: 'font-size:12.5px;font-weight:' + (r.k === 'new' ? 700 : 600) });
  });
  return s;
}
const jointPic = (cur, rows, label) => wrap(armMap(cur) + stack(rows), '0 0 420 250', label);

const JOINT_ROWS = {
  joint1: [
    { t: 'Motor 1 with its 2 horns', k: 'motor' },
    { t: 'Base', k: 'new', s: '4× M2x6 (2 top, 2 bottom)' },
    { t: 'Base motor holder', k: 'new', s: '2× M2x6 (1 each side)' },
    { t: 'Shoulder part', k: 'new', s: '8× M3x6 (4 top, 4 under)' },
    { t: 'Shoulder motor holder', k: 'new', s: 'just place it, no screws yet' },
  ],
  joint2: [
    { t: 'Shoulder motor holder', k: 'have' },
    { t: 'Motor 2 with its 2 horns', k: 'motor', s: '4× M2x6 through the holder' },
    { t: 'Upper arm', k: 'new', s: '8× M3x6 (4 each side)' },
  ],
  joint3: [
    { t: 'Upper arm, far end', k: 'have' },
    { t: 'Motor 3 with its 2 horns', k: 'motor', s: '4× M2x6 through the arm' },
    { t: 'Forearm', k: 'new', s: '8× M3x6 (4 each side)' },
  ],
  joint4: [
    { t: 'Forearm, far end', k: 'have' },
    { t: 'Motor holder 4', k: 'new', s: 'fit it as the video shows' },
    { t: 'Motor 4 with its 2 horns', k: 'motor', s: '4× M2x6 through the holder' },
  ],
  joint5: [
    { t: 'Wrist holder', k: 'new' },
    { t: 'Motor 5 with ONE horn', k: 'motor', s: '2× M2x6 (front of the holder)' },
    { t: 'Horns of motor 4', k: 'have', s: '8× M3x6 (4 each side)' },
  ],
  'gripper-follower': [
    { t: 'Horn of motor 5', k: 'have' },
    { t: 'Gripper body (fixed jaw)', k: 'new', s: '4× M3x6 into that horn' },
    { t: 'Motor 6 with its 2 horns', k: 'motor', s: '4× M2x6 (2 each side)' },
    { t: 'Moving jaw', k: 'new', s: '8× M3x6 (4 each side)' },
  ],
  'gripper-leader': [
    { t: 'Wrist', k: 'have' },
    { t: 'Leader holder', k: 'new', s: '4× M3x6 into the wrist' },
    { t: 'Handle', k: 'new', s: '1× M2x6' },
    { t: 'Motor 6 with ONE horn', k: 'motor', s: '4× M2x6 (2 each side)' },
    { t: 'Trigger', k: 'new', s: '4× M3x6 into the horn' },
  ],
};
const JOINT_TITLE = { joint1: 'Joint 1: shoulder pan', joint2: 'Joint 2: shoulder lift', joint3: 'Joint 3: elbow flex', joint4: 'Joint 4: wrist flex', joint5: 'Joint 5: wrist roll', 'gripper-follower': 'Follower gripper', 'gripper-leader': 'Leader handle and trigger' };
const JOINT_CAPTION = 'Side view of the arm, schematic, not to scale. Left: where this joint sits on the arm (the orange circle). Right: the order to put the parts together, top to bottom, with the screws that hold each one. Orange outline = added in this step, dark box = a motor, dashed = already built.';

/* ---------- 3. horns: only the first horn (on the spindle) gets the screw ---------- */
function hornPanel({ screwTop, screwBottom, second, bad, title, note }) {
  let s = T(100, 16, title, { a: 'middle', c: 'dg-small', st: 'fill:var(--text);font-weight:700' });
  s += R(52, 78, 96, 70, { st: MOTOR }) + T(100, 117, 'motor', { a: 'middle', c: 'dg-small' });
  s += R(92, 68, 16, 10, { rx: 2, st: MOTOR }); // spindle nub
  s += R(60, 56, 80, 12, { st: 'fill:var(--surface);stroke-width:1.8' }) + T(148, 66, 'horn 1', { c: 'dg-small' });
  if (screwTop) s += R(94, 44, 12, 12, { rx: 2, st: 'fill:var(--ok);stroke:var(--text);stroke-width:1.2' }) + L(97, 50, 103, 50, 'dg-part', 'stroke-width:1.2');
  if (second) {
    s += R(92, 148, 16, 8, { rx: 2, st: MOTOR });
    s += R(60, 156, 80, 12, { st: bad ? BAD_FILL : 'fill:var(--surface);stroke-width:1.8' }) + T(148, 166, 'horn 2', { c: 'dg-small' });
    if (screwBottom) s += R(94, 168, 12, 12, { rx: 2, st: 'fill:var(--bad);stroke:var(--text);stroke-width:1.2' }) + cross(100, 174, 9);
  }
  if (note) s += T(148, 179, note, { c: 'dg-small' });
  return s;
}
function horns({ single = false } = {}) {
  const right = svg(hornPanel({ screwTop: true, second: !single, title: single ? 'one horn, one screw' : 'screw in horn 1 only', note: single ? '' : 'no screw' }), { viewBox: '0 0 200 190', label: single ? 'Right: one horn with one screw' : 'Right: screw in the first horn only' });
  const wrong = svg(single ? hornPanel({ screwTop: true, second: true, bad: true, title: 'a second horn', note: 'extra' }) : hornPanel({ screwTop: true, screwBottom: true, second: true, bad: true, title: 'screw in both horns' }), { viewBox: '0 0 200 190', label: single ? 'Wrong: a second horn' : 'Wrong: screws in both horns' });
  return {
    node: rightWrong(
      { node: right, caption: single ? 'This motor gets <b>one</b> horn, with the M3x6 horn screw.' : 'Only the <b>first horn</b> (on the spindle) gets the M3x6 screw.' },
      { node: wrong, caption: single ? 'A second horn. Not on this motor.' : 'A screw in the second horn. It gets none.' }),
    caption: 'Side view of one motor standing up, spindle at the top, schematic, not to scale. Horn = the small round disc on the motor. Horn 1 is the one you press onto the spindle first.',
    title: single ? 'The horn' : 'The two horns',
  };
}

/* ---------- 4. motor sits ALL the way down in its holder ---------- */
function holderPanel(ok) {
  let s = '';
  s += `<path d="M26 40v100h148V40h-18v86H44V40z" class="dg-part" style="fill:var(--surface2);stroke-width:1.8"/>`;
  s += T(100, 156, 'base', { a: 'middle', c: 'dg-small' });
  if (ok) {
    s += R(48, 58, 104, 68, { st: MOTOR }) + T(100, 98, 'motor', { a: 'middle', c: 'dg-small' });
    s += screw(37, 56) + screw(37, 112) + screw(163, 56) + screw(163, 112);
    s += L(48, 130, 152, 130, 'dg-do', 'stroke-width:1.6;stroke-dasharray:3 3');
  } else {
    s += `<g transform="rotate(-7 100 90)">` + R(48, 40, 104, 68, { st: MOTOR }) + `</g>` + T(100, 80, 'motor', { a: 'middle', c: 'dg-small' });
    s += arrow(100, 128, 100, 113, 'dg-avoid') + T(92, 124, 'gap', { a: 'end', c: 'dg-small', st: 'fill:var(--bad);font-weight:700' });
  }
  return s;
}
function motorInBase() {
  return {
    node: rightWrong(
      { node: svg(holderPanel(true), { viewBox: '0 0 200 170', label: 'Right: motor all the way down in the base' }), caption: 'The motor sits <b>all the way down</b>. Four M2x6 screws hold it.' },
      { node: svg(holderPanel(false), { viewBox: '0 0 200 170', label: 'Wrong: motor not all the way down' }), caption: 'A gap under it, or it tilts or rocks.' }),
    caption: 'Side view of the base, schematic, not to scale. Green dots = the 4 screws that hold the motor: two from the top and two from the bottom, as the official guide says. Where exactly they go is in the video.',
    title: 'Motor in the base',
  };
}

/* ---------- 5. cables: the plug sits level with the socket opening ---------- */
function plugPanel(ok) {
  const dx = ok ? 0 : 20;
  let s = '';
  s += `<path d="M20 40h118v22h-22v32h22v22H20z" class="dg-part" style="${MOTOR}"/>`;           // motor housing with a recess for the plug
  s += T(60, 88, 'motor', { a: 'middle', c: 'dg-small' });
  s += R(112 + dx, 62, 26, 32, { rx: 3, st: ok ? GOOD_FILL : BAD_FILL });                          // plug
  s += L(138 + dx, 78, 186, 78, 'dg-part', 'stroke-width:6;stroke-linecap:round') + L(138 + dx, 78, 186, 78, 'dg-part', 'stroke:var(--surface2);stroke-width:3.4;stroke-linecap:round'); // cable
  s += L(138, 30, 138, 126, 'dg-dim');                                                           // housing edge
  s += T(138, 24, 'edge', { a: 'middle', c: 'dg-small' });
  if (!ok) s += arrow(138, 112, 158, 112, 'dg-avoid') + T(148, 128, 'sticks out', { a: 'middle', c: 'dg-small', st: 'fill:var(--bad);font-weight:700' });
  else s += T(138, 128, 'level with the edge', { a: 'middle', c: 'dg-small', st: 'fill:var(--ok);font-weight:700' });
  return s;
}
function cables() {
  return {
    node: rightWrong(
      { node: svg(plugPanel(true), { viewBox: '0 0 200 140', label: 'Right: plug level with the motor edge' }), caption: 'The plug sits <b>flush</b>: level with the motor edge.' },
      { node: svg(plugPanel(false), { viewBox: '0 0 200 140', label: 'Wrong: plug sticks out' }), caption: 'The plug sticks out. Push it in until it stops.' }),
    caption: 'Top view of the end of a motor with its 3-pin cable plugged in, schematic, not to scale. Push each plug in until it stops: the plug is then level with the motor edge.',
    title: 'The 3-pin cable',
  };
}

/* ---------- 6. the chain: board, then motors 1 to 6 in one line ---------- */
function chainPanel(ok) {
  let s = '';
  s += R(6, 30, 70, 56, { st: 'fill:var(--surface2)' }) + T(41, 54, 'USB servo', { a: 'middle', c: 'dg-small' }) + T(41, 68, 'board', { a: 'middle', c: 'dg-small' });
  const xs = [96, 148, 200, 252, 304, 356];
  xs.forEach((x, i) => {
    const dead = !ok && i >= 3;
    s += R(x, 38, 44, 40, { st: dead ? 'fill:var(--surface2);stroke:var(--bad);stroke-dasharray:4 3;stroke-width:1.8' : MOTOR }) + T(x + 22, 63, String(i + 1), { a: 'middle', st: 'font-size:15px;font-weight:800' });
    const from = i === 0 ? 76 : x - 8, to = x;
    if (ok || i < 3) s += L(from, 58, to, 58, 'dg-do');
    else if (i === 3) s += L(x - 8, 58, x - 2, 58, 'dg-avoid', 'stroke-dasharray:2 3');
  });
  if (!ok) {
    s += cross(242, 58, 7) + T(250, 100, 'cable missing here', { a: 'end', c: 'dg-small', st: 'fill:var(--bad);font-weight:700' }) + T(262, 100, '4, 5 and 6 do not answer', { c: 'dg-small', st: 'fill:var(--bad)' });
  } else {
    s += T(41, 100, 'USB + power', { a: 'middle', c: 'dg-small' }) + T(41, 112, 'unplugged', { a: 'middle', c: 'dg-small' }) + T(250, 100, 'one cable from each motor to the next', { a: 'middle', c: 'dg-small', st: 'fill:var(--ok);font-weight:700' });
  }
  return s;
}
function chain() {
  return {
    node: (() => {
      const el = rightWrong(
        { node: svg(chainPanel(true), { viewBox: '0 0 410 120', label: 'Right: board, then motors 1 to 6 in one line' }), caption: 'Board, then <b>1, 2, 3, 4, 5, 6</b>, in one line.' },
        { node: svg(chainPanel(false), { viewBox: '0 0 410 120', label: 'Wrong: a cable missing in the middle' }), caption: 'One missing cable in the middle: every motor after it goes silent.' });
      el.style.gridTemplateColumns = '1fr';
      return el;
    })(),
    caption: 'Top view of one arm laid flat, schematic: the motors in a row (the real arm is folded up). The cable runs from the board to motor 1, from 1 to 2, and so on to 6. Do the same on the other arm.',
    title: 'The chain',
  };
}

/* ---------- 7. cleaning off print support: push the tool AWAY from your hand ---------- */
function cleanPanel(ok) {
  let s = '';
  s += R(24, 34, 150, 78, { st: 'fill:var(--surface2)' }) + T(80, 104, 'printed part', { c: 'dg-small' });
  // support lattice on the working edge (top right)
  s += R(118, 34, 56, 22, { rx: 2, st: 'fill:none;stroke:var(--muted);stroke-dasharray:2 3' });
  for (let x = 122; x < 172; x += 8) s += L(x, 36, x + 6, 54, 'dg-dim');
  s += T(146, 28, 'support', { a: 'middle', c: 'dg-small' });
  if (ok) {
    s += hand(58, 64, 1.1, 0) + T(24, 168, 'one hand flat, fingers point to you', { c: 'dg-small' });
    s += L(150, 138, 138, 50, 'dg-part', 'stroke-width:6;stroke-linecap:round;stroke:var(--text)') + L(150, 138, 138, 50, 'dg-part', 'stroke-width:3;stroke-linecap:round;stroke:var(--surface2)');
    s += arrow(196, 100, 196, 54, 'dg-do') + T(204, 82, 'push', { c: 'dg-small', st: 'fill:var(--ok);font-weight:700' }) + T(204, 95, 'away', { c: 'dg-small', st: 'fill:var(--ok);font-weight:700' });
  } else {
    s += hand(142, 62, 1.1, 0) + L(60, 150, 136, 84, 'dg-part', 'stroke-width:6;stroke-linecap:round;stroke:var(--text)') + L(60, 150, 136, 84, 'dg-part', 'stroke-width:3;stroke-linecap:round;stroke:var(--surface2)');
    s += arrow(86, 128, 128, 92, 'dg-avoid') + T(24, 168, 'tool points at your hand', { c: 'dg-small', st: 'fill:var(--bad);font-weight:700' });
  }
  return s;
}
function clean() {
  return {
    node: rightWrong(
      { node: svg(cleanPanel(true), { viewBox: '0 0 240 176', label: 'Right: the tool pushes away from your hand' }), caption: 'Push the tool <b>away</b> from your hand and body.' },
      { node: svg(cleanPanel(false), { viewBox: '0 0 240 176', label: 'Wrong: the tool points at your hand' }), caption: 'Never push toward your hand. A slip goes into it.' }),
    caption: 'Top view, you sit at the bottom, schematic. Press the part flat with one hand and work on the edge that is farthest from that hand. Support material = the thin rough scaffolding left by the printer.',
    title: 'Cleaning the printed parts',
  };
}

/* ---------- registry ---------- */
const jointDiagram = (id) => () => ({ node: jointPic(JOINT_NO[id], JOINT_ROWS[id], `${JOINT_TITLE[id]}: where it sits and what goes on what`), caption: JOINT_CAPTION, title: JOINT_TITLE[id] });
const REG = { horns, 'motor-in-base': motorInBase, cables, chain, clean };
for (const id of Object.keys(JOINT_ROWS)) REG[id] = jointDiagram(id);

export const DIAGRAM_IDS = Object.keys(REG);
/** diagram('joint2') -> {node, caption, title}; unknown id -> null (the page just shows no picture). */
export function diagram(id, opts = {}) { try { return REG[id] ? REG[id](opts) : null; } catch (e) { console.warn('diagram failed', id, e); return null; } }
