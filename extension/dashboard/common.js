// Dashboard building blocks shared across views.

import { api, requestPermissions } from '../lib/api.js';
import { h } from '../shared/dom.js';
import { icon } from '../shared/icons.js';
import { monogram } from '../shared/monogram.js';
import { toast, announce } from '../shared/toast.js';
import { hostOf, describeOrigin } from '../shared/format.js';

export const REPO_URL = 'https://github.com/tayaa710/ai-opt-out';

/** Link to the registry correction issue template for a service. */
export function reportErrorUrl(service) {
  const title = `Correction: ${service?.name ?? 'service'} (${service?.id ?? ''})`;
  return `${REPO_URL}/issues/new?template=registry-correction.yml&title=${encodeURIComponent(title)}`;
}

export function suggestServiceUrl(query = '') {
  const title = query ? `Add service: ${query}` : 'Add service: ';
  return `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}`;
}

export function serviceHash(id, query = '') {
  return `#/service/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
}

/** Page heading block. The h1 receives focus on navigation (tabindex -1). */
export function pageHeader({ title, subtitle, actions, eyebrow }) {
  return h(
    'header',
    { class: 'd-page-head' },
    h(
      'div',
      { class: 'd-page-head__text' },
      eyebrow && h('p', { class: 'nt-eyebrow' }, eyebrow),
      h('h1', { class: 'd-page-title', tabindex: '-1', 'data-page-title': '' }, title),
      subtitle && h('p', { class: 'd-page-sub' }, subtitle),
    ),
    actions && h('div', { class: 'd-page-head__actions nt-btn-row' }, actions),
  );
}

/** Titled section. */
export function section({ title, id, description, actions, className }, ...children) {
  const headingId = id ? `${id}-title` : undefined;
  return h(
    'section',
    { class: ['d-section', className], 'aria-labelledby': headingId, id },
    (title || actions) &&
      h(
        'div',
        { class: 'd-section-head' },
        h(
          'div',
          { class: 'd-section-head__text' },
          title && h('h2', { class: 'd-section-title', id: headingId }, title),
          description && h('p', { class: 'd-section-desc' }, description),
        ),
        actions && h('div', { class: 'nt-btn-row' }, actions),
      ),
    children,
  );
}

export function emptyState({ iconName = 'inbox', title, text, actions, testid }) {
  return h(
    'div',
    { class: 'nt-empty', 'data-testid': testid },
    h('div', { class: 'nt-empty__icon' }, icon(iconName)),
    h('p', { class: 'nt-empty__title' }, title),
    text && h('p', { class: 'nt-empty__text' }, text),
    actions && h('div', { class: 'nt-btn-row' }, actions),
  );
}

/** Service identity: tile + name + company. */
export function serviceIdentity(service, { link = true, size = 'md', sub } = {}) {
  const name = link
    ? h('a', { class: 'd-ident__name', href: serviceHash(service.id) }, service.name)
    : h('span', { class: 'd-ident__name' }, service.name);
  return h(
    'div',
    { class: 'd-ident' },
    monogram(service, { size }),
    h('div', { class: 'd-ident__text' }, name, h('span', { class: 'd-ident__sub' }, sub ?? service.company)),
  );
}

/** Button element with optional icon. */
export function button(
  label,
  { variant = 'secondary', size, iconName, onClick, testid, ariaLabel, type = 'button', disabled, key } = {},
) {
  return h(
    'button',
    {
      type,
      class: ['nt-btn', `nt-btn--${variant}`, size && `nt-btn--${size}`],
      onClick,
      'data-testid': testid,
      'aria-label': ariaLabel,
      'data-key': key,
      disabled,
    },
    iconName && icon(iconName),
    label,
  );
}

/** Link styled as a button. */
export function linkButton(label, href, { variant = 'secondary', size, iconName, external, testid } = {}) {
  return h(
    'a',
    {
      class: ['nt-btn', `nt-btn--${variant}`, size && `nt-btn--${size}`],
      href,
      target: external ? '_blank' : null,
      rel: external ? 'noopener noreferrer' : null,
      'data-testid': testid,
    },
    iconName && icon(iconName),
    label,
    external && h('span', { class: 'nt-visually-hidden' }, ' (opens in a new tab)'),
  );
}

/**
 * Start an opt-out run. MUST be called synchronously from a click handler:
 * the permission request has to happen before any other await.
 * @param {object} service
 * @param {object} optOut
 * @param {'auto'|'guided'|'verify'} mode
 * @param {{ onStatus?: (s: { phase: string, message: string }) => void, button?: HTMLButtonElement }} [opts]
 * @returns {Promise<{ ok: boolean, injected?: boolean, reason?: string }>}
 */
export function startOptOut(service, optOut, mode, { onStatus, button: btn } = {}) {
  const needsHost = (mode === 'auto' || mode === 'verify') && optOut.automation;
  const origins = needsHost ? (optOut.automation.hostPermissions ?? []) : [];
  // Request first, synchronously within the user gesture.
  const permission = origins.length ? requestPermissions(origins).catch(() => false) : Promise.resolve(true);
  const report = (phase, message) => {
    onStatus?.({ phase, message });
    announce(message);
  };
  if (btn) {
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
  }
  return (async () => {
    try {
      const granted = await permission;
      if (!granted) {
        const site = origins.map(describeOrigin).join(', ');
        report(
          'denied',
          `NoTrain needs access to ${site} to do this for you. You can follow the steps yourself instead.`,
        );
        toast('Permission not granted. Follow the steps instead.', { tone: 'warn' });
        return { ok: false, reason: 'denied' };
      }
      report('starting', `Opening ${service.name}…`);
      const res = await api.runOptOut(service.id, optOut.id, mode);
      const host = hostOf(optOut.url);
      if (mode === 'guided') {
        report(
          'opened',
          res?.injected
            ? `Opened ${host}. NoTrain will point out each step on the page.`
            : `Opened ${host} in a new tab. Follow the steps below, then mark it as done.`,
        );
      } else if (res?.injected) {
        report(
          'opened',
          mode === 'verify'
            ? `Checking ${host} in a new tab. The result will show up here.`
            : `Working on ${host} in a new tab. You can watch it there; the result will show up here.`,
        );
      } else {
        report('fallback', `Opened ${host}, but NoTrain couldn’t run there. Follow the steps below instead.`);
      }
      return { ok: true, ...res };
    } catch (err) {
      report('error', `Couldn’t start: ${err.message}`);
      toast(`Couldn’t start: ${err.message}`, { tone: 'bad' });
      return { ok: false, reason: 'error' };
    } finally {
      if (btn?.isConnected) {
        btn.removeAttribute('aria-busy');
        btn.disabled = false;
      }
    }
  })();
}

/** Run an async API action with busy button + toast feedback. */
export async function act(btn, fn, { success, failure = 'Something went wrong' } = {}) {
  if (btn) {
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
  }
  try {
    const out = await fn();
    if (success) toast(typeof success === 'function' ? success(out) : success);
    return out;
  } catch (err) {
    toast(`${failure}: ${err.message}`, { tone: 'bad' });
    return undefined;
  } finally {
    if (btn?.isConnected) {
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }
  }
}

/** Trigger a file download of text content. */
export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

/** Copy text to the clipboard with a toast. */
export async function copyText(text, what = 'Text') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
    return true;
  } catch {
    // Fallback for contexts without clipboard permission.
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    let ok;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    toast(ok ? `${what} copied` : 'Couldn’t copy. Select the text and copy it yourself.', {
      tone: ok ? 'good' : 'bad',
    });
    return ok;
  }
}

/** A labelled switch row. */
export function switchField({ id, label, description, checked, onChange, disabled, testid }) {
  const descId = description ? `${id}-desc` : null;
  return h(
    'div',
    { class: 'd-switch-row' },
    h(
      'div',
      { class: 'd-switch-row__text' },
      h('label', { class: 'd-switch-row__label', for: id }, label),
      description && h('p', { class: 'd-switch-row__desc', id: descId }, description),
    ),
    h(
      'span',
      { class: 'nt-switch' },
      h('input', {
        type: 'checkbox',
        role: 'switch',
        class: 'nt-switch__input',
        id,
        checked: Boolean(checked),
        disabled,
        'aria-describedby': descId,
        'data-testid': testid,
        onChange,
      }),
      h('span', { class: 'nt-switch__track', 'aria-hidden': 'true' }),
    ),
  );
}

/** Native select wrapped with the custom chevron. */
export function selectField({ id, label, hint, value, options, onChange, testid }) {
  const hintId = hint ? `${id}-hint` : null;
  return h(
    'div',
    { class: 'nt-field' },
    label && h('label', { class: 'nt-label', for: id }, label),
    h(
      'span',
      { class: 'nt-select-wrap' },
      h(
        'select',
        { class: 'nt-select', id, 'aria-describedby': hintId, 'data-testid': testid, onChange },
        options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
      ),
    ),
    hint && h('p', { class: 'nt-hint', id: hintId }, hint),
  );
}

export function textField({
  id,
  label,
  hint,
  value,
  type = 'text',
  placeholder,
  onInput,
  onChange,
  autocomplete,
  testid,
}) {
  const hintId = hint ? `${id}-hint` : null;
  return h(
    'div',
    { class: 'nt-field' },
    h('label', { class: 'nt-label', for: id }, label),
    h('input', {
      class: 'nt-input',
      id,
      type,
      value: value ?? '',
      placeholder,
      autocomplete,
      'aria-describedby': hintId,
      'data-testid': testid,
      onInput,
      onChange,
    }),
    hint && h('p', { class: 'nt-hint', id: hintId }, hint),
  );
}

/* Run messages survive re-renders (storage updates re-render the page). */
const runMessages = new Map();

export function runKey(serviceId, optOutId) {
  return `${serviceId}/${optOutId}`;
}

export function getRunMessage(serviceId, optOutId) {
  return runMessages.get(runKey(serviceId, optOutId)) ?? null;
}

export function setRunMessage(serviceId, optOutId, status) {
  if (status) runMessages.set(runKey(serviceId, optOutId), { ...status, at: Date.now() });
  else runMessages.delete(runKey(serviceId, optOutId));
}

/** aria-live paragraph showing the latest run message for an opt-out. */
export function runLiveRegion(serviceId, optOutId, className = 'd-live') {
  const msg = getRunMessage(serviceId, optOutId);
  return h(
    'p',
    {
      class: [className, msg && `is-${msg.phase}`],
      role: 'status',
      'aria-live': 'polite',
      'data-testid': 'run-status',
      'data-key': `live-${serviceId}-${optOutId}`,
    },
    msg?.message ?? '',
  );
}

/** Match pattern for a detection cookie URL: https://chatgpt.com → https://chatgpt.com/* */
function originPattern(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** Host patterns needed for cookie-based account detection. */
export function detectionOrigins(services) {
  const set = new Set();
  for (const s of services)
    for (const c of s.detection?.cookies ?? []) {
      const p = originPattern(c.url);
      if (p) set.add(p);
    }
  return [...set];
}

/**
 * Account detection. MUST be called synchronously from a click handler.
 * @returns {Promise<{ detected: string[], checked: number }|null>} null if declined or failed
 */
export function detectAccountsFlow(services) {
  const origins = detectionOrigins(services);
  let perm;
  try {
    perm = requestPermissions(origins, ['cookies']);
  } catch (err) {
    perm = Promise.reject(err);
  }
  return (async () => {
    let granted;
    try {
      granted = await perm;
    } catch (err) {
      toast(`Couldn’t ask for permission: ${err.message}`, { tone: 'bad' });
      return null;
    }
    if (!granted) {
      toast('No problem. You can pick your services yourself.', { tone: 'info' });
      return null;
    }
    try {
      const res = await api.detectAccounts();
      const names = (res?.detected ?? [])
        .map((id) => services.find((s) => s.id === id)?.name)
        .filter(Boolean);
      if (names.length) {
        toast(
          `Found ${names.length === 1 ? '1 account' : `${names.length} accounts`}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`,
        );
      } else {
        toast('No signed-in accounts found. You can pick services yourself.', { tone: 'info' });
      }
      return res;
    } catch (err) {
      toast(`Detection failed: ${err.message}`, { tone: 'bad' });
      return null;
    }
  })();
}
