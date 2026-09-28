// Persistent state for the background. Every write goes through a promise queue
// so read-modify-write sequences from concurrent events (messages, alarms,
// content-script reports) never lose updates. Only the service worker writes;
// extension pages read through the `getState` message and re-render on
// `chrome.storage.onChanged`.
//
// Mutators passed to `updateLocal`/`updateSession` must be synchronous and must
// not call back into this module (that would deadlock the queue).

import {
  ALERTS_LIMIT,
  DEFAULT_SETTINGS,
  HISTORY_LIMIT,
  METHODS,
  OPT_OUT_STATUS,
  RUN_OUTCOMES,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
} from './constants.js';
import { isRegionCode } from './region.js';

/** Keys in `chrome.storage.session` (cleared when the browser closes). */
export const SESSION_KEYS = Object.freeze({
  runs: 'runs',
  grants: 'recentGrants',
});

export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const STATUS_VALUES = Object.freeze(Object.values(OPT_OUT_STATUS));
export const OUTCOME_VALUES = Object.freeze(Object.values(RUN_OUTCOMES));
export const SOURCES = Object.freeze(['manual', 'detected']);
export const REMINDER_DAYS_MIN = 7;
export const REMINDER_DAYS_MAX = 365;
export const NOTE_MAX = 500;
export const PROFILE_FIELD_MAX = 200;

/** Error whose message is safe to show to the user / return to the UI. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isIsoDate(v) {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

export function nowIso(now = new Date()) {
  return now.toISOString();
}

export function newId() {
  return globalThis.crypto.randomUUID();
}

export function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

// ---------------------------------------------------------------------------
// Defaults and normalisation (tolerant: repairs corrupted or partial data)

export function defaultSettings() {
  return structuredClone({
    ...DEFAULT_SETTINGS,
    notifications: { ...DEFAULT_SETTINGS.notifications },
    profile: { ...DEFAULT_SETTINGS.profile },
  });
}

export function defaultUserState() {
  return { services: {} };
}

/**
 * Returns a complete, valid settings object: known fields with valid values are
 * kept, everything else falls back to the default. Unknown fields are dropped.
 */
export function normalizeSettings(raw) {
  const out = defaultSettings();
  if (!isPlainObject(raw)) return out;
  if (typeof raw.onboarded === 'boolean') out.onboarded = raw.onboarded;
  if (isRegionCode(raw.region)) out.region = raw.region;
  if (isPlainObject(raw.notifications)) {
    for (const k of Object.keys(out.notifications)) {
      if (typeof raw.notifications[k] === 'boolean') out.notifications[k] = raw.notifications[k];
    }
  }
  if (isReminderDays(raw.reminderIntervalDays)) out.reminderIntervalDays = raw.reminderIntervalDays;
  if (typeof raw.autoSync === 'boolean') out.autoSync = raw.autoSync;
  if (typeof raw.passiveChecks === 'boolean') out.passiveChecks = raw.passiveChecks;
  if (isPlainObject(raw.profile)) {
    for (const k of Object.keys(out.profile)) {
      const v = raw.profile[k];
      if (typeof v === 'string' && v.length <= PROFILE_FIELD_MAX) out.profile[k] = v;
    }
  }
  out.schemaVersion = STORAGE_SCHEMA_VERSION;
  return out;
}

function isReminderDays(v) {
  return Number.isInteger(v) && v >= REMINDER_DAYS_MIN && v <= REMINDER_DAYS_MAX;
}

/** Repairs a stored opt-out record, or returns null if it is unusable. */
export function normalizeOptOutRecord(raw) {
  if (!isPlainObject(raw) || !STATUS_VALUES.includes(raw.status)) return null;
  const rec = {
    status: raw.status,
    method: METHODS.includes(raw.method) ? raw.method : 'manual',
    updatedAt: isIsoDate(raw.updatedAt) ? raw.updatedAt : new Date(0).toISOString(),
    verifiedAt: isIsoDate(raw.verifiedAt) ? raw.verifiedAt : null,
  };
  if (OUTCOME_VALUES.includes(raw.lastOutcome)) rec.lastOutcome = raw.lastOutcome;
  if (typeof raw.note === 'string' && raw.note.length > 0) rec.note = raw.note.slice(0, NOTE_MAX);
  return rec;
}

/** Repairs a stored per-service record, or returns null if it is unusable. */
export function normalizeServiceRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const rec = {
    tracked: raw.tracked === true,
    source: SOURCES.includes(raw.source) ? raw.source : 'manual',
    addedAt: isIsoDate(raw.addedAt) ? raw.addedAt : new Date(0).toISOString(),
    optOuts: {},
  };
  if (Number.isInteger(raw.knownPolicyVersion) && raw.knownPolicyVersion >= 1) {
    rec.knownPolicyVersion = raw.knownPolicyVersion;
  }
  if (isPlainObject(raw.optOuts)) {
    for (const [id, o] of Object.entries(raw.optOuts)) {
      if (!ID_PATTERN.test(id)) continue;
      const n = normalizeOptOutRecord(o);
      if (n) rec.optOuts[id] = n;
    }
  }
  return rec;
}

export function normalizeUserState(raw) {
  const out = defaultUserState();
  if (!isPlainObject(raw) || !isPlainObject(raw.services)) return out;
  for (const [id, s] of Object.entries(raw.services)) {
    if (!ID_PATTERN.test(id)) continue;
    const n = normalizeServiceRecord(s);
    if (n) out.services[id] = n;
  }
  return out;
}

export function normalizeList(raw, limit) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => isPlainObject(e) && typeof e.id === 'string').slice(0, limit);
}

// ---------------------------------------------------------------------------
// Migrations. `MIGRATIONS[n]` upgrades data from schema version n to n + 1.
// Data written before `schemaVersion` existed is treated as version 0.

/** @type {Array<(data: Record<string, any>) => Record<string, any>>} */
export const MIGRATIONS = [
  // 0 → 1: first versioned schema. Pre-release data only needs normalising,
  // which always runs after the migrations below.
  (data) => data,
];

/**
 * Brings stored data up to STORAGE_SCHEMA_VERSION and normalises it.
 * Data from a *newer* schema (downgrade) is normalised as far as possible.
 * @param {Record<string, any>} stored raw values keyed by STORAGE_KEYS
 * @returns {{ data: Record<string, any>, fromVersion: number }}
 */
export function migrate(stored) {
  let data = { ...stored };
  const hasAny = [STORAGE_KEYS.settings, STORAGE_KEYS.userState].some((k) => data[k] !== undefined);
  const rawVersion = data[STORAGE_KEYS.settings]?.schemaVersion;
  let version = Number.isInteger(rawVersion) ? rawVersion : hasAny ? 0 : STORAGE_SCHEMA_VERSION;
  const fromVersion = version;
  while (version < STORAGE_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (step) data = step(data);
    version += 1;
  }
  data[STORAGE_KEYS.settings] = normalizeSettings(data[STORAGE_KEYS.settings]);
  data[STORAGE_KEYS.userState] = normalizeUserState(data[STORAGE_KEYS.userState]);
  data[STORAGE_KEYS.alerts] = normalizeList(data[STORAGE_KEYS.alerts], ALERTS_LIMIT);
  data[STORAGE_KEYS.history] = normalizeList(data[STORAGE_KEYS.history], HISTORY_LIMIT);
  return { data, fromVersion };
}

// ---------------------------------------------------------------------------
// Settings patches (strict: invalid input is rejected, never silently fixed)

const SETTINGS_KEYS = Object.freeze([
  'onboarded',
  'region',
  'notifications',
  'reminderIntervalDays',
  'autoSync',
  'passiveChecks',
  'profile',
]);

/**
 * Validates a settings patch and returns the merged settings. `notifications`
 * and `profile` are merged one level deep.
 * @throws {UserError}
 */
export function applySettingsPatch(settings, patch) {
  if (!isPlainObject(patch)) throw new UserError('patch must be an object');
  const next = normalizeSettings(settings);
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTINGS_KEYS.includes(key)) throw new UserError(`Unknown setting "${key}"`);
    switch (key) {
      case 'onboarded':
      case 'autoSync':
      case 'passiveChecks':
        if (typeof value !== 'boolean') throw new UserError(`${key} must be a boolean`);
        next[key] = value;
        break;
      case 'region':
        if (!isRegionCode(value)) throw new UserError('region must be a known region code');
        next.region = value;
        break;
      case 'reminderIntervalDays':
        if (!isReminderDays(value)) {
          throw new UserError(
            `reminderIntervalDays must be an integer from ${REMINDER_DAYS_MIN} to ${REMINDER_DAYS_MAX}`,
          );
        }
        next.reminderIntervalDays = value;
        break;
      case 'notifications':
        if (!isPlainObject(value)) throw new UserError('notifications must be an object');
        for (const [k, v] of Object.entries(value)) {
          if (!(k in next.notifications)) throw new UserError(`Unknown notification setting "${k}"`);
          if (typeof v !== 'boolean') throw new UserError(`notifications.${k} must be a boolean`);
          next.notifications[k] = v;
        }
        break;
      case 'profile':
        if (!isPlainObject(value)) throw new UserError('profile must be an object');
        for (const [k, v] of Object.entries(value)) {
          if (!(k in next.profile)) throw new UserError(`Unknown profile field "${k}"`);
          if (typeof v !== 'string' || v.length > PROFILE_FIELD_MAX) {
            throw new UserError(`profile.${k} must be a string of at most ${PROFILE_FIELD_MAX} characters`);
          }
          const trimmed = v.trim();
          if (k === 'email' && trimmed !== '' && !isEmail(trimmed)) {
            throw new UserError('profile.email must be a valid email address');
          }
          next.profile[k] = trimmed;
        }
        break;
      default:
        break;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Write queue

let queue = Promise.resolve();

/**
 * Runs `fn` after every previously queued task has settled.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function serialize(fn) {
  const run = queue.then(() => fn());
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function local() {
  const area = globalThis.chrome?.storage?.local;
  if (!area) throw new Error('chrome.storage.local is unavailable');
  return area;
}

// Firefox < 115 has no storage.session; fall back to memory (lost on restart,
// which only affects in-flight runs and the short-lived permission grant log).
const memorySession = new Map();
function session() {
  return globalThis.chrome?.storage?.session ?? null;
}

/** Fills missing keys with defaults and normalises settings/userState on read. */
export function withDefaults(values) {
  const out = { ...values };
  out[STORAGE_KEYS.settings] = normalizeSettings(out[STORAGE_KEYS.settings]);
  out[STORAGE_KEYS.userState] = normalizeUserState(out[STORAGE_KEYS.userState]);
  out[STORAGE_KEYS.alerts] = Array.isArray(out[STORAGE_KEYS.alerts]) ? out[STORAGE_KEYS.alerts] : [];
  out[STORAGE_KEYS.history] = Array.isArray(out[STORAGE_KEYS.history]) ? out[STORAGE_KEYS.history] : [];
  if (!isPlainObject(out[STORAGE_KEYS.registry])) out[STORAGE_KEYS.registry] = null;
  if (!isPlainObject(out[STORAGE_KEYS.registryMeta])) out[STORAGE_KEYS.registryMeta] = null;
  return out;
}

/**
 * Reads keys from chrome.storage.local, filling defaults.
 * @param {string[]} [keys] defaults to every STORAGE_KEYS value
 */
export async function readLocal(keys = Object.values(STORAGE_KEYS)) {
  const raw = await local().get(keys);
  const filled = withDefaults(raw);
  const out = {};
  for (const k of keys) out[k] = filled[k];
  return out;
}

/**
 * Atomic-ish read-modify-write of chrome.storage.local.
 * The mutator receives the current values (with defaults) and returns
 * `{ set?: Record<string, any>, result?: any }`; only keys in `set` are written.
 * @template T
 * @param {string[]} keys
 * @param {(values: Record<string, any>) => ({ set?: Record<string, any>, result?: T } | undefined)} mutator
 * @returns {Promise<T>}
 */
export function updateLocal(keys, mutator) {
  return serialize(async () => {
    const values = await readLocal(keys);
    const out = mutator(values) ?? {};
    if (out.set && Object.keys(out.set).length > 0) await local().set(out.set);
    return out.result;
  });
}

const MIGRATED_KEYS = [STORAGE_KEYS.settings, STORAGE_KEYS.userState, STORAGE_KEYS.alerts, STORAGE_KEYS.history];

/**
 * Runs migrations on the stored data and writes back whatever changed
 * (including writing defaults on first run).
 * @returns {Promise<{ fromVersion: number, changed: string[] }>}
 */
export function migrateStorage() {
  return serialize(async () => {
    const raw = await local().get(MIGRATED_KEYS);
    const { data, fromVersion } = migrate(raw);
    const set = {};
    for (const k of MIGRATED_KEYS) {
      if (JSON.stringify(raw[k]) !== JSON.stringify(data[k])) set[k] = data[k];
    }
    if (Object.keys(set).length > 0) await local().set(set);
    return { fromVersion, changed: Object.keys(set) };
  });
}

/** Raw write (still serialised). */
export function writeLocal(values) {
  return serialize(() => local().set(values));
}

/** Clears chrome.storage.local and .session (serialised). */
export function clearAll() {
  return serialize(async () => {
    await local().clear();
    const s = session();
    if (s) await s.clear();
    else memorySession.clear();
  });
}

export async function readSession(key, fallback) {
  const s = session();
  if (!s) return memorySession.has(key) ? clone(memorySession.get(key)) : fallback;
  const got = await s.get(key);
  return got[key] === undefined ? fallback : got[key];
}

/**
 * Read-modify-write of one chrome.storage.session key.
 * @template T
 * @param {string} key
 * @param {any} fallback value used when the key is absent
 * @param {(value: any) => ({ value?: any, result?: T } | undefined)} mutator
 * @returns {Promise<T>}
 */
export function updateSession(key, fallback, mutator) {
  return serialize(async () => {
    const current = await readSession(key, clone(fallback));
    const out = mutator(current) ?? {};
    if ('value' in out) {
      const s = session();
      if (s) await s.set({ [key]: out.value });
      else memorySession.set(key, clone(out.value));
    }
    return out.result;
  });
}

/** Test hook: reset the in-memory session fallback. */
export function _resetMemorySession() {
  memorySession.clear();
}
