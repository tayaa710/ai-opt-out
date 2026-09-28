// Derived status: turns registry data + the user's stored progress into what
// the UI shows. Pure functions only, so they are unit-testable in Node.

import { OPT_OUT_STATUS } from './constants.js';
import { appliesToRegion } from './region.js';

/** Opt-out types that represent something the user can actually do. */
const ACTIONABLE_TYPES = new Set(['toggle', 'form', 'email']);

/**
 * @typedef {'not_tracked'|'protected'|'safe_by_default'|'action_needed'|'needs_attention'|'no_opt_out'|'not_in_region'} ServiceStatusCode
 * @typedef {{ code: ServiceStatusCode, label: string, tone: 'good'|'warn'|'bad'|'neutral', applicable: object[], done: number, pendingPolicyChange: boolean }} ServiceStatus
 */

export const STATUS_META = Object.freeze({
  not_tracked: { label: 'Not tracked', tone: 'neutral' },
  protected: { label: 'Opted out', tone: 'good' },
  safe_by_default: { label: 'Not training by default', tone: 'good' },
  action_needed: { label: 'Action needed', tone: 'warn' },
  needs_attention: { label: 'Needs attention', tone: 'bad' },
  no_opt_out: { label: 'No opt-out available', tone: 'neutral' },
  not_in_region: { label: 'No opt-out in your region', tone: 'neutral' },
});

/** Opt-outs from a service that apply to the user's region and can be acted on. */
export function applicableOptOuts(service, region) {
  return (service.optOuts ?? []).filter(
    (o) => ACTIONABLE_TYPES.has(o.type) && appliesToRegion(o.regions, region),
  );
}

/** The stored status of a single opt-out ('not_started' if absent). */
export function optOutStatus(userState, serviceId, optOutId) {
  return userState?.services?.[serviceId]?.optOuts?.[optOutId]?.status ?? OPT_OUT_STATUS.notStarted;
}

/** True if the registry has a policy version the user hasn't acknowledged yet, with severity warning or critical. */
export function hasPendingPolicyChange(service, serviceState) {
  if (!serviceState?.tracked) return false;
  const known = serviceState.knownPolicyVersion ?? service.policyVersion;
  if (service.policyVersion <= known) return false;
  return (service.changelog ?? []).some(
    (c) => c.version > known && (c.severity === 'warning' || c.severity === 'critical'),
  );
}

/**
 * @param {object} service registry entry
 * @param {object} userState stored user state
 * @param {string} region user region code
 * @returns {ServiceStatus}
 */
export function serviceStatus(service, userState, region) {
  const state = userState?.services?.[service.id];
  const applicable = applicableOptOuts(service, region);
  const statuses = applicable.map((o) => optOutStatus(userState, service.id, o.id));
  const done = statuses.filter((s) => s === OPT_OUT_STATUS.done || s === OPT_OUT_STATUS.sent).length;
  const pendingPolicyChange = hasPendingPolicyChange(service, state);
  const make = (code) => ({ code, ...STATUS_META[code], applicable, done, pendingPolicyChange });

  if (!state?.tracked) return make('not_tracked');
  if (pendingPolicyChange || statuses.includes(OPT_OUT_STATUS.needsAttention)) return make('needs_attention');
  if (done > 0) return make('protected');

  const t = service.training ?? {};
  if (t.trainsOnUserData === 'no' || t.defaultState === 'opted_out' || t.defaultState === 'not_applicable') {
    return make('safe_by_default');
  }
  if (applicable.length === 0) {
    const hasAnyActionable = (service.optOuts ?? []).some((o) => ACTIONABLE_TYPES.has(o.type));
    return make(hasAnyActionable ? 'not_in_region' : 'no_opt_out');
  }
  return make('action_needed');
}

/**
 * Summary numbers for the popup/dashboard header.
 * @returns {{ tracked: number, protected: number, actionNeeded: number, attention: number, informational: number }}
 */
export function summarize(services, userState, region) {
  const out = { tracked: 0, protected: 0, actionNeeded: 0, attention: 0, informational: 0 };
  for (const s of services) {
    const st = serviceStatus(s, userState, region);
    if (st.code === 'not_tracked') continue;
    out.tracked += 1;
    if (st.code === 'protected' || st.code === 'safe_by_default') out.protected += 1;
    else if (st.code === 'action_needed') out.actionNeeded += 1;
    else if (st.code === 'needs_attention') out.attention += 1;
    else out.informational += 1;
  }
  return out;
}

/** Sort order used by lists: most urgent first, then by name. */
const ORDER = ['needs_attention', 'action_needed', 'not_in_region', 'no_opt_out', 'protected', 'safe_by_default', 'not_tracked'];
export function compareByUrgency(a, b, userState, region) {
  const da = ORDER.indexOf(serviceStatus(a, userState, region).code);
  const db = ORDER.indexOf(serviceStatus(b, userState, region).code);
  return da - db || a.name.localeCompare(b.name);
}

/** Find the registry service matching a URL's hostname (exact or subdomain). */
export function serviceForUrl(services, url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  let best = null;
  let bestLen = 0;
  for (const s of services) {
    for (const d of s.domains ?? []) {
      if ((host === d || host.endsWith('.' + d)) && d.length > bestLen) {
        best = s;
        bestLen = d.length;
      }
    }
  }
  return best;
}
