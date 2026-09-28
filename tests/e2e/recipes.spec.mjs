// Runs every registry automation recipe against a mock page generated from the
// recipe's own targets. This checks that each recipe is executable by the
// engine and internally consistent (the verify steps agree with the steps,
// toggles move in the right direction, a second run is harmless, and a setting
// that flipped back is reported as a mismatch). It cannot prove the recipe
// matches the live site; hand-written fixtures in tests/fixtures/services/
// are the place for that.
import { test, expect } from '@playwright/test';
import { injectEngine, loadServices, runSteps } from './helpers/content.mjs';

const ORIGIN = 'https://mock.notrain.test';

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const firstText = (target) => target.text?.[0] ?? '';
const selectorKind = (selector = '') => {
  const first = selector.split(',')[0].trim();
  if (/menuitem|option/.test(first)) return 'menuitem';
  if (/switch/.test(first)) return 'switch';
  if (/checkbox/.test(first)) return 'checkbox';
  if (/^a\[/.test(first)) return 'link';
  return 'generic';
};

/** Builds a mock settings page containing one control per distinct recipe target. */
function mockPage(automation) {
  const steps = [...automation.steps, ...(automation.verify ?? [])];
  const desired = automation.steps.find((s) => s.action === 'setToggle')?.state ?? 'on';
  const initialOn = desired === 'off'; // start in the state the recipe has to change
  const parts = [];
  const seen = new Set();
  let n = 0;

  for (const step of steps) {
    const t = step.target;
    if (!t || t.within) continue; // scoped (optional) targets are covered below
    const text = firstText(t);
    const kind = t.role ?? selectorKind(t.selector);
    const key = `${step.action}|${kind}|${text}|${t.selector ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    n += 1;
    const toggleStep = step.action === 'setToggle' || step.action === 'assertToggle';
    if (toggleStep && (kind === 'switch' || kind === 'generic')) {
      if (seen.has(`toggle|${text}`)) continue;
      seen.add(`toggle|${text}`);
      parts.push(
        `<div class="row"><span id="l${n}">${esc(text)}</span>` +
          `<button type="button" role="switch" data-toggle aria-checked="${initialOn}" aria-labelledby="l${n}"></button></div>`,
      );
    } else if (toggleStep && kind === 'checkbox') {
      if (seen.has(`toggle|${text}`)) continue;
      seen.add(`toggle|${text}`);
      parts.push(
        `<div class="row"><label><input type="checkbox" data-toggle ${initialOn ? 'checked' : ''}> ${esc(text)}</label></div>`,
      );
    } else if (kind === 'menuitem') {
      if (seen.has(`menu|${text}`)) continue;
      seen.add(`menu|${text}`);
      parts.push(
        `<div role="menu"><div role="menuitemradio" data-toggle data-menu aria-checked="false" tabindex="0">${esc(text)}</div>` +
          `<div role="menuitemradio" aria-checked="true" tabindex="0">Enabled</div></div>`,
      );
    } else if (kind === 'link') {
      const m = /href\*=['"]?([^'"\]]+)/.exec(t.selector);
      parts.push(`<a href="#${esc(m ? m[1] : '/')}demo">Open settings</a>`);
    } else if (kind === 'button') {
      if (seen.has(`button|${text}`)) continue;
      seen.add(`button|${text}`);
      parts.push(`<button type="button">${esc(text)}</button>`);
    } else if (text && !parts.some((p) => p.includes(esc(text)))) {
      parts.push(`<p>${esc(text)}</p>`);
    }
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock settings</title></head>
<body><header><nav><a href="#">Home</a> <a href="#">Help</a></nav></header>
<main><h1>Settings</h1><section>${parts.join('\n')}</section></main>
<script>
  document.addEventListener('click', (e) => {
    const sw = e.target.closest('[role=switch][data-toggle]');
    if (sw) sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'));
    const item = e.target.closest('[role=menuitemradio]');
    if (item) {
      item.parentElement.querySelectorAll('[role=menuitemradio]').forEach((i) => i.setAttribute('aria-checked', 'false'));
      item.setAttribute('aria-checked', 'true');
    }
  });
  // Undo the opt-out, as if an app update had switched the setting back.
  window.__flipBack = () => {
    document.querySelectorAll('[role=switch][data-toggle]').forEach((el) => el.setAttribute('aria-checked', '${initialOn}'));
    document.querySelectorAll('input[data-toggle]').forEach((el) => { el.checked = ${initialOn}; });
    document.querySelectorAll('[data-menu]').forEach((el) => {
      el.setAttribute('aria-checked', 'false');
      el.nextElementSibling.setAttribute('aria-checked', 'true');
    });
  };
</script></body></html>`;
}

const automated = loadServices().flatMap((service) =>
  service.optOuts.filter((o) => o.automation).map((optOut) => ({ service, optOut })),
);

test('the registry has automation recipes to test', () => {
  expect(automated.length).toBeGreaterThan(0);
});

for (const { service, optOut } of automated) {
  test(`${service.id} / ${optOut.id}: recipe runs, is idempotent and verifies`, async ({ page }) => {
    const { automation } = optOut;
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: mockPage(automation) }),
    );
    await page.goto(`${ORIGIN}/settings`);
    await injectEngine(page);

    // Fast timeouts: everything is already on the page.
    const fast = (steps) =>
      steps.map((s) => (s.timeoutMs ? { ...s, timeoutMs: Math.min(s.timeoutMs, 3000) } : s));
    const quick = (steps) => fast(steps).map((s) => (s.action === 'wait' ? { ...s, ms: 10 } : s));

    const first = await runSteps(page, quick(automation.steps));
    expect(first.outcome, first.message).toBe('success');

    const second = await runSteps(page, quick(automation.steps));
    expect(['success', 'already'], second.message).toContain(second.outcome);

    if (automation.verify?.length) {
      // A passing check reports the setting as already in the desired state.
      const ok = await runSteps(page, quick(automation.verify), { mode: 'verify' });
      expect(['success', 'already'], ok.message).toContain(ok.outcome);

      await page.evaluate(() => window.__flipBack());
      const flipped = await runSteps(page, quick(automation.verify), { mode: 'verify' });
      expect(flipped.outcome, flipped.message).toBe('mismatch');
    }
  });
}
