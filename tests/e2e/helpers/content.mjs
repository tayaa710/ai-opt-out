// Helpers for the content-script tests (engine, overlay, recipes).
// Fixtures under tests/fixtures/ are served from a fake https origin through
// page.route, so pages get a real origin (sessionStorage, secure context) and
// no web server is needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');
export const FIXTURES_DIR = path.join(ROOT, 'tests/fixtures');
export const SERVICES_DIR = path.join(ROOT, 'registry/services');
export const ENGINE_PATH = path.join(ROOT, 'extension/content/engine.js');
export const OVERLAY_PATH = path.join(ROOT, 'extension/content/overlay.js');
export const PASSIVE_PATH = path.join(ROOT, 'extension/content/passive-check.js');
export const FIXTURE_ORIGIN = 'https://fixtures.notrain.test';

/** Serves tests/fixtures/** at FIXTURE_ORIGIN for this page. */
export async function serveFixtures(page) {
  await page.route(`${FIXTURE_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(FIXTURES_DIR, rel);
    if (
      !file.startsWith(FIXTURES_DIR + path.sep) ||
      !fs.existsSync(file) ||
      fs.statSync(file).isDirectory()
    ) {
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    await route.fulfill({ path: file });
  });
}

export function fixtureUrl(rel, query = '') {
  return `${FIXTURE_ORIGIN}/${rel}${query ? (query.startsWith('?') ? query : `?${query}`) : ''}`;
}

export async function injectEngine(page) {
  await page.addScriptTag({ path: ENGINE_PATH });
  await page.waitForFunction(() => !!globalThis.NoTrainEngine);
}

/**
 * Opens a fixture page (and injects the engine unless `engine: false`).
 * @param {import('@playwright/test').Page} page
 * @param {string} rel path under tests/fixtures, e.g. 'patterns/radix-switch.html'
 */
export async function openFixture(page, rel, { query = '', engine = true } = {}) {
  await serveFixtures(page);
  await page.goto(fixtureUrl(rel, query));
  if (engine) await injectEngine(page);
}

/** Runs NoTrainEngine.runSteps in the page and returns its result plus progress events. */
export async function runSteps(page, steps, options = {}) {
  return page.evaluate(
    async ({ steps, options }) => {
      const progress = [];
      const result = await globalThis.NoTrainEngine.runSteps(steps, {
        ...options,
        onProgress: (p) => progress.push(p),
      });
      return { ...result, progress };
    },
    { steps, options },
  );
}

/** All registry services (parsed JSON), sorted by id. */
export function loadServices() {
  return fs
    .readdirSync(SERVICES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(SERVICES_DIR, f), 'utf8')));
}

/** Records chrome.runtime.sendMessage calls in window.__sent (overlay / passive tests). */
export async function stubRuntime(page, { responses = {} } = {}) {
  await page.addInitScript((responses) => {
    globalThis.__NOTRAIN_TEST__ = true;
    window.__sent = [];
    const runtime = {
      id: 'test-extension',
      sendMessage(msg) {
        window.__sent.push(JSON.parse(JSON.stringify(msg)));
        const res = responses[msg && msg.type];
        return Promise.resolve(res === undefined ? { ok: true, data: null } : res);
      },
    };
    try {
      if (!window.chrome) window.chrome = {};
      Object.defineProperty(window.chrome, 'runtime', { value: runtime, configurable: true, writable: true });
    } catch {
      window.chrome = { runtime };
    }
  }, responses);
}
