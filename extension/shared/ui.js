// View building blocks shared by the popup and the dashboard.

import { h, s } from './dom.js';
import { icon } from './icons.js';
import { OPT_OUT_STATUS } from '../lib/constants.js';
import { optOutStatus, serviceStatus } from '../lib/status.js';

/* ---------- Navigation ---------- */

export const DASHBOARD_PATH = 'dashboard/dashboard.html';

export function dashboardUrl(hash = '#/overview') {
  return chrome.runtime.getURL(DASHBOARD_PATH) + (hash.startsWith('#') ? hash : `#${hash}`);
}

/**
 * Open the dashboard at `hash`, reusing an open dashboard tab when possible.
 * @param {string} hash e.g. '#/service/chatgpt'
 */
export async function openDashboard(hash = '#/overview') {
  const url = dashboardUrl(hash);
  const base = chrome.runtime.getURL(DASHBOARD_PATH);
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const existing = contexts.find(
        (c) => c.tabId >= 0 && typeof c.documentUrl === 'string' && c.documentUrl.startsWith(base),
      );
      if (existing) {
        const tab = await chrome.tabs.update(existing.tabId, { url, active: true });
        if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    }
  } catch {
    // Fall through to a new tab.
  }
  await chrome.tabs.create({ url });
}

/* ---------- Status ---------- */

const PENDING = new Set([OPT_OUT_STATUS.notStarted, OPT_OUT_STATUS.needsAttention]);

/** Status pill for a derived service status. */
export function statusPill(status, attrs = {}) {
  return h('span', { class: ['nt-pill', `nt-pill--${status.tone}`], ...attrs }, status.label);
}

/** Short reason text for a needs-attention service. */
export function attentionReason(service, userState, status) {
  if (status.pendingPolicyChange) return 'Policy changed';
  const flipped = status.applicable.some(
    (o) => optOutStatus(userState, service.id, o.id) === OPT_OUT_STATUS.needsAttention,
  );
  return flipped ? 'Setting was turned back on' : 'Needs a look';
}

/**
 * Applicable opt-outs still to do, in registry order (the registry lists the
 * main control first, so it stays the recommended one).
 */
export function pendingOptOuts(service, userState, status) {
  return status.applicable.filter((o) => PENDING.has(optOutStatus(userState, service.id, o.id)));
}

/**
 * The single most useful next action for a service.
 * @returns {{ kind: 'auto'|'guide'|'letter'|'review'|'details', label: string, optOut?: object, status: object }}
 */
export function primaryAction(service, userState, region) {
  const status = serviceStatus(service, userState, region);
  if (status.code === 'needs_attention') {
    if (status.pendingPolicyChange) return { kind: 'review', label: 'Review', status };
    const flipped = status.applicable.find(
      (o) => optOutStatus(userState, service.id, o.id) === OPT_OUT_STATUS.needsAttention,
    );
    if (flipped?.automation) return { kind: 'auto', label: 'Fix it', optOut: flipped, status };
    if (flipped) return { kind: 'guide', label: 'Fix it', optOut: flipped, status };
    return { kind: 'details', label: 'Review', status };
  }
  if (status.code === 'action_needed') {
    const [next] = pendingOptOuts(service, userState, status);
    if (!next) return { kind: 'details', label: 'Details', status };
    if (next.automation) return { kind: 'auto', label: 'Opt out', optOut: next, status };
    if (next.type === 'email') return { kind: 'letter', label: 'Write letter', optOut: next, status };
    return { kind: 'guide', label: 'Show me how', optOut: next, status };
  }
  return { kind: 'details', label: 'Details', status };
}

/* ---------- Progress ring ---------- */

/**
 * Ring meter. The centre shows value/total; the arc is split into coloured
 * segments (e.g. done / to do / attention) so the state reads at a glance.
 * @param {{ value: number, total: number, size?: number, stroke?: number, label?: string,
 *   segments?: { value: number, tone: 'good'|'warn'|'bad' }[] }} opts
 */
export function progressRing({ value, total, size = 64, stroke = 7, label, segments }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const segs = (segments ?? [{ value, tone: 'good' }]).filter((sg) => sg.value > 0);
  const gap = segs.length > 1 ? Math.min(3, c * 0.012) : 0;
  let start = 0;
  const arcs = [];
  for (const sg of segs) {
    const frac = total > 0 ? Math.min(1, sg.value / total) : 0;
    const len = Math.max(0, frac * c - gap);
    arcs.push(
      s('circle', {
        class: ['nt-ring__value', sg.tone !== 'good' && `nt-ring__value--${sg.tone}`],
        cx: size / 2,
        cy: size / 2,
        r,
        'stroke-width': stroke,
        'stroke-dasharray': `${len} ${c}`,
        'stroke-dashoffset': String(-start * c - gap / 2),
      }),
    );
    start += frac;
  }
  const ring = s(
    'svg',
    { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true', focusable: 'false' },
    s('circle', { class: 'nt-ring__track', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke }),
    ...arcs,
  );
  return h(
    'div',
    {
      class: 'nt-ring',
      role: 'img',
      'aria-label': label ?? `${value} of ${total}`,
      style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size / 3.4)}px` },
    },
    ring,
    h(
      'div',
      { class: 'nt-ring__label', 'aria-hidden': 'true' },
      h('span', { class: 'nt-ring__num' }, String(value)),
      h('span', { class: 'nt-ring__of' }, `of ${total}`),
    ),
  );
}

/** Ring segments for a summary: done (green), to do (amber), attention (red). */
export function summarySegments(sum) {
  return [
    { value: sum.protected, tone: 'good' },
    { value: sum.actionNeeded, tone: 'warn' },
    { value: sum.attention, tone: 'bad' },
  ];
}

/**
 * Headline + supporting line for the protection summary.
 * @param {{ tracked: number, protected: number, actionNeeded: number, attention: number, informational: number }} sum
 */
export function summaryCopy(sum) {
  if (sum.tracked === 0) {
    return {
      tone: 'neutral',
      headline: 'No services yet',
      detail: 'Pick the services you use to see where you stand.',
    };
  }
  const covered = `${sum.protected} of ${sum.tracked} opted out or not training by default.`;
  if (sum.attention > 0) {
    return {
      tone: 'bad',
      headline:
        sum.attention === 1 ? '1 service needs attention' : `${sum.attention} services need attention`,
      detail: covered,
    };
  }
  if (sum.actionNeeded > 0) {
    return {
      tone: 'warn',
      headline: sum.actionNeeded === 1 ? '1 opt-out left to do' : `${sum.actionNeeded} opt-outs left to do`,
      detail: covered,
    };
  }
  if (sum.informational > 0 && sum.protected === 0) {
    return {
      tone: 'neutral',
      headline: 'Nothing to switch off',
      detail: 'Your services don’t offer an opt-out where you live. A request letter may still help.',
    };
  }
  return {
    tone: 'good',
    headline: 'You’re all set',
    detail:
      sum.informational > 0
        ? `${covered} The rest have no opt-out in your region.`
        : 'Every service you track is opted out or doesn’t train by default.',
  };
}

/** Busy state for a button while an async action runs. */
export async function withBusy(button, fn) {
  if (!button) return fn();
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

/** Small inline "External" affordance for links that open a site. */
export function externalIcon() {
  return icon('external', { size: 14 });
}
