// NoTrain popup: protection summary, "you're on <service>", tracked services
// by urgency with one primary action each. Anything that needs a permission
// prompt is routed to the dashboard (popups close when a prompt opens).

import { api, hasPermissions } from '../lib/api.js';
import { serviceForUrl, serviceStatus, summarize, compareByUrgency } from '../lib/status.js';
import { h, mount, extLink, isSafeExternalUrl, preserveFocus } from '../shared/dom.js';
import { icon } from '../shared/icons.js';
import { brand, logoMark } from '../shared/logo.js';
import { monogram } from '../shared/monogram.js';
import { createStore } from '../shared/store.js';
import { toast } from '../shared/toast.js';
import { hostOf } from '../shared/format.js';
import { TRAINS_LABELS, DEFAULT_LABELS } from '../shared/labels.js';
import {
  openDashboard,
  primaryAction,
  progressRing,
  statusPill,
  summaryCopy,
  summarySegments,
  attentionReason,
  withBusy,
} from '../shared/ui.js';

const params = new URLSearchParams(location.search);
// ?frame=1 renders the popup framed inside a normal tab (tests, store screenshots).
if (params.get('frame') === '1') document.documentElement.classList.add('is-tab');
// ?preview=<url> pretends the active tab is at <url> (framed previews only).
const previewUrl = params.get('frame') === '1' ? params.get('preview') : null;

const app = document.getElementById('app');
const store = createStore();

/** Active tab info, resolved once. */
const tabInfo = { tab: null, wellKnown: null, probed: false };

async function loadActiveTab() {
  if (previewUrl) {
    tabInfo.tab = { id: -1, url: previewUrl };
    tabInfo.probed = true;
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabInfo.tab = tab ?? null;
  } catch {
    tabInfo.tab = null;
  }
  const url = tabInfo.tab?.url ?? '';
  if (tabInfo.tab?.id >= 0 && /^https:\/\//.test(url)) {
    try {
      const res = await api.probeWellKnown(tabInfo.tab.id);
      if (res?.found && res.document) tabInfo.wellKnown = res;
    } catch {
      // Probing is best-effort; ignore failures (restricted pages, no response).
    }
  }
  tabInfo.probed = true;
  render(store.get());
}

function close() {
  if (!document.documentElement.classList.contains('is-tab')) window.close();
}

async function go(hash) {
  await openDashboard(hash);
  close();
}

/* ---------- Actions ---------- */

async function runAction(service, action, button) {
  const { kind, optOut } = action;
  if (kind === 'auto' && optOut?.automation) {
    const origins = optOut.automation.hostPermissions ?? [];
    let granted;
    try {
      granted = await hasPermissions(origins);
    } catch {
      granted = false;
    }
    if (!granted) {
      // Permission prompts close popups, so ask from the dashboard instead.
      await go(`#/service/${encodeURIComponent(service.id)}?run=${encodeURIComponent(optOut.id)}&mode=auto`);
      return;
    }
    await withBusy(button, async () => {
      try {
        await api.runOptOut(service.id, optOut.id, 'auto');
        close();
      } catch (err) {
        toast(`Couldn’t start: ${err.message}`, { tone: 'bad' });
      }
    });
    return;
  }
  if (kind === 'guide' && optOut) {
    await go(`#/service/${encodeURIComponent(service.id)}?guide=${encodeURIComponent(optOut.id)}`);
    return;
  }
  if (kind === 'letter' && optOut) {
    await go(`#/letters?service=${encodeURIComponent(service.id)}&optOut=${encodeURIComponent(optOut.id)}`);
    return;
  }
  await go(`#/service/${encodeURIComponent(service.id)}`);
}

/* ---------- Pieces ---------- */

function header(state) {
  const unread = (state?.alerts ?? []).filter((a) => !a.read && !a.dismissed).length;
  return h(
    'header',
    { class: 'p-header' },
    brand({ size: 26 }),
    h(
      'div',
      { class: 'p-header__actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'nt-btn nt-btn--ghost nt-btn--icon p-iconbtn',
          'aria-label': unread ? `Alerts, ${unread} unread` : 'Alerts',
          title: 'Alerts',
          'data-testid': 'popup-alerts',
          onClick: () => go('#/alerts'),
        },
        icon('bell'),
        unread > 0 &&
          h('span', { class: 'nt-count', 'aria-hidden': 'true' }, unread > 9 ? '9+' : String(unread)),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'nt-btn nt-btn--ghost nt-btn--icon',
          'aria-label': 'Open dashboard',
          title: 'Open dashboard',
          'data-testid': 'popup-dashboard',
          onClick: () => go('#/overview'),
        },
        icon('overview'),
      ),
    ),
  );
}

function footer() {
  return h(
    'footer',
    { class: 'p-footer' },
    h('span', { class: 'p-footer__private' }, icon('lock'), 'Nothing leaves your device'),
    h(
      'a',
      {
        class: 'nt-link',
        href: '#',
        onClick: (e) => {
          e.preventDefault();
          go('#/services');
        },
      },
      'All services',
      icon('arrowRight', { size: 14 }),
    ),
  );
}

function summaryCard(services, userState, region) {
  const sum = summarize(services, userState, region);
  const copy = summaryCopy(sum);
  return h(
    'section',
    { class: 'nt-card p-summary', 'aria-labelledby': 'p-summary-title', 'data-testid': 'popup-summary' },
    progressRing({
      value: sum.protected,
      total: sum.tracked,
      size: 60,
      stroke: 6,
      segments: summarySegments(sum),
      label: `${sum.protected} of ${sum.tracked} tracked services opted out or not training`,
    }),
    h(
      'div',
      { class: 'p-summary__text' },
      h('h1', { class: 'p-summary__headline', id: 'p-summary-title' }, copy.headline),
      h('p', { class: 'p-summary__detail' }, copy.detail),
    ),
  );
}

function sameSite(a, b) {
  const base = (host) => host.split('.').slice(-2).join('.');
  try {
    const ha = new URL(a).hostname;
    const hb = new URL(b).hostname;
    return base(ha) === base(hb);
  } catch {
    return false;
  }
}

function wellKnownBlock(doc, pageUrl) {
  const trains =
    { yes: 'Yes', no: 'No', conditional: 'In some cases' }[doc.trains_on_user_content] ?? 'Not stated';
  const optOutOk =
    typeof doc.opt_out_url === 'string' &&
    isSafeExternalUrl(doc.opt_out_url) &&
    doc.opt_out_url.startsWith('https://') &&
    sameSite(doc.opt_out_url, pageUrl);
  return h(
    'div',
    { class: 'p-site__wellknown', 'data-testid': 'popup-wellknown' },
    h('div', { class: 'p-site__wellknown-title' }, icon('info'), 'This site publishes an AI-training policy'),
    h('div', { class: 'nt-muted' }, `Trains on what you share: ${trains}`),
    optOutOk && extLink(doc.opt_out_url, 'Open its opt-out page', { class: 'nt-link' }),
  );
}

function currentSiteCard(state) {
  const url = tabInfo.tab?.url;
  if (!url) return null;
  const services = state.registry.services;
  const service = serviceForUrl(services, url);
  const wk = tabInfo.wellKnown?.document;
  if (!service && !wk) return null;

  if (!service) {
    return h(
      'section',
      { class: 'nt-card p-site', 'aria-label': 'This site', 'data-testid': 'popup-site' },
      h(
        'div',
        { class: 'p-site__head' },
        h(
          'div',
          { class: 'p-site__title' },
          h('span', { class: 'p-site__eyebrow' }, 'You’re on'),
          h('span', { class: 'p-site__name' }, wk.name || hostOf(url)),
        ),
      ),
      wellKnownBlock(wk, url),
    );
  }

  const { userState, settings } = state;
  const status = serviceStatus(service, userState, settings.region);
  const trains = TRAINS_LABELS[service.training?.trainsOnUserData] ?? TRAINS_LABELS.unknown;
  const def = DEFAULT_LABELS[service.training?.defaultState];
  const tracked = status.code !== 'not_tracked';
  const action = primaryAction(service, userState, settings.region);

  let actions;
  if (!tracked) {
    actions = [
      h(
        'button',
        {
          type: 'button',
          class: 'nt-btn nt-btn--primary nt-btn--sm',
          'data-testid': 'popup-track-current',
          onClick: (e) =>
            withBusy(e.currentTarget, async () => {
              try {
                await api.trackServices([service.id], true, 'manual');
                toast(`Tracking ${service.name}`);
              } catch (err) {
                toast(`Couldn’t track: ${err.message}`, { tone: 'bad' });
              }
            }),
        },
        icon('plus'),
        `Track ${service.name}`,
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'nt-btn nt-btn--secondary nt-btn--sm',
          onClick: () => go(`#/service/${encodeURIComponent(service.id)}`),
        },
        'Details',
      ),
    ];
  } else if (action.kind === 'details') {
    actions = [
      h(
        'button',
        {
          type: 'button',
          class: 'nt-btn nt-btn--secondary nt-btn--sm',
          onClick: () => go(`#/service/${encodeURIComponent(service.id)}`),
        },
        'View details',
      ),
    ];
  } else {
    actions = [
      h(
        'button',
        {
          type: 'button',
          class: 'nt-btn nt-btn--primary nt-btn--sm',
          'data-testid': 'popup-site-action',
          onClick: (e) => runAction(service, action, e.currentTarget),
        },
        action.kind === 'auto' ? icon('zap') : null,
        action.kind === 'auto'
          ? status.code === 'needs_attention'
            ? 'Fix it for me'
            : 'Opt out for me'
          : action.label,
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'nt-btn nt-btn--secondary nt-btn--sm',
          onClick: () => go(`#/service/${encodeURIComponent(service.id)}`),
        },
        'Details',
      ),
    ];
  }

  let factText = def ? `${trains.long}. ${def.label}.` : `${trains.long}.`;
  let factIcon = trains.tone === 'good' ? 'shieldCheck' : 'info';
  let factTone = trains.tone;
  if (status.code === 'protected') {
    factText = 'You’ve opted out here. NoTrain will let you know if that changes.';
    factIcon = 'shieldCheck';
    factTone = 'good';
  } else if (status.code === 'safe_by_default') {
    factText = 'Doesn’t train on your data by default. Nothing to do.';
    factIcon = 'shieldCheck';
    factTone = 'good';
  } else if (status.code === 'needs_attention') {
    factText = status.pendingPolicyChange
      ? 'Its AI training policy changed. Take a look.'
      : 'A setting you turned off was switched back on.';
    factIcon = 'alert';
    factTone = 'bad';
  }
  return h(
    'section',
    { class: 'nt-card p-site', 'aria-labelledby': 'p-site-name', 'data-testid': 'popup-site' },
    h(
      'div',
      { class: 'p-site__head' },
      monogram(service, { size: 'md' }),
      h(
        'div',
        { class: 'p-site__title' },
        h('span', { class: 'p-site__eyebrow' }, 'You’re on'),
        h('span', { class: 'p-site__name', id: 'p-site-name' }, service.name),
      ),
      statusPill(status),
    ),
    h('p', { class: 'p-site__fact' }, icon(factIcon, { class: `nt-tone-${factTone}` }), factText),
    h('div', { class: 'p-site__actions' }, actions),
    wk && wellKnownBlock(wk, tabInfo.tab.url),
  );
}

function serviceRow(service, state) {
  const { userState, settings } = state;
  const action = primaryAction(service, userState, settings.region);
  const status = action.status;
  const hash = `#/service/${encodeURIComponent(service.id)}`;
  let aside;
  if (status.code === 'protected' || status.code === 'safe_by_default') {
    aside = h(
      'span',
      { class: 'p-row__check', title: status.label },
      icon('checkCircle', { label: status.label }),
    );
  } else if (action.kind === 'details') {
    aside = h('span', { class: 'p-row__check nt-muted' }, icon('chevronRight'));
  } else {
    aside = h(
      'button',
      {
        type: 'button',
        class: [
          'nt-btn',
          'nt-btn--sm',
          status.code === 'needs_attention' ? 'nt-btn--primary' : 'nt-btn--soft',
        ],
        'aria-label': `${action.kind === 'auto' && status.code !== 'needs_attention' ? 'Opt out of' : action.label} ${service.name}`,
        'data-testid': 'popup-row-action',
        onClick: (e) => runAction(service, action, e.currentTarget),
      },
      action.label,
    );
  }
  return h(
    'li',
    { class: 'p-row', 'data-service': service.id },
    h(
      'a',
      {
        class: 'p-row__link',
        href: '#',
        onClick: (e) => {
          e.preventDefault();
          go(hash);
        },
      },
      monogram(service, { size: 'md' }),
      h(
        'span',
        { class: 'p-row__text' },
        h('span', { class: 'p-row__name' }, service.name),
        status.code === 'needs_attention'
          ? h('span', { class: ['nt-pill', 'nt-pill--bad'] }, attentionReason(service, userState, status))
          : statusPill(status),
      ),
    ),
    aside,
  );
}

function servicesSection(state) {
  const { registry, userState, settings } = state;
  const tracked = registry.services
    .filter((s) => userState.services?.[s.id]?.tracked)
    .sort((a, b) => compareByUrgency(a, b, userState, settings.region));
  return h(
    'section',
    { 'aria-labelledby': 'p-services-title', 'data-testid': 'popup-services' },
    h(
      'div',
      { class: 'p-section-head' },
      h('h2', { class: 'p-section-title', id: 'p-services-title' }, 'Your services'),
      h(
        'a',
        {
          class: 'nt-link nt-subtle',
          href: '#',
          onClick: (e) => {
            e.preventDefault();
            go('#/services');
          },
        },
        'Manage',
      ),
    ),
    h(
      'ul',
      { class: 'nt-card nt-list p-list', role: 'list', style: { marginTop: '8px' } },
      tracked.map((s) => serviceRow(s, state)),
    ),
  );
}

function welcome(state) {
  const onboarded = state?.settings?.onboarded;
  return h(
    'section',
    { class: 'nt-card p-welcome', 'data-testid': 'popup-welcome' },
    logoMark({ size: 44 }),
    h(
      'h1',
      { class: 'p-welcome__title' },
      onboarded ? 'Pick your services' : 'See who trains AI on your data',
    ),
    h(
      'p',
      { class: 'p-welcome__text' },
      onboarded
        ? 'You’re not tracking any services yet. Choose the ones you use to see where you stand.'
        : 'NoTrain shows which services use what you share to train AI, and helps you opt out.',
    ),
    !onboarded &&
      h(
        'ul',
        { class: 'p-welcome__points', role: 'list' },
        h('li', null, icon('check'), 'Opt out in a click where possible'),
        h('li', null, icon('check'), 'Step-by-step help everywhere else'),
        h('li', null, icon('check'), 'Alerts when a company changes the rules'),
      ),
    h(
      'button',
      {
        type: 'button',
        class: 'nt-btn nt-btn--primary nt-btn--block',
        'data-testid': 'popup-setup',
        onClick: () => go(onboarded ? '#/services' : '#/welcome'),
      },
      onboarded ? 'Choose services' : 'Set up NoTrain',
      icon('arrowRight'),
    ),
  );
}

function loadingView() {
  const row = () =>
    h(
      'div',
      { class: 'p-skel-row' },
      h('span', { class: 'nt-skeleton', style: { width: '36px', height: '36px', borderRadius: '10px' } }),
      h(
        'div',
        { style: { flex: '1', display: 'grid', gap: '8px' } },
        h('span', { class: 'nt-skeleton nt-skeleton--text', style: { width: '45%' } }),
        h('span', { class: 'nt-skeleton nt-skeleton--text', style: { width: '28%' } }),
      ),
    );
  return [
    h(
      'div',
      { class: 'nt-card p-summary', 'aria-hidden': 'true' },
      h('span', { class: 'nt-skeleton nt-skeleton--circle', style: { width: '60px', height: '60px' } }),
      h(
        'div',
        { style: { flex: '1', display: 'grid', gap: '10px' } },
        h('span', { class: 'nt-skeleton nt-skeleton--title', style: { width: '70%' } }),
        h('span', { class: 'nt-skeleton nt-skeleton--text', style: { width: '90%' } }),
      ),
    ),
    h('div', { class: 'nt-card', 'aria-hidden': 'true' }, row(), row(), row()),
    h('p', { class: 'nt-visually-hidden', role: 'status' }, 'Loading'),
  ];
}

function errorView(error) {
  return h(
    'div',
    { class: 'nt-card', 'data-testid': 'popup-error' },
    h(
      'div',
      { class: 'nt-empty' },
      h('div', { class: 'nt-empty__icon' }, icon('alertCircle')),
      h('p', { class: 'nt-empty__title' }, 'NoTrain couldn’t load'),
      h(
        'p',
        { class: 'nt-empty__text' },
        'The extension is restarting or something went wrong. Your settings are safe.',
      ),
      h('p', { class: 'nt-subtle' }, String(error?.message ?? '')),
      h(
        'div',
        { class: 'nt-btn-row' },
        h(
          'button',
          { type: 'button', class: 'nt-btn nt-btn--primary nt-btn--sm', onClick: () => store.reload() },
          icon('refresh'),
          'Try again',
        ),
      ),
    ),
  );
}

/* ---------- Render ---------- */

function render(snap) {
  const state = snap.state;
  let body;
  if (snap.status === 'loading' && !state) body = loadingView();
  else if (snap.status === 'error' && !state) body = errorView(snap.error);
  else {
    const { registry, userState, settings } = state;
    const anyTracked = registry.services.some((s) => userState.services?.[s.id]?.tracked);
    body = [];
    if (!anyTracked) {
      body.push(welcome(state));
      const site = currentSiteCard(state);
      if (site) body.push(site);
    } else {
      body.push(summaryCard(registry.services, userState, settings.region));
      const site = currentSiteCard(state);
      if (site) body.push(site);
      body.push(servicesSection(state));
    }
  }
  const main = app.querySelector('.p-main');
  const scroll = main ? main.scrollTop : 0;
  preserveFocus(app, () =>
    mount(
      app,
      header(state),
      h(
        'main',
        { class: 'p-main', id: 'main', 'aria-busy': snap.status === 'loading' ? 'true' : 'false' },
        body,
      ),
      footer(),
    ),
  );
  app.querySelector('.p-main').scrollTop = scroll;
}

store.subscribe(render);
render(store.get());
store.start();
loadActiveTab();
