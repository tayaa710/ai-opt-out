#!/usr/bin/env node
// Renders the NoTrain toolbar/store icons from SVG with Playwright's Chromium.
//   node scripts/make-icons.mjs
// Writes extension/icons/icon.svg (master) and icon-{16,32,48,128}.png.
// The 16 px icon uses a simplified drawing so it stays legible in the toolbar;
// the 128 px icon has 16 px transparent padding as the Chrome Web Store asks.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'extension', 'icons');

const FROM = '#6366f1';
const TO = '#4338ca';

/**
 * The mark on a 32-unit grid. `detail` controls how much of the network is drawn.
 * @param {{ size: number, pad?: number, detail: 'full'|'tiny' }} opts
 */
function markSvg({ size, pad = 0, detail }) {
  const inner = 32;
  const scale = (size - pad * 2) / inner;
  const grad = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${FROM}"/><stop offset="1" stop-color="${TO}"/></linearGradient></defs>`;
  let body;
  if (detail === 'tiny') {
    // 16/32 px: the dot grid pushed away from a thicker slash so it survives downscaling.
    const dots = [
      [16.5, 8],
      [24, 8],
      [24, 15.5],
      [8, 16.5],
      [8, 24],
      [15.5, 24],
    ];
    body = [
      `<rect x="0" y="0" width="32" height="32" rx="7" fill="url(#g)"/>`,
      `<g fill="#fff">${dots.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="2.6"/>`).join('')}</g>`,
      `<path d="M7 7 25 25" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/>`,
    ].join('');
  } else {
    const dots = [
      [16, 9.5],
      [22.5, 9.5],
      [22.5, 16],
      [9.5, 16],
      [9.5, 22.5],
      [16, 22.5],
    ];
    const r = 2.2;
    const edges = `<path d="M16 9.5h6.5v6.5M16 9.5l6.5 6.5M9.5 16v6.5H16M9.5 16l6.5 6.5" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="1.1" stroke-linecap="round"/>`;
    body = [
      `<rect x="0" y="0" width="32" height="32" rx="8.5" fill="url(#g)"/>`,
      edges,
      `<g fill="#fff">${dots.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('')}</g>`,
      `<path d="M8.25 8.25 23.75 23.75" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`,
    ].join('');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${grad}<g transform="translate(${pad} ${pad}) scale(${scale})">${body}</g></svg>`;
}

const TARGETS = [
  { size: 16, detail: 'tiny', pad: 0 },
  { size: 32, detail: 'tiny', pad: 0 },
  { size: 48, detail: 'full', pad: 1 },
  { size: 128, detail: 'full', pad: 16 },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  // Master SVG: full detail, no padding (used by pages and the landing site).
  const master = markSvg({ size: 128, detail: 'full', pad: 0 }).replace(
    '<svg ',
    '<svg role="img" aria-label="NoTrain" ',
  );
  await writeFile(path.join(OUT_DIR, 'icon.svg'), `${master}\n`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const t of TARGETS) {
      const svg = markSvg(t);
      await page.setViewportSize({ width: t.size, height: t.size });
      await page.setContent(
        `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`,
      );
      const png = await page.screenshot({
        omitBackground: true,
        clip: { x: 0, y: 0, width: t.size, height: t.size },
      });
      await writeFile(path.join(OUT_DIR, `icon-${t.size}.png`), png);
      console.log(`icons: wrote icon-${t.size}.png`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
