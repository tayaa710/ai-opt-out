// #/alerts: policy changes, flipped settings, reminders and new services.

import { api } from '../../lib/api.js';
import { h } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { monogram } from '../../shared/monogram.js';
import { formatDate, relativeTime } from '../../shared/format.js';
import { ALERT_KIND_LABELS } from '../../shared/labels.js';
import { pageHeader, emptyState, button, act, serviceHash, linkButton } from '../common.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'policy_change', label: 'Policy changes' },
  { id: 'flip_back', label: 'Settings changed' },
  { id: 'reminder', label: 'Reminders' },
];

const ui = { filter: 'all' };

export function title() {
  return 'Alerts';
}

function matches(alert) {
  if (ui.filter === 'all') return true;
  if (ui.filter === 'unread') return !alert.read;
  return alert.kind === ui.filter;
}

function alertCard(alert, service) {
  const kind = ALERT_KIND_LABELS[alert.kind] ?? { label: 'Alert', icon: 'bell' };
  const sev = alert.severity ?? 'info';
  return h(
    'li',
    { class: ['a-item', !alert.read && 'is-unread', `a-item--${sev}`], 'data-testid': 'alert-item', 'data-key': `alert-${alert.id}` },
    h('span', { class: ['a-item__icon', `d-sev--${sev}`] }, icon(kind.icon)),
    h(
      'div',
      { class: 'a-item__main' },
      h(
        'div',
        { class: 'a-item__meta' },
        h('span', { class: 'a-item__kind' }, kind.label),
        sev !== 'info' && h('span', { class: ['nt-pill', 'nt-pill--plain', sev === 'critical' ? 'nt-pill--bad' : 'nt-pill--warn'] }, sev === 'critical' ? 'Important' : 'Heads-up'),
        h('time', { datetime: alert.createdAt, title: formatDate(alert.createdAt, { dateStyle: 'medium', timeStyle: 'short' }) }, relativeTime(alert.createdAt)),
        !alert.read && h('span', { class: 'a-item__new' }, 'New'),
      ),
      h('h2', { class: 'a-item__title' }, alert.title),
      alert.body && h('p', { class: 'a-item__body' }, alert.body),
      h(
        'div',
        { class: 'nt-btn-row a-item__actions' },
        service &&
          linkButton(`Open ${service.name}`, serviceHash(service.id), {
            variant: 'secondary',
            size: 'sm',
          }),
        !alert.read &&
          button('Mark as read', {
            variant: 'ghost',
            size: 'sm',
            iconName: 'check',
            testid: 'alert-read',
            onClick: (e) => act(e.currentTarget, () => api.markAlert(alert.id, { read: true }), { failure: 'Couldn’t update' }),
          }),
        button('Dismiss', {
          variant: 'ghost',
          size: 'sm',
          iconName: 'x',
          testid: 'alert-dismiss',
          ariaLabel: `Dismiss: ${alert.title}`,
          onClick: (e) => act(e.currentTarget, () => api.markAlert(alert.id, { dismissed: true, read: true }), { success: 'Alert dismissed', failure: 'Couldn’t update' }),
        }),
      ),
    ),
    service && h('span', { class: 'a-item__tile' }, monogram(service, { size: 'sm' })),
  );
}

export function render(ctx) {
  const { state } = ctx;
  const byId = new Map(state.registry.services.map((s) => [s.id, s]));
  const visible = state.alerts.filter((a) => !a.dismissed);
  const unread = visible.filter((a) => !a.read).length;
  const list = visible.filter(matches);

  const header = pageHeader({
    title: 'Alerts',
    subtitle: 'NoTrain checks for policy changes every week, watches settings you’ve switched off, and reminds you to re-check them.',
    actions: [
      button('Mark all as read', {
        variant: 'secondary',
        iconName: 'check',
        testid: 'alerts-read-all',
        disabled: unread === 0,
        onClick: (e) => act(e.currentTarget, () => api.markAllAlertsRead(), { success: 'All alerts marked as read', failure: 'Couldn’t update' }),
      }),
    ],
  });

  const filters = h(
    'div',
    { class: 'nt-segmented a-filters', role: 'group', 'aria-label': 'Filter alerts' },
    FILTERS.map((f) => {
      const n = f.id === 'all' ? visible.length : f.id === 'unread' ? unread : visible.filter((a) => a.kind === f.id).length;
      return h(
        'button',
        {
          type: 'button',
          class: 'nt-segmented__btn',
          'aria-pressed': String(ui.filter === f.id),
          'data-testid': `alerts-filter-${f.id}`,
          onClick: () => {
            ui.filter = f.id;
            ctx.rerender();
          },
        },
        f.label,
        n > 0 && h('span', { class: 'a-filter-count' }, ` ${n}`),
      );
    }),
  );

  let body;
  if (visible.length === 0) {
    body = h(
      'div',
      { class: 'nt-card' },
      emptyState({
        iconName: 'bell',
        title: 'No alerts',
        text: 'You’ll see an alert here if a company changes how it uses your data, or if a setting you switched off gets turned back on.',
        actions: [linkButton('Notification settings', '#/settings', { variant: 'secondary' })],
        testid: 'alerts-empty',
      }),
    );
  } else if (list.length === 0) {
    body = h(
      'div',
      { class: 'nt-card' },
      emptyState({
        iconName: 'inbox',
        title: 'Nothing here',
        text: 'No alerts match this filter.',
        actions: [
          button('Show all', {
            variant: 'secondary',
            onClick: () => {
              ui.filter = 'all';
              ctx.rerender();
            },
          }),
        ],
      }),
    );
  } else {
    body = h('ul', { class: 'a-list', role: 'list', 'data-testid': 'alerts-list' }, list.map((a) => alertCard(a, byId.get(a.serviceId))));
  }

  return [header, visible.length > 0 && filters, body];
}
