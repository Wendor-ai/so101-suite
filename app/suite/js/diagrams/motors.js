// Diagrams for the Motor IDs and Setup pages. Every function returns an <svg> node (via svg() from ui.js).
// Drawn with the CSS variables and helper classes from components.css, so they read in light and dark.
// Conventions: top view, you sit at the bottom of the picture; green = do this; red cross = leave it / do not; orange number = step number.
// These are schematic pictures, not photos: boards differ a little between shops.
import { svg, h, rich } from '../ui.js';
import { stepCard } from '../steps.js';

const T = (x, y, s, cls = 'dg-label', anchor = 'middle') => `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${s}</text>`;
const num = (x, y, n) => `<circle class="dg-hi" cx="${x}" cy="${y}" r="10"/><text x="${x}" y="${y + 4}" text-anchor="middle" style="fill:var(--accent-ink,#1b0e00);font-weight:800;font-size:12px">${n}</text>`;
const cross = (x, y) => `<path class="dg-avoid" d="M${x - 8} ${y - 8}l16 16M${x + 8} ${y - 8}l-16 16"/>`;
const tick = (x, y) => `<path class="dg-do" d="M${x - 8} ${y}l6 7 11-14"/>`;
const arrowL = (x1, y, x2) => `<path class="dg-do" d="M${x1} ${y}H${x2}"/><path class="dg-do-fill" d="M${x2 - 9} ${y}l11-7v14z"/>`;
const arrowR = (x1, y, x2) => `<path class="dg-do" d="M${x1} ${y}H${x2}"/><path class="dg-do-fill" d="M${x2 + 9} ${y}l-11-7v14z"/>`;
const greenCable = (d) => `<path d="${d}" fill="none" class="dg-do" style="stroke-width:5"/>`;
const dimCable = (d) => `<path d="${d}" fill="none" style="stroke:var(--dg-dim);stroke-width:5;stroke-linecap:round;fill:none"/>`;

/** The computer: a laptop seen from above. `rows` draws a little port list on its screen (optionally with a new, highlighted line). */
function computer(x, y, { list = false, newLine = false } = {}) {
  let s = `<rect class="dg-part" x="${x}" y="${y}" width="104" height="66" rx="8"/><rect class="dg-part" x="${x + 6}" y="${y + 6}" width="92" height="54" rx="4" style="fill:var(--surface2)"/>`;
  if (list) {
    s += `<path d="M${x + 14} ${y + 18}h40M${x + 14} ${y + 30}h50" style="stroke:var(--dg-dim);stroke-width:3;stroke-linecap:round"/>`;
    if (newLine) s += `<rect x="${x + 12}" y="${y + 38}" width="72" height="12" rx="4" style="fill:color-mix(in srgb,var(--dg-do) 35%,transparent);stroke:var(--dg-do);stroke-width:1.4"/>${tick(x + 90, y + 44)}`;
  }
  return s + T(x + 52, y + 84, 'Computer');
}

/** The USB servo board lying flat. Motor sockets along the top (or bottom) edge, USB socket on the left, round power socket on the right. */
function board(x, y, { w = 150, h = 96, sockets = 'top', label = 'USB servo board', labelY } = {}) {
  const sy = sockets === 'top' ? y - 5 : y + h - 5;
  let s = `<rect class="dg-part" x="${x}" y="${y}" width="${w}" height="${h}" rx="8" style="fill:var(--surface2)"/>`;
  s += `<rect class="dg-part" x="${x - 9}" y="${y + h / 2 - 13}" width="17" height="26" rx="3"/>${T(x + 22, y + h / 2 + 4, 'USB', 'dg-small')}`;
  s += `<circle class="dg-part" cx="${x + w}" cy="${y + 30}" r="10"/><circle cx="${x + w}" cy="${y + 30}" r="3.2" style="fill:var(--dg-part)"/>${T(x + w - 26, y + 34, 'Power', 'dg-small')}`;
  for (let i = 0; i < 3; i++) s += `<rect class="dg-part" x="${x + 34 + i * 30}" y="${sy}" width="20" height="11" rx="2"/>`;
  s += T(x + w / 2 + 6, labelY ?? y + h - 16, label, 'dg-label');
  return s;
}

/** The power supply: a small box with the cable to the wall. */
const brick = (x, y, wallDir = 'right') => `<rect class="dg-part" x="${x}" y="${y}" width="70" height="38" rx="6"/>${T(x + 35, y + 16, 'Power', 'dg-small')}${T(x + 35, y + 29, 'supply', 'dg-small')}` +
  (wallDir === 'right' ? `<path d="M${x + 70} ${y + 19}h18" style="stroke:var(--dg-part);stroke-width:4;stroke-linecap:round"/><rect class="dg-part" x="${x + 86}" y="${y + 10}" width="12" height="18" rx="2"/>${T(x + 92, y + 52, 'Wall', 'dg-small')}` : '');

const VB = '0 0 480 270';

/** Step "Plug in the board": numbers 1-4 match the four steps (power plug in board, supply in the wall, USB in board, USB in computer). */
export function boardSetup() {
  const s = computer(18, 18) +
    board(170, 118) +
    greenCable('M122 51 C150 51 140 168 161 168') +                                  // USB cable computer -> board
    greenCable('M320 148 C344 148 330 78 354 78') +                                   // power cable board -> supply
    brick(354, 60, 'right') +
    num(318, 124, 1) + num(446, 79, 2) + num(166, 144, 3) + num(124, 40, 4) +
    T(245, 232, 'The board lies flat on the table, motors not connected yet', 'dg-small');
  return svg(s, { viewBox: VB, label: 'Top view of the table. A computer at the top left, a USB cable from it to the left side of the USB servo board, and a power supply at the top right with a cable to the board. Numbers 1 to 4 mark the four steps.' });
}

/** Identify, step "unplug": only the USB cable comes out. */
export function unplugUsb() {
  const s = computer(18, 18, { list: true }) +
    board(170, 118) +
    greenCable('M122 51 C150 51 140 168 161 168') +
    arrowL(150, 206, 104) + T(112, 228, 'Pull this one out', 'dg-label', 'start') +
    `<rect class="dg-hand" x="128" y="150" width="34" height="26" rx="12"/><ellipse class="dg-hand" cx="142" cy="150" rx="8" ry="6"/>` +
    dimCable('M320 148 C344 148 330 78 354 78') + brick(354, 60) + cross(334, 128) + T(398, 124, 'Power:', 'dg-small') + T(398, 136, 'leave in', 'dg-small') +
    dimCable('M214 113 V62') + `<rect class="dg-part" x="184" y="22" width="60" height="38" rx="6" style="fill:#14171d"/>` + `<text x="214" y="45" text-anchor="middle" style="fill:#e8eef6;font:600 10.5px var(--font)">Motor</text>` + cross(262, 86) + T(278, 83, 'Motor cable:', 'dg-small', 'start') + T(278, 95, 'leave in', 'dg-small', 'start');
  return svg(s, { viewBox: VB, label: 'Top view. The USB cable between the computer and the left side of the servo board is highlighted with an arrow pulling it away from the board. The power cable and the motor cable have red crosses: leave them plugged in.' });
}

/** Identify, step "plug back in": the same cable goes back into the same socket; a new line appears on the computer. */
export function replugUsb() {
  const s = computer(18, 18, { list: true, newLine: true }) +
    board(170, 118) +
    greenCable('M122 51 C150 51 140 168 161 168') +
    arrowR(100, 206, 150) + T(100, 228, 'Push it back in', 'dg-label', 'start') +
    `<rect class="dg-hand" x="128" y="150" width="34" height="26" rx="12"/><ellipse class="dg-hand" cx="142" cy="150" rx="8" ry="6"/>` +
    dimCable('M320 148 C344 148 330 78 354 78') + brick(354, 60) +
    T(72, 120, 'A new line appears', 'dg-small') +
    dimCable('M214 113 V62') + `<rect class="dg-part" x="184" y="22" width="60" height="38" rx="6" style="fill:#14171d"/>`;
  return svg(s, { viewBox: VB, label: 'Top view. The same USB cable is pushed back into the left side of the servo board. A new line, highlighted in green with a tick, appears in the list of ports on the computer screen.' });
}

/** Waveshare jumpers: right (both caps on B) next to wrong (a cap on A). Schematic, close-up of the pin rows beside the USB socket. */
export function jumpers(which = 'right') {
  const cap = (x, y, onB) => {
    const pinX = (col) => x + (col === 'A' ? 0 : 84);
    const cx = onB ? pinX('B') : pinX('A');
    return `<rect class="dg-part" x="${x - 12}" y="${y - 14}" width="132" height="28" rx="6" style="fill:var(--surface2)"/>` +
      [0, 1, 2, 3].map((i) => `<circle cx="${x + (i < 2 ? i * 22 : 84 + (i - 2) * 22)}" cy="${y}" r="4" style="fill:var(--dg-part)"/>`).join('') +
      T(x + 11, y + 30, 'A', 'dg-label') + T(x + 95, y + 30, 'B', 'dg-label') +
      `<rect x="${cx - 8}" y="${y - 10}" width="38" height="20" rx="5" style="fill:${onB ? 'var(--dg-do)' : 'var(--dg-avoid)'};opacity:.92"/>`;
  };
  const ok = which === 'right';
  const s = `${T(60, 22, 'Jumper 1', 'dg-small', 'middle')}${cap(30, 52, ok)}${T(60, 100, 'Jumper 2', 'dg-small', 'middle')}${cap(30, 130, ok)}` +
    (ok ? tick(190, 90) : '');
  return svg(s, { viewBox: '0 0 220 172', label: ok ? 'Close-up of the two small jumper caps. Both sit on the two pins marked B.' : 'Wrong: a jumper cap sits on the pins marked A instead of B.' });
}

/** One motor on the bench: board + USB + power + ONE 3-pin cable + ONE motor. Numbers 3, 4, 5 match steps 3 (cable in motor), 4 (cable in board), 5 (supply in the wall). */
export function oneMotor({ id = 6, joint = 'Gripper' } = {}) {
  const s = computer(18, 18) +
    board(150, 108, { sockets: 'bottom' }) +
    greenCable('M102 51 C130 51 120 158 141 158') +
    greenCable('M320 138 C346 138 330 78 354 78') + brick(354, 60) +
    greenCable('M214 208 C214 250 300 252 332 214') +                                  // the one 3-pin cable
    `<rect x="330" y="186" width="92" height="46" rx="7" style="fill:#14171d;stroke:var(--dg-part);stroke-width:1.6"/><circle cx="404" cy="209" r="11" style="fill:#e8eef6;stroke:var(--dg-part);stroke-width:1.4"/>` +
    `<text x="364" y="204" text-anchor="middle" style="fill:#e8eef6;font:700 11px var(--font)">Motor ${id}</text><text x="364" y="219" text-anchor="middle" style="fill:#b9c4d2;font:600 10px var(--font)">${joint}</text>` +
    num(326, 192, 3) + num(222, 232, 4) + num(446, 79, 5) +
    `<rect x="14" y="150" width="84" height="44" rx="7" fill="none" class="dg-dim"/>${T(56, 168, 'Other motors:', 'dg-small')}${T(56, 181, 'stay in the bag', 'dg-small')}`;
  return svg(s, { viewBox: VB, label: `Top view of the table. The board is connected to the computer by USB and to the power supply. One 3-pin cable goes from a motor socket on the board to one motor, the ${joint.toLowerCase()} motor. The other motors stay in their bag.` });
}

/** The common mistake: two motors on the board at once. No text inside the picture; the caption says it. */
export function twoMotorsWrong() {
  const motor = (x, y) => `<rect x="${x}" y="${y}" width="70" height="34" rx="6" style="fill:#14171d;stroke:var(--dg-part);stroke-width:1.5"/><circle cx="${x + 56}" cy="${y + 17}" r="8" style="fill:#e8eef6"/>`;
  const s = `<rect class="dg-part" x="20" y="34" width="120" height="70" rx="8" style="fill:var(--surface2)"/>` +
    `<path d="M80 104 C80 130 160 140 190 120M60 104 C60 150 170 168 190 156" fill="none" style="stroke:var(--dg-avoid);stroke-width:5;stroke-linecap:round"/>` +
    motor(190, 102) + motor(190, 142);
  return svg(s, { viewBox: '0 0 290 190', label: 'Wrong: two motors are plugged into the board at once.' });
}

/** Leader vs follower: which arm is which, in one picture. Side view of two simplified arms. */
export function leaderFollower() {
  const arm = (x, kind) => {
    const base = `<rect class="dg-part" x="${x}" y="120" width="70" height="16" rx="4"/>`;
    const link = (d) => `<path d="${d}" fill="none" style="stroke:var(--dg-part);stroke-width:9;stroke-linecap:round;stroke-linejoin:round"/><path d="${d}" fill="none" style="stroke:var(--surface2);stroke-width:5;stroke-linecap:round;stroke-linejoin:round"/>`;
    const body = link(`M${x + 20} 118 L${x + 36} 62 L${x + 92} 52`) + `<circle class="dg-part" cx="${x + 36}" cy="62" r="5"/><circle class="dg-part" cx="${x + 92}" cy="52" r="5"/>`;
    const tool = kind === 'follower'
      ? `<path d="M${x + 92} 52 L${x + 108} 84" style="stroke:var(--dg-part);stroke-width:7;stroke-linecap:round" fill="none"/><path class="dg-do" d="M${x + 108} 84 l-9 20M${x + 108} 84 l9 20" style="stroke-width:4"/>`
      : `<path d="M${x + 92} 52 L${x + 112} 70" style="stroke:var(--dg-part);stroke-width:7;stroke-linecap:round" fill="none"/><rect class="dg-hand" x="${x + 104}" y="66" width="22" height="36" rx="10"/><path class="dg-do" d="M${x + 112} 102 l14 12" style="stroke-width:4"/>`;
    return base + body + tool;
  };
  const s = arm(14, 'follower') + arm(236, 'leader') +
    T(100, 28, 'Follower', 'dg-label') + T(100, 160, 'has two jaws', 'dg-small') + T(100, 174, 'it does the work', 'dg-small') +
    T(322, 28, 'Leader', 'dg-label') + T(322, 160, 'has a handle with a trigger', 'dg-small') + T(322, 174, 'you hold it and move it', 'dg-small');
  return svg(s, { viewBox: '0 0 440 190', label: 'Side view of two arms. The follower, left, ends in a gripper with two jaws. The leader, right, ends in a handle with a trigger that you hold.' });
}

/* ---------- shared step copy (used by the Setup check how-to and the Motor IDs page) ---------- */
/** stepCard lays out know/ifNot as a flex row (and styles every <span> inside it as flex too), so inline markup would be split
 *  into separate flex items. Wrapping it in ONE <div> makes it flow as ordinary text. */
export const inline = (html) => h('div', { class: 'inl' }, rich(html));

/** "Plug in the USB servo board": the four actions behind picture 1 to 4. */
export function connectBoardCard({ know, ifNot } = {}) {
  return stepCard({
    title: 'Plug in the USB servo board',
    where: 'The <b>USB servo board</b> is the small circuit board the motor cables plug into. In a built arm it sits in the base; with loose motors it lies on the table. It has a USB socket, a round power socket and a row of small 3-pin sockets (see the picture).',
    do: ['Push the round plug of the power supply into the board’s round power socket.', 'Plug the power supply into the wall socket.', 'Push the small end of the USB cable into the board’s USB socket.', 'Push the other end of the USB cable into a USB port on this computer.'],
    how: 'Push each plug in until it stops.',
    know: know || inline('A new line appears in the <b>Boards found</b> list.'),
    ifNot: ifNot || inline('Try a different USB cable. Some cables only charge and carry no data.'),
    diagram: boardSetup(), caption: 'Top view, you sit at the bottom. Numbers 1 to 4 match the four steps.',
  });
}
