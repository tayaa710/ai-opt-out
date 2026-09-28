// NoTrain dashboard: app shell + hash router.
// Routes: #/welcome #/overview #/services #/service/<id> #/letters #/creators
//         #/alerts #/settings #/about   (query string after "?", e.g. ?run=x&mode=auto)

import { h, mount, preserveFocus } from '../shared/dom.js';
import { icon } from '../shared/icons.js';
import { brand } from '../shared/logo.js';
import { createStore } from '../shared/store.js';
import { announce } from '../shared/toast.js';
import { emptyState, button } from './common.js';

import * as welcome from './views/welcome.js';
import * as overview from './views/overview.js';
import * as services from './views/services.js';
import * as service from './views/service.js';
import * as letters from './views/letters.js';
import * as creators from './views/creators.js';
import * as alerts from './views/alerts.js';
import * as settings from './views/settings.js';
import * as about from './views/about.js';

const ROUTES = {
  welcome: { view: welcome, focus: true },
  overview: { view: overview, nav: 'Overview', icon: 'home' },
  services: { view: services, nav: 'Services', icon: 'grid' },
  service: { view: service, navParent: 'services' },
  letters: { view: letters, nav: 'Letters', icon: 'letter' },
  creators: { view: creators, nav: 'For creators', icon: 'code' },
  alerts: { view: alerts, nav: 'Alerts', icon: 'bell' },
  settings: { view: settings, nav: 'Settings', icon: 'sliders' },
  about: { view: about, nav: 'About', icon: 'info' },
};

const NAV_ORDER = ['overview', 'services', 'letters', 'creators', 'alerts', 'settings', 'about'];

const app = document.getElementById('app');
const store = createStore();

/** @returns {{ name: string, param: string|null, query: URLSearchParams, raw: string }} */
export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const [name = '', ...rest] = path.split('/').filter(Boolean);
  let param = rest.length ? rest.join('/') : null;
  try {
    param = param ? decodeURIComponent(param) : null;
  } catch {
    // keep raw
  }
  return { name, param, query: new URLSearchParams(qs), raw };
}

export function navigate(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', hash);
    onRoute();
  } else if (location.hash === hash) {
    onRoute();
  } else {
    location.hash = hash;
  }
}

let current = { key: null, route: null };
let firstRender = true;

function routeFromLocation(state) {
  const r = parseHash();
  if (!r.name) {
    const onboarded = state?.settings?.onboarded;
    return { ...r, name: onboarded || !state ? 'overview' : 'welcome' };
  }
  return r;
}

function unreadAlerts(state) {
  return (state?.alerts ?? []).filter((a) => !a.read && !a.dismissed).length;
}

function sidebar(route, state) {
  const active = ROUTES[route.name]?.navParent ?? route.name;
  const unread = unreadAlerts(state);
  return h(
    'aside',
    { class: 'd-side' },
    h('div', { class: 'd-side__brand' }, brand({ size: 30, href: '#/overview', label: 'NoTrain overview' })),
    h(
      'nav',
      { class: 'd-nav', 'aria-label': 'Main' },
      h(
        'ul',
        { role: 'list' },
        NAV_ORDER.map((name) => {
          const def = ROUTES[name];
          return h(
            'li',
            null,
            h(
              'a',
              {
                href: `#/${name}`,
                'aria-current': active === name ? 'page' : null,
                'data-testid': `nav-${name}`,
              },
              icon(def.icon),
              h('span', { class: 'd-nav__label' }, def.nav),
              name === 'alerts' &&
                unread > 0 &&
                h(
                  'span',
                  { class: 'nt-count', 'aria-label': `${unread} unread` },
                  unread > 99 ? '99+' : String(unread),
                ),
            ),
          );
        }),
      ),
    ),
    h(
      'div',
      { class: 'd-side__foot' },
      icon('lock'),
      h('p', null, h('strong', null, 'Private by design. '), 'Everything stays on this device.'),
    ),
  );
}

function focusTopbar() {
  return h('header', { class: 'd-focusbar' }, brand({ size: 30 }));
}

function skipLink() {
  return h(
    'a',
    {
      class: 'nt-skip-link',
      href: '#main',
      onClick: (e) => {
        e.preventDefault();
        const target = document.querySelector('[data-page-title]') ?? document.getElementById('main');
        target?.focus();
      },
    },
    'Skip to content',
  );
}

function loadingBody() {
  const line = (w) => h('span', { class: 'nt-skeleton nt-skeleton--text', style: { width: w } });
  return h(
    'div',
    { class: 'd-loading', 'aria-hidden': 'true' },
    h('span', { class: 'nt-skeleton', style: { width: '220px', height: '30px' } }),
    h('span', { class: 'nt-skeleton nt-skeleton--text', style: { width: '360px' } }),
    h(
      'div',
      { class: 'nt-card', style: { padding: '24px', display: 'grid', gap: '14px' } },
      h('span', { class: 'nt-skeleton nt-skeleton--title' }),
      line('92%'),
      line('80%'),
      line('64%'),
    ),
    h(
      'div',
      { class: 'nt-card', style: { padding: '24px', display: 'grid', gap: '14px' } },
      line('70%'),
      line('85%'),
      line('50%'),
    ),
  );
}

function errorBody(error) {
  return h(
    'div',
    { class: 'nt-card', 'data-testid': 'load-error' },
    emptyState({
      iconName: 'alertCircle',
      title: 'NoTrain couldn’t load',
      text: `The extension may be restarting. Your settings and progress are safe. (${error?.message ?? 'Unknown error'})`,
      actions: [
        button('Try again', { variant: 'primary', iconName: 'refresh', onClick: () => store.reload() }),
      ],
    }),
  );
}

function notFoundBody() {
  return h(
    'div',
    { class: 'nt-card' },
    emptyState({
      iconName: 'search',
      title: 'Page not found',
      text: 'That page doesn’t exist.',
      actions: [h('a', { class: 'nt-btn nt-btn--primary', href: '#/overview' }, 'Go to overview')],
    }),
  );
}

function renderApp({ navigated }) {
  const snap = store.get();
  const state = snap.state;
  const route = routeFromLocation(state);
  if (state && !parseHash().name) {
    // Make the implicit default route explicit so links and reloads agree.
    history.replaceState(null, '', `#/${route.name}`);
    current.key = `${route.name}/`;
  }
  const def = ROUTES[route.name];
  const ctx = { state, route, store, navigate, navigated, rerender: () => renderApp({ navigated: false }) };

  let body;
  let title = 'NoTrain';
  if (!state && snap.status === 'loading') body = loadingBody();
  else if (!state) body = errorBody(snap.error);
  else if (!def) body = notFoundBody();
  else {
    try {
      body = def.view.render(ctx);
      title = def.view.title?.(ctx) ?? def.nav ?? 'NoTrain';
    } catch (err) {
      console.error('[NoTrain] view failed', err);
      body = errorBody(err);
    }
  }
  document.title = title === 'NoTrain' ? 'NoTrain' : `${title} · NoTrain`;

  const focusMode = Boolean(def?.focus);
  const shell = h(
    'div',
    { class: ['d-shell', focusMode && 'is-focus'] },
    skipLink(),
    focusMode ? focusTopbar() : sidebar(route, state),
    h(
      'main',
      {
        class: 'd-main',
        id: 'main',
        tabindex: '-1',
        'aria-busy': snap.status === 'loading' && !state ? 'true' : 'false',
      },
      h(
        'div',
        {
          class: ['d-content', def?.view.wide && 'd-content--wide', focusMode && 'd-content--focus'],
          'data-route': route.name,
        },
        body,
      ),
    ),
  );

  const scrollY = window.scrollY;
  if (navigated) {
    mount(app, shell);
    window.scrollTo(0, 0);
    if (!firstRender) {
      const heading = app.querySelector('[data-page-title]');
      if (heading) heading.focus({ preventScroll: true });
      announce(`${title} page`);
    }
  } else {
    preserveFocus(app, () => mount(app, shell));
    window.scrollTo(0, scrollY);
  }
  def?.view.afterRender?.(ctx, app);
  if (state) firstRender = false;
}

function onRoute() {
  const r = parseHash();
  const key = `${r.name}/${r.param ?? ''}`;
  const navigated = key !== current.key;
  current = { key, route: r };
  renderApp({ navigated });
}

window.addEventListener('hashchange', onRoute);
store.subscribe(() => renderApp({ navigated: false }));
chrome.permissions?.onAdded?.addListener(() => renderApp({ navigated: false }));
chrome.permissions?.onRemoved?.addListener(() => renderApp({ navigated: false }));

current.key = (() => {
  const r = parseHash();
  return `${r.name}/${r.param ?? ''}`;
})();
// Avoid flashing a skeleton when state arrives quickly.
setTimeout(() => {
  if (!store.get().state) renderApp({ navigated: true });
}, 180);
store.start();
