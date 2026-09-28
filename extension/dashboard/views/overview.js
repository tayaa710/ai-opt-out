// #/overview: where you stand, what needs attention, quick wins, recent alerts.

import { h } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { monogram } from '../../shared/monogram.js';
import { relativeTime, plural } from '../../shared/format.js';
import { EFFORT_LABELS, CONFIDENCE_LABELS, ALERT_KIND_LABELS } from '../../shared/labels.js';
import { serviceStatus, summarize, compareByUrgency } from '../../lib/status.js';
import { progressRing, summaryCopy, attentionReason, pendingOptOuts, primaryAction } from '../../shared/ui.js';
import { pageHeader, section, emptyState, serviceHash, startOptOut, linkButton, button, runLiveRegion, setRunMessage } from '../common.js';

export function title() {
  return 'Overview';
}

function statTile(label, value, tone, testid) {
  return h(
    'div',
    { class: ['d-stat', tone && `d-stat--${tone}`], 'data-testid': testid },
    h('span', { class: 'd-stat__value' }, String(value)),
    h('span', { class: 'd-stat__label' }, label),
  );
}

function hero(sum) {
  const copy = summaryCopy(sum);
  return h(
    'section',
    { class: 'nt-card d-hero', 'aria-labelledby': 'hero-title', 'data-testid': 'overview-summary' },
    progressRing({
      value: sum.protected,
      total: sum.tracked,
      size: 112,
      stroke: 10,
      tone: sum.attention > 0 ? 'bad' : 'good',
      label: `${sum.protected} of ${sum.tracked} tracked services opted out or not training`,
    }),
    h(
      'div',
      { class: 'd-hero__text' },
      h('h2', { class: 'd-hero__headline', id: 'hero-title' }, copy.headline),
      h('p', { class: 'd-hero__detail' }, copy.detail),
      h(
        'div',
        { class: 'd-stats' },
        statTile('Tracked', sum.tracked, null, 'stat-tracked'),
        statTile('Opted out', sum.protected, 'good', 'stat-protected'),
        statTile('To do', sum.actionNeeded, sum.actionNeeded ? 'warn' : null, 'stat-todo'),
        statTile('Attention', sum.attention, sum.attention ? 'bad' : null, 'stat-attention'),
      ),
    ),
  );
}

function attentionList(items, state) {
  const { userState, settings } = state;
  return h(
    'ul',
    { class: 'nt-card nt-list', role: 'list' },
    items.map((service) => {
      const action = primaryAction(service, userState, settings.region);
      const reason = attentionReason(service, userState, action.status);
      return h(
        'li',
        { class: 'd-task', 'data-key': `attention-${service.id}` },
        monogram(service),
        h(
          'div',
          { class: 'd-task__main' },
          h('a', { class: 'd-task__title', href: serviceHash(service.id) }, service.name),
          h('span', { class: 'd-task__meta' }, h('span', { class: 'nt-pill nt-pill--bad' }, reason)),
        ),
        linkButton(action.status.pendingPolicyChange ? 'Review change' : 'Fix it', serviceHash(service.id), { variant: 'primary', size: 'sm' }),
      );
    }),
  );
}

function taskRow(service, optOut, { auto }) {
  const effort = EFFORT_LABELS[optOut.effort]?.label;
  const conf = optOut.automation ? CONFIDENCE_LABELS[optOut.automation.confidence] : null;
  const live = runLiveRegion(service.id, optOut.id, 'd-task__live');
  const actionBtn = auto
    ? button('Opt out for me', {
        variant: 'primary',
        size: 'sm',
        iconName: 'zap',
        testid: 'quickwin-run',
        ariaLabel: `Opt out of ${service.name} for me`,
        key: `run-${service.id}-${optOut.id}`,
        onClick: (e) => {
          startOptOut(service, optOut, 'auto', {
            button: e.currentTarget,
            onStatus: (s) => {
              setRunMessage(service.id, optOut.id, s);
              live.textContent = s.message;
            },
          });
        },
      })
    : linkButton(optOut.type === 'email' ? 'Write letter' : 'Show me how', optOut.type === 'email'
        ? `#/letters?service=${encodeURIComponent(service.id)}&optOut=${encodeURIComponent(optOut.id)}`
        : serviceHash(service.id, `guide=${encodeURIComponent(optOut.id)}`), { variant: 'secondary', size: 'sm' });
  return h(
    'li',
    { class: 'd-task', 'data-key': `task-${service.id}-${optOut.id}` },
    monogram(service),
    h(
      'div',
      { class: 'd-task__main' },
      h('a', { class: 'd-task__title', href: serviceHash(service.id) }, service.name),
      h('span', { class: 'd-task__desc' }, optOut.title),
      h(
        'span',
        { class: 'd-task__meta' },
        effort && h('span', { class: 'nt-chip d-chip-sm' }, icon('clock'), effort),
        conf && h('span', { class: ['nt-pill', `nt-pill--${conf.tone}`] }, conf.label),
      ),
      live,
    ),
    actionBtn,
  );
}

function alertsPreview(alerts, services) {
  const byId = new Map(services.map((s) => [s.id, s]));
  return h(
    'ul',
    { class: 'nt-card nt-list', role: 'list' },
    alerts.map((a) => {
      const kind = ALERT_KIND_LABELS[a.kind] ?? { label: 'Alert', icon: 'bell' };
      const svc = byId.get(a.serviceId);
      return h(
        'li',
        { class: ['d-alert-mini', !a.read && 'is-unread'] },
        h('span', { class: ['d-alert-mini__icon', `d-sev--${a.severity ?? 'info'}`] }, icon(kind.icon)),
        h(
          'div',
          { class: 'd-alert-mini__main' },
          h('a', { class: 'd-alert-mini__title', href: svc ? serviceHash(svc.id) : '#/alerts' }, a.title),
          h('span', { class: 'd-alert-mini__meta' }, [svc?.name, relativeTime(a.createdAt)].filter(Boolean).join(' · ')),
        ),
        !a.read && h('span', { class: 'd-unread-dot', 'aria-label': 'Unread' }),
      );
    }),
  );
}

export function render({ state }) {
  const { registry, userState, settings, alerts } = state;
  const region = settings.region;
  const services = registry.services;
  const tracked = services.filter((s) => userState.services?.[s.id]?.tracked).sort((a, b) => compareByUrgency(a, b, userState, region));
  const sum = summarize(services, userState, region);

  const header = pageHeader({
    title: 'Overview',
    subtitle: 'Where you stand with the services you use.',
    actions: [linkButton('Add services', '#/services', { variant: 'secondary', iconName: 'plus' })],
  });

  if (tracked.length === 0) {
    return [
      header,
      h(
        'div',
        { class: 'nt-card' },
        emptyState({
          iconName: 'shield',
          title: 'You’re not tracking any services yet',
          text: 'Choose the services you use. NoTrain will show which ones train AI on your data and how to opt out.',
          actions: [linkButton('Choose services', '#/services', { variant: 'primary' }), linkButton('Run setup again', '#/welcome')],
          testid: 'overview-empty',
        }),
      ),
    ];
  }

  const attention = [];
  const quickWins = [];
  const todo = [];
  for (const service of tracked) {
    const st = serviceStatus(service, userState, region);
    if (st.code === 'needs_attention') {
      attention.push(service);
      continue;
    }
    if (st.code !== 'action_needed') continue;
    for (const o of pendingOptOuts(service, userState, st)) {
      if (o.automation) quickWins.push([service, o]);
      else todo.push([service, o]);
    }
  }

  const recent = alerts.filter((a) => !a.dismissed).slice(0, 4);
  const blocks = [header, hero(sum)];

  if (attention.length) {
    blocks.push(
      section(
        { title: 'Needs your attention', id: 'attention', description: 'A policy changed or a setting was switched back on.' },
        attentionList(attention, state),
      ),
    );
  }

  if (quickWins.length) {
    blocks.push(
      section(
        {
          title: 'Quick wins',
          id: 'quick-wins',
          description: 'NoTrain can switch these off for you. It opens the page, flips the setting and checks it worked.',
        },
        h('ul', { class: 'nt-card nt-list', role: 'list', 'data-testid': 'quick-wins' }, quickWins.map(([s, o]) => taskRow(s, o, { auto: true }))),
      ),
    );
  }

  if (todo.length) {
    blocks.push(
      section(
        { title: 'Still to do', id: 'todo', description: 'These take a few steps on the company’s site. NoTrain walks you through them.' },
        h('ul', { class: 'nt-card nt-list', role: 'list', 'data-testid': 'todo-list' }, todo.map(([s, o]) => taskRow(s, o, { auto: false }))),
      ),
    );
  }

  if (!attention.length && !quickWins.length && !todo.length) {
    blocks.push(
      h(
        'div',
        { class: 'nt-callout nt-callout--good', 'data-testid': 'all-done' },
        icon('shieldCheck'),
        h(
          'div',
          { class: 'nt-callout__body' },
          h('p', { class: 'nt-callout__title' }, 'Nothing left to do'),
          h(
            'p',
            null,
            `NoTrain checks for policy changes every week and will remind you to re-check your settings every ${settings.reminderIntervalDays ?? 90} days.`,
          ),
        ),
      ),
    );
  }

  blocks.push(
    section(
      {
        title: 'Recent alerts',
        id: 'recent-alerts',
        actions: recent.length ? [h('a', { class: 'nt-link', href: '#/alerts' }, 'See all', icon('arrowRight', { size: 14 }))] : null,
      },
      recent.length
        ? alertsPreview(recent, services)
        : h(
            'div',
            { class: 'nt-card' },
            emptyState({
              iconName: 'bell',
              title: 'No alerts',
              text: 'You’ll hear from NoTrain here if a company changes how it uses your data.',
            }),
          ),
    ),
  );

  const untracked = services.length - tracked.length;
  if (untracked > 0) {
    blocks.push(
      h(
        'p',
        { class: 'd-footnote' },
        `You’re tracking ${plural(tracked.length, 'service')} of ${services.length}. `,
        h('a', { href: '#/services' }, 'Browse the rest'),
      ),
    );
  }
  return blocks;
}
