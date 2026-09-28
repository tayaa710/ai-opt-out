// Handlers for the UI → background messages that read or change stored state.
// Payloads have already been validated by router.js.

import { OPT_OUT_STATUS, STORAGE_KEYS, STORAGE_SCHEMA_VERSION } from '../lib/constants.js';
import {
  applySettingsPatch,
  clearAll,
  migrateStorage,
  readLocal,
  updateLocal,
  writeLocal,
} from '../lib/storage.js';
import {
  acknowledgePolicy,
  requireServiceOptOut,
  setOptOutStatus,
  trackServices,
} from '../lib/user-state.js';
import { markAlert, markAllRead, markPolicyAlertsRead } from '../lib/alerts.js';
import { appendHistory, makeHistoryEntry } from '../lib/history.js';
import { isUsableRegistry, refreshFromBundled } from '../lib/registry.js';
import { unregisterAllPassive } from '../lib/passive.js';
import { updateBadge } from '../lib/badge.js';
import { ensureAlarms, ensureReady, resetReady } from './lifecycle.js';
import { validateBackup } from './validate.js';

const K = STORAGE_KEYS;
export const STATE_HISTORY_LIMIT = 100;

export async function getState() {
  const s = await readLocal();
  const registry = s[K.registry];
  return {
    registry,
    registryMeta: s[K.registryMeta] ?? {
      source: 'bundled',
      generatedAt: isUsableRegistry(registry) ? registry.generatedAt : null,
      lastSyncAt: null,
      lastSyncStatus: null,
    },
    settings: s[K.settings],
    userState: s[K.userState],
    alerts: s[K.alerts],
    history: s[K.history].slice(0, STATE_HISTORY_LIMIT),
  };
}

export function updateSettings({ patch }) {
  return updateLocal([K.settings], (v) => {
    const settings = applySettingsPatch(v[K.settings], patch);
    return { set: { [K.settings]: settings }, result: settings };
  });
}

export function track({ serviceIds, tracked, source }) {
  return updateLocal([K.registry, K.userState], (v) => {
    const userState = trackServices(v[K.userState], v[K.registry], { serviceIds, tracked, source });
    return { set: { [K.userState]: userState }, result: userState };
  });
}

export function setStatus({ serviceId, optOutId, status, method, note }, now = new Date()) {
  return updateLocal([K.registry, K.userState, K.history], (v) => {
    const { service, optOut } = requireServiceOptOut(v[K.registry], serviceId, optOutId);
    const userState = setOptOutStatus(v[K.userState], service, optOut, { status, method, note }, now);
    const entry = makeHistoryEntry({ serviceId, optOutId, action: method, outcome: status, detail: note }, now);
    return {
      set: { [K.userState]: userState, [K.history]: appendHistory(v[K.history], entry) },
      result: userState,
    };
  });
}

export function acknowledge({ serviceId }) {
  return updateLocal([K.registry, K.userState, K.alerts], (v) => {
    const { service } = requireServiceOptOut(v[K.registry], serviceId);
    const userState = acknowledgePolicy(v[K.userState], service);
    return {
      set: { [K.userState]: userState, [K.alerts]: markPolicyAlertsRead(v[K.alerts], serviceId) },
      result: userState,
    };
  });
}

export function recordLetter({ serviceId, optOutId }, now = new Date()) {
  return updateLocal([K.registry, K.userState, K.history], (v) => {
    const { service, optOut } = requireServiceOptOut(v[K.registry], serviceId, optOutId);
    const userState = setOptOutStatus(
      v[K.userState],
      service,
      optOut,
      { status: OPT_OUT_STATUS.sent, method: 'letter' },
      now,
    );
    const entry = makeHistoryEntry(
      { serviceId, optOutId, action: 'letter', outcome: OPT_OUT_STATUS.sent },
      now,
    );
    return {
      set: { [K.userState]: userState, [K.history]: appendHistory(v[K.history], entry) },
      result: userState,
    };
  });
}

export function markOneAlert({ id, patch }) {
  return updateLocal([K.alerts], (v) => {
    const alerts = markAlert(v[K.alerts], id, patch);
    return { set: { [K.alerts]: alerts }, result: alerts };
  });
}

export function markEveryAlertRead() {
  return updateLocal([K.alerts], (v) => {
    const alerts = markAllRead(v[K.alerts]);
    return { set: { [K.alerts]: alerts }, result: alerts };
  });
}

export async function exportData(now = new Date()) {
  const s = await readLocal([K.settings, K.userState, K.alerts, K.history]);
  return {
    app: 'NoTrain',
    schemaVersion: STORAGE_SCHEMA_VERSION,
    extensionVersion: globalThis.chrome?.runtime?.getManifest?.().version ?? null,
    exportedAt: now.toISOString(),
    settings: s[K.settings],
    userState: s[K.userState],
    alerts: s[K.alerts],
    history: s[K.history],
  };
}

export async function importData({ data }) {
  const backup = validateBackup(data);
  await writeLocal({
    [K.settings]: backup.settings,
    [K.userState]: backup.userState,
    [K.alerts]: backup.alerts,
    [K.history]: backup.history,
  });
  return { settings: backup.settings, userState: backup.userState };
}

/**
 * Clears everything (local + session storage, passive-check registrations)
 * and starts again from defaults and the bundled registry. Granted optional
 * permissions are left alone (the settings page lists them with revoke buttons).
 */
export async function resetAll() {
  await unregisterAllPassive();
  await clearAll();
  resetReady();
  await migrateStorage();
  await refreshFromBundled();
  await ensureReady();
  await ensureAlarms();
  await updateBadge();
  return true;
}
