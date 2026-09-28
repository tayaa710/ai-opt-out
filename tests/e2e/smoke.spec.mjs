import { test, expect } from './helpers/extension.mjs';

test('extension loads and its service worker starts', async ({ extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});
