// #/services: every registry service, with search, filters and track toggles.

import { api } from '../../lib/api.js';
import { serviceStatus, compareByUrgency } from '../../lib/status.js';
import { h, mount, extLink } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { monogram } from '../../shared/monogram.js';
import { confirmDialog } from '../../shared/dialog.js';
import { toast, announce } from '../../shared/toast.js';
import { plural } from '../../shared/format.js';
import { CATEGORY_ORDER, categoryLabel, TRAINS_LABELS, DEFAULT_LABELS } from '../../shared/labels.js';
import { statusPill } from '../../shared/ui.js';
import {
  pageHeader,
  emptyState,
  serviceHash,
  button,
  suggestServiceUrl,
  detectAccountsFlow,
} from '../common.js';

const ui = { q: '', category: 'all', status: 'all' };

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'tracked', label: 'Tracked' },
  { id: 'todo', label: 'To do' },
  { id: 'done', label: 'Done' },
  { id: 'untracked', label: 'Not tracked' },
];

export function title() {
  return 'Services';
}

function normalise(str) {
  return String(str ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

export function matchesQuery(service, q) {
  if (!q) return true;
  const needle = normalise(q.trim());
  const hay = normalise(
    [service.name, service.company, categoryLabel(service.category), ...(service.domains ?? [])].join(' '),
  );
  return needle.split(/\s+/).every((part) => hay.includes(part));
}

function matchesStatus(code, filter) {
  switch (filter) {
    case 'tracked':
      return code !== 'not_tracked';
    case 'todo':
      return code === 'action_needed' || code === 'needs_attention';
    case 'done':
      return code === 'protected' || code === 'safe_by_default';
    case 'untracked':
      return code === 'not_tracked';
    default:
      return true;
  }
}

async function setTracked(service, tracked, input) {
  input.disabled = true;
  try {
    await api.trackServices([service.id], tracked, 'manual');
    announce(tracked ? `Tracking ${service.name}` : `Stopped tracking ${service.name}`);
    if (!tracked) {
      toast(`Stopped tracking ${service.name}`, {
        tone: 'info',
        action: {
          label: 'Undo',
          onClick: () => api.trackServices([service.id], true, 'manual').catch(() => {}),
        },
      });
    }
  } catch (err) {
    input.checked = !tracked;
    toast(`Couldn’t update ${service.name}: ${err.message}`, { tone: 'bad' });
  } finally {
    if (input.isConnected) input.disabled = false;
  }
}

function factChips(service) {
  const t = service.training ?? {};
  const trains = TRAINS_LABELS[t.trainsOnUserData] ?? TRAINS_LABELS.unknown;
  const def = DEFAULT_LABELS[t.defaultState];
  const chips = [];
  if (t.trainsOnUserData === 'no')
    chips.push(h('span', { class: 'nt-pill nt-pill--good nt-pill--plain' }, 'Doesn’t train on your data'));
  else if (t.trainsOnUserData === 'unknown')
    chips.push(h('span', { class: 'nt-pill nt-pill--neutral nt-pill--plain' }, 'Training unclear'));
  else {
    chips.push(
      h(
        'span',
        { class: `nt-pill nt-pill--${trains.tone} nt-pill--plain` },
        t.trainsOnUserData === 'yes' ? 'Trains on your data' : 'Trains in some cases',
      ),
    );
    if (def && t.defaultState !== 'not_applicable')
      chips.push(
        h(
          'span',
          { class: `nt-pill nt-pill--${def.tone === 'bad' ? 'warn' : def.tone} nt-pill--plain` },
          def.label,
        ),
      );
  }
  return chips;
}

function serviceRow(service, state) {
  const { userState, settings } = state;
  const status = serviceStatus(service, userState, settings.region);
  const tracked = status.code !== 'not_tracked';
  const switchId = `track-${service.id}`;
  return h(
    'li',
    { class: 'd-svc', 'data-service': service.id, 'data-testid': 'service-row' },
    monogram(service, { size: 'lg' }),
    h(
      'div',
      { class: 'd-svc__main' },
      h(
        'div',
        { class: 'd-svc__head' },
        h('a', { class: 'd-svc__name', href: serviceHash(service.id) }, service.name),
        tracked && statusPill(status, { 'data-testid': 'service-status' }),
      ),
      h('p', { class: 'd-svc__company' }, `${service.company} · ${categoryLabel(service.category)}`),
      h('p', { class: 'd-svc__summary' }, service.summary),
      h('div', { class: 'd-svc__facts' }, factChips(service)),
    ),
    h(
      'div',
      { class: 'd-svc__track' },
      h(
        'label',
        { class: 'nt-switch', for: switchId },
        h('input', {
          type: 'checkbox',
          role: 'switch',
          class: 'nt-switch__input',
          id: switchId,
          checked: tracked,
          'aria-label': `Track ${service.name}`,
          'data-testid': 'track-toggle',
          onChange: (e) => setTracked(service, e.currentTarget.checked, e.currentTarget),
        }),
        h('span', { class: 'nt-switch__track', 'aria-hidden': 'true' }),
        h('span', { class: 'd-svc__track-label', 'aria-hidden': 'true' }, 'Track'),
      ),
    ),
  );
}

function filtered(state) {
  const { registry, userState, settings } = state;
  return registry.services
    .filter((s) => ui.category === 'all' || s.category === ui.category)
    .filter((s) => matchesQuery(s, ui.q))
    .filter((s) => matchesStatus(serviceStatus(s, userState, settings.region).code, ui.status))
    .sort((a, b) => compareByUrgency(a, b, userState, settings.region));
}

function results(state) {
  const list = filtered(state);
  const total = state.registry.services.length;
  const countText =
    list.length === total ? plural(total, 'service') : `${list.length} of ${plural(total, 'service')}`;
  const count = h(
    'p',
    { class: 'd-results-count', role: 'status', 'aria-live': 'polite', 'data-testid': 'results-count' },
    countText,
  );
  if (list.length === 0) {
    const hasFilters = ui.q || ui.category !== 'all' || ui.status !== 'all';
    return [
      count,
      h(
        'div',
        { class: 'nt-card' },
        emptyState({
          iconName: 'search',
          title: ui.q ? `No services match “${ui.q}”` : 'No services here',
          text: 'Try a different search or clear the filters. Missing a service? Suggest it and the community can add it.',
          actions: [
            hasFilters &&
              button('Clear filters', {
                variant: 'secondary',
                onClick: () => {
                  ui.q = '';
                  ui.category = 'all';
                  ui.status = 'all';
                  rerenderSelf();
                  document.getElementById('svc-search')?.focus();
                },
              }),
            extLink(suggestServiceUrl(ui.q), 'Suggest a service', { class: 'nt-btn nt-btn--ghost' }),
          ],
          testid: 'services-empty',
        }),
      ),
    ];
  }
  const isTracked = (s) => Boolean(state.userState.services?.[s.id]?.tracked);
  const tracked = list.filter(isTracked);
  const rest = list.filter((s) => !isTracked(s));
  if (tracked.length && rest.length) {
    // Two groups: what you track (by urgency), then everything else (A–Z).
    const group = (id, label, items) =>
      h(
        'section',
        { class: 'd-svc-group', 'aria-labelledby': id },
        h(
          'h2',
          { class: 'd-svc-group__title', id },
          label,
          h('span', { class: 'd-svc-group__count' }, String(items.length)),
        ),
        h(
          'ul',
          { class: 'nt-card nt-list d-svc-list', role: 'list', 'data-testid': 'services-list' },
          items.map((s) => serviceRow(s, state)),
        ),
      );
    return [count, group('grp-tracked', 'Tracking', tracked), group('grp-more', 'More services', rest)];
  }
  return [
    count,
    h(
      'ul',
      { class: 'nt-card nt-list d-svc-list', role: 'list', 'data-testid': 'services-list' },
      list.map((s) => serviceRow(s, state)),
    ),
  ];
}

let rerenderSelf = () => {};

function toolbar(state) {
  const categories = CATEGORY_ORDER.filter((c) => state.registry.services.some((s) => s.category === c));
  return h(
    'div',
    { class: 'd-toolbar', role: 'search', 'aria-label': 'Filter services' },
    h(
      'label',
      { class: 'nt-search d-toolbar__search' },
      h('span', { class: 'nt-visually-hidden' }, 'Search services'),
      icon('search'),
      h('input', {
        class: 'nt-input',
        type: 'search',
        id: 'svc-search',
        placeholder: 'Search by name, company or website',
        value: ui.q,
        autocomplete: 'off',
        spellcheck: 'false',
        'data-testid': 'services-search',
        onInput: (e) => {
          ui.q = e.currentTarget.value;
          rerenderSelf();
        },
      }),
    ),
    h(
      'span',
      { class: 'nt-select-wrap d-toolbar__category' },
      h('label', { class: 'nt-visually-hidden', for: 'svc-category' }, 'Category'),
      h(
        'select',
        {
          class: 'nt-select',
          id: 'svc-category',
          'data-testid': 'services-category',
          onChange: (e) => {
            ui.category = e.currentTarget.value;
            rerenderSelf();
          },
        },
        h('option', { value: 'all', selected: ui.category === 'all' }, 'All categories'),
        categories.map((c) => h('option', { value: c, selected: ui.category === c }, categoryLabel(c))),
      ),
    ),
    h(
      'div',
      { class: 'nt-segmented d-toolbar__status', role: 'group', 'aria-label': 'Show' },
      STATUS_FILTERS.map((f) =>
        h(
          'button',
          {
            type: 'button',
            class: 'nt-segmented__btn',
            'aria-pressed': String(ui.status === f.id),
            'data-testid': `status-filter-${f.id}`,
            onClick: () => {
              ui.status = f.id;
              rerenderSelf();
            },
          },
          f.label,
        ),
      ),
    ),
  );
}

function detectButton(state) {
  const services = state.registry.services;
  const detectable = services.filter((s) => s.detection?.cookies?.length);
  if (!detectable.length) return null;
  return button('Detect my accounts', {
    variant: 'secondary',
    iconName: 'scan',
    testid: 'services-detect',
    onClick: () => {
      confirmDialog({
        title: 'Find the services you’re signed into?',
        body: h(
          'div',
          { class: 'd-dialog-copy' },
          h(
            'p',
            null,
            `NoTrain can check ${plural(detectable.length, 'service')} for a sign-in cookie. It only checks whether the cookie exists. It never reads it, and nothing leaves your device.`,
          ),
          h(
            'p',
            null,
            'Your browser will ask for permission first. NoTrain gives the permission back as soon as it’s done.',
          ),
        ),
        confirmLabel: 'Continue',
        iconName: 'scan',
        onConfirm: () => {
          detectAccountsFlow(services);
        },
      });
    },
  });
}

export function render(ctx) {
  const { state } = ctx;
  const container = h('div', { class: 'd-results', 'data-key': 'services-results' });
  rerenderSelf = () => {
    const toolbarEl = document.querySelector('.d-toolbar');
    if (toolbarEl) {
      // Update pressed state in place (keeps focus on the button pressed).
      toolbarEl
        .querySelectorAll('.nt-segmented__btn')
        .forEach((b, i) => b.setAttribute('aria-pressed', String(STATUS_FILTERS[i].id === ui.status)));
      const sel = toolbarEl.querySelector('#svc-category');
      if (sel && sel.value !== ui.category) sel.value = ui.category;
      const q = toolbarEl.querySelector('#svc-search');
      if (q && q.value !== ui.q) q.value = ui.q;
    }
    mount(container, results(ctx.store.state ?? state));
  };
  mount(container, results(state));
  const trackedCount = state.registry.services.filter(
    (s) => state.userState.services?.[s.id]?.tracked,
  ).length;
  return [
    pageHeader({
      title: 'Services',
      subtitle: `Track the services you use. You’re tracking ${trackedCount} of ${state.registry.services.length}.`,
      actions: [detectButton(state)],
    }),
    toolbar(state),
    container,
  ];
}
