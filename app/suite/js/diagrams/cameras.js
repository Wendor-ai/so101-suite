// Diagrams for the Cameras page (click-to-map the table). Colours are CSS variables so they read in light and dark.
// Each one answers one question: which part touches the table, where to put the spots, where to click.
import { svg } from '../ui.js';

const f1 = (n) => Math.round(n * 10) / 10;
const text = (x, y, s, { anchor = 'start', size = 13, fill, weight } = {}) => `<text x="${f1(x)}" y="${f1(y)}" text-anchor="${anchor}" style="font-size:${size}px;${fill ? `fill:${fill};` : ''}${weight ? `font-weight:${weight};` : ''}">${s}</text>`;
const head = (x, y, dx, dy, size, cls) => {
  const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
  const bx = x - dx * size, by = y - dy * size, px = -dy * size * 0.55, py = dx * size * 0.55;
  return `<polygon class="${cls}" points="${f1(x)},${f1(y)} ${f1(bx + px)},${f1(by + py)} ${f1(bx - px)},${f1(by - py)}"/>`;
};
const arrow = (a, b, cls = 'dg-do', size = 8) => `<line class="${cls}" x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0] - (b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]) * size * 0.6)}" y2="${f1(b[1] - (b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1]) * size * 0.6)}"/>${head(b[0], b[1], b[0] - a[0], b[1] - a[1], size, cls === 'dg-avoid' ? 'dg-avoid-fill' : 'dg-do-fill')}`;
const num = (x, y, n, cls = 'dg-hi', ink = '#1b0e00') => `<circle cx="${f1(x)}" cy="${f1(y)}" r="11" class="${cls}"/><text x="${f1(x)}" y="${f1(y + 4.6)}" text-anchor="middle" style="font:800 13px var(--font);fill:${ink}">${n}</text>`;
const jaw = (a, b, w, hi) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" style="stroke:var(--dg-part);stroke-width:${w + 2.6};stroke-linecap:round"/><line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" style="stroke:${hi ? 'color-mix(in srgb,var(--accent) 40%,var(--dg-fill))' : 'var(--dg-fill)'};stroke-width:${w};stroke-linecap:round"/>`;

/** Side view of the gripper pointing down with the jaws closed: the touching tips are the point that meets the table. */
export function jawTips() {
  let g = `<line x1="14" y1="176" x2="386" y2="176" style="stroke:var(--dg-dim);stroke-width:2.4"/>`;
  g += text(384, 195, 'Table', { anchor: 'end', size: 11, fill: 'var(--muted)' });
  g += `<rect x="146" y="18" width="68" height="58" rx="9" class="dg-part"/>`;                  // back block (the body of the gripper)
  g += jaw([160, 76], [177, 166], 13, false);                                                   // fixed jaw
  g += jaw([200, 76], [183, 166], 13, true);                                                    // moving jaw
  g += `<circle cx="180" cy="170" r="8" class="dg-hi"/>`;                                       // the point that touches
  g += `<circle cx="180" cy="170" r="14" fill="none" style="stroke:var(--accent);stroke-width:1.6;stroke-dasharray:3 3"/>`;
  g += text(90, 50, 'Back block', { anchor: 'end' }) + `<line x1="94" y1="46" x2="144" y2="46" style="stroke:var(--dg-dim);stroke-width:1.2"/>`;
  g += text(112, 118, 'Fixed jaw', { anchor: 'end' }) + `<line x1="116" y1="114" x2="164" y2="114" style="stroke:var(--dg-dim);stroke-width:1.2"/>`;
  g += text(236, 118, 'Moving jaw', { anchor: 'start' }) + `<line x1="198" y1="114" x2="232" y2="114" style="stroke:var(--dg-dim);stroke-width:1.2"/>`;
  g += arrow([248, 152], [196, 168], 'dg-do', 9);
  g += text(252, 150, 'The two tips', { size: 14, weight: 700 });
  g += text(252, 167, 'touch the table here', { size: 14, weight: 700 });
  return svg(g, { viewBox: '0 0 400 204', label: 'Side view of the gripper pointing straight down with the jaws closed. The fixed jaw and the moving jaw meet at their tips. That meeting point is the part that touches the table.' });
}

/** Top view of the table as the camera sees it: three spread-out spots (right) or three clustered ones (wrong). */
export function spreadSpots(kind = 'good') {
  const good = kind === 'good';
  const pts = good ? [[78, 140], [244, 96], [112, 34]] : [[168, 100], [184, 108], [174, 118]];
  const col = good ? 'dg-hi' : 'dg-avoid-fill';
  let g = `<rect x="10" y="8" width="300" height="168" rx="10" style="fill:var(--surface);stroke:var(--dg-dim);stroke-width:1.6"/>`;
  g += `<rect x="150" y="150" width="40" height="26" rx="4" class="dg-part"/>` + text(170, 168, 'Arm', { anchor: 'middle', size: 11 });
  if (good) {
    g += `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" style="fill:color-mix(in srgb,var(--dg-do) 14%,transparent);stroke:var(--dg-do);stroke-width:1.6;stroke-dasharray:5 4"/>`;
    g += pts.map((p, i) => num(p[0], p[1], i + 1)).join('');
    g += text(78, 168, 'near', { anchor: 'middle', size: 11, fill: 'var(--muted)' }) + text(244, 124, 'middle', { anchor: 'middle', size: 11, fill: 'var(--muted)' }) + text(112, 62, 'far', { anchor: 'middle', size: 11, fill: 'var(--muted)' });
  } else {
    g += `<ellipse cx="176" cy="109" rx="30" ry="22" fill="none" style="stroke:var(--dg-avoid);stroke-width:1.8;stroke-dasharray:5 4"/>`;
    g += pts.map((p, i) => num(p[0], p[1], i + 1, 'dg-avoid-fill', '#1a0000')).join('');
  }
  return svg(g, { viewBox: '0 0 320 184', label: good ? 'Top view of the table. Three spots spread out: one near the arm, one in the middle, one far away. They make a big triangle.' : 'Top view of the table. Three spots bunched together in one small area. This is the wrong way.' });
}

/** A camera picture: the gripper hides the tip, so click the middle of the thing the tip is touching. */
export function clickHere() {
  let g = `<rect x="6" y="6" width="308" height="228" rx="10" style="fill:color-mix(in srgb,var(--surface2) 70%,#000);stroke:var(--dg-part);stroke-width:1.6"/>`;
  g += `<rect x="16" y="16" width="288" height="208" rx="6" style="fill:color-mix(in srgb,var(--surface2) 92%,var(--text) 8%)"/>`;
  // the gripper seen from above, partly covering the coin
  g += `<rect x="126" y="38" width="64" height="86" rx="12" class="dg-part"/><rect x="144" y="120" width="12" height="36" rx="5" class="dg-part"/><rect x="160" y="120" width="12" height="36" rx="5" class="dg-part"/>`;
  g += `<circle cx="158" cy="158" r="22" style="fill:color-mix(in srgb,#e04a3a 85%,var(--surface));stroke:var(--dg-part);stroke-width:1.4"/>`;
  g += `<path d="M144 142 q-6 18 14 30" fill="none" style="stroke:var(--dg-fill);stroke-width:2.2;opacity:.9"/>`;
  g += `<circle cx="158" cy="158" r="13" fill="none" style="stroke:var(--dg-do);stroke-width:2.6"/><line x1="158" y1="136" x2="158" y2="180" style="stroke:var(--dg-do);stroke-width:2"/><line x1="136" y1="158" x2="180" y2="158" style="stroke:var(--dg-do);stroke-width:2"/>`;
  g += arrow([244, 118], [176, 152], 'dg-do', 10);
  g += text(300, 104, 'Click the middle', { anchor: 'end', size: 14, weight: 700 });
  g += text(300, 120, 'of the marker', { anchor: 'end', size: 14, weight: 700 });
  g += text(26, 36, 'Gripper', { size: 12, fill: 'var(--muted)' }) + `<line x1="62" y1="32" x2="124" y2="52" style="stroke:var(--dg-dim);stroke-width:1.2"/>`;
  g += text(26, 212, 'Coin or keychain under the tips', { size: 12, fill: 'var(--muted)' });
  return svg(g, { viewBox: '0 0 320 240', label: 'A camera picture from above. The gripper is held over a coin on the table. The coin is partly visible next to the gripper. Click the middle of the coin, which is where the closed jaw tips touch.' });
}
