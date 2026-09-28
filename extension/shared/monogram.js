// Service monogram tiles. Brand logos are not bundled (trademarks), so each
// service gets a coloured tile from its registry `brandColor` with initials in
// whichever of white / near-black has the higher contrast (always >= 4.5:1).

import { h } from './dom.js';

const FALLBACK_COLORS = [
  '#4f46e5',
  '#0f766e',
  '#b45309',
  '#be185d',
  '#1d4ed8',
  '#7c3aed',
  '#15803d',
  '#475569',
];
const DARK_TEXT = '#111827';
const LIGHT_TEXT = '#ffffff';

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text colour for a background: whichever of white / near-black contrasts more. */
export function readableTextColor(bg) {
  return contrastRatio(bg, LIGHT_TEXT) >= contrastRatio(bg, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

/** Tile colour: the registry brandColor if valid, else a stable fallback from the id. */
export function tileColor(service) {
  if (parseHex(service?.brandColor)) return service.brandColor;
  return FALLBACK_COLORS[hashString(String(service?.id ?? service?.name ?? '')) % FALLBACK_COLORS.length];
}

/**
 * One or two letters: first letter of the first two words ("Meta AI" → "MA"),
 * otherwise the first letter ("ChatGPT" → "C"). Ignores bracketed suffixes.
 */
export function initials(name) {
  const clean = String(name ?? '')
    .replace(/\(.*?\)/g, ' ')
    .trim();
  const words = clean.split(/[\s/&+·-]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return '?';
  const first = (w) => Array.from(w.replace(/^[^\p{L}\p{N}]+/u, ''))[0] ?? '';
  if (words.length === 1) return first(words[0]).toUpperCase();
  return (first(words[0]) + first(words[1])).toUpperCase();
}

/**
 * @param {{ id?: string, name: string, brandColor?: string }} service
 * @param {{ size?: 'sm'|'md'|'lg'|'xl' }} [opts]
 */
export function monogram(service, { size = 'md' } = {}) {
  const bg = tileColor(service);
  const text = initials(service?.name);
  return h(
    'span',
    {
      class: ['nt-tile', size !== 'md' && `nt-tile--${size}`],
      style: {
        background: bg,
        color: readableTextColor(bg),
        fontSize: text.length > 1 ? 'calc(var(--tile-size) * 0.34)' : null,
      },
      'aria-hidden': 'true',
    },
    text,
  );
}
