// #/about: how NoTrain works, the privacy promise, limits, the open standard.

import { h, extLink } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { logoMark } from '../../shared/logo.js';
import { formatDate } from '../../shared/format.js';
import { pageHeader, REPO_URL } from '../common.js';

export function title() {
  return 'About';
}

function block(iconName, heading, ...body) {
  return h(
    'section',
    { class: 'nt-card ab-block' },
    h('span', { class: 'ab-block__icon' }, icon(iconName)),
    h('div', { class: 'ab-block__body' }, h('h2', { class: 'ab-block__title' }, heading), body),
  );
}

function list(items) {
  return h(
    'ul',
    { class: 'ab-list' },
    items.map((i) => h('li', null, i)),
  );
}

export function render({ state }) {
  const version = chrome.runtime.getManifest?.().version ?? '';
  const meta = state.registryMeta ?? {};
  const count = state.registry.services.length;
  return [
    pageHeader({
      title: 'About NoTrain',
      subtitle: 'A free, open-source tool that helps you keep your data out of AI training.',
    }),
    h(
      'div',
      { class: 'nt-card ab-hero' },
      logoMark({ size: 48 }),
      h(
        'div',
        null,
        h(
          'p',
          { class: 'ab-hero__name' },
          'NoTrain',
          version && h('span', { class: 'ab-hero__version' }, `Version ${version}`),
        ),
        h(
          'p',
          { class: 'nt-muted' },
          `${count} services in the list`,
          meta.generatedAt ? `, updated ${formatDate(meta.generatedAt)}` : '',
          '. ',
          extLink(REPO_URL, 'Source code on GitHub', { class: 'nt-link' }),
        ),
      ),
    ),
    h(
      'div',
      { class: 'ab-grid' },
      block(
        'lock',
        'Your privacy',
        h(
          'p',
          null,
          'NoTrain has no account, no analytics and no servers. Your settings, the services you track and your progress stay in this browser.',
        ),
        list([
          'The only thing NoTrain downloads by itself is the public list of services, once a week. Nothing about you is sent with it.',
          'Your name and email are only used to fill in letters on your screen. You send letters yourself.',
          'Site access is requested one site at a time, only when you click “Opt out for me”, and can be revoked in Settings.',
        ]),
      ),
      block(
        'listChecks',
        'How it works',
        list([
          'A community-maintained list describes each service: whether it trains AI on your data, what the default is, and every way to opt out, with sources.',
          'For account settings, NoTrain can open the page and switch the setting off while you watch. Otherwise it walks you through the steps.',
          'Where there’s no setting, it writes a request letter based on the privacy law where you live.',
          'Each week it checks for policy changes and alerts you if a service you use changes the rules.',
        ]),
      ),
      block(
        'zap',
        'What automation can and can’t do',
        list([
          'It only runs after you click, in a tab you can see, and you can stop it at any time.',
          'It needs you to be signed in to the service. It never sees or stores your password.',
          'Websites change. If a step can’t be found, NoTrain stops and switches to step-by-step guidance instead of guessing.',
          'Each automatic opt-out is labelled Reliable, Usually works or Experimental, so you know what to expect.',
        ]),
      ),
      block(
        'info',
        'Honest limits',
        list([
          'Opting out usually only affects the future. Data already used to train a model can’t be removed from it.',
          'Some services offer no opt-out at all, or only in some countries. NoTrain tells you when that’s the case.',
          'Services can change settings or policies without notice. NoTrain’s list is checked by people and may lag behind.',
          'Letters are templates, not legal advice.',
        ]),
      ),
      block(
        'globe',
        'An open standard for opt-outs',
        h(
          'p',
          null,
          'NoTrain proposes a simple file any service can publish at ',
          h('code', { class: 'nt-mono ab-code' }, '/.well-known/ai-training-opt-out'),
          ' saying whether it trains on user content and where to opt out. When a site publishes one, the NoTrain popup shows it.',
        ),
        h(
          'p',
          null,
          extLink(`${REPO_URL}/blob/main/spec/well-known-ai-training-opt-out.md`, 'Read the specification', {
            class: 'nt-link',
          }),
        ),
      ),
      block(
        'heart',
        'Open source',
        h(
          'p',
          null,
          'NoTrain is free and MIT licensed. Corrections to the service list are welcome from anyone.',
        ),
        h(
          'p',
          { class: 'ab-links' },
          extLink(REPO_URL, 'GitHub repository', { class: 'nt-link' }),
          extLink(`${REPO_URL}/issues/new?template=registry-correction.yml`, 'Report a correction', {
            class: 'nt-link',
          }),
          extLink(`${REPO_URL}/blob/main/PRIVACY.md`, 'Privacy policy', { class: 'nt-link' }),
        ),
      ),
    ),
  ];
}
