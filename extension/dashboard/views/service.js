// #/service/<id>: plain-language facts about one service and every way to opt out.
// Query: ?run=<optOutId>&mode=auto (from the popup, needs a click to grant access)
//        ?guide=<optOutId> (expand that opt-out's steps)

import { api } from '../../lib/api.js';
import { OPT_OUT_STATUS } from '../../lib/constants.js';
import { serviceStatus, optOutStatus, applicableOptOuts } from '../../lib/status.js';
import { appliesToRegion, regionLabel, hasObjectionRight, REGIONS } from '../../lib/region.js';
import { h, extLink } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { monogram } from '../../shared/monogram.js';
import { toast } from '../../shared/toast.js';
import { formatDate, formatPartialDate, relativeTime, hostOf, describeOrigin } from '../../shared/format.js';
import {
  categoryLabel,
  dataTypeLabel,
  TRAINS_LABELS,
  DEFAULT_LABELS,
  EFFORT_LABELS,
  CONFIDENCE_LABELS,
  OPT_OUT_TYPE_LABELS,
  OPT_OUT_STATUS_LABELS,
  METHOD_LABELS,
  OUTCOME_MESSAGES,
} from '../../shared/labels.js';
import { statusPill } from '../../shared/ui.js';
import {
  emptyState,
  serviceHash,
  button,
  linkButton,
  startOptOut,
  act,
  runLiveRegion,
  setRunMessage,
  reportErrorUrl,
} from '../common.js';

const ACTIONABLE = new Set(['toggle', 'form', 'email']);
const TYPE_ICONS = { toggle: 'sliders', form: 'letter', email: 'mail', 'account-deletion': 'trash', none: 'minusCircle' };

/** Opt-outs whose steps are expanded (per service id). */
const openGuides = new Map();
let handledQuery = '';

function guidesFor(serviceId) {
  if (!openGuides.has(serviceId)) openGuides.set(serviceId, new Set());
  return openGuides.get(serviceId);
}

export function title({ state, route }) {
  const s = state.registry.services.find((x) => x.id === route.param);
  return s ? s.name : 'Service';
}

function regionList(regions) {
  if (!regions?.length) return '';
  if (regions.includes('ALL')) return 'Everywhere';
  return regions.map((r) => REGIONS.find((x) => x.code === r)?.label ?? r).join(', ');
}

function doneStatusFor(optOut) {
  return optOut.type === 'toggle' ? OPT_OUT_STATUS.done : OPT_OUT_STATUS.sent;
}

function markDoneLabel(optOut) {
  if (optOut.type === 'email') return 'I’ve sent it';
  if (optOut.type === 'form') return 'I’ve submitted it';
  return 'Mark as done';
}

function letterHash(service, optOut) {
  const q = new URLSearchParams({ service: service.id });
  if (optOut) q.set('optOut', optOut.id);
  return `#/letters?${q}`;
}

/* ---------- Header + facts ---------- */

function header(service, status, state, ctx) {
  const tracked = status.code !== 'not_tracked';
  return h(
    'header',
    { class: 'd-detail-head' },
    h('a', { class: 'nt-link nt-link--muted d-back', href: '#/services' }, icon('arrowLeft', { size: 16 }), 'All services'),
    h(
      'div',
      { class: 'd-detail-head__row' },
      monogram(service, { size: 'xl' }),
      h(
        'div',
        { class: 'd-detail-head__text' },
        h('h1', { class: 'd-page-title', tabindex: '-1', 'data-page-title': '' }, service.name),
        h(
          'p',
          { class: 'd-detail-head__meta' },
          `${service.company} · ${categoryLabel(service.category)}`,
          service.domains?.[0] ? ` · ${service.domains[0]}` : '',
        ),
      ),
      h(
        'div',
        { class: 'd-detail-head__aside' },
        tracked && statusPill(status, { 'data-testid': 'detail-status' }),
        h(
          'label',
          { class: 'nt-switch d-detail-track' },
          h('input', {
            type: 'checkbox',
            role: 'switch',
            class: 'nt-switch__input',
            id: 'detail-track',
            checked: tracked,
            'data-testid': 'detail-track',
            onChange: async (e) => {
              const input = e.currentTarget;
              const next = input.checked;
              input.disabled = true;
              try {
                await api.trackServices([service.id], next, 'manual');
                toast(next ? `Tracking ${service.name}` : `Stopped tracking ${service.name}`, { tone: next ? 'good' : 'info' });
              } catch (err) {
                input.checked = !next;
                toast(`Couldn’t update: ${err.message}`, { tone: 'bad' });
              } finally {
                if (input.isConnected) input.disabled = false;
              }
            },
          }),
          h('span', { class: 'nt-switch__track', 'aria-hidden': 'true' }),
          h('span', { class: 'nt-switch__label' }, tracked ? 'Tracking' : 'Track'),
        ),
      ),
    ),
    h('p', { class: 'd-detail-summary' }, service.summary),
  );
}

function facts(service) {
  const t = service.training ?? {};
  const trains = TRAINS_LABELS[t.trainsOnUserData] ?? TRAINS_LABELS.unknown;
  const def = DEFAULT_LABELS[t.defaultState] ?? { label: 'Unknown', tone: 'neutral' };
  const fact = (label, value, tone, iconName, testid) =>
    h(
      'div',
      { class: 'nt-fact', 'data-testid': testid },
      h('dt', { class: 'nt-fact__label' }, label),
      h('dd', { class: ['nt-fact__value', `nt-tone-${tone}`] }, iconName && icon(iconName), value),
    );
  return h(
    'dl',
    { class: 'nt-facts d-facts', 'aria-label': 'Key facts' },
    fact('Trains AI on your data?', trains.label, trains.tone, trains.tone === 'good' ? 'checkCircle' : trains.tone === 'bad' ? 'alertCircle' : 'info', 'fact-trains'),
    fact('If you do nothing', def.label, def.tone, null, 'fact-default'),
    fact('Since', t.since ? formatPartialDate(t.since) : 'Not stated', 'neutral', null, 'fact-since'),
    fact(
      'Removes data already used?',
      t.retroactiveRemoval ? 'Yes' : 'No',
      t.retroactiveRemoval ? 'good' : 'neutral',
      null,
      'fact-retro',
    ),
  );
}

function notes(service, region) {
  const t = service.training ?? {};
  const out = [];
  const note = t.regionNotes?.[region] ?? (region === 'US-CA' ? t.regionNotes?.US : null);
  if (note) {
    out.push(
      h(
        'div',
        { class: 'nt-callout', 'data-testid': 'region-note' },
        icon('globe'),
        h('div', { class: 'nt-callout__body' }, h('p', { class: 'nt-callout__title' }, `For ${regionLabel(region)}`), h('p', null, note)),
      ),
    );
  }
  if (t.trainsOnUserData !== 'no' && t.retroactiveRemoval === false) {
    out.push(
      h(
        'div',
        { class: 'nt-callout nt-callout--neutral', 'data-testid': 'future-only-note' },
        icon('clock'),
        h(
          'div',
          { class: 'nt-callout__body' },
          h('p', { class: 'nt-callout__title' }, 'Opting out only affects the future'),
          h('p', null, 'Anything already used to train a model can’t be taken back out of it. Opting out stops new data being used from now on.'),
        ),
      ),
    );
  }
  return out;
}

function policyBanner(service, userState) {
  const st = userState.services?.[service.id];
  const known = st?.knownPolicyVersion ?? service.policyVersion;
  const changes = (service.changelog ?? []).filter((c) => c.version > known).sort((a, b) => b.version - a.version);
  const critical = changes.some((c) => c.severity === 'critical');
  return h(
    'div',
    { class: ['nt-callout', critical ? 'nt-callout--bad' : 'nt-callout--warn', 'd-policy-banner'], role: 'region', 'aria-label': 'Policy change', 'data-testid': 'policy-banner' },
    icon('alert'),
    h(
      'div',
      { class: 'nt-callout__body' },
      h('p', { class: 'nt-callout__title' }, `${service.company} changed how ${service.name} uses your data`),
      h(
        'ul',
        { class: 'd-policy-banner__list' },
        changes.map((c) => h('li', null, h('strong', null, formatDate(c.date)), ` · ${c.summary}`)),
      ),
      h('p', { class: 'nt-subtle' }, 'Check the opt-outs below are still set the way you want.'),
      h(
        'div',
        { class: 'nt-btn-row', style: { marginTop: '6px' } },
        button('Got it', {
          variant: 'secondary',
          size: 'sm',
          iconName: 'check',
          testid: 'ack-policy',
          onClick: (e) => act(e.currentTarget, () => api.acknowledgePolicy(service.id), { success: 'Marked as reviewed', failure: 'Couldn’t save' }),
        }),
      ),
    ),
  );
}

/* ---------- Opt-out cards ---------- */

function statusLine(service, optOut, userState) {
  const rec = userState.services?.[service.id]?.optOuts?.[optOut.id];
  const status = rec?.status ?? OPT_OUT_STATUS.notStarted;
  const meta = OPT_OUT_STATUS_LABELS[status] ?? OPT_OUT_STATUS_LABELS.not_started;
  if (status === OPT_OUT_STATUS.notStarted) return null;
  const when = rec?.verifiedAt ?? rec?.updatedAt;
  const how = rec?.method ? METHOD_LABELS[rec.method] : null;
  const detail = [how, when && relativeTime(when)].filter(Boolean).join(', ');
  return h(
    'span',
    { class: ['nt-pill', `nt-pill--${meta.tone}`], 'data-testid': 'optout-status' },
    meta.label,
    detail ? h('span', { class: 'd-pill-detail' }, ` · ${detail}`) : null,
  );
}

function optOutCard(service, optOut, ctx, { applicable }) {
  const { state } = ctx;
  const { userState, settings } = state;
  const region = settings.region;
  const rec = userState.services?.[service.id]?.optOuts?.[optOut.id];
  const status = optOutStatus(userState, service.id, optOut.id);
  const isDone = status === OPT_OUT_STATUS.done || status === OPT_OUT_STATUS.sent;
  const attention = status === OPT_OUT_STATUS.needsAttention;
  const guides = guidesFor(service.id);
  const guideOpen = guides.has(optOut.id);
  const auto = optOut.automation;
  const conf = auto ? CONFIDENCE_LABELS[auto.confidence] : null;
  const effort = EFFORT_LABELS[optOut.effort];
  const liveMsg = runLiveRegion(service.id, optOut.id);
  const rerender = ctx.rerender;

  const onStatus = (s) => {
    setRunMessage(service.id, optOut.id, s);
    const el = document.querySelector(`[data-key="live-${service.id}-${optOut.id}"]`);
    if (el) {
      el.textContent = s.message;
      el.className = `d-live is-${s.phase}`;
    }
    if (s.phase === 'fallback' || s.phase === 'denied') {
      guides.add(optOut.id);
      rerender();
    }
  };

  const actions = [];
  if (applicable) {
    if (!isDone) {
      if (auto) {
        actions.push(
          button(attention ? 'Fix it for me' : 'Opt out for me', {
            variant: 'primary',
            iconName: 'zap',
            testid: 'run-auto',
            key: `auto-${optOut.id}`,
            onClick: (e) => startOptOut(service, optOut, 'auto', { button: e.currentTarget, onStatus }),
          }),
        );
      }
      if (optOut.url) {
        actions.push(
          button('Guide me', {
            variant: auto ? 'secondary' : 'primary',
            iconName: 'listChecks',
            testid: 'run-guided',
            key: `guide-${optOut.id}`,
            onClick: (e) => {
              guides.add(optOut.id);
              startOptOut(service, optOut, 'guided', { button: e.currentTarget, onStatus }).then(() => {
                rerender();
                document.querySelector(`[data-optout="${CSS.escape(optOut.id)}"] .d-steps`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              });
            },
          }),
        );
      }
      if (optOut.type === 'email' || optOut.type === 'form' || hasObjectionRight(region)) {
        actions.push(
          linkButton(optOut.type === 'email' ? 'Write the letter' : 'Write a letter', letterHash(service, optOut), {
            variant: optOut.type === 'email' && !optOut.url ? 'primary' : 'ghost',
            iconName: 'letter',
            testid: 'write-letter',
          }),
        );
      }
      actions.push(
        button(markDoneLabel(optOut), {
          variant: 'ghost',
          iconName: 'check',
          testid: 'mark-done',
          key: `done-${optOut.id}`,
          onClick: (e) =>
            act(
              e.currentTarget,
              () =>
                optOut.type === 'email'
                  ? api.recordLetter(service.id, optOut.id)
                  : api.setOptOutStatus(service.id, optOut.id, doneStatusFor(optOut), 'manual'),
              { success: 'Marked as done', failure: 'Couldn’t save' },
            ),
        }),
      );
    } else {
      if (auto && status === OPT_OUT_STATUS.done) {
        actions.push(
          button('Check again', {
            variant: 'secondary',
            iconName: 'refresh',
            testid: 'run-verify',
            key: `verify-${optOut.id}`,
            onClick: (e) => startOptOut(service, optOut, 'verify', { button: e.currentTarget, onStatus }),
          }),
        );
      }
      actions.push(
        button('Undo', {
          variant: 'ghost',
          iconName: 'undo',
          testid: 'mark-undo',
          key: `undo-${optOut.id}`,
          onClick: (e) =>
            act(e.currentTarget, () => api.setOptOutStatus(service.id, optOut.id, OPT_OUT_STATUS.notStarted, 'manual'), {
              success: 'Marked as not done',
              failure: 'Couldn’t save',
            }),
        }),
      );
    }
  }

  const outcome = rec?.lastOutcome && !isDone && rec.lastOutcome !== 'success' && rec.lastOutcome !== 'already' ? OUTCOME_MESSAGES[rec.lastOutcome] : null;

  const steps = h(
    'details',
    {
      class: 'nt-disclosure d-steps',
      open: guideOpen,
      'data-testid': 'steps',
      onToggle: (e) => {
        if (e.currentTarget.open) guides.add(optOut.id);
        else guides.delete(optOut.id);
      },
    },
    h('summary', { 'data-key': `steps-${optOut.id}` }, guideOpen ? 'Steps' : 'Show the steps'),
    h(
      'div',
      { class: 'd-steps__body' },
      h('ol', { class: 'nt-steps' }, (optOut.steps ?? []).map((step) => h('li', null, h('span', null, step)))),
      optOut.url && h('p', { class: 'd-steps__link' }, extLink(optOut.url, `Open ${hostOf(optOut.url)}`, { class: 'nt-link' }), icon('external', { size: 13 })),
      applicable &&
        !isDone &&
        h(
          'div',
          { class: 'nt-btn-row' },
          button(markDoneLabel(optOut), {
            variant: 'primary',
            size: 'sm',
            iconName: 'check',
            testid: 'steps-mark-done',
            onClick: (e) =>
              act(
                e.currentTarget,
                () =>
                  optOut.type === 'email'
                    ? api.recordLetter(service.id, optOut.id)
                    : api.setOptOutStatus(service.id, optOut.id, doneStatusFor(optOut), guideOpen ? 'guided' : 'manual'),
                { success: 'Nice. Marked as done.', failure: 'Couldn’t save' },
              ),
          }),
        ),
    ),
  );

  return h(
    'article',
    {
      class: ['nt-card', 'd-optout', isDone && 'is-done', attention && 'is-attention', !applicable && 'is-other'],
      'data-optout': optOut.id,
      'data-testid': 'optout-card',
      'aria-labelledby': `oo-${optOut.id}-title`,
    },
    h(
      'div',
      { class: 'd-optout__top' },
      h(
        'div',
        { class: 'd-optout__kind' },
        h('span', { class: 'd-optout__type-icon' }, icon(TYPE_ICONS[optOut.type] ?? 'circle')),
        h('span', null, OPT_OUT_TYPE_LABELS[optOut.type] ?? 'Opt-out'),
        effort && h('span', { class: 'd-dot-sep', 'aria-hidden': 'true' }, '·'),
        effort && h('span', null, effort.long),
        applicable ? null : h('span', { class: 'd-dot-sep', 'aria-hidden': 'true' }, '·'),
        applicable ? null : h('span', null, regionList(optOut.regions)),
      ),
      applicable && statusLine(service, optOut, userState),
    ),
    h('h3', { class: 'd-optout__title', id: `oo-${optOut.id}-title` }, optOut.title),
    optOut.description && h('p', { class: 'd-optout__desc' }, optOut.description),
    h('div', { class: 'd-optout__effect' }, h('span', { class: 'd-optout__effect-label' }, 'What this does'), h('p', null, optOut.effect)),
    optOut.perDevice &&
      h('p', { class: 'd-optout__note' }, icon('info', { size: 14 }), 'This setting is per device or app. Repeat it everywhere you use the service.'),
    attention &&
      h(
        'div',
        { class: 'nt-callout nt-callout--bad' },
        icon('refresh'),
        h('div', { class: 'nt-callout__body' }, h('p', { class: 'nt-callout__title' }, 'This setting was turned back on'), h('p', null, 'It may have been reset by an update or a new device. Switch it off again.')),
      ),
    outcome && h('p', { class: 'd-optout__outcome', 'data-testid': 'last-outcome' }, icon('info', { size: 14 }), `Last try: ${outcome}`),
    actions.length > 0 &&
      h(
        'div',
        { class: 'd-optout__actions' },
        h('div', { class: 'nt-btn-row' }, actions),
        conf &&
          !isDone &&
          h(
            'span',
            { class: 'd-optout__conf', title: conf.hint },
            h('span', { class: ['nt-pill', `nt-pill--${conf.tone}`] }, conf.label),
            h('span', { class: 'nt-visually-hidden' }, conf.hint),
          ),
      ),
    liveMsg,
    auto && applicable && !isDone &&
      h(
        'p',
        { class: 'd-optout__perm' },
        icon('lock', { size: 13 }),
        `“Opt out for me” asks for access to ${auto.hostPermissions.map(describeOrigin).join(', ')} only. You can revoke it in Settings.`,
      ),
    steps,
  );
}

function runPrompt(service, optOut, ctx) {
  const onStatus = (s) => {
    setRunMessage(service.id, optOut.id, s);
    if (s.phase === 'fallback' || s.phase === 'denied') guidesFor(service.id).add(optOut.id);
  };
  const hosts = optOut.automation.hostPermissions.map(describeOrigin).join(', ');
  return h(
    'section',
    { class: 'nt-card d-run-prompt', 'aria-labelledby': 'run-prompt-title', 'data-testid': 'run-prompt' },
    h('div', { class: 'd-run-prompt__icon' }, icon('zap')),
    h(
      'div',
      { class: 'd-run-prompt__body' },
      h('h2', { class: 'd-run-prompt__title', id: 'run-prompt-title' }, `Ready to opt out of ${service.name}?`),
      h(
        'p',
        null,
        `Your browser will ask to let NoTrain access ${hosts}. NoTrain then opens the setting in a new tab and switches it off while you watch. You can stop it at any time.`,
      ),
      h(
        'div',
        { class: 'nt-btn-row' },
        button('Allow and opt out', {
          variant: 'primary',
          iconName: 'zap',
          testid: 'run-prompt-go',
          onClick: (e) => {
            const p = startOptOut(service, optOut, 'auto', { button: e.currentTarget, onStatus });
            history.replaceState(null, '', serviceHash(service.id));
            p.then(() => ctx.rerender());
          },
        }),
        button('Not now', {
          variant: 'ghost',
          onClick: () => {
            history.replaceState(null, '', serviceHash(service.id));
            ctx.rerender();
          },
        }),
      ),
    ),
  );
}

/* ---------- Aside ---------- */

function dataTypesCard(service) {
  const types = service.training?.dataTypes ?? [];
  return h(
    'section',
    { class: 'nt-card d-aside-card', 'aria-labelledby': 'dt-title' },
    h('h2', { class: 'd-aside-title', id: 'dt-title' }, 'What may be used'),
    types.length
      ? h('ul', { class: 'nt-chip-list', role: 'list', 'data-testid': 'data-types' }, types.map((t) => h('li', { class: 'nt-chip' }, dataTypeLabel(t))))
      : h('p', { class: 'nt-subtle' }, 'Not specified.'),
    service.training?.details && h('p', { class: 'd-aside-text' }, service.training.details),
  );
}

function sourcesCard(service) {
  return h(
    'section',
    { class: 'nt-card d-aside-card', 'aria-labelledby': 'src-title', 'data-testid': 'sources' },
    h('h2', { class: 'd-aside-title', id: 'src-title' }, 'Sources'),
    h('p', { class: 'nt-subtle' }, `Last checked by a person on ${formatDate(service.lastVerified)}.`),
    h(
      'ul',
      { class: 'd-sources', role: 'list' },
      (service.sources ?? []).map((src) =>
        h(
          'li',
          null,
          extLink(src.url, src.title, { class: 'd-source__link' }),
          h('span', { class: 'd-source__meta' }, hostOf(src.url), src.accessed ? ` · read ${formatDate(src.accessed)}` : ''),
        ),
      ),
    ),
    h(
      'p',
      { class: 'd-report' },
      icon('flag', { size: 14 }),
      extLink(reportErrorUrl(service), 'Report an error', { class: 'nt-link', 'data-testid': 'report-error' }),
    ),
  );
}

function changelogCard(service) {
  const entries = [...(service.changelog ?? [])].sort((a, b) => b.version - a.version || String(b.date).localeCompare(String(a.date)));
  const sevTone = { info: 'neutral', warning: 'warn', critical: 'bad' };
  const sevLabel = { info: 'Update', warning: 'Change', critical: 'Major change' };
  return h(
    'section',
    { class: 'nt-card d-aside-card', 'aria-labelledby': 'cl-title', 'data-testid': 'changelog' },
    h('h2', { class: 'd-aside-title', id: 'cl-title' }, 'History'),
    h(
      'ol',
      { class: 'd-timeline', role: 'list' },
      entries.map((c) =>
        h(
          'li',
          { class: 'd-timeline__item' },
          h(
            'div',
            { class: 'd-timeline__head' },
            h('time', { datetime: c.date }, formatDate(c.date)),
            c.severity !== 'info' && h('span', { class: ['nt-pill', 'nt-pill--plain', `nt-pill--${sevTone[c.severity] ?? 'neutral'}`] }, sevLabel[c.severity] ?? c.severity),
          ),
          h('p', null, c.summary),
        ),
      ),
    ),
  );
}

/* ---------- Render ---------- */

export function render(ctx) {
  const { state, route } = ctx;
  const { registry, userState, settings } = state;
  const service = registry.services.find((s) => s.id === route.param);
  if (!service) {
    return h(
      'div',
      { class: 'nt-card' },
      emptyState({
        iconName: 'search',
        title: 'Service not found',
        text: 'It may have been renamed or removed from the registry.',
        actions: [linkButton('All services', '#/services', { variant: 'primary' })],
      }),
    );
  }
  const region = settings.region;
  const status = serviceStatus(service, userState, region);
  const applicable = applicableOptOuts(service, region);
  const others = (service.optOuts ?? []).filter((o) => ACTIONABLE.has(o.type) && !appliesToRegion(o.regions, region));
  const lastResort = (service.optOuts ?? []).filter((o) => o.type === 'account-deletion' && appliesToRegion(o.regions, region));
  const noneEntry = (service.optOuts ?? []).find((o) => o.type === 'none');

  // Deep links: ?guide=<id> expands the steps; ?run=<id>&mode=auto shows the permission prompt.
  const queryKey = `${service.id}?${route.query}`;
  const guideId = route.query.get('guide');
  if (guideId && handledQuery !== queryKey) guidesFor(service.id).add(guideId);
  const runId = route.query.get('run');
  const runOptOut = runId && route.query.get('mode') === 'auto' ? applicable.find((o) => o.id === runId && o.automation) : null;

  const main = [];
  if (runOptOut && optOutStatus(userState, service.id, runOptOut.id) !== OPT_OUT_STATUS.done) main.push(runPrompt(service, runOptOut, ctx));

  main.push(
    h(
      'h2',
      { class: 'd-section-title', id: 'ways-title' },
      applicable.length ? (applicable.length === 1 ? 'How to opt out' : `${applicable.length} ways to opt out`) : 'How to opt out',
    ),
  );
  if (applicable.length) {
    main.push(h('div', { class: 'd-optouts', role: 'list', 'aria-labelledby': 'ways-title' }, applicable.map((o) => h('div', { role: 'listitem' }, optOutCard(service, o, ctx, { applicable: true })))));
  } else {
    const t = service.training ?? {};
    const safe = t.trainsOnUserData === 'no' || t.defaultState === 'opted_out' || t.defaultState === 'not_applicable';
    main.push(
      h(
        'div',
        { class: ['nt-callout', safe ? 'nt-callout--good' : 'nt-callout--neutral'], 'data-testid': 'no-optout' },
        icon(safe ? 'shieldCheck' : 'minusCircle'),
        h(
          'div',
          { class: 'nt-callout__body' },
          h(
            'p',
            { class: 'nt-callout__title' },
            safe ? 'Nothing to switch off' : others.length ? `No opt-out for ${regionLabel(region)}` : 'There’s no way to opt out',
          ),
          h(
            'p',
            null,
            safe
              ? `${service.company} says it doesn’t train on your data by default. NoTrain will tell you if that changes.`
              : noneEntry?.effect ??
                  (others.length
                    ? 'The opt-outs below only apply in other regions.'
                    : `${service.company} doesn’t offer a setting to stop training.`),
          ),
          !safe &&
            h(
              'p',
              null,
              hasObjectionRight(region)
                ? 'You still have a legal right to object. A request letter is the way to use it.'
                : 'You can still send a polite request. Companies sometimes honour it.',
            ),
          !safe && h('div', { class: 'nt-btn-row', style: { marginTop: '6px' } }, linkButton('Write a letter', letterHash(service, null), { variant: 'secondary', size: 'sm', iconName: 'letter' })),
        ),
      ),
    );
  }

  if (lastResort.length) {
    main.push(
      h(
        'details',
        { class: 'nt-disclosure d-other' },
        h('summary', null, 'Last resort: delete your account'),
        h('div', { class: 'd-optouts' }, lastResort.map((o) => optOutCard(service, o, ctx, { applicable: false }))),
      ),
    );
  }

  if (others.length) {
    main.push(
      h(
        'details',
        { class: 'nt-disclosure d-other', 'data-testid': 'other-regions' },
        h('summary', null, `Other regions (${others.length})`),
        h(
          'div',
          { class: 'd-other__body' },
          h('p', { class: 'nt-subtle' }, `These don’t apply in ${regionLabel(region)}. Change your region in Settings if that’s wrong.`),
          h('div', { class: 'd-optouts' }, others.map((o) => optOutCard(service, o, ctx, { applicable: false }))),
        ),
      ),
    );
  }

  return [
    header(service, status, state, ctx),
    status.pendingPolicyChange && policyBanner(service, userState),
    facts(service),
    ...notes(service, region),
    h(
      'div',
      { class: 'd-detail-grid' },
      h('div', { class: 'd-detail-main' }, main),
      h('div', { class: 'd-detail-aside' }, dataTypesCard(service), sourcesCard(service), changelogCard(service)),
    ),
  ];
}

export function afterRender({ route, state }, root) {
  if (route.name !== 'service') return;
  const queryKey = `${route.param}?${route.query}`;
  if (handledQuery === queryKey) return;
  handledQuery = queryKey;
  const target = route.query.get('run') ?? route.query.get('guide');
  if (!target || !state) return;
  requestAnimationFrame(() => {
    const prompt = root.querySelector('[data-testid="run-prompt"]');
    const card = root.querySelector(`[data-optout="${CSS.escape(target)}"]`);
    const el = prompt ?? card;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    const focusable = prompt ? prompt.querySelector('button') : card.querySelector('.d-steps summary');
    focusable?.focus({ preventScroll: true });
  });
}
