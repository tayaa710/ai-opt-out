// In-page automation engine (extension/content/engine.js) against the
// pattern fixtures in tests/fixtures/patterns/.
import { test, expect } from '@playwright/test';
import { ENGINE_PATH, openFixture, runSteps } from './helpers/content.mjs';

const P = (name) => `patterns/${name}.html`;

/** ids (or data-decoy / tag names) of findAll() results */
async function ids(page, target) {
  return page.evaluate(
    (target) => NoTrainEngine.findAll(target).map((el) => el.id || el.dataset.decoy || el.localName),
    target,
  );
}

async function state(page, id) {
  return page.evaluate((id) => NoTrainEngine.readToggleState(document.getElementById(id)), id);
}

test.describe('injection', () => {
  test('defines the API once and survives re-injection', async ({ page }) => {
    await openFixture(page, P('radix-switch'));
    const api = await page.evaluate(() => ({
      version: NoTrainEngine.VERSION,
      frozen: Object.isFrozen(NoTrainEngine),
      fns: [
        'findTarget',
        'findAll',
        'readToggleState',
        'checkLogin',
        'runSteps',
        'highlight',
        'clearHighlight',
      ].every((k) => typeof NoTrainEngine[k] === 'function'),
    }));
    expect(api.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(api.frozen).toBe(true);
    expect(api.fns).toBe(true);

    await page.evaluate(() => {
      window.__first = NoTrainEngine;
      NoTrainEngine.highlight(document.getElementById('improve'));
    });
    await page.addScriptTag({ path: ENGINE_PATH });
    await page.addScriptTag({ path: ENGINE_PATH });
    const after = await page.evaluate(() => ({
      same: window.__first === NoTrainEngine,
      highlights: document.querySelectorAll('notrain-highlight').length,
    }));
    expect(after).toEqual({ same: true, highlights: 1 });
    const r = await runSteps(page, [
      {
        action: 'setToggle',
        target: { role: 'switch', text: ['Improve the model for everyone'] },
        state: 'off',
      },
    ]);
    expect(r.outcome).toBe('success');
  });

  test('read-only APIs do not modify the page', async ({ page }) => {
    await openFixture(page, P('radix-switch'));
    const before = await page.evaluate(() => document.documentElement.outerHTML);
    await page.evaluate(async () => {
      NoTrainEngine.findAll({ role: 'switch' });
      NoTrainEngine.findTarget({ text: ['Improve the model'] });
      NoTrainEngine.readToggleState(document.getElementById('improve'));
      NoTrainEngine.checkLogin([{ role: 'button', text: ['Log in'] }]);
      await NoTrainEngine.waitForTarget({ text: ['nothing like this'] }, { timeoutMs: 300 });
      await NoTrainEngine.runSteps(
        [{ action: 'assertToggle', target: { role: 'switch', text: ['Improve the model'] }, state: 'on' }],
        { mode: 'verify' },
      );
    });
    expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
    expect(await page.evaluate(() => window.fixtureLog)).toEqual([]);
  });
});

test.describe('target resolution', () => {
  test('roles: explicit roles win over native ones, lenient fallback only when nothing strict matches', async ({
    page,
  }) => {
    await openFixture(page, P('ranking'));
    // <button role=switch> is a switch, never a button.
    expect(await ids(page, { role: 'button', text: ['Notifications'] })).toEqual(['role-button']);
    expect(await ids(page, { role: 'switch', text: ['Notifications'] })).toEqual(['role-switch']);
    expect(await ids(page, { role: 'link', text: ['Privacy center'] })).toEqual(['role-link']);
    expect(await ids(page, { role: 'tab', text: ['Data controls'] })).toEqual(['role-tab']);
    // Lenient: a "button" that is really a tab / menu item / link.
    expect(await ids(page, { role: 'button', text: ['Data controls'] })).toEqual(['role-tab']);
    expect(await ids(page, { role: 'button', text: ['Download your data'] })).toEqual(['role-menuitem']);
    expect(await ids(page, { role: 'button', text: ['Privacy center'] })).toEqual(['role-link']);
    // input[type=checkbox][switch] is a switch; checkbox falls back to it.
    expect(await ids(page, { role: 'switch', text: ['Native switch'] })).toEqual(['role-native-switch']);
    expect(await ids(page, { role: 'checkbox', text: ['Native switch'] })).toEqual(['role-native-switch']);
    expect(await ids(page, { role: 'radio', text: ['Do not use my data'] })).toEqual(['role-radio']);
    // A stateless role never falls back to a stateful control.
    expect(await ids(page, { role: 'button', text: ['Native switch'] })).toEqual([]);
    expect(await ids(page, { role: 'dialog' })).toEqual(['dialog-b', 'dialog-a']);
  });

  test('accessible names: aria-labelledby, aria-label, label[for], wrapping label, content, title, alt, value', async ({
    page,
  }) => {
    await openFixture(page, P('ranking'));
    const names = await page.evaluate(() =>
      Object.fromEntries(
        [
          'by',
          'aria',
          'for-box',
          'wrapped-box',
          'content',
          'titled',
          'img-alt',
          'submit-input',
          'role-pressed',
        ].map((id) => [id, NoTrainEngine.accessibleName(document.getElementById(id))]),
      ),
    );
    expect(names).toEqual({
      by: 'Labelled by span',
      aria: 'Close settings',
      'for-box': 'Label for checkbox',
      'wrapped-box': 'Wrapped label text',
      content: 'Plain text button',
      titled: 'Title only',
      'img-alt': 'Image alt name',
      'submit-input': 'Submit value',
      'role-pressed': 'Pressed thing',
    });
    expect(await ids(page, { role: 'button', text: ['labelled by span'] })).toEqual(['by']);
    expect(await ids(page, { role: 'button', text: ['CLOSE   settings'] })).toEqual(['aria']);
    expect(await ids(page, { role: 'checkbox', text: ['Label for checkbox'] })).toEqual(['for-box']);
    expect(await ids(page, { role: 'checkbox', text: ['Wrapped label'] })).toEqual(['wrapped-box']);
    expect(await ids(page, { role: 'button', text: ['Title only'] })).toEqual(['titled']);
    // Typographic quotes in the page match straight quotes in a recipe.
    expect(await ids(page, { role: 'button', text: ['Turn off "Smart quotes"'] })).toEqual(['quotes']);
  });

  test('ranking: exact name beats substring, then shorter text; any candidate string may match', async ({
    page,
  }) => {
    await openFixture(page, P('ranking'));
    const done = await ids(page, { role: 'button', text: ['Done'], within: { selector: '#exact' } });
    expect(done).toEqual(['done', 'done-editing']);
    expect(await ids(page, { role: 'button', text: ['Save'], within: { selector: '#exact' } })).toEqual([
      'save-short',
      'save-long',
    ]);
    expect(
      await ids(page, {
        role: 'button',
        text: ['no such label', 'Plain text'],
        within: { selector: '#names' },
      }),
    ).toEqual(['content']);
  });

  test('row text: nearest ancestor up to 5 levels and 300 chars, never a shared container', async ({
    page,
  }) => {
    await openFixture(page, P('ranking'));
    expect(await ids(page, { role: 'switch', text: ['Short row label'] })).toEqual(['row-short']);
    expect(await ids(page, { role: 'switch', text: ['Four levels row label'] })).toEqual(['row-four']);
    expect(await ids(page, { role: 'switch', text: ['Long row label'] })).toEqual([]);
    expect(await ids(page, { role: 'switch', text: ['Deep row label'] })).toEqual([]);
    // The heading sits in a container holding two switches: attributable to neither.
    expect(await ids(page, { role: 'switch', text: ['Section heading about sharing'] })).toEqual([]);
    expect(await ids(page, { role: 'switch', text: ['Second shared option'] })).toEqual(['shared-b']);
    // Names only (used for login indicators).
    expect(
      await page.evaluate(
        () =>
          NoTrainEngine.findAll({ role: 'switch', text: ['Short row label'] }, document, { rowText: false })
            .length,
      ),
    ).toBe(0);
  });

  test('text-only targets match the smallest visible element containing the text', async ({ page }) => {
    await openFixture(page, P('ranking'));
    const optOut = await ids(page, { text: ['Opt out of AI training'] });
    expect(optOut.slice(0, 2)).toEqual(['exact-span', 'para']);
    expect(optOut.indexOf('para')).toBeLessThan(optOut.indexOf('main'));
    // Split across inline elements.
    expect((await ids(page, { text: ['of AI training here'] }))[0]).toBe('para');
    // Controls named only by aria-label are found too.
    expect((await ids(page, { text: ['Close settings'] }))[0]).toBe('aria');
  });

  test('within scopes the search and can match several containers', async ({ page }) => {
    await openFixture(page, P('ranking'));
    expect(
      await ids(page, {
        role: 'button',
        text: ['Done'],
        within: { role: 'dialog', text: ['Model improvement'] },
      }),
    ).toEqual(['done-b']);
    expect(
      await ids(page, { role: 'button', text: ['Done'], within: { role: 'dialog', text: ['Settings'] } }),
    ).toEqual(['done-a']);
    // A dialog can also be picked by the text it contains.
    expect(
      await ids(page, {
        role: 'button',
        text: ['Done'],
        within: { role: 'dialog', text: ['Improve the model for everyone'] },
      }),
    ).toEqual(['done-b']);
    expect(await ids(page, { role: 'button', text: ['Done'], within: { role: 'dialog' } })).toEqual([
      'done-b',
      'done-a',
    ]);
    expect(await ids(page, { role: 'button', text: ['Done'], within: { selector: '#nope' } })).toEqual([]);
    expect(await ids(page, { selector: 'button', within: { selector: '#dialog-a' } })).toEqual(['done-a']);
  });

  test('selector targets, combined with role and text', async ({ page }) => {
    await openFixture(page, P('data-state'));
    expect(await ids(page, { selector: '.toggle', text: ['Personalised AI'] })).toEqual(['personal']);
    expect(await ids(page, { selector: '.toggle' })).toEqual(['personal', 'replies', 'voice', 'mystery']);
    expect(await ids(page, { selector: '.toggle', role: 'switch' })).toEqual([]);
    const err = await page.evaluate(() => {
      try {
        NoTrainEngine.findAll({ selector: '[[bad' });
        return null;
      } catch (e) {
        return e.code;
      }
    });
    expect(err).toBe('bad_selector');
  });

  test('open shadow roots are searched (nested, slotted labels); closed ones are not', async ({ page }) => {
    await openFixture(page, P('shadow-dom'));
    const found = await page.evaluate(() => {
      const el = NoTrainEngine.findTarget({ role: 'switch', text: ['Train generative AI on my content'] });
      return el && el.getRootNode().host.id;
    });
    expect(found).toBe('train');
    expect(await page.evaluate(() => NoTrainEngine.findAll({ role: 'switch' }).length)).toBe(2);
    expect(
      await page.evaluate(() => NoTrainEngine.findAll({ text: ['Closed training switch'] }).length),
    ).toBe(0);
    const r = await runSteps(page, [
      { action: 'waitFor', target: { text: ['Train generative AI'] } },
      {
        action: 'setToggle',
        target: { role: 'switch', text: ['Train generative AI on my content'] },
        state: 'off',
      },
      { action: 'assertToggle', target: { role: 'switch', text: ['Show AI features'] }, state: 'off' },
    ]);
    expect(r.outcome).toBe('success');
    expect(await page.evaluate(() => window.fixtureLog)).toEqual(['train:off']);
  });

  test('hidden decoys with the same label are never matched or clicked', async ({ page }) => {
    await openFixture(page, P('decoys'));
    expect(await ids(page, { role: 'switch', text: ['Use my data for AI training'] })).toEqual(['real']);
    expect(await ids(page, { role: 'switch' })).toEqual(['real']);
    const visible = await page.evaluate(() =>
      [...document.querySelectorAll('[data-decoy]')]
        .filter((d) => NoTrainEngine.isVisible(d))
        .map((d) => d.dataset.decoy),
    );
    expect(visible).toEqual([]);
    const r = await runSteps(page, [
      {
        action: 'setToggle',
        target: { role: 'switch', text: ['Use my data for AI training'] },
        state: 'off',
      },
    ]);
    expect(r.outcome).toBe('success');
    expect(await page.evaluate(() => window.decoyClicked)).toBeNull();
    expect(await state(page, 'real')).toBe('off');
  });

  test('invalid targets are rejected', async ({ page }) => {
    await openFixture(page, P('ranking'));
    const codes = await page.evaluate(() =>
      [{}, null, { role: 'banana' }, { text: [] }, { text: ['  '] }].map((t) => {
        try {
          NoTrainEngine.findAll(t);
          return 'ok';
        } catch (e) {
          return e.code;
        }
      }),
    );
    expect(codes).toEqual([
      'invalid_target',
      'invalid_target',
      'invalid_target',
      'invalid_target',
      'invalid_target',
    ]);
  });
});

test.describe('toggle state', () => {
  test('aria-checked, aria-pressed, native checked, data-state, unknown', async ({ page }) => {
    await openFixture(page, P('radix-switch'));
    expect(await state(page, 'improve')).toBe('on');
    await openFixture(page, P('aria-pressed'));
    expect(await state(page, 'activity')).toBe('on');
    expect(await state(page, 'topics')).toBe('off');
    await openFixture(page, P('native-checkbox'));
    expect(await state(page, 'train')).toBe('on');
    expect(await state(page, 'news')).toBe('off');
    // Browsers ignore aria-checked on native checkboxes; so does the engine.
    expect(await state(page, 'research')).toBe('on');
    await openFixture(page, P('data-state'));
    expect(await state(page, 'personal')).toBe('on');
    expect(await state(page, 'replies')).toBe('off');
    expect(await state(page, 'voice')).toBe('on');
    expect(await state(page, 'mystery')).toBeNull();
    await openFixture(page, P('stubborn'));
    expect(await state(page, 'unknown')).toBeNull();
    // A label or wrapper resolves to the control inside / behind it.
    await openFixture(page, P('wrapping-label'));
    const viaLabel = await page.evaluate(() =>
      NoTrainEngine.readToggleState(document.querySelector('label.toggle-row')),
    );
    expect(viaLabel).toBe('on');
  });
});

test.describe('actions', () => {
  test('click dispatches a realistic, in-bounds event sequence after scrolling into view', async ({
    page,
  }) => {
    await openFixture(page, P('events'));
    await page.setViewportSize({ width: 800, height: 600 });
    const r = await runSteps(page, [{ action: 'click', target: { role: 'button', text: ['Log events'] } }]);
    expect(r.outcome).toBe('success');
    const events = await page.evaluate(() => window.events);
    expect(events.map((e) => e.type)).toEqual([
      'pointerover',
      'pointerenter',
      'mouseover',
      'mouseenter',
      'pointermove',
      'mousemove',
      'pointerdown',
      'mousedown',
      'focus',
      'pointerup',
      'mouseup',
      'click',
    ]);
    expect(events.filter((e) => e.inside !== null).every((e) => e.inside && e.button === 0)).toBe(true);
    const inView = await page.evaluate(() => {
      const r = document.getElementById('logger').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    });
    expect(inView).toBe(true);
  });

  test('click activates onclick, pointerup-press and pointerdown widgets exactly once', async ({ page }) => {
    await openFixture(page, P('events'));
    const r = await runSteps(page, [
      { action: 'click', target: { role: 'button', text: ['Save choice'] } },
      { action: 'click', target: { role: 'button', text: ['Confirm opt-out'] } },
      { action: 'click', target: { role: 'button', text: ['More options'] } },
    ]);
    expect(r.outcome).toBe('success');
    expect(await page.evaluate(() => window.counts)).toEqual({ clickOnly: 1, press: 1, menu: 1 });
    expect(await page.evaluate(() => ({ submitted: window.submitted, typed: !!window.typed }))).toEqual({
      submitted: 0,
      typed: false,
    });
  });

  test('forms are only submitted by an explicit click on the submit button', async ({ page }) => {
    await openFixture(page, P('native-checkbox'));
    let r = await runSteps(page, [
      {
        action: 'setToggle',
        target: { role: 'checkbox', text: ['Use my data to improve AI models'] },
        state: 'off',
      },
    ]);
    expect(r.outcome).toBe('success');
    expect(await page.evaluate(() => window.submitted)).toBe(false);
    r = await runSteps(page, [{ action: 'click', target: { role: 'button', text: ['Save preferences'] } }]);
    expect(r.outcome).toBe('success');
    expect(await page.evaluate(() => window.submitted)).toBe(true);
  });

  test('click refuses to press a switch or checkbox (only setToggle changes toggles)', async ({ page }) => {
    await openFixture(page, P('radix-switch'));
    const r = await runSteps(page, [
      { action: 'click', target: { text: ['Include your audio recordings'] }, timeoutMs: 300 },
    ]);
    // The only text match is the <span> label; the aria-labelledby switch is toggle-like.
    expect(['success', 'not_found']).toContain(r.outcome);
    expect(await page.evaluate(() => window.fixtureLog)).toEqual([]);
    const r2 = await runSteps(page, [
      { action: 'click', target: { role: 'switch', text: ['Chat history'] }, timeoutMs: 300 },
    ]);
    expect(r2.outcome).toBe('not_found');
    expect(await page.evaluate(() => window.fixtureLog)).toEqual([]);
    await openFixture(page, P('aria-pressed'));
    const r3 = await runSteps(page, [
      { action: 'click', target: { role: 'button', text: ['Use my activity'] }, timeoutMs: 300 },
    ]);
    expect(r3.outcome).toBe('not_found');
    expect(await page.evaluate(() => window.clicks)).toBe(0);
  });

  test('setToggle: Radix switch, native checkbox, wrapping labels, aria-pressed, data-state', async ({
    page,
  }) => {
    await openFixture(page, P('radix-switch'));
    let r = await runSteps(page, [
      {
        action: 'setToggle',
        target: { role: 'switch', text: ['Include your audio recordings'] },
        state: 'off',
      },
      { action: 'setToggle', target: { role: 'switch', text: ['Chat history'] }, state: 'on' },
    ]);
    expect(r.outcome).toBe('success');
    expect(await page.evaluate(() => window.fixtureLog)).toEqual(['audio-label:off', 'history:on']);
    expect(await state(page, 'improve')).toBe('on');

    await openFixture(page, P('native-checkbox'));
    r = await runSteps(page, [
      {
        action: 'setToggle',
        target: { role: 'checkbox', text: ['Use my data to improve AI models'] },
        state: 'off',
      },
      { action: 'setToggle', target: { role: 'switch', text: ['product newsletter'] }, state: 'on' },
    ]);
    expect(r.outcome).toBe('success');
    expect(await state(page, 'train')).toBe('off');
    expect(await state(page, 'news')).toBe('on');

    await openFixture(page, P('wrapping-label'));
    r = await runSteps(page, [
      {
        action: 'setToggle',
        target: { role: 'checkbox', text: ['Allow AI training on my posts'] },
        state: 'off',
      },
      {
        action: 'setToggle',
        target: { role: 'switch', text: ['Personalised recommendations'] },
        state: 'off',
      },
      {
        action: 'setToggle',
        target: { role: 'checkbox', text: ['Share my photos with partners'] },
        state: 'off',
      },
    ]);
    expect(r.outcome).toBe('success');
    expect([await state(page, 'posts'), await state(page, 'recs'), await state(page, 'photos')]).toEqual([
      'off',
      'off',
      'off',
    ]);

    await openFixture(page, P('aria-pressed'));
    r = await runSteps(page, [
      { action: 'setToggle', target: { role: 'button', text: ['Use my activity for AI'] }, state: 'off' },
    ]);
    expect(r.outcome).toBe('success');
    expect(await page.evaluate(() => window.clicks)).toBe(1);

    await openFixture(page, P('data-state'));
    r = await runSteps(page, [
      { action: 'setToggle', target: { selector: '.toggle', text: ['Personalised AI'] }, state: 'off' },
      { action: 'setToggle', target: { selector: '.toggle', text: ['Voice improvement'] }, state: 'off' },
    ]);
    expect(r.outcome).toBe('success');
    expect(
      await page.evaluate(() => [...document.querySelectorAll('.toggle')].map((t) => t.dataset.state)),
    ).toEqual(['off', 'off', 'inactive', 'pending']);
  });

  test('setToggle already in the desired state does not click → already', async ({ page }) => {
    await openFixture(page, P('already-off'));
    const r = await runSteps(page, [
      { action: 'waitFor', target: { text: ['Improve the model for everyone'] } },
      {
        action: 'setToggle',
        target: { role: 'switch', text: ['Improve the model for everyone'] },
        state: 'off',
      },
    ]);
    expect(r.outcome).toBe('already');
    expect(await page.evaluate(() => window.clicks)).toBe(0);
  });

  test('setToggle waits for slow saves without pressing twice, and follows re-rendered elements', async ({
    page,
  }) => {
    await openFixture(page, P('async-toggle'), { query: 'slow=1500&silent=1300' });
    const r = await runSteps(page, [
      {
        action: 'setToggle',
        target: { role: 'switch', text: ['Slow server save'] },
        state: 'off',
        timeoutMs: 1000,
      },
      {
        action: 'setToggle',
        target: { role: 'switch', text: ['Very slow silent save'] },
        state: 'off',
        timeoutMs: 2000,
      },
      { action: 'setToggle', target: { role: 'switch', text: ['Re-rendered switch'] }, state: 'off' },
    ]);
    expect(r.outcome).toBe('success');
    expect(await page.evaluate(() => window.clicks)).toEqual({ slow: 1, silent: 1, replaced: 1 });
    expect(await state(page, 'replaced')).toBe('off');
  });

  test('setToggle that never changes, reverts, is locked or has no state → failed', async ({ page }) => {
    await openFixture(page, P('stubborn'));
    const run = (text, extra = {}) =>
      runSteps(page, [
        {
          action: 'setToggle',
          target: { role: 'switch', text: [text] },
          state: 'off',
          timeoutMs: 500,
          ...extra,
        },
      ]);
    let r = await run('Ignores clicks');
    expect(r).toMatchObject({ outcome: 'failed', failedStep: 0 });
    expect(r.message).toContain("didn't change");
    r = await runSteps(page, [
      {
        action: 'setToggle',
        target: { role: 'checkbox', text: ['Native checkbox that cancels'] },
        state: 'off',
        timeoutMs: 500,
      },
    ]);
    expect(r.outcome).toBe('failed');
    r = await run('Reverts after saving fails');
    expect(r.outcome).toBe('failed');
    expect(r.message).toContain('back');
    r = await run('Managed by your organisation');
    expect(r.outcome).toBe('failed');
    expect(r.message).toContain('locked');
    r = await runSteps(page, [
      {
        action: 'setToggle',
        target: { role: 'checkbox', text: ['Disabled checkbox'] },
        state: 'off',
        timeoutMs: 500,
      },
    ]);
    expect(r.outcome).toBe('failed');
    r = await run('Unknown state');
    expect(r.outcome).toBe('failed');
    expect(r.message).toContain('on or off');
    const clicks = await page.evaluate(() => window.clicks);
    // At most one extra attempt when nothing at all happened; never on a locked control.
    expect(clicks.ignore).toBeLessThanOrEqual(2);
    expect(clicks.revert).toBe(1);
    expect(clicks.locked).toBe(0);
  });

  test('confirmation dialogs: setToggle hands over to the confirm steps, final state is checked', async ({
    page,
  }) => {
    await openFixture(page, P('confirm-dialog'));
    const steps = [
      { action: 'setToggle', target: { role: 'switch', text: ['Allow AI training'] }, state: 'off' },
      // Confirm clicks are optional so that a re-run (no dialog) is idempotent.
      {
        action: 'click',
        target: { role: 'button', text: ['Turn off', 'Confirm'], within: { role: 'dialog' } },
        optional: true,
      },
      {
        action: 'click',
        target: { role: 'button', text: ['Done'], within: { role: 'dialog' } },
        optional: true,
        timeoutMs: 1500,
      },
    ];
    const r = await runSteps(page, steps);
    expect(r.outcome).toBe('success');
    expect(r.progress.find((p) => p.stepIndex === 0 && p.status !== 'running').status).toBe('pending');
    expect(await state(page, 'allow')).toBe('off');
    expect(
      await page.evaluate(() => ({
        confirmations: window.confirmations,
        open: !!document.getElementById('portal'),
      })),
    ).toEqual({
      confirmations: 1,
      open: false,
    });
    const again = await runSteps(page, steps);
    expect(again.outcome).toBe('already');

    // Without a confirm step the change is not confirmed → failed, never reported as success.
    await openFixture(page, P('confirm-dialog'));
    const r2 = await runSteps(page, [
      {
        action: 'setToggle',
        target: { role: 'switch', text: ['Allow AI training'] },
        state: 'off',
        timeoutMs: 800,
      },
    ]);
    expect(r2.outcome).toBe('failed');
  });

  test('setting behind a Manage button in a sub-panel', async ({ page }) => {
    await openFixture(page, P('manage-subpanel'));
    const steps = [
      { action: 'click', target: { role: 'button', text: ['AI training data'] } },
      { action: 'setToggle', target: { role: 'switch', text: ['Use my content to train AI'] }, state: 'off' },
    ];
    const r = await runSteps(page, steps);
    expect(r.outcome).toBe('success');
    expect(await page.evaluate(() => window.opened)).toEqual(['ai']);
    expect(await state(page, 'use')).toBe('off');
    expect(await state(page, 'ads')).toBe('on');
  });

  test('waitFor sees content added later and CSS-only reveals', async ({ page }) => {
    await openFixture(page, P('delayed'), { query: 'delay=700&cssDelay=900' });
    const start = Date.now();
    const r = await runSteps(page, [
      {
        action: 'waitFor',
        target: { role: 'switch', text: ['Use conversations for training'] },
        timeoutMs: 5000,
      },
      { action: 'waitFor', target: { role: 'switch', text: ['Allow model training'] }, timeoutMs: 5000 },
      {
        action: 'setToggle',
        target: { role: 'switch', text: ['Use conversations for training'] },
        state: 'off',
      },
    ]);
    expect(r.outcome).toBe('success');
    expect(Date.now() - start).toBeLessThan(4000);
  });

  test('waitFor timeout → not_found; optional steps are skipped', async ({ page }) => {
    await openFixture(page, P('delayed'), { query: 'delay=60000&cssDelay=60000' });
    const start = Date.now();
    let r = await runSteps(page, [
      {
        action: 'waitFor',
        target: { role: 'switch', text: ['Use conversations for training'] },
        timeoutMs: 600,
      },
    ]);
    expect(r).toMatchObject({ outcome: 'not_found', failedStep: 0 });
    expect(r.message).toContain('Use conversations for training');
    expect(Date.now() - start).toBeLessThan(3000);
    // CSS-hidden (visibility: hidden) is not visible.
    r = await runSteps(page, [
      { action: 'waitFor', target: { role: 'switch', text: ['Allow model training'] }, timeoutMs: 300 },
    ]);
    expect(r.outcome).toBe('not_found');
    r = await runSteps(page, [
      { action: 'waitFor', target: { text: ['Nothing like this'] }, timeoutMs: 200, optional: true },
      {
        action: 'click',
        target: { role: 'button', text: ['Nothing like this'] },
        timeoutMs: 200,
        optional: true,
      },
      { action: 'wait', ms: 50 },
    ]);
    expect(r.outcome).toBe('success');
    expect(r.progress.filter((p) => p.status === 'skipped').map((p) => p.stepIndex)).toEqual([0, 1]);
  });

  test('assertToggle is read-only: success or mismatch', async ({ page }) => {
    await openFixture(page, P('radix-switch'));
    let r = await runSteps(
      page,
      [
        {
          action: 'assertToggle',
          target: { role: 'switch', text: ['Improve the model for everyone'] },
          state: 'off',
        },
      ],
      { mode: 'verify' },
    );
    expect(r).toMatchObject({ outcome: 'mismatch', failedStep: 0 });
    expect(r.message).toContain('is on');
    r = await runSteps(
      page,
      [{ action: 'assertToggle', target: { role: 'switch', text: ['Chat history'] }, state: 'off' }],
      { mode: 'verify' },
    );
    expect(r.outcome).toBe('success');
    // In verify mode even setToggle only reads.
    r = await runSteps(
      page,
      [
        {
          action: 'setToggle',
          target: { role: 'switch', text: ['Improve the model for everyone'] },
          state: 'off',
        },
      ],
      { mode: 'verify' },
    );
    expect(r.outcome).toBe('mismatch');
    // An assert in an auto run reports mismatch too.
    r = await runSteps(page, [
      {
        action: 'assertToggle',
        target: { role: 'switch', text: ['Improve the model for everyone'] },
        state: 'off',
      },
    ]);
    expect(r.outcome).toBe('mismatch');
    expect(await page.evaluate(() => window.fixtureLog)).toEqual([]);
  });

  test('wait sleeps for ms', async ({ page }) => {
    await openFixture(page, P('radix-switch'));
    const t = Date.now();
    const r = await runSteps(page, [{ action: 'wait', ms: 400 }]);
    expect(r.outcome).toBe('success');
    expect(Date.now() - t).toBeGreaterThanOrEqual(380);
  });

  test('malformed recipes fail cleanly', async ({ page }) => {
    await openFixture(page, P('radix-switch'));
    expect((await runSteps(page, [])).outcome).toBe('failed');
    expect((await runSteps(page, [{ action: 'hover', target: { text: ['x'] } }])).outcome).toBe('failed');
    expect(
      (await runSteps(page, [{ action: 'setToggle', target: { role: 'switch' }, state: 'maybe' }])).outcome,
    ).toBe('failed');
    const bad = await runSteps(page, [{ action: 'click', target: { selector: '[[' } }]);
    expect(bad.outcome).toBe('failed');
    expect(bad.message).toContain('Invalid selector');
    expect(await page.evaluate(() => window.fixtureLog)).toEqual([]);
  });
});

test.describe('outcomes', () => {
  test('progress events cover every step in order', async ({ page }) => {
    await openFixture(page, P('radix-switch'));
    const r = await runSteps(page, [
      { action: 'waitFor', target: { text: ['Improve the model'] }, description: 'Waiting for the page' },
      { action: 'setToggle', target: { role: 'switch', text: ['Improve the model'] }, state: 'off' },
    ]);
    expect(r.progress.map((p) => [p.stepIndex, p.status])).toEqual([
      [0, 'running'],
      [0, 'done'],
      [1, 'running'],
      [1, 'done'],
    ]);
    expect(r.progress[0]).toMatchObject({ total: 2, description: 'Waiting for the page', action: 'waitFor' });
    expect(r.progress[2].description).toBe('Turning off “Improve the model”');
  });

  test('needs_login when a login indicator is shown (checked before the steps)', async ({ page }) => {
    await openFixture(page, P('logged-out'));
    const login = [{ role: 'button', text: ['Log in', 'Sign up for free'] }];
    expect(await page.evaluate((l) => NoTrainEngine.checkLogin(l), login)).toBe(true);
    const r = await runSteps(
      page,
      [
        {
          action: 'setToggle',
          target: { role: 'switch', text: ['Improve the model for everyone'] },
          state: 'off',
        },
      ],
      { loginIndicators: login },
    );
    expect(r.outcome).toBe('needs_login');
    expect(await page.evaluate(() => !!window.loginClicked)).toBe(false);
  });

  test('needs_login when the login wall renders late, instead of waiting for the full timeout', async ({
    page,
  }) => {
    await openFixture(page, P('logged-out'), { query: 'late=500' });
    const start = Date.now();
    const r = await runSteps(
      page,
      [{ action: 'waitFor', target: { text: ['Improve the model for everyone'] }, timeoutMs: 15000 }],
      { loginIndicators: [{ role: 'button', text: ['Log in'] }] },
    );
    expect(r.outcome).toBe('needs_login');
    expect(Date.now() - start).toBeLessThan(6000);
  });

  test('a login button that flashes during hydration is not a login wall', async ({ page }) => {
    await openFixture(page, P('logged-out'), { query: 'flash=400' });
    const r = await runSteps(
      page,
      [
        {
          action: 'setToggle',
          target: { role: 'switch', text: ['Improve the model for everyone'] },
          state: 'off',
        },
      ],
      { loginIndicators: [{ role: 'button', text: ['Log in'] }] },
    );
    expect(r.outcome).toBe('success');
  });

  test('login indicators match names only, not text elsewhere in a row', async ({ page }) => {
    await openFixture(page, P('logged-out'), { query: 'flash=1' });
    await page.waitForSelector('#improve');
    // "Require a code when you sign in" is in the row of the "Set up" button.
    expect(await page.evaluate(() => NoTrainEngine.checkLogin([{ role: 'button', text: ['sign in'] }]))).toBe(
      false,
    );
    expect(await page.evaluate(() => NoTrainEngine.checkLogin([]))).toBe(false);
    expect(await page.evaluate(() => NoTrainEngine.checkLogin([{ role: 'banana' }]))).toBe(false);
  });

  test('cancellation via AbortSignal → cancelled, promptly, with nothing clicked afterwards', async ({
    page,
  }) => {
    await openFixture(page, P('delayed'), { query: 'delay=60000&cssDelay=60000' });
    const r = await page.evaluate(async () => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 300);
      const t = Date.now();
      const res = await NoTrainEngine.runSteps(
        [
          { action: 'waitFor', target: { text: ['Use conversations for training'] }, timeoutMs: 20000 },
          { action: 'setToggle', target: { role: 'switch', text: ['Use conversations'] }, state: 'off' },
        ],
        { signal: ctrl.signal },
      );
      return { ...res, ms: Date.now() - t };
    });
    expect(r.outcome).toBe('cancelled');
    expect(r.failedStep).toBe(0);
    expect(r.ms).toBeLessThan(1500);
    const pre = await page.evaluate(async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      return NoTrainEngine.runSteps([{ action: 'wait', ms: 5000 }], { signal: ctrl.signal });
    });
    expect(pre.outcome).toBe('cancelled');
    const mid = await page.evaluate(async () => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 100);
      return NoTrainEngine.runSteps([{ action: 'wait', ms: 5000 }], { signal: ctrl.signal });
    });
    expect(mid.outcome).toBe('cancelled');
  });

  test('waitForTarget honours filter and reports login', async ({ page }) => {
    await openFixture(page, P('radix-switch'));
    const r = await page.evaluate(async () => {
      const a = await NoTrainEngine.waitForTarget(
        { role: 'switch' },
        { timeoutMs: 100, filter: (el) => NoTrainEngine.readToggleState(el) === 'off' },
      );
      const b = await NoTrainEngine.waitForTarget({ role: 'switch', text: ['Nope'] }, { timeoutMs: 100 });
      return { a: a.element && a.element.getAttribute('aria-checked'), b: b.element };
    });
    expect(r).toEqual({ a: 'false', b: null });
  });
});

test.describe('highlight', () => {
  test('draws a ring around the element in its own closed shadow root and cleans up', async ({ page }) => {
    await openFixture(page, P('radix-switch'));
    const r = await page.evaluate(() => {
      const el = document.getElementById('improve');
      const before = el.outerHTML;
      const ok = NoTrainEngine.highlight(el, { label: 'Step 4' });
      const host = document.querySelector('notrain-highlight');
      return {
        ok,
        hosts: document.querySelectorAll('notrain-highlight').length,
        closed: host.shadowRoot === null,
        untouched: el.outerHTML === before,
        pointerEvents: getComputedStyle(host).pointerEvents,
        excluded: NoTrainEngine.findAll({ text: ['Step 4'] }).length,
      };
    });
    expect(r).toEqual({
      ok: true,
      hosts: 1,
      closed: true,
      untouched: true,
      pointerEvents: 'none',
      excluded: 0,
    });
    await page.evaluate(() =>
      NoTrainEngine.highlight(document.querySelector('[aria-labelledby="audio-label"]')),
    );
    expect(await page.locator('notrain-highlight').count()).toBe(1);
    await page.evaluate(() => NoTrainEngine.clearHighlight());
    expect(await page.locator('notrain-highlight').count()).toBe(0);
    expect(await page.evaluate(() => NoTrainEngine.highlight(null))).toBe(false);
  });
});
