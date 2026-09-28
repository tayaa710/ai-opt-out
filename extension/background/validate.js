// Input validation for messages and backups. Every function throws a
// UserError with a path-qualified message on invalid input. Pure module.

import {
  ALERT_KINDS,
  ALERTS_LIMIT,
  HISTORY_LIMIT,
  METHODS,
  STORAGE_SCHEMA_VERSION,
} from '../lib/constants.js';
import {
  ID_PATTERN,
  NOTE_MAX,
  OUTCOME_VALUES,
  SOURCES,
  STATUS_VALUES,
  UserError,
  applySettingsPatch,
  defaultSettings,
  isIsoDate,
  isPlainObject,
  migrate,
} from '../lib/storage.js';
import { ALERT_SEVERITIES } from '../lib/alerts.js';
import { DETAIL_MAX, HISTORY_ACTIONS } from '../lib/history.js';

const MAX_IDS = 500;
const MAX_BACKUP_SERVICES = 2000;

export function expectObject(v, name) {
  if (!isPlainObject(v)) throw new UserError(`${name} must be an object`);
  return v;
}

export function expectBoolean(v, name) {
  if (typeof v !== 'boolean') throw new UserError(`${name} must be true or false`);
  return v;
}

export function expectString(v, name, max = 200) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new UserError(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return v;
}

export function expectId(v, name) {
  if (typeof v !== 'string' || v.length > 80 || !ID_PATTERN.test(v))
    throw new UserError(`${name} is not a valid id`);
  return v;
}

export function expectEnum(v, values, name) {
  if (!values.includes(v)) throw new UserError(`${name} must be one of: ${values.join(', ')}`);
  return v;
}

export function expectInt(v, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(v) || v < min || v > max) throw new UserError(`${name} must be an integer`);
  return v;
}

export function expectIdList(v, name) {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_IDS) {
    throw new UserError(`${name} must be a list of 1-${MAX_IDS} ids`);
  }
  return [...new Set(v.map((id, i) => expectId(id, `${name}[${i}]`)))];
}

export function optionalNote(v, name = 'note') {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > NOTE_MAX) {
    throw new UserError(`${name} must be a string of at most ${NOTE_MAX} characters`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Backups (exportData / importData)

function onlyKeys(obj, allowed, path) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new UserError(`${path}.${k} is not a known field`);
  }
}

function expectIso(v, path, { nullable = false } = {}) {
  if (nullable && v === null) return null;
  if (!isIsoDate(v)) throw new UserError(`${path} must be a date`);
  return v;
}

function checkOptOutRecord(raw, path) {
  expectObject(raw, path);
  onlyKeys(raw, ['status', 'method', 'updatedAt', 'verifiedAt', 'lastOutcome', 'note'], path);
  const rec = {
    status: expectEnum(raw.status, STATUS_VALUES, `${path}.status`),
    method: expectEnum(raw.method, METHODS, `${path}.method`),
    updatedAt: expectIso(raw.updatedAt, `${path}.updatedAt`),
    verifiedAt: expectIso(raw.verifiedAt ?? null, `${path}.verifiedAt`, { nullable: true }),
  };
  if (raw.lastOutcome !== undefined)
    rec.lastOutcome = expectEnum(raw.lastOutcome, OUTCOME_VALUES, `${path}.lastOutcome`);
  const note = optionalNote(raw.note, `${path}.note`);
  if (note) rec.note = note;
  return rec;
}

function checkServiceRecord(raw, path) {
  expectObject(raw, path);
  onlyKeys(raw, ['tracked', 'source', 'addedAt', 'knownPolicyVersion', 'optOuts'], path);
  const rec = {
    tracked: expectBoolean(raw.tracked, `${path}.tracked`),
    source: expectEnum(raw.source, SOURCES, `${path}.source`),
    addedAt: expectIso(raw.addedAt, `${path}.addedAt`),
    optOuts: {},
  };
  if (raw.knownPolicyVersion !== undefined) {
    rec.knownPolicyVersion = expectInt(raw.knownPolicyVersion, `${path}.knownPolicyVersion`, 1);
  }
  const optOuts = expectObject(raw.optOuts ?? {}, `${path}.optOuts`);
  for (const [id, o] of Object.entries(optOuts)) {
    expectId(id, `${path}.optOuts key "${id}"`);
    rec.optOuts[id] = checkOptOutRecord(o, `${path}.optOuts.${id}`);
  }
  return rec;
}

export function checkUserState(raw, path = 'userState') {
  expectObject(raw, path);
  onlyKeys(raw, ['services'], path);
  const services = expectObject(raw.services, `${path}.services`);
  const entries = Object.entries(services);
  if (entries.length > MAX_BACKUP_SERVICES) throw new UserError(`${path}.services has too many entries`);
  const out = { services: {} };
  for (const [id, s] of entries) {
    expectId(id, `${path}.services key "${id}"`);
    out.services[id] = checkServiceRecord(s, `${path}.services.${id}`);
  }
  return out;
}

const ALERT_FIELDS = [
  'id',
  'kind',
  'serviceId',
  'optOutId',
  'serviceIds',
  'policyVersion',
  'severity',
  'title',
  'body',
  'createdAt',
  'read',
  'dismissed',
];

function checkAlert(raw, path) {
  expectObject(raw, path);
  onlyKeys(raw, ALERT_FIELDS, path);
  const a = {
    id: expectString(raw.id, `${path}.id`, 100),
    kind: expectEnum(raw.kind, Object.values(ALERT_KINDS), `${path}.kind`),
    serviceId:
      raw.serviceId === null || raw.serviceId === undefined
        ? null
        : expectId(raw.serviceId, `${path}.serviceId`),
    severity: expectEnum(raw.severity, ALERT_SEVERITIES, `${path}.severity`),
    title: expectString(raw.title, `${path}.title`, 200),
    body: expectString(raw.body, `${path}.body`, 1000),
    createdAt: expectIso(raw.createdAt, `${path}.createdAt`),
    read: expectBoolean(raw.read, `${path}.read`),
    dismissed: expectBoolean(raw.dismissed, `${path}.dismissed`),
  };
  if (raw.optOutId !== undefined) a.optOutId = expectId(raw.optOutId, `${path}.optOutId`);
  if (raw.policyVersion !== undefined)
    a.policyVersion = expectInt(raw.policyVersion, `${path}.policyVersion`, 1);
  if (raw.serviceIds !== undefined) a.serviceIds = expectIdList(raw.serviceIds, `${path}.serviceIds`);
  return a;
}

function checkHistoryEntry(raw, path) {
  expectObject(raw, path);
  onlyKeys(raw, ['id', 'at', 'serviceId', 'optOutId', 'action', 'outcome', 'detail'], path);
  const e = {
    id: expectString(raw.id, `${path}.id`, 100),
    at: expectIso(raw.at, `${path}.at`),
    serviceId: expectId(raw.serviceId, `${path}.serviceId`),
    optOutId: expectId(raw.optOutId, `${path}.optOutId`),
    action: expectEnum(raw.action, HISTORY_ACTIONS, `${path}.action`),
    outcome: expectEnum(raw.outcome, [...OUTCOME_VALUES, ...STATUS_VALUES], `${path}.outcome`),
  };
  if (raw.detail !== undefined) {
    if (typeof raw.detail !== 'string' || raw.detail.length > DETAIL_MAX) {
      throw new UserError(`${path}.detail must be a string of at most ${DETAIL_MAX} characters`);
    }
    e.detail = raw.detail;
  }
  return e;
}

function checkList(raw, path, limit, check) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new UserError(`${path} must be a list`);
  if (raw.length > limit * 2) throw new UserError(`${path} has too many entries`);
  return raw.map((x, i) => check(x, `${path}[${i}]`)).slice(0, limit);
}

/**
 * Validates a backup produced by exportData (strict: unknown fields and
 * invalid values are rejected), then migrates it to the current schema.
 * @returns {{ settings: object, userState: object, alerts: object[], history: object[] }}
 * @throws {UserError}
 */
export function validateBackup(data) {
  if (!isPlainObject(data)) throw new UserError('The backup must be a JSON object');
  if (data.app !== 'NoTrain') throw new UserError('This file is not a NoTrain backup');
  const schemaVersion = data.schemaVersion ?? data.settings?.schemaVersion ?? STORAGE_SCHEMA_VERSION;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) throw new UserError('schemaVersion is invalid');
  if (schemaVersion > STORAGE_SCHEMA_VERSION) {
    throw new UserError('This backup was made by a newer version of NoTrain. Update the extension first.');
  }
  if (data.exportedAt !== undefined) expectIso(data.exportedAt, 'exportedAt');

  const settingsIn = expectObject(data.settings, 'settings');
  const { schemaVersion: _ignored, ...settingsPatch } = settingsIn;
  let settings;
  try {
    settings = applySettingsPatch(defaultSettings(), settingsPatch);
  } catch (err) {
    throw new UserError(`settings: ${err.message}`);
  }
  const userState = checkUserState(data.userState);
  const alerts = checkList(data.alerts, 'alerts', ALERTS_LIMIT, checkAlert);
  const history = checkList(data.history, 'history', HISTORY_LIMIT, checkHistoryEntry);

  const { data: migrated } = migrate({
    settings: { ...settings, schemaVersion },
    userState,
    alerts,
    history,
  });
  return {
    settings: migrated.settings,
    userState: migrated.userState,
    alerts: migrated.alerts,
    history: migrated.history,
  };
}
