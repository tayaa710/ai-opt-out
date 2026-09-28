import { test, expect } from '@playwright/test';
import { openFixture, runSteps } from './helpers/content.mjs';

test('scratch', async ({ page }) => {
  page.on('console', (m) => console.log('PAGE', m.text()));
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await openFixture(page, 'patterns/radix-switch.html');
  const r = await runSteps(page, [
    { action: 'waitFor', target: { text: ['Improve the model for everyone'] } },
    { action: 'setToggle', target: { role: 'switch', text: ['Improve the model for everyone'] }, state: 'off' },
  ]);
  console.log(JSON.stringify(r));
  const ids = await page.evaluate(() => NoTrainEngine.findAll({ role: 'switch', text: ['Chat history'] }).map((e) => e.outerHTML.slice(0, 80)));
  console.log(ids);
  await openFixture(page, 'patterns/decoys.html');
  const d = await page.evaluate(() => NoTrainEngine.findAll({ role: 'switch', text: ['Use my data for AI training'] }).map((e) => e.id || e.dataset.decoy));
  console.log('decoys', d);
});
