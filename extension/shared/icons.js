// Inline stroke icons (24×24, 1.8 px stroke) built with createElementNS.
// Decorative by default (aria-hidden); pass { label } to make one meaningful.

import { s } from './dom.js';

const circle = (cx, cy, r) => ({ tag: 'circle', attrs: { cx, cy, r } });
const rect = (x, y, width, height, rx = 0) => ({ tag: 'rect', attrs: { x, y, width, height, rx } });

const ICONS = {
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  check: ['M20 6 9 17l-5-5'],
  checkCircle: [circle(12, 12, 10), 'm8.5 12 2.5 2.5 4.5-5'],
  alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  alertCircle: [circle(12, 12, 10), 'M12 8v4', 'M12 16h.01'],
  info: [circle(12, 12, 10), 'M12 16v-4', 'M12 8h.01'],
  shield: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
  ],
  shieldCheck: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    'm9 12 2 2 4-4',
  ],
  search: [circle(11, 11, 7.5), 'm20.5 20.5-4.2-4.2'],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  chevronRight: ['m9 18 6-6-6-6'],
  chevronLeft: ['m15 18-6-6 6-6'],
  chevronDown: ['m6 9 6 6 6-6'],
  arrowRight: ['M5 12h14', 'm12 5 7 7-7 7'],
  arrowLeft: ['M19 12H5', 'm12 19-7-7 7-7'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  copy: [rect(8, 8, 13, 13, 2), 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'],
  mail: [rect(2, 4, 20, 16, 2), 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
  zap: [
    'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
  ],
  listChecks: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
  letter: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M10 9H8',
    'M16 13H8',
    'M16 17H8',
  ],
  refresh: [
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
    'M21 3v5h-5',
    'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
    'M8 16H3v5',
  ],
  overview: [rect(3, 3, 7, 9, 1.5), rect(14, 3, 7, 5, 1.5), rect(14, 12, 7, 9, 1.5), rect(3, 16, 7, 5, 1.5)],
  grid: [rect(3, 3, 7, 7, 1.5), rect(14, 3, 7, 7, 1.5), rect(14, 14, 7, 7, 1.5), rect(3, 14, 7, 7, 1.5)],
  code: ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
  globe: [circle(12, 12, 10), 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20', 'M2 12h20'],
  lock: [rect(3, 11, 18, 11, 2), 'M7 11V7a5 5 0 0 1 10 0v4'],
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', circle(12, 7, 4)],
  clock: [circle(12, 12, 10), 'M12 6v6l4 2'],
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  trash: ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'],
  plus: ['M5 12h14', 'M12 5v14'],
  scan: [
    'M3 7V5a2 2 0 0 1 2-2h2',
    'M17 3h2a2 2 0 0 1 2 2v2',
    'M21 17v2a2 2 0 0 1-2 2h-2',
    'M7 21H5a2 2 0 0 1-2-2v-2',
    circle(11.5, 11.5, 3),
    'm16 16-2.3-2.3',
  ],
  sparkles: [
    'M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z',
  ],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  bot: ['M12 8V4H8', rect(4, 8, 16, 12, 2), 'M2 14h2', 'M20 14h2', 'M15 13v2', 'M9 13v2'],
  inbox: [
    'M22 12h-6l-2 3h-4l-2-3H2',
    'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  ],
  minusCircle: [circle(12, 12, 10), 'M8 12h8'],
  database: [{ tag: 'ellipse', attrs: { cx: 12, cy: 5, rx: 9, ry: 3 } }, 'M3 5v14a9 3 0 0 0 18 0V5', 'M3 12a9 3 0 0 0 18 0'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  eyeOff: [
    'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68',
    'M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61',
    'M14.12 14.12a3 3 0 1 1-4.24-4.24',
    'm2 2 20 20',
  ],
  history: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  heart: [
    'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z',
  ],
  book: ['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'],
  key: [circle(7.5, 15.5, 5.5), 'm21 2-9.6 9.6', 'm15.5 7.5 3 3L22 7l-3-3'],
  pencil: ['M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z'],
  circle: [circle(12, 12, 9)],
};

/**
 * @param {keyof typeof ICONS} name
 * @param {{ label?: string, size?: number, class?: string }} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, opts = {}) {
  const def = ICONS[name] ?? ICONS.circle;
  const svg = s('svg', {
    class: ['nt-icon', opts.class],
    viewBox: '0 0 24 24',
    width: opts.size ?? 18,
    height: opts.size ?? 18,
    'aria-hidden': opts.label ? null : 'true',
    role: opts.label ? 'img' : null,
    'aria-label': opts.label ?? null,
    focusable: 'false',
  });
  for (const part of def) {
    if (typeof part === 'string') svg.appendChild(s('path', { d: part }));
    else svg.appendChild(s(part.tag, part.attrs));
  }
  return svg;
}

export const ICON_NAMES = Object.freeze(Object.keys(ICONS));
