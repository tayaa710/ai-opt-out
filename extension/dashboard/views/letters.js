// #/letters: generate a legal request letter (objection, erasure, access, …).
// Query: ?service=<id>&optOut=<id>&kind=<kind>

import { api } from '../../lib/api.js';
import { REGIONS, regionLabel } from '../../lib/region.js';
import { applicableOptOuts } from '../../lib/status.js';
import { h, mount, extLink } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { toast } from '../../shared/toast.js';
import { fileStamp, hostOf } from '../../shared/format.js';
import {
  pageHeader,
  emptyState,
  button,
  copyText,
  downloadText,
  act,
  selectField,
  textField,
} from '../common.js';

let lettersLib = null;
let lettersError = null;
const lettersReady = import('../../lib/letters.js')
  .then((m) => {
    lettersLib = m;
  })
  .catch((err) => {
    lettersError = err;
  });

/** Draft state for the page's lifetime. */
const lt = {
  queryKey: null,
  serviceId: null,
  optOutId: null,
  kind: null,
  region: null,
  fullName: null,
  email: null,
  subject: '',
  body: '',
  edited: false,
  letter: null,
};

export function title() {
  return 'Letters';
}

function initFromRoute(ctx) {
  const { state, route } = ctx;
  const key = route.query.toString();
  if (lt.queryKey === key && lt.serviceId) return;
  lt.queryKey = key;
  const services = state.registry.services;
  const qService = route.query.get('service');
  const trackedFirst = services.find((s) => state.userState.services?.[s.id]?.tracked) ?? services[0];
  lt.serviceId = services.some((s) => s.id === qService)
    ? qService
    : (lt.serviceId ?? trackedFirst?.id ?? null);
  lt.optOutId = route.query.get('optOut') ?? null;
  lt.region = lt.region ?? state.settings.region ?? 'OTHER';
  if (route.query.get('kind')) lt.kind = route.query.get('kind');
  lt.fullName = lt.fullName ?? state.settings.profile?.fullName ?? '';
  lt.email = lt.email ?? state.settings.profile?.email ?? '';
  lt.edited = false;
  lt.letter = null;
}

function kindsFor(region) {
  return lettersLib?.availableKinds ? lettersLib.availableKinds(region) : [];
}

/** The opt-out a sent letter is recorded against. */
function recordTarget(service, region) {
  if (!service) return null;
  const all = service.optOuts ?? [];
  const byId = all.find((o) => o.id === lt.optOutId);
  if (byId) return byId;
  const app = applicableOptOuts(service, region);
  return app.find((o) => o.type === 'email') ?? app.find((o) => o.type === 'form') ?? app[0] ?? null;
}

function regenerate(service) {
  if (!lettersLib || !service) return;
  const kinds = kindsFor(lt.region);
  if (!kinds.some((k) => k.id === lt.kind)) lt.kind = kinds[0]?.id ?? 'generic';
  const optOut = (service.optOuts ?? []).find((o) => o.id === lt.optOutId);
  try {
    lt.letter = lettersLib.generateLetter({
      service,
      optOut,
      region: lt.region,
      kind: lt.kind,
      profile: { fullName: lt.fullName, email: lt.email },
      date: new Date(),
    });
    lt.subject = lt.letter.subject;
    lt.body = lt.letter.body;
    lt.edited = false;
  } catch (err) {
    lt.letter = null;
    lt.subject = '';
    lt.body = '';
    toast(`Couldn’t write the letter: ${err.message}`, { tone: 'bad' });
  }
}

function currentMailto() {
  const to = lt.letter?.to;
  if (!to) return null;
  if (lettersLib?.buildMailto) return lettersLib.buildMailto(to, lt.subject, lt.body);
  return `mailto:${to}?subject=${encodeURIComponent(lt.subject)}&body=${encodeURIComponent(lt.body)}`;
}

function formPanel(ctx, service, onChange) {
  const { state } = ctx;
  const services = state.registry.services;
  const tracked = services.filter((s) => state.userState.services?.[s.id]?.tracked);
  const others = services.filter((s) => !state.userState.services?.[s.id]?.tracked);
  const kinds = kindsFor(lt.region);

  const serviceSelect = h(
    'div',
    { class: 'nt-field' },
    h('label', { class: 'nt-label', for: 'letter-service' }, 'Company'),
    h(
      'span',
      { class: 'nt-select-wrap' },
      h(
        'select',
        {
          class: 'nt-select',
          id: 'letter-service',
          'data-testid': 'letter-service',
          onChange: (e) => {
            lt.serviceId = e.currentTarget.value;
            lt.optOutId = null;
            onChange();
          },
        },
        tracked.length > 0 &&
          h(
            'optgroup',
            { label: 'Your services' },
            tracked.map((s) =>
              h('option', { value: s.id, selected: s.id === lt.serviceId }, `${s.name} (${s.company})`),
            ),
          ),
        h(
          'optgroup',
          { label: tracked.length ? 'Other services' : 'All services' },
          others.map((s) =>
            h('option', { value: s.id, selected: s.id === lt.serviceId }, `${s.name} (${s.company})`),
          ),
        ),
      ),
    ),
  );

  const kindField = h(
    'fieldset',
    { class: 'l-kinds' },
    h('legend', { class: 'nt-label' }, 'What do you want to ask for?'),
    kinds.map((k, i) =>
      h(
        'label',
        { class: 'nt-choice' },
        h('input', {
          type: 'radio',
          name: 'letter-kind',
          value: k.id,
          checked: k.id === lt.kind,
          'data-testid': `letter-kind-${k.id}`,
          onChange: () => {
            lt.kind = k.id;
            onChange();
          },
        }),
        h(
          'span',
          { class: 'nt-choice__body' },
          h(
            'span',
            { class: 'nt-choice__title' },
            k.label,
            i === 0 && h('span', { class: 'nt-pill nt-pill--primary nt-pill--plain l-rec' }, 'Recommended'),
          ),
          h('span', { class: 'nt-choice__desc' }, k.description),
        ),
      ),
    ),
  );

  const saveProfile = (field) => async (e) => {
    const value = e.currentTarget.value.trim();
    try {
      await api.updateSettings({ profile: { [field]: value } });
    } catch {
      // Draft still works without saving.
    }
  };

  return h(
    'section',
    { class: 'nt-card l-form', 'aria-labelledby': 'l-form-title' },
    h('h2', { class: 'd-aside-title', id: 'l-form-title' }, 'Details'),
    serviceSelect,
    selectField({
      id: 'letter-region',
      label: 'Where you live',
      hint: 'Decides which law the letter cites.',
      value: lt.region,
      options: REGIONS.map((r) => ({ value: r.code, label: r.label })),
      testid: 'letter-region',
      onChange: (e) => {
        lt.region = e.currentTarget.value;
        onChange();
      },
    }),
    kindField,
    h(
      'div',
      { class: 'l-profile' },
      textField({
        id: 'letter-name',
        label: 'Your full name',
        value: lt.fullName,
        autocomplete: 'name',
        testid: 'letter-name',
        onInput: (e) => {
          lt.fullName = e.currentTarget.value;
          onChange({ soft: true });
        },
        onChange: saveProfile('fullName'),
      }),
      textField({
        id: 'letter-email',
        label: 'Email on your account',
        type: 'email',
        value: lt.email,
        autocomplete: 'email',
        testid: 'letter-email',
        onInput: (e) => {
          lt.email = e.currentTarget.value;
          onChange({ soft: true });
        },
        onChange: saveProfile('email'),
      }),
      h(
        'p',
        { class: 'nt-hint l-profile__hint' },
        icon('lock', { size: 12 }),
        'Saved on this device only, to fill in letters.',
      ),
    ),
  );
}

function previewPanel(ctx, service) {
  const letter = lt.letter;
  if (!letter) {
    return h(
      'section',
      { class: 'nt-card l-preview' },
      emptyState({ iconName: 'letter', title: 'Pick a company to start', text: 'Your letter appears here.' }),
    );
  }
  const target = recordTarget(service, lt.region);
  const mailto = currentMailto();
  const recipient = letter.to
    ? h('span', { class: 'l-to__value' }, letter.to)
    : letter.formUrl
      ? h(
          'span',
          { class: 'l-to__value' },
          extLink(letter.formUrl, `${hostOf(letter.formUrl)} request form`, { class: 'nt-link' }),
        )
      : h(
          'span',
          { class: 'l-to__value nt-muted' },
          'No public contact found. Use the company’s help or privacy page.',
        );

  const bodyArea = h('textarea', {
    class: 'nt-textarea l-body',
    id: 'letter-body',
    rows: 18,
    spellcheck: 'true',
    'data-testid': 'letter-body',
    value: lt.body,
    onInput: (e) => {
      lt.body = e.currentTarget.value;
      lt.edited = true;
      syncMailto();
    },
  });
  const subjectInput = h('input', {
    class: 'nt-input',
    id: 'letter-subject',
    value: lt.subject,
    'data-testid': 'letter-subject',
    onInput: (e) => {
      lt.subject = e.currentTarget.value;
      lt.edited = true;
      syncMailto();
    },
  });
  const mailBtn = mailto
    ? h(
        'a',
        { class: 'nt-btn nt-btn--primary', href: mailto, 'data-testid': 'letter-mailto' },
        icon('mail'),
        'Open in email app',
      )
    : letter.formUrl
      ? extLink(letter.formUrl, 'Open request form', {
          class: 'nt-btn nt-btn--primary',
          'data-testid': 'letter-form',
        })
      : null;

  function syncMailto() {
    if (mailBtn && mailto) mailBtn.setAttribute('href', currentMailto());
  }

  const authority = letter.authority?.name
    ? h(
        'li',
        null,
        'No reply? You can complain to ',
        letter.authority.url
          ? extLink(letter.authority.url, letter.authority.name, { class: 'nt-link' })
          : letter.authority.name,
        '.',
      )
    : null;

  return h(
    'section',
    { class: 'nt-card l-preview', 'aria-labelledby': 'l-preview-title', 'data-testid': 'letter-preview' },
    h(
      'div',
      { class: 'l-preview__head' },
      h('h2', { class: 'd-aside-title', id: 'l-preview-title' }, 'Your letter'),
      h('span', { class: 'nt-subtle' }, 'You can edit it before sending.'),
    ),
    h(
      'div',
      { class: 'l-to' },
      h('span', { class: 'l-to__label' }, letter.to ? 'To' : 'Send via'),
      recipient,
    ),
    h(
      'div',
      { class: 'nt-field' },
      h('label', { class: 'nt-label', for: 'letter-subject' }, 'Subject'),
      subjectInput,
    ),
    h(
      'div',
      { class: 'nt-field' },
      h('label', { class: 'nt-label', for: 'letter-body' }, 'Letter'),
      bodyArea,
    ),
    h(
      'ul',
      { class: 'l-facts' },
      letter.legalBasis && h('li', null, h('strong', null, 'Based on: '), letter.legalBasis),
      letter.responseDeadline && h('li', null, h('strong', null, 'Reply due: '), letter.responseDeadline),
      authority,
    ),
    h(
      'div',
      { class: 'l-actions' },
      h(
        'div',
        { class: 'nt-btn-row' },
        mailBtn,
        button('Copy', {
          variant: 'secondary',
          iconName: 'copy',
          testid: 'letter-copy',
          onClick: () => copyText(`Subject: ${lt.subject}\n\n${lt.body}`, 'Letter'),
        }),
        button('Download', {
          variant: 'secondary',
          iconName: 'download',
          testid: 'letter-download',
          ariaLabel: 'Download as a text file',
          onClick: () =>
            downloadText(
              `notrain-letter-${service.id}-${lt.kind}-${fileStamp()}.txt`,
              `Subject: ${lt.subject}\n${letter.to ? `To: ${letter.to}\n` : ''}\n${lt.body}`,
            ),
        }),
      ),
      target
        ? button('I’ve sent it', {
            variant: 'soft',
            iconName: 'check',
            testid: 'letter-sent',
            onClick: (e) =>
              act(e.currentTarget, () => api.recordLetter(service.id, target.id), {
                success: `Noted. ${service.name} is marked as “request sent”.`,
                failure: 'Couldn’t save',
              }),
          })
        : null,
    ),
    lt.edited && h('p', { class: 'nt-hint' }, 'Changing the details on the left rewrites the letter.'),
  );
}

export function render(ctx) {
  const { state } = ctx;
  const root = h('div', { class: 'l-wrap' });
  const header = pageHeader({
    title: 'Request letters',
    subtitle:
      'Where there’s no setting to switch off, a written request uses your legal rights. NoTrain fills in the details; you send it from your own email.',
  });

  if (!state.registry.services.length) {
    return [
      header,
      h(
        'div',
        { class: 'nt-card' },
        emptyState({
          iconName: 'letter',
          title: 'No services available',
          text: 'The service list hasn’t loaded yet.',
        }),
      ),
    ];
  }

  if (!lettersLib) {
    if (lettersError) {
      return [
        header,
        h(
          'div',
          { class: 'nt-card' },
          emptyState({
            iconName: 'alertCircle',
            title: 'Letters aren’t available',
            text: 'The letter templates couldn’t be loaded in this build.',
          }),
        ),
      ];
    }
    lettersReady.then(() => ctx.rerender());
    return [
      header,
      h(
        'div',
        { class: 'nt-card', style: { padding: '24px' } },
        h('span', { class: 'nt-skeleton nt-skeleton--title' }),
      ),
    ];
  }

  initFromRoute(ctx);
  const service = () => state.registry.services.find((s) => s.id === lt.serviceId);
  if (!lt.letter) regenerate(service());

  const draw = () => {
    const svc = service();
    mount(root, h('div', { class: 'l-grid' }, formPanel(ctx, svc, onChange), previewPanel(ctx, svc)));
  };
  function onChange({ soft } = {}) {
    regenerate(service());
    if (soft) {
      // Typing in name/email: refresh only the preview, keep focus in the field.
      const preview = root.querySelector('.l-preview');
      if (preview) preview.replaceWith(previewPanel(ctx, service()));
      return;
    }
    const active = document.activeElement?.id;
    draw();
    if (active) document.getElementById(active)?.focus();
  }
  draw();

  return [
    header,
    root,
    h(
      'div',
      { class: 'nt-callout nt-callout--neutral', 'data-testid': 'not-legal-advice' },
      icon('info'),
      h(
        'div',
        { class: 'nt-callout__body' },
        h('p', { class: 'nt-callout__title' }, 'Not legal advice'),
        h(
          'p',
          null,
          `NoTrain isn’t a law firm. These templates cite the laws that usually apply in ${regionLabel(lt.region)}; check they fit your situation. Companies can ask you to confirm your identity before acting on a request.`,
        ),
      ),
    ),
  ];
}
