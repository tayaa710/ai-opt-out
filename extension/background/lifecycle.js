// Service worker lifecycle: initialisation, install/update/startup, alarms,
// reminders, and reactions to storage and permission changes.

import {
  ALARMS,
  REGISTRY_SYNC_PERIOD_MINUTES,
  REMINDER_CHECK_PERIOD_MINUTES,
  STORAGE_KEYS,
} from '../lib/constants.js';
import { migrateStorage, readLocal, updateLocal } from '../lib/storage.js';
import { ensureRegistry, isSyncDue, refreshFromBundled, syncRegistry } from '../lib/registry.js';
import { dueReminders, mergeAlerts } from '../lib/alerts.js';
import { notify } from '../lib/notify.js';
import { updateBadge } from '../lib/badge.js';
import { syncPassiveRegistrations } from '../lib/passive.js';

const K = STORAGE_KEYS;
export const WELCOME_PATH = 'dashboard/dashboard.html#/welcome';
/** First registry sync after install (the bundled copy is fresh at install time). */
export const FIRST_SYNC_DELAY_MINUTES = 60;
export const FIRST_REMINDER_DELAY_MINUTES = 15;

// One initialisation per worker instance (keyed by the chrome object so unit
// tests with a fresh mock get a fresh initialisation).
const ready = new WeakMap();

/**
 * Migrates storage (writing defaults on first run) and makes sure a registry is
 * cached. Idempotent; every message and event awaits it before doing work.
 */
export function ensureReady() {
  const key = globalThis.chrome;
  let p = ready.get(key);
  if (!p) {
    p = (async () => {
      await migrateStorage();
      await ensureRegistry();
    })();
    p.catch(() => ready.delete(key));
    ready.set(key, p);
  }
  return p;
}

/** Forget the cached initialisation (after resetAll). */
export function resetReady() {
  ready.delete(globalThis.chrome);
}

/** Creates the alarms if they do not exist yet (existing schedules are kept). */
export async function ensureAlarms() {
  const alarms = globalThis.chrome?.alarms;
  if (!alarms?.create) return;
  const specs = [
    [ALARMS.registrySync, FIRST_SYNC_DELAY_MINUTES, REGISTRY_SYNC_PERIOD_MINUTES],
    [ALARMS.reminders, FIRST_REMINDER_DELAY_MINUTES, REMINDER_CHECK_PERIOD_MINUTES],
  ];
  for (const [name, delayInMinutes, periodInMinutes] of specs) {
    const existing = await alarms.get(name);
    if (existing && existing.periodInMinutes === periodInMinutes) continue;
    await alarms.create(name, { delayInMinutes, periodInMinutes });
  }
}

/** Syncs the registry if auto-sync is on and the last success is a week old. */
export async function syncIfDue(now = new Date()) {
  const { settings, registryMeta } = await readLocal([K.settings, K.registryMeta]);
  if (!settings.autoSync || !isSyncDue(registryMeta, now)) return null;
  return syncRegistry({ force: false, now });
}

/** Creates due reminder alerts (and one notification if enabled). */
export async function checkReminders(now = new Date()) {
  const { added, wantsNotification } = await updateLocal([K.registry, K.userState, K.settings, K.alerts], (v) => {
    const due = dueReminders(
      { registry: v[K.registry], userState: v[K.userState], settings: v[K.settings], alerts: v[K.alerts] },
      now,
    );
    if (due.length === 0) return { result: { added: [], wantsNotification: false } };
    const merged = mergeAlerts(v[K.alerts], due);
    return {
      set: { [K.alerts]: merged.alerts },
      result: { added: merged.added, wantsNotification: v[K.settings].notifications.reminders },
    };
  });
  if (added.length > 0 && wantsNotification) {
    const one = added.length === 1 ? added[0] : null;
    await notify({
      kind: 'reminder',
      serviceId: one?.serviceId ?? null,
      title: one ? one.title : `${added.length} opt-outs are due for a re-check`,
      message: one ? one.body : 'Settings sometimes get reset by app updates. Open NoTrain to check them.',
      priority: 0,
    });
  }
  return added;
}

async function runMaintenance() {
  await ensureAlarms();
  await syncPassiveRegistrations();
  await updateBadge();
}

/** runtime.onInstalled */
export async function handleInstalled(details) {
  await ensureReady();
  if (details?.reason === 'update') await refreshFromBundled({ createAlerts: true });
  await runMaintenance();
  if (details?.reason === 'install') {
    const { settings } = await readLocal([K.settings]);
    if (!settings.onboarded) {
      await globalThis.chrome.tabs.create({ url: globalThis.chrome.runtime.getURL(WELCOME_PATH) });
    }
  }
}

/** runtime.onStartup */
export async function handleStartup() {
  await ensureReady();
  await runMaintenance();
  await syncIfDue();
}

/** alarms.onAlarm */
export async function handleAlarm(alarm) {
  await ensureReady();
  if (alarm?.name === ALARMS.registrySync) {
    const { settings } = await readLocal([K.settings]);
    if (settings.autoSync) await syncRegistry({ force: false });
  } else if (alarm?.name === ALARMS.reminders) {
    await checkReminders();
    // Daily safety net: retry a registry sync that failed (e.g. offline).
    await syncIfDue();
  }
}

// ---------------------------------------------------------------------------
// Reactions to state changes (coalesced; the work is idempotent)

const BADGE_KEYS = new Set([K.userState, K.alerts, K.registry, K.settings]);
const PASSIVE_KEYS = new Set([K.userState, K.registry, K.settings]);

let badgeRunning = null;
let badgeAgain = false;
export function scheduleBadgeUpdate() {
  if (badgeRunning) {
    badgeAgain = true;
    return badgeRunning;
  }
  badgeRunning = (async () => {
    try {
      do {
        badgeAgain = false;
        await updateBadge();
      } while (badgeAgain);
    } finally {
      badgeRunning = null;
    }
  })();
  return badgeRunning;
}

/** storage.onChanged */
export function handleStorageChanged(changes, area) {
  if (area !== 'local') return Promise.resolve();
  const keys = Object.keys(changes ?? {});
  const work = [];
  if (keys.some((k) => BADGE_KEYS.has(k))) work.push(scheduleBadgeUpdate());
  if (keys.some((k) => PASSIVE_KEYS.has(k))) work.push(syncPassiveRegistrations());
  return Promise.all(work);
}
