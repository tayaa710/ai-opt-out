// Dashboard UI tests: onboarding, services, service detail, letters, creators,
// alerts, settings, export/import, keyboard basics, console errors and an
// automated accessibility smoke check on every route.
import { readFile } from 'node:fs/promises';
import { test, expect } from './helpers/extension.mjs';
import { waitForPageUrl } from './helpers/fake-sites.mjs';
import { send, getState, openPage, seedDemo, a11yProblems, watchErrors } from './helpers/ui-state.mjs';

const DASH = 'dashboard/dashboard.html';
const ROUTES = [
  'overview',
  'services',
  'service/chatgpt',
  'letters',
  'creators',
  'alerts',
  'settings',
  'about',
  'welcome',
];

async function dashboard(context, extensionId, hash, { seed = true } = {}) {
  const page = await openPage(context, extensionId, `${DASH}#/about`);
  if (seed) await seedDemo(page);
  await page.goto(`chrome-extension://${extensionId}/${DASH}${hash}`);
  await expect(page.locator('[data-page-title]').first()).toBeVisible();
  return page;
}

test.describe('onboarding', () => {
  test('first run walks through region and services to the overview', async ({ context, extensionId }) => {
    const page = await openPage(context, extensionId, DASH);
    await expect(page).toHaveURL(/#\/welcome$/);
    await expect(page.getByTestId('welcome-step-1')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Decide who trains AI');
    await expect(page.getByText('Private by design')).toBeVisible();

    await page.getByTestId('welcome-next').click();
    await expect(page.getByTestId('welcome-step-2')).toBeVisible();
    await page.getByTestId('region-UK').check();
    await page.getByTestId('welcome-next').click();

    await expect(page.getByTestId('welcome-step-3')).toBeVisible();
    await expect(page.getByTestId('pick-count')).toHaveText('Nothing selected yet');
    await page.getByTestId('welcome-search').fill('chatg');
    const cards = page.locator('[data-testid="pick-service"]');
    await expect(cards).toHaveCount(1);
    await cards.first().check();
    await expect(page.getByTestId('pick-count')).toHaveText('1 service selected');
    await page.getByTestId('welcome-search').fill('');
    await page.locator('[data-service="claude"] input').check();
    await expect(page.getByTestId('welcome-next')).toHaveText('Continue with 2 services');
    await page.getByTestId('welcome-next').click();

    await expect(page.getByTestId('welcome-step-4')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('You’re set up');
    await expect(page.getByTestId('welcome-summary')).toBeVisible();

    const state = await getState(page);
    expect(state.settings.region).toBe('UK');
    expect(state.settings.onboarded).toBe(true);
    expect(state.userState.services.chatgpt.tracked).toBe(true);
    expect(state.userState.services.claude.tracked).toBe(true);

    await page.getByTestId('welcome-finish').click();
    await expect(page).toHaveURL(/#\/overview$/);
    await expect(page.getByTestId('overview-summary')).toContainText('of 2');
  });

  test('skip setup goes straight to an empty overview', async ({ context, extensionId }) => {
    const page = await openPage(context, extensionId, `${DASH}#/welcome`);
    await page.getByTestId('welcome-skip').click();
    await expect(page).toHaveURL(/#\/overview$/);
    await expect(page.getByTestId('overview-empty')).toBeVisible();
    expect((await getState(page)).settings.onboarded).toBe(true);
  });

  test('detect accounts explains the permission before asking', async ({ context, extensionId }) => {
    const page = await openPage(context, extensionId, `${DASH}#/welcome`);
    await page.getByTestId('welcome-next').click();
    await page.getByTestId('welcome-next').click();
    const detect = page.getByTestId('welcome-detect');
    if (await detect.count()) {
      await expect(page.getByText('never reads it')).toBeVisible();
    }
  });
});

test.describe('overview', () => {
  test('shows summary, attention, quick wins and recent alerts', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/overview');
    await expect(page.getByTestId('overview-summary')).toContainText('needs attention');
    await expect(page.locator('#attention')).toContainText('X (Twitter)');
    await expect(page.getByTestId('quick-wins')).toBeVisible();
    await expect(page.locator('#recent-alerts')).toContainText('Grok training was switched back on');
    // One row per service in the task lists.
    const names = await page.locator('#quick-wins .d-task__title, #todo .d-task__title').allTextContents();
    expect(new Set(names).size).toBe(names.length);
  });
});

test.describe('services', () => {
  test('search, filter and track toggle', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/services');
    const total = (await getState(page)).registry.services.length;
    await expect(page.getByTestId('results-count')).toHaveText(`${total} services`);

    await page.getByTestId('services-search').fill('linkedin');
    await expect(page.getByTestId('service-row')).toHaveCount(1);
    await expect(page.getByTestId('results-count')).toHaveText(`1 of ${total} services`);

    await page.getByTestId('services-search').fill('zzzz-nothing');
    await expect(page.getByTestId('services-empty')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByTestId('service-row')).toHaveCount(total);

    // Category filter only shows that category.
    await page.getByTestId('services-category').selectOption('social');
    const state = await getState(page);
    const socialIds = state.registry.services
      .filter((s) => s.category === 'social')
      .map((s) => s.id)
      .sort();
    const shown = (
      await page.getByTestId('service-row').evaluateAll((els) => els.map((e) => e.dataset.service))
    ).sort();
    expect(shown).toEqual(socialIds);
    await page.getByTestId('services-category').selectOption('all');

    // Track an untracked service.
    const row = page.locator('[data-testid="service-row"][data-service="reddit"]');
    await page.getByTestId('status-filter-untracked').click();
    const untrackedRow = page.locator('[data-testid="service-row"]').first();
    const id = await untrackedRow.getAttribute('data-service');
    await untrackedRow.getByTestId('track-toggle').check();
    await expect.poll(async () => (await getState(page)).userState.services[id]?.tracked).toBe(true);
    await page.getByTestId('status-filter-tracked').click();
    await expect(page.locator(`[data-testid="service-row"][data-service="${id}"]`)).toBeVisible();
    await expect(
      page.locator(`[data-testid="service-row"][data-service="${id}"] [data-testid="service-status"]`),
    ).toBeVisible();

    // Untrack again.
    await page.getByTestId('status-filter-all').click();
    await row.getByTestId('track-toggle').uncheck();
    await expect.poll(async () => (await getState(page)).userState.services.reddit?.tracked).toBe(false);
  });
});

test.describe('service detail', () => {
  test('facts, honesty note, steps, mark done and undo', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/service/claude');
    const state = await getState(page);
    const claude = state.registry.services.find((s) => s.id === 'claude');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(claude.name);
    await expect(page.getByTestId('fact-trains')).toBeVisible();
    await expect(page.getByTestId('fact-default')).toBeVisible();
    await expect(page.getByTestId('data-types').locator('li')).toHaveCount(claude.training.dataTypes.length);
    if (claude.training.retroactiveRemoval === false)
      await expect(page.getByTestId('future-only-note')).toBeVisible();
    await expect(page.getByTestId('sources').getByRole('link').first()).toHaveAttribute(
      'href',
      /^https:\/\//,
    );
    await expect(page.getByTestId('report-error')).toHaveAttribute(
      'href',
      /issues\/new\?template=registry-correction\.yml&title=/,
    );
    await expect(page.getByTestId('changelog')).toBeVisible();

    const card = page.getByTestId('optout-card').first();
    const optOut = claude.optOuts[0];
    await card.getByTestId('steps').locator('summary').click();
    await expect(card.locator('.nt-steps li')).toHaveCount(optOut.steps.length);

    await card.getByTestId('mark-done').click();
    await expect(card.getByTestId('optout-status')).toContainText('Done');
    let st = await getState(page);
    expect(st.userState.services.claude.optOuts[optOut.id].status).toBe('done');

    await card.getByTestId('mark-undo').click();
    await expect(card.getByTestId('optout-status')).toHaveCount(0);
    st = await getState(page);
    expect(st.userState.services.claude.optOuts[optOut.id].status).toBe('not_started');
  });

  test('Guide me opens the site and shows the steps inline', async ({ context, extensionId }) => {
    // Real service hosts are served by the local fake-sites server (helpers/fake-sites.mjs).
    // Claude is tracked but not yet opted out in the demo state, so its toggle card offers "Guide me".
    const page = await dashboard(context, extensionId, '#/service/claude');
    const card = page.getByTestId('optout-card').first();
    await card.getByTestId('run-guided').click();
    const tab = await waitForPageUrl(context, 'https://claude.ai/');
    expect(tab.url()).toMatch(/^https:\/\/claude\.ai\//);
    await expect(card.getByTestId('steps')).toHaveAttribute('open', '');
    await expect(card.getByTestId('steps-mark-done')).toBeVisible();
    await expect(card.getByTestId('run-status')).not.toBeEmpty();
    await card.getByTestId('steps-mark-done').click();
    await expect(card.getByTestId('optout-status')).toContainText('Done');
  });

  test('deep links: ?guide expands steps, ?run shows the permission prompt', async ({
    context,
    extensionId,
  }) => {
    const page = await dashboard(context, extensionId, '#/overview');
    const state = await getState(page);
    const claude = state.registry.services.find((s) => s.id === 'claude');
    const auto = claude.optOuts.find((o) => o.automation);
    await page.goto(
      `chrome-extension://${extensionId}/${DASH}#/service/claude?guide=${claude.optOuts[0].id}`,
    );
    await expect(
      page.locator(`[data-optout="${claude.optOuts[0].id}"] [data-testid="steps"]`),
    ).toHaveAttribute('open', '');
    if (auto) {
      await page.goto(`chrome-extension://${extensionId}/${DASH}#/service/claude?run=${auto.id}&mode=auto`);
      await page.bringToFront(); // the install-time onboarding tab would otherwise hold window focus
      await page.reload();
      await expect(page.getByTestId('run-prompt')).toBeVisible();
      await expect(page.getByTestId('run-prompt-go')).toBeFocused();
      await page.getByRole('button', { name: 'Not now' }).click();
      await expect(page.getByTestId('run-prompt')).toHaveCount(0);
    }
  });

  test('unknown service shows a friendly not-found state', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/service/does-not-exist', { seed: false });
    await expect(page.getByText('Service not found')).toBeVisible();
  });
});

test.describe('letters', () => {
  test('generates, edits, copies and records a letter', async ({ context, extensionId }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await dashboard(context, extensionId, '#/letters?service=claude');
    const body = page.getByTestId('letter-body');
    await expect(body).toHaveValue(/Claude|Anthropic/);
    await expect(body).toHaveValue(/Alex Morgan/);
    await expect(page.getByTestId('letter-subject')).not.toHaveValue('');
    await expect(page.getByTestId('not-legal-advice')).toBeVisible();

    // Changing the kind rewrites the letter.
    const before = await body.inputValue();
    const kinds = page.locator('input[name="letter-kind"]');
    await kinds.nth(1).check();
    await expect(body).not.toHaveValue(before);

    // The user can edit it and the mail link follows.
    await body.fill('Hello Anthropic, please stop training on my data. Alex');
    const mailto = page.getByTestId('letter-mailto');
    if (await mailto.count()) await expect(mailto).toHaveAttribute('href', /^mailto:.*Hello%20Anthropic/);

    await page.getByTestId('letter-copy').click();
    await expect(page.getByTestId('toast').last()).toContainText('copied');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('Hello Anthropic');

    // Profile changes are saved to settings.
    await page.getByTestId('letter-name').fill('Sam Lee');
    await page.getByTestId('letter-name').blur();
    await expect.poll(async () => (await getState(page)).settings.profile.fullName).toBe('Sam Lee');

    const sent = page.getByTestId('letter-sent');
    await sent.click();
    await expect
      .poll(async () => {
        const st = await getState(page);
        return Object.values(st.userState.services.claude?.optOuts ?? {}).some((o) => o.status === 'sent');
      })
      .toBe(true);
  });

  test('download produces a text file', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/letters?service=chatgpt');
    const download = page.waitForEvent('download');
    await page.getByTestId('letter-download').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^notrain-letter-chatgpt-.*\.txt$/);
    const text = await readFile(await file.path(), 'utf8');
    expect(text).toMatch(/^Subject: /);
  });
});

test.describe('creators', () => {
  test('presets, custom selection and output tabs', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/creators', { seed: false });
    const output = page.getByTestId('creator-output');
    await expect(output).toHaveValue(/User-agent: GPTBot/);
    await expect(output).toHaveValue(/Disallow: \//);
    const training = await output.inputValue();

    await page.getByTestId('preset-all-ai').check();
    await expect(output).not.toHaveValue(training);
    await expect(page.getByTestId('keep-search')).toBeVisible();

    await page.getByTestId('preset-custom').check();
    const checks = page.getByTestId('crawler-check');
    await expect(checks.first()).toBeVisible();
    // Unticking every crawler leaves nothing to block.
    for (const box of await checks.all()) if (await box.isChecked()) await box.uncheck();
    await expect(output).toHaveValue(/nothing to block/);

    // Tabs: keyboard arrows move between outputs.
    await page.getByTestId('output-tab-robots').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('output-tab-ai')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('output-tab-ai')).toBeFocused();
    await page.getByTestId('output-tab-tdm').click();
    await expect(output).toHaveValue(/tdm-reservation/);

    const download = page.waitForEvent('download');
    await page.getByTestId('creator-download').click();
    expect((await download).suggestedFilename()).toBe('tdmrep.json');
  });
});

test.describe('alerts', () => {
  test('read, filter, dismiss and mark all read', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/alerts');
    const items = page.getByTestId('alert-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(2);

    await page.getByTestId('alerts-filter-unread').click();
    await expect(items).toHaveCount(1);
    await items.first().getByTestId('alert-read').click();
    await expect(page.getByText('No alerts match this filter.')).toBeVisible();
    await page.getByRole('button', { name: 'Show all' }).click();

    await items.first().getByTestId('alert-dismiss').click();
    await expect(items).toHaveCount(count - 1);
    const st = await getState(page);
    expect(st.alerts.filter((a) => a.dismissed).length).toBeGreaterThanOrEqual(1);

    await expect(page.getByTestId('alerts-read-all')).toBeDisabled();
  });

  test('empty state when there are no alerts', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/alerts', { seed: false });
    await expect(page.getByTestId('alerts-empty')).toBeVisible();
  });
});

test.describe('settings', () => {
  test('settings persist across reloads', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/settings');
    await page.getByTestId('settings-region').selectOption('EU');
    await expect.poll(async () => (await getState(page)).settings.region).toBe('EU');

    await page.getByTestId('notify-reminders').uncheck();
    await expect.poll(async () => (await getState(page)).settings.notifications.reminders).toBe(false);

    await page.getByTestId('settings-reminder').selectOption('30');
    await expect.poll(async () => (await getState(page)).settings.reminderIntervalDays).toBe(30);

    await page.getByTestId('settings-name').fill('Jordan Doe');
    await page.getByTestId('settings-name').press('Tab');
    await expect.poll(async () => (await getState(page)).settings.profile.fullName).toBe('Jordan Doe');

    await page.reload();
    await expect(page.getByTestId('settings-region')).toHaveValue('EU');
    await expect(page.getByTestId('notify-reminders')).not.toBeChecked();
    await expect(page.getByTestId('settings-name')).toHaveValue('Jordan Doe');
    await expect(page.getByTestId('sync-status')).toBeVisible();
    await expect(page.getByTestId('perm-empty')).toBeVisible();
  });

  test('export then import restores data', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/settings');
    const download = page.waitForEvent('download');
    await page.getByTestId('export-button').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^notrain-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const backupPath = await file.path();
    const backup = JSON.parse(await readFile(backupPath, 'utf8'));
    expect(backup.app).toBe('NoTrain');

    await send(page, { type: 'trackServices', serviceIds: ['chatgpt'], tracked: false, source: 'manual' });
    await expect.poll(async () => (await getState(page)).userState.services.chatgpt?.tracked).toBe(false);

    await page.getByTestId('import-input').setInputFiles(backupPath);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Import backup' }).click();
    await expect.poll(async () => (await getState(page)).userState.services.chatgpt?.tracked).toBe(true);
  });

  test('reset asks for confirmation and starts over', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/settings');
    await page.getByTestId('reset-button').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Reset NoTrain?');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await getState(page)).settings.onboarded).toBe(true);

    await page.getByTestId('reset-button').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Erase everything' }).click();
    await expect(page).toHaveURL(/#\/welcome$/);
    const st = await getState(page);
    expect(st.settings.onboarded).toBe(false);
    expect(Object.values(st.userState.services).some((s) => s.tracked)).toBe(false);
  });
});

test.describe('keyboard and accessibility', () => {
  test('skip link, focus on navigation and visible focus rings', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/overview');
    // A fresh load (not an in-app navigation, which focuses the heading) starts at the skip link.
    await page.reload();
    await expect(page.locator('[data-page-title]').first()).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-page-title]')).toBeFocused();

    // Navigating moves focus to the new page's heading.
    await page.getByTestId('nav-services').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/services$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Services' })).toBeFocused();
    await expect(page.getByTestId('nav-services')).toHaveAttribute('aria-current', 'page');

    // Every focusable control shows a visible focus indicator.
    await page.getByTestId('services-search').focus();
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'none';
        const cs = getComputedStyle(el);
        const track = el.matches('.nt-switch__input') ? getComputedStyle(el.nextElementSibling) : null;
        const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
        const trackShadow = track && track.boxShadow !== 'none';
        return hasOutline || hasShadow || trackShadow ? 'ok' : `${el.tagName}.${el.className}`;
      });
      expect(ring).toBe('ok');
    }
  });

  test('every route renders without console errors and passes the a11y smoke check', async ({
    context,
    extensionId,
  }) => {
    const page = await dashboard(context, extensionId, '#/overview');
    const errors = watchErrors(page);
    for (const route of ROUTES) {
      await page.goto(`chrome-extension://${extensionId}/${DASH}#/${route}`);
      await page.reload();
      await expect(page.locator('[data-page-title]').first()).toBeVisible();
      await page.waitForTimeout(150);
      const problems = await a11yProblems(page, { expectNav: route !== 'welcome' });
      expect(problems, `a11y problems on #/${route}`).toEqual([]);
    }
    expect(errors).toEqual([]);
  });

  test('narrow window switches to the top navigation', async ({ context, extensionId }) => {
    const page = await dashboard(context, extensionId, '#/overview');
    await page.setViewportSize({ width: 800, height: 800 });
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav).toBeVisible();
    const box = await nav.boundingBox();
    expect(box.y).toBeLessThan(80);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
