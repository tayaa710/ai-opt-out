// Opt-in account detection (ARCHITECTURE.md "Account detection"). The UI
// requests `cookies` + the detection origins in a click handler, then sends
// `detectAccounts`. We check only the *presence* of known sign-in cookies,
// track the services found, and then give back the `cookies` permission and
// every detection origin that was granted just for this detection.
//
// Which origins were "just granted"? chrome.permissions.onAdded reports only
// permissions that were newly added, so the service worker logs every grant
// (recordPermissionGrant) and detection removes the origins from the grant
// that carried the `cookies` permission. Origins the user had granted earlier
// (e.g. for one-click opt-outs) are never in that event and are kept.

import { STORAGE_KEYS } from './constants.js';
import { SESSION_KEYS, UserError, readLocal, readSession, updateLocal, updateSession } from './storage.js';
import { detectionOrigins, hasPermissions, isDeclared, manifestHostPatterns, originPattern } from './permissions.js';
import { findService, trackServices } from './user-state.js';

/** Grant events this recent count as part of the current detection. */
export const GRANT_WINDOW_MS = 60_000;
/** Grant events are forgotten after this long. */
export const GRANT_LOG_TTL_MS = 10 * 60_000;
/** How long detection waits for a permissions.onAdded event still in flight. */
export const GRANT_WAIT_MS = 1_500;

const K = STORAGE_KEYS;
const waiters = new Set();

/**
 * permissions.onAdded listener: remembers what was granted, and when.
 * @param {{ permissions?: string[], origins?: string[] }} added
 */
export async function recordPermissionGrant(added, now = Date.now()) {
  const entry = { at: now, permissions: [...(added?.permissions ?? [])], origins: [...(added?.origins ?? [])] };
  await updateSession(SESSION_KEYS.grants, [], (log) => ({
    value: [...(Array.isArray(log) ? log : []).filter((e) => now - e.at < GRANT_LOG_TTL_MS), entry],
  }));
  for (const wake of [...waiters]) wake();
}

/**
 * permissions.onRemoved listener: forget grants that no longer exist.
 * @param {{ permissions?: string[], origins?: string[] }} removed
 */
export async function recordPermissionRemoval(removed) {
  const perms = new Set(removed?.permissions ?? []);
  const origins = new Set(removed?.origins ?? []);
  await updateSession(SESSION_KEYS.grants, [], (log) => ({
    value: (Array.isArray(log) ? log : [])
      .map((e) => ({
        ...e,
        permissions: e.permissions.filter((p) => !perms.has(p)),
        origins: e.origins.filter((o) => !origins.has(o)),
      }))
      .filter((e) => e.permissions.length > 0 || e.origins.length > 0),
  }));
}

function waitForGrant(timeoutMs) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    waiters.add(done);
  });
}

function recentGrants(log, now) {
  return (Array.isArray(log) ? log : []).filter((e) => now - e.at <= GRANT_WINDOW_MS);
}

/**
 * Origins granted for the current detection. If a recent grant included the
 * `cookies` permission, that grant *is* the detection request and only its
 * origins count; otherwise (cookies was already held) any recent grant counts.
 */
export function newlyGrantedOrigins(log, now = Date.now()) {
  const recent = recentGrants(log, now);
  const withCookies = recent.filter((e) => e.permissions.includes('cookies'));
  return [...new Set((withCookies.length > 0 ? withCookies : recent).flatMap((e) => e.origins))];
}

async function cookiePresent(url, name) {
  try {
    // Presence only: the returned cookie (and its value) is dropped right here
    // and never stored, logged or sent anywhere.
    const cookie = await globalThis.chrome.cookies.get({ url, name });
    return cookie != null;
  } catch {
    return false;
  }
}

async function activeRunPatterns() {
  const runs = await readSession(SESSION_KEYS.runs, {});
  return new Set(
    Object.values(runs ?? {})
      .filter((r) => r.phase === 'injecting' || r.phase === 'running')
      .flatMap((r) => r.patterns ?? []),
  );
}

async function dropDetectionPermissions(freshOrigins, services) {
  const chrome = globalThis.chrome;
  const detection = new Set(detectionOrigins(services));
  const inUse = await activeRunPatterns();
  const origins = freshOrigins.filter((o) => detection.has(o) && !inUse.has(o));
  try {
    await chrome.permissions.remove({ permissions: ['cookies'] });
  } catch (err) {
    console.warn('NoTrain: could not remove the cookies permission', err);
  }
  if (origins.length > 0) {
    try {
      await chrome.permissions.remove({ origins });
    } catch (err) {
      console.warn('NoTrain: could not remove detection origins', err);
    }
  }
  const dropped = new Set(origins);
  await updateSession(SESSION_KEYS.grants, [], (log) => ({
    value: (Array.isArray(log) ? log : [])
      .map((e) => ({
        ...e,
        permissions: e.permissions.filter((p) => p !== 'cookies'),
        origins: e.origins.filter((o) => !dropped.has(o)),
      }))
      .filter((e) => e.permissions.length > 0 || e.origins.length > 0),
  }));
  return origins;
}

/**
 * Handles `detectAccounts`.
 * @param {{ now?: () => number, grantWaitMs?: number }} [options]
 * @returns {Promise<{ detected: string[], checked: number }>}
 */
export async function detectAccounts({ now = () => Date.now(), grantWaitMs = GRANT_WAIT_MS } = {}) {
  const chrome = globalThis.chrome;
  if (!(await hasPermissions({ permissions: ['cookies'] })) || !chrome.cookies?.get) {
    throw new UserError('Permission to check sign-in cookies was not granted');
  }
  let log = await readSession(SESSION_KEYS.grants, []);
  if (!recentGrants(log, now()).some((e) => e.permissions.includes('cookies'))) {
    // The permissions.onAdded event may still be on its way.
    await waitForGrant(grantWaitMs);
    log = await readSession(SESSION_KEYS.grants, []);
  }
  const fresh = newlyGrantedOrigins(log, now());
  const { registry } = await readLocal([K.registry]);
  const services = registry?.services ?? [];
  const detected = [];
  let checked = 0;
  try {
    const declared = manifestHostPatterns();
    const granted = new Map();
    for (const service of services) {
      let serviceChecked = false;
      for (const c of service.detection?.cookies ?? []) {
        const pattern = originPattern(c.url);
        if (!pattern || !isDeclared(pattern, declared)) continue;
        if (!granted.has(pattern)) granted.set(pattern, await hasPermissions({ origins: [pattern] }));
        if (!granted.get(pattern)) continue;
        serviceChecked = true;
        if (await cookiePresent(c.url, c.name)) {
          detected.push(service.id);
          break;
        }
      }
      if (serviceChecked) checked += 1;
    }
    if (detected.length > 0) {
      await updateLocal([K.registry, K.userState], (v) => {
        const ids = detected.filter((id) => findService(v[K.registry], id));
        const userState = trackServices(v[K.userState], v[K.registry], {
          serviceIds: ids,
          tracked: true,
          source: 'detected',
        });
        return { set: { [K.userState]: userState } };
      });
    }
  } finally {
    await dropDetectionPermissions(fresh, services);
  }
  return { detected, checked };
}
