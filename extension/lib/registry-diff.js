// Compares two registries and turns the differences into user alerts.
// Pure module: no chrome.* access.

import { ALERT_KINDS } from './constants.js';
import { makeAlert, maxSeverity } from './alerts.js';

/**
 * @typedef {{ service: object, fromVersion: number, toVersion: number, entries: object[], severity: string }} PolicyChange
 * @typedef {{ added: object[], removed: string[], changed: PolicyChange[] }} RegistryDiff
 */

/**
 * @param {{ services?: object[] } | null} prev
 * @param {{ services: object[] }} next
 * @returns {RegistryDiff}
 */
export function diffRegistries(prev, next) {
  const prevById = new Map((prev?.services ?? []).map((s) => [s.id, s]));
  const nextIds = new Set();
  const added = [];
  const changed = [];
  for (const service of next?.services ?? []) {
    nextIds.add(service.id);
    const before = prevById.get(service.id);
    if (!before) {
      added.push(service);
      continue;
    }
    if (service.policyVersion > before.policyVersion) {
      changed.push(policyChange(service, before.policyVersion));
    }
  }
  const removed = [...prevById.keys()].filter((id) => !nextIds.has(id));
  return { added, removed, changed };
}

/**
 * Changelog entries newer than `fromVersion`, newest first, and their severity.
 * @returns {PolicyChange}
 */
export function policyChange(service, fromVersion) {
  const entries = (service.changelog ?? [])
    .filter((e) => e.version > fromVersion && e.version <= service.policyVersion)
    .sort((a, b) => b.version - a.version);
  return {
    service,
    fromVersion,
    toVersion: service.policyVersion,
    entries,
    severity: maxSeverity(entries.map((e) => e.severity)),
  };
}

/** @param {PolicyChange} change */
export function policyChangeAlert(change, now = new Date()) {
  const { service, entries, severity, toVersion } = change;
  const title =
    severity === 'critical'
      ? `${service.name}: important change to AI training`
      : `${service.name} changed how it uses your data for AI`;
  const summaries = entries.slice(0, 3).map((e) => e.summary);
  const body =
    summaries.length > 0
      ? summaries.join(' ')
      : `${service.name}'s entry in the NoTrain registry was updated. Review your opt-outs.`;
  return makeAlert(
    { kind: ALERT_KINDS.policyChange, serviceId: service.id, severity, title, body, policyVersion: toVersion },
    now,
  );
}

/** One grouped alert for services that appeared in the registry. */
export function newServicesAlert(services, now = new Date()) {
  const names = services.map((s) => s.name);
  const shown = names.slice(0, 5).join(', ');
  const more = names.length > 5 ? ` and ${names.length - 5} more` : '';
  return makeAlert(
    {
      kind: ALERT_KINDS.newService,
      serviceId: services.length === 1 ? services[0].id : null,
      serviceIds: services.map((s) => s.id),
      severity: 'info',
      title: services.length === 1 ? `New in NoTrain: ${names[0]}` : `${services.length} new services in NoTrain`,
      body: `Now covered: ${shown}${more}. Track any you use to see how to opt out.`,
    },
    now,
  );
}

/**
 * Alerts for a registry update: a policy_change alert per *tracked* service
 * whose policyVersion increased (entries since the version the user already
 * knew about or the previous registry, whichever is newer) and one grouped
 * new_service alert.
 * @param {RegistryDiff} diff
 * @param {object} userState
 * @param {{ newServices?: boolean }} [options]
 * @returns {object[]}
 */
export function alertsForDiff(diff, userState, { newServices = true } = {}, now = new Date()) {
  const alerts = [];
  for (const change of diff.changed) {
    const rec = userState?.services?.[change.service.id];
    if (!rec?.tracked) continue;
    const known = Math.max(change.fromVersion, rec.knownPolicyVersion ?? 0);
    if (change.toVersion <= known) continue;
    const effective = known === change.fromVersion ? change : policyChange(change.service, known);
    alerts.push(policyChangeAlert(effective, now));
  }
  if (newServices && diff.added.length > 0) alerts.push(newServicesAlert(diff.added, now));
  return alerts;
}
