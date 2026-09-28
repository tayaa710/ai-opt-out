// Shared Playwright fixture that launches Chromium with the unpacked
// extension loaded. Usage:
//   import { test, expect } from './helpers/extension.mjs';
//   test('x', async ({ context, extensionId, openExtensionPage }) => { ... });
import { test as base, chromium, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');
export const EXTENSION_DIR = process.env.NOTRAIN_EXTENSION_DIR
  ? path.resolve(process.env.NOTRAIN_EXTENSION_DIR)
  : path.join(ROOT, 'extension');

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  openExtensionPage: async ({ context, extensionId }, use) => {
    await use(async (pagePath) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
      return page;
    });
  },
});

export { expect };
