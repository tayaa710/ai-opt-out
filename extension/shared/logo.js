// NoTrain logo: a rounded square holding a small neural-network dot grid with
// a diagonal slash through it. Same geometry as scripts/make-icons.mjs
// (extension/icons/icon.svg); sizes <= 24 px use the simplified small-icon drawing.

import { h, s, uid } from './dom.js';

export const LOGO_GRADIENT = Object.freeze({ from: '#6366f1', to: '#4338ca' });

const FULL_DOTS = [
  [16, 9.5],
  [22.5, 9.5],
  [22.5, 16],
  [9.5, 16],
  [9.5, 22.5],
  [16, 22.5],
];

const SMALL_DOTS = [
  [16.5, 8],
  [24, 8],
  [24, 15.5],
  [8, 16.5],
  [8, 24],
  [15.5, 24],
];

/**
 * @param {{ size?: number, title?: string }} [opts] title makes the mark meaningful (role=img)
 * @returns {SVGSVGElement}
 */
export function logoMark({ size = 28, title } = {}) {
  const gid = uid('nt-logo-grad');
  const small = size <= 24;
  const svg = s('svg', {
    class: 'nt-logo__mark',
    viewBox: '0 0 32 32',
    width: size,
    height: size,
    role: title ? 'img' : null,
    'aria-label': title ?? null,
    'aria-hidden': title ? null : 'true',
    focusable: 'false',
  });
  svg.append(
    s(
      'defs',
      null,
      s(
        'linearGradient',
        { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' },
        s('stop', { offset: '0', 'stop-color': LOGO_GRADIENT.from }),
        s('stop', { offset: '1', 'stop-color': LOGO_GRADIENT.to }),
      ),
    ),
    s('rect', { x: 0, y: 0, width: 32, height: 32, rx: small ? 7 : 8.5, fill: `url(#${gid})` }),
    !small &&
      s('path', {
        d: 'M16 9.5h6.5v6.5M16 9.5l6.5 6.5M9.5 16v6.5H16M9.5 16l6.5 6.5',
        fill: 'none',
        stroke: '#ffffff',
        'stroke-opacity': '0.5',
        'stroke-width': '1.1',
        'stroke-linecap': 'round',
      }),
    s(
      'g',
      { fill: '#ffffff' },
      ...(small ? SMALL_DOTS : FULL_DOTS).map(([cx, cy]) => s('circle', { cx, cy, r: small ? 2.6 : 2.2 })),
    ),
    s('path', {
      d: small ? 'M7 7 25 25' : 'M8.25 8.25 23.75 23.75',
      stroke: '#ffffff',
      'stroke-width': small ? '3.6' : '2.6',
      'stroke-linecap': 'round',
    }),
  );
  return svg;
}

/**
 * Mark + "NoTrain" wordmark.
 * @param {{ size?: number, href?: string, label?: string }} [opts]
 */
export function brand({ size = 28, href, label } = {}) {
  const attrs = { class: 'nt-logo' };
  if (href) {
    attrs.href = href;
    if (label) attrs['aria-label'] = label;
  }
  return h(href ? 'a' : 'span', attrs, logoMark({ size }), h('span', { class: 'nt-logo__word' }, 'NoTrain'));
}
