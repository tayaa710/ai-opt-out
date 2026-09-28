// On-page panel (extension/content/overlay.js) injected with the engine into
// fixture pages, with chrome.runtime.sendMessage stubbed to record messages.
import { test, expect } from '@playwright/test';
import { OVERLAY_PATH, openFixture, stubRuntime } from './helpers/content.mjs';

const SETTING = 'Improve the model for everyone';

function config(overrides = {}) {
  const automation = {
    confidence: 'medium',
    hostPermissions: ['https://fixtures.notrain.test/*'],
    loginIndicators: [{ role: 'button', text: ['Log in', 'Sign up for free'] }],
    steps: [
      {
        action: 'waitFor',
        target: { text: [SETTING] },
        timeoutMs: 5000,
        description: 'Waiting for Data controls to load',
      },
      {
        action: 'setToggle',
        target: { role: 'switch', text: [SETTING] },
        state: 'off',
        description: `Turning off “${SETTING}”`,
      },
    ],
    verify: [
      { action: 'waitFor', target: { text: [SETTING] }, timeoutMs: 5000 },
      { action: 'assertToggle', target: { role: 'switch', text: [SETTING] }, state: 'off' },
    ],
    ...(overrides.automation || {}),
  };
  return {
    runId: 'run-123',
    mode: 'auto',
    service: { id: 'example-ai', name: 'Example AI', company: 'Example Inc.' },
    ...overrides,
    optOut: {
      id: 'improve-model',
      title: `Turn off “${SETTING}”`,
      steps: ['Open Example AI and sign in.', 'Open Settings → Data controls.', `Turn off “${SETTING}”.`],
      effect: 'Stops new conversations from being used to train models. Past conversations are not removed.',
      automation,
      ...(overrides.optOut || {}),
    },
  };
}

async function start(page, fixture, cfg, { query = '' } = {}) {
  await openFixture(page, `patterns/${fixture}.html`, { query });
  await page.addScriptTag({ path: OVERLAY_PATH });
  return page.evaluate((c) => {
    const r = NoTrainOverlay.start(c);
    return {
      isPromise: !!r && typeof r.then === 'function',
      value: r && typeof r.then !== 'function' ? r : null,
    };
  }, cfg);
}

const view = (page) =>
  page.evaluate(() => NoTrainOverlay._shadow()?.querySelector('.panel')?.dataset.view ?? null);
const panelText = (page) =>
  page.evaluate(
    () => NoTrainOverlay._shadow()?.querySelector('.panel')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
  );
const sent = (page) => page.evaluate(() => window.__sent);
const results = async (page) => (await sent(page)).filter((m) => m.type === 'runResult');

async function waitView(page, name, timeout = 15000) {
  await expect.poll(() => view(page), { timeout }).toBe(name);
}

/** Clicks an overlay button (by text or aria-label) with the real mouse. */
async function clickButton(page, label) {
  const box = await page.evaluate((label) => {
    const root = NoTrainOverlay._shadow();
    // Match on the accessible name (what a screen reader announces).
    const btn = [...root.querySelectorAll('button')].find((b) => NoTrainEngine.accessibleName(b) === label);
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, label);
  if (!box) throw new Error(`No overlay button “${label}”`);
  await page.mouse.click(box.x, box.y);
}

async function focusedLabel(page) {
  return page.evaluate(() => {
    const el = NoTrainOverlay._shadow().activeElement;
    return el ? NoTrainEngine.accessibleName(el) : null;
  });
}

test.beforeEach(async ({ page }) => {
  await stubRuntime(page);
});

test.describe('auto mode', () => {
  test('runs the recipe with live progress, reports, and shows an honest success state', async ({ page }) => {
    const ret = await start(page, 'radix-switch', config());
    expect(ret).toEqual({ isPromise: false, value: { started: true, runId: 'run-123', mode: 'auto' } });
    const host = await page.evaluate(() => {
      const h = document.querySelector('notrain-overlay');
      return {
        count: document.querySelectorAll('notrain-overlay').length,
        closed: h.shadowRoot === null,
        parent: h.parentNode === document.documentElement,
      };
    });
    expect(host).toEqual({ count: 1, closed: true, parent: true });
    expect(await panelText(page)).toContain(`NoTrain is turning off “${SETTING}” for you`);

    await waitView(page, 'done');
    const text = await panelText(page);
    expect(text).toContain(`“${SETTING}” is now off`);
    expect(text).toContain('What this does');
    expect(text).toContain('Past conversations are not removed.');
    expect(await page.evaluate(() => document.getElementById('improve').getAttribute('aria-checked'))).toBe(
      'false',
    );

    const msgs = await sent(page);
    expect(msgs.filter((m) => m.type === 'runProgress')).toEqual([
      {
        type: 'runProgress',
        runId: 'run-123',
        stepIndex: 0,
        total: 2,
        description: 'Waiting for Data controls to load',
      },
      {
        type: 'runProgress',
        runId: 'run-123',
        stepIndex: 1,
        total: 2,
        description: `Turning off “${SETTING}”`,
      },
    ]);
    expect(await results(page)).toEqual([
      {
        type: 'runResult',
        runId: 'run-123',
        serviceId: 'example-ai',
        optOutId: 'improve-model',
        mode: 'auto',
        outcome: 'success',
        message: `“${SETTING}” is now off.`,
      },
    ]);
    // The success view focuses its primary action and announces the result.
    expect(await focusedLabel(page)).toBe('Close');
    await expect
      .poll(() => page.evaluate(() => NoTrainOverlay._shadow().querySelector('[aria-live]').textContent))
      .toContain('is now off');
    // No highlight is left on the page.
    expect(await page.locator('notrain-highlight').count()).toBe(0);

    await clickButton(page, 'Close');
    expect(await page.locator('notrain-overlay').count()).toBe(0);
    expect(await page.evaluate(() => NoTrainOverlay.isActive())).toBe(false);
  });

  test('already off → success state without touching the page', async ({ page }) => {
    await start(page, 'already-off', config());
    await waitView(page, 'done');
    expect(await panelText(page)).toContain(`“${SETTING}” was already off`);
    expect(await page.evaluate(() => window.clicks)).toBe(0);
    expect((await results(page)).map((m) => m.outcome)).toEqual(['already']);
  });

  test('needs_login → "Sign in first" with Try again, which re-runs', async ({ page }) => {
    await start(page, 'logged-out', config());
    await waitView(page, 'login');
    expect(await panelText(page)).toContain('Sign in to Example AI first');
    expect(await panelText(page)).toContain('Try again');
    expect(await focusedLabel(page)).toBe('Try again');
    await page.evaluate(() => window.logIn());
    await clickButton(page, 'Try again');
    await waitView(page, 'done');
    expect((await results(page)).map((m) => m.outcome)).toEqual(['needs_login', 'success']);
  });

  test('not_found → explains and switches to guided mode; "I’ve done it" reports guidedDone', async ({
    page,
  }) => {
    const cfg = config({
      automation: {
        steps: [{ action: 'waitFor', target: { text: ['A label this page does not have'] }, timeoutMs: 400 }],
      },
    });
    await start(page, 'radix-switch', cfg);
    await waitView(page, 'guided');
    const text = await panelText(page);
    expect(text).toContain('NoTrain couldn’t finish this automatically');
    expect(text).toContain('A label this page does not have');
    expect(text).toContain('Open Settings → Data controls.');
    expect((await results(page)).map((m) => m.outcome)).toEqual(['not_found']);
    await clickButton(page, 'I’ve done it');
    await waitView(page, 'done');
    expect((await sent(page)).filter((m) => m.type === 'guidedDone')).toEqual([
      { type: 'guidedDone', runId: 'run-123', serviceId: 'example-ai', optOutId: 'improve-model' },
    ]);
    expect(await panelText(page)).toContain('Marked as done');
  });

  test('failed (toggle refuses) → guided mode', async ({ page }) => {
    const cfg = config({
      automation: {
        steps: [
          {
            action: 'setToggle',
            target: { role: 'switch', text: ['Ignores clicks'] },
            state: 'off',
            timeoutMs: 300,
          },
        ],
      },
    });
    await start(page, 'stubborn', cfg);
    await waitView(page, 'guided');
    expect((await results(page)).map((m) => m.outcome)).toEqual(['failed']);
  });

  test('Stop cancels the run and reports cancelled', async ({ page }) => {
    const cfg = config({
      automation: {
        steps: [
          { action: 'waitFor', target: { text: ['Use conversations for training'] }, timeoutMs: 30000 },
        ],
      },
    });
    await start(page, 'delayed', cfg, { query: 'delay=60000&cssDelay=60000' });
    await waitView(page, 'running');
    await clickButton(page, 'Stop');
    await waitView(page, 'stopped');
    expect(await panelText(page)).toContain('Stopped');
    expect((await results(page)).map((m) => m.outcome)).toEqual(['cancelled']);
    await clickButton(page, 'Show me the steps');
    await waitView(page, 'guided');
  });

  test('closing mid-run cancels it and removes the panel', async ({ page }) => {
    const cfg = config({
      automation: {
        steps: [
          { action: 'waitFor', target: { text: ['Use conversations for training'] }, timeoutMs: 30000 },
        ],
      },
    });
    await start(page, 'delayed', cfg, { query: 'delay=60000&cssDelay=60000' });
    await waitView(page, 'running');
    await clickButton(page, 'Close NoTrain panel');
    expect(await page.locator('notrain-overlay').count()).toBe(0);
    await expect.poll(async () => (await results(page)).map((m) => m.outcome)).toEqual(['cancelled']);
  });

  test('experimental recipes are labelled', async ({ page }) => {
    const cfg = config({
      automation: {
        confidence: 'experimental',
        steps: [{ action: 'waitFor', target: { text: ['Never here'] }, timeoutMs: 3000 }],
      },
    });
    await start(page, 'radix-switch', cfg);
    await waitView(page, 'running');
    expect(await panelText(page)).toContain('Experimental');
    expect(await panelText(page)).toContain('Nothing leaves your device');
  });

  test('starting again replaces the panel and stops the previous run', async ({ page }) => {
    const slow = config({
      automation: { steps: [{ action: 'waitFor', target: { text: ['Never here'] }, timeoutMs: 30000 }] },
    });
    await start(page, 'radix-switch', slow);
    await waitView(page, 'running');
    await page.evaluate((c) => NoTrainOverlay.start(c), config({ runId: 'run-2' }));
    await waitView(page, 'done');
    expect(await page.locator('notrain-overlay').count()).toBe(1);
    const res = await results(page);
    expect(res.map((m) => [m.runId, m.outcome])).toEqual([
      ['run-123', 'cancelled'],
      ['run-2', 'success'],
    ]);
  });

  test('automation without an engine or recipe falls back to guided mode', async ({ page }) => {
    await start(page, 'radix-switch', config({ optOut: { automation: null } }));
    await waitView(page, 'guided');
    expect(await panelText(page)).toContain('can’t do this one automatically');
    expect(await results(page)).toEqual([]);
  });
});

test.describe('verify mode', () => {
  test('still off → success', async ({ page }) => {
    await start(page, 'already-off', config({ mode: 'verify' }));
    await waitView(page, 'done');
    expect(await panelText(page)).toContain(`“${SETTING}” is still off`);
    expect(await results(page)).toEqual([expect.objectContaining({ mode: 'verify', outcome: 'success' })]);
    expect(await page.evaluate(() => window.clicks)).toBe(0);
  });

  test('switched back on → mismatch, without changing anything; "Turn it off again" fixes it', async ({
    page,
  }) => {
    await start(page, 'radix-switch', config({ mode: 'verify' }));
    await waitView(page, 'mismatch');
    expect(await panelText(page)).toContain(`“${SETTING}” has been switched back on`);
    expect(await page.evaluate(() => window.fixtureLog)).toEqual([]);
    expect((await results(page)).map((m) => [m.mode, m.outcome])).toEqual([['verify', 'mismatch']]);
    await clickButton(page, 'Turn it off again');
    await waitView(page, 'done');
    expect(await page.evaluate(() => window.fixtureLog)).toEqual(['improve:off']);
    // Reported against the run's own mode (the background checks it).
    expect((await results(page)).map((m) => [m.mode, m.outcome])).toEqual([
      ['verify', 'mismatch'],
      ['verify', 'success'],
    ]);
  });

  test('without verify steps, the setToggle steps are checked read-only', async ({ page }) => {
    await start(page, 'radix-switch', config({ mode: 'verify', automation: { verify: [] } }));
    await waitView(page, 'mismatch');
    expect(await page.evaluate(() => window.fixtureLog)).toEqual([]);
  });
});

test.describe('guided mode', () => {
  test('numbered steps, the current control is highlighted, completion is noticed, guidedDone is sent', async ({
    page,
  }) => {
    await start(page, 'radix-switch', config({ mode: 'guided' }));
    await waitView(page, 'guided');
    const text = await panelText(page);
    expect(text).toContain('Step by step');
    expect(text).toMatch(/1\s*Step 1: Open Example AI and sign in\./);
    // The step that mentions the switch is current and its control is ringed.
    await expect
      .poll(() =>
        page.evaluate(() => NoTrainOverlay._shadow().querySelector('[aria-current="step"]')?.textContent),
      )
      .toContain(`Turn off “${SETTING}”`);
    await expect.poll(() => page.locator('notrain-highlight').count()).toBe(1);
    expect(await results(page)).toEqual([]);

    // Picking another step by hand moves "current"; that step has no control to point at.
    await clickButton(page, 'Step 1: Open Example AI and sign in.');
    expect(
      await page.evaluate(() => NoTrainOverlay._shadow().querySelector('[aria-current="step"]').textContent),
    ).toContain('Open Example AI');
    await expect.poll(() => page.locator('notrain-highlight').count()).toBe(0);

    // The person switches it off themselves.
    await page.click('#improve');
    await expect.poll(() => panelText(page)).toContain(`Looks like “${SETTING}” is off now.`);
    await expect.poll(() => page.locator('notrain-highlight').count()).toBe(0);
    await clickButton(page, 'I’ve done it');
    await waitView(page, 'done');
    expect((await sent(page)).map((m) => m.type)).toEqual(['guidedDone']);
    expect(await page.locator('notrain-highlight').count()).toBe(0);
  });

  test('guided mode follows the page through a Manage sub-panel', async ({ page }) => {
    const cfg = config({
      mode: 'guided',
      optOut: {
        title: 'Stop AI training on your content',
        steps: [
          'Open Privacy.',
          'Next to “AI training data”, choose Manage.',
          'Turn off “Use my content to train AI”.',
        ],
        automation: {
          confidence: 'medium',
          steps: [
            { action: 'click', target: { role: 'button', text: ['AI training data'] } },
            {
              action: 'setToggle',
              target: { role: 'switch', text: ['Use my content to train AI'] },
              state: 'off',
            },
          ],
        },
      },
    });
    await start(page, 'manage-subpanel', cfg);
    const current = () =>
      page.evaluate(() => NoTrainOverlay._shadow().querySelector('[aria-current="step"]')?.textContent);
    await expect.poll(current).toContain('choose Manage');
    await page.locator('#overview .row', { hasText: 'AI training data' }).getByRole('button').click();
    await expect.poll(current).toContain('Use my content to train AI');
    const ringed = await page.evaluate(() => {
      const sw = document.getElementById('use').getBoundingClientRect();
      return { x: sw.left, y: sw.top };
    });
    expect(ringed.x).toBeGreaterThan(0);
    await expect.poll(() => page.locator('notrain-highlight').count()).toBe(1);
  });

  test('works with no automation at all', async ({ page }) => {
    await start(page, 'radix-switch', config({ mode: 'guided', optOut: { automation: null } }));
    await waitView(page, 'guided');
    expect(await panelText(page)).toContain('Follow these steps on this page.');
    expect(await page.locator('notrain-highlight').count()).toBe(0);
  });
});

test.describe('accessibility and isolation', () => {
  test('keyboard: Tab moves through controls, Enter activates, Escape closes; keys never reach the page', async ({
    page,
  }) => {
    await start(page, 'radix-switch', config({ mode: 'guided' }));
    await waitView(page, 'guided');
    await page.evaluate(() => {
      window.pageKeys = [];
      document.addEventListener('keydown', (e) => window.pageKeys.push(e.key), true);
      window.addEventListener('keydown', (e) => window.pageKeys.push(`w:${e.key}`));
    });
    expect(await focusedLabel(page)).toBe('I’ve done it');
    await page.keyboard.press('Tab');
    expect(await focusedLabel(page)).toBe('Close');
    await page.keyboard.press('Shift+Tab');
    expect(await focusedLabel(page)).toBe('I’ve done it');
    // Minimise with the keyboard.
    await page.evaluate(() => NoTrainOverlay._shadow().querySelector('[aria-controls="nt-body"]').focus());
    await page.keyboard.press('Enter');
    const collapsed = await page.evaluate(() => {
      const root = NoTrainOverlay._shadow();
      const btn = root.querySelector('[aria-controls="nt-body"]');
      return {
        expanded: btn.getAttribute('aria-expanded'),
        bodyHidden: getComputedStyle(root.querySelector('.body')).display === 'none',
        label: btn.getAttribute('aria-label'),
      };
    });
    expect(collapsed).toEqual({ expanded: 'false', bodyHidden: true, label: 'Expand NoTrain panel' });
    await page.keyboard.press('Space');
    expect(
      await page.evaluate(() =>
        NoTrainOverlay._shadow().querySelector('[aria-controls="nt-body"]').getAttribute('aria-expanded'),
      ),
    ).toBe('true');
    await page.keyboard.press('Escape');
    expect(await page.locator('notrain-overlay').count()).toBe(0);
    expect(await page.evaluate(() => window.pageKeys)).toEqual([]);
  });

  test('landmarks and labels: dialog role, heading, live region, labelled icon buttons, visible focus', async ({
    page,
  }) => {
    await start(page, 'radix-switch', config({ mode: 'guided' }));
    await waitView(page, 'guided');
    const a11y = await page.evaluate(() => {
      const root = NoTrainOverlay._shadow();
      const panel = root.querySelector('.panel');
      const title = root.getElementById(panel.getAttribute('aria-labelledby'));
      const icons = [...root.querySelectorAll('.icon-btn')].map((b) => b.getAttribute('aria-label'));
      const done = [...root.querySelectorAll('button')].find((b) => b.textContent.includes('done it'));
      done.focus();
      const outline = getComputedStyle(done).outlineStyle;
      return {
        role: panel.getAttribute('role'),
        modal: panel.getAttribute('aria-modal'),
        title: title && title.tagName,
        live: root.querySelector('[aria-live="polite"]')?.getAttribute('role'),
        icons,
        outline,
      };
    });
    expect(a11y).toEqual({
      role: 'dialog',
      modal: 'false',
      title: 'H2',
      live: 'status',
      icons: ['Minimise NoTrain panel', 'Close NoTrain panel'],
      outline: expect.stringMatching(/solid|auto/),
    });
  });

  test('page CSS cannot restyle or hide the panel, and the panel adds no styles to the page', async ({
    page,
  }) => {
    await openFixture(page, 'patterns/radix-switch.html');
    await page.addStyleTag({
      content: `
        * { color: red !important; font-size: 40px !important; font-family: serif !important; }
        button { background: lime !important; display: none !important; }
        div { display: none !important; }
        notrain-overlay, [data-notrain-ui] { display: none !important; opacity: 0 !important; transform: scale(0) !important; }
        html > * { visibility: hidden !important; }`,
    });
    const pageBefore = await page.evaluate(() => ({
      sheets: document.styleSheets.length,
      body: getComputedStyle(document.body).cssText || getComputedStyle(document.body).font,
      html: document.documentElement.getAttribute('style'),
    }));
    await page.addScriptTag({ path: OVERLAY_PATH });
    await page.evaluate((c) => NoTrainOverlay.start(c), config({ mode: 'guided' }));
    await waitView(page, 'guided');
    const styles = await page.evaluate(() => {
      const host = document.querySelector('notrain-overlay');
      const root = NoTrainOverlay._shadow();
      const hs = getComputedStyle(host);
      const btn = [...root.querySelectorAll('.btn-primary')][0];
      const title = root.querySelector('.title');
      const r = host.getBoundingClientRect();
      return {
        display: hs.display,
        opacity: hs.opacity,
        visibility: hs.visibility,
        position: hs.position,
        zIndex: hs.zIndex,
        onScreen: r.width > 200 && r.height > 100 && r.right <= innerWidth && r.bottom <= innerHeight,
        btnBg: getComputedStyle(btn).backgroundColor,
        btnDisplay: getComputedStyle(btn).display,
        titleSize: getComputedStyle(title).fontSize,
        titleColor: getComputedStyle(title).color,
        font: getComputedStyle(title).fontFamily,
      };
    });
    expect(styles).toMatchObject({
      display: 'block',
      opacity: '1',
      visibility: 'visible',
      position: 'fixed',
      zIndex: '2147483647',
      onScreen: true,
      btnBg: 'rgb(79, 70, 229)',
      btnDisplay: 'flex', // inline-flex, blockified inside the flex action row
      titleSize: '16px',
      titleColor: 'rgb(15, 23, 42)',
    });
    expect(styles.font).toContain('system-ui');
    const pageAfter = await page.evaluate(() => ({
      sheets: document.styleSheets.length,
      body: getComputedStyle(document.body).cssText || getComputedStyle(document.body).font,
      html: document.documentElement.getAttribute('style'),
    }));
    expect(pageAfter).toEqual(pageBefore);
  });

  test('clicks and focus inside the panel do not reach the page (open site dialogs stay open)', async ({
    page,
  }) => {
    await start(page, 'radix-switch', config({ mode: 'guided' }));
    await waitView(page, 'guided');
    await page.evaluate(() => {
      window.pageEvents = [];
      for (const t of ['pointerdown', 'mousedown', 'click', 'focusin']) {
        document.addEventListener(t, (e) => window.pageEvents.push(`${t}:${e.target.localName}`));
      }
    });
    await clickButton(page, 'Minimise NoTrain panel');
    await clickButton(page, 'Expand NoTrain panel');
    expect(await page.evaluate(() => window.pageEvents)).toEqual([]);
  });

  test('dark mode uses the dark tokens; reduced motion disables animation', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await start(page, 'radix-switch', config({ mode: 'guided' }));
    await waitView(page, 'guided');
    const s = await page.evaluate(() => {
      const root = NoTrainOverlay._shadow();
      const panel = root.querySelector('.panel');
      return {
        bg: getComputedStyle(panel).backgroundColor,
        primary: getComputedStyle(root.querySelector('.btn-primary')).backgroundColor,
        animation: getComputedStyle(panel).animationName,
      };
    });
    expect(s).toEqual({ bg: 'rgb(21, 24, 34)', primary: 'rgb(129, 140, 248)', animation: 'none' });
  });

  test('the header drags the panel and it stays on screen', async ({ page }) => {
    await start(page, 'radix-switch', config({ mode: 'guided' }));
    await waitView(page, 'guided');
    const bar = await page.evaluate(() => {
      const r = NoTrainOverlay._shadow().querySelector('.wordmark').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(bar.x, bar.y);
    await page.mouse.down();
    await page.mouse.move(bar.x - 300, bar.y - 200, { steps: 5 });
    await page.mouse.up();
    const moved = await page.evaluate(() =>
      document.querySelector('notrain-overlay').getBoundingClientRect().toJSON(),
    );
    expect(Math.round(moved.left)).toBeLessThan(page.viewportSize().width - 400);
    await page.mouse.move(moved.left + 60, moved.top + 20);
    await page.mouse.down();
    await page.mouse.move(-500, -500, { steps: 5 });
    await page.mouse.up();
    const clamped = await page.evaluate(() =>
      document.querySelector('notrain-overlay').getBoundingClientRect().toJSON(),
    );
    expect(clamped.left).toBeGreaterThanOrEqual(0);
    expect(clamped.top).toBeGreaterThanOrEqual(0);
  });

  test('re-injecting the overlay keeps the existing instance', async ({ page }) => {
    await start(page, 'radix-switch', config({ mode: 'guided' }));
    await page.evaluate(() => (window.__o = NoTrainOverlay));
    await page.addScriptTag({ path: OVERLAY_PATH });
    expect(await page.evaluate(() => window.__o === NoTrainOverlay && NoTrainOverlay.isActive())).toBe(true);
    expect(await page.locator('notrain-overlay').count()).toBe(1);
  });

  test('rejects a missing config', async ({ page }) => {
    await openFixture(page, 'patterns/radix-switch.html');
    await page.addScriptTag({ path: OVERLAY_PATH });
    const err = await page.evaluate(() => {
      try {
        NoTrainOverlay.start();
        return null;
      } catch (e) {
        return e.name;
      }
    });
    expect(err).toBe('TypeError');
    expect(await page.locator('notrain-overlay').count()).toBe(0);
  });
});
