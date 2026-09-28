// Alerts: creation, de-duplication, capping and read/dismiss state. Pure
// functions operate on arrays; the service worker persists them via storage.js.

import { ALERT_KINDS, ALERTS_LIMIT, OPT_OUT_STATUS } from './constants.js';
import { UserError, isPlainObject, newId } from './storage.js';

export const ALERT_SEVERITIES = Object.freeze(['info', 'warning', 'critical']);
const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;

/** Highest of a list of severities ('info' for an empty list). */
export function maxSeverity(severities) {
  let best = 'info';
  for (const s of severities) if ((SEVERITY_RANK[s] ?? -1) > SEVERITY_RANK[best]) best = s;
  return best;
}

export function isUrgent(alert) {
  return alert.severity === 'warning' || alert.severity === 'critical';
}

/** Unread and not dismissed. */
export function isActive(alert) {
  return !alert.read && !alert.dismissed;
}

/**
 * @param {{ kind: string, serviceId?: string|null, optOutId?: string, severity?: string,
 *   title: string, body: string, [extra: string]: any }} fields
 * @param {Date} [now]
 */
export function makeAlert(fields, now = new Date()) {
  const { kind, serviceId = null, optOutId, severity = 'info', title, body, ...extra } = fields;
  const alert = {
    id: newId(),
    kind,
    serviceId,
    severity: ALERT_SEVERITIES.includes(severity) ? severity : 'info',
    title: String(title).slice(0, 200),
    body: String(body).slice(0, 1000),
    createdAt: now.toISOString(),
    read: false,
    dismissed: false,
    ...extra,
  };
  if (optOutId) alert.optOutId = optOutId;
  return alert;
}

/** Two alerts describe the same thing (used to avoid duplicates). */
function sameSubject(a, b) {
  return (
    a.kind === b.kind &&
    (a.serviceId ?? null) === (b.serviceId ?? null) &&
    (a.optOutId ?? null) === (b.optOutId ?? null) &&
    (a.policyVersion ?? null) === (b.policyVersion ?? null)
  );
}

/**
 * Prepends new alerts (newest first), skipping any that duplicate an alert the
 * user has not yet dealt with (a policy change for the same version is never
 * duplicated), and caps the list.
 * @returns {{ alerts: object[], added: object[] }}
 */
export function mergeAlerts(existing, incoming, limit = ALERTS_LIMIT) {
  const list = Array.isArray(existing) ? existing : [];
  const added = [];
  for (const a of incoming) {
    const dup = [...added, ...list].some(
      (b) => sameSubject(a, b) && (isActive(b) || a.kind === ALERT_KINDS.policyChange),
    );
    if (!dup) added.push(a);
  }
  const merged = [...added.slice().reverse(), ...list];
  merged.sort((x, y) => (y.createdAt > x.createdAt ? 1 : y.createdAt < x.createdAt ? -1 : 0));
  return { alerts: merged.slice(0, limit), added };
}

/**
 * @param {object[]} alerts
 * @param {string} id
 * @param {{ read?: boolean, dismissed?: boolean }} patch
 * @throws {UserError} if the alert does not exist or the patch is invalid
 */
export function markAlert(alerts, id, patch) {
  if (!isPlainObject(patch)) throw new UserError('patch must be an object');
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new UserError('patch must set read and/or dismissed');
  for (const k of keys) {
    if (k !== 'read' && k !== 'dismissed') throw new UserError(`Cannot change alert field "${k}"`);
    if (typeof patch[k] !== 'boolean') throw new UserError(`${k} must be a boolean`);
  }
  let found = false;
  const next = alerts.map((a) => {
    if (a.id !== id) return a;
    found = true;
    const updated = { ...a, ...patch };
    // Dismissing something implies the user has seen it.
    if (patch.dismissed === true) updated.read = true;
    return updated;
  });
  if (!found) throw new UserError('Unknown alert');
  return next;
}

export function markAllRead(alerts) {
  return alerts.map((a) => (a.read ? a : { ...a, read: true }));
}

/** Marks every policy-change alert of a service read (after acknowledgePolicy). */
export function markPolicyAlertsRead(alerts, serviceId) {
  return alerts.map((a) =>
    a.kind === ALERT_KINDS.policyChange && a.serviceId === serviceId && !a.read ? { ...a, read: true } : a,
  );
}

// ---------------------------------------------------------------------------
// Alert builders

/**
 * @param {object} service registry entry
 * @param {object} optOut registry opt-out
 * @param {'verify'|'passive'} via
 */
export function flipBackAlert(service, optOut, via, now = new Date()) {
  const how = via === 'passive' ? 'while you were on the site' : 'during a re-check';
  return makeAlert(
    {
      kind: ALERT_KINDS.flipBack,
      serviceId: service.id,
      optOutId: optOut.id,
      severity: 'warning',
      title: `${service.name}: AI training setting is back on`,
      body:
        `NoTrain noticed ${how} that “${optOut.title}” is no longer in the opted-out state. ` +
        'Open the service in NoTrain to turn it off again.',
    },
    now,
  );
}

/**
 * Reminder alerts for tracked services whose `done` opt-outs were last
 * verified (or updated) more than `settings.reminderIntervalDays` ago.
 * At most one per service, and none if one was created within the interval.
 * @returns {object[]} new alerts
 */
export function dueReminders({ registry, userState, settings, alerts }, now = new Date()) {
  const intervalMs = settings.reminderIntervalDays * DAY_MS;
  const cutoff = now.getTime() - intervalMs;
  const out = [];
  for (const service of registry?.services ?? []) {
    const state = userState.services?.[service.id];
    if (!state?.tracked) continue;
    const stale = service.optOuts.filter((o) => {
      const rec = state.optOuts?.[o.id];
      if (rec?.status !== OPT_OUT_STATUS.done) return false;
      const last = Date.parse(rec.verifiedAt ?? rec.updatedAt ?? '');
      return Number.isNaN(last) || last < cutoff;
    });
    if (stale.length === 0) continue;
    const recent = (alerts ?? []).some(
      (a) =>
        a.kind === ALERT_KINDS.reminder &&
        a.serviceId === service.id &&
        (isActive(a) || Date.parse(a.createdAt) > cutoff),
    );
    if (recent) continue;
    out.push(
      makeAlert(
        {
          kind: ALERT_KINDS.reminder,
          serviceId: service.id,
          severity: 'info',
          title: `Time to re-check ${service.name}`,
          body:
            `It has been more than ${settings.reminderIntervalDays} days since you last confirmed your ` +
            `${service.name} opt-out. App updates sometimes reset privacy settings, so it is worth a quick check.`,
        },
        now,
      ),
    );
  }
  return out;
}
