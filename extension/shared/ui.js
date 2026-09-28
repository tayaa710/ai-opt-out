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
      const existing = contexts.find((c) => c.tabId >= 0 && typeof c.documentUrl === 'string' && c.documentUrl.startsWith(base));
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
const EFFORT_RANK = { quick: 0, moderate: 1, involved: 2 };
const TYPE_RANK = { toggle: 0, form: 1, email: 2 };

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

/** Applicable opt-outs still to do, easiest first (automated, then quick, then toggles). */
export function pendingOptOuts(service, userState, status) {
  return status.applicable
    .filter((o) => PENDING.has(optOutStatus(userState, service.id, o.id)))
    .sort(
      (a, b) =>
        Number(Boolean(b.automation)) - Number(Boolean(a.automation)) ||
        (EFFORT_RANK[a.effort] ?? 3) - (EFFORT_RANK[b.effort] ?? 3) ||
        (TYPE_RANK[a.type] ?? 3) - (TYPE_RANK[b.type] ?? 3),
    );
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
 * @param {{ value: number, total: number, size?: number, stroke?: number, tone?: 'good'|'warn'|'bad', label?: string }} opts
 */
export function progressRing({ value, total, size = 64, stroke = 7, tone = 'good', label }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  const ring = s(
    'svg',
    { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true', focusable: 'false' },
    s('circle', { class: 'nt-ring__track', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke }),
    frac > 0 &&
      s('circle', {
        class: ['nt-ring__value', tone !== 'good' && `nt-ring__value--${tone}`],
        cx: size / 2,
        cy: size / 2,
        r,
        'stroke-width': stroke,
        'stroke-dasharray': `${c} ${c}`,
        'stroke-dashoffset': String(c * (1 - frac)),
      }),
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

/**
 * Headline + supporting line for the protection summary.
 * @param {{ tracked: number, protected: number, actionNeeded: number, attention: number, informational: number }} sum
 */
export function summaryCopy(sum) {
  if (sum.tracked === 0) {
    return { tone: 'neutral', headline: 'No services yet', detail: 'Pick the services you use to see where you stand.' };
  }
  const covered = `${sum.protected} of ${sum.tracked} opted out or not training by default.`;
  if (sum.attention > 0) {
    return {
      tone: 'bad',
      headline: sum.attention === 1 ? '1 service needs attention' : `${sum.attention} services need attention`,
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
