// Pure userState transitions. Each function takes the current (normalised)
// userState and returns a new object; nothing here touches chrome.* APIs.

import { METHODS, OPT_OUT_STATUS, RUN_OUTCOMES } from './constants.js';
import { NOTE_MAX, SOURCES, UserError, clone } from './storage.js';

/** Statuses that mean the user acted on the service (and so imply tracking). */
const ENGAGED = new Set([OPT_OUT_STATUS.done, OPT_OUT_STATUS.sent, OPT_OUT_STATUS.needsAttention]);

export function findService(registry, serviceId) {
  return registry?.services?.find((s) => s.id === serviceId) ?? null;
}

export function findOptOut(service, optOutId) {
  return service?.optOuts?.find((o) => o.id === optOutId) ?? null;
}

/**
 * Looks up a service and (optionally) one of its opt-outs.
 * @throws {UserError} if either is unknown
 */
export function requireServiceOptOut(registry, serviceId, optOutId) {
  const service = findService(registry, serviceId);
  if (!service) throw new UserError(`Unknown service "${serviceId}"`);
  if (optOutId === undefined) return { service, optOut: null };
  const optOut = findOptOut(service, optOutId);
  if (!optOut) throw new UserError(`Unknown opt-out "${optOutId}" for ${service.name}`);
  return { service, optOut };
}

function serviceRecord(userState, serviceId) {
  return userState.services[serviceId] ?? null;
}

/**
 * Starts tracking a service, or leaves an already-tracked one untouched.
 * `knownPolicyVersion` is set to the current version so only future policy
 * changes alert the user. Existing opt-out progress is preserved.
 */
function trackOne(userState, service, source, now) {
  const rec = serviceRecord(userState, service.id);
  if (rec?.tracked) return;
  userState.services[service.id] = {
    ...(rec ?? {}),
    tracked: true,
    source,
    addedAt: now.toISOString(),
    knownPolicyVersion: service.policyVersion,
    optOuts: rec?.optOuts ?? {},
  };
}

/**
 * @param {object} userState
 * @param {object} registry
 * @param {{ serviceIds: string[], tracked: boolean, source?: string }} payload
 * @param {Date} [now]
 */
export function trackServices(
  userState,
  registry,
  { serviceIds, tracked, source = 'manual' },
  now = new Date(),
) {
  if (!SOURCES.includes(source)) throw new UserError('source must be "manual" or "detected"');
  const services = serviceIds.map((id) => requireServiceOptOut(registry, id).service);
  const next = clone(userState);
  for (const service of services) {
    if (tracked) {
      trackOne(next, service, source, now);
    } else {
      const rec = serviceRecord(next, service.id);
      if (rec) rec.tracked = false;
    }
  }
  return next;
}

/**
 * Sets the status of one opt-out. Marking something done/sent/needs attention
 * on an untracked service starts tracking it (source "manual").
 * @param {object} userState
 * @param {object} service registry entry
 * @param {object} optOut registry opt-out
 * @param {{ status: string, method: string, note?: string, verified?: boolean, lastOutcome?: string }} change
 * @param {Date} [now]
 */
export function setOptOutStatus(userState, service, optOut, change, now = new Date()) {
  const { status, method, note, verified = false, lastOutcome } = change;
  if (!Object.values(OPT_OUT_STATUS).includes(status)) throw new UserError(`Unknown status "${status}"`);
  if (!METHODS.includes(method)) throw new UserError(`Unknown method "${method}"`);
  const next = clone(userState);
  if (ENGAGED.has(status)) trackOne(next, service, 'manual', now);
  const rec =
    next.services[service.id] ??
    (next.services[service.id] = {
      tracked: false,
      source: 'manual',
      addedAt: now.toISOString(),
      optOuts: {},
    });
  const prev = rec.optOuts[optOut.id];
  const entry = {
    status,
    method,
    updatedAt: now.toISOString(),
    verifiedAt: verified ? now.toISOString() : null,
  };
  if (lastOutcome) entry.lastOutcome = lastOutcome;
  else if (prev?.lastOutcome) entry.lastOutcome = prev.lastOutcome;
  if (typeof note === 'string' && note.trim() !== '') entry.note = note.trim().slice(0, NOTE_MAX);
  else if (note === undefined && prev?.note) entry.note = prev.note;
  rec.optOuts[optOut.id] = entry;
  return next;
}

/** Records the last run outcome without changing the status. */
export function recordOutcome(userState, service, optOut, outcome, method, now = new Date()) {
  const next = clone(userState);
  const rec =
    next.services[service.id] ??
    (next.services[service.id] = {
      tracked: false,
      source: 'manual',
      addedAt: now.toISOString(),
      optOuts: {},
    });
  const prev = rec.optOuts[optOut.id];
  if (prev) {
    rec.optOuts[optOut.id] = { ...prev, lastOutcome: outcome };
  } else {
    rec.optOuts[optOut.id] = {
      status: OPT_OUT_STATUS.notStarted,
      method,
      updatedAt: now.toISOString(),
      verifiedAt: null,
      lastOutcome: outcome,
    };
  }
  return next;
}

/**
 * Applies an outcome reported by the in-page engine (see ARCHITECTURE.md
 * "Opt-out run flow"):
 * - success/already → done, verified now (method auto; verify keeps the
 *   previous method; guided mode → guided)
 * - mismatch → needs_attention (flip-back)
 * - anything else → status unchanged, lastOutcome stored
 * @returns {{ userState: object, flipBack: boolean, statusChanged: boolean }}
 */
export function applyRunOutcome(userState, service, optOut, { mode, outcome }, now = new Date()) {
  const prev = userState.services?.[service.id]?.optOuts?.[optOut.id];
  if (outcome === RUN_OUTCOMES.success || outcome === RUN_OUTCOMES.already) {
    let method = 'auto';
    if (mode === 'guided') method = 'guided';
    else if (mode === 'verify') method = prev?.method ?? 'auto';
    const next = setOptOutStatus(
      userState,
      service,
      optOut,
      { status: OPT_OUT_STATUS.done, method, verified: true, lastOutcome: outcome },
      now,
    );
    return { userState: next, flipBack: false, statusChanged: prev?.status !== OPT_OUT_STATUS.done };
  }
  if (outcome === RUN_OUTCOMES.mismatch) {
    const next = setOptOutStatus(
      userState,
      service,
      optOut,
      { status: OPT_OUT_STATUS.needsAttention, method: prev?.method ?? 'auto', lastOutcome: outcome },
      now,
    );
    return {
      userState: next,
      flipBack: prev?.status !== OPT_OUT_STATUS.needsAttention,
      statusChanged: prev?.status !== OPT_OUT_STATUS.needsAttention,
    };
  }
  const method = mode === 'guided' ? 'guided' : 'auto';
  return {
    userState: recordOutcome(userState, service, optOut, outcome, method, now),
    flipBack: false,
    statusChanged: false,
  };
}

/** Sets knownPolicyVersion to the registry's current version. */
export function acknowledgePolicy(userState, service) {
  const next = clone(userState);
  const rec = next.services[service.id];
  if (!rec) throw new UserError(`${service.name} is not tracked`);
  rec.knownPolicyVersion = service.policyVersion;
  return next;
}

/** Refreshes verifiedAt of a done opt-out (passive check saw it still off). */
export function touchVerified(userState, serviceId, optOutId, now = new Date()) {
  const rec = userState.services?.[serviceId]?.optOuts?.[optOutId];
  if (!rec || rec.status !== OPT_OUT_STATUS.done) return userState;
  const next = clone(userState);
  next.services[serviceId].optOuts[optOutId].verifiedAt = now.toISOString();
  return next;
}
