import { test, expect } from './helpers/extension.mjs';
test('scratch', async ({ context, serviceWorker, openExtensionPage }) => {
  const logs = [];
  serviceWorker.on('console', (m) => logs.push(m.text()));
  const page = await openExtensionPage('popup/popup.html');
  const res = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }));
  console.log(JSON.stringify({ ok: res.ok, error: res.error, meta: res.data?.registryMeta, settings: res.data?.settings, n: res.data?.registry?.services?.length }));
  console.log('pages', context.pages().map((p) => p.url()));
  console.log('logs', logs);
  const bad = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'nope' }));
  console.log(JSON.stringify(bad));
  expect(res.ok).toBe(true);
});
