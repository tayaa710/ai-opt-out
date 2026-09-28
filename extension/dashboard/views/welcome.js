// #/welcome: onboarding in four steps.
//   1. What NoTrain does + privacy promise
//   2. Confirm region (pre-selected from the time zone)
//   3. Choose services (search, grouped by category, optional account detection)
//   4. Done: summary and next steps

import { api } from '../../lib/api.js';
import { REGIONS, guessRegion } from '../../lib/region.js';
import { serviceStatus, applicableOptOuts } from '../../lib/status.js';
import { h, mount } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { logoMark } from '../../shared/logo.js';
import { monogram } from '../../shared/monogram.js';
import { toast } from '../../shared/toast.js';
import { plural } from '../../shared/format.js';
import { CATEGORY_ORDER, categoryLabel } from '../../shared/labels.js';
import { button, detectAccountsFlow } from '../common.js';
import { matchesQuery } from './services.js';

const STEPS = ['Welcome', 'Your region', 'Your services', 'Done'];

/** Wizard state lives for the page's lifetime. */
const wz = { step: 0, region: null, guessed: null, selected: null, q: '', saving: false };

export function title() {
  return 'Welcome';
}

function init(state) {
  if (wz.selected) return;
  wz.guessed = guessRegion();
  const stored = state.settings.region;
  wz.region = state.settings.onboarded || (stored && stored !== 'OTHER') ? stored : wz.guessed;
  wz.selected = new Set(
    state.registry.services.filter((s) => state.userState.services?.[s.id]?.tracked).map((s) => s.id),
  );
}

function goStep(ctx, n) {
  wz.step = n;
  ctx.rerender();
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    document.querySelector('[data-page-title]')?.focus({ preventScroll: true });
  });
}

function progress() {
  return h(
    'div',
    { class: 'w-progress' },
    h(
      'p',
      { class: 'w-progress__label' },
      `Step ${wz.step + 1} of ${STEPS.length}`,
      h('span', { class: 'nt-visually-hidden' }, `: ${STEPS[wz.step]}`),
    ),
    h(
      'div',
      { class: 'w-progress__bars', 'aria-hidden': 'true' },
      STEPS.map((_, i) => h('span', { class: ['w-progress__bar', i <= wz.step && 'is-on'] })),
    ),
  );
}

function footer(...children) {
  return h('div', { class: 'w-footer' }, children);
}

/* ---------- Step 1 ---------- */

function stepIntro(ctx) {
  const feature = (iconName, heading, text) =>
    h(
      'li',
      { class: 'w-feature' },
      h('span', { class: 'w-feature__icon' }, icon(iconName)),
      h(
        'div',
        null,
        h('p', { class: 'w-feature__title' }, heading),
        h('p', { class: 'w-feature__text' }, text),
      ),
    );
  return [
    h(
      'div',
      { class: 'w-hero' },
      logoMark({ size: 56 }),
      h(
        'h1',
        { class: 'w-title', tabindex: '-1', 'data-page-title': '' },
        'Decide who trains AI on your data',
      ),
      h(
        'p',
        { class: 'w-lede' },
        'Many apps now use what you write, post and upload to train AI models. NoTrain shows you which ones do, and helps you switch it off.',
      ),
    ),
    h(
      'ul',
      { class: 'w-features', role: 'list' },
      feature(
        'search',
        'See who trains on your data',
        'Plain-language facts for each service, checked against the company’s own documentation.',
      ),
      feature(
        'zap',
        'Opt out in a click or two',
        'NoTrain can switch settings off for you, or walk you through each step.',
      ),
      feature(
        'bell',
        'Hear about changes',
        'Get a heads-up if a company changes its policy or a setting gets switched back on.',
      ),
    ),
    h(
      'div',
      { class: 'w-promise' },
      icon('lock'),
      h(
        'div',
        null,
        h('p', { class: 'w-promise__title' }, 'Private by design'),
        h(
          'p',
          null,
          'No account, no tracking, no servers. Everything stays in your browser. The only thing NoTrain downloads is a public list of services and how to opt out of them.',
        ),
      ),
    ),
    footer(
      h(
        'button',
        {
          type: 'button',
          class: 'w-skip nt-btn nt-btn--ghost',
          'data-testid': 'welcome-skip',
          onClick: async () => {
            try {
              await api.updateSettings({ onboarded: true });
            } catch {
              // Still let them through.
            }
            ctx.navigate('#/overview');
          },
        },
        'Skip setup',
      ),
      button('Get started', {
        variant: 'primary',
        size: 'lg',
        testid: 'welcome-next',
        onClick: () => goStep(ctx, 1),
      }),
    ),
  ];
}

/* ---------- Step 2 ---------- */

function stepRegion(ctx) {
  const options = REGIONS.map((r) =>
    h(
      'label',
      { class: 'nt-choice w-region' },
      h('input', {
        type: 'radio',
        name: 'region',
        value: r.code,
        checked: wz.region === r.code,
        'data-testid': `region-${r.code}`,
        onChange: () => {
          wz.region = r.code;
        },
      }),
      h(
        'span',
        { class: 'nt-choice__body' },
        h(
          'span',
          { class: 'nt-choice__title' },
          r.label,
          r.code === wz.guessed &&
            r.code !== 'OTHER' &&
            h('span', { class: 'nt-pill nt-pill--primary nt-pill--plain w-suggested' }, 'Suggested'),
        ),
        h('span', { class: 'nt-choice__desc' }, r.law ?? 'No specific privacy law assumed'),
      ),
    ),
  );
  return [
    h(
      'div',
      { class: 'w-head' },
      h('h1', { class: 'w-title', tabindex: '-1', 'data-page-title': '' }, 'Where do you live?'),
      h(
        'p',
        { class: 'w-lede' },
        'Your rights depend on where you live. NoTrain uses this to show the opt-outs and legal requests that apply to you. It never leaves your device.',
      ),
    ),
    h(
      'fieldset',
      { class: 'w-fieldset' },
      h('legend', { class: 'nt-visually-hidden' }, 'Your region'),
      h('div', { class: 'w-region-grid' }, options),
    ),
    wz.guessed &&
      wz.guessed !== 'OTHER' &&
      h(
        'p',
        { class: 'nt-subtle w-note' },
        icon('info', { size: 14 }),
        'Suggested from your computer’s time zone. Change it if it’s wrong.',
      ),
    footer(
      button('Back', { variant: 'ghost', iconName: 'arrowLeft', onClick: () => goStep(ctx, 0) }),
      button('Continue', {
        variant: 'primary',
        size: 'lg',
        testid: 'welcome-next',
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.setAttribute('aria-busy', 'true');
          btn.disabled = true;
          try {
            await api.updateSettings({ region: wz.region });
            goStep(ctx, 2);
          } catch (err) {
            toast(`Couldn’t save your region: ${err.message}`, { tone: 'bad' });
            btn.removeAttribute('aria-busy');
            btn.disabled = false;
          }
        },
      }),
    ),
  ];
}

/* ---------- Step 3 ---------- */

function pickCard(service, onToggle) {
  const id = `pick-${service.id}`;
  const trains = service.training?.trainsOnUserData;
  const hint =
    trains === 'no'
      ? 'Doesn’t train on your data'
      : trains === 'yes'
        ? 'Trains on your data'
        : trains === 'conditional'
          ? 'Trains in some cases'
          : 'Training unclear';
  return h(
    'label',
    { class: 'nt-choice w-pick', for: id, 'data-service': service.id },
    h('input', {
      type: 'checkbox',
      id,
      checked: wz.selected.has(service.id),
      'data-testid': 'pick-service',
      onChange: (e) => {
        if (e.currentTarget.checked) wz.selected.add(service.id);
        else wz.selected.delete(service.id);
        onToggle();
      },
    }),
    monogram(service, { size: 'md' }),
    h(
      'span',
      { class: 'nt-choice__body' },
      h('span', { class: 'nt-choice__title w-pick__name' }, service.name),
      h('span', { class: 'nt-choice__desc' }, hint),
    ),
  );
}

function stepServices(ctx) {
  const { state } = ctx;
  const services = state.registry.services;
  const listEl = h('div', { class: 'w-groups', 'data-key': 'welcome-groups' });
  const countEl = h('p', {
    class: 'w-count',
    role: 'status',
    'aria-live': 'polite',
    'data-testid': 'pick-count',
  });
  const nextBtn = button('', { variant: 'primary', size: 'lg', testid: 'welcome-next' });

  const updateCount = () => {
    const n = wz.selected.size;
    countEl.textContent = n ? `${plural(n, 'service')} selected` : 'Nothing selected yet';
    nextBtn.textContent = n ? `Continue with ${plural(n, 'service')}` : 'Skip for now';
  };

  const drawList = () => {
    const matches = services.filter((s) => matchesQuery(s, wz.q));
    const groups = CATEGORY_ORDER.map((c) => [c, matches.filter((s) => s.category === c)]).filter(
      ([, list]) => list.length,
    );
    mount(
      listEl,
      groups.length
        ? groups.map(([c, list]) =>
            h(
              'section',
              { class: 'w-group', 'aria-labelledby': `grp-${c}` },
              h('h2', { class: 'w-group__title', id: `grp-${c}` }, categoryLabel(c)),
              h(
                'div',
                { class: 'w-pick-grid' },
                list.map((s) => pickCard(s, updateCount)),
              ),
            ),
          )
        : h('p', { class: 'w-none' }, `No services match “${wz.q}”.`),
    );
  };

  nextBtn.addEventListener('click', async () => {
    nextBtn.setAttribute('aria-busy', 'true');
    nextBtn.disabled = true;
    try {
      const selected = [...wz.selected];
      const previously = services.filter((s) => state.userState.services?.[s.id]?.tracked).map((s) => s.id);
      const removed = previously.filter((id) => !wz.selected.has(id));
      if (selected.length) await api.trackServices(selected, true, 'manual');
      if (removed.length) await api.trackServices(removed, false, 'manual');
      await api.updateSettings({ onboarded: true });
      goStep(ctx, 3);
    } catch (err) {
      toast(`Couldn’t save: ${err.message}`, { tone: 'bad' });
      nextBtn.removeAttribute('aria-busy');
      nextBtn.disabled = false;
    }
  });

  drawList();
  updateCount();

  const detectable = services.filter((s) => s.detection?.cookies?.length);
  const detectCard =
    detectable.length > 0 &&
    h(
      'div',
      { class: 'w-detect' },
      h('span', { class: 'w-detect__icon' }, icon('scan')),
      h(
        'div',
        { class: 'w-detect__body' },
        h('p', { class: 'w-detect__title' }, 'Not sure? Let NoTrain find them'),
        h(
          'p',
          { class: 'w-detect__text' },
          `NoTrain can check which of ${plural(detectable.length, 'service')} you’re signed into. Your browser will ask for permission first. NoTrain only checks whether a sign-in cookie exists (it never reads it) and gives the permission back straight after.`,
        ),
      ),
      button('Detect my accounts', {
        variant: 'secondary',
        iconName: 'scan',
        testid: 'welcome-detect',
        onClick: (e) => {
          const btn = e.currentTarget;
          const flow = detectAccountsFlow(services);
          btn.setAttribute('aria-busy', 'true');
          btn.disabled = true;
          flow.then((res) => {
            for (const id of res?.detected ?? []) wz.selected.add(id);
            if (btn.isConnected) {
              btn.removeAttribute('aria-busy');
              btn.disabled = false;
            }
            drawList();
            updateCount();
          });
        },
      }),
    );

  return [
    h(
      'div',
      { class: 'w-head' },
      h('h1', { class: 'w-title', tabindex: '-1', 'data-page-title': '' }, 'Which services do you use?'),
      h('p', { class: 'w-lede' }, 'Pick the ones you have an account with. You can change this any time.'),
    ),
    detectCard,
    h(
      'div',
      { class: 'w-pick-toolbar' },
      h(
        'label',
        { class: 'nt-search' },
        h('span', { class: 'nt-visually-hidden' }, 'Search services'),
        icon('search'),
        h('input', {
          class: 'nt-input',
          type: 'search',
          id: 'welcome-search',
          placeholder: 'Search services',
          value: wz.q,
          autocomplete: 'off',
          'data-testid': 'welcome-search',
          onInput: (e) => {
            wz.q = e.currentTarget.value;
            drawList();
          },
        }),
      ),
      countEl,
    ),
    listEl,
    footer(
      button('Back', { variant: 'ghost', iconName: 'arrowLeft', onClick: () => goStep(ctx, 1) }),
      nextBtn,
    ),
  ];
}

/* ---------- Step 4 ---------- */

function stepDone(ctx) {
  const { state } = ctx;
  const { registry, userState, settings } = state;
  const tracked = registry.services.filter((s) => userState.services?.[s.id]?.tracked);
  let auto = 0;
  let manual = 0;
  let safe = 0;
  let none = 0;
  for (const s of tracked) {
    const st = serviceStatus(s, userState, settings.region);
    if (st.code === 'safe_by_default' || st.code === 'protected') safe += 1;
    else if (st.code === 'action_needed' || st.code === 'needs_attention') {
      if (applicableOptOuts(s, settings.region).some((o) => o.automation)) auto += 1;
      else manual += 1;
    } else none += 1;
  }
  const stats = [
    [auto, auto === 1 ? 'can be switched off for you' : 'can be switched off for you', 'primary'],
    [manual, 'take a few steps', 'warn'],
    [safe, safe === 1 ? 'is already fine' : 'are already fine', 'good'],
    [none, none === 1 ? 'has no opt-out yet' : 'have no opt-out yet', null],
  ].filter(([n]) => n > 0);
  const stat = (n, label, tone) =>
    h(
      'div',
      { class: ['w-stat', tone && `w-stat--${tone}`] },
      h('span', { class: 'w-stat__n' }, String(n)),
      h('span', { class: 'w-stat__label' }, label),
    );
  const next = (n, heading, text) =>
    h(
      'li',
      { class: 'w-next' },
      h('span', { class: 'w-next__n', 'aria-hidden': 'true' }, String(n)),
      h('div', null, h('p', { class: 'w-next__title' }, heading), h('p', { class: 'w-next__text' }, text)),
    );
  return [
    h(
      'div',
      { class: 'w-hero' },
      h('span', { class: 'w-done-icon' }, icon('checkCircle')),
      h('h1', { class: 'w-title', tabindex: '-1', 'data-page-title': '' }, 'You’re set up'),
      h(
        'p',
        { class: 'w-lede' },
        tracked.length
          ? `NoTrain is keeping an eye on ${plural(tracked.length, 'service')} for you.`
          : 'You can add services from the Services page whenever you like.',
      ),
    ),
    tracked.length > 0 &&
      h(
        'div',
        {
          class: 'w-stats',
          'data-testid': 'welcome-summary',
          style: { '--cols': String(Math.max(1, stats.length)) },
        },
        stats.map(([n, label, tone]) => stat(n, label, tone)),
      ),
    h(
      'ol',
      { class: 'w-nexts', role: 'list' },
      next(1, 'Start with the quick wins', 'Your overview lists what to do first. Most take under a minute.'),
      next(
        2,
        'Pin NoTrain to your toolbar',
        'Click the puzzle icon next to the address bar, then the pin next to NoTrain. It shows where you stand on the site you’re visiting.',
      ),
      next(
        3,
        'Leave the rest to NoTrain',
        'It checks for policy changes every week and tells you if something needs your attention.',
      ),
    ),
    footer(
      h('span'),
      button('Go to my overview', {
        variant: 'primary',
        size: 'lg',
        iconName: null,
        testid: 'welcome-finish',
        onClick: () => {
          wz.step = 0;
          wz.selected = null;
          ctx.navigate('#/overview');
        },
      }),
    ),
  ];
}

export function render(ctx) {
  if (ctx.navigated) {
    // Arriving fresh (e.g. after a reset): start from the first step.
    wz.step = 0;
    wz.selected = null;
    wz.q = '';
  }
  init(ctx.state);
  const steps = [stepIntro, stepRegion, stepServices, stepDone];
  return h(
    'div',
    { class: ['w-wrap', `w-wrap--step${wz.step}`], 'data-testid': `welcome-step-${wz.step + 1}` },
    progress(),
    h('div', { class: 'nt-card w-card' }, steps[wz.step](ctx)),
  );
}
