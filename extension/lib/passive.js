// Passive flip-back checks (ARCHITECTURE.md "Monitoring"). For tracked
// services with a `done` toggle opt-out that has read-only `verify` steps and
// a granted host permission, a content script (engine + passive-check) is
// registered on the service's pages. It asks which checks apply, runs only the
// read-only assertions, and reports the toggle state it saw.

import { OPT_OUT_STATUS, RUN_OUTCOMES, STORAGE_KEYS } from './constants.js';
import { UserError, readLocal, updateLocal } from './storage.js';
import { allowedHostPatterns, hasPermissions, manifestHostPatterns, urlMatchesAny } from './permissions.js';
import { findOptOut, findService, setOptOutStatus, touchVerified } from './user-state.js';
import { flipBackAlert, mergeAlerts } from './alerts.js';
import { appendHistory, makeHistoryEntry } from './history.js';
import { notify } from './notify.js';

export const PASSIVE_PREFIX = 'notrain-passive-';
export const PASSIVE_FILES = Object.freeze(['content/engine.js', 'content/passive-check.js']);
export const PASSIVE_STATES = Object.freeze(['on', 'off', 'unknown']);
/** A passive "still off" result refreshes verifiedAt at most this often. */
export const VERIFY_REFRESH_MS = 6 * 60 * 60 * 1000;

const K = STORAGE_KEYS;

/**
 * The state the toggle should be in once opted out: the last assertToggle of
 * the verify steps, else the last setToggle of the steps, else "off".
 */
export function expectedToggleState(optOut) {
  const find = (steps, action) => {
    for (let i = (steps?.length ?? 0) - 1; i >= 0; i -= 1) {
      if (steps[i].action === action && (steps[i].state === 'on' || steps[i].state === 'off'))
        return steps[i].state;
    }
    return null;
  };
  return (
    find(optOut.automation?.verify, 'assertToggle') ?? find(optOut.automation?.steps, 'setToggle') ?? 'off'
  );
}

/**
 * Passive checks the user's state calls for, before checking permissions.
 * @returns {Map<string, { serviceId: string, checks: { optOutId: string, patterns: string[] }[] }>}
 */
export function passiveCandidates({ registry, userState, settings }, declared = manifestHostPatterns()) {
  const out = new Map();
  if (!settings?.passiveChecks) return out;
  for (const service of registry?.services ?? []) {
    const rec = userState?.services?.[service.id];
    if (!rec?.tracked) continue;
    for (const optOut of service.optOuts) {
      if (optOut.type !== 'toggle') continue;
      if (rec.optOuts?.[optOut.id]?.status !== OPT_OUT_STATUS.done) continue;
      if (!(optOut.automation?.verify?.length > 0)) continue;
      const patterns = allowedHostPatterns(optOut, declared);
      if (patterns.length === 0) continue;
      const entry = out.get(service.id) ?? { serviceId: service.id, checks: [] };
      entry.checks.push({ optOutId: optOut.id, patterns });
      out.set(service.id, entry);
    }
  }
  return out;
}

/**
 * Candidates whose host permissions are currently granted.
 * @returns {Promise<Map<string, { serviceId: string, patterns: string[],
 *   checks: { optOutId: string, patterns: string[] }[] }>>}
 */
export async function activePassiveChecks(state, declared) {
  const cache = new Map();
  const granted = async (patterns) => {
    const key = patterns.join(' ');
    if (!cache.has(key)) cache.set(key, await hasPermissions({ origins: patterns }));
    return cache.get(key);
  };
  const out = new Map();
  for (const [serviceId, entry] of passiveCandidates(state, declared)) {
    const checks = [];
    for (const check of entry.checks) if (await granted(check.patterns)) checks.push(check);
    if (checks.length === 0) continue;
    const patterns = [...new Set(checks.flatMap((c) => c.patterns))].sort();
    out.set(serviceId, { serviceId, patterns, checks });
  }
  return out;
}

function sameRegistration(existing, patterns) {
  const a = [...(existing.matches ?? [])].sort();
  const js = existing.js ?? [];
  return (
    a.length === patterns.length &&
    a.every((p, i) => p === patterns[i]) &&
    js.length === PASSIVE_FILES.length &&
    js.every((f, i) => f === PASSIVE_FILES[i])
  );
}

async function register(scripting, id, patterns) {
  const script = {
    id,
    matches: patterns,
    js: [...PASSIVE_FILES],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  };
  try {
    await scripting.registerContentScripts([script]);
  } catch (err) {
    // Some Firefox versions reject persistAcrossSessions; registrations are
    // re-synced on every startup anyway.
    try {
      await scripting.registerContentScripts([{ ...script, persistAcrossSessions: false }]);
    } catch {
      console.warn(`NoTrain: could not register passive check ${id}`, err);
    }
  }
}

async function syncOnce() {
  const scripting = globalThis.chrome?.scripting;
  if (!scripting?.registerContentScripts || !scripting.getRegisteredContentScripts) return;
  try {
    const state = await readLocal([K.registry, K.userState, K.settings]);
    const desired = await activePassiveChecks(state);
    const existing = (await scripting.getRegisteredContentScripts()).filter((s) =>
      s.id.startsWith(PASSIVE_PREFIX),
    );
    const keep = new Set();
    const remove = [];
    for (const s of existing) {
      const want = desired.get(s.id.slice(PASSIVE_PREFIX.length));
      if (want && sameRegistration(s, want.patterns)) keep.add(s.id);
      else remove.push(s.id);
    }
    if (remove.length > 0) await scripting.unregisterContentScripts({ ids: remove });
    for (const [serviceId, want] of desired) {
      const id = `${PASSIVE_PREFIX}${serviceId}`;
      if (!keep.has(id)) await register(scripting, id, want.patterns);
    }
  } catch (err) {
    console.warn('NoTrain: passive check sync failed', err);
  }
}

let running = null;
let again = false;

/**
 * Brings the registered passive-check content scripts in line with the
 * current state and granted permissions. Calls made while a sync is running
 * are coalesced into one follow-up sync. Never throws.
 */
export function syncPassiveRegistrations() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await syncOnce();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Removes every passive-check registration (used by resetAll). */
export async function unregisterAllPassive() {
  const scripting = globalThis.chrome?.scripting;
  if (!scripting?.getRegisteredContentScripts) return;
  try {
    const ids = (await scripting.getRegisteredContentScripts())
      .map((s) => s.id)
      .filter((id) => id.startsWith(PASSIVE_PREFIX));
    if (ids.length) await scripting.unregisterContentScripts({ ids });
  } catch (err) {
    console.warn('NoTrain: could not unregister passive checks', err);
  }
}

/**
 * `getPassiveChecks` from the passive-check content script. The page URL comes
 * from the browser (sender.url), never from the message.
 * @returns {Promise<{ checks: { serviceId: string, optOutId: string, verify: object[], expected: string }[] }>}
 */
export async function getPassiveChecks(_msg, sender) {
  const state = await readLocal([K.registry, K.userState, K.settings]);
  const active = await activePassiveChecks(state);
  const checks = [];
  for (const entry of active.values()) {
    const service = findService(state[K.registry], entry.serviceId);
    for (const c of entry.checks) {
      if (!urlMatchesAny(sender.url, c.patterns)) continue;
      const optOut = findOptOut(service, c.optOutId);
      checks.push({
        serviceId: entry.serviceId,
        optOutId: c.optOutId,
        verify: optOut.automation.verify,
        expected: expectedToggleState(optOut),
      });
    }
  }
  return { checks };
}

/**
 * `passiveCheckResult`: a toggle in the wrong state is a flip-back
 * (needs_attention + alert + notification); the right state refreshes
 * verifiedAt; "unknown" is ignored.
 */
export async function handlePassiveResult(msg, sender, { now = new Date() } = {}) {
  const state = await readLocal([K.registry, K.userState, K.settings]);
  const entry = (await activePassiveChecks(state)).get(msg.serviceId);
  const check = entry?.checks.find((c) => c.optOutId === msg.optOutId);
  if (!check || !urlMatchesAny(sender.url, check.patterns))
    throw new UserError('No passive check for this page');
  if (msg.state === 'unknown') return { recorded: false };

  const { alert, notifyFlips } = await updateLocal(
    [K.registry, K.userState, K.history, K.alerts, K.settings],
    (v) => {
      const service = findService(v[K.registry], msg.serviceId);
      const optOut = findOptOut(service, msg.optOutId);
      const rec = v[K.userState].services[msg.serviceId]?.optOuts?.[msg.optOutId];
      if (!service || !optOut || rec?.status !== OPT_OUT_STATUS.done) return { result: {} };
      if (msg.state === expectedToggleState(optOut)) {
        const last = Date.parse(rec.verifiedAt ?? '');
        if (!Number.isNaN(last) && now.getTime() - last < VERIFY_REFRESH_MS) return { result: {} };
        return {
          set: { [K.userState]: touchVerified(v[K.userState], service.id, optOut.id, now) },
          result: {},
        };
      }
      const userState = setOptOutStatus(
        v[K.userState],
        service,
        optOut,
        { status: OPT_OUT_STATUS.needsAttention, method: rec.method, lastOutcome: RUN_OUTCOMES.mismatch },
        now,
      );
      const entryH = makeHistoryEntry(
        {
          serviceId: service.id,
          optOutId: optOut.id,
          action: 'passive',
          outcome: RUN_OUTCOMES.mismatch,
          detail: 'Setting found switched back on while you visited the site.',
        },
        now,
      );
      const merged = mergeAlerts(v[K.alerts], [flipBackAlert(service, optOut, 'passive', now)]);
      return {
        set: {
          [K.userState]: userState,
          [K.history]: appendHistory(v[K.history], entryH),
          [K.alerts]: merged.alerts,
        },
        result: { alert: merged.added[0] ?? null, notifyFlips: v[K.settings].notifications.flipBacks },
      };
    },
  );
  if (alert && notifyFlips) {
    await notify({ kind: alert.kind, serviceId: alert.serviceId, title: alert.title, message: alert.body });
  }
  return { recorded: true };
}
