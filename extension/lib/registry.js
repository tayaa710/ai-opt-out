// Registry cache: the bundled copy (data/registry.json) is used on first run;
// a weekly sync fetches the public registry JSON (data only, never code),
// validates it, and replaces the cache only if it is newer. Differences for
// tracked services become alerts.

import {
  ALERT_KINDS,
  BUNDLED_REGISTRY_PATH,
  REGISTRY_FORMAT_VERSION,
  REGISTRY_SYNC_PERIOD_MINUTES,
  REMOTE_REGISTRY_URL,
  STORAGE_KEYS,
} from './constants.js';
import { emptyRegistry, validateRegistry } from './registry-validate.js';
import { alertsForDiff, diffRegistries } from './registry-diff.js';
import { isUrgent, mergeAlerts } from './alerts.js';
import { isPlainObject, readLocal, updateLocal } from './storage.js';
import { notify } from './notify.js';

export const REMOTE_MAX_BYTES = 2 * 1024 * 1024;
export const REMOTE_TIMEOUT_MS = 15_000;
/** Unforced syncs (alarms, startup) run at most this often. */
export const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000;
/** After a failed sync, retry no sooner than this (daily alarm checks). */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const SYNC_PERIOD_MS = REGISTRY_SYNC_PERIOD_MINUTES * 60 * 1000;
const MAX_NOTIFICATIONS = 3;

const K = STORAGE_KEYS;

/**
 * Reads a response body as text, aborting once it exceeds `maxBytes`.
 * @param {Response} response
 * @param {number} maxBytes
 */
export async function readTextCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Response is too large');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('Response is too large');
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Response is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * GETs JSON without credentials or referrer, with a timeout covering the body.
 * @param {string} url
 * @param {{ timeoutMs?: number, maxBytes?: number, fetchImpl?: typeof fetch }} [options]
 */
export async function fetchJson(url, { timeoutMs = REMOTE_TIMEOUT_MS, maxBytes = REMOTE_MAX_BYTES, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      cache: 'no-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readTextCapped(res, maxBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Response is not valid JSON');
    }
  } catch (err) {
    if (controller.signal.aborted) throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A stored registry this build can use. */
export function isUsableRegistry(registry) {
  return (
    isPlainObject(registry) &&
    registry.formatVersion === REGISTRY_FORMAT_VERSION &&
    Array.isArray(registry.services) &&
    registry.services.length > 0
  );
}

function logValidation(label, result) {
  if (result.dropped?.length) {
    console.warn(`NoTrain: ${label}: dropped ${result.dropped.length} invalid service(s)`, result.dropped);
  }
}

/** Fetches and validates the registry shipped inside the extension package. */
export async function loadBundledRegistry({ fetchImpl } = {}) {
  const url = globalThis.chrome.runtime.getURL(BUNDLED_REGISTRY_PATH);
  const json = await fetchJson(url, { timeoutMs: 10_000, maxBytes: 8 * REMOTE_MAX_BYTES, fetchImpl });
  const result = validateRegistry(json);
  if (!result.ok) throw new Error(result.error);
  logValidation('bundled registry', result);
  return result.registry;
}

function baseMeta(meta, registry) {
  return {
    source: 'bundled',
    generatedAt: registry?.generatedAt ?? null,
    lastSyncAt: null,
    lastSyncStatus: null,
    ...(isPlainObject(meta) ? meta : {}),
  };
}

/** Shows notifications for urgent policy-change alerts, if the user wants them. */
export async function notifyPolicyAlerts(alerts) {
  const urgent = alerts.filter((a) => a.kind === ALERT_KINDS.policyChange && isUrgent(a));
  if (urgent.length === 0) return;
  const { settings } = await readLocal([K.settings]);
  if (!settings.notifications.policyChanges) return;
  if (urgent.length > MAX_NOTIFICATIONS) {
    await notify({
      kind: ALERT_KINDS.policyChange,
      title: `${urgent.length} services changed their AI training policies`,
      message: 'Open NoTrain to review what changed.',
      priority: 1,
    });
    return;
  }
  for (const a of urgent) {
    await notify({
      kind: a.kind,
      serviceId: a.serviceId,
      title: a.title,
      message: a.body,
      priority: a.severity === 'critical' ? 2 : 1,
    });
  }
}

/**
 * Installs the bundled registry if the cache is missing/unusable or older than
 * the bundled copy (e.g. after an extension update). With `createAlerts`, the
 * differences against the previous cache become alerts.
 * @returns {Promise<object>} the registry now in use
 */
export async function refreshFromBundled({ createAlerts = false, fetchImpl, now = new Date() } = {}) {
  let bundled = null;
  let loadError = null;
  try {
    bundled = await loadBundledRegistry({ fetchImpl });
  } catch (err) {
    loadError = err;
    console.error('NoTrain: bundled registry could not be loaded', err);
  }
  const { registry, added } = await updateLocal([K.registry, K.registryMeta, K.userState, K.alerts], (v) => {
    const current = isUsableRegistry(v[K.registry]) ? v[K.registry] : null;
    if (!bundled) {
      if (current) return { result: { registry: current, added: [] } };
      const empty = emptyRegistry();
      const meta = {
        ...baseMeta(v[K.registryMeta], empty),
        source: 'bundled',
        generatedAt: empty.generatedAt,
        lastError: `Bundled registry unavailable: ${loadError?.message ?? 'unknown error'}`,
      };
      return { set: { [K.registry]: empty, [K.registryMeta]: meta }, result: { registry: empty, added: [] } };
    }
    if (current && Date.parse(current.generatedAt) >= Date.parse(bundled.generatedAt)) {
      return { result: { registry: current, added: [] } };
    }
    const meta = {
      ...baseMeta(v[K.registryMeta], bundled),
      source: 'bundled',
      generatedAt: bundled.generatedAt,
      loadedAt: now.toISOString(),
    };
    delete meta.lastError;
    const set = { [K.registry]: bundled, [K.registryMeta]: meta };
    let addedAlerts = [];
    if (current && createAlerts) {
      const newAlerts = alertsForDiff(diffRegistries(current, bundled), v[K.userState], {}, now);
      const merged = mergeAlerts(v[K.alerts], newAlerts);
      set[K.alerts] = merged.alerts;
      addedAlerts = merged.added;
    }
    return { set, result: { registry: bundled, added: addedAlerts } };
  });
  await notifyPolicyAlerts(added);
  return registry;
}

/** Makes sure a usable registry is cached (loading the bundled copy if not). */
export async function ensureRegistry(options = {}) {
  const { registry } = await readLocal([K.registry]);
  if (isUsableRegistry(registry)) return registry;
  return refreshFromBundled(options);
}

/** Has the registry gone a full sync period without a successful sync? */
export function isSyncStale(meta, now = new Date()) {
  const last = Date.parse(meta?.lastSuccessAt ?? meta?.loadedAt ?? '');
  return Number.isNaN(last) || now.getTime() - last >= SYNC_PERIOD_MS;
}

/** Stale, and not attempted recently (so an offline device does not retry constantly). */
export function isSyncDue(meta, now = new Date()) {
  if (!isSyncStale(meta, now)) return false;
  const attempted = Date.parse(meta?.lastSyncAt ?? '');
  return Number.isNaN(attempted) || now.getTime() - attempted >= RETRY_AFTER_MS;
}

let inflight = null;

/**
 * Fetches the remote registry and applies it if valid and newer.
 * Concurrent calls share one request. Never throws: failures are recorded in
 * registryMeta (`lastSyncStatus: 'error'`).
 * @param {{ force?: boolean, fetchImpl?: typeof fetch, now?: Date }} [options]
 * @returns {Promise<object>} registryMeta
 */
export function syncRegistry(options = {}) {
  if (inflight) return inflight;
  inflight = doSync(options).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doSync({ force = false, fetchImpl, now = new Date() }) {
  const { registryMeta, registry } = await readLocal([K.registryMeta, K.registry]);
  const meta = baseMeta(registryMeta, registry);
  if (!force && meta.lastSyncAt && now.getTime() - Date.parse(meta.lastSyncAt) < MIN_SYNC_INTERVAL_MS) {
    return meta;
  }
  let next = null;
  let error = null;
  try {
    const json = await fetchJson(REMOTE_REGISTRY_URL, { fetchImpl });
    const result = validateRegistry(json, { now });
    if (!result.ok) throw new Error(result.error);
    if (result.registry.services.length === 0) throw new Error('Registry contains no valid services');
    logValidation('remote registry', result);
    next = result.registry;
  } catch (err) {
    error = err;
  }
  const attemptAt = now.toISOString();
  const { meta: newMeta, added } = await updateLocal([K.registry, K.registryMeta, K.userState, K.alerts], (v) => {
    const current = isUsableRegistry(v[K.registry]) ? v[K.registry] : null;
    const base = baseMeta(v[K.registryMeta], v[K.registry]);
    if (error) {
      const m = {
        ...base,
        lastSyncAt: attemptAt,
        lastSyncStatus: 'error',
        lastError: String(error?.message ?? error).slice(0, 200),
      };
      return { set: { [K.registryMeta]: m }, result: { meta: m, added: [] } };
    }
    if (current && Date.parse(next.generatedAt) <= Date.parse(current.generatedAt)) {
      const m = { ...base, lastSyncAt: attemptAt, lastSuccessAt: attemptAt, lastSyncStatus: 'unchanged' };
      delete m.lastError;
      return { set: { [K.registryMeta]: m }, result: { meta: m, added: [] } };
    }
    const diff = diffRegistries(current, next);
    const newAlerts = alertsForDiff(diff, v[K.userState], { newServices: Boolean(current) }, now);
    const merged = mergeAlerts(v[K.alerts], newAlerts);
    const m = {
      ...base,
      source: 'remote',
      generatedAt: next.generatedAt,
      lastSyncAt: attemptAt,
      lastSuccessAt: attemptAt,
      lastSyncStatus: 'ok',
    };
    delete m.lastError;
    return {
      set: { [K.registry]: next, [K.registryMeta]: m, [K.alerts]: merged.alerts },
      result: { meta: m, added: merged.added },
    };
  });
  await notifyPolicyAlerts(added);
  return newMeta;
}
