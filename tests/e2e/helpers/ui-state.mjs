// Helpers for the UI Playwright specs (ui.spec.mjs, popup.spec.mjs,
// store-screenshots.spec.mjs): talk to the real background through the
// documented message API, seed realistic state, and check pages for basic
// accessibility problems.

/** Send a message to the background from an extension page. Throws on { ok: false }. */
export async function send(page, message) {
  const res = await page.evaluate((m) => chrome.runtime.sendMessage(m), message);
  if (!res?.ok) throw new Error(`${message.type} failed: ${res?.error ?? 'no response'}`);
  return res.data;
}

export function getState(page) {
  return send(page, { type: 'getState' });
}

/** Open an extension page and wait until the background answers getState. */
export async function openPage(context, extensionId, pagePath) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
  await page.waitForFunction(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'getState' });
      return res?.ok === true;
    } catch {
      return false;
    }
  });
  return page;
}

export const DEMO_TRACKED = [
  'chatgpt',
  'claude',
  'linkedin',
  'x',
  'gemini',
  'slack',
  'notion',
  'reddit',
  'github',
  'perplexity',
];

/**
 * Realistic state for tests and store screenshots: UK user, ten services
 * tracked, two opted out, one setting flipped back on, three alerts.
 * Opt-out ids are looked up from the live registry so data changes don't break it.
 */
export async function seedDemo(page, { region = 'UK', tracked = DEMO_TRACKED } = {}) {
  const state = await getState(page);
  const services = state.registry.services;
  const has = (id) => services.some((s) => s.id === id);
  const ids = tracked.filter(has);
  const firstOptOut = (id, type = 'toggle') =>
    services.find((s) => s.id === id)?.optOuts.find((o) => o.type === type)?.id;

  await send(page, {
    type: 'updateSettings',
    patch: { region, onboarded: true, profile: { fullName: 'Alex Morgan', email: 'alex@example.com' } },
  });
  await send(page, { type: 'trackServices', serviceIds: ids, tracked: true, source: 'manual' });
  const done = [
    ['chatgpt', 'done', 'auto'],
    ['linkedin', 'done', 'guided'],
    ['x', 'needs_attention', 'auto'],
  ];
  for (const [id, status, method] of done) {
    const optOutId = firstOptOut(id);
    if (ids.includes(id) && optOutId)
      await send(page, { type: 'setOptOutStatus', serviceId: id, optOutId, status, method });
  }
  const xToggle = firstOptOut('x');
  await page.evaluate(
    async ({ xToggle, hasX }) => {
      const now = Date.now();
      const iso = (ms) => new Date(now - ms).toISOString();
      const { alerts = [] } = await chrome.storage.local.get('alerts');
      const extra = [
        hasX && {
          id: 'demo-a1',
          kind: 'flip_back',
          serviceId: 'x',
          optOutId: xToggle,
          severity: 'warning',
          title: 'Grok training was switched back on',
          body: 'NoTrain found the setting that lets X use your posts to train Grok switched on again. Switch it off to stop new posts being used.',
          createdAt: iso(2 * 3600e3),
          read: false,
          dismissed: false,
        },
        {
          id: 'demo-a2',
          kind: 'reminder',
          serviceId: 'chatgpt',
          severity: 'info',
          title: 'Time to re-check ChatGPT',
          body: 'It has been 3 months since you switched off “Improve the model for everyone”. Check it is still off.',
          createdAt: iso(3 * 86400e3),
          read: true,
          dismissed: false,
        },
        {
          id: 'demo-a3',
          kind: 'new_service',
          severity: 'info',
          title: 'New services in NoTrain',
          body: 'More services were added to the list. Take a look in Services.',
          createdAt: iso(6 * 86400e3),
          read: true,
          dismissed: false,
        },
      ].filter(Boolean);
      await chrome.storage.local.set({ alerts: [...extra, ...alerts] });
    },
    { xToggle, hasX: ids.includes('x') },
  );
  return getState(page);
}

/**
 * Basic automated accessibility checks on the current page. Returns a list of
 * human-readable problems (empty when fine).
 */
export function a11yProblems(page, { expectNav = true } = {}) {
  return page.evaluate((expectNavArg) => {
    const problems = [];
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && (r.width > 0 || r.height > 0);
    };
    const describe = (el) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ').join('.')}` : ''}`;
    const textOf = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const nameOf = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim();
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const t = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        if (t) return t;
      }
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl && textOf(lbl)) return textOf(lbl);
      }
      const wrap = el.closest('label');
      if (wrap && textOf(wrap)) return textOf(wrap);
      if (el.tagName === 'INPUT' && ['button', 'submit'].includes(el.type) && el.value) return el.value;
      if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA' && textOf(el))
        return textOf(el);
      if (el.getAttribute('title')) return el.getAttribute('title');
      return '';
    };

    const interactive = document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=switch], [role=tab]',
    );
    for (const el of interactive) {
      if (el.closest('[aria-hidden="true"]') && el.getAttribute('tabindex') === '-1') continue;
      if (el.type === 'file' && el.getAttribute('aria-hidden') === 'true') continue;
      if (!nameOf(el)) problems.push(`No accessible name: ${describe(el)}`);
    }
    for (const img of document.querySelectorAll('img')) {
      if (!img.hasAttribute('alt')) problems.push(`Image without alt: ${img.src}`);
    }
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.closest('[aria-hidden="true"]')) continue;
      const labelled =
        svg.getAttribute('role') === 'img' &&
        (svg.getAttribute('aria-label') || svg.getAttribute('aria-labelledby'));
      if (!labelled)
        problems.push(`SVG is neither hidden nor labelled: ${describe(svg.parentElement ?? svg)}`);
    }
    if (!document.querySelector('main')) problems.push('No <main> landmark');
    if (expectNavArg && !document.querySelector('nav')) problems.push('No <nav> landmark');
    const h1s = [...document.querySelectorAll('h1')].filter(visible);
    if (h1s.length !== 1) problems.push(`Expected exactly one visible h1, found ${h1s.length}`);
    const ids = new Map();
    for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) problems.push(`Duplicate id "${id}" (${n}×)`);
    if (!document.documentElement.lang) problems.push('<html> has no lang');
    if (!document.title) problems.push('Document has no title');
    return problems;
  }, expectNav);
}

/** Collects console errors and uncaught exceptions on a page. */
export function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}
